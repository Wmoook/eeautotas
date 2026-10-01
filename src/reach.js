'use strict';
// The reach field (v3) of Find a route: a physics-aware cost to the trophy (in fifths of a tile) per abstract state of
// the ball, built backwards from the trophy, and the lookup that maps a real state (position, vertical speed, gravity
// queue, slipperiness) to its abstract state. -1 ("cut off") is a proof that the ball cannot reach the trophy from
// there: every rule errs toward "reachable" (the explore prunes such states, the editor calls a cut-off start
// impossible). Exactness is not the field's business: it only prunes and orders; every route is replayed by the engine.
//
// Abstract state = (tile of the ball's centre, type, level); costs are integers in fifths of a tile (5 per straight
// step, 7 per diagonal step, 5 per portal or death respawn):
//   R  (normal tiles) rising: q = ceil((e + TOL) / 8) clamped to [-1, Q], INF = Q + 1; e = px from the tile's top edge
//      up to the highest y the centre can still reach (q >= 1: can enter the row above; q >= 0: can be in the upper
//      half, stand, clear a block below; q = -1: lower half only)
//      (R(INF), "anywhere up": only an up boost or a portal exit whose rise cap is not proven in Q levels, and the
//      lookup's level on an up boost, which the forward model caps: see "the rise caps")
//   F  (every tile) falling or at rest: k in 0..16: the ball's fall potential x = D(v) + (px to the tile's bottom edge)
//      is at most 16 (k + 1), D(v) = the free fall from rest (air, base drag) that ends at speed v. x is exactly
//      conserved by a free fall, so k never grows inside a tile, and grows by 1 per row fallen.
//   C  (field tiles: dots / side arrows / side boosts, climbables, water, mud / lava, up arrows) rising: c in 0..127:
//      the upward speed at the row's top edge, the push left in this row included, is at most c / 8 (127 = 16)
//   XR (normal tiles in a row whose run of normal tiles touches a field) a ball that left a field sideways in this row,
//      by its speed: back into a field in this row it is no faster (no pumping by stepping in and out)
// The physics is in one place, fwd() (a move to a neighbour tile) and the same-tile edges; the backward search inverts
// fwd() per pair of tile profiles (the least source level that reaches each target level) and runs a label-setting
// search in cost buckets. Tables are measured with the engine's own arithmetic at module load (every rise and fall is
// the engine's per-tick speed update: (v + modifier) x drag, capped at 16).
//
// reachField(level, opts) -> the field (plain data: typed arrays and numbers, so it can go to worker threads);
//   opts.check: the Bellman self-check (every stored cost equals the best forward edge), in field.mismatches;
//   opts.explain: when the start is cut off, the highest row the model lets its centre reach (field.explain {row,
//   trophyRow, startRow}; null when the start is not cut off: the forward search would walk the whole model);
//   opts.goals [{tile, cost (tiles)}] and opts.maxCost (tiles): explore.js --hunt's time-to-go field (seeded from these
//   tiles at their own costs, not the trophy; states above maxCost stay -1, which is then no proof); opts.oneWayEntry: one-way
//   platforms block the centre's entry against their pass direction: NOT sound, for src/steer.js's ordering field only).
// fifthsAt(field, px, py, vy, q0, q1, slippery) -> fifths (-1 = cut off); costAt(field, sim) -> tiles (-1 = cut off)
//   (also costAt(field, px, py, vy, onGround): the gravity queue unknown, taken as the strongest); scoreAt(field, ...
//   the same) -> the beam's score in tiles, blended between the 4 tile centres around the ball (native/beam.h
//   reachScore; -1 = cut off);
// writeReachFile(field, file, levelFp): the RCH3 file for eegpu (native/beam.h ReachField, reachFifths / reachScore);
//   levelFp (src/gpu.js blobFp of the level's blob) names the level it was made for: eegpu prove uses the field only for
//   that level (a field is a proof about one level: another level's cut-offs could drop a route).
// Walk mode (levels with jump / fly / speed / low-gravity / multijump / gravity effects, or another world gravity):
// plain walking distance (through portals and death respawns), never a proof of anything.
// Deaths: with a checkpoint or 2+ spawn points a death can take the ball to another place (the respawn at the checkpoint
// touched last, else the next spawn of EE's rotation): an edge from every tile it can die in (a killing current tile;
// anywhere with a timed killer: curse, zombie, poison, lava) to every respawn tile, at DEATH_COST fifths (finite, so no
// proof is lost, but behind every real way: the searches drop dead balls).
const fs = require('fs');
const E = require('./eesim.js');

// ---------------------------------------------------------------- the engine's numbers
const MULT = E.constants.MULT, BD = E.constants.BASE_DRAG, ICE_ND = E.constants.ICE_NO_MOD_DRAG;
const G = (2.0 + 0.0) / MULT;                 // air: modifier_y (px/tick per tick, down)
const JV = ((0 - 2) * 26.0 * 1.0) / MULT;     // a jump's speed_y (-6.708)
const K_T = G * BD / (1 - BD);                // the terminal speed of a fall (13.553)
const TOL = 0.25;                             // px of margin on every apex (>= 0.0013, the dot-row step; < 0.58, 4-tile ledges)
const QMAX = 40, QMIN = 9;                    // R levels: Q = 40 with fields, boosts or portals, else 9
const QMAX_ENV = Math.min(100, Math.max(0, +process.env.EEAT_QMAX | 0));   // (OPT-IN EEAT_QMAX=<n>: reachField's Q)
const KF = 16, NL = 128;                      // F levels 0..16; C / XR levels 0..127
const R_ = 0, F_ = 1, X_ = 2, C_ = 3, L_ = 4, NT = 5;
const NONE = -32768, NONE8 = -128;
const CUT = 0xffff, FAR = 0xfffe;             // cost table: cut off; finite but saturated
// a death (the respawn at a checkpoint or another spawn): finite, so no proof is lost, but priced far beyond any real
// way (fifths: 1638 tiles), so the searches (which drop dead balls) never head for a spike because a checkpoint is near
const DEATH_COST = 8192;
// walk mode with protection: the protected walk where no unprotected way is (the tiles a protected ball can be in only):
// behind every real way too, like a death (see reachField)
const PROT_COST = DEATH_COST;
// tile classes
const WALL = 0, DEADLY = 1, NORM = 2, DOTS = 3, CLIMB = 4, WATER = 5, MUD = 6, UP = 7, BUP = 8, BDOWN = 9;
const isField = (c) => c >= DOTS && c <= UP;
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64;
const X_NONROT_HALF = 4;
const TROPHY = 121, CHECKPOINT = 360, PROTECTION = 420, ICE = 1064, CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
// effects that change jumps, speeds or gravity: walk mode (417 jump, 418 fly, 419 speed, 453 low gravity, 461
// multijump, 1517 gravity)
const WILD = new Set([417, 418, 419, 453, 461, 1517]);
// THE AIR JUMPS (n5 lane 3, OPT-IN: EEAT_AIRJUMP=1 or opts.airJumps true): a level whose only effect tiles are multijumps
// (461, any number) and whose gravity is the default no longer falls back to the walk: the physics model with an AIR JUMP
// at every normal tile (eesim.js 1385-1398: with jumps left a jump in the air sets speed_y to the jump's -6.7 whatever the
// ball was doing): from any R / F / L / XR state R(the jump's rise from the tile's top edge, +8 px of margin), and in the
// fields that pull (climbables, liquids, up arrows) the fastest C and the jump down F(KJD). The jumps left are not
// counted (an unlimited count), so the field stays a RELAXATION for every ball of such a level (1, 2, ... or 1000 jumps,
// or none): its costs lower bounds, its -1 a proof. The side-arrow prices (an added cost) are off with it. Unset / 0:
// the walk as before, byte for byte. (9 of the 230 levels: Springopolis, On And On And On, Just One More Time,
// Sandcastle Safari, First Person Maze, Frolic, Floating Temples, Golden Nightingale, Be gone.)
const AIRJ_ENV = () => process.env.EEAT_AIRJUMP === '1';
// the effect-state field (opts.fxState, COMPILER DOCTOR 10): the effect reset (1618) turns every static effect off
const FX_RESET = 1618;
const jbOf = (v) => (v === 1 || v === 2 ? v : 0);   // eesim.js _jumpMultiplier: 1 x1.3, 2 x0.75, any other number x1
/** the effect state {mj, jb} of a ball the effect-state field models, or null (fly, low gravity, a gravity rotation,
 *  infinite jumps; the speed boost changes no vertical physics and is not in it) */
function fxStateOf(a) {
	if (a.has_levitation || a.flip_gravity !== 0 || a.low_gravity || !(a.max_jumps < 1000)) return null;
	return { mj: a.max_jumps, jb: jbOf(a.jump_boost) };
}
/** does effect tile id with number v change a ball of effect state s (the engine's touch: eesim.js _touchBlock) */
function fxChanges(id, v, s) {
	switch (id) {
		case 461: return v !== s.mj;                    // multijump: max_jumps = its number
		case 417: return jbOf(v) !== s.jb;              // jump: jump_boost = its number
		case 419: return false;                         // speed: no vertical physics
		case FX_RESET: return s.mj !== 1 || s.jb !== 0; // the reset: max_jumps 1, no boost
		default: return v !== 0;                        // fly, low gravity, gravity: on unless 0
	}
}
/** the effect state after effect tile id with number v acts on a ball of state s (null: a state not modelled) */
function fxAfter(id, v, s) {
	if (!fxChanges(id, v, s)) return s;
	if (id === 461) return v < 1000 ? { mj: v, jb: s.jb } : null;
	if (id === 417) return { mj: s.mj, jb: jbOf(v) };
	if (id === FX_RESET) return { mj: 1, jb: 0 };
	return null;
}
/** the effect state the ball will have for its leg: the state after its idle ticks from here meet an effect tile (a ball
 *  standing on or falling onto its spawn's multijump tile: the state of the rest of the leg); fxStateOf otherwise */
function fxStateNext(a) {
	const s = fxStateOf(a);
	if (s === null || typeof a.snapshot !== 'function' || typeof a.tick !== 'function') return s;
	// (the engine itself: the ball's idle ticks from here, at most FX_IDLE, until its state changes, it dies or it rests: a
	// spawn over an effect tile (Need for Steed: the spawn (632, 14) over its multijump (632, 15), max_jumps 2 at tick 9) is a
	// leg of the state it falls into; the sim restored exactly, its event hook off meanwhile)
	const snap = a.snapshot(), hook = a.onEvent;
	let out = s;
	try {
		a.onEvent = null;
		for (let k = 0; k < FX_IDLE; k++) {
			a.tick(FX_IDLE_IN);
			if (a.is_dead) break;
			const s2 = fxStateOf(a);
			if (s2 === null || s2.mj !== s.mj || s2.jb !== s.jb) { out = s2; break; }
			if (k > 0 && a.speed_x === 0 && a.speed_y === 0) break;
		}
	} finally { a.restore(snap); a.onEvent = hook; }
	return out;
}
const FX_IDLE = 40, FX_IDLE_IN = new E.EEInput();
// (a state the physics part of an effect-state field has no way from: its walk + this, behind every way it has)
const FX_FAR = 4000;
const COINDOOR = 43, BLUECOINDOOR = 213, COIN_GOLD = 100;

/**
 * The block flags every guidance wall test reads (this file's fields, src/steer.js, src/goexplore.js, src/bursts.js,
 * src/timed.js, src/editor.js; native/beamhost.h's goal field keeps the same rule by id): eesim.js's table
 * (level.flags) with the ids the engine NEVER lets the ball through made plain walls (F_SOLID without F_DOOR).
 * eesim.js flags 50 (the secret "appear" block) F_DOOR, but World.overlaps() reveals it and then blocks, in every state
 * (eesim.js _ovSlow: `if (val === 50) this._revealSecret(cx, cy)`, then `return val`; docs/eeo_spec/blocks.md 3.2), so
 * the tests that take F_DOOR for a door (open in the fields, a door the walks read from the engine but never a wall at a
 * corner) walked through it: Snowblind's ball sat inside a box of 64 of them, Longing To The Sky's arrow maze is split
 * by 2,145, This is not snow's trophy fenced by six (the campaign doctor, src/out/n3/catalog.md section 5). The other
 * secrets are modelled already by the table: 243 (the secret "blank") is not solid (air, eesim.js OV_SECRET: revealed,
 * never blocking), 136 (the secret "disappear") and 44 are plain solids. Every other F_DOOR id opens in some state
 * (eesim.js _doorPassable). Sound: a wall only removes tiles the ball's box never overlaps (the reach field's -1 stays a
 * proof, only tighter). The engine's own table is not changed (the reveal is its state: the secrets' bits).
 */
const ALWAYS_SHUT = [50];
const GUIDE_FLAGS = new WeakMap();
function guideFlags(level) {
	const f = level.flags;
	let g = GUIDE_FLAGS.get(f);
	if (g === undefined) {
		g = Uint8Array.from(f);
		for (const id of ALWAYS_SHUT) if (id < g.length) g[id] &= ~F_DOOR;
		GUIDE_FLAGS.set(f, g);
	}
	return g;
}

/**
 * The coin doors that can never open: a door (43 gold, 213 blue) opens at `coins >= its number` (eesim.js), and the
 * count never passes the number of coin tiles of its colour (each tile gives one coin, once), so a door whose number is
 * above that is a wall for good (Forgotten Helix: six 16-coin doors, 15 gold coins). Sound: only states behind such a
 * door are ever cut. Returns a Uint8Array over the tiles (1 = such a door) or null when there is none.
 */
function neverOpenDoors(level) {
	const fg = level.fg, lk = level.lookup0, N = fg.length;
	if (!lk) return null;
	let gold = 0, blue = 0;
	const ct = level.coinTiles, cb = level.coinBaseId;
	if (ct && cb) for (let k = 0; k < ct.length; k++) { if (cb[k] === COIN_GOLD) gold++; else blue++; }
	else return null;
	let out = null;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if ((id === COINDOOR && lk[i] > gold) || (id === BLUECOINDOOR && lk[i] > blue)) { (out || (out = new Uint8Array(N)))[i] = 1; }
	}
	return out;
}
/** the class of block id as the ball's current tile (the field's tile classes; flags = guideFlags(level)) */
function classOfId(flags, gMox, gMoy, id) {
	if (id < 0 || id >= flags.length) return NORM;
	if ((flags[id] & F_CLIMB) !== 0) return CLIMB;
	if (id === 116) return BUP;
	if (id === 117) return BDOWN;
	if (id === 119) return WATER;
	if (id === 369 || id === 416) return MUD;
	if (gMox[id] !== 0 || id === 4 || id === 414 || id === 114 || id === 115) return DOTS;
	if (gMoy[id] < 0) return UP;
	return NORM;
}
const LOWER = 1, RIGHT = 2;                   // half blocks the centre can be in (on the edge): lower half, right half
// the field classes' upward pull (the largest -modifier of their ids, input held) and terminal speeds (px/tick)
const A_CLASS = [0, 0, 0, 1 / MULT, 1 / MULT, 1.5 / MULT, 0.8 / MULT, 2 / MULT, 0, 0];
const CAP_CLASS = [0, 0, 0, (1 / MULT) * BD / (1 - BD), 1.02, 2.72, 0.42, K_T, 0, 0];
const MOD_STRONG = -2 / MULT;                 // the most upward modifier of any tile (an unknown queue)

/** the engine's vertical speed update (Player.tick): (v + modifier) x drag, the cap, the snap to 0 */
function vstep(s, m, d) {
	let v = (s + m) * d;
	if (v > 16.0) v = 16.0;
	else if (v < -16.0) v = -16.0;
	else if (v < 0.0001 && v > -0.0001) v = 0.0;
	return v;
}
// ---- the rise under plain air after the queued ticks: sum of the moves u_n = (u + K) BD^n - K while > 0 (closed form)
const NTH = 72;
const TH = new Float64Array(NTH), SW = new Float64Array(NTH);   // u_n > 0 <=> u > TH[n]; SW[n] = BD + .. + BD^n
{ let p = 1, s = 0; for (let n = 0; n < NTH; n++) { TH[n] = K_T / p - K_T; SW[n] = s; p *= BD; s += p; } }
/** the upward distance a ball moving up at u (<= 16) still covers in plain air (the engine's moves, summed) */
function airRise(u) {
	if (!(u > 0)) return 0;
	let lo = 0, hi = NTH - 1;   // the largest n with u > TH[n]
	while (lo < hi) { const m = (lo + hi + 1) >> 1; if (u > TH[m]) lo = m; else hi = m - 1; }
	return (u + K_T) * SW[lo] - lo * K_T;
}
/** the highest the ball rises (px) from speed_y s: the queued ticks' modifiers m0, m1 (the gravity queue), then air;
 *  the first nIce ticks with the ice drag (slippery), the others base drag. An upper bound, and exactly conserved along
 *  the ball's own path (the next tick's bound is the rest of this one's). */
function riseQ(s, m0, m1, nIce) {
	let h = 0, best = 0;
	const n = nIce > 2 ? nIce : 2;
	for (let j = 1; j <= n; j++) {
		s = vstep(s, j === 1 ? m0 : j === 2 ? m1 : G, j <= nIce ? ICE_ND : BD);
		h -= s;
		if (h > best) best = h;
	}
	if (s < 0) { h += airRise(-s); if (h > best) best = h; }
	return best;
}
// ---- tables (the model's): box rise from an upward speed v on a 1/16 px/tick grid (0..16), linear interpolation (the
// curves are convex: the chord lies above, toward more reach)
const NV = 257, DV = 1 / 16;
function riseTable(m0, m1, nIce) { const a = new Float64Array(NV); for (let i = 0; i < NV; i++) a[i] = riseQ(-i * DV, m0, m1, nIce); return a; }
const TABLES = [0, 10].map((nIce) => ({ nIce, RA: riseTable(G, G, nIce), RC: riseTable(-1 / MULT, -1 / MULT, nIce), RD: riseTable(-2 / MULT, -2 / MULT, nIce) }));
const RA0 = TABLES[0].RA;   // RaInv: from the plain (no ice) table: a slower speed reaches as high with less drag
/** a table's value at v: linear between grid points where the table is convex there (the chord lies above), else the
 *  upper grid point's value (the tables increase: an upper bound either way; the ice tables bend down near the cap) */
