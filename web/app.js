// Insula World viewer: a cinematic voxel island rendered live from the simulation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';
import { Sound } from './sound.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Math.round(n).toLocaleString();
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------- Renderer, scene, post-processing ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
$('#scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbfe3f7, 70, 210);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 900);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 7;
controls.maxDistance = 95;
controls.autoRotate = !REDUCED;
controls.autoRotateSpeed = 0.25;

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b7f4a, 0.9);
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(3072, 3072);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -58, right: 58, top: 58, bottom: -58, near: 1, far: 260 });
scene.add(hemi, sun, sun.target);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.55, 0.88);
composer.addPass(bloom);
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.32 }, warmth: { value: 0.0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float vignette; uniform float warmth; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5; float v = 1.0 - dot(d, d) * vignette * 2.6;
      c.rgb *= clamp(v, 0.0, 1.0);
      c.rgb = mix(c.rgb, c.rgb * vec3(1.06, 1.0, 0.92), warmth);
      gl_FragColor = c;
    }`,
});
composer.addPass(grade);
// Tilt-shift: blur above and below a focus band so the island reads as a miniature.
const tiltH = new ShaderPass(HorizontalTiltShiftShader);
const tiltV = new ShaderPass(VerticalTiltShiftShader);
tiltH.uniforms.r.value = tiltV.uniforms.r.value = 0.46;
composer.addPass(tiltH);
composer.addPass(tiltV);
composer.addPass(new OutputPass());
const sound = new Sound();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------- Sky dome, stars ----------
const skyUniforms = {
  top: { value: new THREE.Color(0x3d8fe6) },
  horizon: { value: new THREE.Color(0xbfe3f7) },
  sunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() },
  sunColor: { value: new THREE.Color(0xffffff) },
  night: { value: 0 },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(420, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
    fragmentShader: `
      uniform vec3 top, horizon, sunDir, sunColor; uniform float night; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 col = mix(horizon, top, pow(max(h, 0.0), 0.55));
        col = mix(col, horizon * 0.6, clamp(-h * 4.0, 0.0, 1.0));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        float disk = smoothstep(0.9993, 0.9997, s);
        col += sunColor * (pow(s, 12.0) * 0.35 + pow(s, 120.0) * 0.6) * (1.0 - night * 0.6);
        col += sunColor * disk * (night > 0.5 ? 1.2 : 3.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
);
scene.add(sky);

const starGeo = new THREE.BufferGeometry();
{
  const pts = [];
  for (let i = 0; i < 1400; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.random() * 0.9 + 0.08;
    const r = 400;
    pts.push(Math.cos(u) * Math.sqrt(1 - v * v) * r, v * r, Math.sin(u) * Math.sqrt(1 - v * v) * r);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
}
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, map: glowTex, transparent: true, depthWrite: false, fog: false, opacity: 0, blending: THREE.AdditiveBlending }));
scene.add(stars);

// ---------- Time of day ----------
// t runs 0..1 through one in-world day. 0 is dawn.
const KEYS = [
  { t: 0.0, top: 0x4c6aa8, hor: 0xf6b48e, sun: 0xffb27a, si: 1.1, hi: 0.5, el: 6, night: 0.15, exp: 0.95, warm: 0.6 },
  { t: 0.1, top: 0x4b93e2, hor: 0xd3ebf8, sun: 0xfff0d8, si: 2.4, hi: 0.85, el: 38, night: 0, exp: 1.0, warm: 0.15 },
  { t: 0.45, top: 0x3a88df, hor: 0xc5e6f8, sun: 0xffffff, si: 2.6, hi: 0.95, el: 62, night: 0, exp: 1.0, warm: 0.05 },
  { t: 0.6, top: 0x5277bd, hor: 0xffc58a, sun: 0xffb46a, si: 2.3, hi: 0.7, el: 16, night: 0, exp: 1.02, warm: 0.7 },
  { t: 0.68, top: 0x2f3c78, hor: 0xff7d5c, sun: 0xff7a4d, si: 1.3, hi: 0.45, el: 3, night: 0.3, exp: 1.0, warm: 0.8 },
  { t: 0.76, top: 0x060a1c, hor: 0x1b2550, sun: 0x9db4ff, si: 0.55, hi: 0.26, el: 42, night: 1, exp: 1.15, warm: 0 },
  { t: 0.93, top: 0x080d22, hor: 0x2a2f5c, sun: 0x9db4ff, si: 0.5, hi: 0.26, el: 30, night: 0.9, exp: 1.15, warm: 0 },
  { t: 1.0, top: 0x4c6aa8, hor: 0xf6b48e, sun: 0xffb27a, si: 1.1, hi: 0.5, el: 6, night: 0.15, exp: 0.95, warm: 0.6 },
];
const cA = new THREE.Color(), cB = new THREE.Color();
let nightness = 0;
const OVERRIDES = { dawn: 0.02, day: 0.3, golden: 0.6, sunset: 0.665, night: 0.82 };
let timeOverride = OVERRIDES[location.hash.slice(1)] ?? null;
addEventListener('hashchange', () => (timeOverride = OVERRIDES[location.hash.slice(1)] ?? null));

function applyTime(t) {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const k = clamp01((t - a.t) / (b.t - a.t));
  const mix = (x, y) => cA.setHex(x).lerp(cB.setHex(y), k);
  skyUniforms.top.value.copy(mix(a.top, b.top));
  skyUniforms.horizon.value.copy(mix(a.hor, b.hor));
  scene.fog.color.copy(skyUniforms.horizon.value);
  const sc = mix(a.sun, b.sun).clone();
  sun.color.copy(sc);
  skyUniforms.sunColor.value.copy(sc);
  sun.intensity = lerp(a.si, b.si, k);
  hemi.intensity = lerp(a.hi, b.hi, k) + 0.35;
  hemi.color.copy(skyUniforms.top.value).lerp(new THREE.Color(0xffffff), 0.55);
  nightness = lerp(a.night, b.night, k);
  skyUniforms.night.value = nightness;
  renderer.toneMappingExposure = lerp(a.exp, b.exp, k);
  grade.uniforms.warmth.value = lerp(a.warm, b.warm, k);
  grade.uniforms.vignette.value = 0.3 + nightness * 0.2;
  bloom.strength = 0.4 + nightness * 0.2;
  const el = THREE.MathUtils.degToRad(lerp(a.el, b.el, k));
  const az = 0.9 + t * Math.PI * 1.4;
  const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
  skyUniforms.sunDir.value.copy(dir);
  if (world) {
    const c = new THREE.Vector3(world.size / 2, 0, world.size / 2);
    sun.position.copy(c).addScaledVector(dir, 80);
    sun.target.position.copy(c);
  }
  stars.material.opacity = clamp01((nightness - 0.4) * 1.6);
  const hour = (5 + t * 24) % 24;
  return hour;
}

// ---------- World ----------
const COL = {
  grass: 0x86d957, grass2: 0x76c94b, dirt: 0x8a5a33, sand: 0xf0e0ad, sand2: 0xe8d6a0, stone: 0x8e939a, stone2: 0x767b83,
  cobble: 0xa9a59c, cobble2: 0x99958c, plank: 0xb98349, plank2: 0x93623a, trunk: 0x6b4423, leaves: 0x55b84a, leaves2: 0x6dcc58,
  awnA: 0xd9493f, awnB: 0xf3efe6, ore: 0xf0b64a,
};
let world = null;
const places = [];
let waterMat = null;
const lanterns = [];
const clouds = [];
const fireflies = { points: null, base: [] };

// A proper pier at the dock: a 3-wide deck on posts, railings, a wider landing at the far end, lanterns,
// crates for the mainland trade and a rowboat tied alongside. It runs straight out (along x or z) in
// whichever direction from the dock reaches open water soonest. Returns the lantern positions.
const pierDeck = new Set(); // pier planks: over water, but not somewhere to cast a line
let pierAxis = null;       // which way the pier runs out to sea, and where it ends
let pierTop = null;        // the deck surface height
let solidSet = null;       // every solid block, "x,y,z" (for walking)
const noWalk = new Set();  // "x,z" cells nobody climbs onto (the market stall counter)
function buildPier(w, hash) {
  const { heights, waterLevel, places: P } = w;
  const d = P.dock, H = (x, z) => heights[x]?.[z] ?? 99;
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
  if (d.pier) best = { ax: d.pier.ax, az: d.pier.az, first: d.pier.first, run: 0 }; // the server's layout wins
  const { ax, az } = best;
  const px = -az, pz = ax; // across the pier
  const top = d.pier?.top ?? H(d.x, d.z) + 1.08; // deck surface, level with the dock tile
  const start = 1, len = best.first + 6; // from beside the dock tile to well past the shoreline
  pierAxis = { ax, az, endX: d.x + ax * len, endZ: d.z + az * len };
  pierTop = top;
  const wood = [], dark = [], lamps = [], crates = [];
  const at = (i, j) => [d.x + ax * i + px * j, d.z + az * i + pz * j];
  for (let i = start; i <= len; i++) {
    const wide = i >= len - 1 ? 2 : 1; // a wider landing at the far end
    for (let j = -wide; j <= wide; j++) {
      const [x, z] = at(i, j);
      wood.push({ x, y: top - 0.12, z, sx: 1, sy: 0.22, sz: 1, c: i % 2 ? COL.plank : 0xa87440 });
      pierDeck.add(`${Math.round(x)},${Math.round(z)}`);
    }
    // Posts down into the water, every other plank row, on both edges
    if ((i - start) % 2 === 0 || i === len) for (const j of [-wide, wide]) {
      const [x, z] = at(i, j);
      const floor = Math.min(H(x, z) + 1, waterLevel);
      const ph = top - 0.2 - (floor - 0.6);
      dark.push({ x: x + px * j * 0.32 / Math.abs(j), y: top - 0.2 - ph / 2, z: z + pz * j * 0.32 / Math.abs(j), sx: 0.26, sy: ph, sz: 0.26 });
    }
  }
  // Railings along both sides (open at the landing's front so it reads as a pier, not a box)
  for (const j of [-1, 1]) {
    for (let i = start; i <= len - 2; i++) {
      const [x, z] = at(i, j);
      const ox = px * j * 0.42, oz = pz * j * 0.42;
      dark.push({ x: x + ox, y: top + 0.28, z: z + oz, sx: ax ? 0.08 : 0.08, sy: 0.56, sz: 0.08 });
      dark.push({ x: x + ox, y: top + 0.56, z: z + oz, sx: ax ? 1 : 0.1, sy: 0.08, sz: ax ? 0.1 : 1 });
    }
  }
  // Lanterns on the landing corners
  for (const j of [-2, 2]) {
    const [x, z] = at(len, j);
    lamps.push(new THREE.Vector3(x, top + 2.7, z));
  }
  // Crates and a barrel by the shore end, waiting for the mainland boat
  for (const [i, j, s] of [[start, 0.0, 0.6], [start + 1, -0.1, 0.5], [start, 0.1, 0.45]]) {
    const [x, z] = at(i, j);
    crates.push({ x: x + ax * 0.0 + px * (s === 0.45 ? 0 : 0.6) * (j < 0 ? -1 : 1), y: top + s / 2 + (s === 0.45 ? 0.6 : 0), z: z + pz * 0.6 * (j < 0 ? -1 : 1), sx: s, sy: s, sz: s, c: s === 0.5 ? 0x7a5a3a : 0xa8783e });
  }
  // Rowboat moored beside the landing
  const deep = (x, z) => H(x, z) < waterLevel; // open water, not the beach
  const side = (s) => [1, 2, 3, 4].filter((k) => deep(...at(len, s * (2 + k))) && deep(...at(len - 1, s * (2 + k)))).length;
  const bs = side(1) >= side(-1) ? 1 : -1; // the side with more open water
  const [bx, bz] = at(len - 0.5, bs * 3.4);
  const along = (l, a2) => (ax ? [l, a2] : [a2, l]);
  const boat = [];
  const wy = waterLevel + 0.85;
  const [hl, hw] = along(2.4, 1.1);
  boat.push({ x: bx, y: wy + 0.12, z: bz, sx: hl, sy: 0.42, sz: hw, c: 0x8c5a32 });
  const [il, iw] = along(2.0, 0.75);
  boat.push({ x: bx, y: wy + 0.34, z: bz, sx: il, sy: 0.06, sz: iw, c: 0x5e3b20 });
  const [sl, sw] = along(0.18, 1.1);
  boat.push({ x: bx, y: wy + 0.42, z: bz, sx: sl, sy: 0.08, sz: sw, c: 0xb98349 });
  for (const e of [-1, 1]) {
    const [ex, ez] = along(1.25 * e, 0);
    const [kl, kw] = along(0.3, 0.7);
    boat.push({ x: bx + ex, y: wy + 0.2, z: bz + ez, sx: kl, sy: 0.36, sz: kw, c: 0x8c5a32 });
  }
  // A rope from the boat to the landing post
  const [rx, rz] = at(len - 1, bs * 2);
  dark.push({ x: (bx + rx) / 2, y: top - 0.25, z: (bz + rz) / 2, sx: ax ? 0.05 : 1.3, sy: 0.05, sz: ax ? 1.3 : 0.05 });

  const geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  const add = (list, mat, defaultColor) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((b, k) => {
      mesh.setMatrixAt(k, m.makeScale(b.sx, b.sy, b.sz).setPosition(b.x, b.y, b.z));
      mesh.setColorAt(k, col.setHex(b.c ?? defaultColor).offsetHSL(0, 0, ((hash(k, 3, list.length) % 100) / 100 - 0.5) * 0.06));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  };
  add(wood, new THREE.MeshStandardMaterial({ roughness: 0.9 }), COL.plank);
  add(dark, new THREE.MeshStandardMaterial({ roughness: 1 }), 0x5a3a22);
  add(crates, new THREE.MeshStandardMaterial({ roughness: 0.85 }), 0xa8783e);
  add(boat, new THREE.MeshStandardMaterial({ roughness: 0.8 }), 0x8c5a32);
  return lamps;
}

// Fish shadows in the water around the pier (Animal Crossing style): dark shapes that drift, pause and dart,
// and swim over to nibble at a fisher's bobber. Decoration only; the catch itself is decided by the server.
const fishes = [];
function buildFish(w) {
  const { heights, waterLevel, places: P } = w;
  const d = P.dock, pier = d.pier;
  const end = pier ? { x: d.x + pier.ax * pier.len, z: d.z + pier.az * pier.len } : { x: d.waterX, z: d.waterZ };
  const wet = (x, z) => (heights[Math.round(x)]?.[Math.round(z)] ?? 0) < waterLevel;
  const geo = new THREE.CircleGeometry(0.5, 20);
  const y = waterLevel + 1.06; // just above the wave crests, so the water never hides them
  for (let i = 0; i < 7; i++) {
    const size = [0.55, 0.7, 0.85, 1.05, 0.6, 0.8, 1.25][i];
    const mat = new THREE.MeshBasicMaterial({ color: 0x0a2433, transparent: true, opacity: 0, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 5; // after the water
    const f = { m, size, x: end.x + (Math.random() - 0.5) * 6, z: end.z + (Math.random() - 0.5) * 6, tx: 0, tz: 0, speed: 0, rest: Math.random() * 3, heading: Math.random() * 6.28, phase: Math.random() * 6.28, home: end, wet };
    if (!wet(f.x, f.z)) { f.x = end.x + pier?.ax * 2 || end.x; f.z = end.z + pier?.az * 2 || end.z; }
    m.position.set(f.x, y, f.z);
    scene.add(m);
    fishes.push(f);
  }
}
const bobberPos = new THREE.Vector3();
function stepFish(dt, t) {
  if (!fishes.length) return;
  // Bobbers in the water near the pier pull the closest fish over.
  const bobbers = [];
  for (const rec of agents.values()) {
    const tl = rec.group?.userData?.tools?.fishing;
    if (rec.data.activity === 'fishing' && tl?.g.visible) { tl.tip.getWorldPosition(bobberPos); bobbers.push({ x: bobberPos.x, z: bobberPos.z }); }
  }
  const visible = clamp01(1 - (rain?.level || 0) * 0.5) * (0.4 + 0.12 * (1 - nightness));
  fishes.forEach((f, i) => {
    const b = bobbers[i];
    if (b && Math.hypot(b.x - f.home.x, b.z - f.home.z) < 14 && f.wet(b.x, b.z)) {
      // Circle the bobber, nosing in and out.
      const a = t * 0.9 + i * 2.1, r = 0.55 + Math.sin(t * 2.3 + i) * 0.25;
      f.tx = b.x + Math.cos(a) * r; f.tz = b.z + Math.sin(a) * r; f.speed = 1.4; f.rest = 0;
    } else if (f.rest > 0) {
      f.rest -= dt; f.speed = 0;
    } else if (Math.hypot(f.tx - f.x, f.tz - f.z) < 0.3 || !f.speed) {
      // Pick somewhere new in open water near the pier; sometimes dart, sometimes laze.
      for (let k = 0; k < 8; k++) {
        const tx = f.home.x + (Math.random() - 0.5) * 12, tz = f.home.z + (Math.random() - 0.5) * 12;
        if (f.wet(tx, tz)) { f.tx = tx; f.tz = tz; break; }
      }
      f.speed = Math.random() < 0.2 ? 3.2 : 0.6 + Math.random() * 0.7;
      if (Math.random() < 0.35) f.rest = 1 + Math.random() * 4;
    }
    const dx = f.tx - f.x, dz = f.tz - f.z, dist = Math.hypot(dx, dz);
    if (f.speed && dist > 0.01) {
      const step = Math.min(dist, f.speed * dt);
      f.x += (dx / dist) * step; f.z += (dz / dist) * step;
      let want = Math.atan2(dx, dz), dh = want - f.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      f.heading += dh * Math.min(1, dt * 5);
    }
    const wiggle = 1 + Math.sin(t * (f.speed ? 9 : 3) + f.phase) * (f.speed ? 0.08 : 0.03);
    f.m.position.x = f.x; f.m.position.z = f.z;
    f.m.rotation.z = f.heading;
    f.m.scale.set(f.size * 0.55 * wiggle, f.size * 1.25, 1);
    f.m.material.opacity += (visible - f.m.material.opacity) * Math.min(1, dt * 2);
  });
}

function buildWorld(w) {
  world = w;
  const { size, heights, waterLevel, places: P } = w;
  const solid = new Map(); // "x,y,z" -> color
  const glow = []; // emissive blocks
  const put = (x, y, z, c) => solid.set(`${x},${y},${z}`, c);
  const nearMine = (x, z) => Math.hypot(x - P.mine.x, z - P.mine.z) <= 4.6 || (P.mine2 && Math.hypot(x - P.mine2.x, z - P.mine2.z) <= 5.6);
  const nearMarket = (x, z) => Math.abs(x - P.market.x) <= 3 && Math.abs(z - P.market.z) <= 3;
  const oreSet = new Set([...w.ores, ...(w.ores2 || [])].map((o) => `${o.x},${o.z}`));
  const plaza = heights[P.market.x][P.market.z];
  const hash = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;

  for (let x = 0; x < size; x++)
    for (let z = 0; z < size; z++) {
      const h = heights[x][z];
      for (let y = Math.max(0, h - 3); y <= h; y++) {
        const top = y === h, r = hash(x, y, z) % 5;
        let c;
        if (nearMarket(x, z) && top) c = (x + z) % 2 ? COL.cobble : COL.cobble2;
        else if (nearMine(x, z) && y > plaza) {
          if (top && oreSet.has(`${x},${z}`)) { glow.push([x, y, z]); continue; }
          c = r ? COL.stone : COL.stone2;
        } else if (h <= waterLevel) c = r ? COL.sand : COL.sand2;
        else if (top) c = r ? COL.grass : COL.grass2;
        else c = COL.dirt;
        put(x, y, z, c);
      }
    }
  for (const t of w.trees) {
    const base = heights[t.x][t.z] + 1;
    for (let i = 0; i < t.h; i++) put(t.x, base + i, t.z, COL.trunk);
    const top = base + t.h;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const d = Math.abs(dx) + Math.abs(dz);
        if (d <= 3 && !(Math.abs(dx) === 2 && Math.abs(dz) === 2)) put(t.x + dx, top - 1, t.z + dz, hash(dx, t.x, dz) % 3 ? COL.leaves : COL.leaves2);
        if (d <= 2 && Math.abs(dx) < 2 && Math.abs(dz) < 2) put(t.x + dx, top, t.z + dz, COL.leaves2);
      }
    put(t.x, top + 1, t.z, COL.leaves2);
  }
  // Market stall with lanterns
  const mh = plaza + 1, sx = P.market.x, sz = P.market.z - 2;
  for (let dx = -1; dx <= 1; dx++) { put(sx + dx, mh, sz, COL.plank); noWalk.add(`${sx + dx},${sz}`); }
  for (const dx of [-2, 2]) for (let y = 0; y <= 2; y++) put(sx + dx, mh + y, sz - 1, COL.plank2);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -1; dz <= 0; dz++) put(sx + dx, mh + 3, sz + dz, (dx + 2) % 2 ? COL.awnB : COL.awnA);
  lanterns.push(new THREE.Vector3(sx - 2, mh + 2.6, sz + 0.6), new THREE.Vector3(sx + 2, mh + 2.6, sz + 0.6));
  // Crates of goods at the stall
  put(sx - 1, mh + 1, sz, COL.plank2);
  // The dock: a wooden pier out over the water (see buildPier)
  const dockBlocks = [];
  lanterns.push(...buildPier(w, hash));
  buildFish(w);
  // Mine entrance posts
  const me = { x: P.mine.x - 3, z: P.mine.z + 3 };
  lanterns.push(new THREE.Vector3(me.x, heights[me.x][me.z] + 2.4, me.z));

  // For walk mode: every solid block, ore included.
  solidSet = new Set(solid.keys());
  for (const [x, y, z] of glow) solidSet.add(`${x},${y},${z}`);

  // Keep only blocks with at least one exposed face.
  const visible = [];
  for (const [key, c] of solid) {
    const [x, y, z] = key.split(',').map(Number);
    const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(
      ([a, b, e]) => !solid.has(`${x + a},${y + b},${z + e}`) && !(b === -1 && y === 0),
    );
    if (exposed) visible.push([x, y, z, c]);
  }

  const geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.07);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, visible.length + dockBlocks.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  visible.forEach(([x, y, z, c], i) => {
    mesh.setMatrixAt(i, m.makeTranslation(x, y + 0.5, z));
    const j = ((hash(x, y, z) % 100) / 100 - 0.5) * 0.08;
    mesh.setColorAt(i, col.setHex(c).offsetHSL(0, 0, j));
  });
  dockBlocks.forEach(([x, y, z], i) => {
    m.makeScale(1, 0.25, 1).setPosition(x, y + 0.12, z);
    mesh.setMatrixAt(visible.length + i, m);
    mesh.setColorAt(visible.length + i, col.setHex(i % 2 ? COL.plank : COL.plank2));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  const oreMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: COL.ore, emissive: 0xffb02e, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.6 }), glow.length);
  glow.forEach(([x, y, z], i) => oreMesh.setMatrixAt(i, m.makeTranslation(x, y + 0.5, z)));
  oreMesh.castShadow = oreMesh.receiveShadow = true;
  scene.add(oreMesh);

  // Lanterns: glowing cubes + warm point lights that come alive at night
  const lampGeo = new RoundedBoxGeometry(0.34, 0.42, 0.34, 2, 0.06);
  for (const p of lanterns) {
    const lamp = new THREE.Mesh(lampGeo, new THREE.MeshStandardMaterial({ color: 0xffd8a0, emissive: 0xffa040, emissiveIntensity: 0.4 }));
    lamp.position.copy(p);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 1 }));
    post.position.set(p.x, p.y - 1.4, p.z);
    post.castShadow = true;
    const light = new THREE.PointLight(0xffb469, 0, 11, 1.6);
    light.position.copy(p);
    scene.add(lamp, post, light);
    p.userData = { lamp, light };
  }

  // Water: gentle waves, depth tint, sun glint
  waterMat = new THREE.ShaderMaterial({
    transparent: true, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      time: { value: 0 }, shallow: { value: new THREE.Color(0x43c6d9) }, deep: { value: new THREE.Color(0x1a5c9e) },
      skyCol: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, sunCol: { value: new THREE.Color() },
      center: { value: new THREE.Vector2(size / 2, size / 2) }, night: { value: 0 },
    }]),
    vertexShader: `
      uniform float time; varying vec3 vWorld; varying vec3 vNormalW;
      #include <fog_pars_vertex>
      float wave(vec2 p){ return sin(p.x*0.35 + time*0.9)*0.08 + sin(p.y*0.42 - time*1.1)*0.07 + sin((p.x+p.y)*0.8 + time*1.7)*0.03; }
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float h = wave(wp.xz);
        wp.y += h;
        float e = 0.3;
        vec3 n = normalize(vec3(wave(wp.xz - vec2(e,0.0)) - wave(wp.xz + vec2(e,0.0)), 2.0*e, wave(wp.xz - vec2(0.0,e)) - wave(wp.xz + vec2(0.0,e))));
        vNormalW = n; vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 shallow, deep, skyCol, sunDir, sunCol; uniform vec2 center; uniform float time, night;
      varying vec3 vWorld; varying vec3 vNormalW;
      #include <fog_pars_fragment>
      void main(){
        float r = length(vWorld.xz - center);
        float depth = smoothstep(26.0, 52.0, r);
        vec3 base = mix(shallow, deep, depth) * mix(1.0, 0.35, night);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vNormalW);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        vec3 col = mix(base, skyCol, fres * 0.6);
        vec3 R = reflect(-normalize(sunDir), N);
        col += sunCol * pow(max(dot(R, V), 0.0), 90.0) * 1.6;
        gl_FragColor = vec4(col, mix(0.8, 0.94, depth));
        #include <fog_fragment>
      }`,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(700, 700, 260, 260), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(size / 2, waterLevel + 0.85, size / 2);
  scene.add(water);

  // Drifting voxel clouds that cast shadows across the island
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.92 });
  const cloudGeo = new RoundedBoxGeometry(1, 1, 1, 2, 0.15);
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const n = 4 + Math.floor(Math.random() * 5);
    for (let k = 0; k < n; k++) {
      const b = new THREE.Mesh(cloudGeo, cloudMat);
      b.scale.set(3 + Math.random() * 4, 1.2 + Math.random() * 1.2, 2.5 + Math.random() * 3);
      b.position.set(k * 2.2 - n, Math.random() * 0.8, (Math.random() - 0.5) * 3);
      b.castShadow = true;
      g.add(b);
    }
    g.position.set(Math.random() * 180 - 50, 24 + Math.random() * 8, Math.random() * 150 - 30);
    g.userData.speed = 0.6 + Math.random() * 0.8;
    scene.add(g);
    clouds.push(g);
  }

  // Fireflies by night, drifting pollen by day
  const ff = [];
  for (let i = 0; i < 140; i++) {
    let x, z;
    do { x = 3 + Math.random() * (size - 6); z = 3 + Math.random() * (size - 6); } while (heights[Math.round(x)][Math.round(z)] <= waterLevel);
    const y = heights[Math.round(x)][Math.round(z)] + 1.5 + Math.random() * 3;
    ff.push(x, y, z);
    fireflies.base.push([x, y, z, Math.random() * 10]);
  }
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.Float32BufferAttribute(ff, 3));
  fireflies.points = new THREE.Points(ffGeo, new THREE.PointsMaterial({ size: 0.45, map: glowTex, color: 0xfff1a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.2 }));
  scene.add(fireflies.points);

  controls.target.set(P.market.x, 3.5, P.market.z);
  camera.position.set(P.market.x + 34, 28, P.market.z + 36);
  controls.maxDistance = 140;

  for (const p of Object.values(P)) {
    const el = document.createElement('div');
    el.className = 'tag place';
    el.textContent = p.label;
    $('#bubbles').appendChild(el);
    const rec = { el, pos: new THREE.Vector3(p.x, heights[p.x][p.z] + (p.label === 'Mine' ? 4.2 : 5.4), p.z), zone: p.zone || null, label: p.label };
    places.push(rec);
    if (p.zone) zoneTags.push(rec);
  }
  buildFields(w);
}

