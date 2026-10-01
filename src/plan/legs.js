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
// the zero-speed bucket of legBest's cells (doctor 8, n5-doc-8; DEFAULT ON since n5 lane 6 block 1, EEAT_CELL_ZERO=0 = the cells as
// before): legBest's cellKey
const ZERO_CELL = process.env.EEAT_CELL_ZERO !== '0';
// THE EFFECT CELL (COMPILER DOCTOR b9, n5; OPT-IN EEAT_FX_CELL=1, off = the cells as before, byte for byte): legBest's and
// legBFS's cells (position, speed, ground, jumps, dead + the door state dkOf) carried NO effect state, so a ball that took
// an effect (low gravity, fly, multijump, jump / speed boost, gravity, protection, curse / poison / fire) and came back to a
// place the plain ball had already visited shared the plain ball's cell and was merged away as a duplicate: the effect
// detour, the whole point of an effect puzzle, is pruned. Bad EE Level 9's mini 3: the switch is 6 tiles past a 1-tall
// corridor over a spike pit that only a low-gravity ball crosses, the low-gravity tile in a pocket 1 tile above the
// entrance; the plain ball walks the corridor's first tiles first, the low-gravity ball that jumps into the pocket and
// drops back lands in the same cells and is closed (tools/cmp/legab.js from the mini's entrance, a fresh executor a rep,
// rungs 1-3 = 65 s: 0 of 5 reps, closest 40.6 tiles in the pit in every rep; with the knob 5 of 5 at rung 1, 4.6-5.3 s,
// 524-534 ticks). exact.js keys by the full stateHash (effects in) and prims' featSig has them.
const FX_CELL = process.env.EEAT_FX_CELL === '1';
/** the effect state of the ball as one word (0 = plain: no effect on) */
const fxWord = (sim) => (sim.low_gravity ? 1 : 0) | (sim.has_levitation ? 2 : 0) | ((sim.flip_gravity & 7) << 2) | ((sim.jump_boost & 3) << 5) |
	((sim.speed_boost & 3) << 7) | (((sim.max_jumps === 1 ? 0 : (sim.max_jumps & 63) + 1)) << 9) | (sim.is_invulnerable ? 1 << 16 : 0) |
	(sim.is_cursed ? 1 << 17 : 0) | (sim.is_poisoned ? 1 << 18 : 0) | (sim.is_on_fire ? 1 << 19 : 0);

// THE QUEUE CELL (COMPILER DOCTOR b9, n5; OPT-IN EEAT_Q_CELL=1, off = the cells as before): the engine's gravity queue
// (eesim.js _q0 / _q1: the tiles whose pull acts this tick and next) is no part of a cell either, so a ball entering a
// ladder / dot / arrow / liquid row from the air and one already in it share a cell for the 1-2 ticks their pulls differ.
// A word only while the two queued pulls differ (a transition): steady states keep their cells. Bad EE Level 9's mini 5
// (a ladder maze between spike columns; tools/cmp/legab.js from its entrance, box 6): 3 of 3 at rung 2 either way, the
// leg 571 ticks with it vs 884 without (EEAT_FX_FIELD=1: 0 of 3 at rungs 1-3).
const Q_CELL = process.env.EEAT_Q_CELL === '1';
const pullOf = (L, t) => ((Math.round(L.gMox[t] * 64) & 0x3ff) | ((Math.round(L.gMoy[t] * 64) & 0x3ff) << 10) | ((L.gFlags[t] & 2) << 19));
/** the gravity queue's transition word (0 = both queued tiles pull alike) */
const qWord = (sim) => {
	const L = sim.level;
	if (!L || !L.gMox) return 0;
	const a = pullOf(L, sim._q0), b = pullOf(L, sim._q1);
	return a === b ? 0 : ((a * 0x9e3779b1) ^ b) | 1;
};

// THE KEY CELL (COMPILER DOCTOR b9, n5; OPT-IN EEAT_KEY_CELL=1, off = the cells as before): a held key runs out 500 ticks
// after its last pickup (eesim.js _kt), and dkOf has only which keys are held: a ball that took the key late (much time
// left) and one that took it early (about to run out: a key GATE opens, a key DOOR shuts) share a cell. A word per held key:
// its time left in 50-tick buckets. No key held: the cells as before. Bad EE Level 9's mini 1 (blue keys, key doors and
// gates around its switch; legab from its entrance): 3 of 3 at rung 2 either way (367 vs 361 ticks): no gain shown.
const KEY_CELL = process.env.EEAT_KEY_CELL === '1';
const KEY_BUCKET = 50;
/** the held keys' time-left word (0 = no key held) */
const keyWord = (sim) => {
	const m = sim._keysMask | 0;
	if (m === 0 || !sim._kt) return 0;
	let w = 0;
	for (let c = 0; c < 6; c++) if (m & (1 << c)) w = Math.imul(w ^ (c + 1), 0x01000193) ^ Math.max(0, Math.floor((500 - (sim._ticks - sim._kt[c])) / KEY_BUCKET));
	return w | 1;
};

