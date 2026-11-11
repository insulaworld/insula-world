// x402 payments for the Insula MCP server: a free daily allowance per client, then a small USDG price per call.
//
// x402 is the open standard for paying for an API call in stablecoins (HTTP 402 "Payment Required"). Over MCP
// (x402 v2, transport "mcp"): a call past the free allowance gets a tool result with isError and the payment
// terms; the client signs a USDG transferWithAuthorization (EIP-3009) for the price and retries with it in
// _meta["x402/payment"]; we verify it, run the tool, settle it on Robinhood Chain and return the receipt in
// _meta["x402/payment-response"]. The client never sends a transaction or needs gas: we broadcast the signed
// authorization (the bank wallet pays the gas), and the token contract only lets it move exactly the signed
// amount to our address, once.
//
// Off unless X402_PAY_TO is set. Settings: X402_PAY_TO (receiving address), X402_PRICE_USDG (default 0.01),
// X402_FREE_PER_DAY (default 100), X402_ASSET (default USDG on Robinhood Chain).

import fs from 'node:fs';
import { Contract, Interface, Signature, getAddress, isAddress, verifyTypedData, parseUnits, formatUnits } from 'ethers';

const env = (k, d) => (typeof process !== 'undefined' && process.env?.[k]) || d;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; // Global Dollar (Paxos) on Robinhood Chain, 6 decimals
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
];
const iface = new Interface(TOKEN_ABI);
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

export class X402 {
  constructor(sim, file) {
    this.sim = sim; this.file = file;
    const payTo = env('X402_PAY_TO', '');
    this.payTo = isAddress(payTo) ? getAddress(payTo) : null;
    this.asset = getAddress(env('X402_ASSET', USDG));
    this.decimals = Number(env('X402_DECIMALS', 6));
    this.priceText = env('X402_PRICE_USDG', '0.01');
    this.price = parseUnits(this.priceText, this.decimals);
    this.freePerDay = Math.max(0, Number(env('X402_FREE_PER_DAY', 100)));
    this.domain = { name: env('X402_TOKEN_NAME', 'Global Dollar'), version: env('X402_TOKEN_VERSION', '1') };
    this.usage = new Map(); this.day = today(); this.pending = new Set();
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    this.stats = { settled: saved.settled || 0, revenue: saved.revenue || '0', payers: saved.payers || 0, recent: saved.recent || [] };
    this.payerSet = new Set(saved.payerList || []);
  }

  on() { return !!(this.payTo && this.sim.chain?.family === 'evm' && this.sim.chain.provider && this.sim.chain.contractCall); }
  chainId() { return Number(this.sim.chain.provider?._network?.chainId ?? 4663); }
  network() { return `eip155:${this.chainId()}`; }

