'use strict';
// THE PERFECT PASS (n5-perfect, parts ORDER + POLISH; the compiler's EEAT_PERFECT stage, tools/perf/perfect.js offline):
// a verified route made faster, never slower, every candidate replayed by the engine (common.js evaluate + the
// acceptance rule: no more deaths, no lower random-portal chance).
//
//   (1) ORDER: BRANCH AND BOUND OVER THE TRIGGER ORDERS, the route as the incumbent. A node = verified arrivals of one
//       model state (the planner's S: the features some gate reads, the coins taken, ...), its f = its earliest tick +
//       the planner's ADMISSIBLE lower bound from it (planner.lowerBound: the lb walk relaxation, every gate its model
//       reads); nodes are expanded DEPTH FIRST from the route's end (its last join first, a node's children by the least f
//       first), a node with f >= the incumbent's finish tick is dropped (a proof: no route through it can beat the
//       incumbent). The seeds: the route's OWN states at every model-state change
//       (its trigger arrivals, the level start first), so the planner's alternatives are tried from where the route
//       really was: another next trigger, fewer triggers (a coin the route took on the way that no gate needs: the
//       trophy at once), the same trigger again from a faster state. Expanding a node: the planner's plans from it (its
//       k-best orders and the near-trigger plans), each plan's FIRST step run by the executor (exec.reach: the math tier,
//       the primitives, the exact tier, the skeleton), its arrivals replayed from the level start (the goal test, alive,
//       sooner than the incumbent's finish) and grouped by their model state into child nodes; a finish is a route
//       (the incumbent when faster, and its own states seed the queue again). A failed step is learnt by the planner
//       (CEGAR: its next plan from that node is another one); a (state, edge, rung) runs once.
//   (2) POLISH at the joins: the executor's polish (polish.js polishRoute: the mutation pass with exact rejoins, the
//       exact windows) with the route's trigger ticks as its leg marks, on whatever time the order pass leaves.
//
// perfectRoute(ctx, masks, o) -> Promise<{masks, runTicks, ticks, deaths, chance, saved, orderSaved, polishSaved, found:
//   [{how, runTicks, saved, t}], expanded, legs, pruned, seeds, ms, lb, why}>
//   ctx: {L, model, planner, exec, RM, emit?}; o: {ms (default 20000), legMs (1500), polishShare (0.35), k (3),
//   lbMs (60), maxNodes (400), polish (true), log}
const C = require('../common.js');
const E = require('../eesim.js');
const T = require('./types.js');

const LEG_MS = 1500, LEG_MS_MAX = 6000, POLISH_SHARE = 0.35, K_PLANS = 3, LB_MS = 60, LB_EXPAND = 20000, MAX_NODES = 400;
// (a leg the exact tier can bound: a room this short gets the incumbent as its beforeTick (the skeleton is off for a
// beforeTick waypoint, executor.js reachWp); a longer one runs free and its arrivals are cut here)
const BOUND_ROOM = 400;
const REEXPAND = 3;
// (EEAT_PERFECT_LOG=1: a line per leg on stderr)
const LOG = process.env.EEAT_PERFECT_LOG === '1';

/** the route's model-state changes: [{tick, masks, sim, S}] (the level start first), the replay stopped at the finish */
function routeSeeds(L, model, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const out = [];
	let S = model.stateOf(sim), key = String(S.key);
	out.push({ tick: 0, snapSim: sim.snapshot(), S });
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31); sim.tick(inp);
		if (sim.has_silver_crown) break;
		if (sim.is_dead) continue;
		const S2 = model.stateOf(sim), k2 = String(S2.key);
		if (k2 !== key) { out.push({ tick: t + 1, snapSim: sim.snapshot(), S: S2 }); key = k2; S = S2; }
	}
	return out;
}
/** the trigger ticks of a route (its model-state changes): the polish's leg marks */
function joinTicks(L, model, masks) { return routeSeeds(L, model, masks).map((s) => s.tick).filter((t) => t > 0); }

