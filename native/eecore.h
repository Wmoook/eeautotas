// eecore.h - the EE Offline physics of src/eesim.js in C++, bit for bit: one source for the native CPU engine
// (clang / zig c++) and the GPU kernels (NVRTC, --fmad=false). Every floating-point operation is the JS one, in the
// same order, on IEEE doubles; JS integer conversions go through the helpers below (defined for every input, the
// same on CPU and GPU). The comments name the eesim.js method each part mirrors; the reasoning behind the physics is
// in eesim.js and docs/eeo_spec. The state hash is EESim.stateHash(false, noCoins) exactly, so a state here and a
// state in the JS engine can be compared tick by tick (native/eegpu.cpp "trace", test/gpu.js).
//
// Not ported (no effect on physics or on the hash): onEvent, the event baselines (_ev*), frame_queue_ticks,
// prev_px / prev_py, teleported. The per-run tiles / lookup copies are derived: a coin cell's tile follows the
// collected-coin bits, and the lookup of a coin cell (the only runtime write) is never read.
#pragma once

#if defined(__CUDACC__) || defined(__CUDACC_RTC__)
#define EE_HD __host__ __device__ __forceinline__
#define EE_COLD __host__ __device__ __noinline__
#define EE_GPU 1
#else
#include <cmath>
#include <cstdint>
#include <cstring>
#define EE_HD inline
#define EE_COLD inline
#define EE_GPU 0
#endif

