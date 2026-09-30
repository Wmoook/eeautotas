'use strict';
// EE MATH, part 2: the REGIME of a tick, and of a swept path, tick by tick (docs/ee_math.md "Separability and coupling").
//
//   classifyTick(sim, mask) -> {code, env, sep, model}    the tick about to be played from sim's state (sim unchanged):
//       code  = bit set (C_* below): the couplings found and the axis modes; sep = no coupling bit (the tick map is the
//             product X(x, vx; h, E) x Y(y, vy, jc, thrust; v, jump, E) of src/math/axis.js)
//       model = the per-axis prediction of the state after the tick {px, py, vx, vy, jc, thr, thrusting, grounded}
//   pathRegimes(level, masks, o) -> {codes: Uint32Array, env: Uint16Array (env class ids), stats}   a whole run replayed
//       (o.check: compare the per-axis model with the engine at every tick: stats.sepExact / sepMiss)
//   certifyFree(level, xs, ys, o) -> -1 | first bad tick   a HYPOTHETICAL path (per-tick box positions, e.g. an x table
//       row combined with a y table row): every tick's swept box in plain air and the centre tiles of one physics class,
//       so the factorized (free-air) maps apply; the geometric check the move solver runs before its one engine replay.
//   blockedAt(sim, x, y) -> 0 free / 1 blocked / 2 decided by a one-way rule (speeds, overlap memory): overlaps() != 0
//       without its side effects.
//   physClass(level, id) -> class id (PC_*), PC_NAMES
const E = require('../eesim.js');
const A = require('./axis.js');

// coupling bits (any of them: the tick is not a product of per-axis maps)
const C_CORNER = 1;     // a MUTUAL corner: probes of both axes give different answers at the other axis's positions of the tick
const C_ONEWAY = 2;     // a probed box covers a one-way tile (its rule reads both speeds and the overlap memory)
const C_PORTAL = 4;     // a teleport (the velocity rotation mixes the axes)
const C_STUCK = 8;      // the box overlaps a blocking tile at the tick's start (the failed first step's retries depend on the other axis)
const C_DOORQ = 16;     // a pending team / purple switch retry at the tick's start (door solidity can change inside the tick)
const C_DEAD = 32;      // dead or killed this tick (both speeds frozen)
const C_EFFECT = 64;    // touchBlock changed a physics parameter (effects: fly, jump, speed, gravity, multijump, ...)
const C_GOD = 128;
// TRIANGULAR collision ticks: one axis's probes depend on the other axis's sub-step positions, the other axis's do not
// (a walk-off, a landing on a ledge's edge, a slide past a wall's end): the independent axis is still its 1D map
const C_TRIXY = 1 << 20;   // y depends on x (x independent)
const C_TRIYX = 1 << 21;   // x depends on y (y independent)
const C_COUPLED = C_CORNER | C_ONEWAY | C_PORTAL | C_STUCK | C_DOORQ | C_DEAD | C_EFFECT | C_GOD | C_TRIXY | C_TRIYX;
// axis modes and informational bits (they do not break the product)
const C_XHITP = 1 << 8, C_XHITN = 1 << 9, C_YHITP = 1 << 10, C_YHITN = 1 << 11;   // blocked moving + / - on that axis
const C_ALIGNX = 1 << 12, C_ALIGNY = 1 << 13;   // the auto-align fired (the map depends on the position mod 16)
const C_HALFCUR = 1 << 14;   // the half-block rule moved the centre tile (the environment depends on the sub-tile position)
const C_ICEMEM = 1 << 15;    // slippery > 0 (ice drag on both axes)
const C_ENVCHG = 1 << 16;    // the environment (current, delayed classes, slip, parameters) differs from the tick before
const C_GROUND = 1 << 17;    // grounded (a blocked step toward the current tile's gravity)
const C_JUMP = 1 << 18;      // a jump happened (the gravity axis speed set)
const C_MISS = 1 << 19;      // (pathRegimes check) the per-axis model differs from the engine on this tick
const C_NEAR = 1 << 22;      // no collision, but the swept rectangle holds a non-air tile the lockstep path went around

