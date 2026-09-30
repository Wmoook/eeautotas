'use strict';
// EE MOVEMENT AS 1D MATHEMATICS (n4-math, Derive / reach1d, 2026-09-30). The exact per-axis recurrences of
// src/eesim.js (Player.as 4.13-4.21), the free-air reachability of one axis under input patterns with few changes, the
// level-independent tables built from them, and the queries the compiler evaluates instead of searching. Every claim
// used here is checked against the engine by test/kin1d_theorems.js; docs/ee_math.md has the statements.
//
// THE PER-AXIS TICK (one axis a in {x, y}; m = this axis' input after the speed multiplier, mo = this axis' gravity
// after the gravity multiplier, moO = the other axis' gravity; all exactly the engine's doubles):
//   mod = (mo + m) / 7.752
//   if (v != 0 || mod != 0): s = v + mod; drag by the context (release: (m == 0 && moO != 0) || opp, see axisStep);
//                            cap to +-16, snap |s| < 1e-4 to 0; v = s
//   x = x + v                    (THEOREM P: the sub-stepped move of a collision-free tick is ONE rounded addition)
//   [gravity axis: a jump sets v = J]
//   if (|v| < 1 && |mod| < 0.1 && not liquid): x = align(x)          (the auto-align, Player.as 4.21)
// In free air under default gravity: x is the INPUT AXIS (IA: m = h * sm, mo = 0, moO = 2 gm) and y the GRAVITY AXIS
// (GA: m = 0, mo = 2 gm, moO = 0). THEOREM S: the two evolve independently (no term of one reads the other) until a
// collision, a field tile at the centre (or 2 ticks back), a portal or an effect changes the context.
//
// PATTERNS (input axis): runs of a constant input m in {L = -1, 0 = '-', R = +1}; k = runs - 1 changes. A pattern of
// length t is coded in 29 bits: m0 | m1 << 2 | m2 << 4 | m3 << 6 (0 '-', 1 L, 2 R) | c1 << 8 | c2 << 15 | c3 << 22
// (c_i = the tick after which run i starts, 1..127; 0 = no such run). decode(code, t) gives the runs.
//
// EXACT OFFSETS: speeds do not depend on the position (THEOREM S), offsets do only through the rounding of x + v (at
// most t ulp(x) / 2 over t ticks: 5e-11 px for x < 8192, t = 120) and through the auto-align (x mod 16, only on ticks
// with |v| < 1 and no held key). So a table stores the pattern's speeds (exact doubles) and its offset from 0 (the
// 'nominal' dx); evalIA(x0, v0, code, t) replays the axis from the real x0 in t additions: the EXACT engine value.
//
// API (ctx = {sm, gm, jm}: speed / gravity / jump multipliers, default 1; the plain free-air context):
//   axisStep(v, m, mo, moO, drag, slip) -> v'   the complete speed update of Player.as 4.15 on one axis
//   align(x) -> x'                                the auto-align (4.21)
//   ia(ctx) / ga(ctx) -> the axis constants: ia: {mods[3], ms[3], moO}; ga: {a, J}
//   stepIA(x, v, mi, IA) -> [x, v] (mi 0 '-', 1 L, 2 R);  stepGA(y, v, IA) -> [y, v]
//   evalIA(x0, v0, code, t, ctx[, trace]) -> {x, v, armed}   the exact end state of a pattern (trace: per-tick arrays)
//   evalGA(y0, vy0, t, ctx, jumps) -> {y, v}      jumps: sorted ticks whose tick ends with a jump (vy = J)
//   encode(runs) / decode(code, t) / str(code, t) / changes(code)
//   holdX(x0, v0, mi, t, ctx) -> x after t ticks of one input (the extreme patterns: THEOREM M)
//   rangeIA(x0, v0, t, ctx) -> [xmin, xmax]       every pattern (any number of changes) ends in [xmin - 2, xmax + 2];
//                                                 without an armed tick in [xmin, xmax] exactly (THEOREM M)
//   minT(x0, v0, X, ctx, tmax) -> least t with holdX(R) >= X (X > x0) or holdX(L) <= X: the 1D minimum time (with the
//                                                 align slack: minTSafe)
//   solveIA(x0, v0, T, lo, hi, o) -> patterns with <= o.k changes whose EXACT x_T is in [lo, hi] (and v_T in
//                                   [o.vlo, o.vhi], every tick passing o.tube(t, xPrev, x) when given), fewest changes
//                                   first; branch and bound on the exact interval of THEOREM M; o.limit caps the list
//   buildTable(v0, o) -> the table of every pattern with <= o.K changes and length <= o.T from (0, v0), per tick sorted by
//                        the nominal offset: {v0, T, K, ticks: [{dx: Float64Array, v: Float64Array, code: Uint32Array}]}
//   lookup(tab, t, lo, hi, o) -> rows with nominal dx in [lo, hi] (o.margin, default 2 px + 1e-9 for the align / the
//                                rounding); callers confirm with evalIA from the real x0
//   writeTable / readTable: the binary cache format (src/plan/kin_tables/build.js)
const E = require('../eesim.js');

