// The Insula Daily: an island newspaper with one edition per genesis day.
// The reporter watches every event, keeps a tally of the day, and when the day turns over it writes
// the edition: a lead story, a few more stories, the markets, the day's winners and losers, and a quote.
// Every fact comes from what actually happened. With an LLM key the model polishes the wording
// (one call a day); without one, the templates below write it.

import { PROJECTS, ITEMS } from './agents.js';
import { ERAS } from './eras.js';
import * as brain from './brain.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_EDITIONS = 400;
const HAGGLE = /each for your|a piece|we have a deal|^Paying|Paying \d|Deal\?|^\d+ coins|Sold\.|^Fine\./i;
const DRAMA_ACTS = new Set(['CAUGHT', 'GOT AWAY', 'FINISHED', 'ARRIVE', 'FINE', 'DEFAULT', 'STEAL', 'DONATE', 'BORROW', 'HIRE', 'REPAID', 'COLLECTED', 'TAX DAY', 'WALK AWAY']);

function fresh(sim, day) {
  return {
    day,
    open: {
      balances: Object.fromEntries(Object.keys(sim.agents).map((id) => [id, Math.round(sim.chain.balance(id))])),
      prices: Object.fromEntries(ITEMS.map((i) => [i, sim.market[i]?.last ?? 0])),
      gdp: sim.market.gdp,
      trades: sim.market.trades,
    },
    trades: 0, volume: 0,
    exports: { qty: 0, coins: 0 }, imports: { qty: 0, coins: 0 },
    goods: {},
    loans: [], repays: 0, defaults: [], contracts: [], donations: [], taxes: 0, fines: [], relief: 0, candidates: [], elections: [],
    thefts: [], built: [], landmarks: [], eras: [], arrivals: [], basicIncome: [],
    biggest: null,
    quotes: [],
  };
}

export class Reporter {
  constructor(sim, saved) {
    this.sim = sim;
    this.editions = saved?.editions || [];
    this.acc = saved?.acc || null;
  }

  start() {
    if (!this.acc) this.acc = fresh(this.sim, this.sim.genesisDay());
    this.sim.on((e) => this.observe(e));
    setInterval(() => this.tick(), 2000);
  }

  save() {
    return { editions: this.editions, acc: this.acc };
  }

  name(id) { return this.sim.agents[id]?.name || (id === 'bank' ? 'the bank' : id); }

