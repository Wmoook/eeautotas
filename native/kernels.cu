// kernels.cu - the GPU side of eegpu (compiled to PTX by NVRTC at build time: tools/build-native.js, with
// --fmad=false so every double operation is rounded exactly like the CPU / JS engine).
//   trace_<TW>: one thread replays a run from reset() and writes both state hashes after every tick (exactness proof)
//   search_<TW>: one thread per candidate (start tick x variant), the exact-rejoin search of search.h
//   stateSize_<TW>: sizeof(State<TW>) on the device (the host checks that the layouts agree)
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

__device__ __forceinline__ void warpAdd(unsigned long long* dst, unsigned long long v) {
	for (int o = 16; o > 0; o >>= 1) v += __shfl_down_sync(0xffffffffu, v, o);
	if ((threadIdx.x & 31) == 0 && v) atomicAdd(dst, v);
}

// One thread per candidate; consecutive threads are consecutive variants of the same start tick t: a warp loads ONE
// start state (a broadcast read; 32 different states cost 32x the memory traffic, measured) and shares the level
// geometry around it.
template <int TW>
__device__ void searchBody(const SearchParams& p) {
	const i32 gid = blockIdx.x * blockDim.x + threadIdx.x;
	const i32 ti = gid / p.V, v = gid - ti * p.V;
	unsigned long long nTicks = 0, nCand = 0, nDeath = 0, nDrift = 0, nNoop = 0, nEnd = 0, nHit = 0, nBroken = 0;
	if (ti < p.nT) {
		const i32 t = p.t0 + ti;
		Cand c = makeCand(p.family, t, v, p.seed, p.masks, p.n);
		if (c.valid) {
			nCand++;
			State<TW> s = *(const State<TW>*)(p.snaps + (size_t)t * p.stateBytes);
			Sim<TW> sim(p.L, s);
			const bool crown0 = s.has_silver_crown != 0;
			i32 sticky = 0;
			for (i32 k = 0;; k++) {
				const i32 m = candInput(c, p.masks, p.n, k, sticky);
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
					const i32 r = t + c.skip + (done - c.prefix);
					if (r > p.n) { nEnd++; break; }
					if (fabs(s.px - p.X[r]) + fabs(s.py - p.Y[r]) > p.drift) { nDrift++; break; }
				}
				if (done >= p.horizon) { nEnd++; break; }
			}
		}
	}
	warpAdd(&p.stats[0], nTicks); warpAdd(&p.stats[1], nCand); warpAdd(&p.stats[2], nDeath); warpAdd(&p.stats[3], nDrift);
	warpAdd(&p.stats[4], nNoop); warpAdd(&p.stats[5], nEnd); warpAdd(&p.stats[6], nHit); warpAdd(&p.stats[7], nBroken);
}

template <int TW>
__device__ void traceBody(Level L, const u8* masks, i32 n, u64* out, const u32* coinBits0, u64 seed, i32* info) {
	if (blockIdx.x != 0 || threadIdx.x != 0) return;
	State<TW> s;
	Sim<TW> sim(L, s);
	sim.reset(coinBits0, seed);
	out[0] = sim.hash(false); out[1] = sim.hash(true);
	i32 complete = -1, runTicks = -1, broken = -1;
	for (i32 t = 0; t < n; t++) {
		Input in = maskInput(masks[t]);
		const bool had = s.has_silver_crown != 0;
		sim.tick(in);
		out[2 * (t + 1)] = sim.hash(false); out[2 * (t + 1) + 1] = sim.hash(true);
		if (!had && s.has_silver_crown && complete < 0) { complete = t + 1; runTicks = s.run_ticks; }
		if (s.broken && broken < 0) broken = t + 1;
	}
	info[0] = complete; info[1] = runTicks; info[2] = s.deaths; info[3] = broken;
}

// Raw engine speed (the processor benchmark): every thread plays random sticky inputs from the same start state, the
// workload of src/bench.js on the CPU, so the two numbers compare.
template <int TW>
__device__ void benchBody(Level L, const u8* state0, i32 ticks, u64 seed, unsigned long long* out) {
	State<TW> s = *(const State<TW>*)state0;
	Sim<TW> sim(L, s);
	const i32 gid = blockIdx.x * blockDim.x + threadIdx.x;
	u64 r = splitmix(seed ^ (u64)gid);
	i32 m = 0;
	unsigned long long n = 0;
	for (i32 k = 0; k < ticks; k++) {
		r = splitmix(r);
		if (k == 0 || (r & 255) < 26) m = option((i32)((r >> 8) % 18));
		Input in = maskInput(m);
		sim.tick(in);
		n++;
	}
	warpAdd(out, n);
}

