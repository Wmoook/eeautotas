'use strict';
// THE LEG FINDERS (n4plan, part 'executor', tier 3 of reach()): not proofs, finders; every find is replayed by the
// executor. Both search from real states (each start injected at its own ABSOLUTE tick), the masks of each state from
// endgame.probeMasks (the same states, fewer simulations), over cells of position and speed (with on the ground, the jump
// count, the ball's door-reading state: exact.js discKey), inside a region (the tiles the goal field's walk reaches,
// dilated by a tile, in a box around the starts and the goal, and every tile the walk puts within the margin of the
// farthest start: a portal's exits), ranked by a TIME estimate (ticks): the goal field's distance at the running pace (or
// the primitives' tick field when bounds are given); with o.kbOn the larger of it and the admissible kinematic bound
// (endgame.lowerBound) near the goal. The distance alone is blind to speed: a beam by it kept the slow states at a
// wall's face and lost the run-ups (the key door leg of test/planexec.js: 184 ticks vs 38).
//   legBest (the executor's default): best-first, f = the tick + w x the estimate (w 5), the first arrival closes its
//     cell (2 px x, 4 px y, 1/8 px/tick vx, 1/4 vy); a child holds its input until the ball leaves its parent's cell (at
//     most 8 ticks; a ball at rest on a clock level until the clock changes its cell, a dead ball until it respawns); a
//     held jump that cannot jump is not simulated (the same trajectory); it dives toward the goal and falls back to the
//     next best open state where it is stuck (T-EXEC-LEGS, box 3, 3 s, with the executor's tightening and leg polish:
//     81% of the legs, the legs found 1.000 of the route's own (median), 1.28x (p90); the first version 56%, the beam 30%).
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
const T = require('./types.js');

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
	// (the ranking's time bound: endgame.js's admissible kinematic envelope, capped; none with deaths allowed;
	// EEAT_BEAM_KB=0: none)
	const B = allowDeath || o.noBound || process.env.EEAT_BEAM_KB === '0' ? null : (o.B || X.boundFor(L, goal));
	const dkOf = discKeyCache();
	const JSKIP_B = process.env.EEAT_JSKIP !== '0' && !o.noJskip;
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
	// (the lazy ranking: a state enters with its field time alone (a lower bound of scoreOf's max), the bound is evaluated
	// only when the selection reaches it (from its snapshot))
	const ftOf = (dist) => (dist >= 1e9 ? 1e9 : BF !== null ? bfTime(BF, o.bounds, sim) : dist * FT);
	const kbOf = (x) => {
		if (B === null || x.sc >= 1e9 || x.sc > hLim + 16) return x.sc;
		sim.restore(x.sn);
		if (sim.is_dead) return x.sc;
		const h = EG.lowerBound(B, sim, hLim);
		return h > x.sc ? h : x.sc;
	};
	const LAZY = process.env.EEAT_BEAM_LAZY !== '0';
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
				// (a jump that cannot jump: the very state of the input without it (exact.js's rule), not simulated)
				let noJump = 0;
				for (let k = 0; k < masks.length; k++) {
					const m = masks[k];
					if ((m & 1) && JSKIP_B && (noJump & (1 << (m & 30))) !== 0) continue;
					if (k > 0) { sim.restore(cur[i].sn); E.applyMask(inp, m); sim.tick(inp); sims++; }
					if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
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
					const disc = dkOf(sim);
					const key = cellOf(sim, disc);
					if (!noSeen && seen.has(key)) continue;
					const v = Math.abs(sim.speed_x) + Math.abs(sim.speed_y);
					const e = nx.get(key);
					if (e !== undefined) {
						if (v > e.v) { e.sn = sim.snapshot(e.sn); e.v = v; e.par = i; e.msk = m; e.dist = distD(field, sim, allowDeath); e.sc = LAZY ? ftOf(e.dist) : scoreOf(e.dist); }
						continue;
					}
					const dist = distD(field, sim, allowDeath);
					nx.set(key, { sn: sim.snapshot(), v, t, dist, sc: LAZY ? ftOf(dist) : scoreOf(dist), par: i, msk: m, key });
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
				if (!LAZY) {
					for (let k = 0; k < byDist.length && keep.size < nDist; k++) {
						const x = byDist[k], c = perT.get(x.t) || 0;
						if (c >= perTile) continue;
						perT.set(x.t, c + 1); keep.add(x);
					}
				} else {
					// (in field-time order; each state's full score evaluated as it comes; a state is taken once its score is at
					// most the next unevaluated field time: the order by the full score, as the eager ranking's)
					const hp = [];
					const less = (a, b) => a.sc < b.sc || (a.sc === b.sc && (a.dist < b.dist || (a.dist === b.dist && a.v > b.v)));
					const push = (x) => { let k = hp.length; hp.push(x); while (k > 0) { const p = (k - 1) >> 1; if (!less(x, hp[p])) break; hp[k] = hp[p]; k = p; } hp[k] = x; };
					const pop = () => { const top = hp[0], x = hp.pop(); if (hp.length) { let k = 0; for (;;) { let c = 2 * k + 1; if (c >= hp.length) break; if (c + 1 < hp.length && less(hp[c + 1], hp[c])) c++; if (!less(hp[c], x)) break; hp[k] = hp[c]; k = c; } hp[k] = x; } return top; };
					let idx = 0;
					while (keep.size < nDist) {
						if (hp.length && (idx >= byDist.length || hp[0].sc <= byDist[idx].sc)) {
							const x = pop(), c = perT.get(x.t) || 0;
							if (c >= perTile) continue;
							perT.set(x.t, c + 1); keep.add(x);
						} else if (idx < byDist.length) {
							const y = byDist[idx++];
							y.sc = kbOf(y);
							push(y);
						} else break;
					}
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
 * ranking, g = the absolute tick) over cells (o.cell: px, py, vx, vy multipliers, default 2 px, 4 px, 1/8, 1/4 px/tick;
 * on the ground, the jumps, the door-reading state; the time doors' phase on a clock level), the first arrival of each
 * cell kept (closed): it dives toward the goal and falls back to the next best state when it is stuck (a layered beam of
 * the same width keeps no memory of the states it dropped). Not a proof, not optimal: a finder for long legs; the
 * executor improves what it finds (the tightening, polish.js polishLeg, the exact search bounded by it).
 * o: legBFS's + {w (default 5), cell, hold (8), heapMax (default 300000 open states: past it the worst half goes), kbOn
 *    (the kinematic bound in the ranking), noFinish, noJskip}; goal.over (exact.js overOf: the monotone counter cut).
 */
/** a set of (uint32, uint32) pairs: open addressing on typed arrays (a Set of the doubles a * 2^20 + b made a heap
 *  number per key) */
class PairSet {
	constructor(cap) { this.cap = 1 << Math.max(10, Math.ceil(Math.log2(cap || 4096))); this.a = new Int32Array(this.cap); this.b = new Int32Array(this.cap); this.u = new Uint8Array(this.cap); this.size = 0; }
	_slot(a, b) {
		const m = this.cap - 1;
		let i = (Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b) >>> 7) & m;
		while (this.u[i] && (this.a[i] !== a || this.b[i] !== b)) i = (i + 1) & m;
		return i;
	}
	has(a, b) { return this.u[this._slot(a | 0, b | 0)] === 1; }
	/** true when new */
	add(a, b) {
		a |= 0; b |= 0;
		const i = this._slot(a, b);
		if (this.u[i]) return false;
		this.u[i] = 1; this.a[i] = a; this.b[i] = b; this.size++;
		if (this.size * 2 > this.cap) this._grow();
		return true;
	}
	_grow() {
		const oa = this.a, ob = this.b, ou = this.u, n = this.cap;
		this.cap = n * 2; this.a = new Int32Array(this.cap); this.b = new Int32Array(this.cap); this.u = new Uint8Array(this.cap);
		for (let k = 0; k < n; k++) if (ou[k]) { const i = this._slot(oa[k], ob[k]); this.u[i] = 1; this.a[i] = oa[k]; this.b[i] = ob[k]; }
	}
}

