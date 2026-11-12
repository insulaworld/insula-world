// Open Borders safety watchdog (Robinhood Chain only). Every few minutes it checks the bond contract against
// what the island expects, and if anything is off it closes Open Borders at once: no new residents, no new
// offers, animals stop taking visitors' offers. Agents can always still leave and withdraw (that's in the
// contract, which the island can't stop). The alarm is saved, so a restart doesn't quietly reopen; it's
// cleared by deploying with OB_CLEAR_ALARM=1 after a look.
//
// It checks:
//  1. The contract holds at least what it owes (token balance >= totalBonded).
//  2. Every Slashed event was sent by this server (a slash it didn't send means the operator key is in use
//     somewhere else).
//  3. The operator is still the bank, and nobody has queued a new operator or payee (that would mean the owner
//     key was used; legitimate changes are rare, and the alarm is a prompt to check).
//  4. The bank still has ETH for visitors' gas.

import { Contract, Interface, getAddress, formatUnits, id as topicOf } from 'ethers';

const IFACE = new Interface([
  'function totalBonded() view returns (uint256)',
  'function operator() view returns (address)',
  'function pendingOperator() view returns (address)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'event Slashed(address indexed agent, address indexed to, uint256 amount, bytes32 indexed reason, string memo)',
  'event OperatorQueued(address indexed operator, uint256 activeAt)',
  'event OperatorChanged(address indexed operator)',
  'event PayeeQueued(address indexed payee, uint256 activeAt)',
  'event OwnershipTransferStarted(address indexed to)',
]);
const WATCHED = ['Slashed', 'OperatorQueued', 'OperatorChanged', 'PayeeQueued', 'OwnershipTransferStarted'].map((n) => IFACE.getEvent(n).topicHash);

export class BondWatch {
  constructor(payer, visitors, saved) {
    this.payer = payer;
    this.visitors = visitors;
    this.sim = visitors.sim;
    this.provider = payer.provider;
    this.bonds = new Contract(payer.bonds, IFACE, this.provider);
    this.token = new Contract(payer.token, IFACE, this.provider);
    this.bank = getAddress(payer.chain.addressOf('bank'));
    this.alarm = process.env.OB_CLEAR_ALARM === '1' ? null : saved?.alarm || null;
    this.from = saved?.from ?? null; // next block to scan for events
    this.owner = saved?.owner || null;
    this.lastCheck = null;
    this.lastOk = null;
    this.span = 50_000;
    if (this.alarm) this.visitors.closeForSafety(this.alarm.reason, false);
  }

  async #logs(from, to) {
    const out = [];
    for (let a = from; a <= to;) {
      const b = Math.min(to, a + this.span - 1);
      try {
        out.push(...(await this.provider.getLogs({ address: this.payer.bonds, topics: [WATCHED], fromBlock: a, toBlock: b })));
        a = b + 1;
        if (this.span < 1_000_000) this.span *= 2;
      } catch (e) {
        if (this.span <= 10) throw e;
        this.span = Math.max(10, Math.floor(this.span / 4));
      }
    }
    return out;
  }

  #trip(reason) {
    if (this.alarm) return;
    this.alarm = { reason, at: Date.now() };
    console.error(`[bond-watch] ALARM: ${reason}`);
    this.visitors.closeForSafety(reason, true);
  }

  async check() {
    this.lastCheck = Date.now();
    const [held, owed, operator, pending, owner, head, eth] = await Promise.all([
      this.token.balanceOf(this.payer.bonds), this.bonds.totalBonded(), this.bonds.operator(), this.bonds.pendingOperator(),
      this.bonds.owner(), this.provider.send('eth_blockNumber', []).then(Number), this.provider.getBalance(this.bank), // the real head, not ethers' cached one
    ]);
    if (held < owed) this.#trip(`the bond contract holds ${formatUnits(held, this.payer.decimals)} but owes ${formatUnits(owed, this.payer.decimals)}`);
    if (getAddress(operator) !== this.bank) this.#trip(`the bond contract's operator is ${operator}, not the island's bank`);
    if (pending !== '0x0000000000000000000000000000000000000000') this.#trip(`a new operator (${pending}) is queued on the bond contract`);
    if (this.owner && getAddress(owner) !== this.owner) this.#trip(`the bond contract's owner changed to ${owner}`);
    this.owner = getAddress(owner);
    if (this.from == null) this.from = Math.max(0, head - 5_000);
    if (head >= this.from) {
      for (const log of await this.#logs(this.from, head)) {
        const ev = IFACE.parseLog(log);
        if (ev.name === 'Slashed' && !this.payer.mySlashes.has(log.transactionHash.toLowerCase())) this.#trip(`a slash the island didn't send (${log.transactionHash})`);
        if (ev.name === 'OperatorQueued') this.#trip(`the owner queued a new operator (${ev.args.operator})`);
        if (ev.name === 'PayeeQueued') this.#trip(`the owner queued a new payee (${ev.args.payee})`);
        if (ev.name === 'OwnershipTransferStarted') this.#trip(`the owner started handing over ownership (to ${ev.args.to})`);
      }
      this.from = head + 1;
    }
    this.lowGas = eth < this.payer.gasWei * 20n;
    if (!this.alarm) this.lastOk = Date.now();
    return this.view();
  }

  start(ms = Number(process.env.OB_WATCH_MS || 180_000)) {
    const run = () => this.check().catch((e) => console.error('[bond-watch]', e.shortMessage || e.message));
    setTimeout(run, 5_000);
    setInterval(run, ms);
  }

  view() { return { ok: !this.alarm, alarm: this.alarm, lastCheck: this.lastCheck, lastOk: this.lastOk, lowGas: !!this.lowGas }; }
  save() { return { alarm: this.alarm, from: this.from, owner: this.owner }; }
}
