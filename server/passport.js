// Agent passports: one page per agent (an island animal or an outside visitor like Nova) with everything
// anyone needs to decide whether to trust it, each fact linked to the chain where it can be checked:
// its ERC-8004 identity, wallet, reputation, credit record, bond, and its recent on-chain deals.
// GET /api/passport/:who (an id, a name or an ERC-8004 agent id) and the page at /agent/:who.

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const tokenUrl = (agentId) => (agentId ? `https://robinhoodchain.blockscout.com/token/${IDENTITY_REGISTRY}/instance/${agentId}` : null);
const norm = (s) => String(s ?? '').trim().replace(/^#/, '').toLowerCase();

export class Passports {
  constructor({ sim, identity, reputation, credit, relations, visitors, validation }) {
    Object.assign(this, { sim, identity, reputation, credit, relations, visitors, validation });
  }

  // Everyone with a passport, for the index and the "other agents" links.
  list() {
    const animals = this.sim.state().agents.map((a) => ({ id: a.id, name: a.name, kind: 'animal', species: a.species, job: a.job, agentId: a.erc8004?.agentId || null }));
    const visitors = (this.visitors?.people() || []).map((v) => ({ id: v.id, name: v.name, kind: 'visitor', look: v.look, status: v.status, agentId: v.agentId || null }));
    return [...animals, ...visitors];
  }

  // Finds an agent by id, name or ERC-8004 agent id. Visitors are matched by name only if no animal has it.
  find(q) {
    const s = norm(q);
    if (!s) return null;
    const a = this.sim.state().agents.find((x) => x.id === s || norm(x.name) === s || String(x.erc8004?.agentId ?? '') === s);
    if (a) return { kind: 'animal', a };
    const v = (this.visitors?.people() || []).find((x) => norm(x.id) === s || norm(x.name) === s || String(x.agentId ?? '') === s);
    return v ? { kind: 'visitor', v } : null;
  }

  get(q) {
    const hit = this.find(q);
    if (!hit) return null;
    return hit.kind === 'animal' ? this.#animal(hit.a) : this.#visitor(hit.v);
  }

  #names() {
    const m = new Map();
    for (const a of this.sim.state().agents) m.set(a.id, a.name);
    return m;
  }

  // Trading partners from the relations log (pairs keyed "a|b"), best relationships first.
  #partners(id) {
    let pairs = {};
    try { pairs = this.relations?.summary().pairs || {}; } catch { return []; }
    const names = this.#names();
    return Object.entries(pairs)
      .filter(([k]) => k.split('|').includes(id))
      .map(([k, p]) => { const other = k.split('|').find((x) => x !== id) || id; return { id: other, name: names.get(other) || other, trades: p.trades || 0, trust: p.trust ?? null, rivalry: p.rivalry ?? null }; })
      .filter((p) => p.trades > 0)
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 6);
  }

  #animal(a) {
    const id = a.id;
    const reg = this.identity?.view?.().agents?.[id] || null;
    const agentId = a.erc8004?.agentId || reg?.agentId || null;
    let rep = null, cr = null;
    try { rep = this.reputation.agentView(id); } catch {}
    try { cr = this.credit.report(id); } catch {}
    const b = cr?.borrower;
    const deals = (this.sim.history || [])
      .filter((e) => e.type === 'trade' && e.url && (e.from === id || e.to === id))
      .slice(-12).reverse()
      .map((e) => ({ text: e.text, amount: e.amount, kind: e.kind || null, ts: e.ts, url: e.url }));
    return {
      schema: 'insula-passport/v1',
      kind: 'animal',
      id, name: a.name, species: a.species, job: a.job, role: a.role || null, mayor: Boolean(a.mayor),
      color: a.color, portrait: `/agents/${id}.png`,
      wallet: a.address || null, walletUrl: a.accountUrl || null,
      identity: { agentId, registry: IDENTITY_REGISTRY, chain: 'eip155:4663', url: reg?.url || tokenUrl(agentId), txUrl: reg?.txUrl || null, registeredAt: reg?.at || null },
      reputation: rep ? { score: rep.score, count: rep.count, raters: rep.raters, byTag: rep.byTag, onchain: rep.onchain, recent: (rep.recent || []).slice(0, 6) } : null,
      credit: b ? { grade: b.grade, score: b.score, loans: b.loans, borrowed: b.borrowed, repaidOnTime: b.repaidOnTime, repaidLate: b.repaidLate, defaulted: b.defaulted, unpaid: b.unpaid, repaymentRate: b.repaymentRate, open: (b.open || []).length } : null,
      holdings: { coins: Math.round(a.balance ?? 0), inv: a.inv },
      partners: this.#partners(id),
      deals,
      links: { api: `/api/passport/${id}`, credit: `/api/credit/${id}`, reputation: `/api/reputation/${id}` },
    };
  }

  #visitor(v) {
    const rules = this.visitors.summary().rules;
    const names = this.#names();
    const byName = new Map([...names].map(([k, n]) => [n.toLowerCase(), { id: k, name: n }]));
    const feed = (this.visitors.feed || []).filter((e) => e.visitor === v.id);
    // Who it dealt with: the name each deal line starts with ("Dot bought 12 fish from visitor V1 ...").
    const tally = new Map();
    for (const e of feed) {
      const first = String(e.text || '').split(' ')[0].toLowerCase();
      const who = e.text?.startsWith('The mainland') ? { id: 'mainland', name: 'The mainland' } : byName.get(first);
      if (!who) continue;
      const t = tally.get(who.id) || { ...who, trades: 0, volume: 0 };
      t.trades++; t.volume += e.amount || 0;
      tally.set(who.id, t);
    }
    const active = v.status === 'resident';
    return {
      schema: 'insula-passport/v1',
      kind: 'visitor',
      id: v.id, name: v.name, look: v.look, color: v.color, portrait: null,
      wallet: v.address, walletUrl: v.accountUrl,
      identity: { agentId: v.agentId || null, registry: IDENTITY_REGISTRY, chain: 'eip155:4663', url: tokenUrl(v.agentId), txUrl: null, registeredAt: null },
      residency: { status: v.status, joinedAt: v.joinedAt, joinedDay: v.joinedDay },
      bond: { amount: active ? rules.bond : 0, locked: active, slashed: v.slashed || 0, owedFees: v.owedFees || 0 },
      stats: v.stats,
      tradedToday: v.tradedToday, dailyCap: rules.dailyTradeCap,
      holdings: { inv: v.inv },
      partners: [...tally.values()].sort((a, b) => b.trades - a.trades).slice(0, 6),
      deals: feed.filter((e) => e.url).slice(-12).reverse().map((e) => ({ text: String(e.text || '').replace(`visitor ${v.id}`, v.name), amount: e.amount, kind: e.kind || null, ts: e.ts, url: e.url })),
      links: { api: `/api/passport/${encodeURIComponent(v.name.toLowerCase())}`, borders: '/borders' },
    };
  }
}
