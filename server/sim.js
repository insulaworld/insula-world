// The simulation: an autonomous agent economy that grows over its first month.
// Agents decide for themselves what to do (work, trade, borrow, build, donate, and for one raccoon, steal),
// every coin that changes hands is a real token transfer, and the 30-day timeline in eras.js
// opens new land, new buildings, public works and new arrivals as the economy earns them.

import { Reporter } from './daily.js';
import { groundY, zoneAt } from './world.js';
import {
  AGENT_DEFS, PRICES, MAINLAND, RESOURCES, ITEMS, CARRY, FOOD, LOAN, BUILDINGS, PROJECTS,
  HOUSE_HUNGER_SKIP, WORKSHOP_BOOST, START_COINS, upgradeCost,
} from './agents.js';
import { ERAS, DEFAULT_DAY_MS } from './eras.js';
import * as brain from './brain.js';
import { Election } from './election.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SPEED = 2.4; // tiles per second
// Animals are about a tile wide, nose to tail. Two that meet to deal stop this far apart (centre to
// centre) so their faces don't overlap, and anyone closer than PERSONAL_SPACE gets nudged apart.
const MEET_GAP = 2.4;
const PERSONAL_SPACE = 1.5;
// Buildings are solid: an animal's centre stays this far outside a building's walls.
const WALL_PAD = 0.4;
const BIG_PROJECTS = new Set(['townhall', 'markethall']);
const SKY_MS = 10 * 60 * 1000; // one sky cycle (sunrise to night); must match web/app.js
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const DEF = Object.fromEntries(AGENT_DEFS.map((d) => [d.id, d]));

// The mainland's appetite: every unit shipped lowers what it pays for that item; the glut fades over ~20 minutes.
const GLUT = { ore: 30, fish: 50, wood: 60, grain: 60 };
const GLUT_FADE_MS = 20 * 60 * 1000;
// Imports: the mainland always sells, but at a premium. Coins paid go back to the bank.
const IMPORT_MARKUP = 1.6;
// Food spoils: above the pantry (bigger with a house), this share of the extra rots every minute.
const SPOIL = { items: ['fish', 'grain'], pantry: 12, perHouseLevel: 8, rate: 0.12, everyMs: 60_000 };

// Proof of decision: every agent-caused payment carries the ID and a SHA-256 fingerprint of the decision record
// (what the agent had, what it chose, its reasoning, the negotiation) in its on-chain memo.
async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function canonical(rec) {
  const { id, agent, at, day, brain, saw, options, choice, qty, price, thought, said } = rec;
  return JSON.stringify({ id, agent, at, day, brain, saw, options, choice, qty, price, thought, said, steps: rec.steps.slice() });
}

class Agent {
  constructor(def, sim, pos) {
    Object.assign(this, def);
    this.sim = sim;
    this.x = pos.x;
    this.z = pos.z;
    this.heading = 0;
    this.target = null;
    this.follow = null;
    this.arrive = null;
    this.task = 'waking up';
    this.activity = null; // 'mining' | 'fishing' | 'chopping' | 'farming' | 'building'
    this.thinking = false;
    this.inv = { ore: 0, fish: 2, wood: 0, grain: 0 };
    this.hunger = 2;
    this.memory = [];
    this.refusals = {};
    this.grudges = {}; // otherId -> { n, last }: who they believe has wronged them
    this.say = null;
    this.engaged = false;
  }

  // How strongly this agent holds a grudge against someone: each known theft counts, fading by half every 12 hours.
  grudge(id) {
    const g = this.grudges?.[id];
    if (!g) return 0;
    return g.n * Math.pow(0.5, (Date.now() - g.last) / GRUDGE_HALF_LIFE_MS);
  }

  holdGrudge(id, weight = 1) {
    const now = Date.now();
    const cur = this.grudge(id);
    this.grudges[id] = { n: Math.min(20, cur + weight), last: now };
  }

  remember(text) {
    this.memory.push(text);
    if (this.memory.length > 14) this.memory.shift();
  }

  // Holding the mayor's office right now (won the last election, or the first mayor before any election).
  get inOffice() { return this.sim.isMayor(this); }

  // The decision record this agent's words currently belong to: the deal it's in, or its own latest decision.
  activeRecord() { return this.dealRec || this.decision || null; }

  speak(text, ms = 3200) {
    if (!text) return;
    this.say = { text: String(text).slice(0, 100), until: Date.now() + ms };
    const rec = this.activeRecord();
    if (rec && !rec.hash && rec.steps.length < 30 && this.engaged) rec.steps.push({ who: this.id, said: this.say.text });
    this.sim.emit({ type: 'say', agent: this.id, name: this.name, text: this.say.text });
  }

  think(text, action, decisionId) {
    if (!text) return;
    const rec = this.activeRecord();
    if (!decisionId && rec && !rec.hash && rec.steps.length < 30) rec.steps.push({ who: this.id, thought: String(text).slice(0, 280), action: action || null });
    this.sim.emit({ type: 'thought', agent: this.id, name: this.name, text: String(text).slice(0, 280), action, decision: decisionId || rec?.id || null });
  }

  walkTo(x, z) {
    this.follow = null;
    this.target = { x, z };
    this.progressAt = 0;
    this.walkSince = Date.now();
    return new Promise((r) => (this.arrive = r));
  }

  walkToAgent(other) {
    this.target = null;
    this.follow = other;
    this.progressAt = 0;
    this.walkSince = Date.now();
    return new Promise((r) => (this.arrive = r));
  }

  async wait(ms) {
    await sleep(ms);
    while (this.engaged) await sleep(250);
  }

  step(dt) {
    if (this.engaged) return;
    const goal = this.follow ? { x: this.follow.x, z: this.follow.z } : this.target;
    if (!goal) return;
    const d = dist(this, goal);
    const reach = this.follow ? MEET_GAP : 0.15;
    // A little slack so an animal that has stopped at the right distance counts as arrived (otherwise
    // rounding leaves it creeping toward the exact gap forever).
    if (d <= reach + 0.05) {
      this.target = null;
      this.follow = null;
      const r = this.arrive;
      this.arrive = null;
      r?.();
      return;
    }
    const speed = this.follow ? SPEED * 1.4 : SPEED;
    const now = Date.now();
    const ghost = this.ghostUntil && now < this.ghostUntil;
    // Walk around buildings: head for the next corner when a house is in the way, then straight on.
    const wp = ghost ? goal : this.sim.waypoint(this, goal);
    const direct = wp === goal;
    const dw = direct ? d : dist(this, wp);
    let move = Math.min(speed * dt, direct ? d - reach * (this.follow ? 1 : 0.5) : dw);
    if (dw > 1e-6 && move > 0) {
      const dx = (wp.x - this.x) / dw, dz = (wp.z - this.z) / dw;
      this.x += dx * move;
      this.z += dz * move;
      this.heading = Math.atan2(dx, dz);
    }
    if (!ghost) this.sim.unclip(this);
    // Safety net: an animal that hasn't actually moved for 3 seconds, or has been walking to the same
    // place for 40 seconds, is allowed straight through for a moment so it can never get stuck.
    if (!this.progressAt || dist(this, this.progressPos) > 0.3) { this.progressAt = now; this.progressPos = { x: this.x, z: this.z }; }
    else if (now - this.progressAt > 3000) { this.ghostUntil = now + 3000; this.progressAt = now; }
    if (this.walkSince && now - this.walkSince > 40_000) { this.ghostUntil = now + 3000; this.walkSince = now; }
  }

  face(other) {
    this.heading = Math.atan2(other.x - this.x, other.z - this.z);
  }

  best() {
    return Object.entries(this.skills).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Effective skill, including any workshop bonus on the agent's best job.
  skill(item) {
    const shop = this.sim.buildings.find((b) => b.owner === this.id && b.type === 'workshop' && (b.progress >= 1 || b.level > 1));
    const lvl = shop ? (shop.progress >= 1 ? shop.level : shop.level - 1) : 0;
    return +(this.skills[item] * (item === this.best() ? WORKSHOP_BOOST[lvl] : 1)).toFixed(2);
  }

  houseLevel() {
    const h = this.sim.buildings.find((b) => b.owner === this.id && b.type === 'house');
    if (!h) return 0;
    return h.progress >= 1 ? h.level : h.level - 1;
  }

  save() {
    return { id: this.id, x: this.x, z: this.z, inv: this.inv, hunger: this.hunger, memory: this.memory, refusals: this.refusals, grudges: this.grudges };
  }

  snapshot() {
    return {
      id: this.id, name: this.name, species: this.species, role: this.role || null, mayor: this.inOffice,
      erc8004: this.sim.identity?.ids?.[this.id] ? { agentId: this.sim.identity.ids[this.id].agentId, url: this.sim.identity.ids[this.id].url } : null,
      // Elected mayors keep their own job; a mayor voted out shows as a former mayor.
      job: this.inOffice && this.role !== 'mayor' ? `${this.job} & mayor` : !this.inOffice && this.role === 'mayor' && this.sim.election?.office ? 'former mayor' : this.job,
      color: this.color, accent: this.accent,
      x: +this.x.toFixed(3), z: +this.z.toFixed(3), y: groundY(this.sim.world, this.x, this.z),
      // At work, keep facing the work (the rock, tree or water) once a chat with a customer is over.
      heading: +(this.activity && this.workHeading != null && !this.engaged ? this.workHeading : this.heading).toFixed(3),
      moving: !this.engaged && Boolean(this.target || this.follow),
      task: this.task, activity: this.activity, thinking: this.thinking,
      inv: { ...this.inv }, hunger: this.hunger,
      say: this.say && this.say.until > Date.now() ? this.say.text : null,
      balance: Math.round(this.sim.chain.balance(this.id) * 100) / 100,
      address: this.sim.chain.addressOf(this.id),
      accountUrl: this.sim.chain.accountUrl(this.id),
    };
  }
}

// Smallest lot neighbors trade in (TRADE_MIN_LOT in .env). Fewer, bigger trades: same economy, less gas.
const MIN_LOT = Math.max(1, Number(process.env.TRADE_MIN_LOT || 6));
// Grudges: victims who know (or strongly suspect) who robbed them refuse deals, drive harder bargains and keep watch at night.
const GRUDGE_HALF_LIFE_MS = Number(process.env.GRUDGE_HALF_LIFE_MS || 8 * 3600_000);
const SUSPECT_ODDS = Number(process.env.GRUDGE_SUSPECT_ODDS || 0.5); // chance a victim works out who did it when the thief gets away
// Smallest shipment to the mainland worth sending, in coins (MIN_SHIP_COINS in .env).
const MIN_SHIP = Math.max(0, Number(process.env.MIN_SHIP_COINS || 40));

export class Sim {
  constructor(world, chain, opts = {}) {
    const saved = opts.saved || null;
    this.world = world;
    this.chain = chain;
    this.dayMs = opts.dayMs || DEFAULT_DAY_MS;
    this.listeners = new Set();
    this.history = saved?.history || [];
    this.thoughts = saved?.thoughts || [];
    this.news = saved?.news || [];
    this.genesis = saved?.genesis || Date.now();
    this.started = saved?.started || this.genesis;
    this.market = saved?.market || Object.fromEntries(ITEMS.map((i) => [i, { last: PRICES[i].fair, prev: PRICES[i].fair }]));
    this.market.gdp ??= 0;
    this.market.trades ??= 0;
    this.decisions = saved?.decisions || 0;
    this.loans = (saved?.loans || []).map((l) => ({ ...l, status: l.status === 'collecting' ? 'open' : l.status }));
    this.jobs = (saved?.jobs || []).map((j) => ({ ...j, status: j.status === 'building' ? 'queued' : j.status }));
    this.buildings = saved?.buildings || [];
    this.credit = saved?.credit || {};
    this.nextId = saved?.nextId || 1;
    this.unlocked = new Set(saved?.unlocked || []);
    this.projects = saved?.projects || {};
    this.lastTaxDay = saved?.lastTaxDay ?? 0;
    this.stats = saved?.stats || { thefts: 0, caught: 0, taxes: 0, donations: 0 };
    this.takenPlots = new Set(saved?.takenPlots || []);
    this.shipped = saved?.shipped || Object.fromEntries(ITEMS.map((i) => [i, 0]));
    this.decisionSeq = saved?.decisionSeq || 1;
    this.decisionLog = new Map(); // recent decision records by id (older ones live in the decision files)
    this.daily = new Reporter(this, saved?.daily);
    this.election = new Election(this, saved?.election);
    this.shippedAt = Date.now();
    this.agents = {};
    const m = world.places.market;
    const savedAgents = Object.fromEntries((saved?.agents || []).map((a) => [a.id, a]));
    const present = saved ? Object.keys(savedAgents) : AGENT_DEFS.filter((d) => !d.arrives).map((d) => d.id);
    present.forEach((id, i) => {
      const a = new Agent(DEF[id], this, { x: m.x - 1.5 + i * 1.2, z: m.z + 1 });
      if (savedAgents[id]) Object.assign(a, savedAgents[id], { inv: { ore: 0, fish: 0, wood: 0, grain: 0, ...savedAgents[id].inv } });
      this.agents[id] = a;
    });
  }

