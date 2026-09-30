'use strict';
// THE NAVIGATION GRAPH's A* (n4plan part 'primitives'): a best-first search over EXACT engine states whose edges are
// the primitives' macros (src/plan/prims.js), each simulated by the engine from the node's own snapshot until its first
// event. A node = {snap (this thread's; dropped once expanded), tick (masks from the level start), parent, edge (the
// edge's own masks), g, f, hash, ...}; f = tick + h with h = bounds.at(the goal field, sim): ADMISSIBLE. Ties toward
// the faster ball.
//   dedup: the exact stateHash, always (a state reached at an earlier tick dominates the same state later: its future is
//          the same, the hash leaves the absolute clock out; a regeneration at a smaller tick reopens it). The class
//          dominance (the support key: tile, whole px, 1/16 px/tick of vx, ground, jumps, the features; the earliest tick
//          kept) only with o.classDedup (default true): a heuristic, then proven = false.
//   proven: true only when the goal is popped with exact dedup only, no prune but the admissible bound's, and the STEP
//          family (every probe-reduced mask for one tick) in every expansion: then it is the exact optimum from the given
//          starts (the first goal popped with an admissible h and reopening).
//   budget: {ms, deadline (epoch ms), stop() -> bool, k (goal arrivals wanted)}: the clock is read every EVERY
//          expansions; it returns within ms + 100 ms.
const T = require('./types.js');

const EVERY = 8;

class NodeHeap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	push(n) {
		const a = this.a;
		a.push(n);
		let i = a.length - 1;
		while (i > 0) { const p = (i - 1) >> 1; if (!less(n, a[p])) break; a[i] = a[p]; i = p; }
		a[i] = n;
	}
	pop() {
		const a = this.a, top = a[0], last = a.pop();
		if (a.length > 0) {
			let i = 0;
			const n = a.length;
			for (;;) {
				let c = 2 * i + 1;
				if (c >= n) break;
				if (c + 1 < n && less(a[c + 1], a[c])) c++;
				if (!less(a[c], last)) break;
				a[i] = a[c]; i = c;
			}
			a[i] = last;
		}
		return top;
	}
}
/** f first, then the faster ball (|vx| + |vy|), then the later tick (deeper: nearer the goal at equal f) */
const less = (x, y) => x.f < y.f || (x.f === y.f && (x.sp > y.sp || (x.sp === y.sp && x.tick > y.tick)));

/** the masks from the level start of a node (its start's masks + the edges on its path) */
function masksOf(node) {
	const parts = [];
	let n = node, len = 0;
	while (n.parent) { parts.push(n.edge); len += n.edge.length; n = n.parent; }
	const base = n.baseMasks;
	const out = new Uint8Array(base.length + len);
	out.set(base, 0);
	let o = base.length;
	for (let k = parts.length - 1; k >= 0; k--) { out.set(parts[k], o); o += parts[k].length; }
	return out;
}

/**
 * astar(ctx) -> {ok, goals: [node], expanded, sims, why, closest: node, proven, lbStart}
 * ctx: {sim (this level's EESim), starts: [{snap, masks, tick}], h(sim) -> ticks (admissible; Infinity: no way),
 *       isGoal(sim) -> bool, expand(node, sim) -> [{edge (masks), ticks, event, snap, hash, key, tile, px, py, vx, vy,
 *       onGround, jumps, dead, finished, near}], budget, classDedup, k, beforeTick, stepAll (the STEP family in every
 *       expansion: proven possible), keyOf(sim) (the class key or null), maxNodes, near(sim) (the start's nearness)}
 * closest: the node of the least `near` (an UNWEIGHTED distance to the goal: a child's c.near, else its h; a start's
 *       ctx.near(sim), else its h): never the weighted h of a greedy pass (a start's unweighted h beat every child's
 *       w x h, so the closest was the start in every greedy pass: the planner walled the start's tiles from it)
 */
