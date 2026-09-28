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

// deaths as moves: a death's ticks (goexplore.js DEATH_TILES: 55 ticks at the top running speed, 23.3 tiles) in fifths of a tile
#define EE_DEATH_F 117

struct ExploreHit { u32 parent; u8 option, jumpOption, lane, pad1; float px, vx; i32 layer; i32 gain; i32 refTick; };   // (lane: --lanes)

struct ExploreParams {
	Level L;
	u64* candKey; u64* candPrio;       // per child (parent * 18 + option): its cell (0 = none) and priority (deterministic dedupe)
	const u64* htKeys; const i32* htVals; u32 htMask; const u32* qbits; i32 nocoins;   // target 4: the run's states (exact rejoins)
	const u8* parents; i32 stateBytes; i32 nParents;
	u8* next; const u32* pick; i32 nPick;
	u32 lo, hi;                        // this launch's parents (expand) or picks (materialize): [lo, hi) (launch.h)
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
	u64 salt;                          // mixed into each child's content hash: which state represents a cell (0 = none)
	const u8* lanes; u8* lanesNext;    // --lanes: each frontier state's lane (lane k: salt + k; lanes never share a cell), or null
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
	i32 deaths;                        // 1 (--deaths=1): deaths are moves: a dying child is kept when its respawn pays (kernels.cu
	                                   // exploreKeepDead), then carried through its dead ticks; 0: every dying child is dropped
	i32 maxFifths;                     // > 0 (--costslack): states the reach field puts farther from the trophy are dropped
	i32 maxSteer;                      // > 0 (--costslack with --steer): ... unless the steer field puts them at most this far or has no value for them
	SteerField steer;                  // when on (--steer): the priority and the closest attempt read it (never the prune)
	i32 steerAll;                      // with steer: this layer orders by it (explorehost.h: every 4th, and while near the cap)
	unsigned long long* stats;         // [0] ticks simulated, [1] children skipped as twins of a lower option (search.h canonOption)
	// near-miss refinement (explorehost.h --refine=1): the situations (exploreSituation) in which cells are rfx x finer in
	// px and rfv x finer in vx (an open-addressing set, 0 = empty; null = off)
	const u64* refKeys; u32 refMask; double rfx, rfv;
	// the near-miss record (null = off): per tile and direction k (EE_NB_X / EE_NB_Y), the minimum of (the squared distance
	// from a state's box centre to the centre of that neighbour tile x 512, 20 bits << 44 | layer << 21 | index in the
	// layer) over this try's states (kernels.cu exploreMaterialize); tileSeen: the tiles a box centre was in
	unsigned long long* nearTile; u8* tileSeen;
};

/** A situation: everything of a state's cell but its x position and speed (exact height and vertical speed, on the
 *  ground, jumps, the centre's tile column). The near-miss refinement refines every cell of a situation it lists. */
EE_HD u64 exploreSituation(double py, double vy, bool onGround, i32 jumpCount, i32 tileX) {
	return splitmix(doubleToBits(py + 0) ^ splitmix(doubleToBits(vy + 0) ^ ((u64)(onGround ? 1 : 0) << 40) ^ ((u64)(u32)(jumpCount & 7) << 44) ^ ((u64)(u32)tileX << 48))) | 1ull;
}
EE_HD bool refineHit(const u64* keys, u32 mask, u64 k) {
	u32 s = (u32)(k >> 20) & mask;
	for (int i = 0; i < 64; i++) {
		const u64 v = keys[s];
		if (v == k) return true;
		if (v == 0) return false;
		s = (s + 1) & mask;
	}
	return false;
}
#define EE_NB_X(k) ((k) == 0 || (k) == 3 || (k) == 5 ? -1 : (k) == 1 || (k) == 6 ? 0 : 1)
#define EE_NB_Y(k) ((k) < 3 ? -1 : (k) < 5 ? 0 : 1)

/** The per-layer claim of the exploration (after exploreExpand wrote every child's cell and priority): a cell new in
 *  this layer goes to the child with the lowest priority, whatever order the GPU ran them in. The visited-cell table
 *  holds the cell (bits 12.. of the key) and the layer that first saw it (bits 1..11, mod 2048); cellBest the winning
 *  priority of that layer. An over-full layer keeps exactly `cap` winners, those with the lowest (priority, candidate
 *  index): the host finds the cut by a radix select (explorehost.h claimCut, the counting kernel's histograms). */
