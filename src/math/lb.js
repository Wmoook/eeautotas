'use strict';
// THE ADMISSIBLE LEG BOUND FROM THE EXACT MATHEMATICS (n4-math, Build / bounds, 2026-09-30). A lower bound on the ticks
// any input sequence needs to bring the ball from an EXACT engine state to a target (the centre tile in a tile set:
// 'touch'; or grounded with the centre there: 'land'), built from the per-axis recurrences of src/plan/kin1d.js (the
// engine's own doubles, never a rounded state) and the level's tiles. docs/ee_math.md section 4 has the theorems; every
// one is checked against the engine by tools/math/lbcheck.js and test/admbounds_truth.js (the 'math' column).
//
// THE MODEL (plain physics: gravity down, the current and the delayed tile plain air, no effect but the speed / jump /
// gravity multipliers, max_jumps 1; the level's other tiles SOURCES: see below)
//  X  the input axis. The x speed after a tick is v' = step_m(v) (m the key; with ice anywhere also the ice rules) or 0
//     (a wall), the position fl(x + v') or a point between x and it (a blocked step), then maybe the auto-align. Every
//     step is non-decreasing in v and fl(+) and align are non-decreasing, so (THEOREM X) every path lies in
//     [Xmin_t, Xmax_t] with   U_t = max(max_m step_m(U_(t-1)), 0),  Xmax_t = A+(fl(Xmax_(t-1) + U_t)),
//     A+(X) = max(X, align(X)), and the mirror for Xmin: the 1D envelope, exact doubles, no slack constant.
//  Y  the gravity axis. In the air v' = (v + G) B whatever the input (THEOREM S of kin1d); the only other changes are
//     COLLISION EVENTS: a blocked rising step (a BONK: v = 0 under a ceiling line c; y in [c, c + 1) or its integer
//     pre-position) and a blocked falling step (a LANDING: grounded on a standing line s = top - 16; y = s), after which
//     the jump may set v = J (the landing tick itself: the hop). So a y path is a chain of FLIGHTS between events whose
//     lines are the level's tile tops and bottoms. THE EVENT GRAPH: nodes LAND(column, s) and BONK(column, c, band),
//     edges the flights (exact double trajectories from the node's y band), an event possible at flight tick n only if
//     the flight crosses the line then (descending past s: a landing; rising past c: a bonk) in a column the x window
//     reaches at that tick. Walking: LAND(k, s) -> LAND(k +- 1, s) in >= 1 tick (the centre column changes).
//     Every real path maps to a path of this graph whose times are <= the real ones (relaxations only: every tile that
//     can block is a floor and a ceiling everywhere it could be, walls never stop x, the x speed at a node is anything
//     up to U = max(|vx0|, v*)), so the graph's shortest time to the target is ADMISSIBLE (THEOREM G).
//  SOURCES  tiles whose physics is not plain air (arrows, dots, boosts, climbables, liquids, effects, portals, killers,
//     music; dilated by one tile for the half block's centre shift): the model holds until the centre first enters one.
//     A flight tick whose (x window, y band) meets a source at time t closes that branch with t + rest(source) (rest =
//     a field's value there, e.g. src/plan/admbounds.js, else 0): sound because the path is plain until then.
// Result: lb = min(best target time, the frontier when the node cap stops the graph, a source branch).
//
// API
//   createMathLB(L, o) -> {leg(sim, target, lo) -> {lb, why, tx, arc, nodes, capped, src}, static}
//     target {tiles: int[] | Int32Array, mode: 'touch' | 'land'}; lo {field: Float32Array (rest per tile, optional),
//     cap: node cap (default 4000), horizon (default 3000)}
//   lb === null: the state is outside the plain model (an effect, a field tile under the ball, levitation, flipped
//   gravity, god mode, dead, multi-jump): use the other bounds.
//   proof(lb, ticks) -> 'optimal' | 'gap' (a leg found in exactly lb ticks is PROVEN OPTIMAL from that state)
const E = require('../eesim.js');
const K = require('../plan/kin1d.js');
const A = require('../plan/admbounds.js');
const RF = require('../reach.js');

const C = E.constants;
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
const ICE = 1064, PORTAL = 242, PORTAL_INV = 381, SECRET = 243;
const LINE0 = 4;            // line index = y / 8 + LINE0 (lines from -32 px)

// ---------------------------------------------------------------- the per-axis maps
function alignUp(X) { const a = K.align(X); return a > X ? a : X; }
function alignDn(X) { const a = K.align(X); return a < X ? a : X; }

/** the x step maxima / minima over every input (and the ice rules when ice is possible) */
function xSteps(ctx, ice) {
	const I = K.ia(ctx);
	const ms = [I.ms[2], 0, I.ms[1]];
	const slips = ice ? [false, true] : [false];
	const up = (u) => { let b = -Infinity; for (const m of ms) for (const s of slips) { const v = K.axisStep(u, m, 0, I.moO, 0, s); if (v > b) b = v; } return b; };
	const dn = (u) => { let b = Infinity; for (const m of ms) for (const s of slips) { const v = K.axisStep(u, m, 0, I.moO, 0, s); if (v < b) b = v; } return b; };
	return { up, dn, I };
}

