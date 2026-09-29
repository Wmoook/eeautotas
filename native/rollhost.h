// rollhost.h - `eegpu roll`: the random runs of Find a route's "random runs (GPU)" (src/goexplore.js --gpu=1), a
// persistent GPU server for the Go-Explore of goexplore.js with coarse cells (explore.h RollParams). Included by
// eegpu.cpp.
//   eegpu roll <level.bin> [--reach=<RCH3>] [--prune=1] [--rolls=8] [--roll=40] [--keep=0.85] [--phase=50]
//              [--cap=<cells>] [--mem=<MB>] [--hostmem=<MB>] [--maxPicks=65536] [--rollMax=<the longest batch Lr>]
// It keeps the cell table on the GPU and one state per cell (the pool, by dense id; the start is cell 0) in host memory,
// and reads jobs from stdin (binary mode):
//   "batch K maxT seed [Lr keep]\n" + K x u32 (the picked cells' dense ids): every pick plays --rolls runs of up to
//       --roll ticks (goexplore.js's inputs: explore.h rollSeed / rollDraw); a state at tick >= maxT is not added and a
//       run ends past maxT. Lr and keep (optional; goexplore.js --rollMix, the start event's "mix":1 says the tool reads
//       them): this batch's run length (1 .. --roll, which sizes the buffers) and keep probability instead of --roll /
//       --keep. Reply: {"ev":"batch","n":N,"fin":F,"cells":C,"full":0|1,"touched":..,"ticks":..,"runs":..,"cut":..,
//       "dead":..,"ms":..,"kernelMs":..,"bytes":B}\n + N records of 6 i32 (dense id or -1 (the pool is full: not
//       kept), tick, reach fifths (-1: cut off), room (goexplore.js roomOf key), pick index, run | step << 16: the
//       cell's state is the pick's state after steps 0..step of that run) + F finishes of 4 u32 (pick index, run,
//       step, tick: the trophy taken at that step). A record is a new cell or one reached sooner than before.
//   "seen\n": {"ev":"seen","n":C,"bytes":4C}\n + C x u32: how often runs came through each cell (head B).
//   "stop\n", or the end of stdin: the done line, exit 0.
// Before the first job: the ready event, then {"ev":"start","stateBytes":..,"cap":..,"slots":..,"fifths":..,"room":..,
// "memMB":..,"hostMB":..}. The pool holds --cap cells, else as many as both the GPU's share and the host's hold: on the
// GPU a cell costs its tick, slot and seen count and its table slots (~70 bytes: --mem MB, else a quarter of the GPU's
// memory, an eighth on a GPU of 12 GB or less, at most the free memory less 1 GB), in host memory its state (--hostmem
// MB, default 1024; goexplore.js passes an eighth of the machine's memory, at most half of the free memory): a state is
// 0.5-2 KB, so a pool on the GPU held ~10x fewer cells (the 8 GB laptop GPU's 1 GB 1.4 M of Stupid Fox's, which the
// search fills in a minute; now with 32 GB of RAM: 4 GB of states, 6.5 M cells, 574 MB of the GPU instead of ~1.07 GB,
// next to every move's ~4.9 GB, the beams and the relay; a whole Find a route's peak on an 8 GB GPU is not measured).
// Per batch the picks' states go up and the records' states come down (page-locked buffers
// where the driver gives them). Once full, only known cells improve (goexplore.js's archive likewise). memMB = every GPU
// buffer. Launches are sized toward --launch-ms like every command (launch.h); --stopfile / --pausefile / --parent act
// between two launches.
#pragma once
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#else
#include <sys/mman.h>
#endif

