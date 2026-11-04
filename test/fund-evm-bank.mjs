// Rehearsal helper: plays "you" on launch day, sending ETH and tokens from your wallet to the bank.
// Usage: EVM_RPC=<url> EVM_FUNDER_KEY=<0x key> node test/fund-evm-bank.mjs <token> <bank> <eth> <coins>
import { JsonRpcProvider, Wallet, Contract, parseEther, parseUnits } from 'ethers';
const [token, bank, eth, coins] = process.argv.slice(2);
const funder = new Wallet(process.env.EVM_FUNDER_KEY, new JsonRpcProvider(process.env.EVM_RPC));
let nonce = await funder.getNonce('latest');
if (+eth > 0) await (await funder.sendTransaction({ to: bank, value: parseEther(eth), nonce: nonce++ })).wait();
const t = new Contract(token, ['function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'], funder);
if (+coins > 0) await (await t.transfer(bank, parseUnits(coins, await t.decimals()), { nonce: nonce++ })).wait();
console.log('funded bank', bank, eth, 'ETH +', coins, 'tokens');
