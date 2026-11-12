// Island generation. Deterministic from a seed so the server and every viewer agree.
// The world is the original harbor island plus three zones that unlock over the first month:
// Farm Valley (east), West Hill (a second, richer mine) and North Beach.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(size, cell, rand) {
  const n = Math.ceil(size / cell) + 2;
  const g = Array.from({ length: n }, () => Array.from({ length: n }, rand));
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const gx = Math.max(0, x) / cell, gz = Math.max(0, z) / cell;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const tx = smooth(gx - x0), tz = smooth(gz - z0);
    const a = g[x0][z0], b = g[x0 + 1][z0], c = g[x0][z0 + 1], d = g[x0 + 1][z0 + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
}

export const WATER_LEVEL = 1;

// Zones that open over time. `r` is the zone's radius for working out which zone a tile is in.
export const ZONE_DEFS = {
  harbor: { label: 'Harbor Town' },
  farm: { label: 'Farm Valley', cx: 69, cz: 47, r: 12, base: 2.6, amp: 1.0 },
  west: { label: 'West Hill', cx: 18, cz: 40, r: 10.5, base: 3.2, amp: 1.6 },
  north: { label: 'North Beach', cx: 43, cz: 19, r: 11, base: 1.8, amp: 0.7 },
};

export function generateWorld({ seed = 1337 } = {}) {
  const size = 88;
  const O = 20; // the original 48-tile island sits in the middle of the bigger map
  const rand = mulberry32(seed);
  const noiseA = valueNoise(size, 8, rand);
  const noiseB = valueNoise(size, 4, rand);
  const c = O + 23.5;
  const heights = [];
  for (let x = 0; x < size; x++) {
    heights.push([]);
    for (let z = 0; z < size; z++) {
      const n = noiseA(x, z) * 0.7 + noiseB(x, z) * 0.3;
      // Original harbor island
      const d = Math.hypot(x - c, z - c) / 24;
      let h = Math.round((1 - Math.pow(Math.min(d, 1), 2.2)) * (2 + n * 5.5) - 0.4);
      // Outer zones, blended in where they meet the main island
      for (const k of ['farm', 'west', 'north']) {
        const zd = ZONE_DEFS[k];
        const dd = Math.hypot(x - zd.cx, z - zd.cz) / zd.r;
        if (dd >= 1.15) continue;
        const f = 1 - Math.pow(Math.min(dd, 1), 2.4);
        h = Math.max(h, Math.round(f * (zd.base + n * zd.amp * 2) - 0.2));
      }
      heights[x].push(Math.max(0, h));
    }
  }

  // Market plaza
  const market = { x: Math.round(c), z: Math.round(c) };
  const plazaH = Math.max(2, heights[market.x][market.z]);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) heights[market.x + dx][market.z + dz] = plazaH;

  // Stone hills: the original mine and the bigger West Hill quarry
  const hill = (cx, cz, r, top) => {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
      for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
        const rr = Math.hypot(dx, dz);
        if (rr > r) continue;
        heights[cx + dx][cz + dz] = Math.max(heights[cx + dx][cz + dz], Math.round(top - rr * (top - plazaH) / r));
      }
  };
  const mine = { x: Math.round(c + 9.6), z: Math.round(c - 9.6) };
  hill(mine.x, mine.z, 4.5, plazaH + 4);
  const mine2 = { x: ZONE_DEFS.west.cx, z: ZONE_DEFS.west.cz - 1 };
  hill(mine2.x, mine2.z, 5.5, plazaH + 6);

  // Dock on the south-west shore of the main island
  let dock = null;
  for (let r = 0; r < 24 && !dock; r++) {
    const x = Math.round(c - 8.6 - r * 0.7), z = Math.round(c + 8.6 + r * 0.7);
    if (heights[x][z] <= WATER_LEVEL) dock = { x: Math.round(x + 0.7), z: Math.round(z - 0.7), waterX: x, waterZ: z };
  }
  if (!dock) dock = { x: O + 6, z: O + 41, waterX: O + 5, waterZ: O + 42 };
  heights[dock.x][dock.z] = Math.max(WATER_LEVEL + 1, heights[dock.x][dock.z]);

  // Flat ground for the farm fields and the landmark sites
  const flatten = (cx, cz, w, d, h) => {
    for (let dx = -w; dx <= w; dx++) for (let dz = -d; dz <= d; dz++) heights[cx + dx][cz + dz] = h;
  };
  const fields = { x: ZONE_DEFS.farm.cx + 1, z: ZONE_DEFS.farm.cz, w: 4, d: 3 };
  flatten(fields.x, fields.z, fields.w + 1, fields.d + 1, 3);
  const beach = { x: ZONE_DEFS.north.cx, z: ZONE_DEFS.north.cz };

  const sites = {
    townhall: { x: market.x, z: market.z - 7, w: 2, d: 2 },
    markethall: { x: market.x + 7, z: market.z + 1, w: 2, d: 2 },
    lighthouse: { x: dock.x - 1, z: dock.z - 3, w: 1, d: 1 },
    granary: { x: fields.x - 7, z: fields.z - 2, w: 1, d: 1 },
    harbor: { x: beach.x, z: beach.z - 3, w: 2, d: 1 },
    monument: { x: market.x - 6, z: market.z + 5, w: 1, d: 1 },
  };
  for (const s of Object.values(sites)) {
    const h = Math.max(WATER_LEVEL + 1, heights[s.x][s.z]);
    flatten(s.x, s.z, s.w + 1, s.d + 1, h);
    s.y = h;
  }

  // Ore spots on both hills
  const ores = [], ores2 = [];
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2, r = 1.5 + rand() * 2.5;
    ores.push({ x: Math.round(mine.x + Math.cos(a) * r), z: Math.round(mine.z + Math.sin(a) * r) });
  }
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2, r = 1.5 + rand() * 3.5;
    ores2.push({ x: Math.round(mine2.x + Math.cos(a) * r), z: Math.round(mine2.z + Math.sin(a) * r) });
  }

  const busy = (x, z, pad = 0) =>
    Math.hypot(x - market.x, z - market.z) < 8 + pad ||
    Math.hypot(x - mine.x, z - mine.z) < 6 + pad ||
    Math.hypot(x - mine2.x, z - mine2.z) < 7 + pad ||
    Math.hypot(x - dock.x, z - dock.z) < 3 + pad ||
    (Math.abs(x - fields.x) <= fields.w + 2 + pad && Math.abs(z - fields.z) <= fields.d + 2 + pad) ||
    Object.values(sites).some((s) => Math.abs(x - s.x) <= s.w + 2 + pad && Math.abs(z - s.z) <= s.d + 2 + pad);

  // Trees
  const trees = [];
  for (let i = 0; i < 1600 && trees.length < 36; i++) {
    const x = 2 + Math.floor(rand() * (size - 4)), z = 2 + Math.floor(rand() * (size - 4));
    if (heights[x][z] < WATER_LEVEL + 1 || busy(x, z, 2)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3.3)) continue;
    trees.push({ x, z, h: 3 + Math.floor(rand() * 2) });
  }

  const zoneOf = (x, z) => {
    for (const k of ['farm', 'west', 'north']) {
      const zd = ZONE_DEFS[k];
      if (Math.hypot(x - zd.cx, z - zd.cz) <= zd.r * 0.95) return k;
    }
    return 'harbor';
  };

  // Building plots: flat 3x3 spots, sorted so the closest to each zone's heart fill first.
  const plots = [];
  for (let x = 4; x < size - 4; x++)
    for (let z = 4; z < size - 4; z++) {
      const hs = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) hs.push(heights[x + dx][z + dz]);
      const lo = Math.min(...hs), hi = Math.max(...hs);
      if (lo <= WATER_LEVEL || hi - lo > 1 || busy(x, z, -1)) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.6)) continue;
      if (plots.some((p) => Math.hypot(p.x - x, p.z - z) < 4.4)) continue;
      const zone = zoneOf(x, z);
      const heart = zone === 'harbor' ? market : { x: ZONE_DEFS[zone].cx, z: ZONE_DEFS[zone].cz };
      plots.push({ x, z, y: hi, zone, d: Math.hypot(x - heart.x, z - heart.z) });
    }
  plots.sort((a, b) => a.d - b.d);

  // Everything above is the original island, generated exactly as before so saved buildings, plots and
  // trees stay where they are. The coast expansion below only turns open sea into new land and beach.
  const pier = pierLayout(heights, WATER_LEVEL, dock);
  const grown = expandCoast({ seed, heights, size, pier, sites, rand: mulberry32(seed ^ 0x51ab1e), market, trees, plots, zoneOf });

  return {
    size: grown.size,
    seed,
    waterLevel: WATER_LEVEL,
    heights: grown.heights,
    places: {
      market: { ...market, label: 'Market' },
      mine: { ...mine, label: 'Mine' },
      dock: { x: dock.x, z: dock.z, waterX: dock.waterX, waterZ: dock.waterZ, label: 'Dock', pier },
      farm: { x: fields.x, z: fields.z, label: 'Farm Valley', zone: 'farm' },
      mine2: { ...mine2, label: 'West Hill Quarry', zone: 'west' },
      beach: { ...beach, label: 'North Beach', zone: 'north' },
      meadow: { ...grown.meadow, label: 'South Meadow' },
    },
    zones: Object.fromEntries(Object.entries(ZONE_DEFS).map(([k, v]) => [k, { id: k, label: v.label, cx: v.cx ?? market.x, cz: v.cz ?? market.z, r: v.r ?? 24 }])),
    fields,
    sites,
    ores,
    ores2,
    trees,
    plots,
  };
}

