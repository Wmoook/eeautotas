'use strict';
// eesim.js - bit-exact JavaScript port of scripts/physics/ee_sim.gd (EESim, the exact port of Everybody
// Edits Offline's Player.as / PlayState / World physics) for headless TAS optimization, with the tick loop,
// clocks and start sequence of eeo-tas (ground truth: eeo-tas/src, see docs/eeo_spec/tick_loop.md, state.md).
//
//   const { EESim, EEInput, applyMask, parseEetasBytes } = require('./eesim.js');
//   const level = require('./eelvl.js').loadEelvlLevel('level.eelvl');   // or loadLevel('<toSimLevel>.json')
//   const sim = new EESim(level);            // starts like eeo-tas: level load, /reset, /playtas (see reset())
//   const inp = new EEInput();
//   for (const m of parseEetasBytes(fs.readFileSync('run.eetas'))) { applyMask(inp, m); sim.tick(inp); }
//
// eeo-tas clocks (commit d6e2072, "fixes #7, #22, #31, #32"): keys and time doors run on the integer level clock
// PlayState.ticks (sim._ticks), not on EE Offline's World.offset (+0.3 per tick), and the respawn after a death
// happens at the end of Player.tick, before PlayState's per-frame queues.
//
// Block mechanics beyond ee_sim.gd, ported from eeo-tas's Player.as / Me.as / World.as directly (see
// docs/ENGINE_NOTES.md "Block mechanics", test/mechanics.js): curse 421, zombie 422 / NPC 1573, poison 1584 (tick
// timers, protection 420, respawn), levitation 418 (thrust), teams 423 / 1027 / 1028 (with the per-tick retry of a
// blocked change), zombie gate 206 / door 207, the gold door option, and the AS3 lookup table (lookup_int).
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
const EFFECT_JUMP = 417, EFFECT_FLY = 418, EFFECT_RUN = 419, EFFECT_PROTECTION = 420, EFFECT_LOW_GRAVITY = 453;
const EFFECT_CURSE = 421, EFFECT_ZOMBIE = 422, EFFECT_TEAM = 423, EFFECT_POISON = 1584, NPC_ZOMBIE = 1573;
const EFFECT_MULTIJUMP = 461, EFFECT_GRAVITY = 1517, EFFECT_RESET = 1618;
const TEAM_DOOR = 1027, TEAM_GATE = 1028, ZOMBIE_GATE = 206, ZOMBIE_DOOR = 207, DOOR_GOLD = 200, GATE_GOLD = 201;
// Levitation (Player.as:325-326): _maxThrust = .2, _thrustBurnOff = .01; updateThrust uses physics_jump_height / 2 = 13
const MAX_THRUST = 0.2, THRUST_BURN_OFF = 0.01, THRUST_SCALE = JUMP_HEIGHT / 2;
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

/**
 * Player.setEffect's timed-effect duration (Player.as:1724-1730) for a block number / lava's 2:
 * `duration += 2 * Global.ping; duration *= 100` in doubles (Global.ping = 0.2, Global.as:166-169). The effect kills
 * in the first tick T with `PlayState.ticks - start > duration` (Player.as:399-404), i.e. T = start + floor(D) + 1:
 * D is not always an integer (v = 16 gives 1639.9999999999998, so it kills at start + 1640, not + 1641).
 */
function effectDuration(v) {
  let d = v;
  d += 2 * PING;
  d *= 100;
  return d;
}

// ------------------------------------------------------------------ eeo-tas level clock (PlayState.ticks)
// World.update (World.as:137-156) runs at the start of every tick, after `ticks++` (PlayState.as:562):
//   setTimedoor((Global.playState.ticks / 100) % 10 >= 5);
//   for (color in keys) if (getKey(color) && ((ticks - keysTimer[color]) / 100) >= 5) switchKey(color, false);
// and World.setKey (World.as:117-123) drops a queued retry when ((ticks - keysTimer) / 100) >= 5 and stamps
// keysTimer = ticks when a key turns on (not from the queue). ticks and keysTimer are ints, so in doubles:
//  - ((d / 100) >= 5) === (d >= 500) for every integer d with |d| < 2^53 (d / 100 is correctly rounded and
//    monotone; 499 / 100 = 4.99 < 5, 500 / 100 = 5 exactly): a key lasts exactly KEY_TICKS ticks.
//  - ((t / 100) % 10 >= 5) === (t % 1000 >= 500) for every integer t >= 0 with t / 100 < 2^46: `%` (fmod) is
//    exact, t / 100 rounds to within 2^-7 of 10k + (t % 1000) / 100 and never onto 10k + 5 or 10k + 10 from
//    the other side. test/regress.js checks both over t, d in [0, 2e6) and [-3e3, 3e3).
const KEY_TICKS = 500;
const TIMEDOOR_PERIOD = 1000, TIMEDOOR_HALF = 500;

// PlayState's start sequences (reset()): 'reset' = load the level, /reset, /playtas; 'load' = load, /playtas.
const START_MODES = ['reset', 'load'];

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

/** Loads a level JSON (eelvl.js toSimLevel, or the older Godot export_level.gd) and prepares it. Read-only, shareable. */
function loadLevel(file, opts) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return prepareLevel(d, opts);
}

/**
 * Level JSON (the toSimLevel format) -> the read-only level object every EESim shares.
 * opts (each also read from the JSON when absent here; they are per-run defaults for new EESim(level)):
 *   start: 'reset' | 'load'   (JSON start_mode, default 'reset'), idleTicks (idle_ticks, 0),
 *   startSpawn (start_spawn, null), goldBorder (gold_border, false), ticksPerFrame (ticks_per_frame, 1).
 * See EESim.reset() and EESim.tick() for what they model.
 */
