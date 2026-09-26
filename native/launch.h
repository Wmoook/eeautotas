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
// Items that cost differently: an explore / beam expand parent simulates 1 to 18 children (the twins are skipped), and
// the parents stay grouped by region, so after a launch of cheap parents one of dear ones took up to 6x the time it was
// sized for. Those launches are sized for the worst case (tookWorst: the time scaled from the children really simulated
// to 18 per parent); the search's likewise in candidate-ticks (every live candidate playing the whole segment). In the
// CPU emulation (src/out/emu) the longest launch at --launch-ms=50 went from 61-121 ms to 23-50 ms.
// The smallest launch: one block for explore and beam (128 parents or children, 256 claims) and bench (one tick of its
// threads); the search's is one tick of one batch's candidates (one start tick x the family's variants: 1620 threads
// for m2), the GPU trace's one tick of its one thread.
// The chunks split kernels over index ranges only; the phases stay in order (every chunk of a phase before the next
// phase), so a chunked run computes exactly what the unchunked one did (src/out/emu: --launch-ms=5 vs 500).
// A graceful stop: killing eegpu while a kernel runs makes the driver reset the GPU too (nvlddmkm 153). With
// --stopfile=<path>, the file's existence (checked before a launch, at most every 20 ms) ends the command cleanly
// between two launches: its final line (end "stopped", with what it found so far), exit code 0. The callers write the
// file and kill only when the process has not exited a few seconds later. --parent=<pid>: the same stop once that
// process has exited. Node kills the children it did not start detached as soon as it exits (its job object: a killed
// src/gpusearch.js took its eegpu down with it, mid-kernel), so the callers start eegpu detached with --parent: when
// they die, however, eegpu ends at its next launch instead.
// The wait (--wait=block, the default): the host thread spins for the first --spin-ms (1) of a launch (the short ones
// end there, at once), then sleeps on the launch's end event until the GPU signals it (a blocking-sync event) instead
// of spinning a CPU core for the whole launch (at above-normal priority that core was taken from the CPU workers, and
// heated the laptop); --wait=spin: cuCtxSynchronize spins throughout. The done events' "hostCpuMs" (the process's CPU
// time) and "gapMs" (the GPU clock's time from one command's end to the next one's start, summed) show the cost of each.
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
	cu::CUevent e0 = nullptr;
	int events = -1;        // the event timing: -1 not tried yet, 0 unavailable (host clock only), 1 on
	std::string stopFile;   // --stopfile
	HANDLE parent = nullptr;   // --parent: that process (a stop once it has exited)
	double maxItems = 0;       // --launch-items=N (tests): at most N items per launch whatever the speed (0: no cap), so
	                           // a small workload is split too and must give what one launch gives (test/gpulaunch.js)
	double lastStopCheck = -1e9;
	bool stopping = false;
	int wait = 1;              // --wait: 1 block (spin spinMs, then sleep on the end event), 0 spin
	double spinMs = 1.0;       // --spin-ms
	cu::CUevent eEnd[2] = { nullptr, nullptr };   // the end events, in turn (the gap from one command's end to the next's start)
	int endIdx = 0;
	bool havePrev = false;
	double gapMs = 0;          // the GPU clock's time between one timed command's end and the next one's start, summed
	uint64_t gaps = 0;
};
inline Guard G;
/** the command's final line for a stop request (end "stopped"); none set: a bare done event */
inline std::function<void()> onStop;
inline bool eventsOn() {
	if (G.events < 0) {
		G.events = 0;
		// (the end events are blocking-sync ones, flag 1: a wait for them can sleep; timing still works)
		if (cu::cuEventCreate && cu::cuEventRecord && cu::cuEventElapsedTime && !cu::cuEventCreate(&G.e0, 0) && !cu::cuEventCreate(&G.eEnd[0], 1) &&
			!cu::cuEventCreate(&G.eEnd[1], 1)) G.events = 1;
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

/** the process's CPU time so far (all threads, user + kernel), ms */
inline double hostCpuMs() {
	FILETIME c, e, k, u;
	if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
	const auto ft = [](const FILETIME& f) { return (double)(((uint64_t)f.dwHighDateTime << 32) | f.dwLowDateTime) / 1e4; };
	return ft(k) + ft(u);
}
/** the done events' fields: ,"maxLaunchMs":..,"maxKernelMs":..,"launchTarget":..,"kernelLaunches":..,"hostCpuMs":.. */
inline std::string doneFields() {
	char b[600];
	snprintf(b, sizeof b, ",\"maxLaunchMs\":%.1f,\"maxLaunchKernel\":\"%s\",\"maxKernelMs\":%.1f,\"maxKernelKernel\":\"%s\",\"gpuClock\":%s,\"launchTarget\":%.0f,\"kernelLaunches\":%llu,"
		"\"launchTotalMs\":%.0f,\"kernelTotalMs\":%.0f,\"gapMs\":%.0f,\"wait\":\"%s\",\"hostCpuMs\":%.0f",
		G.maxMs, G.maxWhat.c_str(), G.maxKernelMs, G.maxKernelWhat.c_str(), G.events == 1 ? "true" : "false", G.targetMs, (unsigned long long)G.launches,
		G.totalMs, G.totalKernelMs, G.gapMs, G.wait && G.events == 1 && cu::cuEventQuery && cu::cuEventSynchronize ? "block" : "spin", hostCpuMs());
	return b;
}

/** --parent=<pid>: watch that process (a handle from now on, so a reused pid cannot stand in for it; none when it cannot
 *  be opened) */
inline void watchParent(const std::string& pid) {
	const unsigned long p = strtoul(pid.c_str(), nullptr, 10);
	if (p) G.parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)p);
}
/** --stopfile / --parent: has a stop been requested? (the file exists, or the parent has exited; looked at most every
 *  20 ms unless `now`) */
