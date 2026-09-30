'use strict';
// THE BOUNDS (n4plan part 'primitives', the compiler's math): ADMISSIBLE tick bounds on a level, from tiles and from
// exact engine states, for the planner's abstract edge costs and global lower bound, the navigation graph's A* and the
// compiler's gap report. Every value is a LOWER bound on the ticks the ball needs; none prunes anything by itself.
//
//   bounds = createBounds(L, {model}) -> {vmax, field(goalTiles, Lc?, o?) -> Float32Array(N), at(field, sim) -> ticks,
//            pair(fromTiles, toTiles, Lc?) -> ticks, leg(sim, goal) -> ticks, tiers(field) -> per tier, stats()}
//
// THE GEOMETRY (why the fields are sound). The box's top-left p = (px, py) lives in the free set; a full wall tile X
// (reach.js guideFlags: solid and no door / one-way / half block; a coin door that never opens) is an obstacle to it.
// Take the lattice nodes (16 x, 16 y) = "the box exactly on tile (x, y)": a node is free iff its tile is no wall, the
// segment between two orthogonal nodes iff both tiles are no walls, the open square between four nodes iff all four
// are no walls (the box there overlaps all four). Every other tile (doors as Lc holds them, else open; one-ways; half
// blocks; killers) is free space here: a relaxation, the free set only grows (sound). The centre tile of a state is the
// node within 8 px (L-infinity) of p, joined to it by a straight free segment; a goal holds when the centre is in a goal
// tile, i.e. p within 8 px of that goal node. The engine moves the box by at most 16 px of speed per axis per tick (the
// clamp) plus the auto-align (< 0.2 px) and rounding: D_TICK = 16.25 (endgame.js), interleaving 1-px x and y steps.
//   tier 0 'iso':  the 8-connected graph distance D over these nodes (orthogonal: both tiles free; diagonal: all four)
//                  is the L-infinity geodesic / 16; a state in tile t is more than 16 D - 16 px from the goal, so it needs
//                  more than (16 D - 16 - SLACK) / 16.25 ticks (SLACK 2 px: the engine's integer pixel test lets the box
//                  1 px nearer a wall's low side than the half-open geometry). A non-goal tile needs >= 1 tick.
//   tier 1 'axis': per axis the box's travel along that axis (its total variation) divided by the level's top speed on
//                  that axis and direction (vmax, from the mechanisms the level holds: boosts, arrows, effects, ice,
//                  rotated portals; else the engine's run 6.7766 px/tick, fall 13.553, jump 6.708 x the jump effect):
//                  T >= right / xp + left / xn and T >= down / yp + up / yn along any path; the graph minimum of each is a
//                  Dijkstra over the same nodes with the other axis free. Sound whatever the path's shape.
//   teleports: a portal (not silent: reach.js silentPortals) teleports the ball in the tick after its centre is in the
//                  entry tile (or a half block whose touch goes to it); that tick leaves the centre within one tile of an
//                  exit: Q(p) = 1 + min over the 3 x 3 around its exits of the bound there. A death (a killing tile, or
//                  anywhere with a timed killer) brings the ball to a checkpoint or spawn DEATH_MIN (54; the engine: 55)
//                  ticks after its centre was in the killing tile. Both are sources of the fields at those values, a
//                  fixpoint iterated FROM BELOW (every iterate is a lower bound: the operator is monotone).
//   at(field, sim): the tile's value with the ball's own offset from its node (not the worst 8 px): sound sub-tile
//                  correction; max with endgame.js lowerBound (walls ignored; a way through a death: DEATH_MIN + the field
//                  at the respawns, the min of both).
// The goal set of a trophy field (every goal tile a trophy) takes the half blocks whose touch goes to a trophy too (the
// complete fires by the touched tile); leg() adds the complete's tick (+1) for a trophy goal.
//
// Memoized by (fgHash of the level copy, the sorted goals, touch): a small LRU. 400 x 200 levels: a few ms a field.
const E = require('../eesim.js');
const RF = require('../reach.js');
const T = require('./types.js');

const D_TICK = 16.25;
const SLACK = 2;                 // px: the engine's integer pixel test (floor(px)) lets the box 1 px nearer a low side
const DEATH_MIN = 54;            // ticks from "centre in a killing tile" to "centre in the respawn tile" (the engine: 55)
const EPS = 1e-6;
const MAX_ROUNDS = 5;            // the teleport fixpoint's rounds (each is a lower bound: the fixpoint is iterated from below, so stopping early stays sound)
const MEMO_MAX = 24;
const TROPHY = 121, CHECKPOINT = 360, PORTAL = 242, PORTAL_INV = 381;
const CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64;
const X_NONROT_HALF = 4;
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