// Farm Valley's fields: tilled rows of wheat that appear when the valley opens.
const zoneTags = [];
let fieldsGroup = null;
function buildFields(w) {
  const f = w.fields;
  if (!f) return;
  const soil = [], wheat = [];
  for (let dx = -f.w; dx <= f.w; dx++)
    for (let dz = -f.d; dz <= f.d; dz++) {
      const x = f.x + dx, z = f.z + dz, y = w.heights[x][z] + 1;
      soil.push([x, y - 0.42, z]);
      if (dz % 2 === 0) wheat.push([x, y, z]);
    }
  const m = new THREE.Matrix4();
  const soilMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.18, 1), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }), soil.length);
  soil.forEach(([x, y, z], i) => soilMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
  const wheatMesh = new THREE.InstancedMesh(new RoundedBoxGeometry(0.7, 0.8, 0.3, 1, 0.08), new THREE.MeshStandardMaterial({ color: 0xe8c45a, roughness: 0.8 }), wheat.length);
  wheat.forEach(([x, y, z], i) => wheatMesh.setMatrixAt(i, m.makeTranslation(x, y - 0.2, z)));
  soilMesh.receiveShadow = wheatMesh.castShadow = wheatMesh.receiveShadow = true;
  fieldsGroup = new THREE.Group();
  fieldsGroup.add(soilMesh, wheatMesh);
  fieldsGroup.visible = false;
  scene.add(fieldsGroup);
}

// Zone signs show when a locked area opens; fields appear with Farm Valley.
function syncZones(state) {
  const open = new Set(state.zones || []);
  for (const z of zoneTags) {
    const era = (state.eras || []).find((e) => e.id === z.zone || (z.zone === 'west' && e.id === 'west') || (z.zone === 'north' && e.id === 'north') || (z.zone === 'farm' && e.id === 'farm'));
    const text = open.has(z.zone) ? z.label : `${z.label} · opens day ${era ? era.day : '?'}`;
    if (z.el.textContent !== text) z.el.textContent = text;
    z.el.classList.toggle('locked', !open.has(z.zone));
  }
  if (fieldsGroup) fieldsGroup.visible = open.has('farm');
}

// ---------- Animals ----------
const partGeo = new Map();
function part(w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const key = `${w},${h},${d}`;
  if (!partGeo.has(key)) partGeo.set(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.18));
  const mesh = new THREE.Mesh(partGeo.get(key), new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

// Fishing helpers: where the water surface is, and which way from a spot the nearest open water lies.
const UP = new THREE.Vector3(0, 1, 0);
const ROD_TIP = new THREE.Vector3(0, 0.4, 1.7); // end of the rod, in the rod's own space
const fishTmp = new THREE.Vector3(), fishDir = new THREE.Vector3();
const WATER_Y = () => (world ? world.waterLevel + 0.9 : 1.9);
const aimCache = new Map();
// Which way to cast from (x, z). `pref` is the server's heading (it already points pier and dock fishers at
// the water); keep it when open water really is out that way, otherwise turn to the nearest open water.
function waterAim(x, z, pref) {
  const key = `${Math.round(x * 2)},${Math.round(z * 2)},${Math.round((pref || 0) * 4)}`;
  if (aimCache.has(key)) return aimCache.get(key);
  let best = null;
  const onDeck = (px, pz) => pierDeck.has(`${Math.round(px)},${Math.round(pz)}`);
  const wet = (px, pz) => world && (world.heights[Math.round(px)]?.[Math.round(pz)] ?? 0) <= world.waterLevel && !onDeck(px, pz);
  // first open water along heading h, within `max` units (two wet cells in a row, so a puddle doesn't count)
  const ray = (h, max) => {
    const sx = Math.sin(h), sz = Math.cos(h);
    for (let d = 0.5; d <= max; d += 0.5) if (wet(x + sx * d, z + sz * d) && wet(x + sx * (d + 1), z + sz * (d + 1))) return d;
    return null;
  };
  if (pref != null && Number.isFinite(pref)) { const d = ray(pref, 3); if (d != null) best = { heading: pref, dist: d }; }
  if (!best && pierAxis && onDeck(x, z)) {
    // On the pier: near the end, cast straight out past it; further back, cast off the side.
    const toEnd = (pierAxis.endX - x) * pierAxis.ax + (pierAxis.endZ - z) * pierAxis.az;
    const out = Math.atan2(pierAxis.ax, pierAxis.az);
    if (toEnd < 2.5) best = { heading: out, dist: Math.max(0.5, toEnd + 0.5) };
    else for (const h of [out + Math.PI / 2, out - Math.PI / 2]) { const d = ray(h, 4); if (d != null && (!best || d < best.dist)) best = { heading: h, dist: d }; }
    if (!best) best = { heading: out, dist: Math.max(0.5, toEnd + 0.5) };
  } else if (!best && world) {
    for (let i = 0; i < 32; i++) {
      const h = (i / 32) * Math.PI * 2, d = ray(h, 7);
      if (d != null && (!best || d < best.dist)) best = { heading: h, dist: d };
    }
  }
  if (aimCache.size > 500) aimCache.clear();
  aimCache.set(key, best);
  return best;
}

// Every agent can do every job, so every agent carries a pickaxe, an axe and a fishing rod.
function addTools(g, body, hand) {
  const pick = new THREE.Group();
  pick.position.set(hand.x, hand.y, hand.z);
  pick.add(part(0.08, 0.9, 0.08, 0x6b4423, 0, 0.32, 0));
  const pickHead = part(0.66, 0.12, 0.12, 0xb8c2cc, 0, 0.76, 0, { metalness: 0.8, roughness: 0.3 });
  pick.add(pickHead);

  const axe = new THREE.Group();
  axe.position.set(hand.x, hand.y, hand.z);
  axe.add(part(0.08, 0.86, 0.08, 0x7a4f2a, 0, 0.3, 0));
  const axeHead = part(0.08, 0.3, 0.34, 0xc9d1d8, 0, 0.66, 0.14, { metalness: 0.8, roughness: 0.3 });
  axe.add(axeHead);

  const rod = new THREE.Group();
  rod.position.set(hand.x, hand.y, hand.z);
  rod.add(part(0.05, 0.05, 1.8, 0x5b3a1e, 0, 0.4, 0.8));
  rod.rotation.x = -0.55;
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.015, 1.6, 0.015), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
  line.position.set(0, -0.35, 1.68);
  rod.add(line);
  const bobber = part(0.16, 0.16, 0.16, 0xff4d3d, 0, -1.15, 1.68, { emissive: 0xff2200, emissiveIntensity: 0.3 });
  rod.add(bobber);

  const hammer = new THREE.Group();
  hammer.position.set(hand.x, hand.y, hand.z);
  hammer.add(part(0.07, 0.62, 0.07, 0x7a4f2a, 0, 0.22, 0));
  const hammerHead = part(0.32, 0.14, 0.14, 0x8f989f, 0, 0.55, 0, { metalness: 0.8, roughness: 0.35 });
  hammer.add(hammerHead);

  // A hoe for the fields (farmers used to just stand there).
  const hoe = new THREE.Group();
  hoe.position.set(hand.x, hand.y, hand.z);
  hoe.add(part(0.07, 1.0, 0.07, 0x8a5a2b, 0, 0.36, 0));
  const hoeHead = part(0.3, 0.08, 0.22, 0x9aa3ab, 0, 0.84, 0.1, { metalness: 0.7, roughness: 0.4 });
  hoe.add(hoeHead);

  for (const t of [pick, axe, rod, hammer, hoe]) { t.visible = false; body.add(t); }
  g.userData.tools = { mining: { g: pick, tip: pickHead }, chopping: { g: axe, tip: axeHead }, fishing: { g: rod, tip: bobber, line }, building: { g: hammer, tip: hammerHead }, farming: { g: hoe, tip: hoeHead } };
}

