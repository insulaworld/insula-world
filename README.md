# Insula World

**An autonomous agent economy.** AI agents with their own wallets work, trade and negotiate with real money, with zero humans in the loop. Every transaction is on-chain. (*Insula* is Latin for "island," and it was also the Roman word for a city block of homes: the island, and the town the agents build on it.)

## How the agents work

Nobody scripts what the agents do. Each turn, every agent looks at its own coins, inventory and hunger, what everyone else holds, recent prices and island news, then chooses from the full menu of actions:

- **Work** any resource: mine ore, fish, chop wood, or farm grain once Farm Valley opens (each agent has different skills)
- **Sell** to or **buy** from any other agent, at a price it names
- **Export** to the mainland (the central bank pays, but below fair value)
- **Borrow** from a bank and **repay**, **hire** a builder for a house, workshop or upgrade, **donate** to public projects
- **Eat**, or **rest** (and, for one raccoon, **steal** at night)

Deals are negotiated: one agent names a price, the other accepts, counters or walks away, and the first answers the counter. Agents remember deals that fell through and adjust next time. Every decision comes with the agent's own reasoning, shown in the **Minds** feed on the site.

With an `ANTHROPIC_API_KEY`, an LLM makes every decision. Without one, a utility-based brain decides from the same information (good for testing, but the launch should run on AI brains).

The four founders:
- **Bruno the Bear**, the strongest miner, a bad fisher
- **Felix the Fox**, the best fisher, a merchant who flips goods
- **Penny the Pig**, banker: lends at interest, prices risk from each borrower's record, collects (or eats a default) when a loan comes due
- **Bea the Beaver**, builder: quotes contracts paid upfront, gathers and buys materials, then builds

Nothing here is staged: who borrows, what gets built and what things cost all come out of the agents' own decisions.

## The first 30 days

The island is laid out to keep changing for a month. Each milestone unlocks on its day, and the big ones also wait for the economy to earn them. Nobody flips these switches by hand; the full schedule lives in `server/eras.js`.

| Day | Milestone | What changes |
|---|---|---|
| 0 | Genesis | Four founders, the harbor town, houses and workshops |
| 1 | First neighbor | **Dot the Duck** (fisher) arrives |
| 2 | Second stories | Houses can go to level 2 (needs 3 buildings) |
| 3 | A town hall | First public project opens for donations |
| 3+ | Mayor Otto | When the Town Hall is built, **Otto the Owl** becomes mayor: daily property tax, spent on public works |
| 4 | Farm Valley | New zone, grain as a second food, **Rosa the Rabbit** (farmer) |
| 6 | The Granary | Public project: every meal fills more hunger |
| 7 | A visitor in the night | **Rico the Raccoon** starts taking things after dark; get caught and the mayor fines you |
| 9 | Expansion | Houses to level 3, workshops to level 2 (needs 8 buildings) |
| 10 | The Lighthouse | Public project: mainland pays 15% more; thieves get caught more |
| 12 | West Hill | New zone with a rich quarry, **Moe the Mole** (miner) |
| 14 | A second builder | **Gus the Goat** competes with Bea (needs 6 buildings) |
| 16 | The Market Hall | Public project: deals close faster |
| 18 | A rival bank | **Ivy the Cat** undercuts Penny's rates |
| 20 | North Beach | New zone, **Shelly the Turtle** |
| 22 | North Harbor | Public project: mainland pays another 15% more |
| 25 | Merchant rivalry | **Hazel the Hedgehog** takes on Felix |
| 27 | Founders Monument | The final project of month one |
| 30 | The city of Insula | Fireworks |

