// Rehearsal for scripts/test-visitor.mjs (the cap-1 soft launch test agent) on a local EVM chain: the real Permit2 (built from Uniswap's source), the real
// IslandBonds contract, a stand-in ERC-8004 identity registry, the island's server (sim + MCP) running with
// its animals, and an outside agent that only signs. Run with anvil, solc-js and the contract build:
//   node contracts/test/build.cjs && node test/open-borders-chain.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ANVIL = process.env.ANVIL || '/tmp/el/evm/anvil';
const BUILD = process.env.OB_BUILD || '/tmp/ob/build.json';
const SOLC = process.env.SOLC || '/tmp/el/evm/node_modules/solc';
const PORT = 8561, RPC = `http://127.0.0.1:${PORT}`;

const E = await import('ethers');
const anvil = spawn(ANVIL, ['--port', String(PORT), '--chain-id', '4663', '--base-fee', '10000000', '--gas-price', '10000000', '--silent']);
await new Promise((r) => setTimeout(r, 2500));
const provider = new E.JsonRpcProvider(RPC, 4663, { staticNetwork: true, cacheTimeout: -1 });
const KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'];
const owner = new E.NonceManager(new E.Wallet(KEYS[0], provider));
const ownerAddr = new E.Wallet(KEYS[0]).address;

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { failN++; console.log(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(500); } return false; };
const U = (n) => E.parseUnits(String(n), 18);
const C = (x) => Number(E.formatUnits(x, 18));
const BURN = '0x000000000000000000000000000000000000dEaD';