struct ExploreClaim {
	u64* cells; u64* cellBest; u32 mask;
	const u64* candKey; const u64* candPrio; u32* candSlot; u32 nCand; u32 layer;
	u32* out; u32* nOut; u32 outCap;
	u32* nWin; u32* hist;
	u64 thr; u32 thrIdx;               // the take: winners with a priority above thr, or at thr with an index >= thrIdx, are left out (~0, 0: none)
	u64 selHi; u32 selShift, selBits;  // selShift != ~0: count the selBits bits at selShift of the key among the winners with (key >> (selShift + selBits)) == selHi
	u32 selIdx;                        // the key: 0 the priority, 1 the candidate index (of the winners with priority thr)
	u32* nLost;                        // children dropped because their cell found no slot (64 probes), counted
	u32 lo, hi;                        // this launch's candidates: [lo, hi) (launch.h; every pass in order over all of them)
};
#define EE_SLOT_DROP 0xffffffffu
#define EE_SLOT_REST 0xfffffffeu
/** the priority's histogram bin (the top 12 bits of its 31-bit head; priorities are below 2^63) */
EE_HD u32 prioBin(u64 prio) { return (u32)(prio >> 51) & 4095u; }

/** the claim's verdict ahead of it (in the expand, before this layer's claim: the table holds earlier layers' cells only):
 *  the cell (bits 12..) is in the table from an earlier layer, so exploreClaimPropose drops a child of it (unless it rests) */
EE_HD bool exploreSeenBefore(const u64* cells, u32 mask, u64 cell, u32 layer) {
	const u64 tag = ((u64)(layer & 0x7ffu) << 1) | 1ull;
	u32 slot = (u32)(splitmix(cell) & mask);
	for (u32 probe = 0; probe < 64; probe++) {
		const u64 prev = cells[slot];
		if (prev == 0ull) return false;
		if ((prev & ~0xfffull) == cell) return (prev & 0xfffull) != tag;
		slot = (slot + 1) & mask;
	}
	return false;
}

/** deaths as moves: the cell (bits 12..) marked in the table from this layer on; true when this call put it there (the
 *  first death to a respawn target in a discrete state: kernels.cu exploreKeepDead), false when it was there already */
EE_HD bool exploreMarkOnce(u64* cells, u32 mask, u64 cell, u32 layer) {
	const u64 tag = ((u64)(layer & 0x7ffu) << 1) | 1ull;
	u32 slot = (u32)(splitmix(cell) & mask);
	for (u32 probe = 0; probe < 64; probe++) {
#ifdef __CUDA_ARCH__
		const u64 prev = atomicCAS((unsigned long long*)&cells[slot], 0ull, (unsigned long long)(cell | tag));
#else
		const u64 prev = cells[slot]; if (prev == 0ull) cells[slot] = cell | tag;
#endif
		if (prev == 0ull) return true;
		if ((prev & ~0xfffull) == cell) return false;
		slot = (slot + 1) & mask;
	}
	return false;   // (the table is full here: taken as marked)
}

/** fine: px / vx resolution where corner clips can still happen; coarse (coarseRow and below): px x cqx, vx x cqv */
EE_HD u64 exploreCell(double px, double py, double vx, double vy, u32 small, bool fine, double qy, double qvy, double cqx, double cqv) {
	const double sx = fine ? EE_EXPLORE_QX : cqx, sv = fine ? EE_EXPLORE_QV : cqv;
	const i64 qx = (i64)floor(px * sx), qvx = (i64)floor(vx * sv);
	const u64 ky = qy > 0 ? (u64)(i64)floor(py * qy) : doubleToBits(py + 0), kvy = qvy > 0 ? (u64)(i64)floor(vy * qvy) : doubleToBits(vy + 0);
	u64 h = splitmix(ky ^ splitmix(kvy ^ splitmix((u64)qx * 0x9e3779b97f4a7c15ull ^ (u64)qvx ^ ((u64)small << 40))));
	return h | 1ull;   // never 0 (0 = empty slot)
}

