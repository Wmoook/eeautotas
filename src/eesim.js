'use strict';
// eesim.js - bit-exact JavaScript port of scripts/physics/ee_sim.gd (EESim, the exact port of Everybody
// Edits Offline's Player.as / PlayState / World physics) for headless TAS optimization.
//
//   const { loadLevel, EESim, EEInput, applyMask, parseEetas } = require('./eesim.js');
//   const level = loadLevel('tools/tas/data/forgotten_veil.json');   // made by export_level.gd
//   const sim = new EESim(level); sim.reset();
//   const inp = new EEInput();
//   for (const m of parseEetas(text)) { applyMask(inp, m); sim.tick(inp); }
//
// Every floating-point operation mirrors ee_sim.gd one for one, in the same order (GDScript float = IEEE
// double = JS number; the sim keeps no physics state in float32 Vector2s). GDScript int(x) truncates toward
// zero: Math.trunc, or `x | 0` where |x| < 2^31 is guaranteed (world-bounded positions; it also gives +0 for
// x in (-1, 0], like float(int(x))). Every other bitwise op acts on tile coordinates, ids or flags.
// The fast paths (overlaps() classification from precomputed tile masks, the collision-free sub-step loop,
// the single classification of PlayState's three overlaps() calls, fmod without V8's C call) are exact
// shortcuts: each one is argued in place and the whole sim is checked bit for bit against Godot by
// validate.js. See README.md.

const fs = require('fs');

// ------------------------------------------------------------------ Config.as
const MS_PER_TICK = 10;
const MULT = 7.752;
function hexToDouble(h) { return Buffer.from(h, 'hex').readDoubleLE(0); }
// pow(x, 10) * 1.00016093, exact values taken from Godot 4.6.1 (raw little-endian bits).
const BASE_DRAG = hexToDouble('6accf435f866ef3f');
const ICE_NO_MOD_DRAG = hexToDouble('fac64b3b25c8ef3f');
const ICE_DRAG = hexToDouble('bebf054af2f0ef3f');
const NO_MOD_DRAG = hexToDouble('1db5c8e6e3f1ec3f');
const WATER_DRAG = hexToDouble('8dffc581bf70ee3f');
const MUD_DRAG = hexToDouble('1bcd6139b7d8e83f');
const LAVA_DRAG = hexToDouble('b6e3faa08926ea3f');
const TOXIC_DRAG = hexToDouble('1db5c8e6e3f1ec3f');
const DRAG_HEX = {
  BASE_DRAG: '6accf435f866ef3f', ICE_NO_MOD_DRAG: 'fac64b3b25c8ef3f', ICE_DRAG: 'bebf054af2f0ef3f',
  NO_MOD_DRAG: '1db5c8e6e3f1ec3f', WATER_DRAG: '8dffc581bf70ee3f', MUD_DRAG: '1bcd6139b7d8e83f',
  LAVA_DRAG: 'b6e3faa08926ea3f', TOXIC_DRAG: '1db5c8e6e3f1ec3f',
};
const JUMP_HEIGHT = 26.0;
const GRAVITY = 2.0;
const IGRAVITY = 2;                // int(GRAVITY)
const BOOST = 16.0;
const WATER_BUOYANCY = -0.5;
const MUD_BUOYANCY = 0.4;
const LAVA_BUOYANCY = 0.2;
const TOXIC_BUOYANCY = -0.4;
const PING = 0.2;
const CLOCK_BASE = 1000000000000;

// ------------------------------------------------------------------ ItemId.as
const COIN_GOLD = 100, COIN_BLUE = 101;
const CROWN = 5, BRICK_COMPLETE = 121, PORTAL = 242, PORTAL_INVISIBLE = 381, SPAWNPOINT = 255;
const CHECKPOINT = 360;
const SPEED_LEFT = 114, SPEED_RIGHT = 115, SPEED_UP = 116, SPEED_DOWN = 117;
const WATER = 119, MUD = 369, LAVA = 416, TOXIC_WASTE = 1585, FIRE = 368, ICE = 1064;
const SWITCH_PURPLE = 113, RESET_PURPLE = 1619, DOOR_PURPLE = 184, GATE_PURPLE = 185;
const SWITCH_ORANGE = 467, RESET_ORANGE = 1620, DOOR_ORANGE = 1079, GATE_ORANGE = 1080;
const COINDOOR = 43, COINGATE = 165, BLUECOINDOOR = 213, BLUECOINGATE = 214, DEATH_DOOR = 1011, DEATH_GATE = 1012;
const EFFECT_JUMP = 417, EFFECT_RUN = 419, EFFECT_PROTECTION = 420, EFFECT_LOW_GRAVITY = 453;
const EFFECT_MULTIJUMP = 461, EFFECT_GRAVITY = 1517, EFFECT_RESET = 1618;
const PIANO = 77, DRUMS = 83, GUITAR = 1520;
const BLINK_IDS = [411, 412, 413, 414, 460, 1519];
const SPIKE_IDS = [361, 1580, 1625, 1626, 1627, 1628, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636];
const CLIMBABLE_IDS = [120, 118, 98, 99, 424, 459, 460, 472, 1534, 1146, 1563, 1602];
const JUMP_THROUGH_IDS = [61, 62, 63, 64, 89, 90, 91, 96, 97, 122, 123, 124, 125, 126, 127, 146, 154, 158,
  194, 211, 216, 1069, 1087, 1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1050, 1051, 1164,
  1165, 1147, 1148, 1149, 1155, 1160];
const ROT_HALF_IDS = [1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1155];
const HALF_IDS = [1041, 1042, 1043, 1075, 1076, 1077, 1078, 1101, 1102, 1103, 1104, 1105, 1116, 1117, 1118,
  1119, 1120, 1121, 1122, 1123, 1124, 1125, 1140, 1141];
const NONROT_HALF_IDS = [1101, 1102, 1103, 1104, 1105];
const DOOR_IDS = [23, 24, 25, 26, 27, 28, 1005, 1006, 1007, 1008, 1009, 1010, 156, 157, 184, 185, 1079, 1080,
  200, 201, 1094, 1095, 1152, 1153, 43, 213, 1011, 165, 214, 1012, 1027, 1028, 206, 207, 50];
const COLORS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];
function keyColorIndex(id) {
  switch (id) { case 6: return 0; case 7: return 1; case 8: return 2; case 408: return 3; case 409: return 4; case 410: return 5; }
  return -1;
}

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
// per-id extras (second flag table)
const X_KILL = 1, X_BLINK = 2, X_NONROT_HALF = 4;
// per-tile overlap class (static: only coins change at runtime, 100/101 -> 110/111, all class 0)
const OV_AIR = 0, OV_SOLID = 1, OV_COMPLEX = 2, OV_SECRET = 3;

// state-queue record kinds (PlayState.queue callables)
const SQ_CROWN = 0, SQ_SILVER = 1, SQ_ORANGE = 2;

// ------------------------------------------------------------------ Godot RandomNumberGenerator (PCG32)
const M64 = (1n << 64n) - 1n;
const PCG_MUL = 6364136223846793005n;
const PCG_INC = ((1442695040888963407n << 1n) | 1n) & M64;   // RandomPCG default inc, pcg32_srandom_r
function pcgStep(s) { return (s * PCG_MUL + PCG_INC) & M64; }
function pcgOut(old) {
  const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xFFFFFFFFn);
  const rot = Number(old >> 59n);
  return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
}
function pcgSeedState(seed) {   // RandomNumberGenerator.seed = x -> pcg32_srandom_r(state, x, inc)
  let s = 0n; s = pcgStep(s); s = (s + BigInt(seed)) & M64; s = pcgStep(s); return s;
}
const RNG_SEED_STATE = pcgSeedState(0x5EED);

