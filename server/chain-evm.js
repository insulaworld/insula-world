// The money layer on an EVM chain (Robinhood Chain). Every agent trade is a real ERC-20 transfer.
//  - The memo ("Insula #D123 why:<hash> | what happened") rides in the transaction's input data, right
//    after the standard transfer(to, amount) call. Tokens ignore the extra bytes; explorers show them
//    (Blockscout: Input → View as UTF-8), so the reasoning fingerprint is on-chain with every payment.
//  - On EVM chains the sender pays gas, so the bank keeps every agent topped up with a little ETH.
//    The bank pays its own gas for exports, grants and top-ups.

import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Wallet, Contract, Interface, Transaction, parseUnits, formatUnits, toUtf8Bytes, hexlify, concat } from 'ethers';

export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
];
const erc20 = new Interface(ERC20_ABI);

export const NETWORKS = {
  robinhood: { name: 'Robinhood', chainId: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', explorerName: 'Blockscout', mainnet: true },
  'robinhood-testnet': { name: 'Robinhood Testnet', chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com', explorerName: 'Explorer', mainnet: false },
  local: { name: 'Local EVM', chainId: 1337, rpcUrl: 'http://127.0.0.1:8545', explorer: '', explorerName: 'Explorer', mainnet: false },
};

export function loadEvmWallet(file, provider) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.privateKey) throw new Error(`${file} is not an EVM wallet (Solana wallets can't be used on Robinhood Chain).`);
  return new Wallet(j.privateKey, provider);
}

// Memos are plain ASCII, capped at 200 bytes (same as on Solana), so every payment's cost stays predictable.
export function memoBytes(memo) {
  const ascii = String(memo).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '');
  return toUtf8Bytes(ascii.slice(0, 200));
}

// transfer(to, amount) followed by the memo bytes.
export function transferData(to, raw, memo) {
  const call = erc20.encodeFunctionData('transfer', [to, raw]);
  return memo ? hexlify(concat([call, memoBytes(memo)])) : call;
}

// Reads the memo back out of a transfer's input data (for checks and tools).
export function memoFromInput(data) {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const extra = hex.slice(8 + 64 * 2);
  return extra ? Buffer.from(extra, 'hex').toString('utf8') : '';
}

export class EvmChain {
  constructor(agentIds, cfg, keysDir) {
    const net = NETWORKS[cfg.cluster] || {};
    this.cluster = cfg.cluster;
    this.network = cfg.networkName || net.name || cfg.cluster;
    this.mode = (cfg.mainnet ?? net.mainnet) ? 'mainnet' : 'testnet';
    this.family = 'evm';
    this.explorer = cfg.explorer ?? net.explorer ?? '';
    this.explorerName = cfg.explorerName || net.explorerName || 'Explorer';
    this.decimals = cfg.decimals;
    this.tokenAddress = cfg.token;
    this.symbol = cfg.symbol || 'INSULA';
    this.buyUrl = cfg.buyUrl || null;
    this.useMemo = cfg.memo !== false;
    this.provider = new JsonRpcProvider(process.env.RPC_URL || cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
    this.token = new Contract(cfg.token, ERC20_ABI, this.provider);
    this.wallets = { bank: loadEvmWallet(path.join(keysDir, 'bank.json'), this.provider) };
    for (const id of agentIds) this.wallets[id] = loadEvmWallet(path.join(keysDir, `${id}.json`), this.provider);
    this.balances = {};
    this.eth = {};
    this.nonces = {};
    this.queue = Promise.resolve();
    // Gas per transfer is estimated each time (on Arbitrum-style chains it includes the L1 posting
    // cost, which moves with Ethereum's gas price); this is the planning figure for gas top-ups.
    this.gasLimit = 150_000n;
    this.topups = 0;
    // Gas ceiling: above this, payments wait for gas to calm down (the island slows instead of burning
    // the bank's ETH). Robinhood Chain's floor is 0.02 gwei; it spiked ~25x during the September rush.
    this.maxGasWei = BigInt(Math.round(Number(process.env.MAX_GAS_GWEI || cfg.maxGasGwei || 0.25) * 1e9));
    this.gasWaits = 0;
  }

  async init() {
    await this.#readAll();
    // Self-healing: every few minutes, between payments, re-read every balance from the chain.
    this.resyncTimer = setInterval(() => this.resync(), Number(process.env.RESYNC_MS || 300_000));
    this.resyncTimer.unref?.();
  }

  async #readAll() {
    for (const [id, w] of Object.entries(this.wallets)) {
      this.balances[id] = Number(formatUnits(await this.token.balanceOf(w.address), this.decimals));
      this.eth[id] = await this.provider.getBalance(w.address);
    }
    this.nonces = {};
  }

