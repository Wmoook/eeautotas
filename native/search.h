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
/** Twins: from one state, option o gives exactly the state of the option canonOption(o) <= o, the same option without
 *  its input bits that were unused (Sim::inUsed; e.g. up / down under normal gravity, a jump that cannot fire).
 *  used = inUsed() of option 0's tick (its axis and timer bits hold for every option: they depend on the tile queue,
 *  not on the input); jumpUsed bit h * 3 + v = inUsed() & 1 of option (h, v, no jump)'s tick (the movement before the
 *  jump test depends on h and v). A search needs to simulate only the options with canonOption(o) == o: option 0, and
 *  every other o after the options below it (whose flags it reads). The canonical option has the fewest pressed bits,
 *  so it wins every tie-break by option index and never starts the run timer sooner. */
EE_HD i32 canonOption(i32 o, u32 used, u32 jumpUsed) {
	const i32 h = (used & 6) ? o / 6 : 0, v = (used & 24) ? (o / 2) % 3 : 0;
	const i32 j = (o & 1) && ((jumpUsed >> (h * 3 + v)) & 1) ? 1 : 0;
	return h * 6 + v * 2 + j;
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

/** The systematic twins of one start tick (Searcher::twin, filled by twinBits on the GPU or the CPU): bit v (m1,
 *  0..215) or M1_VARIANTS + v (m2) set = the variant plays exactly like a variant with a lower option index (an input
 *  bit unused on every tick it differs), so it is skipped. TWIN_WORDS words per tick. */
static const int M1_VARIANTS = 18 * 4 * 3, M2_VARIANTS = 5 * 18 * 18, TWIN_WORDS = (M1_VARIANTS + M2_VARIANTS + 31) / 32;

/** One tick of mask m on s; returns Sim::inUsed() of it. Out of line on the GPU (EE_COLD): the twin table's code
 *  (canonMap, twinBits) reaches the engine only through here, so the twins kernel holds one copy of Sim::tick instead
 *  of one per call site (with four it was the module's largest kernel: the PTX grew 42% instead of 11%, and with it
 *  the NVRTC build and the driver's JIT). */
template <int TW>
EE_COLD u32 tickUsed(const Level& L, State<TW>& s, i32 m) {
	Sim<TW> sim(L, s);
	Input in = maskInput(m);
	sim.tick(in);
	return sim.inUsed();
}

/** canon[o] = canonOption(o) from state st: the option that gives exactly o's next state (o itself when o must be
 *  simulated). Simulates option 0 and the canonical no-jump options (at most 9 ticks; tmp = scratch). */
template <int TW>
EE_HD void canonMap(const Level& L, const State<TW>& st, State<TW>& tmp, u8 canon[18]) {
	u32 used = 31, jumpUsed = 0;
	for (i32 o = 0; o < 18; o++) {
		const i32 c = o > 0 ? canonOption(o, used, jumpUsed) : 0;
		canon[o] = (u8)c;
		if (c != o || (o & 1)) continue;   // (a jump option's own flags are not needed)
		tmp = st;
		const u32 u = tickUsed<TW>(L, tmp, option(o));
		if (o == 0) used = u;
		jumpUsed |= (u & 1u) << (o >> 1);
	}
}

/** The systematic variants with option o (m1) or o1 = o (m2) from start tick t (state st) that play exactly like a
 *  variant with a lower option index, by the engine's own flags (Sim::inUsed); set(bit) marks each (bit v for m1,
 *  M1_VARIANTS + v for m2; see makeCand). a, b: scratch states. The same code fills the table on the GPU and the host.
 *    m1 (o held L ticks): o is held 4 ticks; a pressed axis (L/R, U/D) or jump unused on every tick of the hold can go,
 *       and the rest of the variant (the drop, the reference's inputs) is the same, so the variant without it plays alike;
 *    m2 (o1, the reference for g - 1 ticks, o2): o1 by the m1 rule at L = 1; o2 by canonMap of the state the canonical
 *       o1 and the reference's inputs lead to. */
template <int TW, class F>
EE_HD void twinBits(const Level& L, const State<TW>& st, const u8* masks, i32 n, i32 t, i32 o, bool m1, bool m2, State<TW>& a, State<TW>& b, F set) {
	a = st;
	bool canon1 = true;
	{
		bool hFree = o / 6 != 0, vFree = (o / 2) % 3 != 0, jFree = (o & 1) != 0;   // pressed, unused on every tick so far
		for (i32 hold = 1; hold <= (m1 ? 4 : 1); hold++) {
			const u32 u = tickUsed<TW>(L, a, option(o));
			if (u & 6) hFree = false;
			if (u & 24) vFree = false;
			if (u & 1) jFree = false;
			const bool tw = hFree || vFree || jFree;
			if (hold == 1) canon1 = !tw;
			if (tw && m1) for (i32 D = 0; D < 3; D++) set(o + 18 * (hold - 1) + 72 * D);
		}
	}
	if (!m2) return;
	if (!canon1) {   // a twin of a lower o1: every (g, o2)
		for (i32 g = 1; g <= 5; g++) for (i32 o2 = 0; o2 < 18; o2++) set(M1_VARIANTS + (g - 1) * 324 + o * 18 + o2);
		return;
	}
	a = st;
	tickUsed<TW>(L, a, option(o));
	for (i32 g = 1; g <= 5 && t + g < n; g++) {
		if (g > 1) tickUsed<TW>(L, a, masks[t + g - 1]);
		u8 canon[18];
		canonMap<TW>(L, a, b, canon);
		for (i32 o2 = 0; o2 < 18; o2++) if (canon[o2] != o2) set(M1_VARIANTS + (g - 1) * 324 + o * 18 + o2);
	}
}

/** The random families' step draw: seed for resample round c.c (round 0 = the plain seed) */
EE_HD u64 stepSeed(const Cand& c) { return c.c ? splitmix(c.seed + 0x2545f4914f6cdd1dull * (u64)c.c) : c.seed; }
/** the input bits that can act on a candidate near the reference's tick t: the axes that act there (the axis byte: 6
 *  L/R, 24 U/D; bit 1 = a jump could fire, not used: whether a candidate's jump fires depends on its own landing
 *  timing, which the random families shift) and the jump; all when unknown */
EE_HD i32 actBits(const u8* axis, i32 n, i32 t) { return axis && t >= 0 && t < n ? (axis[t] & 30) | 1 : 31; }
/** flip's change at step k (0-based, r = the step's draw): toggle the jump, cycle L/R (none -> L -> R -> none) or U/D,
 *  only on an axis that acts on the reference's tick there (axis byte; changing an inert one changes nothing) */
EE_HD i32 flipMask(i32 m, u64 r, i32 act) {
	i32 grp[3], ng = 0;
	if (act & 1) grp[ng++] = 0;
	if (act & 6) grp[ng++] = 1;
	if (act & 24) grp[ng++] = 2;
	if (!ng) return m;
	const i32 what = grp[(i32)((r >> 20) % (u64)ng)];
	if (what == 0) m ^= 1;
	else if (what == 1) { const i32 h = (m >> 1) & 3; m = (m & ~6) | ((h == 0 ? 1 : h == 1 ? 2 : 0) << 1); }
	else { const i32 vv = (m >> 3) & 3; m = (m & ~24) | ((vv == 0 ? 1 : vv == 1 ? 2 : 0) << 3); }
	return m;
}
/** pert / flip: does the prefix change at least one input bit that acts (by the reference's axis bytes)? Without one
 *  the candidate is `del` (a copy of the reference's inputs, shifted). */
EE_HD bool randomChanges(const Cand& c, const u8* masks, i32 n, const u8* axis) {
	const u64 sd = stepSeed(c);
	for (i32 k = 0; k < c.prefix; k++) {
		const u64 r = rnd(sd, c.t, c.v, k);
		if ((i32)(r % 1000) >= c.a) continue;
		const i32 base = c.t + c.b + k < n ? masks[c.t + c.b + k] : 0, act = actBits(axis, n, c.t + k);
		const i32 m = c.family == FAM_PERT ? option((i32)((r >> 20) % 18)) : flipMask(base, r, act);
		if ((m ^ base) & act) return true;
	}
	return false;
}

/** A candidate (family, start tick t, variant v, seed). axis: the reference's axis bytes per tick (Searcher::axis;
 *  null = every bit acts) for pert / flip; twin: the systematic twins (Searcher::twin, host side; null = none). */
EE_HD Cand makeCand(i32 family, i32 t, i32 v, u64 seed, const u8* masks, i32 n, const u8* axis, const u32* twin) {
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
		if (twin && ((twin[(size_t)t * TWIN_WORDS + (v >> 5)] >> (v & 31)) & 1u)) c.valid = false;
		break;
	}
	case FAM_DEL: c.prefix = 0; c.skip = 1 + v; break;
	case FAM_M2: {
		const i32 g = 1 + v / 324, o1 = option((v / 18) % 18), o2 = option(v % 18);
		c.a = o1; c.b = o2; c.c = g; c.prefix = g + 1; c.skip = g + 1;
		if (t + g >= n || o1 == masks[t] || o2 == masks[t + g]) c.valid = false;
		const i32 b = M1_VARIANTS + v;
		if (twin && ((twin[(size_t)t * TWIN_WORDS + (b >> 5)] >> (b & 31)) & 1u)) c.valid = false;
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
		// pert / flip: new draws of the steps (same shape) until one changes an input that acts; none after 8 = a
		// copy of `del`
		if (family != FAM_STICKY) {
			while (c.c < 8 && !randomChanges(c, masks, n, axis)) c.c++;
			if (c.c == 8) c.valid = false;
		}
		break;
	}
	default: c.valid = false;
	}
	if (t + c.skip > n) c.valid = false;
	return c;
}