// ---------------------------------------------------------------- guided beam search (beam.h)
// expand: one thread per parent; it plays all 18 options from the parent (a fresh copy each time): the lanes of a
// warp are 32 parents playing the same option, so they stay in step, and each parent state is loaded once.
template <int TW>
__device__ void beamExpandBody(const BeamParams& p) {
	const i32 pi = blockIdx.x * blockDim.x + threadIdx.x;
	if (pi >= p.nParents) return;
	const State<TW>* par = (const State<TW>*)(p.parents + (size_t)pi * p.stateBytes);
	const bool crown0 = par->has_silver_crown != 0;
	for (i32 o = 0; o < 18; o++) {
		State<TW> s = *par;
		Sim<TW> sim(p.L, s);
		Input in = maskInput(option(o));
		sim.tick(in);
		BeamChild c;
		c.parent = (u32)pi; c.option = (u8)o; c.flags = 0; c.rejoin = -1; c.hash = 0; c.score = -1e30f; c.bucket = 0;
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
			if (p.goalWeight > 0) sc -= p.goalWeight * goalScore(p, p.L, cx, cy);
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
}
// materialize: one thread per kept child: parent + option -> the next layer's state
template <int TW>
__device__ void beamMaterializeBody(const BeamParams& p) {
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= p.nPick) return;
	const u32 pk = p.pick[i];
	State<TW> s = *(const State<TW>*)(p.parents + (size_t)(pk >> 5) * p.stateBytes);
	Sim<TW> sim(p.L, s);
	Input in = maskInput(option((i32)(pk & 31)));
	sim.tick(in);
	*(State<TW>*)(p.next + (size_t)i * p.stateBytes) = s;
}

