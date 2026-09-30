'use strict';
// THE LEG FINDERS (n4plan, part 'executor', tier 3 of reach()): not proofs, finders; every find is replayed by the
// executor. Both search from real states (each start injected at its own ABSOLUTE tick), the masks of each state from
// endgame.probeMasks (the same states, fewer simulations), over cells of position and speed (with on the ground, the jump
// count, the ball's door-reading state: exact.js discKey), inside a region (the tiles the goal field's walk reaches,
// dilated by a tile, in a box around the starts and the goal), ranked by a TIME estimate (ticks): the admissible
// kinematic bound (endgame.lowerBound) within 64 ticks of the goal, else the goal field's distance at the running pace (or
// the primitives' tick field when bounds are given). The distance alone is blind to speed: a beam by it kept the slow
// states at a wall's face and lost the run-ups (the key door leg of test/planexec.js: 184 ticks vs 38).
//   legBest (the executor's default): best-first, f = the tick + w x the estimate (w 5), the first arrival closes its
//     cell (2 px x, 4 px y, 1/8 px/tick vx, 1/4 vy); it dives toward the goal and falls back to the next best open state
//     where it is stuck (T-EXEC-LEGS, box 3, 3 s: 56% of the legs vs the beam's 30%; p90 of the ticks over the route's
//     own 1.44x vs 2.1x).
//   legBFS: src/legsearch.js's algorithm (copied, not edited): breadth-first by tick keeping the FASTEST state of each
//     FINE cell (1 px x, 2 px y, 1/16, 1/8 px/tick), a layer over its width kept by the estimate with at most 8 states a
//     tile (flybeam.js's rule), the rest by
//     novelty per tile; the width widens (x4) when a pass ends without a goal (the depth limit, exhausted, or no nearer
//     state for `stall` layers).
//
//   legBFS(L, starts, goal, o) -> {status 'found' | 'exhausted' | 'depth' | 'time' | 'stopped', tick (absolute), start,
//        tail, goals [{start, tail, depth}], passes [{width, layers, sims, why}], sims, closest {dist, start, tail},
//        seconds}
//   o: {sim, deadline, stop, allowDeath, beforeTick, field (goal field: ordering + distances), region (Uint8Array | null),
//       width0 (1000), widthMax (80000), depthMax (layers from the earliest start), stall (layers without a nearer state,
//       default 200), extra (layers kept on after the first goal to gather more arrivals, default 3), collect (4000)}
const E = require('../eesim.js');
const EG = require('../endgame.js');
const RF = require('../reach.js');
const X = require('./exact.js');

/** the fine cell of the state in sim (a number: FNV over the cell's parts) */
function cellOf(sim, disc) {
	let h = 0x811c9dc5 | 0;
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	mix(Math.floor(sim.px) | 0); mix(Math.floor(sim.py * 0.5) | 0); mix(Math.floor(sim.speed_x * 16) | 0); mix(Math.floor(sim.speed_y * 8) | 0);
	mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0)); mix(disc | 0);
	// (a second word so that two cells share a number only by a 52-bit accident)
	let g = 0x2545f491 | 0;
	g ^= Math.floor(sim.px * 7) | 0; g = Math.imul(g, 0x5bd1e995); g ^= Math.floor(sim.py * 3) | 0; g = Math.imul(g, 0x5bd1e995);
	g ^= Math.floor(sim.speed_x * 64) | 0; g = Math.imul(g, 0x5bd1e995); g ^= Math.floor(sim.speed_y * 32) | 0; g = Math.imul(g, 0x5bd1e995);
	return (h >>> 0) * 1048576 + ((g >>> 12) & 0xfffff);
}