const convexAt = (T) => { const c = new Uint8Array(NV); for (let i = 0; i + 1 < NV; i++) c[i] = (i === 0 || T[i + 1] - 2 * T[i] + T[i - 1] >= -1e-9) && (i + 2 >= NV || T[i + 2] - 2 * T[i + 1] + T[i] >= -1e-9) ? 1 : 0; return c; };
for (const tb of TABLES) for (const k of ['RA', 'RC', 'RD']) tb[k].convex = convexAt(tb[k]);
const interp = (T, v) => {
	if (!(v > 0)) return T[0];
	if (v >= 16) return T[NV - 1] + (v - 16);
	const x = v / DV, i = Math.floor(x);
	if (T.convex && !T.convex[i]) return x === i ? T[i] : T[i + 1];
	return T[i] + (T[i + 1] - T[i]) * (x - i);
};
/** the smallest grid speed whose plain rise reaches e px (beyond 16 px/tick: R(16) + (v - 16)) */
function RaInv(e) { if (!(e > 0)) return 0; if (e > RA0[NV - 1]) return 16 + (e - RA0[NV - 1]); let lo = 0, hi = NV - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (RA0[m] >= e) hi = m; else lo = m + 1; } return lo * DV; }
// ---- the free fall from rest (air, base drag): FV[n] the speed after n ticks, FS[n] the distance fallen; D(v) is the
// orbit's distance at speed v, linear between ticks (exact: one tick moves D by exactly its move)
const FV = [0], FS = [0];
{ let v = 0, s = 0; for (let n = 1; n < 4000 && v < K_T - 1e-9; n++) { v = vstep(v, G, BD); s += v; FV.push(v); FS.push(s); if (v >= K_T - 1e-9) break; } }
const NFV = FV.length;
const FVa = Float64Array.from(FV), FSa = Float64Array.from(FS);
function fallD(v) {
	if (!(v > 0)) return 0;
	if (v >= FVa[NFV - 1]) return Infinity;
	let lo = 0, hi = NFV - 2;   // FV[lo] <= v < FV[lo + 1]
	while (lo < hi) { const m = (lo + hi + 1) >> 1; if (FVa[m] <= v) lo = m; else hi = m - 1; }
	return FSa[lo] + (v - FVa[lo]) / (FVa[lo + 1] - FVa[lo]) * FVa[lo + 1];
}
/** the speed of the free fall at distance x (inverse of fallD) */
function fallV(x) {
	if (!(x > 0)) return 0;
	let lo = 0, hi = NFV - 2;
	while (lo < hi) { const m = (lo + hi + 1) >> 1; if (FSa[m] <= x) lo = m; else hi = m - 1; }
	if (x >= FSa[NFV - 1]) return FVa[NFV - 1];
	return FVa[lo] + (x - FSa[lo]) / FVa[lo + 1] * (FVa[lo + 1] - FVa[lo]);
}
/** the engine's VF[k]: the largest tick-start speed after falling <= 16 (k + 1) px from rest */
const VF = []; for (let k = 0; k <= KF; k++) { let m = 0; for (let n = 0; n < NFV; n++) if (FSa[n] <= 16 * (k + 1) && FVa[n] > m) m = FVa[n]; VF.push(m); }
/** the continuous version (F(k)'s speed bound): the free fall's speed at 16 (k + 1) px */
const VFC = []; for (let k = 0; k <= KF; k++) VFC.push(k >= KF ? 16 : fallV(16 * (k + 1)));
const kOfX = (x) => (x <= 16 ? 0 : x === Infinity || x > 16 * (KF + 1) ? KF : Math.min(KF, Math.ceil(x / 16) - 1));
// the landing-tick jump: the landing tick moves more than 8 px, so the tick-start speed is above 8 / BD - G (7.89)
const VJMIN = 7.85;
const KLJ = Math.ceil(fallD(VJMIN) / 16) - 1;
const cOfV = (v) => (v >= 16 ? NL - 1 : Math.min(NL - 1, Math.ceil(v * 8 - 1e-9)));
const vOfC = (c) => (c >= NL - 1 ? 16 : c / 8);
// THE BOUNCE'S TURN (OPT-IN EEAT_BOUNCE_TURN=1 / opts.bounceTurn; off = the bounce as before, byte for byte): the up-arrow
// bounce F(k) -> C at a tile t (same-tile edge, bounceC) returns sqrt(v^2 + the gain) >= v for the F level's whole speed v,
// so falling back into a short up-arrow column and bouncing again gained every cycle: a PUMP to 16 px/tick in a 2-tall
// column between two spikes (Cold World's (96, 226-227): F7 -> C61 -> F16 -> C127 -> a 20-row rise; the same pump at C127
// lifted the forward model into the trophy room). But a ball turns round IN t only if it stops within t: its centre is at
// most 16 px over t's bottom edge, and from a tick-start speed v the centre moves sum v_n (v_n = (v_{n-1} + m) d) before it
// turns: with the strongest deceleration the engine allows (eesim.js Player.tick: m = the most upward modifier MOD_STRONG,
// d = BASE_DRAG x NO_MOD_DRAG on the 2 ticks the gravity queue still holds a tile from before t, then t's own up arrow:
// m = -2 / MULT, d = BASE_DRAG (an arrow as the delayed tile: my = 0, no no-modifier drag; ice only drags less)), every
// speed above VTURN leaves t first (into the tile below: an F move there, enterDown, whose level only grows, and its own
// bounce; onto a floor: speed 0, the bounce of v = 0; into a killer: dead). So the bounce at t is the old formula's at
// min(v, VTURN) (the formula grows with v): SOUND (only a turn the engine cannot make is removed)
const BOUNCE_TURN = process.env.EEAT_BOUNCE_TURN === '1';
// THE SIDEWAYS-KEPT RISE, an ORDERING price (OPT-IN EEAT_SIDE_CAP=<q> / opts.sideCap, goal fields only; off = the field byte
// for byte): an R(q) state moved sideways between two normal tiles keeps its apex level q (fwd: dy 0 -> enterR(P2, e)), so
// a chain of sideways moves in one row carries a jump's rise any number of tiles; the engine cannot: a ball rising with
// its apex e px above a row's top edge stays in the row (16 px tall) only while it rises less than 16 px, and each tile of
// sideways travel takes at least 16 / 16.25 ticks, so after k same-row crossings its rise per tick u satisfies roughly
// (k - 3) u < 16 and its apex above the row is at most the rise from u (Cold World's chapter-2 blue coin: the goal field's
// false near, the bottom corridor (105-117, 227-231) at 40-49 tiles, is R7 carried 12 tiles along row 211 into the coin's
// shaft from below). A sound count needs a per-row crossing counter in the label search (~12 count types a direction);
// this knob is the ORDERING part only: a second field whose sideways NORM -> NORM moves keep at most R(q) (`_sideCapQ`),
// and the goal field's cost of a state is that field's where it is finite, the plain field's + SIDE_CAP_PEN (2,500 tiles)
// where only the plain model reaches the goal (a way through a long sideways rise ranks behind every other way), CUT where
// the plain field cuts it: the -1 set (the proof, the executor's heap cut) is the plain field's byte for byte.
const SIDE_CAP = Math.max(0, Math.min(40, +process.env.EEAT_SIDE_CAP | 0));
const SIDE_CAP_PEN = 12500;
const VTURN = (() => {
	const ND = E.constants.NO_MOD_DRAG;
	const dStop = (v) => {
		let s = 0;
		for (let n = 0; v > 0 && n < 4000; n++) { v = (v + MOD_STRONG) * (n < 2 ? BD * ND : BD); if (v < 0.0001) break; s += v; }
		return s;
	};
	let lo = 0, hi = 16;
	for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (dStop(m) < 16 + TOL) lo = m; else hi = m; }
	return hi;
})();

