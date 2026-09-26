// kernels.cu - the GPU side of eegpu (compiled to PTX by NVRTC at build time: tools/build-native.js, with
// --fmad=false so every double operation is rounded exactly like the CPU / JS engine).
//   trace_<TW>: one thread replays a run from reset() and writes both state hashes after every tick (exactness proof;
//     in segments that continue from the saved state)
//   search_<TW>: one thread per candidate (start tick x variant), the exact-rejoin search of search.h
//   twins_<TW>: the search's twin table (the systematic variants that play like a lower one, search.h twinBits)
//   stateSize_<TW>: the sizes of State<TW> and the kernels' parameter structs on the device (the host checks that the
//   layouts agree), and the reach file version (3)
//   reachTest_<TW>: reachFifths and reachScore (beam.h) for a list of states (test/reach.js F: the JS and the GPU agree)
// <TW> = capacity of the state's variable tail in words (8, 32, 128, 512); the host picks the smallest that fits.
#include "eecore.h"
#include "search.h"
#include "beam.h"
#include "explore.h"

using namespace ee;

__device__ __forceinline__ i32 htLookupT(const u64* keys, const i32* vals, u32 mask, u64 h) {
	const u64 key = h | (1ull << 63);
	u32 slot = (u32)(splitmix(h) & mask);
	for (;;) {
		const u64 k = keys[slot];
		if (k == key) return vals[slot];
		if (k == 0) return -1;
		slot = (slot + 1) & mask;
	}
}
__device__ __forceinline__ i32 htLookup(const SearchParams& p, u64 h) {
	const u64 key = h | (1ull << 63);
	u32 slot = (u32)(splitmix(h) & p.htMask);
	for (;;) {
		const u64 k = p.htKeys[slot];
		if (k == key) return p.htVals[slot];
		if (k == 0) return -1;
		slot = (slot + 1) & p.htMask;
	}
}

/** a per-warp sum added to *dst (every lane of the warp must call it) */
__device__ __forceinline__ void warpAdd(unsigned long long* dst, unsigned long long v) {
#ifdef EE_EMU   // (the CPU emulation of the kernels runs one thread at a time)
	if (v) atomicAdd(dst, v);
#else
	for (int o = 16; o > 0; o >>= 1) v += __shfl_down_sync(0xffffffffu, v, o);
	if ((threadIdx.x & 31) == 0 && v) atomicAdd(dst, v);
#endif
}

// One thread per candidate; consecutive threads are consecutive variants of the same start tick t: a warp loads ONE
// start state (a broadcast read; 32 different states cost 32x the memory traffic, measured) and shares the level
// geometry around it. With a list (the systematic families without their twins) the threads take its entries in order.
// In launches of at most p.segTicks ticks per candidate (launch.h): the batch's records (SearchParams::rec) keep each
// live candidate's state, tick index and sticky input between launches; phase 0 starts them, phase 1 continues them.
// A candidate plays exactly the same ticks as in one launch (its inputs depend on its tick index and sticky input only).
template <int TW>
__device__ void searchBody(const SearchParams& p) {
	const u32 r = p.r0 + blockIdx.x * blockDim.x + threadIdx.x;   // (the record: the candidate's index in the batch)
	unsigned long long nTicks = 0, nCand = 0, nDeath = 0, nDrift = 0, nNoop = 0, nEnd = 0, nHit = 0, nBroken = 0;
	if (r < p.r1) {
		SearchRec* rec = (SearchRec*)(p.rec + (size_t)r * p.recBytes);
		State<TW>* saved = (State<TW>*)(p.rec + (size_t)r * p.recBytes + 16);
		i32 ti = p.nT, v = 0, k = 0, sticky = 0;
		bool live = false;
		if (p.phase == 0) {
			if (!p.list) { ti = (i32)(r / (u32)p.V); v = (i32)(r - (u32)ti * (u32)p.V); }
			else if (r < p.nList) { const u32 e = p.list[r]; ti = (i32)(e / (u32)p.V); v = (i32)(e - (u32)ti * (u32)p.V); }
			live = ti < p.nT;
		} else if (rec->k >= 0) { ti = rec->ti; v = rec->v; k = rec->k; sticky = rec->sticky; live = true; }
		bool ended = true;
		if (live) {
			const i32 t = p.t0 + ti;
			Cand c = makeCand(p.family, t, v, p.seed, p.masks, p.n, p.axis, nullptr);   // (the host left the twins out of the list)
			if (c.valid) {
				const State<TW>* s0 = (const State<TW>*)(p.snaps + (size_t)t * p.stateBytes);
				if (p.phase == 0) nCand++;
				State<TW> s = p.phase == 0 ? *s0 : *saved;
				Sim<TW> sim(p.L, s);
				const bool crown0 = s0->has_silver_crown != 0;
				const i32 kEnd = k + p.segTicks;
				for (;; k++) {
					if (k >= kEnd) { ended = false; break; }   // (this launch's share: the rest in the next one)
					const i32 m = candInput(c, p.masks, p.n, p.axis, k, sticky);
					if (m < 0) { nEnd++; break; }
					Input in = maskInput(m);
					sim.tick(in);
					nTicks++;
					const i32 done = k + 1;
					if (s.broken) { nBroken++; break; }
					if (s.is_dead) { nDeath++; break; }
					if (!crown0 && s.has_silver_crown) {
						if (p.n > t + done) {
							const u32 slot = atomicAdd(p.hitCount, 1u);
							if (slot < p.hitCap) { Hit h; h.t = t; h.v = v; h.k = done; h.j = p.n; h.family = p.family; h.flags = 1; h.seed = p.seed; p.hits[slot] = h; }
							nHit++;
						} else nNoop++;
						break;
					}
					if (done >= c.prefix) {
						{
							const u32 bit = (u32)(quadKey(s.px, s.py, s.speed_x, s.speed_y) >> (64 - QBITS_LOG2));
							if ((p.qbits[bit >> 5] >> (bit & 31)) & 1u) {
								const i32 j = htLookup(p, sim.hash(p.nocoins != 0));
								if (j >= 0) {
									if (j > t + done) {
										const u32 slot = atomicAdd(p.hitCount, 1u);
										if (slot < p.hitCap) { Hit h; h.t = t; h.v = v; h.k = done; h.j = j; h.family = p.family; h.flags = 0; h.seed = p.seed; p.hits[slot] = h; }
										nHit++;
									} else nNoop++;
									break;
								}
							}
						}
						const i32 rr = t + c.skip + (done - c.prefix);
						if (rr > p.n) { nEnd++; break; }
						if (fabs(s.px - p.X[rr]) + fabs(s.py - p.Y[rr]) > p.drift) { nDrift++; break; }
					}
					if (done >= p.horizon) { nEnd++; break; }
				}
				if (!ended) { rec->ti = ti; rec->v = v; rec->k = k; rec->sticky = sticky; *saved = s; atomicAdd(p.nLive, 1u); }
			}
		}
		if (ended) rec->k = -1;
	}
	warpAdd(&p.stats[0], nTicks); warpAdd(&p.stats[1], nCand); warpAdd(&p.stats[2], nDeath); warpAdd(&p.stats[3], nDrift);
	warpAdd(&p.stats[4], nNoop); warpAdd(&p.stats[5], nEnd); warpAdd(&p.stats[6], nHit); warpAdd(&p.stats[7], nBroken);
}

