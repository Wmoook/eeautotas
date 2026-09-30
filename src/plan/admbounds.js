'use strict';
// ADMISSIBLE TICK BOUNDS WITH THE ENGINE'S ACCELERATION (n4u study 4 'bounds', 2026-09-29): lower bounds on the ticks
// the ball needs to bring its centre into a goal tile set, from a tile (a field) or from an exact engine state (at()).
// Same interface as the primitives' bounds.js (createBounds): a drop-in, or a max() with it (both are lower bounds).
//
//   B = createAdmBounds(L, o) -> {field(goalTiles, Lc?, fo?) -> Float32Array(N), at(field, sim) -> ticks,
//        pair(fromTiles, toTiles, Lc?) -> ticks, leg(sim, goal) -> ticks, parts(field, sim) -> per tier, stats()}
//
// TIERS (the result is the max; each one alone never over-estimates):
//  fb    the fallback, the geometry of bounds.js tiers 0/1 re-derived: the 8-connected lattice of tile nodes (walls: full
//        solids, never-open coin doors, shut doors of Lc); iso = Chebyshev steps at 16.25 px/tick; axis = the path's
//        x travel over vx and its up / down travel over vup / vdown, the level's sups (16.25 where a mechanism can
//        reach it); portals (1 + the bound near an exit) and deaths (54 + the bound at a respawn) as sources, a
//        fixpoint iterated from below.
//  accX  the HORIZONTAL ACCELERATION. Away from x-sources (tiles whose physics is not an empty tile's: arrows, boosts,
//        dots, liquids, climbables, effects, portals, killers; dilated by 3 tiles for the 2-tick delayed queue) the
//        engine's x update is u' = (u + a) * BASE_DRAG (a = speedMultiplier / 7.752; with ice also u' = u * ICE_NO_MOD)
//        whatever the input: the sup of |speed_x| from the state's own |speed_x| u0 is the monotone sequence u_k, and
//        the x travel in n ticks is <= S(n; u0) = sum of d(u_k) (d: + the auto-align's < 0.2 px below 1 px/tick). From
//        rest the ball needs ~53 ticks to reach 63% of its top run speed 6.7766, so a short leg costs far more than
//        travel / vmax. Paths through a source: the linear time to the source + the fallback from there.
//  up    THE CLIMB RATE. Away from up-sources (the same set) the only upward speed is a jump (speed_y = -6.708 x jm),
//        which needs a GROUNDED tick (a blocked downward step: a non-rising tick) with max_jumps 1, and then decays
//        (u' = (u - g) * BASE_DRAG). A cycle "grounded tick + n rising ticks" gains <= R(n), so the rise per tick is <=
//        rate = max_n R(n) / (n + 1) (4.67 px/tick at gravity 1 vs the 6.708 of one jump tick); the state's own
//        remaining flight Rcur is free. T >= (up travel - Rcur) / rate.
// The lattice offsets are bounds.js's (the state's own offset from its node + 8 + SLACK 2 px at the goal side).
const E = require('../eesim.js');
const RF = require('../reach.js');
const T = require('./types.js');

const C = E.constants;
const BD = C.BASE_DRAG, MULT = C.MULT, ICE_NMD = C.ICE_NO_MOD_DRAG;
const D_TICK = 16.25, SLACK = 2, DEATH_MIN = 54, EPS = 1e-6, ALIGN = 0.2, DSTEP = 1e-7;
const TROPHY = 121, CHECKPOINT = 360, PORTAL = 242, PORTAL_INV = 381, ICE = 1064;
const CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const X_NONROT_HALF = 4;
// endgame.js UNTAME: effects, music, liquids (the kinematic model's exceptions)
const UNTAME = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618, 77, 83, 1520, 119, 369, 416, 1585]);
const DILATE = 4;            // a lattice node outside D4 has its centre tile outside D3: current and delayed (<= 3 tiles back) tame
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
const MAX_ROUNDS = 6;

function terminal(a, drag) { let v = 0; for (let i = 0; i < 100000; i++) { const n = (v + a) * drag; if (n > 16) return 16; if (n === v) break; v = n; } return v; }

