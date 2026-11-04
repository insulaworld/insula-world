// Recreates the soak-test failure: the RPC connection drops (ECONNRESET) right after a payment is sent.
// The payment lands on-chain anyway; the island must still record it. Also checks that the periodic
// resync corrects a balance that changed behind the island's back.
// Usage: EVM_RPC=<url> EVM_FUNDER_KEY=<0x key> node test/evm-resilience.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, parseEther, parseUnits, formatUnits } from 'ethers';
import { EvmChain } from '../server/chain-evm.js';

const RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const provider = new JsonRpcProvider(RPC);
const funder = new NonceManager(new Wallet(process.env.EVM_FUNDER_KEY, provider));
const art = JSON.parse(fs.readFileSync(new URL('./fixtures/test-token.json', import.meta.url)));
const check = (ok, msg) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insula-res-'));
const keys = {};
for (const id of ['bank', 'felix', 'penny']) {
  const w = Wallet.createRandom(); keys[id] = w;
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ address: w.address, privateKey: w.privateKey }));
}
const token = await (await new ContractFactory(art.abi, art.bytecode, funder).deploy('T', 'T', parseUnits('1000000', 18), 0)).waitForDeployment();
const tokenAddr = await token.getAddress();
await (await funder.sendTransaction({ to: keys.bank.address, value: parseEther('0.5') })).wait();
await (await token.transfer(keys.bank.address, parseUnits('100000', 18))).wait();
const chain = new EvmChain(['felix', 'penny'], { family: 'evm', cluster: 'local', chainId: Number((await provider.getNetwork()).chainId), rpcUrl: RPC, token: tokenAddr, decimals: 18, explorer: '' }, dir);
await chain.init();
await chain.transfer('bank', 'penny', 500, 'grant');
const onchain = async (id) => Number(formatUnits(await new Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(keys[id].address), 18));

// 1. The connection "drops" just after the payment is sent: the send call errors, but the network got it.
const real = chain.provider.broadcastTransaction.bind(chain.provider);
let dropped = 0;
chain.provider.broadcastTransaction = async (signed) => { await real(signed); dropped++; throw new Error('read ECONNRESET'); };
const r = await chain.transfer('penny', 'felix', 37, 'Insula #D1 why:abc | fish');
chain.provider.broadcastTransaction = real;
check(dropped >= 1, `the connection dropped ${dropped} time(s) right after sending (gas top-up and payment)`);
check(!!r.sig, 'the island still recorded the payment (found it by hash)');
check(chain.balance('felix') === 37 && (await onchain('felix')) === 37, 'Felix: island 37 = chain 37');
check(chain.balance('penny') === 463 && (await onchain('penny')) === 463, 'Penny: island 463 = chain 463');

// 2. A payment the island never saw (moved directly on-chain): the resync catches it.
const pennyW = new Wallet(keys.penny.privateKey, provider);
await (await funder.sendTransaction({ to: keys.penny.address, value: parseEther('0.01') })).wait();
await (await new Contract(tokenAddr, ['function transfer(address,uint256) returns (bool)'], pennyW).transfer(keys.felix.address, parseUnits('13', 18))).wait();
check(chain.balance('felix') === 37, 'before resync the island still thinks Felix has 37');
const fixed = await chain.resync();
check(chain.balance('felix') === 50 && chain.balance('penny') === 450, `resync corrected the books (${fixed.join(', ')})`);

// 3. Payments keep working after all that (nonces re-read correctly).
await chain.transfer('felix', 'penny', 10, 'after');
check(chain.balance('felix') === (await onchain('felix')) && chain.balance('penny') === (await onchain('penny')), 'later payments still match the chain');
clearInterval(chain.resyncTimer);
console.log('PASS: dropped connections and outside changes no longer drift the books');
fs.rmSync(dir, { recursive: true, force: true });
