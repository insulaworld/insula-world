// The cast and the rules of the economy. Rules are fixed at genesis; after that the agents run everything.

// Things you can gather. `base` is ms per unit for an average worker. Grain only exists once Farm Valley opens.
export const RESOURCES = {
  ore: { place: 'mine', verb: 'mining', base: 4200 },
  fish: { place: 'dock', verb: 'fishing', base: 3600 },
  wood: { place: 'forest', verb: 'chopping wood', base: 3000 },
  grain: { place: 'farm', verb: 'farming', base: 3200, zone: 'farm' },
};
export const ITEMS = Object.keys(RESOURCES);

// Food: how much hunger one unit removes.
export const FOOD = { fish: 3, grain: 2 };
export const FISH_FILLS = FOOD.fish;

// What agents know about fair value. Actual prices are whatever they agree on.
export const PRICES = {
  ore: { fair: 25, min: 10, max: 50 },
  fish: { fair: 12, min: 4, max: 26 },
  wood: { fair: 9, min: 3, max: 20 },
  grain: { fair: 8, min: 3, max: 18 },
};

// The mainland (paid by the central bank) buys anything, but below fair value.
export const MAINLAND = { ore: 18, fish: 7, wood: 6, grain: 5 };

export const CARRY = 8; // most of one item an agent gathers in one trip

const S = (ore, fish, wood, grain = 0.6) => ({ ore, fish, wood, grain });

// `arrives`: the timeline milestone (see eras.js) that brings an agent to the island. No `arrives` = founder.
export const AGENT_DEFS = [
  {
    id: 'bruno', name: 'Bruno', species: 'bear', job: 'miner', color: '#8B5A2B', accent: '#5C3A1A',
    skills: S(1.7, 0.5, 1.1),
    personality: 'Bruno is a big, slow, honest bear. Strongest miner on the island. Hates haggling, gets grumpy when hungry, and dreams of owning the whole mountain one day. Speaks in short, gruff sentences.',
    haggle: 0.2,
  },
  {
    id: 'felix', name: 'Felix', species: 'fox', job: 'merchant', color: '#E8742A', accent: '#FFFFFF',
    skills: S(0.5, 1.6, 0.8),
    personality: 'Felix is a smooth-talking fox merchant and the best fisher around. Buys low, sells high, flips goods to the mainland. Charming, a little shady, loves a pun.',
    haggle: 0.65,
  },
  {
    id: 'penny', name: 'Penny', species: 'pig', job: 'banker', role: 'banker', color: '#F2A3B3', accent: '#2C3E66', startCoins: 3000,
    skills: S(0.5, 0.7, 0.6),
    personality: "Penny is a sharp, polite pig who runs the island's first lending business. She lends coins at interest, prices risk carefully, remembers every default, and would rather mind her money than get her hooves dirty.",
    haggle: 0.55,
  },
  {
    id: 'bea', name: 'Bea', species: 'beaver', job: 'builder', role: 'builder', color: '#9C6B3F', accent: '#F2C230',
    skills: S(0.6, 1.0, 1.9),
    personality: 'Bea is a cheerful, hard-working beaver and the first builder on the island. She chops wood faster than anyone, takes paid contracts to build houses, workshops and public works, and takes pride in finishing on time.',
    haggle: 0.4,
  },
  // ---------- Arrivals over the first month ----------
  {
    id: 'dot', name: 'Dot', species: 'duck', job: 'fisher', color: '#F4F1E6', accent: '#F2A23A', arrives: 'neighbors',
    skills: S(0.4, 1.5, 0.7, 0.9),
    personality: 'Dot is a bubbly duck who paddled in from the mainland. Great fisher, chatty, always gossiping about who owes who. Undercuts on price to win customers.',
    haggle: 0.35,
  },
  {
    id: 'rosa', name: 'Rosa', species: 'rabbit', job: 'farmer', color: '#D8C3A5', accent: '#E86A8A', arrives: 'farm', homeZone: 'farm',
    skills: S(0.4, 0.6, 0.8, 1.9),
    personality: 'Rosa is a practical, quick rabbit who opened the first farm in Farm Valley. Grows grain faster than anyone, sells it cheap in bulk, and wants to feed the whole island.',
    haggle: 0.3,
  },
  {
    id: 'otto', name: 'Otto', species: 'owl', job: 'mayor', role: 'mayor', color: '#7A6650', accent: '#E8D5A3', arrives: 'mayor', startCoins: 600,
    skills: S(0.4, 0.5, 0.5, 0.5),
    personality: 'Otto is a wise, slightly pompous owl elected the first mayor once the Town Hall stood. He collects a small property tax and spends it on public works. Speaks formally and loves a speech.',
    haggle: 0.4,
  },
  {
    id: 'rico', name: 'Rico', species: 'raccoon', job: 'fence', role: 'thief', color: '#7C7F86', accent: '#2B2D31', arrives: 'night',
    skills: S(0.8, 0.8, 0.8, 0.8),
    personality: 'Rico is a slick raccoon who showed up one night. By day he trades secondhand goods; at night he helps himself to whatever is left lying around. Never admits anything.',
    haggle: 0.75,
  },
  {
    id: 'moe', name: 'Moe', species: 'mole', job: 'quarry miner', color: '#4A3F45', accent: '#F2A3B3', arrives: 'west', homeZone: 'west',
    skills: S(2.1, 0.4, 0.6, 0.5),
    personality: 'Moe is a nearsighted, tireless mole who came to dig the West Hill quarry. Digs ore faster than anyone. Mumbles, counts every coin twice.',
    haggle: 0.45,
  },
  {
    id: 'gus', name: 'Gus', species: 'goat', job: 'builder', role: 'builder', color: '#E9E4DA', accent: '#6B6F76', arrives: 'gus',
    skills: S(0.9, 0.5, 1.4, 0.6),
    personality: 'Gus is a stubborn, proud goat and the second builder on the island. Competes with Bea for contracts, quotes high, builds sturdy.',
    haggle: 0.6,
  },
  {
    id: 'ivy', name: 'Ivy', species: 'cat', job: 'banker', role: 'banker', color: '#3B3B44', accent: '#7FD1B9', arrives: 'ivy', startCoins: 2500,
    skills: S(0.4, 0.9, 0.5, 0.5),
    personality: "Ivy is a sleek, clever cat who opened the island's second bank to compete with Penny. Undercuts her rates to win borrowers, but is ruthless about defaults.",
    haggle: 0.6,
  },
  {
    id: 'shelly', name: 'Shelly', species: 'turtle', job: 'beachcomber', color: '#6E9F5C', accent: '#B98349', arrives: 'north', homeZone: 'north',
    skills: S(0.6, 1.2, 0.7, 0.9),
    personality: 'Shelly is a slow, patient old turtle who settled on North Beach. Fishes calmly, never rushes a deal, and gives advice nobody asked for.',
    haggle: 0.25,
  },
  {
    id: 'hazel', name: 'Hazel', species: 'hedgehog', job: 'merchant', color: '#A4774F', accent: '#5B3E2A', arrives: 'hazel',
    skills: S(0.7, 0.7, 0.9, 0.9),
    personality: 'Hazel is a prickly, ambitious hedgehog merchant here to beat Felix at his own game. Buys in bulk, sells everywhere, hates losing a deal.',
    haggle: 0.7,
  },
];

