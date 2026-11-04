// Rehearsal helper: deploys a plain test token (1B supply, 18 decimals) to an EVM chain, minted to the funder.
// Usage: EVM_RPC=<url> EVM_FUNDER_KEY=<0x key> node test/make-evm-token.mjs [taxBps]
import fs from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, parseUnits } from 'ethers';
const art = JSON.parse(fs.readFileSync(new URL('./fixtures/test-token.json', import.meta.url)));
const funder = new Wallet(process.env.EVM_FUNDER_KEY, new JsonRpcProvider(process.env.EVM_RPC));
const c = await (await new ContractFactory(art.abi, art.bytecode, funder).deploy('Insula Rehearsal', 'INSR', parseUnits('1000000000', 18), Number(process.argv[2] || 0))).waitForDeployment();
console.log(await c.getAddress());