const C = E.constants;
const B = C.BASE_DRAG, N = C.NO_MOD_DRAG, MULT = C.MULT;
const DRAG = { plain: 0, climb: 1, water: 2, mud: 3, lava: 4, toxic: 5 };
const DRAG_F = [0, C.NO_MOD_DRAG, C.WATER_DRAG, C.MUD_DRAG, C.LAVA_DRAG, C.TOXIC_DRAG];
const MS = [0, -1, 1];               // input index -> m: 0 '-', 1 L, 2 R
const MCH = ['-', 'L', 'R'];
const ALIGN_SLACK = 2;               // the most the auto-align can move a position toward a grid line (px)

/**
 * The speed update of Player.as 4.15 on one axis (eesim.js _playerTick, the `speed_x` / `speed_y` blocks), not in god
 * mode, before the boosts: m = this axis' input (horizontal / vertical after the axis choice and * speedMultiplier),
 * mo = this axis' gravity (after * gravityMultiplier), moO = the other axis' gravity, drag = DRAG.* of the CURRENT tile
 * (climb for a climbable), slip = slippery > 0.
 */
function axisStep(v, m, mo, moO, drag, slip) {
	const mod = (mo + m) / MULT;
	if (v === 0 && mod === 0) return v;
	let s = v + mod;
	const opp = (s < 0 && m > 0) || (s > 0 && m < 0);
	if ((((m === 0 && moO !== 0) || opp) && !slip) || drag === 1) { s *= B; s *= N; }
	else if (drag >= 2) { s *= B; s *= DRAG_F[drag]; }
	else if (slip) {
		if (m !== 0 && !opp) s *= B; else s *= C.ICE_NO_MOD_DRAG;
		if (opp) s *= C.ICE_DRAG;
	} else s *= B;
	if (s > 16) s = 16;
	else if (s < -16) s = -16;
	else if (s < 0.0001 && s > -0.0001) s = 0;
	return s;
}

/** fmod(x, 16) as the engine computes it (eesim.js fmod16) */
function fmod16(x) { return x > 0 ? x - 16 * Math.floor(x * 0.0625) : x % 16; }
/** the auto-align of Player.as 4.21 (eesim.js: `tx = fmod16(px)` ...), applied when armed */
function align(x) {
	const tx = fmod16(x);
	if (tx < 2) return tx < 0.2 ? (x | 0) : x - tx / 15;
	if (tx > 14) return tx > 15.8 ? (x | 0) + 1 : x + (tx - 14) / 15;
	return x;
}
/** whether the auto-align runs on an axis: |v| < 1 (int(v) == 0), |modifier| < 0.1, not in a liquid */
function armed(v, mod, liquid) { return !(v >= 1 || v <= -1) && !liquid && mod < 0.1 && mod > -0.1; }

