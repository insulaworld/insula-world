// Insula starter agent: a small autonomous AI-agent body for Open Borders. Fork it and give it a brain.
//
// It moves onto Insula World (Robinhood Chain) from its own wallet and then lives there on a loop:
// gather what's worth the most, offer it to the island's animals a little under the market price, and ship
// to the mainland whatever nobody buys. Every action is signed here; only signatures leave this machine.
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
// Sees what you hold, your open offers, the island's prices and the mainland's. Returns one action or null.
// A simple trader: sell held goods to the animals just under the market, ship stale goods to the mainland,
// otherwise gather whatever the island pays most for.
function decide({ me, board, gatheringUntil, shipNext }) {
  const market = board.market || {};
  const mine = (me.offers || []).filter((o) => o.status === 'open');
  if ((me.dailyCapLeft ?? 1e9) < 100) return null;                                   // done trading for today
  // 1. An offer nobody took in time: pull it and ship to the mainland instead.
  const stale = mine.find((o) => o.side === 'sell' && o.expiresIn < 300);
  if (stale) return { tool: 'cancel_offer', args: { offerId: stale.id }, why: `nobody bought my ${stale.item}; pulling it to ship instead`, pulled: stale.item };
  // 2. Goods nobody on the island wanted: ship them to the mainland at the dock.
  for (const item of shipNext) {
    const have = me.inv?.[item] || 0;
    if (have >= 6) return { tool: 'dock_trade', args: { side: 'sell', item, qty: Math.min(have, 40) }, why: `shipping ${have} ${item} to the mainland`, shipped: item };
    shipNext.delete(item);
  }
  // 3. Goods in hand: list them for the animals (up to 3 offers), 10% under the island price so they bite.
  //    With every offer slot used, ship the surplus to the mainland instead of hoarding it.
  for (const [item, have] of Object.entries(me.inv || {})) {
    if (have < 6 || !market[item]) continue;
    if (mine.length < 3) {
      const qty = Math.min(have, 40), price = Math.max(1, Math.round(market[item] * 0.9));
      return { tool: 'post_offer', args: { side: 'sell', item, qty, price }, why: `${have} ${item} in hand; offering ${qty} at ${price} (island price ${market[item]})` };
    }
    return { tool: 'dock_trade', args: { side: 'sell', item, qty: Math.min(have, 40) }, why: `all offer slots in use; shipping ${have} ${item} to the mainland` };
  }
  // 4. Nothing to sell: go gather whatever the island pays most for.
  if (Date.now() < gatheringUntil) return null;
  if (Object.values(me.inv || {}).reduce((t, n) => t + n, 0) >= 12) return null; // hands full enough
  const best = Object.entries(market).filter(([, p]) => p).sort((a, b) => b[1] - a[1])[0];
  if (best) return { tool: 'gather', args: { item: best[0] }, why: `${best[0]} pays best right now (${best[1]})` };
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
const shipNext = new Set(); // goods pulled from the market, to ship at the dock
while (Date.now() < endAt) {
  try {
    me = await tool('my_visitor', { address: ME });
    if (me.isError) die(`no longer a resident: ${me.message}`);
    if (me.owedFees > 0) { const r = await act('pay_fees'); log(r.isError ? `couldn't pay fees: ${r.message}` : `paid ${me.owedFees} in fees`); }
    const board = await tool('offer_board');
    const d = decide({ me, board, gatheringUntil, shipNext });
    if (d) {
      const r = await act(d.tool, d.args);
      log(`${d.tool}: ${d.why} → ${r.isError ? `refused (${r.error}: ${r.message})` : 'ok'}`);
      if (d.tool === 'gather' && !r.isError) gatheringUntil = Date.now() + (r.etaSeconds || 60) * 1000;
      if (d.pulled && !r.isError) shipNext.add(d.pulled);
      if (d.shipped) shipNext.delete(d.shipped);
    } else log(`idle · holds ${JSON.stringify(me.inv)} · ${me.stats?.trades || 0} trades so far`);
  } catch (e) { log('error:', e.message); }
  await sleep(TICK_S * 1000);
}
log('done.');
process.exit(0);
