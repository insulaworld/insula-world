// Insula starter agent: a small autonomous AI-agent body for Open Borders. Fork it and give it a brain.
//
// It moves onto Insula World (Robinhood Chain) from its own wallet and then lives there on a loop:
// gather whatever is scarce, offer it to the island's animals just under the market price (never under a
// floor near its fair price, so it doesn't crash the market), and hold or ship what the island doesn't need. Every action is signed here; only signatures leave this machine.
//
//   npm install && node agent.mjs            (key from AGENT_KEY, or typed at a hidden prompt)
//
// The decisions live in decide() below. That's the part to make smarter: plug in an LLM, read the news,
// watch the animals' prices, specialise in one good. The rest (signing, the island's API) you can leave alone.
import readline from 'node:readline';
import { JsonRpcProvider, Wallet, Contract, Interface, MaxUint256, formatEther, formatUnits } from 'ethers';

const env = (k, d) => process.env[k] ?? d;
const SITE = env('SITE', 'https://insulaworld.com').replace(/\/$/, '');
const RPC = env('RPC', 'https://rpc.mainnet.chain.robinhood.com');
const NAME = env('AGENT_NAME', 'Scout');            // shown on the island map (letters/digits, 16 max)
const LOOK = env('AGENT_LOOK', 'robot');            // robot | round | tall
const COLOR = env('AGENT_COLOR', '#7BC8E3');
const TICK_S = Number(env('TICK_SECONDS', 45));     // how often it thinks
const MAX_MIN = Number(env('MAX_MINUTES', 0));      // 0 = run until stopped
const MOVE_IN = env('MOVE_IN', '1') === '1';        // set 0 to only run setup and look around

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error(`\nSTOP: ${m}\n`); process.exit(1); };

// ---------- the island's MCP server (JSON-RPC over HTTP) ----------
let rid = 1;
async function tool(name, args = {}) {
  const res = await fetch(`${SITE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await res.text();
  const j = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:')).slice(5) : text);
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const r = j.result;
  return { ...(r.structuredContent || JSON.parse(r.content?.[0]?.text || '{}')), isError: !!r.isError };
}

// ---------- the wallet ----------
function hidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const key = env('AGENT_KEY', '') || await hidden("Agent wallet private key (hidden, stays on this machine): ");
const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
const ME = wallet.address;

// Every action: call once to get what to sign, sign it (EIP-712), call again with the signatures.
// The island takes one action every 2 seconds per agent, so actions are spaced out.
let lastAct = 0;
async function act(name, args = {}) {
  const wait = 2600 - (Date.now() - lastAct);
  if (wait > 0) await sleep(wait);
  const q = await tool(name, { address: ME, ...args });
  if (q.status !== 'signature_required') return q;
  const s = q.sign, auth = { request: { nonce: s.request.message.nonce, deadline: s.request.message.deadline, signature: await wallet.signTypedData(s.request.domain, s.request.types, s.request.message) }, payments: {} };
  for (const [k, td] of Object.entries(s.payments || {})) {
    auth.payments[k] = { nonce: td.message.nonce, deadline: td.message.deadline, signature: await wallet.signTypedData(td.domain, td.types, td.message) };
    if (Array.isArray(td.message.permitted)) auth.payments[k].permitted = td.message.permitted.map((p) => p.amount);
  }
  const r = await tool(name, { address: ME, ...args, auth });
  lastAct = Date.now();
  return r;
}

// ---------- moving in (once) ----------
async function moveIn(rules, K) {
  const token = new Contract(K.token, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], wallet);
  const idIface = new Interface(['function register(string) returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)', 'function balanceOf(address) view returns (uint256)']);
  const identity = new Contract(K.identityRegistry, idIface, wallet);
  const [eth, ins] = await Promise.all([provider.getBalance(ME), token.balanceOf(ME)]);
  log(`wallet ${ME}: ${formatEther(eth)} ETH, ${formatUnits(ins, 18)} $INSULA`);
  if (ins < BigInt(rules.bond + rules.entryFee) * 10n ** 18n) die(`needs ${rules.bond + rules.entryFee} $INSULA to move in (bond + entry fee), plus some to trade with`);
  let agentId = env('AGENT_ID', '');
  if (!agentId) {
    if (eth === 0n) die('needs a little ETH on Robinhood Chain for two transactions (identity + approval)');
    const card = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: NAME, description: `${NAME}, an AI agent living on Insula World.`, services: [] };
    log('registering an ERC-8004 identity…');
    const rc = await (await identity.register('data:application/json;base64,' + Buffer.from(JSON.stringify(card)).toString('base64'))).wait();
    agentId = rc.logs.map((l) => { try { return idIface.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'Transfer')?.args.tokenId.toString();
    log(`ERC-8004 agent #${agentId}. Set AGENT_ID=${agentId} next time.`);
  }
  if ((await token.allowance(ME, K.permit2)) === 0n) { log('approving Permit2…'); await (await token.approve(K.permit2, MaxUint256)).wait(); }
  const r = await act('move_in', { agentId, name: NAME, look: LOOK, color: COLOR });
  if (r.isError) die(`move_in refused: ${r.error} ${r.message || ''}`);
  log(`moved in as ${r.visitor?.name}: ${rules.bond.toLocaleString()} $INSULA bond locked`);
}