function legBFS(L, starts, goal, o) {
	o = o || {};
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	const W = L.width, H = L.height;
	const allowDeath = !!o.allowDeath;
	const deadline = o.deadline || Infinity, stop = o.stop || null;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const field = o.field || null;
	const region = o.region || null;
	const collect = o.collect > 0 ? o.collect : 4000;
	const extra = o.extra >= 0 ? o.extra : 3;
	const stallMax = o.stall > 0 ? o.stall : 200;
	const noSeen = !!o.noSeen;
	// (the ranking's time bound: endgame.js's admissible kinematic envelope, capped; none with deaths allowed)
	const B = allowDeath || o.noBound ? null : (o.B || X.boundFor(L, goal));
	const HLIM = o.hLim > 0 ? o.hLim : 64;
	const BF = boundsFieldOf(o.bounds, goal);
	const FT = o.fieldPace > 0 ? o.fieldPace : 16 / 6.78;   // (ticks a tile at the running speed)
	let hLim = HLIM;
	const dirs = field ? dirsOf(field) : null;
	/**
	 * The ranking of the state now in sim (ticks, smaller first): the time to run the goal field's distance along the
	 * walk's descent at its tile from its speed along it (eta: the running acceleration up to the running speed), and near
	 * the goal (within hLim ticks) the admissible kinematic bound when larger. The field alone is blind to speed: a beam by
	 * distance kept the slow states at a wall's face and lost the run-ups (test/planexec.js's key door leg: 184 ticks at
	 * width 300 by the distance, the optimal 38 by this).
	 */
	const scoreOf = (dist) => {
		if (dist >= 1e9) return 1e9;
		const ft = BF !== null ? bfTime(BF, o.bounds, sim) : dist * FT;
		if (B === null || sim.is_dead || ft > hLim + 16) return ft;
		const h = EG.lowerBound(B, sim, hLim);
		return h > ft ? h : ft;
	};
	void dirs;
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const t0 = starts[order[0]].tick;
	let depthMax = o.depthMax > 0 ? o.depthMax : 2000;
	if (beforeTick >= 0) depthMax = Math.min(depthMax, beforeTick - t0);
	let width = o.width0 > 0 ? o.width0 : 1000;
	const widthMax = o.widthMax > 0 ? o.widthMax : 80000;
	const tStart = Date.now();
	const passes = [];
	let sims = 0, lastPoll = 0;
	const closest = { dist: -1, start: -1, tail: null, layer: -1 };
	const res = (status, extraFields) => Object.assign({ status, passes, sims, closest, seconds: (Date.now() - tStart) / 1000, t0 }, extraFields || {});
	const timeUp = () => {
		const now = Date.now();
		if (now > deadline) return 'time';
		if (stop !== null && now - lastPoll >= 20) { lastPoll = now; if (stop()) return 'stopped'; }
		return null;
	};
	if (depthMax < 0) return res('exhausted');
	for (let pass = 0; ; pass++) {
		const layers = [];
		const seen = new Set();
		const tileSeen = new Map();
		let cur = [];   // {sn, v}
		let si = 0;
		const goals = [];
		let found = -1, stall = 0, best = Infinity, why = 'depth';
		const passBest = { dist: -1, layer: -1, idx: -1 };
		let d = 0;
		for (; d <= depthMax; d++) {
			// the starts of this layer
			const par = [], msk = [];
			const nextCur = [];
			while (si < order.length && starts[order[si]].tick - t0 === d) {
				const s = order[si++];
				sim.restore(starts[s].snap);
				if (sim.is_dead && !allowDeath) continue;
				if (X.goalAt(goal, sim, t0 + d, beforeTick)) { if (found < 0) found = d; goals.push({ layer: d, par: -1 - s, msk: -1 }); continue; }
				nextCur.push({ sn: sim.snapshot(), v: 0 });
				par.push(-1 - s); msk.push(0);
			}
			if (d > 0) {
				// (layers[d] was filled while layer d - 1 was expanded: merge the starts in)
				const L0 = layers[d];
				cur = cur.concat(nextCur);
				layers[d] = { par: Int32Array.from([...L0.par, ...par]), msk: Uint8Array.from([...L0.msk, ...msk]) };
			} else {
				cur = nextCur;
				layers[0] = { par: Int32Array.from(par), msk: Uint8Array.from(msk) };
			}
			if (found >= 0 && d >= found + extra) break;
			if (d >= depthMax) break;
			if (cur.length === 0 && si >= order.length) { why = 'exhausted'; break; }
			const tu = timeUp();
			if (tu) { passes.push({ width, layers: d, sims, why: tu }); return finish(tu); }
			// expand layer d -> d + 1
			const c = d + 1;
			const nx = new Map();   // cell -> {sn, v, t, dist, par, msk}
			for (let i = 0; i < cur.length; i++) {
				if ((i & 63) === 0 && i > 0) { const tu2 = timeUp(); if (tu2) { passes.push({ width, layers: d, sims, why: tu2 }); return finish(tu2); } }
				const masks = EG.probeMasks(sim, inp, cur[i].sn);
				sims++;
				for (let k = 0; k < masks.length; k++) {
					const m = masks[k];
					if (k > 0) { sim.restore(cur[i].sn); E.applyMask(inp, m); sim.tick(inp); sims++; }
					if (sim.is_dead && !allowDeath) continue;
					if (!sim.is_dead && X.goalAt(goal, sim, t0 + c, beforeTick)) {
						if (found < 0) found = c;
						if (goals.length < collect) goals.push({ layer: c, par: i, msk: m });
						continue;
					}
					const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
					if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
					const t = cy * W + cx;
					if (region !== null && !region[t]) continue;
					const disc = X.discKey(sim);
					const key = cellOf(sim, disc);
					if (!noSeen && seen.has(key)) continue;
					const v = Math.abs(sim.speed_x) + Math.abs(sim.speed_y);
					const e = nx.get(key);
					if (e !== undefined) {
						if (v > e.v) { e.sn = sim.snapshot(e.sn); e.v = v; e.par = i; e.msk = m; e.dist = distOf(field, sim); e.sc = scoreOf(e.dist); }
						continue;
					}
					const dist = distOf(field, sim);
					nx.set(key, { sn: sim.snapshot(), v, t, dist, sc: scoreOf(dist), par: i, msk: m, key });
				}
			}
			// the next layer: 3/4 by the goal field's distance with at most `perTile` states a tile (flybeam.js's rule: a
			// beam piled up at a wall's face keeps room for the states that are still behind it, e.g. jumping earlier), the
			// rest by novelty per tile then speed
			let arr = [...nx.values()];
			for (const x of arr) seen.add(x.key);
			if (seen.size > 6e6) seen.clear();
			if (arr.length > width) {
				const nDist = Math.floor(width * (o.distShare > 0 ? o.distShare : 0.9));
				const perTile = o.perTile > 0 ? o.perTile : 8;
				const byDist = arr.slice().sort((a, b) => a.sc - b.sc || a.dist - b.dist || b.v - a.v);
				const keep = new Set(), perT = new Map();
				for (let k = 0; k < byDist.length && keep.size < nDist; k++) {
					const x = byDist[k], c = perT.get(x.t) || 0;
					if (c >= perTile) continue;
					perT.set(x.t, c + 1); keep.add(x);
				}
				const rest = arr.filter((x) => !keep.has(x));
				rest.sort((a, b) => (tileSeen.get(a.t) || 0) - (tileSeen.get(b.t) || 0) || a.sc - b.sc || b.v - a.v);
				for (let k = 0; k < rest.length && keep.size < width; k++) keep.add(rest[k]);
				arr = [...keep];
			}
			if (o.onLayer) o.onLayer(c, nx, arr);
			for (const x of arr) tileSeen.set(x.t, (tileSeen.get(x.t) || 0) + 1);
			cur = arr.map((x) => ({ sn: x.sn, v: x.v }));
			layers[c] = { par: Int32Array.from(arr, (x) => x.par), msk: Uint8Array.from(arr, (x) => x.msk) };
			// the nearest state of the layer (the fail report's closest; the stall clock)
			let bi = -1, bd = Infinity;
			for (let k = 0; k < arr.length; k++) if (arr[k].dist < bd) { bd = arr[k].dist; bi = k; }
			if (bi >= 0 && bd < best - 1e-9) { best = bd; stall = 0; passBest.dist = bd; passBest.layer = c; passBest.idx = bi; }
			else if (found < 0 && ++stall > stallMax) { why = 'stall'; d = c; break; }
		}
		// the pass's nearest state (over the passes: the nearest of all)
		if (passBest.layer >= 0 && Number.isFinite(passBest.dist) && (closest.dist < 0 || passBest.dist < closest.dist)) {
			const p = X.pathOfKept(layers, passBest.layer, passBest.idx, starts, t0);
			if (p) { closest.dist = passBest.dist; closest.start = p.start; closest.tail = p.tail; closest.layer = passBest.layer; }
		}
		passes.push({ width, layers: d, sims, why: found >= 0 ? 'found' : why });
		if (found >= 0) {
			const out = goals.map((g) => X.pathOf(layers, g.layer, g.par, g.msk, starts, t0));
			out.sort((a, b) => a.depth - b.depth);
			const first = out.find((g) => g.depth === found) || out[0];
			return res('found', { tick: t0 + found, depth: found, start: first.start, tail: first.tail, goals: out, width });
		}
		if (width >= widthMax) return res(why === 'exhausted' ? 'exhausted' : 'depth');
		const tu = timeUp();
		if (tu) return res(tu);
		width = Math.min(widthMax, width * 4);
	}
	function finish(why) { return res(why); }
}
/**
 * The ranking of a state: the goal field's distance (tiles) less its progress over the next LOOK ticks (its speed along
 * the walk's descent at its tile, px/tick -> tiles): a state running toward the goal ranks before one standing at the
 * same place (the field is blind to speed; the beam kept the slow states at a wall's face and lost the run-ups)
 */