  // ---------- Events ----------

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(event) {
    event.ts = Date.now();
    if (['trade', 'log', 'chainError', 'era'].includes(event.type)) {
      this.history.push(event);
      if (this.history.length > 80) this.history.shift();
      if (event.text) {
        this.news.push(event.text);
        if (this.news.length > 10) this.news.shift();
      }
    }
    if (event.type === 'thought') {
      this.thoughts.push(event);
      if (this.thoughts.length > 80) this.thoughts.shift();
    }
    for (const fn of this.listeners) fn(event);
  }

  log(text) { this.emit({ type: 'log', text }); }
  mood(agent, mood) { this.emit({ type: 'mood', agent: agent.id, mood }); }

  // Every coin movement goes through here. Agent decisions are sealed and fingerprinted into the memo;
  // automatic payments (taxes, fines, grants, basic income, overdue collection) are labeled as rules.
  async #pay(from, to, amount, text, how) {
    const rec = how.by?.decision || null;
    let tag;
    if (rec) {
      if (!rec.hash) {
        rec.canonical = canonical(rec);
        rec.hash = await sha256(rec.canonical);
      }
      tag = `#${rec.id} why:${rec.hash.slice(0, 16)}`;
    } else tag = `rule:${how.rule}`;
    const res = await this.chain.transfer(from, to, amount, `Insula ${tag} | ${text}`);
    if (rec) {
      rec.txs.push({ sig: res.sig, url: res.url, from, to, amount, text });
      this.emit({ type: 'decision', record: rec });
    }
    return { ...res, decision: rec?.id || null, hash: rec?.hash || null, rule: rec ? null : how.rule };
  }

  // Seal a decision record that moves no money (a candidacy, a vote): fingerprint it like a payment decision
  // and write it to the decision files, so it can be looked up at /api/decisions/<id>.
  async seal(rec) {
    rec.canonical = canonical(rec);
    rec.hash = await sha256(rec.canonical);
    this.decisionLog.set(rec.id, rec);
    if (this.decisionLog.size > 3000) this.decisionLog.delete(this.decisionLog.keys().next().value);
    this.emit({ type: 'decision', record: rec });
    return rec;
  }

  // An automatic payment under a named rule (the election's treasury handover, theft relief).
  rulePayment(from, to, amount, text, rule) { return this.#pay(from, to, amount, text, { rule }); }

  #release(a, b) {
    a.engaged = b.engaged = false;
    a.dealRec = b.dealRec = null;
  }

