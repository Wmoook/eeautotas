// launch.h - bounded kernel launches. Every kernel launch of every eegpu command goes through launch(): it waits for the
// kernel and times it (by the GPU's clock: events around the kernel, so a wait for another process's GPU work does not
// count as this kernel's cost; and by the host clock from launch to its end), and on any launch error it prints ONE JSON line
// {"error":...,"cuda":N,"launchError":true,"timeout":true|false,...} and exits (7 for CUDA_ERROR_LAUNCH_TIMEOUT, 6 for any
// other error): after a launch timeout the context is gone, and the callers back off (src/gpusearch.js, src/editor.js)
// instead of retrying at once.
// Why: Windows resets the display driver when one GPU command runs past its watchdog (TDR, 2 s), and a laptop GPU
// that throttles to 1/6 of its clock turns a 300 ms launch into a 2 s one. So a command never launches a whole
// workload at once: a Chunk sizes the launches of one kernel from the measured time per item toward --launch-ms
// (default 50): it starts small, grows at most 1.5x per launch toward 70% of the target, and shrinks at once (down to
// 1/10 in one step) after a launch that took longer than the target. A launch sized for 35 ms takes about 210 ms if
// the clock drops 6x before it; the next one is sized for the new speed.
// The chunks split kernels over index ranges only; the phases stay in order (every chunk of a phase before the next
// phase), so a chunked run computes exactly what the unchunked one did (src/out/emu: --launch-ms=5 vs 500).
// A graceful stop: killing eegpu while a kernel runs makes the driver reset the GPU too (nvlddmkm 153). With
// --stopfile=<path>, the file's existence (checked before a launch, at most every 20 ms) ends the command cleanly
// between two launches: its final line (end "stopped", with what it found so far), exit code 0. The callers write the
// file and kill only when the process has not exited a few seconds later.
#pragma once
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <functional>
#include <string>
#include "cudadrv.h"

