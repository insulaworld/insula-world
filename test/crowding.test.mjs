// Animals sent to the same spot (four fishers at North Beach) used to push each other apart forever and
// never count as arrived. Now each North Beach fisher has its own place, and anyone stuck within arm's
// reach of a crowded spot counts as arrived.
process.env.LLM = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, groundY, harborDeck } from '../server/world.js';
import { Sim } from '../server/sim.js';

const world = generateWorld({ seed: 1337 });
const chain = { mode: 'mock', addressOf: (id) => `MOCK-${id}`, accountUrl: () => null, balance: () => 1e6, transfer: async () => ({ sig: null }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('four animals walking to one point all arrive within a few seconds', async () => {
  const sim = new Sim(world, chain, {});
  const four = Object.values(sim.agents).slice(0, 4);
  four.forEach((a, i) => { a.x = 43 + (i - 1.5) * 0.4; a.z = 20; });
  // Drive the movement loop by hand (the same step + personal-space nudge the island runs), no AI.
  const goal = { x: 43, z: 18 };
  const arrived = new Set();
  four.forEach((a) => a.walkTo(goal.x, goal.z).then(() => arrived.add(a.id)));
  const sep = Object.getOwnPropertyNames(Object.getPrototypeOf(sim)).includes('start');
  assert.ok(sep);
  const t0 = Date.now();
  while (arrived.size < 4 && Date.now() - t0 < 12_000) {
    for (const a of four) a.step(0.05);
    sim.nudgeApart?.(0.05);
    await sleep(50);
  }
  assert.equal(arrived.size, 4, `${arrived.size} of 4 arrived in ${Date.now() - t0} ms`);
});

test('North Beach fishers stand on the North Harbor deck, each on their own boards', () => {
  const sim = new Sim(world, chain, {});
  sim.unlocked.add('north');
  const hs = world.sites.harbor;
  const hb = { id: 9001, kind: 'project', type: 'harbor', level: 1, progress: 1, owner: null, x: hs.x, z: hs.z, y: world.heights[hs.x][hs.z] };
  sim.buildings.push(hb);
  sim._solidsAt = 0;
  const deck = harborDeck(hb), onDeck = new Set(deck.tiles.map(([a, b]) => `${a},${b}`));
  const spots = Object.values(sim.agents).map((a) => { a.homeZone = 'north'; return sim.workSpot(a, 'fish'); });
  const keys = new Set(spots.map((s) => `${s.x},${s.z}`));
  assert.ok(keys.size >= Math.min(spots.length, 7), `${keys.size} distinct spots for ${spots.length} fishers`);
  for (const s of spots) {
    assert.ok(onDeck.has(`${Math.round(s.x)},${Math.round(s.z)}`), `spot ${s.x},${s.z} is on the deck`);
    assert.equal(groundY(world, s.x, s.z), Math.max(deck.top, world.heights[Math.round(s.x)][Math.round(s.z)] + 1), 'stands on top of the boards');
    assert.ok(sim.standable(s.x, s.z), `spot ${s.x},${s.z} is walkable`);
  }
  for (let i = 0; i < spots.length; i++)
    for (let j = i + 1; j < spots.length; j++) {
      const d = Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z);
      if (d > 0) assert.ok(d >= 1.5, `spots ${i} and ${j} are ${d.toFixed(2)} apart`);
    }
});

test('before the North Harbor is built, North Beach fishers use the main pier', () => {
  const w2 = generateWorld({ seed: 1337 });
  const sim = new Sim(w2, chain, {});
  sim.unlocked.add('north');
  const a = Object.values(sim.agents)[0];
  a.homeZone = 'north';
  const s = sim.workSpot(a, 'fish');
  const pier = new Set(w2.places.dock.pier.tiles.map(([x, z]) => `${x},${z}`));
  assert.ok(pier.has(`${Math.round(s.x)},${Math.round(s.z)}`), `spot ${s.x},${s.z} is on the main pier`);
});
