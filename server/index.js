// Starts the world: runs the simulation, saves it as it goes, and streams it to anyone watching.

import './env.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { generateWorld } from './world.js';
import { AGENT_DEFS } from './agents.js';
import { createChain } from './chain.js';
import { Sim } from './sim.js';
import { llmStats, llmUsage } from './brain.js';
import { DEFAULT_DAY_MS } from './eras.js';
import { Relations } from './relations.js';

const PORT = Number(process.env.PORT || 3000);
const DAY_MS = Number(process.env.INSULA_DAY_MS || DEFAULT_DAY_MS);
const SAVE = path.resolve(process.env.INSULA_SAVE || 'data/world.json');

// Each save belongs to one coin. A save from another chain or coin (the devnet test world, say) is
// set aside, never loaded: launch day starts a fresh island on mainnet with no extra steps.
const CHAIN_ID = (() => {
  if ((process.env.CHAIN || '').toLowerCase() === 'mock') return 'mock';
  try { const c = JSON.parse(fs.readFileSync(path.resolve('chain-config.json'), 'utf8')); return `${c.cluster}:${c.mint || c.token}`; } catch { return 'mock'; }
})();
if (fs.existsSync(SAVE) && CHAIN_ID !== 'mock') {
  let other = null;
  try { const s = JSON.parse(fs.readFileSync(SAVE, 'utf8')); other = s.chainId ? (s.chainId !== CHAIN_ID ? s.chainId : null) : (CHAIN_ID.startsWith('devnet') ? null : 'devnet'); } catch {}
  if (other) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dir = path.dirname(SAVE), base = path.basename(SAVE, '.json');
    fs.renameSync(SAVE, path.join(dir, `${base}.${other.split(':')[0]}-${stamp}.json`));
    const dec = path.join(dir, base === 'world' ? 'decisions' : `decisions-${base}`);
    if (fs.existsSync(dec)) fs.renameSync(dec, `${dec}.${other.split(':')[0]}-${stamp}`);
    console.log(`The save at ${SAVE} was for ${other}, not ${CHAIN_ID}. Set it aside and starting a new island.`);
  }
}

// Pick up where the island left off.
let saved = null;
if (fs.existsSync(SAVE) && process.env.INSULA_FRESH !== '1') {
  try {
    saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    console.log(`Restored the island from ${SAVE} (genesis ${new Date(saved.genesis).toISOString()}).`);
  } catch (e) {
    console.warn(`Couldn't read ${SAVE} (${e.message}). Starting a new island.`);
  }
}

const world = generateWorld({ seed: Number(process.env.SEED || 1337) });
const chain = await createChain(AGENT_DEFS.map((a) => a.id), saved?.mockBalances);
if (chain.network) process.env.INSULA_NETWORK = chain.network.replace(/ testnet$/i, '');
const sim = new Sim(world, chain, { dayMs: DAY_MS, saved });