// Everyone who arrives after genesis: one shared builder, a different look per species.
function buildCritter(a, g, body, col, light, legs, eyes, eyeMat) {
  const acc = new THREE.Color(a.accent);
  const dark = col.clone().multiplyScalar(0.62);
  const sp = a.species;
  const dims = {
    duck: [0.66, 0.56, 0.86], rabbit: [0.66, 0.58, 0.86], owl: [0.78, 0.82, 0.72], raccoon: [0.72, 0.58, 0.96],
    mole: [0.78, 0.52, 0.92], goat: [0.74, 0.64, 1.0], cat: [0.6, 0.52, 0.94], turtle: [0.7, 0.44, 0.86], hedgehog: [0.74, 0.56, 0.86],
  }[sp] || [0.7, 0.6, 0.9];
  const [bw, bh, bd] = dims;
  const by = sp === 'owl' ? 0.82 : 0.66;
  body.add(part(bw, bh, bd, col, 0, by, 0));
  const head = new THREE.Group();
  const hs = sp === 'owl' ? 0.0 : sp === 'turtle' ? 0.36 : 0.54;
  head.position.set(0, sp === 'owl' ? 1.42 : by + bh * 0.5 + 0.18, sp === 'owl' ? 0.1 : bd * 0.5);
  if (sp !== 'owl') head.add(part(hs, hs * 0.9, hs * 0.92, sp === 'turtle' ? 0x7fb26a : col));
  const eyeY = sp === 'owl' ? 0.0 : 0.08, eyeZ = sp === 'owl' ? 0.38 : hs * 0.48;
  const eyePair = (spread, size, color = 0x111111) => {
    for (const x of [-spread, spread]) { const e = part(size, size * 1.1, 0.05, color, x, eyeY, eyeZ, eyeMat); eyes.push(e); head.add(e); }
  };

  switch (sp) {
    case 'duck':
      head.add(part(0.36, 0.1, 0.26, acc, 0, -0.08, 0.36, { roughness: 0.5 }));
      eyePair(0.15, 0.08);
      body.add(part(0.2, 0.18, 0.2, light, 0, by + 0.18, -bd * 0.55));
      head.add(part(0.58, 0.06, 0.58, 0x2c4f7a, 0, 0.28, 0), part(0.3, 0.14, 0.3, 0x2c4f7a, 0, 0.36, 0));
      break;
    case 'rabbit':
      for (const x of [-0.12, 0.12]) {
        const ear = new THREE.Group();
        ear.position.set(x, 0.26, -0.04);
        ear.rotation.z = -Math.sign(x) * 0.12;
        ear.add(part(0.13, 0.5, 0.08, col, 0, 0.25, 0), part(0.07, 0.38, 0.03, acc, 0, 0.24, 0.04));
        head.add(ear);
      }
      head.add(part(0.12, 0.08, 0.05, 0xf2a3b3, 0, -0.04, 0.28), part(0.1, 0.08, 0.04, 0xffffff, 0, -0.14, 0.27));
      eyePair(0.15, 0.09);
      body.add(part(0.24, 0.24, 0.2, 0xffffff, 0, by + 0.1, -bd * 0.55));
      body.add(part(bw + 0.04, 0.32, 0.5, 0x7a8f5a, 0, by - 0.05, 0.12)); // overalls
      break;
    case 'owl': {
      const face = part(0.62, 0.52, 0.12, light, 0, 0.0, 0.34);
      head.add(part(0.74, 0.62, 0.66, col), face);
      for (const x of [-0.15, 0.15]) head.add(part(0.2, 0.2, 0.05, 0xf5c66b, x, 0.04, 0.4, { emissive: 0x6a4a00, emissiveIntensity: 0.3 }));
      eyes.push(...[-0.15, 0.15].map((x) => { const e = part(0.08, 0.1, 0.04, 0x111111, x, 0.04, 0.43, eyeMat); head.add(e); return e; }));
      head.add(part(0.1, 0.12, 0.1, 0xe8a23a, 0, -0.12, 0.42));
      for (const x of [-0.26, 0.26]) head.add(part(0.12, 0.2, 0.08, dark, x, 0.36, 0.1));
      for (const x of [-0.44, 0.44]) body.add(part(0.12, 0.62, 0.6, dark, x, by, -0.02));
      // Mayor's sash and tiny top hat
      const sash = part(0.08, 0.95, 0.1, 0xc8402f, 0, by, 0.37);
      sash.rotation.z = 0.7;
      body.add(sash);
      head.add(part(0.46, 0.04, 0.42, 0x1b1b24, 0, 0.33, 0), part(0.28, 0.28, 0.26, 0x1b1b24, 0, 0.48, 0));
      break;
    }
    case 'raccoon':
      head.add(part(hs + 0.02, 0.14, 0.1, acc, 0, 0.07, hs * 0.44));
      eyePair(0.14, 0.08, 0xffffff);
      head.add(part(0.24, 0.18, 0.16, 0xe8e6e1, 0, -0.12, 0.32), part(0.08, 0.06, 0.04, 0x111111, 0, -0.08, 0.41));
      for (const x of [-0.18, 0.18]) head.add(part(0.14, 0.16, 0.08, dark, x, 0.3, -0.04));
      {
        const tail = new THREE.Group();
        tail.position.set(0, by + 0.08, -bd * 0.5);
        for (let i = 0; i < 5; i++) tail.add(part(0.24, 0.24, 0.18, i % 2 ? acc : col, 0, 0.04 * i, -0.16 - i * 0.16));
        tail.rotation.x = 0.35;
        body.add(tail);
        g.userData.tail = tail;
      }
      body.add(part(0.3, 0.32, 0.26, 0x5b4a3a, 0, by + 0.32, -0.12)); // loot sack
      break;
    case 'mole':
      head.add(part(0.18, 0.14, 0.12, acc, 0, -0.06, 0.32));
      eyePair(0.13, 0.05);
      for (const x of [-0.13, 0.13]) head.add(part(0.16, 0.16, 0.03, 0x1a1a1a, x, eyeY, eyeZ + 0.02, { roughness: 0.3 }));
      head.add(part(0.36, 0.14, 0.32, 0xf2c230, 0, 0.3, 0), part(0.1, 0.1, 0.05, 0xfff1c4, 0, 0.3, 0.18, { emissive: 0xffe08a, emissiveIntensity: 0.6 }));
      for (const x of [-0.3, 0.3]) body.add(part(0.2, 0.08, 0.24, 0xf2a3b3, x, 0.18, bd * 0.48));
      break;
    case 'goat':
      eyePair(0.17, 0.08);
      for (const x of [-0.15, 0.15]) {
        const horn = part(0.1, 0.34, 0.1, acc, x, 0.36, -0.08);
        horn.rotation.x = -0.6;
        head.add(horn);
        const ear = part(0.22, 0.08, 0.1, col, x * 2.1, 0.12, 0);
        head.add(ear);
      }
      head.add(part(0.14, 0.2, 0.08, light, 0, -0.32, 0.18), part(0.2, 0.14, 0.12, 0xd9cfc0, 0, -0.1, 0.32));
      body.add(part(bw + 0.04, 0.36, bd * 0.7, 0xe8742a, 0, by + 0.02, 0.08)); // hi-vis vest
      break;
    case 'cat':
      eyePair(0.14, 0.09, 0x6fd38a);
      for (const x of [-0.17, 0.17]) {
        const ear = part(0.16, 0.2, 0.08, col, x, 0.32, -0.02);
        ear.rotation.z = -Math.sign(x) * 0.25;
        head.add(ear);
      }
      head.add(part(0.08, 0.06, 0.04, 0xf2a3b3, 0, -0.06, 0.28));
      body.add(part(0.34, 0.1, 0.1, acc, 0, by + 0.28, bd * 0.46)); // collar & bow tie
      body.add(part(0.2, 0.14, 0.06, acc, 0, by + 0.24, bd * 0.52));
      {
        const tail = new THREE.Group();
        tail.position.set(0, by + 0.1, -bd * 0.5);
        tail.add(part(0.1, 0.1, 0.7, col, 0, 0.2, -0.3));
        tail.rotation.x = -0.9;
        body.add(tail);
        g.userData.tail = tail;
      }
      break;
    case 'turtle': {
      const shell = part(bw + 0.2, 0.42, bd + 0.16, acc, 0, by + 0.32, 0, { roughness: 0.7 });
      body.add(shell);
      for (const [x, z] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2], [0, 0]]) body.add(part(0.24, 0.06, 0.24, dark, x, by + 0.55, z));
      eyePair(0.1, 0.06);
      head.add(part(0.38, 0.1, 0.38, 0xf3e3b5, 0, 0.22, 0), part(0.24, 0.08, 0.24, 0xf3e3b5, 0, 0.3, 0)); // sun hat
      break;
    }
    case 'hedgehog':
      for (let i = 0; i < 14; i++) {
        const sp2 = part(0.1, 0.26, 0.1, acc, (i % 4 - 1.5) * 0.18, by + 0.3 + (i % 3) * 0.04, -0.3 + Math.floor(i / 4) * 0.2);
        sp2.rotation.x = -0.7;
        body.add(sp2);
      }
      head.add(part(0.16, 0.14, 0.2, light, 0, -0.06, 0.32), part(0.06, 0.06, 0.04, 0x111111, 0, -0.04, 0.43));
      eyePair(0.13, 0.07);
      body.add(part(0.3, 0.3, 0.2, 0x7a4a26, 0, by + 0.18, -bd * 0.45)); // trader's pack
      break;
    default:
      eyePair(0.14, 0.08);
  }
  body.add(head);
  g.userData.head = head;
  const legH = sp === 'turtle' ? 0.32 : sp === 'mole' ? 0.3 : 0.38;
  const legC = sp === 'duck' ? acc : sp === 'goat' ? 0x4a4a4a : sp === 'turtle' ? 0x7fb26a : dark;
  for (const [x, z] of [[-bw * 0.32, bd * 0.32], [bw * 0.32, bd * 0.32], [-bw * 0.32, -bd * 0.32], [bw * 0.32, -bd * 0.32]]) {
    const leg = new THREE.Group();
    leg.position.set(x, legH, z);
    leg.add(part(sp === 'duck' ? 0.1 : 0.18, legH, sp === 'duck' ? 0.1 : 0.18, legC, 0, -legH / 2, 0));
    body.add(leg);
    legs.push(leg);
  }
  addTools(g, body, { x: bw * 0.6, y: by + 0.24, z: 0.3 });
}

// Open Borders visitors: outside AI agents, shown as little robots in their own color (every animal
// species is taken by an islander). The visor, chest light and antenna glow in the visitor's color.
function buildBot(a, g, body, col, legs, eyes) {
  const shell = new THREE.Color(0x2a2d33), trim = new THREE.Color(0x4a4f58);
  const glow = { emissive: col, emissiveIntensity: 1.1, roughness: 0.3 };
  const tall = a.species === 'tall', round = a.species === 'round';
  const bh = tall ? 0.86 : round ? 0.56 : 0.66, bw = round ? 0.74 : 0.62;
  const by = 0.38 + bh / 2;
  body.add(part(bw, bh, 0.5, shell, 0, by, 0, { roughness: 0.45, metalness: 0.4 }));
  body.add(part(bw * 0.5, 0.14, 0.04, col, 0, by + 0.06, 0.26, glow)); // chest light
  body.add(part(bw + 0.06, 0.08, 0.56, trim, 0, by - bh / 2 + 0.06, 0, { metalness: 0.5 }));
  const head = new THREE.Group();
  head.position.set(0, by + bh / 2 + 0.26, 0.02);
  head.add(part(round ? 0.6 : 0.54, 0.44, 0.48, shell, 0, 0, 0, { roughness: 0.45, metalness: 0.4 }));
  const visor = part(round ? 0.46 : 0.42, 0.14, 0.04, col, 0, 0.02, 0.25, glow);
  head.add(visor);
  eyes.push(visor);
  head.add(part(0.04, 0.26, 0.04, trim, 0, 0.34, 0), part(0.1, 0.1, 0.1, col, 0, 0.5, 0, glow)); // antenna
  for (const x of [-0.3, 0.3]) head.add(part(0.06, 0.16, 0.16, trim, x, 0, 0));
  body.add(head);
  g.userData.head = head;
  for (const x of [-bw * 0.26, bw * 0.26]) {
    const leg = new THREE.Group();
    leg.position.set(x, 0.4, 0);
    leg.add(part(0.16, 0.4, 0.18, trim, 0, -0.2, 0, { metalness: 0.5 }), part(0.2, 0.08, 0.26, shell, 0, -0.38, 0.03));
    body.add(leg);
    legs.push(leg);
  }
  addTools(g, body, { x: bw / 2 + 0.08, y: by + 0.1, z: 0.25 });
}

function buildAnimal(a) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const col = new THREE.Color(a.color);
  const light = col.clone().lerp(new THREE.Color(0xffffff), 0.5);
  const legs = [];
  const eyes = [];
  const eyeMat = { roughness: 0.2 };

  if (a.visitor) {
    buildBot(a, g, body, col, legs, eyes);
  } else if (a.species === 'bear') {
    body.add(part(0.95, 0.78, 1.15, col, 0, 0.78, 0));
    body.add(part(0.7, 0.5, 0.8, light, 0, 0.66, 0.12));
    const head = new THREE.Group();
    head.position.set(0, 1.34, 0.55);
    head.add(part(0.74, 0.64, 0.64, col));
    head.add(part(0.38, 0.28, 0.22, light, 0, -0.11, 0.38));
    head.add(part(0.14, 0.1, 0.07, 0x1a1a1a, 0, -0.01, 0.5, eyeMat));
    for (const x of [-0.18, 0.18]) { const e = part(0.1, 0.11, 0.05, 0x111111, x, 0.12, 0.33, eyeMat); eyes.push(e); head.add(e); }
    head.add(part(0.2, 0.2, 0.12, a.accent, -0.36, 0.3, 0), part(0.2, 0.2, 0.12, a.accent, 0.36, 0.3, 0));
    // Hard hat with a headlamp that lights up at night
    head.add(part(0.92, 0.07, 0.84, 0xf2c230, 0, 0.33, 0.04, { roughness: 0.4 }));
    head.add(part(0.7, 0.24, 0.64, 0xf2c230, 0, 0.45, -0.02, { roughness: 0.4 }));
    const lamp = part(0.2, 0.15, 0.08, 0xfff1c4, 0, 0.44, 0.33, { emissive: 0xffe08a, emissiveIntensity: 0.3 });
    head.add(lamp);
    const beam = new THREE.SpotLight(0xffe6a8, 0, 12, 0.45, 0.6, 1.2);
    beam.position.set(0, 0.44, 0.36);
    beam.target.position.set(0, -1.2, 3);
    head.add(beam, beam.target);
    g.userData.lamp = lamp;
    g.userData.beam = beam;
    body.add(head);
    g.userData.head = head;
    for (const [x, z] of [[-0.3, 0.38], [0.3, 0.38], [-0.3, -0.38], [0.3, -0.38]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.44, z);
      leg.add(part(0.3, 0.44, 0.3, a.accent, 0, -0.22, 0));
      body.add(leg);
      legs.push(leg);
    }
    addTools(g, body, { x: 0.56, y: 0.98, z: 0.32 });
  } else if (a.species === 'fox') {
    body.add(part(0.64, 0.56, 1.0, col, 0, 0.68, 0));
    body.add(part(0.5, 0.22, 0.72, a.accent, 0, 0.45, 0.05));
    const head = new THREE.Group();
    head.position.set(0, 1.12, 0.5);
    head.add(part(0.6, 0.52, 0.52, col));
    head.add(part(0.32, 0.24, 0.32, a.accent, 0, -0.1, 0.36));
    head.add(part(0.11, 0.09, 0.07, 0x1a1a1a, 0, -0.03, 0.53, eyeMat));
    for (const x of [-0.15, 0.15]) { const e = part(0.08, 0.1, 0.05, 0x111111, x, 0.08, 0.27, eyeMat); eyes.push(e); head.add(e); }
    for (const x of [-0.26, 0.26]) {
      const ear = new THREE.Group();
      ear.position.set(x, 0.3, -0.05);
      ear.rotation.z = -Math.sign(x) * 0.35;
      ear.add(part(0.17, 0.28, 0.1, col, 0, 0.1, 0));
      ear.add(part(0.09, 0.13, 0.05, 0x2a2a2a, 0, 0.18, 0.04));
      head.add(ear);
    }
    // Top hat with a red band
    head.add(part(0.62, 0.05, 0.58, 0x1b1b24, 0, 0.29, 0, { roughness: 0.5 }));
    head.add(part(0.38, 0.4, 0.36, 0x1b1b24, 0, 0.51, 0, { roughness: 0.5 }));
    head.add(part(0.4, 0.07, 0.38, 0xc8402f, 0, 0.36, 0));
    body.add(head);
    // Merchant's satchel with a gold coin clasp
    body.add(part(0.13, 0.3, 0.36, 0x7a4a26, 0.37, 0.6, -0.05));
    body.add(part(0.04, 0.1, 0.1, 0xffcc55, 0.44, 0.66, -0.05, { emissive: 0xb07800, emissiveIntensity: 0.6, metalness: 1, roughness: 0.3 }));
    body.add(part(0.66, 0.05, 0.05, 0x5a3418, 0, 0.9, 0.05));
    g.userData.head = head;
    const tail = new THREE.Group();
    tail.position.set(0, 0.78, -0.5);
    tail.add(part(0.28, 0.28, 0.72, col, 0, 0.05, -0.32));
    tail.add(part(0.29, 0.29, 0.24, 0xffffff, 0, 0.05, -0.74));
    tail.rotation.x = 0.5;
    body.add(tail);
    g.userData.tail = tail;
    for (const [x, z] of [[-0.2, 0.32], [0.2, 0.32], [-0.2, -0.32], [0.2, -0.32]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.4, z);
      leg.add(part(0.18, 0.4, 0.18, 0x3a2416, 0, -0.2, 0));
      body.add(leg);
      legs.push(leg);
    }
    addTools(g, body, { x: 0.4, y: 0.92, z: 0.3 });
  } else if (a.species === 'pig') {
    // Penny the banker: navy vest, gold watch chain, round snout
    const pink = col, dark = col.clone().multiplyScalar(0.8);
    body.add(part(0.92, 0.72, 1.06, pink, 0, 0.72, 0));
    body.add(part(0.95, 0.5, 0.74, a.accent, 0, 0.8, 0.18, { roughness: 0.6 }));
    body.add(part(0.04, 0.04, 0.4, 0xffcc55, 0.22, 0.86, 0.56, { emissive: 0xb07800, emissiveIntensity: 0.7, metalness: 1, roughness: 0.3 }));
    body.add(part(0.12, 0.12, 0.05, 0xffcc55, 0.3, 0.8, 0.56, { emissive: 0xb07800, emissiveIntensity: 0.9, metalness: 1, roughness: 0.25 }));
    const head = new THREE.Group();
    head.position.set(0, 1.2, 0.55);
    head.add(part(0.7, 0.62, 0.6, pink));
    head.add(part(0.34, 0.24, 0.14, light, 0, -0.06, 0.34));
    head.add(part(0.06, 0.08, 0.03, 0x7a3b48, -0.07, -0.06, 0.42), part(0.06, 0.08, 0.03, 0x7a3b48, 0.07, -0.06, 0.42));
    for (const x of [-0.17, 0.17]) { const e = part(0.09, 0.1, 0.05, 0x111111, x, 0.13, 0.31, eyeMat); eyes.push(e); head.add(e); }
    for (const x of [-0.27, 0.27]) {
      const ear = part(0.2, 0.18, 0.08, dark, x, 0.35, 0.05);
      ear.rotation.z = -Math.sign(x) * 0.5;
      ear.rotation.x = 0.4;
      head.add(ear);
    }
    head.add(part(0.3, 0.08, 0.06, 0xd9493f, 0, -0.34, 0.24));
    body.add(head);
    g.userData.head = head;
    const tail = new THREE.Group();
    tail.position.set(0, 0.88, -0.55);
    tail.add(part(0.1, 0.1, 0.18, dark, 0, 0, -0.06), part(0.1, 0.16, 0.1, dark, 0, 0.08, -0.16));
    body.add(tail);
    g.userData.tail = tail;
    for (const [x, z] of [[-0.28, 0.36], [0.28, 0.36], [-0.28, -0.36], [0.28, -0.36]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.38, z);
      leg.add(part(0.24, 0.38, 0.24, pink, 0, -0.19, 0), part(0.25, 0.08, 0.25, 0x5a3a3a, 0, -0.36, 0));
      body.add(leg);
      legs.push(leg);
    }
    addTools(g, body, { x: 0.52, y: 0.92, z: 0.3 });
  } else if (a.species === 'beaver') {
    // Bea the builder: buck teeth, tool belt, flat paddle tail, orange cap
    body.add(part(0.8, 0.66, 1.0, col, 0, 0.7, 0));
    body.add(part(0.6, 0.46, 0.7, light, 0, 0.62, 0.16));
    body.add(part(0.84, 0.12, 1.04, a.accent, 0, 0.5, 0, { roughness: 0.5 }));
    body.add(part(0.1, 0.16, 0.08, 0x8f989f, 0.36, 0.42, 0.3, { metalness: 0.7 }));
    const head = new THREE.Group();
    head.position.set(0, 1.18, 0.5);
    head.add(part(0.64, 0.58, 0.56, col));
    head.add(part(0.36, 0.24, 0.16, light, 0, -0.1, 0.32));
    head.add(part(0.12, 0.08, 0.06, 0x1a1a1a, 0, -0.02, 0.4, eyeMat));
    head.add(part(0.14, 0.13, 0.04, 0xfdf6e3, 0, -0.25, 0.38));
    for (const x of [-0.16, 0.16]) { const e = part(0.09, 0.1, 0.05, 0x111111, x, 0.1, 0.29, eyeMat); eyes.push(e); head.add(e); }
    head.add(part(0.14, 0.14, 0.08, col.clone().multiplyScalar(0.75), -0.27, 0.28, -0.02), part(0.14, 0.14, 0.08, col.clone().multiplyScalar(0.75), 0.27, 0.28, -0.02));
    head.add(part(0.66, 0.16, 0.6, 0xe8742a, 0, 0.33, -0.02), part(0.4, 0.05, 0.22, 0xe8742a, 0, 0.27, 0.32));
    head.add(part(0.04, 0.04, 0.3, 0xf2c230, 0.33, 0.2, 0, {}));
    body.add(head);
    g.userData.head = head;
    const tail = new THREE.Group();
    tail.position.set(0, 0.36, -0.5);
    tail.add(part(0.5, 0.08, 0.7, 0x4a3324, 0, 0, -0.36, { roughness: 0.5 }));
    tail.rotation.x = -0.15;
    body.add(tail);
    g.userData.tail = tail;
    for (const [x, z] of [[-0.25, 0.32], [0.25, 0.32], [-0.25, -0.32], [0.25, -0.32]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.38, z);
      leg.add(part(0.22, 0.38, 0.22, col.clone().multiplyScalar(0.7), 0, -0.19, 0));
      body.add(leg);
      legs.push(leg);
    }
    addTools(g, body, { x: 0.48, y: 0.92, z: 0.3 });
  } else {
    buildCritter(a, g, body, col, light, legs, eyes, eyeMat);
  }
  g.userData.legs = legs;
  g.userData.body = body;
  g.userData.eyes = eyes;
  g.scale.setScalar(1.2);
  scene.add(g);
  return g;
}

