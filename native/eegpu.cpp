// eegpu: the native EE engine (native/eecore.h) and its GPU search, driven by src/gpu.js.
//   eegpu trace <level.bin> <run.eetas> <out.bin> [--gpu]   per-tick state hashes of a replay (differential tests)
//   eegpu state <level.bin> <run.eetas> <tick>               the full state after <tick> ticks (JSON, for debugging)
//   eegpu info                                               the GPU (JSON), or {"gpu":null,"why":...}
//   eegpu twins <level.bin> <run.eetas> [out.bin] [...]      CPU check of the searches' twin rule (runTwins)
// Level files come from src/gpu.js levelBlob(); .eetas are raw bytes (mask = (byte - 48) & 31).
// Every GPU command takes --launch-ms=N (default 50): the target time of one kernel launch (launch.h: the work is
// split into launches sized from the measured speed, so none nears the driver's 2 s watchdog even on a throttled
// laptop GPU); its done / summary line reports "maxLaunchMs". A failed launch prints {"error":...,"launchError":true}
// and exits 6 (7: CUDA_ERROR_LAUNCH_TIMEOUT). --stopfile=<path>: when that file appears, the command ends between two
// launches with its final line (end "stopped") and exit code 0 (killing it while a kernel runs resets the driver).
// explore / beam / search / bench run at above-normal CPU priority: their host thread must start the next short launch
// at once (--priority=normal, or EEGPU_PRIORITY=normal in the environment: off).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <vector>
#include <string>
#include <chrono>
#include <algorithm>
#include "cudadrv.h"
#include "launch.h"
#include "eecore.h"
#include "search.h"
#include "beam.h"
#include "explore.h"

using namespace ee;

#ifndef EE_TW_HOST
#define EE_TW_HOST 2048
#endif
typedef State<EE_TW_HOST> HState;
typedef Sim<EE_TW_HOST> HSim;

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

// ------------------------------------------------------------------ level blob (src/gpu.js levelBlob)
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
	/** Level with pointers relative to `base` (host bytes, or the device copy). */
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
	if (b.get("tailWords") > EE_TW_HOST) { fprintf(stderr, "level needs %d state words (max %d)\n", b.get("tailWords"), EE_TW_HOST); exit(3); }
	return b;
}

static std::vector<uint8_t> readMasks(const char* path) {
	std::vector<uint8_t> b = readFile(path);
	for (auto& x : b) x = (uint8_t)((x - 48) & 31);
	return b;
}

