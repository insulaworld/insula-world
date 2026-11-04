// Packs your wallets (.keys/) and chain-config.json into one secret, for hosting.
// Writes deploy-secrets.txt with a single line: INSULA_SECRETS=...
// Paste that line into your host's variables. Treat it like a password: it controls every wallet.
import fs from 'node:fs';
import path from 'node:path';

const keysDir = path.resolve('.keys');
const configPath = path.resolve('chain-config.json');
if (!fs.existsSync(configPath) || !fs.existsSync(keysDir)) {
  console.log('No wallets yet. Run "npm run setup" first.');
  process.exit(1);
}
const keys = {};
for (const f of fs.readdirSync(keysDir)) {
  if (f.endsWith('.json')) keys[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(keysDir, f), 'utf8'));
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const packed = Buffer.from(JSON.stringify({ config, keys })).toString('base64');
fs.writeFileSync('deploy-secrets.txt', `INSULA_SECRETS=${packed}\n`);
console.log(`Packed ${Object.keys(keys).length} wallets for ${config.cluster}. Written to deploy-secrets.txt`);
console.log('Paste its one line into your host\'s variables. Never share it or commit it.');
