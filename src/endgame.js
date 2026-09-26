'use strict';
// Exact endgame solver (branch and bound toward the trophy).
//
// From the exact state S(T) of a run at T = F - K (F = the tick the run finishes in) it tries EVERY input sequence,
// tick by tick: the 18 masks (masks whose left/right or up/down bits provably do nothing in a state give the same state
// and are simulated once, see MASK_SETS), states merged globally by stateHash (the hash leaves the clocks out, so a copy
// reached at an earlier depth dominates every later one), deaths dropped, and a state at depth d cut when
// d + h(s) + 1 > the depth budget, h being a lower bound on the ticks until the box centre is in a trophy cell
// (lowerBound(): it never overestimates). The complete fires in the tick after the centre is in the trophy cell (touchBlock
// reads the tick-start tile), so the first finishing depth is the fastest finish from S(T). A finish is an exact faster
// run (checked with a full C.evaluate and C.judge); a search that runs out of states is a proof that no input sequence
// from S(T) finishes faster without dying (up to 53-bit hash collisions: below n^2 / 2^54 for n states; a death costs
// 55+ ticks, so deaths cannot help while K <= 56). The goal is a region (the trophy cell), not an exact state, so this
// sees endings the exact-rejoin searches cannot (213: 2.36 -> 2.35, the last tick won by a 0.002 px margin).
//
// It runs as a K ladder (8, 16, 24, ... while the time lasts, the smallest K of any start first) from many starts: the
// run, and for a run inside a job the job's history (best_*.eetas), original.eetas and pieces/, each re-simulated to its
// own F' - K with the depth budget that beats the reference run. After a search reaches --cap open states, the K between
// that start's last proof and it are tried (bisection); larger K are not. A faster run found becomes the reference and
// a start itself.
//
// usage: node src/endgame.js --tas=<run.eetas> [--level=<level id | job id>] [--K=<max K> | --K=8,20,..] [--seconds=60]
//        [--out=<faster.eetas>] [--cap=300000] [--starts=<a.eetas,b.eetas,..>] [--others=1] [--deadline=<epoch ms>]
// (--level can be left out for a .eetas inside src/jobs/<id>/; --others=0: not the job's other runs.) Prints one JSON
// object per line (search, proof, found, gave_up, progress, done) and [ticks] lines; writes --out only when it finds a
// faster run. `node src/tas.js endgame <job> [K]` does the same for a job and hands the faster run in (J.tryCandidate).

const fs = require('fs');
const path = require('path');
const C = require('./common.js');
const E = C.E;

const BD = E.constants.BASE_DRAG, NMD = E.constants.NO_MOD_DRAG, MULT = E.constants.MULT;
const JUMP_HEIGHT = 26.0;                        // eesim.js JUMP_HEIGHT (Config.physics_jump_height)
const TROPHY = 121;
// eesim.js flag bits (level.flags / level.xflags)
const F_HALF = 8, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128, X_NONROT_HALF = 4;
const PORTAL = 242, PORTAL_INVISIBLE = 381, ICE = 1064;
// Blocks the kinematic bound does not model as the touched tile (besides gravity tables other than an empty tile's): the
// effects (speed, jump, gravity, flying, multijump, zombie, curse, poison, protection, team, reset), music blocks (a bad
// note ends the tick early) and the liquids. Ice matters as the tile below (slippery), portals through their exits.
const UNTAME = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618, 77, 83, 1520, 119, 369, 416, 1585]);
const D_TICK = 16.25;    // most the box moves along an axis in a tick without a teleport: |speed| <= 16 after the clamp,
                         // the auto-align moves < 0.2 px, plus rounding
const ALIGN = 0.2;       // the auto-align's largest shift (eesim.js _playerTick "auto align to grid")
const EPS = 1e-6;        // float rounding of the sub-steps, per tick
const FIELD_CAP = 64;    // the tile fields are exact up to here: a gap of 16 m px takes ceil(16 m / 16.25) = m ticks, m <= 64

// The masks worth simulating, by which input axes act in a state. The probe (right + down, no jump) comes first: after
// it, sim._mx / sim._my tell whether the horizontal / vertical input was read at all (Player.tick picks mx, my by the
// delayed tile and the gravity, never by the input, and speedMultiplier > 0), and while the run timer runs the input is
// read nowhere else, so masks that differ only in an unread axis give identical states. The first mask of each list is
// the probe with its unread bits dropped (the probe's state is that mask's state).
const MASK_SETS = (() => {
	const mk = (hs, vs) => {
		const probe = (hs.length > 1 ? 4 : 0) | (vs.length > 1 ? 16 : 0);
		const l = [probe];
		for (const j of [0, 1]) for (const h of hs) for (const v of vs) if ((h | v | j) !== probe) l.push(h | v | j);
		return Uint8Array.from(l);
	};
	return [mk([0], [0]), mk([0, 2, 4], [0]), mk([0], [0, 8, 16]), mk([0, 2, 4], [0, 8, 16])];
})();
const PROBE_MASK = 4 | 16;
/** Restores `snap`, plays the probe and returns the masks to expand (the first one = the state now in sim). */
function probeMasks(sim, inp, snap) {
	sim.restore(snap);
	const timerOn = sim.run_ticks !== 0 || sim.has_silver_crown;   // (before the timer runs, any input starts it)
	E.applyMask(inp, PROBE_MASK);
	sim.tick(inp);
	if (!timerOn) return MASK_SETS[3];
	return MASK_SETS[(sim._mx !== 0 ? 1 : 0) | (sim._my !== 0 ? 2 : 0)];
}

// ---------------------------------------------------------------- the lower bound
/**
 * Per level: the target cells, which tiles the kinematic bound models, the portal field. Target = a trophy cell, or a
 * half block whose touch goes to a trophy (eesim.js _playerTick: the centre's tile is replaced by the tile above
 * (rotation 1) or to the left (rotation 0) of a half block). opts.goals: other goal cells (tile indices) than the trophies
 * (the tests use them).
 */