const LOOK = 10;
const DIRS = new WeakMap();
function dirsOf(field) {
	let d = DIRS.get(field);
	if (d) return d;
	const W = field.W, H = field.H, N = W * H, walk = field.walk;
	d = new Float32Array(2 * N);
	if (walk) for (let t = 0; t < N; t++) {
		if (walk[t] === RF.CUT) continue;
		const x = t % W, y = (t / W) | 0;
		let bx = 0, by = 0, bv = walk[t];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const xx = x + dx, yy = y + dy;
			if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const v = walk[yy * W + xx];
			if (v !== RF.CUT && v < bv) { bv = v; bx = dx; by = dy; }
		}
		const n = Math.hypot(bx, by) || 1;
		d[2 * t] = bx / n; d[2 * t + 1] = by / n;
	}
	DIRS.set(field, d);
	return d;
}
/**
 * legBest(L, starts, goal, o) -> the same result shape as legBFS: a BEST-FIRST search (weighted A*: f = g + w x the
 * ranking below, g = the absolute tick) over COARSE cells (4 px x, 4 px y, 1/2 px/tick vx, 1 px/tick vy, on the ground,
 * the jumps, the door-reading state), the first arrival of each cell kept (closed): it dives toward the goal and falls back
 * to the next best state when it is stuck (a layered beam of the same width keeps no memory of the states it dropped).
 * Not a proof, not optimal: a finder for long legs; the executor improves what it finds (the exact search bounded by it).
 * o: legBFS's + {w (default 2.5), heapMax (default 300000 open states: past it the worst half goes)}.
 */
