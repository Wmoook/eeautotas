// exact.h - THE EXACT LAYERED SEARCH on the GPU (`eegpu exact`, native/exacthost.h; its own kernel module
// native/exactkernels.cu -> eegpu_exact_<tw>.ptx, so the app's kernels (kernels.cu) stay as they are). Shared by the
// kernels and the host (the host runs the same h on the CPU for `eegpu exacth --cpu=1`).
//
// The search (box 8 lane 'gpuproof', 2026-10-01): for a level and a layer bound Cl (= the run-tick limit C + 1: a finish
// at layer d is a route of d - 1 run ticks, tools/perfect/wholepar.js's convention), breadth first by layers over EXACT
// engine states (eecore.h, == src/eesim.js): layer 0 = the idle starts (the timer starts at the first input: waiting is
// free), layer d + 1 = every child of layer d under the 18 inputs (search.h option(); an input bit the parent's tick did
// not read gives its lower option's very state: canonOption, not simulated; from layer 0 option 0 is the next idle start,
// itself in layer 0); a child is
//   - a FINISH when it holds the silver crown: the first layer with one is the optimum (every lower layer was complete);
//   - CUT when d + 1 + h > Cl, h the admissible ticks to the crown (xhOf below: tables from the CPU, tools/perfect/gpuh.js,
//     the max of tiers the CPU prover uses; the least cut d + 1 + h is the next contour: IDA*'s rule);
//   - MERGED when the visited set holds its state (a copy seen at a layer <= this one: breadth first, so the first copy
//     is the earliest; dominance: its future is the same, one layer or more sooner); the set's key is the state's two
//     independent hashes of the SAME key stream as EESim.stateHash (Sim::hash: the 53-bit stateHash itself, Sim::hash2: a
//     64-bit FNV-1a), 117 bits; a slot collision is probed on (open addressing), never overwritten;
//   - else NEW: (parent, option) appended to the next layer's links; the host re-simulates it into the next layer.
// Deaths are moves (a dead child is a state like any other; h knows the respawn). A layer that ends with no open state
// and no finish PROVES that no route takes <= Cl - 1 run ticks (and >= the next contour - 1).
// Every bound tier is admissible on its own (bounds.js / wholeproof.js's proofs), a max of them too; dropping a tier
// only weakens the cut. A table miss (an unknown door state) falls back to the rel tier: weaker, still sound.
#pragma once
#include "eecore.h"
#include "search.h"
#include "beam.h"   // (ReachField, reachFifths: the kin tier's reach cut, levelproof.js contextOf)

