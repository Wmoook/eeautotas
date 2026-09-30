'use strict';
// THE EXECUTOR (n4plan, the compiler's MOVES stage, part 'executor'): from REAL engine states (Arrivals) to a waypoint
// (types.js Waypoint: a trigger touched with its Expect, a region, the trophy), with legs PROVEN optimal where the exact
// search finishes; the compiler's code generation. No search tool of the old paradigm (goexplore, bursts, heat, eegpu):
// every leg is the engine's own simulation, every arrival replayed from the level start before it is returned.
//
//   exec = await createExecutor(L, {file, workers, prims, bounds, model, RM, emit, seed}) ->
//     {reach(starts, wp, budget) -> Promise<StepResult>, polish(masks, o) -> Promise<{masks, runTicks, saved, legs}>,
//      stats(), close()}
//
// reach(): the tiers (the budget: {ms, level (the rung 0..3), k (arrivals, default 4), stop, deadline}; it returns
// within budget.ms + 200 ms ALWAYS: the worker's own clock stops at the deadline less a margin, and a watchdog answers
// 'budget' and replaces the worker when it does not):
//   0. the proof pre-check: the RCH3 field of the level as the doors stand at each start (types.js levelNow + goalField,
//      physics mode only) -1 at EVERY start = a proof that the goal cannot be reached while the doors stay as they are
//      (fail 'proof', blockedBy = the shut gates the all-open field's way crosses);
//   1. the primitives (opts.prims: prims.route) when given;
//   2. EXACT (exact.js solveExact): the breadth-first branch and bound over absolute ticks from every start (exact dedup,
//      the admissible bound, deaths dropped unless wp.allowDeath, the -1 cut): the first goal = the proven minimum;
//   3. LEG (legs.js): the finders, not proofs: legBest (the default) a best-first search (f = tick + 2.5 x the time
//      estimate: the admissible kinematic bound near the goal, else the goal field's distance at the running pace, or the
//      primitives' tick field when opts.bounds is given) over fine cells (1 px, 2 px, 1/16, 1/8, the door-reading state:
//      the first arrival closes a cell); legBFS (EEAT_EXEC_LEG=beam; 'mix': best-first then the beam bounded by it) a
//      time-layered widening beam that keeps the fastest state per cell, ranked the same way, at most 8 states a tile;
//   2b. EXACT again with the leg's ticks as the budget (maxDepth = its absolute tick - 1): a shorter leg (proven the
//      minimum) or a proof that the leg is optimal;
//   the goal states of the successful tier (up to 4 k) -> T.pickDiverse (the earliest, the fastest, one per class).
//   Every leg found is taught to the primitives (prims.learn) when they exist. On failure a FailReport from the nearest
//   state any tier saw (the goal field's distance): why, closest {masks, tile, dist, vx, vy}, touched (the triggers its
//   way touched), blockedBy (shut gates within 2 tiles of it on the all-open field's way), level.
// WORKERS: every reach() / polish() runs in a worker thread (execworker.js; opts.workers, default min(4, cpus - 1),
// workers 0 = in-process); each worker loads the level once from opts.file and must replay a fixed input sequence to the
// same state hashes as this thread's L (else the executor runs in-process); arrivals cross threads as mask strings and
// are rebuilt (replayed, verified, T.arrivalOf with opts.RM) in this thread.
const os = require('os');
const path = require('path');
const E = require('../eesim.js');
const RF = require('../reach.js');
const T = require('./types.js');
const X = require('./exact.js');
const LG = require('./legs.js');

const VERIFY_MARGIN_MS = 60;    // the worker's clock ends this much before the deadline (this thread's replays)
const WATCHDOG_MS = 150;        // past the deadline + this, an unanswered worker call is answered 'budget'
const REPLAY_CACHE = 64;
const K_DEFAULT = 4;
const LEG_MODE = () => { const m = String(process.env.EEAT_EXEC_LEG || 'best'); return m === 'beam' || m === 'mix' ? m : 'best'; };
const BASE_FEATS = ['key0', 'key1', 'key2', 'key3', 'key4', 'key5', 'team', 'coins', 'bcoins', 'crown', 'silver', 'deaths', 'cp', 'fx', 'prot'];

// ================================================================ the core (one thread: a worker, or in-process)
/**
 * makeCore(L, co) -> {reach(startStrs, wp, budget) -> Promise<result with mask strings>, polish(str, o), stats}
 * co: {prims (a primitives object of THIS thread, or null), bounds (this thread's, or null), model (this thread's, or
 * null)}. budget: {ms, level, k, deadline, stop}.
 */