function prepareLevel(d, opts) {
  opts = opts || {};
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

  // Lookup.getInt (Lookup.as:70-73): World.deserializeFromMessage stores the record's int for every rotatable /
  // half / numbered / music / spike entry, keyed by position only, on EITHER layer, last write wins, never removed
  // at load (World.as:292-348). toSimLevel exports exactly that as lookup_int. Older JSON without it: the extras
  // (ee_level.gd: layer-0 records only, a later record without an int clears the value) - identical for every file
  // EEO itself writes (one record per position), which is all the sample levels.
  const lookup0 = new Int32Array(N);
  const useLookupInt = Array.isArray(d.lookup_int);
  if (useLookupInt) {
    for (const e of d.lookup_int) {
      const i = e[0] | 0;
      if (i >= 0 && i < N) lookup0[i] = e[1] | 0;
    }
  }
  // Portals = AS3 Lookup.portalLookup (Lookup.as:135-171): World.deserializeFromMessage (World.as:349-352) calls
  // setPortal for EVERY 242/381 record, whatever its layer, keyed by position only (a later record at the cell
  // replaces the entry: last write wins) and never removed at load, also when a later record puts another block on
  // the cell. processPortals (Player.as:1087-1102) enters only from a layer-0 242/381 tile, with that cell's entry
  // (none = Portal(0, 0, 0): target == id, no teleport), and getPortals(target) takes EVERY entry with that id as an
  // exit: background (layer-1) records and stale entries under other blocks included. toSimLevel exports the
  // lookup as `portals` [index, rotation, id, target, type] in insertion order (= the extras order for every file
  // EEO writes); JSON without it (older exports) falls back to the extras whose final tile is 242/381.
  // The only runtime change: collecting a coin calls setTileComplex(0, ...) -> deleteLookup (World.as:415-418), which
  // removes a portal entry at that cell for good (/reset's resetCoins uses setTile: it does not come back).
  const portalSlot = new Int32Array(N).fill(-1);
  const pId = [], pTarget = [], pRot = [];
  const byId = new Map();                     // portal id -> {xs, ys, cells} (px positions, <<4), lookup order
  const cd = new Set(), bcd = new Set();
  const addPortal = (i, rotation, id, target) => {
    const px = id === null || id === undefined ? 0 : id | 0;
    const tg = target === null || target === undefined ? 0 : target | 0;
    const rt = rotation === null || rotation === undefined ? 0 : rotation | 0;
    let slot = portalSlot[i];
    if (slot < 0) { slot = pId.length; portalSlot[i] = slot; pId.push(0); pTarget.push(0); pRot.push(0); }
    pId[slot] = px; pTarget[slot] = tg; pRot[slot] = rt;
  };
  const usePortalLookup = Array.isArray(d.portals);
  if (usePortalLookup) {
    for (const e of d.portals) {
      const i = e[0] | 0;
      if (i >= 0 && i < N) addPortal(i, e[1], e[2], e[3]);
    }
  }
  for (const e of d.extras) {
    const i = e[0], rotation = e[1], id = e[2], target = e[3];
    const t = fg[i];
    if (t === PORTAL || t === PORTAL_INVISIBLE) {
      if (!usePortalLookup) addPortal(i, rotation, id, target);
    } else if (!useLookupInt && rotation !== null && rotation !== undefined) {
      lookup0[i] = rotation;
    }
  }
  // exits per id, in slot (= lookup insertion) order; each position appears once (the lookup is position keyed)
  const slotCell = new Int32Array(pId.length);
  for (let i = 0; i < N; i++) if (portalSlot[i] >= 0) slotCell[portalSlot[i]] = i;
  for (let s = 0; s < pId.length; s++) {
    const i = slotCell[s];
    if (!byId.has(pId[s])) byId.set(pId[s], { xs: [], ys: [], cells: [] });
    const l = byId.get(pId[s]);
    l.xs.push((i % W) << 4); l.ys.push(Math.floor(i / W) << 4); l.cells.push(i);
  }
  // coin / blue coin door thresholds (door_state events only)
  for (let i = 0; i < N; i++) {
    const t = fg[i];
    if (t === COINDOOR || t === COINGATE) cd.add(lookup0[i]);
    else if (t === BLUECOINDOOR || t === BLUECOINGATE) bcd.add(lookup0[i]);
  }
  // World.spawnPoints[0] (World.as:359-366): every 255 and every 1582 with number 0, both layers, in level-file
  // record order (entry order inside a record); toSimLevel exports it as spawn_points. worldSpawn is 0 for an
  // opened file (world portals, which could change it, need the Y key: inert in a replay). Old JSON without
  // spawn_points: the 255 tiles of layer 0 in row-major order (not EEO's order when there are several).
  const spX = [], spY = [];
  let spawnOrder = 'file';
  if (Array.isArray(d.spawn_points)) {
    const s0 = Array.isArray(d.spawn_points[0]) ? d.spawn_points[0] : [];
    for (const p of s0) { spX.push(p[0] | 0); spY.push(p[1] | 0); }
  } else {
    spawnOrder = 'row-major';
    for (let i = 0; i < N; i++) if (fg[i] === SPAWNPOINT) { spX.push(i % W); spY.push(Math.floor(i / W)); }
  }
  let hasTimeDoors = false, hasCoinGate = false, hasBlueCoinGate = false, hasDeathDoor = false, hasDeathGate = false;
  let hasTeamEffect = false;    // 423: the only way `team` / the pending team retry can change after /reset
  let clockSensitive = false;   // key tiles or time doors (the level clock matters); informational
  // Coin cells: 100/101, and 110/111 stored in the file (collected coins: not collectible after a plain load,
  // turned back into 100/101 by World.resetCoins in /reset, World.as:402-409). coinBaseId = the uncollected id.
  const coinTiles = [], coinBaseId = [], secretTiles = [];
  const coinBit = new Int32Array(N).fill(-1), secretBit = new Int32Array(N).fill(-1);
  const ovl = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = fg[i];
    if (t === 156 || t === 157) hasTimeDoors = true;
    if (t === COINGATE) hasCoinGate = true;
    if (t === BLUECOINGATE) hasBlueCoinGate = true;
    if (t === DEATH_DOOR || t === DEATH_GATE) hasDeathDoor = true;
    if (t === DEATH_GATE) hasDeathGate = true;
    if (t === EFFECT_TEAM) hasTeamEffect = true;
    if (t === 6 || t === 7 || t === 8 || t === 408 || t === 409 || t === 410 || t === 156 || t === 157) clockSensitive = true;
    if (t === COIN_GOLD || t === COIN_BLUE || t === COIN_GOLD + 10 || t === COIN_BLUE + 10) {
      coinBit[i] = coinTiles.length; coinTiles.push(i); coinBaseId.push(t === COIN_GOLD || t === COIN_GOLD + 10 ? COIN_GOLD : COIN_BLUE);
    }
    if (t === 50 || t === 243) { secretBit[i] = secretTiles.length; secretTiles.push(i); }
    const f = flags[t];
    if ((f & F_SOLID) === 0) ovl[i] = t === 243 ? OV_SECRET : OV_AIR;
    else if ((f & (F_ROTHALF | F_HALF | F_JUMPTHRU | F_DOOR)) !== 0) ovl[i] = OV_COMPLEX;
    else ovl[i] = OV_SOLID;
  }
  // portal entries on coin cells (crafted files only: a background portal record under a coin, or a portal record
  // overwritten by a coin): collecting that coin deletes the entry (see above), tracked per run in _portalGone
  const portalCoinIdx = new Int32Array(N).fill(-1);
  let nPortalCoins = 0;
  for (let s = 0; s < pId.length; s++) if (coinBit[slotCell[s]] >= 0) portalCoinIdx[slotCell[s]] = nPortalCoins++;
  const portalsById = new Map();
  for (const [k, v] of byId) {
    let pc = null;
    for (let j = 0; j < v.cells.length; j++) {
      const b = portalCoinIdx[v.cells[j]];
      if (b >= 0) { if (pc === null) pc = new Int32Array(v.cells.length).fill(-1); pc[j] = b; }
    }
    portalsById.set(k, { xs: Int32Array.from(v.xs), ys: Int32Array.from(v.ys), n: v.xs.length, pc });
  }
  // random exits (the RNG step count is keyed): an enterable portal (layer-0 242/381) whose target has 2+ exits
  let multiTarget = false;
  for (let s = 0; s < pId.length; s++) {
    const t = fg[slotCell[s]];
    const l = portalsById.get(pTarget[s]);
    if ((t === PORTAL || t === PORTAL_INVISIBLE) && pTarget[s] !== pId[s] && l && l.n > 1) multiTarget = true;
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
  const coinWords = Math.max(1, Math.ceil(coinTiles.length / 32));
  const coinBits0 = new Int32Array(coinWords);   // collected-coin bitset after a plain load: the file's 110/111
  for (let k = 0; k < coinTiles.length; k++) if (fg[coinTiles[k]] !== coinBaseId[k]) coinBits0[k >> 5] |= 1 << (k & 31);
  const pick = (a, b, dflt) => (a !== undefined && a !== null ? a : (b !== undefined && b !== null ? b : dflt));
  const startMode = String(pick(opts.start, d.start_mode, 'reset'));
  if (!START_MODES.includes(startMode)) throw new Error(`start mode '${startMode}' (expected ${START_MODES.join(' or ')})`);
  const startSpawn = pick(opts.startSpawn, d.start_spawn, null);
  return {
    id: d.level_id, file: d.level_file, width: W, height: H, gravity,
    // Player.worldGravityMultiplier = the header float32 as stored (PlayState.as:104, 116): 0 means no gravity,
    // a negative value pulls the other way; no clamping or fallback (only the /gravity command limits 0.1..3).
    gravityMult: gravity,
    fg, bg, lookup0, flags, xflags: extra, ovl, airMask, airPS, gMorx, gMory, gMox, gMoy, gFlags,
    portalSlot, pId: Int32Array.from(pId), pTarget: Int32Array.from(pTarget), pRot: Int32Array.from(pRot),
    portalsById, multiTargetPortals: multiTarget, rngScript: Array.isArray(d.rng_script) ? Int32Array.from(d.rng_script) : null,
    // portal entries on coin cells: index per cell (null when the level has none), count, the per-run deleted set's
    // start value (all present; shared, replaced on write)
    portalCoinIdx: nPortalCoins > 0 ? portalCoinIdx : null, nPortalCoins,
    portalGone0: new Int32Array(Math.max(1, Math.ceil(nPortalCoins / 32))),
    coinDoorThresholds: Int32Array.from([...cd].sort((a, b) => a - b)),
    blueCoinDoorThresholds: Int32Array.from([...bcd].sort((a, b) => a - b)),
    spawnsX: Int32Array.from(spX), spawnsY: Int32Array.from(spY), spawnOrder,
    hasTimeDoors, hasCoinGate, hasBlueCoinGate, hasDeathDoor, hasDeathGate, hasTeamEffect, clockSensitive,
    coinTiles: Int32Array.from(coinTiles), coinBaseId: Int32Array.from(coinBaseId), coinBit, coinWords, coinBits0,
    secretTiles: Int32Array.from(secretTiles), secretBit, secretWords: Math.max(1, Math.ceil(secretTiles.length / 32)),
    // per-run defaults for new EESim(level) (see EESim.reset() / tick())
    startMode, idleTicks: Math.max(0, pick(opts.idleTicks, d.idle_ticks, 0) | 0),
    startSpawn: startSpawn === null ? null : startSpawn | 0,
    goldBorder: !!pick(opts.goldBorder, d.gold_border, false),
    ticksPerFrame: Math.max(1, pick(opts.ticksPerFrame, d.ticks_per_frame, 1) | 0),
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

/**
 * .eetas file bytes -> Uint8Array of masks (1 jump, 2 left, 4 right, 8 up, 16 down), exactly as eeo-tas plays them.
 *
 * /loadtas copies the file into a ByteArray verbatim (UI2.as:2254-2271): no text decoding, no trimming, no BOM
 * handling. Every executed tick reads ONE byte while bytes remain (PlayState.as:539-541, Me.as:35-45):
 * TASInput.readInputs (tas/TASInput.as:21-34) does `v = readByte() - 48` (readByte is signed, -128..127) and
 * takes jump = v & 1, left = (v >> 1) & 1, right = (v >> 2) & 1, up = (v >> 3) & 1, down = (v >> 4) & 1 (int32
 * two's complement). 256 is a multiple of 32, so that is `(byte - 48) & 31` for every byte value:
 * '0'..'O' (48..79, the only bytes /record writes) -> 0..31, 'P'..'_' wrap to 0..15, LF -> 26 (left+up+down),
 * CR -> 29 (jump+right+up+down), space -> 16 (down), a UTF-8 BOM EF BB BF -> three ticks 31, 11, 15.
 * Byte i drives tick i + 1 (PlayState.ticks = i + 1 after /reset). Jump is a fresh press on every tick with the bit
 * (spacejustdown = spacedown = bit 0): applyMask(input, mask) feeds it to EESim.tick.
 *
 * End of the file: in the tick after the last byte was consumed, PlayState.tick sees bytesAvailable == 0 and
 * !endofTAS (PlayState.as:543-555). With /playtas it sets endofTAS, keeps ticks running (that same tick runs) and
 * sets Config.physics_ms_per_tick = TASGlobal.speedMult (1 ms per tick = 10x speed unless /speed was used); that
 * tick and every later one read the LIVE KEYBOARD (Me.as:47-53), normally nothing held = mask 0, and the game never
 * stops by itself (the level is complete when touchBlock sets `completed`; the run timer stops there). With
 * /playsegment it pauses instead: no further tick runs. So a run must complete within its bytes; tools write
 * masks.slice(0, completeTick) and simulate past the end, if at all, with mask 0.
 */
function parseEetasBytes(buf) {
  if (typeof buf === 'string') throw new TypeError('parseEetasBytes takes the raw file bytes (Buffer / Uint8Array), not text');
  if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
  const n = buf.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (buf[i] - 48) & 31;   // (x - 48) & 31 depends only on x mod 32 = the byte's
  return out;
}

/**
 * Older API: a string (or bytes, which go to parseEetasBytes). The string is taken as one byte per UTF-16 code unit
 * (its low 8 bits), i.e. exactly parseEetasBytes(Buffer.from(text, 'latin1')): right for text that was decoded
 * from the raw bytes as latin1, or for pure ASCII files read as 'utf8'. A file read as 'utf8' that contains other
 * bytes (a BOM, non-ASCII) cannot be recovered from the string: read files with fs.readFileSync(file) (no encoding)
 * and call parseEetasBytes. No trimming, no BOM skipping (eeo-tas plays every byte).
 */
function parseEetas(text) {
  if (typeof text !== 'string') return parseEetasBytes(text);
  const n = text.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (text.charCodeAt(i) - 48) & 31;   // low byte (latin1) - 48, low 5 bits
  return out;
}

/** Bytes of an .eetas that /record never writes (outside '0'..'O', 48..79): each is still a tick in eeo-tas. */
function eetasOddBytes(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'latin1');
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] & 0xFF;
    if (b < 48 || b > 79) out.push({ index: i, byte: b, mask: (b - 48) & 31 });
  }
  return out;
}

