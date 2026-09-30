'use strict';
// src/plan/lab/bwchain.js - THE GATED LEVEL AS A CHAIN OF BACKWARD LEGS (n5-s99-gated, 2026-09-30).
//
// The whole-level stage (bwlevel_child.js, EEAT_BW_LEVEL=1) solves a level whose trophy needs no trigger as ONE leg of the
// backward solver (backward.js) and ends at once on the other 77 of the 206 failing levels ('the start is not in the
// target's walk': the trophy behind doors a trigger opens). Here such a level is a CHAIN: the compiler's own planner
// (planner.js, the landmarks' order, the model's gates) names the next trigger from the chain's EXACT engine state, the
// backward solver runs ONE continuous leg to it (the lab: long legs need 30-40 s in one piece; the executor's rung windows
// restart it), the leg's end state (its speed and sub-pixel as the engine left them) is the next leg's start, and the
// planner plans again from there (the triggers taken, the gates as they now stand). A failed leg is a fact for the planner
// (learn: the next rung, then its CEGAR cut / block) and the chain tries the plans' other first steps; a state with no
// step left is backed out of (the anchor before it tries its next step). Every leg is the engine's replay; the route is
// C.evaluate'd by the caller.
//
//   chainLevel(L, o) -> {ok, masks, runTicks?, legs: [{label, from, T, ms, ok, why}], depth, why, stats}
//   o: {ms (the whole clock), sched ([ms] a leg's clocks, the last one capped by the time left), planMs, onAnchor(masks,
//       info) (each new chain state: the caller's import), log(line), stop() -> bool, model, maxBack}
const E = require('../../eesim.js');
const T = require('../types.js');
const C = require('../../common.js');
const MD = require('../model.js');
const BW = require('./backward.js');

const ENVN = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const SCHED = (process.env.EEAT_BWC_SCHED || '6000,40000').split(',').map(Number).filter((x) => x > 0);

/** the masks' replay from a snapshot at tick t0: the first tick (relative) the goal holds, the tail candidates tried */
function hitOf(L, snap, legMasks, goal) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	const last = legMasks.length ? legMasks[legMasks.length - 1] & 30 : 0;
	for (const tail of [[], [last], [last, last], [0], [last, 0, 0], [0, 0]]) {
		sim.reset(); sim.restore(snap);
		const all = legMasks.length + tail.length;
		for (let t = 0; t < all; t++) {
			E.applyMask(inp, (t < legMasks.length ? legMasks[t] : tail[t - legMasks.length]) & 31);
			sim.tick(inp);
			if (sim.is_dead && !goal.allowDeath) break;
			if (goal.test(sim)) {
				const m = new Uint8Array(t + 1);
				for (let k = 0; k <= t; k++) m[k] = k < legMasks.length ? legMasks[k] : tail[k - legMasks.length];
				return { masks: m, sim };
			}
		}
	}
	return null;
}