// ------------------------------------------------------------------ CPU modes
static int cmdTrace(int argc, char** argv) {
	if (argc < 5) { fprintf(stderr, "usage: eegpu trace <level.bin> <run.eetas> <out.bin>\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	Level L = B.level(B.bytes.data());
	std::vector<uint8_t> m = readMasks(argv[3]);
	HState* st = (HState*)calloc(1, sizeof(HState));
	HSim sim(L, *st);
	sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
	// startMode 'reset': the file's collected coins are reset anyway, but freshLoad must see them (they matter for
	// the idle ticks and the pre-reset overlaps); pass them always
	std::vector<uint64_t> out;
	int32_t complete = -1, runTicks = -1, deaths = 0, broken = -1;
	auto t0 = std::chrono::steady_clock::now();
	out.push_back(sim.hash(false)); out.push_back(sim.hash(true));
	for (size_t t = 0; t < m.size(); t++) {
		Input in = maskInput(m[t]);
		bool had = st->has_silver_crown;
		sim.tick(in);
		out.push_back(sim.hash(false)); out.push_back(sim.hash(true));
		if (!had && st->has_silver_crown && complete < 0) { complete = (int32_t)(t + 1); runTicks = st->run_ticks; }
		if (st->broken && broken < 0) broken = (int32_t)(t + 1);
	}
	double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
	deaths = st->deaths;
	FILE* f = fopen(argv[4], "wb");
	int32_t head[6] = { (int32_t)m.size(), complete, runTicks, deaths, broken, 0 };
	fwrite(head, 4, 6, f);
	fwrite(out.data(), 8, out.size(), f);
	fclose(f);
	printf("{\"ticks\":%zu,\"complete\":%d,\"runTicks\":%d,\"deaths\":%d,\"broken\":%d,\"seconds\":%.6f}\n", m.size(), complete, runTicks, deaths, broken, sec);
	free(st);
	return 0;
}

static void jd(const char* k, double v, bool comma = true) {
	uint64_t b; memcpy(&b, &v, 8);
	printf("\"%s\":[%.17g,\"%016llx\"]%s", k, v, (unsigned long long)b, comma ? "," : "");
}
static int cmdState(int argc, char** argv) {
	if (argc < 5) { fprintf(stderr, "usage: eegpu state <level.bin> <run.eetas> <tick>\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	Level L = B.level(B.bytes.data());
	std::vector<uint8_t> m = readMasks(argv[3]);
	int T = atoi(argv[4]);
	HState* st = (HState*)calloc(1, sizeof(HState));
	HSim sim(L, *st);
	sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
	for (int t = 0; t < T && t < (int)m.size(); t++) { Input in = maskInput(m[t]); sim.tick(in); }
	HState& s = *st;
	printf("{");
	jd("px", s.px); jd("py", s.py); jd("speed_x", s.speed_x); jd("speed_y", s.speed_y); jd("modifier_x", s.modifier_x);
	jd("modifier_y", s.modifier_y); jd("mox", s.mox); jd("moy", s.moy); jd("_mx", s.mx); jd("_my", s.my);
	jd("_slippery", s.slippery); jd("_last_jump", s.last_jump); jd("_ox", s.ox); jd("_oy", s.oy); jd("_dead_offset", s.dead_offset);
	jd("_current_thrust", s.current_thrust);
#define II(k, v) printf("\"%s\":%d,", k, (int)(v));
	II("morx", s.morx) II("mory", s.mory) II("jump_count", s.jump_count) II("max_jumps", s.max_jumps) II("jump_boost", s.jump_boost)
	II("speed_boost", s.speed_boost) II("flip_gravity", s.flip_gravity) II("coins", s.coins) II("blue_coins", s.blue_coins)
	II("deaths", s.deaths) II("_next_spawn", s.next_spawn) II("_keysMask", s.keysMask)
	II("_show_coin_gate", s.show_coin_gate) II("_show_blue_coin_gate", s.show_blue_coin_gate) II("_show_death_gate", s.show_death_gate)
	II("_ticks", s.ticks) II("_tick0", s.tick0) II("_q0", s.q0) II("_q1", s.q1) II("_pastx", s.pastx) II("_pasty", s.pasty)
	II("overlapa", s.overlapa) II("overlapb", s.overlapb) II("overlapc", s.overlapc) II("overlapd", s.overlapd)
	II("_last_portal_x", s.last_portal_x) II("_last_portal_y", s.last_portal_y) II("_horizontal", s.horizontal)
	II("_vertical", s.vertical) II("_current", s.current) II("run_ticks", s.run_ticks) II("team", s.team)
	II("_team_tx", s.team_tx) II("_team_ty", s.team_ty) II("cpx", s.checkpoint_x) II("cpy", s.checkpoint_y)
	II("gdx", s.grav_x) II("gdy", s.grav_y) II("_rngSteps", s.rngSteps)
	II("on_ground", s.on_ground) II("is_dead", s.is_dead) II("in_god_mode", s.in_god_mode) II("has_crown", s.has_crown)
	II("has_silver_crown", s.has_silver_crown) II("low_gravity", s.low_gravity) II("is_invulnerable", s.is_invulnerable)
	II("is_on_fire", s.is_on_fire) II("_timedoor_state", s.timedoor_state) II("_collide_crown", s.collide_crown)
	II("_collide_silver_crown", s.collide_silver_crown) II("_last_portal_set", s.last_portal_set) II("_spacedown", s.spacedown)
	II("_spacejustdown", s.spacejustdown) II("_prev_jump_held", s.prev_jump_held) II("is_cursed", s.is_cursed)
	II("is_zombie", s.is_zombie) II("is_poisoned", s.is_poisoned) II("has_levitation", s.has_levitation)
	II("is_thrusting", s.is_thrusting) II("broken", s.broken) II("nsq", s.nsq) II("nkq", s.nkq) II("ntq", s.ntq)
	for (int c = 0; c < 6; c++) printf("\"kt%d\":%d,", c, s.kt[c]);
#undef II
	jd("_fire_duration", s.fire_duration); jd("_curse_duration", s.curse_duration); jd("_zombie_duration", s.zombie_duration);
	jd("_poison_duration", s.poison_duration);
	printf("\"tail\":[");
	for (int i = 0; i < L.tailWords; i++) printf("%s%u", i ? "," : "", s.w[i]);
	printf("],");
	printf("\"hash\":\"%llu\",\"hashNoCoins\":\"%llu\"}\n", (unsigned long long)sim.hash(false), (unsigned long long)sim.hash(true));
	free(st);
	return 0;
}

// ------------------------------------------------------------------ options
static std::string opt(int argc, char** argv, const char* name, const char* dflt) {
	const size_t n = strlen(name);
	for (int i = 1; i < argc; i++) if (!strncmp(argv[i], "--", 2) && !strncmp(argv[i] + 2, name, n) && argv[i][2 + n] == '=') return argv[i] + 3 + n;
	for (int i = 1; i < argc; i++) if (!strncmp(argv[i], "--", 2) && !strcmp(argv[i] + 2, name)) return "1";
	return dflt;
}
static std::string exeDir() {
	char p[MAX_PATH]; GetModuleFileNameA(nullptr, p, MAX_PATH);
	std::string s = p; size_t k = s.find_last_of("\\/"); return k == std::string::npos ? "." : s.substr(0, k);
}
static std::string readText(const std::string& path) {
	std::vector<uint8_t> b = readFile(path.c_str());
	return std::string(b.begin(), b.end());
}
static std::string jsonStr(const std::string& s) {
	std::string o = "\"";
	for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if ((unsigned char)c < 32) o += ' '; else o += c; }
	return o + "\"";
}

// ------------------------------------------------------------------ ptx: compile the kernels with NVRTC (build time)
static int cmdPtx(int argc, char** argv) {
	if (argc < 4) { fprintf(stderr, "usage: eegpu ptx <native dir> <out.ptx> --nvrtc=<dir with nvrtc64_120_0.dll> [--arch=compute_60] [--def=NAME,...]\n"); return 2; }
	std::string dir = argv[2];
	if (!cu::loadNvrtc(opt(argc, argv, "nvrtc", "."))) { fprintf(stderr, "%s\n", cu::lastError.c_str()); return 3; }
	std::string src = readText(dir + "/kernels.cu"), h1 = readText(dir + "/eecore.h"), h2 = readText(dir + "/search.h"), h3 = readText(dir + "/beam.h"), h4 = readText(dir + "/explore.h");
	const char* hdrs[] = { h1.c_str(), h2.c_str(), h3.c_str(), h4.c_str() };
	const char* names[] = { "eecore.h", "search.h", "beam.h", "explore.h" };
	cu::nvrtcProgram prog;
	cu::nvrtcCreateProgram(&prog, src.c_str(), "kernels.cu", 4, hdrs, names);
	std::string arch = "--gpu-architecture=" + opt(argc, argv, "arch", "compute_60");
	std::string tw = "-DEE_ONLY_TW=" + opt(argc, argv, "tw", "8");
	std::vector<std::string> defs;   // --def=A,B: extra -D options (build experiments, e.g. EE_TICK_NOINLINE)
	{
		const std::string d = opt(argc, argv, "def", "");
		for (size_t p = 0; p < d.size();) { size_t q = d.find(',', p); if (q == std::string::npos) q = d.size(); if (q > p) defs.push_back("-D" + d.substr(p, q - p)); p = q + 1; }
	}
	std::vector<const char*> opts = { arch.c_str(), "--fmad=false", "--std=c++17", tw.c_str() };
	for (const std::string& x : defs) opts.push_back(x.c_str());
	auto t0 = std::chrono::steady_clock::now();
	int rc = cu::nvrtcCompileProgram(prog, (int)opts.size(), opts.data());
	size_t ls = 0; cu::nvrtcGetProgramLogSize(prog, &ls);
	std::string log(ls + 1, 0); cu::nvrtcGetProgramLog(prog, &log[0]);
	if (rc) { fprintf(stderr, "NVRTC failed (%d):\n%s\n", rc, log.c_str()); return 4; }
	size_t ps = 0; cu::nvrtcGetPTXSize(prog, &ps);
	std::string ptx(ps, 0); cu::nvrtcGetPTX(prog, &ptx[0]);
	while (!ptx.empty() && ptx.back() == 0) ptx.pop_back();
	if (ptx.find("fma.rn.f64") != std::string::npos) { fprintf(stderr, "PTX contains fused multiply-adds: not exact\n"); return 5; }
	FILE* f = fopen(argv[3], "wb"); fwrite(ptx.data(), 1, ptx.size(), f); fclose(f);
	int maj = 0, min = 0; cu::nvrtcVersion(&maj, &min);
	printf("{\"ptx\":%s,\"bytes\":%zu,\"nvrtc\":\"%d.%d\",\"ms\":%.0f}\n", jsonStr(argv[3]).c_str(), ptx.size(), maj, min,
		std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
	if (strlen(log.c_str()) > 1) fprintf(stderr, "%s\n", log.c_str());
	cu::nvrtcDestroyProgram(&prog);
	return 0;
}

// ------------------------------------------------------------------ GPU context with the kernels loaded
struct Gpu {
	cu::Device d;
	cu::CUmodule mod = nullptr;
	bool ok = false;
	bool open(const std::string& ptxPath) {
		if (!d.open()) return false;
		FILE* f = fopen(ptxPath.c_str(), "rb");
		if (!f) { cu::lastError = "kernels not found: " + ptxPath; return false; }
		fclose(f);
		if (!cu::loadModule(&mod, readText(ptxPath))) return false;
		ok = true;
		return true;
	}
	cu::CUfunction fn(const std::string& name) {
		cu::CUfunction f = nullptr;
		if (cu::cuModuleGetFunction(&f, mod, name.c_str())) return nullptr;
		return f;
	}
	std::string json() const {
		char b[512];
		snprintf(b, sizeof b, "{\"name\":%s,\"sms\":%d,\"clockMHz\":%d,\"cc\":\"%d.%d\",\"memMB\":%zu,\"driver\":%d}",
			jsonStr(d.name).c_str(), d.sms, d.clockMHz, d.ccMajor, d.ccMinor, d.mem >> 20, d.driver);
		return b;
	}
};
/** The kernels for a state size (eegpu_<tw>.ptx next to the exe, or --ptxdir). */
static std::string ptxFor(int argc, char** argv, int tw) {
	return opt(argc, argv, "ptxdir", exeDir().c_str()) + "\\eegpu_" + std::to_string(tw) + ".ptx";
}

static int twFor(int tailWords) { return tailWords <= 8 ? 8 : tailWords <= 32 ? 32 : tailWords <= 128 ? 128 : tailWords <= 512 ? 512 : 0; }

static int cmdInfo(int argc, char** argv) {
	Gpu g;
	if (!g.open(ptxFor(argc, argv, 8))) {
		printf("{\"gpu\":null,\"why\":%s}\n", jsonStr(cu::lastError).c_str());
		return 0;
	}
	int sz[4] = {0};
	cu::Buf out; out.alloc(16);
	cu::CUfunction f = g.fn("stateSize_8");
	void* args[] = { &out.p };
	bool layoutOk = false;
	if (f) {
		lk::launch(f, 1, 1, args, "stateSize");
		cu::cuMemcpyDtoH_v2(sz, out.p, 16);
		layoutOk = sz[0] == (int)sizeof(State<8>) && sz[1] == (int)sizeof(SearchParams) && sz[2] == (int)sizeof(Hit) && sz[3] == (int)sizeof(Level);
	}
	std::string fa;
	for (int tw : { 8 }) {
		cu::CUfunction fs = g.fn("search_" + std::to_string(tw));
		int regs = -1, local = -1, maxT = -1;
		if (fs) { cu::cuFuncGetAttribute(&regs, 4, fs); cu::cuFuncGetAttribute(&local, 3, fs); cu::cuFuncGetAttribute(&maxT, 0, fs); }
		char b[160]; snprintf(b, sizeof b, "%s\"search_%d\":{\"regs\":%d,\"localBytes\":%d,\"maxThreads\":%d}", fa.empty() ? "" : ",", tw, regs, local, maxT);
		fa += b;
	}
	printf("{\"kernels\":{%s},", fa.c_str());
	printf("\"gpu\":%s,\"layoutOk\":%s,\"deviceSizes\":[%d,%d,%d,%d],\"hostSizes\":[%d,%d,%d,%d]%s}\n", g.json().c_str(), layoutOk ? "true" : "false",
		sz[0], sz[1], sz[2], sz[3], (int)sizeof(State<8>), (int)sizeof(SearchParams), (int)sizeof(Hit), (int)sizeof(Level), lk::doneFields().c_str());
	return 0;
}

// ------------------------------------------------------------------ trace on the GPU
template <int TW>
static bool gpuTrace(Gpu& g, const LevelBlob& B, const std::vector<uint8_t>& m, std::vector<uint64_t>& out, int32_t info[4], double& sec) {
	cu::Buf dl, dm, dout, dinfo, dstate;
	if (!dl.upload(B.bytes.data(), B.bytes.size()) || !dm.upload(m.data(), m.size()) || !dout.alloc(16 * (m.size() + 1)) || !dinfo.upload(info, 16) ||
		!dstate.alloc(sizeof(State<TW>))) return false;
	Level L = B.level((const uint8_t*)(uintptr_t)dl.p);
	const u8* masks = (const u8*)(uintptr_t)dm.p;
	const int n = (int)m.size();
	int t0 = 0, t1 = 0;
	u64* o = (u64*)(uintptr_t)dout.p;
	const u32* cb0 = (const u32*)(uintptr_t)(dl.p + B.aoff[A_coinBits0]);
	u64 seed = B.rngSeed;
	i32* inf = (i32*)(uintptr_t)dinfo.p;
	u8* stp = (u8*)(uintptr_t)dstate.p;
	void* args[] = { &L, &masks, &t0, &t1, &o, &cb0, &seed, &inf, &stp };
	cu::CUfunction f = g.fn("trace_" + std::to_string(TW));
	if (!f) { cu::lastError = "no trace kernel (rebuild the kernels)"; return false; }
	auto c0 = std::chrono::steady_clock::now();
	// one thread over the run, in segments of ticks sized to the launch target (each continues from the saved state)
	lk::Chunk ck(64, 1, 1e7);
	do {
		t1 = t0 + (n > t0 ? (int)ck.next((uint64_t)(n - t0)) : 0);   // (an empty run: one launch for the start state)
		const double ms = lk::launch(f, 1, 1, args, "trace");
		ck.took(t1 - t0, ms);
		t0 = t1;
	} while (t0 < n);
	sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - c0).count();
	out.resize(2 * (m.size() + 1));
	CU_TRY(cu::cuMemcpyDtoH_v2(out.data(), dout.p, 16 * (m.size() + 1)));
	CU_TRY(cu::cuMemcpyDtoH_v2(info, dinfo.p, 16));
	dl.free(); dm.free(); dout.free(); dinfo.free(); dstate.free();
	return true;
}

static int cmdTraceGpu(int argc, char** argv) {
	LevelBlob B = readLevel(argv[2]);
	std::vector<uint8_t> m = readMasks(argv[3]);
	const int tw = twFor(B.get("tailWords"));
	if (!tw) { fprintf(stderr, "this level's state is too large for the GPU engine\n"); return 3; }
	Gpu g;
	if (!g.open(ptxFor(argc, argv, tw))) { fprintf(stderr, "%s\n", cu::lastError.c_str()); return 3; }
	std::vector<uint64_t> out;
	int32_t info[4] = { -1, -1, 0, -1 };
	double sec = 0;
	bool ok = tw == 8 ? gpuTrace<8>(g, B, m, out, info, sec) : tw == 32 ? gpuTrace<32>(g, B, m, out, info, sec)
		: tw == 128 ? gpuTrace<128>(g, B, m, out, info, sec) : tw == 512 ? gpuTrace<512>(g, B, m, out, info, sec) : false;
	if (!ok) { fprintf(stderr, "GPU trace failed: %s\n", tw ? cu::lastError.c_str() : "level state too large for the GPU"); return 4; }
	FILE* f = fopen(argv[4], "wb");
	int32_t head[6] = { (int32_t)m.size(), info[0], info[1], info[2], info[3], 1 };
	fwrite(head, 4, 6, f);
	fwrite(out.data(), 8, out.size(), f);
	fclose(f);
	printf("{\"ticks\":%zu,\"complete\":%d,\"runTicks\":%d,\"deaths\":%d,\"broken\":%d,\"seconds\":%.6f,\"gpu\":true%s}\n", m.size(), info[0], info[1], info[2], info[3], sec, lk::doneFields().c_str());
	return 0;
}

// ------------------------------------------------------------------ search
struct Edge { int32_t t, j, k; uint8_t family, flags; std::vector<uint8_t> seq; };

template <int TW>
struct Searcher {
	typedef State<TW> S;
	const LevelBlob& B;
	Level L;                       // host pointers
	std::vector<uint8_t> masks;    // the reference, cut at its finish (n ticks)
	int n = 0, runTicks = 0;
	std::vector<uint8_t> snaps;    // S(0..n), sizeof(S) each
	std::vector<double> X, Y, SX, SY;
	std::vector<uint64_t> H, H2;
	std::vector<uint32_t> qbits;   // hash(nc), hash2(nc) of S(t)
	bool nocoins;
	std::vector<uint64_t> htKeys; std::vector<int32_t> htVals; uint32_t htMask = 0;
	std::vector<uint32_t> pix; int pixW = 0, pixH = 0;
	std::vector<uint8_t> axis;     // per tick t < n: the input bits that act on the reference's tick t (Sim inAxes | inJump; pert / flip)
	std::vector<uint32_t> twin;    // TWIN_WORDS per tick: the systematic variants that are exact twins (the GPU's twins kernel or buildTwins; empty = none)
	Searcher(const LevelBlob& b, bool nc) : B(b), L(b.level(b.bytes.data())), nocoins(nc) {}
	const uint32_t* twinp() const { return twin.empty() ? nullptr : twin.data(); }

	/** Replays the reference: per-tick states, positions and hashes, the hash table, the pixel prefilter. */
	bool prepare(const std::vector<uint8_t>& ref, std::string& err) {
		S* st = (S*)calloc(1, sizeof(S));
		Sim<TW> sim(L, *st);
		sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
		std::vector<uint8_t> snap;
		auto push = [&]() {
			const uint8_t* p = (const uint8_t*)st;
			snaps.insert(snaps.end(), p, p + sizeof(S));
			X.push_back(st->px); Y.push_back(st->py); SX.push_back(st->speed_x); SY.push_back(st->speed_y);
			H.push_back(sim.hash(nocoins)); H2.push_back(sim.hash2(nocoins));
		};
		push();
		n = -1;
		const bool crown0 = st->has_silver_crown;
		for (size_t t = 0; t < ref.size(); t++) {
			Input in = maskInput(ref[t]);
			sim.tick(in);
			axis.push_back((uint8_t)(sim.inAxes | sim.inJump));
			push();
			if (st->broken) { err = "the reference run overflows the engine's fixed queues at tick " + std::to_string(t + 1); free(st); return false; }
			if (!crown0 && st->has_silver_crown) { n = (int)t + 1; runTicks = st->run_ticks; break; }
		}
		free(st);
		if (n < 0) { err = "the reference run does not finish the level"; return false; }
		masks.assign(ref.begin(), ref.begin() + n);
		// hash table (open addressing; the LATEST tick of a hash wins, like Map.set)
		uint32_t cap = 1024;
		while (cap < 4u * (uint32_t)(n + 1)) cap <<= 1;
		htMask = cap - 1;
		htKeys.assign(cap, 0); htVals.assign(cap, -1);
		for (int t = 0; t <= n; t++) {
			const uint64_t key = H[t] | (1ull << 63);
			uint32_t slot = (uint32_t)(splitmix(H[t]) & htMask);
			while (htKeys[slot] != 0 && htKeys[slot] != key) slot = (slot + 1) & htMask;
			htKeys[slot] = key; htVals[slot] = t;
		}
		// prefilter: the quadKey bit of every reference state
		qbits.assign((1u << QBITS_LOG2) / 32, 0);
		for (int t = 0; t <= n; t++) {
			const uint32_t bit = (uint32_t)(quadKey(X[t], Y[t], SX[t], SY[t]) >> (64 - QBITS_LOG2));
			qbits[bit >> 5] |= 1u << (bit & 31);
		}
		// pixel prefilter (unused by the kernel now): 1 bit per level pixel
		pixW = L.W * 16; pixH = L.H * 16;
		pix.assign(((size_t)pixW * pixH + 31) / 32, 0);
		for (int t = 0; t <= n; t++) {
			const double fx = floor(X[t]), fy = floor(Y[t]);
			if (fx >= 0 && fy >= 0 && fx < pixW && fy < pixH) { const uint32_t bit = (uint32_t)fy * pixW + (uint32_t)fx; pix[bit >> 5] |= 1u << (bit & 31); }
		}
		return true;
	}

	/** The systematic twins of start ticks [t0, t1) on the CPU (search.h twinBits; runSearch computes them on the GPU,
	 *  --twins=cpu here): 130-200 ticks per start tick. */
	void buildTwins(int t0, int t1, bool wantM1, bool wantM2) {
		twin.assign((size_t)n * TWIN_WORDS, 0u);
		S* a = (S*)malloc(sizeof(S)); S* b = (S*)malloc(sizeof(S));
		for (int t = t0; t < t1 && t < n; t++) {
			const S& st = *(const S*)(snaps.data() + (size_t)t * sizeof(S));
			u32* row = twin.data() + (size_t)t * TWIN_WORDS;
			for (int o = 0; o < 18; o++) twinBits<TW>(L, st, masks.data(), n, t, o, wantM1, wantM2, *a, *b, [&](int bit) { row[bit >> 5] |= 1u << (bit & 31); });
		}
		free(a); free(b);
	}

	/** Rebuilds a hit's inputs and replays them on the CPU from S(t): true if it really reaches S(j) (both hashes). */
	bool verify(const Hit& h, Edge& e) {
		if (h.t < 0 || h.t >= n || h.k <= 0 || h.j <= h.t + h.k || h.j > n) return false;
		Cand c = makeCand(h.family, h.t, h.v, h.seed, masks.data(), n, axis.data(), twinp());
		if (!c.valid) return false;
		S* st = (S*)malloc(sizeof(S));
		memcpy(st, snaps.data() + (size_t)h.t * sizeof(S), sizeof(S));
		Sim<TW> sim(L, *st);
		const bool crown0 = st->has_silver_crown;
		e.seq.clear();
		int sticky = 0;
		bool ok = true;
		for (int q = 0; q < h.k; q++) {
			const int m = candInput(c, masks.data(), n, axis.data(), q, sticky);
			if (m < 0) { ok = false; break; }
			e.seq.push_back((uint8_t)m);
			Input in = maskInput(m);
			sim.tick(in);
			if (st->is_dead || st->broken) { ok = false; break; }
			if (!crown0 && st->has_silver_crown && q + 1 < h.k) { ok = false; break; }
		}
		if (ok) {
			if (h.flags & 1) ok = !crown0 && st->has_silver_crown;
			else ok = sim.hash(nocoins) == H[h.j] && sim.hash2(nocoins) == H2[h.j];
		}
		free(st);
		e.t = h.t; e.j = h.j; e.k = h.k; e.family = (uint8_t)h.family; e.flags = (uint8_t)h.flags;
		return ok;
	}
};

static const char* FAMILY_NAMES[] = { "m1", "del", "m2", "pert", "flip", "sticky" };

template <int TW>
static int runSearch(int argc, char** argv, const LevelBlob& B, const std::vector<uint8_t>& ref) {
	const bool nc = opt(argc, argv, "nocoins", "0") == "1";
	const double seconds = atof(opt(argc, argv, "seconds", "20").c_str());
	const int horizon = atoi(opt(argc, argv, "horizon", "1500").c_str());
	const double drift = atof(opt(argc, argv, "drift", "96").c_str());
	uint64_t seed = strtoull(opt(argc, argv, "seed", "1").c_str(), nullptr, 10);
	std::string fams = opt(argc, argv, "families", "m1,del,m2,pert,flip,sticky");
	const int from = atoi(opt(argc, argv, "from", "0").c_str());
	const int toArg = atoi(opt(argc, argv, "to", "-1").c_str());
	auto tStart = std::chrono::steady_clock::now();
	auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - tStart).count(); };

	Searcher<TW> S(B, nc);
	std::string err;
	if (!S.prepare(ref, err)) { printf("{\"error\":%s}\n", jsonStr(err).c_str()); return 3; }
	const int n = S.n;
	const int t0 = std::max(0, std::min(from, n - 1)), t1 = toArg < 0 ? n : std::max(t0 + 1, std::min(toArg, n));
	std::vector<int> famList;
	for (int f = 0; f < FAM_COUNT; f++) if (fams.find(FAMILY_NAMES[f]) != std::string::npos) famList.push_back(f);
	// the systematic families' exact twins (search.h twinBits), left out of their launches: --twins=1 (the table on the
	// GPU), cpu (on the CPU, the same code), 0 (simulate them all, as before)
	const std::string twinsOpt = opt(argc, argv, "twins", "1");
	const bool twM1 = std::find(famList.begin(), famList.end(), (int)FAM_M1) != famList.end(), twM2 = std::find(famList.begin(), famList.end(), (int)FAM_M2) != famList.end();
	const bool twGpu = twinsOpt != "0" && twinsOpt != "cpu" && (twM1 || twM2);
	double twinSec = 0, listSec = 0;   // (host time: the twin table, the launches' candidate lists)
	if (twinsOpt == "cpu" && (twM1 || twM2)) { const double s0 = elapsed(); S.buildTwins(t0, t1, twM1, twM2); twinSec = elapsed() - s0; }
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::CUfunction fsearch = g.fn("search_" + std::to_string(TW));
	if (!fsearch) { printf("{\"error\":\"search kernel missing\"}\n"); return 4; }
	lk::onStop = [&]() {   // (stopped before the search: an empty edges file; later the finale below)
		FILE* f = fopen(argv[4], "wb");
		const uint32_t head[4] = { 0x44454545u, 1u, 0u, (uint32_t)n };
		if (f) { fwrite(head, 4, 4, f); fclose(f); }
		printf("{\"ev\":\"done\",\"end\":\"stopped\",\"n\":%d,\"edges\":0%s}\n", n, lk::doneFields().c_str());
	};
	// device data
	cu::Buf dl, dsnap, dmask, dX, dY, dK, dV, dpix, dq, dhits, dcount, dstats, dax, dlist;
	const uint32_t hitCap = 1u << 18;
	bool up = dl.upload(B.bytes.data(), B.bytes.size()) && dsnap.upload(S.snaps.data(), S.snaps.size()) &&
		dmask.upload(S.masks.data(), S.masks.size()) && dX.upload(S.X.data(), 8 * S.X.size()) && dY.upload(S.Y.data(), 8 * S.Y.size()) &&
		dK.upload(S.htKeys.data(), 8 * S.htKeys.size()) && dV.upload(S.htVals.data(), 4 * S.htVals.size()) &&
		dpix.upload(S.pix.data(), 4 * S.pix.size()) && dq.upload(S.qbits.data(), 4 * S.qbits.size()) && dhits.alloc(sizeof(Hit) * hitCap) && dcount.alloc(4) && dstats.alloc(8 * 8) &&
		dax.upload(S.axis.data(), S.axis.size());
	if (!up) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	cu::cuMemsetD8_v2(dcount.p, 0, 4); cu::cuMemsetD8_v2(dstats.p, 0, 64);
	SearchParams P;
	memset(&P, 0, sizeof P);
	P.L = B.level((const uint8_t*)(uintptr_t)dl.p);
	P.snaps = (const u8*)(uintptr_t)dsnap.p; P.stateBytes = (i32)sizeof(State<TW>);
	P.masks = (const u8*)(uintptr_t)dmask.p; P.n = n;
	P.X = (const double*)(uintptr_t)dX.p; P.Y = (const double*)(uintptr_t)dY.p;
	P.htKeys = (const u64*)(uintptr_t)dK.p; P.htVals = (const i32*)(uintptr_t)dV.p; P.htMask = S.htMask;
	P.pix = (const u32*)(uintptr_t)dpix.p; P.pixW = S.pixW; P.pixH = S.pixH;
	P.qbits = (const u32*)(uintptr_t)dq.p;
	P.nocoins = nc; P.horizon = horizon; P.drift = drift;
	P.hits = (Hit*)(uintptr_t)dhits.p; P.hitCount = (u32*)(uintptr_t)dcount.p; P.hitCap = hitCap;
	P.stats = (unsigned long long*)(uintptr_t)dstats.p;
	P.axis = (const u8*)(uintptr_t)dax.p;
	if (twGpu) {   // the twin table on the GPU, in chunks of start ticks (18 threads each), copied back for the lists and verify
		const double s0 = elapsed();
		cu::CUfunction ftw = g.fn("twins_" + std::to_string(TW));
		const int chunkMax = 8192;   // (the buffer; the launches are sized to the launch target: launch.h)
		lk::Chunk ck(32, 1, chunkMax);
		cu::Buf dtw;
		if (!ftw || !dtw.alloc(4ull * TWIN_WORDS * chunkMax)) { printf("{\"error\":\"twins kernel missing (rebuild: node tools/build-native.js)\"}\n"); return 4; }
		S.twin.assign((size_t)n * TWIN_WORDS, 0u);
		i32 m1 = twM1 ? 1 : 0, m2 = twM2 ? 1 : 0;
		u32* dtwp = (u32*)(uintptr_t)dtw.p;
		for (int c0 = t0; c0 < t1;) {
			P.t0 = c0; P.nT = (int)ck.next((uint64_t)(t1 - c0));
			cu::cuMemsetD8_v2(dtw.p, 0, 4ull * TWIN_WORDS * P.nT);
			void* ta[] = { &P, &dtwp, &m1, &m2 };
			const unsigned threads = (unsigned)P.nT * 18;
			const double ms = lk::launch(ftw, (threads + 127) / 128, 128, ta, "twins");
			ck.took(P.nT, ms);
			cu::cuMemcpyDtoH_v2(S.twin.data() + (size_t)c0 * TWIN_WORDS, dtw.p, 4ull * TWIN_WORDS * P.nT);
			c0 += P.nT;
		}
		twinSec = elapsed() - s0;
	}

	// the work: every family over [t0, t1); systematic families once, then the random ones (new seeds) until time is up
	std::vector<Edge> edges;
	std::vector<std::vector<int>> best(n + 1);   // (t -> edge indices), dedupe per (t, j): minimum k
	uint64_t famTicks[FAM_COUNT] = {0}, famHits[FAM_COUNT] = {0}, famVerified[FAM_COUNT] = {0}, famTwins[FAM_COUNT] = {0};
	double famSec[FAM_COUNT] = {0};
	uint64_t rejected = 0, launches = 0;
	unsigned long long statsPrev[8] = {0};
	// batches of candidates (start ticks x variants): each candidate's state waits in a record on the GPU, and the
	// batch's launches play up to famSeg ticks of every live candidate (launch.h: one candidate can run --horizon ticks,
	// and one thread's tick took 0.5 ms on a throttled laptop GPU), until none is left. Per family (their candidates
	// cost differently): the start ticks per batch (toward 10 x the launch target, at most the records' room) and the
	// ticks per launch (toward the target)
	const size_t recBytes = (16 + sizeof(State<TW>) + 15) & ~(size_t)15;
	const size_t recCap = std::max<size_t>(4096, std::min<size_t>((size_t)256 << 20, (g.d.mem ? g.d.mem : (size_t)4 << 30) / 16) / recBytes);
	cu::Buf drec, dlive;
	if (!drec.alloc(recBytes * recCap) || !dlive.alloc(4)) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
	P.rec = (u8*)(uintptr_t)drec.p; P.recBytes = (i32)recBytes; P.nLive = (u32*)(uintptr_t)dlive.p;
	std::vector<lk::Chunk> famBatch, famSeg;
	for (int f = 0; f < FAM_COUNT; f++) {
		const double Vf = f >= FAM_PERT ? 256 : familyVariants(f);
		famBatch.emplace_back(std::max(1.0, std::floor(1024.0 / Vf)), 1, std::max(1.0, std::floor((double)recCap / Vf)), 1, 10.0);
		famSeg.emplace_back(32, 1, std::max(1, horizon), 1, 1.0);
	}
	std::vector<Hit> batchHits;
	// a batch's hits: in candidate order (start tick, variant: whatever order the GPU found them in), the shortest k per (t, j)
	auto takeHits = [&]() {
		std::sort(batchHits.begin(), batchHits.end(), [](const Hit& a, const Hit& b) { return a.t != b.t ? a.t < b.t : a.v < b.v; });
		for (const Hit& h : batchHits) {
			famHits[h.family]++;
			bool dup = false;
			for (int ei : best[h.t]) if (edges[ei].j == h.j && edges[ei].k <= h.k) { dup = true; break; }
			if (dup) continue;
			Edge e;
			if (!S.verify(h, e)) { rejected++; continue; }
			famVerified[h.family]++;
			best[h.t].push_back((int)edges.size());
			edges.push_back(std::move(e));
		}
		batchHits.clear();
	};
	// the edges file and the done event (stopped: a stop request between two launches, launch.h; the batch's hits so far count)
	auto finale = [&](bool stopped) {
		if (stopped) takeHits();
		unsigned long long st[8];
		cu::cuMemcpyDtoH_v2(st, dstats.p, 64);
		const double sec = elapsed();
		// edges file: "EEED", version 1, count, n, then per edge: t, j, k (i32), family, flags (u8), 2 pad, k input bytes
		FILE* f = fopen(argv[4], "wb");
		uint32_t head[4] = { 0x44454545u, 1u, (uint32_t)edges.size(), (uint32_t)n };
		fwrite(head, 4, 4, f);
		for (const Edge& e : edges) {
			int32_t a[3] = { e.t, e.j, e.k };
			uint8_t b[4] = { e.family, e.flags, 0, 0 };
			fwrite(a, 4, 3, f); fwrite(b, 1, 4, f); fwrite(e.seq.data(), 1, e.seq.size(), f);
		}
		fclose(f);
		int64_t bestSave = 0;
		for (const Edge& e : edges) bestSave = std::max<int64_t>(bestSave, (int64_t)e.j - e.t - e.k);
		printf("{\"ev\":\"done\",\"gpu\":%s,\"n\":%d,\"runTicks\":%d,\"seconds\":%.2f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"candidates\":%llu,"
			"\"ends\":{\"death\":%llu,\"drift\":%llu,\"noop\":%llu,\"end\":%llu,\"hit\":%llu,\"broken\":%llu},\"launches\":%llu,"
			"\"edges\":%zu,\"rejected\":%llu,\"bestSaving\":%lld,\"tw\":%d,\"twinSeconds\":%.2f,\"listSeconds\":%.2f%s%s,\"families\":{",
			g.json().c_str(), n, S.runTicks, sec, st[0], st[0] / std::max(1e-9, sec), st[1], st[2], st[3], st[4], st[5], st[6], st[7],
			(unsigned long long)launches, edges.size(), (unsigned long long)rejected, (long long)bestSave, TW, twinSec, listSec,
			stopped ? ",\"end\":\"stopped\"" : "", lk::doneFields().c_str());
		bool first = true;
		for (int fm : famList) {
			printf("%s\"%s\":{\"ticks\":%llu,\"seconds\":%.2f,\"hits\":%llu,\"edges\":%llu,\"twins\":%llu,\"launchTicks\":%.0f,\"batchStarts\":%.0f}", first ? "" : ",", FAMILY_NAMES[fm],
				(unsigned long long)famTicks[fm], famSec[fm], (unsigned long long)famHits[fm], (unsigned long long)famVerified[fm], (unsigned long long)famTwins[fm], famSeg[fm].size, famBatch[fm].size);
			first = false;
		}
		printf("}}\n");
	};
	lk::onStop = [&]() { finale(true); };
	bool cut = false;   // (the time ran out inside a batch: its start ticks are not done)
	bool firstPass = true;
	int fi = 0;
	int tCursor = t0;
	double lastProgress = 0;
	std::vector<uint32_t> list;   // a systematic launch's candidates: (t - t0) * V + v, the twins left out (Searcher::twin)
	while (elapsed() < seconds && !famList.empty()) {
		const int fam = famList[fi];
		const bool random = fam >= FAM_PERT;
		if (!firstPass && !random) {
			// the systematic families run once; stop when there is nothing else to do
			bool anyRandom = false;
			for (int f2 : famList) if (f2 >= FAM_PERT) anyRandom = true;
			if (!anyRandom) break;
			fi = (fi + 1) % famList.size();
			continue;
		}
		const int V = random ? 256 : familyVariants(fam);
		const int nT = (int)famBatch[fam].next((uint64_t)(t1 - tCursor));
		P.family = fam; P.t0 = tCursor; P.nT = nT; P.V = V; P.seed = seed;
		unsigned threads = (unsigned)nT * V;   // one thread per candidate (t fastest)
		P.list = nullptr; P.nList = 0;
		if (!random && S.twinp()) {
			const auto b0 = std::chrono::steady_clock::now();
			list.clear();
			const int base = fam == FAM_M2 ? M1_VARIANTS : 0;
			for (int ti = 0; ti < nT; ti++) {
				const uint32_t* row = S.twinp() + (size_t)(tCursor + ti) * TWIN_WORDS;
				for (int v = 0; v < V; v++) {
					const int b = base + v;
					if (fam != FAM_DEL && ((row[b >> 5] >> (b & 31)) & 1u)) { famTwins[fam]++; continue; }   // (the table bit first: most are twins)
					if (makeCand(fam, tCursor + ti, v, seed, S.masks.data(), n, S.axis.data(), S.twinp()).valid) list.push_back((uint32_t)ti * (uint32_t)V + (uint32_t)v);
				}
			}
			threads = (unsigned)list.size();
			if (4 * list.size() > dlist.bytes && !dlist.alloc(4 * list.size() + (4 * list.size()) / 2)) { printf("{\"error\":%s}\n", jsonStr(cu::lastError).c_str()); return 4; }
			if (!list.empty()) cu::cuMemcpyHtoD_v2(dlist.p, list.data(), 4 * list.size());
			P.list = (const u32*)(uintptr_t)dlist.p; P.nList = (u32)list.size();
			listSec += std::chrono::duration<double>(std::chrono::steady_clock::now() - b0).count();
		}
		const unsigned block = 128;
		void* args[] = { &P };
		double ms = 0;
		batchHits.clear();
		const double b0 = elapsed();
		if (threads) {
			// the batch: phase 0 starts every candidate, phase 1 continues the live ones, each launch up to segTicks ticks
			P.phase = 0; P.r0 = 0; P.r1 = threads;
			double liveFrac = 1;
			for (;;) {
				cu::cuMemsetD8_v2(dlive.p, 0, 4);
				P.segTicks = (i32)famSeg[fam].next((uint64_t)std::max(1, horizon));
				ms = lk::launch(fsearch, (threads + block - 1) / block, block, args, "search");
				launches++;
				famSec[fam] += ms / 1000;
				famSeg[fam].took(P.segTicks * liveFrac, ms);   // (a launch with few live candidates only shrinks it)
				uint32_t cnt = 0, live = 0;
				cu::cuMemcpyDtoH_v2(&cnt, dcount.p, 4);
				if (cnt) {
					cnt = std::min(cnt, hitCap);
					const size_t o = batchHits.size();
					batchHits.resize(o + cnt);
					cu::cuMemcpyDtoH_v2(batchHits.data() + o, dhits.p, sizeof(Hit) * cnt);
					cu::cuMemsetD8_v2(dcount.p, 0, 4);
				}
				cu::cuMemcpyDtoH_v2(&live, dlive.p, 4);
				if (!live) break;
				liveFrac = (double)live / threads;
				P.phase = 1;
				if (elapsed() >= seconds) { cut = true; break; }   // (time is up inside the batch)
			}
		}
		takeHits();
		unsigned long long st[8];
		cu::cuMemcpyDtoH_v2(st, dstats.p, 64);
		famTicks[fam] += st[0] - statsPrev[0];
		memcpy(statsPrev, st, sizeof st);
		if (cut) break;   // (the batch's start ticks are not done: the cursor stays)
		if (threads) famBatch[fam].took(nT, (elapsed() - b0) * 1000);
		tCursor += nT;
		if (tCursor >= t1) {
			tCursor = t0;
			if (random) seed = splitmix(seed + 0x51ed);
			fi = (fi + 1) % famList.size();
			if (fi == 0) firstPass = false;
		}
		if (elapsed() - lastProgress > 2.0) {
			lastProgress = elapsed();
			printf("{\"ev\":\"progress\",\"t\":%.1f,\"ticks\":%llu,\"ticksPerSec\":%.0f,\"edges\":%zu,\"family\":\"%s\",\"at\":%d,\"launchMs\":%.0f}\n",
				elapsed(), st[0], st[0] / std::max(1e-9, elapsed()), edges.size(), FAMILY_NAMES[fam], tCursor, ms);
			fflush(stdout);
		}
	}
	lk::onStop = nullptr;
	finale(false);
	return 0;
}

// ------------------------------------------------------------------ bench: raw engine speed, GPU and native CPU
template <int TW>
static int runBench(int argc, char** argv, const LevelBlob& B) {
	const double seconds = atof(opt(argc, argv, "seconds", "3").c_str());
	const int ticks = std::max(1, std::min(1024, atoi(opt(argc, argv, "ticks", "256").c_str())));   // (per thread: bounds one launch)
	State<TW>* st = (State<TW>*)calloc(1, sizeof(State<TW>));
	Level L = B.level(B.bytes.data());
	{ Sim<TW> sim(L, *st); sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed); }
	// native CPU, one thread (the same random sticky inputs)
	double cpuRate = 0;
	{
		State<TW>* c = (State<TW>*)malloc(sizeof(State<TW>));
		uint64_t n = 0;
		auto t0 = std::chrono::steady_clock::now();
		double el = 0;
		for (uint64_t lane = 0; el < std::min(1.0, seconds / 3); lane++) {
			memcpy(c, st, sizeof(State<TW>));
			Sim<TW> sim(L, *c);
			u64 r = splitmix(12345 ^ lane);
			int m = 0;
			for (int k = 0; k < ticks; k++) {
				r = splitmix(r);
				if (k == 0 || (r & 255) < 26) m = option((int)((r >> 8) % 18));
				Input in = maskInput(m);
				sim.tick(in);
				n++;
			}
			el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
		}
		cpuRate = n / el;
		free(c);
	}
	Gpu g;
	if (!g.open(ptxFor(argc, argv, TW))) {
		printf("{\"gpu\":null,\"why\":%s,\"nativeCpuSingle\":%.0f}\n", jsonStr(cu::lastError).c_str(), cpuRate);
		return 0;
	}
	cu::CUfunction f = g.fn("bench_" + std::to_string(TW));
	// one run of `ticks` ticks per thread, 1024 threads per SM (enough to fill the GPU), played in segments of ticks
	// sized to the launch target (launch.h: one thread's 256 ticks took 300 ms on a throttled laptop GPU); the threads'
	// states wait on the GPU between segments
	const unsigned threads = (unsigned)g.d.sms * 1024;
	cu::Buf dl, ds, dout, dstates, drng;
	if (!f || !dl.upload(B.bytes.data(), B.bytes.size()) || !ds.upload(st, sizeof(State<TW>)) || !dout.alloc(8) ||
		!dstates.alloc(sizeof(State<TW>) * (size_t)threads) || !drng.alloc(16ull * threads)) {
		printf("{\"gpu\":null,\"why\":%s,\"nativeCpuSingle\":%.0f}\n", jsonStr(cu::lastError).c_str(), cpuRate);
		return 0;
	}
	Level dL = B.level((const uint8_t*)(uintptr_t)dl.p);
	const u8* s0 = (const u8*)(uintptr_t)ds.p;
	unsigned long long* o = (unsigned long long*)(uintptr_t)dout.p;
	u8* stp = (u8*)(uintptr_t)dstates.p;
	u64* rngp = (u64*)(uintptr_t)drng.p;
	cu::cuMemsetD8_v2(dout.p, 0, 8);
	int k0 = 0, k1 = 0;
	u64 seed = 1;
	void* a[] = { &dL, &s0, &k0, &k1, &seed, &o, &stp, &rngp };
	lk::Chunk ck(4, 1, ticks);
	auto t0 = std::chrono::steady_clock::now();
	double el = 0;
	bool measuring = false;
	lk::onStop = [&]() {   // (a stop request: what was measured so far, not a speed to keep)
		unsigned long long n = 0;
		cu::cuMemcpyDtoH_v2(&n, dout.p, 8);
		printf("{\"gpu\":%s,\"ticksPerSec\":%.0f,\"ticks\":%llu,\"seconds\":%.2f,\"nativeCpuSingle\":%.0f,\"end\":\"stopped\"%s}\n", g.json().c_str(),
			measuring && el > 0 ? n / el : 0.0, n, el, cpuRate, lk::doneFields().c_str());
	};
	// runs until `seconds` of measuring (after one whole warm-up run: clocks up, the segment size settles)
	for (;;) {
		for (k0 = 0; k0 < ticks; k0 = k1) {
			k1 = k0 + (int)ck.next((uint64_t)(ticks - k0));
			ck.took(k1 - k0, lk::launch(f, threads / 128, 128, a, "bench"));
			el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
			if (measuring && el >= seconds) break;
		}
		seed++;
		if (!measuring) { cu::cuMemsetD8_v2(dout.p, 0, 8); t0 = std::chrono::steady_clock::now(); measuring = true; continue; }
		if (el >= seconds) break;
	}
	lk::onStop = nullptr;
	unsigned long long n = 0;
	cu::cuMemcpyDtoH_v2(&n, dout.p, 8);
	printf("{\"gpu\":%s,\"ticksPerSec\":%.0f,\"ticks\":%llu,\"seconds\":%.2f,\"nativeCpuSingle\":%.0f,\"ticksPerLaunch\":%.0f%s}\n", g.json().c_str(), n / el, n, el, cpuRate,
		ck.size, lk::doneFields().c_str());
	free(st);
	return 0;
}

