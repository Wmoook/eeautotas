'use strict';
// FIELD KINEMATICS (n4-math, build / fields, 2026-09-30): every EE field as mathematics the compiler evaluates.
//
// THE ONE FACT (docs/ee_math.md section 6): in any field the tick is, per axis, the SAME scalar recurrence of kin.js
// (stepV + the move + the align), and a field only chooses its coefficients. A field context E = (the current tile,
// the delayed tile, flipGravity, the effects) fixes per axis an AXIS CONTEXT
//     A = { ms[3]  the input term m of each input index (0 '-', 1 neg = L / U, 2 pos = R / D), after x sm
//           mods[3] the modifier (mo + m) / 7.752 of each input (the engine's own double)
//           mo, moO this axis' pull and the other axis' pull (x gm): moO != 0 turns the release drag into B x N
//           cur, slip the current tile (climbable / liquid drags) and the ice timer
//           boost  0, or the +-16 a boost tile writes after the drag
//           mor, J the current tile's int pull and the jump speed (J = 0: no jump on this axis) }
// and one tick of the axis with input i is exactly (Theorem F1, checked against eesim.js in every field):
//     v' = boost || stepV(v, mods[i], ms[i], moO, slip, cur);  p' = align(p (+) v', v', mods[i], liquid(cur))
// (p (+) v' is the sub-stepped move, one rounded add: T-ADD, section 1.5). The recurrence classes this gives:
//     GRAV   ms = 0, mo = +-2 gm:  v' = (v + a) B                            (air's y, an arrow's own axis)
//     INPUT  mo = 0, moO != 0:     hold along (v + k) B, release / against (v + k) B N   (air's x, an arrow's cross axis)
//     FREE   mo = 0, moO = 0:      hold along and release (v + k) B, against (v + k) B N  (dots, flip 4, boosts' cross)
//     CLIMB  climbable current:    (v + k) B N always (both axes, no pull)
//     LIQUID liquid current:       (v + a + k) B D_liquid, the release of x (moO = buoyancy != 0) B N
//     BOOST  boost current:        v' = +-16 on its axis whatever the input; the other axis FREE
//     ICE    slip > 0:             along B, release Ino, against Ino I (the floor's axis while the timer runs)
// THEOREM F2 (the dihedral symmetry): stepV(-v, -mod, -m, -moO) = -stepV(v, mod, m, moO) (round to nearest is odd), so a
// left / right / up arrow field is the plain field rotated or reflected: its speeds are the plain tables' speeds with the
// signs and axes changed, bit for bit (the tables of src/plan/kin1d.js serve every arrow field).
// THEOREM F3 (the envelope, sound in every field, the key-order exceptions included): with lo_{t+1} = min_i V(lo_t, i),
// hi_{t+1} = max_i V(hi_t, i) (V monotone in v for every fixed input: section 1.4) every input word's speed lies in
// [lo_t, hi_t] and its position in [plo_t - s, phi_t + s] (p (+) v monotone in both; s = ALIGN_SLACK where an armed tick
// is possible). Where the key order holds (all but mud, lava and fast ice) hi = hold toward: minT is exact.
//
// API
//   CLASSES, REP (a tile id per class), classOfId(id)
//   fieldCtx({cur, del, flip, sb, zombie, lowGravity, worldGravity, jb, slip}) -> {x: A, y: A, ...}   (tick()'s own maths)
//   ctxOfSim(sim) / ctxOfState(st, del) : the context of the next tick of a real state
//   vStep(v, i, A), pStep(p, v, i, A), step(p, v, i, A) -> [p', v']   one axis tick
//   evalAxis(p0, v0, code, t, As, trace)       a kin1d pattern code (<= 3 changes) on an axis schedule As (A or A[] per tick)
//   holdAxis(p0, v0, i, t, As)                  one input held
//   envelope(p0, v0, T, As)                     THEOREM F3: {vlo, vhi, plo, phi, armable}
//   minTAxis(p0, v0, X, As, tmax, safe)         the least t whose envelope reaches X (admissible; exact where hold attains it)
//   fixedPoint(A, i, v0)                        {v, tick} the double the held input converges to, and when
//   kindOf(A), describe(A)                      the recurrence class and its constants
//   solveAxis(p0, v0, T, lo, hi, As, o)         every pattern (<= o.k changes) whose exact p_T is in [lo, hi] (branch and
//                                               bound on THEOREM F3; LEMMA L's binary search where the class is monotone)
//   schedule(ctx0, T, queue)                    the per-tick contexts of a path that stays in one field's tiles (the queue)
const K = require('../plan/kin.js');
const K1 = require('../plan/kin1d.js');

