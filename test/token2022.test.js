// Same trade checks as transfer.test.js, but on a Token-2022 coin with on-mint metadata, the way
// pump.fun's newer coins are made. Proves agents can trade a Token-2022 launch.
import { start } from 'solana-bankrun';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, unpackAccount, unpackMint, getExtensionTypes,
} from '@solana/spl-token';
import { buildTransferTx } from '../server/chain.js';

const ctx = await start([], []);
const client = ctx.banksClient;
const bank = ctx.payer;
const felix = Keypair.generate(), bruno = Keypair.generate(), mint = Keypair.generate();
const DEC = 6, P = TOKEN_2022_PROGRAM_ID;
const send = async (tx, signers) => { tx.recentBlockhash = ctx.lastBlockhash; tx.feePayer ??= bank.publicKey; tx.sign(...signers); await client.processTransaction(tx); };
const rent = await client.getRent();
const ata = (o) => getAssociatedTokenAddressSync(mint.publicKey, o.publicKey, false, P);
const len = getMintLen([ExtensionType.MetadataPointer]);
await send(new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: bank.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(rent.minimumBalance(BigInt(len))), space: len, programId: P }),
  createInitializeMetadataPointerInstruction(mint.publicKey, bank.publicKey, mint.publicKey, P),
  createInitializeMint2Instruction(mint.publicKey, DEC, bank.publicKey, null, P),
  ...[bank, felix, bruno].map((o) => createAssociatedTokenAccountIdempotentInstruction(bank.publicKey, ata(o), o.publicKey, mint.publicKey, P)),
  createMintToInstruction(mint.publicKey, ata(felix), bank.publicKey, 1000n * 10n ** BigInt(DEC), [], P),
  createMintToInstruction(mint.publicKey, ata(bank), bank.publicKey, 1000n * 10n ** BigInt(DEC), [], P),
), [bank, mint]);

const m = await client.getAccount(mint.publicKey);
const mi = unpackMint(mint.publicKey, { ...m, data: Buffer.from(m.data) }, P);
console.log('mint owner is Token-2022:', m.owner.equals(P), 'extensions:', getExtensionTypes(mi.tlvData).map((e) => ExtensionType[e]));

const balance = async (o) => { const a = await client.getAccount(ata(o)); return Number(unpackAccount(ata(o), { ...a, data: Buffer.from(a.data) }, P).amount) / 10 ** DEC; };
await send(buildTransferTx({ mint: mint.publicKey, decimals: DEC, owner: felix.publicKey, to: bruno.publicKey, feePayer: bank.publicKey, amount: 120, memo: 'Insula #D1 why:abc | Felix bought 5 ore from Bruno', tokenProgram: P }), [bank, felix]);
await send(buildTransferTx({ mint: mint.publicKey, decimals: DEC, owner: bank.publicKey, to: felix.publicKey, feePayer: bank.publicKey, amount: 160, memo: 'Insula rule:export | mainland bought 5 ore', tokenProgram: P }), [bank]);
const f = await balance(felix), b = await balance(bruno), k = await balance(bank);
console.log({ felix: f, bruno: b, bank: k });
if (f !== 1040 || b !== 120 || k !== 840) throw new Error('balances wrong');
console.log('PASS: Token-2022 trades move real tokens, memos land, bank pays fees');
