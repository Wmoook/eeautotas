'use strict';
// The precision stage of Find a route ("exact landings"; src/editor.js strategy 'precision'): routes that need ONE
// exact sub-pixel position, which every search that keeps one state per cell (every move, the relay, the beams, the
// CPU / GPU random runs' archives) or samples random runs misses. The user's test level (a trophy pocket under a spike
// whose right side is a half block): the ball must drop into the pocket with px == 5720.0 exactly (the spike kills by the
// tile under the box centre at each tick's check, so px >= 5720; the half block's solid right half overlaps the box
// below the corridor, so px <= 5720), one double on a grid of 2^-40 px: a window of zero width.
//
// Why a zero-width window is always at a whole pixel (in fact a multiple of 8 px): every static constraint of the
// engine on the box's x is at a multiple of 8 px (tile edges, half-block edges, the centre rule trunc(px + 8) >> 4, the
// world's edges), so the set of allowed x is a union of intervals whose ends are multiples of 8; a window that is a
// single point is one of them. The same holds for y. (Windows that come from the motion between two checks, e.g. a
// diagonal pass by a spike's corner, are not points and are not looked for here.)
//
// How an exact x is reached (the TAS authors' method, OC's "every combination of 1-4 ticks and how much it moves you"):
// under vertical gravity, on plain tiles, the x motion does not depend on y: the speed update (drag, the 0.0001 snap),
// the 1 px sub-steps (the first snaps x to a whole pixel) and the auto-align. From rest (speed exactly 0) an input
// pattern moves the ball by a fixed amount wherever it starts in the same binade of doubles (x in [2^k, 2^(k+1)): the
// same grid), up to rare double roundings and the auto-align near tile edges. So exact positions add up: a meet in the
// middle finds input pieces whose moves sum to the target exactly:
//   anchor (a real rest state from an attempt) --P1 (the engine: every pattern of up to N1 ticks, then coasting to
//   rest)--> p --m2 (the model: a library of rest-to-rest pieces, relative)--> q --F (the model: every pattern of up to
//   N2 ticks and its coast, at each tick where it comes nearest the target so far, slower than one press)--> X
// with the F table in a hash keyed by the exact start q = X - its move, and p + m2 looked up in it (in the doubles'
// grid units: integers below 2^53, so the sums are exact). Every hit is replayed in the engine from the anchor (the
// model's misses: an auto-align on the way, a double rounding) and continued by an exact local search (below).
//
// Where to aim (the nudge test): the stall's states (the nearest attempts' states nearest the trophy by the reach
// field) are moved to every multiple of 8 px within PREC_REACH px of their x, at rest (speed_x 0), and an exact local
// search from each says whether that position gets nearer the trophy than the state itself: a target X where it does
// by NUDGE_GAIN tiles or finishes. A nudged state is not a reachable state: it only says where exactness would pay; the
// realization above must reach it for real, and every route is replayed by C.evaluate.
//
// The exact local search: best-first by the reach field's cost (src/reach.js; its -1 prunes in physics mode: a proof;
// in walk mode such states are kept and ordered last), states told apart by the full state hash (sim.stateHash(): no
// cells, no merging), a node budget. It also runs from each stall state itself (the baseline; a route found there is
// reported too). A landing whose local search does not finish but gets nearer than the stall is reported as a nearer
// attempt (the editor's CPU search goes on from it).
//
// The tables grow (GROW) while a pass of lookups runs through without a route: about 3x the combinations a step. Measured
// on the laptop (4 lookup threads) from one plain attempt: the user's level (x 5720, a grid of 2^-40 px) a route after
// 4.8 s (step 1); the same puzzle at x 4856 / 1976 / 1016 (2^-40 / -42 / -43) 4.8 / 4.5 / 3.8 s (step 1); at x 104
// (2^-46: 64x finer) no route at step 1, a route at step 4 after 62.8 s.
//
// Scope (not handled): x windows under horizontal gravity, in liquids, on ice, with speed effects (the model's plain
// case; such spots are skipped), y windows, windows that are not points.
//
// CLI (the editor's child; JSON lines like goexplore.js):
//   node src/precision.js <level.eelvl> --attempts=<file> [--workers=N] [--seconds=S] [--depth=D] [--after=S] [--grow=0]
//       [--first=1] [--stdin=1]
//     <file>: one attempt per line (.eetas characters, '0' + mask), nearest first; --after: the lookups go on that long
//     after the first route (AFTER_MS); --grow=0: the first table sizes only
//   {"ev":"start","attempts":n,"workers":n,"startCost":c}
//   {"ev":"progress","phase":"stall"|"nudge"|"tables"|"search","step":k,"targets":n,"hits":n,"landed":n,"lookups":n,"sec":..}
//   {"ev":"target","x":X,"py":..,"gain":tiles,"finish":b}
//   {"ev":"closest","dist":tiles,"tick":T,"inputs":".."}      (a landing's state nearer the trophy than the stall)
//   {"ev":"result","kind":"finish","ticks":T,"runTicks":..,"deaths":n,"inputs":"..","how":"landing"|"local"}  (C.evaluate'd)
//   {"ev":"done","end":"finish"|"exhausted"|"time"|"stopped"|"no target"|"no stall states"|"no anchors","targets":n,"routes":n,"sec":..}
// stdin (--stdin=1): "depth D" (only routes of at most D ticks), "stop".
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('./eesim.js');

const MULT = E.constants.MULT, BD = E.constants.BASE_DRAG, ND = E.constants.NO_MOD_DRAG;
// an arrival this slow is turned round by one press the other way (the next tick): the pin against a wall
const VMAX = 1 / MULT;
// the nudge: multiples of NUDGE_STEP px within PREC_REACH px of a stall state; a target gets NUDGE_GAIN tiles nearer
const NUDGE_STEP = 8, PREC_REACH = 24, NUDGE_GAIN = 1.0;
// the point test: the ball this far to either side of a target must not get as near (else the window is wide)
const NUDGE_EPS = 1 / 64;
// the stall states: up to STALL_K states at most STALL_SLACK tiles above the nearest attempt's cost
const STALL_K = 12, STALL_SLACK = 1.5, LOOKBACK = 600;
// the local search's node budgets: the nudge test (per state), after a landing
const NUDGE_NODES = 2500, LAND_NODES = 40000;
// the meet in the middle: pattern lengths (P1 by the engine, the m2 library, the F table), the rest search's reach
const N1 = 6, N2_LIB = 10, N2_F = 11, COAST_MAX = 400, FLOOR_SCAN = 512, MAX_ANCHORS = 24;
// after the first route the lookups go on this long for faster ones
const AFTER_MS = 20000;
// the nudge test's share of a round (s), the targets realized per round
const NUDGE_S = 30, MAX_TARGETS = 3;
// the F table's slots (2^HASH_LOG: 12 bytes each; filled to 60%)
const HASH_LOG = 24;
const MOVES_X = [0, 2, 4, 1, 3, 5], MOVES_Y = [0, 8, 16, 1, 9, 17];
const MOVES_ALL = [0, 2, 4, 8, 16, 10, 12, 18, 20, 1, 3, 5, 9, 17, 11, 13, 19, 21];
const LAT = [2, 0, 4];   // the lateral patterns' inputs: left, none, right (-1, 0, 1)

// ---------------------------------------------------------------- the lateral model (x, vertical gravity, plain tiles)
// The engine's own arithmetic (eesim.js _playerTick: the speed update, the sub-stepped x motion, the auto-align) for a
// ball whose horizontal acceleration is the input alone (mox 0, moy != 0, not slippery, no speed effect, not in a
// liquid or on a climbable) and that touches no wall. test/precision.js checks it bit for bit against the engine.
function fmod1(x) { return x > 0.0 ? x - Math.trunc(x) : x % 1.0; }
function fmod16(x) { return x > 0.0 ? x - 16.0 * Math.floor(x * 0.0625) : x % 16.0; }
/** the tick's speed: sx the speed before, mx the input (-1, 0, 1) */
function latSpeed(sx, mx) {
	const modx = mx / MULT;
	if (sx !== 0.0 || modx !== 0.0) {
		let s = sx + modx;
		if (mx === 0 || (s < 0.0 && mx > 0) || (s > 0.0 && mx < 0)) { s *= BD; s *= ND; } else s *= BD;
		if (s > 16.0) s = 16.0; else if (s < -16.0) s = -16.0; else if (s < 0.0001 && s > -0.0001) s = 0.0;
		return s;
	}
	return sx;
}
/** the sub-stepped move by the tick's speed sx (no wall) */
function latMove(px, sx) {
	if (sx === 0.0) return px;
	let remx = fmod1(px), csx = sx;
	while (csx !== 0.0) {
		if (csx > 0.0) {
			if (csx + remx >= 1.0) { px += (1.0 - remx); px = px | 0; csx -= (1.0 - remx); remx = 0.0; } else { px += csx; csx = 0.0; }
		} else if (remx + csx < 0.0 && remx !== 0.0) { csx += remx; px -= remx; px = px | 0; remx = 1.0; } else { px += csx; csx = 0.0; }
	}
	return px;
}
/** the auto-align after the move (|speed| < 1, no input) */
function latAlign(px, sx, mx) {
	if (sx >= 1.0 || sx <= -1.0 || mx !== 0) return px;
	const tx = fmod16(px);
	if (tx < 2.0) return tx < 0.2 ? px | 0 : px - tx / 15.0;
	if (tx > 14.0) return tx > 15.8 ? (px | 0) + 1.0 : px + (tx - 14.0) / 15.0;
	return px;
}
/** one tick of the model: st {px, sx}, mx -1 / 0 / 1; align false: without the auto-align (the relative pieces) */
function latTick(st, mx, align) {
	const s = latSpeed(st.sx, mx);
	const px = latMove(st.px, s);
	st.sx = s;
	st.px = align === false ? px : latAlign(px, s, mx);
}
/** the grid of doubles around x: base 2^k <= x < 2^(k+1), ulp 2^(k-52) */
function gridOf(x) {
	const k = Math.floor(Math.log2(x));
	let base = 2 ** k;
	if (base > x) base /= 2; else if (base * 2 <= x) base *= 2;
	return { base, ulp: base * 2 ** -52, top: base * 2 };
}

