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
	u8 flags;       // 1 dead, 2 finished, 4 rejoined (j in `rejoin`), 8 broken
	u16 bucket;     // spatial bucket id (low bits of the tile position and velocity signs), for the diversity cap
	i32 rejoin;     // reference tick j of an exact rejoin (flags & 4), else -1
};

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
/** Walking distance to the goal, bilinear between tile centres (lower = closer; 1e6 where unreachable). */
EE_HD float goalScore(const BeamParams& p, const Level& L, float cx, float cy) {
	const float fx = cx / 16.f - 0.5f, fy = cy / 16.f - 0.5f;
	i32 x0 = (i32)floorf(fx), y0 = (i32)floorf(fy);
	const float ax = fx - x0, ay = fy - y0;
	float v = 0, w = 0;
	for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
		const i32 x = x0 + dx, y = y0 + dy;
		if (x < 0 || y < 0 || x >= L.W || y >= L.H) continue;
		const float d = p.goalDist[y * L.W + x];
		if (d < 0) continue;
		const float k = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
		v += k * d; w += k;
	}
	return w > 1e-6f ? v / w : 1e6f;
}

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