// The search's twin table (search.h twinBits): one thread per (start tick, option) of [p.t0, p.t0 + p.nT); TWIN_WORDS
// words per start tick (zeroed by the host), bits set atomically (the options of a tick share words).
template <int TW>
__device__ void twinsBody(const SearchParams& p, u32* twin, i32 m1, i32 m2) {
	const i32 gid = blockIdx.x * blockDim.x + threadIdx.x;
	const i32 ti = gid / 18, o = gid - ti * 18;
	if (ti >= p.nT) return;
	const i32 t = p.t0 + ti;
	const State<TW>& st = *(const State<TW>*)(p.snaps + (size_t)t * p.stateBytes);
	State<TW> a, b;
	u32* row = twin + (size_t)ti * TWIN_WORDS;
	twinBits<TW>(p.L, st, p.masks, p.n, t, o, m1 != 0, m2 != 0, a, b, [&](i32 bit) { atomicOr(&row[bit >> 5], 1u << (bit & 31)); });
}

// The trace in segments (launch.h: a whole run in one launch can outlast the driver's watchdog): ticks [t0, t1) of the
// run from the state the last segment left in `state` (t0 == 0: from reset()); info (complete, runTicks, deaths,
// broken) carries over too (the host starts it at -1, -1, 0, -1).
template <int TW>
__device__ void traceBody(Level L, const u8* masks, i32 t0, i32 t1, u64* out, const u32* coinBits0, u64 seed, i32* info, u8* state) {
	if (blockIdx.x != 0 || threadIdx.x != 0) return;
	State<TW> s;
	Sim<TW> sim(L, s);
	if (t0 == 0) {
		sim.reset(coinBits0, seed);
		out[0] = sim.hash(false); out[1] = sim.hash(true);
	} else s = *(const State<TW>*)state;
	i32 complete = info[0], runTicks = info[1], broken = info[3];
	for (i32 t = t0; t < t1; t++) {
		Input in = maskInput(masks[t]);
		const bool had = s.has_silver_crown != 0;
		sim.tick(in);
		out[2 * (t + 1)] = sim.hash(false); out[2 * (t + 1) + 1] = sim.hash(true);
		if (!had && s.has_silver_crown && complete < 0) { complete = t + 1; runTicks = s.run_ticks; }
		if (s.broken && broken < 0) broken = t + 1;
	}
	info[0] = complete; info[1] = runTicks; info[2] = s.deaths; info[3] = broken;
	*(State<TW>*)state = s;
}

