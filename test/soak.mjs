// Soak test: runs the whole simulation with time sped up (no server, mock money) and samples
// the economy's health. Usage: node test/soak.mjs <speedup> <realMinutes> <genesisDayMinutes> <outDir>
import fs from 'node:fs';

const SPEED = Number(process.argv[2] || 6);
const REAL_MIN = Number(process.argv[3] || 30);
const DAY_MIN = Number(process.argv[4] || 6);
const OUT = process.argv[5] || 'data/soak';
fs.mkdirSync(OUT, { recursive: true });

// Speed up time: every timer fires SPEED times sooner and the clock runs SPEED times faster.
const realNow = Date.now.bind(Date), t0 = realNow();
Date.now = () => t0 + (realNow() - t0) * SPEED;
const rsT = globalThis.setTimeout, rsI = globalThis.setInterval;
globalThis.setTimeout = (fn, ms = 0, ...a) => rsT(fn, ms / SPEED, ...a);
globalThis.setInterval = (fn, ms = 0, ...a) => rsI(fn, ms / SPEED, ...a);

const { generateWorld } = await import('../server/world.js');
const { AGENT_DEFS } = await import('../server/agents.js');
const { createChain } = await import('../server/chain.js');
const { Sim } = await import('../server/sim.js');
process.env.CHAIN = 'mock';
const chain = await createChain(AGENT_DEFS.map((a) => a.id));
const sim = new Sim(generateWorld({ seed: 1337 }), chain, { dayMs: DAY_MIN * 60_000 });

const counts = {};
let errors = 0;
sim.on((e) => {
  const k = e.type === 'trade' ? `trade:${e.kind}` : e.type;
  counts[k] = (counts[k] || 0) + 1;
  if (e.type === 'chainError') errors++;
});
const origErr = console.error;
console.error = (...a) => { errors++; if (errors < 20) origErr(...a); };

const last = {}; // per agent: { x, z, task, since }
const stuck = new Set();
const rows = [];
const gini = (xs) => {
  const v = xs.slice().sort((a, b) => a - b), n = v.length, s = v.reduce((t, x) => t + x, 0);
  return s ? v.reduce((t, x, i) => t + (2 * (i + 1) - n - 1) * x, 0) / (n * s) : 0;
};
function sample() {
  const st = sim.state();
  const coins = st.agents.map((a) => a.balance);
  const total = coins.reduce((t, x) => t + x, 0);
  for (const a of st.agents) {
    const p = last[a.id];
    if (p && Math.hypot(p.x - a.x, p.z - a.z) < 0.01 && p.task === a.task && !['resting', 'minding the bank', 'holding office hours', 'thinking'].includes(a.task)) {
      if (Date.now() - p.since > 5 * 60_000) stuck.add(`${a.name}: "${a.task}"`);
    } else last[a.id] = { x: a.x, z: a.z, task: a.task, since: Date.now() };
  }
  const row = {
    simMin: Math.round((Date.now() - t0) / 60_000), day: st.day, pop: st.agents.length, gdp: Math.round(st.market.gdp),
    trades: st.market.trades, bank: st.bank.balance, agentCoins: Math.round(total), gini: +gini(coins).toFixed(2),
    richest: st.agents.slice().sort((a, b) => b.balance - a.balance)[0]?.name, richShare: +(Math.max(...coins) / total).toFixed(2),
    ore: st.market.ore.last, fish: st.market.fish.last, wood: st.market.wood.last, grain: st.market.grain.last,
    avgHunger: +(st.agents.reduce((t, a) => t + a.hunger, 0) / st.agents.length).toFixed(1), starving: st.agents.filter((a) => a.hunger >= 9).length,
    built: st.economy.built, loansOpen: st.loans.length, defaults: st.economy.defaults, thefts: st.economy.thefts, taxes: st.economy.taxes,
    eras: st.eras.filter((e) => e.unlocked).length, saveKB: Math.round(JSON.stringify(sim.serialize()).length / 1024),
    rssMB: Math.round(process.memoryUsage().rss / 1e6), errors,
  };
  rows.push(row);
  fs.writeFileSync(`${OUT}/samples.json`, JSON.stringify(rows, null, 1));
}
sim.start();
rsI(sample, 20_000);
rsT(() => {
  sample();
  const st = sim.state();
  const report = {
    ranRealMin: REAL_MIN, speedup: SPEED, simHours: +(REAL_MIN * SPEED / 60).toFixed(1), genesisDays: st.day,
    final: rows[rows.length - 1], counts, stuck: [...stuck],
    projects: st.projects.map((p) => `${p.id}:${p.status}`),
    buildings: st.buildings.map((b) => `${b.type}L${b.level}@${b.owner || 'public'}${b.progress < 1 ? `(${Math.round(b.progress * 100)}%)` : ''}`),
    agents: st.agents.map((a) => `${a.name} ${Math.round(a.balance)}c h${a.hunger} ${JSON.stringify(a.inv)}`),
  };
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  fs.writeFileSync(`${OUT}/world.json`, JSON.stringify(sim.serialize()));
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}, REAL_MIN * 60_000);
