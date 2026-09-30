'use strict';
// EE MATH, part 2: the engine checks of the SEPARABILITY theorems (docs/ee_math.md "Separability and coupling").
// Every claim is checked against EESim itself (src/eesim.js), bit for bit.
//
//   node tools/math/sepcheck.js free   [--threads=N] [--T=30] [--out=f.json]   THEOREM 1/3: the cross products in uniform
//        environments (open air, dots, water, climbable, arrows, boosts, low gravity, multijump, levitation, speed
//        effect, flipped gravity): every (x-pattern, y-pattern) pair of the families (all patterns with <= 2 input
//        changes) played by the engine = (x of the x-pattern's run, y of the y-pattern's run), with the input bits the
//        environment ignores randomized in the product runs.
//   node tools/math/sepcheck.js trans  [--threads=N] [--out=]   THEOREM 4: translation invariance of the per-axis
//        offsets (integer shifts; the binade and mod-16 exceptions measured)
//   node tools/math/sepcheck.js routes [--threads=N] [--out=] [--root=<truth root>]   THEOREM 2 on the known routes:
//        every tick classified (src/math/regime.js), the per-axis model = the engine on every separable tick, the
//        coupling census, and (--m18=K) at every K-th separable tick all 18 masks from the tick's state: x after the tick
//        depends only on the x-driving input, y only on the y-driving input
//   node tools/math/sepcheck.js ground [--threads=N]   THEOREM 5: contact maps (flat floors / walls, the walk-off)
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../../src/eesim.js');
const A = require('../../src/math/axis.js');
const R = require('../../src/math/regime.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) args[m[1]] = m[2]; else if (!args._) args._ = a; }

function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
/** W x H, a border of block 9, the inside filled with `fill` (0 = air); tiles [[x, y, id]] on top */
function mkLevel(W, H, fill, tiles = [], gravity = 1) {
	const fg = new Int32Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fg[y * W + x] = (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? 9 : fill;
	for (const [x, y, id] of tiles) fg[y * W + x] = id;
	const d = { format: 'eesim-level-1', level_id: 'sep', width: W, height: H, gravity_hex: f64hex(gravity), gravity,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras: [], spawn_points: [[[2, 2]]], lookup_int: [] };
	return E.prepareLevel(d, {});
}

// a seeded PRNG (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** all sequences of length T over `vals` with at most `k` changes (k <= 2): [{v0, c1, v1, c2, v2}] as arrays */
function patterns(vals, T, k) {
	const out = [];
	for (const a of vals) {
		out.push(new Array(T).fill(a));
		if (k < 1) continue;
		for (const b of vals) {
			if (b === a) continue;
			for (let i = 1; i < T; i++) {
				const p = new Array(T).fill(a); for (let t = i; t < T; t++) p[t] = b; out.push(p);
				if (k < 2) continue;
				for (const c of vals) {
					if (c === b) continue;
					for (let j = i + 1; j < T; j++) { const q = p.slice(); for (let t = j; t < T; t++) q[t] = c; out.push(q); }
				}
			}
		}
	}
	return out;
}

// ------------------------------------------------------------------ environments for the cross products
// kind: which input drives which axis. 'vert' x <- h, y <- jump (v ignored); 'horiz' x <- jump, y <- v (h ignored);
// 'free4' x <- h, y <- v (jump ignored or no jump possible).
const ENVS = [
	{ name: 'air', fill: 0, kind: 'vert' },
	{ name: 'air-multijump2', fill: 0, kind: 'vert', set: { max_jumps: 2, jump_count: 1 } },
	{ name: 'air-multijump-inf', fill: 0, kind: 'vert', set: { max_jumps: 1000, jump_count: 1 } },
	{ name: 'air-jumpboost', fill: 0, kind: 'vert', set: { max_jumps: 3, jump_boost: 1, jump_count: 1 } },
	{ name: 'air-speedboost', fill: 0, kind: 'vert', set: { speed_boost: 1 } },
	{ name: 'air-slowzombie', fill: 0, kind: 'vert', set: { speed_boost: 2, max_jumps: 2, jump_count: 1 } },
	{ name: 'air-lowgravity', fill: 0, kind: 'vert', set: { low_gravity: true, max_jumps: 2, jump_count: 1 } },
	{ name: 'air-levitation', fill: 0, kind: 'vert', set: { has_levitation: true } },
	{ name: 'air-flip2 (gravity up)', fill: 0, kind: 'vert', set: { flip_gravity: 2, max_jumps: 2, jump_count: 1 } },
	{ name: 'air-flip1 (gravity left)', fill: 0, kind: 'horiz', set: { flip_gravity: 1, max_jumps: 2, jump_count: 1 } },
	{ name: 'air-flip3 (gravity right)', fill: 0, kind: 'horiz', set: { flip_gravity: 3, max_jumps: 2, jump_count: 1 } },
	{ name: 'air-flip4 (no gravity)', fill: 0, kind: 'free4', set: { flip_gravity: 4 } },
	{ name: 'arrow-up (2)', fill: 2, kind: 'vert', set: { max_jumps: 2, jump_count: 1 } },
	{ name: 'arrow-down (1518)', fill: 1518, kind: 'vert', set: { max_jumps: 2, jump_count: 1 } },
	{ name: 'arrow-left (1)', fill: 1, kind: 'horiz', set: { max_jumps: 2, jump_count: 1 } },
	{ name: 'arrow-right (3)', fill: 3, kind: 'horiz', set: { max_jumps: 2, jump_count: 1 } },
	{ name: 'dot (4)', fill: 4, kind: 'free4' },
	{ name: 'dot-invisible (414)', fill: 414, kind: 'free4' },
	{ name: 'climbable (chain 118)', fill: 118, kind: 'free4' },
	{ name: 'water (119)', fill: 119, kind: 'free4' },
	{ name: 'mud (369)', fill: 369, kind: 'free4' },
	{ name: 'lava (416, protected)', fill: 416, kind: 'free4', set: { is_invulnerable: true } },
	{ name: 'toxic (1585, protected)', fill: 1585, kind: 'free4', set: { is_invulnerable: true } },
	{ name: 'boost-left (114)', fill: 114, kind: 'free4' },
	{ name: 'boost-down (117)', fill: 117, kind: 'free4' },
	{ name: 'spike-air (361, protected)', fill: 361, kind: 'vert', set: { is_invulnerable: true } },
];

const XVALS = { vert: [0, 2, 4], horiz: [0, 1], free4: [0, 2, 4] };     // mask bits of the x driver
const YVALS = { vert: [0, 1], horiz: [0, 8, 16], free4: [0, 8, 16] };    // mask bits of the y driver
const NOISE = { vert: [0, 8, 16, 24], horiz: [0, 2, 4, 6], free4: [0, 1] }; // bits the environment ignores (randomized)

/** a start state in env (random but reproducible), as a snapshot of a sim on the env's level */
function startState(env, L, r) {
	const sim = new E.EESim(L);
	sim.reset();
	const W = L.width, H = L.height;
	// centre of the level, a random sub-pixel fraction and a random integer offset (so tiles and binades vary)
	sim.px = Math.floor(W * 8 + (r() - 0.5) * 64) + (r() < 0.25 ? 0 : r());
	sim.py = Math.floor(H * 8 + (r() - 0.5) * 64) + (r() < 0.25 ? 0 : r());
	const pickv = [0, 0.12899896800825594, 3.5 * r(), 6.7 * r(), 16 * r() - 8, (r() - 0.5) * 2];
	sim.speed_x = pickv[Math.floor(r() * pickv.length)] * (r() < 0.5 ? -1 : 1);
	sim.speed_y = pickv[Math.floor(r() * pickv.length)] * (r() < 0.5 ? -1 : 1);
	sim._q0 = env.fill; sim._q1 = env.fill;
	sim._slippery = 0.0;
	sim.jump_count = 1;
	if (env.set) for (const k of Object.keys(env.set)) sim[k] = env.set[k];
	if (sim.has_levitation) sim._current_thrust = r() < 0.5 ? 0.2 : 0.1;
	sim._last_portal_set = false;
	return sim;
}

/** play masks from snapshot s; rec gets per tick [px, vx, py, vy, jc, thr] */
function play(sim, s, masks, inp, rec) {
	sim.restore(s);
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		const o = t * 6;
		rec[o] = sim.px; rec[o + 1] = sim.speed_x; rec[o + 2] = sim.py; rec[o + 3] = sim.speed_y; rec[o + 4] = sim.jump_count; rec[o + 5] = sim._current_thrust;
	}
}

/** one cross-product task: env index, seed, T, k; returns counts */
function freeTask(task) {
	const env = ENVS[task.env];
	const L = mkLevel(128, 128, env.fill);
	const r = rng(task.seed);
	const sim = startState(env, L, r);
	const s = sim.snapshot();
	const T = task.T, k = task.k;
	const PX = patterns(XVALS[env.kind], T, k), PY = patterns(YVALS[env.kind], T, k);
	const inp = new E.EEInput();
	// the noise stream of the product runs (the reference runs have none): the ignored bits change every tick
	const noise = new Array(T); const nv = NOISE[env.kind];
	for (let t = 0; t < T; t++) noise[t] = nv[Math.floor(r() * nv.length)];
	const X = PX.map(() => new Float64Array(T * 6)), Y = PY.map(() => new Float64Array(T * 6));
	const m = new Array(T);
	for (let a = 0; a < PX.length; a++) { for (let t = 0; t < T; t++) m[t] = PX[a][t] | PY[0][t]; play(sim, s, m, inp, X[a]); }
	for (let b = 0; b < PY.length; b++) { for (let t = 0; t < T; t++) m[t] = PX[0][t] | PY[b][t]; play(sim, s, m, inp, Y[b]); }
	const rec = new Float64Array(T * 6);
	let runs = 0, ticks = 0, missX = 0, missY = 0, left = 0, firstMiss = null;
	const ySlots = env.kind === 'horiz' ? [2, 3] : [2, 3, 4, 5];   // jc / thrust belong to the gravity axis
	const xSlots = env.kind === 'horiz' ? [0, 1, 4, 5] : [0, 1];
	for (let a = 0; a < PX.length; a++) {
		for (let b = 0; b < PY.length; b++) {
			if (task.sample && r() > task.sample) continue;
			for (let t = 0; t < T; t++) m[t] = PX[a][t] | PY[b][t] | noise[t];
			play(sim, s, m, inp, rec);
			runs++; ticks += T;
			let bx = false, by = false;
			for (let t = 0; t < T; t++) {
				const o = t * 6;
				for (const q of xSlots) if (!Object.is(rec[o + q], X[a][o + q])) bx = true;
				for (const q of ySlots) if (!Object.is(rec[o + q], Y[b][o + q])) by = true;
				if (rec[o] < 16 || rec[o + 2] < 16 || rec[o] > L.width * 16 - 32 || rec[o + 2] > L.height * 16 - 32) left++;
			}
			if (bx) missX++;
			if (by) missY++;
			if ((bx || by) && !firstMiss) firstMiss = { a, b, x: Array.from(PX[a]), y: Array.from(PY[b]) };
		}
	}
	return { env: env.name, seed: task.seed, px0: s.px, py0: s.py, vx0: s.speed_x, vy0: s.speed_y, T, k, nx: PX.length, ny: PY.length, runs, ticks, missX, missY, left, firstMiss };
}

// ------------------------------------------------------------------ translation invariance
function binade(x) { return x >= 1 ? Math.floor(Math.log2(x)) : -1; }
/**
 * For start x0 (a fraction f), every h pattern (<= 2 changes, T ticks) played at x0 and at x0 + n: are the offsets
 * x(t) - x0 identical? Categories: n % 16 == 0 or not; same binade at every tick (both runs) or not; auto-align armed
 * (|vx| < 1 and no key at some tick) or not. The y axis likewise with jump patterns and y shifts (normal and low gravity).
 */
function transTask(task) {
	const L = mkLevel(700, 700, 0);   // x up to ~11000 px: binades 2^8 .. 2^13
	const r = rng(task.seed);
	const T = task.T;
	const sim = new E.EESim(L); sim.reset();
	const s0 = sim.snapshot();
	const inp = new E.EEInput();
	const axis = task.axis;
	const f = r() < 0.2 ? 0 : r();
	const v0 = [0, 0.12899896800825594, 2.5 * r(), 6.7 * r(), 13 * r(), 0.9 * r()][Math.floor(r() * 6)] * (r() < 0.5 ? -1 : 1);
	const base = task.base + f;
	const pats = axis === 'x' ? patterns([0, 2, 4], T, 2) : patterns([0, 1], T, 2);
	const cat = {};
	const add = (key, same) => { const c = cat[key] || (cat[key] = { n: 0, same: 0, maxAbs: 0 }); c.n++; if (same.eq) c.same++; if (same.d > c.maxAbs) c.maxAbs = same.d; };
	const runAt = (p0, pat) => {
		sim.restore(s0);
		if (axis === 'x') { sim.px = p0; sim.py = 5000.5; sim.speed_x = v0; sim.speed_y = 0; }
		else { sim.py = p0; sim.px = 5000.5; sim.speed_y = v0; sim.speed_x = 0; sim.max_jumps = 1000; sim.jump_count = 1; }
		sim.low_gravity = !!task.lowg;
		sim._q0 = 0; sim._q1 = 0; sim._slippery = 0;
		const pos = new Float64Array(T), vel = new Float64Array(T);
		for (let t = 0; t < T; t++) {
			E.applyMask(inp, pat[t]);
			sim.tick(inp);
			pos[t] = axis === 'x' ? sim.px : sim.py; vel[t] = axis === 'x' ? sim.speed_x : sim.speed_y;
		}
		return { pos, vel };
	};
	const lo = 40, hi = 700 * 16 - 64;   // a run that comes near the world's edge (a collision) is not a translation case
	const near = (r) => { for (let t = 0; t < T; t++) if (r.pos[t] < lo || r.pos[t] > hi) return true; return false; };
	let skipped = 0;
	for (const pat of pats) {
		const a = runAt(base, pat);
		if (near(a)) { skipped++; continue; }
		let armed = false;
		for (let t = 0; t < T; t++) {
			const keyFree = axis === 'x' ? (pat[t] & 6) === 0 || (pat[t] & 6) === 6 : !!task.lowg;
			if (Math.abs(a.vel[t]) < 1 && keyFree) armed = true;
		}
		for (const n of task.shifts) {
			const b = runAt(base + n, pat);
			if (near(b)) { skipped++; continue; }
			let same = true, eq = true, d = 0;
			const b0a = binade(base), b0b = binade(base + n);
			if (b0a !== b0b) same = false;
			for (let t = 0; t < T; t++) {
				if (binade(a.pos[t]) !== binade(b.pos[t]) || binade(a.pos[t]) !== b0a) same = false;
				const da = a.pos[t] - base, db = b.pos[t] - (base + n);
				if (!Object.is(da, db) || !Object.is(a.vel[t], b.vel[t])) { eq = false; d = Math.max(d, Math.abs(da - db)); }
			}
			const key = `${n % 16 === 0 ? 'n%16=0' : 'n%16!=0'}|${same ? 'sameBinade' : 'binadeDiffers'}|${armed ? 'alignArmed' : 'noAlign'}`;
			add(key, { eq, d });
		}
	}
	return { axis, lowg: !!task.lowg, base, f, v0, T, cat, skipped };
}

// ------------------------------------------------------------------ known routes
function routeTask(task) {
	process.env.EEAT_TRUTH_ROOT = task.root;
	const TS = require('../../src/plan/truthset.js');
	const e = task.entry;
	const tr = TS.loadTruth(e);
	if (!tr) return { name: e.name, route: e.route, stale: true };
	const res = R.pathRegimes(tr.L, tr.masks, { check: true });
	const st = res.stats;
	// counts by class and bit
	const byCur = {}, bits = {};
	const n = res.codes.length;
	for (let t = 0; t < n; t++) {
		const c = res.codes[t];
		const nm = R.PC_NAMES[res.cur[t]];
		const g = byCur[nm] || (byCur[nm] = { ticks: 0, sep: 0, free: 0 });
		g.ticks++;
		if ((c & R.C_COUPLED) === 0) g.sep++;
		if ((c & R.C_COUPLED) === 0 && (c & (R.C_XHITP | R.C_XHITN | R.C_YHITP | R.C_YHITN)) === 0) g.free++;
		for (let b = 0; b < 23; b++) if ((c >> b) & 1) bits[b] = (bits[b] || 0) + 1;
	}
	// modes: x free/blocked, y free/blocked on separable ticks
	const modes = { xfree_yfree: 0, xfree_yblk: 0, xblk_yfree: 0, xblk_yblk: 0 };
	for (let t = 0; t < n; t++) {
		const c = res.codes[t];
		if ((c & R.C_COUPLED) !== 0) continue;
		const xb = (c & (R.C_XHITP | R.C_XHITN)) !== 0, yb = (c & (R.C_YHITP | R.C_YHITN)) !== 0;
		modes[(xb ? 'xblk' : 'xfree') + '_' + (yb ? 'yblk' : 'yfree')]++;
	}
	// the 18-mask check at every m18-th separable tick
	let m18 = null;
	if (task.m18 > 0) m18 = masks18(tr.L, tr.masks, res.codes, task.m18);
	// certifyFree on single ticks: the free product ticks of one class (current = delayed, no switch, nothing hit): how
	// many the geometric certificate accepts (it asks the whole swept rectangle to be plain air: conservative)
	const cert = {};
	for (let t = 0; t < n; t++) {
		const c = res.codes[t];
		if ((c & R.C_COUPLED) !== 0 || (c & (R.C_XHITP | R.C_XHITN | R.C_YHITP | R.C_YHITN | R.C_ENVCHG)) !== 0) continue;
		if (res.cur[t] !== res.del[t]) continue;
		if (res.cur[t] === R.PC.portal || res.cur[t] === R.PC.effect || res.cur[t] === R.PC.kill || res.cur[t] === R.PC.solid) continue;
		const nm = R.PC_NAMES[res.cur[t]];
		const g = cert[nm] || (cert[nm] = { ticks: 0, ok: 0 });
		g.ticks++;
		if (R.certifyFree(tr.L, [res.xs[t], res.xs[t + 1]], [res.ys[t], res.ys[t + 1]], { cls: nm }) === -1) g.ok++;
	}
	return { name: e.name, source: e.source, route: e.route, ticks: n, sep: st.sep, sepExact: st.sepExact, sepMiss: st.sepMiss, allExact: st.allExact,
		envChanges: st.envChanges, tri: st.tri, triExact: st.triExact, triMiss: st.triMiss, bits, bitExact: st.bitExact, byCur, modes, freeRuns: hist(st.freeRuns), sepRuns: hist(st.sepRuns), miss: st.miss.slice(0, 5), m18,
		legs: legStats(res.codes), cert };
}

/**
 * The route cut into LEGS at its support contacts: a leg = the ticks from the first tick after a grounded tick to the
 * next grounded tick (the landing, inclusive). Each leg's class: 'pure' (every tick a product, one environment),
 * 'switch' (products, the environment changes on the way: a field edge), 'tri' (+ triangular ticks, no other coupling),
 * 'coupled' (a mutual corner, a one-way, a portal, a door, an effect or a death on the way). Where the triangular ticks
 * sit: the leg's first tick (the take-off / walk-off), its last (the landing), or inside.
 */
function legStats(codes) {
	// interior = the ticks strictly between the take-off tick a and the landing tick b; the ends classified apart
	const out = { pure: { n: 0, ticks: 0 }, switch: { n: 0, ticks: 0 }, tri: { n: 0, ticks: 0 }, coupled: { n: 0, ticks: 0 },
		takeoff: { product: 0, tri: 0, coupled: 0 }, landing: { product: 0, tri: 0, coupled: 0 }, len: [] };
	const TRI = R.C_TRIXY | R.C_TRIYX, HARD = R.C_COUPLED & ~TRI;
	const endCls = (c) => ((c & HARD) !== 0 ? 'coupled' : (c & TRI) !== 0 ? 'tri' : 'product');
	let t = 0;
	const n = codes.length;
	while (t < n && (codes[t] & R.C_GROUND) === 0) t++;          // the first support
	while (t < n) {
		while (t < n && (codes[t] & R.C_GROUND) !== 0) t++;     // standing / running
		const a = t;
		while (t < n && (codes[t] & R.C_GROUND) === 0) t++;
		if (t >= n) break;                                       // no landing: the route's end
		const b = t;                                             // the landing tick (grounded)
		let hard = false, tri = false, sw = false;
		for (let k = a + 1; k < b; k++) {
			const c = codes[k];
			if ((c & HARD) !== 0) hard = true;
			if ((c & TRI) !== 0) tri = true;
			if ((c & R.C_ENVCHG) !== 0) sw = true;
		}
		const cls = hard ? 'coupled' : tri ? 'tri' : sw ? 'switch' : 'pure';
		out[cls].n++; out[cls].ticks += b - a + 1;
		out.takeoff[endCls(codes[a])]++; out.landing[endCls(codes[b])]++;
		out.len.push(b - a + 1);
	}
	out.len = hist(out.len);
	return out;
}
function hist(runs) {
	const s = runs.slice().sort((a, b) => a - b);
	const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
	return { n: s.length, sum: s.reduce((a, b) => a + b, 0), p50: q(0.5), p90: q(0.9), max: s.length ? s[s.length - 1] : 0, ge10: s.filter((x) => x >= 10).length, ge30: s.filter((x) => x >= 30).length };
}

/**
 * masks18: from the state before tick t (every K-th separable tick), all 18 masks: the ticks that stay separable are
 * grouped by their x driver (h where the tick's mx reads h; the jump bit where morx != 0) and by their y driver (v where
 * my reads v; the jump bit where mory != 0): within a group the engine's x (resp. y) after the tick must be identical.
 */
function masks18(L, masks, codes, K) {
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	const ALL = [];
	for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) ALL.push(h | v | j);
	let tested = 0, groupsX = 0, groupsY = 0, violX = 0, violY = 0, sepMasks = 0;
	let k = 0;
	const first = [];
	for (let t = 0; t < masks.length; t++) {
		const m = masks[t] & 31;
		if ((codes[t] & R.C_COUPLED) === 0 && (++k % K) === 0) {
			const s = sim.snapshot();
			const gx = new Map(), gy = new Map();
			for (const mm of ALL) {
				const cls = R.classifyTick(sim, mm);
				if (!cls.sep) continue;
				const env = cls.env;
				sim.restore(s);
				const pb = R.paramsOf(sim);
				E.applyMask(inp, mm); sim.tick(inp);
				const pa = R.paramsOf(sim);
				let eff = false; for (let i = 0; i < pa.length; i++) if (!Object.is(pa[i], pb[i])) eff = true;
				if (eff || sim.teleported) { sim.restore(s); continue; }
				sepMasks++;
				// driver keys: what the per-axis maps read (eesim.js 1136-1139: which input axis acts; the jump bit acts on
				// the axis whose current-tile gravity mor is non-zero: the jump, jumpCount and the levitation thrust)
				const hv = (mm & 2 ? -1 : 0) + (mm & 4 ? 1 : 0), vv = (mm & 8 ? -1 : 0) + (mm & 16 ? 1 : 0), jj = mm & 1;
				const liquidD = (L.flags[env.delayed] & A.F_LIQUID) !== 0;
				const xReadsH = liquidD || env.moy !== 0.0 || env.mox === 0.0;
				const yReadsV = liquidD || (env.moy === 0.0);
				const kx = (xReadsH ? hv : 9) + ',' + (env.morx !== 0 ? jj : 9);
				const ky = (yReadsV ? vv : 9) + ',' + (env.mory !== 0 ? jj : 9);
				const xs = [sim.px, sim.speed_x].concat(env.morx !== 0 ? [sim.jump_count, sim._current_thrust] : []);
				const ys = [sim.py, sim.speed_y].concat(env.mory !== 0 ? [sim.jump_count, sim._current_thrust] : []);
				if (gx.has(kx)) { if (!sameArr(gx.get(kx), xs)) { violX++; if (first.length < 5) first.push({ t, axis: 'x', mm, kx }); } } else { gx.set(kx, xs); groupsX++; }
				if (gy.has(ky)) { if (!sameArr(gy.get(ky), ys)) { violY++; if (first.length < 5) first.push({ t, axis: 'y', mm, ky }); } } else { gy.set(ky, ys); groupsY++; }
				sim.restore(s);
			}
			tested++;
		}
		E.applyMask(inp, m); sim.tick(inp);
	}
	return { tested, sepMasks, groupsX, groupsY, violX, violY, first };
}
function sameArr(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true; }