// Raw engine speed (the processor benchmark): every thread plays random sticky inputs from the same start state, the
// workload of src/bench.js on the CPU, so the two numbers compare.
// In segments (launch.h): ticks [k0, k1) of each thread's run; its state and random state wait in `states` / `rng`
// between launches (k0 == 0: from state0, a new run).
template <int TW>
__device__ void benchBody(Level L, const u8* state0, i32 k0, i32 k1, u64 seed, unsigned long long* out, u8* states, u64* rng) {
	const i32 gid = blockIdx.x * blockDim.x + threadIdx.x;
	State<TW>* saved = (State<TW>*)states + gid;
	State<TW> s = k0 == 0 ? *(const State<TW>*)state0 : *saved;
	Sim<TW> sim(L, s);
	u64 r = k0 == 0 ? splitmix(seed ^ (u64)gid) : rng[2 * gid];
	i32 m = k0 == 0 ? 0 : (i32)rng[2 * gid + 1];
	unsigned long long n = 0;
	for (i32 k = k0; k < k1; k++) {
		r = splitmix(r);
		if (k == 0 || (r & 255) < 26) m = option((i32)((r >> 8) % 18));
		Input in = maskInput(m);
		sim.tick(in);
		n++;
	}
	*saved = s; rng[2 * gid] = r; rng[2 * gid + 1] = (u64)m;
	warpAdd(out, n);
}

// ---------------------------------------------------------------- guided beam search (beam.h)
// expand: one thread per parent; it plays all 18 options from the parent (a fresh copy each time): the lanes of a
// warp are 32 parents playing the same option, so they stay in step, and each parent state is loaded once. An option
// that is a twin of a lower one (search.h canonOption: an input bit unused from this parent) is not simulated: its
// child is the lower option's, which wins the dedupe's tie anyway (flag 16).
template <int TW>
__device__ __forceinline__ void beamExpandParent(const BeamParams& p, const i32 pi, unsigned long long& nSim, unsigned long long& nTwin) {
	const State<TW>* par = (const State<TW>*)(p.parents + (size_t)pi * p.stateBytes);
	const bool crown0 = par->has_silver_crown != 0;
	u64 nearest = ~0ull;   // the closest child to the trophy (goal distance, parent, option)
	u32 used = 31, jumpUsed = 0;   // option 0's input bits; per (h, v): a jump press matters (Sim::inUsed)
	for (i32 o = 0; o < 18; o++) {
		BeamChild c;
		c.parent = (u32)pi; c.option = (u8)o; c.flags = 0; c.rejoin = -1; c.hash = 0; c.score = -1e30f; c.bucket = 0;
		if (o > 0 && canonOption(o, used, jumpUsed) != o) { c.flags = 16; p.out[(size_t)pi * 18 + o] = c; nTwin++; continue; }
		State<TW> s = *par;
		Sim<TW> sim(p.L, s);
		Input in = maskInput(option(o));
		sim.tick(in);
		nSim++;
		if (o == 0) used = sim.inUsed();
		if (!(o & 1)) jumpUsed |= (sim.inUsed() & 1u) << (o >> 1);
		if (s.broken) c.flags |= 8;
		else if (s.is_dead) c.flags |= 1;
		else {
			if (!crown0 && s.has_silver_crown) c.flags |= 2;
			const float cx = (float)s.px + 8.f, cy = (float)s.py + 8.f;
			float sc = 0;
			if (p.nGuide <= 1 && p.refTile) {   // no line: head along the run from the start (rejoin mode)
				const i32 tx0 = truncI(s.px + 8.0) >> 4, ty0 = truncI(s.py + 8.0) >> 4;
				const i32 r = (tx0 >= 0 && ty0 >= 0 && tx0 < p.L.W && ty0 < p.L.H) ? p.refTile[ty0 * p.L.W + tx0] : -1;
				sc = r >= 0 ? 64.f + runMatchScore(p, r, (float)s.px, (float)s.py, (float)s.speed_x, (float)s.speed_y) : -1e6f;
			}
			if (p.nGuide > 1) {
				const float g = guideScore(p, cx, cy);
				sc += g;
				if (p.refTile && g >= p.lineLen - 24.f) {   // at the end of the line: head back along the run
					const i32 tx0 = truncI(s.px + 8.0) >> 4, ty0 = truncI(s.py + 8.0) >> 4;
					const i32 r = (tx0 >= 0 && ty0 >= 0 && tx0 < p.L.W && ty0 < p.L.H) ? p.refTile[ty0 * p.L.W + tx0] : -1;
					if (r >= 0) sc = p.lineLen + 64.f + runMatchScore(p, r, (float)s.px, (float)s.py, (float)s.speed_x, (float)s.speed_y);
				}
			}
			if (p.goalWeight > 0 || p.closest) {
				// the distance to the trophy: the reach field (physics-aware, tiles) when loaded, else walking distance; a
				// state the field cuts off scores 1e4 + its walking distance (behind everything else, still ordered, and
				// the closest attempt falls back to it: there is always one to show)
				const float walk = p.goalDist ? goalScore(p, p.L, cx, cy) : 1e6f;
				float gd = walk, ck = walk;
				if (p.reach.on) {
					const RfPre pre = rfPre(p.reach, s.speed_y, s.q0, s.q1, s.slippery);
					const i32 own = rfFifthsAt(p.reach, pre, s.px, s.py, s.speed_y);
					gd = own >= 0 ? reachScore(p.reach, pre, s.px, s.py, s.speed_y, own) : 1e4f + walk;
					ck = own >= 0 ? (float)own / 5.f : gd;
				}
				if (p.goalWeight > 0) sc -= p.goalWeight * gd;
				const u64 k = ((u64)orderedScore(ck) << 32) | ((u32)pi << 5) | (u32)o;
				if (k < nearest) nearest = k;
			}
			c.score = sc;
			c.hash = sim.hash(p.nocoins != 0);
			if (p.htMask) {
				const u32 bit = (u32)(quadKey(s.px, s.py, s.speed_x, s.speed_y) >> (64 - QBITS_LOG2));
				if ((p.qbits[bit >> 5] >> (bit & 31)) & 1u) {
					const i32 j = htLookupT(p.htKeys, p.htVals, p.htMask, c.hash);
					if (j > p.layerTick + 1) { c.flags |= 4; c.rejoin = j; }
				}
			}
			const i32 tx = truncI(s.px + 8.0) >> 4, ty = truncI(s.py + 8.0) >> 4;
			c.bucket = (u16)((tx & 63) | ((ty & 63) << 6) | ((signi(s.speed_x) + 1) << 12) | ((signi(s.speed_y) + 1) << 14));
		}
		p.out[(size_t)pi * 18 + o] = c;
	}
	if (p.closest && nearest < *(volatile unsigned long long*)p.closest) atomicMin(p.closest, (unsigned long long)nearest);
}
// (every kernel below runs over the index range [lo, hi) of its launch: launch.h splits the work into short launches)
template <int TW>
__device__ void beamExpandBody(const BeamParams& p) {
	const i32 pi = (i32)p.lo + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	unsigned long long nSim = 0, nTwin = 0;
	if (pi < (i32)p.hi && pi < p.nParents) beamExpandParent<TW>(p, pi, nSim, nTwin);
	warpAdd(&p.stats[0], nSim); warpAdd(&p.stats[1], nTwin);   // (every lane: no early return above)
}
// materialize: one thread per kept child: parent + option -> the next layer's state
template <int TW>
__device__ void beamMaterializeBody(const BeamParams& p) {
	const i32 i = (i32)p.lo + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)p.hi || i >= p.nPick) return;
	const u32 pk = p.pick[i];
	State<TW> s = *(const State<TW>*)(p.parents + (size_t)(pk >> 5) * p.stateBytes);
	Sim<TW> sim(p.L, s);
	Input in = maskInput(option((i32)(pk & 31)));
	sim.tick(in);
	*(State<TW>*)(p.next + (size_t)i * p.stateBytes) = s;
}

