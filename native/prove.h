// prove.h - `eegpu prove`: sound "no route" proofs for Find a route, by abstract interpretation of eesim.js's tick.
// CPU only: this command never loads the NVIDIA driver (no cu:: call), one thread. Included by eegpu.cpp.
//
//   eegpu prove <level.bin> [--reach=<RCH3>] [--seconds=30] [--maxCells=6000000] [--map=<out.txt>]
//               [--noStop --states=<route states>]   (containment of a known route: test/prove.js)
//               [--trace=x,y]                        (stderr: the chain of cells that brought a centre into tile (x, y))
//               [--dv=1] [--wx=1] [--wy=1]           (vx bins of 1/dv px/tick; coarser position cells: sound, slower)
//   eegpu prove <level.bin> --check=<cases.txt>      (the transfer against engine samples: test/prove.js fuzz)
// Output: JSON lines on stdout, the last one {"ev":"done","verdict":...}: "impossible" (the fixpoint holds no state whose
// box centre is in a trophy tile: no input sequence finishes the level; a proof), "reached" (the over-approximation
// reaches the trophy: nothing proven), "limit" (--seconds or --maxCells ran out first: nothing proven) or "unsupported"
// ("why": the blocks / start effects this model does not cover). Progress lines go to stderr.
//
// Scope (the blocks whose physics this models exactly; anything else is "unsupported"): plain solids (ovl OV_SOLID,
// not ice), air-like tiles (air, spawn 255, crown 5, coins 100 / 101 / 110 / 111, checkpoint 360) and the trophy (121,
// the goal); world gravity 1; a start with no effects (EESim.reset(): no god mode, levitation, multijump, jump / speed
// boost, low gravity, flipped gravity, curse, zombie, poison, fire) and not overlapping a block; at most 1024 x 1024
// tiles. The start state comes from the level blob like every other command (Sim::reset).
//
// Abstract state (a "cell"), keyed by (vy, py cell, px cell, vx bin):
//   vy exact: it is always on one of two orbits (G^n(0) after a collision, G^n(jump speed) after a jump), G being the
//     gravity + drag update, so a few hundred values;
//   py in [ya, yb], px in [pa, pb], vx in [va, vb] (boxes inside the cell: 1 px x 1 px x 1 px/tick);
//   two relational bounds for the run-up:
//     o  = px - D(max(vx, 0)) >= olo      (a ball moving right at speed v has run D(v) px since it stood still)
//     oL = px + D(max(-vx, 0)) <= oLhi    (the same to the left)
//   D is the distance of the engine's running speed orbit (0 -> 6.78 px/tick, input held), shrunk by 1e-8 so that
//   D(F(v)) <= D(v) + F(v) holds with slack for every input's speed update F: o never decreases on a tick without an
//   x collision except by the tick's leftward move (and the grid auto-align).
// The fixpoint over all 6 inputs (left / none / right x jump / no jump; up / down do nothing under normal gravity)
// over-approximates every reachable state: no cell whose centre can be in a trophy tile => no input sequence
// finishes the level (a proof, for the engine's semantics of the blocks in scope). The trophy is taken by
// _touchBlock on the tile under the box centre at the start of a tick, so a reachable state with its centre in a
// trophy tile is exactly a finish.
//
// Transfer = EESim._playerTick for these blocks (default gravity everywhere, no slipperiness, no kill, no portal):
// the speed update (monotone: evaluated at the box ends), the sub-stepped movement loop, grounded (the first y
// collision while moving down), the jump (grounded + jump bit), the x auto-align (no x input, |vx| < 1). The loop:
// each axis has a fixed list of attempted positions (a partial step to the next whole pixel, 1 px steps, the final
// fractional step, or ONE big step for a left / up move from a whole pixel); iteration i tries x's next attempt,
// then y's; a failed attempt is retried in every later iteration (the engine restores csx but keeps rem), while
// the other axis keeps the loop running; donex / doney only stop an axis from keeping the loop alive; speed = 0
// after an axis' first collision. Attempts at interval positions test every tile class the box can cover; a test
// that can go both ways branches, each branch with the boxes refined to the positions that give its outcome.
// Which tiles a box covers uses the engine's exact rounding (thr[t]: fl(x + 16) > 16 t + 16), not a tolerance: a
// tolerance let boxes sit 1e-10 px inside a wall, where a downward collision counts as "grounded" (a wall jump).
// A single-value position and speed step with the engine's own arithmetic (exact); intervals are padded by 1e-10.
// Fast path: when no box on the tick's way (start and end bound the monotone steps) can touch a solid, the successor
// is the plain move. Inserting a successor: split into cells, cut to the free space (the engine never leaves the ball
// overlapping a solid: colliding steps are undone, the align never pushes into a block; a start inside a block is
// "unsupported"), tighten vx by the run-up bounds, hull with the cell's box; boxes widen per dimension after repeated
// growth (exact, then 2^-16, 2^-8, then the whole cell) and are cut again, so the fixpoint is reached.
//
// --reach=<file> (src/reach.js RCH3, physics mode): a piece of a successor whose every state the reach field cuts off
// (-1: the field proves the trophy out of reach from there) is dropped. Sound: every state of a route can reach the
// trophy, so none is cut off, and the fixpoint over the kept states still holds every route (pieces with their centre
// in a trophy tile are never dropped). The test is conservative: the lookup's levels (the fall potential k and the
// apex q, monotone in the centre's height) are taken at the piece's ends and every level in between must be cut, for
// every gravity queue the level's air-like tiles give. It speeds up levels with large dead ends; the explanation then
// describes the states the field leaves open ("pruned" > 0 in the done line). Only this level's field is used: the
// RCH3 header's level fingerprint (src/gpu.js blobFp, FNV-1a 64 of the level blob) must be this blob's, and a field
// that cuts off the start is not (the editor proves only levels whose field finds a way); else a "warning" line and
// the proof without it ("reach" 0). Another level's field (user50's walls, the trophy moved) made user50 "impossible".
//
// Explanation (done line "explain"): the highest top of the box (py), the reachable centre tile nearest a trophy
// (Euclidean in tiles) and its distance, the fastest speeds to the right and to the left, and the start tile.
// Tests: test/prove.js (the transfer against the engine, rooms with known answers, route containment, random rooms
// against a concrete search, the reach prune, the scope; --mutants: deliberately broken transfers must be caught).
#pragma once
#include <unordered_map>
#include <array>

