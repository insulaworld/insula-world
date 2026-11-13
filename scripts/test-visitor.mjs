// The Open Borders test agent: moves ONE outside agent onto Insula from a fresh wallet and walks it through
// everything a visitor can do, signing each step locally. For the cap-1 soft launch.
//
//   node scripts/test-visitor.mjs status                    what this wallet has and whether it lives on the island
//   node scripts/test-visitor.mjs setup                     register an ERC-8004 identity + approve Permit2 (2 small transactions)
//   node scripts/test-visitor.mjs move-in [name]            lock the bond and pay the entry fee (signatures only)
//   node scripts/test-visitor.mjs tour                      a full test run: dock buy, offer to the animals, gather, dock sell
//   node scripts/test-visitor.mjs board | me                the offer board / this agent's status
//   node scripts/test-visitor.mjs dock buy|sell <item> <qty>
//   node scripts/test-visitor.mjs offer buy|sell <item> <qty> <price>
//   node scripts/test-visitor.mjs cancel <offerId> | gather <item> | pay-fees
//   node scripts/test-visitor.mjs leave                     move out + requestLeave() on the bond contract
//   node scripts/test-visitor.mjs withdraw                  after the cooling-off period: get the bond back
//
// The wallet's private key is typed at a hidden prompt (or read from VISITOR_KEY) and never leaves this computer:
// the script signs here and sends only signatures to insulaworld.com. Fund the wallet from the Insula dev wallet,
// never a personal one: ERC-8004 identities and transfers are public and permanent.
import fs from 'node:fs';
import readline from 'node:readline';
import { JsonRpcProvider, Wallet, Contract, formatUnits, formatEther, MaxUint256, Interface } from 'ethers';

const env = (k, d) => process.env[k] || d;
const SITE = env('SITE', 'https://insulaworld.com').replace(/\/$/, '');
const RPC = env('RPC', 'https://rpc.mainnet.chain.robinhood.com');
const STATE = env('VISITOR_STATE', 'test-visitor.json'); // address + agent id only, never the key
const NAME = env('VISITOR_NAME', 'Nova');
const [cmd = 'status', ...args] = process.argv.slice(2);

