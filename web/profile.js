// Inhabitant profiles: one animal's story in numbers. Their coins over time, who they deal with (and how
// that's going), what they own, and what they've been thinking. Everything comes from what they actually did:
// /api/state, /api/economy (minute log), /api/relations (pair counts) and /api/decisions?agent=<id>.
import { fmt, svgEl, niceTicks, timeAxis, showTip, tip, getEconomy } from './economy.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const wrap = document.createElement('div');
wrap.id = 'profile';
wrap.className = 'econ-wrap';
wrap.hidden = true;
wrap.setAttribute('role', 'dialog');
wrap.setAttribute('aria-modal', 'true');
wrap.setAttribute('aria-label', 'Inhabitant profile');
wrap.innerHTML = `<article class="econ prof"><div id="prof-body"></div></article>`;
document.body.appendChild(wrap);

function close() { wrap.hidden = true; tip.hidden = true; document.body.classList.remove('econ-open'); }
wrap.addEventListener('click', (ev) => {
  if (ev.target === wrap || ev.target.closest('[data-close]')) return close();
  const other = ev.target.closest('[data-goto]');
  if (other) openProfile(other.dataset.goto);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) close(); });

let current = null;
export async function openProfile(id) {
  current = id;
  document.getElementById('econ').hidden = true;
  wrap.hidden = false;
  document.body.classList.add('econ-open');
  $('#prof-body').innerHTML = '<p class="econ-empty">Loading…</p>';
  try {
    const [state, rel, dec, econ] = await Promise.all([
      fetch('/api/state').then((r) => r.json()),
      fetch('/api/relations').then((r) => r.json()),
      fetch(`/api/decisions?agent=${encodeURIComponent(id)}&limit=500`).then((r) => r.json()),
      getEconomy(),
    ]);
    if (current !== id) return;
    render(id, state, rel, dec, econ);
    wrap.scrollTop = 0;
  } catch (err) {
    console.error(err);
    $('#prof-body').innerHTML = '<p class="econ-empty">Could not load this profile. Try again in a minute.</p>';
  }
}