// ---------------------------------------------------------------- the engine side
function makeCtx(level, field) {
	const RF = require('./reach.js');
	const sim = new E.EESim(level);
	sim.reset();
	const ctx = { level, sim, inp: new E.EEInput(), field: field || RF.reachField(level), RF, fin: false, scratch: new E.EESim(level) };
	sim.onEvent = (k) => { if (k === 'complete') ctx.fin = true; };
	ctx.start = sim.snapshot();
	ctx.startCost = RF.costAt(ctx.field, sim);
	return ctx;
}
const costOf = (ctx) => ctx.RF.costAt(ctx.field, ctx.sim);
// the order: the reach field's cost blended between the 4 tile centres around the ball (a slope inside a tile: a ball
// falling through a tile's upper half is nearer than one standing on its floor), plus a little per tick
const scoreOf = (ctx) => { const s = ctx.sim; return ctx.RF.scoreAt(ctx.field, s.px, s.py, s.speed_y, s._q0, s._q1, s._slippery); };
const TICK_W = 0.002;
/** plays masks from the current state; false when the ball died; ctx.fin tells a finish */
function play(ctx, masks, from, to) {
	const sim = ctx.sim, inp = ctx.inp;
	for (let k = from || 0, n = to === undefined ? masks.length : to; k < n; k++) {
		E.applyMask(inp, masks[k]);
		sim.tick(inp);
		if (ctx.fin) return true;
		if (sim.is_dead) return false;
	}
	return true;
}
/** the moves worth trying from the sim's state: the lateral inputs of its gravity, all of them without gravity */
function movesOf(sim) {
	if (sim.mox === 0 && sim.moy !== 0) return MOVES_X;
	if (sim.moy === 0 && sim.mox !== 0) return MOVES_Y;
	return MOVES_ALL;
}
/** the lateral model applies at this state (see latSpeed) */
function plainX(ctx) {
	const s = ctx.sim, L = ctx.level;
	if (s.in_god_mode || s.mox !== 0 || s.moy === 0 || s._slippery > 0 || s.speed_boost !== 0 || s.is_zombie || s.has_levitation) return false;
	const fl = L.flags[s._current] | 0;
	return (fl & (64 | 32)) === 0;   // F_LIQUID, F_CLIMB
}

// ---------------------------------------------------------------- the exact local search
class Heap {
	constructor() { this.p = []; this.v = []; }
	get size() { return this.p.length; }
	push(pr, v) {
		const p = this.p, a = this.v;
		let i = p.length;
		p.push(pr); a.push(v);
		while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pr) break; p[i] = p[j]; a[i] = a[j]; i = j; }
		p[i] = pr; a[i] = v;
	}
	pop() {
		const p = this.p, a = this.v, top = a[0], lp = p.pop(), lv = a.pop();
		const n = p.length;
		if (n) {
			let i = 0;
			for (;;) {
				let c = 2 * i + 1;
				if (c >= n) break;
				if (c + 1 < n && p[c + 1] < p[c]) c++;
				if (p[c] >= lp) break;
				p[i] = p[c]; a[i] = a[c]; i = c;
			}
			p[i] = lp; a[i] = lv;
		}
		return top;
	}
}
/** best-first from snap (the reach field's blended score, then fewer ticks), every state told apart by its full hash; o: {nodes,
 *  depth}. -> {finish: masks from snap | null, cost: the lowest cost reached, masks: its inputs, expanded} */
function localSearch(ctx, snap, o) {
	const sim = ctx.sim, inp = ctx.inp;
	const maxNodes = o && o.nodes || NUDGE_NODES, maxDepth = o && o.depth || 600;
	sim.restore(snap);
	ctx.fin = false;
	// (the reach field's -1 is a proof only in physics mode: in walk mode such states are kept, ordered last)
	const prune = ctx.field.mode === 'physics';
	const c0 = costOf(ctx);
	if ((c0 < 0 && prune) || sim.is_dead) return { finish: null, cost: Infinity, masks: [], expanded: 0 };
	const par = [-1], mk = [0], dep = [0], snaps = [snap];
	const seen = new Set([sim.stateHash()]);
	const heap = new Heap();
	heap.push(scoreOf(ctx), 0);
	let best = c0 < 0 ? Infinity : c0, bestNode = 0, expanded = 0;
	const pathOf = (i) => { const a = []; while (i > 0) { a.push(mk[i]); i = par[i]; } return a.reverse(); };
	while (heap.size && expanded < maxNodes) {
		const i = heap.pop();
		const s = snaps[i];
		snaps[i] = null;   // (expanded: its children carry on)
		if (dep[i] >= maxDepth) continue;
		expanded++;
		sim.restore(s);
		const moves = movesOf(sim);
		for (let m = 0; m < moves.length; m++) {
			if (m) sim.restore(s);
			ctx.fin = false;
			E.applyMask(inp, moves[m]);
			sim.tick(inp);
			if (ctx.fin) {
				const a = pathOf(i); a.push(moves[m]);
				return { finish: a, cost: 0, masks: a, expanded };
			}
			if (sim.is_dead) continue;
			const h = sim.stateHash();
			if (seen.has(h)) continue;
			const c = costOf(ctx);
			if (c < 0 && prune) continue;
			seen.add(h);
			const k = par.length;
			par.push(i); mk.push(moves[m]); dep.push(dep[i] + 1); snaps.push(sim.snapshot());
			if (c >= 0 && c < best) { best = c; bestNode = k; }
			heap.push((c < 0 ? 1e6 : scoreOf(ctx)) + (dep[i] + 1) * TICK_W, k);
		}
	}
	return { finish: null, cost: best, masks: pathOf(bestNode), expanded };
}

// ---------------------------------------------------------------- the stall states and the nudge test
/** the states of the attempts (masks arrays from the start) nearest the trophy: [{snap, tick, attempt, cost, px, py,
 *  ground}], and every state of each attempt (for the anchors: states[a][t] = snapshot after t ticks) */
