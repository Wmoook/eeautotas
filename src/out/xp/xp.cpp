// xp.cpp - CPU prototype of the editor's "every move" exploration (native/explorehost.h + kernels.cu exploreExpand /
// the claim) with pluggable representative rules, for research (no GPU). Multi-threaded, deterministic.
//   xp <level.bin> <reach.bin> [--pass=2] [--salt=0] [--threads=6] [--depth=100000] [--maxStates=60000000]
//      [--rule=base|kfirst|kany|adapt|...] [--K=4] [--sub=4] [--route=<masks file>] [--prune=1] [--quiet=1]
// Baseline (--rule=base) reproduces the GPU explore's cells and priorities exactly (pass p = editor passCells(p)).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <vector>
#include <string>
#include <thread>
#include <atomic>
#include <chrono>
#include <algorithm>
#include <functional>
#include <mutex>
#include <unordered_set>
#include "eecore.h"
#include "search.h"
#include "beam.h"
#include "explore.h"
using namespace ee;

// ------------------------------------------------------------------ level blob (copied from native/eegpu.cpp)
static std::vector<uint8_t> readFile(const char* path) {
	FILE* f = fopen(path, "rb");
	if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(2); }
	std::vector<uint8_t> b;
	uint8_t buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof buf, f)) > 0) b.insert(b.end(), buf, buf + n);
	fclose(f);
	return b;
}
static const char* BLOB_INTS[] = { "W", "H", "N", "nFlags", "maxX", "maxY", "nPortals", "nExIds", "multiTargetPortals",
	"rngScriptLen", "nCoins", "coinWords", "nSecrets", "secretWords", "nPortalCoins", "pgWords", "nSpawns", "nSw", "swWords",
	"nOsw", "oswWords", "nKeyColors", "hasTimeDoors", "hasCoinGate", "hasBlueCoinGate", "hasDeathDoor", "hasDeathGate",
	"hasTeamEffect", "startMode", "idleTicks", "startSpawn", "hasStartSpawn", "goldBorder", "ticksPerFrame", "offCoin",
	"offSecret", "offPg", "offSw", "offOsw", "tailWords", "keyInts", "nExits" };
enum { A_fg, A_lookup0, A_flags, A_xflags, A_ovl, A_airMask, A_airPS, A_gMorx, A_gMory, A_gMox, A_gMoy, A_gFlags,
	A_portalSlot, A_pId, A_pTarget, A_pRot, A_exIds, A_exOff, A_exX, A_exY, A_exPc, A_rngScript, A_coinBit, A_coinTiles,
	A_coinBaseId, A_secretBit, A_portalCoinIdx, A_spawnsX, A_spawnsY, A_swIds, A_oswIds, A_keyColors, A_coinBits0, A_COUNT };
struct LevelBlob {
	std::vector<uint8_t> bytes;
	int32_t ints[64];
	uint32_t aoff[A_COUNT], acount[A_COUNT];
	double gravityMult;
	uint64_t rngSeed;
	int nInts;
	int32_t get(const char* name) const {
		for (int i = 0; i < nInts; i++) if (!strcmp(BLOB_INTS[i], name)) return ints[i];
		fprintf(stderr, "blob: no field %s\n", name); exit(2);
	}
	Level level(const uint8_t* base) const {
		Level L;
		memset(&L, 0, sizeof L);
#define I(f) L.f = get(#f);
		I(W) I(H) I(N) I(nFlags) I(maxX) I(maxY) I(nPortals) I(nExIds) I(multiTargetPortals) I(rngScriptLen)
		I(nCoins) I(coinWords) I(nSecrets) I(secretWords) I(nPortalCoins) I(pgWords) I(nSpawns) I(nSw) I(swWords)
		I(nOsw) I(oswWords) I(nKeyColors) I(hasTimeDoors) I(hasCoinGate) I(hasBlueCoinGate) I(hasDeathDoor)
		I(hasDeathGate) I(hasTeamEffect) I(startMode) I(idleTicks) I(startSpawn) I(hasStartSpawn) I(goldBorder)
		I(ticksPerFrame) I(offCoin) I(offSecret) I(offPg) I(offSw) I(offOsw) I(tailWords) I(keyInts)
#undef I
		L.gravityMult = gravityMult;
#define P(f, T) L.f = (const T*)(base + aoff[A_##f]);
		P(fg, i32) P(lookup0, i32) P(flags, u8) P(xflags, u8) P(ovl, u8) P(airMask, u16) P(airPS, i32)
		P(gMorx, i8) P(gMory, i8) P(gMox, double) P(gMoy, double) P(gFlags, u8) P(portalSlot, i32) P(pId, i32)
		P(pTarget, i32) P(pRot, i32) P(exIds, i32) P(exOff, i32) P(exX, i32) P(exY, i32) P(exPc, i32)
		P(rngScript, i32) P(coinBit, i32) P(coinTiles, i32) P(coinBaseId, i32) P(secretBit, i32)
		P(spawnsX, i32) P(spawnsY, i32) P(swIds, i32) P(oswIds, i32) P(keyColors, i32)
#undef P
		L.portalCoinIdx = acount[A_portalCoinIdx] ? (const i32*)(base + aoff[A_portalCoinIdx]) : nullptr;
		return L;
	}
	const u32* coinBits0(const uint8_t* base) const { return (const u32*)(base + aoff[A_coinBits0]); }
};
static LevelBlob readLevel(const char* path) {
	LevelBlob b;
	b.bytes = readFile(path);
	const uint8_t* p = b.bytes.data();
	uint32_t magic, version, nInts, nArr;
	memcpy(&magic, p, 4); memcpy(&version, p + 4, 4); memcpy(&nInts, p + 8, 4); memcpy(&nArr, p + 12, 4);
	if (magic != 0x324c4545u || version != 1) { fprintf(stderr, "%s: not a level blob (v1)\n", path); exit(2); }
	if (nInts != sizeof BLOB_INTS / sizeof BLOB_INTS[0] || nArr != A_COUNT) { fprintf(stderr, "level blob layout mismatch\n"); exit(2); }
	b.nInts = (int)nInts;
	memcpy(b.ints, p + 16, 4 * nInts);
	size_t q = 16 + 4 * nInts;
	memcpy(&b.gravityMult, p + q, 8); q += 8;
	memcpy(&b.rngSeed, p + q, 8); q += 8;
	for (uint32_t i = 0; i < nArr; i++) { memcpy(&b.aoff[i], p + q, 4); memcpy(&b.acount[i], p + q + 4, 4); q += 8; }
	return b;
}
static std::string opt(int argc, char** argv, const char* name, const char* dflt) {
	const size_t n = strlen(name);
	for (int i = 1; i < argc; i++) if (!strncmp(argv[i], "--", 2) && !strncmp(argv[i] + 2, name, n) && argv[i][2 + n] == '=') return argv[i] + 3 + n;
	for (int i = 1; i < argc; i++) if (!strncmp(argv[i], "--", 2) && !strcmp(argv[i] + 2, name)) return "1";
	return dflt;
}
// ------------------------------------------------------------------ the reach field on the host
struct ReachHost {
	std::vector<uint8_t> raw;
	bool load(const std::string& file, const Level& L, ReachField& R) {
		raw = readFile(file.c_str());
		if (raw.size() < 28 || memcmp(raw.data(), "RCH2", 4) != 0) return false;
		int32_t W, H, B, JB; float g;
		memcpy(&W, &raw[4], 4); memcpy(&H, &raw[8], 4); memcpy(&B, &raw[12], 4); memcpy(&JB, &raw[16], 4); memcpy(&g, &raw[20], 4);
		const size_t N = (size_t)W * H, pad = (N + 3) & ~(size_t)3;
		if (W != L.W || H != L.H) return false;
		const uint8_t* p = raw.data() + 28;
		R.cls = p; R.own = p + pad; R.refresh = p + 2 * pad; R.cost = (const float*)(p + 3 * pad);
		R.W = W; R.H = H; R.B = B; R.JB = JB; R.g = g; R.on = 1;
		return true;
	}
};

