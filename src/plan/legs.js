'use strict';
// THE FINE-CELL LEG SEARCH (n4plan, part 'executor', tier 3 of reach()): not a proof, a finder. src/legsearch.js's
// algorithm (copied, not edited): a breadth-first search by ABSOLUTE tick from real states (each start injected at its
// own tick) over FINE cells (1 px x, 2 px y, 1/16 px/tick vx, 1/8 px/tick vy, on the ground, the jump count, the ball's
// door-reading state: exact.js discKey) that keeps the FASTEST state of each cell (|vx| + |vy|), where the exact search
// keeps every state and the coarse searches the first arrival: a leg whose speed has to be built far from its goal is
// found here. The goal is the waypoint's test (types.js goalOf, + beforeTick). A layer over its width is kept half by the
// goal field's distance (RCH3 on the level as the doors stood at the start: the nearest first) and half by novelty per
// tile (the tiles seen least in earlier layers), then speed. The region: tiles the goal field's walk reaches (a proof
// there only while the doors stay; here only a limit), dilated by a tile, inside a box around the starts and the goal.
// The width widens (x4) whenever a pass ends without a goal (exhausted, the depth limit, or no nearer state for `stall`
// layers) while the clock lasts: an easy leg is found with a narrow goal-led beam in milliseconds, a hard one gets
// breadth. The masks of each state come from endgame.probeMasks (the same states, fewer simulations).
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
		const ft = dist * FT;
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

module.exports = { legBFS, cellOf };