// physics classes of a tile (what the centre / delayed tile does to the dynamics)
const PC_NAMES = ['air', 'arrowL', 'arrowU', 'arrowR', 'arrowD', 'dot', 'climb', 'water', 'mud', 'lava', 'toxic', 'boostL', 'boostR',
	'boostU', 'boostD', 'kill', 'portal', 'effect', 'solid'];
const PC = {}; PC_NAMES.forEach((n, i) => { PC[n] = i; });
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
function physClass(L, id) {
	const f = L.flags[id];
	if (id === 1 || id === 411) return PC.arrowL;
	if (id === 2 || id === 412) return PC.arrowU;
	if (id === 3 || id === 413) return PC.arrowR;
	if (id === 1518 || id === 1519) return PC.arrowD;
	if (id === 4 || id === 414) return PC.dot;
	if ((f & A.F_CLIMB) !== 0) return PC.climb;
	if (id === 119) return PC.water;
	if (id === 369) return PC.mud;
	if (id === 416) return PC.lava;
	if (id === 1585) return PC.toxic;
	if (id === 114) return PC.boostL;
	if (id === 115) return PC.boostR;
	if (id === 116) return PC.boostU;
	if (id === 117) return PC.boostD;
	if ((L.gFlags[id] & 4) !== 0) return PC.kill;
	if (id === 242 || id === 381) return PC.portal;
	if (EFFECT_IDS.has(id)) return PC.effect;
	if ((f & A.F_SOLID) !== 0) return PC.solid;
	return PC.air;
}

/** overlaps(x, y) != 0 without side effects: 0 free, 1 blocked, 2 only a one-way rule decides (speeds, memory) */
function blockedAt(sim, x, y) {
	if (x < 0.0 || y < 0.0 || x > sim._maxX || y > sim._maxY) return 1;
	if (sim.in_god_mode) return 0;
	const W = sim.width, ovl = sim._ovl, flags = sim._flags;
	const ox = (x | 0) >> 4, oy = (y | 0) >> 4;
	const cxEnd = ox + 1 + ((x + 16.0) > (ox * 16 + 16) ? 1 : 0);
	const cyEnd = oy + 1 + ((y + 16.0) > (oy * 16 + 16) ? 1 : 0);
	let oneway = false;
	for (let cy = oy; cy < cyEnd; cy++) {
		const row = cy * W;
		for (let cx = ox; cx < cxEnd; cx++) {
			const k = ovl[row + cx];
			if (k === A.OV_AIR || k === A.OV_SECRET) continue;
			const tlx = cx * 16, tly = cy * 16;
			if (!(x < tlx + 16.0 && tlx < x + 16.0 && y < tly + 16.0 && tly < y + 16.0)) continue;
			if (k === A.OV_SOLID) return 1;
			const val = sim.tiles[row + cx];
			const fl = flags[val];
			if ((fl & (A.F_ROTHALF | A.F_HALF | A.F_JUMPTHRU)) !== 0) {
				if ((fl & A.F_ROTHALF) !== 0) {
					if ((fl & A.F_JUMPTHRU) !== 0) { oneway = true; continue; }
				} else if ((fl & A.F_HALF) !== 0) {
					const rot = sim._lookup[row + cx];
					let hit = true;
					if (rot === 1) hit = x < tlx + 16.0 && tlx < x + 16.0 && y < tly + 16.0 && tly + 8.0 < y + 16.0;
					else if (rot === 2) hit = x < tlx + 8.0 && tlx < x + 16.0 && y < tly + 16.0 && tly < y + 16.0;
					else if (rot === 3) hit = x < tlx + 16.0 && tlx < x + 16.0 && y < tly + 8.0 && tly < y + 16.0;
					else if (rot === 0) hit = x < tlx + 16.0 && tlx + 8.0 < x + 16.0 && y < tly + 16.0 && tly < y + 16.0;
					if (!hit) continue;
				} else { oneway = true; continue; }
			}
			if ((fl & A.F_DOOR) !== 0) {
				if (val !== 50 && sim._doorPassable(val, row + cx)) continue;
			}
			return 1;
		}
	}
	return oneway ? 2 : 0;
}

