// exacthost.h - `eegpu exact` and `eegpu exacth`: THE EXACT LAYERED SEARCH on the GPU (native/exact.h has the search's
// rules and why they are exact) driven from the host. Included by eegpu.cpp.
//   eegpu exact <level.bin> --h=<h.bin> --C=<run ticks> [--ladder=1] [--seconds=600] [--deaths=1] [--htBits=28]
//               [--arena=<states>] [--stage=<states>] [--hostGB=64] [--hpipe=1] [--progress=1]
//     For a run-tick limit C: the exact minimum run ticks to the trophy and its inputs when some route takes <= C run
//     ticks, else a PROOF that none does (and lb = the next contour). --ladder=1: IDA* contours from the start's bound up to
//     C (each layer bound Cl one complete search; the first with a finish is the optimum, a closed one proves lb >= Cl).
//     --h: the bound tables (tools/perfect/gpuh.js). --hpipe=1: after a layer whose states met door states the tables do
//     not hold, prints {"ev":"sigs",...} and reads stdin lines until "go" ("add <file>": more order-tier fields, an 'EEHA'
//     file of gpuh.js): the driver tools/gpuproof/exact.js. Memory: the visited set 2^htBits slots of 16 bytes on the GPU;
//     a layer's states in two GPU arenas of --arena states, the rest in host RAM (--hostGB) through two staging buffers
//     of --stage states; the parent links of every layer (8 bytes a state) in host RAM.
//     Prints JSON lines: ready, start, layer (with --progress), sigs, found, C (one per layer bound: status closed |
//     found | time | mem | full | broken), done.
//   eegpu exacth <level.bin> --h=<h.bin> <run.eetas> [--cpu=1]
//     h (exact.h xhOf) after every tick of a run until its finish, on the GPU (--cpu=1: the host's copy of the same code):
//     {"h":[..],"g":[..]} (h -1 = Infinity; g: 0 no gate lookup, 1 known door state, 2 miss, 3 in a shut door).
#pragma once
#include <deque>
#include <set>
#include <memory>
#include <iostream>
#include "exact.h"

// ------------------------------------------------------------------ the bound tables ('EEH1' / 'EEHA', gpuh.js)
struct XhFile {
	std::vector<uint8_t> raw;
	size_t o = 0;
	bool bad = false;
	const uint8_t* take(size_t bytes) {
		o = (o + 7) & ~(size_t)7;
		if (o + bytes > raw.size()) { bad = true; return nullptr; }
		const uint8_t* p = raw.data() + o;
		o += bytes;
		return p;
	}
	int32_t i32at(size_t k) const { int32_t v; memcpy(&v, raw.data() + k, 4); return v; }
	double f64at(size_t k) const { double v; memcpy(&v, raw.data() + k, 8); return v; }
};

struct XhTables {
	std::vector<std::unique_ptr<XhFile>> files;   // the main file, then every add file (host pointers point into them)
	GpuH H;                                       // host pointers
	std::vector<std::vector<uint32_t>> sigs;      // the known door states (index = gate field)
	std::vector<HField> hostGate;                 // their fields (host pointers)
	std::vector<std::pair<const uint8_t*, std::unique_ptr<cu::Buf>>> dev;   // device copies of the files (base, buffer)
	std::vector<HField> devGate;
	cu::Buf dSigKeys, dSigField, dGateF, dMissBits, dMissList, dNMiss;
	std::vector<uint32_t> sigKeysH; std::vector<int32_t> sigFieldH;
	uint32_t sigMask = 0;
	static const uint32_t MISS_CAP = 4096, MISS_BITS_LOG2 = 20;
	std::string err;

