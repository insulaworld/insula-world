// The mayor election: a chip in the top bar that counts down to the vote, and a panel with the candidates,
// their platforms, the live count and every vote with its reason. Fed by the live state (insula:state events).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => Math.round(n ?? 0).toLocaleString('en-US');
const FOCUS = { works: 'Public works', relief: 'Theft relief' };
const FOCUS_SUB = { works: 'treasury funds new town projects', relief: 'treasury repays goods stolen at night' };

let state = null;
let names = {};

function left(ms) {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600e3), m = Math.ceil((ms % 3600e3) / 60e3);
  return h >= 1 ? `${h}h ${String(m === 60 ? 59 : m).padStart(2, '0')}m` : `${Math.max(1, Math.ceil(ms / 60e3))}m`;
}

// ---------- Chip ----------
const chip = document.createElement('button');
chip.id = 'vote-btn';
chip.type = 'button';
chip.className = 'chip mono';
chip.hidden = true;
chip.setAttribute('aria-haspopup', 'dialog');
chip.title = 'The mayor election: candidates, platforms and every vote';
const anchor = document.getElementById('econ-btn');
anchor?.parentNode.insertBefore(chip, anchor.nextSibling);

function chipText(e) {
  const narrow = matchMedia('(max-width: 600px)').matches;
  // Laptop widths: the top bar is already full, so the chip stays short.
  const mid = !narrow && matchMedia('(max-width: 1599px)').matches;
  const now = Date.now();
  if (e.phase === 'campaign' && e.current) {
    const voting = now >= e.current.voteAt;
    chip.classList.toggle('live', true);
    if (voting) return narrow ? 'VOTING' : `VOTING ${e.current.voted}/${Object.keys(names).length || '…'}`;
    const ms = e.current.voteAt - now;
    if (mid && ms >= 3600e3) return `VOTE ${Math.floor(ms / 3600e3)}H`;
    return narrow || mid ? `VOTE ${left(ms).toUpperCase()}` : `ELECTION · VOTE IN ${left(e.current.voteAt - now).toUpperCase()}`;
  }
  chip.classList.toggle('live', false);
  const mayor = names[e.office?.mayor] || 'the mayor';
  if (!e.n && e.nextCampaignAt) return narrow || mid ? 'ELECTION' : `ELECTION · OPENS IN ${left(e.nextCampaignAt - now).toUpperCase()}`;
  return narrow ? 'MAYOR' : `MAYOR ${mayor.toUpperCase()}`;
}

// ---------- Panel ----------
const wrap = document.createElement('div');
wrap.id = 'vote';
wrap.className = 'econ-wrap';
wrap.hidden = true;
wrap.setAttribute('role', 'dialog');
wrap.setAttribute('aria-modal', 'true');
wrap.setAttribute('aria-label', 'Mayor election');
wrap.innerHTML = `
  <article class="econ vote">
    <header class="econ-head">
      <div>
        <h2 id="vote-title">Mayor election</h2>
        <p class="mono econ-sub" id="vote-sub"></p>
      </div>
      <button id="vote-close" class="econ-x" type="button" aria-label="Close">✕</button>
    </header>
    <p class="vote-how">Every few days the animals elect a mayor. Each one decides for itself whether to run and what to promise, then every animal votes, with its reason on the record. The winner's platform becomes the island's rules. No human picks anything.</p>
    <section id="vote-office" class="econ-card"></section>
    <section id="vote-race" class="econ-card"></section>
    <section id="vote-votes" class="econ-card"></section>
    <section id="vote-past" class="econ-card"></section>
    <p class="mono econ-foot">Each candidacy and vote is a decision record with a SHA-256 fingerprint. Tap one to read it.</p>
  </article>`;
document.body.appendChild(wrap);

function open() {
  wrap.hidden = false;
  document.body.classList.add('econ-open');
  render();
  if (location.hash !== '#election') history.replaceState(null, '', '#election');
}
function close() {
  wrap.hidden = true;
  document.body.classList.remove('econ-open');
  if (location.hash === '#election') history.replaceState(null, '', location.pathname + location.search);
}
chip.addEventListener('click', open);
$('#vote-close').addEventListener('click', close);
wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden && $('#why')?.hidden !== false) close(); });

const rules = (p) => `
  <div class="vote-rules">
    <div><span class="mono k">Property tax</span><b>${p.tax}</b><span class="sub">coins per building level a day</span></div>
    <div><span class="mono k">Theft fine</span><b>${p.fine}</b><span class="sub">coins, paid to the victim</span></div>
    <div><span class="mono k">Treasury focus</span><b>${FOCUS[p.focus] || p.focus}</b><span class="sub">${FOCUS_SUB[p.focus] || ''}</span></div>
  </div>`;
const why = (id, label = 'why') => (id ? `<button class="why vote-why mono" type="button" data-decision="${esc(id)}">${esc(label)} ${esc(id)}</button>` : '');