  observe(e) {
    if (e.type === 'daily') return;
    this.tick();
    const a = this.acc;
    if (!a) return;
    if (e.type === 'trade') {
      const amt = Math.round(e.amount || 0);
      switch (e.kind) {
        case 'export': a.exports.qty += e.qty || 0; a.exports.coins += amt; break;
        case 'import': a.imports.qty += e.qty || 0; a.imports.coins += amt; break;
        case 'loan': a.loans.push({ lender: e.from, borrower: e.to, amount: amt }); break;
        case 'repay': a.repays++; break;
        case 'default': a.defaults.push({ who: e.from, lender: e.to, amount: amt }); break;
        case 'contract': a.contracts.push({ client: e.from, builder: e.to, amount: amt, text: e.text }); break;
        case 'donation': a.donations.push({ who: e.from, amount: amt, text: e.text }); break;
        case 'tax': a.taxes += amt; break;
        case 'fine': a.fines.push({ thief: e.from, victim: e.to, amount: amt }); break;
        case 'relief': a.relief = (a.relief || 0) + amt; break;
        case 'income': if (/basic income/.test(e.text || '')) a.basicIncome.push(e.to); break;
        default:
          if (ITEMS.includes(e.kind)) {
            const g = (a.goods[e.kind] ||= { qty: 0, coins: 0, deals: 0 });
            g.qty += e.qty || 0; g.coins += amt; g.deals++;
          }
      }
      if (!['income', 'tax', 'fine', 'relief', 'treasury'].includes(e.kind)) {
        a.trades++;
        a.volume += amt;
        if (!a.biggest || amt > a.biggest.amount) a.biggest = { amount: amt, text: e.text, kind: e.kind, from: e.from, to: e.to };
      }
    } else if (e.type === 'story') {
      if (e.kind === 'theft') a.thefts.push({ thief: e.thief, victim: e.victim, item: e.item, n: e.n, caught: e.caught });
      if (e.kind === 'election') (a.elections ||= []).push({ n: e.n, winner: e.winner, prev: e.prev, changed: e.changed, tally: e.tally, policy: e.policy });
      if (e.kind === 'built') a.built.push({ owner: e.owner, builder: e.builder, btype: e.btype, level: e.level });
    } else if (e.type === 'election' && e.kind === 'candidate') {
      (a.candidates ||= []).push({ n: e.n, id: e.candidate.id, tax: e.candidate.tax, fine: e.candidate.fine, focus: e.candidate.focus, pitch: e.candidate.pitch, incumbent: e.candidate.incumbent });
    } else if (e.type === 'world' && e.kind === 'landmark') {
      a.landmarks.push(e.project);
    } else if (e.type === 'era') {
      a.eras.push({ id: e.id, title: e.title, summary: e.summary });
    } else if (e.type === 'arrival') {
      a.arrivals.push({ id: e.agent, name: e.name, species: e.species, job: e.job });
      a.open.balances[e.agent] = Math.round(this.sim.chain.balance(e.agent));
    } else if ((e.type === 'say' || e.type === 'thought') && e.text && e.agent) {
      // Keep a handful of quotable lines, weighted toward the dramatic ones. Haggling numbers make dull quotes.
      if (HAGGLE.test(e.text) || e.text.length < 16) return;
      if (e.type === 'thought' && !DRAMA_ACTS.has(e.action) && Math.random() > 0.03) return;
      const drama = (e.type === 'thought' && DRAMA_ACTS.has(e.action) ? 3 : 0) + (/THIEF|caught|open|default|built|finished|Hello/i.test(e.text) ? 2 : 1);
      a.quotes.push({ agent: e.agent, name: e.name, text: e.text, drama, kind: e.type === 'say' ? 'said' : 'thought' });
      if (a.quotes.length > 40) a.quotes.sort((x, y) => y.drama - x.drama).splice(30 + Math.floor(Math.random() * 10), 1);
    }
  }

  // Close the day as soon as it turns over (before counting the next event), then write it up.
  tick() {
    if (!this.acc || this.sim.genesisDay() <= this.acc.day) return;
    const acc = this.acc;
    this.acc = fresh(this.sim, this.sim.genesisDay());
    this.publish(acc)
      .then((ed) => {
        this.editions.push(ed);
        this.editions.sort((x, y) => x.day - y.day);
        if (this.editions.length > MAX_EDITIONS) this.editions.shift();
        this.sim.emit({ type: 'daily', day: ed.day, headline: ed.headline, deck: ed.deck });
      })
      .catch((e) => console.error('[daily] could not write the paper:', e.message));
  }

  latest() { return this.editions[this.editions.length - 1] || null; }
  edition(day) { return this.editions.find((e) => e.day === day) || null; }
  index() { return this.editions.map((e) => ({ day: e.day, headline: e.headline })); }

  // Today's paper so far, written from the live tally (templates only, no LLM).
  live() { return this.acc ? { ...this.compile(this.acc), live: true } : null; }

  async publish(acc) {
    const ed = this.compile(acc);
    if (brain.LLM_ON) {
      const polished = await brain.writePaper(ed).catch(() => null);
      if (polished) {
        ed.headline = polished.headline || ed.headline;
        ed.deck = polished.deck || ed.deck;
        (polished.stories || []).forEach((s, i) => {
          if (ed.stories[i] && s?.body) ed.stories[i] = { ...ed.stories[i], title: s.title || ed.stories[i].title, body: s.body };
        });
        ed.writer = brain.llmStats().model;
      }
    }
    ed.publishedAt = Date.now();
    return ed;
  }

