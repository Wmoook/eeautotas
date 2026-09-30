'use strict';
// src/plan/oneshot/solve.js - THE ONE SHOT, part 3: SOLVE (n5-oneshot, 2026-09-30; brief.md ADDENDUM 09:50).
//
// ONE optimal path computation over (THE MOVE GRAPH x THE TRIGGER STATE): A* whose nodes are REAL engine states (each the
// end of a verified edge from its parent: the whole path is masks the engine replayed, from the level start) and whose
// key is (the model's abstract state S (model.js stateOf: coins / blue coins / keys + their timers / switches / team /
// crowns / effects / death counts / the checkpoint: every feature a door reads), the support class of the ball: its
// centre tile, ground contact, speed class (vx 1/2 px/tick, vy 2 px/tick) and, within a class, up to CLASS_K distinct
// exact states (the sub-pixel / exact-speed variants: never rounded, ADDENDUM 09:45)).
//
//   EDGES of a node (the move graph; each one replayed from the node's snapshot, so every edge is exact):
//     'leg'   the move solver's direct leg (msolve.js leg: plain closed forms, the field tier, the coupled piece) to the
//             first waypoint of each of the planner's plans from S, when the reach field puts it within LEG_TILES
//     'land'  the forward fan-out (msolve.js landings: the earliest verified landing, and its hop, on the standable
//             tiles the plain extremes reach within FAN_T ticks), toward the plan's waypoint and around the ball
//     'fan'   the 18 held masks (9 directions, with / without a press on the first tick) to their first support event:
//             a landing, a field class change, a teleport, a trigger tile touched; a death played on to the respawn
//             (a death is an edge: the 54 dead ticks its cost, the respawn and the death count its end state)
//     'graph' edges of the precomputed whole-level move graph (parts 1-2 of the one shot: o.graph.edgesOf), when given
//     'inj'   states handed in from outside (inject(): the executor's exact fallback legs, a known state): a missing
//             edge found by the exact fallback goes INTO the graph (its end a node like any other)
//   THE ORDER f = g + w x ord, ord = the least over the planner's plans from S of (KAPPA x the RCH3 reach field's tiles
//     from the ball to the plan's first waypoint on the level as S holds its doors (types.js goalField: its -1 a proof
//     that no way exists while S holds: FAR_TILES) + the plan's est ticks after that waypoint); the planner's
//     landmarks and the order of triggers live in its plans, re-planned per abstract state (memo by S.key), so the
//     trigger ORDER falls out of the same A*: nodes of every S compete on one heap.
//   THE CLAIM fa = g + adm, adm = the admissible bound on the ticks to the trophy (bounds.js leg, relaxed: every door
//     open, deaths through the respawns): after the first route, nodes with fa >= the best are pruned; an open list with
//     no fa below the best = the route is OPTIMAL WITHIN THE GRAPH (closed).
//   TWO PHASES (anytime, msolve.js chain's rule): w = W1 (greedy) until the first route, then w = 1 (A*; the heap
//     re-keyed), pruned by fa.
//
// API
//   const OS = createOneShot(L, {model, planner, bounds, solver (msolve createSolver(L)), graph, emit})
//   OS.run(ms, o) -> {ok, done, best: {masks, ticks} | null, closed, stats}: resumable (the open list persists)
//   OS.inject(masks, why) -> bool: a real state (masks from the level start) as a node (its g = its ticks)
//   OS.arrivals() -> [{masks, tick, S, key, g}]: per abstract state reached, its earliest node (the strategy's anchors)
//   OS.best() -> {masks, ticks} | null
//   OS.stats() -> counters
// Rules: exact to the engine (every edge replayed; the route is the concatenation of replayed edges, verified again by
// the caller with common.js evaluate); general code only; no search tool (no goexplore / beam / GPU): the edges are the
// mathematics' moves and the engine's own events.
const E = require('../../eesim.js');
const T = require('../types.js');
const RF = require('../../reach.js');