namespace ee {

// bounds.js constants (the same doubles)
#define XH_D_TICK 16.25
#define XH_SLACK 2.0
#define XH_EPS 1e-6
#define XH_SIGW 8            // the door-state signature's words (up to 256 door classes; more: the gate tier is off)
EE_HD double xhInf() { return bitsToDouble(0x7ff0000000000000ull); }
EE_HD bool xhIsInf(double v) { return doubleToBits(v) == 0x7ff0000000000000ull; }

/** one bounds.js field (bounds.field + its META) as float32 tile tables: f = the tile value (Infinity: no way), iso /
 *  ax / ay / axp / ayp = the META arrays at() refines with (null when the level's tiers lack them) */
struct HField { const float* f; const float* iso; const float* ax; const float* ay; const float* axp; const float* ayp; };

/** THE KIN TIER: src/endgame.js lowerBound (the kinematic envelope, walls ignored, portals through its portal field; its
 *  boundContext B exported by gpuh.js), the same double operations in the same order (levelproof.js contextOf's kin
 *  tier: lowerBound + 1, capped at DEATH_MIN + 1 + hResp where the ball can die) */
#define XK_D_TICK 16.25
#define XK_ALIGN 0.2
#define XK_EPS 1e-6
#define XK_FIELD_CAP 64
#define XK_RISE_N 256
#define XK_SQ 64
#define XK_BIG 1073741824
struct KinB {
	i32 on, W, H, nF, nT, tameLevel, halves, canDie, hasRun, hasFly, hasJump, hasFlip;
	const double* targets;      // nT x (x0, x1, y0, y1): the centre's cell as top-left ranges
	const u8* tameId;           // nF
	const i32* wildPS; const i32* icePS; const i32* boostPS; const i32* gxPS; const i32* gyPS; const i32* jxPS; const i32* jyPS;
	const u8* portal;           // N (null: no portal)
	const u8* trigQ;            // N (null: no portal)
	const i32* trigPS;
	const double* rise;         // 3 x (XK_RISE_N + 1): riseTable for jump_boost 0 / 1 / 2 (the tame physics' jv)
	double wgm, modY, alignY, mory0, gmaxG;
	double riseJv[3];
};
struct GpuH {
	i32 W, H, N, nF;
	i32 useIso, useAxis, usePlain, gate, nCls, sigWords;
	double vxp, vxn, vyp, vyn;          // bounds.js vmax
	double pxp, pxn, pyp, pyn;          // bounds.js vplain (usePlain)
	double deadRel;                     // max(1, the least rel value at a respawn tile) (Infinity: none)
	double hResp;                       // levelproof.js contextOf hResp (the kin tier's)
	const u8* mechId;                   // nF + 1: bounds.js S.mechId
	const u8* mechT;                    // N: S.mechT
	HField rel;
	// the order tier: the door classes (a door tile's passability reads its id and lookup0 only: eecore.h doorPassable)
	const i32* clsVal; const i32* clsTile; const i32* clsKey;   // per class: the id, a tile of it, its key bit (levelNow keeps a key door open while its key is on)
	const i32* clsOfTile;               // N: the class of a door tile levelNow reads, else -1
	// the known door states: open addressing over sigMask + 1 slots (sigWords words each; sigField -1 = empty)
	u32 sigMask; const u32* sigKeys; const i32* sigField; const HField* gateF;
	// the misses of a layer (the host reads them, computes their fields when piped, and clears them)
	u32* missBits; u32 missBitMask; u32* missList; u32* nMiss; u32 missCap; u32 missSalt;
	KinB K;
	// THE REACH FIELD'S PROOF (levelproof.js contextOf, n5-b7-proof cycle 6): the RCH3 field (src/reach.js, physics mode)
	// gpuh.js writes into the tables' file; a live ball it calls cut off (-1) has h Infinity (R.on 0: none)
	ReachField R;
};

// ---------------------------------------------------------------- the kin tier (src/endgame.js, line for line)
EE_HD i32 xkRect(const KinB& B, const i32* ps, i32 x0, i32 x1, i32 y0, i32 y1) {
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > B.W - 1) x1 = B.W - 1;
	if (y1 > B.H - 1) y1 = B.H - 1;
	if (x0 > x1 || y0 > y1) return 0;
	const i32 W1 = B.W + 1;
	return ps[(y1 + 1) * W1 + x1 + 1] - ps[y0 * W1 + x1 + 1] - ps[(y1 + 1) * W1 + x0] + ps[y0 * W1 + x0];
}
EE_HD double xkFloor16(double v) { return floor((v + 8.0) / 16.0); }
EE_HD double xkFree(const KinB& B, double xl, double xr, double yu, double yd) {
	double best = xhInf();
	for (i32 k = 0; k < B.nT; k++) {
		const double* t = B.targets + 4 * k;
		double gx = t[0] - xr, a = xl - t[1];
		if (a > gx) gx = a;
		if (gx < 0) gx = 0;
		double gy = t[2] - yd, b = yu - t[3];
		if (b > gy) gy = b;
		if (gy < 0) gy = 0;
		const double n = ceil((gx > gy ? gx : gy) / XK_D_TICK);
		if (n < best) best = n;
	}
	if (B.portal && best > 0) {
		const i32 W = B.W, H = B.H;
		auto cl = [](double v, i32 hi) { double c = v; if (c > hi) c = hi; if (c < 0) c = 0; return (i32)c; };
		const i32 x0 = cl(xkFloor16(xl), W - 1), x1 = cl(xkFloor16(xr), W - 1), y0 = cl(xkFloor16(yu), H - 1), y1 = cl(xkFloor16(yd), H - 1);
		i32 m;
		if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) {
			m = XK_FIELD_CAP;
			for (i32 y = y0; y <= y1; y++) for (i32 x = x0; x <= x1; x++) if (B.portal[y * W + x] < m) m = B.portal[y * W + x];
		} else {
			const i32 mx = (x0 + x1) >> 1, my = (y0 + y1) >> 1;
			i32 e = x1 - mx; if (mx - x0 > e) e = mx - x0; if (y1 - my > e) e = y1 - my; if (my - y0 > e) e = my - y0;
			m = (i32)B.portal[my * W + mx] - e;
			if (m < 0) m = 0;
		}
		if ((double)m < best) best = (double)m;
	}
	return best;
}
EE_HD bool xkTameCells(const KinB& B, i32 x0, i32 x1, i32 y0, i32 y1) {
	const i32 h = B.halves;
	return xkRect(B, B.wildPS, x0 - h, x1, y0 - h, y1) == 0 && xkRect(B, B.icePS, x0 - h, x1, y0 - h + 1, y1 + 1) == 0;
}
/** trigMin: the smallest Q of the portal entries triggered from the cells, XK_BIG when none */
EE_HD i32 xkTrigMin(const KinB& B, i32 x0, i32 x1, i32 y0, i32 y1) {
	if (xkRect(B, B.trigPS, x0, x1, y0, y1) == 0) return XK_BIG;
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > B.W - 1) x1 = B.W - 1;
	if (y1 > B.H - 1) y1 = B.H - 1;
	i32 m = XK_BIG;
	for (i32 y = y0; y <= y1; y++) for (i32 x = x0; x <= x1; x++) { const i32 q = B.trigQ[y * B.W + x]; if (q != 0 && q < m) m = q; }
	return m;
}
EE_HD i32 xkTrigMinNew(const KinB& B, i32 x0, i32 x1, i32 y0, i32 y1, i32 a0, i32 a1, i32 b0, i32 b1) {
	i32 m = XK_BIG, v;
	if (b0 < y0) { v = xkTrigMin(B, a0, a1, b0, y0 - 1); if (v < m) m = v; }
	if (b1 > y1) { v = xkTrigMin(B, a0, a1, y1 + 1, b1); if (v < m) m = v; }
	if (a0 < x0) { v = xkTrigMin(B, a0, x0 - 1, y0, y1); if (v < m) m = v; }
	if (a1 > x1) { v = xkTrigMin(B, x1 + 1, a1, y0, y1); if (v < m) m = v; }
	return m;
}
EE_HD bool xkHits(const KinB& B, double xl, double xr, double yu, double yd) {
	for (i32 k = 0; k < B.nT; k++) {
		const double* t = B.targets + 4 * k;
		if (xr >= t[0] && xl < t[1] && yd >= t[2] && yu < t[3]) return true;
	}
	return false;
}
EE_HD double xkStepX(double v, i32 h) {
	const double mx = h < 0 ? (0.0 + -1.0) / MULT : h > 0 ? (0.0 + 1.0) / MULT : (0.0 + 0.0) / MULT;
	if (v == 0 && mx == 0) return 0;
	double sx = v + mx;
	if (h == 0 || (sx < 0 && h > 0) || (sx > 0 && h < 0)) { sx *= EE_BASE_DRAG; sx *= EE_NO_MOD_DRAG; } else sx *= EE_BASE_DRAG;
	if (sx > 16) sx = 16; else if (sx < -16) sx = -16; else if (sx < 0.0001 && sx > -0.0001) sx = 0;
	return sx;
}
EE_HD double xkStepY(const KinB& B, double v) {
	double sy = v + B.modY;
	sy *= EE_BASE_DRAG;
	if (sy > 16) sy = 16; else if (sy < -16) sy = -16; else if (sy < 0.0001 && sy > -0.0001) sy = 0;
	return sy;
}
EE_HD double xkMax3(double a, double b, double c) { double m = a; if (b > m) m = b; if (c > m) m = c; return m; }
EE_HD double xkMin3(double a, double b, double c) { double m = a; if (b < m) m = b; if (c < m) m = c; return m; }
EE_HD bool xkQg(const Level& L, const double* t, i32 q) { return q < L.nFlags && (q < 0 || t[q] != 0); }
template <int TW>
EE_HD double xkGeneral(const KinB& B, const Level& L, const State<TW>& s, i32 j, double xl, double xr, double yu, double yd, double ux, double uy, double best) {
	const double sm = B.hasRun || s.speed_boost == 1 ? 1.5 : 1.0;
	const double thr = B.hasFly || s.has_levitation ? (0.2 * (JUMP_HEIGHT / 2) * 1.0) / MULT : 0;
	const double Jv = (2 * JUMP_HEIGHT * (B.hasJump || s.jump_boost == 1 ? 1.3 : 1.0)) / MULT;
	const bool rot = B.hasFlip || s.flip_gravity != 0;
	const i32 q0 = s.q0, q1 = s.q1;
	const i32 h = B.halves;
	i32 x0 = (i32)xkFloor16(xl), x1 = (i32)xkFloor16(xr), y0 = (i32)xkFloor16(yu), y1 = (i32)xkFloor16(yd);
	double Mx = 0, My = 0, Jx = 0, Jy = 0;
	auto region = [&]() -> bool {
		if (xkRect(B, B.boostPS, x0 - h, x1, y0 - h, y1) != 0) return false;
		bool gx = xkQg(L, L.gMox, q0) || xkQg(L, L.gMox, q1) || xkRect(B, B.gxPS, x0 - h, x1, y0 - h, y1) != 0;
		bool gy = xkQg(L, L.gMoy, q0) || xkQg(L, L.gMoy, q1) || xkRect(B, B.gyPS, x0 - h, x1, y0 - h, y1) != 0;
		bool jx = xkRect(B, B.jxPS, x0 - h, x1, y0 - h, y1) != 0, jy = xkRect(B, B.jyPS, x0 - h, x1, y0 - h, y1) != 0;
		if (rot) { gx = gy = gx || gy; jx = jy = jx || jy; }
		Mx = ((gx ? B.gmaxG : 0) + sm) / MULT + XK_EPS;
		My = ((gy ? B.gmaxG : 0) + sm) / MULT + XK_EPS;
		Jx = jx ? Jv + thr + XK_EPS : 0;
		Jy = jy ? Jv + thr + XK_EPS : 0;
		return true;
	};
	if (!region()) { const double f = (double)j + xkFree(B, xl, xr, yu, yd); return f < best ? f : best; }
	for (double k = j + 1; k < best; k++) {
		double px = ux + Mx, py = uy + My;
		if (px > 16) px = 16;
		if (py > 16) py = 16;
		const double dx = px + XK_ALIGN + XK_EPS, dy = py + XK_ALIGN + XK_EPS;
		xl -= dx; xr += dx; yu -= dy; yd += dy;
		const double ax = px + (Jx > 0 ? thr : 0), ay = py + (Jy > 0 ? thr : 0);
		ux = ax > Jx ? ax : Jx;
		uy = ay > Jy ? ay : Jy;
		if (xkHits(B, xl, xr, yu, yd)) return k;
		const i32 a0 = (i32)xkFloor16(xl), a1 = (i32)xkFloor16(xr), b0 = (i32)xkFloor16(yu), b1 = (i32)xkFloor16(yd);
		if (a0 != x0 || a1 != x1 || b0 != y0 || b1 != y1) {
			const i32 na0 = x0 < a0 ? x0 : a0, na1 = x1 > a1 ? x1 : a1, nb0 = y0 < b0 ? y0 : b0, nb1 = y1 > b1 ? y1 : b1;
			if (B.trigQ && k + 1 < best) { const i32 t = xkTrigMinNew(B, x0, x1, y0, y1, na0, na1, nb0, nb1); if (t < XK_BIG && k + t < best) best = k + t; }
			x0 = na0; x1 = na1; y0 = nb0; y1 = nb1;
			if (!region()) { const double f = k + xkFree(B, xl, xr, yu, yd); return f < best ? f : best; }
		}
	}
	return best;
}
/** endgame.js lowerBound(B, sim, lim) */
template <int TW>
EE_HD double xkLowerBound(const KinB& B, const Level& L, const State<TW>& s, i32 lim) {
	const double px = s.px, py = s.py;
	const double h0 = xkFree(B, px, px, py, py);
	if (h0 > (double)lim || eq0(h0) || s.in_god_mode || s.is_dead) return h0;
	i32 cx0 = (i32)xkFloor16(px), cy0 = (i32)xkFloor16(py), cx1 = cx0, cy1 = cy0;
	double best = (double)lim + 1;
	if (B.trigQ) { const i32 t = xkTrigMin(B, cx0, cx1, cy0, cy1); if ((double)t < best) best = (double)t; }
	auto tameId = [&](i32 id) { return id >= 0 && id < B.nF && B.tameId[id] == 1; };
	if (!B.tameLevel || s.has_levitation || s.speed_boost != 0 || s.is_zombie || s.low_gravity || s.flip_gravity != 0 ||
		s.slippery > 0 || L.gravityMult != B.wgm || !tameId(s.q0) || !tameId(s.q1) || !xkTameCells(B, cx0, cx1, cy0, cy1)) {
		const double g = xkGeneral<TW>(B, L, s, 0, px, px, py, py, fabs(s.speed_x), fabs(s.speed_y), best);
		return h0 > g ? h0 : g;
	}
	double jm = 1.0;
	if (s.jump_boost == 1) jm *= 1.3;
	if (s.jump_boost == 2) jm *= 0.75;
	const double jv = ((0 - B.mory0) * JUMP_HEIGHT * jm) / MULT;
	const double* R = nullptr;
	i32 k0 = 0;
	double sq[XK_SQ];
	if (s.max_jumps <= 1 && lim < 256) {
		const i32 ri = s.jump_boost == 1 ? 1 : s.jump_boost == 2 ? 2 : 0;
		R = B.rise + (size_t)ri * (XK_RISE_N + 1);
		sq[0] = 0;
		for (double v = s.speed_y; k0 < XK_SQ - 1;) { v = xkStepY(B, v); if (!(v < 0)) break; k0++; sq[k0] = sq[k0 - 1] - v; }
		if (k0 >= XK_SQ - 1) R = nullptr;
	}
	double xl = px, xr = px, yu = py, yd = py, vl = s.speed_x, vr = vl, vu = s.speed_y, vd = vu;
	for (i32 j = 1; (double)j < best; j++) {
		const double sR = vr >= 0 ? xkStepX(vr, 1) : xkMax3(xkStepX(vr, -1), xkStepX(vr, 0), xkStepX(vr, 1));
		const double sL = vl <= 0 ? xkStepX(vl, -1) : xkMin3(xkStepX(vl, -1), xkStepX(vl, 0), xkStepX(vl, 1));
		xr += (sR > 0 ? sR : 0) + XK_ALIGN + XK_EPS;
		xl += (sL < 0 ? sL : 0) - XK_ALIGN - XK_EPS;
		vr = sR > 0 ? sR : 0;
		vl = sL < 0 ? sL : 0;
		const double sD = xkStepY(B, vd);
		yd += (sD > 0 ? sD : 0) + B.alignY + XK_EPS;
		vd = sD > 0 ? sD : 0;
		if (R) {
			double up = 0;
			if (k0 == 0) up = R[j];
			else { const i32 mm = j < k0 ? j : k0; for (i32 m = 1; m <= mm; m++) { const double u = sq[m] + R[j - m]; if (u > up) up = u; } }
			yu = py - up - j * (B.alignY + XK_EPS);
		} else {
			const double sU = xkStepY(B, vu);
			yu += (sU < 0 ? sU : 0) - B.alignY - XK_EPS;
			vu = sU < jv ? sU : jv;
		}
		if (xkHits(B, xl, xr, yu, yd)) return h0 > (double)j ? h0 : (double)j;
		const i32 a0 = (i32)xkFloor16(xl), a1 = (i32)xkFloor16(xr), b0 = (i32)xkFloor16(yu), b1 = (i32)xkFloor16(yd);
		if (a0 != cx0 || a1 != cx1 || b0 != cy0 || b1 != cy1) {
			if (B.trigQ && (double)(j + 1) < best) { const i32 t = xkTrigMinNew(B, cx0, cx1, cy0, cy1, a0, a1, b0, b1); if (t < XK_BIG && (double)(j + t) < best) best = (double)(j + t); }
			cx0 = a0; cx1 = a1; cy0 = b0; cy1 = b1;
			if (!xkTameCells(B, a0, a1, b0, b1)) {
				double uy = vd, aj = fabs(jv), c = R ? fabs(s.speed_y) : -vu;
				if (aj > uy) uy = aj;
				if (c > uy) uy = c;
				const double g = xkGeneral<TW>(B, L, s, j, xl, xr, yu, yd, vr > -vl ? vr : -vl, uy, best);
				return h0 > g ? h0 : g;
			}
		}
	}
	return h0 > best ? h0 : best;
}