/** the plain free-air input axis (x under default gravity): the modifier of each input, the input values */
function ia(ctx) {
	const sm = sm_(ctx), gm = gm_(ctx);
	const ms = MS.map((m) => m * sm);                  // mx = horizontal; mx *= sm
	const moO = 2 * gm;                                // moy = 2; moy *= gm
	return { sm, gm, ms, moO, mods: ms.map((m) => (0 + m) / MULT) };
}
/** the plain free-air gravity axis (y under default gravity): the modifier a and the jump speed J */
function ga(ctx) {
	const gm = gm_(ctx), jm = (ctx && ctx.jm) || 1;
	const mo = 2 * gm;
	return { gm, jm, mo, a: (mo + 0) / MULT, J: ((0 - 2) * 26 * jm) / MULT };
}
function sm_(ctx) { return (ctx && ctx.sm) || 1; }
function gm_(ctx) {
	if (!ctx) return 1;
	if (ctx.gm !== undefined) return ctx.gm;
	let g = 1; if (ctx.low) g *= 0.15; if (ctx.world !== undefined) g *= ctx.world; return g;
}
/** the multipliers as the engine computes them from the effects (Player.as 347-369) */
function ctxOf(sim) {
	let sm = 1; if (sim.speed_boost === 1) sm *= 1.5; if (sim.speed_boost === 2) sm *= 0.6; if (sim.is_zombie && !sim.in_god_mode) sm *= 0.6;
	let gm = 1; if (sim.low_gravity) gm *= 0.15; gm *= sim.world_gravity_multiplier;
	return { sm, gm, jm: sim._jumpMultiplier() };
}

/** one plain input-axis tick from (x, v) with input index mi: [x', v'] (THEOREMS S, P and the align) */
function stepIA(x, v, mi, I) {
	const m = I.ms[mi];
	v = axisStep(v, m, 0, I.moO, 0, false);
	x += v;
	if (armed(v, I.mods[mi], false)) x = align(x);
	return [x, v];
}
/** one plain gravity-axis tick without a jump */
function stepGA(y, v, G) {
	v = axisStep(v, 0, G.mo, 0, 0, false);
	y += v;
	if (armed(v, G.a, false)) y = align(y);
	return [y, v];
}

// ------------------------------------------------------------------ patterns
function encode(runs) {
	let code = 0, c = 0;
	if (runs.length > 4) throw new Error('kin1d: a table pattern has at most 3 changes');
	for (let i = 0; i < runs.length; i++) {
		const mi = typeof runs[i][0] === 'string' ? MCH.indexOf(runs[i][0]) : runs[i][0];
		code |= mi << (2 * i);
		if (i > 0) { if (c > 127) throw new Error('kin1d: change tick > 127'); code |= c << (8 + 7 * (i - 1)); }
		c += runs[i][1];
	}
	return code >>> 0;
}
/** code -> [[mi, len], ...] for a pattern of length t */
function decode(code, t) {
	const runs = [];
	let start = 0;
	for (let i = 0; i < 4; i++) {
		const next = i < 3 ? (code >>> (8 + 7 * i)) & 127 : 0;
		const mi = (code >>> (2 * i)) & 3;
		if (next === 0 || next >= t) { runs.push([mi, t - start]); break; }
		runs.push([mi, next - start]);
		start = next;
	}
	return runs;
}
function changes(code) { let k = 0; for (let i = 0; i < 3; i++) if (((code >>> (8 + 7 * i)) & 127) !== 0) k++; return k; }
function str(code, t) { return decode(code, t).map(([mi, n]) => `${MCH[mi]}${n}`).join(' '); }
/** the input index at tick j (1-based) of a coded pattern */
function inputAt(code, j) {
	let mi = code & 3;
	for (let i = 0; i < 3; i++) { const c = (code >>> (8 + 7 * i)) & 127; if (c === 0 || j <= c) break; mi = (code >>> (2 * (i + 1))) & 3; }
	return mi;
}

