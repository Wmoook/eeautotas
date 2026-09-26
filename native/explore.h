// explore.h - exhaustive layer-by-layer exploration on the GPU (`eegpu explore`), shared by the kernels and the host.
// Every state of a layer is expanded with the 18 input options; a child is kept once per "cell" (a GPU hash set that
// persists over the layers, so each physical situation is expanded only at its earliest tick). The cell is the exact
// vertical state (py, vy bits), on_ground, jump_count, the gravity queue and last-portal flag, plus px to 1/16 px and
// vx to 1/1024 px/tick: fine enough to keep the sub-pixel differences that decide corner clips.
// A "target" test runs in the kernel: here the ground jump on a floor (the landing tick starts with the ball's centre
// still above the floor's row and the jump fires), so any input history that reaches it is reported.
#pragma once
#include "eecore.h"
#include "search.h"

#ifndef EE_EXPLORE_QX
#define EE_EXPLORE_QX 4.0     // cells: px to 1/4 px
#define EE_EXPLORE_QV 256.0   // vx to 1/256 px/tick
#endif

namespace ee {

struct ExploreHit { u32 parent; u8 option, jumpOption, pad0, pad1; float px, vx; i32 layer; i32 gain; i32 refTick; };

struct ExploreParams {
	Level L;
	u64* candKey; u64* candPrio;       // per child (parent * 18 + option): its cell (0 = none) and priority (deterministic dedupe)
	const u64* htKeys; const i32* htVals; u32 htMask; const u32* qbits; i32 nocoins;   // target 4: the run's states (exact rejoins)
	const u8* parents; i32 stateBytes; i32 nParents;
	u8* next; const u32* pick; i32 nPick;
	u64* cells; u32 cellMask;          // the visited-cell set (open addressing, 0 = empty)
	u32* out; u32* nOut; u32 outCap;   // new children: parent << 5 | option
	ExploreHit* hits; u32* nHits; u32 hitCap;
	// region (tiles, box centre): children outside are dropped
	i32 rx0, ry0, rx1, ry1;
	// the target: landing on a floor whose top is at floorY (the box's py = floorY - 16) from above the row, jumping
	double floorPy; double aboveMax;   // tick-start py < aboveMax (centre above the row), landing py == floorPy
	i32 tx0, tx1;                      // the landing's centre tile x range
	i32 layer;
	i32 coarseRow;                     // from this tile row down (box centre), cells are coarse in x
	double cqx, cqv;                   // the coarse cells: px x cqx and vx x cqv to whole numbers (0.5 and 16 = 2 px, 1/16 px/tick)
	i32 discrete;                      // 1: cells also key on Sim::hashDiscrete (coins, keys, switches, door phase, effects)
	i32 keepRest;                      // 1 (time doors): a ball at rest stays in the frontier (it can wait for a door)
	i32 target;                        // 0: ground jump on the floor (above); 1: reach the region below
	i32 reachX0, reachX1, reachY0, reachY1;   // target 1: the box centre's tile in this rectangle
	double qy, qvy;                    // > 0: py / vy quantized to 1/qy, 1/qvy in the cells (coarse reachability); 0 = exact
	// target 2: ahead of the run. refTile[tile] = the run's first visit tick >= fromTick (-1 = never)
	const i32* refTile; i32 fromTick, minGain, slack, minAhead;
	i32* tileBest;                     // target 2: the best gain recorded per tile (a hit only when it improves)
	const float* rX; const float* rY; const float* rVX; const float* rVY; i32 nRef; float maxDist;   // the run's states
	const float* goalDist;             // the goal field (tiles to the trophy; beamhost.h goalField), for the closest attempt
	unsigned long long* closest;       // per layer: min of (orderedScore(goal distance) << 32 | parent << 5 | option) (null = off)
	ReachField reach;                  // when on: the closest attempt's distance; with prune, states it rules out are dropped
	i32 prune;
};

/** The per-layer claim of the exploration (after exploreExpand wrote every child's cell and priority): a cell new in
 *  this layer goes to the child with the lowest priority, whatever order the GPU ran them in. The visited-cell table
 *  holds the cell (bits 12.. of the key) and the layer that first saw it (bits 1..11, mod 2048); cellBest the winning
 *  priority of that layer. */
struct ExploreClaim {
	u64* cells; u64* cellBest; u32 mask;
	const u64* candKey; const u64* candPrio; u32* candSlot; u32 nCand; u32 layer;
	u32* out; u32* nOut; u32 outCap;
	u32* nWin; u32* hist; u32 thrBin;   // over-full layers: winners with a priority bin above thrBin are left out,
	u32 thrSub, subBin;                // and in bin thrBin those with a sub-bin >= thrSub; subBin != ~0: count sub-bins of that bin
};
#define EE_SLOT_DROP 0xffffffffu
#define EE_SLOT_REST 0xfffffffeu
/** the priority's histogram bin (the top 12 bits of its 31-bit head) */
EE_HD u32 prioBin(u64 prio) { return (u32)(prio >> 51) & 4095u; }
EE_HD u32 prioSub(u64 prio) { return (u32)(prio >> 39) & 4095u; }

/** fine: px / vx resolution where corner clips can still happen; coarse (coarseRow and below): px x cqx, vx x cqv */
EE_HD u64 exploreCell(double px, double py, double vx, double vy, u32 small, bool fine, double qy, double qvy, double cqx, double cqv) {
	const double sx = fine ? EE_EXPLORE_QX : cqx, sv = fine ? EE_EXPLORE_QV : cqv;
	const i64 qx = (i64)floor(px * sx), qvx = (i64)floor(vx * sv);
	const u64 ky = qy > 0 ? (u64)(i64)floor(py * qy) : doubleToBits(py + 0), kvy = qvy > 0 ? (u64)(i64)floor(vy * qvy) : doubleToBits(vy + 0);
	u64 h = splitmix(ky ^ splitmix(kvy ^ splitmix((u64)qx * 0x9e3779b97f4a7c15ull ^ (u64)qvx ^ ((u64)small << 40))));
	return h | 1ull;   // never 0 (0 = empty slot)
}

}  // namespace ee
