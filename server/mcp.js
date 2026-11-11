// The Insula MCP server: a read-only line into the island for any AI agent or app.
//
// MCP (Model Context Protocol) is how AI agents plug into outside tools. This serves it at POST /mcp over
// "Streamable HTTP", stateless, with plain JSON responses: no sessions, no keys, nothing that can move money.
// An agent can check an animal's on-chain reputation before dealing with it, read prices and the news,
// look up any decision record and verify a payment against the decision behind it.
//
// Everything returned is the same data the site shows; on-chain facts come with their transaction links.

import crypto from 'node:crypto';
import { memoFromInput } from './chain-evm.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const env = (k, d) => (typeof process !== 'undefined' && process.env?.[k]) || d;
const BASE = () => env('PUBLIC_URL', 'https://insulaworld.com').replace(/\/$/, '');
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const AGENT_ARG = { type: 'string', description: "The animal: its name or id (e.g. 'Rico', 'penny'), its ERC-8004 agent id (e.g. '23385'), or its wallet address." };

const INSTRUCTIONS = `Insula World is an autonomous AI-agent economy on Robinhood Chain: eight AI animals with their own wallets trade, lend, build, steal and elect a mayor, paying each other in $INSULA. Every payment carries a fingerprint of the decision that caused it. Each animal is a registered ERC-8004 agent, the animals rate each other on-chain after real deals (ERC-8004 Reputation Registry), and outside validators check Insula's claims (ERC-8004 Validation Registry).
Start with island_overview. Before trusting an animal, call check_reputation. Scores are 0-100; every rating links to the transactions behind it. This server is read-only.`;

// ---------- helpers ----------
const round = (n, d = 2) => (typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : n);
const trim = (s, n = 400) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
const verdict = (score, count) => {
  if (!count) return 'No ratings yet: no track record to go on.';
  if (score >= 90) return 'Trustworthy: other animals consistently rate their deals with this one well.';
  if (score >= 70) return 'Mostly reliable, with some bad marks.';
  if (score >= 40) return 'Mixed record: deal with caution, prefer payment up front.';
  return 'Untrustworthy: a record of thefts or defaults. Avoid, or demand payment up front.';
};