static int cmdBench(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: eegpu bench <level.bin> [--seconds=3] [--ticks=256]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runBench<8>(argc, argv, B);
	case 32: return runBench<32>(argc, argv, B);
	case 128: return runBench<128>(argc, argv, B);
	case 512: return runBench<512>(argc, argv, B);
	}
	printf("{\"gpu\":null,\"why\":\"level state too large\"}\n");
	return 0;
}

#include "beamhost.h"
#include "explorehost.h"

// ------------------------------------------------------------------ twins: the exactness check of the twin rule (CPU)
/** equal states: every byte, except the fields the next tick overwrites before it reads them (Sim::inUsed) */
template <int TW>
static bool sameState(const State<TW>& a, const State<TW>& b) {
	static State<TW> x, y;
	memcpy(&x, &a, sizeof x); memcpy(&y, &b, sizeof y);
	for (State<TW>* s : { &x, &y }) { s->horizontal = 0; s->vertical = 0; s->spacedown = 0; s->spacejustdown = 0; s->prev_jump_held = 0; s->last_jump = 0; }
	return !memcmp(&x, &y, sizeof x);
}
/** equal now and for `more` ticks of the same (pseudo-random) inputs: both hashes, both coin modes, the run timer */
template <int TW>
static bool sameFuture(const Level& L, const State<TW>& a0, const State<TW>& b0, int more, u64 seed) {
	static State<TW> a, b;
	memcpy(&a, &a0, sizeof a); memcpy(&b, &b0, sizeof b);
	Sim<TW> sa(L, a), sb(L, b);
	for (int k = 0;; k++) {
		if (sa.hash(false) != sb.hash(false) || sa.hash(true) != sb.hash(true) || sa.hash2(false) != sb.hash2(false) || a.run_ticks != b.run_ticks || a.deaths != b.deaths) return false;
		if (k == 0 && !sameState(a, b)) return false;
		if (k >= more) return true;
		seed = splitmix(seed);
		Input in = maskInput((int)(seed % 32)); sa.tick(in);
		Input in2 = maskInput((int)(seed % 32)); sb.tick(in2);
	}
}