// Size of the map after the coast expansion. The original island used 88x88; the map grows to the east and
// south only, so every existing coordinate keeps its meaning.
export const MAP_SIZE = 100;
export const MEADOW = { cx: 52, cz: 72, r: 10.5 };

// Grows the island by about a quarter: a wider coastline all round (where there's open sea, away from the
// pier and the North Beach harbor) plus a new South Meadow, each edged with a fresh sand beach. Only tiles
// that were sea or beach change. New trees and building plots for the new land are appended to the lists.
function expandCoast({ seed, heights: old, size: oldSize, pier, sites, rand, market, trees, plots, zoneOf }) {
  const size = MAP_SIZE;
  const noise = valueNoise(size, 6, rand);
  const heights = Array.from({ length: size }, (_, x) => Array.from({ length: size }, (_, z) => old[x]?.[z] ?? 0));
  const wasLand = (x, z) => (old[x]?.[z] ?? 0) > WATER_LEVEL;
  // Distance from each tile to the nearest original land tile (brute force over the coast only).
  const coast = [];
  for (let x = 0; x < oldSize; x++) for (let z = 0; z < oldSize; z++) {
    if (!wasLand(x, z)) continue;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !wasLand(x + a, z + b))) coast.push([x, z]);
  }
  const pierTiles = pier.tiles;
  const end = pierTiles[pierTiles.length - 1];
  const keepSea = (x, z) =>
    pierTiles.some(([a, b]) => Math.hypot(a - x, b - z) < 5) ||
    Math.hypot(x - end[0], z - end[1]) < 9 ||
    (Math.abs(x - sites.harbor.x) < 7 && z < sites.harbor.z + 1);
  const edge = 3; // open water kept around the map's border
  const M = MEADOW;
  for (let x = edge; x < size - edge; x++)
    for (let z = edge; z < size - edge; z++) {
      if (wasLand(x, z) || keepSea(x, z)) continue;
      const n = noise(x, z);
      let d = 99;
      for (const [cx, cz] of coast) { const dd = Math.hypot(x - cx, z - cz); if (dd < d) d = dd; }
      const R = 2.0 + n * 2.2; // how far the new shore reaches here
      const md = Math.hypot((x - M.cx) / M.r, (z - M.cz) / (M.r * (z < M.cz ? 1.45 : 1))); // South Meadow, a low lobe joined to the main island
      let h = 0;
      if (d <= R - 1.2) h = 2 + (n > 0.62 && d < R - 2.6 ? 1 : 0);
      else if (d <= R + 0.6) h = 1;
      if (md < 1) h = Math.max(h, Math.round((1 - Math.pow(md, 2.2)) * (2.2 + n * 1.6)) + 1);
      else if (md < 1.12) h = Math.max(h, 1);
      heights[x][z] = Math.max(heights[x][z], h);
    }
  // Smooth single-tile spikes and holes on the new land so it walks well.
  for (let x = edge; x < size - edge; x++)
    for (let z = edge; z < size - edge; z++) {
      if (wasLand(x, z) || heights[x][z] <= WATER_LEVEL) continue;
      const ns = [heights[x + 1][z], heights[x - 1][z], heights[x][z + 1], heights[x][z - 1]];
      const hi = Math.max(...ns);
      if (heights[x][z] > hi) heights[x][z] = hi;
    }

  // New trees and plots on the new land only, so the original ones never move.
  const isNew = (x, z) => !wasLand(x, z) && heights[x][z] > WATER_LEVEL;
  for (let i = 0; i < 900 && trees.length < 44; i++) {
    const x = edge + Math.floor(rand() * (size - 2 * edge)), z = edge + Math.floor(rand() * (size - 2 * edge));
    if (!isNew(x, z) || Math.hypot(x - market.x, z - market.z) < 10) continue;
    if (Math.hypot(x - MEADOW.cx, z - MEADOW.cz) < MEADOW.r * 0.8) continue; // the meadow stays open ground for visitors
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3.3)) continue;
    trees.push({ x, z, h: 3 + Math.floor(rand() * 2) });
  }
  const meadow = { x: M.cx, z: M.cz };
  const added = [];
  for (let x = edge + 1; x < size - edge - 1; x++)
    for (let z = edge + 1; z < size - edge - 1; z++) {
      const hs = [];
      let fresh = false;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { hs.push(heights[x + dx][z + dz]); fresh ||= isNew(x + dx, z + dz); }
      const lo = Math.min(...hs), hi = Math.max(...hs);
      if (!fresh || lo <= WATER_LEVEL || hi - lo > 1) continue;
      if (Math.hypot(x - meadow.x, z - meadow.z) < 3) continue; // keep the meadow's heart open for visitors
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.6)) continue;
      if ([...plots, ...added].some((p) => Math.hypot(p.x - x, p.z - z) < 4.4)) continue;
      const zone = zoneOf(x, z);
      added.push({ x, z, y: hi, zone, d: 100 + Math.hypot(x - market.x, z - market.z) });
    }
  added.sort((a, b) => a.d - b.d);
  plots.push(...added);
  return { size, heights, meadow };
}

