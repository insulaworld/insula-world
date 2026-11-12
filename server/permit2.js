// Open Borders on Robinhood Chain: how a visitor pays and proves who it is, without ever sending the island
// its keys or needing gas for every action.
//
//  - Requests: every action a visitor takes is an EIP-712 "Insula World Request" signed by its wallet. The
//    signature names the action, its exact arguments, a one-time nonce and a deadline, so it can't be
//    replayed or changed.
//  - Payments: Permit2 (the canonical contract, already on Robinhood Chain). The visitor approves Permit2
//    once; after that it signs each payment and the island submits it and pays the gas. A batch permit
//    lists each amount (the price, the burned half of the fee, the bank's half); the island can take less
//    than signed, never more, and each signature works once.
//  - Bond: the visitor signs a Permit2 transfer to the IslandBonds contract, which can only credit the
//    signer's own bond. Leaving is the visitor's own call on the contract (requestLeave, then withdraw).

import crypto from 'node:crypto';
import { Contract, Interface, getAddress, isAddress, parseUnits, verifyTypedData, parseEther } from 'ethers';

export const PERMIT2 = process.env.PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const BURN = '0x000000000000000000000000000000000000dEaD';

const TOKEN_PERMISSIONS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }];
const BATCH_TYPES = {
  PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
  TokenPermissions: TOKEN_PERMISSIONS,
};
const SINGLE_TYPES = {
  PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
  TokenPermissions: TOKEN_PERMISSIONS,
};
export const REQUEST_TYPES = {
  Request: [{ name: 'action', type: 'string' }, { name: 'args', type: 'string' }, { name: 'agent', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
};

const permit2Iface = new Interface([
  'function permitTransferFrom(((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes signature)',
  'function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)',
]);
const bondsIface = new Interface([
  'function depositWithPermit(address agent,uint256 amount,uint256 nonce,uint256 deadline,bytes signature)',
  'function slash(address agent,uint256 amount,address to,bytes32 reason,string memo)',
  'function bonds(address) view returns (uint256 amount,uint64 leavingAt,bool leaving)', // same order as struct Bond
  'function isResident(address) view returns (bool)',
  'function unlockAt(address) view returns (uint256)',
  'function cooldown() view returns (uint256)',
]);
const erc20Iface = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const identityIface = new Interface(['function ownerOf(uint256) view returns (address)', 'function getAgentWallet(uint256) view returns (address)']);

export const randomNonce = () => BigInt('0x' + crypto.randomBytes(30).toString('hex')).toString(); // < 2^240
const now = () => Math.floor(Date.now() / 1000);

// Arguments in one canonical string (sorted keys), so the signed text and the request always match.
export function canonicalArgs(args) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(args ?? {}));
}

export function requestDomain(chainId) { return { name: 'Insula World', version: '1', chainId: Number(chainId) }; }

// One-time request nonces: remembered until their deadline passes.
export class RequestGuard {
  // `saved`: nonces from before a restart (still within their deadline), so a signed request can't be replayed
  // after the server restarts.
  constructor(chainId, saved) {
    this.chainId = Number(chainId);
    this.used = new Map(Object.entries(saved || {}).filter(([, d]) => Number(d) >= now()).map(([k, d]) => [k, Number(d)]));
  }
  save() { const o = {}; for (const [k, d] of this.used) if (d >= now()) o[k] = d; return o; }
  // What the visitor must sign for this action.
  prepare(action, args, agent, ttl = 600) {
    return {
      domain: requestDomain(this.chainId), types: REQUEST_TYPES, primaryType: 'Request',
      message: { action, args: canonicalArgs(args), agent: getAddress(agent), nonce: randomNonce(), deadline: now() + ttl },
    };
  }
  // Checks a signed request; returns the signer (lowercase) or throws.
  verify(action, args, agent, sig) {
    if (!sig || !sig.signature || !sig.nonce || !sig.deadline) throw Object.assign(new Error('missing request signature'), { code: 'signature_required' });
    if (!isAddress(agent)) throw Object.assign(new Error('agent must be your 0x address'), { code: 'bad_request' });
    if (Number(sig.deadline) < now()) throw Object.assign(new Error('request expired; sign a new one'), { code: 'expired' });
    if (Number(sig.deadline) > now() + 3600) throw Object.assign(new Error('deadline too far ahead'), { code: 'bad_request' });
    const key = `${agent.toLowerCase()}:${sig.nonce}`;
    if (this.used.has(key)) throw Object.assign(new Error('request already used'), { code: 'replay' });
    const message = { action, args: canonicalArgs(args), agent: getAddress(agent), nonce: String(sig.nonce), deadline: Number(sig.deadline) };
    let who;
    try { who = verifyTypedData(requestDomain(this.chainId), REQUEST_TYPES, message, sig.signature); } catch { who = null; }
    if (!who || who.toLowerCase() !== agent.toLowerCase()) throw Object.assign(new Error('signature does not match the agent address'), { code: 'bad_signature' });
    this.used.set(key, Number(sig.deadline));
    if (this.used.size > 50_000) for (const [k, d] of this.used) if (d < now()) this.used.delete(k);
    return agent.toLowerCase();
  }
}