// fmod(x, 1.0) and fmod(x, 16.0) without V8's slow C fmod call. For x > 0 these are exact: x - trunc(x)
// and x - 16*floor(x/16) are exactly representable (Sterbenz), and equal fmod mathematically. x <= 0
// (+-0 keeps its sign in fmod; negative positions never happen) falls back to %, which is IEEE fmod.
function fmod1(x) { return x > 0.0 ? x - Math.trunc(x) : x % 1.0; }
function fmod16(x) { return x > 0.0 ? x - 16.0 * Math.floor(x * 0.0625) : x % 16.0; }
// The integer forms of the eeo-tas clock tests (see KEY_TICKS), spot-checked here at load time around every
// boundary up to 1e5 (test/regress.js checks the full ranges).
(() => {
  for (let b = 0; b <= 100000; b += 500) {
    for (let t = Math.max(0, b - 2); t <= b + 2; t++) {
      if ((((t / 100) % 10) >= 5) !== ((t % TIMEDOOR_PERIOD) >= TIMEDOOR_HALF)) throw new Error('eesim: time door clock check failed at ' + t);
      if (((t / 100) >= 5) !== (t >= KEY_TICKS) || (((-t) / 100) >= 5) !== (-t >= KEY_TICKS)) throw new Error('eesim: key clock check failed at ' + t);
    }
  }
})();
const KEY_DOUBLES = 16;          // stateKey double slots (at most 14 are used, see _initKeyLayout)
const AIR_REQ = [1, 3, 9, 27];   // tileMask bits of a box covering 1x1, 2x1, 1x2, 2x2 tiles
const REQ3 = [1, 3, 7, 9, 27, 63, 73, 219, 511];   // tileMask bits of a w x h region, index (w-1) + 3*(h-1)
function signi(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }  // int(signf(x))

const EMPTY_Q = Object.freeze([]);

// ------------------------------------------------------------------ the simulator
class EESim {
  /**
   * opts (per-run settings, not state; defaults come from the level, see prepareLevel):
   *   start: 'reset' | 'load'  how the replay starts (reset()); default 'reset' = load the level, /reset, /playtas
   *   idleTicks: n             live ticks with nothing pressed between the level load and /reset (or /playtas)
   *   startSpawn: k | null     force spawnPoints[0][k] as the start spawn (the rotation continues from k)
   *   goldBorder: bool         the player's gold smiley border (cookie setting): gold door 200 open, gate 201 shut
   *   ticksPerFrame: k         PlayState's per-frame queues drain after ticks with PlayState.ticks % k == 0 (tick())
   * Changing a setting takes effect at the next reset() (goldBorder and ticksPerFrame at once).
   */
  constructor(level, opts) {
    if (!level || !level.fg) throw new Error('EESim needs a level from loadLevel()');
    this.level = level;
    this.onEvent = null;
    const o = opts || {};
    const pick = (a, b) => (a !== undefined && a !== null ? a : b);
    this.startMode = String(pick(o.start, level.startMode || 'reset'));
    this.idleTicks = pick(o.idleTicks, level.idleTicks || 0);
    this.startSpawn = pick(o.startSpawn, level.startSpawn === undefined ? null : level.startSpawn);
    this.goldBorder = !!pick(o.goldBorder, level.goldBorder);
    this.ticksPerFrame = Math.max(1, pick(o.ticksPerFrame, level.ticksPerFrame || 1) | 0);
    /** Diagnostic: ticks that ended with an orange-switch / crown / key retry pending in PlayState's per-frame queues. */
    this.frame_queue_ticks = 0;
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
    // timed effects (Player.as:110-120, 321-322, 329): the raw flags (Player.zombie/poison read false while flying)
    // and setEffect's start tick / duration (see effectDuration); fire's are _fire_time_start / _fire_duration
    this.is_cursed = false; this._curse_time_start = 0; this._curse_duration = 0.0;
    this.is_zombie = false; this._zombie_time_start = 0; this._zombie_duration = 0.0;
    this.is_poisoned = false; this._poison_time_start = 0; this._poison_duration = 0.0;
    // levitation (Player.as:316, 324-327): hasLevitation, isThrusting, _currentThrust
    this.has_levitation = false; this.is_thrusting = false; this._current_thrust = 0.0;
    // teams (Player.as:233, 278-279): team and the pending UpdateTeamDoors cell tx, ty (-1 = none)
    this.team = 0; this._team_tx = -1; this._team_ty = -1;
    this.morx = 0; this.mory = 0; this.mox = 0.0; this.moy = 0.0;
    // world state
    this._next_spawn = 0;
    this._keysMask = 0;                        // World.keys (bit c = COLORS[c])
    this._kt = new Int32Array(6);              // World.keysTimer: PlayState.ticks when the key turned on
    this._timedoor_state = false;              // World.timedoorState (as of the last World.update)
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
    // portal entries deleted by a coin pickup at their cell (bit = level.portalCoinIdx); never mutated in place (a
    // pickup installs a new array), so snapshots share it like a scalar
    this._portalGone = level.portalGone0;
    this._rngState = RNG_SEED_STATE; this._rngSteps = 0;
    // player internals
    this._ticks = 0;                          // PlayState.ticks
    this._tick0 = 0;                          // PlayState.ticks at the start of the replay (see ticks())
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
    this.reset();
  }

  // ================================================================ public API