// ---------------------------------------------------------------- static per level
const STATIC = new WeakMap();
function staticOf(L) {
	let S = STATIC.get(L);
	if (S) return S;
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags, nF = fl.length;
	const AS = A.staticOf(L);
	// blocking tiles: 1 = a plain static solid (top 16r, bottom 16r + 16), 2 = can block with another shape or state
	// (half blocks, one-ways, doors and gates, the secret block): tops 16r and 16r + 8, bottoms 16r + 8 and 16r + 16
	const blk = new Uint8Array(N);
	let ice = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id === ICE) ice = true;
		if (id === SECRET) { blk[i] = 2; continue; }
		if (id < 0 || id >= nF) { blk[i] = 2; continue; }
		const f = fl[id];
		if ((f & F_SOLID) === 0) continue;
		blk[i] = (f & (F_ROTHALF | F_HALF | F_JUMPTHRU | F_DOOR)) !== 0 ? 2 : 1;
	}
	// per centre column kc and line: the standing lines s (a top t of a tile in columns kc - 1..kc + 1: s = t - 16) and
	// the ceiling lines c (a bottom); stored per line index as sorted column lists
	const NL = 2 * H + 2 * LINE0 + 4;
	const lineIdx = (y) => (y >> 3) + LINE0;
	const stand = Array.from({ length: NL }, () => new Set()), ceil = Array.from({ length: NL }, () => new Set());
	for (let i = 0; i < N; i++) {
		if (!blk[i]) continue;
		const x = i % W, y = (i - x) / W;
		const tops = blk[i] === 1 ? [16 * y] : [16 * y, 16 * y + 8];
		const bots = blk[i] === 1 ? [16 * y + 16] : [16 * y + 8, 16 * y + 16];
		for (let kc = x - 1; kc <= x + 1; kc++) {
			if (kc < 0 || kc >= W) continue;
			for (const t of tops) { const li = lineIdx(t - 16); if (li >= 0 && li < NL) stand[li].add(kc); }
			for (const b of bots) { const li = lineIdx(b); if (li >= 0 && li < NL) ceil[li].add(kc); }
		}
	}
	// the world's edges block like solids (a box out of the world overlaps): the top edge a ceiling (the ball's top at
	// y = 0), the bottom edge a floor (standing at y = 16 H - 16)
	for (let kc = 0; kc < W; kc++) { ceil[lineIdx(0)].add(kc); stand[lineIdx(16 * H - 16)].add(kc); }
	const toArr = (a) => a.map((s) => Int32Array.from([...s].sort((p, q) => p - q)));
	// SOURCES by the centre cell (the engine's `current`: the tile under the centre, a half block's cell shifted to the
	// cell above (rot 1, presents) or to the left (rot 0), eesim.js _playerTick): phys = its physics is not plain air
	// (arrows, dots, boosts, climbables, liquids, effects, music) or it teleports (a portal that is not silent);
	// kill = it kills (spikes, fire, toxic: death at the next tick's start, 54+ dead ticks). No dilation: every one of
	// these reads the tick-start centre cell (touchBlock, processPortals, the gravity queue's `current`).
	const lk = L.lookup0, xfl = L.xflags || [];
	const silent = RF.silentPortals ? RF.silentPortals(L) : null;
	const phys = new Uint8Array(N), kill = new Uint8Array(N), portalOf = new Int32Array(N).fill(-1);
	for (let i = 0; i < N; i++) {
		let j = i;
		const id0 = fg[i];
		if (id0 >= 0 && id0 < nF && (fl[id0] & F_HALF) !== 0) {
			let rot = lk ? lk[i] : 0;
			if ((xfl[id0] & 4) !== 0) rot = 1;
			const x = i % W, y = (i - x) / W;
			if (rot === 1) j = y > 0 ? i - W : -1;
			else if (rot === 0) j = x > 0 ? i - 1 : -1;
		}
		const id = j < 0 ? 0 : fg[j];
		if (!AS.tameQ(id)) phys[i] = 1;
		if ((id === PORTAL || id === PORTAL_INV) && j >= 0 && !(silent && silent[j])) { phys[i] = 1; portalOf[i] = j; }
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) kill[i] = 1;
	}
	const src = new Uint8Array(N);
	for (let i = 0; i < N; i++) src[i] = phys[i] | kill[i];
	const W1 = W + 1, ps = new Int32Array(W1 * (H + 1));
	for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += src[y * W + x]; ps[(y + 1) * W1 + x + 1] = ps[y * W1 + x + 1] + row; } }
	// THE TELEPORTS (for the rest after a source): portal cells grouped by their exit set (the exit tiles of the portal's
	// target id), kill cells (a death: DEATH_MIN dead ticks, then a respawn tile: a checkpoint or a spawn), and each
	// group's Chebyshev distance transform in tiles (the nearest entry cell)
	const groups = new Map();   // exit key -> {exits: tile[], cells: []}
	if (L.portalSlot && L.portalsById) for (let i = 0; i < N; i++) {
		const j = portalOf[i];
		if (j < 0) continue;
		const sl = L.portalSlot[j];
		if (sl < 0) continue;
		const ex = L.portalsById.get(L.pTarget[sl]);
		if (!ex || !ex.n) continue;
		const tl = [];
		for (let k = 0; k < ex.n; k++) { const x = ex.xs[k] >> 4, y = ex.ys[k] >> 4; if (x >= 0 && y >= 0 && x < W && y < H) tl.push(y * W + x); }
		if (!tl.length) continue;
		tl.sort((a, b) => a - b);
		const key = tl.join(',');
		let gr = groups.get(key);
		if (!gr) { gr = { exits: Int32Array.from(tl), cells: [] }; groups.set(key, gr); }
		gr.cells.push(i);
	}
	const tele = [];
	for (const gr of groups.values()) tele.push({ exits: gr.exits, cost: 1, dist: chebTransform(W, H, gr.cells) });
	const killCells = [];
	for (let i = 0; i < N; i++) if (kill[i] && !phys[i]) killCells.push(i);
	const respawn = AS.respawn || new Int32Array(0);
	if (killCells.length && respawn.length) tele.push({ exits: respawn, cost: A.DEATH_MIN, dist: chebTransform(W, H, killCells), death: true });
	S = { W, H, N, blk, NL, lineIdx, stand: toArr(stand), ceil: toArr(ceil), src, phys, kill, ps, W1, ice, AS, tame: AS.tameLevel,
		tele, respawn, timed: !!AS.timed, sups: levelSups(L, groups.size > 0) };
	STATIC.set(L, S);
	return S;
}
/**
 * THE BOUNDED SPEED-UPS: the most speed any tick of the level can give each axis, from the classes of the level's own
 * tiles (the fields' fixed points, section 1.4 / 6): x the held run (v* at the speed effect's x1.5 where one is in the
 * level), the fall's terminal where x can be a gravity axis (side arrows, gravity effects), 16 where a boost of the
 * axis, a portal (the rotation's x 1.42 then the cap) or levitation is; y down the fall's terminal (the level's world
 * gravity) or 16 (down boosts, portals, levitation); y up the jump's |J| (the jump effect's x1.3), the fall's terminal
 * under up arrows / gravity effects, the climb and the liquids' drifts, or 16 (up boosts, portals, levitation). An
 * effect or tile of unknown physics: 16 everywhere. Every speed after a source contact is within these (+ the align's
 * 0.25 px a tick), so a source's rest is at least the distance over them.
 */
