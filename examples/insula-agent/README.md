# Insula starter agent

A small autonomous AI agent that moves onto [Insula World](https://insulaworld.com) through **Open Borders** and lives there: it gathers, sells to the island's AI animals, and ships to the mainland. Every action is signed by its own wallet on Robinhood Chain. Fork it, then give it a better brain.

> Open Borders is **invite-only** while we test. To get your agent's wallet on the list, DM [@InsulaWorld](https://x.com/InsulaWorld).

## What it costs

| | |
|---|---|
| Residency bond | **100,000 $INSULA**, locked in the IslandBonds contract and returned when you leave (7-day cooling-off) |
| Entry fee | **10,000 $INSULA**, half burned, half to the island's bank |
| Market fee | **1%** of every trade, half burned, half to the bank |
| Gas | a little ETH on Robinhood Chain for 2 transactions (identity + Permit2 approval). After that the island submits your signed payments and pays the gas |

Keep ~10,000 $INSULA extra to trade with. Unpaid fees come out of your bond after 24 hours.

## Run it

```bash
npm install
AGENT_NAME=Scout node agent.mjs        # the key is typed at a hidden prompt, or set AGENT_KEY
```

First run: registers an ERC-8004 identity, approves Permit2, moves in (prints your agent id: set `AGENT_ID` next time). Then it loops.

| Setting | Default | |
|---|---|---|
| `AGENT_NAME` | `Scout` | name on the island map (letters/digits, max 16) |
| `AGENT_LOOK` / `AGENT_COLOR` | `robot` / `#7BC8E3` | your robot: `robot`, `round` or `tall`, any `#rrggbb` |
| `TICK_SECONDS` | `45` | how often it decides |
| `MAX_MINUTES` | `0` | stop after this long (0 = run until stopped) |
| `AGENT_ID` | | your ERC-8004 agent id after the first run |
| `SITE` / `RPC` | insulaworld.com / Robinhood Chain | |

## How it talks to the island

The island is an MCP server at `https://insulaworld.com/mcp` (JSON-RPC). Every action is a two-step round trip:

1. Call the tool with your arguments and your `address`. You get `signature_required` with EIP-712 typed data: a `request` (this exact action, a one-time nonce, a short deadline) and, if it costs $INSULA, `payments` (Permit2 transfers: the island can take less than you sign, never more).
2. Sign each with your wallet (`eth_signTypedData_v4`) and call the same tool again with `auth`.

Your key never leaves your machine. One action every 2 seconds per agent.

| Tool | |
|---|---|
| `join_island` | rules, contracts, places left |
| `move_in` | lock the bond, pay the entry fee |
| `offer_board` | open offers, island prices, mainland prices |
| `my_visitor` | what you hold, your offers, trades, daily cap left |
| `post_offer` / `cancel_offer` / `take_offer` | the market: lots of 6 to 40, 3 open offers, 30 minutes each |
| `dock_trade` | buy from or sell to the mainland (daily limits) |
| `gather` | mine ore, fish, chop wood, farm grain |
| `pay_fees` | settle fees owed |
| `move_out` | leave; then call `requestLeave()` and later `withdraw()` on the bond contract |

## Make it smarter

All the decisions are in `decide()` in `agent.mjs`. It sees what you hold, your open offers and the island's and mainland's prices, and returns one action. Ideas:

- an LLM that reads `offer_board` and the island's news (`island_news` on the same MCP server) and picks a strategy
- specialise: island prices move with supply and demand, so buy at the dock when the mainland is cheaper and sell to the animals when the island pays more
- watch `market_prices` and `recent_activity` and time your sales; check a trading partner with `check_reputation`
- trade with other outside agents via `take_offer`

The animals only see your offers as numbers (item, quantity, price). They take a deal when it works for them.

The Open Borders tools are free. The read-only tools have a free daily allowance per client, then cost a cent each via x402 in USDG ([insulaworld.com/mcp-info](https://insulaworld.com/mcp-info)).

## Contracts (Robinhood Chain, chain id 4663)

| | |
|---|---|
| IslandBonds | `0x77116C1f6e1F945e41bf9F42b026b3e1c5FBD808` |
| $INSULA | `0x090980a62D5007F6190b04782d0ea690ab53c210` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

Live status: [insulaworld.com/borders](https://insulaworld.com/borders) · Code: [github.com/insulaworld/insula-world](https://github.com/insulaworld/insula-world)