/** bounds.js at(f, sim) for a live ball without its endgame part (the tile value, refined by the ball's own offset from
 *  its node: iso, axis, plain), the same double operations */
EE_HD double xhAt(const GpuH& G, const HField& F, i32 t, double dx, double dy, bool plain) {
	double v = (double)F.f[t];
	if (eq0(v) || xhIsInf(v)) return v;
	const double adx = fabs(dx), ady = fabs(dy);
	if (F.iso) {
		const double s = (double)F.iso[t];
		const double b = ceil((16.0 * s - (adx > ady ? adx : ady) - 8.0 - XH_SLACK) / XH_D_TICK - XH_EPS);
		if (b > v) v = b;
	}
	if (F.ax) {
		const double mx = G.vxp < G.vxn ? G.vxp : G.vxn, my = G.vyp < G.vyn ? G.vyp : G.vyn;
		const double bx = ceil((double)F.ax[t] - (dx > 0 ? dx / G.vxp : -dx / G.vxn) - (8.0 + XH_SLACK) / mx - XH_EPS);
		const double by = ceil((double)F.ay[t] - (dy > 0 ? dy / G.vyp : -dy / G.vyn) - (8.0 + XH_SLACK) / my - XH_EPS);
		if (bx > v) v = bx;
		if (by > v) v = by;
	}
	if (F.axp && plain) {
		const double mx = G.pxp < G.pxn ? G.pxp : G.pxn, my = G.pyp < G.pyn ? G.pyp : G.pyn;
		const double bx = ceil((double)F.axp[t] - (dx > 0 ? dx / G.pxp : -dx / G.pxn) - (8.0 + XH_SLACK) / mx - XH_EPS);
		const double by = ceil((double)F.ayp[t] - (dy > 0 ? dy / G.pyp : -dy / G.pyn) - (8.0 + XH_SLACK) / my - XH_EPS);
		if (bx > v) v = bx;
		if (by > v) v = by;
	}
	return v;
}