// ---------------------------------------------------------------- the x acceleration curve
/** per (a, ice): the sup trajectories from 0 (rising to v*) and from 16 (falling to v*), their prefix travel */
const CURVES = new Map();
function curveOf(a, ice) {
	const key = `${a}|${ice ? 1 : 0}`;
	let c = CURVES.get(key);
	if (c) return c;
	const step = (u) => { let n = (u + a) * BD; if (ice) { const m = u * ICE_NMD; if (m > n) n = m; } return n > 16 ? 16 : n; };
	const d = (u) => (u < 1.2 ? Math.min(u + ALIGN, 1.2) : u) + DSTEP;
	const vs = terminal(a, BD);
	const mk = (u0) => {
		const U = [u0], S = [0];
		let u = u0;
		for (let k = 1; k < 200000; k++) {
			const n = step(u);
			U.push(n); S.push(S[k - 1] + d(n));
			if (Math.abs(n - u) < 1e-13 && k > 50) break;
			u = n;
		}
		return { U: Float64Array.from(U), S: Float64Array.from(S), vEnd: d(U[U.length - 1]) * (1 + 1e-12) };
	};
	c = { a, ice, vs, up: mk(0), dn: mk(16), step };
	// the total excess travel over v* from 16 (the bonus a fast state can have over a v* runner)
	CURVES.set(key, c);
	return c;
}
/** S(n) of a table from index k: travel in n ticks starting at the table's k-th speed */
function travel(tb, k, n) {
	const L = tb.S.length - 1;
	const end = k + n;
	const sEnd = end <= L ? tb.S[end] : tb.S[L] + (end - L) * tb.vEnd;
	return sEnd - tb.S[k];
}
/** the fewest ticks n with travel >= D from a state with |speed| u0 (a lower bound: the sup trajectory dominates) */
function ticksFor(c, u0, D) {
	if (!(D > 0)) return 0;
	let tb, k;
	if (u0 <= c.vs) {
		tb = c.up;
		// the first k with U[k] >= u0 (the trajectory from U[k] dominates the one from u0)
		let lo = 0, hi = tb.U.length - 1;
		if (tb.U[hi] < u0) { tb = c.dn; k = tb.U.length - 1; } else {   // (at v* itself: the falling table's end, >= v*)
			while (lo < hi) { const m = (lo + hi) >> 1; if (tb.U[m] >= u0) hi = m; else lo = m + 1; }
			k = lo;
		}
	} else {
		tb = c.dn;
		// the last k with U[k] >= u0 (U falls from 16)
		let lo = 0, hi = tb.U.length - 1;
		if (u0 >= 16) k = 0; else {
			while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tb.U[m] >= u0) lo = m; else hi = m - 1; }
			k = lo;
		}
	}
	// smallest n with travel(tb, k, n) >= D
	let lo = 0, hi = 1;
	while (travel(tb, k, hi) < D) { lo = hi; hi *= 2; if (hi > 1e7) return hi; }
	while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (travel(tb, k, m) >= D) hi = m; else lo = m + 1; }
	return lo;
}
/** the most extra travel over v* a state with |speed| u0 can still get (sum of (d(u_k) - v*)^+) */
function bonusOf(c, u0) {
	if (u0 <= c.vs) return 0;
	const tb = c.dn;
	let k = 0;
	if (u0 < 16) { let lo = 0, hi = tb.U.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tb.U[m] >= u0) lo = m; else hi = m - 1; } k = lo; }
	let b = 0;
	for (let j = k + 1; j < tb.U.length; j++) { const e = tb.S[j] - tb.S[j - 1] - c.vs; if (e <= 0) break; b += e; }
	return b;
}

// ---------------------------------------------------------------- the climb rate
const RISES = new Map();
/** the rise of one jump (speed jv, gravity g) per tick after it: R[n], and rate = max R(n) / (n + 1) */
function riseOf(jv, g) {
	const key = `${jv}|${g}`;
	let r = RISES.get(key);
	if (r) return r;
	const R = [0];
	let u = jv, rate = 0;
	for (let n = 1; n < 100000; n++) {
		u = (u - g) * BD;
		if (u > 16) u = 16;
		if (!(u > 0)) break;
		R.push(R[n - 1] + u + DSTEP);
		const q = R[n] / (n + 1);
		if (q > rate) rate = q;
	}
	r = { jv, g, R: Float64Array.from(R), rate: rate * (1 + 1e-9) };
	RISES.set(key, r);
	return r;
}
/** the rest of the rise of a flight with upward speed u0 (> 0) under gravity g, plus the auto-align margin */
function flightRise(u0, g) {
	let s = 0, u = u0;
	for (let k = 0; k < 100000; k++) { u = (u - g) * BD; if (u > 16) u = 16; if (!(u > 0)) break; s += u + DSTEP; }
	return s;
}

