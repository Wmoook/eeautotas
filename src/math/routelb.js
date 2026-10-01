'use strict';
// THE ORDER-AWARE WHOLE-ROUTE LOWER BOUND (n5-p4-perfect, 2026-09-30; docs/ee_math.md section 9). A lower bound on the
// ticks EVERY route needs from an exact engine state to the finish (and, from the level start, on its run ticks): the
// least over every order of the triggers the level's gates make relevant of the sum of tight per-leg bounds, by A* over
// the model's abstract states (src/plan/model.js: the features some gate reads, the coins a coin gate counts, the
// checkpoint a death returns to). Admissible by construction; checked on the known routes (tools/perfect/routelb_truth.js).
//
// THE GEOMETRY (exact, no slack constant). The ball's CENTRE c = p + 8 (p the box's top-left). The engine's box overlaps
// tile W along an axis iff floor(p) is in [16W - 15, 16W + 15], so the centre is in the OBSTACLE [16W - 7, 16W + 24) of a
// wall tile on both axes, and every free set's maximal interval STARTS at a multiple of 8 (16W + 24). The 8-px lattice of
// centre points (8i, 8j) holds every passage: flooring a free point to the lattice keeps it free (both axes), the floored
// copy of a continuous path is a lattice path through free nodes (an edge is free iff both its ends are), a touch of the
// cell [16X, 16X + 16)^2 floors to one of its 4 lattice points, and an L1-type geodesic between lattice-aligned regions
// among these obstacles runs on the lattice (the Hanan grid: a geodesic turns only at obstacle edges, which are lattice
// lines (16W + 24) or are floored toward the path's own side (16W - 7 -> 16W - 8), so snapping never adds travel; only the
// exact start point costs its own floor offset, subtracted once). A node (i, j) is blocked iff a wall tile lies in
// cols(i) x rows(j): cols(2a) = {a - 1, a}, cols(2a + 1) = {a}.
//
// THE SPEEDS (sound, LOCAL). Per tile c: U(c) = the most |speed| after the speed update of any tick that STARTS with the
// centre in c (the speed that tick moves the box by: |dx| <= U, the auto-align adds < 0.2 px only below 1 px/tick, so at
// most one cell boundary a tick per axis), a fixpoint from below over the engine's update v' = (v + a) x drag:
//   V(c) = the speed at a tick START in c >= U(c') of every tile c' within one cell (the tick before), the jump speed next
//          to a tile it can jump from, the speed through a teleport (x 1.42, clamped, where the exit turns it);
//   U(c) = max(16 on a boost of that axis, min(16, BASE_DRAG x (V(c) + a(c)))), a(c) = the most push (input x the speed
//          effect, gravity x the gravity multiplier, along the axis and direction) any DELAYED tile within 2 cells can give
//          (the delayed tile is the current tile of 2 ticks before); BASE_DRAG is the largest drag but ice's (ice, fly,
//          gravity effects, a gravity multiplier <= 0: every speed 16 on that axis).
// The excess over the plain sups therefore decays by BASE_DRAG a cell away from every mechanism (a boost's 16 px/tick is
// 11.4 37 cells on). Per cell W(c) = max U over its 3 x 3 (a tick's travel inside a cell belongs to a tick that started
// within one cell of it).
//
// THE LEG BOUND. On a time interval of n ticks the centre's path P satisfies, for any lam in [0, 1],
//   n >= sum over ticks of lam |dx| / W + (1 - lam) (up / Wup + down / Wdn)       (each tick: |dx| <= W, |dy| <= W)
// so n >= the lattice geodesic with edge costs lam 8 / Wx (horizontal), (1 - lam) 8 / Wup (up), (1 - lam) 8 / Wdn (down)
// and the max over lam of it (one lam a leg: a leg is a time interval). Teleports: the tick after the centre is in a
// portal's entry tile it is within one tile of an exit (1 + the field there, one Dijkstra with the exit regions as super
// sources); deaths: DEATH_MIN (54) + the field at the state's respawn (the checkpoint it holds), from every tile that kills
// (anywhere with a timed killer). The trophy: + 1 (the complete fires the tick after the centre is in its cell).
// Gates as the abstract state holds them ('lb' mode: killers passable, keys sticky, death / time doors open, coin gates by
// the start's counts); a leg's start in a gate its touch just shut (the engine defers it while the ball overlaps it)
// escapes through blocked nodes.
//
// THE ORDER. Nodes (S, the trigger just touched, or the start); edges: every relevant trigger whose touch changes S, the
// trophy; coin identities merged by the intersection of the taken coins (an over-approximation of both: admissible), as
// planner.js lowerBound. A* with h = the open-level field to the trophy (every gate open). The bound = the goal's g when
// it is popped, else the least f on the open list when the budget ends (still a bound).
//
// API
//   createRouteLB(L, o) -> {bound(sim, bo) -> {lb, complete, expanded, order, ms}, runBound(bo) -> {lb (run ticks), ...},
//     fieldOf(S, goalNodes, lam), caps, stats()}
//   o: {model, lams (default [0, 0.25, 0.5, 0.75, 1]), memoMB (256)}; bo: {ms (default 5000), maxExpand}
const E = require('../eesim.js');
const B = require('../plan/bounds.js');
const T = require('../plan/types.js');

