// beamhost.h - `eegpu beam`: the guided beam search (beam.h) driven from the host. Included by eegpu.cpp.
//   eegpu beam <level.bin> [--ref=<run.eetas> --from=T] [--guide=<file: "x y" per line, px, box centre>]
//              [--goal=1] [--width=32768] [--depth=3000] [--seconds=60] [--nocoins=0|1] [--guideWeight=0.5]
//              [--goalWeight=16] [--bucket=24]
// Starts from the reference's state after T ticks (--ref), or from the level start (the editor). Prints JSON lines:
// progress, results (kind "rejoin": an exact rejoin with the reference at tick j, saving ticks; kind "finish": the
// level is finished), and done. Every result is re-checked on the CPU before it is printed. Inputs are printed as
// .eetas characters ('0' + mask). "ticks" counts the ticks simulated; "twins" the children not simulated because a
// lower option gives the same state (search.h canonOption).
#pragma once
#include <queue>
#include <unordered_map>


/** The goal distance field: the walking distance in tiles (8-way, no corner cutting) to a finish block (121) over tiles
 *  that are not static solid blocks (doors, one-ways and half blocks count as open) and do not kill (spikes, fire,
 *  toxic: the box centre can never be there, so "next to the trophy, under spikes" is not close). -1 = cut off.
 *  It only steers the search and names the closest attempt. False when the level has no finish block. */