// ------------------------------------------------------------------ contact maps (ground, walls, walk-off)
/**
 * A flat floor across the whole level (row 60) and a start standing on it: every (h pattern, jump pattern) pair: x = x of
 * the h pattern's run, y = y of the jump pattern's run (the floor is under every x: contact without coupling). Then a
 * floor with a gap (a ledge): y depends on x only through the support (the walk-off tick): the triangular coupling;
 * counted: the pairs whose y differs from the jump pattern's reference run.
 */
function groundTask(task) {
	const W = 200, H = 100, fy = 60;
	const tiles = [];
	for (let x = 1; x < W - 1; x++) if (!(task.gap && x >= 100 && x < 104)) tiles.push([x, fy, 9]);
	const L = mkLevel(W, H, 0, tiles);
	const sim = new E.EESim(L); sim.reset();
	const r = rng(task.seed);
	// no gap: anywhere; the gap (columns 100-103, x 1600-1663): 20-60 px left of its edge, so most h patterns walk off
	sim.px = (task.gap ? 1540 + Math.floor(r() * 40) : 1400 + Math.floor(r() * 150)) + (r() < 0.3 ? 0 : r());
	sim.py = fy * 16 - 16; sim.speed_x = (r() - 0.5) * 12; sim.speed_y = 0;
	sim._q0 = 0; sim._q1 = 0; sim.jump_count = 0;
	// settle one tick with no input so grounded / jump count are the floor's
	const inp = new E.EEInput(); E.applyMask(inp, 0); sim.tick(inp);
	const s = sim.snapshot();
	const T = task.T;
	const PX = patterns([0, 2, 4], T, 2), PY = patterns([0, 1], T, 2);
	const X = PX.map(() => new Float64Array(T * 6)), Y = PY.map(() => new Float64Array(T * 6));
	const m = new Array(T);
	for (let a = 0; a < PX.length; a++) { for (let t = 0; t < T; t++) m[t] = PX[a][t] | PY[0][t]; play(sim, s, m, inp, X[a]); }
	for (let b = 0; b < PY.length; b++) { for (let t = 0; t < T; t++) m[t] = PX[0][t] | PY[b][t]; play(sim, s, m, inp, Y[b]); }
	const rec = new Float64Array(T * 6);
	let runs = 0, missX = 0, missY = 0, sepTicks = 0, ticks = 0;
	for (let a = 0; a < PX.length; a++) {
		for (let b = 0; b < PY.length; b++) {
			if (task.sample && r() > task.sample) continue;
			for (let t = 0; t < T; t++) m[t] = PX[a][t] | PY[b][t];
			play(sim, s, m, inp, rec);
			runs++;
			let bx = false, by = false;
			for (let t = 0; t < T; t++) {
				const o = t * 6;
				if (!Object.is(rec[o], X[a][o]) || !Object.is(rec[o + 1], X[a][o + 1])) bx = true;
				for (const q of [2, 3, 4]) if (!Object.is(rec[o + q], Y[b][o + q])) by = true;
			}
			if (bx) missX++;
			if (by) missY++;
			ticks += T;
		}
	}
	void sepTicks;
	return { gap: !!task.gap, seed: task.seed, px0: s.px, vx0: s.speed_x, T, runs, ticks, missX, missY };
}

