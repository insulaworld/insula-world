// Agent brains. Every decision an agent makes comes from here:
//  - what to do next (work, trade, borrow, repay, build, donate, eat, rest, and for one raccoon, steal)
//  - what price to ask or bid, and whether to accept, counter or walk away
//  - loan terms, construction quotes, and answers to both
// Each decision comes with a "thought": the agent's own reasoning, shown in the Minds feed.
//
// With ANTHROPIC_API_KEY set, an LLM makes every decision. Without it, a utility-based
// fallback brain decides from the same information and writes its reasoning from real numbers.

import { PRICES, MAINLAND, LOAN, CARRY } from './agents.js';

const API_KEY = typeof process !== 'undefined' ? process.env?.ANTHROPIC_API_KEY : undefined;
const MODEL = (typeof process !== 'undefined' && process.env?.LLM_MODEL) || 'claude-haiku-5-5';
const API_URL = ((typeof process !== 'undefined' && process.env?.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
export const LLM_ON = Boolean(API_KEY) && (typeof process === 'undefined' || process.env?.LLM !== 'off');

// What each kind of agent is driven to do. Without this, AI agents play it too safe: work, sell, eat, repeat.
const ROLE_DRIVE = {
  default: 'Idle coins earn nothing; the rich invest in a house, then a workshop, and fund public projects.',
  builder: 'You earn from building contracts. Buy or import the materials you need, finish jobs fast, and build your own house and workshop when you have no customers.',
  banker: 'You earn from interest. Money sitting in your vault earns nothing; a loan out to a good borrower is money working.',
  mayor: 'Your job is to grow the town: spend the tax treasury on public projects, and keep the island fair.',
  thief: 'You live by quietly taking goods from others at night. It is your trade, and you are good at it, though getting caught means a fine.',
};

let llmCalls = 0;
// Print each distinct AI error at most once a minute, with a count of repeats, instead of flooding the window.
const warned = new Map();
function warnOnce(msg) {
  const w = warned.get(msg) || { at: 0, n: 0 };
  w.n++;
  if (Date.now() - w.at > 60_000) {
    console.warn(w.n > 1 ? `${msg} (x${w.n} in the last minute)` : msg);
    w.at = Date.now();
    w.n = 0;
  }
  warned.set(msg, w);
}
const usage = { input: 0, output: 0, failed: 0, since: Date.now(), byKind: {}, ruleShortcuts: 0, badChoices: 0 };
export const llmStats = () => ({ on: LLM_ON, model: LLM_ON ? MODEL : null, calls: llmCalls });
export const llmUsage = () => ({ calls: llmCalls, ...usage });

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r = Math.round;
const ml = (ctx, item) => ctx.mainland?.[item] ?? MAINLAND[item];

// ---------- LLM plumbing ----------

let thinkingParamOk = (typeof process === 'undefined' || process.env?.LLM_THINKING) !== 'on';

// One request to the model; returns the parsed JSON object from its reply, or throws.
async function callModel(system, user, maxTokens = 1000, timeoutMs = 20_000, kind = 'other') {
  llmCalls++;
  const k = (usage.byKind[kind] ||= { calls: 0, input: 0, output: 0, failed: 0 });
  k.calls++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
        // The agents write their reasoning into the "thought" field, so the model's own hidden thinking is
        // switched off: it would eat the reply budget and cost extra. Skipped if this model doesn't accept it.
        ...(thinkingParamOk ? { thinking: { type: 'disabled' } } : {}),
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { const body = await res.json(); detail = body?.error?.message || ''; } catch {}
      if (res.status === 400 && thinkingParamOk && /thinking/i.test(detail)) {
        thinkingParamOk = false;
        k.calls--;
        llmCalls--;
        return callModel(system, user, maxTokens, timeoutMs, kind);
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    const data = await res.json();
    usage.input += data.usage?.input_tokens || 0;
    usage.output += data.usage?.output_tokens || 0;
    k.input += data.usage?.input_tokens || 0;
    k.output += data.usage?.output_tokens || 0;
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      const kinds = (data.content || []).map((c) => c.type).join(',') || 'none';
      throw new Error(`no JSON in reply (stop: ${data.stop_reason}, blocks: ${kinds}, text: "${text.slice(0, 80).replace(/\s+/g, ' ')}")`);
    }
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    usage.failed++;
    k.failed++;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function askLLM(agent, situation, schema, kind) {
  if (!LLM_ON) return null;
  try {
    return await callModel(
      `You are ${agent.name} the ${agent.species}, an autonomous AI agent in Insula, an island economy run only by AI agents. ` +
        `Your coins are real tokens in your own wallet. ${agent.personality}\n` +
        `Goals: stay fed, grow your wealth, keep good relationships. ${ROLE_DRIVE[agent.role] || ROLE_DRIVE.default} ` +
        'Think like a real economic actor. Reply with ONLY JSON. "thought": private reasoning, one sentence, max 20 words, first person, with a number. ' +
        '"say": spoken aloud, under 10 words, in character.',
      `${situation}\n\nRespond as JSON: ${schema}`,
      undefined,
      undefined,
      kind,
    );
  } catch (e) {
    warnOnce(`[brain] AI call failed (${e.message}). Agents use their rule brain for those decisions.`);
    return null;
  }
}

// The Insula Daily: rewrite the day's edition in a newspaper voice. Facts in, same facts out.
export async function writePaper(ed) {
  if (!LLM_ON) return null;
  const facts = { day: ed.day, lead: { kicker: ed.kicker, title: ed.headline, body: ed.deck }, stories: ed.stories.map((s) => ({ kicker: s.kicker, title: s.title, body: s.body })), numbers: ed.numbers };
  try {
    const out = await callModel(
      'You write The Insula Daily, the newspaper of an island economy run entirely by AI agents (animals with their own crypto wallets). ' +
        'Rewrite the given stories in a lively, warm small-town newspaper voice. Use ONLY the facts given: never invent events, names or numbers, ' +
        'and keep every number exactly as given. Never say a building is built, open, rising or finished unless the facts say it is finished; a fundraiser is only a fundraiser. Headlines under 9 words. Bodies 1-3 sentences. Reply with ONLY a JSON object.',
      `Today's facts:\n${JSON.stringify(facts)}\n\nRespond as JSON: {"headline": string, "deck": string, "stories": [{"title": string, "body": string}] } with exactly ${facts.stories.length} stories in the same order.`,
      1500,
      40_000,
      'newspaper',
    );
    return out && typeof out.headline === 'string' ? out : null;
  } catch (e) {
    warnOnce(`[daily] AI call failed (${e.message}), printing the plain edition`);
    return null;
  }
}

const invText = (inv, items) => items.map((i) => `${inv[i] || 0} ${i}`).join(', ');

// The briefing an agent reads before deciding. Kept compact: every token here is paid for on every call.
// short = true drops the island roll call, for quick negotiation replies.
const invShort = (inv, items) => items.filter((i) => inv[i]).map((i) => `${inv[i]} ${i}`).join(', ') || 'nothing';
// Food over the pantry is rotting away: say so plainly, with the numbers.
function spoilNote(ctx) {
  const keep = ctx.self.pantry ?? 12;
  const rot = ['fish', 'grain'].filter((i) => (ctx.self.inv[i] || 0) > keep).map((i) => `${ctx.self.inv[i]} ${i}`);
  return rot.length ? `\nSPOILING: you hold ${rot.join(' and ')}, but only ${keep} of each stays fresh; about 12% of the rest rots every minute. Sell it, ship it or eat it.` : '';
}

// What investing would do for this agent, in plain numbers, so the AI can weigh it against just working.
function investNote(ctx) {
  const has = (t) => ctx.owns?.some((b) => b.startsWith(t));
  const notes = [];
  if (!has('house') && !ctx.pendingJob) notes.push('no house yet (hunger rises half as fast with one)');
  else if (!has('workshop') && !ctx.pendingJob) notes.push('no workshop yet (+25% speed at every job)');
  if (ctx.projects?.length) notes.push(`public projects need funding (${ctx.projects.map((p) => p.label).join(', ')}), which helps everyone`);
  if (ctx.self.coins > 1200) notes.push(`${r(ctx.self.coins)} coins idle`);
  return notes.length ? `\nINVESTING: ${notes.join('; ')}.` : '';
}

function describe(ctx, short = false) {
  const s = ctx.self;
  const items = ctx.items;
  const others = ctx.others.map((o) => `${o.name}${o.role ? ` (${o.role})` : ''} ${r(o.coins)}c ${items.filter((i) => o.inv[i]).map((i) => `${i}${o.inv[i]}`).join(' ') || '-'}`).join('; ');
  const market = items.map((k) => `${k} ${ctx.market[k]}/${PRICES[k].fair}/${ml(ctx, k)}`).join(', ');
  const food = Object.entries(ctx.food).filter(([k]) => items.includes(k)).map(([k, v]) => `${k} -${v}`).join(', ');
  return (
    `Day ${ctx.day}${ctx.night ? ', night' : ''}. YOU: ${r(s.coins)} coins; ${invShort(s.inv, items)}; hunger ${s.hunger}/10 (eating: ${food}); ` +
    `best at ${items.slice().sort((a, b) => s.skills[b] - s.skills[a])[0]}.` +
    (short ? '' : `\nOTHERS: ${others}.`) +
    `\nPRICES (island/fair/mainland): ${market}.` +
    (short ? '' : `\nNEWS: ${ctx.news.slice(-2).join(' | ') || 'quiet'}.`) +
    (ctx.memory.length ? `\nMEMORY: ${[...new Set(ctx.memory.slice(-5))].slice(-3).join(' | ')}.` : '') +
    (ctx.grudges?.length ? `\nGRUDGES: ${ctx.grudges.map((g) => `${g.name} has been stealing from you`).join('; ')}. You don't trust them.` : '') +
    (ctx.watchedBy?.length ? `\nWATCHING YOU: ${ctx.watchedBy.join(', ')}. They know you've been robbing them and keep watch at night, so they're likelier to catch you.` : '') +
    (ctx.loan ? `\nLOAN: you owe ${ctx.loan.owed}, due in ${Math.max(0, r((ctx.loan.due - Date.now()) / 1000))}s or your goods get seized.` : '') +
    (ctx.owns?.length ? `\nYOU OWN: ${ctx.owns.join(', ')}.` : '') +
    (short ? '' : investNote(ctx)) +
    spoilNote(ctx) +
    (ctx.myJobs?.length ? `\nJOBS YOU OWE (paid): ${ctx.myJobs.map((j) => `${j.label} (${j.wood} wood${j.ore ? `, ${j.ore} ore` : ''})`).join('; ')}.` : '') +
    (ctx.role === 'banker' ? `\nBANKER: ${ctx.loansGiven} loans out; you earn interest.` : '') +
    (ctx.role === 'mayor' ? '\nMAYOR: you collect daily property tax; spend it on public projects.' : '') +
    (ctx.role === 'thief' ? '\nAt night you can take goods from others; you might get caught and fined.' : '')
  );
}

// ---------- What to do next ----------

// Autopilot: routine moves (keep working, rest) don't need a fresh AI call every few seconds.
// While nothing important has changed since the AI's last choice, the agent sticks with that plan.
// Anything that matters (hunger, a loan, a job, night for the thief, a big change in coins) wakes the AI up.
const ROUTINE = new Set(['work', 'rest']);
const AUTOPILOT_MAX = Number((typeof process !== 'undefined' && process.env?.LLM_AUTOPILOT) ?? 8);
const AUTOPILOT_MS = 300_000;
function situation(ctx) {
  const s = ctx.self;
  return [
    s.hunger >= 6 ? 'hungry' : s.hunger >= 3 ? 'peckish' : 'fed',
    Object.values(s.inv).some((v) => v >= CARRY - 1) ? 'full' : '',
    ['fish', 'grain'].some((i) => (s.inv[i] || 0) > (s.pantry ?? 12)) ? 'spoiling' : '',
    Math.floor(Math.log2(Math.max(1, s.coins))),
    ctx.loan ? (ctx.loan.due - Date.now() < 90_000 ? 'loan-due' : 'loan') : '',
    ctx.myJobs?.length || 0,
    ctx.pendingJob ? 'job' : '',
    ctx.role === 'thief' && ctx.night ? 'night' : '',
    (ctx.projects || []).length,
    ctx.day,
  ].join('|');
}

// The move menu, compressed: one line per kind of move, listing the items and neighbors it applies to, so
// "sell fish to Bruno", "sell fish to Felix", "sell wood to Bruno"... become a single line. Same choices,
// far fewer tokens (every token is paid for on every decision), and it stays short as the island grows.
const num = (re, str) => (str.match(re) || [])[1];
function menu(options) {
  const by = new Map();
  const order = [];
  for (const o of options) {
    if (!by.has(o.action)) { by.set(o.action, []); order.push(o.action); }
    by.get(o.action).push(o);
  }
  // Group a move kind by item, then list who: "fish (you have 7): felix, penny; wood (you have 30): bruno".
  const perItem = (list, fmt) => {
    const items = new Map();
    for (const o of list) { if (!items.has(o.item)) items.set(o.item, []); items.get(o.item).push(o); }
    return [...items.entries()].map(([item, os]) => fmt(item, os)).join('; ');
  };
  const out = [];
  for (const action of order) {
    const list = by.get(action);
    if (action === 'work') out.push(`- work:<item>: gather it yourself; per minute for you: ${list.map((o) => `${o.item} ${num(/about ([\d.]+)/, o.label) ?? '?'}`).join(', ')}`);
    else if (action === 'eat') out.push(`- eat:<item>: eat; ${list.map((o) => `${o.item} (have ${o.maxQty}, -${num(/removes (\d+)/, o.label) ?? '?'} hunger each)`).join(', ')}`);
    else if (action === 'sell') {
      // Items that go to the same buyers share one list of names.
      const buyers = new Map();
      for (const o of list) { if (!buyers.has(o.item)) buyers.set(o.item, { have: o.maxQty, who: [] }); buyers.get(o.item).who.push(o.with); }
      const sets = new Map();
      for (const [item, b] of buyers) { const k = b.who.join(', '); if (!sets.has(k)) sets.set(k, []); sets.get(k).push(`${item} (you have ${b.have})`); }
      out.push(`- sell:<item>:<who>: sell to a neighbor, lots of 6+; ${[...sets].map(([who, items]) => `${items.join(', ')} to ${who}`).join('; ')}`);
    }
    else if (action === 'buy') out.push(`- buy:<item>:<who>: buy from a neighbor, lots of 6+; ${perItem(list, (item, os) => `${item} from ${os.map((o) => `${o.with} (has ${o.maxQty})`).join(', ')}`)}`);
    else if (action === 'steal') out.push(`- steal:<item>:<who>: quietly take it in the dark; ${perItem(list, (item, os) => `${item} from ${os.map((o) => `${o.with} (has ${o.maxQty})`).join(', ')}`)}`);
    else if (action === 'export') out.push(`- export:<item>: ship to the mainland (price drops as more ships); ${list.map((o) => `${o.item} ${num(/at (\d+) each/, o.label) ?? '?'}`).join(', ')} each`);
    else if (action === 'import') out.push(`- import:<item>: buy from the mainland, pricey; ${list.map((o) => `${o.item} ${num(/at (\d+) each/, o.label) ?? '?'}`).join(', ')} each`);
    else {
      // Everything else: per-neighbor moves grouped as before, one-offs as their own line.
      const groups = new Map();
      for (const o of list) {
        if (o.with && o.id.endsWith(`:${o.with}`)) {
          const key = o.id.slice(0, -o.with.length) + '<who>';
          if (!groups.has(key)) groups.set(key, { label: o.label.replace(o.withName, '<who>').replace(/they have \d+ coins; /, ''), who: [] });
          groups.get(key).who.push(o.with);
        } else out.push(`- ${o.id}: ${o.label}`);
      }
      for (const [key, g] of groups) out.push(`- ${key}: ${g.label}; <who> = ${g.who.join(', ')}`);
    }
  }
  return out.join('\n');
}

export async function decide(agent, ctx, options) {
  // Starving with food in hand: just eat. No need to ask the AI.
  const eats = options.filter((o) => o.action === 'eat').sort((a, b) => b.maxQty - a.maxQty);
  if (LLM_ON && ctx.self.hunger >= 7 && eats.length) {
    usage.ruleShortcuts++;
    const e = eats[0];
    const fill = ctx.food[e.item] || 2;
    const qty = clamp(Math.ceil((ctx.self.hunger - 2) / fill), 1, e.maxQty);
    return { option: e, qty, price: null, thought: `Hunger ${ctx.self.hunger}/10. Eating ${qty} ${e.item} before anything else.`, say: null, brain: 'rule' };
  }
  // Hoarding far more than anyone can use: ship the extra to the mainland (the bank pays for it on-chain).
  // Breaks up haggling loops over a glut and sends the agent back to work with room in its pack.
  const SURPLUS = { wood: 80, ore: 50, fish: 30, grain: 30 };
  const glut = Object.entries(SURPLUS)
    .map(([item, max]) => ({ item, max, have: ctx.self.inv?.[item] || 0, opt: options.find((o) => o.id === `export:${item}`) }))
    .filter((g) => g.opt && g.have > g.max)
    .sort((a, b) => b.have / b.max - a.have / a.max)[0];
  if (glut && Math.random() < 0.5) {
    usage.ruleShortcuts++;
    agent._plan = null;
    const qty = Math.min(glut.have - Math.round(glut.max / 2), glut.opt.maxQty);
    return { option: glut.opt, qty, price: null, thought: `I'm sitting on ${glut.have} ${glut.item}, way more than I can use. Shipping ${qty} to the mainland.`, say: null, brain: 'rule' };
  }
  const nudge = LLM_ON ? growthNudge(agent, ctx, options) : null;
  if (nudge) { usage.ruleShortcuts++; agent._plan = null; return nudge; }
  const plan = agent._plan;
  const sit = situation(ctx);
  if (LLM_ON && plan && plan.sit === sit && plan.streak < AUTOPILOT_MAX && Date.now() - plan.at < AUTOPILOT_MS) {
    const same = options.find((o) => o.id === plan.choice);
    if (same) {
      plan.streak++;
      return { option: same, qty: same.maxQty || 1, price: null, thought: plan.thought, say: null, brain: 'autopilot' };
    }
  }
  const llm = await askLLM(
    agent,
    `${describe(ctx)}\n\nWhat next? Fill in <item>/<who> from the line, e.g. sell:fish:bruno.\n${menu(options)}`,
    '{"thought": string, "choice": option id, "qty": number, "price": number (per unit for trades, total for hiring), "say": string}',
    'decide',
  );
  const chosen = llm && options.find((o) => o.id === llm.choice);
  if (chosen) {
    agent._plan = ROUTINE.has(chosen.action) ? { choice: chosen.id, thought: llm.thought, sit, streak: 0, at: Date.now() } : null;
    const qty = clamp(r(+llm.qty || chosen.maxQty || 1), 1, chosen.maxQty || 99999);
    return { option: chosen, qty, price: Number.isFinite(+llm.price) ? r(+llm.price) : null, thought: llm.thought, say: llm.say, brain: MODEL };
  }
  // The AI answered, but with a move that isn't on the menu: counted, so a confusing menu shows up in /api/usage.
  if (llm) usage.badChoices++;
  agent._plan = null;
  return fallbackDecide(agent, ctx, options);
}

// The growth backstop. AI agents tend to play it safe, which leaves the island unbuilt and the 30-day
// roadmap stuck. So some ambitious moves happen by rule, at set odds, whenever an agent can afford them:
// building a home, then a workshop, chipping in to public projects, the builder building for themself,
// the mayor spending the treasury, and Rico's night jobs. Everything else stays the AI's call.
function growthNudge(agent, ctx, options) {
  const s = ctx.self;
  // A builder with paid jobs works through them: get the materials, then build. That's a contract, not a whim.
  if (ctx.role === 'builder' && ctx.myJobs?.length) return fallbackDecide(agent, ctx, options);
  if (s.hunger >= 7) return null;
  const keep = s.pantry ?? 12;
  for (const item of ['fish', 'grain']) {
    const extra = (s.inv[item] || 0) - keep;
    if (extra > 15 && Math.random() < 0.3) {
      const o = options.find((x) => x.action === 'export' && x.item === item);
      if (o) return { option: o, qty: extra, price: null, thought: `${s.inv[item]} ${item} and it's starting to rot. Shipping ${extra} to the mainland before it all goes bad.`, say: null, brain: 'rule' };
    }
  }
  const has = (t) => ctx.owns?.some((b) => b.startsWith(t));
  const find = (fn) => options.filter(fn).sort(() => Math.random() - 0.5)[0];
  const pickOf = (o, qty, thought, price = null) => ({ option: o, qty, price, thought, say: null, brain: 'rule' });
  if (ctx.role === 'thief' && ctx.night && Math.random() < 0.45) {
    const o = find((x) => x.action === 'steal');
    if (o) return pickOf(o, o.maxQty, `Dark out. ${o.withName} is carrying ${o.maxQty} ${o.item} and not looking. Easy pickings.`);
  }
  if (ctx.role === 'mayor' && s.coins > 300 && Math.random() < 0.5) {
    const o = find((x) => x.action === 'fund');
    if (o) { const amt = Math.min(o.maxQty, r(s.coins * 0.6)); if (amt > 0) return pickOf(o, amt, `The treasury holds ${r(s.coins)}. ${amt} goes to public works; that's what taxes are for.`); }
  }
  if (ctx.role === 'builder' && !ctx.myJobs?.length && s.coins > 800 && Math.random() < 0.3) {
    const o = find((x) => x.action === 'selfbuild');
    if (o) return pickOf(o, 1, `No customers waiting and ${r(s.coins)} coins. Time I built my own ${o.item}.`);
  }
  if (ctx.role === 'banker' && ctx.loansGiven < 3 && s.coins > 1500 && Math.random() < 0.2) {
    const o = options.filter((x) => x.action === 'offer').sort((a, b) => (ctx.others.find((p) => p.id === a.with)?.coins ?? 0) - (ctx.others.find((p) => p.id === b.with)?.coins ?? 0))[0];
    if (o) return pickOf(o, o.maxQty, `${r(s.coins)} coins doing nothing in the vault. ${o.withName} is short; a loan to them earns me interest.`);
  }
  if (!ctx.pendingJob && !ctx.loan && !ctx.credit?.defaulted && Math.random() < 0.15) {
    const o = find((x) => x.action === 'borrow');
    if (o && !has('house') && s.coins > 200 && s.coins <= 650) return pickOf(o, 350, `I want a house but only have ${r(s.coins)}. Borrowing 350 from ${o.withName}; my next sales pay it back.`);
    if (o && has('house') && !has('workshop') && s.coins > 250 && s.coins < 1000) return pickOf(o, 450, `A workshop would make me 25% faster, but I only have ${r(s.coins)}. Borrowing 450 from ${o.withName}; the extra output pays it back.`);
  }
  if (!ctx.pendingJob) {
    const hire = (type) => find((x) => x.action === 'hire' && x.item === type);
    if (!has('house') && s.coins > 650 && Math.random() < 0.4) {
      const o = hire('house');
      if (o) return pickOf(o, 1, `${r(s.coins)} coins and no roof. A house halves how fast I get hungry; ${o.withName} can build it.`, r(s.coins * 0.6));
    }
    if (has('house') && !has('workshop') && s.coins > 1000 && Math.random() < 0.3) {
      const o = hire('workshop');
      if (o) return pickOf(o, 1, `${r(s.coins)} coins idle. A workshop makes me 25% faster, so it pays for itself.`, r(s.coins * 0.55));
    }
    if (has('workshop') && s.coins > 1600 && Math.random() < 0.15) {
      const o = find((x) => x.action === 'upgrade');
      if (o) return pickOf(o, 1, `Upgrading my ${o.item} to level ${o.toLevel}. ${r(s.coins)} coins should be working, not sitting.`, r(s.coins * 0.5));
    }
  }
  if (s.coins > 900 && Math.random() < 0.22) {
    const o = find((x) => x.action === 'donate');
    if (o) { const amt = Math.min(o.maxQty, r(Math.min(500, s.coins * 0.15))); if (amt > 0) return pickOf(o, amt, `${amt} toward the ${o.label.match(/the ([A-Z][\w ]+?) \(/)?.[1] || 'project'}. It helps the whole island, me included.`); }
  }
  return null;
}

const FOODS = ['fish', 'grain'];
const isFood = (i) => FOODS.includes(i);

// What one unit is worth to this agent: food feeds you, materials matter most to builders with jobs.
// Everything else is worth about what the mainland pays, which keeps speculative bubbles in check.
function valueOf(agent, ctx, item) {
  const fair = PRICES[item].fair;
  if (isFood(item)) return fair * (1 + ctx.self.hunger / 9) * (1 + (1 - Math.min(ctx.self.skills[item], 1.5)) * 0.35);
  if (ctx.role === 'builder' && ctx.myJobs?.some((j) => (j[item] || 0) > 0)) return fair * 1.35;
  return ml(ctx, item) * 1.25;
}

function fallbackDecide(agent, ctx, options) {
  const s = ctx.self;
  const find = (fn) => options.find(fn);
  const choose = (option, thought, extra = {}) => ({ option, qty: extra.qty ?? option.maxQty ?? 1, price: extra.price ?? null, thought, say: extra.say ?? null, brain: 'rule' });
  const foodHeld = FOODS.reduce((t, f) => t + (s.inv[f] || 0), 0);

  // 0. Debts and paid jobs come first.
  const repay = find((o) => o.action === 'repay');
  if (repay) {
    const left = (ctx.loan.due - Date.now()) / 1000;
    const age = (Date.now() - (ctx.loan.issued || 0)) / 1000;
    if (left < 60 || (age > 90 && s.coins - ctx.loan.owed > 600)) return choose(repay, `I owe ${ctx.loan.owed} and have ${r(s.coins)}. ${left < 60 ? `Only ${r(left)}s left before ${repay.withName} seizes everything.` : 'The loan did its job; paying it off now keeps my credit clean.'}`);
  }
  if (ctx.role === 'builder' && ctx.myJobs.length && s.hunger < 7) {
    // Build the job at the front of the line, so small jobs can't keep eating the materials a big one needs.
    const build = find((o) => o.action === 'build' && o.job === ctx.myJobs[0].id);
    if (build) return choose(build, `Already paid for ${ctx.myJobs[0].label}, and I have the materials. Time to build.`);
    const job = ctx.myJobs[0];
    const rich = s.coins > 1200;
    for (const item of ['ore', 'wood']) {
      const short = job[item] - s.inv[item];
      if (short <= 0) continue;
      const imp0 = find((o) => o.action === 'import' && o.item === item);
      if (imp0 && rich) return choose(imp0, `${job.label} needs ${short} more ${item}. I've got ${r(s.coins)} coins and customers waiting, so the boat it is.`, { qty: Math.min(imp0.maxQty, short) });
      // Skip anyone who already said no, and other builders (their materials are spoken for).
      const seller = options
        .filter((o) => o.action === 'buy' && o.item === item && !ctx.refusals?.[`buy:${item}:${o.with}`] && !ctx.others.some((x) => x.id === o.with && x.role === 'builder'))
        .sort((a, b) => b.maxQty - a.maxQty)[0];
      if (seller && (item === 'ore' || rich)) return choose(seller, `${job.label} needs ${short} more ${item}. ${seller.withName} has ${seller.maxQty}. Paying a local beats doing it myself.`, { qty: Math.min(seller.maxQty, short) });
      const imp = find((o) => o.action === 'import' && o.item === item);
      if (imp && rich) return choose(imp, `${job.label} needs ${short} more ${item} and nobody local has it. I've got ${r(s.coins)}; the boat sells it, so time beats money here.`, { qty: Math.min(imp.maxQty, short) });
      if (item === 'ore' && s.inv.wood >= job.wood) return choose(find((o) => o.id === 'work:ore'), `Nobody's selling ore. I'll dig the ${short} I need myself.`);
    }
    return choose(find((o) => o.id === 'work:wood'), `${job.label} needs ${job.wood} wood. I have ${s.inv.wood}. Chopping.`);
  }

  if (ctx.role === 'builder' && !ctx.myJobs.length) {
    const own = options.filter((o) => o.action === 'selfbuild');
    const house = own.find((o) => o.item === 'house' && !o.toLevel);
    const other = own.find((o) => o !== house);
    if (house && s.coins > 700) return choose(house, `I build everyone else's homes. No customers waiting, ${r(s.coins)} coins: time I built my own.`);
    if (other && s.coins > 1500 && Math.random() < 0.5) return choose(other, `Quiet day and ${r(s.coins)} in the bank. I'll put it into my own ${other.item}${other.toLevel ? ` (level ${other.toLevel})` : ''}.`);
  }

  // 1. Food first.
  if (s.hunger >= 6) {
    const eat = options.filter((o) => o.action === 'eat').sort((a, b) => b.maxQty - a.maxQty)[0];
    if (eat) return choose(eat, `Hunger at ${s.hunger}/10 and I've got ${s.inv[eat.item]} ${eat.item}. Eating before anything else.`, { qty: Math.min(eat.maxQty, Math.ceil(s.hunger / (ctx.food[eat.item] || 2))) });
    const sellers = options.filter((o) => o.action === 'buy' && isFood(o.item)).sort((a, b) => b.maxQty - a.maxQty);
    if (sellers.length) {
      const o = sellers[0];
      const qty = Math.min(o.maxQty, o.item === 'grain' ? 3 : 2);
      return choose(o, `Hunger ${s.hunger}/10 and nothing to eat. ${o.withName} has ${o.maxQty} ${o.item}. Buying ${qty}, even if I overpay a little.`, { qty });
    }
    const own = options.filter((o) => o.action === 'work' && isFood(o.item)).sort((a, b) => s.skills[b.item] - s.skills[a.item])[0];
    const imp = options.filter((o) => o.action === 'import' && isFood(o.item)).sort((a, b) => a.label.localeCompare(b.label))[0];
    if (imp && (s.hunger >= 8 || s.skills[own.item] < 1) && s.coins > 200) return choose(imp, `Hunger ${s.hunger}/10, nobody here is selling food, and I'm slow at getting my own. Buying off the boat.`, { qty: Math.min(imp.maxQty, 3) });
    return choose(own, `Starving at ${s.hunger}/10 and nobody is selling food. I'll get my own ${own.item}.`);
  }

  // 2. A night's work, for some.
  if (ctx.role === 'thief' && ctx.night) {
    const marks = options.filter((o) => o.action === 'steal').sort((a, b) => (PRICES[b.item].fair * b.maxQty) - (PRICES[a.item].fair * a.maxQty));
    if (marks.length && Math.random() < 0.45) {
      const m = marks[0];
      return choose(m, `Dark out. ${m.withName} has ${m.maxQty}+ ${m.item} lying around, worth ~${PRICES[m.item].fair} each. Nobody counts that carefully.`);
    }
  }

  // 3. Mayor: spend the treasury on public works.
  if (ctx.role === 'mayor') {
    const fund = find((o) => o.action === 'fund');
    if (fund && s.coins > 350) {
      const amt = Math.min(fund.maxQty, r(s.coins - 250));
      return choose(fund, `Treasury has ${r(s.coins)}. Putting ${amt} toward the ${ctx.projects.find((p) => fund.id.endsWith(p.id))?.label ?? 'project'}. Public works pay everyone back.`, { qty: amt });
    }
  }

  // 4. Cash in on a full load: sell to whoever needs it, or ship it to the mainland.
  for (const item of ctx.items) {
    const have = s.inv[item] || 0;
    const keep = isFood(item) ? (s.skills[item] < 1 ? 5 : 2) : 0;
    if (have - keep < 4) continue;
    const buyers = options
      .filter((o) => o.action === 'sell' && o.item === item)
      .map((o) => ({ o, other: ctx.others.find((x) => x.id === o.with) }))
      .filter(({ other }) => other && other.coins > PRICES[item].fair * 2)
      .filter(({ other }) => (isFood(item)
        ? (other.inv.fish || 0) + (other.inv.grain || 0) < 4 && (other.skills[item] < 1.2 || (other.inv[item] || 0) < 1)
        : (ctx.builderNeeds?.[other.id]?.[item] || 0) > 0))
      .filter(({ o }) => !ctx.refusals[`sell:${item}:${o.with}`] || Math.random() < 0.35)
      .sort((a, b) => a.other.skills[item] - b.other.skills[item] || (a.other.inv[item] || 0) - (b.other.inv[item] || 0));
    const qty = have - keep;
    if (buyers.length && (Math.random() < 0.8 || isFood(item))) {
      const { o, other } = buyers[0];
      const need = ctx.builderNeeds?.[other.id]?.[item] || 0;
      const before = ctx.refusals[`sell:${item}:${o.with}`];
      return choose(o, before
        ? `${other.name} turned down ${before} for ${item} earlier. Going back with a lower ask; still beats the mainland's ${ml(ctx, item)}.`
        : isFood(item)
          ? `Holding ${have} ${item}. ${other.name} is short on food and has ${r(other.coins)} coins. Mainland only pays ${ml(ctx, item)}.`
          : `${other.name} needs ${need} more ${item} for a job. That's my buyer, not the mainland at ${ml(ctx, item)}.`,
      { qty: isFood(item) ? qty : Math.min(qty, Math.max(need, 1)) });
    }
    const exp = find((o) => o.action === 'export' && o.item === item);
    if (exp && (!isFood(item) || have > 10)) return choose(exp, `Nobody here wants ${have} ${item} at a decent price. The mainland pays ${ml(ctx, item)} each; better than sitting on it.`, { qty });
  }

  // 5. Merchants (and fences) pick up cheap goods to resell.
  if (agent.haggle > 0.5 && s.coins > 300 && Math.random() < 0.3) {
    const flip = options
      // Only flip what you aren't already stuck holding, and only with a real margin over the mainland price.
      .filter((o) => o.action === 'buy' && !isFood(o.item) && o.maxQty >= 3 && !ctx.refusals[`buy:${o.item}:${o.with}`] && (s.inv[o.item] || 0) < 3 && ml(ctx, o.item) >= 6)
      .sort((a, b) => b.maxQty - a.maxQty)[0];
    if (flip) {
      const target = ml(ctx, flip.item) - 2;
      // A flip has a hard ceiling: paying more than this loses money once it's shipped.
      agent._flipMax = { item: flip.item, max: target, until: Date.now() + 120_000 };
      return choose(flip, `${flip.withName} is sitting on ${flip.maxQty} ${flip.item}. If I get it for ${target} or less, the mainland pays ${ml(ctx, flip.item)} and I keep the difference.`, { qty: Math.min(flip.maxQty, 5), price: target });
    }
  }

  // 6. Civic duty, now and then.
  const donate = find((o) => o.action === 'donate');
  const wealthy = s.coins > 3000;
  if (donate && s.coins > 1100 && Math.random() < (wealthy ? 0.4 : 0.2)) {
    const p = ctx.projects.find((x) => donate.id.endsWith(x.id));
    const amt = Math.min(donate.maxQty, r(wealthy ? Math.min(1000, s.coins * 0.1) : Math.min(250, s.coins * 0.12)));
    return choose(donate, `${p.label} is at ${p.funded}/${p.need}. ${p.perk[0].toUpperCase() + p.perk.slice(1)}, which helps me too. ${amt} is a fair share.`, { qty: amt });
  }

  // 7. Invest: new buildings and upgrades.
  const hires = options.filter((o) => o.action === 'hire' || o.action === 'upgrade');
  if (hires.length && Math.random() < (wealthy ? 0.6 : 0.3)) {
    const pickBuilder = (list) => list.sort(() => Math.random() - 0.5)[0];
    const house = pickBuilder(hires.filter((o) => o.action === 'hire' && o.item === 'house'));
    const shop = pickBuilder(hires.filter((o) => o.action === 'hire' && o.item === 'workshop'));
    const up = pickBuilder(hires.filter((o) => o.action === 'upgrade'));
    if (house && s.coins > 520) return choose(house, `${r(s.coins)} coins and no roof. A house means I get hungry slower and spend less on food. ${house.withName} can build it.`);
    if (shop && s.coins > 820) return choose(shop, `${r(s.coins)} coins sitting idle. A workshop makes me faster at my best job, so it pays for itself.`);
    if (up && s.coins > 900) return choose(up, `My ${up.item} could go to level ${up.toLevel}. With ${r(s.coins)} in the bank, that upgrade pays for itself.`);
  }

  // 8. Borrowing: to invest, or to get by.
  const borrow = options.filter((o) => o.action === 'borrow').sort(() => Math.random() - 0.5)[0];
  if (borrow && !ctx.credit?.defaulted) {
    if (!ctx.owns?.length && !ctx.pendingJob && s.coins < 500 && s.coins > 150 && Math.random() < 0.25) {
      return choose(borrow, `I want a house but only have ${r(s.coins)}. Borrowing 300 from ${borrow.withName}; my next sales pay it back.`, { qty: 300 });
    }
    if (ctx.owns?.some((b) => b.startsWith('house')) && !ctx.owns.some((b) => b.startsWith('workshop')) && !ctx.pendingJob && s.coins > 250 && s.coins < 750 && Math.random() < 0.3) {
      return choose(borrow, `A workshop would make me faster, but I only have ${r(s.coins)}. Borrowing 400 from ${borrow.withName}; the extra output pays it back.`, { qty: 400 });
    }
    if (s.coins < 160) return choose(borrow, `Only ${r(s.coins)} coins left. A loan from ${borrow.withName} keeps me going until my next sale.`, { qty: 300 });
  }

  // 9. Bankers and mayors keep office hours.
  if ((ctx.role === 'banker' || ctx.role === 'mayor') && foodHeld >= 1 && s.hunger < 5 && Math.random() < 0.55) {
    const rest = find((o) => o.action === 'rest');
    if (rest) return choose(rest, ctx.role === 'banker'
      ? `${ctx.loansGiven} loan${ctx.loansGiven === 1 ? '' : 's'} out and ${r(s.coins)} coins in the vault. My money works so I don't have to.`
      : `Office hours. ${r(s.coins)} in the treasury. Citizens know where to find me.`);
  }
  if (Math.random() < 0.05) {
    const rest = find((o) => o.action === 'rest');
    if (rest) return choose(rest, `${r(s.coins)} coins, hunger ${s.hunger}/10. I can afford a short break.`);
  }

  // 10. Otherwise work whatever pays best for my skills.
  const work = options
    .filter((o) => o.action === 'work')
    .map((o) => {
      const price = ctx.market[o.item] || PRICES[o.item].fair;
      let score = (s.skills[o.item] * price) / (o.base / 1000);
      if (isFood(o.item) && foodHeld < 2) score *= 1.4;
      return { o, score: score * (0.85 + Math.random() * 0.3), price };
    })
    .sort((a, b) => b.score - a.score);
  const best = work[0];
  return choose(best.o, `${best.o.item[0].toUpperCase() + best.o.item.slice(1)} pays best for me right now: skill x${s.skills[best.o.item]}, last price ${best.price}.`);
}

// ---------- Negotiation over goods ----------

export async function propose(agent, other, side, item, qty, ctx, suggested) {
  const fair = ctx.market[item] || PRICES[item].fair;
  const p = PRICES[item];
  const llm = suggested ? null : await askLLM(
    agent,
    `${describe(ctx, true)}\n\nYou walked up to ${other.name} to ${side} ${qty} ${item}. Name your price per ${item}.`,
    '{"thought": string, "price": number, "say": string}',
    'propose',
  );
  if (llm && Number.isFinite(+llm.price)) return { price: clamp(r(+llm.price), p.min, p.max), say: llm.say, thought: llm.thought };
  const v = valueOf(agent, ctx, item);
  const refused = ctx.refusals?.[`${side}:${item}:${other.id}`];
  let price = suggested
    ?? (side === 'sell'
      ? r(Math.max(ml(ctx, item) + 1, fair * (1 + agent.haggle * 0.35 + (Math.random() - 0.5) * 0.12)))
      : r(Math.min(v, fair * (1 - agent.haggle * 0.25 + (Math.random() - 0.5) * 0.1))));
  if (refused && !suggested) price = side === 'sell' ? r(Math.max(ml(ctx, item) + 1, Math.min(price, refused * 0.88))) : r(Math.max(price, refused * 1.12));
  const say = side === 'sell'
    ? pick([`${qty} ${item}, ${price} each.`, `Fresh ${item}. ${price} a piece.`, `For you? ${price} each.`])
    : pick([`I'll take ${qty} ${item}. ${price} each?`, `${price} each for your ${item}. Deal?`, `Need ${item}. Paying ${price}.`]);
  const thought = refused
    ? `Last time ${other.name} wouldn't do ${refused}. Trying ${price} this time.`
    : side === 'sell'
      ? `Fair is about ${fair}. Opening at ${price} leaves room to come down.`
      : `Fair is about ${fair}. Bidding ${price}; I'd go to ${r(v)} if I have to.`;
  return { price: clamp(price, p.min, p.max), say, thought };
}

export async function respond(agent, proposer, side, item, qty, price, ctx) {
  const buying = side === 'sell';
  const total = qty * price;
  const p = PRICES[item];
  if (buying && ctx.self.coins < total) {
    return { decision: 'reject', say: pick(["Can't afford that.", 'My wallet says no.']), thought: `${total} coins total and I only have ${r(ctx.self.coins)}. Not happening.` };
  }
  if (!buying && ctx.role === 'builder' && ctx.myJobs?.some((j) => (j[item] || 0) > 0)) {
    return { decision: 'reject', say: `Need my ${item} for a job.`, thought: `I owe people buildings. Every bit of ${item} I have is spoken for.` };
  }
  if (!buying && (ctx.self.inv[item] || 0) < qty) {
    return { decision: 'reject', say: `Don't have ${qty} ${item}.`, thought: `They want ${qty} ${item} but I've only got ${ctx.self.inv[item] || 0}.` };
  }
  // Clear-cut offers (an obvious bargain, or an obvious insult) get the rule brain's answer; the AI handles close calls.
  const grudge = ctx.grudges?.some((g) => g.id === proposer.id);
  const rule = ruleRespond(agent, buying, item, price, ctx, grudge);
  if (LLM_ON && rule.clear) { usage.ruleShortcuts++; return rule; }
  const llm = await askLLM(
    agent,
    `${describe(ctx, true)}\n\n${proposer.name} offers to ${side} ${qty} ${item} at ${price} each (${total} total). ` +
      `You are the ${buying ? 'buyer' : 'seller'}. Accept, counter, or reject.`,
    '{"thought": string, "decision": "accept" | "counter" | "reject", "price": number (your counter, if countering), "say": string}',
    'respond',
  );
  if (llm && ['accept', 'counter', 'reject'].includes(llm.decision)) {
    return { decision: llm.decision, price: clamp(r(+llm.price || price), p.min, p.max), say: llm.say, thought: llm.thought };
  }
  return rule;
}

function ruleRespond(agent, buying, item, price, ctx, grudge = false) {
  const p = PRICES[item];
  // With someone you don't trust you buy cheaper and sell dearer.
  const v = valueOf(agent, ctx, item) * (grudge ? (buying ? 0.82 : 1.25) : 1);
  if (buying) {
    const max = v * 1.05;
    if (price <= max && (Math.random() > agent.haggle * 0.7 || price <= v * 0.8)) {
      return { clear: price <= v * 0.8, decision: 'accept', say: pick(['Deal.', 'Done.', 'Shake on it.']), thought: `${price} each is under what it's worth to me (~${r(v)}). Taking it.` };
    }
    if (price <= max * 1.35) {
      const c = r(Math.max(p.min, Math.min(price - 1, v * (0.85 + Math.random() * 0.1))));
      return { decision: 'counter', price: c, say: pick([`${c}, and we have a deal.`, `How about ${c}?`, `${c}. Final-ish.`]), thought: `${price} is steep. It's worth ~${r(v)} to me, so I'll counter at ${c}.` };
    }
    return { clear: true, decision: 'reject', say: pick(['Way too much.', 'In your dreams.']), thought: `${price} each? It's worth maybe ${r(v)} to me. Walking.` };
  }
  const floor = Math.max(ml(ctx, item), v * 0.9);
  if (price >= floor && (Math.random() > agent.haggle * 0.7 || price >= v * 1.15)) {
    return { clear: price >= v * 1.15, decision: 'accept', say: pick(['Deal.', 'Fine by me.', 'Sold.']), thought: `${price} beats the mainland's ${ml(ctx, item)} and my floor of ~${r(floor)}. Selling.` };
  }
  if (price >= floor * 0.7) {
    const c = r(Math.min(p.max, Math.max(price + 1, floor * (1.05 + Math.random() * 0.1))));
    return { decision: 'counter', price: c, say: pick([`Make it ${c}.`, `${c} or no deal.`, `I need ${c}.`]), thought: `${price} is lowball. My floor is ~${r(floor)}, so ${c}.` };
  }
  return { clear: true, decision: 'reject', say: pick(['Not that low.', "I'll keep it."]), thought: `${price}? The mainland pays ${ml(ctx, item)}. No.` };
}

export async function answerCounter(agent, other, side, item, qty, counter, original, ctx) {
  // A counter within a few percent of your own price is an easy yes; the AI weighs the real gaps.
  if (LLM_ON && Math.abs(counter - original) <= Math.max(1, original * 0.06)) {
    usage.ruleShortcuts++;
    return { decision: 'accept', say: pick(['Fine. Deal.', 'Close enough. Deal.', 'Shake on it.']), thought: `${counter} vs my ${original}: close enough to call it a deal.` };
  }
  const llm = await askLLM(
    agent,
    `${describe(ctx, true)}\n\nYou offered to ${side} ${qty} ${item} at ${original} each. ${other.name} counters with ${counter}. Accept or reject?`,
    '{"thought": string, "decision": "accept" | "reject", "say": string}',
    'counter',
  );
  if (llm && ['accept', 'reject'].includes(llm.decision)) return llm;
  const v = valueOf(agent, ctx, item);
  const flip = agent._flipMax && agent._flipMax.item === item && Date.now() < agent._flipMax.until ? agent._flipMax.max : null;
  if (side === 'buy' && flip !== null && counter > flip) {
    return { decision: 'reject', say: pick(['Then I pass.', 'Too rich for a resale.', 'No margin in that.']), thought: `At ${counter} there's nothing left after the mainland pays ${ml(ctx, item)}. I walk.` };
  }
  const ok = side === 'sell' ? counter >= Math.max(ml(ctx, item), v * 0.82) || ctx.self.coins < 100 : counter <= v * 1.25 || ctx.self.hunger >= 7;
  return ok
    ? { decision: 'accept', say: pick(['Fine. Deal.', 'Grr. Okay.', 'You win this one.']), thought: `${counter} isn't what I wanted, but it still works for me.` }
    : { decision: 'reject', say: pick(['No way.', 'Forget it.', 'Not at that price.']), thought: `${counter} doesn't work for me. I'll find another deal.` };
}

// ---------- Loans ----------

export async function loanTerms(banker, borrower, amount, ctx, credit, byBanker = false) {
  const other = ctx.others.find((o) => o.id === borrower.id);
  const rival = ctx.others.find((o) => o.role === 'banker');
  const obviousNo = credit.defaulted >= 2 || ctx.self.coins < amount + 300;
  // The banker already chose to pitch this loan; terms come from the rate card, no second AI call.
  const llm = (obviousNo || byBanker) && LLM_ON ? (usage.ruleShortcuts++, null) : await askLLM(
    banker,
    `${describe(ctx, true)}\n\n${borrower.name} asks to borrow ${amount} coins, repaid in ${LOAN.termMs / 1000}s. ` +
      `Their record with the island's banks: ${credit.repaid} repaid, ${credit.defaulted} defaulted. They have ${r(other?.coins ?? 0)} coins now. ` +
      `${rival ? `${rival.name} runs a rival bank. ` : ''}Offer terms (amount up to what they asked, interest rate as a decimal, e.g. 0.15) or decline.`,
    '{"thought": string, "decision": "offer" | "decline", "amount": number, "rate": number, "say": string}',
    'loanTerms',
  );
  if (llm && ['offer', 'decline'].includes(llm.decision)) {
    return { decision: llm.decision, amount: clamp(r(+llm.amount || amount), 50, amount), rate: clamp(+llm.rate || 0.15, 0.02, 0.6), say: llm.say, thought: llm.thought };
  }
  if (credit.defaulted >= 2 || ctx.self.coins < amount + 300) {
    return { decision: 'decline', amount: 0, rate: 0, say: pick(["I'm afraid not.", 'Not this time.']), thought: credit.defaulted >= 2 ? `${borrower.name} has defaulted ${credit.defaulted} times. No more loans.` : `Lending ${amount} would leave the vault too thin.` };
  }
  let rate = 0.1 + credit.defaulted * 0.15 - Math.min(credit.repaid, 3) * 0.02 + (other && other.coins < 100 ? 0.05 : 0);
  if (rival) rate -= 0.02; // competition keeps rates down
  rate = +Math.max(0.03, rate).toFixed(2);
  const size = credit.defaulted ? Math.min(amount, 250) : amount;
  return {
    decision: 'offer', amount: size, rate,
    say: pick([`${size} at ${r(rate * 100)}%. Due soon.`, `I can do ${size}, ${r(rate * 100)}% interest.`, `${size} coins. ${r(rate * 100)}%. Don't be late.`]),
    thought: `${borrower.name}: ${credit.repaid} repaid, ${credit.defaulted} defaulted. ${size} at ${r(rate * 100)}% earns me ${r(size * rate)} if they pay${rival ? `, and keeps them away from ${rival.name}` : ''}.`,
  };
}

export async function loanAccept(borrower, banker, amount, rate, owed, ctx) {
  if (LLM_ON && (rate <= 0.12 || rate >= 0.45)) {
    usage.ruleShortcuts++;
    return rate <= 0.12
      ? { decision: 'accept', say: pick(['Deal. Thank you.', "I'll pay it back.", 'Done.']), thought: `${r(rate * 100)}% is cheap money. ${owed} back for ${amount} now.` }
      : { decision: 'reject', say: pick(['Too steep for me.', "I'll manage without."]), thought: `${r(rate * 100)}% is loan-shark territory. No thanks.` };
  }
  const llm = await askLLM(
    borrower,
    `${describe(ctx, true)}\n\n${banker.name} offers you ${amount} coins at ${r(rate * 100)}% interest: repay ${owed} within ${LOAN.termMs / 1000}s ` +
      'or your coins get seized. Accept or walk away?',
    '{"thought": string, "decision": "accept" | "reject", "say": string}',
    'loanAnswer',
  );
  if (llm && ['accept', 'reject'].includes(llm.decision)) return llm;
  const ok = rate <= 0.3 || ctx.self.coins < 80;
  return ok
    ? { decision: 'accept', say: pick(['Deal. Thank you.', "I'll pay it back.", 'Done.']), thought: `${owed} back for ${amount} now. I can earn that before it's due.` }
    : { decision: 'reject', say: pick(['Too steep for me.', "I'll manage without."]), thought: `${r(rate * 100)}% is loan-shark territory. I'll take my chances.` };
}

// ---------- Construction contracts ----------

export async function contractQuote(builder, client, what, cost, ctx, queue) {
  const woodCost = cost.wood * (ctx.market.wood || PRICES.wood.fair);
  const oreCost = cost.ore * (ctx.market.ore || PRICES.ore.fair);
  const rival = ctx.others.find((o) => o.role === 'builder');
  const llm = await askLLM(
    builder,
    `${describe(ctx, true)}\n\n${client.name} wants you to build a ${what} (${cost.wood} wood${cost.ore ? `, ${cost.ore} ore` : ''}, about ${r(cost.buildMs / 1000)}s of work). ` +
      `You have ${queue} other jobs queued.${rival ? ` ${rival.name} is a rival builder.` : ''} Materials are worth ~${r(woodCost + oreCost)}. Quote a total price, paid upfront.`,
    '{"thought": string, "price": number, "say": string}',
    'contractQuote',
  );
  // Never below materials plus half the labor, so a builder can't work at a loss by accident.
  const floor = r(woodCost + oreCost + cost.labor * 0.5);
  if (llm && Number.isFinite(+llm.price)) return { price: clamp(Math.max(r(+llm.price), floor), 60, 5000), say: llm.say, thought: llm.thought };
  const price = r((woodCost + oreCost + cost.labor) * (1 + builder.haggle * 0.3 + queue * 0.08 - (rival ? 0.06 : 0)));
  return {
    price,
    say: pick([`${price} coins, paid upfront.`, `A ${what}? ${price}. Quality work.`, `${price} and it's yours.`]),
    thought: `Materials ~${r(woodCost + oreCost)}, plus ${cost.labor} for labor${queue ? ` and ${queue} jobs ahead` : ''}${rival ? `, trimmed a bit so ${rival.name} doesn't steal the job` : ''}. ${price} is fair.`,
  };
}

export async function contractAnswer(client, builder, what, price, perk, ctx, budget) {
  if (LLM_ON && (price > ctx.self.coins * 0.6 || (budget && price <= budget))) {
    usage.ruleShortcuts++;
    return price > ctx.self.coins * 0.6
      ? { decision: 'reject', say: 'Too rich for me right now.', thought: `${price} is over half my ${r(ctx.self.coins)} coins. Not yet.` }
      : { decision: 'accept', say: 'Deal. Build it.', thought: `${price} is inside the ${budget} I set aside for this. Done.` };
  }
  const llm = await askLLM(
    client,
    `${describe(ctx, true)}\n\n${builder.name} quotes ${price} coins upfront to build your ${what} (${perk}). Accept, counter, or reject?`,
    '{"thought": string, "decision": "accept" | "counter" | "reject", "price": number (counter), "say": string}',
    'contractAnswer',
  );
  if (llm && ['accept', 'counter', 'reject'].includes(llm.decision)) return { decision: llm.decision, price: r(+llm.price || price * 0.85), say: llm.say, thought: llm.thought };
  const coins = ctx.self.coins;
  if (price > coins * 0.6) return { decision: 'reject', say: 'Too rich for me right now.', thought: `${price} is over half my ${r(coins)} coins. Not yet.` };
  if (budget && price <= budget) return { decision: 'accept', say: 'Deal. Build it.', thought: `${price} is within my budget of ${budget}.` };
  if (Math.random() < client.haggle) {
    const c = r(price * (0.82 + Math.random() * 0.08));
    return { decision: 'counter', price: c, say: `How about ${c}?`, thought: `${price} feels padded. Countering at ${c}.` };
  }
  return { decision: 'accept', say: pick(['Deal. Build it.', 'Fair enough.']), thought: `${price} for a ${what}: ${perk}. Worth it.` };
}

// ---------- Small talk while working ----------
const IDLE = {
  bruno: ['Rock. More rock.', 'Mountain is mine someday.', 'Good swing.', '*grunts*'],
  felix: ['Buy low, sell high.', "Fishin' for profits.", 'Another day, another coin.', 'Reel deal.'],
  penny: ['Interest never sleeps.', 'A penny saved...', 'Balanced books, happy pig.', 'Mm, compounding.'],
  bea: ['Measure twice, chop once.', 'Timber!', 'Busy as a beaver.', 'Good wood.'],
  dot: ['Quack! Big one!', 'Did you hear about Felix?', 'Fresh catch, cheap!'],
  rosa: ['Grain for everyone!', 'Rows straight as arrows.', 'Hop to it.'],
  otto: ['Hoo-hum. Civic matters.', 'For the good of Insula.', 'The treasury is sound.'],
  rico: ['Nothing to see here.', 'Lovely evening...', 'Just passing through.'],
  moe: ['Dig, dig, dig.', 'Can\'t see a thing. Love it.', 'Ore! I think.'],
  gus: ['Bea calls that a wall?', 'Built like a goat. Sturdy.', 'Baaa-rgain prices.'],
  ivy: ['Better rates than Penny.', 'Purr-fect credit only.', 'Interest, darling.'],
  shelly: ['Slow and steady.', 'Patience pays.', 'In my day...'],
  hazel: ['Felix who?', 'Bulk deals, quick.', 'Prickly about prices.'],
};
export function idleLine(agent) {
  return pick(IDLE[agent.id] || ['...']);
}
