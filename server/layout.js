// The spacious town plan (layout v2). The first plan packed every building around the market with gaps of a
// tile or less, so houses touched each other, the Town Hall touched the plaza and a house sat on the dock.
// This plan places the landmark sites and the building plots with room to walk between them:
//   - at least GAP clear tiles between any two buildings, the plaza, the dock and the pier
//   - an open lane from the market to the dock, and around the mines, the farm fields and the meadow
// It only changes where things stand (the sites, the plots, a few trees in the way); the land stays the same,
// except the small flat pads under the sites. Saved buildings are moved onto it once (relocate(), below).

export const LAYOUT_VERSION = 2;
const GAP = 4;          // clear tiles around landmarks, the plaza and the dock
const GAP_HOMES = 3;    // clear tiles between two private buildings
const PLAZA_R = 3.5;    // the market plaza's half-width

// Footprint half-sizes, as drawn on the site (private buildings and the small landmarks are 3x3; the Town Hall
// and Market Hall are 5x5, the Town Hall with a porch one tile deeper on its +z side).
export function footprint(kind, type) {
  if (kind === 'project' && (type === 'townhall' || type === 'markethall')) return { w: 2.5, d0: 2.5, d1: type === 'townhall' ? 3.5 : 2.5 };
  return { w: 1.5, d0: 1.5, d1: 1.5 };
}

const boxOf = (x, z, f) => ({ x0: x - f.w, x1: x + f.w, z0: z - f.d0, z1: z + f.d1 });
const boxGap = (a, b) => {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0), dz = Math.max(b.z0 - a.z1, a.z0 - b.z1, 0);
  return dx && dz ? Math.hypot(dx, dz) : Math.max(dx, dz);
};
const segDist = (px, pz, ax, az, bx, bz) => {
  const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
};

