// emu.cpp - runs eegpu (native/eegpu.cpp) with its CUDA kernels (native/kernels.cu) emulated on the CPU, one thread at
// a time, behind a fake CUDA driver: tests the GPU commands (explore, beam, search) without a GPU. Scratch tool.
//   zig c++ -O2 -std=c++17 ... -DNATIVE_DIR=... emu.cpp -o emu.exe ; emu.exe <eegpu args> --ptxdir=<dir with dummy ptx>
// NEVER loads nvcuda.dll: LoadLibraryA / GetProcAddress are replaced before cudadrv.h is read.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <string>
#include <vector>
#include <map>
#include <functional>

// ---- the CUDA language on the host
#define EE_EMU 1
#define __global__
#define __device__
#define __host__
#define __forceinline__ inline
#define __noinline__
#define __launch_bounds__(n)
struct EmuDim { unsigned x, y, z; };
static EmuDim blockIdx, threadIdx, blockDim;
inline unsigned atomicAdd(unsigned* p, unsigned v) { unsigned o = *p; *p = o + v; return o; }
inline unsigned long long atomicAdd(unsigned long long* p, unsigned long long v) { unsigned long long o = *p; *p = o + v; return o; }
inline unsigned long long atomicCAS(unsigned long long* p, unsigned long long c, unsigned long long v) { unsigned long long o = *p; if (o == c) *p = v; return o; }
inline unsigned long long atomicMin(unsigned long long* p, unsigned long long v) { unsigned long long o = *p; if (v < o) *p = v; return o; }
inline unsigned long long atomicMax(unsigned long long* p, unsigned long long v) { unsigned long long o = *p; if (v > o) *p = v; return o; }
inline unsigned atomicMin(unsigned* p, unsigned v) { unsigned o = *p; if (v < o) *p = v; return o; }
inline unsigned atomicMax(unsigned* p, unsigned v) { unsigned o = *p; if (v > o) *p = v; return o; }
inline int atomicMax(int* p, int v) { int o = *p; if (v > o) *p = v; return o; }
inline unsigned atomicOr(unsigned* p, unsigned v) { unsigned o = *p; *p = o | v; return o; }

#include KERNELS_CU
INSTANCE(32)
INSTANCE(128)
INSTANCE(512)

// ---- the fake driver
static HMODULE emuLoadLibraryA(const char* name) { return strstr(name, "nvcuda") ? (HMODULE)(uintptr_t)1 : nullptr; }
static FARPROC emuGetProcAddress(HMODULE, const char* name);
#define LoadLibraryA emuLoadLibraryA
#define GetProcAddress emuGetProcAddress
#define main eegpu_main
#include EEGPU_CPP
#undef main
#undef LoadLibraryA
#undef GetProcAddress

