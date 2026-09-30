'use strict';
// src/plan/kin.js - THE EXACT PER-TICK RECURRENCES OF EE MOVEMENT (n4-math, derive / recurrences, 2026-09-30).
//
// Everybody Edits Offline's Player.tick (eeo-tas, as ported bit for bit by src/eesim.js _playerTick) written as pure
// functions of doubles: no engine object, no hidden state, every floating-point operation in the engine's order, so every
// value is the engine's to the last bit (IEEE doubles, never rounded, -0 kept where the engine keeps it). The maths, with
// the proofs and the exceptions, is docs/ee_math.md section 1; test/kin.js checks every function here against eesim.js.
//
// THE PIECES (one tick = these in this order; tick() composes them):
//   forces(cur, del, flip, god)          the pulls: int morx/mory from the current tile (what counts as floor, jumps),
//                                        double mox/moy from the delayed tile (the acceleration), rotated by flipGravity
//   axes(del, mox, moy, h, v)            which inputs act: mx, my (liquids both, vertical pull -> h only, ...)
//   speedMult(sb, zombie, god), gravMult(lowGravity, worldGravity)
//   modifier(mo, m)                      the per-tick acceleration (mo + m) / 7.752 (the public-setter round trip)
//   slipStep(slip, below, cur)           the ice timer
//   stepV(v, mod, m, moOther, slip, cur, god)   THE SPEED RECURRENCE of one axis (drag tree, cap 16, snap 1e-4)
//   stepX(vx, h, S) / stepY(vy, v, S)    the same with the surface / context object S of surface()
//   moveFree(p, v, boost)                one axis's sub-stepped position when no step collides
//   overlaps(st, W, x, y)                World.overlaps: the 16x16 box against the tiles (one-ways, half blocks, doors)
//   jumpSpeed(mor, jm), jumpMult(...)    the jump impulse
//   thrustStep(v, thr, mor)              levitation's getter / setter round trip
//   align(p, v, mod, liquid)             the auto-align to the 16 px grid
//   tick(st, mask, W)                    the whole Player.tick for a state st (fromSim / newState) in a world W
// All positions / speeds are px and px per tick (the engine's internal units; AS3's public speeds are x 7.752).

// ---------------------------------------------------------------- constants (Config.as, exact bits)
function hexToDouble(h) { return Buffer.from(h, 'hex').readDoubleLE(0); }
const MULT = 7.752;                                   // physics_variable_multiplyer
const BASE_DRAG = hexToDouble('6accf435f866ef3f');    // pow(.9981, 10) * 1.00016093 (MSVC pow: V8's differs)
const NO_MOD_DRAG = hexToDouble('1db5c8e6e3f1ec3f');  // pow(.99, 10) * 1.00016093
const WATER_DRAG = hexToDouble('8dffc581bf70ee3f');   // pow(.995, 10) * ...
const MUD_DRAG = hexToDouble('1bcd6139b7d8e83f');     // pow(.975, 10) * ...
const LAVA_DRAG = hexToDouble('b6e3faa08926ea3f');    // pow(.98, 10) * ...
const TOXIC_DRAG = hexToDouble('1db5c8e6e3f1ec3f');   // = NO_MOD_DRAG
const ICE_NO_MOD_DRAG = hexToDouble('fac64b3b25c8ef3f'); // pow(.9993, 10) * ...
const ICE_DRAG = hexToDouble('bebf054af2f0ef3f');     // pow(.9998, 10) * ...
const JUMP_HEIGHT = 26.0, GRAVITY = 2.0, IGRAVITY = 2, BOOST = 16.0;
const CAP = 16.0, SNAP = 0.0001;                      // speed cap and the snap to 0
const WATER_BUOYANCY = -0.5, MUD_BUOYANCY = 0.4, LAVA_BUOYANCY = 0.2, TOXIC_BUOYANCY = -0.4;
const MAX_THRUST = 0.2, THRUST_BURN_OFF = 0.01, THRUST_SCALE = JUMP_HEIGHT / 2;
const MAGIC = 1.42;                                   // the portal's speed factor when it rotates
// Derived (each the engine's own double; docs/ee_math.md 1.2)
const G = GRAVITY / MULT;       // 0.2579979360165119: gravity's pull per tick (px / tick^2) at gm = 1
const A = 1 / MULT;             // 0.12899896800825594: one direction key per tick at sm = 1

// ---------------------------------------------------------------- block ids and flags (ItemId.as; = eesim.js tables)
const WATER = 119, MUD = 369, LAVA = 416, TOXIC = 1585, FIRE = 368, ICE = 1064;
const PORTAL = 242, PORTAL_INV = 381;
const SPEED_LEFT = 114, SPEED_RIGHT = 115, SPEED_UP = 116, SPEED_DOWN = 117;
const DOT = 4, DOT_INV = 414, MULTIJUMP = 461;
const COIN_GOLD = 100, COIN_BLUE = 101, CHECKPOINT = 360;
const EFFECT_JUMP = 417, EFFECT_FLY = 418, EFFECT_RUN = 419, EFFECT_PROTECTION = 420, EFFECT_LOW_GRAVITY = 453;
const EFFECT_CURSE = 421, EFFECT_ZOMBIE = 422, EFFECT_POISON = 1584, NPC_ZOMBIE = 1573, EFFECT_GRAVITY = 1517, EFFECT_RESET = 1618;
const CLIMBABLE_IDS = [120, 118, 98, 99, 424, 459, 460, 472, 1534, 1146, 1563, 1602];
const SPIKE_IDS = [361, 1580, 1625, 1626, 1627, 1628, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636];
const JUMP_THROUGH_IDS = [61, 62, 63, 64, 89, 90, 91, 96, 97, 122, 123, 124, 125, 126, 127, 146, 154, 158,
	194, 211, 216, 1069, 1087, 1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1050, 1051, 1164,
	1165, 1147, 1148, 1149, 1155, 1160];
const ROT_HALF_IDS = [1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1155];
const HALF_IDS = [1041, 1042, 1043, 1075, 1076, 1077, 1078, 1101, 1102, 1103, 1104, 1105, 1116, 1117, 1118,
	1119, 1120, 1121, 1122, 1123, 1124, 1125, 1140, 1141];
const NONROT_HALF_IDS = [1101, 1102, 1103, 1104, 1105];
const DOOR_IDS = [23, 24, 25, 26, 27, 28, 1005, 1006, 1007, 1008, 1009, 1010, 156, 157, 184, 185, 1079, 1080,
	200, 201, 1094, 1095, 1152, 1153, 43, 213, 1011, 165, 214, 1012, 1027, 1028, 206, 207, 50];