// ---------------------------------------------------------------- random runs (`eegpu roll`, native/rollhost.h)
// The GPU side of Find a route's "random runs (GPU)" (src/goexplore.js --gpu=1): the Go-Explore of goexplore.js with
// coarse cells, its rolls on the GPU. The host (goexplore.js) keeps the archive and picks K cells per batch (heads A /
// B / C); here every pick plays R random runs of up to Lr ticks from its cell's state (the state pool is in host memory:
// one state per cell, by its dense id; the picks' states come up per batch, the records' go down), with goexplore.js's
// input policy (the first input drawn, then each tick kept with p `keep`, else drawn again from the 18: the same
// mulberry32 draws, so the host rebuilds a run's inputs from its seed). Every state on the way is looked up in the cell
// table (open addressing over coarse cell keys: rollCellKey), new cells are added, and per cell the earliest arrival of
// the batch wins (atomicMin over (tick, pick, run, step)); a cell reached sooner than before is materialized (replayed
// from its pick's state, for the host's pool) and reported with its reach cost and room. A state the reach field rules
// out (-1, a proof) ends its run, as a death does; nothing else prunes.
struct RollParams {
	Level L;
	ReachField reach;
	i32 prune;                         // 1: a state the reach field rules out ends its run (-1 is a proof)
	u8* stage; i32 stateBytes;         // the records' states, by record index (the host copies them into its pool)
	i32* cellT;                        // the cells' ticks (the path length), by dense id
	const u32* picks; u32 nPicks;      // this batch's picked cells (dense ids)
	i32 R, Lr;                         // runs per pick, ticks per run (Lr <= 255)
	u32 lo, hi;                        // this launch's items: runs (pick x R + run), touched slots or records
	u32 batchSeed; double keep;
	i32 maxT;                          // a state at tick >= maxT is not added (a route from there is not faster); past it a run ends
	// the cell table (slot = splitmix(key) & mask, linear probing): key (0 = empty), the batch's best arrival
	// ((tick << 40) | (pick << 20) | (run << 8) | step; ~0 = none), the tick of the arrival the host knows (~0u: none),
	// how often a run came through (head B), the dense id (-1: not materialized yet)
	u64* keys; u32 mask; u64* best; u32* doneT; u32* seen; i32* dense;
	u32* touched; u32 touchedCap;      // the slots whose best was set this batch (first set: appended)
	i32 full;                          // 1: the pool is full, no new cells (known ones still improve)
	u32* fin; u32 finCap;              // finishes: (pick, run, step, tick) x 4 u32
	u32* ctr;                          // counters: [0] touched, [1] finishes, [2] records, [3] dense ids given out
	// rooms (goexplore.js roomOf): which counts the doors read
	i32 roomTeam, roomCoins, roomBlue, roomCrown, roomSilver;
	i32 phase;                         // > 0 (time doors): the cell keys hold the door phase in buckets of `phase` ticks
	i32 deaths;                        // 1 (--deaths=1): a run goes on through a death that pays (kernels.cu rollBody), at most one
	unsigned long long* stats;         // [0] ticks simulated, [1] runs, [2] runs ended by the reach field, [3] deaths that ended a
	                                   // run, [4] deaths kept (--deaths=1)
	// collect
	u8* pickStates;                    // the picks' states at the batch's start (from the host's pool; collect replays from them)
	i32* out;                          // per record (dense id or -1: pool full, tick, fifths, room, pick, run | step << 16) x 6
	u32 denseCap;
	u32* denseSlot;                    // per dense id: its slot (the seen counts by dense id: rollSeen)
	u32* seenOut;                      // rollSeen: seen[denseSlot[d]] for d in [lo, hi)
};
/** The mulberry32 of goexplore.js (rngOf): the same u32 operations, the same doubles in [0, 1) */
struct Mulberry {
	u32 s;
	EE_HD double next() {
		s = s + 0x6d2b79f5u;
		u32 t = (u32)imul((i32)(s ^ (s >> 15)), (i32)(1u | s));
		t = (t + (u32)imul((i32)(t ^ (t >> 7)), (i32)(61u | t))) ^ t;
		return (double)(t ^ (t >> 14)) / 4294967296.0;
	}
};
/** goexplore.js fmix (murmur3's finalizer, on int32) */
EE_HD u32 rollFmix(u32 h) { h ^= h >> 16; h = (u32)imul((i32)h, (i32)0x85ebca6bu); h ^= h >> 13; h = (u32)imul((i32)h, (i32)0xc2b2ae35u); return h ^ (h >> 16); }
/** a run's seed: (batch seed, pick index, run) -> mulberry32's state (goexplore.js rollSeed) */
EE_HD u32 rollSeed(u32 batchSeed, u32 pick, u32 run) { return rollFmix(batchSeed ^ rollFmix(pick * 0x9e3779b1u ^ rollFmix(run + 0x7f4a7c15u))); }
/** the input of step k of a run (goexplore.js: the first input drawn, then each tick kept with p keep, else drawn) */
EE_HD i32 rollDraw(Mulberry& r, double keep, i32 m) {
	if (r.next() >= keep) m = option((i32)(r.next() * 18.0));
	return m;
}
EE_HD void rollW(u32& h, i32 v) { h = (u32)imul((i32)(h ^ (u32)v), 0x5bd1e995); h ^= h >> 13; }
/** goexplore.js roomOf(L).key(sim): the room (keys, effects and their values, switches, and the team / coin / crown /
 *  death counts where a door reads them), the same int32 hash */