const MULT = K.MULT;
const MS = [0, -1, 1];                 // input index -> the key's sign: 0 none, 1 L / U, 2 R / D
const ALIGN_SLACK = 2;                 // the most the auto-align moves a pattern's position toward a grid line (kin1d)
const CLASSES = ['air', 'arrowL', 'arrowU', 'arrowR', 'arrowD', 'dot', 'climb', 'water', 'mud', 'lava', 'toxic', 'boostL', 'boostR', 'boostU', 'boostD'];
const REP = { air: 0, arrowL: 1, arrowU: 2, arrowR: 3, arrowD: 1518, dot: 4, climb: 120, water: 119, mud: 369, lava: 416, toxic: 1585, boostL: 114, boostR: 115, boostU: 116, boostD: 117 };
/** the field class of a tile id (the classes above; 'other' for solids, portals, effects, killers, coins...) */
function classOfId(id) {
	switch (id) {
		case 0: return 'air';
		case 1: case 411: return 'arrowL';
		case 2: case 412: return 'arrowU';
		case 3: case 413: return 'arrowR';
		case 1518: case 1519: return 'arrowD';
		case 4: case 414: return 'dot';
		case 119: return 'water';
		case 369: return 'mud';
		case 416: return 'lava';
		case 1585: return 'toxic';
		case 114: return 'boostL';
		case 115: return 'boostR';
		case 116: return 'boostU';
		case 117: return 'boostD';
	}
	if (K.isClimb(id)) return 'climb';
	return 'other';
}
/** the physics of a tile as the per-axis maps see it: tiles of one key act identically on the ball (not its collisions) */
function physKey(id) {
	const c = classOfId(id);
	if (c !== 'other') return c;
	const t = K.gravTables(), fl = K.flagsOf(id);
	// a plain pull (the default case of Player.as's switch): air-like, a killer or not
	return (t.flags[id] & 4) ? 'kill' : ((fl & K.F.SOLID) ? 'solidish' : 'airlike');
}

// ---------------------------------------------------------------- the contexts
const _m = { morx: 0, mory: 0, mox: 0, moy: 0, kill: false }, _a = { mx: 0, my: 0 };
/**
 * fieldCtx(o): the per-axis contexts of one tick, with Player.tick's own arithmetic (kin.tick's order): o {cur, del
 * (default cur), flip, sb, zombie, lowGravity, worldGravity (1), jb, slip (the ice timer AFTER this tick's update: 0 =
 * none), god (false)}. Returns {cur, del, flip, sm, gm, jm, morx, mory, mox, moy, kill, x: A, y: A}.
 */
