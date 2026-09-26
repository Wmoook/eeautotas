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
//   tiles at their own costs, not the trophy; states above maxCost stay -1, which is then no proof).
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
const KF = 16, NL = 128;                      // F levels 0..16; C / XR levels 0..127
const R_ = 0, F_ = 1, X_ = 2, C_ = 3, L_ = 4, NT = 5;
const NONE = -32768, NONE8 = -128;
const CUT = 0xffff, FAR = 0xfffe;             // cost table: cut off; finite but saturated
// a death (the respawn at a checkpoint or another spawn): finite, so no proof is lost, but priced far beyond any real
// way (fifths: 1638 tiles), so the searches (which drop dead balls) never head for a spike because a checkpoint is near
const DEATH_COST = 8192;
// tile classes
const WALL = 0, DEADLY = 1, NORM = 2, DOTS = 3, CLIMB = 4, WATER = 5, MUD = 6, UP = 7, BUP = 8, BDOWN = 9;
const isField = (c) => c >= DOTS && c <= UP;
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64;
const X_NONROT_HALF = 4;
const TROPHY = 121, CHECKPOINT = 360, PROTECTION = 420, ICE = 1064, CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
// effects that change jumps, speeds or gravity: walk mode (417 jump, 418 fly, 419 speed, 453 low gravity, 461
// multijump, 1517 gravity)
const WILD = new Set([417, 418, 419, 453, 461, 1517]);
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