function boundContext(level, opts) {
	const W = level.width, H = level.height, N = W * H, fg = level.fg, flags = level.flags, nF = flags.length;
	const fl = (id) => (id >= 0 && id < nF ? flags[id] : 0);
	let halves = false;
	for (let i = 0; i < N; i++) if ((fl(fg[i]) & F_HALF) !== 0) { halves = true; break; }
	/** the cells whose touch goes to cell (x, y): itself, and a half block below it (rotation 1) or right of it (0) */
	const touchers = (x, y) => {
		const l = [y * W + x];
		const half = (xx, yy, want) => {
			if (xx >= W || yy >= H) return;
			const i = yy * W + xx, id = fg[i];
			if ((fl(id) & F_HALF) === 0) return;
			const rot = (level.xflags[id] & X_NONROT_HALF) !== 0 ? 1 : level.lookup0[i];
			if (rot === want) l.push(i);
		};
		half(x, y + 1, 1);
		half(x + 1, y, 0);
		return l;
	};
	const cells = [];
	const goals = opts && opts.goals ? opts.goals.slice() : [];
	if (!goals.length) for (let i = 0; i < N; i++) if (fg[i] === TROPHY) goals.push(i);
	for (const i of goals) for (const c of touchers(i % W, (i - i % W) / W)) if (!cells.includes(c)) cells.push(c);
	// the centre's cell is (x, y) for top-left positions 16 x - 8 <= px < 16 x + 8 (the same for py)
	const targets = new Float64Array(cells.length * 4);
	cells.forEach((i, k) => {
		const x = i % W, y = (i - x) / W;
		targets.set([16 * x - 8, 16 * x + 8, 16 * y - 8, 16 * y + 8], k * 4);
	});
	// tiles whose physics is an empty tile's (same gravity tables; the kill flag is allowed: a death is dropped anyway)
	const g0x = level.gMox[0], g0y = level.gMoy[0], r0x = level.gMorx[0], r0y = level.gMory[0];
	const wgm = level.gravityMult;
	const tameLevel = g0x === 0 && g0y > 0 && r0x === 0 && r0y > 0 && Number.isFinite(wgm) && wgm > 0;
	const tameId = new Uint8Array(nF);
	for (let b = 0; b < nF; b++) {
		tameId[b] = tameLevel && level.gMox[b] === g0x && level.gMoy[b] === g0y && level.gMorx[b] === r0x && level.gMory[b] === r0y &&
			(flags[b] & (F_CLIMB | F_LIQUID | F_BOOST)) === 0 && !UNTAME.has(b) ? 1 : 0;
	}
	const wildPS = prefixSums(W, H, (i) => { const id = fg[i]; return !(id < nF && tameId[id]); });
	const icePS = prefixSums(W, H, (i) => fg[i] === ICE);
	const boostPS = prefixSums(W, H, (i) => fg[i] >= nF || (fl(fg[i]) & F_BOOST) !== 0);   // (and ids without tables: not modelled)
	// the speed of the modelled physics (eesim.js _playerTick with an empty tile's tables, flip_gravity 0, no effects):
	// modifier_y = (moy * gm + my) / MULT with my = 0, jump speed_y = ((0 - mory) * JUMP_HEIGHT * jm) / MULT
	const modY = (g0y * wgm + 0.0) / MULT;
	// the general physics (any tile but boosts, any effect): per axis |modifier| <= (|mo| * |gm| + |m| * speedMultiplier) /
	// MULT with |mo| <= the largest gravity table entry of the level's tiles (low gravity only makes it smaller), the
	// levitation thrust changes a speed by <= 0.2 * 13 * |mor| * 0.5 / MULT (|mor| <= 2), a jump sets it to
	// <= 2 * 26 * jm / MULT, drags are < 1, collisions and deaths set 0 (Player.as speed rules in eesim.js _playerTick)
	const ids = new Set(fg);
	ids.add(0);
	let gmax = 0;
	for (const id of ids) if (id < nF) gmax = Math.max(gmax, Math.abs(level.gMox[id]), Math.abs(level.gMoy[id]));
	// per axis, the cells whose tables pull (mo) or can push off (mor) along it (for the general bound)
	const g = (id, t) => id < nF && t[id] !== 0;
	const B = { W, H, N, fg, nF, cells, targets, tameLevel, tameId, wildPS, icePS, boostPS, halves: halves ? 1 : 0, wgm, modY, mory0: r0y,
		alignY: Math.abs(modY) < 0.11 ? ALIGN : 0,   // the y auto-align needs |modifier_y| < 0.1
		MX: [(0.0 + -1) / MULT, (0.0 + 0) / MULT, (0.0 + 1) / MULT], portal: null, trigQ: null, trigPS: null, rise: new Map(),
		riseJv: NaN, riseLast: null, sq: new Float64Array(64),
		gmaxG: gmax * (Number.isFinite(wgm) ? Math.abs(wgm) : Infinity), hasRun: ids.has(419), hasFly: ids.has(418), hasJump: ids.has(417),
		hasFlip: ids.has(1517), gMox: level.gMox, gMoy: level.gMoy, gMorx: level.gMorx, gMory: level.gMory,
		gxPS: prefixSums(W, H, (i) => g(fg[i], level.gMox)), gyPS: prefixSums(W, H, (i) => g(fg[i], level.gMoy)),
		jxPS: prefixSums(W, H, (i) => g(fg[i], level.gMorx)), jyPS: prefixSums(W, H, (i) => g(fg[i], level.gMory)) };
	portalField(level, B, touchers);
	return B;
}
/** 2D prefix sums of the cells where f(i) holds ((W + 1) x (H + 1)) */
function prefixSums(W, H, f) {
	const W1 = W + 1, ps = new Int32Array(W1 * (H + 1));
	for (let y = 0; y < H; y++) {
		let row = 0;
		for (let x = 0; x < W; x++) {
			if (f(y * W + x)) row++;
			ps[(y + 1) * W1 + x + 1] = ps[y * W1 + x + 1] + row;
		}
	}
	return ps;
}
/** cells counted in the prefix sums ps inside [x0, x1] x [y0, y1] (clipped to the world) */
function rectCount(B, ps, x0, x1, y0, y1) {
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > B.W - 1) x1 = B.W - 1;
	if (y1 > B.H - 1) y1 = B.H - 1;
	if (x0 > x1 || y0 > y1) return 0;
	const W1 = B.W + 1;
	return ps[(y1 + 1) * W1 + x1 + 1] - ps[y0 * W1 + x1 + 1] - ps[(y1 + 1) * W1 + x0] + ps[y0 * W1 + x0];
}

/**
 * Chebyshev distance field on the tiles (walls ignored) from sources [tile, cost], capped: min over sources of
 * cheb(tile, source) + cost. A bucket queue (costs are small integers).
 */
