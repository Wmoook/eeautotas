// explorehost.h - `eegpu explore`: the exhaustive exploration of explore.h, driven from the host. Included by eegpu.cpp.
//   eegpu explore <level.bin> <run.eetas | -> --from=T --region=x0,y0,x1,y1 --floor=<py of the ball standing on the floor>
//                 --above=<tick-start py limit> --land=x0,x1 [--depth=200] [--cap=2000000] [--seconds=120]
// From the run's state after T ticks (`-`: the level start), expands every input every tick, one state per cell
// (explore.h), and reports every input history whose next tick is a ground jump on the floor from above its row (JSON
// lines). Other targets: --reach=x0,y0,x1,y1 (the box centre enters those tiles), --ahead=1 (ahead of the run),
// --finish=1 (the tick that takes the trophy; the search ends with the first layer that has one: the fastest route
// up to the cell merging). Cells: --coarse=<row> (from this tile row down, px x --cqx and vx x --cqv to whole
// numbers; default 0.5 and 16), --qy / --qvy (py / vy likewise; 0 = exact), --discrete=1 (cells also differ in coins,
// keys, switches, the time doors' phase, effects: Sim::hashDiscrete).
// --rejoin=1 [--nocoins=1] [--gain=1]: the optimizer's target. From the run's state at --from, a state equal to one the
// run reaches at least --gain ticks later (exact state hash, re-checked on the CPU with both hashes) is a proven
// shortcut: {"ev":"rejoin","from":T,"j":J,"ticks":L,"saving":J-T-L,"inputs":...} (the shortest per J); states on the
// run are not expanded (from there it goes as the run does).
#pragma once