function fieldCtx(o) {
	const cur = o.cur | 0, del = o.del === undefined ? cur : (o.del | 0), flip = o.flip | 0, god = !!o.god;
	const M = K.forces(cur, del, flip, god, _m);
	const morx = M.morx, mory = M.mory, rawMox = M.mox, rawMoy = M.moy, kill = M.kill;
	const sm = K.speedMult(o.sb | 0, !!o.zombie, god);
	const gm = K.gravMult(!!o.lowGravity, o.worldGravity === undefined ? 1.0 : o.worldGravity);
	const mox = rawMox * gm, moy = rawMoy * gm;
	const slip = o.slip === undefined ? 0.0 : o.slip;
	const jm = K.jumpMult(o.jb | 0, !!o.zombie, god, slip);
	const liquid = K.isLiquid(cur) && !god;
	const mk = (isX) => {
		const ms = new Float64Array(3), mods = new Float64Array(3);
		for (let i = 0; i < 3; i++) {
			// the axis choice reads the delayed tile and the UNSCALED pulls (tick(): before mo *= gm)
			if (K.isLiquid(del)) { _a.mx = isX ? MS[i] : 0; _a.my = isX ? 0 : MS[i]; }
			else if (rawMoy !== 0.0) { _a.mx = isX ? MS[i] : 0; _a.my = 0.0; }
			else if (rawMox !== 0.0) { _a.mx = 0.0; _a.my = isX ? 0 : MS[i]; }
			else { _a.mx = isX ? MS[i] : 0; _a.my = isX ? 0 : MS[i]; }
			const m = (isX ? _a.mx : _a.my) * sm;
			ms[i] = m;
			mods[i] = ((isX ? mox : moy) + m) / MULT;
		}
		let boost = 0;
		if (!god) {
			if (isX) { if (cur === 114) boost = -16.0; else if (cur === 115) boost = 16.0; }
			else { if (cur === 116) boost = -16.0; else if (cur === 117) boost = 16.0; }
		}
		const mo = isX ? mox : moy, moO = isX ? moy : mox, mor = isX ? morx : mory;
		const J = (mor !== 0 && mo !== 0.0) ? K.jumpSpeed(mor, jm) : 0;
		return { isX, ms, mods, mo, moO, cur, slip, boost, mor, J, liquid, god };
	};
	return { cur, del, flip, sm, gm, jm, morx, mory, mox, moy, kill, x: mk(true), y: mk(false) };
}
/** the context of the NEXT tick of a real EESim state that stays in its current tile (del from its gravity queue) */
function ctxOfSim(sim, o = {}) {
	const cur = o.cur === undefined ? sim.current_tile : o.cur;
	const del = o.del === undefined ? (K.isImmediate(cur) ? sim._q1 : sim._q0) : o.del;
	return fieldCtx({ cur, del, flip: sim.flip_gravity, sb: sim.speed_boost, zombie: sim.is_zombie, lowGravity: sim.low_gravity,
		worldGravity: sim.world_gravity_multiplier, jb: sim.jump_boost, slip: o.slip === undefined ? 0 : o.slip });
}
/**
 * schedule(o, T): the per-tick contexts [1..T] of a path whose centre stays on tiles of `o.cur`'s physics for T ticks,
 * the gravity queue starting at (o.q0, o.q1) (the state's _q0, _q1): the first ticks read the queue's older tiles (the
 * 2-tick delay, 1 in dots / climbables), then the field itself (docs/ee_math.md 6.4). Returns {x: A[], y: A[], ctx: []}
 * (index t = the context of tick t, t >= 1; index 0 unused).
 */
function schedule(o, T) {
	const xs = [null], ys = [null], cs = [null];
	let q0 = o.q0 === undefined ? o.cur : o.q0, q1 = o.q1 === undefined ? o.cur : o.q1;
	const cache = new Map();
	for (let t = 1; t <= T; t++) {
		const c = o.cur;
		let d = q0;
		q0 = q1; q1 = c;
		if (K.isImmediate(c)) { d = q0; q0 = q1; q1 = c; }
		const key = d;
		let ctx = cache.get(key);
		if (!ctx) { ctx = fieldCtx(Object.assign({}, o, { cur: c, del: d })); cache.set(key, ctx); }
		xs.push(ctx.x); ys.push(ctx.y); cs.push(ctx);
	}
	return { x: xs, y: ys, ctx: cs };
}

// ---------------------------------------------------------------- one axis
/** one axis' speed after a tick with input index i (THEOREM F1: stepV, then the boost's override) */
function vStep(v, i, A) {
	let s = K.stepV(v, A.mods[i], A.ms[i], A.moO, A.slip, A.cur, A.god);
	if (A.boost !== 0) s = A.boost;
	return s;
}
/** the move (one rounded add for p >= 16: T-ADD; the sub-step loop below 16) and the auto-align */
function pStep(p, v, i, A) {
	const q = (p >= 16.0 && p + v >= 16.0) ? p + v : K.moveFree(p, v, A.boost !== 0);
	return K.align(q, v, A.mods[i], A.liquid);
}
function step(p, v, i, A) { v = vStep(v, i, A); return [pStep(p, v, i, A), v]; }
/** the axis context of tick t of a schedule (an A: the same every tick; an array: A[t], the last one after its end) */
function At(As, t) { return Array.isArray(As) ? As[t < As.length ? t : As.length - 1] : As; }
/** whether the align can fire on this axis with input i at speed v: |v| < 1, |modifier| < 0.1, not a liquid */
function armed(v, i, A) { return !(v >= 1 || v <= -1) && !A.liquid && A.mods[i] < 0.1 && A.mods[i] > -0.1; }