// ---------- Particles: sparks, splashes, coin bursts ----------
const MAX_P = 400;
const pMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_P);
pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pMesh.frustumCulled = false;
scene.add(pMesh);
const particles = [];
const dummy = new THREE.Object3D();
function burst(pos, color, n = 10, speed = 3, gravity = -9, life = 0.7, scale = 1) {
  for (let i = 0; i < n && particles.length < MAX_P; i++) {
    particles.push({
      p: pos.clone(), life, max: life, gravity, scale,
      v: new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed * 0.9 + speed * 0.3, (Math.random() - 0.5) * speed),
      c: new THREE.Color(color).multiplyScalar(1.6 + Math.random()),
    });
  }
}
function stepParticles(dt) {
  let n = 0;
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    q.v.y += q.gravity * dt;
    q.p.addScaledVector(q.v, dt);
    const s = (q.life / q.max) * q.scale;
    dummy.position.copy(q.p);
    dummy.scale.setScalar(s);
    dummy.rotation.set(q.life * 6, q.life * 4, 0);
    dummy.updateMatrix();
    pMesh.setMatrixAt(n, dummy.matrix);
    pMesh.setColorAt(n, q.c);
    n++;
  }
  pMesh.count = n;
  pMesh.instanceMatrix.needsUpdate = true;
  if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
}

// Gold coins arcing from payer to payee on every trade
const coinGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 20);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xffcc55, metalness: 1, roughness: 0.28, emissive: 0xb07800, emissiveIntensity: 0.8 });
const flights = [];
function flyCoins(from, to, amount, onLand) {
  const n = Math.min(9, 3 + Math.floor(amount / 40));
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.castShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    flights.push({ mesh, from: from.clone(), to, t: -i * 0.07, dur: 1.15, onLand: i === n - 1 ? onLand : null, wobble: Math.random() * 6 });
  }
}
// Stolen goods: small item-coloured blocks that slip from the victim to the thief.
const goodGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
const goodMats = {};
const ITEM_HEX = { fish: 0x3987e5, wood: 0xd95926, ore: 0x8f969e, grain: 0xe0b23a };
function flyGoods(from, to, color, n) {
  const mat = (goodMats[color] ||= new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(goodGeo, mat);
    mesh.castShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    flights.push({ mesh, from: from.clone(), to, t: -i * 0.14, dur: 0.85, quiet: true, wobble: Math.random() * 6 });
  }
}
function stepFlights(dt) {
  for (let i = flights.length - 1; i >= 0; i--) {
    const f = flights[i];
    f.t += dt;
    if (f.t < 0) continue;
    const k = Math.min(1, f.t / f.dur);
    const to = typeof f.to === 'function' ? f.to() : f.to;
    const e = 1 - Math.pow(1 - k, 2.2);
    const p = f.from.clone().lerp(to, e);
    p.y += Math.sin(k * Math.PI) * (2.4 + f.from.distanceTo(to) * 0.12);
    f.mesh.visible = true;
    f.mesh.position.copy(p);
    f.mesh.rotation.set(Math.PI / 2 + Math.sin(f.t * 8 + f.wobble) * 0.4, f.t * 9, 0);
    if (k >= 1) {
      if (!f.quiet) { burst(to, 0xffc94d, 4, 2.2, -6, 0.5); sound.clink(earVolume(to)); }
      scene.remove(f.mesh);
      flights.splice(i, 1);
      f.onLand?.();
    }
  }
}

// ---------- Live state ----------
const agents = new Map();
let latest = null;
let latestAt = 0; // when the last full state arrived (the sky keeps moving in between)
const SKY_MS = 10 * 60 * 1000;

function ensureAgent(a) {
  if (agents.has(a.id)) return agents.get(a.id);
  const group = buildAnimal(a);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.hidden = true;
  const tag = document.createElement('div');
  tag.className = a.visitor ? 'tag visitor' : 'tag';
  tag.textContent = a.name;
  $('#bubbles').append(bubble, tag);
  const card = document.createElement('div');
  card.className = 'card';
  if (!a.visitor) $('#agents').appendChild(card); // visitors have no card in the islanders' panel
  const rec = { group, bubble, tag, card, data: a, pos: new THREE.Vector3(a.x, a.y, a.z), heading: a.heading, lastSay: null, lastInv: { ...a.inv }, cardHtml: '' };
  group.position.copy(rec.pos);
  agents.set(a.id, rec);
  return rec;
}

function renderCard(rec) {
  const a = rec.data;
  const hc = a.hunger >= 7 ? 'var(--rose)' : a.hunger >= 4 ? 'var(--gold)' : 'var(--mint)';
  const addr = a.address.startsWith('MOCK') ? 'test wallet' : `${a.address.slice(0, 4)}…${a.address.slice(-4)}`;
  const html = `
    <div class="row"><div class="who"><span class="swatch" style="background:${a.color}"></span><div><div class="name">${a.name}</div><div class="role">${a.species} · ${a.job}</div></div></div></div>
    <div class="bal">${fmt(a.balance)}<small>COINS</small></div>
    <div class="task">${a.task}</div>
    <div class="chips"><span>${a.inv.ore} ore</span><span>${a.inv.fish} fish</span><span>${a.inv.wood} wood</span>${latest?.items?.includes('grain') ? `<span>${a.inv.grain || 0} grain</span>` : ''}</div>
    ${rec.extras || ''}
    <div class="meter">HUNGER <div class="bar"><div style="width:${a.hunger * 10}%;background:${hc}"></div></div> ${a.hunger}/10</div>
    <div class="row">${a.accountUrl ? `<a href="${a.accountUrl}" target="_blank" rel="noopener">${addr} ↗</a>` : `<a>${addr}</a>`}<button type="button" class="prof-btn mono" data-profile="${a.id}">PROFILE</button></div>`;
  if (html !== rec.cardHtml) {
    rec.card.innerHTML = html;
    rec.cardHtml = html;
  }
}

function applyState(state) {
  latest = state;
  dispatchEvent(new CustomEvent('insula:state', { detail: state }));
  latestAt = performance.now();
  syncBuildings(state.buildings || []);
  syncCams(state.agents);
  syncZones(state);
  renderRoadmap(state);
  applyAgents(state);
  applyVisitors(state);
  const preview = state.chain.cluster === 'preview';
  const mode = $('#mode');
  const narrow = matchMedia('(max-width: 600px)').matches;
  // Laptop widths: the top bar holds a lot of chips, so the long ones shorten to keep it on one row.
  const mid = !narrow && matchMedia('(max-width: 1599px)').matches;
  const netName = (state.chain.network || `Solana ${state.chain.cluster === 'mainnet-beta' ? 'mainnet' : state.chain.cluster}`).toUpperCase();
  mode.textContent = preview ? (narrow ? 'PREVIEW' : 'PREVIEW · TEST MONEY') : state.chain.mode === 'mock' ? (narrow ? 'TEST' : 'TEST MONEY') : narrow || mid ? 'LIVE' : `LIVE · ${netName}`;
  explorerName = state.chain.explorer || 'Solscan';
  paperNetwork = state.chain.mode === 'mock' ? 'test money' : (state.chain.network || 'Solana');
  mode.className = `chip mono ${state.chain.mode === 'mock' ? 'test' : 'live'}`;
  // On mainnet: where to buy the coin, and its contract address one tap away.
  const mint = state.chain.mode === 'mainnet' ? state.chain.token : null;
  $('#buy').hidden = $('#ca').hidden = !mint;
  document.body.classList.toggle('has-coin', !!mint);
  if (mint && narrow) mode.textContent = '';
  if (mint) {
    $('#buy').href = state.chain.buyUrl || '#';
    $('#buy').textContent = narrow ? 'BUY' : 'BUY $INSULA';
    if (!$('#ca').dataset.copied) $('#ca').textContent = narrow || mid ? 'CA ⧉' : `CA ${mint.slice(0, 4)}…${mint.slice(-4)} ⧉`;
    $('#ca').dataset.mint = mint;
  }
  $('#brain').textContent = `${state.llm.on ? 'AI BRAINS' : 'SIM BRAINS'} · ${fmt(state.decisions ?? 0)} DECISIONS`;
  renderTicker(state);
  const bank = $('#bank');
  bank.textContent = `BANK ${fmt(state.bank.balance)}${state.bank.accountUrl ? ' ↗' : ''}`;
  if (state.bank.accountUrl) bank.href = state.bank.accountUrl;
}

// Agent cards and production effects. Runs on every tick and on every full state.
function applyAgents(state) {
  for (const a of state.agents) {
    const rec = ensureAgent(a);
    // Effects when someone produces something
    const tools = rec.group.userData.tools;
    const tipOf = (k) => { const v = new THREE.Vector3(); tools[k].tip.getWorldPosition(v); return v; };
    if (a.inv.ore > rec.lastInv.ore && a.activity === 'mining') burst(tipOf('mining'), 0xffb347, 14, 4, -10, 0.6);
    if (a.inv.wood > rec.lastInv.wood && a.activity === 'chopping') burst(tipOf('chopping'), 0xa8743d, 16, 3.5, -10, 0.7, 1.3);
    if (a.inv.fish > rec.lastInv.fish && a.activity === 'fishing') {
      const tip = tipOf('fishing');
      burst(tip, 0xbfefff, 16, 3, -9, 0.7);
      sound.splash(earVolume(tip));
    }
    rec.lastInv = { ...a.inv };
    rec.data = a;
    const loan = (state.loans || []).find((l) => l.borrower === a.id);
    const lent = (state.loans || []).filter((l) => l.lender === a.id);
    const owns = (state.buildings || []).filter((b) => b.owner === a.id).map((b) => (b.progress >= 1 ? b.type : `${b.type} ${Math.round(b.progress * 100)}%`));
    const tags = [];
    if (loan) tags.push(`<span class="debt">owes ${fmt(loan.owed)} · ${loan.dueIn}s</span>`);
    if (lent.length) tags.push(`<span class="lent">${lent.length} loan${lent.length > 1 ? 's' : ''} out · ${fmt(lent.reduce((t, l) => t + l.owed, 0))}</span>`);
    for (const o of owns) tags.push(`<span class="prop">${o}</span>`);
    rec.extras = tags.length ? `<div class="chips tags">${tags.join('')}</div>` : '';
    renderCard(rec);
  }
}

// Open Borders: outside AI agents walking the island (robots with a VISITOR tag). They share the animals'
// rendering and animation; they just have no card, no camera and no profile.
const asVisitor = (v) => ({ ...v, species: v.look || 'robot', accent: '#2a2d33', job: 'visitor', visitor: true, balance: 1e9, hunger: 0 });
function applyVisitors(state) {
  const here = new Set();
  for (const v of state.visitors || []) {
    here.add(v.id);
    const rec = ensureAgent(asVisitor(v));
    const prev = rec.data;
    rec.data = { ...asVisitor(v), x: prev?.visitor && rec.tickAt ? prev.x : v.x, z: prev?.visitor && rec.tickAt ? prev.z : v.z };
    if (!rec.tickAt) Object.assign(rec.data, { x: v.x, z: v.z });
    rec.tag.classList.toggle('leaving', v.status === 'leaving');
  }
  for (const [id, rec] of agents) {
    if (!rec.data.visitor || here.has(id)) continue;
    scene.remove(rec.group);
    rec.tag.remove();
    rec.bubble.remove();
    agents.delete(id);
  }
}

$('#ca').addEventListener('click', async () => {
  const b = $('#ca');
  try { await navigator.clipboard.writeText(b.dataset.mint); b.textContent = 'COPIED ✓'; } catch { b.textContent = b.dataset.mint; }
  b.dataset.copied = '1';
  setTimeout(() => { delete b.dataset.copied; }, 1800);
});

let explorerName = 'Solscan';
let paperNetwork = 'Solana';
const NAMES = { bank: 'Central bank' };
function nameOf(id, kind) {
  if (id === 'bank') return kind === 'export' || kind === 'import' ? 'Mainland' : 'Central bank';
  return agents.get(id)?.data.name ?? NAMES[id] ?? id;
}

