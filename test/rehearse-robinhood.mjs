// Launch-day rehearsal on Robinhood Chain TESTNET. Runs everything in a throwaway copy of the project,
// so your real wallets (.keys) and save are never touched:
//   1. checks the money layer against the real chain (test/evm.test.mjs)
//   2. deploys a test token (stand-in for your Pons token)
//   3. runs the real launch setup: it asks for funding, we fund the bank, it pays the founders
//   4. runs the island for a few minutes and checks every balance against the chain
// Needs a throwaway rehearsal wallet with ~0.03 testnet ETH (the script makes one and tells you its address).
// Writes the outcome to rehearsal-result.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, parseUnits, parseEther, formatEther, formatUnits } from 'ethers';
import { NETWORKS } from '../server/chain-evm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NET = NETWORKS['robinhood-testnet'];
// Only RH_TESTNET_RPC is read from your .env: nothing else (no API key, no real wallets) reaches the rehearsal.
const envLine = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^RH_TESTNET_RPC=(.+)$/m) : null;
const RPC = process.env.RH_TESTNET_RPC || envLine?.[1].trim() || NET.rpcUrl;
const log = [];
const say = (s = '') => { console.log(s); log.push(s); };
const done = (ok) => { fs.writeFileSync(path.join(ROOT, 'rehearsal-result.txt'), log.join('\n') + '\n'); process.exit(ok ? 0 : 1); };

// The throwaway rehearsal wallet (testnet only; never put real funds in it).
const wdir = path.join(ROOT, '.rehearsal');
fs.mkdirSync(wdir, { recursive: true });
const wfile = path.join(wdir, 'funder.json');
if (!fs.existsSync(wfile)) { const w = Wallet.createRandom(); fs.writeFileSync(wfile, JSON.stringify({ address: w.address, privateKey: w.privateKey })); }
const fkey = JSON.parse(fs.readFileSync(wfile, 'utf8'));

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false });
let chainId;
try { chainId = Number((await provider.getNetwork()).chainId); } catch (e) {
  say(`Can't reach the Robinhood testnet RPC at ${RPC} (${e.shortMessage || e.message}).`);
  say('Get a free Robinhood testnet RPC URL (Alchemy or Chainstack), put it in .env as RH_TESTNET_RPC=..., and run this again.');
  done(false);
}
if (chainId !== NET.chainId) { say(`${RPC} is chain ${chainId}, not Robinhood testnet (${NET.chainId}).`); done(false); }
const bal = Number(formatEther(await provider.getBalance(fkey.address)));
say(`Rehearsal wallet: ${fkey.address}`);
say(`  testnet ETH: ${bal}`);
if (bal < 0.007) {
  say('\nIt needs about 0.01 testnet ETH. Paste the rehearsal wallet address above into https://faucet.testnet.chain.robinhood.com');
  say('(it gives 0.01 a day), or send 0.01 testnet ETH to it from your wallet, then run this again.');
  done(false);
}
const funder = new NonceManager(new Wallet(fkey.privateKey, provider));

const run = (args, env, cwd, timeoutMs) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', LLM: 'off', INSULA_SECRETS: '', CHAIN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { out += d; });
  const t = timeoutMs ? setTimeout(() => p.kill(), timeoutMs) : null;
  p.on('exit', (code) => { if (t) clearTimeout(t); resolve({ code, out }); });
});

// 1. The money layer on the real chain.
say('\n== 1. Money layer on Robinhood testnet ==');
const t1 = await run([path.join(ROOT, 'test', 'evm.test.mjs')], { EVM_RPC: RPC, EVM_FUNDER_KEY: fkey.privateKey, EVM_CLUSTER: 'robinhood-testnet', EVM_BANK_ETH: '0.002', MAX_GAS_GWEI: '5' }, ROOT);
if (!/PASS:/.test(t1.out)) { say(t1.out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 5).join('\n')); say('Step 1 FAILED.'); done(false); }
say(t1.out.split('\n').filter((l) => /^ok -|PASS|gas used/.test(l)).join('\n'));

// 2. A stand-in for the Pons token.
say('\n== 2. Test token ==');
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'test-token.json'), 'utf8'));
const token = await (await new ContractFactory(art.abi, art.bytecode, funder).deploy('Insula Rehearsal', 'INSR', parseUnits('1000000000', 18), 0)).waitForDeployment();
const tokenAddr = await token.getAddress();
say(`Token ${tokenAddr}  ${NET.explorer}/address/${tokenAddr}`);