/** X.discKey(sim) with the switch maps' part cached by map identity: a map the sim does not own (a restored snapshot's)
 *  is never changed in place (eesim.js _swSet copies it first), so the same map gives the same part */
function discKeyCache() {
	let dsw = null, dosw = null, s1 = 0, s2 = 0, o1 = 0, o2 = 0;
	return (sim) => {
		const sw = sim._switches, osw = sim._oswitches;
		if (sw !== dsw || sim._swOwned) {
			s1 = 0; s2 = 0;
			for (const [k, v] of sw) if (v === true) { s1 = (s1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; s2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
			dsw = sim._swOwned ? null : sw;
		}
		if (osw !== dosw || sim._oswOwned) {
			o1 = 0; o2 = 0;
			for (const [k, v] of osw) if (v === true) { o1 = (o1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; o2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
			dosw = sim._oswOwned ? null : osw;
		}
		let h = 0x811c9dc5;
		const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
		mix(sim._keysMask | 0); mix(sim.coins | 0); mix(sim.blue_coins | 0); mix(sim.deaths | 0); mix(sim.team | 0);
		mix((sim._collide_crown ? 1 : 0) | (sim._collide_silver_crown ? 2 : 0) | (sim.is_zombie ? 4 : 0));
		mix(sim._show_coin_gate | 0); mix(sim._show_blue_coin_gate | 0); mix(sim._show_death_gate | 0);
		mix(s1); mix(s2); mix(o1); mix(o2);
		return h >>> 0;
	};
}

function legBest(L, starts, goal, o) {
	o = o || {};
	const JSKIP_L = process.env.EEAT_JSKIP !== '0' && !o.noJskip;
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	const W = L.width, H = L.height;
	const allowDeath = !!o.allowDeath;
	const deadline = o.deadline || Infinity, stop = o.stop || null;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const field = o.field || null, region = o.region || null;
	// (o.visited: a Uint8Array(W x H) the search marks with the centre tile of every state it reached in its region (the
	// executor's counterexample walls: the tiles its field ranks below every tile reached, next to them, never entered))
	const vis = o.visited instanceof Uint8Array && o.visited.length === L.width * L.height ? o.visited : null;
	const w = o.w > 0 ? o.w : 5;   // (T-EXEC-LEGS, box 3, 3 s: 2.5 46% / 5 56% / 8 56% / 12 55% with the cells below)
	const heapMax = o.heapMax > 0 ? o.heapMax : 300000;
	// (the cell: px, py, vx, vy multipliers; default 2 px, 4 px, 1/8, 1/4 px/tick: T-EXEC-LEGS 3 s at w 5: 56% vs 1 px, 2 px,
	// 1/16, 1/8 (legBFS's) 46%, 4 px, 4 px, 1/4, 1/2 40%)
	const CQ = o.cell || [0.5, 0.25, 8, 4];
	const collect = o.collect > 0 ? o.collect : 64;
	// (the order: the goal field's time alone by default; o.kbOn (or EEAT_LEG_KB=1) takes the larger of it and the
	// kinematic bound where the field puts the goal within KBT ticks: T-EXEC-LEGS, box 3, 3 s: 76.6% / 77.4% without it vs
	// 71.3% / 71.3% with it (its lookups were 30% of a long leg's time), the legs found 1.050 vs 1.023 of the route's)
	const B = allowDeath || o.noBound || (process.env.EEAT_LEG_KB !== '1' && !o.kbOn) ? null : (o.B || X.boundFor(L, goal));
	const HLIM = o.hLim > 0 ? o.hLim : 64, FT = o.fieldPace > 0 ? o.fieldPace : 16 / 6.78;
	// (the kinematic bound only for states the field puts within KBT ticks (EEAT_LEG_KBT: measurements))
	const KBT = +process.env.EEAT_LEG_KBT || HLIM + 16;
	const BF = boundsFieldOf(o.bounds, goal);
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const t0 = starts[order[0]].tick;
	let depthMax = o.depthMax > 0 ? o.depthMax : 4000;
	if (beforeTick >= 0) depthMax = Math.min(depthMax, beforeTick - t0);
	const tStart = Date.now();
	// the nodes: parent, mask, tick (absolute layer), the snapshot while open
	const par = [], msk = [], rp = [], gg = [], sn = [], dst = [];
	const HOLD = o.hold > 0 ? o.hold : (+process.env.EEAT_BEST_HOLD || 8);
	// (the wait: on a level whose clock matters (keys run out, time doors) a ball at rest that stays in its cell holds on
	// until the clock changes its cell (a key out, the time doors' phase: in the cell key there), at most WAIT ticks)
	const CLOCK = !!L.clockSensitive && process.env.EEAT_BEST_WAIT !== '0';
	const WAIT = CLOCK ? 600 : 0;
	// (a dead ball (a death step's allowDeath) holds on through its dead ticks until it respawns: its cell does not change
	// meanwhile, and the first arrival's rule dropped it: a death step was never found)
	const DEAD_HOLD = 80;
	const pool = [];
	// (the finisher: the NK states nearest the goal by the field (at most 2 a tile, within FIN_D tiles) kept with their
	// snapshots; at FIN_F of the time with no leg found, the exact search from them (solveExact over absolute ticks: the
	// fastest way on from every one of them at once) takes the rest: a precise last approach the cells merge away, a
	// 1-tile pocket; OPT-IN EEAT_FINISH=1: T-EXEC-LEGS, box 3, 3 s: 75.8% with it vs 78.1% without, 6 legs lost, none gained)
	const FIN = process.env.EEAT_FINISH === '1' && !o.noFinish && deadline < Infinity;
	const FIN_D = +process.env.EEAT_FIN_D || 6, FIN_F = +process.env.EEAT_FIN_F || 0.75, NK = 24;
	const near = [];
	const finAt = FIN ? tStart + FIN_F * (deadline - tStart) : Infinity;
	let finR = null;
	const keepNear = (j, d, tile) => {
		let nt = 0, wt = -1, wa = -1;
		for (let k = 0; k < near.length; k++) {
			const e = near[k];
			if (e.tile === tile) { nt++; if (wt < 0 || e.d > near[wt].d) wt = k; }
			if (wa < 0 || e.d > near[wa].d) wa = k;
		}
		const k = nt >= 2 ? wt : near.length < NK ? -1 : wa;
		if (k >= 0 && near[k].d <= d) return;
		if (k < 0) near.push({ d, node: j, tile, snap: sim.snapshot() });
		else { const e = near[k]; e.d = d; e.node = j; e.tile = tile; e.snap = sim.snapshot(e.snap); }
	};
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
	const closed = new PairSet(1 << 16);
	const dkOf = discKeyCache();
	const scoreOf = (dist) => {
		if (dist >= 1e9) return 1e9;
		const ft = BF !== null ? bfTime(BF, o.bounds, sim) : dist * FT;
		if (B === null || sim.is_dead || ft > KBT) return ft;
		const h = EG.lowerBound(B, sim, HLIM);
		return h > ft ? h : ft;
	};
	// (the cell: ka the physical part's hash, kb the door-reading state's)
	let ka = 0, kb = 0;
	const q0 = CQ[0], q1 = CQ[1], q2 = CQ[2], q3 = CQ[3];
	const cellKey = () => {
		let h = 0x811c9dc5 | 0;
		const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
		mix(Math.floor(sim.px * q0) | 0); mix(Math.floor(sim.py * q1) | 0); mix(Math.floor(sim.speed_x * q2) | 0); mix(Math.floor(sim.speed_y * q3) | 0);
		mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0) | (CLOCK && sim._timedoor_state ? 1024 : 0));
		ka = h; kb = dkOf(sim) | 0;
	};
	const goals = [];
	const closest = { dist: -1, start: -1, tail: null, node: -1, pop: -1 };
	let sims = 0, pops = 0, lastPoll = 0, found = -1;
	const pathOfNode = (i, extraMask, extraReps) => {
		const rev = [];
		if (extraMask >= 0) for (let r = 0; r < (extraReps || 1); r++) rev.push(extraMask);
		let k = i;
		while (par[k] >= 0) { for (let r = 0; r < rp[k]; r++) rev.push(msk[k]); k = par[k]; }
		return { start: sIdx[k], tail: Uint8Array.from(rev.reverse()) };
	};
	const sIdx = [];
	for (const s of order) {
		sim.restore(starts[s].snap);
		if (sim.is_dead && !allowDeath) continue;
		const i = par.length;
		par.push(-1); msk.push(0); rp.push(0); gg.push(starts[s].tick - t0); sn.push(sim.snapshot()); sIdx[i] = s;
		const d = distOf(field, sim);
		dst.push(d);
		if (X.goalAt(goal, sim, starts[s].tick, beforeTick)) { goals.push({ node: i, mask: -1, depth: gg[i] }); found = gg[i]; continue; }
		cellKey(); closed.add(ka, kb);
		hpush(i, gg[i] + w * scoreOf(d));
	}
	let why = 'exhausted';
	let popsAtFound = -1;
	const drop = { dead: 0, over: 0, oob: 0, region: 0, closed: 0, skipJ: 0 };
	const over = typeof goal.over === 'function' ? goal.over : null;
	while (heap.length && goals.length < collect && (popsAtFound < 0 || pops - popsAtFound < 3000)) {
		if ((pops & 63) === 0) {
			const now = Date.now();
			if (now > deadline) { why = 'time'; break; }
			if (stop !== null && now - lastPoll >= 20) { lastPoll = now; if (stop()) { why = 'stopped'; break; } }
			if (now > finAt && found < 0 && near.length && finR === null) {
				const fst = near.map((e) => ({ snap: e.snap, tick: t0 + gg[e.node] }));
				let gMin = Infinity;
				for (const e of near) if (gg[e.node] < gMin) gMin = gg[e.node];
				finR = X.solveExact(L, fst, goal, { sim, deadline, stop, allowDeath, beforeTick, collect: 64, maxDepthCap: Math.max(1, depthMax - gMin) });
				for (const r of finR.runs || []) sims += r.ticks;
				if (finR.status === 'found') { why = 'found'; break; }
				if (finR.status === 'stopped') { why = 'stopped'; break; }
				if (Date.now() > deadline) { why = 'time'; break; }
			}
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
		// (the node's own cell: a child is the input HELD until the ball leaves it (at most HOLD ticks): a child in its
		// parent's cell is the same trajectory a tick on, and the first arrival's rule would drop it (a ball at rest, a slow
		// fall: the search died at its start on 2 px / 4 px cells))
		sim.restore(snap);
		cellKey();
		const pa = ka, pb = kb;
		const masks = EG.probeMasks(sim, inp, snap);
		sims++;
		// (a jump held that cannot jump: while the input without the jump bit leaves no jump after every tick of its hold (the
		// run timer on, no levitation, jump_count >= max_jumps), its jump twin is the very same trajectory (exact.js's rule
		// tick by tick) and its child the same cell: not simulated)
		let noJump = 0;
		for (let k = 0; k < masks.length; k++) {
			const m = masks[k];
			if ((m & 1) && JSKIP_L && (noJump & (1 << (m & 30))) !== 0) { drop.skipJ++; continue; }
			if (k > 0) { sim.restore(snap); E.applyMask(inp, m); sim.tick(inp); sims++; }
			let reps = 1, same = true, bad = false, nj = JSKIP_L && !(m & 1);
			for (;;) {
				if (nj && !(sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps)) nj = false;
				if (sim.is_dead && !allowDeath) { drop.dead++; bad = true; break; }
				if (over !== null && over(sim)) { drop.over++; bad = true; break; }
				if (!sim.is_dead && X.goalAt(goal, sim, t0 + g + reps, beforeTick)) {
					if (found < 0 || g + reps < found) found = g + reps;
					if (popsAtFound < 0) popsAtFound = pops;
					goals.push({ node: i, mask: m, reps, depth: g + reps });
					bad = true;
					break;
				}
				cellKey();
				same = ka === pa && kb === pb;
				if (!same || g + reps >= depthMax) break;
				if (reps >= HOLD && !(sim.is_dead && reps < DEAD_HOLD) && !(reps < WAIT && sim.speed_x === 0 && sim.speed_y === 0)) break;
				E.applyMask(inp, m); sim.tick(inp); sims++; reps++;
			}
			if (nj) noJump |= 1 << (m & 30);
			if (bad) continue;
			if (same) { drop.closed++; continue; }
			const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
			if (cx < 0 || cy < 0 || cx >= W || cy >= H) { drop.oob++; continue; }
			if (region !== null && !region[cy * W + cx]) { drop.region++; continue; }
			if (vis !== null) vis[cy * W + cx] = 1;
			if (!closed.add(ka, kb)) { drop.closed++; continue; }
			const d = distD(field, sim, allowDeath);
			const j = par.length;
			par.push(i); msk.push(m); rp.push(reps); gg.push(g + reps); dst.push(d);
			sn.push(sim.snapshot(pool.length ? pool.pop() : undefined));
			hpush(j, g + reps + w * scoreOf(d));
			if (d < 1e9 && (closest.dist < 0 || d < closest.dist)) { closest.dist = d; closest.node = j; closest.pop = pops; }
			if (FIN && d <= FIN_D && finR === null) keepNear(j, d, cy * W + cx);
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
		const fin = finR ? { status: finR.status, starts: near.length, lb: finR.lb, depth: finR.depth, runs: (finR.runs || []).length } : null;
		return Object.assign({ status, passes: [{ pops, open: heap.length, closed: closed.size, why: status, drop, fin }], sims, closest, seconds: (Date.now() - tStart) / 1000, t0 }, extraF || {});
	};
	if (finR !== null && finR.status === 'found' && !goals.length) {
		// (the finisher's legs: the path to its start state, then its exact tail)
		const out = [];
		for (const c of finR.goals) {
			const e = near[c.start];
			const p = pathOfNode(e.node, -1);
			const tail = new Uint8Array(p.tail.length + c.tail.length);
			tail.set(p.tail, 0); tail.set(c.tail, p.tail.length);
			out.push({ start: p.start, tail, depth: gg[e.node] + c.tail.length });
		}
		out.sort((a, b) => a.depth - b.depth);
		return res('found', { tick: t0 + out[0].depth, depth: out[0].depth, start: out[0].start, tail: out[0].tail, goals: out, finisher: true });
	}
	if (goals.length) {
		const out = goals.map((x) => { const p = pathOfNode(x.node, x.mask, x.reps); return { start: p.start, tail: p.tail, depth: x.depth }; });
		out.sort((a, b) => a.depth - b.depth);
		return res('found', { tick: t0 + out[0].depth, depth: out[0].depth, start: out[0].start, tail: out[0].tail, goals: out });
	}
	return res(why);
}

/** the primitives' relaxed tick field for this goal (bounds.js field(tiles, null, {touch})), or null (no bounds, an
 *  error, or not asked): the finders' time estimate when asked (wall-aware, the level's top speeds per axis). OPT-IN
 *  since lane 4 block 2 (EEAT_LEG_BF=1): the admissible tick field is a weak ranking (the bound is a median 0.145 of the
 *  real ticks, the walls its only physics), and the finders ranked by it stalled at the goal field's false nears; ranked
 *  by the goal field's physics (the distance at the running pace) the 18 near-miss levels of the full compile b1 (box 3,
 *  60 s, --workers=3, one run each) reached 67 triggers vs 48 / 48 / 51 (Starlight 13 vs 0-2, Level 1 Overworld 13 vs 7,
 *  Delusion Valley 2 vs 0, LoZ Skyward Sword 3 vs 2; Booty Return 11 vs 10-13, Pancake Quest 4 vs 5-6) */
function boundsFieldOf(bounds, goal) {
	if (!bounds || typeof bounds.field !== 'function' || typeof bounds.at !== 'function' || process.env.EEAT_LEG_BF !== '1') return null;
	try { return bounds.field(T.fieldTilesOf(goal), goal.wallLc || null, { touch: T.fieldTouchOf(goal) }); } catch (e) { return null; }
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
/** the ordering distance, a DEAD ball of a death step (allowDeath) 0: it comes back at its respawn by itself, and its
 *  tile (the killer's) has no value on the field (1e9: the dead states went last and the heap's cut dropped them) */
const distD = (field, sim, allowDeath) => (allowDeath && sim.is_dead ? 0 : distOf(field, sim));
const distOf = (field, sim) => {
	if (!field) return 0;
	const c = RF.costAt(field, sim);
	if (c < 0) return 1e9;
	return c;
};

module.exports = { legBFS, legBest, cellOf, eta };