namespace prv {

static double hexd(const char* h) {
	uint8_t b[8];
	for (int i = 0; i < 8; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); b[i] = (uint8_t)v; }
	double d; memcpy(&d, b, 8); return d;
}
static uint64_t bitsOf(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static double below(double x) { return std::nextafter(x, -1e300); }
static double above(double x) { return std::nextafter(x, 1e300); }

static const double MULT = 7.752;
static double BASE_DRAG, NO_MOD_DRAG;
static const double PAD = 1e-10;       // slack for the engine's rounding of p + v (its errors are ~1e-13)
// thr[t] = the smallest double p > 16 t with fl(p + 16) > 16 t + 16: the engine's box at p covers tiles t and t + 1 for
// p in [thr[t], 16 t + 16), only tile t for p in [16 t, thr[t]) (EESim._ovAt: x2 = (x + 16.0) > (ox * 16 + 16))
static std::vector<double> thrX, thrY;
static double threshold(int t) {
	double b = 16.0 * t, lim = (double)(t * 16 + 16);
	uint64_t lo = bitsOf(b), hi = bitsOf(b + 1.0);   // (b + 1) + 16 > lim for sure
	while (hi - lo > 1) { uint64_t mid = lo + (hi - lo) / 2; double x; memcpy(&x, &mid, 8); if (x + 16.0 > lim) hi = mid; else lo = mid; }
	double r; memcpy(&r, &hi, 8); return r;
}

// ------------------------------------------------------------------ level
struct PLevel {
	int W = 0, H = 0;
	double maxX = 0, maxY = 0, gm = 1;
	double sx0 = 0, sy0 = 0, svx0 = 0, svy0 = 0;
	std::vector<uint8_t> cls;   // 0 air-like, 1 solid, 2 goal
	bool solid(int cx, int cy) const { return cls[(size_t)cy * W + cx] == 1; }
	bool goal(int cx, int cy) const { return cx >= 0 && cy >= 0 && cx < W && cy < H && cls[(size_t)cy * W + cx] == 2; }
};
static PLevel LV;
static void initThresholds() {
	thrX.clear(); thrY.clear();
	for (int t = 0; t <= LV.W + 1; t++) thrX.push_back(threshold(t));
	for (int t = 0; t <= LV.H + 1; t++) thrY.push_back(threshold(t));
}

// World.overlaps() for a plain-solid level at an exact (x, y), computed exactly as EESim._ovAt does
static bool collideExact(double x, double y) {
	if (x < 0.0 || y < 0.0 || x > LV.maxX || y > LV.maxY) return true;
	int ox = ((int)x) >> 4, oy = ((int)y) >> 4;
	int x2 = (x + 16.0) > (double)(ox * 16 + 16) ? 1 : 0;
	int y2 = (y + 16.0) > (double)(oy * 16 + 16) ? 1 : 0;
	for (int cy = oy; cy <= oy + y2; cy++)
		for (int cx = ox; cx <= ox + x2; cx++)
			if (LV.solid(cx, cy)) return true;
	return false;
}

struct Iv { double lo, hi; bool empty() const { return !(lo <= hi); } };
static Iv ivMeet(Iv a, Iv b) { return Iv{ std::max(a.lo, b.lo), std::min(a.hi, b.hi) }; }
static Iv ivJoin(Iv a, Iv b) { if (a.empty()) return b; if (b.empty()) return a; return Iv{ std::min(a.lo, b.lo), std::max(a.hi, b.hi) }; }
static const Iv EMPTY{ 1, 0 };

// The tile ranges a box can cover for positions in I (one axis): classes {positions, first tile, last tile, out}.
struct TCls { Iv sub; int t0, t1; bool out; };
static inline void tileRange(double p, double maxP, int& t0, int& t1, bool& out) {
	if (p < 0.0 || p > maxP) { out = true; t0 = t1 = 0; return; }
	out = false; t0 = ((int)p) >> 4; t1 = t0 + ((p + 16.0) > (double)(t0 * 16 + 16) ? 1 : 0);
}
static int tileClasses(Iv I, double maxP, const std::vector<double>& thr, TCls* out) {
	int n = 0;
	{   // the tiles a box covers are monotone in its position: equal at both ends = one class
		int a0, a1, b0, b1; bool ao, bo;
		tileRange(I.lo, maxP, a0, a1, ao); tileRange(I.hi, maxP, b0, b1, bo);
		if (ao == bo && a0 == b0 && a1 == b1 && !(ao && I.lo < 0.0 && I.hi > maxP)) { out[n++] = TCls{ I, a0, a1, ao }; return n; }
	}
	if (I.lo == I.hi) {
		double p = I.lo;
		if (p < 0.0 || p > maxP) { out[n++] = TCls{ I, 0, 0, true }; return n; }
		int t = ((int)p) >> 4;
		out[n++] = TCls{ I, t, t + ((p + 16.0) > (double)(t * 16 + 16) ? 1 : 0), false };
		return n;
	}
	if (I.lo < 0.0) out[n++] = TCls{ Iv{ I.lo, std::min(I.hi, below(0.0)) }, 0, 0, true };
	if (I.hi > maxP) out[n++] = TCls{ Iv{ std::max(I.lo, above(maxP)), I.hi }, 0, 0, true };
	Iv Iw = ivMeet(I, Iv{ 0.0, maxP });
	if (Iw.empty()) return n;
	int t0 = (int)std::floor(Iw.lo / 16.0), t1 = (int)std::floor(Iw.hi / 16.0);
	for (int t = t0; t <= t1 && n < 60; t++) {
		double b = 16.0 * t;
		if (b >= Iw.lo && b <= Iw.hi) out[n++] = TCls{ Iv{ b, b }, t, t, false };
		Iv s = ivMeet(Iw, Iv{ above(b), below(thr[t]) });
		if (!s.empty()) out[n++] = TCls{ s, t, t, false };
		Iv r = ivMeet(Iw, Iv{ thr[t], below(b + 16.0) });
		if (!r.empty()) out[n++] = TCls{ r, t, t + 1, false };
	}
	return n;
}
static long long statTests = 0, statTestsIv = 0;
struct Test { bool canFree, canColl; Iv fX, cX, fY, cY; };
static Test test2D(Iv X, Iv Y) {
	statTests++;
	Test r{ false, false, EMPTY, EMPTY, EMPTY, EMPTY };
	if (X.lo == X.hi && Y.lo == Y.hi) {
		if (collideExact(X.lo, Y.lo)) { r.canColl = true; r.cX = X; r.cY = Y; }
		else { r.canFree = true; r.fX = X; r.fY = Y; }
		return r;
	}
	statTestsIv++;
	TCls cx[64], cy[64];
	int nx = tileClasses(X, LV.maxX, thrX, cx), ny = tileClasses(Y, LV.maxY, thrY, cy);
	for (int i = 0; i < nx; i++)
		for (int j = 0; j < ny; j++) {
			bool coll = cx[i].out || cy[j].out;
			for (int yy = cy[j].t0; !coll && yy <= cy[j].t1; yy++)
				for (int xx = cx[i].t0; !coll && xx <= cx[i].t1; xx++)
					if (LV.solid(xx, yy)) coll = true;
			if (coll) { r.canColl = true; r.cX = ivJoin(r.cX, cx[i].sub); r.cY = ivJoin(r.cY, cy[j].sub); }
			else { r.canFree = true; r.fX = ivJoin(r.fX, cx[i].sub); r.fY = ivJoin(r.fY, cy[j].sub); }
		}
	return r;
}

// ------------------------------------------------------------------ speeds (EESim._playerTick, default tiles)
static double modY() { double moy = 2.0; double gm = 1.0; gm *= LV.gm; moy *= gm; return (moy + 0.0) / MULT; }
static double F(double v, int h) {
	double mx = (double)h;
	double modx = (0.0 + mx) / MULT;
	if (v != 0.0 || modx != 0.0) {
		double sx = v + modx;
		if ((mx == 0.0) || (sx < 0.0 && mx > 0.0) || (sx > 0.0 && mx < 0.0)) { sx *= BASE_DRAG; sx *= NO_MOD_DRAG; }
		else sx *= BASE_DRAG;
		if (sx > 16.0) sx = 16.0;
		else if (sx < -16.0) sx = -16.0;
		else if (sx < 0.0001 && sx > -0.0001) sx = 0.0;
		return sx;
	}
	return v;
}
static double G(double vy) {
	double m = modY();
	if (vy != 0.0 || m != 0.0) {
		double sy = vy + m;
		sy *= BASE_DRAG;
		if (sy > 16.0) sy = 16.0;
		else if (sy < -16.0) sy = -16.0;
		else if (sy < 0.0001 && sy > -0.0001) sy = 0.0;
		return sy;
	}
	return vy;
}
static double JUMPV;

// ------------------------------------------------------------------ run-up distance D
static std::vector<double> Dv, Dd;
static double Dslope;
static const double DC = 1.0 - 1e-8;
static void buildD() {
	Dv.clear(); Dd.clear();
	Dv.push_back(0.0); Dd.push_back(0.0);
	double v = 0.0, d = 0.0;
	for (;;) {
		double v1 = F(v, 1);
		if (v1 - v < 1e-4) break;
		d += v1; Dv.push_back(v1); Dd.push_back(d); v = v1;
	}
	size_t n = Dv.size() - 1;
	Dslope = (Dd[n] - Dd[n - 1]) / (Dv[n] - Dv[n - 1]);
}
static double Draw(double v) {
	if (v <= 0.0) return 0.0;
	size_t n = Dv.size() - 1;
	if (v >= Dv[n]) return Dd[n] + (v - Dv[n]) * Dslope;
	size_t i = std::upper_bound(Dv.begin(), Dv.end(), v) - Dv.begin() - 1;
	return Dd[i] + (v - Dv[i]) * ((Dd[i + 1] - Dd[i]) / (Dv[i + 1] - Dv[i]));
}
static double Dc(double v) { return DC * Draw(v); }
static double Dinv(double d) {   // the largest v >= 0 with Dc(v) <= d (rounded up)
	if (d <= 0.0) return 0.0;
	double e = d / DC;
	size_t n = Dd.size() - 1;
	double v;
	if (e >= Dd[n]) v = Dv[n] + (e - Dd[n]) / Dslope;
	else {
		size_t i = std::upper_bound(Dd.begin(), Dd.end(), e) - Dd.begin() - 1;
		v = Dv[i] + (e - Dd[i]) * ((Dv[i + 1] - Dv[i]) / (Dd[i + 1] - Dd[i]));
	}
	return v * (1.0 + 1e-12) + 1e-9;
}

// ------------------------------------------------------------------ vy ids
struct VyInfo { double vy, vy1; };
static std::vector<VyInfo> vys;
static std::unordered_map<uint64_t, uint32_t> vyIdx;
static uint32_t vyId(double vy) {
	auto it = vyIdx.find(bitsOf(vy));
	if (it != vyIdx.end()) return it->second;
	uint32_t id = (uint32_t)vys.size();
	vys.push_back(VyInfo{ vy, G(vy) });
	vyIdx.emplace(bitsOf(vy), id);
	return id;
}

// ------------------------------------------------------------------ one axis of the movement loop
struct Att { bool fin; double pos; };
enum { M_START = 0, M_EXACT = 1, M_FINAL = 2 };
struct Axis {
	Iv S, V, T;          // start positions, speeds (after the update), final target S + V
	int dir;
	int mode; double e;  // current position: S / e / T
	int c, n; bool done;
	Att att[24];
};
static bool axRefineS(Axis& a, Iv R) {
	a.S = ivMeet(a.S, R);
	if (a.S.empty()) return false;
	if (a.dir != 0) { a.T = ivMeet(a.T, Iv{ a.S.lo + a.V.lo - PAD, a.S.hi + a.V.hi + PAD }); if (a.T.empty()) return false; }
	return true;
}
static bool axRefineT(Axis& a, Iv R) {
	a.T = ivMeet(a.T, R);
	if (a.T.empty()) return false;
	a.S = ivMeet(a.S, Iv{ a.T.lo - a.V.hi - PAD, a.T.hi - a.V.lo + PAD });
	if (a.S.empty()) return false;
	a.V = ivMeet(a.V, Iv{ a.T.lo - a.S.hi - PAD, a.T.hi - a.S.lo + PAD });
	return !a.V.empty();
}
static Iv axPos(const Axis& a) { return a.mode == M_EXACT ? Iv{ a.e, a.e } : a.mode == M_START ? a.S : a.T; }
static bool axRefinePos(Axis& a, Iv R) {
	if (a.mode == M_START) return axRefineS(a, R);
	if (a.mode == M_FINAL) return axRefineT(a, R);
	return a.e >= R.lo && a.e <= R.hi;
}

// All attempt lists for start positions S (inside one pixel k) and speeds V (one sign class). exactV: V is one value.
static double fmod1(double x) { return x > 0.0 ? x - std::trunc(x) : std::fmod(x, 1.0); }
static void axisVariants(Iv S, Iv V, std::vector<Axis>& out) {
	int k = (int)std::floor(S.lo);
	Axis base;
	base.S = S; base.V = V; base.T = S;
	base.dir = V.lo > 0.0 ? 1 : V.hi < 0.0 ? -1 : 0;
	base.mode = M_START; base.e = 0; base.c = 0; base.n = 0; base.done = false;
	if (base.dir == 0) { out.push_back(base); return; }
	if (S.lo == S.hi && V.lo == V.hi) {
		// one start, one speed: the engine's own step arithmetic (EESim._playerTick stepx / stepy, no boost)
		double p = S.lo, rem = fmod1(p), cs = V.lo;
		int n = 0;
		while (cs != 0.0 && n < 24) {
			if (cs > 0.0) {
				if (cs + rem >= 1.0) { p += 1.0 - rem; p = std::trunc(p); cs -= (1.0 - rem); rem = 0.0; }
				else { p += cs; cs = 0.0; }
			} else {
				if (rem + cs < 0.0 && rem != 0.0) { p -= rem; p = std::trunc(p); cs += rem; rem = 1.0; }
				else { p += cs; cs = 0.0; }
			}
			base.att[n++] = Att{ false, p };
		}
		base.n = n; base.T = Iv{ p, p };
		out.push_back(base);
		return;
	}
	Iv T{ S.lo + V.lo - PAD, S.hi + V.hi + PAD };
	base.T = T;
	if (base.dir > 0) {
		// right / down: 1 px steps to k+1 .. M (the first one is the partial step from a fractional start), then the
		// final step to T in [M, M+1); or no final step when the steps end exactly at M
		long M0 = (long)std::floor(T.lo), M1 = (long)std::floor(T.hi);
		for (long M = M0; M <= M1; M++) {
			if (M < k) continue;
			int nu = (int)(M - k);
			if (nu > 20) continue;
			Iv Tm = ivMeet(T, Iv{ (double)M, below((double)(M + 1)) });
			if (!Tm.empty()) {
				Axis a = base;
				for (int i = 0; i < nu; i++) a.att[i] = Att{ false, (double)(k + 1 + i) };
				a.att[nu] = Att{ true, 0 }; a.n = nu + 1;
				if (axRefineT(a, Tm)) out.push_back(a);
			}
			if (M > k && T.lo <= (double)M && (double)M <= T.hi) {
				Axis a = base;
				for (int i = 0; i < nu; i++) a.att[i] = Att{ false, (double)(k + 1 + i) };
				a.n = nu;
				if (axRefineT(a, Iv{ (double)M, (double)M })) out.push_back(a);
			}
		}
		return;
	}
	// left / up
	if (S.lo == (double)k) {
		// from a whole pixel: one big step
		Axis a = base;
		a.S = Iv{ (double)k, (double)k };
		a.T = Iv{ (double)k + V.lo - PAD, (double)k + V.hi + PAD };
		a.att[0] = Att{ true, 0 }; a.n = 1;
		if (axRefineT(a, a.T)) out.push_back(a);
	}
	if (S.hi > (double)k) {
		Iv S2{ std::max(S.lo, above((double)k)), S.hi };
		Iv T2{ S2.lo + V.lo - PAD, S2.hi + V.hi + PAD };
		Axis b = base; b.S = S2; b.T = T2;
		long M0 = (long)std::floor(T2.lo) + 1, M1 = (long)std::floor(T2.hi) + 1;
		for (long M = M0; M <= M1; M++) {
			Iv Tm = ivMeet(T2, Iv{ (double)(M - 1), below((double)M) });
			if (Tm.empty()) continue;
			Axis a = b;
			if (M - 1 >= k) { a.att[0] = Att{ true, 0 }; a.n = 1; }   // within the pixel: one final step
			else {
				int n = 0;
				a.att[n++] = Att{ false, (double)k };                // partial step to k
				for (long u = k - 1; u >= M && n < 22; u--) a.att[n++] = Att{ false, (double)u };
				a.att[n++] = Att{ true, 0 }; a.n = n;
			}
			if (axRefineT(a, Tm)) out.push_back(a);
		}
		// rounding: a 1 px step lands on Mp and the final step is a no-op there
		for (long Mp = (long)std::ceil(T2.lo); (double)Mp <= T2.hi && Mp <= k; Mp++) {
			Axis a = b;
			int n = 0;
			a.att[n++] = Att{ false, (double)k };
			for (long u = k - 1; u >= Mp && n < 22; u--) a.att[n++] = Att{ false, (double)u };
			a.att[n++] = Att{ false, (double)Mp }; a.n = n;
			if (axRefineT(a, Iv{ (double)Mp, (double)Mp })) out.push_back(a);
		}
	}
}

// ------------------------------------------------------------------ the movement loop over both axes
struct Out { Iv X, V, Y; double vy; bool grounded, donex; };
struct Cfg { Axis x, y; bool grounded; int phase; };
static long long statBranches = 0, statCfgs = 0, statSucc = 0, statVariants = 0;

// one attempt of axis `mv` (isX: the x axis) against the other axis' current position
// returns 0 = continue with c, 1 = dead; may push a branch onto the stack
static int attempt(Cfg& c, bool isX, double vy1, std::vector<Cfg>& stack, int nextPhase) {
	Axis& A = isX ? c.x : c.y;
	Axis& B = isX ? c.y : c.x;
	if (A.c >= A.n) return 0;
	const Att at = A.att[A.c];
	Iv cand = at.fin ? A.T : Iv{ at.pos, at.pos };
	Iv other = axPos(B);
	Test t = isX ? test2D(cand, other) : test2D(other, cand);
	Iv fA = isX ? t.fX : t.fY, cA = isX ? t.cX : t.cY, fB = isX ? t.fY : t.fX, cB = isX ? t.cY : t.cX;
	auto collide = [&](Cfg& d) -> bool {
		Axis& a = isX ? d.x : d.y; Axis& b = isX ? d.y : d.x;
		if (at.fin && !axRefineT(a, cA)) return false;
		if (!axRefinePos(b, cB)) return false;
		if (!isX && !a.done) d.grounded = vy1 > 0.0;
		a.done = true;
		return true;
	};
	auto freeStep = [&](Cfg& d) -> bool {
		Axis& a = isX ? d.x : d.y; Axis& b = isX ? d.y : d.x;
		if (at.fin) { if (!axRefineT(a, fA)) return false; a.mode = M_FINAL; }
		else { a.mode = M_EXACT; a.e = at.pos; }
		if (!axRefinePos(b, fB)) return false;
		a.c++;
		return true;
	};
	if (t.canFree && t.canColl) {
		statBranches++;
		Cfg d = c;
		if (collide(d)) { d.phase = nextPhase; stack.push_back(d); }
		return freeStep(c) ? 0 : 1;
	}
	if (t.canFree) return freeStep(c) ? 0 : 1;
	return collide(c) ? 0 : 1;
}

static void runLoop(std::vector<Cfg>& stack, double vy1, std::vector<Out>& outs) {
	while (!stack.empty()) {
		Cfg c = stack.back(); stack.pop_back();
		statCfgs++;
		bool dead = false;
		for (;;) {
			if (c.phase == 0) { if (attempt(c, true, vy1, stack, 1)) { dead = true; break; } c.phase = 1; }
			if (c.phase == 1) { if (attempt(c, false, vy1, stack, 2)) { dead = true; break; } c.phase = 2; }
			if (c.phase == 2) {
				if ((c.x.c < c.x.n && !c.x.done) || (c.y.c < c.y.n && !c.y.done)) { c.phase = 0; continue; }
				break;
			}
		}
		if (dead) continue;
		Out o;
		o.X = axPos(c.x);
		o.V = c.x.done ? Iv{ 0.0, 0.0 } : c.x.V;
		o.Y = axPos(c.y);
		o.vy = c.y.done ? 0.0 : vy1;
		o.grounded = c.grounded; o.donex = c.x.done;
		outs.push_back(o);
	}
}

// ------------------------------------------------------------------ auto-align (EESim._playerTick, no x input, |vx| < 1)
static double alignX(double px) {
	double tx = px > 0.0 ? px - 16.0 * std::floor(px * 0.0625) : std::fmod(px, 16.0);
	if (tx < 2.0) {
		if (tx < 0.2) px = std::trunc(px);
		else px -= tx / 15.0;
	} else if (tx > 14.0) {
		if (tx > 15.8) { px = std::trunc(px); px += 1.0; }
		else px += (tx - 14.0) / 15.0;
	}
	return px;
}
static bool meetsMod16(Iv X, double a, double b) {
	double q0 = std::floor(X.lo / 16.0), q1 = std::floor(X.hi / 16.0);
	for (double q = q0; q <= q1; q++) if (!ivMeet(X, Iv{ 16.0 * q + a, 16.0 * q + b }).empty()) return true;
	return false;
}

// the engine's final position of a collision-free move from p at speed v (EESim stepx / stepy arithmetic)
static double finalExact(double p, double v) {
	double rem = fmod1(p), cs = v;
	int n = 0;
	while (cs != 0.0 && n++ < 24) {
		if (cs > 0.0) {
			if (cs + rem >= 1.0) { p += 1.0 - rem; p = std::trunc(p); cs -= (1.0 - rem); rem = 0.0; }
			else { p += cs; cs = 0.0; }
		} else {
			if (rem + cs < 0.0 && rem != 0.0) { p -= rem; p = std::trunc(p); cs += rem; rem = 1.0; }
			else { p += cs; cs = 0.0; }
		}
	}
	return p;
}
// can a box anywhere in X x Y touch a solid (or leave the world)?
static bool sweptAir(Iv X, Iv Y) {
	if (X.lo < 0.0 || Y.lo < 0.0 || X.hi > LV.maxX || Y.hi > LV.maxY) return false;
	int x0 = (int)std::floor(X.lo / 16.0), x1 = (int)std::floor((X.hi + 16.0) / 16.0);
	int y0 = (int)std::floor(Y.lo / 16.0), y1 = (int)std::floor((Y.hi + 16.0) / 16.0);
	x1 = std::min(x1, LV.W - 1); y1 = std::min(y1, LV.H - 1);
	for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) if (LV.solid(x, y)) return false;
	return true;
}
static long long statFast = 0;