/** the exact end state of a pattern from (x0, v0) after t ticks (the engine's doubles, THEOREMS S + P + align) */
function evalIA(x0, v0, code, t, ctx, trace) {
	const I = ctx && ctx.ms ? ctx : ia(ctx);
	let x = x0, v = v0, arm = false;
	const runs = decode(code, t);
	let j = 0;
	for (const [mi, n] of runs) {
		const m = I.ms[mi], mod = I.mods[mi];
		for (let q = 0; q < n; q++) {
			v = axisStep(v, m, 0, I.moO, 0, false);
			x += v;
			if (armed(v, mod, false)) { x = align(x); arm = true; }
			if (trace) { trace.x[j] = x; trace.v[j] = v; }
			j++;
		}
	}
	return { x, v, armed: arm };
}
/**
 * the gravity axis from (y0, vy0): t ticks, a jump at the end of every tick listed in jumps (1-based, sorted; an entry
 * [tick, J] carries its own jump speed: a jump effect or ice between two air jumps changes J)
 */
function evalGA(y0, vy0, t, ctx, jumps, trace) {
	const G = ctx && ctx.J !== undefined ? ctx : ga(ctx);
	let y = y0, v = vy0, ji = 0;
	for (let j = 1; j <= t; j++) {
		v = axisStep(v, 0, G.mo, 0, 0, false);
		y += v;
		if (jumps && ji < jumps.length) {
			const e = jumps[ji], at = Array.isArray(e) ? e[0] : e;
			if (at === j) { v = Array.isArray(e) ? e[1] : G.J; ji++; }
		}
		if (armed(v, G.a, false)) y = align(y);
		if (trace) { trace.y[j - 1] = y; trace.v[j - 1] = v; }
	}
	return { y, v };
}
/** x after t ticks of the one input mi from (x0, v0), exact */
function holdX(x0, v0, mi, t, ctx) {
	const I = ctx && ctx.ms ? ctx : ia(ctx);
	let x = x0, v = v0;
	for (let j = 0; j < t; j++) { const r = stepIA(x, v, mi, I); x = r[0]; v = r[1]; }
	return x;
}
/**
 * THEOREM M (the extremes): with the align off, every pattern's x_t and v_t lie between those of 'hold L' and 'hold R'
 * (the speed map is monotone in v and in m and x + v is monotone: induction). The align moves a position by at most
 * ALIGN_SLACK toward a grid line, so every pattern ends in [xmin - 2, xmax + 2] (checked: test/kin1d_theorems.js M).
 */
function rangeIA(x0, v0, t, ctx) { return [holdX(x0, v0, 1, t, ctx), holdX(x0, v0, 2, t, ctx)]; }
/** the 1D minimum time: the least t <= tmax with hold-toward reaching X (exact; the align ignored), else Infinity */
function minT(x0, v0, X, ctx, tmax = 1000, slack = 0) {
	const I = ctx && ctx.ms ? ctx : ia(ctx);
	const mi = X >= x0 ? 2 : 1;
	let x = x0, v = v0;
	if (mi === 2 ? x + slack >= X : x - slack <= X) return 0;
	for (let t = 1; t <= tmax; t++) {
		const r = stepIA(x, v, mi, I); x = r[0]; v = r[1];
		if (mi === 2 ? x + slack >= X : x - slack <= X) return t;
	}
	return Infinity;
}
/** the admissible 1D minimum time: THEOREM M with the align slack (a lower bound for EVERY input sequence) */
function minTSafe(x0, v0, X, ctx, tmax = 1000) { return minT(x0, v0, X, ctx, tmax, ALIGN_SLACK); }

// ------------------------------------------------------------------ the exact solver (branch and bound)
/**
 * solveIA(x0, v0, T, lo, hi, o): every pattern with <= o.k (default 1) changes whose exact x_T lies in [lo, hi]
 * (and v_T in [o.vlo, o.vhi]; every tick j with o.tube(j, xPrev, x) true), found by walking the pattern tree with the
 * interval bound of THEOREM M at every node (hold L / hold R from the node's state, widened by ALIGN_SLACK when an
 * armed tick is possible): a node whose interval misses [lo, hi] is cut, so the walk visits the hits and the tree's
 * boundary only. Fewest changes first (k = 0, 1, ... each complete), at most o.limit results (default 64).
 * Result: [{code, k, x, v, str}], each x, v the engine's exact double at T.
 */