// ------------------------------------------------------------------ World.offset table (for stateKey)
// _offset is 0 at reset() and += 0.3 every tick, so _offset == OFFSETS[_ticks] exactly.
let OFFSETS = new Float64Array([0]);
function ensureOffsets(n) {
  if (OFFSETS.length > n) return;
  let len = OFFSETS.length;
  let size = len;
  while (size <= n) size *= 2;
  const t = new Float64Array(size);
  t.set(OFFSETS);
  let o = OFFSETS[len - 1];
  for (let i = len; i < size; i++) { o += 0.3; t[i] = o; }
  OFFSETS = t;
}
// First tick n at which ((OFFSETS[n] - timer) / 30.0) >= 5.0 (the key-expiry / time-door condition).
function expiryTick(timer, atLeast) {
  ensureOffsets(atLeast + 2048);
  let lo = 0, hi = OFFSETS.length;
  if (((OFFSETS[hi - 1] - timer) / 30.0) < 5.0) { ensureOffsets(hi * 2 + 4096); hi = OFFSETS.length; }
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (((OFFSETS[mid] - timer) / 30.0) >= 5.0) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// ------------------------------------------------------------------ level loading
function buildFlags(n) {
  const flags = new Uint8Array(n);
  const extra = new Uint8Array(n);
  const has = (arr) => { const s = new Set(arr); return (id) => s.has(id); };
  const climbS = has(CLIMBABLE_IDS), jtS = has(JUMP_THROUGH_IDS), rhS = has(ROT_HALF_IDS), hS = has(HALF_IDS);
  const dS = has(DOOR_IDS), spS = has(SPIKE_IDS), blS = has(BLINK_IDS), nrS = has(NONROT_HALF_IDS);
  for (let id = 0; id < n; id++) {
    let f = 0;
    const climb = climbS(id);
    if (!climb && ((9 <= id && id <= 97) || (122 <= id && id <= 217) || (id >= 1001 && id <= 1499)) && id !== 83 && id !== 77) f |= F_SOLID;
    if (climb) f |= F_CLIMB;
    if (jtS(id)) f |= F_JUMPTHRU;
    if (rhS(id)) f |= F_ROTHALF;
    if (hS(id)) f |= F_HALF;
    if (dS(id)) f |= F_DOOR;
    if (id === WATER || id === MUD || id === LAVA || id === TOXIC_WASTE) f |= F_LIQUID;
    if (id >= SPEED_LEFT && id <= SPEED_DOWN) f |= F_BOOST;
    flags[id] = f;
    let x = 0;
    if (id === FIRE || spS(id)) x |= X_KILL;
    if (blS(id)) x |= X_BLINK;
    if (nrS(id)) x |= X_NONROT_HALF;
    extra[id] = x;
  }
  return { flags, extra };
}

/** Loads a level exported by tools/tas/export_level.gd (JSON with base64 layers). Read-only, shareable. */
function loadLevel(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return prepareLevel(d);
}

function prepareLevel(d) {
  const W = d.width | 0, H = d.height | 0, N = W * H;
  const fgBuf = Buffer.from(d.fg_b64, 'base64');
  if (fgBuf.length !== N * 4) throw new Error('fg size mismatch');
  const fg = new Int32Array(N);
  let maxId = 0;
  for (let i = 0; i < N; i++) {
    const v = fgBuf.readInt32LE(i * 4);
    if (v < 0) throw new Error('negative block id ' + v + ' at ' + i + ' (unsupported)');
    fg[i] = v;
    if (v > maxId) maxId = v;
  }
  let bg = null;
  if (d.bg_b64) {
    const b = Buffer.from(d.bg_b64, 'base64');
    bg = new Int32Array(N);
    for (let i = 0; i < N; i++) bg[i] = b.readInt32LE(i * 4);
  }
  const gravity = d.gravity_hex ? hexToDouble(d.gravity_hex) : +d.gravity;
  const nFlags = Math.max(4096, maxId + 1);
  const { flags, extra } = buildFlags(nFlags);

  // EESim.reset(): extras in Dictionary insertion order
  const lookup0 = new Int32Array(N);
  const portalSlot = new Int32Array(N).fill(-1);
  const pId = [], pTarget = [], pRot = [];
  const byId = new Map();                     // portal id -> {xs, ys} (px positions, <<4), extra order
  const cd = new Set(), bcd = new Set();
  for (const e of d.extras) {
    const i = e[0], rotation = e[1], id = e[2], target = e[3];
    const t = fg[i];
    if (t === PORTAL || t === PORTAL_INVISIBLE) {
      const px = id === null || id === undefined ? 0 : id;
      const tg = target === null || target === undefined ? 0 : target;
      const rt = rotation === null || rotation === undefined ? 0 : rotation;
      let slot = portalSlot[i];
      if (slot < 0) { slot = pId.length; portalSlot[i] = slot; pId.push(0); pTarget.push(0); pRot.push(0); }
      pId[slot] = px; pTarget[slot] = tg; pRot[slot] = rt;
      if (!byId.has(px)) byId.set(px, { xs: [], ys: [] });
      const l = byId.get(px);
      l.xs.push((i % W) << 4); l.ys.push(Math.floor(i / W) << 4);
    } else if (rotation !== null && rotation !== undefined) {
      lookup0[i] = rotation;
      if (t === COINDOOR || t === COINGATE) cd.add(rotation);
      else if (t === BLUECOINDOOR || t === BLUECOINGATE) bcd.add(rotation);
    }
  }
  const portalsById = new Map();
  let multiTarget = false;
  for (const [k, v] of byId) {
    portalsById.set(k, { xs: Int32Array.from(v.xs), ys: Int32Array.from(v.ys), n: v.xs.length });
  }
  for (let s = 0; s < pId.length; s++) {
    const l = portalsById.get(pTarget[s]);
    if (pTarget[s] !== pId[s] && l && l.n > 1) multiTarget = true;
  }
  const spX = [], spY = [];
  let hasTimeDoors = false, hasCoinGate = false, hasBlueCoinGate = false, hasDeathDoor = false, hasDeathGate = false;
  let clockSensitive = false;   // key tiles or time doors: World.offset periods (500 or 501 ticks) can start
  const coinTiles = [], secretTiles = [];
  const coinBit = new Int32Array(N).fill(-1), secretBit = new Int32Array(N).fill(-1);
  const ovl = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = fg[i];
    if (t === SPAWNPOINT) { spX.push(i % W); spY.push(Math.floor(i / W)); }
    else if (t === 156 || t === 157) hasTimeDoors = true;
    if (t === COINGATE) hasCoinGate = true;
    if (t === BLUECOINGATE) hasBlueCoinGate = true;
    if (t === DEATH_DOOR || t === DEATH_GATE) hasDeathDoor = true;
    if (t === DEATH_GATE) hasDeathGate = true;
    if (t === 6 || t === 7 || t === 8 || t === 408 || t === 409 || t === 410 || t === 156 || t === 157) clockSensitive = true;
    if (t === COIN_GOLD || t === COIN_BLUE) { coinBit[i] = coinTiles.length; coinTiles.push(i); }
    if (t === 50 || t === 243) { secretBit[i] = secretTiles.length; secretTiles.push(i); }
    const f = flags[t];
    if ((f & F_SOLID) === 0) ovl[i] = t === 243 ? OV_SECRET : OV_AIR;
    else if ((f & (F_ROTHALF | F_HALF | F_JUMPTHRU | F_DOOR)) !== 0) ovl[i] = OV_COMPLEX;
    else ovl[i] = OV_SOLID;
  }
  // tileMask[y*W+x] describes the tiles (x+dx, y+dy): bit (dx + 3*dy), dx,dy in 0..2 = plain air (OV_AIR);
  // bit 9 + (dx + 3*dy), dx,dy in 0..1 = plain static solid (OV_SOLID); out of bounds = neither.
  // The four tiles of a box (x2, y2 = it spans a 2nd column / row) are bits 0, 1, 3, 4, i.e. overlaps()'s
  // scan order is ascending bit order: all air -> overlaps() returns 0 (side effect: overlapa..d = -1);
  // lowest non-air bit a static solid -> it returns that tile (no side effects). Else it needs the full scan.
  const airMask = new Uint16Array(N);
  const cls = (x, y) => (x < W && y < H) ? ovl[y * W + x] : -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const c = cls(x + dx, y + dy);
          if (c === OV_AIR) m |= 1 << (dx + 3 * dy);
          else if (c === OV_SOLID && dx < 2 && dy < 2) m |= 1 << (9 + dx + 3 * dy);
        }
      }
      airMask[y * W + x] = m;
    }
  }
  // 2D prefix sums of tiles that are not plain air (for the collision-free sub-step loop check)
  const W1 = W + 1;
  const airPS = new Int32Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      if (ovl[y * W + x] !== OV_AIR) row++;
      airPS[(y + 1) * W1 + x + 1] = airPS[y * W1 + x + 1] + row;
    }
  }
  // Gravity tables (Player.tick's two `match` blocks): current tile -> morx, mory (int), rotate_mor, kill;
  // delayed tile -> mox, moy (float), rotate_mo. Same values as the GDScript literals.
  const gMorx = new Int8Array(nFlags), gMory = new Int8Array(nFlags);
  const gMox = new Float64Array(nFlags), gMoy = new Float64Array(nFlags);
  const gFlags = new Uint8Array(nFlags);   // 1 rotate_mor, 2 rotate_mo, 4 kill (when not dead / invulnerable)
  for (let id = 0; id < nFlags; id++) {
    let morx = 0, mory = 0, rmor = true, kill = false;
    let mox = 0.0, moy = 0.0, rmo = true;
    if ((flags[id] & F_CLIMB) !== 0) {
      morx = 0; mory = 0; mox = 0.0; moy = 0.0;
    } else {
      switch (id) {
        case 1: case 411: morx = -IGRAVITY; mory = 0; rmor = false; mox = -GRAVITY; moy = 0.0; rmo = false; break;
        case 2: case 412: morx = 0; mory = -IGRAVITY; rmor = false; mox = 0.0; moy = -GRAVITY; rmo = false; break;
        case 3: case 413: morx = IGRAVITY; mory = 0; rmor = false; mox = GRAVITY; moy = 0.0; rmo = false; break;
        case 1518: case 1519: morx = 0; mory = IGRAVITY; rmor = false; mox = 0.0; moy = GRAVITY; rmo = false; break;
        case SPEED_LEFT: case SPEED_RIGHT: case SPEED_UP: case SPEED_DOWN: case 4: case 414:
          morx = 0; mory = 0; mox = 0.0; moy = 0.0; break;
        case WATER: morx = 0; mory = Math.trunc(WATER_BUOYANCY) + 0; mox = 0.0; moy = WATER_BUOYANCY; break;
        case MUD: morx = 0; mory = Math.trunc(MUD_BUOYANCY) + 0; mox = 0.0; moy = MUD_BUOYANCY; break;
        case LAVA: morx = 0; mory = Math.trunc(LAVA_BUOYANCY) + 0; mox = 0.0; moy = LAVA_BUOYANCY; break;
        case TOXIC_WASTE: morx = 0; mory = Math.trunc(TOXIC_BUOYANCY) + 0; kill = true; mox = 0.0; moy = TOXIC_BUOYANCY; break;
        default:
          morx = 0; mory = IGRAVITY; mox = 0.0; moy = GRAVITY;
          if ((extra[id] & X_KILL) !== 0) kill = true;
      }
    }
    gMorx[id] = morx; gMory[id] = mory; gMox[id] = mox; gMoy[id] = moy;
    gFlags[id] = (rmor ? 1 : 0) | (rmo ? 2 : 0) | (kill ? 4 : 0);
  }
  return {
    id: d.level_id, file: d.level_file, width: W, height: H, gravity,
    gravityMult: gravity > 0.0 ? gravity : 1.0,
    fg, bg, lookup0, flags, xflags: extra, ovl, airMask, airPS, gMorx, gMory, gMox, gMoy, gFlags,
    portalSlot, pId: Int32Array.from(pId), pTarget: Int32Array.from(pTarget), pRot: Int32Array.from(pRot),
    portalsById, multiTargetPortals: multiTarget, rngScript: Array.isArray(d.rng_script) ? Int32Array.from(d.rng_script) : null,
    coinDoorThresholds: Int32Array.from([...cd].sort((a, b) => a - b)),
    blueCoinDoorThresholds: Int32Array.from([...bcd].sort((a, b) => a - b)),
    spawnsX: Int32Array.from(spX), spawnsY: Int32Array.from(spY),
    hasTimeDoors, hasCoinGate, hasBlueCoinGate, hasDeathDoor, hasDeathGate, clockSensitive,
    coinTiles: Int32Array.from(coinTiles), coinBit, coinWords: Math.max(1, Math.ceil(coinTiles.length / 32)),
    secretTiles: Int32Array.from(secretTiles), secretBit, secretWords: Math.max(1, Math.ceil(secretTiles.length / 32)),
  };
}

// ------------------------------------------------------------------ input
class EEInput {
  constructor() {
    this.left = false; this.right = false; this.up = false; this.down = false;
    this.jump = false;
    this.jump_pressed = false;   // press edge (EESim clears it after use)
    this.god_toggle = false;     // G pressed (EESim clears it after use)
  }
  clear() {
    this.left = false; this.right = false; this.up = false; this.down = false;
    this.jump = false; this.jump_pressed = false; this.god_toggle = false;
  }
  copy_from(o) {
    this.left = o.left; this.right = o.right; this.up = o.up; this.down = o.down;
    this.jump = o.jump; this.jump_pressed = o.jump_pressed; this.god_toggle = o.god_toggle;
  }
}

/** eeo-tas replay semantics (EETas.next): 1 jump (sets jump AND jump_pressed), 2 left, 4 right, 8 up, 16 down. */
function applyMask(input, m) {
  const j = (m & 1) !== 0;
  input.jump = j;
  input.jump_pressed = j;
  input.left = (m & 2) !== 0;
  input.right = (m & 4) !== 0;
  input.up = (m & 8) !== 0;
  input.down = (m & 16) !== 0;
  input.god_toggle = false;
  return input;
}

/** .eetas text -> Uint8Array of masks (EETas.load_file: strip_edges, clampi(ord(c) - 48, 0, 31)). */
function parseEetas(text) {
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // Godot skips a UTF-8 BOM
  let b = 0, e = text.length;
  while (b < e && text.charCodeAt(b) <= 32) b++;
  while (e > b && text.charCodeAt(e - 1) <= 32) e--;
  const out = [];
  for (const ch of text.slice(b, e)) {
    let m = ch.codePointAt(0) - 48;
    if (m < 0) m = 0; else if (m > 31) m = 31;
    out.push(m);
  }
  return Uint8Array.from(out);
}

// fmod(x, 1.0) and fmod(x, 16.0) without V8's slow C fmod call. For x > 0 these are exact: x - trunc(x)
// and x - 16*floor(x/16) are exactly representable (Sterbenz), and equal fmod mathematically. x <= 0
// (+-0 keeps its sign in fmod; negative positions never happen) falls back to %, which is IEEE fmod.
function fmod1(x) { return x > 0.0 ? x - Math.trunc(x) : x % 1.0; }
function fmod16(x) { return x > 0.0 ? x - 16.0 * Math.floor(x * 0.0625) : x % 16.0; }
// ((d / 30.0) >= 5.0) === (d >= 150.0) for every double d: IEEE division is monotone and the doubles next to
// 150 fall on the expected sides (checked here at load time, so a surprise can never go unnoticed).
const PERIOD_150 = 150.0;
(() => {
  const f = new Float64Array(1), u = new BigUint64Array(f.buffer);
  for (let k = -4; k <= 4; k++) {
    f[0] = 150.0; u[0] += BigInt(k);
    if ((f[0] / 30.0 >= 5.0) !== (f[0] >= PERIOD_150)) throw new Error('eesim: period threshold check failed');
  }
})();
const AIR_REQ = [1, 3, 9, 27];   // tileMask bits of a box covering 1x1, 2x1, 1x2, 2x2 tiles
const REQ3 = [1, 3, 7, 9, 27, 63, 73, 219, 511];   // tileMask bits of a w x h region, index (w-1) + 3*(h-1)
function signi(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }  // int(signf(x))

const EMPTY_Q = Object.freeze([]);