/** a kin1d pattern code (runs of one input) played on an axis for t ticks from (p0, v0): {p, v, armed} (trace: arrays) */
function evalAxis(p0, v0, code, t, As, trace) {
	let p = p0, v = v0, arm = false, j = 0;
	for (const [mi, n] of K1.decode(code, t)) {
		for (let q = 0; q < n; q++) {
			j++;
			const A = At(As, j);
			v = vStep(v, mi, A);
			if (armed(v, mi, A)) arm = true;
			p = pStep(p, v, mi, A);
			if (trace) { trace.p[j] = p; trace.v[j] = v; }
		}
	}
	return { p, v, armed: arm };
}
/** input i held for t ticks: [p, v] */
function holdAxis(p0, v0, i, t, As, from = 0) {
	let p = p0, v = v0;
	for (let j = from + 1; j <= from + t; j++) { const A = At(As, j); v = vStep(v, i, A); p = pStep(p, v, i, A); }
	return [p, v];
}

/**
 * THEOREM F3, the envelope of every input word on an axis schedule from (p0, v0) at tick `from`: speeds [vlo, vhi] by the
 * min / max over the inputs of the monotone speed maps, positions [plo, phi] (the rounded add is monotone in both), and
 * `armable[t]` (some word may be armed at tick t: |v| < 1 possible and some input with |modifier| < 0.1). Sound: an
 * outer bound of the reachable set (for every class, mud / lava / ice included); exact (attained) where the class's key
 * order holds (hold toward = the extreme).
 */
function envelope(p0, v0, T, As, from = 0) {
	const vlo = new Float64Array(T + 1), vhi = new Float64Array(T + 1), plo = new Float64Array(T + 1), phi = new Float64Array(T + 1);
	const armable = new Uint8Array(T + 1);
	vlo[0] = vhi[0] = v0; plo[0] = phi[0] = p0;
	let arm = 0;
	for (let t = 1; t <= T; t++) {
		const A = At(As, from + t);
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < 3; i++) {
			const a = vStep(vlo[t - 1], i, A), b = vStep(vhi[t - 1], i, A);
			if (a < lo) lo = a; if (b < lo) lo = b; if (a > hi) hi = a; if (b > hi) hi = b;
		}
		vlo[t] = lo; vhi[t] = hi;
		const ql = (plo[t - 1] >= 16.0 && plo[t - 1] + lo >= 16.0) ? plo[t - 1] + lo : K.moveFree(plo[t - 1], lo, A.boost !== 0);
		const qh = (phi[t - 1] >= 16.0 && phi[t - 1] + hi >= 16.0) ? phi[t - 1] + hi : K.moveFree(phi[t - 1], hi, A.boost !== 0);
		plo[t] = ql; phi[t] = qh;
		if (!arm && !A.liquid && lo < 1 && hi > -1) for (let i = 0; i < 3; i++) if (A.mods[i] < 0.1 && A.mods[i] > -0.1) { arm = 1; break; }
		armable[t] = arm;
	}
	return { vlo, vhi, plo, phi, armable };
}
/**
 * the fewest ticks for ANY input word on the axis schedule to bring the position from p0 to X (the envelope's side
 * toward X reaches it; safe: minus ALIGN_SLACK where an armed tick is possible): an admissible lower bound; exact where
 * hold toward attains the envelope. Infinity when not within tmax.
 */
function minTAxis(p0, v0, X, As, tmax = 1000, safe = true, from = 0) {
	if (X === p0) return 0;
	const up = X > p0;
	let lo = v0, hi = v0, pl = p0, ph = p0, arm = false;
	for (let t = 1; t <= tmax; t++) {
		const A = At(As, from + t);
		let a = Infinity, b = -Infinity;
		for (let i = 0; i < 3; i++) {
			const u = vStep(lo, i, A), w = vStep(hi, i, A);
			if (u < a) a = u; if (w < a) a = w; if (u > b) b = u; if (w > b) b = w;
		}
		lo = a; hi = b;
		pl = pl + lo; ph = ph + hi;
		if (!arm && safe && !A.liquid && lo < 1 && hi > -1) for (let i = 0; i < 3; i++) if (A.mods[i] < 0.1 && A.mods[i] > -0.1) { arm = true; break; }
		const s = arm ? ALIGN_SLACK : 0;
		if (up ? ph + s >= X : pl - s <= X) return t;
	}
	return Infinity;
}