/**
 * The engine's sub-stepped movement loop (eesim.js 1285-1352) replayed with blockedAt: the rest positions of each axis
 * (visX, visY), every probe [pos, other axis pos, answer], the final positions, hits. Used to find the couplings.
 */
function shadowMove(sim, sx, sy, boostCur) {
	let px = sim.px, py = sim.py;
	let remx = A.fmod1(px), remy = A.fmod1(py), csx = sx, csy = sy;
	let donex = false, doney = false, oneway = false, guard = 0;
	const prX = [], prY = [], visX = [px], visY = [py];
	let hitX = 0, hitY = 0;
	if (csx !== 0.0 || csy !== 0.0) {
		do {
			const ox = px, oy = py, osx = csx, osy = csy;
			if (csx > 0.0) {
				if (csx + remx >= 1.0) { px += (1.0 - remx); px = px | 0; csx -= (1.0 - remx); remx = 0.0; }
				else { px += csx; csx = 0.0; }
			} else if (csx < 0.0) {
				if (remx + csx < 0.0 && (remx !== 0.0 || boostCur)) { csx += remx; px -= remx; px = px | 0; remx = 1.0; }
				else { px += csx; csx = 0.0; }
			}
			let r = blockedAt(sim, px, py);
			if (r === 2) { oneway = true; r = 0; }
			if (px !== ox || r !== 0) prX.push(px, py, r);
			if (r !== 0) { if (!donex) hitX = osx > 0 ? 1 : -1; px = ox; csx = osx; donex = true; }
			if (px !== visX[visX.length - 1]) visX.push(px);
			if (csy > 0.0) {
				if (csy + remy >= 1.0) { py += 1.0 - remy; py = py | 0; csy -= (1.0 - remy); remy = 0.0; }
				else { py += csy; csy = 0.0; }
			} else if (csy < 0.0) {
				if (remy + csy < 0.0 && (remy !== 0.0 || boostCur)) { py -= remy; py = py | 0; csy += remy; remy = 1.0; }
				else { py += csy; csy = 0.0; }
			}
			r = blockedAt(sim, px, py);
			if (r === 2) { oneway = true; r = 0; }
			if (py !== oy || r !== 0) prY.push(py, px, r);
			if (r !== 0) { if (!doney) hitY = osy > 0 ? 1 : -1; py = oy; csy = osy; doney = true; }
			if (py !== visY[visY.length - 1]) visY.push(py);
			if (++guard > 100000) break;
		} while ((csx !== 0.0 && !donex) || (csy !== 0.0 && !doney));
	}
	return { px, py, hitX, hitY, prX, prY, visX, visY, oneway };
}

/**
 * The corner test: is every probe's answer the same at every rest position the other axis takes in the tick?
 * {xDepY: some x probe's answer depends on y, yDepX: some y probe's answer depends on x}. Neither: the tick's collisions
 * are 1D (a product); one of them: TRIANGULAR (that axis is driven by the other one's sub-step schedule, the other axis
 * is independent); both: a mutual corner.
 */
function cornerOf(sim, sh) {
	let xDepY = false, yDepX = false;
	for (let i = 0; i < sh.prX.length && !xDepY; i += 3) {
		const x = sh.prX[i], r = sh.prX[i + 2];
		for (const y of sh.visY) { const b = blockedAt(sim, x, y); if ((b === 1 ? 1 : 0) !== r || b === 2) { xDepY = true; break; } }
	}
	for (let i = 0; i < sh.prY.length && !yDepX; i += 3) {
		const y = sh.prY[i], r = sh.prY[i + 2];
		for (const x of sh.visX) { const b = blockedAt(sim, x, y); if ((b === 1 ? 1 : 0) !== r || b === 2) { yDepX = true; break; } }
	}
	return { xDepY, yDepX };
}

