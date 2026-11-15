// Adds the island's newer animals (like Gus) as payees on IslandBonds, so a slashed bond can pay them back
// as victims, the same as the original animals.
//
//   node scripts/add-payees.mjs              dry run: shows each animal as listed, queued or missing; sends nothing
//   node scripts/add-payees.mjs --go         queues every missing animal (one setPayee each, from the owner wallet)
//   node scripts/add-payees.mjs --activate   31 days later: switches on every queued animal whose wait is over
//
// Queueing waits 31 days on purpose (longer than any visitor's cooling-off), so visitors always see a new payee
// coming. The island's watchdog accepts animals being queued; anyone else being queued closes Open Borders.
// --go needs the owner (dev) wallet's key, typed at a hidden prompt (or OWNER_KEY); it never leaves this computer.
// --activate can be sent by any wallet with a little ETH.
import fs from 'node:fs';
import readline from 'node:readline';
import { JsonRpcProvider, Wallet, Contract, getAddress, isAddress, formatEther } from 'ethers';

const env = (k, d) => process.env[k] || d;
const GO = process.argv.includes('--go');
const ACTIVATE = process.argv.includes('--activate');
const RPC = env('RPC', 'https://rpc.mainnet.chain.robinhood.com');
const SITE = env('SITE', 'https://insulaworld.com');
const BONDS = env('BONDS_ADDRESS', '0x77116C1f6e1F945e41bf9F42b026b3e1c5FBD808');
const say = (s) => console.log(s);
const fail = (s) => { console.error(`\nSTOP: ${s}`); process.exit(1); };

function hidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const art = JSON.parse(fs.readFileSync(new URL('../contracts/build/IslandBonds.json', import.meta.url)));
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
await provider.getNetwork().catch((e) => fail(`can't reach ${RPC}: ${e.message}`));
if ((await provider.getCode(BONDS)) === '0x') fail(`no IslandBonds contract at ${BONDS}`);
const bonds = new Contract(BONDS, art.abi, provider);
const owner = getAddress(await bonds.owner());

let animals;
try {
  const st = await (await fetch(`${SITE}/api/state`)).json();
  animals = st.agents.filter((a) => isAddress(a.address)).map((a) => ({ name: a.name, address: getAddress(a.address) }));
} catch (e) { fail(`couldn't read the animals from ${SITE}: ${e.message}`); }

const now = Math.floor(Date.now() / 1000);
const day = (t) => new Date(t * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
say(`IslandBonds ${BONDS} (owner ${owner})${GO ? '' : ACTIVATE ? ' — activating' : ' — DRY RUN, nothing is sent'}`);
const missing = [], due = [];
for (const a of animals) {
  const [listed, at] = await Promise.all([bonds.payees(a.address), bonds.payeeAt(a.address)]);
  const when = Number(at);
  let state;
  if (listed) state = 'listed';
  else if (when) { state = when <= now ? 'queued, ready to activate' : `queued, active from ${day(when)}`; if (when <= now) due.push(a); }
  else { state = 'MISSING'; missing.push(a); }
  say(`  ${a.name.padEnd(8)} ${a.address}  ${state}`);
}

if (!GO && !ACTIVATE) {
  say(missing.length ? `\n${missing.length} to queue (${missing.map((a) => a.name).join(', ')}). Run again with --go, signing with the owner wallet.` : '\nEvery animal is listed or queued.');
  if (due.length) say(`${due.length} ready to activate: run with --activate.`);
  process.exit(0);
}

const list = GO ? missing : due;
if (!list.length) { say(GO ? '\nNothing to queue.' : '\nNothing ready to activate yet.'); process.exit(0); }
const key = env(GO ? 'OWNER_KEY' : 'SENDER_KEY', '') || await hidden(`Private key of the ${GO ? 'owner (dev)' : 'sending'} wallet (hidden, stays on this computer): `);
let wallet;
try { wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider); } catch { fail('that is not a private key'); }
if (GO && getAddress(wallet.address) !== owner) fail(`that wallet (${wallet.address}) is not the contract's owner (${owner})`);
say(`\nSending from ${wallet.address} (${formatEther(await provider.getBalance(wallet.address))} ETH)`);
const signed = bonds.connect(wallet);
for (const a of list) {
  const tx = GO ? await signed.setPayee(a.address, true) : await signed.activatePayee(a.address);
  await tx.wait();
  say(`  ${a.name}: ${GO ? 'queued' : 'activated'}  https://robinhoodchain.blockscout.com/tx/${tx.hash}`);
}
if (GO) {
  const at = Number(await bonds.payeeAt(list[0].address));
  say(`\nDone. They become payees after ${day(at)}: then run  node scripts/add-payees.mjs --activate`);
}