// ---------------------------------------------------------------- the beam's selection (beam.h BeamSel)
extern "C" __global__ void beamSelInsert(BeamSel q) {
	const i32 i = (i32)q.r0 + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)q.r1 || i >= q.nKids) return;
	const BeamChild c = q.kids[i];
	if (c.flags & (2 | 4)) { const u32 r = atomicAdd(q.nRes, 1u); if (r < q.resCap) q.res[r] = (u32)i; }
	if (c.flags & (1 | 2 | 8 | 16)) { q.slot[i] = ~0u; return; }
	const u64 key = c.hash | (1ull << 63);
	u32 s = (u32)(splitmix(c.hash) & q.hMask);
	for (u32 probe = 0; probe < 128; probe++) {
		const u64 prev = atomicCAS((unsigned long long*)&q.hKeys[s], 0ull, (unsigned long long)key);
		if (prev == 0ull || prev == key) break;
		s = (s + 1) & q.hMask;
	}
	q.slot[i] = s;
	atomicMax((unsigned long long*)&q.hBest[s], (unsigned long long)(((u64)orderedScore(c.score) << 32) | (u64)(0xffffffffu - (u32)i)));
}
extern "C" __global__ void beamSelWinners(BeamSel q) {
	const i32 i = (i32)q.r0 + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)q.r1 || i >= q.nKids) return;
	const u32 s = q.slot[i];
	u8 w = 0;
	if (s != ~0u && (u32)q.hBest[s] == 0xffffffffu - (u32)i) {
		w = 1;
		const u32 k = orderedScore(q.kids[i].score);
		atomicMin(&q.mm[0], k); atomicMax(&q.mm[1], k);
	}
	q.win[i] = w;
}
extern "C" __global__ void beamSelHist(BeamSel q) {
	const i32 i = (i32)q.r0 + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)q.r1 || i >= q.nKids || !q.win[i]) return;
	atomicAdd(&q.hist[scoreBin(q, orderedScore(q.kids[i].score))], 1u);
}
/** one round: the winners in score bins [bLo, bHi] */
extern "C" __global__ void beamSelPick(BeamSel q, i32 bLo, i32 bHi) {
	const i32 i = (i32)q.r0 + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)q.r1 || i >= q.nKids || !q.win[i]) return;
	const BeamChild c = q.kids[i];
	const i32 b = scoreBin(q, orderedScore(c.score));
	if (b < bLo || b > bHi) return;
	if (atomicAdd(&q.bucketCnt[c.bucket], 1u) >= (u32)q.bucketCap) { const u32 o = atomicAdd(q.nOver, 1u); if (o < q.overCap) q.over[o] = (u32)i; return; }
	const u32 s = atomicAdd(q.nPick, 1u);
	if (s < q.K) q.pick[s] = (c.parent << 5) | c.option;
}
/** the fill-up: pick[n0 + j] = the j-th state over the cap (j < need; this launch: j in [lo, hi)) */
extern "C" __global__ void beamSelFill(BeamSel q, u32 n0, u32 need) {
	const u32 j = q.r0 + blockIdx.x * blockDim.x + threadIdx.x;
	if (j >= q.r1 || j >= need) return;
	const BeamChild c = q.kids[q.over[j]];
	q.pick[n0 + j] = (c.parent << 5) | c.option;
}

