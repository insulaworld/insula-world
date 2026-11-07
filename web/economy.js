// The economy dashboard: the island's numbers over time, drawn from the server's minute log (/api/economy).
// Prices, each animal's wallet, trades per day and the gas runway. Plain SVG, no chart library.
const $ = (s, el = document) => el.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
export const fmt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
const short = (n) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : fmt(n));
// Item colors: four categorical slots in fixed order, checked for colorblind separation on this dark surface.
const ITEMS = [
  { id: 'fish', label: 'Fish', color: '#3987e5' },
  { id: 'wood', label: 'Wood', color: '#d95926' },
  { id: 'ore', label: 'Ore', color: '#199e70' },
  { id: 'grain', label: 'Grain', color: '#c98500' },
];
const RANGES = [{ id: '24h', label: '24H', ms: 864e5 }, { id: '3d', label: '3D', ms: 3 * 864e5 }, { id: 'all', label: 'ALL', ms: Infinity }];

const wrap = document.createElement('div');
wrap.id = 'econ';
wrap.className = 'econ-wrap';
wrap.hidden = true;
wrap.setAttribute('role', 'dialog');
wrap.setAttribute('aria-modal', 'true');
wrap.setAttribute('aria-label', 'Island economy');
wrap.innerHTML = `
  <article class="econ">
    <header class="econ-head">
      <div>
        <h2>Island economy</h2>
        <p class="mono econ-sub" id="econ-sub">Loading…</p>
      </div>
      <div class="econ-ranges mono" role="tablist" aria-label="Time range">
        ${RANGES.map((r) => `<button type="button" data-range="${r.id}" role="tab">${r.label}</button>`).join('')}
      </div>
      <button id="econ-close" class="econ-x" type="button" aria-label="Close">✕</button>
    </header>
    <section class="econ-tiles" id="econ-tiles"></section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Prices</h3><span class="mono econ-note">coins per unit on the island market · hourly average</span></div>
      <div class="econ-legend mono" id="econ-legend"></div>
      <div class="econ-chart" id="econ-prices"></div>
    </section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Wallets</h3><span class="mono econ-note">each animal's coins · tap for their profile</span></div>
      <div class="econ-wallets" id="econ-wallets"></div>
    </section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Trades per day</h3><span class="mono econ-note">every one a real token transfer</span></div>
      <div class="econ-chart short" id="econ-days"></div>
    </section>
    <p class="mono econ-foot">Sampled every minute from the live island. Every coin is $INSULA on Robinhood Chain.</p>
  </article>`;
document.body.appendChild(wrap);

export const tip = document.createElement('div');
tip.className = 'econ-tip mono';
tip.hidden = true;
document.body.appendChild(tip);

let data = null, agents = [], range = '3d', loadedAt = 0;

async function load() {
  if (data && Date.now() - loadedAt < 60_000) return;
  const [e, s] = await Promise.all([fetch('/api/economy').then((r) => r.json()), fetch('/api/state').then((r) => r.json())]);
  data = e; agents = s.agents; loadedAt = Date.now();
  data.state = s;
}

export async function getEconomy() { await load(); return data; }

export async function openEconomy() {
  wrap.hidden = false;
  document.body.classList.add('econ-open');
  try { await load(); render(); } catch (err) { $('#econ-sub').textContent = 'Could not load the numbers. Try again in a minute.'; console.error(err); }
}
function close() { wrap.hidden = true; tip.hidden = true; document.body.classList.remove('econ-open'); }
$('#econ-close').addEventListener('click', close);
wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) close(); });
wrap.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { range = b.dataset.range; render(); }));
addEventListener('resize', () => { if (!wrap.hidden && data) render(); });

function visible() {
  const pts = data.points || [];
  if (!pts.length) return [];
  const r = RANGES.find((x) => x.id === range);
  const from = pts.at(-1).t - r.ms;
  return pts.filter((p) => p.t >= from);
}

function render() {
  wrap.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.range === range)));
  const s = data.state, pts = visible();
  $('#econ-sub').textContent = `DAY ${s.day} · ${s.agents.length} ANIMALS · LIVE`;
  tiles(s);
  prices(pts);
  wallets(pts);
  days();
}

function tiles(s) {
  const today = data.byDay.at(-1);
  const held = s.agents.reduce((t, a) => t + a.balance, 0);
  const g = data.gas;
  const cells = [
    ['Trades today', fmt(today?.trades), `${fmt(s.market.trades)} all time`],
    ['Coins moved today', short(today?.gdp ?? 0), `${short(s.market.gdp)} all time`],
    ['Held by animals', short(held), `${((held / (held + s.bank.balance)) * 100).toFixed(1)}% of island supply`],
    ['Bank reserve', short(s.bank.balance), 'pays for mainland exports'],
    ['Buildings', fmt(s.economy.built), `${fmt(s.economy.taxes)} coins paid in tax`],
    ['Gas runway', g?.daysLeft != null ? `${g.daysLeft} days` : '–', g ? `${g.all.toFixed(4)} ETH across all wallets` : 'no gas data yet'],
  ];
  $('#econ-tiles').innerHTML = cells.map(([k, v, sub]) => `<div class="econ-tile"><span class="mono k">${k}</span><b>${v}</b><span class="sub">${sub}</span></div>`).join('');
}