	HField readField(XhFile& f) {
		HField F; memset(&F, 0, sizeof F);
		const size_t N = (size_t)H.N;
		F.f = (const float*)f.take(4 * N);
		if (H.useIso) F.iso = (const float*)f.take(4 * N);
		if (H.useAxis) { F.ax = (const float*)f.take(4 * N); F.ay = (const float*)f.take(4 * N); }
		if (H.usePlain) { F.axp = (const float*)f.take(4 * N); F.ayp = (const float*)f.take(4 * N); }
		return F;
	}
	bool load(const std::string& path, const Level& L) {
		std::unique_ptr<XhFile> f(new XhFile());
		f->raw = readFile(path.c_str());
		if (f->raw.size() < 296 || memcmp(f->raw.data(), "EEH1", 4) != 0 || f->i32at(4) != 2) { err = "not a bound table file (EEH1 v2): " + path; return false; }
		memset(&H, 0, sizeof H);
		int32_t in[24];
		for (int k = 0; k < 24; k++) in[k] = f->i32at(8 + 4 * k);
		H.W = in[0]; H.H = in[1]; H.N = in[2]; H.nF = in[3]; H.useIso = in[4]; H.useAxis = in[5]; H.usePlain = in[6]; H.gate = in[7];
		KinB& K = H.K;
		K.on = in[8]; H.nCls = in[9]; H.sigWords = in[10];
		const int nGate = in[11];
		K.nT = in[12]; K.tameLevel = in[13]; K.halves = in[14]; K.canDie = in[15]; K.hasRun = in[16]; K.hasFly = in[17]; K.hasJump = in[18];
		K.hasFlip = in[19];
		const int hasPortal = in[20];
		K.nF = in[21]; K.W = H.W; K.H = H.H;
		double d[24];
		for (int k = 0; k < 24; k++) d[k] = f->f64at(104 + 8 * k);
		H.vxp = d[0]; H.vxn = d[1]; H.vyp = d[2]; H.vyn = d[3]; H.pxp = d[4]; H.pxn = d[5]; H.pyp = d[6]; H.pyn = d[7]; H.deadRel = d[8]; H.hResp = d[9];
		K.wgm = d[10]; K.modY = d[11]; K.alignY = d[12]; K.mory0 = d[13]; K.gmaxG = d[14]; K.riseJv[0] = d[15]; K.riseJv[1] = d[16]; K.riseJv[2] = d[17];
		if (H.W != L.W || H.H != L.H || H.N != L.N) { err = "the bound tables are another level's"; return false; }
		if (H.sigWords < 1 || H.sigWords > XH_SIGW || H.nCls > 32 * H.sigWords) { err = "bad bound tables (door classes)"; return false; }
		if (K.on && K.nF != L.nFlags) { err = "the bound tables are another level's (block table)"; return false; }
		f->o = 296;
		H.mechId = f->take((size_t)H.nF + 1);
		H.mechT = f->take((size_t)H.N);
		H.clsVal = (const i32*)f->take(4 * (size_t)H.nCls); H.clsTile = (const i32*)f->take(4 * (size_t)H.nCls); H.clsKey = (const i32*)f->take(4 * (size_t)H.nCls);
		H.clsOfTile = (const i32*)f->take(4 * (size_t)H.N);
		H.rel = readField(*f);
		if (K.on) {
			const size_t PS = 4 * (size_t)(H.W + 1) * (H.H + 1);
			K.targets = (const double*)f->take(32 * (size_t)K.nT);
			K.tameId = f->take((size_t)K.nF);
			K.wildPS = (const i32*)f->take(PS); K.icePS = (const i32*)f->take(PS); K.boostPS = (const i32*)f->take(PS);
			K.gxPS = (const i32*)f->take(PS); K.gyPS = (const i32*)f->take(PS); K.jxPS = (const i32*)f->take(PS); K.jyPS = (const i32*)f->take(PS);
			if (hasPortal) { K.portal = f->take((size_t)H.N); K.trigQ = f->take((size_t)H.N); K.trigPS = (const i32*)f->take(PS); }
			K.rise = (const double*)f->take(8 * 3 * (size_t)(XK_RISE_N + 1));
		}
		for (int k = 0; k < nGate; k++) {
			const uint32_t* s = (const uint32_t*)f->take(4 * (size_t)H.sigWords);
			if (!s) break;
			sigs.push_back(std::vector<uint32_t>(s, s + H.sigWords));
			hostGate.push_back(readField(*f));
		}
		if (f->bad) { err = "bad bound tables (truncated): " + path; return false; }
		files.push_back(std::move(f));
		return true;
	}
	/** an 'EEHA' file: more order-tier fields (door states not known before; known ones are skipped) */
	int add(const std::string& path) {
		std::unique_ptr<XhFile> f(new XhFile());
		f->raw = readFile(path.c_str());
		if (f->raw.size() < 32 || memcmp(f->raw.data(), "EEHA", 4) != 0 || f->i32at(4) != 1 || f->i32at(8) != H.N || f->i32at(12) != H.sigWords) { err = "not an add file for these tables: " + path; return -1; }
		const int n = f->i32at(16);
		f->o = 32;
		int added = 0;
		for (int k = 0; k < n; k++) {
			const uint32_t* s = (const uint32_t*)f->take(4 * (size_t)H.sigWords);
			if (!s) break;
			std::vector<uint32_t> sg(s, s + H.sigWords);
			HField F = readField(*f);
			if (std::find(sigs.begin(), sigs.end(), sg) != sigs.end()) continue;
			sigs.push_back(sg); hostGate.push_back(F); added++;
		}
		if (f->bad) { err = "bad add file (truncated): " + path; return -1; }
		files.push_back(std::move(f));
		return added;
	}
	/** the open-addressing table of the known door states (host copy: sigKeysH / sigFieldH); H's pointers to it */
	void buildSigTable() {
		uint32_t cap = 64;
		while (cap < 2 * (uint32_t)sigs.size() + 2) cap <<= 1;
		sigMask = cap - 1;
		sigKeysH.assign((size_t)cap * H.sigWords, 0); sigFieldH.assign(cap, -1);
		for (size_t k = 0; k < sigs.size(); k++) {
			uint32_t slot = xhSigHash(sigs[k].data(), H.sigWords, 0) & sigMask;
			while (sigFieldH[slot] >= 0) slot = (slot + 1) & sigMask;
			sigFieldH[slot] = (int32_t)k;
			memcpy(&sigKeysH[(size_t)slot * H.sigWords], sigs[k].data(), 4 * (size_t)H.sigWords);
		}
		H.sigMask = sigMask; H.sigKeys = sigKeysH.data(); H.sigField = sigFieldH.data(); H.gateF = hostGate.data();
	}
	// ---- the device copy
	const uint8_t* devBase(const void* p, size_t& fileIx) const {
		for (size_t k = 0; k < files.size(); k++) {
			const uint8_t* b = files[k]->raw.data();
			if ((const uint8_t*)p >= b && (const uint8_t*)p < b + files[k]->raw.size()) { fileIx = k; return b; }
		}
		return nullptr;
	}
	template <class T> const T* rebase(const T* p) const {
		if (!p) return nullptr;
		size_t k = 0;
		const uint8_t* b = devBase(p, k);
		if (!b || k >= dev.size()) return nullptr;
		return (const T*)(uintptr_t)(dev[k].second->p + ((const uint8_t*)p - b));
	}
	HField rebaseField(const HField& F) const {
		HField R; R.f = rebase(F.f); R.iso = rebase(F.iso); R.ax = rebase(F.ax); R.ay = rebase(F.ay); R.axp = rebase(F.axp); R.ayp = rebase(F.ayp);
		return R;
	}
	/** uploads the files not on the GPU yet and the door-state table; D = H with device pointers */
	bool upload(GpuH& D) {
		while (dev.size() < files.size()) {
			std::unique_ptr<cu::Buf> b(new cu::Buf());
			if (!b->upload(files[dev.size()]->raw.data(), files[dev.size()]->raw.size())) { err = cu::lastError; return false; }
			dev.push_back(std::make_pair(files[dev.size()]->raw.data(), std::move(b)));
		}
		buildSigTable();
		devGate.clear();
		for (const HField& F : hostGate) devGate.push_back(rebaseField(F));
		dSigKeys.free(); dSigField.free(); dGateF.free();
		if (!dSigKeys.upload(sigKeysH.data(), 4 * sigKeysH.size()) || !dSigField.upload(sigFieldH.data(), 4 * sigFieldH.size()) ||
			!dGateF.upload(devGate.empty() ? (const void*)&H.rel : (const void*)devGate.data(), sizeof(HField) * std::max<size_t>(1, devGate.size()))) { err = cu::lastError; return false; }
		if (!dMissBits.p) {
			if (!dMissBits.alloc(((size_t)1 << MISS_BITS_LOG2) / 8) || !dMissList.alloc(4ull * MISS_CAP * H.sigWords) || !dNMiss.alloc(4)) { err = cu::lastError; return false; }
			cu::cuMemsetD8_v2(dMissBits.p, 0, ((size_t)1 << MISS_BITS_LOG2) / 8); cu::cuMemsetD8_v2(dNMiss.p, 0, 4);
		}
		D = H;
		D.mechId = rebase(H.mechId); D.mechT = rebase(H.mechT); D.clsVal = rebase(H.clsVal); D.clsTile = rebase(H.clsTile); D.clsKey = rebase(H.clsKey);
		D.clsOfTile = rebase(H.clsOfTile); D.rel = rebaseField(H.rel);
		{
			KinB& K = D.K; const KinB& Q = H.K;
			K.targets = rebase(Q.targets); K.tameId = rebase(Q.tameId); K.wildPS = rebase(Q.wildPS); K.icePS = rebase(Q.icePS);
			K.boostPS = rebase(Q.boostPS); K.gxPS = rebase(Q.gxPS); K.gyPS = rebase(Q.gyPS); K.jxPS = rebase(Q.jxPS); K.jyPS = rebase(Q.jyPS);
			K.portal = rebase(Q.portal); K.trigQ = rebase(Q.trigQ); K.trigPS = rebase(Q.trigPS); K.rise = rebase(Q.rise);
		}
		D.sigKeys = (const u32*)(uintptr_t)dSigKeys.p; D.sigField = (const i32*)(uintptr_t)dSigField.p; D.gateF = (const HField*)(uintptr_t)dGateF.p;
		D.missBits = (u32*)(uintptr_t)dMissBits.p; D.missBitMask = ((u32)1 << MISS_BITS_LOG2) - 1; D.missList = (u32*)(uintptr_t)dMissList.p;
		D.nMiss = (u32*)(uintptr_t)dNMiss.p; D.missCap = MISS_CAP;
		return true;
	}
	/** the misses of the last layer (each once), and the device's miss state cleared (a new salt) */
	std::vector<std::vector<uint32_t>> takeMisses(GpuH& D, uint32_t salt) {
		std::vector<std::vector<uint32_t>> out;
		uint32_t n = 0;
		cu::cuMemcpyDtoH_v2(&n, dNMiss.p, 4);
		if (n) {
			n = std::min(n, MISS_CAP);
			std::vector<uint32_t> w((size_t)n * H.sigWords);
			cu::cuMemcpyDtoH_v2(w.data(), dMissList.p, 4ull * w.size());
			for (uint32_t k = 0; k < n; k++) {
				std::vector<uint32_t> s(w.begin() + (size_t)k * H.sigWords, w.begin() + (size_t)(k + 1) * H.sigWords);
				if (std::find(out.begin(), out.end(), s) == out.end() && std::find(sigs.begin(), sigs.end(), s) == sigs.end()) out.push_back(s);
			}
			cu::cuMemsetD8_v2(dMissBits.p, 0, ((size_t)1 << MISS_BITS_LOG2) / 8); cu::cuMemsetD8_v2(dNMiss.p, 0, 4);
		}
		D.missSalt = salt;
		return out;
	}
};
static std::string sigHex(const std::vector<uint32_t>& s) {
	std::string o;
	char b[16];
	for (size_t k = 0; k < s.size(); k++) { snprintf(b, sizeof b, "%s%08x", k ? "." : "", s[k]); o += b; }
	return o;
}
/** the kernels' layout (exactSize_<tw>) against this tool's */
template <int TW>
static bool exactLayoutOk(Gpu& g) {
	cu::Buf out;
	if (!out.alloc(64)) return false;
	cu::CUfunction f = g.fn("exactSize_" + std::to_string(TW));
	if (!f) return false;
	void* args[] = { &out.p };
	lk::launch(f, 1, 1, args, "exactSize");
	int32_t sz[6] = { 0, 0, 0, 0, 0, 0 };
	cu::cuMemcpyDtoH_v2(sz, out.p, 24);
	return sz[0] == (int)sizeof(State<TW>) && sz[1] == (int)sizeof(Level) && sz[2] == (int)sizeof(GpuH) && sz[3] == (int)sizeof(ExactParams) && sz[4] == (int)sizeof(HField) && sz[5] == (int)sizeof(DfsParams);
}
static std::string ptxExactFor(int argc, char** argv, int tw) {
#ifdef _WIN32
	return opt(argc, argv, "ptxdir", exeDir().c_str()) + "\\eegpu_exact_" + std::to_string(tw) + ".ptx";
#else
	return opt(argc, argv, "ptxdir", exeDir().c_str()) + "/eegpu_exact_" + std::to_string(tw) + ".ptx";
#endif
}