// the effects of admbounds.js's UNTAME list whose speed effect is not modelled here (16 on every axis where one is)
const UNKNOWN_FX = new Set([453, 1520, 1573]);
function levelSups(L, portals) {
	const fg = L.fg, fl = L.flags, ids = new Set();
	for (let i = 0; i < fg.length; i++) ids.add(fg[i]);
	const has = (id) => ids.has(id);
	let gm = L.gravityMult;
	if (!(Number.isFinite(gm) && gm > 0)) return { x: 16, up: 16, down: 16 };
	if (gm < 1) gm = 1;
	const fallT = A.terminal((2 * gm) / C.MULT, C.BASE_DRAG);
	const runT = (sm) => A.terminal(sm / C.MULT, C.BASE_DRAG);
	let unknown = false, climb = false, liquid = false;
	for (const id of ids) {
		if (id < 0 || id >= fl.length) { unknown = true; continue; }
		if (fl[id] & 32) climb = true;
		if (fl[id] & 64) liquid = true;
		if (UNKNOWN_FX.has(id)) unknown = true;
	}
	if (unknown) return { x: 16, up: 16, down: 16 };
	const fly = has(418), grav = has(1517);
	const side = has(1) || has(3) || has(411) || has(413) || grav;
	const up = has(2) || has(412) || grav;
	const jm = has(417) ? 1.3 : 1;
	const J = (2 * 26 * jm) / C.MULT;
	const x = Math.max(runT(1), has(419) ? runT(1.5) : 0, side ? fallT : 0, has(114) || has(115) || portals || fly ? 16 : 0);
	const down = Math.max(fallT, has(117) || portals || fly ? 16 : 0);
	const upv = Math.max(J, up ? fallT : 0, has(116) || portals || fly ? 16 : 0, climb ? 1.1 : 0, liquid ? 4 : 0);
	return { x: Math.min(16, x), up: Math.min(16, upv), down: Math.min(16, down) };
}
/** the fewest ticks to move the centre from any point of one tile to any point of a tile (dx, dy) tiles away (dy > 0
 *  down) at the speed sups (+ 0.25 px a tick for the align; 7 px once for a portal's x1.42 tick) */
function supTicks(dx, dy, sp) {
	const f = (d, v) => { if (d <= 1) return 0; const px = 16 * (d - 1) - SLACK_PX; return px <= 0 ? 0 : Math.ceil(px / (v + 0.25) - 1e-9); };
	return Math.max(f(Math.abs(dx), sp.x), f(Math.abs(dy), dy > 0 ? sp.down : sp.up));
}

/** the Chebyshev (8-way) distance in tiles from every tile to the nearest of `cells` (two-pass transform) */
function chebTransform(W, H, cells) {
	const INF = 1 << 29, d = new Int32Array(W * H).fill(INF);
	for (const c of cells) d[c] = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = y * W + x;
		let v = d[i];
		if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
		if (y > 0) { const u = i - W; if (d[u] + 1 < v) v = d[u] + 1; if (x > 0 && d[u - 1] + 1 < v) v = d[u - 1] + 1; if (x + 1 < W && d[u + 1] + 1 < v) v = d[u + 1] + 1; }
		d[i] = v;
	}
	for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
		const i = y * W + x;
		let v = d[i];
		if (x + 1 < W && d[i + 1] + 1 < v) v = d[i + 1] + 1;
		if (y + 1 < H) { const u = i + W; if (d[u] + 1 < v) v = d[u] + 1; if (x > 0 && d[u - 1] + 1 < v) v = d[u - 1] + 1; if (x + 1 < W && d[u + 1] + 1 < v) v = d[u + 1] + 1; }
		d[i] = v;
	}
	return d;
}
/** the fewest ticks for the centre to go from any point of one tile to any point of a tile d tiles away (Chebyshev):
 *  every axis moves at most 16.25 px a tick (the speed cap 16 and the align; + 7 px once for a portal's x1.42 tick) */
