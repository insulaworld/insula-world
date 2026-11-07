// Loads settings from a .env file in the project folder (KEY=value per line), so the same
// commands work on Windows, Mac and Linux. Settings already in the environment win.
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
  }
}
// The project used to be called Oikos: settings with the old OIKOS_ prefix still work.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('OIKOS_') && process.env[`INSULA_${k.slice(6)}`] === undefined) process.env[`INSULA_${k.slice(6)}`] = v;
}
if (process.argv.includes('--mock')) process.env.CHAIN = 'mock';
// Fast-forward test world: one day per minute, fresh each run, its own save file.
if (process.argv.includes('--fast')) {
  process.env.INSULA_DAY_MS ||= '60000';
  process.env.INSULA_SAVE ||= 'data/fast.json';
  process.env.INSULA_FRESH ||= '1';
}

// On a host (Fly.io, a VPS), the wallets and chain settings can come from one secret variable,
// INSULA_SECRETS, made by "npm run secrets". It's unpacked into .keys/ and chain-config.json at start.
if (process.env.INSULA_SECRETS && !fs.existsSync(path.resolve('chain-config.json'))) {
  const packed = JSON.parse(Buffer.from(process.env.INSULA_SECRETS, 'base64').toString('utf8'));
  const keysDir = path.resolve('.keys');
  fs.mkdirSync(keysDir, { recursive: true });
  for (const [name, secret] of Object.entries(packed.keys)) fs.writeFileSync(path.join(keysDir, `${name}.json`), JSON.stringify(secret));
  fs.writeFileSync(path.resolve('chain-config.json'), JSON.stringify(packed.config, null, 2));
  console.log(`Unpacked ${Object.keys(packed.keys).length} wallets from INSULA_SECRETS.`);
}