const PARAMS = ['jump_boost', 'speed_boost', 'low_gravity', 'has_levitation', 'max_jumps', 'flip_gravity', 'is_invulnerable', 'is_zombie',
	'is_cursed', 'is_poisoned', 'is_on_fire', 'in_god_mode', 'world_gravity_multiplier'];
function paramsOf(sim) { return PARAMS.map((k) => sim[k]); }

/**
 * classifyTick(sim, mask): the regime of the tick sim would play with `mask` (sim is not changed). Pass o.after (the
 * sim after the real tick, or a {params: paramsOf(after)} object) to detect C_EFFECT; without it no effect is flagged.
 * The door states the movement sees are the tick's own (eesim.js tick(): PlayState's gate snapshots and World.update's
 * time doors and key expiry run before Player.tick): they are put in place while the tick is analysed, then restored;
 * a key expiring or a gate snapshot changing this tick sets C_DOORQ.
 */
function classifyTick(sim, mask, o = {}) {
	const td = sim._timedoor_state, km = sim._keysMask, sc = sim._show_coin_gate, sb = sim._show_blue_coin_gate, sd = sim._show_death_gate;
	const t = sim._ticks + 1;
	let q = false;
	sim._timedoor_state = (t % E.TIMEDOOR_PERIOD) >= E.TIMEDOOR_PERIOD / 2;
	if (km !== 0) for (let c = 0; c < 6; c++) if ((km & (1 << c)) !== 0 && (t - sim._kt[c]) >= E.KEY_TICKS) { sim._keysMask &= ~(1 << c); q = true; }
	if (sc !== sim.coins || sb !== sim.blue_coins || sd !== sim.deaths) {
		const L = sim.level;
		if (L.hasCoinGate || L.hasBlueCoinGate || L.hasDeathGate) q = true;
		sim._show_coin_gate = sim.coins; sim._show_blue_coin_gate = sim.blue_coins; sim._show_death_gate = sim.deaths;
	}
	try {
		const r = classifyCore(sim, mask, o);
		if (q) { r.code |= C_DOORQ; r.sep = false; }
		return r;
	} finally {
		sim._timedoor_state = td; sim._keysMask = km; sim._show_coin_gate = sc; sim._show_blue_coin_gate = sb; sim._show_death_gate = sd;
	}
}

