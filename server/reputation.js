// On-chain reputation: the animals rate each other in the ERC-8004 Reputation Registry on Robinhood Chain.
//
// ERC-8004 pairs the identity registry (every animal is a registered AI agent, see identity.js) with a
// reputation registry: anyone may call giveFeedback(agentId, value, ...) about an agent, except the agent's own
// owner, and anyone can read the results. Here the animals rate each other, from their own wallets, about the
// deals they actually did together:
//   - goods bought and delivered, goods sold and paid for, building contracts carried out   (good)
//   - loans given, loans repaid                                                            (good)
//   - loans defaulted on                                                                   (bad)
//   - being caught stealing (the victim rates the thief, right away)                        (very bad)
// Nothing is guessed: an unproven theft (the victim only suspects) is never rated. Each rating is one
// giveFeedback call (value 0-100, tag1 = what it was about, tag2 = "insula-world") with a public feedback file
// (served at /rep/<id>.json, its keccak256 on-chain) listing the counts and the transactions behind it.
// Everyday deals are batched: one rating per pair of animals per island day. Caught thefts are rated at once.
//
// Opt-in: set ERC8004_REPUTATION=on (needs the identity registry on and the animals registered).

import { Interface, keccak256, toUtf8Bytes, id as topicId } from 'ethers';
import { REGISTRY as IDENTITY_REGISTRY } from './identity.js';

const env = (k, d) => (typeof process !== 'undefined' && process.env?.[k]) || d;
export const REP_REGISTRY = env('ERC8004_REPUTATION_REGISTRY', '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
const ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];
const iface = new Interface(ABI);
const NEW_FEEDBACK = topicId('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');
const ITEMS = new Set(['ore', 'fish', 'wood', 'grain']);
const TAG2 = 'insula-world';
const BASE = () => env('PUBLIC_URL', 'https://insulaworld.com').replace(/\/$/, '');
const blank = () => ({ bought: 0, sold: 0, built: 0, hired: 0, lent: 0, repaid: 0, defaults: 0, coins: 0, txs: [] });

// The score for one period of dealings, 0-100 (no decimals), and what it was mostly about.
export function score(t) {
  const pos = t.bought + t.sold + (t.built + t.hired + t.lent) * 2 + t.repaid * 3;
  const neg = t.defaults * 6 + (t.caught || 0) * 10;
  if (!pos && !neg) return null;
  const value = neg ? Math.round((100 * pos) / (pos + neg)) : 100;
  const tag1 = t.period ? 'history' : t.caught ? 'theft' : t.defaults ? 'default' : t.lent || t.repaid ? 'credit' : t.built || t.hired ? 'contract' : 'trade';
  return { value, tag1 };
}

export class Reputation {
  constructor(sim, identity, saved) {
    this.sim = sim;
    this.identity = identity;
    this.open = saved?.open || {};       // rater -> rated -> counts for the current island day
    this.ratings = saved?.ratings || []; // every rating: { id, rater, rated, agentId, value, tag1, day, at, uri, hash, status, tx, url, index }
    this.files = saved?.files || {};     // rating id -> the exact feedback file text (its hash is on-chain)
    this.thefts = saved?.thefts || [];   // caught thefts waiting a moment for the fine's transaction
    this.day = saved?.day ?? sim.genesisDay();
    this.seq = saved?.seq || 1;
    this.historyDone = saved?.historyDone || false; // the one-time rating of everything since day 1
    this.status = 'off';
    this.busy = false;
    this.onchain = {};                   // agent id -> { count, value, at } read back from the registry
  }

  save() {
    // Keep the files of the most recent ratings only (older ones are on-chain and in the explorer).
    const keep = new Set(this.ratings.slice(-3000).map((r) => r.id));
    const files = Object.fromEntries(Object.entries(this.files).filter(([k]) => keep.has(k)));
    return { open: this.open, ratings: this.ratings.slice(-3000), files, thefts: this.thefts, day: this.day, seq: this.seq, historyDone: this.historyDone };
  }