const DIR9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const TELEPORT_PX = 20;
const KAPPA = 16 / 6.776552880470027;              // ticks per tile at the top running speed (msolve.js chain's)
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(+process.env[k]) ? +process.env[k] : d);
const W1 = env('EEAT_OS_W1', 3);                   // the greedy phase's weight
const WEND = env('EEAT_OS_W', 1);                  // the A* phase's weight
const CLASS_K = env('EEAT_OS_CLASS_K', 1);         // exact states kept per support class
const CELL_Q = env('EEAT_OS_Q', 8);                // a class's position cell (px) away from the exact tiles
const CELL_QX = env('EEAT_OS_QX', 4);              // ... and on the exact tiles
const FAN_T = env('EEAT_OS_FAN_T', 60);            // the fan-outs' horizon (ticks)
const FAN_MAX = env('EEAT_OS_FAN_MAX', 24);        // landings' tiles per node
const LEG_T = env('EEAT_OS_LEG_T', 150);           // a direct leg's horizon
const LEG_TILES = env('EEAT_OS_LEG_TILES', 16);    // a direct leg only where the reach field puts the waypoint this near
const LEG_MS = env('EEAT_OS_LEG_MS', 30);          // a direct leg's clock
const SEG_T = env('EEAT_OS_SEG', 10);              // an airborne fan edge ends after this many ticks (a mid-air node: the next change)
const LEG_FAIL = env('EEAT_OS_LEG_FAIL', 8);       // a waypoint's failed legs before its reach for them halves
const LAND_AIR = process.env.EEAT_OS_LAND_AIR === '1';
const LAND_PER = env('EEAT_OS_LAND_PER', 2);
const LEG_NOGAIN = env('EEAT_OS_LEG_NOGAIN', 12);   // a step's legs that changed nothing before it gets no more legs        // landings fan-outs per (abstract state, support tile, speed class)   // the landings fan-out from airborne nodes too
const CLASS_MODE = String(process.env.EEAT_OS_CLASS || 'fine');   // the support class: 'fine' | 'coarse'
const FAR_TILES = env('EEAT_OS_FAR', 800);         // the order's tiles where the reach field says 'no way while S holds'
const PLAN_K = env('EEAT_OS_PLAN_K', 2);           // the planner's plans per abstract state (their first waypoints)
const PLAN_MS = env('EEAT_OS_PLAN_MS', 150);       // a plan call's time
const PLAN_SHARE = env('EEAT_OS_PLAN_SHARE', 0.3); // the plans' share of the run's time at most
const NODES_MAX = env('EEAT_OS_NODES', 600000);    // the open list's cap (the worst half dropped past it)
const DEATH_WAIT = 140;                             // a death edge's ticks at most after the death (the respawn: 54-55)

const NEAR_R = env('EEAT_OS_NEAR_R', 2);           // the exact tiles' reach from a hot tile
const CLASS_K_EXACT = env('EEAT_OS_CLASS_KX', 1);  // exact states kept per support class on the exact tiles
// THE REFINEMENT LADDER: an open list that runs out with no route = the class abstraction dropped a state the way needs
// (a counterexample to it): the A* starts again from the root (and the injected states) with finer classes (EEAT_OS_LADDER=0:
// no ladder, the run ends 'done')
const LADDER = process.env.EEAT_OS_LADDER === '0' ? [[CELL_Q, CELL_QX, CLASS_K, CLASS_K_EXACT]]
	: [[CELL_Q, CELL_QX, CLASS_K, CLASS_K_EXACT], [4, 2, 2, 2], [2, 1, 4, 4], [1, 1, 8, 16]];
const SEG_NEAR = env('EEAT_OS_SEG_NEAR', 4);       // the fan's segments on the exact tiles
const SEG_G = env('EEAT_OS_SEG_G', 16);            // a grounded run's segment (a mid-run node: the jump from there)
const DOTS = new Set([4, 414]), PORTALS = new Set([242, 381]);
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const F_SOLID = 1, F_LIQUID = 64, F_CLIMB = 32, F_BOOST = 128;
/** the plain ids (msolve.js plainIds' rule: default gravity, no field / effect / portal / killer) */
function plainIdsOf(L) {
	const KN = require('../kin.js');
	const n = L.flags.length, out = new Uint8Array(n);
	KN.flagsOf(n - 1);
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

/** a heap on f (then the deeper g, then the older) */
class Heap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	static lt(x, y) { return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.id < y.id))); }
	push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
	pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; this.down(0); } return top; }
	down(i) { const a = this.a; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && Heap.lt(a[l], a[m])) m = l; if (r < a.length && Heap.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
	heapify() { for (let i = (this.a.length >> 1) - 1; i >= 0; i--) this.down(i); }
}

