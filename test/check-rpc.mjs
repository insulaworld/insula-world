// Checks the Robinhood RPC in .env (RH_RPC_URL): reachable, and really Robinhood mainnet (chain 4663).
import fs from 'node:fs';
const m = fs.readFileSync('.env', 'utf8').match(/^RH_RPC_URL=(.+)$/m);
if (!m) { console.log('No RH_RPC_URL line in .env.'); process.exit(1); }
const url = m[1].trim();
try {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber' }, { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice' }]) });
  const j = await r.json();
  if (!Array.isArray(j)) { console.log(`The RPC answered with an error: ${JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
  const [id, block, gas] = j.map((x) => (x.result ? parseInt(x.result, 16) : null));
  if (id === 4663) console.log(`OK: Robinhood mainnet, block ${block}, gas ${(gas / 1e9).toFixed(4)} gwei.`);
  else console.log(`Reached an RPC, but it is chain ${id}, not Robinhood mainnet (4663).`);
} catch (e) { console.log(`Couldn't reach the RPC (${e.message}). If Alchemy says the key is invalid, the key may have a letter O where a zero should be.`); }
