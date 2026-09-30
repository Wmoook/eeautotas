'use strict';
// THE ABSTRACT PLANNER (n4plan, part 'planner': the compiler's PLAN stage and the CEGAR loop's planning side).
// createPlanner(model, facts, {bounds, seed}) -> {plan, learn, lowerBound, costOf, explain, stats}.
//
// The abstract graph: a node = (S, position): S the model's abstract state (the features some gate reads, the coin tiles
// taken), the position the tiles of the last trigger touched (or the anchor's tile; after a death step the respawn
// tiles). Edges: "touch trigger X next" for every relevant trigger whose touch changes S and that the walk relaxation
// under S reaches from the position (the walk BFS with its portal hops and the death shortcut: INF there is a proof for
// the relaxation, so no edge is dropped without one); the trophy edge; a death step where only a death reaches a target.
//   - est: facts.okTicks when learned, else max(lb, walk steps x the pace (median of learned ticks / steps, 4 at first));
//     the plans come from a weighted A* on est (k-best, diverse by their first step).
//   - lb: ADMISSIBLE ticks (model.pairLb: ceil(16 (D - 1) / 16.25) of the walk steps D under the lb relaxation, keys
//     sticky, coin gates shut only by the anchor's real counts, the death shortcut; o.bounds.pair where no death can
//     shortcut, the larger of both). lowerBound(anchor): A* on lb with h = the same bound on the level with every gate open
//     (admissible; nodes re-opened on a better g), the optimum when it completes, else the least f on the open list.
//   - B&B: plan(anchor, {depth}) drops every node whose lb to the trophy puts it at depth or past.
// Waypoints (types.js): a trigger -> {kind 'trigger', tiles (a coin trigger's untaken tiles), trig, expect, label}; the
// trophy -> {kind 'trophy'}; a key followed by its door -> a region step past the door (beforeTickFrom 'prev+500', or
// beforeTick when the key is the anchor's own); a death step -> {kind 'region', tiles: the respawn tiles, expect deaths +
// 1, allowDeath}.
// learn(step, result, anchor) -> Fact[] (>= 1, the version bumped, whenever !result.ok): fail -> the next rung; RUNG_MAX
// -> block; why 'proof' -> proof (never from that S again); blockedBy -> needs (the gate's feature first); ok -> ok.
const T = require('./types.js');
const { lbOfSteps, INF, DEAD_TICKS } = require('./model.js');

const PACE0 = 4;              // est ticks per walk step before any learned leg
const EST_W = 1.5;            // the plan search's heuristic weight (est only; the lb search is plain A*)
const KEY_TICKS = 500;
const COLOURS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];

/** a heap on f (then g) */
class Heap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
	pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && Heap.lt(a[l], a[m])) m = l; if (r < a.length && Heap.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
	peek() { return this.a[0]; }
	static lt(x, y) { return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.seq < y.seq))); }
}