  /**
   * The state in which eeo-tas runs tick 1 of a replay (byte 0 of the .eetas). How a TAS starts in eeo-tas:
   * /playtas (UI2.as:2207-2228) only rewinds the input file and turns ticks on; it resets nothing. The state it
   * starts from comes from:
   *  1. loading the level: a new PlayState, World and Player (PlayState.as:99-192), PlayState.ticks = 0,
   *     player.placeAtSpawn() -> spawnPoints[0][0] (nextSpawnPos becomes 1);
   *  2. idleTicks live ticks with nothing pressed (TASGlobal.ticksEnabled starts true, so a loaded level runs until
   *     the user pauses it with /tick or /reset; the player falls and settles);
   *  3. start 'reset' (the TAS workflow of the eeo-tas README: /reset, then /playtas): /reset (UI2.as:1701-1705)
   *     = player.resetPlayer() (Player.as:1265-1297), PlayState.ticks = 0, ticks paused. resetPlayer respawns at
   *     the NEXT spawn of the rotation (spawn index 1 % n after a load), zeroes coins, deaths, run timer, effects
   *     (static and timed), team, checkpoint, crowns and purple switches, and turns every 110/111 back into 100/101;
   *     it keeps keys and their timers, orange switches, PlayState's queues, the gravity queue, slippery, jumpCount,
   *     pastx/pasty, ox/oy, overlapa..d, lastPortal, the pending team retry (tx, ty), isThrusting, the time-door
   *     state and the gate snapshots (with idleTicks 0 these are the fresh-load values). The paused frames before
   *     /playtas still drain PlayState's queues (one pass).
   *     start 'load' (/playtas right after the load): spawn index 0, 110/111 stay collected, PlayState.ticks =
   *     idleTicks at the start.
   *  4. startSpawn, if set, overrides the start position with spawnPoints[0][startSpawn % n].
   * The portal-choice model (_rngState / rngScript steps) restarts at the TAS start (EEO's Math.random is unseeded).
   */
  reset() {
    if (!START_MODES.includes(this.startMode)) throw new Error(`start mode '${this.startMode}' (expected ${START_MODES.join(' or ')})`);
    this._freshLoad();
    const idle = Math.max(0, this.idleTicks | 0);
    if (idle > 0 || this.startMode === 'reset') {
      const ev = this.onEvent;
      this.onEvent = null;
      try {
        if (idle > 0) {
          const inp = new EEInput();
          for (let i = 0; i < idle; i++) { inp.clear(); this.tick(inp); }
        }
        if (this.startMode === 'reset') this._slashReset();
      } finally {
        this.onEvent = ev;
      }
    }
    const L = this.level;
    if (this.startSpawn !== null && this.startSpawn !== undefined && L.spawnsX.length > 0) {
      const n = L.spawnsX.length, k = (((this.startSpawn | 0) % n) + n) % n;
      this.px = L.spawnsX[k] * 16; this.py = L.spawnsY[k] * 16;
      this._next_spawn = k + 1;
    }
    this._rngState = RNG_SEED_STATE; this._rngSteps = 0; this.rngNeed = 0;
    this.frame_queue_ticks = 0;
    this._tick0 = this._ticks;   // PlayState.ticks when the replay starts (0 after /reset)
    this.prev_px = this.px; this.prev_py = this.py;
    this.teleported = true;
    // event baselines: events describe changes from here on
    this._evKeysMask = this._keysMask; this._ev_coins = this.coins; this._ev_bcoins = this.blue_coins;
    this._ev_timedoor = this._timedoor_state;
    this._evSwitches = new Map(); this._evSwOwned = true;
    this._evOSwitches = new Map(); this._evOSwOwned = true;
    this._switch_dirty = this._switches.size !== 0 || this._oswitches.size !== 0;
    if (this._switch_dirty) { this._diffSwitchesSilently(false); this._diffSwitchesSilently(true); this._switch_dirty = false; }
    this._ev_grav_x = this.gravity_dir.x; this._ev_grav_y = this.gravity_dir.y;
    if (this.onEvent !== null) this.onEvent('respawn', { pos: { x: this.px, y: this.py } });
  }

  /** Loading the level: the PlayState constructor with a new World and Player (their field initializers). */
  _freshLoad() {
    const L = this.level;
    this.width = L.width; this.height = L.height;
    this.world_gravity_multiplier = L.gravityMult;
    this.tiles.set(L.fg);                                  // 110/111 in the file stay collected tiles
    this._lookup.set(L.lookup0);
    this._coinBits = L.coinBits0; this._coinOwned = false; // copy-on-write
    this._secretBits = new Int32Array(L.secretWords); this._secretOwned = true;
    this._portalGone = L.portalGone0;                      // a new Lookup: every portal entry of the file
    // World
    this._next_spawn = 0;
    this._keysMask = 0;
    this._kt.fill(0);
    this._timedoor_state = false;
    this._show_coin_gate = 0; this._show_blue_coin_gate = 0; this._show_death_gate = 0;
    this._oswitches = new Map(); this._oswOwned = true;
    // PlayState
    this._ticks = 0;
    this._stateQueue.length = 0; this._keysQueue.length = 0; this._tileQueue.length = 0;
    // Player / Me
    this._switches = new Map(); this._swOwned = true;
    this._switch_dirty = false;
    this._rngState = RNG_SEED_STATE; this._rngSteps = 0;
    this._q0 = 0; this._q1 = 0;                           // queue = Vector.<int>(2)
    this._last_jump = -(CLOCK_BASE + this._ticks * MS_PER_TICK);   // lastJump = -Date (irrelevant under eeo-tas input)
    this._slippery = 0.0;
    this._pastx = 0; this._pasty = 0;
    this.overlapa = -1; this.overlapb = -1; this.overlapc = -1; this.overlapd = -1;
    this._last_portal_set = true; this._last_portal_x = 0; this._last_portal_y = 0;   // lastPortal = new Point()
    this.has_crown = false; this.has_silver_crown = false;
    this._collide_crown = false; this._collide_silver_crown = false;
    this.coins = 0; this.blue_coins = 0; this.deaths = 0;
    this.checkpoint.x = -1; this.checkpoint.y = -1;
    this.flip_gravity = 0; this.jump_count = 0; this.max_jumps = 1; this.jump_boost = 0; this.speed_boost = 0;
    this.low_gravity = false; this.is_invulnerable = false;
    this.is_on_fire = false; this._fire_time_start = 0; this._fire_duration = 0.0;
    this.is_cursed = false; this._curse_time_start = 0; this._curse_duration = 0.0;
    this.is_zombie = false; this._zombie_time_start = 0; this._zombie_duration = 0.0;
    this.is_poisoned = false; this._poison_time_start = 0; this._poison_duration = 0.0;
    this.has_levitation = false; this.is_thrusting = false; this._current_thrust = 0.0;
    this.team = 0; this._team_tx = -1; this._team_ty = -1;
    this.in_god_mode = false;
    this.is_dead = false; this._dead_offset = 0.0;
    this.run_ticks = 0;
    this.speed_x = 0.0; this.speed_y = 0.0; this.modifier_x = 0.0; this.modifier_y = 0.0;
    this.morx = 0; this.mory = 0; this.mox = 0.0; this.moy = 0.0; this._mx = 0.0; this._my = 0.0;
    this._horizontal = 0; this._vertical = 0; this._spacedown = false; this._spacejustdown = false; this._prev_jump_held = false;
    this._current = 0; this.current_tile = 0;
    this.on_ground = false;
    this.gravity_dir.x = 0; this.gravity_dir.y = 1;
    this._ox = 0.0; this._oy = 0.0;                       // Player.as:293-294 (not the spawn position)
    this.px = 16.0; this.py = 16.0;                       // Player constructor
    this._placeAtSpawn(false);                            // PlayState.as:123
    this.frame_queue_ticks = 0;
  }

  /** /reset (UI2.as:1701-1705): Player.resetPlayer() (Player.as:1265-1297), then PlayState.ticks = 0, paused. */
  _slashReset() {
    if (!this.in_god_mode) {                              // resetPlayer returns at once while flying
      this.has_crown = false; this.has_silver_crown = false;
      this._checkCrown(false);                            // at the pre-reset position: can defer on PlayState.queue
      this._checkSilverCrown(false);
      this._collide_crown = false; this._collide_silver_crown = false;
      this.deaths = 0;
      this.coins = 0; this.blue_coins = 0;                // Player.resetCoins
      this.is_dead = false;                               // resetDeath (deadoffset is left alone)
      // resetEffects(true) (Player.as:1817-1821): every static effect off (levitation also zeroes the thrust,
      // Player.as:1838-1844) and the timed ones (curse, zombie, fire, poison: flags only); isThrusting survives
      this.jump_boost = 0; this.speed_boost = 0; this.is_invulnerable = false; this.low_gravity = false;
      this.max_jumps = 1; this.flip_gravity = 0;
      this.has_levitation = false; this._current_thrust = 0.0;
      this.is_cursed = false; this.is_zombie = false; this.is_on_fire = false; this.is_poisoned = false;
      this.checkpoint.x = -1; this.checkpoint.y = -1;     // resetCheckpoint
      this._switches = new Map(); this._swOwned = true;   // switches = {}
      this.team = 0;                                      // team = 0 (the pending retry tx, ty is NOT cleared)
      this.run_ticks = 0;                                 // Me.ticks = 0; completed = false (== !has_silver_crown)
      this._resetCoinTiles();                             // World.resetCoins: 110 -> 100, 111 -> 101 (layer 0)
      this._secretBits = new Int32Array(this.level.secretWords); this._secretOwned = true;   // lookup.resetSecrets
      this.respawn();                                     // placeAtSpawn(true): the next spawn of the rotation
    }
    this._ticks = 0;
    // The paused frames between /reset and /playtas still run PlayState.enterFrame. Draining is idempotent at an
    // unchanged state (a retry that fails re-evaluates the same state), so one pass stands for all of them.
    this._drainFrameQueues();
  }