/** the fixed point input i converges to from v0 (exact: the first tick v stops changing; a 2-cycle is reported) */
function fixedPoint(A, i, v0 = 0, tmax = 100000) {
	let v = v0;
	for (let t = 1; t <= tmax; t++) {
		const w = vStep(v, i, A);
		if (w === v) return { v, tick: t - 1 };
		v = w;
	}
	return { v, tick: -1 };
}
const DRAG_NAMES = new Map([[K.BASE_DRAG, 'B'], [K.NO_MOD_DRAG, 'N'], [K.WATER_DRAG, 'W'], [K.MUD_DRAG, 'U'], [K.LAVA_DRAG, 'L'], [K.ICE_NO_MOD_DRAG, 'Ino'], [K.ICE_DRAG, 'I']]);
/** the recurrence class of an axis context (docs/ee_math.md 6.1) */
function kindOf(A) {
	if (A.boost !== 0) return 'BOOST';
	if (K.isClimb(A.cur)) return 'CLIMB';
	if (A.liquid) return 'LIQUID';
	if (A.slip > 0) return 'ICE';
	const driven = A.ms[1] !== 0 || A.ms[2] !== 0;
	if (!driven) return A.mo !== 0 ? 'GRAV' : 'STILL';
	if (A.mo !== 0) return 'INPUT+PULL';
	return A.moO !== 0 ? 'INPUT' : 'FREE';
}
/**
 * the drag factors each input applies (as the product the engine rounds twice: e.g. 'B*N'), probed at a positive and a
 * negative speed: {release, along, against} for the + direction
 */
function describe(A) {
	const probe = (v, i) => {
		// recover the factor: s = v + mod, then s * f1 (* f2): try the known products
		const s = v + A.mods[i];
		const out = vStep(v, i, A);
		if (A.boost !== 0) return 'boost';
		for (const [f1, n1] of DRAG_NAMES) {
			if (s * f1 === out) return n1;
			for (const [f2, n2] of DRAG_NAMES) if ((s * f1) * f2 === out) return n1 + '*' + n2;
		}
		return '?';
	};
	return { kind: kindOf(A), mods: [...A.mods], mo: A.mo, moO: A.moO, J: A.J, boost: A.boost,
		release: probe(3.0, 0), along: probe(3.0, 2), against: probe(3.0, 1) };
}

// ---------------------------------------------------------------- THE SOLVER of one axis (generalized kin1d.solveIA)
/**
 * solveAxis(p0, v0, T, lo, hi, As, o): every input pattern with <= o.k changes (default 1; runs of '-', neg, pos; kin1d's
 * 29-bit codes) whose EXACT position after T ticks on the axis schedule As lies in [lo, hi] (and speed in [o.vlo, o.vhi];
 * o.tube(t, p) false cuts a pattern whose p at tick t is outside the level's free span), fewest changes first. Branch and
 * bound on THEOREM F3 (the envelope from each node's exact state; ALIGN_SLACK where armable), so it is sound and complete
 * on its family for every field class; the last change is binary-searched (LEMMA L) where both inputs are held keys of an
 * ordered class, else scanned. o.limit (64) caps the answers, o.maxNodes the work. o.inputs restricts the inputs
 * (e.g. [0] for a gravity axis). Result [{code, k, p, v, str}] (+ .stats).
 */