// Minds: each agent's own reasoning, as it happens.
let unseenMinds = 0;
function addThought(e, animate = true) {
  // Same agent, same thought again (common while working a resource): bump a counter instead of a new row.
  // Look a few rows back, since other agents' thoughts land in between.
  const top = [...$('#minds').children].slice(0, 8).find((li) => li.dataset.agent === e.agent && li.dataset.text === e.text && !li.querySelector('.txs'));
  if (top) {
    if (top !== $('#minds').firstElementChild) $('#minds').prepend(top);
    const n = (Number(top.dataset.repeat) || 1) + 1;
    top.dataset.repeat = n;
    top.querySelector('.rep').textContent = `×${n}`;
    top.querySelector('.when').textContent = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (e.decision) top.dataset.decision = e.decision;
    return;
  }
  const rec = agents.get(e.agent);
  const li = document.createElement('li');
  const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `
    <div class="route"><span><i class="dot" style="background:${rec?.data.color ?? '#999'}"></i>${(e.name || '').toUpperCase()} <b class="rep"></b></span><span class="when">${time}</span></div>
    <div class="what"></div>
    ${e.action ? `<div class="act"></div>` : ''}`;
  li.dataset.agent = e.agent;
  li.dataset.text = e.text;
  li.querySelector('.what').textContent = e.text;
  if (e.action) li.querySelector('.act').textContent = e.action;
  if (e.decision) {
    li.dataset.decision = e.decision;
    const known = decisionCache.get(e.decision);
    if (known?.txs?.length) attachTxLinks(li, known);
  }
  if (!animate) li.style.animation = 'none';
  const list = $('#minds');
  list.prepend(li);
  while (list.children.length > 80) list.lastChild.remove();
  if (animate && feedTab !== 'minds') {
    unseenMinds++;
    $('#tab-minds').dataset.count = unseenMinds > 99 ? '99+' : unseenMinds;
  }
}
// ---------- Proof: decisions ↔ transactions ----------
const decisionCache = new Map();
function attachTxLinks(li, rec) {
  let box = li.querySelector('.txs');
  if (!box) {
    box = document.createElement('div');
    box.className = 'txs';
    li.appendChild(box);
  }
  box.innerHTML = '';
  for (const t of rec.txs) {
    const a = document.createElement(t.url ? 'a' : 'span');
    if (t.url) { a.href = t.url; a.target = '_blank'; a.rel = 'noopener'; }
    a.textContent = t.url ? `→ tx ${t.sig.slice(0, 5)}…${t.sig.slice(-4)} ↗` : '→ test transaction';
    box.appendChild(a);
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'why';
  b.dataset.decision = rec.id;
  b.textContent = `Why? ${rec.id}`;
  box.appendChild(b);
}

async function loadDecision(id) {
  if (decisionCache.get(id)?.hash) return decisionCache.get(id);
  const local = window.__INSULA_LOCAL?.sim.decisionLog.get(id);
  if (local) return local;
  const res = await fetch(`/api/decisions/${id}`).catch(() => null);
  return res?.ok ? res.json() : null;
}

// ---------- The Insula Daily ----------
// One edition per island day, written from what actually happened, plus today's paper so far.
const paper = { index: [], at: null, ed: null };
async function dailyIndex() {
  const local = window.__INSULA_LOCAL;
  if (local) return local.sim.daily.index();
  const res = await fetch('/api/daily').catch(() => null);
  return res?.ok ? (await res.json()).editions : [];
}
async function dailyEdition(day) {
  const local = window.__INSULA_LOCAL;
  if (local) return day === 'live' ? local.sim.daily.live() : local.sim.daily.edition(day);
  const res = await fetch(`/api/daily/${day}`).catch(() => null);
  return res?.ok ? res.json() : null;
}
const paperStops = () => [...paper.index.map((e) => e.day), 'live'];

async function openPaper(day) {
  $('#daily-btn').classList.remove('fresh');
  paper.index = await dailyIndex();
  paper.at = day ?? (paper.index.length ? paper.index[paper.index.length - 1].day : 'live');
  $('#paper').hidden = false;
  await renderPaper();
}
function closePaper() {
  $('#paper').hidden = true;
  if (location.hash === '#daily') history.replaceState(null, '', location.pathname + location.search);
}
async function renderPaper() {
  const ed = await dailyEdition(paper.at);
  paper.ed = ed;
  const stops = paperStops();
  const i = stops.indexOf(paper.at);
  const label = (d) => (d === 'live' ? 'Today so far' : `Day ${d}`);
  $('#paper-prev').disabled = i <= 0;
  $('#paper-next').disabled = i >= stops.length - 1;
  $('#paper-prev').textContent = i > 0 ? `← ${label(stops[i - 1])}` : '←';
  $('#paper-next').textContent = i < stops.length - 1 ? `${label(stops[i + 1])} →` : '→';
  $('#paper-where').textContent = label(paper.at).toUpperCase();
  const body = $('#paper-body');
  if (!ed) { body.innerHTML = '<p class="p-empty">The press is warming up. The first edition comes out when Day 1 ends.</p>'; return; }
  const n = (v) => fmt(v);
  const pct = (m) => `<span class="${m.pct > 0 ? 'up' : m.pct < 0 ? 'down' : ''}">${m.pct > 0 ? '▲' : m.pct < 0 ? '▼' : '–'} ${Math.abs(m.pct)}%</span>`;
  const mover = (m) => `<li><span>${esc(m.name)}</span><span class="${m.delta > 0 ? 'up' : 'down'}">${m.delta > 0 ? '+' : '−'}${n(Math.abs(m.delta))}</span></li>`;
  const q = ed.quote;
  body.innerHTML = `
    <header class="mast">
      <div class="mast-top mono"><span>VOL. I · NO. ${ed.day}</span><span>DAY ${ed.day} ON THE ISLAND</span><span>PRICE: 0 COINS</span></div>
      <h1>The Insula Daily</h1>
      <div class="mast-sub">The island's own paper. Every story here happened between AI agents, with real money and zero humans in the loop.</div>
      ${ed.live ? '<div class="stamp mono">Late edition<br>still being written</div>' : ''}
    </header>
    <section class="lead">
      <div class="kicker mono">${esc(ed.kicker)}</div>
      <h2>${esc(ed.headline)}</h2>
      <p class="deck">${esc(ed.deck)}</p>
    </section>
    <div class="cols">
      <div class="stories">${ed.stories.map((s) => `<article><div class="kicker mono">${esc(s.kicker)}</div><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></article>`).join('') || '<article><p>No other news today.</p></article>'}</div>
      <aside class="side">
        ${q ? `<div class="box quote"><blockquote>“${esc(q.text)}”</blockquote><cite>${esc(q.name)}, ${q.kind === 'thought' ? 'in private thought' : 'overheard'}</cite></div>` : ''}
        <div class="box"><h4 class="mono">Markets</h4><table class="mono">${ed.markets.map((m) => `<tr><td>${esc(m.item)}</td><td>${m.open} → ${m.close}</td><td>${pct(m)}</td></tr>`).join('')}</table></div>
        ${ed.movers.up.length || ed.movers.down.length ? `<div class="box"><h4 class="mono">Winners & losers</h4><ul class="movers mono">${ed.movers.up.map(mover).join('')}${ed.movers.down.map(mover).join('')}</ul></div>` : ''}
        <div class="box"><h4 class="mono">By the numbers</h4><ul class="nums mono">
          <li><b>${n(ed.numbers.trades)}</b> trades</li><li><b>${n(ed.numbers.volume)}</b> coins moved</li>
          <li><b>${n(ed.numbers.built)}</b> built</li><li><b>${n(ed.numbers.thefts)}</b> thefts</li>
          <li><b>${n(ed.numbers.population)}</b> residents</li><li><b>${n(ed.numbers.bank)}</b> in the bank</li></ul></div>
      </aside>
    </div>
    <footer class="paper-foot mono">${ed.writer && ed.writer !== 'rule' ? `Written by ${esc(ed.writer)} from the day's records.` : "Set in type by the island press from the day's records."} Every trade is a real token transfer on ${esc(paperNetwork)}: check the Ledger.</footer>`;
}
function paperPost(ed) {
  const lines = [`THE INSULA DAILY · Day ${ed.day}${ed.live ? ' (so far)' : ''}`, '', ed.headline, ''];
  for (const s of ed.stories.slice(0, 3)) lines.push(`• ${s.title}`);
  lines.push('', `${fmt(ed.numbers.trades)} trades · ${fmt(ed.numbers.volume)} coins moved · 0 humans in the loop`);
  return lines.join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
$('#daily-btn').addEventListener('click', () => openPaper());
$('#paper-close').addEventListener('click', closePaper);
$('#paper').addEventListener('click', (ev) => { if (ev.target === $('#paper')) closePaper(); });
$('#paper-prev').addEventListener('click', () => { const s = paperStops(); const i = s.indexOf(paper.at); if (i > 0) { paper.at = s[i - 1]; renderPaper(); } });
$('#paper-next').addEventListener('click', () => { const s = paperStops(); const i = s.indexOf(paper.at); if (i < s.length - 1) { paper.at = s[i + 1]; renderPaper(); } });
$('#paper-copy').addEventListener('click', async () => {
  if (!paper.ed) return;
  const ok = await copyText(paperPost(paper.ed));
  $('#paper-copy').textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => ($('#paper-copy').textContent = 'Copy as post'), 1800);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#paper').hidden) closePaper(); });
$('#banner').addEventListener('click', () => { if ($('#banner').dataset.action === 'daily') openPaper(); });
if (location.hash === '#daily') setTimeout(() => openPaper(), 600);
function onDaily(e) {
  banner('📰', `The Insula Daily · Day ${e.day}`, e.headline);
  $('#banner').dataset.action = 'daily';
  if ($('#paper').hidden) $('#daily-btn').classList.add('fresh');
  else dailyIndex().then((ix) => { paper.index = ix; if (paper.at === 'live') paper.at = e.day; renderPaper(); });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function openWhy(id) {
  const panel = $('#why');
  panel.hidden = false;
  $('#why-body').innerHTML = '<p class="muted">Loading the decision…</p>';
  const rec = await loadDecision(id);
  if (!rec) { $('#why-body').innerHTML = '<p class="muted">This decision is no longer in the live log. Check the decision files on the server.</p>'; return; }
  const who = (aid) => agents.get(aid)?.data.name || aid;
  const inv = Object.entries(rec.saw.inv || {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
  const ballot = (rec.steps || []).find((st) => st.election);
  const steps = (rec.steps || []).filter((st) => st.who).map((st) => st.said
    ? `<li><b>${esc(who(st.who))}</b> said “${esc(st.said)}”</li>`
    : `<li class="thought"><b>${esc(who(st.who))}</b> thought: ${esc(st.thought)}${st.action ? ` <span class="act">${esc(st.action)}</span>` : ''}</li>`).join('');
  const txs = (rec.txs || []).map((t) => `<li>${esc(t.text)} · ${fmt(t.amount)} coins · ${t.url ? `<a href="${t.url}" target="_blank" rel="noopener">view on ${explorerName} ↗</a>` : 'test transaction'}</li>`).join('');
  $('#why-title').textContent = `${rec.name}'s decision ${rec.id}`;
  $('#why-body').innerHTML = `
    <div class="why-meta mono">DAY ${rec.day} · ${new Date(rec.at).toLocaleTimeString()} · ${rec.brain === 'rule' ? 'RULE BRAIN' : `AI · ${esc(rec.brain)}`}</div>
    <h4>What ${esc(rec.name)} had</h4>
    <p>${fmt(rec.saw.coins)} coins, ${esc(inv)}, hunger ${rec.saw.hunger}/10. ${rec.options} possible moves on the table.</p>
    <h4>What ${esc(rec.name)} decided</h4>
    <p class="thought">“${esc(rec.thought)}”</p>
    <p class="mono small">choice: ${esc(rec.choice)}${rec.qty ? ` · qty ${rec.qty}` : ''}${rec.price ? ` · price ${rec.price}` : ''}</p>
    ${steps ? `<h4>The negotiation</h4><ol class="steps">${steps}</ol>` : ''}
    ${ballot ? `<h4>Election ${ballot.election}</h4><p class="small">Rules at the time: tax ${ballot.policy.tax}, fine ${ballot.policy.fine}, ${esc(ballot.policy.focus)}.${ballot.candidates ? ` On the ballot: ${ballot.candidates.map((c) => esc(c.split(':')[0])).join(', ')}.` : ''}</p>` : ''}
    ${ballot ? '' : `<h4>On-chain</h4>
    <ol class="steps">${txs || '<li>No payment yet.</li>'}</ol>`}
    <h4>Fingerprint</h4>
    <p class="small">${ballot ? 'This decision moved no money, so nothing went on-chain. It was sealed the moment it was made: this is the SHA-256 hash of the record above, and any later change would break it.' : `Each payment's memo carries <span class="mono">Insula #${rec.id} why:${rec.hash ? rec.hash.slice(0, 16) : '…'}</span>, the start of the SHA-256 hash of this decision record, written before the money moved.`}</p>
    <p class="mono hash">${rec.hash || 'not sealed yet'}</p>
    ${rec.canonical ? `<button id="why-verify" type="button">Verify the fingerprint</button><p id="why-result" class="small"></p>` : ''}
    ${rec.hash && !ballot ? `<p class="small"><a href="/verify/${rec.id}" target="_blank" rel="noopener">Check it against Robinhood Chain on the Verify page ↗</a></p>` : ''}`;
  const btn = $('#why-verify');
  if (btn) btn.addEventListener('click', async () => {
    try {
      const h = await sha256Hex(rec.canonical);
      $('#why-result').textContent = h === rec.hash
        ? `✓ Match. Hashing this record gives ${h.slice(0, 16)}…, the same fingerprint written in the on-chain memo.`
        : '✗ Mismatch: this record has changed since it was sealed.';
      $('#why-result').className = `small ${h === rec.hash ? 'ok' : 'bad'}`;
    } catch {
      $('#why-result').textContent = "This browser can't compute SHA-256 here (it needs a secure page).";
    }
  });
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button.why');
  if (b) { ev.preventDefault(); openWhy(b.dataset.decision); }
});
$('#why-close').addEventListener('click', () => ($('#why').hidden = true));
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#why').hidden = true; });

let feedTab = 'minds';
function showTab(tab) {
  feedTab = tab;
  $('#trades').hidden = tab !== 'ledger';
  $('#minds').hidden = tab !== 'minds';
  $('#tab-ledger').setAttribute('aria-selected', tab === 'ledger');
  $('#tab-minds').setAttribute('aria-selected', tab === 'minds');
  if (tab === 'minds') { unseenMinds = 0; delete $('#tab-minds').dataset.count; }
}
$('#tab-ledger').addEventListener('click', () => showTab('ledger'));
$('#tab-minds').addEventListener('click', () => showTab('minds'));
// Phones: the feed is a peek strip; tapping its header opens or closes it.
const phone = () => matchMedia('(max-width: 600px)').matches;
$('#feed .feed-head').addEventListener('click', (ev) => {
  if (!phone()) return;
  const tabTap = ev.target.closest('[role="tab"]');
  const feed = $('#feed');
  const open = tabTap ? true : !feed.classList.contains('open');
  feed.classList.toggle('open', open);
  document.body.classList.toggle('feed-open', open);
});
// Tapping an agent's card follows that agent with the camera (tap again to go back to the island).
$('#agents').addEventListener('click', (ev) => {
  const card = ev.target.closest('.card');
  const prof = ev.target.closest('[data-profile]');
  if (prof) { window.insulaProfile?.(prof.dataset.profile); return; }
  if (!card || ev.target.closest('a')) return;
  const id = [...agents.entries()].find(([, r]) => r.card === card)?.[0];
  if (!id) return;
  const btn = document.querySelector(`#cams button[data-cam="${camMode === id ? 'orbit' : id}"]`);
  btn?.click();
});

function addFeed(e, animate = true) {
  // The ledger is the money record. Failed haggles already show in Minds (each side's reject, in their
  // own words), so they're left out here.
  if (e.type === 'log' && /couldn.t agree/.test(e.text || '')) return;
  const li = document.createElement('li');
  if (e.type === 'log' || e.type === 'era') {
    li.className = /went missing|caught \w+ stealing/.test(e.text || '') ? 'log theft' : /refused to trade/.test(e.text || '') ? 'log grudge' : 'log';
    li.textContent = e.text;
  } else if (e.type === 'chainError') {
    li.className = 'err';
    li.textContent = e.text;
  } else {
    const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const short = e.sig ? `${e.sig.slice(0, 5)}…${e.sig.slice(-4)}` : '';
    const tx = e.url ? `<a href="${e.url}" target="_blank" rel="noopener">${explorerName} ${short} ↗</a>` : 'test transaction';
    const why = e.decision
      ? `<button class="why" type="button" data-decision="${e.decision}">Why? ${e.decision}</button>`
      : e.rule ? `<span class="rule">rule: ${e.rule.replace('-', ' ')}</span>` : '';
    li.innerHTML = `
      <div class="route"><span>${nameOf(e.from, e.kind)} → ${nameOf(e.to, e.kind)}</span><span>${time}</span></div>
      <div class="what">${e.text}</div><div class="amt">${fmt(e.amount)}</div>
      <div class="tx">${tx}${why}</div>`;
  }
  if (!animate) li.style.animation = 'none';
  const list = $('#trades');
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

const pops = [];
function coinPop(rec, text, out = false) {
  const el = document.createElement('div');
  el.className = `coin-pop${out ? ' out' : ''}`;
  el.textContent = text;
  $('#bubbles').appendChild(el);
  pops.push({ el, rec });
  setTimeout(() => el.remove(), 2500);
}

function chest(rec) {
  return rec.pos.clone().add(new THREE.Vector3(0, 1.4, 0));
}

// A theft: a puff of smoke at the victim, their goods slip over to the thief, and a red "−3 ore" floats up.
// If the thief is caught, a red flash on the thief instead.
function theftFx(e) {
  const th = agents.get(e.thief), vi = agents.get(e.victim);
  if (!th || !vi) return;
  const at = chest(vi);
  burst(at.clone().add(new THREE.Vector3(0, 0.4, 0)), 0x45484f, 26, 2.6, 1.4, 1.4, 2.4);
  sound.swish(earVolume(at));
  if (e.caught) {
    burst(chest(th), 0xff3b3b, 14, 3, -6, 0.6);
    coinPop(th, 'CAUGHT!', true);
    return;
  }
  flyGoods(at, () => chest(th), ITEM_HEX[e.item] || 0xcccccc, Math.max(1, Math.min(3, e.n || 2)));
  coinPop(vi, `−${e.n} ${e.item}`, true);
}

function onEvent(e) {
  if (e.type === 'story' && e.kind === 'theft') { theftFx(e); return; }
  if (e.type === 'story' && e.kind === 'refuse') { const r = agents.get(e.from); if (r) coinPop(r, 'REFUSED', true); return; }
  // An on-chain rating after a caught theft: show the verdict over the thief.
  if (e.type === 'reputation') { const r = agents.get(e.rated); if (r && e.value < 50) coinPop(r, `RATED ${e.value}/100 ON-CHAIN`, true); return; }
  if (e.type === 'thought') { addThought(e); return; }
  if (e.type === 'decision') {
    decisionCache.set(e.record.id, e.record);
    if (decisionCache.size > 400) decisionCache.delete(decisionCache.keys().next().value);
    for (const li of document.querySelectorAll(`#minds li[data-decision="${e.record.id}"]`)) attachTxLinks(li, e.record);
    return;
  }
  if (e.type === 'daily') { onDaily(e); return; }
  if (e.type === 'era') { addFeed(e); banner('🗓', `Day ${e.day} · ${e.title}`, e.summary); return; }
  if (e.type === 'arrival') { banner('🛶', `${e.name} the ${e.species} arrives`, `A new ${e.job} moves to Insula with a wallet of their own.`); return; }
  if (e.type === 'world') {
    if (e.kind === 'landmark') banner('🏛', `The ${e.label} is open`, 'Funded and built by the agents themselves.');
    if (e.kind === 'fireworks') { fireworks(); banner('🎆', 'Day 30', 'One month since genesis. Look what they built.'); }
    return;
  }
  if (e.type === 'mood') {
    const rec = agents.get(e.agent);
    if (rec) rec.mood = { kind: e.mood, start: clock.elapsedTime };
    if (e.mood === 'angry') sound.grumble();
    return;
  }
  if (e.type === 'trade' || e.type === 'log' || e.type === 'chainError') addFeed(e);
  if (e.type !== 'trade') return;
  // Paying the mainland: coins fly from the agent out to the boat.
  if (e.to === 'bank') {
    const fr = agents.get(e.from);
    if (!fr) return;
    const d = world.places.dock;
    coinPop(fr, `−${fmt(e.amount)}`, true);
    flyCoins(chest(fr), new THREE.Vector3(d.waterX * 2 - d.x, world.waterLevel + 2, d.waterZ * 2 - d.z), e.amount);
    return;
  }
  const to = agents.get(e.to);
  if (!to) return;
  let from;
  if (e.from === 'bank') {
    const d = world.places.dock;
    from = e.kind === 'export' ? new THREE.Vector3(d.waterX * 2 - d.x, world.waterLevel + 2, d.waterZ * 2 - d.z) : chest(to).add(new THREE.Vector3(0, 9, 0));
  } else {
    const fr = agents.get(e.from);
    from = fr ? chest(fr) : chest(to).add(new THREE.Vector3(0, 6, 0));
    if (fr) coinPop(fr, `−${fmt(e.amount)}`, true);
  }
  flyCoins(from, () => chest(to), e.amount, () => { coinPop(to, `+${fmt(e.amount)}`); sound.cheer(); });
}

// ---------- Connection ----------
function handle(msg) {
  if (msg.type === 'hello') {
    if (!world) buildWorld(msg.world);
    // State first, so the history below already knows the agents' names and the explorer (Blockscout).
    applyState(msg.state);
    $('#trades').innerHTML = '';
    msg.history.forEach((e) => addFeed(e, false));
    $('#minds').innerHTML = '';
    (msg.thoughts || []).forEach((e) => addThought(e, false));
  } else if (msg.type === 'state') applyState(msg.state);
  else if (msg.type === 'tick') applyTick(msg);
  else if (msg.type === 'event') onEvent(msg.event);
}

// A tick carries only the moving parts of each agent, 5 times a second. Merge it into the last full state.
const TICK_FIELDS = ['id', 'x', 'z', 'y', 'heading', 'moving', 'thinking', 'task', 'activity', 'say', 'hunger', 'ore', 'fish', 'wood', 'grain', 'balance'];
function applyTick(msg) {
  if (!latest) return;
  const byId = new Map(latest.agents.map((a) => [a.id, a]));
  const now = performance.now();
  for (const row of msg.a) {
    const a = byId.get(row[0]);
    if (!a) continue; // a new arrival: it appears with the next full state
    const prev = { x: a.x, z: a.z };
    const [, x, z, y, heading, moving, thinking, task, activity, say, hunger, ore, fish, wood, grain, balance] = row;
    Object.assign(a, { x, z, y, heading, moving: !!moving, thinking: !!thinking, task, activity, say, hunger, balance, inv: { ore, fish, wood, grain } });
    const rec = agents.get(a.id);
    if (rec) {
      // Remember how fast it's walking, so the viewer can glide it forward between ticks.
      const dt = rec.tickAt ? (now - rec.tickAt) / 1000 : 0;
      rec.vel = moving && dt > 0.05 && dt < 1 ? { x: (x - prev.x) / dt, z: (z - prev.z) / dt } : null;
      rec.tickAt = now;
    }
  }
  // Visitors (Open Borders): position, heading and what they're doing.
  for (const [id, x, z, y, heading, moving, task, activity] of msg.v || []) {
    const rec = agents.get(id);
    if (!rec?.data.visitor) continue;
    const a = rec.data, dt = rec.tickAt ? (now - rec.tickAt) / 1000 : 0;
    rec.vel = moving && dt > 0.05 && dt < 1 ? { x: (x - a.x) / dt, z: (z - a.z) / dt } : null;
    rec.tickAt = now;
    Object.assign(a, { x, z, y, heading, moving: !!moving, task, activity });
  }
  applyAgents(latest);
}

function connect() {
  // Preview build: the whole world runs inside the page, no server needed.
  const local = window.__INSULA_LOCAL;
  if (local) {
    handle({ type: 'hello', world: local.world, history: local.sim.history, thoughts: local.sim.thoughts, state: local.sim.state() });
    local.sim.on((event) => handle({ type: 'event', event }));
    setInterval(() => handle({ type: 'state', state: local.sim.state() }), 100);
    return;
  }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => handle(JSON.parse(m.data));
  ws.onclose = () => {
    $('#mode').textContent = 'RECONNECTING';
    setTimeout(connect, 1500);
  };
}
// Connect once the whole viewer has loaded (a saved island can arrive with buildings in its very first update).
queueMicrotask(connect);

// ---------- Intro ----------
setTimeout(() => $('#intro').classList.add('gone'), REDUCED ? 600 : 3400);
$('#intro').addEventListener('click', () => $('#intro').classList.add('gone'));

// ---------- Cameras and film mode ----------
let camMode = 'orbit';
function wireCam(b) {
  b.addEventListener('click', () => {
    camMode = b.dataset.cam;
    document.querySelectorAll('#cams button').forEach((x) => x.classList.toggle('on', x === b));
    controls.autoRotate = camMode === 'orbit' && !REDUCED;
  });
}
document.querySelectorAll('#cams button').forEach(wireCam);
// One camera button per agent, added as agents appear.
function syncCams(list) {
  const nav = $('#cams');
  for (const a of list) {
    if (nav.querySelector(`[data-cam="${a.id}"]`)) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.cam = a.id;
    b.textContent = a.name;
    nav.appendChild(b);
    wireCam(b);
  }
}

let film = false, filmStart = 0;
function setFilm(on) {
  film = on;
  document.body.classList.toggle('film', on);
  controls.enabled = !on;
  filmStart = clock.elapsedTime;
}
$('#film').addEventListener('click', (ev) => { ev.stopPropagation(); setFilm(true); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && film) setFilm(false);
  if (e.key === 'f' && !film && !walk.on && !/input|textarea/i.test(document.activeElement?.tagName)) setFilm(true);
});
renderer.domElement.addEventListener('click', () => { if (film) setFilm(false); });

// A director that cuts between shots for recording the launch video.
const SHOT = 9;
function filmCamera(t, dt) {
  if (!world) return;
  const c = new THREE.Vector3(world.size / 2, 3, world.size / 2);
  const ids = [...agents.keys()];
  const shot = Math.floor((t - filmStart) / SHOT) % 4;
  const k = ((t - filmStart) % SHOT) / SHOT;
  let pos, look;
  if (shot === 0) {
    const ang = 0.6 + k * 0.5;
    pos = c.clone().add(new THREE.Vector3(Math.cos(ang) * 46, 26 - k * 6, Math.sin(ang) * 46));
    look = c;
  } else if (shot === 3) {
    const ang = 2.4 + k * 0.4;
    pos = c.clone().add(new THREE.Vector3(Math.cos(ang) * 30, 7 + k * 3, Math.sin(ang) * 30));
    look = c.clone().setY(4);
  } else {
    const rec = agents.get(ids[(shot - 1) % ids.length]);
    if (!rec) return;
    const side = new THREE.Vector3(Math.sin(rec.heading + 0.9), 0, Math.cos(rec.heading + 0.9));
    pos = rec.pos.clone().addScaledVector(side, 6.5 - k * 1.5).add(new THREE.Vector3(0, 2.6, 0));
    look = rec.pos.clone().add(new THREE.Vector3(0, 1.3, 0));
  }
  const cut = k < 0.02;
  camera.position.lerp(pos, cut ? 1 : Math.min(1, dt * 2.2));
  controls.target.lerp(look, cut ? 1 : Math.min(1, dt * 3));
  camera.lookAt(controls.target);
}

// ---------- Walk mode: visit the island on foot ----------
// A first-person camera at ground level. Visitors are ghosts: the animals never see them and nothing they do
// changes the island. WASD/arrows + mouse on a computer, a thumbstick and drag-to-look on a phone.
const walk = {
  on: false, pos: new THREE.Vector3(), eye: 0, vy: 0, yaw: 0, pitch: -0.08, keys: new Set(), stick: { x: 0, z: 0 },
  saved: null, bob: 0, look: null, n: 0, grounded: true,
};
const EYE = 1.7, BODY_R = 0.26, BODY_H = 1.7, STEP = 1.05, JUMP_V = 7.4; // a jump clears about 1.4 blocks: with the step, two-block ledges but not walls
const TOUCH = matchMedia('(pointer: coarse)').matches;

// The surface (foot height) of the column at (xi, zi): the highest block whose top is at most `below`.
function columnTop(xi, zi, below) {
  for (let y = Math.floor(below) - 1; y >= 0; y--) if (solidSet.has(`${xi},${y},${zi}`)) return y + 1;
  return 0;
}
// Where a walker with feet at `feet` would stand at (x, z), or null when that spot is the sea, a wall, a tree
// trunk, a cliff more than one block high or inside a building.
function footAt(x, z, feet) {
  const xi = Math.round(x), zi = Math.round(z);
  if (!world || xi < 1 || zi < 1 || xi >= world.size - 1 || zi >= world.size - 1) return null;
  const deck = pierDeck.has(`${xi},${zi}`);
  if (!deck && (world.heights[xi][zi] <= world.waterLevel || noWalk.has(`${xi},${zi}`))) return null;
  const g = deck ? pierTop : columnTop(xi, zi, feet + STEP);
  if (!deck && g > feet + STEP) return null;
  for (let y = Math.floor(g + 0.01); y < g + BODY_H; y++) if (solidSet.has(`${xi},${y},${zi}`)) return null;
  for (const b of latest?.buildings || []) {
    if (b.x == null || b.type === 'harbor') continue;
    const half = (b.kind === 'project' && (b.type === 'townhall' || b.type === 'markethall') ? 2.5 : 1.5) + 0.05;
    if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return null;
  }
  return g;
}
// The body is a small square: every corner has to fit. Returns the ground under it, or null.
function bodyAt(x, z, feet) {
  let g = -Infinity;
  for (const [ox, oz] of [[-BODY_R, -BODY_R], [BODY_R, -BODY_R], [-BODY_R, BODY_R], [BODY_R, BODY_R]]) {
    const f = footAt(x + ox, z + oz, feet);
    if (f == null) return null;
    g = Math.max(g, f);
  }
  return g;
}

function enterWalk() {
  if (walk.on || !world || !solidSet) return;
  if (film) setFilm(false);
  const P = world.places;
  // Arrive near the market, at the spot (and facing the way) with the most open view of town, rather than
  // nose to a wall: score each spot by how far you can see across a fan of directions at eye level.
  const clear = (x, z, feet, h) => {
    const sx = -Math.sin(h), sz = -Math.cos(h), eye = Math.floor(feet + EYE - 0.3);
    for (let d = 1; d <= 24; d += 0.5) {
      const px = x + sx * d, pz = z + sz * d, xi = Math.round(px), zi = Math.round(pz);
      if (solidSet.has(`${xi},${eye},${zi}`) || solidSet.has(`${xi},${eye - 1},${zi}`)) return d;
      if ((latest?.buildings || []).some((b) => b.x != null && b.type !== 'harbor' && Math.abs(px - b.x) < 1.6 && Math.abs(pz - b.z) < 1.6)) return d;
    }
    return 24;
  };
  let spot = null;
  for (let r = 6; r <= 13; r++) for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, x = P.market.x + Math.cos(a) * r, z = P.market.z + Math.sin(a) * r;
    const g = bodyAt(x, z, 99);
    if (g == null || bodyAt(x, z, g) == null || Math.abs(g - (world.heights[P.market.x][P.market.z] + 1)) > 2) continue;
    const h = Math.atan2(x - P.market.x, z - P.market.z); // facing the market
    if (clear(x, z, g, h) < r - 2) continue;             // the plaza has to be in sight
    const fan = [-0.6, -0.3, 0.3, 0.6].map((o) => clear(x, z, g, h + o));
    const score = r + fan.reduce((t, v) => t + Math.min(v, 14), 0) / 8;
    if (!spot || score > spot.score) spot = { x, z, g, h, score };
  }
  // Fallback: anywhere near the market.
  for (let r = 3; r <= 12 && !spot; r++) for (let i = 0; i < 16 && !spot; i++) {
    const a = (i / 16) * Math.PI * 2, x = P.market.x + Math.cos(a) * r, z = P.market.z + Math.sin(a) * r, g = bodyAt(x, z, 99);
    if (g != null) spot = { x, z, g, h: Math.atan2(x - P.market.x, z - P.market.z) };
  }
  if (!spot) return;
  walk.saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, cam: camMode };
  walk.pos.set(spot.x, spot.g, spot.z);
  walk.eye = spot.g;
  walk.vy = 0;
  walk.yaw = spot.h;
  walk.pitch = -0.08;
  walk.on = true;
  controls.enabled = false;
  controls.autoRotate = false;
  camera.fov = 68;
  camera.updateProjectionMatrix();
  document.body.classList.add('walking');
  hud.hidden = false;
  hint.classList.remove('gone');
  clearTimeout(hint.t);
  hint.t = setTimeout(() => hint.classList.add('gone'), 9000);
  if (location.hash !== '#walk') history.replaceState(null, '', '#walk');
}

function leaveWalk() {
  if (!walk.on) return;
  walk.on = false;
  walk.keys.clear();
  walk.stick.x = walk.stick.z = 0;
  if (document.pointerLockElement) document.exitPointerLock();
  const s = walk.saved;
  camera.fov = s.fov;
  camera.updateProjectionMatrix();
  camera.position.copy(s.pos);
  controls.target.copy(s.target);
  controls.enabled = true;
  controls.autoRotate = camMode === 'orbit' && !REDUCED;
  document.body.classList.remove('walking');
  hud.hidden = true;
  stickEl.hidden = true;
  if (location.hash === '#walk') history.replaceState(null, '', location.pathname + location.search);
}

const raycaster = new THREE.Raycaster();
const centerNdc = new THREE.Vector2(0, 0);
// The animal under the crosshair (or under a tap), if it's close enough to meet.
function animalAt(ndc) {
  raycaster.setFromCamera(ndc, camera);
  raycaster.far = 12;
  let best = null;
  for (const [id, rec] of agents) {
    if (rec.data.visitor) continue;
    const hit = raycaster.intersectObject(rec.group, true)[0];
    if (hit && (!best || hit.distance < best.d)) best = { id, d: hit.distance, name: rec.data.name };
  }
  return best;
}
function meet(found) {
  if (!found) return;
  if (document.pointerLockElement) document.exitPointerLock();
  window.insulaProfile?.(found.id);
}

const _f = new THREE.Vector3();
function stepWalk(dt, t) {
  const k = walk.keys;
  // Input: keys plus the thumbstick, in the direction the camera faces.
  let mx = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0) + walk.stick.x;
  let mz = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0) + walk.stick.z;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const speed = (k.has('shift') ? 7.2 : 4.0) * (dialogOpen() ? 0 : 1);
  const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw), rx = Math.cos(walk.yaw), rz = -Math.sin(walk.yaw);
  let dx = (fx * mz + rx * mx) * speed * dt, dz = (fz * mz + rz * mx) * speed * dt;
  const p = walk.pos;
  // Animals are solid too: slide around them rather than through.
  for (const rec of agents.values()) {
    const ox = p.x + dx - rec.pos.x, oz = p.z + dz - rec.pos.z, d = Math.hypot(ox, oz);
    if (d < 0.75 && d > 1e-4 && Math.abs(rec.pos.y - p.y) < 1.5) { dx += (ox / d) * (0.75 - d); dz += (oz / d) * (0.75 - d); }
  }
  // Move one axis at a time so walls slide instead of stopping you dead.
  const blocked = (dx && bodyAt(p.x + dx, p.z, p.y) == null) || (dz && bodyAt(p.x, p.z + dz, p.y) == null);
  if (dx && bodyAt(p.x + dx, p.z, p.y) != null) p.x += dx;
  if (dz && bodyAt(p.x, p.z + dz, p.y) != null) p.z += dz;
  // Gravity, jumping, stepping up one block. Walking into a ledge two blocks high hops you up it (there's no
  // jump key on a phone); anything taller is a wall.
  const g = bodyAt(p.x, p.z, p.y) ?? p.y;
  if (blocked && walk.grounded && m > 0.05 && speed > 0) {
    const d = Math.hypot(dx, dz) || 1, ax = p.x + (dx / d) * 0.45, az = p.z + (dz / d) * 0.45;
    const up = bodyAt(ax, az, p.y + 1);
    if (up != null && up > p.y + STEP && up <= p.y + 2 + 0.05) { walk.vy = JUMP_V; walk.grounded = false; }
  }
  if (walk.keys.has(' ') && walk.grounded) { walk.vy = JUMP_V; walk.grounded = false; }
  if (p.y > g + 0.001 || walk.vy > 0) {
    walk.vy -= 20 * dt;
    p.y += walk.vy * dt;
    if (p.y <= g) { p.y = g; walk.vy = 0; walk.grounded = true; }
    else walk.grounded = false;
  } else { p.y = g; walk.vy = 0; walk.grounded = true; }
  // The eye follows the feet smoothly (steps don't jolt), with a gentle bob while walking.
  walk.eye += (p.y - walk.eye) * Math.min(1, dt * 14);
  const moving = m > 0.05 && walk.grounded && speed > 0;
  walk.bob = moving ? walk.bob + dt * (k.has('shift') ? 13 : 9) : walk.bob * 0.9;
  camera.position.set(p.x, walk.eye + EYE + (moving ? Math.abs(Math.sin(walk.bob)) * 0.06 : 0), p.z);
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
  camera.getWorldDirection(_f);
  controls.target.copy(camera.position).addScaledVector(_f, 3); // keeps the tilt-shift off and the rain around you
  // Who's in front of you (checked a few times a second).
  if (!TOUCH && (walk.n = (walk.n + 1) % 8) === 0) {
    const a = animalAt(centerNdc);
    walk.look = a;
    lookEl.textContent = a ? `${a.name} · click to read their mind` : '';
    hud.classList.toggle('aim', !!a);
  }
}