// --- drawing helpers ---------------------------------------------------------------------------------------
export function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
}
export function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
// Time ticks on round boundaries: midnights for long ranges, every few hours for short ones.
export function timeAxis(svg, t0, t1, x, { W, H, L, R, B }) {
  const span = t1 - t0, maxTicks = Math.max(3, Math.floor((W - L - R) / 90));
  const stepH = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168].find((h) => span / (h * 3600e3) <= maxTicks) || 168;
  const first = new Date(t0); first.setMinutes(0, 0, 0);
  if (stepH >= 24) first.setHours(0); else first.setHours(Math.ceil(first.getHours() / stepH) * stepH);
  // Step with calendar math, not fixed milliseconds, so ticks stay on midnight across daylight-saving changes.
  for (const d = first; d.getTime() <= t1; stepH >= 24 ? d.setDate(d.getDate() + stepH / 24) : d.setHours(d.getHours() + stepH)) {
    const t = d.getTime();
    if (t < t0) continue;
    const px = x(t);
    if (px < L + 14 || px > W - R - 14) continue;
    svgEl('line', { x1: px, x2: px, y1: H - B, y2: H - B + 4, class: 'grid' }, svg);
    svgEl('text', { x: px, y: H - 6, class: 'ax', 'text-anchor': 'middle' }, svg).textContent = timeLabel(t, stepH >= 24 ? 3 * 864e5 : 0);
  }
}
const timeLabel = (t, spanMs) => {
  const d = new Date(t);
  return spanMs > 2 * 864e5 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-US', { hour: 'numeric' });
};
export function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, x + 14)) + 'px';
  tip.style.top = Math.max(8, y - r.height - 12) + 'px';
}

// --- prices: one line per item, crosshair + tooltip ---------------------------------------------------------
// Trade prices jump around deal to deal, so the chart shows a rolling one-hour average per item.
function smoothPrices(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const win = pts.slice(Math.max(0, i - 5), i + 1).filter((p) => p.prices);
    if (!pts[i].prices || !win.length) { out.push(pts[i]); continue; }
    const avg = {};
    for (const it of ITEMS) {
      const vs = win.map((p) => p.prices[it.id]).filter((v) => v != null);
      if (pts[i].prices[it.id] != null && vs.length) avg[it.id] = Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10;
    }
    out.push({ ...pts[i], prices: avg });
  }
  return out;
}