  /** World.resetCoins (World.as:402-409): every collected coin tile back to 100/101 (setTile: lookup untouched). */
  _resetCoinTiles() {
    const L = this.level, cb = this._coinBits;
    for (let w = 0; w < cb.length; w++) {
      let d = cb[w];
      while (d !== 0) {
        const low = d & -d;
        const k = w * 32 + (31 - Math.clz32(low));
        d ^= low;
        this.tiles[L.coinTiles[k]] = L.coinBaseId[k];
      }
    }
    this._coinBits = new Int32Array(L.coinWords); this._coinOwned = true;
  }

  /** Marks the current switch maps as already reported (event baselines at the start). */
  _diffSwitchesSilently(orange) {
    const cur = orange ? this._oswitches : this._switches;
    const seen = new Map();
    for (const [id, on] of cur) if (on) seen.set(id, true);
    if (orange) { this._evOSwitches = seen; this._evOSwOwned = true; } else { this._evSwitches = seen; this._evSwOwned = true; }
  }

  /** Ticks since the replay started = .eetas bytes consumed (the completion tick of a run). */
  ticks() { return this._ticks - this._tick0; }
  /** PlayState.ticks, the level clock (keys, time doors): ticks() plus the idle ticks of a start without /reset. */
  level_ticks() { return this._ticks; }