  enabled() {
    return /^(on|1|true|yes)$/i.test(env('ERC8004_REPUTATION', '')) && this.identity.enabled();
  }

  isAgent(id) { return id && id !== 'bank' && !!this.sim.agents[id]; }
  tally(rater, rated) { return ((this.open[rater] ||= {})[rated] ||= blank()); }
  evidence(t, e) {
    if (!e.sig) return;
    t.txs.push({ hash: e.sig, from: this.sim.chain.addressOf(e.from), to: this.sim.chain.addressOf(e.to), coins: Math.round(e.amount || 0), what: e.kind });
    if (t.txs.length > 40) t.txs.splice(0, t.txs.length - 40);
  }

  // Count what happened between two animals, from the island's own events.
  record(e) {
    if (e.type === 'trade' && this.isAgent(e.from) && this.isAgent(e.to)) {
      const amt = Math.round(e.amount || 0);
      const both = (a, b, fa, fb) => { const x = this.tally(a, b), y = this.tally(b, a); x[fa]++; y[fb]++; x.coins += amt; y.coins += amt; this.evidence(x, e); this.evidence(y, e); };
      if (ITEMS.has(e.kind)) both(e.from, e.to, 'bought', 'sold');      // the buyer got the goods, the seller got paid
      else if (e.kind === 'contract') both(e.from, e.to, 'built', 'hired');
      else if (e.kind === 'loan') { const t = this.tally(e.to, e.from); t.lent++; t.coins += amt; this.evidence(t, e); }      // the borrower rates the lender
      else if (e.kind === 'repay') { const t = this.tally(e.to, e.from); t.repaid++; t.coins += amt; this.evidence(t, e); }  // the lender rates the borrower
      else if (e.kind === 'default') { const t = this.tally(e.to, e.from); t.defaults++; this.evidence(t, e); }
      else if (e.kind === 'fine') { const th = this.thefts.find((x) => x.victim === e.to && x.thief === e.from && !x.fine); if (th) th.fine = { hash: e.sig, from: this.sim.chain.addressOf(e.from), to: this.sim.chain.addressOf(e.to), coins: Math.round(e.amount || 0), what: 'fine' }; }
    } else if (e.type === 'credit' && e.kind === 'default' && this.isAgent(e.from) && this.isAgent(e.to)) {
      this.tally(e.to, e.from).defaults++;
    } else if (e.type === 'story' && e.kind === 'theft' && e.caught && this.isAgent(e.thief) && this.isAgent(e.victim)) {
      this.thefts.push({ thief: e.thief, victim: e.victim, item: e.item, n: e.n, at: Date.now() });
    }
  }