function solveIA(x0, v0, T, lo, hi, o = {}) {
	const I = o.ctx && o.ctx.ms ? o.ctx : ia(o.ctx);
	const K = o.k === undefined ? 1 : o.k, limit = o.limit || 64;
	const vlo = o.vlo === undefined ? -Infinity : o.vlo, vhi = o.vhi === undefined ? Infinity : o.vhi;
	const tube = o.tube || null, maxNodes = o.maxNodes || Infinity;
	const out = [];
	const stats = { nodes: 0, cut: 0, budget: false };
	// can a pattern that uses input mi from state (x, v) at tick t with up to kLeft more changes still land in the window?
	// THEOREM M: its x_T and v_T lie within hold L / hold R from (x, v) (+- the align slack when armed ticks are possible)
	const hold = (x, v, mi, n) => { for (let j = 0; j < n; j++) { const r = stepIA(x, v, mi, I); x = r[0]; v = r[1]; } return [x, v]; };
	const alignPossible = I.mods.some((md) => md < 0.1 && md > -0.1);
	const feasible = (x, v, n, kLeft, mi) => {
		let a, b;
		if (kLeft === 0) { a = b = hold(x, v, mi, n); }
		else { a = hold(x, v, 1, n); b = hold(x, v, 2, n); }
		const sl = alignPossible ? ALIGN_SLACK : 0;
		if (b[0] + sl < lo || a[0] - sl > hi) return false;
		if (b[1] < vlo || a[1] > vhi) return false;
		return true;
	};
	// the last change (THEOREM M, per tick): for a prefix ending in run mi and the final run mf, x_T and v_T are monotone
	// in the change tick j (moving the change one tick later swaps one tick of mf for mi); with no armed tick possible
	// in either run (both inputs held: |modifier| >= 0.1) the hits form an interval of j found by binary search
	const lastRun = (t, xs, vs, n, mi, k, code2) => {
		// xs[i], vs[i] = the state after tick t + 1 + i of run mi (i < n); the change after tick j = t + 1 + i
		for (let mf = 0; mf < 3 && out.length < limit; mf++) {
			if (mf === mi) continue;
			const code3 = (code2 | (mf << (2 * (k + 1))) | 0) >>> 0;
			const fin = (i) => { const j = t + 1 + i; return hold(xs[i], vs[i], mf, T - j); };
			const emit = (i, r) => {
				const j = t + 1 + i;
				if (r[0] >= lo && r[0] <= hi && r[1] >= vlo && r[1] <= vhi && out.length < limit) {
					const c = (code3 | (j << (8 + 7 * k))) >>> 0;
					out.push({ code: c, k: k + 1, x: r[0], v: r[1], str: str(c, T) });
				}
			};
			const monotone = !(I.mods[mi] < 0.1 && I.mods[mi] > -0.1) && !(I.mods[mf] < 0.1 && I.mods[mf] > -0.1);
			if (!monotone) { for (let i = 0; i < n && out.length < limit; i++) { stats.nodes++; emit(i, fin(i)); } continue; }
			const up = MS[mi] > MS[mf];   // x_T non-decreasing in j
			// the first i with x_T >= lo (up) / <= hi (down)
			let a = 0, b = n;
			while (a < b) { const m = (a + b) >> 1; stats.nodes++; const r = fin(m); if (up ? r[0] >= lo : r[0] <= hi) b = m; else a = m + 1; }
			for (let i = a; i < n && out.length < limit; i++) {
				stats.nodes++;
				const r = fin(i);
				if (up ? r[0] > hi : r[0] < lo) break;
				emit(i, r);
			}
		}
	};
	for (let kTarget = 0; kTarget <= K && out.length < limit && !stats.budget; kTarget++) {
		// patterns with exactly kTarget changes: runs r0..rk
		const rec = (t, x, v, miPrev, k, code) => {
			// start a run with input mi != miPrev at tick t + 1 (k = the index of this run)
			for (let mi = 0; mi < 3 && out.length < limit; mi++) {
				if (k > 0 && mi === miPrev) continue;
				const code2 = (code | (mi << (2 * k)) | (k > 0 ? t << (8 + 7 * (k - 1)) : 0)) >>> 0;
				if (++stats.nodes > maxNodes) { stats.budget = true; return; }
				if (!feasible(x, v, T - t, kTarget - k, mi)) { stats.cut++; continue; }
				if (!tube && k === kTarget - 1) {
					// this run is the second to last: its states, then the last change by lastRun
					const n = Math.min(T - 1, 127) - t;
					if (n <= 0) continue;
					const xs = new Float64Array(n), vs = new Float64Array(n);
					let xx = x, vv = v;
					for (let i = 0; i < n; i++) { const r = stepIA(xx, vv, mi, I); xx = r[0]; vv = r[1]; xs[i] = xx; vs[i] = vv; }
					lastRun(t, xs, vs, n, mi, k, code2);
					continue;
				}
				// walk this run tick by tick; the last run goes to T
				let xx = x, vv = v, ok = true;
				for (let j = t + 1; j <= T; j++) {
					const xp = xx;
					const r = stepIA(xx, vv, mi, I); xx = r[0]; vv = r[1];
					if (tube && !tube(j, xp, xx)) { ok = false; break; }
					if (k === kTarget) continue;
					if (j < T) {
						if (j - t >= 1 && j <= 127) rec(j, xx, vv, mi, k + 1, code2);
						if (out.length >= limit || stats.budget) return;
					}
				}
				if (ok && k === kTarget && xx >= lo && xx <= hi && vv >= vlo && vv <= vhi) out.push({ code: code2, k, x: xx, v: vv, str: str(code2, T) });
			}
		};
		rec(0, x0, v0, -1, 0, 0);
	}
	out.stats = stats;
	return out;
}