// ------------------------------------------------------------------ the simulator
class EESim {
  constructor(level) {
    if (!level || !level.fg) throw new Error('EESim needs a level from loadLevel()');
    this.level = level;
    this.onEvent = null;
    /** stateKey(): also key the held-jump timer and edge (only needed for inputs with jump && !jump_pressed). */
    this.stateKeyRawInput = false;
    this.rngScript = level.rngScript || null;   // EEO mode (see _randiRange)
    this.rngNeed = 0;
    const W = level.width, H = level.height;
    this.width = W; this.height = H;
    this._maxX = W * 16 - 16; this._maxY = H * 16 - 16;
    this._flags = level.flags; this._xflags = level.xflags; this._ovl = level.ovl; this._airMask = level.airMask;
    this._airPS = level.airPS;
    this._loopCollided = false;   // performance hint only (not state): last sub-step loop hit something
    this.tiles = new Int32Array(level.fg);           // live layer 0 (coins -> 110/111)
    this._lookup = new Int32Array(level.lookup0);    // Lookup.getInt
    this.world_gravity_multiplier = 1.0;
    // public state
    this.px = 16.0; this.py = 16.0; this.prev_px = 16.0; this.prev_py = 16.0;
    this.speed_x = 0.0; this.speed_y = 0.0;
    this.gravity_dir = { x: 0, y: 1 };
    this.on_ground = false; this.is_dead = false; this.in_god_mode = false;
    this.coins = 0; this.blue_coins = 0; this.has_crown = false;
    this.has_silver_crown = false; this.deaths = 0;
    this.checkpoint = { x: -1, y: -1 };
    this.teleported = false;
    this.modifier_x = 0.0; this.modifier_y = 0.0;
    this.current_tile = 0; this.flip_gravity = 0; this.jump_count = 0; this.max_jumps = 1;
    this.jump_boost = 0; this.speed_boost = 0; this.low_gravity = false; this.is_invulnerable = false;
    this.is_on_fire = false; this.run_ticks = 0;
    this.morx = 0; this.mory = 0; this.mox = 0.0; this.moy = 0.0;
    // world state
    this._next_spawn = 0;
    this._keysMask = 0;                        // _keys (bit c = COLORS[c])
    this._kt = new Float64Array(6);            // _keys_timer
    this._offset = 0.0;
    this._timedoor_state = false; this._hide_timedoor_offset = 0.0;
    this._show_coin_gate = 0; this._show_blue_coin_gate = 0; this._show_death_gate = 0;
    this._switches = new Map(); this._swOwned = true;           // purple (per player), copy-on-write
    this._oswitches = new Map(); this._oswOwned = true;         // orange
    this._evSwitches = new Map(); this._evSwOwned = true;
    this._evOSwitches = new Map(); this._evOSwOwned = true;
    this._collide_crown = false; this._collide_silver_crown = false;
    this._stateQueue = [];   // flat triples [kind, a, b]
    this._keysQueue = [];    // flat pairs [color, state]
    this._tileQueue = [];    // flat pairs [sid, enabled]
    this._coinBits = new Int32Array(level.coinWords); this._coinOwned = true;
    this._secretBits = new Int32Array(level.secretWords); this._secretOwned = true;
    this._rngState = RNG_SEED_STATE; this._rngSteps = 0;
    // player internals
    this._ticks = 0;
    this._q0 = 0; this._q1 = 0;               // _queue (length 2)
    this._last_jump = 0.0; this._slippery = 0.0;
    this._pastx = 0; this._pasty = 0;
    this._ox = 0.0; this._oy = 0.0;
    this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
    this._last_portal_set = true; this._last_portal_x = 0; this._last_portal_y = 0;
    this._dead_offset = 0.0; this._fire_time_start = 0.0; this._fire_duration = 0.0;
    this._horizontal = 0; this._vertical = 0;
    this._spacedown = false; this._spacejustdown = false; this._prev_jump_held = false;
    this._mx = 0.0; this._my = 0.0;
    this._current = 0;
    // movement-loop temporaries
    this._rem_x = 0.0; this._rem_y = 0.0; this._cur_sx = 0.0; this._cur_sy = 0.0;
    this._osx = 0.0; this._osy = 0.0; this._donex = false; this._doney = false;
    this._grounded = false; this._land_speed = 0.0;
    // diff-event state
    this._evKeysMask = 0; this._ev_coins = 0; this._ev_bcoins = 0; this._ev_timedoor = false;
    this._ev_grav_x = 0; this._ev_grav_y = 1;
    this._switch_dirty = false;
    // stateKey scratch
    this._keyBuf = null; this._keyF = null; this._keyI = null; this._keyBytes = null; this._keyDoubleOff = 0;
    this._keyColors = [];
    this._ktCacheT = new Float64Array(6).fill(NaN); this._ktCacheN = new Float64Array(6);
    this.reset();
  }

  // ================================================================ public API

  /** Fresh start, like loading the level (EESim.reset). */
  reset() {
    const L = this.level;
    this.width = L.width; this.height = L.height;
    this.world_gravity_multiplier = L.gravityMult;
    this.tiles.set(L.fg);
    this._lookup.set(L.lookup0);
    this._coinBits = new Int32Array(L.coinWords); this._coinOwned = true;
    this._secretBits = new Int32Array(L.secretWords); this._secretOwned = true;
    this._next_spawn = 0;
    this._keysMask = 0;
    this._kt.fill(0.0);
    this._offset = 0.0;
    this._timedoor_state = false;
    this._hide_timedoor_offset = 0.0;
    this._show_coin_gate = 0; this._show_blue_coin_gate = 0; this._show_death_gate = 0;
    this._oswitches = new Map(); this._oswOwned = true;
    this._switches = new Map(); this._swOwned = true;
    this._evSwitches = new Map(); this._evSwOwned = true;
    this._evOSwitches = new Map(); this._evOSwOwned = true;
    this._switch_dirty = false;
    this._stateQueue.length = 0; this._keysQueue.length = 0; this._tileQueue.length = 0;
    this._rngState = RNG_SEED_STATE; this._rngSteps = 0;
    this._ticks = 0;
    this._q0 = 0; this._q1 = 0;
    this._last_jump = -(CLOCK_BASE + this._ticks * MS_PER_TICK);
    this._slippery = 0.0;
    this._pastx = 0; this._pasty = 0;
    this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
    this._last_portal_set = true; this._last_portal_x = 0; this._last_portal_y = 0;
    this.has_crown = false; this.has_silver_crown = false;
    this._collide_crown = false; this._collide_silver_crown = false;
    this.coins = 0; this.blue_coins = 0; this.deaths = 0;
    this.checkpoint.x = -1; this.checkpoint.y = -1;
    this.flip_gravity = 0; this.jump_count = 0; this.max_jumps = 1; this.jump_boost = 0; this.speed_boost = 0;
    this.low_gravity = false; this.is_invulnerable = false; this.is_on_fire = false;
    this.is_dead = false; this._dead_offset = 0.0;
    this.run_ticks = 0;
    this.speed_x = 0.0; this.speed_y = 0.0; this.modifier_x = 0.0; this.modifier_y = 0.0;
    this.morx = 0; this.mory = 0; this.mox = 0.0; this.moy = 0.0;
    this._horizontal = 0; this._vertical = 0; this._spacedown = false; this._spacejustdown = false; this._prev_jump_held = false;
    this.on_ground = false;
    this.gravity_dir.x = 0; this.gravity_dir.y = 1;
    this.px = 16.0; this.py = 16.0;
    this._placeAtSpawn(false);
    this._ox = this.px; this._oy = this.py;
    this.prev_px = this.px; this.prev_py = this.py;
    this.teleported = true;
    this._evKeysMask = this._keysMask; this._ev_coins = 0; this._ev_bcoins = 0; this._ev_timedoor = false;
    this._ev_grav_x = this.gravity_dir.x; this._ev_grav_y = this.gravity_dir.y;
    if (this.onEvent !== null) this.onEvent('respawn', { pos: { x: this.px, y: this.py } });
  }

  ticks() { return this._ticks; }

  is_key_active(color) { const c = COLORS.indexOf(color); return c >= 0 && (this._keysMask & (1 << c)) !== 0; }
  is_switch_on(id) { return this._switches.get(id) === true; }
  is_orange_switch_on(id) { return this._oswitches.get(id) === true; }
  get_tile_number(tx, ty) { return this._lookupAt(tx, ty); }
  key_time_left(color) {
    const c = COLORS.indexOf(color);
    if (c < 0 || (this._keysMask & (1 << c)) === 0 || this.key_expiry_pending(color)) return 0.0;
    return Math.max(0.0, 5.0 - (this._offset - this._kt[c]) / 30.0);
  }
  key_expiry_pending(color) {
    const c = COLORS.indexOf(color);
    if (c < 0 || (this._keysMask & (1 << c)) === 0) return false;
    const q = this._keysQueue;
    for (let i = 0; i < q.length; i += 2) if (q[i] === c && q[i + 1] === 0) return true;
    return false;
  }
  is_tile_solid_now(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    const i = ty * this.width + tx;
    const val = this.tiles[i];
    const fl = this._flags[val];
    if ((fl & F_SOLID) === 0) return false;
    if ((fl & F_DOOR) !== 0) return !this._doorPassable(val, i);
    return true;
  }
  is_tile_one_way(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return (this._flags[this.tiles[ty * this.width + tx]] & F_JUMPTHRU) !== 0;
  }
  is_coin_collected(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    const t = this.tiles[ty * this.width + tx];
    return t === 110 || t === 111;
  }
  is_secret_revealed(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    const b = this.level.secretBit[ty * this.width + tx];
    return b >= 0 && ((this._secretBits[b >> 5] >>> (b & 31)) & 1) !== 0;
  }
  get_tile(tx, ty) { return this._getTile(tx, ty); }
  get_portal(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return null;
    const s = this.level.portalSlot[ty * this.width + tx];
    return s < 0 ? null : { id: this.level.pId[s], target: this.level.pTarget[s], rotation: this.level.pRot[s] };
  }
  set_god_mode(on) {
    if (on === this.in_god_mode) return;
    this.in_god_mode = on;
    this.is_dead = false;
    if (this.onEvent !== null) this.onEvent('god_mode', { on: this.in_god_mode });
  }
  /** Player.respawn() */
  respawn() {
    this.modifier_x = 0.0; this.modifier_y = 0.0;
    this.speed_x = 0.0; this.speed_y = 0.0;
    this.is_dead = false;
    this.is_on_fire = false;
    this._tileQueue.length = 0;
    this._placeAtSpawn(true);
    this.teleported = true;
    if (this.onEvent !== null) this.onEvent('respawn', { pos: { x: this.px, y: this.py } });
  }
  /** Player.killPlayer() */
  kill_player() {
    if (!this.in_god_mode && !this.is_dead) {
      this.is_dead = true;
      if (this.onEvent !== null) this.onEvent('death', { pos: { x: this.px, y: this.py } });
    }
  }

  // ================================================================ tick

  /** Exactly one original EE physics tick (10 ms). Mutates input.jump_pressed / god_toggle like EESim. */
  tick(input) {
    this.prev_px = this.px;
    this.prev_py = this.py;
    this.teleported = false;
    this._ticks++;
    // --- PlayState.tick(): three overlaps() at the same box, each can revert one deferred gate value.
    // When the box takes a fast path (all air / first tile a static solid / out of the world / god mode) all
    // three calls give the same result with idempotent side effects (coin, blue coin and death gates are
    // complex tiles, which never take a fast path), so it is classified once.
    const cls = this._ovClass(this.px, this.py);
    if (cls === 0) {
      this._show_coin_gate = this.coins;
      this._show_blue_coin_gate = this.blue_coins;
      this._show_death_gate = this.deaths;
    } else if (cls < 0) {
      let old = this._show_coin_gate;
      this._show_coin_gate = this.coins;
      if (this._overlaps() !== 0) this._show_coin_gate = old;
      old = this._show_blue_coin_gate;
      this._show_blue_coin_gate = this.blue_coins;
      if (this._overlaps() !== 0) this._show_blue_coin_gate = old;
      old = this._show_death_gate;
      this._show_death_gate = this.deaths;
      if (this._overlaps() !== 0) this._show_death_gate = old;
    }
    if (input.god_toggle) {
      input.god_toggle = false;
      this.in_god_mode = !this.in_god_mode;
      this.is_dead = false;
      if (this.onEvent !== null) this.onEvent('god_mode', { on: this.in_god_mode });
    }
    // --- World.update()
    this._offset += 0.3;
    if ((this._offset - this._hide_timedoor_offset) >= PERIOD_150) {   // == ((o - h) / 30.0) >= 5.0
      this._hide_timedoor_offset = this._offset;
      this._timedoor_state = !this._timedoor_state;
    }
    if (this._keysMask !== 0) {
      for (let c = 0; c < 6; c++) {
        if ((this._keysMask & (1 << c)) !== 0 && ((this._offset - this._kt[c]) / 30.0) >= 5.0) this._switchKey(c, false, false);
      }
    }
    // --- Player.tick()
    this._playerTick(input);
    // --- PlayState.enterFrame(): queue, then keysquene
    if (this._stateQueue.length !== 0) {
      const q = this._stateQueue;
      let n = q.length / 3;
      while (n > 0) {
        n--;
        const kind = q.shift(), a = q.shift(), b = q.shift();
        if (kind === SQ_CROWN) this._checkCrown(a !== 0);
        else if (kind === SQ_SILVER) this._checkSilverCrown(a !== 0);
        else this._pressOrangeSwitch(a, b !== 0);
      }
    }
    if (this._keysQueue.length !== 0) {
      const q = this._keysQueue;
      let n = q.length / 2;
      while (n > 0) {
        n--;
        const c = q.shift(), st = q.shift();
        this._switchKey(c, st !== 0, true);
      }
    }
    // --- Player.draw(): death animation finished -> respawn
    if (this.is_dead && this._dead_offset > 16.0) {
      this.respawn();
      this.deaths++;
    }
    this._emitDiffs();
  }

