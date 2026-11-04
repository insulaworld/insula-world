// A fake AI server for testing the brain code path without an API key.
// Replies like the real API, but on purpose also sends errors, garbage, slow replies and invalid choices.
// Usage: node test/fake-llm.mjs <port> <statsFile>
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 4599);
const STATS = process.argv[3] || 'fake-llm-stats.json';
const stats = { total: 0, kinds: {}, outcomes: {} };
const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const words = ['Supply is tight.', 'Fair price, fair deal.', 'I need the coins.', 'Long game.', 'Not today.'];

function answer(prompt) {
  const schema = prompt.slice(prompt.lastIndexOf('Respond as JSON:'));
  if (schema.includes('"headline"')) {
    const n = Number((schema.match(/exactly (\d+) stories/) || [])[1] || 0);
    return { kind: 'paper', body: { headline: 'Big news on the island', deck: 'The agents had a day.', stories: Array.from({ length: n }, (_, i) => ({ title: `Story ${i + 1}`, body: 'Rewritten by the fake AI.' })) } };
  }
  if (schema.includes('"choice"')) {
    let ids = [...prompt.matchAll(/^- ([a-z]+(?::[a-z0-9<>]+)*): /gm)].map((m) => m[1]).filter((id) => !id.includes('<'));
    // FAKE_SAFE=1 imitates the real AI's caution: it only ever works, eats, exports or rests.
    if (process.env.FAKE_SAFE) ids = ids.filter((id) => /^(work|eat|rest)/.test(id));
    return { kind: 'decide', body: { thought: `Thinking it over. ${pick(words)}`, choice: pick(ids), qty: 1 + Math.floor(Math.random() * 6), price: 5 + Math.floor(Math.random() * 30), say: pick(words) } };
  }
  if (schema.includes('"offer" | "decline"')) return { kind: 'loanTerms', body: { thought: 'Risk looks fine.', decision: pick(['offer', 'offer', 'decline']), amount: 200 + Math.floor(Math.random() * 400), rate: +(0.05 + Math.random() * 0.3).toFixed(2), say: 'Here are my terms.' } };
  if (schema.includes('"accept" | "counter" | "reject"')) return { kind: 'respond', body: { thought: pick(words), decision: pick(['accept', 'counter', 'reject']), price: 5 + Math.floor(Math.random() * 40), say: pick(words) } };
  if (schema.includes('"accept" | "reject"')) return { kind: 'answer', body: { thought: pick(words), decision: pick(['accept', 'reject']), say: pick(words) } };
  if (schema.includes('"price": number, "say"')) return { kind: 'price', body: { thought: pick(words), price: 5 + Math.floor(Math.random() * 600), say: pick(words) } };
  return { kind: 'unknown', body: { thought: '?', say: '?' } };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    stats.total++;
    let prompt = '';
    try { prompt = JSON.parse(raw).messages[0].content; } catch { bump(stats.outcomes, 'bad-request'); }
    const { kind, body } = answer(prompt);
    bump(stats.kinds, kind);
    const roll = Math.random();
    const reply = (text) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: Math.round(raw.length / 4), output_tokens: Math.round(text.length / 4) } }));
    };
    if (roll < 0.08) { bump(stats.outcomes, 'http500'); res.writeHead(500); res.end('{"error":"overloaded"}'); }
    else if (roll < 0.16) { bump(stats.outcomes, 'garbage'); reply('Sure! Here is my answer: I think I will go fishing.'); }
    else if (roll < 0.2) { bump(stats.outcomes, 'slow'); setTimeout(() => reply(JSON.stringify(body)), 14_000); }
    else if (roll < 0.25 && kind === 'decide') { bump(stats.outcomes, 'bad-choice'); reply(JSON.stringify({ ...body, choice: 'fly:to:the:moon' })); }
    else if (roll < 0.3) { bump(stats.outcomes, 'wrapped'); reply('Here you go:\n```json\n' + JSON.stringify(body) + '\n```'); }
    else { bump(stats.outcomes, 'ok'); reply(JSON.stringify(body)); }
    fs.writeFileSync(STATS, JSON.stringify(stats, null, 1));
  });
}).listen(PORT, () => console.log(`fake AI on ${PORT}`));