// flag bits (the first 8 = eesim.js F_*, then its X_* shifted by 8)
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const F_KILL = 256, F_NONROT_HALF = 1024;

let FL = new Int32Array(0);                 // flags per id, grown on demand
let GMORX = new Int8Array(0), GMORY = new Int8Array(0), GMOX = new Float64Array(0), GMOY = new Float64Array(0);
let GF = new Uint8Array(0);                 // 1 rotate_mor, 2 rotate_mo, 4 kill
function buildTables(n) {
	const inS = (a) => { const s = new Set(a); return (id) => s.has(id); };
	const climb = inS(CLIMBABLE_IDS), jt = inS(JUMP_THROUGH_IDS), rh = inS(ROT_HALF_IDS), hf = inS(HALF_IDS);
	const dr = inS(DOOR_IDS), sp = inS(SPIKE_IDS), nr = inS(NONROT_HALF_IDS);
	const fl = new Int32Array(n);
	const gmorx = new Int8Array(n), gmory = new Int8Array(n), gmox = new Float64Array(n), gmoy = new Float64Array(n);
	const gf = new Uint8Array(n);
	for (let id = 0; id < n; id++) {
		let f = 0;
		const c = climb(id);
		// ItemId.isSolid (ItemId.as:366-372)
		if (!c && ((9 <= id && id <= 97) || (122 <= id && id <= 217) || (id >= 1001 && id <= 1499)) && id !== 83 && id !== 77) f |= F_SOLID;
		if (c) f |= F_CLIMB;
		if (jt(id)) f |= F_JUMPTHRU;
		if (rh(id)) f |= F_ROTHALF;
		if (hf(id)) f |= F_HALF;
		if (dr(id)) f |= F_DOOR;
		if (id === WATER || id === MUD || id === LAVA || id === TOXIC) f |= F_LIQUID;
		if (id >= SPEED_LEFT && id <= SPEED_DOWN) f |= F_BOOST;
		if (id === FIRE || sp(id)) f |= F_KILL;
		if (nr(id)) f |= F_NONROT_HALF;
		fl[id] = f;
		// the two gravity switches of Player.tick (Player.as:461-638): current -> morx, mory (int), delayed -> mox, moy
		let morx = 0, mory = 0, rmor = true, kill = false, mox = 0.0, moy = 0.0, rmo = true;
		if (c) { morx = 0; mory = 0; mox = 0.0; moy = 0.0; }
		else {
			switch (id) {
				case 1: case 411: morx = -IGRAVITY; rmor = false; mox = -GRAVITY; rmo = false; break;
				case 2: case 412: mory = -IGRAVITY; rmor = false; moy = -GRAVITY; rmo = false; break;
				case 3: case 413: morx = IGRAVITY; rmor = false; mox = GRAVITY; rmo = false; break;
				case 1518: case 1519: mory = IGRAVITY; rmor = false; moy = GRAVITY; rmo = false; break;
				case SPEED_LEFT: case SPEED_RIGHT: case SPEED_UP: case SPEED_DOWN: case DOT: case DOT_INV: break;
				case WATER: mory = Math.trunc(WATER_BUOYANCY) + 0; moy = WATER_BUOYANCY; break;   // int(-0.5) = 0
				case MUD: mory = Math.trunc(MUD_BUOYANCY) + 0; moy = MUD_BUOYANCY; break;
				case LAVA: mory = Math.trunc(LAVA_BUOYANCY) + 0; moy = LAVA_BUOYANCY; break;
				case TOXIC: mory = Math.trunc(TOXIC_BUOYANCY) + 0; kill = true; moy = TOXIC_BUOYANCY; break;
				default: mory = IGRAVITY; moy = GRAVITY; if ((f & F_KILL) !== 0) kill = true;
			}
		}
		gmorx[id] = morx; gmory[id] = mory; gmox[id] = mox; gmoy[id] = moy;
		gf[id] = (rmor ? 1 : 0) | (rmo ? 2 : 0) | (kill ? 4 : 0);
	}
	FL = fl; GMORX = gmorx; GMORY = gmory; GMOX = gmox; GMOY = gmoy; GF = gf;
}
buildTables(4096);
function need(id) { if (id >= FL.length) buildTables(Math.max(id + 1, FL.length * 2)); }
/** the flag bits of a block id (F_* above) */
function flagsOf(id) { need(id); return FL[id]; }
const isClimb = (id) => (flagsOf(id) & F_CLIMB) !== 0;
const isLiquid = (id) => (flagsOf(id) & F_LIQUID) !== 0;
const isSolid = (id) => (flagsOf(id) & F_SOLID) !== 0;
/** the gravity queue shortens to 1 tick in dots and climbables (Player.as:442-447) */
const isImmediate = (id) => id === DOT || id === DOT_INV || isClimb(id);

// ---------------------------------------------------------------- AS3 helpers the engine uses (exact)
/** fmod(x, 1) for x >= 0 (x - trunc(x) is exact: Sterbenz); % (IEEE fmod) otherwise */
function fmod1(x) { return x > 0.0 ? x - Math.trunc(x) : x % 1.0; }
/** fmod(x, 16) (exact the same way) */
function fmod16(x) { return x > 0.0 ? x - 16.0 * Math.floor(x * 0.0625) : x % 16.0; }

// ---------------------------------------------------------------- 1 the pulls (Player.as:461-690)
/**
 * forces(cur, del, flip, god, out): out.morx, out.mory (ints: the current tile's pull: floor side, jumps; kills),
 * out.mox, out.moy (doubles: the delayed tile's pull, the acceleration before the gravity multiplier), out.kill (the
 * current tile kills a live, unprotected ball), after flipGravity's rotation of the pairs whose rotate flag holds
 * (arrows keep their direction). Returns out.
 */
function forces(cur, del, flip, god, out) {
	need(cur > del ? cur : del);
	let morx = 0, mory = 0, mox = 0.0, moy = 0.0, rMor = true, rMo = true, kill = false;
	if (!god) {
		const gc = GF[cur];
		morx = GMORX[cur]; mory = GMORY[cur];
		rMor = (gc & 1) !== 0; kill = (gc & 4) !== 0;
		mox = GMOX[del]; moy = GMOY[del];
		rMo = (GF[del] & 2) !== 0;
	}
	switch (flip) {
		case 1:
			if (rMo) { const t = mox; mox = -moy; moy = t; }
			if (rMor) { const it = morx; morx = 0 - mory; mory = it; }
			break;
		case 2:
			if (rMo) { mox = -mox; moy = -moy; }
			if (rMor) { morx = 0 - morx; mory = 0 - mory; }
			break;
		case 3:
			if (rMo) { const t = mox; mox = moy; moy = -t; }
			if (rMor) { const it = morx; morx = mory; mory = 0 - it; }
			break;
		case 4:
			if (rMo) { mox = 0.0; moy = 0.0; }
			if (rMor) { morx = 0; mory = 0; }
			break;
	}
	out.morx = morx; out.mory = mory; out.mox = mox; out.moy = moy; out.kill = kill;
	return out;
}