function stallStates(ctx, attempts) {
	const sim = ctx.sim, all = [], states = [];
	let cmin = Infinity;
	attempts.forEach((ms, a) => {
		sim.restore(ctx.start);
		ctx.fin = false;
		// (the snapshots of the last LOOKBACK ticks only: a long attempt's precision spot is where it stalled)
		const st = new Array(ms.length + 1).fill(null);
		st[0] = sim.snapshot();
		let end = ms.length;
		for (let t = 0; t < ms.length; t++) {
			E.applyMask(ctx.inp, ms[t]);
			sim.tick(ctx.inp);
			if (sim.is_dead || ctx.fin) { end = t; break; }
			st[t + 1] = sim.snapshot();
			if (t + 1 > LOOKBACK) st[t + 1 - LOOKBACK] = null;
			const c = costOf(ctx);
			if (c < 0) continue;
			all.push({ a, t: t + 1, cost: c, px: sim.px, py: sim.py, ground: sim.on_ground });
		}
		for (let i = all.length - 1; i >= 0 && all[i].a === a; i--) if (all[i].t >= end + 1 - LOOKBACK && all[i].cost < cmin) cmin = all[i].cost;
		states.push(st);
	});
	const live = all.filter((s) => states[s.a][s.t]);
	live.sort((x, y) => x.cost - y.cost || x.t - y.t);
	const pick = [], seen = new Set();
	for (const s of live) {
		if (s.cost > cmin + STALL_SLACK || pick.length >= STALL_K) break;
		const key = `${Math.round(s.px)},${Math.round(s.py)},${s.ground ? 1 : 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pick.push(Object.assign(s, { snap: states[s.a][s.t] }));
	}
	return { stall: pick, states, cmin };
}
/** a copy of state snap with the ball at x = X, at rest; null when the box would overlap a block there */
function nudged(ctx, snap, X) {
	const sim = ctx.scratch;
	sim.restore(snap);
	if (sim._ovAt(X, sim.py) !== 0) return null;
	sim.restore(snap);
	sim.px = X; sim.prev_px = X; sim._ox = X; sim.speed_x = 0.0;
	return sim.snapshot();
}
/** the nudge test: -> {targets [{x, py, gain, finish, from: stall state, cont: masks from the nudged state}], routes
 *  [{masks from the start, how}]} */
function nudgeTest(ctx, stall, cmin, o) {
	const targets = new Map(), routes = [];
	const nodes = o && o.nudgeNodes || NUDGE_NODES, deadline = o && o.deadline || Infinity;
	for (const s of stall) {
		if (Date.now() > deadline) break;
		const base = localSearch(ctx, s.snap, { nodes });
		if (base.finish) routes.push({ from: s, cont: base.finish, how: 'local' });
		const ref = Math.min(base.cost, cmin);
		const x0 = Math.ceil((s.px - PREC_REACH) / NUDGE_STEP) * NUDGE_STEP;
		for (let X = x0; X <= s.px + PREC_REACH; X += NUDGE_STEP) {
			if (X === s.px || X <= 0) continue;
			const n = nudged(ctx, s.snap, X);
			if (!n) continue;
			const r = localSearch(ctx, n, { nodes });
			const gain = ref - r.cost;
			if (!r.finish && !(gain >= NUDGE_GAIN)) continue;
			// (a window of zero width: the ball a hair to either side does not get there; a wider one is the other searches' work)
			const wide = [X - NUDGE_EPS, X + NUDGE_EPS].some((x) => { const m = nudged(ctx, s.snap, x); if (!m) return false; const q = localSearch(ctx, m, { nodes }); return !!q.finish || ref - q.cost >= NUDGE_GAIN; });
			if (wide) continue;
			const key = `${X},${s.py}`;
			const old = targets.get(key);
			const t = { x: X, py: s.py, gain: r.finish ? ref : gain, finish: !!r.finish, from: s, cont: r.finish || r.masks };
			if (!old || (t.finish && !old.finish) || (t.finish === old.finish && t.gain > old.gain)) targets.set(key, t);
		}
	}
	const list = [...targets.values()].sort((a, b) => (b.finish - a.finish) || (b.gain - a.gain));
	return { targets: list, routes };
}

// ---------------------------------------------------------------- the floor, the anchors, P1 (the engine)
/** the stretch of floor at the rest state snap: {lo, hi, loOpen, hiOpen} (x of the box) where a ball at rest stays at
 *  rest there alive: scanned in half pixels from its x (the rules change only at whole pixels) */
function floorOf(ctx, snap) {
	const sim = ctx.scratch, inp = new E.EEInput();
	sim.restore(snap);
	const py = sim.py, x0 = sim.px;
	const ok = (x) => {
		sim.restore(snap);
		if (sim._ovAt(x, py) !== 0) return false;
		sim.restore(snap);
		sim.px = x; sim.prev_px = x; sim._ox = x; sim.speed_x = 0.0;
		E.applyMask(inp, 0);
		sim.tick(inp);
		return !sim.is_dead && sim.on_ground && sim.py === py && Math.abs(sim.px - x) < 2.5;
	};
	const scan = (dir) => {
		// whole pixels k and the open stretches (k, k + 1) between them, outward from x0
		let k = dir < 0 ? Math.floor(x0) : Math.ceil(x0), last = x0;
		if (k === x0) k += dir;
		for (let n = 0; n < FLOOR_SCAN; n++, k += dir) {
			if (!ok(k - dir * 0.5)) return { end: last, open: false };   // (the stretch ends at last, which held)
			if (!ok(k)) return { end: k, open: true };                    // (it holds up to k, not at k)
			last = k;
		}
		return { end: last, open: false };
	};
	const l = scan(-1), r = scan(1);
	return { py, lo: l.end, loOpen: l.open, hi: r.end, hiOpen: r.open };
}
const inFloor = (f, x) => (f.loOpen ? x > f.lo : x >= f.lo) && (f.hiOpen ? x < f.hi : x <= f.hi);
/** the rest anchors: every state of the attempts (their kept snapshots) on a floor, coasted (no input) to rest in the
 *  engine, where the lateral model applies; [{snap, px, py, a (attempt), t (its tick), coast (ticks of no input to
 *  rest)}], distinct (x, y) */
function anchorsOf(ctx, states) {
	const sim = ctx.sim, out = [], seen = new Set();
	for (let a = 0; a < states.length; a++) {
		for (let t = states[a].length - 1; t >= 0; t--) {
			if (!states[a][t]) continue;
			sim.restore(states[a][t]);
			if (!sim.on_ground || sim.is_dead) continue;
			const py = sim.py;
			let c = 0;
			while (sim.speed_x !== 0 && c < COAST_MAX) { E.applyMask(ctx.inp, 0); sim.tick(ctx.inp); c++; if (sim.is_dead || sim.py !== py) break; }
			if (sim.is_dead || sim.speed_x !== 0 || sim.py !== py || !sim.on_ground) continue;
			const key = `${sim.px},${py}`;
			if (seen.has(key) || !plainX(ctx)) continue;
			seen.add(key);
			out.push({ snap: sim.snapshot(), px: sim.px, py, a, t, coast: c });
		}
	}
	return out;
}
/** the anchors by stretch of floor: [{floor, anchors (at most MAX_ANCHORS, spread over x)}] */
function floorsOf(ctx, anchors) {
	const out = [];
	const left = anchors.slice().sort((x, y) => x.py - y.py || x.px - y.px);
	while (left.length) {
		const floor = floorOf(ctx, left[0].snap);
		const mine = left.filter((A) => A.py === floor.py && inFloor(floor, A.px));
		const rest = left.filter((A) => !(A.py === floor.py && inFloor(floor, A.px)));
		// (an anchor the stretch scan does not hold, e.g. auto-aligned onto an edge: its own stretch)
		if (!mine.length) mine.push(left[0]), rest.splice(rest.indexOf(left[0]), 1);
		left.length = 0; left.push(...rest);
		let pick = mine;
		if (mine.length > MAX_ANCHORS) { const step = mine.length / MAX_ANCHORS; pick = []; for (let i = 0; i < MAX_ANCHORS; i++) pick.push(mine[Math.floor(i * step)]); }
		out.push({ floor, anchors: pick });
	}
	return out;
}
/** P1: every lateral pattern of 1..N1 ticks from each anchor (ending with a press), coasted to rest, in the engine;
 *  [{px, anchor, code, len, coast}] with distinct rest x on the floor */
function restsOf(ctx, anchors, floor, n1) {
	const sim = ctx.sim, inp = ctx.inp, out = [], seen = new Set();
	const lvl = [];
	for (let ai = 0; ai < anchors.length; ai++) {
		const A = anchors[ai];
		if (!seen.has(A.px)) { seen.add(A.px); out.push({ px: A.px, anchor: ai, code: 0, len: 0, coast: 0 }); }
		// depth-first with the snapshot of each depth
		const stack = [[0, 0, 0]];   // [depth, code, last input]
		lvl[0] = A.snap;
		const rec = (d, code) => {
			for (let i = 0; i < 3; i++) {
				if (i === 1 && d === 0) continue;   // (a pattern starts with a press)
				sim.restore(lvl[d]);
				E.applyMask(inp, LAT[i]);
				sim.tick(inp);
				if (sim.is_dead || sim.py !== floor.py || !inFloor(floor, sim.px)) continue;
				const c2 = code * 3 + i;
				if (d + 1 < n1) { lvl[d + 1] = sim.snapshot(); rec(d + 1, c2); sim.restore(lvl[d + 1]); }
				if (i === 1) continue;   // (ends with a press)
				let c = 0;
				while (sim.speed_x !== 0 && c < COAST_MAX) {
					E.applyMask(inp, 0); sim.tick(inp); c++;
					if (sim.is_dead || sim.py !== floor.py || !inFloor(floor, sim.px)) { c = -1; break; }
				}
				if (c < 0 || sim.speed_x !== 0 || !sim.on_ground || seen.has(sim.px)) continue;
				seen.add(sim.px);
				out.push({ px: sim.px, anchor: ai, code: c2, len: d + 1, coast: c });
			}
		};
		void stack;
		rec(0, 0);
	}
	return out;
}
const decode = (code, len) => { const a = new Array(len); for (let k = len - 1; k >= 0; k--) { a[k] = LAT[code % 3]; code = Math.floor(code / 3); } return a; };

// ---------------------------------------------------------------- FAST RESTS (n5-perfect, part 5: the known TASes' way)
// The rest anchors above are the attempts' states COASTED to rest (no input: from a run at 3.5 px/tick ~85 ticks) and
// every piece after them coasts to rest too (~60 ticks each): the compiled routes of the precision puzzle took 319-358
// run ticks where the best known TAS takes 111 (src/jobs test-precision-puzzle, replayed: it brakes with opposite presses
// from full speed at tick 57 to a speed of 0.0006 at tick 75, the speed snaps to exactly 0 at tick 90, and ONE 20-tick
// piece from that rest lands on x = 5720.0 exactly while moving). A rest is any state whose speed is exactly 0 (the
// engine's 0.0001 snap), and the fastest rests come from BRAKING, not coasting: from the attempts' MOVING states on the
// floor every lateral pattern of up to FAST_K ticks (the model, bit for bit the engine's: latTick) followed by at most
// FAST_COAST ticks of no input, cut where the ball can no longer stop on the floor (the least stopping distance of its
// speed, a table from the model), cut where it reaches rest (the rest's continuations are the library's and the F
// table's), within FAST_NODES model ticks. Each rest keeps its fewest ticks from the level start, and the pieces after it
// are capped too (the library's and the arrivals' coasts at FAST_LIB_COAST / FAST_AT), so every exact landing found is
// a short one; the hits are then replayed in order of their ticks (the first that finishes is the fastest found).
const FAST_K = 22, FAST_COAST = 30, FAST_NODES = 2e8, FAST_NODES_MIN = 2e7, FAST_NS = 2.5e6, FAST_LIB_COAST = 40, FAST_AT = 48, FAST_ANCHORS = 48;
const BRAKE_L = [2, 1, 0], BRAKE_R = [0, 1, 2], FAST_SLACK = 12, FAST_OVER_MS = 8000, FAST_STEPS = [0, 2], FAST_OLD = 0.4;
/** the least distance a ball at lateral speed v (|v| in 1/1024 px/tick steps, rounded down) travels before its speed
 *  is exactly 0, braking with the opposite input every tick (a lower bound for every input word: the model) */
let STOP_TABLE = null;
function stopTable() {
	if (STOP_TABLE) return STOP_TABLE;
	const n = 17 * 1024, t = new Float64Array(n);
	const st = { px: 0, sx: 0 };
	for (let k = 0; k < n; k++) {
		const v = k / 1024;
		st.px = 0; st.sx = v;
		let far = 0, c = 0;
		while (st.sx !== 0 && c < 4000) { latTick(st, st.sx > 0 ? -1 : 0, false); if (st.px > far) far = st.px; c++; }
		t[k] = far;
	}
	// (monotone: a faster ball never stops sooner; the rounding down keeps it a lower bound)
	for (let k = 1; k < n; k++) if (t[k] < t[k - 1]) t[k] = t[k - 1];
	STOP_TABLE = t;
	return t;
}
const stopDist = (v) => { const t = stopTable(); const k = Math.min(t.length - 1, Math.floor(Math.abs(v) * 1024)); return t[k] * 0.999; };
/** the moving anchors: the attempts' kept states on this floor (on the ground, the lateral model applies), the latest
 *  FAST_ANCHORS of each attempt: [{snap, px, py, a, t, coast: 0, sx}] */
function movingAnchorsOf(ctx, states, floor) {
	const sim = ctx.sim, out = [];
	for (let a = 0; a < states.length; a++) {
		let k = 0;
		for (let t = states[a].length - 1; t >= 0 && k < FAST_ANCHORS; t--) {
			if (!states[a][t]) continue;
			sim.restore(states[a][t]);
			if (!sim.on_ground || sim.is_dead || sim.py !== floor.py || !inFloor(floor, sim.px) || !plainX(ctx)) continue;
			out.push({ snap: states[a][t], px: sim.px, py: sim.py, a, t, coast: 0, sx: sim.speed_x });
			k++;
		}
	}
	return out;
}
/** THE EARLY BRAKE (C6 lane 5 block 4; OPT-IN EEAT_PREC_AIR_EARLY=1, with EEAT_PREC_AIR=1): the air pass's moving anchors
 *  where the brake toward X must START, not the attempts' latest states. The precision puzzle's best known (111) and our
 *  153 route are the same run up to tick 56 (x 5745.08, vx -3.53); the known brakes from tick 57 and rests 0.36 px off X at
 *  tick 77, then jumps and lands x == X in the air; movingAnchorsOf's latest 48 states of an attempt are its late creep
 *  (ours rests at 5721.21 only at tick ~113), and its node budget spread over every anchor never covers a 20-tick brake.
 *  Here: every kept state of every attempt on this floor moving toward X whose hardest brake (stopDist, a lower bound of
 *  every input word) still stops at X or before it by at most EARLY_SPAN px, the same state once (prefixes of one route
 *  share it), the EARLIEST EARLY_K of them: the whole fast-rest budget on the brakes that can rest near X soonest. */
const PREC_AIR_EARLY = process.env.EEAT_PREC_AIR_EARLY === '1';
const EARLY_K = +process.env.EEAT_PREC_EARLY_K || 4, EARLY_SPAN = +process.env.EEAT_PREC_EARLY_SPAN || 12;
function earlyAnchorsOf(ctx, states, floor, X, side) {
	const sim = ctx.sim, out = [], seen = new Set();
	const dir = side === 'right' ? -1 : 1;
	for (let a = 0; a < states.length; a++) {
		for (let t = 0; t < states[a].length; t++) {
			if (!states[a][t]) continue;
			sim.restore(states[a][t]);
			if (!sim.on_ground || sim.is_dead || sim.py !== floor.py || !inFloor(floor, sim.px) || !plainX(ctx)) continue;
			const v = sim.speed_x * dir, d = (X - sim.px) * dir;
			if (!(v > 0) || !(d > 0)) continue;
			const s = d - stopDist(v);
			if (s < 0 || s > EARLY_SPAN) continue;
			const key = `${sim.px},${sim.speed_x}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ snap: states[a][t], px: sim.px, py: sim.py, a, t, coast: 0, sx: sim.speed_x });
		}
	}
	out.sort((x, y) => x.t - y.t);
	return out.slice(0, EARLY_K);
}
/** the fast rests: [{px, anchor, code, len, coast, total}] (distinct rest x, each with its fewest ticks from the start) */
function fastRestsOf(anchors, floor, o) {
	const K = o && o.k || FAST_K, CO = o && o.coast || FAST_COAST, budget = o && o.nodes || FAST_NODES;
	const best = new Map();
	const st = { px: 0, sx: 0 };
	let nodes = 0;
	const lo = floor.loOpen ? floor.lo : floor.lo - 1e-9, hi = floor.hiOpen ? floor.hi : floor.hi + 1e-9;
	const snapMax = 0.0001 / Math.pow(BD * ND, CO) * 1.02;
	const keep = (px, ai, code, len, coast, total) => {
		const old = best.get(px);
		if (!old || total < old.total) best.set(px, { px, anchor: ai, code, len, coast, total });
	};
	// (the latest anchors first: they are nearest their rests; each anchor gets an equal share of what is left)
	const order = anchors.map((_, i) => i).sort((x, y) => anchors[y].t - anchors[x].t);
	for (let oi = 0; oi < order.length && nodes < budget; oi++) {
		const ai = order[oi], A = anchors[ai];
		const cap = nodes + (budget - nodes) / (order.length - oi);
		const rec = (px, sx, d, code) => {
			// (the brake first: the fastest rests brake from the run's speed)
			const ord = sx < 0 ? BRAKE_L : BRAKE_R;
			for (let q = 0; q < 3 && nodes < cap; q++) {
				const i = ord[q];
				st.px = px; st.sx = sx;
				latTick(st, i - 1, true);
				nodes++;
				const px2 = st.px, sx2 = st.sx;
				if (!(px2 > lo && px2 < hi)) continue;
				// (it can no longer stop on the floor)
				if (sx2 < 0 ? px2 - stopDist(sx2) <= lo : sx2 > 0 ? px2 + stopDist(sx2) >= hi : false) continue;
				const c2 = code * 3 + i;
				if (sx2 === 0) { keep(px2, ai, c2, d + 1, 0, A.t + d + 1); continue; }
				// the coast to rest after this pattern (only after a press: an idle tick's coast is the idle branch)
				// (a coast of CO ticks can snap only a speed below 0.0001 / q^CO: q the idle drag, a margin for the roundings)
				if (i !== 1 && Math.abs(sx2) < snapMax) {
					st.px = px2; st.sx = sx2;
					let c = 0, ok = true;
					while (st.sx !== 0 && c < CO) { latTick(st, 0, true); c++; nodes++; if (!(st.px > lo && st.px < hi)) { ok = false; break; } }
					if (ok && st.sx === 0) keep(st.px, ai, c2, d + 1, c, A.t + d + 1 + c);
				}
				if (d + 1 < K) rec(px2, sx2, d + 1, c2);
			}
		};
		rec(A.px, A.sx, 0, 0);
	}
	const out = [...best.values()];
	out.sort((x, y) => x.total - y.total);
	return { rests: out, nodes };
}