// The island grows a fresh ring of coast (east and south mostly; the west and north coasts are near the map
// edge) so the spread-out town has room. Only open sea turns into land; water stays open around the pier and
// the North Beach harbor, and the outer tile of each new shore is sand.
const GROW_TO = 112;
function hash2(x, z, s) { let h = (x * 374761393 + z * 668265263 + s * 2147483647) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function smoothNoise(x, z, cell, s) {
  const gx = x / cell, gz = z / cell, x0 = Math.floor(gx), z0 = Math.floor(gz), tx = gx - x0, tz = gz - z0;
  const sm = (t) => t * t * (3 - 2 * t), a = hash2(x0, z0, s), b = hash2(x0 + 1, z0, s), c = hash2(x0, z0 + 1, s), d = hash2(x0 + 1, z0 + 1, s);
  const u = sm(tx), v = sm(tz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function growLand(world, WATER_LEVEL) {
  const old = world.heights, oldN = world.size, N = GROW_TO, edge = 3;
  const H = Array.from({ length: N }, (_, x) => Array.from({ length: N }, (_, z) => old[x]?.[z] ?? 0));
  const isLand = (x, z) => (old[x]?.[z] ?? 0) > WATER_LEVEL;
  // Distance from every tile to the nearest land tile (two-pass chamfer).
  const D = Array.from({ length: N }, (_, x) => Array.from({ length: N }, (_, z) => (isLand(x, z) ? 0 : 1e9)));
  const S2 = Math.SQRT2;
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) for (const [a, b, c] of [[-1, 0, 1], [0, -1, 1], [-1, -1, S2], [-1, 1, S2]]) { const v = D[x + a]?.[z + b]; if (v !== undefined && v + c < D[x][z]) D[x][z] = v + c; }
  for (let x = N - 1; x >= 0; x--) for (let z = N - 1; z >= 0; z--) for (const [a, b, c] of [[1, 0, 1], [0, 1, 1], [1, 1, S2], [1, -1, S2]]) { const v = D[x + a]?.[z + b]; if (v !== undefined && v + c < D[x][z]) D[x][z] = v + c; }
  const pier = world.places.dock.pier.tiles, end = pier[pier.length - 1], hb = world.sites.harbor;
  const keepSea = (x, z) => pier.some(([a, b]) => Math.hypot(a - x, b - z) < 6) || Math.hypot(x - end[0], z - end[1]) < 10 || (Math.abs(x - hb.x) < 8 && z < hb.z + 2);
  for (let x = edge; x < N - edge; x++)
    for (let z = edge; z < N - edge; z++) {
      if (isLand(x, z) || keepSea(x, z)) continue;
      const R = 5 + smoothNoise(x, z, 7, 91) * 3.5;
      const d = D[x][z];
      if (d <= R - 1.4) H[x][z] = Math.max(H[x][z], 2);
      else if (d <= R + 0.4) H[x][z] = Math.max(H[x][z], 1);
    }
  world.heights = H;
  world.size = N;
  return isLand;
}

export function spreadLayout(world, { WATER_LEVEL, ZONE_DEFS, zoneOf }) {
  const treesBefore = world.trees.length;
  const wasLand = growLand(world, WATER_LEVEL);
  const H = world.heights, N = world.size;
  const h = (x, z) => H[x]?.[z] ?? 0;
  const land = (x, z) => h(x, z) > WATER_LEVEL;
  const P = world.places, market = P.market, dock = P.dock, pier = dock.pier;
  const fields = world.fields;

  // Things every building keeps clear of (as boxes), plus lanes kept open.
  const keep = [
    { ...boxOf(market.x, market.z, { w: PLAZA_R, d0: PLAZA_R, d1: PLAZA_R }), pad: GAP },
    { ...boxOf(dock.x, dock.z, { w: 1.5, d0: 1.5, d1: 1.5 }), pad: GAP + 1 },
    { x0: fields.x - fields.w - 0.5, x1: fields.x + fields.w + 0.5, z0: fields.z - fields.d - 0.5, z1: fields.z + fields.d + 0.5, pad: 3 },
  ];
  for (const [x, z] of pier.tiles) keep.push({ x0: x - 0.5, x1: x + 0.5, z0: z - 0.5, z1: z + 0.5, pad: 3 });
  const round = [[P.mine, 5.5], [P.mine2, 7], [{ x: P.meadow.x, z: P.meadow.z }, 6]];
  const lanes = [[market, dock, 2.5]]; // centerline, half-width clear of buildings
  const placed = []; // boxes already given out ({ ...box, home })

  const fits = (x, z, f, home = false) => {
    const b = boxOf(x, z, f);
    if (b.x0 < 3 || b.z0 < 3 || b.x1 > N - 4 || b.z1 > N - 4) return false;
    for (const k of keep) if (boxGap(b, k) < k.pad) return false;
    for (const p of placed) if (boxGap(b, p) < (home && p.home ? GAP_HOMES : GAP)) return false;
    for (const [c, r] of round) if (Math.hypot(x - c.x, z - c.z) < r + f.w) return false;
    for (const [a, c, w] of lanes) if (segDist(x, z, a.x, a.z, c.x, c.z) < w + f.w) return false;
    return true;
  };
  const ground = (x, z, f) => {
    const hs = [];
    for (let dx = -Math.floor(f.w); dx <= Math.floor(f.w); dx++)
      for (let dz = -Math.floor(f.d0); dz <= Math.floor(f.d1); dz++) {
        if (!land(x + dx, z + dz)) return null;
        hs.push(h(x + dx, z + dz));
      }
    return { lo: Math.min(...hs), hi: Math.max(...hs) };
  };

  // 1. Landmark sites: the nearest good spot to where each belongs, flattened into a pad.
  const want = {
    townhall: { x: market.x, z: market.z - 12, near: 7 },           // north of the plaza, facing it
    markethall: { x: market.x + 12, z: market.z + 1, near: 7 },     // east of the plaza
    monument: { x: market.x - 11, z: market.z - 2, near: 7 },       // west of the plaza (built later)
    granary: { x: fields.x - 1, z: fields.z - fields.d - 7, near: 6 }, // beside the fields, not on a house
    harbor: { x: world.sites.harbor.x, z: world.sites.harbor.z, near: 0 }, // the North Beach harbor stays put
  };
  const sites = {};
  for (const [type, w] of Object.entries(want)) {
    const f = footprint('project', type);
    if (type === 'harbor') { sites.harbor = world.sites.harbor; placed.push(boxOf(sites.harbor.x, sites.harbor.z, { w: 2.5, d0: 1.5, d1: 1.5 })); continue; }
    let best = null;
    for (let r = 0; r <= w.near && !best; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = w.x + dx, z = w.z + dz, g = ground(x, z, f);
          if (!g || g.hi - g.lo > 2 || !fits(x, z, f)) continue;
          const score = Math.hypot(dx, dz) + (g.hi - g.lo) * 1.5;
          if (!best || score < best.score) best = { x, z, score, y: Math.max(WATER_LEVEL + 1, g.hi) };
        }
    if (!best) best = { x: world.sites[type].x, z: world.sites[type].z, y: world.sites[type].y };
    sites[type] = { x: best.x, z: best.z, w: Math.ceil(f.w - 0.5), d: Math.ceil(f.d1 - 0.5), y: best.y };
    placed.push(boxOf(best.x, best.z, f));
  }
  // The Lighthouse: on the shore beside the dock, off the path, with open water in front of it.
  {
    const f = footprint('project', 'lighthouse');
    let best = null;
    for (let x = dock.x - 10; x <= dock.x + 10; x++)
      for (let z = dock.z - 10; z <= dock.z + 10; z++) {
        const d = Math.hypot(x - dock.x, z - dock.z);
        if (d < 6 || d > 10) continue;
        const g = ground(x, z, f);
        if (!g || g.hi - g.lo > 2 || !fits(x, z, f)) continue;
        let wet = 0;
        for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) if (!land(x + a, z + b)) wet++;
        if (wet < 6) continue; // on the waterfront
        const score = d - wet * 0.15;
        if (!best || score < best.score) best = { x, z, score, y: Math.max(WATER_LEVEL + 1, g.hi) };
      }
    if (!best) best = { x: world.sites.lighthouse.x, z: world.sites.lighthouse.z, y: world.sites.lighthouse.y };
    sites.lighthouse = { x: best.x, z: best.z, w: 1, d: 1, y: best.y };
    placed.push(boxOf(best.x, best.z, f));
  }
  // Flatten each new site's pad (one tile round the building) to its height.
  for (const [type, s] of Object.entries(sites)) {
    if (type === 'harbor') continue;
    const f = footprint('project', type);
    for (let dx = -Math.ceil(f.w); dx <= Math.ceil(f.w); dx++)
      for (let dz = -Math.ceil(f.d0); dz <= Math.ceil(f.d1); dz++)
        if (land(s.x + dx, s.z + dz) || (Math.abs(dx) < f.w && dz > -f.d0 && dz < f.d1)) H[s.x + dx][s.z + dz] = s.y;
  }

  // 2. Building plots: flat 3x3 spots, GAP tiles apart from everything, sorted so each zone's heart fills first.
  // Candidates are taken nearest-the-heart first, so each zone packs neatly outward from its center.
  const f3 = footprint('private', 'house');
  const cands = [];
  for (let x = 4; x < N - 4; x++)
    for (let z = 4; z < N - 4; z++) {
      const g = ground(x, z, f3);
      if (!g || g.hi - g.lo > 3 || !fits(x, z, f3, true)) continue;
      // In town, a tree can make way for a home; out in the countryside the trees stay.
      const town = Math.hypot(x - market.x, z - market.z) < 20;
      if (!town && world.trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.2)) continue;
      const zone = zoneOf(x, z);
      const heart = zone === 'harbor' ? market : { x: ZONE_DEFS[zone].cx, z: ZONE_DEFS[zone].cz };
      cands.push({ x, z, y: g.hi, zone, d: Math.hypot(x - heart.x, z - heart.z) + (g.hi - g.lo) * 0.8 });
    }
  cands.sort((a, b) => a.d - b.d);
  const plots = [];
  for (const c of cands) {
    if (!fits(c.x, c.z, f3, true)) continue;
    plots.push(c);
    placed.push({ ...boxOf(c.x, c.z, f3), home: true });
  }

  // 3. Trees standing on a new site or plot come down.
  const all = [...Object.entries(sites).filter(([k]) => k !== 'harbor').map(([k, s]) => boxOf(s.x, s.z, footprint('project', k))), ...plots.map((p) => boxOf(p.x, p.z, f3))];
  world.trees = world.trees.filter((t) => !all.some((b) => boxGap(b, { x0: t.x - 0.5, x1: t.x + 0.5, z0: t.z - 0.5, z1: t.z + 0.5 }) < 1));
  // ...and as many new ones grow on the new land, clear of every building, so the island keeps its wood.
  const tb = (x, z) => ({ x0: x - 0.5, x1: x + 0.5, z0: z - 0.5, z1: z + 0.5 });
  for (let i = 0; i < 20000 && world.trees.length < treesBefore; i++) {
    const x = 4 + Math.floor(hash2(i, 7, 5) * (N - 8)), z = 4 + Math.floor(hash2(i, 11, 6) * (N - 8));
    if (wasLand(x, z) || !land(x, z)) continue;
    if (Math.hypot(x - market.x, z - market.z) < 14 || Math.hypot(x - P.meadow.x, z - P.meadow.z) < 9) continue;
    if (world.trees.some((t) => Math.hypot(t.x - x, t.z - z) < 4)) continue;
    if (all.some((b) => boxGap(b, tb(x, z)) < 2) || keep.some((k) => boxGap(k, tb(x, z)) < 2)) continue;
    world.trees.push({ x, z, h: 3 + Math.floor(hash2(x, z, 3) * 2) });
  }

  world.sites = sites;
  world.plots = plots;
  world.layout = LAYOUT_VERSION;
  return world;
}