// ---------------------------------------------------------------- static per level
const STATIC = new WeakMap();
function staticOf(L) {
	let S = STATIC.get(L);
	if (S) return S;
	const W = L.width, H = L.height, N = W * H, fg = L.fg, g = RF.guideFlags(L), nF = g.length, lk = L.lookup0, xfl = L.xflags;
	const never = RF.neverOpenDoors(L);
	const fl = (id) => (id >= 0 && id < nF ? g[id] : 0);
	const isWallId = (id) => (fl(id) & F_SOLID) !== 0 && (fl(id) & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0;
	const hcur = (i) => { const id = fg[i]; if ((fl(id) & F_HALF) === 0) return -1; return (xfl[id] & X_NONROT_HALF) ? 1 : lk[i]; };
	const touchers = (i) => {
		const x = i % W, y = (i - x) / W, l = [i];
		if (y + 1 < H && hcur(i + W) === 1) l.push(i + W);
		if (x + 1 < W && hcur(i + 1) === 0) l.push(i + 1);
		return l;
	};
	const curOf = (i) => { const hc = hcur(i); return hc === 1 ? (i >= W ? i - W : -1) : hc === 0 ? (i % W > 0 ? i - 1 : -1) : i; };
	const wgm = L.gravityMult;
	const ids = new Set();
	for (let i = 0; i < N; i++) ids.add(fg[i]);
	ids.add(0);
	// tame ids: an empty tile's gravity tables, no climb / liquid / boost flag, not an effect (endgame.js tameId)
	const g0x = L.gMox[0], g0y = L.gMoy[0], r0x = L.gMorx[0], r0y = L.gMory[0];
	const tameLevel = g0x === 0 && g0y > 0 && r0x === 0 && r0y > 0 && Number.isFinite(wgm) && wgm > 0;
	const tameId = (b) => tameLevel && b >= 0 && b < nF && L.gMox[b] === g0x && L.gMoy[b] === g0y && L.gMorx[b] === r0x && L.gMory[b] === r0y &&
		(L.flags[b] & (F_CLIMB | F_LIQUID | F_BOOST)) === 0 && !UNTAME.has(b) && ((L.gFlags[b] & 4) === 0);
	// portals (every one that teleports: also the silent ones count as sources; a teleport's value only for the
	// non-silent ones, the silent ones never teleport)
	const silent = RF.silentPortals(L);
	const portals = [];
	const portalCell = new Uint8Array(N);
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const t = fg[i], s = L.portalSlot[i];
			if ((t !== PORTAL && t !== PORTAL_INV)) continue;
			portalCell[i] = 1;
			if (s < 0 || silent[i] || L.pTarget[s] === L.pId[s]) continue;
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
	let timed = false;
	for (let i = 0; i < N; i++) { const id = fg[i]; if (((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0) || id === LAVA) timed = true; }
	const kills = (i) => i >= 0 && fg[i] < L.gFlags.length && (L.gFlags[fg[i]] & 4) !== 0;
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
	// SOURCES: a tile whose id's PHYSICS is not an empty tile's (arrows, boosts, dots, liquids, climbables, effects;
	// the kill flag alone is no physics: a spike is tame) dilated by DILATE (the gravity queue's 2 ticks back + the
	// walk node's one tile), and the tiles that TELEPORT (portals; killers: a death respawns) dilated by 1 (the node)
	const src0 = new Uint8Array(N), src1 = new Uint8Array(N), srcX0 = new Uint8Array(N), killM = new Uint8Array(N);
	let nSrc = 0;
	const tameIdPhys = (b) => tameLevel && b >= 0 && b < nF && L.gMox[b] === g0x && L.gMoy[b] === g0y && L.gMorx[b] === r0x && L.gMory[b] === r0y &&
		(L.flags[b] & (F_CLIMB | F_LIQUID | F_BOOST)) === 0 && !UNTAME.has(b);
	// the X physics alone: only a sideways pull (side arrows: mox / morx), a side boost (114 / 115) or an effect changes
	// the x update u' = (u + a) * drag with drag <= BASE_DRAG (dots, climbables, liquids, up / down arrows, vertical
	// boosts push x by the input alone, a = 1 / MULT, with base drag or a stronger one: not x sources)
	const X_SAFE_UNTAME = new Set([119, 369, 416, 1585, 77, 83]);   // liquids (stronger drags), music (a tick cut short)
	const tameIdX = (b) => tameLevel && b >= 0 && b < nF && L.gMox[b] === 0 && L.gMorx[b] === 0 && b !== 114 && b !== 115 &&
		(!UNTAME.has(b) || X_SAFE_UNTAME.has(b));
	for (let i = 0; i < N; i++) {
		if (isWallId(fg[i])) continue;
		if (!tameIdPhys(fg[i])) { src0[i] = 1; nSrc++; }
		if (!tameIdX(fg[i])) srcX0[i] = 1;
		if (portalCell[i]) { src1[i] = 1; nSrc++; }
		if (kills(i) || kills(curOf(i))) killM[i] = 1;
	}
	const dilate = (a, r) => {
		const tmp = new Uint8Array(N), out = new Uint8Array(N);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let v = 0;
			for (let d = -r; d <= r && !v; d++) { const xx = x + d; if (xx >= 0 && xx < W && a[y * W + xx]) v = 1; }
			tmp[y * W + x] = v;
		}
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let v = 0;
			for (let d = -r; d <= r && !v; d++) { const yy = y + d; if (yy >= 0 && yy < H && tmp[yy * W + x]) v = 1; }
			out[y * W + x] = v;
		}
		return out;
	};
	let src = new Uint8Array(N), srcX = new Uint8Array(N), killD = new Uint8Array(N);
	if (!tameLevel) { src.fill(1); srcX.fill(1); } else {
		const b = dilate(src1, 1), a = dilate(src0, DILATE), ax = dilate(srcX0, DILATE);
		killD = dilate(killM, 1);
		for (let i = 0; i < N; i++) { src[i] = a[i] | b[i]; srcX[i] = ax[i] | b[i]; }
	}
	const tameQ = (id) => tameIdPhys(id), tameQX = (id) => tameIdX(id);
	// the level's sups for the fallback (bounds.js vmaxOf's rules, re-derived)
	const cap = { xp: false, xn: false, yp: false, yn: false };
	let gmx = 0, gmUp = 0, gmDown = 0, zeroG = false, liquid = false;
	for (const id of ids) {
		if (id < 0 || id >= nF) { cap.xp = cap.xn = cap.yp = cap.yn = true; continue; }
		if (L.gMox[id] !== 0 || L.gMorx[id] !== 0) gmx = Math.max(gmx, Math.abs(L.gMox[id]) + 1);
		if (L.gMoy[id] < 0 || L.gMory[id] < 0) gmUp = Math.max(gmUp, -L.gMoy[id] + 1);
		if (L.gMoy[id] > 0) gmDown = Math.max(gmDown, L.gMoy[id]);
		if (L.gMox[id] === 0 && L.gMoy[id] === 0) zeroG = true;
		if ((L.flags[id] & (F_LIQUID | F_CLIMB)) !== 0) liquid = true;
	}
	if (!(Number.isFinite(wgm) && wgm > 0)) cap.xp = cap.xn = cap.yp = cap.yn = true;
	if (ids.has(418) || ids.has(1517)) cap.xp = cap.xn = cap.yp = cap.yn = true;
	if (ids.has(114)) cap.xn = true;
	if (ids.has(115)) cap.xp = true;
	if (ids.has(116)) cap.yn = true;
	if (ids.has(117)) cap.yp = true;
	if (gmx > 0) cap.xp = cap.xn = true;
	if (gmUp > 0) cap.yn = true;
	// multi jumps (461 resets the jump count every tick; 1573 / others: effects) -> the up speed may be re-set each tick:
	// the jump speed stays the sup of a jump anyway (a jump SETS speed_y), so only the up tier needs max_jumps 1
	if (portals.length && L.pRot) {
		let rot = false;
		for (const p of portals) { const s = L.portalSlot[p.entry], ex = L.portalsById.get(L.pTarget[s]); for (let k = 0; k < ex.n && !rot; k++) { const ns = L.portalSlot[(ex.ys[k] >> 4) * W + (ex.xs[k] >> 4)]; if ((ns >= 0 ? L.pRot[ns] : 0) !== L.pRot[s]) rot = true; } }
		if (rot) cap.xp = cap.xn = cap.yp = cap.yn = true;
	}
	const sm = ids.has(419) ? 1.5 : 1.0;
	const jm = ids.has(417) ? 1.3 : 1.0;
	const aRun = sm / MULT;
	const run = terminal(aRun, BD);
	const ice = ids.has(ICE);
	// ice: with no input the drag is ICE_NO_MOD alone (weaker than BASE): a speed above ~10.7 decays slower; below the
	// run terminal nothing changes (the curve's step takes the max)
	const vmax = {
		xp: cap.xp ? D_TICK : run + 0.02, xn: cap.xn ? D_TICK : run + 0.02,
		yp: cap.yp ? D_TICK : Math.min(D_TICK, Math.max(terminal((Math.max(gmDown, 2) * Math.max(wgm, 1)) / MULT, BD), (zeroG || liquid) ? run : 0) + 0.02),
		yn: cap.yn ? D_TICK : Math.min(D_TICK, Math.max((2 * 26 * jm) / MULT, (zeroG || liquid) ? run : 0) + 0.02),
	};
	// the tame tiers' own physics: a = 1 / MULT (the speed effect 419 is a source tile; a state with speed_boost 1 or a
	// zombie falls back), gravity g = 2 * wgm / MULT, the jump 6.708 (the jump effect 417 is a source; a state with
	// jump_boost falls back)
	const gTame = (g0y * wgm) / MULT;
	const cx = curveOf(1 / MULT, ice);
	const jv = (r0y * 26) / MULT;
	const rise = riseOf(jv, gTame);
	const upOk = tameLevel && Math.abs(gTame) >= 0.11 && gTame > 0;   // (no y auto-align: |modifier_y| >= 0.1)
	S = { W, H, N, g, nF, isWallId, never, touchers, portals, dsrc: Int32Array.from(dsrc), respawn: Int32Array.from(respawn), deaths, timed,
		src, srcX, killD, nSrc, tameLevel, tameQ, tameQX, vmax, cx, rise, upOk, gTame, ice, ids };
	STATIC.set(L, S);
	return S;
}