// ---------------------------------------------------------------- the model's tables (relative pieces)
/** the rest-to-rest library: every lateral pattern of 1..n ticks (ending with a press) from rest, coasted to rest, no
 *  auto-align; in grid units of g: {du, lo, hi (the excursion, px), code, len, coast} (distinct du) */
function libraryOf(g, ref, n, coastMax) {
	const CM = coastMax || COAST_MAX;
	const du = [], lo = [], hi = [], code = [], len = [], coast = [];
	const seen = new Set();
	const st = { px: 0, sx: 0 };
	const rec = (px, sx, d, c, mn, mxp) => {
		for (let i = 0; i < 3; i++) {
			if (i === 1 && sx === 0) continue;
			st.px = px; st.sx = sx;
			latTick(st, i - 1, false);
			const px2 = st.px, sx2 = st.sx, c2 = c * 3 + i, mn2 = Math.min(mn, px2), mx2 = Math.max(mxp, px2);
			if (px2 - ref < -200 || px2 - ref > 200) continue;
			if (d + 1 < n) rec(px2, sx2, d + 1, c2, mn2, mx2);
			if (i === 1 || sx2 === 0) continue;
			let t = 0, a = mn2, b = mx2;
			st.px = px2; st.sx = sx2;
			while (st.sx !== 0 && t < CM) { latTick(st, 0, false); t++; if (st.px < a) a = st.px; if (st.px > b) b = st.px; }
			if (st.sx !== 0) continue;
			const u = (st.px - ref) / g.ulp;
			if (u === 0 || seen.has(u)) continue;
			seen.add(u);
			du.push(u); lo.push(a - ref); hi.push(b - ref); code.push(c2); len.push(d + 1); coast.push(t);
		}
	};
	rec(ref, 0, 0, 0, ref, ref);
	// (sorted by the move: a rest's lookups are the window of moves that land in the F table's range)
	const ix = du.map((_, k) => k).sort((a, b) => du[a] - du[b]);
	const pick = (a) => ix.map((k) => a[k]);
	return { du: Float64Array.from(pick(du)), lo: Float64Array.from(pick(lo)), hi: Float64Array.from(pick(hi)), code: pick(code), len: pick(len), coast: pick(coast), n: du.length };
}
/** a hash of exact grid positions (integers below 2^53) -> int, open addressing in shared memory; with the F table's
 *  entries (typed arrays of up to `limit` = 60% of the slots: the pattern code, its ticks, the ticks to the arrival, the
 *  excursion) */