template <int TW>
EE_HD u32 rollRoom(const RollParams& p, const State<TW>& s) {
	u32 h = 0x3c6ef372u;
#define w(v) rollW(h, (i32)(v))
	w(s.keysMask);
	w((p.roomCrown && s.collide_crown ? 1 : 0) | (s.low_gravity ? 2 : 0) | (s.is_invulnerable ? 4 : 0) | (p.roomSilver && s.collide_silver_crown ? 8 : 0) |
		(s.is_cursed ? 16 : 0) | (s.is_zombie ? 32 : 0) | (s.is_on_fire ? 64 : 0) | (s.is_poisoned ? 128 : 0) | (s.has_levitation ? 256 : 0) |
		(p.L.hasTimeDoors && s.timedoor_state ? 512 : 0));
	w(s.max_jumps); w(s.jump_boost); w(s.speed_boost); w(s.flip_gravity);
	if (p.roomTeam) w(s.team);
	if (p.roomCoins) w(s.coins);
	if (p.L.hasCoinGate) w(s.show_coin_gate);
	if (p.roomBlue) w(s.blue_coins);
	if (p.L.hasBlueCoinGate) w(s.show_blue_coin_gate);
	if (p.L.hasDeathDoor) w(s.deaths);
	if (p.L.hasDeathGate) w(s.show_death_gate);
	// (the switches that are on: goexplore.js sums fmix(id ^ salt) over them; it writes the sum whenever the switch Map
	// has an entry, on or off, here whenever one is on: rooms after a switch went on and off again differ only in name)
	u32 sum = 0; bool any = false;
	for (i32 k = 0; k < p.L.nSw; k++) if ((s.w[p.L.offSw + (k >> 5)] >> (k & 31)) & 1u) { sum += rollFmix((u32)(p.L.swIds[k] ^ 0x1234567)); any = true; }
	if (any) w((i32)sum);
	sum = 0; any = false;
	for (i32 k = 0; k < p.L.nOsw; k++) if ((s.w[p.L.offOsw + (k >> 5)] >> (k & 31)) & 1u) { sum += rollFmix((u32)(p.L.oswIds[k] ^ 0x7654321)); any = true; }
	if (any) w((i32)sum);
#undef w
	return h;
}
/** goexplore.js's coarse cell: (tile, room, on the ground, the time-door phase bucket, sign of vx, class of vy) */
template <int TW>
EE_HD u64 rollCellKey(const RollParams& p, const State<TW>& s, u32 room) {
	const i32 tx = truncI(s.px + 8.0) >> 4, ty = truncI(s.py + 8.0) >> 4;
	i32 tile = ty * p.L.W + tx;
	tile = tile < 0 ? 0 : tile > p.L.N - 1 ? p.L.N - 1 : tile;
	const i32 ph = p.phase > 0 ? (s.ticks % TIMEDOOR_PERIOD) / p.phase : 0;
	const double vy = s.speed_y;
	const i32 vyc = dlt(vy, -3.0) ? 0 : lt0(vy) ? 1 : eq0(vy) ? 2 : 3;
	const i32 vxs = gt0(s.speed_x) ? 2 : lt0(s.speed_x) ? 0 : 1;
	const u64 small = (u64)(s.on_ground ? 1 : 0) | ((u64)vxs << 1) | ((u64)vyc << 3) | ((u64)(u32)ph << 5);
	return splitmix(((u64)(u32)tile << 32 | room) ^ splitmix(small + 0x51ed270b27aa6cd1ull)) | 1ull;
}

}  // namespace ee
