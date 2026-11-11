// Credit history: every loan an animal has taken or made, as a report another app can read.
//
// The island's bank (Penny) lends coins to the other animals at a rate she negotiates; they repay with
// interest, get collected from when they're late, or default. Every loan and repayment is a real $INSULA
// transfer on Robinhood Chain. This turns that record into a credit report per animal, keyed to its ERC-8004
// identity, for agent-credit protocols (Priors, bond.credit and the like) or anyone pricing risk:
//   GET /api/credit           every animal's summary
//   GET /api/credit/:agent    one animal's full report (by id, name, ERC-8004 agent id or wallet)
// Each report carries a keccak256 of its own contents, so a lender can pin the exact version it relied on.
// Read-only: nothing here moves money.

import { keccak256, toUtf8Bytes } from 'ethers';
import { LOAN } from './agents.js';

const env = (k, d) => (typeof process !== 'undefined' && process.env?.[k]) || d;
const BASE = () => env('PUBLIC_URL', 'https://insulaworld.com').replace(/\/$/, '');
const iso = (t) => (t ? new Date(t).toISOString() : null);
const r2 = (n) => Math.round(n * 100) / 100;

// 0-100 from closed loans: repaid on time counts fully, repaid late (collected) half, a default counts 3x
// against. No closed loans means no score (no history), never a default score.
export function creditScore({ onTime, late, defaulted }) {
  const good = onTime + late * 0.5, n = onTime + late + defaulted;
  if (!n) return null;
  return Math.round((100 * good) / (good + (late * 0.5) + defaulted * 3));
}
const grade = (s) => (s == null ? 'NR' : s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F');

export class Credit {
  constructor(sim, identity, reputation) { this.sim = sim; this.identity = identity; this.reputation = reputation; }

  #who(id) {
    const a = this.sim.state().agents.find((x) => x.id === id);
    return a ? { id: a.id, name: a.name, species: a.species, job: a.job, role: a.role, wallet: a.address, erc8004AgentId: a.erc8004?.agentId ?? null } : { id };
  }

  #borrower(id) {
    const L = this.sim.loans.filter((l) => l.borrower === id);
    const closed = L.filter((l) => l.status === 'repaid' || l.status === 'defaulted');
    const onTime = L.filter((l) => l.status === 'repaid' && !l.late).length;
    const late = L.filter((l) => l.status === 'repaid' && l.late).length;
    const defaulted = L.filter((l) => l.status === 'defaulted');
    const open = L.filter((l) => l.status === 'open' || l.status === 'collecting');
    // Older loans (before outcomes were recorded per loan) can't tell on-time from collected; they count as on time
    // only if repaid. The island-wide tally (sim.credit) is the cross-check.
    const sum = (arr, f) => arr.reduce((t, l) => t + (f(l) || 0), 0);
    const score = creditScore({ onTime, late, defaulted: defaulted.length });
    return {
      loans: L.length, borrowed: Math.round(sum(L, (l) => l.principal)),
      repaidOnTime: onTime, repaidLate: late, defaulted: defaulted.length,
      unpaid: Math.round(sum(defaulted, (l) => l.owed - (l.paid || 0))),
      interestPaid: Math.round(sum(L.filter((l) => l.status === 'repaid'), (l) => (l.paid ?? l.owed) - l.principal)),
      averageLoan: L.length ? Math.round(sum(L, (l) => l.principal) / L.length) : 0,
      averageRatePct: L.length ? r2((100 * sum(L, (l) => l.rate)) / L.length) : 0,
      open: open.map((l) => ({ id: l.id, lender: l.lender, principal: l.principal, owed: l.owed, due: iso(l.due), tx: l.tx || null })),
      firstLoan: iso(L[0]?.issued), lastLoan: iso(L[L.length - 1]?.issued),
      repaymentRate: closed.length ? Math.round(((onTime + late) / closed.length) * 10000) / 10000 : null,
      score, grade: grade(score),
      islandTally: this.sim.credit?.[id] || { repaid: 0, defaulted: 0 },
    };
  }

  #lender(id) {
    const L = this.sim.loans.filter((l) => l.lender === id);
    if (!L.length) return null;
    const def = L.filter((l) => l.status === 'defaulted').length, closed = L.filter((l) => l.status === 'repaid' || l.status === 'defaulted').length;
    return {
      loansMade: L.length, lent: Math.round(L.reduce((t, l) => t + l.principal, 0)), borrowers: new Set(L.map((l) => l.borrower)).size,
      defaultRate: closed ? Math.round((def / closed) * 10000) / 10000 : null, defaults: def, openBook: Math.round(L.filter((l) => l.status === 'open').reduce((t, l) => t + l.owed, 0)),
    };
  }

  summary(id) {
    const b = this.#borrower(id);
    return { ...this.#who(id), score: b.score, grade: b.grade, loans: b.loans, repaidOnTime: b.repaidOnTime, repaidLate: b.repaidLate, defaulted: b.defaulted, open: b.open.length, report: `${BASE()}/api/credit/${id}` };
  }

  report(id) {
    const b = this.#borrower(id);
    const rep = (() => { try { return this.reputation.agentView(id); } catch { return null; } })();
    const recent = this.sim.loans.filter((l) => l.borrower === id).slice(-25).reverse().map((l) => ({
      id: l.id, lender: l.lender, principal: l.principal, ratePct: r2(l.rate * 100), owed: l.owed, issued: iso(l.issued), due: iso(l.due),
      status: l.status === 'repaid' ? (l.late ? 'repaid late (collected)' : 'repaid') : l.status, paid: l.paid ?? (l.status === 'repaid' ? l.owed : null),
      closed: iso(l.closed), loanTx: l.tx || null, repaymentTx: l.repayTx || null,
    }));
    const body = {
      schema: 'insula-credit-report/v1',
      subject: { ...this.#who(id), chain: `eip155:${this.identity.chainId?.() ?? 4663}`, identityRegistry: this.identity.view?.().registry || null },
      currency: { name: '$INSULA', note: 'All amounts are $INSULA coins, the island\'s money; every loan and repayment is a real token transfer on Robinhood Chain.' },
      terms: { loanTermSeconds: LOAN.termMs / 1000, maxLoan: LOAN.max, rate: 'negotiated per loan by the banker; ratePct is the total interest for the loan' },
      borrower: { ...b, recentLoans: recent },
      lender: this.#lender(id),
      reputation: rep?.count ? { score: rep.score, ratings: rep.count, credit: rep.byTag?.credit || null, defaults: rep.byTag?.default || null, registry: rep.registry } : null,
      method: 'score = 100 x (on-time + 0.5 x late) / (on-time + late + 3 x defaults); grade A >= 90, B >= 75, C >= 60, D >= 40, F below; NR = no closed loans yet. Late = collected by the bank after the due date. Per-loan outcomes and transaction links are recorded from Nov 11, 2026; earlier repayments count as on time.',
      generatedAt: new Date().toISOString(), source: `${BASE()}/api/credit/${id}`,
    };
    return { ...body, hash: keccak256(toUtf8Bytes(JSON.stringify(body))) };
  }

  all() {
    return { schema: 'insula-credit-summary/v1', generatedAt: new Date().toISOString(), agents: Object.keys(this.sim.agents).map((id) => this.summary(id)) };
  }
}