function classifyCore(sim, mask, o) {
	const env = A.envOf(sim, mask);
	let code = 0;
	if (env.god) code |= C_GOD;
	if (sim.is_dead || env.kill) code |= C_DEAD;
	// a pending purple-switch press, or a pending team change that would change the team (Player.as:421: retried at the
	// tick's start; a retry whose cell number is the team already is a no-op)
	if (sim._tileQueue.length !== 0 || (sim._team_tx !== -1 && sim._lookupAt(sim._team_tx, sim._team_ty) !== sim.team)) code |= C_DOORQ;
	if (env.half) code |= C_HALFCUR;
	if (env.slip > 0.0 || sim._slippery > 0.0) code |= C_ICEMEM;
	// timed kills at the top of the tick (curse, zombie, poison, fire): the post-tick state tells
	if (o.after && o.after.is_dead && !sim.is_dead) code |= C_DEAD;
	let vx = A.dragAxis(sim.speed_x, env.modX, env.mx, env.moy, env);
	let vy = A.dragAxis(sim.speed_y, env.modY, env.my, env.mox, env);
	if (!env.god) {
		if (env.boostX !== null) vx = env.boostX;
		if (env.boostY !== null) vy = env.boostY;
	}
	const deadNow = (code & C_DEAD) !== 0;
	if (deadNow) { vx = 0.0; vy = 0.0; }
	// processPortals: a teleport this tick (the movement loop runs, the tile is an active portal, lastPortal clear)
	if ((vx !== 0.0 || vy !== 0.0) && !env.god && env.portal >= 0) {
		const L = sim.level;
		if (L.pTarget[env.portal] !== L.pId[env.portal] && !sim._last_portal_set) code |= C_PORTAL;
	}
	const b0 = blockedAt(sim, sim.px, sim.py);
	if (b0 === 1) code |= C_STUCK;
	if (b0 === 2) code |= C_ONEWAY;
	const sh = shadowMove(sim, vx, vy, env.boostCur);
	if (sh.oneway) code |= C_ONEWAY;
	const anyHit = sh.hitX !== 0 || sh.hitY !== 0;
	// the per-axis model (the product): each axis moves by its 1D map with the other axis FROZEN at its tick-start
	// coordinate (the 1D obstacle Bx(p) = blocked(p, y0), By(p) = blocked(x0, p))
	const mx = A.moveAxis(sim.px, vx, env.boostCur, (p) => blockedAt(sim, p, sim.py) === 1);
	const my = A.moveAxis(sim.py, vy, env.boostCur, (p) => blockedAt(sim, sim.px, p) === 1);
	if ((code & (C_ONEWAY | C_STUCK)) === 0) {
		// the lockstep loop (shadow = the engine's movement) against each frozen 1D map: an axis whose outcome is its
		// frozen map is independent of the other axis's motion in this tick (for every other-axis input: its map does not
		// read them); both: a product; one: triangular; none: a mutual corner
		const xOK = Object.is(mx.p, sh.px) && mx.hit === (sh.hitX !== 0);
		const yOK = Object.is(my.p, sh.py) && my.hit === (sh.hitY !== 0);
		if (!xOK && !yOK) code |= C_CORNER;
		else if (!yOK) code |= C_TRIXY;
		else if (!xOK) code |= C_TRIYX;
		// C_NEAR: nothing collided, but the tick's swept rectangle holds a non-air tile (a staircase past a block's corner)
		if (!anyHit && !sim._sweptAir(Math.min(sim.px, sh.px), Math.max(sim.px, sh.px), Math.min(sim.py, sh.py), Math.max(sim.py, sh.py))) code |= C_NEAR;
	}
	if (sh.hitX > 0) code |= C_XHITP; else if (sh.hitX < 0) code |= C_XHITN;
	if (sh.hitY > 0) code |= C_YHITP; else if (sh.hitY < 0) code |= C_YHITN;
	let grounded = false;
	if (mx.hit && ((vx > 0.0 && env.morx > 0) || (vx < 0.0 && env.morx < 0))) grounded = true;
	if (my.hit && ((vy > 0.0 && env.mory > 0) || (vy < 0.0 && env.mory < 0))) grounded = true;
	const tail = A.gravityTail({ vx: mx.hit ? 0.0 : vx, vy: my.hit ? 0.0 : vy, jc: sim.jump_count, thr: sim._current_thrust,
		thrusting: sim.is_thrusting, grounded, deadNow }, env, { maxJumps: sim.max_jumps, lev: sim.has_levitation });
	if (grounded) code |= C_GROUND;
	if (tail.jumped) code |= C_JUMP;
	const ax = A.alignAxis(mx.p, tail.vx, env.modX, env.liquidCur), ay = A.alignAxis(my.p, tail.vy, env.modY, env.liquidCur);
	if (ax !== mx.p) code |= C_ALIGNX;
	if (ay !== my.p) code |= C_ALIGNY;
	if (o.after && o.after.params) {
		const pa = o.after.params, pb = paramsOf(sim);
		for (let i = 0; i < pa.length; i++) if (!Object.is(pa[i], pb[i])) { code |= C_EFFECT; break; }
	}
	return { code, env, sep: (code & C_COUPLED) === 0,
		model: { px: ax, py: ay, vx: tail.vx, vy: tail.vy, jc: tail.jc, thr: tail.thr, thrusting: tail.thrusting, grounded } };
}

/** the model's prediction against the engine's state after the tick (bit for bit) */
function modelMatches(m, after) {
	return Object.is(m.px, after.px) && Object.is(m.py, after.py) && Object.is(m.vx, after.speed_x) && Object.is(m.vy, after.speed_y) &&
		m.jc === after.jump_count && Object.is(m.thr, after._current_thrust) && m.thrusting === after.is_thrusting &&
		m.grounded === after._grounded;
}

