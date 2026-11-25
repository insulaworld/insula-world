// Agent passports: animals and visitors are found by id, name or ERC-8004 id, and every deal listed links to the chain.
process.env.LLM = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../server/world.js';
import { Sim } from '../server/sim.js';
import { Passports } from '../server/passport.js';

const world = generateWorld({ seed: 1337 });
const chain = { mode: 'mock', addressOf: (id) => `0x${Buffer.from(id).toString('hex').padEnd(40, '0').slice(0, 40)}`, accountUrl: (a) => `https://x/address/${a}`, balance: () => 1e6, transfer: async () => ({ sig: null }) };
const sim = new Sim(world, chain, {});
const felix = sim.agents.felix || Object.values(sim.agents)[0];
sim.history.push({ type: 'trade', from: felix.id, to: 'bank', amount: 40, text: `${felix.name} paid 40`, url: 'https://x/tx/1', ts: Date.now() });
sim.history.push({ type: 'trade', from: felix.id, to: 'bank', amount: 5, text: 'no tx link', ts: Date.now() });
const visitors = {
  feed: [
    { text: `${felix.name} bought 8 fish from visitor V1 for 88 coins (11 each)`, amount: 88, kind: 'fish', ts: Date.now(), url: 'https://x/tx/2', visitor: 'V1' },
    { text: 'The mainland bought 16 grain from visitor V1 for 96 coins', amount: 96, kind: 'grain', ts: Date.now(), url: 'https://x/tx/3', visitor: 'V1' },
    { text: 'someone else', amount: 1, ts: Date.now(), url: 'https://x/tx/4', visitor: 'V2' },
  ],
  people: () => [{ id: 'V1', agentId: '25852', name: 'Nova', look: 'robot', color: '#7BE3A3', address: '0xabc', status: 'resident', joinedAt: 1, joinedDay: 15, slashed: 0, inv: { ore: 1 }, stats: { trades: 2, volume: 184, fees: 2 }, owedFees: 0, tradedToday: 184, accountUrl: 'https://x/address/0xabc' }],
  summary: () => ({ rules: { bond: 100000, dailyTradeCap: 2000 } }),
};
const reputation = { agentView: (id) => ({ score: 100, count: 3, raters: 2, byTag: {}, onchain: null, recent: [] }) };
const credit = { report: () => ({ borrower: { grade: 'A', score: 100, loans: 4, borrowed: 1000, repaidOnTime: 4, repaidLate: 0, defaulted: 0, unpaid: 0, repaymentRate: 1, open: [] } }) };
const identity = { view: () => ({ agents: { [felix.id]: { agentId: '23379', url: 'https://x/token/23379', txUrl: 'https://x/tx/reg' } } }) };
const relations = { summary: () => ({ pairs: { [[felix.id, 'otto'].sort().join('|')]: { trades: 5, trust: 90, rivalry: 2 } } }) };
const P = new Passports({ sim, identity, reputation, credit, relations, visitors });

test('an animal is found by id, name and ERC-8004 id', () => {
  for (const q of [felix.id, felix.name, felix.name.toUpperCase()]) assert.equal(P.get(q)?.id, felix.id, q);
  assert.equal(P.get('nobody-here'), null);
});

test('an animal passport carries identity, reputation, credit and only deals with a tx link', () => {
  const p = P.get(felix.id);
  assert.equal(p.kind, 'animal');
  assert.equal(p.identity.agentId, '23379');
  assert.equal(p.reputation.score, 100);
  assert.equal(p.credit.grade, 'A');
  assert.ok(p.deals.length >= 1 && p.deals.every((d) => d.url), 'every listed deal links to the chain');
  assert.equal(p.partners[0]?.trades, 5);
});

test('a visitor passport (Nova) shows bond, trades and who it dealt with', () => {
  const p = P.get('nova');
  assert.equal(p.kind, 'visitor');
  assert.equal(P.get('25852')?.name, 'Nova');
  assert.equal(p.bond.amount, 100000);
  assert.equal(p.bond.locked, true);
  assert.equal(p.deals.length, 2, 'only its own deals');
  assert.deepEqual(p.partners.map((x) => x.id).sort(), [felix.id, 'mainland'].sort());
  assert.equal(P.list().filter((a) => a.kind === 'visitor').length, 1);
});
