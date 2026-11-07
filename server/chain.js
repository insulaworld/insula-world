// The money layer. Every trade between agents goes through here.
//  - "devnet": a real SPL token transfer on Solana devnet, with a memo describing the deal.
//  - "mock":   instant fake transfers, for building and testing without a chain.
// The central bank wallet pays all network fees, so it is the only wallet that needs SOL.

import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { START_COINS, FOUNDERS } from './agents.js';
import {
  getAssociatedTokenAddressSync, createTransferCheckedInstruction, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const KEYS_DIR = path.resolve('.keys');
export const CONFIG_PATH = path.resolve('chain-config.json');

export function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

function explorerTx(sig, cluster) {
  return `https://solscan.io/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
}
function explorerAccount(addr, cluster) {
  return `https://solscan.io/account/${addr}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
}

// Memos are plain ASCII, capped at 200 bytes: the memo program's cost grows with length and much
// faster for non-ASCII, so this keeps every trade well inside its compute limit.
function memoBytes(memo) {
  const ascii = memo.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '');
  return Buffer.from(ascii.slice(0, 200), 'ascii');
}

// One trade = one transaction: the token transfer plus a memo that says what the deal was,
// so anyone can read the story of the island on Solscan. The bank pays the network fee.
// tokenProgram: the classic SPL Token program, or Token-2022.
export function buildTransferTx({ mint, decimals, owner, to, feePayer, amount, memo, tokenProgram = TOKEN_PROGRAM_ID }) {
  const raw = BigInt(Math.round(amount * 10 ** decimals));
  const tx = new Transaction().add(
    // A tight compute limit (a 200-byte memo alone uses ~86k) lets a higher priority price cost less in total.
    ComputeBudgetProgram.setComputeUnitLimit({ units: 160_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.PRIORITY_MICROLAMPORTS || 10_000) }),
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, owner, false, tokenProgram),
      mint,
      getAssociatedTokenAddressSync(mint, to, false, tokenProgram),
      owner,
      raw,
      decimals,
      [],
      tokenProgram,
    ),
    new TransactionInstruction({
      keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: memoBytes(memo),
    }),
  );
  tx.feePayer = feePayer;
  return tx;
}

class MockChain {
  constructor(agentIds, saved) {
    this.mode = 'mock';
    this.cluster = 'mock';
    // Founders start funded; later arrivals get a welcome grant from the bank when they show up.
    this.balances = saved || Object.fromEntries(agentIds.map((id) => [id, FOUNDERS.includes(id) ? START_COINS[id] : 0]));
    this.balances.bank ??= 1_000_000;
    this.count = 0;
  }
  async init() {}
  addressOf(id) { return `MOCK-${id.toUpperCase()}`; }
  accountUrl() { return null; }
  balance(id) { return this.balances[id] ?? 0; }
  async transfer(from, to, amount, memo) {
    if (this.balance(from) < amount) throw new Error(`${from} is broke`);
    await new Promise((r) => setTimeout(r, 150));
    this.balances[from] -= amount;
    this.balances[to] = (this.balances[to] ?? 0) + amount;
    this.count++;
    return { sig: `mock-${Date.now().toString(36)}-${this.count}`, url: null, memo };
  }
}

class SolanaChain {
  constructor(agentIds) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    this.cluster = cfg.cluster;
    this.mode = cfg.cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
    this.family = 'solana';
    this.network = cfg.cluster === 'mainnet-beta' ? 'Solana' : `Solana ${cfg.cluster}`;
    this.explorerName = 'Solscan';
    this.buyUrl = cfg.buyUrl || null;
    this.tokenAddress = cfg.mint;
    this.tokenProgram = new PublicKey(cfg.tokenProgram || TOKEN_PROGRAM_ID.toBase58());
    this.decimals = cfg.decimals;
    this.mint = new PublicKey(cfg.mint);
    this.connection = new Connection(process.env.RPC_URL || cfg.rpcUrl, 'confirmed');
    this.wallets = { bank: loadKeypair(path.join(KEYS_DIR, 'bank.json')) };
    for (const id of agentIds) this.wallets[id] = loadKeypair(path.join(KEYS_DIR, `${id}.json`));
    this.balances = {};
    this.queue = Promise.resolve();
  }
  async init() {
    for (const id of Object.keys(this.wallets)) {
      const ata = getAssociatedTokenAddressSync(this.mint, this.wallets[id].publicKey, false, this.tokenProgram);
      try {
        const acc = await getAccount(this.connection, ata, 'confirmed', this.tokenProgram);
        this.balances[id] = Number(acc.amount) / 10 ** this.decimals;
      } catch {
        this.balances[id] = 0;
      }
    }
  }
  addressOf(id) { return this.wallets[id].publicKey.toBase58(); }
  accountUrl(id) { return explorerAccount(this.addressOf(id), this.cluster); }
  balance(id) { return this.balances[id] ?? 0; }

  // Transfers run one at a time so balances stay consistent.
  transfer(from, to, amount, memo) {
    const job = this.queue.then(() => this.#send(from, to, amount, memo));
    this.queue = job.catch(() => {});
    return job;
  }

  async #send(from, to, amount, memo) {
    if (this.balance(from) < amount) throw new Error(`${from} is broke`);
    const owner = this.wallets[from];
    const bank = this.wallets.bank;
    const tx = buildTransferTx({
      mint: this.mint,
      decimals: this.decimals,
      owner: owner.publicKey,
      to: this.wallets[to].publicKey,
      feePayer: bank.publicKey,
      amount,
      memo,
      tokenProgram: this.tokenProgram,
    });
    const signers = from === 'bank' ? [bank] : [bank, owner];
    const sig = await sendAndConfirmTransaction(this.connection, tx, signers, { commitment: 'confirmed' });
    this.balances[from] -= amount;
    this.balances[to] = (this.balances[to] ?? 0) + amount;
    return { sig, url: explorerTx(sig, this.cluster), memo };
  }
}

export async function createChain(agentIds, savedMock) {
  const wanted = (process.env.CHAIN || 'auto').toLowerCase();
  const ready = fs.existsSync(CONFIG_PATH);
  let chain;
  if (wanted === 'mock' || (wanted === 'auto' && !ready)) {
    chain = new MockChain(agentIds, savedMock);
  } else {
    if (!ready) throw new Error('No chain-config.json. Run "npm run setup" first, or start with CHAIN=mock.');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.family === 'evm') {
      const { EvmChain } = await import('./chain-evm.js');
      chain = new EvmChain(agentIds, cfg, KEYS_DIR);
    } else {
      chain = new SolanaChain(agentIds);
    }
  }
  await chain.init();
  return chain;
}