  _playerTick(input) {
    const flags = this._flags;
    const W = this.width;
    const now = CLOCK_BASE + this._ticks * MS_PER_TICK;
    const isgodmod = this.in_god_mode;
    if (this.is_dead) this._dead_offset += 0.3;
    else this._dead_offset = 0.0;
    if (!this.is_dead && this.is_on_fire) {
      if (this._fire_duration !== 0.0 && now - this._fire_time_start > this._fire_duration * 1000.0) this.kill_player();
    }

    let cx = Math.trunc(this.px + 8.0) >> 4;
    let cy = Math.trunc(this.py + 8.0) >> 4;

    let delayed = this._q0;
    this._q0 = this._q1;                          // _queue_shift()
    let current = this._getTile(cx, cy);
    if ((flags[current] & F_HALF) !== 0) {
      let rot = (cx >= 0 && cy >= 0 && cx < W && cy < this.height) ? this._lookup[cy * W + cx] : 0;
      if ((this._xflags[current] & X_NONROT_HALF) !== 0) rot = 1;
      if (rot === 1) cy -= 1;
      if (rot === 0) cx -= 1;
      current = this._getTile(cx, cy);
    }
    this._current = current;
    this.current_tile = current;

    const currentBelow = this._getCurrentBelow(current, cx, cy);
    this._q1 = current;                           // _queue_push(current)
    if (current === 4 || current === 414 || (flags[current] & F_CLIMB) !== 0) {
      delayed = this._q0;
      this._q0 = this._q1;
      this._q1 = current;
    }

    if (this._tileQueue.length !== 0) {
      const q = this._tileQueue;
      let ql = q.length / 2;
      while (ql > 0) {
        ql--;
        const sid = q.shift(), en = q.shift();
        this._pressPurpleSwitch(sid, en !== 0);
      }
    }

    // --- Me.getPlayerInput()
    const ij = !!input.jump;
    this._horizontal = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    this._vertical = (input.up ? -1 : 0) + (input.down ? 1 : 0);
    this._spacedown = ij;
    this._spacejustdown = !!input.jump_pressed || (ij && !this._prev_jump_held);
    this._prev_jump_held = ij;
    input.jump_pressed = false;

    if (this.is_dead) {
      this._spacejustdown = false;
      this._spacedown = false;
      this._horizontal = 0;
      this._vertical = 0;
    }

    let rotateMo = true;
    let rotateMor = true;
    let morx = 0, mory = 0;
    let mox = 0.0, moy = 0.0;

    if (!isgodmod) {
      // the two `match` blocks of Player.tick, table driven (see prepareLevel)
      const L = this.level;
      const gfc = L.gFlags[current];
      morx = L.gMorx[current]; mory = L.gMory[current];
      rotateMor = (gfc & 1) !== 0;
      if ((gfc & 4) !== 0 && !this.is_dead && !this.is_invulnerable) this.kill_player();
      mox = L.gMox[delayed]; moy = L.gMoy[delayed];
      rotateMo = (L.gFlags[delayed] & 2) !== 0;
    }

    switch (this.flip_gravity) {
      case 1:
        if (rotateMo) { const t = mox; mox = -moy; moy = t; }
        if (rotateMor) { const it = morx; morx = 0 - mory; mory = it; }
        break;
      case 2:
        if (rotateMo) { mox = -mox; moy = -moy; }
        if (rotateMor) { morx = 0 - morx; mory = 0 - mory; }
        break;
      case 3:
        if (rotateMo) { const t = mox; mox = moy; moy = -t; }
        if (rotateMor) { const it = morx; morx = mory; mory = 0 - it; }
        break;
      case 4:
        if (rotateMo) { mox = 0.0; moy = 0.0; }
        if (rotateMor) { morx = 0; mory = 0; }
        break;
    }

    let mx, my;
    if ((flags[delayed] & F_LIQUID) !== 0) { mx = this._horizontal; my = this._vertical; }
    else if (moy !== 0.0) { mx = this._horizontal; my = 0.0; }
    else if (mox !== 0.0) { mx = 0.0; my = this._vertical; }
    else { mx = this._horizontal; my = this._vertical; }

    let sm = 1.0;                                 // _speed_multiplier()
    if (this.speed_boost === 1) sm *= 1.5;
    if (this.speed_boost === 2) sm *= 0.6;
    mx *= sm;
    my *= sm;
    let gm = 1.0;                                 // _gravity_multiplier()
    if (this.low_gravity) gm *= 0.15;
    gm *= this.world_gravity_multiplier;
    mox *= gm;
    moy *= gm;
    this._mx = mx; this._my = my;
    this.morx = morx; this.mory = mory; this.mox = mox; this.moy = moy;

    this.modifier_x = (mox + mx) / MULT;
    this.modifier_y = (moy + my) / MULT;

    const climbCur = (flags[current] & F_CLIMB) !== 0;
    if (currentBelow === ICE && !climbCur && current !== 4 && current !== 414) this._slippery = 2.0;
    else if ((flags[currentBelow] & F_SOLID) !== 0) this._slippery = 0.0;
    else if (this._slippery > 0.0) this._slippery -= 0.2;

    const slippery = this._slippery;
    if (this.speed_x !== 0.0 || this.modifier_x !== 0.0) {
      let sx = this.speed_x + this.modifier_x;
      if (((((mx === 0.0 && moy !== 0.0) || (sx < 0.0 && mx > 0.0) || (sx > 0.0 && mx < 0.0)) && (slippery <= 0.0 || isgodmod)) || (climbCur && !isgodmod))) {
        sx *= BASE_DRAG;
        sx *= NO_MOD_DRAG;
      } else if (current === WATER && !isgodmod) {
        sx *= BASE_DRAG; sx *= WATER_DRAG;
      } else if (current === MUD && !isgodmod) {
        sx *= BASE_DRAG; sx *= MUD_DRAG;
      } else if (current === LAVA && !isgodmod) {
        sx *= BASE_DRAG; sx *= LAVA_DRAG;
      } else if (current === TOXIC_WASTE && !isgodmod) {
        sx *= BASE_DRAG; sx *= TOXIC_DRAG;
      } else if (slippery > 0.0 && !isgodmod) {
        if (mx !== 0.0 && !((sx < 0.0 && mx > 0.0) || (sx > 0.0 && mx < 0.0))) sx *= BASE_DRAG;
        else sx *= ICE_NO_MOD_DRAG;
        if ((sx < 0.0 && mx > 0.0) || (sx > 0.0 && mx < 0.0)) sx *= ICE_DRAG;
      } else {
        sx *= BASE_DRAG;
      }
      if (sx > 16.0) sx = 16.0;
      else if (sx < -16.0) sx = -16.0;
      else if (sx < 0.0001 && sx > -0.0001) sx = 0.0;
      this.speed_x = sx;
    }

    if (this.speed_y !== 0.0 || this.modifier_y !== 0.0) {
      let sy = this.speed_y + this.modifier_y;
      if (((((my === 0.0 && mox !== 0.0) || (sy < 0.0 && my > 0.0) || (sy > 0.0 && my < 0.0)) && (slippery <= 0.0 || isgodmod)) || (climbCur && !isgodmod))) {
        sy *= BASE_DRAG;
        sy *= NO_MOD_DRAG;
      } else if (current === WATER && !isgodmod) {
        sy *= BASE_DRAG; sy *= WATER_DRAG;
      } else if (current === MUD && !isgodmod) {
        sy *= BASE_DRAG; sy *= MUD_DRAG;
      } else if (current === LAVA && !isgodmod) {
        sy *= BASE_DRAG; sy *= LAVA_DRAG;
      } else if (current === TOXIC_WASTE && !isgodmod) {
        sy *= BASE_DRAG; sy *= TOXIC_DRAG;
      } else if (slippery > 0.0 && !isgodmod) {
        if (my !== 0.0 && !((sy < 0.0 && my > 0.0) || (sy > 0.0 && my < 0.0))) sy *= BASE_DRAG;
        else sy *= ICE_NO_MOD_DRAG;
        if ((sy < 0.0 && my > 0.0) || (sy > 0.0 && my < 0.0)) sy *= ICE_DRAG;
      } else {
        sy *= BASE_DRAG;
      }
      if (sy > 16.0) sy = 16.0;
      else if (sy < -16.0) sy = -16.0;
      else if (sy < 0.0001 && sy > -0.0001) sy = 0.0;
      this.speed_y = sy;
    }

    if (!isgodmod) {
      switch (current) {
        case SPEED_LEFT: this.speed_x = -BOOST; break;
        case SPEED_RIGHT: this.speed_x = BOOST; break;
        case SPEED_UP: this.speed_y = -BOOST; break;
        case SPEED_DOWN: this.speed_y = BOOST; break;
      }
      if (this.is_dead) {
        this.speed_x = 0.0;
        this.speed_y = 0.0;
      }
    }

    // --- sub-stepped movement (stepx/stepy + processPortals)
    this._rem_x = fmod1(this.px);
    this._cur_sx = this.speed_x;
    this._rem_y = fmod1(this.py);
    this._cur_sy = this.speed_y;
    let grounded = false;
    let landSpeed = 0.0;

    if (this._cur_sx !== 0.0 || this._cur_sy !== 0.0) {
      // processPortals() runs at the top of every loop iteration with the tick-start tile (cx, cy), which
      // cannot change during the loop: every iteration after the first is a no-op (lastPortal is set by
      // then, or the tile is no active portal and lastPortal = null again), so it is done once here.
      const slot = (current === PORTAL || current === PORTAL_INVISIBLE) ? this.level.portalSlot[cy * W + cx] : -1;
      if (isgodmod || slot < 0 || this.level.pTarget[slot] === this.level.pId[slot]) this._last_portal_set = false;
      else if (!this._last_portal_set) this._portalTeleport(slot, cx, cy);
      const boostCur = (flags[current] & F_BOOST) !== 0;
      // loop state in locals (the AS3/GDScript members _rem_x, _cur_sx, _osx, _donex ... are loop temporaries)
      let px = this.px, py = this.py;
      let remx = this._rem_x, remy = this._rem_y, csx = this._cur_sx, csy = this._cur_sy;
      let donex = false, doney = false;
      let exact = true;
      if (!isgodmod && !this._loopCollided) {
        // Collision-free fast version of the loop below: the same stepping arithmetic, assuming every
        // overlaps() call returns 0 through the all-air path. Then check that every box it probed is in the
        // world and covers only plain-air tiles; if so each of those calls would indeed have returned 0 and
        // reset overlapa..d, so the result is identical. Otherwise run the exact loop from the same start.
        let x = px, y = py, rx = remx, ry = remy, sx = csx, sy = csy;
        let minX = x, maxX = x, minY = y, maxY = y, lox = x, loy = y;
        do {
          lox = x; loy = y;
          if (sx > 0.0) {
            if (sx + rx >= 1.0) { x += (1.0 - rx); x = x | 0; sx -= (1.0 - rx); rx = 0.0; }
            else { x += sx; sx = 0.0; }
          } else if (sx < 0.0) {
            if (rx + sx < 0.0 && (rx !== 0.0 || boostCur)) { sx += rx; x -= rx; x = x | 0; rx = 1.0; }
            else { x += sx; sx = 0.0; }
          }
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (sy > 0.0) {
            if (sy + ry >= 1.0) { y += 1.0 - ry; y = y | 0; sy -= (1.0 - ry); ry = 0.0; }
            else { y += sy; sy = 0.0; }
          } else if (sy < 0.0) {
            if (ry + sy < 0.0 && (ry !== 0.0 || boostCur)) { y -= ry; y = y | 0; sy += ry; ry = 1.0; }
            else { y += sy; sy = 0.0; }
          }
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } while (sx !== 0.0 || sy !== 0.0);
        if (this._sweptAir(minX, maxX, minY, maxY)) {
          exact = false;
          px = x; py = y;
          this._ox = lox; this._oy = loy;
          this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
        }
      }
      if (exact) do {
        const ox = px, oy = py;
        this._ox = ox;
        this._oy = oy;
        const osx = csx, osy = csy;
        // stepx
        if (csx > 0.0) {
          if (csx + remx >= 1.0) {
            px += (1.0 - remx);
            px = px | 0;                  // float(int(px)); |px| < 2^31 (world-bounded)
            csx -= (1.0 - remx);
            remx = 0.0;
          } else {
            px += csx;
            csx = 0.0;
          }
        } else if (csx < 0.0) {
          if (remx + csx < 0.0 && (remx !== 0.0 || boostCur)) {
            csx += remx;
            px -= remx;
            px = px | 0;                  // float(int(px)); |px| < 2^31 (world-bounded)
            remx = 1.0;
          } else {
            px += csx;
            csx = 0.0;
          }
        }
        if (this._ovAt(px, py) !== 0) {
          px = ox;
          const s = this.speed_x;
          if (s > 0.0 && morx > 0) { if (!grounded) landSpeed = Math.abs(s); grounded = true; }
          if (s < 0.0 && morx < 0) { if (!grounded) landSpeed = Math.abs(s); grounded = true; }
          this.speed_x = 0.0;
          csx = osx;
          donex = true;
        }
        // stepy
        if (csy > 0.0) {
          if (csy + remy >= 1.0) {
            py += 1.0 - remy;
            py = py | 0;
            csy -= (1.0 - remy);
            remy = 0.0;
          } else {
            py += csy;
            csy = 0.0;
          }
        } else if (csy < 0.0) {
          if (remy + csy < 0.0 && (remy !== 0.0 || boostCur)) {
            py -= remy;
            py = py | 0;
            csy += remy;
            remy = 1.0;
          } else {
            py += csy;
            csy = 0.0;
          }
        }
        if (this._ovAt(px, py) !== 0) {
          py = oy;
          const s = this.speed_y;
          if (s > 0.0 && mory > 0) { if (!grounded) landSpeed = Math.abs(s); grounded = true; }
          if (s < 0.0 && mory < 0) { if (!grounded) landSpeed = Math.abs(s); grounded = true; }
          this.speed_y = 0.0;
          csy = osy;
          doney = true;
        }
      } while ((csx !== 0.0 && !donex) || (csy !== 0.0 && !doney));
      this._loopCollided = donex || doney;
      this.px = px;
      this.py = py;
    }
    this._grounded = grounded;
    this._land_speed = landSpeed;

    // --- jumping, touching blocks
    if (!this.is_dead) {
      let mod = 1.0;
      let injump = false;
      if (this._spacejustdown) {
        this._last_jump = -now;
        injump = true;
        mod = -1.0;
      }
      if (this._spacedown) {
        if (this._last_jump < 0.0) {
          if (now + this._last_jump > 750.0) injump = true;
        } else {
          if (now - this._last_jump > 150.0) injump = true;
        }
      }
      if ((((this.speed_x === 0.0 && morx !== 0 && mox !== 0.0) || (this.speed_y === 0.0 && mory !== 0 && moy !== 0.0)) && grounded) || this._current === EFFECT_MULTIJUMP) {
        this.jump_count = 0;
      }
      if (this.jump_count === 0 && !grounded) this.jump_count = 1;
      if (injump) {
        let jumped = false;
        if (this.jump_count < this.max_jumps && morx !== 0 && mox !== 0.0) {
          if (this.max_jumps < 1000) this.jump_count += 1;
          this.speed_x = ((0 - morx) * JUMP_HEIGHT * this._jumpMultiplier()) / MULT;
          this._last_jump = now * mod;
          jumped = true;
        }
        if (this.jump_count < this.max_jumps && mory !== 0 && moy !== 0.0) {
          if (this.max_jumps < 1000) this.jump_count += 1;
          this.speed_y = ((0 - mory) * JUMP_HEIGHT * this._jumpMultiplier()) / MULT;
          this._last_jump = now * mod;
          jumped = true;
        }
        if (jumped && this.onEvent !== null) this.onEvent('jump', { pos: { x: this.px, y: this.py } });
      }
      this._touchBlock(cx, cy, isgodmod, now);
    }

    // --- auto align to grid (not in liquids)
    const liquidCur = (flags[this._current] & F_LIQUID) !== 0 && !isgodmod;
    if ((this.speed_x >= 1.0 || this.speed_x <= -1.0) || liquidCur) {
      // int(speed_x) != 0
    } else if (this.modifier_x < 0.1 && this.modifier_x > -0.1) {
      const tx = fmod16(this.px);
      if (tx < 2.0) {
        if (tx < 0.2) this.px = this.px | 0;
        else this.px -= tx / 15.0;
      } else if (tx > 14.0) {
        if (tx > 15.8) {
          this.px = this.px | 0;
          this.px += 1.0;
        } else {
          this.px += (tx - 14.0) / 15.0;
        }
      }
    }
    if ((this.speed_y >= 1.0 || this.speed_y <= -1.0) || liquidCur) {
      // int(speed_y) != 0
    } else if (this.modifier_y < 0.1 && this.modifier_y > -0.1) {
      const ty = fmod16(this.py);
      if (ty < 2.0) {
        if (ty < 0.2) this.py = this.py | 0;
        else this.py -= ty / 15.0;
      } else if (ty > 14.0) {
        if (ty > 15.8) {
          this.py = this.py | 0;
          this.py += 1.0;
        } else {
          this.py += (ty - 14.0) / 15.0;
        }
      }
    }

    // --- Me.updateStuff()
    if (!this.has_silver_crown && (this.run_ticks !== 0 || this._horizontal !== 0 || this._vertical !== 0 || this._spacedown)) {
      this.run_ticks += 1;
    }

    const wasGround = this.on_ground;
    this.on_ground = this._grounded;
    if (this._grounded && !wasGround && this.onEvent !== null) this.onEvent('land', { impact_speed: this._land_speed });
  }