// ---------------------------------------------------------------- the beam's selection (beam.h BeamSel)
extern "C" __global__ void beamSelInsert(BeamSel q) {
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.nKids) return;
	const BeamChild c = q.kids[i];
	if (c.flags & (2 | 4)) { const u32 r = atomicAdd(q.nRes, 1u); if (r < q.resCap) q.res[r] = (u32)i; }
	if (c.flags & (1 | 2 | 8)) { q.slot[i] = ~0u; return; }
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
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.nKids) return;
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
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.nKids || !q.win[i]) return;
	atomicAdd(&q.hist[scoreBin(q, orderedScore(q.kids[i].score))], 1u);
}
/** one round: the winners in score bins [bLo, bHi] */
extern "C" __global__ void beamSelPick(BeamSel q, i32 bLo, i32 bHi) {
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= q.nKids || !q.win[i]) return;
	const BeamChild c = q.kids[i];
	const i32 b = scoreBin(q, orderedScore(c.score));
	if (b < bLo || b > bHi) return;
	if (atomicAdd(&q.bucketCnt[c.bucket], 1u) >= (u32)q.bucketCap) { const u32 o = atomicAdd(q.nOver, 1u); if (o < q.overCap) q.over[o] = (u32)i; return; }
	const u32 s = atomicAdd(q.nPick, 1u);
	if (s < q.K) q.pick[s] = (c.parent << 5) | c.option;
}
/** the fill-up: pick[n0 + j] = the j-th state over the cap (j < need) */
extern "C" __global__ void beamSelFill(BeamSel q, u32 n0, u32 need) {
	const u32 j = blockIdx.x * blockDim.x + threadIdx.x;
	if (j >= need) return;
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
template <int TW>
__device__ void exploreExpandBody(const ExploreParams& p) {
	const i32 pi = blockIdx.x * blockDim.x + threadIdx.x;
	if (pi >= p.nParents) return;
	const State<TW>* par = (const State<TW>*)(p.parents + (size_t)pi * p.stateBytes);
	for (i32 o = 0; o < 18; o++) {
		State<TW> s = *par;
		Sim<TW> sim(p.L, s);
		const double startPy = s.py;
		Input in = maskInput(option(o));
		sim.tick(in);
		if (s.broken || s.is_dead) continue;
		const i32 cx = truncI(s.px + 8.0) >> 4, cy = truncI(s.py + 8.0) >> 4;
		if (cx < p.rx0 || cx > p.rx1 || cy < p.ry0 || cy > p.ry1) continue;
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
					if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.pad0 = e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = bestR - now; e.refTick = bestR; p.hits[h] = e; }
				}
			}
		}
		else if (p.target == 3) {   // the finish: this tick took the trophy (the silver crown); report, do not expand
			if (s.has_silver_crown && !par->has_silver_crown) {
				const u32 h = atomicAdd(p.nHits, 1u);
				if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.pad0 = e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
				continue;
			}
		}
		else if (p.target == 1) {   // reach a region: report and do not expand further
			if (cx >= p.reachX0 && cx <= p.reachX1 && cy >= p.reachY0 && cy <= p.reachY1) {
				const u32 h = atomicAdd(p.nHits, 1u);
				if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = 255; e.pad0 = e.pad1 = 0; e.px = (float)s.px; e.vx = (float)s.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
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
				if (!t.is_dead && lt0(t.speed_y) && t.py <= p.floorPy && t.py > p.floorPy - 8.0) {
					const i32 lx = truncI(t.px + 8.0) >> 4;
					if (lx >= p.tx0 && lx <= p.tx1) {
						const u32 h = atomicAdd(p.nHits, 1u);
						if (h < p.hitCap) { ExploreHit e; e.parent = (u32)pi; e.option = (u8)o; e.jumpOption = (u8)(jo == 0 ? 1 : jo == 1 ? 3 : 5); e.pad0 = e.pad1 = 0; e.px = (float)t.px; e.vx = (float)t.speed_x; e.layer = p.layer; e.gain = 0; e.refTick = -1; p.hits[h] = e; }
					}
				}
			}
		}
		(void)startPy;
		const u32 small = (u32)(s.on_ground ? 1 : 0) | ((u32)(s.jump_count & 7) << 1) | ((u32)(s.q0 & 0x7ff) << 4) | ((u32)(s.q1 & 0x7ff) << 15) | ((u32)(s.last_portal_set ? 1 : 0) << 26);
		u64 key = exploreCell(s.px, s.py, s.speed_x, s.speed_y, small, cy < p.coarseRow, p.qy, p.qvy, p.cqx, p.cqv);
		if (p.discrete) key = splitmix(key ^ sim.hashDiscrete()) | 1ull;
		if (!cellInsert(p.cells, p.cellMask, key)) {
			// waiting: a ball at rest (no input, not moved, no speed) stays in the frontier, so it is there when the
			// time doors switch (then its cells are new again: the door phase is part of them)
			if (!(p.keepRest && o == 0 && s.px == par->px && s.py == par->py && eq0(s.speed_x) && eq0(s.speed_y))) continue;
		}
		const u32 slot = atomicAdd(p.nOut, 1u);
		if (slot < p.outCap) p.out[slot] = ((u32)pi << 5) | (u32)o;
	}
}
template <int TW>
__device__ void exploreMaterializeBody(const ExploreParams& p) {
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= p.nPick) return;
	const u32 pk = p.pick[i];
	State<TW> s = *(const State<TW>*)(p.parents + (size_t)(pk >> 5) * p.stateBytes);
	Sim<TW> sim(p.L, s);
	Input in = maskInput(option((i32)(pk & 31)));
	sim.tick(in);
	*(State<TW>*)(p.next + (size_t)i * p.stateBytes) = s;
}

#define INSTANCE(TW) INSTANCE_(TW)
#define INSTANCE_(TW) \
	extern "C" __global__ void __launch_bounds__(128) search_##TW(SearchParams p) { searchBody<TW>(p); } \
	extern "C" __global__ void trace_##TW(Level L, const u8* masks, i32 n, u64* out, const u32* coinBits0, u64 seed, i32* info) { traceBody<TW>(L, masks, n, out, coinBits0, seed, info); } \
	extern "C" __global__ void __launch_bounds__(128) bench_##TW(Level L, const u8* state0, i32 ticks, u64 seed, unsigned long long* out) { benchBody<TW>(L, state0, ticks, seed, out); } 	extern "C" __global__ void __launch_bounds__(128) beamExpand_##TW(BeamParams p) { beamExpandBody<TW>(p); } 	extern "C" __global__ void __launch_bounds__(128) beamMaterialize_##TW(BeamParams p) { beamMaterializeBody<TW>(p); } 	extern "C" __global__ void __launch_bounds__(128) exploreExpand_##TW(ExploreParams p) { exploreExpandBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) exploreMaterialize_##TW(ExploreParams p) { exploreMaterializeBody<TW>(p); } \
	extern "C" __global__ void stateSize_##TW(i32* out) { out[0] = (i32)sizeof(State<TW>); out[1] = (i32)sizeof(SearchParams); out[2] = (i32)sizeof(Hit); out[3] = (i32)sizeof(Level); }
// one state size per PTX file (the build passes -DEE_ONLY_TW=8 / 32 / 128 / 512)
#ifndef EE_ONLY_TW
#define EE_ONLY_TW 8
#endif
INSTANCE(EE_ONLY_TW)