function render() {
  const e = state;
  if (!e || wrap.hidden) return;
  const now = Date.now();
  const cur = e.current;
  const voting = e.phase === 'campaign' && cur && now >= cur.voteAt;
  const done = cur?.result;
  $('#vote-sub').textContent = !e.n
    ? (e.nextCampaignAt ? `FIRST CAMPAIGN OPENS IN ${left(e.nextCampaignAt - now).toUpperCase()}` : 'WAITING FOR THE TOWN HALL')
    : e.phase === 'campaign'
      ? (voting ? `ELECTION ${cur.n} · POLLS OPEN · ${cur.voted} VOTED` : `ELECTION ${cur.n} · CAMPAIGN · VOTE IN ${left(cur.voteAt - now).toUpperCase()}`)
      : `ELECTION ${cur?.n ?? e.n} DECIDED · NEXT CAMPAIGN IN ${left(e.nextCampaignAt - now).toUpperCase()}`;

  // Who's in office, and the rules they set
  const o = e.office;
  $('#vote-office').innerHTML = o ? `
    <div class="econ-card-head"><h3>Mayor ${esc(names[o.mayor] || o.mayor)}</h3><span class="mono econ-note">in office since ${new Date(o.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · treasury ${fmt(o.treasury)} coins</span></div>
    ${rules(o.policy)}
    <p class="vote-record">This term so far: ${esc(o.record)}.</p>` : '<p class="vote-record">No mayor yet. Elections start once the Town Hall stands.</p>';

  // The race
  if (cur?.candidates?.length) {
    const total = Math.max(1, Object.values(cur.tally || {}).reduce((t, v) => t + v, 0));
    const lead = Math.max(...Object.values(cur.tally || { x: 0 }));
    const showCount = voting || done;
    $('#vote-race').innerHTML = `
      <div class="econ-card-head"><h3>${done ? `Election ${cur.n} result` : `Election ${cur.n} candidates`}</h3><span class="mono econ-note">${done ? `${fmt(total)} votes counted` : showCount ? 'live count' : `${cur.candidates.length} running · max 4`}</span></div>
      <div class="vote-cands">${cur.candidates.map((c) => {
        const v = cur.tally?.[c.id] || 0;
        const won = done && done.winner === c.id;
        return `<div class="vote-cand${won ? ' won' : ''}">
          <div class="vote-who"><button class="vote-name" type="button" data-profile="${esc(c.id)}">${esc(c.name)}</button>${c.incumbent && !won ? `<span class="mono vote-tag">${done ? 'OUTGOING MAYOR' : 'MAYOR'}</span>` : ''}${won ? `<span class="mono vote-tag win">${c.incumbent ? 'RE-ELECTED' : 'ELECTED'}</span>` : ''}</div>
          <p class="vote-pitch">“${esc(c.pitch)}”</p>
          <p class="mono vote-plat">TAX ${c.tax} · FINE ${c.fine} · ${esc((FOCUS[c.focus] || c.focus).toUpperCase())}</p>
          ${showCount ? `<div class="vote-bar"><i style="width:${(v / total) * 100}%"${v === lead && v ? ' class="lead"' : ''}></i></div><p class="mono vote-n">${v} vote${v === 1 ? '' : 's'}</p>` : ''}
          ${why(c.decision, 'why they run')}
        </div>`;
      }).join('')}</div>
      ${done ? `<p class="vote-record">${done.changed ? `${esc(names[done.winner])} takes over from ${esc(names[done.prev])}. ${done.handoverUrl ? `<a href="${esc(done.handoverUrl)}" target="_blank" rel="noopener">Treasury handover on-chain ↗</a>` : ''}` : `${esc(names[done.winner])} stays in office.`}</p>` : ''}`;
  } else {
    $('#vote-race').innerHTML = `<div class="econ-card-head"><h3>Candidates</h3></div><p class="vote-record">${e.phase === 'campaign' ? 'Animals are deciding whether to run…' : 'The next campaign hasn\'t opened yet.'}</p>`;
  }

  // Every vote, with its reason
  const votes = Object.entries(cur?.votes || {});
  $('#vote-votes').hidden = !votes.length;
  if (votes.length) {
    $('#vote-votes').innerHTML = `
      <div class="econ-card-head"><h3>How each animal voted</h3><span class="mono econ-note">in their own words</span></div>
      <ul class="vote-list">${votes.sort((a, b) => (names[a[0]] || '').localeCompare(names[b[0]] || '')).map(([voter, v]) => `
        <li><b>${esc(names[voter] || voter)}</b> → <b>${esc(names[v.for] || v.for)}</b><span class="vote-thought">${esc(v.thought)}</span>${why(v.decision, 'record')}</li>`).join('')}</ul>`;
  }

  // Earlier elections
  const shown = (e.history || []).slice().reverse().filter((h) => !(done && h.n === cur.n));
  $('#vote-past').hidden = !shown.length;
  if (shown.length) {
    $('#vote-past').innerHTML = `<div class="econ-card-head"><h3>Past elections</h3></div>
      <ul class="vote-list">${shown.map((h) => `<li><b>Election ${h.n}</b> · ${esc(names[h.winner] || h.winner)} ${h.changed ? `beat ${esc(names[h.prev] || h.prev)}` : 're-elected'} · ${Object.entries(h.tally).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(names[id] || id)} ${n}`).join(', ')}<span class="vote-thought">Rules: tax ${h.policy.tax}, fine ${h.policy.fine}, ${esc(FOCUS[h.policy.focus] || h.policy.focus)}.</span></li>`).join('')}</ul>`;
  }
}

wrap.addEventListener('click', (ev) => {
  const p = ev.target.closest('[data-profile]');
  if (p) { close(); window.insulaProfile?.(p.dataset.profile); }
});

addEventListener('insula:state', (ev) => {
  const s = ev.detail;
  if (!s?.election) return;
  names = Object.fromEntries((s.agents || []).map((a) => [a.id, a.name]));
  state = s.election;
  chip.hidden = !state.ready;
  document.body.classList.toggle('has-vote', !chip.hidden);
  if (!chip.hidden) chip.textContent = chipText(state);
  render();
});
// Keep the countdown ticking between updates.
setInterval(() => { if (state && !chip.hidden) chip.textContent = chipText(state); }, 15_000);
if (location.hash === '#election') setTimeout(open, 800);
window.insulaElection = open;
