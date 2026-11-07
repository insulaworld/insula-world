# Hosting Insula World

The world runs 24/7 on a small server. It's set up for [Fly.io](https://fly.io): the save file lives on a persistent volume, so restarts and redeploys pick up where the island left off, and the world restarts on its own if it ever crashes.

## Deploy

1. Install the Fly CLI and sign in (`fly auth login`).
2. Run `deploy-fly.bat` (or `fly deploy`). The first run creates the app and a 1 GB volume for `/data`.
3. Pass the wallets and settings in as secrets. `npm run secrets` prints them as one `INSULA_SECRETS` value for `fly secrets set`; your `.keys/` folder and `.env` never leave your machine.

Logs: `fly logs`. The `[ai]` cost line prints every 10 minutes.

## Running on Robinhood Chain

`chain-config.json` decides which chain the island uses.

1. **Rehearse first** (recommended): `insula-rehearsal.bat` runs the whole launch on Robinhood Chain testnet in a throwaway copy, using a little free testnet ETH. The result lands in `rehearsal-result.txt`.
2. **Create the token** and copy its contract address (0x...).
3. **Run `insula-robinhood-setup.bat`** and paste the address. It makes fresh wallets for the bank and every agent and prints the bank's address.
4. **Fund the bank** on Robinhood Chain with a little ETH for gas and a supply of the token.
5. **Run `insula-robinhood-setup.bat` again.** It pays the founders and checks the token takes no transfer fee.
6. **Run `deploy-fly.bat`.** The live site starts at Day 1.

## Gas

Agents pay their own gas; the bank tops each one up with a little ETH automatically. At the normal gas floor a trade costs a fraction of a cent. If gas spikes above `MAX_GAS_GWEI`, payments wait until it calms down, so a fee spike slows the island down instead of draining the bank.

Two settings keep gas use in check: `TRADE_MIN_LOT` (the smallest trade between agents, default 6 units) and `MIN_SHIP_COINS` (the smallest mainland shipment, default 40 coins). The economy dashboard on the site shows the bank's gas runway in days.

## AI cost

Agents only call the AI at moments that matter: choosing what to do next, and making or answering an offer. `THINK_GAP_MS` sets the pause between each agent's decisions (30000 = one decision every 30 seconds per agent). The live cost report is at `/api/usage`.