  is_key_active(color) { const c = COLORS.indexOf(color); return c >= 0 && (this._keysMask & (1 << c)) !== 0; }
  is_switch_on(id) { return this._switches.get(id) === true; }
  is_orange_switch_on(id) { return this._oswitches.get(id) === true; }
  get_tile_number(tx, ty) { return this._lookupAt(tx, ty); }
  /** Seconds (100 ticks) until an active key expires. */
  key_time_left(color) {
    const c = COLORS.indexOf(color);
    if (c < 0 || (this._keysMask & (1 << c)) === 0 || this.key_expiry_pending(color)) return 0.0;
    return Math.max(0.0, 5.0 - (this._ticks - this._kt[c]) / 100.0);
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
  /** Lookup.getPortal: the portalLookup entry at the cell (any layer; null if none or deleted by a coin pickup). */
  get_portal(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return null;
    const i = ty * this.width + tx, s = this.level.portalSlot[i], pci = this.level.portalCoinIdx;
    if (s < 0 || (pci !== null && pci[i] >= 0 && ((this._portalGone[pci[i] >> 5] >>> (pci[i] & 31)) & 1) !== 0)) return null;
    return { id: this.level.pId[s], target: this.level.pTarget[s], rotation: this.level.pRot[s] };
  }
  set_god_mode(on) {
    if (on === this.in_god_mode) return;
    this.in_god_mode = on;
    this.is_dead = false;
    if (this.onEvent !== null) this.onEvent('god_mode', { on: this.in_god_mode });
  }
  /**
   * Player.respawn() (Player.as:1240-1263): speeds and modifiers 0, alive, not on fire, purple retries dropped,
   * placeAtSpawn(true), then setEffect(curse / zombie / fire / poison, false). Team, levitation (thrust and
   * isThrusting), protection and the other static effects are kept.
   */
  respawn() {
    this.modifier_x = 0.0; this.modifier_y = 0.0;
    this.speed_x = 0.0; this.speed_y = 0.0;
    this.is_dead = false;
    this.is_on_fire = false;
    this._tileQueue.length = 0;
    this._placeAtSpawn(true);
    this.is_cursed = false; this.is_zombie = false; this.is_poisoned = false;
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

  /**
   * Exactly one eeo-tas tick (PlayState.tick, PlayState.as:534-795), in eeo-tas order: PlayState.ticks++, the three
   * gate snapshots, (god toggle: a test hook, the G key in eeo-tas), World.update (time doors, key expiry),
   * Player.tick (ending with the respawn check), then PlayState.enterFrame's queue drains. Mutates
   * input.jump_pressed / god_toggle like EESim.
   *
   * PlayState's `queue` (orange switch presses, crown and silver-crown collide flags) and `keysquene` (key on/off)
   * retries run in PlayState.enterFrame, ONCE PER RENDERED FRAME after that frame's ticks (PlayState.as:498-507,
   * blitter/BlGame.as handleEnterFrame: `for (; Bl.time < now; Bl.time += Config.physics_ms_per_tick) tick();
   * enterFrame();`), while ticks paused or not. During a replay the stage asks for 120 fps (Config.maxFrameRate,
   * PlayState.as:191) and /playtas N sets physics_ms_per_tick = 10 / N ms: at /playtas 1 a tick is due every 10 ms
   * and a frame every 8.3 ms, so each frame runs 0 or 1 tick (5 ticks per 6 frames) and every tick is followed by at
   * least one drain before the next. Extra drains between two ticks change nothing (a retry that fails re-evaluates
   * the same state), so that equals draining once after every tick: ticksPerFrame = 1, the default, also exactly
   * what Shift+C stepping (/record) does. A frame holds 2+ ticks when the player runs below 100 fps (lag, a 60 Hz
   * cap), at /playtas N > 1.2, and after the end of the file (1 ms per tick by default: about 8 ticks per frame);
   * then some retries wait for a later tick, depending on wall-clock timing that no replay reproduces.
   * ticksPerFrame = k models a steady k ticks per frame (drain after ticks with PlayState.ticks % k == 0), and
   * frame_queue_ticks counts the ticks that ended with a retry pending in these queues: a run with
   * frame_queue_ticks == 0 does not depend on the frame schedule at all. The purple-switch retries
   * (Player.tilequeue) run inside Player.tick every tick and are exact.
   */
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
    // --- World.update() (World.as:137-156); World.offset (+0.3) only animates in eeo-tas
    const t = this._ticks;
    this._timedoor_state = (t % TIMEDOOR_PERIOD) >= TIMEDOOR_HALF;   // setTimedoor((ticks / 100) % 10 >= 5)
    if (this._keysMask !== 0) {
      // for (color in keys): red, green, blue, cyan, magenta, yellow (AVM2 for-in order is unspecified; it only
      // matters when two keys expire on the same tick and one of them is deferred)
      for (let c = 0; c < 6; c++) {
        if ((this._keysMask & (1 << c)) !== 0 && (t - this._kt[c]) >= KEY_TICKS) this._switchKey(c, false, false);
      }
    }
    // --- Player.tick() (ends with the respawn: Player.as:1176-1179); true = eeo-tas threw in it (see _touchBlock)
    const threw = this._playerTick(input);
    // --- PlayState.enterFrame() (per rendered frame, see above): queue, then keysquene; not in the frame whose tick
    // threw (BlGame.handleEnterFrame never gets to it), so pending retries wait for the next tick's frame
    if (this._stateQueue.length !== 0 || this._keysQueue.length !== 0) {
      this.frame_queue_ticks++;
      if (!threw && (this.ticksPerFrame === 1 || t % this.ticksPerFrame === 0)) this._drainFrameQueues();
    }
    this._emitDiffs();
  }

  /** PlayState.enterFrame (PlayState.as:498-507): each loop takes the length first, so re-queued items wait. */
  _drainFrameQueues() {
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
  }

  _playerTick(input) {
    const flags = this._flags;
    const W = this.width;
    const now = CLOCK_BASE + this._ticks * MS_PER_TICK;
    const isgodmod = this.in_god_mode;
    if (this.is_dead) this._dead_offset += 0.3;
    else this._dead_offset = 0.0;
    // timed effects (Player.as:399-404, PlayState.ticks based), in this order, each `flag && duration && ticks - start
    // > duration`; the zombie and poison getters read false while flying (Player.as:1680-1695), and killPlayer does
    // nothing while flying or dead anyway. A duration of 0 (NPC zombie) never kills.
    if (!this.is_dead && (this.is_cursed || this.is_zombie || this.is_on_fire || this.is_poisoned)) {
      const t = this._ticks;
      if (this.is_cursed && this._curse_duration !== 0.0 && t - this._curse_time_start > this._curse_duration) this.kill_player();
      if (this.is_zombie && !isgodmod && this._zombie_duration !== 0.0 && t - this._zombie_time_start > this._zombie_duration) this.kill_player();
      if (this.is_on_fire && this._fire_duration !== 0.0 && t - this._fire_time_start > this._fire_duration) this.kill_player();
      if (this.is_poisoned && !isgodmod && this._poison_duration !== 0.0 && t - this._poison_time_start > this._poison_duration) this.kill_player();
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

    // pending team change (Player.as:421): `if (tx != -1) UpdateTeamDoors(tx, ty)`, every tick, before movement. tx
    // and ty are the members (Player.as:278-279), not the later `var tx:Number` / `var ty:Number` locals of the
    // auto-align code: EE Offline's Player.tick bytecode (built with Flex SDK 4.6, the SDK of eeo-tas's
    // .actionScriptProperties) reads `getlocal0; getproperty private::tx` here.
    if (this._team_tx !== -1) this._updateTeamDoors(this._team_tx, this._team_ty);

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

    let sm = 1.0;                                 // speedMultiplier (Player.as:363-369)
    if (this.speed_boost === 1) sm *= 1.5;
    if (this.speed_boost === 2) sm *= 0.6;
    if (this.is_zombie && !isgodmod) sm *= 0.6;
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
        // Player.as:946-965: jump held while levitating = thrust (applyThrust); else the held-jump repeat timer
        if (this.has_levitation) {
          this.is_thrusting = true;
          this._current_thrust = MAX_THRUST;
        } else if (this._last_jump < 0.0) {
          if (now + this._last_jump > 750.0) injump = true;
        } else {
          if (now - this._last_jump > 150.0) injump = true;
        }
      } else {
        this.is_thrusting = false;
      }
      if ((((this.speed_x === 0.0 && morx !== 0 && mox !== 0.0) || (this.speed_y === 0.0 && mory !== 0 && moy !== 0.0)) && grounded) || this._current === EFFECT_MULTIJUMP) {
        this.jump_count = 0;
      }
      if (this.jump_count === 0 && !grounded) this.jump_count = 1;
      if (injump && !this.has_levitation) {
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
      if (!this._touchBlock(cx, cy, isgodmod)) {
        // eeo-tas threw in touchBlock (an out-of-range music block): the rest of Player.tick (sendMovement,
        // updateThrust, the auto-align, updateStuff = the run timer, the respawn check: the player is alive here) and
        // of PlayState.tick is skipped, and so is that frame's PlayState.enterFrame (tick() skips the queue drain).
        // Bl.time is not advanced, so the next frame runs the next tick as usual. (on_ground is this port's
        // observable of the movement that did happen.)
        this._setOnGround();
        return true;
      }
    }

    // --- levitation thrust (Player.as:998-1000, updateThrust 1846-1861), also while dead, after touchBlock (a 418
    // touched this tick already counts). `this.speedY -= _currentThrust * (26/2) * (this.mory * 0.5)` goes through
    // the public getter and setter (x 7.752, / 7.752), on every axis with a non-zero int mor, even at thrust 0.
    if (this.has_levitation) {
      const thr = this._current_thrust;
      if (this.mory !== 0) this.speed_y = (this.speed_y * MULT - (thr * THRUST_SCALE) * (this.mory * 0.5)) / MULT;
      if (this.morx !== 0) this.speed_x = (this.speed_x * MULT - (thr * THRUST_SCALE) * (this.morx * 0.5)) / MULT;
      if (!this.is_thrusting) {
        if (this._current_thrust > 0.0) this._current_thrust -= THRUST_BURN_OFF;
        else this._current_thrust = 0.0;
      }
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

    // (= _setOnGround(), inline: the call costs ~5% of the engine's speed here)
    const wasGround = this.on_ground;
    this.on_ground = this._grounded;
    if (this._grounded && !wasGround && this.onEvent !== null) this.onEvent('land', { impact_speed: this._land_speed });

    // --- end of Player.tick (Player.as:1176-1179): the death animation is over -> respawn, then deaths++.
    // deadoffset += 0.3 per dead tick first exceeds 16 after 54 additions (16.200000000000017): killed during tick
    // D, respawned at the end of tick D + 54 (alive in D + 55). This runs before PlayState.enterFrame's queues, so
    // their retries in this tick already see the spawn position and the new death count.
    if (this._dead_offset > 16.0) {
      this.respawn();
      this.deaths++;
    }
    return false;
  }

  /** on_ground (+ the 'land' event): whether the movement of this tick hit the floor (inlined at the end of _playerTick). */
  _setOnGround() {
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
    // getPortals(target): every portalLookup entry with that id (entries deleted by a coin pickup excluded)
    let targets = L.portalsById.get(L.pTarget[slot]);
    if (targets === undefined) return;
    if (targets.pc !== null && this._portalGone !== L.portalGone0) targets = this._liveExits(targets);
    if (targets.n <= 0) return;
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

  /** The exits of `t` whose portal entry still exists (see _setTileCoin), in the same order. */
  _liveExits(t) {
    const g = this._portalGone, xs = [], ys = [];
    for (let k = 0; k < t.n; k++) {
      const b = t.pc[k];
      if (b >= 0 && ((g[b >> 5] >>> (b & 31)) & 1) !== 0) continue;
      xs.push(t.xs[k]); ys.push(t.ys[k]);
    }
    return { xs, ys, n: xs.length, pc: null };
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
      case DOOR_GOLD: return this.goldBorder;    // pl.wearsGoldSmiley (the cookie's gold border setting, PlayState.as:128)
      case GATE_GOLD: return !this.goldBorder;
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
      case TEAM_DOOR: return this.team === this._lookup[i];   // World.as:731-732
      case TEAM_GATE: return this.team !== this._lookup[i];
      // World.as:734-735 (ItemId.as:96-97): 206 is the zombie GATE (open unless zombie), 207 the zombie DOOR (open
      // only while zombie). overlaps() returns 0 while flying before it gets here, so the getter's flying test is moot.
      case ZOMBIE_GATE: return !this.is_zombie;
      case ZOMBIE_DOOR: return this.is_zombie;
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

  /**
   * Me.touchBlock. Returns false when eeo-tas throws in it (an out-of-range music block, see below): the caller
   * then ends the tick there, like the uncaught RangeError does.
   */
  _touchBlock(cx, cy, isgodmode) {
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
      if (current === PIANO || current === DRUMS || current === GUITAR) {
        // Me.as:133-149 (`if (isme)`, whatever god mode): SoundManager.playPianoSound(n) reads pianoSounds[n + 27],
        // playDrumSound drumSounds[n], playGuitarSound guitarSounds[n] (sounds/SoundManager.as:402-414): Vectors of
        // 88, 20 and 49 sounds. A number outside them throws RangeError #1125 while the argument is evaluated, and
        // nothing catches it (Player.tick, BlContainer.tick, PlayState.tick, BlGame.handleEnterFrame have no try):
        // the rest of this tick is skipped (see _playerTick), pastx / pasty included, so every tick that starts in
        // this cell throws again.
        const note = this._lookupAt(cx, cy);
        const kind = current === PIANO ? 'piano' : (current === DRUMS ? 'drum' : 'guitar');
        if (!musicNoteValid(current, note)) {
          if (this.onEvent !== null) this.onEvent('tick_aborted', { reason: kind, tile: { x: cx, y: cy }, note });
          return false;
        }
        if (this.onEvent !== null) this.onEvent(kind, { tile: { x: cx, y: cy }, note });
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
            // Me.as:300-315: `newInv = getBoolean; if (isInvulnerable == newInv) break;` turning it on also turns off
            // curse, zombie, poison and fire (flags only: setEffect(x, false) keeps start and duration)
            const inv = this._lookupAt(cx, cy) !== 0;
            if (this.is_invulnerable !== inv) {
              this.is_invulnerable = inv;
              if (inv) {
                this.is_cursed = false; this.is_zombie = false; this.is_poisoned = false; this.is_on_fire = false;
              }
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'protection', on: inv, tile: { x: cx, y: cy } });
            }
            break;
          }
          case EFFECT_RESET:
            // resetEffects(false) (Me.as:316-318, Player.as:1800-1821): the static effects only (jump, fly with its
            // thrust, run, protection, low gravity, multijump, gravity); curse, zombie, poison, fire and team stay
            this.jump_boost = 0; this.speed_boost = 0; this.is_invulnerable = false; this.low_gravity = false;
            this.max_jumps = 1; this.flip_gravity = 0;
            this.has_levitation = false; this._current_thrust = 0.0;
            break;
          case EFFECT_FLY: {
            // Me.as:259-264: `newLevitation = getBoolean; if (hasLevitation == newLevitation) break;` (the setter
            // zeroes the thrust when turning it off, Player.as:1838-1844; isThrusting is left alone)
            const lev = this._lookupAt(cx, cy) !== 0;
            if (this.has_levitation !== lev) {
              this.has_levitation = lev;
              if (!lev) this._current_thrust = 0.0;
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'levitation', on: lev, tile: { x: cx, y: cy } });
            }
            break;
          }
          case EFFECT_CURSE: {
            // Me.as:277-282: `newCurse = getInt > 0; if (cursed == newCurse || isInvulnerable) break; cursed = newCurse;
            // setEffect(effectCurse, cursed, 0, getInt)`: on -> start = PlayState.ticks, duration (v + 0.4) * 100.
            // Re-touching while cursed does not refresh the timer; a number <= 0 lifts the curse.
            const v = this._lookupAt(cx, cy);
            const on = v > 0;
            if (this.is_cursed !== on && !this.is_invulnerable) {
              this.is_cursed = on;
              if (on) { this._curse_time_start = this._ticks; this._curse_duration = effectDuration(v); }
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'curse', on, tile: { x: cx, y: cy }, duration: on ? this._curse_duration : 0 });
            }
            break;
          }
          case EFFECT_ZOMBIE: {
            // Me.as:283-288, the same pattern for zombie (speed x0.6, jump x0.75, zombie doors 206/207)
            const v = this._lookupAt(cx, cy);
            const on = v > 0;
            if (this.is_zombie !== on && !this.is_invulnerable) {
              this.is_zombie = on;
              if (on) { this._zombie_time_start = this._ticks; this._zombie_duration = effectDuration(v); }
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'zombie', on, tile: { x: cx, y: cy }, duration: on ? this._zombie_duration : 0 });
            }
            break;
          }
          case EFFECT_POISON: {
            // Me.as:289-294, the same pattern for poison
            const v = this._lookupAt(cx, cy);
            const on = v > 0;
            if (this.is_poisoned !== on && !this.is_invulnerable) {
              this.is_poisoned = on;
              if (on) { this._poison_time_start = this._ticks; this._poison_duration = effectDuration(v); }
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'poison', on, tile: { x: cx, y: cy }, duration: on ? this._poison_duration : 0 });
            }
            break;
          }
          case NPC_ZOMBIE:
            // Me.as:295-299: `if (zombie || isInvulnerable) break; zombie = true; setEffect(effectZombie, true)`:
            // duration 0 -> start 0, duration 0: a zombie with no death timer
            if (!this.is_zombie && !this.is_invulnerable) {
              this.is_zombie = true;
              this._zombie_time_start = 0; this._zombie_duration = 0.0;
              if (this.onEvent !== null) this.onEvent('effect', { effect: 'zombie', on: true, tile: { x: cx, y: cy }, duration: 0 });
            }
            break;
          case EFFECT_TEAM:
            // Me.as:320-323 (isme): UpdateTeamDoors(cx, cy), with the overlap revert and the per-tick retry
            this._updateTeamDoors(cx, cy);
            break;
          case LAVA:
            if (!this.is_on_fire && !this.is_invulnerable) {
              // setEffect(effectFire, true, 0, 2) (Player.as:1724-1730): start = PlayState.ticks,
              // duration = ((2 + 2 * Global.ping) * 100) in doubles = 240 -> killed 241 ticks later
              this.is_on_fire = true;
              this._fire_time_start = this._ticks;
              this._fire_duration = effectDuration(2);
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
    return true;
  }

  /**
   * setTileComplex(0, cx, cy, 110/111, null) for a coin pickup (Me.as:87, the only runtime tile write): tile -> 110 /
   * 111 and Lookup.deleteLookup(cx, cy) (World.as:415-418): the int and a portal entry at the cell are gone.
   */
  _setTileCoin(cx, cy, id) {
    const i = cy * this.width + cx;
    this.tiles[i] = id;
    this._lookup[i] = 0;
    const pci = this.level.portalCoinIdx;
    if (pci !== null && pci[i] >= 0) {
      const b = pci[i], g = this._portalGone.slice();
      g[b >> 5] |= 1 << (b & 31);
      this._portalGone = g;
    }
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

  /** World.setKey() (World.as:117-123): `if (fromqueue && ((ticks - keysTimer) / 100) >= 5) return;` */
  _setKey(c, state, fromqueue) {
    if (fromqueue && (this._ticks - this._kt[c]) >= KEY_TICKS) return;
    if (state) this._keysMask |= (1 << c);
    else this._keysMask &= ~(1 << c);
    if (state && !fromqueue) this._kt[c] = this._ticks;
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

  /**
   * Player.placeAtSpawn() (Player.as:1212-1238) with worldSpawn 0: the checkpoint if asked for and set, else
   * spawnPoints[0][nextSpawnPos] (level-file order, 255 and 1582 #0) and nextSpawnPos++ (wrapping), else (16, 16).
   */
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

  /** Player.jumpMultiplier (Player.as:354-361), in this order; zombie reads false while flying. */
  _jumpMultiplier() {
    let jm = 1.0;
    if (this.jump_boost === 1) jm *= 1.3;
    if (this.jump_boost === 2) jm *= 0.75;
    if (this.is_zombie && !this.in_god_mode) jm *= 0.75;
    if (this._slippery > 0.0) jm *= 0.88;
    return jm;
  }

  /**
   * Player.UpdateTeamDoors(x, y) + UpdateTeamDoorsById(id, false) (Player.as:1583-1604): tx, ty = the cell; if the
   * team differs from the cell's number, switch to it, and if the box then overlaps something (a team door or gate
   * closing on it) switch back and keep tx, ty pending (retried every tick, Player.as:421), else clear tx, ty.
   * If the team already equals the number, tx, ty stay set (a no-op retry every tick, no overlaps call).
   */
  _updateTeamDoors(x, y) {
    const id = this._lookupAt(x, y);
    this._team_tx = x; this._team_ty = y;
    if (this.team === id) return;
    const oid = this.team;
    this.team = id;
    if (this._overlaps() !== 0) {
      this.team = oid;
    } else {
      this._team_tx = -1; this._team_ty = -1;
      if (this.onEvent !== null) this.onEvent('team', { team: id, from: oid, tile: { x, y } });
    }
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
        const k = w * 32 + bit, i = L.coinTiles[k];
        // (the lookup of a coin cell is never read: only its tile id matters)
        if (((bits[w] >>> bit) & 1) !== 0) { this.tiles[i] = L.coinBaseId[k] + 10; this._lookup[i] = 0; }
        else { this.tiles[i] = L.coinBaseId[k]; this._lookup[i] = L.lookup0[i]; }
      }
    }
    this._coinBits = bits;
  }

  // ================================================================ state key

  /**
   * A string that is equal for two states iff they behave identically from here on (for eeo-tas inputs,
   * i.e. applyMask), ignoring absolute clocks (_ticks, run_ticks, frame_queue_ticks, prev_px/py, teleported, and
   * the per-tick input/derived fields that the next tick overwrites before reading). Running timers are keyed
   * by the exact number of ticks until they fire. Binary string (UTF-16 code units): use it as a Map/Set key.
   *
   * Exact across ticks: eeo-tas timers are integer tick counts (a key lasts exactly 500 ticks from any start, a timed
   * effect kills at start + floor(duration) + 1), so they are keyed relative to _ticks. The only absolute-clock
   * dependence is keyed as such: the time-door phase
   * PlayState.ticks % 1000 on levels with 156/157, and PlayState.ticks % ticksPerFrame when ticksPerFrame > 1.
   * `strict` is accepted for compatibility and no longer needed (it changes nothing).
   */
  stateKey(strict) {   // eslint-disable-line no-unused-vars
    const nd = this._fillKey();
    const key = this._keyBytes.ucs2Slice(0, this._keyDoubleOff + nd * 8);
    const v = this._varKey();
    return v === '' ? key : key + v;
  }

  /**
   * The variable part of the key (rare): purple / orange switch on-sets, the three queues, the frame phase. Each
   * present section is its tag (1..6), its int count and the ints (2 UTF-16 units each), so the string decodes
   * uniquely whatever the ints are (switch numbers are any int32 in a crafted file). The fixed part before it is
   * self-delimiting too (its length follows from the flag bits in its first int). A switch map with no switch on
   * adds nothing, like no map at all (doors and switches only test `=== true`).
   */
  _varKey() {
    let v = '';
    if (this._switches.size !== 0) { const s = switchKey(this._switches); if (s !== '') v += '\u0001' + s; }
    if (this._oswitches.size !== 0) { const s = switchKey(this._oswitches); if (s !== '') v += '\u0002' + s; }
    if (this._stateQueue.length !== 0) v += '\u0003' + seqKey(this._stateQueue);
    if (this._keysQueue.length !== 0) v += '\u0004' + seqKey(this._keysQueue);
    if (this._tileQueue.length !== 0) v += '\u0005' + seqKey(this._tileQueue);
    if (this.ticksPerFrame > 1) v += '\u0006' + seqKey([this._ticks % this.ticksPerFrame]);
    return v;
  }

  /**
   * A 53-bit hash of exactly what stateKey() contains, computed without building the string (about 3x
   * faster). Equal states -> equal hashes; different states collide with probability ~2^-53 per pair.
   * (`strict` is ignored, see stateKey.)
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
    const extra = this._varKey();
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
    // timed effects (flag + ticks until the kill check fires, see _effectTimerKey): curse, zombie, fire, poison.
    // The zombie flag also matters while dead (zombie doors in the overlaps() calls of the dead ticks).
    if (this.is_cursed) { fl |= 65536; F[nd++] = this._effectTimerKey(this._curse_time_start, this._curse_duration); }
    if (this.is_zombie) { fl |= 131072; F[nd++] = this._effectTimerKey(this._zombie_time_start, this._zombie_duration); }
    if (this.is_on_fire) { fl |= 512; F[nd++] = this._effectTimerKey(this._fire_time_start, this._fire_duration); }
    if (this.is_poisoned) { fl |= 262144; F[nd++] = this._effectTimerKey(this._poison_time_start, this._poison_duration); }
    // levitation: the thrust (0 whenever levitation is off: the setter zeroes it, nothing else raises it) and
    // isThrusting, which is read (by updateThrust's burn-off) only while the thrust is non-zero
    if (this.has_levitation) {
      fl |= 524288;
      F[nd++] = this._current_thrust + 0;
      if (this.is_thrusting && this._current_thrust !== 0.0) fl |= 1048576;
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
    // key timers (colors that have key tiles), for active keys and keys with a queued retry (keysTimer matters
    // for nothing else: every other path that turns a key on stamps it): r = keysTimer + 500 - ticks, the number
    // of ticks until World.update expires it / a queued retry is dropped (the first later tick T with
    // T - keysTimer >= 500 is ticks + max(r, 1)), so every r <= 1 behaves alike. -1 = not relevant.
    const kc = this._keyColors;
    if (kc.length !== 0) {
      let rel = this._keysMask;
      for (let q = 0; q < this._keysQueue.length; q += 2) rel |= 1 << this._keysQueue[q];
      for (let j = 0; j < kc.length; j++) {
        const c = kc[j];
        if ((rel & (1 << c)) !== 0) {
          const r = this._kt[c] + KEY_TICKS - this._ticks;
          I[o++] = r > 1 ? r : 1;
        } else I[o++] = -1;
      }
    }
    // time doors: an absolute phase of PlayState.ticks (the state at every later tick is (T % 1000) >= 500)
    if (L.hasTimeDoors) I[o++] = this._ticks % TIMEDOOR_PERIOD;
    if (L.hasDeathDoor) I[o++] = this.deaths;
    if (L.hasCoinGate) I[o++] = this._show_coin_gate;
    if (L.hasBlueCoinGate) I[o++] = this._show_blue_coin_gate;
    if (L.hasDeathGate) I[o++] = this._show_death_gate;
    if (L.multiTargetPortals) I[o++] = this._rngSteps;   // == RNG state (seeded at reset)
    if (L.hasTeamEffect) {
      // team, and the pending retry (tx, ty): it matters only through the cell's number, and only while that differs
      // from the team (an equal one returns before any overlaps() call, and anything that changes the team moves
      // or clears tx, ty first; resetPlayer is outside a replay)
      I[o++] = this.team;
      if (this._team_tx !== -1) {
        const pid = this._lookupAt(this._team_tx, this._team_ty);
        if (pid !== this.team) { I[0] |= 2097152; I[o++] = pid; } else I[o++] = 0;
      } else I[o++] = 0;
    }
    this._coinOff = o;
    if (L.coinTiles.length !== 0) { const cb = this._coinBits; for (let w = 0; w < cb.length; w++) I[o++] = cb[w]; }
    if (L.secretTiles.length !== 0) { const sb = this._secretBits; for (let w = 0; w < sb.length; w++) I[o++] = sb[w]; }
    // portal entries deleted by coin pickups (only levels with portal entries on coin cells; see _setTileCoin)
    if (L.nPortalCoins > 0) { const pg = this._portalGone; for (let w = 0; w < pg.length; w++) I[o++] = pg[w]; }
    return nd;
  }

  /**
   * Ticks until a timed effect's kill check fires (Player.as:399-404: the first tick T > now with
   * T - start > duration is start + floor(duration) + 1, T and start being integers), clamped to >= 1: equal values
   * die at the same tick whatever start and duration were. 0 = no timer (duration 0: NPC zombie). -2 while dead:
   * the checks do not run and the respawn clears the effect.
   */
  _effectTimerKey(start, dur) {
    if (this.is_dead) return -2;
    if (!(dur !== 0.0 && dur === dur)) return 0;   // `xDuration &&` is false for 0 and NaN
    const r = start + Math.floor(dur) + 1 - this._ticks;
    return r > 1 ? r : 1;
  }

  /** Per-level key layout: [int32 slots the level can vary][pad][5 + up to 9 conditional doubles]. */
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
    if (L.hasTeamEffect) nI += 2;
    if (L.coinTiles.length !== 0) nI += L.coinWords;
    if (L.secretTiles.length !== 0) nI += L.secretWords;
    if (L.nPortalCoins > 0) nI += L.portalGone0.length;
    if (nI & 1) nI++;   // keep the doubles 8-byte aligned
    // doubles: 5 always, then at most dead_offset, 4 effect timers, thrust, ox + oy, the held-jump timer = 14
    const ab = new ArrayBuffer(nI * 4 + KEY_DOUBLES * 8);
    this._keyBuf = ab;
    this._keyI = new Int32Array(ab, 0, nI);
    this._keyDoubleOff = nI * 4;
    this._keyF = new Float64Array(ab, nI * 4, KEY_DOUBLES);
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