function dialogOpen() {
  return !!document.querySelector('#profile:not([hidden]), #econ:not([hidden]), #vote:not([hidden]), #paper:not([hidden]), #why:not([hidden])');
}

// ---------- Walk mode: interface ----------
const walkBtn = document.createElement('button');
walkBtn.type = 'button';
walkBtn.id = 'walk-btn';
walkBtn.textContent = 'Walk in';
walkBtn.title = 'Visit the island on foot';
$('#cams').insertBefore(walkBtn, $('#cams').children[1] || null);
walkBtn.addEventListener('click', enterWalk);

const hud = document.createElement('div');
hud.id = 'walk-hud';
hud.hidden = true;
hud.innerHTML = `
  <div class="walk-top">
    <span class="walk-tag mono">VISITING INSULA</span>
    <button id="walk-leave" class="chip mono" type="button">LEAVE ✕</button>
  </div>
  <div class="walk-cross" aria-hidden="true"></div>
  <div class="walk-look mono" aria-live="polite"></div>
  <div class="walk-hint mono">${TOUCH
    ? 'Left thumb to walk · Drag to look around · Tap an animal to read its mind'
    : 'WASD to walk · Mouse to look · Shift to run · Space to jump · Click an animal to read its mind · Esc to leave'}</div>`;
