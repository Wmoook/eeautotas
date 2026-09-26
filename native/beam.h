// beam.h - guided beam search on the GPU, shared by the kernels and the host.
// A layer = up to K states at the same tick. Each state is expanded with the 18 input options (search.h option());
// every child is simulated one tick and scored. The host keeps the best K distinct children (dedupe by state hash,
// a cap per spatial bucket for diversity) and the GPU re-simulates them (from parent + option) into the next layer.
// Scores:
//   guide line (from the viewer or the editor): progress along the polyline minus a penalty for the distance to it;
//   goal (the editor's trophy): minus the walking distance to the goal over open tiles (a BFS field from the host);
//   both can be combined. A child that finishes the level, or (with a reference run) rejoins it later than it
//   could by playing the reference, is reported as a result.
#pragma once
#include "eecore.h"
#include "search.h"

namespace ee {

struct BeamChild {
	float score;
	u32 parent;     // index in the parent layer
	u64 hash;       // state hash (noCoins as configured)
	u8 option;      // 0..17 (search.h option())
	u8 flags;       // 1 dead, 2 finished, 4 rejoined (j in `rejoin`), 8 broken, 16 a twin of a lower option (not simulated)
	u16 bucket;     // spatial bucket id (low bits of the tile position and velocity signs), for the diversity cap
	i32 rejoin;     // reference tick j of an exact rejoin (flags & 4), else -1
};

/** The reach field v3 (src/reach.js, the RCH3 file): the cost to the trophy in fifths of a tile per abstract state of
 *  the ball, and the lookup from a real state (reachFifths: the same double operations as reach.js fifthsAt, so the
 *  JS and the GPU agree to the fifth; test/reach.js F). -1 = cut off: the physics model proves the trophy out of reach
 *  (every rule errs toward reachable). mode 1 (walk): plain walking distance, no proof of anything. on = 0: not loaded. */
struct ReachField {
	const u8* cls; const u8* seg; const i32* rowC; const i32* rowX; const u16* walk;
	const u16* costR; const u16* costF; const u16* costL; const u16* costC; const u16* costX;
	const double* segPush; const double* segCap; const double* modMin; const double* FV; const double* FS; const double* TH; const double* SW;
	double G, BD, ICE_ND, KT, TOL, MOD_STRONG;
	i32 W, H, mode, Q, prioShift, deaths, ice, nFlags, NFV, NTH, nSeg, nC, nX, on;
};
// every table read of the lookup goes through RF_AT (a host build with -DRF_CHECK aborts on an index out of its table:
// eegpu reachtest with such a build checks the lookup's bounds on the CPU; on the GPU it is a plain read)
#if defined(RF_CHECK) && !EE_GPU
#include <cstdlib>
inline void rfBad(const char* what, long long i, long long n) { fprintf(stderr, "reach lookup: %s index %lld out of [0, %lld)\n", what, i, n); abort(); }
#define RF_AT(arr, i, n) ((long long)(i) < 0 || (long long)(i) >= (long long)(n) ? (rfBad(#arr, (long long)(i), (long long)(n)), (arr)[0]) : (arr)[i])
#else
#define RF_AT(arr, i, n) ((arr)[i])
#endif
enum { RF_WALL = 0, RF_DEADLY = 1, RF_NORM = 2, RF_UP = 7, RF_BUP = 8, RF_BDOWN = 9, RF_KF = 16, RF_NL = 128, RF_CUT = 0xffff };
/** the engine's vertical speed update: (v + modifier) x drag, the cap, the snap to 0 */
EE_HD double rfStep(double s, double m, double d) {
	double v = (s + m) * d;
	if (v > 16.0) v = 16.0;
	else if (v < -16.0) v = -16.0;
	else if (v < 0.0001 && v > -0.0001) v = 0.0;
	return v;
}
/** the upward distance a ball moving up at u still covers in plain air (closed form of the engine's moves) */
EE_HD double rfAirRise(const ReachField& R, double u) {
	if (!(u > 0)) return 0;
	i32 lo = 0, hi = R.NTH - 1;
	while (lo < hi) { const i32 m = (lo + hi + 1) >> 1; if (u > RF_AT(R.TH, m, R.NTH)) lo = m; else hi = m - 1; }
	return (u + R.KT) * RF_AT(R.SW, lo, R.NTH) - (double)lo * R.KT;
}
/** the highest the ball rises from speed_y s: the queued modifiers m0, m1, then air; nIce ticks with the ice drag */
EE_HD double rfRiseQ(const ReachField& R, double s, double m0, double m1, i32 nIce) {
	double h = 0, best = 0;
	const i32 n = nIce > 2 ? nIce : 2;
	for (i32 j = 1; j <= n; j++) {
		s = rfStep(s, j == 1 ? m0 : j == 2 ? m1 : R.G, j <= nIce ? R.ICE_ND : R.BD);
		h -= s;
		if (h > best) best = h;
	}
	if (s < 0) { h += rfAirRise(R, -s); if (h > best) best = h; }
	return best;
}
/** the free fall's distance at speed v (the orbit table, linear between ticks); a huge number beyond its end */
EE_HD double rfFallD(const ReachField& R, double v) {
	if (!(v > 0)) return 0;
	if (v >= RF_AT(R.FV, R.NFV - 1, R.NFV)) return 1e300;
	i32 lo = 0, hi = R.NFV - 2;
	while (lo < hi) { const i32 m = (lo + hi + 1) >> 1; if (RF_AT(R.FV, m, R.NFV) <= v) lo = m; else hi = m - 1; }
	return RF_AT(R.FS, lo, R.NFV) + (v - RF_AT(R.FV, lo, R.NFV)) / (RF_AT(R.FV, lo + 1, R.NFV) - R.FV[lo]) * R.FV[lo + 1];
}
EE_HD i32 rfKOfX(double x) { if (x <= 16) return 0; if (!(x <= 16.0 * (RF_KF + 1))) return RF_KF; const i32 k = (i32)ceil(x / 16) - 1; return k < RF_KF ? k : RF_KF; }
EE_HD i32 rfQOf(const ReachField& R, double e) { const double q = ceil((e + R.TOL) / 8); return q < -1 ? -1 : q > R.Q ? R.Q : (i32)q; }
EE_HD i32 rfCOfV(double v) { if (v >= 16) return RF_NL - 1; const double c = ceil(v * 8 - 1e-9); return c > RF_NL - 1 ? RF_NL - 1 : (i32)c; }
/** the C (or XR) level of a ball rising at vy with its centre at cy in a row whose top edge is top, segment s */
EE_HD i32 rfCLevel(const ReachField& R, double top, i32 s, double cy, double vy, double m0, double m1, i32 nIce) {
	const double push = RF_AT(R.segPush, s, R.nSeg), cap = RF_AT(R.segCap, s, R.nSeg), mField = -push / 32;
	double v = vy, y = cy, umax = 0;
	const i32 n = nIce > 2 ? nIce : 2;
	for (i32 j = 1; j <= n; j++) {
		v = rfStep(v, j == 1 ? m0 : j == 2 ? m1 : mField, j <= nIce ? R.ICE_ND : R.BD);
		y += v;
		if (-v > umax) umax = -v;
	}
	const double u = v < 0 ? -v : 0, d = y - top;
	const double E2 = u * u + (d > 0 ? push * d / 16 : 0);
	double w = sqrt(E2);
	if (w > cap) w = cap;
	if (u > w) w = u;
	if (umax > w) w = umax;
	return rfCOfV(w);
}
/** the stored cost of (tile t, type, level); types 0 R, 1 F, 2 XR, 3 C, 4 L */
EE_HD u32 rfCost(const ReachField& R, i32 t, i32 ty, i32 l) {
	const size_t N = (size_t)R.W * R.H;
	if (ty == 0) return RF_AT(R.costR, (size_t)t * (R.Q + 3) + l + 1, N * (R.Q + 3));
	if (ty == 1) return RF_AT(R.costF, (size_t)t * (RF_KF + 1) + l, N * (RF_KF + 1));
	if (ty == 4) return RF_AT(R.costL, (size_t)t * (RF_KF + 1) + l, N * (RF_KF + 1));
	if (ty == 3) { const i32 r = RF_AT(R.rowC, t, N); return r < 0 ? RF_CUT : RF_AT(R.costC, (size_t)r * RF_NL + l, (size_t)R.nC * RF_NL); }
	const i32 r = RF_AT(R.rowX, t, N); return r < 0 ? RF_CUT : RF_AT(R.costX, (size_t)r * RF_NL + l, (size_t)R.nX * RF_NL);
}
/** a ball's abstract state (src/reach.js stateOf): its tile t (-1: off the level), a base (type bt, level bl; bt -1: none)
 *  and nr (0..2) rise descriptions (types rt, levels rl: R, then XR in a row next to fields). The walk mode and a wall
 *  tile: none of them. Types: 0 R, 1 F, 2 XR, 3 C, 4 L. */
struct RfState { i32 t, bt, bl, nr, rt[2], rl[2]; };
EE_HD RfState rfStateOf(const ReachField& R, double px, double py, double vy, i32 q0, i32 q1, double slip) {
	RfState s;
	s.t = -1; s.bt = -1; s.bl = 0; s.nr = 0; s.rt[0] = s.rt[1] = 0; s.rl[0] = s.rl[1] = 0;
	const i32 tx = truncI(px + 8.0) >> 4, ty = truncI(py + 8.0) >> 4;
	if (tx < 0 || ty < 0 || tx >= R.W || ty >= R.H) return s;
	const i32 t = ty * R.W + tx;
	const size_t N = (size_t)R.W * R.H;
	s.t = t;
	if (R.mode == 1) return s;
	const i32 g = RF_AT(R.cls, t, N);
	if (g == RF_WALL) return s;
	if (g == RF_DEADLY) { if (R.deaths) { s.bt = 1; s.bl = 0; } return s; }
	if (g == RF_BUP) { s.bt = 0; s.bl = R.Q + 1; return s; }
	if (g == RF_BDOWN) { s.bt = 1; s.bl = RF_KF; return s; }
	const double m0 = q0 >= 0 && q0 < R.nFlags ? RF_AT(R.modMin, q0, R.nFlags) : R.MOD_STRONG, m1 = q1 >= 0 && q1 < R.nFlags ? RF_AT(R.modMin, q1, R.nFlags) : R.MOD_STRONG;
	const i32 nIce = R.ice && slip > 0 ? (i32)floor(slip / 0.2 + 0.5) : 0;
	const double cy = py + 8, top = 16.0 * ty;
	double fv = vy, fy = cy;
	for (i32 j = 1; j <= nIce; j++) { fv = rfStep(fv, R.G, R.ICE_ND); fy += fv; }
	const i32 k = rfKOfX(rfFallD(R, fv > 0 ? fv : 0) + (top + 16 - fy));
	if (g != RF_NORM) {
		if (vy < 0) { s.bt = 3; s.bl = rfCLevel(R, top, RF_AT(R.seg, t, N), cy, vy, m0, m1, nIce); }
		else { s.bt = 1; s.bl = k; }
		return s;
	}
	if (!(vy < 0)) { s.bt = cy > top + 8 ? 4 : 1; s.bl = k; }
	const double rise = rfRiseQ(R, vy, m0, m1, nIce);
	if (!(vy < 0) && !(rise > 0)) return s;
	const bool lid = ty == 0 || RF_AT(R.cls, t - R.W, N) == RF_WALL;
	i32 q = rfQOf(R, top - (cy - rise));
	if (lid && q > 0) q = 0;
	s.rt[0] = 0; s.rl[0] = q; s.nr = 1;
	if (RF_AT(R.rowX, t, N) >= 0) {
		s.rt[1] = 2; s.nr = 2;
		s.rl[1] = lid ? rfCLevel(R, top, RF_AT(R.seg, t, N), cy < top + 8 ? cy : top + 8, 0, m0, m1, nIce) : rfCLevel(R, top, RF_AT(R.seg, t, N), cy, vy, m0, m1, nIce);
	}
	return s;
}
/** the stored cost of state s at tile j (RF_CUT: cut off). rebase: j is a neighbour tile dRow rows below s's own (the
 *  beam's blend, reach.js blendCost): the ball's state re-referenced to it (R: its apex stays, 2 levels per row down, j's
 *  own lid; XR, C, F, L: the same level; a type j holds no state of is left out) */
EE_HD u32 rfStateCost(const ReachField& R, const RfState& s, i32 j, bool rebase, i32 dRow) {
	const size_t N = (size_t)R.W * R.H;
	u32 v = RF_CUT;
	if (s.nr > 0) {
		bool any = false;
		v = 0;
		for (i32 e = 0; e < s.nr; e++) {
			i32 l = s.rl[e];
			if (rebase && s.rt[e] == 0) {
				l += 2 * dRow;
				if (l > R.Q) l = R.Q;
				if (l < -1) l = -1;
				if ((j < R.W || RF_AT(R.cls, j - R.W, N) == RF_WALL) && l > 0) l = 0;
			} else if (rebase && s.rt[e] == 2 && RF_AT(R.rowX, j, N) < 0) continue;
			any = true;
			const u32 c = rfCost(R, j, s.rt[e], l);
			if (c > v) v = c;
		}
		if (!any) v = RF_CUT;
	}
	if (s.bt >= 0) { const u32 b = rfCost(R, j, s.bt, s.bl); v = s.nr > 0 ? (b < v ? b : v) : b; }
	return v;
}
/** the cost (fifths) of the ball in state s: -1 = cut off (the walk mode: the walking distance of its tile) */
EE_HD i32 rfFifths(const ReachField& R, const RfState& s) {
	if (s.t < 0) return -1;
	if (R.mode == 1) { const u32 w = RF_AT(R.walk, s.t, (size_t)R.W * R.H); return w == RF_CUT ? -1 : (i32)w; }
	const u32 v = rfStateCost(R, s, s.t, false, 0);
	return v == RF_CUT ? -1 : (i32)v;
}
/** the cost (fifths) of a ball: top-left px, py; speed_y vy; the gravity queue q0, q1; slippery. -1 = cut off.
 *  (src/reach.js fifthsAt, the same numbers) */
EE_HD i32 reachFifths(const ReachField& R, double px, double py, double vy, i32 q0, i32 q1, double slip) {
	return rfFifths(R, rfStateOf(R, px, py, vy, q0, q1, slip));
}
/** the beam's score in tiles (src/reach.js scoreAt, the same doubles): the cost blended bilinearly between the centres of
 *  the 4 tiles around the ball's centre, each with the ball's own state s re-referenced to it (rfStateCost; walls,
 *  deadly and cut-off tiles left out), for a smooth gradient; the own tile's cost `own` (rfFifths(s) >= 0) when all the
 *  others are left out. One lookup and 4 table reads per state. */
EE_HD float reachScore(const ReachField& R, const RfState& s, double px, double py, i32 own) {
	const size_t N = (size_t)R.W * R.H;
	const double fx = (px + 8.0) / 16.0 - 0.5, fy = (py + 8.0) / 16.0 - 0.5;
	const i32 x0 = (i32)floor(fx), y0 = (i32)floor(fy);
	const i32 tx = truncI(px + 8.0) >> 4, ty = truncI(py + 8.0) >> 4;
	const double ax = fx - x0, ay = fy - y0;
	double v = 0, w = 0;
	for (i32 dy = 0; dy < 2; dy++) for (i32 dx = 0; dx < 2; dx++) {
		const i32 x = x0 + dx, y = y0 + dy;
		u32 c;
		if (x == tx && y == ty) c = (u32)own;
		else if (x < 0 || y < 0 || x >= R.W || y >= R.H) continue;
		else {
			const i32 j = y * R.W + x;
			if (R.mode == 1) c = RF_AT(R.walk, j, N);
			else {
				const i32 g = RF_AT(R.cls, j, N);
				if (g == RF_WALL || g == RF_DEADLY) continue;
				c = rfStateCost(R, s, j, true, y - ty);
			}
			if (c == RF_CUT) continue;
		}
		const double k = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
		v += k * (double)c; w += k;
	}
	return (float)(w > 1e-9 ? v / w / 5.0 : own / 5.0);
}

struct BeamParams {
	Level L;
	const u8* parents; i32 stateBytes; i32 nParents;
	u8* next;                         // materialize: the new layer's states
	const u32* pick; i32 nPick;       // materialize: (parent << 5 | option) per new state
	BeamChild* out;
	// guide polyline in pixel coordinates of the box centre: (gx[i], gy[i]), cumulative length gs[i]
	const float* gx; const float* gy; const float* gs; i32 nGuide; float guideWeight;
	// goal distance field (tiles), -1 = unreachable; goalWeight 0 = off
	const float* goalDist; float goalWeight;
	// exact rejoin with a reference run (nRef > 0): hash table of the reference states and their prefilter
	const u64* htKeys; const i32* htVals; u32 htMask; const u32* qbits;
	i32 layerTick;                    // reference tick the layer's states "stand for" (start tick + depth)
	i32 nocoins;
	// back to the run after the guide: per tile, the first reference tick >= refFrom that visits it (-1 = none); past
	// the line's end a state scores by how far along the run its tile is (so the beam heads for exact rejoins)
	const i32* refTile; i32 refFrom; float lineLen;
	// the run's per-tick position and speed (float; for the closeness score), n + 1 entries
	const float* rX; const float* rY; const float* rSX; const float* rSY; i32 nRef;
	unsigned long long* closest;       // per layer: min of (orderedScore(goal distance) << 32 | parent << 5 | option) (null = off)
	ReachField reach;                  // when on: the score's and the closest attempt's distance (instead of goalDist)
	unsigned long long* stats;         // expand: [0] ticks simulated, [1] children skipped as twins of a lower option (flag 16)
};

/** Past the guide: the best "closeness" to a state of the run on this tile, favouring later ticks: states that are
 *  almost equal to a run state become exactly equal at the next wall hit, landing, boost or portal. */
EE_HD float runMatchScore(const BeamParams& p, i32 r0, float px, float py, float sx, float sy) {
	float best = -1e30f;
	for (i32 r = r0; r < r0 + 24 && r < p.nRef; r++) {
		const float d = fabsf(px - p.rX[r]) + fabsf(py - p.rY[r]) + 3.f * (fabsf(sx - p.rSX[r]) + fabsf(sy - p.rSY[r]));
		const float sc = 4.f * (float)(r - p.refFrom) - 6.f * d;
		if (sc > best) best = sc;
	}
	return best;
}

/** Progress along the guide at the point of the line NEAREST to the ball (arc length there; the later one on a tie)
 *  minus weight * the distance to it (float: a heuristic). (Taking the best "progress - weight * distance" over the
 *  whole line instead would credit a ball far from the line with the line's far end.) */
EE_HD float guideScore(const BeamParams& p, float cx, float cy) {
	float bestD = 1e30f, prog = 0.f;
	for (i32 i = 0; i + 1 < p.nGuide; i++) {
		const float ax = p.gx[i], ay = p.gy[i], bx = p.gx[i + 1], by = p.gy[i + 1];
		const float dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
		float t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0.f;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const float qx = ax + t * dx - cx, qy = ay + t * dy - cy;
		const float d = sqrtf(qx * qx + qy * qy);
		const float arc = p.gs[i] + t * (p.gs[i + 1] - p.gs[i]);
		if (d < bestD - 0.01f || (d <= bestD + 0.01f && arc > prog)) { bestD = d; prog = arc; }
	}
	return prog - p.guideWeight * bestD;
}
/** Walking distance to the goal (gd: the goal field, tiles), bilinear between tile centres (lower = closer; 1e6 where
 *  unreachable). */
EE_HD float goalDistAt(const float* gd, const Level& L, float cx, float cy) {
	const float fx = cx / 16.f - 0.5f, fy = cy / 16.f - 0.5f;
	i32 x0 = (i32)floorf(fx), y0 = (i32)floorf(fy);
	const float ax = fx - x0, ay = fy - y0;
	float v = 0, w = 0;
	for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
		const i32 x = x0 + dx, y = y0 + dy;
		if (x < 0 || y < 0 || x >= L.W || y >= L.H) continue;
		const float d = gd[y * L.W + x];
		if (d < 0) continue;
		const float k = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
		v += k * d; w += k;
	}
	return w > 1e-6f ? v / w : 1e6f;
}
EE_HD float goalScore(const BeamParams& p, const Level& L, float cx, float cy) { return goalDistAt(p.goalDist, L, cx, cy); }

