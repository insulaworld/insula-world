// Multi-hour soak test on Robinhood Chain TESTNET, using what's left in the rehearsal wallet.
// Like the rehearsal (throwaway copy, your real wallets never touched), but the island runs for hours
// and every 10 minutes it checks every balance against the chain and writes a status line to
// soak-result.txt, so problems that only show up over time (nonces, gas top-ups, RPC limits) surface.
// Usage: node test/soak-robinhood.mjs [hours=3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, parseUnits, formatEther, formatUnits } from 'ethers';
import { NETWORKS } from '../server/chain-evm.js';

const HOURS = Number(process.argv[2] || 3);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NET = NETWORKS['robinhood-testnet'];
const envLine = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^RH_TESTNET_RPC=(.+)$/m) : null;
const RPC = process.env.RH_TESTNET_RPC || envLine?.[1].trim() || NET.rpcUrl;
const OUT = path.join(ROOT, 'soak-result.txt');
fs.writeFileSync(OUT, '');
const say = (s = '') => { const line = `[${new Date().toLocaleTimeString()}] ${s}`; console.log(line); fs.appendFileSync(OUT, line + '\n'); };

const wfile = path.join(ROOT, '.rehearsal', 'funder.json');
if (!fs.existsSync(wfile)) { say('No rehearsal wallet yet. Run insula-rehearsal.bat first.'); process.exit(1); }
const fkey = JSON.parse(fs.readFileSync(wfile, 'utf8'));
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: false });
const chainId = Number((await provider.getNetwork()).chainId);
if (chainId !== NET.chainId) { say(`${RPC} is chain ${chainId}, not Robinhood testnet.`); process.exit(1); }
// Earlier runs leave test ETH in their throwaway bank and agent wallets: sweep it back first.
let swept = 0n;
for (const name of fs.readdirSync(os.tmpdir()).filter((n) => /^insula-(soak|rehearsal)-/.test(n))) {
  const kdir = path.join(os.tmpdir(), name, '.keys');
  if (!fs.existsSync(kdir)) continue;
  for (const f of fs.readdirSync(kdir).filter((x) => x.endsWith('.json'))) {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(kdir, f), 'utf8'));
      if (!k.privateKey) continue;
      const w = new Wallet(k.privateKey, provider);
      const have = await provider.getBalance(w.address);
      if (have === 0n) continue;
      const fee = await provider.getFeeData();
      const price = (fee.gasPrice ?? 100_000_000n) * 2n;
      const gas = (await provider.estimateGas({ from: w.address, to: fkey.address, value: 1n })) * 2n;
      const value = have - gas * price;
      if (value <= 0n) continue;
      await (await w.sendTransaction({ to: fkey.address, value, gasLimit: gas, type: 2, maxFeePerGas: price, maxPriorityFeePerGas: 0n })).wait();
      swept += value;
    } catch (e) { /* a wallet we can't sweep is fine; move on */ }
  }
}
if (swept > 0n) say(`Swept ${formatEther(swept)} test ETH back from earlier test runs.`);
const bal = await provider.getBalance(fkey.address);
say(`Soak test: ${HOURS} hours on Robinhood testnet. Rehearsal wallet has ${formatEther(bal)} test ETH.`);
if (bal < 1_500_000_000_000_000n) { say('Needs at least 0.0015 test ETH. Top it up from the faucet and run again.'); process.exit(1); }
const funder = new NonceManager(new Wallet(fkey.privateKey, provider));

const run = (args, env, cwd) => {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', LLM: 'off', INSULA_SECRETS: '', CHAIN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve) => { let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('exit', (code) => resolve({ code, out })); });
  return { p, done };
};

// A stand-in token, the real setup in a throwaway copy, and all spare test ETH into the bank.
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'test-token.json'), 'utf8'));
const token = await (await new ContractFactory(art.abi, art.bytecode, funder).deploy('Insula Soak', 'INSK', parseUnits('1000000000', 18), 0)).waitForDeployment();
const tokenAddr = await token.getAddress();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insula-soak-'));
const skip = new Set(['node_modules', 'data', '.keys', '.rehearsal', '.env', 'chain-config.json', 'deploy-secrets.txt', 'fly-secrets.txt', '.flyapp']);
fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => {
  const rel = path.relative(ROOT, src).split(path.sep)[0];
  return !(skip.has(rel) || rel.startsWith('.keys-') || /^chain-config\..+\.json$/.test(rel) || /\.(mp4|zip|png|jpg)$/.test(rel));
} });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
fs.writeFileSync(path.join(tmp, '.env'), [`INSULA_TOKEN=${tokenAddr}`, 'RH_NETWORK=robinhood-testnet', `RH_RPC_URL=${RPC}`, 'INSULA_BUY_URL=https://example.com/soak', 'MIN_BANK_ETH=0.0008', 'MAX_GAS_GWEI=5'].join('\n') + '\n');
await run(['server/setup-robinhood.js'], {}, tmp).done;
const bankAddr = JSON.parse(fs.readFileSync(path.join(tmp, '.keys', 'bank.json'), 'utf8')).address;
const spare = (await provider.getBalance(fkey.address)) - 300_000_000_000_000n; // keep 0.0003 for these two sends
await (await funder.sendTransaction({ to: bankAddr, value: spare })).wait();
await (await token.connect(funder).transfer(bankAddr, parseUnits('4000000', 18))).wait();
const s2 = await run(['server/setup-robinhood.js'], {}, tmp).done;
if (!/Robinhood Chain setup done/.test(s2.out)) { say('Setup failed:'); say(s2.out.slice(-800)); process.exit(1); }
const bankStart = Number(formatEther(await provider.getBalance(bankAddr)));
say(`Bank funded with ${bankStart.toFixed(5)} test ETH and 4,000,000 test coins. Island starting.`);