/** eegpu twins <level.bin> <run.eetas> [<out.bin>] [--every=1] [--walks=0] [--search=0]: at every --every-th state of
 *  the run (and --walks states reached from it by random inputs), all 18 options: every option the twin rule skips
 *  (search.h canonOption, as the explore and the beam use it) must give the state of its canonical option, byte for
 *  byte (but the overwritten input fields), and the same hashes for 8 more random ticks. --search=1 (the run must
 *  finish): the search's twin tables (Searcher::buildTwins) at the same ticks, each skipped m1 / m2 variant against the
 *  variant it stands for. out.bin: canon[18] per tick of the run (for the JS engine's check, src/out). Prints a JSON
 *  summary; exit code 1 on any violation. */
template <int TW>
static int runTwins(int argc, char** argv, const LevelBlob& B) {
	typedef State<TW> S;
	const int every = std::max(1, atoi(opt(argc, argv, "every", "1").c_str()));
	const int walks = atoi(opt(argc, argv, "walks", "0").c_str());
	const bool search = opt(argc, argv, "search", "0") == "1";
	Level L = B.level(B.bytes.data());
	std::vector<uint8_t> m = readMasks(argv[3]);
	S* st = (S*)calloc(1, sizeof(S)); S* tmp = (S*)malloc(sizeof(S)); S* w = (S*)malloc(sizeof(S)); S* kids = (S*)malloc(sizeof(S) * 18);
	Sim<TW> sim(L, *st);
	sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
	std::vector<uint8_t> out;
	uint64_t states = 0, skipped = 0, bad = 0, sims = 0;
	uint64_t seed = 0x1234567ull;
	std::string firstBad;
	// one state: the 18 children, the canonical map, the check
	auto check = [&](const S& at, int t, int walk, u8 canon[18]) {
		canonMap<TW>(L, at, *tmp, canon);
		for (int o = 0; o < 18; o++) {
			memcpy(kids + o, &at, sizeof(S));
			Sim<TW> ks(L, kids[o]);
			Input in = maskInput(option(o)); ks.tick(in);
		}
		states++;
		for (int o = 0; o < 18; o++) {
			if (canon[o] == o) { sims++; continue; }
			skipped++;
			seed = splitmix(seed + (u64)t);
			if (!sameFuture<TW>(L, kids[o], kids[canon[o]], 8, seed)) {
				if (!bad++) { char b[160]; snprintf(b, sizeof b, "tick %d walk %d: option %d (mask %d) differs from its canonical %d (mask %d)", t, walk, o, option(o), canon[o], option(canon[o])); firstBad = b; }
			}
		}
	};
	const bool crown0 = st->has_silver_crown;
	const bool writeOut = argc > 4 && argv[4][0] != '-';
	int n = (int)m.size();
	for (int t = 0; t <= (int)m.size(); t++) {
		u8 canon[18];
		if (t % every == 0 && t < (int)m.size()) {
			check(*st, t, -1, canon);
			for (int k = 0; k < walks; k++) {   // off the run: random sticky inputs for 1..40 ticks
				memcpy(w, st, sizeof(S));
				Sim<TW> ws(L, *w);
				seed = splitmix(seed ^ ((u64)t << 20) ^ (u64)k);
				const int len = 1 + (int)(seed % 40);
				int mk = option((int)((seed >> 8) % 18));
				for (int q = 0; q < len && !w->is_dead; q++) { seed = splitmix(seed); if ((seed & 255) < 40) mk = option((int)((seed >> 8) % 18)); Input in = maskInput(mk); ws.tick(in); }
				if (!w->is_dead && !w->broken) { u8 c2[18]; check(*w, t, k, c2); }
			}
		} else if (writeOut && t < (int)m.size()) canonMap<TW>(L, *st, *tmp, canon);
		if (writeOut && t < (int)m.size()) out.insert(out.end(), canon, canon + 18);
		if (t == (int)m.size()) break;
		Input in = maskInput(m[t]); sim.tick(in);
		if (!crown0 && st->has_silver_crown) { n = t + 1; if (search) break; }
	}
	if (writeOut) { FILE* f = fopen(argv[4], "wb"); fwrite(out.data(), 1, out.size(), f); fclose(f); }
	// the search's tables: a skipped variant must play like some variant with a lower option index (by the prefix's end)
	uint64_t vChecked = 0, vTwins = 0, vBad = 0, twinBits = 0, twinTotal = 0;
	double buildSec = 0;
	if (search) {
		std::vector<uint8_t> ref(m.begin(), m.begin() + std::min((size_t)n, m.size()));
		Searcher<TW> SR(B, false);
		std::string err;
		if (!SR.prepare(ref, err)) { printf("{\"error\":%s}\n", jsonStr(err).c_str()); return 3; }
		const int N = SR.n;
		const auto b0 = std::chrono::steady_clock::now();
		SR.buildTwins(0, N, true, true);
		buildSec = std::chrono::duration<double>(std::chrono::steady_clock::now() - b0).count();
		for (int t = 0; t < N; t++) for (int w2 = 0; w2 < TWIN_WORDS; w2++) twinBits += (uint64_t)__builtin_popcount(SR.twin[(size_t)t * TWIN_WORDS + w2]);
		twinTotal = (uint64_t)N * (M1_VARIANTS + M2_VARIANTS);
		// the prefix of a variant into s (m1: option o1 held L1 ticks; m2 (g > 0): o1, the reference g - 1 ticks, o2)
		auto play = [&](int t, int o1, int L1, int g, int o2, S& s) {
			memcpy(&s, SR.snaps.data() + (size_t)t * sizeof(S), sizeof(S));
			Sim<TW> ps(L, s);
			if (g == 0) { for (int q = 0; q < L1; q++) { Input in = maskInput(option(o1)); ps.tick(in); } return; }
			{ Input in = maskInput(option(o1)); ps.tick(in); }
			for (int q = 1; q < g; q++) { Input in = maskInput(SR.masks[t + q]); ps.tick(in); }
			{ Input in = maskInput(option(o2)); ps.tick(in); }
		};
		// the lower variants a skipped one can stand for: its option with some pressed groups (L/R, U/D, jump) dropped
		auto lower = [&](int o, std::vector<int>& outv) {
			outv.clear();
			const int h = o / 6, v = (o / 2) % 3, j = o & 1;
			for (int dh = 0; dh < 2; dh++) for (int dv = 0; dv < 2; dv++) for (int dj = 0; dj < 2; dj++) {
				if ((dh && !h) || (dv && !v) || (dj && !j)) continue;
				const int c = (dh ? 0 : h) * 6 + (dv ? 0 : v) * 2 + (dj ? 0 : j);
				if (c != o) outv.push_back(c);
			}
		};
		S* a = (S*)malloc(sizeof(S)); S* b = (S*)malloc(sizeof(S));
		std::vector<int> lo1, lo2;
		for (int t = 0; t < N; t += every) {
			for (int v = 0; v < M1_VARIANTS + M2_VARIANTS; v++) {
				const bool isM1 = v < M1_VARIANTS;
				const int vv = isM1 ? v : v - M1_VARIANTS;
				if (isM1 && vv >= 72) continue;   // (the drop D does not change the prefix)
				if (!isM1 && t + 1 + vv / 324 >= N) continue;
				vChecked++;
				if (!((SR.twin[(size_t)t * TWIN_WORDS + (v >> 5)] >> (v & 31)) & 1u)) continue;
				vTwins++;
				bool found = false;
				if (isM1) {
					const int o = vv % 18, L1 = 1 + vv / 18;
					play(t, o, L1, 0, 0, *a);
					lower(o, lo1);
					for (int c : lo1) { play(t, c, L1, 0, 0, *b); seed = splitmix(seed); if (sameFuture<TW>(L, *a, *b, 8, seed)) { found = true; break; } }
				} else {
					const int g = 1 + vv / 324, o1 = (vv / 18) % 18, o2 = vv % 18;
					play(t, o1, 1, g, o2, *a);
					lower(o1, lo1); lo1.push_back(o1);
					lower(o2, lo2); lo2.push_back(o2);
					for (int c1 : lo1) { for (int c2 : lo2) { if (c1 == o1 && c2 == o2) continue; play(t, c1, 1, g, c2, *b); seed = splitmix(seed); if (sameFuture<TW>(L, *a, *b, 8, seed)) { found = true; break; } } if (found) break; }
				}
				if (!found && !vBad++) { char bb[160]; snprintf(bb, sizeof bb, "search tick %d variant %s %d: no lower variant plays the same", t, isM1 ? "m1" : "m2", vv); if (firstBad.empty()) firstBad = bb; }
			}
		}
		free(a); free(b);
	}
	printf("{\"states\":%llu,\"options\":%llu,\"simulated\":%llu,\"skipped\":%llu,\"violations\":%llu,\"searchVariants\":%llu,\"searchTwins\":%llu,\"searchViolations\":%llu,"
		"\"tableTwins\":%llu,\"tableVariants\":%llu,\"tableSeconds\":%.2f,\"first\":%s}\n",
		(unsigned long long)states, (unsigned long long)states * 18, (unsigned long long)sims, (unsigned long long)skipped, (unsigned long long)bad,
		(unsigned long long)vChecked, (unsigned long long)vTwins, (unsigned long long)vBad, (unsigned long long)twinBits, (unsigned long long)twinTotal, buildSec, jsonStr(firstBad).c_str());
	free(st); free(tmp); free(w); free(kids);
	return bad || vBad ? 1 : 0;
}
static int cmdTwins(int argc, char** argv) {
	if (argc < 4) { fprintf(stderr, "usage: eegpu twins <level.bin> <run.eetas> [out.bin] [--every=1] [--walks=0] [--search=0]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	switch (twFor(B.get("tailWords"))) {
	case 8: return runTwins<8>(argc, argv, B);
	case 32: return runTwins<32>(argc, argv, B);
	case 128: return runTwins<128>(argc, argv, B);
	case 512: return runTwins<512>(argc, argv, B);
	}
	printf("{\"error\":\"level state too large\"}\n");
	return 3;
}

static int cmdSearch(int argc, char** argv) {
	if (argc < 5) { fprintf(stderr, "usage: eegpu search <level.bin> <ref.eetas> <out.edges> [--seconds=20] [--nocoins=0|1] [--horizon=1500] [--drift=96] [--families=m1,del,m2,pert,flip,sticky] [--seed=N] [--from=T] [--to=T] [--twins=1|cpu|0]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	std::vector<uint8_t> ref = readMasks(argv[3]);
	const int tw = twFor(B.get("tailWords"));
	switch (tw) {
	case 8: return runSearch<8>(argc, argv, B, ref);
	case 32: return runSearch<32>(argc, argv, B, ref);
	case 128: return runSearch<128>(argc, argv, B, ref);
	case 512: return runSearch<512>(argc, argv, B, ref);
	}
	printf("{\"error\":\"this level's state is too large for the GPU engine\"}\n");
	return 3;
}

int main(int argc, char** argv) {
	if (argc < 2) { fprintf(stderr, "eegpu trace|state|info|ptx|search ...\n"); return 2; }
	std::string cmd = argv[1];
	lk::setTarget(atof(opt(argc, argv, "launch-ms", "50").c_str()));   // (launch.h: every kernel launch aims at this)
	// the GPU commands' host thread mostly waits for short launches and must start the next one at once: above normal
	// priority, so busy CPU threads (the editor's CPU search, a job's workers) do not leave the GPU idle between launches
	// (an explore pass on a 50x50 level took 3-7x as long next to 15 busy threads); --priority=normal (or the environment's
	// EEGPU_PRIORITY=normal): off
	const char* envPrio = getenv("EEGPU_PRIORITY");
	const std::string prio = opt(argc, argv, "priority", envPrio && *envPrio ? envPrio : "high");
	if ((cmd == "explore" || cmd == "beam" || cmd == "search" || cmd == "bench") && prio != "normal") SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
	lk::G.stopFile = opt(argc, argv, "stopfile", "");                   // (launch.h: a graceful stop between launches)
	if (cmd == "trace") return opt(argc, argv, "gpu", "0") == "1" ? cmdTraceGpu(argc, argv) : cmdTrace(argc, argv);
	if (cmd == "state") return cmdState(argc, argv);
	if (cmd == "info") return cmdInfo(argc, argv);
	if (cmd == "ptx") return cmdPtx(argc, argv);
	if (cmd == "search") return cmdSearch(argc, argv);
	if (cmd == "bench") return cmdBench(argc, argv);
	if (cmd == "beam") return cmdBeam(argc, argv);
	if (cmd == "explore") return cmdExplore(argc, argv);
	if (cmd == "twins") return cmdTwins(argc, argv);
	fprintf(stderr, "unknown command %s\n", argv[1]);
	return 2;
}
