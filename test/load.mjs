// Load test: opens many viewers at once and measures what each one costs.
// Usage: node test/load.mjs <ws-url> <viewers> <seconds>
//   e.g. node test/load.mjs ws://localhost:3000/ws 200 30
// Reports bandwidth per viewer (actual bytes on the wire, after compression), message rate,
// and how quickly the server still answers a normal web request while under load.
import WebSocket from 'ws';

const [url = 'ws://localhost:3000/ws', n = '50', secs = '20'] = process.argv.slice(2);
const N = Number(n);
const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '/api/usage');
const socks = [];
let messages = 0;
let opened = 0;
let failed = 0;

for (let i = 0; i < N; i++) {
  const ws = new WebSocket(url);
  ws.on('open', () => opened++);
  ws.on('message', () => messages++);
  ws.on('error', () => failed++);
  socks.push(ws);
  if (i % 25 === 24) await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 3000)); // let the hello messages pass
const wire0 = socks.reduce((t, s) => t + (s._socket?.bytesRead || 0), 0);
const msg0 = messages;
const t0 = Date.now();

const lat = [];
const probe = setInterval(async () => {
  const s = Date.now();
  try { await fetch(httpUrl); lat.push(Date.now() - s); } catch { lat.push(-1); }
}, 1000);

await new Promise((r) => setTimeout(r, Number(secs) * 1000));
clearInterval(probe);
const dt = (Date.now() - t0) / 1000;
const wire = socks.reduce((t, s) => t + (s._socket?.bytesRead || 0), 0) - wire0;
const perViewer = wire / N / dt;
lat.sort((a, b) => a - b);
const report = {
  viewers: N, connected: opened, failed, seconds: +dt.toFixed(1),
  kbPerSecondPerViewer: +(perViewer / 1024).toFixed(2),
  messagesPerSecondPerViewer: +((messages - msg0) / N / dt).toFixed(1),
  gbPerDayPer100Viewers: +((perViewer * 100 * 86400) / 1e9).toFixed(1),
  serverResponseMs: { median: lat[Math.floor(lat.length / 2)], worst: lat[lat.length - 1] },
};
console.log(JSON.stringify(report, null, 1));
for (const s of socks) s.terminate();
process.exit(0);