EE_HD u32 xhSigHash(const u32* w, i32 n, u32 salt) {
	u32 h = 0x811c9dc5u ^ salt;
	for (i32 i = 0; i < n; i++) { h ^= w[i]; h *= 0x01000193u; h ^= h >> 15; }
	return h;
}

/** the state's door signature (bit c: door class c is a wall in types.js levelNow's copy) */
template <int TW>
EE_HD void xhSig(const GpuH& G, Sim<TW>& sim, u32* sig) {
	for (i32 w = 0; w < XH_SIGW; w++) sig[w] = 0;
	for (i32 c = 0; c < G.nCls; c++) {
		if ((sim.s.keysMask & G.clsKey[c]) != 0) continue;
		if (!sim.doorPassable(G.clsVal[c], G.clsTile[c])) sig[c >> 5] |= 1u << (c & 31);
	}
}

/** wholeproof.js createH's h (the rel and order tiers): max(rel at, gate at) + 1 for a live ball (rel Infinity:
 *  Infinity), the rel tier's least respawn value + 1 for a dead one. gst (may be null): 0 no gate lookup, 1 a known door
 *  state, 2 a miss, 3 the box is in a door this state shuts (wholeproof.js inShut: no gate tier). */
template <int TW>
EE_HD double xhMine(const GpuH& G, Sim<TW>& sim, i32* gst) {
	const State<TW>& s = sim.s;
	if (s.is_dead) return xhIsInf(G.deadRel) ? G.deadRel : G.deadRel + 1.0;
	i32 x = truncI(s.px + 8.0) >> 4, y = truncI(s.py + 8.0) >> 4;
	if (x < 0) x = 0; else if (x >= G.W) x = G.W - 1;
	if (y < 0) y = 0; else if (y >= G.H) y = G.H - 1;
	const i32 t = y * G.W + x;
	const double dx = s.px - 16.0 * (double)x, dy = s.py - 16.0 * (double)y;
	bool plain = false;
	if (G.usePlain) {
		plain = s.speed_boost != 1 && s.jump_boost != 1 && s.flip_gravity == 0 && !s.has_levitation && !(s.slippery > 0) &&
			fabs(s.speed_x) <= G.pxp && s.speed_y <= G.pyp && -s.speed_y <= G.pyn &&
			!(s.q0 >= 0 && s.q0 < G.nF && G.mechId[s.q0]) && !(s.q1 >= 0 && s.q1 < G.nF && G.mechId[s.q1]) && !G.mechT[t];
	}
	double v = xhAt(G, G.rel, t, dx, dy, plain);
	if (xhIsInf(v)) return v;
	if (G.gate) {
		u32 sig[XH_SIGW];
		xhSig<TW>(G, sim, sig);
		// (inShut: the box overlaps a door tile this state shuts: no gate tier)
		bool shut = false;
		const i32 x0 = (i32)floor(s.px / 16.0), x1 = (i32)floor((s.px + 15.999) / 16.0), y0 = (i32)floor(s.py / 16.0), y1 = (i32)floor((s.py + 15.999) / 16.0);
		for (i32 yy = y0; yy <= y1 && !shut; yy++) for (i32 xx = x0; xx <= x1; xx++) {
			if (xx < 0 || yy < 0 || xx >= G.W || yy >= G.H) continue;
			const i32 c = G.clsOfTile[yy * G.W + xx];
			if (c >= 0 && ((sig[c >> 5] >> (c & 31)) & 1u)) { shut = true; break; }
		}
		if (shut) { if (gst) *gst = 3; }
		else {
			u32 slot = xhSigHash(sig, G.sigWords, 0) & G.sigMask;
			i32 k = -1;
			for (u32 p = 0; p <= G.sigMask; p++) {
				const i32 fi = G.sigField[slot];
				if (fi < 0) break;
				bool eq = true;
				for (i32 w = 0; w < G.sigWords; w++) if (G.sigKeys[(size_t)slot * G.sigWords + w] != sig[w]) { eq = false; break; }
				if (eq) { k = fi; break; }
				slot = (slot + 1) & G.sigMask;
			}
			if (k >= 0) {
				if (gst) *gst = 1;
				const double a = xhAt(G, G.gateF[k], t, dx, dy, plain);
				if (a > v) v = a;
			} else {
				if (gst) *gst = 2;
#if EE_GPU
				// (a miss: listed once per layer for the host; a door state whose hash bit is taken this layer is listed on
				// a later layer, the host salts the hash per layer)
				if (G.missBits) {
					const u32 hb = xhSigHash(sig, G.sigWords, G.missSalt) & G.missBitMask;
					const u32 m = 1u << (hb & 31);
					if (!(atomicOr(&G.missBits[hb >> 5], m) & m)) {
						const u32 q = atomicAdd(G.nMiss, 1u);
						if (q < G.missCap) for (i32 w = 0; w < G.sigWords; w++) G.missList[(size_t)q * G.sigWords + w] = sig[w];
					}
				}
#endif
			}
		}
	}
	return xhIsInf(v) ? v : v + 1.0;
}

