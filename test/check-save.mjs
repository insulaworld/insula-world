// Checks a saved world for consistency. Usage: node test/check-save.mjs <save.json> [earlierSave.json]
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prev = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const problems = [];
const ids = new Set();
for (const b of s.buildings) {
  if (ids.has(b.id)) problems.push(`duplicate building id ${b.id}`);
  ids.add(b.id);
}
const owned = {};
for (const b of s.buildings.filter((x) => x.kind === 'private')) {
  const k = `${b.owner}:${b.type}`;
  if (owned[k]) problems.push(`${b.owner} owns two ${b.type}s`);
  owned[k] = true;
}
for (const a of s.agents) for (const [k, v] of Object.entries(a.inv)) if (v < 0) problems.push(`${a.id} has ${v} ${k}`);
for (const j of s.jobs) {
  if (!['queued', 'building', 'done'].includes(j.status)) problems.push(`job ${j.id} has status ${j.status}`);
  if (j.buildingRef && !s.buildings.some((b) => b.id === j.buildingRef)) problems.push(`job ${j.id} points at a missing building`);
  if (j.kind === 'project' && j.status === 'done' && s.projects[j.type]?.status !== 'done') problems.push(`project ${j.type} built but not marked done`);
}
for (const [id, p] of Object.entries(s.projects)) {
  if (p.status === 'queued' && !s.jobs.some((j) => j.kind === 'project' && j.type === id)) problems.push(`project ${id} funded but no job`);
}
const privateSpots = s.buildings.filter((b) => b.kind === 'private').length + s.jobs.filter((j) => j.kind === 'new' && !j.buildingRef && j.status !== 'done').length;
if (privateSpots !== s.takenPlots.length) problems.push(`plots taken ${s.takenPlots.length} but buildings+pending ${privateSpots}`);
for (const l of s.loans) if (!['open', 'repaid', 'defaulted', 'collecting'].includes(l.status)) problems.push(`loan ${l.id} status ${l.status}`);
const agentIds = s.agents.map((a) => a.id);
if (new Set(agentIds).size !== agentIds.length) problems.push('duplicate agents');
const summary = {
  agents: agentIds.length, buildings: s.buildings.map((b) => `${b.id}:${b.type}@${b.owner || 'public'}:${Math.round(b.progress * 100)}%`),
  jobs: s.jobs.filter((j) => j.status !== 'done').map((j) => `${j.id}:${j.kind}:${j.type}:${j.status}${j.materialsUsed ? ':onsite' : ''}`),
  loans: s.loans.map((l) => `${l.borrower}:${l.status}`), eras: s.unlocked.length, gdp: Math.round(s.market.gdp),
};
if (prev) {
  for (const b of prev.buildings) {
    const now = s.buildings.find((x) => x.id === b.id);
    if (!now) problems.push(`building ${b.id} disappeared after restart`);
    else if (now.progress < b.progress && now.level === b.level) problems.push(`building ${b.id} went backwards`);
  }
  if (s.genesis !== prev.genesis) problems.push('genesis changed after restart');
  if (s.market.gdp < prev.market.gdp) problems.push('GDP went down after restart');
  if (s.agents.length < prev.agents.length) problems.push('agents lost after restart');
}
console.log(JSON.stringify(summary, null, 1));
console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'PASS: save is consistent');