function makeHash(log) {
	const cap = 2 ** log, limit = Math.floor(cap * 0.6);
	const keys = new Float64Array(new SharedArrayBuffer(cap * 8)).fill(-1), vals = new Int32Array(new SharedArrayBuffer(cap * 4));
	return { log, cap, keys, vals, n: 0, limit, code: new Int32Array(limit), len: new Uint8Array(limit), at: new Uint16Array(limit), far: new Float64Array(new SharedArrayBuffer(limit * 8)) };
}
function clearHash(H) { if (H.n) { H.keys.fill(-1); H.n = 0; } }
function slotOf(u, log) {
	const lo = u % 4294967296, hi = Math.floor(u / 4294967296);
	return (Math.imul((lo | 0) ^ Math.imul(hi | 0, 0x9E3779B1), 0x85EBCA6B) >>> 0) >>> (32 - log);
}
function hashPut(H, u, v) {
	const m = H.cap - 1;
	let h = slotOf(u, H.log);
	while (H.keys[h] !== -1) { if (H.keys[h] === u) return false; h = (h + 1) & m; }
	H.keys[h] = u; H.vals[h] = v; H.n++;
	return true;
}
function hashGet(keys, vals, log, u) {
	const m = keys.length - 1;
	let h = slotOf(u, log);
	for (;;) { const k = keys[h]; if (k === -1) return -1; if (k === u) return vals[h]; h = (h + 1) & m; }
}
/** the F table: from rest at ref, every lateral pattern of 1..n ticks (and its coast, no auto-align), at each tick where
 *  the ball comes nearer X than ever before (side 'right': moving left, a new least x; 'left' the mirror) no faster than
 *  VMAX: the exact start Q = X - (x - ref) as the hash key (grid units of g) -> the F entry {code, len (pattern ticks),
 *  at (ticks to the arrival), far (the excursion away from X, px from the start)} */
function arrivalsOf(g, ref, X, side, n, H, limit, atMax, air) {
	if (air) return airArrivalsOf(g, ref, X, n, H, limit, air);
	const AM = atMax || Infinity;
	clearHash(H);
	const { code, len, at, far } = H;
	limit = Math.min(limit || H.limit, H.limit);
	const uX = (X - g.base) / g.ulp, uRef = (ref - g.base) / g.ulp;
	let uMin = Infinity, uMax = -Infinity;
	const st = { px: 0, sx: 0 };
	const dir = side === 'right' ? -1 : 1;
	let full = false;
	const cand = (px, sx, c, d, t, farPx) => {
		if (full) return;
		if (dir < 0 ? !(sx <= 0 && -sx <= VMAX) : !(sx >= 0 && sx <= VMAX)) return;
		const u = uX - ((px - g.base) / g.ulp - uRef);
		if (u < 0 || u >= 2 ** 53) return;
		const k = H.n;
		if (hashPut(H, u, k)) { code[k] = c; len[k] = d; at[k] = t; far[k] = farPx; if (u < uMin) uMin = u; if (u > uMax) uMax = u; }
		if (H.n >= limit) full = true;
	};
	const rec = (px, sx, d, c, near, farPx) => {
		for (let i = 0; i < 3 && !full; i++) {
			if (i === 1 && sx === 0) continue;
			st.px = px; st.sx = sx;
			latTick(st, i - 1, false);
			const px2 = st.px, sx2 = st.sx, c2 = c * 3 + i;
			const far2 = Math.max(farPx, dir < 0 ? px2 - ref : ref - px2);
			let near2 = near;
			if (dir < 0 ? px2 < near : px2 > near) { near2 = px2; cand(px2, sx2, c2, d + 1, d + 1, far2); }
			if (Math.abs(px2 - ref) > 200) continue;
			if (d + 1 < n) rec(px2, sx2, d + 1, c2, near2, far2);
			if (i === 1 || sx2 === 0) continue;
			// the coast (no input) after the pattern
			st.px = px2; st.sx = sx2;
			let t = d + 1, nr = near2;
			while (st.sx !== 0 && t < d + 1 + COAST_MAX && t < AM && !full) {
				latTick(st, 0, false); t++;
				if (dir < 0 ? st.px < nr : st.px > nr) { nr = st.px; cand(st.px, st.sx, c2, d + 1, t, far2); }
			}
		}
	};
	rec(ref, 0, 0, 0, ref, 0);
	return { code, len, at, far, n: H.n, full, uMin, uMax };
}
// THE AIRBORNE ARRIVAL (C6 lane 5 block 3; OPT-IN EEAT_PREC_AIR=1, unset: the stage byte for byte as before): the ground
// pieces above arrive at X on the floor, so the ball must creep onto the window's edge at the end of a coast (the
// precision puzzle: 153 run ticks, a 34-tick piece from a rest 1.2 px away whose last 18 ticks crawl from 5720.52 to
// 5720.0). The best known route (111) jumps from a rest 0.36 px from X instead, bonks the ceiling, steers in the air and
// is at x == X exactly at the tick its fall passes the floor's level. Under vertical gravity on plain tiles the x motion
// does not depend on y (the binade lemma holds from any speed and in the air), and the jump's y path does not depend on
// x, so an airborne piece is: from rest, the jump on its first tick, every lateral pattern of 1..n ticks and its coast,
// at the tick k the fall comes back to the floor's level (airTimeOf: the engine from a real rest of that floor) or one
// tick before; any direction, no faster than VMAX (one press toward the window's wall stops it there). Its excursion is
// in the air: far 0 (the engine's replay of every hit judges the way).
function airArrivalsOf(g, ref, X, n, H, limit, k) {
	clearHash(H);
	const { code, len, at, far } = H;
	limit = Math.min(limit || H.limit, H.limit);
	const uX = (X - g.base) / g.ulp, uRef = (ref - g.base) / g.ulp;
	let uMin = Infinity, uMax = -Infinity;
	const st = { px: 0, sx: 0 };
	let full = false;
	// (from rest an idle tick moves nothing, so a pattern that arrives at its own tick t < k arrives at k when it starts
	// k - t ticks after the jump: every tick of every pattern and coast is a candidate, the delay kept in at's high byte;
	// at the arrival no faster leftward than one press (the next press toward the window's wall stops it), any rightward)
	const cand = (px, sx, c, d, t) => {
		if (full || !(sx >= -VMAX)) return;
		const u = uX - ((px - g.base) / g.ulp - uRef);
		if (u < 0 || u >= 2 ** 53) return;
		const kk = H.n;
		if (hashPut(H, u, kk)) { code[kk] = c; len[kk] = d; at[kk] = k | ((k - t) << 8); far[kk] = 0; if (u < uMin) uMin = u; if (u > uMax) uMax = u; }
		if (H.n >= limit) full = true;
	};
	const rec = (px, sx, d, c) => {
		for (let i = 0; i < 3 && !full; i++) {
			if (i === 1 && d === 0) continue;   // (a pattern starts with a press: the delay is its idle start)
			st.px = px; st.sx = sx;
			latTick(st, i - 1, false);
			const px2 = st.px, sx2 = st.sx, c2 = c * 3 + i, d2 = d + 1;
			if (Math.abs(px2 - ref) > 200) continue;
			cand(px2, sx2, c2, d2, d2);
			if (d2 < n && d2 < k) rec(px2, sx2, d2, c2);
			if (i === 1 || d2 >= k) continue;
			// the coast (no input) after the pattern, every tick to the floor's level
			st.px = px2; st.sx = sx2;
			let t = d2;
			while (t < k && st.sx !== 0) { latTick(st, 0, false); t++; cand(st.px, st.sx, c2, d2, t); }
		}
	};
	if (k >= 2) rec(ref, 0, 0, 0);
	return { code, len, at, far, n: H.n, full, uMin, uMax };
}
/** the ticks from a jump at rest on the floor fl (one press, no lateral input) to the tick the fall is back at the floor's
 *  level (the landing tick), by the engine from a real rest: 0 when it does not come back within 240 ticks */