  _markGrounded(s) {
    if (!this._grounded) this._land_speed = Math.abs(s);
    this._grounded = true;
  }

  /** The teleport half of processPortals() (tile is an active portal, lastPortal == null, not god mode). */
  _portalTeleport(slot, cx, cy) {
    const L = this.level;
    this._last_portal_set = true;
    this._last_portal_x = cx << 4;
    this._last_portal_y = cy << 4;
    const targets = L.portalsById.get(L.pTarget[slot]);
    if (targets === undefined || targets.n <= 0) return;
    const pick = this._randiRange(0, targets.n - 1);
    const cpx = targets.xs[pick], cpy = targets.ys[pick];
    let oldRot = L.pRot[slot];
    const ns = L.portalSlot[(cpy >> 4) * this.width + (cpx >> 4)];
    const newRot = ns >= 0 ? L.pRot[ns] : 0;
    if (oldRot < newRot) oldRot += 4;
    const osx = this.speed_x * MULT;
    const osy = this.speed_y * MULT;
    const omx = this.modifier_x * MULT;
    const omy = this.modifier_y * MULT;
    const dir = oldRot - newRot;
    const magic = 1.42;
    switch (dir) {
      case 1:
        this.speed_x = (osy * magic) / MULT;
        this.speed_y = (-osx * magic) / MULT;
        this.modifier_x = (omy * magic) / MULT;
        this.modifier_y = (-omx * magic) / MULT;
        this._rem_y = -this._rem_x;
        this._cur_sy = -this._cur_sx;
        break;
      case 2:
        this.speed_x = (-osx * magic) / MULT;
        this.speed_y = (-osy * magic) / MULT;
        this.modifier_x = (-omx * magic) / MULT;
        this.modifier_y = (-omy * magic) / MULT;
        this._rem_y = -this._rem_y;
        this._cur_sy = -this._cur_sy;
        this._rem_x = -this._rem_x;
        this._cur_sx = -this._cur_sx;
        break;
      case 3:
        this.speed_x = (-osy * magic) / MULT;
        this.speed_y = (osx * magic) / MULT;
        this.modifier_x = (-omy * magic) / MULT;
        this.modifier_y = (omx * magic) / MULT;
        this._rem_x = -this._rem_y;
        this._cur_sx = -this._cur_sy;
        break;
    }
    this.px = cpx;
    this.py = cpy;
    this._last_portal_x = cpx;
    this._last_portal_y = cpy;
    this.teleported = true;
    if (this.onEvent !== null) this.onEvent('portal', { from: { x: cx, y: cy }, to: { x: cpx >> 4, y: cpy >> 4 } });
  }

  /** RandomNumberGenerator.randi_range(from, to) (RandomPCG::random + pcg32_boundedrand_r). */
  _randiRange(from, to) {
    if (from === to) return from;
    if (this.rngScript !== null) {
      // EEO mode: EE Offline picks random portal exits with Math.random (not reproducible), so the outcome of the k-th
      // random draw comes from a script (tools/tas/rng.js finds which outcomes a TAS needs). Past the end of the script:
      // rngNeed = number of choices (for the enumerator) and choice 0.
      const k = this._rngSteps++;
      const n = Math.abs(from - to) + 1;
      let c = k < this.rngScript.length ? this.rngScript[k] : -1;
      if (c < 0 || c >= n) { if (k >= this.rngScript.length) this.rngNeed = n; c = 0; }
      return Math.min(from, to) + c;
    }
    const bound = (Math.abs(from - to) + 1) >>> 0;
    const threshold = ((-bound >>> 0) % bound) >>> 0;
    for (;;) {
      const old = this._rngState;
      this._rngState = pcgStep(old);
      this._rngSteps++;
      const r = pcgOut(old);
      if (r >= threshold) return (r % bound) + Math.min(from, to);
    }
  }

  _getCurrentBelow(current, cx, cy) {
    let x = 0, y = 0;
    switch (current) {
      case 1: case 411: x -= 1; break;
      case 2: case 412: y -= 1; break;
      case 3: x += 1; break;
      case 4: y += 1; break;
      default:
        switch (this.flip_gravity) {
          case 0: y += 1; break;
          case 1: x -= 1; break;
          case 2: y -= 1; break;
          default: x += 1;
        }
    }
    return this._getTile(cx + x, cy + y);
  }