// ------------------------------------------------------------------ successors of one box under one x input
struct Succ { Iv X, V, Y; double vy, olo, oLhi; bool grounded; };
static void successors(Iv P0, Iv Y0, Iv V0, double olo0, double oLhi0, double vy, int h, std::vector<Succ>& res) {
	res.clear();
	double vy1 = G(vy);
	double Va = F(V0.lo, h), Vb = F(V0.hi, h);
	double dOlo = std::min(0.0, Va), dOhi = std::max(0.0, Vb);
	static std::vector<std::pair<Iv, bool>> vp;   // speed pieces
	vp.clear();   // sign classes (|v| < 1e-4 is exactly 0), |v| < 1 for the align
	bool al = h == 0;
	if (Va <= -0.0001) {
		Iv n{ Va, std::min(Vb, -0.0001) };
		if (al) {
			Iv n1 = ivMeet(n, Iv{ -1e300, -1.0 }), n2 = ivMeet(n, Iv{ above(-1.0), 1e300 });
			if (!n1.empty()) vp.push_back({ n1, false });
			if (!n2.empty()) vp.push_back({ n2, true });
		} else vp.push_back({ n, false });
	}
	if (Va <= 0.0 && Vb >= 0.0) vp.push_back({ Iv{ 0.0, 0.0 }, al });
	if (Vb >= 0.0001) {
		Iv p{ std::max(Va, 0.0001), Vb };
		if (al) {
			Iv p1 = ivMeet(p, Iv{ -1e300, below(1.0) }), p2 = ivMeet(p, Iv{ 1.0, 1e300 });
			if (!p1.empty()) vp.push_back({ p1, true });
			if (!p2.empty()) vp.push_back({ p2, false });
		} else vp.push_back({ p, false });
	}
	static std::vector<Axis> ys, xs;
	ys.clear();
	axisVariants(Y0, Iv{ vy1, vy1 }, ys);
	static std::vector<Cfg> stack;
	static std::vector<Out> outs;
	stack.clear();
	for (auto& pr : vp) {
		xs.clear(); outs.clear();
		{   // fast path: nothing to hit anywhere on the way (the steps are monotone, so start and end bound them)
			const Iv& Vp = pr.first;
			Iv X1 = (P0.lo == P0.hi && Vp.lo == Vp.hi) ? Iv{ finalExact(P0.lo, Vp.lo), finalExact(P0.lo, Vp.lo) } : Iv{ P0.lo + Vp.lo - PAD, P0.hi + Vp.hi + PAD };
			Iv Y1 = Y0.lo == Y0.hi ? Iv{ finalExact(Y0.lo, vy1), finalExact(Y0.lo, vy1) } : Iv{ Y0.lo + vy1 - PAD, Y0.hi + vy1 + PAD };
			if (sweptAir(ivJoin(P0, X1), ivJoin(Y0, Y1))) {
				statFast++;
				Out o; o.X = X1; o.V = Vp; o.Y = Y1; o.vy = vy1; o.grounded = false; o.donex = false;
				outs.push_back(o);
				goto post;
			}
		}
		axisVariants(P0, pr.first, xs);
		statVariants += (long long)(xs.size() * ys.size());
		for (const Axis& ax : xs)
			for (const Axis& ay : ys) {
				Cfg c; c.x = ax; c.y = ay; c.grounded = false; c.phase = 0;
				stack.push_back(c);
			}
		runLoop(stack, vy1, outs);
	post:
		for (const Out& o : outs) {
			bool aligned = h == 0 && (o.donex || pr.second);
			Iv X = o.X;
			double dlo = 0.0, dhi = 0.0;
			if (aligned) {
				Iv Xa{ alignX(X.lo) - PAD, alignX(X.hi) + PAD };
				if (meetsMod16(X, 0.0, 2.0)) dlo = -0.2 - PAD;
				if (meetsMod16(X, 14.0, 16.0)) dhi = 0.2 + PAD;
				X = Xa;
			}
			Succ s;
			s.X = X; s.V = o.V; s.Y = o.Y; s.vy = o.vy; s.grounded = o.grounded;
			if (o.donex) { s.olo = X.lo; s.oLhi = X.hi; }
			else {
				s.olo = std::max(olo0 + dOlo + dlo, X.lo - Dc(std::max(s.V.hi, 0.0)));
				s.oLhi = std::min(oLhi0 + dOhi + dhi, X.hi + Dc(std::max(-s.V.lo, 0.0)));
			}
			res.push_back(s);
			statSucc++;
		}
	}
}