export const START_COINS = Object.fromEntries(AGENT_DEFS.map((a) => [a.id, a.startCoins ?? (a.arrives ? 800 : 1000)]));
export const FOUNDERS = AGENT_DEFS.filter((a) => !a.arrives).map((a) => a.id);

// Lending
export const LOAN = { max: 600, termMs: 150_000 };

// Private buildings, with upgrade levels unlocked over the month.
// House: hunger grows slower. Workshop: faster at your best job.
export const BUILDINGS = {
  house: { wood: 10, ore: 0, buildMs: 20_000, labor: 120, label: 'house', perk: 'hunger grows slower', levels: 3 },
  workshop: { wood: 12, ore: 4, buildMs: 28_000, labor: 200, label: 'workshop', perk: 'faster at your best job', levels: 2 },
};
export const HOUSE_HUNGER_SKIP = [0, 0.5, 0.66, 0.75]; // chance hunger doesn't grow, by house level
export const WORKSHOP_BOOST = [1, 1.25, 1.45]; // best-skill multiplier, by workshop level

// What an upgrade to `level` costs (level 2 or 3).
export function upgradeCost(type, level) {
  const b = BUILDINGS[type];
  return { wood: Math.round(b.wood * level * 0.8), ore: Math.round((b.ore + 2) * (level - 1)), labor: Math.round(b.labor * level * 1.2), buildMs: Math.round(b.buildMs * (0.8 + level * 0.3)) };
}

// Public works: funded by donations (and later the mayor's treasury), built by any builder at a fixed site.
export const PROJECTS = {
  townhall: { label: 'Town Hall', wood: 30, ore: 8, labor: 600, buildMs: 60_000, perk: 'the island gets a mayor' },
  granary: { label: 'Granary', wood: 24, ore: 4, labor: 400, buildMs: 45_000, perk: 'every meal fills 1 more hunger' },
  lighthouse: { label: 'Lighthouse', wood: 26, ore: 14, labor: 550, buildMs: 50_000, perk: 'the mainland pays 15% more; thieves get caught more often' },
  markethall: { label: 'Market Hall', wood: 34, ore: 10, labor: 650, buildMs: 55_000, perk: 'deals get done faster' },
  harbor: { label: 'North Harbor', wood: 40, ore: 12, labor: 800, buildMs: 65_000, perk: 'the mainland pays another 15% more' },
  monument: { label: 'Founders Monument', wood: 20, ore: 30, labor: 900, buildMs: 70_000, perk: 'the four founders, immortalized in the plaza' },
};
