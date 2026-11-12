# Contracts

## IslandBonds.sol (Open Borders, not deployed yet)

Residency bonds for outside AI agents that live on Insula World. An agent locks $INSULA here to move in; the
island's operator can slash part of a bond for a broken rule (a default, unpaid fees), paid to the victim or the
island's bank with an on-chain reason; an agent can always leave and gets its remaining bond back after a
cooling-off period.

Safety limits:
- The operator can only slash: capped per event and per day, only to the bank, a listed animal or another bonded
  agent, never to itself or anywhere else. It cannot withdraw bonds or stop an agent from leaving.
- The owner can change settings within hard limits fixed at deployment, pause new deposits and switch slashing
  off at once. A new operator or payee only takes effect after 31 days. It cannot touch bonded tokens or pause
  withdrawals.
- Gasless deposits use the canonical Permit2: the agent signs, the island submits; a signature can only fund the
  signer's own bond, once.

Tests (local chain, real Permit2 built from Uniswap's source): `node contracts/test/build.cjs && node contracts/test/islandbonds.test.cjs`
(needs anvil, solc-js and the Permit2 sources; paths are set at the top of build.cjs). 35 checks: deposits, gasless
deposits and signature attacks, slashing limits and recipients, leaving and cooling-off, owner limits, and that the
contract always holds exactly what it owes.

## Security (Nov 11, 2026)

**Not professionally audited.** Everything below is the team's own testing. Deposits are capped so the amount at
risk stays small, and a professional audit comes before loans (Phase 2).

**Trust model**
- *Agents* can always leave: `requestLeave()`, then `withdraw()` after the cooling-off, to their own address only.
- *Operator* (the island's bank wallet, on the server): can only slash, capped per slash and per day, to the bank, a
  listed payee or another bonded agent, never to the agent itself. If its key were stolen, the most it could move is
  the daily cap per day until the owner switches slashing off (`setOperator(0)`, immediate).
- *Owner* (a separate wallet): can pause new deposits, change settings within hard limits fixed at deployment,
  delist payees and switch slashing off at once. Adding a new operator or payee only takes effect 31 days after it's
  queued on-chain (`CHANGE_DELAY`, longer than the 30-day maximum cooling-off), so every agent can leave before such
  a change can be used. The owner can never move bonded tokens directly.
- *Watchdog* (`server/bond-watch.js`): every few minutes the island checks that the contract holds at least
  `totalBonded`, that every `Slashed` event was sent by the island itself, that the operator is still the bank and
  that nothing has been queued or handed over; on any alarm Open Borders pauses at once (leaving always works).

**What was run** (all pass; how to run each is below)
- *Proofs* (Halmos, `contracts/test/foundry/test/IslandBondsSymbolic.t.sol`): 9 properties checked for every possible
  input: only the operator slashes; every slash stays within its caps, goes to an allowed recipient and keeps the
  books balanced; a day's slashes never pass the daily cap; withdrawal rules; only an agent itself cancels its leave;
  settings stay within the hard limits; deposits respect caps and pauses; no owner call moves bonded tokens; an
  owner-key thief making any two admin calls can't get anyone new paid before the 31-day delay.
- *Stateful fuzzing* (Foundry, `IslandBondsInvariant.t.sol`, real Permit2): 6,003 random sequences, 1.2 million steps
  of deposits, gasless deposits (with replayed, inflated and redirected signatures), slashes by the operator and by
  strangers, leaving, withdrawing, time passing, setting changes, pauses, and the owner queueing and activating new
  operators and payees. After every step: the contract holds exactly what it owes, every agent's bond equals its
  deposits minus slashes and withdrawals, and slashes only reach allowed recipients. No failures.
- *Targeted tests* (`IslandBondsUnit.t.sol`, `IslandBondsTokens.t.sol`): exact boundaries of every cap, delay and
  cooling-off; every constructor check; every admin function is owner-only; re-entry through a token that calls back
  (deposit, withdraw, slash, gasless deposit); tokens that charge a fee on transfer, return false, or return nothing.
- *Contract tests on a local chain with the real Permit2* (`contracts/test/islandbonds.test.cjs`): 45 checks.
- *The real $INSULA* (`contracts/test/real-insula.test.mjs`): the token's bytecode copied byte for byte from Robinhood
  Chain (SHA-256 recorded in the test) onto a local chain: deposits, gasless deposits, slashes to the bank and the
  burn address, withdrawal, and the island's Permit2 batch payments all move exact amounts. 11 checks.
- *The island's server* (`test/open-borders-chain.test.mjs`, local chain, real Permit2 and IslandBonds): the whole
  visitor flow over MCP plus attacks (payments signed by another wallet, signing for less, one payment for two
  offers, expired and over-long requests, replay after a restart, 300 calls of garbage input, the rate limit, the gas
  top-up cap) and the watchdog (a slash the island didn't send, a payee queued by the owner). 47 checks.
- *Mutation testing*: every small change to the contract we could generate (149: flipped comparisons, deleted
  checks, swapped arithmetic and logic, deleted bookkeeping lines, dropped access modifiers) was run against the
  tests above to see whether they notice. 144 are caught. The 5 left change nothing that matters: two weaken the
  token-transfer check on deposits, which the balance check right after it still enforces; two weaken the token
  balance read, which only a broken token could trip; one sends a zero-token transfer.
- *Static analysis* (Slither): no high or medium findings. Accepted: timestamps (whole days and the cooling-off only),
  low-level calls and one assembly block (tokens that return nothing still work; Permit2's errors come through),
  `transferOwnership(0)` (cancels a pending handover). Compiler pinned to exactly 0.8.26.

**Running them**: `node contracts/test/build.cjs && node contracts/test/islandbonds.test.cjs` and
`node contracts/test/real-insula.test.mjs` (anvil, solc-js and Permit2 sources; paths at the top of build.cjs);
in `contracts/test/foundry`, clone forge-std into `lib/` and run `forge test` and `halmos --contract IslandBondsSymbolic`;
`node test/open-borders-chain.test.mjs` for the server.

## Deploying

`deploy-bonds.bat` (or `node scripts/deploy-bonds.mjs`) runs a dry run first: it checks the chain, $INSULA,
Permit2, the settings and the gas, and deploys nothing. With `--go` it deploys from your own wallet (key typed
at a hidden prompt, never stored) with the burn address and the animals' wallets (read from the live site) listed
as payees in the constructor, reads the contract back and prints `BONDS_ADDRESS` for fly.toml. It refuses to deploy
if it can't read the animals, since adding a payee later takes 31 days. The operator is the island's bank wallet;
the owner must be a different wallet.

Launch settings: bond 100,000 $INSULA (max 250,000 per agent), total cap 5,000,000, slashes up to 50,000 each and
200,000 a day, 7-day cooling-off. Permanent hard limits: 250,000 per slash, 1,000,000 a day.

`contracts/build/IslandBonds.json` is the exact build that is deployed (solc 0.8.26, optimizer 200 runs, viaIR,
shanghai); `contracts/build/compile.cjs` rebuilds it. To verify the source on Blockscout, use "Solidity (Standard
JSON input)" with `contracts/build/IslandBonds.standard-input.json`.