  _getTile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this.tiles[ty * this.width + tx];
  }

  _lookupAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this._lookup[ty * this.width + tx];
  }

  // ================================================================ World.overlaps()

  /** Id of the first blocking tile (1 when out of the world), 0 when free. Same side effects as EE. */
  _overlaps() { return this._ovAt(this.px, this.py); }

  /**
   * The fast paths of overlaps() at (x, y) without the full scan: 0 = returns 0 (all air: overlapa..d reset,
   * or god mode: untouched), 1 = returns non-zero without side effects (out of the world, or the first tile in
   * scan order is a static solid), -1 = needs the full scan (nothing done).
   */
  _ovClass(x, y) {
    if (x < 0.0 || y < 0.0 || x > this._maxX || y > this._maxY) return 1;
    if (this.in_god_mode) return 0;
    const ox = (x | 0) >> 4;   // 0 <= x <= _maxX: | 0 truncates like int()
    const oy = (y | 0) >> 4;
    const x2 = (x + 16.0) > (ox * 16 + 16) ? 1 : 0;
    const y2 = (y + 16.0) > (oy * 16 + 16) ? 1 : 0;
    const req = AIR_REQ[x2 | (y2 << 1)];
    const m = this._airMask[oy * this.width + ox];
    const nonAir = req & ~m;
    if (nonAir === 0) {
      this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
      return 0;
    }
    if (((m >> 9) & nonAir & -nonAir) !== 0) return 1;
    return -1;
  }

  /**
   * True when every box at positions x in [minX, maxX], y in [minY, maxY] lies in the world and covers only
   * plain-air tiles (then overlaps() at any of them returns 0 via the all-air path). The tile columns of a box
   * at x are ox(x) .. ceil(fl(x + 16) / 16) - 1, both monotonic in x, so the union is one rectangle.
   */
  _sweptAir(minX, maxX, minY, maxY) {
    if (minX < 0.0 || minY < 0.0 || maxX > this._maxX || maxY > this._maxY) return false;
    const tx0 = (minX | 0) >> 4, ty0 = (minY | 0) >> 4;
    const ox1 = (maxX | 0) >> 4, oy1 = (maxY | 0) >> 4;
    const tx1 = ox1 + ((maxX + 16.0) > (ox1 * 16 + 16) ? 1 : 0);
    const ty1 = oy1 + ((maxY + 16.0) > (oy1 * 16 + 16) ? 1 : 0);
    const w = tx1 - tx0, h = ty1 - ty0;
    if (w <= 2 && h <= 2) {
      const req = REQ3[w + 3 * h];
      return (this._airMask[ty0 * this.width + tx0] & req) === req;
    }
    const W1 = this.width + 1, ps = this._airPS;
    return ps[(ty1 + 1) * W1 + tx1 + 1] - ps[ty0 * W1 + tx1 + 1] - ps[(ty1 + 1) * W1 + tx0] + ps[ty0 * W1 + tx0] === 0;
  }

  /** World.overlaps() for the box at (x, y) (callers pass the current px, py). */
  _ovAt(x, y) {
    if (x < 0.0 || y < 0.0 || x > this._maxX || y > this._maxY) return 1;
    if (this.in_god_mode) return 0;
    const ox = (x | 0) >> 4;   // 0 <= x <= _maxX: | 0 truncates like int()
    const oy = (y | 0) >> 4;
    // int(ceil((x + 16.0) / 16.0)) is ox + 2 when fl(x + 16) > 16 * ox + 16, else ox + 1 (0 <= x - 16 * ox < 16)
    const x2 = (x + 16.0) > (ox * 16 + 16) ? 1 : 0;
    const y2 = (y + 16.0) > (oy * 16 + 16) ? 1 : 0;
    // tiles under the box, as boxMask bits in scan order (the per-tile rectangle test always passes for them)
    const req = AIR_REQ[x2 | (y2 << 1)];
    const m = this._airMask[oy * this.width + ox];
    const nonAir = req & ~m;
    if (nonAir === 0) {
      // every tile under the box is plain air: the scan finds nothing and resets overlapa..d
      this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
      return 0;
    }
    // first non-air tile in scan order is a plain solid: the scan returns it (callers only test != 0)
    if (((m >> 9) & nonAir & -nonAir) !== 0) return 1;
    return this._ovSlow(x, y, ox, oy, ox + 1 + x2, oy + 1 + y2);
  }

  _ovSlow(x, y, ox, oy, cxEnd, cyEnd) {
    const W = this.width;
    const ovl = this._ovl;
    let skipa = false, skipb = false, skipc = false, skipd = false;
    for (let cy = oy; cy < cyEnd; cy++) {
      const row = cy * W;
      for (let cx = ox; cx < cxEnd; cx++) {
        const k = ovl[row + cx];
        if (k === OV_AIR) continue;
        if (k === OV_SECRET) { this._revealSecret(cx, cy); continue; }
        const val = this.tiles[row + cx];
        const tlx = cx * 16;
        const tly = cy * 16;
        if (!(x < tlx + 16.0 && tlx < x + 16.0 && y < tly + 16.0 && tly < y + 16.0)) continue;
        if (k === OV_SOLID) return val;
        const fl = this._flags[val];
        if ((fl & (F_ROTHALF | F_HALF | F_JUMPTHRU)) !== 0) {
          const rot = this._lookup[row + cx];
          if ((fl & F_ROTHALF) !== 0) {
            if ((fl & F_JUMPTHRU) !== 0) {
              // up
              if ((this.speed_y < 0.0 || cy <= this.overlapa || (this.speed_y === 0.0 && this.speed_x === 0.0 && (this._oy + 15.0) > tly)) && rot === 1) {
                if (cy !== oy || this.overlapa === -1) this.overlapa = cy;
                skipa = true;
                continue;
              }
              // right
              if ((this.speed_x > 0.0 || (cx <= this.overlapb && this.speed_x <= 0.0 && this._ox < tlx + 16.0)) && rot === 2) {
                if (cx !== ox || this.overlapb === -1) this.overlapb = cx;
                skipb = true;
                continue;
              }
              // down
              if ((this.speed_y > 0.0 || (cy <= this.overlapc && this.speed_y <= 0.0 && this._oy < tly + 16.0)) && rot === 3) {
                if (cy !== oy || this.overlapc === -1) this.overlapc = cy;
                skipc = true;
                continue;
              }
              // left
              if ((this.speed_x < 0.0 || cx <= this.overlapd || (this.speed_y === 0.0 && this.speed_x < 0.0 && (this._ox - 15.0) < tlx)) && rot === 0) {
                if (cx !== ox || this.overlapd === -1) this.overlapd = cx;
                skipd = true;
                continue;
              }
            }
          } else if ((fl & F_HALF) !== 0) {
            if (rot === 1) {
              if (!rectHit(x, y, tlx, tly + 8.0, 16.0, 8.0)) continue;
            } else if (rot === 2) {
              if (!rectHit(x, y, tlx, tly, 8.0, 16.0)) continue;
            } else if (rot === 3) {
              if (!rectHit(x, y, tlx, tly, 16.0, 8.0)) continue;
            } else if (rot === 0) {
              if (!rectHit(x, y, tlx + 8.0, tly, 8.0, 16.0)) continue;
            }
          } else {
            // plain one-way (canJumpThroughFromBelow)
            if (this.speed_y < 0.0 || cy <= this.overlapa || (this.speed_y === 0.0 && this.speed_x === 0.0 && (this._oy + 15.0) > tly)) {
              if (cy !== oy || this.overlapa === -1) this.overlapa = cy;
              skipa = true;
              continue;
            }
          }
        }
        if ((fl & F_DOOR) !== 0) {
          if (val === 50) this._revealSecret(cx, cy);
          else if (this._doorPassable(val, row + cx)) continue;
        }
        return val;
      }
    }
    if (!skipa) this.overlapa = -1;
    if (!skipb) this.overlapb = -1;
    if (!skipc) this.overlapc = -1;
    if (!skipd) this.overlapd = -1;
    return 0;
  }

  /** The door/gate switch of World.overlaps(): true = the tile does NOT block. */
  _doorPassable(val, i) {
    const km = this._keysMask;
    switch (val) {
      case 23: return (km & 1) !== 0;
      case 24: return (km & 2) !== 0;
      case 25: return (km & 4) !== 0;
      case 26: return (km & 1) === 0;
      case 27: return (km & 2) === 0;
      case 28: return (km & 4) === 0;
      case 1005: return (km & 8) !== 0;
      case 1006: return (km & 16) !== 0;
      case 1007: return (km & 32) !== 0;
      case 1008: return (km & 8) === 0;
      case 1009: return (km & 16) === 0;
      case 1010: return (km & 32) === 0;
      case 156: return this._timedoor_state;
      case 157: return !this._timedoor_state;
      case DOOR_PURPLE: return this._switches.get(this._lookup[i]) === true;
      case GATE_PURPLE: return this._switches.get(this._lookup[i]) !== true;
      case DOOR_ORANGE: return this._oswitches.get(this._lookup[i]) === true;
      case GATE_ORANGE: return this._oswitches.get(this._lookup[i]) !== true;
      case 200: return false;
      case 201: return true;
      case 1094: return this._collide_crown;
      case 1095: return !this._collide_crown;
      case 1152: return this._collide_silver_crown;
      case 1153: return !this._collide_silver_crown;
      case COINDOOR: return this._lookup[i] <= this.coins;
      case BLUECOINDOOR: return this._lookup[i] <= this.blue_coins;
      case DEATH_DOOR: return this._lookup[i] <= this.deaths;
      case COINGATE: return this._lookup[i] > this._show_coin_gate;
      case BLUECOINGATE: return this._lookup[i] > this._show_blue_coin_gate;
      case DEATH_GATE: return this._lookup[i] > this._show_death_gate;
      case 1027: return 0 === this._lookup[i];
      case 1028: return 0 !== this._lookup[i];
      case 206: return false;
      case 207: return true;
    }
    return false;
  }

  _revealSecret(cx, cy) {
    const b = this.level.secretBit[cy * this.width + cx];
    const w = b >> 5, m = 1 << (b & 31);
    if ((this._secretBits[w] & m) === 0) {
      if (!this._secretOwned) { this._secretBits = this._secretBits.slice(); this._secretOwned = true; }
      this._secretBits[w] |= m;
      if (this.onEvent !== null) this.onEvent('secret', { tile: { x: cx, y: cy } });
    }
  }

  // ================================================================ Me.touchBlock()

  _touchBlock(cx, cy, isgodmode, now) {
    const current = this._current;
    if (current === COIN_GOLD || current === COIN_BLUE) {
      this._setTileCoin(cx, cy, current + 10);
      if (current === COIN_GOLD) {
        this.coins += 1;
        if (this.onEvent !== null) this.onEvent('coin', { tile: { x: cx, y: cy } });
      } else {
        this.blue_coins += 1;
        if (this.onEvent !== null) this.onEvent('blue_coin', { tile: { x: cx, y: cy } });
      }
    }
    if (this._pastx !== cx || this._pasty !== cy) {
      if ((current === PIANO || current === DRUMS || current === GUITAR) && this.onEvent !== null) {
        this.onEvent(current === PIANO ? 'piano' : (current === DRUMS ? 'drum' : 'guitar'),
          { tile: { x: cx, y: cy }, note: this._lookupAt(cx, cy) });
      }
      if (!isgodmode) {
        if ((this._xflags[current] & X_BLINK) !== 0 && this.onEvent !== null) this.onEvent('blink', { tile: { x: cx, y: cy }, id: current });
        switch (current) {
          case CROWN:
            if (!this.has_crown) {
              this._removeCrown();
              this.has_crown = true;
              this._checkCrown(true);
              if (this.onEvent !== null) this.onEvent('crown', { tile: { x: cx, y: cy } });
            }
            break;
          case SWITCH_PURPLE: {
            const sid = this._lookupAt(cx, cy);
            this._pressPurpleSwitch(sid, !(this._switches.get(sid) === true));
            break;
          }
          case SWITCH_ORANGE: {
            const osid = this._lookupAt(cx, cy);
            this._pressOrangeSwitch(osid, !(this._oswitches.get(osid) === true));
            break;
          }
          case RESET_PURPLE: {
            const rsid = this._lookupAt(cx, cy);
            if (rsid === 1000 || this._switches.get(rsid) === true) this._pressPurpleSwitch(rsid, false);
            break;
          }
          case RESET_ORANGE: {
            const rosid = this._lookupAt(cx, cy);
            if (rosid === 1000 || this._oswitches.get(rosid) === true) this._pressOrangeSwitch(rosid, false);
            break;
          }
          case CHECKPOINT:
            this.checkpoint.x = cx; this.checkpoint.y = cy;
            if (this.onEvent !== null) this.onEvent('checkpoint', { tile: { x: cx, y: cy } });
            break;
          case BRICK_COMPLETE:
            if (!this.has_silver_crown) {
              this.has_silver_crown = true;
              this._checkSilverCrown(true);
              if (this.onEvent !== null) this.onEvent('complete', { tile: { x: cx, y: cy }, ticks: this.run_ticks });
            }
            break;
          case 6: case 7: case 8: case 408: case 409: case 410: {
            const col = keyColorIndex(current);
            this._switchKey(col, true, false);
            if (this.onEvent !== null) this.onEvent('key', { color: COLORS[col], tile: { x: cx, y: cy } });
            break;
          }
          case EFFECT_JUMP: {
            const nj = this._lookupAt(cx, cy);
            if (this.jump_boost !== nj) this.jump_boost = nj;
            break;
          }
          case EFFECT_RUN: {
            const ns = this._lookupAt(cx, cy);
            if (this.speed_boost !== ns) this.speed_boost = ns;
            break;
          }
          case EFFECT_LOW_GRAVITY:
            this.low_gravity = this._lookupAt(cx, cy) !== 0;
            break;
          case EFFECT_PROTECTION: {
            const inv = this._lookupAt(cx, cy) !== 0;
            if (this.is_invulnerable !== inv) {
              this.is_invulnerable = inv;
              if (inv) this.is_on_fire = false;
            }
            break;
          }
          case EFFECT_RESET:
            this.jump_boost = 0; this.speed_boost = 0; this.is_invulnerable = false; this.low_gravity = false;
            this.max_jumps = 1; this.flip_gravity = 0;
            break;
          case LAVA:
            if (!this.is_on_fire && !this.is_invulnerable) {
              this.is_on_fire = true;
              const arg = 2.0 + 2.0 * PING;
              const dur = 2.0 + 2.0 * PING;
              this._fire_time_start = now - (dur - arg) * 1000.0;
              this._fire_duration = dur;
            }
            break;
          case WATER: case MUD: case TOXIC_WASTE:
            this.is_on_fire = false;
            break;
          case EFFECT_MULTIJUMP: {
            const jps = this._lookupAt(cx, cy);
            if (jps !== this.max_jumps) this.max_jumps = jps;
            break;
          }
          case EFFECT_GRAVITY: {
            const nf = this._lookupAt(cx, cy);
            if (this.flip_gravity !== nf) this.flip_gravity = nf;
            break;
          }
        }
      }
      this._pastx = cx;
      this._pasty = cy;
    }
  }

  /** _set_tile for a coin pickup (the only runtime tile write): tile -> 110/111, lookup deleted. */
  _setTileCoin(cx, cy, id) {
    const i = cy * this.width + cx;
    this.tiles[i] = id;
    this._lookup[i] = 0;
    const b = this.level.coinBit[i];
    if (!this._coinOwned) { this._coinBits = this._coinBits.slice(); this._coinOwned = true; }
    this._coinBits[b >> 5] |= 1 << (b & 31);
  }

  // ================================================================ PlayState / World key & state helpers

  /** PlayState.switchKey() */
  _switchKey(c, state, fromqueue) {
    this._setKey(c, state, fromqueue);
    if (this._overlaps() !== 0) {
      this._setKey(c, !state, false);
      this._keysQueue.push(c, state ? 1 : 0);
    }
  }

  /** World.setKey() */
  _setKey(c, state, fromqueue) {
    if (fromqueue && ((this._offset - this._kt[c]) / 30.0) >= 5.0) return;
    if (state) this._keysMask |= (1 << c);
    else this._keysMask &= ~(1 << c);
    if (state && !fromqueue) this._kt[c] = this._offset;
  }

  _checkCrown(collide) {
    this._collide_crown = collide;
    if (this._overlaps() !== 0) {
      this._collide_crown = !collide;
      this._stateQueue.push(SQ_CROWN, collide ? 1 : 0, 0);
    }
  }

  _removeCrown() {
    this.has_crown = false;
    this._checkCrown(false);
  }

  _checkSilverCrown(collide) {
    this._collide_silver_crown = collide;
    if (this._overlaps() !== 0) {
      this._collide_silver_crown = !collide;
      this._stateQueue.push(SQ_SILVER, collide ? 1 : 0, 0);
    }
  }

  _swSet(id, v) {
    if (!this._swOwned) { this._switches = new Map(this._switches); this._swOwned = true; }
    this._switches.set(id, v);
    this._switches._key = undefined;
  }

  _oswSet(id, v) {
    if (!this._oswOwned) { this._oswitches = new Map(this._oswitches); this._oswOwned = true; }
    this._oswitches.set(id, v);
    this._oswitches._key = undefined;
  }

  _pressPurpleSwitch(sid, enabled) {
    if (sid === 1000) {
      for (let i = 0; i < 1000; i++) this._pressPurpleSwitch(i, enabled);
    }
    this._switch_dirty = true;
    this._swSet(sid, enabled);
    if (this._overlaps() !== 0) {
      this._swSet(sid, !enabled);
      this._tileQueue.push(sid, enabled ? 1 : 0);
    }
  }

  _pressOrangeSwitch(sid, enabled) {
    if (sid === 1000) {
      for (let i = 0; i < 1000; i++) this._pressOrangeSwitch(i, enabled);
    }
    this._switch_dirty = true;
    this._oswSet(sid, enabled);
    if (this._overlaps() !== 0) {
      this._oswSet(sid, !enabled);
      this._stateQueue.push(SQ_ORANGE, sid, enabled ? 1 : 0);
    }
  }

  /** Player.placeAtSpawn() */
  _placeAtSpawn(useCheckpoint) {
    let nx = 1, ny = 1;
    const L = this.level;
    if (useCheckpoint && this.checkpoint.x !== -1) {
      nx = this.checkpoint.x;
      ny = this.checkpoint.y;
    } else if (L.spawnsX.length > 0) {
      if (this._next_spawn >= L.spawnsX.length) this._next_spawn = 0;
      nx = L.spawnsX[this._next_spawn];
      ny = L.spawnsY[this._next_spawn];
      this._next_spawn += 1;
    }
    this.px = nx * 16;
    this.py = ny * 16;
  }

  _jumpMultiplier() {
    let jm = 1.0;
    if (this.jump_boost === 1) jm *= 1.3;
    if (this.jump_boost === 2) jm *= 0.75;
    if (this._slippery > 0.0) jm *= 0.88;
    return jm;
  }

  // ================================================================ events (diff based)

  _emitDiffs() {
    const ev = this.onEvent;
    const km = this._keysMask;
    if (km !== this._evKeysMask) {
      for (let c = 0; c < 6; c++) {
        const on = (km >> c) & 1;
        if (on !== ((this._evKeysMask >> c) & 1)) {
          this._evKeysMask ^= (1 << c);
          if (ev !== null) {
            ev('door_state', { kind: COLORS[c], open: on !== 0 });
            if (on === 0) ev('key_expired', { color: COLORS[c] });
          }
        }
      }
    }
    if (this.coins !== this._ev_coins) {
      if (ev !== null) {
        const th = this.level.coinDoorThresholds;
        for (let k = 0; k < th.length; k++) {
          const t = th[k];
          if ((t <= this.coins) !== (t <= this._ev_coins)) ev('door_state', { kind: 'coin', open: t <= this.coins, count: t });
        }
      }
      this._ev_coins = this.coins;
    }
    if (this.blue_coins !== this._ev_bcoins) {
      if (ev !== null) {
        const th = this.level.blueCoinDoorThresholds;
        for (let k = 0; k < th.length; k++) {
          const t = th[k];
          if ((t <= this.blue_coins) !== (t <= this._ev_bcoins)) ev('door_state', { kind: 'blue_coin', open: t <= this.blue_coins, count: t });
        }
      }
      this._ev_bcoins = this.blue_coins;
    }
    if (this._timedoor_state !== this._ev_timedoor) {
      this._ev_timedoor = this._timedoor_state;
      if (this.level.hasTimeDoors && ev !== null) ev('door_state', { kind: 'time', open: this._timedoor_state });
    }
    if (this._switch_dirty) {
      this._switch_dirty = false;
      this._diffSwitches(false);
      this._diffSwitches(true);
    }
    const gx = signi(this.mox), gy = signi(this.moy);
    const gd = this.gravity_dir;
    if (!this.in_god_mode && (gx !== gd.x || gy !== gd.y)) { gd.x = gx; gd.y = gy; }
    if (gd.x !== this._ev_grav_x || gd.y !== this._ev_grav_y) {
      this._ev_grav_x = gd.x; this._ev_grav_y = gd.y;
      if (ev !== null) ev('gravity_changed', { dir: { x: gd.x, y: gd.y } });
    }
  }

  _diffSwitches(orange) {
    const cur = orange ? this._oswitches : this._switches;
    const kind = orange ? 'orange' : 'purple';
    for (const [id, on] of cur) {
      const seen = orange ? this._evOSwitches : this._evSwitches;
      if (on !== (seen.get(id) === true)) {
        let s = seen;
        if (orange) { if (!this._evOSwOwned) { s = this._evOSwitches = new Map(seen); this._evOSwOwned = true; } }
        else if (!this._evSwOwned) { s = this._evSwitches = new Map(seen); this._evSwOwned = true; }
        if (on) s.set(id, true); else s.delete(id);
        if (this.onEvent !== null) {
          this.onEvent('switch', { kind, id, on });
          this.onEvent('door_state', { kind, id, open: on });
        }
      }
    }
  }

  // ================================================================ snapshots

  /**
   * Full state snapshot (opaque). restore(s) continues bit-identically, any number of times, in any order.
   * Cheap: scalars are copied; the rarely-written parts (collected coins, secrets, switch maps) are
   * copy-on-write and shared by reference. Pass a previous snapshot as `out` to reuse it (no allocation).
   * Call between ticks only.
   */
  snapshot(out) {
    const s = out instanceof EESnapshot ? out : new EESnapshot();
    this._snapScalars(s);
    s.gdx = this.gravity_dir.x; s.gdy = this.gravity_dir.y;
    s.cpx = this.checkpoint.x; s.cpy = this.checkpoint.y;
    const kt = this._kt;
    s.kt0 = kt[0]; s.kt1 = kt[1]; s.kt2 = kt[2]; s.kt3 = kt[3]; s.kt4 = kt[4]; s.kt5 = kt[5];
    s.coinBits = this._coinBits; this._coinOwned = false;
    s.secretBits = this._secretBits; this._secretOwned = false;
    s.switches = this._switches; this._swOwned = false;
    s.oswitches = this._oswitches; this._oswOwned = false;
    s.evSwitches = this._evSwitches; this._evSwOwned = false;
    s.evOSwitches = this._evOSwitches; this._evOSwOwned = false;
    s.stateQueue = this._stateQueue.length === 0 ? EMPTY_Q : this._stateQueue.slice();
    s.keysQueue = this._keysQueue.length === 0 ? EMPTY_Q : this._keysQueue.slice();
    s.tileQueue = this._tileQueue.length === 0 ? EMPTY_Q : this._tileQueue.slice();
    s.level = this.level;
    return s;
  }

  restore(s) {
    if (!(s instanceof EESnapshot) || s.level !== this.level) throw new Error('restore: not a snapshot of this level');
    this._restoreScalars(s);
    this.gravity_dir.x = s.gdx; this.gravity_dir.y = s.gdy;
    this.checkpoint.x = s.cpx; this.checkpoint.y = s.cpy;
    const kt = this._kt;
    kt[0] = s.kt0; kt[1] = s.kt1; kt[2] = s.kt2; kt[3] = s.kt3; kt[4] = s.kt4; kt[5] = s.kt5;
    if (s.coinBits !== this._coinBits) this._syncCoins(s.coinBits);
    this._coinOwned = false;
    this._secretBits = s.secretBits; this._secretOwned = false;
    this._switches = s.switches; this._swOwned = false;
    this._oswitches = s.oswitches; this._oswOwned = false;
    this._evSwitches = s.evSwitches; this._evSwOwned = false;
    this._evOSwitches = s.evOSwitches; this._evOSwOwned = false;
    copyInto(this._stateQueue, s.stateQueue);
    copyInto(this._keysQueue, s.keysQueue);
    copyInto(this._tileQueue, s.tileQueue);
    this._switch_dirty = true;
  }

  /** Make tiles/_lookup match the collected-coin bitset `bits` (restore). */
  _syncCoins(bits) {
    const L = this.level, cur = this._coinBits;
    for (let w = 0; w < cur.length; w++) {
      let d = cur[w] ^ bits[w];
      while (d !== 0) {
        const low = d & -d;
        const bit = 31 - Math.clz32(low);
        d ^= low;
        const i = L.coinTiles[w * 32 + bit];
        if (((bits[w] >>> bit) & 1) !== 0) { this.tiles[i] = L.fg[i] + 10; this._lookup[i] = 0; }
        else { this.tiles[i] = L.fg[i]; this._lookup[i] = L.lookup0[i]; }
      }
    }
    this._coinBits = bits;
  }

  // ================================================================ state key

  /**
   * A string that is equal for two states iff they behave identically from here on (for eeo-tas inputs,
   * i.e. applyMask), ignoring absolute clocks (_ticks, _offset, run_ticks, prev_px/py, teleported, and the
   * per-tick input/derived fields that the next tick overwrites before reading). Running timers are keyed
   * by the exact number of ticks until they fire. Binary string (UTF-16 code units): use it as a Map/Set key.
   *
   * One absolute-clock effect cannot be keyed away: a key (6-8, 408-410) or time-door (156/157) period that
   * STARTS at tick p lasts 500 or 501 ticks depending on p (World.offset accumulates 0.3 per tick in
   * floating point; ~73% / 27%). So two equal-key states at different ticks behave identically until the
   * first key pickup / time-door toggle after the keyed moment, and may differ by one tick in that
   * period's length. strict = true also keys _ticks on levels that have key tiles or time doors, making
   * equality exact (on other levels both keys are the same).
   */
  stateKey(strict) {
    const L = this.level;
    const nd = this._fillKey();
    let key = this._keyBytes.ucs2Slice(0, this._keyDoubleOff + nd * 8);
    // variable parts (rare): switch on-sets, queues
    if (this._switches.size !== 0) key += '\u0001' + switchKey(this._switches);
    if (this._oswitches.size !== 0) key += '\u0002' + switchKey(this._oswitches);
    if (this._stateQueue.length !== 0) key += '\u0003' + intsKey(this._stateQueue);
    if (this._keysQueue.length !== 0) key += '\u0004' + intsKey(this._keysQueue);
    if (this._tileQueue.length !== 0) key += '\u0005' + intsKey(this._tileQueue);
    if (strict === true && L.clockSensitive) key += '\u0006' + intsKey([this._ticks]);
    return key;
  }

  /**
   * A 53-bit hash of exactly what stateKey(strict) contains, computed without building the string (about 3x
   * faster). Equal states -> equal hashes; different states collide with probability ~2^-53 per pair.
   */
  stateHash(strict, noCoins) {
    const nd = this._fillKey();
    if (noCoins === true) {
      // "same state apart from which coins were collected": coins never change physics except through coin doors,
      // gates and coin tiles, so equal no-coin hashes behave identically as long as no coin door/gate is touched
      const I = this._keyI;
      I[1] = 0; I[2] = 0;
      if (this.level.coinTiles.length !== 0) for (let w = 0; w < this.level.coinWords; w++) I[this._coinOff + w] = 0;
    }
    const words = (this._keyDoubleOff + nd * 8) >> 2;
    const W32 = this._keyW;
    let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
    for (let i = 0; i < words; i++) {
      let k = Math.imul(W32[i], 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h1 ^= k; h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
      h2 = Math.imul(h2 ^ W32[i], 0x5bd1e995); h2 ^= h2 >>> 13;
    }
    let extra = '';
    if (this._switches.size !== 0) extra += '' + switchKey(this._switches);
    if (this._oswitches.size !== 0) extra += '' + switchKey(this._oswitches);
    if (this._stateQueue.length !== 0) extra += '' + intsKey(this._stateQueue);
    if (this._keysQueue.length !== 0) extra += '' + intsKey(this._keysQueue);
    if (this._tileQueue.length !== 0) extra += '' + intsKey(this._tileQueue);
    if (strict === true && this.level.clockSensitive) extra += '' + intsKey([this._ticks]);
    for (let i = 0; i < extra.length; i++) {
      const c = extra.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 15;
    }
    h1 ^= words; h1 ^= h1 >>> 16; h1 = Math.imul(h1, 0x85ebca6b); h1 ^= h1 >>> 13; h1 = Math.imul(h1, 0xc2b2ae35); h1 ^= h1 >>> 16;
    h2 ^= h2 >>> 16; h2 = Math.imul(h2, 0x7feb352d); h2 ^= h2 >>> 15;
    return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
  }

  /** Fills the key buffer (int32 slots + doubles) for stateKey / stateHash; returns the number of doubles. */
  _fillKey() {
    const L = this.level;
    if (this._keyBuf === null) this._initKeyLayout();
    const I = this._keyI, F = this._keyF;
    // doubles: px, py, speed_x, speed_y, slippery (-0 -> +0 and slippery <= 0 -> 0: provably no behavioural
    // difference), then the conditional ones in a fixed order, flagged in fl
    F[0] = this.px + 0; F[1] = this.py + 0; F[2] = this.speed_x + 0; F[3] = this.speed_y + 0;
    F[4] = this._slippery > 0.0 ? this._slippery : 0.0;
    let nd = 5;
    let fl = 0;
    if (this.on_ground) fl |= 1;
    if (this.is_dead) { fl |= 2; F[nd++] = this._dead_offset + 0; }
    if (this.in_god_mode) fl |= 4;
    if (this.has_crown) fl |= 8;
    if (this.has_silver_crown) fl |= 16;
    if (this._collide_crown) fl |= 32;
    if (this._collide_silver_crown) fl |= 64;
    if (this.low_gravity) fl |= 128;
    if (this.is_invulnerable) fl |= 256;
    if (this._last_portal_set) fl |= 1024;
    const now = CLOCK_BASE + this._ticks * MS_PER_TICK;
    if (this.is_on_fire) {
      // fire kills when now - start > duration * 1000 (exact integer ms): key the elapsed time until then
      fl |= 512;
      if (this._fire_duration !== 0.0) fl |= 4096;
      let d = -2;
      if (!this.is_dead) { d = now - this._fire_time_start; if (d > this._fire_duration * 1000.0) d = -1; }
      F[nd++] = d;
    }
    // _ox/_oy are read by overlaps() only for one-way tiles under the box, before the next movement loop
    // rewrites them (or after a respawn, which moves the box without the loop).
    if (this.is_dead || this._boxTouchesOneWay()) { fl |= 2048; F[nd++] = this._ox + 0; F[nd++] = this._oy + 0; }
    if (this._timedoor_state && L.hasTimeDoors) fl |= 8192;
    if (this.stateKeyRawInput) {
      // held jump (jump && !jump_pressed) repeats 750 ms after a press, then every 150 ms
      if (this._prev_jump_held) fl |= 16384;
      const lj = this._last_jump;
      if (lj < 0.0) { fl |= 32768; F[nd++] = Math.min(now + lj, 750.0); }
      else F[nd++] = Math.min(now - lj, 150.0);
    }
    I[0] = fl;
    I[1] = this.coins; I[2] = this.blue_coins;
    I[3] = this.jump_count; I[4] = this.max_jumps; I[5] = this.jump_boost; I[6] = this.speed_boost;
    I[7] = this.flip_gravity;
    I[8] = (this.checkpoint.x + 1) | ((this.checkpoint.y + 1) << 16);   // tile coords, W, H < 65535
    I[9] = this._next_spawn;
    I[10] = (this._pastx + 1) | ((this._pasty + 1) << 16);
    I[11] = this._q0; I[12] = this._q1;
    I[13] = (this.overlapa + 1) | ((this.overlapb + 1) << 16);
    I[14] = (this.overlapc + 1) | ((this.overlapd + 1) << 16);
    I[15] = (this.gravity_dir.x + 1) + 3 * (this.gravity_dir.y + 1) + 16 * this._keysMask;
    let o = 16;
    // key timers (colors that have key tiles): ticks until (offset - timer) / 30 >= 5, for active keys and
    // keys with a queued switch; -1 otherwise
    const kc = this._keyColors;
    if (kc.length !== 0) {
      let rel = this._keysMask;
      for (let q = 0; q < this._keysQueue.length; q += 2) rel |= 1 << this._keysQueue[q];
      for (let j = 0; j < kc.length; j++) {
        const c = kc[j];
        if ((rel & (1 << c)) !== 0) {
          const t = this._kt[c];
          let n;
          if (this._ktCacheT[c] === t) n = this._ktCacheN[c];
          else { n = expiryTick(t, this._ticks); this._ktCacheT[c] = t; this._ktCacheN[c] = n; }
          const r = n - this._ticks;
          I[o++] = r > 0 ? r : 0;
        } else I[o++] = -1;
      }
    }
    if (L.hasTimeDoors) I[o++] = expiryTick(this._hide_timedoor_offset, this._ticks) - this._ticks;
    if (L.hasDeathDoor) I[o++] = this.deaths;
    if (L.hasCoinGate) I[o++] = this._show_coin_gate;
    if (L.hasBlueCoinGate) I[o++] = this._show_blue_coin_gate;
    if (L.hasDeathGate) I[o++] = this._show_death_gate;
    if (L.multiTargetPortals) I[o++] = this._rngSteps;   // == RNG state (seeded at reset)
    this._coinOff = o;
    if (L.coinTiles.length !== 0) { const cb = this._coinBits; for (let w = 0; w < cb.length; w++) I[o++] = cb[w]; }
    if (L.secretTiles.length !== 0) { const sb = this._secretBits; for (let w = 0; w < sb.length; w++) I[o++] = sb[w]; }
    return nd;
  }

  /** Per-level key layout: [int32 slots the level can vary][pad][5 + up to 5 conditional doubles]. */
  _initKeyLayout() {
    const L = this.level;
    if (L.width >= 65535 || L.height >= 65535) throw new Error('stateKey: level too large for packed tile coordinates');
    const present = new Set();
    for (let i = 0; i < L.fg.length; i++) { const c = keyColorIndex(L.fg[i]); if (c >= 0) present.add(c); }
    this._keyColors = [...present].sort((a, b) => a - b);
    let nI = 16 + this._keyColors.length;
    if (L.hasTimeDoors) nI++;
    if (L.hasDeathDoor) nI++;
    if (L.hasCoinGate) nI++;
    if (L.hasBlueCoinGate) nI++;
    if (L.hasDeathGate) nI++;
    if (L.multiTargetPortals) nI++;
    if (L.coinTiles.length !== 0) nI += L.coinWords;
    if (L.secretTiles.length !== 0) nI += L.secretWords;
    if (nI & 1) nI++;   // keep the doubles 8-byte aligned
    const ab = new ArrayBuffer(nI * 4 + 10 * 8);
    this._keyBuf = ab;
    this._keyI = new Int32Array(ab, 0, nI);
    this._keyDoubleOff = nI * 4;
    this._keyF = new Float64Array(ab, nI * 4, 10);
    this._keyBytes = Buffer.from(ab);
    this._keyW = new Int32Array(ab);
    if (typeof this._keyBytes.ucs2Slice !== 'function') {
      const b = this._keyBytes;
      b.ucs2Slice = (a, e) => b.toString('utf16le', a, e);
    }
  }

  _boxTouchesOneWay() {
    const x = this.px, y = this.py;
    if (x < 0.0 || y < 0.0 || x > this._maxX || y > this._maxY) return false;
    const ox = Math.trunc(x) >> 4, oy = Math.trunc(y) >> 4;
    const cxEnd = Math.ceil((x + 16.0) / 16.0), cyEnd = Math.ceil((y + 16.0) / 16.0);
    for (let cy = oy; cy < cyEnd; cy++) {
      for (let cx = ox; cx < cxEnd; cx++) {
        if ((this._flags[this.tiles[cy * this.width + cx]] & F_JUMPTHRU) !== 0) return true;
      }
    }
    return false;
  }
}