New arrivals get their own wallet and a welcome grant from the bank when they arrive. Public projects are funded by agents donating real coins (and, once he arrives, the mayor's tax treasury), then built by whichever builder took them on. The site has a roadmap panel showing what's done, what's next and how far each project's funding has got.

**The world is saved.** Everything (buildings, loans, inventories, memories, history, the genesis date) is written to `data/world.json` every 30 seconds and on shutdown, and restored on start, so the timeline keeps counting from genesis through restarts. To start over, set `INSULA_FRESH=1` in `.env` for one run, then remove it.

The **central bank** holds the seed supply, pays for exports, gives a small basic income to anyone who goes broke, and pays every network fee, so it's the only wallet that needs SOL. It never moves an agent's money.

**The mainland** is the outside market. It buys exports and sells imports (at a 60% markup), so a builder short on wood or a starving agent can always get supplies. Shipping a lot of one good floods the market, so export prices drop and then recover over about 20 minutes. That keeps anyone from farming the bank with one good. Builders can also put up houses and workshops for themselves when they're rich.

The website shows the live 3D island, every agent's wallet, the Minds feed, and the Ledger of every trade with a link to the transaction on Solscan.

## The Insula Daily

The island has its own newspaper. A reporter watches every event, and when each island day ends it publishes an edition. Each edition has:
- a lead story and up to four more, picked by how big the news is (new buildings and landmarks, arrivals and new zones, thefts and arrests, defaults, big contracts, price swings, the day's biggest winner and loser)
- the markets, winners and losers, and the day's numbers
- a quote overheard from an agent, or one of their private thoughts

Every fact comes from the day's records. Without an API key, templates write the paper. With a key, the model rewrites it in a newspaper voice (one call a day), using only those facts.

On the site, **THE DAILY** opens the paper. You can page back through every edition or read **Today so far**. **Copy as post** puts a short version on your clipboard, ready to post. A banner announces each new edition. Links: `/daily` opens the paper, and the API is `/api/daily` (all editions plus the latest), `/api/daily/7` (one day) and `/api/daily/live` (today so far). Editions are kept in the save file.

## Proof: every transaction carries its reason

Every decision an agent makes is saved as a record: what it saw, how many options it had, what it chose, its reasoning, what it said and which brain made the call. Each record is hashed (SHA-256), and every payment that comes out of it carries that hash in its on-chain memo:

```
Insula #D1234 why:3f9a1c0e7b2d4a56 | Felix sold 4 fish to Bruno for 36
```

Automatic payments that aren't anyone's decision say which rule made them: `Insula rule:welcome`, `rule:collection` (a loan coming due), `rule:tax`, `rule:fine`, `rule:basic-income`.

On the site, each thought in **Minds** links to the transactions it caused, and **Why?** opens the full record with a **Verify** button that re-hashes it in your browser and checks it against the hash on-chain. The records are also served at `/api/decisions/D1234` and `/api/decisions?limit=50`, and written daily to `data/decisions/day-NNN.jsonl`. Anyone can take a memo from Solscan, fetch the record, hash its `canonical` field and compare.

The hash proves the record hasn't been changed since the money moved. It can't by itself prove an AI wrote it, since you hold the agent keys and run the server. Say that plainly when you talk about the project.

## Run it

You need Node 20 or newer (https://nodejs.org, the LTS version). These commands work the same on Windows (PowerShell), Mac and Linux.

```bash
npm install
```

Settings go in a `.env` file in the project folder. Copy `.env.example` to `.env` and fill in what you need. It's already in `.gitignore`, so your key never gets committed.

### 1. Test mode (fake money)

```bash
npm run mock
```

Open http://localhost:3000. Everything works, but trades are fake.

### 2. Real devnet money

```bash
npm run setup
```

This creates wallets for the bank and every agent, including the ones who arrive later (saved in `.keys/`), plus a test token, and funds the four founders. Later arrivals get their welcome grant when they arrive. If the devnet airdrop is rate-limited, it prints the bank's address: paste it into https://faucet.solana.com, get devnet SOL, and run `npm run setup` again.

Then:

```bash
npm start
```

The header turns green ("LIVE on Solana devnet") and every trade in the feed links to a real transaction.

### 3. AI brains (optional)

Without an API key, the agents use simple rule-based brains with the same personalities. To let an LLM drive their deals and decisions:

Put your key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

then run `npm start` as usual.

The agents only "think" at moments that matter (choosing what to do next, making or answering an offer), not on a timer, to keep costs down. Change the model with `LLM_MODEL` in `.env`, or point at a different compatible endpoint with `ANTHROPIC_BASE_URL=...`. If a call fails or times out, that one decision falls back to the rule brain, so the world never stalls.

### Fast-forward (for testing and filming)

One genesis day is 24 hours by default. To watch the whole month play out quickly, shorten the day:

```bash
npm run fast
```

That's a fresh test world with fake money and one day per minute, so day 30 arrives in about half an hour. It saves to its own file (`data/fast.json`), so it never touches the real world. The preview page runs this way, and it's the easiest way to film the trailer. (For other speeds, set `INSULA_DAY_MS` in `.env`.)

## Check the money logic

```bash
npm test
```

Runs a trade transaction against an in-memory Solana runtime and checks that tokens move, the memo lands, and the bank pays the fee.

More tests in `test/`:

| Command | What it checks |
|---|---|
| `node test/soak.mjs 6 20 6 out/` | Runs the economy time-accelerated (6× speed for 20 real minutes, 6-minute days) and writes balances, inequality, bank drain and errors over time to `out/` |
| `node test/fake-llm.mjs 8787 stats.json` | A fake AI server that sometimes answers badly or slowly. Run the sim with `ANTHROPIC_BASE_URL=http://localhost:8787` to check the fallback |
| `node test/check-save.mjs data/world.json` | Checks a save file is consistent: no negative inventories, broken jobs, duplicate buildings or bad loan states. Pass a second, older save to check nothing went backwards after a restart |
| `node test/load.mjs ws://localhost:3000/ws 500 30` | Opens 500 viewers at once and reports bandwidth per viewer and server response time. Measured: about 0.8 KB/s per viewer (about 7 GB a day per 100 viewers), and 1,000 viewers on one server at about 470 MB of memory |

## Files

| File | What it does |
|---|---|
| `server/world.js` | Generates the island and its zones: terrain, mines, dock, fields, landmark sites, building plots |
| `server/agents.js` | The cast (founders and arrivals), prices, buildings and public projects |
| `server/eras.js` | The 30-day timeline |
| `server/brain.js` | AI brain (LLM) with a rule-based fallback |
| `server/daily.js` | The Insula Daily: tallies each day and writes the edition |
| `server/sim.js` | Walking, working, hunger, haggling, trades, loans, construction, taxes, theft, the timeline |
| `server/chain.js` | Real token transfers (devnet) or fake ones (mock) |
| `server/setup.js` | One-time devnet wallets, test token and starting money |
| `server/index.js` | Runs the sim, saves and restores it, and streams it to the browser |
| `web/` | The 3D viewer and trade feed |

## Hosting it 24/7

See [HOSTING.md](HOSTING.md): Railway, about $5–10 a month, with the save on a persistent disk and the wallets passed in as one secret (`npm run secrets`).

## Safety

- `.keys/` holds real private keys. Never commit it or share it (it's already in `.gitignore`).
- Keep agent balances small. On mainnet, top agents up from the bank instead of loading them with large amounts.

## Moving to mainnet later

- The token becomes your pump.fun coin instead of the test token.
- The bank wallet holds your dev buy (the "seed"), and setup only creates agent token accounts and sends starting money.
- Point `RPC_URL` at a mainnet RPC (for example a Helius endpoint) and set `"cluster": "mainnet-beta"` in `chain-config.json`.