// ---------------------------------------------------------------- the field
function reachField(level, opts) {
	opts = opts || {};
	const t0 = Date.now();
	const sideCapQ = opts._sideCapQ | 0;   // (the sideways-kept rise's capped model: SIDE_CAP above; 0 = the plain model)
	const W = level.width, H = level.height, N = W * H;
	const fg = level.fg, flags = guideFlags(level), nFlags = flags.length, gF = level.gFlags, gMox = level.gMox, gMoy = level.gMoy, lk = level.lookup0, xfl = level.xflags;
	const fl = (id) => (id >= 0 && id < nFlags ? flags[id] : 0);
	let wild = !(level.gravityMult === 1), protect = false, ice = false, anyField = false, anyPortal = false, checkpoints = false, timed = false;
	const protOn = [];   // the protection effect's "on" tiles (its number is not 0: Me.as, eesim.js EFFECT_PROTECTION)
	// opts.plainFx (with opts.goals; COMPILER DOCTOR 6): the field of a PLAIN ball (no effect on: types.js featValue 'fx'
	// 0) in a level with effect tiles: the physics model up to the first effect tile that changes a plain ball (fxExit)
	// and that tile a goal at its walk cost (the walk is a lower bound for any effect state, so the field stays a lower
	// bound and its -1 a proof for the plain ball); an effect tile that leaves a plain ball plain (a fly / jump / speed /
	// low-gravity / gravity effect of number 0, a multijump of 1) is air. Without it: one effect tile anywhere made the
	// whole level's field the gravity-blind walk.
	// opts.fxState {mj, jb} (with opts.goals; COMPILER DOCTOR 10, types.js EEAT_FX_STATE): the same field for a ball that
	// CARRIES an effect the physics model can take (fxStateOf: max_jumps mj < 1000, jump_boost jb; the speed boost changes
	// no vertical physics and is ignored; fly, low gravity, a gravity rotation and infinite jumps are not modelled: none):
	// its jump rises the combined height of its mj jumps (the ground jump + mj - 1 air jumps at the apex: a ball that walks
	// off a ledge keeps mj - 1 air jumps, eesim.js jump_count, and the R states' free sideways moves let the ledge jump
	// stand for that way) with the jump effect's speed, none at mj 0; the effect tiles that change THIS state are its exits
	// (fxChanges: goals at their walk cost), the others air. ORDERING ONLY: a ball the engine takes off the ground some
	// other way (a portal exit, a boost) keeps air jumps the model does not give it, so the physics part is no lower bound:
	// costAt never reads its -1 (the walk's cost + FX_FAR there), and the walk's -1 stays the only cut, as on the walk field.
	let mjTiles = 0, wildOther = false;   // (the air jumps: multijump tiles, any other effect tile)
	const fxS = opts.fxState && opts.goals ? opts.fxState : null;
	const plainFx = (!!opts.plainFx && !!opts.goals) || fxS !== null;
	const fxExit = plainFx ? [] : null;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (WILD.has(id) || (fxS !== null && id === FX_RESET)) {
			if (WILD.has(id)) { if (id === 461) mjTiles++; else wildOther = true; }
			if (!plainFx) wild = true;
			else if (fxS !== null ? fxChanges(id, lk[i], fxS) : (id === 461 ? lk[i] !== 1 : lk[i] !== 0)) fxExit.push(i);
		}
		if (id === PROTECTION && lk[i] !== 0) { protect = true; protOn.push(i); }
		if (id === ICE) ice = true;
		if (id === CHECKPOINT) checkpoints = true;
		// a timed killer: curse / zombie / poison with a time (the tile's number > 0), lava (fire): the ball dies anywhere later
		if (((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0) || id === LAVA) timed = true;
	}
	// ---- classify. The collision uses a half block's stored rotation (1 the lower half, 0 the right half: the centre can
	// be in the tile only on its edge; 2 the left half, 3 the upper half: never; any other value is a full solid, taken as
	// open here, which errs toward reachable). The engine's current tile (gravity, kills) of a half block is the tile above
	// (rotation 1, and every present 1101-1105, which the current-tile rule always reads as rotation 1, whatever their
	// stored rotation) or to the left (0).
	const hgeo = (i) => ((fl(fg[i]) & F_HALF) === 0 ? -1 : lk[i]);
	const hcur = (i) => { const id = fg[i]; if ((fl(id) & F_HALF) === 0) return -1; return (xfl[id] & X_NONROT_HALF) ? 1 : lk[i]; };
	const curOf = new Int32Array(N);   // the engine's current tile when the centre is in tile i (-1: off the level)
	for (let i = 0; i < N; i++) { const hc = hcur(i); curOf[i] = hc === 1 ? (i >= W ? i - W : -1) : hc === 0 ? (i % W > 0 ? i - 1 : -1) : i; }
	const kills = (i) => i >= 0 && (gF[fg[i]] & 4) !== 0;
	const isWallId = (id) => (fl(id) & F_SOLID) !== 0 && (fl(id) & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0;
	const gclass = (id) => classOfId(flags, gMox, gMoy, id);
	const wallAt = (i) => { const hr = hgeo(i); return isWallId(fg[i]) || hr === 2 || hr === 3; };
	// ---- protection: a protected ball passes killing tiles (nothing kills it), but it is protected only on its way from a
	// protection tile: the tiles a protected ball can be in (protP) are the 8-way walk from the "on" tiles through every tile
	// but walls (a diagonal step closed between two walls), portals forward (it never dies: no respawn). Outside them a
	// killing tile is deadly as on a level without protection: sound (a protected ball is never there), and sharper than
	// "protection somewhere: no tile kills anywhere" (Forgotten Helix: its one protection tile is 2 tiles from the trophy,
	// its 39,724 spikes were air for the whole level, and a spectator box between two spike clouds, reached by a portal,
	// looked 106 tiles from the trophy)
	const shut = neverOpenDoors(level);   // coin doors above the level's coins: walls for good
	// the half-block quadrants (halfQuadOn): the moves the box cannot make next to half blocks (exact), or null
	const Qg = halfQuadOn(opts) ? quadOf(W, H, fg, flags, lk, shut) : null;
	let protP = null;
	if (protect) {
		protP = new Uint8Array(N);
		const q = [];
		const blkP = Qg ? moveBlocks(W, H, Qg, (i) => !wallAt(i)) : null;
		for (const i of protOn) if (!wallAt(i)) { protP[i] = 1; q.push(i); }
		const exitsOf = (i) => {
			const s = level.portalSlot ? level.portalSlot[i] : -1;
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || !level.portalsById || silentPortals(level)[i]) return null;
			return level.portalsById.get(level.pTarget[s]) || null;
		};
		while (q.length) {
			const t = q.pop(), x = t % W, y = (t / W) | 0;
			const ex = exitsOf(t);
			if (ex) for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && !protP[j] && !wallAt(j)) { protP[j] = 1; q.push(j); } }
			for (let di = 0; di < 8; di++) {
				const dx = QDX[di], dy = QDY[di];
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (protP[j] || wallAt(j)) continue;
				if (dx && dy && wallAt(y * W + xx) && wallAt(yy * W + x)) continue;
				if (blkP && blkP[t * 8 + di]) continue;
				protP[j] = 1; q.push(j);
			}
		}
	}
	const cls = new Uint8Array(N), sp = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const hr = hgeo(i);
		if (isWallId(id) || hr === 2 || hr === 3 || (shut !== null && shut[i])) { cls[i] = WALL; continue; }
		if (!(protP !== null && protP[i]) && id >= 0 && id < nFlags && (gF[id] & 4) !== 0) { cls[i] = DEADLY; continue; }
		if (hr === 1) sp[i] = LOWER; else if (hr === 0) sp[i] = RIGHT;
		const j = curOf[i];
		const c = j < 0 ? NORM : gclass(fg[j]);
		cls[i] = c;
		if (isField(c) || c === BUP || c === BDOWN) anyField = true;
	}
	const passable = (i) => cls[i] !== WALL && cls[i] !== DEADLY;
	// (the half-block quadrants' closed moves, for every move of the walk and the physics model: the centre can be in any
	// tile that is not a wall on the way, a deadly one too: it dies only by its tick-start tile)
	const blk = Qg ? moveBlocks(W, H, Qg, (i) => cls[i] !== WALL) : null;
	// ---- deaths: the ball comes back at the checkpoint it touched last, else at the next spawn point of EE's rotation
	// (255 and 1582 #0, level.spawnsX / spawnsY; none: tile (1, 1)); every checkpoint and spawn is a respawn tile. It dies
	// where its current tile kills (spikes, fire, toxic; also with protection somewhere, and a half block's tile under a
	// spike), or with a timed killer in the level (curse, zombie, poison, lava's fire) anywhere. A death is an edge (of
	// DEATH_COST, so the ordering keeps real ways first) to every respawn tile, modelled only when a death can take the
	// ball somewhere its start cannot (a checkpoint, or 2+ spawns): a death back to the start's spawn changes nothing the
	// start can reach, and the searches drop dead balls.
	const respawn = [];
	{
		const seen = new Uint8Array(N);
		const add = (i) => { if (i >= 0 && i < N && !seen[i] && passable(i)) { seen[i] = 1; respawn.push(i); } };
		const sx = level.spawnsX || [], sy = level.spawnsY || [];
		for (let k = 0; k < sx.length; k++) if (sx[k] >= 0 && sy[k] >= 0 && sx[k] < W && sy[k] < H) add(sy[k] * W + sx[k]);
		if (!sx.length && W > 1 && H > 1) add(W + 1);
		for (let i = 0; i < N; i++) if (fg[i] === CHECKPOINT) add(i);
	}
	// (opts.deaths === false: no death edges, as with no checkpoint and one spawn: the searches' prune field when they drop
	// dead balls, src/editor.js DEATH_FREE; a state only a death leads to the trophy from is then cut off. With the edges
	// (the default) a death is a finite way: the editor's verdicts, "impossible" and "only through a death")
	let deaths = opts.deaths !== false && (checkpoints || (level.spawnsX ? level.spawnsX.length : 0) >= 2) && respawn.length > 0;
	const dsrc = [];   // the tiles the ball can die in
	if (deaths) for (let i = 0; i < N; i++) if (cls[i] === DEADLY || (cls[i] !== WALL && (timed || kills(curOf[i]) || kills(i)))) dsrc.push(i);
	if (!dsrc.length) deaths = false;
	const dsrcT = new Uint8Array(N);
	if (deaths) for (const i of dsrc) dsrcT[i] = 1;
	// portals: exits (passable, or deadly with deaths) per portal tile
	const srcOf = new Map(), portalExits = new Map();
	if (level.portalSlot && level.portalsById) {
		const silent = silentPortals(level);
		for (let i = 0; i < N; i++) {
			const s = level.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || !passable(i)) continue;
			// (a portal EE never teleports from has no exits (silentPortals): a portal whose target is its own id (eesim.js
			// clears lastPortal there and moves on: Christmas Tree Quest's id-0 border ring was "6 tiles" from the trophy through
			// teleports EE never makes), a sealed portal cluster (the ball there keeps lastPortal: never teleports again)
			if (silent[i]) continue;
			const ex = level.portalsById.get(level.pTarget[s]);
			if (!ex) continue;
			const list = [];
			for (let k = 0; k < ex.n; k++) {
				const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4);
				if (j >= 0 && j < N && (passable(j) || (cls[j] === DEADLY && deaths)) && !list.includes(j)) list.push(j);
			}
			if (!list.length) continue;
			portalExits.set(i, list);
			anyPortal = true;
			for (const j of list) { if (!srcOf.has(j)) srcOf.set(j, []); srcOf.get(j).push(i); }
		}
	}
	// (opts.portalForced, src/steer.js only, like oneWayEntry: a ball whose tick starts in a portal tile is teleported
	// (eesim.js _portalTeleport), so a portal tile with exits is left only through them, never walked, jumped or flown
	// through: a row of portals is a wall that sends the ball elsewhere. Not sound, so never in the RCH3 proof field: a
	// ball a teleport put on a portal tile keeps lastPortal and moves on over portal tiles (the exits are left out here),
	// and a move of more than 16 px a tick can cross a one-tile portal row between two tick starts. Without it the ordering
	// fields send the searches through portal ceilings (Wine Quest I: the hub's portal rows, "190 tiles" from the trophy)
	const forcedP = new Uint8Array(N);
	if (opts.portalForced) {
		for (const i of portalExits.keys()) { const s = level.portalSlot[i]; if (!srcOf.has(i) && level.pTarget[s] !== level.pId[s]) forcedP[i] = 1; }
		unforceChains(W, H, forcedP, portalExits, srcOf);
	}
	// (opts.fxState: a multi-jump or a boosted jump rises past QMIN's 9 half rows)
	// (OPT-IN opts.qMax / EEAT_QMAX=<n> (41-100; off = QMAX 40, byte for byte): THE CAPS PAST 40. A portal exit's cap is
	// q 40 with a pull-up-1 queue, 41 next to an up arrow (9 + riseQ(-22.72, -2 / MULT x 2) = 325 px), and with the ice drag
	// 44-46 (a boost 46): past Q 40 every such cap is R(INF), a rise anywhere up FOREVER (the rise-q16 fix's 100+ tiles of
	// sky again): Cold World: 216 / 216 portal exits and 23 / 23 boosts R(INF) (8 ice blocks), the forward model's way into
	// the trophy room a 105-row rise from a boost. Q 47 holds every cap (the ice boost's 46): R(q) decays 2 levels a row)
	const QM = opts.qMax > 0 ? Math.min(100, opts.qMax | 0) : QMAX_ENV > QMAX ? QMAX_ENV : QMAX;
	const Q = anyField || anyPortal || (fxS !== null && (fxS.mj >= 2 || fxS.jb === 1)) ? QM : QMIN, INF = Q + 1, NR = Q + 3;
	// ---- the rise caps (the n3 rise-q16 fix): every speed is capped at 16 px/tick by the engine's speed update (Player.tick:
	// (v + modifier) x drag, then the clamp), so an up boost's and a portal exit's rise is finite: R(q), not R(INF) (which
	// sent the fields up 100+ tiles of open sky from any boost or portal exit: Imps Paradise, Barrel Cannon Canyon, ...).
	// Up boost t (a ball whose tick starts in it: speed_y = -16 after the update, then a move of <= 16 px): its rise from t's
	// top edge <= 16 + riseQ(-16, m1, m2) with the gravity queue of the next two ticks: m1 = the current tile of the tick
	// before (a neighbour of t, or t itself; after a teleport, a respawn or at the start: a portal / air: G), m2 = t's own.
	// Portal p (the teleport tick starts in p: the exit gets the rotated speed x 1.42 (<= 22.72, unclamped until the next
	// update), the ball is put at the exit's tile corner and moves <= 16 px this tick, + < 1 px from the rotated sub-pixel
	// remainders (_portalTeleport: _rem_y = -_rem_x ...)): the rise from the exit tile's top edge <= 9 + riseQ(-16 x 1.42,
	// m1, m2), m1 the tick before's current tile (a neighbour of p), m2 = p's own. Where that
	// q exceeds Q (ice: the ice drag's longer rise; a strong pull by it) the cap is not proven in Q levels: R(INF) stays.
	// Sound (both are the engine's own arithmetic with the most upward modifiers and the ice drag's ticks), so it is in
	// the proof field too. rcT: per up boost tile, its R level (INF: no cap); rpT: per portal tile, its exits' R level.
	const nIceR = ice ? 10 : 0;
	const mmR = modMinOf(level);
	const modCurR = (n) => { const j = curOf[n]; const id = j < 0 ? -1 : fg[j]; return id >= 0 && id < mmR.length ? mmR[id] : G; };
	const pull3 = (i) => {   // the most upward queued modifier of a ball whose previous tick started next to tile i
		const x = i % W, y = (i / W) | 0;
		let m = G;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H) m = Math.min(m, modCurR(ny * W + nx));
		}
		return m;
	};
	const capOf = (e) => { const q = Math.ceil((e + TOL) / 8); return q <= Q ? Math.max(-1, q) : INF; };
	const rcT = new Int8Array(N), rpT = new Int8Array(N).fill(INF);
	// (OPT-IN opts.iceCaps / EEAT_ICE_CAPS=1: THE CAPS' ICE ONLY NEAR ICE. Off = with one ice block anywhere every up boost's
	// and every portal exit's rise is the ice drag's (boost 16 + 342-366 px = q 43-46, portal 9 + 347-359 = q 44-45: all past
	// Q 40), so EVERY boost and portal exit of the level is R(INF), a rise anywhere up forever (Cold World: 8 ice blocks; a
	// boost 95 tiles from the nearest lifted the forward model 105 rows into the trophy room's approach). A rise is slippery
	// only if the ball is slippery where it starts (iceNear: within ICE_REACH_TILES of ice, portal hops chained) or turns
	// slippery on the way (eesim.js: current-below ice, the centre right over an ice block): a rise from a boost / an exit
	// lasts < RISE_TICKS ticks (the portal's 22.72 px/tick with the ice drag every tick: 72) of <= 16.25 px an axis, no hop
	// inside it (a hop is a new exit: its own cap), so the rise's ice drag only where ice is within RISE_TILES + the ice
	// reach of the boost / of one of the portal's exits (or of the portal itself); elsewhere the plain cap. SOUND (the same
	// arithmetic, the ice drag dropped only where no slippery tick can be))
	let iceCapNear = null;
	if (ice && nIceR > 0 && !opts.riseInf && (opts.iceCaps !== undefined ? !!opts.iceCaps : ICE_CAPS)) {
		// (slippery at the start: the ice reach with its portal hops; turning slippery on the way: ice within RISE_TILES + 1,
		// no hop (a hop ends the rise: the exit's own cap))
		iceCapNear = iceNearOf(level, W, H, N);
		const far = iceNearOf(level, W, H, N, RISE_TILES + 1, false);
		for (let i = 0; i < N; i++) iceCapNear[i] |= far[i];
	}
	const nIceAt = (i) => (iceCapNear !== null && !iceCapNear[i] ? 0 : nIceR);
	const nIceP = (p) => { if (iceCapNear === null || iceCapNear[p]) return nIceR; for (const e of portalExits.get(p)) if (iceCapNear[e]) return nIceR; return 0; };
	for (let i = 0; i < N; i++) if (cls[i] === BUP) rcT[i] = opts.riseInf ? INF : capOf(16 + riseQ(-16, pull3(i), modCurR(i), nIceAt(i)));
	for (const p of portalExits.keys()) rpT[p] = opts.riseInf ? INF : capOf(9 + riseQ(-16 * 1.42, pull3(p), modCurR(p), nIceP(p)));
	// ---- THE EXIT FROM THE ENTRY (opts.exitEntry, src/steer.js's ordering fields; d4-portal-exact): a portal p whose exits
	// all have its own rotation (eesim.js _portalTeleport: dir 0, the speeds kept, no x 1.42) puts the ball at an exit's tile
	// corner with the speed it had: a ball rising into p rises about as far from the exit, a falling one falls on. So its
	// teleports map the entry state to the exit state (R(q) -> R(q + 2): the centre moves to the exit's middle, <= 8 px up
	// from anywhere in p, + < 1 px of kept sub-pixel remainders; F(k) / L(k) -> F(k + 1)), instead of the most any teleport
	// of p can give (R(rpT[p]), F(KF): "rise 20 rows from the exit" for a ball walking in: Ice-O-Slide's (68, 159) -> (32,
	// 175), the steer's 193 tiles at the portal vs 245 for the ball standing at the exit, the portal a false near). XR
	// entries and exits in a field / boost or over ice (eesim.js resets slippery there: more ice ticks than the entry's
	// state counts): as before. Marks: exitE[p] = 1
	let exitE = null;
	if (opts.exitEntry && level.pRot) {
		for (const [p, list] of portalExits) {
			const sp = level.portalSlot[p];
			let ok = sp >= 0;
			for (const e of list) { const se = level.portalSlot[e]; if (se < 0 || level.pRot[se] !== level.pRot[sp] || cls[e] !== NORM || (e + W < N && fg[e + W] === ICE)) ok = false; }
			if (ok) { if (!exitE) exitE = new Uint8Array(N); exitE[p] = 1; }
		}
	}
	// (the air jumps: multijumps the only effect, the default gravity: the physics model with air jumps, not the walk)
	const airJ = (opts.airJumps !== undefined ? opts.airJumps === true : AIRJ_ENV()) && mjTiles > 0 && !wildOther && level.gravityMult === 1;
	if (airJ) wild = false;
	let mode = wild ? 'walk' : 'physics';
	if (mode === 'physics' && N * (Q + 20) * 2 > 128 * 1048576) mode = 'walk';
	// the field transit tables (the n3 rise-exit-apex fix: ORDERING fields only, see exitApexOn; on ice only the classes
	// whose drag the engine takes before the ice's: segTablesOf)
	const XA = exitApexOn(opts) ? exitApexTab() : null;
	const trophy = (i) => fg[i] === TROPHY && passable(i);

	// ---- goals (explore.js --hunt): tile -> cost in fifths
	let goals = 0;
	let goalF = null;
	if (opts.goals) {
		goalF = new Map();
		for (const g of opts.goals) {
			const i = g.tile;
			if (!(i >= 0 && i < N) || !passable(i) || !(g.cost >= 0)) continue;
			const c = Math.round(g.cost * 5);
			if (!goalF.has(i)) goals++;
			if (!(goalF.get(i) <= c)) goalF.set(i, c);
		}
	} else for (let i = 0; i < N; i++) if (trophy(i)) goals++;
	const maxF = opts.maxCost >= 0 ? Math.floor(opts.maxCost * 5 + 1e-9) : Infinity;

	// ---- walking distance (both modes: walk mode's cost, physics mode's fallback score): 8-way, a diagonal step closed
	// only between two walls, portals, death respawns
	const walk = walkField(W, H, cls, passable, trophy, goalF, portalExits, deaths ? { respawn, src: dsrc } : null, maxF, forcedP, blk);
	// (opts.plainFx: the effect tiles that change a plain ball become goals at their walk cost, the physics field's seeds)
	let fxSeeds = 0;
	if (fxExit !== null && fxExit.length && mode === 'physics') {
		for (const i of fxExit) {
			if (!passable(i) || walk[i] === CUT) continue;
			// (opts.fxState + opts.fxSeedCost(tile, the state after it): the exit seeded at the next state's own cost there,
			// fifths (the next state's field: one unit along a state change), at least the walk's (a lower bound); -1: the walk)
			let c = walk[i];
			if (fxS !== null && typeof opts.fxSeedCost === 'function') { const n = opts.fxSeedCost(i, fxAfter(fg[i], lk[i], fxS)); if (n >= 0) c = Math.min(FAR, Math.max(c, n)); }
			if (!(goalF.get(i) <= c)) { if (!goalF.has(i)) goals++; goalF.set(i, c); fxSeeds++; }
		}
	}
	// walk mode with protection: that walk (killing tiles open where a protected ball can be) is a protected ball's way. An
	// unprotected ball's (every killing tile deadly; the protection tiles goals at the protected walk's cost from there)
	// orders every ball, and the protected walk + PROT_COST only where the unprotected one has no way. Sound: a protected
	// ball is in protP, where the protected walk is its way; an unprotected one reaches the trophy or a protection tile by
	// its own. (Physics mode: protP's killing tiles open in the one field, as above.) The fallback's costs are ways "through
	// a death" to the lookups' blend (scoreAt, native reachScore: the deaths flag), behind every real way.
	let walkOut = walk, protFallback = 0;
	if (mode === 'walk' && protP !== null) {
		const killT = (i) => cls[i] !== WALL && fg[i] >= 0 && fg[i] < nFlags && (gF[fg[i]] & 4) !== 0;
		const passU = (i) => passable(i) && !killT(i);
		const seedU = new Map();
		if (goalF) for (const [i, c] of goalF) seedU.set(i, c);
		else for (let i = 0; i < N; i++) if (trophy(i)) seedU.set(i, 0);
		for (const p of protOn) { const v = walk[p]; if (v !== CUT && !(seedU.get(p) <= v)) seedU.set(p, v); }
		const walkU = walkField(W, H, cls, passU, trophy, seedU, portalExits, deaths ? { respawn, src: dsrc } : null, maxF, forcedP, blk);
		walkOut = new Uint16Array(N).fill(CUT);
		for (let i = 0; i < N; i++) {
			if (walkU[i] !== CUT) walkOut[i] = walkU[i];
			else if (protP[i] && walk[i] !== CUT) { walkOut[i] = Math.min(FAR, walk[i] + PROT_COST); protFallback++; }
		}
	}
	const base = { version: 3, W, H, N, mode, Q, B: Q, INF, ice, deaths: deaths || protFallback > 0, goals, toGoals: goalF !== null, cls, walk: walkOut, mismatches: 0, KLJ, fxSeeds, plainFx: plainFx && fxS === null && mode === 'physics', fx: fxS !== null && mode === 'physics' ? { mj: fxS.mj, jb: fxS.jb } : null,
		halfQuad: blk ? blk.reduce((a, x) => a + x, 0) : 0,
		prot: protP === null ? null : { on: protOn.length, tiles: protP.reduce((s, x) => s + x, 0), fallback: protFallback } };
	if (mode === 'walk') return Object.assign(base, { ms: Date.now() - t0, prioShift: prioShiftOf(walkOut), labels: 0 });

	// ---- per tile: floors, jumps, landing jumps, ceilings, segments
	const isFloor = (j) => {
		if (j >= N) return true;
		const f = fl(fg[j]);
		if ((f & (F_SOLID | F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) === 0) return false;
		if ((f & F_JUMPTHRU) && (f & F_ROTHALF) && lk[j] === 3) return false;   // a down-passing one-way: the ball falls through
		return true;
	};
	const lowWall = new Uint8Array(N);
	for (let i = 0; i < N; i++) lowWall[i] = i + W >= N || cls[i + W] === WALL || sp[i] === LOWER ? 1 : 0;
	// row segments of normal and field tiles; with a field: its push, top speed, pull and exit table are the strongest of
	// its fields (a ball can go sideways from one to the other in the row); normal tiles in it hold XR states
	const segOf = new Uint8Array(N);
	const segKey = new Map(), segPush = [0], segCap = [0], segA = [0], segRd = [0], segMask = [0];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W;) {
			const i0 = y * W + x;
			if (cls[i0] !== NORM && !isField(cls[i0])) { x++; continue; }
			let x1 = x, A = 0, cap = 0, rd = 0, any = false, mask = 0;
			while (x1 < W && (cls[y * W + x1] === NORM || isField(cls[y * W + x1]))) {
				const c = cls[y * W + x1];
				if (isField(c)) { any = true; A = Math.max(A, A_CLASS[c]); cap = Math.max(cap, CAP_CLASS[c]); if (c === UP || c === WATER) rd = 1; mask |= 1 << c; }
				x1++;
			}
			if (any) {
				// (with the transit tables the row's field classes too: dots and a chain share A and cap, not their tables)
				const key = XA !== null ? `${A}|${cap}|${rd}|${mask}` : `${A}|${cap}|${rd}`;
				let s = segKey.get(key);
				if (s === undefined) { s = segPush.length; segKey.set(key, s); segPush.push(32 * A); segCap.push(cap); segA.push(A); segRd.push(rd); segMask.push(mask); }
				if (s > 255) throw new Error('reach: too many segment kinds');
				for (let k = x; k < x1; k++) segOf[y * W + k] = s;
			}
			x = x1;
		}
	}
	const xrOK = (i) => cls[i] === NORM && segOf[i] !== 0;
	const nIce = ice ? 10 : 0;
	// (OPT-IN opts.iceLocal / EEAT_ICE_LOCAL=1: the jump's ice rise only where a slippery ball can be: iceNear, else the
	// plain rise. Off = every jump of a level with one ice block anywhere rises as from ice (72.56 px, not 63.42: +9 px, a
	// row more at the apex), a false near under every ledge 5 rows below a goal: Cold World's chapter-2 blue coin
	// (98,207), 5 rows over the floor under its 1-wide shaft and 60+ tiles from the level's ice, read 5 tiles from there
	// (the true way is from above, through its gate); the engine's best from there reaches row 208)
	const iceNear = ice && (opts.iceLocal !== undefined ? !!opts.iceLocal : ICE_LOCAL) ? iceNearOf(level, W, H, N) : null;
	const mm0 = modMinOf(level), mm = (id) => (id >= 0 && id < mm0.length ? mm0[id] : G);
	const T = TABLES[ice ? 1 : 0];
	const KSTEP = ice ? 2 : 1;   // rows of fall potential per row fallen (ice: the ball may still fall with less drag)
	// the jump: from a floor under the centre's tile, a lower half block, or a ledge beside (the box overhangs it); the
	// gravity queue of the tick after the jump holds the current tile of the tick before it, anywhere in the 3 x 3 tiles
	// around (a neighbour that pulls up: up arrows, liquids, dots, climbables, and boosts, whose zero gravity lets up act):
	// the lookup's own table (modMin) of that tile's id
	const J = new Int8Array(N).fill(-128);
	const modCur = (n) => { const j = curOf[n]; return j < 0 ? G : mm(fg[j]); };
	// (opts.fxState: the ball's jump speed and jumps; eesim.js _jumpMultiplier: jump_boost 1 x1.3, 2 x0.75)
	const MJX = fxS !== null ? fxS.mj : 1;
	const JVX = MJX === 0 ? 0 : fxS !== null ? JV * (fxS.jb === 1 ? 1.3 : fxS.jb === 2 ? 0.75 : 1) : JV;
	const rjAir = MJX > 1 ? riseQ(JVX, G, G, nIce) : 0;
	for (let i = 0; i < N; i++) {
		if (cls[i] !== NORM) continue;
		if (i < W || cls[i - W] === WALL) continue;   // a ceiling right above: the jump bonks at once
		const x = i % W, y = (i / W) | 0;
		let m = G;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H) m = Math.min(m, modCur(ny * W + nx));
		}
		// (opts.fxState: the jump effect's speed; mj jumps: + mj - 1 air jumps from the apex, in plain air; none at mj 0)
		if (JVX === 0) continue;
		const rj = riseQ(JVX, m, G, iceNear !== null && !iceNear[i] ? 0 : nIce) + (MJX > 1 ? (MJX - 1) * rjAir : 0);
		let e = -1e9;
		if (isFloor(i + W) && !(i + W < N && sp[i + W] === LOWER)) e = Math.max(e, rj - 8);
		if (sp[i] === LOWER) e = Math.max(e, rj);
		for (const d of [-1, 1]) {
			const nx = x + d;
			if (nx < 0 || nx >= W) continue;
			const n = i + d;
			if (cls[n] === WALL) continue;
			if (isFloor(n + W) && !(n + W < N && sp[n + W] === LOWER)) e = Math.max(e, rj - 8);
			if (sp[n] === LOWER) e = Math.max(e, rj);
		}
		if (e > -1e9) J[i] = fxS !== null && e + TOL > 8 * Q ? INF : qOf(e, Q);   // (opts.fxState: past Q's rows, anywhere up)
	}
	// (the air jumps: the rise of a jump anywhere in a normal tile, the centre up to the tile's top edge: the stand jump's
	// rise from a floor + 8, and 8 px of margin; the gravity queue as the stand jump's)
	const JA = airJ ? new Int8Array(N).fill(-128) : null;
	if (JA !== null) for (let i = 0; i < N; i++) {
		if (cls[i] !== NORM) continue;
		const x = i % W, y = (i / W) | 0;
		let m = G;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H) m = Math.min(m, modCur(ny * W + nx));
		}
		JA[i] = qOf(riseQ(JV, m, G, nIce) + 8, Q);
	}
	// landing-tick jump sites: a field tile over a floor (or beside a floor under a neighbour that is not a wall)
	const lj = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		if (!isField(cls[i])) continue;
		const x = i % W;
		if (isFloor(i + W) || (x > 0 && cls[i - 1] !== WALL && isFloor(i + W - 1)) || (x < W - 1 && cls[i + 1] !== WALL && isFloor(i + W + 1))) lj[i] = 1;
	}
	// up arrows under a ceiling (anything that stops a rise): the jump down from it
	const ceilJ = new Uint8Array(N);
	for (let i = 0; i < N; i++) if (cls[i] === UP && (i < W || cls[i - W] === WALL || (fl(fg[i - W]) & (F_SOLID | F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) !== 0)) ceilJ[i] = 1;
	const KJD = Math.min(KF, kOfX(fallD(Math.max(-JV, -JVX)) + 16) + (ice ? 1 : 0));   // (opts.fxState: the stronger jump)

	// ---- per-tile profiles (what fwd reads), the model
	// (opts.oneWayEntry, src/steer.js only: a one-way platform's centre entry against its pass direction is blocked (a plain
	// one-way cannot be entered from above). Not sound (a ball that rose into a platform may fall back through it), so never
	// in the RCH3 proof field: the steer field only orders)
	const owOf = new Int8Array(N).fill(-1);
	if (opts.oneWayEntry) for (let i = 0; i < N; i++) { const f = fl(fg[i]); if ((f & F_JUMPTHRU) && cls[i] !== WALL && cls[i] !== DEADLY) owOf[i] = (f & F_ROTHALF) ? (lk[i] & 3) : 1; }
	const profKey = new Map(), prof = [], pid = new Int32Array(N);
	for (let i = 0; i < N; i++) {
		const key = (cls[i] === BUP ? rcT[i] + 2 : 0) * 1e9 + (owOf[i] + 1) * 1e8 + cls[i] * 1e7 + sp[i] * 1e6 + lowWall[i] * 1e5 + lj[i] * 1e4 + (xrOK(i) ? 1e3 : 0) + segOf[i];
		let p = profKey.get(key);
		if (p === undefined) {
			p = prof.length; profKey.set(key, p);
			const s = segOf[i];
			prof.push({ ow: owOf[i], cls: cls[i], sp: sp[i], lowWall: lowWall[i], lj: lj[i], xrOK: xrOK(i) ? 1 : 0, push: segPush[s], cap: segCap[s], A: segA[s], rd: segRd[s], rc: cls[i] === BUP ? rcT[i] : INF, seg: s });
		}
		pid[i] = p;
	}
	const qOfQ = (e) => qOf(e, Q);
	const vfieldP = (P, v, h) => Math.max(v, Math.min(P.cap, Math.sqrt(v * v + P.push * h)));
	const Pexit = (P, v) => v + interp(P.rd ? T.RD : T.RC, v);          // a field's exit: the centre's apex above the row's top edge
	// (XR: its apex by the exit table of its row's fields: the queue holds one of them; the +v margin covers one tick of another
	// kind's pull left from the row below)
	// (the transit tables, XA: per row segment the largest of its field classes' tables, like its push and top speed; up / in:
	// the C level at the row's top edge from a speed at its bottom edge / anywhere in it; exit: the apex over its top edge)
	const segT = XA !== null ? segMask.map((m) => segTablesOf(XA, m, ice)) : null;
	const xUp = (P, v) => segT[P.seg].up[cOfV(v)], xIn = (P, v) => segT[P.seg].in[cOfV(v)];
	const xExit = (P, v) => (XA !== null && P.seg !== 0 ? Math.min(Pexit(P, v), segT[P.seg].exit[cOfV(v)]) : Pexit(P, v));
	const enterR = (P2, e, emit, below) => {
		const c = P2.cls;
		if (c === BUP) emit(R_, P2.rc);
		else if (c === BDOWN) emit(F_, KF);
		else if (c === NORM || c === DEADLY) { const q = qOfQ(e); if (q >= 0 || !P2.lowWall) emit(R_, q); }
		else if (isField(c)) {
			// (below: over the row's bottom edge at <= RaInv(e + 16) (e is then the apex above this row's top edge less 16:
			// RaInv of the apex above the edge crossed); else anywhere in the row at that speed)
			const u = RaInv(e + 16);
			const cl = cOfV(vfieldP(P2, u, 1));
			emit(C_, XA !== null ? Math.min(cl, below ? xUp(P2, u) : xIn(P2, u)) : cl);
		}
	};
	const enterDown = (P2, k, emit) => {
		const c = P2.cls;
		if (c === BUP) emit(R_, P2.rc);
		else if (c === BDOWN) emit(F_, KF);
		else emit(F_, Math.min(KF, k + KSTEP));
	};
	// (opts.fxState: the ball's jump speed; none at mj 0)
	const ljump = (P, P2, k, emit) => { if (JVX !== 0 && P.cls === NORM && P2.lj && k >= KLJ) { const cl = cOfV(vfieldP(P2, -JVX, 1)); emit(C_, XA !== null ? Math.min(cl, xIn(P2, -JVX)) : cl); } };
	/** the forward model: a move from a tile of profile P to a neighbour of profile P2 by (dx, dy) of a state (ty, l) */
	function fwd(P, P2, dx, dy, ty, l, emit) {
		if ((P2.sp === LOWER && dy < 0) || (P.sp === LOWER && dy > 0) || (P2.sp === RIGHT && dx < 0) || (P.sp === RIGHT && dx > 0)) return;
		if (P2.ow >= 0 && (P2.ow === 1 ? dy === 1 : P2.ow === 3 ? dy === -1 : P2.ow === 2 ? dx === -1 : dx === 1)) return;   // (opts.oneWayEntry)
		const src = P.cls, dst = P2.cls;
		// (a ball whose tick starts in an up boost rises at most its cap, whatever it had: the lookup's R(INF) there)
		if (src === BUP && ty === R_ && l > P.rc) l = P.rc;
		if (ty === R_ && l === INF) {   // unlimited rise (an up boost or a portal exit whose cap is not proven in Q levels: ice): anywhere up or sideways (and everything R(Q) does)
			fwd(P, P2, dx, dy, R_, Q, emit);
			if (dy === 1) enterDown(P2, KF, emit);
			else if (dst === BDOWN) emit(F_, KF);
			else emit(R_, INF);
			return;
		}
		if (src === BDOWN) { if (ty === F_) { if (dy === 1) enterDown(P2, l, emit); else if (dy === 0) emit(F_, l); } return; }
		if (ty === L_) {   // falling in the lower half of a normal row: never at standing height here
			if (src !== NORM && src !== BUP) return;
			if (dy === 0) { if (dst === BUP) emit(R_, P2.rc); else if (dst === BDOWN) emit(F_, KF); else if (isField(dst)) emit(F_, l); else if (!P2.lowWall) emit(L_, l); }
			else if (dy === 1) { enterDown(P2, l, emit); ljump(P, P2, l, emit); }
			return;
		}
		if (ty === F_) {
			if (dy === 0) { if (dst === BUP) emit(R_, P2.rc); else if (dst === BDOWN) emit(F_, KF); else emit(F_, l); }
			else if (dy === 1) { enterDown(P2, l, emit); ljump(P, P2, l, emit); }
			return;
		}
		if (src === NORM || src === BUP) {
			if (ty === C_) return;
			if (ty === X_) {
				const v = vOfC(l), e = xExit(P, v), q = qOfQ(e);
				// (back into a field of this row: no faster (no pumping); with the tables, a drag field's tick takes its share)
				if (dy === 0) { if (isField(dst)) emit(C_, XA !== null ? Math.min(l, xIn(P2, v)) : l); else if (dst === NORM && P2.xrOK) emit(X_, l); else enterR(P2, e, emit, false); }
				else if (dy === -1) {
					// (with the tables, up into a field: over its bottom edge at the XR state's own speed, not at the speed of its
					// apex, which the exit margin makes more; up into a normal tile of a row with a field: an XR state again, at
					// the speed of the apex left there (less than its own: an XR ball never gains by going up in the air), not
					// an R state, whose entry into a field there takes RaInv(the apex + 16))
					if (q >= 1) {
						if (XA !== null && isField(dst)) emit(C_, Math.min(cOfV(vfieldP(P2, v, 1)), xUp(P2, v)));
						else if (XA !== null && dst === NORM && P2.xrOK) { if (qOfQ(e - 16) >= 0 || !P2.lowWall) emit(X_, Math.min(l, cOfV(RaInv(e - 16)))); }
						else enterR(P2, e - 16, emit, true);
					}
				}
				else { const kb = kOfX(e + 16); enterDown(P2, kb, emit); ljump(P, P2, kb, emit); }
				return;
			}
			// R(q)
			const e = 8 * l - TOL;
			if (dy === -1) { if (l >= 1) enterR(P2, e - 16, emit, true); }
			else if (dy === 0) enterR(P2, sideCapQ > 0 && src === NORM && dst === NORM ? Math.min(e, 8 * sideCapQ - TOL) : e, emit, false);
			else { const kb = kOfX(e + 16); enterDown(P2, kb, emit); ljump(P, P2, kb, emit); }
			return;
		}
		// a field: C(c) (down: through the same-tile edge C -> F(0))
		if (ty !== C_ || !isField(src)) return;
		const v = vOfC(l);
		if (dy === -1) {
			if (isField(dst)) {
				const vin = Math.min(16, v + 2 * Math.max(0, P.A - P2.A));   // (the queue: 2 ticks of the old pull)
				const cl = cOfV(vfieldP(P2, vin, 1));
				emit(C_, XA !== null ? Math.min(cl, xUp(P2, vin)) : cl);
			} else {
				const e = xExit(P, v) - 16;
				// (with the tables: out over the top edge into a normal tile of a row with a field, an XR state (it left a field)
				// at the speed of the apex left over that edge (at most its own), not an R state: an R ball entering a field
				// again takes RaInv(its apex + 16), the margin of a ball anywhere in the row, and field -> air -> field climbed a
				// column and the air beside it at a gain every row (Barrel Cannon Canyon's dot rail to 16 px/tick, Happy
				// Spookaween's chain 24 rows up))
				if (XA !== null && dst === NORM && P2.xrOK) { if (qOfQ(e) >= 0 || !P2.lowWall) emit(X_, Math.min(l, cOfV(RaInv(e)))); }
				else enterR(P2, e, emit, true);
			}
		} else if (dy === 0) {
			if (isField(dst)) emit(C_, l);
			else if (dst === NORM && P2.xrOK) emit(X_, l);
			else enterR(P2, xExit(P, v), emit, false);
		}
	}
	// ---- the stop in a field, the up-arrow bounce
	const stopC = (t) => cOfV(vfieldP(prof[pid[t]], 2 * G, lowWall[t] ? 0.5 : 1));
	const bTurn = opts.bounceTurn !== undefined ? !!opts.bounceTurn : BOUNCE_TURN;   // (THE BOUNCE'S TURN: VTURN above)
	const bounceC = (t, k) => { const P = prof[pid[t]], v = bTurn ? Math.min(VFC[k], VTURN) : VFC[k]; return cOfV(Math.min(16, Math.sqrt(v * v + Math.max(P.push, 8 * G * v + 10 * G * G)))); };

	// ---- same-tile edges (cost 0) and the edges to other tiles (portals: cost 5; death respawns: DEATH_COST), forward
	/** the same-tile edges of (t, ty, l): emit(ty2, l2) */
	function sameTile(t, ty, l, emit) {
		const c = cls[t];
		if (c === NORM) {
			if (J[t] !== -128 && ((ty === R_ && l >= 0) || ty === F_ || ty === X_)) emit(R_, J[t]);   // stand, jump
			if (JA !== null && JA[t] !== -128) emit(R_, JA[t]);   // (the air jumps: from any state here)
			if ((ty === R_ && l >= 0) || ty === X_) emit(F_, 1);   // the apex (at or above the middle)
			if (ty === R_ && l === -1) emit(L_, 0);               // the apex in the lower half
			if (ty === F_) emit(L_, l);                           // (a falling ball may be in the lower half)
		} else if (isField(c)) {
			if (ty === F_) emit(C_, c === UP ? bounceC(t, l) : stopC(t));   // stop and rise / bounce
			if (ty === C_) emit(F_, 0);                                     // turn round
			if (ceilJ[t] && (ty === F_ || ty === C_)) emit(F_, KJD);         // the jump down from a ceiling in up arrows
			if (JA !== null && c !== DOTS && (ty === F_ || ty === C_)) { emit(C_, NL - 1); emit(F_, KJD); }   // (the air jumps in a pulling field)
		} else if (c === BDOWN) emit(F_, KF);
		else if (c === BUP) emit(R_, rcT[t]);
	}
	/** the edges of (t, ty, l) to other tiles: emit(t2, ty2, l2, cost). A death: the respawned ball stands still in the
	 *  respawn tile's middle, its gravity queue from where it died (a pull there lifts it a pixel or so: R(0), which the
	 *  lookup gives it; F(0) without one) */
	function crossEdges(t, ty, l, emit) {
		if (deaths && dsrcT[t] === 1) for (const r of respawn) { emit(r, F_, 0, DEATH_COST); if (cls[r] === NORM) emit(r, R_, 0, DEATH_COST); }
		if (cls[t] === DEADLY) return;
		// (the exit: R(rpT[t]) (the rise cap of t's teleports), F(16), and in a field C(16 px/tick): the rotated speed is clamped
		// to 16 by the next update, and the teleport tick moves <= 16 px; an exit whose tile is a DOWN boost (a stale portal
		// entry under a 117) keeps R(INF): R has no moves in a down boost (fwd returns there), but the teleport tick moves
		// the ball up out of the exit tile, so no tick of it starts in the boost: fwd's INF branch is its rise (the n3
		// rise-q16 soundness review: R(rpT) there was a false -1))
		if (ty !== C_ && portalExits.has(t)) {
			if (exitE !== null && exitE[t] === 1 && ty !== X_) {   // (the exit from the entry: opts.exitEntry)
				for (const e of portalExits.get(t)) {
					if (ty === R_) emit(e, R_, Math.min(rpT[t], l === INF || l + 2 > Q ? INF : l + 2), 5);   // (and never past the teleport's own cap)
					else emit(e, F_, Math.min(KF, l + 1), 5);   // (F, L)
				}
			} else for (const e of portalExits.get(t)) { emit(e, R_, cls[e] === BDOWN ? INF : rpT[t], 5); emit(e, F_, KF, 5); if (isField(cls[e])) emit(e, C_, NL - 1, 5); }
		}
	}

	// ---- storage: R, F and L per tile, C per field tile, XR per xrOK tile
	const rowC = new Int32Array(N).fill(-1), rowX = new Int32Array(N).fill(-1);
	let nC = 0, nX = 0;
	for (let i = 0; i < N; i++) { if (isField(cls[i])) rowC[i] = nC++; else if (xrOK(i)) rowX[i] = nX++; }
	const costR = new Uint16Array(N * NR).fill(CUT), costF = new Uint16Array(N * (KF + 1)).fill(CUT), costL = new Uint16Array(N * (KF + 1)).fill(CUT);
	const costC = new Uint16Array(nC * NL).fill(CUT), costX = new Uint16Array(nX * NL).fill(CUT);
	const NLV = [NR, KF + 1, NL, NL, KF + 1], LO = [-1, 0, 0, 0, 0], HI = [INF, KF, NL - 1, NL - 1, KF];
	const COST = [costR, costF, costX, costC, costL];
	const slotOf = (t, ty) => (ty === C_ ? rowC[t] : ty === X_ ? rowX[t] : t);
	// the search's front per (tile, type) in one array: the lowest level index labelled so far
	const XB = 2 * N, CB = XB + nX, LB = CB + nC;
	const front = new Int16Array(LB + N);
	front.fill(NR, 0, N); front.fill(KF + 1, N, XB); front.fill(NL, XB, LB); front.fill(KF + 1, LB);
	// ---- the inverse model: per (source profile, target profile, direction) [5 source types][5 target types][128 target
	// level indices] = the least source level whose move reaches at least that target level (NONE: none), lazily
	const DIRS = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) DIRS.push([dx, dy]);
	const DX = Int8Array.from(DIRS, (d) => d[0]), DY = Int8Array.from(DIRS, (d) => d[1]);
	const nP = prof.length;
	const invArr = new Array(nP * nP * 8).fill(null);
	const idxOf = (ty, l) => l - LO[ty];
	const maxOut = new Int16Array(NT), run = new Int16Array(NT);
	const note = (ty2, l2) => { const i2 = l2 - LO[ty2]; if (i2 > maxOut[ty2]) maxOut[ty2] = i2; };
	function invTable(pt, pt2, di) {
		const key = (pt * nP + pt2) * 8 + di;
		let tab = invArr[key];
		if (tab !== null) return tab;
		tab = new Int8Array(NT * NT * NL).fill(NONE8);
		const P = prof[pt], P2 = prof[pt2], dx = DX[di], dy = DY[di];
		for (let ty = 0; ty < NT; ty++) {
			run.fill(-1);
			for (let l = LO[ty]; l <= HI[ty]; l++) {   // ascending: each target level index gets the first source level reaching it
				maxOut.fill(-1);
				fwd(P, P2, dx, dy, ty, l, note);
				for (let ty2 = 0; ty2 < NT; ty2++) {
					const m = maxOut[ty2];
					if (m > run[ty2]) { for (let x = run[ty2] + 1; x <= m; x++) tab[(ty2 * NL + x) * NT + ty] = l; run[ty2] = m; }
				}
			}
		}
		invArr[key] = tab;
		return tab;
	}
	// ---- the side-arrow and slot prices (ordering only: the -1 set is the plain model's, only the prices of moves change)
	const SA = sideArrowPrices(level, airJ ? Object.assign({}, opts, { sideArrow: false }) : opts, { N, W, H, cls, curOf, passable, isFloor, fg, srcOf, trophy });
	// ---- the backward label-setting search in cost buckets (integer costs; edges cost 0, 5 or 7, a priced move more)
	let seeds = [];
	if (goalF) seeds = [...goalF].sort((a, b) => a[1] - b[1]);
	else for (let i = 0; i < N; i++) if (trophy(i)) seeds.push([i, 0]);
	const srcP = new Uint8Array(N);
	for (let i = 0; i < N; i++) srcP[i] = passable(i) && fg[i] !== TROPHY && !forcedP[i] ? 1 : 0;   // (move sources: the trophy ends the way; a forced portal is left by its exits only)
	const stopT = new Int16Array(N).fill(-1);
	for (let i = 0; i < N; i++) if (isField(cls[i]) && cls[i] !== UP) stopT[i] = stopC(i);
	const bounceT = new Int16Array(N * (KF + 1));
	for (let i = 0; i < N; i++) if (cls[i] === UP) for (let k = 0; k <= KF; k++) bounceT[i * (KF + 1) + k] = bounceC(i, k);
	const respawnT = new Uint8Array(N);
	if (deaths) for (const r of respawn) respawnT[r] = cls[r] === NORM ? 2 : 1;   // (2: R(0) is a respawn state too)
	const srcList = new Array(N).fill(null);
	for (const [e, ps] of srcOf) srcList[e] = Int32Array.from(ps);
	const { labels, maxFin } = labelSearch({ N, W, H, NR, NL, KF, cls, J, ceilJ, KJD, pid, srcP, rowC, rowX, COST, NLV, LO, front, XB, CB, LB,
		invArr, invTable, nP, stopT, bounceT, srcList, respawnT, dsrc: Int32Array.from(deaths ? dsrc : []), seeds, maxF, rcT, rpT, pen: SA.pen, penCost: SA.cost, blk, exitE, Q, INF, JA });
	const kinds = invArr.reduce((a, x) => a + (x !== null ? 1 : 0), 0);
	const field = Object.assign(base, { ms: 0, labels, kinds, profiles: nP, prioShift: 0, KJD, sideArrow: SA.info, airJumps: airJ,
		seg: segOf, segPush: Float64Array.from(segPush), segCap: Float64Array.from(segCap), rowC, rowX, costR, costF, costL, costC, costX, nC, nX,
		modMin: mm0 });
	field.prioShift = Math.max(0, bitLen(Math.min(maxFin, FAR)) - 12);
	if (XA !== null) field.exitApex = true;
	const costOf = (t, ty, l) => { const s = slotOf(t, ty); if (s < 0) return CUT; return COST[ty][s * NLV[ty] + idxOf(ty, Math.max(LO[ty], Math.min(HI[ty], l)))]; };
	/** every edge out of (t, ty, l): emit(t2, ty2, l2, cost) */
	const edgesOf = (t, ty, l, emit) => {
		if (fg[t] === TROPHY) return;
		crossEdges(t, ty, l, emit);
		if (cls[t] === DEADLY) return;
		sameTile(t, ty, l, (ty2, l2) => emit(t, ty2, l2, 0));
		const x = t % W, y = (t / W) | 0;
		for (let di = 0; di < 8; di++) {
			const [dx, dy] = DIRS[di], x2 = x + dx, y2 = y + dy;
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const t2 = y2 * W + x2;
			if (!passable(t2) && !(deaths && cls[t2] === DEADLY)) continue;
			if (dx && dy && cls[y * W + x2] === WALL && cls[y2 * W + x] === WALL) continue;
			if (blk && blk[t * 8 + di]) continue;
			const add = (dx && dy ? 7 : 5) + (SA.pen !== null && SA.pen[t * 8 + di] !== 0 ? SA.cost : 0);
			fwd(prof[pid[t]], prof[pid[t2]], dx, dy, ty, l, (ty2, l2) => emit(t2, ty2, l2, add));
		}
	};

	// ---- opts.check: every stored cost is the best edge + its target's stored cost (integers), and a cut-off state has
	// no finite option
	if (opts.check) {
		let bad = 0;
		for (let t = 0; t < N; t++) {
			if (!passable(t) && !(deaths && cls[t] === DEADLY)) continue;
			for (let ty = 0; ty < NT; ty++) {
				if (slotOf(t, ty) < 0) continue;
				for (let l = LO[ty]; l <= HI[ty]; l++) {
					let best = goalF ? (goalF.has(t) ? goalF.get(t) : Infinity) : trophy(t) ? 0 : Infinity;
					edgesOf(t, ty, l, (t2, ty2, l2, add) => { const c = costOf(t2, ty2, l2); if (c !== CUT && c + add < best) best = c + add; });
					const have = COST[ty][slotOf(t, ty) * NLV[ty] + idxOf(ty, l)];
					if (have === FAR) continue;
					if (have === CUT) { if (best !== Infinity && best <= maxF) bad++; }
					else if (have !== best && !(best > FAR)) bad++;
				}
			}
		}
		field.mismatches = bad;
	}
	// ---- opts.explain: when the start is cut off, the highest row its centre can reach in the model (a forward search:
	// small then; from a start that is not cut off it would walk the whole model, so it is skipped: explain null)
	field.explain = null;
	const sim0 = opts.explain ? new E.EESim(level) : null;
	if (sim0) sim0.reset();
	if (sim0 && fifthsAt(field, sim0.px, sim0.py, sim0.speed_y, sim0._q0, sim0._q1, sim0._slippery) < 0) {
		const sim = sim0;
		const st = stateOf(field, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
		let best = -1, trophyRow = -1;
		for (let i = 0; i < N; i++) if (trophy(i)) { const r = (i / W) | 0; if (trophyRow < 0 || r < trophyRow) trophyRow = r; }
		const starts = st ? [...(st.base ? [st.base] : []), ...(st.rise || [])] : [];
		if (starts.length) {
			const seen = [new Map(), new Map(), new Map(), new Map(), new Map()];
			const q = [];
			const add = (t, ty, l) => { if (slotOf(t, ty) < 0) return; const m = seen[ty]; const o = m.get(t); if (o !== undefined && o >= l) return; m.set(t, l); q.push(t, ty, l); };
			for (const [ty, l] of starts) add(st.t, ty, l);
			let steps = 0;
			while (q.length && steps++ < 5e6) {
				const l = q.pop(), ty = q.pop(), t = q.pop();
				const row = (t / W) | 0;
				if (best < 0 || row < best) best = row;
				edgesOf(t, ty, l, (t2, ty2, l2) => add(t2, ty2, l2));
			}
		}
		field.explain = { row: best, trophyRow, startRow: st ? (st.t / W) | 0 : -1 };
	}
	if (opts.debug) Object.defineProperty(field, '_m', { value: { fwd, prof, pid, J, lj, ceilJ, KJD, DIRS, stopC, bounceC, portalExits, respawn, passable, lowWall, segOf, edgesOf, costOf, rcT, rpT } });
	// (OPT-IN EEAT_SIDE_CAP / opts.sideCap: the sideways-kept rise's ordering price, goal fields only: SIDE_CAP above)
	const scq = opts.sideCap !== undefined ? Math.max(0, Math.min(40, opts.sideCap | 0)) : SIDE_CAP;
	if (scq > 0 && !sideCapQ && goalF && !opts.check && !opts.debug) {
		const capped = reachField(level, Object.assign({}, opts, { _sideCapQ: scq, explain: false }));
		sideCapMerge(field, capped, scq);
	}
	field.ms = Date.now() - t0;
	return field;
}
/** the sideways-kept rise's ordering merge (SIDE_CAP): every finite cost of the plain field f becomes the capped field g's
 *  cost there (at least f's), or f's + SIDE_CAP_PEN where g cuts the state; f's CUT and FAR stay: the same -1 set */