// Moves a saved island's buildings onto the spacious plan, once. Landmarks go to their new sites. Each animal's
// buildings go to the free plots nearest where they stood (in the same zone), house first, workshop near the
// house. Returns the new list of taken plot keys, and fixes any job still waiting for a plot.
export function relocate({ world, buildings, jobs, agents }) {
  const key = (p) => `${p.x},${p.z}`;
  const taken = new Set();
  const moved = [];
  for (const b of buildings) {
    if (b.kind !== 'project') continue;
    const s = world.sites[b.type];
    if (!s) continue;
    moved.push([b.id, b.x, b.z, s.x, s.z]);
    Object.assign(b, { x: s.x, z: s.z, y: s.y });
  }
  const zoneAtOld = (x, z) => {
    for (const k of ['farm', 'west', 'north']) { const zd = world.zones[k]; if (Math.hypot(x - zd.cx, z - zd.cz) <= zd.r * 0.95) return k; }
    return 'harbor';
  };
  const pick = (x, z, zone) => {
    let best = null;
    for (const p of world.plots) {
      if (taken.has(key(p))) continue;
      const d = Math.hypot(p.x - x, p.z - z) + (p.zone === zone ? 0 : 30);
      if (!best || d < best.d) best = { p, d };
    }
    return best?.p || null;
  };
  // Houses first (oldest first), then each owner's other buildings near their house.
  const priv = buildings.filter((b) => b.kind !== 'project').sort((a, b) => (a.type === 'house' ? 0 : 1) - (b.type === 'house' ? 0 : 1) || a.id - b.id);
  const home = {};
  for (const b of priv) {
    const zone = zoneAtOld(b.x, b.z);
    const anchor = b.type !== 'house' && home[b.owner] ? { x: (home[b.owner].x * 2 + b.x) / 3, z: (home[b.owner].z * 2 + b.z) / 3 } : b;
    const p = pick(anchor.x, anchor.z, zone);
    if (!p) continue; // no room: it stays where it is
    taken.add(key(p));
    moved.push([b.id, b.x, b.z, p.x, p.z]);
    Object.assign(b, { x: p.x, z: p.z, y: p.y });
    if (b.type === 'house' && !home[b.owner]) home[b.owner] = p;
  }
  // Jobs that reserved a plot but haven't broken ground get a new one.
  for (const j of jobs || []) {
    if (!j.plot || j.buildingRef || j.status === 'done') continue;
    const p = pick(j.plot.x, j.plot.z, zoneAtOld(j.plot.x, j.plot.z));
    if (p) { taken.add(key(p)); j.plot = { x: p.x, z: p.z, y: p.y }; }
  }
  // Anyone standing where a building now is steps out to its door.
  for (const a of agents || []) {
    for (const b of buildings) {
      const f = footprint(b.kind, b.type);
      if (a.x > b.x - f.w - 0.3 && a.x < b.x + f.w + 0.3 && a.z > b.z - f.d0 - 0.3 && a.z < b.z + f.d1 + 0.3) { a.x = b.x; a.z = b.z + f.d1 + 1.2; a.target = null; }
    }
  }
  return { taken, moved };
}