function makeCore(L, co) {
	co = co || {};
	const W = L.width, H = L.height, N = W * H;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const cache = new Map();
	const st = { calls: 0, ok: 0, fail: 0, byTool: {}, byWhy: {}, sims: 0, ms: 0, proven: 0 };
	const fieldMs = { n: 0, perTile: 0 };
	let analysis = null;

	/** the state after a masks string (a cached replay: the longest cached prefix, then the rest) */
	function startOf(str) {
		let e = cache.get(str);
		if (e) { cache.delete(str); cache.set(str, e); return e; }
		let from = null;
		for (const [k, v] of cache) if (k.length < str.length && (from === null || k.length > from.tick) && str.startsWith(k)) from = v;
		const masks = T.masksOf(str);
		let dead = false, deadAt = -1;
		if (from) sim.restore(from.snap); else sim.reset();
		for (let t = from ? from.tick : 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			if (sim.is_dead && deadAt < 0) deadAt = t + 1;
		}
		dead = !!sim.is_dead;
		e = { str, masks, tick: masks.length, snap: sim.snapshot(), dead, deadAt: from && from.deadAt >= 0 ? from.deadAt : deadAt, disc: X.discKey(sim), hash: sim.stateHash() };
		cache.set(str, e);
		if (cache.size > REPLAY_CACHE) cache.delete(cache.keys().next().value);
		return e;
	}
	/** the goal field of the level as the doors stand in the state now in sim (memoized in types.js) */
	function fieldNow(goal, allowDeath) {
		const Lc = T.levelNow(L, sim);
		const t0 = Date.now();
		const f = T.goalField(Lc, goal.tiles, { deaths: allowDeath });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		return f;
	}
	/** a field build expected to fit the time left (an unknown level: yes) */
	const fieldFits = (left) => fieldMs.n === 0 || fieldMs.perTile * N < 0.4 * left;
	function steerA() {
		if (analysis) return analysis;
		try { analysis = require('../steer.js').analyze(L); } catch (e) { analysis = { cls: new Uint8Array(N), gateFeat: [] }; }
		return analysis;
	}

	async function reach(startStrs, wp, budget) {
		const tIn = Date.now();
		budget = budget || {};
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + (budget.ms > 0 ? budget.ms : 3000));
		const wEnd = deadline - VERIFY_MARGIN_MS;
		const stop = typeof budget.stop === 'function' ? budget.stop : null;
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		const rung = budget.level | 0;
		const goal = T.goalOf(L, wp);
		const allowDeath = !!wp.allowDeath;
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		st.calls++;
		let sims = 0;
		const tiers = [];
		const out = (r) => {
			r.ms = Date.now() - tIn; r.sims = sims; r.tiers = tiers;
			st.ms += r.ms; st.sims += sims;
			if (r.ok) { st.ok++; st.byTool[r.tool] = (st.byTool[r.tool] || 0) + 1; if (r.legs && r.legs.some((l) => l.proven)) st.proven++; }
			else { st.fail++; st.byWhy[r.fail.why] = (st.byWhy[r.fail.why] || 0) + 1; }
			return r;
		};
		const starts = startStrs.map((s) => startOf(String(s)));
		const t0 = Math.min(...starts.map((s) => s.tick));
		// (a start already at the goal: that start is the arrival, 0 ticks)
		const here = [];
		starts.forEach((s, i) => { sim.restore(s.snap); if (!s.dead && X.goalAt(goal, sim, s.tick, beforeTick)) here.push(i); });
		if (here.length) {
			const cands = here.map((i) => ({ start: i, tail: new Uint8Array(0), depth: starts[i].tick - t0 }));
			const r = finishFound(cands, 'exact', here.map((i) => ({ start: i, ticks: 0, lb: 0, proven: true, tool: 'exact' })), 0);   // (0 ticks: the exact search's depth 0)
			if (r) return out(r);
		}
		const live = starts.filter((s) => allowDeath || !s.dead);
		if (!live.length) return out(failResult('dies', null, 'every start is dead', rung, starts, goal, { deadline }));
		// -------- tier 0: the proof pre-check (and the goal fields for the cuts and the distances)
		let field0 = null, proofAll = true, anyField = false;
		const fields = new Map();   // disc -> field
		const startCost = [];
		for (const s of starts) {
			sim.restore(s.snap);
			let f = fields.get(s.disc);
			if (f === undefined) {
				f = fieldFits(wEnd - Date.now()) ? fieldNow(goal, allowDeath) : null;
				fields.set(s.disc, f);
			}
			if (f === null) { proofAll = false; startCost.push(-2); continue; }
			anyField = true;
			if (field0 === null) field0 = f;
			const c = RF.costAt(f, sim);
			startCost.push(c);
			if (!(c < 0 && f.mode !== 'walk')) proofAll = false;
		}
		tiers.push({ tier: 'proof', ms: Date.now() - tIn, proof: anyField && proofAll });
		if (anyField && proofAll) return out(proofFail(starts[0], goal, wp, rung, 'the goal field of the level as the doors stand is -1 at every start', deadline));
		const disc0 = starts[0].disc;
		const sameDisc = starts.every((s) => s.disc === disc0);
		const cutField = sameDisc && field0 && field0.mode !== 'walk' ? field0 : null;
		const snaps = starts.map((s) => ({ snap: s.snap, tick: s.tick }));
		const stopFn = () => (stop !== null && stop());
		let closest = { dist: -1, masks: null };
		const noteClosest = (dist, sIdx, tail) => {
			if (!(dist >= 0) || tail === null || sIdx < 0) return;
			if (closest.dist < 0 || dist < closest.dist) closest = { dist, masks: T.concat(starts[sIdx].masks, tail) };
		};
		// -------- tier 1: the primitives
		if (co.prims && typeof co.prims.route === 'function' && Date.now() < wEnd) {
			const t1 = Date.now();
			try {
				const pEnd = t1 + 0.5 * (wEnd - t1);
				const arr = live.map((s) => { sim.restore(s.snap); return T.arrivalOf(L, sim, s.masks, null); });
				const nr = await co.prims.route(arr, goal, { ms: pEnd - t1, deadline: pEnd, stop: stopFn, k }, { allowDeath, beforeTick });
				sims += (nr && nr.sims) || 0;
				tiers.push({ tier: 'prims', ms: Date.now() - t1, ok: !!(nr && nr.ok) });
				if (nr && nr.ok && nr.arrivals && nr.arrivals.length) {
					const cands = [];
					for (const a of nr.arrivals) {
						const m = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
						const si = starts.findIndex((s) => m.length >= s.tick && T.strOf(m.subarray(0, s.tick)) === s.str);
						if (si >= 0) cands.push({ start: si, tail: m.slice(starts[si].tick), depth: m.length - t0 });
					}
					const legsP = cands.length ? [{ start: cands[0].start, ticks: cands[0].tail.length, lb: nr.lb >= 0 ? nr.lb : 0, proven: !!nr.proven, tool: 'prims' }] : [];
					const r = finishFound(cands, 'prims', legsP, nr.lb >= 0 ? nr.lb : 0);
					if (r) return out(r);
				}
				if (nr && nr.closest && nr.closest.masks) {
					const m = nr.closest.masks instanceof Uint8Array ? nr.closest.masks : T.masksOf(nr.closest.masks);
					if (closest.dist < 0 || (nr.closest.dist >= 0 && nr.closest.dist < closest.dist)) closest = { dist: nr.closest.dist >= 0 ? nr.closest.dist : 1e9, masks: m };
				}
			} catch (e) { tiers.push({ tier: 'prims', error: String(e && e.message || e) }); }
		}
		// -------- tier 2: the exact search, short (iterative deepening)
		const cap = rung <= 0 ? 150000 : rung === 1 ? 250000 : 300000;
		const baseX = { sim, allowDeath, beforeTick, bounds: co.bounds || null, field: cutField, discKey: X.discKey, disc0, stop: stopFn, cap };
		let lbAbs = 0, exactProof = false, legTime = false;
		let found = null;   // {cands, tool, proven, lbAbs}
		{
			const t2 = Date.now();
			const xEnd = t2 + 0.35 * (wEnd - t2);
			const track = { dist: undefined };
			const r = X.solveExact(L, snaps, goal, Object.assign({}, baseX, { deadline: xEnd, track, distField: field0 }));
			sims += sumTicks(r);
			lbAbs = Math.max(lbAbs, r.lb || 0);
			tiers.push({ tier: 'exact', ms: Date.now() - t2, status: r.status, lb: r.lb, runs: r.runs });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else {
				if (r.exhausted) exactProof = true;
				if (track.layer >= 0 && r.layers) { const p = X.pathOfKept(r.layers, track.layer, track.idx, snaps, r.t0); if (p) noteClosest(track.dist, p.start, p.tail); }
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- tier 3: the fine-cell leg search
		if (!found && !exactProof && Date.now() < wEnd - 5) {
			// (the finders: the best-first search dives (the first leg, soonest), then the time-layered beam bounded by it
			// (a faster leg of the same kind); LEG_MODE 'beam' / 'best' (env EEAT_EXEC_LEG) for measurements)
			const region = regionOf(field0, starts, goal);
			const depthMax = beforeTick >= 0 ? beforeTick - t0 : 4000;
			const runBeam = (end, dmax) => LG.legBFS(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null,
				width0: 300, widthMax: 80000, depthMax: dmax, stall: 150 + 100 * rung });
			const runBest = (end) => LG.legBest(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null, depthMax, w: +process.env.EEAT_BEST_W || 0, cell: process.env.EEAT_BEST_CELL ? process.env.EEAT_BEST_CELL.split(",").map(Number) : null });
			const mode = LEG_MODE();
			const t3 = Date.now();
			let r = mode === 'beam' ? runBeam(wEnd - 3, depthMax) : runBest(mode === 'best' ? wEnd - 3 : t3 + 0.7 * (wEnd - t3));
			sims += r.sims;
			tiers.push({ tier: mode === 'beam' ? 'leg' : 'best', ms: Date.now() - t3, status: r.status, passes: r.passes });
			if (mode === 'mix' && r.status !== 'stopped' && Date.now() < wEnd - 5) {
				const ub = r.status === 'found' ? Math.min(...r.goals.map((c) => c.depth)) : depthMax + 1;
				if (ub > 1) {
					const t5 = Date.now();
					const r2 = runBeam(r.status === 'found' ? t5 + 0.5 * (wEnd - t5) : wEnd - 3, ub - 1);
					sims += r2.sims;
					tiers.push({ tier: 'leg', ms: Date.now() - t5, status: r2.status, passes: r2.passes });
					if (r2.status === 'found' || r.status !== 'found') { if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail); r = r2; }
				}
			}
			if (r.status === 'found') found = { cands: r.goals, tool: 'leg', proven: false, lbAbs };
			else {
				if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail);
				if (r.status === 'time' || r.status === 'depth') legTime = true;
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- the leg found made shorter: polish.js polishLeg (exact windows from its end back: the waypoint sooner, the
		// leg's own state region sooner, exact rejoins; every change replayed from the start)
		if (found && found.tool === 'leg' && Date.now() < wEnd - 20 && process.env.EEAT_LEG_POLISH !== '0') {
			const t6 = Date.now();
			const c0 = found.cands.reduce((m, c) => (c.depth < m.depth ? c : m), found.cands[0]);
			const PO = require('./polish.js');
			const pl = PO.polishLeg(L, snaps[c0.start], c0.tail, goal, { sim, deadline: t6 + 0.6 * (wEnd - t6), allowDeath, beforeTick, stop: stopFn });
			tiers.push({ tier: 'leg-polish', ms: Date.now() - t6, saved: pl.saved, windows: pl.windows });
			if (pl.saved > 0) found.cands.unshift({ start: c0.start, tail: pl.tail, depth: c0.depth - pl.saved });
		}
		// -------- tier 2b: the exact search bounded by the leg found (a shorter leg, or a proof that it is optimal)
		if (found && found.tool === 'leg' && Date.now() < wEnd - 5) {
			const t4 = Date.now();
			const ub = Math.min(...found.cands.map((c) => c.depth));
			const r = X.exactLeg(L, snaps, goal, Object.assign({}, baseX, { maxDepth: ub - 1, deadline: wEnd - 2 }));
			sims += r.stats.ticks;
			tiers.push({ tier: 'exact-ub', ms: Date.now() - t4, status: r.status, maxDepth: ub - 1 });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else if (r.status === 'proof') { found.proven = true; found.lbAbs = ub; }
		}
		if (found) {
			const minDepth = Math.min(...found.cands.map((c) => c.depth));
			const legs = [];
			const r = finishFound(found.cands, found.tool, null, found.proven ? minDepth : lbAbs, found.proven, minDepth);
			if (r) {
				// (teach the primitives every leg found: the move they lacked, derived from the physics)
				if (co.prims && typeof co.prims.learn === 'function' && found.tool !== 'prims') {
					try { for (const a of r.arrivalsRaw) { const s = starts[a.start]; sim.restore(s.snap); const from = T.arrivalOf(L, sim, s.masks, null); co.prims.learn(from, a.tail, a.arrival); } } catch (e) { /* optional */ }
				}
				delete r.arrivalsRaw;
				return out(r);
			}
			void legs;
		}
		const why = exactProof ? 'exhausted' : (legTime || Date.now() >= wEnd - 5 ? 'budget' : 'exhausted');
		return out(failResult(why, closest, null, rung, starts, goal, { lbAbs, startCost, deadline }));

		// ---------------------------------------------------------------- the pieces
		/** a result from goal candidates {start, tail, depth}: arrivals built, verified from the level start, picked */
		function finishFound(cands, tool, legsIn, lbA, proven, minDepth) {
			const arr = [];
			const seenH = new Set();
			for (const c of cands.slice(0, 4000)) {
				const s = starts[c.start];
				sim.restore(s.snap);
				for (let t = 0; t < c.tail.length; t++) { E.applyMask(inp, c.tail[t]); sim.tick(inp); }
				const masks = T.concat(s.masks, c.tail);
				const a = T.arrivalOf(L, sim, masks, null);
				if (seenH.has(a.hash)) continue;
				seenH.add(a.hash);
				a._c = c;
				arr.push(a);
				if (Date.now() > deadline - 20 && arr.length >= 1) break;
			}
			const picked = T.pickDiverse(arr, k);
			// (a CALM arrival too: pickDiverse ranks equal ticks by |vx| + |vy|, so a jump pressed on the goal tick is its
			// "earliest" and "fastest"; the next leg from a ball launched upward can be much longer (test/planexec.js's key
			// door level: 38 ticks from the calm state, none found in 3 s from the four launched ones))
			const calm = (a) => a.vy >= -0.5;
			if (picked.length && !picked.some(calm)) {
				let best = null;
				for (const a of arr) if (calm(a) && (!best || a.tick < best.tick || (a.tick === best.tick && Math.abs(a.vx) > Math.abs(best.vx)))) best = a;
				if (best) { if (picked.length >= k) picked[picked.length - 1] = best; else picked.push(best); }
			}
			const good = [];
			for (const a of picked) {
				const c = a._c;
				if (verifyLeg(L, a.masks, goal, starts[c.start].tick, beforeTick, allowDeath)) good.push(a);
			}
			if (!good.length) return null;
			const md = minDepth !== undefined ? minDepth : Math.min(...cands.map((c) => c.depth));
			const legs = legsIn || good.map((a) => {
				const c = a._c, off = starts[c.start].tick - t0;
				return { start: c.start, ticks: c.tail.length, lb: Math.max(0, lbA - off), proven: !!proven && c.depth === md, tool };
			});
			const lb = Math.min(...starts.map((s, i) => Math.max(0, lbA - (s.tick - t0))));
			return { ok: true, arrivals: good.map((a) => ({ masks: T.strOf(a.masks), start: a._c.start, ticks: a._c.tail.length })), tool, legs, lb, fail: null,
				arrivalsRaw: good.map((a) => ({ start: a._c.start, tail: a._c.tail, arrival: a })) };
		}
	}

	/** the region of the leg search: tiles the goal field's walk reaches (dilated by a tile) in a box around the starts
	 *  and the goal */
	function regionOf(field, starts, goal) {
		let x0 = W, y0 = H, x1 = -1, y1 = -1;
		const add = (t) => { const x = t % W, y = (t / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
		for (const s of starts) { sim.restore(s.snap); add(T.tileOf(sim, W, H)); }
		for (const t of goal.tiles) add(t);
		const M = +process.env.EEAT_REGION_M || 24;   // (tiles around the starts and the goal; env: measurements)
		x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(W - 1, x1 + M); y1 = Math.min(H - 1, y1 + M);
		const reg = new Uint8Array(N);
		const walk = field && field.walk ? field.walk : null;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const t = y * W + x;
			if (walk === null || walk[t] !== RF.CUT) { reg[t] = 1; continue; }
			// (a tile next to a reached one: the centre in a half block's tile, a door's edge)
			for (let dy = -1; dy <= 1 && !reg[t]; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < W && yy < H && walk[yy * W + xx] !== RF.CUT) { reg[t] = 1; break; }
			}
		}
		// (the starts' own tiles always)
		for (const s of starts) { sim.restore(s.snap); reg[T.tileOf(sim, W, H)] = 1; }
		return reg;
	}

	/** a FailReport result: the closest state's details, the triggers its way touched, the gates blocking it */
	function failResult(why, closest, note, rung, starts, goal, extra) {
		const fail = { why, closest: null, touched: [], blockedBy: [], level: rung | 0, note: note || null };
		const dl = extra && extra.deadline ? extra.deadline : Infinity;
		if (closest && closest.masks && starts && goal) {
			const c = describe(closest.masks, closest.dist, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		} else if (starts && starts.length && goal) {
			// (no nearer state than the start: the start itself, by the all-open field)
			const c = describe(starts[0].masks, -1, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		}
		const r = { ok: false, arrivals: [], tool: null, legs: [], lb: extra && extra.lbAbs >= 0 ? extra.lbAbs : 0, fail };
		if (fail.closest) fail.closest.masks = T.strOf(fail.closest.masks);
		return r;
	}
	function proofFail(start, goal, wp, rung, note, dl) {
		const r = failResult('proof', null, note, rung, [start], goal, { deadline: dl });
		// (the proof's blockedBy: every shut gate on the all-open field's way from the start, not only near it)
		sim.restore(start.snap);
		r.fail.blockedBy = blockedOnWay(goal, sim, Infinity, wp.allowDeath, dl);
		return r;
	}
	/** the all-open goal field (the level itself: every door a door, open), when it is built already or fits the time */
	const plainBuilt = new Set();
	function plainField(goal, allowDeath, dl) {
		const key = `${Array.from(goal.tiles).join(',')}|${allowDeath ? 1 : 0}`;
		if (!plainBuilt.has(key) && !fieldFits(dl - Date.now())) return null;
		const t0 = Date.now();
		const f = T.goalField(L, goal.tiles, { deaths: !!allowDeath });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		plainBuilt.add(key);
		return f;
	}
	/** the closest state's report: replay its masks (the touched triggers since the leg's start), its tile, speed,
	 *  distance, and the gates blocking it */
	function describe(masks, dist, starts, goal, dl) {
		const s0 = starts[0];
		// (the start the masks extend: the longest start prefix)
		let si = 0;
		for (let i = 0; i < starts.length; i++) if (masks.length >= starts[i].tick && T.strOf(masks.subarray(0, starts[i].tick)) === starts[i].str) { si = i; break; }
		const s = starts[si] || s0;
		sim.restore(s.snap);
		const touched = [];
		const fv = featsOf(sim);
		for (let t = s.tick; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			const f2 = featsOf(sim);
			for (const [k, v] of f2) if (fv.get(k) !== v) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: v });
			for (const k of fv.keys()) if (!f2.has(k)) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: 0 });
			fv.clear(); for (const [k, v] of f2) fv.set(k, v);
		}
		const tile = T.tileOf(sim, W, H);
		let d = dist;
		if (!(d >= 0)) {
			try { const f = plainField(goal, false, dl); if (f) { const c = RF.costAt(f, sim); d = c < 0 ? -1 : c; } else d = -1; } catch (e) { d = -1; }
		}
		const closest = { masks, tile, dist: d, vx: sim.speed_x, vy: sim.speed_y, px: sim.px, py: sim.py, dead: !!sim.is_dead };
		const blockedBy = blockedOnWay(goal, sim, 2, false, dl);
		return { closest, touched: touched.slice(0, 64), blockedBy };
	}
	/**
	 * The gates (steer.js analyze: cls 3 with a feature) SHUT in the state in sim (is_tile_solid_now) on the all-open
	 * field's way from its tile to the goal (the RCH3 field of the level itself, every door open: its walk, descended), within
	 * `near` tiles (Chebyshev) of the state's tile (Infinity: all of them on the way).
	 */
	function blockedOnWay(goal, s, near, allowDeath, dl) {
		const A = steerA();
		let f;
		try { f = plainField(goal, allowDeath, dl === undefined ? Infinity : dl); } catch (e) { return []; }
		if (!f) return [];
		const walk = f.walk;
		if (!walk) return [];
		const t0 = T.tileOf(s, W, H);
		const x0 = t0 % W, y0 = (t0 / W) | 0;
		const out = [], got = new Set();
		const gateAt = (t) => {
			if (A.cls[t] !== 3) return;
			const feat = A.gateFeat[t];
			if (!feat || feat === 'static' || feat === 'open') return;
			const x = t % W, y = (t / W) | 0;
			if (Math.max(Math.abs(x - x0), Math.abs(y - y0)) > near) return;
			if (!s.is_tile_solid_now(x, y) || got.has(t)) return;
			got.add(t); out.push({ tile: t, feat, x, y });
		};
		// the way: the steepest descent of the walk from the tile (8-way), and the gates next to it
		let t = t0;
		if (walk[t] === RF.CUT) {
			// (the state's tile has no walk value: the nearest neighbour that has one)
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x0 + dx, yy = y0 + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (walk[j] !== RF.CUT && (bt < 0 || walk[j] < walk[bt])) bt = j; }
			if (bt < 0) return out;
			t = bt;
		}
		for (let steps = 0; steps < N && walk[t] > 0; steps++) {
			gateAt(t);
			const x = t % W, y = (t / W) | 0;
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (walk[j] !== RF.CUT && walk[j] < walk[t] && (bt < 0 || walk[j] < walk[bt])) bt = j;
			}
			if (bt < 0) break;   // (a portal: the way goes on at an exit the descent does not follow)
			t = bt;
		}
		gateAt(t);
		return out;
	}
	function featsOf(s) {
		const m = new Map();
		for (const f of (co.model && co.model.feats) || BASE_FEATS) { const v = T.featValue(s, f); if (!Number.isNaN(v)) m.set(f, v); }
		for (const [k, v] of s._switches) if (v === true) m.set(`psw:${k}`, 1);
		for (const [k, v] of s._oswitches) if (v === true) m.set(`osw:${k}`, 1);
		return m;
	}

	async function polish(str, o) {
		const P = require('./polish.js');
		return P.polishRoute(L, T.masksOf(str), Object.assign({}, o, { core: true }));
	}
	return { reach, polish, stats: () => Object.assign({}, st), startOf, L };
}
const sumTicks = (r) => (r && r.runs ? r.runs.reduce((a, x) => a + (x.ticks || 0), 0) : r && r.stats ? r.stats.ticks : 0);