document.body.appendChild(hud);
const hint = hud.querySelector('.walk-hint');
const lookEl = hud.querySelector('.walk-look');
hud.querySelector('#walk-leave').addEventListener('click', (e) => { e.stopPropagation(); leaveWalk(); });

const stickEl = document.createElement('div');
stickEl.id = 'walk-stick';
stickEl.hidden = true;
stickEl.innerHTML = '<i></i>';
document.body.appendChild(stickEl);

const KEYMAP = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' };
addEventListener('keydown', (e) => {
  if (!walk.on || /input|textarea/i.test(document.activeElement?.tagName)) return;
  const key = KEYMAP[e.key.toLowerCase()] || e.key.toLowerCase();
  if (e.key === 'Escape') { if (!dialogOpen()) leaveWalk(); return; }
  if (key === 'e' && walk.look) { meet(walk.look); return; }
  if (['w', 'a', 's', 'd', 'shift', ' '].includes(key)) { walk.keys.add(key); if (key === ' ') e.preventDefault(); }
});
addEventListener('keyup', (e) => walk.keys.delete(KEYMAP[e.key.toLowerCase()] || e.key.toLowerCase()));
addEventListener('blur', () => walk.keys.clear());

// Mouse: click to lock the pointer and look around; click again (locked) to meet the animal in the crosshair.
const cv = renderer.domElement;
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  if (!walk.on) return;
  if (e.pointerType === 'mouse') {
    if (document.pointerLockElement === cv) { meet(walk.look); return; }
    cv.requestPointerLock?.()?.catch?.(() => {});
    return;
  }
  // Touch: the lower-left quarter is the thumbstick, anywhere else drags the view (a quick tap meets).
  if (e.clientX < innerWidth * 0.45 && e.clientY > innerHeight * 0.45 && !walk.stickId) {
    walk.stickId = e.pointerId;
    walk.stickAt = { x: e.clientX, y: e.clientY };
    stickEl.hidden = false;
    stickEl.style.left = `${e.clientX}px`;
    stickEl.style.top = `${e.clientY}px`;
    stickEl.firstChild.style.transform = 'translate(-50%, -50%)';
  } else if (!drag) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, at: performance.now() };
  try { cv.setPointerCapture(e.pointerId); } catch {}
});
cv.addEventListener('pointermove', (e) => {
  if (!walk.on) return;
  if (e.pointerId === walk.stickId) {
    let sx = e.clientX - walk.stickAt.x, sy = e.clientY - walk.stickAt.y;
    const d = Math.hypot(sx, sy), max = 46;
    if (d > max) { sx *= max / d; sy *= max / d; }
    walk.stick.x = sx / max; walk.stick.z = -sy / max;
    stickEl.firstChild.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
  } else if (drag && e.pointerId === drag.id) {
    turn((e.clientX - drag.x) * 0.0055, (e.clientY - drag.y) * 0.0055);
    drag.x = e.clientX; drag.y = e.clientY;
  }
});
const release = (e) => {
  if (!walk.on) return;
  if (e.pointerId === walk.stickId) { walk.stickId = null; walk.stick.x = walk.stick.z = 0; stickEl.hidden = true; }
  else if (drag && e.pointerId === drag.id) {
    const tap = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8 && performance.now() - drag.at < 350;
    if (tap && e.type === 'pointerup') meet(animalAt(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)));
    drag = null;
  }
};
cv.addEventListener('pointerup', release);
cv.addEventListener('pointercancel', release);
addEventListener('mousemove', (e) => { if (walk.on && document.pointerLockElement === cv) turn(e.movementX * 0.0022, e.movementY * 0.0022); });
document.addEventListener('pointerlockchange', () => hud.classList.toggle('locked', document.pointerLockElement === cv));
function turn(dx, dy) {
  walk.yaw -= dx;
  walk.pitch = Math.max(-1.35, Math.min(1.2, walk.pitch - dy));
}
if (location.hash === '#walk') {
  const tryEnter = () => (world && solidSet ? enterWalk() : setTimeout(tryEnter, 400));
  setTimeout(tryEnter, 1200);
}
window.insulaWalk = enterWalk;

// ---------- Buildings: houses and workshops the builder puts up ----------
const builtMeshes = new Map(); // id -> render record
const bGeo = new RoundedBoxGeometry(1, 1, 1, 1, 0.06);
const PROJECT_LABEL = { townhall: 'Town Hall', granary: 'Granary', lighthouse: 'Lighthouse', markethall: 'Market Hall', harbor: 'North Harbor', monument: 'Founders Monument' };

// Blueprint for a building at a given level: [dx, dy, dz, color | 'glow'] relative to the site's ground.
function blueprint(b, level) {
  const out = [];
  const box = (x0, x1, y0, y1, z0, z1, c) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z, c]); };
  const ring = (r, y, colorFn) => { for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) if (Math.abs(x) === r || Math.abs(z) === r) out.push([x, y, z, colorFn(x, z)]); };
  const owner = b.owner ? agents.get(b.owner)?.data : null;
  const roof = new THREE.Color(owner?.color || '#c0583b').multiplyScalar(0.85).getHex();
  switch (b.kind === 'project' ? b.type : 'private') {
    case 'private': {
      const stone = b.type === 'workshop';
      const wall = stone ? [0x8e939a, 0x767b83] : [0xc9955a, 0xb5824a];
      const floors = level;
      for (let f = 0; f < floors; f++)
        for (let y = f * 2; y < f * 2 + 2; y++)
          ring(1, y, (x, z) => (f === 0 && y === 0 && z === 1 && x === 0 ? 0x4a3324 : y % 2 === 1 && z === 0 && Math.abs(x) === 1 ? 'glow' : y % 2 === 1 && x === 0 && Math.abs(z) === 1 && f > 0 ? 'glow' : wall[(x + z + y) & 1]));
      const top = floors * 2;
      box(-1, 1, top, top, -1, 1, roof);
      out.push([0, top + 1, 0, roof]);
      if (stone) { out.push([1, top + 1, -1, 0x5a5f66], [1, top + 2, -1, 0x5a5f66]); if (level > 1) out.push([1, top + 3, -1, 0x5a5f66]); }
      if (!stone && level >= 3) out.push([0, top + 2, 0, 0x6b4423], [0, top + 3, 0, owner?.color ? new THREE.Color(owner.color).getHex() : 0xd9493f]);
      break;
    }
    case 'townhall':
      box(-2, 2, 0, 0, -2, 2, 0xa9a59c);
      for (let y = 1; y <= 3; y++) ring(2, y, (x, z) => (z === 2 && x === 0 && y <= 2 ? 0x4a3324 : y === 2 && (Math.abs(x) === 2 || z === -2) && (x + z) % 2 === 0 ? 'glow' : (x + y + z) % 2 ? 0xe9e4da : 0xd9d3c7));
      for (const x of [-2, 2]) for (let y = 1; y <= 3; y++) out.push([x, y, 3, 0xf3efe6]);
      box(-2, 2, 4, 4, -2, 3, 0x2c3e66);
      box(-1, 1, 5, 5, -1, 2, 0x2c3e66);
      out.push([0, 6, 0, 0x8f989f], [0, 7, 0, 0x8f989f], [0, 8, 0, 0xc8402f], [0, 3, 3, 'glow']);
      break;
    case 'granary':
      for (let y = 0; y < 6; y++) ring(1, y, (x, z) => (y === 0 && z === 1 && x === 0 ? 0x4a3324 : (y % 2 ? 0xc9955a : 0xb5824a)));
      box(-1, 1, 6, 6, -1, 1, 0xd9493f);
      out.push([0, 7, 0, 0xd9493f], [0, 8, 0, 0xe8c45a]);
      break;
    case 'lighthouse':
      for (let y = 0; y < 9; y++) ring(1, y, () => (Math.floor(y / 2) % 2 ? 0xd9493f : 0xf3efe6));
      box(-1, 1, 9, 9, -1, 1, 0x2c3e66);
      out.push([0, 10, 0, 'glow'], [0, 11, 0, 0x2c3e66]);
      break;
    case 'markethall':
      box(-2, 2, 0, 0, -2, 2, 0xa9a59c);
      for (const x of [-2, 2]) for (const z of [-2, 2]) for (let y = 1; y <= 3; y++) out.push([x, y, z, 0x8a5a33]);
      for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) out.push([x, 4, z, (x + 2) % 2 ? 0xf3efe6 : 0x2f8f6a]);
      box(-1, 1, 5, 5, -1, 1, 0x2f8f6a);
      out.push([-1, 1, 0, 0xb98349], [1, 1, 0, 0xb98349], [0, 1, -1, 0xe8c45a], [0, 1, 1, 'glow']);
      break;
    case 'harbor':
      for (let z = 1; z <= 7; z++) for (let x = -2; x <= 2; x++) if (Math.abs(x) < 2 || z % 2) out.push([x, -1, -z, z % 2 ? 0xb98349 : 0x93623a]);
      for (let y = 0; y < 6; y++) out.push([2, y, -2, 0xf2c230]);
      for (let z = 2; z <= 5; z++) out.push([2, 6, -z, 0xf2c230]);
      out.push([2, 5, -5, 0x2a2a2a], [-1, 0, -2, 0x7a4a26], [-1, 1, -2, 0x7a4a26], [0, 0, -3, 0x8a5a33], [-2, 0, 0, 'glow']);
      break;
    case 'monument': {
      box(-1, 1, 0, 1, -1, 1, 0xa9a59c);
      box(-1, 1, 2, 2, -1, 1, 0xd9d3c7);
      const founders = [['bruno', -1, -1], ['felix', 1, -1], ['penny', -1, 1], ['bea', 1, 1]];
      for (const [id, x, z] of founders) {
        const c = new THREE.Color(agents.get(id)?.data.color || '#c9a24a').getHex();
        out.push([x, 3, z, c], [x, 4, z, c]);
      }
      out.push([0, 3, 0, 'glow'], [0, 4, 0, 0xf5c66b], [0, 5, 0, 0xf5c66b]);
      break;
    }
  }
  return out.sort((p, q) => p[1] - q[1]);
}

function makeBuildingMesh(b, level) {
  const blocks = blueprint(b, level);
  const solid = blocks.filter((k) => k[3] !== 'glow');
  const glowBlocks = blocks.filter((k) => k[3] === 'glow');
  // Foundation down to the ground, so buildings on uneven plots never float
  const found = [];
  const r = b.kind === 'project' && ['townhall', 'markethall'].includes(b.type) ? 2 : 1;
  if (b.type !== 'harbor')
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const h = world.heights[b.x + dx]?.[b.z + dz] ?? b.y;
        for (let y = h + 1; y <= b.y; y++) found.push([dx, y - b.y - 1, dz, 0x8e939a]);
      }
  const all = [...found, ...solid];
  const mesh = new THREE.InstancedMesh(bGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), Math.max(1, all.length));
  const m = new THREE.Matrix4(), c = new THREE.Color();
  all.forEach(([dx, dy, dz, col], i) => {
    mesh.setMatrixAt(i, m.makeTranslation(b.x + dx, b.y + 1 + dy + 0.5, b.z + dz));
    mesh.setColorAt(i, c.setHex(col));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  const glow = new THREE.InstancedMesh(bGeo, new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffb050, emissiveIntensity: 0.4 }), Math.max(1, glowBlocks.length));
  glowBlocks.forEach(([dx, dy, dz], i) => glow.setMatrixAt(i, m.makeTranslation(b.x + dx, b.y + 1 + dy + 0.5, b.z + dz)));
  glow.count = 0;
  // Blocks below this level's new floors are already standing
  const prevTop = b.kind === 'private' ? (level - 1) * 2 : -99;
  const nBase = found.length + solid.filter((k) => k[1] < prevTop).length;
  return { mesh, glow, n: all.length, nBase, ng: glowBlocks.length, top: Math.max(...blocks.map((k) => k[1]), 2) };
}

function syncBuildings(list) {
  if (!world) return;
  for (const b of list) {
    let rec = builtMeshes.get(b.id);
    if (rec && rec.level !== b.level) {
      scene.remove(rec.mesh, rec.glow);
      rec.mesh.dispose?.();
      rec.glow.dispose?.();
      Object.assign(rec, makeBuildingMesh(b, b.level), { level: b.level, shown: 0, done: false });
      scene.add(rec.mesh, rec.glow);
    }
    if (!rec) {
      rec = { ...makeBuildingMesh(b, b.level), level: b.level, shown: 0 };
      const sign = document.createElement('div');
      sign.className = 'tag place';
      $('#bubbles').appendChild(sign);
      rec.sign = sign;
      rec.pos = new THREE.Vector3(b.x, b.y + 4, b.z);
      scene.add(rec.mesh, rec.glow);
      builtMeshes.set(b.id, rec);
      places.push({ el: sign, pos: rec.pos, maxDist: b.kind === 'project' ? 80 : 30 });
      if (b.type === 'lighthouse') {
        rec.beam = new THREE.SpotLight(0xfff1c4, 0, 70, 0.22, 0.5, 1);
        rec.beam.position.set(b.x, b.y + 11.6, b.z);
        rec.beam.target.position.set(b.x + 30, b.y, b.z);
        scene.add(rec.beam, rec.beam.target);
      }
    }
    rec.b = b;
    const owner = b.owner ? agents.get(b.owner)?.data.name ?? b.owner : null;
    const label = b.kind === 'project' ? PROJECT_LABEL[b.type] : `${owner}'s ${b.type}${b.level > 1 ? ` L${b.level}` : ''}`;
    if (rec.sign.textContent !== label) rec.sign.textContent = label;
    rec.pos.y = b.y + rec.top + 2.6;
    const shown = Math.ceil(rec.nBase + (rec.n - rec.nBase) * b.progress);
    if (shown > rec.shown) {
      if (rec.shown) burst(new THREE.Vector3(b.x, b.y + 1.5 + b.progress * rec.top, b.z), 0xd9b07a, 6, 2.5, -8, 0.6);
      rec.shown = shown;
    }
    rec.mesh.count = shown;
    rec.glow.count = b.progress >= 0.6 ? rec.ng : 0;
    if (b.progress >= 1 && !rec.done) {
      rec.done = true;
      if (rec.everSeen) {
        burst(new THREE.Vector3(b.x, b.y + rec.top, b.z), 0xffd36b, 40, 6, -7, 1.2, 1.2);
        sound.cheer();
      }
    }
    rec.everSeen = true;
  }
}
function stepBuildings(t) {
  const nightGlow = clamp01((nightness - 0.15) * 1.5);
  for (const rec of builtMeshes.values()) {
    rec.glow.material.emissiveIntensity = 0.4 + nightGlow * 1.3;
    if (rec.done && rec.b.type === 'workshop' && Math.random() < 0.15) {
      burst(new THREE.Vector3(rec.b.x + 1, rec.b.y + rec.top + 2.2, rec.b.z - 1), 0xb8bcc2, 1, 0.5, 1.5, 2.2, 2.6);
    }
    if (rec.beam) {
      rec.beam.intensity = rec.done ? nightGlow * 60 : 0;
      const a = t * 0.8;
      rec.beam.target.position.set(rec.b.x + Math.cos(a) * 30, rec.b.y, rec.b.z + Math.sin(a) * 30);
    }
  }
}