function solveAxis(p0, v0, T, lo, hi, As, o = {}) {
	const Kmax = o.k === undefined ? 1 : o.k, limit = o.limit || 64, maxNodes = o.maxNodes || Infinity;
	const vlo = o.vlo === undefined ? -Infinity : o.vlo, vhi = o.vhi === undefined ? Infinity : o.vhi;
	const tube = o.tube || null, inputs = o.inputs || [0, 1, 2];
	const out = [], stats = { nodes: 0, cut: 0, budget: false };
	if (T > 127 && Kmax > 0) return Object.assign(out, { stats });
	// can a pattern from (p, v) after tick t, with kLeft more changes and its current input mi, end in the window?
	const feasible = (p, v, t, kLeft, mi) => {
		let a, b, sl = 0;
		if (kLeft === 0) {
			const r = holdAxis(p, v, mi, T - t, As, t);
			a = b = r;
			for (let j = t + 1; j <= T && !sl; j++) { const A = At(As, j); if (A.mods[mi] < 0.1 && A.mods[mi] > -0.1 && !A.liquid) sl = ALIGN_SLACK; }
			if (r[0] + sl < lo || r[0] - sl > hi) return false;
			if (r[1] < vlo || r[1] > vhi) return false;
			return true;
		}
		const e = envelope(p, v, T - t, As, t);
		sl = e.armable[T - t] ? ALIGN_SLACK : 0;
		if (e.phi[T - t] + sl < lo || e.plo[T - t] - sl > hi) return false;
		if (e.vhi[T - t] < vlo || e.vlo[T - t] > vhi) return false;
		return true;
	};
	const orderedAt = (mi, mf, t0) => {
		// LEMMA L needs both runs held keys (no armed tick) and an ordered class along the schedule from t0
		if (mi === 0 || mf === 0) return false;
		for (let j = t0; j <= T; j++) { const A = At(As, j); const kd = kindOf(A); if (kd !== 'INPUT' && kd !== 'FREE' && kd !== 'GRAV' && kd !== 'INPUT+PULL') return false; if (A.mods[mi] < 0.1 && A.mods[mi] > -0.1) return false; if (A.mods[mf] < 0.1 && A.mods[mf] > -0.1) return false; }
		return true;
	};
	const emit = (code, k, p, v) => { if (p >= lo && p <= hi && v >= vlo && v <= vhi && out.length < limit) out.push({ code, k, p, v, str: K1.str(code, T) }); };
	for (let kT = 0; kT <= Kmax && out.length < limit && !stats.budget; kT++) {
		const rec = (t, p, v, miPrev, k, code) => {
			for (const mi of inputs) {
				if (out.length >= limit) return;
				if (k > 0 && mi === miPrev) continue;
				const code2 = (code | (mi << (2 * k)) | (k > 0 ? t << (8 + 7 * (k - 1)) : 0)) >>> 0;
				if (++stats.nodes > maxNodes) { stats.budget = true; return; }
				if (!feasible(p, v, t, kT - k, mi)) { stats.cut++; continue; }
				if (k === kT) {
					// the last run to T
					let pp = p, vv = v, ok = true;
					for (let j = t + 1; j <= T; j++) { const A = At(As, j); vv = vStep(vv, mi, A); pp = pStep(pp, vv, mi, A); if (tube && !tube(j, pp)) { ok = false; break; } }
					if (ok) emit(code2, k, pp, vv);
					continue;
				}
				if (!tube && k === kT - 1) {
					// the second-to-last run: its states, then the last change by LEMMA L's binary search or a scan
					const n = Math.min(T - 1, 127) - t;
					if (n <= 0) continue;
					const ps = new Float64Array(n), vs = new Float64Array(n);
					let pp = p, vv = v;
					for (let i = 0; i < n; i++) { const A = At(As, t + 1 + i); vv = vStep(vv, mi, A); pp = pStep(pp, vv, mi, A); ps[i] = pp; vs[i] = vv; }
					for (const mf of inputs) {
						if (mf === mi || out.length >= limit) continue;
						const code3 = (code2 | (mf << (2 * (k + 1)))) >>> 0;
						const fin = (i) => { const j = t + 1 + i; return holdAxis(ps[i], vs[i], mf, T - j, As, j); };
						const put = (i, r) => { emit((code3 | ((t + 1 + i) << (8 + 7 * k))) >>> 0, k + 1, r[0], r[1]); };
						if (!orderedAt(mi, mf, t + 1)) { for (let i = 0; i < n && out.length < limit; i++) { stats.nodes++; put(i, fin(i)); } continue; }
						// x_T is monotone in the change tick (one more tick of mi instead of mf): increasing when mi > mf
						const up = MS[mi] > MS[mf];
						let a = 0, b = n;
						while (a < b) { const m = (a + b) >> 1; stats.nodes++; const r = fin(m); if (up ? r[0] >= lo : r[0] <= hi) b = m; else a = m + 1; }
						for (let i = a; i < n && out.length < limit; i++) { stats.nodes++; const r = fin(i); if (up ? r[0] > hi : r[0] < lo) break; put(i, r); }
					}
					continue;
				}
				// walk this run tick by tick, branching at every tick into the next run
				let pp = p, vv = v;
				for (let j = t + 1; j < T && j <= 127; j++) {
					const A = At(As, j);
					vv = vStep(vv, mi, A); pp = pStep(pp, vv, mi, A);
					if (tube && !tube(j, pp)) break;
					rec(j, pp, vv, mi, k + 1, code2);
					if (out.length >= limit || stats.budget) return;
				}
			}
		};
		rec(0, p0, v0, -1, 0, 0);
	}
	out.stats = stats;
	return out;
}

// the tiles whose touch changes the state (Me.touchBlock: effects, portals, keys, switches, crowns, the trophy, NPCs,
// music blocks that can abort a tick): a path evaluation stops there; coins change only counts (doors later)
const TOUCH = new Set([5, 121, 113, 1619, 467, 1620, 6, 7, 8, 408, 409, 410, 417, 418, 419, 420, 421, 422, 423, 453, 461, 1517,
	1573, 1584, 1618, 242, 381, 77, 83]);
