// One-time MAINNET setup, for launch day. Unlike the devnet setup, nothing is minted here:
// the money is your pump.fun coin, and the bank holds tokens you send it (part of your dev buy).
//
//   1. makes fresh mainnet wallets for the bank and each agent (.keys/); your devnet wallets and
//      chain-config.json are moved to .keys-devnet/ and chain-config.devnet.json, not deleted
//   2. reads your coin from the chain: classic SPL Token or Token-2022, and its decimals
//   3. checks the bank has SOL (it pays every fee) and enough of your coin
//   4. opens a token account for every agent and gives the founders their starting coins
//
// Needs in .env:  INSULA_MINT=<your coin's mint address>   MAINNET_RPC_URL=<a mainnet RPC, e.g. Helius>
// Safe to run again: it picks up where it stopped (e.g. after you fund the bank).

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getExtensionTypes, ExtensionType, getAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import { AGENT_DEFS, START_COINS, FOUNDERS } from './agents.js';
import { KEYS_DIR, CONFIG_PATH, loadKeypair } from './chain.js';

// SETUP_CLUSTER=devnet is only for rehearsing launch day against a devnet coin.
const CLUSTER = process.env.SETUP_CLUSTER || 'mainnet-beta';
const MIN_SOL = 0.05; // token accounts for 13 agents (~0.03 SOL rent) plus fees for the first days
const RPC = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MINT = (process.env.INSULA_MINT || process.argv[2] || '').trim();
const stop = (msg) => { console.log(`\n${msg}\n`); process.exit(1); };

if (!MINT) stop('Put your coin\'s mint address in .env as INSULA_MINT=... (from the pump.fun page), then run this again.');
let mint;
try { mint = new PublicKey(MINT); } catch { stop(`"${MINT}" is not a valid Solana address. Copy the mint (contract address) from pump.fun.`); }
if (!process.env.MAINNET_RPC_URL) console.log('Note: no MAINNET_RPC_URL in .env, using the public RPC. It rate-limits; use a Helius URL for the live world.');

const connection = new Connection(RPC, 'confirmed');

// 1. Keep the devnet setup safe, then start fresh mainnet wallets.
const old = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
if (old && old.cluster !== CLUSTER) {
  const backupKeys = path.resolve('.keys-devnet');
  if (fs.existsSync(backupKeys)) stop('.keys-devnet already exists. Move it somewhere safe first, so no wallets get mixed up.');
  fs.renameSync(KEYS_DIR, backupKeys);
  fs.renameSync(CONFIG_PATH, path.resolve('chain-config.devnet.json'));
  console.log('Moved the devnet wallets to .keys-devnet/ and chain-config.devnet.json.');
}
if (old?.cluster === CLUSTER && old.mint !== mint.toBase58()) {
  stop(`These mainnet wallets are already set up for a different coin (${old.mint}). Not touching them.`);
}
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

// 2. What kind of token is it?
const info = await connection.getAccountInfo(mint);
if (!info) stop(`No account at ${mint.toBase58()} on mainnet. Is that the right address, and has the coin launched?`);
let tokenProgram;
if (info.owner.equals(TOKEN_PROGRAM_ID)) tokenProgram = TOKEN_PROGRAM_ID;
else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
else stop(`${mint.toBase58()} is not a token mint (owned by ${info.owner.toBase58()}).`);
const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
const decimals = mintInfo.decimals;
console.log(`Coin: ${mint.toBase58()}`);
console.log(`Type: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'classic SPL Token'}, ${decimals} decimals, supply ${(Number(mintInfo.supply) / 10 ** decimals).toLocaleString()}`);
if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
  const ext = getExtensionTypes(mintInfo.tlvData);
  const names = ext.map((e) => ExtensionType[e]);
  console.log(`Extensions: ${names.join(', ') || 'none'}`);
  const blocking = ext.filter((e) => [ExtensionType.TransferHook, ExtensionType.NonTransferable, ExtensionType.ConfidentialTransferMint].includes(e));
  if (blocking.length) stop(`This coin uses ${blocking.map((e) => ExtensionType[e]).join(', ')}, which Insula can't trade with safely. Stopping.`);
  if (ext.includes(ExtensionType.PermanentDelegate)) console.log('Note: this coin has a permanent delegate (an authority that can move any holder\'s tokens). Trading still works.');
  if (ext.includes(ExtensionType.TransferFeeConfig)) console.log('Warning: this coin takes a fee on every transfer, so agents will receive slightly less than they are paid.');
}

const cfg = { cluster: CLUSTER, rpcUrl: RPC, mint: mint.toBase58(), decimals, tokenProgram: tokenProgram.toBase58() };
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

// 3. The bank needs SOL for fees and enough coins for the founders' starting money (plus a float for exports).
const founderTotal = FOUNDERS.reduce((t, id) => t + START_COINS[id], 0);
const sol = (await connection.getBalance(bank.publicKey)) / LAMPORTS_PER_SOL;
const bankAta = getAssociatedTokenAddressSync(mint, bank.publicKey, false, tokenProgram);
let bankCoins = 0;
try { bankCoins = Number((await getAccount(connection, bankAta, 'confirmed', tokenProgram)).amount) / 10 ** decimals; } catch {}
console.log(`\nBank wallet: ${bank.publicKey.toBase58()}`);
console.log(`  SOL:   ${sol} (needs at least ${MIN_SOL})`);
console.log(`  Coins: ${bankCoins.toLocaleString()} (founders need ${founderTotal.toLocaleString()}; send it most of your dev buy)`);
if (sol < MIN_SOL || bankCoins < founderTotal) {
  stop(`Send to the bank wallet above, from your own wallet:\n   - about 1 SOL (it pays every trade's fee: ~0.03 SOL a day at first, ~0.1 a day with all 13 agents)\n   - your $INSULA dev buy (or most of it)\nThen run this again.`);
}

// 4. A token account for every agent; founders get their starting coins now, later arrivals when they arrive.
const entries = Object.entries(agents);
for (let i = 0; i < entries.length; i += 4) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
  let n = 0;
  for (const [id, kp] of entries.slice(i, i + 4)) {
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram);
    if (await connection.getAccountInfo(ata)) continue;
    tx.add(createAssociatedTokenAccountIdempotentInstruction(bank.publicKey, ata, kp.publicKey, mint, tokenProgram));
    n++;
    if (FOUNDERS.includes(id)) {
      tx.add(createTransferCheckedInstruction(bankAta, mint, ata, bank.publicKey, BigInt(START_COINS[id]) * 10n ** BigInt(decimals), decimals, [], tokenProgram));
      console.log(`Founder ${id}: ${START_COINS[id]} coins -> ${kp.publicKey.toBase58()}`);
    } else {
      console.log(`Wallet ready for ${id} (arrives later) -> ${kp.publicKey.toBase58()}`);
    }
  }
  if (n) await sendAndConfirmTransaction(connection, tx, [bank], { commitment: 'confirmed' });
}
fs.writeFileSync(path.join(KEYS_DIR, 'setup-done'), new Date().toISOString());
console.log('\nMainnet setup done. Next: deploy with a fresh world (see HOSTING.md, "Launch day").');