const C = E.constants;
const BD = C.BASE_DRAG, MULT = C.MULT;
const V_CAP = 16.0;
const JUMP_V = (2 * 26) / MULT;           // 6.708: the jump speed (x the jump effect)
const DEATH_MIN = 54;
const TROPHY = 121;
const F_SOLID = 1, F_CLIMB = 32, F_LIQUID = 64;
const SPEED_LEFT = 114, SPEED_RIGHT = 115, SPEED_UP = 116, SPEED_DOWN = 117, ICE = 1064;
const FX_JUMP = 417, FX_FLY = 418, FX_RUN = 419, FX_LOWGRAV = 453, FX_MULTIJUMP = 461, FX_GRAVITY = 1517;
const CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
const EPS = 1e-6;
const DBG = process.env.EEAT_RLB_DBG === '1';

// ---------------------------------------------------------------- a binary heap (Float64 keys, Int32 values)
class Heap {
	constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
	clear() { this.n = 0; }
	push(key, val) {
		if (this.n >= this.k.length) { const k2 = new Float64Array(this.k.length * 2), v2 = new Int32Array(this.k.length * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
		let i = this.n++;
		const K = this.k, V = this.v;
		while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
		K[i] = key; V[i] = val;
	}
	pop() {
		const K = this.k, V = this.v, top = V[0], n = --this.n;
		if (n > 0) {
			const key = K[n], val = V[n];
			let i = 0;
			for (;;) {
				let c = 2 * i + 1;
				if (c >= n) break;
				if (c + 1 < n && K[c + 1] < K[c]) c++;
				if (K[c] >= key) break;
				K[i] = K[c]; V[i] = V[c]; i = c;
			}
			K[i] = key; V[i] = val;
		}
		return top;
	}
	topKey() { return this.k[0]; }
}

// ---------------------------------------------------------------- the speed caps
/**
 * capsOf(L) -> {Ux, Uup, Udn (Float32Array(N): the speed after the update of a tick starting in the tile), Wx, Wup, Wdn
 * (the 3 x 3 max), why} (see the header; every value at least the align floor 1.2, at most 16)
 */
function capsOf(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, nF = L.gMox.length;
	const flags = L.flags;
	const S = B.staticOf(L);
	const ids = S.ids;
	const why = [];
	const has = (id) => ids.has(id);
	const wgm = L.gravityMult;
	let global16 = false;
	if (!(Number.isFinite(wgm) && wgm > 0)) { global16 = true; why.push('gravity multiplier'); }
	if (has(FX_FLY)) { global16 = true; why.push('fly'); }
	if (has(FX_GRAVITY)) { global16 = true; why.push('gravity effect'); }
	const ice = has(ICE);
	if (ice) why.push('ice');
	const SM = has(FX_RUN) ? 1.5 : 1.0;
	const JM = has(FX_JUMP) ? 1.3 : 1.0;
	const gmax = Math.max(1, Number.isFinite(wgm) ? wgm : 1);
	const gmin = Math.min(has(FX_LOWGRAV) ? 0.15 : 1, Number.isFinite(wgm) && wgm > 0 ? wgm : 1);
	const multi = has(FX_MULTIJUMP);
	const Ux = new Float32Array(N), Uup = new Float32Array(N), Udn = new Float32Array(N);
	if (global16) {
		Ux.fill(V_CAP); Uup.fill(V_CAP); Udn.fill(V_CAP);
		return finish();
	}
	const idOf = (t) => { const id = fg[t]; return id >= 0 && id < nF ? id : 0; };
	const liquid = (id) => (flags[id] & F_LIQUID) !== 0;
	// per tile: the push it gives as a DELAYED tile (px/tick per tick, before the drag), per axis and direction
	const pX = new Float32Array(N), pUp = new Float32Array(N), pDn = new Float32Array(N);
	for (let t = 0; t < N; t++) {
		const id = idOf(t), mox = L.gMox[id], moy = L.gMoy[id], liq = liquid(id);
		// the input acts on an axis where the delayed tile has no gravity along the other one (eesim: liquids both,
		// moy != 0 -> x only, mox != 0 -> y only, else both)
		const inX = liq || moy !== 0 || mox === 0;
		const inY = liq || (moy === 0);
		pX[t] = ((inX ? SM : 0) + Math.abs(mox) * gmax) / MULT;
		// up: gravity pulls down (moy > 0) at least gmin, pushes up (moy < 0) at most gmax
		const gUp = moy > 0 ? -moy * gmin : -moy * gmax;
		pUp[t] = ((inY ? SM : 0) + gUp) / MULT;
		const gDn = moy > 0 ? moy * gmax : moy * gmin;
		pDn[t] = ((inY ? SM : 0) + gDn) / MULT;
	}
	// a(c): the most push over the delayed tiles within 2 cells
	const aX = new Float32Array(N), aUp = new Float32Array(N), aDn = new Float32Array(N);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		let mx = -Infinity, mu = -Infinity, md = -Infinity;
		for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
			const d = yy * W + xx;
			if (pX[d] > mx) mx = pX[d];
			if (pUp[d] > mu) mu = pUp[d];
			if (pDn[d] > md) md = pDn[d];
		}
		const c = y * W + x;
		aX[c] = mx; aUp[c] = mu; aDn[c] = md;
	}
	// sources at a tick START (V): the jumps (set after the movement: the next tick starts within one cell of the tile
	// jumped from), the boosts (U directly), the teleports (copied below)
	const jX = new Float32Array(N), jUp = new Float32Array(N), jDn = new Float32Array(N);
	const boostX = new Uint8Array(N), boostUp = new Uint8Array(N), boostDn = new Uint8Array(N);
	const markJ = (arr, t, v) => {
		const x = t % W, y = (t - x) / W;
		for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) { const c = yy * W + xx; if (arr[c] < v) arr[c] = v; }
	};
	const jv = JUMP_V * JM;
	for (let t = 0; t < N; t++) {
		const id = idOf(t);
		if (id === SPEED_LEFT || id === SPEED_RIGHT) boostX[t] = 1;
		if (id === SPEED_UP) boostUp[t] = 1;
		if (id === SPEED_DOWN) boostDn[t] = 1;
		const morx = L.gMorx[id], mory = L.gMory[id];
		// a jump from this tile as the current one (mor != 0; its delayed tile's mo != 0 too, taken as possible)
		if (morx !== 0) markJ(jX, t, jv);
		if (mory > 0) markJ(jUp, t, jv);
		if (mory < 0) markJ(jDn, t, jv);
	}
	if (multi) { /* air jumps: the jump wherever mory != 0 (already every normal tile) */ }
	// teleports: per portal its entry tiles and exit 3 x 3, rotated or not
	const portals = S.portals || [];
	// the drag of a tick that starts in the tile (eesim: the no-modifier branch BD x NO_MOD, the liquids BD x theirs, a
	// climbable BD x NO_MOD, else BD; the largest of the branches the tile allows; ice: the global rule below)
	const Dg = new Float32Array(N);
	for (let t = 0; t < N; t++) {
		const id = idOf(t);
		let d = BD;
		if (id === 119) d = BD * C.WATER_DRAG;
		else if (id === 369) d = BD * C.MUD_DRAG;
		else if (id === 416) d = BD * C.LAVA_DRAG;
		else if (id === 1585) d = BD * C.TOXIC_DRAG;
		else if ((flags[id] & F_CLIMB) !== 0) d = BD * C.NO_MOD_DRAG;
		// (the no-modifier drag BD x NO_MOD is below BD: the other branch decides)
		Dg[t] = Math.max(d, BD * C.NO_MOD_DRAG) === d ? d : d;
	}
	// the fixpoint (a worklist, values rise from the plain sups)
	const solve = (U, a, jSrc, boost) => {
		const Vs = new Float32Array(N);
		for (let c = 0; c < N; c++) { Vs[c] = jSrc[c]; U[c] = boost[c] ? V_CAP : Math.min(V_CAP, Dg[c] * Math.max(0, Vs[c] + a[c])); }
		// (the plain sup: v -> (v + a) BD from 0 reaches a BD / (1 - BD); the worklist gets there from below)
		const inQ = new Uint8Array(N);
		let q = new Int32Array(N), qn = 0;
		for (let c = 0; c < N; c++) { q[qn++] = c; inQ[c] = 1; }
		let rounds = 0;
		while (qn > 0 && rounds < 4000) {
			rounds++;
			const cur = q.subarray(0, qn).slice();
			qn = 0;
			for (let k = 0; k < cur.length; k++) {
				const c = cur[k];
				inQ[c] = 0;
				const u = U[c];
				const x = c % W, y = (c - x) / W;
				// the next tick starts within one cell: V(n) >= U(c)
				for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
					const n = yy * W + xx;
					if (Vs[n] + EPS < u) {
						Vs[n] = u;
						const un = boost[n] ? V_CAP : Math.min(V_CAP, Dg[n] * Math.max(0, u + a[n]));
						if (un > U[n] + EPS) { U[n] = un; if (!inQ[n]) { inQ[n] = 1; if (qn >= q.length) { const q2 = new Int32Array(q.length * 2); q2.set(q); q = q2; } q[qn++] = n; } }
					}
				}
			}
		}
		return Vs;
	};
	solve(Ux, aX, jX, boostX);
	solve(Uup, aUp, jUp, boostUp);
	solve(Udn, aDn, jDn, boostDn);
	// teleports: an exit's 3 x 3 starts a tick with the entry's speed (x 1.42 where it turns): rotated portals 16, others
	// the entry's caps propagated again (a few rounds; each round from below)
	if (portals.length) {
		let anyRot = false;
		for (const p of portals) if (p.rotated) anyRot = true;
		for (let round = 0; round < 3; round++) {
			let changed = false;
			for (const p of portals) {
				let mx = 0, mu = 0, md = 0;
				for (const t of p.trig) { if (Ux[t] > mx) mx = Ux[t]; if (Uup[t] > mu) mu = Uup[t]; if (Udn[t] > md) md = Udn[t]; }
				if (p.rotated) { const m = Math.min(V_CAP, 1.42 * Math.max(mx, mu, md)); mx = mu = md = m; }
				for (const c of p.near) {
					const ux = Math.min(V_CAP, Dg[c] * (mx + aX[c])), uu = Math.min(V_CAP, Dg[c] * (mu + aUp[c])), ud = Math.min(V_CAP, Dg[c] * (md + aDn[c]));
					if (ux > jX[c]) { jX[c] = Math.max(jX[c], mx); changed = true; }
					if (uu > jUp[c]) { jUp[c] = Math.max(jUp[c], mu); changed = true; }
					if (ud > jDn[c]) { jDn[c] = Math.max(jDn[c], md); changed = true; }
				}
			}
			if (!changed) break;
			solve(Ux, aX, jX, boostX);
			solve(Uup, aUp, jUp, boostUp);
			solve(Udn, aDn, jDn, boostDn);
		}
		void anyRot;
	}
	if (ice) {
		// slippery: the ice's drag keeps more speed and lasts 10 ticks after the ice: every x speed 16 near ice (rows above
		// it within 12 cells, any column within 12): a coarse sound rule
		for (let t = 0; t < N; t++) {
			if (fg[t] !== ICE) continue;
			const x = t % W, y = (t - x) / W;
			for (let yy = Math.max(0, y - 12); yy <= Math.min(H - 1, y + 12); yy++) for (let xx = Math.max(0, x - 12); xx <= Math.min(W - 1, x + 12); xx++) { const c = yy * W + xx; Ux[c] = V_CAP; Uup[c] = V_CAP; Udn[c] = V_CAP; }
		}
	}
	return finish();

	function finish() {
		const flo = (u) => Math.max(u, 1.2) * (1 + 1e-9) + 1e-9;
		for (let c = 0; c < N; c++) { Ux[c] = flo(Ux[c]); Uup[c] = flo(Uup[c]); Udn[c] = flo(Udn[c]); }
		const Wx = new Float32Array(N), Wup = new Float32Array(N), Wdn = new Float32Array(N);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let a = 0, b = 0, d = 0;
			for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
				const n = yy * W + xx;
				if (Ux[n] > a) a = Ux[n];
				if (Uup[n] > b) b = Uup[n];
				if (Udn[n] > d) d = Udn[n];
			}
			const c = y * W + x;
			Wx[c] = a; Wup[c] = b; Wdn[c] = d;
		}
		return { Ux, Uup, Udn, Wx, Wup, Wdn, why, global16 };
	}
}