/** the fine cell of the state in sim (a number: FNV over the cell's parts) */
function cellOf(sim, disc) {
	let h = 0x811c9dc5 | 0;
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	mix(Math.floor(sim.px) | 0); mix(Math.floor(sim.py * 0.5) | 0); mix(Math.floor(sim.speed_x * 16) | 0); mix(Math.floor(sim.speed_y * 8) | 0);
	mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0)); mix(disc | 0);
	// (EEAT_CELL_ZERO=1: the state at rest on the tile grid, per axis, a cell of its own, as legBest's cellKey)
	if (ZERO_CELL) { const ax = sim.speed_x === 0 && sim.px % 16 === 0, ay = sim.speed_y === 0 && sim.py % 16 === 0; if (ax || ay) mix(0x7f00 | (ax ? 1 : 0) | (ay ? 2 : 0)); }
	if (FX_CELL) { const f = fxWord(sim); if (f !== 0) mix(0x5a000000 | f); }
	if (Q_CELL) { const q = qWord(sim); if (q !== 0) { mix(0x5b000000); mix(q); } }
	if (KEY_CELL) { const k = keyWord(sim); if (k !== 0) { mix(0x5c000000); mix(k); } }
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
	constructor(cap, withV) { this.cap = 1 << Math.max(10, Math.ceil(Math.log2(cap || 4096))); this.a = new Int32Array(this.cap); this.b = new Int32Array(this.cap); this.u = new Uint8Array(this.cap); this.v = withV ? new Float32Array(this.cap) : null; this.size = 0; }
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
	/** (a set made withV) true when new, or when this arrival's speed v is faster than the fastest recorded for the pair by
	 *  more than dv (then recorded) */
	addV(a, b, v, dv) {
		a |= 0; b |= 0;
		const i = this._slot(a, b);
		if (this.u[i]) { if (v > this.v[i] + dv) { this.v[i] = v; return true; } return false; }
		this.u[i] = 1; this.a[i] = a; this.b[i] = b; this.v[i] = v; this.size++;
		if (this.size * 2 > this.cap) this._grow();
		return true;
	}
	_grow() {
		const oa = this.a, ob = this.b, ou = this.u, ov = this.v, n = this.cap;
		this.cap = n * 2; this.a = new Int32Array(this.cap); this.b = new Int32Array(this.cap); this.u = new Uint8Array(this.cap); this.v = ov ? new Float32Array(this.cap) : null;
		for (let k = 0; k < n; k++) if (ou[k]) { const i = this._slot(oa[k], ob[k]); this.u[i] = 1; this.a[i] = oa[k]; this.b[i] = ob[k]; if (ov) this.v[i] = ov[k]; }
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
	// (a DEATH STEP (o.dieStep: the waypoint's die field, planner.js dieField): the dead ball and the ball at a kill cell's
	// door first: diePri, below; not a leg that only MAY die (the executor's death leg: its goal is a trigger)
	const KC = allowDeath && o.dieStep && DIE_PRI > 0 ? killCellsOf(L) : null;
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
	// (the side-arrow crossings: a ball inside a run of side arrows, moving against their push slower than the rest of the
	// run needs, where the field's way goes on past the run, ranks behind (the run-up it must go back for): ORDERING only)
	const SAX = process.env.EEAT_SAX === '1' && field && field.mode !== 'walk' ? saxOf(L, field) : null;
	const saxPen = SAX === null ? () => 0 : (s) => {
		const cx = (s.px + 8) >> 4, cy = (s.py + 8) >> 4;
		if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
		const t = cy * W + cx, k = SAX.k[t];
		if (!k) return 0;
		const p = SAX.p[t], va = -p * s.speed_x, c = s.px + 8;
		// (what is left of the run for the centre, px: to the far edge of its last tile against the push)
		const D = p < 0 ? (cx + k) * 16 - c : c - (cx - k + 1) * 16;
		return va < saxNeed(D / 16) ? SAX_PEN * k * FT : 0;
	};
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
	// (THE FASTEST ARRIVAL, OPT-IN EEAT_BEST_ENERGY=1 or o.energy: a closed cell takes a later arrival again when its speed
	// |v| is faster than every arrival it took by more than EEAT_BEST_EDV px/tick (default 0). The first arrival's rule keeps
	// whichever state came first, and a cell's states differ by up to a speed quantum (the coarse grain's 1 px/tick vy): a
	// PUMP (a dive into an arrow column for the speed that lifts the ball out; My level de42's trophy, two dives) needs the
	// fastest of them, and the slower one closed its cell (lane 4 b4: from the known route's state at tick 80 the coarse
	// grain 'exhausted' 361 k pops, with this rule found in 574 pops / 18 ms; from the spawn neither in 20 s: the first
	// dive's apex is lost the same way within the default grain's quanta). Ordering / pruning only: no claim.)
	const ENERGY = process.env.EEAT_BEST_ENERGY === '1' || !!o.energy;
	const EDV = process.env.EEAT_BEST_EDV !== undefined ? +process.env.EEAT_BEST_EDV : 0;
	// (THE SPEED CLASSES, OPT-IN EEAT_SPEED_Q=1 or o.speedQ; off = the search as before, byte for byte (C6 lane 4 block 5): the
	// goal field keeps no horizontal speed, so f ranks a slow ball beside the goal before a fast one farther back, and the
	// heap's cut (heapMax: the worst half goes) drops the fast ones first: the long legs' closest states stand on the known
	// route's way but SLOW (B8 hard: FV 731's (-0.2,-2.0) px/tick where the route passes at (+6.0,-5.6); Sentinel's run-up
	// along dot row 102 at 2.5 -> 6.4 px/tick). Every open state of speed class c >= 1 is also in its class's own heap (by
	// the same f): c = 4 rising faster than a jump (vy < SQ_VY), else 1 / 2 / 3 for |vx| in [2, 4) / [4, 6) / 6+ px/tick;
	// every SQ_K-th pop takes the best of the next class heap (round robin), and the heap's cut keeps the class states (each
	// class heap holds at most SQ_CAP, its worst half dropped past it). A type-based best-first: ordering only, no claim.)
	const SQ = process.env.EEAT_SPEED_Q === '1' || !!o.speedQ;
	const SQ_K = +process.env.EEAT_SQ_K >= 2 ? +process.env.EEAT_SQ_K : 4;
	const SQ_VY = process.env.EEAT_SQ_VY !== undefined ? +process.env.EEAT_SQ_VY : -7;
	const SQ_CAP = +process.env.EEAT_SQ_CAP > 0 ? +process.env.EEAT_SQ_CAP : heapMax >> 3;
	const sqClass = (s) => {
		if (s.speed_y < SQ_VY) return 4;
		const ax = s.speed_x < 0 ? -s.speed_x : s.speed_x;
		return ax < 2 ? 0 : ax < 4 ? 1 : ax < 6 ? 2 : 3;
	};
	const SQH = SQ ? [null, { h: [], f: [] }, { h: [], f: [] }, { h: [], f: [] }, { h: [], f: [] }] : null;
	const inG = SQ ? [] : null;   // (a node still in the main heap: the cut frees its snapshot only when no heap holds it)
	const sqCls = SQ ? [] : null;
	let sqRR = 0, sqPops = 0;
	const qpush = (Q, i, f) => {
		const h = Q.h, hq = Q.f;
		let k = h.length; h.push(i); hq.push(f);
		while (k > 0) { const p = (k - 1) >> 1; if (hq[p] <= f) break; h[k] = h[p]; hq[k] = hq[p]; k = p; }
		h[k] = i; hq[k] = f;
	};
	const qpop = (Q) => {
		const h = Q.h, hq = Q.f, top = h[0], n = h.length - 1, li = h[n], lf = hq[n];
		h.length = n; hq.length = n;
		if (n > 0) {
			let k = 0;
			for (;;) {
				let c = 2 * k + 1;
				if (c >= n) break;
				if (c + 1 < n && hq[c + 1] < hq[c]) c++;
				if (hq[c] >= lf) break;
				h[k] = h[c]; hq[k] = hq[c]; k = c;
			}
			h[k] = li; hq[k] = lf;
		}
		return top;
	};
	/** a class state's node into its class heap (its worst half dropped past SQ_CAP: a snapshot no heap holds goes) */
	const sqAdd = (j, f, c) => {
		const Q = SQH[c];
		qpush(Q, j, f);
		if (Q.h.length <= SQ_CAP) return;
		const idx = Q.h.map((x, k) => k).sort((a, b) => Q.f[a] - Q.f[b]);
		const keep = idx.slice(0, SQ_CAP >> 1);
		for (const k of idx.slice(SQ_CAP >> 1)) { const n = Q.h[k]; sqCls[n] = 0; if (!inG[n] && sn[n]) { pool.push(sn[n]); sn[n] = null; } }
		const nh = keep.map((k) => Q.h[k]), nf = keep.map((k) => Q.f[k]);
		Q.h.length = 0; Q.f.length = 0;
		for (let k = 0; k < nh.length; k++) { Q.h.push(nh[k]); Q.f.push(nf[k]); }   // (sorted by f: a valid heap)
	};
	/** the next class heap's best live node (round robin over the classes), or -1 */
	const sqNext = () => {
		for (let t = 0; t < 4; t++) {
			const Q = SQH[1 + ((sqRR + t) & 3)];
			while (Q.h.length && !sn[Q.h[0]]) qpop(Q);
			if (Q.h.length) { sqRR = (sqRR + t + 1) & 3; return qpop(Q); }
		}
		return -1;
	};
	const closed = new PairSet(1 << 16, ENERGY);
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
	const ZC = o.zeroCell !== undefined ? !!o.zeroCell : ZERO_CELL;
	const cellKey = () => {
		let h = 0x811c9dc5 | 0;
		const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
		if (ZC) {
			// (THE ZERO-SPEED BUCKET: a speed of exactly 0 is a cell of its own, not the [0, 1/q) bucket it shares with a
			// slow drift: a ball falling straight down a 1-wide column (vx 0, px on the tile grid) and the same ball with an
			// input held into the column's wall (vx +0.1: the wall stops the move, not the speed) share every cell of the
			// fall, the first one popped closes them, and when that is the drifting one it slides onto the ledge beside the
			// next 1-wide opening (UT Eternal Galaxy: 3 up-arrow rows under a dot row, from the known route's own state at the
			// column's top legBest never entered the arrows in 300 ms; the zero-input fall reaches the coin in 56 ticks)
			// (per axis only the state AT REST ON THE GRID (speed exactly 0 and the position exactly on the tile grid: the 16 px
			// box enters a 1-wide opening only there) gets the extra bucket: every other state keeps its cell, so the cells grow
			// by at most one per cell where such a state arrives)
			const ax = sim.speed_x === 0 && sim.px % 16 === 0, ay = sim.speed_y === 0 && sim.py % 16 === 0;
			mix(Math.floor(sim.px * q0) | 0); mix(Math.floor(sim.py * q1) | 0); mix(Math.floor(sim.speed_x * q2) | 0); mix(Math.floor(sim.speed_y * q3) | 0);
			if (ax || ay) mix(0x7f00 | (ax ? 1 : 0) | (ay ? 2 : 0));
		} else { mix(Math.floor(sim.px * q0) | 0); mix(Math.floor(sim.py * q1) | 0); mix(Math.floor(sim.speed_x * q2) | 0); mix(Math.floor(sim.speed_y * q3) | 0); }
		mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0) | (CLOCK && sim._timedoor_state ? 1024 : 0));
		if (FX_CELL) { const f = fxWord(sim); if (f !== 0) mix(0x5a000000 | f); }
		if (Q_CELL) { const q = qWord(sim); if (q !== 0) { mix(0x5b000000); mix(q); } }
		if (KEY_CELL) { const k = keyWord(sim); if (k !== 0) { mix(0x5c000000); mix(k); } }
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
		cellKey(); if (ENERGY) closed.addV(ka, kb, Math.hypot(sim.speed_x, sim.speed_y), EDV); else closed.add(ka, kb);
		hpush(i, gg[i] + w * scoreOf(d));
		if (SQ) inG[i] = 1;
	}
	let why = 'exhausted';
	let popsAtFound = -1;
	const drop = { dead: 0, over: 0, oob: 0, region: 0, closed: 0, skipJ: 0 };
	const over = typeof goal.over === 'function' ? goal.over : null;
	while ((heap.length || SQ) && goals.length < collect && (popsAtFound < 0 || pops - popsAtFound < 3000)) {
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
		let i;
		if (SQ && (++sqPops % SQ_K === 0 || !heap.length)) { i = sqNext(); if (i < 0) { if (!heap.length) break; i = hpop(); } } else i = hpop();
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
			if (!(ENERGY ? closed.addV(ka, kb, Math.hypot(sim.speed_x, sim.speed_y), EDV) : closed.add(ka, kb))) { drop.closed++; continue; }
			// (o.onAdd(cellHash, sim, tick): a diagnostic hook, every state the search keeps)
			if (o.onAdd) o.onAdd(ka, sim, g + reps);
			const d = distD(field, sim, allowDeath);
			const j = par.length;
			par.push(i); msk.push(m); rp.push(reps); gg.push(g + reps); dst.push(d);
			sn.push(sim.snapshot(pool.length ? pool.pop() : undefined));
			const fj = g + reps + w * (scoreOf(d) + saxPen(sim)) + (KC !== null ? diePri(L, sim, KC, g + reps) : 0);
			hpush(j, fj);
			if (SQ) { inG[j] = 1; const c = sqClass(sim); if (c) { sqCls[j] = c; sqAdd(j, fj, c); } }
			if (d < 1e9 && (closest.dist < 0 || d < closest.dist)) { closest.dist = d; closest.node = j; closest.pop = pops; }
			if (FIN && d <= FIN_D && finR === null) keepNear(j, d, cy * W + cx);
		}
		pool.push(snap);
		if (heap.length > heapMax) {
			// (the worst half of the open states goes: their snapshots back to the pool)
			const idx = heap.map((x, k) => k).sort((a, b) => hf[a] - hf[b]);
			const keep = idx.slice(0, heapMax >> 1);
			const nh = keep.map((k) => heap[k]), nf = keep.map((k) => hf[k]);
			for (const k of idx.slice(heapMax >> 1)) { const n = heap[k]; if (SQ) { inG[n] = 0; if (sqCls[n]) continue; } if (sn[n]) { pool.push(sn[n]); sn[n] = null; } }
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

/** THE SIDE-ARROW CROSSINGS (COMPILE-ALL lane 4, block 3): the goal field keeps no horizontal speed, so it crosses a run of
 *  side arrows against their push at any speed (reach.js prices only runs of 5+, which the running speed cannot cross);
 *  a run of 2-4 is crossed only by a ball that came in fast (Christmas Town's coin (397, 3): its known route enters 4 left
 *  arrows at 6.04 px/tick after a run-up and coasts out at 1.2; Beaches in Space's coin (69, 71) behind 3 right arrows):
 *  the finders sat at the run's slow states ("closest 2 tiles", 3 rungs) and never went back for the run-up.
 *  saxOf(L, field): per tile p (the push: -1 left arrows 1 / 411, +1 right arrows 3 / 413, else 0) and k (the arrows of
 *  that push from this tile on against the push, itself included; 0 where the field's way does not go on past the run:
 *  the least field cost on the tile past it (or a row up / down) not below this tile's). saxNeed(r): the least speed
 *  (px/tick) against the push that carries the centre r tiles on to the run's far edge (reach.js's crossing table
 *  1.05 / 3.15 / 4.55 / 5.65 / 6.75 / 7.5 for 1..6 tiles, linear between, +0.75 a tile past 6). OPT-IN (EEAT_SAX=1): a
 *  first version (one tile lenient: the need of k - 1 tiles) on the lane's 23 levels, box 3, 60 s: progress 58 vs 72 (Ice Cream Expedition 1 vs 8, CTM 2 0 vs 2, Two 2 vs 3; Christmas Town / Beaches in Space not reached
 *  either way): the runs' slow states were not what stalled those legs (their closest 0 / 2 tiles are the skeleton's and
 *  the pocket's); this version (the need by what is left of the run, px) is not measured in a compile. */
const SAX_NEED = [0, 1.05, 3.15, 4.55, 5.65, 6.75, 7.5];
const saxNeed = (r) => {
	if (!(r > 0)) return 0;
	const n = SAX_NEED.length - 1;
	if (r >= n) return SAX_NEED[n] + 0.75 * (r - n);
	const i = Math.floor(r), f = r - i;
	return SAX_NEED[i] + f * (SAX_NEED[i + 1] - SAX_NEED[i]);
};
const SAX_PEN = +process.env.EEAT_SAX_PEN > 0 ? +process.env.EEAT_SAX_PEN : 4;
const saxMemo = new WeakMap();
function saxOf(L, f) {
	let r = saxMemo.get(f);
	if (r) return r;
	const W = L.width, H = L.height, N = W * H, CUT = RF.CUT;
	const p = new Int8Array(N), k = new Uint16Array(N);
	let any = false;
	for (let t = 0; t < N; t++) { const id = L.fg[t]; if (id === 1 || id === 411) { p[t] = -1; any = true; } else if (id === 3 || id === 413) { p[t] = 1; any = true; } }
	if (any && f.costR) {
		const tm = tileMinLegs(f);
		for (let t = 0; t < N; t++) {
			if (!p[t] || tm[t] >= CUT) continue;
			const dx = -p[t], x = t % W, y = (t / W) | 0;
			let n = 0, xx = x;
			while (xx >= 0 && xx < W && p[y * W + xx] === p[t]) { n++; xx += dx; }
			if (xx < 0 || xx >= W) continue;
			let best = CUT;
			for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy >= 0 && yy < H && tm[yy * W + xx] < best) best = tm[yy * W + xx]; }
			if (best < tm[t]) k[t] = n;
		}
	}
	r = { p, k };
	saxMemo.set(f, r);
	return r;
}
/** per tile the least cost (fifths) of any ball state centred on it by the goal field f (executor.js tileMinOf's) */
function tileMinLegs(f) {
	const N = f.W * f.H, CUT = RF.CUT, m = new Uint32Array(N).fill(CUT);
	const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
	for (let t = 0; t < N; t++) {
		let v = CUT;
		for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
		for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
		const rc = f.rowC[t], rx = f.rowX[t];
		if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
		if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
		m[t] = v;
	}
	return m;
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
/** a death step's PRIORITY (ordering only; the goal test and every replay are the engine's): its field is 0 on the
 *  killers' neighbours (the tiles a death starts from: model.js dieSrc) and a dead ball's distance is 0, but the goal
 *  (alive back at a respawn, one death more) is still the last steps into the killer's cell AND ~55 dead ticks away. The
 *  best-first search's dive reached the doorstep at priority ~g and stopped there: every child on the doorstep costs
 *  g + reps while the whole dive's backlog waits at ~g, so the entry and the dead ball's hold to its respawn were never
 *  popped (box 3, from the level's start, the executor's best tier with the die field: Lab of Insanity 814 k pops,
 *  I Wanna be the Guy 1.07 M pops, ZERO dead ticks, where random runs die in 100% / 25% of their runs, and holding right
 *  from IWBTG's doorstep dies in 7 ticks). So a DEAD ball goes first (2 x DIE_PRI ahead: its expansion holds through the
 *  dead ticks, whose last tick is the goal test at the respawn), then an alive ball whose centre is within 24 px of a kill
 *  cell (a killer, or a half block whose current-tile redirect is one: the engine's kill test reads the centre's cell),
 *  nearer first by up to DIE_NEAR ticks (the gradient into the killer the tile field has not): a death step dives INTO
 *  the death. The same searches then: Lab of Insanity found in 0.28 s (148 ticks), The Square 0.31 s (305), IWBTG 0.43 s
 *  (268). EEAT_DIE_PRI=0: off (the order as before) */
const TMD = require('../timed.js');
const DIE_PRI = process.env.EEAT_DIE_PRI === '0' ? 0 : 1e6, DIE_NEAR = 16;
const killCellsMemo = new WeakMap();
function killCellsOf(L) {
	let m = killCellsMemo.get(L);
	if (m) return m;
	const W = L.width, H = L.height, N = W * H, fg = L.fg, gF = L.gFlags, fl = L.flags, xf = L.xflags, lk = L.lookup0;
	m = new Uint8Array(N);
	const kills = (id) => gF && id >= 0 && id < gF.length && (gF[id] & 4) !== 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (kills(id)) { m[i] = 1; continue; }
		if (fl && id < fl.length && (fl[id] & 8) !== 0) {   // F_HALF: the centre's cell redirects up (rotation 1) or left (0)
			let rot = lk ? lk[i] : 0;
			if (xf && (xf[id] & 4) !== 0) rot = 1;   // X_NONROT_HALF
			const x = i % W, y = (i / W) | 0;
			const j = rot === 1 ? (y > 0 ? i - W : -1) : rot === 0 ? (x > 0 ? i - 1 : -1) : i;
			if (j >= 0 && j !== i && kills(fg[j])) m[i] = 1;
		}
	}
	killCellsMemo.set(L, m);
	return m;
}
/** the death step's priority shift (ticks, <= 0) for the ball now in sim */
function diePri(L, sim, kc, gt) {
	if (sim.is_dead) return -2 * DIE_PRI;
	// (a running timed killer (poison, curse, zombie, fire) kills the ball at a fixed tick wherever it is: its lineage goes
	// DEPTH first, the deepest ahead, until that tick (DEEPER's death step: its die sources are poison effects; breadth
	// first over the poisoned states never reached the tick of the death)
	if (TMD.timedLeft(sim) > 0) return -DIE_PRI - 2 * gt;
	const W = L.width, H = L.height, cx = sim.px + 8, cy = sim.py + 8, tx = cx >> 4, ty = cy >> 4;
	let best = Infinity;
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const x = tx + dx, y = ty + dy;
		if (x < 0 || y < 0 || x >= W || y >= H || kc[y * W + x] !== 1) continue;
		const ex = cx < x * 16 ? x * 16 - cx : cx >= x * 16 + 16 ? cx - (x * 16 + 16) + 1 : 0;
		const ey = cy < y * 16 ? y * 16 - cy : cy >= y * 16 + 16 ? cy - (y * 16 + 16) + 1 : 0;
		const e = Math.sqrt(ex * ex + ey * ey);
		if (e < best) best = e;
	}
	return best === Infinity || best >= 24 ? 0 : -DIE_PRI - DIE_NEAR * (1 - best / 24);
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