namespace lk {

struct Guard {
	double targetMs = 50;   // --launch-ms
	double maxMs = 0;       // the longest launch (or big memset) so far, host clock from launch to its end: "maxLaunchMs"
	double maxKernelMs = 0; // the longest by the GPU's own clock (events around the kernel): "maxKernelMs"; a launch
	                        // that waits for another process's GPU work counts that wait in maxMs, not here
	double totalMs = 0;     // time in launches (host clock)
	double totalKernelMs = 0;   // ... by the GPU's clock (how busy a command keeps the GPU: explore --lanes)
	uint64_t launches = 0;
	std::string maxWhat, maxKernelWhat;   // which kernel took maxMs / maxKernelMs
	cu::CUevent e0 = nullptr, e1 = nullptr;
	int events = -1;        // the event timing: -1 not tried yet, 0 unavailable (host clock only), 1 on
	std::string stopFile;   // --stopfile
	double lastStopCheck = -1e9;
	bool stopping = false;
};
inline Guard G;
/** the command's final line for a stop request (end "stopped"); none set: a bare done event */
inline std::function<void()> onStop;
inline bool eventsOn() {
	if (G.events < 0) {
		G.events = 0;
		if (cu::cuEventCreate && cu::cuEventRecord && cu::cuEventElapsedTime && !cu::cuEventCreate(&G.e0, 0) && !cu::cuEventCreate(&G.e1, 0)) G.events = 1;
	}
	return G.events == 1;
}

/** --launch-ms: the target time of one launch (ms; 1 to 1000) */
inline void setTarget(double ms) { G.targetMs = std::max(1.0, std::min(1000.0, std::isfinite(ms) && ms > 0 ? ms : 50.0)); }

/** a launch failed: one JSON line and exit (no retry: the caller decides when the GPU gets work again) */
[[noreturn]] inline void die(const char* what, cu::CUresult r, double ms) {
	const char* s = "?";
	if (cu::cuGetErrorString) cu::cuGetErrorString(r, &s);
	const bool timeout = r == 702;   // CUDA_ERROR_LAUNCH_TIMEOUT: the driver's watchdog stopped the kernel
	char b[600];
	if (timeout) snprintf(b, sizeof b, "the GPU driver stopped the %s kernel after %.0f ms (CUDA error 702, launch timeout: the display driver's watchdog). Launches were sized for %.0f ms; the GPU is much slower than measured (overheating?)", what, ms, G.targetMs);
	else snprintf(b, sizeof b, "the %s kernel failed after %.0f ms: CUDA error %d (%s)", what, ms, (int)r, s);
	std::string o = "\"";
	for (const char* c = b; *c; c++) { if (*c == '"' || *c == '\\') o += '\\'; o += *c; }
	o += "\"";
	printf("{\"error\":%s,\"cuda\":%d,\"launchError\":true,\"timeout\":%s,\"kernel\":\"%s\",\"launchMs\":%.1f,\"maxLaunchMs\":%.1f,\"launchTarget\":%.0f,\"launches\":%llu}\n",
		o.c_str(), (int)r, timeout ? "true" : "false", what, ms, G.maxMs, G.targetMs, (unsigned long long)G.launches);
	fflush(stdout);
	exit(timeout ? 7 : 6);
}

inline double sinceMs(std::chrono::steady_clock::time_point t0) { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count(); }
inline double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

/** the done events' fields: ,"maxLaunchMs":..,"maxKernelMs":..,"launchTarget":..,"kernelLaunches":.. */
inline std::string doneFields() {
	char b[300];
	snprintf(b, sizeof b, ",\"maxLaunchMs\":%.1f,\"maxLaunchKernel\":\"%s\",\"maxKernelMs\":%.1f,\"maxKernelKernel\":\"%s\",\"gpuClock\":%s,\"launchTarget\":%.0f,\"kernelLaunches\":%llu",
		G.maxMs, G.maxWhat.c_str(), G.maxKernelMs, G.maxKernelWhat.c_str(), G.events == 1 ? "true" : "false", G.targetMs, (unsigned long long)G.launches);
	return b;
}

/** --stopfile: has a stop been requested? (the file exists; looked at most every 20 ms unless `now`) */
inline bool stopRequested(bool now = false) {
	if (G.stopFile.empty()) return false;
	const double t = nowMs();
	if (!now && t - G.lastStopCheck < 20) return false;
	G.lastStopCheck = t;
	return GetFileAttributesA(G.stopFile.c_str()) != INVALID_FILE_ATTRIBUTES;
}
/** between launches (no kernel running): a stop request ends the command here, cleanly: its final line, exit 0 */
inline void checkStop(bool now = false) {
	if (G.stopping || !stopRequested(now)) return;
	G.stopping = true;
	if (onStop) onStop();
	else printf("{\"ev\":\"done\",\"end\":\"stopped\"%s}\n", doneFields().c_str());
	fflush(stdout);
	exit(0);
}

inline void count(double ms, double kms, const char* what) {
	G.launches++; G.totalMs += ms; G.totalKernelMs += kms;
	if (ms > G.maxMs) { G.maxMs = ms; G.maxWhat = what; }
	if (kms > G.maxKernelMs) { G.maxKernelMs = kms; G.maxKernelWhat = what; }
}
/** one GPU command (a kernel launch, a memset), waited for and timed: returns its time by the GPU's clock (the host's
 *  without events); the host clock's goes into maxMs. Exits on any error. */
template <class F>
inline double timed(const char* what, F issue) {
	checkStop();
	const bool ev = eventsOn();
	const auto t0 = std::chrono::steady_clock::now();
	cu::CUresult r = ev ? cu::cuEventRecord(G.e0, nullptr) : 0;
	if (!r) r = issue();
	if (!r && ev) r = cu::cuEventRecord(G.e1, nullptr);
	if (!r) r = cu::cuCtxSynchronize();
	const double ms = sinceMs(t0);
	double kms = ms;
	if (!r && ev) { float f = 0; if (!cu::cuEventElapsedTime(&f, G.e0, G.e1) && f >= 0) kms = std::min(ms, (double)f); }
	count(ms, kms, what);
	if (r) die(what, r, ms);
	return kms;
}

/** One launch of f (grid x block threads, 1-D), waited for and timed: its milliseconds by the GPU's clock (what sizes
 *  the next launch: a wait for another process's GPU work is not this kernel's cost). Exits on any error. */
inline double launch(cu::CUfunction f, unsigned grid, unsigned block, void** args, const char* what) {
	return timed(what, [&]() { return cu::cuLaunchKernel(f, grid, 1, 1, block, 1, 1, 0, nullptr, args, nullptr); });
}

/** cuMemsetD8 of a big buffer in pieces of at most 32 MB, each waited for (a GPU command like a kernel: 128 MB took
 *  150 ms on a throttled laptop GPU shared with another process) */
inline void memset8(cu::CUdeviceptr p, unsigned char v, size_t bytes, const char* what) {
	const size_t piece = (size_t)32 << 20;
	for (size_t o = 0; o < bytes; o += piece) timed(what, [&]() { return cu::cuMemsetD8_v2(p + o, v, std::min(piece, bytes - o)); });
}

/** How many items (threads, start ticks, ticks) one launch of a kernel takes: sized toward the target from the time
 *  per item that the last launches measured; it grows at most 1.5x per launch and shrinks at once after a launch that
 *  ran over the target (at most to 1/10 in one step). `align`: sizes are rounded down to a multiple (full blocks). */
struct Chunk {
	double size, lo, hi, align, scale;   // scale: the target is scale x --launch-ms (e.g. a batch of several launches)
	Chunk(double start, double lo_, double hi_, double align_ = 1, double scale_ = 1) : size(start), lo(lo_), hi(hi_), align(align_), scale(scale_) {}
	/** the next launch's items, with `left` items left to do */
	uint64_t next(uint64_t left) const {
		double s = std::max(lo, std::min(hi, size));
		if (align > 1) s = std::max(align, std::floor(s / align) * align);
		return std::max<uint64_t>(1, std::min<uint64_t>(left, (uint64_t)s));
	}
	/** a launch of `items` items took `ms` */
	void took(double items, double ms) {
		if (items <= 0) return;
		const double t = G.targetMs * scale;
		ms = std::max(ms, 0.02);
		// the items this launch's speed does in 70% of the target: the margin for the next launch's clock (the laptop's
		// swings between 210 and 780 MHz from one launch to the next: 3.7x)
		const double want = items * 0.7 * t / ms;
		if (ms > t) size = std::max(size * 0.1, std::min(size, want));   // over the target: shrink at once
		else if (items >= 0.5 * size) size = std::min(size * 1.5, want);       // a full launch: toward the target, at most 1.5x
		else if (want < size) size = std::max(size * 0.1, want);                 // a short launch (a range's tail) that was slow
		size = std::max(lo, std::min(hi, size));
	}
};

/** Runs a kernel over the items [0, n) in launches sized by ck: set(lo, hi) puts the range into the kernel's
 *  arguments (args points at them), then ceil((hi - lo) / block) blocks of `block` threads (one thread per item). */
template <class F>
inline void over(Chunk& ck, uint64_t n, unsigned block, cu::CUfunction f, void** args, const char* what, F set) {
	for (uint64_t a = 0; a < n;) {
		const uint64_t b = a + ck.next(n - a);
		set((uint32_t)a, (uint32_t)b);
		const double ms = launch(f, (unsigned)((b - a + block - 1) / block), block, args, what);
		ck.took((double)(b - a), ms);
		a = b;
	}
}

}  // namespace lk