namespace ee {

typedef signed char i8;
typedef unsigned char u8;
typedef unsigned short u16;
typedef int i32;
typedef unsigned int u32;
typedef long long i64;
typedef unsigned long long u64;

// ------------------------------------------------------------------ JS number semantics
/** ToInt32 of a double (x | 0): truncate, wrap modulo 2^32; NaN / Infinity -> 0. */
EE_HD i32 toI32(double x) {
	if (!(x > -2147483649.0 && x < 2147483648.0)) {   // rare: out of the direct range (or NaN)
		if (x != x || x == 1.0 / 0.0 || x == -1.0 / 0.0) return 0;
		double t = trunc(x);
		double m = fmod(t, 4294967296.0);
		if (m < 0) m += 4294967296.0;
		return (i32)(u32)(u64)m;
	}
	return (i32)x;   // in range: C truncation = JS truncation
}
/** double(x | 0): the int back as a double (+0 for -0 and (-1, 0)). */
EE_HD double orZero(double x) { return (double)toI32(x); }
/** JS a % b on doubles = C fmod. */
EE_HD double jsMod(double a, double b) { return fmod(a, b); }
EE_HD i32 imul(i32 a, i32 b) { return (i32)((u32)a * (u32)b); }
EE_HD i32 shl(i32 a, int s) { return (i32)((u32)a << (s & 31)); }
EE_HD u32 ushr(i32 a, int s) { return (u32)a >> (s & 31); }
EE_HD i32 clz32(u32 x) {
#if EE_GPU
	return __clz((int)x);
#else
	return x == 0 ? 32 : __builtin_clz(x);
#endif
}
EE_HD int signi(double x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

// ------------------------------------------------------------------ bit patterns
EE_HD double bitsToDouble(u64 b) {
#if EE_GPU
	return __longlong_as_double((long long)b);
#else
	double d; memcpy(&d, &b, 8); return d;
#endif
}
EE_HD u64 doubleToBits(double d) {
#if EE_GPU
	return (u64)__double_as_longlong(d);
#else
	u64 b; memcpy(&b, &d, 8); return b;
#endif
}

// ------------------------------------------------------------------ exact integer forms of double tests
// A GeForce GPU runs 64-bit float instructions at 1/64 of its normal rate, and comparisons, truncations and
// int <-> double conversions are such instructions too. These helpers do them on the bit pattern with integer
// instructions instead. Each gives exactly the IEEE result for every value that is not NaN (+0 and -0 compare equal).
// The engine never meets a NaN: the GPU is only used for levels whose gravity multiplier is finite and below 1e300
// (src/gpu.js), and every other input is a finite table constant; so a hot path may use them. The CPU build runs the
// same code, and test/gpu.js compares both engines with src/eesim.js tick by tick.
/** A signed integer with the same order as the double (for non-NaN values; -0 and +0 map to 0). */
EE_HD i64 ordKey(double x) {
	const u64 b = doubleToBits(x);
	if ((b << 1) == 0) return 0;
	return (i64)b >= 0 ? (i64)b : (i64)(b ^ 0x7FFFFFFFFFFFFFFFull);
}
EE_HD bool dlt(double a, double b) { return ordKey(a) < ordKey(b); }
EE_HD bool dle(double a, double b) { return ordKey(a) <= ordKey(b); }
EE_HD bool dgt(double a, double b) { return ordKey(a) > ordKey(b); }
EE_HD bool dge(double a, double b) { return ordKey(a) >= ordKey(b); }
EE_HD bool gt0(double x) { return (i64)doubleToBits(x) > 0; }                                   // x > 0.0
EE_HD bool lt0(double x) { const u64 b = doubleToBits(x); return (b >> 63) != 0 && (b << 1) != 0; }   // x < 0.0
EE_HD bool ne0(double x) { return (doubleToBits(x) << 1) != 0; }                               // x != 0.0
EE_HD bool eq0(double x) { return (doubleToBits(x) << 1) == 0; }                               // x == 0.0
/** x > c and x >= c for a constant c > 0: positive doubles are ordered like their bit patterns. */
EE_HD bool gtP(double x, double c) { return (i64)doubleToBits(x) > (i64)doubleToBits(c); }
EE_HD bool geP(double x, double c) { return (i64)doubleToBits(x) >= (i64)doubleToBits(c); }
/** trunc(x) as an int, for |x| < 2^31 (the world's coordinates); larger values go the slow exact way. */
EE_HD i32 truncI(double x) {
	const u64 b = doubleToBits(x);
	const i32 e = (i32)((b >> 52) & 0x7FF) - 1023;
	if (e < 0) return 0;
	if (e > 30) return toI32(x);
	const u32 v = (u32)(((b & 0xFFFFFFFFFFFFFull) | 0x10000000000000ull) >> (52 - e));
	return (b >> 63) ? -(i32)v : (i32)v;
}
/** (double)i, exactly (every int32 is a double). */
EE_HD double i2d(i32 i) {
	if (i == 0) return 0.0;
	const u64 sign = i < 0 ? (1ull << 63) : 0;
	const u32 a = i < 0 ? (u32)(0u - (u32)i) : (u32)i;
	const i32 e = 31 - clz32(a);
	const u64 mant = ((u64)a << (52 - e)) & 0xFFFFFFFFFFFFFull;
	return bitsToDouble(sign | ((u64)(e + 1023) << 52) | mant);
}
/** double(x | 0) for the world's coordinates: truncate toward zero, +0 for (-1, 0]. */
EE_HD double orZeroF(double x) { return i2d(truncI(x)); }
/** trunc(x) as a double (sign kept: trunc(-0.5) = -0), for finite x. */
EE_HD double truncD(double x) {
	const u64 b = doubleToBits(x);
	const i32 e = (i32)((b >> 52) & 0x7FF) - 1023;
	if (e < 0) return bitsToDouble(b & (1ull << 63));
	if (e >= 52) return x;
	return bitsToDouble(b & ~((1ull << (52 - e)) - 1));
}

// ------------------------------------------------------------------ constants (eesim.js top)
static const double MS_PER_TICK = 10;
static const double MULT = 7.752;
// the drag constants, from their raw little-endian bits (eesim.js DRAG_HEX)
#define EE_BASE_DRAG bitsToDouble(0x3fef66f835f4cc6aull)
#define EE_ICE_NO_MOD_DRAG bitsToDouble(0x3fefc8253b4bc6faull)
#define EE_ICE_DRAG bitsToDouble(0x3feff0f24a05bfbeull)
#define EE_NO_MOD_DRAG bitsToDouble(0x3fecf1e3e6c8b51dull)
#define EE_WATER_DRAG bitsToDouble(0x3fee70bf81c5ff8dull)
#define EE_MUD_DRAG bitsToDouble(0x3fe8d8b73961cd1bull)
#define EE_LAVA_DRAG bitsToDouble(0x3fea2689a0fae3b6ull)
#define EE_TOXIC_DRAG bitsToDouble(0x3fecf1e3e6c8b51dull)
static const double JUMP_HEIGHT = 26.0;
static const double BOOST = 16.0;
static const double PING = 0.2;
static const double CLOCK_BASE = 1000000000000.0;
static const double MAX_THRUST = 0.2, THRUST_BURN_OFF = 0.01, THRUST_SCALE = 26.0 / 2;

enum {
	COIN_GOLD = 100, COIN_BLUE = 101, CROWN = 5, BRICK_COMPLETE = 121, PORTAL = 242, PORTAL_INVISIBLE = 381,
	CHECKPOINT = 360, SPEED_LEFT = 114, SPEED_RIGHT = 115, SPEED_UP = 116, SPEED_DOWN = 117,
	WATER = 119, MUD = 369, LAVA = 416, TOXIC_WASTE = 1585, FIRE = 368, ICE = 1064,
	SWITCH_PURPLE = 113, RESET_PURPLE = 1619, DOOR_PURPLE = 184, GATE_PURPLE = 185,
	SWITCH_ORANGE = 467, RESET_ORANGE = 1620, DOOR_ORANGE = 1079, GATE_ORANGE = 1080,
	COINDOOR = 43, COINGATE = 165, BLUECOINDOOR = 213, BLUECOINGATE = 214, DEATH_DOOR = 1011, DEATH_GATE = 1012,
	EFFECT_JUMP = 417, EFFECT_FLY = 418, EFFECT_RUN = 419, EFFECT_PROTECTION = 420, EFFECT_LOW_GRAVITY = 453,
	EFFECT_CURSE = 421, EFFECT_ZOMBIE = 422, EFFECT_TEAM = 423, EFFECT_POISON = 1584, NPC_ZOMBIE = 1573,
	EFFECT_MULTIJUMP = 461, EFFECT_GRAVITY = 1517, EFFECT_RESET = 1618,
	TEAM_DOOR = 1027, TEAM_GATE = 1028, ZOMBIE_GATE = 206, ZOMBIE_DOOR = 207, DOOR_GOLD = 200, GATE_GOLD = 201,
	PIANO = 77, DRUMS = 83, GUITAR = 1520,
	F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128,
	X_KILL = 1, X_BLINK = 2, X_NONROT_HALF = 4,
	OV_AIR = 0, OV_SOLID = 1, OV_COMPLEX = 2, OV_SECRET = 3,
	SQ_CROWN = 0, SQ_SILVER = 1, SQ_ORANGE = 2,
	KEY_TICKS = 500, TIMEDOOR_PERIOD = 1000, TIMEDOOR_HALF = 500,
};

// ------------------------------------------------------------------ level (read-only, shared)
/** The prepared level (eesim.js prepareLevel), flattened by src/gpu.js levelBlob(). Pointers into one blob. */
struct Level {
	i32 W, H, N, nFlags;
	i32 maxX, maxY;                       // W * 16 - 16, H * 16 - 16
	double gravityMult;
	const i32* fg; const i32* lookup0;
	const u8* flags; const u8* xflags; const u8* ovl; const u16* airMask; const i32* airPS;
	const i8* gMorx; const i8* gMory; const double* gMox; const double* gMoy; const u8* gFlags;
	const i32* portalSlot; const i32* pId; const i32* pTarget; const i32* pRot; i32 nPortals;
	// exits per portal id (lookup order): ids sorted ascending, exits [exOff[k], exOff[k + 1])
	const i32* exIds; const i32* exOff; const i32* exX; const i32* exY; const i32* exPc; i32 nExIds;
	i32 multiTargetPortals;
	const i32* rngScript; i32 rngScriptLen;   // rngScriptLen < 0: no script (Godot PCG mode)
	const i32* coinBit; const i32* coinTiles; const i32* coinBaseId; i32 nCoins, coinWords;
	const i32* secretBit; i32 nSecrets, secretWords;
	const i32* portalCoinIdx; i32 nPortalCoins, pgWords;   // portalCoinIdx null when nPortalCoins == 0
	const i32* spawnsX; const i32* spawnsY; i32 nSpawns;
	// purple / orange switch ids that any press can set (sorted ascending): bit k of the on-set = ids[k]
	const i32* swIds; i32 nSw, swWords;
	const i32* oswIds; i32 nOsw, oswWords;
	const i32* keyColors; i32 nKeyColors;   // key colors with key tiles (sorted), for the key-timer hash slots
	i32 hasTimeDoors, hasCoinGate, hasBlueCoinGate, hasDeathDoor, hasDeathGate, hasTeamEffect;
	// per-run settings (EESim constructor defaults)
	i32 startMode;       // 0 reset, 1 load
	i32 idleTicks, startSpawn, hasStartSpawn, goldBorder, ticksPerFrame;
	// the variable tail of the state (words): coin bits, secret bits, portal-gone bits, purple, orange on-sets
	i32 offCoin, offSecret, offPg, offSw, offOsw, tailWords;
	// the hash's int32 slot count (EESim._initKeyLayout nI, padded to even)
	i32 keyInts;
};

EE_HD i32 findSorted(const i32* a, i32 n, i32 v) {   // index of v in the sorted array a, or -1
	i32 lo = 0, hi = n - 1;
	while (lo <= hi) {
		i32 mid = (lo + hi) >> 1;
		i32 x = a[mid];
		if (x == v) return mid;
		if (x < v) lo = mid + 1; else hi = mid - 1;
	}
	return -1;
}

// ------------------------------------------------------------------ state
#ifndef EE_QCAP
#define EE_QCAP 8
#endif
/** Everything EESim.snapshot() keeps that affects physics or the hash. TW = capacity of the variable tail (words). */
template <int TW>
struct State {
	double px, py, speed_x, speed_y, modifier_x, modifier_y, mox, moy, mx, my;
	double slippery, last_jump, ox, oy, dead_offset, current_thrust;
	double fire_duration, curse_duration, zombie_duration, poison_duration;
	u64 rngState;
	i32 fire_time_start, curse_time_start, zombie_time_start, poison_time_start;
	i32 morx, mory, jump_count, max_jumps, jump_boost, speed_boost, flip_gravity;
	i32 coins, blue_coins, deaths, next_spawn, keysMask;
	i32 kt[6];
	i32 show_coin_gate, show_blue_coin_gate, show_death_gate;
	i32 ticks, tick0, q0, q1, pastx, pasty, overlapa, overlapb, overlapc, overlapd;
	i32 last_portal_x, last_portal_y, horizontal, vertical, current, run_ticks;
	i32 team, team_tx, team_ty, checkpoint_x, checkpoint_y, grav_x, grav_y;
	i32 rngSteps, rngNeed;
	u8 on_ground, is_dead, in_god_mode, has_crown, has_silver_crown, low_gravity, is_invulnerable, is_on_fire;
	u8 timedoor_state, collide_crown, collide_silver_crown, last_portal_set, spacedown, spacejustdown, prev_jump_held;
	u8 is_cursed, is_zombie, is_poisoned, has_levitation, is_thrusting, loopCollided, grounded;
	u8 broken;           // a queue overflowed or the tail was too small: this state is not simulated exactly any more
	u8 nsq, nkq, ntq;    // queue lengths in entries (triples / pairs / pairs)
	i32 sq[3 * EE_QCAP];
	i32 kq[2 * EE_QCAP];
	i32 tq[2 * EE_QCAP];
	u32 w[TW];
};

/** The input of one tick (EEInput after applyMask). */
struct Input {
	u8 left, right, up, down, jump, jump_pressed;
};
EE_HD Input maskInput(int m) {
	Input in;
	in.jump = (m & 1) != 0; in.jump_pressed = in.jump;
	in.left = (m & 2) != 0; in.right = (m & 4) != 0; in.up = (m & 8) != 0; in.down = (m & 16) != 0;
	return in;
}

// ------------------------------------------------------------------ the simulator
template <int TW>
struct Sim {
	const Level& L;
	State<TW>& s;
	EE_HD Sim(const Level& l, State<TW>& st) : L(l), s(st) {}

	// ---- tiles (the live layer 0 of EESim.tiles: coin cells follow the collected bits)
	EE_HD bool coinCollected(i32 k) const { return ((s.w[L.offCoin + (k >> 5)] >> (k & 31)) & 1u) != 0; }
	EE_HD i32 tileAt(i32 i) const {
		i32 b = L.coinBit[i];
		if (b >= 0) return L.coinBaseId[b] + (coinCollected(b) ? 10 : 0);
		return L.fg[i];
	}
	EE_HD i32 getTile(i32 tx, i32 ty) const {
		if (tx < 0 || ty < 0 || tx >= L.W || ty >= L.H) return 0;
		return tileAt(ty * L.W + tx);
	}
	EE_HD i32 lookupAt(i32 tx, i32 ty) const {
		if (tx < 0 || ty < 0 || tx >= L.W || ty >= L.H) return 0;
		return L.lookup0[ty * L.W + tx];
	}
	EE_HD u8 flag(i32 id) const { return (id >= 0 && id < L.nFlags) ? L.flags[id] : 0; }
	EE_HD u8 xflag(i32 id) const { return (id >= 0 && id < L.nFlags) ? L.xflags[id] : 0; }

	// ---- switches (Map id -> bool, only `=== true` matters: an on-set over the level's switch ids)
	EE_HD bool swOn(i32 id) const {
		i32 k = findSorted(L.swIds, L.nSw, id);
		return k >= 0 && ((s.w[L.offSw + (k >> 5)] >> (k & 31)) & 1u) != 0;
	}
	EE_HD bool oswOn(i32 id) const {
		i32 k = findSorted(L.oswIds, L.nOsw, id);
		return k >= 0 && ((s.w[L.offOsw + (k >> 5)] >> (k & 31)) & 1u) != 0;
	}
	EE_HD void swSet(i32 id, bool v) {
		i32 k = findSorted(L.swIds, L.nSw, id);
		if (k < 0) { if (v) s.broken = 1; return; }   // (never: every pressable id is in swIds)
		u32 m = 1u << (k & 31);
		if (v) s.w[L.offSw + (k >> 5)] |= m; else s.w[L.offSw + (k >> 5)] &= ~m;
	}
	EE_HD void oswSet(i32 id, bool v) {
		i32 k = findSorted(L.oswIds, L.nOsw, id);
		if (k < 0) { if (v) s.broken = 1; return; }
		u32 m = 1u << (k & 31);
		if (v) s.w[L.offOsw + (k >> 5)] |= m; else s.w[L.offOsw + (k >> 5)] &= ~m;
	}

	// ---- queues (flat arrays, FIFO)
	EE_HD void sqPush(i32 a, i32 b, i32 c) {
		if (s.nsq >= EE_QCAP) { s.broken = 1; return; }
		i32 o = 3 * s.nsq; s.sq[o] = a; s.sq[o + 1] = b; s.sq[o + 2] = c; s.nsq++;
	}
	EE_HD void kqPush(i32 a, i32 b) {
		if (s.nkq >= EE_QCAP) { s.broken = 1; return; }
		i32 o = 2 * s.nkq; s.kq[o] = a; s.kq[o + 1] = b; s.nkq++;
	}
	EE_HD void tqPush(i32 a, i32 b) {
		if (s.ntq >= EE_QCAP) { s.broken = 1; return; }
		i32 o = 2 * s.ntq; s.tq[o] = a; s.tq[o + 1] = b; s.ntq++;
	}

	// ================================================================ reset (EESim.reset)
	EE_HD void clearTail() { for (i32 i = 0; i < L.tailWords; i++) s.w[i] = 0; }

	/** _freshLoad(); coinBits0 (the file's collected coins) comes in through `coinBits0` (null = none). */
	EE_COLD void freshLoad(const u32* coinBits0) {
		clearTail();
		if (coinBits0) for (i32 i = 0; i < L.coinWords; i++) s.w[L.offCoin + i] = coinBits0[i];
		s.next_spawn = 0; s.keysMask = 0;
		for (int c = 0; c < 6; c++) s.kt[c] = 0;
		s.timedoor_state = 0;
		s.show_coin_gate = 0; s.show_blue_coin_gate = 0; s.show_death_gate = 0;
		s.ticks = 0; s.tick0 = 0;
		s.nsq = 0; s.nkq = 0; s.ntq = 0;
		s.rngState = 0; s.rngSteps = 0; s.rngNeed = 0;   // (set by reset())
		s.q0 = 0; s.q1 = 0;
		s.last_jump = -(CLOCK_BASE + s.ticks * MS_PER_TICK);
		s.slippery = 0.0;
		s.pastx = 0; s.pasty = 0;
		s.overlapa = -1; s.overlapb = -1; s.overlapc = -1; s.overlapd = -1;
		s.last_portal_set = 1; s.last_portal_x = 0; s.last_portal_y = 0;
		s.has_crown = 0; s.has_silver_crown = 0; s.collide_crown = 0; s.collide_silver_crown = 0;
		s.coins = 0; s.blue_coins = 0; s.deaths = 0;
		s.checkpoint_x = -1; s.checkpoint_y = -1;
		s.flip_gravity = 0; s.jump_count = 0; s.max_jumps = 1; s.jump_boost = 0; s.speed_boost = 0;
		s.low_gravity = 0; s.is_invulnerable = 0;
		s.is_on_fire = 0; s.fire_time_start = 0; s.fire_duration = 0.0;
		s.is_cursed = 0; s.curse_time_start = 0; s.curse_duration = 0.0;
		s.is_zombie = 0; s.zombie_time_start = 0; s.zombie_duration = 0.0;
		s.is_poisoned = 0; s.poison_time_start = 0; s.poison_duration = 0.0;
		s.has_levitation = 0; s.is_thrusting = 0; s.current_thrust = 0.0;
		s.team = 0; s.team_tx = -1; s.team_ty = -1;
		s.in_god_mode = 0; s.is_dead = 0; s.dead_offset = 0.0;
		s.run_ticks = 0;
		s.speed_x = 0.0; s.speed_y = 0.0; s.modifier_x = 0.0; s.modifier_y = 0.0;
		s.morx = 0; s.mory = 0; s.mox = 0.0; s.moy = 0.0; s.mx = 0.0; s.my = 0.0;
		s.horizontal = 0; s.vertical = 0; s.spacedown = 0; s.spacejustdown = 0; s.prev_jump_held = 0;
		s.current = 0;
		s.on_ground = 0; s.grounded = 0;
		s.grav_x = 0; s.grav_y = 1;
		s.ox = 0.0; s.oy = 0.0;
		s.px = 16.0; s.py = 16.0;
		s.loopCollided = 0; s.broken = 0;
		placeAtSpawn(false);
	}

	/** _slashReset(): /reset = Player.resetPlayer(), PlayState.ticks = 0, one pass of the frame queues. */
	EE_COLD void slashReset() {
		if (!s.in_god_mode) {
			s.has_crown = 0; s.has_silver_crown = 0;
			checkCrown(false);
			checkSilverCrown(false);
			s.collide_crown = 0; s.collide_silver_crown = 0;
			s.deaths = 0;
			s.coins = 0; s.blue_coins = 0;
			s.is_dead = 0;
			s.jump_boost = 0; s.speed_boost = 0; s.is_invulnerable = 0; s.low_gravity = 0;
			s.max_jumps = 1; s.flip_gravity = 0;
			s.has_levitation = 0; s.current_thrust = 0.0;
			s.is_cursed = 0; s.is_zombie = 0; s.is_on_fire = 0; s.is_poisoned = 0;
			s.checkpoint_x = -1; s.checkpoint_y = -1;
			for (i32 i = 0; i < L.swWords; i++) s.w[L.offSw + i] = 0;
			s.team = 0;
			s.run_ticks = 0;
			for (i32 i = 0; i < L.coinWords; i++) s.w[L.offCoin + i] = 0;       // _resetCoinTiles
			for (i32 i = 0; i < L.secretWords; i++) s.w[L.offSecret + i] = 0;   // resetSecrets
			respawn();
		}
		s.ticks = 0;
		drainFrameQueues();
	}

	/** EESim.reset() (after _freshLoad; the RNG seed comes from the host: RNG_SEED_STATE). */
	EE_COLD void reset(const u32* coinBits0, u64 rngSeedState) {
		freshLoad(coinBits0);
		i32 idle = L.idleTicks > 0 ? L.idleTicks : 0;
		if (idle > 0 || L.startMode == 0) {
			if (idle > 0) {
				Input in; in.left = in.right = in.up = in.down = in.jump = in.jump_pressed = 0;
				for (i32 i = 0; i < idle; i++) { Input c = in; tick(c); }
			}
			if (L.startMode == 0) slashReset();
		}
		if (L.hasStartSpawn && L.nSpawns > 0) {
			i32 n = L.nSpawns, k = ((L.startSpawn % n) + n) % n;
			s.px = (double)(L.spawnsX[k] * 16); s.py = (double)(L.spawnsY[k] * 16);
			s.next_spawn = k + 1;
		}
		s.rngState = rngSeedState; s.rngSteps = 0; s.rngNeed = 0;
		s.tick0 = s.ticks;
	}

	// ================================================================ tick (EESim.tick)
	EE_HD void tick(Input& input) {
		s.ticks++;
		i32 cls = ovClass(s.px, s.py);
		if (cls == 0) {
			s.show_coin_gate = s.coins; s.show_blue_coin_gate = s.blue_coins; s.show_death_gate = s.deaths;
		} else if (cls < 0) {
			i32 old = s.show_coin_gate;
			s.show_coin_gate = s.coins;
			if (overlaps() != 0) s.show_coin_gate = old;
			old = s.show_blue_coin_gate;
			s.show_blue_coin_gate = s.blue_coins;
			if (overlaps() != 0) s.show_blue_coin_gate = old;
			old = s.show_death_gate;
			s.show_death_gate = s.deaths;
			if (overlaps() != 0) s.show_death_gate = old;
		}
		// World.update
		i32 t = s.ticks;
		s.timedoor_state = (t % TIMEDOOR_PERIOD) >= TIMEDOOR_HALF;
		if (s.keysMask != 0) {
			for (int c = 0; c < 6; c++) {
				if ((s.keysMask & (1 << c)) != 0 && (t - s.kt[c]) >= KEY_TICKS) switchKey(c, false, false);
			}
		}
		bool threw = playerTick(input);
		if (s.nsq != 0 || s.nkq != 0) {
			if (!threw && (L.ticksPerFrame == 1 || t % L.ticksPerFrame == 0)) drainFrameQueues();
		}
		// _emitDiffs: only gravity_dir matters (it is hashed)
		int gx = signi(s.mox), gy = signi(s.moy);
		if (!s.in_god_mode && (gx != s.grav_x || gy != s.grav_y)) { s.grav_x = gx; s.grav_y = gy; }
	}

	EE_COLD void drainFrameQueues() {
		if (s.nsq != 0) {
			i32 n = s.nsq;
			while (n > 0) {
				n--;
				i32 kind = s.sq[0], a = s.sq[1], b = s.sq[2];
				for (i32 i = 3; i < 3 * s.nsq; i++) s.sq[i - 3] = s.sq[i];
				s.nsq--;
				if (kind == SQ_CROWN) checkCrown(a != 0);
				else if (kind == SQ_SILVER) checkSilverCrown(a != 0);
				else pressOrangeSwitch(a, b != 0);
			}
		}
		if (s.nkq != 0) {
			i32 n = s.nkq;
			while (n > 0) {
				n--;
				i32 c = s.kq[0], st = s.kq[1];
				for (i32 i = 2; i < 2 * s.nkq; i++) s.kq[i - 2] = s.kq[i];
				s.nkq--;
				switchKey(c, st != 0, true);
			}
		}
	}

	/** _playerTick. Returns true when eeo-tas threw in touchBlock (out-of-range music block). */
	EE_HD bool playerTick(Input& input) {
		const i32 W = L.W;
		const double now = CLOCK_BASE + s.ticks * MS_PER_TICK;
		const bool isgodmod = s.in_god_mode != 0;
		if (s.is_dead) s.dead_offset += 0.3;
		else s.dead_offset = 0.0;
		if (!s.is_dead && (s.is_cursed || s.is_zombie || s.is_on_fire || s.is_poisoned)) {
			i32 t = s.ticks;
			if (s.is_cursed && s.curse_duration != 0.0 && (double)(t - s.curse_time_start) > s.curse_duration) killPlayer();
			if (s.is_zombie && !isgodmod && s.zombie_duration != 0.0 && (double)(t - s.zombie_time_start) > s.zombie_duration) killPlayer();
			if (s.is_on_fire && s.fire_duration != 0.0 && (double)(t - s.fire_time_start) > s.fire_duration) killPlayer();
			if (s.is_poisoned && !isgodmod && s.poison_duration != 0.0 && (double)(t - s.poison_time_start) > s.poison_duration) killPlayer();
		}

		i32 cx = truncI(s.px + 8.0) >> 4;
		i32 cy = truncI(s.py + 8.0) >> 4;

		i32 delayed = s.q0;
		s.q0 = s.q1;
		i32 current = getTile(cx, cy);
		if ((flag(current) & F_HALF) != 0) {
			i32 rot = (cx >= 0 && cy >= 0 && cx < W && cy < L.H) ? L.lookup0[cy * W + cx] : 0;
			if ((xflag(current) & X_NONROT_HALF) != 0) rot = 1;
			if (rot == 1) cy -= 1;
			if (rot == 0) cx -= 1;
			current = getTile(cx, cy);
		}
		s.current = current;

		if (s.team_tx != -1) updateTeamDoors(s.team_tx, s.team_ty);

		i32 currentBelow = getCurrentBelow(current, cx, cy);
		s.q1 = current;
		if (current == 4 || current == 414 || (flag(current) & F_CLIMB) != 0) {
			delayed = s.q0;
			s.q0 = s.q1;
			s.q1 = current;
		}

		if (s.ntq != 0) {
			i32 ql = s.ntq;
			while (ql > 0) {
				ql--;
				i32 sid = s.tq[0], en = s.tq[1];
				for (i32 i = 2; i < 2 * s.ntq; i++) s.tq[i - 2] = s.tq[i];
				s.ntq--;
				pressPurpleSwitch(sid, en != 0);
			}
		}

		// Me.getPlayerInput()
		bool ij = input.jump != 0;
		s.horizontal = (input.left ? -1 : 0) + (input.right ? 1 : 0);
		s.vertical = (input.up ? -1 : 0) + (input.down ? 1 : 0);
		s.spacedown = ij;
		s.spacejustdown = input.jump_pressed || (ij && !s.prev_jump_held);
		s.prev_jump_held = ij;
		input.jump_pressed = 0;
		if (s.is_dead) { s.spacejustdown = 0; s.spacedown = 0; s.horizontal = 0; s.vertical = 0; }

		bool rotateMo = true, rotateMor = true;
		i32 morx = 0, mory = 0;
		double mox = 0.0, moy = 0.0;
		if (!isgodmod) {
			u8 gfc = (current >= 0 && current < L.nFlags) ? L.gFlags[current] : 3;
			morx = (current >= 0 && current < L.nFlags) ? L.gMorx[current] : 0;
			mory = (current >= 0 && current < L.nFlags) ? L.gMory[current] : 2;
			rotateMor = (gfc & 1) != 0;
			if ((gfc & 4) != 0 && !s.is_dead && !s.is_invulnerable) killPlayer();
			bool din = delayed >= 0 && delayed < L.nFlags;
			mox = din ? L.gMox[delayed] : 0.0; moy = din ? L.gMoy[delayed] : 2.0;
			rotateMo = ((din ? L.gFlags[delayed] : 3) & 2) != 0;
		}
		switch (s.flip_gravity) {
		case 1:
			if (rotateMo) { double t = mox; mox = -moy; moy = t; }
			if (rotateMor) { i32 it = morx; morx = 0 - mory; mory = it; }
			break;
		case 2:
			if (rotateMo) { mox = -mox; moy = -moy; }
			if (rotateMor) { morx = 0 - morx; mory = 0 - mory; }
			break;
		case 3:
			if (rotateMo) { double t = mox; mox = moy; moy = -t; }
			if (rotateMor) { i32 it = morx; morx = mory; mory = 0 - it; }
			break;
		case 4:
			if (rotateMo) { mox = 0.0; moy = 0.0; }
			if (rotateMor) { morx = 0; mory = 0; }
			break;
		}

		double mx, my;
		if ((flag(delayed) & F_LIQUID) != 0) { mx = s.horizontal; my = s.vertical; }
		else if (ne0(moy)) { mx = s.horizontal; my = 0.0; }
		else if (ne0(mox)) { mx = 0.0; my = s.vertical; }
		else { mx = s.horizontal; my = s.vertical; }

		double sm = 1.0;
		if (s.speed_boost == 1) sm *= 1.5;
		if (s.speed_boost == 2) sm *= 0.6;
		if (s.is_zombie && !isgodmod) sm *= 0.6;
		mx *= sm;
		my *= sm;
		double gm = 1.0;
		if (s.low_gravity) gm *= 0.15;
		gm *= L.gravityMult;
		mox *= gm;
		moy *= gm;
		s.mx = mx; s.my = my;
		s.morx = morx; s.mory = mory; s.mox = mox; s.moy = moy;

		s.modifier_x = (mox + mx) / MULT;
		s.modifier_y = (moy + my) / MULT;

		const bool climbCur = (flag(current) & F_CLIMB) != 0;
		if (currentBelow == ICE && !climbCur && current != 4 && current != 414) s.slippery = 2.0;
		else if ((flag(currentBelow) & F_SOLID) != 0) s.slippery = 0.0;
		else if (gt0(s.slippery)) s.slippery -= 0.2;

		const double slippery = s.slippery;
		if (ne0(s.speed_x) || ne0(s.modifier_x)) {
			double sx = s.speed_x + s.modifier_x;
			if (((((eq0(mx) && ne0(moy)) || (lt0(sx) && gt0(mx)) || (gt0(sx) && lt0(mx))) && (!gt0(slippery) || isgodmod)) || (climbCur && !isgodmod))) {
				sx *= EE_BASE_DRAG;
				sx *= EE_NO_MOD_DRAG;
			} else if (current == WATER && !isgodmod) {
				sx *= EE_BASE_DRAG; sx *= EE_WATER_DRAG;
			} else if (current == MUD && !isgodmod) {
				sx *= EE_BASE_DRAG; sx *= EE_MUD_DRAG;
			} else if (current == LAVA && !isgodmod) {
				sx *= EE_BASE_DRAG; sx *= EE_LAVA_DRAG;
			} else if (current == TOXIC_WASTE && !isgodmod) {
				sx *= EE_BASE_DRAG; sx *= EE_TOXIC_DRAG;
			} else if (gt0(slippery) && !isgodmod) {
				if (ne0(mx) && !((lt0(sx) && gt0(mx)) || (gt0(sx) && lt0(mx)))) sx *= EE_BASE_DRAG;
				else sx *= EE_ICE_NO_MOD_DRAG;
				if ((lt0(sx) && gt0(mx)) || (gt0(sx) && lt0(mx))) sx *= EE_ICE_DRAG;
			} else {
				sx *= EE_BASE_DRAG;
			}
			if (gtP(sx, 16.0)) sx = 16.0;
			else if (dlt(sx, -16.0)) sx = -16.0;
			else if (dlt(sx, 0.0001) && dgt(sx, -0.0001)) sx = 0.0;
			s.speed_x = sx;
		}
		if (ne0(s.speed_y) || ne0(s.modifier_y)) {
			double sy = s.speed_y + s.modifier_y;
			if (((((eq0(my) && ne0(mox)) || (lt0(sy) && gt0(my)) || (gt0(sy) && lt0(my))) && (!gt0(slippery) || isgodmod)) || (climbCur && !isgodmod))) {
				sy *= EE_BASE_DRAG;
				sy *= EE_NO_MOD_DRAG;
			} else if (current == WATER && !isgodmod) {
				sy *= EE_BASE_DRAG; sy *= EE_WATER_DRAG;
			} else if (current == MUD && !isgodmod) {
				sy *= EE_BASE_DRAG; sy *= EE_MUD_DRAG;
			} else if (current == LAVA && !isgodmod) {
				sy *= EE_BASE_DRAG; sy *= EE_LAVA_DRAG;
			} else if (current == TOXIC_WASTE && !isgodmod) {
				sy *= EE_BASE_DRAG; sy *= EE_TOXIC_DRAG;
			} else if (gt0(slippery) && !isgodmod) {
				if (ne0(my) && !((lt0(sy) && gt0(my)) || (gt0(sy) && lt0(my)))) sy *= EE_BASE_DRAG;
				else sy *= EE_ICE_NO_MOD_DRAG;
				if ((lt0(sy) && gt0(my)) || (gt0(sy) && lt0(my))) sy *= EE_ICE_DRAG;
			} else {
				sy *= EE_BASE_DRAG;
			}
			if (gtP(sy, 16.0)) sy = 16.0;
			else if (dlt(sy, -16.0)) sy = -16.0;
			else if (dlt(sy, 0.0001) && dgt(sy, -0.0001)) sy = 0.0;
			s.speed_y = sy;
		}

		if (!isgodmod) {
			switch (current) {
			case SPEED_LEFT: s.speed_x = -BOOST; break;
			case SPEED_RIGHT: s.speed_x = BOOST; break;
			case SPEED_UP: s.speed_y = -BOOST; break;
			case SPEED_DOWN: s.speed_y = BOOST; break;
			}
			if (s.is_dead) { s.speed_x = 0.0; s.speed_y = 0.0; }
		}

		// sub-stepped movement
		double rem_x = fmod1(s.px), cur_sx = s.speed_x, rem_y = fmod1(s.py), cur_sy = s.speed_y;
		bool grounded = false;
		if (ne0(cur_sx) || ne0(cur_sy)) {
			i32 slot = (current == PORTAL || current == PORTAL_INVISIBLE) ? L.portalSlot[cy * W + cx] : -1;
			if (isgodmod || slot < 0 || L.pTarget[slot] == L.pId[slot]) s.last_portal_set = 0;
			else if (!s.last_portal_set) portalTeleport(slot, cx, cy, rem_x, cur_sx, rem_y, cur_sy);
			const bool boostCur = (flag(current) & F_BOOST) != 0;
			double px = s.px, py = s.py;
			double remx = rem_x, remy = rem_y, csx = cur_sx, csy = cur_sy;
			bool donex = false, doney = false;
			bool exact = true;
			if (!isgodmod && !s.loopCollided) {
				double x = px, y = py, rx = remx, ry = remy, sx = csx, sy = csy;
				double minX = x, maxX = x, minY = y, maxY = y, lox = x, loy = y;
				do {
					lox = x; loy = y;
					if (gt0(sx)) {
						if (geP(sx + rx, 1.0)) { x += (1.0 - rx); x = orZeroF(x); sx -= (1.0 - rx); rx = 0.0; }
						else { x += sx; sx = 0.0; }
					} else if (lt0(sx)) {
						if (lt0(rx + sx) && (ne0(rx) || boostCur)) { sx += rx; x -= rx; x = orZeroF(x); rx = 1.0; }
						else { x += sx; sx = 0.0; }
					}
					if (dlt(x, minX)) minX = x;
					if (dgt(x, maxX)) maxX = x;
					if (gt0(sy)) {
						if (geP(sy + ry, 1.0)) { y += 1.0 - ry; y = orZeroF(y); sy -= (1.0 - ry); ry = 0.0; }
						else { y += sy; sy = 0.0; }
					} else if (lt0(sy)) {
						if (lt0(ry + sy) && (ne0(ry) || boostCur)) { y -= ry; y = orZeroF(y); sy += ry; ry = 1.0; }
						else { y += sy; sy = 0.0; }
					}
					if (dlt(y, minY)) minY = y;
					if (dgt(y, maxY)) maxY = y;
				} while (ne0(sx) || ne0(sy));
				if (sweptAir(minX, maxX, minY, maxY)) {
					exact = false;
					px = x; py = y;
					s.ox = lox; s.oy = loy;
					s.overlapa = -1; s.overlapb = -1; s.overlapc = -1; s.overlapd = -1;
				}
			}
			if (exact) do {
				const double ox = px, oy = py;
				s.ox = ox;
				s.oy = oy;
				const double osx = csx, osy = csy;
				if (gt0(csx)) {
					if (geP(csx + remx, 1.0)) { px += (1.0 - remx); px = orZeroF(px); csx -= (1.0 - remx); remx = 0.0; }
					else { px += csx; csx = 0.0; }
				} else if (lt0(csx)) {
					if (lt0(remx + csx) && (ne0(remx) || boostCur)) { csx += remx; px -= remx; px = orZeroF(px); remx = 1.0; }
					else { px += csx; csx = 0.0; }
				}
				if (ovAt(px, py) != 0) {
					px = ox;
					const double sp = s.speed_x;
					if (gt0(sp) && morx > 0) grounded = true;
					if (lt0(sp) && morx < 0) grounded = true;
					s.speed_x = 0.0;
					csx = osx;
					donex = true;
				}
				if (gt0(csy)) {
					if (geP(csy + remy, 1.0)) { py += 1.0 - remy; py = orZeroF(py); csy -= (1.0 - remy); remy = 0.0; }
					else { py += csy; csy = 0.0; }
				} else if (lt0(csy)) {
					if (lt0(remy + csy) && (ne0(remy) || boostCur)) { py -= remy; py = orZeroF(py); csy += remy; remy = 1.0; }
					else { py += csy; csy = 0.0; }
				}
				if (ovAt(px, py) != 0) {
					py = oy;
					const double sp = s.speed_y;
					if (gt0(sp) && mory > 0) grounded = true;
					if (lt0(sp) && mory < 0) grounded = true;
					s.speed_y = 0.0;
					csy = osy;
					doney = true;
				}
			} while ((ne0(csx) && !donex) || (ne0(csy) && !doney));
			s.loopCollided = donex || doney;
			s.px = px;
			s.py = py;
		}
		s.grounded = grounded;

		// jumping, touching blocks
		if (!s.is_dead) {
			double mod = 1.0;
			bool injump = false;
			if (s.spacejustdown) { s.last_jump = -now; injump = true; mod = -1.0; }
			if (s.spacedown) {
				if (s.has_levitation) {
					s.is_thrusting = 1;
					s.current_thrust = MAX_THRUST;
				} else if (lt0(s.last_jump)) {
					if (gtP(now + s.last_jump, 750.0)) injump = true;
				} else {
					if (gtP(now - s.last_jump, 150.0)) injump = true;
				}
			} else {
				s.is_thrusting = 0;
			}
			if ((((eq0(s.speed_x) && morx != 0 && ne0(mox)) || (eq0(s.speed_y) && mory != 0 && ne0(moy))) && grounded) || s.current == EFFECT_MULTIJUMP) {
				s.jump_count = 0;
			}
			if (s.jump_count == 0 && !grounded) s.jump_count = 1;
			if (injump && !s.has_levitation) {
				if (s.jump_count < s.max_jumps && morx != 0 && ne0(mox)) {
					if (s.max_jumps < 1000) s.jump_count += 1;
					s.speed_x = ((double)(0 - morx) * JUMP_HEIGHT * jumpMultiplier()) / MULT;
					s.last_jump = now * mod;
				}
				if (s.jump_count < s.max_jumps && mory != 0 && ne0(moy)) {
					if (s.max_jumps < 1000) s.jump_count += 1;
					s.speed_y = ((double)(0 - mory) * JUMP_HEIGHT * jumpMultiplier()) / MULT;
					s.last_jump = now * mod;
				}
			}
			if (!touchBlock(cx, cy, isgodmod)) {
				s.on_ground = s.grounded;
				return true;
			}
		}

		// levitation thrust
		if (s.has_levitation) {
			const double thr = s.current_thrust;
			if (s.mory != 0) s.speed_y = (s.speed_y * MULT - (thr * THRUST_SCALE) * ((double)s.mory * 0.5)) / MULT;
			if (s.morx != 0) s.speed_x = (s.speed_x * MULT - (thr * THRUST_SCALE) * ((double)s.morx * 0.5)) / MULT;
			if (!s.is_thrusting) {
				if (gt0(s.current_thrust)) s.current_thrust -= THRUST_BURN_OFF;
				else s.current_thrust = 0.0;
			}
		}

		// auto align to grid (not in liquids)
		const bool liquidCur = (flag(s.current) & F_LIQUID) != 0 && !isgodmod;
		if ((geP(s.speed_x, 1.0) || dle(s.speed_x, -1.0)) || liquidCur) {
		} else if (dlt(s.modifier_x, 0.1) && dgt(s.modifier_x, -0.1)) {
			const double tx = fmod16(s.px);
			if (dlt(tx, 2.0)) {
				if (dlt(tx, 0.2)) s.px = orZeroF(s.px);
				else s.px -= tx / 15.0;
			} else if (dgt(tx, 14.0)) {
				if (dgt(tx, 15.8)) { s.px = orZeroF(s.px); s.px += 1.0; }
				else s.px += (tx - 14.0) / 15.0;
			}
		}
		if ((geP(s.speed_y, 1.0) || dle(s.speed_y, -1.0)) || liquidCur) {
		} else if (dlt(s.modifier_y, 0.1) && dgt(s.modifier_y, -0.1)) {
			const double ty = fmod16(s.py);
			if (dlt(ty, 2.0)) {
				if (dlt(ty, 0.2)) s.py = orZeroF(s.py);
				else s.py -= ty / 15.0;
			} else if (dgt(ty, 14.0)) {
				if (dgt(ty, 15.8)) { s.py = orZeroF(s.py); s.py += 1.0; }
				else s.py += (ty - 14.0) / 15.0;
			}
		}

		// Me.updateStuff()
		if (!s.has_silver_crown && (s.run_ticks != 0 || s.horizontal != 0 || s.vertical != 0 || s.spacedown)) s.run_ticks += 1;
		s.on_ground = s.grounded;
		if (gtP(s.dead_offset, 16.0)) { respawn(); s.deaths++; }
		return false;
	}

	// fmod(x, 1) and fmod(x, 16) (eesim.js fmod1 / fmod16): for x > 0, x - trunc(x) and x - 16 * floor(x / 16)
	EE_HD static double fmod1(double x) { return gt0(x) ? x - truncD(x) : jsMod(x, 1.0); }
	EE_HD static double fmod16(double x) { return gt0(x) ? x - 16.0 * truncD(x * 0.0625) : jsMod(x, 16.0); }

	/** _portalTeleport; the loop temporaries are the caller's locals (by reference). */
	EE_COLD void portalTeleport(i32 slot, i32 cx, i32 cy, double& rem_x, double& cur_sx, double& rem_y, double& cur_sy) {
		s.last_portal_set = 1;
		s.last_portal_x = cx << 4;
		s.last_portal_y = cy << 4;
		i32 k = findSorted(L.exIds, L.nExIds, L.pTarget[slot]);
		if (k < 0) return;
		i32 e0 = L.exOff[k], e1 = L.exOff[k + 1];
		// live exits (entries deleted by a coin pickup excluded), in order
		i32 n = 0;
		for (i32 e = e0; e < e1; e++) if (exitLive(e)) n++;
		if (n <= 0) return;
		i32 pick = randiRange(0, n - 1);
		i32 cpx = 0, cpy = 0;
		for (i32 e = e0, j = 0; e < e1; e++) {
			if (!exitLive(e)) continue;
			if (j == pick) { cpx = L.exX[e]; cpy = L.exY[e]; break; }
			j++;
		}
		i32 oldRot = L.pRot[slot];
		i32 ns = L.portalSlot[(cpy >> 4) * L.W + (cpx >> 4)];
		i32 newRot = ns >= 0 ? L.pRot[ns] : 0;
		if (oldRot < newRot) oldRot += 4;
		const double osx = s.speed_x * MULT;
		const double osy = s.speed_y * MULT;
		const double omx = s.modifier_x * MULT;
		const double omy = s.modifier_y * MULT;
		const i32 dir = oldRot - newRot;
		const double magic = 1.42;
		switch (dir) {
		case 1:
			s.speed_x = (osy * magic) / MULT;
			s.speed_y = (-osx * magic) / MULT;
			s.modifier_x = (omy * magic) / MULT;
			s.modifier_y = (-omx * magic) / MULT;
			rem_y = -rem_x;
			cur_sy = -cur_sx;
			break;
		case 2:
			s.speed_x = (-osx * magic) / MULT;
			s.speed_y = (-osy * magic) / MULT;
			s.modifier_x = (-omx * magic) / MULT;
			s.modifier_y = (-omy * magic) / MULT;
			rem_y = -rem_y;
			cur_sy = -cur_sy;
			rem_x = -rem_x;
			cur_sx = -cur_sx;
			break;
		case 3:
			s.speed_x = (-osy * magic) / MULT;
			s.speed_y = (osx * magic) / MULT;
			s.modifier_x = (-omy * magic) / MULT;
			s.modifier_y = (omx * magic) / MULT;
			rem_x = -rem_y;
			cur_sx = -cur_sy;
			break;
		}
		s.px = (double)cpx;
		s.py = (double)cpy;
		s.last_portal_x = cpx;
		s.last_portal_y = cpy;
	}
	EE_HD bool exitLive(i32 e) const {
		if (L.nPortalCoins == 0) return true;
		i32 b = L.exPc[e];
		return !(b >= 0 && ((s.w[L.offPg + (b >> 5)] >> (b & 31)) & 1u) != 0);
	}

	/** _randiRange(from, to) */
	EE_COLD i32 randiRange(i32 from, i32 to) {
		if (from == to) return from;
		i32 lo = from < to ? from : to;
		if (L.rngScriptLen >= 0) {
			i32 k = s.rngSteps++;
			i32 n = (from > to ? from - to : to - from) + 1;
			i32 c = k < L.rngScriptLen ? L.rngScript[k] : -1;
			if (c < 0 || c >= n) { if (k >= L.rngScriptLen) s.rngNeed = n; c = 0; }
			return lo + c;
		}
		u32 bound = (u32)((from > to ? from - to : to - from) + 1);
		u32 threshold = (0u - bound) % bound;
		for (;;) {
			u64 old = s.rngState;
			s.rngState = old * 6364136223846793005ull + 2885390081777926815ull;   // PCG_INC = (1442695040888963407 << 1) | 1
			s.rngSteps++;
			u32 xorshifted = (u32)(((old >> 18) ^ old) >> 27);
			u32 rot = (u32)(old >> 59);
			u32 r = (xorshifted >> rot) | (xorshifted << ((0u - rot) & 31));
			if (r >= threshold) return (i32)(r % bound) + lo;
		}
	}

	EE_HD i32 getCurrentBelow(i32 current, i32 cx, i32 cy) const {
		i32 x = 0, y = 0;
		switch (current) {
		case 1: case 411: x -= 1; break;
		case 2: case 412: y -= 1; break;
		case 3: x += 1; break;
		case 4: y += 1; break;
		default:
			switch (s.flip_gravity) {
			case 0: y += 1; break;
			case 1: x -= 1; break;
			case 2: y -= 1; break;
			default: x += 1;
			}
		}
		return getTile(cx + x, cy + y);
	}

	// ================================================================ World.overlaps()
	EE_HD i32 overlaps() { return ovAt(s.px, s.py); }

	EE_HD i32 ovClass(double x, double y) {
		if (lt0(x) || lt0(y) || gtP(x, i2d(L.maxX)) || gtP(y, i2d(L.maxY))) return 1;
		if (s.in_god_mode) return 0;
		const i32 ox = truncI(x) >> 4, oy = truncI(y) >> 4;
		const i32 x2 = gtP(x + 16.0, i2d(ox * 16 + 16)) ? 1 : 0;
		const i32 y2 = gtP(y + 16.0, i2d(oy * 16 + 16)) ? 1 : 0;
		const i32 idx = x2 | (y2 << 1);
		const i32 req = idx == 0 ? 1 : (idx == 1 ? 3 : (idx == 2 ? 9 : 27));
		const i32 m = L.airMask[oy * L.W + ox];
		const i32 nonAir = req & ~m;
		if (nonAir == 0) { s.overlapa = -1; s.overlapb = -1; s.overlapc = -1; s.overlapd = -1; return 0; }
		if (((m >> 9) & nonAir & -nonAir) != 0) return 1;
		return -1;
	}

	EE_HD bool sweptAir(double minX, double maxX, double minY, double maxY) const {
		if (lt0(minX) || lt0(minY) || gtP(maxX, i2d(L.maxX)) || gtP(maxY, i2d(L.maxY))) return false;
		const i32 tx0 = truncI(minX) >> 4, ty0 = truncI(minY) >> 4;
		const i32 ox1 = truncI(maxX) >> 4, oy1 = truncI(maxY) >> 4;
		const i32 tx1 = ox1 + (gtP(maxX + 16.0, i2d(ox1 * 16 + 16)) ? 1 : 0);
		const i32 ty1 = oy1 + (gtP(maxY + 16.0, i2d(oy1 * 16 + 16)) ? 1 : 0);
		const i32 w = tx1 - tx0, h = ty1 - ty0;
		if (w <= 2 && h <= 2) {
			const i32 k = w + 3 * h;
			const i32 req = k == 0 ? 1 : k == 1 ? 3 : k == 2 ? 7 : k == 3 ? 9 : k == 4 ? 27 : k == 5 ? 63 : k == 6 ? 73 : k == 7 ? 219 : 511;
			return (L.airMask[ty0 * L.W + tx0] & req) == req;
		}
		const i32 W1 = L.W + 1;
		const i32* ps = L.airPS;
		return ps[(ty1 + 1) * W1 + tx1 + 1] - ps[ty0 * W1 + tx1 + 1] - ps[(ty1 + 1) * W1 + tx0] + ps[ty0 * W1 + tx0] == 0;
	}

	EE_HD i32 ovAt(double x, double y) {
		if (lt0(x) || lt0(y) || gtP(x, i2d(L.maxX)) || gtP(y, i2d(L.maxY))) return 1;
		if (s.in_god_mode) return 0;
		const i32 ox = truncI(x) >> 4, oy = truncI(y) >> 4;
		const i32 x2 = gtP(x + 16.0, i2d(ox * 16 + 16)) ? 1 : 0;
		const i32 y2 = gtP(y + 16.0, i2d(oy * 16 + 16)) ? 1 : 0;
		const i32 idx = x2 | (y2 << 1);
		const i32 req = idx == 0 ? 1 : (idx == 1 ? 3 : (idx == 2 ? 9 : 27));
		const i32 m = L.airMask[oy * L.W + ox];
		const i32 nonAir = req & ~m;
		if (nonAir == 0) { s.overlapa = -1; s.overlapb = -1; s.overlapc = -1; s.overlapd = -1; return 0; }
		if (((m >> 9) & nonAir & -nonAir) != 0) return 1;
		return ovSlow(x, y, ox, oy, ox + 1 + x2, oy + 1 + y2);
	}

	EE_HD static bool rectHit(double x, double y, double rx, double ry, double rw, double rh) {
		return x < rx + rw && rx < x + 16.0 && y < ry + rh && ry < y + 16.0;
	}

	EE_HD i32 ovSlow(double x, double y, i32 ox, i32 oy, i32 cxEnd, i32 cyEnd) {
		const i32 W = L.W;
		bool skipa = false, skipb = false, skipc = false, skipd = false;
		for (i32 cy = oy; cy < cyEnd; cy++) {
			const i32 row = cy * W;
			for (i32 cx = ox; cx < cxEnd; cx++) {
				const i32 k = L.ovl[row + cx];
				if (k == OV_AIR) continue;
				if (k == OV_SECRET) { revealSecret(cx, cy); continue; }
				const i32 val = tileAt(row + cx);
				const double tlx = i2d(cx * 16);
				const double tly = i2d(cy * 16);
				const double tlx16 = i2d(cx * 16 + 16), tly16 = i2d(cy * 16 + 16);   // = tlx + 16.0, tly + 16.0 (exact)
				if (!(dlt(x, tlx16) && dlt(tlx, x + 16.0) && dlt(y, tly16) && dlt(tly, y + 16.0))) continue;
				if (k == OV_SOLID) return val;
				const u8 fl = flag(val);
				if ((fl & (F_ROTHALF | F_HALF | F_JUMPTHRU)) != 0) {
					const i32 rot = L.lookup0[row + cx];
					if ((fl & F_ROTHALF) != 0) {
						if ((fl & F_JUMPTHRU) != 0) {
							if ((lt0(s.speed_y) || cy <= s.overlapa || (eq0(s.speed_y) && eq0(s.speed_x) && dgt(s.oy + 15.0, tly))) && rot == 1) {
								if (cy != oy || s.overlapa == -1) s.overlapa = cy;
								skipa = true;
								continue;
							}
							if ((gt0(s.speed_x) || (cx <= s.overlapb && !gt0(s.speed_x) && dlt(s.ox, tlx16))) && rot == 2) {
								if (cx != ox || s.overlapb == -1) s.overlapb = cx;
								skipb = true;
								continue;
							}
							if ((gt0(s.speed_y) || (cy <= s.overlapc && !gt0(s.speed_y) && dlt(s.oy, tly16))) && rot == 3) {
								if (cy != oy || s.overlapc == -1) s.overlapc = cy;
								skipc = true;
								continue;
							}
							if ((lt0(s.speed_x) || cx <= s.overlapd || (eq0(s.speed_y) && lt0(s.speed_x) && dlt(s.ox - 15.0, tlx))) && rot == 0) {
								if (cx != ox || s.overlapd == -1) s.overlapd = cx;
								skipd = true;
								continue;
							}
						}
					} else if ((fl & F_HALF) != 0) {
						if (rot == 1) { if (!rectHit(x, y, tlx, tly + 8.0, 16.0, 8.0)) continue; }
						else if (rot == 2) { if (!rectHit(x, y, tlx, tly, 8.0, 16.0)) continue; }
						else if (rot == 3) { if (!rectHit(x, y, tlx, tly, 16.0, 8.0)) continue; }
						else if (rot == 0) { if (!rectHit(x, y, tlx + 8.0, tly, 8.0, 16.0)) continue; }
					} else {
						if (lt0(s.speed_y) || cy <= s.overlapa || (eq0(s.speed_y) && eq0(s.speed_x) && dgt(s.oy + 15.0, tly))) {
							if (cy != oy || s.overlapa == -1) s.overlapa = cy;
							skipa = true;
							continue;
						}
					}
				}
				if ((fl & F_DOOR) != 0) {
					if (val == 50) revealSecret(cx, cy);
					else if (doorPassable(val, row + cx)) continue;
				}
				return val;
			}
		}
		if (!skipa) s.overlapa = -1;
		if (!skipb) s.overlapb = -1;
		if (!skipc) s.overlapc = -1;
		if (!skipd) s.overlapd = -1;
		return 0;
	}

	EE_HD bool doorPassable(i32 val, i32 i) const {
		const i32 km = s.keysMask;
		switch (val) {
		case 23: return (km & 1) != 0;
		case 24: return (km & 2) != 0;
		case 25: return (km & 4) != 0;
		case 26: return (km & 1) == 0;
		case 27: return (km & 2) == 0;
		case 28: return (km & 4) == 0;
		case 1005: return (km & 8) != 0;
		case 1006: return (km & 16) != 0;
		case 1007: return (km & 32) != 0;
		case 1008: return (km & 8) == 0;
		case 1009: return (km & 16) == 0;
		case 1010: return (km & 32) == 0;
		case 156: return s.timedoor_state != 0;
		case 157: return !s.timedoor_state;
		case DOOR_PURPLE: return swOn(L.lookup0[i]);
		case GATE_PURPLE: return !swOn(L.lookup0[i]);
		case DOOR_ORANGE: return oswOn(L.lookup0[i]);
		case GATE_ORANGE: return !oswOn(L.lookup0[i]);
		case DOOR_GOLD: return L.goldBorder != 0;
		case GATE_GOLD: return !L.goldBorder;
		case 1094: return s.collide_crown != 0;
		case 1095: return !s.collide_crown;
		case 1152: return s.collide_silver_crown != 0;
		case 1153: return !s.collide_silver_crown;
		case COINDOOR: return L.lookup0[i] <= s.coins;
		case BLUECOINDOOR: return L.lookup0[i] <= s.blue_coins;
		case DEATH_DOOR: return L.lookup0[i] <= s.deaths;
		case COINGATE: return L.lookup0[i] > s.show_coin_gate;
		case BLUECOINGATE: return L.lookup0[i] > s.show_blue_coin_gate;
		case DEATH_GATE: return L.lookup0[i] > s.show_death_gate;
		case TEAM_DOOR: return s.team == L.lookup0[i];
		case TEAM_GATE: return s.team != L.lookup0[i];
		case ZOMBIE_GATE: return !s.is_zombie;
		case ZOMBIE_DOOR: return s.is_zombie != 0;
		}
		return false;
	}

	EE_COLD void revealSecret(i32 cx, i32 cy) {
		const i32 b = L.secretBit[cy * L.W + cx];
		if (b < 0) return;   // (a 243 / 50 tile always has a secret bit)
		s.w[L.offSecret + (b >> 5)] |= 1u << (b & 31);
	}

	// ================================================================ Me.touchBlock()
	EE_HD static bool musicNoteValid(i32 id, i32 n) {
		if (id == PIANO) return n >= -27 && n <= 60;
		if (id == DRUMS) return n >= 0 && n <= 19;
		return n >= 0 && n <= 48;
	}
	EE_HD static double effectDuration(i32 v) {
		double d = (double)v;
		d += 2 * PING;
		d *= 100;
		return d;
	}

	EE_HD bool touchBlock(i32 cx, i32 cy, bool isgodmode) {
		const i32 current = s.current;
		if (current == COIN_GOLD || current == COIN_BLUE) {
			setTileCoin(cx, cy);
			if (current == COIN_GOLD) s.coins += 1; else s.blue_coins += 1;
		}
		if (s.pastx != cx || s.pasty != cy) {
			if (current == PIANO || current == DRUMS || current == GUITAR) {
				const i32 note = lookupAt(cx, cy);
				if (!musicNoteValid(current, note)) return false;
			}
			if (!isgodmode) {
				switch (current) {
				case CROWN:
					if (!s.has_crown) { s.has_crown = 0; checkCrown(false); s.has_crown = 1; checkCrown(true); }
					break;
				case SWITCH_PURPLE: { const i32 sid = lookupAt(cx, cy); pressPurpleSwitch(sid, !swOn(sid)); break; }
				case SWITCH_ORANGE: { const i32 osid = lookupAt(cx, cy); pressOrangeSwitch(osid, !oswOn(osid)); break; }
				case RESET_PURPLE: { const i32 rsid = lookupAt(cx, cy); if (rsid == 1000 || swOn(rsid)) pressPurpleSwitch(rsid, false); break; }
				case RESET_ORANGE: { const i32 rosid = lookupAt(cx, cy); if (rosid == 1000 || oswOn(rosid)) pressOrangeSwitch(rosid, false); break; }
				case CHECKPOINT: s.checkpoint_x = cx; s.checkpoint_y = cy; break;
				case BRICK_COMPLETE:
					if (!s.has_silver_crown) { s.has_silver_crown = 1; checkSilverCrown(true); }
					break;
				case 6: case 7: case 8: case 408: case 409: case 410: {
					const i32 col = current == 6 ? 0 : current == 7 ? 1 : current == 8 ? 2 : current == 408 ? 3 : current == 409 ? 4 : 5;
					switchKey(col, true, false);
					break;
				}
				case EFFECT_JUMP: { const i32 nj = lookupAt(cx, cy); if (s.jump_boost != nj) s.jump_boost = nj; break; }
				case EFFECT_RUN: { const i32 ns = lookupAt(cx, cy); if (s.speed_boost != ns) s.speed_boost = ns; break; }
				case EFFECT_LOW_GRAVITY: s.low_gravity = lookupAt(cx, cy) != 0; break;
				case EFFECT_PROTECTION: {
					const bool inv = lookupAt(cx, cy) != 0;
					if ((s.is_invulnerable != 0) != inv) {
						s.is_invulnerable = inv;
						if (inv) { s.is_cursed = 0; s.is_zombie = 0; s.is_poisoned = 0; s.is_on_fire = 0; }
					}
					break;
				}
				case EFFECT_RESET:
					s.jump_boost = 0; s.speed_boost = 0; s.is_invulnerable = 0; s.low_gravity = 0;
					s.max_jumps = 1; s.flip_gravity = 0;
					s.has_levitation = 0; s.current_thrust = 0.0;
					break;
				case EFFECT_FLY: {
					const bool lev = lookupAt(cx, cy) != 0;
					if ((s.has_levitation != 0) != lev) { s.has_levitation = lev; if (!lev) s.current_thrust = 0.0; }
					break;
				}
				case EFFECT_CURSE: {
					const i32 v = lookupAt(cx, cy);
					const bool on = v > 0;
					if ((s.is_cursed != 0) != on && !s.is_invulnerable) {
						s.is_cursed = on;
						if (on) { s.curse_time_start = s.ticks; s.curse_duration = effectDuration(v); }
					}
					break;
				}
				case EFFECT_ZOMBIE: {
					const i32 v = lookupAt(cx, cy);
					const bool on = v > 0;
					if ((s.is_zombie != 0) != on && !s.is_invulnerable) {
						s.is_zombie = on;
						if (on) { s.zombie_time_start = s.ticks; s.zombie_duration = effectDuration(v); }
					}
					break;
				}
				case EFFECT_POISON: {
					const i32 v = lookupAt(cx, cy);
					const bool on = v > 0;
					if ((s.is_poisoned != 0) != on && !s.is_invulnerable) {
						s.is_poisoned = on;
						if (on) { s.poison_time_start = s.ticks; s.poison_duration = effectDuration(v); }
					}
					break;
				}
				case NPC_ZOMBIE:
					if (!s.is_zombie && !s.is_invulnerable) { s.is_zombie = 1; s.zombie_time_start = 0; s.zombie_duration = 0.0; }
					break;
				case EFFECT_TEAM: updateTeamDoors(cx, cy); break;
				case LAVA:
					if (!s.is_on_fire && !s.is_invulnerable) { s.is_on_fire = 1; s.fire_time_start = s.ticks; s.fire_duration = effectDuration(2); }
					break;
				case WATER: case MUD: case TOXIC_WASTE: s.is_on_fire = 0; break;
				case EFFECT_MULTIJUMP: { const i32 jps = lookupAt(cx, cy); if (jps != s.max_jumps) s.max_jumps = jps; break; }
				case EFFECT_GRAVITY: { const i32 nf = lookupAt(cx, cy); if (s.flip_gravity != nf) s.flip_gravity = nf; break; }
				}
			}
			s.pastx = cx;
			s.pasty = cy;
		}
		return true;
	}

	/** _setTileCoin: the coin's bit (the tile follows it) and a portal entry at the cell deleted. */
	EE_COLD void setTileCoin(i32 cx, i32 cy) {
		const i32 i = cy * L.W + cx;
		if (L.nPortalCoins > 0) {
			const i32 b = L.portalCoinIdx[i];
			if (b >= 0) s.w[L.offPg + (b >> 5)] |= 1u << (b & 31);
		}
		const i32 b = L.coinBit[i];
		if (b >= 0) s.w[L.offCoin + (b >> 5)] |= 1u << (b & 31);
	}

	// ================================================================ keys, crowns, switches, spawn, teams
	EE_COLD void switchKey(i32 c, bool state, bool fromqueue) {
		setKey(c, state, fromqueue);
		if (overlaps() != 0) { setKey(c, !state, false); kqPush(c, state ? 1 : 0); }
	}
	EE_HD void setKey(i32 c, bool state, bool fromqueue) {
		if (fromqueue && (s.ticks - s.kt[c]) >= KEY_TICKS) return;
		if (state) s.keysMask |= (1 << c);
		else s.keysMask &= ~(1 << c);
		if (state && !fromqueue) s.kt[c] = s.ticks;
	}
	EE_COLD void checkCrown(bool collide) {
		s.collide_crown = collide;
		if (overlaps() != 0) { s.collide_crown = !collide; sqPush(SQ_CROWN, collide ? 1 : 0, 0); }
	}
	EE_COLD void checkSilverCrown(bool collide) {
		s.collide_silver_crown = collide;
		if (overlaps() != 0) { s.collide_silver_crown = !collide; sqPush(SQ_SILVER, collide ? 1 : 0, 0); }
	}
	/** _pressPurpleSwitch: switch 1000 presses 0..999 first (the JS recursion, one level deep, as a loop). */
	EE_COLD void pressPurpleSwitch(i32 sid, bool enabled) {
		if (sid == 1000) for (i32 i = 0; i < 1000; i++) pressPurpleOne(i, enabled);
		pressPurpleOne(sid, enabled);
	}
	EE_COLD void pressPurpleOne(i32 sid, bool enabled) {
		swSet(sid, enabled);
		if (overlaps() != 0) { swSet(sid, !enabled); tqPush(sid, enabled ? 1 : 0); }
	}
	EE_COLD void pressOrangeSwitch(i32 sid, bool enabled) {
		if (sid == 1000) for (i32 i = 0; i < 1000; i++) pressOrangeOne(i, enabled);
		pressOrangeOne(sid, enabled);
	}
	EE_COLD void pressOrangeOne(i32 sid, bool enabled) {
		oswSet(sid, enabled);
		if (overlaps() != 0) { oswSet(sid, !enabled); sqPush(SQ_ORANGE, sid, enabled ? 1 : 0); }
	}
	EE_HD void placeAtSpawn(bool useCheckpoint) {
		i32 nx = 1, ny = 1;
		if (useCheckpoint && s.checkpoint_x != -1) { nx = s.checkpoint_x; ny = s.checkpoint_y; }
		else if (L.nSpawns > 0) {
			if (s.next_spawn >= L.nSpawns) s.next_spawn = 0;
			nx = L.spawnsX[s.next_spawn];
			ny = L.spawnsY[s.next_spawn];
			s.next_spawn += 1;
		}
		s.px = (double)(nx * 16);
		s.py = (double)(ny * 16);
	}
	EE_COLD void respawn() {
		s.modifier_x = 0.0; s.modifier_y = 0.0;
		s.speed_x = 0.0; s.speed_y = 0.0;
		s.is_dead = 0;
		s.is_on_fire = 0;
		s.ntq = 0;
		placeAtSpawn(true);
		s.is_cursed = 0; s.is_zombie = 0; s.is_poisoned = 0;
	}
	EE_HD void killPlayer() { if (!s.in_god_mode && !s.is_dead) s.is_dead = 1; }
	EE_HD double jumpMultiplier() const {
		double jm = 1.0;
		if (s.jump_boost == 1) jm *= 1.3;
		if (s.jump_boost == 2) jm *= 0.75;
		if (s.is_zombie && !s.in_god_mode) jm *= 0.75;
		if (s.slippery > 0.0) jm *= 0.88;
		return jm;
	}
	EE_COLD void updateTeamDoors(i32 x, i32 y) {
		const i32 id = lookupAt(x, y);
		s.team_tx = x; s.team_ty = y;
		if (s.team == id) return;
		const i32 oid = s.team;
		s.team = id;
		if (overlaps() != 0) s.team = oid;
		else { s.team_tx = -1; s.team_ty = -1; }
	}

	// ================================================================ state hash (EESim.stateHash(false, noCoins))
	EE_COLD bool boxTouchesOneWay() const {
		const double x = s.px, y = s.py;
		if (x < 0.0 || y < 0.0 || x > (double)L.maxX || y > (double)L.maxY) return false;
		const i32 ox = toI32(trunc(x)) >> 4, oy = toI32(trunc(y)) >> 4;
		const i32 cxEnd = toI32(ceil((x + 16.0) / 16.0)), cyEnd = toI32(ceil((y + 16.0) / 16.0));
		for (i32 cy = oy; cy < cyEnd; cy++)
			for (i32 cx = ox; cx < cxEnd; cx++)
				if ((flag(tileAt(cy * L.W + cx)) & F_JUMPTHRU) != 0) return true;
		return false;
	}
	EE_HD double effectTimerKey(i32 start, double dur) const {
		if (s.is_dead) return -2.0;
		if (!(dur != 0.0 && dur == dur)) return 0.0;
		const double r = (double)start + floor(dur) + 1.0 - (double)s.ticks;
		return r > 1.0 ? r : 1.0;
	}

	struct Hasher {
		i32 h1, h2, words;
		EE_HD void init() { h1 = (i32)0x9747b28cu; h2 = (i32)0x85ebca6bu; words = 0; }
		EE_HD void word(i32 w) {
			i32 k = imul(w, (i32)0xcc9e2d51u);
			k = shl(k, 15) | (i32)ushr(k, 17);
			k = imul(k, 0x1b873593);
			h1 ^= k; h1 = shl(h1, 13) | (i32)ushr(h1, 19); h1 = (i32)((u32)imul(h1, 5) + 0xe6546b64u);
			h2 = imul(h2 ^ w, 0x5bd1e995); h2 ^= (i32)ushr(h2, 13);
			words++;
		}
		EE_HD void dbl(double d) { u64 b = doubleToBits(d); word((i32)(u32)b); word((i32)(u32)(b >> 32)); }
		EE_HD void ch(i32 c) { h1 = imul(h1 ^ c, 0x01000193); h2 = imul(h2 ^ c, 0x5bd1e995); h2 ^= (i32)ushr(h2, 15); }
		EE_HD void seq(i32 v) { ch(v & 0xFFFF); ch((i32)((ushr(v, 16)) & 0xFFFF)); }
		EE_HD u64 finish() {
			i32 a = h1, b = h2;
			a ^= words; a ^= (i32)ushr(a, 16); a = imul(a, (i32)0x85ebca6bu); a ^= (i32)ushr(a, 13); a = imul(a, (i32)0xc2b2ae35u); a ^= (i32)ushr(a, 16);
			b ^= (i32)ushr(b, 16); b = imul(b, 0x7feb352d); b ^= (i32)ushr(b, 15);
			return ((u64)(u32)a << 21) | (u64)((u32)b & 0x1fffffu);
		}
	};

	/** A second, independent 64-bit hash of the same key stream (FNV-1a): the host checks GPU hits with both. */
	struct Hasher2 {
		u64 h; i32 words;
		EE_HD void init() { h = 0xcbf29ce484222325ull; words = 0; }
		EE_HD void mix(u32 x) { for (int b = 0; b < 4; b++) { h ^= (x >> (8 * b)) & 0xffu; h *= 0x100000001b3ull; } }
		EE_HD void word(i32 w) { mix((u32)w); words++; }
		EE_HD void dbl(double d) { u64 b = doubleToBits(d); word((i32)(u32)b); word((i32)(u32)(b >> 32)); }
		EE_HD void ch(i32 c) { mix(0x10000u | (u32)(c & 0xFFFF)); }
		EE_HD void seq(i32 v) { ch(v & 0xFFFF); ch((i32)((ushr(v, 16)) & 0xFFFF)); }
		EE_HD u64 finish() { mix((u32)words); return h; }
	};

	/** EESim.stateHash(false, noCoins): the same 53-bit value (as an integer). */
	EE_HD u64 hash(bool noCoins) const { return hashWith<Hasher>(noCoins); }
	EE_HD u64 hash2(bool noCoins) const { return hashWith<Hasher2>(noCoins); }

	template <class HS>
	EE_COLD u64 hashWith(bool noCoins) const {
		// the doubles (in _fillKey order) and the flag word first: the ints are hashed before the doubles
		double F[16];
		i32 nd = 0;
		F[nd++] = s.px + 0; F[nd++] = s.py + 0; F[nd++] = s.speed_x + 0; F[nd++] = s.speed_y + 0;
		F[nd++] = s.slippery > 0.0 ? s.slippery : 0.0;
		i32 fl = 0;
		if (s.on_ground) fl |= 1;
		if (s.is_dead) { fl |= 2; F[nd++] = s.dead_offset + 0; }
		if (s.in_god_mode) fl |= 4;
		if (s.has_crown) fl |= 8;
		if (s.has_silver_crown) fl |= 16;
		if (s.collide_crown) fl |= 32;
		if (s.collide_silver_crown) fl |= 64;
		if (s.low_gravity) fl |= 128;
		if (s.is_invulnerable) fl |= 256;
		if (s.last_portal_set) fl |= 1024;
		if (s.is_cursed) { fl |= 65536; F[nd++] = effectTimerKey(s.curse_time_start, s.curse_duration); }
		if (s.is_zombie) { fl |= 131072; F[nd++] = effectTimerKey(s.zombie_time_start, s.zombie_duration); }
		if (s.is_on_fire) { fl |= 512; F[nd++] = effectTimerKey(s.fire_time_start, s.fire_duration); }
		if (s.is_poisoned) { fl |= 262144; F[nd++] = effectTimerKey(s.poison_time_start, s.poison_duration); }
		if (s.has_levitation) {
			fl |= 524288;
			F[nd++] = s.current_thrust + 0;
			if (s.is_thrusting && s.current_thrust != 0.0) fl |= 1048576;
		}
		if (s.is_dead || boxTouchesOneWay()) { fl |= 2048; F[nd++] = s.ox + 0; F[nd++] = s.oy + 0; }
		if (s.timedoor_state && L.hasTimeDoors) fl |= 8192;
		i32 teamPid = 0;
		if (L.hasTeamEffect && s.team_tx != -1) {
			const i32 pid = lookupAt(s.team_tx, s.team_ty);
			if (pid != s.team) { fl |= 2097152; teamPid = pid; }
		}
		HS h; h.init();
		h.word(fl);
		h.word(noCoins ? 0 : s.coins); h.word(noCoins ? 0 : s.blue_coins);
		h.word(s.jump_count); h.word(s.max_jumps); h.word(s.jump_boost); h.word(s.speed_boost);
		h.word(s.flip_gravity);
		h.word((s.checkpoint_x + 1) | shl(s.checkpoint_y + 1, 16));
		h.word(s.next_spawn);
		h.word((s.pastx + 1) | shl(s.pasty + 1, 16));
		h.word(s.q0); h.word(s.q1);
		h.word((s.overlapa + 1) | shl(s.overlapb + 1, 16));
		h.word((s.overlapc + 1) | shl(s.overlapd + 1, 16));
		h.word((s.grav_x + 1) + 3 * (s.grav_y + 1) + 16 * s.keysMask);
		i32 nI = 16;
		if (L.nKeyColors != 0) {
			i32 rel = s.keysMask;
			for (i32 q = 0; q < s.nkq; q++) rel |= 1 << s.kq[2 * q];
			for (i32 j = 0; j < L.nKeyColors; j++) {
				const i32 c = L.keyColors[j];
				if ((rel & (1 << c)) != 0) { const i32 r = s.kt[c] + KEY_TICKS - s.ticks; h.word(r > 1 ? r : 1); }
				else h.word(-1);
				nI++;
			}
		}
		if (L.hasTimeDoors) { h.word(s.ticks % TIMEDOOR_PERIOD); nI++; }
		if (L.hasDeathDoor) { h.word(s.deaths); nI++; }
		if (L.hasCoinGate) { h.word(s.show_coin_gate); nI++; }
		if (L.hasBlueCoinGate) { h.word(s.show_blue_coin_gate); nI++; }
		if (L.hasDeathGate) { h.word(s.show_death_gate); nI++; }
		if (L.multiTargetPortals) { h.word(s.rngSteps); nI++; }
		if (L.hasTeamEffect) { h.word(s.team); h.word(teamPid); nI += 2; }
		if (L.nCoins != 0) for (i32 w = 0; w < L.coinWords; w++) { h.word(noCoins ? 0 : (i32)s.w[L.offCoin + w]); nI++; }
		if (L.nSecrets != 0) for (i32 w = 0; w < L.secretWords; w++) { h.word((i32)s.w[L.offSecret + w]); nI++; }
		if (L.nPortalCoins > 0) for (i32 w = 0; w < L.pgWords; w++) { h.word((i32)s.w[L.offPg + w]); nI++; }
		if (nI & 1) h.word(0);   // the padding slot (always 0)
		for (i32 i = 0; i < nd; i++) h.dbl(F[i]);
		// the variable part (_varKey): switch on-sets, queues, frame phase
		for (int orange = 0; orange < 2; orange++) {
			const i32 nids = orange ? L.nOsw : L.nSw, off = orange ? L.offOsw : L.offSw;
			const i32* ids = orange ? L.oswIds : L.swIds;
			i32 cnt = 0;
			for (i32 k = 0; k < nids; k++) if ((s.w[off + (k >> 5)] >> (k & 31)) & 1u) cnt++;
			if (cnt == 0) continue;
			h.ch(orange ? 2 : 1);
			h.seq(cnt);
			for (i32 k = 0; k < nids; k++) if ((s.w[off + (k >> 5)] >> (k & 31)) & 1u) h.seq(ids[k]);
		}
		if (s.nsq != 0) { h.ch(3); h.seq(3 * s.nsq); for (i32 i = 0; i < 3 * s.nsq; i++) h.seq(s.sq[i]); }
		if (s.nkq != 0) { h.ch(4); h.seq(2 * s.nkq); for (i32 i = 0; i < 2 * s.nkq; i++) h.seq(s.kq[i]); }
		if (s.ntq != 0) { h.ch(5); h.seq(2 * s.ntq); for (i32 i = 0; i < 2 * s.ntq; i++) h.seq(s.tq[i]); }
		if (L.ticksPerFrame > 1) { h.ch(6); h.seq(1); h.seq(s.ticks % L.ticksPerFrame); }
		return h.finish();
	}
};

}  // namespace ee