/** the environment key of a tick: the per-axis maps it selects (classes of current and delayed, slip, parameters) */
function envKey(L, sim, env) {
	return physClass(L, env.current) * 64 + physClass(L, env.delayed) + (env.slip > 0.0 ? 4096 : 0) + (sim.flip_gravity & 7) * 8192 +
		(sim.has_levitation ? 65536 : 0) + (sim.speed_boost & 3) * 131072 + (sim.jump_boost & 3) * 524288 + (sim.low_gravity ? 2097152 : 0) +
		(sim.is_zombie ? 4194304 : 0) + Math.min(3, sim.max_jumps >= 1000 ? 3 : sim.max_jumps) * 8388608;
}

/**
 * pathRegimes(level, masks, o) -> {codes, cur, del, stats}: the run replayed from the level's start (or o.sim), each tick
 * classified before it is played. o.check: the per-axis model vs the engine on every tick (C_MISS on a difference).
 * stats: {ticks, sep, coupled: {bit: n}, modes, sepExact, sepMiss, allExact, envChanges, runs (free-uniform run lengths)}
 */
function pathRegimes(L, masks, o = {}) {
	const sim = o.sim || new E.EESim(L);
	if (!o.sim) sim.reset();
	const inp = new E.EEInput();
	const n = o.until ? Math.min(o.until, masks.length) : masks.length;
	const codes = new Uint32Array(n), cur = new Uint8Array(n), del = new Uint8Array(n);
	const st = { ticks: n, sep: 0, coupled: {}, bitExact: {}, sepExact: 0, sepMiss: 0, allExact: 0, envChanges: 0, freeRuns: [], sepRuns: [], miss: [],
		tri: 0, triExact: 0, triMiss: 0 };
	let prevKey = -1, freeRun = 0, sepRun = 0;
	const CB = [0, 1, 2, 3, 4, 5, 6, 7, 20, 21];
	for (let t = 0; t < n; t++) {
		const m = masks[t] & 31;
		const cls = classifyTick(sim, m, {});
		const key = envKey(L, sim, cls.env);
		cur[t] = physClass(L, cls.env.current); del[t] = physClass(L, cls.env.delayed);
		E.applyMask(inp, m);
		const before = paramsOf(sim);
		const wasDead = sim.is_dead;
		sim.tick(inp);
		let code = cls.code;
		const after = paramsOf(sim);
		for (let i = 0; i < after.length; i++) if (!Object.is(after[i], before[i])) { code |= C_EFFECT; break; }
		if (sim.is_dead && !wasDead) code |= C_DEAD;
		if (sim.teleported && (code & C_PORTAL) === 0) code |= C_PORTAL;
		if (key !== prevKey && t > 0) { code |= C_ENVCHG; st.envChanges++; }
		prevKey = key;
		const sep = (code & C_COUPLED) === 0;
		// triangular: only the one-way dependence, nothing else coupled
		const triOnly = (code & C_COUPLED & ~(C_TRIXY | C_TRIYX)) === 0 && (code & (C_TRIXY | C_TRIYX)) !== 0;
		if (o.check) {
			const ok = modelMatches(cls.model, sim);
			if (ok) { st.allExact++; for (const b of CB) if ((code >> b) & 1) st.bitExact[b] = (st.bitExact[b] || 0) + 1; }
			if (sep) { if (ok) st.sepExact++; else { st.sepMiss++; code |= C_MISS; if (st.miss.length < 20) st.miss.push({ t, code, model: cls.model, px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y, jc: sim.jump_count }); } }
			if (triOnly) {
				// the independent axis is its 1D map
				const md = cls.model;
				const indep = (code & C_TRIXY) !== 0
					? Object.is(md.px, sim.px) && Object.is(md.vx, sim.speed_x)
					: Object.is(md.py, sim.py) && Object.is(md.vy, sim.speed_y);
				if (indep) st.triExact++; else { st.triMiss++; code |= C_MISS; if (st.miss.length < 20) st.miss.push({ t, tri: true, code, model: md, px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y }); }
			}
		}
		codes[t] = code;
		if (sep) st.sep++;
		if (triOnly) st.tri++;
		for (const b of CB) if ((code >> b) & 1) st.coupled[b] = (st.coupled[b] || 0) + 1;
		const free = sep && (code & (C_XHITP | C_XHITN | C_YHITP | C_YHITN | C_ENVCHG | C_ALIGNX | C_ALIGNY | C_ICEMEM)) === 0;
		if (free) freeRun++; else { if (freeRun > 0) st.freeRuns.push(freeRun); freeRun = 0; }
		if (sep && (code & C_ENVCHG) === 0) sepRun++; else { if (sepRun > 0) st.sepRuns.push(sepRun); sepRun = 0; }
	}
	if (freeRun > 0) st.freeRuns.push(freeRun);
	if (sepRun > 0) st.sepRuns.push(sepRun);
	return { codes, cur, del, stats: st, sim };
}