function sideCapMerge(f, g, q) {
	const pairs = [[f.costR, g.costR], [f.costF, g.costF], [f.costL, g.costL], [f.costC, g.costC], [f.costX, g.costX]];
	let changed = 0, pen = 0, mx = 0;
	for (const [a, b] of pairs) {
		if (!a || !b || a.length !== b.length) continue;
		for (let i = 0; i < a.length; i++) {
			const x = a[i];
			if (x === CUT || x === FAR) continue;
			const y = b[i];
			const v = y === CUT ? Math.min(FAR, x + SIDE_CAP_PEN) : y === FAR ? FAR : Math.max(x, y);
			if (y === CUT) pen++;
			if (v !== x) { a[i] = v; changed++; }
			if (v < FAR && v > mx) mx = v;
		}
	}
	f.prioShift = Math.max(f.prioShift || 0, bitLen(Math.min(mx, FAR)) - 12);
	f.sideCap = { q, changed, pen, ms: g.ms };
}
/**
 * The backward label-setting search (reachField's core, a function of its own so the engine optimizes it): labels
 * (tile, type, level index, cost) in increasing cost from cost buckets; a label below the (tile, type)'s front sets
 * the costs of the levels up to the old front, then the inverse edges push their sources. Same-tile edges (cost 0),
 * portals and deaths (5), moves (5, diagonal 7) through the inverse tables (S.invTable).
 */
