'use strict';
// EE MATH, part 2: SEPARABILITY. The exact per-axis tick maps of eesim.js (Player.tick, Player.as:381-1180) and the
// tick's ENVIRONMENT, the only channel through which the two axes see each other when nothing collides.
//
// THE FACTORIZATION (docs/ee_math.md "Separability and coupling", checked by tools/math/sepcheck.js against the engine):
// one alive, non-god tick with no teleport, no one-way tile under a probed box, the box not stuck at its start and every
// collision probe's answer independent of the other axis over the tick is exactly
//     (x', vx')      = X(x, vx; h, E)          (x-probes answered by the 1D obstacle Bx(x) = blocked(x, any y of the tick))
//     (y', vy', ...) = Y(y, vy, jc, thrust; v, jump, E)
// where E = envOf(sim, mask) is computed from the tick-start state: the centre tile (the half-block rule), the delayed
// tile (the gravity queue), the tile below (ice), the effects (speed / jump / gravity multipliers, flip, levitation,
// multijump). E is a function of (cx, cy) = the centre's TILE: the axes couple only through which tile the centre is in
// (and through the collisions, portals and one-ways that are not in the factorized class).
//
// Every float operation here is the engine's, in the engine's order (the per-axis restatement of eesim.js 1044-1459);
// the model is checked bit for bit against EESim.tick (tools/math/sepcheck.js, test/mathsep.js).
const E = require('../eesim.js');

const K = E.constants;
const MULT = K.MULT, BASE = K.BASE_DRAG, NOMOD = K.NO_MOD_DRAG, ICE_NM = K.ICE_NO_MOD_DRAG, ICE = K.ICE_DRAG;
const WATER_D = K.WATER_DRAG, MUD_D = K.MUD_DRAG, LAVA_D = K.LAVA_DRAG, TOXIC_D = K.TOXIC_DRAG;
const JUMP_HEIGHT = 26.0, MAX_THRUST = 0.2, THRUST_BURN_OFF = 0.01, THRUST_SCALE = JUMP_HEIGHT / 2;
// eesim.js flag bits (buildFlags) and overlap classes (prepareLevel ovl)
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const X_NONROT_HALF = 4;
const OV_AIR = 0, OV_SOLID = 1, OV_COMPLEX = 2, OV_SECRET = 3;
const WATER = 119, MUD = 369, LAVA = 416, TOXIC = 1585, ICE_ID = 1064;
const SPEED_LEFT = 114, SPEED_RIGHT = 115, SPEED_UP = 116, SPEED_DOWN = 117;
const PORTAL = 242, PORTAL_INVISIBLE = 381, EFFECT_MULTIJUMP = 461;

function fmod1(x) { return x > 0.0 ? x - Math.trunc(x) : x % 1.0; }
function fmod16(x) { return x > 0.0 ? x - 16.0 * Math.floor(x * 0.0625) : x % 16.0; }

function tileAt(sim, tx, ty) {
	if (tx < 0 || ty < 0 || tx >= sim.width || ty >= sim.height) return 0;
	return sim.tiles[ty * sim.width + tx];
}

/** Player.tick's current_below (eesim.js _getCurrentBelow): the tile the ice rule reads. */
function belowOf(sim, current, cx, cy) {
	let x = 0, y = 0;
	switch (current) {
		case 1: case 411: x -= 1; break;
		case 2: case 412: y -= 1; break;
		case 3: x += 1; break;
		case 4: y += 1; break;
		default:
			switch (sim.flip_gravity) {
				case 0: y += 1; break;
				case 1: x -= 1; break;
				case 2: y -= 1; break;
				default: x += 1;
			}
	}
	return tileAt(sim, cx + x, cy + y);
}

