// Deploys IslandBonds (the Open Borders residency bond contract) to Robinhood Chain from YOUR wallet.
//
//   node scripts/deploy-bonds.mjs          dry run: checks the chain, the token, Permit2 and the settings, deploys nothing
//   node scripts/deploy-bonds.mjs --go     deploys, with the burn address and the animals listed as payees from the start
//
// Your private key is typed at a hidden prompt (or read from DEPLOYER_KEY) and never leaves this computer.
// The deployer becomes the owner unless OWNER is set (a separate, safer wallet is better: the owner can change
// the operator and payees (new ones only after a 31-day delay), change settings within the hard limits and pause
// new deposits).
// The operator (who can slash, within the caps) is the island's bank wallet, which the server already holds.
//
// Afterwards: put the printed BONDS_ADDRESS in fly.toml, deploy, and leave OPEN_BORDERS off until the outside review.
import fs from 'node:fs';
import readline from 'node:readline';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, getAddress, parseUnits, formatEther, isAddress } from 'ethers';

const env = (k, d) => process.env[k] || d;
const GO = process.argv.includes('--go');
const RPC = env('RPC', 'https://rpc.mainnet.chain.robinhood.com');
const CHAIN_ID = BigInt(env('CHAIN_ID', '4663'));
const TOKEN = env('TOKEN', '0x090980a62D5007F6190b04782d0ea690ab53c210');           // $INSULA
const PERMIT2 = env('PERMIT2', '0x000000000022D473030F116dDEE9F6B43aC78BA3');        // canonical Permit2
const BANK = env('BANK', '0x449D88802D7EDA208F02a8026762da4fbe1a5c7c');              // the island's bank (also the operator)
const OPERATOR = env('OPERATOR', BANK);
const SITE = env('SITE', 'https://insulaworld.com');
const BURN = '0x000000000000000000000000000000000000dEaD';
const DAY = 86_400;

// Settings, in whole $INSULA. The hard limits can never be raised after deployment.
const S = {
  minBond: Number(env('MIN_BOND', 100_000)),          // the residency bond
  maxBond: Number(env('MAX_BOND', 250_000)),          // room for a bigger bond in later phases
  totalCap: Number(env('TOTAL_CAP', 5_000_000)),      // 50 residents x 100,000 at launch
  maxSlash: Number(env('MAX_SLASH', 50_000)),         // per slash
  dailySlashCap: Number(env('DAILY_SLASH_CAP', 200_000)),
  cooldownDays: Number(env('COOLDOWN_DAYS', 7)),
  hardMaxSlash: Number(env('HARD_MAX_SLASH', 250_000)),
  hardDailySlashCap: Number(env('HARD_DAILY_SLASH_CAP', 1_000_000)),
};

const art = JSON.parse(fs.readFileSync(new URL('../contracts/build/IslandBonds.json', import.meta.url)));
const ERC20 = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
const say = (s) => console.log(s);
const fail = (s) => { console.error(`\nSTOP: ${s}`); process.exit(1); };

function hidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 }); // no cached nonces between our transactions
const net = await provider.getNetwork().catch((e) => fail(`can't reach ${RPC}: ${e.message}`));
if (net.chainId !== CHAIN_ID) fail(`chain ${net.chainId} is not ${CHAIN_ID}`);
for (const [n, a] of Object.entries({ TOKEN, PERMIT2, BANK, OPERATOR })) if (!isAddress(a)) fail(`${n} is not an address`);
if ((await provider.getCode(PERMIT2)) === '0x') fail(`no Permit2 at ${PERMIT2}`);
if ((await provider.getCode(TOKEN)) === '0x') fail(`no token at ${TOKEN}`);
const token = new Contract(TOKEN, ERC20, provider);
const decimals = Number(await token.decimals());
const symbol = await token.symbol();
const u = (n) => parseUnits(String(n), decimals);

// The animals' wallets become payees, so a slash can pay a victim directly.
let animals = [];
try {
  const st = await (await fetch(`${SITE}/api/state`)).json();
  animals = st.agents.filter((a) => isAddress(a.address)).map((a) => ({ name: a.name, address: getAddress(a.address) }));
} catch (e) { say(`(couldn't read the animals from ${SITE}: ${e.message}; they can be added later with setPayee)`); }