/**
 * axes(del, mox, moy, h, v, out): the inputs that act (Player.as:692-707): liquids (the delayed tile) both axes; a
 * vertical pull (moy != 0) only h; a horizontal pull only v; no pull (dots, climbables, boosts, flip 4) both.
 * h = left/right in {-1, 0, 1}, v = up/down. out.mx, out.my (before the speed multiplier).
 */
function axes(del, mox, moy, h, v, out) {
	if (isLiquid(del)) { out.mx = h; out.my = v; }
	else if (moy !== 0.0) { out.mx = h; out.my = 0.0; }
	else if (mox !== 0.0) { out.mx = 0.0; out.my = v; }
	else { out.mx = h; out.my = v; }
	return out;
}

/** speedMultiplier (Player.as:363-369), in the engine's order */
function speedMult(sb, zombie, god) {
	let sm = 1.0;
	if (sb === 1) sm *= 1.5;
	if (sb === 2) sm *= 0.6;
	if (zombie && !god) sm *= 0.6;
	return sm;
}
/** gravityMultiplier (Player.as:347-352): low gravity x0.15, then the level's float32 gravity as a double */
function gravMult(lowGravity, worldGravity) {
	let gm = 1.0;
	if (lowGravity) gm *= 0.15;
	gm *= worldGravity;
	return gm;
}
/** jumpMultiplier (Player.as:354-361), in the engine's order; slip = the ice timer after this tick's update */
function jumpMult(jb, zombie, god, slip) {
	let jm = 1.0;
	if (jb === 1) jm *= 1.3;
	if (jb === 2) jm *= 0.75;
	if (zombie && !god) jm *= 0.75;
	if (slip > 0.0) jm *= 0.88;
	return jm;
}
/** the per-tick acceleration of an axis: this.modifierX = mox + mx through the public setter (/ 7.752) */
function modifier(mo, m) { return (mo + m) / MULT; }

/**
 * slipStep(slip, below, cur): the ice timer (Player.as:717-723): 2 while the tile below (in the pull's direction,
 * current_below) is ice (not in a climbable or a dot), 0 over any other solid, else -0.2 a tick while > 0 (the float
 * steps 1.8, 1.6, 1.4000000000000001, ..., 2.7755575615628914e-16, -0.19999999999999973: 11 ticks > 0 after ice).
 */
function slipStep(slip, below, cur) {
	if (below === ICE && !isClimb(cur) && cur !== DOT && cur !== DOT_INV) return 2.0;
	if (isSolid(below)) return 0.0;
	if (slip > 0.0) return slip - 0.2;
	return slip;
}
/** current_below's offset (Player.as:423-440): the duplicate case labels make 413, 414, 1518, 1519 use flipGravity */
function belowDir(cur, flip) {
	switch (cur) {
		case 1: case 411: return [-1, 0];
		case 2: case 412: return [0, -1];
		case 3: return [1, 0];
		case 4: return [0, 1];
		default:
			switch (flip) { case 0: return [0, 1]; case 1: return [-1, 0]; case 2: return [0, -1]; default: return [1, 0]; }
	}
}

// ---------------------------------------------------------------- 2 THE SPEED RECURRENCE (Player.as:725-805)
/**
 * stepV(v, mod, m, moOther, slip, cur, god): one axis's speed after this tick's acceleration and drag, BEFORE the
 * boosts' override and the dead freeze (stepX / stepY add those):
 *   if v == 0 and mod == 0: v (untouched: the engine skips the block)
 *   s = v + mod;  opp = (s < 0 and m > 0) or (s > 0 and m < 0)          (the NEW speed against the held key)
 *   s *= BASE_DRAG * NO_MOD_DRAG   (two roundings) if ((m == 0 and moOther != 0) or opp) and no ice, or in a climbable
 *   else s *= BASE * WATER | MUD | LAVA | TOXIC                          (the current tile's liquid)
 *   else on ice (slip > 0): (m != 0 and not opp ? BASE : ICE_NO_MOD), then x ICE if opp
 *   else s *= BASE
 *   then clamp to [-16, 16], and |s| < 1e-4 -> +0.
 * For X: v = speed_x, mod = modifierX, m = mx, moOther = moy; for Y: speed_y, modifierY, my, mox.
 */
function stepV(v, mod, m, moOther, slip, cur, god) {
	if (v !== 0.0 || mod !== 0.0) {
		let s = v + mod;
		if (((((m === 0.0 && moOther !== 0.0) || (s < 0.0 && m > 0.0) || (s > 0.0 && m < 0.0)) && (slip <= 0.0 || god)) || (isClimb(cur) && !god))) {
			s *= BASE_DRAG;
			s *= NO_MOD_DRAG;
		} else if (cur === WATER && !god) {
			s *= BASE_DRAG; s *= WATER_DRAG;
		} else if (cur === MUD && !god) {
			s *= BASE_DRAG; s *= MUD_DRAG;
		} else if (cur === LAVA && !god) {
			s *= BASE_DRAG; s *= LAVA_DRAG;
		} else if (cur === TOXIC && !god) {
			s *= BASE_DRAG; s *= TOXIC_DRAG;
		} else if (slip > 0.0 && !god) {
			if (m !== 0.0 && !((s < 0.0 && m > 0.0) || (s > 0.0 && m < 0.0))) s *= BASE_DRAG;
			else s *= ICE_NO_MOD_DRAG;
			if ((s < 0.0 && m > 0.0) || (s > 0.0 && m < 0.0)) s *= ICE_DRAG;
		} else {
			s *= BASE_DRAG;
		}
		if (s > CAP) s = CAP;
		else if (s < -CAP) s = -CAP;
		else if (s < SNAP && s > -SNAP) s = 0.0;
		return s;
	}
	return v;
}