// The island, for hours, with a health check every 10 minutes.
const PORT = '3988';
const island = run(['server/index.js'], { PORT, INSULA_SAVE: path.join(tmp, 'data', 'world.json') }, tmp);
const t = new Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const end = Date.now() + HOURS * 3600_000;
let problems = 0, stalls = 0;
const seenTrades = new Set(), seenErrors = new Set();
await new Promise((r) => setTimeout(r, 60_000));
for (let check = 1; ; check++) {
  try {
    const st = await get('/api/state');
    const hist = await get('/api/history');
    // The island keeps only its last 80 events, so collect new ones at each check.
    let newTrades = 0;
    for (const e of hist.filter((x) => x.type === 'trade')) if (!seenTrades.has(e.sig)) { seenTrades.add(e.sig); newTrades++; }
    const errors = hist.filter((x) => x.type === 'chainError' && !seenErrors.has(`${x.ts}${x.text}`));
    for (const e of errors) seenErrors.add(`${e.ts}${e.text}`);
    const trades = seenTrades.size;
    // Read the island, then the chain, then the island again: a trade landing mid-check shows up in one of
    // the two island reads, so only a balance that matches neither is a real mismatch.
    let mismatch = [];
    const rows = [...st.agents.filter((x) => x.address), { id: 'bank', name: 'Bank', balance: st.bank.balance, address: st.bank.address }];
    const chainBal = {};
    for (const a of rows) chainBal[a.address] = Number(formatUnits(await t.balanceOf(a.address), 18));
    const st2 = await get('/api/state');
    const after = Object.fromEntries([...st2.agents.map((x) => [x.address, x.balance]), [st2.bank.address, st2.bank.balance]]);
    for (const a of rows) {
      const on = chainBal[a.address], tol = a.name === 'Bank' ? 1 : 0.01;
      if (Math.abs(on - a.balance) > tol && Math.abs(on - (after[a.address] ?? a.balance)) > tol) mismatch.push(`${a.name} island ${a.balance}/${after[a.address]} vs chain ${on}`);
    }
    const eth = Number(formatEther(await provider.getBalance(bankAddr)));
    stalls = newTrades === 0 ? stalls + 1 : 0;
    const ok = !mismatch.length && !errors.length && stalls < 2;
    if (!ok) problems++;
    say(`check ${check}: ${ok ? 'OK' : 'PROBLEM'} | ${trades}+ trades (${newTrades} new) | ${errors.length} new payment errors | balances ${mismatch.length ? 'MISMATCH ' + mismatch.join('; ') : 'match'} | bank ETH ${eth.toFixed(6)} | agents ${st.agents.length} | decisions ${st.decisions}`);
    for (const e of errors.slice(-2)) say(`   error: ${e.text}`);
    if (eth < 0.00015) { say('Bank is nearly out of test ETH; ending early.'); break; }
  } catch (e) {
    problems++;
    say(`check ${check}: PROBLEM | couldn't read the island (${e.message})`);
  }
  if (Date.now() >= end) break;
  await new Promise((r) => setTimeout(r, Math.min(600_000, Math.max(1000, end - Date.now()))));
}
island.p.kill();
const log = (await island.done).out;
const warn = log.split('\n').filter((l) => /\[chain\]|Error|error/.test(l)).slice(-5);
for (const w of warn) say(`   server log: ${w.slice(0, 200)}`);
const ethEnd = Number(formatEther(await provider.getBalance(bankAddr)));
say(`Bank used ${(bankStart - ethEnd).toFixed(6)} test ETH (gas + top-ups held by agents) over the run.`);
say(problems ? `SOAK FINISHED WITH ${problems} PROBLEM CHECK(S): send Claude soak-result.txt.` : `PASS: ${HOURS}-hour soak on Robinhood testnet, every check clean.`);