function createOneShot(L, o = {}) {
	const W = L.width, H = L.height, N = W * H;
	const model = o.model;
	if (!model || typeof model.stateOf !== 'function') throw new Error('oneshot: a model (model.js compileModel) is required');
	const planner = o.planner && typeof o.planner.plan === 'function' ? o.planner : null;
	const bounds = o.bounds && typeof o.bounds.leg === 'function' ? o.bounds : null;
	const graph = o.graph && typeof o.graph.edgesOf === 'function' ? o.graph : null;
	const say = typeof o.emit === 'function' ? o.emit : () => {};
	const MS = o.solver || require('../msolve.js').createSolver(L, {});
	const clsOf = require('../msolve.js').clsOf;
	const flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const trophyTiles = Array.from(model.trophyTiles || []);
	const trophyGoal = T.goalOf(L, { kind: 'trophy', label: 'trophy' });
	const deathsOK = !!model.canDie && process.env.EEAT_OS_DEATHS !== '0';
	const deathsField = !!model.canDie;
	// (the trigger tiles: a fan edge ends where it touches one (a new abstract state, probably))
	const trigTile = new Uint8Array(N);
	for (const X of model.triggers) if (X.relevant || X.kind === 'trophy') for (const t of X.tiles) if (t >= 0 && t < N) trigTile[t] = 1;
	// THE EXACT TILES (ADDENDUM 09:45): within NEAR_R tiles of a tile of another physics class than plain air / plain
	// solids (a field, an arrow, a dot, a killer, a portal, an effect, a trigger): there the sub-pixel state decides the
	// ticks in a field and the squeeze past a killer, so a support class keeps CLASS_K_EXACT exact states (not CLASS_K)
	// and the fan's segments are SEG_NEAR ticks (not SEG_T)
	const exactTile = new Uint8Array(N);
	{
		const plain = plainIdsOf(L);
		const hot = new Uint8Array(N);
		for (let i = 0; i < N; i++) { const id = L.fg[i]; if ((id > 0 && !(id < plain.length && plain[id] === 1)) || trigTile[i]) hot[i] = 1; }
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!hot[y * W + x]) continue;
			for (let v = Math.max(0, y - NEAR_R); v <= Math.min(H - 1, y + NEAR_R); v++) for (let u = Math.max(0, x - NEAR_R); u <= Math.min(W - 1, x + NEAR_R); u++) exactTile[v * W + u] = 1;
		}
	}
	const ST = { expanded: 0, pushed: 0, nodes: 0, dupHash: 0, dupClass: 0, dead: 0, deathEdges: 0, legs: 0, legOk: 0, lands: 0, fans: 0, graphEdges: 0, injected: 0, plans: 0, planMs: 0, planFail: 0,
		states: 0, routes: 0, pruned: 0, dropped: 0, expandMs: 0, hMs: 0, legMs: 0, landMs: 0, fanMs: 0, firstMs: 0, runs: 0, ms: 0, byKind: {} };
	const nodes = [];                 // id -> node
	const heap = new Heap();
	const seen = new Map();           // stateHash -> least g
	const classes = new Map();        // class key -> [g ...] (the CLASS_K least)
	let level = 0, lvQ = LADDER[0][0], lvQX = LADDER[0][1], lvK = LADDER[0][2], lvKX = LADDER[0][3];
	const injList = [];              // the injected states (masks), again at every ladder step
	const infos = new Map();          // S.key -> {wps: [{tiles, field, rest, label}], adm}
	const firstOfS = new Map();
	const landSeen = new Map();       // (S, support tile, speed class) -> the landings fan-outs made there       // S.key -> node id (the earliest)
	let best = null;                  // {T, id, masks}
	let w = W1, phase = W1 === WEND ? 2 : 1;
	let closed = false, uncert = false;
	let tRun0 = 0, planSpent = 0, runMs = 0;

	// ---------------------------------------------------------------- nodes
	function masksOf(id) {
		const parts = [];
		let len = 0;
		for (let k = id; k >= 0; k = nodes[k].par) { const e = nodes[k].edge; if (e && e.length) { parts.push(e); len += e.length; } }
		const out = new Uint8Array(len);
		let at = 0;
		for (let i = parts.length - 1; i >= 0; i--) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}
	const clsKey = CLASS_MODE === 'coarse'
		? (S, s) => `${S.key}|${T.tileOf(s, W, H)}|${s.on_ground ? 1 : 0}|${Math.round(s.speed_x)}|${Math.round(s.speed_y / 4)}`
		: CLASS_MODE === 'tile'
			? (S, s) => `${S.key}|${T.tileOf(s, W, H)}|${s.on_ground ? 1 : 0}|${Math.round(s.speed_x * 2)}|${Math.round(s.speed_y / 2)}|${s.jump_count}`
			// (the default: a position cell of CELL_Q px (CELL_QX on the exact tiles: the sub-pixel matters there), the speed in
			// 1/2 px/tick, ground, the jumps: a class holds CLASS_K states, the earliest)
			: (S, s) => { const q = exactTile[T.tileOf(s, W, H)] ? lvQX : lvQ; return `${S.key}|${Math.floor(s.px / q)},${Math.floor(s.py / q)},${q}|${s.on_ground ? 1 : 0}|${Math.round(s.speed_x * 2)}|${Math.round(s.speed_y * 2)}|${s.jump_count}`; };
	/** the planner's plans from state S (the node's real state in sim): their first waypoints and the est after them */
	function infoOf(S, id) {
		let inf = infos.get(S.key);
		if (inf) return inf;
		inf = { plans: [], adm: 0, Lc: null };
		const t0 = Date.now();
		let plans = [];
		if (planner && planSpent < PLAN_SHARE * Math.max(1000, runMs + (Date.now() - tRun0))) {
			try {
				const m = masksOf(id);
				const arr = T.arrivalOf(L, sim, m, null);
				const r = planner.plan({ arrival: arr, arrivals: [arr], S, key: String(S.key), tick: m.length }, { k: PLAN_K, ms: PLAN_MS });
				plans = Array.isArray(r) ? r : r && Array.isArray(r.plans) ? r.plans : [];
				ST.plans++;
			} catch (e) { ST.planFail++; plans = []; }
			planSpent += Date.now() - t0;
			ST.planMs += Date.now() - t0;
		}
		// (each plan as its steps: the tiles, the est after the step, the field made on first use; a node pursues one step of
		// each plan (its si) and moves on to the next step on reaching the step's tiles in the same abstract state: a region
		// step (past a door, a respawn) or a trigger the model's state does not tell apart)
		inf.Lc = model.levelOf(S);
		const seenT = new Set();
		for (const p of plans) {
			if (!p || !Array.isArray(p.steps) || !p.steps.length) continue;
			const st0 = p.steps[0], wp0 = st0.waypoint || { kind: 'trophy' };
			const tiles0 = wp0.kind === 'trophy' ? trophyTiles : Array.from(wp0.tiles || []);
			if (!tiles0.length) continue;
			const k = tiles0.slice(0, 8).join(',') + ':' + tiles0.length;
			if (seenT.has(k)) continue;
			seenT.add(k);
			let left = Number.isFinite(+p.cost) ? +p.cost : 0;
			const steps = [];
			for (const st of p.steps) {
				const wp = st.waypoint || { kind: 'trophy' };
				const tiles = wp.kind === 'trophy' ? trophyTiles : Array.from(wp.tiles || []);
				if (!tiles.length) break;
				left -= Number.isFinite(+st.estTicks) ? +st.estTicks : 0;
				steps.push({ tiles, set: new Set(tiles), field: undefined, rest: Math.min(Math.max(0, left), 1e6), label: wp.label || wp.kind, kind: wp.kind, allowDeath: !!wp.allowDeath });
				if (wp.kind === 'trophy') break;
			}
			if (steps.length) inf.plans.push({ steps });
		}
		if (!inf.plans.length) inf.plans.push({ steps: [{ tiles: trophyTiles, set: new Set(trophyTiles), field: undefined, rest: 0, label: 'trophy', kind: 'trophy', allowDeath: false }] });
		infos.set(S.key, inf);
		ST.states = infos.size;
		return inf;
	}
	/** a step's goal field (the RCH3 field on the level as the abstract state holds its doors), made on first use */
	function fieldOf(inf, step) {
		if (step.field === undefined) {
			try { step.field = T.goalField(inf.Lc, step.tiles, { deaths: deathsField && step.allowDeath }); } catch (e) { step.field = null; }
		}
		return step.field;
	}
	/** the steps a node pursues: its parent's (same abstract state) or the first ones, moved on past the steps whose tiles
	 *  the ball's centre is in */
	function stepsOf(inf, par, S) {
		const P = inf.plans.length;
		const si = new Uint8Array(P);
		const pn = par >= 0 ? nodes[par] : null;
		if (pn && pn.S && pn.S.key === S.key && pn.si && pn.si.length === P) si.set(pn.si);
		const t = T.tileOf(sim, W, H), tt = T.touchedTile(sim, W, H);
		for (let p = 0; p < P; p++) {
			const steps = inf.plans[p].steps;
			while (si[p] + 1 < steps.length && steps[si[p]].kind !== 'trophy' && (steps[si[p]].set.has(t) || (tt >= 0 && steps[si[p]].set.has(tt)))) si[p]++;
		}
		return si;
	}
	/** h of the live sim in state S: {ord, adm, near (the least field tiles), wi (the plan of the least ord), si} */
	function hOf(S, id, par) {
		const t0 = Date.now();
		const inf = infoOf(S, id);
		const si = stepsOf(inf, par, S);
		let ord = Infinity, near = Infinity, wi = 0;
		for (let i = 0; i < inf.plans.length; i++) {
			const step = inf.plans[i].steps[si[i]];
			const f = fieldOf(inf, step);
			let c = f ? RF.costAt(f, sim) : -1;
			if (c < 0) c = FAR_TILES;
			const v = KAPPA * c + step.rest;
			if (v < ord) { ord = v; wi = i; }
			if (c < near) near = c;
		}
		let adm = 0;
		if (bounds) { try { const b = bounds.leg(sim, trophyGoal, { relaxed: true }); adm = Number.isFinite(b) ? Math.max(0, b) : 1e9; } catch (e) { adm = 0; uncert = true; } }
		else uncert = true;
		ST.hMs += Date.now() - t0;
		return { ord, adm, near, wi, si };
	}
	/** a new node from the live sim (after `edge` from node par): dedup, h, push; returns the node or null */
	function addNode(par, edge, g, kind) {
		const hash = sim.stateHash();
		const had = seen.get(hash);
		if (had !== undefined && had <= g) { ST.dupHash++; return null; }
		let S;
		try { S = model.stateOf(sim); } catch (e) { return null; }
		const ck = clsKey(S, sim);
		const K = exactTile[T.tileOf(sim, W, H)] ? lvKX : lvK;
		let gs = classes.get(ck);
		if (gs && gs.length >= K && gs[gs.length - 1] <= g) { ST.dupClass++; return null; }
		seen.set(hash, g);
		const id = nodes.length;
		const n = { id, par, edge, g, snap: sim.snapshot(), S, hash, ck, K, kind, h: 0, f: 0, fa: 0, wi: 0, closed: false, near: Infinity };
		nodes.push(n);
		const h = hOf(S, id, par);
		n.h = h.ord; n.fa = g + h.adm; n.wi = h.wi; n.si = h.si; n.near = h.near; n.f = g + w * h.ord;
		if (best && n.fa >= best.T) { ST.pruned++; n.snap = null; return null; }
		if (!gs) { gs = []; classes.set(ck, gs); }
		gs.push(g); gs.sort((a, b) => a - b); if (gs.length > K) gs.length = K;
		if (!firstOfS.has(S.key) || nodes[firstOfS.get(S.key)].g > g) firstOfS.set(S.key, id);
		heap.push(n);
		ST.pushed++; ST.nodes = nodes.length;
		ST.byKind[kind] = (ST.byKind[kind] || 0) + 1;
		if (heap.size > NODES_MAX) trim();
		return n;
	}
	/** the open list past its cap: the worse half (by f) dropped */
	function trim() {
		const a = heap.a.slice().sort((x, y) => x.f - y.f || y.g - x.g);
		const keep = a.slice(0, NODES_MAX >> 1);
		for (let i = keep.length; i < a.length; i++) { a[i].snap = null; ST.dropped++; }
		heap.a = keep; heap.heapify();
		uncert = true;
	}
	/** a route: the node reached the trophy after `edge` at its tick g */
	function routeAt(par, edge, g, kind) {
		if (best && g >= best.T) return;
		const id = nodes.length;
		nodes.push({ id, par, edge, g, snap: null, S: null, hash: 0, ck: '', kind, h: 0, f: g, fa: g, closed: true });
		best = { T: g, id, masks: masksOf(id), kind, at: Date.now() - tRun0 + runMs };
		ST.routes++;
		if (!ST.firstMs) ST.firstMs = best.at;
		say({ ev: 'oneshot', what: 'route', ticks: g, expanded: ST.expanded, nodes: nodes.length, states: infos.size, ms: best.at });
		if (phase === 1) rekey();
	}
	function rekey() {
		w = WEND; phase = 2;
		for (const x of heap.a) x.f = x.g + w * x.h;
		heap.a = heap.a.filter((x) => !(best && x.fa >= best.T));
		heap.heapify();
	}

	// ---------------------------------------------------------------- edges
	/** play masks from node n's snapshot; the goal / trophy / a death (played on to the respawn when deaths are edges) end it.
	 *  -> {end: 'ok' | 'goal' | 'dead', t (ticks played)}; the sim holds the end state */
	function play(n, ms, goal) {
		sim.restore(n.snap);
		for (let t = 0; t < ms.length; t++) {
			E.applyMask(inp, ms[t] & 31);
			sim.tick(inp);
			if (sim.has_silver_crown || (goal && goal.test(sim))) return { end: 'goal', t: t + 1 };
			if (sim.is_dead) {
				if (!deathsOK) return { end: 'dead', t: t + 1 };
				// (a death: no input until the respawn has the ball alive again)
				let k = t + 1;
				E.applyMask(inp, 0);
				for (let q = 0; q < DEATH_WAIT && sim.is_dead; q++) { sim.tick(inp); k++; }
				if (sim.is_dead) return { end: 'dead', t: k };
				return { end: 'respawn', t: k };
			}
		}
		return { end: 'ok', t: ms.length };
	}
	/** the 18 held masks to their first support event (msolve.js eventFan's rule + a trigger touched + deaths) */
	/**
	 * the 18 held masks to their first support event (msolve.js eventFan's rule + a trigger touched + deaths), cut into
	 * SEGMENTS where no event comes (airborne SEG_T ticks, grounded SEG_G, on the exact tiles SEG_NEAR: a node where the
	 * next edge changes the input); a mask that DIES also gives its prefixes 1, 2 and 4 ticks before the death (the states
	 * from which another input may still pass: the squeeze past a killer, decided by the sub-pixel); a landing edge also
	 * as its HOP (the jump bit on the landing tick)
	 */
	function fanOf(n, maxT, goal) {
		const out = [];
		for (const p0 of [0, 1]) for (const m0 of DIR9) {
			sim.restore(n.snap);
			const c0 = clsOf(sim, flags);
			let air = !sim.on_ground || sim.speed_y !== 0;
			const ms = [];
			for (let t = 0; t < maxT; t++) {
				const px = sim.px, py = sim.py;
				const mk = t === 0 ? (m0 | p0) : m0;
				E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
				if (sim.has_silver_crown || (goal && goal.test(sim))) { out.push(Uint8Array.from(ms)); break; }
				if (sim.is_dead) {
					if (deathsOK) out.push(Uint8Array.from(ms));
					for (const b of [1, 2, 4]) if (ms.length - b >= 1) out.push(Uint8Array.from(ms.slice(0, ms.length - b)));
					break;
				}
				const c = clsOf(sim, flags);
				const tele = Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX;
				const tt = T.touchedTile(sim, W, H);
				const landed = sim.on_ground && air && t > 0;
				if (tele || (c !== c0 && c !== 'A') || landed || (tt >= 0 && trigTile[tt] === 1 && t > 0)) {
					out.push(Uint8Array.from(ms));
					if (landed) { const hm = Uint8Array.from(ms); hm[hm.length - 1] |= 1; out.push(hm); }
					break;
				}
				// (a segment's end: a node where the next edge changes the input)
				const seg = exactTile[T.tileOf(sim, W, H)] ? SEG_NEAR : sim.on_ground ? SEG_G : SEG_T;
				if (seg > 0 && t + 1 >= seg) { out.push(Uint8Array.from(ms)); break; }
				if (!sim.on_ground) air = true;
			}
		}
		return out;
	}
	/** expand node n: its edges, each replayed; children pushed */
	function expand(n, deadline, goal) {
		const t0 = Date.now();
		ST.expanded++;
		n.closed = true;
		const inf = infos.get(n.S.key) || infoOf(n.S, n.id);
		const lim = best ? Math.min(LEG_T, best.T - n.g - 1) : LEG_T;
		if (lim <= 0) return;
		const cand = [];   // [masks, kind]
		// (1) the direct legs to the plans' first waypoints within reach (a waypoint whose legs keep failing: only from
		// nearer, LEG_FAIL tries with no find halve the distance they are tried from)
		sim.restore(n.snap);
		const tl = Date.now();
		for (let p = 0; p < inf.plans.length; p++) {
			if (Date.now() >= deadline) break;
			const wp = inf.plans[p].steps[n.si ? n.si[p] : 0];
			sim.restore(n.snap);
			const wf = fieldOf(inf, wp);
			const c = wf ? RF.costAt(wf, sim) : -1;
			wp.tries = wp.tries || 0; wp.oks = wp.oks || 0;
			const reachT = wp.oks > 0 ? LEG_TILES : LEG_TILES / (1 << Math.min(3, Math.floor(wp.tries / LEG_FAIL)));
			if (c < 0 || c > reachT) continue;
			// (a step whose legs arrive and change nothing (the same abstract state, no new node) LEG_NOGAIN times: no more legs)
			if ((wp.noGain || 0) >= LEG_NOGAIN) continue;
			wp.tries++;
			let r = null;
			try {
				r = MS.leg(n.snap, { tiles: wp.tiles, cls: 'any' }, { Tmax: lim, chain: false, K: 2, fieldMs: Math.max(5, LEG_MS >> 1), coupled: c <= 6, coupledTicks: 20000, nodes: 30000,
					deadline: Math.min(deadline, Date.now() + LEG_MS) });
			} catch (e) { r = null; }
			ST.legs++;
			if (r && r.ok) { ST.legOk++; wp.oks++; cand.push([r.masks, 'leg', wp]); if (r.hop) cand.push([r.hop, 'leg', wp]); }
		}
		ST.legMs += Date.now() - tl;
		// (2) the landings fan-out, toward the least-ord waypoint and around the ball: from a SUPPORT (on the ground, at rest
		// on its axis: the move graph's nodes; LAND_AIR=1: from airborne nodes too)
		const t2 = Date.now();
		sim.restore(n.snap);
		const support = sim.on_ground && sim.speed_y === 0;
		// (once per (abstract state, tile, speed class) of support: the landings of the other position cells of the same tile
		// are the same moves a few px apart, and the fan-out is the costly edge family)
		const lk = support ? `${n.S.key}|${T.tileOf(sim, W, H)}|${Math.round(sim.speed_x)}` : '';
		const lc = support ? (landSeen.get(lk) || 0) : 0;
		if (support) landSeen.set(lk, lc + 1);
		if (Date.now() < deadline && ((support && lc < LAND_PER) || LAND_AIR)) {
			const ws = inf.plans[n.wi] ? inf.plans[n.wi].steps[n.si ? n.si[n.wi] : 0] : null;
			let lands = [];
			try { lands = MS.landings(n.snap, { Tmax: Math.min(lim, FAN_T), max: FAN_MAX, toward: { tiles: ws ? ws.tiles : trophyTiles }, K: 1, nodes: 20000, deadline: Math.min(deadline, Date.now() + 200) }); } catch (e) { lands = []; }
			for (const e of lands) { cand.push([e.masks, 'land']); if (e.hop) cand.push([e.hop, 'land']); }
			ST.lands += lands.length;
		}
		ST.landMs += Date.now() - t2;
		// (3) the event fan
		const t3 = Date.now();
		for (const ms of fanOf(n, Math.min(lim, FAN_T), goal)) cand.push([ms, 'fan']);
		ST.fanMs += Date.now() - t3;
		ST.fans++;
		// (4) the precomputed graph's edges
		if (graph) {
			let ge = [];
			try { sim.restore(n.snap); ge = graph.edgesOf(sim, { S: n.S, g: n.g, lim }) || []; } catch (e) { ge = []; }
			for (const e of ge) { const ms = e && e.masks ? e.masks : e; if (ms && ms.length) cand.push([ms instanceof Uint8Array ? ms : T.masksOf(ms), 'graph']); }
			ST.graphEdges += ge.length;
		}
		// the children
		for (const [ms, kind, cw] of cand) {
			if (!ms || !ms.length) continue;
			if (best && n.g + ms.length >= best.T + DEATH_WAIT) continue;
			const r = play(n, ms, goal);
			const g = n.g + r.t;
			if (r.end === 'goal') { routeAt(n.id, ms.subarray(0, r.t), g, kind); continue; }
			if (r.end === 'dead') { ST.dead++; continue; }
			if (best && g >= best.T) continue;
			if (r.end === 'respawn') {
				// (the death edge: the masks to the death, then no input to the respawn)
				ST.deathEdges++;
				const e = new Uint8Array(r.t); e.set(ms.subarray(0, Math.min(ms.length, r.t)));
				addNode(n.id, e, g, 'die');
				continue;
			}
			const ch = addNode(n.id, ms, g, kind);
			if (cw && (!ch || ch.S.key === n.S.key)) cw.noGain = (cw.noGain || 0) + 1;
		}
		n.snap = null;   // (expanded: its children hold what is needed; the route is rebuilt from the edges)
		ST.expandMs += Date.now() - t0;
	}

	// ---------------------------------------------------------------- the root and the loop
	function root() {
		sim.reset();
		const n = addNode(-1, new Uint8Array(0), 0, 'root');
		return n;
	}
	let rooted = false;
	/** the next step of the refinement ladder: finer classes, the A* again from the root and the injected states (the plans,
	 *  fields and the abstract states' first nodes kept: they are real states) */
	function refine() {
		level++;
		[lvQ, lvQX, lvK, lvKX] = LADDER[level];
		classes.clear(); seen.clear(); heap.a = []; landSeen.clear();
		w = W1; phase = W1 === WEND ? 2 : 1;
		ST.level = level; ST.refines = (ST.refines || 0) + 1;
		say({ ev: 'oneshot', what: 'refine', level, q: lvQ, qx: lvQX, k: lvK, kx: lvKX, expanded: ST.expanded });
		if (!o.noRoot) root();
		for (const m of injList) { sim.reset(); let dead = false; for (let t = 0; t < m.length; t++) { E.applyMask(inp, m[t] & 31); sim.tick(inp); } if (!sim.is_dead) addNode(-1, m, m.length, 'inj'); }
	}
	/**
	 * run(ms, ro) -> {ok, done, best, closed, stats}: the A* for ms (resumable). ro.goal: types.js goalOf (default: the
	 * trophy), ro.stop: () => bool
	 */
	function run(ms, ro = {}) {
		tRun0 = Date.now();
		const deadline = tRun0 + Math.max(1, ms);
		const goal = ro.goal || null;
		ST.runs++;
		if (!rooted) { rooted = true; if (!o.noRoot) root(); }
		let done = false;
		while (Date.now() < deadline) {
			if (ro.stop && ro.stop()) break;
			if (!heap.size) {
				if (!best && level + 1 < LADDER.length) { refine(); continue; }
				done = true; break;
			}
			const n = heap.pop();
			if (n.closed || !n.snap) continue;
			// (stale: its exact state reached sooner since, or its class filled with sooner states)
			if (seen.get(n.hash) < n.g) { ST.stale = (ST.stale || 0) + 1; n.snap = null; continue; }
			const gs = classes.get(n.ck);
			if (gs && gs.length >= n.K && gs[n.K - 1] < n.g) { ST.stale = (ST.stale || 0) + 1; n.snap = null; continue; }
			if (best && n.fa >= best.T) { ST.pruned++; continue; }
			expand(n, deadline, goal);
		}
		runMs += Date.now() - tRun0;
		ST.ms = runMs;
		if (done && best && !uncert) closed = true;
		return { ok: !!best, done, closed, best: best ? { masks: best.masks, ticks: best.T } : null, stats: stats() };
	}
	/** a real state from outside (masks from the level start) as a node: the executor's exact fallback's legs */
	function inject(masks, why) {
		if (!rooted) { rooted = true; if (!o.noRoot) root(); }
		sim.reset();
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (sim.is_dead && !deathsOK) return false; }
		if (sim.is_dead) return false;
		if (sim.has_silver_crown) { routeAt(-1, Uint8Array.from(masks), masks.length, 'inj'); return true; }
		// (tRun0 for the plan share's clock)
		if (!tRun0) tRun0 = Date.now();
		const n = addNode(-1, Uint8Array.from(masks), masks.length, 'inj');
		if (!o.noLadderInj) injList.push(Uint8Array.from(masks));
		if (n) { ST.injected++; ST.injH = Math.round(n.h); ST.injNear = n.near; }
		return !!n;
	}
	function arrivals() {
		const out = [];
		for (const [key, id] of firstOfS) { const n = nodes[id]; out.push({ key, S: n.S, g: n.g, id, masks: masksOf(id) }); }
		return out;
	}
	function stats() {
		let open = 0, minF = Infinity;
		for (const x of heap.a) if (!x.closed && x.snap) { open++; if (x.f < minF) minF = x.f; }
		return Object.assign({}, ST, { open, minF: Number.isFinite(minF) ? Math.round(minF) : null, best: best ? best.T : null, phase, closed, uncert, classes: classes.size });
	}
	return { run, inject, arrivals, best: () => (best ? { masks: best.masks, ticks: best.T } : null), stats, masksOf, _nodes: nodes };
}