/**
 * envOf(sim, mask) -> the tick's environment, computed exactly as eesim.js _playerTick computes it before the movement
 * (1044-1163), without changing the sim. Both axes read it; nothing in it depends on a speed.
 *   cx, cy (after the half-block rule), current, delayed, below, half (the half-block rule moved the centre tile),
 *   morx, mory (int, current), mox, moy (delayed, rotated, x gm), mx, my (input x sm, selected by delayed),
 *   modX, modY (the modifiers), slip (slippery after the tick's update), climb, liquidCur, boostCur, boostX, boostY
 *   (the boost override of that axis or null), kill (current kills this tick), jm, lev, dead, god.
 */
function envOf(sim, mask) {
	const L = sim.level, flags = sim._flags, W = sim.width;
	const god = sim.in_god_mode;
	let cx = Math.trunc(sim.px + 8.0) >> 4;
	let cy = Math.trunc(sim.py + 8.0) >> 4;
	let delayed = sim._q0;
	const q1 = sim._q1;
	let current = tileAt(sim, cx, cy);
	let half = false;
	if ((flags[current] & F_HALF) !== 0) {
		let rot = (cx >= 0 && cy >= 0 && cx < W && cy < sim.height) ? sim._lookup[cy * W + cx] : 0;
		if ((sim._xflags[current] & X_NONROT_HALF) !== 0) rot = 1;
		if (rot === 1) cy -= 1;
		if (rot === 0) cx -= 1;
		current = tileAt(sim, cx, cy);
		half = true;
	}
	const below = belowOf(sim, current, cx, cy);
	if (current === 4 || current === 414 || (flags[current] & F_CLIMB) !== 0) delayed = q1;
	const dead0 = sim.is_dead;
	const h = dead0 ? 0 : ((mask & 2 ? -1 : 0) + (mask & 4 ? 1 : 0));
	const v = dead0 ? 0 : ((mask & 8 ? -1 : 0) + (mask & 16 ? 1 : 0));
	let rotateMo = true, rotateMor = true, morx = 0, mory = 0, mox = 0.0, moy = 0.0, kill = false;
	if (!god) {
		const gfc = L.gFlags[current];
		morx = L.gMorx[current]; mory = L.gMory[current];
		rotateMor = (gfc & 1) !== 0;
		kill = (gfc & 4) !== 0 && !dead0 && !sim.is_invulnerable;
		mox = L.gMox[delayed]; moy = L.gMoy[delayed];
		rotateMo = (L.gFlags[delayed] & 2) !== 0;
	}
	switch (sim.flip_gravity) {
		case 1:
			if (rotateMo) { const t = mox; mox = -moy; moy = t; }
			if (rotateMor) { const it = morx; morx = 0 - mory; mory = it; }
			break;
		case 2:
			if (rotateMo) { mox = -mox; moy = -moy; }
			if (rotateMor) { morx = 0 - morx; mory = 0 - mory; }
			break;
		case 3:
			if (rotateMo) { const t = mox; mox = moy; moy = -t; }
			if (rotateMor) { const it = morx; morx = mory; mory = 0 - it; }
			break;
		case 4:
			if (rotateMo) { mox = 0.0; moy = 0.0; }
			if (rotateMor) { morx = 0; mory = 0; }
			break;
	}
	let mx, my;
	if ((flags[delayed] & F_LIQUID) !== 0) { mx = h; my = v; }
	else if (moy !== 0.0) { mx = h; my = 0.0; }
	else if (mox !== 0.0) { mx = 0.0; my = v; }
	else { mx = h; my = v; }
	let sm = 1.0;
	if (sim.speed_boost === 1) sm *= 1.5;
	if (sim.speed_boost === 2) sm *= 0.6;
	if (sim.is_zombie && !god) sm *= 0.6;
	mx *= sm;
	my *= sm;
	let gm = 1.0;
	if (sim.low_gravity) gm *= 0.15;
	gm *= sim.world_gravity_multiplier;
	mox *= gm;
	moy *= gm;
	const climb = (flags[current] & F_CLIMB) !== 0;
	let slip = sim._slippery;
	if (below === ICE_ID && !climb && current !== 4 && current !== 414) slip = 2.0;
	else if ((flags[below] & F_SOLID) !== 0) slip = 0.0;
	else if (slip > 0.0) slip -= 0.2;
	// jumpMultiplier reads the updated slippery (it is called in the jump section)
	let jm = 1.0;
	if (sim.jump_boost === 1) jm *= 1.3;
	if (sim.jump_boost === 2) jm *= 0.75;
	if (sim.is_zombie && !god) jm *= 0.75;
	if (slip > 0.0) jm *= 0.88;
	let boostX = null, boostY = null;
	if (!god) {
		if (current === SPEED_LEFT) boostX = -16.0;
		else if (current === SPEED_RIGHT) boostX = 16.0;
		else if (current === SPEED_UP) boostY = -16.0;
		else if (current === SPEED_DOWN) boostY = 16.0;
	}
	const portal = (current === PORTAL || current === PORTAL_INVISIBLE) ? L.portalSlot[cy * W + cx] : -1;
	return {
		cx, cy, current, delayed, below, half, h, v, jump: !dead0 && (mask & 1) !== 0,
		morx, mory, mox, moy, mx, my, modX: (mox + mx) / MULT, modY: (moy + my) / MULT,
		slip, climb, liquidCur: (flags[current] & F_LIQUID) !== 0 && !god, boostCur: (flags[current] & F_BOOST) !== 0,
		boostX, boostY, kill, jm, sm, gm, god, dead0, portal, multijump: current === EFFECT_MULTIJUMP,
	};
}