// ---------------------------------------------------------------- Dijkstra over the lattice
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
			for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
			K[i] = key; V[i] = node;
		}
		return top;
	}
}
/** backward Dijkstra: dist[t] = min over lattice paths t -> source of the step costs + the source's init. cost[d]: the
 *  forward step from a tile to its neighbour (DX8[d], DY8[d]); block: tiles not entered (walls, or excluded sources) */
function dijkstra(W, H, block, srcT, srcI, cost, out) {
	const N = W * H, dist = out || new Float64Array(N);
	dist.fill(Infinity);
	const heap = new Heap(1024);
	for (let k = 0; k < srcT.length; k++) { const s = srcT[k], c = srcI[k]; if (c < dist[s]) { dist[s] = c; heap.push(c, s); } }
	// the ball steps from the neighbour INTO this tile: the neighbour at (+DX, +DY) steps by (-DX, -DY)
	const cst = new Float64Array(8);
	for (let d = 0; d < 8; d++) cst[d] = cost(-DX8[d], -DY8[d]);
	while (heap.n > 0) {
		const key = heap.k[0], t = heap.pop();
		if (key > dist[t]) continue;
		const x = t % W, y = (t - x) / W;
		for (let d = 0; d < 8; d++) {
			const xx = x + DX8[d], yy = y + DY8[d];
			if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const n = yy * W + xx;
			if (block[n]) continue;
			if (d >= 4 && (block[y * W + xx] || block[yy * W + x] || block[t])) continue;
			const nd = key + cst[d];
			if (nd < dist[n]) { dist[n] = nd; heap.push(nd, n); }
		}
	}
	return dist;
}