// ------------------------------------------------------------------ tables
/**
 * Every pattern with <= K changes and length <= T from (0, v0) (plain free air, ctx): per tick t (1..T) the rows
 * (nominal dx = x_t - 0 as the recurrence gives it from x0 = 0 with the align OFF, v_t exact, code), sorted by dx.
 * Rows whose pattern had an armed tick (|v| < 1 with no key held) carry flag bit 31 in the code: their dx from a real x0
 * can differ by up to ALIGN_SLACK (the align reads x mod 16); evalIA gives the exact value.
 */
function buildTable(v0, o = {}) {
	const T = o.T || 60, K = o.K === undefined ? 2 : o.K;
	const I = ia(o.ctx);
	const cnt = new Float64Array(T + 1);
	// count first (exact sizes), then fill
	const walk = (emit) => {
		const rec = (t, x, v, miPrev, k, code, arm) => {
			for (let mi = 0; mi < 3; mi++) {
				if (k > 0 && mi === miPrev) continue;
				const code2 = (code | (mi << (2 * k)) | (k > 0 ? t << (8 + 7 * (k - 1)) : 0)) >>> 0;
				const m = I.ms[mi], mod = I.mods[mi], canArm = mod < 0.1 && mod > -0.1;
				let xx = x, vv = v, a = arm;
				for (let j = t + 1; j <= T; j++) {
					vv = axisStep(vv, m, 0, I.moO, 0, false);
					xx += vv;
					if (canArm && !(vv >= 1 || vv <= -1)) a = true;
					emit(j, xx, vv, a ? (code2 | 0x80000000) >>> 0 : code2);
					if (k < K && j < T && j <= 127) rec(j, xx, vv, mi, k + 1, code2, a);
				}
			}
		};
		rec(0, 0, v0, -1, 0, 0, false);
	};
	walk((j) => { cnt[j]++; });
	const ticks = [null];
	for (let t = 1; t <= T; t++) ticks.push({ dx: new Float64Array(cnt[t]), v: new Float64Array(cnt[t]), code: new Uint32Array(cnt[t]), n: 0 });
	walk((j, x, v, code) => { const r = ticks[j]; r.dx[r.n] = x; r.v[r.n] = v; r.code[r.n] = code; r.n++; });
	for (let t = 1; t <= T; t++) sortRows(ticks[t]);
	return { v0, T, K, ctx: { sm: I.sm, gm: I.gm }, ticks };
}
function sortRows(r) {
	const n = r.dx.length, idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	const dx = r.dx;
	idx.sort((a, b) => dx[a] - dx[b] || a - b);
	const dx2 = new Float64Array(n), v2 = new Float64Array(n), c2 = new Uint32Array(n);
	for (let i = 0; i < n; i++) { dx2[i] = dx[idx[i]]; v2[i] = r.v[idx[i]]; c2[i] = r.code[idx[i]]; }
	r.dx = dx2; r.v = v2; r.code = c2; delete r.n;
}
function lowerBound(a, x) { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m] < x) l = m + 1; else h = m; } return l; }
/**
 * lookup(tab, t, lo, hi, o): the table rows at tick t whose nominal dx is within [lo - margin, hi + margin] (margin
 * default 1e-9, plus ALIGN_SLACK for the armed rows) and v in [o.vlo, o.vhi]. With o.x0 each candidate is evaluated
 * from the real x0 (evalIA) and kept only when its EXACT x_t - x0... i.e. x_t is in [x0 + lo, x0 + hi].
 */