// ---------------------------------------------------------------- the engine's top speeds (its own arithmetic)
const C = E.constants;
const BD = C.BASE_DRAG, MULT = C.MULT;
/** the limit of v -> (v + a) * BD from 0 (monotone: the sup of the speed under a constant push a per tick) */
function terminal(a) { let v = 0; for (let i = 0; i < 20000; i++) { const n = (v + a) * BD; if (n > 16) return 16; if (n === v) break; v = n; } return v; }
const V_RUN = terminal(1 / MULT);           // 6.7766: holding a direction, base drag only
const V_FALL = terminal(2 / MULT);          // 13.553: gravity 2 (the plain down pull)
const V_JUMP = (2 * 26) / MULT;             // 6.708: the jump speed (x the jump effect's multiplier)
const V_CAP = D_TICK;                       // the clamp 16 + the align + rounding: no rule
const V_MARGIN = 0.02;                      // rounding margin over a measured sup
const EFFECT_ALL = new Set([418, 1517]);    // fly (levitation thrust), the gravity effect: every axis at the cap
const ICE = 1064, SPEED_FX = 419, JUMP_FX = 417;

/** per-level static data (cached on the level object) */
const STATIC = new WeakMap();
function staticOf(L) {
	let S = STATIC.get(L);
	if (S) return S;
	const W = L.width, H = L.height, N = W * H, fg = L.fg, g = RF.guideFlags(L), nF = g.length, lk = L.lookup0, xfl = L.xflags;
	const never = RF.neverOpenDoors(L);
	const silent = RF.silentPortals(L);
	const fl = (id) => (id >= 0 && id < nF ? g[id] : 0);
	const isWallId = (id) => (fl(id) & F_SOLID) !== 0 && (fl(id) & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0;
	/** the cells whose touch (the engine's current tile) is cell i: itself, a half block below it (rotation 1, presents
	 *  always) or right of it (rotation 0) (endgame.js touchers, reach.js hcur) */
	const hcur = (i) => { const id = fg[i]; if ((fl(id) & F_HALF) === 0) return -1; return (xfl[id] & X_NONROT_HALF) ? 1 : lk[i]; };
	const touchers = (i) => {
		const x = i % W, y = (i - x) / W, l = [i];
		if (y + 1 < H && hcur(i + W) === 1) l.push(i + W);
		if (x + 1 < W && hcur(i + 1) === 0) l.push(i + 1);
		return l;
	};
	const curOf = (i) => { const hc = hcur(i); return hc === 1 ? (i >= W ? i - W : -1) : hc === 0 ? (i % W > 0 ? i - 1 : -1) : i; };
	// portals: per entry the trigger cells and the tiles within one of its exits
	const portals = [];
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const t = fg[i], s = L.portalSlot[i];
			if ((t !== PORTAL && t !== PORTAL_INV) || s < 0 || silent[i] || L.pTarget[s] === L.pId[s]) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex || ex.n === 0) continue;
			const near = new Set();
			for (let k = 0; k < ex.n; k++) {
				const x = ex.xs[k] >> 4, y = ex.ys[k] >> 4;
				for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) near.add(yy * W + xx);
			}
			if (near.size) portals.push({ entry: i, trig: Int32Array.from(touchers(i)), near: Int32Array.from(near) });
		}
	}
	// deaths: the killing tiles (by the tile or its current tile), anywhere with a timed killer; the respawn tiles
	let timed = false;
	const ids = new Set();
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		ids.add(id);
		if (((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0) || id === LAVA) timed = true;
	}
	const kills = (i) => i >= 0 && L.gFlags && fg[i] < L.gFlags.length && (L.gFlags[fg[i]] & 4) !== 0;
	const dsrc = [];
	for (let i = 0; i < N; i++) if (!isWallId(fg[i]) && (timed || kills(i) || kills(curOf(i)))) dsrc.push(i);
	const respawn = [];
	{
		const seen = new Uint8Array(N);
		const add = (i) => { if (i >= 0 && i < N && !seen[i]) { seen[i] = 1; respawn.push(i); } };
		const sx = L.spawnsX || [], sy = L.spawnsY || [];
		for (let k = 0; k < sx.length; k++) if (sx[k] >= 0 && sy[k] >= 0 && sx[k] < W && sy[k] < H) add(sy[k] * W + sx[k]);
		if (!sx.length && W > 1 && H > 1) add(W + 1);
		for (let i = 0; i < N; i++) if (fg[i] === CHECKPOINT) add(i);
	}
	const deaths = dsrc.length > 0 && respawn.length > 0;
	// the mechanisms: the tiles whose touch can take the ball past the plain speeds (boosts, the jump / fly / speed /
	// gravity effects, side and up gravity, the tile above ice (slippery), a rotated portal's triggers), with their half
	// block touchers; a ball in plain mode keeps the plain speeds until its centre is in one (the plain layer)
	const mechId = new Uint8Array(nF + 1);
	for (let id = 0; id < nF; id++) {
		if (id === 114 || id === 115 || id === 116 || id === 117 || id === JUMP_FX || id === SPEED_FX || EFFECT_ALL.has(id)) mechId[id] = 1;
		else if (L.gMox[id] !== 0 || L.gMorx[id] !== 0 || L.gMoy[id] < 0) mechId[id] = 1;
	}
	const mechT = new Uint8Array(N);
	const markMech = (i) => { if (i >= 0 && i < N) for (const c of touchers(i)) mechT[c] = 1; };
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id >= 0 && id < nF && mechId[id]) markMech(i);
		if (id === ICE && i >= W) markMech(i - W);
	}
	for (const p of portals) {
		const s0 = L.portalSlot[p.entry], ex = L.portalsById.get(L.pTarget[s0]);
		let rot = false;
		for (let k = 0; k < ex.n && !rot; k++) { const ns = L.portalSlot[(ex.ys[k] >> 4) * W + (ex.xs[k] >> 4)]; if ((ns >= 0 ? L.pRot[ns] : 0) !== L.pRot[s0]) rot = true; }
		p.rotated = rot;
		if (rot) for (const c of p.trig) mechT[c] = 1;
	}
	const mechTiles = [];
	for (let i = 0; i < N; i++) if (mechT[i] && !isWallId(fg[i])) mechTiles.push(i);
	const vmax = vmaxOf(L, ids, g, nF);
	const vplain = vmaxPlainOf(L, ids, g, nF);
	S = { W, H, N, g, nF, isWallId, never, touchers, portals, dsrc: Int32Array.from(dsrc), respawn: Int32Array.from(respawn), deaths, ids, vmax, vplain,
		mechId, mechT, mechTiles: Int32Array.from(mechTiles) };
	STATIC.set(L, S);
	return S;
}

