// exactkernels.cu - the kernels of `eegpu exact` (native/exact.h, native/exacthost.h): a module of their own
// (eegpu ptx --src=exactkernels.cu -> eegpu_exact_<tw>.ptx; tools/gpuproof/build-linux.sh), so the app's kernels.cu and
// its PTX stay as they are. NVRTC with --fmad=false like kernels.cu: every double operation as the CPU / JS engine.
//   exactExpand_<TW>: one thread per parent: its children under the 18 inputs (twins of a lower option skipped), each a
//     finish, cut by h, merged by the visited set, or new (its (parent, option) appended to the picks)
//   exactMaterialize_<TW>: one thread per pick: parent + option -> the next layer's state
//   exactH_<TW>: h (exact.h xhOf) of a list of states (eegpu exacth: the GPU's h against tools/perfect/gpuh.js's)
//   exactSize_<TW>: the device's struct sizes (the host refuses kernels of another layout)
#include "eecore.h"
#include "search.h"
#include "exact.h"

using namespace ee;

/** a per-warp sum added to *dst (every lane of the warp must call it) */
__device__ __forceinline__ void xWarpAdd(unsigned long long* dst, unsigned long long v) {
	for (int o = 16; o > 0; o >>= 1) v += __shfl_down_sync(0xffffffffu, v, o);
	if ((threadIdx.x & 31) == 0 && v) atomicAdd(dst, v);
}

template <int TW>
__device__ __forceinline__ void exactExpandParent(const ExactParams& p, const u32 gi, unsigned long long* st) {
	const State<TW>* par = (const State<TW>*)(p.parents + (size_t)(gi - p.base) * p.stateBytes);
	const bool first = p.layer == 0;   // (a source: the timer has not started; option 0 is the next idle start, in layer 0)
	u32 used = 31, jumpUsed = 0x1ffu;
	const i32 c = p.layer + 1;
	for (i32 o = first ? 1 : 0; o < 18; o++) {
		if (!first && o > 0 && canonOption(o, used, jumpUsed) != o) { st[1]++; continue; }
		State<TW> s = *par;
		Sim<TW> sim(p.L, s);
		Input in = maskInput(option(o));
		sim.tick(in);
		st[0]++;
		if (!first) {
			if (o == 0) { used = sim.inUsed(); jumpUsed = 0; }
			if (!(o & 1)) jumpUsed |= (sim.inUsed() & 1u) << (o >> 1);
		}
		if (s.broken) { st[6]++; continue; }
		if (s.is_dead) { st[2]++; if (!p.deaths) continue; }
		if (s.has_silver_crown) {
			if (*(volatile unsigned long long*)p.found == 0) atomicCAS(p.found, 0ull, (((unsigned long long)gi << 5) | (unsigned long long)o) + 1ull);
			continue;
		}
		// (a child at the layer bound is never expanded: wholepar.js's dfs returns at lim < 1 before h; its f >= Cl + 1)
		const i32 lim = p.Cl - c;
		if (lim < 1) {
			st[3]++;
			if ((u32)(p.Cl + 1) < *(volatile u32*)p.nextF) atomicMin(p.nextF, (u32)(p.Cl + 1));
			continue;
		}
		i32 gst = 0;
		const double h = xhOf<TW>(p.G, p.L, sim, lim, &gst);
		if (gst == 1) st[8]++; else if (gst == 2) st[9]++; else if (gst == 3) st[10]++;
		if (xhIsInf(h)) { st[3]++; st[11]++; continue; }
		const double f = (double)c + h;
		if (f > (double)p.Cl) {
			st[3]++;
			const u32 fi = f < 4.0e9 ? (u32)f : 0xfffffffeu;
			if (fi < *(volatile u32*)p.nextF) atomicMin(p.nextF, fi);
			continue;
		}
		const u64 b = xsKeyB(sim.hash2(false)), a = xsKeyA(sim.hash(false), b);
		u32 slot = 0;
		const int r = xsInsert(p.table, p.tableMask, p.probeMax, a, b, &slot);
		if (r == 0) { st[4]++; continue; }
		if (r == 2) st[7]++;
		else atomicMin(&p.layerOf[slot], (u32)c);
		const u32 q = atomicAdd(p.nPick, 1u);
		if (q < p.pickCap) p.picks[q] = ((u64)gi << 5) | (u64)o;
		// (while the next layer's GPU arena has room the child goes there at once: no second tick in the materialize)
		if (q < p.directCap) *(State<TW>*)(p.nextDirect + (size_t)q * p.stateBytes) = s;
		st[5]++;
	}
}