static bool goalField(const Level& L, std::vector<float>& goalDist) {
	goalDist.assign((size_t)L.N, -1.f);
	typedef std::pair<float, int> QE;
	std::priority_queue<QE, std::vector<QE>, std::greater<QE>> q;
	for (int i = 0; i < L.N; i++) if (L.fg[i] == 121) { goalDist[i] = 0; q.push({ 0.f, i }); }
	if (q.empty()) return false;
	auto open = [&](int i) {
		const int id = L.fg[i];
		const bool known = id >= 0 && id < L.nFlags;
		const u8 fl = known ? L.flags[id] : 0;
		if (known && (L.gFlags[id] & 4) != 0) return false;   // kills
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
	return true;
}

/** The reach file (src/reach.js writeReachFile, 'RCH3') on the GPU: fills R (device pointers), keeps the buffers alive,
 *  and a host copy (H, host pointers: eegpu reachtest). Anything but RCH3 is refused: the app is newer than this tool. */
struct ReachGpu {
	std::vector<uint8_t> raw;
	cu::Buf dev;
	ReachField H;
	bool parse(const std::string& file, const Level& L, std::string& err) {
		raw = readFile(file.c_str());
		if (raw.size() < 4 || memcmp(raw.data(), "RCH3", 4) != 0) {
			err = std::string("the reach file is not RCH3 (") + (raw.size() >= 4 ? std::string((const char*)raw.data(), 4) : std::string("empty")) +
				"): the search tool is older (or newer) than the app: rebuild it (node tools/build-native.js)";
			return false;
		}
		if (raw.size() < 192) { err = "bad reach file (too short): " + file; return false; }
		int32_t in[15];
		memcpy(in, &raw[4], sizeof in);
		double d[6];
		memcpy(d, &raw[64], sizeof d);
		memset(&H, 0, sizeof H);
		H.W = in[1]; H.H = in[2]; H.mode = in[3]; H.Q = in[4]; H.prioShift = in[5]; H.deaths = in[6] & 1; H.ice = (in[6] >> 1) & 1;
		const int32_t nC = in[7], nX = in[8], nSeg = in[9], nFl = in[10];
		H.NFV = in[11]; H.NTH = in[12]; H.nFlags = nFl; H.nSeg = nSeg; H.nC = nC; H.nX = nX;
		H.G = d[0]; H.BD = d[1]; H.ICE_ND = d[2]; H.KT = d[3]; H.TOL = d[4]; H.MOD_STRONG = d[5];
		if (in[0] != 3 || H.W != L.W || H.H != L.H || H.Q < 0 || H.Q > 100 || nC < 0 || nX < 0 || nSeg < 1 || H.NFV < 2 || H.NTH < 2) { err = "the reach file does not match the level"; return false; }
		if (H.mode == 0 && nFl != L.nFlags) { err = "the reach file does not match the level (block table)"; return false; }
		const size_t N = (size_t)H.W * H.H, walk = H.mode == 1;
		size_t o = 192;
		auto take = [&](size_t bytes) { o = (o + 7) & ~(size_t)7; const size_t at = o; o += bytes; return at; };
		const size_t oCls = take(N), oSeg = take(N), oRowC = take(4 * N), oRowX = take(4 * N), oWalk = take(2 * N);
		size_t oR = 0, oF = 0, oL = 0, oC = 0, oX = 0;
		if (!walk) { oR = take(2 * N * (H.Q + 3)); oF = take(2 * N * 17); oL = take(2 * N * 17); oC = take(2 * (size_t)nC * 128); oX = take(2 * (size_t)nX * 128); }
		const size_t oPush = take(8 * (size_t)nSeg), oCap = take(8 * (size_t)nSeg), oMod = take(8 * (size_t)nFl), oFV = take(8 * (size_t)H.NFV), oFS = take(8 * (size_t)H.NFV),
			oTH = take(8 * (size_t)H.NTH), oSW = take(8 * (size_t)H.NTH);
		if (((o + 7) & ~(size_t)7) != raw.size()) { err = "the reach file does not match the level (size)"; return false; }
		const uint8_t* b = raw.data();
		H.cls = b + oCls; H.seg = b + oSeg; H.rowC = (const i32*)(b + oRowC); H.rowX = (const i32*)(b + oRowX); H.walk = (const u16*)(b + oWalk);
		if (!walk) { H.costR = (const u16*)(b + oR); H.costF = (const u16*)(b + oF); H.costL = (const u16*)(b + oL); H.costC = (const u16*)(b + oC); H.costX = (const u16*)(b + oX); }
		H.segPush = (const double*)(b + oPush); H.segCap = (const double*)(b + oCap); H.modMin = (const double*)(b + oMod);
		H.FV = (const double*)(b + oFV); H.FS = (const double*)(b + oFS); H.TH = (const double*)(b + oTH); H.SW = (const double*)(b + oSW);
		H.on = 1;
		return true;
	}
	/** the same field on the GPU: one buffer, the pointers rebased */
	bool upload(ReachField& R, std::string& err) {
		if (!dev.upload(raw.data(), raw.size())) { err = cu::lastError; return false; }
		R = H;
		const uint8_t* base = raw.data();
		auto rebase = [&](const void* p) -> const void* { return p ? (const void*)(uintptr_t)(dev.p + ((const uint8_t*)p - base)) : nullptr; };
		R.cls = (const u8*)rebase(H.cls); R.seg = (const u8*)rebase(H.seg); R.rowC = (const i32*)rebase(H.rowC); R.rowX = (const i32*)rebase(H.rowX);
		R.walk = (const u16*)rebase(H.walk); R.costR = (const u16*)rebase(H.costR); R.costF = (const u16*)rebase(H.costF); R.costL = (const u16*)rebase(H.costL);
		R.costC = (const u16*)rebase(H.costC); R.costX = (const u16*)rebase(H.costX); R.segPush = (const double*)rebase(H.segPush); R.segCap = (const double*)rebase(H.segCap);
		R.modMin = (const double*)rebase(H.modMin); R.FV = (const double*)rebase(H.FV); R.FS = (const double*)rebase(H.FS); R.TH = (const double*)rebase(H.TH);
		R.SW = (const double*)rebase(H.SW);
		return true;
	}
	bool load(const std::string& file, const Level& L, ReachField& R, std::string& err) { return parse(file, L, err) && upload(R, err); }
};

/** The closest attempt of a search: the state nearest the trophy so far (the reach field's cost in tiles; a state it
 *  cuts off counts 1e4 + its walking distance; without the field the walking distance), printed as
 *  {"ev":"closest","dist":tiles,["cut":1,]"tick":T,"inputs":...} when it improves, at most every 0.5 s (and at the end). */
struct Closest {
	float dist = 1e30f; int layer = -1; uint32_t pk = 0; bool pending = false; double printed = -10;
	/** after layer d's expand: the GPU's per-layer minimum (~0 = none) */
	void take(unsigned long long cl, int d) {
		if (cl == ~0ull) return;
		const float dd = scoreFromOrdered((u32)(cl >> 32));
		if (dd < dist - 1e-3f) { dist = dd; layer = d; pk = (u32)cl; pending = true; }
	}
	template <class F> void print(double now, bool force, const std::string& prefix, int from0, F inputsOf) {
		if (!pending || (!force && now - printed < 0.5)) return;
		const std::string in = prefix + inputsOf(layer, pk >> 5, (int)(pk & 31));
		// (dist >= 1e4: the physics model cuts off every state so far, and dist - 1e4 is the walking distance: "cut":1)
		printf("{\"ev\":\"closest\",\"dist\":%.3f,%s\"tick\":%d,\"inputs\":\"%s\"}\n", dist, dist >= 1e4f ? "\"cut\":1," : "", from0 + (int)in.size(), in.c_str());
		fflush(stdout);
		pending = false; printed = now;
	}
};

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
	std::string prefix;
	{
		const std::string pf = opt(argc, argv, "prefix", "");
		if (!pf.empty()) {
			std::vector<uint8_t> raw = readFile(pf.c_str());
			for (uint8_t c : raw) if (c >= 48 && c < 80) prefix.push_back((char)c);
			Sim<TW> ps(L, *start);
			for (char c : prefix) { Input in = maskInput((c - 48) & 31); ps.tick(in); if (start->is_dead) { printf("{\"error\":\"the prefix dies\"}\n"); return 3; } }
		}
	}
	const int from0 = from;
	from += (int)prefix.size();   // the layer ticks count from the end of the prefix
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
	if (gx.size() < 2 && n > 0) {
		double bestD = 1e30;
		const int rfMin = std::max(from, atoi(opt(argc, argv, "refFrom", "0").c_str()) - 30);   // --refFrom: follow the run from about this tick
		for (int t = rfMin; t <= n; t++) {
			const double dx = X[t] - start->px, dy = Y[t] - start->py, dd = dx * dx + dy * dy;
			if (dd < bestD) { bestD = dd; refFrom = t; }
		}
		refTile.assign((size_t)L.N, -1);
		for (int t = refFrom; t <= n; t++) {
			const int tx = (int)std::floor((X[t] + 8) / 16), ty = (int)std::floor((Y[t] + 8) / 16);
			if (tx >= 0 && ty >= 0 && tx < L.W && ty < L.H && refTile[(size_t)ty * L.W + tx] < 0) refTile[(size_t)ty * L.W + tx] = t;
		}
		printf("{\"ev\":\"rejoinMode\",\"startTick\":%d,\"runTickHere\":%d}\n", from, refFrom);
	}
	const int depthLimit = refFrom >= 0 ? std::min(depthMax, refFrom - from + 600) : depthMax;
	std::vector<float> goalDist;
	if (goal && !goalField(L, goalDist)) { printf("{\"error\":\"the level has no finish block (the trophy, block 121)\"}\n"); return 3; }
	(void)from0;
	if (gx.size() < 2 && !goal && refPath.empty()) { printf("{\"error\":\"give a guide line, a goal, or a reference run\"}\n"); return 3; }

	// ---- GPU
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	if (!layoutOrError(g, TW)) return 4;
	cu::CUfunction fexp = g.fn("beamExpand_" + std::to_string(TW)), fmat = g.fn("beamMaterialize_" + std::to_string(TW));
	cu::CUfunction fIns = g.fn("beamSelInsert"), fWin = g.fn("beamSelWinners"), fHist = g.fn("beamSelHist"), fPick = g.fn("beamSelPick"), fFill = g.fn("beamSelFill");
	if (!fexp || !fmat || !fIns || !fWin || !fHist || !fPick || !fFill) { printf("{\"error\":\"beam kernels missing\"}\n"); return 4; }
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
	// the selection's buffers
	const uint32_t maxKids = (uint32_t)K * 18;
	uint32_t hCap = 1024; while (hCap < 2 * maxKids) hCap <<= 1;
	const int NBINS = 4096;
	cu::Buf dhK, dhB, dslot, dwin, dmm, dhist, dbc, dnpick, dover, dnover, dres, dnres, dstats;
	const uint32_t resCap = 4096;
	up = dhK.alloc(8ull * hCap) && dhB.alloc(8ull * hCap) && dslot.alloc(4ull * maxKids) && dwin.alloc(maxKids) && dmm.alloc(8) &&
		dhist.alloc(4ull * NBINS) && dbc.alloc(4ull * 65536) && dnpick.alloc(4) && dover.alloc(4ull * maxKids) && dnover.alloc(4) && dres.alloc(4ull * resCap) && dnres.alloc(4) &&
		dstats.alloc(16);
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::cuMemsetD8_v2(dstats.p, 0, 16);
	BeamSel Q;
	memset(&Q, 0, sizeof Q);
	Q.kids = (const BeamChild*)(uintptr_t)dout.p; Q.hKeys = (u64*)(uintptr_t)dhK.p; Q.hBest = (u64*)(uintptr_t)dhB.p; Q.hMask = hCap - 1;
	Q.slot = (u32*)(uintptr_t)dslot.p; Q.win = (u8*)(uintptr_t)dwin.p; Q.mm = (u32*)(uintptr_t)dmm.p; Q.hist = (u32*)(uintptr_t)dhist.p; Q.nBins = NBINS;
	Q.bucketCnt = (u32*)(uintptr_t)dbc.p; Q.bucketCap = bucketCap; Q.pick = (u32*)(uintptr_t)dpick.p; Q.nPick = (u32*)(uintptr_t)dnpick.p; Q.K = (u32)K;
	cu::Buf dclose;
	if (!goalDist.empty() || !opt(argc, argv, "reach", "").empty()) {
		if (!dclose.alloc(8)) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	}
	Closest nearest;
	Q.over = (u32*)(uintptr_t)dover.p; Q.nOver = (u32*)(uintptr_t)dnover.p; Q.overCap = maxKids; Q.res = (u32*)(uintptr_t)dres.p; Q.nRes = (u32*)(uintptr_t)dnres.p; Q.resCap = resCap;
	BeamParams P;
	memset(&P, 0, sizeof P);
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.stateBytes = (i32)SB;
	P.gx = (const float*)(uintptr_t)dgx.p; P.gy = (const float*)(uintptr_t)dgy.p; P.gs = (const float*)(uintptr_t)dgs.p;
	P.nGuide = (i32)gx.size(); P.guideWeight = guideW;
	P.goalDist = goalDist.empty() ? nullptr : (const float*)(uintptr_t)dgoal.p; P.goalWeight = goal ? goalW : 0.f;
	P.htKeys = (const u64*)(uintptr_t)dK.p; P.htVals = (const i32*)(uintptr_t)dV.p; P.htMask = htMask; P.qbits = (const u32*)(uintptr_t)dq.p;
	P.nocoins = nc;
	P.refTile = refTile.empty() ? nullptr : (const i32*)(uintptr_t)drt.p; P.refFrom = refFrom; P.lineLen = gs.empty() ? 0.f : gs.back();
	P.rX = (const float*)(uintptr_t)drx.p; P.rY = (const float*)(uintptr_t)dry.p; P.rSX = (const float*)(uintptr_t)drsx.p; P.rSY = (const float*)(uintptr_t)drsy.p;
	P.nRef = (i32)fX.size();
	P.out = (BeamChild*)(uintptr_t)dout.p;
	P.pick = (const u32*)(uintptr_t)dpick.p;
	P.stats = (unsigned long long*)(uintptr_t)dstats.p;
	ReachGpu reachGpu;
	{
		const std::string rf = opt(argc, argv, "reach", "");
		std::string err;
		if (!rf.empty() && !reachGpu.load(rf, L, P.reach, err)) { printf("{\"error\":%s}\n", jsonStr(err).c_str()); return 3; }
	}
	if (!goalDist.empty() || P.reach.on) P.closest = (unsigned long long*)(uintptr_t)dclose.p;
	g.ready(tStart);   // (the kernels and the buffers are on the GPU: --seconds counts from here)

	std::vector<std::vector<uint32_t>> lineage;   // per layer: kept children as (parent << 5 | option)
	std::vector<BeamChild> kids;
	int nParents = 1;
	cu::CUdeviceptr cur = dA.p, nxt = dB.p;
	int bestSaving = 0, finishLayer = -1;
	uint64_t ticks = 0, matTicks = 0, twins = 0;   // expand ticks (from the kernel: twins of a lower option are skipped), materialize ticks
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
		memcpy(st, start, SB);   // (start already includes the prefix)
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
		if (P.closest) cu::cuMemsetD8_v2(dclose.p, 0xff, 8);
		void* a1[] = { &P };
		if (cu::cuLaunchKernel(fexp, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a1, nullptr) || cu::cuCtxSynchronize()) {
			printf("{\"error\":\"beam expand failed\"}\n"); return 5;
		}
		{
			unsigned long long st[2] = { 0, 0 };
			cu::cuMemcpyDtoH_v2(st, dstats.p, 16);
			ticks = st[0] + matTicks; twins = st[1];
		}
		if (P.closest) {
			unsigned long long cl = ~0ull;
			cu::cuMemcpyDtoH_v2(&cl, dclose.p, 8);
			nearest.take(cl, d);
			nearest.print(elapsed(), false, prefix, from0, inputsOf);
		}
		const uint32_t nKids = (uint32_t)nParents * 18;
		const unsigned kb = (nKids + 255) / 256;
		Q.nKids = (i32)nKids;
		cu::cuMemsetD8_v2(dhK.p, 0, 8ull * hCap); cu::cuMemsetD8_v2(dhB.p, 0, 8ull * hCap);
		cu::cuMemsetD8_v2(dnres.p, 0, 4); cu::cuMemsetD8_v2(dnpick.p, 0, 4); cu::cuMemsetD8_v2(dnover.p, 0, 4);
		cu::cuMemsetD8_v2(dbc.p, 0, 4ull * 65536); cu::cuMemsetD8_v2(dhist.p, 0, 4ull * NBINS);
		{ const uint32_t mm0[2] = { 0xffffffffu, 0u }; cu::cuMemcpyHtoD_v2(dmm.p, mm0, 8); }
		void* aq[] = { &Q };
		if (cu::cuLaunchKernel(fIns, kb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuLaunchKernel(fWin, kb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuCtxSynchronize()) {
			printf("{\"error\":\"beam select failed\"}\n"); return 5;
		}
		// results: only the flagged children come back to the host
		uint32_t nRes = 0;
		cu::cuMemcpyDtoH_v2(&nRes, dnres.p, 4);
		kids.clear();
		if (nRes) {
			nRes = std::min(nRes, resCap);
			std::vector<uint32_t> ri(nRes);
			cu::cuMemcpyDtoH_v2(ri.data(), dres.p, 4ull * nRes);
			for (uint32_t r : ri) { BeamChild c; cu::cuMemcpyDtoH_v2(&c, dout.p + sizeof(BeamChild) * r, sizeof c); kids.push_back(c); }
		}
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
					if (goal) break;   // the editor: the first verified finish of this tick is the fastest possible
				}
			} else if (c.flags & 4) {
				const int saving = c.rejoin - (from + d + 1);
				if (saving > bestSaving) {
					const std::string in = inputsOf(d, c.parent, c.option);
					if (verify(in, c.rejoin, false)) {
						bestSaving = saving;
						printf("{\"ev\":\"result\",\"kind\":\"rejoin\",\"from\":%d,\"ticks\":%zu,\"j\":%d,\"saving\":%d,\"inputs\":\"%s\"}\n",
							from0, prefix.size() + in.size(), c.rejoin, saving, (prefix + in).c_str());
						fflush(stdout);
					}
				}
			}
		}
		if (goal && finishLayer >= 0) { d++; break; }   // the editor: the first (= fastest) finish ends the search
		// selection on the GPU: the winners' score range, a histogram, the picks in rounds from the best bins down
		uint32_t mm[2];
		cu::cuMemcpyDtoH_v2(mm, dmm.p, 8);
		std::vector<uint32_t> pick;
		if (mm[0] <= mm[1]) {
			bestScore = scoreFromOrdered(mm[1]);
			Q.lo = mm[0]; Q.binW = (uint32_t)(((uint64_t)mm[1] - mm[0]) / NBINS + 1);
			if (cu::cuLaunchKernel(fHist, kb, 1, 1, 256, 1, 1, 0, nullptr, aq, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"beam histogram failed\"}\n"); return 5; }
			std::vector<uint32_t> hist(NBINS);
			cu::cuMemcpyDtoH_v2(hist.data(), dhist.p, 4ull * NBINS);
			const uint64_t roundMax = std::max<uint64_t>(256, (uint64_t)K / 16);
			uint32_t np = 0;
			for (int bHi = NBINS - 1; bHi >= 0 && np < (uint32_t)K;) {
				int bLo = bHi;
				uint64_t c = hist[bHi];
				while (bLo > 0 && c + hist[bLo - 1] <= roundMax) c += hist[--bLo];
				if (c) {
					void* ap[] = { &Q, &bLo, &bHi };
					if (cu::cuLaunchKernel(fPick, kb, 1, 1, 256, 1, 1, 0, nullptr, ap, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"beam pick failed\"}\n"); return 5; }
					cu::cuMemcpyDtoH_v2(&np, dnpick.p, 4);
					np = std::min(np, (uint32_t)K);
				}
				bHi = bLo - 1;
			}
			if (np < (uint32_t)K) {   // fill up past the cap (the best first) rather than shrinking the beam
				uint32_t no = 0;
				cu::cuMemcpyDtoH_v2(&no, dnover.p, 4);
				uint32_t need = std::min<uint32_t>(std::min(no, maxKids), (uint32_t)K - np);
				if (need) {
					void* af[] = { &Q, &np, &need };
					if (cu::cuLaunchKernel(fFill, (need + 255) / 256, 1, 1, 256, 1, 1, 0, nullptr, af, nullptr) || cu::cuCtxSynchronize()) { printf("{\"error\":\"beam fill failed\"}\n"); return 5; }
					np += need;
				}
			}
			pick.resize(np);
			if (np) cu::cuMemcpyDtoH_v2(pick.data(), dpick.p, 4ull * np);   // for the lineage (rebuilding the inputs)
		}
		lineage.push_back(pick);
		nParents = (int)pick.size();
		if (!nParents) { d++; break; }   // (the picks are already on the GPU)
		P.nPick = nParents; P.next = (u8*)(uintptr_t)nxt;
		void* a2[] = { &P };
		if (cu::cuLaunchKernel(fmat, (nParents + 127) / 128, 1, 1, 128, 1, 1, 0, nullptr, a2, nullptr) || cu::cuCtxSynchronize()) {
			printf("{\"error\":\"beam materialize failed\"}\n"); return 5;
		}
		matTicks += (uint64_t)nParents; ticks += (uint64_t)nParents;
		std::swap(cur, nxt);
		if (elapsed() - lastProgress > 1.0) {
			lastProgress = elapsed();
			printf("{\"ev\":\"progress\",\"layer\":%d,\"tick\":%d,\"states\":%d,\"bestScore\":%.1f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"twins\":%llu,\"bestSaving\":%d,\"finish\":%d}\n",
				d + 1, from + d + 1, nParents, bestScore, (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), (unsigned long long)twins, bestSaving, finishLayer);
			fflush(stdout);
		}
	}
	if (finishLayer < 0) nearest.print(elapsed(), true, prefix, from0, inputsOf);
	printf("{\"ev\":\"done\",\"gpu\":%s,\"layers\":%d,\"seconds\":%.2f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"bestSaving\":%d,\"finish\":%d,\"twins\":%llu}\n",
		g.json().c_str(), d, elapsed(), (unsigned long long)ticks, ticks / std::max(1e-9, elapsed()), bestSaving, finishLayer, (unsigned long long)twins);
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
