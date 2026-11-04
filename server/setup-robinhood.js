// One-time ROBINHOOD CHAIN setup, for launch day. Nothing is minted here: the money is your Pons
// token, and the bank holds tokens you send it (part of your dev buy).
//
//   1. makes fresh EVM wallets for the bank and each agent (.keys/); any earlier setup (the Solana
//      wallets, a testnet rehearsal) is moved to .keys-<network>/ and chain-config.<network>.json, never deleted
//   2. reads your token from the chain (name, symbol, decimals)
//   3. checks the bank has ETH (it pays gas, and tops agents up with gas) and enough tokens
//   4. gives the founders their starting coins, checking the token takes no transfer tax and that
//      memos ride along in the transaction data
//
// Needs in .env:  INSULA_TOKEN=<your token's contract address>   INSULA_BUY_URL=<your Pons token page>
// Optional:       RH_RPC_URL=<a Robinhood Chain RPC>   RH_NETWORK=robinhood-testnet (rehearsals only)
// Safe to run again: it picks up where it stopped (e.g. after you fund the bank).

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Wallet, Contract, isAddress, getAddress, formatUnits, formatEther } from 'ethers';
import { AGENT_DEFS, START_COINS, FOUNDERS } from './agents.js';
import { KEYS_DIR, CONFIG_PATH } from './chain.js';
import { NETWORKS, ERC20_ABI, EvmChain } from './chain-evm.js';

const NET = process.env.RH_NETWORK || 'robinhood';
const net = NETWORKS[NET];
const stop = (msg) => { console.log(`\n${msg}\n`); process.exit(1); };
if (!net) stop(`Unknown RH_NETWORK "${NET}". Use robinhood (or robinhood-testnet for a rehearsal).`);
const RPC = process.env.RH_RPC_URL || net.rpcUrl;
const MIN_ETH = Number(process.env.MIN_BANK_ETH || 0.01);
const TOKEN = (process.env.INSULA_TOKEN || process.argv[2] || '').trim();

if (!TOKEN) stop('Put your token\'s contract address in .env as INSULA_TOKEN=0x... (from the Pons page), then run this again.');
if (!isAddress(TOKEN)) stop(`"${TOKEN}" is not a valid contract address. Copy the token address (0x...) from Pons.`);
const token = getAddress(TOKEN);

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false });
let chainId;
try { chainId = Number((await provider.getNetwork()).chainId); } catch (e) { stop(`Can't reach ${RPC} (${e.shortMessage || e.message}).`); }
if (NET !== 'local' && chainId !== net.chainId) stop(`That RPC is chain ${chainId}, not ${net.name} (${net.chainId}).`);