using namespace ee;
struct EmuKernel { std::string name; std::function<void(void**)> run; };
static std::map<std::string, EmuKernel*> kernels;
static void reg(const std::string& name, std::function<void(void**)> run) { kernels[name] = new EmuKernel{ name, run }; }
static uint64_t emuThreads = 0;
static void regAll() {
#define TWK(TW) \
	reg("search_" #TW, [](void** a) { search_##TW(*(SearchParams*)a[0]); }); \
	reg("twins_" #TW, [](void** a) { twins_##TW(*(SearchParams*)a[0], *(u32**)a[1], *(i32*)a[2], *(i32*)a[3]); }); \
	reg("trace_" #TW, [](void** a) { trace_##TW(*(Level*)a[0], *(const u8**)a[1], *(i32*)a[2], *(u64**)a[3], *(const u32**)a[4], *(u64*)a[5], *(i32**)a[6]); }); \
	reg("beamExpand_" #TW, [](void** a) { beamExpand_##TW(*(BeamParams*)a[0]); }); \
	reg("beamMaterialize_" #TW, [](void** a) { beamMaterialize_##TW(*(BeamParams*)a[0]); }); \
	reg("exploreExpand_" #TW, [](void** a) { exploreExpand_##TW(*(ExploreParams*)a[0]); }); \
	reg("exploreMaterialize_" #TW, [](void** a) { exploreMaterialize_##TW(*(ExploreParams*)a[0]); }); \
	reg("stateSize_" #TW, [](void** a) { stateSize_##TW(*(i32**)a[0]); });
	TWK(8) TWK(32) TWK(128) TWK(512)
	reg("beamSelInsert", [](void** a) { beamSelInsert(*(BeamSel*)a[0]); });
	reg("beamSelWinners", [](void** a) { beamSelWinners(*(BeamSel*)a[0]); });
	reg("beamSelHist", [](void** a) { beamSelHist(*(BeamSel*)a[0]); });
	reg("beamSelPick", [](void** a) { beamSelPick(*(BeamSel*)a[0], *(i32*)a[1], *(i32*)a[2]); });
	reg("beamSelFill", [](void** a) { beamSelFill(*(BeamSel*)a[0], *(u32*)a[1], *(u32*)a[2]); });
	reg("exploreClaimPropose", [](void** a) { exploreClaimPropose(*(ExploreClaim*)a[0]); });
	reg("exploreClaimCount", [](void** a) { exploreClaimCount(*(ExploreClaim*)a[0]); });
	reg("exploreClaimTake", [](void** a) { exploreClaimTake(*(ExploreClaim*)a[0]); });
}

typedef cu::CUresult R;
static R __stdcall e_cuInit(unsigned) { return 0; }
static R __stdcall e_cuDriverGetVersion(int* v) { *v = 12060; return 0; }
static R __stdcall e_cuDeviceGetCount(int* n) { *n = 1; return 0; }
static R __stdcall e_cuDeviceGet(cu::CUdevice* d, int) { *d = 0; return 0; }
static R __stdcall e_cuDeviceGetName(char* s, int n, cu::CUdevice) { snprintf(s, n, "CPU emulation"); return 0; }
static R __stdcall e_cuDeviceGetAttribute(int* v, int a, cu::CUdevice) { *v = a == cu::ATTR_SM_COUNT ? 4 : a == cu::ATTR_CLOCK_KHZ ? 1000000 : a == cu::ATTR_CC_MAJOR ? 8 : a == cu::ATTR_CC_MINOR ? 6 : 1536; return 0; }
static R __stdcall e_cuDeviceTotalMem_v2(size_t* m, cu::CUdevice) { *m = (size_t)2 << 30; return 0; }
static R __stdcall e_cuCtxCreate_v2(cu::CUcontext* c, unsigned, cu::CUdevice) { *c = (void*)1; return 0; }
static R __stdcall e_cuCtxDestroy_v2(cu::CUcontext) { return 0; }
static R __stdcall e_cuModuleLoadDataEx(cu::CUmodule* m, const void*, unsigned, int*, void**) { *m = (void*)1; return 0; }
static R __stdcall e_cuModuleGetFunction(cu::CUfunction* f, cu::CUmodule, const char* name) {
	auto it = kernels.find(name);
	if (it == kernels.end()) return 500;
	*f = it->second; return 0;
}
static R __stdcall e_cuMemAlloc_v2(cu::CUdeviceptr* p, size_t n) {
	void* q = malloc(n ? n : 8);
	if (!q) return 2;
	memset(q, 0xA5, n);   // (device memory is not zeroed: a pattern exposes reads of it)
	*p = (cu::CUdeviceptr)(uintptr_t)q; return 0;
}
static R __stdcall e_cuMemFree_v2(cu::CUdeviceptr p) { free((void*)(uintptr_t)p); return 0; }
static R __stdcall e_cuMemcpyHtoD_v2(cu::CUdeviceptr d, const void* s, size_t n) { memcpy((void*)(uintptr_t)d, s, n); return 0; }
static R __stdcall e_cuMemcpyDtoH_v2(void* d, cu::CUdeviceptr s, size_t n) { memcpy(d, (const void*)(uintptr_t)s, n); return 0; }
static R __stdcall e_cuMemsetD8_v2(cu::CUdeviceptr d, unsigned char v, size_t n) { memset((void*)(uintptr_t)d, v, n); return 0; }
static R __stdcall e_cuLaunchKernel(cu::CUfunction f, unsigned gx, unsigned gy, unsigned gz, unsigned bx, unsigned by, unsigned bz, unsigned, void*, void** args, void**) {
	EmuKernel* k = (EmuKernel*)f;
	if (gy != 1 || gz != 1 || by != 1 || bz != 1 || !gx || !bx) return 1;
	blockDim.x = bx; blockDim.y = blockDim.z = 1;
	for (unsigned b = 0; b < gx; b++) {
		blockIdx.x = b; blockIdx.y = blockIdx.z = 0;
		for (unsigned t = 0; t < bx; t++) { threadIdx.x = t; threadIdx.y = threadIdx.z = 0; k->run(args); emuThreads++; }
	}
	return 0;
}
static R __stdcall e_cuCtxSynchronize() { return 0; }
static R __stdcall e_cuGetErrorString(R, const char** s) { *s = "emulation error"; return 0; }
static R __stdcall e_cuCtxSetLimit(int, size_t) { return 0; }
static R __stdcall e_cuCtxGetLimit(size_t* v, int) { *v = 8192; return 0; }
static R __stdcall e_cuFuncGetAttribute(int* v, int, cu::CUfunction) { *v = 0; return 0; }

static FARPROC emuGetProcAddress(HMODULE, const char* name) {
#define E(n) if (!strcmp(name, #n)) return (FARPROC)(void*)&e_##n;
	E(cuInit) E(cuDriverGetVersion) E(cuDeviceGetCount) E(cuDeviceGet) E(cuDeviceGetName) E(cuDeviceGetAttribute)
	E(cuDeviceTotalMem_v2) E(cuCtxCreate_v2) E(cuCtxDestroy_v2) E(cuModuleLoadDataEx) E(cuModuleGetFunction)
	E(cuMemAlloc_v2) E(cuMemFree_v2) E(cuMemcpyHtoD_v2) E(cuMemcpyDtoH_v2) E(cuMemsetD8_v2) E(cuLaunchKernel)
	E(cuCtxSynchronize) E(cuGetErrorString) E(cuCtxSetLimit) E(cuCtxGetLimit) E(cuFuncGetAttribute)
#undef E
	return nullptr;
}

// ---- the over-full layer's cut (explorehost.h claimThreshold + the claim kernels) on adversarial priorities
#ifdef SELTEST
#include <algorithm>
static void launchAll(u32 n, const std::function<void()>& f) { blockDim.x = 256; for (u32 i = 0; i < n; i++) { blockIdx.x = i / 256; threadIdx.x = i % 256; f(); } }
static int selTest() {
	int fails = 0;
	u64 r = 12345;
	auto rnd = [&]() { r = splitmix(r); return r; };
	for (int dist = 0; dist < 5; dist++) for (u32 cap : { 1024u, 5000u, 77777u }) {
		const u32 N = 200000;
		std::vector<u64> prio(N), best(N), keys(N, 1);
		std::vector<u32> slot(N), out(N), hist(4096);
		for (u32 i = 0; i < N; i++) {
			const u64 x = rnd() & 0x7fffffffffffffffull;
			prio[i] = dist == 0 ? x                                              // random
				: dist == 1 ? ((0x5a5ull << 51) | (0xa5aull << 39) | (x & ((1ull << 39) - 1)))   // one bin, one sub-bin (the old empty layer)
				: dist == 2 ? ((0x123456789abcull << 3) | (x & 7))              // 8 values: ties
				: dist == 3 ? ((x % 3) << 51) | ((x >> 20) % 5000)              // few bins, dense low bits with ties
				: ((u64)(i % 4096) << 51) | (u64)i;                            // one per bin, spread
			slot[i] = i; best[i] = prio[i];
		}
		ExploreClaim Q; memset(&Q, 0, sizeof Q);
		u32 nWin = 0, nOut = 0;
		Q.candKey = keys.data(); Q.candPrio = prio.data(); Q.candSlot = slot.data(); Q.cellBest = best.data(); Q.nCand = N;
		Q.out = out.data(); Q.nOut = &nOut; Q.outCap = cap; Q.nWin = &nWin; Q.hist = hist.data();
		Q.selShift = 0xffffffffu; Q.thr = ~0ull; Q.thrIdx = 0;
		launchAll(N, [&]() { exploreClaimCount(Q); });
		int passes = 0;
		u64 thr = ~0ull; u32 thrIdx = 0;
		claimCut(hist, cap, [&](bool idx, u64 hi, int shift, int bits) {
			Q.selIdx = idx; Q.thr = thr; Q.selHi = hi; Q.selShift = (u32)shift; Q.selBits = (u32)bits;
			std::fill(hist.begin(), hist.end(), 0u);
			launchAll(N, [&]() { exploreClaimCount(Q); });
		}, thr, thrIdx, passes);
		Q.selShift = 0xffffffffu; Q.selIdx = 0; Q.thr = thr; Q.thrIdx = thrIdx;
		launchAll(N, [&]() { exploreClaimTake(Q); });
		// expected: the cap lowest (priority, candidate index) pairs, exactly
		std::vector<std::pair<u64, u32>> s(N);
		for (u32 i = 0; i < N; i++) s[i] = { prio[i], i };
		std::sort(s.begin(), s.end());
		std::vector<char> want(N, 0), got(N, 0);
		for (u32 j = 0; j < cap; j++) want[s[j].second] = 1;
		for (u32 j = 0; j < nOut && j < cap; j++) got[(out[j] >> 5) * 18 + (out[j] & 31)] = 1;
		const bool ok = nWin == N && nOut == cap && want == got;
		printf("dist %d cap %u: winners %u, kept %u, cut %016llx / index %u, %d passes: %s\n", dist, cap, nWin, nOut, (unsigned long long)thr, thrIdx, passes, ok ? "ok" : "FAIL");
		if (!ok) fails++;
	}
	printf(fails ? "FAIL\n" : "all cuts exact\n");
	return fails ? 1 : 0;
}
#endif

int main(int argc, char** argv) {
#ifdef SELTEST
	if (argc > 1 && !strcmp(argv[1], "seltest")) return selTest();
#endif
	regAll();
	const int rc = eegpu_main(argc, argv);
	fflush(stdout);
	fprintf(stderr, "[emu] %llu emulated GPU threads\n", (unsigned long long)emuThreads);
	return rc;
}