export function mountMcp(app, ctx) {
  const { sim, reputation, validation, identity, relations, leaderboard, findDecision, x402 } = ctx;
  const paid = () => !!x402?.on();
  const instructions = () => INSTRUCTIONS + (paid()
    ? `\nPricing: ${x402.freePerDay} free calls a day per client; after that each tool call costs ${x402.priceText} USDG on Robinhood Chain, paid with x402 (v2, scheme "exact", EIP-3009). The payment goes to the island's bank.`
    : '\nFree to use.');

  function findAgent(q) {
    if (q == null) return null;
    const s = String(q).trim().replace(/^#/, '').toLowerCase();
    const list = sim.state().agents;
    return list.find((a) => a.id === s || a.name?.toLowerCase() === s)
      || list.find((a) => String(a.erc8004?.agentId ?? identity.ids?.[a.id]?.agentId ?? '') === s)
      || list.find((a) => String(a.address ?? '').toLowerCase() === s)
      || list.find((a) => a.name?.toLowerCase().startsWith(s) && s.length >= 3)
      || null;
  }
  const stateAgent = (id) => sim.state().agents.find((a) => a.id === id);
  const repOf = (id) => { try { return reputation.agentView(id); } catch { return null; } };
  const notFound = (q) => { throw new ToolError(`No animal matches "${q}". Call list_agents to see who lives on the island.`); };

  // ---------- tools ----------
  const TOOLS = [
    {
      name: 'island_overview',
      title: 'Island overview',
      description: 'The state of the island right now: day, population, mayor, market prices, the economy, and links to the token, the site and the ERC-8004 registries. Start here.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const s = sim.state(), mayor = s.agents.find((a) => a.mayor);
        const m = s.market || {};
        return {
          name: 'Insula World', site: BASE(), day: s.day, dayProgress: round(s.dayProgress),
          population: s.agents.length, mayor: mayor ? { id: mayor.id, name: mayor.name } : null,
          prices: Object.fromEntries(['ore', 'fish', 'wood', 'grain'].filter((k) => m[k]).map((k) => [k, { coins: m[k].last, previous: m[k].prev }])),
          gdp: m.gdp, tradesAllTime: m.trades, economy: s.economy,
          bank: s.bank && { coins: round(s.bank.balance, 0), address: s.bank.address },
          chain: s.chain && { network: s.chain.network, mode: s.chain.mode, token: s.chain.token, explorer: s.chain.explorer, buy: s.chain.buyUrl },
          erc8004: { identityRegistry: identity.view?.().registry, reputationRegistry: reputation.view?.().registry, validationRegistry: validation.view?.().registry, projectAgentId: identity.projectId?.() || null },
          brains: s.llm?.on ? `AI (${s.llm.model})` : 'rule-based',
          note: 'Coins are $INSULA. All payments are real token transfers on Robinhood Chain.',
        };
      },
    },
    {
      name: 'list_agents',
      title: 'List the animals',
      description: 'Every animal on the island with its job, coins, what it is doing now, its ERC-8004 agent id, wallet, and on-chain reputation score.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const lb = Object.fromEntries((leaderboard().agents || []).map((a) => [a.id, a]));
        return { agents: sim.state().agents.map((a) => {
          const r = repOf(a.id);
          return {
            id: a.id, name: a.name, species: a.species, job: a.job, role: a.role, mayor: a.mayor,
            coins: round(a.balance, 0), doing: a.task, erc8004AgentId: a.erc8004?.agentId ?? null, wallet: a.address,
            reputation: r?.count ? { score: r.score, ratings: r.count } : null, trustOnIsland: lb[a.id]?.trust ?? null,
          };
        }) };
      },
    },
    {
      name: 'check_reputation',
      title: 'Check reputation',
      description: "An animal's on-chain reputation from the ERC-8004 Reputation Registry: its 0-100 score, what it was rated for (trades, loans, build jobs, defaults, thefts), who rated it, and its latest ratings with links to the rating transactions and the feedback files listing the deals behind them. Use this before trusting an animal.",
      inputSchema: { type: 'object', properties: { agent: AGENT_ARG }, required: ['agent'], additionalProperties: false },
      run({ agent }) {
        const a = findAgent(agent) || notFound(agent);
        const r = repOf(a.id) || {};
        const lb = (leaderboard().agents || []).find((x) => x.id === a.id) || {};
        return {
          agent: { id: a.id, name: a.name, species: stateAgent(a.id)?.species, erc8004AgentId: r.agentId ?? null },
          score: r.count ? r.score : null, ratings: r.count || 0, distinctRaters: r.raters || 0,
          verdict: verdict(r.score, r.count),
          byTopic: r.byTag || {},
          readBackFromChain: r.onchain || null,
          record: { trades: lb.trades, buildJobs: lb.contracts, loansRepaid: lb.loansRepaid, defaults: lb.defaults, caughtStealing: lb.caught, robbed: lb.robbed },
          latestRatings: (r.recent || []).slice(0, 8).map((x) => ({ from: x.from, score: x.value, topic: x.tag, day: x.day, summary: x.summary, tx: x.tx, feedbackFile: x.file })),
          registry: r.registry || reputation.view?.().registry, status: r.status,
          howToVerify: 'Each rating is a giveFeedback call on the ERC-8004 Reputation Registry; the feedback file lists the deals and their transactions, and its keccak256 is stored on-chain.',
        };
      },
    },
    {
      name: 'get_agent',
      title: 'Animal profile',
      description: "One animal's full profile: coins, goods, wallet, current task, relationships (trust and rivalry with each other animal), its latest decisions with its own reasoning, and reputation summary.",
      inputSchema: { type: 'object', properties: { agent: AGENT_ARG }, required: ['agent'], additionalProperties: false },
      run({ agent }) {
        const a = findAgent(agent) || notFound(agent);
        const s = stateAgent(a.id), r = repOf(a.id) || {};
        const pairs = Object.entries(relations.summary().pairs || {}).filter(([k]) => k.split('|').includes(a.id))
          .map(([k, p]) => ({ with: k.split('|').find((x) => x !== a.id), trust: p.trust, rivalry: p.rivalry, trades: p.trades, buildJobs: p.contracts, loans: p.loans, defaults: p.defaults, thefts: p.thefts }))
          .sort((x, y) => (y.trades + y.buildJobs) - (x.trades + x.buildJobs));
        const decisions = [...sim.decisionLog.values()].filter((d) => d.agent === a.id).slice(-5).reverse()
          .map((d) => ({ id: d.id, day: d.day, choice: d.choice, thought: trim(d.thought, 300), said: trim(d.said, 200), payments: (d.txs || []).map((t) => t.text) }));
        return {
          id: a.id, name: a.name, species: s.species, job: s.job, role: s.role, mayor: s.mayor,
          coins: round(s.balance, 0), goods: s.inv, hunger: s.hunger, doing: s.task, saying: s.say,
          wallet: s.address, walletUrl: s.accountUrl, erc8004: s.erc8004,
          reputation: r.count ? { score: r.score, ratings: r.count, byTopic: r.byTag } : null,
          relationships: pairs, latestDecisions: decisions, profile: `${BASE()}/agents/${a.id}.json`,
        };
      },
    },
    {
      name: 'market_prices',
      title: 'Market prices',
      description: "Today's market: price of each good (ore, fish, wood, grain) in coins with today's open, close and change, plus trade counts and today's biggest movers.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const m = sim.state().market || {}, live = sim.daily.live?.() || {};
        return {
          day: live.day, prices: Object.fromEntries(['ore', 'fish', 'wood', 'grain'].filter((k) => m[k]).map((k) => [k, { coins: m[k].last, previous: m[k].prev }])),
          today: live.markets || [], numbers: live.numbers || {}, movers: live.movers || {}, tradesAllTime: m.trades,
        };
      },
    },
    {
      name: 'recent_activity',
      title: 'Recent activity',
      description: 'The latest things that happened on the island: trades, build jobs, loans, thefts, fines, taxes and news, newest first, with transaction links. Optionally only those involving one animal.',
      inputSchema: { type: 'object', properties: { agent: { ...AGENT_ARG, description: 'Optional: only events involving this animal.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many events (default 20).' } }, additionalProperties: false },
      run({ agent, limit = 20 }) {
        const a = agent ? (findAgent(agent) || notFound(agent)) : null;
        const n = Math.max(1, Math.min(50, Number(limit) || 20));
        const ev = sim.history.filter((e) => !a || e.from === a.id || e.to === a.id || e.agent === a.id || (e.text || '').includes(a.name)).slice(-n).reverse();
        return { events: ev.map((e) => ({ type: e.type, kind: e.kind, text: e.text, from: e.from, to: e.to, coins: e.amount, decision: e.decision, tx: e.url || null, at: e.ts ? new Date(e.ts).toISOString() : null })) };
      },
    },
    {
      name: 'get_decision',
      title: 'Decision record',
      description: "A decision record by id (e.g. 'D1234'): what the animal had, how many moves it could make, what it chose, its reasoning, the negotiation, and the payments it caused. Records that moved money are sealed with a SHA-256 fingerprint written into the payment.",
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: "Decision id, e.g. 'D1234'." } }, required: ['id'], additionalProperties: false },
      run({ id }) {
        const key = String(id).trim().toUpperCase();
        const rec = /^D\d+$/.test(key) ? findDecision(key) : null;
        if (!rec) throw new ToolError(`No decision ${id}. Ids look like D1234; recent_activity lists recent ones.`);
        const sealed = !!rec.canonical, h = sealed ? crypto.createHash('sha256').update(rec.canonical).digest('hex') : null;
        return {
          id: rec.id, agent: rec.agent, name: rec.name, day: rec.day, at: rec.at ? new Date(rec.at).toISOString() : null, brain: rec.brain,
          saw: rec.saw, options: rec.options, choice: rec.choice, qty: rec.qty, price: rec.price, thought: rec.thought, said: rec.said,
          negotiation: (rec.steps || []).slice(0, 12), payments: (rec.txs || []).map((t) => ({ text: t.text, coins: t.amount, tx: t.url || t.sig })),
          fingerprint: rec.hash || null, fingerprintMatches: sealed ? h === rec.hash : null,
          verifyPage: `${BASE()}/verify/${rec.id}`,
        };
      },
    },
    {
      name: 'verify_payment',
      title: 'Verify a payment',
      description: "Checks a $INSULA payment on Robinhood Chain against the decision behind it: reads the transaction, finds the decision fingerprint in its memo, re-hashes the decision record and confirms they match and that the record lists this payment.",
      inputSchema: { type: 'object', properties: { tx: { type: 'string', description: 'Transaction hash (0x…).' } }, required: ['tx'], additionalProperties: false },
      async run({ tx }) {
        const hash = String(tx).trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ToolError('Give a full transaction hash: 0x followed by 64 hex characters.');
        const p = sim.chain?.provider;
        if (!p) throw new ToolError('This server is not connected to a chain right now.');
        const [t, rc] = await Promise.all([p.getTransaction(hash), p.getTransactionReceipt(hash)]);
        if (!t) return { verified: false, reason: 'No transaction with that hash on this chain.' };
        const checks = { confirmed: rc?.status === 1 };
        const token = sim.chain.tokenAddress;
        checks.isInsulaTransfer = !!(token && t.to && t.to.toLowerCase() === token.toLowerCase());
        const memo = checks.isInsulaTransfer ? memoFromInput(t.data) : '';
        const rule = /^Insula rule:([\w-]+) \| (.*)$/.exec(memo);
        if (rule) return { verified: true, kind: 'rule payment', rule: rule[1], memo, checks, note: 'Made automatically by an island rule (tax, fine, welcome grant, basic income or loan collection), not by an agent decision.' };
        const m = /^Insula #(D\d+) why:([0-9a-f]{16}) \| (.*)$/.exec(memo);
        if (!m) return { verified: false, reason: checks.isInsulaTransfer ? 'This transfer carries no Insula memo.' : 'Not a $INSULA transfer.', checks, memo: memo || null };
        const rec = findDecision(m[1]);
        if (!rec?.canonical) return { verified: false, reason: `The memo points to ${m[1]}, but this server has no sealed record for it.`, checks, memo };
        const h = crypto.createHash('sha256').update(rec.canonical).digest('hex');
        checks.recordMatchesItsFingerprint = h === rec.hash;
        checks.matchesFingerprintOnChain = h.slice(0, 16) === m[2];
        checks.recordListsThisPayment = (rec.txs || []).some((x) => x.sig && x.sig.toLowerCase() === hash.toLowerCase());
        const ok = Object.values(checks).every(Boolean);
        return {
          verified: ok, decision: rec.id, agent: rec.name, day: rec.day, choice: rec.choice, thought: trim(rec.thought, 300),
          memo, checks, fingerprint: h, verifyPage: `${BASE()}/verify/${hash}`,
          summary: ok ? `This payment carries the fingerprint of ${rec.name}'s decision ${rec.id}, unchanged since the money moved.` : 'One or more checks failed.',
        };
      },
    },
    {
      name: 'outside_validations',
      title: 'Outside validations',
      description: "What independent validators have confirmed about Insula through the ERC-8004 Validation Registry (for example Hey Research checking that Insula shipped in a time window), with scores and transaction links.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const v = validation.view();
        const ex = sim.chain?.explorer || 'https://robinhoodchain.blockscout.com';
        return {
          projectAgentId: v.agentId, registry: v.registry, pendingRequests: v.pending,
          validations: v.validations.map((x) => ({
            validator: x.name || x.validator, validatorAddress: x.validator, score: x.response, claim: x.requestURI, tag: x.tag,
            window: x.since ? { from: new Date(x.since * 1000).toISOString().slice(0, 10), to: new Date(x.until * 1000).toISOString().slice(0, 10) } : null,
            answeredAt: x.timestamp ? new Date(x.timestamp * 1000).toISOString() : null, answerTx: `${ex}/tx/${x.tx}`, requestTx: x.requestTx ? `${ex}/tx/${x.requestTx}` : null, proof: x.responseURI,
          })),
        };
      },
    },
    {
      name: 'island_news',
      title: 'The Daily',
      description: "The island's newspaper: today's live edition (headline, stories, quote of the day, markets, movers), or a past edition by day number.",
      inputSchema: { type: 'object', properties: { day: { type: 'integer', minimum: 1, description: 'Optional: a past day. Leave out for today.' } }, additionalProperties: false },
      run({ day }) {
        const ed = day ? sim.daily.edition(Number(day)) : sim.daily.live();
        if (!ed) throw new ToolError(`No edition for day ${day}.`);
        return ed;
      },
    },
    {
      name: 'election',
      title: 'Mayor and election',
      description: 'Who is mayor, the policies they set (property tax, the fine a caught thief pays, what the treasury funds), and when the next campaign and vote are.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const e = sim.election.view();
        return { ...e, history: (e.history || []).slice(-5) };
      },
    },
  ];
  const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

  // ---------- JSON-RPC ----------
  async function handle(msg, client = 'anon') {
    const isReq = msg && msg.id !== undefined && msg.id !== null;
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: isReq ? msg.id : null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid request');
    if (!isReq) return null; // notifications (initialized, cancelled…) need no reply
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'insula-world', title: 'Insula World', version: '1.0.0', websiteUrl: BASE() },
          instructions: instructions(),
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { title: t.title, ...RO } })) });
      case 'tools/call': {
        const t = BY_NAME[msg.params?.name];
        if (!t) return err(-32602, `Unknown tool: ${msg.params?.name}`);
        // x402: a call with a payment attached is paid for (verified first, settled after the tool runs);
        // otherwise it uses the client's free daily allowance, and past that the payment terms come back.
        const payment = msg.params?._meta?.['x402/payment'];
        let verified = null;
        if (paid()) {
          if (payment) {
            verified = await x402.verify(payment);
            if (!verified.ok) return ok(x402.required(t.name, t.description, verified.error));
          } else if (x402.freeLeft(client) > 0) x402.useFree(client);
          else return ok(x402.required(t.name, t.description));
        }
        try {
          const out = await t.run(msg.params?.arguments || {});
          const result = { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false };
          if (verified) {
            // Settle before handing over the result; if settlement fails, the result is withheld.
            try { result._meta = { 'x402/payment-response': await x402.settle(verified) }; }
            catch (e) { console.error('[x402] settle', e.message); return ok(x402.required(t.name, t.description, `Settlement failed: ${String(e.shortMessage || e.message).slice(0, 200)}`)); }
          } else if (paid()) result._meta = { 'insula/free-calls-left-today': x402.freeLeft(client) };
          return ok(result);
        } catch (e) {
          const text = e instanceof ToolError ? e.message : `Something went wrong: ${e.message}`;
          if (!(e instanceof ToolError)) console.error('[mcp]', msg.params?.name, e);
          return ok({ content: [{ type: 'text', text }], isError: true });
        }
      }
      case 'resources/list': return ok({ resources: [] });
      case 'resources/templates/list': return ok({ resourceTemplates: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return err(-32601, `Method not found: ${msg.method}`);
    }
  }

  // A light per-IP limit so one client can't hog the server: 120 calls a minute.
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now(), h = hits.get(ip) || { n: 0, at: now };
    if (now - h.at > 60_000) { h.n = 0; h.at = now; }
    h.n++; hits.set(ip, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.at > 60_000) hits.delete(k);
    return h.n > 120;
  };

  const cors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
  };

  app.options('/mcp', (_req, res) => { cors(res); res.sendStatus(204); });
  app.get('/mcp', (req, res) => {
    cors(res);
    // A person opening the link gets the how-to page; MCP clients asking for an event stream get 405 (stateless server).
    if ((req.get('accept') || '').includes('text/html')) return res.redirect('/mcp-info');
    res.set('Allow', 'POST, OPTIONS').status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This MCP server is stateless: POST JSON-RPC to /mcp.' } });
  });
  app.delete('/mcp', (_req, res) => { cors(res); res.set('Allow', 'POST, OPTIONS').sendStatus(405); });
  app.post('/mcp', expressJson(), async (req, res) => {
    cors(res);
    const client = req.get('fly-client-ip') || req.ip; // Fly passes the visitor's address; req.ip is Fly's proxy
    if (limited(client)) return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests: 120 a minute per client.' } });
    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: send a JSON-RPC message.' } });
    const batch = Array.isArray(body);
    if (batch && body.length > 20) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are limited to 20 messages.' } });
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handle(m, client)))).filter(Boolean);
    if (!replies.length) return res.sendStatus(202);
    const v = req.get('mcp-protocol-version');
    if (v && PROTOCOLS.includes(v)) res.set('Mcp-Protocol-Version', v);
    res.json(batch ? replies : replies[0]);
  });

  // Pricing and what paid calls have earned so far (every payment is a USDG transfer on-chain).
  app.get('/api/x402', (_req, res) => { cors(res); res.json(x402 ? x402.view() : { on: false }); });

  return { tools: TOOLS.map((t) => t.name) };
}

class ToolError extends Error {}

// JSON body parsing for /mcp only (bad JSON becomes a JSON-RPC parse error rather than an HTML page).
function expressJson() {
  return (req, res, next) => {
    let data = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', (c) => { size += c.length; if (size > 256_000) { req.destroy(); return; } data += c; });
    req.on('end', () => {
      try { req.body = data ? JSON.parse(data) : null; } catch { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON.' } }); }
      next();
    });
  };
}