/**
 * surface(o): the tick's context S for stepX / stepY from what the tiles and effects say: o {cur (the current tile,
 * after the half-block shift), del (the delayed tile), below (current_below), flip, slip (the ice timer BEFORE this
 * tick), sb, zombie, lowGravity, worldGravity (1 in every campaign level), god, dead}. S {morx, mory, mox, moy (x the
 * gravity multiplier), sm, gm, slip (after this tick's update), cur, del, god, dead, kill, liquidCur}.
 */
function surface(o, S) {
	S = S || {};
	const god = !!o.god;
	forces(o.cur, o.del, o.flip | 0, god, S);
	S.sm = speedMult(o.sb | 0, !!o.zombie, god);
	S.gm = gravMult(!!o.lowGravity, o.worldGravity === undefined ? 1.0 : o.worldGravity);
	S.mox *= S.gm; S.moy *= S.gm;
	S.slip = slipStep(o.slip === undefined ? 0.0 : o.slip, o.below === undefined ? 0 : o.below, o.cur);
	S.cur = o.cur; S.del = o.del; S.god = god; S.dead = !!o.dead;
	S.liquidCur = isLiquid(o.cur) && !god;
	return S;
}
/**
 * stepX(vx, h, S): speed_x after this tick's speed update (before the move) for the horizontal input h in {-1, 0, 1}:
 * stepV with mx = h x sm when the x axis takes input (axes()), then the boost tiles' override (114 -> -16, 115 -> 16)
 * and the dead freeze. Also sets S.modX (the tick's modifierX, which the auto-align reads).
 */
function stepX(vx, h, S) {
	const ax = axes(S.del, S.mox, S.moy, h, 0, _ax);
	const mx = ax.mx * S.sm;
	const mod = (S.mox + mx) / MULT;
	S.mx = mx; S.modX = mod;
	let s = stepV(vx, mod, mx, S.moy, S.slip, S.cur, S.god);
	if (!S.god) {
		if (S.cur === SPEED_LEFT) s = -BOOST; else if (S.cur === SPEED_RIGHT) s = BOOST;
		if (S.dead) s = 0.0;
	}
	return s;
}
/** stepY(vy, v, S): speed_y the same way for the vertical input v in {-1 up, 0, 1 down} (116 -> -16, 117 -> 16) */
function stepY(vy, v, S) {
	const ax = axes(S.del, S.mox, S.moy, 0, v, _ax);
	const my = ax.my * S.sm;
	const mod = (S.moy + my) / MULT;
	S.my = my; S.modY = mod;
	let s = stepV(vy, mod, my, S.mox, S.slip, S.cur, S.god);
	if (!S.god) {
		if (S.cur === SPEED_UP) s = -BOOST; else if (S.cur === SPEED_DOWN) s = BOOST;
		if (S.dead) s = 0.0;
	}
	return s;
}
const _ax = { mx: 0, my: 0 };

// ---------------------------------------------------------------- 3 the position (Player.as:833-935)
/**
 * moveFree(p, v, boost): one axis's position after the tick's sub-steps when no step collides (the x and y steps
 * interleave, but with overlaps() == 0 each axis only touches its own p, rem, cs: separable). rem = fmod(p, 1):
 *   v > 0: to the next integer (p += 1 - rem, truncated), then 1 px steps, then the fraction (p += c)
 *   v < 0: from a fractional p (rem != 0) or on a boost tile: to the integer below (p -= rem, truncated), 1 px steps
 *          (rem = 1), then the fraction; from an INTEGER p off a boost: the whole distance in one add (p += v)
 * The fraction's add rounds to p's binade: the result is NOT p + v in general (docs/ee_math.md 1.5).
 */
function moveFree(p, v, boost) {
	let r = fmod1(p), c = v;
	while (c !== 0.0) {
		if (c > 0.0) {
			if (c + r >= 1.0) { p += (1.0 - r); p = p | 0; c -= (1.0 - r); r = 0.0; } else { p += c; c = 0.0; }
		} else {
			if (r + c < 0.0 && (r !== 0.0 || boost)) { c += r; p -= r; p = p | 0; r = 1.0; } else { p += c; c = 0.0; }
		}
	}
	return p;
}
/** the positions moveFree visits (after each sub-step), for sweeps: [p1, p2, ..., p_end] */
function subSteps(p, v, boost) {
	const out = [];
	let r = fmod1(p), c = v;
	while (c !== 0.0) {
		if (c > 0.0) {
			if (c + r >= 1.0) { p += (1.0 - r); p = p | 0; c -= (1.0 - r); r = 0.0; } else { p += c; c = 0.0; }
		} else {
			if (r + c < 0.0 && (r !== 0.0 || boost)) { c += r; p -= r; p = p | 0; r = 1.0; } else { p += c; c = 0.0; }
		}
		out.push(p);
	}
	return out;
}

/**
 * align(p, v, mod, liquid): the auto-align (Player.as:1003-1042) of one axis after the move, the jump and the thrust:
 * none when |v| >= 1 (int(v * 256) != 0 exactly then) or the current tile is a liquid; else when |mod| < 0.1:
 * t = p mod 16; t < 0.2 -> trunc(p); t < 2 -> p - t / 15; t > 15.8 -> trunc(p) + 1; t > 14 -> p + (t - 14) / 15.
 */
function align(p, v, mod, liquid) {
	if ((v >= 1.0 || v <= -1.0) || liquid) return p;
	if (!(mod < 0.1 && mod > -0.1)) return p;
	const t = fmod16(p);
	if (t < 2.0) return t < 0.2 ? (p | 0) : p - t / 15.0;
	if (t > 14.0) {
		if (t > 15.8) { p = p | 0; return p + 1.0; }
		return p + (t - 14.0) / 15.0;
	}
	return p;
}

/** the jump's speed on an axis: this.speedX = -morx * 26 * jumpMultiplier (setter: / 7.752), in that order */
function jumpSpeed(mor, jm) { return ((0 - mor) * JUMP_HEIGHT * jm) / MULT; }
/** levitation's thrust (updateThrust, Player.as:1846-1861): speed = (speed x 7.752 - thr x 13 x (mor x 0.5)) / 7.752 */
function thrustStep(v, thr, mor) { return (v * MULT - (thr * THRUST_SCALE) * (mor * 0.5)) / MULT; }
/** the portal's speed / modifier transform for a rotation difference dir (Player.as:1113-1136): [vx', vy'] */
function portalTurn(dir, vx, vy) {
	const ox = vx * MULT, oy = vy * MULT;
	switch (dir) {
		case 1: return [(oy * MAGIC) / MULT, (-ox * MAGIC) / MULT];
		case 2: return [(-ox * MAGIC) / MULT, (-oy * MAGIC) / MULT];
		case 3: return [(-oy * MAGIC) / MULT, (ox * MAGIC) / MULT];
	}
	return [vx, vy];
}