// ------------------------------------------------------------------ the reach field's cut-off (--reach: a proof of its own)
static const ee::ReachField* RF = nullptr;       // host copy (beamhost.h ReachGpu::parse), physics mode only
static std::vector<double> rfMods;              // the distinct modMin of the air-like ids the gravity queue can hold
static std::vector<std::vector<ee::RfPre>> rfPres;   // per vy id: the lookup's position-independent parts, per queue
static long long statPruned = 0;
static const std::vector<ee::RfPre>& presOf(uint32_t vid) {
	while (rfPres.size() <= vid) rfPres.emplace_back();
	std::vector<ee::RfPre>& v = rfPres[vid];
	if (v.empty()) {
		// (rfPre with the modifiers of every queue (q0, q1) the level can give; slippery 0: no ice in scope)
		for (double m0 : rfMods) for (double m1 : rfMods) {
			ee::RfPre p;
			p.m0 = m0; p.m1 = m1; p.nIce = 0;
			const double vy = vys[vid].vy;
			p.fall = ee::rfFallD(*RF, vy > 0 ? vy : 0);
			p.rise = ee::rfRiseQ(*RF, vy, m0, m1, 0);
			v.push_back(p);
		}
	}
	return v;
}
/** true when the reach field cuts off every state with speed vys[vid], px in X, py in Y (the same centre tile). The
 *  lookup (beam.h rfFifthsAt, nIce 0) is min(base, max(R, X)): cut when base (or no base: rising) and R are cut for
 *  every level the piece's heights give (k and q are monotone in the centre's height, so the ends bound them). */
