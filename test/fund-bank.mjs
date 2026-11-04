// Rehearsal helper: plays "you" on launch day, sending SOL and coins from your wallet to the bank.
// Usage: node test/fund-bank.mjs <solPayer.json> <tokenHolder.json> <mint> <bankAddress> <sol> <coins>
import fs from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID as P, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
const [payerF, holderF, mintS, bankS, sol, coins] = process.argv.slice(2);
const c = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = load(payerF), holder = load(holderF), mint = new PublicKey(mintS), bank = new PublicKey(bankS);
const to = getAssociatedTokenAddressSync(mint, bank, false, P);
const sig = await sendAndConfirmTransaction(c, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bank, lamports: Math.round(+sol * LAMPORTS_PER_SOL) }),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, bank, mint, P),
  createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, holder.publicKey, false, P), mint, to, holder.publicKey, BigInt(coins) * 1_000_000n, 6, [], P),
), [payer, holder]);
console.log('funded', sig);
