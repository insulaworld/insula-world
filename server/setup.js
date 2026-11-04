// One-time devnet setup:
//   1. creates wallets for the central bank and each agent (saved in .keys/, never commit these)
//   2. gets devnet SOL for the bank (the bank pays every network fee)
//   3. creates a test token, mints the bank's "seed" supply, and gives each agent starting money
// On mainnet you would skip the mint step: the token is your pump.fun coin and the bank holds your dev buy.

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { AGENT_DEFS, START_COINS, FOUNDERS } from './agents.js';
import { KEYS_DIR, CONFIG_PATH, loadKeypair } from './chain.js';

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const DECIMALS = 6;
const SEED_SUPPLY = 30_000_000; // the bank's tokens (like ~3% of a 1B pump.fun supply)
// Each agent's starting coins come from START_COINS in agents.js (the banker starts with more).

const connection = new Connection(RPC, 'confirmed');
fs.mkdirSync(KEYS_DIR, { recursive: true });

function keypairFor(name) {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const bank = keypairFor('bank');
const agents = Object.fromEntries(AGENT_DEFS.map((a) => [a.id, keypairFor(a.id)]));
console.log(`Bank wallet: ${bank.publicKey.toBase58()}`);

let sol = (await connection.getBalance(bank.publicKey)) / LAMPORTS_PER_SOL;
if (sol < 0.2) {
  console.log('Requesting devnet SOL for the bank...');
  try {
    const sig = await connection.requestAirdrop(bank.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    sol = (await connection.getBalance(bank.publicKey)) / LAMPORTS_PER_SOL;
  } catch (e) {
    console.log(`\nThe devnet airdrop didn't work (${e.message}).`);
    console.log('Get free devnet SOL at https://faucet.solana.com for this address, then run "npm run setup" again:');
    console.log(`\n   ${bank.publicKey.toBase58()}\n`);
    process.exit(1);
  }
}
console.log(`Bank has ${sol} devnet SOL`);

let cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
let mint;
if (cfg?.mint) {
  mint = new (await import('@solana/web3.js')).PublicKey(cfg.mint);
  console.log(`Using existing test token ${cfg.mint}`);
} else {
  console.log('Creating the test token...');
  mint = await createMint(connection, bank, bank.publicKey, null, DECIMALS);
  const bankAta = await getOrCreateAssociatedTokenAccount(connection, bank, mint, bank.publicKey);
  await mintTo(connection, bank, mint, bankAta.address, bank, BigInt(SEED_SUPPLY) * 10n ** BigInt(DECIMALS));
  cfg = { cluster: 'devnet', rpcUrl: RPC, mint: mint.toBase58(), decimals: DECIMALS };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`Test token: ${cfg.mint}`);
}

// Give every agent (including the ones who arrive later) a token account.
// Founders get their starting money now; later arrivals get a welcome grant from the bank when they arrive.
const bankAta = getAssociatedTokenAddressSync(mint, bank.publicKey);
const entries = Object.entries(agents);
for (let i = 0; i < entries.length; i += 4) {
  const tx = new Transaction();
  for (const [id, kp] of entries.slice(i, i + 4)) {
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const exists = await connection.getAccountInfo(ata);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(bank.publicKey, ata, kp.publicKey, mint));
    if (!exists && FOUNDERS.includes(id)) {
      tx.add(createTransferCheckedInstruction(
        bankAta, mint, ata, bank.publicKey, BigInt(START_COINS[id]) * 10n ** BigInt(DECIMALS), DECIMALS,
      ));
      console.log(`Giving founder ${id} ${START_COINS[id]} coins -> ${kp.publicKey.toBase58()}`);
    } else if (!exists) {
      console.log(`Wallet ready for ${id} (arrives later) -> ${kp.publicKey.toBase58()}`);
    }
  }
  await sendAndConfirmTransaction(connection, tx, [bank]);
}
fs.writeFileSync(path.join(KEYS_DIR, 'setup-done'), new Date().toISOString());
console.log('\nSetup done. Start the world with: npm start');