function astar(ctx) {
	const sim = ctx.sim, budget = ctx.budget || {};
	const t0 = Date.now();
	const deadline = Math.min(budget.deadline || Infinity, t0 + (budget.ms > 0 ? budget.ms : 1000));
	const k = Math.max(1, budget.k || ctx.k || 1);
	const classDedup = ctx.classDedup !== false;
	const maxNodes = ctx.maxNodes || 2e6;
	const best = new Map();          // stateHash -> the smallest tick seen
	const cls = classDedup ? new Map() : null;
	const heap = new NodeHeap();
	const goals = [];
	let expanded = 0, sims = 0, why = 'exhausted', closest = null, lbStart = Infinity, nodes = 0, pruned = 0;
	let classCut = 0;
	for (const s of ctx.starts) {
		sim.restore(s.snap);
		const h = ctx.h(sim);
		if (h < lbStart) lbStart = h;
		const node = { snap: s.snap, tick: s.tick, parent: null, edge: null, baseMasks: s.masks, f: s.tick + h, h, sp: Math.abs(sim.speed_x) + Math.abs(sim.speed_y),
			hash: sim.stateHash(), tile: T.tileOf(sim, sim.width, sim.height), vx: sim.speed_x, vy: sim.speed_y, px: sim.px, py: sim.py, event: 'start', macro: null };
		if (h === Infinity) continue;
		const had = best.get(node.hash);
		if (had !== undefined && had <= node.tick) continue;
		best.set(node.hash, node.tick);
		node.near = ctx.near ? ctx.near(sim) : h;
		if (!closest || node.near < closest.near) closest = node;
		if (ctx.isGoal(sim)) { node.goal = true; node.f = node.tick; }
		heap.push(node); nodes++;
	}
	let goalF = Infinity;
	while (heap.size > 0) {
		if ((expanded & (EVERY - 1)) === 0) {
			if (Date.now() > deadline) { why = 'budget'; break; }
			if (budget.stop && budget.stop()) { why = 'stopped'; break; }
		}
		const n = heap.pop();
		if (n.stale) continue;
		const b = best.get(n.hash);
		if (b !== undefined && b < n.tick) continue;   // a copy reached sooner is (or was) open
		if (n.goal) {
			goals.push(n);
			if (goals.length === 1) goalF = n.f;
			if (goals.length >= k) { why = 'found'; break; }
			continue;
		}
		if (goals.length && n.f > goalF + (ctx.slack || 0)) { why = 'found'; break; }
		if (n.expanded) continue;
		n.expanded = true;
		expanded++;
		sim.restore(n.snap);
		const kids = ctx.expand(n, sim, best, cls);
		n.snap = null;
		for (const c of kids) {
			sims += c.ticks;
			if (c.dead && !ctx.allowDeath) continue;
			const tick = n.tick + c.ticks;
			if (ctx.beforeTick !== undefined && tick > ctx.beforeTick) continue;
			const had = best.get(c.hash);
			if (had !== undefined && had <= tick) continue;
			if (cls && c.key !== null && c.key !== undefined) {
				const ck = cls.get(c.key);
				if (ck !== undefined && ck <= tick) { classCut++; continue; }
				cls.set(c.key, tick);
			}
			best.set(c.hash, tick);
			const h = c.goal ? 0 : c.h;
			if (h === Infinity) { pruned++; continue; }
			if (ctx.beforeTick !== undefined && tick + h > ctx.beforeTick) { pruned++; continue; }
			if (ctx.bound !== undefined && !c.goal && tick + (c.h0 !== undefined ? c.h0 : h) >= ctx.bound) { pruned++; continue; }
			if (ctx.bound !== undefined && c.goal && tick >= ctx.bound) { pruned++; continue; }
			const node = { snap: c.snap, tick, parent: n, edge: c.edge, f: tick + h, h, sp: Math.abs(c.vx) + Math.abs(c.vy), hash: c.hash, tile: c.tile, vx: c.vx, vy: c.vy,
				px: c.px, py: c.py, event: c.event, macro: c.macro, goal: !!c.goal, near: c.goal ? 0 : c.near !== undefined ? c.near : h };
			if (!closest || node.near < closest.near || (node.near === closest.near && tick < closest.tick)) closest = node;
			if (node.goal && ctx.greedy) { goals.push(node); if (goals.length === 1) goalF = node.f; continue; }
			heap.push(node); nodes++;
		}
		if (ctx.greedy && goals.length >= k) { why = 'found'; break; }
		if (nodes > maxNodes) { why = 'budget'; break; }
	}
	if (goals.length && why !== 'found') why = 'found';
	const proven = goals.length > 0 && !classDedup && classCut === 0 && !!ctx.stepAll && (why === 'found');
	return { ok: goals.length > 0, goals, expanded, sims, why, closest, proven, lbStart, nodes, pruned, classCut, ms: Date.now() - t0 };
}

module.exports = { astar, masksOf, NodeHeap };