// ---------------------------------------------------------------- exhaustive exploration (explore.h)
__device__ __forceinline__ bool cellInsert(u64* cells, u32 mask, u64 key) {
	u32 slot = (u32)(splitmix(key) & mask);
	for (u32 probe = 0; probe < 64; probe++) {
		const u64 prev = atomicCAS((unsigned long long*)&cells[slot], 0ull, (unsigned long long)key);
		if (prev == 0ull) return true;      // new cell
		if (prev == key) return false;      // seen
		slot = (slot + 1) & mask;
	}
	return false;   // (the table is full here: treat as seen)
}
// expand: one thread per parent, all 18 options (like the beam's). A twin of a lower option (search.h canonOption) is
// not simulated: it would be the same state in the same cell with a higher priority (the option is its last tie-break),
// so the claim would never pick it; the frontier is the same, with fewer ticks.
template <int TW>
__device__ __forceinline__ void exploreExpandParent(const ExploreParams& p, const i32 pi, unsigned long long& nSim, unsigned long long& nTwin) {
	const State<TW>* par = (const State<TW>*)(p.parents + (size_t)pi * p.stateBytes);
	u64 nearest = ~0ull;   // the closest child to the trophy (goal distance, parent, option)
	// the parent's content (the tie-break between children that are the same state)
	const u64 parentHash = splitmix(doubleToBits(par->px) ^ splitmix(doubleToBits(par->py) ^ splitmix(doubleToBits(par->speed_x) ^ splitmix(doubleToBits(par->speed_y) ^ (u64)par->q0 ^ ((u64)par->q1 << 16) ^ ((u64)par->jump_count << 32)))));
	// --lanes: independent explorations side by side, lane k with salt + k; its cells are its own (the lane is mixed
	// into the cell key), so lane k explores exactly what a run with --salt=salt+k alone would (until a layer is cut)
	const u32 lane = p.lanes ? (u32)p.lanes[pi] : 0u;
	const u64 salt = p.salt + lane;
	u32 used = 31, jumpUsed = 0;   // option 0's input bits; per (h, v): a jump press matters (Sim::inUsed)
	for (i32 o = 0; o < 18; o++) {
		p.candKey[(size_t)pi * 18 + o] = 0;   // (none unless it reaches the end of this loop)
		if (o > 0 && canonOption(o, used, jumpUsed) != o) { nTwin++; continue; }
		State<TW> s = *par;
		Sim<TW> sim(p.L, s);
		const double startPy = s.py;
		u32 rcq = 0;   // the reach-field cost (the priority's head: fifths >> prioShift)
		Input in = maskInput(option(o));
		sim.tick(in);
		nSim++;
		if (o == 0) used = sim.inUsed();
		if (!(o & 1)) jumpUsed |= (sim.inUsed() & 1u) << (o >> 1);
		if (s.broken || s.is_dead) continue;
		const i32 cx = truncI(s.px + 8.0) >> 4, cy = truncI(s.py + 8.0) >> 4;
		if (cx < p.rx0 || cx > p.rx1 || cy < p.ry0 || cy > p.ry1) continue;
		// the finish first: this tick took the trophy (the silver crown); report, do not expand (the crown comes from the
		// tick-start tile, so the tick-end position may be anywhere, e.g. over a spike the physics model cuts off)
		if (p.target == 3 && s.has_silver_crown && !par->has_silver_crown) {
			const u32 h = atomicAdd(p.nHits, 1u);
			if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.lane = (u8)lane; e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
			continue;
		}
		if (p.reach.on) {
			const i32 own = reachFifths(p.reach, s.px, s.py, s.speed_y, s.q0, s.q1, s.slippery);
			// the physics model rules this state out: it cannot reach the trophy (a proof)
			if (p.prune && own < 0) continue;
			rcq = own < 0 ? 4095u : (u32)min(own >> p.reach.prioShift, 4095);
			if (p.closest) {
				const float ck = own >= 0 ? (float)own / 5.f : 1e4f + (p.goalDist ? goalDistAt(p.goalDist, p.L, (float)s.px + 8.f, (float)s.py + 8.f) : 1e6f);
				const u64 k = ((u64)orderedScore(ck) << 32) | ((u32)pi << 5) | (u32)o;
				if (k < nearest) nearest = k;
			}
		} else if (p.closest) {
			const u64 k = ((u64)orderedScore(goalDistAt(p.goalDist, p.L, (float)s.px + 8.f, (float)s.py + 8.f)) << 32) | ((u32)pi << 5) | (u32)o;
			if (k < nearest) nearest = k;
		}
		if (p.target == 2) {   // ahead of the run: a hit when the run reaches this tile only minGain+ ticks later
			const i32 r = p.refTile[cy * p.L.W + cx], now = p.fromTick + p.layer + 1;
			if (r >= 0 && r < now - p.slack) continue;   // behind the run's schedule: drop
			if (r >= 0 && r - now >= p.minGain && r - p.fromTick >= p.minAhead) {
				// close to the run's state at some tick of its visit (position + 3 x speed)
				i32 bestR = -1; float bestD = p.maxDist;
				for (i32 rr = r; rr < r + 24 && rr < p.nRef; rr++) {
					const float dd = fabsf((float)s.px - p.rX[rr]) + fabsf((float)s.py - p.rY[rr]) + 3.f * (fabsf((float)s.speed_x - p.rVX[rr]) + fabsf((float)s.speed_y - p.rVY[rr]));
					if (dd <= bestD) { bestD = dd; bestR = rr; }
				}
				if (bestR >= 0 && atomicMax(&p.tileBest[cy * p.L.W + cx], bestR - now) < bestR - now) {
					const u32 h = atomicAdd(p.nHits, 1u);
					if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.lane = (u8)lane; e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = bestR - now; e.refTick = bestR; p.hits[h] = e; }
				}
			}
		}
		else if (p.target == 3) { }   // (the finish: tested above, before the prune)
		else if (p.target == 4) {   // an exact rejoin with the run: a shortcut when the run reaches this state later
			const u32 bit = (u32)(quadKey(s.px, s.py, s.speed_x, s.speed_y) >> (64 - QBITS_LOG2));
			if ((p.qbits[bit >> 5] >> (bit & 31)) & 1u) {
				const i32 j = htLookupT(p.htKeys, p.htVals, p.htMask, sim.hash(p.nocoins != 0));
				if (j >= 0) {
					const i32 now = p.fromTick + p.layer + 1;
					if (j - now >= p.minGain) {
						const u32 h = atomicAdd(p.nHits, 1u);
						if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.lane = (u8)lane; e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = j - now; e.refTick = j; p.hits[h] = e; }
					}
					continue;   // on the run: from here on it goes as the run does (sooner or later), nothing new
				}
			}
			if (p.refTile) {   // behind the run's schedule here: it cannot become a shortcut through this tile
				const i32 r = p.refTile[cy * p.L.W + cx];
				if (r >= 0 && p.fromTick + p.layer + 1 > r + p.slack) continue;
			}
		}
		else if (p.target == 1) {   // reach a region: report and do not expand further
			if (cx >= p.reachX0 && cx <= p.reachX1 && cy >= p.reachY0 && cy <= p.reachY1) {
				const u32 h = atomicAdd(p.nHits, 1u);
				if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.lane = (u8)lane; e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
				continue;
			}
		}
		// the target: the NEXT tick can land on the floor from above its row; try it with the jump
		else if (s.py < p.aboveMax && s.py + 16.0 > p.floorPy && gt0(s.speed_y)) {
			for (i32 jo = 0; jo < 3; jo++) {
				State<TW> t = s;
				Sim<TW> ts(p.L, t);
				Input ji = maskInput(jo == 0 ? 1 : jo == 1 ? 3 : 5);
				ts.tick(ji);
				nSim++;
				if (!t.is_dead && lt0(t.speed_y) && t.py <= p.floorPy && t.py > p.floorPy - 8.0) {
					const i32 lx = truncI(t.px + 8.0) >> 4;
					if (lx >= p.tx0 && lx <= p.tx1) {
						const u32 h = atomicAdd(p.nHits, 1u);
						if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = (u8)(jo == 0 ? 1 : jo == 1 ? 3 : 5); e.lane = (u8)lane; e.pad1 = 0; e.px = (float)t.px; e.vx = (float)t.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
					}
				}
			}
		}
		(void)startPy;
		// (snapped: a whole-pixel position or a zero speed, what a wall, floor or ceiling hit leaves; such states are the
		// precise ones a clip or a one-block gap needs, so they never share a cell with a near miss)
		const u32 snapped = (floor(s.px) == s.px ? 1u : 0u) | (floor(s.py) == s.py ? 2u : 0u) | (eq0(s.speed_x) ? 4u : 0u) | (eq0(s.speed_y) ? 8u : 0u);
		const u32 small = (u32)(s.on_ground ? 1 : 0) | ((u32)(s.jump_count & 7) << 1) | ((u32)(s.q0 & 0x7ff) << 4) | ((u32)(s.q1 & 0x7ff) << 15) | ((u32)(s.last_portal_set ? 1 : 0) << 26) | (snapped << 27);
		// near-miss refinement: a situation the earlier tries' near misses passed through gets cells rfx / rfv times finer
		// (bit 31 of small keeps them apart from the plain cells)
		const bool fine = p.refKeys && refineHit(p.refKeys, p.refMask, exploreSituation(s.py, s.speed_y, s.on_ground != 0, s.jump_count, cx));
		u64 key = fine ? exploreCell(s.px, s.py, s.speed_x, s.speed_y, small | 0x80000000u, false, p.qy, p.qvy, p.cqx * p.rfx, p.cqv * p.rfv)
			: exploreCell(s.px, s.py, s.speed_x, s.speed_y, small, cy < p.coarseRow, p.qy, p.qvy, p.cqx, p.cqv);
		u64 disc = 0;
		if (p.discrete) { disc = sim.hashDiscrete(); key = splitmix(key ^ disc); }
		if (lane) key = splitmix(key ^ (0xd6e8feb86659fd93ull * (u64)lane));   // (--lanes: a lane's own cells)
		// the proposal: the cell (12 low bits free for the layer tag) and a fixed priority: the reach-field distance
		// (12 bits: nearer the trophy first), the state's content (19 bits), then the parent's content and the option
		// (the rest: which of two identical children stands for the cell)
		u64 content = splitmix(doubleToBits(s.px) ^ splitmix(doubleToBits(s.py) ^ splitmix(doubleToBits(s.speed_x) ^ splitmix(doubleToBits(s.speed_y) ^ (u64)small ^ disc))));
		if (salt) content = splitmix(content ^ salt);   // (--salt: other representatives, another merged graph; + the lane)
		// waiting: a ball at rest (no input, not moved, no speed) stays in the frontier even when its cell is known, so it
		// is there when the time doors switch (then its cells are new again: the door phase is part of them)
		const bool rest = p.keepRest && o == 0 && s.px == par->px && s.py == par->py && eq0(s.speed_x) && eq0(s.speed_y);
		p.candKey[(size_t)pi * 18 + o] = (key & ~0xfffull) | (rest ? 2ull : 0ull) | 1ull;
		// (without a reach field the head is part of the content, so a full layer is still cut the same way every run)
		const u64 head = p.reach.on ? (u64)rcq : (content >> 52);
		p.candPrio[(size_t)pi * 18 + o] = (head << 51) | ((content & 0x7ffffull) << 32) | ((parentHash & 0x7ffffffull) << 5) | (u64)o;
	}
	if (p.closest && nearest < *(volatile unsigned long long*)p.closest) atomicMin(p.closest, (unsigned long long)nearest);
}
template <int TW>
__device__ void exploreExpandBody(const ExploreParams& p) {
	const i32 pi = (i32)p.lo + (i32)(blockIdx.x * blockDim.x + threadIdx.x);   // (the launch's parents: [lo, hi))
	unsigned long long nSim = 0, nTwin = 0;
	if (pi < (i32)p.hi && pi < p.nParents) exploreExpandParent<TW>(p, pi, nSim, nTwin);
	warpAdd(&p.stats[0], nSim); warpAdd(&p.stats[1], nTwin);   // (every lane: no early return above)
}
/** the claim, pass 1: each child finds its cell; new this layer -> it proposes its priority (the minimum wins) */
extern "C" __global__ void exploreClaimPropose(ExploreClaim q) {
	const u32 i = q.lo + blockIdx.x * blockDim.x + threadIdx.x;   // (the launch's candidates: [lo, hi))
	if (i >= q.hi || i >= q.nCand) return;
	const u64 ck = q.candKey[i];
	if (!ck) { q.candSlot[i] = EE_SLOT_DROP; return; }
	const u64 cell = ck & ~0xfffull, tag = ((u64)(q.layer & 0x7ffu) << 1) | 1ull;
	u32 slot = (u32)(splitmix(cell) & q.mask), res = EE_SLOT_DROP, probe = 0;
	for (; probe < 64; probe++) {
		u64 prev = q.cells[slot];
		if (prev == 0ull) {
			prev = atomicCAS((unsigned long long*)&q.cells[slot], 0ull, (unsigned long long)(cell | tag));
			if (prev == 0ull) { res = slot; break; }   // new: this layer's
		}
		if ((prev & ~0xfffull) == cell) {
			res = (prev & 0xfffull) == tag ? slot : ((ck & 2ull) ? EE_SLOT_REST : EE_SLOT_DROP);   // earlier layer: seen
			break;
		}
		slot = (slot + 1) & q.mask;
	}
	if (probe == 64 && q.nLost) atomicAdd(q.nLost, 1u);   // (64 probes all taken by other cells: a state lost, counted)
	q.candSlot[i] = res;
	if (res < EE_SLOT_REST) atomicMin((unsigned long long*)&q.cellBest[res], (unsigned long long)q.candPrio[i]);
}
/** pass 2: count the winners and their priority bins (for a full layer); selShift != ~0: a later pass of the radix
 *  select (explorehost.h claimCut), the histogram of the selBits bits at selShift of the key (the priority, or with
 *  selIdx the index of a winner at priority thr) among the winners whose key bits above them are selHi */