/**
 * The speed update of one axis (eesim.js 1164-1214, the X branch with (x, mx, moy) or the Y branch with (y, my, mox)).
 * v: the axis speed, mod: its modifier, m: its input (x sm), moO: the OTHER axis's delayed gravity (the drag condition
 * reads it: under vertical gravity a released horizontal key gets the no-modifier drag), env: slip, climb, current, god.
 */
function dragAxis(v, mod, m, moO, env) {
	if (v === 0.0 && mod === 0.0) return v;
	let s = v + mod;
	const god = env.god, cur = env.current, slip = env.slip;
	const opp = (s < 0.0 && m > 0.0) || (s > 0.0 && m < 0.0);
	if ((((m === 0.0 && moO !== 0.0) || opp) && (slip <= 0.0 || god)) || (env.climb && !god)) { s *= BASE; s *= NOMOD; }
	else if (cur === WATER && !god) { s *= BASE; s *= WATER_D; }
	else if (cur === MUD && !god) { s *= BASE; s *= MUD_D; }
	else if (cur === LAVA && !god) { s *= BASE; s *= LAVA_D; }
	else if (cur === TOXIC && !god) { s *= BASE; s *= TOXIC_D; }
	else if (slip > 0.0 && !god) {
		if (m !== 0.0 && !opp) s *= BASE;
		else s *= ICE_NM;
		if (opp) s *= ICE;
	} else s *= BASE;
	if (s > 16.0) s = 16.0;
	else if (s < -16.0) s = -16.0;
	else if (s < 0.0001 && s > -0.0001) s = 0.0;
	return s;
}

/**
 * One axis's sub-stepped movement with a 1D obstacle (eesim.js 1285-1352 restricted to one axis): the steps of the axis
 * in order, each probed with blocked(p) (true = the box at p overlaps something); the first blocked step restores the
 * position and ends the axis (its retries repeat the same failing step: obstacles sit on whole pixels, see the doc).
 * Returns {p, hit, probes} (probes: every probed position, in order). blocked may be null (free).
 */
function moveAxis(p, s, boostCur, blocked) {
	let rem = fmod1(p), cs = s;
	const probes = [];
	let hit = false;
	while (cs !== 0.0) {
		const op = p;
		if (cs > 0.0) {
			if (cs + rem >= 1.0) { p += (1.0 - rem); p = p | 0; cs -= (1.0 - rem); rem = 0.0; }
			else { p += cs; cs = 0.0; }
		} else {
			if (rem + cs < 0.0 && (rem !== 0.0 || boostCur)) { cs += rem; p -= rem; p = p | 0; rem = 1.0; }
			else { p += cs; cs = 0.0; }
		}
		probes.push(p);
		if (blocked !== null && blocked(p)) { p = op; hit = true; break; }
	}
	return { p, hit, probes };
}

