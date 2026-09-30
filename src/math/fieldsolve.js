'use strict';
// THE FIELD LEG SOLVER (n4-math, build / fields, 2026-09-30): a leg through a field is SOLVED from the per-axis
// mathematics of src/math/fields.js (docs/ee_math.md section 6.7), not searched:
//   1. the field of the start (the centre tile's physics; the gravity queue's older tiles for the first ticks: the
//      schedule) fixes each axis' role: a GRAVITY axis (air's y, an arrow's own axis: no input in flight; its only
//      control is the jump press on a grounded tick) and INPUT axes (the cross axis of a gravity field; both axes in dots,
//      climbables, liquids, boosts' cross axis, flip 4);
//   2. the gravity axis has ONE trajectory per jump tick j (pinned on its floor until the press, then the jump speed J
//      and the recurrence): its coordinate enters the goal tile's window at a few ticks T, or it LANDS on the goal tile's
//      floor plane 16 c (both signs: the floor under a down-gravity ball, the wall beside an arrow's ball) at one tick;
//   3. at each such (j, T) the input axis must be in the goal tile's window: fields.solveAxis (the exact branch and bound
//      on THEOREM F3's envelope) returns every input pattern with <= k changes that puts it there, the envelope first
//      proving most T infeasible in microseconds; with no gravity both axes are solved and every pair of answers works
//      (THEOREM 3 of section 2: the axes compose);
//   4. candidates in increasing T (the cheapest first) are replayed once by the engine (EESim from the start's snapshot):
//      the first whose replay reaches a goal tile (with the support class asked, the level's collisions, doors, fields on
//      the way) is the leg. A verify miss (a wall, a field boundary, a trigger on the way) tries the next candidate.
//   The lower bound fieldLB = max over axes of minTAxis (THEOREM F3) to the nearest goal tile holds for every input word
//   while the ball stays in the start's field (reported, not used as a proof across fields).
// A fallback family ('family': the per-tick one-change patterns over the 9 direction masks, with and without the jump
// press, prefix-shared) runs only when o.family is set and the math finds nothing.
//
// API
//   solveLeg(L, sim, goal, o) -> {ok, masks, ticks, tool: 'math'|'family'|null, T, lb, tried, ms, why}
//     sim: an EESim at the leg's start (unchanged); goal: {tiles: number[] (centre tiles y * W + x), cls: 'G'|'Z'|'W'|
//     'C'|'B'|'A'|null (the support class at arrival, moves.js's letters), maxT}; o: {k (2), jmax (40), limit (6), family,
//     famMax (the family's horizon)}
//   supportClass(sim) -> the class letter of a state (moves.js clsOf)
const E = require('../eesim.js');
const K = require('../plan/kin.js');
const K1 = require('../plan/kin1d.js');
const F = require('./fields.js');
const AX = require('./axis.js');

const F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
/** the support class of a state (the moves study's letters): D dead, W liquid, C climbable, Z dots, B boost, G on the ground, A air */
function supportClass(s) {
	if (s.is_dead) return 'D';
	const id = s.current_tile, flags = s._flags, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (id === 4 || id === 414) return 'Z';
	if (f & F_BOOST) return 'B';
	if (s.on_ground) return 'G';
	return 'A';
}
function tileOfSim(s) {
	const W = s.width, H = s.height;
	let x = Math.trunc(s.px + 8) >> 4, y = Math.trunc(s.py + 8) >> 4;
	if (x < 0) x = 0; else if (x >= W) x = W - 1;
	if (y < 0) y = 0; else if (y >= H) y = H - 1;
	return y * W + x;
}
const HB = [0, 2, 4], VB = [0, 8, 16];      // input index -> mask bits (x: -, L, R; y: -, U, D)
const DIR9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];

/**
 * the engine check of a candidate: play masks from the start snapshot; return the first tick (1-based) where the state
 * is at a goal tile with the class asked (0: never), with o.extend extra ticks of the last mask (a landing one tick late)
 */
function verify(sim, snap, masks, goalSet, cls, maxT, inp) {
	sim.restore(snap);
	const n = Math.min(masks.length, maxT);
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (sim.is_dead) return 0;
		if (goalSet.has(tileOfSim(sim)) && (!cls || supportClass(sim) === cls)) return t + 1;
	}
	return 0;
}