/** The candidate's input at step k (0-based), or -1 when the reference has no more inputs. */
EE_HD i32 candInput(const Cand& c, const u8* masks, i32 n, const u8* axis, i32 k, i32& sticky) {
	if (k >= c.prefix) {
		const i32 r = c.t + c.skip + (k - c.prefix);
		return r < n ? masks[r] : -1;
	}
	switch (c.family) {
	case FAM_M1: return c.a;
	case FAM_M2: return k == 0 ? c.a : (k == c.c ? c.b : masks[c.t + k]);
	case FAM_PERT: {
		const u64 r = rnd(stepSeed(c), c.t, c.v, k);
		const i32 base = c.t + c.b + k < n ? masks[c.t + c.b + k] : 0;
		return (i32)(r % 1000) < c.a ? option((i32)((r >> 20) % 18)) : base;
	}
	case FAM_FLIP: {
		const u64 r = rnd(stepSeed(c), c.t, c.v, k);
		const i32 m = c.t + c.b + k < n ? masks[c.t + c.b + k] : 0;
		return (i32)(r % 1000) < c.a ? flipMask(m, r, actBits(axis, n, c.t + k)) : m;
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
	const u8* axis;              // the reference's axis byte per tick (pert / flip; see makeCand)
	const u32* list; u32 nList;  // non-null: the launch's candidates, (t - t0) * V + v each (systematic families without their twins)
};

}  // namespace ee