// ---------------------------------------------------------------- 4 collision: World.overlaps (World.as:604-751)
/**
 * overlaps(st, W, x, y): the first blocking tile under the 16 x 16 box at (x, y) (1 outside the world), 0 when free;
 * its side effects on the one-way memory st.oa..st.od exactly as the engine's (the reveal of secrets has no physics).
 * One-ways read st.vx, st.vy (their signs: the engine's speed at the call) and st.ox, st.oy (the sub-step's start);
 * doors ask W.doorOpen(id, cx, cy, st). Scan: rows oy .. (the row of y + 16 when it passes a tile edge), columns alike.
 */
function overlaps(st, W, x, y) {
	if (x < 0.0 || y < 0.0 || x > W.maxX || y > W.maxY) return 1;
	if (st.god) return 0;
	const ox = (x | 0) >> 4, oy = (y | 0) >> 4;
	const cxEnd = ox + 1 + ((x + 16.0) > (ox * 16 + 16) ? 1 : 0);
	const cyEnd = oy + 1 + ((y + 16.0) > (oy * 16 + 16) ? 1 : 0);
	let skipa = false, skipb = false, skipc = false, skipd = false;
	for (let cy = oy; cy < cyEnd; cy++) {
		for (let cx = ox; cx < cxEnd; cx++) {
			const val = W.tile(cx, cy);
			const fl = flagsOf(val);
			if ((fl & F_SOLID) === 0) continue;
			const tlx = cx * 16, tly = cy * 16;
			if ((fl & (F_ROTHALF | F_HALF | F_JUMPTHRU)) !== 0) {
				const rot = W.lookup(cx, cy);
				if ((fl & F_ROTHALF) !== 0) {
					if ((fl & F_JUMPTHRU) !== 0) {
						if ((st.vy < 0.0 || cy <= st.oa || (st.vy === 0.0 && st.vx === 0.0 && (st.oy + 15.0) > tly)) && rot === 1) {
							if (cy !== oy || st.oa === -1) st.oa = cy;
							skipa = true; continue;
						}
						if ((st.vx > 0.0 || (cx <= st.ob && st.vx <= 0.0 && st.ox < tlx + 16.0)) && rot === 2) {
							if (cx !== ox || st.ob === -1) st.ob = cx;
							skipb = true; continue;
						}
						if ((st.vy > 0.0 || (cy <= st.oc && st.vy <= 0.0 && st.oy < tly + 16.0)) && rot === 3) {
							if (cy !== oy || st.oc === -1) st.oc = cy;
							skipc = true; continue;
						}
						if ((st.vx < 0.0 || cx <= st.od || (st.vy === 0.0 && st.vx < 0.0 && (st.ox - 15.0) < tlx)) && rot === 0) {
							if (cx !== ox || st.od === -1) st.od = cx;
							skipd = true; continue;
						}
					}
				} else if ((fl & F_HALF) !== 0) {
					if (rot === 1) { if (!rectHit(x, y, tlx, tly + 8.0, 16.0, 8.0)) continue; }
					else if (rot === 2) { if (!rectHit(x, y, tlx, tly, 8.0, 16.0)) continue; }
					else if (rot === 3) { if (!rectHit(x, y, tlx, tly, 16.0, 8.0)) continue; }
					else if (rot === 0) { if (!rectHit(x, y, tlx + 8.0, tly, 8.0, 16.0)) continue; }
				} else if (st.vy < 0.0 || cy <= st.oa || (st.vy === 0.0 && st.vx === 0.0 && (st.oy + 15.0) > tly)) {
					if (cy !== oy || st.oa === -1) st.oa = cy;
					skipa = true; continue;
				}
			}
			if ((fl & F_DOOR) !== 0 && val !== 50 && W.doorOpen(val, cx, cy, st)) continue;
			return val;
		}
	}
	if (!skipa) st.oa = -1;
	if (!skipb) st.ob = -1;
	if (!skipc) st.oc = -1;
	if (!skipd) st.od = -1;
	return 0;
}
function rectHit(x, y, rx, ry, rw, rh) { return x < rx + rw && rx < x + 16.0 && y < ry + rh && ry < y + 16.0; }

// ---------------------------------------------------------------- 5 the whole tick
/**
 * newState(o): a kin state (every field Player.tick reads or writes that moves the ball). fromSim(sim) reads one from
 * an EESim (a read, no engine code runs).
 */
function newState(o = {}) {
	const st = {
		px: 16.0, py: 16.0, vx: 0.0, vy: 0.0, modX: 0.0, modY: 0.0,
		q0: 0, q1: 0, slip: 0.0, cur: 0,
		jc: 0, maxJ: 1, jb: 0, sb: 0, lowg: false, flip: 0, wg: 1.0,
		lev: false, thrusting: false, thr: 0.0, inv: false, god: false,
		dead: false, deadOff: 0.0, deaths: 0, onGround: false,
		cursed: false, curseStart: 0, curseDur: 0.0, zombie: false, zombieStart: 0, zombieDur: 0.0,
		poison: false, poisonStart: 0, poisonDur: 0.0, fire: false, fireStart: 0.0, fireDur: 0.0,
		lastPortal: true, ox: 0.0, oy: 0.0, oa: -1, ob: -1, oc: -1, od: -1,
		pastx: 0, pasty: 0, cpx: -1, cpy: -1, nextSpawn: 0, ticks: 0, timedoor: false, grounded: false,
		mor:{ morx: 0, mory: 0, mox: 0.0, moy: 0.0, kill: false },
	};
	return Object.assign(st, o);
}
function fromSim(s) {
	return newState({
		px: s.px, py: s.py, vx: s.speed_x, vy: s.speed_y, modX: s.modifier_x, modY: s.modifier_y,
		q0: s._q0, q1: s._q1, slip: s._slippery, cur: s._current,
		jc: s.jump_count, maxJ: s.max_jumps, jb: s.jump_boost, sb: s.speed_boost, lowg: s.low_gravity, flip: s.flip_gravity,
		wg: s.world_gravity_multiplier, lev: s.has_levitation, thrusting: s.is_thrusting, thr: s._current_thrust,
		inv: s.is_invulnerable, god: s.in_god_mode, dead: s.is_dead, deadOff: s._dead_offset, deaths: s.deaths,
		onGround: s.on_ground,
		cursed: s.is_cursed, curseStart: s._curse_time_start, curseDur: s._curse_duration,
		zombie: s.is_zombie, zombieStart: s._zombie_time_start, zombieDur: s._zombie_duration,
		poison: s.is_poisoned, poisonStart: s._poison_time_start, poisonDur: s._poison_duration,
		fire: s.is_on_fire, fireStart: s._fire_time_start, fireDur: s._fire_duration,
		lastPortal: s._last_portal_set, ox: s._ox, oy: s._oy, oa: s.overlapa, ob: s.overlapb, oc: s.overlapc, od: s.overlapd,
		pastx: s._pastx, pasty: s._pasty, cpx: s.checkpoint.x, cpy: s.checkpoint.y, nextSpawn: s._next_spawn, ticks: s._ticks,
		timedoor: s._timedoor_state, grounded: s._grounded,
	});
}
/** the fields tick() maintains, as a list (for comparisons) */
const FIELDS = ['px', 'py', 'vx', 'vy', 'modX', 'modY', 'q0', 'q1', 'slip', 'cur', 'jc', 'maxJ', 'jb', 'sb', 'lowg', 'flip',
	'lev', 'thrusting', 'thr', 'inv', 'dead', 'deadOff', 'deaths', 'onGround', 'cursed', 'zombie', 'poison', 'fire',
	'lastPortal', 'ox', 'oy', 'oa', 'ob', 'oc', 'od', 'pastx', 'pasty', 'cpx', 'cpy', 'nextSpawn', 'ticks', 'timedoor', 'grounded'];