  // ---------- Writing the paper from the facts ----------

  compile(acc) {
    const sim = this.sim;
    const n = (id) => this.name(id);
    const close = Object.fromEntries(Object.keys(sim.agents).map((id) => [id, Math.round(sim.chain.balance(id))]));
    const movers = Object.keys(close)
      .map((id) => ({ id, name: n(id), delta: close[id] - (acc.open.balances[id] ?? close[id]), coins: close[id] }))
      .filter((m) => m.delta !== 0)
      .sort((x, y) => y.delta - x.delta);
    const markets = ITEMS.filter((i) => sim.itemsOpen().includes(i)).map((i) => {
      const open = acc.open.prices[i] || sim.market[i].last;
      const cl = sim.market[i].last;
      return { item: i, open, close: cl, pct: open ? Math.round(((cl - open) / open) * 100) : 0 };
    });
    const richest = Object.entries(close).sort((x, y) => y[1] - x[1])[0];

    const cands = [];
    const add = (score, kicker, title, body) => cands.push({ score, kicker, title, body });

    for (const id of acc.landmarks) {
      const p = PROJECTS[id];
      add(100, 'Public works', `The ${p.label} opens`, `After agents chipped in coins of their own, the ${p.label} is finished. What it changes: ${p.perk}. No human approved it, funded it or built it.`);
    }
    // A milestone that brings a new resident is one story, not two.
    const covered = new Set();
    for (const e of acc.eras) {
      if (e.id === 'genesis') continue;
      if (e.id === 'festival') { add(120, 'Day 30', 'The city of Insula', `One month since genesis. ${plural(Object.keys(sim.agents).length, 'agent')}, ${plural(sim.buildings.filter((b) => b.progress >= 1).length, 'building')} and every coin on-chain. Fireworks over a town the agents built themselves.`); continue; }
      const def = ERAS.find((x) => x.id === e.id);
      for (const id of def?.unlock.arrivals || []) covered.add(id);
      if (def?.unlock.projects?.length) {
        // A project opening is a fundraiser, not a finished building: say so plainly.
        const p = PROJECTS[def.unlock.projects[0]];
        add(70, 'Public works', `Fundraising opens for the ${p.label}`, `${e.summary} Nothing is built yet: residents now decide whether to chip in the ${p.labor} coins it needs. If it gets built: ${p.perk}.`);
      } else add(84, 'The island grows', e.title, e.summary);
    }
    for (const r of acc.arrivals.filter((r) => !covered.has(r.id))) {
      add(85, 'New in town', `${r.name} the ${cap(r.species)} moves to Insula`, `A new ${r.job} stepped off the boat with a wallet of their own and a welcome grant from the bank. Insula now has ${plural(Object.keys(sim.agents).length, 'resident')}.`);
    }
    const an = (x) => (/^(8|11|18)/.test(String(x)) ? 'an' : 'a');
    const rules = (p) => `property tax ${p.tax} per building level, ${an(p.fine)} ${p.fine}-coin fine for theft, and a treasury that ${p.focus === 'relief' ? 'repays theft victims' : 'funds public works'}`;
    for (const el of acc.elections || []) {
      const score = Object.entries(el.tally).sort((x, y) => y[1] - x[1]).map(([id, v]) => `${n(id)} ${v}`).join(', ');
      add(el.changed ? 110 : 90, 'Election', el.changed ? `${n(el.winner)} unseats ${n(el.prev)} as mayor` : `Mayor ${n(el.winner)} re-elected`,
        `Every resident voted, and every vote came with a reason anyone can check. Final count: ${score}. The new rules: ${rules(el.policy)}.`);
    }
    const running = (acc.candidates || []).filter((c) => !(acc.elections || []).some((el) => el.n === c.n));
    if (running.length) {
      const list = running.map((c) => `${n(c.id)}${c.incumbent ? ' (the mayor)' : ''} on tax ${c.tax} and fine ${c.fine}: "${c.pitch}"`).join('; ');
      add(running.length > 1 ? 88 : 60, 'Election', running.length > 1 ? `${running.length} animals run for mayor` : `${n(running[0].id)} runs unopposed`, `The campaign is on. ${list}. Voting is tomorrow.`);
    }
    if (acc.relief > 0) add(42, 'Town hall', `Treasury repays ${fmt(acc.relief)} coins to theft victims`, 'Under the mayor\'s relief policy, goods stolen in the night are paid back from the town treasury.');
    const caught = acc.thefts.filter((t) => t.caught);
    const away = acc.thefts.filter((t) => !t.caught);
    if (caught.length) {
      const t = caught[caught.length - 1];
      const fine = acc.fines.find((f) => f.thief === t.thief);
      add(72, 'Crime', `${n(t.thief)} caught red-handed`, `${n(t.victim)} caught ${n(t.thief)} taking ${t.n} ${t.item} in the night. The goods went back${fine ? `, and the mayor fined ${n(t.thief)} ${fine.amount} coins, paid straight to ${n(t.victim)}` : ''}.${caught.length > 1 ? ` It was one of ${caught.length} arrests today.` : ''}`);
    }
    if (away.length) {
      const victims = [...new Set(away.map((t) => n(t.victim)))];
      const items = away.reduce((m, t) => ((m[t.item] = (m[t.item] || 0) + t.n), m), {});
      const list = Object.entries(items).map(([i, q]) => `${q} ${i}`).join(', ');
      add(away.length >= 3 ? 68 : 58, 'Crime', away.length === 1 ? 'Goods go missing in the night' : `Night thief strikes ${away.length} times`, `${list} went missing overnight from ${victims.slice(0, 3).join(', ')}${victims.length > 3 ? ' and others' : ''}. Nobody was caught.`);
    }
    for (const d of acc.defaults) {
      add(66, 'Credit', `${n(d.who)} defaults on a loan`, `${n(d.lender)}'s loan to ${n(d.who)} came due and couldn't be paid in full. ${n(d.lender)} took back ${fmt(d.amount)} coins and marked the loss in the books.`);
    }
    const bigContract = acc.contracts.slice().sort((x, y) => y.amount - x.amount)[0];
    if (bigContract) {
      const others = acc.contracts.length - 1;
      add(bigContract.amount >= 300 ? 56 : 40, 'Construction', `${n(bigContract.client)} hires ${n(bigContract.builder)} for ${fmt(bigContract.amount)} coins`, `${bigContract.text}.${others > 0 ? ` ${plural(others, 'more contract')} signed today.` : ''}`);
    }
    if (acc.built.length) {
      const list = acc.built.slice(0, 3).map((b) => `${n(b.owner)}'s ${b.level > 1 ? `level ${b.level} ` : ''}${b.btype}`);
      const one = acc.built[0];
      add(acc.built.length >= 3 ? 52 : 38, 'Construction', acc.built.length === 1 ? `${n(one.builder)} finishes ${n(one.owner)}'s ${one.level > 1 ? `level ${one.level} ` : ''}${one.btype}` : `${plural(acc.built.length, 'new building')} finished`, `Finished today: ${list.join(', ')}${acc.built.length > 3 ? ' and more' : ''}. The island now has ${plural(sim.buildings.filter((b) => b.progress >= 1).length, 'building')}.`);
    }
    const donated = acc.donations.reduce((t, d) => t + d.amount, 0);
    if (donated > 0) {
      const top = acc.donations.slice().sort((x, y) => y.amount - x.amount)[0];
      add(44, 'Public works', `Residents give ${fmt(donated)} coins to public projects`, `The biggest gift came from ${n(top.who)}: ${top.text}.`);
    }
    // A treasury handover isn't anyone's good or bad day: leave both mayors out of the money stories.
    const handed = new Set((acc.elections || []).filter((el) => el.changed).flatMap((el) => [el.winner, el.prev]));
    const top = movers.find((m) => !handed.has(m.id));
    if (top && top.delta >= 200) {
      const m = top;
      add(Math.min(62, 40 + m.delta / 100), 'Money', `${m.name} up ${fmt(m.delta)} coins`, `${m.name} ended the day with ${fmt(m.coins)} coins, the best day on the island.${richest && richest[0] === m.id ? ` That keeps ${m.name} the richest agent in Insula.` : ''}`);
    }
    // Paying a builder isn't a rough day, it's a purchase (the construction story covers it).
    const clients = new Set(acc.contracts.map((c) => c.client));
    const loser = movers.filter((m) => !clients.has(m.id) && !handed.has(m.id)).pop();
    if (loser && loser.delta <= -200) {
      add(Math.min(54, 36 + -loser.delta / 100), 'Money', `A rough day for ${loser.name}`, `${loser.name} is down ${fmt(-loser.delta)} coins, closing at ${fmt(loser.coins)}.`);
    }
    for (const m of markets) {
      if (Math.abs(m.pct) >= 25 && m.open > 0) {
        add(46 + Math.min(10, Math.abs(m.pct) / 10), 'Markets', `${cap(m.item)} ${m.pct > 0 ? 'jumps' : 'slides'} ${Math.abs(m.pct)}%`, `${cap(m.item)} went from ${m.open} to ${m.close} coins between agents today${acc.goods[m.item] ? `, across ${plural(acc.goods[m.item].deals, 'deal')}` : ''}.`);
      }
    }
    if (acc.loans.length) {
      const lent = acc.loans.reduce((t, l) => t + l.amount, 0);
      add(34, 'Credit', `${plural(acc.loans.length, 'loan')} written`, `The banks lent ${fmt(lent)} coins today and were repaid ${plural(acc.repays, 'time')}.`);
    }
    if (acc.exports.coins > 0) {
      add(30, 'Trade', `${fmt(acc.exports.qty)} goods shipped to the mainland`, `Exports brought in ${fmt(acc.exports.coins)} coins${acc.imports.coins ? `, against ${fmt(acc.imports.coins)} spent on imports` : ''}.`);
    }
    if (acc.taxes > 0) add(28, 'Town hall', `Mayor collects ${fmt(acc.taxes)} coins in tax`, 'Property tax goes into the town treasury and back into public works.');

    cands.sort((x, y) => y.score - x.score);
    const lead = cands[0] || { kicker: 'Island life', title: `A quiet day in Insula`, body: `${plural(acc.trades, 'trade')} and nothing out of the ordinary. The agents worked, ate and haggled.` };
    const stories = cands.slice(1, 5).map(({ kicker, title, body }) => ({ kicker, title, body }));

    const quotes = acc.quotes.slice().sort((x, y) => y.drama - x.drama);
    const q = quotes.length ? quotes[Math.floor(Math.random() * Math.min(4, quotes.length))] : null;

    return {
      day: acc.day + 1,
      headline: lead.title,
      kicker: lead.kicker,
      deck: lead.body,
      stories,
      quote: q ? { name: q.name, agent: q.agent, text: q.text, kind: q.kind } : null,
      markets,
      movers: { up: movers.filter((m) => m.delta > 0).slice(0, 3), down: movers.filter((m) => m.delta < 0).slice(-3).reverse() },
      numbers: {
        trades: acc.trades,
        volume: Math.round(acc.volume),
        built: acc.built.length + acc.landmarks.length,
        thefts: acc.thefts.length,
        population: Object.keys(sim.agents).length,
        bank: Math.round(sim.chain.balance('bank')),
      },
      writer: 'rule',
    };
  }
}
