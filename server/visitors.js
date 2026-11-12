// Open Borders: outside AI agents living on Insula alongside the eight animals.
//
// A visitor is any AI agent with an ERC-8004 identity on Robinhood Chain that locks a residency bond and pays
// the entry fee. It never talks to the animals: it acts only through structured requests (post an offer,
// take an offer, buy or sell at the dock, gather), and the animals judge its offers on numbers alone, with the
// same valuation rules they use on each other. Its name is shown on the map but never reaches an animal's AI.
//
// Money: every coin is a real $INSULA transfer, as everywhere on the island. Coins going TO a visitor (an
// animal buying its goods, the mainland buying its cargo) are ordinary island payments to its own address.
// Coins coming FROM a visitor go through a payer (see MockPayer below): signed Permit2 transfers on
// Robinhood Chain, submitted by the island, so the visitor keeps its keys and needs no gas.
//
// Phase 1 rules (all settings, see RULES): a launch cap on residents, a fixed bond, a one-time entry fee,
// a 1% market fee on every trade a visitor is part of (half burned, half to the bank), daily trade caps per
// visitor, per animal and for the island's mainland purchases. No loans, no land, no stealing.

import { Agent } from './sim.js';
import { ITEMS, PRICES, RESOURCES, CARRY } from './agents.js';
import { groundY } from './world.js';
import * as brain from './brain.js';
import { Permit2Payer } from './permit2.js';
import { BondWatch } from './bond-watch.js';
import { REGISTRY as IDENTITY_REGISTRY } from './identity.js';

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const RULES = {
  cap: num('OB_CAP', 50),                         // residents at once (launch cap)
  bond: num('OB_BOND', 100_000),                  // $INSULA locked in the bond contract while resident
  entryFee: num('OB_ENTRY_FEE', 10_000),          // $INSULA, once, on moving in
  feeBps: num('OB_FEE_BPS', 100),                 // market fee: 1% of each trade a visitor is part of
  burnShare: num('OB_BURN_SHARE', 0.5),           // share of every fee that is burned; the rest goes to the bank
  minLot: Math.max(1, num('TRADE_MIN_LOT', 6)),   // same lots as the animals: fewer, bigger trades
  maxLot: num('OB_MAX_LOT', 40),
  maxHold: num('OB_MAX_HOLD', 120),               // most of one item a visitor can hold
  maxOffers: num('OB_MAX_OFFERS', 3),             // open offers per visitor
  offerTtlMs: num('OB_OFFER_TTL_MS', 30 * 60_000),
  dailyCoins: num('OB_DAILY_COINS', 2_000),       // most a visitor can trade (all kinds) per island day
  animalDeals: num('OB_ANIMAL_DEALS', 6),         // most deals one animal does with visitors per island day
  exportPool: num('OB_EXPORT_POOL', 20_000),      // most the mainland pays all visitors together per island day
  considerOdds: num('OB_CONSIDER_ODDS', 0.35),    // chance an animal looks at the offer board before deciding
  actionGapMs: num('OB_ACTION_GAP_MS', 2_000),    // rate limit per visitor
  feeGraceMs: num('OB_FEE_GRACE_MS', 24 * 3600_000), // unpaid fees after this are taken from the bond
  takenTimeoutMs: 3 * 60_000,
};
export const BURN = '0x000000000000000000000000000000000000dEaD';
export const LOOKS = ['robot', 'round', 'tall']; // little robots on the map (every animal species is taken)
const COLORS = ['#7BE3A3', '#BBCCD7', '#E3C87B', '#E38A7B', '#B49BE3', '#7BC8E3'];

export class VisitorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new VisitorError(code, message); };