function legBest(L, starts, goal, o) {
	o = o || {};
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	const W = L.width, H = L.height;
	const allowDeath = !!o.allowDeath;
	const deadline = o.deadline || Infinity, stop = o.stop || null;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const field = o.field || null, region = o.region || null;
	const w = o.w > 0 ? o.w : 5;   // (T-EXEC-LEGS, box 3, 3 s: 2.5 46% / 5 56% / 8 56% / 12 55% with the cells below)
	const heapMax = o.heapMax > 0 ? o.heapMax : 300000;
	// (the cell: px, py, vx, vy multipliers; default 2 px, 4 px, 1/8, 1/4 px/tick: T-EXEC-LEGS 3 s at w 5: 56% vs 1 px, 2 px,
	// 1/16, 1/8 (legBFS's) 46%, 4 px, 4 px, 1/4, 1/2 40%)
	const CQ = o.cell || [0.5, 0.25, 8, 4];
	const collect = o.collect > 0 ? o.collect : 64;
	const B = allowDeath || o.noBound ? null : (o.B || X.boundFor(L, goal));
	const HLIM = o.hLim > 0 ? o.hLim : 64, FT = o.fieldPace > 0 ? o.fieldPace : 16 / 6.78;
	const BF = boundsFieldOf(o.bounds, goal);
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const t0 = starts[order[0]].tick;
	let depthMax = o.depthMax > 0 ? o.depthMax : 4000;
	if (beforeTick >= 0) depthMax = Math.min(depthMax, beforeTick - t0);
	const tStart = Date.now();
	// the nodes: parent, mask, tick (absolute layer), the snapshot while open
	const par = [], msk = [], gg = [], sn = [], dst = [];
	const pool = [];
	// the open heap of node indices by f
	const heap = [], hf = [];
	const hpush = (i, f) => {
		let k = heap.length; heap.push(i); hf.push(f);
		while (k > 0) { const p = (k - 1) >> 1; if (hf[p] <= f) break; heap[k] = heap[p]; hf[k] = hf[p]; k = p; }
		heap[k] = i; hf[k] = f;
	};
	const hpop = () => {
		const top = heap[0], n = heap.length - 1;
		const li = heap[n], lf = hf[n];
		heap.length = n; hf.length = n;
		if (n > 0) {
			let k = 0;
			for (;;) {
				let c = 2 * k + 1;
				if (c >= n) break;
				if (c + 1 < n && hf[c + 1] < hf[c]) c++;
				if (hf[c] >= lf) break;
				heap[k] = heap[c]; hf[k] = hf[c]; k = c;
			}
			heap[k] = li; hf[k] = lf;
		}
		return top;
	};
	const closed = new Set();
	const scoreOf = (dist) => {
		if (dist >= 1e9) return 1e9;
		const ft = BF !== null ? bfTime(BF, o.bounds, sim) : dist * FT;
		if (B === null || sim.is_dead || ft > HLIM + 16) return ft;
		const h = EG.lowerBound(B, sim, HLIM);
		return h > ft ? h : ft;
	};
	const cellKey = () => {
		let h = 0x811c9dc5 | 0;
		const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
		mix(Math.floor(sim.px * CQ[0]) | 0); mix(Math.floor(sim.py * CQ[1]) | 0); mix(Math.floor(sim.speed_x * CQ[2]) | 0); mix(Math.floor(sim.speed_y * CQ[3]) | 0);
		mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0));
		const d = X.discKey(sim);
		return (h >>> 0) * 1048576 + (d & 0xfffff);
	};
	const goals = [];
	const closest = { dist: -1, start: -1, tail: null, node: -1 };
	let sims = 0, pops = 0, lastPoll = 0, found = -1;
	const pathOfNode = (i, extraMask) => {
		const rev = [];
		if (extraMask >= 0) rev.push(extraMask);
		let k = i;
		while (par[k] >= 0) { rev.push(msk[k]); k = par[k]; }
		return { start: sIdx[k], tail: Uint8Array.from(rev.reverse()) };
	};
	const sIdx = [];
	for (const s of order) {
		sim.restore(starts[s].snap);
		if (sim.is_dead && !allowDeath) continue;
		const i = par.length;
		par.push(-1); msk.push(0); gg.push(starts[s].tick - t0); sn.push(sim.snapshot()); sIdx[i] = s;
		const d = distOf(field, sim);
		dst.push(d);
		if (X.goalAt(goal, sim, starts[s].tick, beforeTick)) { goals.push({ node: i, mask: -1, depth: gg[i] }); found = gg[i]; continue; }
		closed.add(cellKey());
		hpush(i, gg[i] + w * scoreOf(d));
	}
	let why = 'exhausted';
	let popsAtFound = -1;
	while (heap.length && goals.length < collect && (popsAtFound < 0 || pops - popsAtFound < 3000)) {
		if ((pops & 63) === 0) {
			const now = Date.now();
			if (now > deadline) { why = 'time'; break; }
			if (stop !== null && now - lastPoll >= 20) { lastPoll = now; if (stop()) { why = 'stopped'; break; } }
		}
		const i = hpop();
		pops++;
		const snap = sn[i];
		sn[i] = null;
		if (!snap) continue;
		const g = gg[i];
		if (g >= depthMax) { pool.push(snap); continue; }
		// (once a goal is found, only nodes that can still arrive by then are worth a look: the other goals of its layer)
		if (found >= 0 && g + 1 > found) { pool.push(snap); continue; }
		const masks = EG.probeMasks(sim, inp, snap);
		sims++;
		for (let k = 0; k < masks.length; k++) {
			const m = masks[k];
			if (k > 0) { sim.restore(snap); E.applyMask(inp, m); sim.tick(inp); sims++; }
			if (sim.is_dead && !allowDeath) continue;
			if (!sim.is_dead && X.goalAt(goal, sim, t0 + g + 1, beforeTick)) {
				if (found < 0 || g + 1 < found) found = g + 1;
				if (popsAtFound < 0) popsAtFound = pops;
				goals.push({ node: i, mask: m, depth: g + 1 });
				continue;
			}
			const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
			if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
			if (region !== null && !region[cy * W + cx]) continue;
			const key = cellKey();
			if (closed.has(key)) continue;
			closed.add(key);
			const d = distOf(field, sim);
			const j = par.length;
			par.push(i); msk.push(m); gg.push(g + 1); dst.push(d);
			sn.push(sim.snapshot(pool.length ? pool.pop() : undefined));
			hpush(j, g + 1 + w * scoreOf(d));
			if (d < 1e9 && (closest.dist < 0 || d < closest.dist)) { closest.dist = d; closest.node = j; }
		}
		pool.push(snap);
		if (heap.length > heapMax) {
			// (the worst half of the open states goes: their snapshots back to the pool)
			const idx = heap.map((x, k) => k).sort((a, b) => hf[a] - hf[b]);
			const keep = idx.slice(0, heapMax >> 1);
			const nh = keep.map((k) => heap[k]), nf = keep.map((k) => hf[k]);
			for (const k of idx.slice(heapMax >> 1)) { const n = heap[k]; if (sn[n]) { pool.push(sn[n]); sn[n] = null; } }
			heap.length = 0; hf.length = 0;
			const ord = nf.map((f, k) => k).sort((a, b) => nf[a] - nf[b]);
			for (const k of ord) { heap.push(nh[k]); hf.push(nf[k]); }
		}
	}
	const res = (status, extraF) => {
		if (closest.node >= 0) { const p = pathOfNode(closest.node, -1); closest.start = p.start; closest.tail = p.tail; }
		return Object.assign({ status, passes: [{ pops, open: heap.length, closed: closed.size, why: status }], sims, closest, seconds: (Date.now() - tStart) / 1000, t0 }, extraF || {});
	};
	if (goals.length) {
		const out = goals.map((x) => { const p = pathOfNode(x.node, x.mask); return { start: p.start, tail: p.tail, depth: x.depth }; });
		out.sort((a, b) => a.depth - b.depth);
		return res('found', { tick: t0 + out[0].depth, depth: out[0].depth, start: out[0].start, tail: out[0].tail, goals: out });
	}
	return res(why);
}