/** Whether eeo-tas's sound tables have the music block's number (SoundManager.as: 88 piano, 20 drum, 49 guitar sounds). */
function musicNoteValid(id, n) {
  if (id === PIANO) return n >= -27 && n <= 60;   // pianoSounds[n + 27]
  if (id === DRUMS) return n >= 0 && n <= 19;
  return n >= 0 && n <= 48;                        // GUITAR
}

function rectHit(x, y, rx, ry, rw, rh) {
  return x < rx + rw && rx < x + 16.0 && y < ry + rh && ry < y + 16.0;
}

function copyInto(dst, src) {
  if (dst.length !== 0) dst.length = 0;   // (setting .length is a slow runtime call in V8: skip when empty)
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/** ints -> their count, then each int, as 2 UTF-16 units apiece (low 16 bits, high 16 bits): self-delimiting. */
function seqKey(arr) {
  const n = arr.length;
  let s = String.fromCharCode(n & 0xFFFF, (n >>> 16) & 0xFFFF);
  for (let i = 0; i < n; i++) { const v = arr[i] | 0; s += String.fromCharCode(v & 0xFFFF, (v >>> 16) & 0xFFFF); }
  return s;
}

/** A switch map's on-set as seqKey of the sorted ids, '' when no switch is on (cached on the map until _swSet). */
function switchKey(m) {
  if (m._key !== undefined) return m._key;
  const on = [];
  for (const [id, v] of m) if (v === true) on.push(id);
  on.sort((a, b) => a - b);
  const k = on.length === 0 ? '' : seqKey(on);
  m._key = k;
  return k;
}

// ------------------------------------------------------------------ snapshot object
// Every scalar field of the sim that snapshot()/restore() copy (the Godot _SNAP_PROPS minus the arrays,
// plus the RNG state). Straight-line copy code is generated from this list. The key timers (_kt, ints) are
// copied as kt0..kt5. frame_queue_ticks is a diagnostic counter and rngNeed the enumerator's "a draw went past the
// outcome script" signal (rng.js); neither affects behaviour, neither is keyed.
const SNAP_SCALARS = ['px', 'py', 'prev_px', 'prev_py', 'speed_x', 'speed_y', 'on_ground', 'is_dead',
  'in_god_mode', 'coins', 'blue_coins', 'has_crown', 'has_silver_crown', 'deaths', 'teleported', 'modifier_x',
  'modifier_y', 'current_tile', 'flip_gravity', 'jump_count', 'max_jumps', 'jump_boost', 'speed_boost',
  'low_gravity', 'is_invulnerable', 'is_on_fire', 'run_ticks', 'morx', 'mory', 'mox', 'moy', '_next_spawn',
  '_keysMask', '_timedoor_state', '_show_coin_gate', '_show_blue_coin_gate',
  '_show_death_gate', '_collide_crown', '_collide_silver_crown', '_ticks', '_q0', '_q1', '_last_jump',
  '_slippery', '_pastx', '_pasty', '_ox', '_oy', 'overlapa', 'overlapb', 'overlapc', 'overlapd',
  '_last_portal_set', '_last_portal_x', '_last_portal_y', '_dead_offset', '_fire_time_start', '_fire_duration',
  '_horizontal', '_vertical', '_spacedown', '_spacejustdown', '_prev_jump_held', '_mx', '_my', '_current',
  '_evKeysMask', '_ev_coins', '_ev_bcoins', '_ev_timedoor', '_ev_grav_x', '_ev_grav_y', '_rngState', '_rngSteps',
  'rngNeed', 'frame_queue_ticks', '_tick0',
  'is_cursed', '_curse_time_start', '_curse_duration', 'is_zombie', '_zombie_time_start', '_zombie_duration',
  'is_poisoned', '_poison_time_start', '_poison_duration', 'has_levitation', 'is_thrusting', '_current_thrust',
  'team', '_team_tx', '_team_ty', '_portalGone'];

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
  loadLevel, prepareLevel, EESim, EEInput, EESnapshot, applyMask, parseEetas, parseEetasBytes, eetasOddBytes,
  COLORS, DRAG_HEX, SNAP_SCALARS, RNG_SEED_STATE, pcgSeedState, pcgStep, pcgOut,
  KEY_TICKS, TIMEDOOR_PERIOD, START_MODES,
  constants: { BASE_DRAG, ICE_NO_MOD_DRAG, ICE_DRAG, NO_MOD_DRAG, WATER_DRAG, MUD_DRAG, LAVA_DRAG, TOXIC_DRAG, MULT },
};