function prices(all) {
  const box = $('#econ-prices');
  box.innerHTML = '';
  // Start where price logging starts (the first days of the log have no prices).
  const pts = smoothPrices(all.slice(Math.max(0, all.findIndex((p) => p.prices))));
  const items = ITEMS.filter((it) => pts.some((p) => p.prices?.[it.id] != null));
  $('#econ-legend').innerHTML = items.map((it) => `<span><i style="background:${it.color}"></i>${it.label}</span>`).join('');
  if (pts.length < 2) { box.innerHTML = '<p class="econ-empty">Not enough history yet.</p>'; return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 220, L = 34, R = 52, T = 10, B = 24;
  const t0 = pts[0].t, t1 = pts.at(-1).t;
  const vals = pts.flatMap((p) => items.map((it) => p.prices?.[it.id]).filter((v) => v != null));
  const lo = Math.max(0, Math.min(...vals) - 1), hi = Math.max(...vals) + 1;
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Island prices over time: ' + items.map((it) => `${it.label} ${pts.at(-1).prices?.[it.id] ?? '–'}`).join(', ') }, box);
  for (const v of niceTicks(lo, hi)) {
    svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    svgEl('text', { x: L - 6, y: y(v) + 3, class: 'ax', 'text-anchor': 'end' }, svg).textContent = v;
  }
  timeAxis(svg, t0, t1, x, { W, H, L, R, B });
  // Direct labels at the line ends, nudged apart so they never overlap.
  const ends = [];
  for (const it of items) {
    let d = '', pen = false;
    for (const p of pts) {
      const v = p.prices?.[it.id];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    }
    svgEl('path', { d, class: 'line', stroke: it.color }, svg);
    const last = pts.at(-1).prices?.[it.id];
    if (last != null) ends.push({ it, y: y(last), v: last });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const e of ends) svgEl('text', { x: W - R + 6, y: e.y + 3, class: 'end' }, svg).textContent = `${e.it.label} ${e.v}`;
  // Hover layer
  const cross = svgEl('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' }, svg);
  const dots = items.map((it) => svgEl('circle', { r: 4, fill: it.color, class: 'dot', visibility: 'hidden' }, svg));
  const hit = svgEl('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), mx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((mx - L) / (W - L - R)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
    items.forEach((it, i) => {
      const v = best.prices?.[it.id];
      dots[i].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[i].setAttribute('cx', x(best.t)); dots[i].setAttribute('cy', y(v)); }
    });
    const when = new Date(best.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    showTip(`<b>Day ${best.day} · ${when}</b>` + items.map((it) => `<div><i style="background:${it.color}"></i>${it.label}<span>${best.prices?.[it.id] ?? '–'}</span></div>`).join(''), ev.clientX, ev.clientY);
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hidden = true; };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

// --- wallets: one small chart per animal, each on its own scale ---------------------------------------------
function wallets(pts) {
  const box = $('#econ-wallets');
  const list = agents.slice().sort((a, b) => b.balance - a.balance);
  box.innerHTML = list.map((a) => `
    <button type="button" class="econ-wallet" data-id="${a.id}" aria-label="${a.name}: ${fmt(a.balance)} coins. Open profile.">
      <span class="who"><i style="background:${a.color}"></i>${a.name}<small class="mono">${a.role || a.job || a.species}</small></span>
      <b>${fmt(a.balance)}</b>
      <span class="chg mono" data-chg></span>
      <span class="spark" data-spark></span>
    </button>`).join('');
  for (const a of list) {
    const el = box.querySelector(`[data-id="${a.id}"]`);
    const series = pts.filter((p) => p.coins?.[a.id] != null).map((p) => ({ t: p.t, v: p.coins[a.id] }));
    if (series.length) series.push({ t: Date.now(), v: a.balance });
    const first = series[0]?.v;
    const chg = el.querySelector('[data-chg]');
    if (first != null) {
      const diff = a.balance - first;
      chg.textContent = `${diff >= 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))}`;
      chg.classList.add(diff >= 0 ? 'up' : 'down');
    }
    spark(el.querySelector('[data-spark]'), series, a);
    el.addEventListener('click', () => window.insulaProfile?.(a.id));
  }
}
function spark(box, series, a) {
  if (series.length < 2) return;
  const W = 160, H = 34, t0 = series[0].t, t1 = series.at(-1).t;
  const vs = series.map((s) => s.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * (W - 4) + 2, y = (v) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (H - 4);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, box);
  svgEl('path', { d: series.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(''), class: 'line thin', stroke: a.color, 'vector-effect': 'non-scaling-stroke' }, svg);
}

// --- trades per day: bars ------------------------------------------------------------------------------------
function days() {
  const box = $('#econ-days');
  box.innerHTML = '';
  const rows = data.byDay.filter((d) => d.trades > 0);
  if (!rows.length) { box.innerHTML = '<p class="econ-empty">No trades logged yet.</p>'; return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 150, L = 40, R = 8, T = 16, B = 22;
  const hi = Math.max(...rows.map((d) => d.trades));
  const ticks = niceTicks(0, hi * 1.08, 4), top = Math.max(hi, ticks.at(-1));
  const bw = (W - L - R) / rows.length, y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Trades per day: ' + rows.map((d) => `day ${d.day} ${d.trades}`).join(', ') }, box);
  for (const v of ticks) {
    svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    svgEl('text', { x: L - 6, y: y(v) + 3, class: 'ax', 'text-anchor': 'end' }, svg).textContent = short(v);
  }
  const today = rows.at(-1).day;
  rows.forEach((d, i) => {
    const w = Math.min(46, bw - 2), cx = L + i * bw + bw / 2, h = Math.max(1, H - B - y(d.trades));
    // Rounded top only: a path with a 4px radius on the data end, square on the baseline.
    const r = Math.min(4, w / 2, h), x0 = cx - w / 2, y0 = H - B - h;
    svgEl('path', { d: `M${x0},${H - B}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${H - B}Z`, class: 'bar' + (d.day === today ? ' today' : '') }, svg);
    svgEl('text', { x: cx, y: H - 6, class: 'ax', 'text-anchor': 'middle' }, svg).textContent = `D${d.day}`;
    const hit = svgEl('rect', { x: L + i * bw, y: T, width: bw, height: H - T - B, fill: 'transparent' }, svg);
    const show = (ev) => showTip(`<b>Day ${d.day}${d.day === today ? ' · so far' : ''}</b><div>Trades<span>${fmt(d.trades)}</span></div><div>Coins moved<span>${fmt(d.gdp)}</span></div><div>Buildings<span>${fmt(d.built)}</span></div>`, ev.clientX, ev.clientY);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => (tip.hidden = true));
  });
}

window.insulaEconomy = openEconomy;
document.getElementById('econ-btn')?.addEventListener('click', () => openEconomy());
if (location.hash === '#economy') setTimeout(() => openEconomy(), 600);