extern "C" __global__ void exploreClaimCount(ExploreClaim q) {
	const u32 i = q.lo + blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.hi || i >= q.nCand) return;
	const u32 s = q.candSlot[i];
	if (s == EE_SLOT_DROP || (s < EE_SLOT_REST && q.cellBest[s] != q.candPrio[i])) return;
	const u64 pr = q.candPrio[i];
	if (q.selShift != 0xffffffffu) {
		if (q.selIdx && pr != q.thr) return;
		const u64 key = q.selIdx ? (u64)i : pr;
		if ((key >> (q.selShift + q.selBits)) == q.selHi) atomicAdd(&q.hist[(u32)(key >> q.selShift) & ((1u << q.selBits) - 1u)], 1u);
		return;
	}
	atomicAdd(q.nWin, 1u);
	atomicAdd(&q.hist[prioBin(pr)], 1u);
}
/** pass 3: the winners below the cut (priority below thr, or thr with an index below thrIdx) are the next layer */
extern "C" __global__ void exploreClaimTake(ExploreClaim q) {
	const u32 i = q.lo + blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.hi || i >= q.nCand) return;
	const u32 s = q.candSlot[i];
	if (s == EE_SLOT_DROP || (s < EE_SLOT_REST && q.cellBest[s] != q.candPrio[i])) return;
	const u64 pr = q.candPrio[i];
	if (pr > q.thr || (pr == q.thr && i >= q.thrIdx)) return;
	const u32 k = atomicAdd(q.nOut, 1u);
	if (k < q.outCap) q.out[k] = ((i / 18u) << 5) | (i % 18u);
}

