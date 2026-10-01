'use strict';
// THE ABSTRACT PLANNER (n4plan, part 'planner'): A* over (abstract state S, entry tile) of the level model (model.js) to
// the trophy. An edge is a trigger the region walk of (S, entry) reaches whose touch changes S (the next node: S' at the
// trigger's tile), a key running out ('expire'), a death (the respawn at S's checkpoint or the next spawn: 'die'), a
// checkpoint (where a death could follow), or, once the facts allow it for a node class, a static effect ('enabler').
// Costs: the facts' measured ticks, else the RCH3 physics fields (lazily: only for the edges of the plans about to be
// returned, LazySP style: an edge with no physics way is repriced and A* runs again), else the walk; each times the
// facts' penalty (2^rung, x4 per unmet need). k plans, diverse by their first triggers. Receding horizon: the strategy
// executes steps[0] and plans again from the real arrival.
//
// createPlanner(model, facts, opts) -> {plan(anchor, {k, ms, maxNodes}) -> Plan[] (plans.why), learn(step, stepResult)
//   -> Fact[], explain(plan) -> string, stats()}
// anchor = {arrival (types Arrival), S (model.stateOf; computed from the arrival when missing)}
// Plan = {id, steps: Step[], cost, partial, why}; Step = {n, edge, nodeClass, from, to, waypoint, estTicks, rung,
//   deadline?, kind, fromTick (step 0)}; step.S / step.S2 (non-enumerable): the model states before / after.
const T = require('./types.js');

const TICKS_PER_FIFTH = 0.6;   // ~3 ticks per tile (5 fifths)
const WALK_FACTOR = 1.5;   // the walk is gravity-blind: its estimate x 1.5
const DIE_TICKS = 54;
const PHYS_NONE_PEN = 20;   // an edge with no physics way at rest (it may need speed): x 20, not removed
const COIN_BRANCH = 3;