/**
 * tick(st, mask, W): one eeo-tas tick (PlayState.tick's clock and gate calls + Player.tick) of the state st in place,
 * for the input mask (1 jump, 2 left, 4 right, 8 up, 16 down; replay semantics: every tick with the jump bit is a fresh
 * press). W (makeWorld, or the harness's): width, height, maxX, maxY, tile(cx, cy), lookup(cx, cy),
 * doorOpen(id, cx, cy, st), portal(cx, cy) -> {id, target, rot} | null, exit(P, st) -> {x, y, rot} | null,
 * spawn(st) -> [tx, ty] (placeAtSpawn without a checkpoint; advances st.nextSpawn), and optionally coin(st, cx, cy, id)
 * and touch(st, cx, cy, id) for the touches that change the world (coins, keys, switches, crowns, team; not physics).
 * Returns st. st.grounded = the move hit the floor this tick.
 */
function tick(st, mask, W) {
	st.ticks++;
	// PlayState.tick's three coin / blue coin / death gate overlaps() at the box (their one-way memory side effects)
	overlaps(st, W, st.px, st.py); overlaps(st, W, st.px, st.py); overlaps(st, W, st.px, st.py);
	// World.update: the time doors' state for this tick (156 open, 157 shut from tick 500 of every 1000); keys expire
	// here too (the world's business: W.doorOpen)
	st.timedoor = (st.ticks % 1000) >= 500;
	const god = st.god;
	// 4.1 dead offset and the timed kills
	if (st.dead) st.deadOff += 0.3; else st.deadOff = 0.0;
	if (!st.dead && (st.cursed || st.zombie || st.fire || st.poison)) {
		const t = st.ticks;
		if (st.cursed && st.curseDur !== 0.0 && t - st.curseStart > st.curseDur) kill(st);
		if (st.zombie && !god && st.zombieDur !== 0.0 && t - st.zombieStart > st.zombieDur) kill(st);
		if (st.fire && st.fireDur !== 0.0 && t - st.fireStart > st.fireDur) kill(st);
		if (st.poison && !god && st.poisonDur !== 0.0 && t - st.poisonStart > st.poisonDur) kill(st);
	}
	// 4.2 the centre tile, the gravity queue, half blocks
	let cx = Math.trunc(st.px + 8.0) >> 4, cy = Math.trunc(st.py + 8.0) >> 4;
	let del = st.q0;
	st.q0 = st.q1;
	let cur = W.tile(cx, cy);
	if ((flagsOf(cur) & F_HALF) !== 0) {
		let rot = W.lookup(cx, cy);
		if ((flagsOf(cur) & F_NONROT_HALF) !== 0) rot = 1;
		if (rot === 1) cy -= 1;
		if (rot === 0) cx -= 1;
		cur = W.tile(cx, cy);
	}
	st.cur = cur;
	const bd = belowDir(cur, st.flip);
	const below = W.tile(cx + bd[0], cy + bd[1]);
	st.q1 = cur;
	if (isImmediate(cur)) { del = st.q0; st.q0 = st.q1; st.q1 = cur; }
	// 4.7-4.8 input
	const jumpBit = (mask & 1) !== 0;
	let h = ((mask & 2) !== 0 ? -1 : 0) + ((mask & 4) !== 0 ? 1 : 0);
	let v = ((mask & 8) !== 0 ? -1 : 0) + ((mask & 16) !== 0 ? 1 : 0);
	let space = jumpBit;
	if (st.dead) { space = false; h = 0; v = 0; }
	// 4.9-4.13 pulls, axes, multipliers, modifiers
	const M = forces(cur, del, st.flip, god, st.mor);
	if (M.kill && !st.dead && !st.inv) kill(st);
	let mx, my;
	if (isLiquid(del)) { mx = h; my = v; }
	else if (M.moy !== 0.0) { mx = h; my = 0.0; }
	else if (M.mox !== 0.0) { mx = 0.0; my = v; }
	else { mx = h; my = v; }
	const sm = speedMult(st.sb, st.zombie, god);
	mx *= sm; my *= sm;
	const gm = gravMult(st.lowg, st.wg);
	const mox = M.mox * gm, moy = M.moy * gm;
	M.mox = mox; M.moy = moy;
	st.modX = (mox + mx) / MULT;
	st.modY = (moy + my) / MULT;
	// 4.14 ice
	st.slip = slipStep(st.slip, below, cur);
	// 4.15 THE SPEED RECURRENCES
	st.vx = stepV(st.vx, st.modX, mx, moy, st.slip, cur, god);
	st.vy = stepV(st.vy, st.modY, my, mox, st.slip, cur, god);
	// 4.16 boosts and the dead freeze
	if (!god) {
		switch (cur) {
			case SPEED_LEFT: st.vx = -BOOST; break;
			case SPEED_RIGHT: st.vx = BOOST; break;
			case SPEED_UP: st.vy = -BOOST; break;
			case SPEED_DOWN: st.vy = BOOST; break;
		}
		if (st.dead) { st.vx = 0.0; st.vy = 0.0; }
	}
	// 4.17-4.18 the sub-stepped move and the portal
	let remx = fmod1(st.px), csx = st.vx, remy = fmod1(st.py), csy = st.vy;
	let grounded = false;
	if (csx !== 0.0 || csy !== 0.0) {
		const P = (cur === PORTAL || cur === PORTAL_INV) ? W.portal(cx, cy) : null;
		if (god || P === null || P.target === P.id) st.lastPortal = false;
		else if (!st.lastPortal) {
			st.lastPortal = true;
			const ex = W.exit(P, st);
			if (ex !== null) {
				let oldRot = P.rot;
				const newRot = ex.rot;
				if (oldRot < newRot) oldRot += 4;
				const osx = st.vx * MULT, osy = st.vy * MULT, omx = st.modX * MULT, omy = st.modY * MULT;
				switch (oldRot - newRot) {
					case 1:
						st.vx = (osy * MAGIC) / MULT; st.vy = (-osx * MAGIC) / MULT;
						st.modX = (omy * MAGIC) / MULT; st.modY = (-omx * MAGIC) / MULT;
						remy = -remx; csy = -csx;
						break;
					case 2:
						st.vx = (-osx * MAGIC) / MULT; st.vy = (-osy * MAGIC) / MULT;
						st.modX = (-omx * MAGIC) / MULT; st.modY = (-omy * MAGIC) / MULT;
						remy = -remy; csy = -csy; remx = -remx; csx = -csx;
						break;
					case 3:
						st.vx = (-osy * MAGIC) / MULT; st.vy = (osx * MAGIC) / MULT;
						st.modX = (-omy * MAGIC) / MULT; st.modY = (omx * MAGIC) / MULT;
						remx = -remy; csx = -csy;
						break;
				}
				st.px = ex.x; st.py = ex.y;
			}
		}
		const boost = (flagsOf(cur) & F_BOOST) !== 0;
		let px = st.px, py = st.py, donex = false, doney = false;
		do {
			const ox = px, oy = py;
			st.ox = ox; st.oy = oy;
			const osx = csx, osy = csy;
			if (csx > 0.0) {
				if (csx + remx >= 1.0) { px += (1.0 - remx); px = px | 0; csx -= (1.0 - remx); remx = 0.0; }
				else { px += csx; csx = 0.0; }
			} else if (csx < 0.0) {
				if (remx + csx < 0.0 && (remx !== 0.0 || boost)) { csx += remx; px -= remx; px = px | 0; remx = 1.0; }
				else { px += csx; csx = 0.0; }
			}
			if (overlaps(st, W, px, py) !== 0) {
				px = ox;
				if (st.vx > 0.0 && M.morx > 0) grounded = true;
				if (st.vx < 0.0 && M.morx < 0) grounded = true;
				st.vx = 0.0;
				csx = osx;
				donex = true;
			}
			if (csy > 0.0) {
				if (csy + remy >= 1.0) { py += 1.0 - remy; py = py | 0; csy -= (1.0 - remy); remy = 0.0; }
				else { py += csy; csy = 0.0; }
			} else if (csy < 0.0) {
				if (remy + csy < 0.0 && (remy !== 0.0 || boost)) { py -= remy; py = py | 0; csy += remy; remy = 1.0; }
				else { py += csy; csy = 0.0; }
			}
			if (overlaps(st, W, px, py) !== 0) {
				py = oy;
				if (st.vy > 0.0 && M.mory > 0) grounded = true;
				if (st.vy < 0.0 && M.mory < 0) grounded = true;
				st.vy = 0.0;
				csy = osy;
				doney = true;
			}
		} while ((csx !== 0.0 && !donex) || (csy !== 0.0 && !doney));
		st.px = px; st.py = py;
	}
	st.grounded = grounded;
	// 4.19 the jump (replay: spacejustdown = spacedown = the bit, so injump = the bit) and the touch
	if (!st.dead) {
		const injump = space;
		if (space) { if (st.lev) { st.thrusting = true; st.thr = MAX_THRUST; } }
		else st.thrusting = false;
		if ((((st.vx === 0.0 && M.morx !== 0 && mox !== 0.0) || (st.vy === 0.0 && M.mory !== 0 && moy !== 0.0)) && grounded) || cur === MULTIJUMP) st.jc = 0;
		if (st.jc === 0 && !grounded) st.jc = 1;
		if (injump && !st.lev) {
			if (st.jc < st.maxJ && M.morx !== 0 && mox !== 0.0) {
				if (st.maxJ < 1000) st.jc += 1;
				st.vx = jumpSpeed(M.morx, jumpMult(st.jb, st.zombie, god, st.slip));
			}
			if (st.jc < st.maxJ && M.mory !== 0 && moy !== 0.0) {
				if (st.maxJ < 1000) st.jc += 1;
				st.vy = jumpSpeed(M.mory, jumpMult(st.jb, st.zombie, god, st.slip));
			}
		}
		touch(st, W, cx, cy, cur);
	}
	// 4.20 levitation's thrust (also while dead)
	if (st.lev) {
		const thr = st.thr;
		if (M.mory !== 0) st.vy = thrustStep(st.vy, thr, M.mory);
		if (M.morx !== 0) st.vx = thrustStep(st.vx, thr, M.morx);
		if (!st.thrusting) { if (st.thr > 0.0) st.thr -= THRUST_BURN_OFF; else st.thr = 0.0; }
	}
	// 4.21 the auto-align
	const liquidCur = isLiquid(cur) && !god;
	st.px = align(st.px, st.vx, st.modX, liquidCur);
	st.py = align(st.py, st.vy, st.modY, liquidCur);
	st.onGround = grounded;
	// 4.22 the respawn, 54 ticks after the kill
	if (st.deadOff > 16.0) {
		st.modX = 0.0; st.modY = 0.0; st.vx = 0.0; st.vy = 0.0;
		st.dead = false; st.fire = false;
		if (st.cpx !== -1) { st.px = st.cpx * 16; st.py = st.cpy * 16; }
		else { const sp = W.spawn(st); st.px = sp[0] * 16; st.py = sp[1] * 16; }
		st.cursed = false; st.zombie = false; st.poison = false;
		st.deaths++;
	}
	return st;
}
function kill(st) { if (!st.god && !st.dead) st.dead = true; }

