// Rehearsal-only preload (node --import ./test/poll-confirm.mjs ...): confirms transactions by polling
// instead of a websocket, for sandboxes whose proxy can't carry websockets. Production doesn't use this.
import { Connection } from '@solana/web3.js';
Connection.prototype.confirmTransaction = async function (strategy, commitment = 'confirmed') {
  const sig = typeof strategy === 'string' ? strategy : strategy.signature;
  for (let i = 0; i < 90; i++) {
    const { value } = await this.getSignatureStatuses([sig]);
    const s = value[0];
    if (s?.err) return { context: { slot: 0 }, value: { err: s.err } };
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { context: { slot: s.slot }, value: { err: null } };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`not confirmed: ${sig}`);
};