function airTimeOf(ctx, A, r, fl) {
	const sim = ctx.sim, inp = ctx.inp;
	sim.restore(A.snap);
	ctx.fin = false;
	if (!play(ctx, [...decode(r.code, r.len), ...new Array(r.coast).fill(0)]) || ctx.fin || sim.py !== fl.py) return 0;
	for (let t = 1; t <= 240; t++) {
		E.applyMask(inp, t === 1 ? 1 : 0);
		sim.tick(inp);
		if (sim.is_dead || ctx.fin) return 0;
		if (t > 1 && sim.py === fl.py && sim.speed_y === 0) return t;
	}
	return 0;
}
const PREC_AIR = process.env.EEAT_PREC_AIR === '1';

// ---------------------------------------------------------------- the meet in the middle
/** the lookups of rests[i0..i1) x (the empty piece + the library's moves that land in the F table's key range [uMin,
 *  uMax]) in the F table: {hits: [[i, j (-1 = none), f]], n: lookups} */
function scanChunk(D, i0, i1) {
	const out = [];
	const { restU, restPx, du, lo, hi, keys, vals, log, far, floorLo, floorHi, loOpen, hiOpen, side, ulp, uMin, uMax } = D;
	const inF = (x) => (loOpen ? x > floorLo : x >= floorLo) && (hiOpen ? x < floorHi : x <= floorHi);
	const nJ = du.length;
	const lower = (v) => { let a = 0, b = nJ; while (a < b) { const m = (a + b) >> 1; if (du[m] < v) a = m + 1; else b = m; } return a; };
	let n = 0;
	for (let i = i0; i < i1; i++) {
		const p = restU[i], pAbs = restPx[i];
		const j0 = lower(uMin - p), j1 = lower(uMax - p + 1);
		// (k = j0 - 1: the empty piece, the rest itself)
		for (let k = j0 - 1; k < j1; k++) {
			const j = k < j0 ? -1 : k;
			let q = p;
			if (j < 0) {
				if (p < uMin || p > uMax) continue;
			} else {
				if (!inF(pAbs + lo[j]) || !inF(pAbs + hi[j])) continue;
				q = p + du[j];
			}
			n++;
			const f = hashGet(keys, vals, log, q);
			if (f < 0) continue;
			// (the F piece's way before its arrival stays on the floor)
			const qAbs = pAbs + (j >= 0 ? du[j] * ulp : 0);
			if (!inF(qAbs) || !inF(side === 'right' ? qAbs + far[f] : qAbs - far[f])) continue;
			out.push([i, j, f]);
		}
	}
	return { hits: out, n };
}

if (!isMainThread && workerData && workerData.precisionScan) {
	const D = workerData.D;
	parentPort.on('message', (m) => {
		if (m.stop) { process.exit(0); return; }
		const r = scanChunk(D, m.i0, m.i1);
		parentPort.postMessage({ id: m.id, hits: r.hits, n: r.n });
	});
}

/** realizes target t (a nudge target): per stretch of floor with rest anchors whose ends reach X (the target's own
 *  height first) and per side the ball can arrive from: P1, the library, the F table, the lookups (worker threads),
 *  every hit replayed from its anchor and continued by the exact local search. -> {routes, landed, hits, lookups, end,
 *  closest} */
