'use strict';
// THE CEGAR FACT STORE (n4plan, part 'planner'): what the executor taught the planner. A step that failed within its
// budget is a counterexample: its (edge, nodeClass) moves up one rung (the next try gets the next budget and the plan
// pays double for it); past the last rung, or on a proof, the edge is blocked for that node class. A success records the
// measured ticks (the planner's cost from then on). 'needs' names a door feature an edge waits for (the executor's
// blockedBy: a shut gate near its closest approach); 'enable' lets the planner try the physics effects first.
//
// createFacts({rungs: 4}) -> {record(fact), rung(edge, nodeClass), penalty(edge, nodeClass, unmet), blocked(edge,
//   nodeClass), measured(edge, nodeClass) -> ticks | null, needs(trigId) -> Set(feat), enabled(nodeClass), version,
//   toJSON(), reset({keepProofs, boost}), scale, stats()}
// Fact kinds: {kind:'ok', edge, nodeClass, ticks} | {kind:'fail', edge, nodeClass, rung, why} | {kind:'proof', edge,
//   nodeClass} | {kind:'needs', trig, feat} | {kind:'side', edge, touched} | {kind:'enable', nodeClass}
// nodeClass = S.key + '@' + regionId (the planner's); edge = nodeClass + '>' + <trigId | trophy | die | expire:<feat> |
// explore:<tile>>.

function createFacts(opts = {}) {
	const RUNGS = opts.rungs || 4;
	const E = new Map();   // edge|nodeClass -> {rung, proof, ticks, fails, oks}
	const needs = new Map();   // trigId -> Set(feat)
	const enabled = new Set();   // nodeClasses allowed the effects' enabler edges
	const sides = [];
	let version = 0, scale = 1, deepenings = 0;
	const k = (edge, nodeClass) => `${edge}|${nodeClass}`;
	const get = (edge, nodeClass) => E.get(k(edge, nodeClass));
	const ent = (edge, nodeClass) => { const key = k(edge, nodeClass); let e = E.get(key); if (!e) { e = { edge, nodeClass, rung: 0, proof: false, ticks: null, fails: 0, oks: 0, why: null }; E.set(key, e); } return e; };
	const F = {
		/** record one fact (returns it) */
		record(f) {
			if (!f || !f.kind) return f;
			version++;
			switch (f.kind) {
				case 'ok': { const e = ent(f.edge, f.nodeClass); e.oks++; if (Number.isFinite(f.ticks)) e.ticks = e.ticks === null ? f.ticks : Math.min(e.ticks, f.ticks); e.rung = 0; break; }
				case 'fail': { const e = ent(f.edge, f.nodeClass); e.fails++; e.why = f.why || null; e.rung = Math.max(e.rung, (f.rung | 0) + 1); break; }
				case 'proof': { const e = ent(f.edge, f.nodeClass); e.proof = true; e.why = 'proof'; break; }
				case 'needs': { const t = String(f.trig); if (!needs.has(t)) needs.set(t, new Set()); needs.get(t).add(f.feat); break; }
				case 'side': sides.push(f); if (sides.length > 1000) sides.shift(); break;
				case 'enable': enabled.add(f.nodeClass); break;
			}
			return f;
		},
		/** the rung the next try of this edge from this class gets (0..rungs-1; >= rungs: blocked) */
		rung(edge, nodeClass) { const e = get(edge, nodeClass); return e ? e.rung : 0; },
		/** the plan's cost factor: 2^rung, x4 per unmet need (the caller counts the needs whose gates are shut in S) */
		penalty(edge, nodeClass, unmet = 0) { const e = get(edge, nodeClass); return (e && e.ticks !== null && e.rung === 0 ? 1 : Math.pow(2, e ? e.rung : 0)) * Math.pow(4, unmet); },
		/** blocked: a proof, or failed past the last rung */
		blocked(edge, nodeClass) { const e = get(edge, nodeClass); return !!e && (e.proof || e.rung >= RUNGS); },
		/** the measured ticks of a success (null: none) */
		measured(edge, nodeClass) { const e = get(edge, nodeClass); return e && e.ticks !== null ? e.ticks : null; },
		/** the door features a trigger was found to need */
		needs(trig) { return needs.get(String(trig)) || new Set(); },
		/** the class may try the effects (enabler edges) */
		enabled(nodeClass) { return enabled.has(nodeClass); },
		get version() { return version; },
		/** the budget scale (x2 per global deepening) */
		get scale() { return scale; },
		get deepenings() { return deepenings; },
		get rungs() { return RUNGS; },
		/** the global deepening: every rung back to 0 (the proofs kept unless keepProofs false), budgets x boost */
		reset(o = {}) {
			const keepProofs = o.keepProofs !== false;
			for (const [key, e] of E) { e.rung = 0; if (!keepProofs) e.proof = false; if (!e.proof && e.ticks === null && e.oks === 0 && !keepProofs) E.delete(key); }
			scale *= o.boost || 2;
			deepenings++;
			version++;
		},
		/** every edge this store knows (tests, logs) */
		entries() { return [...E.values()]; },
		stats() { let blocked = 0, proofs = 0, fails = 0, oks = 0; for (const e of E.values()) { if (e.proof) proofs++; if (e.proof || e.rung >= RUNGS) blocked++; fails += e.fails; oks += e.oks; } return { edges: E.size, blocked, proofs, fails, oks, needs: needs.size, enabled: enabled.size, version, scale, deepenings }; },
		toJSON() { return { rungs: RUNGS, scale, deepenings, version, edges: [...E.values()], needs: [...needs].map(([t, s]) => [t, [...s]]), enabled: [...enabled] }; },
	};
	return F;
}

module.exports = { createFacts };