static bool reachCut(uint32_t vid, Iv X, Iv Y) {
	const int tx0 = ((int)std::trunc(X.lo + 8.0)) >> 4, tx1 = ((int)std::trunc(X.hi + 8.0)) >> 4;
	const int ty0 = ((int)std::trunc(Y.lo + 8.0)) >> 4, ty1 = ((int)std::trunc(Y.hi + 8.0)) >> 4;
	if (tx0 != tx1 || ty0 != ty1 || tx0 < 0 || ty0 < 0 || tx0 >= LV.W || ty0 >= LV.H) return false;
	if (LV.goal(tx0, ty0)) return false;   // (a finish: never dropped)
	const ee::ReachField& R = *RF;
	const int t = ty0 * R.W + tx0;
	const int g = R.cls[t];
	if (g == ee::RF_WALL) return true;
	if (g != ee::RF_NORM) return false;
	const double vy = vys[vid].vy, top = 16.0 * ty0;
	const double cyLo = Y.lo + 8.0, cyHi = Y.hi + 8.0;
	const bool hasBase = !(vy < 0);
	const bool lid = ty0 == 0 || R.cls[t - R.W] == ee::RF_WALL;
	for (const ee::RfPre& pre : presOf(vid)) {
		if (hasBase) {
			const int kLo = ee::rfKOfX(pre.fall + (top + 16 - cyHi)), kHi = ee::rfKOfX(pre.fall + (top + 16 - cyLo));
			const bool useF = !(cyLo > top + 8), useL = cyHi > top + 8;
			for (int k = kLo; k <= kHi; k++) {
				if (useF && ee::rfCost(R, t, 1, k) != ee::RF_CUT) return false;
				if (useL && ee::rfCost(R, t, 4, k) != ee::RF_CUT) return false;
			}
			if (!(pre.rise > 0)) continue;
		}
		int qLo = ee::rfQOf(R, top - (cyHi - pre.rise)), qHi = ee::rfQOf(R, top - (cyLo - pre.rise));
		if (lid) { qLo = std::min(qLo, 0); qHi = std::min(qHi, 0); }
		for (int q = qLo; q <= qHi; q++) if (ee::rfCost(R, t, 0, q) != ee::RF_CUT) return false;
	}
	return true;
}

// ------------------------------------------------------------------ cells
static double DV = 1.0;   // vx bin width (--dv=N: 1 / N)
static int WX = 1, WY = 1;
struct Cell { double pa, pb, ya, yb, va, vb, olo, oLhi; uint32_t vid; int kx, ky, b; bool queued; uint8_t gx, gy, gv, go; uint32_t parent; int8_t pin; };
static uint32_t curParent = ~0u; static int curInput = -9;
static std::vector<Cell> cells;
static std::vector<uint64_t> htKeys; static std::vector<uint32_t> htVal; static size_t htMask = 0, htCount = 0;
static uint64_t mix64(uint64_t x) { x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull; x ^= x >> 33; return x; }
static void htInit(size_t cap) { htKeys.assign(cap, ~0ull); htVal.assign(cap, 0); htMask = cap - 1; htCount = 0; }
static void htPut(uint64_t k, uint32_t v);
static void htGrow() {
	std::vector<uint64_t> ok = std::move(htKeys); std::vector<uint32_t> ov = std::move(htVal);
	htInit(ok.size() * 2);
	for (size_t i = 0; i < ok.size(); i++) if (ok[i] != ~0ull) htPut(ok[i], ov[i]);
}
static void htPut(uint64_t k, uint32_t v) {
	if ((htCount + 1) * 2 > htMask + 1) htGrow();
	size_t i = mix64(k) & htMask;
	while (htKeys[i] != ~0ull) { if (htKeys[i] == k) { htVal[i] = v; return; } i = (i + 1) & htMask; }
	htKeys[i] = k; htVal[i] = v; htCount++;
}
static int64_t htGet(uint64_t k) {
	size_t i = mix64(k) & htMask;
	while (htKeys[i] != ~0ull) { if (htKeys[i] == k) return htVal[i]; i = (i + 1) & htMask; }
	return -1;
}
static uint64_t cellKey(uint32_t vid, long ky, long kx, long b) {
	return ((uint64_t)vid << 40) | ((uint64_t)(ky & 0x3FFF) << 26) | ((uint64_t)(kx & 0x3FFF) << 12) | (uint64_t)((b + 2048) & 0xFFF);
}

static std::vector<uint32_t> queue; static size_t qHead = 0;
static bool reachedGoal = false;
static long long statInserts = 0, statGrow = 0;
static std::vector<uint8_t> reachTile;

static double snapDown(double x, double g) { return std::floor(x * g) / g; }
static double snapUp(double x, double g) { return std::ceil(x * g) / g; }

static void markCentre(const Cell& c) {
	int cx0 = ((int)std::trunc(c.pa + 8.0)) >> 4, cx1 = ((int)std::trunc(c.pb + 8.0)) >> 4;
	int cy0 = ((int)std::trunc(c.ya + 8.0)) >> 4, cy1 = ((int)std::trunc(c.yb + 8.0)) >> 4;
	for (int cy = cy0; cy <= cy1; cy++)
		for (int cx = cx0; cx <= cx1; cx++) {
			if (LV.goal(cx, cy)) reachedGoal = true;
			if (cx >= 0 && cy >= 0 && cx < LV.W && cy < LV.H) reachTile[(size_t)cy * LV.W + cx] = 1;
		}
}

