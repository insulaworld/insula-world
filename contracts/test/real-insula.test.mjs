// IslandBonds and Permit2 payments against the REAL $INSULA token code, copied byte for byte from Robinhood Chain
// (0x090980a62D5007F6190b04782d0ea690ab53c210; contracts/test/fixtures/insula.code.txt, SHA-256 of the hex string
// 8df304ae58f902a8079863c7ed664a26fec5daeea16e25d21cfe321a4039fc0d) onto a local chain at its real address.
// Usage: node contracts/test/real-insula.test.mjs   (needs anvil; ANVIL and OB_BUILD paths as in the other tests)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as E from 'ethers';

const ANVIL = process.env.ANVIL || '/tmp/el/evm/anvil';
const BUILD = process.env.OB_BUILD || '/tmp/ob/build.json';
const INSULA = '0x090980a62D5007F6190b04782d0ea690ab53c210';
const BURN = '0x000000000000000000000000000000000000dEaD';
const code = fs.readFileSync(new URL('./fixtures/insula.code.txt', import.meta.url), 'utf8').trim();
const b = JSON.parse(fs.readFileSync(BUILD));
const art = JSON.parse(fs.readFileSync(new URL('../build/IslandBonds.json', import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const U = (n) => E.parseUnits(String(n), 18);

const anvil = spawn(ANVIL, ['--port', '8561', '--chain-id', '4663', '--silent']);
try {
  await new Promise((r) => setTimeout(r, 2500));
  const p = new E.JsonRpcProvider('http://127.0.0.1:8561', 4663, { staticNetwork: true, cacheTimeout: -1 });
  const keys = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'];
  const [owner, operator, agent, other] = keys.map((k) => new E.Wallet(k, p));
  const bank = E.Wallet.createRandom().address;

  console.log('The real token');
  ok(crypto.createHash('sha256').update(code).digest('hex') === '8df304ae58f902a8079863c7ed664a26fec5daeea16e25d21cfe321a4039fc0d', 'bytecode matches the copy taken from Robinhood Chain');
  await p.send('anvil_setCode', [INSULA, code]);
  // OpenZeppelin ERC-20: balances are mapping slot 0, total supply slot 2.
  const slot = (a) => E.keccak256(E.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [a, 0]));
  for (const w of [agent, other]) await p.send('anvil_setStorageAt', [INSULA, slot(w.address), E.toBeHex(U(1_000_000), 32)]);
  await p.send('anvil_setStorageAt', [INSULA, E.toBeHex(2, 32), E.toBeHex(U(2_000_000), 32)]);
  const tok = new E.Contract(INSULA, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)'], p);
  ok((await tok.balanceOf(agent.address)) === U(1_000_000) && Number(await tok.decimals()) === 18, 'balances and decimals read as expected');
  const t0 = await tok.balanceOf(other.address);
  await (await tok.connect(agent).transfer(other.address, U(12345))).wait();
  ok((await tok.balanceOf(other.address)) - t0 === U(12345), 'a transfer arrives in full (no fee on transfer)');
  ok(await tok.connect(agent).transfer.staticCall(BURN, 1n) === true, 'transfers return true, and the burn address can receive');

  console.log('IslandBonds with the real token');
  const dep = async (abi, bin, ...args) => { const c = await new E.ContractFactory(abi, bin, owner).deploy(...args); await c.waitForDeployment(); return c; };
  const permit2 = await dep(b.Permit2.abi, b.Permit2.bin);
  const P2 = await permit2.getAddress();
  const bonds = await dep(art.abi, art.bytecode, INSULA, P2, bank, owner.address, operator.address, U(100000), U(250000), U(5000000), U(50000), U(200000), 7 * 86400, U(250000), U(1000000), [BURN]);
  const BA = await bonds.getAddress();
  await (await tok.connect(other).approve(BA, U(100000))).wait();
  await (await bonds.connect(other).deposit(U(100000))).wait();
  ok((await tok.balanceOf(BA)) === U(100000) && (await bonds.totalBonded()) === U(100000), 'a normal deposit locks exactly 100,000');
  await (await tok.connect(agent).approve(P2, E.MaxUint256)).wait();
  const dom = { name: 'Permit2', chainId: 4663, verifyingContract: P2 };
  const single = { PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] };
  const dl = Math.floor(Date.now() / 1000) + 3600;
  const sig = await agent.signTypedData(dom, single, { permitted: { token: INSULA, amount: U(100000) }, spender: BA, nonce: 1, deadline: dl });
  await (await bonds.connect(operator).depositWithPermit(agent.address, U(100000), 1, dl, sig)).wait();
  ok((await bonds.isResident(agent.address)) && (await tok.balanceOf(BA)) === U(200000), 'a gasless deposit through Permit2 locks exactly 100,000');
  await (await bonds.connect(operator).slash(agent.address, U(1000), BURN, E.id('unpaid-fees'), 'test')).wait();
  await (await bonds.connect(operator).slash(agent.address, U(1000), bank, E.id('unpaid-fees'), 'test')).wait();
  ok((await tok.balanceOf(bank)) === U(1000) && (await bonds.totalBonded()) === U(198000), 'slashes pay the bank and the burn address exactly');
  await (await bonds.connect(agent).requestLeave()).wait();
  await p.send('evm_increaseTime', [7 * 86400]); await p.send('evm_mine', []);
  const before = await tok.balanceOf(agent.address);
  await (await bonds.connect(agent).withdraw()).wait();
  ok((await tok.balanceOf(agent.address)) - before === U(98000), 'after the cooling-off the agent gets exactly its remaining 98,000');
  ok((await tok.balanceOf(BA)) === (await bonds.totalBonded()), 'the contract holds exactly what it owes');

  console.log("The island's Permit2 batch payments with the real token");
  const batch = { PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: single.TokenPermissions };
  const permitted = [U(150), U(1), U(1)].map((amount) => ({ token: INSULA, amount }));
  const dl2 = (await p.getBlock('latest')).timestamp + 3600; // the chain's clock (it moved 7 days ahead above)
  const bsig = await agent.signTypedData(dom, batch, { permitted, spender: operator.address, nonce: 7, deadline: dl2 });
  const seller = E.Wallet.createRandom().address;
  const p2c = new E.Contract(P2, ['function permitTransferFrom(((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes signature)'], operator);
  const b0 = await tok.balanceOf(BURN), k0 = await tok.balanceOf(bank);
  await (await p2c.permitTransferFrom({ permitted, nonce: 7, deadline: dl2 }, [{ to: seller, requestedAmount: U(150) }, { to: BURN, requestedAmount: U(1) }, { to: bank, requestedAmount: U(1) }], agent.address, bsig)).wait();
  ok((await tok.balanceOf(seller)) === U(150) && (await tok.balanceOf(BURN)) - b0 === U(1) && (await tok.balanceOf(bank)) - k0 === U(1), 'price + burned fee + bank fee in one transaction, exact amounts');
  let replayed = true;
  try { await (await p2c.permitTransferFrom({ permitted, nonce: 7, deadline: dl2 }, [{ to: seller, requestedAmount: U(150) }, { to: BURN, requestedAmount: U(1) }, { to: bank, requestedAmount: U(1) }], agent.address, bsig)).wait(); } catch { replayed = false; }
  ok(!replayed, 'the same signed payment cannot be used twice');
} catch (e) {
  console.error(e);
  fail++;
} finally {
  anvil.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