/**
 * graphOf(g, L) -> {edgesOf(sim) -> [{masks}]}: part 2's whole-level move graph (src/plan/oneshot/edges.js buildGraph:
 * {sups: [{i, tile, cls}], edges: [{f, m (run-length [[mask, n], ...]) | masks, T}]}) as the solver's 'graph' edges: at
 * a node whose (centre tile, support class) is a support of the graph, that support's edges (proposals from its
 * representative state: the solver replays each from the node's own exact state, so a proposal that does not hold there
 * gives whatever the engine does, an exact edge all the same)
 */
function graphOf(g, L) {
	if (!g || !Array.isArray(g.sups) || !Array.isArray(g.edges)) return null;
	const W = L.width, H = L.height;
	const clsOf = require('../msolve.js').clsOf;
	const byKey = new Map();
	for (const e of g.edges) {
		const u = g.sups[e.f];
		if (!u) continue;
		const k = u.tile * 8 + 'GWCZBAD'.indexOf(u.cls);
		let a = byKey.get(k);
		if (!a) byKey.set(k, (a = []));
		a.push(e);
	}
	const dec = (e) => {
		if (e.masks) return e.masks;
		if (typeof e.m === 'string') return (e.masks = T.masksOf(e.m));
		let n = 0;
		for (const q of e.m) n += q[1];
		const out = new Uint8Array(n);
		let k = 0;
		for (const [m, c] of e.m) { out.fill(m, k, k + c); k += c; }
		return (e.masks = out);
	};
	return {
		edgesOf(sim) {
			const k = T.tileOf(sim, W, H) * 8 + 'GWCZBAD'.indexOf(clsOf(sim, L.flags));
			const a = byKey.get(k);
			if (!a) return [];
			const out = [];
			for (const e of a) {
				const m = dec(e);
				out.push({ masks: m });
				// (the landing hop part 2 verified from the representative: the jump bit on the edge's last tick)
				if (e.hop) { if (!e.hopMasks) { e.hopMasks = Uint8Array.from(m); e.hopMasks[m.length - 1] |= 1; } out.push({ masks: e.hopMasks }); }
			}
			return out;
		},
		stats: () => ({ sups: g.sups.length, edges: g.edges.length, keyed: byKey.size }),
	};
}

module.exports = { createOneShot, graphOf, KAPPA };
