// End-to-end check of the Robinhood Chain (EVM) money layer against a real chain:
// deploys a test token, makes wallets, then has agents pay each other through EvmChain and checks
// that tokens moved on-chain, memos landed in the input data, and the bank topped up gas.
// Usage: EVM_RPC=<url> EVM_FUNDER_KEY=<0x private key with ETH> [EVM_CLUSTER=local] node test/evm.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, parseEther, parseUnits, formatUnits } from 'ethers';
import { EvmChain, memoFromInput, ERC20_ABI } from '../server/chain-evm.js';

const RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const CLUSTER = process.env.EVM_CLUSTER || 'local';
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false });
const { chainId } = await provider.getNetwork();
const funder = new NonceManager(new Wallet(process.env.EVM_FUNDER_KEY, provider));
const art = JSON.parse(fs.readFileSync(new URL('./fixtures/test-token.json', import.meta.url)));
const check = (ok, msg) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

// A bank and three agents with fresh wallets.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insula-evm-'));
const ids = ['felix', 'bruno', 'penny'];
const keys = {};
for (const id of ['bank', ...ids]) {
  const w = Wallet.createRandom();
  keys[id] = w;
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ address: w.address, privateKey: w.privateKey }));
}

// Deploy the token to the bank, fund the bank with a little ETH, and give each agent starting coins.
const token = await (await new ContractFactory(art.abi, art.bytecode, funder).deploy('Insula Rehearsal', 'INSR', parseUnits('1000000000', 18), 0)).waitForDeployment();
const tokenAddr = await token.getAddress();
console.log('token', tokenAddr, 'chain', chainId);
await (await funder.sendTransaction({ to: keys.bank.address, value: parseEther(process.env.EVM_BANK_ETH || '0.02') })).wait();
await (await token.transfer(keys.bank.address, parseUnits('5000000', 18))).wait();

const cfg = { family: 'evm', cluster: CLUSTER, chainId: Number(chainId), rpcUrl: RPC, token: tokenAddr, decimals: 18, explorer: '' };
const chain = new EvmChain(ids, cfg, dir);
await chain.init();
check(chain.balance('bank') === 5_000_000, 'bank sees its 5,000,000 coins');
for (const id of ids) await chain.transfer('bank', id, 1000, `Insula rule:grant | The bank gave ${id} 1000 coins`);
check(ids.every((id) => chain.balance(id) === 1000), 'founders received 1000 coins each');

// Agents (who start with zero ETH) pay each other; the bank must top up their gas first.
const memo = 'Insula #D840 why:2ecc58ed2de72d40 | Penny bought 5 fish from Felix for 50 coins (10 each)';
const r1 = await chain.transfer('penny', 'felix', 50, memo);
const r2 = await chain.transfer('felix', 'bruno', 12.5, 'Insula #D841 why:abc | Felix bought 1 ore from Bruno');
const r3 = await chain.transfer('bruno', 'bank', 30, 'Insula rule:import | Bruno bought 2 wood off the boat');
check(chain.topups >= 3, `bank topped up gas for agents (${chain.topups} top-ups)`);

// Check everything on-chain, not just our own bookkeeping.
const t = new Contract(tokenAddr, ERC20_ABI, provider);
const onchain = async (id) => Number(formatUnits(await t.balanceOf(keys[id].address), 18));
check(await onchain('felix') === 1037.5, `Felix on-chain 1037.5 (got ${await onchain('felix')})`);
check(await onchain('penny') === 950, 'Penny on-chain 950');
check(await onchain('bruno') === 982.5, 'Bruno on-chain 982.5');
for (const id of [...ids, 'bank']) check(Math.abs((await onchain(id)) - chain.balance(id)) < 1e-9, `${id}: island balance matches chain`);
const tx = await provider.getTransaction(r1.sig);
check(memoFromInput(tx.data) === memo, 'memo is readable from the transaction input data');
check(tx.from === keys.penny.address, 'Penny signed her own payment');
const rc = await provider.getTransactionReceipt(r1.sig);
const sent = await provider.getTransaction(r1.sig);
console.log(`gas used per trade: ${rc.gasUsed} (limit set ${sent.gasLimit})`);
check(rc.gasUsed < sent.gasLimit, 'estimated gas limit has headroom');

// Many trades in a row (nonces must stay in order).
for (let i = 0; i < 12; i++) await chain.transfer(i % 2 ? 'felix' : 'penny', i % 2 ? 'penny' : 'felix', 5, `Insula #D9${i} why:x | trade ${i}`);
check(await onchain('felix') === chain.balance('felix'), 'balances still match after 12 quick trades');
console.log(`PASS: EVM trades move real tokens, memos land in calldata, bank tops up gas (${r2.sig.slice(0, 10)}…, ${r3.sig.slice(0, 10)}…)`);
fs.rmSync(dir, { recursive: true, force: true });