function lookup(tab, t, lo, hi, o = {}) {
	const r = tab.ticks[t];
	if (!r) return [];
	const m = o.margin === undefined ? 1e-9 : o.margin;
	const vlo = o.vlo === undefined ? -Infinity : o.vlo, vhi = o.vhi === undefined ? Infinity : o.vhi;
	const out = [];
	const i0 = lowerBound(r.dx, lo - m - ALIGN_SLACK);
	for (let i = i0; i < r.dx.length && r.dx[i] <= hi + m + ALIGN_SLACK; i++) {
		const code = r.code[i], arm = (code & 0x80000000) !== 0;
		if (!arm && (r.dx[i] < lo - m || r.dx[i] > hi + m)) continue;
		if (r.v[i] < vlo || r.v[i] > vhi) continue;
		const row = { dx: r.dx[i], v: r.v[i], code: code & 0x7fffffff, armed: arm };
		if (o.x0 !== undefined) {
			const e = evalIA(o.x0, tab.v0, row.code, t, tab.ctx);
			if (e.x < o.x0 + lo || e.x > o.x0 + hi) continue;
			row.x = e.x; row.v = e.v;
		}
		out.push(row);
		if (o.limit && out.length >= o.limit) break;
	}
	return out;
}
/**
 * the table's summary per tick: [t, dxmin, dxmax, the largest gap between consecutive offsets, rows, the largest gap
 * inside [dxmin + edge, dxmax - edge] (edge default 8 px: the extremes are single patterns, hold R and its last-tick
 * variants, whose gaps no change can fill), the median gap there] (the resolution of the reachable offsets)
 */
function summary(tab, edge = 8) {
	const out = [];
	for (let t = 1; t <= tab.T; t++) {
		const d = tab.ticks[t].dx;
		let gap = 0, gin = 0;
		const lo = d[0] + edge, hi = d[d.length - 1] - edge, gaps = [];
		for (let i = 1; i < d.length; i++) {
			const g = d[i] - d[i - 1];
			if (g > gap) gap = g;
			if (d[i - 1] >= lo && d[i] <= hi) { if (g > gin) gin = g; if (gaps.length < 200000) gaps.push(g); }
		}
		gaps.sort((a, b) => a - b);
		out.push([t, d[0], d[d.length - 1], gap, d.length, lo < hi ? gin : NaN, gaps.length ? gaps[gaps.length >> 1] : NaN]);
	}
	return out;
}