function createPlanner(model, facts, o = {}) {
	const L = model.L, W = model.W, H = model.H;
	const bounds = o.bounds && typeof o.bounds.pair === 'function' ? o.bounds : null;
	const ST = { plans: 0, planMs: 0, expands: 0, lbCalls: 0, lbMs: 0, lbExpands: 0, learned: 0, costOf: 0 };
	const paceSamples = [];
	let lastPlans = [], lastWhy = '';
	const relevant = model.triggers.filter((X) => X.relevant && X.kind !== 'trophy');
	const trophyTiles = model.trophyTiles;
	const openS = { key: '__open__', dkey: '__open__', vals: [], feats: {} };
	// ---------------------------------------------------------------- positions
	const posOfTrig = new Map();
	const posOf = (X) => { let p = posOfTrig.get(X.id); if (!p) { p = { id: 't' + X.id, tiles: X.tiles, trig: X.id, extra: 0 }; posOfTrig.set(X.id, p); } return p; };
	const respawnPos = { id: 'respawn', tiles: model.respawn, extra: DEAD_TICKS };
	const idlePos = { id: 'idle', tiles: model.idleTiles, extra: 0 };
	// the fully open level (every tile but the static walls): the heuristics
	let openMask = null;
	const openDist = new Map();
	function hSteps(pos) {
		let d = openDist.get(pos.id);
		if (!d) {
			if (!openMask) { openMask = new Uint8Array(model.N); for (let i = 0; i < model.N; i++) openMask[i] = model.A.cls[i] !== 0 ? 1 : 0; }
			d = model.bfs(openMask, pos.tiles);
			openDist.set(pos.id, d);
		}
		let b = INF;
		for (const t of trophyTiles) if (d[t] < b) b = d[t];
		return b;
	}
	let openResp = null;
	const hMemo = new Map();
	/** the admissible ticks from pos to the trophy on the open level (the death shortcut included) */
	function hLb(pos) {
		const had = hMemo.get(pos.id);
		if (had !== undefined) return had;
		let best = lbOfSteps(hSteps(pos));
		if (model.canDie) {
			const d = openDist.get(pos.id);
			let dk = INF;
			for (let i = 0; i < model.N; i++) if (model.dieTile[i] && d[i] < dk) dk = d[i];
			if (dk < INF) {
				if (openResp === null) openResp = hSteps(respawnPos);
				if (openResp < INF) best = Math.min(best, lbOfSteps(dk) + DEAD_TICKS + lbOfSteps(openResp));
			}
		}
		best += pos.extra || 0;
		hMemo.set(pos.id, best);
		return best;
	}
	const pace = () => {
		if (!paceSamples.length) return PACE0;
		const s = paceSamples.slice().sort((a, b) => a - b);
		return Math.max(1, s[s.length >> 1]);
	};
	// ---------------------------------------------------------------- the anchor
	function anchorOf(anchor) {
		anchor = anchor || {};
		const arr = anchor.arrival || null;
		let S = anchor.S || null, sim = null;
		if (!S || (arr && arr.masks && !anchor._sim)) {
			if (arr && arr.masks) { sim = T.playTo(L, arr.masks, { allowDeath: true }).sim; S = S || model.stateOf(sim); }
			else S = S || model.S0;
		}
		const masks = arr && arr.masks ? arr.masks : new Uint8Array(0);
		let idle = true;
		for (let i = 0; i < masks.length; i++) if (masks[i] & 31) { idle = false; break; }
		const tile = arr && arr.tile !== undefined ? arr.tile : model.startTile;
		const pos = idle ? idlePos : { id: 'a' + tile, tiles: [tile], extra: 0 };
		const cls = arr ? `${Math.round(arr.vx || 0)},${arr.onGround ? 1 : 0}` : '0,1';
		const base = { coins: S.feats.coins !== undefined ? S.feats.coins : 0, bcoins: S.feats.bcoins !== undefined ? S.feats.bcoins : 0 };
		return { S, pos, tick: arr ? arr.tick || 0 : 0, idle, cls, base, sim, arr };
	}
	// ---------------------------------------------------------------- edges
	/** the lb of a leg: the tier-0 bound under the lb relaxation, the primitives' bound where it is sound too */
	function legLb(S, pos, tiles, base) {
		const a = model.pairLb(S, pos, tiles, 'lb', base);
		if (!bounds || model.canDie || model.hasCoinGate.coins || model.hasCoinGate.bcoins || !Number.isFinite(a)) return a;
		let b = 0;
		try { b = bounds.pair(pos.tiles, tiles, model.levelOf(S)); } catch (e) { b = 0; }
		return Number.isFinite(b) ? Math.max(a, b + (pos.extra || 0)) : a;
	}
	/**
	 * the edges of node (S, pos): [{X (null: the trophy), S2, pos2, expect, lb, est, steps, viaDeath, edge}]; mode 'lb':
	 * every edge the relaxation keeps (no facts); 'plan': the facts' blocks / proofs / needs applied at the root
	 */
	function edgesOf(S, pos, base, mode, root, rootCls) {
		const out = [];
		const P = pace();
		for (const X of relevant) {
			if (pos.trig === X.id && !(X.kind === 'psw' || X.kind === 'osw')) continue;
			const tr = model.touch(S, X);
			if (!tr.changed) continue;
			const live = model.liveTiles(S, X);
			const edge = 'trig:' + X.id;
			if (mode === 'plan') {
				const cls = root ? rootCls : S.key + '|*';
				if (facts && facts.blocked(edge, cls, S.key)) continue;
				if (facts && facts.needsOf(edge, cls).some((n) => S.feats[n.feat] !== n.value)) continue;
			}
			const info = model.pairInfo(S, pos, live, 'est', base);
			if (info.steps >= INF) continue;
			const lb = mode === 'lb' || mode === 'plan' ? legLb(S, pos, live, base) : 0;
			if (!Number.isFinite(lb)) continue;
			let est = Math.max(lb, info.steps * P + (info.viaDeath ? DEAD_TICKS : 0) + (pos.extra || 0));
			if (mode === 'plan' && facts) { const ok = facts.okTicks(edge, root ? rootCls : S.key + '|*'); if (ok !== undefined) est = Math.max(lb, ok); }
			out.push({ X, S2: tr.S2, pos2: posOf(X), expect: tr.expect, lb, est, steps: info.steps, viaDeath: info.viaDeath, edge, live });
		}
		// the trophy
		const info = model.pairInfo(S, pos, trophyTiles, 'est', base);
		if (info.steps < INF) {
			const edge = 'trophy';
			const cls = root ? rootCls : S.key + '|*';
			const blocked = mode === 'plan' && facts && (facts.blocked(edge, cls, S.key) || facts.needsOf(edge, cls).some((n) => S.feats[n.feat] !== n.value));
			if (!blocked) {
				const lb = legLb(S, pos, trophyTiles, base);
				if (Number.isFinite(lb)) {
					let est = Math.max(lb, info.steps * P + (info.viaDeath ? DEAD_TICKS : 0) + (pos.extra || 0));
					if (mode === 'plan' && facts) { const ok = facts.okTicks(edge, cls); if (ok !== undefined) est = Math.max(lb, ok); }
					out.push({ X: null, S2: S, pos2: null, expect: null, lb, est, steps: info.steps, viaDeath: info.viaDeath, edge, live: trophyTiles });
				}
			}
		}
		return out;
	}
	// ---------------------------------------------------------------- the lower bound
	/**
	 * lowerBound(anchor, o) -> {ticks, complete, expanded, ms}: the admissible ticks from the anchor's state to the trophy
	 * (the run timer's: an anchor before any input gets its idle trajectory free and 2 ticks off for the first input's
	 * tick). o.ms (1500), o.maxExpand (200000).
	 */
	function lowerBound(anchor, lo = {}) {
		const t0 = Date.now();
		ST.lbCalls++;
		const a = anchorOf(anchor);
		const ms = lo.ms !== undefined ? lo.ms : 1500, maxExpand = lo.maxExpand || 200000;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, goal = Infinity, complete = false;
		const k0 = a.S.key + '#' + a.pos.id;
		best.set(k0, 0);
		open.push({ S: a.S, pos: a.pos, g: 0, f: hLb(a.pos), seq: seq++, goal: false });
		while (open.size) {
			const n = open.pop();
			if (n.goal) { goal = n.g; complete = true; break; }
			const k = n.S.key + '#' + n.pos.id;
			if (best.get(k) < n.g) continue;
			if (expanded >= maxExpand || Date.now() - t0 > ms) { open.push(n); break; }
			expanded++;
			for (const e of edgesOf(n.S, n.pos, a.base, 'lb', false, null)) {
				const g2 = n.g + e.lb;
				if (!e.X) { open.push({ S: n.S, pos: null, g: g2, f: g2, seq: seq++, goal: true }); continue; }
				const k2 = e.S2.key + '#' + e.pos2.id;
				const had = best.get(k2);
				if (had !== undefined && had <= g2) continue;
				best.set(k2, g2);
				open.push({ S: e.S2, pos: e.pos2, g: g2, f: g2 + hLb(e.pos2), seq: seq++, goal: false });
			}
		}
		let ticks;
		if (complete) ticks = goal;
		else if (!open.size) { ticks = Infinity; complete = true; }
		else { ticks = Infinity; for (const n of open.a) if (n.f < ticks) ticks = n.f; }
		if (a.idle && Number.isFinite(ticks)) ticks = Math.max(0, ticks - 2);
		ST.lbExpands += expanded; ST.lbMs += Date.now() - t0;
		return { ticks, complete, expanded, ms: Date.now() - t0 };
	}
	// ---------------------------------------------------------------- the plan search
	function search(a, po, exclude) {
		const t0 = Date.now();
		const ms = po.ms, maxExpand = po.maxExpand;
		const budget = po.depth > 0 ? po.depth - a.tick : Infinity;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, found = null, pruned = 0;
		const P = pace();
		const root = { S: a.S, pos: a.pos, g: 0, gl: 0, parent: null, e: null, depth: 0, seq: seq++ };
		root.f = EST_W * hSteps(a.pos) * P;
		open.push(root);
		best.set(a.S.key + '#' + a.pos.id, 0);
		let bestPartial = root;
		const better = (x, y) => x.S.gain > y.S.gain || (x.S.gain === y.S.gain && x.f < y.f);
		let rootEdges = 0;
		while (open.size) {
			const n = open.pop();
			if (n.goal) { found = n; break; }
			const k = n.S.key + '#' + n.pos.id;
			if (best.get(k) < n.g) continue;
			if (expanded >= maxExpand || Date.now() - t0 > ms) break;
			expanded++;
			if (better(n, bestPartial)) bestPartial = n;
			const isRoot = n === root;
			const es = edgesOf(n.S, n.pos, a.base, 'plan', isRoot, a.S.key + '|' + a.cls);
			if (isRoot) rootEdges = es.length;
			for (const e of es) {
				if (isRoot && exclude.has(e.edge)) continue;
				const g2 = n.g + e.est, gl2 = n.gl + e.lb;
				if (!e.X) {
					if (gl2 >= budget) { pruned++; continue; }
					open.push({ S: n.S, pos: null, g: g2, gl: gl2, f: g2, parent: n, e, depth: n.depth + 1, seq: seq++, goal: true });
					continue;
				}
				const hl = hLb(e.pos2);
				if (gl2 + hl >= budget) { pruned++; continue; }
				const k2 = e.S2.key + '#' + e.pos2.id;
				const had = best.get(k2);
				if (had !== undefined && had <= g2) continue;
				best.set(k2, g2);
				open.push({ S: e.S2, pos: e.pos2, g: g2, gl: gl2, f: g2 + EST_W * hSteps(e.pos2) * P, parent: n, e, depth: n.depth + 1, seq: seq++, goal: false });
			}
		}
		ST.expands += expanded;
		return { found, bestPartial: bestPartial === root ? null : bestPartial, expanded, ms: Date.now() - t0, pruned, rootEdges, exhausted: !open.size && !found };
	}
	/** the path of a search node -> the plan's steps (with the key-door passages and death steps inserted) */
	function stepsOf(a, node) {
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push({ e: n.e, from: n.parent });
		path.reverse();
		const steps = [];
		let deathsNow = null;
		const push = (st) => { st.n = steps.length; steps.push(st); };
		for (let i = 0; i < path.length; i++) {
			const { e, from } = path[i];
			const isRoot = i === 0;
			const cls = isRoot ? a.S.key + '|' + a.cls : from.S.key + '|*';
			// a death first where only a death reaches the target
			if (e.viaDeath) {
				if (deathsNow === null) deathsNow = a.sim ? a.sim.deaths : 0;
				const edge = `death:${deathsNow}`;
				push({ edge, nodeClass: cls, rung: facts ? facts.rungOf(edge, cls) : 0, estTicks: DEAD_TICKS, lb: DEAD_TICKS,
					waypoint: { kind: 'region', tiles: model.respawn.slice(), expect: { feat: 'deaths', value: deathsNow + 1 }, allowDeath: true, label: `die, back at a respawn (deaths ${deathsNow + 1})` } });
				deathsNow++;
			}
			// the anchor's own active key: its door first, before the key runs out
			if (isRoot && a.sim && (!e.X || e.X.kind !== 'key')) {
				const pass = keyPassage(a.S, a.pos, e, a.base);
				if (pass) {
					const c = pass.colour, left = KEY_TICKS - (a.sim._ticks - a.sim._kt[c]);
					if (left > 0) push({ edge: `region:key${c}-door`, nodeClass: cls, rung: facts ? facts.rungOf(`region:key${c}-door`, cls) : 0, estTicks: 0, lb: 0,
						waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTick: a.tick + left - 1, label: `past the ${COLOURS[c] || c} key door` } });
				}
			}
			const X = e.X;
			const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: X.label } : { kind: 'trophy', label: 'trophy' };
			push({ edge: e.edge, nodeClass: cls, rung: facts ? facts.rungOf(e.edge, cls) : 0, waypoint: wp, estTicks: Math.round(e.est), lb: e.lb });
			// a key followed by its door: the passage while the key is on
			if (X && X.kind === 'key' && i + 1 < path.length) {
				const next = path[i + 1].e;
				const pass = keyPassage(e.S2, e.pos2, next, a.base, X.param);
				if (pass) push({ edge: `region:key${X.param}-door`, nodeClass: e.S2.key + '|*', rung: facts ? facts.rungOf(`region:key${X.param}-door`, e.S2.key + '|*') : 0, estTicks: 0, lb: 0,
					waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTickFrom: 'prev+500', label: `past the ${COLOURS[X.param] || X.param} key door` } });
			}
		}
		return steps;
	}
	/** the tiles just past a key door that the next edge needs (null: it needs none): the tiles next to a door of that
	 *  colour that the key-off state cannot reach from the position but the key-on state can */
	function keyPassage(S, pos, next, base, colour) {
		const cols = colour !== undefined ? [colour] : [0, 1, 2, 3, 4, 5].filter((c) => S.feats['key' + c] === 1);
		for (const c of cols) {
			const f = 'key' + c;
			if (S.feats[f] !== 1) continue;
			const vals = S.vals.slice(); vals[model.fIdx.get(f)] = 0;
			const Soff = model.mkState(vals, S.taken, S.btaken);
			const dOff = model.dist(Soff, pos, 'est', base), dOn = model.dist(S, pos, 'est', base);
			const tgt = next.live || trophyTiles;
			let off = INF, on = INF;
			for (const t of tgt) { if (dOff[t] < off) off = dOff[t]; if (dOn[t] < on) on = dOn[t]; }
			if (off < INF && off <= on + 2) continue;
			// the tiles next to a door of colour c, reachable with the key on, not with it off
			const tiles = [];
			for (let i = 0; i < model.N; i++) {
				if (dOff[i] < INF || dOn[i] >= INF || model.A.cls[i] === 0 || model.A.cls[i] === 3) continue;
				const x = i % W, y = (i / W) | 0;
				let near = false;
				for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1) && !near; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
					const j = yy * W + xx;
					if (model.A.cls[j] === 3 && model.A.gateFeat[j] === f && model.A.gatePol[j] === 1) { near = true; break; }
				}
				if (near) tiles.push(i);
			}
			if (tiles.length) return { colour: c, tiles };
		}
		return null;
	}
	/**
	 * plan(anchor, {k, depth, epoch, ms, maxExpand}) -> Plan[] (with .why when empty: 'exhausted' | 'proof')
	 */
	function plan(anchor, po = {}) {
		const t0 = Date.now();
		ST.plans++;
		const a = anchorOf(anchor);
		const k = po.k || 3;
		const first = ST.plans === 1;
		const so = { ms: po.ms || (first ? 2000 : 300), maxExpand: po.maxExpand || 200000, depth: po.depth || 0 };
		const plans = [], exclude = new Set();
		let why = '', rootEdges = -1, anyExhausted = false;
		for (let r = 0; r < k; r++) {
			const res = search(a, so, exclude);
			if (rootEdges < 0) rootEdges = res.rootEdges;
			const node = res.found || res.bestPartial;
			if (!node) { anyExhausted = anyExhausted || res.exhausted; break; }
			const steps = stepsOf(a, node);
			if (!steps.length) break;
			const lbTail = res.found ? 0 : hLb(node.pos);
			plans.push({ id: `p${ST.plans}.${r}`, steps, cost: Math.round(node.g + (res.found ? 0 : pace() * hSteps(node.pos))), lb: node.gl + lbTail, partial: !res.found, why: res.found ? 'trophy' : 'budget: the most gain', expanded: res.expanded });
			exclude.add(steps[0].edge);
			// (the first step's own edge: a death or passage step was inserted before the real first edge)
			let n = node; while (n.parent && n.parent.parent) n = n.parent;
			if (n.e) exclude.add(n.e.edge);
		}
		if (!plans.length) {
			why = rootEdges === 0 && !(facts && facts.list().length) ? 'proof' : 'exhausted';
			// (no edge at the root because the facts took them all: exhausted; none at all without facts: a walk proof)
			if (rootEdges === 0 && facts && facts.list().length) {
				const raw = edgesOf(a.S, a.pos, a.base, 'lb', false, null);
				why = raw.length ? 'exhausted' : 'proof';
			}
		}
		lastPlans = plans; lastWhy = why;
		ST.planMs += Date.now() - t0;
		const out = plans;
		out.why = why;
		out.plans = plans;
		return out;
	}
	// ---------------------------------------------------------------- CEGAR
	/** the value of the feature gate tile i reads that opens it */
	function openValue(i, S) {
		const A = model.A, k = A.gateFeat[i], pol = A.gatePol[i], p = A.gateParam[i];
		if (!k || k === 'open' || k === 'time' || k === 'static') return null;
		if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'crown') return pol === 1 ? 1 : 0;
		if (k === 'team') return pol === 1 ? p : null;
		if (k === 'coins' || k === 'bcoins') return pol === 1 ? p : null;
		return null;
	}
	/**
	 * learn(step, result, anchor) -> Fact[]: at least one whenever !result.ok (the facts' version bumps with each).
	 */
	function learn(step, result, anchor) {
		ST.learned++;
		const out = [];
		if (!facts) return out;
		const edge = step.edge, cls = step.nodeClass;
		const a = anchor ? anchorOf(anchor) : null;
		if (result && result.ok) {
			const arr = result.arrivals && result.arrivals[0];
			const ticks = arr && a ? Math.max(0, arr.tick - a.tick) : (result.ticks || 0);
			out.push(facts.add({ kind: 'ok', edge, nodeClass: cls, ticks, lb: step.lb || 0 }));
			if (a && step.waypoint && step.waypoint.tiles) {
				const d = model.pairSteps(a.S, a.pos, step.waypoint.tiles, 'est', a.base);
				if (d > 0 && d < INF && ticks > 0) paceSamples.push(ticks / d);
			}
			return out;
		}
		const fail = (result && result.fail) || { why: 'budget' };
		const sKey = a ? a.S.key : (cls || '').split('|')[0];
		if (fail.why === 'proof') out.push(facts.add({ kind: 'proof', edge, sKey }));
		for (const b of fail.blockedBy || []) {
			if (!a || b.tile === undefined) continue;
			const f = b.feat || model.A.gateFeat[b.tile];
			const v = openValue(b.tile, a.S);
			if (!f || v === null || v === undefined || a.S.feats[f] === v) continue;
			out.push(facts.add({ kind: 'needs', edge, nodeClass: cls, feat: f, value: v }));
		}
		const rung = facts.rungOf(edge, cls);
		out.push(facts.add({ kind: 'fail', edge, nodeClass: cls, rung, why: fail.why || 'budget', closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [] }));
		if (rung + 1 >= facts.RUNG_MAX) out.push(facts.add({ kind: 'block', edge, nodeClass: cls }));
		return out;
	}
	// ---------------------------------------------------------------- the truth checker's price of an order
	/**
	 * costOf(order, anchor) -> {lb, est, feasible, why, legs}: the order's legs priced like the plans' (lb: sound for
	 * any real route that touches the triggers in this order, the trophy last). order: trigger ids (or 'trig:<id>').
	 */
	function costOf(order, anchor) {
		ST.costOf++;
		const a = anchorOf(anchor);
		let S = a.S, pos = a.pos, lb = 0, est = 0, feasible = true, why = 'ok';
		const legs = [];
		const P = pace();
		const ids = order.map((x) => (typeof x === 'string' ? +String(x).replace(/^trig:/, '') : +x));
		for (let i = 0; i <= ids.length; i++) {
			const X = i < ids.length ? model.triggers[ids[i]] : null;
			if (i < ids.length && !X) { feasible = false; why = `no trigger ${ids[i]}`; break; }
			const tiles = X ? X.tiles : trophyTiles;
			const l = legLb(S, pos, tiles, a.base);
			const steps = model.pairInfo(S, pos, tiles, 'est', a.base).steps;
			if (!Number.isFinite(l)) { feasible = false; why = `leg ${i} to ${X ? X.label : 'the trophy'} unreachable in the model`; legs.push({ to: X ? X.id : 'trophy', lb: Infinity }); break; }
			lb += l; est += Math.max(l, steps < INF ? steps * P : l);
			legs.push({ to: X ? X.id : 'trophy', lb: l });
			if (X) { const tr = model.touch(S, X); S = tr.S2; pos = posOf(X); }
		}
		if (a.idle && feasible) lb = Math.max(0, lb - 2);
		return { lb, est: Math.round(est), feasible, why, legs };
	}
	function explain() {
		if (!lastPlans.length) return `no plan (${lastWhy || 'none yet'})`;
		const p = lastPlans[0];
		return `${p.partial ? 'PARTIAL ' : ''}plan ${p.id}: est ${p.cost} ticks, lb ${p.lb}: ` + p.steps.map((s) => s.waypoint.label + (s.rung ? `[r${s.rung}]` : '')).join(' -> ');
	}
	const stats = () => Object.assign({}, ST, { pace: pace(), model: model.stats() });
	return { plan, learn, lowerBound, costOf, explain, stats, _edgesOf: edgesOf, _hLb: hLb, _anchorOf: anchorOf };
}

module.exports = { createPlanner, PACE0 };
