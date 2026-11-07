// Relationships between inhabitants, counted from what they actually did: trades and their value, deals that
// fell through, building contracts, loans, repayments, defaults and thefts. Nothing here is made up; the
// profiles will show these numbers (and trust/rivalry scores worked out from them).
// Saved next to the island's save (data/world.relations.json). On first start it backfills from the
// decision files, so the history goes back to genesis.
import fs from 'node:fs';
import path from 'node:path';

const ITEMS = new Set(['ore', 'fish', 'wood', 'grain']);
const blank = () => ({ trades: 0, volume: 0, noDeals: 0, contracts: 0, contractVolume: 0, loans: 0, loanVolume: 0, repaid: 0, defaults: 0, thefts: 0, caught: 0, last: 0 });

export class Relations {
  constructor(file, chainId, sim) {
    this.file = file;
    this.sim = sim;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.data = saved && saved.chainId === chainId ? saved : { chainId, since: Date.now(), backfilled: false, pairs: {}, given: {} };
    this.dirty = false;
  }

  key(a, b) { return [a, b].sort().join('|'); }
  pair(a, b) { return (this.data.pairs[this.key(a, b)] ||= blank()); }
  // Directed counts (who buys from / pays whom), for "favorite trading partner".
  give(from, to, amount) {
    const g = (this.data.given[from] ||= {});
    const x = (g[to] ||= { n: 0, coins: 0 });
    x.n++; x.coins += Math.round(amount || 0);
  }
  isAgent(id) { return id && id !== 'bank' && !!this.sim.agents[id]; }

  record(e) {
    const at = e.ts || Date.now();
    if (e.type === 'trade' && this.isAgent(e.from) && this.isAgent(e.to)) {
      const p = this.pair(e.from, e.to), amt = Math.round(e.amount || 0);
      if (ITEMS.has(e.kind)) { p.trades++; p.volume += amt; this.give(e.from, e.to, amt); }
      else if (e.kind === 'contract') { p.contracts++; p.contractVolume += amt; this.give(e.from, e.to, amt); }
      else if (e.kind === 'loan') { p.loans++; p.loanVolume += amt; }
      else if (e.kind === 'repay') p.repaid++;
      else if (e.kind === 'default') p.defaults++;
      else return;
      p.last = at; this.dirty = true;
    } else if (e.type === 'story' && e.kind === 'theft' && this.isAgent(e.thief) && this.isAgent(e.victim)) {
      const p = this.pair(e.thief, e.victim);
      p.thefts++; if (e.caught) p.caught++;
      p.last = at; this.dirty = true;
    } else if (e.type === 'log' && /couldn.t agree/.test(e.text || '')) {
      const m = /^(\w+) and (\w+) couldn.t agree/.exec(e.text);
      const id = (name) => Object.values(this.sim.agents).find((a) => a.name === name)?.id;
      const a = m && id(m[1]), b = m && id(m[2]);
      if (a && b) { this.pair(a, b).noDeals++; this.pair(a, b).last = at; this.dirty = true; }
    }
  }

  // History from before this file existed, rebuilt from the decision files (one record per decision).
  backfill(dir) {
    if (this.data.backfilled) return 0;
    let n = 0;
    // A decision is written again each time it moves money, so keep only its last (fullest) copy.
    const recs = new Map();
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.id) recs.set(r.id, r);
      }
    }
    {
      for (const r of recs.values()) {
        if (!r.at || r.at >= this.data.since) continue;
        for (const t of r.txs || []) {
          if (!this.isAgent(t.from) || !this.isAgent(t.to)) continue;
          const text = t.text || '';
          const p = this.pair(t.from, t.to), amt = Math.round(t.amount || 0);
          if (/ bought \d+ (ore|fish|wood|grain) from /.test(text)) { p.trades++; p.volume += amt; this.give(t.from, t.to, amt); }
          else if (/ lent /.test(text)) { p.loans++; p.loanVolume += amt; }
          else if (/ repaid /.test(text)) p.repaid++;
          else if (/hired|to build|contract/i.test(text)) { p.contracts++; p.contractVolume += amt; this.give(t.from, t.to, amt); }
          else continue;
          p.last = Math.max(p.last, r.at); n++;
        }
        // A proposed trade that moved no money fell through.
        const m = /^(sell|buy):(\w+):(\w+)$/.exec(r.choice || '');
        if (m && !(r.txs || []).length && (r.steps || []).length > 1 && this.isAgent(m[3]) && this.isAgent(r.agent)) {
          this.pair(r.agent, m[3]).noDeals++; n++;
        }
      }
    }
    this.data.backfilled = true;
    this.dirty = true;
    return n;
  }

  save() {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  // Scores from the counts. Trust: deals that went through and loans paid back, against walk-aways and
  // defaults. Rivalry: walk-aways and thefts. Both 0-100.
  summary() {
    const out = {};
    for (const [k, p] of Object.entries(this.data.pairs)) {
      const good = p.trades + p.contracts * 2 + p.repaid * 3, bad = p.noDeals * 0.5 + p.defaults * 6 + p.thefts * 4;
      // Rivalry: how often they walk away from each other (as a share of their haggles, with a small prior so
      // a handful of haggles can't max it out), plus thefts with diminishing weight, plus defaults. Walk-aways
      // alone top out around 80, so only real wrongdoing pushes a pair to the top.
      const walkRate = p.noDeals / (p.trades + p.noDeals + 10);
      const rivalry = walkRate * 80 + 60 * (1 - Math.exp(-p.thefts / 3)) + Math.min(30, p.defaults * 10);
      out[k] = { ...p, trust: Math.round((100 * (good + 1)) / (good + bad + 2)), rivalry: Math.min(100, Math.round(rivalry)) };
    }
    return { since: this.data.since, backfilled: this.data.backfilled, pairs: out, given: this.data.given };
  }
}