let planSeq = 0;
function createPlanner(model, facts, opts = {}) {
	const M = model;
	const physKnown = new Map();   // doorKey|trig|entry -> fifths (Infinity: none at rest)
	const anchorEx = new Map();   // anchor hash -> Set(edge): a real state's proof (RCH3 -1 with the doors as now)
	const st = { plans: 0, astar: 0, nodes: 0, ms: 0, physChecks: 0, reruns: 0, lastMs: 0 };
	const featGates = new Map();   // feat -> gate type indices
	M.gtypes.forEach((g, i) => { const k = g.kind === 0 ? g.feat : g.kind >= 4 ? 'deaths' : null; if (k) { if (!featGates.has(k)) featGates.set(k, []); featGates.get(k).push(i); } });
	const hOf = (t) => (M.hAll[t] >= 0 ? M.hAll[t] : M.hMax + 200) * TICKS_PER_FIFTH;
	const def = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, writable: true });
	/** how many of a trigger's learned needs have every gate shut... any gate of the feat shut under S */
	function unmetOf(S, trig) {
		if (trig === undefined || trig === null) return 0;
		const nd = facts.needs(trig);
		if (!nd.size) return 0;
		const o = M.openTypes(S);
		let u = 0;
		for (const f of nd) { const gs = featGates.get(f); if (gs && gs.some((g) => o[g] === 0)) u++; }
		return u;
	}
	const edgeName = (nc, via) => `${nc}>${via.kind === 'trig' || via.kind === 'cp' || via.kind === 'fx' ? via.id : via.kind === 'expire' ? 'expire:' + via.feat : via.kind === 'explore' ? 'explore:' + via.tile : via.kind}`;
	/** the estimated ticks of an edge: measured, else physics, else the walk */
	function estOf(S, entry, nc, via) {
		const en = edgeName(nc, via);
		const m = facts.measured(en, nc);
		if (m !== null) return m;
		if (via.kind === 'expire') return 0;
		if (via.kind === 'die') return DIE_TICKS + via.walk * TICKS_PER_FIFTH * WALK_FACTOR;
		if (via.kind === 'trig' || via.kind === 'trophy' || via.kind === 'cp' || via.kind === 'fx') {
			const pk = physKnown.get(`${M.doorKey(S)}|${via.kind === 'trophy' ? 'trophy' : via.id}|${entry}`);
			if (pk !== undefined) return Number.isFinite(pk) ? Math.max(1, pk * TICKS_PER_FIFTH) : Math.max(1, via.walk * TICKS_PER_FIFTH * WALK_FACTOR) * PHYS_NONE_PEN;
		}
		return Math.max(1, via.walk * TICKS_PER_FIFTH * WALK_FACTOR);
	}
	// ---------------------------------------------------------------- one A* run
	function astar(root, ctx) {
		st.astar++;
		const t0 = Date.now();
		const heap = [];
		const less = (a, b) => a.f < b.f || (a.f === b.f && a.h < b.h);
		const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
		const closed = new Map();
		push(root);
		let best = null, goal = null, popped = 0, rootEdges = 0;
		while (heap.length) {
			if (popped >= ctx.maxNodes || Date.now() - t0 > ctx.ms) { ctx.cut = popped >= ctx.maxNodes ? 'nodes' : 'time'; break; }
			const n = pop();
			if (n.goal) { goal = n; break; }
			const R = M.region(n.S, n.entry);
			n.R = R;
			n.nc = n.S.key + '@' + R.regionId;
			const dk = n.S.keyNoCoin + '@' + R.regionId;
			const had = closed.get(dk);
			if (had !== undefined && had <= n.g) continue;
			closed.set(dk, n.g);
			popped++;
			if (n !== root && (!best || n.h < best.h || (n.h === best.h && n.g < best.g))) best = n;
			const kids = expand(n, ctx, n === root);
			if (n === root) rootEdges = kids.length;
			for (const k of kids) push(k);
		}
		st.nodes += popped;
		return { goal, best, popped, rootEdges, ms: Date.now() - t0 };
	}
	/** the successors of node n */
	function expand(n, ctx, isRoot) {
		const S = n.S, R = n.R, nc = n.nc, out = [];
		const ex = isRoot ? ctx.ex : null;
		const add = (via, S2, entry2, goal) => {
			const en = edgeName(nc, via);
			if (facts.blocked(en, nc)) return;
			if (ex && ex.has(en)) return;
			const est = estOf(S, n.entry, nc, via);
			const trig = via.kind === 'trig' || via.kind === 'cp' || via.kind === 'fx' ? via.id : undefined;
			const pen = facts.penalty(en, nc, unmetOf(S, trig)) * (ctx.div.get(nc + '>' + (trig !== undefined ? trig : via.kind)) || 1);
			const g = n.g + Math.max(0, est) * pen;
			const kid = { S: S2, entry: entry2, g, h: goal ? 0 : hOf(entry2), parent: n, via: Object.assign(via, { est, edge: en, nc }), goal: !!goal, depth: n.depth + 1 };
			kid.f = kid.g + kid.h;
			out.push(kid);
		};
		if (R.trophy) add({ kind: 'trophy', tile: R.trophy.tile, walk: R.trophy.dist }, S, R.trophy.tile, true);
		const dk = M.doorKey(S);
		const coinsSeen = { coins: 0, bcoins: 0 };
		for (const e of R.edges) {
			const tr = M.triggers[e.id];
			if (tr.kind === 'coins' || tr.kind === 'bcoins') { if (coinsSeen[tr.kind] >= COIN_BRANCH) continue; }
			const S2 = M.apply(S, e.id);
			if (!S2) continue;
			if (M.doorKey(S2) === dk) {
				// (no door changes: only a count below its highest threshold is progress)
				const prog = (tr.kind === 'coins' || tr.kind === 'bcoins') && tr.fi >= 0 && S.a[tr.fi] < M.capOf[tr.fi];
				if (!prog) continue;
			}
			if (tr.kind === 'coins' || tr.kind === 'bcoins') coinsSeen[tr.kind]++;
			add({ kind: 'trig', id: e.id, tile: e.tile, walk: e.dist }, S2, e.tile);
		}
		// (a death: the respawn at S's checkpoint or the next spawn; the death count a death door / gate reads)
		if (M.dieOK && R.killer && !(M.featIdx.has('prot') && S.a[M.featIdx.get('prot')] === 1)) {
			const d = M.die(S);
			const progress = M.deathDoors > 0 && S.deaths < M.deathCap;
			const moved = d.tile !== n.entry && !(R.tiles.length && regionHas(R, d.tile));
			if (progress || moved) add({ kind: 'die', tile: d.tile, walk: R.killer.dist, killer: R.killer.tile }, d.S, d.tile);
		}
		for (const [feat, S2] of M.expire(S)) add({ kind: 'expire', feat, walk: 0, tile: n.entry }, S2, n.entry);
		// (checkpoints where a death can follow: the 2 nearest and the one nearest the trophy)
		if (M.cpTracked && R.cps.length && R.killer) {
			const pick = R.cps.slice(0, 2);
			let bh = null;
			for (const c of R.cps) if (!bh || hOf(c.tile) < hOf(bh.tile)) bh = c;
			if (bh && !pick.includes(bh)) pick.push(bh);
			for (const c of pick) { const S2 = M.apply(S, c.id); if (S2) add({ kind: 'cp', id: c.id, tile: c.tile, walk: c.dist }, S2, c.tile); }
		}
		// (the effects, once a failure without a named door let this class try them)
		if (M.fxTracked && R.fxs.length && facts.enabled(nc)) {
			for (const c of R.fxs.slice(0, 3)) { const S2 = M.apply(S, c.id); if (S2) add({ kind: 'fx', id: c.id, tile: c.tile, walk: c.dist }, S2, c.tile); }
		}
		return out;
	}
	function regionHas(R, t) {
		if (!R._set) { const s = new Set(); for (const x of R.tiles) s.add(x); def(R, '_set', s); }
		return R._set.has(t);
	}
	// ---------------------------------------------------------------- plans from A* results
	function waypointOf(n, via) {
		const S = n.S;
		const label = (s) => s;
		switch (via.kind) {
			case 'trophy': return { kind: 'trophy', label: 'trophy' };
			case 'trig': case 'cp': case 'fx': {
				const tr = M.triggers[via.id];
				const S2 = M.apply(S, via.id) || S;
				return { kind: 'trigger', tiles: tr.tiles.slice(), trig: via.id, expect: M.expectOf(S, via.id, S2), label: label(M.trigLabel(via.id)) };
			}
			case 'die': return { kind: 'region', tiles: [via.tile], expect: { feat: 'deaths', value: S.deaths + 1 }, allowDeath: true, label: `die (killer @${M.xy(via.killer)}), respawn @${M.xy(via.tile)}` };
			case 'expire': return { kind: 'region', tiles: Array.from(n.R.tiles), expect: { feat: via.feat, value: 0 }, label: `wait: ${via.feat} runs out` };
			case 'explore': return { kind: 'region', tiles: via.tiles, expect: null, label: via.label };
		}
		return null;
	}
	function planOf(end, root, anchor, partial, why) {
		const chain = [];
		for (let n = end; n && n !== root; n = n.parent) chain.push(n);
		chain.reverse();
		const steps = [];
		let elapsed = 0;
		const keyAt = new Map();   // key feat -> elapsed at pickup
		chain.forEach((kid, i) => {
			const n = kid.parent, via = kid.via;
			const step = {
				n: i, kind: via.kind, edge: via.edge, nodeClass: via.nc,
				from: { key: n.S.key, tile: n.entry, region: n.R.regionId, desc: M.describe(n.S) },
				to: { key: kid.S.key, tile: kid.entry, desc: M.describe(kid.S) },
				waypoint: waypointOf(n, via), estTicks: Math.round(via.est), rung: facts.rung(via.edge, via.nc),
			};
			if (i === 0) step.fromTick = anchor.arrival ? anchor.arrival.tick : 0;
			// (a key taken: the steps after it that still hold it have a deadline: it runs out after 500 ticks)
			for (const [feat, at] of keyAt) { const fi = M.featIdx.get(feat); if (fi !== undefined && n.S.a[fi] === 1) step.deadline = Math.max(50, Math.min(step.deadline || 1e9, 450 - (elapsed - at))); else keyAt.delete(feat); }
			elapsed += Math.max(0, via.est);
			if (via.kind === 'trig' && M.triggers[via.id].kind === 'key') keyAt.set('key' + M.triggers[via.id].param, elapsed);
			def(step, 'S', n.S); def(step, 'S2', kid.S); def(step, 'R', n.R);
			steps.push(step);
		});
		return { id: ++planSeq, steps, cost: Math.round(end.g), partial: !!partial, why: why || (partial ? 'partial' : 'trophy') };
	}
	/** the explore step when the root has no usable trigger: the region's tiles farthest by walk (then those nearest the
	 *  trophy, the highest, the lowest), the first group whose edge is not blocked */
	function explorePlan(root, anchor, ctx) {
		const R = root.R || M.region(root.S, root.entry);
		root.R = R; root.nc = root.S.key + '@' + R.regionId;
		const n = R.tiles.length;
		if (n <= 1) return null;
		const idx = Array.from({ length: n }, (_, i) => i);
		const W = M.W;
		const groups = [];
		const take = (order, label) => { const k = Math.max(1, Math.min(64, Math.ceil(n * 0.05))); groups.push({ tiles: order.slice(0, k).map((i) => R.tiles[i]), label }); };
		take(idx.slice().sort((a, b) => R.d[b] - R.d[a] || R.tiles[a] - R.tiles[b]), 'explore: the farthest tiles by walk');
		take(idx.slice().sort((a, b) => hOf(R.tiles[a]) - hOf(R.tiles[b]) || R.tiles[a] - R.tiles[b]), 'explore: the tiles nearest the trophy');
		take(idx.slice().sort((a, b) => ((R.tiles[a] / W) | 0) - ((R.tiles[b] / W) | 0) || R.tiles[a] - R.tiles[b]), 'explore: the highest tiles');
		take(idx.slice().sort((a, b) => ((R.tiles[b] / W) | 0) - ((R.tiles[a] / W) | 0) || R.tiles[a] - R.tiles[b]), 'explore: the lowest tiles');
		const seen = new Set();
		for (const g of groups) {
			const key = g.tiles.slice().sort((a, b) => a - b).join(',');
			if (seen.has(key) || (g.tiles.length === 1 && g.tiles[0] === root.entry)) continue;
			seen.add(key);
			const via = { kind: 'explore', tile: Math.min(...g.tiles), tiles: g.tiles, label: g.label, walk: 0 };
			const en = edgeName(root.nc, via);
			if (facts.blocked(en, root.nc) || ctx.ex.has(en)) continue;
			via.est = 300; via.edge = en; via.nc = root.nc;
			const kid = { S: root.S, entry: via.tile, g: 300 * facts.penalty(en, root.nc), h: 0, parent: root, via, goal: false, depth: 1 };
			return planOf(kid, root, anchor, true, 'no trigger');
		}
		return null;
	}
	// ---------------------------------------------------------------- physics checks of the plans' first edges
	function physCheck(plans, root, anchor, ctx) {
		let changed = false;
		for (const p of plans) {
			for (const s of p.steps.slice(0, ctx.physSteps)) {
				if (Date.now() > ctx.physDeadline) return changed;
				if (s.kind !== 'trig' && s.kind !== 'trophy' && s.kind !== 'cp' && s.kind !== 'fx') continue;
				const trig = s.kind === 'trophy' ? 'trophy' : s.waypoint.trig;
				const pk = `${M.doorKey(s.S)}|${trig}|${s.from.tile}`;
				if (s.n === 0 && ctx.sim && !ctx.checked.has(s.edge)) {
					// (from the REAL state: the doors as they stand now; -1 is a proof for this state)
					ctx.checked.add(s.edge);
					st.physChecks++;
					const tiles = trig === 'trophy' ? M.trophies : M.triggers[trig].tiles;
					const v = M.anchorCost(ctx.sim, tiles);
					if (v < 0) { ctx.ex.add(s.edge); changed = true; continue; }
					if (!physKnown.has(pk)) { physKnown.set(pk, v * 5); changed = changed || Math.abs(v * 5 * TICKS_PER_FIFTH - s.estTicks) > 0.25 * s.estTicks + 10; }
					continue;
				}
				if (physKnown.has(pk)) continue;
				st.physChecks++;
				const v = M.edgeCost(s.S, trig, s.from.tile);
				physKnown.set(pk, v);
				if (!Number.isFinite(v) || Math.abs(v * TICKS_PER_FIFTH - s.estTicks) > 0.25 * s.estTicks + 10) changed = true;
			}
		}
		return changed;
	}
	// ---------------------------------------------------------------- plan()
	function plan(anchor, o = {}) {
		const t0 = Date.now();
		st.plans++;
		const k = o.k || 3, ms = o.ms || opts.ms || 3000, maxNodes = o.maxNodes || opts.maxNodes || 100000;
		const arrival = anchor.arrival || { tile: M.startTile, tick: 0, masks: new Uint8Array(0) };
		let S = anchor.S;
		let sim = null;
		const wantPhys = o.physics !== undefined ? o.physics : opts.physics !== false;
		if (!S || wantPhys) { try { sim = M.simAt(arrival); } catch (e) { sim = null; } }
		if (!S) { S = sim ? M.stateOf(sim) : M.startState(); anchor.S = S; }
		if (arrival.finished) { const out = [{ id: ++planSeq, steps: [], cost: 0, partial: false, why: 'finished' }]; out.why = 'finished'; return out; }
		const ahash = arrival.hash !== undefined ? String(arrival.hash) + ':' + arrival.tick : 'start';
		if (!anchorEx.has(ahash)) anchorEx.set(ahash, new Set());
		const ctx = { ex: anchorEx.get(ahash), div: new Map(), maxNodes, ms, sim: wantPhys ? sim : null, checked: new Set(), physSteps: o.physSteps || opts.physSteps || 3,
			physDeadline: t0 + (o.physMs !== undefined ? o.physMs : opts.physMs !== undefined ? opts.physMs : 2000) };
		const mkRoot = () => ({ S, entry: arrival.tile, g: 0, h: hOf(arrival.tile), f: hOf(arrival.tile), parent: null, via: null, goal: false, depth: 0 });
		let plans = [], why = null;
		for (let round = 0; round < (wantPhys ? 4 : 1); round++) {
			plans = []; ctx.div = new Map();
			const sigs = new Set();
			let rootEdgesAny = 0;
			for (let attempt = 0; attempt < k * 3 && plans.length < k; attempt++) {
				const left = ms - (Date.now() - t0);
				ctx.ms = attempt === 0 ? Math.max(200, left * 0.6) : Math.max(100, left / (k * 3 - attempt));
				if (attempt > 0 && left < 100) break;
				const root = mkRoot();
				const r = astar(root, ctx);
				rootEdgesAny += r.rootEdges;
				let p = null;
				if (r.goal) p = planOf(r.goal, root, anchor, false, 'trophy');
				else if (r.best) p = planOf(r.best, root, anchor, true, `partial (${ctx.cut || 'no trophy in the model'}): the node nearest the trophy`);
				if (!p) break;
				const sig = p.steps.slice(0, 3).map((s) => s.edge.split('>').pop()).join(' ');
				if (!sigs.has(sig)) { sigs.add(sig); plans.push(p); }
				for (const s of p.steps) { const key = s.nodeClass + '>' + (s.waypoint && s.waypoint.trig !== undefined ? s.waypoint.trig : s.kind); ctx.div.set(key, (ctx.div.get(key) || 1) * 2); }
				if (!r.goal && !r.best) break;
			}
			if (!plans.length) {
				const root = mkRoot();
				const p = explorePlan(root, anchor, ctx);
				if (p) plans = [p]; else why = 'exhausted';
				break;
			}
			if (!wantPhys || Date.now() > ctx.physDeadline) break;
			if (!physCheck(plans, null, anchor, ctx)) break;
			st.reruns++;
		}
		// (the plans in cost order; a plan whose first edge a proof from this state removed is gone by the re-run)
		plans = plans.filter((p) => !(p.steps.length && ctx.ex.has(p.steps[0].edge)));
		if (!plans.length && !why) {
			const root = mkRoot();
			const p = explorePlan(root, anchor, ctx);
			if (p) plans = [p]; else why = 'exhausted';
		}
		plans.sort((a, b) => (a.partial ? 1 : 0) - (b.partial ? 1 : 0) || a.cost - b.cost);
		plans.why = why || (plans.length ? plans[0].why : 'exhausted');
		st.lastMs = Date.now() - t0; st.ms += st.lastMs;
		return plans;
	}
	// ---------------------------------------------------------------- learn(): CEGAR
	function learn(step, res) {
		const out = [];
		const rec = (f) => { facts.record(f); out.push(f); };
		if (!step) return out;
		if (res && res.ok) {
			let ticks = null;
			if (res.arrivals && res.arrivals.length && Number.isFinite(step.fromTick)) ticks = Math.min(...res.arrivals.map((a) => a.tick)) - step.fromTick;
			rec({ kind: 'ok', edge: step.edge, nodeClass: step.nodeClass, ticks });
			return out;
		}
		const fail = (res && res.fail) || { why: 'budget' };
		if (fail.why === 'stopped') return out;
		if (fail.why === 'proof') rec({ kind: 'proof', edge: step.edge, nodeClass: step.nodeClass });
		else rec({ kind: 'fail', edge: step.edge, nodeClass: step.nodeClass, rung: step.rung | 0, why: fail.why });
		const S = step.S;
		let named = 0;
		for (const b of fail.blockedBy || []) {
			let feat = b.feat;
			if (!feat && b.tile >= 0 && M.gtype[b.tile] >= 0) { const g = M.gtypes[M.gtype[b.tile]]; feat = g.kind === 0 ? g.feat : g.kind >= 4 ? 'deaths' : null; }
			if (!feat) continue;
			// (a need only where its gate is shut in the step's state)
			let shut = true;
			if (S && b.tile >= 0 && M.gtype[b.tile] >= 0) shut = M.openTypes(S)[M.gtype[b.tile]] === 0;
			else if (S) { const gs = featGates.get(feat); shut = !!gs && gs.some((g) => M.openTypes(S)[g] === 0); }
			if (!shut) continue;
			const trig = step.waypoint && step.waypoint.trig !== undefined ? step.waypoint.trig : step.kind;
			rec({ kind: 'needs', trig, feat });
			named++;
		}
		if (fail.touched && fail.touched.length) rec({ kind: 'side', edge: step.edge, touched: fail.touched });
		if ((step.rung | 0) >= 1 && !named && M.fxTracked) rec({ kind: 'enable', nodeClass: step.nodeClass });
		return out;
	}
	function explain(p) {
		if (!p) return '(no plan)';
		const head = `${p.partial ? 'PARTIAL ' : ''}plan ${p.id} cost ${p.cost} (${p.why}), ${p.steps.length} steps: `;
		return head + p.steps.map((s) => `${s.n + 1}. ${s.waypoint ? s.waypoint.label : s.kind} [${s.to.desc}] ~${s.estTicks}t r${s.rung}${s.deadline ? ' by ' + s.deadline : ''}`).join(' -> ');
	}
	function stats() { return Object.assign({}, st, { model: Object.assign({}, M.stats), facts: facts.stats ? facts.stats() : null }); }
	return { plan, learn, explain, stats, _physKnown: physKnown, _anchorEx: anchorEx };
}

module.exports = { createPlanner, TICKS_PER_FIFTH };