/**
 * drivers(level, env) -> {xH, xJ, yV, yJ}: which input acts on which axis in the tick's environment (eesim.js 1135-1139:
 * the input axes, selected by the DELAYED tile; the jump bit, its jumpCount and the levitation thrust act on the axis
 * whose CURRENT-tile gravity mor is non-zero; the jump itself also needs the delayed pull mo on that axis).
 */
function drivers(L, env) {
	const liquidD = (L.flags[env.delayed] & A.F_LIQUID) !== 0;
	return {
		xH: liquidD || env.moy !== 0.0 || env.mox === 0.0, xJ: env.morx !== 0,
		yV: liquidD || env.moy === 0.0, yJ: env.mory !== 0,
		jumpX: env.morx !== 0 && env.mox !== 0.0, jumpY: env.mory !== 0 && env.moy !== 0.0,
	};
}

/**
 * envSchedule(level, xs, ys, q0, q1) -> {curId, delId, cur, del, below, cx, cy} (Int32 / Uint8 arrays, index t = 1..n
 * for the tick that starts at (xs[t-1], ys[t-1])): the environment a HYPOTHETICAL path meets, from its positions alone
 * (the centre tile with the half-block rule, the gravity queue started from the state's q0, q1 = sim._q0, sim._q1,
 * the tile below for flipGravity 0). The mode schedule of a candidate leg: where it switches tables.
 */
function envSchedule(L, xs, ys, q0, q1) {
	const n = xs.length - 1, W = L.width, H = L.height, fg = L.fg;
	const curId = new Int32Array(n + 1), delId = new Int32Array(n + 1), below = new Int32Array(n + 1);
	const cur = new Uint8Array(n + 1), del = new Uint8Array(n + 1), cxs = new Int32Array(n + 1), cys = new Int32Array(n + 1);
	const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : fg[y * W + x];
	for (let t = 1; t <= n; t++) {
		let cx = Math.trunc(xs[t - 1] + 8.0) >> 4, cy = Math.trunc(ys[t - 1] + 8.0) >> 4;
		let c = at(cx, cy);
		if ((L.flags[c] & A.F_HALF) !== 0) {
			let rot = (cx >= 0 && cy >= 0 && cx < W && cy < H) ? L.lookup0[cy * W + cx] : 0;
			if ((L.xflags[c] & 4) !== 0) rot = 1;
			if (rot === 1) cy -= 1;
			if (rot === 0) cx -= 1;
			c = at(cx, cy);
		}
		let d = q0;
		q0 = q1; q1 = c;
		if (c === 4 || c === 414 || (L.flags[c] & A.F_CLIMB) !== 0) { d = q0; q0 = q1; q1 = c; }
		curId[t] = c; delId[t] = d; cur[t] = physClass(L, c); del[t] = physClass(L, d);
		below[t] = at(cx, cy + 1); cxs[t] = cx; cys[t] = cy;
	}
	return { curId, delId, cur, del, below, cx: cxs, cy: cys };
}