say(`IslandBonds deploy ${GO ? '' : '(DRY RUN) '}on chain ${net.chainId} via ${RPC}`);
say(`  token     ${symbol} ${TOKEN} (${decimals} decimals)`);
say(`  Permit2   ${PERMIT2}`);
say(`  bank      ${BANK}`);
say(`  operator  ${OPERATOR}${OPERATOR === BANK ? ' (the bank)' : ''}`);
say(`  bond ${S.minBond.toLocaleString()} (max ${S.maxBond.toLocaleString()}), total cap ${S.totalCap.toLocaleString()}, slash ${S.maxSlash.toLocaleString()} per event / ${S.dailySlashCap.toLocaleString()} a day, cooling-off ${S.cooldownDays} days`);
say(`  hard limits (permanent): slash ${S.hardMaxSlash.toLocaleString()} per event, ${S.hardDailySlashCap.toLocaleString()} a day`);
say(`  payees     burn address + ${animals.length} animals${animals.length ? ` (${animals.map((a) => a.name).join(', ')})` : ''}`);
say(`  contract   ${art.deployedSize} bytes, ${art.compiler}`);

const key = env('DEPLOYER_KEY', '') || await hidden('Private key of the deploying wallet (hidden, stays on this computer): ');
let wallet;
try { wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider); } catch { fail('that is not a private key'); }
const OWNER = getAddress(env('OWNER', wallet.address));
const eth = await provider.getBalance(wallet.address);
say(`  deployer  ${wallet.address} (${formatEther(eth)} ETH)`);
say(`  owner     ${OWNER}${OWNER === wallet.address ? ' (the deployer)' : ''}`);
if (OWNER === getAddress(OPERATOR)) fail('the owner and the operator should be different wallets');

const payees = [BURN, ...animals.map((a) => a.address)];
const args = [TOKEN, PERMIT2, BANK, OWNER, OPERATOR, u(S.minBond), u(S.maxBond), u(S.totalCap), u(S.maxSlash), u(S.dailySlashCap), BigInt(S.cooldownDays * DAY), u(S.hardMaxSlash), u(S.hardDailySlashCap), payees];
const factory = new ContractFactory(art.abi, art.bytecode, wallet);
const deployTx = await factory.getDeployTransaction(...args);
const gas = await provider.estimateGas({ ...deployTx, from: wallet.address }).catch((e) => fail(`the deployment would fail: ${e.shortMessage || e.message}`));
const fee = await provider.getFeeData();
const cost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
say(`  gas       about ${gas} (up to ${formatEther(cost)} ETH)`);
if (eth < cost * 2n) fail('not enough ETH in the deploying wallet for the deployment and the payee transactions');
if (!GO) { say('\nDry run OK. Run again with --go to deploy.'); process.exit(0); }
if (!animals.length && !process.env.NO_ANIMALS) fail(`couldn't read the animals' wallets from ${SITE}; they must be listed at deployment (adding them later takes 31 days). Set NO_ANIMALS=1 to deploy anyway.`);

const c = await factory.deploy(...args);
say(`\nDeploying: ${c.deploymentTransaction().hash}`);
await c.waitForDeployment();
const at = await c.getAddress();
say(`Deployed at ${at}`);
for (const p of payees) if (!(await c.payees(p))) fail(`payee ${p} is not listed`);
say(`  payees listed: burn address${animals.length ? ` and ${animals.map((a) => a.name).join(', ')}` : ''}`);
// Read it back.
const check = await Promise.all([c.token(), c.permit2(), c.bank(), c.owner(), c.operator(), c.minBond(), c.cooldown(), c.payees(BURN)]);
say(`Checked: token ${check[0]}, Permit2 ${check[1]}, bank ${check[2]}, owner ${check[3]}, operator ${check[4]}, bond ${check[5] / 10n ** BigInt(decimals)}, cooling-off ${Number(check[6]) / DAY} days, burn payee ${check[7]}`);
say(`\nBONDS_ADDRESS = "${at}"`);
say('Next: add that line under [env] in fly.toml (OPEN_BORDERS stays off), deploy, and verify the source on Blockscout with contracts/build/IslandBonds.standard-input.json.');
process.exit(0);