function rectHit(x, y, rx, ry, rw, rh) {
  return x < rx + rw && rx < x + 16.0 && y < ry + rh && ry < y + 16.0;
}

function copyInto(dst, src) {
  if (dst.length !== 0) dst.length = 0;   // (setting .length is a slow runtime call in V8: skip when empty)
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

function intsKey(arr) {
  let s = '';
  for (let i = 0; i < arr.length; i++) { const v = arr[i] | 0; s += String.fromCharCode(v & 0xFFFF, (v >>> 16) & 0xFFFF); }
  return s;
}

function switchKey(m) {
  if (m._key !== undefined) return m._key;
  const on = [];
  for (const [id, v] of m) if (v === true) on.push(id);
  on.sort((a, b) => a - b);
  const k = intsKey(on);
  m._key = k;
  return k;
}

// ------------------------------------------------------------------ snapshot object
// Every scalar field of the sim that snapshot()/restore() copy (the Godot _SNAP_PROPS minus the arrays,
// plus the RNG state). Straight-line copy code is generated from this list.
const SNAP_SCALARS = ['px', 'py', 'prev_px', 'prev_py', 'speed_x', 'speed_y', 'on_ground', 'is_dead',
  'in_god_mode', 'coins', 'blue_coins', 'has_crown', 'has_silver_crown', 'deaths', 'teleported', 'modifier_x',
  'modifier_y', 'current_tile', 'flip_gravity', 'jump_count', 'max_jumps', 'jump_boost', 'speed_boost',
  'low_gravity', 'is_invulnerable', 'is_on_fire', 'run_ticks', 'morx', 'mory', 'mox', 'moy', '_next_spawn',
  '_keysMask', '_offset', '_timedoor_state', '_hide_timedoor_offset', '_show_coin_gate', '_show_blue_coin_gate',
  '_show_death_gate', '_collide_crown', '_collide_silver_crown', '_ticks', '_q0', '_q1', '_last_jump',
  '_slippery', '_pastx', '_pasty', '_ox', '_oy', 'overlapa', 'overlapb', 'overlapc', 'overlapd',
  '_last_portal_set', '_last_portal_x', '_last_portal_y', '_dead_offset', '_fire_time_start', '_fire_duration',
  '_horizontal', '_vertical', '_spacedown', '_spacejustdown', '_prev_jump_held', '_mx', '_my', '_current',
  '_evKeysMask', '_ev_coins', '_ev_bcoins', '_ev_timedoor', '_ev_grav_x', '_ev_grav_y', '_rngState', '_rngSteps'];

// eslint-disable-next-line no-new-func
const EESnapshot = new Function(SNAP_SCALARS.map((f) => `this.${f} = 0;`).join('\n') + `
  this.gdx = 0; this.gdy = 0; this.cpx = 0; this.cpy = 0;
  this.kt0 = 0; this.kt1 = 0; this.kt2 = 0; this.kt3 = 0; this.kt4 = 0; this.kt5 = 0;
  this.coinBits = null; this.secretBits = null; this.switches = null; this.oswitches = null;
  this.evSwitches = null; this.evOSwitches = null;
  this.stateQueue = null; this.keysQueue = null; this.tileQueue = null; this.level = null;`);
// eslint-disable-next-line no-new-func
EESim.prototype._snapScalars = new Function('s', SNAP_SCALARS.map((f) => `s.${f} = this.${f};`).join('\n'));
// eslint-disable-next-line no-new-func
EESim.prototype._restoreScalars = new Function('s', SNAP_SCALARS.map((f) => `this.${f} = s.${f};`).join('\n'));

module.exports = {
  loadLevel, prepareLevel, EESim, EEInput, EESnapshot, applyMask, parseEetas,
  COLORS, DRAG_HEX, SNAP_SCALARS, RNG_SEED_STATE, pcgSeedState, pcgStep, pcgOut,
  constants: { BASE_DRAG, ICE_NO_MOD_DRAG, ICE_DRAG, NO_MOD_DRAG, WATER_DRAG, MUD_DRAG, LAVA_DRAG, TOXIC_DRAG, MULT },
};
