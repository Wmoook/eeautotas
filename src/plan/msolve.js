'use strict';
// src/plan/msolve.js - THE MOVE SOLVER (n4-math, build / solver, 2026-09-30).
//
// A LEG = from a REAL engine state (a support state: its exact position, speeds, jump count, effects, the level's doors
// as they stand) to a TARGET (centre tiles + the support class the ball must be in there: a landing 'G', a field entry
// 'Z' / 'W' / 'C' / 'B', any, or a teleport onto an exit tile). The solver EVALUATES the leg from the mathematics of
// docs/ee_math.md instead of searching the engine's state space:
//
//   1. THE REGIME (section 2): from the start state's environment E (the centre / delayed tiles, the flip, the effects)
//      the leg is PLAIN (vertical gravity, a default-gravity centre: the two axes are independent 1D systems, x the
//      input axis and y the gravity axis, until the centre enters a tile of another physics class) or not.
//   2. THE GRAVITY AXIS is a one-parameter family (section 3.1: y has no input in the air with max_jumps 1): a standing
//      ball presses jump at tick j (y = y0 to tick j, then the jump trajectory from (y0, J)), or walks off at tick o (y0
//      to tick o - 1, then the fall from (y0, 0)), or walks; a launched ball (a hop, a fall) has ONE trajectory. Each
//      family member crosses each floor line (16 r - 16) descending at exactly one tick: THE LANDING TICK T(j, r) is
//      a closed form of the table of the trajectory. Every (T, member, target row) is listed, sorted by T: CHEAPEST T
//      FIRST.
//   3. THE INPUT AXIS at that T: every x pattern with <= k changes (kin1d patterns: runs of - / L / R) whose EXACT x_T
//      (T-ADD: x_t = align(x_{t-1} + v_t), the engine's doubles from the real x0) lies in the target's x window (the
//      target tiles' centre columns whose floor is under the box), every tick passing the TUBE: the 16 x 16 box at
//      (x_t, y_t) free of the level's solid tiles (a bitmask lookup), the centre in plain tiles, on the floor while the
//      member stands (at the engine's first x sub-step: the walk-off rule). A branch and bound over the runs cut by
//      THEOREM M (hold L / hold R bound every pattern; here as the HOLD TABLES, position-free offsets per start speed
//      on a 1/64 px/tick grid, monotone, so a cut is a proof) and the LAST CHANGE by LEMMA L's binary search.
//   4. VERIFY: each candidate (T, x pattern, y member) becomes masks and is replayed ONCE by the engine (EESim from the
//      start snapshot, ~0.6 us a tick); a miss (a corner of the sub-step staircase, a one-way, a door, the align)
//      goes on to the next candidate. The answer is the engine's: the first tick the goal test holds.
//   5. NOT PLAIN (arrows, dots, liquids, climbables, boosts, portals) or no plain candidate: the COUPLED piece, the
//      per-tick one-change family over the 9 direction masks (and a press at the first tick) replayed by the engine
//      with the prefix shared, cheapest first-hit tick kept (tool 'coupled').
//   6. THE BOUND (sections 3.2, 1.4): a lower bound on the leg's ticks for EVERY input sequence of the plain regime:
//      max(x: the 1D minimum time from max(v0 toward, 0) with the align slack, y: the first tick the jump (or the
//      fall) reaches the target's floor line); a leg whose found T equals it is PROVEN OPTIMAL (lb === T).
//
// API
//   const S = createSolver(L, {K, Tmax, alts})
//   S.leg(start, target, o) -> {ok, masks (Uint8Array of the leg, replayed), T, hop (masks with the jump on the last
//       tick: the landing hop, verified too) | null, lb, proven, tool ('plain' | 'coupled' | null), cands, verifies,
//       us, why}
//     start: an EESnapshot of L (sim.snapshot()) or an EESim of L (its current state is read, not changed)
//     target: {tiles: number[] (centre tiles), cls: 'G' | 'Z' | 'W' | 'C' | 'B' | 'A' | 'any', tele: bool (the goal tick
//       must teleport), via: number[] (portal tiles to enter for a teleport target)}
//     o: {Tmax, K (max x changes, default 2), coupled (default true), plain (default true), alts}
//   S.lowerBound(start, target) -> ticks (admissible in the plain regime; 0 when no bound applies)
//   S.goal(target) -> (sim, prevX, prevY) -> bool: the target's exact test on a real state
//   S.replay(start, masks, target) -> first tick (1-based) the goal holds, or 0
//   clsOf(sim, L) -> the support class letter of a state (the moves study's: D W C Z B G A)
//   holdTables(ctx) -> {DR, DL, grid}: THE HOLD TABLES (position-free offsets of hold R / hold L per start speed)
const E = require('../eesim.js');
const K1 = require('./kin1d.js');
const KN = require('./kin.js');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const PORTALS = new Set([242, 381]);
const TELEPORT_PX = 20;
const DIR9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const MI_MASK = [0, 2, 4];               // kin1d input index -> mask bits (0 '-', 1 L, 2 R)

// ------------------------------------------------------------------ the support class (the moves study's clsOf)
function clsOf(sim, flags) {
	if (sim.is_dead) return 'D';
	const id = sim.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (DOTS.has(id)) return 'Z';
	if (f & F_BOOST) return 'B';
	if (sim.on_ground) return 'G';
	return 'A';
}

