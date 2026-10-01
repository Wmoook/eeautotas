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
const EG = require('../endgame.js');

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
function capsOf(L, copt = {}) {
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
	// the pushes by how long the ball has been in its cell: the DELAYED tile is the current tile of 2 ticks before, so
	// the tick it arrives (phase 0) the push comes from within 2 cells, the next tick (phase 1, it stayed) from within 1
	// (the cell it came from), and from then on (phase 2) from its own tile: a ball that stays next to water or an arrow
	// does not keep the water's or the arrow's push (the worklist without phases raised every cell next to one to that
	// push's terminal speed)
	const r1max = (arr) => {
		const out = new Float32Array(N);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let m = -Infinity;
			for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) { const v = arr[yy * W + xx]; if (v > m) m = v; }
			out[y * W + x] = m;
		}
		return out;
	};
	// the fixpoint over (cell, phase) (a worklist, values rise from below; the tick's movement speed U = drag x (V + push))
	const aMax = (2 * gmax + SM) / MULT + 0.01;
	const PH2 = (16 + 0.4 + aMax) / 2 + 0.01;   // (+ 0.4: the auto-align moves up to 0.2 px a tick below 1 px/tick)
	const solve = (U, a2, own, jSrc, boost) => {
		const a1 = r1max(own);
		const V = new Float32Array(3 * N), Uq = new Float32Array(3 * N);
		const uOf = (c, ph, v) => boost[c] ? V_CAP : Math.min(V_CAP, Dg[c] * Math.max(0, v + (ph === 0 ? a2[c] : ph === 1 ? a1[c] : own[c])));
		for (let c = 0; c < N; c++) for (let ph = 0; ph < 3; ph++) { V[3 * c + ph] = jSrc[c]; Uq[3 * c + ph] = uOf(c, ph, jSrc[c]); }
		const inQ = new Uint8Array(3 * N);
		let q = new Int32Array(3 * N), qn = 0;
		for (let s = 0; s < 3 * N; s++) { q[qn++] = s; inQ[s] = 1; }
		const raise = (s, v) => {
			// (phase 2: the ball began 2 ticks in this cell; along the axis it moved its speed each tick (a wall zeroes it), so
			// u(k-2) + u(k-1) < 16 with u(k-1) <= u(k-2) + the most push: the speed it starts phase 2 with is below PH2)
			if (s % 3 === 2 && !boost[(s / 3) | 0] && v > PH2) v = PH2;
			if (V[s] + EPS >= v) return;
			V[s] = v;
			const c = (s / 3) | 0, ph = s - 3 * c;
			const un = uOf(c, ph, v);
			if (un > Uq[s] + EPS) { Uq[s] = un; if (!inQ[s]) { inQ[s] = 1; if (qn >= q.length) { const q2 = new Int32Array(q.length * 2); q2.set(q); q = q2; } q[qn++] = s; } }
		};
		let rounds = 0;
		while (qn > 0 && rounds < 4000) {
			rounds++;
			const cur = q.subarray(0, qn).slice();
			qn = 0;
			for (let k = 0; k < cur.length; k++) {
				const s = cur[k];
				inQ[s] = 0;
				const u = Uq[s];
				const c = (s / 3) | 0, ph = s - 3 * c;
				const x = c % W, y = (c - x) / W;
				// the next tick: in a neighbour (phase 0) or the same cell (phase + 1, at most 2)
				for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
					const n = yy * W + xx;
					if (n === c) raise(3 * c + (ph < 2 ? ph + 1 : 2), u);
					else raise(3 * n, u);
				}
			}
		}
		for (let c = 0; c < N; c++) U[c] = Math.max(Uq[3 * c], Uq[3 * c + 1], Uq[3 * c + 2]);
		return V;
	};
	solve(Ux, aX, pX, jX, boostX);
	solve(Uup, aUp, pUp, jUp, boostUp);
	solve(Udn, aDn, pDn, jDn, boostDn);
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
			solve(Ux, aX, pX, jX, boostX);
			solve(Uup, aUp, pUp, jUp, boostUp);
			solve(Udn, aDn, pDn, jDn, boostDn);
		}
		void anyRot;
	}
	// THE CROSSING DP (per axis direction, any row / column: a relaxation of where the pushes are): the worklist above lets
	// a push region raise a cell by staying in it (its self-loop and same-column moves), so a few side arrows raised whole
	// regions to 16 px/tick; a ball moving right at speed u stays < 16 / u ticks in a column (it moves >= u px a tick
	// until a wall zeroes it), so the speed it can gain there is what crossing the column's 16 px with the column's most
	// push gives. s_in(x) = the speed entering column x moving right (0: a run starts at rest: a reversal passes through
	// 0, a respawn is at rest), s_out(x) = the most exit speed over entry speeds <= s_in(x) (a 0.25 grid and s_in itself),
	// a boost of that direction 16, a portal exit the entry's speed (x 1.42 turned). The cap of a cell is the least of the
	// worklist's and its column's (both sound).
	if (!copt.noCross) {
		const crossCap = (len, pushAt, boostAt, startAt, D) => {
			// pushAt(i) / boostAt(i) / startAt(i): the push / a boost of the run's direction / a teleport's start speed in
			// line i (0..len-1, in the run's order)
			const cap = new Float32Array(len);
			let sin = 0;
			const sim = (s0, a) => {
				let s = s0, x = 0, mx = s0;
				for (let k = 0; k < 400 && x < 16; k++) { s = Math.min(V_CAP, (s + a) * D); if (s <= 1e-9) return { out: 0, mx }; x += s; if (s > mx) mx = s; }
				return { out: s, mx };
			};
			for (let i = 0; i < len; i++) {
				const a = pushAt(i);
				const s0 = Math.max(sin, startAt(i));
				let out = 0, mx = s0;
				if (boostAt(i)) { out = V_CAP; mx = V_CAP; }
				else {
					for (let s = 0; ; s = Math.min(s0, s + 0.25)) {
						const r = sim(s, a);
						if (r.out > out) out = r.out;
						if (r.mx > mx) mx = r.mx;
						if (s >= s0) break;
					}
				}
				cap[i] = Math.max(mx, out);
				// (a run that starts in this line (a jump, a teleport) may start at its far edge: the next line gets that speed)
				sin = Math.max(out, startAt(i));
			}
			return cap;
		};
		// x: per column the most push toward +x / -x over its cells (the delayed tile within 2 cells: aX's own dilation;
		// the sign: input both ways, gravity by mox's sign)
		const pR = new Float32Array(W), pL = new Float32Array(W), bR = new Uint8Array(W), bL = new Uint8Array(W);
		for (let x = 0; x < W; x++) { pR[x] = -Infinity; pL[x] = -Infinity; }
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let r = -Infinity, l = -Infinity;
			for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
				const d = yy * W + xx, id = idOf(d), mox = L.gMox[id], moy = L.gMoy[id], liq = liquid(id);
				const inX = liq || moy !== 0 || mox === 0;
				const vr = ((inX ? SM : 0) + (mox > 0 ? mox * gmax : mox * gmin)) / MULT;
				const vl = ((inX ? SM : 0) + (mox < 0 ? -mox * gmax : -mox * gmin)) / MULT;
				if (vr > r) r = vr;
				if (vl > l) l = vl;
			}
			if (r > pR[x]) pR[x] = r;
			if (l > pL[x]) pL[x] = l;
			const id = idOf(y * W + x);
			if (id === SPEED_RIGHT) bR[x] = 1;
			if (id === SPEED_LEFT) bL[x] = 1;
		}
		// (portals: a column holding an exit gets the speed of any entry: the DP's start there is at most the worklist's
		// cap at the exit, which already holds the teleported speeds; a portal level keeps the worklist alone where higher
		// is impossible to tell: the DP's start in an exit column is that cap)
		const exitCol = new Float32Array(W);
		for (const p of portals) for (const c of p.near) { const x = c % W; if (Ux[c] > exitCol[x]) exitCol[x] = Ux[c]; }
		// (a horizontal jump from a side-gravity tile sets the x speed: a start of its column too)
		for (let c = 0; c < N; c++) { const x = c % W; if (jX[c] > exitCol[x]) exitCol[x] = jX[c]; }
		const capR = crossCap(W, (i) => pR[i], (i) => bR[i], (i) => exitCol[i], BD);
		const capL = crossCap(W, (i) => pL[W - 1 - i], (i) => bL[W - 1 - i], (i) => exitCol[W - 1 - i], BD);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			const colCap = Math.max(capR[x], capL[W - 1 - x]);
			if (colCap < Ux[c]) Ux[c] = colCap;
		}
		// up: per row the most upward push (gravity up, input in zero-gravity / liquids), a jump or an up boost as the
		// row's start, crossing upward (bottom to top)
		const pU = new Float32Array(H), jRow = new Float32Array(H), bU = new Uint8Array(H);
		for (let y = 0; y < H; y++) pU[y] = -Infinity;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const c = y * W + x;
			if (aUp[c] > pU[y]) pU[y] = aUp[c];
			if (jUp[c] > jRow[y]) jRow[y] = jUp[c];
			if (idOf(c) === SPEED_UP) bU[y] = 1;
		}
		const exitRow = new Float32Array(H);
		for (const p of portals) for (const c of p.near) { const y = Math.floor(c / W); if (Uup[c] > exitRow[y]) exitRow[y] = Uup[c]; }
		// (the up DP: a row's start speed is the most of the run from below and the jump / teleport there; a run starts at
		// rest anywhere too)
		{
			const cap = new Float32Array(H);
			let sin = 0;
			for (let i = 0; i < H; i++) {
				const y = H - 1 - i;
				const a = pU[y];
				const s0 = Math.max(sin, jRow[y], exitRow[y]);
				let out = 0, mx = s0;
				if (bU[y]) { out = V_CAP; mx = V_CAP; }
				else {
					for (let s = 0; ; s = Math.min(s0, s + 0.25)) {
						let v = s, pos = 0, m2 = s;
						for (let k = 0; k < 400 && pos < 16; k++) { v = Math.min(V_CAP, (v + a) * BD); if (v <= 1e-9) { v = 0; break; } pos += v; if (v > m2) m2 = v; }
						if (pos >= 16 && v > out) out = v;
						if (m2 > mx) mx = m2;
						if (s >= s0) break;
					}
				}
				cap[y] = Math.max(mx, out);
				// (a jump or a teleport in this row may start at its top edge: the row above gets that speed)
				sin = Math.max(out, jRow[y], exitRow[y]);
			}
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = y * W + x; if (cap[y] < Uup[c]) Uup[c] = cap[y]; }
		}
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
	let openNbRef = null;   // (the nodes the static walls block: set below with the open level's mask)
	function escape(dist, nb, start, lam) {
		// (a node a STATIC wall blocks holds no ball: no value; the escape goes only through nodes a gate blocks: the
		// ball overlapping a gate its touch shut, which the engine keeps open until it has left it)
		if (openNbRef[start]) return Infinity;
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
			if (openNbRef[n]) continue;
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
	// (the crumbs, coins no gate reads that EEAT_CRUMBS makes relevant for the planner's relays, are left out: a route may
	// skip them, and leaving a trigger out is a relaxation)
	const trig = model.triggers.filter((X) => X.relevant && !X.crumb && X.kind !== 'trophy');
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
	// the endgame's kinematic bound contexts per goal (trophy: its own; a trigger: its tiles)
	let primB = null;   // (the primitives' bounds, made on the first start leg)
	const egMemo = new Map();
	function egCtx(goalKey, tiles) {
		let c = egMemo.get(goalKey);
		if (!c) { c = goalKey === 'trophy' ? EG.boundContext(L) : EG.boundContext(L, { goals: Array.from(tiles) }); egMemo.set(goalKey, c); if (egMemo.size > 256) egMemo.delete(egMemo.keys().next().value); }
		return c;
	}
	// the open level (every gate open: static walls only): the A* heuristic to the trophy
	const openMask = (() => { const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = model.A.cls[i] === 0 ? 0 : 1; return m; })();
	const openNb = nodeBlockedOf(openMask, 'open');
	openNbRef = openNb;
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
				const v = boundFromNodes(S, regionNodes([t]), null, Object.assign({}, bo, { walkTiles: [t] })).lb;
				if (v < best) best = v;
			}
			return { lb: best === Infinity ? Infinity : best + left, complete: true, expanded: 0, order: [], ms: Date.now() - tq, dead: true };
		}
		const i0 = Math.max(0, Math.min(LW - 1, Math.floor(cx / 8))), j0 = Math.max(0, Math.min(LH - 1, Math.floor(cy / 8)));
		const dx = Math.max(0, cx - 8 * i0), dy = Math.max(0, cy - 8 * j0);
		const c0 = Math.max(0, Math.min(W - 1, i0 >> 1)) + W * Math.max(0, Math.min(H - 1, j0 >> 1));
		const startCorr = (lam) => lam * dx / caps.Wx[c0] + (1 - lam) * dy / caps.Wdn[c0];
		const nodes = Int32Array.of(j0 * LW + i0);
		const bo2 = Object.assign({}, bo, { startSim: sim, walkTiles: [T.tileOf(sim, W, H)] });
		const r1 = boundFromNodes(S, nodes, startCorr, bo2);
		if (pend) {
			const r2 = boundFromNodes(pend, nodes, startCorr, bo2);
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
		hpush({ f: h0, g: 0, S: S0, pos: -1, nodes: startNodes, corr: startCorr, path: null, goal: false, wpos: bo.walkTiles ? { id: 'rlw' + bo.walkTiles.join(','), tiles: bo.walkTiles } : null });
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
			// (the start leg from an exact state: also the endgame's kinematic envelope from its own speed (walls ignored,
			// acceleration from the state's speed), a way through a death at least DEATH_MIN + the field from a respawn)
			const sim0 = n.pos === -1 && bo.startSim ? bo.startSim : null;
			const kin = (fieldLeg, goalTiles, goalKey, goalNodes) => {
				if (!sim0 || !(fieldLeg < Infinity)) return fieldLeg;
				const B = egCtx(goalKey, goalTiles);
				const lim = Math.min(4000, Math.ceil(fieldLeg) + 600);
				let eg = EG.lowerBound(B, sim0, lim);
				if (SB.deaths) {
					// (a way through a death: >= DEATH_MIN + the bound from the respawn; max over lam of the least over its nodes)
					const resp = respKey(n.S);
					let alt = 0;
					for (const lam of lams) {
						const f = field(nbInfo.nb, nbInfo.key, goalNodes, goalKey, lam, resp);
						let m = Infinity;
						for (const r of resp.nodes) if (f[r] < m) m = f[r];
						if (m > alt) alt = m;
					}
					if (DEATH_MIN + alt < eg) eg = DEATH_MIN + alt;
				}
				// (and the primitives' bound from the exact state (bounds.js leg: the doors as the state holds them, which a leg does
				// not change; its plain layer and its own endgame part), the larger)
				let bl = 0;
				try { if (!primB) primB = B.createBounds(L, { model }); const v = primB.leg(sim0, goalKey === 'trophy' ? { kind: 'trophy', tiles: goalTiles } : { kind: 'trigger', tiles: Array.from(goalTiles) }); if (Number.isFinite(v)) bl = goalKey === 'trophy' ? v - 1 : v; } catch (e) { bl = 0; }
				return Math.max(fieldLeg, eg, bl);
			};
			// (the planner's walk bound of the same leg: the 8-way tile walk at 16.25 px/tick, the death shortcut to the state's
			// respawn (model.pairLb, 'lb' mode): a sound relaxation of its own; the leg is the larger)
			const walk = (goalTiles) => { if (!n.wpos) return 0; try { const v = model.pairLb(n.S, n.wpos, goalTiles, 'lb', null); return Number.isFinite(v) || v === Infinity ? v : 0; } catch (e) { return 0; } };
			// the trophy
			const lt = Math.max(kin(legCost(n.S, nbInfo, n.nodes, trophyNodes, 'trophy', n.corr), trophyTiles, 'trophy', trophyNodes), walk(trophyTiles));
			if (lt < Infinity) hpush({ f: n.g + lt + 1, g: n.g + lt + 1, S: n.S, pos: -2, nodes: null, path: { X: 'trophy', prev: n.path, g: n.g + lt + 1 }, goal: true });
			for (const X of trig) {
				const r = model.touch(n.S, X);
				if (!r.changed) continue;
				const tn = trigNodes.get(X.id);
				const leg = Math.max(kin(legCost(n.S, nbInfo, n.nodes, tn, 't' + X.id, n.corr), X.tiles, 't' + X.id, tn), walk(X.tiles));
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
				hpush({ f: gm + h, g: gm, S: S2, pos: X.id, nodes: tn, corr: null, path: { X: X.label, prev: n.path, g: gm }, goal: false, wpos: walkPosOf(X) });
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
		// (the clock-blind hash: the time doors' phase and the key timers left out, which this bound does not read (time
		// doors open; a key that runs out only shuts doors: a later idle start's bound is no lower))
		let h = sim.stateHashClockBlind(), rests = -1;
		for (let k = 0; k <= idleMax; k++) {
			if (sim.has_silver_crown) return { lb: 0, why: 'the idle ball finishes', idle: k };
			sim.tick(inp);
			const h2 = sim.stateHashClockBlind();
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
	// ---- the cost-to-go field per abstract state (the exact search's heuristic)
	/**
	 * fieldMulti(nb, nbKey, sources [{nodes, v}], key, lam, resp) -> Float32Array(NL): one backward Dijkstra from several
	 * source regions, each at its own value (portals and deaths as in field())
	 */
	function fieldMulti(nb, sources, lam, resp) {
		const dist = scratch;
		dist.fill(Infinity);
		const lx = lam, ly = 1 - lam;
		heap.clear();
		for (const s of sources) for (const g of s.nodes) if (s.v < dist[g]) { dist[g] = s.v; heap.push(s.v, g); }
		const fired = new Uint8Array(ports.length);
		let dieFired = !resp || !dieNodes;
		const respSet = resp ? resp.set : null;
		while (heap.n > 0) {
			const d = heap.topKey(), m = heap.pop();
			if (d > dist[m]) continue;
			if (ports.length) {
				const l = exitOf.get(m);
				if (l) for (const k of l) { if (fired[k]) continue; fired[k] = 1; const v = d + 1; for (const e of ports[k].entry) if (v < dist[e]) { dist[e] = v; heap.push(v, e); } }
			}
			if (!dieFired && respSet.has(m)) { dieFired = true; const v = d + DEATH_MIN; for (const e of dieNodes) if (v < dist[e]) { dist[e] = v; heap.push(v, e); } }
			const i = m % LW, j = (m - i) / LW;
			if (i > 0) { const n = m - 1; if (!nb[n]) { const v = d + lx * hx[n]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }
			if (i + 1 < LW) { const n = m + 1; if (!nb[n]) { const v = d + lx * hx[m]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }
			if (j > 0) { const n = m - LW; if (!nb[n]) { const v = d + ly * hd[n]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }
			if (j + 1 < LH) { const n = m + LW; if (!nb[n]) { const v = d + ly * hu[m]; if (v < dist[n]) { dist[n] = v; heap.push(v, n); } } }
		}
		const out = new Float32Array(NL);
		for (let n = 0; n < NL; n++) { const v = dist[n]; let f = Math.fround(v); if (f > v) f = Math.fround(v - Math.max(1e-6, Math.abs(v) * 2.4e-7)); out[n] = f; }
		st.fields++;
		return out;
	}
	const walkPos = new Map();
	function walkPosOf(X) { let p = walkPos.get(X.id); if (!p) { p = { id: 'rlx' + X.id, tiles: X.tiles }; walkPos.set(X.id, p); } return p; }
	const togoMemo = new Map();
	const vMemo = new Map();
	const constS = model.feats.length === 0 && !model.coinTiles.length && !model.bcoinTiles.length && !model.cpTracked ? model.S0 : null;
	/** V(S, X): the order-aware bound from the region of trigger X in state S (cached) */
	function vOf(S, X) {
		const k = S.key + '#' + X.id;
		let v = vMemo.get(k);
		if (v === undefined) {
			// (o.togoCheap: the open level's field from X's region + 1 (every gate open: a relaxation of every state after the
			// touch), one lookup instead of an order search: the proofs' heuristic, called on every new abstract state)
			v = o.togoCheap ? hOpen(trigNodes.get(X.id), null) : boundFromNodes(S, trigNodes.get(X.id), null, { ms: 3000, walkTiles: X.tiles }).lb;
			vMemo.set(k, v);
		}
		return v;
	}
	/** the cost-to-go fields of an abstract state: per lam min(the trophy + 1, the next relevant trigger + its V) */
	function togoFields(S) {
		let e = togoMemo.get(S.key);
		if (e) return e;
		const nbInfo = nbOfS(S);
		const sources = [{ nodes: trophyNodes, v: 1 }];
		for (const X of trig) {
			const r = model.touch(S, X);
			if (!r.changed) continue;
			const v = vOf(r.S2, X);
			if (v < Infinity) sources.push({ nodes: trigNodes.get(X.id), v });
		}
		const resp = SB.deaths ? respKey(S) : null;
		e = { nb: nbInfo.nb, f: lams.map((lam) => fieldMulti(nbInfo.nb, sources, lam, resp)) };
		togoMemo.set(S.key, e);
		if (togoMemo.size > 256) togoMemo.delete(togoMemo.keys().next().value);
		return e;
	}
	/** togoFor(sim) -> admissible ticks until has_silver_crown from the exact state (0: no claim: a change pending in the
	 *  engine's queues, a blocked node, dead) */
	function togoFor(sim) {
		if (sim.is_dead || sim.has_silver_crown) return 0;
		if ((sim._tileQueue && sim._tileQueue.length) || (sim._stateQueue && sim._stateQueue.length) || (sim._keysQueue && sim._keysQueue.length) || (sim._team_tx !== undefined && sim._team_tx !== -1)) return 0;
		// (a level whose abstract state never changes: no feature, no coin a gate counts, no tracked checkpoint)
		const S = constS || model.stateOf(sim);
		const e = togoFields(S);
		const cx = sim.px + 8, cy = sim.py + 8;
		const i0 = Math.floor(cx / 8), j0 = Math.floor(cy / 8);
		if (i0 < 0 || j0 < 0 || i0 >= LW || j0 >= LH) return 0;
		const n = j0 * LW + i0;
		if (e.nb[n]) return 0;
		const dx = cx - 8 * i0, dy = cy - 8 * j0;
		const c0 = Math.min(W - 1, i0 >> 1) + W * Math.min(H - 1, j0 >> 1);
		let best = 0;
		for (let k = 0; k < lams.length; k++) {
			const lam = lams[k];
			const v = e.f[k][n] - (lam * dx / caps.Wx[c0] + (1 - lam) * dy / caps.Wdn[c0]);
			if (v > best) best = v;
		}
		return best;
	}
	const setupMs = Date.now() - t0;
	return { bound, runBound, field, togoFor, nodeBlockedOf, regionNodes, caps, model, lams, LW, LH, stats: () => Object.assign({ setupMs }, st), trophyNodes };
}

module.exports = { createRouteLB, capsOf, Heap };
