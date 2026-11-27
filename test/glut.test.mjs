// No fire sales: once shipping has pushed the mainland's price under half of fair value, the animals aren't
// offered the export at all (they hold), and they come back once the glut fades.
process.env.LLM = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../server/world.js';
import { Sim } from '../server/sim.js';
import { PRICES, EXPORT_FLOOR } from '../server/agents.js';

const world = generateWorld({ seed: 1337 });
const chain = { mode: 'mock', addressOf: (id) => `MOCK-${id}`, accountUrl: () => null, balance: () => 1e6, transfer: async () => ({ sig: null }) };
const sim = new Sim(world, chain, {});
const a = Object.values(sim.agents)[0];
a.inv.ore = 8;
const exportsOre = () => sim.optionsFor(a).some((o) => o.action === 'export' && o.item === 'ore');

test('ore can be shipped while the mainland pays a fair-ish price', () => {
  sim.shipped.ore = 0;
  assert.ok(sim.mainlandPrice('ore') >= PRICES.ore.fair * EXPORT_FLOOR);
  assert.ok(exportsOre());
});

test('a flooded mainland: no export offered, the animal holds', () => {
  sim.shipped.ore = 200; // far past the glut point
  assert.ok(sim.mainlandPrice('ore') < PRICES.ore.fair * EXPORT_FLOOR, `mainland pays ${sim.mainlandPrice('ore')}`);
  assert.equal(exportsOre(), false);
});

test('once the glut fades, shipping comes back', () => {
  sim.shipped.ore = 5;
  assert.ok(exportsOre());
});
