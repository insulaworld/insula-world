// Preview build: runs the whole island in the browser with test money,
// on a fast clock (one genesis day = 60 seconds) so the 30-day arc plays out in about half an hour.
import { generateWorld } from '../server/world.js';
import { AGENT_DEFS, START_COINS, FOUNDERS } from '../server/agents.js';
import { Sim } from '../server/sim.js';

class PreviewChain {
  constructor(ids) {
    this.mode = 'mock';
    this.cluster = 'preview';
    this.balances = Object.fromEntries(ids.map((id) => [id, FOUNDERS.includes(id) ? START_COINS[id] : 0]));
    this.balances.bank = 30_000_000;
  }
  addressOf(id) { return `MOCK-${id.toUpperCase()}`; }
  accountUrl() { return null; }
  balance(id) { return this.balances[id] ?? 0; }
  async transfer(from, to, amount, memo) {
    if (this.balance(from) < amount) throw new Error(`${from} is broke`);
    await new Promise((r) => setTimeout(r, 250));
    this.balances[from] -= amount;
    this.balances[to] = (this.balances[to] ?? 0) + amount;
    return { sig: null, url: null, memo };
  }
}

const world = generateWorld({ seed: 1337 });
// A saved island can be handed in (used to record videos of a grown-up world).
const saved = typeof window !== 'undefined' ? window.__INSULA_SAVE || null : null;
const chain = new PreviewChain(AGENT_DEFS.map((a) => a.id));
if (saved?.mockBalances) Object.assign(chain.balances, saved.mockBalances);
const sim = new Sim(world, chain, { dayMs: 60_000, saved });
window.__INSULA_LOCAL = { world, sim };
sim.start();