/**
 * THE COVERAGE FINDER (doctor 7, n5-doc-7; OPT-IN EEAT_COVER=1: the executor's tier 3 runs it first for EEAT_COVER_SHARE of
 * its window from rung EEAT_COVER_RUNG on). The other finders rank by the goal field (legBest: f = tick + w x the field's
 * time; legBFS: the field's rank per layer), and the field is a relaxation: where the only way to the goal first goes AWAY
 * from it (a run-up: an arrow field, a boost, a pump; a detour around a wall the relaxation crosses) every state of the
 * detour ranks behind the whole false near's region, and a 400-1,000-tick leg ends 'budget' at every rung. Measured on the
 * known routes of doctor 7's batch (src/out/n5/doctor/batch7.md): along the route's own leg the goal field RISES by 28.4
 * tiles (K Underground, checkpoint (17,80) -> (64,84): the run-up column (9, 73-76) into the right-arrow field), 36.4
 * (Helix Reborn), 21.6 (Vignettes), 16.6 (The Tunnels), 12.6 (Endeavor) before it falls to the goal, and legBest fails
 * those legs at rungs 1-2 from the route's OWN state (tools/cmp/krt.js). This finder does not follow the field: coarse
 * cells (the centre tile, 7 x-speed and 7 y-speed classes, on the ground, the door-reading state) keep their EARLIEST
 * arrival; a cell is picked by novelty (a tournament of COV_K cells by 1 / sqrt(1 + picks) + 0.5 / sqrt(1 + seen)), a
 * share COV_PF of the picks the field's nearest of a sample (the pull toward the goal), and from it COV_R sticky random
 * rollouts of 20-60 ticks (an input kept with p COV_KEEP) inside the executor's region; the goal test is the executor's
 * (X.goalAt), every new cell a node of a path tree, so a find is a path of real inputs (the executor replays it, as every
 * finder's). A seeded PRNG (the same seed, the same search for a given tick budget). Not a proof, not a bound.
 *   legCover(L, starts, goal, o) -> legBest's result shape: {status 'found' | 'time' | 'stopped' | 'exhausted', goals
 *   [{start, tail, depth}], tick, depth, start, tail, closest {dist, start, tail}, sims, passes, seconds, t0}
 *   o: {sim, deadline, stop, allowDeath, beforeTick, field, region, depthMax, seed, maxCells}
 */