/** The auto-align of one axis (eesim.js 1426-1459): v, mod its speed and modifier after the tick. Returns p. */
function alignAxis(p, v, mod, liquidCur) {
	if ((v >= 1.0 || v <= -1.0) || liquidCur) return p;
	if (!(mod < 0.1 && mod > -0.1)) return p;
	const t = fmod16(p);
	if (t < 2.0) {
		if (t < 0.2) p = p | 0;
		else p -= t / 15.0;
	} else if (t > 14.0) {
		if (t > 15.8) { p = p | 0; p += 1.0; }
		else p += (t - 14.0) / 15.0;
	}
	return p;
}

/** true when alignAxis would change p (the grid pull fires) */
function alignFires(p, v, mod, liquidCur) {
	return alignAxis(p, v, mod, liquidCur) !== p;
}

/**
 * The gravity-axis tail of the tick (eesim.js 1361-1424): jumpCount, the jump, the levitation thrust. Both axes are
 * given (the engine's statements read both), but for an axis-aligned gravity only the axis with mor != 0 changes:
 * a = {vx, vy, jc, thr, thrusting, grounded}, env, st = {maxJumps, lev}. Returns the new {vx, vy, jc, thr, thrusting}.
 */
function gravityTail(a, env, st) {
	let { vx, vy, jc, thr, thrusting } = a;
	const { morx, mory, mox, moy } = env;
	const grounded = a.grounded;
	let jumped = false;
	if (!env.dead0 && !a.deadNow) {
		const jump = env.jump;
		if (jump) {
			if (st.lev) { thrusting = true; thr = MAX_THRUST; }
		} else thrusting = false;
		if ((((vx === 0.0 && morx !== 0 && mox !== 0.0) || (vy === 0.0 && mory !== 0 && moy !== 0.0)) && grounded) || env.multijump) jc = 0;
		if (jc === 0 && !grounded) jc = 1;
		if (jump && !st.lev) {
			if (jc < st.maxJumps && morx !== 0 && mox !== 0.0) {
				if (st.maxJumps < 1000) jc += 1;
				vx = ((0 - morx) * JUMP_HEIGHT * env.jm) / MULT;
				jumped = true;
			}
			if (jc < st.maxJumps && mory !== 0 && moy !== 0.0) {
				if (st.maxJumps < 1000) jc += 1;
				vy = ((0 - mory) * JUMP_HEIGHT * env.jm) / MULT;
				jumped = true;
			}
		}
	}
	if (st.lev) {
		const t = thr;
		if (mory !== 0) vy = (vy * MULT - (t * THRUST_SCALE) * (mory * 0.5)) / MULT;
		if (morx !== 0) vx = (vx * MULT - (t * THRUST_SCALE) * (morx * 0.5)) / MULT;
		if (!thrusting) {
			if (thr > 0.0) thr -= THRUST_BURN_OFF;
			else thr = 0.0;
		}
	}
	return { vx, vy, jc, thr, thrusting, jumped };
}

module.exports = {
	MULT, BASE, NOMOD, ICE_NM, ICE, WATER_D, MUD_D, LAVA_D, TOXIC_D, JUMP_HEIGHT,
	F_SOLID, F_JUMPTHRU, F_ROTHALF, F_HALF, F_DOOR, F_CLIMB, F_LIQUID, F_BOOST, OV_AIR, OV_SOLID, OV_COMPLEX, OV_SECRET,
	fmod1, fmod16, tileAt, belowOf, envOf, dragAxis, moveAxis, alignAxis, alignFires, gravityTail,
};