function save() {
  fs.mkdirSync(path.dirname(SAVE), { recursive: true });
  const tmp = `${SAVE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...sim.serialize(), chainId: CHAIN_ID }));
  fs.renameSync(tmp, SAVE); // write-then-rename so a crash never leaves a half-written save
}
setInterval(save, 30_000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { save(); globalThis.saveRelations?.(); console.log('\nSaved the island. Bye.'); } catch (e) { console.error('Save failed:', e.message); }
    process.exit(0);
  });
}

const app = express();
app.use(express.static(path.resolve('web')));
app.use('/vendor/three', express.static(path.resolve('node_modules/three')));
app.get('/api/state', (_req, res) => res.json(sim.state()));
app.get('/api/world', (_req, res) => res.json(world));
app.get('/api/history', (_req, res) => res.json(sim.history));

// The decision log: every agent decision that moved money, with the record whose fingerprint is in the memo.
// Each save gets its own decision folder, so test runs never mix with the real world's records.
const SAVE_BASE = path.basename(SAVE, '.json');
const DECISIONS_DIR = path.join(path.dirname(SAVE), SAVE_BASE === 'world' ? 'decisions' : `decisions-${SAVE_BASE}`);
fs.mkdirSync(DECISIONS_DIR, { recursive: true });
sim.on((e) => {
  if (e.type !== 'decision') return;
  const file = path.join(DECISIONS_DIR, `day-${String(e.record.day).padStart(3, '0')}.jsonl`);
  fs.appendFile(file, JSON.stringify(e.record) + '\n', () => {});
});
// Relationships between inhabitants (trades, walk-aways, loans, thefts), for the profiles.
const relations = new Relations(SAVE.replace(/\.json$/, '') + '.relations.json', CHAIN_ID, sim);
try {
  const n = relations.backfill(DECISIONS_DIR);
  if (n) console.log(`Relationships: rebuilt ${n} past interactions from the decision files.`);
} catch (e) { console.error('[relations] backfill', e.message); }
sim.on((e) => { try { relations.record(e); } catch {} });
globalThis.saveRelations = () => relations.save();
setInterval(() => { try { relations.save(); } catch (e) { console.error('[relations]', e.message); } }, 30_000);
app.get('/api/relations', (_req, res) => res.json(relations.summary()));

function findDecision(id) {
  const live = sim.decisionLog.get(id);
  if (live?.hash) return live;
  const needle = `"id":"${id}"`;
  for (const f of fs.readdirSync(DECISIONS_DIR).sort().reverse()) {
    const lines = fs.readFileSync(path.join(DECISIONS_DIR, f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return JSON.parse(lines[i]);
  }
  return live || null;
}
app.get('/api/decisions/:id', (req, res) => {
  const rec = /^D\d+$/.test(req.params.id) ? findDecision(req.params.id) : null;
  return rec ? res.json(rec) : res.status(404).json({ error: 'No decision with that ID.' });
});
app.get('/api/decisions', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 50);
  res.json([...sim.decisionLog.values()].filter((r) => r.hash).slice(-limit).reverse());
});
app.get('/decisions', (_req, res) => res.redirect('/api/decisions?limit=500'));

// The Insula Daily: one edition per genesis day, plus today's paper so far.
app.get('/api/daily', (_req, res) => res.json({ editions: sim.daily.index(), latest: sim.daily.latest() }));
app.get('/api/daily/live', (_req, res) => res.json(sim.daily.live()));
app.get('/api/daily/:day', (req, res) => {
  const ed = sim.daily.edition(Number(req.params.day));
  return ed ? res.json(ed) : res.status(404).json({ error: 'No edition for that day yet.' });
});
app.get('/daily', (_req, res) => res.redirect('/#daily'));

const server = http.createServer(app);
// Updates are compressed on the wire (permessage-deflate). Each message is built once and sent to everyone.
const wss = new WebSocketServer({
  server, path: '/ws',
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 6 }, serverNoContextTakeover: false, clientNoContextTakeover: false },
});
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
};
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', world, history: sim.history, thoughts: sim.thoughts, state: sim.state() }));
});
sim.on((event) => broadcast({ type: 'event', event }));
// Two update streams, so viewers only download what changes:
//  - "tick", 5 times a second: just the moving parts (where each agent is, what it's doing, its wallet)
//  - "state", every 2 seconds: everything else (buildings, roadmap, loans, market, projects)
// The viewer glides agents smoothly between ticks, so it looks the same as before at a fraction of the bandwidth.
const round2 = (v) => Math.round(v * 100) / 100;
setInterval(() => {
  if (!wss.clients.size) return;
  const a = Object.values(sim.agents).map((g) => {
    const s = g.snapshot();
    return [s.id, round2(s.x), round2(s.z), round2(s.y), round2(s.heading), s.moving ? 1 : 0, s.thinking ? 1 : 0, s.task, s.activity, s.say, s.hunger,
      s.inv.ore, s.inv.fish, s.inv.wood, s.inv.grain, Math.round(s.balance)];
  });
  broadcast({ type: 'tick', t: Date.now(), a });
}, 200);
setInterval(() => { if (wss.clients.size) broadcast({ type: 'state', state: sim.state() }); }, 2000);

server.listen(PORT, () => {
  const llm = llmStats();
  console.log(`\nInsula World is live at http://localhost:${PORT}`);
  console.log(`Money: ${chain.mode === 'mock' ? 'MOCK (fake transfers)' : `real ${chain.cluster} token transfers`}`);
  console.log(`Brains: ${llm.on ? `AI (${llm.model})` : 'rule-based (set ANTHROPIC_API_KEY for AI brains)'}`);
  console.log(`Timeline: one genesis day = ${DAY_MS === DEFAULT_DAY_MS ? '24 hours' : `${DAY_MS / 1000}s (fast mode)`}. Saving to ${SAVE}\n`);
  sim.start();
});