function labelSearch(S) {
	const { N, W, H, NR, NL: L, cls, J, ceilJ, KJD, pid, srcP, rowC, rowX, COST, NLV, LO, front, XB, CB, LB, invArr, invTable, nP,
		stopT, bounceT, srcList, respawnT, dsrc, seeds, maxF, rcT, rpT } = S;
	const blk = S.blk || null, exitE = S.exitE || null, Q = S.Q, INF = S.INF;   // (the half-block quadrants' closed moves; the exit from the entry)
	const JA = S.JA || null;   // (the air jumps: reachField's JA)
	const K1 = S.KF + 1;
	// (a ring of cost buckets longer than the dearest edge: 8 for 5 / 7; with the side-arrow prices a power of two past the
	// price, its buckets made when first used)
	const pen = S.pen || null, penCost = pen !== null ? S.penCost : 0;
	const NB = pen !== null ? 1 << bitLen(penCost + 8) : 8;
	const bk = [], bn = new Int32Array(NB);
	for (let b = 0; b < NB; b++) bk.push(NB === 8 ? new Int32Array(4096) : null);
	let queued = 0, cur = 0;
	// the lowest level pushed per slot and its cost: a later push at a level and cost no lower is dominated
	const pendL = new Int16Array(front.length).fill(32767), pendC = new Int32Array(front.length);
	const fslot = (t, ty) => (ty === 0 ? t : ty === 1 ? N + t : ty === 4 ? LB + t : ty === 2 ? (rowX[t] < 0 ? -1 : XB + rowX[t]) : rowC[t] < 0 ? -1 : CB + rowC[t]);
	const push = (t, ty, i, c) => {
		if (c > maxF) return;
		const s = fslot(t, ty);
		if (s < 0 || i >= front[s] || (i >= pendL[s] && c >= pendC[s])) return;
		if (i < pendL[s]) { pendL[s] = i; pendC[s] = c; }
		const b = c & (NB - 1);
		let a = bk[b];
		if (a === null) bk[b] = a = new Int32Array(256);
		if (bn[b] === a.length) { const a2 = new Int32Array(a.length * 2); a2.set(a); bk[b] = a = a2; }
		a[bn[b]++] = t * 2048 + ty * 256 + i;
		queued++;
	};
	const pushAllLow = (t, c) => { for (let ty = 0; ty < 5; ty++) push(t, ty, 0, c); };
	const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
	let si = 0, labels = 0, maxFin = 0;
	// deaths: every death source costs DEATH_COST more than the cheapest respawn state (a respawn tile's F(0), or R(0)), so
	// the sources are pushed once, when that label is set, at its cost + DEATH_COST (beyond the bucket ring: kept aside)
	let dState = dsrc.length ? 0 : 2, dAt = 0;   // 0 waiting for a respawn label, 1 pending at dAt, 2 done
	while (si < seeds.length || queued > 0 || dState === 1) {
		if (queued === 0) cur = si < seeds.length && !(dState === 1 && dAt < seeds[si][1]) ? seeds[si][1] : dAt;
		if (cur > maxF) break;
		while (si < seeds.length && seeds[si][1] === cur) pushAllLow(seeds[si++][0], cur);
		if (dState === 1 && dAt === cur) { dState = 2; for (let n = 0; n < dsrc.length; n++) pushAllLow(dsrc[n], cur); }
		const b = cur & (NB - 1), cv = cur > FAR ? FAR : cur;
		for (let n = 0; n < bn[b]; n++) {
			const key = bk[b][n];
			queued--;
			const t2 = (key / 2048) | 0, ty2 = (key >> 8) & 7, i2 = key & 255;
			const fs2 = fslot(t2, ty2), old = front[fs2];
			if (i2 >= old) continue;
			// the costs of the levels from i2 up to the old front
			const s2 = ty2 === 3 ? rowC[t2] : ty2 === 2 ? rowX[t2] : t2, cst = COST[ty2], L2 = NLV[ty2];
			for (let x = i2; x < old; x++) cst[s2 * L2 + x] = cv;
			front[fs2] = i2;
			labels++;
			if (cur > maxFin && dState !== 2) maxFin = cur;   // (the priorities' range: the costs of real ways, before deaths)
			const c2 = cls[t2], l2 = i2 + LO[ty2];
			// same-tile edges into (t2, ty2, >= l2) (the inverse of sameTile)
			if (c2 === NORM) {
				if (ty2 === R_ && J[t2] !== -128 && l2 <= J[t2]) { push(t2, R_, 1, cur); push(t2, F_, 0, cur); push(t2, X_, 0, cur); }
				if (JA !== null && ty2 === R_ && JA[t2] !== -128 && l2 <= JA[t2]) { push(t2, R_, 0, cur); push(t2, F_, 0, cur); push(t2, X_, 0, cur); push(t2, L_, 0, cur); }
				if (ty2 === F_ && l2 <= 1) { push(t2, R_, 1, cur); push(t2, X_, 0, cur); }
				if (ty2 === L_) { if (l2 <= 0) push(t2, R_, 0, cur); push(t2, F_, l2, cur); }
			} else if (c2 >= DOTS && c2 <= UP) {
				if (ty2 === C_) {
					if (c2 !== UP) { if (l2 <= stopT[t2]) push(t2, F_, 0, cur); }
					else { for (let k = 0; k < K1; k++) if (bounceT[t2 * K1 + k] >= l2) { push(t2, F_, k, cur); break; } }
				}
				if (ty2 === F_) {
					if (l2 <= 0) push(t2, C_, 0, cur);
					if (ceilJ[t2] && l2 <= KJD) { push(t2, F_, 0, cur); push(t2, C_, 0, cur); }
				}
				// (the air jumps in a pulling field: C(fastest) and F(KJD) from any F / C state here)
				if (JA !== null && c2 !== DOTS && ((ty2 === C_) || (ty2 === F_ && l2 <= KJD))) { push(t2, F_, 0, cur); push(t2, C_, 0, cur); }
			} else if (c2 === BDOWN) { if (ty2 === F_) pushAllLow(t2, cur); }
			else if (c2 === BUP) { if (ty2 === R_ && l2 <= rcT[t2]) pushAllLow(t2, cur); }
			// portals: (portal tile p, any but C) -> (exit, R(rpT[p]) (R(INF) on a down boost: crossEdges), F(16), and C(16 px/tick) in a field)
			if (srcList[t2] !== null && (ty2 === F_ || ty2 === R_ || (ty2 === C_ && c2 >= DOTS && c2 <= UP))) for (const p of srcList[t2]) {
				if (exitE !== null && exitE[p] === 1) {
					// (the exit from the entry, opts.exitEntry: R(l) -> R(min(l + 2 (INF past Q), rpT[p])), F(k) / L(k) -> F(k + 1);
					// XR as before)
					if (ty2 === R_) {
						if (l2 > rpT[p]) continue;
						push(p, R_, (l2 === INF ? Q - 1 : Math.max(-1, l2 - 2)) + 1, cur + 5);
						push(p, X_, 0, cur + 5);
					} else if (ty2 === F_) { const i0 = Math.max(0, l2 - 1); push(p, F_, i0, cur + 5); push(p, L_, i0, cur + 5); push(p, X_, 0, cur + 5); }
					continue;
				}
				if (ty2 === R_ && c2 !== BDOWN && l2 > rpT[p]) continue;
				push(p, R_, 0, cur + 5); push(p, F_, 0, cur + 5); push(p, X_, 0, cur + 5); push(p, L_, 0, cur + 5);
			}
			// deaths: (a death source, any) -> (respawn tile, F(0) or R(0))
			if (dState === 0 && respawnT[t2] !== 0 && ((ty2 === F_ && l2 === 0) || (ty2 === R_ && l2 <= 0 && respawnT[t2] === 2))) { dState = 1; dAt = cur + DEATH_COST; }
			// moves into t2 from its 8 neighbours
			const x2 = t2 % W, y2 = (t2 - x2) / W, pt2 = pid[t2], o = (ty2 * L + i2) * 5;
			for (let di = 0; di < 8; di++) {
				const dx = DX[di], dy = DY[di], x = x2 - dx, y = y2 - dy;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const t = y * W + x;
				if (srcP[t] === 0) continue;
				if (dx !== 0 && dy !== 0 && cls[y * W + x2] === WALL && cls[y2 * W + x] === WALL) continue;
				if (blk !== null && blk[t * 8 + di] !== 0) continue;
				const pt = pid[t];
				let tab = invArr[(pt * nP + pt2) * 8 + di];
				if (tab === null) tab = invTable(pt, pt2, di);
				const step = cur + (dx !== 0 && dy !== 0 ? 7 : 5) + (pen !== null && pen[t * 8 + di] !== 0 ? penCost : 0);
				for (let ty = 0; ty < 5; ty++) { const lm = tab[o + ty]; if (lm !== NONE8) push(t, ty, lm - LO[ty], step); }
			}
		}
		bn[b] = 0;
		cur++;
	}
	return { labels, maxFin };
}