// ---------------------------------------------------------------- the field
function reachField(level, opts) {
	opts = opts || {};
	const t0 = Date.now();
	const W = level.width, H = level.height, N = W * H;
	const fg = level.fg, flags = level.flags, nFlags = flags.length, gF = level.gFlags, gMox = level.gMox, gMoy = level.gMoy, lk = level.lookup0, xfl = level.xflags;
	const fl = (id) => (id >= 0 && id < nFlags ? flags[id] : 0);
	let wild = !(level.gravityMult === 1), protect = false, ice = false, anyField = false, anyPortal = false, checkpoints = false, timed = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (WILD.has(id)) wild = true;
		if (id === PROTECTION) protect = true;
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
	const gclass = (id) => {
		if (id < 0 || id >= nFlags) return NORM;
		if ((flags[id] & F_CLIMB) !== 0) return CLIMB;
		if (id === 116) return BUP;
		if (id === 117) return BDOWN;
		if (id === 119) return WATER;
		if (id === 369 || id === 416) return MUD;
		if (gMox[id] !== 0 || id === 4 || id === 414 || id === 114 || id === 115) return DOTS;
		if (gMoy[id] < 0) return UP;
		return NORM;
	};
	const cls = new Uint8Array(N), sp = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const hr = hgeo(i);
		if (isWallId(id) || hr === 2 || hr === 3) { cls[i] = WALL; continue; }
		if (!protect && id >= 0 && id < nFlags && (gF[id] & 4) !== 0) { cls[i] = DEADLY; continue; }
		if (hr === 1) sp[i] = LOWER; else if (hr === 0) sp[i] = RIGHT;
		const j = curOf[i];
		const c = j < 0 ? NORM : gclass(fg[j]);
		cls[i] = c;
		if (isField(c) || c === BUP || c === BDOWN) anyField = true;
	}
	const passable = (i) => cls[i] !== WALL && cls[i] !== DEADLY;
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
	let deaths = (checkpoints || (level.spawnsX ? level.spawnsX.length : 0) >= 2) && respawn.length > 0;
	const dsrc = [];   // the tiles the ball can die in
	if (deaths) for (let i = 0; i < N; i++) if (cls[i] === DEADLY || (cls[i] !== WALL && (timed || kills(curOf[i]) || kills(i)))) dsrc.push(i);
	if (!dsrc.length) deaths = false;
	const dsrcT = new Uint8Array(N);
	if (deaths) for (const i of dsrc) dsrcT[i] = 1;
	// portals: exits (passable, or deadly with deaths) per portal tile
	const srcOf = new Map(), portalExits = new Map();
	if (level.portalSlot && level.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = level.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || !passable(i)) continue;
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
	const Q = anyField || anyPortal ? QMAX : QMIN, INF = Q + 1, NR = Q + 3;
	let mode = wild ? 'walk' : 'physics';
	if (mode === 'physics' && N * (Q + 20) * 2 > 128 * 1048576) mode = 'walk';
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
	const walk = walkField(W, H, cls, passable, trophy, goalF, portalExits, deaths ? { respawn, src: dsrc } : null, maxF);
	const base = { version: 3, W, H, N, mode, Q, B: Q, INF, ice, deaths, goals, toGoals: goalF !== null, cls, walk, mismatches: 0, KLJ };
	if (mode === 'walk') return Object.assign(base, { ms: Date.now() - t0, prioShift: prioShiftOf(walk), labels: 0 });

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
	const segKey = new Map(), segPush = [0], segCap = [0], segA = [0], segRd = [0];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W;) {
			const i0 = y * W + x;
			if (cls[i0] !== NORM && !isField(cls[i0])) { x++; continue; }
			let x1 = x, A = 0, cap = 0, rd = 0, any = false;
			while (x1 < W && (cls[y * W + x1] === NORM || isField(cls[y * W + x1]))) {
				const c = cls[y * W + x1];
				if (isField(c)) { any = true; A = Math.max(A, A_CLASS[c]); cap = Math.max(cap, CAP_CLASS[c]); if (c === UP || c === WATER) rd = 1; }
				x1++;
			}
			if (any) {
				const key = `${A}|${cap}|${rd}`;
				let s = segKey.get(key);
				if (s === undefined) { s = segPush.length; segKey.set(key, s); segPush.push(32 * A); segCap.push(cap); segA.push(A); segRd.push(rd); }
				if (s > 255) throw new Error('reach: too many segment kinds');
				for (let k = x; k < x1; k++) segOf[y * W + k] = s;
			}
			x = x1;
		}
	}
	const xrOK = (i) => cls[i] === NORM && segOf[i] !== 0;
	const nIce = ice ? 10 : 0;
	const mm0 = modMinOf(level), mm = (id) => (id >= 0 && id < mm0.length ? mm0[id] : G);
	const T = TABLES[ice ? 1 : 0];
	const KSTEP = ice ? 2 : 1;   // rows of fall potential per row fallen (ice: the ball may still fall with less drag)
	// the jump: from a floor under the centre's tile, a lower half block, or a ledge beside (the box overhangs it); the
	// gravity queue of the tick after the jump holds the current tile of the tick before it, anywhere in the 3 x 3 tiles
	// around (a neighbour that pulls up: up arrows, liquids, dots, climbables, and boosts, whose zero gravity lets up act):
	// the lookup's own table (modMin) of that tile's id
	const J = new Int8Array(N).fill(-128);
	const modCur = (n) => { const j = curOf[n]; return j < 0 ? G : mm(fg[j]); };
	for (let i = 0; i < N; i++) {
		if (cls[i] !== NORM) continue;
		if (i < W || cls[i - W] === WALL) continue;   // a ceiling right above: the jump bonks at once
		const x = i % W, y = (i / W) | 0;
		let m = G;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && ny >= 0 && nx < W && ny < H) m = Math.min(m, modCur(ny * W + nx));
		}
		const rj = riseQ(JV, m, G, nIce);
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
		if (e > -1e9) J[i] = qOf(e, Q);
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
	const KJD = Math.min(KF, kOfX(fallD(-JV) + 16) + (ice ? 1 : 0));

	// ---- per-tile profiles (what fwd reads), the model
	const profKey = new Map(), prof = [], pid = new Int32Array(N);
	for (let i = 0; i < N; i++) {
		const key = cls[i] * 1e7 + sp[i] * 1e6 + lowWall[i] * 1e5 + lj[i] * 1e4 + (xrOK(i) ? 1e3 : 0) + segOf[i];
		let p = profKey.get(key);
		if (p === undefined) {
			p = prof.length; profKey.set(key, p);
			const s = segOf[i];
			prof.push({ cls: cls[i], sp: sp[i], lowWall: lowWall[i], lj: lj[i], xrOK: xrOK(i) ? 1 : 0, push: segPush[s], cap: segCap[s], A: segA[s], rd: segRd[s] });
		}
		pid[i] = p;
	}
	const qOfQ = (e) => qOf(e, Q);
	const vfieldP = (P, v, h) => Math.max(v, Math.min(P.cap, Math.sqrt(v * v + P.push * h)));
	const Pexit = (P, v) => v + interp(P.rd ? T.RD : T.RC, v);          // a field's exit: the centre's apex above the row's top edge
	// (XR: its apex by the exit table of its row's fields: the queue holds one of them; the +v margin covers one tick of another
	// kind's pull left from the row below)
	const enterR = (P2, e, emit) => {
		const c = P2.cls;
		if (c === BUP) emit(R_, INF);
		else if (c === BDOWN) emit(F_, KF);
		else if (c === NORM || c === DEADLY) { const q = qOfQ(e); if (q >= 0 || !P2.lowWall) emit(R_, q); }
		else if (isField(c)) emit(C_, cOfV(vfieldP(P2, RaInv(e + 16), 1)));
	};
	const enterDown = (P2, k, emit) => {
		const c = P2.cls;
		if (c === BUP) emit(R_, INF);
		else if (c === BDOWN) emit(F_, KF);
		else emit(F_, Math.min(KF, k + KSTEP));
	};
	const ljump = (P, P2, k, emit) => { if (P.cls === NORM && P2.lj && k >= KLJ) emit(C_, cOfV(vfieldP(P2, -JV, 1))); };
	/** the forward model: a move from a tile of profile P to a neighbour of profile P2 by (dx, dy) of a state (ty, l) */
	function fwd(P, P2, dx, dy, ty, l, emit) {
		if ((P2.sp === LOWER && dy < 0) || (P.sp === LOWER && dy > 0) || (P2.sp === RIGHT && dx < 0) || (P.sp === RIGHT && dx > 0)) return;
		const src = P.cls, dst = P2.cls;
		if (ty === R_ && l === INF) {   // unlimited rise: anywhere up or sideways (and everything R(Q) does)
			fwd(P, P2, dx, dy, R_, Q, emit);
			if (dy === 1) enterDown(P2, KF, emit);
			else if (dst === BDOWN) emit(F_, KF);
			else emit(R_, INF);
			return;
		}
		if (src === BDOWN) { if (ty === F_) { if (dy === 1) enterDown(P2, l, emit); else if (dy === 0) emit(F_, l); } return; }
		if (ty === L_) {   // falling in the lower half of a normal row: never at standing height here
			if (src !== NORM && src !== BUP) return;
			if (dy === 0) { if (dst === BUP) emit(R_, INF); else if (dst === BDOWN) emit(F_, KF); else if (isField(dst)) emit(F_, l); else if (!P2.lowWall) emit(L_, l); }
			else if (dy === 1) { enterDown(P2, l, emit); ljump(P, P2, l, emit); }
			return;
		}
		if (ty === F_) {
			if (dy === 0) { if (dst === BUP) emit(R_, INF); else if (dst === BDOWN) emit(F_, KF); else emit(F_, l); }
			else if (dy === 1) { enterDown(P2, l, emit); ljump(P, P2, l, emit); }
			return;
		}
		if (src === NORM || src === BUP) {
			if (ty === C_) return;
			if (ty === X_) {
				const v = vOfC(l), e = Pexit(P, v), q = qOfQ(e);
				if (dy === 0) { if (isField(dst)) emit(C_, l); else if (dst === NORM && P2.xrOK) emit(X_, l); else enterR(P2, e, emit); }
				else if (dy === -1) { if (q >= 1) enterR(P2, e - 16, emit); }
				else { const kb = kOfX(e + 16); enterDown(P2, kb, emit); ljump(P, P2, kb, emit); }
				return;
			}
			// R(q)
			const e = 8 * l - TOL;
			if (dy === -1) { if (l >= 1) enterR(P2, e - 16, emit); }
			else if (dy === 0) enterR(P2, e, emit);
			else { const kb = kOfX(e + 16); enterDown(P2, kb, emit); ljump(P, P2, kb, emit); }
			return;
		}
		// a field: C(c) (down: through the same-tile edge C -> F(0))
		if (ty !== C_ || !isField(src)) return;
		const v = vOfC(l);
		if (dy === -1) {
			if (isField(dst)) emit(C_, cOfV(vfieldP(P2, Math.min(16, v + 2 * Math.max(0, P.A - P2.A)), 1)));   // (the queue: 2 ticks of the old pull)
			else enterR(P2, Pexit(P, v) - 16, emit);
		} else if (dy === 0) {
			if (isField(dst)) emit(C_, l);
			else if (dst === NORM && P2.xrOK) emit(X_, l);
			else enterR(P2, Pexit(P, v), emit);
		}
	}
	// ---- the stop in a field, the up-arrow bounce
	const stopC = (t) => cOfV(vfieldP(prof[pid[t]], 2 * G, lowWall[t] ? 0.5 : 1));
	const bounceC = (t, k) => { const P = prof[pid[t]], v = VFC[k]; return cOfV(Math.min(16, Math.sqrt(v * v + Math.max(P.push, 8 * G * v + 10 * G * G)))); };

	// ---- same-tile edges (cost 0) and the edges to other tiles (portals: cost 5; death respawns: DEATH_COST), forward
	/** the same-tile edges of (t, ty, l): emit(ty2, l2) */
	function sameTile(t, ty, l, emit) {
		const c = cls[t];
		if (c === NORM) {
			if (J[t] !== -128 && ((ty === R_ && l >= 0) || ty === F_ || ty === X_)) emit(R_, J[t]);   // stand, jump
			if ((ty === R_ && l >= 0) || ty === X_) emit(F_, 1);   // the apex (at or above the middle)
			if (ty === R_ && l === -1) emit(L_, 0);               // the apex in the lower half
			if (ty === F_) emit(L_, l);                           // (a falling ball may be in the lower half)
		} else if (isField(c)) {
			if (ty === F_) emit(C_, c === UP ? bounceC(t, l) : stopC(t));   // stop and rise / bounce
			if (ty === C_) emit(F_, 0);                                     // turn round
			if (ceilJ[t] && (ty === F_ || ty === C_)) emit(F_, KJD);         // the jump down from a ceiling in up arrows
		} else if (c === BDOWN) emit(F_, KF);
		else if (c === BUP) emit(R_, INF);
	}
	/** the edges of (t, ty, l) to other tiles: emit(t2, ty2, l2, cost). A death: the respawned ball stands still in the
	 *  respawn tile's middle, its gravity queue from where it died (a pull there lifts it a pixel or so: R(0), which the
	 *  lookup gives it; F(0) without one) */
	function crossEdges(t, ty, emit) {
		if (deaths && dsrcT[t] === 1) for (const r of respawn) { emit(r, F_, 0, DEATH_COST); if (cls[r] === NORM) emit(r, R_, 0, DEATH_COST); }
		if (cls[t] === DEADLY) return;
		if (ty !== C_ && portalExits.has(t)) for (const e of portalExits.get(t)) { emit(e, R_, INF, 5); emit(e, F_, KF, 5); }
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
	// ---- the backward label-setting search in cost buckets (integer costs; edges cost 0, 5 or 7)
	let seeds = [];
	if (goalF) seeds = [...goalF].sort((a, b) => a[1] - b[1]);
	else for (let i = 0; i < N; i++) if (trophy(i)) seeds.push([i, 0]);
	const srcP = new Uint8Array(N);
	for (let i = 0; i < N; i++) srcP[i] = passable(i) && fg[i] !== TROPHY ? 1 : 0;   // (move sources: the trophy ends the way)
	const stopT = new Int16Array(N).fill(-1);
	for (let i = 0; i < N; i++) if (isField(cls[i]) && cls[i] !== UP) stopT[i] = stopC(i);
	const bounceT = new Int16Array(N * (KF + 1));
	for (let i = 0; i < N; i++) if (cls[i] === UP) for (let k = 0; k <= KF; k++) bounceT[i * (KF + 1) + k] = bounceC(i, k);
	const respawnT = new Uint8Array(N);
	if (deaths) for (const r of respawn) respawnT[r] = cls[r] === NORM ? 2 : 1;   // (2: R(0) is a respawn state too)
	const srcList = new Array(N).fill(null);
	for (const [e, ps] of srcOf) srcList[e] = Int32Array.from(ps);
	const { labels, maxFin } = labelSearch({ N, W, H, NR, NL, KF, cls, J, ceilJ, KJD, pid, srcP, rowC, rowX, COST, NLV, LO, front, XB, CB, LB,
		invArr, invTable, nP, stopT, bounceT, srcList, respawnT, dsrc: Int32Array.from(deaths ? dsrc : []), seeds, maxF });
	const kinds = invArr.reduce((a, x) => a + (x !== null ? 1 : 0), 0);
	const field = Object.assign(base, { ms: 0, labels, kinds, profiles: nP, prioShift: 0, KJD,
		seg: segOf, segPush: Float64Array.from(segPush), segCap: Float64Array.from(segCap), rowC, rowX, costR, costF, costL, costC, costX, nC, nX,
		modMin: mm0 });
	field.prioShift = Math.max(0, bitLen(Math.min(maxFin, FAR)) - 12);
	const costOf = (t, ty, l) => { const s = slotOf(t, ty); if (s < 0) return CUT; return COST[ty][s * NLV[ty] + idxOf(ty, Math.max(LO[ty], Math.min(HI[ty], l)))]; };
	/** every edge out of (t, ty, l): emit(t2, ty2, l2, cost) */
	const edgesOf = (t, ty, l, emit) => {
		if (fg[t] === TROPHY) return;
		crossEdges(t, ty, emit);
		if (cls[t] === DEADLY) return;
		sameTile(t, ty, l, (ty2, l2) => emit(t, ty2, l2, 0));
		const x = t % W, y = (t / W) | 0;
		for (let di = 0; di < 8; di++) {
			const [dx, dy] = DIRS[di], x2 = x + dx, y2 = y + dy;
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const t2 = y2 * W + x2;
			if (!passable(t2) && !(deaths && cls[t2] === DEADLY)) continue;
			if (dx && dy && cls[y * W + x2] === WALL && cls[y2 * W + x] === WALL) continue;
			fwd(prof[pid[t]], prof[pid[t2]], dx, dy, ty, l, (ty2, l2) => emit(t2, ty2, l2, dx && dy ? 7 : 5));
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
	if (opts.debug) Object.defineProperty(field, '_m', { value: { fwd, prof, pid, J, lj, ceilJ, KJD, DIRS, stopC, bounceC, portalExits, respawn, passable, lowWall, segOf, edgesOf, costOf } });
	field.ms = Date.now() - t0;
	return field;
}
/**
 * The backward label-setting search (reachField's core, a function of its own so the engine optimizes it): labels
 * (tile, type, level index, cost) in increasing cost from cost buckets; a label below the (tile, type)'s front sets
 * the costs of the levels up to the old front, then the inverse edges push their sources. Same-tile edges (cost 0),
 * portals and deaths (5), moves (5, diagonal 7) through the inverse tables (S.invTable).
 */
function labelSearch(S) {
	const { N, W, H, NR, NL: L, cls, J, ceilJ, KJD, pid, srcP, rowC, rowX, COST, NLV, LO, front, XB, CB, LB, invArr, invTable, nP,
		stopT, bounceT, srcList, respawnT, dsrc, seeds, maxF } = S;
	const K1 = S.KF + 1;
	const NB = 8;
	const bk = [], bn = new Int32Array(NB);
	for (let b = 0; b < NB; b++) bk.push(new Int32Array(4096));
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
			} else if (c2 === BDOWN) { if (ty2 === F_) pushAllLow(t2, cur); }
			else if (c2 === BUP) { if (ty2 === R_) pushAllLow(t2, cur); }
			// portals: (portal tile, any but C) -> (exit, R(INF) and F(16))
			if ((ty2 === R_ || ty2 === F_) && srcList[t2] !== null) for (const p of srcList[t2]) { push(p, R_, 0, cur + 5); push(p, F_, 0, cur + 5); push(p, X_, 0, cur + 5); push(p, L_, 0, cur + 5); }
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
				const pt = pid[t];
				let tab = invArr[(pt * nP + pt2) * 8 + di];
				if (tab === null) tab = invTable(pt, pt2, di);
				const step = cur + (dx !== 0 && dy !== 0 ? 7 : 5);
				for (let ty = 0; ty < 5; ty++) { const lm = tab[o + ty]; if (lm !== NONE8) push(t, ty, lm - LO[ty], step); }
			}
		}
		bn[b] = 0;
		cur++;
	}
	return { labels, maxFin };
}