// ---------------------------------------------------------------- createAdmBounds
function createAdmBounds(L, o = {}) {
	const S = staticOf(L);
	const W = S.W, H = S.H, N = S.N, vm = S.vmax;
	const memo = new Map(), META = new WeakMap();
	const st = { fields: 0, hits: 0, ms: 0 };
	const tiers = { fb: o.fb !== false, accX: o.accX !== false, up: o.up !== false };
	const offX = (16 + SLACK) / Math.min(vm.xp, vm.xn), offY = (16 + SLACK) / Math.min(vm.yp, vm.yn);

	function wallOf(Lc) {
		const fg = Lc.fg, w = new Uint8Array(N);
		for (let i = 0; i < N; i++) if (S.isWallId(fg[i]) || (S.never && S.never[i])) w[i] = 1;
		return w;
	}
	function field(goalTiles, Lc, fo = {}) {
		const gl = Array.from(goalTiles).filter((t) => t >= 0 && t < N).sort((a, b) => a - b);
		const touch = fo.touch !== undefined ? !!fo.touch : gl.length > 0 && gl.every((t) => L.fg[t] === TROPHY);
		const key = `${Lc ? T.fgHash(Lc.fg) : '-'}|${touch ? 1 : 0}|${gl.join(',')}`;
		const had = memo.get(key);
		if (had) { st.hits++; memo.delete(key); memo.set(key, had); return had; }
		const t0 = Date.now();
		const wall = wallOf(Lc || L);
		const goals = new Set();
		for (const t of gl) for (const c of (touch ? S.touchers(t) : [t])) goals.add(c);
		const goalArr = Int32Array.from(goals), isGoal = new Uint8Array(N);
		for (const t of goalArr) isGoal[t] = 1;
		// ---- the fallback (bounds.js tiers 0/1), portals and deaths fixed from below
		const Q = new Float64Array(S.portals.length).fill(1);
		let R = 0;
		const fb = new Float64Array(N);
		const iso = new Float64Array(N), ax = new Float64Array(N), ay = new Float64Array(N);
		const cX = (dx) => (dx > 0 ? 16 / vm.xp : dx < 0 ? 16 / vm.xn : 0);
		const cY = (dy) => (dy > 0 ? 16 / vm.yp : dy < 0 ? 16 / vm.yn : 0);
		for (let round = 0; ; round++) {
			const srcT = [], srcI = [];
			for (const t of goalArr) { srcT.push(t); srcI.push(0); }
			S.portals.forEach((p, k) => { for (const c of p.trig) { srcT.push(c); srcI.push(Q[k]); } });
			if (S.deaths) for (const d of S.dsrc) { srcT.push(d); srcI.push(DEATH_MIN + R); }
			dijkstra(W, H, wall, srcT, srcI.map((v) => v * D_TICK / 16), () => 1, iso);
			dijkstra(W, H, wall, srcT, srcI, (dx) => cX(dx), ax);
			dijkstra(W, H, wall, srcT, srcI, (dx, dy) => cY(dy), ay);
			for (let i = 0; i < N; i++) {
				if (isGoal[i]) { fb[i] = 0; continue; }
				if (iso[i] === Infinity) { fb[i] = Infinity; continue; }
				fb[i] = Math.max(1, Math.ceil((16 * iso[i] - 16 - SLACK) / D_TICK - EPS), Math.ceil(ax[i] - offX - EPS), Math.ceil(ay[i] - offY - EPS));
			}
			let changed = false;
			S.portals.forEach((p, k) => {
				let m = Infinity;
				for (const c of p.near) if (!wall[c] && fb[c] < m) m = fb[c];
				if (1 + m > Q[k] + 1e-9) { Q[k] = 1 + m; changed = true; }
			});
			if (S.deaths) {
				let m = Infinity;
				for (const r of S.respawn) if (fb[r] < m) m = fb[r];
				if (m !== Infinity && m > R + 1e-9) { R = m; changed = true; }
			}
			if (!changed || round + 1 >= MAX_ROUNDS) break;
		}
		// ---- the tame tiers: direct fields (sources blocked, travel in px) and via-source fields (ticks, from fb)
		const tame = S.tameLevel && (tiers.accX || tiers.up);
		let xd = null, xv = null, ud = null, uv = null;
		if (tame) {
			// per tier its own source set (x: S.srcX, up: S.src); the walk's node first in a source tile has its centre within
			// one tile of it: the source's value = the least fallback of its 3 x 3
			const prep = (srcArr) => {
				const block = new Uint8Array(N);
				for (let i = 0; i < N; i++) block[i] = wall[i] | srcArr[i];
				const gT = [], gI = [];
				for (const t of goalArr) if (!block[t]) { gT.push(t); gI.push(0); }
				const vT = [], vI = [];
				for (let i = 0; i < N; i++) {
					if (!srcArr[i] || wall[i]) continue;
					const x = i % W, y = (i - x) / W;
					let m = Infinity;
					for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) { const c = yy * W + xx; if (!wall[c] && fb[c] < m) m = fb[c]; }
					if (m !== Infinity) { vT.push(i); vI.push(m); }
				}
				// a death (the node within one tile of a killer): >= DEATH_MIN ticks dead + the fallback from a respawn; the
				// killers stay walkable (a walk past or through them that does not die is tame)
				if (S.deaths) for (let i = 0; i < N; i++) if (S.killD[i] && !wall[i] && !srcArr[i]) { vT.push(i); vI.push(DEATH_MIN + R); }
				return { block, gT, gI, vT, vI, srcArr };
			};
			if (tiers.accX) {
				const P = prep(S.srcX);
				xd = dijkstra(W, H, P.block, P.gT, P.gI, (dx) => (dx !== 0 ? 16 : 0));
				// via: paths into the sources (priced as the linear v* run; the state's bonus over v* subtracted in at())
				xv = viaField(wall, P.srcArr, P.vT, P.vI, (dx) => (dx !== 0 ? 16 / S.cx.vs : 0));
			}
			if (tiers.up && S.upOk) {
				const P = prep(S.src);
				ud = dijkstra(W, H, P.block, P.gT, P.gI, (dx, dy) => (dy < 0 ? 16 : 0));
				uv = viaField(wall, P.srcArr, P.vT, P.vI, (dx, dy) => (dy < 0 ? 16 / S.rise.rate : 0));
			}
		}
		const bound = new Float32Array(N);
		for (let i = 0; i < N; i++) bound[i] = fb[i];
		// the tile value (any state in the tile): x from speed 16, up with the whole remaining flight of speed 16 ignored
		// (no up gain for the tile value), the state tiers in at()
		if (xd) for (let i = 0; i < N; i++) {
			if (isGoal[i] || bound[i] === Infinity) continue;
			const dir = xd[i] === Infinity ? Infinity : ticksFor(S.cx, 16, xd[i] - 16 - SLACK);
			const via = xv[i] === Infinity ? Infinity : Math.ceil(xv[i] - (8 + 16 + SLACK) / S.cx.vs - bonusOf(S.cx, 16) / S.cx.vs - EPS);
			const b = Math.min(dir, via, S.timed ? DEATH_MIN + R : Infinity);
			if (b > bound[i] && b !== Infinity) bound[i] = b;
		}
		const ms = Date.now() - t0;
		st.fields++; st.ms += ms;
		META.set(bound, { goals: goalArr, isGoal, fb, iso, ax, ay, xd, xv, ud, uv, touch, ms, R });
		memo.set(key, bound);
		if (memo.size > (o.memo || 16)) memo.delete(memo.keys().next().value);
		return bound;
	}
	/** the via-source field: from the source tiles (init fb there) over non-source, non-wall tiles; a source tile is its
	 *  own init (the step INTO a source is priced like any step: entering it takes the same travel) */
	function viaField(wall, srcArr, vT, vI, cost) {
		// sources are entered, not crossed: run the Dijkstra on 'wall' with the sources as the only way to have a value,
		// while blocking the relaxation OUT of a source tile into ... (a path may leave and re-enter: any path is priced by
		// its first source, the fb there covers the rest): relax only from sources and non-source tiles into non-source
		// tiles (a source tile keeps its init)
		const dist = new Float64Array(N).fill(Infinity);
		const heap = new Heap(1024);
		for (let k = 0; k < vT.length; k++) { const s = vT[k]; if (vI[k] < dist[s]) { dist[s] = vI[k]; heap.push(vI[k], s); } }
		const cst = new Float64Array(8);
		for (let d = 0; d < 8; d++) cst[d] = cost(-DX8[d], -DY8[d]);
		while (heap.n > 0) {
			const key = heap.k[0], t = heap.pop();
			if (key > dist[t]) continue;
			const x = t % W, y = (t - x) / W;
			for (let d = 0; d < 8; d++) {
				const xx = x + DX8[d], yy = y + DY8[d];
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const n = yy * W + xx;
				if (wall[n] || srcArr[n]) continue;
				if (d >= 4 && (wall[y * W + xx] || wall[yy * W + x] || wall[t])) continue;
				const nd = key + cst[d];
				if (nd < dist[n]) { dist[n] = nd; heap.push(nd, n); }
			}
		}
		return dist;
	}
	/** the parts at an exact state: {fb, accX, up, dead} (null where a tier does not apply) */
	function parts(f, sim) {
		const m = META.get(f);
		const out = { fb: null, accX: null, up: null };
		if (sim.is_dead) {
			let b = Infinity;
			for (const r of S.respawn) if (f[r] < b) b = f[r];
			out.fb = Math.max(1, b);
			return out;
		}
		const t = T.tileOf(sim, W, H);
		let v = f[t];
		if (!m || v === 0 || v === Infinity) { out.fb = v; return out; }
		const x = t % W, y = (t - x) / W;
		const dx = sim.px - 16 * x, dy = sim.py - 16 * y, adx = Math.abs(dx), ady = Math.abs(dy);
		{
			let b = Math.ceil((16 * m.iso[t] - Math.max(adx, ady) - 8 - SLACK) / D_TICK - EPS);
			const bx = Math.ceil(m.ax[t] - (dx > 0 ? dx / vm.xp : -dx / vm.xn) - (8 + SLACK) / Math.min(vm.xp, vm.xn) - EPS);
			const by = Math.ceil(m.ay[t] - (dy > 0 ? dy / vm.yp : -dy / vm.yn) - (8 + SLACK) / Math.min(vm.yp, vm.yn) - EPS);
			out.fb = Math.max(v, b, bx, by);
		}
		// the ball's own physics plain: no effect, and the gravity queue's tiles (the next 2 ticks' delayed) tame
		const fx0 = !sim.has_levitation && sim.speed_boost === 0 && !sim.is_zombie && sim.flip_gravity === 0 && !sim.in_god_mode;
		const cur = sim.current_tile === undefined ? 0 : sim.current_tile;
		const plain = fx0 && S.tameQ(sim._q0) && S.tameQ(sim._q1) && S.tameQ(cur);
		const plainX = fx0 && S.tameQX(sim._q0) && S.tameQX(sim._q1) && S.tameQX(cur);
		if (m.xd && plainX) {
			const u0 = Math.abs(sim.speed_x);
			const need = m.xd[t] - adx - 8 - SLACK;
			const dir = m.xd[t] === Infinity ? Infinity : ticksFor(S.cx, u0, need);
			const via = m.xv[t] === Infinity ? Infinity : Math.ceil(m.xv[t] - (adx + 16 + SLACK) / S.cx.vs - bonusOf(S.cx, u0) / S.cx.vs - EPS);
			out.accX = Math.min(dir, via, S.timed ? DEATH_MIN + m.R : Infinity);
		}
		if (m.ud && plain && sim.max_jumps <= 1 && sim.jump_boost === 0 && !sim.low_gravity && sim.world_gravity_multiplier === L.gravityMult) {
			const vy = sim.speed_y;
			const rcur = vy < 0 ? flightRise(-vy, S.gTame) : 0;
			const dir = m.ud[t] === Infinity ? Infinity : Math.ceil((m.ud[t] - ady - 8 - SLACK - rcur) / S.rise.rate - EPS);
			const via = m.uv[t] === Infinity ? Infinity : Math.ceil(m.uv[t] - (ady + 16 + SLACK + rcur) / S.rise.rate - EPS);
			out.up = Math.min(dir, via, S.timed ? DEATH_MIN + m.R : Infinity);
		}
		return out;
	}
	function at(f, sim) {
		const p = parts(f, sim);
		let v = p.fb;
		if (v === 0 || v === Infinity || v === null) return v;
		if (p.accX !== null && p.accX > v && p.accX !== Infinity) v = p.accX;
		if (p.up !== null && p.up > v && p.up !== Infinity) v = p.up;
		return v;
	}
	function pair(fromTiles, toTiles, Lc) {
		const f = field(toTiles, Lc);
		let b = Infinity;
		for (const t of fromTiles) if (t >= 0 && t < N && f[t] < b) b = f[t];
		return b;
	}
	function leg(sim, goal, lo = {}) {
		const Lc = lo.relaxed ? null : T.levelNow(L, sim);
		const trophy = goal.kind === 'trophy';
		const tiles = trophy ? (() => { const a = []; for (let i = 0; i < N; i++) if (L.fg[i] === TROPHY) a.push(i); return a; })() : goal.tiles;
		const f = field(tiles, Lc, { touch: trophy });
		const v = at(f, sim);
		return trophy && v !== Infinity ? v + 1 : v;
	}
	return { vmax: vm, field, at, parts, pair, leg, meta: (f) => META.get(f), stats: () => Object.assign({}, st, { memo: memo.size }), static: S };
}

module.exports = { createAdmBounds, staticOf, curveOf, ticksFor, bonusOf, riseOf, flightRise, terminal, D_TICK, SLACK, DEATH_MIN };