/**
 * vmax {xp, xn, yp, yn} (px per tick of travel along an axis direction: +x right, +y down) from the mechanisms the level
 * holds; V_CAP (16.25) where a mechanism can push past the plain physics. The plain sups are the engine's arithmetic
 * (terminal()); every speed a tick moves the box with is the speed after the update (drag, clamp).
 */
function vmaxOf(L, ids, g, nF) {
	const v = { xp: V_RUN, xn: V_RUN, yp: V_FALL, yn: V_JUMP, why: [] };
	const cap = (k, why) => { if (v[k] < V_CAP) { v[k] = V_CAP; v.why.push(`${k}:${why}`); } };
	let gmx = 0, gmUp = 0, gmDown = 0, zeroG = false, liquid = false;
	for (const id of ids) {
		if (id < 0 || id >= nF) continue;
		if (L.gMox[id] !== 0 || L.gMorx[id] !== 0) gmx = Math.max(gmx, Math.abs(L.gMox[id]));
		if (L.gMoy[id] < 0) gmUp = Math.max(gmUp, -L.gMoy[id]);
		if (L.gMoy[id] > 0) gmDown = Math.max(gmDown, L.gMoy[id]);
		if (L.gMox[id] === 0 && L.gMoy[id] === 0) zeroG = true;
		if ((g[id] & (F_LIQUID | F_CLIMB)) !== 0) liquid = true;
	}
	const wgm = L.gravityMult;
	if (!(Number.isFinite(wgm) && wgm > 0)) { for (const k of ['xp', 'xn', 'yp', 'yn']) cap(k, 'gravity multiplier'); return v; }
	for (const id of EFFECT_ALL) if (ids.has(id)) for (const k of ['xp', 'xn', 'yp', 'yn']) cap(k, `effect ${id}`);
	if (ids.has(114)) cap('xn', 'boost 114');
	if (ids.has(115)) cap('xp', 'boost 115');
	if (ids.has(116)) cap('yn', 'boost 116');
	if (ids.has(117)) cap('yp', 'boost 117');
	if (ids.has(ICE)) { cap('xp', 'ice'); cap('xn', 'ice'); }
	if (gmx > 0) { cap('xp', 'side gravity'); cap('xn', 'side gravity'); }
	if (gmUp > 0) cap('yn', 'up gravity');
	// rotated portals: a speed turned into another axis (x 1.42, clamped to 16 the tick after)
	if (L.portalSlot && L.portalsById && L.pRot) {
		let rot = false;
		for (let i = 0; i < L.fg.length && !rot; i++) {
			const s = L.portalSlot[i];
			if (s < 0 || (L.fg[i] !== PORTAL && L.fg[i] !== PORTAL_INV)) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			for (let k = 0; k < ex.n; k++) {
				const ns = L.portalSlot[(ex.ys[k] >> 4) * L.width + (ex.xs[k] >> 4)];
				const nr = ns >= 0 ? L.pRot[ns] : 0;
				if (nr !== L.pRot[s]) { rot = true; break; }
			}
		}
		if (rot) for (const k of ['xp', 'xn', 'yp', 'yn']) cap(k, 'rotated portal');
	}
	const sm = ids.has(SPEED_FX) ? 1.5 : 1.0;
	const jm = ids.has(JUMP_FX) ? 1.3 : 1.0;
	// the push of held input (speed effect x 1.5) on any axis it can act on; gravity pulls down (x the world multiplier;
	// any down table entry); the jump
	const run = terminal(sm / MULT);
	if (v.xp < V_CAP) v.xp = Math.max(V_RUN, run) + V_MARGIN;
	if (v.xn < V_CAP) v.xn = Math.max(V_RUN, run) + V_MARGIN;
	if (v.yp < V_CAP) v.yp = Math.max(terminal((Math.max(gmDown, 2) * Math.max(wgm, 1)) / MULT), (zeroG || liquid) ? run : 0) + V_MARGIN;
	if (v.yn < V_CAP) v.yn = Math.max(V_JUMP * jm, (zeroG || liquid) ? run : 0) + V_MARGIN;
	for (const k of ['xp', 'xn', 'yp', 'yn']) if (v[k] > V_CAP) v[k] = V_CAP;
	return v;
}