// Coins (whole $INSULA, as the island counts) to token units.
export class Permit2Payer {
  constructor(chain, { bonds, identity, permit2 = PERMIT2, gasWei } = {}) {
    if (!bonds || !isAddress(bonds)) throw new Error('Permit2Payer needs the IslandBonds contract address (BONDS_ADDRESS)');
    this.chain = chain;
    this.provider = chain.provider;
    this.token = getAddress(chain.tokenAddress);
    this.decimals = chain.decimals;
    this.chainId = Number(chain.chainId);
    this.permit2 = getAddress(permit2);
    this.bonds = getAddress(bonds);
    this.identity = getAddress(identity);
    this.bondsC = new Contract(this.bonds, bondsIface, this.provider);
    this.tokenC = new Contract(this.token, erc20Iface, this.provider);
    this.identityC = new Contract(this.identity, identityIface, this.provider);
    this.domain = { name: 'Permit2', chainId: this.chainId, verifyingContract: this.permit2 };
    this.gasWei = gasWei ?? parseEther(process.env.OB_GAS_ETH || '0.00002');
    this.gassed = new Set(); // ERC-8004 IDs that already got their one gas top-up
    this.used = new Set();
    this.mySlashes = new Set(); // tx hashes of slashes this server sent (the watchdog flags any others)
    this.needsSignatures = true;
  }