async function realize(ctx, t, st, o) {
	const res = { routes: [], landed: 0, hits: 0, lookups: 0, end: 'no anchors', closest: null, firstAt: 0 };
	const emit = o.emit || (() => {});
	const floors = floorsOf(ctx, st.anchors || (st.anchors = anchorsOf(ctx, st.states)))
		.filter((F) => t.x >= F.floor.lo - 16 && t.x <= F.floor.hi + 16)
		.sort((a, b) => Math.abs(a.floor.py - t.py) - Math.abs(b.floor.py - t.py));
	for (const F of floors) {
		const sides = t.x <= F.floor.lo ? ['right'] : t.x >= F.floor.hi ? ['left'] : ['right', 'left'];
		for (const side of sides) {
			if (Date.now() > o.deadline || (o.stopped && o.stopped()) || (res.routes.length && o.firstOnly)) return res;
			if (!F.anchors.some((A) => (side === 'right' ? A.px > t.x : A.px < t.x))) continue;
			await realizeOn(ctx, t, st, F, side, o, res, emit);
		}
	}
	return res;
}
// The tables grow while a pass of lookups runs through without a route: each step about 3x the combinations (longer rest
// patterns in the engine, library pieces, arrivals). The expected number of exact landings is about (rests x library
// moves x arrivals) / (their spread in grid units): on the user's level (x ~ 5720, a grid of 2^-40 px) the first step
// gives ~6 in ~2 s; at x ~ 104 (2^-46 px, 64x finer) the same tables give ~0.02, so later steps (up to ~27x) run there.
const GROW = [{ n1: 6, lib: 10, f: 11 }, { n1: 7, lib: 11, f: 11 }, { n1: 7, lib: 11, f: 12 }, { n1: 8, lib: 12, f: 12 }, { n1: 8, lib: 13, f: 12 }];
// (THE AIRBORNE ARRIVAL's pass, EEAT_PREC_AIR=1: first, with AIR_SHARE of the time left and its own result; the ground
// passes below then run as before and the stage keeps the fastest route of both)
const AIR_SHARE = 0.4, AIR_STEPS = 2;
async function realizeOn(ctx, t, st, F0, side, o, res, emit) {
	if (!PREC_AIR || o.air) return realizeOnGround(ctx, t, st, F0, side, o, res, emit);
	const floor = F0.floor;
	const g = gridOf(side === 'right' ? Math.max(t.x, 1) : Math.max(t.x - 1e-9, 1));
	const fl = { py: floor.py, lo: Math.max(floor.lo, g.base), loOpen: floor.lo >= g.base ? floor.loOpen : false, hi: Math.min(floor.hi, g.top - 1), hiOpen: floor.hi <= g.top - 1 ? floor.hiOpen : false };
	const ra = { routes: [], landed: 0, hits: 0, lookups: 0, end: '', closest: res.closest, firstAt: 0 };
	const restsBy = new Map([[GROW[0].n1, restsOf(ctx, F0.anchors, fl, GROW[0].n1)]]);
	let k = 0;
	for (const r of restsBy.get(GROW[0].n1).slice(0, 8)) { k = airTimeOf(ctx, F0.anchors[r.anchor], r, fl); if (k) break; }
	emit({ ev: 'progress', phase: 'air', target: t.x, side, airTicks: k, sec: o.sec() });
	if (k) {
		const oa = Object.assign({}, o, { air: k, fast: false, deadline: Math.min(o.deadline, Date.now() + Math.max(0, o.deadline - Date.now()) * AIR_SHARE) });
		if (o.fast) {
			// (the rests braked from the attempts' moving states first: the airborne piece pays where its rest comes early;
			// the coasted rests' anchors are the attempts' late rests; the hits checked fewest ticks first)
			let fa = movingAnchorsOf(ctx, st.states, F0.floor).filter((A) => (side === 'right' ? A.px > t.x : A.px < t.x));
			// (THE EARLY BRAKE, EEAT_PREC_AIR_EARLY=1: the brakes that can rest near X soonest, earlyAnchorsOf; none: as before)
			if (PREC_AIR_EARLY) { const ea = earlyAnchorsOf(ctx, st.states, F0.floor, t.x, side); if (ea.length) fa = ea; }
			const secsLeft = Math.max(0, (oa.deadline - Date.now()) / 1000);
			const fr = fastRestsOf(fa, fl, { nodes: o.fastNodes || Math.max(FAST_NODES_MIN, Math.min(FAST_NODES, secsLeft * FAST_NS)) });
			emit({ ev: 'progress', phase: 'airfast', anchors: fa.length, early: PREC_AIR_EARLY ? fa.map((A) => A.t) : undefined, rests: fr.rests.length, first: fr.rests.length ? fr.rests[0].total : null, nodes: fr.nodes, sec: o.sec() });
			const FA = { floor: F0.floor, anchors: fa, rests: fr.rests };
			const oaf = Object.assign({}, oa, { fast: true, firstOnly: false });
			for (const step of FAST_STEPS) {
				const why = await realizeStep(ctx, t, st, FA, side, oaf, ra, emit, g, fl, FA.rests, GROW[step], step);
				if (ra.routes.length || why !== 'exhausted' || Date.now() > oa.deadline || (o.stopped && o.stopped())) break;
			}
		}
		for (let step = 0; step < AIR_STEPS && !ra.routes.length; step++) {
			const sz = GROW[step];
			if (!restsBy.has(sz.n1)) restsBy.set(sz.n1, restsOf(ctx, F0.anchors, fl, sz.n1));
			const why = await realizeStep(ctx, t, st, F0, side, oa, ra, emit, g, fl, restsBy.get(sz.n1), sz, step);
			if (ra.routes.length || why !== 'exhausted' || Date.now() > oa.deadline || (o.stopped && o.stopped())) break;
		}
	}
	res.hits += ra.hits; res.landed += ra.landed; res.lookups += ra.lookups;
	if (ra.closest && ra.closest !== res.closest) res.closest = ra.closest;
	if (!(ra.routes.length && o.firstOnly)) await realizeOnGround(ctx, t, st, F0, side, o, res, emit);
	if (ra.routes.length) { res.routes.push(...ra.routes); if (!res.firstAt) res.firstAt = ra.firstAt; if (!res.end || res.end === 'exhausted') res.end = 'finish'; }
}
async function realizeOnGround(ctx, t, st, F0, side, o, res, emit) {
	const floor = F0.floor;
	const g = gridOf(side === 'right' ? Math.max(t.x, 1) : Math.max(t.x - 1e-9, 1));
	// (the pieces add up within one binade of doubles: the stretch cut to it)
	const fl = { py: floor.py, lo: Math.max(floor.lo, g.base), loOpen: floor.lo >= g.base ? floor.loOpen : false, hi: Math.min(floor.hi, g.top - 1), hiOpen: floor.hi <= g.top - 1 ? floor.hiOpen : false };
	const restsBy = new Map();
	// (fast: FIRST the coasted rests as before with FAST_OLD of the time left (the route to fall back on: the fast pass
	// alone found none on one compile's attempt of the precision puzzle, where the coasted rests did), then the rests
	// braked from the attempts' moving states (FAST RESTS above) with the rest, for a faster one; then the coasted rests
	// again with what is left when neither found one)
	let FF = null;
	if (o.fast) {
		const d0 = o.deadline, oOld = Object.assign({}, o, { fast: false, deadline: Math.min(d0, Date.now() + (d0 - Date.now()) * FAST_OLD) });
		await realizeOnGround(ctx, t, st, F0, side, oOld, res, emit);
		if (Date.now() > d0 || (o.stopped && o.stopped())) return;
		o = Object.assign({}, o, { firstOnly: false });
	}
	if (o.fast) {
		const fa = movingAnchorsOf(ctx, st.states, F0.floor).filter((A) => (side === 'right' ? A.px > t.x : A.px < t.x));
		// (the braking search's share: FAST_NS model ticks a second of the stage's budget, within FAST_NODES_MIN..MAX)
		const secsLeft = Math.max(0, (o.deadline - Date.now()) / 1000);
		const fr = fastRestsOf(fa, fl, { nodes: o.fastNodes || Math.max(FAST_NODES_MIN, Math.min(FAST_NODES, secsLeft * FAST_NS)) });
		emit({ ev: 'progress', phase: 'fast', anchors: fa.length, rests: fr.rests.length, nodes: fr.nodes, first: fr.rests.length ? fr.rests[0].total : null, sec: o.sec() });
		FF = { floor: F0.floor, anchors: fa, rests: fr.rests };
	}
	if (FF) {
		// (the fast rests with the first table sizes, then the larger F table; nothing: the coasted rests below, as before)
		for (const step of FAST_STEPS) {
			const why = await realizeStep(ctx, t, st, FF, side, o, res, emit, g, fl, FF.rests, GROW[step], step);
			if (res.routes.length || why !== 'exhausted' || Date.now() > o.deadline || (o.stopped && o.stopped())) return;
		}
		if (res.routes.length) return;
		o = Object.assign({}, o, { fast: false });
	}
	for (let step = 0; step < GROW.length; step++) {
		const sz = step === 0 ? { n1: o.n1 || GROW[0].n1, lib: o.n2lib || GROW[0].lib, f: o.n2f || GROW[0].f } : GROW[step];
		if (!restsBy.has(sz.n1)) restsBy.set(sz.n1, restsOf(ctx, F0.anchors, fl, sz.n1));
		const why = await realizeStep(ctx, t, st, F0, side, o, res, emit, g, fl, restsBy.get(sz.n1), sz, step);
		if (res.routes.length || why !== 'exhausted' || Date.now() > o.deadline || (o.stopped && o.stopped()) || o.grow === false) return;
	}
}
async function realizeStep(ctx, t, st, F0, side, o, res, emit, g, fl, rests, sz, step) {
	const anchors = F0.anchors;
	emit({ ev: 'progress', phase: 'tables', target: t.x, side, step, floor: [fl.lo, fl.hi, fl.py], anchors: anchors.length, rests: rests.length, sec: o.sec() });
	if (!rests.length || Date.now() > o.deadline) return 'none';
	const ref = Math.floor((fl.lo + fl.hi) / 2) + 0.3713;
	const lib = libraryOf(g, ref, sz.lib, o.fast ? FAST_LIB_COAST : 0);
	const H = o.hash;
	const F = arrivalsOf(g, ref, t.x, side, sz.f, H, 0, o.fast ? FAST_AT : 0, o.air || 0);
	emit({ ev: 'progress', phase: 'tables', step, library: lib.n, arrivals: H.n, sec: o.sec() });
	// (the rests nearest X first: the library's moves are short, so only rests near X can meet the F table; then in order
	// of their ticks)
	if (!o.fast) rests.sort((a, b) => Math.abs(a.px - t.x) - Math.abs(b.px - t.x) || (anchors[a.anchor].t + a.len + a.coast) - (anchors[b.anchor].t + b.len + b.coast));
	const D = {
		restU: Float64Array.from(rests, (r) => (r.px - g.base) / g.ulp), restPx: Float64Array.from(rests, (r) => r.px),
		du: lib.du, lo: lib.lo, hi: lib.hi, keys: H.keys, vals: H.vals, log: H.log, far: F.far,
		floorLo: fl.lo, floorHi: fl.hi, loOpen: fl.loOpen, hiOpen: fl.hiOpen, side, ulp: g.ulp, uMin: F.uMin, uMax: F.uMax,
	};
	const sim = ctx.sim;
	const tried = new Set();
	const check = (i, j, f) => {
		const r = rests[i], A = anchors[r.anchor];
		const key = `${i},${j},${f}`;
		if (tried.has(key)) return null;
		tried.add(key);
		res.hits++;
		const tail = [...decode(r.code, r.len), ...new Array(r.coast).fill(0)];
		if (j >= 0) tail.push(...decode(lib.code[j], lib.len[j]), ...new Array(lib.coast[j]).fill(0));
		const fm = decode(F.code[f], F.len[f]);
		if (o.air) {
			// (the airborne piece: the jump on its first tick, the lateral pattern after its delay, then its coast)
			const tot = F.at[f] & 255, dl = F.at[f] >> 8;
			for (let k = 0; k < tot; k++) tail.push((k >= dl && k - dl < fm.length ? fm[k - dl] : 0) | (k === 0 ? 1 : 0));
		} else for (let k = 0; k < F.at[f]; k++) tail.push(k < fm.length ? fm[k] : 0);
		sim.restore(A.snap);
		ctx.fin = false;
		if (!play(ctx, tail)) return null;
		if (ctx.fin) return { masks: tail, A };
		if (sim.px !== t.x) return null;
		res.landed++;
		const land = sim.snapshot();
		if (o.air) emit({ ev: 'airland', at: F.at[f] & 255, delay: F.at[f] >> 8, vx: sim.speed_x, vy: sim.speed_y, py: sim.py, masks: prefixOf(A).concat(tail).map((m) => String.fromCharCode(48 + m)).join('') });
		// the nudge test's own way on from X first (it may fit the landing as it is), then the exact local search
		const tryMasks = (ms) => { sim.restore(land); ctx.fin = false; return play(ctx, ms) && ctx.fin; };
		if (t.cont && t.cont.length && tryMasks(t.cont)) return { masks: tail.concat(t.cont), A };
		const ls = localSearch(ctx, land, { nodes: o.landNodes || LAND_NODES });
		if (ls.finish) return { masks: tail.concat(ls.finish), A };
		// (no finish from there: the landing's nearest state, when it is nearer than the stall, goes to the other searches)
		if (ls.cost < (res.closest ? res.closest.cost : st.cmin) - 1e-6) {
			res.closest = { cost: ls.cost, masks: prefixOf(A).concat(tail, ls.masks) };
			emit({ ev: 'nearer', cost: ls.cost, masks: res.closest.masks });
		}
		return null;
	};
	const prefixOf = (A) => Array.from(st.attempts[A.a].subarray(0, A.t)).concat(new Array(A.coast).fill(0));
	// the lookups in chunks of about 4 M, on worker threads
	const nW = Math.max(1, o.workers || 1), CH = Math.max(1, Math.floor(4e6 / (lib.n + 1)));
	const workers = [];
	for (let w = 0; w < nW; w++) {
		const wk = new Worker(__filename, { workerData: { precisionScan: true, D } });
		wk.unref();
		workers.push(wk);
	}
	let next = 0, busy = 0, done = false, end = '';
	const pending = [];
	const over = () => o.stopped && o.stopped() ? 'stopped' : Date.now() > o.deadline ? 'time' : res.firstAt && Date.now() - res.firstAt > (o.afterMs || AFTER_MS) ? 'finish' : '';
	await new Promise((resolve) => {
		const finish = (why) => { if (done) return; done = true; res.end = end = why; resolve(); };
		const give = (wk) => {
			if (done) return;
			const why = next >= rests.length ? (res.routes.length ? 'finish' : 'exhausted') : over();
			if (why) { if (!busy) finish(why); return; }
			const i0 = next, i1 = Math.min(rests.length, next + CH);
			next = i1; busy++;
			wk.postMessage({ id: i0, i0, i1 });
		};
		for (const wk of workers) {
			wk.on('message', (m) => {
				busy--;
				res.lookups += m.n;
				if (o.fast) {
					// (every hit kept with its ticks from the level start; replayed in that order after the scan)
					for (const [i, j, f] of m.hits) pending.push([rests[i].total + (j >= 0 ? lib.len[j] + lib.coast[j] : 0) + (o.air ? F.at[f] & 255 : F.at[f]), i, j, f]);
					emit({ ev: 'progress', phase: 'search', target: t.x, side, step, hits: pending.length, lookups: res.lookups, done: next, rests: rests.length, sec: o.sec() });
					give(wk);
					return;
				}
				for (const [i, j, f] of m.hits) {
					const r = check(i, j, f);
					if (!r) continue;
					const masks = prefixOf(r.A).concat(r.masks);
					res.routes.push(masks);
					if (!res.firstAt) res.firstAt = Date.now();
					emit({ ev: 'route', masks });
				}
				emit({ ev: 'progress', phase: 'search', target: t.x, side, step, hits: res.hits, landed: res.landed, lookups: res.lookups, done: next, rests: rests.length, sec: o.sec() });
				if (res.routes.length && o.firstOnly) { finish('finish'); return; }
				give(wk);
			});
			wk.on('error', (e) => { busy--; emit({ ev: 'warning', text: `a lookup worker failed: ${e && e.message || e}` }); give(wk); });
		}
		for (const wk of workers) give(wk);
	});
	for (const wk of workers) { try { wk.postMessage({ stop: true }); } catch (e) { /* gone */ } }
	if (o.fast && pending.length) {
		// the fewest ticks first: the first hit that finishes is the fastest of this pass (the landing's way on from X, the
		// local search, adds about the same to each); a few more within FAST_SLACK ticks of it are tried too
		pending.sort((a, b) => a[0] - b[0]);
		let bestLen = Infinity, first = -1;
		for (let k = 0; k < pending.length; k++) {
			if (Date.now() > o.deadline + FAST_OVER_MS || (o.stopped && o.stopped())) break;
			if (first >= 0 && pending[k][0] > pending[first][0] + FAST_SLACK) break;
			const [, i, j, f] = pending[k];
			const r = check(i, j, f);
			if (!r) continue;
			const masks = prefixOf(r.A).concat(r.masks);
			if (first < 0) first = k;
			if (masks.length >= bestLen) continue;
			bestLen = masks.length;
			res.routes.push(masks);
			if (!res.firstAt) res.firstAt = Date.now();
			emit({ ev: 'route', masks });
		}
		res.end = end = res.routes.length ? 'finish' : 'exhausted';
		emit({ ev: 'progress', phase: 'fastcheck', hits: pending.length, tried: res.hits, landed: res.landed, best: bestLen, sec: o.sec() });
	}
	return end;
}