function chebField(W, H, sources, cap) {
	const N = W * H, d = new Int16Array(N).fill(cap);
	const buckets = [];
	for (let c = 0; c <= cap; c++) buckets.push([]);
	for (const [i, c] of sources) if (c < d[i]) { d[i] = c; buckets[c].push(i); }
	for (let c = 0; c < cap; c++) {
		const q = buckets[c];
		for (let k = 0; k < q.length; k++) {
			const i = q[k];
			if (d[i] !== c) continue;
			const x = i % W, y = (i - x) / W;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= H) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= W) continue;
					const j = yy * W + xx;
					if (d[j] > c + 1) { d[j] = c + 1; buckets[c + 1].push(j); }
				}
			}
		}
	}
	return d;
}
/**
 * Portals: a lower bound per tile on the ticks from "the centre is in this tile at the end of a tick" to "in a target
 * cell", for paths that use a portal (paths without one are bounded by the pixel distance, freeTicks). Without a teleport
 * the centre moves <= D_TICK px per axis per tick, so tiles m + 1 apart (Chebyshev) take >= m ticks (m <= FIELD_CAP);
 * a teleport (the tick after the centre is in an entry tile) leaves the centre within one tile of an exit. So
 * HT(t) = max(0, min over sources s (cheb(t, s) + c(s)) - 1) with the targets (c = 0) and every entry p
 * (c = Q(p) = max(1, min over its exits e of HT(e))), a fixpoint (Q only decreases). An entry is triggered from its
 * own cell and from a half block whose touch goes to it (the engine teleports by the touched tile). Every entry and
 * every exit of the level counts (EEO's random exit, a coin-deleted exit, the lastPortal rule only make real paths
 * slower). Sets B.portal (the field through portals only), B.trigQ (per cell: Q of the entries it triggers, 0 = none)
 * and B.trigPS (prefix sums of those cells).
 */
function portalField(level, B, touchers) {
	const W = B.W, H = B.H, fg = level.fg;
	const entries = [];
	if (level.portalSlot && level.portalsById) {
		for (let i = 0; i < B.N; i++) {
			const t = fg[i], s = level.portalSlot[i];
			if ((t !== PORTAL && t !== PORTAL_INVISIBLE) || s < 0 || level.pTarget[s] === level.pId[s]) continue;
			const ex = level.portalsById.get(level.pTarget[s]);
			if (!ex || ex.n === 0) continue;
			const exits = [];
			for (let k = 0; k < ex.n; k++) {
				const x = ex.xs[k] >> 4, y = ex.ys[k] >> 4;
				if (x >= 0 && y >= 0 && x < W && y < H) exits.push(y * W + x);
			}
			if (exits.length) entries.push({ trig: touchers(i % W, (i - i % W) / W), exits, q: FIELD_CAP });
		}
	}
	if (!entries.length) return;
	const src = () => { const l = []; for (const e of entries) for (const c of e.trig) l.push([c, e.q]); return l; };
	const tsrc = B.cells.map((i) => [i, 0]);
	for (let it = 0; it < 64; it++) {
		const g = chebField(W, H, tsrc.concat(src()), FIELD_CAP + 1);
		let changed = false;
		for (const e of entries) {
			let m = FIELD_CAP;
			for (const x of e.exits) m = Math.min(m, Math.max(0, g[x] - 1));
			const q = Math.max(1, m);
			if (q < e.q) { e.q = q; changed = true; }
		}
		if (!changed) break;
	}
	const gp = chebField(W, H, src(), FIELD_CAP + 1);
	const f = new Uint8Array(B.N);
	for (let i = 0; i < B.N; i++) f[i] = Math.min(FIELD_CAP, Math.max(0, gp[i] - 1));
	const trigQ = new Uint8Array(B.N);
	for (const e of entries) for (const c of e.trig) if (trigQ[c] === 0 || e.q < trigQ[c]) trigQ[c] = e.q;
	B.portal = f;
	B.trigQ = trigQ;
	B.trigPS = prefixSums(W, H, (i) => trigQ[i] !== 0);
}
/**
 * Rise[n]: the most the ball can rise in n ticks from a tick in which it can land and jump (max_jumps 1, the modelled
 * physics, jump speed jv). A jump needs a landing in the same tick (jump_count resets only on a tick whose movement hit a
 * floor while moving down; in the air it is 1 = max_jumps), and the landing tick does not rise. After a jump the ball
 * rises by the pre-speeds p_1, p_2, .. (p_1 = stepY(jv)); a ceiling can stop it after any rising tick (speed 0), and the
 * next tick (pre-speed stepY(0) > 0) can land again: Rise[n] = max(Rise[n - 1], S(n - 1), max over 1 <= m <= n - 2 of
 * S(m) + Rise[n - 1 - m]) with S(m) = the rise of the first m ticks after the jump.
 */
function riseTable(B, jv) {
	if (jv === B.riseJv) return B.riseLast;
	let r = B.rise.get(jv);
	if (r) { B.riseJv = jv; B.riseLast = r; return r; }
	const N = 256, S = new Float64Array(N + 1);
	for (let i = 1, v = jv; i <= N; i++) { v = stepY(B, v); S[i] = S[i - 1] + (v < 0 ? -v : 0); }
	r = new Float64Array(N + 1);
	for (let n = 1; n <= N; n++) {
		let best = Math.max(r[n - 1], S[n - 1]);
		for (let m = 1; m <= n - 2; m++) { const v = S[m] + r[n - 1 - m]; if (v > best) best = v; }
		r[n] = best;
	}
	B.rise.set(jv, r);
	B.riseJv = jv; B.riseLast = r;
	return r;
}

/**
 * Lower bound on the ticks until the centre can be in a target cell for any position in the box [xl, xr] x [yu, yd]
 * (top-left px; a point when equal), by the speed limit alone: D_TICK px per axis per tick, portals through their field.
 */