static void insert(uint32_t vid, Iv X, Iv Y, Iv V, double olo, double oLhi) {
	if (X.empty() || V.empty() || Y.empty()) return;
	long ky0 = (long)std::floor(Y.lo / WY), ky1 = (long)std::floor(Y.hi / WY);
	long kx0 = (long)std::floor(X.lo / WX), kx1 = (long)std::floor(X.hi / WX);
	long b0 = (long)std::floor(V.lo / DV), b1 = (long)std::floor(V.hi / DV);
	for (long ky = ky0; ky <= ky1; ky++) {
		Iv Yk = ivMeet(Y, Iv{ (double)(ky * WY), below((double)((ky + 1) * WY)) });
		if (Yk.empty()) continue;
		for (long kx = kx0; kx <= kx1; kx++) {
			Iv Xk = ivMeet(X, Iv{ (double)(kx * WX), below((double)((kx + 1) * WX)) });
			if (Xk.empty()) continue;
			Iv Yq = Yk;
			if (!sweptAir(Xk, Yq)) {   // the engine never leaves the ball overlapping a solid: keep the free positions only
				Test ft = test2D(Xk, Yq);
				if (!ft.canFree) continue;
				Xk = ivMeet(Xk, ft.fX); Yq = ivMeet(Yq, ft.fY);
				if (Xk.empty() || Yq.empty()) continue;
			}
			if (RF && reachCut(vid, Xk, Yq)) { statPruned++; continue; }   // (--reach: the field proves these out of reach)
			for (long b = b0; b <= b1; b++) {
				Iv Vb = ivMeet(V, Iv{ b * DV, below((b + 1) * DV) });
				if (Vb.empty()) continue;
				double vlo = Vb.lo, vhi = Vb.hi;
				{ double r = Xk.hi - olo; if (r < -1e-7) continue; if (vhi > 0.0) vhi = std::min(vhi, Dinv(std::max(r, 0.0))); }
				{ double r = oLhi - Xk.lo; if (r < -1e-7) continue; if (vlo < 0.0) vlo = std::max(vlo, -Dinv(std::max(r, 0.0))); }
				if (vlo > vhi) continue;
				double xlo = std::max(Xk.lo, olo + Dc(std::max(vlo, 0.0)) - 1e-9);
				double xhi = std::min(Xk.hi, oLhi - Dc(std::max(-vhi, 0.0)) + 1e-9);
				if (xlo > xhi) continue;
				double ol = std::max(olo, xlo - Dc(std::max(vhi, 0.0)));
				double oh = std::min(oLhi, xhi + Dc(std::max(-vlo, 0.0)));
				statInserts++;
				uint64_t key = cellKey(vid, ky, kx, b);
				int64_t ci = htGet(key);
				double cxl = (double)(kx * WX), cxh = below((double)((kx + 1) * WX));
				double cyl = (double)(ky * WY), cyh = below((double)((ky + 1) * WY));
				double cvl = b * DV, cvh = below((b + 1) * DV);
				if (ci < 0) {
					Cell c; c.vid = vid; c.kx = (int)kx; c.ky = (int)ky; c.b = (int)b;
					c.pa = xlo; c.pb = xhi; c.ya = Yq.lo; c.yb = Yq.hi; c.va = vlo; c.vb = vhi;
					c.olo = snapDown(ol, 1048576.0); c.oLhi = snapUp(oh, 1048576.0);
					c.queued = true; c.gx = c.gy = c.gv = c.go = 0; c.parent = curParent; c.pin = (int8_t)curInput;
					uint32_t id = (uint32_t)cells.size();
					cells.push_back(c); htPut(key, id); queue.push_back(id);
					markCentre(cells[id]);
				} else {
					Cell& c = cells[(size_t)ci];
					bool gX = xlo < c.pa || xhi > c.pb, gY = Yq.lo < c.ya || Yq.hi > c.yb, gV = vlo < c.va || vhi > c.vb, gO = ol < c.olo || oh > c.oLhi;
					if (!gX && !gY && !gV && !gO) continue;
					// grow, widening each dimension in steps (exact first, then coarser grids, then the whole cell) so the
					// fixpoint ends; widened parts that are impossible (inside solids, beyond the run-up bound) are cut again
					auto bump = [](uint8_t& g) { if (g < 255) g++; };
					if (gX) bump(c.gx);
					if (gY) bump(c.gy);
					if (gV) bump(c.gv);
					if (gO) bump(c.go);
					auto grid = [](int g, double fine, double mid) { return g <= 6 ? 0.0 : g <= 12 ? fine : g <= 20 ? mid : -1.0; };
					double gpx = grid(c.gx, 65536.0, 256.0), gpy = grid(c.gy, 65536.0, 256.0), gvv = grid(c.gv, 1048576.0, 4096.0);
					double gov = c.go <= 12 ? 1048576.0 : c.go <= 30 ? 4096.0 : 64.0;
					auto lo = [](double m, double gr, double cell) { return gr == 0 ? m : gr < 0 ? cell : std::max(cell, snapDown(m, gr)); };
					auto hi = [](double m, double gr, double cell) { return gr == 0 ? m : gr < 0 ? cell : std::min(cell, snapUp(m, gr)); };
					Iv hX{ std::min(c.pa, xlo), std::max(c.pb, xhi) }, hY{ std::min(c.ya, Yq.lo), std::max(c.yb, Yq.hi) };
					Iv nX{ lo(hX.lo, gpx, cxl), hi(hX.hi, gpx, cxh) }, nY{ lo(hY.lo, gpy, cyl), hi(hY.hi, gpy, cyh) };
					if (nX.lo < hX.lo || nX.hi > hX.hi || nY.lo < hY.lo || nY.hi > hY.hi) {
						Test ft = test2D(nX, nY);
						if (ft.canFree) { nX = ivJoin(hX, ivMeet(nX, ft.fX)); nY = ivJoin(hY, ivMeet(nY, ft.fY)); } else { nX = hX; nY = hY; }
					}
					bool growP = nX.lo < c.pa || nX.hi > c.pb || nY.lo < c.ya || nY.hi > c.yb;
					c.pa = nX.lo; c.pb = nX.hi; c.ya = nY.lo; c.yb = nY.hi;
					if (ol < c.olo) c.olo = snapDown(ol, gov);
					if (oh > c.oLhi) c.oLhi = snapUp(oh, gov);
					double hva = std::min(c.va, vlo), hvb = std::max(c.vb, vhi);
					double wva = lo(hva, gvv, cvl), wvb = hi(hvb, gvv, cvh);
					double tvb = Dinv(std::max(c.pb - c.olo, 0.0)), tva = -Dinv(std::max(c.oLhi - c.pa, 0.0));
					c.vb = std::max(hvb, std::min(wvb, tvb));
					c.va = std::min(hva, std::max(wva, tva));
					statGrow++;
					if (growP) { c.parent = curParent; c.pin = (int8_t)curInput; markCentre(c); }
					if (!c.queued) { c.queued = true; queue.push_back((uint32_t)ci); }
				}
			}
		}
	}
}

static void pieces(Iv I, std::vector<Iv>& out) {   // split at whole pixels
	out.clear();
	for (long k = (long)std::floor(I.lo); (double)k <= I.hi; k++) {
		Iv p = ivMeet(I, Iv{ (double)k, below((double)(k + 1)) });
		if (!p.empty()) out.push_back(p);
	}
}

static void process(uint32_t ci) {
	Cell c = cells[ci];
	cells[ci].queued = false;
	double vy = vys[c.vid].vy;
	static std::vector<Succ> ss;
	static std::vector<Iv> px, py;
	pieces(Iv{ c.pa, c.pb }, px);
	pieces(Iv{ c.ya, c.yb }, py);
	uint32_t jid = vyId(JUMPV);
	for (const Iv& P : px)
		for (const Iv& Y : py)
			for (int h = -1; h <= 1; h++) {
				successors(P, Y, Iv{ c.va, c.vb }, c.olo, c.oLhi, vy, h, ss);
				curParent = ci;
				for (const Succ& s : ss) {
					curInput = h * 2;
					insert(vyId(s.vy), s.X, s.Y, s.V, s.olo, s.oLhi);
					curInput = h * 2 + 1;
					if (s.grounded) insert(jid, s.X, s.Y, s.V, s.olo, s.oLhi);
				}
			}
}

// every concrete state of a known route (lines "px py vx vy", hex doubles, tick by tick) must lie in a cell
static void checkStates(const char* statesFile) {
	FILE* f = fopen(statesFile, "rb");
	if (!f) { printf("{\"ev\":\"route\",\"error\":\"cannot read the states file\"}\n"); return; }
	static char buf[512];
	int t = 0, missing = 0, firstMiss = -1;
	while (fgets(buf, sizeof buf, f)) {
		char a[4][32];
		if (sscanf(buf, "%31s %31s %31s %31s", a[0], a[1], a[2], a[3]) != 4) continue;
		double px = hexd(a[0]), py = hexd(a[1]), vx = hexd(a[2]), vy = hexd(a[3]);
		auto it = vyIdx.find(bitsOf(vy));
		bool ok = false;
		if (it != vyIdx.end()) {
			long ky = (long)std::floor(py / WY), kx = (long)std::floor(px / WX), b = (long)std::floor(vx / DV);
			int64_t ci = htGet(cellKey(it->second, ky, kx, b));
			if (ci >= 0) {
				const Cell& c = cells[(size_t)ci];
				double o = px - Dc(std::max(vx, 0.0)), oL = px + Dc(std::max(-vx, 0.0));
				ok = px >= c.pa && px <= c.pb && py >= c.ya && py <= c.yb && vx >= c.va && vx <= c.vb && o >= c.olo && oL <= c.oLhi;
			}
		}
		if (!ok) { missing++; if (firstMiss < 0) { firstMiss = t; fprintf(stderr, "route state %d NOT contained: px %.17g py %.17g vx %.17g vy %.17g\n", t, px, py, vx, vy); } }
		t++;
	}
	fclose(f);
	printf("{\"ev\":\"route\",\"states\":%d,\"missing\":%d,\"firstMissing\":%d}\n", t, missing, firstMiss);
}
static void dumpChain(uint32_t id) {
	int n = 0;
	while (id != ~0u && n++ < 400) {
		const Cell& c = cells[id];
		fprintf(stderr, "  #%u in %d  px [%.6f %.6f] py [%.6f %.6f] vx [%.5f %.5f] vy %.6f o [%.3f %.3f]\n", id, c.pin, c.pa, c.pb, c.ya, c.yb, c.va, c.vb, vys[c.vid].vy, c.olo, c.oLhi);
		id = c.parent;
	}
}

static void initEngine() {
	BASE_DRAG = hexd("6accf435f866ef3f");
	NO_MOD_DRAG = hexd("1db5c8e6e3f1ec3f");
	JUMPV = ((0.0 - 2.0) * 26.0 * 1.0) / MULT;
	buildD();
}