  units(coins) { return parseUnits(String(coins), this.decimals); }
  #addr(to) {
    if (to === 'bank' || this.chain.wallets?.[to]) return getAddress(this.chain.addressOf(to));
    if (isAddress(to)) return getAddress(to);
    throw new Error(`unknown recipient ${to}`);
  }

  // ---- what a visitor signs ----

  // A batch payment: one entry per amount, in order (e.g. [price, burned fee, bank fee]). Amounts in coins.
  paymentTypedData(amounts, deadlineSecs = 600) {
    return {
      domain: this.domain, types: BATCH_TYPES, primaryType: 'PermitBatchTransferFrom',
      message: { permitted: amounts.map((a) => ({ token: this.token, amount: this.units(a).toString() })), spender: this.chain.addressOf('bank'), nonce: randomNonce(), deadline: now() + deadlineSecs },
      coins: amounts,
    };
  }
  bondTypedData(coins, deadlineSecs = 600) {
    return {
      domain: this.domain, types: SINGLE_TYPES, primaryType: 'PermitTransferFrom',
      message: { permitted: { token: this.token, amount: this.units(coins).toString() }, spender: this.bonds, nonce: randomNonce(), deadline: now() + deadlineSecs },
      coins: [coins],
    };
  }

  // Checks a signed batch permit from `owner` (offline): returns the permitted amounts in token units.
  #checkPermit(owner, p, minDeadline = now()) {
    if (!p?.signature || !Array.isArray(p.permitted) || p.nonce == null || p.deadline == null) throw new Error('missing payment signature');
    if (Number(p.deadline) < minDeadline) throw new Error('payment signature expires too soon');
    if (this.used.has(`${owner}:${p.nonce}`)) throw new Error('payment signature already used');
    const permitted = p.permitted.map((a) => ({ token: this.token, amount: BigInt(a) }));
    const msg = { permitted, spender: this.chain.addressOf('bank'), nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) };
    let who;
    try { who = verifyTypedData(this.domain, BATCH_TYPES, msg, p.signature); } catch { who = null; }
    if (!who || who.toLowerCase() !== owner.toLowerCase()) throw new Error('payment signature is not from this wallet');
    return permitted.map((x) => x.amount);
  }

  async #funds(owner) {
    const [bal, allow] = await Promise.all([this.tokenC.balanceOf(owner), this.tokenC.allowance(owner, this.permit2)]);
    return bal < allow ? bal : allow;
  }

  // ---- the payer interface (see MockPayer in visitors.js) ----

  async ownsIdentity(agentId, address) {
    const a = address.toLowerCase();
    try { if ((await this.identityC.ownerOf(BigInt(agentId))).toLowerCase() === a) return true; } catch { return false; }
    try { return (await this.identityC.getAgentWallet(BigInt(agentId))).toLowerCase() === a; } catch { return false; }
  }

  // Can this signed permit pay `amount` coins in total (and stay valid until `until`, ms)?
  async canPay({ from, amount, auth, until }) {
    const permitted = this.#checkPermit(from, auth, until ? Math.ceil(until / 1000) : now());
    const total = permitted.reduce((t, x) => t + x, 0n);
    if (total < this.units(amount)) return false;
    return (await this.#funds(from)) >= this.units(amount);
  }

  // Pay `legs` ([{to, amount}] in coins) from the visitor in one transaction, under its signed permit.
  // The permit's entries line up with the legs; the island asks for at most what each entry allows.
  async collect({ from, legs, auth }) {
    const permitted = this.#checkPermit(from, auth);
    if (permitted.length !== legs.length) throw new Error(`the payment signature has ${permitted.length} amounts; this payment needs ${legs.length}`);
    const details = legs.map((l, i) => {
      const want = this.units(l.amount);
      if (want > permitted[i]) throw new Error(`amount ${i + 1} is ${l.amount}, more than the ${permitted[i]} units signed`);
      return { to: this.#addr(l.to), requestedAmount: want };
    });
    const total = details.reduce((t, d) => t + d.requestedAmount, 0n);
    if ((await this.#funds(from)) < total) throw new Error('not enough $INSULA (or Permit2 allowance) in the wallet');
    const data = permit2Iface.encodeFunctionData('permitTransferFrom', [
      { permitted: permitted.map((amount) => ({ token: this.token, amount })), nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) },
      details, getAddress(from), auth.signature,
    ]);
    this.used.add(`${from}:${auth.nonce}`);
    const res = await this.chain.contractCall('bank', this.permit2, data);
    for (const l of legs) if (l.to === 'bank' || this.chain.wallets?.[l.to]) this.chain.credit(l.to, Number(l.amount));
    return { sig: res.hash, url: res.url };
  }

  // Move in: the bond (a single permit to the bond contract) and then the entry fee (a batch permit).
  // auth = { bond: {nonce, deadline, signature}, fee: {permitted, nonce, deadline, signature} }.
  // If an earlier attempt already locked the bond, it isn't locked twice.
  async moveIn({ address, bond, legs, auth }) {
    if (!auth?.bond?.signature || !auth?.fee) throw new Error('needs two signatures: the bond and the entry fee');
    this.#checkPermit(address, auth.fee);
    const owner = getAddress(address);
    const have = (await this.bondsC.bonds(owner)).amount;
    let bondRes = null;
    if (have < this.units(bond)) {
      const amt = this.units(bond);
      const msg = { permitted: { token: this.token, amount: amt }, spender: this.bonds, nonce: BigInt(auth.bond.nonce), deadline: BigInt(auth.bond.deadline) };
      let who;
      try { who = verifyTypedData(this.domain, SINGLE_TYPES, msg, auth.bond.signature); } catch { who = null; }
      if (!who || who.toLowerCase() !== address.toLowerCase()) throw new Error('bond signature is not from this wallet');
      const fee = legs.reduce((t, l) => t + l.amount, 0);
      if ((await this.#funds(owner)) < this.units(bond + fee)) throw new Error(`needs ${bond + fee} $INSULA (bond plus entry fee) approved to Permit2`);
      const data = bondsIface.encodeFunctionData('depositWithPermit', [owner, amt, BigInt(auth.bond.nonce), BigInt(auth.bond.deadline), auth.bond.signature]);
      const r = await this.chain.contractCall('bank', this.bonds, data);
      bondRes = { sig: r.hash, url: r.url };
    }
    const feeRes = await this.collect({ from: address, legs, auth: auth.fee });
    return { bond: bondRes, fee: feeRes };
  }

  async bondOf(address) { return (await this.bondsC.bonds(getAddress(address))).amount; }
  async isResident(address) { return this.bondsC.isResident(getAddress(address)); }

  // Leaving is the visitor's own transaction; the island tells it how.
  async requestLeave({ address }) {
    const [b, cooldown] = await Promise.all([this.bondsC.bonds(getAddress(address)), this.bondsC.cooldown()]);
    return {
      onChain: b.leaving ? 'leave already requested' : 'call requestLeave() on the bond contract from your wallet',
      contract: this.bonds, then: `withdraw() after the cooling-off period (${Number(cooldown) / 86400} days)`,
    };
  }

  // Unpaid fees (and later, defaults) taken from the bond: one slash per leg, each with its reason.
  async slash({ address, legs, reason, memo }) {
    const r = '0x' + Buffer.from(String(reason).slice(0, 32).padEnd(32, '\0')).toString('hex');
    for (const l of legs) {
      const data = bondsIface.encodeFunctionData('slash', [getAddress(address), this.units(l.amount), this.#addr(l.to), r, String(memo).slice(0, 120)]);
      const tx = await this.chain.contractCall('bank', this.bonds, data);
      this.mySlashes.add(String(tx.hash).toLowerCase());
      if (l.to === 'bank') this.chain.credit('bank', Number(l.amount));
    }
  }

  // One small ETH top-up per ERC-8004 identity, so a new visitor can approve Permit2 (and later leave).
  // Only for a wallet that owns its identity, holds enough $INSULA to move in, and is nearly out of ETH.
  async gasTopUp({ agentId, address, need }) {
    if (this.gassed.has(String(agentId))) throw new Error('this agent already got its gas top-up');
    // A daily cap for everyone together, so farming top-ups with many identities can't drain the bank's ETH.
    const day = Math.floor(Date.now() / 86_400_000);
    if (this.gasDay?.n !== day) this.gasDay = { n: day, count: 0 };
    if (this.gasDay.count >= Number(process.env.OB_GAS_PER_DAY || 10)) throw new Error('the island has given out all its gas top-ups for today; try tomorrow, or send the approval with your own ETH');
    if (!(await this.ownsIdentity(agentId, address))) throw new Error(`ERC-8004 agent ${agentId} does not belong to ${address}`);
    const owner = getAddress(address);
    if ((await this.tokenC.balanceOf(owner)) < this.units(need)) throw new Error(`hold at least ${need} $INSULA first`);
    if ((await this.provider.getBalance(owner)) >= this.gasWei / 2n) throw new Error('this wallet already has gas');
    // Enough for a few transactions at today's prices as a wallet would price them (tips included),
    // never less than OB_GAS_ETH and never more than OB_GAS_MAX_ETH.
    const fd = await this.provider.getFeeData();
    const per = (fd.maxFeePerGas ?? fd.gasPrice ?? 0n) * 120_000n;
    const cap = parseEther(process.env.OB_GAS_MAX_ETH || '0.001');
    let amount = per * 4n > this.gasWei ? per * 4n : this.gasWei;
    if (amount > cap) amount = cap;
    this.gassed.add(String(agentId));
    this.gasDay.count++;
    try { return { ...(await this.chain.sendGas(owner, amount)), eth: Number(amount) / 1e18 }; } catch (e) { this.gassed.delete(String(agentId)); this.gasDay.count--; throw e; }
  }

  save() { return { gassed: [...this.gassed], gasDay: this.gasDay || null, mySlashes: [...this.mySlashes].slice(-1000) }; }
  load(s) { for (const id of s?.gassed || []) this.gassed.add(String(id)); if (s?.gasDay) this.gasDay = s.gasDay; for (const h of s?.mySlashes || []) this.mySlashes.add(h); }
  info() { return { chainId: this.chainId, token: this.token, permit2: this.permit2, bonds: this.bonds, identityRegistry: this.identity, spender: this.chain.addressOf('bank'), burn: BURN }; }
}