// ------------------------------------------------------------------ the level: tile classes
/** plain centre ids: default gravity (the gravity tables' default case), no field / effect / portal / kill */
function plainIds(L) {
	const n = L.flags.length, out = new Uint8Array(n);
	KN.flagsOf(n - 1);                                   // grow kin's tables to the level's ids
	const g = KN.gravTables();
	for (let id = 0; id < n; id++) {
		const f = L.flags[id] | 0;
		if (f & (F_LIQUID | F_CLIMB | F_BOOST)) continue;
		if (DOTS.has(id) || PORTALS.has(id) || EFFECT_IDS.has(id)) continue;
		if (g.morx[id] !== 0 || g.mory[id] !== 2 || g.mox[id] !== 0 || g.moy[id] !== 2 || (g.flags[id] & 4) !== 0) continue;
		if (L.gFlags && (L.gFlags[id] & 4) !== 0) continue;
		out[id] = 1;
	}
	return out;
}

// ------------------------------------------------------------------ THE HOLD TABLES (THEOREM M, position-free)
const HOLD_T = 160, GRID = 64;               // up to 160 ticks; start speeds on a 1/64 px/tick grid over [-16, 16]
const HOLDS = new Map();
/**
 * holdTables(ctx): DR[i * (HOLD_T + 1) + n] = the offset of n ticks of hold R from the grid speed g_i = -16 + i / 64
 * (x0 = 0: the recurrence's own offset), DL the same for hold L. The speed map is non-decreasing in v (THEOREM M), so
 * for any start speed v in [g_i, g_{i+1}]: offset_R(v, n) <= DR[i+1][n] and offset_L(v, n) >= DL[i][n] (+- the align
 * slack and the roundings of a real x0: 1e-6 px): an O(1) sound interval for the branch and bound.
 */
function holdTables(ctx) {
	const I = K1.ia(ctx);
	const key = `${I.sm},${I.gm}`;
	if (HOLDS.has(key)) return HOLDS.get(key);
	const NG = 32 * GRID + 1, S = HOLD_T + 1;
	const DR = new Float64Array(NG * S), DL = new Float64Array(NG * S);
	for (let i = 0; i < NG; i++) {
		const v0 = -16 + i / GRID;
		for (const [D, mi] of [[DR, 2], [DL, 1]]) {
			let x = 0, v = v0;
			D[i * S] = 0;
			for (let n = 1; n <= HOLD_T; n++) {
				v = K1.axisStep(v, I.ms[mi], 0, I.moO, 0, false);
				x += v;       // no align: the held key's modifier is >= 0.1 at sm >= 1 (the align slack covers the rest)
				D[i * S + n] = x;
			}
		}
	}
	const H = { DR, DL, S, NG, I };
	HOLDS.set(key, H);
	return H;
}
/** [lo, hi]: every x pattern from (x, v) ends after n ticks inside it (THEOREM M on the grid + slack) */
function holdRange(H, x, v, n, slack) {
	if (n > HOLD_T) return [-Infinity, Infinity];
	let fi = (v + 16) * GRID;
	if (!(fi >= 0)) fi = 0; else if (fi > H.NG - 1) fi = H.NG - 1;
	const lo = Math.floor(fi), hi = Math.ceil(fi);
	return [x + H.DL[lo * H.S + n] - slack, x + H.DR[hi * H.S + n] + slack];
}
/** [lo, hi] of n ticks of the ONE held key mi (1 L, 2 R) from (x, v): the table's rows around v (monotone in v) */
function holdOne(H, x, v, n, mi, slack) {
	if (n > HOLD_T) return [-Infinity, Infinity];
	let fi = (v + 16) * GRID;
	if (!(fi >= 0)) fi = 0; else if (fi > H.NG - 1) fi = H.NG - 1;
	const lo = Math.floor(fi), hi = Math.ceil(fi), D = mi === 2 ? H.DR : H.DL;
	return [x + D[lo * H.S + n] - slack, x + D[hi * H.S + n] + slack];
}