/** the fixpoint from the level's start; opts as eegpu prove's. Prints the done line (and the route line). */
static int run(int argc, char** argv) {
	const long long maxCells = atoll(opt(argc, argv, "maxCells", "6000000").c_str());
	const double seconds = atof(opt(argc, argv, "seconds", "30").c_str());
	const std::string mapFile = opt(argc, argv, "map", ""), statesFile = opt(argc, argv, "states", "");
	const bool noStop = opt(argc, argv, "noStop", "0") == "1";
	int traceX = -1, traceY = -1;
	sscanf(opt(argc, argv, "trace", "-1,-1").c_str(), "%d,%d", &traceX, &traceY);
	DV = 1.0 / std::max(1e-9, atof(opt(argc, argv, "dv", "1").c_str()));
	WX = std::max(1, atoi(opt(argc, argv, "wx", "1").c_str()));
	WY = std::max(1, atoi(opt(argc, argv, "wy", "1").c_str()));
	auto t0 = std::chrono::steady_clock::now();
	htInit(1 << 20);
	reachTile.assign((size_t)LV.W * LV.H, 0);
	insert(vyId(LV.svy0), Iv{ LV.sx0, LV.sx0 }, Iv{ LV.sy0, LV.sy0 }, Iv{ LV.svx0, LV.svx0 },
		LV.sx0 - Dc(std::max(LV.svx0, 0.0)), LV.sx0 + Dc(std::max(-LV.svx0, 0.0)));
	long long processed = 0;
	const char* end = "fixpoint";
	double lastLog = 0;
	while (qHead < queue.size()) {
		if (reachedGoal && !noStop) break;
		uint32_t ci = queue[qHead++];
		if (qHead > (1u << 22) && qHead * 2 > queue.size()) { queue.erase(queue.begin(), queue.begin() + qHead); qHead = 0; }
		process(ci);
		processed++;
		if ((processed & 0x3FF) == 0) {
			double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
			if (sec - lastLog >= 2) {
				lastLog = sec;
				fprintf(stderr, "[prove] %.1fs processed %lld cells %zu vys %zu queue %zu pruned %lld\n", sec, processed, cells.size(), vys.size(), queue.size() - qHead, statPruned);
			}
			if (sec > seconds) { end = "time"; break; }
			if ((long long)cells.size() > maxCells) { end = "cells"; break; }
		}
	}
	if (reachedGoal && strcmp(end, "fixpoint") == 0) end = "goal";
	if (!statesFile.empty()) checkStates(statesFile.c_str());
	if (traceX >= 0) {
		for (uint32_t i = 0; i < cells.size(); i++) {
			const Cell& c = cells[i];
			int cx0 = ((int)std::trunc(c.pa + 8.0)) >> 4, cx1 = ((int)std::trunc(c.pb + 8.0)) >> 4, cy0 = ((int)std::trunc(c.ya + 8.0)) >> 4, cy1 = ((int)std::trunc(c.yb + 8.0)) >> 4;
			if (traceX >= cx0 && traceX <= cx1 && traceY >= cy0 && traceY <= cy1) { fprintf(stderr, "TRACE cell %u\n", i); dumpChain(i); break; }
		}
	}
	double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
	const char* verdict = !strcmp(end, "fixpoint") ? "impossible" : !strcmp(end, "goal") ? "reached" : "limit";
	int nt = 0; for (auto v : reachTile) nt += v;
	// explanation data: the highest point the ball reaches, the reachable centre tile nearest to a trophy, the speeds
	double minPy = 1e300, maxVr = 0, maxVl = 0;
	for (const Cell& c : cells) { minPy = std::min(minPy, c.ya); maxVr = std::max(maxVr, c.vb); maxVl = std::max(maxVl, -c.va); }
	std::vector<int> goals;
	for (int i = 0; i < LV.W * LV.H; i++) if (LV.cls[(size_t)i] == 2) goals.push_back(i);
	int nx = -1, ny = -1, gx = -1, gy = -1; double nd = 1e300;
	long long work = 0;
	for (int y = 0; y < LV.H && work < 400000000LL; y++) for (int x = 0; x < LV.W; x++) {
		if (!reachTile[(size_t)y * LV.W + x]) continue;
		for (int gi : goals) {
			const int xx = gi % LV.W, yy = gi / LV.W;
			double d = std::hypot((double)(x - xx), (double)(y - yy));
			if (d < nd) { nd = d; nx = x; ny = y; gx = xx; gy = yy; }
		}
		work += (long long)goals.size();
	}
	const int sxT = ((int)std::trunc(LV.sx0 + 8.0)) >> 4, syT = ((int)std::trunc(LV.sy0 + 8.0)) >> 4;
	fprintf(stderr, "[stats] fast %lld cfgs %lld tests %lld (interval %lld) succ %lld variants %lld pruned %lld\n", statFast, statCfgs, statTests, statTestsIv, statSucc, statVariants, statPruned);
	printf("{\"ev\":\"done\",\"verdict\":\"%s\",\"end\":\"%s\",\"sec\":%.3f,\"cells\":%zu,\"vys\":%zu,\"processed\":%lld,\"inserts\":%lld,\"grows\":%lld,"
		"\"branches\":%lld,\"tiles\":%d,\"pruned\":%lld,\"reach\":%d,\"dv\":%g,\"wx\":%d,\"wy\":%d,"
		"\"explain\":{\"topY\":%.6f,\"maxVxRight\":%.6f,\"maxVxLeft\":%.6f,\"nearest\":[%d,%d],\"nearestDist\":%.6f,\"trophy\":[%d,%d],\"start\":[%d,%d],\"size\":[%d,%d]}}\n",
		verdict, end, sec, cells.size(), vys.size(), processed, statInserts, statGrow, statBranches, nt, statPruned, RF ? 1 : 0, 1.0 / DV, WX, WY,
		cells.empty() ? -1.0 : minPy, maxVr, maxVl, nx, ny, nd >= 1e300 ? -1.0 : nd, gx, gy, sxT, syT, LV.W, LV.H);
	fflush(stdout);
	if (!mapFile.empty()) {
		FILE* f = fopen(mapFile.c_str(), "wb");
		if (f) {
			for (int y = 0; y < LV.H; y++) {
				for (int x = 0; x < LV.W; x++) {
					uint8_t c = LV.cls[(size_t)y * LV.W + x];
					char ch = c == 1 ? '#' : c == 2 ? 'T' : '.';
					if (reachTile[(size_t)y * LV.W + x]) ch = c == 2 ? '!' : 'o';
					fputc(ch, f);
				}
				fputc('\n', f);
			}
			fclose(f);
		}
	}
	return 0;
}

// --check=<cases>: per case "C pa pb ya yb va vb vy h j n" (hex doubles) then n lines "S px py vx vy px' py' vx' vy'"
// (the concrete engine's successor under mask h / j). The box's o-bounds are taken from the samples.
static int check(const char* casesFile) {
	FILE* f = fopen(casesFile, "rb");
	if (!f) { printf("{\"error\":\"cannot read the cases file\"}\n"); return 1; }
	static char buf[4096];
	long long cases = 0, samples = 0, bad = 0, badO = 0, succTotal = 0;
	double maxW = 0, sumW = 0;
	std::vector<Succ> ss;
	int shown = 0;
	long long dBad = 0;
	// the run-up distance's property: D(F(v)) <= D(v) + F(v) (and its mirror) for every input's speed update
	for (int i = 0; i <= 200000; i++) {
		double v = 7.0 * i / 200000.0;
		for (int h = -1; h <= 1; h++) {
			double fv = F(v, h);
			double S = Dc(std::max(v, 0.0)) + fv - Dc(std::max(fv, 0.0));
			if (S < std::min(0.0, fv)) dBad++;
			double vm = -v, fm = F(vm, h);
			double Sm = Dc(std::max(-vm, 0.0)) - fm - Dc(std::max(-fm, 0.0));
			if (Sm < std::min(0.0, -fm)) dBad++;
		}
	}
	while (fgets(buf, sizeof buf, f)) {
		if (buf[0] != 'C') continue;
		char a[8][32]; int h, j, n;
		if (sscanf(buf + 2, "%31s %31s %31s %31s %31s %31s %31s %d %d %d", a[0], a[1], a[2], a[3], a[4], a[5], a[6], &h, &j, &n) != 10) continue;
		Iv P{ hexd(a[0]), hexd(a[1]) }, Y{ hexd(a[2]), hexd(a[3]) }, V{ hexd(a[4]), hexd(a[5]) };
		double vy = hexd(a[6]);
		std::vector<std::array<double, 8>> sm;
		double olo = 1e300, oLhi = -1e300;
		for (int i = 0; i < n; i++) {
			if (!fgets(buf, sizeof buf, f)) break;
			char s[8][32];
			sscanf(buf + 2, "%31s %31s %31s %31s %31s %31s %31s %31s", s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
			std::array<double, 8> r; for (int q = 0; q < 8; q++) r[q] = hexd(s[q]);
			sm.push_back(r);
			olo = std::min(olo, r[0] - Dc(std::max(r[2], 0.0)));
			oLhi = std::max(oLhi, r[0] + Dc(std::max(-r[2], 0.0)));
		}
		cases++;
		// the prover splits boxes at whole pixels before the transfer (process()); do the same
		std::vector<Iv> px, py;
		pieces(P, px); pieces(Y, py);
		std::vector<Succ> all;
		for (const Iv& pp : px) for (const Iv& yy : py) {
			successors(pp, yy, V, olo, oLhi, vy, h, ss);
			for (auto s : ss) { if (j && s.grounded) s.vy = JUMPV; all.push_back(s); }
		}
		succTotal += (long long)all.size();
		for (auto& s : all) { maxW = std::max(maxW, s.X.hi - s.X.lo); sumW += s.X.hi - s.X.lo; }
		for (auto& r : sm) {
			samples++;
			bool ok = false, okNoO = false;
			for (auto& s : all) {
				if (bitsOf(s.vy) != bitsOf(r[7])) continue;
				if (!(r[4] >= s.X.lo && r[4] <= s.X.hi && r[5] >= s.Y.lo && r[5] <= s.Y.hi && r[6] >= s.V.lo && r[6] <= s.V.hi)) continue;
				okNoO = true;
				double o = r[4] - Dc(std::max(r[6], 0.0)), oL = r[4] + Dc(std::max(-r[6], 0.0));
				if (o >= s.olo && oL <= s.oLhi) { ok = true; break; }
			}
			if (!okNoO || !ok) {
				if (!okNoO) bad++; else badO++;
				if (shown++ < 12) {
					fprintf(stderr, "%s case %lld: P [%.17g, %.17g] Y [%.17g, %.17g] V [%.17g, %.17g] vy %.17g h %d j %d | sample (%.17g %.17g %.17g) -> (%.17g %.17g %.17g %.17g)\n",
						okNoO ? "OBOUND" : "MISS", cases, P.lo, P.hi, Y.lo, Y.hi, V.lo, V.hi, vy, h, j, r[0], r[1], r[2], r[4], r[5], r[6], r[7]);
					for (auto& s : all) fprintf(stderr, "   succ X [%.17g, %.17g] Y [%.17g, %.17g] V [%.17g, %.17g] vy %.17g g %d o [%.9f %.9f]\n", s.X.lo, s.X.hi, s.Y.lo, s.Y.hi, s.V.lo, s.V.hi, s.vy, s.grounded, s.olo, s.oLhi);
				}
			}
		}
	}
	fclose(f);
	printf("{\"ev\":\"check\",\"cases\":%lld,\"samples\":%lld,\"missed\":%lld,\"oBoundViolations\":%lld,\"dPropertyViolations\":%lld,\"succPerCase\":%.2f,\"maxSuccWidth\":%.4f,\"meanSuccWidth\":%.4f}\n",
		cases, samples, bad, badO, dBad, cases ? (double)succTotal / cases : 0.0, maxW, succTotal ? sumW / succTotal : 0.0);
	return bad || badO || dBad ? 3 : 0;
}

}  // namespace prv

