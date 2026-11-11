// Mayor elections. Every few island days (ELECTION_EVERY_DAYS, default 3):
//   1. The campaign opens. The mayor runs again; every other animal decides for itself whether to run, and on
//      what platform (property tax, the fine for theft, and what the treasury pays for).
//   2. A day later the island votes. Each animal votes once, with its reason.
//   3. The votes are counted, the winner takes office and their platform becomes the island's rules.
// Nobody runs this by hand. Candidacies and votes are decision records with SHA-256 fingerprints, like
// every payment's; a change of mayor hands the treasury over in an on-chain payment labeled rule:election.

import * as brain from './brain.js';
import { PRICES } from './agents.js';

const env = (k, d) => {
  const v = typeof process !== 'undefined' ? process.env?.[k] : undefined;
  return v == null || v === '' ? d : Number(v);
};

// What a mayor can set, and the hard limits. Anything a candidate asks for is clamped to these.
export const POLICY = {
  default: { tax: 8, fine: 80, focus: 'works' },
  limits: { tax: [0, 16], fine: [40, 200] },
  focuses: ['works', 'relief'],
};
const MAX_CANDIDATES = 4;

const clampPolicy = (p, base = POLICY.default) => ({
  tax: Math.round(Math.min(POLICY.limits.tax[1], Math.max(POLICY.limits.tax[0], Number.isFinite(+p.tax) ? +p.tax : base.tax))),
  fine: Math.round(Math.min(POLICY.limits.fine[1], Math.max(POLICY.limits.fine[0], Number.isFinite(+p.fine) ? +p.fine : base.fine)) / 5) * 5,
  focus: POLICY.focuses.includes(p.focus) ? p.focus : base.focus,
});
const hours = (ms) => (ms >= 3600_000 ? `${Math.round(ms / 3600_000)} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`);

export class Election {
  constructor(sim, saved) {
    this.sim = sim;
    const s = saved || {};
    this.n = s.n || 0;                 // elections held or under way
    this.phase = s.phase || 'term';    // 'term' | 'campaign'
    this.nextCampaignAt = s.nextCampaignAt || null;
    this.voteAt = s.voteAt || null;
    this.current = s.current || null;  // { n, openedAt, candidates: [...], votes: { voterId: {...} }, result }
    this.history = s.history || [];    // past results, newest last
    this.office = s.office || null;    // { mayor, since, policy, treasury, term: {...} }
    this.busy = false;
    this.lastPitchAt = 0;
  }

  save() {
    return { n: this.n, phase: this.phase, nextCampaignAt: this.nextCampaignAt, voteAt: this.voteAt, current: this.current, history: this.history.slice(-20), office: this.office };
  }

  // ---------- Timing ----------
  everyMs() { return env('ELECTION_EVERY_DAYS', 3) * this.sim.dayMs; }
  campaignMs() { return env('ELECTION_CAMPAIGN_DAYS', 1) * this.sim.dayMs; }

  // Elections need a mayor in the first place: they start once the Town Hall has brought one.
  ready() { return Boolean(this.sim.has('tax') && (this.office || Object.values(this.sim.agents).some((a) => a.role === 'mayor'))); }

  // The office: who is mayor, the rules they set, and the treasury (taxes in, public spending out) they hold.
  ensureOffice() {
    if (this.office) return this.office;
    const mayor = Object.values(this.sim.agents).find((a) => a.role === 'mayor');
    if (!mayor) return null;
    // The treasury so far: every tax coin collected, minus what the mayor has put into public works.
    const spent = Object.values(this.sim.projects).reduce((t, p) => t + (p.donors?.[mayor.id] || 0), 0);
    const treasury = Math.max(0, Math.min(this.sim.chain.balance(mayor.id), (this.sim.stats.taxes || 0) - spent));
    this.office = { mayor: mayor.id, since: Date.now(), policy: { ...POLICY.default }, treasury: Math.round(treasury), term: this.#freshTerm() };
    return this.office;
  }

  #freshTerm() {
    return { taxes: 0, funded: 0, fines: 0, fined: 0, relief: 0, thefts0: this.sim.stats.thefts || 0, caught0: this.sim.stats.caught || 0 };
  }

