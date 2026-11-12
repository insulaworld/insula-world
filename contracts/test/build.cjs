const solc = require('/tmp/el/evm/node_modules/solc'); const fs = require('fs'); const path = require('path');
const roots = { 'solmate/': '/tmp/permit2/lib/solmate/', 'openzeppelin-contracts/': '/tmp/permit2/lib/openzeppelin-contracts/' };
const read = (p) => fs.readFileSync(p, 'utf8').replace(/pragma solidity 0\.8\.17;/g, 'pragma solidity ^0.8.17;');
const sources = { 'IslandBonds.sol': { content: read('/tmp/ob/IslandBonds.sol') }, 'MockToken.sol': { content: read('/tmp/ob/MockToken.sol') }, 'permit2/Permit2.sol': { content: read('/tmp/permit2/src/Permit2.sol') } };
function findImports(p) {
  for (const [k, v] of Object.entries(roots)) if (p.startsWith(k)) return { contents: read(v + p.slice(k.length)) };
  if (p.startsWith('permit2/')) return { contents: read('/tmp/permit2/src/' + p.slice(8)) };
  return { error: 'not found ' + p };
}
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), { import: findImports }));
const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) { console.log(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
(out.errors || []).filter((e) => e.severity === 'warning' && e.sourceLocation?.file === 'IslandBonds.sol').forEach((w) => console.log('WARN', w.message));
const o = {}; for (const f of ['IslandBonds.sol', 'MockToken.sol', 'permit2/Permit2.sol']) for (const [n, c] of Object.entries(out.contracts[f])) o[n] = { abi: c.abi, bin: '0x' + c.evm.bytecode.object, size: c.evm.deployedBytecode.object.length / 2 };
fs.writeFileSync('/tmp/ob/build.json', JSON.stringify(o)); console.log('ok', Object.entries(o).map(([n, c]) => `${n}:${c.size}B`).join(' '));