const V_CAP = 16.25, SLACK_PX = 7;
function chebTicks(d) { if (d <= 1) return 0; const px = 16 * (d - 1) - SLACK_PX; return px <= 0 ? 0 : Math.ceil(px / V_CAP - 1e-9); }

/** the source tiles in columns [x0, x1] x rows [y0, y1] (clamped) */
function srcCount(S, x0, x1, y0, y1) {
	if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= S.W) x1 = S.W - 1; if (y1 >= S.H) y1 = S.H - 1;
	if (x0 > x1 || y0 > y1) return 0;
	const W1 = S.W1, p = S.ps;
	return p[(y1 + 1) * W1 + x1 + 1] - p[y0 * W1 + x1 + 1] - p[(y1 + 1) * W1 + x0] + p[y0 * W1 + x0];
}

// ---------------------------------------------------------------- the heap (time, node)
class Heap {
	constructor() { this.k = new Float64Array(256); this.v = new Int32Array(256); this.n = 0; }
	push(key, node) {
		if (this.n >= this.k.length) { const k2 = new Float64Array(this.k.length * 2), v2 = new Int32Array(this.k.length * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
		let i = this.n++;
		const K_ = this.k, V = this.v;
		while (i > 0) { const p = (i - 1) >> 1; if (K_[p] <= key) break; K_[i] = K_[p]; V[i] = V[p]; i = p; }
		K_[i] = key; V[i] = node;
	}
	pop() {
		const K_ = this.k, V = this.v, top = V[0], n = --this.n;
		if (n > 0) {
			const key = K_[n], node = V[n];
			let i = 0;
			for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K_[c + 1] < K_[c]) c++; if (K_[c] >= key) break; K_[i] = K_[c]; V[i] = V[c]; i = c; }
			K_[i] = key; V[i] = node;
		}
		return top;
	}
}

/** the plain context of a state, or null (outside the model) */
function plainCtx(sim, S) {
	if (!S.tame || sim.is_dead || sim.in_god_mode || sim.has_levitation || sim.flip_gravity !== 0 || sim.max_jumps !== 1) return null;
	if (sim.is_zombie || sim.is_cursed || sim.is_on_fire || sim.is_poisoned) return null;
	const cur = sim.current_tile === undefined ? 0 : sim.current_tile;
	if (!S.AS.tameQ(sim._q0) || !S.AS.tameQ(sim._q1) || !S.AS.tameQ(cur)) return null;
	const ctx = K.ctxOf(sim);
	return ctx;
}