/**
 * The side-arrow and slot prices (n3 side-arrow-sideways, 2026-09-29): ORDERING only. The model keeps no horizontal
 * speed: it crosses side arrows against their push at any speed and enters a 1-tile-tall slot sideways from any height.
 * Two moves the engine makes only with what the model does not track get a price (`SA_COST` fifths more), never a cut:
 * the edge set is the plain model's, so the -1 set (the proof) is the same, and every finite cost stays finite.
 * (1) Arrows: a side arrow (1 / 411 left, 3 / 413 right, by the current tile) under horizontal gravity takes the input's
 * hold on x away, so a ball moving against its push only coasts on the speed it carried in, decelerating like a jump.
 * The engine's crossing table (a runway, k opposing arrows in a row, R held; src/out/n3/side-arrow-sideways crosstab.js,
 * test/reach.js K): the least entry speed that carries the centre past k tiles is 1.05 / 3.15 / 4.55 / 5.65 / 6.75 /
 * 7.5 px/tick for k = 1..6; the running speed tends to 6.78 and reaches 6.7 only after ~60 tiles of runway (Sentinel
 * Ravines' 34-tile runway: 6.15), so at running speed at most `SA_KRUN` (4) tiles are crossed. The price: a move with a
 * horizontal part against the push FROM a tile with 5+ opposing tiles still ahead in its row (itself included) TO a tile
 * with fewer (or out of the run): every crossing of 5+ tiles makes exactly one such move wherever the ball joined the
 * run (from the side, or dropped in from above with its speed), and a ball that joined 4 or fewer from the end pays
 * nothing. Exempt (the ball may carry more): runs that a fast flight from a speed source reaches (a side boost of the
 * move's direction: 16 px/tick, decaying toward 6.78, > 7.5 for ~75 tiles held; a portal exit: up to 16 x 1.42; an
 * arrow pushing the move's way: up to 13.55): its cone goes column by column the move's way, a row up or down at most
 * per column, through tiles that are not walls or killers, `SA_FEED_X` (80) columns (Crypts of Anubis: its route crosses
 * a 5-run at 8.9 px/tick, 41 columns and 9 rows past a side boost; a box of 40 x 10 missed it and priced every way).
 * (2) Slots: a tile with walls above and below fits the 16-px box only at py = 16 y exactly, which a ball under
 * vertical gravity has only on a floor (no auto-align: eesim.js aligns y only while no gravity pulls on y). The price: a
 * move with a horizontal part into such a slot from a tile that is not one (the ball enters from outside), unless the
 * source is a field that lets the ball hold its height (dots / side arrows / side boosts, climbables, liquids) or the
 * move is level and the source has a floor under it; never into a trophy.
 * opts.sideArrow (default on; EEAT_SIDEARROW=0 off = the plain model's prices), off for fields with opts.maxCost (a
 * price past the cap would cut). Returns {pen: Uint8Array over tile x 8 directions (1 = priced) or null, cost, info}.
 */
const SA_COST = 12500;   // fifths (2,500 tiles): behind a real way (a death is 1,638 tiles) and past the doctors' detours (<= 1,882)
const SA_KRUN = 4, SA_FEED_X = 80;
function sideArrowPrices(level, opts, M) {
	const env = process.env.EEAT_SIDEARROW;
	const mode = opts.sideArrow !== undefined ? (opts.sideArrow === true ? 'arrows' : opts.sideArrow || 'off') : env === '0' ? 'off' : env === 'all' ? 'all' : 'arrows';
	const on = mode !== 'off';
	const info = { on: on && !(opts.maxCost >= 0), mode, arrows: 0, runs: 0, fed: 0, slots: 0 };
	if (!info.on) return { pen: null, cost: 0, info };
	const { N, W, H, cls, curOf, passable, isFloor, fg, srcOf, trophy } = M;
	const gmx = level.gMox, nG = gmx ? gmx.length : 0;
	const push = new Int8Array(N);   // the side push of the tile (its current tile's): -1 left, 1 right
	let anyPush = false;
	for (let i = 0; i < N; i++) {
		if (cls[i] !== DOTS) continue;
		const j = curOf[i], id = j < 0 ? -1 : fg[j];
		if (id >= 0 && id < nG && gmx[id] !== 0) { push[i] = gmx[id] < 0 ? -1 : 1; anyPush = true; }
	}
	const slot = new Uint8Array(N);
	let anySlot = false;
	if (mode === 'all') for (let i = W; i < N - W; i++) if (passable(i) && cls[i - W] === WALL && cls[i + W] === WALL && !trophy(i)) { slot[i] = 1; anySlot = true; }
	if (!anyPush && !anySlot) return { pen: null, cost: 0, info };
	const pen = new Uint8Array(N * 8);
	const DXS = [-1, 0, 1, -1, 1, -1, 0, 1], DYS = [-1, -1, -1, 0, 0, 1, 1, 1];
	if (anyPush) {
		// rem[d][i]: opposing tiles from i on in direction d (0: right, against a left push; 1: left, against a right push)
		const rem = [new Uint16Array(N), new Uint16Array(N)], fed = [new Uint8Array(N), new Uint8Array(N)];
		const exitT = new Uint8Array(N);
		for (const e of srcOf.keys()) exitT[e] = 1;
		const source = (i, dx) => exitT[i] === 1 || push[i] === dx || fg[i] === (dx > 0 ? 115 : 114);
		// the fast flight's cone per direction: from every speed source, column by column the way it goes (a row up or down
		// at most per column: a jump rises ~4 rows over ~12 columns at that speed), through tiles that are not walls or
		// killers, at most SA_FEED_X columns (a boost's 16 px/tick decays to the 7.5 six tiles need in ~75 tiles, held)
		const cone = [new Uint8Array(N).fill(255), new Uint8Array(N).fill(255)];
		const flies = (i) => cls[i] !== WALL && cls[i] !== DEADLY;
		for (const d of [0, 1]) {
			const dx = d === 0 ? 1 : -1, cd = cone[d];
			for (let i = 0; i < N; i++) if (flies(i) && source(i, dx)) cd[i] = 0;
			for (let s = 0; s < W - 1; s++) {
				const x = d === 0 ? s : W - 1 - s, x2 = x + dx;
				for (let y = 0; y < H; y++) {
					const c0 = cd[y * W + x];
					if (c0 >= SA_FEED_X) continue;
					for (let dy = -1; dy <= 1; dy++) {
						const y2 = y + dy;
						if (y2 < 0 || y2 >= H) continue;
						const j = y2 * W + x2;
						if (flies(j) && c0 + 1 < cd[j]) cd[j] = c0 + 1;
					}
				}
			}
		}
		for (let y = 0; y < H; y++) {
			for (let x = W - 1; x >= 0; x--) { const i = y * W + x; rem[0][i] = push[i] === -1 ? 1 + (x + 1 < W ? rem[0][i + 1] : 0) : 0; }
			for (let x = 0; x < W; x++) { const i = y * W + x; rem[1][i] = push[i] === 1 ? 1 + (x > 0 ? rem[1][i - 1] : 0) : 0; }
			// the runs of SA_KRUN + 1 or more: fed when the fast flight's cone reaches a tile of them (the price is on the
			// move out of the run's end: a ball in the run with speed anywhere may make it)
			for (const d of [0, 1]) {
				const dx = d === 0 ? 1 : -1;
				for (let x = 0; x < W; x++) {
					const i = y * W + x;
					const start = d === 0 ? (x === 0 || push[i - 1] !== -1) : (x === W - 1 || push[i + 1] !== 1);
					if (!start || rem[d][i] <= SA_KRUN) continue;
					const len = rem[d][i];
					info.runs++;
					let f = false;
					for (let k = 0; k < len && !f; k++) if (cone[d][i + dx * k] <= SA_FEED_X) f = true;
					if (f) { info.fed++; for (let k = 0; k < len; k++) fed[d][i + dx * k] = 1; }
				}
			}
		}
		// (hard[d][i]: i is in a run of SA_KRUN + 1 or more opposing tiles of its row, not fed)
		const hard = [new Uint8Array(N), new Uint8Array(N)];
		for (let y = 0; y < H; y++) for (const d of [0, 1]) {
			const dx = d === 0 ? 1 : -1;
			for (let x = 0; x < W; x++) {
				const i = y * W + x;
				const start = d === 0 ? (x === 0 || push[i - 1] !== -1) : (x === W - 1 || push[i + 1] !== 1);
				if (!start || rem[d][i] <= SA_KRUN || fed[d][i]) continue;
				for (let k = 0; k < rem[d][i]; k++) hard[d][i + dx * k] = 1;
			}
		}
		for (let t = 0; t < N; t++) {
			if (push[t] === 0) continue;
			const d = push[t] === -1 ? 0 : 1, dx = d === 0 ? 1 : -1;
			if (!hard[d][t]) continue;
			const x = t % W, y = (t / W) | 0;
			for (let di = 0; di < 8; di++) {
				if (DXS[di] !== dx) continue;
				const x2 = x + dx, y2 = y + DYS[di];
				if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
				const t2 = y2 * W + x2;
				if (hard[d][t2]) continue;   // (still in a hard run: the move out of it pays)
				pen[t * 8 + di] = 1; info.arrows++;
			}
		}
	}
	if (anySlot) {
		const yField = (c) => c === DOTS || c === CLIMB || c === WATER || c === MUD;
		for (let t = 0; t < N; t++) {
			if (!passable(t) || slot[t] || yField(cls[t])) continue;
			const x = t % W, y = (t / W) | 0;
			for (let di = 0; di < 8; di++) {
				const dx = DXS[di], dy = DYS[di];
				if (dx === 0) continue;
				const x2 = x + dx, y2 = y + dy;
				if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
				const t2 = y2 * W + x2;
				if (!slot[t2]) continue;
				if (dy === 0 && isFloor(t + W)) continue;
				if (!pen[t * 8 + di]) { pen[t * 8 + di] = 1; info.slots++; }
			}
		}
	}
	if (!info.arrows && !info.slots) return { pen: null, cost: 0, info };
	return { pen, cost: SA_COST, info };
}
/**
 * The field transit tables (the n3 rise-exit-apex fix, 2026-09-29): ORDERING only. The model's C state kept the speed a
 * ball came into a field with, row after row (vfieldP never lowers it), and a ball that left a field over its top edge
 * into the air beside a field column was an R state, which the next field entry prices at RaInv(apex + 16) (a ball
 * anywhere in the row): field -> air -> field went up a column and the air beside it at a gain every row (Happy
 * Spookaween: a jump lifted 24 rows by a 6-tile chain; Barrel Cannon Canyon: a dot rail to 16 px/tick; Cold World: a
 * jump through 4 rows of water and a one-way row; the engine: 200 of 200 rollouts bob under the one-way). With the tables
 * (src/exitapex.json, measured by tools/exitapex.js with the engine's own ticks: per field class, the speed at a row's
 * top edge from a speed at its bottom edge (up) or anywhere in it (in), and the apex over its top edge (exit); a
 * climbable's tick takes x 0.888 of the speed, water's x 0.934, mud's x 0.886) the C levels follow them (the least of
 * the model's bound and the table), and a ball out over a field's top edge into a normal tile of a row with a field
 * is an XR state (at most its own speed; and so on up the air of such rows). Not a proof (a ball whose centre only
 * grazes a field tile between two tick starts has none of its drag), so never in the RCH3 field of the searches' prune:
 * opts.exitApex true / false; unset, only the ordering fields (opts.oneWayEntry: src/steer.js's bodies and legs) follow
 * EEAT_EXITAPEX (1 on, 0 off; unset EXITAPEX_DEFAULT: OFF, opt-in until the product A/B).
 */
const EXITAPEX_DEFAULT = false;
function exitApexOn(opts) {
	if (opts.exitApex !== undefined) return opts.exitApex === true;
	if (!opts.oneWayEntry) return false;
	const env = process.env.EEAT_EXITAPEX;
	return env === '1' ? true : env === '0' ? false : EXITAPEX_DEFAULT;
}
let XA_TAB;
function exitApexTab() {
	if (XA_TAB === undefined) { try { XA_TAB = require('./exitapex.json'); } catch (e) { XA_TAB = null; } }
	return XA_TAB;
}
/** a row segment's tables: per C level the largest over its field classes (mask: bit c for class c); a class without a
 *  table: no limit (the model's own bound). On a level with ice (ice) a ball may carry slipperiness into a field, and the
 *  engine's ice drag branch then takes the place of the base drag for dots, arrows and the air after an exit (not for
 *  climbables, water or mud, whose drag comes first): there only those three classes' up / in tables, no exit table */
