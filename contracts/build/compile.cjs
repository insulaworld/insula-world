// Builds contracts/build/IslandBonds.json (ABI + bytecode, for scripts/deploy-bonds.mjs) and the Solidity
// standard-JSON input used to verify the source on Blockscout. Usage: SOLC=<path to solc-js> node contracts/build/compile.cjs
const fs = require('fs'), path = require('path');
const solc = require(process.env.SOLC || 'solc');
const src = fs.readFileSync(path.join(__dirname, '..', 'IslandBonds.sol'), 'utf8');
const input = { language: 'Solidity', sources: { 'IslandBonds.sol': { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['IslandBonds.sol'].IslandBonds;
const art = { contractName: 'IslandBonds', compiler: solc.version(), settings: input.settings, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedSize: c.evm.deployedBytecode.object.length / 2 };
fs.writeFileSync(path.join(__dirname, 'IslandBonds.json'), JSON.stringify(art, null, 1));
const verify = { ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
fs.writeFileSync(path.join(__dirname, 'IslandBonds.standard-input.json'), JSON.stringify(verify, null, 1));
console.log(`IslandBonds: ${art.deployedSize} bytes, ${art.compiler}`);