// ------------------------------------------------------------------ driver
const JOBS = { free: freeTask, trans: transTask, routes: routeTask, ground: groundTask };

if (!isMainThread) {
	parentPort.on('message', (task) => {
		try { parentPort.postMessage({ ok: true, res: JOBS[task.job](task) }); } catch (err) { parentPort.postMessage({ ok: false, err: String(err && err.stack || err), task }); }
	});
} else if (require.main === module) {
	const job = args._ || 'free';
	const threads = Math.max(1, Math.min(+args.threads || Math.max(1, os.cpus().length - 2), 64));
	const tasks = [];
	if (job === 'free') {
		const T = +args.T || 30, k = +args.k || 2, per = +args.per || 4;
		for (let e = 0; e < ENVS.length; e++) for (let i = 0; i < per; i++) tasks.push({ job, env: e, seed: 1000 * e + i + 1, T, k, sample: +args.sample || 0 });
	} else if (job === 'trans') {
		const T = +args.T || 40, per = +args.per || 6;
		const shifts = [16, 32, 256, 1, 5, 8, 13, 300];
		const bases = [380, 700, 1000, 1990, 3500, 4050];   // binades 2^8 .. 2^12; 1000 / 1990 / 4050 sit near a binade edge
		let seed = 1;
		for (const base of bases) for (let i = 0; i < per; i++) {
			tasks.push({ job, axis: 'x', base, shifts, T, seed: seed++ });
			tasks.push({ job, axis: 'y', base, shifts, T, seed: seed++ });
			tasks.push({ job, axis: 'y', base, shifts, T, seed: seed++, lowg: true });
		}
	} else if (job === 'routes') {
		const root = args.root || process.env.EEAT_TRUTH_ROOT;
		process.env.EEAT_TRUTH_ROOT = root;
		const TS = require('../../src/plan/truthset.js');
		const ks = TS.knownRoutes();
		// the longest first (load balance)
		ks.sort((a, b) => fs.statSync(b.route).size - fs.statSync(a.route).size);
		for (const e of ks) tasks.push({ job, entry: e, root, m18: +args.m18 || 0 });
	} else if (job === 'ground') {
		const T = +args.T || 30, per = +args.per || 4;
		for (let i = 0; i < per; i++) { tasks.push({ job, seed: i + 1, T, sample: +args.sample || 0 }); tasks.push({ job, seed: 100 + i, T, gap: true, sample: +args.sample || 0 }); }
	}
	const results = new Array(tasks.length);
	let next = 0, done = 0;
	const t0 = Date.now();
	const out = args.out || `sepcheck_${job}.json`;
	const workers = [];
	const n = Math.min(threads, tasks.length);
	if (n === 0) { console.log('no tasks'); process.exit(0); }
	const finish = () => {
		fs.writeFileSync(out, JSON.stringify({ job, args, ms: Date.now() - t0, results }, null, 1));
		console.log(`${job}: ${tasks.length} tasks in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
		for (const w of workers) w.terminate();
	};
	for (let i = 0; i < n; i++) {
		const w = new Worker(__filename, { argv: process.argv.slice(2) });
		workers.push(w);
		const give = () => { if (next < tasks.length) { w._i = next; w.postMessage(tasks[next++]); } };
		w.on('message', (msg) => {
			results[w._i] = msg.ok ? msg.res : { error: msg.err };
			if (!msg.ok) console.error('task failed', msg.err);
			done++;
			if (done % Math.max(1, Math.floor(tasks.length / 20)) === 0) console.log(`  ${done}/${tasks.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
			if (done === tasks.length) finish(); else give();
		});
		w.on('error', (err) => { console.error('worker error', err); });
		give();
	}
}

module.exports = { mkLevel, patterns, ENVS, freeTask, transTask, routeTask, groundTask, masks18 };