// ------------------------------------------------------------------ a layer's states: [0, nG) on the GPU, the rest in host RAM
struct XStates {
	uint64_t n = 0, nG = 0;
	size_t SB = 0, block = 1 << 18;   // host blocks of `block` states
	std::vector<std::unique_ptr<uint8_t[]>> host;
	uint64_t nHost() const { return n - nG; }
	void clear() { n = 0; nG = 0; host.clear(); }
	/** appends k states (host bytes) to the host part */
	void appendHost(const uint8_t* src, uint64_t k) {
		while (k > 0) {
			const uint64_t at = n - nG, b = at / block, o = at % block;
			if (b >= host.size()) host.emplace_back(new uint8_t[block * SB]);
			const uint64_t m = std::min<uint64_t>(k, block - o);
			memcpy(host[b].get() + o * SB, src, m * SB);
			src += m * SB; n += m; k -= m;
		}
	}
	/** copies host-part states [a, a + k) (host-part indices) to dst */
	void readHost(uint64_t a, uint64_t k, uint8_t* dst) const {
		while (k > 0) {
			const uint64_t b = a / block, o = a % block, m = std::min<uint64_t>(k, block - o);
			memcpy(dst, host[b].get() + o * SB, m * SB);
			dst += m * SB; a += m; k -= m;
		}
	}
	double hostGB() const { return (double)host.size() * block * SB / 1e9; }
};