// ---------------------------------------------------------------- createMathLB
function createMathLB(L, o = {}) {
	const S = staticOf(L);
	const W = S.W, H = S.H, NL = S.NL;
	const st = { legs: 0, nodes: 0, capped: 0, nulls: 0, ms: 0 };
	const YBOT = 16 * H + 32, YTOP = -48;

	// THE REST AFTER A SOURCE, per target (cached): F(i) = the least ticks from any state centred in tile i to the target
	// by the speed cap alone (chebTicks) and the teleports (a portal group: 1 tick + the least F at its exits; a death:
	// DEATH_MIN + the least F at a respawn; with timed killers a death anywhere), the teleport exits' values by a fixpoint
	const restCache = new Map();
	function restOf(tiles, spQ) {
		const sp = spQ || S.sups;
		const key = tiles.join(',') + '|' + sp.x + ',' + sp.up + ',' + sp.down;
		let R = restCache.get(key);
		if (R) return R;
		const d0 = chebTransform(W, H, tiles);
		const tx = tiles.map((t) => t % W), ty = tiles.map((t) => (t / W) | 0);
		// the direct term: the sups per axis to the nearest target tile (few target tiles: each; many: the isotropic cap)
		const direct = tiles.length <= 16
			? (i) => { const x = i % W, y = (i - x) / W; let m = Infinity; for (let k = 0; k < tiles.length; k++) { const v = supTicks(tx[k] - x, ty[k] - y, sp); if (v < m) m = v; } return m; }
			: (i) => chebTicks(d0[i]);
		const T = S.tele, nT = T.length;
		const minExit = new Float64Array(nT).fill(Infinity);
		const nodes = new Map();
		for (const t of T) for (const x of t.exits) if (!nodes.has(x)) nodes.set(x, direct(x));
		let deathT = -1;
		for (let k = 0; k < nT; k++) if (T[k].death) deathT = k;
		for (let it = 0; it < nodes.size + 3; it++) {
			for (let k = 0; k < nT; k++) { let m = Infinity; for (const x of T[k].exits) { const g = nodes.get(x); if (g < m) m = g; } minExit[k] = m; }
			let changed = false;
			const timedV = S.timed && deathT >= 0 ? A.DEATH_MIN + minExit[deathT] : Infinity;
			for (const [x, g] of nodes) {
				let v = g;
				for (let k = 0; k < nT; k++) { const c = chebTicks(T[k].dist[x]) + T[k].cost + minExit[k]; if (c < v) v = c; }
				if (timedV < v) v = timedV;
				if (v < g) { nodes.set(x, v); changed = true; }
			}
			if (!changed) break;
		}
		const timedV = S.timed && deathT >= 0 ? A.DEATH_MIN + minExit[deathT] : Infinity;
		const deathRest = deathT >= 0 ? A.DEATH_MIN + minExit[deathT] : A.DEATH_MIN;
		const F = (i) => {
			let v = direct(i);
			for (let k = 0; k < nT; k++) { const c = chebTicks(T[k].dist[i]) + T[k].cost + minExit[k]; if (c < v) v = c; }
			if (timedV < v) v = timedV;
			return v;
		};
		R = { F, deathRest, hMemo: new Float32Array(W * H).fill(-1) };
		restCache.set(key, R);
		if (restCache.size > 8) restCache.delete(restCache.keys().next().value);
		return R;
	}

	function leg(sim, target, lo = {}) {
		const t0 = Date.now();
		st.legs++;
		const ctx = plainCtx(sim, S);
		if (!ctx) { st.nulls++; return { lb: null, why: 'not plain' }; }
		// 'land': grounded with the centre in a target tile (already so counts); 'landing': a NEW landing there (the ball
		// airborne before it: the moves' next support); 'touch': the centre in a target tile
		const landing = target.mode === 'landing';
		const land = target.mode === 'land' || landing;
		const tiles = Array.from(target.tiles || []);
		if (!tiles.length) return { lb: null, why: 'no target' };
		const field = lo.field || null;
		const cap = lo.cap || o.cap || 4000;
		const msCap = lo.ms || o.ms || 0;   // a time budget (ms): past it the A* frontier is the answer (a lower bound)
		const HOR = lo.horizon || o.horizon || 3000;
		const ice = S.ice || sim._slippery > 0;
		const freeNear = (row, kc) => {
			if (row < 0 || row >= H) return true;
			for (let c = Math.max(0, kc - 3); c <= Math.min(W - 1, kc + 3); c++) if (S.blk[row * W + c] !== 1) return true;
			return kc - 3 < 0 || kc + 3 >= W;
		};
		const qUp = (q) => q;
		const XS = xSteps(ctx, ice);
		const G = K.ga(ctx);
		const Js = [G.J];
		if (ice) { const jm = ctx.jm * 0.88; Js.push(((0 - 2) * 26 * jm) / C.MULT); }
		const yArm = G.a < 0.1 && G.a > -0.1;   // the y align can fire (low gravity)
		// the gravity axis: v' = (v + G) B, or on ice (the slippery timer: 11 ticks after the ice) (v + G) Ino: the band's
		// speeds are the least and the most of the two (the step is monotone in v for either drag)
		const stepY0 = (v) => K.axisStep(v, 0, G.mo, 0, 0, false);
		const stepYice = (v) => K.axisStep(v, 0, G.mo, 0, 0, true);
		const stepYlo = ice ? (v) => Math.min(stepY0(v), stepYice(v)) : stepY0;
		const stepYhi = ice ? (v) => Math.max(stepY0(v), stepYice(v)) : stepY0;
		const x0 = sim.px, vx0 = sim.speed_x, y0 = sim.py, vy0 = sim.speed_y;
		const vstar = A.terminal(ctx.sm / C.MULT, C.BASE_DRAG);
		const U = Math.max(Math.abs(vx0), vstar);
		// ---- THEOREM X: the global x envelope from the exact state (to the horizon)
		const XE = { max: [x0], min: [x0] };
		{
			let uu = vx0, ul = vx0, xmx = x0, xmn = x0;
			for (let t = 1; t <= HOR; t++) {
				uu = XS.up(uu); if (uu < 0) uu = 0;
				ul = XS.dn(ul); if (ul > 0) ul = 0;
				xmx = alignUp(xmx + uu); xmn = alignDn(xmn + ul);
				XE.max.push(xmx); XE.min.push(xmn);
				if (xmx > 16 * W + 64 && xmn < -64) break;
			}
		}
		const XH = XE.max.length - 1;
		/** the first t with [Xmin_t, Xmax_t] meeting [a, b) (a centre-column window: x in [a, b)); HOR + 1 = never within */
		function xreach(a, b) {
			if (x0 >= a && x0 < b) return 0;
			let lo_ = 1, hi = XH;
			const ok = x0 < a ? (t) => XE.max[t] >= a : (t) => XE.min[t] < b;
			if (!ok(hi)) return XH + 1;
			while (lo_ < hi) { const m = (lo_ + hi) >> 1; if (ok(m)) hi = m; else lo_ = m + 1; }
			return lo_;
		}
		const colReach = new Float64Array(W).fill(-1);
		const creach = (kc) => { if (kc < 0 || kc >= W) return Infinity; let r = colReach[kc]; if (r < 0) { r = xreach(16 * kc - 8, 16 * kc + 8); colReach[kc] = r; } return r; };
		// the node speed sequence from U (|vx| <= U at every node: U >= v* is invariant)
		const Useq = [U];
		for (let n = 1; n <= HOR; n++) { let u = XS.up(Useq[n - 1]); if (u < 0) u = 0; Useq.push(u); }
		// targets: per tile its x window, y window, reach time
		const tgt = tiles.map((t) => { const tx = t % W, ty = (t - tx) / W; return { t, tx, ty, xa: 16 * tx - 8, xb: 16 * tx + 8, ya: 16 * ty - 8, yb: 16 * ty + 8, xr: creach(tx) }; });
		const tgtMask = new Set(tiles);
		// the start in the target (touch: its centre tile; land: grounded there)
		{
			const cx = Math.trunc(x0 + 8) >> 4, cy = Math.trunc(y0 + 8) >> 4;
			if (!landing && tgtMask.has(cy * W + cx) && (!land || sim.on_ground)) return done(0, 'start');
		}
		let best = Infinity, why = 'target', srcHit = false;
		let arc = Infinity;   // the target time on the start's own flight (no event before it)
		const heap = new Heap();
		// node store
		const nk = [], nkc = [], nline = [], nhi = [], nt = [];
		const landT = new Map(), bonkT = new Map(), doneL = new Map(), doneB = new Map();
		// a node = a collision event at time t in centre column kc; (ya, yb) its EXACT y band: the target and the sources
		// are checked on it here, before the dedup (a node dropped for an earlier one of its key still had its own
		// position); the key's band (hiQ, quantized up for the retries) is the one its flights start from
		const pushNode = (kind, kc, li, hiQ, t, ya, yb, isLanding) => {
			if (t >= best) return;
			{
				const r0 = Math.floor((ya + 8) / 16), r1 = Math.floor((yb + 8) / 16);
				const hit = !land || (kind === 0 && (!landing || isLanding));
				if (hit) for (const g of tgt) if (g.tx === kc && g.ty >= r0 && g.ty <= r1) cand(Math.max(t, g.xr), 'target');
				if (srcCount(S, kc, kc, r0, r1) > 0) { const rr = srcRest(kc, kc, r0, r1); if (t + rr < best) { best = t + rr; why = 'source'; srcHit = true; } }
				if (t >= best) return;
			}
			const key = (kc * NL + li) * 512 + hiQ;
			const M = kind === 0 ? landT : bonkT;
			const had = M.get(key);
			if (had !== undefined && had <= t) return;
			M.set(key, t);
			nk.push(kind); nkc.push(kc); nline.push(li); nhi.push(hiQ); nt.push(t);
			if (DBG) { npar.push(curOrigin); nhow.push(curHow); }
			heap.push(t + hNode(kind, kc, li, hiQ), nk.length - 1);
		};
		const DBG = !!lo.debug;
		let curOrigin = -1, curHow = '', bestTrace = null;
		const npar = [], nhow = [];
		const cand = (t, w) => { if (t < best) { best = t; why = w; if (DBG) bestTrace = { from: curOrigin, how: curHow, t }; } };
		// the rest after a source cell: a kill cell (an unprotected ball dies at the next tick's start: 54+ dead ticks,
		// no goal while dead) at least DEATH_MIN, the field's value there when a field is given; a physics cell the field's
		// value (or 0)
		const inv = !!sim.is_invulnerable;
		const sp0 = S.sups;
		const RS = restOf(tiles, Math.abs(vx0) > sp0.x || -vy0 > sp0.up || vy0 > sp0.down
			? { x: Math.max(sp0.x, Math.abs(vx0)), up: Math.max(sp0.up, -vy0), down: Math.max(sp0.down, vy0) } : sp0);
		// A*'s h: from any state centred in a tile the rest field F (the speed cap + the teleports) and the given field
		// bound every continuation, plain or through a source: admissible for the graph's paths (the frontier's least
		// t + h is then a lower bound of every unexplored path)
		const hTile = (i) => { let h = RS.hMemo[i]; if (h < 0) { h = RS.F(i); RS.hMemo[i] = h; } if (field && field[i] > h && field[i] !== Infinity) h = field[i]; return h; };
		const hNode = (kind, kc, li, q) => {
			const line = (li - LINE0) * 8;
			let ya, yb;
			if (kind === 0) { ya = line - 1; yb = line + q; } else { ya = line - ((q / 17) | 0); yb = line + (q % 17); }
			let r0 = Math.floor((ya + 8) / 16), r1 = Math.floor((yb + 8) / 16);
			if (r0 < 0) r0 = 0; if (r1 > H - 1) r1 = H - 1;
			if (kc < 0 || kc >= W || r0 > r1) return 0;
			let h = Infinity;
			for (let r = r0; r <= r1; r++) { const v = hTile(r * W + kc); if (v < h) h = v; }
			return h === Infinity ? 0 : h;
		};
		const srcRest = (kx0, kx1, ry0, ry1) => {
			let m = Infinity;
			for (let yy = Math.max(0, ry0); yy <= Math.min(H - 1, ry1); yy++) for (let xx = Math.max(0, kx0); xx <= Math.min(W - 1, kx1); xx++) {
				const i = yy * W + xx;
				const k = S.kill[i] && !inv;
				if (!S.phys[i] && !k) continue;
				let r = k ? RS.deathRest : RS.F(i);
				if (field && field[i] > r) r = field[i];
				if (r < m) m = r;
			}
			return m;
		};
		/**
		 * one flight from time tA: y band [ylo, yhi] (exact when equal) with speed v, the x window per tick: the global
		 * envelope (xw null: the start) or the node window [xa, xb) grown by the node speed sequence
		 */
		function flight(tA, ylo, yhi, v, xa, xb, isStart, air) {
			let pl = ylo, ph = yhi, vl = v, vh = v;
			let ea = xa, eb = xb;   // the window's absolute edges (left: min, right: max)
			const exact = ylo === yhi && !ice;
			for (let n = 1; ; n++) {
				const tn = tA + n;
				if (tn >= best || n > HOR) return;
				vl = stepYlo(vl); vh = stepYhi(vh);
				let nl = pl + vl, nh = ph + vh;
				if (yArm) { nl = alignDn(nl); nh = alignUp(nh); }
				let wa, wb;
				if (isStart) { const q = Math.min(tn, XH); wa = XE.min[q]; wb = XE.max[q]; }
				else { const u = Useq[Math.min(n, Useq.length - 1)]; ea = alignDn(ea - u); eb = alignUp(eb + u); wa = ea; wb = eb; }
				// the centre columns of the window (x in [wa, wb]) and the centre rows of the tick-end band
				const k0 = Math.floor((wa + 8) / 16), k1 = Math.floor((wb + 8) / 16);
				const r0 = Math.floor((nl + 8) / 16), r1 = Math.floor((nh + 8) / 16);
				// the target (touch: a tick-end position; land: a landing event below)
				if (!land) for (const g of tgt) {
					if (nh >= g.ya && nl < g.yb && wb >= g.xa && wa < g.xb) { const tt = Math.max(tn, g.xr); cand(tt, isStart ? 'arc' : 'target'); if (isStart && tt < arc) arc = tt; }
				}
				// sources
				if (srcCount(S, k0, k1, r0, r1) > 0) { const rr = srcRest(k0, k1, r0, r1); if (tn + rr < best) { best = tn + rr; why = 'source'; srcHit = true; } }
				// events. A blocked step zeroes the axis' speed; the engine RETRIES the blocked axis' step in the loop's later
				// iterations while the other axis moves (eesim.js: `csy = osy`), so a landing / bonk leaves the ball anywhere
				// from the line to its free position of the tick, with speed 0 (grounded for a landing)
				if (vh > 0) {
					// landings: standing lines s with pl <= s < nh (the band was at or above s, would pass it)
					const la = S.lineIdx(Math.ceil(pl)), lb_ = S.lineIdx(Math.floor(nh));
					for (let li = Math.max(0, la - 1); li <= Math.min(NL - 1, lb_ + 1); li++) {
						const s = (li - LINE0) * 8;
						if (!(pl <= s && s < nh)) continue;
						const cols = S.stand[li];
						if (!cols.length) continue;
						let hiX = Math.ceil(nh - s); if (hiX < 0) hiX = 0; if (hiX > 16) hiX = 16;
						const frow = Math.floor((s + 17) / 16);   // the row past the standing line (the floor's)
						let i = lowerBound(cols, k0);
						for (; i < cols.length && cols[i] <= k1; i++) {
							const kc = cols[i];
							const hx = hiX && freeNear(frow, kc) ? hiX : 0;
							const tt = Math.max(tn, creach(kc));
							if (isStart && land && tt < arc && (!landing || air || n >= 2 || v !== 0)) for (const g of tgt) if (g.tx === kc && rowsHit(s - 1, s + hx, g.ty)) arc = tt;
							pushNode(0, kc, li, qUp(hx), tt, s - 1, s + hx, air || n >= 2 || v !== 0);
						}
					}
				}
				if (vl < 0) {
					// bonks: ceiling lines c with nl < c <= ph (the band was at or below c, would pass above it)
					const la = S.lineIdx(Math.floor(nl)), lb_ = S.lineIdx(Math.ceil(ph));
					for (let li = Math.max(0, la - 1); li <= Math.min(NL - 1, lb_ + 1); li++) {
						const c = (li - LINE0) * 8;
						if (!(nl < c && c <= ph)) continue;
						const cols = S.ceil[li];
						if (!cols.length) continue;
						// the bonk's y: [c, c + 1) from a fractional pre-position, the pre-position itself from an integer one,
						// the free position (above c) by the retry
						let hi = c + 1;
						if (exact) { if (Number.isInteger(ph)) hi = ph; else if (Math.floor(ph) < c) hi = ph; else hi = c; }
						else { const m = Math.floor(ph); if (m >= pl && m > hi) hi = m; }
						let hiQ = Math.ceil(hi - c); if (hiQ < 1) hiQ = 1; if (hiQ > 16) hiQ = 16;
						let loX = Math.ceil(c - nl); if (loX < 0) loX = 0; if (loX > 16) loX = 16;
						const crow = Math.floor((c - 1) / 16);   // the row past the ceiling line (the ceiling's)
						let i = lowerBound(cols, k0);
						for (; i < cols.length && cols[i] <= k1; i++) { const kc = cols[i]; const lx = loX && freeNear(crow, kc) ? loX : 0; pushNode(1, kc, li, qUp(lx) * 17 + hiQ, Math.max(tn, creach(kc)), c - lx, c + hiQ); }
					}
				}
				pl = nl; ph = nh;
				if (pl > YBOT) return;
			}
		}
		function rowsHit(yl, yh, ty) { const a = Math.floor((yl + 8) / 16), b = Math.floor((yh + 8) / 16); return ty >= a && ty <= b; }
		// ---- THE EVENT GRAPH
		{	// the start's own centre cell is the next tick's `current`
			const cx = Math.trunc(x0 + 8) >> 4, cy = Math.trunc(y0 + 8) >> 4;
			if (cx >= 0 && cy >= 0 && cx < W && cy < H) { const rr = srcRest(cx, cx, cy, cy); if (rr < best) { best = rr; why = 'source'; srcHit = true; } }
		}
		curOrigin = -1; curHow = 'start';
		flight(0, y0, y0, vy0, x0, x0, true, !sim.on_ground);
		let expanded = 0, capped = false, frontier = Infinity;
		while (heap.n > 0) {
			const f = heap.k[0];
			if (f >= best) break;
			if (f >= HOR) { frontier = f; break; }
			if (expanded >= cap || (msCap && (expanded & 31) === 0 && Date.now() - t0 > msCap)) { capped = true; frontier = f; break; }
			const id = heap.pop();
			const kind = nk[id], kc = nkc[id], li = nline[id], hiQ = nhi[id], t = nt[id];
			const key = (kc * NL + li) * 512 + hiQ;
			if ((kind === 0 ? landT : bonkT).get(key) !== t) continue;
			// dominance: a node of the same place expanded no later with a band that holds this one's gives every
			// continuation this one gives, no later
			{
				const pk = kc * NL + li, lst = (kind === 0 ? doneL : doneB).get(pk);
				const lq = kind === 0 ? 0 : (hiQ / 17) | 0, hq = kind === 0 ? hiQ : hiQ % 17;
				let dom = false;
				if (lst) for (let q = 0; q < lst.length; q += 3) if (lst[q] >= lq && lst[q + 1] >= hq && lst[q + 2] <= t) { dom = true; break; }
				if (dom) continue;
				if (lst) lst.push(lq, hq, t); else (kind === 0 ? doneL : doneB).set(pk, [lq, hq, t]);
			}
			expanded++;
			const line = (li - LINE0) * 8;
			const xa = 16 * kc - 8, xb = 16 * kc + 8;
			if (kind === 0) {
				const s = line, sh = s + hiQ;   // the ball: y in [s - 1, s + hiQ] (hiQ: the retry past the line)
				const r0 = Math.floor((s - 1 + 8) / 16), r1 = Math.floor((sh + 8) / 16);
				// the target (touch: the node's position; land: grounded here)
				curOrigin = id; curHow = 'walk';
				// walking: the next centre column on the same line, >= 1 tick
				if (hiQ === 0) for (const d of [-1, 1]) {
					const k2 = kc + d;
					if (k2 < 0 || k2 >= W) continue;
					const cols = S.stand[li];
					const j = lowerBound(cols, k2);
					if (j < cols.length && cols[j] === k2) pushNode(0, k2, li, 0, Math.max(t + 1, creach(k2)), s - 1, s, false);
				}
				// the jump (at this very tick: the hop) and the walk-off fall
				curOrigin = id; curHow = 'walk';
				for (const J of Js) { curHow = 'jump'; flight(t, s - 1, sh, J, xa, xb, false, true); }
				curHow = 'walkoff';
				flight(t, s - 1, sh, 0, xa, xb, false, hiQ > 0);
			} else {
				const c = line, loQ = (hiQ / 17) | 0, hQ = hiQ % 17;   // the ball: y in [c - loQ, c + hQ]
				const r0 = Math.floor((c - loQ + 8) / 16), r1 = Math.floor((c + hQ + 8) / 16);
				curOrigin = id; curHow = 'bonkfall';
				flight(t, c - loQ, c + hQ, 0, xa, xb, false, true);
			}
		}
		st.nodes += expanded;
		if (capped) st.capped++;
		let lb = best;
		if (frontier < lb) { lb = frontier; why = 'frontier'; }
		if (lb === Infinity) {
			// the relaxed graph exhausted without the target: in the model the target is out of reach. The model is a
			// relaxation, so that is a proof in the model's physics; a gap in the model (a blocking shape it does not know)
			// must not turn it into a huge bound, so the answer falls back to the teleport-aware speed-cap bound
			const cx = Math.trunc(x0 + 8) >> 4, cy = Math.trunc(y0 + 8) >> 4;
			lb = cx >= 0 && cy >= 0 && cx < W && cy < H ? RS.F(cy * W + cx) : 0;
			why = 'exhausted';
		}
		if (lb > HOR) { lb = HOR; why = 'horizon'; }
		let chain = null;
		if (DBG && bestTrace) {
			chain = [{ how: bestTrace.how, t: bestTrace.t }];
			let q = bestTrace.from;
			while (q >= 0) { chain.push({ node: nk[q] ? 'BONK' : 'LAND', kc: nkc[q], line: (nline[q] - LINE0) * 8, hiQ: nhi[q], t: nt[q], how: nhow[q] }); q = npar[q]; }
		}
		return done(lb, why, { nodes: expanded, capped, src: srcHit, arc: arc === Infinity ? null : arc, tx: Math.min(...tgt.map((g) => g.xr)), chain });
		function done(lbv, w, extra) { st.ms += Date.now() - t0; return Object.assign({ lb: lbv, why: w }, extra || {}); }
	}
	return { leg, static: S, stats: () => Object.assign({}, st) };
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/** a leg found in `ticks` from the state the bound was computed at: 'optimal' when ticks === lb (the bound is a proof) */
function proof(lb, ticks) { return lb !== null && lb !== undefined && ticks === lb ? 'optimal' : 'gap'; }

module.exports = { createMathLB, staticOf, plainCtx, proof, xSteps, alignUp, alignDn };
