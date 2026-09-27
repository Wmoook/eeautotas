// rollhost.h - `eegpu roll`: the random runs of Find a route's "random runs (GPU)" (src/goexplore.js --gpu=1), a
// persistent GPU server for the Go-Explore of goexplore.js with coarse cells (explore.h RollParams). Included by
// eegpu.cpp.
//   eegpu roll <level.bin> [--reach=<RCH3>] [--prune=1] [--rolls=8] [--roll=40] [--keep=0.85] [--phase=50]
//              [--cap=<cells>] [--mem=<MB>] [--maxPicks=65536]
// It keeps the cell table and one state per cell (the pool, by dense id; the start is cell 0) on the GPU, and reads
// jobs from stdin (binary mode):
//   "batch K maxT seed\n" + K x u32 (the picked cells' dense ids): every pick plays --rolls runs of up to --roll ticks
//       (goexplore.js's inputs: explore.h rollSeed / rollDraw); a state at tick >= maxT is not added and a run ends past
//       maxT. Reply: {"ev":"batch","n":N,"fin":F,"cells":C,"full":0|1,"touched":..,"ticks":..,"runs":..,"cut":..,
//       "dead":..,"ms":..,"kernelMs":..,"bytes":B}\n + N records of 6 i32 (dense id or -1 (the pool is full: not
//       kept), tick, reach fifths (-1: cut off), room (goexplore.js roomOf key), pick index, run | step << 16: the
//       cell's state is the pick's state after steps 0..step of that run) + F finishes of 4 u32 (pick index, run,
//       step, tick: the trophy taken at that step). A record is a new cell or one reached sooner than before.
//   "seen\n": {"ev":"seen","n":C,"bytes":4C}\n + C x u32: how often runs came through each cell (head B).
//   "stop\n", or the end of stdin: the done line, exit 0.
// Before the first job: the ready event, then {"ev":"start","stateBytes":..,"cap":..,"slots":..,"fifths":..,"room":..,
// "memMB":..}. The pool holds --cap cells (default: from --mem, else a quarter of the GPU's memory (an eighth on a GPU
// of 12 GB or less: the 8 GB laptop GPU gives it 1 GB, ~1.4 M cells, next to every move's table and the beams), at most
// the free memory less 1 GB); once full, only known cells improve (goexplore.js's archive likewise). Launches are
// sized toward --launch-ms like every command (launch.h); --stopfile / --pausefile / --parent act between two launches.
#pragma once
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

