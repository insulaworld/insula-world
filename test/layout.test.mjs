// The spacious town plan: a saved island from the old, cramped plan is moved onto it once, with every
// building kept (owner, level, progress), nothing touching, and nobody left standing inside a wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateWorld } from '../server/world.js';
import { footprint, LAYOUT_VERSION } from '../server/layout.js';
import { Sim } from '../server/sim.js';

const world = generateWorld({ seed: 1337 });
const chain = { mode: 'mock', addressOf: (id) => `MOCK-${id}`, accountUrl: () => null, balance: () => 1e6, transfer: async () => ({ sig: null }) };
const box = (b) => { const f = footprint(b.kind, b.type); return { x0: b.x - f.w, x1: b.x + f.w, z0: b.z - f.d0, z1: b.z + f.d1 }; };
const gap = (a, b) => { const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0), dz = Math.max(b.z0 - a.z1, a.z0 - b.z1, 0); return dx && dz ? Math.hypot(dx, dz) : Math.max(dx, dz); };
const load = () => JSON.parse(fs.readFileSync(new URL('./fixtures/cramped-world.json', import.meta.url), 'utf8'));

test('the plan itself: sites and plots never crowd each other, the plaza or the dock', () => {
  const things = [
    ...Object.entries(world.sites).filter(([k]) => k !== 'harbor').map(([k, s]) => box({ kind: 'project', type: k, x: s.x, z: s.z })),
    ...world.plots.map((p) => box({ kind: 'private', type: 'house', x: p.x, z: p.z })),
  ];
  for (let i = 0; i < things.length; i++) for (let j = i + 1; j < things.length; j++) assert.ok(gap(things[i], things[j]) >= 3, `gap ${gap(things[i], things[j])}`);
  const m = world.places.market, plaza = { x0: m.x - 3.5, x1: m.x + 3.5, z0: m.z - 3.5, z1: m.z + 3.5 };
  for (const t of things) assert.ok(gap(t, plaza) >= 4, 'clear of the market plaza');
  const d = world.places.dock;
  for (const t of things) assert.ok(gap(t, { x0: d.x - 0.5, x1: d.x + 0.5, z0: d.z - 0.5, z1: d.z + 0.5 }) >= 4, 'clear of the dock');
  assert.ok(world.plots.length >= 40, `room to grow (${world.plots.length} plots)`);
  assert.equal(world.layout, LAYOUT_VERSION);
});

test('a cramped saved island moves onto the plan once, keeping every building', () => {
  const saved = load();
  const before = saved.buildings.map((b) => ({ ...b }));
  const sim = new Sim(world, chain, { saved });
  assert.equal(sim.layout, LAYOUT_VERSION);
  assert.equal(sim.buildings.length, before.length, 'no building lost');
  for (const b of sim.buildings) {
    const o = before.find((x) => x.id === b.id);
    assert.deepEqual([b.kind, b.type, b.owner, b.level, b.progress], [o.kind, o.type, o.owner, o.level, o.progress], `building ${b.id} kept as it was`);
  }
  for (let i = 0; i < sim.buildings.length; i++)
    for (let j = i + 1; j < sim.buildings.length; j++) {
      const g = gap(box(sim.buildings[i]), box(sim.buildings[j]));
      assert.ok(g >= 3, `${sim.buildings[i].type} ${sim.buildings[i].id} and ${sim.buildings[j].type} ${sim.buildings[j].id} are ${g} apart`);
    }
  // Every private building is on a plot, and that plot is taken.
  for (const b of sim.buildings.filter((x) => x.kind !== 'project')) {
    assert.ok(world.plots.some((p) => p.x === b.x && p.z === b.z), `building ${b.id} sits on a plot`);
    assert.ok(sim.takenPlots.has(`${b.x},${b.z}`), `its plot is marked taken`);
  }
  for (const b of sim.buildings.filter((x) => x.kind === 'project')) assert.deepEqual([b.x, b.z], [world.sites[b.type].x, world.sites[b.type].z]);
  // Nobody stands inside a building.
  for (const a of Object.values(sim.agents))
    for (const b of sim.buildings) {
      const k = box(b);
      assert.ok(!(a.x > k.x0 && a.x < k.x1 && a.z > k.z0 && a.z < k.z1), `${a.id} is not inside building ${b.id}`);
    }
  // A save made now is on the new plan, so the next start leaves it alone.
  const again = JSON.parse(JSON.stringify(sim.serialize()));
  assert.equal(again.layout, LAYOUT_VERSION);
  const pos = again.buildings.map((b) => `${b.id}:${b.x},${b.z}`).join(' ');
  const sim2 = new Sim(world, chain, { saved: again });
  assert.equal(sim2.buildings.map((b) => `${b.id}:${b.x},${b.z}`).join(' '), pos, 'reloading moves nothing');
  assert.equal(sim2.relocated, undefined);
});

test('a brand-new island starts on the plan and never relocates', () => {
  const sim = new Sim(world, chain, {});
  assert.equal(sim.layout, LAYOUT_VERSION);
  assert.equal(sim.relocated, undefined);
});

test('the live island (Nov 16) fits, with room kept for everyone still coming', () => {
  const saved = load();
  saved.buildings = JSON.parse(fs.readFileSync(new URL('./fixtures/live-buildings-2026-11-16.json', import.meta.url), 'utf8'));
  saved.takenPlots = [];
  saved.jobs = [];
  const sim = new Sim(world, chain, { saved });
  assert.equal(sim.relocated, saved.buildings.length, 'every building moved onto the plan');
  for (let i = 0; i < sim.buildings.length; i++)
    for (let j = i + 1; j < sim.buildings.length; j++) assert.ok(gap(box(sim.buildings[i]), box(sim.buildings[j])) >= 3);
  // Ivy (day 18) and Hazel (day 25) build a house and workshop in town; Shelly (day 20) at North Beach.
  const free = {};
  for (const p of world.plots) if (!sim.takenPlots.has(`${p.x},${p.z}`)) free[p.zone] = (free[p.zone] || 0) + 1;
  assert.ok(free.harbor >= 4 + 6, `town has room for Ivy, Hazel and more (${free.harbor} free)`);
  assert.ok(free.north >= 2, `North Beach has room for Shelly (${free.north} free)`);
  const totalFree = Object.values(free).reduce((a, b) => a + b, 0);
  assert.ok(totalFree >= 6 + 12, `spare plots for later arrivals (${totalFree} free)`);
  // The North Harbor (day 22) and the Founders Monument (day 27) have their own sites, clear of every building.
  for (const type of ['harbor', 'monument']) {
    const s = world.sites[type];
    assert.ok(s, `${type} has a site`);
    const site = box({ kind: 'project', type, x: s.x, z: s.z });
    for (const b of sim.buildings) assert.ok(gap(site, box(b)) >= 3, `${type} site is clear of building ${b.id}`);
  }
});