// ---------------------------------------------------------------- one round: stall -> nudge -> realize
/** attempts: masks arrays (nearest first); o: {seconds, workers, emit(ev) ('route' events carry masks from the start),
 *  stopped(), firstOnly, afterMs, hashLog, n1, n2lib, n2f, ctx}. -> {routes: [masks], targets, closest, end} */
async function round(level, attempts, o) {
	const t0 = Date.now(), sec = () => Math.round((Date.now() - t0) / 100) / 10;
	const emit = o.emit || (() => {});
	const deadline = t0 + (o.seconds || 120) * 1000;
	const ctx = o.ctx || makeCtx(level, o.field);
	const st = stallStates(ctx, attempts);
	st.attempts = attempts;
	const out = { routes: [], targets: [], closest: null, end: 'no target' };
	emit({ ev: 'progress', phase: 'stall', stall: st.stall.length, nearest: st.cmin, sec: sec() });
	if (!st.stall.length) { out.end = 'no stall states'; return out; }
	const nt = nudgeTest(ctx, st.stall, st.cmin, { deadline: t0 + Math.min(o.seconds || 120, NUDGE_S) * 1000 });
	for (const r of nt.routes) {
		const ms = Array.from(attempts[r.from.a].subarray(0, r.from.t)).concat(r.cont);
		out.routes.push(ms);
		emit({ ev: 'route', masks: ms, how: 'local' });
	}
	out.targets = nt.targets;
	emit({ ev: 'progress', phase: 'nudge', targets: nt.targets.length, routes: out.routes.length, sec: sec() });
	for (const t of nt.targets.slice(0, MAX_TARGETS)) emit({ ev: 'target', x: t.x, py: t.py, gain: Math.round(t.gain * 10) / 10, finish: t.finish });
	if (out.routes.length && o.firstOnly) { out.end = 'finish'; return out; }
	let hash = null;
	for (const t of nt.targets.slice(0, MAX_TARGETS)) {
		if (Date.now() > deadline || (o.stopped && o.stopped())) { out.end = o.stopped && o.stopped() ? 'stopped' : 'time'; break; }
		if (!hash) hash = makeHash(o.hashLog || HASH_LOG);
		const r = await realize(ctx, t, st, { deadline, workers: o.workers, emit, sec, stopped: o.stopped, firstOnly: o.firstOnly, afterMs: o.afterMs, hash, n1: o.n1, n2lib: o.n2lib, n2f: o.n2f, grow: o.grow, fast: o.fast, fastNodes: o.fastNodes });
		out.routes.push(...r.routes);
		if (r.closest && (!out.closest || r.closest.cost < out.closest.cost)) out.closest = r.closest;
		out.end = r.end;
		if (r.routes.length) break;
	}
	return out;
}

module.exports = { latSpeed, latMove, latAlign, latTick, gridOf, stopDist, movingAnchorsOf, earlyAnchorsOf, fastRestsOf, localSearch, stallStates, nudged, nudgeTest, floorOf, anchorsOf, floorsOf, restsOf, libraryOf,
	arrivalsOf, makeHash, hashPut, hashGet, scanChunk, realize, round, makeCtx, VMAX, NUDGE_STEP, NUDGE_EPS, PREC_REACH };

// ---------------------------------------------------------------- CLI (the editor's child)
if (isMainThread && require.main === module) {
	const C = require('./common.js');
	const EL = require('./eelvl.js');
	const a = C.parseArgs(process.argv.slice(2));
	const file = a._[0];
	const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
	if (!file || !a.attempts) { console.error('usage: node src/precision.js <level.eelvl> --attempts=<file> [--workers=N] [--seconds=S] [--depth=D] [--first=1] [--stdin=1]'); process.exit(2); }
	const level = EL.loadEelvlLevel(file);
	const attempts = String(fs.readFileSync(a.attempts, 'latin1')).split(/\r?\n/).filter((l) => /^[0-O]+$/.test(l)).map((l) => Uint8Array.from(l, (c) => (c.charCodeAt(0) - 48) & 31));
	let depth = +a.depth > 0 ? +a.depth : Infinity, stop = false;
	if (a.stdin) {
		let buf = '';
		process.stdin.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
				if (line === 'stop') stop = true;
				else if (/^depth \d+$/.test(line)) depth = +line.slice(6);
			}
		});
		process.stdin.on('end', () => { stop = true; });
	}
	const t0 = Date.now();
	const workers = Math.max(1, Math.min(os.cpus().length, +a.workers || 1));
	let best = null;
	let nearest = Infinity;
	const emit = (ev) => {
		if (ev.ev === 'nearer') {
			// (a landing's nearest state: an attempt nearer the trophy than the stall, for the other searches)
			if (best || !(ev.cost < nearest - 1e-6)) return;
			nearest = ev.cost;
			const ms = Uint8Array.from(ev.masks);
			out({ ev: 'closest', dist: Math.round(ev.cost * 1000) / 1000, tick: ms.length, inputs: C.eetasBytes(ms).toString('latin1') });
			return;
		}
		if (ev.ev !== 'route') { out(ev); return; }
		// every route replayed in the engine from the level's start (C.evaluate) before it is reported
		const r = C.evaluate(level, Uint8Array.from(ev.masks));
		if (!r || r.ms.length > depth) return;
		if (best && !(r.runTicks < best.runTicks || (r.runTicks === best.runTicks && r.ms.length < best.ticks))) return;
		best = { runTicks: r.runTicks, ticks: r.ms.length };
		out({ ev: 'result', kind: 'finish', ticks: r.ms.length, runTicks: r.runTicks, deaths: r.deaths, inputs: C.eetasBytes(r.ms).toString('latin1'), how: ev.how || 'landing',
			sec: Math.round((Date.now() - t0) / 100) / 10 });
	};
	(async () => {
		const ctx = makeCtx(level);
		out({ ev: 'start', attempts: attempts.length, workers, startCost: ctx.startCost < 0 ? null : ctx.startCost });
		const r = await round(level, attempts, { ctx, seconds: +a.seconds || 120, workers, emit, stopped: () => stop, firstOnly: a.first === '1',
			n1: +a.n1 || undefined, n2lib: +a.n2lib || undefined, n2f: +a.n2f || undefined, hashLog: +a.hashLog || undefined, grow: a.grow !== '0', afterMs: +a.after >= 0 && a.after !== undefined ? +a.after * 1000 : undefined,
			fast: a.fast === undefined ? process.env.EEAT_PREC_FAST === '1' : a.fast === '1', fastNodes: +a.fastNodes || undefined });
		out({ ev: 'done', end: best ? 'finish' : r.end, targets: r.targets.length, routes: r.routes.length, sec: Math.round((Date.now() - t0) / 100) / 10 });
		process.exit(0);
	})().catch((e) => { out({ ev: 'warning', text: String(e && e.stack || e) }); out({ ev: 'done', end: 'error' }); process.exit(1); });
}