function chainLevel(L, o = {}) {
	const t0 = Date.now();
	const clock = o.ms || 120000;
	const tEnd = t0 + clock;
	const left = () => tEnd - Date.now();
	const log = o.log || (() => {});
	const stop = o.stop || (() => false);
	const model = o.model || MD.compileModel(L);
	const facts = require('../facts.js').createFacts({ rungs: 4, model });
	const planner = require('../planner.js').createPlanner(model, facts, { bounds: o.bounds || null, seed: o.seed, file: o.file, floorAsync: false });
	const B = o.backward || BW.createBackward(L);
	const sched = o.sched || SCHED;
	const planMs = o.planMs || ENVN('EEAT_BWC_PLANMS', 1500);
	const maxBack = o.maxBack !== undefined ? o.maxBack : ENVN('EEAT_BWC_BACK', 6);
	const legs = [];
	const stats = { plans: 0, legs: 0, legsOk: 0, back: 0, bestDepth: 0, skipDeath: 0, miss: 0 };
	// the chain's nodes: {masks (from the level start), snap, sim state key, tried: Set of edges, depth}
	const sim0 = new E.EESim(L); sim0.reset();
	const nodeOf = (masks, sim, depth, parent) => ({ masks, snap: sim.snapshot(), S: model.stateOf(sim), a: Object.assign(T.arrivalOf(L, sim, masks, null), { run: sim.run_ticks }), depth, tried: new Set(), parent, fails: 0 });
	let cur = nodeOf(new Uint8Array(0), sim0, 0, null);
	const seen = new Set([cur.a.hash]);
	let best = null, why = 'budget', deepest = cur;
	const anchorArg = (n) => ({ arrival: n.a, arrivals: [n.a], S: n.S, key: String(n.S.key), tick: n.a.tick, run: n.a.run });
	while (left() > 500 && !stop()) {
		// ---- the next steps from this node: the plans' first steps not tried here (the planner re-plans as the facts grow)
		let step = null;
		for (let rp = 0; rp < 4 && !step && left() > 500; rp++) {
			let r;
			try { r = planner.plan(anchorArg(cur), { k: 3, ms: Math.min(planMs, Math.max(100, left() / 8)) }); } catch (e) { r = { plans: [], why: 'error: ' + e.message }; }
			stats.plans++;
			const cands = [];
			for (const p of (r && r.plans) || []) {
				const s = p.steps && p.steps[0];
				if (!s || cur.tried.has(String(s.edge))) continue;
				if (!cands.some((c) => String(c.edge) === String(s.edge))) cands.push(s);
			}
			// (a death step: the backward solver's macro moves avoid deaths: not its step (the compiler's executor takes those))
			for (const s of cands) {
				if (s.waypoint && s.waypoint.allowDeath) { cur.tried.add(String(s.edge)); stats.skipDeath++; continue; }
				step = s; break;
			}
			if (!step && !cands.length) break;
		}
		if (!step) {
			// ---- no step left here: back out (the parent tries its next step)
			if (!cur.parent || stats.back >= maxBack) { why = cur.parent ? 'back limit' : 'no step from the start'; break; }
			stats.back++;
			log(`back from depth ${cur.depth} (tick ${cur.a.tick})`);
			cur = cur.parent;
			continue;
		}
		const wp = step.waypoint;
		cur.tried.add(String(step.edge));
		const goal = T.goalOf(L, wp);
		const tiles = Array.from(goal.tiles);
		const tl = Date.now();
		let r = null, tries = 0;
		for (let i = 0; i < sched.length && left() > 300 && !stop(); i++) {
			const ms = i === sched.length - 1 ? Math.min(sched[i], left() - 200) : Math.min(sched[i], left() - 200);
			if (ms < 300) break;
			try { r = B.solve(cur.snap, { tiles }, { ms }); } catch (e) { r = { ok: false, why: 'error: ' + e.message }; }
			tries++;
			if (r.ok || /walk|target|bug|error/.test(r.why || '')) break;
		}
		stats.legs++;
		const leg = { label: wp.label || wp.kind, from: cur.a.tick, depth: cur.depth, ok: false, T: null, ms: Date.now() - tl, why: r ? r.why || '' : 'no clock', tries };
		legs.push(leg);
		let hit = null;
		if (r && r.ok) {
			hit = hitOf(L, cur.snap, r.masks, goal);
			if (!hit) { leg.why = 'goal missed'; stats.miss++; }
		}
		if (!hit) {
			log(`leg ${wp.label || wp.kind} from tick ${cur.a.tick} (depth ${cur.depth}): FAIL ${leg.why} ${(leg.ms / 1000).toFixed(1)} s`);
			cur.fails++;
			try { planner.learn(step, { ok: false, fail: { why: /exhausted/.test(leg.why) ? 'exhausted' : 'budget' } }, anchorArg(cur)); } catch (e) { /* no fact */ }
			continue;
		}
		const masks = new Uint8Array(cur.masks.length + hit.masks.length);
		masks.set(cur.masks); masks.set(hit.masks, cur.masks.length);
		leg.ok = true; leg.T = hit.masks.length; stats.legsOk++;
		log(`leg ${wp.label || wp.kind} from tick ${cur.a.tick} (depth ${cur.depth}): ${leg.T} t, ${(leg.ms / 1000).toFixed(1)} s`);
		const n = nodeOf(masks, hit.sim, cur.depth + 1, cur);
		try { planner.learn(step, { ok: true, arrivals: [n.a] }, anchorArg(cur)); } catch (e) { /* no fact */ }
		if (hit.sim.has_silver_crown || wp.kind === 'trophy') {
			const ev = C.evaluate(L, masks, false);
			if (ev) { best = { masks: ev.ms || masks, runTicks: ev.runTicks, deaths: ev.deaths }; why = 'finish'; break; }
			leg.why = 'no finish'; leg.ok = false;
			continue;
		}
		if (seen.has(n.a.hash)) continue;
		seen.add(n.a.hash);
		if (n.depth > stats.bestDepth) { stats.bestDepth = n.depth; deepest = n; }
		if (o.onAnchor) { try { o.onAnchor(masks, { depth: n.depth, label: leg.label, tick: n.a.tick }); } catch (e) { /* the caller's */ } }
		cur = n;
	}
	if (!best && why === 'budget' && stop()) why = 'stopped';
	return { ok: !!best, masks: best ? best.masks : null, runTicks: best ? best.runTicks : null, deaths: best ? best.deaths : null, legs, depth: stats.bestDepth, deepestTick: deepest.a.tick, why, stats, ms: Date.now() - t0 };
}

module.exports = { chainLevel, hitOf };
