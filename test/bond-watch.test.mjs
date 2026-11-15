// The watchdog's event searches: they go to their own provider (the public node by default), and once a node
// refuses a range size the watchdog stops trying bigger ones, instead of failing every other request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { BondWatch } from '../server/bond-watch.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const BANK = '0x449D88802D7EDA208F02a8026762da4fbe1a5c7c';
const GUS = '0x1111111111111111111111111111111111111111';
const ROSA = '0x2222222222222222222222222222222222222222';
const BONDS = '0x77116C1f6e1F945e41bf9F42b026b3e1c5FBD808';

function setup({ limit, head, logs = [] }) {
  const calls = { ok: 0, refused: 0, main: 0 };
  const logsProvider = {
    async getLogs({ fromBlock, toBlock }) {
      if (toBlock - fromBlock + 1 > limit) { calls.refused++; throw new Error(`range over ${limit} blocks`); }
      calls.ok++; return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  // The main provider must never be asked for logs; it answers the contract reads through Contract.call.
  const provider = {
    async getLogs() { calls.main++; return []; },
    async send(m) { if (m === 'eth_blockNumber') return '0x' + head.n.toString(16); },
    async getBalance() { return 10n ** 18n; },
    async call(tx) {
      const sel = tx.data.slice(0, 10);
      const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
      const addr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
      return { '0x70a08231': word(100n), '0x44d96e95': word(100n), '0x570ca735': addr(BANK), '0xac7e534e': addr(ZERO), '0x8da5cb5b': addr('0x0f28bBA728C581d523CC70933524797Fa85984E1') }[sel] ?? word(0);
    },
    async getNetwork() { return { chainId: 4663n }; },
    resolveName: async (n) => n,
  };
  const payer = { provider, logsProvider, bonds: BONDS, token: '0x090980a62D5007F6190b04782d0ea690ab53c210', chainId: 4663, decimals: 18, gasWei: 1n, mySlashes: new Set(), chain: { addressOf: (id) => ({ bank: BANK, gus: GUS, rosa: ROSA })[id] } };
  const tripped = [];
  const visitors = { sim: { agents: { gus: {}, rosa: {} } }, closeForSafety: (reason, isNew) => { if (isNew) tripped.push(reason); } };
  return { watch: new BondWatch(payer, visitors, { from: 1000 }), calls, tripped };
}

test('a node that only allows 10-block searches: after the first refusals, no more failed requests', async () => {
  const head = { n: 1000 };
  const { watch, calls } = setup({ limit: 10, head });
  head.n = 1000 + 720; // ~3 minutes of blocks
  await watch.check();
  const firstRefused = calls.refused;
  assert.ok(firstRefused > 0 && firstRefused < 12, `learns the limit in a few tries (${firstRefused})`);
  head.n += 720;
  await watch.check();
  assert.equal(calls.refused, firstRefused, 'the second check never asks for a range the node refused');
  assert.equal(calls.main, 0, 'event searches never go to the paid RPC');
  assert.equal(watch.from, head.n + 1);
});

test('a node with a big limit: a 3-minute check is one or two searches', async () => {
  const head = { n: 1000 };
  const { watch, calls } = setup({ limit: 100_000, head });
  head.n += 720;
  await watch.check();
  const before = calls.ok + calls.refused;
  head.n += 720;
  await watch.check();
  assert.ok(calls.ok + calls.refused - before <= 2, `${calls.ok + calls.refused - before} searches`);
});

const EV = new Interface(['event PayeeQueued(address indexed payee, uint256 activeAt)']);
const queued = (payee, blockNumber) => {
  const { data, topics } = EV.encodeEventLog('PayeeQueued', [payee, 1n]);
  return { address: BONDS, data, topics, blockNumber, transactionHash: '0x' + '1'.repeat(64), index: 0, logIndex: 0 };
};

test('queueing an island animal (Gus) as a payee is expected; a stranger trips the alarm', async () => {
  const run = async (payee) => {
    const head = { n: 1000 };
    const { watch, tripped } = setup({ limit: 100_000, head, logs: [queued(payee, 1100)] });
    head.n = 1200;
    await watch.check();
    return tripped;
  };
  assert.deepEqual(await run(GUS), [], 'Gus: no alarm at all');
  const stranger = await run('0x9999999999999999999999999999999999999999');
  assert.equal(stranger.length, 1);
  assert.match(stranger[0], /queued a new payee/);
});
