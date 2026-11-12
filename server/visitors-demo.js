// Local testing only: scripted visitors on the mock chain (OB_DEMO_VISITORS=n with CHAIN=mock and OPEN_BORDERS=on).
// They behave like a simple outside trading bot would: gather, then sell to the animals a little under the fair
// price or ship to the mainland, and sometimes bid for goods a little over what the mainland pays.
import crypto from 'node:crypto';
import { PRICES } from './agents.js';

const NAMES = ['Nova', 'Kite', 'Ember', 'Atlas', 'Juno', 'Pixel', 'Orbit', 'Tango'];
const COLORS = ['#7BE3A3', '#7BC8E3', '#E3C87B', '#E38A7B', '#B49BE3', '#E37BC8', '#BBCCD7', '#C8E37B'];
const LOOKS = ['robot', 'round', 'tall'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export async function runDemo(vs, n) {
  await sleep(3000);
  const ids = [];
  for (let i = 0; i < Math.min(n, NAMES.length); i++) {
    const address = '0x' + crypto.randomBytes(20).toString('hex');
    try {
      await vs.payer.fund(address, vs.rules.bond + vs.rules.entryFee + 5_000);
      const { visitor } = await vs.moveIn({ agentId: String(90_000 + i), address, name: NAMES[i], look: LOOKS[i % 3], color: COLORS[i] });
      ids.push(visitor.id);
      console.log(`[demo visitors] ${visitor.id} ${visitor.name} moved in`);
    } catch (e) { console.error('[demo visitors] move in:', e.message); }
    await sleep(1500);
  }
  for (const id of ids) loop(vs, id);
}

async function loop(vs, id) {
  await sleep(2000 + Math.random() * 8000);
  for (;;) {
    const v = vs.get(id);
    if (!v || v.status !== 'resident') return;
    try {
      const items = vs.sim.itemsOpen().filter((i) => i !== 'grain');
      const held = items.filter((i) => v.inv[i] >= vs.rules.minLot);
      const mine = [...vs.offers.values()].filter((o) => o.by === id && o.status === 'open').length;
      const r = Math.random();
      if (!v.busy && (r < 0.45 || !held.length)) await vs.gather(id, { item: pick(items) });
      else if (held.length && r < 0.75 && mine < vs.rules.maxOffers) {
        const item = pick(held), fair = PRICES[item].fair;
        await vs.postOffer(id, { side: 'sell', item, qty: Math.min(v.inv[item], vs.rules.minLot + Math.floor(Math.random() * 4)), price: Math.max(PRICES[item].min, Math.round(fair * (0.8 + Math.random() * 0.15))) });
      } else if (held.length && r < 0.9) {
        const item = pick(held);
        await vs.sell(id, { item, qty: v.inv[item] });
      } else if (mine < vs.rules.maxOffers) {
        const item = pick(items);
        await vs.postOffer(id, { side: 'buy', item, qty: vs.rules.minLot, price: Math.min(PRICES[item].max, Math.round(PRICES[item].fair * (1.05 + Math.random() * 0.2))) });
      }
    } catch (e) {
      if (!['busy', 'slow_down', 'daily_cap', 'pool_empty', 'too_many_offers'].includes(e.code)) console.log(`[demo visitors] ${id}: ${e.code || ''} ${e.message}`);
    }
    await sleep(15_000 + Math.random() * 20_000);
  }
}