template <int TW>
__device__ void exactExpandBody(const ExactParams& p) {
	const u32 gi = p.lo + blockIdx.x * blockDim.x + threadIdx.x;
	unsigned long long st[XS_NSTATS];
	for (int k = 0; k < XS_NSTATS; k++) st[k] = 0;
	if (gi < p.hi) exactExpandParent<TW>(p, gi, st);
	for (int k = 0; k < XS_NSTATS; k++) xWarpAdd(&p.stats[k], st[k]);   // (every lane: no early return above)
}

template <int TW>
__device__ void exactMaterializeBody(const ExactParams& p) {
	const u32 k = p.lo + blockIdx.x * blockDim.x + threadIdx.x;
	if (k >= p.hi) return;
	const u64 pk = p.mpicks[k];
	State<TW> s = *(const State<TW>*)(p.parents + (size_t)((u32)(pk >> 5) - p.base) * p.stateBytes);
	Sim<TW> sim(p.L, s);
	Input in = maskInput(option((i32)(pk & 31)));
	sim.tick(in);
	*(State<TW>*)(p.next + (size_t)(k - p.dstBase) * p.stateBytes) = s;
}

// ---------------------------------------------------------------- the depth-first stage (exact.h DfsParams)
// One thread = one stack; a step = one child simulated (the twin skips and the pops are free), the same rules as the
// expand: a finish, a child at the bound, h's cut, the table (a slot's least layer by atomicMin: pruned only when some
// thread entered the state at a layer <= this one), else pushed.
template <int TW>
__device__ void exactDfsBody(const DfsParams& p) {
	const u32 t = blockIdx.x * blockDim.x + threadIdx.x;
	unsigned long long st[XS_NSTATS];
	for (int k = 0; k < XS_NSTATS; k++) st[k] = 0;
	bool idle = false;
	if (t < p.nThreads) {
		i32 dep = p.depth[t];
		u32 tk = p.task[t];
		u8* fr0 = p.stk + (size_t)t * p.maxDepth * p.stateBytes;
		u64* mt = p.meta + (size_t)t * p.maxDepth;
		u32 steps = 0;
		while (steps < p.budget) {
			if ((steps & 63) == 0 && *(volatile u32*)p.stop) break;
			// the next child to simulate: pops, a new task and the twins of a lower option all here, so the warp's lanes
			// meet again at the tick (SIMT: one step = one child for every lane)
			i32 o = 0;
			bool first = false;
			u32 used = 31, jumpUsed = 0x1ff;
			bool none = false;
			for (;;) {
				if (dep < 0) {
					tk = atomicAdd(p.taskNext, 1u);
					if (tk >= p.nTasks) { idle = true; none = true; break; }
					*(State<TW>*)fr0 = *(const State<TW>*)(p.tasks + (size_t)tk * p.stateBytes);
					const bool src = p.D == 0;
					mt[0] = xdMeta(src ? 1 : 0, 31, 0x1ff, src);
					dep = 0;
				}
				const u64 m = mt[dep];
				o = (i32)(m & 31);
				first = ((m >> 19) & 1) != 0;
				used = (u32)((m >> 5) & 31); jumpUsed = (u32)((m >> 10) & 0x1ff);
				if (!first) while (o > 0 && o < 18 && canonOption(o, used, jumpUsed) != o) { o++; st[1]++; }
				if (o >= 18) { dep--; continue; }
				break;
			}
			if (none) break;
			mt[dep] = xdMeta(o + 1, used, jumpUsed, first);
			steps++;
			State<TW> s = *(const State<TW>*)(fr0 + (size_t)dep * p.stateBytes);
			Sim<TW> sim(p.L, s);
			Input in = maskInput(option(o));
			sim.tick(in);
			st[0]++;
			if (!first) {
				if (o == 0) { used = sim.inUsed(); jumpUsed = 0; }
				if (!(o & 1)) jumpUsed |= (sim.inUsed() & 1u) << (o >> 1);
				mt[dep] = xdMeta(o + 1, used, jumpUsed, first);
			}
			const i32 c = p.D + dep + 1;
			if (s.broken) { st[6]++; continue; }
			if (s.is_dead) { st[2]++; if (!p.deaths) continue; }
			if (s.has_silver_crown) {
				if (atomicCAS(p.found, 0ull, (unsigned long long)tk + 1ull) == 0ull) {
					p.foundPath[0] = dep + 1;
					for (i32 k = 0; k < dep; k++) p.foundPath[1 + k] = (i32)(mt[k] & 31) - 1;
					p.foundPath[1 + dep] = o;
					atomicExch(p.stop, 1u);
				}
				break;
			}
			const i32 lim = p.Cl - c;
			if (lim < 1) {
				st[3]++;
				if ((u32)(p.Cl + 1) < *(volatile u32*)p.nextF) atomicMin(p.nextF, (u32)(p.Cl + 1));
				continue;
			}
			i32 gst = 0;
			const double h = xhOf<TW>(p.G, p.L, sim, lim, &gst);
			if (gst == 1) st[8]++; else if (gst == 2) st[9]++; else if (gst == 3) st[10]++;
			if (xhIsInf(h)) { st[3]++; st[11]++; continue; }
			const double f = (double)c + h;
			if (f > (double)p.Cl) {
				st[3]++;
				const u32 fi = f < 4.0e9 ? (u32)f : 0xfffffffeu;
				if (fi < *(volatile u32*)p.nextF) atomicMin(p.nextF, fi);
				continue;
			}
			// (the table only for states with lim >= ttMinLim: the deepest layers hold most states and their subtrees are
			// a few ticks, so they are searched again rather than kept; no entry = no prune: sound)
			if (lim >= p.ttMinLim) {
				const u64 b = xsKeyB(sim.hash2(false)), a = xsKeyA(sim.hash(false), b);
				u32 slot = 0;
				int r = xsInsert(p.table, p.tableMask, p.probeMax, a, b, &slot);
				u32* lay = p.layerOf;
				// (the main table's probes full: the second table, in the stack arena's spare memory)
				if (r == 2 && p.table2) { r = xsInsert(p.table2, p.tableMask2, p.probeMax, a, b, &slot); lay = p.layerOf2; }
				if (r == 2) st[7]++;
				else {
					const u32 old = atomicMin(&lay[slot], (u32)c);
					if (old <= (u32)c) { st[4]++; continue; }
				}
			}
			st[5]++;
			*(State<TW>*)(fr0 + (size_t)(dep + 1) * p.stateBytes) = s;
			mt[dep + 1] = xdMeta(0, 31, 0, false);
			dep++;
		}
		p.depth[t] = dep;
		p.task[t] = tk;
	}
	if (idle) atomicAdd(p.idle, 1u);
	for (int k = 0; k < XS_NSTATS; k++) xWarpAdd(&p.stats[k], st[k]);
}