// ------------------------------------------------------------------ helpers
static double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
static void parallelFor(int threads, size_t n, size_t grain, const std::function<void(size_t, size_t, int)>& f) {
	std::atomic<size_t> next(0);
	auto work = [&](int tid) {
		for (;;) {
			const size_t a = next.fetch_add(grain);
			if (a >= n) break;
			f(a, std::min(n, a + grain), tid);
		}
	};
	if (threads <= 1 || n <= grain) { work(0); return; }
	std::vector<std::thread> ts;
	for (int t = 1; t < threads; t++) ts.emplace_back(work, t);
	work(0);
	for (auto& t : ts) t.join();
}

/** the per-shard cell table: open addressing on the cell key (0 = empty); per slot the layer that first saw it and a
 *  rep count; per slot K sub-keys (rules with several representatives) */
struct Shard {
	std::vector<u64> keys; std::vector<i32> layer; std::vector<u8> count; std::vector<u64> subs; std::vector<u32> widx;
	size_t used = 0; int K = 1;
	void init(size_t cap, int k) { K = k; keys.assign(cap, 0); layer.assign(cap, -1); count.assign(cap, 0); widx.assign(cap, 0); if (K > 1) subs.assign(cap * K, 0); used = 0; }
	size_t find(u64 key, bool& fresh) {
		if ((used + 1) * 2 > keys.size()) grow();
		size_t m = keys.size() - 1, s = (size_t)(splitmix(key) >> 20) & m;
		for (;;) {
			if (keys[s] == 0) { keys[s] = key; used++; fresh = true; return s; }
			if (keys[s] == key) { fresh = false; return s; }
			s = (s + 1) & m;
		}
	}
	void grow() {
		std::vector<u64> ok; std::vector<i32> ol; std::vector<u8> oc; std::vector<u64> os; std::vector<u32> ow;
		ok.swap(keys); ol.swap(layer); oc.swap(count); os.swap(subs); ow.swap(widx);
		const size_t cap = ok.size() * 2;
		keys.assign(cap, 0); layer.assign(cap, -1); count.assign(cap, 0); widx.assign(cap, 0); if (K > 1) subs.assign(cap * K, 0);
		const size_t m = cap - 1;
		for (size_t i = 0; i < ok.size(); i++) if (ok[i]) {
			size_t s = (size_t)(splitmix(ok[i]) >> 20) & m;
			while (keys[s]) s = (s + 1) & m;
			keys[s] = ok[i]; layer[s] = ol[i]; count[s] = oc[i]; widx[s] = ow[i];
			if (K > 1) for (int k = 0; k < K; k++) subs[s * K + k] = os[i * K + k];
		}
	}
};

struct XC { u64 cell, prio, sub; u32 idx; float px, vx, py, vy; };