// AI cost report every 10 minutes (and on /api/usage), so you can see what the brains cost before launch.
// Set LLM_PRICE_IN and LLM_PRICE_OUT in .env (dollars per million tokens) to get a dollar estimate.
function usageReport() {
  const u = llmUsage();
  const hours = Math.max(1e-9, (Date.now() - u.since) / 3_600_000);
  const pin = Number(process.env.LLM_PRICE_IN || 0), pout = Number(process.env.LLM_PRICE_OUT || 0);
  const cost = (u.input * pin + u.output * pout) / 1e6;
  return {
    calls: u.calls, failed: u.failed, inputTokens: u.input, outputTokens: u.output, hours: +hours.toFixed(2),
    callsPerHour: Math.round(u.calls / hours), decisions: sim.decisions,
    costSoFar: pin || pout ? +cost.toFixed(4) : null,
    costPerDay: pin || pout ? +((cost / hours) * 24).toFixed(2) : null,
    costPer30Days: pin || pout ? +((cost / hours) * 24 * 30).toFixed(2) : null,
    // Answers the rule brain gave instead of the AI because they were clear-cut (an obvious yes or no).
    ruleShortcuts: u.ruleShortcuts,
    // Where the AI spend goes, by kind of call, most expensive first.
    byKind: Object.fromEntries(Object.entries(u.byKind)
      .map(([k, v]) => [k, { calls: v.calls, failed: v.failed, tokensPerCall: v.calls ? Math.round((v.input + v.output) / v.calls) : 0, cost: +((v.input * pin + v.output * pout) / 1e6).toFixed(4), share: cost ? `${Math.round(((v.input * pin + v.output * pout) / 1e6 / cost) * 100)}%` : null }])
      .sort((a, b) => b[1].cost - a[1].cost)),
  };
}
app.get('/api/usage', (_req, res) => res.json(usageReport()));

// Economy log: one line a minute next to the save file (e.g. data/world.samples.jsonl), plus the latest
// AI usage report (data/world.usage.json). Handy for spotting problems over a long run.
const SAMPLES = SAVE.replace(/\.json$/, '') + '.samples.jsonl';
const USAGE = SAVE.replace(/\.json$/, '') + '.usage.json';
let chainErrors = 0;
sim.on((e) => { if (e.type === 'chainError') chainErrors++; });
function gini(xs) {
  const v = xs.slice().sort((a, b) => a - b);
  const n = v.length, sum = v.reduce((t, x) => t + x, 0);
  if (!n || !sum) return 0;
  return v.reduce((t, x, i) => t + (2 * (i + 1) - n - 1) * x, 0) / (n * sum);
}
setInterval(() => {
  try {
    const st = sim.state();
    const coins = st.agents.map((a) => a.balance);
    const rich = st.agents.slice().sort((a, b) => b.balance - a.balance)[0];
    const line = {
      at: new Date().toISOString(), day: st.day, pop: st.agents.length, bank: st.bank.balance,
      agentCoins: Math.round(coins.reduce((t, x) => t + x, 0)), gini: +gini(coins).toFixed(2),
      richest: rich ? `${rich.name} ${Math.round(rich.balance)}` : null, gdp: Math.round(st.market.gdp), trades: st.market.trades,
      built: st.economy.built, loanBook: st.economy.loanBook, defaults: st.economy.defaults, thefts: st.economy.thefts,
      starving: st.agents.filter((a) => a.hunger >= 9).length, eras: st.eras.filter((e) => e.unlocked).length,
      projectsDone: st.projects.filter((p) => p.status === 'done').length, chainErrors, ai: usageReport(),
      // For the economy charts: island prices, what the mainland pays, each agent's wallet and stock,
      // and their building levels (a workshop upgrade is the only thing that raises an agent's output).
      prices: Object.fromEntries(st.items.map((i) => [i, st.market[i]?.last])),
      mainland: Object.fromEntries(st.items.map((i) => [i, sim.mainlandPrice(i)])),
      agents: Object.fromEntries(st.agents.map((a) => [a.id, {
        coins: Math.round(a.balance), inv: a.inv, hunger: a.hunger,
        house: st.buildings.find((b) => b.owner === a.id && b.type === 'house')?.level || 0,
        workshop: st.buildings.find((b) => b.owner === a.id && b.type === 'workshop')?.level || 0,
      }])),
    };
    fs.appendFileSync(SAMPLES, JSON.stringify(line) + '\n');
    fs.writeFileSync(USAGE, JSON.stringify(line.ai, null, 1));
  } catch (e) { console.error('[samples]', e.message); }
}, 60_000);
if (llmStats().on) {
  setInterval(() => {
    const r = usageReport();
    console.log(`[ai] ${r.calls} calls (${r.failed} failed), ${r.inputTokens} in / ${r.outputTokens} out tokens in ${r.hours}h` +
      (r.costPer30Days != null ? `, ~$${r.costPerDay}/day, ~$${r.costPer30Days} for 30 days` : ' (set LLM_PRICE_IN / LLM_PRICE_OUT in .env for a $ estimate)'));
  }, 10 * 60_000);
}