/**
 * certifyFree(level, xs, ys, o) -> -1 when the hypothetical path (xs[t], ys[t] = the box after tick t, t = 0 the start)
 * stays in the free product regime at every tick, else the first tick t (1-based) where it may not: the swept box of the
 * tick (the rectangle between the two positions) must lie in the world on plain-air tiles (no probe can block, so no
 * collision, corner, one-way or door), and the centre tile (the half-block rule included) of the tick's start and the
 * delayed tile (2 ticks back; 1 for dots / climbables) must be of physics class o.cls (default 'air') and no portal /
 * effect / kill tile, the tile below not ice (o.cls 'air': slippery stays 0). A level-independent table row (dx(t),
 * dy(t)) placed at the start state therefore needs this check and one engine replay (the replay is exact by theorem 2
 * when this returns -1 and the start's delayed tiles are of the class too).
 */
function certifyFree(L, xs, ys, o = {}) {
	const cls = PC[o.cls || 'air'];
	const W = L.width, H = L.height, maxX = W * 16 - 16, maxY = H * 16 - 16;
	const ovl = L.ovl, fg = L.fg;
	const tileClass = (x, y) => {
		let cx = Math.trunc(x + 8.0) >> 4, cy = Math.trunc(y + 8.0) >> 4;
		if (cx < 0 || cy < 0 || cx >= W || cy >= H) return PC.air;
		let id = fg[cy * W + cx];
		if ((L.flags[id] & A.F_HALF) !== 0) {
			let rot = L.lookup0[cy * W + cx];
			if ((L.xflags[id] & 4) !== 0) rot = 1;
			if (rot === 1) cy -= 1;
			if (rot === 0) cx -= 1;
			id = (cx < 0 || cy < 0 || cx >= W || cy >= H) ? 0 : fg[cy * W + cx];
		}
		return physClass(L, id);
	};
	const belowIce = (x, y) => {
		const cx = Math.trunc(x + 8.0) >> 4, cy = (Math.trunc(y + 8.0) >> 4) + 1;
		return cx >= 0 && cy >= 0 && cx < W && cy < H && fg[cy * W + cx] === 1064;
	};
	for (let t = 1; t < xs.length; t++) {
		const x0 = xs[t - 1], y0 = ys[t - 1], x1 = xs[t], y1 = ys[t];
		const minX = Math.min(x0, x1), maxXs = Math.max(x0, x1), minY = Math.min(y0, y1), maxYs = Math.max(y0, y1);
		if (minX < 0.0 || minY < 0.0 || maxXs > maxX || maxYs > maxY) return t;
		const tx0 = (minX | 0) >> 4, ty0 = (minY | 0) >> 4;
		const ox1 = (maxXs | 0) >> 4, oy1 = (maxYs | 0) >> 4;
		const tx1 = ox1 + ((maxXs + 16.0) > (ox1 * 16 + 16) ? 1 : 0), ty1 = oy1 + ((maxYs + 16.0) > (oy1 * 16 + 16) ? 1 : 0);
		for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (ovl[ty * W + tx] !== A.OV_AIR) return t;
		if (tileClass(x0, y0) !== cls) return t;
		if (cls === PC.air && belowIce(x0, y0)) return t;
	}
	return -1;
}

module.exports = {
	C_CORNER, C_ONEWAY, C_PORTAL, C_STUCK, C_DOORQ, C_DEAD, C_EFFECT, C_GOD, C_TRIXY, C_TRIYX, C_COUPLED,
	C_XHITP, C_XHITN, C_YHITP, C_YHITN, C_ALIGNX, C_ALIGNY, C_HALFCUR, C_ICEMEM, C_ENVCHG, C_GROUND, C_JUMP, C_MISS, C_NEAR,
	PC, PC_NAMES, physClass, blockedAt, shadowMove, cornerOf, classifyTick, modelMatches, envKey, pathRegimes, certifyFree, paramsOf,
	drivers, envSchedule,
};
