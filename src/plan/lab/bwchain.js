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
const CLOCKS = (process.env.EEAT_BWC_CLOCKS || '1500,40000').split(',').map(Number).filter((x) => x > 0);
const KEEP = ENVN('EEAT_BWC_KEEP', 2);
const NEAR_K = ENVN('EEAT_BWC_K', 6);
const RANK_W = ENVN('EEAT_BWC_RANKW', 0.5), GAIN_W = ENVN('EEAT_BWC_GAINW', 3), SIB_W = ENVN('EEAT_BWC_SIBW', 0.5);
// (a candidate's weight: the planner's first plan's first step W_PLAN1 (its 40-s try before most probes: the planner-order
// first version finished Frostbitten where the broad v3 spent its clock on 102 legs of alternatives), the other plans' W_PLAN2, the planner's nearest edges W_EDGE +
// RANK_W a place, the model's other triggers (EXTEND) W_EXT + RANK_W a place)
const W_PLAN1 = ENVN('EEAT_BWC_WPLAN1', 0.1), W_PLAN2 = ENVN('EEAT_BWC_WPLAN2', 1.5), W_EDGE = ENVN('EEAT_BWC_WEDGE', 2), W_EXT = ENVN('EEAT_BWC_WEXT', 4), EXT_K = ENVN('EEAT_BWC_EXTK', 8);
const ORDER_LEVEL = process.env.EEAT_BWC_ORDER === 'level';
// THE NEAREST-FIRST ORDER (P4 gated, OPT-IN EEAT_BWC_RANK=est; unset / 'plan' = the order above byte for byte). The order
// oracle (tools/cmp/orderoracle.js: the 19 gated levels' known routes, 409 anchors at the route's own state after each of its
// trigger events, the route's next trigger ranked among the planner's choices): the plans' first steps hold the route's
// next trigger first at 34.5% and among the first 3 at 56.5%; the planner's own edges by est (the est walk x the pace)
// at 57.9% / 82.4% (level-weighted top 3: 81.5 vs 71.5%): the planner's plans aim at the trophy or at a far 'most gain'
// node through the relaxation's false nears (Katwalk, Wine Quest I, Endeavor: the trophy at every anchor; Weird Perfection:
// 'budget: the most gain' partial plans 1,200-3,000 est ticks away while the route takes the coin 60-200 away). With the
// knob a node's candidates are its usable edges by est (the nearest first, K + 2 of them), plan 1's first step put at
// place PLAN_AT (1) unless nearer, the other plans' first steps after them; a candidate's weight W_EST0 + RANK_W x its place
const RANK_EST = process.env.EEAT_BWC_RANK === 'est';
const W_EST0 = ENVN('EEAT_BWC_WEST0', 0.25), PLAN_AT = ENVN('EEAT_BWC_PLANAT', 1);
// THE CHAIN'S MEMORY OF FAILED LEGS (P4 gated, OPT-IN EEAT_BWC_LEARN=1; off = byte for byte): a leg the chain tried at its
// full clock and lost from one node comes back as the first candidate of the next node (the planner's plan from there is
// the same false near: Katwalk's / Wine Quest I's trophy, est 12-1,500 at every anchor): (1) its edge's cost x (1 + FAIL_K x
// its full-clock failures from any node) while no node reached it; (2) the chain's planner learns every leg (planner.learn:
// the facts' rungs, the pace) and prices an edge that failed from any class by FAIL_EST ticks a failed rung
// (planner o.failEst), so its next plans go another way
const LEARN = process.env.EEAT_BWC_LEARN === '1';
const FAIL_K = ENVN('EEAT_BWC_FAILK', 1), FAIL_EST_C = ENVN('EEAT_BWC_FAILEST', 400);
// THE ORDER BOUND (P4 gated, OPT-IN EEAT_BWC_MORE=1; off = the first route ends the search, byte for byte): a chain route is
// one order; the search goes on to the clock's end for FASTER orders, a branch and bound with the first route the incumbent:
// a node at tick t is out once t + the planner's admissible bound to the trophy (planner.lowerBound) reaches the
// incumbent's finish tick, a candidate once t + its edge's lb does; every faster finish (C.evaluate'd) is the new incumbent
// and reported through o.onRoute (the child prints it: the compile's routeOf takes it when faster)
const MORE = process.env.EEAT_BWC_MORE === '1';

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
	const planner = require('../planner.js').createPlanner(model, facts, Object.assign({ bounds: o.bounds || null, seed: o.seed, file: o.file, floorAsync: false }, LEARN ? { failEst: FAIL_EST_C } : {}));
	// (EEAT_BWC_LEARN: the edges' full-clock failures from any node / the edges some node reached)
	const failN = new Map(), okE = new Set();
	const failF = (edge) => (LEARN && !okE.has(edge) ? 1 + FAIL_K * (failN.get(edge) || 0) : 1);
	const B = o.backward || BW.createBackward(L);
	const CL = o.clocks || CLOCKS;
	const planMs = o.planMs || ENVN('EEAT_BWC_PLANMS', 600);
	const K = o.K || NEAR_K;
	const legs = [];
	const stats = { plans: 0, legs: 0, legsOk: 0, nodes: 0, dropped: 0, bestDepth: 0, bestGain: 0, level: 0, cands: 0, ext: 0, extRounds: 0 };
	const byKey = new Map();   // S.key -> [nodes]
	const nodes = [];
	let seq = 0;
	const anchorArg = (n) => ({ arrival: n.a, arrivals: [n.a], S: n.S, key: String(n.S.key), tick: n.a.tick, run: n.a.run });
	/** a node's class in the planner's facts (planner anchorOf: the abstract state + the arrival's speed class) */
	const classOf = (n) => { if (n.cls === undefined) { try { const a = planner._anchorOf(anchorArg(n)); n.cls = a.S.key + '|' + a.cls; } catch (e) { n.cls = String(n.S.key) + '|*'; } } return n.cls; };
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
		const push = (edge, wp, w, step) => { const k = String(edge); if (seen.has(k) || !wp) return; seen.add(k); out.push({ edge: k, wp, w, tried: -1, step: step || null }); };
		let r = null;
		try { r = planner.plan(anchorArg(n), { k: 3, ms: Math.min(planMs, Math.max(100, left() / 10)) }); } catch (e) { r = null; }
		stats.plans++;
		let est = Infinity;
		if (RANK_EST) {
			// (the nearest-first order: the usable edges by est, plan 1's first step at PLAN_AT, the other plans' after them)
			const firsts = [];
			for (const p of (r && r.plans) || []) {
				if (Number.isFinite(+p.cost)) est = Math.min(est, +p.cost);
				const s = p.steps && p.steps.find((x) => !(x.waypoint && x.waypoint.allowDeath));
				if (s && s === p.steps[0] && !firsts.some((f) => String(f.edge) === String(s.edge))) firsts.push(s);
			}
			n.h = est;
			let es = [], cls = '';
			try {
				const a = planner._anchorOf(anchorArg(n));
				cls = a.S.key + '|' + a.cls;
				es = (planner._edgesOf(a.S, a.pos, a.base, 'plan', true, cls, a) || []).filter((e) => !e.relaxOnly && !e.viaDeath && (e.X ? e.X.kind !== 'die' && e.live && e.live.length : true));
				es.sort((x, y) => (x.est - y.est) || (x.lb - y.lb));
			} catch (e) { es = []; }
			const list = [];
			for (const e of es.slice(0, K + 2)) {
				const X = e.X;
				const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: e.anyOf > 1 ? `${X.label} (any of ${e.anyOf})` : X.label } : { kind: 'trophy', label: 'trophy' };
				list.push({ edge: String(e.edge), wp, step: { edge: String(e.edge), nodeClass: cls, rung: 0, waypoint: wp, lb: e.lb } });
			}
			firsts.forEach((s, i) => {
				const j = list.findIndex((c) => c.edge === String(s.edge));
				const at = i === 0 ? Math.min(PLAN_AT, list.length) : list.length;
				if (j >= 0) { if (i === 0 && j > at) { const [c] = list.splice(j, 1); list.splice(at, 0, c); } return; }
				list.splice(at, 0, { edge: String(s.edge), wp: s.waypoint, step: s });
			});
			list.forEach((c, i) => push(c.edge, c.wp, W_EST0 + RANK_W * i, c.step));
			stats.cands += out.length;
			n.cands = out;
			n.seen = seen;
			return out;
		}
		for (const p of (r && r.plans) || []) {
			if (Number.isFinite(+p.cost)) est = Math.min(est, +p.cost);
			const s = p.steps && p.steps.find((x) => !(x.waypoint && x.waypoint.allowDeath));
			if (s && s === p.steps[0]) push(s.edge, s.waypoint, out.length ? W_PLAN2 : W_PLAN1, s);
		}
		n.h = est;
		try {
			const a = planner._anchorOf(anchorArg(n));
			const cls = a.S.key + '|' + a.cls;
			const es = planner._edgesOf(a.S, a.pos, a.base, 'plan', true, cls, a) || [];
			const ok = es.filter((e) => !e.relaxOnly && !e.viaDeath && (e.X ? e.X.kind !== 'die' && e.live && e.live.length : true));
			ok.sort((x, y) => (x.est - y.est) || (x.lb - y.lb));
			let ei = 0;
			for (const e of ok.slice(0, K + 2)) {
				const X = e.X;
				const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: e.anyOf > 1 ? `${X.label} (any of ${e.anyOf})` : X.label } : { kind: 'trophy', label: 'trophy' };
				push(e.edge, wp, W_EDGE + RANK_W * ei++);
				if (out.length >= K + 3) break;
			}
		} catch (e) { /* the plans alone */ }
		stats.cands += out.length;
		n.cands = out;
		n.seen = seen;
		return out;
	};
	/** a node's candidates once more: the model's other triggers (any kind the planner's edges leave out: an effect that
	 *  turns gravity, a checkpoint), the nearest by the est walk first (the search ran out of tries: EXTEND) */
	const extendCands = (n) => {
		if (n.ext || !n.cands) return 0;
		n.ext = true;
		let added = 0;
		try {
			const a = planner._anchorOf(anchorArg(n));
			const d = model.dist(a.S, a.pos, 'est', a.base);
			const sim = new E.EESim(L); sim.reset(); sim.restore(n.snap);
			const W = L.width, list = [];
			for (const X of model.triggers || []) {
				if (!X || !X.tiles || !X.tiles.length || X.kind === 'die' || X.kind === 'trophy') continue;
				const key = 'x:' + X.id;
				if (n.seen.has(key)) continue;
				const coin = X.kind === 'coin' || X.kind === 'bcoin';
				const live = coin ? X.tiles.filter((t) => !sim.is_coin_collected(t % W, (t / W) | 0)) : X.tiles.slice();
				if (!live.length) continue;
				let m = Infinity;
				for (const t of live) if (d[t] >= 0 && d[t] < m) m = d[t];
				if (!(m < 1e8)) continue;
				list.push({ key, X, live, m });
			}
			list.sort((p, q) => p.m - q.m);
			for (const it of list.slice(0, EXT_K)) {
				n.seen.add(it.key);
				n.cands.push({ edge: it.key, wp: { kind: 'trigger', tiles: it.live, trig: it.X.id, expect: null, label: it.X.label }, w: W_EXT + RANK_W * added, tried: -1 });
				added++;
			}
		} catch (e) { /* none */ }
		stats.ext += added;
		return added;
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
	// (THE ORDER BOUND, MORE: the incumbent's finish tick; a node whose tick + the planner's admissible lower bound to the
	// trophy (planner.lowerBound: A* on the lb walk relaxation) reaches it, and a candidate whose tick + its edge's lb does,
	// is no try any more)
	let bestC = Infinity;
	const lbOf = (n) => {
		if (n.lbT === undefined) { let t = 0; try { const r = planner.lowerBound(anchorArg(n), { ms: 300 }); t = r && Number.isFinite(r.ticks) ? r.ticks : (r && r.complete ? Infinity : 0); } catch (e) { t = 0; } n.lbT = t; stats.lbCalls = (stats.lbCalls || 0) + 1; }
		return n.lbT;
	};
	const boundOut = (n) => bestC < Infinity && n.a.tick + lbOf(n) >= bestC;
	outer:
	while (left() > 300 && !stop()) {
		// the next try: the least COST over (node, candidate, its next clock level) = the clock x (1 + RANK_W x the candidate's
		// rank at its node) x (1 + GAIN_W x the node's gain below the best), ties by the node's order (a node not yet planned
		// stands for its first candidate at the first clock); EEAT_BWC_ORDER=level: every candidate of every node at a clock
		// before any at the next (the first version: a hard first leg spent L1 on every candidate before its own L2)
		let pick = null, pc = null, lvl = -1;
		if (ORDER_LEVEL) {
			for (let l = 0; l < CL.length && !pick; l++) {
				const order = nodes.slice().sort(better);
				for (const n of order) {
					const cs = candsOf(n);
					const c = cs.find((x) => x.tried < l);
					if (c) { pick = n; pc = c; lvl = l; break; }
					if (left() < 300) break outer;
				}
			}
		} else {
			for (let guard = 0; guard < 4 && !pc; guard++) {
				let gMax = -Infinity;
				for (const n of nodes) if (n.gain > gMax) gMax = n.gain;
				// (a node's place among the nodes of its gain, by the planner's est + ticks: SIB_W a place)
				const sib = new Map(), byGain = new Map();
				for (const n of nodes) { let a = byGain.get(n.gain); if (!a) byGain.set(n.gain, a = []); a.push(n); }
				for (const a of byGain.values()) { a.sort(better); a.forEach((n, i) => sib.set(n, i)); }
				let bk = Infinity, bn = null, bc = null, bl = -1;
				for (const n of nodes) {
					if (bestC < Infinity && boundOut(n)) { if (!n.cut) { n.cut = true; stats.boundCut = (stats.boundCut || 0) + 1; } continue; }
					const gf = (1 + GAIN_W * Math.max(0, gMax - n.gain)) * (1 + SIB_W * sib.get(n));
					if (!n.cands) { const k = CL[0] * gf; if (k < bk || (k === bk && bn && better(n, bn) < 0)) { bk = k; bn = n; bc = null; bl = 0; } continue; }
					for (let i = 0; i < n.cands.length; i++) {
						const c = n.cands[i], l = c.tried + 1;
						if (l >= CL.length) continue;
						if (bestC < Infinity && c.step && Number.isFinite(+c.step.lb) && n.a.tick + (+c.step.lb) >= bestC) continue;
						const k = CL[l] * c.w * gf * failF(c.edge);
						if (k < bk || (k === bk && bn && better(n, bn) < 0)) { bk = k; bn = n; bc = c; bl = l; }
					}
				}
				if (!bn) {
					// (every try spent: the nodes' candidates extended by the model's other triggers, once)
					let add = 0;
					for (const n of nodes) add += extendCands(n);
					stats.extRounds++;
					if (!add) break;
					continue;
				}
				if (!bc) { candsOf(bn); if (left() < 300) break outer; continue; }   // (planned now: its candidates join the next pick)
				pick = bn; pc = bc; lvl = bl;
			}
		}
		if (!pick) { if (!best) why = 'exhausted'; else stats.closed = true; break; }
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
		const fullTry = lvl >= CL.length - 1 || pc.tried >= CL.length;
		const leg = { label: wp.label || wp.kind, from: pick.a.tick, depth: pick.depth, ok: false, T: null, ms: Date.now() - tl, why: r.why || '', clock: ms };
		legs.push(leg);
		let hit = null;
		if (r.ok) { hit = hitOf(L, pick.snap, r.masks, goal); if (!hit) { leg.why = 'goal missed'; pc.tried = CL.length; } }
		if (!hit) {
			log(`L${lvl} ${leg.label} from tick ${pick.a.tick} (depth ${pick.depth}): FAIL ${leg.why} ${(leg.ms / 1000).toFixed(1)} s`);
			if (LEARN && fullTry) {
				failN.set(pc.edge, (failN.get(pc.edge) || 0) + 1); stats.learnFail = (stats.learnFail || 0) + 1;
				if (pc.step) { try { planner.learn(Object.assign({}, pc.step, { nodeClass: classOf(pick) }), { ok: false, fail: { why: /walk|target/.test(r.why || '') ? 'exhausted' : 'budget' } }, anchorArg(pick)); } catch (e) { /* the price only */ } }
			}
			continue;
		}
		if (LEARN) {
			okE.add(pc.edge);
			if (pc.step) { try { planner.learn(Object.assign({}, pc.step, { nodeClass: classOf(pick) }), { ok: true, ticks: hit.masks.length }, anchorArg(pick)); } catch (e) { /* the price only */ } }
		}
		pc.tried = CL.length;
		const masks = new Uint8Array(pick.masks.length + hit.masks.length);
		masks.set(pick.masks); masks.set(hit.masks, pick.masks.length);
		leg.ok = true; leg.T = hit.masks.length; stats.legsOk++;
		log(`L${lvl} ${leg.label} from tick ${pick.a.tick} (depth ${pick.depth}): ${leg.T} t, ${(leg.ms / 1000).toFixed(1)} s`);
		if (hit.sim.has_silver_crown || wp.kind === 'trophy') {
			const ev = C.evaluate(L, masks, false);
			if (ev) {
				// (MORE: the first route is the incumbent and the search goes on for faster orders under its bound; each faster
				// one is reported (o.onRoute) and becomes the bound)
				if (!best || ev.runTicks < best.runTicks) {
					best = { masks: ev.ms || masks, runTicks: ev.runTicks, deaths: ev.deaths, ms: Date.now() - t0 };
					why = 'finish'; bestC = ev.complete; stats.routes = (stats.routes || 0) + 1;
					if (o.onRoute) { try { o.onRoute(best); } catch (e) { /* the caller's */ } }
				}
				if (!MORE) break;
				continue;
			}
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
