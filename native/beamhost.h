// beamhost.h - `eegpu beam`: the guided beam search (beam.h) driven from the host. Included by eegpu.cpp.
//   eegpu beam <level.bin> [--ref=<run.eetas> --from=T] [--guide=<file: "x y" per line, px, box centre>]
//              [--goal=1] [--width=32768] [--depth=3000] [--seconds=60] [--nocoins=0|1] [--guideWeight=0.5]
//              [--goalWeight=16] [--bucket=24]
// Starts from the reference's state after T ticks (--ref), or from the level start (the editor). Prints JSON lines:
// progress, results (kind "rejoin": an exact rejoin with the reference at tick j, saving ticks; kind "finish": the
// level is finished), and done. Every result is re-checked on the CPU before it is printed. Inputs are printed as
// .eetas characters ('0' + mask).
#pragma once
#include <queue>
#include <unordered_map>

template <int TW>
static int runBeam(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const int K = std::max(64, atoi(opt(argc, argv, "width", "32768").c_str()));
	const int depthMax = atoi(opt(argc, argv, "depth", "3000").c_str());
	const double seconds = atof(opt(argc, argv, "seconds", "60").c_str());
	const bool nc = opt(argc, argv, "nocoins", "0") == "1";
	const bool goal = opt(argc, argv, "goal", "0") == "1";
	const float guideW = (float)atof(opt(argc, argv, "guideWeight", "0.5").c_str());
	const float goalW = (float)atof(opt(argc, argv, "goalWeight", "16").c_str());
	const int bucketCap = std::max(1, atoi(opt(argc, argv, "bucket", "24").c_str()));
	const std::string refPath = opt(argc, argv, "ref", "");
	int from = atoi(opt(argc, argv, "from", "0").c_str());
	auto tStart = std::chrono::steady_clock::now();
	auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(); };

	Level L = B.level(B.bytes.data());
	S* start = (S*)calloc(1, sizeof(S));
	// ---- the start state, and the reference (for exact rejoins)
	std::vector<uint64_t> refH, refH2;
	std::vector<uint8_t> refMasks;
	std::vector<uint64_t> htKeys; std::vector<int32_t> htVals; uint32_t htMask = 0;
	std::vector<uint32_t> qbits;
	std::vector<double> X, Y, SX, SY;
	int n = -1;
	{
		Sim<TW> sim(L, *start);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		if (!refPath.empty()) {
			std::vector<uint8_t> ref = readMasks(refPath.c_str());
			S* st = (S*)malloc(sizeof(S));
			memcpy(st, start, sizeof(S));
			Sim<TW> rs(L, *st);
			const bool crown0 = st->has_silver_crown;
			auto push = [&]() { refH.push_back(rs.hash(nc)); refH2.push_back(rs.hash2(nc)); X.push_back(st->px); Y.push_back(st->py); SX.push_back(st->speed_x); SY.push_back(st->speed_y); };
			push();
			if (from <= 0) memcpy(start, st, sizeof(S));
			for (size_t t = 0; t < ref.size(); t++) {
				Input in = maskInput(ref[t]);
				rs.tick(in);
				push();
				if ((int)t + 1 == from) memcpy(start, st, sizeof(S));
				if (!crown0 && st->has_silver_crown) { n = (int)t + 1; break; }
			}
			free(st);
			if (n < 0) { printf("{\"error\":\"the reference run does not finish the level\"}\n"); return 3; }
			if (from < 0 || from >= n) { printf("{\"error\":\"--from must be a tick inside the run (0..%d)\"}\n", n - 1); return 3; }
			refMasks.assign(ref.begin(), ref.begin() + n);
			uint32_t cap = 1024;
			while (cap < 4u * (uint32_t)(n + 1)) cap <<= 1;
			htMask = cap - 1;
			htKeys.assign(cap, 0); htVals.assign(cap, -1);
			for (int t = 0; t <= n; t++) {
				const uint64_t key = refH[t] | (1ull << 63);
				uint32_t slot = (uint32_t)(splitmix(refH[t]) & htMask);
				while (htKeys[slot] != 0 && htKeys[slot] != key) slot = (slot + 1) & htMask;
				htKeys[slot] = key; htVals[slot] = t;
			}
			qbits.assign((1u << QBITS_LOG2) / 32, 0);
			for (int t = 0; t <= n; t++) {
				const uint32_t bit = (uint32_t)(quadKey(X[t], Y[t], SX[t], SY[t]) >> (64 - QBITS_LOG2));
				qbits[bit >> 5] |= 1u << (bit & 31);
			}
		} else from = 0;
	}
	// ---- the guide polyline
	std::vector<float> gx, gy, gs;
	{
		const std::string gp = opt(argc, argv, "guide", "");
		if (!gp.empty()) {
			FILE* f = fopen(gp.c_str(), "r");
			double x, y;
			while (f && fscanf(f, "%lf %lf", &x, &y) == 2) { gx.push_back((float)x); gy.push_back((float)y); }
			if (f) fclose(f);
			gs.push_back(0);
			for (size_t i = 1; i < gx.size(); i++) gs.push_back(gs.back() + std::hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]));
		}
	}
	// ---- back to the run after the line: the reference tick nearest to the line's end (after the start), and per tile
	// the first reference tick from there on that visits it; the search stops a while after the run got there
	std::vector<int32_t> refTile;
	int refFrom = -1;
	if (gx.size() >= 2 && n > 0) {
		double bestD = 1e30;
		for (int t = from; t <= n; t++) {
			const double dx = X[t] + 8 - gx.back(), dy = Y[t] + 8 - gy.back(), dd = dx * dx + dy * dy;
			if (dd < bestD) { bestD = dd; refFrom = t; }
		}
		refTile.assign((size_t)L.N, -1);
		for (int t = refFrom; t <= n; t++) {
			const int tx = (int)std::floor((X[t] + 8) / 16), ty = (int)std::floor((Y[t] + 8) / 16);
			if (tx >= 0 && ty >= 0 && tx < L.W && ty < L.H && refTile[(size_t)ty * L.W + tx] < 0) refTile[(size_t)ty * L.W + tx] = t;
		}
	}
	const int depthLimit = refFrom >= 0 ? std::min(depthMax, refFrom - from + 600) : depthMax;
	// ---- the goal distance field: walking distance in tiles to a finish block (121) over tiles that are not static
	// solid blocks (doors, one-ways and half blocks count as open; it only steers the search)
	std::vector<float> goalDist;
	if (goal) {
		goalDist.assign((size_t)L.N, -1.f);
		typedef std::pair<float, int> QE;
		std::priority_queue<QE, std::vector<QE>, std::greater<QE>> q;
		for (int i = 0; i < L.N; i++) if (L.fg[i] == 121) { goalDist[i] = 0; q.push({ 0.f, i }); }
		if (q.empty()) { printf("{\"error\":\"the level has no finish block (the trophy, block 121)\"}\n"); return 3; }
		auto open = [&](int i) {
			const int id = L.fg[i];
			const u8 fl = (id >= 0 && id < L.nFlags) ? L.flags[id] : 0;
			return (fl & F_SOLID) == 0 || (fl & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) != 0;
		};
		while (!q.empty()) {
			QE e = q.top(); q.pop();
			if (e.first > goalDist[e.second] + 1e-4f) continue;
			const int x = e.second % L.W, y = e.second / L.W;
			for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const int nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= L.W || ny >= L.H) continue;
				const int j = ny * L.W + nx;
				if (!open(j)) continue;
				if (dx && dy && (!open(y * L.W + nx) || !open(ny * L.W + x))) continue;   // no corner cutting
				const float nd = e.first + (dx && dy ? 1.4142f : 1.f);
				if (goalDist[j] < 0 || nd < goalDist[j]) { goalDist[j] = nd; q.push({ nd, j }); }
			}
		}
	}
	if (gx.size() < 2 && !goal && refPath.empty()) { printf("{\"error\":\"give a guide line, a goal, or a reference run\"}\n"); return 3; }

	// ---- GPU
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::CUfunction fexp = g.fn("beamExpand_" + std::to_string(TW)), fmat = g.fn("beamMaterialize_" + std::to_string(TW));
	if (!fexp || !fmat) { printf("{\"error\":\"beam kernels missing\"}\n"); return 4; }
	cu::Buf dl, dA, dB, dout, dpick, dgx, dgy, dgs, dgoal, dK, dV, dq, drt, drx, dry, drsx, drsy;
	std::vector<float> fX(X.begin(), X.end()), fY(Y.begin(), Y.end()), fSX(SX.begin(), SX.end()), fSY(SY.begin(), SY.end());
	const size_t SB = sizeof(S);
	bool up = dl.upload(B.bytes.data(), B.bytes.size()) && dA.alloc(SB * K) && dB.alloc(SB * K) && dout.alloc(sizeof(BeamChild) * (size_t)K * 18) &&
		dpick.alloc(4 * (size_t)K) && dgx.upload(gx.data(), 4 * gx.size()) && dgy.upload(gy.data(), 4 * gy.size()) && dgs.upload(gs.data(), 4 * gs.size()) &&
		dgoal.upload(goalDist.data(), 4 * goalDist.size()) && dK.upload(htKeys.data(), 8 * htKeys.size()) && dV.upload(htVals.data(), 4 * htVals.size()) &&
		dq.upload(qbits.data(), 4 * qbits.size()) && drt.upload(refTile.data(), 4 * refTile.size()) &&
		drx.upload(fX.data(), 4 * fX.size()) && dry.upload(fY.data(), 4 * fY.size()) && drsx.upload(fSX.data(), 4 * fSX.size()) && drsy.upload(fSY.data(), 4 * fSY.size());
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::cuMemcpyHtoD_v2(dA.p, start, SB);
	BeamParams P;
	memset(&P, 0, sizeof P);
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.stateBytes = (i32)SB;
	P.gx = (const float*)(uintptr_t)dgx.p; P.gy = (const float*)(uintptr_t)dgy.p; P.gs = (const float*)(uintptr_t)dgs.p;
	P.nGuide = (i32)gx.size(); P.guideWeight = guideW;
	P.goalDist = (const float*)(uintptr_t)dgoal.p; P.goalWeight = goal ? goalW : 0.f;
	P.htKeys = (const u64*)(uintptr_t)dK.p; P.htVals = (const i32*)(uintptr_t)dV.p; P.htMask = htMask; P.qbits = (const u32*)(uintptr_t)dq.p;
	P.nocoins = nc;
	P.refTile = refTile.empty() ? nullptr : (const i32*)(uintptr_t)drt.p; P.refFrom = refFrom; P.lineLen = gs.empty() ? 0.f : gs.back();
	P.rX = (const float*)(uintptr_t)drx.p; P.rY = (const float*)(uintptr_t)dry.p; P.rSX = (const float*)(uintptr_t)drsx.p; P.rSY = (const float*)(uintptr_t)drsy.p;
	P.nRef = (i32)fX.size();
	P.out = (BeamChild*)(uintptr_t)dout.p;
	P.pick = (const u32*)(uintptr_t)dpick.p;

	std::vector<std::vector<uint32_t>> lineage;   // per layer: kept children as (parent << 5 | option)
	std::vector<BeamChild> kids;
	int nParents = 1;
	cu::CUdeviceptr cur = dA.p, nxt = dB.p;
	int bestSaving = 0, finishLayer = -1;
	uint64_t ticks = 0;
	double lastProgress = -10;
	float bestScore = -1e30f;
	// the inputs of a child of layer d (parent p, option o): walk the lineage back to the start state
	auto inputsOf = [&](int d, uint32_t p, int o) {
		std::string s(d + 1, '0');
		s[d] = (char)('0' + option(o));
		for (int k = d - 1; k >= 0; k--) { const uint32_t pk = lineage[k][p]; s[k] = (char)('0' + option((int)(pk & 31))); p = pk >> 5; }
		return s;
	};
	// re-check a result on the CPU from the start state
	auto verify = [&](const std::string& in, int j, bool finish) {
		S* st = (S*)malloc(SB);
		memcpy(st, start, SB);
		Sim<TW> sim(L, *st);
		const bool crown0 = st->has_silver_crown;
		bool ok = true;
		for (size_t k = 0; k < in.size(); k++) {
			Input x = maskInput(in[k] - '0');
			sim.tick(x);
			if (st->is_dead || st->broken || (!crown0 && st->has_silver_crown && k + 1 < in.size())) { ok = false; break; }
		}
		if (ok) ok = finish ? (!crown0 && st->has_silver_crown) : (sim.hash(nc) == refH[j] && sim.hash2(nc) == refH2[j]);
		free(st);
		return ok;
	};
	int d = 0;
	for (; d < depthLimit && elapsed() < seconds && nParents > 0; d++) {
		P.parents = (const u8*)(uintptr_t)cur; P.nParents = nParents; P.layerTick = from + d;
		void* a1[] = { &P };
		if (cu::cuLaunchKernel(fexp, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a1, nullptr) || cu::cuCtxSynchronize()) {
			printf("{\"error\":\"beam expand failed\"}\n"); return 5;
		}
		ticks += (uint64_t)nParents * 18;
		kids.resize((size_t)nParents * 18);
		cu::cuMemcpyDtoH_v2(kids.data(), dout.p, sizeof(BeamChild) * kids.size());
		// results
		for (const BeamChild& c : kids) {
			if (c.flags & 2) {
				const std::string in = inputsOf(d, c.parent, c.option);
				if (verify(in, n, true)) {
					const int total = from + (int)in.size();
					if (finishLayer < 0 || (int)in.size() < finishLayer) {
						finishLayer = (int)in.size();
						printf("{\"ev\":\"result\",\"kind\":\"finish\",\"from\":%d,\"ticks\":%zu,\"finishTick\":%d,\"saving\":%d,\"inputs\":\"%s\"}\n",
							from, in.size(), total, n > 0 ? n - total : 0, in.c_str());
						fflush(stdout);
					}
				}
			} else if (c.flags & 4) {
				const int saving = c.rejoin - (from + d + 1);
				if (saving > bestSaving) {
					const std::string in = inputsOf(d, c.parent, c.option);
					if (verify(in, c.rejoin, false)) {
						bestSaving = saving;
						printf("{\"ev\":\"result\",\"kind\":\"rejoin\",\"from\":%d,\"ticks\":%zu,\"j\":%d,\"saving\":%d,\"inputs\":\"%s\"}\n",
							from, in.size(), c.rejoin, saving, in.c_str());
						fflush(stdout);
					}
				}
			}
		}
		if (goal && finishLayer >= 0) { d++; break; }   // the editor: the first (= fastest) finish ends the search
		// selection: best score per state hash, then by score with a cap per spatial bucket
		std::vector<int> idx;
		idx.reserve(kids.size());
		{
			std::unordered_map<uint64_t, int> seen;
			seen.reserve(kids.size() * 2);
			for (int i = 0; i < (int)kids.size(); i++) {
				const BeamChild& c = kids[i];
				if (c.flags & (1 | 2 | 8)) continue;
				auto it = seen.find(c.hash);
				if (it == seen.end()) { seen.emplace(c.hash, (int)idx.size()); idx.push_back(i); }
				else if (kids[idx[it->second]].score < c.score) idx[it->second] = i;
			}
		}
		std::sort(idx.begin(), idx.end(), [&](int a, int b) { return kids[a].score > kids[b].score; });
		std::vector<uint32_t> pick;
		pick.reserve(K);
		{
			std::unordered_map<uint32_t, int> perBucket;
			std::vector<int> over;   // skipped by the cap, in score order
			for (int i : idx) {
				if ((int)pick.size() >= K) break;
				int& cnt = perBucket[kids[i].bucket];
				if (cnt >= bucketCap) { over.push_back(i); continue; }
				cnt++;
				pick.push_back((kids[i].parent << 5) | kids[i].option);
			}
			for (int i : over) {   // fill up past the cap rather than shrinking the beam
				if ((int)pick.size() >= K) break;
				pick.push_back((kids[i].parent << 5) | kids[i].option);
			}
		}
		if (!idx.empty()) bestScore = kids[idx[0]].score;
		lineage.push_back(pick);
		nParents = (int)pick.size();
		if (!nParents) { d++; break; }
		cu::cuMemcpyHtoD_v2(dpick.p, pick.data(), 4 * pick.size());
		P.nPick = nParents; P.next = (u8*)(uintptr_t)nxt;
		void* a2[] = { &P };
		if (cu::cuLaunchKernel(fmat, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a2, nullptr) || cu::cuCtxSynchronize()) {
			printf("{\"error\":\"beam materialize failed\"}\n"); return 5;
		}
		ticks += nParents;
		std::swap(cur, nxt);
		if (elapsed() - lastProgress > 1.0) {
			lastProgress = elapsed();
			printf("{\"ev\":\"progress\",\"layer\":%d,\"tick\":%d,\"states\":%d,\"bestScore\":%.1f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"bestSaving\":%d,\"finish\":%d}\n",
				d + 1, from + d + 1, nParents, bestScore, (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), bestSaving, finishLayer);
			fflush(stdout);
		}
	}
	printf("{\"ev\":\"done\",\"gpu\":%s,\"layers\":%d,\"seconds\":%.2f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"bestSaving\":%d,\"finish\":%d}\n",
		g.json().c_str(), d, elapsed(), (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), bestSaving, finishLayer);
	free(start);
	return 0;
}

static int cmdBeam(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: eegpu beam <level.bin> [--ref=run.eetas --from=T] [--guide=file] [--goal=1] [--width=K] [--depth=D] [--seconds=S]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runBeam<8>(argc, argv, B);
	case 32: return runBeam<32>(argc, argv, B);
	case 128: return runBeam<128>(argc, argv, B);
	case 512: return runBeam<512>(argc, argv, B);
	}
	printf("{\"error\":\"level state too large for the GPU engine\"}\n");
	return 3;
}