template <int TW>
static int run(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const Level L = B.level(B.bytes.data());
	ReachField R; memset(&R, 0, sizeof R);
	ReachHost rh;
	if (!rh.load(argv[2], L, R)) { fprintf(stderr, "bad reach file\n"); return 3; }
	const int pass = atoi(opt(argc, argv, "pass", "2").c_str());
	// the editor's passCells(p)
	const double v = std::pow(2.0, std::max(0, pass));
	double cqx = 0.5 * std::pow(2.0, pass), cqv = 16 * v, qy = pass >= 2 ? 0 : std::pow(2.0, pass), qvy = pass >= 2 ? 0 : 16 * v;
	if (opt(argc, argv, "cqx", "").size()) cqx = atof(opt(argc, argv, "cqx", "").c_str());
	if (opt(argc, argv, "cqv", "").size()) cqv = atof(opt(argc, argv, "cqv", "").c_str());
	if (opt(argc, argv, "qy", "").size()) qy = atof(opt(argc, argv, "qy", "").c_str());
	if (opt(argc, argv, "qvy", "").size()) qvy = atof(opt(argc, argv, "qvy", "").c_str());
	const u64 salt = strtoull(opt(argc, argv, "salt", "0").c_str(), nullptr, 10);
	const int threads = atoi(opt(argc, argv, "threads", "6").c_str());
	const int depthMax = atoi(opt(argc, argv, "depth", "100000").c_str());
	const size_t maxStates = (size_t)atof(opt(argc, argv, "maxStates", "60000000").c_str());
	const size_t cap = (size_t)atof(opt(argc, argv, "cap", "2000000").c_str());
	const bool prune = opt(argc, argv, "prune", "1") == "1";
	const bool quiet = opt(argc, argv, "quiet", "0") == "1", verbose = opt(argc, argv, "verbose", "0") == "1";
	const std::string rule = opt(argc, argv, "rule", "base");
	const int K = std::max(1, atoi(opt(argc, argv, "K", "1").c_str()));
	const double sub = atof(opt(argc, argv, "sub", "4").c_str());       // sub-cell refinement for the diversity rules
	const double seconds = atof(opt(argc, argv, "seconds", "1e9").c_str());
	// adaptive precision: near a tile corner (see cornerNear), x cells cqx * afx and vx cells cqv * afv
	const double afx = atof(opt(argc, argv, "afx", "16").c_str()), afv = atof(opt(argc, argv, "afv", "16").c_str());
	const double adist = atof(opt(argc, argv, "adist", "4").c_str());
	const int ruleId = rule == "base" ? 0 : rule == "kfirst" ? 1 : rule == "kany" ? 2 : rule == "adapt" ? 3 : rule == "adaptk" ? 4 : rule == "ext" ? 5 : rule == "adaptext" ? 6 : rule == "kbox" ? 7 : rule == "klate" ? 8 : rule == "pareto" ? 9 : rule == "dom" ? 10 : rule == "dom2" ? 12 : -1;
	if (ruleId < 0) { fprintf(stderr, "unknown rule %s\n", rule.c_str()); return 2; }
	const int Kt = (ruleId == 2 || ruleId == 4 || ruleId == 8 || ruleId == 10 || ruleId == 12) ? K : ruleId == 7 ? std::max(K, 2) : 1;   // (table sub-key slots; kbox: the box; dom: the reps)
	// --shift=1: the cell grid is shifted by a fraction of a cell derived from the salt (other cell boundaries per try)
	const bool shiftOn = opt(argc, argv, "shift", "0") == "1";
	const double shiftX = shiftOn ? (double)(splitmix(strtoull(opt(argc, argv, "salt", "0").c_str(), nullptr, 10) * 7919 + 1) >> 11) / 9007199254740992.0 : 0.0;
	const double shiftV = shiftOn ? (double)(splitmix(strtoull(opt(argc, argv, "salt", "0").c_str(), nullptr, 10) * 7919 + 2) >> 11) / 9007199254740992.0 : 0.0;
	// --fcell=H,qf,qv: anisotropic cells on (px + H vx) to 1/qf px and vx to 1/qv (the strip a precise move needs)
	double fH = 0, fQf = 16, fQv = 16;
	sscanf(opt(argc, argv, "fcell", "0,16,16").c_str(), "%lf,%lf,%lf", &fH, &fQf, &fQv);
	const int timeKey = atoi(opt(argc, argv, "timeKey", "0").c_str());   // > 0: cells are shared only within windows of this many ticks
	const bool lexMode = opt(argc, argv, "lex", "0") == "1";   // ancestry priorities: a merge is won by the state whose ancestry won the earliest coin flip where the two histories part
	const bool onePerLayer = opt(argc, argv, "onePerLayer", "0") == "1";
	const bool vdomOnly = opt(argc, argv, "vdom", "0") == "1";
	const float domEx = (float)atof(opt(argc, argv, "domEx", "0").c_str()), domEv = (float)atof(opt(argc, argv, "domEv", "0").c_str());
	const float boxEx = (float)(1.0 / (cqx * atof(opt(argc, argv, "boxEps", "8").c_str()))), boxEv = (float)(1.0 / (cqv * atof(opt(argc, argv, "boxEps", "8").c_str())));
	// --ext=px,vx,...: the quantities whose extremes the ext rules keep; --H: the horizon of fx / fy; --extSide=1 min only, 2 max only
	int extDim[8], nExt = 0;
	{
		const std::string e = opt(argc, argv, "ext", "px,vx");
		for (size_t p = 0; p < e.size() && nExt < 8;) {
			size_t q = e.find(',', p); if (q == std::string::npos) q = e.size();
			const std::string w = e.substr(p, q - p);
			const int id = w == "px" ? 0 : w == "vx" ? 1 : w == "py" ? 2 : w == "vy" ? 3 : w == "fx" ? 4 : w == "fy" ? 5 : w == "fs" ? 6 : -1;
			if (id >= 0) extDim[nExt++] = id;
			p = q + 1;
		}
	}
	const float extH = (float)atof(opt(argc, argv, "H", "8").c_str());
	const int extSide = atoi(opt(argc, argv, "extSide", "0").c_str());
	const bool noBase = opt(argc, argv, "nobase", "0") == "1";
	const bool track = opt(argc, argv, "track", "0") == "1";
	int claimLo = 0, claimHi = -1;
	sscanf(opt(argc, argv, "claimRange", "0,-1").c_str(), "%d,%d", &claimLo, &claimHi);   // ext: only the extremes (not the lowest-priority state)

	// solid per tile (for the adaptive rule): a static solid block
	std::vector<u8> solid((size_t)L.N, 0);
	for (int i = 0; i < L.N; i++) { const int id = L.fg[i]; solid[i] = (id >= 0 && id < L.nFlags && (L.flags[id] & F_SOLID) && !(L.flags[id] & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF))) ? 1 : 0; }
	auto solidAt = [&](int tx, int ty) -> bool { if (tx < 0 || ty < 0 || tx >= L.W || ty >= L.H) return true; return solid[(size_t)ty * L.W + tx] != 0; };
	// cornerNear: the box [px, px + 16) has a vertical tile boundary X within adist px of its left or right edge, where
	// the two columns differ in solidity in a row the box touches or the rows just above / below it (a ledge, a ceiling
	// edge, a one-tile gap: where a sub-pixel decides between catching an edge or not)
	auto cornerNear = [&](double px, double py) -> bool {
		const int r0 = (int)std::floor(py / 16) - 1, r1 = (int)std::floor((py + 15.999) / 16) + 1;
		for (int e = 0; e < 2; e++) {
			const double edge = px + (e ? 16.0 : 0.0);
			const int X = (int)std::lround(edge / 16.0);
			if (std::fabs(edge - 16.0 * X) > adist) continue;
			for (int r = r0; r <= r1; r++) if (solidAt(X - 1, r) != solidAt(X, r)) return true;
		}
		return false;
	};

	// the cell key of a state (explore.h exploreCell + kernels.cu: snapped / small bits, the discrete hash); sx, sv =
	// the x / vx scale used
	// --zone=x0,y0,x1,y1 (tiles of the box centre) and / or --zoneRc=Z (reach cost <= Z): the adaptive rules refine there
	int zone[4] = { 0, 0, -1, -1 };
	sscanf(opt(argc, argv, "zone", "0,0,-1,-1").c_str(), "%d,%d,%d,%d", &zone[0], &zone[1], &zone[2], &zone[3]);
	const float zoneRc = (float)atof(opt(argc, argv, "zoneRc", "-1").c_str());
	const bool routeZone = opt(argc, argv, "routeZone", "0") == "1";   // (oracle test: refine the cells of states in the modes the known route visits)
	std::unordered_set<u64> routeModes;
	const int zoneTileDiv = atoi(opt(argc, argv, "zoneTileDiv", "1").c_str());   // the situation's tile x divided by this (0: any tile)
	auto modeOf = [&](const S& s) -> u64 { const i64 tx = zoneTileDiv > 0 ? (i64)std::floor((s.px + 8) / 16) / zoneTileDiv : 0; return splitmix(doubleToBits(s.py) ^ splitmix(doubleToBits(s.speed_y) ^ ((u64)s.on_ground << 40) ^ ((u64)s.jump_count << 44) ^ ((u64)tx << 48))); };
	const bool zoneMode = zone[2] >= zone[0] || zoneRc >= 0 || routeZone;
	auto inZone = [&](const S& s) -> bool {
		const int cx = (int)std::floor((s.px + 8) / 16), cy = (int)std::floor((s.py + 8) / 16);
		if (zone[2] >= zone[0] && cx >= zone[0] && cx <= zone[2] && cy >= zone[1] && cy <= zone[3]) return true;
		if (routeZone && routeModes.count(modeOf(s))) return true;
		if (zoneRc >= 0) { const float rc = reachAt(R, (float)s.px + 8.f, (float)s.py + 8.f, (float)s.speed_y, s.on_ground != 0); if (rc >= 0 && rc <= zoneRc) return true; }
		return false;
	};
	auto keyOf = [&](const S& s, Sim<TW>& sim, double& sx, double& sv, u32& small, u64& disc) -> u64 {
		const u32 snapped = (floor(s.px) == s.px ? 1u : 0u) | (floor(s.py) == s.py ? 2u : 0u) | (eq0(s.speed_x) ? 4u : 0u) | (eq0(s.speed_y) ? 8u : 0u);
		small = (u32)(s.on_ground ? 1 : 0) | ((u32)(s.jump_count & 7) << 1) | ((u32)(s.q0 & 0x7ff) << 4) | ((u32)(s.q1 & 0x7ff) << 15) | ((u32)(s.last_portal_set ? 1 : 0) << 26) | (snapped << 27);
		sx = cqx; sv = cqv;
		if ((ruleId == 3 || ruleId == 4 || ruleId == 6) && (zoneMode ? inZone(s) : cornerNear(s.px, s.py))) { sx = cqx * afx; sv = cqv * afv; }
		u64 key = fH > 0 ? exploreCell(s.px + fH * s.speed_x + shiftX / fQf, s.py, s.speed_x + shiftV / fQv, s.speed_y, small, false, qy, qvy, fQf, fQv)
			: exploreCell(s.px + shiftX / sx, s.py, s.speed_x + shiftV / sv, s.speed_y, small, false, qy, qvy, sx, sv);
		if (ruleId == 3 || ruleId == 4 || ruleId == 6) key = splitmix(key ^ (sx != cqx ? 0x5555ull : 0));
		disc = sim.hashDiscrete();
		return splitmix(key ^ disc);
	};
	S* start = (S*)calloc(1, sizeof(S));
	{ Sim<TW> sim(L, *start); sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed); }
	// the route to track (optional): its states per tick
	std::vector<S> route;
	{
		const std::string rf = opt(argc, argv, "route", "");
		if (!rf.empty()) {
			std::vector<uint8_t> raw = readFile(rf.c_str());
			S s = *start; route.push_back(s);
			for (uint8_t c : raw) { if (c < 48 || c >= 80) continue; Sim<TW> sim(L, s); Input in = maskInput((c - 48) & 31); const bool cr = s.has_silver_crown; sim.tick(in); route.push_back(s); if (!cr && s.has_silver_crown) break; }
			fprintf(stderr, "route: %zu ticks, finishes %d\n", route.size() - 1, (int)route.back().has_silver_crown);
			for (const S& rs : route) routeModes.insert(modeOf(rs));
		}
	}
	{
		// --zoneFiles=a,b,...: more input files whose states' situations are refined (routeZone), e.g. the closest
		// attempts of several earlier tries
		const std::string zf = opt(argc, argv, "zoneFiles", "");
		for (size_t p = 0; p < zf.size();) {
			size_t q = zf.find(',', p); if (q == std::string::npos) q = zf.size();
			const std::string f = zf.substr(p, q - p); p = q + 1;
			if (f.empty()) continue;
			std::vector<uint8_t> raw = readFile(f.c_str());
			S s = *start; routeModes.insert(modeOf(s));
			for (uint8_t c : raw) { if (c == 10) { s = *start; continue; } if (c < 48 || c >= 80) continue; Sim<TW> sim(L, s); Input in = maskInput((c - 48) & 31); sim.tick(in); routeModes.insert(modeOf(s)); }
		}
	}
	if (opt(argc, argv, "reachTrace", "0") == "1") {
		for (size_t t = 1; t < route.size(); t++) {
			const S& s = route[t];
			const float rc = reachAt(R, (float)s.px + 8.f, (float)s.py + 8.f, (float)s.speed_y, s.on_ground != 0);
			printf("%zu px %.3f py %.3f vx %.3f vy %.3f g %d rc %.3f%s\n", t, s.px, s.py, s.speed_x, s.speed_y, s.on_ground, rc, rc < 0 ? "  <-- PRUNED" : "");
		}
		return 0;
	}
	if (opt(argc, argv, "bench", "0") == "1") {
		double b0 = now();
		u64 r = 1; long n = 0;
		for (int rep = 0; rep < 2000; rep++) {
			S s = *start;
			for (int t = 0; t < 500; t++) { Sim<TW> sim(L, s); r = splitmix(r); Input in = maskInput(option((int)(r % 18))); sim.tick(in); n++; if (s.is_dead) break; }
		}
		double b1 = now();
		u64 hs = 0;
		{ S s = *start; Sim<TW> sim(L, s); for (int i = 0; i < 1000000; i++) hs += sim.hashDiscrete(); }
		double b2 = now();
		fprintf(stderr, "bench: %ld ticks in %.3f s = %.0f ticks/s; hashDiscrete %.0f ns\n", n, b1 - b0, n / (b1 - b0), (b2 - b1) * 1e3, (unsigned long long)hs);
		return 0;
	}
	const int nSh = 64;
	std::vector<Shard> shards(nSh);
	for (auto& sh : shards) sh.init(1 << 16, Kt);
	// the route's cells: who claims them, when (diagnostic)
	std::vector<u64> routeCell(route.size(), 0);
	struct Claim { int t, layer; float wpx, wvx; bool own; u32 idx; };
	std::vector<Claim> claims;
	std::mutex claimMu;
	for (size_t t = 1; t < route.size(); t++) {
		S s = route[t]; Sim<TW> sim(L, s);
		double sx, sv; u32 sm; u64 dc;
		routeCell[t] = (keyOf(s, sim, sx, sv, sm, dc) & ~0xfffull) | 1ull;
	}
	// --why=1: candidates near the route (same py / vy, |dpx| < --whyDist) dropped because their cell was claimed in an
	// earlier layer: (tick, claimed layer, px, vx, claimer's candidate index)
	const bool whyOn = opt(argc, argv, "why", "0") == "1";
	const float whyDist = (float)atof(opt(argc, argv, "whyDist", "1.0").c_str());
	struct Blocked { int t, layer; float px, vx; u32 widx; };
	std::vector<Blocked> blocked;
	std::unordered_set<u64> routeSet;
	for (size_t t = 1; t < routeCell.size(); t++) routeSet.insert(routeCell[t]);
	auto routeTicksOf = [&](u64 cell, std::vector<int>& out) { out.clear(); for (size_t t = 1; t < routeCell.size(); t++) if (routeCell[t] == cell) out.push_back((int)t); };

	// --from=T: start from the route's state at tick T (a smaller test bed: the search must do the rest)
	const int from = atoi(opt(argc, argv, "from", "0").c_str());
	double watch[5] = { 0, 0, 0, 0, -1 };
	sscanf(opt(argc, argv, "watch", "0,0,0,0,-1").c_str(), "%lf,%lf,%lf,%lf,%lf", &watch[0], &watch[1], &watch[2], &watch[3], &watch[4]);
	if (from > 0) { if (from >= (int)route.size()) { fprintf(stderr, "--from needs --route\n"); return 2; } *start = route[from]; }
	const int batchS = std::max(1, atoi(opt(argc, argv, "batch", "1").c_str()));   // --batch=S: S independent tries (salts salt..salt+S-1) in one run
	std::vector<S> cur((size_t)batchS, *start), nxt;
	std::vector<u16> curTry((size_t)batchS), nxtTry;
	for (int t = 0; t < batchS; t++) curTry[t] = (u16)t;
	std::vector<u64> curPrio(1, splitmix(salt + 0x5bd1e995ull)), nxtPrio;   // (--lex=1: each state's priority, its ancestry's random bits, oldest first)
	std::vector<std::vector<u32>> lineage;
	std::vector<XC> cand;
	std::vector<u8> candOk;
	std::atomic<unsigned long long> ticks(0), twins(0);
	size_t totalStates = 1, maxLayer = 1;
	int finishLayer = -1, finishTry = -1; std::string finishInputs;
	double t0 = now();
	float bestRc = 1e30f; int bestRcLayer = -1; std::string bestRcInputs;
	int routeLost = -1;
	std::string why = "depth";
	auto inputsOf = [&](int d, u32 p, int o) {
		std::string s(d + 1, '0');
		s[d] = (char)('0' + option(o));
		for (int k = d - 1; k >= 0; k--) { const u32 pk = lineage[k][p]; s[k] = (char)('0' + option((int)(pk & 31))); p = pk >> 5; }
		return s;
	};
	// --frontier=<out>: the near misses of this search: per tile not reached that the reach field calls reachable
	// (a frontier tile) next to reached ones, the state that came nearest to its centre from each reached neighbour;
	// their inputs (one line each) go to <out> (a zone for --zoneFiles)
	const std::string frontierOut = opt(argc, argv, "frontier", "");
	static const int NBX[8] = { -1, 0, 1, -1, 1, -1, 0, 1 }, NBY[8] = { -1, -1, -1, 0, 0, 1, 1, 1 };
	struct NearRec { float d = 1e30f; int layer = -1; u32 idx = 0; };
	std::vector<NearRec> nearRec(frontierOut.empty() ? 0 : (size_t)L.N * 8);
	std::vector<u8> tileSeen(frontierOut.empty() ? 0 : (size_t)L.N, 0);
	double phT[4] = { 0, 0, 0, 0 };
	int d = 0;
	for (; d < depthMax; d++) {
		const size_t nP = cur.size();
		if (!nP) { why = "exhausted"; break; }
		if (now() - t0 > seconds) { why = "time"; break; }
		cand.resize(nP * 18); candOk.assign(nP * 18, 0);
		std::vector<std::vector<u32>> finishes(threads);
		std::vector<float> tBest(threads, 1e30f); std::vector<u32> tBestIdx(threads, 0);
		const double ph0 = now();
		parallelFor(threads, nP, 64, [&](size_t a, size_t b, int tid) {
			unsigned long long nSim = 0, nTw = 0;
			for (size_t pi = a; pi < b; pi++) {
				const S* par = &cur[pi];
				const u64 parentHash = splitmix(doubleToBits(par->px) ^ splitmix(doubleToBits(par->py) ^ splitmix(doubleToBits(par->speed_x) ^ splitmix(doubleToBits(par->speed_y) ^ (u64)par->q0 ^ ((u64)par->q1 << 16) ^ ((u64)par->jump_count << 32)))));
				u32 used = 31, jumpUsed = 0;
				for (int o = 0; o < 18; o++) {
					if (o > 0 && canonOption(o, used, jumpUsed) != o) { nTw++; continue; }
					S s = *par;
					Sim<TW> sim(L, s);
					Input in = maskInput(option(o));
					sim.tick(in);
					nSim++;
					if (o == 0) used = sim.inUsed();
					if (!(o & 1)) jumpUsed |= (sim.inUsed() & 1u) << (o >> 1);
					if (s.broken || s.is_dead) continue;
					const float rc = reachAt(R, (float)s.px + 8.f, (float)s.py + 8.f, (float)s.speed_y, s.on_ground != 0);
					const bool fin = s.has_silver_crown && !par->has_silver_crown;
					if (prune && rc < 0.f && !fin) continue;
					if (fin) { finishes[tid].push_back((u32)(pi * 18 + o)); continue; }
					if (rc >= 0.f && rc < tBest[tid]) { tBest[tid] = rc; tBestIdx[tid] = (u32)(pi * 18 + o); }
					const float rcq = rc < 0.f ? 4095.f : fminf(rc * 8.f, 4095.f);
					double sx, sv; u32 small; u64 disc;
					const u64 key0 = timeKey > 0 ? splitmix(keyOf(s, sim, sx, sv, small, disc) ^ (0x51ed270b27f4e5a1ull * (u64)(1 + (d + 1) / timeKey))) : keyOf(s, sim, sx, sv, small, disc);
					const u64 key = batchS > 1 ? splitmix((key0 & ~0xfffull) ^ (0x2545f4914f6cdd1dull * (u64)(curTry[pi] + 1))) : key0;   // (--batch: the tries never share a cell)
					u64 content = splitmix(doubleToBits(s.px) ^ splitmix(doubleToBits(s.py) ^ splitmix(doubleToBits(s.speed_x) ^ splitmix(doubleToBits(s.speed_y) ^ (u64)small ^ disc))));
					{ const u64 saltT = salt + (batchS > 1 ? (u64)curTry[pi] : 0); if (saltT) content = splitmix(content ^ saltT); }
					const u64 head = (u64)(u32)rcq;
					XC& c = cand[pi * 18 + o];
					c.cell = (key & ~0xfffull) | 1ull;
					c.prio = lexMode ? ((curPrio[pi] << 1) | (splitmix(salt * 0x9e3779b97f4a7c15ull ^ parentHash ^ ((u64)o << 58) ^ 0x1234567ull) & 1ull)) : ((head << 51) | ((content & 0x7ffffull) << 32) | ((parentHash & 0x7ffffffull) << 5) | (u64)o);
					c.idx = (u32)(pi * 18 + o);
					c.px = (float)s.px; c.vx = (float)s.speed_x; c.py = (float)s.py; c.vy = (float)s.speed_y;
					// the sub-cell (diversity rules): x and vx sub-times finer
					c.sub = splitmix((u64)(i64)floor(s.px * sx * sub) * 0x9e3779b97f4a7c15ull ^ (u64)(i64)floor(s.speed_x * sv * sub)) | 1ull;
					candOk[pi * 18 + o] = 1;
					if (getenv("XP_DBG") && d == 61 && (key & ~0xfffull) == 0x5f5c59abbe7cd000ull) printf("DBG o%d key %016llx px %.17g vx %.17g rcq %f prio %016llx\n", o, (unsigned long long)key, s.px, s.speed_x, rcq, (unsigned long long)c.prio);
				}
			}
			ticks += nSim; twins += nTw;
		});
		const double ph1 = now(); phT[0] += ph1 - ph0;
		for (int t = 0; t < threads; t++) if (tBest[t] < bestRc) { bestRc = tBest[t]; bestRcLayer = d; bestRcInputs = inputsOf(d, tBestIdx[t] / 18, (int)(tBestIdx[t] % 18)); }
		{
			std::vector<u32> fin;
			for (auto& f : finishes) fin.insert(fin.end(), f.begin(), f.end());
			if (!fin.empty()) {
				std::sort(fin.begin(), fin.end());
				finishLayer = d;
				finishInputs = inputsOf(d, fin[0] / 18, (int)(fin[0] % 18));
				finishTry = batchS > 1 ? (int)curTry[fin[0] / 18] : 0;
				why = "finish";
				d++;
				break;
			}
		}
		// the claim, per shard (a cell's shard: its key's top bits); the candidates bucketed by shard first
		const size_t CH = 1 << 16, nCh = (cand.size() + CH - 1) / CH;
		std::vector<std::vector<std::vector<u32>>> buck(nCh, std::vector<std::vector<u32>>(nSh));
		parallelFor(threads, nCh, 1, [&](size_t a, size_t b, int) {
			for (size_t ch = a; ch < b; ch++)
				for (size_t i = ch * CH; i < std::min(cand.size(), (ch + 1) * CH); i++) if (candOk[i]) buck[ch][cand[i].cell >> 58].push_back((u32)i);
		});
		const double ph2 = now(); phT[1] += ph2 - ph1;
		std::vector<std::vector<std::pair<u64, u32>>> win(nSh);   // (prio, idx) of the winners
		parallelFor(threads, nSh, 1, [&](size_t a, size_t b, int) {
			for (size_t sh = a; sh < b; sh++) {
				Shard& T = shards[sh];
				{	// (grow first: slots must stay put during the scan)
					size_t n = 0;
					for (size_t ch = 0; ch < nCh; ch++) n += buck[ch][sh].size();
					while ((T.used + n + 1) * 2 > T.keys.size()) T.grow();
				}
				std::vector<std::pair<size_t, size_t>> loc;   // (slot, cand index) of the candidates in open cells
				for (size_t ch = 0; ch < nCh; ch++) for (u32 i : buck[ch][sh]) {
					const XC& c = cand[i];
					bool fresh = false;
					const size_t s = T.find(c.cell, fresh);
					if (fresh) T.layer[s] = d;
					if (ruleId == 7 || ruleId == 10 || ruleId == 12) {
						if (T.count[s] >= K) continue;
						loc.push_back({ s, i });
					} else if (ruleId == 2 || ruleId == 4 || ruleId == 8) {
						// kany: open while it holds fewer than K states (each with a sub-cell of its own)
						if (T.count[s] >= K) continue;
						bool dup = false;
						for (int k = 0; k < T.count[s]; k++) if (T.subs[s * K + k] == c.sub) { dup = true; break; }
						if (dup) continue;
						loc.push_back({ s, i });
					} else {
						if (T.layer[s] != d) {   // seen in an earlier layer
							if (whyOn && from + d + 1 < (int)route.size()) {
								const S& rs = route[from + d + 1];
								if (c.py == (float)rs.py && c.vy == (float)rs.speed_y && std::fabs(c.px - (float)rs.px) < whyDist) { std::lock_guard<std::mutex> lk(claimMu); blocked.push_back({ from + d + 1, T.layer[s], c.px, c.vx, T.widx[s] }); }
							}
							continue;
						}
						loc.push_back({ s, i });
					}
				}
				std::sort(loc.begin(), loc.end(), [&](const std::pair<size_t, size_t>& x, const std::pair<size_t, size_t>& y) {
					if (x.first != y.first) return x.first < y.first;
					return cand[x.second].prio < cand[y.second].prio;
				});
				for (size_t i = 0; i < loc.size();) {
					size_t j = i;
					while (j < loc.size() && loc[j].first == loc[i].first) j++;
					const size_t s = loc[i].first;
					if (ruleId == 0 || ruleId == 3) {
						win[sh].push_back({ cand[loc[i].second].prio, cand[loc[i].second].idx }); T.widx[s] = cand[loc[i].second].idx;
						if (!routeSet.empty() && routeSet.count(T.keys[s])) {
							const XC& c = cand[loc[i].second];
							std::vector<int> ts; routeTicksOf(T.keys[s], ts);
							std::lock_guard<std::mutex> lk(claimMu);
							for (int t : ts) claims.push_back({ t, from + d, c.px, c.vx, t == from + d + 1 && (float)route[t].px == c.px && (float)route[t].speed_x == c.vx, c.idx });
						}
					} else if (ruleId == 9) {
						// pareto: the cell's first layer keeps its lowest-priority state and the Pareto fronts of
						// (px, vx) in both directions (most advanced and fastest to the right, and to the left), each
						// front at most K states (its two ends and evenly spaced ones between)
						std::vector<size_t> chosen(1, i);
						for (int dir = 0; dir < 2; dir++) {
							const float sg = dir ? -1.f : 1.f;
							std::vector<size_t> ord;
							for (size_t q = i; q < j; q++) ord.push_back(q);
							std::sort(ord.begin(), ord.end(), [&](size_t a, size_t b) {
								const XC& ca = cand[loc[a].second]; const XC& cb = cand[loc[b].second];
								if (ca.px != cb.px) return sg * ca.px > sg * cb.px;
								return sg * ca.vx > sg * cb.vx;
							});
							std::vector<size_t> front;
							float best = -1e30f;
							for (size_t q : ord) { const float v = sg * cand[loc[q].second].vx; if (v > best) { best = v; front.push_back(q); } }
							if ((int)front.size() > K && K <= 1) front.resize(1);
							else if ((int)front.size() > K) {
								std::vector<size_t> f2;
								for (int k = 0; k < K; k++) f2.push_back(front[(size_t)((double)k * (front.size() - 1) / (K - 1) + 0.5)]);
								front.swap(f2);
							}
							for (size_t q : front) if (std::find(chosen.begin(), chosen.end(), q) == chosen.end()) chosen.push_back(q);
						}
						for (size_t q : chosen) win[sh].push_back({ cand[loc[q].second].prio, cand[loc[q].second].idx });
					} else if (ruleId == 5 || ruleId == 6) {
						// ext: the cell's first layer keeps its lowest-priority state and the extremes (min and max) of
						// each listed quantity among its candidates (px, vx, py, vy, fx = px + H vx, fy = py + H vy)
						std::vector<size_t> chosen;
						if (!noBase) chosen.push_back(i);
						for (int e = 0; e < nExt; e++) {
							size_t lo = i, hi = i; float vlo = 1e30f, vhi = -1e30f;
							for (size_t q = i; q < j; q++) {
								const XC& c = cand[loc[q].second];
								const float v = extDim[e] == 0 ? c.px : extDim[e] == 1 ? c.vx : extDim[e] == 2 ? c.py : extDim[e] == 3 ? c.vy : extDim[e] == 4 ? c.px + extH * c.vx : extDim[e] == 5 ? c.py + extH * c.vy : (c.vx > 0 ? 1.f : c.vx < 0 ? -1.f : 0.f) * (c.px + extH * c.vx);
								if (v < vlo) { vlo = v; lo = q; }
								if (v > vhi) { vhi = v; hi = q; }
							}
							if (extSide != 2 && std::find(chosen.begin(), chosen.end(), lo) == chosen.end()) chosen.push_back(lo);
							if (extSide != 1 && std::find(chosen.begin(), chosen.end(), hi) == chosen.end()) chosen.push_back(hi);
						}
						for (size_t q : chosen) win[sh].push_back({ cand[loc[q].second].prio, cand[loc[q].second].idx });
					} else if (ruleId == 12) {
						// dom2: a cell keeps up to K states; a state is dropped only when the cell already holds (from an
						// earlier layer or earlier in this one) a state at least as far right and as fast to the right
						// AND one at least as far left and as fast to the left (tolerance domEx / domEv): the two
						// Pareto staircases of (px, vx), whatever direction the future takes
						for (size_t q = i; q < j && T.count[s] < K; q++) {
							const XC& c = cand[loc[q].second];
							bool domR = false, domL = false;
							for (int k = 0; k < T.count[s] && !(domR && domL); k++) {
								float rv[2]; memcpy(rv, &T.subs[s * Kt + k], 8);
								if (rv[0] >= c.px - domEx && rv[1] >= c.vx - domEv) domR = true;
								if (rv[0] <= c.px + domEx && rv[1] <= c.vx + domEv) domL = true;
							}
							if (domR && domL) continue;
							float rv[2] = { c.px, c.vx };
							memcpy(&T.subs[s * Kt + T.count[s]], rv, 8);
							T.count[s]++;
							win[sh].push_back({ c.prio, c.idx });
						}
					} else if (ruleId == 10) {
						// dom: a cell keeps up to K states that no earlier-or-same-layer state of the cell dominates: r
						// dominates c when r is at least as far along and at least as fast in c's direction of motion
						// (sigma = sign of c's vx; a state at rest is dominated only by an equal one). The first state
						// of a new cell is its lowest-priority one; the rest in priority order.
						for (size_t q = i; q < j && T.count[s] < K; q++) {
							const XC& c = cand[loc[q].second];
							const float sg = c.vx > 0 ? 1.f : c.vx < 0 ? -1.f : 0.f;
							bool dom = false;
							for (int k = 0; k < T.count[s] && !dom; k++) {
								float rv[2]; memcpy(rv, &T.subs[s * Kt + k], 8);
								if (sg == 0.f) dom = rv[0] == c.px && rv[1] == c.vx;
								else if (vdomOnly) dom = sg * rv[1] >= sg * c.vx - domEv;   // (vdom: speed alone)
								else dom = sg * rv[0] >= sg * c.px - domEx && sg * rv[1] >= sg * c.vx - domEv;
							}
							if (dom) continue;
							float rv[2] = { c.px, c.vx };
							memcpy(&T.subs[s * Kt + T.count[s]], rv, 8);
							T.count[s]++;
							win[sh].push_back({ c.prio, c.idx });
						}
					} else if (ruleId == 7) {
						// kbox: the first state of a cell, then (any later layer too) a state outside the box (px, vx) of
						// the cell's states so far by more than eps, until the cell holds K
						for (size_t q = i; q < j && T.count[s] < K; q++) {
							const XC& c = cand[loc[q].second];
							float bx[4];
							if (T.count[s] == 0) { bx[0] = bx[1] = c.px; bx[2] = bx[3] = c.vx; }
							else {
								memcpy(bx, &T.subs[s * Kt], 16);
								if (!(c.px < bx[0] - boxEx || c.px > bx[1] + boxEx || c.vx < bx[2] - boxEv || c.vx > bx[3] + boxEv)) continue;
								bx[0] = std::min(bx[0], c.px); bx[1] = std::max(bx[1], c.px); bx[2] = std::min(bx[2], c.vx); bx[3] = std::max(bx[3], c.vx);
							}
							memcpy(&T.subs[s * Kt], bx, 16);
							T.count[s]++;
							win[sh].push_back({ c.prio, c.idx });
						}
					} else if (ruleId == 1) {
						// kfirst: up to K of the cell's first layer, distinct sub-cells, by priority
						std::vector<u64> taken;
						for (size_t q = i; q < j && (int)taken.size() < K; q++) {
							const XC& c = cand[loc[q].second];
							if (std::find(taken.begin(), taken.end(), c.sub) != taken.end()) continue;
							taken.push_back(c.sub);
							win[sh].push_back({ c.prio, c.idx });
						}
					} else {
						const bool freshCell = T.count[s] == 0;   // (klate: a cell new in this layer takes one state only)
						int admitted = 0;   // (--onePerLayer=1: a cell takes at most one state per layer: fine blocking across layers, coarse merging within one)
						for (size_t q = i; q < j && T.count[s] < K && !(ruleId == 8 && freshCell && T.count[s] >= 1) && !(onePerLayer && admitted >= 1); q++) {
							const XC& c = cand[loc[q].second];
							bool dup = false;
							for (int k = 0; k < T.count[s]; k++) if (T.subs[s * K + k] == c.sub) { dup = true; break; }
							if (dup) continue;
							T.subs[s * K + T.count[s]] = c.sub; T.count[s]++; admitted++;
							win[sh].push_back({ c.prio, c.idx });
						}
					}
					i = j;
				}
			}
		});
		const double ph3 = now(); phT[2] += ph3 - ph2;
		std::vector<std::pair<u64, u32>> all;
		for (auto& w : win) all.insert(all.end(), w.begin(), w.end());
		size_t over = 0;
		if (all.size() > cap) { std::nth_element(all.begin(), all.begin() + cap, all.end()); over = all.size() - cap; all.resize(cap); }
		std::vector<u32> pick(all.size());
		for (size_t i = 0; i < all.size(); i++) pick[i] = all[i].second;
		std::sort(pick.begin(), pick.end());
		nxt.resize(pick.size());
		parallelFor(threads, pick.size(), 256, [&](size_t a, size_t b, int) {
			for (size_t i = a; i < b; i++) { S s = cur[pick[i] / 18]; Sim<TW> sim(L, s); Input in = maskInput(option((int)(pick[i] % 18))); sim.tick(in); nxt[i] = s; }
		});
		phT[3] += now() - ph3;
		if (lexMode) { nxtPrio.resize(pick.size()); for (size_t i = 0; i < pick.size(); i++) nxtPrio[i] = cand[pick[i]].prio; std::swap(curPrio, nxtPrio); }
		if (batchS > 1) { nxtTry.resize(pick.size()); for (size_t i = 0; i < pick.size(); i++) nxtTry[i] = curTry[pick[i] / 18]; std::swap(curTry, nxtTry); }
		std::vector<u32> lin(pick.size());
		for (size_t i = 0; i < pick.size(); i++) lin[i] = ((pick[i] / 18) << 5) | (pick[i] % 18);
		lineage.push_back(std::move(lin));
		std::swap(cur, nxt);
		if (getenv("XP_DUMP") && d + 1 == atoi(getenv("XP_DUMP"))) {
			FILE* df = fopen("dump_xp.txt", "w");
			for (size_t i = 0; i < cur.size(); i++) fprintf(df, "%.17g %.17g %.17g %.17g %d %d %u\n", cur[i].px, cur[i].py, cur[i].speed_x, cur[i].speed_y, cur[i].on_ground, cur[i].jump_count, lineage.back()[i]);
			fclose(df);
		}
		totalStates += cur.size();
		maxLayer = std::max(maxLayer, cur.size());
		if (!frontierOut.empty()) {
			// per tile and direction (8 neighbours): the state of this search that came nearest (box centre) to that
			// neighbour tile's centre, and whether the tile was reached at all
			for (size_t i = 0; i < cur.size(); i++) {
				const S& s = cur[i];
				const double cxp = s.px + 8, cyp = s.py + 8;
				const int tx = (int)std::floor(cxp / 16), ty = (int)std::floor(cyp / 16);
				if (tx < 0 || ty < 0 || tx >= L.W || ty >= L.H) continue;
				const size_t ti = (size_t)ty * L.W + tx;
				tileSeen[ti] = 1;
				for (int k = 0; k < 8; k++) {
					const int nx = tx + NBX[k], ny = ty + NBY[k];
					const double ex = nx * 16 + 8 - cxp, ey = ny * 16 + 8 - cyp;
					const float dd = (float)(ex * ex + ey * ey);
					NearRec& r = nearRec[ti * 8 + k];
					if (dd < r.d) { r.d = dd; r.layer = d; r.idx = (u32)i; }
				}
			}
		}
		if (track && from + d + 1 < (int)route.size()) {
			// --track=1: the state nearest the route's (same py, vy, ground, jumps; |dpx| + 10 |dvx|) in this layer
			const S& rs = route[from + d + 1];
			double best = 1e30, bdx = 0, bdv = 0; size_t nY = 0;
			for (const S& s : cur) if (s.py == rs.py && s.speed_y == rs.speed_y && s.on_ground == rs.on_ground && s.jump_count == rs.jump_count) {
				nY++;
				const double e = std::fabs(s.px - rs.px) + 10 * std::fabs(s.speed_x - rs.speed_x);
				if (e < best) { best = e; bdx = s.px - rs.px; bdv = s.speed_x - rs.speed_x; }
			}
			fprintf(stderr, "track %d: route px %.3f py %.3f vx %.4f vy %.3f g %d | y-matches %zu nearest dpx %+.4f dvx %+.5f\n", from + d + 1, rs.px, rs.py, rs.speed_x, rs.speed_y, rs.on_ground, nY, nY ? bdx : 0.0, nY ? bdv : 0.0);
		}
		if (watch[0] < watch[1]) {
			// --watch=pxMin,pxMax,pyMin,pyMax,ground(-1 any): the states in that box this layer
			size_t n = 0; double lo = 1e9, hi = -1e9, vlo = 1e9, vhi = -1e9;
			for (const S& s : cur) if (s.px >= watch[0] && s.px <= watch[1] && s.py >= watch[2] && s.py <= watch[3] && (watch[4] < 0 || (double)s.on_ground == watch[4])) { n++; lo = std::min(lo, s.px); hi = std::max(hi, s.px); vlo = std::min(vlo, s.speed_x); vhi = std::max(vhi, s.speed_x); }
			if (n) fprintf(stderr, "watch tick %d: %zu states px %.3f..%.3f vx %.3f..%.3f\n", from + d + 1, n, lo, hi, vlo, vhi);
		}
		// the route: is its state at tick d + 1 in the new layer?
		if (!route.empty() && d + 1 < (int)route.size()) {
			const S& rs = route[d + 1];
			bool present = false;
			for (const S& s : cur) if (s.px == rs.px && s.py == rs.py && s.speed_x == rs.speed_x && s.speed_y == rs.speed_y && s.on_ground == rs.on_ground && s.jump_count == rs.jump_count && s.q0 == rs.q0 && s.q1 == rs.q1) { present = true; break; }
			if (!present && routeLost < 0) {
				routeLost = d + 1;
				fprintf(stderr, "route lost at tick %d: px %.4f py %.4f vx %.5f vy %.5f g %d\n", d + 1, rs.px, rs.py, rs.speed_x, rs.speed_y, rs.on_ground);
			}
			if (present && routeLost >= 0) { fprintf(stderr, "route back at tick %d\n", d + 1); routeLost = -1; }
		}
		if (!quiet && (d % 20 == 0 || verbose)) fprintf(stderr, "layer %d: %zu states (total %zu) over %zu, best rc %.2f, %.1f s\n", d + 1, cur.size(), totalStates, over, bestRc, now() - t0);
		if (totalStates > maxStates) { why = "full"; d++; break; }
	}
	if (whyOn) {
		std::sort(blocked.begin(), blocked.end(), [](const Blocked& a, const Blocked& b) { return a.t != b.t ? a.t < b.t : a.px < b.px; });
		for (const Blocked& b : blocked) {
			if (b.t < claimLo || b.t > claimHi) continue;
			const int dl = b.layer - from;   // (the claim layer's index)
			fprintf(stderr, "blocked t %d: cand px %.3f vx %.4f (route px %.3f vx %.4f): cell claimed at tick %d by %s\n", b.t, b.px, b.vx, route[b.t].px, route[b.t].speed_x, b.layer + 1,
				dl >= 0 && dl < (int)lineage.size() ? inputsOf(dl, b.widx / 18, (int)(b.widx % 18)).c_str() : "?");
		}
	}
	if (!route.empty()) {
		// per route tick: the claim of its cell (tick claimed, the winner's px / vx vs the route's)
		std::sort(claims.begin(), claims.end(), [](const Claim& a, const Claim& b) { return a.t < b.t; });
		std::string line;
		int lastOwn = 0;
		for (const Claim& c : claims) if (c.own) lastOwn = std::max(lastOwn, c.t);
		fprintf(stderr, "route cells: last tick whose own state won its cell: %d (unclaimed ticks: ", lastOwn);
		std::vector<char> seen(route.size(), 0);
		for (const Claim& c : claims) seen[c.t] = 1;
		int nUn = 0;
		for (size_t t = 1; t < route.size(); t++) if (!seen[t]) { if (nUn < 30) fprintf(stderr, "%zu ", t); nUn++; }
		fprintf(stderr, "... %d)\n", nUn);
		if (opt(argc, argv, "claims", "0") == "1")
			for (const Claim& c : claims) if (!c.own) {
				fprintf(stderr, "  t %d: cell claimed at tick %d by px %.3f vx %.4f (route px %.3f vx %.4f py %.3f vy %.3f g %d)\n", c.t, c.layer + 1, c.wpx, c.wvx, route[c.t].px, route[c.t].speed_x, route[c.t].py, route[c.t].speed_y, route[c.t].on_ground);
				const int dl = c.layer - from;
				if (c.t >= claimLo && c.t <= claimHi && dl >= 0 && dl < (int)lineage.size()) fprintf(stderr, "    claimer inputs: %s\n", inputsOf(dl, c.idx / 18, (int)(c.idx % 18)).c_str());
			}
	}
	if (opt(argc, argv, "closest", "0") == "1") fprintf(stderr, "closest: rc %.3f tick %d inputs %s\n", bestRc, from + bestRcLayer + 1, bestRcInputs.c_str());
	if (!frontierOut.empty()) {
		const int SB = R.B + 1;
		auto reachable = [&](int t) { for (int b = 0; b < SB; b++) if (R.cost[(size_t)t * SB + b] >= 0.f) return true; return false; };
		std::vector<std::string> lines;
		int nF = 0;
		for (int ty = 0; ty < L.H; ty++) for (int tx = 0; tx < L.W; tx++) {
			const int f = ty * L.W + tx;
			if (tileSeen[f] || !reachable(f)) continue;
			bool any = false;
			for (int k = 0; k < 8; k++) {
				const int nx = tx - NBX[k], ny = ty - NBY[k];   // (the neighbour n whose direction k points at f)
				if (nx < 0 || ny < 0 || nx >= L.W || ny >= L.H) continue;
				const int n = ny * L.W + nx;
				if (!tileSeen[n]) continue;
				const NearRec& r = nearRec[(size_t)n * 8 + k];
				if (r.layer < 0 || r.layer >= (int)lineage.size()) continue;
				const u32 pk = lineage[r.layer][r.idx];
				lines.push_back(inputsOf(r.layer, pk >> 5, (int)(pk & 31)));
				any = true;
			}
			if (any) nF++;
		}
		std::sort(lines.begin(), lines.end());
		lines.erase(std::unique(lines.begin(), lines.end()), lines.end());
		FILE* fo = fopen(frontierOut.c_str(), "wb");
		for (const std::string& l : lines) fprintf(fo, "%s\n", l.c_str());
		fclose(fo);
		fprintf(stderr, "frontier: %d tiles, %zu near-miss lines -> %s\n", nF, lines.size(), frontierOut.c_str());
	}
	const double sec = now() - t0;
	if (!quiet) fprintf(stderr, "phases: expand %.2f bucket %.2f claim %.2f mat %.2f\n", phT[0], phT[1], phT[2], phT[3]);
	printf("{\"rule\":\"%s\",\"pass\":%d,\"salt\":%llu,\"K\":%d,\"end\":\"%s\",\"layers\":%d,\"finish\":%d,\"states\":%zu,\"maxLayer\":%zu,\"ticks\":%llu,\"twins\":%llu,\"sec\":%.2f,\"bestRc\":%.3f,\"bestRcLayer\":%d,\"batch\":%d,\"finishTry\":%d,\"inputs\":\"%s\"}\n",
		rule.c_str(), pass, (unsigned long long)salt, K, why.c_str(), from + d, finishLayer >= 0 ? from + finishLayer + 1 : -1, totalStates, maxLayer, (unsigned long long)ticks.load(), (unsigned long long)twins.load(), sec, bestRc, bestRcLayer, batchS, finishTry, finishInputs.c_str());
	fflush(stdout);
	free(start);
	return 0;
}

int main(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: xp <level.bin> <reach.bin> [options]\n"); return 2; }
	LevelBlob B = readLevel(argv[1]);
	const int tw = B.get("tailWords");
	if (tw <= 8) return run<8>(argc, argv, B);
	if (tw <= 32) return run<32>(argc, argv, B);
	if (tw <= 128) return run<128>(argc, argv, B);
	fprintf(stderr, "level state too large\n");
	return 3;
}