try {
  // ---- contracts ----
  const b = JSON.parse(fs.readFileSync(BUILD, 'utf8'));
  const solc = require(SOLC);
  const idSrc = 'pragma solidity ^0.8.20; contract MockIdentity { event Transfer(address indexed from, address indexed to, uint256 indexed tokenId); mapping(uint256 => address) public ownerOf; uint256 public next = 30000; function set(uint256 id, address o) external { ownerOf[id] = o; } function register(string calldata) external returns (uint256 id) { id = ++next; ownerOf[id] = msg.sender; emit Transfer(address(0), msg.sender, id); } }';
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Id.sol': { content: idSrc } }, settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  b.MockIdentity = { abi: out.contracts['Id.sol'].MockIdentity.abi, bin: '0x' + out.contracts['Id.sol'].MockIdentity.evm.bytecode.object };
  const dep = async (name, ...args) => { const c = await new E.ContractFactory(b[name].abi, b[name].bin, owner).deploy(...args); await c.waitForDeployment(); return c; };

  // The island's wallets: the bank and the eight animals.
  const { AGENT_DEFS, START_COINS, FOUNDERS } = await import('../server/agents.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-chain-'));
  const wallets = {};
  for (const id of ['bank', ...AGENT_DEFS.map((a) => a.id)]) {
    const w = E.Wallet.createRandom();
    wallets[id] = w;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ address: w.address, privateKey: w.privateKey }));
  }
  const bank = wallets.bank.address;
  const tok = await dep('MockToken');
  const permit2 = await dep('Permit2');
  const idReg = await dep('MockIdentity');
  const [T, P2, ID] = await Promise.all([tok.getAddress(), permit2.getAddress(), idReg.getAddress()]);
  const bonds = await dep('IslandBonds', T, P2, bank, ownerAddr, bank, U(100000), U(200000), U(5000000), U(20000), U(50000), 86400, U(100000), U(500000), [BURN]);
  const BA = await bonds.getAddress();
  await (await owner.sendTransaction({ to: bank, value: E.parseEther('5') })).wait();
  await (await tok.mint(bank, U(5_000_000))).wait();
  for (const id of FOUNDERS) await (await tok.mint(wallets[id].address, U(START_COINS[id]))).wait();

  // ---- the island's server ----
  const agent = E.Wallet.createRandom(); // the invited test agent
  process.env.OB_ALLOW = agent.address;
  process.env.OPEN_BORDERS = 'on';
  process.env.BONDS_ADDRESS = BA;
  process.env.PERMIT2_ADDRESS = P2;
  process.env.ERC8004_REGISTRY = ID;
  process.env.LLM = 'off';
  process.env.MAX_GAS_GWEI = '50';
  process.env.OB_ACTION_GAP_MS = '0';
  process.env.OB_CONSIDER_ODDS = '1';
  process.env.THINK_GAP_MS = '0';
  const { EvmChain } = await import('../server/chain-evm.js');
  const chain = new EvmChain(AGENT_DEFS.map((a) => a.id), { family: 'evm', cluster: 'local', chainId: 4663, rpcUrl: RPC, token: T, decimals: 18, explorer: '' }, dir);
  await chain.init();
  const { generateWorld } = await import('../server/world.js');
  const { Sim } = await import('../server/sim.js');
  const { Visitors, createPayer } = await import('../server/visitors.js');
  const { mountMcp } = await import('../server/mcp.js');
  const express = (await import('express')).default;
  const sim = new Sim(generateWorld({ seed: 1337 }), chain, {});
  const payer = createPayer(chain);
  ok(payer?.constructor?.name === 'Permit2Payer', 'Robinhood-style chain + BONDS_ADDRESS → the Permit2 payer');
  const vs = new Visitors(sim, payer, null);
  const events = [];
  sim.on((e) => events.push(e));
  sim.start();
  vs.start();
  const app = express();
  mountMcp(app, { sim, visitors: vs, x402: null, reputation: null, identity: { ids: {} } });
  const server = http.createServer(app).listen(8562);
  let rid = 1;
  const rpc = async (method, params) => {
    const r = await fetch('http://127.0.0.1:8562/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) });
    return (await r.json()).result;
  };
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { ...r.structuredContent, isError: r.isError, text: r.content?.[0]?.text }; };


  // ---- the test agent: a fresh wallet funded like the soft launch (ETH + 110k $INSULA) ----
  await (await owner.sendTransaction({ to: agent.address, value: E.parseEther('0.01') })).wait();
  await (await tok.mint(agent.address, U(120_000))).wait();
  const stateFile = path.join(dir, 'visitor.json');
  const run = (cmd, ...a) => new Promise((res) => {
    const p = spawn('node', ['scripts/test-visitor.mjs', cmd, ...a], { env: { ...process.env, SITE: 'http://127.0.0.1:8562', RPC, VISITOR_KEY: agent.privateKey, VISITOR_STATE: stateFile, WAIT_MIN: '1' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { console.log(out.split('\n').map((l) => '      | ' + l).join('\n')); res({ code, out }); });
  });
  console.log('Invite-only');
  const stranger = E.Wallet.createRandom();
  const sq = await tool('move_in', { address: stranger.address, agentId: '1' });
  ok(sq.isError && sq.error === 'invite_only', 'a wallet not on OB_ALLOW is refused before signing anything');
  const sg = await tool('get_gas', { address: stranger.address, agentId: '1' });
  ok(sg.isError, 'and cannot claim gas');
  ok((await tool('join_island', {})).inviteOnly !== false, 'join_island still answers');
  console.log('Script: status, setup, move-in, tour, leave');
  let r = await run('status');
  ok(r.code === 0 && /not registered yet/.test(r.out), 'status works on a fresh wallet');
  r = await run('setup');
  ok(r.code === 0 && /ERC-8004 agent #\d+/.test(r.out) && /Permit2 approved/.test(r.out), 'setup registers an identity and approves Permit2');
  ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).agentId && !fs.readFileSync(stateFile, 'utf8').includes(agent.privateKey.slice(2, 20)), 'state file has the agent id and never the key');
  r = await run('move-in', 'Nova');
  ok(r.code === 0 && /✓ moved in/.test(r.out), 'move-in locks the bond and pays the entry fee');
  ok(C((await bonds.bonds(agent.address)).amount) === 100000, 'bond of 100,000 locked on-chain');
  r = await run('tour');
  ok(r.code === 0 && /✓ dock: buy 6 fish/.test(r.out) && /✓ offer: sell 6 fish/.test(r.out) && /✓ gather ore/.test(r.out) && /✓ dock: sell 8 ore/.test(r.out), 'tour: dock buy, offer, gather a full load, sell it');
  r = await run('me');
  ok(r.code === 0 && /✓ my status/.test(r.out), 'me shows the agent');
  r = await run('leave');
  ok(r.code === 0 && /✓ move out/.test(r.out) && /leaving; withdraw after/.test(r.out), 'leave moves out and calls requestLeave()');
  ok((await bonds.bonds(agent.address)).leaving, 'bond is marked leaving on-chain');
  r = await run('withdraw');
  ok(r.code !== 0 && /cooling-off period ends/.test(r.out), 'withdraw refuses before the cooling-off period');
  await provider.send('evm_increaseTime', [86400 + 60]); await provider.send('evm_mine', []);
  r = await run('withdraw');
  ok(r.code === 0 && /bond withdrawn/.test(r.out) && C((await bonds.bonds(agent.address)).amount) === 0, 'withdraw returns the bond after the cooling-off period');
  server.close();
  console.log(`\n${pass} passed, ${failN} failed`);
} catch (e) {
  console.error(e); failN++;
} finally {
  anvil.kill();
  process.exit(failN ? 1 : 0);
}
