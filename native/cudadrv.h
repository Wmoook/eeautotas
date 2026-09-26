// cudadrv.h - the CUDA driver API (nvcuda.dll, installed with every NVIDIA driver) and NVRTC (build time only),
// loaded at run time: the exe needs no CUDA toolkit, and runs (CPU only) on PCs without an NVIDIA GPU.
#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

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
typedef void* CUevent; typedef void* CUstream;
// (optional: the launch timing of launch.h; without them the host clock alone)
CU_FN(CUresult, cuEventCreate, (CUevent*, unsigned))
CU_FN(CUresult, cuEventRecord, (CUevent, CUstream))
CU_FN(CUresult, cuEventElapsedTime, (float*, CUevent, CUevent))

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
	cuEventCreate = (t_cuEventCreate)GetProcAddress(m, "cuEventCreate");   // (optional)
	cuEventRecord = (t_cuEventRecord)GetProcAddress(m, "cuEventRecord");
	cuEventElapsedTime = (t_cuEventElapsedTime)GetProcAddress(m, "cuEventElapsedTime");
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

/** Loads PTX text; the driver compiles it for this GPU (cached by the driver). */
inline bool loadModule(CUmodule* mod, const std::string& ptx) {
	static char errlog[16384];
	errlog[0] = 0;
	int opts[] = { JIT_ERROR_LOG_BUFFER, JIT_ERROR_LOG_BUFFER_SIZE_BYTES };
	void* vals[] = { errlog, (void*)(size_t)sizeof errlog };
	CUresult r = cuModuleLoadDataEx(mod, ptx.c_str(), 2, opts, vals);
	if (r) { fail("cuModuleLoadDataEx", r); lastError += std::string(": ") + errlog; return false; }
	return true;
}

/** A device buffer. */
struct Buf {
	CUdeviceptr p = 0; size_t bytes = 0;
	bool alloc(size_t n) { free(); bytes = n ? n : 8; CU_TRY(cuMemAlloc_v2(&p, bytes)); return true; }
	bool upload(const void* src, size_t n) { if (!alloc(n)) return false; if (n) CU_TRY(cuMemcpyHtoD_v2(p, src, n)); return true; }
	void free() { if (p) cuMemFree_v2(p); p = 0; }
};

}  // namespace cu