/** h(state, lim): the admissible ticks until has_silver_crown (Infinity: never), tools/perfect/wholepar.js makeCtx(L,
 *  {kin, rel, gate}).h(sim, lim) line for line: the kin tier (levelproof.js contextOf: a dead ball's ticks left + hResp + 1,
 *  else Infinity where the reach field calls the ball cut off, else endgame.lowerBound + 1 capped at DEATH_MIN + 1 + hResp
 *  where it can die; above lim it is the answer: only "above lim" matters then), then the max with createH's (xhMine).
 *  gst: xhMine's (4: cut by the reach field). */
template <int TW>
EE_HD double xhOf(const GpuH& G, const Level& L, Sim<TW>& sim, i32 lim, i32* gst) {
	const State<TW>& s = sim.s;
	if (gst) *gst = 0;
	if (s.has_silver_crown) return 0;
	double v = 0;
	if (G.K.on) {
		if (s.is_dead) {
			double left = floor((16.0 - s.dead_offset) / 0.3 - 1e-9);
			if (left < 0) left = 0;
			v = left + G.hResp + 1.0;
		} else {
			// (reach.js costAt(f, sim) < 0 <=> fifthsAt(f, px, py, speed_y, _q0, _q1, _slippery) == -1 = beam.h reachFifths)
			if (G.R.on && reachFifths(G.R, s.px, s.py, s.speed_y, s.q0, s.q1, s.slippery) < 0) { if (gst) *gst = 4; return xhInf(); }
			v = xkLowerBound<TW>(G.K, L, s, lim) + 1.0;
			if (G.K.canDie && v > 54.0 + 1.0 + G.hResp) v = 54.0 + 1.0 + G.hResp;
		}
		if (v != floor(v)) v = ceil(v - 0.01);
		if (v > (double)lim) return v;
	}
	const double a = xhMine<TW>(G, sim, gst);
	return a > v ? a : v;
}

