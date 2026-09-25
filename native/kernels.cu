// kernels.cu - the GPU side of eegpu (compiled to PTX by NVRTC at build time: tools/build-native.js, with
// --fmad=false so every double operation is rounded exactly like the CPU / JS engine).
//   trace_<TW>: one thread replays a run from reset() and writes both state hashes after every tick (exactness proof)
//   search_<TW>: one thread per candidate (start tick x variant), the exact-rejoin search of search.h
//   stateSize_<TW>: sizeof(State<TW>) on the device (the host checks that the layouts agree)
// <TW> = capacity of the state's variable tail in words (8, 32, 128, 512); the host picks the smallest that fits.
#include "eecore.h"
#include "search.h"
#include "beam.h"

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

#define INSTANCE(TW) INSTANCE_(TW)
#define INSTANCE_(TW) \
	extern "C" __global__ void __launch_bounds__(128) search_##TW(SearchParams p) { searchBody<TW>(p); } \
	extern "C" __global__ void trace_##TW(Level L, const u8* masks, i32 n, u64* out, const u32* coinBits0, u64 seed, i32* info) { traceBody<TW>(L, masks, n, out, coinBits0, seed, info); } \
	extern "C" __global__ void __launch_bounds__(128) bench_##TW(Level L, const u8* state0, i32 ticks, u64 seed, unsigned long long* out) { benchBody<TW>(L, state0, ticks, seed, out); } 	extern "C" __global__ void __launch_bounds__(128) beamExpand_##TW(BeamParams p) { beamExpandBody<TW>(p); } 	extern "C" __global__ void __launch_bounds__(128) beamMaterialize_##TW(BeamParams p) { beamMaterializeBody<TW>(p); } 	extern "C" __global__ void stateSize_##TW(i32* out) { out[0] = (i32)sizeof(State<TW>); out[1] = (i32)sizeof(SearchParams); out[2] = (i32)sizeof(Hit); out[3] = (i32)sizeof(Level); }
// one state size per PTX file (the build passes -DEE_ONLY_TW=8 / 32 / 128 / 512)
#ifndef EE_ONLY_TW
#define EE_ONLY_TW 8
#endif
INSTANCE(EE_ONLY_TW)