template <int TW>
__device__ void exploreMaterializeBody(const ExploreParams& p) {
	const i32 i = (i32)p.lo + (i32)(blockIdx.x * blockDim.x + threadIdx.x);
	if (i >= (i32)p.hi || i >= p.nPick) return;
	const u32 pk = p.pick[i];
	State<TW> s = *(const State<TW>*)(p.parents + (size_t)(pk >> 5) * p.stateBytes);
	Sim<TW> sim(p.L, s);
	Input in = maskInput(option((i32)(pk & 31)));
	sim.tick(in);
	*(State<TW>*)(p.next + (size_t)i * p.stateBytes) = s;
	if (p.lanes) p.lanesNext[i] = p.lanes[pk >> 5];   // (--lanes: the child stays in its parent's lane)
	if (p.nearTile) {
		// the near-miss record (--refine): how near this state's box centre comes to each neighbour tile's centre, as
		// (squared distance x 512, 20 bits) << 44 | layer << 21 | index in the layer (the cap is at most 2^21 states)
		const double cxp = s.px + 8.0, cyp = s.py + 8.0;
		const i32 tx = truncI(cxp) >> 4, ty = truncI(cyp) >> 4;
		if (tx >= 0 && ty >= 0 && tx < p.L.W && ty < p.L.H && i < (1 << 21) && p.layer >= 0 && p.layer < (1 << 23)) {
			const size_t t = (size_t)ty * p.L.W + tx;
			p.tileSeen[t] = 1;
			for (i32 k = 0; k < 8; k++) {
				const double ex = (tx + EE_NB_X(k)) * 16 + 8 - cxp, ey = (ty + EE_NB_Y(k)) * 16 + 8 - cyp;
				const double q = (ex * ex + ey * ey) * 512.0;
				const unsigned long long v = ((unsigned long long)(q < 1048575.0 ? (u64)q : 1048575ull) << 44) | ((u64)(u32)p.layer << 21) | (u64)(u32)i;
				if (v < p.nearTile[t * 8 + k]) atomicMin(&p.nearTile[t * 8 + k], v);
			}
		}
	}
}