/** The per-layer selection on the GPU, the same as walking the children by score: dedupe by state hash (the best score
 *  wins), a histogram of the winners' scores, then rounds of picks from the best bins down (a few bins per round; the
 *  order inside a round is arbitrary) with a per-bucket cap; the states over the cap, in round order, fill up the layer
 *  when the capped pick ends short. */
struct BeamSel {
	const BeamChild* kids; i32 nKids;
	u64* hKeys; u64* hBest; u32 hMask;   // dedupe table (cleared every layer)
	u32* slot; u8* win;                  // per child: its table slot (~0u = not a candidate), winner flag
	u32* mm;                             // [0] min, [1] max ordered score of the winners
	u32* hist; i32 nBins; u32 lo, binW;  // histogram of the winners' ordered scores
	u32* bucketCnt; i32 bucketCap;       // per bucket (65536)
	u32* pick; u32* nPick; u32 K;        // the next layer: parent << 5 | option
	u32* over; u32* nOver; u32 overCap;  // winners over the bucket cap, in round order (for filling up)
	u32* res; u32* nRes; u32 resCap;     // result children (finish / rejoin)
};
/** float -> u32 with the same order */
EE_HD u32 floatBits(float f) {
#if EE_GPU
	return (u32)__float_as_uint(f);
#else
	u32 b; memcpy(&b, &f, 4); return b;
#endif
}
EE_HD float bitsFloat(u32 b) {
#if EE_GPU
	return __uint_as_float(b);
#else
	float f; memcpy(&f, &b, 4); return f;
#endif
}
EE_HD u32 orderedScore(float f) { const u32 b = floatBits(f); return (b & 0x80000000u) ? ~b : (b | 0x80000000u); }
EE_HD i32 scoreBin(const BeamSel& q, u32 k) { const u32 b = (k - q.lo) / q.binW; return b >= (u32)q.nBins ? q.nBins - 1 : (i32)b; }
EE_HD float scoreFromOrdered(u32 k) { return bitsFloat((k & 0x80000000u) ? (k & 0x7fffffffu) : ~k); }

}  // namespace ee