  // Queued like a payment, so it never runs while a payment is in flight.
  resync() {
    const job = this.queue.then(async () => {
      const before = { ...this.balances };
      for (let i = 0; i < 3; i++) {
        try { await this.#readAll(); break; } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 3000)); }
      }
      const fixed = Object.keys(this.balances).filter((id) => Math.abs((before[id] ?? 0) - this.balances[id]) > 1e-9);
      if (fixed.length) console.warn(`[chain] resync corrected ${fixed.length} balance(s): ${fixed.map((id) => `${id} ${before[id]} -> ${this.balances[id]}`).join(', ')}`);
      this.resyncs = (this.resyncs || 0) + 1;
      return fixed;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  addressOf(id) { return this.wallets[id].address; }
  accountUrl(id) { return this.explorer ? `${this.explorer}/address/${this.addressOf(id)}` : null; }
  txUrl(hash) { return this.explorer ? `${this.explorer}/tx/${hash}` : null; }
  balance(id) { return this.balances[id] ?? 0; }
  get mint() { return null; }

  // Transfers run one at a time, so balances, nonces and gas top-ups stay consistent.
  transfer(from, to, amount, memo) {
    const job = this.queue.then(() => this.#send(from, to, amount, memo));
    // After a failed or uncertain payment, re-read the chain before the next payment goes out.
    this.queue = job.catch(async () => {
      if (!this.needResync) return;
      this.needResync = false;
      try { await this.#readAll(); console.warn('[chain] re-read all balances after a failed payment'); } catch {}
    });
    return job;
  }

  // What one transfer costs in gas right now (with headroom), in wei.
  // Arbitrum-style chains ignore tips, so we pay the base price with 2x headroom and no tip.
  async #txCost() {
    const now = Date.now();
    if (!this.fee || now - this.fee.at > 30_000) {
      const [fee, block] = await Promise.all([this.provider.getFeeData(), this.provider.getBlock('latest')]);
      const base = block?.baseFeePerGas ?? 0n;
      const quoted = fee.gasPrice ?? fee.maxFeePerGas ?? 1_000_000_000n;
      const price = quoted > base ? quoted : base;
      this.fee = { at: now, price, max: price * 2n + 1n };
    }
    return { price: this.fee.price, max: this.fee.max, cost: this.fee.max * this.gasLimit };
  }

  async #sendTx(id, req) {
    const w = this.wallets[id];
    if (this.nonces[id] === undefined) this.nonces[id] = await this.provider.getTransactionCount(w.address, 'pending');
    const nonce = this.nonces[id];
    const { max } = await this.#txCost();
    if (req.gasLimit === undefined) {
      try {
        const est = await this.provider.estimateGas({ from: w.address, to: req.to, data: req.data, value: req.value });
        req = { ...req, gasLimit: (est * 13n) / 10n + 5_000n };
      } catch (e) {
        throw new Error(`this payment would fail on-chain (${e.shortMessage || e.message})`);
      }
    }
    // Sign first, so the transaction hash is known before it's sent. If the connection drops while
    // sending or waiting, we look the payment up by hash instead of guessing it failed.
    const populated = await w.populateTransaction({ ...req, nonce, type: 2, maxFeePerGas: max, maxPriorityFeePerGas: 0n });
    const signed = await w.signTransaction(populated);
    const hash = Transaction.from(signed).hash;
    try {
      try { await this.provider.broadcastTransaction(signed); } catch (e) {
        if (!/ECONNRESET|ETIMEDOUT|socket|network|timeout|fetch failed|already known|nonce too low/i.test(String(e.message || e))) throw e;
      }
      this.nonces[id] = nonce + 1;
      const rcpt = await this.#receipt(hash);
      if (!rcpt) throw new Error(`payment not confirmed after 2 minutes: ${hash}`);
      if (rcpt.status !== 1) throw new Error(`transaction failed: ${hash}`);
      const spent = rcpt.gasUsed * (rcpt.gasPrice ?? 0n) + (req.value ?? 0n);
      this.eth[id] = (this.eth[id] ?? 0n) - spent;
      return rcpt.hash;
    } catch (e) {
      delete this.nonces[id]; // re-read the nonce next time, whatever happened
      this.needResync = true;
      throw e;
    }
  }

  // Waits for a receipt, riding out dropped connections (each lookup is retried on its own).
  async #receipt(hash) {
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      try {
        const r = await this.provider.getTransactionReceipt(hash);
        if (r) return r;
      } catch {}
      await new Promise((res) => setTimeout(res, 800));
    }
    return null;
  }

  // Before an agent pays, make sure it can afford the gas. Below ~10 transfers' worth, the bank sends
  // ~40 more (or less if the bank itself is running low: never more than an eighth of what it holds).
  async #ensureGas(id) {
    if (id === 'bank') return;
    const { cost } = await this.#txCost();
    if ((this.eth[id] ?? 0n) >= cost * 10n) return;
    const bankEth = this.eth.bank ?? 0n;
    let amount = cost * 40n;
    if (amount > bankEth / 8n) amount = bankEth / 8n;
    if (amount < cost * 3n) throw new Error('the bank is out of ETH for gas');
    await this.#sendTx('bank', { to: this.wallets[id].address, value: amount });
    this.eth[id] = (this.eth[id] ?? 0n) + amount;
    this.topups++;
  }

  // Holds payments while gas is above the ceiling; after 15 minutes it gives up on this one payment.
  async #waitForCheapGas() {
    for (let i = 0; i < 30; i++) {
      const { price } = await this.#txCost();
      if (price <= this.maxGasWei) return;
      if (i === 0) { this.gasWaits++; console.warn(`[chain] gas is ${Number(price) / 1e9} gwei (ceiling ${Number(this.maxGasWei) / 1e9}); holding payments until it drops.`); }
      await new Promise((r) => setTimeout(r, 30_000));
      this.fee = null;
    }
    throw new Error('gas stayed above the ceiling for 15 minutes');
  }

  async #send(from, to, amount, memo) {
    if (this.balance(from) < amount) throw new Error(`${from} is broke`);
    await this.#waitForCheapGas();
    await this.#ensureGas(from);
    const raw = parseUnits(Number(amount).toFixed(Math.min(6, this.decimals)), this.decimals);
    const data = transferData(this.wallets[to].address, raw, this.useMemo ? memo : null);
    const hash = await this.#sendTx(from, { to: this.tokenAddress, data });
    this.balances[from] -= amount;
    this.balances[to] = (this.balances[to] ?? 0) + amount;
    return { sig: hash, url: this.txUrl(hash), memo };
  }
}