/** Me.touchBlock's physics (Me.as:74-358): the effects that change the recurrences' context; the rest goes to W. */
function touch(st, W, cx, cy, cur) {
	if ((cur === COIN_GOLD || cur === COIN_BLUE) && W.coin) W.coin(st, cx, cy, cur);
	if (st.pastx !== cx || st.pasty !== cy) {
		if (!st.god) {
			switch (cur) {
				case EFFECT_JUMP: st.jb = W.lookup(cx, cy); break;
				case EFFECT_RUN: st.sb = W.lookup(cx, cy); break;
				case EFFECT_LOW_GRAVITY: st.lowg = W.lookup(cx, cy) !== 0; break;
				case EFFECT_PROTECTION: {
					const inv = W.lookup(cx, cy) !== 0;
					if (st.inv !== inv) { st.inv = inv; if (inv) { st.cursed = false; st.zombie = false; st.poison = false; st.fire = false; } }
					break;
				}
				case EFFECT_RESET:
					st.jb = 0; st.sb = 0; st.inv = false; st.lowg = false; st.maxJ = 1; st.flip = 0; st.lev = false; st.thr = 0.0;
					break;
				case EFFECT_FLY: {
					const lev = W.lookup(cx, cy) !== 0;
					if (st.lev !== lev) { st.lev = lev; if (!lev) st.thr = 0.0; }
					break;
				}
				case EFFECT_CURSE: case EFFECT_ZOMBIE: case EFFECT_POISON: {
					const n = W.lookup(cx, cy), on = n > 0;
					const k = cur === EFFECT_CURSE ? 'curse' : (cur === EFFECT_ZOMBIE ? 'zombie' : 'poison');
					const flag = k === 'curse' ? 'cursed' : k;
					if (st[flag] !== on && !st.inv) {
						st[flag] = on;
						if (on) { st[k + 'Start'] = st.ticks; st[k + 'Dur'] = (n + 2 * 0.2) * 100; }
					}
					break;
				}
				case NPC_ZOMBIE:
					if (!st.zombie && !st.inv) { st.zombie = true; st.zombieStart = 0; st.zombieDur = 0.0; }
					break;
				case LAVA:
					if (!st.fire && !st.inv) { st.fire = true; st.fireStart = st.ticks; st.fireDur = (2 + 2 * 0.2) * 100; }
					break;
				case WATER: case MUD: case TOXIC: st.fire = false; break;
				case MULTIJUMP: st.maxJ = W.lookup(cx, cy); break;
				case EFFECT_GRAVITY: st.flip = W.lookup(cx, cy); break;
				case CHECKPOINT: st.cpx = cx; st.cpy = cy; break;
				default: if (W.touch) W.touch(st, cx, cy, cur);
			}
		}
		st.pastx = cx; st.pasty = cy;
	}
}

