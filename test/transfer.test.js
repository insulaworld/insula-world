// Checks that a trade transaction really works against a local in-memory Solana runtime:
// the buyer's tokens move to the seller, the memo is accepted, and the bank pays the fee.
import { start } from 'solana-bankrun';
import { Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, unpackAccount,
} from '@solana/spl-token';
import { buildTransferTx } from '../server/chain.js';

const ctx = await start([], []);
const client = ctx.banksClient;
const bank = ctx.payer;
const felix = Keypair.generate(), bruno = Keypair.generate(), mint = Keypair.generate();
const DEC = 6;
const send = async (tx, signers) => {
  tx.recentBlockhash = ctx.lastBlockhash;
  tx.feePayer ??= bank.publicKey;
  tx.sign(...signers);
  await client.processTransaction(tx);
};
const rent = await client.getRent();
const ata = (o) => getAssociatedTokenAddressSync(mint.publicKey, o.publicKey);
await send(new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: bank.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(mint.publicKey, DEC, bank.publicKey, null),
  ...[bank, felix, bruno].map((o) => createAssociatedTokenAccountIdempotentInstruction(bank.publicKey, ata(o), o.publicKey, mint.publicKey)),
  createMintToInstruction(mint.publicKey, ata(felix), bank.publicKey, 1000n * 10n ** BigInt(DEC)),
  createMintToInstruction(mint.publicKey, ata(bank), bank.publicKey, 1000n * 10n ** BigInt(DEC)),
), [bank, mint]);

const balance = async (o) => Number(unpackAccount(ata(o), { ...(await client.getAccount(ata(o))), data: Buffer.from((await client.getAccount(ata(o))).data) }).amount) / 10 ** DEC;
const felixSolBefore = await client.getBalance(felix.publicKey);

// Felix (no SOL at all) pays Bruno 120 coins; the bank covers the fee.
await send(buildTransferTx({ mint: mint.publicKey, decimals: DEC, owner: felix.publicKey, to: bruno.publicKey, feePayer: bank.publicKey, amount: 120, memo: 'Insula World: Felix bought 5 ore from Bruno for 120 coins (24 each)' }), [bank, felix]);
// The bank pays Felix for an export.
await send(buildTransferTx({ mint: mint.publicKey, decimals: DEC, owner: bank.publicKey, to: felix.publicKey, feePayer: bank.publicKey, amount: 160, memo: 'Insula World: mainland bought 5 ore from Felix for 160 coins' }), [bank]);

const f = await balance(felix), b = await balance(bruno), k = await balance(bank);
console.log({ felix: f, bruno: b, bank: k, felixSol: Number(await client.getBalance(felix.publicKey)) / LAMPORTS_PER_SOL });
if (f !== 1040 || b !== 120 || k !== 840 || felixSolBefore !== 0n) throw new Error('balances wrong');
console.log('PASS: trades move real tokens, memos land, bank pays fees');
