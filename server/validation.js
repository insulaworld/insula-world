// Outside validation (ERC-8004 Validation Registry): what independent validators have confirmed about Insula.
//
// Insula's own project agent (ERC8004_PROJECT_AGENT_ID, owned by the dev wallet) asks validators to check a
// claim with validationRequest(validator, agentId, requestURI, requestHash). The validator answers on-chain
// with validationResponse(requestHash, response 0-100, responseURI, responseHash, tag). This module only READS
// those answers from the chain (no keys, no transactions) so the site can show them, each linked to its
// transaction. First validator: Hey Research, which checks whether a project shipped in a time window.

import { AbiCoder, JsonRpcProvider, zeroPadValue, toBeHex, id as topicId } from 'ethers';

const env = (k, d) => (typeof process !== 'undefined' && process.env?.[k]) || d;
export const VAL_REGISTRY = env('ERC8004_VALIDATION_REGISTRY', '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58');
const REQUEST = topicId('ValidationRequest(address,uint256,string,bytes32)');
const RESPONSE = topicId('ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)');
const KNOWN = { '0xda0fa5d2a347425c072b4327a822db7782858fb7': { name: 'Hey Research', url: 'https://heyresearch.xyz', x: 'HeyResearch' } };
const abi = AbiCoder.defaultAbiCoder();

export class Validation {
  constructor(sim, identity) {
    this.sim = sim; this.identity = identity;
    this.items = []; this.status = 'off'; this.checkedAt = null;
    this.from = Number(env('ERC8004_VALIDATION_FROM_BLOCK', 111_843_000)); // just before Insula's first request
    this.chunk = 9_000_000; this.scanned = this.from - 1; this.reqs = []; this.resps = []; this.error = null;
  }

  // Read-only lookups go to the chain's public node: hosted nodes (the server's RPC_URL) often cap log lookups
  // at a few blocks. Override with ERC8004_VALIDATION_RPC.
  provider() {
    if (this._p) return this._p;
    const pub = { 4663: 'https://rpc.mainnet.chain.robinhood.com', 46630: 'https://rpc.testnet.chain.robinhood.com' };
    const cid = Number(this.identity.chainId?.() ?? this.sim.chain.provider?._network?.chainId ?? 0), url = env('ERC8004_VALIDATION_RPC', pub[cid]);
    this._p = url ? new JsonRpcProvider(url, cid || undefined, { staticNetwork: !!cid }) : this.sim.chain.provider;
    return this._p;
  }

  agentId() { return this.identity.projectId?.() || null; }
  enabled() { return !!this.agentId() && this.identity.enabled() && !!this.sim.chain?.provider; }

  start() {
    if (!this.enabled()) return;
    this.status = 'starting';
    const run = () => this.refresh().then(() => { this.error = null; }).catch((e) => { this.status = this.items.length ? 'live' : 'error'; this.error = String(e.shortMessage || e.message).slice(0, 200); console.error('[validation]', e.message); });
    setTimeout(run, 15_000);
    setInterval(run, Number(env('ERC8004_VALIDATION_TICK_MS', 5 * 60_000))).unref?.();
  }

  // Log lookups in chunks that shrink to fit whatever range limit the node has (public node: 10M blocks;
  // hosted nodes can be far tighter), remembered between runs.
  async #logs(topics, from, to) {
    const p = this.provider(); let out = [], a = from;
    while (a <= to) {
      const b = Math.min(to, a + this.chunk - 1);
      try { out = out.concat(await p.getLogs({ address: VAL_REGISTRY, topics, fromBlock: a, toBlock: b })); a = b + 1; }
      catch (e) { if (this.chunk <= 10) throw e; this.chunk = Math.max(10, Math.floor(this.chunk / 8)); }
    }
    return out;
  }

  async refresh() {
    const p = this.provider(), agent = zeroPadValue(toBeHex(BigInt(this.agentId())), 32);
    const latest = await p.getBlockNumber();
    if (latest > this.scanned) {
      const from = this.scanned + 1;
      const [reqs, resps] = [await this.#logs([REQUEST, null, agent], from, latest), await this.#logs([RESPONSE, null, agent], from, latest)];
      this.reqs.push(...reqs); this.resps.push(...resps); this.scanned = latest;
    }
    const reqs = this.reqs, resps = this.resps;
    const asked = {};
    for (const l of reqs) {
      try { asked[l.topics[3]] = { requestURI: abi.decode(['string'], l.data)[0], requestTx: l.transactionHash, requestBlock: l.blockNumber }; } catch { /* malformed */ }
    }
    const latestByReq = {};
    for (const l of resps) {
      try {
        const [response, responseURI, responseHash, tag] = abi.decode(['uint8', 'string', 'bytes32', 'string'], l.data);
        const validator = ('0x' + l.topics[1].slice(26)).toLowerCase();
        const item = {
          validator, ...(KNOWN[validator] || { name: null }), requestHash: l.topics[3], response: Number(response),
          responseURI, responseHash, tag, tx: l.transactionHash, block: l.blockNumber, ...(asked[l.topics[3]] || {}),
        };
        const prev = latestByReq[item.requestHash];
        if (!prev || prev.block < item.block) latestByReq[item.requestHash] = item; // validators may update an answer
      } catch { /* malformed */ }
    }
    const items = Object.values(latestByReq).sort((a, b) => b.block - a.block);
    const stamps = Object.fromEntries(this.items.map((x) => [x.tx, x.timestamp]));
    for (const it of items) if (stamps[it.tx]) it.timestamp = stamps[it.tx];
    // the claim's window, when the request says it (hey-ship-claim:1:<slug>:<since>:<until>)
    for (const it of items) {
      const m = /:(\d{9,11}):(\d{9,11})$/.exec(it.requestURI || '') || /since=(\d+).*until=(\d+)/.exec(it.responseURI || '');
      if (m) { it.since = Number(m[1]); it.until = Number(m[2]); }
      if (!it.timestamp) it.timestamp = (await p.getBlock(it.block).catch(() => null))?.timestamp ?? null;
    }
    this.items = items; this.status = 'live'; this.checkedAt = Date.now();
    this.pending = reqs.filter((l) => !latestByReq[l.topics[3]]).length;
  }

  view() {
    return { agentId: this.agentId(), registry: VAL_REGISTRY, status: this.status, error: this.error, scannedTo: this.scanned, checkedAt: this.checkedAt, pending: this.pending || 0, validations: this.items };
  }
}