template <int TW>
static int runExact(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const size_t SB = sizeof(S);
	const int C = atoi(opt(argc, argv, "C", "-1").c_str());
	if (C < 0) { printf("{\"error\":\"--C=<run ticks> is required\"}\n"); return 2; }
	const bool ladder = opt(argc, argv, "ladder", "0") == "1";
	const double seconds = atof(opt(argc, argv, "seconds", "600").c_str());
	const int deaths = opt(argc, argv, "deaths", "1") == "0" ? 0 : 1;
	const int htBitsOpt = atoi(opt(argc, argv, "htBits", "0").c_str());
	const bool hpipe = opt(argc, argv, "hpipe", "0") == "1";
	const bool progress = opt(argc, argv, "progress", "1") == "1";
	const bool spill = opt(argc, argv, "spill", "0") == "1";   // a layer past the GPU arena into host RAM (else: the depth-first stage)
	const bool dfsOn = opt(argc, argv, "dfs", "1") != "0";
	const int ttMinLim = atoi(opt(argc, argv, "ttMinLim", "2").c_str());   // the depth-first stage keeps states with lim >= this in the table
	const int dfsAt = atoi(opt(argc, argv, "dfsAt", "-1").c_str());     // (tests) the depth-first stage from this breadth-first layer on
	const double hostGB = atof(opt(argc, argv, "hostGB", "24").c_str());
	const int fromLb = atoi(opt(argc, argv, "from", "-1").c_str());   // a proven lb (run ticks): every route takes >= that many
	const int maxIdle = 3000;
	auto tStart = Clock::now();
	auto elapsed = [&]() { return std::chrono::duration<double>(Clock::now() - tStart).count(); };
	Level L = B.level(B.bytes.data());
	XhTables X;
	if (!X.load(opt(argc, argv, "h", ""), L)) { printf("{\"error\":%s}\n", jsonStr(X.err).c_str()); return 3; }
	X.buildSigTable();
	// ---- the idle sources (levelproof.js sourcesOf: until the state hash repeats; the ball must not die or finish idling)
	std::vector<S> src;
	{
		S* st = (S*)calloc(1, SB);
		Sim<TW> sim(L, *st);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		src.push_back(*st);
		uint64_t hs = sim.hash(false);
		bool rests = false;
		for (int k = 0; k < maxIdle; k++) {
			Input in = maskInput(0);
			sim.tick(in);
			if (st->is_dead || st->has_silver_crown) { printf("{\"error\":\"the idle ball %s\"}\n", st->is_dead ? "dies" : "finishes"); return 3; }
			const uint64_t h2 = sim.hash(false);
			if (h2 == hs) { rests = true; break; }
			hs = h2;
			src.push_back(*st);
		}
		free(st);
		if (!rests) { printf("{\"error\":\"the idle ball does not rest within %d ticks\"}\n", maxIdle); return 3; }
	}
	// h at the sources (the host's copy of the GPU's h): the least = the first layer a finish can be at
	double h0 = 1e300;
	for (S& s0 : src) { S c = s0; Sim<TW> sm(L, c); const double v = xhOf<TW>(X.H, L, sm, 1 << 30, nullptr); if (v < h0) h0 = v; }
	if (!(h0 < 1e300)) {
		printf("{\"ev\":\"done\",\"verdict\":\"UNREACHABLE\",\"C\":%d,\"opt\":-1,\"lb\":-1,\"why\":\"the bound is infinite at every idle start\"}\n", C);
		return 0;
	}
	// ---- GPU
	Gpu g;
	if (!g.open(ptxExactFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	if (!exactLayoutOk<TW>(g)) { printf("{\"error\":\"the exact kernels do not match this tool (rebuild: tools/gpuproof/build-linux.sh)\"}\n"); return 4; }
	cu::CUfunction fexp = g.fn("exactExpand_" + std::to_string(TW)), fmat = g.fn("exactMaterialize_" + std::to_string(TW));
	cu::CUfunction fdfs = g.fn("exactDfs_" + std::to_string(TW)), fforget = g.fn("exactForget");
	if (!fexp || !fmat || !fdfs || !fforget) { printf("{\"error\":%s}\n", jsonStr("exact kernels missing: " + cu::lastError).c_str()); return 4; }
	ExactParams P;
	memset(&P, 0, sizeof P);
	cu::Buf dl;
	if (!dl.upload(B.bytes.data(), B.bytes.size())) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	if (!X.upload(P.G)) { printf("{\"error\":%s}\n", jsonStr(X.err).c_str()); return 4; }
	const size_t freeB = cu::freeNow();
	// the table: 20 bytes a slot (the two keys, the least layer); by default 30% of the free memory, at most 2^30 slots
	uint64_t slots = 1;
	if (htBitsOpt > 0) slots = 1ull << std::max(16, std::min(31, htBitsOpt));
	else { while (slots * 2 * 20 <= 0.3 * (double)freeB && slots < (1ull << 30)) slots <<= 1; }
	const uint64_t stage = std::max<uint64_t>(1024, (uint64_t)atof(opt(argc, argv, "stage", "1000000").c_str()));
	// (the arenas: what is left after the table, the picks, the spill's staging buffers and 1.5 GB of headroom)
	const double rest = (double)freeB - 20.0 * slots - (spill ? 2.0 * stage * SB : 0) - 8.0 * 18 * stage - 1.5e9;
	uint64_t arena = (uint64_t)atof(opt(argc, argv, "arena", "0").c_str());
	if (arena == 0) arena = rest > 0 ? (uint64_t)(rest / 2 / SB) : 0;
	if (arena < 16) { printf("{\"error\":\"not enough GPU memory: lower --htBits or --stage (free %.1f GB)\"}\n", freeB / 1e9); return 4; }
	cu::Buf dT, dLay, dA, dB2, dSP, dSC, dPick, dNPick, dFound, dNextF, dStats;
	bool up = dT.alloc(16ull * slots) && dLay.alloc(4ull * slots) && dA.alloc(SB * arena) && dB2.alloc(SB * arena) && dPick.alloc(8ull * 18 * stage) &&
		dNPick.alloc(4) && dFound.alloc(8) && dNextF.alloc(4) && dStats.alloc(8 * XS_NSTATS);
	if (up && spill) up = dSP.alloc(SB * stage) && dSC.alloc(SB * stage);
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	P.stateBytes = (i32)SB; P.deaths = deaths;
	P.table = (u64*)(uintptr_t)dT.p; P.tableMask = (u32)(slots - 1); P.probeMax = 128; P.layerOf = (u32*)(uintptr_t)dLay.p;
	P.picks = (u64*)(uintptr_t)dPick.p; P.nPick = (u32*)(uintptr_t)dNPick.p; P.pickCap = (u32)(18 * stage);
	P.found = (unsigned long long*)(uintptr_t)dFound.p; P.nextF = (u32*)(uintptr_t)dNextF.p; P.stats = (unsigned long long*)(uintptr_t)dStats.p;
	// the depth-first stage's small buffers
	cu::Buf dDepth, dTask, dTaskNext, dIdle, dStop, dFPath, dMeta;
	const uint32_t dfsWant = std::max<uint32_t>(1024, (uint32_t)atof(opt(argc, argv, "dfsThreads", std::to_string(g.d.sms * 1024).c_str()).c_str()));
	up = dDepth.alloc(4ull * dfsWant) && dTask.alloc(4ull * dfsWant) && dTaskNext.alloc(4) && dIdle.alloc(4) && dStop.alloc(4) && dFPath.alloc(4 * 4096);
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	g.ready(tStart);
	printf("{\"ev\":\"start\",\"C\":%d,\"sources\":%zu,\"h0\":%.0f,\"tw\":%d,\"stateBytes\":%zu,\"tableSlots\":%llu,\"arena\":%llu,\"spill\":%d,\"dfs\":%d,\"dfsThreads\":%u,\"gate\":%d,\"kin\":%d,\"doorClasses\":%d,\"doorStates\":%zu,\"gpu\":%s}\n",
		C, src.size(), h0, TW, SB, (unsigned long long)slots, (unsigned long long)arena, spill ? 1 : 0, dfsOn ? 1 : 0, dfsWant, X.H.gate, X.H.K.on, X.H.nCls, X.sigs.size(), g.json().c_str());
	fflush(stdout);

	unsigned long long tot[XS_NSTATS] = {};
	uint64_t totParents = 0, totMat = 0, totSigsAdded = 0;
	uint32_t salt = 1;
	std::set<std::vector<uint32_t>> reported;
	// the misses after a layer: printed once each; piped: the driver's fields for them before the next layer
	auto handleMisses = [&](int layer) {
		std::vector<std::vector<uint32_t>> m = X.takeMisses(P.G, salt++);
		std::vector<std::vector<uint32_t>> fresh;
		for (auto& s : m) if (!reported.count(s)) { reported.insert(s); fresh.push_back(s); }
		if (fresh.empty()) return;
		printf("{\"ev\":\"sigs\",\"layer\":%d,\"n\":%zu,\"sigs\":[", layer, fresh.size());
		for (size_t k = 0; k < fresh.size(); k++) printf("%s\"%s\"", k ? "," : "", sigHex(fresh[k]).c_str());
		printf("]}\n");
		fflush(stdout);
		if (!hpipe) return;
		std::string line;
		int added = 0;
		while (std::getline(std::cin, line)) {
			if (line == "go") break;
			if (line.rfind("add ", 0) == 0) {
				const int a = X.add(line.substr(4));
				if (a < 0) { printf("{\"ev\":\"warn\",\"why\":%s}\n", jsonStr(X.err).c_str()); fflush(stdout); }
				else added += a;
			}
		}
		if (added > 0) {
			if (!X.upload(P.G)) { printf("{\"error\":%s}\n", jsonStr(X.err).c_str()); exit(4); }
			P.G.missSalt = salt;
			totSigsAdded += added;
		}
	};
	// the route of a finish: the links back to a source (k idle ticks), then the options after; replayed on the CPU engine
	auto routeOf = [&](const std::vector<std::vector<uint64_t>>& links, int layer, uint64_t idx, const std::vector<int>& tail, std::string& in, int& runTicks) {
		std::vector<int> ms;
		for (int lay = layer; lay >= 1; lay--) { const uint64_t q = links[lay][idx]; ms.push_back(option((int)(q & 31))); idx = q >> 5; }
		std::reverse(ms.begin(), ms.end());
		for (int o : tail) ms.push_back(option(o));
		in.assign((size_t)idx, '0');
		for (int m : ms) in.push_back((char)('0' + m));
		S* stt = (S*)calloc(1, SB);
		Sim<TW> sim(L, *stt);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		int crownAt = -1;
		for (size_t t = 0; t < in.size(); t++) { Input x = maskInput(in[t] - '0'); sim.tick(x); if (stt->has_silver_crown) { crownAt = (int)t + 1; break; } }
		runTicks = stt->run_ticks;
		free(stt);
		return crownAt == (int)in.size();
	};

	// ---- the layer bounds (in layers: a finish at layer F is a route of F - 1 run ticks)
	const int ClMax = C + 1;
	int lbLayer = std::max(fromLb, (int)h0 - 1);   // no finish at a layer <= lbLayer (proven)
	int bestF = -1;                                // the best finish found (layers), its route
	std::string bestIn;
	int bestRun = -1;
	bool bestVerified = false;
	std::string verdict = "OPEN";
	int Cl = ladder ? std::min(ClMax, std::max(lbLayer + 1, 1)) : ClMax;
	lk::Chunk ckExp(4096, 128, 1u << 30, 128), ckMat(16384, 128, 1u << 30, 128);
	XStates cur, nxt;
	cur.SB = nxt.SB = SB;
	std::vector<uint8_t> hostBuf(spill ? SB * stage : 0);
	int lastCl = -1;
	bool stopAll = false;
	while (!stopAll) {
		const auto tc = Clock::now();
		lastCl = Cl;
		// a new search: the table cleared, the sources (layer 0) the frontier
		lk::memset8(dT.p, 0, 16ull * slots, "memset");
		lk::memset8(dLay.p, 0xff, 4ull * slots, "memset");
		cu::cuMemsetD8_v2(dFound.p, 0, 8);
		{ const uint32_t nf = 0xffffffffu; cu::cuMemcpyHtoD_v2(dNextF.p, &nf, 4); }
		cu::cuMemsetD8_v2(dStats.p, 0, 8 * XS_NSTATS);
		std::vector<std::vector<uint64_t>> links(1);
		cur.clear(); nxt.clear();
		cu::cuMemcpyHtoD_v2(dA.p, src.data(), SB * src.size());
		cur.n = cur.nG = src.size();
		cu::CUdeviceptr arCur = dA.p, arNxt = dB2.p;
		uint64_t states = src.size(), nodes0 = tot[0];
		std::string status = "closed", stage2 = "bfs";
		uint64_t foundPk = 0;
		int foundLayer = -1;
		std::vector<int> foundTail;
		int d = 0, dfsD = -1;
		uint64_t prevN = 0;
		for (; d < Cl; d++) {
			if (cur.n == 0) break;
			// the next layer would not fit in the GPU: the depth-first stage from this one
			if (!spill && dfsOn && d > 0 && ((prevN > 0 && (double)cur.n * ((double)cur.n / (double)prevN) * 1.1 > (double)arena) || d == dfsAt)) { dfsD = d; break; }
			P.layer = d; P.Cl = Cl;
			const auto tl = Clock::now();
			nxt.clear();
			std::vector<uint64_t> lk1;
			lk1.reserve(std::min<uint64_t>(cur.n * 2, arena));
			bool overflow = false;
			for (uint64_t a = 0; a < cur.n && foundPk == 0;) {
				// a chunk of parents: within the GPU part, or a host part's piece uploaded to the parents' staging buffer
				uint64_t b;
				if (a < cur.nG) { b = std::min<uint64_t>(cur.nG, a + stage); P.parents = (const u8*)(uintptr_t)(arCur + a * SB); }
				else {
					b = std::min<uint64_t>(cur.n, a + stage);
					cur.readHost(a - cur.nG, b - a, hostBuf.data());
					cu::cuMemcpyHtoD_v2(dSP.p, hostBuf.data(), SB * (b - a));
					P.parents = (const u8*)(uintptr_t)dSP.p;
				}
				P.base = (u32)a;
				// (the next arena's room: the expand writes its first new children there itself)
				const uint64_t room = nxt.n == nxt.nG ? arena - nxt.nG : 0;
				P.directCap = (u32)std::min<uint64_t>(room, 0xffffffffull);
				P.nextDirect = (u8*)(uintptr_t)(arNxt + nxt.nG * SB);
				cu::cuMemsetD8_v2(dNPick.p, 0, 4);
				void* a1[] = { &P };
				unsigned long long simSeen = 0;
				cu::cuMemcpyDtoH_v2(&simSeen, dStats.p, 8);
				lk::over(ckExp, b - a, 128, fexp, a1, "exact expand", [&](uint32_t lo, uint32_t hi) { P.lo = (u32)a + lo; P.hi = (u32)a + hi; },
					[&](lk::Chunk& c, double items, double ms) {
						unsigned long long sm = simSeen;
						cu::cuMemcpyDtoH_v2(&sm, dStats.p, 8);
						c.tookWorst(items, ms, (double)(sm - simSeen), items * 18.0);
						simSeen = sm;
					});
				totParents += b - a;
				uint32_t np = 0;
				cu::cuMemcpyDtoH_v2(&np, dNPick.p, 4);
				cu::cuMemcpyDtoH_v2(&foundPk, dFound.p, 8);
				if (foundPk) { foundLayer = d + 1; break; }
				if (np > P.pickCap) { status = "broken"; stopAll = true; break; }   // (never: a chunk is at most `stage` parents)
				if (np > room && !spill) { overflow = true; break; }
				// the new children's links (the states: written by the expand, the rest re-simulated into host RAM)
				const size_t l0 = lk1.size();
				lk1.resize(l0 + np);
				if (np) cu::cuMemcpyDtoH_v2(lk1.data() + l0, dPick.p, 8ull * np);
				P.mpicks = (const u64*)(uintptr_t)dPick.p;
				uint64_t k0 = std::min<uint64_t>(np, room);
				nxt.nG += k0; nxt.n += k0;
				while (k0 < np) {
					const uint64_t m = std::min<uint64_t>(np - k0, stage);
					P.next = (u8*)(uintptr_t)dSC.p; P.dstBase = (u32)k0;
					void* a2[] = { &P };
					lk::over(ckMat, m, 128, fmat, a2, "exact materialize", [&](uint32_t lo, uint32_t hi) { P.lo = (u32)k0 + lo; P.hi = (u32)k0 + hi; });
					cu::cuMemcpyDtoH_v2(hostBuf.data(), dSC.p, SB * m);
					nxt.appendHost(hostBuf.data(), m);
					totMat += m;
					k0 += m;
				}
				a = b;
				if (nxt.hostGB() + cur.hostGB() > hostGB) { status = "mem"; stopAll = true; break; }
				if (elapsed() > seconds) { status = "time"; stopAll = true; break; }
			}
			unsigned long long st[XS_NSTATS];
			cu::cuMemcpyDtoH_v2(st, dStats.p, 8 * XS_NSTATS);
			if (foundPk) { links.push_back(std::move(lk1)); break; }
			if (stopAll) break;
			if (overflow) {
				// (the layer did not fit: its table entries forgotten, the depth-first stage from layer d)
				if (!dfsOn) { status = "mem"; stopAll = true; break; }
				uint32_t maxL = (uint32_t)d;
				for (uint64_t a = 0; a < slots;) {
					const uint64_t bb = std::min<uint64_t>(slots, a + (1ull << 26));
					uint32_t lo = (uint32_t)a, hi = (uint32_t)bb;
					void* af[] = { &P.layerOf, &lo, &hi, &maxL };
					lk::launch(fforget, (unsigned)((bb - a + 255) / 256), 256, af, "exact forget");
					a = bb;
				}
				dfsD = d;
				break;
			}
			links.push_back(std::move(lk1));
			states += nxt.n;
			if (st[6] > 0) { status = "broken"; stopAll = true; break; }   // (a state the engine cannot hold exactly: no claim)
			if ((double)(st[5] + src.size()) > 0.9 * (double)slots) { status = "full"; stopAll = true; break; }
			if (progress) {
				printf("{\"ev\":\"layer\",\"Cl\":%d,\"layer\":%d,\"states\":%llu,\"gpu\":%llu,\"host\":%llu,\"sim\":%llu,\"new\":%llu,\"merged\":%llu,\"cut\":%llu,\"dead\":%llu,\"twins\":%llu,\"full\":%llu,\"gateHit\":%llu,\"gateMiss\":%llu,\"gateShut\":%llu,\"s\":%.2f,\"ls\":%.3f,\"maxLaunchMs\":%.1f}\n",
					Cl, d + 1, (unsigned long long)nxt.n, (unsigned long long)nxt.nG, (unsigned long long)nxt.nHost(), st[0], st[5], st[4], st[3], st[2], st[1], st[7], st[8], st[9], st[10],
					std::chrono::duration<double>(Clock::now() - tc).count(), std::chrono::duration<double>(Clock::now() - tl).count(), lk::G.maxMs);
				fflush(stdout);
			}
			if (X.H.gate) handleMisses(d + 1);
			prevN = cur.n;
			std::swap(cur, nxt);
			std::swap(arCur, arNxt);
		}
		// ---- THE DEPTH-FIRST STAGE: layer dfsD's states as the tasks, to the bound Cl
		if (dfsD >= 0 && !foundPk && !stopAll) {
			stage2 = "dfs";
			const int maxDepth = Cl - dfsD;
			uint32_t nThreads = (uint32_t)std::min<uint64_t>(dfsWant, (uint64_t)(arena / (uint64_t)maxDepth));
			if (nThreads >= 256) nThreads = nThreads / 128 * 128;
			if (nThreads < 1) { printf("{\"error\":\"no room for the depth-first stacks (--arena)\"}\n"); return 4; }
			dMeta.free();
			if (!dMeta.alloc(8ull * nThreads * maxDepth)) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
			DfsParams Q;
			memset(&Q, 0, sizeof Q);
			Q.L = P.L; Q.G = P.G; Q.tasks = (const u8*)(uintptr_t)arCur; Q.stateBytes = (i32)SB; Q.nTasks = (u32)cur.nG;
			Q.D = dfsD; Q.Cl = Cl; Q.deaths = deaths; Q.ttMinLim = ttMinLim;
			Q.table = P.table; Q.tableMask = P.tableMask; Q.probeMax = P.probeMax; Q.layerOf = P.layerOf;
			Q.stk = (u8*)(uintptr_t)arNxt; Q.meta = (u64*)(uintptr_t)dMeta.p; Q.maxDepth = maxDepth; Q.nThreads = nThreads;
			Q.depth = (i32*)(uintptr_t)dDepth.p; Q.task = (u32*)(uintptr_t)dTask.p; Q.taskNext = (u32*)(uintptr_t)dTaskNext.p;
			Q.found = P.found; Q.foundPath = (i32*)(uintptr_t)dFPath.p; Q.nextF = P.nextF; Q.stats = P.stats;
			Q.idle = (u32*)(uintptr_t)dIdle.p; Q.stop = (u32*)(uintptr_t)dStop.p;
			// the second table in the stack arena's spare memory (20 bytes a slot, a power of 2, from 2^20 slots)
			{
				const uint64_t stackB = (uint64_t)nThreads * maxDepth * SB;
				const uint64_t base = (stackB + 255) & ~(uint64_t)255;
				const uint64_t spare = arena * SB > base ? arena * SB - base : 0;
				uint64_t s2 = 0;
				if (opt(argc, argv, "table2", "1") != "0") { s2 = 1ull << 20; if (s2 * 20 > spare) s2 = 0; else while (s2 * 2 * 20 <= spare && s2 < (1ull << 31)) s2 <<= 1; }
				if (s2) {
					Q.table2 = (u64*)(uintptr_t)(arNxt + base); Q.tableMask2 = (u32)(s2 - 1); Q.layerOf2 = (u32*)(uintptr_t)(arNxt + base + 16 * s2);
					lk::memset8(arNxt + base, 0, 16 * s2, "memset");
					lk::memset8(arNxt + base + 16 * s2, 0xff, 4 * s2, "memset");
				}
				printf("{\"ev\":\"table2\",\"slots\":%llu}\n", (unsigned long long)s2);
			}
			lk::memset8(dDepth.p, 0xff, 4ull * nThreads, "memset");
			cu::cuMemsetD8_v2(dTaskNext.p, 0, 4); cu::cuMemsetD8_v2(dStop.p, 0, 4);
			if (cur.nHost() > 0) { printf("{\"error\":\"the depth-first stage takes a GPU-resident frontier only\"}\n"); return 4; }
			printf("{\"ev\":\"dfs\",\"Cl\":%d,\"D\":%d,\"tasks\":%llu,\"threads\":%u,\"maxDepth\":%d}\n", Cl, dfsD, (unsigned long long)cur.nG, nThreads, maxDepth);
			fflush(stdout);
			double budget = 64, lastP = elapsed();
			const double target = std::max(5.0, lk::G.targetMs);
			for (;;) {
				cu::cuMemsetD8_v2(dIdle.p, 0, 4);
				Q.budget = (u32)budget;
				void* aq[] = { &Q };
				const double ms = lk::launch(fdfs, (nThreads + 127) / 128, 128, aq, "exact dfs");
				budget = std::max(8.0, std::min(1e6, budget * std::max(0.1, std::min(2.0, 0.7 * target / std::max(0.05, ms)))));
				uint32_t idle = 0;
				cu::cuMemcpyDtoH_v2(&idle, dIdle.p, 4);
				cu::cuMemcpyDtoH_v2(&foundPk, dFound.p, 8);
				if (foundPk) {
					int32_t fp[4096];
					cu::cuMemcpyDtoH_v2(fp, dFPath.p, 4 * 4096);
					foundTail.assign(fp + 1, fp + 1 + fp[0]);
					foundLayer = dfsD + fp[0];
					break;
				}
				if (idle >= nThreads) break;
				if (elapsed() > seconds) { status = "time"; stopAll = true; break; }
				if (progress && elapsed() - lastP > 5) {
					lastP = elapsed();
					unsigned long long st[XS_NSTATS];
					cu::cuMemcpyDtoH_v2(st, dStats.p, 8 * XS_NSTATS);
					uint32_t tn = 0;
					cu::cuMemcpyDtoH_v2(&tn, dTaskNext.p, 4);
					printf("{\"ev\":\"dfsprogress\",\"Cl\":%d,\"tasksTaken\":%u,\"tasks\":%llu,\"sim\":%llu,\"new\":%llu,\"merged\":%llu,\"cut\":%llu,\"full\":%llu,\"s\":%.1f,\"budget\":%.0f,\"launchMs\":%.1f}\n",
						Cl, std::min<uint32_t>(tn, (uint32_t)cur.nG), (unsigned long long)cur.nG, st[0], st[5], st[4], st[3], st[7], std::chrono::duration<double>(Clock::now() - tc).count(), budget, ms);
					fflush(stdout);
				}
			}
		}
		unsigned long long st[XS_NSTATS];
		cu::cuMemcpyDtoH_v2(st, dStats.p, 8 * XS_NSTATS);
		for (int k = 0; k < XS_NSTATS; k++) tot[k] += st[k];
		if (st[6] > 0 && status == "closed") status = "broken";
		uint32_t nextF = 0xffffffffu;
		cu::cuMemcpyDtoH_v2(&nextF, dNextF.p, 4);
		const double secs = std::chrono::duration<double>(Clock::now() - tc).count();
		if (foundPk) {
			// the route: the frontier's links (the finisher's parent, or the depth-first task) and its options after
			const uint64_t pk = foundPk - 1;
			std::string in;
			int runTicks = -1;
			bool ok;
			if (foundTail.empty()) {
				std::vector<int> tail(1, (int)(pk & 31));
				ok = routeOf(links, foundLayer - 1, pk >> 5, tail, in, runTicks);
			} else ok = routeOf(links, dfsD, pk, foundTail, in, runTicks);
			// (breadth first, or one layer above a proven bound: the least layer; else a better one may be below it)
			const bool minimal = foundTail.empty() || foundLayer <= lbLayer + 1;
			printf("{\"ev\":\"found\",\"Cl\":%d,\"layer\":%d,\"opt\":%d,\"runTicks\":%d,\"verified\":%s,\"minimal\":%s,\"by\":\"%s\",\"inputs\":\"%s\"}\n",
				Cl, foundLayer, foundLayer - 1, runTicks, ok ? "true" : "false", minimal ? "true" : "false", stage2.c_str(), in.c_str());
			status = ok ? "found" : "replay-failed";
			if (ok && (bestF < 0 || foundLayer < bestF)) { bestF = foundLayer; bestIn = in; bestRun = runTicks; bestVerified = true; }
			if (!ok) stopAll = true;
			if (ok && minimal) { lbLayer = std::max(lbLayer, foundLayer - 1); }
		} else if (status == "closed") {
			// no finish at a layer <= Cl: every route takes >= Cl run ticks; IDA*: its finish is at a layer >= nextF
			lbLayer = std::max(lbLayer, Cl);
			if (nextF != 0xffffffffu) lbLayer = std::max(lbLayer, (int)nextF - 1);
		}
		const unsigned long long nodes = tot[0] - nodes0;
		printf("{\"ev\":\"C\",\"C\":%d,\"Cl\":%d,\"status\":\"%s\",\"stage\":\"%s\",\"D\":%d,\"lb\":%d,\"next\":%d,\"layers\":%d,\"states\":%llu,\"nodes\":%llu,\"new\":%llu,\"merged\":%llu,\"cut\":%llu,\"dead\":%llu,\"twins\":%llu,\"full\":%llu,\"gateMiss\":%llu,\"seconds\":%.2f,\"nodesPerSec\":%.0f}\n",
			Cl - 1, Cl, status.c_str(), stage2.c_str(), dfsD, lbLayer, nextF == 0xffffffffu ? -1 : (int)nextF, d, (unsigned long long)states, nodes, st[5], st[4], st[3], st[2], st[1], st[7], st[9], secs, nodes / std::max(1e-9, secs));
		fflush(stdout);
		if (stopAll) break;
		if (bestF > 0 && bestF <= lbLayer + 1) { verdict = "FOUND"; break; }   // (no finish below it: the optimum)
		if (status == "closed" && nextF == 0xffffffffu && bestF < 0) { verdict = "UNREACHABLE"; break; }
		if (bestF < 0 && lbLayer >= ClMax) { verdict = "NONE"; break; }      // (no route takes <= C run ticks)
		if (status != "closed" && status != "found") break;
		// the next bound: below the best finish (is there a faster one?), else up the contours
		if (bestF > 0) Cl = bestF - 1;
		else Cl = std::min(ClMax, std::max(Cl + 1, std::max(lbLayer + 1, (int)(nextF == 0xffffffffu ? ClMax : nextF))));
	}
	if (verdict == "OPEN" && bestF > 0) verdict = "FOUND-UNPROVEN";
	const int optRun = verdict == "FOUND" ? bestF - 1 : -1;
	printf("{\"ev\":\"done\",\"verdict\":\"%s\",\"C\":%d,\"opt\":%d,\"best\":%d,\"bestRunTicks\":%d,\"lb\":%d,\"lastCl\":%d,\"nodes\":%llu,\"parents\":%llu,\"materialized\":%llu,\"doorStatesAdded\":%llu,\"seconds\":%.2f,\"nodesPerSec\":%.0f,\"inputs\":\"%s\",\"gpu\":%s%s}\n",
		verdict.c_str(), C, optRun, bestF > 0 ? bestF - 1 : -1, bestRun, lbLayer, lastCl, tot[0], (unsigned long long)totParents, (unsigned long long)totMat, (unsigned long long)totSigsAdded,
		elapsed(), tot[0] / std::max(1e-9, elapsed()), bestIn.c_str(), g.json().c_str(), lk::doneFields().c_str());
	(void)bestVerified;
	return 0;
}

static int cmdExact(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: eegpu exact <level.bin> --h=<h.bin> --C=<run ticks> [--ladder=1] [--seconds=600] [--htBits=28] [--hpipe=1]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runExact<8>(argc, argv, B);
	case 32: return runExact<32>(argc, argv, B);
	case 128: return runExact<128>(argc, argv, B);
	case 512: return runExact<512>(argc, argv, B);
	}
	printf("{\"error\":\"level state too large for the GPU engine\"}\n");
	return 3;
}

template <int TW>
static int runExactH(int argc, char** argv, const LevelBlob& B, const std::vector<uint8_t>& masks) {
	typedef State<TW> S;
	const size_t SB = sizeof(S);
	Level L = B.level(B.bytes.data());
	XhTables X;
	if (!X.load(opt(argc, argv, "h", ""), L)) { printf("{\"error\":%s}\n", jsonStr(X.err).c_str()); return 3; }
	X.buildSigTable();
	std::vector<S> sts;
	{
		S* st = (S*)calloc(1, SB);
		Sim<TW> sim(L, *st);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		sts.push_back(*st);
		for (size_t t = 0; t < masks.size(); t++) {
			Input in = maskInput(masks[t]);
			sim.tick(in);
			sts.push_back(*st);
			if (st->has_silver_crown) break;
		}
		free(st);
	}
	const int n = (int)sts.size();
	const i32 lim = atoi(opt(argc, argv, "lim", "200").c_str());
	std::vector<double> h(n);
	std::vector<int32_t> gs(n);
	if (opt(argc, argv, "cpu", "0") == "1") {
		for (int i = 0; i < n; i++) { S c = sts[i]; Sim<TW> sm(L, c); i32 q = 0; h[i] = xhOf<TW>(X.H, L, sm, lim, &q); gs[i] = q; }
	} else {
		Gpu g;
		if (!g.open(ptxExactFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
		if (!exactLayoutOk<TW>(g)) { printf("{\"error\":\"the exact kernels do not match this tool\"}\n"); return 4; }
		cu::CUfunction f = g.fn("exactH_" + std::to_string(TW));
		cu::Buf dl, ds, dh, dg;
		GpuH D;
		if (!f || !dl.upload(B.bytes.data(), B.bytes.size()) || !ds.upload(sts.data(), SB * n) || !dh.alloc(8ull * n) || !dg.alloc(4ull * n) || !X.upload(D)) {
			printf("{\"error\":%s}\n", jsonStr(cu::lastError + X.err).c_str()); return 4;
		}
		D.missBits = nullptr;
		Level LD = B.level((const uint8_t*)(uintptr_t)dl.p);
		const u8* sp = (const u8*)(uintptr_t)ds.p;
		i32 sb = (i32)SB, nn = n;
		double* hp = (double*)(uintptr_t)dh.p;
		i32* gp = (i32*)(uintptr_t)dg.p;
		i32 limv = lim;
		void* args[] = { &D, &LD, &sp, &sb, &nn, &limv, &hp, &gp };
		lk::launch(f, (unsigned)((n + 127) / 128), 128, args, "exactH");
		cu::cuMemcpyDtoH_v2(h.data(), dh.p, 8ull * n);
		cu::cuMemcpyDtoH_v2(gs.data(), dg.p, 4ull * n);
	}
	printf("{\"n\":%d,\"h\":[", n);
	for (int i = 0; i < n; i++) printf("%s%.0f", i ? "," : "", xhIsInf(h[i]) ? -1.0 : h[i]);
	printf("],\"g\":[");
	for (int i = 0; i < n; i++) printf("%s%d", i ? "," : "", gs[i]);
	printf("]}\n");
	return 0;
}
static int cmdExactH(int argc, char** argv) {
	if (argc < 4) { fprintf(stderr, "usage: eegpu exacth <level.bin> <run.eetas> --h=<h.bin> [--cpu=1]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	std::vector<uint8_t> m = readMasks(argv[3]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runExactH<8>(argc, argv, B, m);
	case 32: return runExactH<32>(argc, argv, B, m);
	case 128: return runExactH<128>(argc, argv, B, m);
	case 512: return runExactH<512>(argc, argv, B, m);
	}
	printf("{\"error\":\"level state too large for the GPU engine\"}\n");
	return 3;
}
