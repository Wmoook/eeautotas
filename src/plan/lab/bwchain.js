'use strict';
// src/plan/lab/bwchain.js - THE GATED LEVEL AS A CHAIN OF BACKWARD LEGS (n5-s99-gated, 2026-09-30).
//
// The whole-level stage (bwlevel_child.js, EEAT_BW_LEVEL=1) solves a level whose trophy needs no trigger as ONE leg of the
// backward solver (backward.js) and ends at once on the other 77 of the 206 failing levels ('the start is not in the
// target's walk': the trophy behind doors a trigger opens). Here such a level is a CHAIN of trigger legs, each one
// continuous backward solve from the chain's EXACT engine state (its speed and sub-pixel as the last leg left them) to the
// next trigger's tiles.
//
// WHERE THE GATED LEVELS BREAK (tools/cmp/routechain.js on the 19 gated levels with a known route, box 5): along the KNOWN
// ROUTE's trigger order the backward solver finds nearly every leg, from the route's own state and from the chain's own
// state alike, most in 0.1-12 s (Buuwuu's Stronghold, Katwalk, Treasure Trove Cove: every leg); along the PLANNER's
// order (the first version of this file: the plan's first step, 6 + 40 s a leg) the chains broke at depth 0-7 on legs
// from states the route never passes through (Buuwuu's team 2 then coin (7,41), then coin (55,59): 46 s 'budget'; the
// route takes coin (55,59) before (7,41), 0.5 s). THE ORDER is the break, and a leg that is feasible is found fast.
//
// So the chain is a BEST-FIRST SEARCH OVER ORDERS with the backward solver as the edge oracle and ITERATIVE CLOCK
// DEEPENING: a node = an exact chain state (the masks from the level start); its candidate next steps = the planner's
// plans' first steps (the landmarks' order, the model's gates) and the nearest relevant triggers of the planner's edges
// (est walk order); every candidate of every node is tried at the short clock CL[0] before any at CL[1], and so on
// (a feasible leg costs its time, an infeasible order CL[0]); among the nodes the most progress first, then the planner's
// est to the trophy + the ticks so far. A child whose abstract state (the model's key) already has KEEP nodes that
// arrived no later is dropped; the order among nodes: the most gain (the model's state gain: features changed, coins
// taken; a team or switch toggled back and forth is no gain), then the planner's est + the ticks. Every leg is the engine's replay; the route is C.evaluate'd by the caller.
//
//   chainLevel(L, o) -> {ok, masks, runTicks, deaths, legs: [{label, from, depth, T, ms, ok, why, clock}], depth, why,
//                        stats, ms}
//   o: {ms (the whole clock), clocks ([ms] the clock levels), planMs, K (nearest candidates a node), onAnchor(masks,
//       info) (each new chain node: the caller's import), log(line), stop() -> bool, model, backward, starts ([masks]:
//       more roots, e.g. the compile's anchors)}
const E = require('../../eesim.js');
const T = require('../types.js');
const C = require('../../common.js');
const MD = require('../model.js');
const BW = require('./backward.js');

const ENVN = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const CLOCKS = (process.env.EEAT_BWC_CLOCKS || '800,4000,15000,40000').split(',').map(Number).filter((x) => x > 0);
const KEEP = ENVN('EEAT_BWC_KEEP', 2);
const NEAR_K = ENVN('EEAT_BWC_K', 6);