/**
 * The leg's check, a replay from the level start: no death after the start tick (unless allowDeath), the goal test true
 * at the end with the ball alive (and at a tick <= beforeTick), and not before in the leg (the arrival is the leg's FIRST
 * goal state). (types.js playTo(...).goalAt === masks.length is the same test when the start's own masks never held the
 * goal: CONTRACT REQUEST in the report.)
 */
function verifyLeg(L, masks, goal, startTick, beforeTick, allowDeath) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const u = t + 1;
		if (u <= startTick) continue;
		if (sim.is_dead && !allowDeath) return null;
		if (u < n && !sim.is_dead && (beforeTick < 0 || u <= beforeTick) && goal.test(sim)) return null;
	}
	return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || n <= beforeTick) ? sim : null;
}

/** a fixed input sequence's state hashes (the worker's level = this thread's level?) */
function fingerprint(L) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let x = 0x2545f491;
	const out = [L.width, L.height];
	for (let t = 1; t <= 400; t++) {
		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		E.applyMask(inp, (x >>> 0) % 18 === 17 ? 0 : [0, 1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 16, 17, 18, 20, 21, 6, 7][(x >>> 0) % 18] & 31);
		sim.tick(inp);
		if (t % 100 === 0) out.push(sim.stateHash());
	}
	return out.join(',');
}

