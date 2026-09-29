// cudadrv.h - the CUDA driver API (nvcuda.dll, installed with every NVIDIA driver) and NVRTC (build time only),
// loaded at run time: the exe needs no CUDA toolkit, and runs (CPU only) on PCs without an NVIDIA GPU.
// Linux (tools/build-native.js --target=linux: a rented cloud GPU): the driver's libcuda.so.1 through dlopen, NVRTC as
// libnvrtc.so.12 (only `eegpu ptx` loads it), the kernel cache's lock a flock on a file in the cache folder.
#pragma once
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define CU_DRIVER_LIB "nvcuda.dll"
#define CU_SYM(m, n) GetProcAddress(m, n)
#else
#include <dlfcn.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdlib>
#include <ctime>
#include <sys/file.h>
#include <sys/stat.h>
#define CU_DRIVER_LIB "libcuda.so.1"
#define CU_SYM(m, n) dlsym(m, n)
#endif
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>
#include <atomic>
#include <chrono>

namespace cu {

typedef int CUresult; typedef int CUdevice; typedef void* CUcontext; typedef void* CUmodule; typedef void* CUfunction;
typedef unsigned long long CUdeviceptr;
enum { ATTR_SM_COUNT = 16, ATTR_CLOCK_KHZ = 13, ATTR_CC_MAJOR = 75, ATTR_CC_MINOR = 76, ATTR_MAX_THREADS_PER_SM = 39,
	JIT_INFO_LOG_BUFFER = 3, JIT_INFO_LOG_BUFFER_SIZE_BYTES = 4, JIT_ERROR_LOG_BUFFER = 5, JIT_ERROR_LOG_BUFFER_SIZE_BYTES = 6 };

#ifdef _WIN32
#define CU_FN(ret, name, args) typedef ret (__stdcall *t_##name) args; inline t_##name name = nullptr;
#else
#define CU_FN(ret, name, args) typedef ret (*t_##name) args; inline t_##name name = nullptr;
#endif
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
typedef void* CUevent; typedef void* CUstream;
// (optional: the launch timing of launch.h; without them the host clock alone)
CU_FN(CUresult, cuEventCreate, (CUevent*, unsigned))
CU_FN(CUresult, cuEventRecord, (CUevent, CUstream))
CU_FN(CUresult, cuEventElapsedTime, (float*, CUevent, CUevent))
CU_FN(CUresult, cuEventQuery, (CUevent))         // (optional: launch.h's waits; without them a spin in cuCtxSynchronize)
CU_FN(CUresult, cuEventSynchronize, (CUevent))
CU_FN(CUresult, cuMemGetInfo_v2, (size_t*, size_t*))   // (optional: explore --lanes sizes its cell table by the free memory)
CU_FN(CUresult, cuMemAllocHost_v2, (void**, size_t))   // (optional: page-locked host buffers, e.g. eegpu roll's copies; else malloc)
CU_FN(CUresult, cuMemFreeHost, (void*))

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
inline CUresult lastCode = 0;   // (the last failure's code: 2 = CUDA_ERROR_OUT_OF_MEMORY)
/** driver work in flight that an exit must not cut (a kernel launch and its wait, launch.h timed(); a module load, which
 *  may write the kernel cache): launch.h's parent watchdog ends an orphaned process only while this is 0 */
inline std::atomic<int> busy{ 0 };
struct Busy { Busy() { busy++; } ~Busy() { busy--; } };
/** what one more eegpu process's context takes on this GPU (set by Device::open): the stack every resident thread may
 *  use (stackBytes x SMs x threads per SM: 1.8 GB on an A100) + ~256 MB for the context itself; an idle burst server held
 *  1.9 GB on the A100 before any buffer. freeShare's headroom keeps two of them free. */
inline size_t ctxBytes = 0;

inline bool fail(const char* what, CUresult r) {
	lastCode = r;
	const char* s = "?";
	if (cuGetErrorString) cuGetErrorString(r, &s);
	char b[512]; snprintf(b, sizeof b, "%s failed: CUDA error %d (%s)", what, r, s);
	lastError = b;
	return false;
}
#define CU_TRY(x) do { cu::CUresult r_ = (x); if (r_) return cu::fail(#x, r_); } while (0)

/** Loads nvcuda.dll (Linux: libcuda.so.1). false (lastError says why) when there is no NVIDIA driver. */
inline bool loadDriver() {
#ifdef _WIN32
	HMODULE m = LoadLibraryA("nvcuda.dll");
	if (!m) { lastError = "no NVIDIA driver (nvcuda.dll not found): GPU mode needs an NVIDIA graphics card"; return false; }
#else
	void* m = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
	if (!m) { const char* e = dlerror(); lastError = std::string("no NVIDIA driver (libcuda.so.1 not found): GPU mode needs an NVIDIA graphics card") + (e ? std::string(" [") + e + "]" : ""); return false; }
#endif
#define L(n) n = (t_##n)CU_SYM(m, #n); if (!n) { lastError = CU_DRIVER_LIB " lacks " #n " (driver too old?)"; return false; }
	L(cuInit) L(cuDriverGetVersion) L(cuDeviceGetCount) L(cuDeviceGet) L(cuDeviceGetName) L(cuDeviceGetAttribute)
	L(cuDeviceTotalMem_v2) L(cuCtxCreate_v2) L(cuCtxDestroy_v2) L(cuModuleLoadDataEx) L(cuModuleGetFunction)
	L(cuMemAlloc_v2) L(cuMemFree_v2) L(cuMemcpyHtoD_v2) L(cuMemcpyDtoH_v2) L(cuMemsetD8_v2) L(cuLaunchKernel)
	L(cuCtxSynchronize) L(cuGetErrorString) L(cuCtxSetLimit) L(cuCtxGetLimit) L(cuFuncGetAttribute)
#undef L
	cuEventCreate = (t_cuEventCreate)CU_SYM(m, "cuEventCreate");   // (optional)
	cuEventRecord = (t_cuEventRecord)CU_SYM(m, "cuEventRecord");
	cuEventElapsedTime = (t_cuEventElapsedTime)CU_SYM(m, "cuEventElapsedTime");
	cuEventQuery = (t_cuEventQuery)CU_SYM(m, "cuEventQuery");
	cuEventSynchronize = (t_cuEventSynchronize)CU_SYM(m, "cuEventSynchronize");
	cuMemGetInfo_v2 = (t_cuMemGetInfo_v2)CU_SYM(m, "cuMemGetInfo_v2");
	cuMemAllocHost_v2 = (t_cuMemAllocHost_v2)CU_SYM(m, "cuMemAllocHost_v2");
	cuMemFreeHost = (t_cuMemFreeHost)CU_SYM(m, "cuMemFreeHost");
	return true;
}

/** Loads NVRTC from `dir` (`eegpu ptx` only; Linux: libnvrtc.so.12 there, else from the library path). */
inline bool loadNvrtc(const std::string& dir) {
#ifdef _WIN32
	SetDllDirectoryA(dir.c_str());
	HMODULE m = LoadLibraryA((dir + "\\nvrtc64_120_0.dll").c_str());
	if (!m) { lastError = "nvrtc64_120_0.dll not found in " + dir; return false; }
#else
	void* m = dlopen((dir + "/libnvrtc.so.12").c_str(), RTLD_NOW | RTLD_LOCAL);
	if (!m) m = dlopen("libnvrtc.so.12", RTLD_NOW | RTLD_LOCAL);
	if (!m) { lastError = "libnvrtc.so.12 not found in " + dir; return false; }
#endif
#define L(n) n = (t_##n)CU_SYM(m, #n); if (!n) { lastError = "nvrtc lacks " #n; return false; }
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
	size_t mem = 0;        // the memory this process sizes by: the GPU's, or EEAT_GPU_BUDGET_MB when less
	size_t totalMem = 0;   // the GPU's
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
		totalMem = mem;
		// EEAT_GPU_BUDGET_MB: this run's share of the GPU (e.g. two searches on one GPU: half each); every consumer that
		// sizes by the GPU's memory (explore's table and states, the random runs' pool, the search's records, `info`'s
		// memMB, which the editor sizes the wall breaker and the bursts by) sees the budget instead of the whole GPU
		{
			const char* b = getenv("EEAT_GPU_BUDGET_MB");
			const double mb = b && *b ? atof(b) : 0;
			if (mb >= 256) mem = std::min(mem, (size_t)(mb * 1048576.0));
		}
		CU_TRY(cuCtxCreate_v2(&ctx, 0, dev));
		CU_TRY(cuCtxSetLimit(0 /* CU_LIMIT_STACK_SIZE */, stackBytes));
		ctxBytes = stackBytes * (size_t)std::max(1, sms) * (size_t)std::max(1, maxThreadsPerSM) + ((size_t)256 << 20);
		return true;
	}
};