/** the plain speeds: every mechanism left out (vmaxOf without the rules a mechanism tile triggers) */
function vmaxPlainOf(L, ids, g, nF) {
	let gmDown = 0, zeroG = false, liquid = false;
	for (const id of ids) {
		if (id < 0 || id >= nF) continue;
		if (L.gMoy[id] > 0) gmDown = Math.max(gmDown, L.gMoy[id]);
		if (L.gMox[id] === 0 && L.gMoy[id] === 0) zeroG = true;
		if ((g[id] & (F_LIQUID | F_CLIMB)) !== 0) liquid = true;
	}
	const wgm = L.gravityMult;
	if (!(Number.isFinite(wgm) && wgm > 0)) return null;
	const v = { xp: V_RUN + V_MARGIN, xn: V_RUN + V_MARGIN, yp: Math.max(terminal((Math.max(gmDown, 2) * Math.max(wgm, 1)) / MULT), (zeroG || liquid) ? V_RUN : 0) + V_MARGIN,
		yn: Math.max(V_JUMP, (zeroG || liquid) ? V_RUN : 0) + V_MARGIN };
	for (const k of ['xp', 'xn', 'yp', 'yn']) if (v[k] > V_CAP) v[k] = V_CAP;
	return v;
}

// ---------------------------------------------------------------- the graph searches
/** a binary heap of (key, node) over typed arrays */
class Heap {
	constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
	push(key, node) {
		if (this.n >= this.k.length) { const k2 = new Float64Array(this.k.length * 2), v2 = new Int32Array(this.k.length * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
		let i = this.n++;
		const K = this.k, V = this.v;
		while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
		K[i] = key; V[i] = node;
	}
	pop() {
		const K = this.k, V = this.v, top = V[0], n = --this.n;
		if (n > 0) {
			const key = K[n], node = V[n];
			let i = 0;
			for (;;) {
				let c = 2 * i + 1;
				if (c >= n) break;
				if (c + 1 < n && K[c + 1] < K[c]) c++;
				if (K[c] >= key) break;
				K[i] = K[c]; V[i] = V[c]; i = c;
			}
			K[i] = key; V[i] = node;
		}
		return top;
	}
	topKey() { return this.k[0]; }
}

/**
 * Backward Dijkstra over the nodes: dist[t] = min over paths t -> s of (sum of step costs) + init[s] over sources s.
 * cost(dx, dy) is the cost of the forward step from a tile to its neighbour at (dx, dy) (the ball moves by (dx, dy)).
 * Moves: orthogonal between two free tiles, diagonal only when all four tiles of the square are free.
 */
function dijkstra(S, wall, srcTiles, srcInit, cost, out) {
	const W = S.W, H = S.H, N = S.N;
	const dist = out || new Float64Array(N);
	dist.fill(Infinity);
	const heap = new Heap(1024);
	for (let k = 0; k < srcTiles.length; k++) {
		const s = srcTiles[k], c = srcInit[k];
		if (c < dist[s]) { dist[s] = c; heap.push(c, s); }
	}
	const cst = new Float64Array(8);
	for (let d = 0; d < 8; d++) cst[d] = cost(-DX8[d], -DY8[d]);   // the ball steps from the neighbour INTO this tile
	while (heap.n > 0) {
		const key = heap.topKey(), t = heap.pop();
		if (key > dist[t]) continue;
		const x = t % W, y = (t - x) / W;
		for (let d = 0; d < 8; d++) {
			const xx = x + DX8[d], yy = y + DY8[d];
			if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const n = yy * W + xx;
			if (wall[n]) continue;
			if (d >= 4 && (wall[y * W + xx] || wall[yy * W + x] || wall[t])) continue;
			const nd = key + cst[d];
			if (nd < dist[n]) { dist[n] = nd; heap.push(nd, n); }
		}
	}
	return dist;
}

// ---------------------------------------------------------------- createBounds
function createBounds(L, o = {}) {
	const S = staticOf(L);
	const W = S.W, H = S.H, N = S.N;
	const model = o.model || null;
	const vmax = S.vmax;
	const useAxis = vmax.xp < V_CAP || vmax.xn < V_CAP || vmax.yp < V_CAP || vmax.yn < V_CAP;
	const tiersOn = { iso: o.iso !== false, axis: o.axis !== false && useAxis, endgame: o.endgame !== false };
	const memo = new Map();
	const META = new WeakMap();
	const st = { fields: 0, hits: 0, ms: 0, rounds: 0, at: 0 };
	let EG = null, egCtx = new Map();

	const wallOf = (Lc) => {
		const fg = Lc.fg, w = new Uint8Array(N);
		for (let i = 0; i < N; i++) if (S.isWallId(fg[i]) || (S.never && S.never[i])) w[i] = 1;
		return w;
	};
	const stepIso = () => 1;   // the iso field counts nodes (steps); ticks from steps at the end
	const costX = (dx) => (dx > 0 ? 16 / vmax.xp : dx < 0 ? 16 / vmax.xn : 0);
	const costY = (dy) => (dy > 0 ? 16 / vmax.yp : dy < 0 ? 16 / vmax.yn : 0);
	const offX = (16 + SLACK) / Math.min(vmax.xp, vmax.xn), offY = (16 + SLACK) / Math.min(vmax.yp, vmax.yn);
	// the plain layer: a ball in plain mode (no effect, plain speeds, no pending mechanism) keeps the plain speeds until
	// its centre is in a mechanism tile; from there the capped layer's values (less both sides' offsets at that tile)
	const vp = S.vplain;
	const usePlain = o.plain !== false && !!vp && (vp.xp < vmax.xp || vp.xn < vmax.xn || vp.yp < vmax.yp || vp.yn < vmax.yn);
	const costXp = (dx) => (dx > 0 ? 16 / vp.xp : dx < 0 ? 16 / vp.xn : 0);
	const costYp = (dy) => (dy > 0 ? 16 / vp.yp : dy < 0 ? 16 / vp.yn : 0);
	const offXp = usePlain ? (16 + SLACK) / Math.min(vp.xp, vp.xn) : 0, offYp = usePlain ? (16 + SLACK) / Math.min(vp.yp, vp.yn) : 0;
	const capX = (dx) => (dx > 0 ? 16 / Math.max(vmax.xp, 1) : dx < 0 ? 16 / Math.max(vmax.xn, 1) : 0);
	const capY = (dy) => (dy > 0 ? 16 / Math.max(vmax.yp, 1) : dy < 0 ? 16 / Math.max(vmax.yn, 1) : 0);
	/** a state in plain mode: the plain layer's values hold for it */
	const isPlain = (sim) => usePlain && !sim.is_dead && sim.speed_boost !== 1 && sim.jump_boost !== 1 && sim.flip_gravity === 0 && !sim.has_levitation &&
		!(sim._slippery > 0) && Math.abs(sim.speed_x) <= vp.xp && sim.speed_y <= vp.yp && -sim.speed_y <= vp.yn &&
		!(sim._q0 >= 0 && sim._q0 < S.nF && S.mechId[sim._q0]) && !(sim._q1 >= 0 && sim._q1 < S.nF && S.mechId[sim._q1]) && !S.mechT[T.tileOf(sim, W, H)];

	const srcTarr = (goalArr, Q, R) => { const t = Array.from(goalArr); S.portals.forEach((p) => { for (const c of p.trig) t.push(c); }); if (S.deaths) for (const d of S.dsrc) t.push(d); return t; };
	const srcIarr = (goalArr, Q, R) => { const t = Array.from(goalArr, () => 0); S.portals.forEach((p, k) => { for (let j = 0; j < p.trig.length; j++) t.push(Q[k]); }); if (S.deaths) for (let j = 0; j < S.dsrc.length; j++) t.push(DEATH_MIN + R); return t; };
	/**
	 * field(goalTiles, Lc?, o?) -> Float32Array(N) of admissible ticks (Infinity: no way; 0 on goal tiles).
	 * o.touch: add the half blocks whose touch goes to a goal (default: when every goal tile is a trophy).
	 */
	function field(goalTiles, Lc, fo = {}) {
		const Lx = Lc || L;
		const gl = Array.from(goalTiles).filter((t) => t >= 0 && t < N).sort((a, b) => a - b);
		const touch = fo.touch !== undefined ? !!fo.touch : gl.length > 0 && gl.every((t) => L.fg[t] === TROPHY);
		const key = `${Lc ? T.fgHash(Lc.fg) : '-'}|${touch ? 1 : 0}|${gl.join(',')}`;
		const had = memo.get(key);
		if (had) { st.hits++; memo.delete(key); memo.set(key, had); return had; }
		const t0 = Date.now();
		const wall = wallOf(Lx);
		const goals = new Set();
		for (const t of gl) for (const c of (touch ? S.touchers(t) : [t])) goals.add(c);
		const goalArr = Int32Array.from(goals);
		const isGoal = new Uint8Array(N);
		for (const t of goalArr) isGoal[t] = 1;
		// sources: the goals (0), the portal triggers (Q), the death sources (DEATH_MIN + the best respawn), from below
		const Q = new Float64Array(S.portals.length).fill(1);
		let R = 0;
		const bound = new Float32Array(N);
		const iso = tiersOn.iso ? new Float64Array(N) : null, ax = tiersOn.axis ? new Float64Array(N) : null, ay = tiersOn.axis ? new Float64Array(N) : null;
		let rounds = 0;
		for (;;) {
			rounds++;
			const srcT = [], srcI = [];
			for (const t of goalArr) { srcT.push(t); srcI.push(0); }
			S.portals.forEach((p, k) => { for (const c of p.trig) { srcT.push(c); srcI.push(Q[k]); } });
			if (S.deaths) for (const d of S.dsrc) { srcT.push(d); srcI.push(DEATH_MIN + R); }
			// iso: in steps (a source's ticks / (16 / 16.25) steps)
			if (iso) dijkstra(S, wall, srcT, srcI.map((v) => v * D_TICK / 16), stepIso, iso);
			if (ax) { dijkstra(S, wall, srcT, srcI, (dx) => costX(dx), ax); dijkstra(S, wall, srcT, srcI, (dx, dy) => costY(dy), ay); }
			for (let i = 0; i < N; i++) {
				if (isGoal[i]) { bound[i] = 0; continue; }
				let b = 1;
				if (iso) { const v = iso[i]; if (v === Infinity) { bound[i] = Infinity; continue; } b = Math.max(b, Math.ceil((16 * v - 16 - SLACK) / D_TICK - EPS)); }
				if (ax) {
					const vx = ax[i], vy = ay[i];
					if (vx === Infinity || vy === Infinity) { bound[i] = Infinity; continue; }
					b = Math.max(b, Math.ceil(vx - offX - EPS), Math.ceil(vy - offY - EPS));
				}
				bound[i] = b;
			}
			// the teleports' values from this bound (monotone: every round a lower bound)
			let changed = false;
			S.portals.forEach((p, k) => {
				let m = Infinity;
				for (const c of p.near) if (!wall[c] && bound[c] < m) m = bound[c];
				const q = 1 + m;
				if (q > Q[k] + 1e-9) { Q[k] = q; changed = true; }
			});
			if (S.deaths) {
				let m = Infinity;
				for (const r of S.respawn) if (bound[r] < m) m = bound[r];
				if (m > R + 1e-9 && m !== Infinity) { R = m; changed = true; }
			}
			if (!changed || rounds >= MAX_ROUNDS) break;
		}
		// the plain layer: sources the goals, the non-rotated portals (Qp, its own fixpoint from below), the deaths (the
		// capped respawn values: a respawn is plain, and the capped values hold anyway), the mechanism tiles (the capped
		// per-axis values there less 8 px on each side of the tile at each layer's slowest speed)
		let axp = null, ayp = null, plainB = null;
		if (usePlain && S.mechTiles.length) {
			const cx = ax || dijkstra(S, wall, srcTarr(goalArr, Q, R, wall), srcIarr(goalArr, Q, R, wall), (dx) => capX(dx), null);
			const cy = ay || dijkstra(S, wall, srcTarr(goalArr, Q, R, wall), srcIarr(goalArr, Q, R, wall), (dx, dy) => capY(dy), null);
			const mOffX = (8 + SLACK) / Math.min(vp.xp, vp.xn) + (8 + SLACK) / Math.min(vmax.xp, vmax.xn), mOffY = (8 + SLACK) / Math.min(vp.yp, vp.yn) + (8 + SLACK) / Math.min(vmax.yp, vmax.yn);
			const Qp = new Float64Array(S.portals.length).fill(1);
			axp = new Float64Array(N); ayp = new Float64Array(N); plainB = new Float32Array(N);
			for (let r = 0; r < MAX_ROUNDS; r++) {
				rounds++;
				const sT = [], sX = [], sY = [];
				for (const t of goalArr) { sT.push(t); sX.push(0); sY.push(0); }
				S.portals.forEach((p, k) => { if (!p.rotated) for (const c of p.trig) { sT.push(c); sX.push(Qp[k]); sY.push(Qp[k]); } });
				if (S.deaths) for (const d of S.dsrc) { sT.push(d); sX.push(DEATH_MIN + R); sY.push(DEATH_MIN + R); }
				for (const m of S.mechTiles) if (!isGoal[m]) { sT.push(m); sX.push(Math.max(0, cx[m] - mOffX)); sY.push(Math.max(0, cy[m] - mOffY)); }
				dijkstra(S, wall, sT, sX, (dx) => costXp(dx), axp);
				dijkstra(S, wall, sT, sY, (dx, dy) => costYp(dy), ayp);
				for (let i = 0; i < N; i++) {
					if (isGoal[i] || bound[i] === Infinity) { plainB[i] = bound[i]; continue; }
					plainB[i] = Math.max(bound[i], Math.ceil(axp[i] - offXp - EPS), Math.ceil(ayp[i] - offYp - EPS));
				}
				let changed = false;
				S.portals.forEach((p, k) => {
					if (p.rotated) return;
					let m = Infinity;
					for (const c of p.near) if (!wall[c] && plainB[c] < m) m = plainB[c];
					if (1 + m > Qp[k] + 1e-9) { Qp[k] = 1 + m; changed = true; }
				});
				if (!changed) break;
			}
		}
		const ms = Date.now() - t0;
		st.fields++; st.ms += ms; st.rounds += rounds;
		META.set(bound, { goals: goalArr, isGoal, iso: iso ? Float32Array.from(iso) : null, ax: ax ? Float32Array.from(ax) : null, ay: ay ? Float32Array.from(ay) : null,
			axp: axp ? Float32Array.from(axp) : null, ayp: ayp ? Float32Array.from(ayp) : null, plainB, touch, ms, rounds, lc: !!Lc });
		memo.set(key, bound);
		if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
		return bound;
	}

	/** the bound for an exact state: the field's tile value with the ball's own offset from its node, max endgame's */
	function at(f, sim, ao = {}) {
		st.at++;
		const m = META.get(f);
		if (sim.is_dead) {
			let b = Infinity;
			for (const r of S.respawn) if (f[r] < b) b = f[r];
			return Math.max(1, b);
		}
		const t = T.tileOf(sim, W, H);
		let v = f[t];
		if (!m || v === 0 || v === Infinity) return v;
		const x = t % W, y = (t - x) / W;
		const dx = sim.px - 16 * x, dy = sim.py - 16 * y;   // the ball's top-left from its node (|d| <= 8, 1 px more by the pixel test)
		const adx = Math.abs(dx), ady = Math.abs(dy);
		if (m.iso) {
			const s = m.iso[t];
			const b = Math.ceil((16 * s - Math.max(adx, ady) - 8 - SLACK) / D_TICK - EPS);
			if (b > v) v = b;
		}
		if (m.ax) {
			const bx = Math.ceil(m.ax[t] - (dx > 0 ? dx / vmax.xp : -dx / vmax.xn) - (8 + SLACK) / Math.min(vmax.xp, vmax.xn) - EPS);
			const by = Math.ceil(m.ay[t] - (dy > 0 ? dy / vmax.yp : -dy / vmax.yn) - (8 + SLACK) / Math.min(vmax.yp, vmax.yn) - EPS);
			if (bx > v) v = bx;
			if (by > v) v = by;
		}
		if (m.axp && isPlain(sim)) {
			const bx = Math.ceil(m.axp[t] - (dx > 0 ? dx / vp.xp : -dx / vp.xn) - (8 + SLACK) / Math.min(vp.xp, vp.xn) - EPS);
			const by = Math.ceil(m.ayp[t] - (dy > 0 ? dy / vp.yp : -dy / vp.yn) - (8 + SLACK) / Math.min(vp.yp, vp.yn) - EPS);
			if (bx > v) v = bx;
			if (by > v) v = by;
		}
		if (tiersOn.endgame && (ao.endgame !== false) && v < 128) {
			// endgame.js's kinematic bound holds for the ways without a death (portals it models); a way through a death
			// takes >= DEATH_MIN ticks to the respawn and the field's value there
			let e = endgameAt(m, sim, Math.max(v, 1) + 64);
			if (S.deaths) { let r = Infinity; for (const x of S.respawn) if (f[x] < r) r = f[x]; if (DEATH_MIN + r < e) e = DEATH_MIN + r; }
			if (e > v) v = e;
		}
		return v;
	}
	function endgameAt(m, sim, lim) {
		if (!EG) EG = require('../endgame.js');
		const k = m.goals.join(',');
		let B = egCtx.get(k);
		if (!B) { B = EG.boundContext(L, { goals: Array.from(m.goals) }); egCtx.set(k, B); if (egCtx.size > 16) egCtx.delete(egCtx.keys().next().value); }
		return EG.lowerBound(B, sim, lim);
	}
	/** min over fromTiles of field(toTiles, Lc) */
	function pair(fromTiles, toTiles, Lc) {
		const f = field(toTiles, Lc);
		let b = Infinity;
		for (const t of fromTiles) if (t >= 0 && t < N && f[t] < b) b = f[t];
		return b;
	}
	/** a waypoint goal (types.js goalOf) from an exact state; the trophy: + the complete's tick */
	function leg(sim, goal, lo = {}) {
		const Lc = lo.relaxed ? null : T.levelNow(L, sim);
		const trophy = goal.kind === 'trophy';
		const f = field(goal.tiles, Lc, { touch: trophy });
		const v = at(f, sim);
		return trophy && v !== Infinity ? v + 1 : v;
	}
	/** per tier the values at a state (the report's tightness) */
	function tiers(f, sim) {
		const m = META.get(f);
		const out = { field: null, iso: null, axis: null, plain: null, endgame: null };
		if (!m) return out;
		const t = T.tileOf(sim, W, H);
		out.field = f[t];
		if (sim.is_dead || f[t] === 0 || f[t] === Infinity) return out;
		const x = t % W, y = (t - x) / W, dx = sim.px - 16 * x, dy = sim.py - 16 * y;
		if (m.iso) out.iso = Math.max(1, Math.ceil((16 * m.iso[t] - Math.max(Math.abs(dx), Math.abs(dy)) - 8 - SLACK) / D_TICK - EPS));
		if (m.ax) out.axis = Math.max(1, Math.ceil(m.ax[t] - (dx > 0 ? dx / vmax.xp : -dx / vmax.xn) - (8 + SLACK) / Math.min(vmax.xp, vmax.xn) - EPS),
			Math.ceil(m.ay[t] - (dy > 0 ? dy / vmax.yp : -dy / vmax.yn) - (8 + SLACK) / Math.min(vmax.yp, vmax.yn) - EPS));
		if (m.axp && isPlain(sim)) out.plain = Math.max(1, Math.ceil(m.axp[t] - (dx > 0 ? dx / vp.xp : -dx / vp.xn) - (8 + SLACK) / Math.min(vp.xp, vp.xn) - EPS),
			Math.ceil(m.ayp[t] - (dy > 0 ? dy / vp.yp : -dy / vp.yn) - (8 + SLACK) / Math.min(vp.yp, vp.yn) - EPS));
		out.endgame = endgameAt(m, sim, 512);
		if (S.deaths) { let r = Infinity; for (const x of S.respawn) if (f[x] < r) r = f[x]; if (DEATH_MIN + r < out.endgame) out.endgame = DEATH_MIN + r; }
		return out;
	}
	return { vmax, vplain: usePlain ? vp : null, isPlain, tiersOn, field, at, pair, leg, tiers, meta: (f) => META.get(f), stats: () => Object.assign({}, st, { memo: memo.size }), static: S };
}

module.exports = { createBounds, vmaxOf, terminal, staticOf, dijkstra, D_TICK, DEATH_MIN, V_RUN, V_FALL, V_JUMP, V_CAP, SLACK };