let NPC = null;
/** 'field' (a field class), 'air' (no physics, no touch), 'coin', 'touch' (changes the state), 'kill', 'solid' */
function tileKind(id) {
	if (id === 0) return 'air';
	if (NPC === null) { try { NPC = new Set(require('../eelvl.js').NPC_IDS || []); } catch (e) { NPC = new Set(); } }
	if (TOUCH.has(id) || NPC.has(id)) return 'touch';
	if (id === 100 || id === 101 || id === 110 || id === 111) return 'coin';
	if (classOfId(id) !== 'other') return 'field';
	if ((K.gravTables().flags[id] & 4) !== 0) return 'kill';
	if ((K.flagsOf(id) & K.F.SOLID) !== 0) return 'solid';
	return 'air';
}

// ---------------------------------------------------------------- the piecewise path (field boundaries, the queue)
/**
 * pathEval(L, s, masks, o): the COLLISION-FREE per-axis evaluation of an input sequence through the fields of a static
 * level: per tick the centre tile (the half-block rule), the gravity queue (2 ticks, 1 in dots / climbables), the tile
 * below (the ice timer), the context fieldCtx(cur, del, ...) and the two axis maps; multi-jumps in the air (jc < maxJ).
 * s: {px, py, vx, vy, q0, q1, slip, flip, sb, zombie, lowg, wg, jb, jc, maxJ} (kin's state fields; fromSim gives them).
 * Stops at the first tick whose swept box touches a tile that is not passable air-like physics, or whose centre tile is
 * outside the field classes (an effect, a portal, a killer, a coin: they change the state), or o.stop(t, st) true.
 * Returns {n (ticks evaluated), why ('end' | 'solid' | 'tile' | 'stop' | 'edge'), xs, ys, vxs, vys, cur: Int32Array}.
 * Exact = the engine on every evaluated tick (THEOREM F1 + the queue: test/fields_theorems.js F5).
 */