template <int TW>
static int runExplore(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	int from = atoi(opt(argc, argv, "from", "0").c_str());
	const int depthMax = atoi(opt(argc, argv, "depth", "200").c_str());
	const int capReq = std::max(1024, atoi(opt(argc, argv, "cap", "2000000").c_str()));
	const double seconds = atof(opt(argc, argv, "seconds", "120").c_str());
	int rx0 = 0, ry0 = 0, rx1 = 1 << 20, ry1 = 1 << 20, lx0 = 0, lx1 = 1 << 20;
	sscanf(opt(argc, argv, "region", "0,0,1048576,1048576").c_str(), "%d,%d,%d,%d", &rx0, &ry0, &rx1, &ry1);
	sscanf(opt(argc, argv, "land", "0,1048576").c_str(), "%d,%d", &lx0, &lx1);
	const double floorPy = atof(opt(argc, argv, "floor", "0").c_str()), aboveMax = atof(opt(argc, argv, "above", "0").c_str());
	auto tStart = std::chrono::steady_clock::now();
	auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(); };
	Level L = B.level(B.bytes.data());
	S* start = (S*)calloc(1, sizeof(S));
	const bool ahead = opt(argc, argv, "ahead", "0") == "1";
	const bool rejoin = opt(argc, argv, "rejoin", "0") == "1", ncR = opt(argc, argv, "nocoins", "0") == "1";
	std::vector<uint64_t> refH, refH2;       // --rejoin: the run's state hashes per tick, and the quad keys' positions
	std::vector<double> qX, qY, qSX, qSY;
	std::vector<int32_t> refTile;
	std::vector<float> rX, rY, rVX, rVY;   // the run's state per tick (index = tick)
	{
		Sim<TW> sim(L, *start);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		std::vector<uint8_t> ref;
		if (strcmp(argv[3], "-") != 0) ref = readMasks(argv[3]);
		S* rs = (S*)malloc(sizeof(S));
		if (ahead || rejoin) refTile.assign((size_t)L.N, -1);
		for (int t = 0; t < (int)ref.size(); t++) {
			rX.push_back((float)start->px); rY.push_back((float)start->py); rVX.push_back((float)start->speed_x); rVY.push_back((float)start->speed_y);
			if (rejoin) { refH.push_back(sim.hash(ncR)); refH2.push_back(sim.hash2(ncR)); qX.push_back(start->px); qY.push_back(start->py); qSX.push_back(start->speed_x); qSY.push_back(start->speed_y); }
			if (t == from) memcpy(rs, start, sizeof(S));
			if (t >= from && (ahead || rejoin)) {
				// --ahead: the run's first visit per tile; --rejoin: its last (a state later than that, by more than
				// the slack, is behind the run's schedule there)
				const int tx = (int)std::floor((start->px + 8) / 16), ty = (int)std::floor((start->py + 8) / 16);
				if (tx >= 0 && ty >= 0 && tx < L.W && ty < L.H && (rejoin || refTile[(size_t)ty * L.W + tx] < 0)) refTile[(size_t)ty * L.W + tx] = t;
			}
			if (t >= from && !ahead && !rejoin) break;
			const bool crown0 = start->has_silver_crown;
			Input in = maskInput(ref[t]); sim.tick(in);
			if (!crown0 && start->has_silver_crown) break;
		}
		if (from < (int)ref.size()) memcpy(start, rs, sizeof(S));
		free(rs);
		if (rejoin && from >= (int)refH.size()) { printf("{\"error\":\"--from must be a tick inside the run\"}\n"); return 3; }
	}
	// --prefix: inputs played from the start state first (the exploration continues from where they end); the
	// reported inputs include them
	std::string prefixStr;
	{
		const std::string pf = opt(argc, argv, "prefix", "");
		if (!pf.empty()) {
			std::vector<uint8_t> raw = readFile(pf.c_str());
			Sim<TW> ps(L, *start);
			for (uint8_t c : raw) {
				if (c < 48 || c >= 80) continue;
				prefixStr.push_back((char)c);
				Input in = maskInput((c - 48) & 31);
				ps.tick(in);
			}
			if (start->is_dead) { printf("{\"error\":\"the prefix dies\"}\n"); return 3; }
		}
	}
	const int from0 = from;
	from += (int)prefixStr.size();
	(void)from0;
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::CUfunction fexp = g.fn("exploreExpand_" + std::to_string(TW)), fmat = g.fn("exploreMaterialize_" + std::to_string(TW));
	cu::CUfunction fProp = g.fn("exploreClaimPropose"), fCount = g.fn("exploreClaimCount"), fTake = g.fn("exploreClaimTake");
	if (!fexp || !fmat || !fProp || !fCount || !fTake) { printf("{\"error\":\"explore kernels missing\"}\n"); return 4; }
	const size_t SB = sizeof(S);
	// the visited-cell table: 1 GB (2^27 cells) on GPUs with 6 GB or more, else smaller; stop before it is half full
	// (probing degrades). The state buffers take at most about a third of the memory.
	const size_t memB = g.d.mem ? g.d.mem : (size_t)4 << 30;
	uint32_t cellLog = memB >= ((size_t)11 << 30) ? 27 : memB >= ((size_t)5 << 30) ? 26 : 25;   // (16 bytes per cell)
	if (opt(argc, argv, "cells", "").size()) cellLog = (uint32_t)std::max(20, std::min(28, atoi(opt(argc, argv, "cells", "27").c_str())));
	const uint32_t cellCount = 1u << cellLog;
	const int cap = (int)std::max<size_t>(1024, std::min<size_t>((size_t)capReq, memB / 3 / (2 * sizeof(S) + 18 * 20)));
	const uint32_t hitCap = 1u << 16;
	cu::Buf dl, dA, dB, dcells, dout, dnout, dhits, dnhits, dpick, dbest, dck, dcp, dcs, dnwin, dhist;
	const size_t nCandMax = (size_t)cap * 18;
	bool up = dl.upload(B.bytes.data(), B.bytes.size()) && dA.alloc(SB * cap) && dB.alloc(SB * cap) && dcells.alloc(8ull * cellCount) &&
		dout.alloc(4ull * cap) && dnout.alloc(4) && dhits.alloc(sizeof(ExploreHit) * hitCap) && dnhits.alloc(4) && dpick.alloc(4ull * cap) &&
		dbest.alloc(8ull * cellCount) && dck.alloc(8 * nCandMax) && dcp.alloc(8 * nCandMax) && dcs.alloc(4 * nCandMax) && dnwin.alloc(4) && dhist.alloc(4 * 4096);
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::cuMemsetD8_v2(dbest.p, 0xff, 8ull * cellCount);
	ExploreClaim Q;
	memset(&Q, 0, sizeof Q);
	Q.cells = (u64*)(uintptr_t)dcells.p; Q.cellBest = (u64*)(uintptr_t)dbest.p; Q.mask = cellCount - 1;
	Q.candKey = (const u64*)(uintptr_t)dck.p; Q.candPrio = (const u64*)(uintptr_t)dcp.p; Q.candSlot = (u32*)(uintptr_t)dcs.p;
	Q.out = (u32*)(uintptr_t)dout.p; Q.nOut = (u32*)(uintptr_t)dnout.p; Q.outCap = (u32)cap; Q.nWin = (u32*)(uintptr_t)dnwin.p; Q.hist = (u32*)(uintptr_t)dhist.p;
	const bool finishTarget = opt(argc, argv, "finish", "0") == "1";
	int finishLayer = -1;
	// the closest attempt (the route search): the goal field on the GPU, the per-layer minimum
	std::vector<float> goalDist;
	cu::Buf dgoal, dclose;
	Closest nearest;
	ReachGpu reachGpu;
	ReachField reachF;
	memset(&reachF, 0, sizeof reachF);
	{
		const std::string rf = opt(argc, argv, "reach", "");
		std::string err;
		if (!rf.empty() && !reachGpu.load(rf, L, reachF, err)) { printf("{\"error\":%s}\n", jsonStr(err).c_str()); return 3; }
	}
	const bool wantNear = finishTarget && (reachF.on || goalField(L, goalDist));
	if (wantNear && ((!reachF.on && !dgoal.upload(goalDist.data(), 4 * goalDist.size())) || !dclose.alloc(8))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
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
	P.cqx = atof(opt(argc, argv, "cqx", "0.5").c_str()); P.cqv = atof(opt(argc, argv, "cqv", "16").c_str());
	if (finishTarget) P.target = 3;
	if (wantNear) { P.goalDist = (const float*)(uintptr_t)dgoal.p; P.closest = (unsigned long long*)(uintptr_t)dclose.p; }
	P.reach = reachF;
	P.prune = reachF.on && opt(argc, argv, "prune", "0") == "1" ? 1 : 0;
	P.discrete = opt(argc, argv, "discrete", "0") == "1" ? 1 : 0;
	P.keepRest = P.discrete && L.hasTimeDoors ? 1 : 0;
	cu::Buf drt, dtb, drx, dry, drvx, drvy, dhk, dhv, dqb;
	std::vector<int> rejoinBest;   // --rejoin: the shortest printed per target tick
	if (rejoin) {
		uint32_t hcap = 1024;
		while (hcap < 4u * (uint32_t)refH.size()) hcap <<= 1;
		std::vector<uint64_t> hk(hcap, 0); std::vector<int32_t> hv(hcap, -1);
		for (int t = 0; t < (int)refH.size(); t++) {
			const uint64_t key = refH[t] | (1ull << 63);
			uint32_t slot = (uint32_t)(splitmix(refH[t]) & (hcap - 1));
			while (hk[slot] != 0 && hk[slot] != key) slot = (slot + 1) & (hcap - 1);
			hk[slot] = key; hv[slot] = t;   // (the latest tick wins: the biggest saving)
		}
		std::vector<uint32_t> qb((1u << QBITS_LOG2) / 32, 0);
		for (size_t t = 0; t < qX.size(); t++) { const uint32_t bit = (uint32_t)(quadKey(qX[t], qY[t], qSX[t], qSY[t]) >> (64 - QBITS_LOG2)); qb[bit >> 5] |= 1u << (bit & 31); }
		if (!dhk.upload(hk.data(), 8 * hk.size()) || !dhv.upload(hv.data(), 4 * hv.size()) || !dqb.upload(qb.data(), 4 * qb.size())) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
		P.target = 4; P.htKeys = (const u64*)(uintptr_t)dhk.p; P.htVals = (const i32*)(uintptr_t)dhv.p; P.htMask = hcap - 1; P.qbits = (const u32*)(uintptr_t)dqb.p;
		P.nocoins = ncR ? 1 : 0; P.fromTick = from; P.minGain = std::max(1, atoi(opt(argc, argv, "gain", "1").c_str()));
		// --slack=N: a state later than the run's last visit of its tile + N is dropped (off by default: -1)
		P.slack = atoi(opt(argc, argv, "slack", "-1").c_str());
		if (P.slack >= 0) {
			if (!drt.upload(refTile.data(), 4 * refTile.size())) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
			P.refTile = (const i32*)(uintptr_t)drt.p;
		}
		rejoinBest.assign(refH.size(), 1 << 30);
	}
	if (ahead) {
		if (!drt.upload(refTile.data(), 4 * refTile.size())) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
		P.target = 2; P.refTile = (const i32*)(uintptr_t)drt.p; P.fromTick = from;
		std::vector<int32_t> tb(refTile.size(), -1);
		if (!dtb.upload(tb.data(), 4 * tb.size())) { printf("{\"error\":\"tileBest\"}\n"); return 4; }
		P.tileBest = (i32*)(uintptr_t)dtb.p;
		if (!drx.upload(rX.data(), 4 * rX.size()) || !dry.upload(rY.data(), 4 * rY.size()) || !drvx.upload(rVX.data(), 4 * rVX.size()) || !drvy.upload(rVY.data(), 4 * rVY.size())) { printf("{\"error\":\"run arrays\"}\n"); return 4; }
		P.rX = (const float*)(uintptr_t)drx.p; P.rY = (const float*)(uintptr_t)dry.p; P.rVX = (const float*)(uintptr_t)drvx.p; P.rVY = (const float*)(uintptr_t)drvy.p;
		P.nRef = (i32)rX.size(); P.maxDist = (float)atof(opt(argc, argv, "maxdist", "24").c_str());
		P.minGain = atoi(opt(argc, argv, "gain", "10").c_str()); P.slack = atoi(opt(argc, argv, "slack", "30").c_str());
		P.minAhead = atoi(opt(argc, argv, "minahead", "40").c_str());
	}
	P.pick = (const u32*)(uintptr_t)dpick.p;
	P.candKey = (u64*)(uintptr_t)dck.p; P.candPrio = (u64*)(uintptr_t)dcp.p;
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
		if (wantNear) cu::cuMemsetD8_v2(dclose.p, 0xff, 8);
		void* a1[] = { &P };
		if (cu::cuLaunchKernel(fexp, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a1, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"explore expand failed\"}\n"); return 5; }
		ticks += (uint64_t)nParents * 18;
		if (wantNear) {
			unsigned long long cl = ~0ull;
			cu::cuMemcpyDtoH_v2(&cl, dclose.p, 8);
			nearest.take(cl, d);
			nearest.print(elapsed(), false, prefixStr, from0, inputsOf);
		}
		// the claim: the cells new in this layer, one child each (the lowest priority); a layer over the cap keeps the
		// lowest priority bins
		Q.candKey = (const u64*)(uintptr_t)dck.p; Q.nCand = (u32)nParents * 18; Q.layer = (u32)d;
		{
			const unsigned cb = (Q.nCand + 255) / 256;
			void* aq[] = { &Q };
			cu::cuMemsetD8_v2(dnwin.p, 0, 4); cu::cuMemsetD8_v2(dhist.p, 0, 4 * 4096);
			if (cu::cuLaunchKernel(fProp, cb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuLaunchKernel(fCount, cb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuCtxSynchronize()) {
				printf("{\"error\":\"explore claim failed\"}\n"); return 5;
			}
			uint32_t nWin = 0;
			cu::cuMemcpyDtoH_v2(&nWin, dnwin.p, 4);
			if (opt(argc, argv, "debug", "0") == "1") fprintf(stderr, "layer %d: %u parents, %u candidates, %u winners\n", d, (unsigned)nParents, Q.nCand, nWin);
			Q.thrBin = 4096; Q.thrSub = 0; Q.subBin = 0xffffffffu;
			if (nWin > (uint32_t)cap) {
				// the bins that fit whole, then the boundary bin split by its sub-bins (the state's content)
				std::vector<uint32_t> hist(4096);
				cu::cuMemcpyDtoH_v2(hist.data(), dhist.p, 4 * 4096);
				uint64_t acc = 0; uint32_t b = 0;
				while (b < 4096 && acc + hist[b] <= (uint64_t)cap) acc += hist[b++];
				Q.thrBin = b;
				if (b < 4096) {
					Q.subBin = b;
					cu::cuMemsetD8_v2(dhist.p, 0, 4 * 4096);
					if (cu::cuLaunchKernel(fCount, cb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"explore claim failed\"}\n"); return 5; }
					cu::cuMemcpyDtoH_v2(hist.data(), dhist.p, 4 * 4096);
					uint32_t sb = 0;
					while (sb < 4096 && acc + hist[sb] <= (uint64_t)cap) acc += hist[sb++];
					Q.thrSub = sb;
					Q.subBin = 0xffffffffu;
				}
				if (opt(argc, argv, "debug", "0") == "1") fprintf(stderr, "claim layer %d: %u candidates, %u winners > cap %d: bins below %u and sub-bins below %u of it (%llu states)\n", d, Q.nCand, nWin, cap, Q.thrBin, Q.thrSub, (unsigned long long)acc);
			}
			if (cu::cuLaunchKernel(fTake, cb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"explore claim failed\"}\n"); return 5; }
		}
		uint32_t nOut = 0, nh = 0;
		cu::cuMemcpyDtoH_v2(&nOut, dnout.p, 4);
		cu::cuMemcpyDtoH_v2(&nh, dnhits.p, 4);
		nh = std::min(nh, hitCap);
		if (nh > hitsSeen) {
			std::vector<ExploreHit> hv(nh);
			cu::cuMemcpyDtoH_v2(hv.data(), dhits.p, sizeof(ExploreHit) * nh);
			// the layer's hits in a fixed order (by their inputs), whatever order the GPU found them in
			std::vector<std::pair<std::string, uint32_t>> order;
			for (uint32_t i = hitsSeen; i < nh; i++) {
				std::string in = prefixStr + inputsOf(d, hv[i].parent, hv[i].option);
				if (hv[i].jumpOption != 255) in.push_back((char)('0' + hv[i].jumpOption));
				order.push_back({ in, i });
			}
			std::sort(order.begin(), order.end());
			for (const auto& oh : order) {
				const ExploreHit& h = hv[oh.second];
				const std::string& in = oh.first;
				if (rejoin) {
					const int j = h.refTick;
					if (j < 0 || j >= (int)refH.size() || (int)in.size() >= rejoinBest[j]) continue;
					// the CPU check: the inputs from the start state reach the run's state at j (both hashes)
					S* st = (S*)malloc(SB);
					memcpy(st, start, SB);
					Sim<TW> vs(L, *st);
					bool ok = true;
					for (size_t k = prefixStr.size(); k < in.size() && ok; k++) { Input x = maskInput((in[k] - '0') & 31); vs.tick(x); if (st->is_dead || st->broken) ok = false; }
					ok = ok && vs.hash(ncR) == refH[j] && vs.hash2(ncR) == refH2[j];
					free(st);
					if (!ok) continue;
					rejoinBest[j] = (int)in.size();
					printf("{\"ev\":\"rejoin\",\"from\":%d,\"j\":%d,\"ticks\":%d,\"saving\":%d,\"inputs\":\"%s\"}\n", from0, j, (int)in.size(), j - from0 - (int)in.size(), in.c_str());
					continue;
				}
				printf("{\"ev\":\"hit\",\"layer\":%d,\"tick\":%d,\"px\":%.3f,\"vx\":%.3f,\"gain\":%d,\"refTick\":%d,\"inputs\":\"%s\"}\n", d, from0 + (int)in.size(), h.px, h.vx, h.gain, h.refTick, in.c_str());
			}
			fflush(stdout);
			hitsSeen = nh;
			if (finishTarget) { finishLayer = d; d++; break; }   // the first layer with a finish is the fastest
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
		printf("{\"ev\":\"layer\",\"layer\":%d,\"tick\":%d,\"new\":%u,\"kept\":%u,\"states\":%llu,\"hits\":%u,\"sec\":%.1f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"full\":%.4f}\n",
			d + 1, from + d + 1, nOut, kept, (unsigned long long)totalStates, hitsSeen, elapsed(), (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), (double)totalStates / (cellCount / 2));
		fflush(stdout);
	}
	if (finishLayer < 0) nearest.print(elapsed(), true, prefixStr, from0, inputsOf);
	const char* why = finishLayer >= 0 ? "finish" : totalStates > cellCount / 2 ? "full" : nParents <= 0 ? "exhausted" : d >= depthMax ? "depth" : "time";
	printf("{\"ev\":\"done\",\"gpu\":%s,\"layers\":%d,\"states\":%llu,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"hits\":%u,\"seconds\":%.1f,\"end\":\"%s\",\"cellLog\":%u,\"cap\":%d}\n",
		g.json().c_str(), d, (unsigned long long)totalStates, (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), hitsSeen, elapsed(), why, cellLog, cap);
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