function freeTicks(B, xl, xr, yu, yd) {
	let best = Infinity;
	const t = B.targets;
	for (let k = 0; k < t.length; k += 4) {
		const gx = Math.max(0, t[k] - xr, xl - t[k + 1]), gy = Math.max(0, t[k + 2] - yd, yu - t[k + 3]);
		const n = Math.ceil(Math.max(gx, gy) / D_TICK);
		if (n < best) best = n;
	}
	const f = B.portal;
	if (f !== null && best > 0) {
		const W = B.W, H = B.H;
		const x0 = Math.max(0, Math.min(W - 1, Math.floor((xl + 8) / 16))), x1 = Math.max(0, Math.min(W - 1, Math.floor((xr + 8) / 16)));
		const y0 = Math.max(0, Math.min(H - 1, Math.floor((yu + 8) / 16))), y1 = Math.max(0, Math.min(H - 1, Math.floor((yd + 8) / 16)));
		let m;
		if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) {
			m = FIELD_CAP;
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (f[y * W + x] < m) m = f[y * W + x];
		} else {
			// the field is 1-Lipschitz in tiles: the middle tile's value minus the half extent
			const mx = (x0 + x1) >> 1, my = (y0 + y1) >> 1;
			m = Math.max(0, f[my * W + mx] - Math.max(x1 - mx, mx - x0, y1 - my, my - y0));
		}
		if (m < best) best = m;
	}
	return best;
}
/**
 * The modelled physics holds while the centre is in the cells [x0, x1] x [y0, y1]: the touched tile (the centre's
 * cell, or with half blocks the one above / left of it) is modelled and the tile below it is not ice (slippery).
 * (Outside the world the engine reads tile 0.)
 */
function tameCells(B, x0, x1, y0, y1) {
	const h = B.halves;
	return rectCount(B, B.wildPS, x0 - h, x1, y0 - h, y1) === 0 && rectCount(B, B.icePS, x0 - h, x1, y0 - h + 1, y1 + 1) === 0;
}
/** the smallest Q of the portal entries triggered from the cells [x0, x1] x [y0, y1], Infinity when none */
function trigMin(B, x0, x1, y0, y1) {
	if (rectCount(B, B.trigPS, x0, x1, y0, y1) === 0) return Infinity;
	x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(B.W - 1, x1); y1 = Math.min(B.H - 1, y1);
	let m = Infinity;
	for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const q = B.trigQ[y * B.W + x]; if (q !== 0 && q < m) m = q; }
	return m;
}
/** trigMin over the cells of the rectangle [a0, a1] x [b0, b1] outside the smaller one [x0, x1] x [y0, y1] inside it
 *  (the cells a growing envelope adds: the others gave their candidate at an earlier tick already) */
function trigMinNew(B, x0, x1, y0, y1, a0, a1, b0, b1) {
	return Math.min(b0 < y0 ? trigMin(B, a0, a1, b0, y0 - 1) : Infinity, b1 > y1 ? trigMin(B, a0, a1, y1 + 1, b1) : Infinity,
		a0 < x0 ? trigMin(B, a0, x0 - 1, y0, y1) : Infinity, a1 > x1 ? trigMin(B, x1 + 1, a1, y0, y1) : Infinity);
}
function hitsTarget(B, xl, xr, yu, yd) {
	const t = B.targets;
	for (let k = 0; k < t.length; k += 4) if (xr >= t[k] && xl < t[k + 1] && yd >= t[k + 2] && yu < t[k + 3]) return true;
	return false;
}
/** speed_x after a tick's update in the modelled physics, horizontal input h (eesim.js _playerTick, the same operations) */
function stepX(B, v, h) {
	const mx = B.MX[h + 1];
	if (v === 0 && mx === 0) return 0;
	let sx = v + mx;
	if (h === 0 || (sx < 0 && h > 0) || (sx > 0 && h < 0)) { sx *= BD; sx *= NMD; } else sx *= BD;
	if (sx > 16) sx = 16; else if (sx < -16) sx = -16; else if (sx < 0.0001 && sx > -0.0001) sx = 0;
	return sx;
}
/** speed_y after a tick's update in the modelled physics (gravity only: no vertical input under vertical gravity) */
function stepY(B, v) {
	let sy = v + B.modY;
	sy *= BD;
	if (sy > 16) sy = 16; else if (sy < -16) sy = -16; else if (sy < 0.0001 && sy > -0.0001) sy = 0;
	return sy;
}
const tameIdOf = (B, id) => id >= 0 && id < B.nF && B.tameId[id] === 1;

/**
 * A lower bound on the number of ticks j >= 0 after which the box centre can be in a target cell (the complete then
 * fires in tick j + 1), or lim + 1 when it is more than lim. It never overestimates:
 * - the speed limit (freeTicks): without a teleport or a respawn (deaths are dropped) the box moves <= D_TICK px per axis
 *   per tick; teleports through the portal field;
 * - the kinematic envelope, while the ball touches tiles with an empty tile's physics and has no effect (flip gravity,
 *   speed, low gravity, flying, zombie, ice): per axis the reachable positions after j ticks lie in [lo, hi], with the
 *   speeds bounded by the update functions (monotone in the speed; the extreme input each tick), a collision may stop the
 *   ball at any tick (speed 0, no move past the new speed), the auto-align shifts < 0.2 px. Upward: with max_jumps 1 a
 *   jump needs a landing (riseTable), else a jump may set speed_y to the jump speed on any tick. A portal is a way out:
 *   the centre in an entry's trigger cell after tick j gives j + Q(p) (the envelope goes on for the paths that do not
 *   teleport: a portal tile has an empty tile's physics otherwise). The cells the boxes cover are checked tick by tick;
 *   where they leave the modelled tiles the rest is bounded by the speed limit from that box.
 */