/**
 * makeWorld(L, o): the world W of a prepared level (eesim.js prepareLevel / eelvl loadEelvlLevel) whose tiles never
 * change: doors as o.doorOpen(id, cx, cy, st) says (default: shut), portals from the level's lookup (a target with
 * several exits takes o.pick(n, st) -> index, default 0), spawns in the level's order.
 */
function makeWorld(L, o = {}) {
	const Wd = L.width, H = L.height, fg = L.fg, lk = L.lookup0;
	const exitsOf = new Map();
	return {
		width: Wd, height: H, maxX: Wd * 16 - 16, maxY: H * 16 - 16,
		tile: (cx, cy) => (cx < 0 || cy < 0 || cx >= Wd || cy >= H) ? 0 : fg[cy * Wd + cx],
		lookup: (cx, cy) => (cx < 0 || cy < 0 || cx >= Wd || cy >= H) ? 0 : lk[cy * Wd + cx],
		doorOpen: o.doorOpen || (() => false),
		portal(cx, cy) {
			const s = L.portalSlot[cy * Wd + cx];
			return s < 0 ? { id: 0, target: 0, rot: 0 } : { id: L.pId[s], target: L.pTarget[s], rot: L.pRot[s] };
		},
		exit(P, st) {
			const t = L.portalsById.get(P.target);
			if (!t || t.n <= 0) return null;
			const k = t.n === 1 ? 0 : (o.pick ? o.pick(t.n, st) : 0);
			const x = t.xs[k], y = t.ys[k];
			const ns = L.portalSlot[(y >> 4) * Wd + (x >> 4)];
			return { x, y, rot: ns >= 0 ? L.pRot[ns] : 0 };
		},
		spawn(st) {
			if (L.spawnsX.length === 0) return [1, 1];
			if (st.nextSpawn >= L.spawnsX.length) st.nextSpawn = 0;
			const p = [L.spawnsX[st.nextSpawn], L.spawnsY[st.nextSpawn]];
			st.nextSpawn += 1;
			return p;
		},
		exitsOf,
	};
}

module.exports = {
	// constants
	MULT, BASE_DRAG, NO_MOD_DRAG, WATER_DRAG, MUD_DRAG, LAVA_DRAG, TOXIC_DRAG, ICE_NO_MOD_DRAG, ICE_DRAG,
	JUMP_HEIGHT, GRAVITY, BOOST, CAP, SNAP, MAX_THRUST, THRUST_BURN_OFF, THRUST_SCALE, MAGIC, G, A,
	WATER_BUOYANCY, MUD_BUOYANCY, LAVA_BUOYANCY, TOXIC_BUOYANCY,
	ids: { WATER, MUD, LAVA, TOXIC, FIRE, ICE, PORTAL, PORTAL_INV, SPEED_LEFT, SPEED_RIGHT, SPEED_UP, SPEED_DOWN, DOT, DOT_INV,
		MULTIJUMP, CLIMBABLE_IDS, SPIKE_IDS, JUMP_THROUGH_IDS, ROT_HALF_IDS, HALF_IDS, NONROT_HALF_IDS, DOOR_IDS },
	F: { SOLID: F_SOLID, JUMPTHRU: F_JUMPTHRU, ROTHALF: F_ROTHALF, HALF: F_HALF, DOOR: F_DOOR, CLIMB: F_CLIMB, LIQUID: F_LIQUID,
		BOOST: F_BOOST, KILL: F_KILL, NONROT_HALF: F_NONROT_HALF },
	flagsOf, isClimb, isLiquid, isSolid, isImmediate, fmod1, fmod16,
	gravTables: () => ({ morx: GMORX, mory: GMORY, mox: GMOX, moy: GMOY, flags: GF }),
	// the pieces
	forces, axes, speedMult, gravMult, jumpMult, modifier, slipStep, belowDir, stepV, surface, stepX, stepY,
	moveFree, subSteps, align, jumpSpeed, thrustStep, portalTurn, overlaps,
	// the whole tick
	newState, fromSim, FIELDS, tick, makeWorld,
};