function segTablesOf(XA, mask, ice) {
	const up = new Int16Array(NL), inn = new Int16Array(NL), exit = new Float64Array(NL);
	if (!mask) return { up: up.fill(NL - 1), in: inn.fill(NL - 1), exit: exit.fill(Infinity) };
	if (ice) exit.fill(Infinity);
	for (let c = DOTS; c <= UP; c++) {
		if (!(mask & (1 << c))) continue;
		const k = ice && (c === DOTS || c === UP) ? null : XA.kinds[c];
		for (let i = 0; i < NL; i++) {
			const a = k ? k.up[i] : NL - 1, b = k ? k.in[i] : NL - 1, x = k ? k.exit[i] : Infinity;
			if (a > up[i]) up[i] = a;
			if (b > inn[i]) inn[i] = b;
			if (x > exit[i]) exit[i] = x;
		}
	}
	return { up, in: inn, exit };
}
const qOf = (e, Q) => Math.max(-1, Math.min(Q, Math.ceil((e + TOL) / 8)));
const bitLen = (v) => { let n = 0; while (v > 0) { n++; v = Math.floor(v / 2); } return n; };
function prioShiftOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] < DEATH_COST && a[i] > m) m = a[i]; return Math.max(0, bitLen(m) - 12); }
/** per block id: its most upward modifier_y as the delayed tile (input held where the engine lets it act) */
// ---- the ice's reach (opts.iceLocal): eesim.js sets _slippery = 2.0 on a tick whose current-below tile is ice, 0 on any
// other solid below, and -0.2 a tick otherwise (the double reaches 2.8e-16 after 10 steps: 11 slippery ticks after the
// last ice contact, docs/ee_math.md 1.5). So a ball can be slippery only within 11 ticks of an ice contact; a tick moves
// the centre at most 16.25 px an axis (endgame.js D_TICK), a portal hop moves it for free. ICE_REACH_TILES Chebyshev
// tiles (12 ticks x 16.25 px = 12.2 tiles, 2 tiles for the centre over the ice tile and the rounding) from every ice
// tile, walls ignored (they only shorten the way), portal hops chained: every tile a slippery ball's centre can be in
const ICE_LOCAL = process.env.EEAT_ICE_LOCAL === '1';
const ICE_REACH_TILES = 16;
// (opts.iceCaps / EEAT_ICE_CAPS=1: the boost and portal caps' ice only near ice; see rcT in reachField. RISE_TICKS: the
// longest rise from a portal exit (-16 x 1.42 px/tick, the most upward queue for 2 ticks, then air, the ice drag every
// tick: 72 ticks; a boost's -16: 55), a tick moving the centre <= 16.25 px an axis)
const ICE_CAPS = process.env.EEAT_ICE_CAPS === '1';
const RISE_TICKS = (() => { let s = -16 * 1.42, n = 0; while (s < 0 && n < 1000) { s = (s + (n < 2 ? MOD_STRONG : G)) * ICE_ND; n++; } return n + 2; })();
const RISE_TILES = Math.ceil(RISE_TICKS * 16.25 / 16) + 1;
function iceNearOf(level, W, H, N, radius = ICE_REACH_TILES, hops = true) {
	const fg = level.fg;
	const dist = new Int16Array(N).fill(-1);
	let cur = [];
	for (let i = 0; i < N; i++) if (fg[i] === ICE) { dist[i] = 0; cur.push(i); }
	const silent = level.portalsById && level.portalSlot ? silentPortals(level) : null;
	const exitsOf = (i) => {
		if (!hops || !silent || (fg[i] !== 242 && fg[i] !== 381)) return null;
		const s = level.portalSlot[i];
		if (s < 0 || silent[i]) return null;
		return level.portalsById.get(level.pTarget[s]) || null;
	};
	for (let d = 0; d <= radius && cur.length; d++) {
		const nxt = [];
		for (let k = 0; k < cur.length; k++) {
			const t = cur[k];
			const ex = exitsOf(t);   // (a hop: its exits at the same distance)
			if (ex) for (let q = 0; q < ex.n; q++) { const j = (ex.ys[q] >> 4) * W + (ex.xs[q] >> 4); if (j >= 0 && j < N && dist[j] < 0) { dist[j] = d; cur.push(j); } }
			if (d === radius) continue;
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (dist[j] < 0) { dist[j] = d + 1; nxt.push(j); }
			}
		}
		cur = nxt;
	}
	const near = new Uint8Array(N);
	for (let i = 0; i < N; i++) if (dist[i] >= 0) near[i] = 1;
	return near;
}
function modMinOf(level) {
	const n = level.flags.length, a = new Float64Array(n);
	for (let id = 0; id < n; id++) {
		const moy = level.gMoy[id], liquid = (level.flags[id] & F_LIQUID) !== 0;
		a[id] = (moy + (liquid || moy === 0.0 ? -1.0 : 0.0)) / MULT;
	}
	return a;
}
/**
 * unforceChains(W, H, forcedP, exits, srcOf): the forced portals (opts.portalForced) that a ball a teleport put on a
 * portal exit can still walk over, cleared: it keeps lastPortal over every portal tile it moves on to (eesim.js
 * processPortals), so the portal tiles 4-connected to an exit through portal tiles are walked, not forced. Good Egg's
 * pocket columns x = 1 and x = 3 (exits such as (1, 197) next to portals such as (1, 196)): forced, the pocket coins
 * (1, 190), (3, 177), (3, 155) were out of reach in the steer field, which had no value and no coin plan for coins 0-8
 * (the n2-int gate study, 2026-09-28)
 */
function unforceChains(W, H, forcedP, exits, srcOf) {
	const N = W * H, isP = (t) => exits.has(t) || srcOf.has(t);
	const q = [...srcOf.keys()], seen = new Uint8Array(N);
	for (const j of q) seen[j] = 1;
	while (q.length) {
		const t = q.pop();
		forcedP[t] = 0;
		const x = t % W, y = (t / W) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const x2 = x + dx, y2 = y + dy;
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const u = y2 * W + x2;
			if (!seen[u] && isP(u)) { seen[u] = 1; q.push(u); }
		}
	}
}
/**
 * silentPortals(level): Uint8Array over the tiles, 1 = a portal tile (242 / 381 with a slot) EE never teleports from, so
 * every guidance builder gives it no exits (exact, never a prune: the engine has no such edge). eesim.js processPortals
 * (Player.as:1087): a tick that starts on a portal teleports only when lastPortal is clear, and clears it on any other
 * tile or on a portal whose target is its own id. (1) SELF-TARGET: pTarget === pId clears lastPortal: never a teleport
 * (Christmas Tree Quest: 611 id-0 portals wired together, one 5 tiles from the trophy; Desolate Relics: a 1,514-tile fake
 * shortcut). (2) SEALED CLUSTER: the portal tiles 8-connected to each other, none self-target, none a spawn, every tile
 * around them in the world and a static wall (solid, no door / one-way / half block, by the engine's level.flags: a subset
 * of guideFlags' walls, so at most as many marks):
 * the ball's centre can be there only after a teleport put it there (lastPortal set; no walk in: walls all around), it
 * can never leave (walls), and moving between portal tiles keeps lastPortal set: it never teleports again (a sealed exit
 * read lower than the start through the exits of its own id). Deaths there (timed effects) are the fields' own edges.
 */
const silentCache = new WeakMap();
function silentPortals(level) {
	if (silentCache.has(level)) return silentCache.get(level);
	const W = level.width, H = level.height, N = W * H, fg = level.fg, flags = level.flags, nFlags = flags ? flags.length : 0;
	const out = new Uint8Array(N);
	if (!level.portalSlot || !level.pTarget) { silentCache.set(level, out); return out; }
	const isP = (i) => (fg[i] === 242 || fg[i] === 381) && level.portalSlot[i] >= 0;
	const isWallId = (id) => id >= 0 && id < nFlags && (flags[id] & F_SOLID) !== 0 && (flags[id] & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0;
	const spawn = new Uint8Array(N);
	if (level.spawnsX) for (let k = 0; k < level.spawnsX.length; k++) { const j = level.spawnsY[k] * W + level.spawnsX[k]; if (j >= 0 && j < N) spawn[j] = 1; }
	if (!level.spawnsX || level.spawnsX.length === 0) { if (W > 1 && H > 1) spawn[W + 1] = 1; }   // (no spawn: eesim places the ball at (1, 1))
	const seen = new Uint8Array(N);
	for (let i0 = 0; i0 < N; i0++) {
		if (!isP(i0)) continue;
		const s0 = level.portalSlot[i0];
		if (level.pTarget[s0] === level.pId[s0]) { out[i0] = 1; continue; }
		if (seen[i0]) continue;
		// the cluster of non-self-target portal tiles (8-connected); sealed unless a tile around it is open or out of the world
		const cl = [i0], q = [i0];
		seen[i0] = 1;
		let sealed = true;
		while (q.length) {
			const t = q.pop(), x = t % W, y = (t / W) | 0;
			if (spawn[t]) sealed = false;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x2 = x + dx, y2 = y + dy;
				if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) { sealed = false; continue; }
				const u = y2 * W + x2;
				if (isP(u)) {
					const su = level.portalSlot[u];
					if (level.pTarget[su] === level.pId[su]) { sealed = false; continue; }   // (it clears lastPortal)
					if (!seen[u]) { seen[u] = 1; cl.push(u); q.push(u); }
				} else if (!isWallId(fg[u])) sealed = false;
			}
		}
		if (sealed) for (const t of cl) out[t] = 1;
	}
	silentCache.set(level, out);
	return out;
}
/**
 * THE HALF-BLOCK QUADRANTS (d4-portal-exact, 2026-09-29): which moves of the tile models the ball's 16 x 16 box can make
 * next to half blocks. EXACT (a necessary condition of the engine's movement, never a guess), so the RCH3 proof field
 * takes it too: its -1 set only grows where the box cannot pass.
 * A tile's quadrants (8 x 8 px): 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right; a plain wall all four, a half
 * block (F_HALF, the engine's rectHit by its stored rotation: 0 the right half, 1 the lower, 2 the left, 3 the upper) its
 * two, any other rotation none (the engine: a full solid; taken as open, which errs toward reachable), every other tile
 * none (doors, one-ways, coins: open; the model's walls are the engine's static walls). Out of the world: solid (the
 * engine's overlaps() is 1 there).
 * The engine moves the box 1 px at a time, x then y, with a collision test after each (eesim.js tick's loop; the
 * auto-align only moves the centre toward its own tile's middle, never across a boundary, and never onto a quadrant the
 * box did not already overlap), so the centre crosses tile edges one axis at a time. At a crossing of the vertical edge
 * x = 16 X (between columns X - 1 and X) in row Y, the boxes just before and after it (both collision-free) overlap
 * column X - 1's right quadrants and column X's left ones; in y the box overlaps row Y's upper quadrants always (the
 * centre is in row Y), and row Y's lower ones unless cy = 16 Y exactly, where it overlaps row Y - 1's lower ones
 * instead: hCross(X, Y) = upper free && (row Y lower free || row Y - 1 lower free). A crossing of y = 16 Y in column X
 * likewise: column X's left quadrants at the edge always, and column X's right ones unless cx = 16 X exactly, where
 * column X - 1's right ones: vCross(X, Y). A diagonal move of the tile models is two crossings through a side tile the
 * centre can be in (moveOK: via the horizontal neighbour or the vertical one); with only whole tiles this is the old
 * rule (a diagonal closed between two walls), so a level without half blocks gets the same fields byte for byte.
 * What it closes, e.g.: a right half block's tile holds the centre only at cx = 16 X (its left edge), so it is entered
 * from below or above only where column X - 1's right quadrants are open there (NSFW Spring Relics: its capsule's portal
 * (10, 188) is reached only through (11, 188), a right half block over a shut team door: no way in, where the tile
 * models read the diagonal open and the capsule 1.4 tiles from the portal); from the right, never.
 * EEAT_HALFQUAD=0 (or opts.halfQuad === false): off, the fields as before.
 */
const halfQuadOn = (opts) => (opts && opts.halfQuad !== undefined ? !!opts.halfQuad : process.env.EEAT_HALFQUAD !== '0');
/** a tile's quadrant bits by the static geometry (flags: guideFlags; shut: never-open doors, walls) */
function quadOf(W, H, fg, flags, lk, shut) {
	const N = W * H, nF = flags.length, Q = new Uint8Array(N);
	let half = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i], f = id >= 0 && id < nF ? flags[id] : 0;
		if ((shut && shut[i]) || ((f & F_SOLID) !== 0 && (f & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0)) Q[i] = 15;
		else if ((f & F_HALF) !== 0) {
			const r = lk[i];
			Q[i] = r === 0 ? 10 : r === 1 ? 12 : r === 2 ? 5 : r === 3 ? 3 : 0;
			if (Q[i]) half = true;
		}
	}
	return { Q, half };
}
const QDX = [-1, 0, 1, -1, 1, -1, 0, 1], QDY = [-1, -1, -1, 0, 0, 1, 1, 1];
/** the move from tile (x, y) in direction di (QDX / QDY order) by the quadrants qa(x, y) (15 out of the world) and the
 *  tiles the centre can be in on the way, transit(x, y) (the side tile of a diagonal) */
function moveOK(qa, transit, x, y, di) {
	const dx = QDX[di], dy = QDY[di];
	const hC = (X, Y) => { const L = qa(X - 1, Y), R = qa(X, Y); if ((L & 2) || (R & 1)) return false; if (!(L & 8) && !(R & 4)) return true; return !(qa(X - 1, Y - 1) & 8) && !(qa(X, Y - 1) & 4); };
	const vC = (X, Y) => { const U = qa(X, Y - 1), D = qa(X, Y); if ((U & 4) || (D & 1)) return false; if (!(U & 8) && !(D & 2)) return true; return !(qa(X - 1, Y - 1) & 8) && !(qa(X - 1, Y) & 2); };
	const bx = dx > 0 ? x + 1 : x, by = dy > 0 ? y + 1 : y;
	if (dy === 0) return hC(bx, y);
	if (dx === 0) return vC(x, by);
	return (transit(x + dx, y) && hC(bx, y) && vC(x + dx, by)) || (transit(x, y + dy) && vC(x, by) && hC(bx, y + dy));
}
/** the quadrant rule's blocked moves: Uint8Array(N x 8) (1: the move from tile t in direction di closed), only where a
 *  half block is in the 5 x 5 tiles around (elsewhere the rule is the old one); null: no half block, or the knob off */
function moveBlocks(W, H, Qg, transitT) {
	if (!Qg.half) return null;
	const N = W * H, Q = Qg.Q, blk = new Uint8Array(N * 8);
	const qa = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 15 : Q[y * W + x]);
	const tr = (x, y) => x >= 0 && y >= 0 && x < W && y < H && transitT(y * W + x);
	const near = new Uint8Array(N);   // a half block within 2 tiles
	for (let i = 0; i < N; i++) {
		const q = Q[i];
		if (q === 0 || q === 15) continue;
		const x = i % W, y = (i / W) | 0;
		for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) near[yy * W + xx] = 1;
	}
	let n = 0;
	for (let t = 0; t < N; t++) {
		if (!near[t]) continue;
		const x = t % W, y = (t / W) | 0;
		for (let di = 0; di < 8; di++) {
			const x2 = x + QDX[di], y2 = y + QDY[di];
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			if (!moveOK(qa, tr, x, y, di)) { blk[t * 8 + di] = 1; n++; }
		}
	}
	return n ? blk : null;
}
/** walking distance in fifths to the goals (8-way, a diagonal step closed only between two walls; portals; deaths:
 *  {respawn, src} or null, every source DEATH_COST more than the nearest respawn tile; blk: the half-block quadrants'
 *  closed moves, moveBlocks, or null) */
function walkField(W, H, cls, passable, trophy, goalF, portalExits, deaths, maxF, forcedP, blk) {
	const N = W * H, dist = new Uint16Array(N).fill(CUT);
	const d = new Float64Array(N).fill(Infinity);
	const heap = [];
	const hpush = (i, v) => { heap.push([v, i]); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= v) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
	const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
	if (goalF) for (const [i, c] of goalF) { if (c < d[i]) { d[i] = c; hpush(i, c); } }
	else for (let i = 0; i < N; i++) if (trophy(i)) { d[i] = 0; hpush(i, 0); }
	const srcOf = new Map();
	for (const [p, ex] of portalExits) for (const e of ex) { if (!srcOf.has(e)) srcOf.set(e, []); srcOf.get(e).push(p); }
	let resp = deaths ? new Set(deaths.respawn) : null;
	while (heap.length) {
		const [v, t2] = hpop();
		if (v > d[t2] || v > maxF) continue;
		const x2 = t2 % W, y2 = (t2 / W) | 0;
		const relax = (t, c) => { if (c < d[t]) { d[t] = c; hpush(t, c); } };
		if (srcOf.has(t2)) for (const p of srcOf.get(t2)) relax(p, v + 5);
		if (resp && resp.has(t2)) { resp = null; for (const i of deaths.src) relax(i, v + DEATH_COST); }   // (the nearest respawn tile)
		// the tiles that move into t2 (a deadly t2 too: the ball moves in and dies; a deadly tile itself is left only by dying)
		for (let di = 0; di < 8; di++) {
			const dx = QDX[di], dy = QDY[di];
			const x = x2 - dx, y = y2 - dy;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const t = y * W + x;
			if (!passable(t) || (forcedP && forcedP[t])) continue;
			if (dx && dy && cls[y * W + x2] === WALL && cls[y2 * W + x] === WALL) continue;
			if (blk && blk[t * 8 + di]) continue;
			relax(t, v + (dx && dy ? 7 : 5));
		}
	}
	for (let i = 0; i < N; i++) if (d[i] !== Infinity && d[i] <= maxF) dist[i] = d[i] > FAR ? FAR : d[i];
	return dist;
}

// ---------------------------------------------------------------- the lookup
const ICE_STEP = 0.2;
const nIceOf = (slip) => (slip > 0 ? Math.round(slip / ICE_STEP) : 0);
/** the C level (or XR level) of a ball rising at speed_y vy (< 0) with its centre at cy, in a row whose top edge is at
 *  top, pushed (up to) by segment s: the queued ticks, then the push left in the row (an energy bound) */