function lowerBound(B, sim, lim) {
	const px = sim.px, py = sim.py;
	const h0 = freeTicks(B, px, px, py, py);
	if (h0 > lim || h0 === 0 || sim.in_god_mode || sim.is_dead) return h0;
	// the centre's cells so far (the envelope only grows: new cells are checked when the rectangle grows)
	let cx0 = Math.floor((px + 8) / 16), cy0 = Math.floor((py + 8) / 16), cx1 = cx0, cy1 = cy0;
	let best = lim + 1;
	if (B.trigQ !== null) best = Math.min(best, trigMin(B, cx0, cx1, cy0, cy1));
	if (!B.tameLevel || sim.has_levitation || sim.speed_boost !== 0 || sim.is_zombie || sim.low_gravity || sim.flip_gravity !== 0 ||
		sim._slippery > 0 || sim.world_gravity_multiplier !== B.wgm || !tameIdOf(B, sim._q0) || !tameIdOf(B, sim._q1) || !tameCells(B, cx0, cx1, cy0, cy1)) {
		return Math.max(h0, generalTicks(B, sim, 0, px, px, py, py, Math.abs(sim.speed_x), Math.abs(sim.speed_y), best));
	}
	const jv = ((0 - B.mory0) * JUMP_HEIGHT * sim._jumpMultiplier()) / MULT;
	// the rise with one jump per landing: the state's own flight first (k0 rising ticks, sq[m] = their rise), a landing
	// after tick m (a ceiling may stop it any time), then riseTable
	let R = null, k0 = 0;
	const sq = B.sq;
	if (sim.max_jumps <= 1 && lim < 256) {
		R = riseTable(B, jv);
		sq[0] = 0;
		for (let v = sim.speed_y; k0 < sq.length - 1;) { v = stepY(B, v); if (!(v < 0)) break; k0++; sq[k0] = sq[k0 - 1] - v; }
		if (k0 >= sq.length - 1) R = null;   // (still rising: the per-tick model)
	}
	let xl = px, xr = px, yu = py, yd = py, vl = sim.speed_x, vr = vl, vu = sim.speed_y, vd = vu;
	for (let j = 1; j < best; j++) {
		// the largest / smallest speed after the update: for a speed >= 0 holding right gives the largest (the others add
		// less or drag harder), for a speed <= 0 holding left the smallest; the signs are fixed after the first tick
		const sR = vr >= 0 ? stepX(B, vr, 1) : Math.max(stepX(B, vr, -1), stepX(B, vr, 0), stepX(B, vr, 1));
		const sL = vl <= 0 ? stepX(B, vl, -1) : Math.min(stepX(B, vl, -1), stepX(B, vl, 0), stepX(B, vl, 1));
		xr += (sR > 0 ? sR : 0) + ALIGN + EPS;
		xl += (sL < 0 ? sL : 0) - ALIGN - EPS;
		vr = sR > 0 ? sR : 0;
		vl = sL < 0 ? sL : 0;
		const sD = stepY(B, vd);
		yd += (sD > 0 ? sD : 0) + B.alignY + EPS;
		vd = sD > 0 ? sD : 0;
		if (R !== null) {
			let up = 0;
			if (k0 === 0) up = R[j];
			else for (let m = 1, mm = j < k0 ? j : k0; m <= mm; m++) { const u = sq[m] + R[j - m]; if (u > up) up = u; }
			yu = py - up - j * (B.alignY + EPS);
		} else {
			const sU = stepY(B, vu);
			yu += (sU < 0 ? sU : 0) - B.alignY - EPS;
			vu = sU < jv ? sU : jv;
		}
		if (hitsTarget(B, xl, xr, yu, yd)) return Math.max(h0, j);
		const a0 = Math.floor((xl + 8) / 16), a1 = Math.floor((xr + 8) / 16), b0 = Math.floor((yu + 8) / 16), b1 = Math.floor((yd + 8) / 16);
		if (a0 !== cx0 || a1 !== cx1 || b0 !== cy0 || b1 !== cy1) {
			if (B.trigQ !== null && j + 1 < best) best = Math.min(best, j + trigMinNew(B, cx0, cx1, cy0, cy1, a0, a1, b0, b1));
			cx0 = a0; cx1 = a1; cy0 = b0; cy1 = b1;
			if (!tameCells(B, a0, a1, b0, b1)) {
				// on from here with the general bound: the speeds after tick j are within these (upward: the state's own
				// flight or a jump)
				const uy = Math.max(vd, Math.abs(jv), R !== null ? Math.abs(sim.speed_y) : -vu);
				return Math.max(h0, generalTicks(B, sim, j, xl, xr, yu, yd, Math.max(vr, -vl), uy, best));
			}
		}
	}
	return Math.max(h0, best);
}
/**
 * The bound in the general physics (lowerBound's third tier), from tick j with the positions in the box and the
 * speeds after tick j within ux, uy per axis. Per axis and tick the speed before the move is at most the speed after
 * the last tick + |modifier| (then drag < 1, the clamp at 16), and after the move at most that or a jump's speed, plus
 * the levitation thrust; the box grows by the speed before the move + the auto-align on each side. |modifier| <=
 * (the largest |mo| * |gm| if a cell with mo on that axis can be the delayed tile + the input * speedMultiplier) / MULT;
 * a jump or the thrust on an axis needs a touched cell with mor on it (both axes where gravity can be rotated). The
 * cells are the rectangle of every box so far (it only grows), with the queued tiles. Valid while no boost is touched (a
 * boost sets 16 px/tick: then the speed limit); portals as in lowerBound. Returns the first tick the box can hold a
 * target cell (or `best` if lower).
 */
function generalTicks(B, sim, j, xl, xr, yu, yd, ux, uy, best) {
	const sm = B.hasRun || sim.speed_boost === 1 ? 1.5 : 1.0;
	const thr = B.hasFly || sim.has_levitation ? (0.2 * (JUMP_HEIGHT / 2) * 1.0) / MULT : 0;
	const Jv = (2 * JUMP_HEIGHT * (B.hasJump || sim.jump_boost === 1 ? 1.3 : 1.0)) / MULT;
	const rot = B.hasFlip || sim.flip_gravity !== 0;
	const q0 = sim._q0, q1 = sim._q1;
	const qg = (t) => (q0 < B.nF && t[q0] !== 0) || (q1 < B.nF && t[q1] !== 0);
	const h = B.halves;
	let x0 = Math.floor((xl + 8) / 16), x1 = Math.floor((xr + 8) / 16), y0 = Math.floor((yu + 8) / 16), y1 = Math.floor((yd + 8) / 16);
	let Mx = 0, My = 0, Jx = 0, Jy = 0;
	const region = () => {
		if (rectCount(B, B.boostPS, x0 - h, x1, y0 - h, y1) !== 0) return false;
		let gx = qg(B.gMox) || rectCount(B, B.gxPS, x0 - h, x1, y0 - h, y1) !== 0, gy = qg(B.gMoy) || rectCount(B, B.gyPS, x0 - h, x1, y0 - h, y1) !== 0;
		let jx = rectCount(B, B.jxPS, x0 - h, x1, y0 - h, y1) !== 0, jy = rectCount(B, B.jyPS, x0 - h, x1, y0 - h, y1) !== 0;
		if (rot) { gx = gy = gx || gy; jx = jy = jx || jy; }
		Mx = ((gx ? B.gmaxG : 0) + sm) / MULT + EPS;
		My = ((gy ? B.gmaxG : 0) + sm) / MULT + EPS;
		Jx = jx ? Jv + thr + EPS : 0;
		Jy = jy ? Jv + thr + EPS : 0;
		return true;
	};
	if (!region()) return Math.min(best, j + freeTicks(B, xl, xr, yu, yd));
	for (let k = j + 1; k < best; k++) {
		// speeds before the move of tick k, the move, the speeds after it
		const px = Math.min(16, ux + Mx), py = Math.min(16, uy + My);
		const dx = px + ALIGN + EPS, dy = py + ALIGN + EPS;
		xl -= dx; xr += dx; yu -= dy; yd += dy;
		ux = Math.max(px + (Jx > 0 ? thr : 0), Jx);
		uy = Math.max(py + (Jy > 0 ? thr : 0), Jy);
		if (hitsTarget(B, xl, xr, yu, yd)) return k;
		const a0 = Math.floor((xl + 8) / 16), a1 = Math.floor((xr + 8) / 16), b0 = Math.floor((yu + 8) / 16), b1 = Math.floor((yd + 8) / 16);
		if (a0 !== x0 || a1 !== x1 || b0 !== y0 || b1 !== y1) {
			// (the box only grows: the new cells are outside the old rectangle)
			if (B.trigQ !== null && k + 1 < best) best = Math.min(best, k + trigMinNew(B, x0, x1, y0, y1, Math.min(x0, a0), Math.max(x1, a1), Math.min(y0, b0), Math.max(y1, b1)));
			x0 = Math.min(x0, a0); x1 = Math.max(x1, a1); y0 = Math.min(y0, b0); y1 = Math.max(y1, b1);
			if (!region()) return Math.min(best, k + freeTicks(B, xl, xr, yu, yd));
		}
	}
	return best;
}