  #record(item, price, amount) {
    if (item && this.market[item]) {
      this.market[item].prev = this.market[item].last;
      this.market[item].last = price;
    }
    this.market.gdp += amount;
    this.market.trades++;
  }

  // ---------- Timeline ----------

  genesisDay() { return Math.floor((Date.now() - this.genesis) / this.dayMs); }
  has(flag) { return ERAS.some((e) => this.unlocked.has(e.id) && e.unlock[flag]); }
  zonesOpen() { return new Set(ERAS.filter((e) => this.unlocked.has(e.id)).flatMap((e) => e.unlock.zones || [])); }
  itemsOpen() { return ITEMS.filter((i) => i !== 'grain' || ERAS.some((e) => this.unlocked.has(e.id) && e.unlock.items?.includes('grain'))); }
  maxLevel(type) {
    const key = type === 'house' ? 'houseLevel' : 'workshopLevel';
    return Math.max(0, ...ERAS.filter((e) => this.unlocked.has(e.id) && e.unlock[key]).map((e) => e.unlock[key]));
  }
  projectDone(id) { return this.projects[id]?.status === 'done'; }
  builtCount() { return this.buildings.filter((b) => b.kind === 'private' && b.progress >= 1).length; }
  isNight() { const t = ((Date.now() - this.started) % SKY_MS) / SKY_MS; return t > 0.7 && t < 0.97; }
  byRole(role) { return Object.values(this.agents).filter((a) => a.role === role); }
  isMayor(agent) { return Boolean(agent) && this.election?.mayorId() === agent.id; }
  mayor() { return this.agents[this.election?.mayorId()] || null; }
  exportBoost() { return 1 + (this.projectDone('lighthouse') ? 0.15 : 0) + (this.projectDone('harbor') ? 0.15 : 0); }
  #fadeGlut() {
    const k = Math.exp(-(Date.now() - this.shippedAt) / GLUT_FADE_MS);
    for (const i of ITEMS) this.shipped[i] *= k;
    this.shippedAt = Date.now();
  }
  mainlandPrice(item) {
    this.#fadeGlut();
    return Math.max(1, Math.round((MAINLAND[item] * this.exportBoost()) / (1 + this.shipped[item] / GLUT[item])));
  }
  importPrice(item) { return Math.round(PRICES[item].fair * IMPORT_MARKUP); }
  // On short test days (fast mode, filming) builders work proportionally faster, so the whole month's
  // construction fits in the compressed timeline. On real 24-hour days this is 1 (normal speed).
  buildPace() { return Math.min(1, Math.max(0.25, this.dayMs / 600_000)); }
  talkGap() { return this.projectDone('markethall') ? 1250 : 1900; }
  foodFills(item) { return FOOD[item] + (this.projectDone('granary') ? 1 : 0); }

  #checkEras() {
    const day = this.genesisDay();
    for (const era of ERAS) {
      if (this.unlocked.has(era.id) || day < era.day) continue;
      const n = era.needs || {};
      // GDP targets are sized for real days; shorter preview days shrink them proportionally.
      if (n.gdp && this.market.gdp < n.gdp * Math.min(1, Math.max(0.05, this.dayMs / 600_000))) continue;
      if (n.buildings && this.builtCount() < n.buildings) continue;
      if (n.project && !this.projectDone(n.project)) continue;
      this.#unlock(era);
    }
  }

  #unlock(era) {
    this.unlocked.add(era.id);
    const u = era.unlock;
    for (const p of u.projects || []) {
      if (this.projects[p]) continue;
      const builder = this.byRole('builder').sort((a, b) => this.#queueOf(a) - this.#queueOf(b))[0];
      this.projects[p] = { id: p, status: 'funding', funded: 0, need: PROJECTS[p].labor, builder: builder?.id || null, donors: {} };
    }
    if (era.id !== 'genesis') this.emit({ type: 'era', id: era.id, title: era.title, text: `Day ${era.day + 1}: ${era.title}. ${era.summary}`, summary: era.summary, day: era.day + 1 });
    if (u.festival) this.emit({ type: 'world', kind: 'fireworks' });
    for (const id of u.arrivals || []) this.#arrive(id).catch((e) => console.error('[sim] arrival', e));
  }

  async #arrive(id) {
    if (this.agents[id]) return;
    const def = DEF[id];
    const w = this.world;
    const spot = def.homeZone && w.zones[def.homeZone] ? { x: w.zones[def.homeZone].cx, z: w.zones[def.homeZone].cz } : { x: w.places.dock.x, z: w.places.dock.z };
    const a = new Agent(def, this, spot);
    this.agents[id] = a;
    const grant = START_COINS[id];
    try {
      const res = await this.#pay('bank', id, grant, `welcome grant for ${def.name}`, { rule: 'welcome' });
      this.emit({ type: 'trade', kind: 'income', from: 'bank', to: id, amount: grant, text: `${def.name} the ${cap(def.species)} arrived with ${grant} coins from the mainland`, ...res });
    } catch (e) {
      this.#chainError(e, 'welcome grant');
    }
    this.emit({ type: 'arrival', agent: id, name: def.name, species: def.species, job: def.job });
    a.speak(`Hello, Insula! ${def.name} the ${def.job} reporting.`, 4200);
    a.think(`Just arrived with ${grant} coins. I'm a ${def.job}; time to find my place in this economy.`, 'ARRIVE');
    this.#loop(a);
  }

  // ---------- Save ----------

  serialize() {
    return {
      version: 2,
      genesis: this.genesis, started: this.started, savedAt: Date.now(),
      market: this.market, decisions: this.decisions, loans: this.loans, jobs: this.jobs, buildings: this.buildings,
      credit: this.credit, nextId: this.nextId, unlocked: [...this.unlocked], projects: this.projects,
      lastTaxDay: this.lastTaxDay, stats: this.stats, takenPlots: [...this.takenPlots], shipped: this.shipped, decisionSeq: this.decisionSeq,
      election: this.election.save(),
      agents: Object.values(this.agents).map((a) => a.save()),
      history: this.history.slice(-80), thoughts: this.thoughts.slice(-80), news: this.news, daily: this.daily.save(),
      mockBalances: this.chain.mode === 'mock' ? this.chain.balances : undefined,
    };
  }

  // ---------- What viewers see ----------

  state() {
    const elapsed = Date.now() - this.started;
    const sinceGenesis = Date.now() - this.genesis;
    return {
      agents: Object.values(this.agents).map((a) => a.snapshot()),
      bank: { balance: Math.round(this.chain.balance('bank')), address: this.chain.addressOf('bank'), accountUrl: this.chain.accountUrl('bank') },
      chain: { mode: this.chain.mode, cluster: this.chain.cluster, network: this.chain.network || null, explorer: this.chain.explorerName || null, token: this.chain.tokenAddress || null, buyUrl: this.chain.buyUrl || null },
      llm: brain.llmStats(),
      time: (elapsed % SKY_MS) / SKY_MS,
      day: Math.floor(sinceGenesis / this.dayMs) + 1,
      dayProgress: (sinceGenesis % this.dayMs) / this.dayMs,
      dayMs: this.dayMs,
      market: JSON.parse(JSON.stringify(this.market)),
      decisions: this.decisions,
      loans: this.loans.filter((l) => l.status === 'open').map((l) => ({ ...l, dueIn: Math.max(0, Math.round((l.due - Date.now()) / 1000)) })),
      buildings: this.buildings.map((b) => ({ ...b })),
      projects: Object.values(this.projects).map((p) => ({ id: p.id, label: PROJECTS[p.id].label, status: p.status, funded: Math.round(p.funded), need: p.need, builder: p.builder, perk: PROJECTS[p.id].perk })),
      zones: [...this.zonesOpen()],
      items: this.itemsOpen(),
      eras: ERAS.map((e) => ({ id: e.id, day: e.day, title: e.title, summary: e.summary, unlocked: this.unlocked.has(e.id), after: e.needs?.project || null })),
      economy: {
        loanBook: Math.round(this.loans.filter((l) => l.status === 'open').reduce((t, l) => t + l.owed, 0)),
        defaults: this.loans.filter((l) => l.status === 'defaulted').length,
        built: this.buildings.filter((b) => b.progress >= 1).length,
        population: Object.keys(this.agents).length,
        thefts: this.stats.thefts,
        taxes: this.stats.taxes,
      },
      election: this.election.view(),
    };
  }

  // What an agent can see when deciding.
  context(agent) {
    const builders = this.byRole('builder');
    return {
      self: { coins: this.chain.balance(agent.id), inv: { ...agent.inv }, hunger: agent.hunger, skills: Object.fromEntries(ITEMS.map((i) => [i, agent.skill(i)])), pantry: this.pantry(agent) },
      others: Object.values(this.agents)
        .filter((a) => a !== agent)
        .map((a) => ({ id: a.id, name: a.name, species: a.species, role: a.role || null, skills: a.skills, coins: this.chain.balance(a.id), inv: { ...a.inv }, task: a.task })),
      market: Object.fromEntries(ITEMS.map((i) => [i, this.market[i].last])),
      mainland: Object.fromEntries(ITEMS.map((i) => [i, this.mainlandPrice(i)])),
      items: this.itemsOpen(),
      food: Object.fromEntries(Object.keys(FOOD).map((i) => [i, this.foodFills(i)])),
      news: this.news.slice(),
      memory: agent.memory.slice(),
      role: agent.role || null,
      day: this.genesisDay() + 1,
      night: this.isNight(),
      loan: this.#openLoan(agent.id),
      loansGiven: agent.role === 'banker' ? this.loans.filter((l) => l.status === 'open' && l.lender === agent.id).length : 0,
      credit: this.credit[agent.id] || { repaid: 0, defaulted: 0 },
      owns: this.buildings.filter((b) => b.owner === agent.id).map((b) => `${b.type} L${b.level}${b.progress < 1 ? ' (under construction)' : ''}`),
      myJobs: agent.role === 'builder' ? this.#queue(agent).map((j) => ({ id: j.id, kind: j.kind, label: this.#jobLabel(j), wood: this.#need(j).wood, ore: this.#need(j).ore })) : [],
      builderNeeds: Object.fromEntries(builders.map((b) => [b.id, this.#builderNeeds(b)])),
      pendingJob: this.jobs.some((j) => j.client === agent.id && j.status !== 'done'),
      projects: Object.values(this.projects).filter((p) => p.status === 'funding').map((p) => ({ id: p.id, label: PROJECTS[p.id].label, funded: Math.round(p.funded), need: p.need, perk: PROJECTS[p.id].perk })),
      refusals: Object.fromEntries(Object.entries(agent.refusals).filter(([, v]) => Date.now() - v.ts < 150_000).map(([k, v]) => [k, v.price])),
      grudges: Object.values(this.agents).filter((a) => a !== agent && agent.grudge(a.id) >= 0.5).map((a) => ({ id: a.id, name: a.name, level: Math.round(agent.grudge(a.id) * 10) / 10 })),
      isMayor: this.isMayor(agent),
      treasury: this.isMayor(agent) ? Math.round(this.election.office?.treasury ?? this.chain.balance(agent.id)) : null,
      policy: this.election.policy(),
      election: this.#electionNote(),
      watchedBy: agent.role === 'thief' ? Object.values(this.agents).filter((a) => a !== agent && a.grudge(agent.id) >= 2).map((a) => a.name) : [],
    };
  }

  // One line for every animal's briefing while a campaign is on.
  #electionNote() {
    const e = this.election, cur = e.current;
    if (e.phase !== 'campaign' || !cur?.candidates?.length) return null;
    const left = Math.max(0, e.voteAt - Date.now());
    return `Election ${cur.n} for mayor, vote in ${left >= 3600_000 ? `${Math.round(left / 3600_000)}h` : `${Math.ceil(left / 60_000)}m`}: ${cur.candidates.map((c) => `${c.name} (tax ${c.tax}, fine ${c.fine}, ${c.focus})`).join(' vs ')}`;
  }

  // Footprints of everything standing (or going up), padded so animals stay outside the walls.
  // Recomputed every couple of seconds; the harbor is a walkable pier, so it doesn't count.
  solids() {
    if (this._solidsAt && Date.now() - this._solidsAt < 2000) return this._solids;
    this._solidsAt = Date.now();
    this._solids = this.buildings.filter((b) => b.type !== 'harbor' && b.x != null).map((b) => {
      const half = (b.kind === 'project' && BIG_PROJECTS.has(b.type) ? 2.5 : 1.5) + WALL_PAD;
      return { x: b.x, z: b.z, half };
    });
    return this._solids;
  }

  // Where to head next on the way to `goal`: straight there when no building is in the way, otherwise the
  // corner (just outside the walls) of the first building on the line that makes the shortest detour.
  waypoint(a, goal) {
    const solids = this.solids();
    const inBox = (p, b, pad = 0) => Math.abs(p.x - b.x) < b.half + pad && Math.abs(p.z - b.z) < b.half + pad;
    // First building the straight line from p to q passes through (2D slab test).
    const firstHit = (p, q) => {
      let best = null, bestT = Infinity;
      const dx = q.x - p.x, dz = q.z - p.z;
      for (const b of solids) {
        if (inBox(p, b) || inBox(q, b)) continue;
        let t0 = 0, t1 = 1, ok = true;
        for (const [o, dd, lo, hi] of [[p.x, dx, b.x - b.half, b.x + b.half], [p.z, dz, b.z - b.half, b.z + b.half]]) {
          if (Math.abs(dd) < 1e-9) { if (o <= lo || o >= hi) { ok = false; break; } continue; }
          let ta = (lo - o) / dd, tb = (hi - o) / dd;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          if (t0 >= t1) { ok = false; break; }
        }
        if (ok && t0 < bestT) { bestT = t0; best = b; }
      }
      return best;
    };
    const b = firstHit(a, goal);
    if (!b) return goal;
    const h = b.half + 0.35;
    const len = (p, q) => Math.hypot(q.x - p.x, q.z - p.z);
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sz]) => ({ x: b.x + sx * h, z: b.z + sz * h }));
    const free = corners.map((c) => !solids.some((o) => inBox(c, o)));
    // Rest of the trip from corner i: straight to the goal if this building no longer blocks it,
    // otherwise around to the neighbouring corner that can see the goal.
    const tail = (i) => {
      const c = corners[i];
      if (firstHit(c, goal) !== b) return len(c, goal);
      let t = Infinity;
      for (const j of [(i + 1) % 4, (i + 3) % 4]) if (free[j] && firstHit(corners[j], goal) !== b) t = Math.min(t, len(c, corners[j]) + len(corners[j], goal));
      return t === Infinity ? len(c, goal) + 4 * h : t;
    };
    let best = null, cost = Infinity;
    corners.forEach((c, i) => {
      if (!free[i] || len(a, c) < 0.05 || firstHit(a, c)) return;
      const k = len(a, c) + tail(i);
      if (k < cost) { cost = k; best = c; }
    });
    return best || goal;
  }

  #insideSolid(x, z) {
    return this.solids().some((b) => Math.abs(x - b.x) < b.half && Math.abs(z - b.z) < b.half);
  }

  // Push an animal out of any building it's standing in, along the shortest way out.
  unclip(agent) {
    for (const b of this.solids()) {
      const dx = agent.x - b.x, dz = agent.z - b.z;
      const px = b.half - Math.abs(dx), pz = b.half - Math.abs(dz);
      if (px <= 0 || pz <= 0) continue;
      // Shortest way out first, but never into the sea.
      const sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
      const exits = [
        { x: agent.x + sx * px, z: agent.z, cost: px }, { x: agent.x, z: agent.z + sz * pz, cost: pz },
        { x: b.x - sx * b.half, z: agent.z, cost: 2 * b.half - px }, { x: agent.x, z: b.z - sz * b.half, cost: 2 * b.half - pz },
      ].sort((a, c) => a.cost - c.cost);
      const out = exits.find((e) => this.#dry(e.x, e.z)) || exits[0];
      agent.x = out.x; agent.z = out.z;
    }
  }

  #dry(x, z) {
    const w = this.world, xi = Math.round(x), zi = Math.round(z);
    if (xi < 0 || zi < 0 || xi >= w.size || zi >= w.size) return false;
    return w.heights[xi][zi] > w.waterLevel || Boolean(w.places?.dock?.pier?.tiles.some(([a, b]) => a === xi && b === zi));
  }

  // Land or pier, not open water, and not inside a building.
  #standable(x, z) {
    const w = this.world, xi = Math.round(x), zi = Math.round(z);
    if (xi < 0 || zi < 0 || xi >= w.size || zi >= w.size) return false;
    if (this.#insideSolid(x, z)) return false;
    if (w.heights[xi][zi] > w.waterLevel) return true;
    return Boolean(w.places?.dock?.pier?.tiles.some(([a, b]) => a === xi && b === zi));
  }

  // Personal space: animals closer than PERSONAL_SPACE drift apart, so a crowd at the dock or the market
  // stands side by side instead of inside each other. Two animals in a deal never get moved.
  #separate(dt) {
    const list = Object.values(this.agents);
    const k = Math.min(1, dt * 6);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.engaged && b.engaged) continue;
        let dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
        if (d >= PERSONAL_SPACE) continue;
        if (d < 0.01) { dx = Math.cos(i + j); dz = Math.sin(i + j); d = 1; }
        const push = (PERSONAL_SPACE - d) * k, ux = dx / d, uz = dz / d;
        const share = a.engaged ? [0, 1] : b.engaged ? [1, 0] : [0.5, 0.5];
        const ax = a.x + ux * push * share[0], az = a.z + uz * push * share[0];
        const bx = b.x - ux * push * share[1], bz = b.z - uz * push * share[1];
        if (share[0] && this.#dry(ax, az)) { a.x = ax; a.z = az; }
        if (share[1] && this.#dry(bx, bz)) { b.x = bx; b.z = bz; }
      }
    }
  }

  // ---------- Main loops ----------

  start() {
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      for (const a of Object.values(this.agents)) a.step(dt);
      this.#separate(dt);
      for (const a of Object.values(this.agents)) {
        if (a.engaged || (!a.target && !a.follow)) this.unclip(a);
      }
    }, 50);
    setInterval(() => {
      for (const a of Object.values(this.agents)) {
        if (Math.random() >= HOUSE_HUNGER_SKIP[a.houseLevel()]) a.hunger = Math.min(10, a.hunger + 1);
      }
    }, 14_000);
    setInterval(() => this.#collectOverdue(), 5000);
    setInterval(() => this.#safetyNet(), 60_000);
    setInterval(() => this.#spoil(), SPOIL.everyMs);
    setInterval(() => this.#checkEras(), 2000);
    setInterval(() => this.#collectTax(), 5000);
    if (!this.unlocked.has('genesis')) {
      this.#unlock(ERAS[0]);
      this.log('Genesis. The rules are set; from here on the agents run the economy.');
    }
    this.#checkEras();
    this.daily.start();
    this.election.start();
    for (const a of Object.values(this.agents)) this.#loop(a);
  }

  async #loop(agent) {
    await sleep(1200 + Math.random() * 1800);
    for (;;) {
      try {
        while (agent.engaged) await sleep(250);
        agent.thinking = true;
        agent.task = 'thinking';
        const options = this.#options(agent);
        const ctx = this.context(agent);
        const d = await brain.decide(agent, ctx, options);
        agent.thinking = false;
        this.decisions++;
        // Neighbor trades come in lots of at least MIN_LOT; settle the size here so the record matches the deal.
        if ((d.option.action === 'sell' || d.option.action === 'buy') && d.option.maxQty >= MIN_LOT) d.qty = Math.min(d.option.maxQty, Math.max(d.qty || 0, MIN_LOT));
        const rec = {
          id: `D${this.decisionSeq++}`, agent: agent.id, name: agent.name, at: Date.now(), day: this.genesisDay() + 1,
          brain: d.brain || 'rule', saw: { coins: Math.round(ctx.self.coins), inv: { ...ctx.self.inv }, hunger: ctx.self.hunger },
          options: options.length, choice: d.option.id, qty: d.qty ?? null, price: d.price ?? null, thought: d.thought || '', said: d.say || null,
          steps: [], txs: [],
        };
        this.decisionLog.set(rec.id, rec);
        if (this.decisionLog.size > 3000) this.decisionLog.delete(this.decisionLog.keys().next().value);
        agent.think(d.thought, this.#actionLabel(d), rec.id);
        agent.decision = rec;
        if (d.say) agent.speak(d.say);
        const began = Date.now();
        await this.#execute(agent, d);
        // Safety brake: an action that ends almost at once (nothing to do) shouldn't loop straight back into a
        // new decision, which would burn AI calls. Pause briefly instead.
        if (Date.now() - began < 1500) await sleep(2500);
        // Pace: after each action the agent rests a while before deciding again (THINK_GAP_MS, in .env).
        // Slows the whole island: fewer AI calls, fewer trades, less gas. 0 = no rest.
        const rest = Number(process.env.THINK_GAP_MS || 0);
        if (rest > 0) {
          const until = Date.now() + rest * (0.7 + Math.random() * 0.6);
          // Rest at home (beside your own house) most of the time, so the town spreads out instead of
          // everyone piling up at the dock or wherever the last deal happened.
          const home = this.buildings.find((b) => b.owner === agent.id && b.type === 'house' && b.progress >= 1);
          if (home && !agent.engaged && Math.random() < 0.7 && dist(agent, { x: home.x + 2.2, z: home.z + 0.6 }) > 1) {
            agent.task = 'heading home';
            await Promise.race([agent.walkTo(home.x + 2.2, home.z + 0.6), sleep(Math.max(0, until - Date.now()))]);
          }
          if (!agent.engaged) agent.task = 'resting';
          await sleep(Math.max(0, until - Date.now()));
        }
      } catch (e) {
        agent.thinking = false;
        console.error(`[sim] ${agent.name}:`, e);
        await sleep(3000);
      }
    }
  }

  // Everything an agent could do right now.
  #options(agent) {
    const opts = [];
    const items = this.itemsOpen();
    const coins = this.chain.balance(agent.id);
    for (const item of items) {
      // No room to carry more (and not starving for food): a trip would gather nothing, so don't offer it.
      if (agent.inv[item] >= this.#workGoal(agent, item) && !(FOOD[item] && agent.hunger >= 8)) continue;
      const rate = (60_000 / (RESOURCES[item].base / agent.skill(item))).toFixed(1);
      opts.push({ id: `work:${item}`, action: 'work', item, base: RESOURCES[item].base / agent.skill(item), label: `go ${RESOURCES[item].verb} (about ${rate} ${item} per minute for you)` });
    }
    for (const food of Object.keys(FOOD)) {
      if (agent.inv[food] > 0 && agent.hunger >= 2) opts.push({ id: `eat:${food}`, action: 'eat', item: food, maxQty: agent.inv[food], label: `eat ${food} (you have ${agent.inv[food]}; each removes ${this.foodFills(food)} hunger)` });
    }
    // After a failed deal, don't pitch the same trade to the same agent again for a while (TRADE_COOLDOWN_MS),
    // so the island isn't a loop of the same rejected offers.
    const tradeGap = Number(process.env.TRADE_COOLDOWN_MS || 600_000);
    const cooling = (key) => Date.now() - (agent.refusals[key]?.ts || 0) < tradeGap;
    for (const other of Object.values(this.agents)) {
      if (other === agent) continue;
      for (const item of items) {
        // Trades between neighbors come in lots of at least MIN_LOT: every trade is a real token transfer
        // that costs gas, so a few bigger deals beat a stream of tiny ones.
        if (agent.inv[item] >= MIN_LOT && !cooling(`sell:${item}:${other.id}`)) opts.push({ id: `sell:${item}:${other.id}`, action: 'sell', item, with: other.id, withName: other.name, maxQty: agent.inv[item], label: `sell ${item} to ${other.name} (you have ${agent.inv[item]}; lots of ${MIN_LOT} or more)` });
        if (other.inv[item] >= MIN_LOT && coins >= PRICES[item].min * MIN_LOT && !cooling(`buy:${item}:${other.id}`)) opts.push({ id: `buy:${item}:${other.id}`, action: 'buy', item, with: other.id, withName: other.name, maxQty: other.inv[item], label: `buy ${item} from ${other.name} (they have ${other.inv[item]}; lots of ${MIN_LOT} or more)` });
      }
    }
    for (const item of items) {
      // A shipment has to be worth at least MIN_SHIP coins: each one is a real transfer that costs gas.
      if (agent.inv[item] > 0 && agent.inv[item] * this.mainlandPrice(item) >= MIN_SHIP) opts.push({ id: `export:${item}`, action: 'export', item, maxQty: agent.inv[item], label: `ship ${item} to the mainland at ${this.mainlandPrice(item)} each (price drops as more is shipped)` });
      const ip = this.importPrice(item);
      if (coins >= ip * 2) opts.push({ id: `import:${item}`, action: 'import', item, maxQty: Math.min(20, Math.floor((coins - 50) / ip)), label: `buy ${item} from the mainland at ${ip} each (always in stock, but pricey)` });
    }

    // Lending: borrow from any banker who isn't you
    const loan = this.#openLoan(agent.id);
    for (const banker of this.byRole('banker')) {
      if (banker === agent) continue;
      if (!loan && coins < 1100) opts.push({ id: `borrow:${banker.id}`, action: 'borrow', with: banker.id, withName: banker.name, maxQty: LOAN.max, label: `ask ${banker.name} for a loan (up to ${LOAN.max} coins, with interest)` });
    }
    // Bankers can go to a customer and offer a loan, instead of waiting to be asked.
    // Cooldowns keep the pitches rare: a banker pitches at most once every few minutes, and the same
    // customer isn't pitched again for half an hour (OFFER_COOLDOWN_MS / OFFER_EACH_MS in .env).
    const pitched = (this.lastPitch ||= {});
    const offerGap = Number(process.env.OFFER_COOLDOWN_MS || 300_000), eachGap = Number(process.env.OFFER_EACH_MS || 1_800_000);
    if (agent.role === 'banker' && coins > 800 && Date.now() - (pitched[`by:${agent.id}`] || 0) >= offerGap) {
      for (const other of Object.values(this.agents)) {
        if (other === agent || this.#openLoan(other.id) || (this.credit[other.id]?.defaulted || 0) >= 2) continue;
        if (Date.now() - (pitched[other.id] || 0) < eachGap) continue;
        const theirs = this.chain.balance(other.id);
        if (theirs >= 1100) continue;
        const amt = Math.min(LOAN.max, Math.round(Math.min(coins - 400, theirs < 300 ? 400 : 300) / 10) * 10);
        if (amt >= 100) opts.push({ id: `offer:${other.id}`, action: 'offer', with: other.id, withName: other.name, maxQty: amt, label: `go offer ${other.name} a loan (they have ${Math.round(theirs)} coins; up to ${amt}, with interest)` });
      }
    }
    if (loan && coins >= loan.owed) opts.push({ id: 'repay', action: 'repay', with: loan.lender, withName: this.agents[loan.lender].name, label: `repay your loan to ${this.agents[loan.lender].name} (${Math.round(loan.owed)} owed, due in ${Math.max(0, Math.round((loan.due - Date.now()) / 1000))}s)` });

    // Construction: hire a builder for a new building or an upgrade
    if (!this.jobs.some((j) => j.client === agent.id && j.status !== 'done')) {
      const mine = (t) => this.buildings.find((b) => b.owner === agent.id && b.type === t);
      const freePlot = this.#freePlot(agent);
      for (const builder of this.byRole('builder')) {
        if (builder === agent) continue;
        for (const [type, spec] of Object.entries(BUILDINGS)) {
          const have = mine(type);
          if (!have) {
            if (type === 'workshop' && !mine('house')) continue;
            if (this.maxLevel(type) < 1 || !freePlot) continue;
            if (coins < spec.labor + spec.wood * PRICES.wood.fair) continue;
            opts.push({ id: `hire:${type}:${builder.id}`, action: 'hire', item: type, with: builder.id, withName: builder.name, label: `hire ${builder.name} to build you a ${type} (${spec.perk})` });
          } else if (have.progress >= 1 && have.level < Math.min(spec.levels, this.maxLevel(type))) {
            const c = upgradeCost(type, have.level + 1);
            if (coins < c.labor + c.wood * PRICES.wood.fair) continue;
            opts.push({ id: `upgrade:${have.id}:${builder.id}`, action: 'upgrade', item: type, building: have.id, toLevel: have.level + 1, with: builder.id, withName: builder.name, label: `hire ${builder.name} to upgrade your ${type} to level ${have.level + 1} (${spec.perk})` });
          }
        }
      }
    }
    // Builders can build for themselves: materials only, no fee.
    if (agent.role === 'builder' && !this.jobs.some((j) => j.client === agent.id && j.status !== 'done')) {
      const mine = (t) => this.buildings.find((b) => b.owner === agent.id && b.type === t);
      for (const [type, spec] of Object.entries(BUILDINGS)) {
        const have = mine(type);
        if (!have && this.maxLevel(type) >= 1 && (type === 'house' || mine('house')) && this.#freePlot(agent)) {
          opts.push({ id: `selfbuild:${type}`, action: 'selfbuild', item: type, label: `build yourself a ${type} (${spec.perk}; you supply the materials)` });
        } else if (have && have.progress >= 1 && have.level < Math.min(spec.levels, this.maxLevel(type))) {
          opts.push({ id: `selfbuild:${type}:up`, action: 'selfbuild', item: type, building: have.id, toLevel: have.level + 1, label: `upgrade your own ${type} to level ${have.level + 1}` });
        }
      }
    }
    if (agent.role === 'builder') {
      for (const j of this.jobs.filter((x) => x.builder === agent.id && x.status === 'queued')) {
        const n = this.#need(j);
        if (agent.inv.wood >= n.wood && agent.inv.ore >= n.ore) opts.push({ id: `build:${j.id}`, action: 'build', job: j.id, label: j.materialsUsed ? `finish ${this.#jobLabel(j)} (materials already on site)` : `build ${this.#jobLabel(j)} (uses ${n.wood} wood${n.ore ? ` + ${n.ore} ore` : ''})` });
      }
    }

    // Public works: chip in
    for (const p of Object.values(this.projects)) {
      if (p.status !== 'funding' || !p.builder || p.builder === agent.id) continue;
      const left = p.need - p.funded;
      // The mayor spends from the treasury (taxes collected), not from their own pocket.
      const treasury = this.isMayor(agent) ? Math.min(coins - 150, this.election.office?.treasury ?? coins) : 0;
      if (treasury >= 50) opts.push({ id: `donate:${p.id}`, action: 'fund', project: p.id, maxQty: Math.round(Math.min(left, treasury)), label: `fund from the treasury the ${PROJECTS[p.id].label} (${Math.round(p.funded)}/${p.need} raised; ${PROJECTS[p.id].perk}; treasury ${Math.round(treasury)})` });
      else if (coins > 300) opts.push({ id: `donate:${p.id}`, action: 'donate', project: p.id, maxQty: Math.round(Math.min(left, coins - 150)), label: `donate to the ${PROJECTS[p.id].label} (${Math.round(p.funded)}/${p.need} raised; ${PROJECTS[p.id].perk})` });
    }

    // After dark, someone may help himself to unattended goods
    if (agent.role === 'thief' && this.isNight() && Date.now() - (agent.lastSteal || 0) > 45_000) {
      for (const other of Object.values(this.agents)) {
        if (other === agent || other.engaged) continue;
        for (const item of items) if (other.inv[item] >= 2) opts.push({ id: `steal:${other.id}:${item}`, action: 'steal', item, with: other.id, withName: other.name, maxQty: Math.min(3, other.inv[item]), label: `quietly take ${item} from ${other.name} while it's dark (they have ${other.inv[item]})` });
      }
    }

    const restLabel = this.isMayor(agent) && this.projectDone('townhall') ? 'hold office hours at the Town Hall' : { banker: 'mind the bank' }[agent.role] || 'rest for a bit';
    opts.push({ id: 'rest', action: 'rest', label: restLabel });
    return opts;
  }

  #jobLabel(j) {
    if (j.kind === 'project') return `the ${PROJECTS[j.type].label}`;
    const who = this.agents[j.client]?.name || 'someone';
    return j.kind === 'upgrade' ? `${who}'s ${j.type} upgrade to level ${j.toLevel}` : `${who}'s ${j.type}`;
  }

  #actionLabel(d) {
    const o = d.option;
    switch (o.action) {
      case 'work': return `${o.item.toUpperCase()} · WORK`;
      case 'eat': return `EAT ${o.item.toUpperCase()}`;
      case 'rest': return 'REST';
      case 'export': return `EXPORT ${d.qty} ${o.item.toUpperCase()}`;
      case 'import': return `IMPORT ${d.qty} ${o.item.toUpperCase()}`;
      case 'selfbuild': return `BUILD OWN ${o.item.toUpperCase()}${o.toLevel ? ` → L${o.toLevel}` : ''}`;
      case 'borrow': return `BORROW ${d.qty} ← ${o.withName.toUpperCase()}`;
      case 'repay': return `REPAY → ${o.withName.toUpperCase()}`;
      case 'offer': return `OFFER LOAN → ${o.withName.toUpperCase()}`;
      case 'hire': return `HIRE ${o.withName.toUpperCase()} · ${o.item.toUpperCase()}`;
      case 'upgrade': return `UPGRADE ${o.item.toUpperCase()} → L${o.toLevel}`;
      case 'build': return 'BUILD';
      case 'donate': case 'fund': return `${o.action.toUpperCase()} ${d.qty} → ${PROJECTS[o.project].label.toUpperCase()}`;
      case 'steal': return `STEAL ${o.item.toUpperCase()} ← ${o.withName.toUpperCase()}`;
      default: return `${o.action.toUpperCase()} ${d.qty} ${o.item.toUpperCase()} ${o.action === 'sell' ? '→' : '←'} ${o.withName.toUpperCase()}`;
    }
  }

  async #execute(agent, d) {
    const o = d.option;
    switch (o.action) {
      case 'work': return this.#work(agent, o.item);
      case 'eat': return this.#eat(agent, o.item, d.qty);
      case 'export': return this.#export(agent, o.item, d.qty);
      case 'import': return this.#import(agent, o.item, d.qty);
      case 'selfbuild': return this.#selfBuild(agent, o);
      case 'sell': case 'buy': return this.#trade(agent, this.agents[o.with], o.action, o.item, d.qty, d.price);
      case 'borrow': return this.#borrow(agent, this.agents[o.with], d.qty);
      case 'repay': return this.#repay(agent);
      case 'offer': return this.#borrow(this.agents[o.with], agent, d.qty || o.maxQty, true);
      case 'hire': return this.#hire(agent, this.agents[o.with], { kind: 'new', type: o.item }, d.price);
      case 'upgrade': return this.#hire(agent, this.agents[o.with], { kind: 'upgrade', type: o.item, building: o.building, toLevel: o.toLevel }, d.price);
      case 'build': return this.#build(agent, this.jobs.find((j) => j.id === o.job));
      case 'donate': case 'fund': return this.#donate(agent, o.project, d.qty);
      case 'steal': return this.#steal(agent, this.agents[o.with], o.item, d.qty);
      default: return this.#rest(agent);
    }
  }

  async #rest(agent) {
    const s = this.world.sites, m = this.world.places.market;
    if (this.isMayor(agent) && this.projectDone('townhall') && (agent.role !== 'banker' || Math.random() < 0.5)) {
      agent.task = 'holding office hours';
      await agent.walkTo(s.townhall.x, s.townhall.z + 3.2);
      return agent.wait(6000);
    }
    if (agent.role === 'banker') {
      agent.task = 'minding the bank';
      await agent.walkTo(m.x - 2.2 + (agent.id === 'ivy' ? 4.4 : 0), m.z - 1.4);
      return agent.wait(6000);
    }
    agent.task = 'resting';
    await agent.wait(4500);
  }

  // ---------- Work ----------

  // Fishing spots out on the pier, each facing open water: the far end of the landing first, then its
  // corners, then along both sides. Each agent has its own, so fishers line the pier instead of stacking.
  #pierSpot(agent) {
    const dock = this.world.places.dock, pier = dock.pier;
    if (!pier) return null;
    if (!this.pierSpots) {
      const { ax, az, first, len } = pier;
      const at = (i, j) => ({ x: dock.x + ax * i - az * j, z: dock.z + az * i + ax * j });
      const out = (i, j, fi, fj) => { const p = at(i, j), f = at(i + fi, j + fj); return { x: p.x, z: p.z, face: f }; };
      const spots = [out(len, 0, 3, 0), out(len, -1, 3, 0), out(len, 1, 3, 0), out(len - 1, -2, 0, -3), out(len - 1, 2, 0, 3)];
      for (let i = len - 2; i >= Math.max(2, first); i--) spots.push(out(i, -1, 0, -3), out(i, 1, 0, 3));
      // Only spots that cast into open water (not toward the shallows by the shore).
      const deep = (q) => (this.world.heights[Math.round(q.x)]?.[Math.round(q.z)] ?? 99) < this.world.waterLevel;
      const open = spots.filter((sp) => deep(sp.face) && deep({ x: (sp.x + sp.face.x) / 2, z: (sp.z + sp.face.z) / 2 }));
      this.pierSpots = open.length ? open : spots;
    }
    const ids = Object.keys(this.agents);
    return this.pierSpots[Math.max(0, ids.indexOf(agent.id)) % this.pierSpots.length];
  }

  // Each agent has its own place along the shore by the dock (land tiles at about dock height), so a
  // crowd at the dock stands side by side instead of on one tile.
  #dockSpot(agent) {
    const w = this.world, dock = w.places.dock;
    if (!this.dockSpots) {
      const h0 = w.heights[dock.x][dock.z], spots = [];
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        const x = dock.x + dx, z = dock.z + dz, h = w.heights[x]?.[z];
        if (h === undefined || h <= w.waterLevel || Math.abs(h - h0) > 1) continue;
        const r = Math.hypot(dx, dz);
        if (r > 2.9) continue;
        spots.push({ x, z, r });
      }
      spots.sort((a, b) => a.r - b.r);
      this.dockSpots = spots.length ? spots : [{ x: dock.x, z: dock.z }];
    }
    const ids = Object.keys(this.agents);
    return this.dockSpots[Math.max(0, ids.indexOf(agent.id)) % this.dockSpots.length];
  }

  #spotFor(agent, item) {
    const w = this.world;
    if (item === 'ore') {
      // The West Hill quarry is open to everyone once unlocked; locals prefer it.
      const pool = this.zonesOpen().has('west') && (agent.homeZone === 'west' || Math.random() < 0.35) ? w.ores2 : w.ores;
      const s = pool[Math.floor(Math.random() * pool.length)];
      // Stand beside the ore (not on it) and face it, so the pick swings at the rock.
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: s.x + dx * 0.95, z: s.z + dz * 0.95 }))
        .filter((p) => this.#standable(p.x, p.z) && Math.abs((w.heights[Math.round(p.x)]?.[Math.round(p.z)] ?? 99) - w.heights[s.x][s.z]) <= 1 && !pool.some((o) => o !== s && Math.round(p.x) === o.x && Math.round(p.z) === o.z));
      const p = sides.length ? sides[Math.floor(Math.random() * sides.length)] : { x: s.x + 0.5, z: s.z + 0.5 };
      return { x: p.x, z: p.z, face: { x: s.x, z: s.z } };
    }
    if (item === 'fish') {
      const north = this.zonesOpen().has('north') && (agent.homeZone === 'north' || Math.random() < 0.3);
      if (north) return { x: w.places.beach.x, z: w.places.beach.z - 6, face: { x: w.places.beach.x, z: w.places.beach.z - 12 } };
      const ps = this.#pierSpot(agent);
      if (ps) return ps;
      const d = this.#dockSpot(agent);
      return { x: d.x, z: d.z, face: { x: w.places.dock.waterX, z: w.places.dock.waterZ } };
    }
    if (item === 'grain') {
      const f = w.fields;
      return { x: f.x - f.w + Math.random() * f.w * 2, z: f.z - f.d + Math.random() * f.d * 2 };
    }
    const open = this.zonesOpen();
    const near = w.trees
      .filter((t) => open.has(zoneAt(w, t.x, t.z)))
      .map((t) => ({ t, d: Math.hypot(t.x - agent.x, t.z - agent.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    const t = near[Math.floor(Math.random() * near.length)].t;
    return { x: t.x + 1.1, z: t.z + 0.2, face: { x: t.x, z: t.z } };
  }

  // How much of an item a work trip gathers up to: a normal load, or what the builder's jobs need.
  #workGoal(agent, item) {
    const jobNeed = agent.role === 'builder' ? this.jobs.filter((j) => j.builder === agent.id && j.status === 'queued').reduce((t, j) => Math.max(t, j.need[item] || 0), 0) : 0;
    return Math.max(Math.min(CARRY, agent.inv[item] + 5), Math.min(jobNeed, 40));
  }

  async #work(agent, item) {
    const spot = this.#spotFor(agent, item);
    agent.task = `walking to ${{ ore: 'dig', fish: 'fish', wood: 'chop wood', grain: 'the fields' }[item]}`;
    await agent.walkTo(spot.x, spot.z);
    if (spot.face) agent.heading = Math.atan2(spot.face.x - agent.x, spot.face.z - agent.z);
    agent.workHeading = spot.face ? agent.heading : null;
    const verb = RESOURCES[item].verb;
    agent.task = verb;
    agent.activity = { ore: 'mining', fish: 'fishing', wood: 'chopping', grain: 'farming' }[item];
    const per = RESOURCES[item].base / agent.skill(item);
    // A starving agent can still catch or harvest food (just a couple, then go eat), but stops other work.
    const starving = agent.hunger >= 8;
    if (starving && !FOOD[item]) { agent.speak('Too hungry to work.'); return; }
    const goal = starving ? agent.inv[item] + 2 : this.#workGoal(agent, item);
    try {
      while (agent.inv[item] < goal && (agent.hunger < 8 || FOOD[item])) {
        await agent.wait(per * (0.85 + Math.random() * 0.3));
        agent.inv[item]++;
        if (Math.random() < 0.15) agent.speak(brain.idleLine(agent));
      }
    } finally {
      agent.activity = null;
      agent.workHeading = null;
    }
    agent.remember(`${verb}, now holding ${agent.inv[item]} ${item}`);
    if (agent.hunger >= 8) agent.speak('Too hungry to keep going.');
  }

  async #eat(agent, item, qty) {
    const n = Math.max(1, Math.min(qty || 1, agent.inv[item] || 0));
    if (!agent.inv[item]) return;
    agent.task = 'eating';
    agent.inv[item] -= n;
    agent.hunger = Math.max(0, agent.hunger - n * this.foodFills(item));
    agent.speak(n > 1 ? '*nom nom nom*' : '*nom*');
    agent.remember(`ate ${n} ${item}`);
    await agent.wait(2200);
  }

  async #export(agent, item, qty) {
    const n = Math.min(qty, agent.inv[item]);
    if (n <= 0) return;
    const dock = this.#dockSpot(agent);
    agent.task = `shipping ${item}`;
    await agent.walkTo(dock.x, dock.z);
    const n2 = Math.min(n, agent.inv[item]);
    if (n2 <= 0) return;
    const price = this.mainlandPrice(item);
    const amount = n2 * price;
    if (amount < MIN_SHIP) {
      agent.think(`The mainland only pays ${price} each now. ${amount} coins isn't worth the boat.`, 'NO SHIP');
      return;
    }
    agent.speak(`${n2} ${item} off to the mainland!`);
    try {
      const res = await this.#pay('bank', agent.id, amount, `mainland bought ${n2} ${item} from ${agent.name} for ${amount}`, { by: agent });
      agent.inv[item] -= n2;
      this.shipped[item] += n2;
      agent.remember(`exported ${n2} ${item} for ${amount}`);
      this.#record(null, 0, amount);
      this.emit({ type: 'trade', kind: 'export', from: 'bank', to: agent.id, amount, qty: n2, price, item, text: `The mainland bought ${n2} ${item} from ${agent.name} for ${amount} coins`, ...res });
      this.mood(agent, 'happy');
    } catch (e) {
      this.#chainError(e, 'export');
    }
  }

  async #import(agent, item, qty) {
    const price = this.importPrice(item);
    const n = Math.max(1, Math.min(qty || 1, 20, Math.floor((this.chain.balance(agent.id) - 20) / price)));
    if (n < 1) return;
    const dock = this.#dockSpot(agent);
    agent.task = `buying ${item} off the boat`;
    await agent.walkTo(dock.x, dock.z);
    const amount = n * price;
    if (this.chain.balance(agent.id) < amount) return;
    try {
      const text = `${agent.name} bought ${n} ${item} from the mainland for ${amount} coins`;
      const res = await this.#pay(agent.id, 'bank', amount, text, { by: agent });
      agent.inv[item] += n;
      agent.remember(`imported ${n} ${item} for ${amount}`);
      this.#record(null, 0, amount);
      this.emit({ type: 'trade', kind: 'import', from: agent.id, to: 'bank', amount, qty: n, price, item, text, ...res });
    } catch (e) {
      this.#chainError(e, 'import');
    }
  }

  // ---------- Trading: anyone with anyone ----------

  async #meet(agent, other) {
    agent.task = `looking for ${other.name}`;
    await agent.walkToAgent(other);
    for (let i = 0; i < 32 && other.engaged; i++) await sleep(250);
    if (other.engaged || agent.engaged) {
      agent.think(`${other.name} is busy with someone else. I'll come back later.`, 'GIVE UP');
      return false;
    }
    agent.engaged = other.engaged = true;
    agent.dealRec = other.dealRec = agent.decision || null;
    // Nobody haggles from inside a wall.
    agent.ghostUntil = other.ghostUntil = 0;
    this.unclip(agent); this.unclip(other);
    // If the other one walked into us on the way, step back so the two stand a proper distance apart.
    const d = dist(agent, other);
    if (d < MEET_GAP - 0.2) {
      const ux = d > 0.01 ? (agent.x - other.x) / d : 1, uz = d > 0.01 ? (agent.z - other.z) / d : 0;
      const nx = other.x + ux * MEET_GAP, nz = other.z + uz * MEET_GAP;
      if (this.#standable(nx, nz)) { agent.x = nx; agent.z = nz; }
    }
    agent.face(other);
    other.face(agent);
    return true;
  }

  async #trade(agent, other, side, item, qty, suggested) {
    if (!other) return;
    const seller = side === 'sell' ? agent : other;
    const buyer = side === 'sell' ? other : agent;
    if (!(await this.#meet(agent, other))) return;
    const gap = this.talkGap();
    try {
      const n = Math.min(Math.max(qty || 0, MIN_LOT), seller.inv[item]);
      if (n < MIN_LOT) {
        agent.think(`${seller.name} doesn't have ${MIN_LOT} ${item} anymore. Missed it.`, 'NO DEAL');
        return;
      }
      // Someone who knows you've been robbing them may not deal with you at all.
      const g = other.grudge(agent.id);
      if (g >= 1 && Math.random() < Math.min(0.6, 0.15 + g * 0.08)) {
        other.speak(brain.pick([`Not with you, ${agent.name}. I know what you did.`, 'Keep walking, thief.', `I don't trade with thieves.`, 'After last night? No.']));
        other.think(`${agent.name} has been stealing from me. I'm not doing business with ${agent.name}.`, 'REFUSE');
        agent.think(`${other.name} won't trade with me. Word gets around.`, 'SHUNNED');
        agent.remember(`${other.name} refused to trade with me (grudge)`);
        agent.refusals[`${side}:${item}:${other.id}`] = { price: 0, ts: Date.now() };
        this.log(`${other.name} refused to trade with ${agent.name}.`);
        this.emit({ type: 'story', kind: 'refuse', from: other.id, to: agent.id, item });
        this.mood(other, 'angry');
        return;
      }
      agent.task = other.task = 'haggling';
      const open = await brain.propose(agent, other, side, item, n, this.context(agent), suggested > 0 ? suggested : null);
      agent.speak(open.say || `${n} ${item}, ${open.price} each.`);
      agent.think(open.thought, `${side === 'sell' ? 'ASK' : 'BID'} ${open.price}`);
      await sleep(gap);

      let price = open.price;
      const reply = await brain.respond(other, agent, side, item, n, price, this.context(other));
      other.speak(reply.say);
      other.think(reply.thought, reply.decision === 'counter' ? `COUNTER ${reply.price}` : reply.decision.toUpperCase());
      await sleep(gap);

      if (reply.decision === 'counter') {
        const back = await brain.answerCounter(agent, other, side, item, n, reply.price, price, this.context(agent));
        agent.speak(back.say);
        agent.think(back.thought, back.decision.toUpperCase());
        await sleep(gap);
        if (back.decision === 'accept') {
          price = reply.price;
        } else {
          // Close enough (within ~10%): split the difference instead of walking away over a coin or two.
          const gapP = Math.abs(reply.price - price);
          if (gapP > Math.max(2, Math.round(price * 0.1))) return this.#noDeal(seller, buyer, item, price, agent, side);
          const mid = gapP <= 1 ? (Math.random() < 0.5 ? price : reply.price) : Math.round((price + reply.price) / 2);
          agent.speak(brain.pick([`Meet me in the middle. ${mid}.`, `Fine. ${mid} and we're done.`, `Split the difference: ${mid}?`]));
          agent.think(`${reply.price} vs my ${price}. Not worth losing the deal over; ${mid} each.`, `SPLIT ${mid}`);
          await sleep(gap * 0.8);
          other.speak(brain.pick(['Deal.', 'Fine. Deal.', 'Done.', 'Alright, shake on it.']));
          price = mid;
        }
      } else if (reply.decision !== 'accept') {
        return this.#noDeal(seller, buyer, item, price, agent, side);
      }

      const amount = n * price;
      if (seller.inv[item] < n) {
        seller.speak(`Wait, I'm out of ${item}.`);
        return this.#noDeal(seller, buyer, item, price, agent, side);
      }
      if (this.chain.balance(buyer.id) < amount) {
        buyer.speak("Wait... I'm short.");
        return this.#noDeal(seller, buyer, item, price, agent, side);
      }
      const text = `${buyer.name} bought ${n} ${item} from ${seller.name} for ${amount} coins (${price} each)`;
      try {
        const res = await this.#pay(buyer.id, seller.id, amount, text, { by: agent });
        seller.inv[item] -= n;
        buyer.inv[item] += n;
        seller.remember(`sold ${n} ${item} to ${buyer.name} at ${price}`);
        buyer.remember(`bought ${n} ${item} from ${seller.name} at ${price}`);
        this.#record(item, price, amount);
        this.emit({ type: 'trade', kind: item, item, from: buyer.id, to: seller.id, amount, qty: n, price, text, ...res });
        this.mood(seller, 'happy');
        this.mood(buyer, 'happy');
      } catch (e) {
        this.#chainError(e, item);
      }
      await sleep(gap * 0.6);
    } finally {
      this.#release(agent, other);
    }
  }

  #noDeal(seller, buyer, item, price, proposer, side) {
    const other = proposer === seller ? buyer : seller;
    proposer.refusals[`${side}:${item}:${other.id}`] = { price, ts: Date.now() };
    this.log(`${seller.name} and ${buyer.name} couldn't agree on ${item} (stuck at ${price}).`);
    seller.remember(`no deal with ${buyer.name} on ${item} at ${price}`);
    buyer.remember(`no deal with ${seller.name} on ${item} at ${price}`);
    this.mood(seller, 'angry');
    this.mood(buyer, 'angry');
  }

  // What a builder still needs for their next queued job (others can see this, so they know who to sell to).
  // A builder's queued jobs, in the order they'll tackle them: paying customers first, then whatever needs the least extra material.
  // Materials still to bring for a job (none if they were delivered before a restart).
  #need(j) { return j.materialsUsed ? { wood: 0, ore: 0 } : j.need; }

  #queue(b) {
    const missing = (j) => Math.max(0, this.#need(j).wood - b.inv.wood) + Math.max(0, this.#need(j).ore - b.inv.ore) * 3;
    // Private jobs usually go first (they need fewer materials), but a funded landmark that has waited
    // more than two minutes jumps the line, so a steady stream of house orders can never block it forever.
    const rank = (j) => (j.kind !== 'project' ? 1 : Date.now() - (j.queuedAt || 0) > 120_000 ? 0 : 2);
    return this.jobs
      .filter((j) => j.builder === b.id && j.status === 'queued')
      .sort((x, y) => rank(x) - rank(y) || missing(x) - missing(y) || x.id - y.id);
  }

  #builderNeeds(b) {
    const j = this.#queue(b)[0];
    if (!j) return { wood: 0, ore: 0 };
    const n = this.#need(j);
    return { wood: Math.max(0, n.wood - b.inv.wood), ore: Math.max(0, n.ore - b.inv.ore) };
  }

  #queueOf(b) {
    return this.jobs.filter((j) => j.builder === b.id && j.status !== 'done').length;
  }

  // ---------- Lending ----------

  #openLoan(id) {
    return this.loans.find((l) => l.borrower === id && (l.status === 'open' || l.status === 'collecting')) || null;
  }

  // A loan conversation. Usually the borrower walks to the bank and asks; with byBanker the banker
  // walks over and pitches it, and the borrower decides whether to take it.
  async #borrow(agent, banker, wanted, byBanker = false) {
    if (!banker || !agent || this.#openLoan(agent.id)) return;
    if (byBanker) { const p = (this.lastPitch ||= {}); p[agent.id] = p[`by:${banker.id}`] = Date.now(); }
    if (!(await (byBanker ? this.#meet(banker, agent) : this.#meet(agent, banker)))) return;
    const gap = this.talkGap();
    agent.task = banker.task = 'talking money';
    try {
      const amount = Math.max(50, Math.min(LOAN.max, Math.round(wanted || 300)));
      if (byBanker) banker.speak(brain.pick([`Money working for you, ${agent.name}? I could lend you ${amount}.`, `Need capital? I've got ${amount} for you.`, `${agent.name}! Loan of ${amount}, if you want it.`]));
      else agent.speak(brain.pick([`Need a loan. ${amount} coins?`, `Could you lend me ${amount}?`, `Got ${amount} for a hard-working animal?`]));
      await sleep(gap);
      const terms = await brain.loanTerms(banker, agent, amount, this.context(banker), this.credit[agent.id] || { repaid: 0, defaulted: 0 }, byBanker);
      banker.speak(terms.say);
      banker.think(terms.thought, terms.decision === 'offer' ? `OFFER ${terms.amount} @ ${Math.round(terms.rate * 100)}%` : 'DECLINE');
      await sleep(gap);
      if (terms.decision !== 'offer') {
        this.log(`${banker.name} turned down ${agent.name}'s loan request.`);
        this.mood(agent, 'angry');
        return;
      }
      const owed = Math.round(terms.amount * (1 + terms.rate));
      const ok = await brain.loanAccept(agent, banker, terms.amount, terms.rate, owed, this.context(agent));
      agent.speak(ok.say);
      agent.think(ok.thought, ok.decision === 'accept' ? 'ACCEPT LOAN' : 'WALK AWAY');
      await sleep(gap * 0.8);
      if (ok.decision !== 'accept' || this.chain.balance(banker.id) < terms.amount) return;
      const text = `${banker.name} lent ${agent.name} ${terms.amount} coins at ${Math.round(terms.rate * 100)}% (${owed} due)`;
      const res = await this.#pay(banker.id, agent.id, terms.amount, text, { by: agent });
      this.loans.push({ id: this.nextId++, borrower: agent.id, lender: banker.id, principal: terms.amount, rate: terms.rate, owed, due: Date.now() + LOAN.termMs, issued: Date.now(), status: 'open', tx: res?.url || res?.sig || null });
      agent.remember(`borrowed ${terms.amount} from ${banker.name}, owe ${owed}`);
      banker.remember(`lent ${terms.amount} to ${agent.name} at ${Math.round(terms.rate * 100)}%`);
      this.#record(null, 0, terms.amount);
      this.emit({ type: 'trade', kind: 'loan', from: banker.id, to: agent.id, amount: terms.amount, text, ...res });
      this.mood(agent, 'happy');
    } catch (e) {
      this.#chainError(e, 'loan');
    } finally {
      this.#release(agent, banker);
    }
  }

  async #repay(agent) {
    const loan = this.#openLoan(agent.id);
    if (!loan || loan.status !== 'open') return;
    const banker = this.agents[loan.lender];
    if (this.chain.balance(agent.id) < loan.owed) return;
    if (!(await this.#meet(agent, banker))) return;
    try {
      agent.speak(brain.pick(['Here. Paid in full.', 'Settling up.', 'Your coins, with interest.']));
      const text = `${agent.name} repaid ${banker.name} ${loan.owed} coins (${loan.owed - loan.principal} interest)`;
      const res = await this.#pay(agent.id, banker.id, loan.owed, text, { by: agent });
      loan.status = 'repaid'; loan.closed = Date.now(); loan.paid = loan.owed; loan.repayTx = res?.url || res?.sig || null;
      const c = (this.credit[agent.id] ||= { repaid: 0, defaulted: 0 });
      c.repaid++;
      this.#record(null, 0, loan.owed);
      this.emit({ type: 'trade', kind: 'repay', from: agent.id, to: banker.id, amount: loan.owed, text, ...res });
      await sleep(this.talkGap());
      banker.speak(brain.pick(['Pleasure doing business.', 'Always good for it. Noted.', 'Your credit is golden.']));
      banker.think(`${agent.name} paid back ${loan.owed} on time. That's ${c.repaid} clean loan${c.repaid > 1 ? 's' : ''}. Better rates next time.`, 'REPAID');
      this.mood(banker, 'happy');
    } catch (e) {
      this.#chainError(e, 'repayment');
    } finally {
      this.#release(agent, banker);
    }
  }

  async #collectOverdue() {
    for (const loan of this.loans.filter((l) => l.status === 'open' && Date.now() > l.due)) {
      loan.status = 'collecting';
      const who = this.agents[loan.borrower], banker = this.agents[loan.lender];
      const take = Math.min(Math.floor(this.chain.balance(who.id)), loan.owed);
      const c = (this.credit[who.id] ||= { repaid: 0, defaulted: 0 });
      try {
        if (take > 0) {
          const full = take >= loan.owed;
          const text = full ? `${banker.name} collected ${take} coins from ${who.name} (loan overdue)` : `${who.name} defaulted. ${banker.name} seized ${take} of ${loan.owed} coins owed`;
          const res = await this.#pay(who.id, banker.id, take, text, { rule: 'collection' });
          this.emit({ type: 'trade', kind: full ? 'repay' : 'default', from: who.id, to: banker.id, amount: take, text, ...res });
          loan.status = full ? 'repaid' : 'defaulted';
          Object.assign(loan, { late: true, closed: Date.now(), paid: take, repayTx: res?.url || res?.sig || null }); // collected after the due date
        } else {
          loan.status = 'defaulted';
          Object.assign(loan, { late: true, closed: Date.now(), paid: 0 });
          this.log(`${who.name} defaulted on ${loan.owed} coins owed to ${banker.name}.`);
          this.emit({ type: 'credit', kind: 'default', from: who.id, to: banker.id, owed: loan.owed });
        }
      } catch (e) {
        loan.status = 'open';
        this.#chainError(e, 'collection');
        continue;
      }
      if (loan.status === 'defaulted') {
        c.defaulted++;
        banker.think(`${who.name} couldn't cover ${loan.owed}. That's a default on the books. Rates go up for ${who.name}, or no more loans.`, 'DEFAULT');
        who.speak('Oh no... my coins!');
        this.mood(banker, 'angry');
        this.mood(who, 'angry');
      } else {
        c.repaid++;
        banker.think(`${who.name} missed the deadline, so I collected ${loan.owed} directly. Paid, but late.`, 'COLLECTED');
      }
    }
  }

  // ---------- Construction ----------

  #plotKey(p) { return `${p.x},${p.z}`; }

  #freePlot(agent) {
    const open = this.zonesOpen();
    const free = this.world.plots.filter((p) => open.has(p.zone) && !this.takenPlots.has(this.#plotKey(p)));
    if (!free.length) return null;
    return free.find((p) => p.zone === (agent.homeZone || 'harbor')) || free[0];
  }

  async #hire(client, builder, spec, suggested) {
    if (!builder || this.jobs.some((j) => j.client === client.id && j.status !== 'done')) return;
    if (!(await this.#meet(client, builder))) return;
    const gap = this.talkGap();
    client.task = builder.task = 'negotiating a contract';
    try {
      const upgrade = spec.kind === 'upgrade';
      const base = BUILDINGS[spec.type];
      const cost = upgrade ? upgradeCost(spec.type, spec.toLevel) : { wood: base.wood, ore: base.ore, labor: base.labor, buildMs: base.buildMs };
      const what = upgrade ? `${spec.type} upgrade to level ${spec.toLevel}` : spec.type;
      client.speak(brain.pick([`I want a ${what}. What's your price?`, `Build me a ${what}?`, `How much for a ${what}, ${builder.name}?`]));
      await sleep(gap);
      const quote = await brain.contractQuote(builder, client, what, cost, this.context(builder), this.#queueOf(builder));
      builder.speak(quote.say);
      builder.think(quote.thought, `QUOTE ${quote.price}`);
      await sleep(gap);
      let fee = quote.price;
      const reply = await brain.contractAnswer(client, builder, what, fee, base.perk, this.context(client), suggested);
      client.speak(reply.say);
      client.think(reply.thought, reply.decision === 'counter' ? `COUNTER ${reply.price}` : reply.decision.toUpperCase());
      await sleep(gap);
      if (reply.decision === 'counter') {
        const floor = cost.wood * MAINLAND.wood + cost.ore * MAINLAND.ore + cost.labor * 0.8;
        const ok = reply.price >= floor;
        builder.speak(ok ? brain.pick(['Fine. You have a deal.', "Alright, I'll do it."]) : brain.pick(["Can't do it for that.", 'Not worth my time at that price.']));
        builder.think(ok ? `${reply.price} still covers materials and my time (floor ~${Math.round(floor)}).` : `${reply.price} doesn't cover materials and labor (~${Math.round(floor)}).`, ok ? 'ACCEPT' : 'REJECT');
        await sleep(gap);
        if (!ok) { this.mood(client, 'angry'); return; }
        fee = reply.price;
      } else if (reply.decision !== 'accept') {
        return;
      }
      if (this.chain.balance(client.id) < fee) return;
      let plot = null;
      if (!upgrade) {
        plot = this.#freePlot(client);
        if (!plot) return;
        this.takenPlots.add(this.#plotKey(plot));
      }
      const text = `${client.name} paid ${builder.name} ${fee} coins to build a ${what}`;
      const res = await this.#pay(client.id, builder.id, fee, text, { by: client });
      this.jobs.push({
        id: this.nextId++, kind: spec.kind, type: spec.type, client: client.id, builder: builder.id, fee, status: 'queued',
        plot: plot ? { x: plot.x, z: plot.z, y: plot.y } : null, building: spec.building || null, toLevel: spec.toLevel || 1,
        need: { wood: cost.wood, ore: cost.ore }, buildMs: cost.buildMs,
      });
      client.remember(`hired ${builder.name} to build a ${what} for ${fee}`);
      builder.remember(`contract: ${client.name}'s ${what}, paid ${fee}, needs ${cost.wood} wood${cost.ore ? ` + ${cost.ore} ore` : ''}`);
      this.#record(null, 0, fee);
      this.emit({ type: 'trade', kind: 'contract', from: client.id, to: builder.id, amount: fee, text, ...res });
      this.mood(builder, 'happy');
    } catch (e) {
      this.#chainError(e, 'contract');
    } finally {
      this.#release(client, builder);
    }
  }

  async #selfBuild(builder, o) {
    if (this.jobs.some((j) => j.client === builder.id && j.status !== 'done')) return;
    const upgrade = Boolean(o.toLevel);
    const base = BUILDINGS[o.item];
    const cost = upgrade ? upgradeCost(o.item, o.toLevel) : { wood: base.wood, ore: base.ore, labor: base.labor, buildMs: base.buildMs };
    let plot = null;
    if (!upgrade) {
      plot = this.#freePlot(builder);
      if (!plot) return;
      this.takenPlots.add(this.#plotKey(plot));
    }
    this.jobs.push({
      id: this.nextId++, kind: upgrade ? 'upgrade' : 'new', type: o.item, client: builder.id, builder: builder.id, fee: 0, status: 'queued',
      plot: plot ? { x: plot.x, z: plot.z, y: plot.y } : null, building: o.building || null, toLevel: o.toLevel || 1,
      need: { wood: cost.wood, ore: cost.ore }, buildMs: cost.buildMs,
    });
    builder.remember(`started my own ${o.item}${upgrade ? ` upgrade to level ${o.toLevel}` : ''}`);
    this.log(`${builder.name} is building ${upgrade ? `an upgrade for her own ${o.item}` : `a ${o.item} for herself`}.`.replace('her', builder.id === 'gus' ? 'his' : 'her').replace('herself', builder.id === 'gus' ? 'himself' : 'herself'));
  }

  async #build(builder, job) {
    if (!job || job.status !== 'queued') return;
    const need = this.#need(job);
    if (builder.inv.wood < need.wood || builder.inv.ore < need.ore) return;
    job.status = 'building';
    // Find or create the building this job works on
    let b = job.buildingRef && this.buildings.find((x) => x.id === job.buildingRef);
    if (!b && job.kind === 'upgrade') b = this.buildings.find((x) => x.id === job.building);
    if (!b) {
      if (job.kind === 'project') {
        const s = this.world.sites[job.type];
        b = { id: job.id, kind: 'project', type: job.type, owner: null, x: s.x, z: s.z, y: s.y, level: 1, progress: 0 };
      } else {
        b = { id: job.id, kind: 'private', type: job.type, owner: job.client, x: job.plot.x, z: job.plot.z, y: job.plot.y, level: 1, progress: 0 };
      }
      this.buildings.push(b);
    }
    job.buildingRef = b.id;
    const site = { x: b.x + 2.2, z: b.z + 0.6 };
    builder.task = `walking to ${this.#jobLabel(job)}`;
    await builder.walkTo(site.x, site.z);
    builder.heading = Math.atan2(b.x - builder.x, b.z - builder.z);
    if (!job.materialsUsed && (builder.inv.wood < job.need.wood || builder.inv.ore < job.need.ore)) {
      // Materials went missing on the way (sold, or Rico got to them). Back in the queue; gather again.
      job.status = 'queued';
      builder.think(`Got to the site and I'm short on materials. Someone's been in my pile. Back to gathering.`, 'SHORT');
      return;
    }
    if (!job.materialsUsed) {
      builder.inv.wood -= job.need.wood;
      builder.inv.ore -= job.need.ore;
      job.materialsUsed = true;
      if (job.kind === 'upgrade') { b.level = job.toLevel; b.progress = 0; }
    }
    builder.task = `building ${this.#jobLabel(job)}`;
    builder.activity = 'building';
    const steps = 20;
    try {
      for (let i = Math.round(b.progress * steps) + 1; i <= steps; i++) {
        await builder.wait((job.buildMs * this.buildPace()) / steps);
        b.progress = i / steps;
      }
    } finally {
      builder.activity = null;
    }
    job.status = 'done';
    if (job.kind === 'project') {
      this.projects[job.type].status = 'done';
      const p = PROJECTS[job.type];
      this.log(`${builder.name} finished the ${p.label}: ${p.perk}.`);
      this.emit({ type: 'world', kind: 'landmark', project: job.type, label: p.label });
      builder.think(`The ${p.label} is done. That one goes in the history books.`, 'FINISHED');
      builder.speak(`The ${p.label} is open!`, 4200);
      for (const a of Object.values(this.agents)) this.mood(a, 'happy');
    } else {
      const owner = this.agents[job.client];
      this.log(`${builder.name} finished ${this.#jobLabel(job)}.`);
      this.emit({ type: 'story', kind: 'built', owner: job.client, builder: builder.id, btype: job.type, level: b.level });
      builder.think(`Done with ${this.#jobLabel(job)}. Paid ${job.fee} upfront; materials cost me about ${job.need.wood * PRICES.wood.fair + job.need.ore * PRICES.ore.fair}.`, 'FINISHED');
      builder.speak('Built to last!');
      owner?.remember(`${builder.name} finished my ${job.type} (level ${b.level})`);
      this.mood(builder, 'happy');
      if (owner) this.mood(owner, 'happy');
    }
  }

  // ---------- Public works ----------

  async #donate(agent, projectId, qty) {
    const p = this.projects[projectId];
    if (!p || p.status !== 'funding') return;
    const builder = this.agents[p.builder];
    if (!builder) return;
    const mayor = this.isMayor(agent) && (this.election.office?.treasury ?? 0) >= 20;
    const cap = mayor ? this.election.office.treasury : Infinity;
    const amount = Math.round(Math.max(20, Math.min(qty || 100, p.need - p.funded, this.chain.balance(agent.id) - 100, cap)));
    if (amount < 20) return;
    const label = PROJECTS[projectId].label;
    const text = mayor ? `Mayor ${agent.name} put ${amount} treasury coins toward the ${label}` : `${agent.name} donated ${amount} coins to the ${label}`;
    try {
      const res = await this.#pay(agent.id, builder.id, amount, text, { by: agent });
      p.funded += amount;
      if (mayor) this.election.onFund(amount);
      p.donors[agent.id] = (p.donors[agent.id] || 0) + amount;
      this.stats.donations += amount;
      this.#record(null, 0, amount);
      this.emit({ type: 'trade', kind: 'donation', from: agent.id, to: builder.id, amount, text, ...res });
      agent.remember(`gave ${amount} to the ${label}`);
      agent.speak(mayor ? 'For the good of Insula!' : brain.pick(['For the island!', 'Happy to chip in.', 'Build it big.']));
      if (p.funded >= p.need) {
        p.status = 'queued';
        const spec = PROJECTS[projectId];
        this.jobs.push({ id: this.nextId++, kind: 'project', type: projectId, client: null, builder: builder.id, fee: p.funded, status: 'queued', need: { wood: spec.wood, ore: spec.ore }, buildMs: spec.buildMs, queuedAt: Date.now() });
        this.log(`The ${label} is fully funded. ${builder.name} starts gathering materials.`);
        builder.remember(`the ${label} is funded (${Math.round(p.funded)}); needs ${spec.wood} wood + ${spec.ore} ore`);
      }
    } catch (e) {
      this.#chainError(e, 'donation');
    }
  }

  // The mayor collects a small property tax once per genesis day.
  async #collectTax() {
    if (!this.has('tax')) return;
    this.election.ensureOffice();
    const mayor = this.mayor();
    if (!mayor) return;
    const rate = this.election.policy().tax;
    const day = this.genesisDay();
    if (day <= this.lastTaxDay) return;
    this.lastTaxDay = day;
    let total = 0;
    for (const b of this.buildings.filter((x) => x.kind === 'private' && x.owner && x.owner !== mayor.id && x.progress >= 1)) {
      const owner = this.agents[b.owner];
      const tax = rate * b.level;
      if (!tax || !owner || this.chain.balance(owner.id) < tax + 50) continue;
      try {
        const res = await this.#pay(owner.id, mayor.id, tax, `property tax on ${owner.name}'s ${b.type}`, { rule: 'tax' });
        total += tax;
        this.emit({ type: 'trade', kind: 'tax', from: owner.id, to: mayor.id, amount: tax, text: `${owner.name} paid ${tax} coins of property tax on a level ${b.level} ${b.type}`, ...res });
      } catch (e) {
        this.#chainError(e, 'tax');
      }
    }
    if (total) {
      this.stats.taxes += total;
      this.election.onTax(total);
      mayor.think(`Tax day: ${total} coins collected. The treasury now funds public works for everyone.`, 'TAX DAY');
    }
  }

  // ---------- Spoilage ----------
  // Fish and grain go off. Above what an agent can keep fresh (more with a bigger house), a share rots
  // every minute, so nobody can hoard food forever: they have to eat it, sell it or ship it.
  pantry(agent) { return SPOIL.pantry + SPOIL.perHouseLevel * agent.houseLevel(); }
  #spoil() {
    for (const a of Object.values(this.agents)) {
      const keep = this.pantry(a);
      const lost = [];
      for (const item of SPOIL.items) {
        const extra = (a.inv[item] || 0) - keep;
        if (extra <= 0) continue;
        const n = Math.max(1, Math.floor(extra * SPOIL.rate));
        a.inv[item] -= n;
        a.spoiled = (a.spoiled || 0) + n;
        lost.push(`${n} ${item}`);
      }
      if (!lost.length) continue;
      // Tell the story now and then, not every minute.
      if (a.spoiled >= 15 && Date.now() - (a.spoiledToldAt || 0) > 5 * 60_000) {
        this.log(`${a.spoiled} food rotted in ${a.name}'s stores. ${a.name} grew more than anyone would buy.`);
        a.remember(`${lost.join(' and ')} rotted; I should sell or ship surplus food sooner`);
        a.spoiledToldAt = Date.now();
        a.spoiled = 0;
      }
    }
  }

  // ---------- Theft ----------

  async #steal(thief, victim, item, qty) {
    if (!victim || !this.isNight()) return;
    thief.task = 'sneaking around';
    await thief.walkToAgent(victim);
    if (victim.engaged || thief.engaged) return;
    const n = Math.min(qty || 2, 3, victim.inv[item]);
    if (n <= 0) return;
    thief.lastSteal = Date.now();
    victim.inv[item] -= n;
    thief.inv[item] += n;
    this.stats.thefts++;
    // Victims holding a grudge keep watch at night, so they're harder to rob.
    const watching = Math.min(0.3, victim.grudge(thief.id) * 0.06);
    const odds = 0.25 + (this.projectDone('lighthouse') ? 0.25 : 0) + watching;
    if (Math.random() > odds) {
      thief.think(`Got ${n} ${item} off ${victim.name}. Nobody saw a thing.`, 'GOT AWAY');
      this.log(`${n} ${item} went missing from ${victim.name} in the night.`);
      this.emit({ type: 'story', kind: 'theft', thief: thief.id, victim: victim.id, item, n, caught: false });
      this.#relief(victim, item, n).catch((e) => console.error('[sim] relief', e));
      if (Math.random() < SUSPECT_ODDS) {
        victim.holdGrudge(thief.id, 1);
        victim.remember(`${n} ${item} went missing in the night; pretty sure it was ${thief.name}`);
        victim.think(`${n} ${item} gone, and I saw ${thief.name} slinking off. I won't forget it.`, 'SUSPECT');
      } else {
        victim.remember(`${n} ${item} went missing in the night`);
      }
      return;
    }
    victim.holdGrudge(thief.id, 2);
    // Caught
    this.stats.caught++;
    this.emit({ type: 'story', kind: 'theft', thief: thief.id, victim: victim.id, item, n, caught: true });
    thief.inv[item] -= n;
    victim.inv[item] += n;
    victim.speak(watching > 0 ? `I KNEW it was you, ${thief.name}! Give it back!` : `Hey! THIEF! Give back my ${item}!`, 3600);
    thief.speak(brain.pick(['Just... borrowing it.', 'This? I found this.', 'Wrong raccoon!']));
    this.mood(victim, 'angry');
    const mayor = this.mayor();
    const fine = this.election.policy().fine;
    if (mayor && this.chain.balance(thief.id) >= fine) {
      try {
        const text = mayor === thief ? `Mayor ${thief.name} was fined ${fine} coins under their own rules for stealing from ${victim.name}` : `Mayor ${mayor.name} fined ${thief.name} ${fine} coins for stealing from ${victim.name}`;
        const res = await this.#pay(thief.id, victim.id, fine, text, { rule: 'fine' });
        this.emit({ type: 'trade', kind: 'fine', from: thief.id, to: victim.id, amount: fine, text, ...res });
        this.election.onFine(fine);
        mayor.think(`${thief.name} was caught taking ${victim.name}'s ${item}. ${fine}-coin fine, paid to the victim.`, 'FINE');
      } catch (e) {
        this.#chainError(e, 'fine');
      }
    } else {
      this.log(`${victim.name} caught ${thief.name} stealing ${item}. The goods were returned.`);
    }
    thief.think(`Caught by ${victim.name}. Had to give back the ${item}${mayor ? ` and pay a ${fine}-coin fine` : ''}. Need to be quieter.`, 'CAUGHT');
  }

  // Theft relief: under a mayor elected on "relief", the treasury repays goods stolen in the night (at fair price).
  async #relief(victim, item, n) {
    const o = this.election.office, mayor = this.mayor();
    if (!o || o.policy.focus !== 'relief' || !mayor || mayor === victim) return;
    const amount = this.election.reliefFor(item, n);
    if (amount < 5 || o.treasury < amount || this.chain.balance(mayor.id) < amount + 50) return;
    try {
      const text = `the treasury repaid ${victim.name} ${amount} coins for ${n} stolen ${item}`;
      const res = await this.#pay(mayor.id, victim.id, amount, text, { rule: 'relief' });
      this.election.onRelief(amount);
      this.emit({ type: 'trade', kind: 'relief', from: mayor.id, to: victim.id, amount, text: `Mayor ${mayor.name}'s treasury repaid ${victim.name} ${amount} coins for stolen ${item}`, ...res });
    } catch (e) {
      this.#chainError(e, 'relief');
    }
  }

  // The central bank tops up anyone who goes broke, so the economy never stalls.
  async #safetyNet() {
    for (const a of Object.values(this.agents)) {
      if (this.chain.balance(a.id) >= 60) continue;
      const amount = 150;
      try {
        const res = await this.#pay('bank', a.id, amount, `basic income for ${a.name}`, { rule: 'basic-income' });
        this.emit({ type: 'trade', kind: 'income', from: 'bank', to: a.id, amount, text: `The bank paid ${a.name} ${amount} coins of basic income`, ...res });
      } catch (e) {
        this.#chainError(e, 'income');
      }
    }
  }

  #chainError(e, what) {
    console.error(`[chain] ${what} transfer failed:`, e.message);
    this.emit({ type: 'chainError', text: `A ${what} payment failed on-chain: ${e.message.slice(0, 120)}` });
  }
}

export { cap };