inline bool stopRequested(bool now = false) {
	if (G.stopFile.empty() && !G.parent) return false;
	const double t = nowMs();
	if (!now && t - G.lastStopCheck < 20) return false;
	G.lastStopCheck = t;
	if (G.parent && WaitForSingleObject(G.parent, 0) == WAIT_OBJECT_0) return true;
	return !G.stopFile.empty() && GetFileAttributesA(G.stopFile.c_str()) != INVALID_FILE_ATTRIBUTES;
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
/** waits for the GPU command that ends with `end` (issued at t0): --wait=block spins for spinMs, then sleeps on the
 *  (blocking-sync) event; --wait=spin, or no events: cuCtxSynchronize (a spin). Then the context's status (a kernel's
 *  error shows there). */
inline cu::CUresult waitDone(cu::CUevent end, std::chrono::steady_clock::time_point t0) {
	if (!end || !G.wait || !cu::cuEventQuery || !cu::cuEventSynchronize) return cu::cuCtxSynchronize();
	for (;;) {
		const cu::CUresult q = cu::cuEventQuery(end);
		if (q == 0) return cu::cuCtxSynchronize();
		if (q != 600) return q;   // (600: CUDA_ERROR_NOT_READY; anything else is the kernel's error)
		if (sinceMs(t0) >= G.spinMs) break;
		YieldProcessor();
	}
	const cu::CUresult r = cu::cuEventSynchronize(end);
	return r ? r : cu::cuCtxSynchronize();
}
/** one GPU command (a kernel launch, a memset), waited for and timed: returns its time by the GPU's clock (the host's
 *  without events); the host clock's goes into maxMs. Exits on any error. */
template <class F>
inline double timed(const char* what, F issue) {
	checkStop();
	const bool ev = eventsOn();
	cu::CUevent end = ev ? G.eEnd[G.endIdx] : nullptr;
	const auto t0 = std::chrono::steady_clock::now();
	cu::CUresult r = ev ? cu::cuEventRecord(G.e0, nullptr) : 0;
	if (!r) r = issue();
	if (!r && ev) r = cu::cuEventRecord(end, nullptr);
	if (!r) r = waitDone(end, t0);
	const double ms = sinceMs(t0);
	double kms = ms;
	if (!r && ev) {
		float f = 0;
		if (!cu::cuEventElapsedTime(&f, G.e0, end) && f >= 0) kms = std::min(ms, (double)f);
		// the gap since the last command's end (host work between them, the wake-up, other processes' GPU work)
		if (G.havePrev && !cu::cuEventElapsedTime(&f, G.eEnd[G.endIdx ^ 1], G.e0) && f >= 0) { G.gapMs += f; G.gaps++; }
		G.havePrev = true; G.endIdx ^= 1;
	}
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
		if (G.maxItems > 0) s = std::min(s, G.maxItems);   // (--launch-items: the aligned kernels still take `align`)
		if (align > 1) s = std::max(align, std::floor(s / align) * align);
		return std::max<uint64_t>(1, std::min<uint64_t>(left, (uint64_t)s));
	}
	/** a launch of `items` items whose cost per item varies took `ms`: `units` = the work it really did (e.g. children
	 *  simulated), `worst` = the most it could have done (e.g. 18 per parent). Its time scaled up to the worst case sizes
	 *  the next launch, so a launch of the dearest items takes no longer than the target at this speed. */
	void tookWorst(double items, double ms, double units, double worst) { took(items, ms * std::max(1.0, worst / std::max(1.0, units))); }
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
 *  arguments (args points at them), then ceil((hi - lo) / block) blocks of `block` threads (one thread per item);
 *  after(ck, items, ms) tells ck what a launch took (e.g. tookWorst with the launch's work). */
template <class F, class A>
inline void over(Chunk& ck, uint64_t n, unsigned block, cu::CUfunction f, void** args, const char* what, F set, A after) {
	for (uint64_t a = 0; a < n;) {
		const uint64_t b = a + ck.next(n - a);
		set((uint32_t)a, (uint32_t)b);
		const double ms = launch(f, (unsigned)((b - a + block - 1) / block), block, args, what);
		after(ck, (double)(b - a), ms);
		a = b;
	}
}
template <class F>
inline void over(Chunk& ck, uint64_t n, unsigned block, cu::CUfunction f, void** args, const char* what, F set) {
	over(ck, n, block, f, args, what, set, [](Chunk& c, double items, double ms) { c.took(items, ms); });
}

}  // namespace lk
