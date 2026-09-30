'use strict';
// THE CORRIDOR (n5 chains lab, approach C, 2026-09-30): a LONG leg (a real engine state -> a target's tiles, hundreds to
// thousands of ticks, dozens of input changes) decomposed into SHORT sub-legs at the level's natural waypoints, each one
// the move solver's (src/plan/msolve.js: <= its horizon, few input changes, computed and replayed, not searched), with
// several arrival states kept per waypoint and the join chosen by a dynamic programme over them, so the speed carries.
//
// WHY: msolve.chain (A* over support states) expands by the forward fan-out (msolve.landings: ONE x change, 60 ticks) and
// the event fan (the 18 held masks to their first event). Along the known routes' stuck legs (tools/lab/corridor_cases.js:
// the compile's failing waypoints, from the route's own states) those two generators produce the route's next landing on
// only ~20-35% (landings) / ~30-50% (event fan) of its moves, while msolve.leg aimed at THAT landing's tile (two x changes,
// the land-and-act members, the field and coupled tiers) solves ~85% of them in 1-50 ms (src/out/lab_corridor/cover.js).
// The chain's successors miss the moves; its direct leg aims only at the far target. The corridor aims msolve.leg at the
// NEXT FOOTHOLDS instead, and the geometry says which.
//
// THE GEOMETRY (per leg, from the start's own state: the doors as they stand):
//   the goal field f = the RCH3 physics field of the level as the doors stand (types.js goalField: a sound relaxation,
//   cost in tiles to the target; its -1 a proof); the SUPPORTS = every standable tile (a free centre tile whose 16 x 16
//   box is free over a landable tile: solid, one-way, half block; not a field tile), each with its STANDING COST cs(t) =
//   f at a ball at rest there; the SPANS = maximal runs of supports on one floor row (the footholds: a waypoint is a
//   span, the sub-leg's target its tiles within reach, one row: cheap for the plain solver); the FIELD tiles (arrows,
//   dots, liquids, climbables, boosts) with their least cost tm(t) over every abstract state there (their entries are
//   waypoints of their own). The CORRIDOR of a state of cost c: the spans of standing cost <= c - delta within one move's
//   reach (the next sub-level set of footholds: every way to the target meets the sub-level set, a cut of the level for
//   the physics the field models; its footholds are where the ball stops, never a cell in mid-air), ranked by the order
//   the search itself uses (the move's estimated ticks + w x KAPPA x the span's cost); when none is in reach (the
//   relaxation's false near, an uphill way) the spans nearest the ball (any cost): the corridor's REPAIR.
// THE SUB-LEGS: msolve.leg from a kept state to each of the M best corridor spans (class G: a landing there), horizon
//   legT, with the plain tier's alternatives (o.alts: distinct end speeds within altSlack ticks) and the landing hop (the
//   jump on the landing tick: the same foothold, launched); the field entries (class any) when the corridor has field
//   tiles; msolve's cheap fans too (landings, one x change; the event fan: every held mask to its first event, with timed
//   stops inside a field). Every arrival the engine's replay.
// THE DP OVER ARRIVAL STATES: the waypoints are the search's nodes (a support tile when grounded; off the supports a
//   (tile, class, rising) cell); a node keeps up to K (grounded) / Ka (air) arrival states, Pareto in (the tick, the
//   speed toward the target's side): a later but faster arrival survives an earlier slow one (it saves the run-up the
//   slow one still has to make). The order is best-first on f = g + w x KAPPA x c(state) - BETA x the speed toward the
//   target (ticks: KAPPA = the ticks a tile at the top running speed), greedy (w1) until the first chain, then w: so the
//   deepest cheap footholds are expanded first; a state near the target (c <= D tiles) also tries the DIRECT leg
//   (msolve.leg to the target, horizon 120). The first complete chain is the answer (anytime: later chains replace it
//   while the clock lasts, pruned by g).
// Nothing here proves anything: every returned leg is masks the engine replayed from the start to the target.
//
//   const CR = createCorridor(L, {solver})   (solver: a msolve createSolver(L) to share, else one of its own)
//   CR.solve(start, target, o) -> {ok, masks, T, why, expanded, legs, subOk, repairs, nodes, ms, firstMs, prof}
//     start: an EESnapshot / EESim of L; target: {tiles, cls ('any' default)}; o: {ms (3000), deadline, K (3), Ka (2),
//     delta (tiles, 3), legT (90), alts (1), M (spans a node, 5), D (tiles, 30: the direct leg's radius), w1 (3), w (1.2),
//     beta (4), fan (true: msolve's cheap fans too), Tmax (the whole leg's tick cap, 6000), first (stop at the first
//     chain), trace(ev)}
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
	function corridorOf(G, s, thr, w, M, RX, RU, RD, Mu, exits) {
		const cx = Math.trunc(s.px + 8) >> 4, cy = Math.trunc(s.py + 8) >> 4;
		const here = T.tileOf(s, W, H);
		const hereSpan = s.on_ground ? G.span[here] : -1;
		const cands = [], any = [];
		if (Mu === undefined) Mu = 0;
		for (let y = Math.max(0, cy - RU); y <= Math.min(H - 1, cy + RD); y++) {
			for (const sp of G.byRow[y]) {
				if (sp.x1 < cx - RX || sp.x0 > cx + RX || sp.id === hereSpan) continue;
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
		const RX = o.RX || 24, RU = o.RU || 5, RD = o.RD || 60, fanT = o.fanT || 120;
		const snap0 = start instanceof E.EESim ? start.snapshot() : start;
		const tgt = { tiles: Array.from(target.tiles), cls: target.cls || 'any' };
		sim.restore(snap0);
		const G = geometry(sim, tgt.tiles);
		const c0 = RF.costAt(G.f, sim);
		const out = { ok: false, masks: null, T: 0, why: '', expanded: 0, legs: 0, subOk: 0, repairs: 0, nodes: 0, ms: 0, firstMs: 0, c0, bestC: c0, bestCg: 0 };
		const prof = { direct: 0, sub: 0, field: 0, land: 0, fan: 0, admit: 0 };
		if (!(c0 >= 0)) { out.why = 'cut'; out.ms = Date.now() - t0; return out; }
		// the target's side (for the speed credit)
		let tcx = 0; for (const t of tgt.tiles) tcx += t % W; tcx /= Math.max(1, tgt.tiles.length);
		// ---- the node store: key -> [states]; a state {snap, g, masks, c, v, key, f, dead}
		// THE RESUMED SEARCH (o.resume: a key the caller builds from the start state and the target): the node store, the
		// seen states, the open list, the order's weight and the best chain are kept (the newest KEEP keys) and a call with
		// the same key goes on where the last one stopped (the compile retries a stuck waypoint from the same arrival at every
		// rung: the calls add up instead of starting over)
		const R0 = o.resume ? keep.get(o.resume) : null;
		if (R0) { keep.delete(o.resume); keep.set(o.resume, R0); out.resumed = true; out.bestC = R0.bestC; out.bestCg = R0.bestCg; }
		const nodes = R0 ? R0.nodes : new Map(), seen = R0 ? R0.seen : new Map();
		const heap = R0 ? R0.heap : [];
		if (R0) w = R0.w;
		const lt = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);
		const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!lt(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && lt(heap[l], heap[m])) m = l; if (r < heap.length && lt(heap[r], heap[m])) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
		const push = (n) => { heap.push(n); up(heap.length - 1); };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; down(0); } return top; };
		const fOf = (x) => x.g + w * KAPPA * x.c - BETA * Math.max(0, x.v);
		let best = R0 ? R0.best : null;
		const trace = o.trace || null;
		/** the node key of the live sim: its support tile when grounded on one, else its (tile, class, rising) cell */
		const keyOf = () => {
			const t = T.tileOf(sim, W, H);
			if (sim.on_ground && G.span[t] >= 0) return 's' + t;
			return 'c' + t + clsOf(sim) + (sim.speed_y < 0 ? 'u' : 'd');
		};
		/** the speed toward the target's side (px/tick; the credit a kept faster arrival gets) */
		const toward = () => { const cx = (Math.trunc(sim.px + 8) >> 4); const dir = tcx > cx + 0.5 ? 1 : tcx < cx - 0.5 ? -1 : 0; return dir * sim.speed_x; };
		/** insert the live sim (reached with masks, g ticks) as a state; false when dominated / seen / cut */
		function admit(masks, g, from) {
			if (g >= TMAX || (best && g >= best.T)) return false;
			if (sim.is_dead) return false;
			const h = sim.stateHash();
			const sg = seen.get(h);
			if (sg !== undefined && sg <= g) return false;
			seen.set(h, g);
			const c = RF.costAt(G.f, sim);
			if (!(c >= 0)) return false;
			if (c < out.bestC) { out.bestC = c; out.bestCg = g; }
			const key = keyOf(), v = toward();
			let a = nodes.get(key);
			if (!a) { a = []; nodes.set(key, a); }
			// Pareto in (g, v) with 1 tick / 0.25 px/tick of tolerance, at most K (Ka) a node
			for (const q of a) if (q.g <= g && q.v >= v - 0.25) return false;
			for (let i = a.length - 1; i >= 0; i--) if (a[i].g >= g && a[i].v <= v + 0.25) { a[i].dead = true; a.splice(i, 1); }
			const n = { snap: sim.snapshot(), g, masks, c, v, key, f: 0, dead: false, from };
			n.f = fOf(n);
			if (a.length >= (key[0] === 's' ? K : Ka)) {
				a.sort((p, q) => p.f - q.f);
				if (a[a.length - 1].f <= n.f) return false;
				a[a.length - 1].dead = true;
				a.pop();
			}
			a.push(n);
			push(n);
			out.nodes++;
			if (o.probe) (out.kids || (out.kids = [])).push({ tile: T.tileOf(sim, W, H), g, ground: !!sim.on_ground, from, c });
			return true;
		}
		/** play masks from snapshot sn; the live sim ends there; false on a death */
		function play(sn, ms) {
			sim.restore(sn);
			for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); if (sim.is_dead) return false; }
			return true;
		}
		const legOpts = (Tmax, plainNode) => ({ Tmax, chain: false, fields: !plainNode, coupled: !plainNode, nodes: o.legNodes || 40000, itemNodes: o.itemNodes || 10000, plainMs: o.plainMs || 25, coupledTicks: o.coupledTicks || 20000, fieldMs: o.fieldMs || 40, alts, altSlack: 12, deadline });
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
		if (!R0) { sim.restore(snap0); admit(new Uint8Array(0), 0, 'start'); }
		while (heap.length && Date.now() < deadline) {
			const n = pop();
			if (n.dead) continue;
			if (best && n.g + 1 >= best.T) continue;
			out.expanded++;
			sim.restore(n.snap);
			const plainNode = !!S.plainStart(sim);
			if (trace) trace({ ev: 'expand', g: n.g, c: n.c, f: n.f, key: n.key, from: n.from, tile: T.tileOf(sim, W, H), vx: sim.speed_x, vy: sim.speed_y });
			// THE DIRECT LEG near the target
			if (n.c <= D) {
				const lim = best ? Math.min(120, best.T - n.g - 1) : 120;
				if (lim > 0) {
					stats.directs++; out.legs++;
					const tp = Date.now();
					const r = S.leg(n.snap, tgt, Object.assign(legOpts(lim, plainNode), { alts: 0, fields: true, coupled: true, coupledTicks: 60000, fieldMs: 100 }));
					prof.direct += Date.now() - tp;
					if (r.ok) {
						stats.directOk++;
						setBest(n.g + r.T, cat(n.masks, r.masks));
						if (o.first) break;
						continue;
					}
				}
			}
			sim.restore(n.snap);
			// (a grounded plain node: M spans; an airborne or field node (a launch, a field's inside): the best one, its
			// fans do the rest)
			const grounded = plainNode && sim.on_ground;
			const inField = !plainNode && clsOf(sim) !== 'A' && clsOf(sim) !== 'G';
			const cor = corridorOf(G, sim, n.c - delta, w, grounded ? M : Ma, RX, RU, RD, grounded ? Mu : 0, inField);
			// THE SUB-LEGS: msolve.leg to each of the best corridor spans, then the nearest uphill / level spans (the repair)
			let tp = Date.now(), got = 0;
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
			if (!fanOn || Date.now() >= deadline) continue;
			// MSOLVE'S CHEAP FANS: the forward fan-out toward the corridor (one x change) and the event fan (every held mask to
			// its first support event, with its timed stops inside a field: the ways the footholds do not see)
			const kids = [];
			tp = Date.now();
			if (plainNode) {
				const aim = cor.spans.length ? [].concat(...cor.spans.map((s) => s.tiles)) : tgt.tiles;
				const lands = S.landings(n.snap, { Tmax: 60, K: 1, max: 12, toward: { tiles: aim }, nodes: 10000, deadline });
				for (const e of lands) { kids.push(e.masks); if (e.hop) kids.push(e.hop); }
			}
			prof.land += Date.now() - tp;
			tp = Date.now();
			for (const p0 of [0, 1]) for (const m0 of MS.DIR9) {
				sim.restore(n.snap);
				const c00 = clsOf(sim);
				let air = !sim.on_ground || sim.speed_y !== 0;
				const ms = [];
				for (let t = 0; t < fanT; t++) {
					const px = sim.px, py = sim.py;
					const mk = t === 0 ? (m0 | p0) : m0;
					E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
					if (sim.is_dead) break;
					const c1 = clsOf(sim);
					const tele = Math.abs(sim.px - px) > 20 || Math.abs(sim.py - py) > 20;
					if (tele || (c1 !== c00 && c1 !== 'A') || (sim.on_ground && air && t > 0)) { kids.push(Uint8Array.from(ms)); break; }
					if (!plainNode && (t + 1 === 8 || t + 1 === 20 || t + 1 === 40)) kids.push(Uint8Array.from(ms));
					if (!sim.on_ground) air = true;
				}
			}
			prof.fan += Date.now() - tp;
			tp = Date.now();
			let k = 0;
			for (const ms of kids) {
				if (!play(n.snap, ms)) continue;
				if (admit(cat(n.masks, ms), n.g + ms.length, 'fan')) k++;
			}
			prof.admit += Date.now() - tp;
			if (trace) trace({ ev: 'kids', kids: kids.length, admitted: k, got });
			if (o.probe) break;
		}
		out.prof = prof;
		out.ms = Date.now() - t0;
		if (best) { out.ok = true; out.masks = best.masks; out.T = best.T; }
		else out.why = heap.length ? 'budget' : 'exhausted';
		if (o.resume) {
			// (kept while it can still give something: an open node)
			if (heap.length && !best) {
				keep.set(o.resume, { nodes, seen, heap, best, w, bestC: out.bestC, bestCg: out.bestCg });
				while (keep.size > KEEP) keep.delete(keep.keys().next().value);
			} else keep.delete(o.resume);
		}
		return out;
	}
	const keep = new Map();
	return { solve, geometry, corridorOfForTest: corridorOf, stats: () => Object.assign({}, stats), solver: S };
}

module.exports = { createCorridor, KAPPA };