const qOf = (e, Q) => Math.max(-1, Math.min(Q, Math.ceil((e + TOL) / 8)));
const bitLen = (v) => { let n = 0; while (v > 0) { n++; v = Math.floor(v / 2); } return n; };
function prioShiftOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] < DEATH_COST && a[i] > m) m = a[i]; return Math.max(0, bitLen(m) - 12); }
/** per block id: its most upward modifier_y as the delayed tile (input held where the engine lets it act) */
function modMinOf(level) {
	const n = level.flags.length, a = new Float64Array(n);
	for (let id = 0; id < n; id++) {
		const moy = level.gMoy[id], liquid = (level.flags[id] & F_LIQUID) !== 0;
		a[id] = (moy + (liquid || moy === 0.0 ? -1.0 : 0.0)) / MULT;
	}
	return a;
}
/** walking distance in fifths to the goals (8-way, a diagonal step closed only between two walls; portals; deaths:
 *  {respawn, src} or null, every source DEATH_COST more than the nearest respawn tile) */
function walkField(W, H, cls, passable, trophy, goalF, portalExits, deaths, maxF) {
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
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const x = x2 - dx, y = y2 - dy;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const t = y * W + x;
			if (!passable(t)) continue;
			if (dx && dy && cls[y * W + x2] === WALL && cls[y2 * W + x] === WALL) continue;
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
 *  strongest pull); slippery. -1 = cut off. The same numbers as native/beam.h reachFifths. */
function fifthsAt(f, px, py, vy, q0, q1, slip) {
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
 *  (cut-off ones left out, and ways through a death while the ball's own way is a real one), for a smooth gradient; the
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
			if (c < 0 || (c >= DEATH_COST && own < DEATH_COST)) continue;
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
	VERSION: 3, reachField, fifthsAt, scoreAt, costAt, stateAt, stateOf, writeReachFile, reachFileBytes, shareField, DEATH_COST, DEATH_TILES: DEATH_COST / 5,
	// the tables and the lookup's pieces (tests)
	riseQ, airRise, fallD, fallV, kOfX, cOfV, qOf, interp, RaInv, TABLES, VF, VFC, KLJ, NFV, NTH, FVa, FSa,
	G, BD, JV, K_T, TOL, QMAX, KF, NL, CUT, FAR, R_, F_, X_, C_,
	WALL, DEADLY, NORM, DOTS, CLIMB, WATER, MUD, UP, BUP, BDOWN, A_CLASS, CAP_CLASS,
	// v2 names (src/out scripts): the classes
	C_SOLID: WALL, C_DEADLY: DEADLY, C_NORMAL: NORM, C_UP: UP, C_BOOSTUP: BUP,
};