const COV_K = 16, COV_PF = +process.env.EEAT_COVER_PF >= 0 && process.env.EEAT_COVER_PF !== undefined ? +process.env.EEAT_COVER_PF : 0.25;
const COV_R = 4, COV_KEEP = +process.env.EEAT_COVER_KEEP > 0 ? +process.env.EEAT_COVER_KEEP : 0.9;
const COV_MASKS = (() => { const a = []; for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) a.push(h | v | j); return a; })();
function covVx(v) { return v <= -9 ? 0 : v <= -7 ? 1 : v <= -5 ? 2 : v <= -2.5 ? 3 : v < -0.5 ? 4 : v < 0.5 ? 5 : v < 2.5 ? 6 : v < 5 ? 7 : v < 7 ? 8 : v < 9 ? 9 : 10; }
function covVy(v) { return v <= -8 ? 0 : v <= -4 ? 1 : v < -1 ? 2 : v < 1 ? 3 : v < 4 ? 4 : v < 8 ? 5 : 6; }
function legCover(L, starts, goal, o) {
	o = o || {};
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	const W = L.width, H = L.height;
	const allowDeath = !!o.allowDeath;
	const deadline = o.deadline || Infinity, stop = o.stop || null;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const field = o.field || null, region = o.region || null;
	const maxCells = o.maxCells > 0 ? o.maxCells : (+process.env.EEAT_COVER_CELLS || 40000);
	const tStart = Date.now();
	let seed = (o.seed >>> 0) || 0x9e3779b9;
	const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const t0 = starts[order[0]].tick;
	let depthMax = o.depthMax > 0 ? o.depthMax : 4000;
	if (beforeTick >= 0) depthMax = Math.min(depthMax, beforeTick - t0);
	const dkOf = discKeyCache();
	// the path tree: a node = its parent, the inputs from the parent's state to its own, its depth (ticks past t0)
	const nPar = [], nSeg = [], nG = [], nStart = [];
	// the cells: key -> index; per cell its node, snapshot, picks, seen, field distance
	const cellIx = new Map();
	const cNode = [], cSnap = [], cPick = [], cSeen = [], cDist = [];
	const keyOf = () => {
		const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
		return `${(cy * W + cx) * 154 + covVx(sim.speed_x) * 14 + covVy(sim.speed_y) * 2 + (sim.on_ground ? 1 : 0)}|${dkOf(sim) | 0}`;
	};
	const pathOf = (node, extra, n) => {
		const segs = [];
		let k = node;
		while (k >= 0) { segs.push(nSeg[k]); if (nPar[k] < 0) break; k = nPar[k]; }
		let len = n || 0;
		for (const s of segs) len += s.length;
		const tail = new Uint8Array(len);
		let p = 0;
		for (let i = segs.length - 1; i >= 0; i--) { tail.set(segs[i], p); p += segs[i].length; }
		if (n) tail.set(extra.subarray(0, n), p);
		return { start: nStart[node], tail };
	};
	const goals = [];
	const closest = { dist: -1, start: -1, tail: null, node: -1, pop: -1 };
	let sims = 0, picks = 0, lastPoll = 0;
	for (const s of order) {
		sim.restore(starts[s].snap);
		if (sim.is_dead && !allowDeath) continue;
		const j = nPar.length;
		nPar.push(-1); nSeg.push(new Uint8Array(0)); nG.push(starts[s].tick - t0); nStart.push(s);
		if (X.goalAt(goal, sim, starts[s].tick, beforeTick)) { goals.push({ start: s, tail: new Uint8Array(0), depth: starts[s].tick - t0 }); continue; }
		const k = keyOf();
		if (cellIx.has(k)) continue;
		const d = distOf(field, sim);
		cellIx.set(k, cNode.length); cNode.push(j); cSnap.push(sim.snapshot()); cPick.push(0); cSeen.push(1); cDist.push(d);
		if (d < 1e9 && (closest.dist < 0 || d < closest.dist)) { closest.dist = d; closest.node = j; }
	}
	const buf = new Uint8Array(64);
	let why = 'time';
	if (goals.length) why = 'found';
	else if (!cNode.length) why = 'exhausted';
	while (!goals.length && cNode.length) {
		if ((picks & 15) === 0) {
			const now = Date.now();
			if (now > deadline) { why = 'time'; break; }
			if (stop !== null && now - lastPoll >= 20) { lastPoll = now; if (stop()) { why = 'stopped'; break; } }
		}
		picks++;
		// the pick: the field's nearest of a sample (COV_PF of the picks), else novelty
		const n = cNode.length;
		let c = -1;
		if (field && rnd() < COV_PF) {
			let bd = Infinity;
			for (let s = 0; s < 2 * COV_K; s++) { const i = (rnd() * n) | 0; const v = cDist[i] + 0.5 * Math.sqrt(cPick[i]); if (v < bd) { bd = v; c = i; } }
		} else {
			let bs = -1;
			for (let s = 0; s < COV_K; s++) { const i = (rnd() * n) | 0; const v = 1 / Math.sqrt(1 + cPick[i]) + 0.5 / Math.sqrt(1 + cSeen[i]); if (v > bs) { bs = v; c = i; } }
		}
		cPick[c]++;
		const node0 = cNode[c], g0 = nG[node0];
		if (g0 >= depthMax) continue;
		for (let r = 0; r < COV_R && !goals.length; r++) {
			sim.restore(cSnap[c]);
			const len = Math.min(20 + ((rnd() * 41) | 0), depthMax - g0, buf.length);
			let m = COV_MASKS[(rnd() * COV_MASKS.length) | 0];
			for (let k = 0; k < len; k++) {
				if (k > 0 && rnd() > COV_KEEP) m = COV_MASKS[(rnd() * COV_MASKS.length) | 0];
				buf[k] = m;
				E.applyMask(inp, m); sim.tick(inp); sims++;
				const g = g0 + k + 1;
				if (sim.is_dead && !allowDeath) break;
				if (!sim.is_dead && X.goalAt(goal, sim, t0 + g, beforeTick)) {
					const p = pathOf(node0, buf, k + 1);
					goals.push({ start: p.start, tail: p.tail, depth: g });
					break;
				}
				const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
				if (cx < 0 || cy < 0 || cx >= W || cy >= H) break;
				if (region !== null && !region[cy * W + cx]) break;
				if (sim.is_dead) continue;
				const key = keyOf();
				const ci = cellIx.get(key);
				if (ci !== undefined) {
					cSeen[ci]++;
					// (an earlier arrival takes the cell: its node and snapshot)
					if (g < nG[cNode[ci]]) {
						const j = nPar.length;
						nPar.push(node0); nSeg.push(buf.slice(0, k + 1)); nG.push(g); nStart.push(nStart[node0]);
						cNode[ci] = j; cSnap[ci] = sim.snapshot(cSnap[ci]);
					}
					continue;
				}
				if (cNode.length >= maxCells) continue;
				const d = distOf(field, sim);
				const j = nPar.length;
				nPar.push(node0); nSeg.push(buf.slice(0, k + 1)); nG.push(g); nStart.push(nStart[node0]);
				cellIx.set(key, cNode.length); cNode.push(j); cSnap.push(sim.snapshot()); cPick.push(0); cSeen.push(1); cDist.push(d);
				if (d < 1e9 && (closest.dist < 0 || d < closest.dist)) { closest.dist = d; closest.node = j; closest.pop = picks; }
			}
		}
	}
	if (goals.length) why = 'found';
	if (closest.node >= 0) { const p = pathOf(closest.node, null, 0); closest.start = p.start; closest.tail = p.tail; }
	const res = { status: why, passes: [{ pops: picks, cells: cNode.length, why }], sims, closest, seconds: (Date.now() - tStart) / 1000, t0 };
	if (goals.length) { goals.sort((a, b) => a.depth - b.depth); Object.assign(res, { tick: t0 + goals[0].depth, depth: goals[0].depth, start: goals[0].start, tail: goals[0].tail, goals }); }
	return res;
}

module.exports = { legBFS, legBest, legCover, cellOf, eta };