// ---------------------------------------------------------------- the route bound
function createRouteLB(L, o = {}) {
	const t0 = Date.now();
	const W = L.width, H = L.height, N = W * H;
	const model = o.model || require('../plan/model.js').compileModel(L, {});
	const SB = B.staticOf(L);
	const caps = o.caps || capsOf(L);
	const LW = 2 * W, LH = 2 * H, NL = LW * LH;
	const lams = o.lams || [0, 0.25, 0.5, 0.75, 1];
	const st = { fields: 0, fieldMs: 0, hits: 0, searches: 0, expanded: 0, escapes: 0 };
	// per node: the edge costs (ticks per lattice step at lam = 1 / at 1 - lam = 1): right edge (n -> n + 1), the vertical
	// edge between n and n + LW (up: n + LW -> n, down: n -> n + LW)
	const hx = new Float32Array(NL), hu = new Float32Array(NL), hd = new Float32Array(NL);
	{
		const cellW = (arr, i, j) => {
			// the cells the segment touches: cols of its x span, rows of its y (on a row boundary both rows)
			let m = 0;
			const cx = Math.min(W - 1, Math.max(0, i >> 1)), rows = (j & 1) === 0 ? [(j >> 1) - 1, j >> 1] : [j >> 1];
			for (const ry of rows) { if (ry < 0 || ry >= H) continue; const v = arr[ry * W + cx]; if (v > m) m = v; }
			return m > 0 ? m : V_CAP;
		};
		const cellWv = (arr, i, j) => {
			// a vertical segment from (i, j) to (i, j + 1): rows of its y span (j >> 1), cols of its x (on a col boundary both)
			let m = 0;
			const ry = Math.min(H - 1, Math.max(0, j >> 1)), cols = (i & 1) === 0 ? [(i >> 1) - 1, i >> 1] : [i >> 1];
			for (const cx of cols) { if (cx < 0 || cx >= W) continue; const v = arr[ry * W + cx]; if (v > m) m = v; }
			return m > 0 ? m : V_CAP;
		};
		for (let j = 0; j < LH; j++) for (let i = 0; i < LW; i++) {
			const n = j * LW + i;
			hx[n] = 8 / cellW(caps.Wx, i, j);
			hu[n] = 8 / cellWv(caps.Wup, i, j);
			hd[n] = 8 / cellWv(caps.Wdn, i, j);
		}
	}
	// ---- the tile mask -> the node mask
	/** nodeBlockedOf(m) -> Uint8Array(NL): node (i, j) blocked iff a tile in cols(i) x rows(j) has m[t] === 0 */
	const nbMemo = new Map();
	function nodeBlockedOf(m, key) {
		const had = key ? nbMemo.get(key) : null;
		if (had) return had;
		const nb = new Uint8Array(NL);
		for (let j = 0; j < LH; j++) {
			const r0 = (j & 1) === 0 ? (j >> 1) - 1 : (j >> 1), r1 = j >> 1;
			for (let i = 0; i < LW; i++) {
				const c0 = (i & 1) === 0 ? (i >> 1) - 1 : (i >> 1), c1 = i >> 1;
				let b = 0;
				for (let ry = r0; ry <= r1 && !b; ry++) {
					if (ry < 0 || ry >= H) continue;
					for (let cx = c0; cx <= c1; cx++) { if (cx < 0 || cx >= W) continue; if (m[ry * W + cx] === 0) { b = 1; break; } }
				}
				nb[j * LW + i] = b;
			}
		}
		if (key) { nbMemo.set(key, nb); if (nbMemo.size > 64) nbMemo.delete(nbMemo.keys().next().value); }
		return nb;
	}
	// ---- regions
	const touchersOf = (t) => SB.touchers(t);
	/** the lattice nodes of a tile set (each tile and its half-block touchers: their 2 x 2 nodes) */
	function regionNodes(tiles) {
		const out = new Set();
		for (const t0 of tiles) for (const t of touchersOf(t0)) {
			const x = t % W, y = (t - x) / W;
			for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) out.add((2 * y + dj) * LW + 2 * x + di);
		}
		return Int32Array.from(out);
	}
	const trophyTiles = [];
	for (let i = 0; i < N; i++) if (L.fg[i] === TROPHY) trophyTiles.push(i);
	const trophyNodes = regionNodes(trophyTiles);
	// portals: the entry region -> the exit 3 x 3 region
	const ports = (SB.portals || []).map((p) => ({ entry: regionNodes(Array.from(p.trig)), exit: regionNodes(Array.from(p.near)) }));
	const exitOf = new Map();   // node -> [portal index]
	ports.forEach((p, k) => { for (const n of p.exit) { const l = exitOf.get(n); if (l) l.push(k); else exitOf.set(n, [k]); } });
	// deaths: the tiles that kill (the tile or the half block's current tile; everywhere with a timed killer)
	const dieNodes = (() => {
		if (!SB.deaths) return null;
		return regionNodes(Array.from(SB.dsrc));
	})();
	const respawnNodesOf = new Map();
	function respawnNodes(S) {
		const p = model.respawnOf(S, 'lb');
		const k = p.id;
		let r = respawnNodesOf.get(k);
		if (!r) { r = { nodes: regionNodes(p.tiles), set: null }; r.set = new Set(r.nodes); respawnNodesOf.set(k, r); }
		return r;
	}
	// ---- fields
	const memo = new Map();
	const memoMax = Math.max(16, Math.floor((o.memoMB || 256) * 1048576 / (4 * NL)));
	const heap = new Heap(1 << 16);
	const scratch = new Float64Array(NL);
	/**
	 * field(nb, goalNodes, lam, respawn, goalKey) -> Float32Array(NL): the least weighted travel (ticks) from each node to
	 * the goal region, through free nodes; portals and deaths as super edges (one Dijkstra: an exit region's first popped
	 * node fires its portals' entries at + 1, the respawn region's first popped node fires every death node at + 54)
	 */
	function field(nb, nbKey, goalNodes, goalKey, lam, resp) {
		const key = nbKey + '|' + goalKey + '|' + lam + '|' + (resp ? resp.key : '-');
		const had = memo.get(key);
		if (had) { st.hits++; memo.delete(key); memo.set(key, had); return had; }
		const tq = Date.now();
		// (the search in doubles; the kept field in floats rounded DOWN: a float32 key compared with a double went round in
		// circles on zero-cost edges)
		const dist = scratch;
		dist.fill(Infinity);
		const lx = lam, ly = 1 - lam;
		heap.clear();
		for (const g of goalNodes) { if (dist[g] > 0) { dist[g] = 0; heap.push(0, g); } }
		const fired = new Uint8Array(ports.length);
		let dieFired = !resp || !dieNodes;
		const respSet = resp ? resp.set : null;
		while (heap.n > 0) {
			const d = heap.topKey(), m = heap.pop();
			if (d > dist[m]) continue;
			// super edges
			if (ports.length) {
				const l = exitOf.get(m);
				if (l) for (const k of l) {
					if (fired[k]) continue;
					fired[k] = 1;
					const v = d + 1;
					for (const e of ports[k].entry) if (v < dist[e]) { dist[e] = v; heap.push(v, e); }
				}
			}
			if (!dieFired && respSet.has(m)) {
				dieFired = true;
				const v = d + DEATH_MIN;
				for (const e of dieNodes) if (v < dist[e]) { dist[e] = v; heap.push(v, e); }
			}
			// lattice moves into m from its 4 neighbours n (n -> m forward), n free
			const i = m % LW, j = (m - i) / LW;
			if (i > 0) { const n = m - 1; if (!nb[n]) { const v = d + lx * hx[n]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }          // n moves right into m
			if (i + 1 < LW) { const n = m + 1; if (!nb[n]) { const v = d + lx * hx[m]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }  // n moves left into m
			if (j > 0) { const n = m - LW; if (!nb[n]) { const v = d + ly * hd[n]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }        // n moves down into m
			if (j + 1 < LH) { const n = m + LW; if (!nb[n]) { const v = d + ly * hu[m]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }   // n moves up into m
		}
		const out = new Float32Array(NL);
		for (let n = 0; n < NL; n++) {
			const v = dist[n];
			let f = Math.fround(v);
			if (f > v) f = Math.fround(v - Math.max(1e-6, Math.abs(v) * 2.4e-7));
			out[n] = f;
		}
		st.fields++; st.fieldMs += Date.now() - tq;
		memo.set(key, out);
		if (memo.size > memoMax) memo.delete(memo.keys().next().value);
		return out;
	}
	/** a blocked start node (a gate the touch just shut, deferred while the ball overlaps it): the least over the free
	 *  nodes reachable through blocked ones of the moves' cost + the field there (a local Dijkstra, <= 4096 nodes; past
	 *  that 0: no claim) */
	const escHeap = new Heap(256);
	function escape(dist, nb, start, lam) {
		st.escapes++;
		const lx = lam, ly = 1 - lam;
		const seen = new Map();
		escHeap.clear();
		seen.set(start, 0); escHeap.push(0, start);
		let best = Infinity, pops = 0;
		while (escHeap.n > 0) {
			const d = escHeap.topKey(), n = escHeap.pop();
			if (d >= best) break;
			if (d > seen.get(n)) continue;
			if (++pops > 4096) return 0;
			if (!nb[n]) { const v = d + dist[n]; if (v < best) best = v; continue; }
			const i = n % LW, j = (n - i) / LW;
			const step = (m, w) => { const v = d + w; const s = seen.get(m); if (s === undefined || v < s) { seen.set(m, v); escHeap.push(v, m); } };
			if (i + 1 < LW) step(n + 1, lx * hx[n]);
			if (i > 0) step(n - 1, lx * hx[n - 1]);
			if (j + 1 < LH) step(n + LW, ly * hd[n]);
			if (j > 0) step(n - LW, ly * hu[n - LW]);
		}
		return best;
	}
	// ---- the abstract graph
	const trig = model.triggers.filter((X) => X.relevant && X.kind !== 'trophy');
	const trigNodes = new Map(trig.map((X) => [X.id, regionNodes(X.tiles)]));
	const nbKeyOf = (S) => { const m = model.passMask(S, 'lb', null); return { m, key: maskKey(m) }; };
	const mkMemo = new WeakMap();
	function maskKey(m) {
		let k = mkMemo.get(m);
		if (k) return k;
		let h1 = 0x811c9dc5, h2 = 0x9747b28c;
		for (let i = 0; i < m.length; i++) { h1 ^= m[i]; h1 = Math.imul(h1, 0x01000193); h2 = Math.imul(h2 ^ m[i], 0x5bd1e995); h2 ^= h2 >>> 15; }
		k = (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
		mkMemo.set(m, k);
		return k;
	}
	const respKey = (S) => { const r = respawnNodes(S); r.key = r.key || ('r' + model.respawnOf(S, 'lb').id); return r; };
	// the open level (every gate open: static walls only): the A* heuristic to the trophy
	const openMask = (() => { const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = model.A.cls[i] === 0 ? 0 : 1; return m; })();
	const openNb = nodeBlockedOf(openMask, 'open');
	// (the open level's respawns: every respawn tile, the relaxation's)
	const respAll = (() => { const t = model.respawn || []; const nodes = regionNodes(t); return { nodes, set: new Set(nodes), key: 'rall' }; })();
	function hOpen(nodes, startCorr) {
		let best = 0;
		for (const lam of lams) {
			const f = field(openNb, 'open', trophyNodes, 'trophy', lam, SB.deaths ? respAll : null);
			let m = Infinity;
			for (const n of nodes) if (f[n] < m) m = f[n];
			if (startCorr) m -= startCorr(lam);
			if (m > best) best = m;
		}
		return best === Infinity ? Infinity : best + 1;
	}
	/** the leg's bound: max over lam of min over the from-nodes of the field to the goal nodes under S */
	function legCost(S, nbInfo, fromNodes, goalNodes, goalKey, startCorr) {
		const resp = SB.deaths ? respKey(S) : null;
		let best = 0, any = false;
		for (const lam of lams) {
			const f = field(nbInfo.nb, nbInfo.key, goalNodes, goalKey, lam, resp);
			let m = Infinity;
			for (const n of fromNodes) {
				let v = f[n];
				if (nbInfo.nb[n]) v = escape(f, nbInfo.nb, n, lam);
				if (v < m) m = v;
			}
			if (m === Infinity) return Infinity;
			if (startCorr) m -= startCorr(lam);
			any = true;
			if (m > best) best = m;
		}
		return any ? Math.max(0, best) : Infinity;
	}
	const nbOfS = (S) => {
		const { m, key } = nbKeyOf(S);
		return { nb: nodeBlockedOf(m, key), key };
	};
	const andBits = (x, y) => { if (!x) return x; const o2 = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) o2[i] = x[i] & y[i]; return o2; };
	const sameBits = (x, y) => { if (!x) return true; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
	/**
	 * bound(sim, bo) -> {lb (ticks until has_silver_crown at the earliest; Infinity: none in the relaxation), complete,
	 * expanded, order, ms}. The state's own abstract state (its pending changes too: the least of both).
	 */
	function bound(sim, bo = {}) {
		const tq = Date.now();
		st.searches++;
		if (sim.has_silver_crown) return { lb: 0, complete: true, expanded: 0, order: [], ms: 0 };
		let S = model.stateOf(sim);
		const pend = model.pendingOf ? model.pendingOf(sim, S) : null;
		// the start node: the centre floored to the lattice; the floor offset's cost subtracted (it moves right / down)
		let cx = sim.px + 8, cy = sim.py + 8, extra = 0;
		if (sim.is_dead) {
			// dead: the respawn of its state after the dead ticks left (Player.tick: dead_offset + 0.3 a tick past 16)
			const left = Math.max(0, Math.floor((16.0 - sim._dead_offset) / 0.3 - 1e-9));
			const r = model.respawnOf(S, 'lb');
			let best = Infinity;
			for (const t of r.tiles) {
				const v = boundFromNodes(S, regionNodes([t]), null, bo).lb;
				if (v < best) best = v;
			}
			return { lb: best === Infinity ? Infinity : best + left, complete: true, expanded: 0, order: [], ms: Date.now() - tq, dead: true };
		}
		const i0 = Math.max(0, Math.min(LW - 1, Math.floor(cx / 8))), j0 = Math.max(0, Math.min(LH - 1, Math.floor(cy / 8)));
		const dx = Math.max(0, cx - 8 * i0), dy = Math.max(0, cy - 8 * j0);
		const c0 = Math.max(0, Math.min(W - 1, i0 >> 1)) + W * Math.max(0, Math.min(H - 1, j0 >> 1));
		const startCorr = (lam) => lam * dx / caps.Wx[c0] + (1 - lam) * dy / caps.Wdn[c0];
		const nodes = Int32Array.of(j0 * LW + i0);
		const r1 = boundFromNodes(S, nodes, startCorr, bo);
		if (pend) {
			const r2 = boundFromNodes(pend, nodes, startCorr, bo);
			if (r2.lb < r1.lb) { r2.pending = true; r2.ms = Date.now() - tq; return r2; }
		}
		r1.ms = Date.now() - tq;
		void extra;
		return r1;
	}
	function boundFromNodes(S0, startNodes, startCorr, bo) {
		const ms = bo.ms !== undefined ? bo.ms : 5000, maxExpand = bo.maxExpand || 200000;
		const tq = Date.now();
		const open = [];   // a heap of {f, g, S, pos, nodes, path}
		const hpush = (x) => { open.push(x); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p].f <= x.f) break; open[i] = open[p]; i = p; } open[i] = x; };
		const hpop = () => { const top = open[0], last = open.pop(); if (open.length) { let i = 0; const n = open.length; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && open[c + 1].f < open[c].f) c++; if (open[c].f >= last.f) break; open[i] = open[c]; i = c; } open[i] = last; } return top; };
		const best = new Map();
		const mkey = (S, pos) => S.dkey + '|c' + S.cp + '#' + pos;
		const h0 = hOpen(startNodes, startCorr);
		if (h0 === Infinity) return { lb: Infinity, complete: true, expanded: 0, order: [], why: 'no way to the trophy on the open level' };
		hpush({ f: h0, g: 0, S: S0, pos: -1, nodes: startNodes, corr: startCorr, path: null, goal: false });
		best.set(mkey(S0, -1), { g: 0, S: S0 });
		let expanded = 0, goal = null, cut = false;
		while (open.length) {
			const n = hpop();
			if (n.goal) { goal = n; break; }
			const rec = best.get(mkey(n.S, n.pos));
			if (rec && (rec.g < n.g || rec.S !== n.S)) continue;
			if (expanded >= maxExpand || Date.now() - tq > ms) { hpush(n); cut = true; break; }
			expanded++;
			if (DBG) console.error(`rlb expand ${expanded} g ${n.g.toFixed(1)} f ${n.f.toFixed(1)} pos ${n.pos} S ${n.S.key} open ${open.length}`);
			const nbInfo = nbOfS(n.S);
			// the trophy
			const lt = legCost(n.S, nbInfo, n.nodes, trophyNodes, 'trophy', n.corr);
			if (lt < Infinity) hpush({ f: n.g + lt + 1, g: n.g + lt + 1, S: n.S, pos: -2, nodes: null, path: { X: 'trophy', prev: n.path, g: n.g + lt + 1 }, goal: true });
			for (const X of trig) {
				const r = model.touch(n.S, X);
				if (!r.changed) continue;
				const tn = trigNodes.get(X.id);
				const leg = legCost(n.S, nbInfo, n.nodes, tn, 't' + X.id, n.corr);
				if (leg === Infinity) continue;
				const g2 = n.g + leg;
				const k2 = mkey(r.S2, X.id);
				const had = best.get(k2);
				let S2 = r.S2, gm = g2;
				if (had) {
					const tk = andBits(had.S.taken, S2.taken), btk = andBits(had.S.btaken, S2.btaken);
					const wider = !sameBits(tk, had.S.taken) || !sameBits(btk, had.S.btaken);
					if (!wider && had.g <= g2) continue;
					gm = Math.min(had.g, g2);
					if (wider || had.g > g2) S2 = model.mkState(S2.vals, tk, btk, S2.cp);
				}
				best.set(k2, { g: gm, S: S2 });
				const h = hOpen(tn, null);
				if (h === Infinity) continue;
				hpush({ f: gm + h, g: gm, S: S2, pos: X.id, nodes: tn, corr: null, path: { X: X.label, prev: n.path, g: gm }, goal: false });
			}
		}
		st.expanded += expanded;
		let lb, complete = false, order = [];
		if (goal) { lb = goal.g; complete = true; for (let p = goal.path; p; p = p.prev) order.push(`${p.X} @${Math.round(p.g)}`); order.reverse(); }
		else if (!open.length) { lb = Infinity; complete = true; }
		else { lb = Infinity; for (const x of open) if (x.f < lb) lb = x.f; }
		return { lb, complete, expanded, order, cut, ms: Date.now() - tq };
	}
	/**
	 * runBound(bo) -> {lb (RUN ticks from the level start), idle, starts, at}: the timer starts at the end of the first
	 * tick with an input and the ball follows its idle trajectory for free before it, so a route whose first input is at
	 * tick k finishes >= bound(idle state k) - 1 run ticks after the timer's start: the least over the idle trajectory
	 * until it rests (its state hash repeats); no claim (0) when it does not rest within bo.idleMax (3000) ticks
	 */
	function runBound(bo = {}) {
		const idleMax = bo.idleMax || 3000;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset(); E.applyMask(inp, 0);
		let h = sim.stateHash(), rests = -1;
		for (let k = 0; k <= idleMax; k++) {
			if (sim.has_silver_crown) return { lb: 0, why: 'the idle ball finishes', idle: k };
			sim.tick(inp);
			const h2 = sim.stateHash();
			if (h2 === h && !sim.is_dead) { rests = k; break; }
			h = h2;
		}
		if (rests < 0) return { lb: 0, why: `the idle ball does not rest within ${idleMax} ticks`, idle: -1 };
		sim.reset();
		let lb = Infinity, at = -1, starts = 0, last = null, lastKey = '';
		for (let k = 0; k <= rests; k++) {
			// (consecutive idle states in one abstract state at one lattice node give the same bound but the offset: computed)
			const r = bound(sim, bo);
			starts++;
			const v = r.lb === Infinity ? Infinity : r.lb - 1;
			if (v < lb) { lb = v; at = k; last = r; }
			void lastKey;
			if (k < rests) sim.tick(inp);
		}
		return { lb: lb === Infinity ? Infinity : Math.max(0, Math.ceil(lb - 1e-6)), lbRaw: lb, at, starts, idle: rests, order: last ? last.order : [], complete: last ? last.complete : false };
	}
	const setupMs = Date.now() - t0;
	return { bound, runBound, field, nodeBlockedOf, regionNodes, caps, model, lams, LW, LH, stats: () => Object.assign({ setupMs }, st), trophyNodes };
}

module.exports = { createRouteLB, capsOf, Heap };