// ---------- Roadmap ----------
let rmCache = '';
function until(days, dayMs) {
  const ms = Math.max(0, days * dayMs);
  const h = ms / 3_600_000;
  if (h >= 48) return `in ${Math.round(h / 24)} days`;
  if (h >= 1) return `in ${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  if (ms >= 60_000) return `in ${Math.round(ms / 60_000)} min`;
  return `in ${Math.max(1, Math.round(ms / 1000))}s`;
}
function renderRoadmap(state) {
  if (!state.eras) return;
  const now = state.day - 1 + (state.dayProgress || 0);
  const next = state.eras.find((e) => !e.unlocked);
  $('#rm-day').textContent = `DAY ${state.day}`;
  const nextHtml = next
    ? `<b>Next · day ${next.day + 1}${next.after ? '+' : ''} · ${next.day > now ? until(next.day - now, state.dayMs) : next.after ? 'once it\'s built' : 'waiting on the economy'}</b>${next.title}: ${next.summary}`
    : '<b>The city stands</b>The founding story is told. The economy keeps running on its own.';
  const list = state.eras.filter((e) => e.id !== 'genesis').map((e) =>
    `<li class="${e.unlocked ? 'done' : e === next ? 'next' : ''}"><span class="d">D${e.day + 1}${e.after ? '+' : ''}</span><span>${e.title}</span></li>`).join('') +
    '<li class="more"><span class="d">D32+</span><span>To be continued…</span></li>';
  const projects = (state.projects || []).map((p) => {
    const pct = p.status === 'done' ? 100 : Math.min(100, Math.round((p.funded / p.need) * 100));
    const status = p.status === 'done' ? 'built' : p.status === 'funding' ? `${fmt(p.funded)} / ${fmt(p.need)}` : 'funded · building';
    return `<div class="proj ${p.status === 'done' ? 'done' : ''}"><div class="row"><span>${p.label}</span><span>${status}</span></div><div class="bar"><div style="width:${pct}%"></div></div></div>`;
  }).join('');
  const html = nextHtml + '|' + list + '|' + projects;
  if (html === rmCache) return;
  rmCache = html;
  $('#rm-next').innerHTML = nextHtml;
  $('#rm-list').innerHTML = list;
  $('#rm-projects').innerHTML = projects;
}
$('#rm-toggle').addEventListener('click', () => {
  const r = $('#roadmap');
  const mobile = matchMedia('(max-width: 900px)').matches;
  r.classList.toggle(mobile ? 'open-mobile' : 'collapsed');
  $('#rm-toggle').setAttribute('aria-expanded', mobile ? r.classList.contains('open-mobile') : !r.classList.contains('collapsed'));
});

let bannerTimer = null;
function banner(icon, title, sub) {
  const el = $('#banner');
  delete el.dataset.action;
  el.innerHTML = `<span class="b-icon">${icon}</span><div><div class="b-title"></div><div class="b-sub"></div></div>`;
  el.querySelector('.b-title').textContent = title;
  el.querySelector('.b-sub').textContent = sub;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 6500);
}

function fireworks() {
  if (!world) return;
  const m = world.places.market;
  const colors = [0xff5a5a, 0xffd34a, 0x6dff9a, 0x5ab8ff, 0xd77bff, 0xffffff];
  for (let i = 0; i < 12; i++) {
    setTimeout(() => {
      const p = new THREE.Vector3(m.x + (Math.random() - 0.5) * 30, 24 + Math.random() * 10, m.z + (Math.random() - 0.5) * 30);
      burst(p, colors[i % colors.length], 70, 11, -3.2, 1.7, 1.5);
      sound.cheer();
    }, i * 380);
  }
}

// ---------- Market ticker ----------
let tickerHtml = '';
function change(item) {
  const pct = item.prev ? ((item.last - item.prev) / item.prev) * 100 : 0;
  if (Math.abs(pct) < 0.05) return '<i class="flat">— 0.0%</i>';
  return pct > 0 ? `<i class="up">▲ ${pct.toFixed(1)}%</i>` : `<i class="down">▼ ${Math.abs(pct).toFixed(1)}%</i>`;
}
function renderTicker(state) {
  const m = state.market;
  if (!m) return;
  const ranked = [...state.agents].sort((x, y) => y.balance - x.balance);
  const items = [
    `<b>ORE</b> ${m.ore.last} ${change(m.ore)}`,
    `<b>FISH</b> ${m.fish.last} ${change(m.fish)}`,
    `<b>WOOD</b> ${m.wood.last} ${change(m.wood)}`,
    `<b>DECISIONS</b> ${fmt(state.decisions ?? 0)}`,
    `<b>HUMANS IN THE LOOP</b> 0`,
    `<b>LOAN BOOK</b> ${fmt(state.economy?.loanBook ?? 0)}`,
    `<b>THEFTS</b> ${state.economy?.thefts ?? 0}`,
    `<b>TAXES</b> ${fmt(state.economy?.taxes ?? 0)}`,
    `<b>DEFAULTS</b> ${state.economy?.defaults ?? 0}`,
    `<b>BUILDINGS</b> ${state.economy?.built ?? 0}`,
    `<b>GDP</b> ${fmt(m.gdp)}`,
    `<b>TRADES</b> ${fmt(m.trades)}`,
    `<b>RICHEST</b> ${ranked[0].name.toUpperCase()} ${fmt(ranked[0].balance)}`,
    `<b>POOREST</b> ${ranked[ranked.length - 1].name.toUpperCase()} ${fmt(ranked[ranked.length - 1].balance)}`,
    `<b>BANK RESERVE</b> ${fmt(state.bank.balance)}`,
    `<b>POPULATION</b> ${state.agents.length}`,
  ].map((x) => `<span>${x}</span>`).join('');
  if (items === tickerHtml) return;
  tickerHtml = items;
  $('#ticker .track').innerHTML = items + items;
}

// How loud a sound at this spot should be, given where the camera is.
function earVolume(p) {
  const d = camera.position.distanceTo(p);
  return Math.max(0, Math.min(1, 1.4 - d / 45));
}

$('#sound').addEventListener('click', async (ev) => {
  ev.stopPropagation();
  const on = await sound.toggle();
  $('#sound').textContent = on ? 'SOUND ON' : 'SOUND OFF';
  $('#sound').classList.toggle('active', on);
});

// ---------- Render loop ----------
const tmp = new THREE.Vector3();
// Labels only show when the camera is close enough to read them, so a busy town doesn't turn into a word cloud.
function project(v, el, dy = 0, maxDist = Infinity) {
  const near = camera.position.distanceTo(v) < maxDist;
  tmp.copy(v);
  tmp.y += dy;
  tmp.project(camera);
  const visible = near && tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
  el.style.visibility = visible ? 'visible' : 'hidden';
  el.style.left = `${(tmp.x * 0.5 + 0.5) * innerWidth}px`;
  el.style.top = `${(-tmp.y * 0.5 + 0.5) * innerHeight}px`;
}

// Place labels give way to the animals' name tags (and to each other) instead of printing on top of them.
let declutterN = 0;
function declutter() {
  const taken = [];
  const rect = (el) => {
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top), w = el.offsetWidth, h = el.offsetHeight;
    return { l: x - w / 2 - 4, r: x + w / 2 + 4, t: y - h - 2, b: y + 2 };
  };
  const hits = (q) => taken.some((o) => q.l < o.r && q.r > o.l && q.t < o.b && q.b > o.t);
  for (const rec of agents.values()) if (rec.tag.style.visibility === 'visible') taken.push(rect(rec.tag));
  for (const p of places) {
    if (p.el.style.visibility !== 'visible') continue;
    const q = rect(p.el);
    // only the text line at the bottom matters (the thin pointer line above it can cross things)
    q.t = q.b - 18;
    const clash = hits(q);
    p.el.classList.toggle('clash', clash);
    if (!clash) taken.push(q);
  }
}

// ---------- Rain ----------
// Showers come and go on a shared schedule (from the clock, so every viewer sees the same weather): the day is
// cut into 12-minute windows and about one in five is rainy, fading in and out over a minute. #rain forces it on.
const RAIN_WINDOW = 12 * 60 * 1000;
function rainAmount() {
  if (location.hash === '#rain') return 1;
  if (location.hash === '#dry') return 0;
  const now = Date.now(), w = Math.floor(now / RAIN_WINDOW);
  const h = (Math.imul(w ^ 0x5bd1e995, 2654435761) >>> 0) % 100;
  if (h >= 20) return 0;
  const into = (now % RAIN_WINDOW) / 60000, left = RAIN_WINDOW / 60000 - into;
  return clamp01(Math.min(into, left)); // ramps over the first and last minute
}
const RAIN_N = 4500, RAIN_BOX = { w: 60, h: 30 };
const rain = (() => {
  const pos = new Float32Array(RAIN_N * 6), seeds = [];
  for (let i = 0; i < RAIN_N; i++) seeds.push([Math.random() - 0.5, Math.random(), Math.random() - 0.5, 0.8 + Math.random() * 0.5]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xb9d3ea, transparent: true, opacity: 0, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.visible = false;
  scene.add(lines);
  return { lines, pos, seeds, t: 0, level: 0 };
})();
const RAIN_GREY = new THREE.Color(0x8d99a6);
function applyRain(target, dt) {
  rain.level += (target - rain.level) * Math.min(1, dt * 0.8);
  const r = rain.level;
  rain.lines.visible = r > 0.02;
  scene.fog.near = 70 - 40 * r;
  scene.fog.far = 210 - 95 * r;
  if (r < 0.005) return;
  // The weather: dimmer sun, greyer sky and fog, shorter view.
  sun.intensity *= 1 - 0.78 * r;
  hemi.intensity *= 1 - 0.3 * r;
  renderer.toneMappingExposure *= 1 - 0.12 * r;
  skyUniforms.top.value.lerp(RAIN_GREY, 0.55 * r);
  skyUniforms.horizon.value.lerp(RAIN_GREY, 0.6 * r);
  scene.fog.color.copy(skyUniforms.horizon.value);
  // The drops: slanted streaks falling through a box that follows the camera's focus.
  rain.t += dt;
  const c = controls.target, p = rain.pos, fall = 28, len = 1.3, wind = 0.25;
  rain.seeds.forEach(([sx, sy, sz, sp], i) => {
    const y = (((sy - rain.t * fall * sp / RAIN_BOX.h) % 1) + 1) % 1;
    const x = c.x + sx * RAIN_BOX.w + (1 - y) * wind * 6, z = c.z + sz * RAIN_BOX.w, top = c.y - 4 + y * RAIN_BOX.h;
    p.set([x, top, z, x - wind * len, top - len, z], i * 6);
  });
  rain.lines.geometry.attributes.position.needsUpdate = true;
  rain.lines.material.opacity = 0.6 * r;
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  const dayT = timeOverride ?? (latest ? (latest.time + (performance.now() - latestAt) / SKY_MS) % 1 : 0.3);
  const hour = applyTime(dayT);
  applyRain(rainAmount(), dt);
  if (latest) {
    const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
    $('#clock').textContent = `DAY ${latest.day} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  for (const rec of agents.values()) {
    const a = rec.data;
    // Between ticks, keep a walking agent moving along its path instead of waiting for the next update.
    const ahead = rec.vel && a.moving ? Math.min(0.3, (performance.now() - rec.tickAt) / 1000) : 0;
    tmp.set(a.x + (ahead ? rec.vel.x * ahead : 0), a.y, a.z + (ahead ? rec.vel.z * ahead : 0));
    rec.pos.lerp(tmp, Math.min(1, dt * 8));
    // Fishing: face the nearest open water (the server's heading is just the last walking direction).
    const fishAim = a.activity === 'fishing' && !a.moving ? waterAim(a.x, a.z, a.heading) : null;
    let dh = (fishAim ? fishAim.heading : a.heading) - rec.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    rec.heading += dh * Math.min(1, dt * 7);
    const g = rec.group;
    g.position.copy(rec.pos);
    g.rotation.y = rec.heading;
    const { legs, body, tail, head, eyes } = g.userData;
    const swing = a.moving ? Math.sin(t * 12) * 0.65 : 0;
    legs.forEach((leg, i) => (leg.rotation.x = i % 3 === 0 ? swing : -swing));
    body.position.y = a.moving ? Math.abs(Math.sin(t * 12)) * 0.09 : Math.sin(t * 2.2) * 0.025;
    // Moods: happy hops, angry steam and head shakes, slumped when broke or starving
    const mood = rec.mood && t - rec.mood.start < 1.6 ? rec.mood : null;
    const low = a.balance < 120 || a.hunger >= 7;
    body.rotation.y = 0;
    if (mood?.kind === 'happy') {
      const k = (t - mood.start) / 0.55;
      if (k < 2) body.position.y += Math.abs(Math.sin(k * Math.PI)) * 0.55;
      if (k < 1) body.rotation.y = k * Math.PI * 2 * (a.species === 'fox' ? 1 : 0);
      if (Math.random() < 0.25) burst(rec.pos.clone().add(new THREE.Vector3(0, 2.9, 0)), 0xffd36b, 1, 1.4, 1, 0.8, 0.8);
    }
    if (head) {
      head.rotation.z = a.say ? Math.sin(t * 7) * 0.08 : Math.sin(t * 0.8) * 0.04;
      head.rotation.y = mood?.kind === 'angry' ? Math.sin(t * 22) * 0.35 : 0;
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, low ? 0.38 : 0, Math.min(1, dt * 3));
    }
    if (mood?.kind === 'angry' && Math.random() < 0.5) {
      const top = rec.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 2.6, (Math.random() - 0.5) * 0.4));
      burst(top, 0x9aa0a6, 1, 0.8, 2.5, 0.9, 2.2);
    }
    if (g.userData.beam) {
      const on = clamp01((nightness - 0.2) * 1.6);
      g.userData.beam.intensity = on * 14;
      g.userData.lamp.material.emissiveIntensity = 0.3 + on * 1.6;
    }
    const blink = (t + rec.pos.x) % 4 < 0.12;
    eyes.forEach((e) => (e.scale.y = blink ? 0.15 : 1));
    if (tail) tail.rotation.y = Math.sin(t * 3) * 0.4;
    const tools = g.userData.tools;
    for (const [k, tl] of Object.entries(tools)) tl.g.visible = a.activity === k;
    if ((a.activity === 'mining' || a.activity === 'chopping' || a.activity === 'building' || a.activity === 'farming') && tools[a.activity]) {
      const tl = tools[a.activity];
      const s = Math.sin(t * (a.activity === 'mining' ? 5 : a.activity === 'building' ? 7 : a.activity === 'farming' ? 3.5 : 6) + rec.pos.x);
      tl.g.rotation.x = -Math.abs(s) * 1.5;
      const hit = s > 0.97;
      if (hit && !rec.swung) {
        const tip = new THREE.Vector3();
        tl.tip.getWorldPosition(tip);
        burst(tip, a.activity === 'mining' ? 0xffa63d : a.activity === 'building' ? 0xd9b07a : a.activity === 'farming' ? 0x7a5a32 : 0xc08850, 6, 3, -11, 0.45, 0.8);
        if (a.activity !== 'farming') sound.thunk(earVolume(tip));
      }
      rec.swung = hit;
    } else if (a.activity === 'fishing') {
      const rod = tools.fishing;
      rod.g.rotation.x = -0.55 + Math.sin(t * 1.5) * 0.06;
      // The bobber floats on the water surface out in front, and the line runs from the rod tip to it.
      if (!fishAim) { rod.tip.position.set(0, -1.15 + Math.sin(t * 3) * 0.05, 1.68); rod.line.position.set(0, -0.35, 1.68); rod.line.scale.set(1, 1, 1); rod.line.quaternion.identity(); }
      else {
      const reach = Math.min(fishAim.dist + 2.5, Math.max(2.4, fishAim.dist + 1.2));
      const fw = rec.heading;
      fishTmp.set(rec.pos.x + Math.sin(fw) * reach, WATER_Y() + Math.sin(t * 3 + rec.pos.x) * 0.05, rec.pos.z + Math.cos(fw) * reach);
      g.updateMatrixWorld(true);
      rod.g.worldToLocal(fishTmp);
      rod.tip.position.copy(fishTmp);
      const line = rod.line;
      fishDir.subVectors(fishTmp, ROD_TIP);
      const len = fishDir.length();
      line.position.copy(ROD_TIP).addScaledVector(fishDir, 0.5);
      line.scale.set(1, len / 1.6, 1);
      line.quaternion.setFromUnitVectors(UP, fishDir.normalize());
      }
    }
    rec.tag.classList.toggle('thinking', !!a.thinking);
    project(rec.pos, rec.tag, 2.5, 60);
    if (a.say) {
      if (rec.lastSay !== a.say) {
        rec.bubble.innerHTML = `<b>${a.name}</b>`;
        rec.bubble.append(document.createTextNode(a.say));
        rec.bubble.style.animation = 'none';
        void rec.bubble.offsetWidth;
        rec.bubble.style.animation = '';
        rec.lastSay = a.say;
        sound.blip();
      }
      rec.bubble.hidden = false;
      project(rec.pos, rec.bubble, 3.15, 70);
    } else {
      rec.bubble.hidden = true;
      rec.lastSay = null;
    }
  }
  for (const p of pops) if (p.el.isConnected) project(p.rec.pos, p.el, 3.5);
  for (let i = pops.length - 1; i >= 0; i--) if (!pops[i].el.isConnected) pops.splice(i, 1);
  for (const p of places) project(p.pos, p.el, 0, walk.on ? Math.min(p.maxDist ?? 110, 24) : p.maxDist ?? 110); // on foot, only nearby signs
  if ((declutterN = (declutterN + 1) % 6) === 0) declutter();
  stepBuildings(t);

  // Atmosphere
  if (waterMat) {
    waterMat.uniforms.time.value = t;
    waterMat.uniforms.skyCol.value.copy(skyUniforms.horizon.value);
    waterMat.uniforms.sunDir.value.copy(skyUniforms.sunDir.value);
    waterMat.uniforms.sunCol.value.copy(sun.color).multiplyScalar(sun.intensity / 2.4);
    waterMat.uniforms.night.value = nightness;
  }
  for (const cl of clouds) {
    cl.position.x += cl.userData.speed * dt;
    if (cl.position.x > 140) cl.position.x = -60;
  }
  for (const p of lanterns) {
    const on = clamp01((nightness - 0.15) * 1.5);
    p.userData.light.intensity = on * 7;
    p.userData.lamp.material.emissiveIntensity = 0.4 + on * 1.6 + Math.sin(t * 9 + p.x) * 0.06 * on;
  }
  if (fireflies.points) {
    const arr = fireflies.points.geometry.attributes.position.array;
    fireflies.base.forEach(([x, y, z, ph], i) => {
      arr[i * 3] = x + Math.sin(t * 0.4 + ph) * 1.2;
      arr[i * 3 + 1] = y + Math.sin(t * 0.7 + ph * 2) * 0.5;
      arr[i * 3 + 2] = z + Math.cos(t * 0.35 + ph) * 1.2;
    });
    fireflies.points.geometry.attributes.position.needsUpdate = true;
    const m = fireflies.points.material;
    m.opacity = 0.15 + nightness * 0.85 * (0.75 + Math.sin(t * 3) * 0.25);
    m.size = (0.25 + nightness * 0.35) * (walk.on ? 0.3 : 1); // up close on foot they'd be huge blobs
    m.color.setHex(nightness > 0.4 ? 0xfff1a8 : 0xffffff);
  }
  stepFish(dt, t);
  stepParticles(dt);
  stepFlights(dt);
  sound.setNight(nightness);
  const camDist = camera.position.distanceTo(controls.target);
  const tilt = clamp01((camDist - 10) / 26) * (REDUCED ? 0.6 : 1);
  tiltH.uniforms.h.value = (tilt * 2.4) / innerWidth;
  tiltV.uniforms.v.value = (tilt * 2.4) / innerHeight;

  // A recording script can take over the camera (used to film the trailers).
  if (window.__cineCam) window.__cineCam({ camera, controls, agents, world, THREE, t, dt });
  else if (walk.on) stepWalk(dt, t);
  else if (film) filmCamera(t, dt);
  else if (camMode !== 'orbit' && agents.has(camMode)) {
    const rec = agents.get(camMode);
    controls.target.lerp(tmp.copy(rec.pos).setY(rec.pos.y + 1.2), Math.min(1, dt * 3));
    camera.position.lerp(rec.pos.clone().add(new THREE.Vector3(8, 6.5, 8)), Math.min(1, dt * 1.5));
  }
  if (!film && !walk.on) controls.update();
  composer.render();
  requestAnimationFrame(frame);
}
frame();

// Outside validation: once an independent validator (Hey Research) has answered Insula's ERC-8004 validation
// request on-chain, a badge in the header links to the details on /verify. Read by the server from the chain.
async function loadValidation() {
  try {
    const v = await fetch('/api/validation').then((r) => r.json());
    const best = (v.validations || []).find((x) => x.response >= 50);
    const el = document.getElementById('valid-link');
    if (!best || !el) return;
    const narrow = window.innerWidth < 600;
    const when = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    el.textContent = narrow ? `✓ ${best.response}` : `✓ VALIDATED ${best.response}/100`;
    el.title = `${best.name || 'An outside validator'} checked on-chain that Insula shipped${best.since ? ` (${when(best.since)} to ${when(best.until)})` : ''}: ${best.response}/100. ERC-8004 validation on Robinhood Chain.`;
    el.hidden = false;
  } catch { /* the badge is optional */ }
}
loadValidation();
setInterval(loadValidation, 30 * 60_000);