/** The kernels' parameters (exactkernels.cu): one layer's parents [lo, hi) (global indices; parents[i - base]) */
struct ExactParams {
	Level L;
	GpuH G;
	const u8* parents; i32 stateBytes; u32 base;
	u32 lo, hi;
	i32 layer;              // the parents' layer d
	i32 Cl;                 // the layer bound: a child at d + 1 with d + 1 + h > Cl is cut
	i32 deaths;             // 1: a dead child is a move (0: dropped; the verdict then says "without deaths")
	u64* table; u32 tableMask;   // the visited set: 2 words a slot (the 53-bit hash | bit 62, the 64-bit hash | 1)
	u32* layerOf;                // per slot: the least layer the state was entered at (0xffffffff: none; the depth-first stage's table)
	u32 probeMax;           // probes before an insert gives up (the state is then kept: no merge, sound)
	u64* picks; u32* nPick; u32 pickCap;   // expand: the new children, (global parent << 5 | option)
	u8* nextDirect; u32 directCap;         // expand: pick q < directCap's state written to nextDirect[q] (the next arena)
	// materialize: picks [lo, hi) of mpicks -> next[k - dstBase]
	const u64* mpicks; u8* next; u32 dstBase;
	unsigned long long* found;   // expand: (global parent << 5 | option) + 1 of a finish (0: none)
	u32* nextF;             // expand: the least d + 1 + h over the cut children (0xffffffff: none)
	unsigned long long* stats;   // expand: [0] children simulated, [1] twins, [2] dead, [3] cut, [4] merged, [5] new,
	                             // [6] broken, [7] table full, [8] gate hits, [9] gate misses, [10] gate shut, [11] h Infinity
};
static const int XS_NSTATS = 12;

