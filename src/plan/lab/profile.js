'use strict';
// src/plan/lab/profile.js - THE CORRIDOR PROFILE SOLVER (n5-lab-profile, approach B: time-optimal speed profiles along
// corridors). A LAB PROTOTYPE: nothing requires it unless EEAT_PROFILE=1 (the executor's opt-in tier).
//
// The classic time-optimal path parametrisation (TOPP) takes a path and finds the fastest admissible speed along it; its
// optimal controls are BANG-BANG (every input at an extreme, switched at a few times). In EE the geometric path is the
// CORRIDOR (the level sets of the goal field: the physics-aware cost to the target, src/reach.js), and the axes are 1D
// systems (docs/ee_math.md 2: the tick factorizes) whose time-optimal controls are bang-bang too (THEOREM M: hold toward
// is the extreme of every input word; the gravity axis has no input but the jump, fired on a grounded tick). So a leg is
// solved over the BANG-BANG FAMILY instead of the per-tick input space:
//   - the input axis holds ONE key (or none) between SWITCHING EVENTS: a landing, the apex, a wall stop, every P ticks of
//     an arc (the switching-time grid);
//   - the gravity axis' only decision is the jump bit on the ticks whose move hits the floor (THE RUNNER DP: with the
//     horizontal word fixed, every jump schedule is a path in a small DAG: the state after a landing is canonical, (the
//     tick, the floor line) when no wall was met, so the schedules merge there exactly (stateHash));
//   - the phase plane of each tick (TOPP-RA's reachable set, one set per tick) is kept as the states the family reaches,
//     merged exactly by stateHash and cut to a width by the time to go (the goal field's distance at the running pace from
//     the speed along its descent) with a diversity quota per (tile, support, direction of motion): the phase plane's
//     front instead of the fastest state alone (the slow state at a turn is the one that makes it).
// Every emitted input string is the engine's own replay from the start (EESim): the answer is exact by construction.
//
//   profileLeg(L, starts, goal, o) -> {ok, masks, start, tick (the leg's ticks from its start), ms, layers, sims, why,
//     closest (the least time to go the cut kept)}
//     starts: [{snap, tick}] (the tick is the start's absolute tick: the earliest start is layer 0)
//     goal: types.js goalOf(L, wp) (test(sim), tiles, fieldTiles, allowDeath)
//     o: {ms (budget, 2000), deadline, width (W 300), quota (per diversity cell 3), period (P 6), depth (Tmax 3000),
//         field (the goal field; else built: types.js goalField of the level as the doors stand at the first start),
//         stop ()}
const E = require('../../eesim.js');
const RF = require('../../reach.js');
const T = require('../types.js');

const F_LIQUID = 64, F_CLIMB = 32, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const A_RUN = 1 / 7.752, V_RUN = 6.776552880470027;
const DIRS3 = [0, 2, 4];                              // - L R
const DIRS9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];       // - L R U D LU RU LD RD
const NOV_SHARE = process.env.EEAT_PROFILE_NOV !== undefined ? +process.env.EEAT_PROFILE_NOV : 0.3;
const CELL_DOM = process.env.EEAT_PROFILE_CELL !== '0';
// the finish (the move solver from the front's best states): on (EEAT_PROFILE_FIN=0 off), every FIN_EVERY layers the FIN_K
// best states within FIN_EST ticks of the goal by the time to go, a leg of at most FIN_TMAX ticks, FIN_MS of clock, the
// coupled family's FIN_CT ticks, the field tier's FIN_FMS
const FIN_ON = process.env.EEAT_PROFILE_FIN !== '0';
const FIN_EVERY = +process.env.EEAT_PROFILE_FIN_EVERY || 4, FIN_K = +process.env.EEAT_PROFILE_FIN_K || 2;
const FIN_EST = +process.env.EEAT_PROFILE_FIN_EST || 80, FIN_TMAX = 120, FIN_MS = 60, FIN_CT = 20000, FIN_FMS = 20;