  start() {
    if (!this.enabled()) { this.status = 'off'; return; }
    this.status = 'starting';
    const every = Number(env('ERC8004_REPUTATION_TICK_MS', 60_000));
    setInterval(() => this.tick().catch((e) => console.error('[reputation]', e.message)), every).unref?.();
    setTimeout(() => this.tick().catch((e) => console.error('[reputation]', e.message)), Number(env('ERC8004_REPUTATION_DELAY_MS', 90_000)));
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.checked) {
        const code = await this.sim.chain.provider.getCode(REP_REGISTRY);
        if (!code || code === '0x') { this.status = 'no reputation registry on this chain'; console.warn(`[reputation] no ERC-8004 reputation registry at ${REP_REGISTRY}; skipping.`); return; }
        this.checked = true;
      }
      this.status = 'live';
      // Once: rate everything since day 1 from the island's relationship records (ERC8004_REPUTATION_HISTORY=on).
      if (!this.historyDone && /^(on|1|true|yes)$/i.test(env('ERC8004_REPUTATION_HISTORY', '')) && this.relations) {
        const n = this.#history();
        this.historyDone = true;
        if (n) this.sim.log(`The animals put their history on-chain: ${n} ratings of each other covering day 1 to day ${this.sim.genesisDay() + 1} (ERC-8004 reputation).`);
      }
      // Caught thefts: rated right away (after a moment, so the fine's transaction can be attached).
      for (const th of this.thefts.filter((x) => Date.now() - x.at > 20_000)) {
        this.thefts.splice(this.thefts.indexOf(th), 1);
        this.#queue(th.victim, th.thief, { ...blank(), caught: 1, txs: th.fine ? [th.fine] : [], item: th.item, n: th.n }, true);
      }
      // A new island day: rate yesterday's dealings, one rating per pair.
      const today = this.sim.genesisDay();
      if (today !== this.day) {
        const day = this.day + 1; // the island counts days from 1
        let n = 0;
        for (const [rater, row] of Object.entries(this.open)) for (const [rated, t] of Object.entries(row)) if (this.#queue(rater, rated, t, false, day)) n++;
        this.open = {};
        this.day = today;
        if (n) this.sim.log(`The animals left ${n} on-chain ratings of each other for day ${day} (ERC-8004 reputation).`);
      }
      const sent = await this.#send();
      // Read the scores back from the registry now and then (and right after new ratings land).
      if (sent || Date.now() - (this.readAt || 0) > 10 * 60_000) { this.readAt = Date.now(); await this.readBack().catch(() => {}); }
    } finally {
      this.busy = false;
    }
  }

  // Turn a tally into a rating with its public feedback file, waiting to be sent.
  #queue(rater, rated, t, now, day = this.day + 1) {
    const s = score(t);
    if (!s || !this.isAgent(rater) || !this.isAgent(rated) || rater === rated) return null;
    const agentId = this.identity.ids[rated]?.agentId;
    if (!agentId) return null; // not registered yet: nothing to rate
    const chainId = this.identity.chainId();
    const id = `R${this.seq++}`;
    const A = this.sim.agents[rater], B = this.sim.agents[rated];
    const parts = [];
    if (t.bought) parts.push(`${A.name} bought from ${B.name} ${t.bought} time${t.bought > 1 ? 's' : ''} and got the goods`);
    if (t.sold) parts.push(`${B.name} paid for ${t.sold} order${t.sold > 1 ? 's' : ''} from ${A.name}`);
    if (t.built) parts.push(`${B.name} built ${t.built} job${t.built > 1 ? 's' : ''} for ${A.name}`);
    if (t.hired) parts.push(`${B.name} hired ${A.name} ${t.hired} time${t.hired > 1 ? 's' : ''} and paid`);
    if (t.lent) parts.push(`${B.name} lent ${A.name} coins${t.lent > 1 ? ` ${t.lent} times` : ''}`);
    if (t.repaid) parts.push(`${B.name} repaid ${A.name} ${t.repaid} time${t.repaid > 1 ? 's' : ''}`);
    if (t.defaults) parts.push(`${B.name} defaulted on a loan from ${A.name}`);
    if (t.caught) parts.push(t.period ? `${A.name} caught ${B.name} stealing ${t.caught} time${t.caught > 1 ? 's' : ''}` : `${A.name} caught ${B.name} stealing ${t.n || ''} ${t.item || 'goods'}`.replace(/\s+/g, ' '));
    const proof = t.txs.at(-1);
    const file = {
      agentRegistry: `eip155:${chainId}:${IDENTITY_REGISTRY}`,
      agentId: Number(agentId),
      clientAddress: `eip155:${chainId}:${this.sim.chain.addressOf(rater)}`,
      createdAt: new Date().toISOString(),
      value: s.value,
      valueDecimals: 0,
      tag1: s.tag1,
      tag2: TAG2,
      endpoint: `${BASE()}/#profile-${rated}`,
      ...(proof ? { proofOfPayment: { fromAddress: proof.from, toAddress: proof.to, chainId: String(chainId), txHash: proof.hash } } : {}),
      insula: {
        rater: { id: rater, name: A.name, agentId: this.identity.ids[rater]?.agentId ? Number(this.identity.ids[rater].agentId) : null },
        rated: { id: rated, name: B.name },
        period: t.period || (now ? 'event' : `day ${day}`),
        ...(t.source ? { source: t.source } : {}),
        summary: parts.join('; ') + '.',
        counts: { bought: t.bought, sold: t.sold, built: t.built, hired: t.hired, lent: t.lent, repaid: t.repaid, defaults: t.defaults, caughtStealing: t.caught || 0, coins: t.coins },
        transactions: t.txs.map((x) => x.hash),
        scoring: 'good = deals honored + 2x contracts and loans given + 3x loans repaid; bad = 6x defaults + 10x thefts caught; value = 100 * good / (good + bad)',
      },
    };
    const text = JSON.stringify(file, null, 2);
    this.files[id] = text;
    const r = { id, rater, rated, agentId: String(agentId), value: s.value, tag1: s.tag1, day, at: Date.now(), uri: `${BASE()}/rep/${id}.json`, hash: keccak256(toUtf8Bytes(text)), status: 'queued', tries: 0, summary: file.insula.summary, now };
    this.ratings.push(r);
    return r;
  }

  // The history rating: one rating per pair (in each direction) for everything they did together since day 1,
  // counted from the relationship records (trades, build jobs, loans, repayments, defaults, caught thefts).
  // Directions come from who paid whom and from roles: the banker in a pair is the lender, the builder is the
  // one who builds, the thief is the one who steals. Unproven thefts are left out, as always.
  #history() {
    const rel = this.relations.data, given = rel.given || {};
    const today = this.sim.genesisDay() + 1;
    const role = (id) => this.sim.agents[id]?.role;
    let n = 0;
    for (const [key, p] of Object.entries(rel.pairs || {})) {
      const [a, b] = key.split('|');
      if (!this.isAgent(a) || !this.isAgent(b)) continue;
      for (const [rater, rated] of [[a, b], [b, a]]) {
        const t = { ...blank(), period: `history: day 1 to day ${today}`, source: { kind: 'Insula relationship records: trades, build jobs and loans since day 1; caught thefts since ' + new Date(rel.since).toISOString().slice(0, 10), decisions: `${BASE()}/api/decisions?agent=${rated}` } };
        const builderRated = role(rated) === 'builder' && role(rater) !== 'builder';
        const builderRater = role(rater) === 'builder' && role(rated) !== 'builder';
        const contracts = p.contracts || 0;
        // goods: what rater paid rated (minus build-job payments) = orders rated delivered; and the other way round
        t.bought = Math.max(0, (given[rater]?.[rated]?.n || 0) - (builderRated ? contracts : 0));
        t.sold = Math.max(0, (given[rated]?.[rater]?.n || 0) - (builderRater ? contracts : 0));
        if (builderRated) t.built = contracts;
        if (builderRater) t.hired = contracts;
        const lenderRated = role(rated) === 'banker' && role(rater) !== 'banker';
        const lenderRater = role(rater) === 'banker' && role(rated) !== 'banker';
        if (lenderRated) t.lent = p.loans || 0;                                   // borrower rates the lender
        if (lenderRater) { t.repaid = p.repaid || 0; t.defaults = p.defaults || 0; } // lender rates the borrower
        if (role(rated) === 'thief' && role(rater) !== 'thief') t.caught = p.caught || 0; // only thefts that were caught
        t.coins = (given[rater]?.[rated]?.coins || 0) + (given[rated]?.[rater]?.coins || 0);
        if (this.#queue(rater, rated, t, false, today)) n++;
      }
    }
    return n;
  }

  // Send queued ratings, one at a time, each from the rater's own wallet.
  async #send() {
    const gap = Number(env('ERC8004_REPUTATION_GAP_MS', 4000));
    let sent = 0;
    for (const r of this.ratings.filter((x) => x.status === 'queued' || (x.status === 'failed' && x.tries < 3))) {
      if (!this.isAgent(r.rater)) { r.status = 'skipped'; continue; }
      r.tries++;
      try {
        const data = iface.encodeFunctionData('giveFeedback', [BigInt(r.agentId), r.value, 0, r.tag1, TAG2, `${BASE()}/#profile-${r.rated}`, r.uri, r.hash]);
        const res = await this.sim.chain.contractCall(r.rater, REP_REGISTRY, data);
        const log = res.receipt?.logs?.find((l) => l.address.toLowerCase() === REP_REGISTRY.toLowerCase() && l.topics[0] === NEW_FEEDBACK);
        r.index = log ? Number(iface.parseLog(log).args.feedbackIndex) : null;
        r.status = 'sent'; r.tx = res.hash; r.url = res.url; r.sentAt = Date.now(); sent++;
        const A = this.sim.agents[r.rater], B = this.sim.agents[r.rated];
        this.sim.emit({ type: 'reputation', rater: r.rater, rated: r.rated, value: r.value, tag: r.tag1, tx: r.tx, url: r.url, id: r.id });
        if (r.now) {
          this.sim.log(`${A?.name} rated ${B?.name} ${r.value}/100 on-chain for stealing (ERC-8004 reputation).`);
          A?.think(`Rated ${B?.name} ${r.value}/100 on-chain for the theft. Every app on Robinhood can see that now.`, 'ON-CHAIN RATING');
        }
      } catch (e) {
        r.status = 'failed'; r.error = String(e.message || e).slice(0, 160);
        console.error(`[reputation] ${r.id} ${r.rater}->${r.rated}: ${r.error}`);
      }
      await new Promise((ok) => setTimeout(ok, gap));
    }
    return sent;
  }

  // Read each animal's summary back from the registry (only ratings from island wallets, as ERC-8004 advises
  // filtering by trusted clients), so the site shows what's actually on-chain.
  async readBack() {
    if (this.status !== 'live') return;
    const { Contract } = await import('ethers');
    const reg = new Contract(REP_REGISTRY, ABI, this.sim.chain.provider);
    const clients = Object.keys(this.sim.agents).map((a) => this.sim.chain.addressOf(a));
    for (const [id, rec] of Object.entries(this.identity.ids)) {
      try {
        const [count, value, dec] = await reg.getSummary(BigInt(rec.agentId), clients, '', '');
        this.onchain[id] = { count: Number(count), value: Number(value) / 10 ** Number(dec), at: Date.now() };
      } catch {}
    }
  }

  // ---------- Public views ----------
  agentView(id) {
    const mine = this.ratings.filter((r) => r.rated === id && r.status === 'sent');
    const by = {};
    for (const r of mine) (by[r.tag1] ||= []).push(r.value);
    const avg = (a) => (a.length ? Math.round(a.reduce((t, v) => t + v, 0) / a.length) : null);
    return {
      status: this.status,
      registry: REP_REGISTRY,
      agentId: this.identity.ids[id]?.agentId || null,
      count: mine.length,
      score: avg(mine.map((r) => r.value)),
      raters: new Set(mine.map((r) => r.rater)).size,
      byTag: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { count: v.length, score: avg(v) }])),
      onchain: this.onchain[id] || null,
      pending: this.ratings.filter((r) => r.rated === id && r.status === 'queued').length,
      recent: mine.slice(-12).reverse().map((r) => ({ id: r.id, from: r.rater, value: r.value, tag: r.tag1, day: r.day, summary: r.summary, tx: r.url || null, file: r.uri })),
      given: this.ratings.filter((r) => r.rater === id && r.status === 'sent').length,
    };
  }

  view() {
    return {
      status: this.status,
      registry: REP_REGISTRY,
      identityRegistry: IDENTITY_REGISTRY,
      chainId: this.identity.chainId(),
      tag2: TAG2,
      sent: this.ratings.filter((r) => r.status === 'sent').length,
      queued: this.ratings.filter((r) => r.status === 'queued').length,
      agents: Object.fromEntries(Object.keys(this.sim.agents).map((id) => [id, this.agentView(id)])),
      howToRead: 'getSummary(agentId, <island wallets>, "", "") on the reputation registry; tag2 "insula-world" marks Insula ratings.',
    };
  }
}
