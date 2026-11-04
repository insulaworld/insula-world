// The first 30 days of Insula, laid out ahead of time.
// Each milestone unlocks on its day, and the big ones also wait for the economy to earn them
// (enough trading, enough buildings, a public project finished). Nobody flips these switches by hand.
//
// `day` counts genesis days: real days by default (INSULA_DAY_MS sets a shorter day for previews and tests).

export const ERAS = [
  {
    id: 'genesis', day: 0, title: 'Genesis',
    summary: 'Four founders, one harbor town, real money. Houses and workshops can be built.',
    unlock: { zones: ['harbor'], houseLevel: 1, workshopLevel: 1 },
  },
  {
    id: 'neighbors', day: 1, title: 'First neighbor',
    summary: 'Dot the Duck paddles in from the mainland.',
    unlock: { arrivals: ['dot'] },
  },
  {
    id: 'upgrades', day: 2, title: 'Second stories',
    summary: 'Houses can be upgraded to level 2.',
    needs: { buildings: 3 },
    unlock: { houseLevel: 2 },
  },
  {
    id: 'townhall', day: 3, title: 'A town hall',
    summary: 'The first public project: anyone can chip in to fund a Town Hall.',
    needs: { gdp: 4000 },
    unlock: { projects: ['townhall'] },
  },
  {
    id: 'mayor', day: 3, title: 'Mayor Otto',
    summary: 'With the Town Hall standing, Otto the Owl arrives as mayor. He collects property tax and funds public works.',
    needs: { project: 'townhall' },
    unlock: { arrivals: ['otto'], tax: true },
  },
  {
    id: 'farm', day: 4, title: 'Farm Valley opens',
    summary: 'The east valley opens. Rosa the Rabbit starts the first farm, and grain becomes a second food.',
    needs: { gdp: 7000 },
    unlock: { zones: ['farm'], items: ['grain'], arrivals: ['rosa'] },
  },
  {
    id: 'granary', day: 6, title: 'The Granary',
    summary: 'Public project: a Granary in Farm Valley makes every meal more filling.',
    unlock: { projects: ['granary'] },
  },
  {
    id: 'night', day: 7, title: 'A visitor in the night',
    summary: 'Rico the Raccoon arrives. Things start going missing after dark.',
    unlock: { arrivals: ['rico'] },
  },
  {
    id: 'expansion', day: 9, title: 'Expansion',
    summary: 'Houses can reach level 3 and workshops level 2.',
    needs: { buildings: 8 },
    unlock: { houseLevel: 3, workshopLevel: 2 },
  },
  {
    id: 'lighthouse', day: 10, title: 'The Lighthouse',
    summary: 'Public project: a Lighthouse by the dock raises export prices and helps catch thieves.',
    unlock: { projects: ['lighthouse'] },
  },
  {
    id: 'west', day: 12, title: 'West Hill quarry',
    summary: 'West Hill opens with a rich new quarry. Moe the Mole moves in to dig it.',
    needs: { gdp: 20000 },
    unlock: { zones: ['west'], arrivals: ['moe'] },
  },
  {
    id: 'gus', day: 14, title: 'A second builder',
    summary: 'Gus the Goat arrives to compete with Bea for contracts.',
    needs: { buildings: 6 },
    unlock: { arrivals: ['gus'] },
  },
  {
    id: 'markethall', day: 16, title: 'The Market Hall',
    summary: 'Public project: a covered Market Hall so deals get done faster.',
    unlock: { projects: ['markethall'] },
  },
  {
    id: 'ivy', day: 18, title: 'A rival bank',
    summary: 'Ivy the Cat opens a second bank and starts undercutting Penny.',
    needs: { gdp: 35000 },
    unlock: { arrivals: ['ivy'] },
  },
  {
    id: 'north', day: 20, title: 'North Beach',
    summary: 'North Beach opens. Shelly the Turtle settles on the sand.',
    unlock: { zones: ['north'], arrivals: ['shelly'] },
  },
  {
    id: 'harbor', day: 22, title: 'North Harbor',
    summary: 'Public project: a second harbor on North Beach raises export prices again.',
    unlock: { projects: ['harbor'] },
  },
  {
    id: 'hazel', day: 25, title: 'Merchant rivalry',
    summary: 'Hazel the Hedgehog arrives to take on Felix.',
    needs: { gdp: 55000 },
    unlock: { arrivals: ['hazel'] },
  },
  {
    id: 'monument', day: 27, title: 'The Founders Monument',
    summary: 'The final project of the first month: a monument to the four founders in the plaza.',
    unlock: { projects: ['monument'] },
  },
  {
    id: 'festival', day: 30, title: 'The city of Insula',
    summary: 'One month since genesis. Fireworks over a town the agents built themselves.',
    unlock: { festival: true },
  },
];

export const DEFAULT_DAY_MS = 24 * 60 * 60 * 1000;