// the binary format: header JSON line (v0 as hex bits, T, K, ctx, counts) then per tick dx[], v[], code[]
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
function hexf64(h) { return Buffer.from(h, 'hex').readDoubleLE(0); }
function writeTable(file, tab) {
	const fs = require('fs');
	const counts = []; for (let t = 1; t <= tab.T; t++) counts.push(tab.ticks[t].dx.length);
	const head = Buffer.from(JSON.stringify({ fmt: 'kin1d-1', v0: f64hex(tab.v0), T: tab.T, K: tab.K, ctx: tab.ctx, counts }) + '\n');
	const parts = [head];
	for (let t = 1; t <= tab.T; t++) {
		const r = tab.ticks[t];
		parts.push(Buffer.from(r.dx.buffer, r.dx.byteOffset, r.dx.byteLength), Buffer.from(r.v.buffer, r.v.byteOffset, r.v.byteLength),
			Buffer.from(r.code.buffer, r.code.byteOffset, r.code.byteLength));
	}
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, Buffer.concat(parts));
	fs.renameSync(tmp, file);
}
function readTable(file) {
	const buf = require('fs').readFileSync(file);
	const nl = buf.indexOf(10);
	const h = JSON.parse(buf.subarray(0, nl).toString());
	if (h.fmt !== 'kin1d-1') throw new Error('kin1d: not a kin1d table: ' + file);
	let off = nl + 1;
	const ab = new ArrayBuffer(buf.length - off);
	new Uint8Array(ab).set(buf.subarray(off));
	off = 0;
	const ticks = [null];
	for (let t = 1; t <= h.T; t++) {
		const n = h.counts[t - 1];
		const dx = new Float64Array(ab.slice(off, off + 8 * n)); off += 8 * n;
		const v = new Float64Array(ab.slice(off, off + 8 * n)); off += 8 * n;
		const code = new Uint32Array(ab.slice(off, off + 4 * n)); off += 4 * n;
		ticks.push({ dx, v, code });
	}
	return { v0: hexf64(h.v0), T: h.T, K: h.K, ctx: h.ctx, ticks };
}

// ------------------------------------------------------------------ the table cache
/** the start speed classes of the tables (src/plan/kin_tables/build.js): rest, the hold-R fixed point and its mirror */
const TOP = hexf64('f7eea4ad301b1b40');   // 6.776552880470027: hold R from rest reaches it exactly at tick 1760 and stays
const CLASSES = { rest: 0, top: TOP, topL: -TOP };
let EKEY = null;
/** bump when the table format or the recurrence changes (the tables' key: the engine + this version) */
const TABLE_VERSION = 1;
/** the tables' key: the engine and TABLE_VERSION (a changed engine never reads an old table) */
function engineKey() {
	if (EKEY) return EKEY;
	const fs = require('fs'), path = require('path'), crypto = require('crypto');
	const h = crypto.createHash('sha1');
	h.update(fs.readFileSync(path.join(__dirname, '..', 'eesim.js')));
	h.update('kin1d-tables-' + TABLE_VERSION);
	EKEY = h.digest('hex').slice(0, 16);
	return EKEY;
}
/** the cache folder: EEAT_KIN1D_DIR, else <os tmp>/eeat_kin1d/<engineKey> (never in src/: 70-100 MB a table) */
function cacheDir() {
	const path = require('path');
	return process.env.EEAT_KIN1D_DIR || path.join(require('os').tmpdir(), 'eeat_kin1d', engineKey());
}
/** loadTable(name, {K, T, build}): the table of class name (CLASSES) from the cache, built there when missing */
function loadTable(name, o = {}) {
	const fs = require('fs'), path = require('path');
	const KK = o.K === undefined ? 2 : o.K, TT = o.T || (KK >= 3 ? 48 : 120);
	const file = path.join(o.dir || cacheDir(), `${name}_k${KK}_t${TT}.bin`);
	if (fs.existsSync(file)) return readTable(file);
	if (o.build === false) return null;
	if (!(name in CLASSES)) throw new Error('kin1d: no table class ' + name);
	const tab = buildTable(CLASSES[name], { T: TT, K: KK });
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeTable(file, tab);
	return tab;
}

module.exports = {
	B, N, MULT, DRAG, MS, MCH, ALIGN_SLACK, TOP, CLASSES, engineKey, cacheDir, loadTable,
	axisStep, fmod16, align, armed, ia, ga, ctxOf, stepIA, stepGA,
	encode, decode, changes, str, inputAt,
	evalIA, evalGA, holdX, rangeIA, minT, minTSafe, solveIA,
	buildTable, lookup, summary, writeTable, readTable, f64hex, hexf64,
};