// ------------------------------------------------------------------ the solver
function createSolver(L, opts = {}) {
	const W = L.width, Hh = L.height, N = W * Hh;
	const maxX = W * 16 - 16, maxY = Hh * 16 - 16;
	const flags = L.flags;
	const plainId = plainIds(L);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const KMAX = opts.K === undefined ? 2 : opts.K;
	// the per-state solid map: 0 free, 1 solid, 3 one-way (a floor from above only), 4 half block (solid, conservative)
	const base = new Uint8Array(N);
	const doorTiles = [];
	for (let i = 0; i < N; i++) {
		const id = L.fg[i], f = flags[id] | 0;
		if ((f & F_SOLID) === 0) continue;
		if (f & F_JUMPTHRU) base[i] = 3;
		else if (f & (F_HALF | F_ROTHALF)) base[i] = 4;
		else if (f & F_DOOR) { base[i] = 1; doorTiles.push(i); }
		else base[i] = 1;
	}
	const solidMaps = new Map();
	/** the solid map of a live state: the doors as they stand now (memo by the doors' pattern) */
	function solidOf(s) {
		if (doorTiles.length === 0) return base;
		let key = '';
		const bits = new Uint8Array(doorTiles.length);
		for (let k = 0; k < doorTiles.length; k++) { const i = doorTiles[k]; bits[k] = s.is_tile_solid_now(i % W, (i / W) | 0) ? 1 : 0; }
		key = Buffer.from(bits).toString('latin1');
		let m = solidMaps.get(key);
		if (m) return m;
		m = Uint8Array.from(base);
		for (let k = 0; k < doorTiles.length; k++) m[doorTiles[k]] = bits[k] ? 1 : 0;
		if (solidMaps.size > 64) solidMaps.clear();
		solidMaps.set(key, m);
		return m;
	}
	// the live tiles (coins taken are air, switches as they stand): the centre's physics class
	const plainAt = (tiles, x, y) => {
		const cx = Math.trunc(x + 8) >> 4, cy = Math.trunc(y + 8) >> 4;
		if (cx < 0 || cy < 0 || cx >= W || cy >= Hh) return false;
		const id = tiles[cy * W + cx];
		return id < plainId.length && plainId[id] === 1;
	};
	/** the 16 x 16 box at (x, y) is free of solids (one-ways pass; half blocks block: conservative) */
	const boxFree = (sol, x, y) => {
		if (x < 0 || y < 0 || x > maxX || y > maxY) return false;
		const ox = (x | 0) >> 4, oy = (y | 0) >> 4;
		const cxE = ox + ((x + 16) > ox * 16 + 16 ? 2 : 1), cyE = oy + ((y + 16) > oy * 16 + 16 ? 2 : 1);
		for (let cy = oy; cy < cyE; cy++) for (let cx = ox; cx < cxE; cx++) { const s = sol[cy * W + cx]; if (s === 1 || s === 4) return false; }
		return true;
	};
	/** a landable tile (solid, one-way from above, half) under the box's columns at x in row fr (the world's bottom too) */
	const floorAt = (sol, x, fr) => {
		if (fr >= Hh) return true;
		if (fr < 0) return false;
		const ox = (x | 0) >> 4, cxE = ox + ((x + 16) > ox * 16 + 16 ? 2 : 1);
		for (let cx = ox; cx < cxE; cx++) { if (cx < 0 || cx >= W) continue; if (sol[fr * W + cx] !== 0) return true; }
		return false;
	};

	/** a blocking tile (solid or half; a one-way lets a rise through) over the box's columns at x in row cr (the top edge) */
	const ceilAt = (sol, x, cr) => {
		if (cr < 0) return true;
		const ox = (x | 0) >> 4, cxE = ox + ((x + 16) > ox * 16 + 16 ? 2 : 1);
		for (let cx = ox; cx < cxE; cx++) { if (cx < 0 || cx >= W) continue; const q = sol[cr * W + cx]; if (q === 1 || q === 4) return true; }
		return false;
	};

	// ---------------------------------------------------------------- the goal test
	function goalOf(target) {
		const set = new Uint8Array(N);
		for (const t of target.tiles) if (t >= 0 && t < N) set[t] = 1;
		const cls = target.cls || 'any', tele = !!target.tele;
		return (s, px, py) => {
			if (s.is_dead) { if (cls !== 'D') return false; }
			let tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4;
			if (tx < 0) tx = 0; else if (tx >= W) tx = W - 1;
			if (ty < 0) ty = 0; else if (ty >= Hh) ty = Hh - 1;
			if (set[ty * W + tx] !== 1) return false;
			if (tele && !(Math.abs(s.px - px) > TELEPORT_PX || Math.abs(s.py - py) > TELEPORT_PX)) return false;
			if (cls === 'any' || tele) return true;
			return clsOf(s, flags) === cls;
		};
	}
	/** replay masks from a snapshot; the first tick (1-based) the goal holds, 0 never (stops at a death unless goal D) */
	function replay(snap, masks, goal, T) {
		sim.restore(snap);
		const n = T === undefined ? masks.length : Math.min(T, masks.length);
		for (let t = 0; t < n; t++) {
			const px = sim.px, py = sim.py;
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			if (goal(sim, px, py)) return t + 1;
			if (sim.is_dead) return 0;
		}
		return 0;
	}

	// ---------------------------------------------------------------- the plain regime
	/** the start state's plain context, or null (why) */
	function plainStart(s) {
		if (s.is_dead || s.in_god_mode || s.flip_gravity !== 0 || s.has_levitation || s._slippery > 0) return null;
		const c = K1.ctxOf(s);
		if (!(c.gm > 0)) return null;
		const ids = [s._current, s._q0, s._q1];
		for (const id of ids) if (!(id < plainId.length && plainId[id] === 1)) return null;
		if (!plainAt(s.tiles, s.px, s.py)) return null;
		return c;
	}

	/** the free gravity axis from (y0, vy0): Y[0..n], V[0..n] (evalGA's recurrence, exact) */
	function gravTrace(y0, vy0, n, G) {
		// Y the positions, R the raw positions before the align (the landing probe sees them), V the speeds
		const Y = new Float64Array(n + 1), V = new Float64Array(n + 1), R = new Float64Array(n + 1);
		Y[0] = y0; V[0] = vy0; R[0] = y0;
		let y = y0, v = vy0;
		for (let j = 1; j <= n; j++) {
			v = K1.axisStep(v, 0, G.mo, 0, 0, false);
			y += v; R[j] = y;
			if (K1.armed(v, G.a, false)) y = K1.align(y);
			Y[j] = y; V[j] = v;
		}
		return { Y, V, R };
	}

	/**
	 * solveX: every x pattern (<= kMax changes) from (x0, v0) whose exact x_T is in one of wins ([lo, hi) intervals), each
	 * tick j = 1..T passing tube(j, xPrev, x) (true = allowed), fewest changes first; emit(code, x, v, k) -> true stops.
	 */
	function solveX(x0, v0, T, wins, tube, kMax, I, Hd, emit, budget, wall = null) {
		let wlo = Infinity, whi = -Infinity;
		for (const w of wins) { if (w[0] < wlo) wlo = w[0]; if (w[1] > whi) whi = w[1]; }
		const inWin = (x) => { for (let q = 0; q < wins.length; q++) if (x >= wins[q][0] && x < wins[q][1]) return true; return false; };
		const slack = K1.ALIGN_SLACK + 1e-6;
		let stop = false;
		const feasible = (x, v, n, kLeft, mi) => {
			if (n <= 0) return x >= wlo - 1e-9 && x < whi + 1e-9;
			const r = kLeft === 0 && mi !== 0 ? holdOne(Hd, x, v, n, mi, slack) : holdRange(Hd, x, v, n, slack);
			return r[1] >= wlo && r[0] < whi;
		};
		// the x map of tick j: the speed recurrence, the one-add move (T-ADD), the member's WALLS (wall(j, xPrev, x) =
		// the blocked x, vx = 0; the y of tick j is the member's, so the obstacle is a function of j), the align
		const step = (x, v, mi, j) => {
			v = K1.axisStep(v, I.ms[mi], 0, I.moO, 0, false);
			let xn = x + v;
			if (wall !== null) { const w = wall(j, x, xn, v); if (w !== xn) { xn = w; v = 0; } }
			const raw = xn;
			if (K1.armed(v, I.mods[mi], false)) xn = K1.align(xn);
			return [xn, v, raw];
		};
		// the final run from (x, v) after tick j0 with input mi to T: the tube every tick; [x, v] or null
		const finalRun = (j0, x, v, mi) => {
			for (let j = j0 + 1; j <= T; j++) {
				const xp = x;
				const r = step(x, v, mi, j); x = r[0]; v = r[1];
				if (!tube(j, xp, x, r[2])) return null;
			}
			return [x, v];
		};
		for (let kT = 0; kT <= kMax && !stop; kT++) {
			const rec = (t, x, v, miPrev, k, code) => {
				for (let mi = 0; mi < 3 && !stop; mi++) {
					if (k > 0 && mi === miPrev) continue;
					if (--budget.n < 0) { stop = true; budget.out = true; return; }
					if (!feasible(x, v, T - t, kT - k, mi)) continue;
					const code2 = (code | (mi << (2 * k)) | (k > 0 ? t << (8 + 7 * (k - 1)) : 0)) >>> 0;
					if (k === kT) {
						const r = finalRun(t, x, v, mi);
						if (r && inWin(r[0]) && emit(code2, r[0], r[1], k)) { stop = true; return; }
						continue;
					}
					// walk this run; after each tick j < T the next run may start (the change after tick j)
					const nmax = Math.min(T - 1, 127);
					if (k === kT - 1) {
						// the second to last run: LEMMA L (x_T monotone in the change tick when both runs are held keys)
						const xs = [], vs = [];
						let xx = x, vv = v;
						for (let j = t + 1; j <= nmax; j++) {
							const xp = xx;
							const r = step(xx, vv, mi, j); xx = r[0]; vv = r[1];
							if (!tube(j, xp, xx, r[2])) break;
							xs.push(xx); vs.push(vv);
						}
						const n = xs.length;
						for (let mf = 0; mf < 3 && !stop && n > 0; mf++) {
							if (mf === mi) continue;
							const code3 = (code2 | (mf << (2 * (k + 1)))) >>> 0;
							const tryAt = (i) => {
								const j = t + 1 + i;
								const r = finalRun(j, xs[i], vs[i], mf);
								if (r && inWin(r[0])) {
									const c = (code3 | (j << (8 + 7 * k))) >>> 0;
									if (emit(c, r[0], r[1], k + 1)) stop = true;
								}
							};
							const mono = mi !== 0 && mf !== 0 && !(I.mods[mi] < 0.1 && I.mods[mi] > -0.1) && !(I.mods[mf] < 0.1 && I.mods[mf] > -0.1);
							if (!mono) {
								for (let i = 0; i < n && !stop; i++) {
									if (--budget.n < 0) { stop = true; budget.out = true; return; }
									if (!feasible(xs[i], vs[i], T - (t + 1 + i), 0, mf)) continue;
									tryAt(i);
								}
								continue;
							}
							// the free end x_T(i) (no tube) is monotone in i: binary search the window's hull
							const up = K1.MS[mi] > K1.MS[mf];
							const endX = (i) => { let a = xs[i], b = vs[i]; for (let j = t + 2 + i; j <= T; j++) { const r = step(a, b, mf, j); a = r[0]; b = r[1]; } return a; };
							let a = 0, b = n;
							while (a < b) { const m = (a + b) >> 1; budget.n--; const e = endX(m); if (up ? e >= wlo - 1e-9 : e < whi + 1e-9) b = m; else a = m + 1; }
							for (let i = a; i < n && !stop; i++) {
								if (--budget.n < 0) { stop = true; budget.out = true; return; }
								const e = endX(i);
								if (up ? e >= whi + 1e-9 : e < wlo - 1e-9) break;
								tryAt(i);
							}
						}
						continue;
					}
					let xx = x, vv = v;
					for (let j = t + 1; j <= nmax && !stop; j++) {
						const xp = xx;
						const r = step(xx, vv, mi, j); xx = r[0]; vv = r[1];
						if (!tube(j, xp, xx, r[2])) break;
						rec(j, xx, vv, mi, k + 1, code2);
					}
				}
			};
			rec(0, x0, v0, -1, 0, 0);
		}
	}

	/** the target's x windows for a landing row fr (floor row): centre col in the target's cols of row fr - 1, box over a floor */
	function landWins(tg, sol, fr) {
		const out = [];
		for (const c of tg.colsByRow.get(fr - 1) || []) {
			// x in [16c - 8, 16c + 8) with a landable tile under [x, x + 16): the floor columns c - 1, c, c + 1
			const lo = 16 * c - 8, hi = 16 * c + 8;
			// (the landing probe sees the x before the align and after the first sub-step: 2 px of slack; the tube's
			// landing tick tests the floor exactly on those x)
			const f = (k) => k >= 0 && k < W && (fr >= Hh || sol[fr * W + k] !== 0);
			const sl = K1.ALIGN_SLACK;
			if (f(c)) { out.push([lo, hi]); continue; }
			if (f(c - 1)) out.push([lo, Math.min(hi, 16 * c + sl)]);
			if (f(c + 1)) out.push([Math.max(lo, 16 * c - sl), hi]);
		}
		return mergeWins(out);
	}
	function enterWins(tg, row) {
		const out = [];
		for (const c of tg.colsByRow.get(row) || []) out.push([16 * c - 8, 16 * c + 8]);
		return mergeWins(out);
	}

	/**
	 * THE PLAIN SOLVER: the (T, gravity member, row) list sorted by T, the x axis solved at each, candidates replayed.
	 * Returns {ok, masks, T, hop, cands, verifies, tool: 'plain'} or {ok: false, ...}.
	 */
	function solvePlain(snap, s, ctx, tg, goal, o, stats) {
		const Tmax = o.Tmax;
		const I = K1.ia(ctx), G = K1.ga(ctx), Hd = holdTables(ctx);
		const sol = solidOf(s), tiles = s.tiles;
		const x0 = s.px, vx0 = s.speed_x, y0 = s.py, vy0 = s.speed_y;
		const standing = s.on_ground && vy0 === 0;
		const fr0 = ((y0 + 16) | 0) >> 4;                       // the floor row under a standing ball (y0 = 16 fr0 - 16)
		const canJump = standing && s.max_jumps >= 1;
		const kMax = o.K === undefined ? KMAX : o.K;
		if (standing && y0 !== 16 * fr0 - 16) return { ok: false, why: 'standing off the grid (a half block / one-way)', tool: 'plain' };
		// the gravity members: {kind, j, Y (per tick), V, g (ground ticks: floor needed at 1..g), off (a walk-off tick)}
		const members = [];
		const fall = gravTrace(y0, 0, Tmax, G), air = gravTrace(y0, vy0, Tmax, G), jmp = gravTrace(y0, G.J, Tmax, G);
		if (standing) {
			if (canJump) for (let j = 1; j < Tmax; j++) members.push({ kind: 'jump', j, g: j, off: 0, y: (t) => (t <= j ? y0 : jmp.Y[t - j]), r: (t) => (t <= j ? y0 : jmp.R[t - j]), v: (t) => (t <= j ? 0 : jmp.V[t - j]), air0: j });
			for (let off = 1; off < Tmax; off++) members.push({ kind: 'off', j: 0, g: off - 1, off, y: (t) => (t < off ? y0 : fall.Y[t - off + 1]), r: (t) => (t < off ? y0 : fall.R[t - off + 1]), v: (t) => (t < off ? 0 : fall.V[t - off + 1]), air0: off - 1 });
			members.push({ kind: 'walk', j: 0, g: Tmax, off: 0, y: () => y0, r: () => y0, v: () => 0, air0: Tmax });
		} else {
			members.push({ kind: 'air', j: 0, g: 0, off: 0, y: (t) => air.Y[t], r: (t) => air.R[t], v: (t) => air.V[t], air0: 0 });
		}
		// THE BONK MEMBERS: a rise stopped by a ceiling row cr (its line 16 cr + 16: y blocked there, vy = 0), then the
		// fall from (line, 0): one member per (rising member, ceiling line between its apex and its start)
		const falls = new Map();
		const fallFrom = (yl) => { if (!falls.has(yl)) falls.set(yl, gravTrace(yl, 0, Tmax, G)); return falls.get(yl); };
		for (const m of members.slice()) {
			if (m.kind !== 'jump' && m.kind !== 'air') continue;
			let prev = m.kind === 'jump' ? y0 : y0;
			for (let t = m.air0 + 1; t <= Tmax; t++) {
				const yt = m.y(t);
				if (!(m.v(t) < 0)) break;
				// every ceiling line crossed upward in this tick: prev >= line > yt
				for (let line = (Math.floor(prev / 16)) * 16; line > yt; line -= 16) {
					// the blocked y: the line (the 1 px steps from a fractional y), or the start itself (from a whole y the
					// move is ONE add: blocked, it stays)
					const yb = Number.isInteger(prev) ? prev : line;
					const b = t, cr = line / 16 - 1, fl = fallFrom(yb);
					members.push({ kind: m.kind, j: m.j, g: m.g, off: 0, air0: m.air0, bonk: { b, cr, line: yb },
						y: (q) => (q < b ? m.y(q) : q === b ? yb : fl.Y[q - b]), r: (q) => (q < b ? m.r(q) : q === b ? yb : fl.R[q - b]), v: (q) => (q < b ? m.v(q) : q === b ? 0 : fl.V[q - b]) });
				}
				prev = yt;
			}
		}
		// the (T, member, windows) items
		const items = [];
		for (const m of members) {
			if (m.kind === 'walk') {
				// on the floor row: the target's tiles in the centre row fr0 - 1 (class G while walking)
				if (tg.cls === 'G' || tg.cls === 'any') {
					const wins = landWins(tg, sol, fr0);
					if (wins.length) for (let T = 1; T <= Tmax; T++) items.push({ T, m, wins, land: fr0 });
				}
				continue;
			}
			for (const fr of tg.landRows) {
				if (tg.cls !== 'G' && tg.cls !== 'any') break;
				const line = 16 * fr - 16;
				// the descending crossing of the floor line after the member's air start
				for (let t = Math.max(1, m.air0 + 1); t <= Tmax; t++) {
					const yp = t === 1 ? y0 : m.y(t - 1), yt = m.y(t);
					if (yp <= line && m.r(t) > line && m.v(t) > 0) { const wins = landWins(tg, sol, fr); if (wins.length) items.push({ T: t, m, wins, land: fr }); break; }
				}
			}
			if (tg.cls !== 'G') {
				for (const row of tg.rows) {
					const ylo = 16 * row - 8, yhi = 16 * row + 8;
					for (let t = Math.max(1, m.air0 + 1); t <= Tmax; t++) {
						const yt = m.y(t);
						if (yt >= ylo && yt < yhi) items.push({ T: t, m, wins: enterWins(tg, row), land: -1 });
					}
				}
			}
		}
		items.sort((a, b) => a.T - b.T || (a.m.kind === 'jump' ? a.m.j : 1e3 + a.m.off) - (b.m.kind === 'jump' ? b.m.j : 1e3 + b.m.off));
		const budget = { n: o.nodes || 400000, out: false };
		let best = null;
		for (const it of items) {
			if (best && it.T > best.T) break;
			if (budget.out) break;
			// the root cut: THEOREM M from the start
			const r0 = holdRange(Hd, x0, vx0, it.T, K1.ALIGN_SLACK + 1e-6);
			let any = false; for (const w of it.wins) if (r0[1] >= w[0] && r0[0] < w[1]) any = true;
			if (!any) continue;
			stats.items++;
			const m = it.m, T = it.T;
			const Ys = new Float64Array(T + 1);
			Ys[0] = y0;
			for (let t = 1; t <= T; t++) Ys[t] = m.y(t);
			if (it.land >= 0) Ys[T] = 16 * it.land - 16;
			// THE WALLS of the member's tick j: the box probed at the member's y (before and after the tick); blocked, x stops
			// at its last free sub-step (the 1 px steps from a fractional x; from a whole x a short move is ONE add: it stays)
			const wall = (j, x, xn) => {
				const ya = Ys[j], yb = Ys[j - 1];
				const blk = (p) => !(boxFree(sol, p, ya) && boxFree(sol, p, yb));
				if (!blk(xn)) return xn;
				let p = x;
				if (xn > x) {
					if (Number.isInteger(x) && xn - x < 1) return x;
					for (let q = Number.isInteger(x) ? x + 1 : Math.ceil(x); q <= xn; q += 1) { if (blk(q)) return p; p = q; }
					return p;
				}
				if (Number.isInteger(x)) return x;
				for (let q = Math.floor(x); q >= xn; q -= 1) { if (blk(q)) return p; p = q; }
				return p;
			};
			const tube = (j, xp, x, raw) => {
				// the first x sub-step's position (the y probe of the lockstep loop sees it); raw = x before the align
				if (raw === undefined) raw = x;
				let xs = raw;
				const fx = Math.floor(xp);
				if (raw > xp) { if (raw >= fx + 1) xs = fx + 1; } else if (raw < xp) { if (xp !== fx && raw < fx) xs = fx; }
				if (j <= m.g) return floorAt(sol, xs, fr0) && boxFree(sol, x, y0);
				if (m.off && j === m.off) { if (floorAt(sol, xs, fr0)) return false; }
				if (m.bonk && j === m.bonk.b) {
					// the ceiling over the box (at the sub-step, before or after the align) and the box free under it
					if (!(ceilAt(sol, xs, m.bonk.cr) || ceilAt(sol, raw, m.bonk.cr) || ceilAt(sol, x, m.bonk.cr))) return false;
					if (j < T) return boxFree(sol, x, m.bonk.line) && plainAt(tiles, x, m.bonk.line);
				}
				if (j === T) {
					if (it.land >= 0) return boxFree(sol, x, 16 * it.land - 16) && (floorAt(sol, raw, it.land) || floorAt(sol, xs, it.land) || floorAt(sol, x, it.land));
					return true;
				}
				return boxFree(sol, x, Ys[j]) && plainAt(tiles, x, Ys[j]);
			};
			const emit = (code, xT, vT, k) => {
				stats.cands++;
				// a field entry: the class letter reads the tile the centre was on at the tick's START, so the goal holds one
				// tick after the centre enters (the last input held one more tick)
				const extra = it.land < 0 && tg.cls !== 'any' ? 1 : 0;
				const masks = new Uint8Array(T + extra);
				for (let t = 1; t <= T + extra; t++) {
					let mk = MI_MASK[K1.inputAt(code, Math.min(t, T))];
					if (m.kind === 'jump' && t === m.j) mk |= 1;
					masks[t - 1] = mk;
				}
				stats.verifies++;
				const hit = replay(snap, masks, goal, T + extra);
				if (hit > 0) {
					const ms = masks.subarray(0, hit);
					if (!best || hit < best.T) best = { T: hit, masks: Uint8Array.from(ms), k, member: m.kind === 'jump' ? `jump@${m.j}` : m.kind === 'off' ? `off@${m.off}` : m.kind, code };
					return true;
				}
				return false;
			};
			const c0 = stats.cands;
			solveX(x0, vx0, T, it.wins, tube, kMax, I, Hd, emit, budget, wall);
			if (o.debug) o.debug({ T, kind: m.kind, j: m.j, off: m.off, bonk: m.bonk, land: it.land, wins: it.wins, cands: stats.cands - c0, best: best && best.T });
		}
		if (!best) return { ok: false, why: budget.out ? 'budget' : 'no plain candidate', tool: 'plain' };
		return Object.assign({ ok: true, tool: 'plain' }, best);
	}

	// ---------------------------------------------------------------- the coupled piece (per-tick one change, engine)
	function solveCoupled(snap, s, tg, goal, o, stats) {
		const Tmax = o.Tmax;
		const jumpFirst = [0, 1];
		let best = null;
		const snaps = [];
		const hold = (m0, p0, from, tick0, limit) => {
			// play mask m0 (with the jump bit p0 on the first tick of the leg) from snapshot `from` at leg tick tick0
			sim.restore(from);
			for (let t = tick0; t < limit; t++) {
				const px = sim.px, py = sim.py;
				E.applyMask(inp, t === 0 ? (m0 | p0) : m0);
				sim.tick(inp);
				stats.ticks++;
				if (goal(sim, px, py)) return t + 1;
				if (sim.is_dead) return 0;
			}
			return 0;
		};
		// F0
		for (const p0 of jumpFirst) for (const m0 of DIR9) {
			const h = hold(m0, p0, snap, 0, best ? best.T : Tmax);
			if (h && (!best || h < best.T)) { const ms = new Uint8Array(h).fill(m0); ms[0] |= p0; best = { T: h, masks: ms, k: 0 }; }
		}
		// F1: the prefix m0 (snapshots every tick), then m1 from tick c
		for (const p0 of jumpFirst) for (const m0 of DIR9) {
			const lim = best ? best.T - 1 : Tmax - 1;
			snaps.length = 0;
			sim.restore(snap);
			let alive = lim;
			for (let t = 0; t < lim; t++) {
				const px = sim.px, py = sim.py;
				E.applyMask(inp, t === 0 ? (m0 | p0) : m0);
				sim.tick(inp);
				stats.ticks++;
				if (sim.is_dead || goal(sim, px, py)) { alive = t; break; }
				snaps.push(sim.snapshot());
			}
			for (let c = 1; c <= alive && c <= snaps.length; c++) {
				const lim2 = best ? best.T : Tmax;
				if (c >= lim2) break;
				for (const m1 of DIR9) {
					if (m1 === m0) continue;
					const h = hold(m1, 0, snaps[c - 1], c, best ? best.T : Tmax);
					if (h && (!best || h < best.T)) {
						const ms = new Uint8Array(h);
						for (let t = 0; t < h; t++) ms[t] = t < c ? m0 : m1;
						ms[0] |= p0;
						best = { T: h, masks: ms, k: 1 };
					}
				}
				if (stats.ticks > (o.coupledTicks || 2e6)) break;
			}
			if (stats.ticks > (o.coupledTicks || 2e6)) break;
		}
		if (!best) return { ok: false, why: 'no coupled candidate', tool: 'coupled' };
		return Object.assign({ ok: true, tool: 'coupled' }, best);
	}

	// ---------------------------------------------------------------- the bound
	/** the admissible lower bound of the plain regime (0 when it does not apply: fields, teleports, multi-jumps) */
	function lowerBoundOf(s, tg, ctx) {
		if (!ctx || tg.tele) return 0;
		const G = K1.ga(ctx), I = K1.ia(ctx);
		const x0 = s.px, vx0 = s.speed_x, y0 = s.py, vy0 = s.speed_y;
		// x: the nearest target column's centre range [16c - 8, 16c + 8): hold toward from max(v0 toward, 0), with the slack
		let tx = Infinity;
		for (const t of tg.tiles) {
			const c = t % W, lo = 16 * c - 8, hi = 16 * c + 8;
			let need;
			if (x0 >= lo - K1.ALIGN_SLACK && x0 < hi + K1.ALIGN_SLACK) need = 0;
			else if (x0 < lo) need = minTo(x0, Math.max(vx0, 0), lo - K1.ALIGN_SLACK, 2, I);
			else need = minTo(x0, Math.min(vx0, 0), hi + K1.ALIGN_SLACK, 1, I);
			if (need < tx) tx = need;
		}
		// y: a landing on floor row fr (line 16 fr - 16) needs the ball to cross the line descending: below the start, the
		// fall from max(vy0, 0) is the fastest (no input adds downward speed in the plain regime); above, the jump from the
		// first tick (or the current rise) reaches the line first, then one more tick to land
		// y: the centre in target row r at tick T means y_T in [16 r - 8, 16 r + 8) (whatever the floor's height: half
		// blocks, one-ways); the align moves y by < 2 px (low gravity arms it): the slack. Below the start the fall from
		// max(vy0, 0) is the fastest (no input adds downward speed in the plain regime; a floor or a bonk only stops);
		// above it the rise of a jump pressed at tick 1 (y moves from tick 2) or the current rise, and a landing there
		// needs one tick more (the rise ends first)
		let ty = Infinity;
		const standing = s.on_ground && vy0 === 0;
		const SL = K1.ALIGN_SLACK;
		if (s.max_jumps === 1) {
			for (const r of tg.rows) {
				const ylo = 16 * r - 8 - SL, yhi = 16 * r + 8 + SL;
				let t = Infinity;
				if (y0 >= ylo && y0 < yhi) t = 0;
				else if (y0 < ylo) {
					let y = y0, v = Math.max(vy0, 0);
					for (let j = 1; j <= 4000; j++) { v = K1.axisStep(v, 0, G.mo, 0, 0, false); y += v; if (y >= ylo) { t = j; break; } }
				} else {
					const jumpNow = standing && s.jump_count < s.max_jumps;
					let y = y0, v = jumpNow ? G.J : Math.min(vy0, 0);
					for (let j = 1; j <= 4000; j++) { v = K1.axisStep(v, 0, G.mo, 0, 0, false); y += v; if (y < yhi) { t = j + (jumpNow ? 1 : 0) + (tg.cls === 'G' ? 1 : 0); break; } if (v > 0) break; }
				}
				if (t < ty) ty = t;
			}
		} else ty = 0;
		if (tg.cls === 'G' && ty < 1) ty = 1;
		const b = Math.max(tx, ty);
		return Number.isFinite(b) ? b : 0;
	}
	/**
	 * the bound's certificate: the ball cannot leave the plain regime within b ticks when no non-plain, non-solid tile
	 * lies in the rectangle the plain extremes reach (x: hold L / hold R, y: the jump's apex to the fall), so the bound
	 * holds for EVERY input sequence (a field, boost or portal the ball could reach first would void it)
	 */
	function certify(s, b, ctx) {
		if (b <= 0 || b > HOLD_T) return false;
		const G = K1.ga(ctx), Hd = holdTables(ctx);
		let xlo = s.px, xhi = s.px;
		for (let n = 1; n <= b; n++) {
			const qR = holdRange(Hd, s.px, Math.max(s.speed_x, 0), n, K1.ALIGN_SLACK), qL = holdRange(Hd, s.px, Math.min(s.speed_x, 0), n, K1.ALIGN_SLACK);
			if (qL[0] < xlo) xlo = qL[0]; if (qR[1] > xhi) xhi = qR[1];
		}
		let ylo = s.py - b * Math.max(Math.abs(G.J), -Math.min(s.speed_y, 0)) - K1.ALIGN_SLACK, yhi = s.py;
		{
			let y = s.py, v = Math.max(s.speed_y, 0);
			for (let n = 1; n <= b; n++) { v = K1.axisStep(v, 0, G.mo, 0, 0, false); y += v; if (y > yhi) yhi = y; }
			yhi += K1.ALIGN_SLACK;
		}
		if (s.max_jumps !== 1) return false;
		const c0 = Math.max(0, (Math.floor(xlo) >> 4)), c1 = Math.min(W - 1, (Math.floor(xhi + 16) >> 4));
		const r0 = Math.max(0, (Math.floor(ylo) >> 4)), r1 = Math.min(Hh - 1, (Math.floor(yhi + 16) >> 4));
		const tiles = s.tiles;
		for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
			const id = tiles[cy * W + cx];
			if ((flags[id] & F_SOLID) !== 0) continue;
			if (!(id < plainId.length && plainId[id] === 1)) return false;
		}
		return true;
	}
	function minTo(x0, v0, X, mi, I) {
		let x = x0, v = v0;
		for (let t = 1; t <= 4000; t++) {
			const r = K1.stepIA(x, v, mi, I); x = r[0]; v = r[1];
			if (mi === 2 ? x >= X : x <= X) return t;
		}
		return Infinity;
	}

	// ---------------------------------------------------------------- the leg
	function targetOf(target) {
		const tiles = Array.from(target.tiles);
		const colsByRow = new Map(), rows = new Set(), landRows = new Set();
		const add = (t) => {
			const c = t % W, r = (t / W) | 0;
			if (!colsByRow.has(r)) colsByRow.set(r, []);
			colsByRow.get(r).push(c);
			rows.add(r); landRows.add(r + 1);
		};
		const via = target.tele && target.via ? Array.from(target.via) : null;
		if (via) for (const t of via) add(t); else for (const t of tiles) add(t);
		return { tiles, cls: via ? 'any' : (target.cls || 'any'), tele: !!target.tele, colsByRow, rows: Array.from(rows), landRows: Array.from(landRows), via };
	}
	function snapOf(start) {
		if (start instanceof E.EESim) return start.snapshot();
		return start;
	}
	function leg(start, target, o = {}) {
		const t0 = process.hrtime.bigint();
		const snap = snapOf(start);
		sim.restore(snap);
		const stats = { items: 0, cands: 0, verifies: 0, ticks: 0 };
		const tg = targetOf(target);
		const goal = goalOf(target);
		const oo = Object.assign({ Tmax: opts.Tmax || 120 }, o);
		const ctx = plainStart(sim);
		const lb = ctx && !target.tele ? lowerBoundOf(sim, tg, ctx) : 0;
		const cert = lb > 0 && certify(sim, lb, ctx);
		let res = { ok: false, why: ctx ? 'no candidate' : 'not plain' };
		if (ctx && oo.plain !== false) {
			if (tg.via) {
				// a teleport target: enter the portal tile (any class), then the goal's own tick
				const pre = { tiles: tg.via, cls: 'any' };
				const r = solvePlain(snap, sim, ctx, targetOf(pre), goalOf(pre), oo, stats);
				if (r.ok) {
					// play on (no input) until the goal (the teleport) holds
					const ms = new Uint8Array(Math.min(oo.Tmax, r.T + 4));
					ms.set(r.masks);
					for (let t = r.T; t < ms.length; t++) ms[t] = r.masks[r.T - 1] & 30;
					const h = replay(snap, ms, goal);
					if (h) res = { ok: true, tool: 'plain', T: h, masks: ms.slice(0, h), k: r.k, member: r.member };
				}
			} else res = solvePlain(snap, sim, ctx, tg, goal, oo, stats);
		}
		if (!res.ok && oo.coupled !== false) {
			const r = solveCoupled(snap, sim, tg, goal, oo, stats);
			if (r.ok) res = r; else if (!ctx) res.why = 'not plain; ' + r.why;
		}
		if (res.ok) {
			// the landing hop: the same masks with the jump bit on the last tick (a different end state, the same support)
			const hm = Uint8Array.from(res.masks);
			hm[hm.length - 1] |= 1;
			res.hop = replay(snap, hm, goal, hm.length) === hm.length ? hm : null;
			res.lb = lb;
			res.cert = cert;
			res.proven = cert && res.T === lb;
		} else { res.lb = lb; res.cert = cert; res.proven = false; }
		res.cands = stats.cands; res.verifies = stats.verifies; res.items = stats.items; res.ticks = stats.ticks;
		res.us = Number(process.hrtime.bigint() - t0) / 1e3;
		return res;
	}

	return {
		L, sim, leg, goal: goalOf, clsOf: (s) => clsOf(s, flags),
		replay: (start, masks, target) => replay(snapOf(start), masks, goalOf(target)),
		lowerBound: (start, target) => { sim.restore(snapOf(start)); const c = plainStart(sim); return c ? lowerBoundOf(sim, targetOf(target), c) : 0; },
		solidOf, boxFree, floorAt, plainStart,
	};
}

function mergeWins(ws) {
	ws.sort((a, b) => a[0] - b[0]);
	const out = [];
	for (const w of ws) { if (out.length && w[0] <= out[out.length - 1][1]) { if (w[1] > out[out.length - 1][1]) out[out.length - 1][1] = w[1]; } else out.push([w[0], w[1]]); }
	return out;
}

module.exports = { createSolver, clsOf, holdTables, holdRange, mergeWins, DIR9, TELEPORT_PX };