/** the table's layers above maxLayer forgotten (an aborted layer's entries: the depth-first stage searches them again) */
extern "C" __global__ void exactForget(u32* layerOf, u32 lo, u32 hi, u32 maxLayer) {
	const u32 i = lo + blockIdx.x * blockDim.x + threadIdx.x;
	if (i < hi && layerOf[i] != 0xffffffffu && layerOf[i] > maxLayer) layerOf[i] = 0xffffffffu;
}

template <int TW>
__device__ void exactHBody(const GpuH& G, const Level& L, const u8* states, i32 sb, i32 n, i32 lim, double* out, i32* gst) {
	const i32 i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i >= n) return;
	State<TW> s = *(const State<TW>*)(states + (size_t)i * sb);
	Sim<TW> sim(L, s);
	i32 g = 0;
	out[i] = xhOf<TW>(G, L, sim, lim, &g);
	gst[i] = g;
}

#define XINSTANCE(TW) XINSTANCE_(TW)
#define XINSTANCE_(TW) \
	extern "C" __global__ void __launch_bounds__(128) exactExpand_##TW(ExactParams p) { exactExpandBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) exactMaterialize_##TW(ExactParams p) { exactMaterializeBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) exactDfs_##TW(DfsParams p) { exactDfsBody<TW>(p); } \
	extern "C" __global__ void __launch_bounds__(128) exactH_##TW(GpuH G, Level L, const u8* states, i32 sb, i32 n, i32 lim, double* out, i32* gst) { exactHBody<TW>(G, L, states, sb, n, lim, out, gst); } \
	extern "C" __global__ void exactSize_##TW(i32* out) { out[0] = (i32)sizeof(State<TW>); out[1] = (i32)sizeof(Level); out[2] = (i32)sizeof(GpuH); out[3] = (i32)sizeof(ExactParams); out[4] = (i32)sizeof(HField); out[5] = (i32)sizeof(DfsParams); }
#ifndef EE_ONLY_TW
#define EE_ONLY_TW 8
#endif
XINSTANCE(EE_ONLY_TW)