function pathEval(L, s, masks, o = {}) {
	const n = masks.length, W = L.width, H = L.height, fg = L.fg, lk = L.lookup0, flags = L.flags;
	const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1), vxs = new Float64Array(n + 1), vys = new Float64Array(n + 1);
	const curs = new Int32Array(n + 1);
	const ctxX = o.ctxs ? new Array(n + 1).fill(null) : null, ctxY = o.ctxs ? new Array(n + 1).fill(null) : null;
	let px = s.px, py = s.py, vx = s.vx, vy = s.vy, q0 = s.q0, q1 = s.q1, slip = s.slip || 0, jc = s.jc === undefined ? 1 : s.jc;
	const maxJ = s.maxJ || 1;
	xs[0] = px; ys[0] = py; vxs[0] = vx; vys[0] = vy;
	const base = { flip: s.flip | 0, sb: s.sb | 0, zombie: !!s.zombie, lowGravity: !!s.lowg, worldGravity: s.wg === undefined ? 1 : s.wg, jb: s.jb | 0 };
	const cache = o.cache || new Map();
	const bkey = `${base.flip},${base.sb},${base.zombie ? 1 : 0},${base.lowGravity ? 1 : 0},${base.worldGravity},${base.jb}|`;
	const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : fg[y * W + x];
	const maxX = W * 16 - 16, maxY = H * 16 - 16;
	const passable = (id) => (flags[id] & K.F.SOLID) === 0;
	let why = 'end', t = 0;
	if (s.lev || s.dead) { why = 'unsupported'; t = 1; }
	for (t = why === 'end' ? 1 : n + 1; t <= n; t++) {
		let cx = Math.trunc(px + 8.0) >> 4, cy = Math.trunc(py + 8.0) >> 4;
		let cur = at(cx, cy);
		if ((flags[cur] & K.F.HALF) !== 0) {
			let rot = (cx >= 0 && cy >= 0 && cx < W && cy < H) ? lk[cy * W + cx] : 0;
			if ((L.xflags[cur] & 4) !== 0) rot = 1;
			if (rot === 1) cy -= 1;
			if (rot === 0) cx -= 1;
			cur = at(cx, cy);
		}
		const tk = tileKind(cur);
		if (tk === 'touch' || tk === 'kill' || (tk === 'coin' && o.stopCoins)) { why = 'tile'; break; }
		let del = q0;
		q0 = q1; q1 = cur;
		if (K.isImmediate(cur)) { del = q0; q0 = q1; q1 = cur; }
		const bd = K.belowDir(cur, base.flip);
		const below = at(cx + bd[0], cy + bd[1]);
		slip = K.slipStep(slip, below, cur);
		const key = bkey + cur + ',' + del + ',' + slip;
		let ctx = cache.get(key);
		if (!ctx) { ctx = fieldCtx(Object.assign({ cur, del, slip }, base)); cache.set(key, ctx); }
		const m = masks[t - 1] & 31;
		const h = ((m & 2) ? -1 : 0) + ((m & 4) ? 1 : 0), v = ((m & 8) ? -1 : 0) + ((m & 16) ? 1 : 0);
		const ix = h < 0 ? 1 : h > 0 ? 2 : 0, iy = v < 0 ? 1 : v > 0 ? 2 : 0;
		const nvx = vStep(vx, ix, ctx.x), nvy = vStep(vy, iy, ctx.y);
		let nx = (px >= 16.0 && px + nvx >= 16.0) ? px + nvx : K.moveFree(px, nvx, ctx.x.boost !== 0);
		let ny = (py >= 16.0 && py + nvy >= 16.0) ? py + nvy : K.moveFree(py, nvy, ctx.y.boost !== 0);
		// the swept box must stay in the world and on passable tiles (no probe of the lockstep loop can block)
		if (nx < 0 || ny < 0 || nx > maxX || ny > maxY) { why = 'edge'; break; }
		const x0 = Math.min(px, nx), x1 = Math.max(px, nx), y0 = Math.min(py, ny), y1 = Math.max(py, ny);
		let blocked = false;
		for (let ty = (y0 | 0) >> 4; ty <= ((y1 + 16) | 0) >> 4 && !blocked; ty++) {
			if (ty * 16 >= y1 + 16) break;
			for (let tx = (x0 | 0) >> 4; tx <= ((x1 + 16) | 0) >> 4; tx++) {
				if (tx * 16 >= x1 + 16) break;
				if (!passable(at(tx, ty))) { blocked = true; break; }
			}
		}
		if (blocked) { why = 'solid'; break; }
		let fvx = nvx, fvy = nvy;
		// the jump in the air (multi-jump): the engine's order, after the move
		if (cur === 461) jc = 0;
		if (jc === 0) jc = 1;
		if ((m & 1) !== 0) {
			if (jc < maxJ && ctx.x.J !== 0) { if (maxJ < 1000) jc++; fvx = ctx.x.J; }
			if (jc < maxJ && ctx.y.J !== 0) { if (maxJ < 1000) jc++; fvy = ctx.y.J; }
		}
		nx = K.align(nx, fvx, ctx.x.mods[ix], ctx.x.liquid);
		ny = K.align(ny, fvy, ctx.y.mods[iy], ctx.y.liquid);
		px = nx; py = ny; vx = fvx; vy = fvy;
		xs[t] = px; ys[t] = py; vxs[t] = vx; vys[t] = vy; curs[t] = cur;
		if (ctxX) { ctxX[t] = ctx.x; ctxY[t] = ctx.y; }
		if (o.stop && o.stop(t, px, py, vx, vy)) { why = 'stop'; break; }
	}
	const nEval = why === 'end' ? n : (why === 'stop' ? t : (why === 'unsupported' ? 0 : t - 1));
	return { n: nEval, why, xs, ys, vxs, vys, cur: curs, q0, q1, slip, jc, ctxX, ctxY };
}

/** THEOREM F2's map on one axis context: negate the pulls and the inputs' signs (the mirror field) */
function mirror(A) {
	const ms = new Float64Array(3), mods = new Float64Array(3);
	// the mirror swaps the neg and pos keys: input 1 of the mirror = input 2 of A with its sign flipped
	ms[0] = -A.ms[0]; ms[1] = -A.ms[2]; ms[2] = -A.ms[1];
	mods[0] = -A.mods[0]; mods[1] = -A.mods[2]; mods[2] = -A.mods[1];
	return Object.assign({}, A, { ms, mods, mo: -A.mo, moO: -A.moO, boost: -A.boost, J: -A.J, mor: -A.mor });
}

module.exports = {
	MS, ALIGN_SLACK, CLASSES, REP, classOfId, physKey,
	fieldCtx, ctxOfSim, schedule, vStep, pStep, step, At, armed, evalAxis, holdAxis, envelope, minTAxis, fixedPoint,
	kindOf, describe, solveAxis, mirror, pathEval, tileKind, TOUCH,
};