// ---------------------------------------------------------------- the search
/** A set of stateHash values (integers below 2^53) in one Float64Array, open addressing (0 = empty slot). */
class HashSet {
	constructor(bits) { this._alloc(bits || 16); }
	_alloc(bits) { this.bits = bits; this.mask = (1 << bits) - 1; this.t = new Float64Array(1 << bits); this.size = 0; }
	/** adds h; false when it was there already */
	add(h) {
		if (h === 0) h = 1;
		if (this.size * 2 >= this.t.length) this._grow();
		const t = this.t, m = this.mask;
		let i = (h % 4294967296) & m;
		for (;;) {
			const v = t[i];
			if (v === 0) { t[i] = h; this.size++; return true; }
			if (v === h) return false;
			i = (i + 1) & m;
		}
	}
	_grow() {
		const old = this.t;
		this._alloc(this.bits + 1);
		for (let k = 0; k < old.length; k++) if (old[k] !== 0) this.add(old[k]);
	}
}
const MAX_SEEN = 1 << 24;   // distinct states per search (the table's size then: 256 MB)

/**
 * Breadth-first branch and bound from `snap` (a state of `sim`'s level) for a finish within maxDepth ticks.
 * o: {B, cap (open states per depth), deadline (epoch ms), noCoins, accept(tail, depth) -> true to stop (a verified
 * faster run), progress(info), meter, noBound (tests: no cuts)}. Returns {status: 'found' | 'proof' | 'cap' | 'time',
 * depth, tail, stats}.
 */
function search(sim, snap, maxDepth, o) {
	const B = o.B, inp = new E.EEInput(), cap = o.cap || 300000, noCoins = !!o.noCoins;
	const bound = o.noBound ? () => 0 : lowerBound;
	const t0 = Date.now();
	const st = { ticks: 0, states: 1, merged: 0, cut: 0, dead: 0, finishes: 0, maxOpen: 1, depth: 0, seconds: 0 };
	const done = (status, extra) => { st.seconds = (Date.now() - t0) / 1000; return Object.assign({ status, stats: st }, extra || {}); };
	const seen = new HashSet(16);
	sim.restore(snap);
	seen.add(noCoins ? sim.stateHash(false, true) : sim.stateHash());
	if (bound(B, sim, maxDepth - 1) > maxDepth - 1) { st.cut++; return done('proof'); }
	let cur = [snap], curN = 1, nxt = [];
	const layers = [null];   // layers[d] = {par, msk}: parent index in layer d - 1, the mask
	let lastLog = t0;
	for (let d = 1; d <= maxDepth; d++) {
		st.depth = d;
		const lim = maxDepth - d - 1;   // a kept state at depth d must reach a target cell within lim ticks
		const par = [], msk = [];
		let n = 0;
		for (let i = 0; i < curN; i++) {
			if ((i & 255) === 0) {
				const now = Date.now();
				if (o.meter) o.meter.poll();
				if (now > o.deadline) return done('time');
				if (o.progress && now - lastLog >= 2000) { lastLog = now; o.progress({ depth: d, open: curN, done: i, seen: seen.size, ticks: st.ticks, cut: st.cut, seconds: (now - t0) / 1000 }); }
			}
			const masks = probeMasks(sim, inp, cur[i]);
			st.ticks++;
			for (let k = 0; k < masks.length; k++) {
				const m = masks[k];
				if (k > 0) { sim.restore(cur[i]); E.applyMask(inp, m); sim.tick(inp); st.ticks++; }
				if (sim.is_dead) { st.dead++; continue; }
				if (sim.has_silver_crown) {
					st.finishes++;
					const tail = new Uint8Array(d);
					tail[d - 1] = m;
					for (let e = d - 1, idx = i; e >= 1; e--) { tail[e - 1] = layers[e].msk[idx]; idx = layers[e].par[idx]; }
					if (!o.accept || o.accept(tail, d)) return done('found', { depth: d, tail });
					continue;
				}
				if (!seen.add(noCoins ? sim.stateHash(false, true) : sim.stateHash())) { st.merged++; continue; }
				if (lim < 0 || bound(B, sim, lim) > lim) { st.cut++; continue; }
				nxt[n] = sim.snapshot(nxt[n]);
				par.push(i); msk.push(m);
				n++;
				if (n > cap) return done('cap', { open: n });
			}
			if (seen.size >= MAX_SEEN) return done('cap', { seen: seen.size });
		}
		layers.push({ par: Int32Array.from(par), msk: Uint8Array.from(msk) });
		st.states += n;
		if (n > st.maxOpen) st.maxOpen = n;
		// the two layers' snapshot pools swap (snapshot(out) reuses them); the caller's start snapshot is not reused
		const sw = cur;
		cur = nxt; curN = n;
		nxt = d === 1 ? [] : sw;
		if (curN === 0) return done('proof');
	}
	return done('proof');
}

