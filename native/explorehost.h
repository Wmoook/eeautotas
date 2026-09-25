// explorehost.h - `eegpu explore`: the exhaustive exploration of explore.h, driven from the host. Included by eegpu.cpp.
//   eegpu explore <level.bin> <run.eetas> --from=T --region=x0,y0,x1,y1 --floor=<py of the ball standing on the floor>
//                 --above=<tick-start py limit> --land=x0,x1 [--depth=200] [--cap=2000000] [--seconds=120]
// From the run's state after T ticks, expands every input every tick, one state per cell (explore.h), and reports
// every input history whose next tick is a ground jump on the floor from above its row (JSON lines).
#pragma once

template <int TW>
static int runExplore(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const int from = atoi(opt(argc, argv, "from", "0").c_str());
	const int depthMax = atoi(opt(argc, argv, "depth", "200").c_str());
	const int cap = std::max(1024, atoi(opt(argc, argv, "cap", "2000000").c_str()));
	const double seconds = atof(opt(argc, argv, "seconds", "120").c_str());
	int rx0 = 0, ry0 = 0, rx1 = 1 << 20, ry1 = 1 << 20, lx0 = 0, lx1 = 1 << 20;
	sscanf(opt(argc, argv, "region", "0,0,1048576,1048576").c_str(), "%d,%d,%d,%d", &rx0, &ry0, &rx1, &ry1);
	sscanf(opt(argc, argv, "land", "0,1048576").c_str(), "%d,%d", &lx0, &lx1);
	const double floorPy = atof(opt(argc, argv, "floor", "0").c_str()), aboveMax = atof(opt(argc, argv, "above", "0").c_str());
	auto tStart = std::chrono::steady_clock::now();
	auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(); };
	Level L = B.level(B.bytes.data());
	S* start = (S*)calloc(1, sizeof(S));
	{
		Sim<TW> sim(L, *start);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		std::vector<uint8_t> ref = readMasks(argv[3]);
		for (int t = 0; t < from && t < (int)ref.size(); t++) { Input in = maskInput(ref[t]); sim.tick(in); }
	}
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::CUfunction fexp = g.fn("exploreExpand_" + std::to_string(TW)), fmat = g.fn("exploreMaterialize_" + std::to_string(TW));
	if (!fexp || !fmat) { printf("{\"error\":\"explore kernels missing\"}\n"); return 4; }
	const size_t SB = sizeof(S);
	const uint32_t cellCount = 1u << 27;   // 1 GB: stop before it is half full (probing degrades)
	const uint32_t hitCap = 1u << 16;
	cu::Buf dl, dA, dB, dcells, dout, dnout, dhits, dnhits, dpick;
	bool up = dl.upload(B.bytes.data(), B.bytes.size()) && dA.alloc(SB * cap) && dB.alloc(SB * cap) && dcells.alloc(8ull * cellCount) &&
		dout.alloc(4ull * cap) && dnout.alloc(4) && dhits.alloc(sizeof(ExploreHit) * hitCap) && dnhits.alloc(4) && dpick.alloc(4ull * cap);
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::cuMemsetD8_v2(dcells.p, 0, 8ull * cellCount);
	cu::cuMemsetD8_v2(dnhits.p, 0, 4);
	cu::cuMemcpyHtoD_v2(dA.p, start, SB);
	ExploreParams P;
	memset(&P, 0, sizeof P);
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.stateBytes = (i32)SB;
	P.cells = (u64*)(uintptr_t)dcells.p; P.cellMask = cellCount - 1;
	P.out = (u32*)(uintptr_t)dout.p; P.nOut = (u32*)(uintptr_t)dnout.p; P.outCap = (u32)cap;
	P.hits = (ExploreHit*)(uintptr_t)dhits.p; P.nHits = (u32*)(uintptr_t)dnhits.p; P.hitCap = hitCap;
	P.rx0 = rx0; P.ry0 = ry0; P.rx1 = rx1; P.ry1 = ry1;
	P.floorPy = floorPy; P.aboveMax = aboveMax; P.tx0 = lx0; P.tx1 = lx1;
	P.coarseRow = atoi(opt(argc, argv, "coarse", "1048576").c_str());
	P.target = opt(argc, argv, "reach", "").empty() ? 0 : 1;
	sscanf(opt(argc, argv, "reach", "0,0,0,0").c_str(), "%d,%d,%d,%d", &P.reachX0, &P.reachY0, &P.reachX1, &P.reachY1);
	P.qy = atof(opt(argc, argv, "qy", "0").c_str()); P.qvy = atof(opt(argc, argv, "qvy", "0").c_str());
	P.pick = (const u32*)(uintptr_t)dpick.p;
	std::vector<std::vector<uint32_t>> lineage;
	int nParents = 1;
	cu::CUdeviceptr cur = dA.p, nxt = dB.p;
	uint64_t ticks = 0, totalStates = 1;
	uint32_t hitsSeen = 0;
	std::vector<ExploreHit> hits;
	auto inputsOf = [&](int d, uint32_t p, int o) {
		std::string s(d + 1, '0');
		s[d] = (char)('0' + option(o));
		for (int k = d - 1; k >= 0; k--) { const uint32_t pk = lineage[k][p]; s[k] = (char)('0' + option((int)(pk & 31))); p = pk >> 5; }
		return s;
	};
	int d = 0;
	for (; d < depthMax && nParents > 0 && elapsed() < seconds; d++) {
		cu::cuMemsetD8_v2(dnout.p, 0, 4);
		P.parents = (const u8*)(uintptr_t)cur; P.nParents = nParents; P.layer = d;
		void* a1[] = { &P };
		if (cu::cuLaunchKernel(fexp, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a1, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"explore expand failed\"}\n"); return 5; }
		ticks += (uint64_t)nParents * 18;
		uint32_t nOut = 0, nh = 0;
		cu::cuMemcpyDtoH_v2(&nOut, dnout.p, 4);
		cu::cuMemcpyDtoH_v2(&nh, dnhits.p, 4);
		nh = std::min(nh, hitCap);
		if (nh > hitsSeen) {
			std::vector<ExploreHit> hv(nh);
			cu::cuMemcpyDtoH_v2(hv.data(), dhits.p, sizeof(ExploreHit) * nh);
			for (uint32_t i = hitsSeen; i < nh; i++) {
				const ExploreHit& h = hv[i];
				std::string in = inputsOf(d, h.parent, h.option);
				if (h.jumpOption != 255) in.push_back((char)('0' + h.jumpOption));
				printf("{\"ev\":\"hit\",\"layer\":%d,\"tick\":%d,\"px\":%.3f,\"vx\":%.3f,\"inputs\":\"%s\"}\n", d, from + (int)in.size(), h.px, h.vx, in.c_str());
			}
			fflush(stdout);
			hitsSeen = nh;
		}
		const uint32_t kept = std::min<uint32_t>(nOut, (uint32_t)cap);
		std::vector<uint32_t> pick(kept);
		if (kept) cu::cuMemcpyDtoH_v2(pick.data(), dout.p, 4ull * kept);
		lineage.push_back(pick);
		nParents = (int)kept;
		totalStates += kept;
		if (!kept) { d++; break; }
		P.nPick = nParents; P.next = (u8*)(uintptr_t)nxt;
		cu::cuMemcpyHtoD_v2(dpick.p, pick.data(), 4ull * kept);
		void* a2[] = { &P };
		if (cu::cuLaunchKernel(fmat, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a2, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"explore materialize failed\"}\n"); return 5; }
		std::swap(cur, nxt);
		if (totalStates > cellCount / 2) { printf("{\"warn\":\"the visited-cell table is half full: stopping\"}\n"); d++; break; }
		printf("{\"ev\":\"layer\",\"layer\":%d,\"tick\":%d,\"new\":%u,\"kept\":%u,\"states\":%llu,\"hits\":%u,\"sec\":%.1f}\n", d + 1, from + d + 1, nOut, kept, (unsigned long long)totalStates, hitsSeen, elapsed());
		fflush(stdout);
	}
	printf("{\"ev\":\"done\",\"layers\":%d,\"states\":%llu,\"ticks\":%llu,\"hits\":%u,\"seconds\":%.1f}\n", d, (unsigned long long)totalStates, (unsigned long long)ticks, hitsSeen, elapsed());
	free(start);
	return 0;
}

static int cmdExplore(int argc, char** argv) {
	if (argc < 4) { fprintf(stderr, "usage: eegpu explore <level.bin> <run.eetas> --from=T --region=x0,y0,x1,y1 --floor=PY --above=PY --land=x0,x1\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runExplore<8>(argc, argv, B);
	case 32: return runExplore<32>(argc, argv, B);
	case 128: return runExplore<128>(argc, argv, B);
	case 512: return runExplore<512>(argc, argv, B);
	}
	printf("{\"error\":\"level state too large for the GPU engine\"}\n");
	return 3;
}