/** ticks to cover D px from speed v along the way: the running acceleration up to the running speed (legs.js eta) */
function eta(D, v) {
	if (D <= 0) return 0;
	if (v >= V_RUN) return D / v;
	if (v < -V_RUN) v = -V_RUN;
	const tv = (V_RUN - v) / A_RUN, dv = v * tv + 0.5 * A_RUN * tv * tv;
	if (D <= dv) return (-v + Math.sqrt(v * v + 2 * A_RUN * D)) / A_RUN;
	return tv + (D - dv) / V_RUN;
}

/** the walk field's descent direction per tile (unit vectors; legs.js dirsOf) */
const DIRS_MEMO = new WeakMap();
function dirsOf(field) {
	let d = DIRS_MEMO.get(field);
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
	DIRS_MEMO.set(field, d);
	return d;
}

/**
 * profileLeg: the bang-bang family's reachable sets tick by tick (see the header). Returns the earliest arrival the family
 * reaches within the budget.
 */
function profileLeg(L, starts, goal, o = {}) {
	const t0ms = Date.now();
	const W = L.width, H = L.height;
	const deadline = Math.min(o.deadline > 0 ? o.deadline : Infinity, t0ms + (o.ms > 0 ? o.ms : 2000));
	const width = o.width > 0 ? o.width : 300, quota = o.quota > 0 ? o.quota : 3, P = o.period > 0 ? o.period : 6;
	const depth = o.depth > 0 ? o.depth : 3000;
	const allowDeath = !!goal.allowDeath;
	const stop = typeof o.stop === 'function' ? o.stop : null;
	const sim = new E.EESim(L), inp = new E.EEInput();
	const flags = L.flags;
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const tBase = starts[order[0]].tick;
	// the goal field (the corridor): the level as the doors stand at the first start
	let field = o.field || null;
	if (!field) {
		sim.restore(starts[order[0]].snap);
		try { field = T.goalField(T.levelNow(L, sim), T.fieldTilesOf(goal), { deaths: allowDeath }); } catch (e) { field = null; }
	}
	const dirs = field ? dirsOf(field) : null;
	const tileNow = () => Math.min(H - 1, Math.max(0, (sim.py + 8) >> 4)) * W + Math.min(W - 1, Math.max(0, (sim.px + 8) >> 4));
	// A GIVEN CORRIDOR (o.guide: the centre positions of a path, one per tick, and its tube radius): the time to go is the
	// path's own time from the latest of its points within the tube (the progress along the path), + the distance to it at
	// the running pace; a state outside the tube is dropped. The lab's diagnosis: the time parametrisation along a known
	// corridor, apart from the corridor's extraction.
	const guide = o.guide || null;
	let gIdx = null;
	if (guide) {
		// a tile -> the path's points within the tube of it (sorted by tick)
		gIdx = new Map();
		const R = guide.r || 48, n = guide.x.length;
		for (let k = 0; k < n; k++) {
			const tx0 = Math.floor((guide.x[k] - R) / 16), tx1 = Math.floor((guide.x[k] + R) / 16);
			const ty0 = Math.floor((guide.y[k] - R) / 16), ty1 = Math.floor((guide.y[k] + R) / 16);
			for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
				if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
				const t = ty * W + tx;
				let a = gIdx.get(t);
				if (!a) gIdx.set(t, a = []);
				if (a.length === 0 || a[a.length - 1] !== k) a.push(k);
			}
		}
	}
	const guideEst = (t) => {
		const a = gIdx.get(t);
		if (!a) return 1e9;
		const R = guide.r || 48, cx = sim.px + 8, cy = sim.py + 8, n = guide.x.length;
		for (let q = a.length - 1; q >= 0; q--) {
			const k = a[q], dx = guide.x[k] - cx, dy = guide.y[k] - cy, dd = Math.hypot(dx, dy);
			if (dd <= R) return (n - 1 - k) + dd / V_RUN;
		}
		return 1e9;
	};
	/** the time to go (ticks) of the state in sim: the field's distance at the running pace from the speed along its descent */
	const estOf = (t) => {
		if (guide) return sim.is_dead ? 1e9 : guideEst(t);
		if (!field) return 0;
		if (sim.is_dead) return allowDeath ? 0 : 1e9;
		const c = RF.costAt(field, sim);
		if (c < 0) return 1e9;
		const v = dirs ? sim.speed_x * dirs[2 * t] + sim.speed_y * dirs[2 * t + 1] : 0;
		return eta(c * 16, v);
	};
	/** the relevant direction masks of the state in sim: the plain vertical-gravity field acts on L / R only */
	const dirsFor = () => {
		const id = sim.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
		if (sim.flip_gravity === 0 && !(f & (F_LIQUID | F_CLIMB | F_BOOST)) && !DOTS.has(id) && !sim.has_levitation) {
			const gd = sim.gravity_dir;
			if (!gd || gd.x === 0) return DIRS3;
		}
		return DIRS9;
	};
	// THE FINISH (the mathematics of the last stretch): the front's best states within FIN_EST ticks of the goal by the time
	// to go ask the move solver (src/plan/msolve.js: the plain regime's closed forms, the field tier, the coupled family) for
	// the direct leg to the goal's tiles; its answer is replayed by the engine to the goal's own test (the touch lag: the
	// last input held up to 2 ticks more). The best finish's arrival tick bounds the front: the layers go on to it (an
	// earlier arrival of the family itself wins).
	const finOn = o.finish !== undefined ? !!o.finish : FIN_ON;
	let msol = null;
	const msolver = () => msol || (msol = require('../msolve.js').createSolver(L, {}));
	const finTried = new Set();
	let bestFin = null;          // {arrive (depth), ref (the node's ref at depth d0), d0, masks}
	const finishTry = (nd, d) => {
		if (finTried.has(nd.h)) return;
		finTried.add(nd.h);
		const Tmax = Math.min(FIN_TMAX, Math.max(8, Math.ceil(nd.est * 1.6) + 8));
		if (bestFin && d + 1 >= bestFin.arrive) return;
		let r = null;
		try {
			r = msolver().leg(nd.sn, { tiles: Array.from(goal.tiles), cls: 'any' }, { Tmax: bestFin ? Math.min(Tmax, bestFin.arrive - d - 1) : Tmax, chain: false, coupledTicks: FIN_CT, fieldMs: FIN_FMS, deadline: Math.min(deadline, Date.now() + FIN_MS) });
		} catch (e) { r = null; }
		finCalls++;
		if (!r || !r.ok) return;
		// the goal's own test on the engine's replay (the touch lag: the last input held up to 2 ticks more)
		sim.restore(nd.sn);
		const ms = Array.from(r.masks);
		let hit = -1;
		for (let t = 0; t < ms.length + 2; t++) {
			const m = t < ms.length ? ms[t] : (ms[ms.length - 1] & 30);
			if (t >= ms.length) ms.push(m);
			E.applyMask(inp, m); sim.tick(inp);
			if (sim.is_dead && !allowDeath) break;
			if (goal.test(sim)) { hit = t + 1; break; }
		}
		if (hit < 0) return;
		const arrive = d + hit;
		if (!bestFin || arrive < bestFin.arrive) { bestFin = { arrive, ref: nd.ref, d0: d, masks: ms.slice(0, hit), tool: r.tool }; finOK++; }
	};
	let finCalls = 0, finOK = 0;
	// the layers: layers[d] = the states at depth d + 1: their parent reference (the index in layers[d - 1], or -1 - s for a
	// start) and the mask of their tick
	const layers = [];
	const visits = new Uint16Array(W * H);
	const seen = new Set(), cells = new Set();
	const cellDom = o.cellDom !== undefined ? !!o.cellDom : CELL_DOM;
	const cellKey = () => {
		let h = 0x811c9dc5 | 0;
		const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
		mix(Math.floor(sim.px) | 0); mix(Math.floor(sim.py * 0.5) | 0); mix(Math.floor(sim.speed_x * 8) | 0); mix(Math.floor(sim.speed_y * 4) | 0);
		mix((sim.on_ground ? 1 : 0) | ((sim.jump_count & 255) << 1) | (sim.is_dead ? 512 : 0) | ((sim._keysMask & 63) << 10));
		let g = 0x2545f491 | 0;
		g ^= Math.floor(sim.px * 3) | 0; g = Math.imul(g, 0x5bd1e995); g ^= Math.floor(sim.py * 1.5) | 0; g = Math.imul(g, 0x5bd1e995);
		g ^= Math.floor(sim.speed_x * 24) | 0; g = Math.imul(g, 0x5bd1e995); g ^= Math.floor(sim.speed_y * 12) | 0; g = Math.imul(g, 0x5bd1e995);
		return (h >>> 0) * 1048576 + ((g >>> 12) & 0xfffff);
	};
	let cur = [];           // {sn, dm, last, gr, vs, vx, est, ref}
	let si = 0, sims = 0;
	let bestEst = Infinity;
	let found = null, why = 'depth';
	for (let d = 0; d <= depth; d++) {
		// the starts of this depth
		while (si < order.length && starts[order[si]].tick - tBase === d) {
			const s = order[si++];
			sim.restore(starts[s].snap);
			if (sim.is_dead && !allowDeath) continue;
			if (goal.test(sim)) { found = { depth: d, ref: -1 - s, msk: -1 }; break; }
			cur.push({ sn: sim.snapshot(), dm: -1, last: -1e9, gr: !!sim.on_ground, vs: Math.sign(sim.speed_y), vx: sim.speed_x, est: estOf(tileNow()), ref: -1 - s, h: sim.stateHash() });
		}
		if (found) break;
		if (bestFin && d >= bestFin.arrive) break;
		if (cur.length === 0) { why = 'exhausted'; break; }
		if (Date.now() > deadline) { why = 'time'; break; }
		// the finish: the front's best states near the goal (every FIN_EVERY layers)
		if (finOn && d % FIN_EVERY === 0) {
			let n = 0;
			for (let q = 0; q < cur.length && n < FIN_K; q++) {
				if (cur[q].est > FIN_EST) break;
				if (finTried.has(cur[q].h)) continue;
				n++;
				finishTry(cur[q], d);
				if (Date.now() > deadline) break;
			}
		}
		if (stop !== null && stop()) { why = 'stopped'; break; }
		// expand: every state by its direction options (a switching event: all of them; else the held one) and, where the
		// tick's move hits the floor, the jump bit
		const kids = [];
		const add = (nd, m, ev) => {
			if (sim.is_dead && !allowDeath) return false;
			if (goal.test(sim)) { found = { depth: d + 1, ref: nd.ref, msk: m }; return true; }
			// DOMINANCE (exact): a state the family reached at an earlier tick is dominated (the same future, later): once
			// (the pit's jump cycles end); and the fine cell (1 px x, 2 px y, 1/8 vx, 1/4 vy, support, jumps): its first
			// arrival (legBFS's cells; an approximation of the phase plane's dominance: a later arrival at the same place and
			// speed)
			const h = sim.stateHash();
			if (seen.has(h)) return false;
			seen.add(h);
			if (cellDom) {
				const ck = cellKey();
				if (cells.has(ck)) return false;
				cells.add(ck);
			}
			const t = tileNow();
			kids.push({ sn: sim.snapshot(), dm: m & 30, last: ev ? d : nd.last, gr: !!sim.on_ground, vs: Math.sign(sim.speed_y), vx: sim.speed_x, est: estOf(t), pref: nd.ref, mk: m, tile: t, h });
			return false;
		};
		for (let i = 0; i < cur.length && !found; i++) {
			const nd = cur[i];
			sim.restore(nd.sn);
			const ds = dirsFor();
			const ev = nd.dm < 0 || d - nd.last >= P || (nd.gr === false && sim.on_ground) || (nd.vs < 0 && sim.speed_y >= 0) ||
				(nd.vx !== 0 && sim.speed_x === 0);
			const multi = sim.max_jumps > 1 || sim.has_levitation;
			const opts = ev ? ds : [nd.dm];
			for (let q = 0; q < opts.length && !found; q++) {
				const m = opts[q];
				sim.restore(nd.sn);
				E.applyMask(inp, m); sim.tick(inp); sims++;
				const jumpOK = sim.on_ground || (multi && ev);
				if (add(nd, m, ev)) break;
				if (!jumpOK) continue;
				sim.restore(nd.sn);
				E.applyMask(inp, m | 1); sim.tick(inp); sims++;
				if (add(nd, m | 1, ev)) break;
			}
		}
		if (found) break;
		// the cut: the time to go, a diversity quota per (tile, support, direction of motion)
		kids.sort((a, b) => a.est - b.est);
		if (o.debugKids && d === o.debugKids) for (const k of kids) { sim.restore(k.sn); console.error(`  kid est ${k.est.toFixed(1)} at (${((sim.px + 8) / 16).toFixed(2)}, ${((sim.py + 8) / 16).toFixed(2)}) v (${sim.speed_x.toFixed(2)}, ${sim.speed_y.toFixed(2)}) gr ${sim.on_ground} m ${k.mk} cost ${RF.costAt(field, sim)}`); }
		const cell = new Map();
		const next = [];
		const wEst = Math.ceil(width * (1 - NOV_SHARE));
		for (const k of kids) {
			if (next.length >= wEst) break;
			if (k.est >= 1e9) continue;
			const vb = Math.max(-4, Math.min(4, Math.round(k.vx / 1.7))) + 4;
			const key = ((k.tile * 9 + vb) * 2 + (k.gr ? 1 : 0)) * 3 + (k.vs + 1);
			const c = cell.get(key) || 0;
			if (c >= quota) continue;
			cell.set(key, c + 1);
			k.keep = true;
			next.push(k);
		}
		// the novelty share: the states in the tiles the family has visited least (the corridor's false nears: a field that
		// is optimistic keeps the whole front in a pit it cannot leave; the front's extent is kept too)
		if (next.length < width) {
			const rest = kids.filter((k) => !k.keep && k.est < 1e9);
			rest.sort((a, b) => (visits[a.tile] - visits[b.tile]) || a.est - b.est);
			const tq = new Map();
			for (const k of rest) {
				if (next.length >= width) break;
				const c = tq.get(k.tile) || 0;
				if (c >= 2) continue;
				tq.set(k.tile, c + 1);
				next.push(k);
			}
		}
		for (const k of next) if (visits[k.tile] < 65535) visits[k.tile]++;
		const lp = new Int32Array(next.length), lm = new Uint8Array(next.length);
		for (let q = 0; q < next.length; q++) { lp[q] = next[q].pref; lm[q] = next[q].mk; next[q].ref = q; }
		layers.push({ par: lp, msk: lm });
		if (next.length && next[0].est < bestEst) bestEst = next[0].est;
		if (o.debug && (d % o.debug) === 0 && next.length) {
			sim.restore(next[0].sn);
			let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
			for (const k of next) { const tx = k.tile % W, ty = (k.tile / W) | 0; x0 = Math.min(x0, tx); x1 = Math.max(x1, tx); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty); }
			console.error(`d ${d} n ${next.length} kids ${kids.length} est ${next[0].est.toFixed(1)} at (${((sim.px + 8) / 16).toFixed(1)}, ${((sim.py + 8) / 16).toFixed(1)}) v (${sim.speed_x.toFixed(2)}, ${sim.speed_y.toFixed(2)}) gr ${sim.on_ground} box x ${x0}-${x1} y ${y0}-${y1}`);
		}
		cur = next;
	}
	// the answer: the family's own arrival, or the finish when it arrives sooner
	if (found && bestFin && bestFin.arrive < found.depth) found = null;
	const res = { ok: !!(found || bestFin), ms: Date.now() - t0ms, layers: layers.length, sims, why: found ? 'found' : bestFin ? 'finish' : why, closest: bestEst, finCalls, finOK };
	if (!res.ok) return res;
	if (found && found.msk < 0) return Object.assign(res, { masks: new Uint8Array(0), start: -1 - found.ref, tick: 0 });
	// the input string: back through the layers to the node, then its tick (found) or the finishing leg
	const pathTo = (ref, dd) => {
		const out = [];
		while (ref >= 0) {
			const Lr = layers[dd - 1];
			out.push(Lr.msk[ref]);
			ref = Lr.par[ref];
			dd--;
		}
		out.reverse();
		return { out, s: -1 - ref };
	};
	const p = found ? pathTo(found.ref, found.depth - 1) : pathTo(bestFin.ref, bestFin.d0);
	const tail = found ? [found.msk] : bestFin.masks;
	const masks = Uint8Array.from(p.out.concat(tail));
	return Object.assign(res, { masks, start: p.s, tick: masks.length, tool: found ? 'profile' : 'profile+' + bestFin.tool });
}

module.exports = { profileLeg, eta, dirsOf };
