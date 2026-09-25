// kernels.cu - the GPU side of eegpu (compiled to PTX by NVRTC at build time: tools/build-native.js, with
// --fmad=false so every double operation is rounded exactly like the CPU / JS engine).
//   trace_<TW>: one thread replays a run from reset() and writes both state hashes after every tick (exactness proof)
//   search_<TW>: one thread per candidate (start tick x variant), the exact-rejoin search of search.h
//   stateSize_<TW>: sizeof(State<TW>) on the device (the host checks that the layouts agree)
// <TW> = capacity of the state's variable tail in words (8, 32, 128, 512); the host picks the smallest that fits.
#include "eecore.h"
#include "search.h"

using namespace ee;

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

template <int TW>
__device__ void searchBody(const SearchParams& p) {
	const i32 gid = blockIdx.x * blockDim.x + threadIdx.x;
	const i32 ti = gid / p.V, v = gid - ti * p.V;
	unsigned long long nTicks = 0, nCand = 0, nDeath = 0, nDrift = 0, nNoop = 0, nEnd = 0, nHit = 0, nBroken = 0;
	if (ti < p.nT) {
		const i32 t = p.t0 + ti;
		Cand c = makeCand(p.family, t, v, p.seed, p.masks, p.n);
		if (c.valid) {
			nCand = 1;
			State<TW> s;
			{
				const u32* src = (const u32*)(p.snaps + (size_t)t * p.stateBytes);
				u32* dst = (u32*)&s;
				for (i32 i = 0; i < (i32)(sizeof(State<TW>) / 4); i++) dst[i] = src[i];
			}
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
					const double fx = floor(s.px), fy = floor(s.py);
					if (fx >= 0.0 && fy >= 0.0 && fx < (double)p.pixW && fy < (double)p.pixH) {
						const u32 bit = (u32)fy * (u32)p.pixW + (u32)fx;
						if ((p.pix[bit >> 5] >> (bit & 31)) & 1u) {
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

#define INSTANCE(TW) \
	extern "C" __global__ void __launch_bounds__(128) search_##TW(SearchParams p) { searchBody<TW>(p); } \
	extern "C" __global__ void trace_##TW(Level L, const u8* masks, i32 n, u64* out, const u32* coinBits0, u64 seed, i32* info) { traceBody<TW>(L, masks, n, out, coinBits0, seed, info); } \
	extern "C" __global__ void stateSize_##TW(i32* out) { out[0] = (i32)sizeof(State<TW>); out[1] = (i32)sizeof(SearchParams); out[2] = (i32)sizeof(Hit); out[3] = (i32)sizeof(Level); }
INSTANCE(8)
INSTANCE(32)
INSTANCE(128)
INSTANCE(512)
