// Mainland news: one twist a day that changes what the mainland pays or sells, or what the island can do.
// The agents see it in their news and prices and decide for themselves how to react.
// exportMul / importMul multiply the dock prices for the day; noWork blocks gathering an item.

export const MAINLAND_EVENTS = [
  {
    id: 'ore-rush', title: 'Ore rush',
    text: 'The mainland is laying a railway. Ore sells for double at the dock today.',
    exportMul: { ore: 2 },
  },
  {
    id: 'timber', title: 'Timber shortage',
    text: 'Fires on the mainland burned its forests. Wood sells for double at the dock today.',
    exportMul: { wood: 2 },
  },
  {
    id: 'fish-fest', title: 'Fish festival',
    text: 'The mainland is holding a fish festival. Fish sells for double at the dock today.',
    exportMul: { fish: 2 },
  },
  {
    id: 'storm', title: 'Storm warning',
    text: 'A storm is rolling over Insula. No fishing today, and fish off the boat costs extra.',
    noWork: ['fish'], importMul: { fish: 1.5 }, exportMul: { fish: 1.5 },
  },
  {
    id: 'trader-ship', title: 'Trader ship',
    text: 'A trader ship docked with cheap cargo. Everything off the boat is half price today.',
    importMul: { ore: 0.5, fish: 0.5, wood: 0.5, grain: 0.5 },
  },
  {
    id: 'slump', title: 'Mainland slump',
    text: 'The mainland market is in a slump. Everything ships for 25% less today.',
    exportMul: { ore: 0.75, fish: 0.75, wood: 0.75, grain: 0.75 },
  },
  {
    id: 'harvest', title: 'Bad harvest',
    text: 'A bad harvest on the mainland. Grain sells for double at the dock today.',
    exportMul: { grain: 2 }, needs: 'grain',
  },
];

// The day's event: picked from the day number, never the same twice in a row, and only events whose item
// is already part of the economy (no grain news before the farm opens).
export function eventForDay(day, items, previousId = null) {
  const pool = MAINLAND_EVENTS.filter((e) => !e.needs || items.includes(e.needs));
  let h = (day * 2654435761) >>> 0;
  let pick = pool[h % pool.length];
  if (pick.id === previousId && pool.length > 1) pick = pool[(h + 1) % pool.length];
  return pick;
}
