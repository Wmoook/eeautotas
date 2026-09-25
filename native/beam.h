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
};

/** Progress along the guide (arc length at the closest point) minus weight * distance to it (float: a heuristic). */
EE_HD float guideScore(const BeamParams& p, float cx, float cy) {
	float best = -1e30f;
	for (i32 i = 0; i + 1 < p.nGuide; i++) {
		const float ax = p.gx[i], ay = p.gy[i], bx = p.gx[i + 1], by = p.gy[i + 1];
		const float dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
		float t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0.f;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const float qx = ax + t * dx - cx, qy = ay + t * dy - cy;
		const float d = sqrtf(qx * qx + qy * qy);
		const float sc = p.gs[i] + t * (p.gs[i + 1] - p.gs[i]) - p.guideWeight * d;
		if (sc > best) best = sc;
	}
	return best;
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

}  // namespace ee