template <int TW>
static int runRoll(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const int R = std::max(1, std::min(4095, atoi(opt(argc, argv, "rolls", "8").c_str())));
	const int Lr = std::max(1, std::min(255, atoi(opt(argc, argv, "roll", "40").c_str())));
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
	if (!fRoll || !fCollect || !fSeen) { printf("{\"error\":\"roll kernels missing\"}\n"); return 4; }
	RollParams P;
	memset(&P, 0, sizeof P);
	P.L = L;   // (host pointers for now: the start cell's key below; the device copy's before the first launch)
	P.R = R; P.Lr = Lr; P.keep = keep;
	P.prune = opt(argc, argv, "prune", "1") == "1" ? 1 : 0;
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
	// the pool's size: --cap cells, else what --mem MB (else a quarter of the GPU's memory, an eighth up to 12 GB, at most
	// the free memory less 1 GB) holds: a state, its tick, slot and seen count, and two table slots of 28 bytes per cell
	size_t memB = 0;
	{
		const size_t total = g.d.mem ? g.d.mem : (size_t)4 << 30;
		size_t fr = total, tot = 0;
		if (cu::cuMemGetInfo_v2) cu::cuMemGetInfo_v2(&fr, &tot);
		const double mb = atof(opt(argc, argv, "mem", "0").c_str());
		// (a GPU of 12 GB or less, e.g. the 8 GB laptop one: an eighth, 1 GB, next to every move's table and the beams)
		const size_t share = total <= ((size_t)12 << 30) ? total / 8 : total / 4;
		memB = mb > 0 ? (size_t)(mb * 1048576.0) : std::min(share, fr > ((size_t)1 << 30) + ((size_t)256 << 20) ? fr - ((size_t)1 << 30) : (size_t)256 << 20);
	}
	// (per pick: its id, its state's copy, and R x Lr touched slots at most)
	const size_t fixedB = (size_t)maxPicks * (4 + SB + 4 * (size_t)R * Lr) + B.bytes.size();
	uint64_t cap = (uint64_t)std::max<int64_t>(4096, (int64_t)((memB > fixedB ? memB - fixedB : 0) / (SB + 12 + 24 + 2 * 28)));
	if (opt(argc, argv, "cap", "").size()) cap = (uint64_t)std::max(1024, atoi(opt(argc, argv, "cap", "0").c_str()));
	cap = std::min<uint64_t>(cap, (uint64_t)1 << 30);
	uint64_t slots = 1024;
	while (slots < 2 * cap) slots <<= 1;
	// (the records of one collect launch range: at most one per touched slot; the touched slots of a batch are collected in
	// ranges of at most recCap)
	const uint32_t touchedCap = (uint32_t)std::min<uint64_t>((uint64_t)maxPicks * R * Lr, slots);
	const uint32_t recCap = (uint32_t)std::min<uint64_t>(touchedCap, cap);
	const uint32_t finCap = 4096;
	cu::Buf dl, dpool, dcellT, dkeys, dbest, ddone, dseen, ddense, dslot, dseenOut, dtouched, dpicks, dpickS, dfin, dout, dctr;
	for (;;) {
		const bool ok = dl.upload(B.bytes.data(), B.bytes.size()) && dpool.alloc(SB * cap) && dcellT.alloc(4 * cap) && dkeys.alloc(8 * slots) && dbest.alloc(8 * slots) &&
			ddone.alloc(4 * slots) && dseen.alloc(4 * slots) && ddense.alloc(4 * slots) && dslot.alloc(4 * cap) && dseenOut.alloc(4 * cap) && dtouched.alloc(4ull * touchedCap) &&
			dpicks.alloc(4ull * maxPicks) && dpickS.alloc(SB * maxPicks) && dfin.alloc(16ull * finCap) && dout.alloc(24ull * recCap) && dctr.alloc(64);
		if (ok) break;
		// (out of GPU memory, e.g. another strategy took it after the check: half the pool, down to 64 K cells)
		if (cu::lastCode != 2 || cap <= 65536) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
		for (cu::Buf* b : { &dl, &dpool, &dcellT, &dkeys, &dbest, &ddone, &dseen, &ddense, &dslot, &dseenOut, &dtouched, &dpicks, &dpickS, &dfin, &dout, &dctr }) b->free();
		cap /= 2;
		slots /= 2;
		printf("{\"warn\":\"out of GPU memory: the pool holds %llu cells\"}\n", (unsigned long long)cap);
	}
	const uint32_t recCapNow = (uint32_t)std::min<uint64_t>(recCap, cap);
	lk::memset8(dkeys.p, 0, 8 * slots, "memset");
	lk::memset8(dbest.p, 0xff, 8 * slots, "memset");
	lk::memset8(ddone.p, 0xff, 4 * slots, "memset");
	lk::memset8(dseen.p, 0, 4 * slots, "memset");
	lk::memset8(ddense.p, 0xff, 4 * slots, "memset");
	cu::cuMemsetD8_v2(dctr.p, 0, 64);
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
		cu::cuMemcpyHtoD_v2(dpool.p, start, SB);
		cu::cuMemcpyHtoD_v2(dcellT.p, &zero, 4);
		cu::cuMemcpyHtoD_v2(dctr.p + 12, &one, 4);
		cu::cuMemcpyHtoD_v2(dslot.p, &slot0, 4);
	}
	const int32_t fifths0 = reachGpu.H.on ? reachFifths(reachGpu.H, start->px, start->py, start->speed_y, start->q0, start->q1, start->slippery) : -1;
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.pool = (u8*)(uintptr_t)dpool.p; P.stateBytes = (i32)SB; P.cellT = (i32*)(uintptr_t)dcellT.p;
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
	_setmode(_fileno(stdin), _O_BINARY);
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	g.ready(tStart);
	printf("{\"ev\":\"start\",\"stateBytes\":%d,\"cap\":%llu,\"slots\":%llu,\"fifths\":%d,\"room\":%d,\"memMB\":%.0f,\"rolls\":%d,\"roll\":%d,\"phase\":%d,\"gpu\":%s}\n", (int)SB,
		(unsigned long long)cap, (unsigned long long)slots, fifths0, (int32_t)room0, (double)((SB + 12) * cap + 28 * slots + (SB + 4ull * R * Lr) * maxPicks) / 1048576.0, R, Lr, P.phase,
		g.json().c_str());
	fflush(stdout);
	uint64_t batches = 0;
	unsigned long long st[4] = { 0, 0, 0, 0 };
	auto finale = [&](const char* why) {
		printf("{\"ev\":\"done\",\"end\":\"%s\",\"batches\":%llu,\"ticks\":%llu,\"runs\":%llu,\"seconds\":%.1f%s}\n", why, (unsigned long long)batches, st[0], st[1],
			std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(), lk::doneFields().c_str());
		fflush(stdout);
	};
	lk::onStop = [&]() { finale("stopped"); };
	lk::Chunk ckRoll(2048, 128, 1u << 30, 128), ckCol(4096, 128, 1u << 30, 128), ckSeen(1 << 16, 256, 1u << 31, 256);
	unsigned long long simSeen = 0;
	auto rollTook = [&](lk::Chunk& c, double items, double ms) {
		unsigned long long sim = simSeen;
		cu::cuMemcpyDtoH_v2(&sim, dctr.p + 32, 8);
		c.tookWorst(items, ms, (double)(sim - simSeen), items * Lr);   // (a run that ends early is cheaper: sized for Lr ticks each)
		simSeen = sim;
	};
	std::vector<uint32_t> picks(maxPicks);
	std::vector<int32_t> outAll;
	std::vector<uint32_t> fins, seenHost;
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
		if (sscanf(line, "batch %llu %llu %llu", &k, &mt, &seed) != 3 || k < 1 || k > maxPicks) { printf("{\"error\":\"bad job: %.60s\"}\n", line); fflush(stdout); return 3; }
		if (fread(picks.data(), 4, (size_t)k, stdin) != (size_t)k) break;
		const auto tb = std::chrono::steady_clock::now();
		const double k0 = lk::G.totalKernelMs;
		cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
		uint32_t nd = std::min<uint32_t>(ctr[3], (uint32_t)cap);
		for (unsigned long long i = 0; i < k; i++) if (picks[i] >= nd) { printf("{\"error\":\"pick %u: no such cell\"}\n", picks[i]); fflush(stdout); return 3; }
		cu::cuMemcpyHtoD_v2(dpicks.p, picks.data(), 4 * k);
		cu::cuMemsetD8_v2(dctr.p, 0, 12);   // (touched, finishes, records)
		P.nPicks = (u32)k; P.maxT = (i32)std::min<unsigned long long>(mt, 0x7fffffff); P.batchSeed = (u32)seed; P.full = nd >= cap ? 1 : 0;
		void* ap[] = { &P };
		lk::over(ckRoll, k * (uint64_t)R, 128, fRoll, ap, "roll", [&](uint32_t lo, uint32_t hi) { P.lo = lo; P.hi = hi; }, rollTook);
		const double rollMs = lk::G.totalKernelMs - k0, rollWall = lk::sinceMs(tb);
		cu::cuMemcpyDtoH_v2(ctr, dctr.p, 32);
		const uint32_t nt = std::min(ctr[0], touchedCap);
		outAll.clear();
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
		}
		const double colMs = lk::G.totalKernelMs - c0;
		const uint32_t nf = std::min(ctr[1], finCap);
		fins.assign(4ull * nf, 0);
		if (nf) cu::cuMemcpyDtoH_v2(fins.data(), dfin.p, 16ull * nf);
		nd = std::min<uint32_t>(ctr[3], (uint32_t)cap);
		unsigned long long st1[4];
		cu::cuMemcpyDtoH_v2(st1, dctr.p + 32, 32);
		const unsigned long long dt = st1[0] - st[0], dr = st1[1] - st[1], dc = st1[2] - st[2], dd = st1[3] - st[3];
		memcpy(st, st1, sizeof st);
		batches++;
		const size_t n = outAll.size() / 6;
		printf("{\"ev\":\"batch\",\"n\":%zu,\"fin\":%u,\"cells\":%u,\"full\":%d,\"touched\":%u,\"ticks\":%llu,\"runs\":%llu,\"cut\":%llu,\"dead\":%llu,\"ms\":%.2f,\"kernelMs\":%.2f,"
			"\"rollMs\":%.2f,\"rollWallMs\":%.2f,\"colMs\":%.2f,\"bytes\":%llu}\n",
			n, nf, nd, nd >= cap ? 1 : 0, nt, dt, dr, dc, dd, lk::sinceMs(tb), lk::G.totalKernelMs - k0, rollMs, rollWall, colMs, (unsigned long long)(24 * n + 16ull * nf));
		fflush(stdout);
		if (n) fwrite(outAll.data(), 24, n, stdout);
		if (nf) fwrite(fins.data(), 16, nf, stdout);
		fflush(stdout);
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