// 1. Keep any earlier setup safe, then start fresh wallets for this token.
const old = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
const sameSetup = old?.family === 'evm' && old.cluster === NET && old.token === token;
if (old && !sameSetup) {
  let tag = old.family === 'evm' ? old.cluster : old.cluster === 'mainnet-beta' ? 'solana' : `solana-${old.cluster}`;
  if (fs.existsSync(path.resolve(`.keys-${tag}`))) tag += `-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
  if (fs.existsSync(KEYS_DIR)) fs.renameSync(KEYS_DIR, path.resolve(`.keys-${tag}`));
  fs.renameSync(CONFIG_PATH, path.resolve(`chain-config.${tag}.json`));
  console.log(`Moved the previous wallets to .keys-${tag}/ and chain-config.${tag}.json (kept, not deleted).`);
}
fs.mkdirSync(KEYS_DIR, { recursive: true });
function walletFor(name) {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.privateKey) return new Wallet(j.privateKey, provider);
  }
  const w = Wallet.createRandom();
  fs.writeFileSync(file, JSON.stringify({ address: w.address, privateKey: w.privateKey }));
  return new Wallet(w.privateKey, provider);
}
const bank = walletFor('bank');
for (const a of AGENT_DEFS) walletFor(a.id);

// 2. The token.
const code = await provider.getCode(token);
if (code === '0x') stop(`No contract at ${token} on ${net.name}. Is that the right address, and has the token launched?`);
const t = new Contract(token, ERC20_ABI, provider);
let decimals, symbol, name, supply;
try {
  [decimals, symbol, name, supply] = await Promise.all([t.decimals(), t.symbol(), t.name(), t.totalSupply()]);
  decimals = Number(decimals);
} catch { stop(`${token} doesn't look like a standard token (couldn't read its name, symbol and decimals).`); }
console.log(`Token: ${name} ($${symbol}) ${token}`);
console.log(`       ${decimals} decimals, supply ${Number(formatUnits(supply, decimals)).toLocaleString()}, on ${net.name}`);

const cfg = {
  family: 'evm', cluster: NET, chainId, rpcUrl: RPC, token, decimals, symbol, networkName: net.name,
  mainnet: net.mainnet, explorer: net.explorer, explorerName: net.explorerName,
  buyUrl: process.env.INSULA_BUY_URL || old?.buyUrl || null, memo: old?.memo ?? true,
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
if (!cfg.buyUrl) console.log('Note: no INSULA_BUY_URL in .env, so the site\'s BUY button will be hidden. Add your Pons page link and run this again.');

// 3. The bank needs ETH for gas and enough tokens for the founders (plus a float for exports).
const founderTotal = FOUNDERS.reduce((s, id) => s + START_COINS[id], 0);
const eth = Number(formatEther(await provider.getBalance(bank.address)));
const coins = Number(formatUnits(await t.balanceOf(bank.address), decimals));
console.log(`\nBank wallet: ${bank.address}`);
console.log(`  ETH:   ${eth} (needs at least ${MIN_ETH})`);
console.log(`  Coins: ${coins.toLocaleString()} (founders need ${founderTotal.toLocaleString()}; send it 3-5 million)`);
if (eth < MIN_ETH || coins < founderTotal) {
  stop(`Send to the bank wallet above, on ${net.name}, from your own wallet:\n   - ETH for gas (${MIN_ETH} minimum; it pays gas for every trade)\n   - your $${symbol} for the island (3-5 million)\nThen run this again.`);
}

// 4. Founders' starting coins. The first payment also proves two things about the token:
//    no transfer tax (the founder receives exactly what was sent), and memos are accepted.
const chain = new EvmChain(AGENT_DEFS.map((a) => a.id), cfg, KEYS_DIR);
await chain.init();
for (const id of FOUNDERS) {
  if (chain.balance(id) > 0) { console.log(`Founder ${id} already has ${chain.balance(id)} coins.`); continue; }
  let res;
  try {
    res = await chain.transfer('bank', id, START_COINS[id], `Insula rule:genesis | The bank gave ${id} ${START_COINS[id]} starting coins`);
  } catch (e) {
    if (!cfg.memo) throw e;
    console.log(`A payment with a memo was refused (${e.message}). Trying without memos...`);
    cfg.memo = false; chain.useMemo = false;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    res = await chain.transfer('bank', id, START_COINS[id], '');
  }
  const got = Number(formatUnits(await t.balanceOf(chain.addressOf(id)), decimals));
  if (Math.abs(got - START_COINS[id]) > 1e-9) {
    stop(`${id} received ${got} instead of ${START_COINS[id]}: this token takes a fee on transfers, so the island's books would drift. Stopping; tell Claude.`);
  }
  console.log(`Founder ${id}: ${START_COINS[id]} coins -> ${chain.addressOf(id)}  ${res.url || res.sig}`);
}
for (const a of AGENT_DEFS.filter((x) => !FOUNDERS.includes(x.id))) console.log(`Wallet ready for ${a.id} (arrives later) -> ${chain.addressOf(a.id)}`);
if (!cfg.memo) console.log('\nNote: this token refused memos, so payments go through without the on-chain reasoning fingerprint.');
fs.writeFileSync(path.join(KEYS_DIR, 'setup-done'), new Date().toISOString());
console.log(`\nRobinhood Chain setup done. Next: run deploy-fly.bat (it starts a fresh island on ${net.name}).`);