async function perfectRoute(ctx, masks0, o = {}) {
	const { L, model, planner, exec } = ctx;
	const RM = ctx.RM || null;
	const emit = typeof ctx.emit === 'function' ? ctx.emit : () => {};
	const t0 = Date.now();
	const ms = o.ms > 0 ? o.ms : 20000;
	const deadline = t0 + ms;
	const polishOn = o.polish !== false && exec && typeof exec.polish === 'function';
	const orderEnd = t0 + (polishOn ? (1 - (o.polishShare >= 0 ? o.polishShare : POLISH_SHARE)) : 1) * ms;
	const legMs0 = o.legMs > 0 ? o.legMs : LEG_MS;
	const kPlans = o.k > 0 ? o.k : K_PLANS;
	const maxNodes = o.maxNodes > 0 ? o.maxNodes : MAX_NODES;
	const log = typeof o.log === 'function' ? o.log : null;
	const ev0 = C.evaluate(L, masks0);
	if (!ev0) return { masks: masks0, runTicks: null, saved: 0, why: 'the route does not finish' };
	let best = { ms: ev0.ms, runTicks: ev0.runTicks, ticks: ev0.complete, deaths: ev0.deaths, chance: ev0.chance };
	const found = [];
	const St = { expanded: 0, legs: 0, legsOk: 0, pruned: 0, seeds: 0, arrivals: 0, lbCalls: 0, planCalls: 0, repeats: 0 };
	/** a finishing candidate: the incumbent when faster by the acceptance rule */
	const tryRoute = (m, how) => {
		const ev = C.evaluate(L, m);
		if (!ev) return false;
		if (ev.deaths > best.deaths || ev.chance < best.chance - 1e-9) return false;
		if (!(ev.runTicks < best.runTicks || (ev.runTicks === best.runTicks && ev.complete < best.ticks))) return false;
		const saved = best.runTicks - ev.runTicks;
		best = { ms: ev.ms, runTicks: ev.runTicks, ticks: ev.complete, deaths: ev.deaths, chance: ev.chance };
		found.push({ how, runTicks: ev.runTicks, saved, t: Math.round((Date.now() - t0) / 100) / 10 });
		emit({ ev: 'perfect', kind: 'route', how, runTicks: ev.runTicks, saved });
		if (log) log(`  + ${how}: ${ev.runTicks} (-${saved})`);
		return true;
	};
	// ---------------------------------------------------------------- (1) ORDER
	const lbCache = new Map();
	const anchorArg = (N) => ({ arrival: N.arrivals[0], arrivals: N.arrivals, S: N.S, key: N.key, tick: N.tick, run: N.run });
	const lbOf = (N) => {
		const h = N.arrivals[0].hash;
		if (lbCache.has(h)) return lbCache.get(h);
		let v = 0;
		try {
			if (planner && typeof planner.lowerBound === 'function') {
				St.lbCalls++;
				const r = planner.lowerBound(anchorArg(N), { ms: o.lbMs > 0 ? o.lbMs : LB_MS, maxExpand: LB_EXPAND });
				const x = r && typeof r === 'object' ? +r.ticks : +r;
				v = x === Infinity ? Infinity : Number.isFinite(x) && x > 0 ? x : 0;
			}
		} catch (e) { v = 0; }
		lbCache.set(h, v);
		return v;
	};
	const queue = [];   // nodes, the least f first
	const seenState = new Map();   // hash -> 1 (an arrival state already queued)
	const push = (N) => {
		N.lb = lbOf(N);
		N.f = N.tick + N.lb;
		if (!(N.f < best.ticks)) { St.pruned++; return; }
		queue.push(N);
	};
	const nodeOf = (arrivals, S, via) => {
		const a0 = arrivals.reduce((m, a) => (a.tick < m.tick ? a : m), arrivals[0]);
		return { arrivals: T.pickDiverse(arrivals, 4), S, key: String(S.key), tick: a0.tick, run: a0.run, via };
	};
	const seedFrom = (m, via) => {
		const seeds = routeSeeds(L, model, m);
		const sim = new E.EESim(L);
		for (const s of seeds) {
			sim.reset(); sim.restore(s.snapSim);
			const masks = m.subarray(0, s.tick);
			const a = Object.assign(T.arrivalOf(L, sim, masks, RM), { run: sim.run_ticks });
			if (seenState.has(a.hash)) continue;
			seenState.set(a.hash, 1);
			St.seeds++;
			push(nodeOf([a], s.S, via));
		}
	};
	seedFrom(best.ms, 'the route');
	const tried = new Set();
	const verify = (wp, res, starts) => {
		const out = [];
		if (!res || !res.ok || !Array.isArray(res.arrivals)) return out;
		const trophy = wp.kind === 'trophy';
		const goal = trophy ? null : T.goalOf(L, wp);
		for (const a of res.arrivals) {
			if (!a || !a.masks) continue;
			const m = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			if (m.length >= best.ticks) continue;
			// (the start it grew from: its masks begin this one (the prefix's deaths are the route's moves))
			let from = 0;
			for (const s of starts) if (s.masks.length <= m.length && s.masks.length > from) { let ok = true; for (let t = 0; t < s.masks.length; t++) if ((s.masks[t] & 31) !== (m[t] & 31)) { ok = false; break; } if (ok) from = s.masks.length; }
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			let goalAt = -1, finished = -1, dead = false;
			for (let t = 0; t < m.length; t++) {
				E.applyMask(inp, m[t] & 31); sim.tick(inp);
				if (sim.is_dead && t >= from && !(goal && goal.allowDeath)) { dead = true; break; }
				if (finished < 0 && sim.has_silver_crown) { finished = t + 1; break; }
				if (goal && goalAt < 0 && goal.test(sim)) goalAt = t + 1;
			}
			if (finished > 0) { tryRoute(m.subarray(0, finished), 'order'); continue; }
			if (dead || trophy || goalAt < 0 || sim.is_dead) continue;
			if (Number.isFinite(+wp.beforeTick) && wp.beforeTick >= 0 && goalAt > wp.beforeTick) continue;
			out.push(Object.assign(T.arrivalOf(L, sim, m, RM), { run: sim.run_ticks }));
		}
		return out;
	};
	const relOf = (x) => { if (typeof x === 'number') return x; const mm = /^\s*(?:prev\s*\+\s*)?(\d+)\s*$/.exec(String(x === undefined || x === null ? '' : x)); return mm ? +mm[1] : NaN; };
	while (queue.length && Date.now() < orderEnd && St.expanded < maxNodes) {
		// (depth first from the route's END: the queue is a stack, the seeds pushed earliest first so the latest state (the
		// last join: its trophy leg) is expanded first, a node's children pushed so its least f is next; the admissible lb
		// is weak on long levels (Tutorial 1: 372 of 1,655), so a best-first order on f is a breadth-first re-derivation of
		// the whole route from the start that finishes nothing in its time (the first version: 14 nodes, 8 legs, no finish))
		const N = queue.pop();
		if (!(N.f < best.ticks)) { St.pruned++; continue; }
		St.expanded++;
		let plans = [], failed = 0;
		try {
			St.planCalls++;
			const r = planner.plan(anchorArg(N), { k: kPlans, depth: best.ticks, ms: Math.min(400, Math.max(60, orderEnd - Date.now())) });
			plans = (Array.isArray(r) ? r : (r && r.plans) || []).filter((p) => p && Array.isArray(p.steps) && p.steps.length);
		} catch (e) { plans = []; }
		for (const p of plans) {
			if (Date.now() >= orderEnd) break;
			if (Number.isFinite(+p.lb) && N.tick + +p.lb >= best.ticks) { St.pruned++; continue; }
			const step = p.steps[0];
			const tk = `${N.arrivals[0].hash}|${step.edge}|${step.rung | 0}`;
			if (tried.has(tk)) { St.repeats++; continue; }
			tried.add(tk);
			const wp0 = step.waypoint || { kind: 'trophy', label: 'trophy' };
			const wp = Object.assign({}, wp0);
			const rel = relOf(step.beforeTickFrom !== undefined ? step.beforeTickFrom : wp0.beforeTickFrom);
			if (Number.isFinite(rel)) { wp.beforeTick = N.arrivals.reduce((m, a) => Math.max(m, a.tick), 0) + rel; wp.beforeRel = rel; }
			// (the incumbent as the leg's deadline where the exact tier can bound it: its finish less the rest's lb)
			const room = best.ticks - N.tick;
			if (room <= BOUND_ROOM && !(wp.beforeTick >= 0)) wp.beforeTick = best.ticks - 1 - (wp.kind === 'trophy' ? 0 : 1);
			const legMs = Math.min(LEG_MS_MAX, legMs0 * (1 << Math.min(2, step.rung | 0)), Math.max(100, orderEnd - Date.now()));
			const dl = Date.now() + legMs;
			let res = null;
			St.legs++;
			try { res = await exec.reach(N.arrivals, wp, { ms: legMs, level: Math.min(3, step.rung | 0), k: 4, deadline: dl, stop: () => Date.now() > Math.min(dl + 2000, deadline) }); } catch (e) { res = null; }
			const arr = verify(wp, res, N.arrivals);
			try { planner.learn(step, res && res.ok && arr.length ? Object.assign({}, res, { arrivals: arr }) : Object.assign({}, res || {}, { ok: false, fail: (res && res.fail) || { why: 'budget' } }), anchorArg(N)); } catch (e) { /* the planner's bookkeeping */ }
			if (LOG) console.error(`perfect: node @${N.tick} (${N.via || ''}) f ${Math.round(N.f)} -> ${(step.waypoint && step.waypoint.label) || step.edge} r${step.rung | 0} ${legMs}ms: ${arr.length ? `${arr.length} arrivals, first @${Math.min(...arr.map((a) => a.tick))}` : `fail ${res && res.fail ? res.fail.why : '?'}`}${res && res.tool ? ` [${res.tool}]` : ''}`);
			if (!arr.length) { failed++; continue; }
			St.legsOk++; St.arrivals += arr.length;
			const byKey = new Map();
			for (const a of arr) {
				if (seenState.has(a.hash)) continue;
				seenState.set(a.hash, 1);
				const sim = new E.EESim(L); sim.reset(); sim.restore(a.snap);
				let S2; try { S2 = model.stateOf(sim); } catch (e) { continue; }
				const k2 = String(S2.key);
				if (!byKey.has(k2)) byKey.set(k2, { S: S2, list: [] });
				byKey.get(k2).list.push(a);
			}
			const kids = [];
			for (const { S, list } of byKey.values()) { const K = nodeOf(list, S, (step.waypoint && step.waypoint.label) || String(step.edge)); K.lb = lbOf(K); K.f = K.tick + K.lb; if (K.f < best.ticks) kids.push(K); else St.pruned++; }
			kids.sort((a, b) => b.f - a.f);
			for (const K of kids) queue.push(K);
		}
		// (a failed leg moved its edge up a rung (the planner's facts): the node goes back into the queue for the next rung's
		// longer leg, at most REEXPAND times (iterative deepening within the bound))
		if (failed && (N.reexp | 0) < REEXPAND) { N.reexp = (N.reexp | 0) + 1; queue.unshift(N); }
		// (a better incumbent: its own states seed the queue too)
		if (found.length && found[found.length - 1].seeded !== true) { found[found.length - 1].seeded = true; seedFrom(best.ms, 'a better route'); }
	}
	const orderSaved = ev0.runTicks - best.runTicks;
	// ---------------------------------------------------------------- (2) POLISH at the joins
	let polishSaved = 0;
	if (polishOn && Date.now() < deadline - 300) {
		const pms = Math.max(200, deadline - Date.now());
		try {
			const pr = await exec.polish(best.ms, { ms: pms, legs: joinTicks(L, model, best.ms) });
			if (pr && pr.masks) {
				const m = pr.masks instanceof Uint8Array ? pr.masks : T.masksOf(pr.masks);
				const before = best.runTicks;
				if (tryRoute(m, 'polish at the joins')) polishSaved = before - best.runTicks;
			}
		} catch (e) { /* the polish's own failure: the route as it is */ }
	}
	return { masks: best.ms, runTicks: best.runTicks, ticks: best.ticks, deaths: best.deaths, chance: best.chance, saved: ev0.runTicks - best.runTicks, orderSaved, polishSaved, found,
		expanded: St.expanded, legs: St.legs, legsOk: St.legsOk, pruned: St.pruned, seeds: St.seeds, lbCalls: St.lbCalls, planCalls: St.planCalls, repeats: St.repeats, queueLeft: queue.length,
		exhausted: queue.length === 0, ms: Date.now() - t0 };
}

module.exports = { perfectRoute, routeSeeds, joinTicks };