const say = (...a) => console.log(...a);
const fail = (m) => { console.error(`\n  STOP: ${m}\n`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (x) => Number(formatUnits(x, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 });

function hidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

// ---- the island's MCP server ----
let rid = 1;
async function rpc(method, params) {
  const r = await fetch(`${SITE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:')).slice(5) : text); } catch { fail(`unexpected reply from ${SITE}/mcp: ${text.slice(0, 200)}`); }
  if (j.error) fail(`${method}: ${j.error.message}`);
  return j.result;
}
async function tool(name, a = {}) {
  const r = await rpc('tools/call', { name, arguments: a });
  const out = { ...(r.structuredContent || {}), isError: r.isError };
  if (!r.structuredContent) { try { Object.assign(out, JSON.parse(r.content?.[0]?.text || '{}')); } catch { out.text = r.content?.[0]?.text; } }
  return out;
}

// ---- wallet ----
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const key = env('VISITOR_KEY', '') || await hidden('Private key of the TEST agent wallet (hidden, stays on this computer): ');
let wallet;
try { wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider); } catch { fail('that is not a private key'); }
const A = wallet.address;
const saved = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
if (saved.address && saved.address !== A) fail(`${STATE} belongs to ${saved.address}, not ${A}. Use the same wallet, or set VISITOR_STATE to a new file.`);
const save = (patch) => { Object.assign(saved, { address: A }, patch); fs.writeFileSync(STATE, JSON.stringify(saved, null, 2)); };

const join = await tool('join_island');
if (join.isError) fail(`the island says: ${join.error || join.message || join.text}. Is OPEN_BORDERS on?`);
const K = join.contracts || fail('the island did not name its contracts');
const token = new Contract(K.token, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], wallet);
const bonds = new Contract(K.bonds, ['function bonds(address) view returns (uint256 amount, uint64 leavingAt, bool leaving)', 'function requestLeave()', 'function withdraw()', 'function cooldown() view returns (uint256)'], wallet);
const idIface = new Interface(['function register(string agentURI) returns (uint256 agentId)', 'function ownerOf(uint256) view returns (address)', 'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const identity = new Contract(K.identityRegistry, idIface, wallet);

async function signAll(s) {
  const auth = { request: { nonce: s.sign.request.message.nonce, deadline: s.sign.request.message.deadline, signature: await wallet.signTypedData(s.sign.request.domain, s.sign.request.types, s.sign.request.message) }, payments: {} };
  for (const [k, td] of Object.entries(s.sign.payments || {})) {
    // Show what each payment can take, before signing it.
    const amounts = Array.isArray(td.message.permitted) ? td.message.permitted.map((p) => p.amount) : [td.message.permitted?.amount ?? td.message.amount].filter(Boolean);
    say(`    signing ${k}: up to ${amounts.map((x) => C(BigInt(x))).join(' + ')} $INSULA`);
    auth.payments[k] = { nonce: td.message.nonce, deadline: td.message.deadline, signature: await wallet.signTypedData(td.domain, td.types, td.message) };
    if (Array.isArray(td.message.permitted)) auth.payments[k].permitted = td.message.permitted.map((p) => p.amount);
  }
  return auth;
}
async function signed(name, a) {
  const s = await tool(name, { address: A, ...a });
  if (s.status !== 'signature_required') return s;
  return tool(name, { address: A, ...a, auth: await signAll(s) });
}
const show = (label, r) => {
  if (r.isError) { say(`  ✗ ${label}: ${r.error || ''} ${r.message || r.text || ''}`.trim()); return false; }
  say(`  ✓ ${label}`);
  const brief = { ...r }; delete brief.isError;
  say('    ' + JSON.stringify(brief).slice(0, 400));
  return true;
};

const chainNow = async () => Number((await provider.getBlock('latest')).timestamp);
const freeAt = async (b) => new Date((Number(b.leavingAt) + Number(await bonds.cooldown())) * 1000).toLocaleString();
async function status() {
  const [eth, ins, allow, bond] = await Promise.all([provider.getBalance(A), token.balanceOf(A), token.allowance(A, K.permit2), bonds.bonds(A).catch(() => null)]);
  say(`\n  test agent  ${A}`);
  say(`  ETH         ${formatEther(eth)}`);
  say(`  $INSULA     ${C(ins)}   (needs ${(join.rules.bond + join.rules.entryFee).toLocaleString('en-US')} to move in, plus ~10,000 to trade with)`);
  say(`  Permit2     ${allow > 0n ? 'approved' : 'not approved yet'}`);
  say(`  identity    ${saved.agentId ? `ERC-8004 #${saved.agentId}` : 'not registered yet'}`);
  if (bond) say(`  bond        ${C(bond.amount)} locked${bond.leaving ? `, leaving (withdraw after ${await freeAt(bond)})` : ''}`);
  say(`  island      Open Borders ${join.open ? 'OPEN' : 'closed'}, ${join.residents}/${join.cap} residents`);
  const me = await tool('my_visitor', { address: A });
  if (!me.isError) say(`  on island   ${me.name} · ${me.status} · holds ${JSON.stringify(me.inv || {})}`);
  return { eth, ins, allow };
}

async function setup() {
  const { eth, ins, allow } = await status();
  if (eth === 0n) fail('the wallet has no ETH. Send it a little (about 0.0005 ETH) from the Insula dev wallet for two small transactions.');
  if (ins < BigInt(join.rules.bond + join.rules.entryFee) * 10n ** 18n) say(`  note: send at least ${(join.rules.bond + join.rules.entryFee).toLocaleString('en-US')} $INSULA before move-in.`);
  if (!saved.agentId) {
    const card = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: NAME, description: 'Test visitor on Insula World (Open Borders soft launch).', image: '', services: [] };
    const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(card)).toString('base64');
    say('\n  registering an ERC-8004 identity…');
    const tx = await identity.register(uri);
    const rc = await tx.wait();
    const log = rc.logs.map((l) => { try { return idIface.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'Transfer' && p.args.to === A);
    if (!log) fail(`registered (${tx.hash}) but no agent id in the receipt`);
    save({ agentId: log.args.tokenId.toString(), identityTx: tx.hash });
    say(`  ✓ ERC-8004 agent #${saved.agentId}  (tx ${tx.hash})`);
  }
  if (allow === 0n) {
    say('  approving Permit2 to move $INSULA (the island only ever takes what you sign)…');
    const tx = await token.approve(K.permit2, MaxUint256);
    await tx.wait();
    say(`  ✓ Permit2 approved  (tx ${tx.hash})`);
  }
  say('\n  setup done. Next: move-in');
}

async function moveIn(name = NAME) {
  if (!saved.agentId) fail('run setup first (no ERC-8004 identity yet)');
  say(`\n  moving in as ${name}…`);
  const r = await signed('move_in', { agentId: saved.agentId, name, look: 'robot', color: '#7BE3A3' });
  if (show('moved in', r)) save({ movedInAt: new Date().toISOString() });
}

async function me() { const r = await tool('my_visitor', { address: A }); show('my status', r); return r; }

async function tour() {
  say('\n  TEST TOUR: dock buy → offer to the animals → gather → dock sell');
  const spare = await token.balanceOf(A);
  if (spare < 500n * 10n ** 18n) fail(`only ${C(spare)} $INSULA left after moving in. Send ~10,000 more to trade with, then run tour again.`);
  const board = await tool('offer_board');
  show('offer board', board);
  const m = board.market || {};
  // 1. Buy 6 fish from the mainland.
  show('dock: buy 6 fish', await signed('dock_trade', { side: 'buy', item: 'fish', qty: 6 }));
  // 2. Offer those 6 fish to the animals, a touch under the island price so someone takes it.
  const price = Math.max(1, Math.round((m.fish || 12) * 0.95));
  const o = await signed('post_offer', { side: 'sell', item: 'fish', qty: 6, price });
  show(`offer: sell 6 fish at ${price}`, o);
  // 3. Wait for an animal to take it (up to WAIT_MIN minutes).
  const until = Date.now() + Number(env('WAIT_MIN', 10)) * 60_000;
  say(`  waiting up to ${env('WAIT_MIN', 10)} min for an animal to take the offer…`);
  let filled = false;
  while (Date.now() < until) {
    const s = await tool('my_visitor', { address: A });
    if (!s.isError && !(s.offers || []).some((x) => x.status === 'open' || x.open)) { filled = true; break; }
    await sleep(20_000);
  }
  say(filled ? '  ✓ the offer closed (taken or expired, see my status)' : '  … still open; it will expire on its own (cancel <offerId> to pull it)');
  // 4. Gather a load of ore, then sell it at the dock.
  const g = await signed('gather', { item: 'ore' });
  show('gather ore', g);
  const want = g.qty || 8;
  say(`  waiting for the trip to finish (about ${g.etaSeconds || 60}s)…`);
  for (let i = 0; i < 40; i++) { const s = await tool('my_visitor', { address: A }); if ((s.inv?.ore || 0) >= want) break; await sleep(Math.max(3000, ((g.etaSeconds || 60) * 1000) / 10)); }
  const s = await tool('my_visitor', { address: A });
  if ((s.inv?.ore || 0) > 0) show(`dock: sell ${s.inv.ore} ore`, await signed('dock_trade', { side: 'sell', item: 'ore', qty: s.inv.ore }));
  await me();
  say('\n  tour done. Watch the robot on insulaworld.com. When you are finished testing: leave');
}

async function leave() {
  show('move out', await signed('move_out', {}));
  const b = await bonds.bonds(A);
  if (b.amount > 0n && !b.leaving) {
    say('  requestLeave() on the bond contract…');
    const tx = await bonds.requestLeave();
    await tx.wait();
    say(`  ✓ leaving; withdraw after ${await freeAt(await bonds.bonds(A))}  (tx ${tx.hash})`);
  }
}

async function withdraw() {
  const b = await bonds.bonds(A);
  if (!b.leaving) fail('call leave first');
  if (await chainNow() < Number(b.leavingAt) + Number(await bonds.cooldown())) fail(`the cooling-off period ends ${await freeAt(b)}`);
  const tx = await bonds.withdraw();
  await tx.wait();
  say(`  ✓ bond withdrawn (tx ${tx.hash}). Balance now ${C(await token.balanceOf(A))} $INSULA`);
}

const int = (x, what) => { const n = Number(x); if (!Number.isInteger(n) || n <= 0) fail(`${what} must be a whole number`); return n; };
switch (cmd) {
  case 'status': await status(); break;
  case 'setup': await setup(); break;
  case 'move-in': await moveIn(args[0]); break;
  case 'tour': await tour(); break;
  case 'board': show('offer board', await tool('offer_board')); break;
  case 'me': await me(); break;
  case 'dock': show(`dock ${args[0]} ${args[2]} ${args[1]}`, await signed('dock_trade', { side: args[0], item: args[1], qty: int(args[2], 'qty') })); break;
  case 'offer': show('post offer', await signed('post_offer', { side: args[0], item: args[1], qty: int(args[2], 'qty'), price: int(args[3], 'price') })); break;
  case 'cancel': show('cancel offer', await signed('cancel_offer', { offerId: args[0] })); break;
  case 'gather': show(`gather ${args[0]}`, await signed('gather', { item: args[0] })); break;
  case 'pay-fees': show('pay fees', await signed('pay_fees', {})); break;
  case 'leave': await leave(); break;
  case 'withdraw': await withdraw(); break;
  default: fail(`unknown command "${cmd}". Try: status, setup, move-in, tour, board, me, dock, offer, cancel, gather, pay-fees, leave, withdraw`);
}
process.exit(0);