/** the axis schedule of a leg whose centre stays on the start tile's physics: [1..T] contexts per axis */
function scheduleOf(sim, T) {
	const W = sim.width, H = sim.height;
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	const cur = (cx < 0 || cy < 0 || cx >= W || cy >= H) ? 0 : sim.tiles[cy * W + cx];
	return F.schedule({ cur, q0: sim._q0, q1: sim._q1, flip: sim.flip_gravity, sb: sim.speed_boost, zombie: sim.is_zombie,
		lowGravity: sim.low_gravity, worldGravity: sim.world_gravity_multiplier, jb: sim.jump_boost, slip: 0 }, T);
}

/**
 * solveLeg(L, sim, goal, o): the leg from sim's state to the goal tiles (see the header). Candidates in increasing T,
 * each replayed by the engine; the first success is returned.
 */
function solveLeg(L, sim, goal, o = {}) {
	const t0 = Date.now();
	const kMax = o.k === undefined ? 2 : o.k, jmax = o.jmax === undefined ? 40 : o.jmax, limit = o.limit || 6;
	const deadline = t0 + (o.maxMs || 250);   // the candidate generation's clock (the engine verifies stay exact)
	const maxT = Math.min(goal.maxT || 120, 127);
	const W = L.width;
	const goalSet = new Set(goal.tiles);
	const cls = goal.cls || null;
	const snap = sim.snapshot();
	const vsim = new E.EESim(L), inp = new E.EEInput();
	const res = { ok: false, masks: null, ticks: 0, tool: null, T: 0, lb: 0, tried: 0, solves: 0, ms: 0, why: '' };
	const S = scheduleOf(sim, maxT + 1);
	const c1 = S.ctx[Math.min(3, maxT)];                  // the field itself (past the queue's delay)
	const gAxis = c1.y.J !== 0 || (c1.y.ms[1] === 0 && c1.y.ms[2] === 0 && c1.y.mo !== 0) ? 'y'
		: (c1.x.J !== 0 || (c1.x.ms[1] === 0 && c1.x.ms[2] === 0 && c1.x.mo !== 0) ? 'x' : null);
	const p0 = { x: sim.px, y: sim.py }, v0 = { x: sim.speed_x, y: sim.speed_y };
	const tiles = goal.tiles.map((t) => [t % W, (t / W) | 0]);
	const win = (c) => [16 * c - 8, 16 * c + 8 - 1e-9];
	// the field lower bound: every word, both axes, to the nearest goal tile's window (THEOREM F3, the start's field)
	let lb = Infinity;
	for (const [gx, gy] of tiles) {
		const [xl, xh] = win(gx), [yl, yh] = win(gy);
		const tx = p0.x < xl ? F.minTAxis(p0.x, v0.x, xl, S.x, maxT) : (p0.x > xh ? F.minTAxis(p0.x, v0.x, xh, S.x, maxT) : 0);
		const ty = p0.y < yl ? F.minTAxis(p0.y, v0.y, yl, S.y, maxT) : (p0.y > yh ? F.minTAxis(p0.y, v0.y, yh, S.y, maxT) : 0);
		lb = Math.min(lb, Math.max(tx, ty));
	}
	res.lb = lb;
	const cands = [];   // {T, masks}
	const seen = new Set();
	const push = (T, masks) => {
		const key = K1.f64hex(T) + String.fromCharCode(...masks);
		if (seen.has(key)) return;
		seen.add(key);
		cands.push({ T, masks });
	};
	const failed = [];   // the candidates the engine refused (their real field schedules drive the iteration below)
	const tryCands = (tool = 'math') => {
		cands.sort((a, b) => a.T - b.T);
		for (const c of cands) {
			res.tried++;
			const at = verify(vsim, snap, c.masks, goalSet, cls, maxT, inp);
			if (at > 0) {
				res.ok = true; res.masks = c.masks.slice(0, at); res.ticks = at; res.T = c.T; res.tool = tool;
				return true;
			}
			if (failed.length < 64) failed.push(c);
		}
		cands.length = 0;
		return false;
	};
	/**
	 * both axes solved on a (time-varying) schedule and paired: an axis whose inputs do nothing at some ticks (a gravity
	 * axis in the air) simply has one trajectory there; a support G's gravity coordinate is asked in [plane - 8,
	 * plane + 16] at T (the landing tick's free step), the engine decides
	 */
	const solveBoth = (Sx, Sy, Tfrom) => {
		for (let T = Math.max(1, Tfrom); T <= maxT && cands.length < 400 && Date.now() < deadline; T++) {
			for (const [gx, gy] of tiles) {
				let [xl, xh] = win(gx), [yl, yh] = win(gy);
				const Ax = At(Sx, T), Ay = At(Sy, T);
				if (cls === 'G') {
					if (Ay.mo > 0 && Ay.ms[1] === 0 && Ay.ms[2] === 0) { yl = 16 * gy - 8; yh = 16 * gy + 16; }
					else if (Ay.mo < 0 && Ay.ms[1] === 0 && Ay.ms[2] === 0) { yl = 16 * gy - 16; yh = 16 * gy + 8; }
					if (Ax.mo > 0 && Ax.ms[1] === 0 && Ax.ms[2] === 0) { xl = 16 * gx - 8; xh = 16 * gx + 16; }
					else if (Ax.mo < 0 && Ax.ms[1] === 0 && Ax.ms[2] === 0) { xl = 16 * gx - 16; xh = 16 * gx + 8; }
				}
				const ex = F.envelope(p0.x, v0.x, T, Sx), ey = F.envelope(p0.y, v0.y, T, Sy);
				const sx = ex.armable[T] ? F.ALIGN_SLACK : 0, sy = ey.armable[T] ? F.ALIGN_SLACK : 0;
				if (ex.phi[T] + sx < xl || ex.plo[T] - sx > xh || ey.phi[T] + sy < yl || ey.plo[T] - sy > yh) continue;
				const xs = F.solveAxis(p0.x, v0.x, T, xl, xh, Sx, { k: kMax, limit: 4, maxNodes: 20000 });
				res.solves++;
				if (!xs.length) continue;
				const ys = F.solveAxis(p0.y, v0.y, T, yl, yh, Sy, { k: kMax, limit: 4, maxNodes: 20000 });
				res.solves++;
				for (const a of xs) for (const b of ys) {
					const masks = new Uint8Array(Math.min(maxT, T + 3));
					for (let t = 1; t <= masks.length; t++) {
						const tt = Math.min(t, T);
						masks[t - 1] = HB[K1.inputAt(a.code, tt)] | VB[K1.inputAt(b.code, tt)];
					}
					push(T, masks);
				}
			}
		}
	};
	/**
	 * THE SCHEDULE ITERATION (a leg across field boundaries): a refused candidate's real path (pathEval: the centre's tiles,
	 * the gravity queue, exact) gives the field schedule a path of that shape meets; both axes are solved again on it
	 * (time-varying contexts), up to `rounds` times, each schedule once
	 */
	const ctxCache = new Map();
	/** the contexts the ENGINE used on a candidate's replay (the centre tile, the queue's delayed tile, the ice timer, the effects), per tick */
	const engineSchedule = (masks) => {
		vsim.restore(snap);
		const Sx = [null], Sy = [null], keys = [];
		for (let t = 0; t < masks.length; t++) {
			const q0 = vsim._q0, q1 = vsim._q1;
			E.applyMask(inp, masks[t]);
			vsim.tick(inp);
			const cur = vsim.current_tile, del = K.isImmediate(cur) ? q1 : q0;
			const o = { cur, del, flip: vsim.flip_gravity, sb: vsim.speed_boost, zombie: vsim.is_zombie, lowGravity: vsim.low_gravity,
				worldGravity: vsim.world_gravity_multiplier, jb: vsim.jump_boost, slip: vsim._slippery };
			const key = `${cur},${del},${o.flip},${o.sb},${o.zombie ? 1 : 0},${o.lowGravity ? 1 : 0},${o.jb},${o.slip}`;
			let c = ctxCache.get(key);
			if (!c) { c = F.fieldCtx(o); ctxCache.set(key, c); }
			Sx.push(c.x); Sy.push(c.y); keys.push(key);
			if (vsim.is_dead) break;
		}
		while (Sx.length <= maxT + 1) { Sx.push(Sx[Sx.length - 1]); Sy.push(Sy[Sy.length - 1]); }
		return { x: Sx, y: Sy, key: keys.join('|') };
	};
	const iterate = (rounds) => {
		const doneSch = new Set();
		for (let r = 0; r < rounds && !res.ok; r++) {
			const pool = failed.splice(0, failed.length).slice(0, 12);
			if (!pool.length) break;
			for (const c of pool) {
				const S2 = engineSchedule(c.masks);
				if (doneSch.has(S2.key)) continue;
				doneSch.add(S2.key);
				const k3 = Math.min(3, S2.x.length - 1);
				const cx = { x: S2.x[k3], y: S2.y[k3] };
				const g2 = cx.y.J !== 0 || (cx.y.ms[1] === 0 && cx.y.ms[2] === 0 && cx.y.mo !== 0) ? 'y'
					: (cx.x.J !== 0 || (cx.x.ms[1] === 0 && cx.x.ms[2] === 0 && cx.x.mo !== 0) ? 'x' : null);
				generate(S2, cx, g2, false);
				if (tryCands('iter')) return true;
			}
		}
		return false;
	};
	const generate = (S, c1, gAxis, first) => {
	if (gAxis !== null) {
		// ---- a gravity field: the gravity axis' trajectories (one per jump tick), the input axis solved in the window
		const iAxis = gAxis === 'y' ? 'x' : 'y';
		const G = S[gAxis], I = S[iAxis];
		const gSign = Math.sign(c1[gAxis].mo);
		const grounded = sim.on_ground && v0[gAxis] === 0;
		// the floor under the box (the tiles on the pull's side): the box overlaps it iff the input coordinate q is in
		// (span[0], span[1]) (the contiguous solid tiles under the box, both ways)
		let span = null;
		if (grounded) {
			const Wd = sim.width, Ht = sim.height, flags = L.flags;
			const solidAt = (x, y) => x >= 0 && y >= 0 && x < Wd && y < Ht && (flags[sim.tiles[y * Wd + x]] & 1) !== 0;
			const q = p0[iAxis], g = p0[gAxis];
			const line = gSign > 0 ? ((Math.trunc(g) + 16) >> 4) : ((Math.trunc(g) >> 4) - 1);
			const at = (i) => (gAxis === 'y' ? solidAt(i, line) : solidAt(line, i));
			const s0 = Math.trunc(q) >> 4, s1 = Math.trunc(q + 15.999) >> 4;
			let seed = -1;
			for (let c = s0; c <= s1; c++) if (at(c)) { seed = c; break; }
			if (seed >= 0) {
				let a = seed, e = seed + 1;
				while (a - 1 >= 0 && at(a - 1) && seed - a < 400) a--;
				while (at(e) && e - seed < 400) e++;
				span = [16 * a - 16, 16 * e];
			}
		}
		const onFloor = (q) => span === null || (q > span[0] && q < span[1]);
		// the gravity axis' options: fly on (an airborne start), walk (pinned), jump at tick j (pinned until the press),
		// walk off an edge at T0 (pinned until T0 - 1, then free from rest); each with the input axis' tube (the box on the
		// floor while pinned, off its edge at T0)
		const opts = [];
		if (!grounded) opts.push({ kind: 'fly', pinned: 0, jump: 0, tube: null });
		else {
			opts.push({ kind: 'walk', pinned: maxT, jump: 0, tube: (t, q) => onFloor(q) });
			if (c1[gAxis].J !== 0) for (let j = 1; j <= Math.min(jmax, maxT - 1); j++) opts.push({ kind: 'jump', pinned: j, jump: j, tube: (t, q) => t > j || onFloor(q) });
			if (span !== null) {
				const tR = F.minTAxis(p0[iAxis], v0[iAxis], span[1], I, maxT), tL = F.minTAxis(p0[iAxis], v0[iAxis], span[0], I, maxT);
				for (let T0 = Math.max(1, tR); T0 <= maxT; T0++) opts.push({ kind: 'offR', pinned: T0 - 1, jump: 0, tube: (t, q) => (t < T0 ? onFloor(q) : (t === T0 ? q >= span[1] : true)) });
				for (let T0 = Math.max(1, tL); T0 <= maxT; T0++) opts.push({ kind: 'offL', pinned: T0 - 1, jump: 0, tube: (t, q) => (t < T0 ? onFloor(q) : (t === T0 ? q <= span[0] : true)) });
			}
		}
		// the ceiling over the start's box (against the pull): the gravity axis' 1D obstacle there (a bonk: the sub-step
		// move blocked, the speed 0: axis.js moveAxis, the engine's own sub-steps); one-ways let the ball through
		const Wd = sim.width, Ht = sim.height, flg = L.flags;
		const q0 = p0[iAxis], qc0 = Math.trunc(q0) >> 4, qc1 = Math.trunc(q0 + 15.999) >> 4;
		const blockedAgainst = (p) => {
			const a = Math.trunc(p) >> 4, b = (Math.trunc(p + 16.0) - (Number.isInteger(p + 16.0) ? 1 : 0)) >> 4;
			for (let g = a; g <= b; g++) for (let c = qc0; c <= qc1; c++) {
				const x = gAxis === 'y' ? c : g, y = gAxis === 'y' ? g : c;
				if (x < 0 || y < 0 || x >= Wd || y >= Ht) return true;
				const f = flg[sim.tiles[y * Wd + x]];
				if ((f & 1) !== 0 && (f & 2) === 0) return true;
			}
			return false;
		};
		const nOpts = opts.length;
		// per goal tile: the earliest tick any gravity option lands on its plane (G) / enters its window
		const gFirst = tiles.map(() => Infinity), gWin = tiles.map(() => Infinity);
		let cutG = false;
		for (let oi = 0; oi < opts.length; oi++) {
			if (Date.now() >= deadline) { cutG = true; break; }
			const op = opts[oi];
			const gp = new Float64Array(maxT + 1), gv = new Float64Array(maxT + 1);
			gp[0] = p0[gAxis]; gv[0] = v0[gAxis];
			let p = p0[gAxis], v = grounded ? 0 : v0[gAxis], bonked = false;
			for (let t = 1; t <= maxT; t++) {
				const A = At(G, t);
				if (t <= op.pinned) { v = (t === op.jump) ? A.J : 0; }
				else {
					v = F.vStep(v, 0, A);
					if (!op.noCeil && v !== 0 && Math.sign(v) === -gSign) {
						const mv = AX.moveAxis(p, v, A.boost !== 0, blockedAgainst);
						p = mv.p; if (mv.hit) { v = 0; bonked = true; }
						p = K.align(p, v, A.mods[0], A.liquid);
					} else p = F.pStep(p, v, 0, A);
				}
				gp[t] = p; gv[t] = v;
			}
			// a bonk against the start's ceiling is only one reading: the ball may have left the start's columns first
			if (bonked && oi < nOpts) opts.push(Object.assign({}, op, { noCeil: true }));
			// the ticks where the gravity coordinate suits a goal tile: inside its window, or its landing on the tile's plane
			for (let ti = 0; ti < tiles.length; ti++) {
				const [gx, gy] = tiles[ti];
				const gc = gAxis === 'y' ? gy : gx, ic = gAxis === 'y' ? gx : gy;
				const [gl, gh] = win(gc), [il, ih] = win(ic);
				const plane = 16 * gc;
				for (let T = 1; T <= maxT; T++) {
					// in the goal tile's window, or (a support G) a landing on its floor plane: the free step of tick T passes
					// the plane toward the pull (the engine stops the box on it), or the walk on that floor
					const inWin = gp[T] >= gl && gp[T] <= gh;
					let land = false;
					if (cls === 'G') land = op.kind === 'walk' ? gp[T] === plane : (T > op.pinned && (gSign > 0 ? (gp[T - 1] <= plane && gp[T] > plane) : (gp[T - 1] >= plane && gp[T] < plane)));
					if (!inWin && !land) continue;
					if (land && T < gFirst[ti]) gFirst[ti] = T;
					if (inWin && T < gWin[ti]) gWin[ti] = T;
					if (op.kind === 'walk' && cls === 'G' && !land) continue;
					const sols = F.solveAxis(p0[iAxis], v0[iAxis], T, il, ih, I, { k: kMax, limit, maxNodes: 20000, tube: op.tube });
					res.solves++;
					for (const s of sols) {
						const masks = new Uint8Array(Math.min(maxT, T + 3));
						for (let t = 1; t <= masks.length; t++) {
							const mi = t <= T ? K1.inputAt(s.code, t) : K1.inputAt(s.code, T);
							masks[t - 1] = (iAxis === 'x' ? HB[mi] : VB[mi]) | (t === op.jump ? 1 : 0);
						}
						push(T, masks);
					}
				}
			}
		}
		// the leg's field bound: per goal tile the later of the input axis' envelope time (THEOREM F3) and the earliest
		// gravity option's window tick (every jump tick, walk-off and ceiling reading: the gravity axis has no other input)
		let lbG = Infinity;
		for (let ti = 0; ti < tiles.length; ti++) {
			const ic = gAxis === 'y' ? tiles[ti][0] : tiles[ti][1];
			const [il, ih] = win(ic);
			const q = p0[iAxis], w = v0[iAxis];
			const tI = q < il ? F.minTAxis(q, w, il, I, maxT) : (q > ih ? F.minTAxis(q, w, ih, I, maxT) : 0);
			// a support G is grounded: on a full-tile floor the box rests on the goal row's plane, reached no sooner than
			// the first landing tick (a half-block floor rests elsewhere: the window tick then, the weaker bound)
			const g = cls === 'G' ? (gFirst[ti] < Infinity ? gFirst[ti] : gWin[ti]) : gWin[ti];
			lbG = Math.min(lbG, Math.max(tI, g));
		}
		if (first) res.lb = cutG ? null : lbG;   // a generation the clock cut proves no bound
	} else {
		// ---- no gravity (dots, climbables, liquids, boosts' cross axis, flip 4): both axes solved, every pair composes
		solveBoth(S.x, S.y, first && lb !== Infinity ? lb : 1);
	}
	};
	generate(S, c1, gAxis, true);
	if (tryCands()) { res.ms = Date.now() - t0; return res; }
	// ---- across field boundaries: the refused candidates' real schedules, both axes solved again on them
	if (o.iterate !== false && iterate(o.rounds || 2)) { res.ms = Date.now() - t0; return res; }
	// ---- the fallback family (o.family): per-tick one-change patterns over the 9 direction masks, jump press or not
	if (o.family) {
		const horizon = Math.min(maxT, o.famMax || maxT);
		const grounded = sim.on_ground;
		let best = null;
		for (const jp of grounded ? [1, 0] : [0]) {
			for (const d0 of DIR9) {
				// the prefix d0 (with the press on tick 1), a snapshot after every tick
				sim.restore(snap);
				const snaps = [];
				let hit = 0;
				for (let t = 1; t <= horizon; t++) {
					E.applyMask(inp, d0 | (t === 1 ? jp : 0));
					sim.tick(inp);
					res.tried++;
					if (sim.is_dead) break;
					if (goalSet.has(tileOfSim(sim)) && (!cls || supportClass(sim) === cls)) { hit = t; break; }
					snaps.push(sim.snapshot());
				}
				if (hit && (!best || hit < best.t)) { best = { t: hit, masks: Uint8Array.from({ length: hit }, (_, i) => d0 | (i === 0 ? jp : 0)) }; }
				for (let c = 1; c < snaps.length; c++) {
					if (best && c >= best.t) break;
					for (const d1 of DIR9) {
						if (d1 === d0) continue;
						sim.restore(snaps[c - 1]);
						for (let t = c + 1; t <= (best ? best.t - 1 : horizon); t++) {
							E.applyMask(inp, d1);
							sim.tick(inp);
							res.tried++;
							if (sim.is_dead) break;
							if (goalSet.has(tileOfSim(sim)) && (!cls || supportClass(sim) === cls)) {
								const m = new Uint8Array(t);
								for (let i = 0; i < t; i++) m[i] = (i < c ? d0 : d1) | (i === 0 ? jp : 0);
								best = { t, masks: m };
								break;
							}
						}
					}
				}
			}
		}
		if (best) { res.ok = true; res.masks = best.masks; res.ticks = best.t; res.tool = 'family'; res.T = best.t; }
		else res.why = 'none';
	} else res.why = 'none';
	sim.restore(snap);
	res.ms = Date.now() - t0;
	return res;
}
function At(As, t) { return F.At(As, t); }

module.exports = { solveLeg, supportClass, tileOfSim, verify, scheduleOf };