/** THE DEPTH-FIRST STAGE (exactkernels.cu exactDfs): when the next layer would not fit in the GPU, the frontier (layer D)
 *  becomes the tasks of a depth-first search to the layer bound, one stack a thread (frames in global memory: the state,
 *  and a meta word: the next option, the twin flags), tasks taken from a shared counter, the visited set as THE SHARED
 *  TRANSPOSITION TABLE of tools/perfect/wholepar.js: a slot keeps the least layer it was entered at (layerOf, atomicMin);
 *  a state is pruned only when some thread entered it at a layer <= this one under the same bound (it searches it to the
 *  end, or the bound's search stops unproven): sound under any interleaving. The BFS layers before it entered their
 *  states at their least layers (breadth first). Launches of `budget` child steps a thread, the stacks kept between. */
struct DfsParams {
	Level L;
	GpuH G;
	const u8* tasks; i32 stateBytes; u32 nTasks;   // the frontier: layer D's states
	i32 D, Cl, deaths;
	u64* table; u32 tableMask, probeMax; u32* layerOf;
	u64* table2; u32 tableMask2; u32* layerOf2;      // a second table (null: none) where the first one's probes are full
	u8* stk; u64* meta; i32 maxDepth; u32 nThreads;   // frame k of thread t: stk + (t * maxDepth + k) * stateBytes
	i32* depth; u32* task;                           // per thread (-1: no task in hand)
	u32* taskNext;
	u32 budget;                                      // child steps a thread per launch
	i32 ttMinLim;                                    // the table only for children with lim >= this (default 2)
	unsigned long long* found;                       // the finder's task + 1
	i32* foundPath;                                  // [0] n, [1..n] the options from the task's state
	u32* nextF;
	unsigned long long* stats;
	u32* idle;                                       // threads that found no task left this launch
	u32* stop;                                       // 1: a finish was found
};
// meta word: bits 0-4 the next option, 5-9 the option 0 tick's used bits, 10-18 the jump bits, 19 a source (first moves)
EE_HD u64 xdMeta(i32 o, u32 used, u32 jumpUsed, bool first) { return (u64)o | ((u64)(used & 31) << 5) | ((u64)(jumpUsed & 0x1ff) << 10) | ((u64)(first ? 1 : 0) << 19); }

#if EE_GPU
/** the visited set's insert: 1 new (inserted), 0 there already (merged), 2 the probes ran out (kept, counted: sound);
 *  *slotOut = the key's slot (not for 2) */
__device__ __forceinline__ int xsInsert(u64* T, u32 mask, u32 probeMax, u64 a, u64 b, u32* slotOut) {
	u32 i = (u32)(splitmix(a ^ (b * 0x9e3779b97f4a7c15ull)) & mask);
	for (u32 p = 0; p < probeMax; p++) {
		unsigned long long* slot = (unsigned long long*)(T + 2 * (size_t)i);
		unsigned long long cur = *(volatile unsigned long long*)slot;
		if (cur == 0) {
			cur = atomicCAS(slot, 0ull, (unsigned long long)a);
			if (cur == 0) { atomicExch(slot + 1, (unsigned long long)b); *slotOut = i; return 1; }
		}
		if (cur == a) {
			// (b not written yet reads 0: another key here, at most a state kept twice; a different b: a 53-bit collision)
			const unsigned long long cb = *(volatile unsigned long long*)(slot + 1);
			if (cb == b) { *slotOut = i; return 0; }
		}
		i = (i + 1) & mask;
	}
	return 2;
}
#endif

}  // namespace ee