  // How many free calls this client has left today.
  #count(client) {
    if (today() !== this.day) { this.usage.clear(); this.day = today(); }
    return this.usage.get(client) || 0;
  }
  freeLeft(client) { return Math.max(0, this.freePerDay - this.#count(client)); }
  useFree(client) { this.usage.set(client, this.#count(client) + 1); if (this.usage.size > 50_000) this.usage.clear(); }

  requirements() {
    return {
      scheme: 'exact', network: this.network(), amount: this.price.toString(), asset: this.asset, payTo: this.payTo,
      maxTimeoutSeconds: 300, extra: { name: this.domain.name, version: this.domain.version, assetTransferMethod: 'eip3009' },
    };
  }
  required(tool, description, error) {
    const body = {
      x402Version: 2, error: error || `Free allowance used (${this.freePerDay} calls a day). This call costs ${this.priceText} USDG on Robinhood Chain.`,
      resource: { url: `mcp://tool/${tool}`, description, mimeType: 'application/json' },
      accepts: [this.requirements()],
    };
    return { isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  // Checks a PaymentPayload without moving anything. Returns { ok, error, auth, sig }.
  async verify(p) {
    const fail = (error) => ({ ok: false, error });
    if (!p || typeof p !== 'object') return fail('Missing payment payload.');
    if (p.x402Version !== 2) return fail('Unsupported x402Version (this server speaks x402 v2).');
    const a = p.accepted || {}, auth = p.payload?.authorization, sigHex = p.payload?.signature;
    if (a.scheme !== 'exact' || a.network !== this.network()) return fail(`Pay with scheme "exact" on ${this.network()}.`);
    if (!auth || typeof sigHex !== 'string') return fail('The payload needs an EIP-3009 authorization and its signature.');
    try {
      if (getAddress(a.asset) !== this.asset || getAddress(a.payTo) !== this.payTo) return fail('Wrong asset or recipient.');
      if (getAddress(auth.to) !== this.payTo) return fail('The authorization pays the wrong address.');
      const value = BigInt(auth.value), now = BigInt(Math.floor(Date.now() / 1000));
      if (value < this.price) return fail(`Amount too low: this call costs ${this.priceText} USDG.`);
      if (value > this.price * 100n) return fail('Amount far above the price; sign exactly the amount asked.');
      if (BigInt(auth.validAfter) > now) return fail('The authorization is not valid yet.');
      if (BigInt(auth.validBefore) < now + 6n) return fail('The authorization has expired (or expires within 6 seconds).');
      if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return fail('The nonce must be 32 bytes.');
      const key = `${getAddress(auth.from)}:${auth.nonce.toLowerCase()}`;
      if (this.pending.has(key)) return fail('This authorization is already being settled.');
      const msg = { from: getAddress(auth.from), to: getAddress(auth.to), value, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce };
      const signer = verifyTypedData({ ...this.domain, chainId: this.chainId(), verifyingContract: this.asset }, TYPES, msg, sigHex);
      if (getAddress(signer) !== msg.from) return fail('The signature does not match the payer.');
      const token = new Contract(this.asset, TOKEN_ABI, this.sim.chain.provider);
      const [used, bal] = await Promise.all([token.authorizationState(msg.from, msg.nonce), token.balanceOf(msg.from)]);
      if (used) return fail('This authorization was already used.');
      if (bal < value) return fail('The payer does not hold enough USDG.');
      const s = Signature.from(sigHex);
      const data = iface.encodeFunctionData('transferWithAuthorization', [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, s.v, s.r, s.s]);
      // Simulate the settlement from the wallet that will send it.
      await this.sim.chain.provider.call({ from: this.sim.chain.wallets?.bank?.address, to: this.asset, data });
      return { ok: true, msg, data, key };
    } catch (e) {
      return fail(`Payment check failed: ${e.shortMessage || e.reason || e.message}`.slice(0, 300));
    }
  }

  // Broadcasts the authorization (queued with the island's own payments; the bank wallet pays the gas).
  async settle(v) {
    this.pending.add(v.key);
    try {
      const r = await this.sim.chain.contractCall('bank', this.asset, v.data);
      if (r.receipt && r.receipt.status !== 1) throw new Error('settlement reverted');
      this.#record(v.msg, r.hash);
      return { success: true, transaction: r.hash, network: this.network(), payer: v.msg.from };
    } finally { this.pending.delete(v.key); }
  }

  #record(msg, hash) {
    this.stats.settled++;
    this.stats.revenue = (BigInt(this.stats.revenue) + msg.value).toString();
    if (!this.payerSet.has(msg.from)) { this.payerSet.add(msg.from); this.stats.payers = this.payerSet.size; }
    this.stats.recent = [{ tx: hash, payer: msg.from, usdg: formatUnits(msg.value, this.decimals), at: Date.now() }, ...this.stats.recent].slice(0, 20);
    try { fs.writeFileSync(this.file, JSON.stringify({ ...this.stats, payerList: [...this.payerSet] })); } catch (e) { console.error('[x402] save', e.message); }
  }

  view() {
    const ex = this.sim.chain?.explorer;
    return {
      on: this.on(), network: this.on() ? this.network() : null, asset: this.asset, payTo: this.payTo,
      priceUsdg: this.priceText, freeCallsPerDay: this.freePerDay,
      paidCalls: this.stats.settled, revenueUsdg: formatUnits(BigInt(this.stats.revenue), this.decimals), payers: this.stats.payers,
      recent: this.stats.recent.map((r) => ({ ...r, url: ex ? `${ex}/tx/${r.tx}` : null })),
    };
  }
}

function today() { return new Date().toISOString().slice(0, 10); }
