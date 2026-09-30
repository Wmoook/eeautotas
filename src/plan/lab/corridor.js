'use strict';
// THE CORRIDOR (n5 chains lab, approach C, 2026-09-30): a LONG leg (a real engine state -> a target's tiles, hundreds to
// thousands of ticks, dozens of input changes) searched as a chain of short moves between the level's natural waypoints
// (the footholds: support spans; off them the air / field cells), several arrival states kept per waypoint (the speed
// carries), best-first on the goal field. Every returned leg is masks the engine replayed from the start to the target.
//
// WHAT THE MEASUREMENTS DECIDED (box 5; src/out/lab_corridor/, the ORCHESTRATOR's LAB corridor lines):
//   * the generator: one expansion from the route's own state at each landing of 24 stuck known-route legs (340 moves;
//     the route's next landing span reached no later than the route + 8 ticks): msolve's CHEAP FANS alone (the forward
//     fan-out, one x change, and the event fan, every held mask to its first event) 55.0% at 68 ms an expansion; the
//     sub-legs (msolve.leg aimed at the corridor's M best spans) alone 21.5%, both 58.2% at 239 ms: the legs cost 3.5x
//     for +3%. Aimed at the ROUTE's own next foothold, msolve.leg solves 42% at the corridor's small plain budget, 74%
//     with the plain tier unbounded (median 71 ms, p90 1 s); that foothold is among the corridor's 3 spans 115 / 340.
//   * the search: with the fans alone most searches ENDED 'exhausted' (the held-mask generator closes): timed stops on
//     plain nodes too (8, 20 ticks: mid-run and mid-air nodes the next fans turn from, so 2+-change moves compose) and
//     the Pareto store by x direction (dom 'dir': a run-up away from the target is kept) open it: 3 / 24 legs at 30 s,
//     progress (c0 - bestC) / c0 0.48 (the legs always: 1 / 17, 0.33).
//   * THE MOVES STUDY'S 4-MOVE CHAINS (tools/lab/corridor_chain.js: every 48th move of the known routes, the route's
//     exact state -> the support 4 moves ahead, 5 s each, paired with msolve.chain): 1,123 chains, the default below
//     75.1% vs msolve.chain 44.3% (route 60-120 ticks 87.4%, 120-240 64.6%, 240+ 49.5% vs 4.1%), found in 485 ms
//     median, every answer replayed. THE 55 KNOWN-ROUTE LEGS the compile fails (tools/lab/corridor_krt.js, the route's
//     own state at the previous trigger, 30 s): 26 / 55 vs msolve.chain 13 / 55 (the long ones 5 / 20 vs 0 / 20).
// So the default in the executor (tier MC, EEAT_CORRIDOR=1) is the event fan + the plain stops + the x-direction store
// (no landings fan: landMax 0, as good on the chains, found in 510 vs 730 ms median) and, where that store runs empty or
// stalls, the lazy pass's WIDENED fan (o.lazyWide: more stops, a longer hold, the landings) on the most advanced nodes;
// the sub-legs stay as options: legMode 'always' / 'stuck' (only where the fans made no progress) / 'lazy' (on the most
// advanced node the fans left, when their open list is empty or the frontier stalls lazyStall expansions; legNew: aimed
// only at footholds no node stands on).
//
// THE GEOMETRY (per leg, from the start's own state: the doors as they stand): the goal field f (types.js goalField: the
//   RCH3 physics field, cost in tiles, its -1 a proof); the SUPPORTS (a free centre tile whose box stands over a landable
//   tile, edges too: the box straddles the next column's floor) with their standing cost; the SPANS (maximal runs of
//   supports on one row); the field tiles with their least cost and their exits. The CORRIDOR of a state of cost c: the
//   spans of standing cost <= c - delta within one move's reach box, ranked by the move's estimated ticks + w x KAPPA x
//   the span's cost; none in reach: the spans nearest the ball (the repair).
// THE STORE AND ORDER: a node = a support tile when grounded ('s' + tile), else an air / field cell (tile, class, rising;
//   airKey 'vy': the vertical speed bucket too); K (grounded) / Ka (air) arrival states a node, Pareto in (tick, speed:
//   toward the target, or by x direction with dom 'dir'); f = g + w x KAPPA x c - BETA x the speed toward the target,
//   greedy (w1) until the first chain, then w; a state within D tiles tries the DIRECT leg (msolve.leg to the target,
//   horizon 120; skipped where the plain lower bound is past it). The first complete chain is the answer (o.first), else
//   anytime. o.resume: the node store, the open lists and the best kept per key (the executor's rungs add up).
//
//   const CR = createCorridor(L, {solver})   (solver: a msolve createSolver(L) to share, else one of its own)
//   CR.solve(start, target, o) -> {ok, masks, T, why, expanded, legs, subOk, repairs, nodes, ms, firstMs, c0, bestC,
//     bestCg, prof, resumed}
//     start: an EESnapshot / EESim of L; target: {tiles, cls ('any' default), tele, via}; o: {ms (3000), deadline, K (3),
//     Ka (2), delta (0.5), legT (120), alts (1), M (6), Mu (2), D (30), w1 (3), w (1.2), beta (4), fan (true), legs,
//     legMode, plainStops, fieldStops (8, 20, 40), dom, airKey, landMax (12), landT (60), landNodes (10000), Tmax (6000),
//     first, resume, probe, trace(ev)}
const E = require('../../eesim.js');
const RF = require('../../reach.js');
const T = require('../types.js');
const MS = require('../msolve.js');