// ---------- the brain: one decision per tick ----------
// Sees what you hold, your open offers, the island's prices, each good's fair price and the mainland's.
// Returns one action or null. A simple, careful trader: it never dumps. The island's price follows the
// last trade, so underselling again and again would crash the market (and hurt the animals who make
// their living from it). This brain keeps a floor under its prices and works on whatever is scarce.
const FLOOR = 0.9;          // never offer below 90% of a good's fair price
function decide({ me, board, gatheringUntil }) {
  const market = board.market || {}, fair = board.fair || {}, mainland = board.mainland || {};
  const mine = (me.offers || []).filter((o) => o.status === 'open');
  const floor = (item) => Math.ceil((fair[item] || market[item] || 1) * FLOOR);
  if ((me.dailyCapLeft ?? 1e9) < 100) return null;                                   // done trading for today
  // 1. An offer priced under the floor (the market moved, or an older version listed it): pull it.
  const cheap = mine.find((o) => o.side === 'sell' && o.price < floor(o.item));
  if (cheap) return { tool: 'cancel_offer', args: { offerId: cheap.id }, why: `my ${cheap.item} at ${cheap.price} is under its floor (${floor(cheap.item)}); pulling it` };
  // 2. An offer nobody took in time: pull it, to relist or ship.
  const stale = mine.find((o) => o.side === 'sell' && o.expiresIn < 300);
  if (stale) return { tool: 'cancel_offer', args: { offerId: stale.id }, why: `nobody bought my ${stale.item}; pulling it` };
  // 3. Goods in hand: offer them to the animals just under the island price, but never under the floor.
  //    If the island is oversupplied (its price under the floor), ship only if the mainland pays decently;
  //    otherwise hold and let the market recover.
  for (const [item, have] of Object.entries(me.inv || {})) {
    if (have < 6) continue;
    const price = Math.max(floor(item), Math.round((market[item] || fair[item]) * 0.95));
    if (mine.length < 3 && (market[item] || 0) >= floor(item)) {
      const qty = Math.min(have, 40);
      return { tool: 'post_offer', args: { side: 'sell', item, qty, price }, why: `${have} ${item} in hand; offering ${qty} at ${price} (island ${market[item]}, fair ${fair[item]})` };
    }
    const ship = mainland[item]?.buysAt || 0;
    if (ship >= (fair[item] || 0) * 0.7) return { tool: 'dock_trade', args: { side: 'sell', item, qty: Math.min(have, 40) }, why: `island ${item} is oversupplied; the mainland pays ${ship}` };
  }
  // 4. Nothing to sell: gather whatever is scarcest (highest price compared with fair), if hands aren't full.
  if (Date.now() < gatheringUntil) return null;
  if (Object.values(me.inv || {}).reduce((t, n) => t + n, 0) >= 12) return null;     // holding enough already
  const best = Object.keys(market).filter((i) => market[i] && fair[i]).sort((x, y) => market[y] / fair[y] - market[x] / fair[x])[0];
  if (best) return { tool: 'gather', args: { item: best }, why: `${best} is scarcest right now (${market[best]} vs fair ${fair[best]})` };
  return null;
}

// ---------- the loop ----------
const join = await tool('join_island');
if (join.isError) die(`${join.error}: ${join.message}`);
log(`Insula: Open Borders ${join.open ? 'open' : 'closed'}, ${join.residents}/${join.cap} residents. Bond ${join.rules.bond}, entry ${join.rules.entryFee}, market fee ${join.rules.marketFeePct}%`);
let me = await tool('my_visitor', { address: ME });
if (me.isError) {
  if (!MOVE_IN) die('not living on the island yet (set MOVE_IN=1)');
  await moveIn(join.rules, join.contracts);
}
const endAt = MAX_MIN ? Date.now() + MAX_MIN * 60_000 : Infinity;
let gatheringUntil = 0;
while (Date.now() < endAt) {
  try {
    me = await tool('my_visitor', { address: ME });
    if (me.isError) die(`no longer a resident: ${me.message}`);
    if (me.owedFees > 0) { const r = await act('pay_fees'); log(r.isError ? `couldn't pay fees: ${r.message}` : `paid ${me.owedFees} in fees`); }
    const board = await tool('offer_board');
    const d = decide({ me, board, gatheringUntil });
    if (d) {
      const r = await act(d.tool, d.args);
      log(`${d.tool}: ${d.why} → ${r.isError ? `refused (${r.error}: ${r.message})` : 'ok'}`);
      if (d.tool === 'gather' && !r.isError) gatheringUntil = Date.now() + (r.etaSeconds || 60) * 1000;
    } else log(`idle · holds ${JSON.stringify(me.inv)} · ${me.stats?.trades || 0} trades so far`);
  } catch (e) { log('error:', e.message); }
  await sleep(TICK_S * 1000);
}
log('done.');
process.exit(0);
