// search.h - candidate input sequences for the exact-rejoin search, shared by the GPU kernel and the host (which
// rebuilds and re-checks every hit on the CPU). A candidate is (start tick t, family, variant v, seed): from the
// reference state S(t) it plays a short "prefix" of new inputs, then the reference's own inputs from a later tick
// (t + skip). After the prefix, every state is looked up in the reference's state-hash table: a state equal to the
// reference state S(j) with j > t + k (k = ticks played) is an exact shortcut saving j - t - k ticks (mutate.js).
#pragma once
#include "eecore.h"

namespace ee {

enum Family { FAM_M1 = 0, FAM_DEL = 1, FAM_M2 = 2, FAM_PERT = 3, FAM_FLIP = 4, FAM_STICKY = 5, FAM_COUNT = 6 };

/** The 18 input options of the CPU tools: h in {0, L, R} x v in {0, U, D} x jump (index o = h * 6 + v * 2 + j). */
EE_HD i32 option(i32 o) {
	const i32 h = o / 6, v = (o / 2) % 3, j = o & 1;
	return (h == 1 ? 2 : h == 2 ? 4 : 0) | (v == 1 ? 8 : v == 2 ? 16 : 0) | j;
}
EE_HD u64 splitmix(u64 x) {
	x += 0x9e3779b97f4a7c15ull;
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
	x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
	return x ^ (x >> 31);
}
EE_HD u64 rnd(u64 seed, i32 t, i32 v, i32 q) {
	return splitmix(seed ^ splitmix(((u64)(u32)t << 32) ^ (u64)(u32)v) ^ ((u64)(u32)q * 0xd1342543de82ef95ull));
}

/** Prefilter key of a state: equal states have equal (px, py, speed_x, speed_y) (the hash's first four doubles, with
 *  -0 normalized the same way), so a state whose key bit is not set cannot equal any reference state. */
EE_HD u64 quadKey(double px, double py, double sx, double sy) {
	return splitmix(doubleToBits(px + 0) ^ splitmix(doubleToBits(py + 0) ^ splitmix(doubleToBits(sx + 0) ^ splitmix(doubleToBits(sy + 0)))));
}
static const int QBITS_LOG2 = 25;   // 32M bits = 4 MB

/** Variants per start tick for the systematic families (random families: any count). */
EE_HD i32 familyVariants(i32 f) {
	switch (f) {
	case FAM_M1: return 18 * 4 * 3;    // option x hold L 1..4 x drop D 0..2
	case FAM_DEL: return 32;           // drop D = 1..32 reference ticks
	case FAM_M2: return 5 * 18 * 18;   // gap g 1..5 x o1 x o2
	default: return 0;
	}
}

/** A candidate's shape. valid = false: skip it (a duplicate of the reference or of another variant). */
struct Cand {
	i32 t, v, family;
	u64 seed;
	i32 prefix;     // ticks of new inputs
	i32 skip;       // the suffix plays masks[t + skip + (k - prefix)]
	i32 a, b, c;    // family parameters
	bool valid;
};

EE_HD Cand makeCand(i32 family, i32 t, i32 v, u64 seed, const u8* masks, i32 n) {
	Cand c;
	c.t = t; c.v = v; c.family = family; c.seed = seed; c.valid = true; c.a = c.b = c.c = 0;
	switch (family) {
	case FAM_M1: {
		const i32 o = v % 18, L = 1 + (v / 18) % 4, D = v / 72;
		c.a = option(o); c.prefix = L; c.skip = L + D;
		if (D == 0) {   // identical to the reference?
			bool same = true;
			for (i32 q = 0; q < L; q++) if (t + q >= n || masks[t + q] != c.a) { same = false; break; }
			if (same) c.valid = false;
		}
		break;
	}
	case FAM_DEL: c.prefix = 0; c.skip = 1 + v; break;
	case FAM_M2: {
		const i32 g = 1 + v / 324, o1 = option((v / 18) % 18), o2 = option(v % 18);
		c.a = o1; c.b = o2; c.c = g; c.prefix = g + 1; c.skip = g + 1;
		if (t + g >= n || o1 == masks[t] || o2 == masks[t + g]) c.valid = false;
		break;
	}
	case FAM_PERT: case FAM_FLIP: case FAM_STICKY: {
		const u64 r = rnd(seed, t, v, -1);
		const i32 P = 5 + (i32)(r % 36);                      // prefix 5..40
		const i32 dsel = (i32)((r >> 8) % 16);
		const i32 D = dsel < 7 ? 1 : dsel < 13 ? 2 : 3 + (dsel - 13);   // drop 1 (most), 2, 3..5
		const i32 psel = (i32)((r >> 16) % 3);
		c.a = family == FAM_STICKY ? 150 : (psel == 0 ? 50 : psel == 1 ? 100 : 200);   // per-mille change rate
		c.b = D; c.prefix = P; c.skip = D + P;
		break;
	}
	default: c.valid = false;
	}
	if (t + c.skip > n) c.valid = false;
	return c;
}

/** The candidate's input at step k (0-based), or -1 when the reference has no more inputs. */
EE_HD i32 candInput(const Cand& c, const u8* masks, i32 n, i32 k, i32& sticky) {
	if (k >= c.prefix) {
		const i32 r = c.t + c.skip + (k - c.prefix);
		return r < n ? masks[r] : -1;
	}
	switch (c.family) {
	case FAM_M1: return c.a;
	case FAM_M2: return k == 0 ? c.a : (k == c.c ? c.b : masks[c.t + k]);
	case FAM_PERT: {
		const u64 r = rnd(c.seed, c.t, c.v, k);
		const i32 base = c.t + c.b + k < n ? masks[c.t + c.b + k] : 0;
		return (i32)(r % 1000) < c.a ? option((i32)((r >> 20) % 18)) : base;
	}
	case FAM_FLIP: {
		const u64 r = rnd(c.seed, c.t, c.v, k);
		i32 m = c.t + c.b + k < n ? masks[c.t + c.b + k] : 0;
		if ((i32)(r % 1000) < c.a) {
			const i32 what = (i32)((r >> 20) % 3);
			if (what == 0) m ^= 1;                                        // toggle jump
			else if (what == 1) { const i32 h = (m >> 1) & 3; m = (m & ~6) | ((h == 0 ? 1 : h == 1 ? 2 : 0) << 1); }   // none -> L -> R -> none
			else { const i32 vv = (m >> 3) & 3; m = (m & ~24) | ((vv == 0 ? 1 : vv == 1 ? 2 : 0) << 3); }
		}
		return m;
	}
	case FAM_STICKY: {
		const u64 r = rnd(c.seed, c.t, c.v, k);
		if (k == 0 || (i32)(r % 1000) < c.a) sticky = option((i32)((r >> 20) % 18));
		return sticky;
	}
	}
	return -1;
}

// ------------------------------------------------------------------ kernel interface (same layout on host and GPU)
/** A shortcut found by the GPU: from S(t), k ticks of the candidate reach S(j) (flags 1: the level finish, j = n). */
struct Hit { i32 t, v, k, j, family, flags; u64 seed; };

struct SearchParams {
	Level L;
	const u8* snaps; i32 stateBytes;
	const u8* masks; i32 n;
	const double* X; const double* Y;
	const u64* htKeys; const i32* htVals; u32 htMask;
	const u32* pix; i32 pixW, pixH;   // (unused: replaced by qbits)
	const u32* qbits;                 // 2^QBITS_LOG2 bits: quadKey of every reference state
	i32 nocoins, horizon; double drift;
	i32 family, t0, nT, V; u64 seed;
	Hit* hits; u32* hitCount; u32 hitCap;
	unsigned long long* stats;   // [0] ticks [1] candidates [2] death [3] drift [4] no-op/behind [5] horizon/end [6] hits [7] broken
};

}  // namespace ee
