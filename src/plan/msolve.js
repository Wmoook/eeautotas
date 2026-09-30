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
//   5. NOT PLAIN (arrows, dots, liquids, climbables, boosts, portals) or no plain candidate: THE FIELD TIER,
//      src/math/fieldsolve.js solveLeg (the fields derivation's per-axis field kinematics: the start field's axis roles,
//      the gravity axis' options, the input axes by fields.solveAxis, the schedule iteration across field boundaries),
//      its answer replayed by this solver's goal test; then THE COUPLED PIECE, the per-tick one-change family over the
//      9 direction masks (and a press at the first tick) replayed by the engine with the prefix shared, only below the
//      field answer's T or where neither found one (cheapest T across the tiers). tool: 'plain' | 'field' | 'coupled'.
//   6. THE BOUND (sections 3.2, 1.4, docs/ee_math.md 5): a lower bound on the leg's ticks for EVERY input sequence of
//      the plain regime: max(x: the 1D minimum time (hold toward from max(v0 toward, 0), the align slack) to the target
//      columns' centre range, y: the first tick the fall from max(vy0, 0) (below) or the rise of a jump pressed now /
//      the current rise (above; past one jump's reach: |J| a tick at most) reaches the target rows' centre range, +1
//      for a landing above). Its CERTIFICATE: every non-plain, non-solid tile u inside the rectangle the plain extremes
//      reach in that many ticks has max(the first tick the centre can be in u's column, in u's row) >= the bound (THE
//      TILE TEST), or, with no portal / killer / effect in the box the ball can reach at the speed limit (20 px a tick),
//      that plus u's gap to the target at the limit (THE SPEED LIMIT); no timed killer running. A leg whose found T
//      equals a certified bound is PROVEN OPTIMAL (res.proven): no input sequence reaches the target sooner.
//   7. CHAINS (chain): A* over SUPPORT STATES with solved legs as edges: the direct leg to the target at every node,
//      the forward fan-out (landings: the earliest verified landing, and its hop, on the standable tiles the plain
//      extremes reach) and the event fan-out (the 18 held masks to their first support event), nodes merged by
//      stateHash; the claim fa = g + the certified plain bound, the order f = g + w x max(that bound, kappa x the reach
//      field's cost to the target's tiles), the reach field's -1 a proof; closed = optimal within the legs' graph.
// The gravity members also cover BONKS (a rise stopped by a ceiling line: y blocked there, vy = 0, then the fall) and
// the x map carries the member's WALLS (a blocked x stops at its last free sub-step, vx = 0); the landing reads the raw
// x and y before the align (the collision probe sees them).
//
// API
//   const S = createSolver(L, {K, Tmax})
//   S.leg(start, target, o) -> {ok, masks (Uint8Array of the leg, replayed), T, hop (masks with the jump on the last
//       tick: the landing hop, verified too) | null, lb, cert, proven, provenBy ('plain' | 'events'), lbMath, proveUs,
//       tool, member, k, cands, verifies, us, why}
//     start: an EESnapshot of L (sim.snapshot()) or an EESim of L (its current state is read, not changed)
//     target: {tiles: number[] (centre tiles), cls: 'G' | 'Z' | 'W' | 'C' | 'B' | 'A' | 'any', tele: bool (the goal tick
//       must teleport), via: number[] (portal tiles to enter for a teleport target)}
//     o: {Tmax, K (max x changes, default 2), plain, fields, coupled (each default true), nodes (the plain branch and
//       bound's budget, 400 k), fieldMs (250), coupledTicks (2 M), chain / chainAny / chainMs (the chain tier),
//       prove (the event-graph proof of src/math/lb.js for a leg the plain certificate did not prove; default
//       createSolver's opts.prove, false), proveMs (50), debug(item)}
//   S.chain(start, target, o) -> {ok, masks, T, closed, expanded, legs, nodes, cut, reach, firstMs, ms}
//                                o: {ms, legT, w, fanT, fanMax, fanNodes, events, reach (the reach field's order), kappa}
//   S.landings(start, o) -> [{tile, T, masks, hop}]   the forward fan-out from a plain state
//   S.lowerBound(start, target) -> ticks (the plain regime's bound; 0 when none applies)
//   S.goal(target) -> (sim, prevX, prevY) -> bool: the target's exact test on a real state
//   S.replay(start, masks, target) -> first tick (1-based) the goal holds, or 0
//   clsOf(sim, flags) -> the support class letter of a state (the moves study's: D W C Z B G A)
//   holdTables(ctx) -> THE HOLD TABLES (position-free offsets of hold R / hold L per start speed, 1/64 px/tick grid)
const E = require('../eesim.js');
const K1 = require('./kin1d.js');
const KN = require('./kin.js');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const PORTALS = new Set([242, 381]);
const TELEPORT_PX = 20;
const SPEED_PX = 20;                     // the most the centre moves in a tick an axis without a teleport (16 + the align)
let FS_ = null;
/** the field leg solver (src/math/fieldsolve.js), loaded on first use */
const FSOLVE = () => FS_ || (FS_ = require('../math/fieldsolve.js'));
let RF_ = null;
/** the reach field (src/reach.js), the chains' order, loaded on first use */
const RF = () => RF_ || (RF_ = require('../reach.js'));
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
	// the certificate's tile test (opts.certTiles false: the rectangle alone, the first version) and its speed-limit
	// refinement (opts.certSpeed false: off): a field tile the ball could reach first still leaves the bound when the
	// way on from it to the target at the speed limit ends at lb or later. The limit holds while no tile the ball could
	// meet teleports it (a portal) or kills it (a respawn: a killer, an effect with a timer): STRICT tiles, counted by a
	// summed-area table of the level's static tiles
	const certTiles = opts.certTiles !== false, certSpeed = opts.certSpeed !== false;
	const strictSAT = new Int32Array((W + 1) * (Hh + 1));
	{
		KN.flagsOf(flags.length - 1);
		const gt = KN.gravTables();
		const strictId = (id) => PORTALS.has(id) || EFFECT_IDS.has(id) || (id < gt.flags.length && (gt.flags[id] & 4) !== 0) || !!(L.gFlags && (L.gFlags[id] & 4) !== 0);
		for (let y = 0; y < Hh; y++) {
			let row = 0;
			for (let x = 0; x < W; x++) {
				const id = L.fg[y * W + x];
				if (strictId(id)) row++;
				strictSAT[(y + 1) * (W + 1) + x + 1] = strictSAT[y * (W + 1) + x + 1] + row;
			}
		}
	}
	/** the strict tiles in columns [x0, x1] x rows [y0, y1] (clamped to the world) */
	function strictIn(x0, y0, x1, y1) {
		x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W - 1, x1); y1 = Math.min(Hh - 1, y1);
		if (x1 < x0 || y1 < y0) return 0;
		const S = strictSAT, R = W + 1;
		return S[(y1 + 1) * R + x1 + 1] - S[y0 * R + x1 + 1] - S[(y1 + 1) * R + x0] + S[y0 * R + x0];
	}
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
					if (o.each) {
						// the fan-out: the walk's items per tile of the floor row (their own windows and goals)
						for (const c of tg.colsByRow.get(fr0 - 1) || []) {
							const wins = landWins({ colsByRow: new Map([[fr0 - 1, [c]]]) }, sol, fr0);
							if (wins.length) for (let T = 1; T <= Tmax; T++) items.push({ T, m, wins, land: fr0, tile: (fr0 - 1) * W + c });
						}
					} else {
						const wins = landWins(tg, sol, fr0);
						if (wins.length) for (let T = 1; T <= Tmax; T++) items.push({ T, m, wins, land: fr0 });
					}
				}
				continue;
			}
			for (const fr of tg.landRows) {
				if (tg.cls !== 'G' && tg.cls !== 'any') break;
				const line = 16 * fr - 16;
				// the descending crossing of the floor line after the member's air start
				for (let t = Math.max(1, m.air0 + 1); t <= Tmax; t++) {
					const yp = t === 1 ? y0 : m.y(t - 1);
					if (yp <= line && m.r(t) > line && m.v(t) > 0) {
						if (o.each) {
							// the forward fan-out: one item per target tile of the row (its own window)
							for (const c of tg.colsByRow.get(fr - 1) || []) {
								const wins = landWins({ colsByRow: new Map([[fr - 1, [c]]]) }, sol, fr);
								if (wins.length) items.push({ T: t, m, wins, land: fr, tile: (fr - 1) * W + c });
							}
						} else { const wins = landWins(tg, sol, fr); if (wins.length) items.push({ T: t, m, wins, land: fr }); }
						break;
					}
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
		const solved = o.each ? new Map() : null, goals = o.each ? new Map() : null, tries = new Map();
		for (const it of items) {
			if (!o.each && best && it.T > best.T) break;
			if (budget.out) break;
			if (o.each && solved.has(it.tile)) continue;
			if (o.each && o.perTile) { const n = (tries.get(it.tile) || 0) + 1; tries.set(it.tile, n); if (n > o.perTile) continue; }
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
				if (o.each) {
					let gt = goals.get(it.tile);
					if (!gt) { gt = goalOf({ tiles: [it.tile], cls: 'G' }); goals.set(it.tile, gt); }
					const h2 = replay(snap, masks, gt, T);
					if (h2 > 0) { solved.set(it.tile, { tile: it.tile, T: h2, masks: Uint8Array.from(masks.subarray(0, h2)) }); return true; }
					return false;
				}
				const hit = replay(snap, masks, goal, T + extra);
				if (hit > 0) {
					const ms = masks.subarray(0, hit);
					if (!best || hit < best.T) best = { T: hit, masks: Uint8Array.from(ms), k, member: m.kind === 'jump' ? `jump@${m.j}` : m.kind === 'off' ? `off@${m.off}` : m.kind, code };
					return true;
				}
				return false;
			};
			const c0 = stats.cands;
			// a per-item share of the budget: no one (T, member) item eats the whole leg's budget
			const cap = o.itemNodes || 40000, before = budget.n;
			const ib = { n: Math.min(budget.n, cap), out: false };
			solveX(x0, vx0, T, it.wins, tube, kMax, I, Hd, emit, ib, wall);
			budget.n = before - (Math.min(before, cap) - Math.max(ib.n, 0));
			if (budget.n <= 0) budget.out = true;
			if (o.debug) o.debug({ T, kind: m.kind, j: m.j, off: m.off, bonk: m.bonk, land: it.land, wins: it.wins, cands: stats.cands - c0, best: best && best.T });
		}
		if (o.each) return { ok: solved.size > 0, tool: 'plain', each: Array.from(solved.values()), budgetOut: budget.out };
		if (!best) return { ok: false, why: budget.out ? 'budget' : 'no plain candidate', tool: 'plain' };
		return Object.assign({ ok: true, tool: 'plain' }, best);
	}

	// ---------------------------------------------------------------- the coupled piece (per-tick one change, engine)
	// THE SPEED-LIMIT CUT of the coupled piece (sound): without a teleport the centre moves at most SPEED_PX a tick an axis
	// (a death ends the hold), so a state whose box position is g px (Chebyshev) from the target tiles' box range needs
	// ceil(g / SPEED_PX) more ticks; a hold whose tick + that exceeds its limit cannot reach the target within the limit,
	// nor can any branch from its later ticks (the bound holds for every input from that state). Off with a portal in the
	// level or a teleport target (the teleport jumps the limit)
	let hasPortal_ = null;
	function hasPortal() {
		if (hasPortal_ === null) { hasPortal_ = false; for (let i = 0; i < N; i++) if (PORTALS.has(L.fg[i])) { hasPortal_ = true; break; } }
		return hasPortal_;
	}
	function boxOf(tg) {
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (const t of (tg.via || tg.tiles)) { const c = t % W, r = (t / W) | 0; if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
		// the box position px of a centre in tile column c: [16 c - 8, 16 c + 8)
		return { xl: 16 * x0 - 8, xh: 16 * x1 + 8, yl: 16 * y0 - 8, yh: 16 * y1 + 8 };
	}
	// the coupled piece's JUMP FAMILIES and the cut (EEAT_MATH_CORDER=0: the first version's family alone, no cut): the
	// first version's order (the first-tick press, then DIR9) with the jump press at the change tick on the same direction
	// (hold, then jump: the most common unsolved field-leg pattern of the moves study) in the same pass, then the press on a
	// change of direction; a heading order (the masks toward the target first) lost more legs than it found
	const CORDER = process.env.EEAT_MATH_CORDER !== '0';
	function solveCoupled(snap, s, tg, goal, o, stats) {
		const Tmax = o.Tmax;
		const ordered = CORDER && o.coupledOrder !== false;
		const jumpFirst = [0, 1];
		let best = null;
		const snaps = [];
		const bx = ordered && !tg.tele && !tg.via && !hasPortal() ? boxOf(tg) : null;
		const cut = (t, limit) => {
			// (t: the leg tick just played, 1-based; the goal can hold at the earliest at t + need)
			const x = sim.px, y = sim.py;
			const g = Math.max(bx.xl - x, x - bx.xh, bx.yl - y, y - bx.yh, 0);
			return t + Math.ceil(g / SPEED_PX) > limit;
		};
		const hold = (m0, p0, from, tick0, limit) => {
			// play mask m0 (with the jump bit p0 on the first tick of the leg, or of this hold with p0 = 2) from snapshot
			// `from` at leg tick tick0
			sim.restore(from);
			for (let t = tick0; t < limit; t++) {
				const px = sim.px, py = sim.py;
				E.applyMask(inp, t === 0 ? (m0 | (p0 & 1)) : t === tick0 && p0 === 2 ? (m0 | 1) : m0);
				sim.tick(inp);
				stats.ticks++;
				if (goal(sim, px, py)) return t + 1;
				if (sim.is_dead) return 0;
				if (bx && cut(t + 1, limit)) { stats.cuts = (stats.cuts || 0) + 1; return 0; }
			}
			return 0;
		};
		const pre = [];
		for (const p0 of jumpFirst) for (const m0 of DIR9) pre.push([p0, m0]);
		// F0
		for (const [p0, m0] of pre) {
			const h = hold(m0, p0, snap, 0, best ? best.T : Tmax);
			if (h && (!best || h < best.T)) { const ms = new Uint8Array(h).fill(m0); ms[0] |= p0; best = { T: h, masks: ms, k: 0 }; }
		}
		// F1: the prefix m0 (snapshots every tick), then m1 from tick c; phase 0 = the family of the first version (m1 != m0)
		// with THE JUMP PRESS AT c ON THE SAME DIRECTION (m1 = m0, the jump bit at c: hold, then jump: 75% of the unsolved
		// field legs it solves), phase 1 (the budget left) the press at c on a change of direction (m1 != m0)
		const budget = o.coupledTicks || 2e6;
		const phases = ordered && o.coupledJump !== false ? [0, 1] : [0];
		for (const ph of phases) {
			for (const [p0, m0] of pre) {
				if (stats.ticks > budget) break;
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
					// (the cut: no branch from this tick on reaches the target within the limit)
					if (bx && cut(t + 1, best ? best.T : Tmax)) { alive = t; break; }
				}
				for (let c = 1; c <= alive && c <= snaps.length; c++) {
					const lim2 = best ? best.T : Tmax;
					if (c >= lim2) break;
					for (let i = 0; i < DIR9.length + 1; i++) {
						// phase 0: DIR9 (m1 != m0, no press) then m0 with the press (i = 9); phase 1: DIR9 (m1 != m0) with the press
						let m1, p1;
						if (i === DIR9.length) { if (ph !== 0 || !ordered || o.coupledJump === false) continue; m1 = m0; p1 = 2; }
						else { m1 = DIR9[i]; if (m1 === m0) continue; p1 = ph === 0 ? 0 : 2; }
						const h = hold(m1, p1, snaps[c - 1], c, best ? best.T : Tmax);
						if (h && (!best || h < best.T)) {
							const ms = new Uint8Array(h);
							for (let t = 0; t < h; t++) ms[t] = t < c ? m0 : m1;
							ms[0] |= p0;
							if (p1 === 2) ms[c] |= 1;
							best = { T: h, masks: ms, k: 1 };
						}
					}
					if (stats.ticks > budget) break;
				}
			}
		}
		if (!best) return { ok: false, why: 'no coupled candidate', tool: 'coupled' };
		return Object.assign({ ok: true, tool: 'coupled' }, best);
	}

	// ---------------------------------------------------------------- the bound
	/** the admissible lower bound of the plain regime (0 when it does not apply: fields, teleports, multi-jumps) */
	// the x part of the bound for one column: the centre in [16c - 8, 16c + 8) (with the align slack), hold toward from
	// max(v0 toward, 0)
	function txOf(s, I, c) {
		const x0 = s.px, vx0 = s.speed_x, lo = 16 * c - 8, hi = 16 * c + 8;
		if (x0 >= lo - K1.ALIGN_SLACK && x0 < hi + K1.ALIGN_SLACK) return 0;
		if (x0 < lo) return minTo(x0, Math.max(vx0, 0), lo - K1.ALIGN_SLACK, 2, I);
		return minTo(x0, Math.min(vx0, 0), hi + K1.ALIGN_SLACK, 1, I);
	}
	// the y part for one row (max_jumps 1): the centre in [16 r - 8, 16 r + 8) (with the slack); land: +1 above the start
	function tyOf(s, G, r, land) {
		const y0 = s.py, vy0 = s.speed_y, SL = K1.ALIGN_SLACK;
		const standing = s.on_ground && vy0 === 0;
		const ylo = 16 * r - 8 - SL, yhi = 16 * r + 8 + SL;
		let t = Infinity;
		if (y0 >= ylo && y0 < yhi) t = 0;
		else if (y0 < ylo) {
			let y = y0, v = Math.max(vy0, 0);
			for (let j = 1; j <= 4000; j++) { v = K1.axisStep(v, 0, G.mo, 0, 0, false); y += v; if (y >= ylo) { t = j; break; } }
		} else {
			const jumpNow = standing && s.jump_count < s.max_jumps;
			let y = y0, v = jumpNow ? G.J : Math.min(vy0, 0);
			for (let j = 1; j <= 4000; j++) { v = K1.axisStep(v, 0, G.mo, 0, 0, false); y += v; if (y < yhi) { t = j + (jumpNow ? 1 : 0) + (land ? 1 : 0); break; } if (v > 0) break; }
			// out of one jump's reach (stairs, re-jumps from landings): no tick rises more than |J| (the jump sets it,
			// gravity only slows it): a looser bound, still one
			if (!Number.isFinite(t)) t = Math.ceil((y0 - yhi) / Math.abs(G.J)) + (land ? 1 : 0);
		}
		return t;
	}
	function lowerBoundOf(s, tg, ctx) {
		if (!ctx || tg.tele) return 0;
		const G = K1.ga(ctx), I = K1.ia(ctx);
		// x: the nearest target column's centre range [16c - 8, 16c + 8): hold toward from max(v0 toward, 0), with the slack
		let tx = Infinity;
		for (const t of tg.tiles) {
			const need = txOf(s, I, t % W);
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
		if (s.max_jumps === 1) {
			for (const r of tg.rows) {
				const t = tyOf(s, G, r, tg.cls === 'G');
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
	function certify(s, b, ctx, tg) {
		if (b <= 0 || b > HOLD_T) return false;
		// a timed killer running (a curse, a zombie, fire, poison): its death respawns the ball elsewhere, no bound
		if (s.is_cursed || s.is_zombie || s.is_on_fire || s.is_poisoned) return false;
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
		// THE TILE TEST: a non-plain tile u inside the rectangle voids the bound only when the ball can reach it before
		// tick b: the first tick the centre can be in u's column (txOf) and in its row (tyOf, no landing) are lower bounds
		// on the first tick it is in u, valid up to the first non-plain tile a path enters (the plain regime holds until
		// then); so min over those tiles of max(tx, ty) >= b means no path leaves the plain regime before b, and the bound
		// holds for every input sequence
		const tiles = s.tiles, I = K1.ia(ctx);
		const txc = new Map(), tyr = new Map();
		// THE SPEED LIMIT: every speed is capped at 16 px/tick after the drag (boosts set 16), the sub-steps move by the
		// speed, the align by < 2 px: the centre moves at most SPEED_PX a tick an axis unless a portal teleports it or a
		// death respawns it; with no strict tile inside the box the ball can reach at that limit in b ticks, a path that
		// first leaves the plain regime at a field tile u still needs max(tx, ty)(u) + the gap from u to a target tile
		// at the limit
		let refine = false;
		if (certSpeed && tg && tg.tiles && tg.tiles.length) {
			const R = SPEED_PX * b;
			refine = strictIn(Math.floor((s.px - R) / 16), Math.floor((s.py - R) / 16), Math.floor((s.px + 16 + R) / 16), Math.floor((s.py + 16 + R) / 16)) === 0;
		}
		for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
			const id = tiles[cy * W + cx];
			if ((flags[id] & F_SOLID) !== 0) continue;
			if (id < plainId.length && plainId[id] === 1) continue;
			if (!certTiles) return false;
			let ty = tyr.get(cy);
			if (ty === undefined) { ty = tyOf(s, G, cy, false); tyr.set(cy, ty); }
			if (ty >= b) continue;
			let tx = txc.get(cx);
			if (tx === undefined) { tx = txOf(s, I, cx); txc.set(cx, tx); }
			if (tx >= b) continue;
			if (refine && Math.max(tx, ty) + gapTicks(cx, cy, tg) >= b) continue;
			return false;
		}
		return true;
	}
	/** the least ticks from anywhere in tile (cx, cy) to a target tile's centre range at the speed limit */
	function gapTicks(cx, cy, tg) {
		let best = Infinity;
		for (const t of tg.tiles) {
			const tc = t % W, tr = (t / W) | 0;
			const gx = Math.max(0, 16 * Math.abs(cx - tc) - 16), gy = Math.max(0, 16 * Math.abs(cy - tr) - 16);
			const n = Math.ceil(Math.max(gx, gy) / SPEED_PX);
			if (n < best) best = n;
		}
		return Number.isFinite(best) ? best : 0;
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
	// the reach field to a set of tiles (the chains' order), one per tile set, the newest 8 kept
	const rfCache = new Map();
	function reachFieldOf(tiles) {
		const key = Array.from(tiles).sort((a, b) => a - b).join(',');
		if (rfCache.has(key)) return rfCache.get(key);
		let f = null;
		try { f = RF().reachField(L, { goals: Array.from(tiles).map((t) => ({ tile: t, cost: 0 })), deaths: false }); } catch (e) { f = null; }
		if (rfCache.size >= 8) rfCache.delete(rfCache.keys().next().value);
		rfCache.set(key, f);
		return f;
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
		const cert = lb > 0 && certify(sim, lb, ctx, tg);
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
		if (!res.ok && oo.fields !== false && !target.tele) {
			// THE FIELD TIER (src/math/fieldsolve.js, the fields derivation): the start field's axis roles, the gravity
			// axis' option trajectories, the input axes solved by fields.solveAxis in the goal's windows, the schedule
			// iteration across field boundaries; its candidates replayed by the engine there
			sim.restore(snap);
			const r = FSOLVE().solveLeg(L, sim, { tiles: tg.tiles, cls: tg.cls === 'any' ? null : tg.cls, maxT: oo.Tmax }, { k: oo.fieldK || 2, maxMs: oo.fieldMs || 250 });
			stats.fields = (stats.fields || 0) + 1;
			if (r.ok) {
				// the goal replayed here by this solver's own test (the same letters; a teleport goal never reaches here)
				const hit = replay(snap, r.masks, goal);
				if (hit > 0) res = { ok: true, tool: 'field', T: hit, masks: Uint8Array.from(r.masks.subarray(0, hit)), member: r.tool };
			}
		}
		if (res.ok && res.tool === 'field' && oo.coupled !== false && res.T > 1) {
			// cheapest T across the tiers: the coupled piece below the field answer's T
			const r = solveCoupled(snap, sim, tg, goal, Object.assign({}, oo, { Tmax: res.T - 1 }), stats);
			if (r.ok && r.T < res.T) res = r;
		}
		if (!res.ok && oo.coupled !== false) {
			const r = solveCoupled(snap, sim, tg, goal, oo, stats);
			if (r.ok) res = r; else if (!ctx) res.why = 'not plain; ' + r.why;
		}
		if (!res.ok && oo.chain !== false && (ctx || oo.chainAny !== false) && !target.tele && oo.Tmax >= (oo.chainMin || 40)) {
			// THE CHAIN TIER: a long leg as a chain of shorter ones through supports (A* over support states, 4.6),
			// within this leg's horizon and a small clock; from a non-plain start too (its successors by the event fan-out:
			// a leg across fields = the pieces between its field events); the root's direct leg is this failed one
			const r = chain(snap, target, { Tmax: oo.Tmax, ms: oo.chainMs || 400, legT: Math.min(60, oo.Tmax), reach: oo.chainReach === true, rootLeg: false });
			stats.chain = r;
			if (r.ok) res = { ok: true, tool: 'chain', T: r.T, masks: r.masks, member: `chain ${r.expanded}` };
		}
		if (res.ok) {
			// the landing hop: the same masks with the jump bit on the last tick (a different end state, the same support)
			const hm = Uint8Array.from(res.masks);
			hm[hm.length - 1] |= 1;
			res.hop = replay(snap, hm, goal, hm.length) === hm.length ? hm : null;
			res.lb = lb;
			res.cert = cert;
			res.proven = cert && res.T === lb;
			if (res.proven) res.provenBy = 'plain';
		} else { res.lb = lb; res.cert = cert; res.proven = false; }
		res.cands = stats.cands; res.verifies = stats.verifies; res.items = stats.items; res.ticks = stats.ticks;
		res.us = Number(process.hrtime.bigint() - t0) / 1e3;
		if (res.ok && !res.proven && (oo.prove !== undefined ? oo.prove : opts.prove) && !target.tele) {
			// THE EVENT-GRAPH BOUND (src/math/lb.js, docs/ee_math.md section 5: the admissible bound over the level's
			// collision events, the build / bounds derivation): a leg found in exactly its bound's ticks is PROVEN OPTIMAL
			// from this state. The target's mode: 'land' for a landing class G (grounded with the centre there: the goal's
			// states are among them), 'touch' for the others (the centre in the tiles). Its time apart (res.proveUs)
			const p0 = process.hrtime.bigint();
			try {
				sim.restore(snap);
				const r = MLB().certify(sim, { tiles: tg.tiles, mode: tg.cls === 'G' ? 'land' : 'touch' }, res.T, { cap: oo.proveCap || 4000, ms: oo.proveMs || 50 });
				res.lbMath = r.lb;
				if (r.proven && r.lb === res.T) { res.proven = true; res.provenBy = 'events'; }
				// a bound above a replayed leg's ticks would be a counterexample to the bound: reported, never a proof
				if (r.lb !== null && r.lb > res.T) res.lbMathAbove = true;
			} catch (e) { res.lbMath = null; }
			res.proveUs = Number(process.hrtime.bigint() - p0) / 1e3;
		}
		return res;
	}
	let MLB_ = null;
	/** the event-graph bound (src/math/lb.js) of this level, made on first use */
	function MLB() { return MLB_ || (MLB_ = require('../math/lb.js').createMathLB(L)); }

	// ---------------------------------------------------------------- CHAINS: A* over support states
	/**
	 * standable support tiles near a state: a free centre tile over a landable tile (solid, one-way, half), the box
	 * there free, inside the rectangle the plain extremes can reach in `ticks`; sorted by the tile distance to the
	 * target's nearest tile (the order of the fan-out), at most `max`
	 */
	function supportsNear(s, ticks, ctx, tg, max) {
		const sol = solidOf(s), Hd = holdTables(ctx), G = K1.ga(ctx);
		let xlo = s.px, xhi = s.px;
		for (let n = 1; n <= Math.min(ticks, HOLD_T); n++) {
			const q = holdRange(Hd, s.px, s.speed_x, n, K1.ALIGN_SLACK);
			if (q[0] < xlo) xlo = q[0]; if (q[1] > xhi) xhi = q[1];
		}
		const ylo = s.py - 80, yhi = s.py + ticks * 13.6;
		const c0 = Math.max(0, Math.floor(xlo / 16)), c1 = Math.min(W - 1, Math.floor((xhi + 16) / 16));
		const r0 = Math.max(0, Math.floor(ylo / 16)), r1 = Math.min(Hh - 2, Math.floor((yhi + 16) / 16));
		// the current tile is no successor of a standing ball (a walk in place); a launched one (a hop) lands on it
		const here = s.on_ground && s.speed_y === 0 ? (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4) : -1;
		const tt = tg.tiles.map((t) => [t % W, (t / W) | 0]);
		const out = [];
		for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
			const t = cy * W + cx;
			if (t === here || sol[t] !== 0 || sol[t + W] === 0) continue;
			if (!(s.tiles[t] < plainId.length && plainId[s.tiles[t]] === 1)) continue;
			if (!boxFree(sol, 16 * cx, 16 * cy)) continue;
			let d = Infinity;
			for (const [gx, gy] of tt) { const e = Math.abs(gx - cx) + Math.abs(gy - cy); if (e < d) d = e; }
			out.push([d, t]);
		}
		out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		return out.slice(0, max).map((q) => q[1]);
	}
	/**
	 * landings(start, o): THE FORWARD FAN-OUT: from a plain state, the earliest verified landing (and its hop) on every
	 * standable tile the plain extremes reach within o.Tmax (60) ticks (at most o.max (400) tiles), each by the plain
	 * solver's (T, member, tile) items with <= o.K (1) x changes, one engine replay each: [{tile, T, masks, hop}]
	 */
	function landings(start, o = {}) {
		const snap = snapOf(start);
		sim.restore(snap);
		const ctx = plainStart(sim);
		if (!ctx) return [];
		const Tmax = o.Tmax || 60;
		// the fan-out's tiles: the nearest to the target and the nearest to the ball (half each: the target's side and the way out)
		const mx = o.max || 400;
		let tiles = supportsNear(sim, Tmax, ctx, o.toward || { tiles: [] }, mx);
		if (o.toward) {
			const near = supportsNear(sim, Tmax, ctx, { tiles: [(Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)] }, mx);
			const set = new Set(tiles.slice(0, mx >> 1));
			for (const t of near) { if (set.size >= mx) break; set.add(t); }
			tiles = Array.from(set);
		}
		if (!tiles.length) return [];
		const tg = targetOf({ tiles, cls: 'G' });
		const stats = { items: 0, cands: 0, verifies: 0, ticks: 0 };
		const r = solvePlain(snap, sim, ctx, tg, goalOf({ tiles, cls: 'G' }), { Tmax, K: o.K === undefined ? 1 : o.K, each: true, nodes: o.nodes || 150000, perTile: o.perTile || 0 }, stats);
		const out = r.each || [];
		for (const e of out) {
			const hm = Uint8Array.from(e.masks); hm[hm.length - 1] |= 1;
			const g = goalOf({ tiles: [e.tile], cls: 'G' });
			e.hop = replay(snap, hm, g, hm.length) === hm.length ? hm : null;
		}
		out.stats = stats;
		return out;
	}
	/**
	 * eventFan(start, maxT): each of the 18 held masks (DIR9, with and without the press on the first tick) played to
	 * its first support event within maxT ticks: a landing (on_ground after a tick in the air or a fresh press), the
	 * class letter changing (a field entered or left), a teleport; [{masks}] (deaths dropped)
	 */
	function eventFan(start, maxT) {
		const snap = snapOf(start);
		const out = [];
		for (const p0 of [0, 1]) for (const m0 of DIR9) {
			sim.restore(snap);
			const c0 = clsOf(sim, flags);
			let air = !sim.on_ground || sim.speed_y !== 0;
			const ms = [];
			for (let t = 0; t < maxT; t++) {
				const px = sim.px, py = sim.py;
				const mk = t === 0 ? (m0 | p0) : m0;
				E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
				if (sim.is_dead) break;
				const c = clsOf(sim, flags);
				const tele = Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX;
				if (tele || (c !== c0 && c !== 'A') || (sim.on_ground && air && t > 0)) { out.push({ masks: Uint8Array.from(ms), hop: null }); break; }
				if (!sim.on_ground) air = true;
			}
		}
		return out;
	}
	/**
	 * chain(start, target, o): A* over SUPPORT STATES with solved legs as edges. A node = an exact engine state (its
	 * snapshot, the masks from the chain's start, g = ticks); its edges = the direct leg to the target and legs to the
	 * o.fan (8) standable tiles nearest the target (supportsNear), each landing also as its hop (the jump on the
	 * landing tick: another state, the same support); nodes merged by stateHash (a state reached again no sooner is
	 * dropped); the order f = g + w x max(the plain bound, the reach field's cost to the target's tiles x kappa ticks a
	 * tile), the claim fa = g + the plain regime's certified lower bound (0 where none applies), so a search none of
	 * whose open nodes has fa below the best found has CLOSED: that chain is optimal within the graph of these legs (the
	 * reach field's -1 in physics mode drops a node: a proof). Lazy verification: every edge is the solver's replayed
	 * answer, made when its node is expanded, not before.
	 * o: {ms (2000), fan (8), legT (80: a leg's Tmax), K, w (1), reach (true: the reach field's order), kappa,
	 * coupledDirect}. Returns {ok, masks, T, closed, expanded, legs, nodes, cut, reach, ms}.
	 */
	function chain(start, target, o = {}) {
		const t0 = Date.now(), budgetMs = o.ms || 2000, fan = o.fan === undefined ? 8 : o.fan, legT = o.legT || 80;
		const snap0 = snapOf(start);
		const tg = targetOf(target);
		const heap = [];
		// the least f first, among equal f the deepest (the larger g: the same guarantees, the goal sooner)
		const lt = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);
		const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!lt(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && lt(heap[l], heap[m])) m = l; if (r < heap.length && lt(heap[r], heap[m])) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
		const push = (n) => { heap.push(n); up(heap.length - 1); };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; down(0); } return top; };
		// h: two numbers. THE CLAIM (fa = g + adm): the plain bound, admissible; a bound without its certificate (a field
		// or a portal within reach) voids the closed claim (uncert). THE ORDER (f = g + w x ord): the larger of that bound
		// and the reach field to the target's tiles (src/reach.js, deaths off: the chain never dies) in ticks at the top
		// running speed (not admissible: an order only); the reach field's -1 in physics mode is a proof (no death-free way
		// to the tiles), so such a node is dropped
		// TWO PHASES (anytime): the order's weight w1 (o.w1, default 2: greedy toward the target) until the first chain
		// or half the clock, then w (o.w, default 1: A*, the best chain pruned by fa); the heap re-keyed at the switch
		let uncert = false, cut = 0;
		const wEnd = o.w || 1, w1 = o.w1 === undefined ? Math.max(2, wEnd) : o.w1, switchMs = budgetMs * (o.phase1 === undefined ? 0.5 : o.phase1);
		let W8 = w1, phase = w1 === wEnd ? 2 : 1;
		const rekey = () => {
			W8 = wEnd; phase = 2;
			for (const x of heap) x.f = x.g + W8 * x.h;
			for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
		};
		const rf = o.reach === false ? null : reachFieldOf(tg.tiles);
		const KAPPA = o.kappa || 16 / 6.776552880470027;
		const hOf = () => {
			let b = 0;
			const c = plainStart(sim);
			if (c && !tg.tele) {
				b = lowerBoundOf(sim, tg, c);
				if (b > 0 && !certify(sim, b, c, tg)) uncert = true;
			}
			let ord = b;
			if (rf) {
				const rc = RF().costAt(rf, sim);
				if (rc < 0) { if (rf.mode === 'physics') { cut++; return null; } } else ord = Math.max(ord, rc * KAPPA);
			}
			return { adm: b, ord };
		};
		const cat = (a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };
		const seen = new Map();
		sim.restore(snap0);
		seen.set(sim.stateHash(), 0);
		const h0 = hOf();
		if (h0) push({ snap: snap0, g: 0, masks: new Uint8Array(0), h: h0.ord, f: W8 * h0.ord, fa: h0.adm });
		let best = null, expanded = 0, legs = 0, nodes = 1, firstAt = 0;
		while (heap.length && Date.now() - t0 < budgetMs) {
			if (phase === 1 && (best || Date.now() - t0 >= switchMs)) rekey();
			const n = pop();
			if (best && n.fa >= best.T) continue;
			expanded++;
			if (o.trace) o.trace(n);
			const horizon = o.Tmax ? o.Tmax - n.g : Infinity;
			const lim = Math.min(best ? Math.min(legT, best.T - n.g - 1) : legT, horizon);
			if (lim <= 0) continue;
			sim.restore(n.snap);
			const plainNode = !!plainStart(sim);
			if (n.g > 0 || o.rootLeg !== false) {
				const r = leg(n.snap, target, { Tmax: lim, K: o.K, chain: false, fields: !plainNode, coupled: !plainNode && o.coupledDirect !== false, nodes: o.legNodes || 40000, coupledTicks: o.coupledTicks || 300000 });
				legs++;
				if (r.ok && (!best || n.g + r.T < best.T)) { if (!best) firstAt = Date.now() - t0; best = { T: n.g + r.T, masks: cat(n.masks, r.masks) }; }
			}
			sim.restore(n.snap);
			const ctx = plainStart(sim);
			if (fan <= 0) continue;
			const lands = ctx ? landings(n.snap, { Tmax: Math.min(lim, o.fanT || 60), K: o.fanK, max: o.fanMax || 30, toward: tg, nodes: o.fanNodes || 20000, perTile: o.perTile || 0 }) : [];
			if (o.events !== false) for (const e of eventFan(n.snap, Math.min(lim, o.fanT || 60))) lands.push(e);
			legs += lands.length;
			for (const rr of lands) {
				if (Date.now() - t0 >= budgetMs) break;
				for (const ms of [rr.masks, rr.hop]) {
					if (!ms) continue;
					const g = n.g + ms.length;
					if (best && g >= best.T) continue;
					if (o.Tmax && g >= o.Tmax) continue;
					sim.restore(n.snap);
					let dead = false;
					for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); if (sim.is_dead) { dead = true; break; } }
					if (dead) continue;
					const hsh = sim.stateHash();
					if (seen.has(hsh) && seen.get(hsh) <= g) continue;
					seen.set(hsh, g);
					const h = hOf();
					if (!h) continue;
					if (best && g + h.adm >= best.T) continue;
					push({ snap: sim.snapshot(), g, masks: cat(n.masks, ms), h: h.ord, f: g + W8 * h.ord, fa: g + h.adm });
					nodes++;
				}
			}
		}
		let open = 0;
		for (const x of heap) if (!best || x.fa < best.T) open++;
		const closed = !!best && !uncert && open === 0;
		return { ok: !!best, masks: best ? best.masks : null, T: best ? best.T : 0, closed, expanded, legs, nodes, cut, reach: rf ? rf.mode : null, firstMs: firstAt, ms: Date.now() - t0 };
	}

	return {
		L, sim, leg, chain, landings, supportsNear, goal: goalOf, clsOf: (s) => clsOf(s, flags),
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