// ================================================================ the main thread's executor
/** the Waypoint as plain data (it crosses threads) */
const wpData = (wp) => ({ kind: wp.kind, tiles: wp.tiles ? Array.from(wp.tiles) : [], trig: wp.trig, expect: wp.expect ? { feat: wp.expect.feat, value: wp.expect.value } : null,
	label: wp.label || '', allowDeath: !!wp.allowDeath, beforeTick: wp.beforeTick >= 0 ? wp.beforeTick : -1 });

async function createExecutor(L, opts) {
	opts = opts || {};
	const emit = typeof opts.emit === 'function' ? opts.emit : null;
	let nW = opts.workers === undefined || opts.workers === null ? Math.max(0, Math.min(4, os.cpus().length - 1)) : Math.max(0, opts.workers | 0);
	const note = [];
	if (nW > 0 && !opts.file) { note.push('no level file: the executor runs in-process'); nW = 0; }
	const core = makeCore(L, { prims: opts.prims || null, bounds: opts.bounds || null, model: opts.model || null });
	const RM = opts.RM || null;
	const S = { reach: 0, ok: 0, fail: 0, watchdog: 0, verifyDrop: 0, polish: 0, byTool: {}, byWhy: {}, ms: 0, sims: 0 };
	// ---- the pool
	const pool = [];
	let Worker = null;
	const queue = [];
	let jobId = 0;
	const spawn = (i) => {
		const w = new Worker(path.join(__dirname, 'execworker.js'), { workerData: { file: path.resolve(String(opts.file)), usePrims: !!opts.prims, useBounds: !!opts.bounds, seed: opts.seed | 0 } });
		const slot = { w, busy: null, i, dead: false };
		w.on('message', (msg) => {
			const job = slot.busy;
			if (!job || msg.id !== job.id) return;
			slot.busy = null;
			job.done(msg);
			pump();
		});
		w.on('error', (e) => { const job = slot.busy; slot.busy = null; slot.dead = true; if (job) job.done({ id: job.id, error: String(e && e.message || e) }); replace(slot); });
		w.on('exit', () => { if (!slot.dead) { slot.dead = true; const job = slot.busy; slot.busy = null; if (job) job.done({ id: job.id, error: 'the worker exited' }); replace(slot); } });
		w.unref();
		return slot;
	};
	const replace = (slot) => {
		if (closed) return;
		const k = pool.indexOf(slot);
		if (k >= 0) pool[k] = spawn(slot.i);
		pump();
	};
	let closed = false;
	if (nW > 0) {
		Worker = require('worker_threads').Worker;
		for (let i = 0; i < nW; i++) pool.push(spawn(i));
		// the workers' level must be this one: the same state hashes after a fixed input sequence
		const fp = fingerprint(L);
		const res = await Promise.all(pool.map((slot) => call(slot, { type: 'fp' }, Date.now() + 60000)));
		if (res.some((r) => !r || r.error || r.fp !== fp)) {
			note.push(`the workers' level differs from this one (${res.map((r) => (r && r.error) || (r && r.fp === fp ? 'same' : 'differs')).join(', ')}): the executor runs in-process`);
			for (const slot of pool) { slot.dead = true; try { slot.w.terminate(); } catch (e) { /* gone */ } }
			pool.length = 0; nW = 0;
		}
	}
	if (emit && note.length) emit({ ev: 'exec.note', note });
	/** a job on a given worker slot (its answer, or {error}) */
	function call(slot, msg, deadline, stopFlag) {
		return new Promise((resolve) => {
			const id = ++jobId;
			let settled = false;
			const done = (m) => { if (settled) return; settled = true; clearTimeout(timer); resolve(m); };
			slot.busy = { id, done };
			slot.w.postMessage(Object.assign({ id, stopFlag }, msg));
			const timer = setTimeout(() => {
				if (settled) return;
				S.watchdog++;
				// (the worker did not answer in time: answer 'budget' and replace it)
				done({ id, error: 'watchdog', watchdog: true });
				slot.dead = true; slot.busy = null;
				try { slot.w.terminate(); } catch (e) { /* gone */ }
				replace(slot);
			}, Math.max(10, deadline - Date.now()) + WATCHDOG_MS);
		});
	}
	function pump() {
		while (queue.length) {
			const slot = pool.find((s) => !s.busy && !s.dead);
			if (!slot) return;
			const q = queue.shift();
			if (Date.now() > q.deadline - VERIFY_MARGIN_MS) { q.resolve({ id: 0, error: 'queue', queued: true }); continue; }
			call(slot, q.msg, q.deadline, q.stopFlag).then(q.resolve);
		}
	}
	function dispatch(msg, deadline, stopFlag) {
		return new Promise((resolve) => { queue.push({ msg, deadline, stopFlag, resolve }); pump(); });
	}

	async function reach(starts, wp, budget) {
		const tIn = Date.now();
		budget = budget || {};
		const ms = budget.ms > 0 ? budget.ms : 3000;
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + ms);
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		S.reach++;
		const startStrs = starts.map((a) => (typeof a === 'string' ? a : T.strOf(a.masks)));
		const w = wpData(wp);
		let res;
		if (nW === 0) {
			try { res = await core.reach(startStrs, w, { ms, level: budget.level | 0, k, deadline, stop: budget.stop }); }
			catch (e) { res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: `error: ${e && e.message || e}` } }; }
		} else {
			const sab = new SharedArrayBuffer(4), flag = new Int32Array(sab);
			let poll = null;
			if (typeof budget.stop === 'function') poll = setInterval(() => { try { if (budget.stop()) Atomics.store(flag, 0, 1); } catch (e) { /* ignore */ } }, 20);
			const msg = await dispatch({ type: 'reach', starts: startStrs, wp: w, budget: { ms, level: budget.level | 0, k, deadline } }, deadline, sab);
			if (poll) clearInterval(poll);
			if (msg.error || !msg.result) {
				const why = Atomics.load(flag, 0) ? 'stopped' : 'budget';
				res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why, closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: msg.error || 'no answer' } };
			} else res = msg.result;
		}
		return finalize(res, starts, wp, tIn);
	}
	/** the StepResult of a core result: every arrival replayed from the level start in THIS thread (verified: the goal
	 *  first holds at its end, alive, beforeTick), an Arrival with this thread's snapshot and opts.RM's room */
	function finalize(res, starts, wp, tIn) {
		const goal = T.goalOf(L, wp);
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		const out = { ok: false, arrivals: [], tool: res.tool || null, ms: 0, sims: res.sims || 0, legs: res.legs || [], lb: res.lb || 0, fail: res.fail || null, tiers: res.tiers };
		if (res.ok) {
			for (const a of res.arrivals) {
				const masks = T.masksOf(a.masks);
				const st = starts[a.start];
				const startTick = st && st.masks ? st.masks.length : (typeof st === 'string' ? st.length : 0);
				const vs = verifyLeg(L, masks, goal, startTick, beforeTick, !!wp.allowDeath);
				if (!vs) { S.verifyDrop++; continue; }
				const arr = T.arrivalOf(L, vs, masks, RM);
				arr.leg = { start: a.start, ticks: a.ticks, tool: res.tool };
				out.arrivals.push(arr);
			}
			if (out.arrivals.length) out.ok = true;
			else { out.tool = null; out.fail = { why: 'budget', closest: null, touched: [], blockedBy: [], level: 0, note: 'no arrival survived the replay' }; }
		}
		if (out.fail && out.fail.closest && typeof out.fail.closest.masks === 'string') out.fail.closest.masks = T.masksOf(out.fail.closest.masks);
		out.ms = Date.now() - tIn;
		S.ms += out.ms; S.sims += out.sims;
		if (out.ok) { S.ok++; S.byTool[out.tool] = (S.byTool[out.tool] || 0) + 1; } else { S.fail++; const w = out.fail ? out.fail.why : '?'; S.byWhy[w] = (S.byWhy[w] || 0) + 1; }
		if (emit) emit({ ev: 'exec.reach', label: wp.label || '', ok: out.ok, tool: out.tool, ms: out.ms, sims: out.sims, legs: out.legs, lb: out.lb, why: out.fail ? out.fail.why : null });
		return out;
	}

	async function polish(masks, o) {
		o = o || {};
		S.polish++;
		const str = typeof masks === 'string' ? masks : T.strOf(masks);
		const po = { ms: o.ms > 0 ? o.ms : 30000, legs: o.legs || null, allowDeaths: o.allowDeaths !== false };
		let r;
		if (nW === 0) r = await core.polish(str, po);
		else {
			const msg = await dispatch({ type: 'polish', masks: str, o: po }, Date.now() + po.ms + 5000, new SharedArrayBuffer(4));
			r = msg && msg.result ? msg.result : null;
			if (!r) r = await core.polish(str, Object.assign({}, po, { ms: Math.min(po.ms, 2000) }));
		}
		// (never a slower or unfinished route: checked here again)
		const C = require('../common.js');
		const m0 = typeof masks === 'string' ? T.masksOf(masks) : masks;
		const ev0 = C.evaluate(L, m0, false);
		const m1 = typeof r.masks === 'string' ? T.masksOf(r.masks) : r.masks;
		const ev1 = C.evaluate(L, m1, false);
		if (!ev1 || (ev0 && (ev1.runTicks > ev0.runTicks))) return { masks: ev0 ? ev0.ms : m0, runTicks: ev0 ? ev0.runTicks : -1, saved: 0, legs: r.legs || [] };
		return { masks: ev1.ms, runTicks: ev1.runTicks, saved: ev0 ? ev0.runTicks - ev1.runTicks : 0, legs: r.legs || [], steps: r.steps };
	}
	function stats() { return Object.assign({ workers: nW, notes: note.slice(), core: nW === 0 ? core.stats() : null }, S); }
	async function close() {
		closed = true;
		for (const slot of pool) { slot.dead = true; try { await slot.w.terminate(); } catch (e) { /* gone */ } }
		pool.length = 0;
		for (const q of queue.splice(0)) q.resolve({ id: 0, error: 'closed' });
	}
	return { reach, polish, stats, close, workers: () => nW };
}

module.exports = { createExecutor, makeCore, verifyLeg, fingerprint, wpData, BASE_FEATS };