// ---------------------------------------------------------------- the K ladder over many starts
/** every run of a job worth starting from: best.eetas first, then best_*.eetas, original.eetas, pieces/ */
function runsOfJob(dir) {
	const list = [];
	const add = (f) => { try { list.push({ name: path.relative(dir, f).replace(/\\/g, '/'), masks: C.readEetas(f) }); } catch (e) { /* gone */ } };
	add(path.join(dir, 'best.eetas'));
	let fl = [];
	try { fl = fs.readdirSync(dir); } catch (e) { /* none */ }
	for (const f of fl.filter((x) => /^best_\d+\.eetas$/.test(x)).sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))) add(path.join(dir, f));
	if (fl.includes('original.eetas')) add(path.join(dir, 'original.eetas'));
	try { for (const f of fs.readdirSync(path.join(dir, 'pieces')).filter((x) => x.endsWith('.eetas')).sort()) add(path.join(dir, 'pieces', f)); } catch (e) { /* none */ }
	return list;
}
/** coins change nothing here but pickups: no coin doors or gates, no portal entry on a coin cell (then states that
 *  differ only in collected coins behave identically, and the acceptance rule does not count coins) */
function coinsBlind(level) {
	if (level.nPortalCoins > 0) return false;
	for (const id of level.fg) if (id === 43 || id === 165 || id === 213 || id === 214) return false;
	return true;
}
const STEP = 8;   // the ladder: K = 8, 16, 24, ...
/** "8,20" -> {list: [8, 20]} (exactly these); "40" -> {max: 40} (the ladder up to 40); empty -> null (no limit) */
function parseK(spec) {
	if (spec === undefined || spec === null || spec === '' || spec === true) return null;
	if (Array.isArray(spec)) return { list: spec.slice().sort((a, b) => a - b) };
	if (typeof spec === 'object') return spec;
	if (typeof spec === 'number') return { max: spec };
	const l = String(spec).split(',').map((s) => parseInt(s, 10)).filter((k) => k > 0);
	if (!l.length) return null;
	return l.length > 1 ? { list: l.sort((a, b) => a - b) } : { max: l[0] };
}

/**
 * The K ladder: every start (a run, re-simulated to its F' - K) is searched for a finish faster than the reference
 * (runs[0], or opts.reference = its C.evaluate result), the smallest K of any start first. Per start K goes 8, 16, 24, ..
 * (up to opts.K.max, which is tried itself); after a give-up at K the midpoints between its last proof and K are tried
 * (a K that fits under the open-state cap). opts.K.list: exactly these K. A start whose state at F' - K equals one
 * searched at the same K and no later run time shares its outcome. runs: [{name, masks}].
 * opts: {K ({list} | {max} | null), seconds, deadline, cap, log(obj), meter, out (file for a faster run)}.
 * Returns {reference, best (C.evaluate result of the fastest run), masks, found [{start, K, T, depth, runTicks, saved}],
 * proofs [{start, K, T, maxDepth, ...}], gaveUp, searches, ticks, seconds}.
 */