function render(id, state, rel, decisions, econ) {
  const a = state.agents.find((x) => x.id === id);
  if (!a) { $('#prof-body').innerHTML = '<p class="econ-empty">This animal hasn\'t arrived yet.</p>'; return; }
  const byId = Object.fromEntries(state.agents.map((x) => [x.id, x]));
  // Pairs this animal is part of, with the other side's id.
  const pairs = Object.entries(rel.pairs).filter(([k]) => k.split('|').includes(id))
    .map(([k, p]) => ({ other: k.split('|').find((x) => x !== id), ...p })).filter((p) => byId[p.other]);
  const sum = (f) => pairs.reduce((t, p) => t + (p[f] || 0), 0);
  const trades = sum('trades'), volume = sum('volume'), walk = sum('noDeals');
  // Directed: who this animal pays (buys from / hires) and who pays them.
  const paidTo = rel.given?.[id] || {};
  const paidBy = Object.fromEntries(Object.entries(rel.given || {}).map(([from, m]) => [from, m[id]]).filter(([, v]) => v));
  const fav = pairs.slice().sort((x, y) => y.trades - x.trades)[0];
  const rank = state.agents.slice().sort((x, y) => y.balance - x.balance).findIndex((x) => x.id === id) + 1;
  const owned = (state.buildings || []).filter((b) => b.owner === id);
  const house = owned.find((b) => b.type === 'house'), shop = owned.find((b) => b.type === 'workshop');
  const loans = (state.loans || []).filter((l) => l.borrower === id || l.lender === id);
  const born = (econ.points || []).find((p) => p.coins?.[id] != null);
  const role = [a.species, a.job, a.role && a.role !== a.job ? a.role : null].filter(Boolean).join(' · ');
  const addr = a.address?.startsWith('MOCK') ? 'test wallet' : `${a.address.slice(0, 6)}…${a.address.slice(-4)}`;

  const tiles = [
    ['Coins', fmt(a.balance), `#${rank} richest of ${state.agents.length}`],
    ['Trades', fmt(trades), `${fmt(volume)} coins of goods`],
    ['Partners', fmt(pairs.filter((p) => p.trades + p.contracts + p.loans > 0).length), fav ? `most with ${byId[fav.other].name}` : 'none yet'],
    ['Walked away', fmt(walk), 'deals that fell through'],
    ['Home', house ? `Lv ${house.level || 1}` : '–', shop ? `workshop Lv ${shop.level || 1}` : 'no workshop yet'],
  ];

  const relRows = pairs.slice().sort((x, y) => (y.trades + y.loans + y.contracts) - (x.trades + x.loans + x.contracts)).map((p) => {
    const o = byId[p.other];
    const extras = [
      p.contracts ? `${p.contracts} build job${p.contracts > 1 ? 's' : ''}` : '',
      p.loans ? `${p.loans} loan${p.loans > 1 ? 's' : ''}, ${p.repaid} repaid` : '',
      p.defaults ? `${p.defaults} default${p.defaults > 1 ? 's' : ''}` : '',
      p.thefts ? `${p.thefts} theft${p.thefts > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    const out = paidTo[p.other]?.coins || 0, inn = paidBy[p.other]?.coins || 0;
    return `
      <button type="button" class="prof-rel" data-goto="${p.other}" aria-label="Open ${esc(o.name)}'s profile">
        <span class="who"><i style="background:${o.color}"></i>${esc(o.name)}</span>
        <span class="mono n">${fmt(p.trades)} trades · walked away ${fmt(p.noDeals)}×${extras ? ' · ' + extras : ''}</span>
        <span class="mono flow">paid ${fmt(out)} · received ${fmt(inn)}</span>
        <span class="meters">
          <span class="meter"><span class="mono">TRUST</span><span class="track"><span style="width:${p.trust}%"></span></span><b class="mono">${p.trust}</b></span>
          <span class="meter riv"><span class="mono">RIVALRY</span><span class="track"><span style="width:${p.rivalry}%"></span></span><b class="mono">${p.rivalry}</b></span>
        </span>
      </button>`;
  }).join('');

  // Routine moves can repeat the last AI thought word for word; show each thought once.
  const thoughts = decisions.filter((d, i, all) => d.thought && d.thought !== all[i + 1]?.thought).slice(0, 8).map((d) => `
    <li>
      <p>“${esc(d.thought)}”</p>
      <span class="mono">${ago(d.at)} · ${d.brain === 'rule' || d.brain === 'autopilot' ? 'routine' : 'AI'}${(d.txs || []).length ? ` · <a href="${esc(d.txs[0].url)}" target="_blank" rel="noopener">paid on chain ↗</a>` : ''} · <a href="/api/decisions/${esc(d.id)}" target="_blank" rel="noopener">${esc(d.id)}</a></span>
    </li>`).join('');

  $('#prof-body').innerHTML = `
    <header class="econ-head">
      <div>
        <h2><i class="prof-swatch" style="background:${a.color}"></i>${esc(a.name)}</h2>
        <p class="mono econ-sub">${esc(role).toUpperCase()}${born ? ` · HERE SINCE DAY ${born.day}` : ''}</p>
      </div>
      <button type="button" class="econ-x" data-close aria-label="Close">✕</button>
    </header>
    <p class="prof-now">${esc(a.task)}${a.say ? ` · <q>${esc(a.say)}</q>` : ''}</p>
    <section class="econ-tiles prof-tiles">${tiles.map(([k, v, s]) => `<div class="econ-tile"><span class="mono k">${k}</span><b>${v}</b><span class="sub">${s}</span></div>`).join('')}</section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Coins over time</h3><span class="mono econ-note">${a.accountUrl ? `wallet <a href="${a.accountUrl}" target="_blank" rel="noopener">${addr} ↗</a>` : addr}</span></div>
      <div class="econ-chart" id="prof-coins"></div>
    </section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Neighbors</h3><span class="mono econ-note">trust grows with deals kept; rivalry with walk-aways, defaults and theft</span></div>
      <div class="prof-rels">${relRows || '<p class="econ-empty">No dealings yet.</p>'}</div>
    </section>
    <section class="econ-card">
      <div class="econ-card-head"><h3>Recent thoughts</h3><span class="mono econ-note">in their own words, as they decided</span></div>
      <ul class="prof-thoughts">${thoughts || '<li><p>Nothing yet.</p></li>'}</ul>
    </section>
    ${loans.length ? `<p class="mono econ-foot">${loans.length} open loan${loans.length > 1 ? 's' : ''} right now.</p>` : ''}`;

  coinsChart($('#prof-coins'), (econ.points || []).filter((p) => p.coins?.[id] != null).map((p) => ({ t: p.t, v: p.coins[id], day: p.day })).concat([{ t: Date.now(), v: a.balance, day: state.day }]), a);
}

function coinsChart(box, series, a) {
  if (series.length < 3) { box.innerHTML = '<p class="econ-empty">Not enough history yet.</p>'; return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 220, L = 48, R = 12, T = 10, B = 24;
  const t0 = series[0].t, t1 = series.at(-1).t;
  const vs = series.map((s) => s.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * 0.08 || 10, ylo = Math.max(0, lo - pad), yhi = hi + pad;
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), y = (v) => T + (1 - (v - ylo) / (yhi - ylo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${a.name}'s coins over time, from ${fmt(series[0].v)} to ${fmt(a.balance)}` }, box);
  for (const v of niceTicks(ylo, yhi)) {
    svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    svgEl('text', { x: L - 6, y: y(v) + 3, class: 'ax', 'text-anchor': 'end' }, svg).textContent = v >= 1e4 ? `${Math.round(v / 1e3)}k` : fmt(v);
  }
  timeAxis(svg, t0, t1, x, { W, H, L, R, B });
  svgEl('path', { d: series.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(''), class: 'line', stroke: a.color }, svg);
  const cross = svgEl('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' }, svg);
  const dot = svgEl('circle', { r: 4, fill: a.color, class: 'dot', visibility: 'hidden' }, svg);
  const hit = svgEl('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), mx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((mx - L) / (W - L - R)) * (t1 - t0);
    let best = series[0];
    for (const s of series) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(best.t)); dot.setAttribute('cy', y(best.v)); dot.setAttribute('visibility', 'visible');
    const when = new Date(best.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    showTip(`<b>Day ${best.day} · ${when}</b><div><i style="background:${a.color}"></i>Coins<span>${fmt(best.v)}</span></div>`, ev.clientX, ev.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

window.insulaProfile = openProfile;
const m = /^#profile-(\w+)$/.exec(location.hash);
if (m) setTimeout(() => openProfile(m[1]), 600);