export function zoneAt(world, x, z) {
  for (const k of ['farm', 'west', 'north']) {
    const zd = world.zones[k];
    if (Math.hypot(x - zd.cx, z - zd.cz) <= zd.r * 0.95) return k;
  }
  return 'harbor';
}

// The pier at the dock: a 3-wide deck running straight out (along x or z) in whichever direction from the
// dock reaches open water soonest, with a 5-wide landing at the far end. Shared by the server (agents stand
// on the deck) and the site (which draws it).
export function pierLayout(heights, waterLevel, d) {
  const H = (x, z) => heights[x]?.[z] ?? 99;
  const wet = (x, z) => H(x, z) <= waterLevel;
  let best = null;
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let first = 0;
    for (let i = 1; i <= 5 && !first; i++) if (wet(d.x + ax * i, d.z + az * i)) first = i;
    if (!first) continue;
    let run = 0;
    for (let i = first; i < first + 9; i++) if (wet(d.x + ax * i, d.z + az * i)) run++;
    if (!best || run > best.run || (run === best.run && first < best.first)) best = { ax, az, first, run };
  }
  if (!best) best = { ax: Math.sign(d.waterX - d.x) || -1, az: 0, first: 1, run: 0 };
  const { ax, az, first } = best;
  const len = first + 6;
  const top = H(d.x, d.z) + 1.08;
  const tiles = [];
  for (let i = 1; i <= len; i++) {
    const wide = i >= len - 1 ? 2 : 1;
    for (let j = -wide; j <= wide; j++) tiles.push([d.x + ax * i - az * j, d.z + az * i + ax * j]);
  }
  return { ax, az, first, len, top, tiles };
}

const pierIndex = new WeakMap();
export function groundY(world, x, z) {
  const xi = Math.min(world.size - 1, Math.max(0, Math.round(x)));
  const zi = Math.min(world.size - 1, Math.max(0, Math.round(z)));
  const pier = world.places?.dock?.pier;
  if (pier) {
    if (!pierIndex.has(world)) pierIndex.set(world, new Set(pier.tiles.map(([a, b]) => `${a},${b}`)));
    if (pierIndex.get(world).has(`${xi},${zi}`)) return pier.top;
  }
  return Math.max(world.heights[xi][zi], world.waterLevel) + 1;
}