// 3. The real launch setup, in a throwaway copy of the project.
say('\n== 3. Launch setup (in a throwaway copy) ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insula-rehearsal-'));
const skip = new Set(['node_modules', 'data', '.keys', '.rehearsal', '.env', 'chain-config.json', 'deploy-secrets.txt', 'fly-secrets.txt', '.flyapp']);
fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => {
  const rel = path.relative(ROOT, src).split(path.sep)[0];
  return !(skip.has(rel) || rel.startsWith('.keys-') || /^chain-config\..+\.json$/.test(rel) || /\.(mp4|zip)$/.test(rel));
} });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
fs.writeFileSync(path.join(tmp, '.env'), [`INSULA_TOKEN=${tokenAddr}`, 'RH_NETWORK=robinhood-testnet', `RH_RPC_URL=${RPC}`, 'INSULA_BUY_URL=https://example.com/rehearsal', 'MIN_BANK_ETH=0.002', 'MAX_GAS_GWEI=5', 'ANTHROPIC_API_KEY='].join('\n') + '\n');
const s1 = await run(['server/setup-robinhood.js'], {}, tmp);
if (!/Send to the bank wallet/.test(s1.out)) { say('Setup did not ask for funding as expected.'); say(s1.out.slice(-800)); done(false); }
const bankAddr = JSON.parse(fs.readFileSync(path.join(tmp, '.keys', 'bank.json'), 'utf8')).address;
say(`Setup asked to fund bank ${bankAddr}; funding it like you will on launch day...`);
await (await funder.sendTransaction({ to: bankAddr, value: parseEther('0.003') })).wait();
await (await token.connect(funder).transfer(bankAddr, parseUnits('4000000', 18))).wait();
const s2 = await run(['server/setup-robinhood.js'], {}, tmp);
if (!/Robinhood Chain setup done/.test(s2.out)) { say('Setup FAILED on the second run:'); say(s2.out.slice(-1200)); done(false); }
say(s2.out.split('\n').filter((l) => /Founder|done/.test(l)).join('\n'));

// 4. The island itself, with real transfers, for a few minutes.
say('\n== 4. The island on Robinhood testnet (4 minutes) ==');
const PORT = '3987';
const island = run(['server/index.js'], { PORT, INSULA_SAVE: path.join(tmp, 'data', 'world.json') }, tmp, 245_000);
await new Promise((r) => setTimeout(r, 235_000));
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
let st, hist;
try { st = await get('/api/state'); hist = await get('/api/history'); } catch (e) { say(`Couldn't read the island (${e.message}).`); done(false); }
await island;
const trades = hist.filter((e) => e.type === 'trade');
const errors = hist.filter((e) => e.type === 'chainError');
say(`Network label: ${st.chain.network} (${st.chain.mode})`);
say(`${trades.length} trades, ${errors.length} payment errors`);
for (const tr of trades.slice(-4)) say(`  ${tr.text}  ${tr.url || tr.sig}`);
for (const er of errors.slice(0, 3)) say(`  ERROR: ${er.text}`);
const t = new Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
let match = true;
for (const a of [...st.agents.filter((x) => x.address), { id: 'bank', name: 'Bank', balance: st.bank.balance, address: st.bank.address }]) {
  const on = Number(formatUnits(await t.balanceOf(a.address), 18));
  const ok = Math.abs(on - a.balance) < 0.01 || a.id === 'bank' && Math.abs(on - a.balance) < 1;
  if (!ok) match = false;
  say(`  ${a.name}: island ${a.balance}, on-chain ${on} ${ok ? 'ok' : 'MISMATCH'}`);
}
const bankEth = Number(formatEther(await provider.getBalance(bankAddr)));
say(`Bank ETH left: ${bankEth} (spent ${(0.003 - bankEth).toFixed(6)} on gas and top-ups in 4 minutes)`);
const pass = trades.length > 0 && errors.length === 0 && match;
say(`\n${pass ? 'PASS: launch rehearsal on Robinhood testnet succeeded.' : 'REHEARSAL FAILED: send Claude rehearsal-result.txt.'}`);
fs.rmSync(tmp, { recursive: true, force: true });
done(pass);