const F_SOLID = 1, F_LIQUID = 64, F_CLIMB = 32, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const ARROWS = new Set([1, 2, 3, 1518, 411, 412, 413, 1519]);
const KAPPA = 16 / 6.776552880470027;       // ticks a tile at the held run's top speed
const VRUN = 6.776552880470027;
const KEEP = 4;                             // resumed searches kept (the newest)
const BFS_MASKS = [];                         // (o.bfs: the 18 masks a tick)
for (const p0 of [0, 1]) for (const m of MS.DIR9) BFS_MASKS.push(m | p0);
const REFINE = [{ fieldKey: 'sub', fieldPx: 8, fieldV: 2 }, { fieldKey: 'sub', fieldPx: 4, fieldV: 1 }];   // (o.refine's ladder)

function createCorridor(L, opts = {}) {
	const S = opts.solver || MS.createSolver(L, {});
	const W = L.width, H = L.height, N = W * H;
	const flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const plainOf = new Uint8Array(flags.length);
	for (let id = 0; id < flags.length; id++) {
		const f = flags[id] | 0;
		plainOf[id] = (f & (F_LIQUID | F_CLIMB | F_BOOST)) || DOTS.has(id) || ARROWS.has(id) ? 0 : 1;
	}
	const isField = (id) => id >= 0 && id < flags.length && ((flags[id] & F_SOLID) === 0) && plainOf[id] === 0;
	const clsOf = (s) => S.clsOf(s);
	const geoMemo = new Map();
	const stats = { solves: 0, legs: 0, subOk: 0, repairs: 0, directs: 0, directOk: 0 };

	/** per tile the least cost (tiles) of any abstract state centred there (the field entries' cost), -1 cut */
	function tileMinOf(f) {
		const m = new Float32Array(N).fill(-1);
		if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) { const v = f.walk ? f.walk[t] : RF.CUT; m[t] = v === RF.CUT ? -1 : v / 5; } return m; }
		const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL, CUT = RF.CUT;
		for (let t = 0; t < N; t++) {
			let v = CUT;
			for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
			for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
			const rc = f.rowC[t], rx = f.rowX[t];
			if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
			if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
			m[t] = v === CUT ? -1 : v / 5;
		}
		return m;
	}

	/**
	 * THE GEOMETRY of a leg: the goal field on the level as the doors stand in `s`, the supports with their standing cost,
	 * the spans (the tiles of each), the field tiles with their least cost (memo by the doors' pattern and the target)
	 */
	function geometry(s, tiles) {
		const Lc = T.levelNow(L, s);
		const key = T.fgHash(Lc.fg) + '|' + Array.from(tiles).sort((a, b) => a - b).join(',');
		let G = geoMemo.get(key);
		if (G) return G;
		const f = T.goalField(Lc, tiles, { deaths: false });
		const sol = S.solidOf(s);
		const cs = new Float32Array(N).fill(-1), span = new Int32Array(N).fill(-1), tm = tileMinOf(f);
		const spans = [];
		for (let y = 0; y < H - 1; y++) {
			let cur = null;
			for (let x = 0; x < W; x++) {
				const t = y * W + x;
				const id = Lc.fg[t];
				// a ball centred in column x stands there when its box (px in [16x - 8, 16x + 8)) is free over a landable tile
				// under one of its columns: the tile below, or an edge over the next column's floor (the box straddles it)
				let c = -1;
				if (sol[t] === 0 && !isField(id)) {
					for (const px of [16 * x, 16 * x - 8, 16 * x + 7]) {
						if (!S.boxFree(sol, px, 16 * y) || !S.floorAt(sol, px, y + 1)) continue;
						const v = RF.costAt(f, px, 16 * y, 0);
						if (v >= 0 && (c < 0 || v < c)) c = v;
					}
				}
				if (!(c >= 0)) { cur = null; continue; }
				cs[t] = c;
				if (!cur) { cur = { id: spans.length, row: y, x0: x, x1: x, c }; spans.push(cur); }
				cur.x1 = x;
				if (c < cur.c) cur.c = c;
				span[t] = cur.id;
			}
		}
		const fld = [], fex = [];
		for (let t = 0; t < N; t++) {
			if (!isField(Lc.fg[t]) || !(tm[t] >= 0)) continue;
			fld.push(t);
			// a field EXIT: a field tile next to (4-way) a free tile of plain physics (the field's edge the ball leaves by)
			const x = t % W, y = (t / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const u = yy * W + xx;
				if (sol[u] === 0 && !isField(Lc.fg[u])) { fex.push(t); break; }
			}
		}
		// the spans by row, for the reach box's scan
		const byRow = Array.from({ length: H }, () => []);
		for (const sp of spans) byRow[sp.row].push(sp);
		G = { f, cs, span, tm, spans, byRow, fld: Int32Array.from(fld), fex: Int32Array.from(fex), sol };
		geoMemo.set(key, G);
		if (geoMemo.size > 8) geoMemo.delete(geoMemo.keys().next().value);
		return G;
	}

	const cat = (a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };

	/** the estimated ticks of one move from (px, py, vx) to a span's nearest tile (run at the held speed, the fall's time) */
	function moveTicks(px, py, vx, sp) {
		const cx = px + 8, tx = cx < 16 * sp.x0 + 8 ? 16 * sp.x0 + 8 : cx > 16 * sp.x1 + 8 ? 16 * sp.x1 + 8 : cx;
		const dx = Math.abs(tx - cx), dy = 16 * sp.row + 8 - (py + 8);
		const v = Math.max(1.5, Math.min(VRUN, Math.abs(vx) + 1));
		const tX = dx / v;
		const tY = dy > 0 ? Math.sqrt(2 * dy / 0.258) : dy < -8 ? 30 : 0;
		return Math.max(tX, tY, 4);
	}

	/**
	 * THE CORRIDOR of a node: the spans of standing cost <= thr in the reach box around (cx, cy) (their tiles within the
	 * box), ranked by the estimated f after the move; when none: the spans nearest the ball of any cost (the repair); and
	 * the field tiles of least cost <= thr in the box (their entries), at most 48 of the least cost
	 */
	function corridorOf(G, s, thr, w, M, RX, RU, RD, Mu, exits, skip) {
		const cx = Math.trunc(s.px + 8) >> 4, cy = Math.trunc(s.py + 8) >> 4;
		const here = T.tileOf(s, W, H);
		const hereSpan = s.on_ground ? G.span[here] : -1;
		const cands = [], any = [];
		if (Mu === undefined) Mu = 0;
		for (let y = Math.max(0, cy - RU); y <= Math.min(H - 1, cy + RD); y++) {
			for (const sp of G.byRow[y]) {
				if (sp.x1 < cx - RX || sp.x0 > cx + RX || sp.id === hereSpan || (skip && skip(sp.id))) continue;
				const x0 = Math.max(sp.x0, cx - RX), x1 = Math.min(sp.x1, cx + RX);
				const tiles = [];
				let cmin = Infinity;
				for (let x = x0; x <= x1; x++) { const t = y * W + x; if (G.cs[t] >= 0) { tiles.push(t); if (G.cs[t] < cmin) cmin = G.cs[t]; } }
				if (!tiles.length) continue;
				const est = moveTicks(s.px, s.py, s.speed_x, { x0, x1, row: y });
				const e = { tiles, c: cmin, est, f: est + w * KAPPA * cmin, d: Math.abs(y - cy) + Math.max(0, x0 - cx, cx - x1) };
				if (cmin <= thr) cands.push(e); else any.push(e);
			}
		}
		cands.sort((a, b) => a.f - b.f);
		any.sort((a, b) => a.d - b.d || a.f - b.f);
		const fl = [];
		// (outside a field its entries: every field tile; inside one its exits)
		for (const t of exits ? G.fex : G.fld) {
			if (!(G.tm[t] <= thr) || t === here) continue;
			const x = t % W, y = (t / W) | 0;
			if (x < cx - RX || x > cx + RX || y < cy - RU - 16 || y > cy + RD) continue;
			fl.push(t);
		}
		fl.sort((a, b) => G.tm[a] - G.tm[b]);
		// (the uphill / level spans nearest the ball: Mu of them always, the relaxation's false nears need a way round;
		// with no corridor span at all, at least 2)
		return { spans: cands.slice(0, M), repair: any.slice(0, cands.length ? Mu : Math.max(2, Mu)), fld: fl.slice(0, 48), nCands: cands.length };
	}

	function solve(start, target, o = {}) {
		const t0 = Date.now();
		stats.solves++;
		const budgetMs = o.ms || 3000;
		const deadline = o.deadline ? Math.min(o.deadline, t0 + budgetMs) : t0 + budgetMs;
		const K = o.K || 3, Ka = o.Ka || 2, legT = o.legT || 120, alts = o.alts === undefined ? 1 : o.alts;
		const delta = o.delta === undefined ? 0.5 : o.delta, D = o.D === undefined ? 30 : o.D;
		const M = o.M || 6, Mu = o.Mu === undefined ? 2 : o.Mu, Ma = o.Ma || 1, subStop = o.subStop || 3;
		// the order's weight: w1 (greedy toward the target) until the first chain, then w (the anytime refinement)
		const w2 = o.w === undefined ? 1.2 : o.w, w1 = o.w1 === undefined ? 3 : o.w1;
		let w = w1;
		const BETA = o.beta === undefined ? 4 : o.beta, TMAX = o.Tmax || 6000;
		const fanOn = o.fan !== false;
		// the sub-legs: 'always' (every expansion), 'stuck' (only where the fans made no progress), 'never' (o.legs false)
		const legMode = o.legs === false ? 'never' : o.legMode || 'always';
		const lazyStall = o.lazyStall || 40;
		// (the lazy pass: o.lazyWide the widened fan (stops o.wideStops), o.lazyLegs false: no sub-legs there)
		const lazyWide = !!o.lazyWide, lazyLegs = o.lazyLegs !== false;
		const directOnce = !!o.directOnce, dTried = new Set();
		// THE FIELDS PASS (n5-s99-fields; every knob off = the corridor before, byte for byte):
		//   o.goalFan: the fans test the target on every tick they play (the engine's own state: a fan that crosses the
		//     target is a chain at once, not a node a later direct leg has to finish);
		//   o.directShare: the direct legs' clock at most this share of the call's elapsed time (in a field a direct leg
		//     costs ~40 ms against ~0.15 ms for a whole event fan: the fans starved);
		//   o.fieldKey 'sub': a state whose centre is in a field is its own node by its (tile, class, sub-tile offset in
		//     o.fieldPx px cells, speeds in o.fieldV px/tick cells): the entry offset and speed decide the ticks spent in
		//     the field and where it lets go (brief ADDENDUM 09:45), so arrivals that differ there are not merged; o.Kf
		//     states a field node.
		const goalFan = !!o.goalFan;
		const directShare = o.directShare || 0;
		const hot = [], dNear = o.directNear === undefined ? 2 : o.directNear;   // (the new nearest states' direct legs, next turn)
		const fieldKey = o.fieldKey || null, fPx = o.fieldPx || 4, fV = o.fieldV || 1, Kf = o.Kf || Ka;
		const restKey = !!o.restKey;
		const domDir = o.dom === 'dir', airKey = o.airKey || 'cls';
		// (the forward fan-out's size: o.landMax landings (0: none), horizon o.landT, o.landNodes)
		const landMax = o.landMax !== undefined ? o.landMax : 12, landT = o.landT || 60, landNodes = o.landNodes || 10000;
		const wideLand = Math.max(12, 2 * landMax);   // (the widened fan's landings: at least 12, also with landMax 0)
		// the event fan's timed stops (ticks): inside a field always (8, 20, 40), on plain physics o.plainStops (none by
		// default: the held mask to its first event only); a stop is an airborne or mid-run node the next fans turn from
		const stopsOf = (v, d) => new Set((v === undefined ? d : Array.isArray(v) ? v : String(v).split(',').filter(Boolean)).map(Number));
		const fieldStops = stopsOf(o.fieldStops, [8, 20, 40]), plainStops = stopsOf(o.plainStops, []), wideStops = stopsOf(o.wideStops, [3, 5, 12, 16, 30, 50, 80]);
		const RX = o.RX || 24, RU = o.RU || 5, RD = o.RD || 60, fanT = o.fanT || 120;
		const lazyM = o.lazyM || M, lazyRX = o.lazyRX || RX, lazyRU = o.lazyRU || RU, legNew = !!o.legNew;
		const snap0 = start instanceof E.EESim ? start.snapshot() : start;
		const tgt = Object.assign({}, target, { tiles: Array.from(target.tiles), cls: target.cls || 'any' });   // (tele / via kept: a portal target)
		const gtest = goalFan ? S.goal(tgt) : null;
		sim.restore(snap0);
		const G = geometry(sim, tgt.tiles);
		const c0 = RF.costAt(G.f, sim);
		const out = { ok: false, masks: null, T: 0, why: '', expanded: 0, legs: 0, subOk: 0, repairs: 0, nodes: 0, ms: 0, firstMs: 0, c0, bestC: c0, bestCg: 0 };
		const prof = { direct: 0, sub: 0, field: 0, land: 0, fan: 0, admit: 0 };
		const rej = { g: 0, dead: 0, seen: 0, cut: 0, dom: 0 };   // (the children admit refused, by why)
		if (!(c0 >= 0)) { out.why = 'cut'; out.ms = Date.now() - t0; return out; }
		// the target's side (for the speed credit)
		let tcx = 0; for (const t of tgt.tiles) tcx += t % W; tcx /= Math.max(1, tgt.tiles.length);
		// ---- the node store: key -> [states]; a state {snap, g, masks, c, v, key, f, dead}
		// THE RESUMED SEARCH (o.resume: a key the caller builds from the start state and the target): the node store, the
		// seen states, the open list, the order's weight and the best chain are kept (the newest KEEP keys) and a call with
		// the same key goes on where the last one stopped (the compile retries a stuck waypoint from the same arrival at every
		// rung: the calls add up instead of starting over)
		const R0 = o.resume ? keep.get(o.resume) : null;
		if (R0) { keep.delete(o.resume); keep.set(o.resume, R0); out.resumed = true; out.bestC = R0.bestC; out.bestCg = R0.bestCg; out.bestMasks = R0.bestMasks || null; }
		const nodes = R0 ? R0.nodes : new Map(), seen = R0 ? R0.seen : new Map();
		const heap = R0 ? R0.heap : [];
		// (the spans a grounded node stands on: legNew's filter)
		const spansHit = R0 && R0.spansHit ? R0.spansHit : new Set();
		const spanSeen = (spId) => spansHit.has(spId);
		// (legMode 'lazy': the nodes the fans expanded whose legs have not run, by their cost: the legs go to the most advanced
		// one when the fans' open list runs empty or the frontier stalls lazyStall expansions)
		const lazy = R0 && R0.lazy ? R0.lazy : [];
		const llt = (a, b) => a.c < b.c || (a.c === b.c && a.g < b.g);
		const lazyPush = (n) => { lazy.push(n); let i = lazy.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (!llt(lazy[i], lazy[q])) break; [lazy[q], lazy[i]] = [lazy[i], lazy[q]]; i = q; } };
		const lazyPop = () => { const top = lazy[0], last = lazy.pop(); if (lazy.length) { lazy[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < lazy.length && llt(lazy[l], lazy[m])) m = l; if (r < lazy.length && llt(lazy[r], lazy[m])) m = r; if (m === i) break; [lazy[m], lazy[i]] = [lazy[i], lazy[m]]; i = m; } } return top; };
		if (R0) w = R0.w;
		const lt = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);
		const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!lt(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && lt(heap[l], heap[m])) m = l; if (r < heap.length && lt(heap[r], heap[m])) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
		const push = (n) => { heap.push(n); up(heap.length - 1); };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; down(0); } return top; };
		const fOf = (x) => x.g + w * KAPPA * x.c - BETA * Math.max(0, x.v);
		let best = R0 ? R0.best : null;
		const trace = o.trace || null;
		/** the live sim's cost (tiles) by the goal field; a WALK-mode field (effect levels: never a proof) has no value off
		 *  its walkable tiles (a flying / launched ball): there the least of the walkable tiles within 2 of the ball + the
		 *  distance (Flight Path: every child of the start was -1, the search ended at its first expansion) */
		const costNow = () => {
			const c = RF.costAt(G.f, sim);
			if (c >= 0 || G.f.mode !== 'walk') return c;
			const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
			let b = -1;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				const x = cx + dx, y = cy + dy;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const v = G.tm[y * W + x];
				if (v >= 0) { const d = v + Math.max(Math.abs(dx), Math.abs(dy)); if (b < 0 || d < b) b = d; }
			}
			return b;
		};
		/** the node key of the live sim: its support tile when grounded on one, else its (tile, class, rising) cell */
		const keyOf = () => {
			const t = T.tileOf(sim, W, H);
			// (o.restKey: a support node only at rest on it, the vertical speed 0: a ball on the ground on its jump tick or
			// bonking under a ceiling is not yet standing, and the standing state dominated every child it made there)
			if (sim.on_ground && G.span[t] >= 0 && !(restKey && sim.speed_y !== 0)) return 's' + t;
			if (fieldKey && isField(sim.current_tile)) {
				// (a field cell: the sub-tile offset and the speeds too)
				const ox = Math.floor((((sim.px % 16) + 16) % 16) / fPx), oy = Math.floor((((sim.py % 16) + 16) % 16) / fPx);
				return 'f' + t + clsOf(sim) + ':' + ox + ',' + oy + ':' + Math.round(sim.speed_x / fV) + ',' + Math.round(sim.speed_y / fV);
			}
			// (airKey 'vy': the rise / fall speed in 2 px/tick buckets too: two arrivals in one tile at different vertical speeds
			// land in different places)
			if (airKey === 'vy') return 'c' + t + clsOf(sim) + ':' + Math.round(sim.speed_y / 2);
			return 'c' + t + clsOf(sim) + (sim.speed_y < 0 ? 'u' : 'd');
		};
		/** the speed toward the target's side (px/tick; the credit a kept faster arrival gets) */
		const toward = () => { const cx = (Math.trunc(sim.px + 8) >> 4); const dir = tcx > cx + 0.5 ? 1 : tcx < cx - 0.5 ? -1 : 0; return dir * sim.speed_x; };
		/** insert the live sim (reached with masks, g ticks) as a state; false when dominated / seen / cut */
		function admit(masks, g, from) {
			if (g >= TMAX || (best && g >= best.T)) { rej.g++; return false; }
			if (sim.is_dead) { rej.dead++; return false; }
			const h = sim.stateHash();
			const sg = seen.get(h);
			if (sg !== undefined && sg <= g) { rej.seen++; return false; }
			seen.set(h, g);
			const c = costNow();
			if (!(c >= 0)) { rej.cut++; return false; }
			const newBest = c < out.bestC;
			if (c < out.bestC) { out.bestC = c; out.bestCg = g; out.bestMasks = masks; }
			const key = keyOf(), v = toward();
			let a = nodes.get(key);
			if (!a) { a = []; nodes.set(key, a); }
			// Pareto in (g, v) with 1 tick / 0.25 px/tick of tolerance, at most K (Ka) a node
			// (dom 'dir': a state dominates another only moving the same way at least as fast (the x speed's sign and size),
			// never across directions: a run-up away from the target is kept next to a standing arrival)
			const sx = sim.speed_x;
			const dm = domDir ? (q, g1, x1) => q.g <= g1 && (Math.abs(x1) < 0.25 || Math.sign(q.sx) === Math.sign(x1)) && Math.abs(q.sx) >= Math.abs(x1) - 0.25 : (q, g1, x1, v1) => q.g <= g1 && q.v >= v1 - 0.25;
			for (const q of a) if (dm(q, g, sx, v)) { rej.dom++; return false; }
			for (let i = a.length - 1; i >= 0; i--) if (dm({ g, sx, v }, a[i].g, a[i].sx, a[i].v)) { a[i].dead = true; a.splice(i, 1); }
			const n = { snap: sim.snapshot(), g, masks, c, v, sx, key, f: 0, dead: false, from };
			if (key[0] === 's') spansHit.add(G.span[+key.slice(1)]);
			n.f = fOf(n);
			if (a.length >= (key[0] === 's' ? K : key[0] === 'f' ? Kf : Ka)) {
				a.sort((p, q) => p.f - q.f);
				if (a[a.length - 1].f <= n.f) return false;
				a[a.length - 1].dead = true;
				a.pop();
			}
			a.push(n);
			push(n);
			out.nodes++;
			// (o.directShare: a new nearest state within dNear tiles gets its direct leg at the loop's next turn, whatever
			// its place in the order: the near misses one tile from the target waited behind cheaper nodes)
			if (directShare && newBest && c <= dNear) hot.push(n);
			if (o.probe) (out.kids || (out.kids = [])).push({ tile: T.tileOf(sim, W, H), g, ground: !!sim.on_ground, from, c });
			return true;
		}
		/** play masks from snapshot sn; the live sim ends there; false on a death */
		function play(sn, ms) {
			sim.restore(sn);
			for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); if (sim.is_dead) return false; }
			return true;
		}
		const legOpts = (Tmax, plainNode) => ({ Tmax, chain: false, fields: !plainNode, coupled: !plainNode, nodes: o.legNodes || 40000, itemNodes: o.itemNodes || 10000, plainMs: o.plainMs || 25, coupledTicks: o.coupledTicks || 20000, fieldMs: o.fieldMs || 40, alts, altSlack: 12, deadline, prove: false });
		/** a leg's arrivals (the answer, its hop, the alternatives) admitted from node n */
		function takeLeg(n, r, tag) {
			let k = 0;
			const list = [r.masks];
			if (r.hop) list.push(r.hop);
			if (r.alts) for (const a of r.alts) list.push(a.masks);
			for (const ms of list) {
				if (!ms || !ms.length) continue;
				if (!play(n.snap, ms)) continue;
				if (admit(cat(n.masks, ms), n.g + ms.length, tag)) k++;
			}
			return k;
		}
		const setBest = (T1, masks) => {
			if (best && T1 >= best.T) return;
			best = { T: T1, masks };
			if (!out.firstMs) out.firstMs = Date.now() - t0;
			if (trace) trace({ ev: 'best', T: T1 });
			if (w !== w2) { w = w2; for (const x of heap) x.f = fOf(x); for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i); }
		};
		// THE EXACT SHORT SEARCH (o.bfs): every input sequence (the 18 masks a tick) from a node, states merged by stateHash,
		// o.bfsCap states a layer, to o.bfsD ticks, the target tested every tick: the moves the held-mask fans and the direct
		// legs do not make (The Memory Game's 20-tick boost chain exhausted the corridor at 227 expansions; this search finds
		// it at depth 20 in 0.75 s); run on a new nearest state within dNear (the hot list, o.bfsMs of clock) and on the
		// most advanced states of an exhausted search. Exact: the engine's own ticks, the first hit the fewest ticks from
		// that node within the cap
		const gB = o.bfs ? (gtest || S.goal(tgt)) : null;
		const bfsFrom = (nn, depth, cap, until) => {
			out.bfsRuns = (out.bfsRuns || 0) + 1;
			const tp = Date.now();
			let layer = [{ snap: nn.snap, m: -1, par: null }];
			const seenB = new Set();
			let found = null;
			for (let d = 1; d <= depth && layer.length && !found; d++) {
				if (best && nn.g + d >= best.T) break;
				const nx = [];
				for (const e of layer) {
					if (Date.now() > until) { nx.length = 0; break; }
					for (const m of BFS_MASKS) {
						sim.restore(e.snap);
						const px = sim.px, py = sim.py;
						E.applyMask(inp, m); sim.tick(inp);
						if (sim.is_dead) continue;
						if (gB(sim, px, py)) { found = { m, par: e }; break; }
						const h = sim.stateHash();
						if (seenB.has(h)) continue;
						seenB.add(h);
						if (nx.length < cap) nx.push({ snap: sim.snapshot(), m, par: e });
					}
					e.snap = null;
					if (found) break;
				}
				layer = nx;
			}
			prof.bfs = (prof.bfs || 0) + Date.now() - tp;
			if (!found) return false;
			const ms = [];
			for (let e = found; e && e.m >= 0; e = e.par) ms.push(e.m);
			ms.reverse();
			out.bfsOk = (out.bfsOk || 0) + 1;
			setBest(nn.g + ms.length, cat(nn.masks, Uint8Array.from(ms)));
			return true;
		};
		if (!R0) { sim.restore(snap0); admit(new Uint8Array(0), 0, 'start'); }
		let lastC = out.bestC, stall = 0;
		/** the direct leg from node nn to the target (o.first: true when it ended the search) */
		const directLeg = (nn, plainNode) => {
			const lim = best ? Math.min(120, best.T - nn.g - 1) : 120;
			if (!(lim > 0)) return false;
			stats.directs++; out.legs++;
			const tp = Date.now();
			// (a plain node whose admissible bound to the target is past the horizon: no direct leg; its budgets o.dCT / o.dFMs)
			const r = plainNode && S.lowerBound(nn.snap, tgt) > lim ? { ok: false, why: 'lb' } : S.leg(nn.snap, tgt, Object.assign(legOpts(lim, plainNode), { alts: 0, fields: true, coupled: true, coupledTicks: o.dCT || 60000, fieldMs: o.dFMs || 100 }));
			prof.direct += Date.now() - tp;
			if (!r.ok) return false;
			stats.directOk++;
			setBest(nn.g + r.T, cat(nn.masks, r.masks));
			return true;
		};
		// THE DEFERRED DIRECT LEGS (o.directShare): a node whose direct leg the share put off waits here by its cost (the
		// nearest first); the share's room goes to them before any new node's (only a NEW nearest state within o.directNear
		// tiles skips the share, the hot list: every node near the target skipping it starved the fans there again)
		const dq = [];
		const dlt = (a, b) => a.c < b.c || (a.c === b.c && a.g < b.g);
		const dqPush = (x) => { dq.push(x); let i = dq.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (!dlt(dq[i], dq[q])) break; [dq[q], dq[i]] = [dq[i], dq[q]]; i = q; } };
		const dqPop = () => { const top = dq[0], last = dq.pop(); if (dq.length) { dq[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < dq.length && dlt(dq[l], dq[m])) m = l; if (r < dq.length && dlt(dq[r], dq[m])) m = r; if (m === i) break; [dq[m], dq[i]] = [dq[i], dq[m]]; i = m; } } return top; };
		const dRoom = () => !directShare || prof.direct <= directShare * (Date.now() - t0) + 20;
		while (Date.now() < deadline) {
			if (hot.length) {
				const m = hot.pop();
				if (!m.dead && !(best && m.g + 1 >= best.T) && !(directOnce && dTried.has(m.key))) {
					if (directOnce) dTried.add(m.key);
					sim.restore(m.snap);
					out.hotRuns = (out.hotRuns || 0) + 1;
					if (directLeg(m, !!S.plainStart(sim)) && o.first) break;
					if (o.bfs && !best && bfsFrom(m, o.bfsD || 24, o.bfsCap || 2000, Math.min(deadline, Date.now() + (o.bfsMs || 400))) && o.first) break;
				}
				continue;
			}
			if (dq.length && dRoom()) {
				const m = dqPop();
				if (!m.dead && !(best && m.g + 1 >= best.T)) {
					sim.restore(m.snap);
					out.dqRuns = (out.dqRuns || 0) + 1;
					if (directLeg(m, !!S.plainStart(sim)) && o.first) break;
				}
				continue;
			}
			let n = null, pass = 'all';
			if (legMode === 'lazy' && lazy.length && (!heap.length || stall >= lazyStall)) { n = lazyPop(); pass = 'legs'; stall = 0; out.lazyPasses = (out.lazyPasses || 0) + 1; }
			else if (heap.length) n = pop();
			else break;
			if (n.dead) continue;
			if (best && n.g + 1 >= best.T) continue;
			if (pass === 'all') out.expanded++;
			if (out.bestC < lastC - 0.01) { lastC = out.bestC; stall = 0; } else stall++;
			sim.restore(n.snap);
			const plainNode = !!S.plainStart(sim);
			if (trace) trace({ ev: 'expand', g: n.g, c: n.c, f: n.f, key: n.key, from: n.from, tile: T.tileOf(sim, W, H), vx: sim.speed_x, vy: sim.speed_y });
			// THE DIRECT LEG near the target
			// (o.directOnce: one direct leg a node key (the tile cell), from its first expanded state)
			if (pass === 'all' && n.c <= D && !(directOnce && dTried.has(n.key))) {
				if (directOnce) dTried.add(n.key);
				if (directShare && !dRoom()) dqPush(n);
				else if (directLeg(n, plainNode)) { if (o.first) break; continue; }
			}
			sim.restore(n.snap);
			// (a grounded plain node: M spans; an airborne or field node (a launch, a field's inside): the best one, its
			// fans do the rest)
			const grounded = plainNode && sim.on_ground;
			const inField = !plainNode && clsOf(sim) !== 'A' && clsOf(sim) !== 'G';
			// (the lazy legs pass: its own span count and reach box, the legs being rare; legNew: only footholds no node stands on
			// yet: the fans reach the others)
			const lp = pass === 'legs';
			const cor = corridorOf(G, sim, n.c - delta, w, grounded ? (lp ? lazyM : M) : Ma, lp ? lazyRX : RX, lp ? lazyRU : RU, RD, grounded ? Mu : 0, inField, lp && legNew ? spanSeen : null);
			// THE SUB-LEGS: msolve.leg to each of the best corridor spans, then the nearest uphill / level spans (the repair)
			let got = 0, tp;
			const doLegs = () => {
				tp = Date.now();
				if (!cor.spans.length) { out.repairs++; stats.repairs++; }
				let nOk = 0;
				for (const [list, tag] of [[cor.spans, 'sub'], [cor.repair, 'rep']]) for (const sp of list) {
					if (Date.now() >= deadline || nOk >= subStop) break;
					const lim = best ? Math.min(legT, best.T - n.g - 1) : legT;
					if (lim <= 0) break;
					// (the plain regime's admissible bound past the horizon: no leg, skipped)
					if (plainNode && S.lowerBound(n.snap, { tiles: sp.tiles, cls: 'G' }) > lim) { out.lbSkips = (out.lbSkips || 0) + 1; continue; }
					out.legs++; stats.legs++;
					const r = S.leg(n.snap, { tiles: sp.tiles, cls: 'G' }, legOpts(lim, plainNode));
					if (r.ok) nOk++;
					if (r.ok) { got += takeLeg(n, r, tag); out.subOk++; stats.subOk++; }
					if (trace) trace({ ev: tag, n: sp.tiles.length, c: sp.c, est: Math.round(sp.est), ok: r.ok, T: r.T, why: r.why, tool: r.tool });
				}
				prof.sub += Date.now() - tp;
				// the field entries of the corridor (class any: the centre in a field tile; inside a field: its exits)
				tp = Date.now();
				if (cor.fld.length && (!got || !grounded) && Date.now() < deadline) {
					out.legs++; stats.legs++;
					const lim = best ? Math.min(legT, best.T - n.g - 1) : legT;
					if (lim > 0) {
						const r = S.leg(n.snap, { tiles: cor.fld, cls: 'any' }, Object.assign(legOpts(lim, plainNode), { fields: true }));
						if (r.ok) { got += takeLeg(n, r, 'field'); out.subOk++; stats.subOk++; }
						if (trace) trace({ ev: 'subField', n: cor.fld.length, ok: r.ok, T: r.T, why: r.why });
					}
				}
				prof.field += Date.now() - tp;
			};
			// MSOLVE'S CHEAP FANS: the forward fan-out toward the corridor (one x change) and the event fan (every held mask to
			// its first support event, with its timed stops inside a field: the ways the footholds do not see); the least cost
			// of the children it admitted (the progress test of legMode 'stuck')
			const doFans = (wide) => {
				// (wide: the widened fan of a lazy pass: more stops, a longer hold, more landings over a longer horizon)
				const stops = wide ? wideStops : plainNode ? plainStops : fieldStops, fT = wide ? 2 * fanT : fanT;
				const kids = [];
				tp = Date.now();
				if (plainNode && (wide ? wideLand : landMax) > 0) {
					const aim = cor.spans.length ? [].concat(...cor.spans.map((s) => s.tiles)) : tgt.tiles;
					const lands = S.landings(n.snap, { Tmax: wide ? 2 * landT : landT, K: 1, max: wide ? wideLand : landMax, toward: { tiles: aim }, nodes: wide ? 4 * landNodes : landNodes, deadline });
					for (const e of lands) { kids.push(e.masks); if (e.hop) kids.push(e.hop); }
				}
				prof.land += Date.now() - tp;
				tp = Date.now();
				for (const p0 of [0, 1]) for (const m0 of MS.DIR9) {
					sim.restore(n.snap);
					const c00 = clsOf(sim);
					let air = !sim.on_ground || sim.speed_y !== 0;
					const ms = [];
					for (let t = 0; t < fT; t++) {
						const px = sim.px, py = sim.py;
						const mk = t === 0 ? (m0 | p0) : m0;
						E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
						if (sim.is_dead) break;
						const c1 = clsOf(sim);
						const tele = Math.abs(sim.px - px) > 20 || Math.abs(sim.py - py) > 20;
						if (gtest && gtest(sim, px, py)) { setBest(n.g + t + 1, cat(n.masks, Uint8Array.from(ms))); out.fanGoal = (out.fanGoal || 0) + 1; break; }
						if (tele || (c1 !== c00 && c1 !== 'A') || (sim.on_ground && air && t > 0)) { kids.push(Uint8Array.from(ms)); break; }
						if (stops.has(t + 1)) kids.push(Uint8Array.from(ms));
						if (!sim.on_ground) air = true;
					}
				}
				prof.fan += Date.now() - tp;
				tp = Date.now();
				let k = 0, cMin = Infinity;
				for (const ms of kids) {
					if (!play(n.snap, ms)) continue;
					if (admit(cat(n.masks, ms), n.g + ms.length, 'fan')) { k++; const c = costNow(); if (c >= 0 && c < cMin) cMin = c; }
				}
				prof.admit += Date.now() - tp;
				if (trace) trace({ ev: 'kids', kids: kids.length, admitted: k, got });
				return cMin;
			};
			if (pass === 'legs') { if (lazyWide) doFans(true); if (lazyLegs) doLegs(); }
			else if (legMode === 'lazy') { if (fanOn) doFans(); lazyPush(n); }
			else if (legMode === 'stuck') {
				// fans first; the legs only where the fans admitted no child below the node's cost - delta (the moves a held
				// mask and one x change do not make: run-ups, mid-air turns, uphill ways)
				const cMin = fanOn ? doFans() : Infinity;
				if (!(cMin < n.c - delta) && Date.now() < deadline) { out.stuck = (out.stuck || 0) + 1; doLegs(); }
			} else {
				if (legMode !== 'never') doLegs();
				if (fanOn && Date.now() < deadline) doFans();
			}
			if (o.probe) break;
			if (o.first && best && goalFan) break;
		}
		out.prof = prof; out.rej = rej;
		out.ms = Date.now() - t0;
		if (best) { out.ok = true; out.masks = best.masks; out.T = best.T; }
		else out.why = heap.length || lazy.length ? 'budget' : 'exhausted';
		if (o.resume) {
			// (kept while it can still give something: an open node)
			if ((heap.length || lazy.length) && !best) {
				keep.set(o.resume, { nodes, seen, heap, lazy, spansHit, best, w, bestC: out.bestC, bestCg: out.bestCg, bestMasks: out.bestMasks || null });
				while (keep.size > KEEP) keep.delete(keep.keys().next().value);
			} else keep.delete(o.resume);
		}
		// (o.bfs: an exhausted search's most advanced states, the least cost first, get the exact short search with the
		// time left, before the refinement ladder)
		if (!best && o.bfs && out.why === 'exhausted' && Date.now() < deadline - 20) {
			const all = [];
			for (const a of nodes.values()) for (const q of a) all.push(q);
			all.sort((p, q) => p.c - q.c || p.g - q.g);
			for (const q of all.slice(0, o.bfsK || 4)) {
				if (Date.now() >= deadline - 20) break;
				if (bfsFrom(q, o.bfsD2 || 40, o.bfsCap2 || 4000, deadline)) { out.ok = true; out.masks = best.masks; out.T = best.T; out.why = ''; break; }
			}
			out.ms = Date.now() - t0;
			if (best) return out;
		}
		// THE REFINEMENT LADDER (o.refine: true = REFINE, or the levels left): a search that ran out of nodes (exhausted) with
		// time left goes again, fresh, with finer field cells (the sub-tile offset and the speeds in the key: fieldKey), then
		// finer still: arrivals the coarse store merged (a dot field's cell kept 2 states by the x speed alone) are the way
		// on; as a default key the fine cells dilute the search (the field chains 80.3% plain vs 78.4% / 75.0% with the
		// coarse / fine cells as the key from the start), as the next step of an exhausted one they only add
		if (!best && o.refine && out.why === 'exhausted' && Date.now() < deadline - 20) {
			const lv = Array.isArray(o.refine) ? o.refine : REFINE;
			if (lv.length) {
				const tR = Date.now() - t0;
				const r2 = solve(snap0, target, Object.assign({}, o, lv[0], { refine: lv.slice(1), resume: undefined, deadline, ms: Math.max(1, deadline - Date.now()) }));
				r2.refined = (r2.refined || 0) + 1;
				r2.expanded += out.expanded; r2.nodes += out.nodes;
				r2.c0 = out.c0; if (out.bestC < r2.bestC) { r2.bestC = out.bestC; r2.bestCg = out.bestCg; r2.bestMasks = out.bestMasks; }
				if (r2.firstMs) r2.firstMs += tR;
				r2.ms = Date.now() - t0;
				return r2;
			}
		}
		return out;
	}
	const keep = new Map();
	return { solve, geometry, corridorOfForTest: corridorOf, stats: () => Object.assign({}, stats), solver: S };
}

module.exports = { createCorridor, KAPPA };