template <int TW>
static int runRoll(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const int R = std::max(1, std::min(4095, atoi(opt(argc, argv, "rolls", "8").c_str())));
	const int Lr = std::max(1, std::min(255, atoi(opt(argc, argv, "roll", "40").c_str())));
	// (--rollMax: the longest run a batch may ask for, "batch K maxT seed Lr keep": the buffers are sized for it; an older
	// tool ignores it and plays --roll / --keep in every batch, which goexplore.js then does too: its start event has no
	// "mix")
	const int LrMax = std::max(Lr, std::min(255, atoi(opt(argc, argv, "rollMax", "0").c_str())));
	const double keep = atof(opt(argc, argv, "keep", "0.85").c_str());
	const uint32_t maxPicks = (uint32_t)std::max(1, std::min(1 << 20, atoi(opt(argc, argv, "maxPicks", "65536").c_str())));
	auto tStart = std::chrono::steady_clock::now();
	Level L = B.level(B.bytes.data());
	S* start = (S*)calloc(1, sizeof(S));
	{ Sim<TW> sim(L, *start); sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed); }
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	if (!layoutOrError(g, TW)) return 4;
	const std::string tw = std::to_string(TW);
	cu::CUfunction fRoll = g.fn("roll_" + tw), fCollect = g.fn("rollCollect_" + tw), fSeen = g.fn("rollSeen");
	if (!fRoll || !fCollect || !fSeen) { printf("{\"error\":%s}\n", jsonStr("roll kernels missing: " + cu::lastError).c_str()); return 4; }
	RollParams P;
	memset(&P, 0, sizeof P);
	P.L = L;   // (host pointers for now: the start cell's key below; the device copy's before the first launch)
	P.R = R; P.Lr = Lr; P.keep = keep;
	P.prune = opt(argc, argv, "prune", "1") == "1" ? 1 : 0;
	// --deaths=1: deaths are moves: a run goes on through a death that pays (kernels.cu rollBody), at most one a run
	P.deaths = opt(argc, argv, "deaths", "0") == "1" ? 1 : 0;
	for (int i = 0; i < L.N; i++) {
		const int id = L.fg[i];
		if (id == 1027 || id == 1028) P.roomTeam = 1;
		else if (id == 43 || id == 165) P.roomCoins = 1;
		else if (id == 213 || id == 214) P.roomBlue = 1;
		else if (id == 1094 || id == 1095) P.roomCrown = 1;
		else if (id == 1152 || id == 1153) P.roomSilver = 1;
	}
	P.phase = L.hasTimeDoors ? std::max(1, atoi(opt(argc, argv, "phase", "50").c_str())) : 0;
	ReachGpu reachGpu;
	{
		const std::string rf = opt(argc, argv, "reach", "");
		std::string err;
		if (!rf.empty() && !reachGpu.load(rf, L, P.reach, err)) { printf("{\"error\":%s}\n", jsonStr(err).c_str()); return 3; }
	}
	const size_t SB = sizeof(S);
	// the GPU's share (--mem MB, else a quarter of the GPU's memory, an eighth up to 12 GB, at most the free memory less
	// 1 GB) and the host's (--hostmem MB)
	size_t memB = 0;
	{
		// (the GPU's memory: EEAT_GPU_BUDGET_MB when less; with EEAT_GPU_FIT=1 (opt-in, cudadrv.h fitOn) the free memory's
		// share: half of it less the headroom, cudadrv.h freeShare, so the consumers that start after the pool keep room)
		const size_t total = g.d.mem ? g.d.mem : (size_t)4 << 30;
		size_t fr = total, tot = 0;
		if (cu::cuMemGetInfo_v2) cu::cuMemGetInfo_v2(&fr, &tot);
		const double mb = atof(opt(argc, argv, "mem", "0").c_str());
		const size_t share = total <= ((size_t)12 << 30) ? total / 8 : total / 4;
		const size_t freeCap = cu::fitOn() ? std::max(cu::freeShare(g.d.totalMem, 0.5), (size_t)256 << 20)
			: fr > ((size_t)1 << 30) + ((size_t)256 << 20) ? fr - ((size_t)1 << 30) : (size_t)256 << 20;
		memB = mb > 0 ? (size_t)(mb * 1048576.0) : std::min(share, freeCap);
	}
	const size_t hostB = (size_t)(std::max(16.0, atof(opt(argc, argv, "hostmem", "1024").c_str())) * 1048576.0);
	// (the records of one collect launch range come down with their states: ~64 MB)
	const uint32_t stageCap = (uint32_t)std::max<size_t>(4096, std::min<size_t>(65536, ((size_t)64 << 20) / SB));
	// (per pick: its id, its state's copy, and R x LrMax touched slots at most)
	const size_t fixedB = (size_t)maxPicks * (4 + SB + 4 * (size_t)R * LrMax) + (size_t)stageCap * (SB + 24) + B.bytes.size() + 4096;
	const size_t devB = memB > fixedB ? memB - fixedB : 0;
	// (on the GPU per cell: its tick, slot and seen count, and two table slots of 28 bytes; in host memory its state)
	const bool capGiven = opt(argc, argv, "cap", "").size() > 0;
	uint64_t cap = std::min<uint64_t>(devB / (12 + 2 * 28), hostB / SB);
	if (capGiven) cap = (uint64_t)std::max(1024, atoi(opt(argc, argv, "cap", "0").c_str()));
	cap = std::max<uint64_t>(4096, std::min<uint64_t>(cap, (uint64_t)1 << 30));
	uint64_t slots = 1024;
	while (slots < 2 * cap) slots <<= 1;
	// (the table's slots are a power of two: fewer cells where the rounding would pass the GPU's share)
	while (!capGiven && slots > 8192 && 28 * slots + 12 * cap > devB) { slots >>= 1; cap = std::min<uint64_t>(cap, slots / 2); }
	// (the records of one collect launch range: at most one per touched slot; the touched slots of a batch are collected in
	// ranges of at most recCap)
	const uint32_t touchedCap = (uint32_t)std::min<uint64_t>((uint64_t)maxPicks * R * LrMax, slots);
	const uint32_t recCap = (uint32_t)std::min<uint64_t>(std::min<uint64_t>(touchedCap, cap), stageCap);
	const uint32_t finCap = 4096;
	cu::Buf dl, dstage, dcellT, dkeys, dbest, ddone, dseen, ddense, dslot, dseenOut, dtouched, dpicks, dpickS, dfin, dout, dctr;
	for (;;) {
		const bool ok = dl.upload(B.bytes.data(), B.bytes.size()) && dstage.alloc(SB * (size_t)recCap) && dcellT.alloc(4 * cap) && dkeys.alloc(8 * slots) && dbest.alloc(8 * slots) &&
			ddone.alloc(4 * slots) && dseen.alloc(4 * slots) && ddense.alloc(4 * slots) && dslot.alloc(4 * cap) && dseenOut.alloc(4 * cap) && dtouched.alloc(4ull * touchedCap) &&
			dpicks.alloc(4ull * maxPicks) && dpickS.alloc(SB * maxPicks) && dfin.alloc(16ull * finCap) && dout.alloc(24ull * recCap) && dctr.alloc(80);
		if (ok) break;
		// (out of GPU memory, e.g. another strategy took it after the check: half the table, down to 64 K cells)
		if (cu::lastCode != 2 || cap <= 65536) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
		for (cu::Buf* b : { &dl, &dstage, &dcellT, &dkeys, &dbest, &ddone, &dseen, &ddense, &dslot, &dseenOut, &dtouched, &dpicks, &dpickS, &dfin, &dout, &dctr }) b->free();
		cap /= 2;
		slots /= 2;
		printf("{\"warn\":\"out of GPU memory: the pool holds %llu cells\"}\n", (unsigned long long)cap);
	}
	size_t devUsed = 0;
	for (cu::Buf* b : { &dl, &dstage, &dcellT, &dkeys, &dbest, &ddone, &dseen, &ddense, &dslot, &dseenOut, &dtouched, &dpicks, &dpickS, &dfin, &dout, &dctr }) devUsed += b->bytes;
	// the pool in host memory (not page-locked: its pages are touched as cells come; Linux: an anonymous map with huge
	// pages where the kernel gives them, fewer page faults as it fills), and the copies' buffers
	struct Pool {
		uint8_t* p = nullptr; size_t bytes = 0;
		bool alloc(size_t n) {
			bytes = n;
#ifdef _WIN32
			p = (uint8_t*)malloc(n);
#else
			void* q = mmap(nullptr, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
			p = q == MAP_FAILED ? nullptr : (uint8_t*)q;
#ifdef MADV_HUGEPAGE
			if (p) (void)madvise(p, n, MADV_HUGEPAGE);
#endif
#endif
			return p != nullptr;
		}
		~Pool() {
#ifdef _WIN32
			free(p);
#else
			if (p) munmap(p, bytes);
#endif
		}
	} poolMem;
	for (;;) {
		if (poolMem.alloc(SB * (size_t)cap) || cap <= 65536) break;
		cap /= 2;
		printf("{\"warn\":\"out of host memory: the pool holds %llu cells\"}\n", (unsigned long long)cap);
	}
	uint8_t* const pool = poolMem.p;
	if (!pool) { printf("{\"error\":\"out of host memory for the pool\"}\n"); return 4; }
	cu::HostBuf pickH, stageH;
	if (!pickH.alloc(SB * maxPicks) || !stageH.alloc(SB * (size_t)recCap)) { printf("{\"error\":\"out of host memory for the copies\"}\n"); return 4; }
	const uint32_t recCapNow = (uint32_t)std::min<uint64_t>(recCap, cap);
	lk::memset8(dkeys.p, 0, 8 * slots, "memset");
	lk::memset8(dbest.p, 0xff, 8 * slots, "memset");
	lk::memset8(ddone.p, 0xff, 4 * slots, "memset");
	lk::memset8(dseen.p, 0, 4 * slots, "memset");
	lk::memset8(ddense.p, 0xff, 4 * slots, "memset");
	cu::cuMemsetD8_v2(dctr.p, 0, 80);
	// the start: cell 0
	const uint32_t room0 = rollRoom<TW>(P, *start);
	const uint64_t key0 = rollCellKey<TW>(P, *start, room0);
	const uint32_t slot0 = (uint32_t)(splitmix(key0) & (slots - 1));
	{
		const uint32_t zero = 0, one = 1;
		const int32_t d0 = 0;
		cu::cuMemcpyHtoD_v2(dkeys.p + 8ull * slot0, &key0, 8);
		cu::cuMemcpyHtoD_v2(ddone.p + 4ull * slot0, &zero, 4);
		cu::cuMemcpyHtoD_v2(ddense.p + 4ull * slot0, &d0, 4);
		memcpy(pool, start, SB);
		cu::cuMemcpyHtoD_v2(dcellT.p, &zero, 4);
		cu::cuMemcpyHtoD_v2(dctr.p + 12, &one, 4);
		cu::cuMemcpyHtoD_v2(dslot.p, &slot0, 4);
	}
	const int32_t fifths0 = reachGpu.H.on ? reachFifths(reachGpu.H, start->px, start->py, start->speed_y, start->q0, start->q1, start->slippery) : -1;
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.stage = (u8*)(uintptr_t)dstage.p; P.stateBytes = (i32)SB; P.cellT = (i32*)(uintptr_t)dcellT.p;
	P.picks = (const u32*)(uintptr_t)dpicks.p; P.pickStates = (u8*)(uintptr_t)dpickS.p;
	P.keys = (u64*)(uintptr_t)dkeys.p; P.mask = (u32)(slots - 1); P.best = (u64*)(uintptr_t)dbest.p; P.doneT = (u32*)(uintptr_t)ddone.p;
	P.seen = (u32*)(uintptr_t)dseen.p; P.dense = (i32*)(uintptr_t)ddense.p;
	P.touched = (u32*)(uintptr_t)dtouched.p; P.touchedCap = touchedCap;
	P.fin = (u32*)(uintptr_t)dfin.p; P.finCap = finCap;
	P.ctr = (u32*)(uintptr_t)dctr.p; P.stats = (unsigned long long*)(uintptr_t)(dctr.p + 32);
	P.out = (i32*)(uintptr_t)dout.p;
	P.denseCap = (u32)cap;
	P.denseSlot = (u32*)(uintptr_t)dslot.p; P.seenOut = (u32*)(uintptr_t)dseenOut.p;
#ifdef _WIN32
	fflush(stdout);   // (the lines so far in text mode; from here on the frames' bytes as they are)
	_setmode(_fileno(stdin), _O_BINARY);
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	g.ready(tStart);
	printf("{\"ev\":\"start\",\"stateBytes\":%d,\"cap\":%llu,\"slots\":%llu,\"fifths\":%d,\"room\":%d,\"memMB\":%.0f,\"hostMB\":%.0f,\"locked\":%d,\"rolls\":%d,\"roll\":%d,\"rollMax\":%d,\"mix\":1,\"phase\":%d,\"gpu\":%s}\n",
		(int)SB, (unsigned long long)cap, (unsigned long long)slots, fifths0, (int32_t)room0, (double)devUsed / 1048576.0, (double)(SB * cap + pickH.bytes + stageH.bytes) / 1048576.0,
		pickH.locked && stageH.locked ? 1 : 0, R, Lr, LrMax, P.phase, g.json().c_str());
	fflush(stdout);
	uint64_t batches = 0;
	unsigned long long st[5] = { 0, 0, 0, 0, 0 };
	// (EEAT_ROLLSIZE: the launch floor's sizing, below; the done line's rollSize / rollFloorMs: on or off, the largest
	// class floor measured)
	const bool sizeOn = [] { const char* v = getenv("EEAT_ROLLSIZE"); return !(v && v[0] == '0'); }();
	double floorMax = 0;
	auto finale = [&](const char* why) {
		printf("{\"ev\":\"done\",\"end\":\"%s\",\"batches\":%llu,\"ticks\":%llu,\"runs\":%llu,\"seconds\":%.1f,\"rollSize\":%d,\"rollFloorMs\":%.1f%s}\n", why, (unsigned long long)batches,
			st[0], st[1], std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(), sizeOn ? 1 : 0, floorMax, lk::doneFields().c_str());
		fflush(stdout);
	};
	lk::onStop = [&]() { finale("stopped"); };
	lk::Chunk ckCol(4096, 128, 1u << 30, 128), ckSeen(1 << 16, 256, 1u << 31, 256);
	// (the roll launches' sizes, one per run length: a batch of the roll mix may play runs of another length than the
	// batch before; a new length's first size is the last one's scaled by the lengths, so 240-tick runs after 40-tick
	// ones do not start with a launch 6x the target)
	// THE LAUNCH FLOOR (n3-roll-launch-sizing, 2026-09-29; EEAT_ROLLSIZE=0: the sizing before, below): a launch takes at
	// least its longest run's ticks one after the other (a thread's ticks are sequential), however few runs it holds: on
	// the A100 ~80 ms for a run of 240 ticks (The Flighty Slighty: the mix's 240-tick batches took 5.1 s of kernels each,
	// 120-tick ones 2.1 s, 40-tick ones 47 ms; 0.7 / 1.3 / 22 M ticks per kernel second). A launch over the target
	// shrank the next one (lk::Chunk), which cannot go under the floor: the long classes' launches fell to a few hundred
	// runs, each as long as a full one. Now per class the floor F = the least time of its last 16 launches (another
	// process on the GPU only adds time), and the launches are sized by the time past it: the target for that part is
	// max(--launch-ms, 1.3 F) - F, and the part is the measured time less F (the observed runs, not Lr ticks each). The
	// worst case (every run of the launch the batch's Lr ticks, at the least time per simulated tick any launch of this
	// process measured: an upper bound of the GPU's cost per tick) stays under 2 x max(--launch-ms, 1.3 F) (TDR); until a
	// launch of 16,384 ticks or more has measured it, the sizing before.
	struct RollClass {
		int lr; lk::Chunk ck; double win[16]; int nWin, iWin;
		RollClass(int lr_, double size) : lr(lr_), ck(size, 128, 1u << 30, 128), nWin(0), iWin(0) {}
		double floorMs() const { double f = 1e30; for (int i = 0; i < nWin; i++) f = std::min(f, win[i]); return nWin ? f : 0; }
	};
	std::vector<RollClass> ckRolls;
	ckRolls.reserve(256);   // (at most 255 lengths: the references handed out stay valid)
	RollClass* rcNow = nullptr;
	auto ckRollFor = [&](int lr) -> lk::Chunk& {
		for (auto& c : ckRolls) if (c.lr == lr) { rcNow = &c; return c.ck; }
		double size = 2048;
		if (!ckRolls.empty()) size = std::max(128.0, std::min((double)(1u << 30), ckRolls.back().ck.size * ckRolls.back().lr / (double)lr));
		ckRolls.emplace_back(lr, size);
		rcNow = &ckRolls.back();
		return ckRolls.back().ck;
	};
	ckRollFor(Lr);
	unsigned long long simSeen = 0;
	double tickUB = 0;   // (ms per simulated tick: the least of any launch of 16,384 ticks or more; 0 = none yet)
	auto rollTook = [&](lk::Chunk& c, double items, double ms) {
		unsigned long long sim = simSeen;
		cu::cuMemcpyDtoH_v2(&sim, dctr.p + 32, 8);
		const double units = (double)(sim - simSeen);
		simSeen = sim;
		if (sizeOn && rcNow && &rcNow->ck == &c) {
			RollClass& rc = *rcNow;
			rc.win[rc.iWin] = ms; rc.iWin = (rc.iWin + 1) % 16; rc.nWin = std::min(16, rc.nWin + 1);
			if (units >= 16384 && ms > 0) tickUB = tickUB > 0 ? std::min(tickUB, ms / units) : ms / units;
			if (tickUB > 0) {
				const double T = lk::G.targetMs, F = rc.floorMs(), tal = std::max(T, 1.3 * F);
				floorMax = std::max(floorMax, F);
				c.scale = std::max(0.05, (tal - F) / T);
				c.took(items, std::max(0.02, ms - F));
				c.size = std::max(c.lo, std::min(c.size, (2 * tal - F) / (P.Lr * tickUB)));
				return;
			}
		}
		c.tookWorst(items, ms, units, items * P.Lr);   // (a run that ends early is cheaper: sized for the batch's Lr ticks each)
	};
	std::vector<uint32_t> picks(maxPicks);
	std::vector<int32_t> outAll, sorted, lastD;
	std::vector<uint32_t> fins, finSorted, seenHost;
	std::vector<std::pair<uint64_t, uint32_t>> ord;
	char line[256];
	const char* why = "eof";
	for (;;) {
		if (!fgets(line, sizeof line, stdin)) break;
		unsigned long long k = 0, mt = 0, seed = 0;
		if (!strncmp(line, "stop", 4)) { why = "stopped"; break; }
		uint32_t ctr[8];
		if (!strncmp(line, "seen", 4)) {
			cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
			const uint32_t nd = std::min<uint32_t>(ctr[3], (uint32_t)cap);
			seenHost.assign(nd, 0);
			if (nd) {
				void* as[] = { &P };
				lk::over(ckSeen, nd, 256, fSeen, as, "roll seen", [&](uint32_t lo, uint32_t hi) { P.lo = lo; P.hi = hi; });
				cu::cuMemcpyDtoH_v2(seenHost.data(), dseenOut.p, 4ull * nd);
			}
			printf("{\"ev\":\"seen\",\"n\":%u,\"bytes\":%u}\n", nd, 4 * nd);
			fflush(stdout);
			if (nd) fwrite(seenHost.data(), 4, nd, stdout);
			fflush(stdout);
			continue;
		}
		int lrB = Lr;
		double keepB = keep;
		const int nf0 = sscanf(line, "batch %llu %llu %llu %d %lf", &k, &mt, &seed, &lrB, &keepB);
		if ((nf0 != 3 && nf0 != 5) || k < 1 || k > maxPicks || lrB < 1 || lrB > LrMax || !(keepB >= 0 && keepB <= 1)) { printf("{\"error\":\"bad job: %.60s\"}\n", line); fflush(stdout); return 3; }
		if (nf0 == 3) { lrB = Lr; keepB = keep; }
		if (fread(picks.data(), 4, (size_t)k, stdin) != (size_t)k) break;
		const auto tb = std::chrono::steady_clock::now();
		const double k0 = lk::G.totalKernelMs;
		cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
		uint32_t nd = std::min<uint32_t>(ctr[3], (uint32_t)cap);
		for (unsigned long long i = 0; i < k; i++) if (picks[i] >= nd) { printf("{\"error\":\"pick %u: no such cell\"}\n", picks[i]); fflush(stdout); return 3; }
		cu::cuMemcpyHtoD_v2(dpicks.p, picks.data(), 4 * k);
		// (the picks' states, from the pool)
		for (unsigned long long i = 0; i < k; i++) memcpy(pickH.p + i * SB, pool + (size_t)picks[i] * SB, SB);
		cu::cuMemcpyHtoD_v2(dpickS.p, pickH.p, SB * k);
		cu::cuMemsetD8_v2(dctr.p, 0, 12);   // (touched, finishes, records)
		P.nPicks = (u32)k; P.maxT = (i32)std::min<unsigned long long>(mt, 0x7fffffff); P.batchSeed = (u32)seed; P.full = nd >= cap ? 1 : 0;
		P.Lr = lrB; P.keep = keepB;   // (this batch's roll and collect kernels: its run length and keep)
		void* ap[] = { &P };
		lk::over(ckRollFor(lrB), k * (uint64_t)R, 128, fRoll, ap, "roll", [&](uint32_t lo, uint32_t hi) { P.lo = lo; P.hi = hi; }, rollTook);
		const double rollMs = lk::G.totalKernelMs - k0, rollWall = lk::sinceMs(tb);
		cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
		const uint32_t nt = std::min(ctr[0], touchedCap);
		outAll.clear();
		lastD.clear();
		const double c0 = lk::G.totalKernelMs;
		for (uint32_t a = 0; a < nt; a += recCapNow) {
			const uint32_t b = std::min(nt, a + recCapNow);
			cu::cuMemsetD8_v2(dctr.p + 8, 0, 4);
			lk::over(ckCol, b - a, 128, fCollect, ap, "roll collect", [&](uint32_t lo, uint32_t hi) { P.lo = a + lo; P.hi = a + hi; });
			cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
			const uint32_t nr = std::min(ctr[2], recCapNow);
			if (!nr) continue;
			const size_t o = outAll.size();
			outAll.resize(o + 6ull * nr);
			cu::cuMemcpyDtoH_v2(outAll.data() + o, dout.p, 24ull * nr);
			// (the records' states, into the pool; those of the last range after the reply, while goexplore.js picks the next
			// batch: the copies into new pages of the pool took ~10 ms of a 55 ms batch of Stupid Fox's on the H100)
			cu::cuMemcpyDtoH_v2(stageH.p, dstage.p, SB * nr);
			if (b < nt) {
				for (uint32_t j = 0; j < nr; j++) {
					const int32_t d = outAll[o + 6ull * j];
					if (d >= 0 && (uint64_t)d < cap) memcpy(pool + (size_t)d * SB, stageH.p + (size_t)j * SB, SB);
				}
			} else lastD.assign(outAll.begin() + o, outAll.end());
		}
		const double colMs = lk::G.totalKernelMs - c0;
		const uint32_t nf = std::min(ctr[1], finCap);
		fins.assign(4ull * nf, 0);
		if (nf) cu::cuMemcpyDtoH_v2(fins.data(), dfin.p, 16ull * nf);
		nd = std::min<uint32_t>(ctr[3], (uint32_t)cap);
		unsigned long long st1[5];
		cu::cuMemcpyDtoH_v2(st1, dctr.p + 32, 40);
		const unsigned long long dt = st1[0] - st[0], dr = st1[1] - st[1], dc = st1[2] - st[2], dd = st1[3] - st[3], dk = st1[4] - st[4];
		memcpy(st, st1, sizeof st);
		batches++;
		const size_t n = outAll.size() / 6;
		// (a canonical order: the records and the finishes by (tick, pick, run, step), unique per record; the GPU's atomics
		// give them in any order, and goexplore.js's archive follows the order it reads them in: so the same seed makes
		// the same search, but for the new cells' dense ids, and those of the batch that fills the pool)
		const auto recKey = [](uint32_t t, uint32_t pk, uint32_t run, uint32_t step) { return ((uint64_t)t << 40) | ((uint64_t)pk << 20) | ((uint64_t)(run & 0xfff) << 8) | (step & 0xff); };
		if (n > 1) {
			ord.resize(n);
			for (size_t j = 0; j < n; j++) { const int32_t* o = &outAll[6 * j]; ord[j] = { recKey((uint32_t)o[1], (uint32_t)o[4], (uint32_t)o[5] & 0xffff, (uint32_t)o[5] >> 16), (uint32_t)j }; }
			std::sort(ord.begin(), ord.end());
			sorted.resize(outAll.size());
			for (size_t j = 0; j < n; j++) memcpy(&sorted[6 * j], &outAll[6ull * ord[j].second], 24);
			outAll.swap(sorted);
		}
		if (nf > 1) {
			ord.resize(nf);
			for (uint32_t j = 0; j < nf; j++) ord[j] = { recKey(fins[4 * j + 3], fins[4 * j], fins[4 * j + 1], fins[4 * j + 2]), j };
			std::sort(ord.begin(), ord.end());
			finSorted.resize(fins.size());
			for (uint32_t j = 0; j < nf; j++) memcpy(&finSorted[4 * j], &fins[4ull * ord[j].second], 16);
			fins.swap(finSorted);
		}
		printf("{\"ev\":\"batch\",\"n\":%zu,\"fin\":%u,\"cells\":%u,\"full\":%d,\"touched\":%u,\"ticks\":%llu,\"runs\":%llu,\"cut\":%llu,\"dead\":%llu,\"kept\":%llu,\"ms\":%.2f,\"kernelMs\":%.2f,"
			"\"rollMs\":%.2f,\"rollWallMs\":%.2f,\"colMs\":%.2f,\"bytes\":%llu}\n",
			n, nf, nd, nd >= cap ? 1 : 0, nt, dt, dr, dc, dd, dk, lk::sinceMs(tb), lk::G.totalKernelMs - k0, rollMs, rollWall, colMs, (unsigned long long)(24 * n + 16ull * nf));
		fflush(stdout);
		if (n) fwrite(outAll.data(), 24, n, stdout);
		if (nf) fwrite(fins.data(), 16, nf, stdout);
		fflush(stdout);
		// (the last range's states: lastD holds its records as they came, 6 i32 each, next to their states in stageH)
		for (size_t j = 0; 6 * j < lastD.size(); j++) {
			const int32_t d = lastD[6 * j];
			if (d >= 0 && (uint64_t)d < cap) memcpy(pool + (size_t)d * SB, stageH.p + j * SB, SB);
		}
	}
	lk::onStop = nullptr;
	finale(why);
	free(start);
	return 0;
}

static int cmdRoll(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: eegpu roll <level.bin> [--reach=<file>] [--rolls=8] [--roll=40] (jobs on stdin: native/rollhost.h)\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runRoll<8>(argc, argv, B);
	case 32: return runRoll<32>(argc, argv, B);
	case 128: return runRoll<128>(argc, argv, B);
	case 512: return runRoll<512>(argc, argv, B);
	}
	printf("{\"error\":\"level state too large for the GPU engine\"}\n");
	return 3;
}