/** the masks' replay from a snapshot: the first tick the goal holds (the tail candidates tried) -> {masks, sim} | null */
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
	const CL = o.clocks || CLOCKS;
	const planMs = o.planMs || ENVN('EEAT_BWC_PLANMS', 600);
	const K = o.K || NEAR_K;
	const legs = [];
	const stats = { plans: 0, legs: 0, legsOk: 0, nodes: 0, dropped: 0, bestDepth: 0, bestGain: 0, level: 0, cands: 0 };
	const byKey = new Map();   // S.key -> [nodes]
	const nodes = [];
	let seq = 0;
	const anchorArg = (n) => ({ arrival: n.a, arrivals: [n.a], S: n.S, key: String(n.S.key), tick: n.a.tick, run: n.a.run });
	const addNode = (masks, sim, parent, label) => {
		const S = model.stateOf(sim);
		const key = String(S.key);
		const a = Object.assign(T.arrivalOf(L, sim, masks, null), { run: sim.run_ticks });
		const same = byKey.get(key) || [];
		if (same.some((x) => x.a.hash === a.hash)) { stats.dropped++; return null; }
		if (same.length >= KEEP && same.every((x) => x.a.tick <= a.tick)) { stats.dropped++; return null; }
		const n = { id: ++seq, masks, snap: sim.snapshot(), S, a, depth: parent ? parent.depth + 1 : 0, parent, label, cands: null, h: Infinity, gain: Number.isFinite(+S.gain) ? +S.gain : (parent ? parent.gain + 1 : 0) };
		same.push(n); byKey.set(key, same);
		nodes.push(n); stats.nodes++;
		if (n.depth > stats.bestDepth) stats.bestDepth = n.depth;
		if (n.gain > stats.bestGain) stats.bestGain = n.gain;
		return n;
	};
	/** a node's candidates, once: the plans' first steps, then the nearest relevant triggers (the planner's edges) */
	const candsOf = (n) => {
		if (n.cands) return n.cands;
		const out = [], seen = new Set();
		const push = (edge, wp, pri) => { const k = String(edge); if (seen.has(k) || !wp) return; seen.add(k); out.push({ edge: k, wp, pri, tried: -1 }); };
		let r = null;
		try { r = planner.plan(anchorArg(n), { k: 3, ms: Math.min(planMs, Math.max(100, left() / 10)) }); } catch (e) { r = null; }
		stats.plans++;
		let est = Infinity;
		for (const p of (r && r.plans) || []) {
			if (Number.isFinite(+p.cost)) est = Math.min(est, +p.cost);
			const s = p.steps && p.steps.find((x) => !(x.waypoint && x.waypoint.allowDeath));
			if (s && s === p.steps[0]) push(s.edge, s.waypoint, 0);
		}
		n.h = est;
		try {
			const a = planner._anchorOf(anchorArg(n));
			const cls = a.S.key + '|' + a.cls;
			const es = planner._edgesOf(a.S, a.pos, a.base, 'plan', true, cls, a) || [];
			const ok = es.filter((e) => !e.relaxOnly && !e.viaDeath && (e.X ? e.X.kind !== 'die' && e.live && e.live.length : true));
			ok.sort((x, y) => (x.est - y.est) || (x.lb - y.lb));
			for (const e of ok.slice(0, K + 2)) {
				const X = e.X;
				const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: e.anyOf > 1 ? `${X.label} (any of ${e.anyOf})` : X.label } : { kind: 'trophy', label: 'trophy' };
				push(e.edge, wp, 1);
				if (out.length >= K + 3) break;
			}
		} catch (e) { /* the plans alone */ }
		stats.cands += out.length;
		n.cands = out;
		return out;
	};
	const prio = (n) => [-(n.gain), (Number.isFinite(n.h) ? n.h : 1e7) + n.a.tick];
	const better = (x, y) => { const a = prio(x), b = prio(y); return a[0] - b[0] || a[1] - b[1]; };
	// the roots: the level start, then the caller's starts (the compile's anchors)
	{
		const s0 = new E.EESim(L); s0.reset();
		addNode(new Uint8Array(0), s0, null, 'start');
		for (const m of o.starts || []) { try { const r = T.playTo(L, m, { allowDeath: true }); if (!r.sim.is_dead) addNode(m, r.sim, null, 'import'); } catch (e) { /* skip */ } }
	}
	let best = null, why = 'budget';
	outer:
	while (left() > 300 && !stop()) {
		// the lowest clock level with an untried candidate, the best node there
		let pick = null, pc = null, lvl = -1;
		for (let l = 0; l < CL.length && !pick; l++) {
			const order = nodes.slice().sort(better);
			for (const n of order) {
				const cs = candsOf(n);
				const c = cs.find((x) => x.tried < l);
				if (c) { pick = n; pc = c; lvl = l; break; }
				if (left() < 300) break outer;
			}
		}
		if (!pick) { why = 'exhausted'; break; }
		stats.level = Math.max(stats.level, lvl);
		pc.tried = lvl;
		const wp = pc.wp;
		const goal = T.goalOf(L, wp);
		const tiles = Array.from(goal.tiles);
		const tl = Date.now();
		const ms = Math.min(CL[lvl], left() - 200);
		if (ms < 200) break;
		let r;
		try { r = B.solve(pick.snap, { tiles }, { ms }); } catch (e) { r = { ok: false, why: 'error: ' + e.message }; }
		if (!r.ok && /walk|target|bug|error/.test(r.why || '')) pc.tried = CL.length;   // (no clock helps)
		stats.legs++;
		const leg = { label: wp.label || wp.kind, from: pick.a.tick, depth: pick.depth, ok: false, T: null, ms: Date.now() - tl, why: r.why || '', clock: ms };
		legs.push(leg);
		let hit = null;
		if (r.ok) { hit = hitOf(L, pick.snap, r.masks, goal); if (!hit) { leg.why = 'goal missed'; pc.tried = CL.length; } }
		if (!hit) { log(`L${lvl} ${leg.label} from tick ${pick.a.tick} (depth ${pick.depth}): FAIL ${leg.why} ${(leg.ms / 1000).toFixed(1)} s`); continue; }
		pc.tried = CL.length;
		const masks = new Uint8Array(pick.masks.length + hit.masks.length);
		masks.set(pick.masks); masks.set(hit.masks, pick.masks.length);
		leg.ok = true; leg.T = hit.masks.length; stats.legsOk++;
		log(`L${lvl} ${leg.label} from tick ${pick.a.tick} (depth ${pick.depth}): ${leg.T} t, ${(leg.ms / 1000).toFixed(1)} s`);
		if (hit.sim.has_silver_crown || wp.kind === 'trophy') {
			const ev = C.evaluate(L, masks, false);
			if (ev) { best = { masks: ev.ms || masks, runTicks: ev.runTicks, deaths: ev.deaths }; why = 'finish'; break; }
			leg.why = 'no finish'; leg.ok = false;
			continue;
		}
		const n = addNode(masks, hit.sim, pick, leg.label);
		if (n && o.onAnchor) { try { o.onAnchor(masks, { depth: n.depth, gain: n.gain, label: leg.label, tick: n.a.tick }); } catch (e) { /* the caller's */ } }
	}
	if (!best && why === 'budget' && stop()) why = 'stopped';
	let deep = null;
	for (const n of nodes) if (!deep || n.gain > deep.gain || (n.gain === deep.gain && n.a.tick < deep.a.tick)) deep = n;
	return { ok: !!best, masks: best ? best.masks : null, runTicks: best ? best.runTicks : null, deaths: best ? best.deaths : null, legs, depth: stats.bestDepth, gain: stats.bestGain, deepestTick: deep ? deep.a.tick : 0, why, stats, ms: Date.now() - t0 };
}

module.exports = { chainLevel, hitOf };