function ladder(level, runs, opts) {
	const o = opts || {};
	const log = o.log || (() => {});
	const t0 = Date.now();
	const deadline = Math.min(o.deadline || Infinity, t0 + (o.seconds === undefined ? 60 : +o.seconds) * 1000);
	const B = boundContext(level);
	const noCoins = o.noCoins === undefined ? coinsBlind(level) : !!o.noCoins;
	const ref = o.reference || C.evaluate(level, runs[0].masks);
	if (!ref) throw new Error(`the reference run (${runs[0].name}) does not finish the level`);
	let best = ref, bestMasks = ref.ms;
	const starts = [];
	// per start: doneK = the largest K settled (a proof, a find, or nothing to search there), failedK = the smallest K
	// given up (cap or time)
	const addStart = (name, masks) => {
		const r = C.replay(level, masks);
		if (r.complete < 0 || r.timerStart < 0) return null;
		const s = { name, masks: masks.slice(0, r.complete), F: r.complete, ts: r.timerStart, runTicks: r.runTicks, doneK: 0, failedK: Infinity };
		starts.push(s);
		return s;
	};
	for (const r of runs) addStart(r.name, r.masks);
	const KO = parseK(o.K);
	const list = KO && KO.list ? KO.list : null, maxK = KO && KO.max ? KO.max : Infinity;
	/** the K to search this start at next: the next ladder K, else the middle between its last settled K and a give-up */
	const nextK = (s) => {
		const top = Math.min(s.F - s.ts, maxK);   // (the run timer must run at F - K)
		if (list) { for (const k of list) if (k > s.doneK && k < s.failedK && k <= s.F - s.ts) return k; return null; }
		let k = (Math.floor(s.doneK / STEP) + 1) * STEP;
		if (k > top && s.doneK < top) k = top;
		if (k <= top && k < s.failedK) return k;
		const hi = Math.min(s.failedK, top + 1);
		return hi - s.doneK >= 2 ? Math.floor((s.doneK + hi) / 2) : null;
	};
	const found = [], proofs = [], gaveUp = [];
	let searches = 0, ticks = 0;
	const sim = new E.EESim(level), inp = new E.EEInput();
	sim.onEvent = null;
	log({ event: 'start', reference: ref.runTicks, starts: starts.length, targets: B.cells.length, modelled: B.tameLevel, portals: B.portal !== null, noCoins,
		K: list || (maxK < Infinity ? `ladder to ${maxK}` : 'ladder'), seconds: (deadline - t0) / 1000 });
	const outcome = new Map();   // "K|state hash" -> {runT, status}: a start at the same state and K shares the outcome
	for (;;) {
		if (Date.now() > deadline) break;
		let s = null, K = Infinity;
		for (const x of starts) { const k = nextK(x); if (k !== null && k < K) { s = x; K = k; } }
		if (s === null) break;
		const T = s.F - K;
		const maxDepth = best.runTicks - 1 - (T - s.ts);   // a finish at depth <= maxDepth beats the best run
		if (maxDepth < 1) { s.doneK = K; continue; }       // (nothing from S(T) can beat it)
		sim.reset();
		for (let t = 0; t < T; t++) { E.applyMask(inp, s.masks[t]); sim.tick(inp); }
		if (sim.is_dead) { s.doneK = K; continue; }
		const okey = `${K}|${noCoins ? sim.stateHash(false, true) : sim.stateHash()}`;
		const prev = outcome.get(okey);
		if (prev !== undefined && prev.runT <= T - s.ts) {
			if (prev.status === 'cap' || prev.status === 'time') s.failedK = K; else s.doneK = K;
			continue;
		}
		const snap = sim.snapshot();
		searches++;
		log({ event: 'search', start: s.name, K, T, runT: T - s.ts, maxDepth, beat: best.runTicks });
		let foundRun = null;
		const accept = (tail, depth) => {
			const ms = new Uint8Array(T + depth);
			ms.set(s.masks.subarray(0, T));
			ms.set(tail, T);
			const ev = C.evaluate(level, ms);
			if (!ev || ev.complete !== T + depth) {
				log({ event: 'error', start: s.name, K, T, depth, why: `the replay ${ev ? `finishes at tick ${ev.complete}` : 'does not finish'}, the search at ${T + depth}` });
				return false;
			}
			const v = C.judge(ev, best, best.deaths);
			if (!v.accept || !(ev.runTicks < best.runTicks)) { log({ event: 'rejected', start: s.name, K, T, depth, runTicks: ev.runTicks, why: v.reason || 'not faster' }); return false; }
			foundRun = ev;
			return true;
		};
		const res = search(sim, snap, maxDepth, { B, cap: o.cap, deadline, noCoins, accept, meter: o.meter,
			progress: (p) => log(Object.assign({ event: 'progress', start: s.name, K }, p)) });
		ticks += res.stats.ticks;
		outcome.set(okey, { runT: T - s.ts, status: res.status });
		const info = { start: s.name, K, T, runT: T - s.ts, maxDepth, beat: best.runTicks, ticks: res.stats.ticks, states: res.stats.states,
			merged: res.stats.merged, cut: res.stats.cut, maxOpen: res.stats.maxOpen, depth: res.stats.depth, seconds: res.stats.seconds };
		if (res.status === 'found') {
			const saved = best.runTicks - foundRun.runTicks;
			best = foundRun; bestMasks = foundRun.ms;
			const f = Object.assign(info, { depth: res.depth, runTicks: foundRun.runTicks, saved, chance: foundRun.chance });
			found.push(f);
			if (o.out) { C.writeEetas(o.out, bestMasks); f.file = o.out; }
			log(Object.assign({ event: 'found' }, f));
			// the found run is the new reference and a start of its own (first, from K = 8); the settled K of the other
			// starts stay settled (the budget only shrinks). From S(T) nothing is faster than the first finish.
			const ns = addStart(`found (K=${K} from ${s.name})`, foundRun.ms);
			if (ns) { starts.splice(starts.indexOf(ns), 1); starts.unshift(ns); }
			s.doneK = K;
			continue;
		}
		if (res.status === 'proof') { s.doneK = K; proofs.push(info); log(Object.assign({ event: 'proof' }, info)); }
		else {
			s.failedK = K;
			gaveUp.push(Object.assign(info, { reason: res.status }));
			log(Object.assign({ event: 'gave_up', reason: res.status }, info));
			if (res.status === 'time') break;
		}
	}
	const out = { reference: ref.runTicks, best: best.runTicks, saved: ref.runTicks - best.runTicks, masks: bestMasks, bestEval: best, found, proofs, gaveUp,
		searches, ticks, seconds: (Date.now() - t0) / 1000 };
	// per start: the largest K with a proof ("nothing faster from S(F - K)")
	const provedBy = {};
	for (const p of proofs) provedBy[p.start] = Math.max(provedBy[p.start] || 0, p.K);
	log({ event: 'done', reference: out.reference, best: out.best, saved: out.saved, file: found.length && o.out ? o.out : null, searches, ticks,
		seconds: out.seconds, proved: provedBy, gaveUp: gaveUp.map((g) => `${g.start} K=${g.K} (${g.reason})`) });
	return out;
}

/**
 * The ladder for a job: every run of the job as a start, the job's best as the reference; the fastest run found is
 * written to probes/endgame_<stamp>.eetas and handed in with J.tryCandidate (inbox of a running job, else decided
 * at once). opts: {K, seconds, cap, log, wait (s, for a running job's verdict), source}. Returns {ladder, file, handed}.
 */
async function endgameJob(id, opts) {
	const o = opts || {};
	const J = require('./jobs.js');
	const dir = J.jobDir(id);
	const level = J.loadJobLevel(id);
	const runs = runsOfJob(dir);
	if (!runs.length) throw new Error(`${id}: no best.eetas`);
	const res = ladder(level, runs, { K: o.K, seconds: o.seconds, cap: o.cap, log: o.log, deadline: o.deadline });
	const r = { ladder: res, file: null, handed: null };
	if (res.found.length) {
		r.file = path.join(dir, 'probes', `endgame_${J.stamp()}.eetas`);
		C.writeEetas(r.file, res.masks);
		r.handed = await J.tryCandidate(id, fs.readFileSync(r.file), { source: o.source || `endgame -${res.saved}`, wait: o.wait === undefined ? 60 : o.wait });
	}
	return r;
}

module.exports = { boundContext, lowerBound, freeTicks, probeMasks, MASK_SETS, search, ladder, runsOfJob, endgameJob, coinsBlind, parseK, HashSet };

if (require.main === module) {
	const a = C.parseArgs(process.argv.slice(2));
	if (!a.tas) { console.log('usage: node src/endgame.js --tas=<run.eetas> [--level=<level id | job id>] [--K=..] [--seconds=60] [--out=..] (see the header)'); process.exit(2); }
	const level = C.loadLevel(a.level, a.tas);
	const runs = [{ name: path.basename(a.tas), masks: C.readEetas(a.tas) }];
	if (a.starts) for (const f of String(a.starts).split(',').filter(Boolean)) runs.push({ name: path.basename(f), masks: C.readEetas(f) });
	const jobId = C.jobOfFile(a.tas);
	if (jobId && a.others !== '0') {
		const self = path.resolve(a.tas);
		for (const r of runsOfJob(path.join(C.JOBS, jobId))) if (path.resolve(C.JOBS, jobId, r.name) !== self) runs.push(r);
	}
	const meter = C.tickMeter();
	const res = ladder(level, runs, { K: parseK(a.K), seconds: a.seconds === undefined ? 60 : +a.seconds, deadline: a.deadline ? +a.deadline : undefined,
		cap: a.cap ? +a.cap : undefined, out: a.out ? path.resolve(a.out) : path.join(__dirname, 'out', 'endgame_best.eetas'), meter,
		log: (obj) => console.log(JSON.stringify(obj)) });
	meter.stop();
}