// ------------------------------------------------------------------ eegpu prove: the level from the blob, the scope
/** the air-like ids (EESim: not solid, default gravity, no effect of their own on the ball's movement) and the goal */
static const int PROVE_AIRLIKE[] = { 0, 255, 121, 5, 100, 101, 110, 111, 360 };
static const int PROVE_GOAL = 121, PROVE_ICE = 1064, PROVE_OV_AIR = 0, PROVE_OV_SOLID = 1;
static int cmdProve(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: eegpu prove <level.bin> [--reach=<file>] [--seconds=30] [--maxCells=N] [--map=] [--noStop --states=] [--check=<cases>]\n"); return 2; }
	LevelBlob B = readLevel(argv[2]);
	Level L = B.level(B.bytes.data());
	std::vector<std::string> why;
	std::vector<int> badIds;
	prv::LV = prv::PLevel();
	prv::LV.W = L.W; prv::LV.H = L.H; prv::LV.maxX = L.maxX; prv::LV.maxY = L.maxY; prv::LV.gm = B.gravityMult;
	prv::LV.cls.assign((size_t)L.W * L.H, 0);
	auto airLike = [](int t) { for (int a : PROVE_AIRLIKE) if (a == t) return true; return false; };
	// every air-like id must have the default gravity of block 0 (the model has one gravity: the engine's default)
	auto sameGravity = [&](int t) {
		return t >= 0 && t < L.nFlags && L.gMorx[t] == L.gMorx[0] && L.gMory[t] == L.gMory[0] && L.gMox[t] == L.gMox[0] && L.gMoy[t] == L.gMoy[0] && L.gFlags[t] == L.gFlags[0];
	};
	int goals = 0;
	std::vector<int> used;
	for (int i = 0; i < L.W * L.H; i++) {
		const int t = L.fg[i];
		uint8_t c;
		if (t == PROVE_GOAL && L.ovl[i] == PROVE_OV_AIR && sameGravity(t)) { c = 2; goals++; }
		else if (airLike(t) && L.ovl[i] == PROVE_OV_AIR && sameGravity(t)) c = 0;
		else if (L.ovl[i] == PROVE_OV_SOLID && t != PROVE_ICE) c = 1;
		else { c = 0; if (std::find(badIds.begin(), badIds.end(), t) == badIds.end()) badIds.push_back(t); }
		if (c != 1 && std::find(used.begin(), used.end(), t) == used.end()) used.push_back(t);
		prv::LV.cls[(size_t)i] = c;
	}
	if (!badIds.empty()) {
		std::sort(badIds.begin(), badIds.end());
		std::string s = "blocks";
		for (size_t k = 0; k < badIds.size() && k < 20; k++) s += (k ? "," : " ") + std::to_string(badIds[k]);
		if (badIds.size() > 20) s += ",...";
		why.push_back(s);
	}
	if (!(B.gravityMult == 1.0)) why.push_back("world gravity");
	if (L.W > 1024 || L.H > 1024) why.push_back("larger than 1024 x 1024 tiles");
	if (goals == 0) why.push_back("no trophy");
	// the start: Sim::reset from the blob, like every other command
	HState* st = (HState*)calloc(1, sizeof(HState));
	HSim sim(L, *st);
	sim.reset(B.coinBits0(B.bytes.data()), B.rngSeed);
	const HState& s = *st;
	if (s.in_god_mode || s.is_dead || s.has_levitation || s.max_jumps != 1 || s.jump_boost || s.speed_boost || s.low_gravity || s.flip_gravity != 0 || s.is_zombie ||
		s.is_cursed || s.is_poisoned || s.is_on_fire) why.push_back("start effects");
	prv::LV.sx0 = s.px; prv::LV.sy0 = s.py; prv::LV.svx0 = s.speed_x; prv::LV.svy0 = s.speed_y;
	free(st);
	prv::initThresholds();
	// the model keeps only positions where the ball overlaps no solid (true of every state a tick produces: a colliding
	// step is undone, the auto-align never pushes into a block); a start inside a block (no spawn block and a solid at
	// tile (1, 1)) breaks that
	if (why.empty() && prv::collideExact(prv::LV.sx0, prv::LV.sy0)) why.push_back("the start overlaps a block");
	if (!why.empty()) {
		std::string w;
		for (size_t k = 0; k < why.size(); k++) w += (k ? "; " : "") + why[k];
		printf("{\"ev\":\"done\",\"verdict\":\"unsupported\",\"why\":%s}\n", jsonStr(w).c_str());
		return 0;
	}
	prv::initEngine();
	const std::string casesFile = opt(argc, argv, "check", "");
	if (!casesFile.empty()) return prv::check(casesFile.c_str());
	// --reach: the reach field's host copy (never uploaded: no GPU), physics mode only, and only the field of this very
	// level: its cut-offs are a proof about the level it was made for, and another level's (the same walls, the trophy
	// elsewhere) dropped user50's route (the header's fingerprint = src/gpu.js blobFp of this blob; 0 = none given)
	ReachGpu rg;
	const std::string reachFile = opt(argc, argv, "reach", "");
	if (!reachFile.empty()) {
		std::string err;
		uint64_t fpFile = 0, fpLevel = 0xcbf29ce484222325ull;
		for (uint8_t c : B.bytes) { fpLevel ^= c; fpLevel *= 0x100000001b3ull; }
		if (!rg.parse(reachFile, L, err)) printf("{\"ev\":\"warning\",\"text\":%s}\n", jsonStr("the reach field is not used: " + err).c_str());
		else if (memcpy(&fpFile, &rg.raw[56], 8), fpFile != fpLevel)
			printf("{\"ev\":\"warning\",\"text\":%s}\n", jsonStr(fpFile ? "the reach field is not used: it was made for another level" : "the reach field is not used: it names no level (written without the level's fingerprint)").c_str());
		else if (rg.H.mode == 0) {
			prv::RF = &rg.H;
			// the queue's modifiers: every air-like id the level holds, and block 0 (Sim::reset's queue)
			if (std::find(used.begin(), used.end(), 0) == used.end()) used.push_back(0);
			for (int t : used) {
				const double m = t >= 0 && t < rg.H.nFlags ? rg.H.modMin[t] : rg.H.MOD_STRONG;
				bool seen = false;
				for (double x : prv::rfMods) if (x == m) seen = true;
				if (!seen) prv::rfMods.push_back(m);
			}
			// (a second guard: the caller runs a proof only when the field finds a way from the start, so a field that
			// cuts the start off is not this level's; its cut-offs are not used)
			if (prv::reachCut(prv::vyId(prv::LV.svy0), prv::Iv{ prv::LV.sx0, prv::LV.sx0 }, prv::Iv{ prv::LV.sy0, prv::LV.sy0 })) {
				printf("{\"ev\":\"warning\",\"text\":%s}\n", jsonStr("the reach field is not used: it cuts off the start").c_str());
				prv::RF = nullptr;
			}
		}
	}
	return prv::run(argc, argv);
}