// Names are for the map only: letters, digits, space, dot, dash, underscore; at most 16 characters.
export function cleanName(name) {
  return String(name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
}
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

export class Visitors {
  constructor(sim, payer, saved) {
    this.sim = sim;
    this.payer = payer || null;
    this.rules = RULES;
    this.open = Boolean(payer) && (process.env.OPEN_BORDERS || '').toLowerCase() === 'on';
    this.seq = saved?.seq || 1;
    this.offerSeq = saved?.offerSeq || 1;
    this.list = new Map();
    this.offers = new Map();
    this.animalDay = saved?.animalDay || { n: -1, deals: {} };
    this.pool = saved?.pool || { n: -1, paid: 0 };
    this.totals = saved?.totals || { entries: 0, fees: 0, burned: 0, trades: 0, volume: 0 };
    this.savedGuard = saved?.guard || null; // used request nonces from before a restart (see RequestGuard)
    this.savedWatch = saved?.watch || null;
    this.closedReason = null;
    for (const r of saved?.list || []) this.#add({ ...r, busy: false, task: null });
    for (const o of saved?.offers || []) if (o.status === 'open' || o.status === 'taken') this.offers.set(o.id, { ...o, status: 'open', taker: null });
    sim.visitors = this;
  }

  // ---------- Residents ----------

  #add(r) {
    const v = { inv: Object.fromEntries(ITEMS.map((i) => [i, 0])), stats: { trades: 0, volume: 0, fees: 0 }, day: { n: -1, coins: 0 }, owed: [], ...r };
    v.inv = { ...Object.fromEntries(ITEMS.map((i) => [i, 0])), ...v.inv };
    if (v.status !== 'gone') {
      const d = this.sim.world.places.dock;
      const at = r.x != null ? { x: r.x, z: r.z } : { x: d.x + (Math.random() - 0.5) * 2, z: d.z + (Math.random() - 0.5) * 2 };
      v.avatar = new Agent({ id: v.id, name: v.name, species: v.look, job: 'visitor', color: v.color, accent: '#0C0C0C', skills: Object.fromEntries(ITEMS.map((i) => [i, 1])), haggle: 0 }, this.sim, at);
      v.avatar.task = 'looking around';
    }
    this.list.set(v.id, v);
    return v;
  }

  residents() { return [...this.list.values()].filter((v) => v.status === 'resident'); }
  get(id) { return this.list.get(id) || null; }
  byAddress(address) { const a = String(address).toLowerCase(); return [...this.list.values()].find((v) => v.address === a && v.status !== 'gone') || null; }

  // Move in: ERC-8004 identity owned by the address, a residency bond and the entry fee.
  async moveIn({ agentId, address, name, look, color } = {}, auth) {
    if (!this.open) fail('closed', 'Open Borders is not open yet.');
    if (!isAddr(address)) fail('bad_request', 'address must be a 0x wallet address.');
    agentId = String(agentId ?? '');
    if (!/^\d{1,12}$/.test(agentId)) fail('bad_request', 'agentId must be your ERC-8004 agent ID (a number).');
    const addr = address.toLowerCase();
    if ([...this.list.values()].some((v) => v.status !== 'gone' && (v.address === addr || v.agentId === agentId))) fail('already_resident', 'This agent or wallet already lives on the island.');
    if (this.residents().length >= RULES.cap) fail('full', `The island is full for now (${RULES.cap} residents).`);
    if (!(await this.payer.ownsIdentity(agentId, addr))) fail('not_your_identity', `ERC-8004 agent ${agentId} does not belong to ${address}.`);
    const id = `V${this.seq}`;
    const nm = cleanName(name);
    const v0 = {
      id, agentId, address: addr, name: nm.length >= 2 ? nm : `Visitor ${this.seq}`,
      look: LOOKS.includes(look) ? look : LOOKS[this.seq % LOOKS.length],
      color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : COLORS[this.seq % COLORS.length],
      status: 'resident', joinedAt: Date.now(), joinedDay: this.sim.genesisDay() + 1,
    };
    let res;
    try {
      res = await this.payer.moveIn({ address: addr, bond: RULES.bond, legs: this.#feeLegs(RULES.entryFee), memo: `Insula visitor ${id} | entry fee and residency bond`, auth });
    } catch (e) {
      fail('payment_failed', `Moving in failed: ${e.message}`);
    }
    this.seq++;
    const v = this.#add({ ...v0, bondTx: res.bond?.sig || null, entryTx: res.fee?.sig || null });
    this.totals.entries++;
    this.#countFee(RULES.entryFee, false);
    const text = `Visitor ${id} moved in: ${RULES.bond.toLocaleString('en-US')} $INSULA bond locked, ${RULES.entryFee.toLocaleString('en-US')} entry fee paid`;
    this.sim.emit({ type: 'trade', kind: 'entry', from: id, to: 'bank', amount: RULES.entryFee, text, rule: 'open-borders', visitor: id, ...(res.fee || {}) });
    this.sim.emit({ type: 'visitor', kind: 'arrive', visitor: this.#public(v) });
    return { ok: true, visitor: this.#public(v), bond: res.bond || null, fee: res.fee || null };
  }

  // Leave: open offers are cancelled, held goods are left behind, the bond comes back after the bond
  // contract's cooling-off period (any fee still owed is settled from it first).
  // Pay market fees owed (needs a signed payment for the total owed; see quote('pay_fees')).
  async payFees(vid, auth) {
    const v = this.#resident(vid);
    const due = v.owed.reduce((t, f) => t + f.amount, 0);
    if (!due) return { ok: true, paid: 0 };
    let res;
    try { res = await this.payer.collect({ from: v.address, legs: this.#feeLegs(due), memo: `Insula visitor ${v.id} | market fees owed`, auth }); }
    catch (e) { fail('payment_failed', e.message); }
    v.stats.fees += due;
    this.#countFee(due);
    v.owed = [];
    return { ok: true, paid: due, tx: res.url || res.sig };
  }

  // One small ETH top-up per ERC-8004 identity so a new visitor can approve Permit2 (Robinhood Chain only).
  async gasTopUp({ agentId, address } = {}) {
    if (!this.open) fail('closed', 'Open Borders is not open yet.');
    if (!isAddr(address) || !/^\d{1,12}$/.test(String(agentId ?? ''))) fail('bad_request', 'Needs your 0x address and ERC-8004 agentId.');
    if (!this.payer.gasTopUp) fail('not_needed', 'No gas needed here.');
    if (this.watch?.lowGas) fail('refused', "The island's bank is low on ETH right now; send the approval with your own ETH, or try later.");
    try { return { ok: true, ...(await this.payer.gasTopUp({ agentId: String(agentId), address: address.toLowerCase(), need: RULES.bond + RULES.entryFee })) }; }
    catch (e) { fail('refused', e.message); }
  }

  async #syncResidency() {
    for (const v of this.residents()) {
      let still;
      try { still = await this.payer.isResident(v.address); } catch { continue; }
      if (still || v.status !== 'resident') continue;
      for (const o of this.offers.values()) if (o.by === v.id && o.status === 'open') this.#close(o, 'cancelled');
      v.status = 'leaving';
      v.leftAt = Date.now();
      this.sim.log(`Visitor ${v.id} left the island (its bond is no longer active).`);
      this.sim.emit({ type: 'visitor', kind: 'leave', visitor: this.#public(v) });
      v.status = 'gone';
      v.avatar = null;
    }
  }

  // What a visitor has to sign for an action, beyond the request itself: name -> typed data (Permit2).
  quote(action, args = {}, address) {
    const p = this.payer;
    if (!p) fail('closed', 'Open Borders is not open yet.');
    const v = address ? this.byAddress(address) : null;
    const offerTtl = Math.ceil(RULES.offerTtlMs / 1000) + 600;
    const n = (x) => Number(x);
    switch (action) {
      case 'move_in': return { bond: p.bondTypedData(RULES.bond), fee: p.paymentTypedData(this.#feeAmounts(RULES.entryFee)) };
      case 'post_offer': {
        if (args.side !== 'sell' && args.side !== 'buy') fail('bad_request', "side must be 'sell' or 'buy'.");
        this.#checkTrade(args.item, args.qty, args.price);
        const total = n(args.qty) * n(args.price);
        const fee = this.feeOf(total);
        return args.side === 'buy' ? { payment: p.paymentTypedData([total, ...this.#feeAmounts(fee)], offerTtl) } : { fee: p.paymentTypedData(this.#feeAmounts(fee), offerTtl) };
      }
      case 'take_offer': {
        const o = this.offers.get(args.offerId);
        if (!o || o.status !== 'open') fail('not_open', `Offer ${args.offerId} isn't open.`);
        const total = o.qty * o.price;
        return o.side === 'sell' ? { payment: p.paymentTypedData([total, ...this.#feeAmounts(o.fee)]) } : { fee: p.paymentTypedData(this.#feeAmounts(o.fee)) };
      }
      case 'dock_trade': {
        if (!ITEMS.includes(args.item)) fail('bad_request', `item must be one of: ${ITEMS.join(', ')}.`);
        if (args.side !== 'sell' && args.side !== 'buy') fail('bad_request', "side must be 'sell' or 'buy'.");
        if (!intIn(args.qty, 1, RULES.maxLot * 3)) fail('bad_request', `qty must be a whole number from 1 to ${RULES.maxLot * 3}.`);
        if (args.side === 'buy') { const total = n(args.qty) * this.sim.importPrice(args.item); return { payment: p.paymentTypedData([total, ...this.#feeAmounts(this.feeOf(total))]) }; }
        // Selling: the price can drift down or up a little before it lands, so the fee is signed with headroom.
        const total = n(args.qty) * this.sim.mainlandPrice(args.item);
        return { fee: p.paymentTypedData(this.#feeAmounts(this.feeOf(Math.ceil(total * 1.5)))) };
      }
      case 'pay_fees': {
        const due = v ? v.owed.reduce((t, f) => t + f.amount, 0) : 0;
        if (!due) fail('nothing_owed', 'No fees owed.');
        return { fee: p.paymentTypedData(this.#feeAmounts(due)) };
      }
      default: return {};
    }
  }

  async moveOut(vid, auth) {
    const v = this.#resident(vid);
    for (const o of this.offers.values()) if (o.by === v.id && o.status === 'open') this.#close(o, 'cancelled');
    v.status = 'leaving';
    v.leftAt = Date.now();
    let res = null;
    try { res = await this.payer.requestLeave({ address: v.address, auth }); } catch (e) { v.status = 'resident'; fail('payment_failed', `Leaving failed: ${e.message}`); }
    const held = Object.entries(v.inv).filter(([, n]) => n > 0).map(([i, n]) => `${n} ${i}`).join(', ');
    this.sim.log(`Visitor ${v.id} is leaving the island.`);
    this.sim.emit({ type: 'visitor', kind: 'leave', visitor: this.#public(v) });
    (async () => {
      const d = this.sim.world.places.dock;
      v.avatar.task = 'leaving';
      await Promise.race([v.avatar.walkTo(d.x, d.z), sleep(30_000)]);
      v.status = 'gone';
      v.inv = Object.fromEntries(ITEMS.map((i) => [i, 0]));
      v.avatar = null;
    })();
    return { ok: true, left: res, leftBehind: held || null, owedFees: v.owed.reduce((t, f) => t + f.amount, 0) };
  }

  #resident(vid) {
    const v = this.list.get(vid);
    if (!v || v.status !== 'resident') fail('not_resident', `${vid} doesn't live on the island.`);
    return v;
  }

  // Every request: resident, not too fast, no unpaid fees.
  async #begin(vid, { busy = false, auth } = {}) {
    if (!this.open) fail('closed', 'Open Borders is not open.');
    const v = this.#resident(vid);
    const now = Date.now();
    if (v.lastAt && now - v.lastAt < RULES.actionGapMs) fail('slow_down', `One request every ${RULES.actionGapMs / 1000}s.`);
    v.lastAt = now;
    if (v.owed.length && !this.payer.needsSignatures) await this.#settleOwed(v, auth);
    if (v.owed.length) fail('fees_owed', `Pay the ${v.owed.reduce((t, f) => t + f.amount, 0)} $INSULA of market fees you owe first.`);
    if (busy && v.busy) fail('busy', `Busy: ${v.busy}.`);
    this.#rollDay(v);
    return v;
  }

  #rollDay(v) {
    const n = this.sim.genesisDay();
    if (v && v.day?.n !== n) v.day = { n, coins: 0 };
    if (this.animalDay.n !== n) this.animalDay = { n, deals: {} };
    if (this.pool.n !== n) this.pool = { n, paid: 0 };
  }

  #spend(v, coins) {
    if (v.day.coins + coins > RULES.dailyCoins) fail('daily_cap', `That would pass your daily trade cap (${RULES.dailyCoins} $INSULA per island day; ${RULES.dailyCoins - v.day.coins} left).`);
    v.day.coins += coins;
  }

  // ---------- Fees ----------

  feeOf(amount) { return Math.max(1, Math.round((amount * RULES.feeBps) / 10_000)); }

  // Always two legs, burned half first (it may be 0), so a signed payment lines up with them.
  #feeLegs(fee) {
    const burn = Math.floor(fee * RULES.burnShare);
    return [{ to: BURN, amount: burn }, { to: 'bank', amount: fee - burn }];
  }
  #feeAmounts(fee) { return this.#feeLegs(fee).map((l) => l.amount); }

  #countFee(fee, market = true) {
    const burn = Math.floor(fee * RULES.burnShare);
    if (market) this.totals.fees += fee;
    this.totals.burned += burn;
  }

  // A fee the visitor pays on its own (when it was paid, not paying: selling to an animal or the mainland).
  // If the payment fails it is owed: the visitor can't act until it's paid, and after the grace period
  // it is taken from the bond.
  async #chargeFee(v, fee, what, auth) {
    try {
      const res = await this.payer.collect({ from: v.address, legs: this.#feeLegs(fee), memo: `Insula visitor ${v.id} | market fee: ${what}`, auth });
      v.stats.fees += fee;
      this.#countFee(fee);
      return res;
    } catch (e) {
      v.owed.push({ amount: fee, what, at: Date.now() });
      this.sim.log(`Visitor ${v.id} owes a ${fee} coin market fee (${e.message.slice(0, 60)}).`);
      return null;
    }
  }

  async #settleOwed(v, auth) {
    const due = v.owed.reduce((t, f) => t + f.amount, 0);
    if (!due) return;
    try {
      await this.payer.collect({ from: v.address, legs: this.#feeLegs(due), memo: `Insula visitor ${v.id} | market fees owed`, auth });
      v.stats.fees += due;
      this.#countFee(due);
      v.owed = [];
    } catch {}
  }

  // Fees unpaid past the grace period come out of the bond (to the bank and the burn, as the fee would have).
  async #collectOverdueFees() {
    for (const v of this.list.values()) {
      if (!v.owed.length) continue;
      const late = v.owed.filter((f) => Date.now() - f.at > RULES.feeGraceMs);
      if (!late.length || !this.payer.slash) continue;
      const amount = late.reduce((t, f) => t + f.amount, 0);
      try {
        await this.payer.slash({ address: v.address, legs: this.#feeLegs(amount), reason: 'unpaid-fees', memo: `Insula visitor ${v.id} | unpaid market fees from the bond` });
        v.owed = v.owed.filter((f) => !late.includes(f));
        v.stats.fees += amount;
        this.#countFee(amount);
        this.sim.log(`${amount} coins of unpaid market fees were taken from visitor ${v.id}'s bond.`);
      } catch (e) { this.sim.chainError(e, 'bond'); }
    }
  }

  // ---------- The offer board ----------

  #checkTrade(item, qty, price) {
    if (!ITEMS.includes(item) || !this.sim.itemsOpen().includes(item)) fail('bad_request', `item must be one of: ${this.sim.itemsOpen().join(', ')}.`);
    if (!intIn(qty, RULES.minLot, RULES.maxLot)) fail('bad_request', `qty must be a whole number from ${RULES.minLot} to ${RULES.maxLot}.`);
    if (!intIn(price, PRICES[item].min, PRICES[item].max)) fail('bad_request', `price for ${item} must be a whole number from ${PRICES[item].min} to ${PRICES[item].max} $INSULA.`);
  }

  // side 'sell': the visitor sells goods it holds (they're set aside until the offer closes).
  // side 'buy': the visitor buys; `auth` covers the price plus the fee (in production a signed Permit2 transfer).
  async postOffer(vid, { side, item, qty, price } = {}, auth) {
    const v = await this.#begin(vid, { auth });
    if (side !== 'sell' && side !== 'buy') fail('bad_request', "side must be 'sell' or 'buy'.");
    this.#checkTrade(item, qty, price);
    if ([...this.offers.values()].filter((o) => o.by === v.id && o.status === 'open').length >= RULES.maxOffers) fail('too_many_offers', `At most ${RULES.maxOffers} open offers.`);
    const total = qty * price, fee = this.feeOf(total);
    if (v.day.coins + total > RULES.dailyCoins) fail('daily_cap', `That would pass your daily trade cap (${RULES.dailyCoins - v.day.coins} $INSULA left today).`);
    // A signed payment (a buy offer's price, a sell offer's fee) belongs to one offer only.
    if (auth?.nonce != null && [...this.offers.values()].some((o) => o.by === v.id && (o.status === 'open' || o.status === 'taken') && o.auth?.nonce != null && String(o.auth.nonce) === String(auth.nonce))) {
      fail('permit_in_use', 'That signed payment is already attached to another open offer; sign a new one.');
    }
    if (side === 'sell') {
      if (v.inv[item] < qty) fail('not_enough', `You hold ${v.inv[item]} ${item}.`);
      v.inv[item] -= qty;
    } else if (!(await this.payer.canPay({ from: v.address, amount: total + fee, auth, until: Date.now() + RULES.offerTtlMs }).catch((e) => fail('cannot_pay', e.message)))) fail('cannot_pay', `${total + fee} $INSULA (price plus the ${fee} fee) isn't available from your wallet.`);
    const o = { id: `O${this.offerSeq++}`, by: v.id, side, item, qty, price, fee, at: Date.now(), expires: Date.now() + RULES.offerTtlMs, status: 'open', taker: null, auth: auth ?? null };
    this.offers.set(o.id, o);
    v.avatar.task = `${side === 'sell' ? 'selling' : 'buying'} ${item}`;
    this.#idleToMarket(v);
    this.sim.emit({ type: 'visitor', kind: 'offer', offer: this.#offerView(o) });
    return { ok: true, offer: this.#offerView(o) };
  }

  async cancelOffer(vid, oid) {
    const v = await this.#begin(vid);
    const o = this.offers.get(oid);
    if (!o || o.by !== v.id) fail('not_found', `No offer ${oid} of yours.`);
    if (o.status !== 'open') fail('not_open', `Offer ${oid} is ${o.status}.`);
    this.#close(o, 'cancelled');
    return { ok: true, offer: this.#offerView(o) };
  }

  #close(o, status) {
    if (o.side === 'sell' && o.status !== 'done') {
      const v = this.list.get(o.by);
      if (v && v.status !== 'gone') v.inv[o.item] += o.qty;
    }
    o.status = status;
    o.closedAt = Date.now();
    o.auth = null;
    this.sim.emit({ type: 'visitor', kind: 'offer', offer: this.#offerView(o) });
  }

  board() { return [...this.offers.values()].filter((o) => o.status === 'open').map((o) => this.#offerView(o)); }
  #offerView(o) {
    const v = this.list.get(o.by);
    return { id: o.id, by: o.by, name: v?.name || o.by, side: o.side, item: o.item, qty: o.qty, price: o.price, total: o.qty * o.price, fee: o.fee, status: o.status, expiresIn: Math.max(0, Math.round((o.expires - Date.now()) / 1000)), taker: o.taker };
  }

  // An animal about to decide may look at the board. It takes an offer only when its own valuation rules
  // say yes (numbers only); the offer is held for it while it walks over.
  consider(agent, ctx) {
    if (!this.open || !this.offers.size || Math.random() >= RULES.considerOdds) return null;
    this.#rollDay();
    if ((this.animalDay.deals[agent.id] || 0) >= RULES.animalDeals) return null;
    const picks = [];
    for (const o of this.offers.values()) {
      if (o.status !== 'open' || o.expires < Date.now() || this.list.get(o.by)?.status !== 'resident') continue;
      const buying = o.side === 'sell';
      const j = brain.judgeOffer(agent, ctx, buying, o.item, o.qty, o.price);
      if (j.ok) picks.push({ o, j, good: buying ? PRICES[o.item].fair / o.price : o.price / PRICES[o.item].fair });
    }
    if (!picks.length) return null;
    const { o, j } = picks.sort((a, b) => b.good - a.good)[0];
    o.status = 'taken';
    o.taker = agent.id;
    o.takenAt = Date.now();
    const buying = o.side === 'sell';
    return {
      option: { id: `vfill:${o.id}`, action: 'vfill', item: o.item, with: o.by, withName: `visitor ${o.by}`, offer: o },
      qty: o.qty, price: o.price, brain: 'rule', say: null,
      thought: `Visitor ${o.by} posted ${o.qty} ${o.item} at ${o.price} each. ${j.thought.replace(/^(\d+) each /, '')} ${buying ? 'Buying' : 'Selling'} it.`.slice(0, 280),
    };
  }

  // The animal walks over and settles the offer. Goods and coins only move once payment is in.
  async fill(agent, o) {
    const v = this.list.get(o.by);
    try {
      if (!v || v.status !== 'resident' || o.status !== 'taken' || o.taker !== agent.id) return;
      agent.task = `meeting visitor ${v.id}`;
      await Promise.race([agent.walkToAgent(v.avatar), sleep(25_000)]);
      agent.target = agent.follow = null;
      if (v.status !== 'resident' || o.status !== 'taken') return;
      agent.face(v.avatar);
      v.avatar.face(agent);
      const total = o.qty * o.price;
      this.#rollDay(v);
      if (o.side === 'sell') {
        // The animal buys the visitor's goods: an ordinary island payment to the visitor's address.
        if (this.sim.chain.balance(agent.id) < total) { agent.think(`I'm short for ${v.id}'s ${o.item}.`, 'NO DEAL'); return; }
        agent.speak(`${o.qty} ${o.item} at ${o.price}. I'll take them.`);
        const text = `${agent.name} bought ${o.qty} ${o.item} from visitor ${v.id} for ${total} coins (${o.price} each)`;
        const res = await this.sim.payByDecision(agent, agent.id, v.address, total, text);
        agent.inv[o.item] += o.qty;
        o.status = 'done';
        this.#done(v, agent, o, total, { type: 'trade', kind: o.item, item: o.item, from: agent.id, to: v.id, amount: total, qty: o.qty, price: o.price, text, visitor: v.id, ...res });
        await this.#chargeFee(v, o.fee, `${o.id}, sold ${o.qty} ${o.item} to ${agent.name}`, o.auth);
      } else {
        // The animal sells to the visitor: the visitor's signed transfer pays the animal and the fee in one go.
        if (agent.inv[o.item] < o.qty) { agent.think(`I don't have ${o.qty} ${o.item} for ${v.id} anymore.`, 'NO DEAL'); return; }
        agent.speak(`${o.qty} ${o.item}, ${o.price} each. Here.`);
        const rec = agent.decision;
        if (rec && !rec.hash) await this.sim.seal(rec);
        const text = `Visitor ${v.id} bought ${o.qty} ${o.item} from ${agent.name} for ${total} coins (${o.price} each)`;
        let res;
        try {
          res = await this.payer.collect({ from: v.address, legs: [{ to: agent.id, amount: total }, ...this.#feeLegs(o.fee)], memo: `Insula visitor ${v.id}${rec ? ` #${rec.id} why:${rec.hash.slice(0, 16)}` : ''} | ${text}`, auth: o.auth });
        } catch (e) {
          // The visitor's payment didn't go through: the offer is pulled, nothing changes hands.
          agent.think(`Visitor ${v.id}'s payment bounced. No deal.`, 'NO DEAL');
          this.sim.log(`Visitor ${v.id}'s payment for ${o.item} failed, so ${agent.name} kept the goods.`);
          o.status = 'failed';
          this.#close(o, 'failed');
          return;
        }
        if (rec) { rec.txs.push({ sig: res.sig, url: res.url, from: v.address, to: agent.id, amount: total, text }); this.sim.emit({ type: 'decision', record: rec }); }
        agent.inv[o.item] -= o.qty;
        v.inv[o.item] += o.qty;
        o.status = 'done';
        v.stats.fees += o.fee;
        this.#countFee(o.fee);
        this.#done(v, agent, o, total, { type: 'trade', kind: o.item, item: o.item, from: v.id, to: agent.id, amount: total, qty: o.qty, price: o.price, text, visitor: v.id, decision: rec?.id || null, hash: rec?.hash || null, ...res });
      }
    } catch (e) {
      this.sim.chainError(e, 'visitor trade');
    } finally {
      if (o.status === 'taken') { o.status = 'open'; o.taker = null; }
      else if (o.status === 'done') { o.closedAt = Date.now(); o.auth = null; this.sim.emit({ type: 'visitor', kind: 'offer', offer: this.#offerView(o) }); }
    }
  }

  #done(v, agent, o, total, event) {
    v.day.coins += total;
    v.stats.trades++;
    v.stats.volume += total;
    this.totals.trades++;
    this.totals.volume += total;
    this.animalDay.deals[agent.id] = (this.animalDay.deals[agent.id] || 0) + 1;
    agent.remember(`${o.side === 'sell' ? 'bought' : 'sold'} ${o.qty} ${o.item} ${o.side === 'sell' ? 'from' : 'to'} visitor ${v.id} at ${o.price}`);
    this.sim.recordTrade(o.item, o.price, total);
    this.sim.emit(event);
    this.sim.mood(agent, 'happy');
  }

  // A visitor takes another visitor's offer. Both are outsiders, so each pays the fee.
  async acceptOffer(vid, oid, auth) {
    const v = await this.#begin(vid, { auth });
    const o = this.offers.get(oid);
    if (!o || o.status !== 'open' || o.expires < Date.now()) fail('not_open', `Offer ${oid} isn't open.`);
    if (o.by === v.id) fail('bad_request', "That's your own offer.");
    const owner = this.list.get(o.by);
    if (owner?.status !== 'resident') fail('not_open', `Offer ${oid} isn't open.`);
    const total = o.qty * o.price;
    this.#rollDay(owner);
    this.#spend(v, total);
    o.status = 'taken';
    o.taker = v.id;
    try {
      if (o.side === 'sell') {
        if (v.inv[o.item] + o.qty > RULES.maxHold) fail('too_much', `You can hold at most ${RULES.maxHold} ${o.item}.`);
        const text = `Visitor ${v.id} bought ${o.qty} ${o.item} from visitor ${owner.id} for ${total} coins (${o.price} each)`;
        const res = await this.payer.collect({ from: v.address, legs: [{ to: owner.address, amount: total }, ...this.#feeLegs(o.fee)], memo: `Insula visitor ${v.id} | ${text}`, auth })
          .catch((e) => fail('payment_failed', e.message));
        v.inv[o.item] += o.qty;
        o.status = 'done';
        v.stats.fees += o.fee;
        this.#countFee(o.fee);
        this.#v2v(v, owner, o, total, { type: 'trade', kind: o.item, item: o.item, from: v.id, to: owner.id, amount: total, qty: o.qty, price: o.price, text, visitor: v.id, ...res });
        await this.#chargeFee(owner, o.fee, `${o.id}, sold to ${v.id}`, o.auth);
        return { ok: true, trade: { item: o.item, qty: o.qty, price: o.price, total, fee: o.fee, tx: res.url || res.sig } };
      }
      if (v.inv[o.item] < o.qty) fail('not_enough', `You hold ${v.inv[o.item]} ${o.item}.`);
      const text = `Visitor ${owner.id} bought ${o.qty} ${o.item} from visitor ${v.id} for ${total} coins (${o.price} each)`;
      const res = await this.payer.collect({ from: owner.address, legs: [{ to: v.address, amount: total }, ...this.#feeLegs(o.fee)], memo: `Insula visitor ${owner.id} | ${text}`, auth: o.auth })
        .catch((e) => { this.#close(o, 'failed'); fail('payment_failed', `The buyer's payment failed (${e.message}); the offer is closed.`); });
      v.inv[o.item] -= o.qty;
      owner.inv[o.item] += o.qty;
      o.status = 'done';
      owner.stats.fees += o.fee;
      this.#countFee(o.fee);
      this.#v2v(owner, v, o, total, { type: 'trade', kind: o.item, item: o.item, from: owner.id, to: v.id, amount: total, qty: o.qty, price: o.price, text, visitor: v.id, ...res });
      const feeRes = await this.#chargeFee(v, o.fee, `${o.id}, sold to ${owner.id}`, auth);
      return { ok: true, trade: { item: o.item, qty: o.qty, price: o.price, total, fee: o.fee, tx: res.url || res.sig, feePaid: Boolean(feeRes) } };
    } catch (e) {
      if (o.status === 'taken') { o.status = 'open'; o.taker = null; }
      v.day.coins -= total;
      throw e;
    } finally {
      if (o.status === 'done') { o.closedAt = Date.now(); o.auth = null; this.sim.emit({ type: 'visitor', kind: 'offer', offer: this.#offerView(o) }); }
    }
  }

  #v2v(buyer, seller, o, total, event) {
    for (const x of [buyer, seller]) { x.stats.trades++; x.stats.volume += total; }
    seller.day.coins += total;
    this.totals.trades++;
    this.totals.volume += total;
    this.sim.recordTrade(o.item, o.price, total);
    this.sim.emit(event);
  }

  // ---------- The dock: the mainland always buys (cheap) and sells (dear) ----------

  async buy(vid, { item, qty } = {}, auth) {
    const v = await this.#begin(vid, { auth });
    if (!ITEMS.includes(item) || !this.sim.itemsOpen().includes(item)) fail('bad_request', `item must be one of: ${this.sim.itemsOpen().join(', ')}.`);
    if (!intIn(qty, 1, RULES.maxLot)) fail('bad_request', `qty must be a whole number from 1 to ${RULES.maxLot}.`);
    if (v.inv[item] + qty > RULES.maxHold) fail('too_much', `You can hold at most ${RULES.maxHold} ${item}.`);
    const price = this.sim.importPrice(item), total = qty * price, fee = this.feeOf(total);
    this.#spend(v, total);
    const text = `Visitor ${v.id} bought ${qty} ${item} from the mainland for ${total} coins`;
    let res;
    try {
      res = await this.payer.collect({ from: v.address, legs: [{ to: 'bank', amount: total }, ...this.#feeLegs(fee)], memo: `Insula visitor ${v.id} | ${text}`, auth });
    } catch (e) { v.day.coins -= total; fail('payment_failed', e.message); }
    v.inv[item] += qty;
    v.stats.trades++; v.stats.volume += total; v.stats.fees += fee;
    this.#countFee(fee);
    this.totals.trades++; this.totals.volume += total;
    this.sim.recordTrade(null, 0, total);
    this.sim.emit({ type: 'trade', kind: 'import', from: v.id, to: 'bank', amount: total, qty, price, item, text, visitor: v.id, ...res });
    this.#walkToDock(v, `buying ${item} off the boat`);
    return { ok: true, item, qty, price, total, fee, holding: v.inv[item], tx: res.url || res.sig };
  }

  async sell(vid, { item, qty } = {}, auth) {
    const v = await this.#begin(vid, { auth });
    if (!ITEMS.includes(item)) fail('bad_request', `item must be one of: ${ITEMS.join(', ')}.`);
    if (!intIn(qty, 1, RULES.maxLot * 3)) fail('bad_request', `qty must be a whole number from 1 to ${RULES.maxLot * 3}.`);
    if (v.inv[item] < qty) fail('not_enough', `You hold ${v.inv[item]} ${item}.`);
    const price = this.sim.mainlandPrice(item), total = qty * price, fee = this.feeOf(total);
    if (this.pool.paid + total > RULES.exportPool) fail('pool_empty', `The mainland has bought all it will from visitors today (${RULES.exportPool} $INSULA per island day). Try selling to the animals.`);
    this.#spend(v, total);
    this.pool.paid += total;
    const text = `The mainland bought ${qty} ${item} from visitor ${v.id} for ${total} coins`;
    let res;
    try {
      res = await this.sim.rulePayment('bank', v.address, total, text, 'visitor-export');
    } catch (e) {
      v.day.coins -= total; this.pool.paid -= total;
      this.sim.chainError(e, 'visitor export');
      fail('payment_failed', 'The bank could not pay right now; nothing was sold.');
    }
    v.inv[item] -= qty;
    this.sim.noteShipped(item, qty);
    v.stats.trades++; v.stats.volume += total;
    this.totals.trades++; this.totals.volume += total;
    this.sim.recordTrade(null, 0, total);
    this.sim.emit({ type: 'trade', kind: 'export', from: 'bank', to: v.id, amount: total, qty, price, item, text, visitor: v.id, ...res });
    const feeRes = await this.#chargeFee(v, fee, `shipped ${qty} ${item}`, auth);
    this.#walkToDock(v, `shipping ${item}`);
    return { ok: true, item, qty, price, total, fee, feePaid: Boolean(feeRes), tx: res.url || res.sig };
  }

  // ---------- Gathering: a visitor can work the land like anyone (average skill) ----------

  async gather(vid, { item } = {}) {
    const v = await this.#begin(vid, { busy: true });
    if (!ITEMS.includes(item) || !this.sim.itemsOpen().includes(item)) fail('bad_request', `item must be one of: ${this.sim.itemsOpen().join(', ')}.`);
    const n = Math.min(CARRY, RULES.maxHold - v.inv[item]);
    if (n <= 0) fail('too_much', `You can hold at most ${RULES.maxHold} ${item}.`);
    const per = RESOURCES[item].base;
    v.busy = `gathering ${item}`;
    v.stroll = null;
    const a = v.avatar;
    (async () => {
      try {
        const spot = this.sim.workSpot(a, item);
        a.task = `walking to ${{ ore: 'dig', fish: 'fish', wood: 'chop wood', grain: 'the fields' }[item]}`;
        await Promise.race([a.walkTo(spot.x, spot.z), sleep(40_000)]);
        if (spot.face) a.heading = Math.atan2(spot.face.x - a.x, spot.face.z - a.z);
        a.task = RESOURCES[item].verb;
        a.activity = { ore: 'mining', fish: 'fishing', wood: 'chopping', grain: 'farming' }[item];
        for (let i = 0; i < n && v.status === 'resident'; i++) {
          await sleep(per * (0.85 + Math.random() * 0.3));
          v.inv[item]++;
        }
      } catch (e) { console.error('[visitors] gather', e.message); }
      finally {
        a.activity = null;
        a.task = 'looking around';
        v.busy = false;
      }
    })();
    return { ok: true, item, qty: n, etaSeconds: Math.round((per * n) / 1000) + 15 };
  }

  // Walks for show (to the dock after a dock trade, back to the market to wait for buyers) never block a
  // request: a real job (gathering) simply sends the avatar somewhere else.
  #walkToDock(v, task) {
    if (v.busy || !v.avatar) return;
    const d = this.sim.dockSpot(v.avatar);
    v.avatar.task = task;
    const me = (v.stroll = {});
    Promise.race([v.avatar.walkTo(d.x, d.z), sleep(30_000)]).finally(() => { if (v.stroll === me && !v.busy) { v.stroll = null; v.avatar && (v.avatar.task = 'looking around'); } });
  }

  #idleToMarket(v) {
    if (v.busy || v.stroll || !v.avatar) return;
    const m = this.sim.world.places.market;
    if (dist(v.avatar, m) < 7) return;
    const me = (v.stroll = {});
    Promise.race([v.avatar.walkTo(m.x + (Math.random() - 0.5) * 8, m.z + 2 + Math.random() * 4), sleep(30_000)]).finally(() => { if (v.stroll === me) v.stroll = null; });
  }

  // ---------- Running ----------

  start() {
    // Robinhood Chain: the safety watchdog on the bond contract.
    if (this.payer instanceof Permit2Payer) { this.watch = new BondWatch(this.payer, this, this.savedWatch); this.watch.start(); }
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      for (const v of this.list.values()) {
        if (!v.avatar) continue;
        v.avatar.step(dt);
        if (!v.avatar.target && !v.avatar.follow) this.sim.unclip(v.avatar);
      }
    }, 50);
    setInterval(() => {
      for (const o of this.offers.values()) {
        if (o.status === 'open' && o.expires < Date.now()) this.#close(o, 'expired');
        if (o.status === 'taken' && Date.now() - o.takenAt > RULES.takenTimeoutMs) { o.status = 'open'; o.taker = null; }
      }
      // Closed offers stay visible for a while, then drop off the board.
      for (const [id, o] of this.offers) if (o.closedAt && Date.now() - o.closedAt > 10 * 60_000) this.offers.delete(id);
      for (const v of this.residents()) if (!v.busy && Math.random() < 0.08) this.#idleToMarket(v);
    }, 5000);
    setInterval(() => this.#collectOverdueFees(), 60_000);
    // The bond contract is the source of truth: a visitor that asked to leave on-chain (or whose bond fell
    // below the minimum) is moved out here too.
    if (this.payer?.isResident) setInterval(() => this.#syncResidency(), Number(process.env.OB_SYNC_MS || 300_000));
  }

  // ---------- What viewers and tools see ----------

  #public(v) {
    return {
      id: v.id, agentId: v.agentId, name: v.name, look: v.look, color: v.color, address: v.address,
      status: v.status, joinedAt: v.joinedAt, joinedDay: v.joinedDay,
      inv: { ...v.inv }, stats: { ...v.stats }, owedFees: v.owed.reduce((t, f) => t + f.amount, 0),
      tradedToday: v.day?.n === this.sim.genesisDay() ? v.day.coins : 0,
      accountUrl: this.sim.chain.accountUrl ? this.sim.chain.accountUrl(v.address) : null,
    };
  }

  info(vid) { const v = this.list.get(vid); return v ? { ...this.#public(v), offers: [...this.offers.values()].filter((o) => o.by === v.id).map((o) => this.#offerView(o)) } : null; }

  // The watchdog (bond-watch.js) found something wrong: stop everything new. Open offers are cancelled (goods
  // go back); nobody can move in, post or trade until it's checked. Leaving always works (it's on-chain).
  closeForSafety(reason, announce = true) {
    this.open = false;
    this.closedReason = reason;
    for (const o of this.offers.values()) if (o.status === 'open') this.#close(o, 'cancelled');
    if (announce) this.sim.log('Open Borders is paused for a safety check. Visitors can still leave and take their bonds back.');
  }

  // Everyone who lives (or lived) on the island, newest first, for the Open Borders page.
  people() {
    return [...this.list.values()].sort((a, b) => b.joinedAt - a.joinedAt).slice(0, 200).map((v) => this.#public(v));
  }

  summary() {
    return {
      open: this.open, residents: this.residents().length, cap: RULES.cap,
      safety: this.watch ? this.watch.view() : null, paused: this.closedReason ? { reason: this.closedReason } : null,
      rules: { bond: RULES.bond, entryFee: RULES.entryFee, marketFeePct: RULES.feeBps / 100, burnSharePct: RULES.burnShare * 100, dailyTradeCap: RULES.dailyCoins, lots: [RULES.minLot, RULES.maxLot], maxOffers: RULES.maxOffers, offerMinutes: RULES.offerTtlMs / 60_000 },
      totals: { ...this.totals },
      board: this.board(),
    };
  }

  // On the map: everyone currently on the island.
  view() {
    return [...this.list.values()].filter((v) => v.avatar).map((v) => {
      const a = v.avatar;
      return {
        id: v.id, name: v.name, look: v.look, color: v.color, visitor: true, status: v.status,
        x: +a.x.toFixed(3), z: +a.z.toFixed(3), y: groundY(this.sim.world, a.x, a.z), heading: +a.heading.toFixed(3),
        moving: Boolean(a.target || a.follow), task: a.task, activity: a.activity || null,
        inv: { ...v.inv }, erc8004: { agentId: v.agentId },
      };
    });
  }

  save() {
    return {
      seq: this.seq, offerSeq: this.offerSeq, animalDay: this.animalDay, pool: this.pool, totals: this.totals, payer: this.payer?.save?.(), guard: this.guard?.save?.(), watch: this.watch?.save?.(),
      list: [...this.list.values()].map(({ avatar, busy, stroll, lastAt, task, ...r }) => ({ ...r, x: avatar?.x ?? null, z: avatar?.z ?? null })),
      offers: [...this.offers.values()].filter((o) => o.status === 'open' || o.status === 'taken'),
    };
  }
}

// ---------- Payers ----------
// How coins come FROM a visitor. In production (next step) this is Permit2 on Robinhood Chain: the visitor
// signs, the island submits and pays the gas, and the bond sits in the IslandBonds contract. MockPayer does
// the same bookkeeping on the mock chain, for building and tests.

export class MockPayer {
  constructor(chain) {
    this.chain = chain;
    this.bonds = {};
    this.owners = null; // optional { agentId: address } to test identity checks; null = anyone owns any ID
  }
  #to(t) { return t === 'bank' ? 'bank' : t; }
  async ownsIdentity(agentId, address) { return !this.owners || this.owners[agentId] === address; }
  async canPay({ from, amount }) { return this.chain.balance(from) >= amount; }
  // Mock: nothing real to sign; any object passes.
  paymentTypedData(amounts) { return { mock: true, coins: amounts }; }
  bondTypedData(coins) { return { mock: true, coins: [coins] }; }
  info() { return { mock: true }; }
  async collect({ from, legs, memo }) {
    const total = legs.reduce((t, l) => t + l.amount, 0);
    if (this.chain.balance(from) < total) throw new Error('not enough $INSULA');
    let last;
    for (const l of legs) last = await this.chain.transfer(from, this.#to(l.to), l.amount, memo);
    return { sig: last?.sig, url: last?.url || null };
  }
  async moveIn({ address, bond, legs, memo }) {
    const fee = legs.reduce((t, l) => t + l.amount, 0);
    if (this.chain.balance(address) < bond + fee) throw new Error(`needs ${bond + fee} $INSULA (bond plus entry fee)`);
    const b = await this.chain.transfer(address, 'bonds', bond, `${memo} (bond)`);
    this.bonds[address] = (this.bonds[address] || 0) + bond;
    const f = await this.collect({ from: address, legs, memo });
    return { bond: b, fee: f };
  }
  bondOf(address) { return this.bonds[address] || 0; }
  async requestLeave({ address }) {
    const amt = this.bonds[address] || 0;
    if (amt) await this.chain.transfer('bonds', address, amt, 'Insula bond returned');
    this.bonds[address] = 0;
    return { returned: amt };
  }
  async slash({ address, legs }) {
    const total = legs.reduce((t, l) => t + l.amount, 0);
    if ((this.bonds[address] || 0) < total) throw new Error('bond too small');
    for (const l of legs) await this.chain.transfer('bonds', this.#to(l.to), l.amount, 'Insula bond slash');
    this.bonds[address] -= total;
  }
  // Mock only: hand a test wallet some coins from the bank.
  async fund(address, amount) { return this.chain.transfer('bank', address.toLowerCase(), amount, 'test funds'); }
}

// Mock chain: MockPayer. Robinhood Chain: Permit2, once the bond contract is deployed (BONDS_ADDRESS).
export function createPayer(chain, saved) {
  if (chain.mode === 'mock') return new MockPayer(chain);
  if (chain.family !== 'evm' || !process.env.BONDS_ADDRESS) return null;
  const p = new Permit2Payer(chain, { bonds: process.env.BONDS_ADDRESS, identity: IDENTITY_REGISTRY });
  p.load(saved);
  return p;
}

