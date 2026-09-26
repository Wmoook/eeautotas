// cudadrv.h - the CUDA driver API (nvcuda.dll, installed with every NVIDIA driver) and NVRTC (build time only),
// loaded at run time: the exe needs no CUDA toolkit, and runs (CPU only) on PCs without an NVIDIA GPU.
#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>
#include <chrono>

namespace cu {

typedef int CUresult; typedef int CUdevice; typedef void* CUcontext; typedef void* CUmodule; typedef void* CUfunction;
typedef unsigned long long CUdeviceptr;
enum { ATTR_SM_COUNT = 16, ATTR_CLOCK_KHZ = 13, ATTR_CC_MAJOR = 75, ATTR_CC_MINOR = 76, ATTR_MAX_THREADS_PER_SM = 39,
	JIT_INFO_LOG_BUFFER = 3, JIT_INFO_LOG_BUFFER_SIZE_BYTES = 4, JIT_ERROR_LOG_BUFFER = 5, JIT_ERROR_LOG_BUFFER_SIZE_BYTES = 6 };

#define CU_FN(ret, name, args) typedef ret (__stdcall *t_##name) args; inline t_##name name = nullptr;
CU_FN(CUresult, cuInit, (unsigned))
CU_FN(CUresult, cuDriverGetVersion, (int*))
CU_FN(CUresult, cuDeviceGetCount, (int*))
CU_FN(CUresult, cuDeviceGet, (CUdevice*, int))
CU_FN(CUresult, cuDeviceGetName, (char*, int, CUdevice))
CU_FN(CUresult, cuDeviceGetAttribute, (int*, int, CUdevice))
CU_FN(CUresult, cuDeviceTotalMem_v2, (size_t*, CUdevice))
CU_FN(CUresult, cuCtxCreate_v2, (CUcontext*, unsigned, CUdevice))
CU_FN(CUresult, cuCtxDestroy_v2, (CUcontext))
CU_FN(CUresult, cuModuleLoadDataEx, (CUmodule*, const void*, unsigned, int*, void**))
CU_FN(CUresult, cuModuleGetFunction, (CUfunction*, CUmodule, const char*))
CU_FN(CUresult, cuMemAlloc_v2, (CUdeviceptr*, size_t))
CU_FN(CUresult, cuMemFree_v2, (CUdeviceptr))
CU_FN(CUresult, cuMemcpyHtoD_v2, (CUdeviceptr, const void*, size_t))
CU_FN(CUresult, cuMemcpyDtoH_v2, (void*, CUdeviceptr, size_t))
CU_FN(CUresult, cuMemsetD8_v2, (CUdeviceptr, unsigned char, size_t))
CU_FN(CUresult, cuLaunchKernel, (CUfunction, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, void*, void**, void**))
CU_FN(CUresult, cuCtxSynchronize, (void))
CU_FN(CUresult, cuGetErrorString, (CUresult, const char**))
CU_FN(CUresult, cuCtxSetLimit, (int, size_t))
CU_FN(CUresult, cuCtxGetLimit, (size_t*, int))
CU_FN(CUresult, cuFuncGetAttribute, (int*, int, CUfunction))

typedef int nvrtcResult; typedef void* nvrtcProgram;
CU_FN(nvrtcResult, nvrtcVersion, (int*, int*))
CU_FN(nvrtcResult, nvrtcCreateProgram, (nvrtcProgram*, const char*, const char*, int, const char* const*, const char* const*))
CU_FN(nvrtcResult, nvrtcCompileProgram, (nvrtcProgram, int, const char* const*))
CU_FN(nvrtcResult, nvrtcGetProgramLogSize, (nvrtcProgram, size_t*))
CU_FN(nvrtcResult, nvrtcGetProgramLog, (nvrtcProgram, char*))
CU_FN(nvrtcResult, nvrtcGetPTXSize, (nvrtcProgram, size_t*))
CU_FN(nvrtcResult, nvrtcGetPTX, (nvrtcProgram, char*))
CU_FN(nvrtcResult, nvrtcDestroyProgram, (nvrtcProgram*))
#undef CU_FN

inline std::string lastError;

inline bool fail(const char* what, CUresult r) {
	const char* s = "?";
	if (cuGetErrorString) cuGetErrorString(r, &s);
	char b[512]; snprintf(b, sizeof b, "%s failed: CUDA error %d (%s)", what, r, s);
	lastError = b;
	return false;
}
#define CU_TRY(x) do { cu::CUresult r_ = (x); if (r_) return cu::fail(#x, r_); } while (0)

/** Loads nvcuda.dll. false (lastError says why) when there is no NVIDIA driver. */
inline bool loadDriver() {
	HMODULE m = LoadLibraryA("nvcuda.dll");
	if (!m) { lastError = "no NVIDIA driver (nvcuda.dll not found): GPU mode needs an NVIDIA graphics card"; return false; }
#define L(n) n = (t_##n)GetProcAddress(m, #n); if (!n) { lastError = "nvcuda.dll lacks " #n " (driver too old?)"; return false; }
	L(cuInit) L(cuDriverGetVersion) L(cuDeviceGetCount) L(cuDeviceGet) L(cuDeviceGetName) L(cuDeviceGetAttribute)
	L(cuDeviceTotalMem_v2) L(cuCtxCreate_v2) L(cuCtxDestroy_v2) L(cuModuleLoadDataEx) L(cuModuleGetFunction)
	L(cuMemAlloc_v2) L(cuMemFree_v2) L(cuMemcpyHtoD_v2) L(cuMemcpyDtoH_v2) L(cuMemsetD8_v2) L(cuLaunchKernel)
	L(cuCtxSynchronize) L(cuGetErrorString) L(cuCtxSetLimit) L(cuCtxGetLimit) L(cuFuncGetAttribute)
#undef L
	return true;
}

inline bool loadNvrtc(const std::string& dir) {
	SetDllDirectoryA(dir.c_str());
	HMODULE m = LoadLibraryA((dir + "\\nvrtc64_120_0.dll").c_str());
	if (!m) { lastError = "nvrtc64_120_0.dll not found in " + dir; return false; }
#define L(n) n = (t_##n)GetProcAddress(m, #n); if (!n) { lastError = "nvrtc lacks " #n; return false; }
	L(nvrtcVersion) L(nvrtcCreateProgram) L(nvrtcCompileProgram) L(nvrtcGetProgramLogSize) L(nvrtcGetProgramLog)
	L(nvrtcGetPTXSize) L(nvrtcGetPTX) L(nvrtcDestroyProgram)
#undef L
	return true;
}

struct Device {
	CUdevice dev = 0;
	CUcontext ctx = nullptr;
	char name[256] = {0};
	int sms = 0, clockMHz = 0, ccMajor = 0, ccMinor = 0, driver = 0, maxThreadsPerSM = 0;
	size_t mem = 0;
	size_t stackBytes = 8192;   // per thread: the sim state (~0.7 KB) and the call frames of the engine
	bool open() {
		if (!loadDriver()) return false;
		CU_TRY(cuInit(0));
		int count = 0;
		CU_TRY(cuDeviceGetCount(&count));
		if (count < 1) { lastError = "no CUDA device"; return false; }
		CU_TRY(cuDeviceGet(&dev, 0));
		CU_TRY(cuDeviceGetName(name, sizeof name, dev));
		int clk = 0;
		cuDeviceGetAttribute(&sms, ATTR_SM_COUNT, dev);
		cuDeviceGetAttribute(&clk, ATTR_CLOCK_KHZ, dev);
		cuDeviceGetAttribute(&ccMajor, ATTR_CC_MAJOR, dev);
		cuDeviceGetAttribute(&ccMinor, ATTR_CC_MINOR, dev);
		cuDeviceGetAttribute(&maxThreadsPerSM, ATTR_MAX_THREADS_PER_SM, dev);
		clockMHz = clk / 1000;
		cuDriverGetVersion(&driver);
		cuDeviceTotalMem_v2(&mem, dev);
		CU_TRY(cuCtxCreate_v2(&ctx, 0, dev));
		CU_TRY(cuCtxSetLimit(0 /* CU_LIMIT_STACK_SIZE */, stackBytes));
		return true;
	}
};

/** Loads a module image: PTX text (the driver compiles it for this GPU, cached by the driver) or a cubin. */
inline bool loadImage(CUmodule* mod, const void* image) {
	static char errlog[16384];
	errlog[0] = 0;
	int opts[] = { JIT_ERROR_LOG_BUFFER, JIT_ERROR_LOG_BUFFER_SIZE_BYTES };
	void* vals[] = { errlog, (void*)(size_t)sizeof errlog };
	CUresult r = cuModuleLoadDataEx(mod, image, 2, opts, vals);
	if (r) { fail("cuModuleLoadDataEx", r); lastError += std::string(": ") + errlog; return false; }
	return true;
}
inline bool loadModule(CUmodule* mod, const std::string& ptx) { return loadImage(mod, ptx.c_str()); }

// ------------------------------------------------------------------ the kernel cache (--cachedir)
// The driver compiles the PTX for the GPU on the CPU at the first load (70-190 s for a 7.8 MB module on a busy laptop
// CPU) and keeps the machine code in its JIT cache (%APPDATA%\NVIDIA\ComputeCache: 1 GiB shared by every CUDA program,
// the least recently used entries dropped). Processes that load the same module at once (the Find a route strategies)
// each compile it: 3 at once were ready after 159 s, against 69 s for one. With a cache folder:
// - the driver's JIT cache moves there (CUDA_CACHE_PATH, set before nvcuda.dll loads; CUDA_CACHE_MAXSIZE 128 MiB unless
//   set: about 9 modules of 13 MB, the driver drops the least recently used beyond it), so other programs and old builds
//   do not push the current one out, and old builds do not pile up;
// - the load holds the named mutex Local\eegpu-jit-<FNV-64 of the PTX>_sm<cc>: the first process compiles, the others
//   wait for it and then find the machine code in the cache (a fraction of a second).
// The machine code stays the driver's own compile of the PTX. (Its JIT linker, cuLink, gives a cubin the app could keep,
// but it compiles relocatable code with another register allocation: search_8 194 registers instead of 168, and Find a
// route's expand kernels ran 20-25% slower, measured launch by launch in one process.)

/** how loadModuleCached got the kernels (the ready event's "module"): "cache" (the driver's cache had them),
 *  "compiled" (the driver compiled them here), "ptx" (no cache folder: the driver's default cache) */
struct ModuleLoad { std::string how = "ptx"; double waitMs = 0; };

inline uint64_t fnv64(const std::string& s) {
	uint64_t h = 0xcbf29ce484222325ull;
	for (unsigned char c : s) { h ^= c; h *= 0x100000001b3ull; }
	return h;
}
/** the bytes in a folder and its subfolders (the driver's cache: an index and a few levels of folders) */
inline uint64_t folderBytes(const std::string& dir, int depth = 0) {
	uint64_t n = 0;
	WIN32_FIND_DATAA fd;
	HANDLE h = FindFirstFileA((dir + "\\*").c_str(), &fd);
	if (h == INVALID_HANDLE_VALUE) return 0;
	do {
		if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
		if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { if (depth < 4) n += folderBytes(dir + "\\" + fd.cFileName, depth + 1); }
		else n += ((uint64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
	} while (FindNextFileA(h, &fd));
	FindClose(h);
	return n;
}
/** the driver's JIT cache goes to `dir` (before loadDriver: the driver reads these when it loads) */
inline void useJitCache(const std::string& dir) {
	CreateDirectoryA(dir.c_str(), nullptr);
	SetEnvironmentVariableA("CUDA_CACHE_PATH", dir.c_str());
	char v[64];
	if (!GetEnvironmentVariableA("CUDA_CACHE_MAXSIZE", v, sizeof v)) SetEnvironmentVariableA("CUDA_CACHE_MAXSIZE", "134217728");
}
/** loadModule, one compile at a time per module and GPU (dir: the cache folder, useJitCache'd; empty: the plain load) */
inline bool loadModuleCached(CUmodule* mod, const std::string& ptx, const std::string& dir, int ccMajor, int ccMinor, ModuleLoad& info) {
	info = ModuleLoad();
	if (dir.empty()) return loadModule(mod, ptx);
	char key[64];
	snprintf(key, sizeof key, "%016llx_sm%d%d", (unsigned long long)fnv64(ptx), ccMajor, ccMinor);
	HANDLE mx = CreateMutexA(nullptr, FALSE, (std::string("Local\\eegpu-jit-") + key).c_str());
	typedef std::chrono::steady_clock Clk;
	const auto w0 = Clk::now();
	// (after 20 minutes it loads anyway; the mutex of an owner that died is abandoned: then it is ours)
	const DWORD w = mx ? WaitForSingleObject(mx, 20 * 60 * 1000) : WAIT_FAILED;
	info.waitMs = std::chrono::duration<double, std::milli>(Clk::now() - w0).count();
	const uint64_t before = folderBytes(dir);
	const auto l0 = Clk::now();
	const bool ok = loadModule(mod, ptx);
	// (a hit takes well under a second; a compile adds megabytes, unless the driver dropped as much to make room)
	const double ms = std::chrono::duration<double, std::milli>(Clk::now() - l0).count();
	info.how = folderBytes(dir) > before + 65536 || ms > 5000 ? "compiled" : "cache";
	if (w == WAIT_OBJECT_0 || w == WAIT_ABANDONED) ReleaseMutex(mx);
	if (mx) CloseHandle(mx);
	return ok;
}

/** A device buffer. */
struct Buf {
	CUdeviceptr p = 0; size_t bytes = 0;
	bool alloc(size_t n) { free(); bytes = n ? n : 8; CU_TRY(cuMemAlloc_v2(&p, bytes)); return true; }
	bool upload(const void* src, size_t n) { if (!alloc(n)) return false; if (n) CU_TRY(cuMemcpyHtoD_v2(p, src, n)); return true; }
	void free() { if (p) cuMemFree_v2(p); p = 0; }
};

}  // namespace cu