/** the primitives' relaxed tick field for this goal (bounds.js field(tiles, null, {touch})), or null (o.fieldTime false,
 *  no bounds, an error): the finders' time estimate when given (wall-aware, the level's top speeds per axis) */
function boundsFieldOf(bounds, goal) {
	if (!bounds || typeof bounds.field !== 'function' || typeof bounds.at !== 'function' || process.env.EEAT_LEG_BF === '0') return null;
	try { return bounds.field(goal.tiles, null, { touch: goal.kind === 'trophy' }); } catch (e) { return null; }
}
function bfTime(f, bounds, sim) {
	const v = bounds.at(f, sim, { endgame: false });
	return v === Infinity || !(v >= 0) ? 1e9 : v;
}

/** ticks to cover D px from speed v along the way: the running acceleration (1 / 7.752 px/tick a tick) up to the
 *  running speed 6.78 px/tick (a faster speed kept) */
const A_RUN = 1 / 7.752, V_RUN = 6.78;
function eta(D, v) {
	if (D <= 0) return 0;
	if (v >= V_RUN) return D / v;
	if (v < -V_RUN) v = -V_RUN;
	const tv = (V_RUN - v) / A_RUN, dv = v * tv + 0.5 * A_RUN * tv * tv;
	if (D <= dv) return (-v + Math.sqrt(v * v + 2 * A_RUN * D)) / A_RUN;
	return tv + (D - dv) / V_RUN;
}
const distOf = (field, sim) => {
	if (!field) return 0;
	const c = RF.costAt(field, sim);
	if (c < 0) return 1e9;
	return c;
};

module.exports = { legBFS, legBest, cellOf, eta };
