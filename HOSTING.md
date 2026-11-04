# Hosting Insula World 24/7

Your PC can't stay on for 30 days, so the world needs a small server. Fly.io and Railway both work; the steps for each are below. It runs the same code, keeps the save file on a disk that survives restarts, and restarts the world automatically if it ever crashes.

The world is one Node program. It needs:
- **a disk** for `data/` (the save file, the decision records and the newspaper)
- **its secrets** (the AI key and the wallets) as variables, never as files in the upload
- **a public web address** for people to watch

## Fly.io (recommended)

About **$7 a month**: one always-on server with 1 GB of memory, plus a 1 GB disk for the save. Fly needs a card on file and has no plan fee.

1. Make an account at **fly.io** and add a card under **Billing**. Name things "insula", not your own name.
2. Double-click **deploy-fly.bat**. It:
   - installs Fly's command line tool and opens your browser to sign in
   - packs your wallets and your `.env` settings into Fly **secrets** (they're never uploaded as files)
   - creates the app (the first free name of `insula-world`, `insula-island` and a couple of others) and a 1 GB disk for the save
   - builds and deploys, then opens your live link: `https://<name>.fly.dev`
3. To update the code later, double-click it again. The world saves on shutdown and continues where it left off.

**Logs:** `flyctl logs -a <name>`. The `[ai]` cost line prints every 10 minutes. **Cost so far:** `https://<name>.fly.dev/api/usage`.

The files behind this are `Dockerfile`, `.dockerignore` and `fly.toml`. The machine never sleeps (`auto_stop_machines = "off"`), because the island has to keep running with nobody watching.

## Railway (alternative)

## 1. Pack the wallets

In the project folder:

```
npm run secrets
```

This writes `deploy-secrets.txt` with one long line, `INSULA_SECRETS=...`. That line is every wallet's private key (the bank and all 13 agents). Treat it like a password. It's in `.gitignore` and is never uploaded with the code.

## 2. Upload the code

```
npm install -g @railway/cli
railway login
railway init
railway up -d
```

- `railway login` opens your browser to sign in.
- `railway init` creates the project. Give it any name.
- `railway up -d` uploads the folder. It skips everything in `.gitignore`, so your `.env`, `.keys/`, `data/` and `deploy-secrets.txt` stay on your PC.

The first deploy will fail or run in test mode, because it has no secrets yet. That's expected.

Or double-click `deploy-railway.bat`, which runs steps 1 and 2 for you.

## 3. In the Railway dashboard

Run `railway open` to jump to it, then click your service.

1. **Variables → Raw Editor.** Paste these, then click **Update Variables**:
   - the contents of your `.env` (at least `ANTHROPIC_API_KEY`, `LLM_PRICE_IN` and `LLM_PRICE_OUT`)
   - the one line from `deploy-secrets.txt`
2. **Add a volume.** Right-click the project canvas, choose **Volume**, and connect it to your service with mount path **`/app/data`**. Your save lives there, so it survives redeploys.
3. **Settings → Networking → Generate Domain.** This gives the world a public address like `insula-production.up.railway.app`. You can attach your own domain here later.

Railway redeploys with the new settings. Open the domain: the header should say **LIVE · SOLANA DEVNET** and the AI brain chip should show.

## 4. Check on it

- **Logs:** in the Railway service, open **Deployments → View logs**, or run `railway logs`. The `[ai]` cost line prints every 10 minutes.
- **Cost so far:** `https://<your-domain>/api/usage`
- **Updating the code:** run `railway up -d` again. The world saves on shutdown and picks up where it left off.

## Before the real launch

- **Start the world fresh on launch day.** Set `INSULA_FRESH=1` for one deploy, then delete that variable. If you don't delete it, every restart wipes the world.
- **Mainnet:** follow "Moving to mainnet" in the README, run `npm run secrets` again, and paste the new `INSULA_SECRETS` line into Railway.
- **Keep the bank modest.** The bank's key lives on the server. Hold most of the dev buy in a wallet only you control, and top the bank up as needed.
- **Use a paid RPC** (for example Helius) on mainnet: set `RPC_URL`. The public RPC rate-limits busy apps.
- **Add billing to your Anthropic account** with a monthly limit, so the AI never stops halfway through the month.

## Other hosts

Any always-on host that runs Node 20+ works the same way: run `npm install` then `npm start`, set the variables above, and give it a persistent disk for `data/` (point `INSULA_SAVE` there if it isn't `./data`). On a plain VPS, use `pm2 start server/index.js --name insula` to keep it running, plus Caddy for HTTPS.

## Launch day (mainnet)

1. Launch the coin on pump.fun. Copy its mint (contract) address.
2. Get a free mainnet RPC URL from Helius (helius.dev). The public RPC rate-limits a busy island.
3. Double-click `insula-mainnet-setup.bat`. Paste the mint address and the RPC URL when asked.
   It makes fresh mainnet wallets (your devnet ones move to `.keys-devnet/`), reads the coin
   (classic SPL or Token-2022), and prints the bank wallet address.
4. From your own wallet, send the bank wallet about 1 SOL and your dev buy.
5. Run `insula-mainnet-setup.bat` again. It opens a token account for each agent and pays the founders.
6. Run `deploy-fly.bat`. The live site sees the save was for devnet, sets it aside, and starts a new island at Day 1.

Fees: the bank pays about 0.0000116 SOL per trade (measured; two signatures plus a small priority fee). With 4 agents that is about 0.03 SOL a day, rising to about 0.1 SOL a day once all 13 have arrived. 1 SOL covers the first 1 to 2 weeks; top it up from the creator fees.

## Launch day on Robinhood Chain (Pons)

The island can run on Solana or Robinhood Chain; `chain-config.json` decides. For Robinhood Chain:

1. Rehearse first (optional but recommended): run `insula-rehearsal.bat`. It makes a throwaway testnet wallet,
   tells you its address, and after you send it ~0.05 testnet ETH (free from the Alchemy Robinhood testnet faucet,
   claimed to your own wallet) it runs the whole launch on testnet in a throwaway copy. Result: `rehearsal-result.txt`.
2. Launch the token on Pons (paired with ETH). Copy its contract address (0x...) and its Pons page link.
3. Run `insula-robinhood-setup.bat`. Paste the address and the link. It makes fresh wallets (your Solana ones move
   to `.keys-solana*/`, nothing is deleted) and prints the bank wallet address.
4. From your own wallet, on Robinhood Chain, send the bank about 0.05-0.1 ETH and 3-5 million of your token.
5. Run `insula-robinhood-setup.bat` again. It pays the founders and checks the token takes no transfer fee.
6. Run `deploy-fly.bat`. The live site sees the old save was for another chain, sets it aside, and starts Day 1.

Gas: agents pay their own gas on Robinhood Chain; the bank tops each one up with a little ETH automatically.
At the normal gas floor (0.02 gwei) a trade costs about half a cent, so roughly 0.005 ETH a day with 4 agents
and ~0.015 a day with all 13. If gas spikes above MAX_GAS_GWEI (default 0.25 gwei, about 12x the floor),
payments wait until it calms down, so a fee spike slows the island instead of draining the bank.
