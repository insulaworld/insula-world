// Rehearsal helper: makes a Token-2022 coin on devnet shaped like a pump.fun coin (metadata pointer +
// on-mint metadata, 6 decimals, 1B supply), minted to a "dev" wallet. Usage: node test/make-2022-coin.mjs <payer.json> <devWallet.json>
import fs from 'node:fs';
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID as P, ExtensionType, getMintLen, LENGTH_SIZE, TYPE_SIZE, createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
const c = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = load(process.argv[2]), dev = load(process.argv[3]), mint = Keypair.generate();
const meta = { mint: mint.publicKey, name: 'Insula Rehearsal', symbol: 'INSR', uri: 'https://example.com/m.json', additionalMetadata: [], updateAuthority: payer.publicKey };
const len = getMintLen([ExtensionType.MetadataPointer]);
const full = len + TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
const ata = getAssociatedTokenAddressSync(mint.publicKey, dev.publicKey, false, P);
await sendAndConfirmTransaction(c, new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await c.getMinimumBalanceForRentExemption(full), programId: P }),
  createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, P),
  createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, P),
  createInitializeInstruction({ programId: P, metadata: mint.publicKey, updateAuthority: payer.publicKey, mint: mint.publicKey, mintAuthority: payer.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri }),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, dev.publicKey, mint.publicKey, P),
  createMintToInstruction(mint.publicKey, ata, payer.publicKey, 1_000_000_000n * 1_000_000n, [], P),
), [payer, mint]);
console.log(mint.publicKey.toBase58());