/** The GPU memory one consumer may take now: `frac` of the free memory less a headroom (the largest of 1.5 GB, 1/20 of
 *  the GPU's and two contexts, ctxBytes: the A/B's first var runs still failed bursts at cuCtxSetLimit "out of memory",
 *  the stack reservation of a new process's context), so every consumer leaves room for the next ones (their contexts,
 *  their tables): consumers that start one
 *  after another split the free memory geometrically and the GPU never runs dry. Sweep2: 34 of 52 runs at two searches
 *  a GPU failed bursts with cuCtxCreate "out of memory" because one consumer (the random runs' pool, every move's states,
 *  the breaker's table) had sized itself by the whole GPU and taken nearly all that was free. SIZE_MAX: unknown (no
 *  cuMemGetInfo). */
inline size_t freeShare(size_t total, double frac) {
	size_t fr = 0, tot = 0;
	if (!cuMemGetInfo_v2 || cuMemGetInfo_v2(&fr, &tot)) return SIZE_MAX;
	const size_t head = std::max<size_t>({ (size_t)1536 << 20, (total ? total : tot) / 20, 2 * ctxBytes });
	return fr > head ? (size_t)((double)(fr - head) * frac) : 0;
}
/** the free memory now (bytes; 0: unknown) */
inline size_t freeNow() { size_t fr = 0, tot = 0; return cuMemGetInfo_v2 && !cuMemGetInfo_v2(&fr, &tot) ? fr : 0; }

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
#ifdef _WIN32
	WIN32_FIND_DATAA fd;
	HANDLE h = FindFirstFileA((dir + "\\*").c_str(), &fd);
	if (h == INVALID_HANDLE_VALUE) return 0;
	do {
		if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
		if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { if (depth < 4) n += folderBytes(dir + "\\" + fd.cFileName, depth + 1); }
		else n += ((uint64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
	} while (FindNextFileA(h, &fd));
	FindClose(h);
#else
	DIR* d = opendir(dir.c_str());
	if (!d) return 0;
	while (const dirent* e = readdir(d)) {
		if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
		const std::string p = dir + "/" + e->d_name;
		struct stat st;
		if (lstat(p.c_str(), &st)) continue;
		if (S_ISDIR(st.st_mode)) { if (depth < 4) n += folderBytes(p, depth + 1); }
		else n += (uint64_t)st.st_size;
	}
	closedir(d);
#endif
	return n;
}
/** the driver's JIT cache goes to `dir` (before loadDriver: the driver reads these when it loads) */
inline void useJitCache(const std::string& dir) {
#ifdef _WIN32
	CreateDirectoryA(dir.c_str(), nullptr);
	SetEnvironmentVariableA("CUDA_CACHE_PATH", dir.c_str());
	char v[64];
	if (!GetEnvironmentVariableA("CUDA_CACHE_MAXSIZE", v, sizeof v)) SetEnvironmentVariableA("CUDA_CACHE_MAXSIZE", "134217728");
#else
	// (the folder and its parents: a fresh machine's data folder may not exist yet)
	for (size_t k = dir.find('/', 1); ; k = dir.find('/', k + 1)) {
		mkdir(dir.substr(0, k).c_str(), 0777);
		if (k == std::string::npos) break;
	}
	setenv("CUDA_CACHE_PATH", dir.c_str(), 1);
	const char* v = getenv("CUDA_CACHE_MAXSIZE");
	if (!v || !*v) setenv("CUDA_CACHE_MAXSIZE", "134217728", 1);
#endif
}
/** loadModule, one compile at a time per module and GPU (dir: the cache folder, useJitCache'd; empty: the plain load) */
inline bool loadModuleCached(CUmodule* mod, const std::string& ptx, const std::string& dir, int ccMajor, int ccMinor, ModuleLoad& info) {
	info = ModuleLoad();
	if (dir.empty()) return loadModule(mod, ptx);
	char key[64];
	snprintf(key, sizeof key, "%016llx_sm%d%d", (unsigned long long)fnv64(ptx), ccMajor, ccMinor);
#ifdef _WIN32
	HANDLE mx = CreateMutexA(nullptr, FALSE, (std::string("Local\\eegpu-jit-") + key).c_str());
	typedef std::chrono::steady_clock Clk;
	const auto w0 = Clk::now();
	// (after 20 minutes it loads anyway; the mutex of an owner that died is abandoned: then it is ours)
	const DWORD w = mx ? WaitForSingleObject(mx, 20 * 60 * 1000) : WAIT_FAILED;
#else
	// (Linux: an exclusive flock on <dir>/eegpu-jit-<key>.lock, looked at every 50 ms; after 20 minutes it loads anyway;
	// the lock of an owner that died goes with it: then it is ours)
	const int lk = open((dir + "/eegpu-jit-" + key + ".lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0666);
	typedef std::chrono::steady_clock Clk;
	const auto w0 = Clk::now();
	bool locked = false;
	while (lk >= 0 && !locked) {
		if (!flock(lk, LOCK_EX | LOCK_NB)) locked = true;
		else if ((errno != EWOULDBLOCK && errno != EINTR) || Clk::now() - w0 > std::chrono::minutes(20)) break;
		else { const timespec d = { 0, 50 * 1000000L }; nanosleep(&d, nullptr); }
	}
#endif
	info.waitMs = std::chrono::duration<double, std::milli>(Clk::now() - w0).count();
	const uint64_t before = folderBytes(dir);
	const auto l0 = Clk::now();
	bool ok;
	{ Busy b; ok = loadModule(mod, ptx); }   // (a compile writes the kernel cache: no watchdog exit meanwhile)
	// (a hit takes well under a second; a compile adds megabytes, unless the driver dropped as much to make room)
	const double ms = std::chrono::duration<double, std::milli>(Clk::now() - l0).count();
	info.how = folderBytes(dir) > before + 65536 || ms > 5000 ? "compiled" : "cache";
#ifdef _WIN32
	if (w == WAIT_OBJECT_0 || w == WAIT_ABANDONED) ReleaseMutex(mx);
	if (mx) CloseHandle(mx);
#else
	if (locked) flock(lk, LOCK_UN);
	if (lk >= 0) close(lk);
#endif
	return ok;
}

/** the device buffers allocated and not freed since tracking began (eegpu explore --serve: a job's buffers are its
 *  commands' locals, which a process of its own never frees; the server frees them all after each job); null: off */
inline std::vector<CUdeviceptr>* gTrack = nullptr;
/** A device buffer. */
struct Buf {
	CUdeviceptr p = 0; size_t bytes = 0;
	bool alloc(size_t n) { free(); bytes = n ? n : 8; CU_TRY(cuMemAlloc_v2(&p, bytes)); if (gTrack) gTrack->push_back(p); return true; }
	bool upload(const void* src, size_t n) { if (!alloc(n)) return false; if (n) CU_TRY(cuMemcpyHtoD_v2(p, src, n)); return true; }
	void free() {
		if (p) {
			cuMemFree_v2(p);
			if (gTrack) { auto it = std::find(gTrack->begin(), gTrack->end(), p); if (it != gTrack->end()) gTrack->erase(it); }
		}
		p = 0;
	}
};
/** frees every buffer tracked (gTrack) and empties the list */
inline void freeTracked() {
	if (!gTrack) return;
	for (CUdeviceptr q : *gTrack) cuMemFree_v2(q);
	gTrack->clear();
}
/** a host buffer for copies to and from the GPU: page-locked where the driver gives it (faster copies), else malloc */
struct HostBuf {
	uint8_t* p = nullptr; size_t bytes = 0; bool locked = false;
	bool alloc(size_t n) {
		free();
		bytes = n ? n : 8;
		void* q = nullptr;
		if (cuMemAllocHost_v2 && cuMemFreeHost && cuMemAllocHost_v2(&q, bytes) == 0 && q) { p = (uint8_t*)q; locked = true; return true; }
		p = (uint8_t*)malloc(bytes);
		return p != nullptr;
	}
	void free() { if (p) { if (locked) cuMemFreeHost(p); else ::free(p); } p = nullptr; locked = false; }
	~HostBuf() { free(); }
};

}  // namespace cu