#define INSTANCE(TW) INSTANCE_(TW)
#define INSTANCE_(TW) \
	extern "C" __global__ void __launch_bounds__(128) search_##TW(SearchParams p) { searchBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) twins_##TW(SearchParams p, u32* twin, i32 m1, i32 m2) { twinsBody<TW>(p, twin, m1, m2); } \
	extern "C" __global__ void trace_##TW(Level L, const u8* masks, i32 t0, i32 t1, u64* out, const u32* coinBits0, u64 seed, i32* info, u8* state) { traceBody<TW>(L, masks, t0, t1, out, coinBits0, seed, info, state); } \
	extern "C" __global__ void __launch_bounds__(128) bench_##TW(Level L, const u8* state0, i32 k0, i32 k1, u64 seed, unsigned long long* out, u8* states, u64* rng) { benchBody<TW>(L, state0, k0, k1, seed, out, states, rng); } 	extern "C" __global__ void __launch_bounds__(128) beamExpand_##TW(BeamParams p) { beamExpandBody<TW>(p); } 	extern "C" __global__ void __launch_bounds__(128) beamMaterialize_##TW(BeamParams p) { beamMaterializeBody<TW>(p); } 	extern "C" __global__ void __launch_bounds__(128) exploreExpand_##TW(ExploreParams p) { exploreExpandBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) exploreMaterialize_##TW(ExploreParams p) { exploreMaterializeBody<TW>(p); } \
	extern "C" __global__ void stateSize_##TW(i32* out) { out[0] = (i32)sizeof(State<TW>); out[1] = (i32)sizeof(SearchParams); out[2] = (i32)sizeof(Hit); out[3] = (i32)sizeof(Level); out[4] = (i32)sizeof(BeamParams); out[5] = (i32)sizeof(ExploreParams); out[6] = (i32)sizeof(ReachField); out[7] = 3; } \
	extern "C" __global__ void __launch_bounds__(128) reachTest_##TW(ReachField R, const double* in, i32 n, i32* out, float* score) { const i32 i = blockIdx.x * blockDim.x + threadIdx.x; \
		if (i < n) { const double* q = in + (size_t)i * 6; const RfPre pre = rfPre(R, q[2], (i32)q[3], (i32)q[4], q[5]); out[i] = rfFifthsAt(R, pre, q[0], q[1], q[2]); score[i] = out[i] >= 0 ? reachScore(R, pre, q[0], q[1], q[2], out[i]) : -1.f; } }
// one state size per PTX file (the build passes -DEE_ONLY_TW=8 / 32 / 128 / 512)
#ifndef EE_ONLY_TW
#define EE_ONLY_TW 8
#endif
INSTANCE(EE_ONLY_TW)