function cLevel(f, top, s, cy, vy, m0, m1, nIce) {
	const push = f.segPush[s], cap = f.segCap[s];
	const mField = -push / 32;
	let v = vy, y = cy, umax = 0;
	const n = nIce > 2 ? nIce : 2;
	for (let j = 1; j <= n; j++) {
		v = vstep(v, j === 1 ? m0 : j === 2 ? m1 : mField, j <= nIce ? ICE_ND : BD);
		y += v;
		if (-v > umax) umax = -v;
	}
	const u = v < 0 ? -v : 0, d = y - top;
	const E2 = u * u + (d > 0 ? push * d / 16 : 0);
	let w = Math.sqrt(E2);
	if (w > cap) w = cap;
	if (u > w) w = u;
	if (umax > w) w = umax;
	return cOfV(w);
}
/**
 * The ball's abstract state: {t, base: [type, level] | null, rise: [[type, level], ...] | null} (null: out of range).
 * The cost is base's, or with `rise` (the ball rises, or its gravity queue will lift it): max over the rise states (each
 * a valid description on its own: the ball can reach only what all of them reach), and for a ball not rising yet the
 * min of that and base (it may also just fall). A ball under a wall rises to the ceiling only.
 */
function stateOf(f, px, py, vy, q0, q1, slip) {
	const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
	if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return null;
	const t = ty * f.W + tx, g = f.cls[t];
	if (f.mode === 'walk' || g === WALL) return { t, base: null, rise: null };
	if (g === DEADLY) return { t, base: f.deaths ? [F_, 0] : null, rise: null };
	if (g === BUP) return { t, base: [R_, f.Q + 1], rise: null };
	if (g === BDOWN) return { t, base: [F_, KF], rise: null };
	const mm = f.modMin, nF = mm.length;
	const m0 = q0 >= 0 && q0 < nF ? mm[q0] : MOD_STRONG, m1 = q1 >= 0 && q1 < nF ? mm[q1] : MOD_STRONG;
	const nIce = f.ice ? nIceOf(slip) : 0;
	const cy = py + 8, top = 16 * ty;
	// the fall potential: the ice ticks, then D(v) + the px to the tile's bottom edge
	let v = vy, y = cy;
	for (let j = 1; j <= nIce; j++) { v = vstep(v, G, ICE_ND); y += v; }
	const k = kOfX(fallD(v > 0 ? v : 0) + (top + 16 - y));
	if (g !== NORM) return { t, base: vy < 0 ? [C_, cLevel(f, top, f.seg[t], cy, vy, m0, m1, nIce)] : [F_, k], rise: null };
	const base = vy < 0 ? null : cy > top + 8 ? [L_, k] : [F_, k];
	const rise = riseQ(vy, m0, m1, nIce);
	if (vy >= 0 && !(rise > 0)) return { t, base, rise: null };
	const ceil = ty === 0 || f.cls[t - f.W] === WALL;
	let q = qOf(top - (cy - rise), f.Q);
	if (ceil && q > 0) q = 0;
	const r = [[R_, q]];
	if (f.rowX[t] >= 0) r.push([X_, ceil ? cLevel(f, top, f.seg[t], Math.min(cy, top + 8), 0, m0, m1, nIce) : cLevel(f, top, f.seg[t], cy, vy, m0, m1, nIce)]);
	return { t, base, rise: r };
}
function costOfState(f, t, ty, l) {
	if (ty === R_) return f.costR[t * (f.Q + 3) + l + 1];
	if (ty === F_) return f.costF[t * (KF + 1) + l];
	if (ty === L_) return f.costL[t * (KF + 1) + l];
	if (ty === C_) { const r = f.rowC[t]; return r < 0 ? CUT : f.costC[r * NL + l]; }
	const r = f.rowX[t]; return r < 0 ? CUT : f.costX[r * NL + l];
}
/** the cost (fifths) of a ball: top-left px, py; speed_y vy; the gravity queue q0, q1 (block ids; -1 = unknown: the
 *  strongest pull); slippery. -1 = cut off. The same numbers as native/beam.h reachFifths. stateOf's cases without
 *  its objects (the one search looks this up at every simulated tick, and the arrays stateOf makes per call were a
 *  third of the lookup's time): the same float operations in the same order and the same Math.max / Math.min, so the
 *  same results as fifthsAtRef (test/fastpath.js checks both along random runs) */
function fifthsAt(f, px, py, vy, q0, q1, slip) {
	const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
	if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return -1;
	if (f.mode === 'walk') { const w = f.walk[ty * f.W + tx]; return w === CUT ? -1 : w; }
	const t = ty * f.W + tx, g = f.cls[t];
	let v;
	if (g === WALL) return -1;
	if (g === DEADLY) { if (!f.deaths) return -1; v = costOfState(f, t, F_, 0); return v === CUT ? -1 : v; }
	if (g === BUP) { v = costOfState(f, t, R_, f.Q + 1); return v === CUT ? -1 : v; }
	if (g === BDOWN) { v = costOfState(f, t, F_, KF); return v === CUT ? -1 : v; }
	const mm = f.modMin, nF = mm.length;
	const m0 = q0 >= 0 && q0 < nF ? mm[q0] : MOD_STRONG, m1 = q1 >= 0 && q1 < nF ? mm[q1] : MOD_STRONG;
	const nIce = f.ice ? nIceOf(slip) : 0;
	const cy = py + 8, top = 16 * ty;
	// (the fall potential: the ice ticks, then D(v) + the px to the tile's bottom edge)
	let vv = vy, y = cy;
	for (let j = 1; j <= nIce; j++) { vv = vstep(vv, G, ICE_ND); y += vv; }
	const k = kOfX(fallD(vv > 0 ? vv : 0) + (top + 16 - y));
	if (g !== NORM) { v = vy < 0 ? costOfState(f, t, C_, cLevel(f, top, f.seg[t], cy, vy, m0, m1, nIce)) : costOfState(f, t, F_, k); return v === CUT ? -1 : v; }
	const baseTy = cy > top + 8 ? L_ : F_;
	const rise = riseQ(vy, m0, m1, nIce);
	if (vy >= 0 && !(rise > 0)) { v = costOfState(f, t, baseTy, k); return v === CUT ? -1 : v; }
	const ceil = ty === 0 || f.cls[t - f.W] === WALL;
	let q = qOf(top - (cy - rise), f.Q);
	if (ceil && q > 0) q = 0;
	// (the rise states' max from 0, then the min with the base when the ball is not rising: stateOf's order)
	v = Math.max(0, costOfState(f, t, R_, q));
	if (f.rowX[t] >= 0) v = Math.max(v, costOfState(f, t, X_, ceil ? cLevel(f, top, f.seg[t], Math.min(cy, top + 8), 0, m0, m1, nIce) : cLevel(f, top, f.seg[t], cy, vy, m0, m1, nIce)));
	if (!(vy < 0)) v = Math.min(v, costOfState(f, t, baseTy, k));
	return v === CUT ? -1 : v;
}
/** fifthsAt through stateOf's objects (the reference the allocation-free fifthsAt is checked against) */
function fifthsAtRef(f, px, py, vy, q0, q1, slip) {
	if (f.mode === 'walk') {
		const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
		if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return -1;
		const v = f.walk[ty * f.W + tx];
		return v === CUT ? -1 : v;
	}
	const s = stateOf(f, px, py, vy, q0, q1, slip);
	if (!s) return -1;
	let v = CUT;
	if (s.rise) { v = 0; for (const [ty, l] of s.rise) v = Math.max(v, costOfState(f, s.t, ty, l)); }
	if (s.base) { const b = costOfState(f, s.t, s.base[0], s.base[1]); v = s.rise ? Math.min(v, b) : b; }
	return v === CUT ? -1 : v;
}
/** the beam's score (native/beam.h reachScore, the same doubles, a float), tiles: the cost blended bilinearly between the
 *  centres of the 4 tiles around the ball's centre, the ball (its speed and gravity queue) looked up at each of them
 *  (cut-off ones left out, and on a field with deaths the ways through one while the ball's own way is a real one: without
 *  death edges, e.g. the steer field's layer bodies, a cost of DEATH_COST or more is a real way), for a smooth gradient; the
 *  own tile's cost when all the others are left out. -1: the ball is cut off. */
function scoreAt(f, px, py, vy, q0, q1, slip) {
	const own = fifthsAt(f, px, py, vy, q0, q1, slip);
	if (own < 0) return -1;
	const tx = Math.trunc(px + 8.0) >> 4, ty = Math.trunc(py + 8.0) >> 4;
	const fx = (px + 8.0) / 16.0 - 0.5, fy = (py + 8.0) / 16.0 - 0.5;
	const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
	let v = 0, w = 0;
	for (let dy = 0; dy < 2; dy++) {
		for (let dx = 0; dx < 2; dx++) {
			const x = x0 + dx, y = y0 + dy;
			const c = x === tx && y === ty ? own : fifthsAt(f, px + 16.0 * (x - tx), py + 16.0 * (y - ty), vy, q0, q1, slip);
			if (c < 0 || (f.deaths && c >= DEATH_COST && own < DEATH_COST)) continue;
			const k = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
			v += k * c;
			w += k;
		}
	}
	return Math.fround(w > 1e-9 ? v / w / 5.0 : own / 5.0);
}
/** the cost to the trophy in tiles (-1 = cut off): costAt(field, sim), or costAt(field, px, py, vy, onGround) with the
 *  gravity queue unknown (taken as the strongest pull) */
function costAt(f, a, py, vy) {
	// (an effect-state field, opts.fxState: a ball in another state is priced by the field's walk; in its own state by the
	// physics part, an airborne ball's air jumps left (mj - jump_count: the engine counts the ground jump as spent once the
	// ball is off the ground) looked up as that much more rise; where the physics part has no way, the walk + FX_FAR: its -1
	// is no proof (ordering only), the walk's is)
	if (f.fx && typeof a === 'object' && a !== null) {
		const tx = Math.trunc(a.px + 8) >> 4, ty = Math.trunc(a.py + 8) >> 4;
		if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return -1;
		const w = f.walk[ty * f.W + tx];
		if (w === CUT) return -1;
		const s = fxStateOf(a);
		if (s === null || s.mj !== f.fx.mj || s.jb !== f.fx.jb) {
			// (another state the field models: that state's field, made on first use by the builder the caller left on f,
			// f.fxOf (types.js goalField, the executor's ordering fields); else the walk)
			if (s !== null && typeof f.fxOf === 'function') {
				const g = f.fxOf(s);
				if (g && g.fx && g.fx.mj === s.mj && g.fx.jb === s.jb) return costAt(g, a);
			}
			return w / 5;
		}
		let vy = a.speed_y;
		const left = s.mj >= 2 && a.jump_count > 0 ? s.mj - a.jump_count : 0;
		if (left > 0) {
			const jv = JV * (s.jb === 1 ? 1.3 : s.jb === 2 ? 0.75 : 1);
			vy = -RaInv(riseQ(vy, G, G, 0) + left * riseQ(jv, G, G, 0));
		}
		const v = fifthsAt(f, a.px, a.py, vy, a._q0, a._q1, a._slippery);
		return v < 0 ? Math.min(FAR, w + FX_FAR * 5) / 5 : v / 5;
	}
	// (a plain-ball field, opts.plainFx: a ball with an effect on is priced by the field's walk, the walk mode's lookup: the
	// physics part holds for a plain ball only)
	if (f.plainFx === true && typeof a === 'object' && a !== null && !(a.has_levitation === false && a.flip_gravity === 0 && a.max_jumps === 1 && a.jump_boost === 0 && a.speed_boost === 0 && !a.low_gravity)) {
		const tx = Math.trunc(a.px + 8) >> 4, ty = Math.trunc(a.py + 8) >> 4;
		if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return -1;
		const w = f.walk[ty * f.W + tx];
		return w === CUT ? -1 : w / 5;
	}
	const v = typeof a === 'object' && a !== null ? fifthsAt(f, a.px, a.py, a.speed_y, a._q0, a._q1, a._slippery) : fifthsAt(f, a, py, vy, -1, -1, f.ice ? 2 : 0);
	return v < 0 ? -1 : v / 5;
}
/** debugging: the ball's abstract state and cost */
function stateAt(f, sim) {
	const s = stateOf(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
	const nm = ([ty, l]) => `${'RFXCL'[ty]}${l}`;
	return s ? { tile: [s.t % f.W, (s.t / f.W) | 0], cls: f.cls[s.t], base: s.base ? nm(s.base) : null, rise: s.rise ? s.rise.map(nm).join('&') : null, fifths: fifthsAt(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery) } : null;
}

// ---------------------------------------------------------------- the file for eegpu
/**
 * RCH3: the header (64 bytes): 'RCH3', int32 version 3, W, H, mode (0 physics, 1 walk), Q, prioShift, flags (1 deaths,
 * 2 ice), nC (field tiles), nX (xrOK tiles), nSeg, nFlags, NFV, NTH, the level's fingerprint (u32 lo, hi: gpu.js
 * blobFp of its blob; 0 0 = not given: eegpu prove then does not use the field); f64 constants (16): G, BD, ICE_ND, K_T, TOL,
 * MOD_STRONG, 0...; then (each 8-aligned): u8 cls[N], u8 seg[N], i32 rowC[N], i32 rowX[N], u16 walk[N], u16 costR[N x
 * (Q + 3)], costF[N x 17], costL[N x 17], costC[nC x 128], costX[nX x 128] (walk mode: none of the cost tables), f64 segPush[nSeg],
 * segCap[nSeg], modMin[nFlags], FV[NFV], FS[NFV], TH[NTH], SW[NTH].
 */
function writeReachFile(f, file, levelFp) {
	if (f.toGoals) throw new Error('writeReachFile: a field to goals (explore --hunt) is not a cost to the trophy');
	fs.writeFileSync(file, reachFileBytes(f, levelFp));
}
function reachFileBytes(f, levelFp) {
	const N = f.W * f.H, walk = f.mode === 'walk';
	const Q = walk ? 0 : f.Q;
	const al = (n) => (n + 7) & ~7;
	const parts = [];
	const u8 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
	const empty8 = new Uint8Array(N), emptyI = new Int32Array(N).fill(-1);
	const arrays = [u8(f.cls), u8(walk ? empty8 : f.seg), u8(walk ? emptyI : f.rowC), u8(walk ? emptyI : f.rowX), u8(f.walk)];
	if (!walk) arrays.push(u8(f.costR), u8(f.costF), u8(f.costL), u8(f.costC), u8(f.costX));
	const nSeg = walk ? 1 : f.segPush.length, nFl = walk ? 1 : f.modMin.length;
	const dbl = walk ? [new Float64Array(1), new Float64Array(1), new Float64Array(1)] : [f.segPush, f.segCap, f.modMin];
	for (const a of [...dbl, FVa, FSa, TH, SW]) arrays.push(u8(a));
	let size = 64 + 128;
	for (const a of arrays) size = al(size) + a.length;
	const buf = Buffer.alloc(al(size));
	buf.write('RCH3', 0, 'latin1');
	const ints = [3, f.W, f.H, walk ? 1 : 0, Q, f.prioShift || 0, (f.deaths ? 1 : 0) | (f.ice ? 2 : 0), walk ? 0 : f.nC, walk ? 0 : f.nX, nSeg, nFl, NFV, NTH];
	ints.forEach((v, k) => buf.writeInt32LE(v, 4 + 4 * k));
	if (levelFp) { buf.writeUInt32LE(levelFp[0] >>> 0, 56); buf.writeUInt32LE(levelFp[1] >>> 0, 60); }
	[G, BD, ICE_ND, K_T, TOL, MOD_STRONG].forEach((v, k) => buf.writeDoubleLE(v, 64 + 8 * k));
	let o = 64 + 128;
	for (const a of arrays) { o = al(o); a.copy(buf, o); o += a.length; }
	return buf;
}

/** the field's typed arrays in shared memory (worker threads read them without a copy each) */
function shareField(f) {
	const out = Object.assign({}, f);
	for (const k of Object.keys(f)) {
		const a = f[k];
		if (ArrayBuffer.isView(a) && !(a.buffer instanceof SharedArrayBuffer)) { const s = new a.constructor(new SharedArrayBuffer(a.byteLength)); s.set(a); out[k] = s; }
	}
	return out;
}

module.exports = {
	VERSION: 3, reachField, fxStateOf, fxStateNext, fxChanges, fxAfter, FX_FAR, neverOpenDoors, guideFlags, classOfId, exitApexOn, ALWAYS_SHUT, unforceChains, silentPortals, halfQuadOn, quadOf, moveOK, moveBlocks, QDX, QDY, fifthsAt, fifthsAtRef, scoreAt, costAt, stateAt, stateOf, writeReachFile, reachFileBytes, shareField, DEATH_COST, DEATH_TILES: DEATH_COST / 5, PROT_COST,
	// the tables and the lookup's pieces (tests)
	riseQ, airRise, fallD, fallV, kOfX, cOfV, qOf, interp, RaInv, TABLES, VF, VFC, KLJ, NFV, NTH, FVa, FSa, VTURN, RISE_TILES, iceNearOf,
	G, BD, JV, K_T, TOL, QMAX, KF, NL, CUT, FAR, R_, F_, X_, C_,
	WALL, DEADLY, NORM, DOTS, CLIMB, WATER, MUD, UP, BUP, BDOWN, A_CLASS, CAP_CLASS,
	// v2 names (src/out scripts): the classes
	C_SOLID: WALL, C_DEADLY: DEADLY, C_NORMAL: NORM, C_UP: UP, C_BOOSTUP: BUP,
};