  mayorId() { return this.office?.mayor || Object.values(this.sim.agents).find((a) => a.role === 'mayor')?.id || null; }
  policy() { return this.office?.policy || POLICY.default; }

  start() {
    setInterval(() => this.tick().catch((e) => console.error('[election]', e)), 5000);
  }

  async tick() {
    if (this.busy || !this.ready()) return;
    this.ensureOffice();
    const now = Date.now();
    if (!this.nextCampaignAt && this.phase === 'term') {
      // First election: the campaign opens shortly after elections switch on (ELECTION_FIRST_DELAY_MS).
      this.nextCampaignAt = now + env('ELECTION_FIRST_DELAY_MS', Math.min(10 * 60_000, this.sim.dayMs / 10));
    }
    this.busy = true;
    try {
      if (this.phase === 'term' && now >= this.nextCampaignAt) await this.#openCampaign();
      else if (this.phase === 'campaign' && now >= this.voteAt) await this.#vote();
      else if (this.phase === 'campaign') this.#campaignChatter();
    } finally {
      this.busy = false;
    }
  }

  // ---------- Briefings ----------
  #me(agent) {
    const sim = this.sim;
    const levels = sim.buildings.filter((b) => b.kind === 'private' && b.owner === agent.id && b.progress >= 1).reduce((t, b) => t + (b.level || 1), 0);
    const thief = agent.role === 'thief';
    const grudges = Object.fromEntries(Object.values(sim.agents).filter((o) => o !== agent).map((o) => [o.id, Math.round(agent.grudge(o.id) * 10) / 10]).filter(([, g]) => g >= 0.5));
    const robbed = Math.round(Object.values(grudges).reduce((t, g) => t + g, 0));
    return { coins: Math.round(sim.chain.balance(agent.id)), levels, thief, builder: agent.role === 'builder', robbed, grudges, crimeFelt: robbed };
  }

  #selfText(agent, me) {
    const p = this.policy();
    const parts = [`${me.coins} coins`, `job: ${agent.job}`];
    parts.push(me.levels ? `you own ${me.levels} building level${me.levels > 1 ? 's' : ''}, so you pay ${me.levels * p.tax} coins tax a day now` : 'you own no buildings, so you pay no property tax');
    if (me.thief) parts.push(`you steal at night for a living; when caught you pay the fine (${p.fine} now)`);
    else if (me.robbed) parts.push(`you've been robbed recently (grudge ${me.robbed} against ${Object.keys(me.grudges).map((id) => this.sim.agents[id]?.name).join(', ')})`);
    else parts.push('nobody has robbed you lately');
    if (me.builder) parts.push('public works are paid to builders like you');
    return parts.join('; ');
  }

  #record() {
    const o = this.office, t = o.term;
    const thefts = (this.sim.stats.thefts || 0) - t.thefts0, caught = (this.sim.stats.caught || 0) - t.caught0;
    return `${t.taxes} coins of tax collected, ${t.funded} spent on public works, ${t.relief} repaid to theft victims, ${thefts} thefts (${caught} caught, ${t.fined} fined)`;
  }

  #facts(agent, extra = {}) {
    const o = this.office;
    const me = this.#me(agent);
    const mayor = this.sim.agents[o.mayor];
    const others = Object.values(this.sim.agents).filter((a) => a !== agent).map((a) => `${a.name} (${a.job}, ${Math.round(this.sim.chain.balance(a.id))}c)`).join(', ');
    return {
      n: this.current?.n ?? this.n, me, self: this.#selfText(agent, me), island: others, policy: o.policy, treasury: Math.round(o.treasury),
      mayorName: mayor?.name || 'nobody', record: this.#record(), termText: hours(this.everyMs() - this.campaignMs()), voteIn: hours(this.campaignMs()),
      incumbent: agent.id === o.mayor, ...extra,
    };
  }

  // The drive line an animal's AI reads (same idea as brain.js ROLE_DRIVE), kept short.
  #drive(agent) {
    return agent.role === 'thief' ? 'You live by quietly taking goods at night; fines are your biggest cost.'
      : agent.id === this.office?.mayor ? 'You are the mayor and like the job.'
      : 'Goals: stay fed, grow your wealth, keep good relationships.';
  }

  // ---------- 1. Campaign ----------
  async #openCampaign() {
    const sim = this.sim, o = this.office;
    this.n++;
    this.phase = 'campaign';
    const openedAt = Date.now();
    this.voteAt = openedAt + this.campaignMs();
    this.current = { n: this.n, openedAt, voteAt: this.voteAt, candidates: [], votes: {}, result: null };
    sim.log(`Election ${this.n}: the race for mayor is open. Voting in ${hours(this.campaignMs())}.`);
    sim.emit({ type: 'election', kind: 'open', n: this.n, voteAt: this.voteAt });
    // The mayor first (always runs), then everyone else, richest first.
    const order = Object.values(sim.agents).sort((a, b) => (a.id === o.mayor ? -1 : b.id === o.mayor ? 1 : sim.chain.balance(b.id) - sim.chain.balance(a.id)));
    for (const agent of order) {
      if (this.current.candidates.length >= MAX_CANDIDATES) break;
      const facts = this.#facts(agent, { running: this.current.candidates.map((c) => `${c.name} (tax ${c.tax}, fine ${c.fine}, ${c.focus}: "${c.pitch}")`) });
      const d = await brain.decideCandidacy(agent, facts, POLICY, this.#drive(agent));
      const platform = d.run ? clampPolicy(d, o.policy) : null;
      const rec = await this.#seal(agent, facts, {
        options: 2, choice: d.run ? `run:tax=${platform.tax},fine=${platform.fine},focus=${platform.focus}` : 'stay-out',
        thought: d.thought, said: d.run ? d.pitch || d.say : null, brain: d.brain,
      });
      if (!d.run) { agent.think(d.thought, 'ELECTION · SITS OUT', rec.id); continue; }
      const c = { id: agent.id, name: agent.name, incumbent: agent.id === o.mayor, thief: agent.role === 'thief', ...platform, pitch: d.pitch || `Tax ${platform.tax}, fine ${platform.fine}.`, decision: rec.id };
      this.current.candidates.push(c);
      agent.think(d.thought, c.incumbent ? 'ELECTION · RUNS AGAIN' : 'ELECTION · RUNS', rec.id);
      agent.speak(d.say || c.pitch, 5200);
      agent.remember(`I'm running for mayor: tax ${c.tax}, fine ${c.fine}, focus ${c.focus}`);
      sim.log(`${agent.name} is running for mayor${c.incumbent ? ' again' : ''}: tax ${c.tax}, fine ${c.fine}, ${c.focus === 'relief' ? 'theft relief' : 'public works'}. "${c.pitch}"`);
      sim.emit({ type: 'election', kind: 'candidate', n: this.n, candidate: c });
    }
    const names = this.current.candidates.map((c) => c.name);
    if (names.length === 1) sim.log(`Election ${this.n}: nobody challenged Mayor ${names[0]}. The vote goes ahead anyway.`);
    for (const a of Object.values(sim.agents)) a.remember(`election ${this.n} for mayor: ${names.join(' vs ')}`);
  }

  // Now and then during the campaign, a candidate repeats their promise out loud.
  #campaignChatter() {
    const c = this.current?.candidates;
    if (!c?.length || Date.now() - this.lastPitchAt < Math.max(60_000, this.campaignMs() / 24)) return;
    this.lastPitchAt = Date.now();
    const pick = c[Math.floor(Math.random() * c.length)];
    const agent = this.sim.agents[pick.id];
    if (agent && !agent.say) agent.speak(pick.pitch, 4800);
  }

  // ---------- 2. Vote ----------
  async #vote() {
    const sim = this.sim, cur = this.current;
    if (!cur?.candidates?.length) { this.#schedule(); return; }
    if (!Object.keys(cur.votes).length) {
      sim.log(`Election ${cur.n}: polls are open. ${cur.candidates.map((c) => c.name).join(' vs ')}.`);
      sim.emit({ type: 'election', kind: 'polls', n: cur.n });
    }
    // One at a time, so the island (and anyone watching) sees the votes come in. Resumes after a restart.
    for (const agent of Object.values(sim.agents)) {
      if (cur.votes[agent.id]) continue;
      const facts = this.#facts(agent, { candidates: cur.candidates });
      const d = await brain.decideVote(agent, facts, this.#drive(agent));
      const pick = cur.candidates.find((c) => c.id === d.vote) || cur.candidates[0];
      const rec = await this.#seal(agent, facts, { options: cur.candidates.length, choice: `vote:${pick.id}`, thought: d.thought, said: d.say, brain: d.brain });
      cur.votes[agent.id] = { for: pick.id, thought: d.thought, say: d.say, decision: rec.id, at: Date.now() };
      agent.think(d.thought, `VOTE → ${pick.name.toUpperCase()}`, rec.id);
      if (d.say) agent.speak(d.say, 4200);
      sim.emit({ type: 'election', kind: 'vote', n: cur.n, voter: agent.id, for: pick.id, decision: rec.id });
      await new Promise((r) => setTimeout(r, env('ELECTION_VOTE_GAP_MS', 2500)));
    }
    await this.#count();
  }

  // ---------- 3. Count and take office ----------
  async #count() {
    const sim = this.sim, cur = this.current, o = this.office;
    const tally = Object.fromEntries(cur.candidates.map((c) => [c.id, 0]));
    for (const v of Object.values(cur.votes)) if (v.for in tally) tally[v.for]++;
    // Most votes wins. A tie keeps the sitting mayor; otherwise it goes to whoever declared first.
    const top = Math.max(...Object.values(tally));
    const tied = cur.candidates.filter((c) => tally[c.id] === top);
    const winner = tied.find((c) => c.incumbent) || tied[0];
    const prev = o.mayor;
    const changed = winner.id !== prev;
    const score = cur.candidates.map((c) => `${c.name} ${tally[c.id]}`).join(', ');
    let handover = null;
    if (changed) {
      const amount = Math.round(Math.min(o.treasury, Math.max(0, sim.chain.balance(prev) - 50)));
      if (amount > 0) {
        try {
          handover = await sim.rulePayment(prev, winner.id, amount, `election ${cur.n}: ${sim.agents[prev]?.name} hands the treasury to Mayor ${winner.name}`, 'election');
          sim.emit({ type: 'trade', kind: 'treasury', from: prev, to: winner.id, amount, text: `${sim.agents[prev]?.name} handed ${amount} treasury coins to the new mayor, ${winner.name}`, ...handover });
        } catch (e) {
          console.error('[election] treasury handover failed:', e.message);
        }
      }
      o.treasury = handover ? amount : 0;
    }
    const before = { ...o.policy };
    o.mayor = winner.id;
    o.policy = clampPolicy(winner, o.policy);
    if (changed) o.since = Date.now();
    const record = this.#record();
    o.term = this.#freshTerm();
    cur.result = { winner: winner.id, tally, changed, prev, policy: { ...o.policy }, before, at: Date.now(), handover: handover?.sig || null, handoverUrl: handover?.url || null, lastTerm: record };
    this.history.push({ n: cur.n, at: cur.result.at, winner: winner.id, prev, changed, tally, candidates: cur.candidates.map(({ id, name, tax, fine, focus, pitch, incumbent }) => ({ id, name, tax, fine, focus, pitch, incumbent })), policy: { ...o.policy } });
    const w = sim.agents[winner.id];
    const text = changed
      ? `${winner.name} wins election ${cur.n} and becomes mayor (${score}). New rules: tax ${o.policy.tax}, fine ${o.policy.fine}, ${o.policy.focus === 'relief' ? 'theft relief' : 'public works'}.`
      : `Mayor ${winner.name} wins election ${cur.n} (${score}) and stays in office. Rules: tax ${o.policy.tax}, fine ${o.policy.fine}, ${o.policy.focus === 'relief' ? 'theft relief' : 'public works'}.`;
    sim.log(text);
    sim.emit({ type: 'election', kind: 'result', n: cur.n, result: cur.result });
    sim.emit({ type: 'story', kind: 'election', n: cur.n, winner: winner.id, prev, changed, tally, policy: { ...o.policy } });
    if (w) {
      w.speak(changed ? brain.pick(['I won! Thank you, Insula!', 'Mayor! Me! Rules change today.', 'The people have spoken!']) : brain.pick(['Thank you, Insula. Back to work.', 'Another term. I won\'t let you down.']), 5200);
      w.think(`Won with ${tally[winner.id]} of ${Object.keys(cur.votes).length} votes. Tax ${o.policy.tax}, fine ${o.policy.fine}, ${o.policy.focus}.`, 'ELECTED');
      sim.mood(w, 'happy');
    }
    if (changed && sim.agents[prev]) {
      const p = sim.agents[prev];
      p.think(`Lost election ${cur.n} to ${winner.name}, ${score}. I'm a private citizen now.`, 'LOST ELECTION');
      p.remember(`I lost the election to ${winner.name}; ${winner.name} is mayor now`);
      sim.mood(p, 'sad');
    }
    for (const a of Object.values(sim.agents)) a.remember(`${winner.name} won election ${cur.n} for mayor: tax ${o.policy.tax}, fine ${o.policy.fine}, ${o.policy.focus}`);
    this.#schedule();
  }

  #schedule() {
    this.phase = 'term';
    this.nextCampaignAt = (this.voteAt || Date.now()) + this.everyMs() - this.campaignMs();
  }

  // Candidacy and vote records: sealed with the same SHA-256 fingerprint as payment decisions, and saved to
  // the decision files, so anyone can look up why each animal ran or voted the way it did.
  async #seal(agent, facts, d) {
    const sim = this.sim;
    const rec = {
      id: `D${sim.decisionSeq++}`, agent: agent.id, name: agent.name, at: Date.now(), day: sim.genesisDay() + 1,
      brain: d.brain || 'rule', saw: { coins: facts.me.coins, inv: { ...agent.inv }, hunger: agent.hunger },
      options: d.options, choice: d.choice, qty: null, price: null, thought: d.thought || '', said: d.said || null,
      steps: [{ election: facts.n, policy: { ...facts.policy }, candidates: facts.candidates?.map((c) => `${c.id}:${c.tax}/${c.fine}/${c.focus}`) || null }],
      txs: [],
    };
    await sim.seal(rec);
    sim.decisions++;
    return rec;
  }

  // ---------- Effects of the office (called by the sim) ----------
  onTax(amount) { if (this.office) { this.office.treasury += amount; this.office.term.taxes += amount; } }
  onFund(amount) { if (this.office) { this.office.treasury = Math.max(0, this.office.treasury - amount); this.office.term.funded += amount; } }
  onFine(amount) { if (this.office) { this.office.term.fines += amount; this.office.term.fined++; } }
  onRelief(amount) { if (this.office) { this.office.treasury = Math.max(0, this.office.treasury - amount); this.office.term.relief += amount; } }
  reliefFor(item, n) { return Math.round(n * (PRICES[item]?.fair || 10)); }

  // ---------- What viewers see ----------
  view() {
    const o = this.office, cur = this.current;
    const tally = cur ? Object.fromEntries(cur.candidates.map((c) => [c.id, Object.values(cur.votes).filter((v) => v.for === c.id).length])) : null;
    return {
      n: this.n, phase: this.phase, nextCampaignAt: this.nextCampaignAt, voteAt: this.voteAt, ready: this.ready(),
      everyMs: this.everyMs(), campaignMs: this.campaignMs(),
      office: o ? { mayor: o.mayor, since: o.since, policy: o.policy, treasury: Math.round(o.treasury), record: this.#record() } : null,
      current: cur ? { n: cur.n, openedAt: cur.openedAt, voteAt: cur.voteAt, candidates: cur.candidates, tally, voted: Object.keys(cur.votes).length,
        votes: Object.fromEntries(Object.entries(cur.votes).map(([k, v]) => [k, { for: v.for, thought: v.thought, decision: v.decision }])), result: cur.result } : null,
      history: this.history.slice(-8),
      limits: POLICY.limits,
    };
  }
}
