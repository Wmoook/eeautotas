'use strict';
// The skip finder ("misguided climbs"): path changes found from states ALL ALONG a finished run. Find a route picks a
// macro PATH and the optimizer's exact rejoins (windows of <= ~800 ticks) can never change it: Egg Quest II's chimney
// (the user's line stands on the pyramid top at t801, our run at t980), Forgotten Veil's purple switch 0 (+264 ticks),
// Octorage's arrow room (+131), EX Crew's climb (64,92)->(48,77) (320 ticks vs 141).
//   1. Starts (`startsOf`, --order coarse): every 8 x and 4 x --every ticks, then every --dense ticks around the
//      --spots places where the run's path to a later point is much longer than the straight line (`excessOf`: it
//      passes far above / below or doubles back), then every 2 x and 1 x --every; each level by that excess. --order
//      run: every --every ticks in run order. Each start once per (its state, its goal window's end state, pick);
//      --done=<file> keeps them across calls (the grind's stage continues its pass).
//   2. Per start and pick (`searchStart`, at most --perS seconds), a bounded every-move search (`bfs`, --depth layers,
//      --bfsShare of the time) from the run's EXACT state there: one state per FINE cell (--qx px, 1/--qvx px/tick,
//      --qy px (0 = exact), 1/--qvy px/tick (0 = exact); ground, jumps, the gravity queue, the discrete state), the
//      cell's state chosen by a lineage-stable rule (--picks: fast = the highest |vx| (the default), first = the first
//      found, high = the highest). Why: Egg Quest II's chimney line is a sub-pixel chain (src/out/night/
//      eq2_chimney_user.md section 4): every search at 2-4 px cells lost it (0 of 17 CPU, 0 of 7 GPU runs), the GPU
//      explore's per-layer hash choice found it in 5 of 20 runs at 1 px, a stable rule at 1 px / 1/16 px/tick from 11
//      of 11 starts. The region is the run's tiles over the goal window plus --margin tiles. A layer with more than --cap
//      new cells keeps them by NOVELTY, never by the reach field's cost (it rates the chimney top 30 tiles worse than the
//      way east): per tile in turn, the tiles above the run's highest point in their column first, then the tiles the
//      run never visits, then the tiles the search has seen least. A jump input that cannot jump (no jumps left after
//      the tick, no levitation, the timer on) is not simulated: its state is the same input's without the jump.
//   3. Goals = any LATER point of the run: a state equal (stateHash, coin-blind with --nocoins, clock-blind on time-door
//      levels) to the run's at a tick at least --minGain later (a proven shortcut at once) or to another run's
//      (--targets: its rest, when it finishes sooner), or a LEAD: a state in a tile the run visits at least --minGain
//      ticks later (per run stretch the first arrivals (--hitsPerSeg) and those nearest the run's state (--hitsClose,
//      |dpos| + 3 |dvel|); another discrete state too: a skipped switch the rest never needs).
//   4. Joins: quick tails from every lead, the nearest first (`quickTails`, `tail`: the run's own inputs from next to
//      the visit, re-anchored at landings / wall stops like mutate --anchor, checked every tick for an exact state of
//      the run; else the same physical state with another discrete state: the rest as it is), loose joins (a lead or a
//      tail within --looseD of the run's state: the run from there as it is), tracking joins (`track`: a beam that
//      follows the run's trajectory until it meets it), the per-lead sweep of tails from the path's earlier states
//      (`join`), and optionally a second search from the nearest leads whose only goal is an equal state (--joinBfs)
//      and one GPU lane in the main thread for the leads nothing joined (--gpu=1: eegpu explore --prefix, --rejoin=1
//      against the run and --finish=1 bounded by the run's own finish).
//   5. Every candidate is replayed from the start (C.evaluate) and judged (C.judge: finish, deaths, random-portal
//      chance) against the run; a faster run replaces it at once, and a worker's find made on an older run is spliced
//      with the current one (splice.js).
// A start with no find is "not found at that grain, pick and depth", never "impossible".
// The same finder on an ATTEMPT (prepare's attempt mode: inputs that do not finish, Find a route before any route): its
// goal is a later point of the attempt reached sooner, a candidate judged by its end (attemptJudge: the attempt's end
// state, or the same physical state and room, in fewer ticks; a finish is a route). The lane (--lane=1, `lane`) runs it
// inside Find a route (editor.js strategy "path skips"): the searches' nearest attempt, then the best route, each first
// spliced with / carried over from its library of shortened attempts and routes (`carryOver`).
// usage: node src/skipfind.js --tas=<run.eetas> [--level=<level id | job id | .json>] [--out=<best.eetas>]
//        [--seconds=600] [--workers=N] [--deadline=<ms since 1970>] [--done=<file>] [--order=coarse|run|excess]
//        [--every=50] [--from=] [--to=] [--starts=a,b,..] [--perS=100] [--depth=300] [--cap=60000] [--picks=fast]
//        [--minGain=20] [--nocoins=auto|0|1] [--targets=<run.eetas,...>] [--gpu=1 [--tool=<eegpu>] [--cachedir=]]
//        (every DEFAULTS key is an option)
//        node src/skipfind.js --lane=1 --level=<level.eelvl | .json> [--workers=N] [--seconds=] [--laneStep=200]
//        [--laneAir=90] [--laneLib=24] [--nice=0]: the lane (see `lane`), fed on stdin
// JSON lines on stdout: {ev: start | search | skip | gpu | done}; --out is rewritten at every find; `[ticks] N` lines.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;
const EG = require('./endgame.js');

const DEFAULTS = {
	every: 50, dense: 10, spots: 8, spotSpan: 60, order: 'coarse',
	depth: 300, horizon: 1500, minGain: 20, margin: 10,
	qx: 1, qvx: 16, qy: 0.5, qvy: 4,
	picks: 'fast',
	cap: 60000, log2: 24,   // (the cell table: 2^24 x 8 bytes a worker; full at 70%: the search ends there)
	perS: 100, bfsShare: 0.85,   // seconds per search (start x pick) and the main bfs's share of them
	deepEvery: 4, deepDepth: 450, deepLog2: 25, deepPerS: 200,   // the deep starts (isDeep): layers, table, seconds
	joinTop: 4, hitsPerSeg: 4, hitsClose: 4, quickOffs: [0, -2, 2, -4, 4, -6, 6, -10, 10], quickMax: 400, quickS: 8, tailBack: 90, tailStep: 3, offBack: 150, offAhead: 60, tailH: 400, tailDiverge: 320, tailS: 4, anchors: 3, anchorD: 12, looseD: 4,
	trackTop: 8, trackW: 400, trackH: 600, trackPhase: 4, trackVw: 3, trackLost: 150, trackLostK: 30, trackS: 8,
	joinBfs: 0, joinDepth: 280, joinCap: 25000, joinMargin: 6,
	maxCands: 40,
	leadRuns: 2, leadMin: 60,   // (an attempt: its best leads as whole runs, at least leadMin ticks ahead of it)
	// (the lane's searches of an attempt, before any route: a layer cap of attemptCap, half the default: time counts there.
	// Egg Quest II's attempt from its landing after the opening fall, one laptop thread, 400 layers: cap 60,000 the
	// chimney line -1,018 in 132 s, 30,000 -982 in 79 s, 15,000 not the chimney (-475, the second house) in 38 s)
	attemptCap: 30000,
	unjoinedTop: 2, gpuMin: 60, gpuModes: 'rejoin,finish', gpuS: 30, gpuRejoinDepth: 700, gpuCells: 27, gpuCap: 65536, gpuCqx: 0.25, gpuCqv: 16, gpuQy: 0.25, gpuQvy: 16,
};

// ---------------------------------------------------------------- the discrete state
function onSet(m) {
	if (!m || m.size === 0) return '';
	const ids = [];
	for (const [id, v] of m) if (v === true) ids.push(id);
	return ids.sort((x, y) => x - y).join('.');
}
/** the discrete state that opens / shuts doors or changes the physics (coins only without nc) as a string */
function ctxKey(sim, nc) {
	const L = sim.level;
	return (nc ? '' : sim.coins + ',' + sim.blue_coins + ',') + (sim.has_crown ? 1 : 0) + ',' + (sim._keysMask | 0) + ',' +
		onSet(sim._switches) + ',' + onSet(sim._oswitches) + ',' + sim.team + ',' + sim.max_jumps + ',' + sim.jump_boost + ',' +
		sim.speed_boost + ',' + sim.flip_gravity + ',' + (sim.has_levitation ? 1 : 0) + (sim.low_gravity ? 1 : 0) +
		(sim.is_invulnerable ? 1 : 0) + (sim.is_cursed ? 1 : 0) + (sim.is_zombie ? 1 : 0) + (sim.is_on_fire ? 1 : 0) + (sim.is_poisoned ? 1 : 0) +
		(L.hasCoinGate ? ',' + sim._show_coin_gate : '') + (L.hasBlueCoinGate ? ',' + sim._show_blue_coin_gate : '');
}
/** ctx ids (1, 2, ...) per distinct ctxKey, cached on a cheap fingerprint and the switch maps' identities */
function makeCtx(nc) {
	const ids = new Map();
	// the cache: every field ctxKey reads (small ints and flags) compared one by one, the switch maps by identity and size
	let c0 = -1, c1 = -1, c2 = -1, c3 = -1, c4 = -1, c5 = -1, c6 = -1, s0 = null, o0 = null, n0 = -1, m0 = -1, id = 0;
	const idOf = (k) => { let v = ids.get(k); if (v === undefined) { v = ids.size + 1; ids.set(k, v); } return v; };
	const of = (sim) => {
		const a = nc ? 0 : sim.coins, b = nc ? 0 : sim.blue_coins, k = sim._keysMask | 0, tm = sim.team | 0;
		const fl = (sim.has_crown ? 1 : 0) | (sim.has_levitation ? 2 : 0) | (sim.low_gravity ? 4 : 0) | (sim.is_invulnerable ? 8 : 0) |
			(sim.is_cursed ? 16 : 0) | (sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | ((sim._show_coin_gate & 0xfff) << 8) |
			((sim._show_blue_coin_gate & 0xff) << 20);
		const fx = (sim.max_jumps & 0x3ff) | ((sim.jump_boost & 0xff) << 10) | ((sim.speed_boost & 0xff) << 18) | ((sim.flip_gravity & 0x3f) << 26);
		if (a === c0 && b === c1 && k === c2 && tm === c3 && fl === c4 && fx === c5 && sim._switches === s0 && sim._oswitches === o0 && sim._switches.size === n0 && sim._oswitches.size === m0) return id;
		c0 = a; c1 = b; c2 = k; c3 = tm; c4 = fl; c5 = fx; c6 = 0; s0 = sim._switches; o0 = sim._oswitches; n0 = sim._switches.size; m0 = sim._oswitches.size;
		id = idOf(ctxKey(sim, nc));
		return id;
	};
	return { ids, of, idOf };
}
/** the ball's physical state only (a 53-bit hash): equal for two states that move alike whatever their discrete states */
function physKey(sim) {
	let a = mixD(0x2545f491, sim.px), b = mixD(0x9e3779b9, sim.py);
	a = mixD(a, sim.speed_x); b = mixD(b, sim.speed_y);
	const small = (sim._q0 & 0xffff) | ((sim._q1 & 0xffff) << 16);
	a = mix(a, small); b = mix(b, (sim.jump_count << 1) | (sim.on_ground ? 1 : 0));
	a = mixD(a, sim.py); b = mixD(b, sim.px);
	return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}

// ---------------------------------------------------------------- the run
const SNAP = 128;
const KINDS = ['exact rejoin', 'physical rejoin', 'loose join'];
/**
 * The run's trace: positions, speeds, tiles, ctx ids, state hashes per tick (after t ticks), the latest tick of each
 * hash and of each physical state, snapshots every SNAP ticks, the stretch each tick's tile visit starts at. null when
 * the run does not finish.
 */
function prepare(level, masks, o = {}) {
	const nc = !!o.nocoins;
	// an ATTEMPT (o.attempt: Find a route's search before any route exists, the lane): inputs that do not finish; its goal
	// is its own later points reached sooner (the end state reached in fewer ticks: `attemptJudge`). A run that dies is
	// cut before its death; one that finishes is a route (prepared as one).
	const att = o.attempt ? attemptOf(level, masks) : null;
	// time-door levels: joins by the clock-blind hash (an exact rejoin there needs a saving that is a multiple of the doors' period;
	// a clock-blind one is a proposal: the replay of the whole candidate decides). An attempt joins by the exact hash: its
	// candidates are judged by their end state, never by a finish
	const cb = att && !att.finish ? false : o.clockblind === undefined ? !!level.hasTimeDoors : !!+o.clockblind;
	const hashOf = cb ? (sm) => sm.stateHashClockBlind(nc) : (sm) => sm.stateHash(false, nc);
	const ev = att ? (att.finish ? att.finish : att) : C.evaluate(level, masks);
	if (!ev || !ev.ms || ev.ms.length < 2) return null;
	const ms = ev.ms, n = ms.length;
	const W = level.width, Hh = level.height;
	const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1);
	const T = new Int32Array(n + 1), CX = new Int32Array(n + 1), H = new Float64Array(n + 1), seg = new Int32Array(n + 1), OG = new Uint8Array(n + 1);
	const hashTick = new Map(), physTick = new Map(), snaps = [];
	const ctx = makeCtx(nc);
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	for (let t = 0; t <= n; t++) {
		if (t % SNAP === 0) snaps.push(sim.snapshot());
		X[t] = sim.px; Y[t] = sim.py; VX[t] = sim.speed_x; VY[t] = sim.speed_y; OG[t] = sim.on_ground ? 1 : 0;
		const tx = Math.floor((sim.px + 8) / 16), ty = Math.floor((sim.py + 8) / 16);
		T[t] = tx >= 0 && ty >= 0 && tx < W && ty < Hh ? ty * W + tx : -1;
		seg[t] = t > 0 && T[t] === T[t - 1] ? seg[t - 1] : t;
		CX[t] = ctx.of(sim);
		H[t] = hashOf(sim);
		hashTick.set(H[t], t);
		physTick.set(physKey(sim), t);
		if (t < n) { E.applyMask(inp, ms[t]); sim.tick(inp); }
	}
	// other runs of the level (o.targets: masks; the job's earlier bests, other routes): a state equal to one of theirs is
	// a join too (their rest from there), counted when that run's finish comes sooner than this one's
	const targets = [];
	for (const tm of o.targets || []) {
		const te = C.evaluate(level, Uint8Array.from(tm));
		if (!te) continue;
		const tick = new Map();
		sim.reset();
		for (let t = 0; t <= te.ms.length; t++) { tick.set(hashOf(sim), t); if (t < te.ms.length) { E.applyMask(inp, te.ms[t]); sim.tick(inp); } }
		targets.push({ ms: te.ms, n: te.ms.length, tick });
	}
	// an attempt's end: its state (exact hash), its physical state and its room (goexplore.js roomOf: Find a route's archive
	// keys its cells by (tile, room, ...)): a candidate that ends in the same physical state and room, sooner, is its later
	// point reached sooner
	let end = null;
	if (att && !att.finish) {
		sim.restore(snaps[Math.floor(n / SNAP)]);
		for (let t = Math.floor(n / SNAP) * SNAP; t < n; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
		end = { h: H[n], phys: physKey(sim), room: roomKeyOf(level)(sim) };
	}
	return { level, masks: ms, n, ev, nc, cb, hashOf, W, Hh, X, Y, VX, VY, T, CX, H, seg, OG, hashTick, physTick, snaps, ctx, targets, attempt: !!end, end };
}
/** goexplore.js roomOf(level).key, one per level */
const roomKeys = new WeakMap();
function roomKeyOf(level) {
	let f = roomKeys.get(level);
	if (!f) { const RM = require('./goexplore.js').roomOf(level); f = (sim) => RM.key(sim); roomKeys.set(level, f); }
	return f;
}
/**
 * An attempt's inputs replayed: {ms, n, runTicks, deaths: 0, chance: 1} cut before its first death (Find a route's
 * archive keeps no dead state), or {finish: C.evaluate(...)} when it finishes (a route).
 */
function attemptOf(level, masks) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (sim.has_silver_crown) return { finish: C.evaluate(level, masks.subarray(0, t + 1)) };
		if (sim.is_dead) { const ms = Uint8Array.from(masks.subarray(0, t)); return { ms, n: ms.length, runTicks: ms.length, deaths: 0, chance: 1, attempt: true }; }
	}
	const ms = Uint8Array.from(masks);
	return { ms, n: ms.length, runTicks: ms.length, deaths: 0, chance: 1, attempt: true };
}
/**
 * A candidate against an attempt (info.attempt): replayed from the start; a finish = a route (C.evaluate: {route: ev});
 * else it must not die and must end, sooner than the attempt, in the attempt's end state (the same stateHash) or in the
 * same physical state and room (another discrete state Find a route's cells do not tell apart: a coin taken or skipped
 * where no door reads it). -> {accept, saved, ev: {ms, runTicks, deaths: 0, chance: 1}, route?}
 */
function attemptJudge(info, ms) {
	if (!ms || ms.length >= info.n) return { accept: false };
	const sim = new E.EESim(info.level);
	sim.reset();
	const inp = new E.EEInput();
	for (let t = 0; t < ms.length; t++) {
		E.applyMask(inp, ms[t]);
		sim.tick(inp);
		if (sim.has_silver_crown) {
			const ev = C.evaluate(info.level, ms.subarray(0, t + 1));
			return ev ? { accept: true, route: ev, ev, saved: info.n - ev.ms.length } : { accept: false };
		}
		if (sim.is_dead) return { accept: false };
	}
	const e = info.end;
	const ok = info.hashOf(sim) === e.h || (physKey(sim) === e.phys && roomKeyOf(info.level)(sim) === e.room);
	return ok ? { accept: true, saved: info.n - ms.length, ev: { ms: Uint8Array.from(ms), runTicks: ms.length, deaths: 0, chance: 1, attempt: true } } : { accept: false };
}
/** a join candidate's rest: the run's own from c.m, or another run's (c.ti) */
const restOf = (info, c) => (c.ti !== undefined ? info.targets[c.ti].ms.subarray(c.m) : info.masks.subarray(c.m, info.n));
/** a state (hash h, at our tick now) equal to another run's (o.targets): the best {ti, m, gain} (gain = this run's finish
 *  tick - ours through that run's rest), or null */
function targetHit(info, h, now, minGain) {
	let best = null;
	for (let ti = 0; ti < info.targets.length; ti++) {
		const T = info.targets[ti], m = T.tick.get(h);
		if (m === undefined) continue;
		const gain = info.n - (now + T.n - m);
		if (gain >= minGain && (!best || gain > best.gain)) best = { ti, m, gain };
	}
	return best;
}
/** the run's exact state after t ticks (into sim) */
function stateAt(info, sim, t, inp) {
	const k = Math.floor(t / SNAP);
	sim.restore(info.snaps[k]);
	for (let u = k * SNAP; u < t; u++) { E.applyMask(inp, info.masks[u]); sim.tick(inp); }
}

// ---------------------------------------------------------------- the starts
/**
 * Where the run later passes far above / below or doubles back: per tick s (every `step`), the excess of the run's
 * path to a later point j (s < j <= s + win) over the straight line, max over j of (path(s, j) - 1.5 x dist(s, j)) /
 * 7 px (ticks at a fast run). Returns [{s, excess}] per step.
 */
function excessOf(info, step, win) {
	const { n, X, Y } = info;
	const P = new Float64Array(n + 1);   // the path length to tick t
	for (let t = 1; t <= n; t++) P[t] = P[t - 1] + Math.abs(X[t] - X[t - 1]) + Math.abs(Y[t] - Y[t - 1]);
	const out = [];
	for (let s = 0; s < n; s += step) {
		let best = 0;
		for (let j = s + 8; j <= Math.min(n, s + win); j += 4) {
			const d = Math.abs(X[j] - X[s]) + Math.abs(Y[j] - Y[s]);
			const e = (P[j] - P[s] - 1.5 * d) / 7;
			if (e > best) best = e;
		}
		out.push({ s, excess: Math.round(best) });
	}
	return out;
}
/**
 * The start ticks in search order. o.order: 'coarse' (the default): coarse to fine, every 8x and 4x o.every ticks, then the
 * dense starts (every o.dense) around the o.spots top spots (local maxima of the excess within 2 x depth), then every
 * 2x and 1x o.every ticks, each level by excess; 'run': every o.every ticks in run order; 'excess': the spots,
 * then every o.every ticks by excess. o.from / o.to bound them; o.starts (a list) replaces them.
 */
function startsOf(info, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const lo = Math.max(0, p.from | 0), hi = Math.min(info.n - p.minGain - 1, p.to > 0 ? p.to : info.n);
	if (p.starts && p.starts.length) return p.starts.filter((s) => s >= 0 && s < info.n - p.minGain);
	const every = Math.max(1, p.every | 0), dense = Math.max(1, p.dense | 0);
	const out = [], seen = new Set();
	const add = (s) => { if (s >= lo && s <= hi && !seen.has(s)) { seen.add(s); out.push(s); } };
	if (p.order === 'run') { for (let s = lo - (lo % every); s <= hi; s += every) add(s); return out; }
	const ex = excessOf(info, dense, 2 * p.depth).filter((e) => e.s >= lo && e.s <= hi);
	const exAt = new Map(ex.map((e) => [e.s, e.excess]));
	const level = (k) => ex.filter((e) => e.s % k === 0).sort((a, b) => b.excess - a.excess || a.s - b.s).forEach((e) => add(e.s));
	// spots: local maxima of the excess (no tick within spotSpan with more), the biggest first
	const spotStarts = () => {
		const spots = ex.filter((e, k) => e.excess > 0 && !ex.some((f, q) => q !== k && Math.abs(f.s - e.s) <= p.spotSpan && (f.excess > e.excess || (f.excess === e.excess && f.s < e.s))))
			.sort((a, b) => b.excess - a.excess).slice(0, p.spots);
		for (const sp of spots) for (let s = sp.s - p.spotSpan; s <= sp.s + p.spotSpan; s += dense) add(Math.max(lo, s - (s % dense)));
	};
	if (p.order === 'excess') { spotStarts(); level(every); return out; }
	level(8 * every);
	level(4 * every);
	spotStarts();
	for (const k of [2 * every, every]) level(k);
	void exAt;
	return out;
}

// ---------------------------------------------------------------- the search
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
function mix(h, v) { h = Math.imul(h ^ v, 0x9e3779b1); return (h ^ (h >>> 15)) >>> 0; }
function mixD(h, d) { f64[0] = d + 0; return mix(mix(h, u32[0]), u32[1]); }

/** The goal window of a search from s: per tile the run's visits in (s, jMax], ascending */
function goalsOf(info, s, jMax) {
	const visits = new Map();
	for (let j = s + 1; j <= jMax; j++) {
		const t = info.T[j];
		if (t < 0) continue;
		let a = visits.get(t);
		if (!a) { a = []; visits.set(t, a); }
		a.push(j);
	}
	return visits;
}

/**
 * One bounded every-move search from sim's state (a snapshot `start` at run tick t0, i.e. the candidate's timeline
 * tick). o: depth, qx, qvx, qy, qvy, pick, cap, log2, region [x0, y0, x1, y1], minGain, visits (goalsOf), hitsPerSeg,
 * rejoinOnly (no leads), colTop (Int32Array: the run's highest row per column in the window, -1 none), deadline.
 * Returns {hits: [{d, idx, t, tile, j, same, close}], rejoins: [{d, par, mask, m, gain}], finishes: [{d, par, mask}],
 * layers: [{par, msk}] per depth (index 0 unused), stats}.
 */
function bfs(info, start, t0, o) {
	const level = info.level, W = info.W, hashOf = info.hashOf;
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	const ctx = info.ctx;
	const CAP = 1 << o.log2, MASK = CAP - 1;
	const hA = new Uint32Array(CAP), hB = new Uint32Array(CAP);
	let used = 0;
	const [rx0, ry0, rx1, ry1] = o.region;
	const tileSeen = new Uint32Array(info.W * info.Hh);
	const visits = o.visits, hashTick = info.hashTick, CX = info.CX, seg = info.seg, X = info.X, Y = info.Y, VX = info.VX, VY = info.VY;
	const minGain = o.minGain;
	const qx = o.qx, qvx = o.qvx, qy = o.qy, qvy = o.qvy;
	const pick = o.pick;
	let ka = 0, kb = 0;
	const cellKey = (cid) => {
		let a = 0x12345, b = 0x6789a;
		const x = Math.floor(sim.px * qx);
		a = mix(a, x); b = mix(b, x + 7);
		if (qy) { const y = Math.floor(sim.py * qy); a = mix(a, y); b = mix(b, y ^ 0x55); } else { a = mixD(a, sim.py); b = mixD(b ^ 0x33, sim.py); }
		if (qvx) { const v = Math.floor(sim.speed_x * qvx); a = mix(a, v); b = mix(b, v ^ 0x77); } else { a = mixD(a, sim.speed_x); b = mixD(b ^ 0x11, sim.speed_x); }
		if (qvy) { const v = Math.floor(sim.speed_y * qvy); a = mix(a, v); b = mix(b, v ^ 0x99); } else { a = mixD(a, sim.speed_y); b = mixD(b ^ 0x22, sim.speed_y); }
		const small = (sim.on_ground ? 1 : 0) | (sim.jump_count << 1) | ((sim._q0 & 0xff) << 8) | ((sim._q1 & 0xff) << 16);
		a = mix(a, small); b = mix(b, small + 3);
		a = mix(a, cid); b = mix(b, cid ^ 0x3c);
		ka = a || 1; kb = b;
	};
	const has = () => { let i = (ka ^ Math.imul(kb, 0x85ebca6b)) & MASK; for (;;) { if (hA[i] === 0) return false; if (hA[i] === ka && hB[i] === kb) return true; i = (i + 1) & MASK; } };
	const insert = () => { let i = (ka ^ Math.imul(kb, 0x85ebca6b)) & MASK; for (;;) { if (hA[i] === 0) { hA[i] = ka; hB[i] = kb; used++; return; } if (hA[i] === ka && hB[i] === kb) return; i = (i + 1) & MASK; } };
	sim.restore(start);
	cellKey(ctx.of(sim)); insert();
	const hits = [], rejoins = [], finishes = [];
	const segCount = new Map(), closeBy = new Map();
	const layers = [null];
	let cur = [start], curN = 1, nxtPool = [];
	const st = { layers: 0, cells: 1, ticks: 0, skipJ: 0, resim: 0, dead: 0, out: 0, cut: 0, peak: 1, full: false, time: false };
	const lastVis = o.lastVis;   // per tile the run's latest visit in the goal window (-1 none)
	const nTargets = info.targets ? info.targets.length : 0;
	// this layer's candidates: one slot per new cell, found through a per-layer open-addressing table (LA/LB keys, LS slot)
	let slotSnap = [], slotPar = [], slotMsk = [], slotScore = [], slotTile = [], slotKa = [], slotKb = [], slotCid = [], slotPos = [];
	let LCAP = 1 << 12, LMASK = LCAP - 1, LA = new Uint32Array(LCAP), LB = new Uint32Array(LCAP), LS = new Int32Array(LCAP);
	for (let d = 1; d <= o.depth && curN > 0; d++) {
		const t = t0 + d;   // the children's tick
		if (LCAP < 12 * curN) { while (LCAP < 12 * curN) LCAP *= 2; LMASK = LCAP - 1; LA = new Uint32Array(LCAP); LB = new Uint32Array(LCAP); LS = new Int32Array(LCAP); }
		let ns = 0;
		for (let i = 0; i < curN; i++) {
			if ((i & 1023) === 0 && o.deadline && Date.now() > o.deadline) { st.time = true; break; }
			const masks = EG.probeMasks(sim, inp, cur[i]);
			st.ticks++;
			// (the masks come without the jump bit first: a jump input that cannot jump (no jumps left after the tick's
			// ground reset, no levitation, the run timer on) leaves exactly the state of the same input without it: skipped)
			let noJump = 0;
			for (let k = 0; k < masks.length; k++) {
				const m = masks[k];
				if ((m & 1) && (noJump & (1 << (m & 30)))) { st.skipJ++; continue; }
				if (k > 0) { sim.restore(cur[i]); E.applyMask(inp, m); sim.tick(inp); st.ticks++; }
				if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
				if (sim.is_dead) { st.dead++; continue; }
				if (sim.has_silver_crown) { if (finishes.length < 16 && t < o.finishBefore) finishes.push({ d, par: i, mask: m }); continue; }
				const tx = Math.floor((sim.px + 8) / 16), ty = Math.floor((sim.py + 8) / 16);
				if (tx < rx0 || tx > rx1 || ty < ry0 || ty > ry1) { st.out++; continue; }
				const tile = ty * W + tx;
				// exact rejoin: a state equal to the run's at a later tick (only where the run goes later: a cheap test first), or
				// to another run's (o.targets) whose rest finishes sooner
				if (lastVis[tile] - t >= minGain || nTargets) {
					const hh = hashOf(sim);
					const mj = hashTick.get(hh);
					if (mj !== undefined && mj - t >= minGain) { rejoins.push({ d, par: i, mask: m, m: mj, gain: mj - t }); continue; }
					if (nTargets) { const th = targetHit(info, hh, t, minGain); if (th) { rejoins.push({ d, par: i, mask: m, m: th.m, ti: th.ti, gain: th.gain }); continue; } }
				}
				const cid = ctx.of(sim);
				cellKey(cid);
				if (has()) continue;
				let score = 0;
				if (pick === 'fast') score = -Math.abs(sim.speed_x);
				else if (pick === 'high') score = sim.py - Math.abs(sim.speed_x) * 1e-3;
				let p = (Math.imul(ka, 0x9e3779b1) ^ kb) & LMASK;
				for (;;) {
					if (LA[p] === 0) break;
					if (LA[p] === ka && LB[p] === kb) break;
					p = (p + 1) & LMASK;
				}
				// (a snapshot only for the layer's first `cap` cells: past that the cut drops most, and a kept one is
				// simulated again from its parent after the cut: ~1 GB a search down to ~0.4)
				if (LA[p] !== 0) {
					const sl = LS[p];
					if (slotScore[sl] <= score) continue;
					if (slotSnap[sl] !== null) slotSnap[sl] = sim.snapshot(slotSnap[sl]);
					slotPar[sl] = i; slotMsk[sl] = m; slotScore[sl] = score;
					continue;
				}
				LA[p] = ka; LB[p] = kb; LS[p] = ns; slotPos[ns] = p;
				slotSnap[ns] = ns < o.cap ? sim.snapshot(nxtPool[ns]) : null; slotPar[ns] = i; slotMsk[ns] = m; slotScore[ns] = score; slotTile[ns] = tile;
				slotKa[ns] = ka; slotKb[ns] = kb; slotCid[ns] = cid;
				ns++;
			}
		}
		for (let q = 0; q < ns; q++) LA[slotPos[q]] = 0;
		if (st.time) break;
		// the layer's cut (novelty): per tile in turn, new heights first, then tiles the run never visits, then the least seen
		let order = null;
		if (ns > o.cap) {
			st.cut += ns - o.cap;
			const groups = new Map();
			for (let q = 0; q < ns; q++) { const tl = slotTile[q]; let g = groups.get(tl); if (!g) { g = []; groups.set(tl, g); } g.push(q); }
			const cls = (tl) => {
				const col = tl % W, row = (tl / W) | 0;
				if (o.colTop && (o.colTop[col] < 0 || row < o.colTop[col])) return 0;
				return lastVis[tl] >= 0 ? 2 : 1;
			};
			const gl = [...groups].map(([tl, g]) => ({ g, c: cls(tl), seen: tileSeen[tl] }));
			gl.sort((a, b) => a.c - b.c || a.seen - b.seen);
			order = [];
			for (let r = 0; order.length < o.cap; r++) {
				let any = false;
				for (const x of gl) { if (r < x.g.length) { order.push(x.g[r]); any = true; if (order.length >= o.cap) break; } }
				if (!any) break;
			}
			order.sort((a, b) => a - b);   // (the kept slots in their found order: the lineage order stays)
		}
		const nk = order ? order.length : ns;
		const par = new Int32Array(nk), msk = new Uint8Array(nk);
		const nxt = new Array(nk);
		// the dropped cells' snapshots, for the kept ones without one (simulated again from their parent)
		let spare = null;
		if (order && ns > o.cap) {
			const kept = new Uint8Array(ns);
			for (const q of order) kept[q] = 1;
			spare = [];
			for (let q = 0; q < ns; q++) if (!kept[q] && slotSnap[q] !== null) spare.push(slotSnap[q]);
		}
		for (let r = 0; r < nk; r++) {
			const q = order ? order[r] : r;
			ka = slotKa[q]; kb = slotKb[q]; insert();
			par[r] = slotPar[q]; msk[r] = slotMsk[q]; nxt[r] = slotSnap[q];
			if (nxt[r] === null) {
				sim.restore(cur[slotPar[q]]); E.applyMask(inp, slotMsk[q]); sim.tick(inp); st.ticks++; st.resim++;
				nxt[r] = sim.snapshot(spare && spare.length ? spare.pop() : undefined);
			}
			const tile = slotTile[q];
			tileSeen[tile]++;
			// a lead: the run is in this tile at least minGain ticks later. Per run stretch the first arrivals (hitsPerSeg,
			// at the latest such visit: the most gain; the same discrete state first) and the arrivals closest to the run's
			// state at one of its visits (hitsClose, |dpos| + 3 |dvel|, another discrete state + 1000): the joins' best chances
			if (!o.rejoinOnly) {
				const vis = visits.get(tile);
				if (vis !== undefined && vis[vis.length - 1] - t >= minGain) {
					const sn = nxt[r], cid = slotCid[q];
					let j = -1, same = false, jc = -1, cc = Infinity;
					for (let e = vis.length - 1; e >= 0 && vis[e] - t >= minGain; e--) {
						const v = vis[e], sm = CX[v] === cid;
						if (j < 0 || (sm && !same)) { j = v; same = sm; }
						const c = Math.abs(sn.px - X[v]) + Math.abs(sn.py - Y[v]) + 3 * (Math.abs(sn.speed_x - VX[v]) + Math.abs(sn.speed_y - VY[v])) + (sm ? 0 : 1000);
						if (c < cc) { cc = c; jc = v; }
					}
					const sk = seg[j] * 2 + (same ? 1 : 0);
					const c = segCount.get(sk) || 0;
					if (c < o.hitsPerSeg) {
						segCount.set(sk, c + 1);
						hits.push({ d, idx: r, t, tile, j, same, close: Math.abs(sn.px - X[j]) + Math.abs(sn.py - Y[j]) + 3 * (Math.abs(sn.speed_x - VX[j]) + Math.abs(sn.speed_y - VY[j])) });
					}
					// the closest: a small list per stretch, the worst replaced
					const ck = seg[jc];
					let L = closeBy.get(ck);
					if (!L) { L = []; closeBy.set(ck, L); }
					if (L.length < o.hitsClose || cc < L[L.length - 1].close) {
						const hit = { d, idx: r, t, tile, j: jc, same: CX[jc] === cid, close: cc };
						if (L.length >= o.hitsClose) L.pop();
						let k = L.length;
						while (k > 0 && L[k - 1].close > cc) k--;
						L.splice(k, 0, hit);
					}
				}
			}
		}
		layers.push({ par, msk });
		st.layers = d; st.cells = used;
		if (nk > st.peak) st.peak = nk;
		// the snapshot pools: this layer's become the parents; the parents' objects are reused two layers on
		const old = cur;
		cur = nxt; curN = nk;
		nxtPool = d === 1 ? [] : old;
		slotSnap = []; slotPar = []; slotMsk = []; slotScore = []; slotTile = []; slotKa = []; slotKb = []; slotCid = [];
		if (used > CAP * 0.7) { st.full = true; break; }
	}
	// the leads: the first arrivals, then the closest ones (a lead in both lists once)
	const inHits = new Set(hits.map((h) => h.d * 1e7 + h.idx));
	for (const L of closeBy.values()) for (const h of L) if (!inHits.has(h.d * 1e7 + h.idx)) { h.near = true; hits.push(h); }
	return { hits, rejoins, finishes, layers, stats: st };
}

/** the masks from the search's start to layer d's state idx (or its child by `mask` when par given) */
function pathOf(layers, d, idx) {
	const out = new Uint8Array(d);
	for (let e = d, i = idx; e >= 1; e--) { out[e - 1] = layers[e].msk[i]; i = layers[e].par[i]; }
	return out;
}
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let k = 0;
	for (const p of parts) { out.set(p, k); k += p.length; }
	return out;
}

/**
 * The join of a lead (a state at tick t = s + d in a tile the run visits at j): from the lead's state and the states
 * before it on its path (every tailStep ticks, tailBack back), the run's own inputs from r0 in [j - offBack, j +
 * offAhead], checked every tick for an exact state of the run at a tick m at least minGain later (else the same
 * physical state: the rest as it is). Returns candidate runs [{ms, claim, how}] (not yet replayed), the most claimed
 * first, at most o.maxCands.
 */
function join(info, s, P, hit, o) {
	const sim = new E.EESim(info.level);
	const inp = new E.EEInput();
	const { masks, n } = info;
	const played = new Uint8Array(o.tailH);
	stateAt(info, sim, s, inp);
	const d = P.length;
	// the path's states from d - tailBack to d
	const d0 = Math.max(0, d - o.tailBack);
	const snaps = new Map();
	for (let e = 0; e <= d; e++) {
		if (e >= d0 && ((d - e) % o.tailStep === 0)) snaps.set(e, sim.snapshot());
		if (e < d) { E.applyMask(inp, P[e]); sim.tick(inp); }
	}
	const out = [];
	const seenKey = new Set();
	// the lead's own state first, then the earlier ones
	const order = [...snaps].sort((a, b) => b[0] - a[0]);
	for (const [e, sn] of order) {
		if (o.deadline && Date.now() > o.deadline) break;
		const te = s + e;   // the tick of this path state
		for (let r0 = Math.max(te + 1, hit.j - o.offBack); r0 <= Math.min(n - 1, hit.j + o.offAhead); r0++) {
			if (o.deadline && (r0 & 15) === 0 && Date.now() > o.deadline) break;
			const c = tail(info, sim, inp, sn, te, r0, o, played);
			if (!c) continue;
			const key = `${e},${c.claim}`;
			if (seenKey.has(key)) continue;
			seenKey.add(key);
			c.e = e;
			c.how = `${KINDS[c.kind]} (path ${e} ticks, ${c.how})`;
			out.push(c);
		}
	}
	out.sort((a, b) => a.kind - b.kind || b.claim - a.claim);
	return out.slice(0, o.maxCands).map((c) => ({ ms: concat([masks.subarray(0, s), P.subarray(0, c.e), c.seq, restOf(info, c)]), kind: c.kind, claim: c.claim, how: c.how, edge: c.e + c.seq.length, m: c.m }));
}
/**
 * One tail: from snapshot sn (our tick te), the run's own inputs from run tick r0, checked every tick for a state of the
 * run (exact: kind 0; the same physical state, another discrete one: kind 1) at a tick at least o.minGain later than
 * ours; re-anchored (like mutate --anchor, up to o.anchors times): at a landing or a wall stop the tail goes on with the
 * inputs of the run tick in [r - 8, r + 150] whose state is nearest (|dpos| + 3 |dvel| < o.anchorD), so a tail a
 * little early or late still meets the run where the run's inputs are timed for; it ends when it dies, drifts away from
 * the run at its run tick (o.tailDiverge px beyond its nearest) or after o.tailH ticks. -> {seq, m, kind, claim, how} | null
 */
function tail(info, sim, inp, sn, te, r0, o, played) {
	const { masks, n, hashTick, physTick, X, Y, VX, VY, hashOf } = info;
	sim.restore(sn);
	let dmin = Infinity, anchors = 0, ground = sim.on_ground;
	let r = r0;
	// the closest approach to the run's state at the run tick the tail is in phase with (|dpos| + 3 |dvel|): with no exact
	// join, a tail that came within o.looseD of it is a loose candidate (the run from there as it is: the replay decides)
	let bestD = Infinity, bestK = 0, bestR = -1, bestNow = 0;
	const loose = () => (bestD < o.looseD && bestR - bestNow >= o.minGain
		? { seq: played.slice(0, bestK), m: bestR, kind: 2, claim: bestR - bestNow, how: `${bestK} ticks of the run's inputs from ${r0}, then the run from ${bestR} as it is (within ${bestD.toFixed(2)} of its state there)` }
		: null);
	for (let k = 0; k < o.tailH && r < n; k++) {
		const vx0 = sim.speed_x;
		played[k] = masks[r];
		E.applyMask(inp, masks[r]); sim.tick(inp);
		r++;
		const len = k + 1;
		if (sim.is_dead) return loose();
		const now = te + len;
		{
			const dd = Math.abs(sim.px - X[r]) + Math.abs(sim.py - Y[r]) + 3 * (Math.abs(sim.speed_x - VX[r]) + Math.abs(sim.speed_y - VY[r]));
			if (dd < bestD && r - now >= o.minGain) { bestD = dd; bestK = len; bestR = r; bestNow = now; }
		}
		const hh = hashOf(sim);
		const m = hashTick.get(hh);
		if (info.targets.length && (m === undefined || m - now < o.minGain)) { const th = targetHit(info, hh, now, o.minGain); if (th) return { seq: played.slice(0, len), m: th.m, ti: th.ti, kind: 0, claim: th.gain, how: `${len} ticks of the run's inputs from ${r0}, meets another run (target ${th.ti}) at ${th.m}` }; }
		if (m !== undefined) {
			if (m - now < o.minGain) return null;
			return { seq: played.slice(0, len), m, kind: 0, claim: m - now, how: `${len} ticks of the run's inputs from ${r0}${anchors ? ` re-anchored ${anchors}x` : ''}, meets the run at ${m}` };
		}
		const q = physTick.get(physKey(sim));
		if (q !== undefined) {
			if (q - now < o.minGain) return null;
			return { seq: played.slice(0, len), m: q, kind: 1, claim: q - now, how: `${len} ticks of the run's inputs from ${r0}, meets the run's position at ${q}; the discrete state differs` };
		}
		if (anchors < o.anchors && ((sim.on_ground && !ground) || (Math.abs(vx0) >= 1 && sim.speed_x === 0))) {
			let bq = -1, bd = o.anchorD;
			for (let q2 = Math.max(0, r - 8); q2 <= Math.min(n - 1, r + 150); q2++) {
				const dd = Math.abs(sim.px - X[q2]) + Math.abs(sim.py - Y[q2]) + 3 * (Math.abs(sim.speed_x - VX[q2]) + Math.abs(sim.speed_y - VY[q2]));
				if (dd < bd) { bd = dd; bq = q2; }
			}
			if (bq >= 0 && bq !== r) { r = bq; anchors++; dmin = Infinity; }
		}
		ground = sim.on_ground;
		if (r >= n) return loose();
		const dist = Math.abs(sim.px - X[r]) + Math.abs(sim.py - Y[r]);
		if (dist < dmin) dmin = dist;
		else if (dist > dmin + o.tailDiverge) return loose();
	}
	return loose();
}
/**
 * The tracking join: from snapshot sn (our tick te, a lead the run passes at run tick r0), a beam that follows the run's
 * own trajectory: each tick every input (the masks that act; a jump that cannot jump skipped) from each of the o.trackW
 * states kept, the children nearest the run's state in phase (run tick r0 + k, +-o.trackPhase: |dpos| + 3 |dvel|) kept,
 * every child checked for a state equal to the run's at a tick at least o.minGain later than ours. In a field (arrows,
 * dots) the run's own inputs from a lead half a pixel off drift away within ~50 ticks and exact meetings are rare (EX
 * Crew: the next one 500 run ticks on, at an up-arrow column); the beam keeps steering back to the run until it meets it.
 * -> {seq, m, kind 0, claim, how} | null
 */
function track(info, sn, te, r0, o) {
	const { n, hashTick, X, Y, VX, VY, hashOf } = info;
	const sim = new E.EESim(info.level), inp = new E.EEInput();
	const W = o.trackW, PH = o.trackPhase, VW = o.trackVw;
	let cur = [sn], lostK = 0;
	const layers = [];
	for (let k = 0; k < o.trackH && r0 + k + 1 + PH < n; k++) {
		if (o.deadline && (k & 15) === 0 && Date.now() > o.deadline) return null;
		const now = te + k + 1, rr = r0 + k + 1;
		const kids = [], seen = new Map();
		for (let i = 0; i < cur.length; i++) {
			const masks = EG.probeMasks(sim, inp, cur[i]);
			let noJump = 0;
			for (let q = 0; q < masks.length; q++) {
				const m = masks[q];
				if ((m & 1) && (noJump & (1 << (m & 30)))) continue;
				if (q > 0) { sim.restore(cur[i]); E.applyMask(inp, m); sim.tick(inp); }
				if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
				if (sim.is_dead) continue;
				const h = hashOf(sim);
				const mj = hashTick.get(h);
				if (mj !== undefined && mj - now >= o.minGain) {
					// met the run: the inputs back through the beam's layers
					const seq = new Uint8Array(k + 1);
					seq[k] = m;
					for (let e = k - 1, idx = i; e >= 0; e--) { seq[e] = layers[e].msk[idx]; idx = layers[e].par[idx]; }
					return { seq, m: mj, kind: 0, claim: mj - now, how: `a ${k + 1}-tick tracking join along the run from ${r0}, meets the run at ${mj}` };
				}
				if (info.targets.length) {
					const th = targetHit(info, h, now, o.minGain);
					if (th) {
						const seq = new Uint8Array(k + 1);
						seq[k] = m;
						for (let e = k - 1, idx = i; e >= 0; e--) { seq[e] = layers[e].msk[idx]; idx = layers[e].par[idx]; }
						return { seq, m: th.m, ti: th.ti, kind: 0, claim: th.gain, how: `a ${k + 1}-tick tracking join along the run from ${r0}, meets another run (target ${th.ti}) at ${th.m}` };
					}
				}
				// one state per fine cell (1 px, 1/8 px/tick, ground, jumps): the nearest; a beam of copies would collapse
				const cell = Math.floor(sim.px) * 1e6 + Math.floor(sim.py) * 97 + Math.floor(sim.speed_x * 8) * 7919 + Math.floor(sim.speed_y * 8) * 104729 + (sim.on_ground ? 0.5 : 0) + sim.jump_count * 0.25;
				let dd = Infinity;
				for (let rq = Math.max(0, rr - PH); rq <= Math.min(n, rr + PH); rq++) {
					const d = Math.abs(sim.px - X[rq]) + Math.abs(sim.py - Y[rq]) + VW * (Math.abs(sim.speed_x - VX[rq]) + Math.abs(sim.speed_y - VY[rq]));
					if (d < dd) dd = d;
				}
				const had = seen.get(cell);
				if (had !== undefined) {
					if (kids[had].d <= dd) continue;
					kids[had] = { d: dd, par: i, m, s: sim.snapshot(kids[had].s) };
					continue;
				}
				seen.set(cell, kids.length);
				kids.push({ d: dd, par: i, m, s: sim.snapshot() });
			}
		}
		if (!kids.length) return null;
		kids.sort((a, b) => a.d - b.d);
		const keep = kids.length > W ? kids.slice(0, W) : kids;
		if (o.debug && k % 25 === 0) console.log(`  track k ${k} run ${rr} kept ${keep.length} of ${kids.length} nearest ${keep[0].d.toFixed(2)}`);
		// (a beam that lost the run for trackLostK ticks in a row stops)
		lostK = keep[0].d > o.trackLost ? lostK + 1 : 0;
		if (lostK > o.trackLostK) return null;
		layers.push({ par: Int32Array.from(keep, (x) => x.par), msk: Uint8Array.from(keep, (x) => x.m) });
		cur = keep.map((x) => x.s);
	}
	return null;
}
/**
 * Quick tails from every lead state (the hits, several per run stretch): the run's inputs from next to the visit it
 * met (o.quickOffs), anchored. Cheap (a few hundred ticks a tail) and many states: a lineage the per-lead sweep does not
 * see. -> candidates as join()'s
 */
function quickTails(info, s, layers, hits, o) {
	const sim = new E.EESim(info.level), s2 = new E.EESim(info.level);
	const inp = new E.EEInput();
	const played = new Uint8Array(o.tailH);
	stateAt(info, s2, s, inp);
	const start = s2.snapshot();
	const out = [];
	const seen = new Set();
	for (const h of hits) {
		if (o.deadline && Date.now() > o.deadline) break;
		const P = pathOf(layers, h.d, h.idx);
		s2.restore(start);
		for (let e = 0; e < P.length; e++) { E.applyMask(inp, P[e]); s2.tick(inp); }
		const sn = s2.snapshot();
		const te = s + h.d;
		// a lead near the run's own state: the run from its visit as it is (the replay decides)
		if (h.close < o.looseD * 3) {
			for (const off of [0, 1, -1]) {
				const r0 = h.j + off;
				if (r0 - te >= o.minGain && r0 < info.n) out.push({ ms: concat([info.masks.subarray(0, s), P, info.masks.subarray(r0, info.n)]), kind: 2, claim: r0 - te,
					how: `loose join (path ${h.d} ticks to the lead at ${te}, within ${h.close.toFixed(2)} of the run's state at ${h.j}, then the run from ${r0} as it is)`, edge: h.d, m: r0 });
			}
		}
		for (const off of o.quickOffs) {
			const r0 = h.j + off;
			if (r0 <= te || r0 >= info.n) continue;
			const c = tail(info, sim, inp, sn, te, r0, o, played);
			if (!c) continue;
			const key = `${h.d},${h.idx},${c.claim}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ ms: concat([info.masks.subarray(0, s), P, c.seq, restOf(info, c)]), kind: c.kind, claim: c.claim,
				how: `${KINDS[c.kind]} (path ${h.d} ticks to the lead at ${te} (the run there at ${h.j}), ${c.how})`, edge: h.d + c.seq.length, m: c.m });
		}
	}
	return out;
}

/**
 * All searches from one start s with one pick: the bfs, then the candidates (its exact rejoins, its finishes, the joins
 * of its best leads), each replayed and judged against the run. Returns {best: {ms, ev, saved, how, s, pick} | null,
 * stats, hits, rejoins, cands}.
 */
/** The goal window of a search from run tick a: the run's visits in (a, b] per tile (visits, lastVis), the region (the
 *  run's tiles over [a, b] + margin, and the tiles `extra`), the run's highest row per column (colTop) */
function windowOf(info, a, b, margin, extra) {
	const visits = goalsOf(info, a, b);
	const lastVis = new Int32Array(info.W * info.Hh).fill(-1);
	for (const [tl, v] of visits) lastVis[tl] = v[v.length - 1];
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const colTop = new Int32Array(info.W).fill(-1);
	const see = (tl) => {
		const x = tl % info.W, y = (tl / info.W) | 0;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		return [x, y];
	};
	for (let j = a; j <= b; j++) {
		const tl = info.T[j];
		if (tl < 0) continue;
		const [x, y] = see(tl);
		if (colTop[x] < 0 || y < colTop[x]) colTop[x] = y;
	}
	for (const tl of extra || []) see(tl);
	const region = [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(info.W - 1, x1 + margin), Math.min(info.Hh - 1, y1 + margin)];
	return { visits, lastVis, colTop, region };
}

/**
 * All searches from one start s with one pick, within o.perS seconds (and o.deadline): the bfs (o.bfsShare of the
 * time), then the candidates: its exact rejoins and finishes; per lead (the joinTop best by gain, one per run stretch)
 * the tails (`join`) and loose splices (the run from next to the visit as it is); then, for the joinBfs best leads
 * still unjoined, a short exact join: a second bfs from the lead's state whose only goal is a state equal to the run's
 * (o.joinDepth layers, o.joinCap per layer). Each candidate replayed and judged against o.best (default the run).
 * Returns {best: {ms, ev, saved, how, s, pick, edge, m} | null, stats, hits, rejoins, leadsJoined, joinBfs, cands, tried, top}.
 */
function searchStart(info, s, pick, o) {
	const p = Object.assign({}, DEFAULTS, o);
	const t0 = Date.now();
	const dl = Math.min(p.deadline || Infinity, t0 + p.perS * 1000);
	const sim = new E.EESim(info.level);
	const inp = new E.EEInput();
	stateAt(info, sim, s, inp);
	const start = sim.snapshot();
	const jMax = Math.min(info.n, s + p.depth + p.horizon);
	const win = windowOf(info, s, jMax, p.margin);
	// (an attempt: any finish is a route, whatever its length)
	const r = bfs(info, start, s, Object.assign({}, p, { pick, finishBefore: info.attempt ? Infinity : info.n, region: win.region, visits: win.visits, lastVis: win.lastVis, colTop: win.colTop,
		deadline: Math.min(dl, t0 + p.perS * 1000 * p.bfsShare) }));
	const bfsMs = Date.now() - t0;
	const base = o.best || info.ev;
	let best = null, tried = 0, cands = 0;
	// every candidate replayed and judged, the most claimed first (only those that claim more than the best so far)
	// (exact joins first: their claim is a proof up to deaths and the random-portal chance; then at most 8 physical
	// rejoins and 12 loose joins a list, whose replay decides)
	// (an attempt: attemptJudge, the end state sooner; a candidate that finishes is a route and beats every shortcut)
	const LIM = [p.maxCands, 8, 12];
	const tryCands = (list) => {
		list.sort((a, b) => a.kind - b.kind || b.claim - a.claim);
		cands += list.length;
		const k = [0, 0, 0];
		for (const c of list) {
			if (best && (best.route || c.claim <= best.saved)) continue;
			if (k[c.kind]++ >= LIM[c.kind]) continue;
			tried++;
			if (info.attempt) {
				const v = attemptJudge(info, c.ms);
				if (v.accept && (v.route || !best || v.saved > best.saved)) best = { ms: v.ev.ms, ev: v.ev, saved: v.route ? info.n : v.saved, route: !!v.route, how: v.route ? `a route: ${c.how}` : c.how, s, pick, edge: c.edge, m: c.m };
				continue;
			}
			const ev = C.evaluate(info.level, c.ms);
			const v = C.judge(ev, best ? best.ev : base, info.ev.deaths);
			if (v.accept && ev.runTicks < base.runTicks) best = { ms: ev.ms, ev, saved: base.runTicks - ev.runTicks, how: c.how, s, pick, edge: c.edge, m: c.m };
		}
	};
	const pre = info.masks.subarray(0, s);
	const direct = [];
	for (const rj of r.rejoins) {
		const P = concat([rj.d > 1 ? pathOf(r.layers, rj.d - 1, rj.par) : new Uint8Array(0), Uint8Array.of(rj.mask)]);
		const rest = rj.ti !== undefined ? info.targets[rj.ti].ms.subarray(rj.m) : info.masks.subarray(rj.m, info.n);
		direct.push({ ms: concat([pre, P, rest]), kind: 0, claim: rj.gain, how: `exact rejoin in the search (${rj.d} ticks, meets ${rj.ti !== undefined ? `another run (target ${rj.ti})` : "the run"} at ${rj.m})`, edge: rj.d, m: rj.m });
	}
	for (const f of r.finishes) {
		const P = concat([f.d > 1 ? pathOf(r.layers, f.d - 1, f.par) : new Uint8Array(0), Uint8Array.of(f.mask)]);
		direct.push({ ms: concat([pre, P]), kind: 0, claim: info.n - (s + f.d), how: `finish in the search (${f.d} ticks)`, edge: f.d, m: info.n });
	}
	tryCands(direct);
	// the leads: the most gain first, the same discrete state first, one per run stretch
	const leads = r.hits.slice().sort((a, b) => (b.j - b.t) - (a.j - a.t) || (b.same - a.same) || a.close - b.close);
	// quick tails from every lead state, the most gain first
	const tq = Date.now();
	// (the leads nearest the run's own state first: the likeliest to meet it exactly; then by gain)
	const qlist = r.hits.slice().sort((a, b) => a.close - b.close || (b.j - b.t) - (a.j - a.t)).slice(0, p.quickMax);
	tryCands(quickTails(info, s, r.layers, qlist, Object.assign({}, p, { deadline: Math.min(dl, tq + p.quickS * 1000) })));
	const quickMs = Date.now() - tq;
	// tracking joins (track): from the nearest leads and the biggest gains in turn, one per run stretch
	const tt = Date.now();
	let tracks = 0;
	{
		const segT = new Set(), list = [];
		const add = (h) => { if (!h || h.j - h.t < 2 * p.minGain) return; const k = info.seg[h.j]; if (segT.has(k)) return; segT.add(k); list.push(h); };
		const byNear = r.hits.slice().sort((a, b) => a.close - b.close);
		for (let i = 0; i < Math.max(byNear.length, leads.length) && list.length < p.trackTop; i++) { add(byNear[i]); if (list.length < p.trackTop) add(leads[i]); }
		const sj = new E.EESim(info.level);
		for (const h of list) {
			if (Date.now() > dl) break;
			if (best && h.j - h.t <= best.saved) continue;
			const P = pathOf(r.layers, h.d, h.idx);
			stateAt(info, sj, s, inp);
			for (let e = 0; e < P.length; e++) { E.applyMask(inp, P[e]); sj.tick(inp); }
			const c = track(info, sj.snapshot(), s + h.d, h.j, Object.assign({}, p, { deadline: Math.min(dl, Date.now() + p.trackS * 1000) }));
			tracks++;
			if (c) tryCands([{ ms: concat([pre, P, c.seq, restOf(info, c)]), kind: 0, claim: c.claim,
				how: `exact rejoin (path ${h.d} ticks to the lead at ${s + h.d} (the run there at ${h.j}), ${c.how})`, edge: h.d + c.seq.length, m: c.m }]);
		}
	}
	const trackMs = Date.now() - tt;
	const joined = [];
	const segDone = new Set();
	let tailsMs = 0, joinMs = 0;
	for (const h of leads) {
		if (joined.length >= p.joinTop || Date.now() > dl) break;
		if (best && h.j - h.t <= best.saved) break;
		const sk = info.seg[h.j];
		if (segDone.has(sk)) continue;
		segDone.add(sk);
		const P = pathOf(r.layers, h.d, h.idx);
		joined.push({ h, P });
		const tj = Date.now();
		const list = join(info, s, P, h, Object.assign({}, p, { deadline: Math.min(dl, tj + p.tailS * 1000) }));
		tailsMs += Date.now() - tj;
		// loose splices: the run from next to the visit as it is (a skipped switch or coin the rest never needs; the replay decides)
		for (const off of [0, 1, -1, 2, -2]) {
			const r0 = h.j + off;
			if (r0 > s + h.d && r0 < info.n) list.push({ ms: concat([pre, P, info.masks.subarray(r0, info.n)]), kind: 2, claim: r0 - (s + h.d), how: `loose splice (path ${h.d} ticks, the run from ${r0})`, edge: h.d, m: r0 });
		}
		tryCands(list);
	}
	// the short exact join: a second search from the leads nearest the run's own state (one per run stretch, at least
	// 2 x minGain ahead), whose only goal is a state equal to the run's (in a field small differences grow: the run's
	// own inputs from a lead 0.5 px off drift away, the replay of a loose join does not finish)
	let joinBfs = 0;
	const joinStats = [];
	const nearSeg = new Set();
	const nearLeads = r.hits.filter((h) => h.j - h.t >= 2 * p.minGain).sort((a, b) => a.close - b.close)
		.filter((h) => { const k = info.seg[h.j]; if (nearSeg.has(k)) return false; nearSeg.add(k); return true; });
	for (const h of nearLeads) {
		if (joinBfs >= p.joinBfs || Date.now() > dl - 1000) break;
		if (best && h.j - h.t <= best.saved + p.minGain) continue;
		joinBfs++;
		const P = pathOf(r.layers, h.d, h.idx);
		const tb = Date.now();
		const dlj = tb + (dl - tb) / Math.max(1, p.joinBfs - joinBfs + 1);   // (the time left, shared by the joins to come)
		const sj = new E.EESim(info.level);
		stateAt(info, sj, s, inp);
		for (let e = 0; e < P.length; e++) { E.applyMask(inp, P[e]); sj.tick(inp); }
		const tl = s + h.d;
		const w2 = windowOf(info, Math.max(s, h.j - 100), Math.min(info.n, h.j + p.joinDepth + p.horizon), p.joinMargin, [h.tile]);
		// goals: the run's visits after the lead's own tick only
		const lv = w2.lastVis;
		const r2 = bfs(info, sj.snapshot(), tl, Object.assign({}, p, { pick, finishBefore: info.attempt ? Infinity : info.n, depth: p.joinDepth, cap: p.joinCap, rejoinOnly: true, region: w2.region, visits: w2.visits, lastVis: lv,
			colTop: w2.colTop, deadline: dlj }));
		joinMs += Date.now() - tb;
		joinStats.push({ t: tl, j: h.j, close: Math.round(h.close * 100) / 100, layers: r2.stats.layers, cells: r2.stats.cells, peak: r2.stats.peak, rejoins: r2.rejoins.length, time: r2.stats.time, out: r2.stats.out, dead: r2.stats.dead });
		const list = [];
		for (const rj of r2.rejoins) {
			const P2 = concat([rj.d > 1 ? pathOf(r2.layers, rj.d - 1, rj.par) : new Uint8Array(0), Uint8Array.of(rj.mask)]);
			list.push({ ms: concat([pre, P, P2, info.masks.subarray(rj.m, info.n)]), kind: 0, claim: rj.gain, how: `exact join (path ${h.d} ticks to the lead at ${tl} (the run there at ${h.j}), then ${rj.d} more, meets the run at ${rj.m})`, edge: h.d + rj.d, m: rj.m });
		}
		for (const f of r2.finishes) {
			const P2 = concat([f.d > 1 ? pathOf(r2.layers, f.d - 1, f.par) : new Uint8Array(0), Uint8Array.of(f.mask)]);
			list.push({ ms: concat([pre, P, P2]), kind: 0, claim: info.n - (tl + f.d), how: `finish from the lead (path ${h.d} + ${f.d} ticks)`, edge: h.d + f.d, m: info.n });
		}
		tryCands(list);
	}
	const top = leads[0] ? { t: leads[0].t, j: leads[0].j, gain: leads[0].j - leads[0].t, tile: [leads[0].tile % info.W, (leads[0].tile / info.W) | 0], same: leads[0].same } : null;
	// the leads no join closed (the biggest gains, one per run stretch): for the finisher (the main thread's GPU lane:
	// every move from the lead to the trophy, bounded by the run's own finish)
	const unjoined = [];
	if (!best && p.unjoinedTop > 0) {
		const sg = new Set();
		for (const h of leads) {
			if (unjoined.length >= p.unjoinedTop || h.j - h.t < p.gpuMin) break;
			const k = info.seg[h.j];
			if (sg.has(k)) continue;
			sg.add(k);
			unjoined.push({ d: h.d, j: h.j, gain: h.j - h.t, same: h.same, P: Array.from(pathOf(r.layers, h.d, h.idx)) });
		}
	}
	// (an attempt: its best leads with the same discrete state, the most gain first, one per run stretch: whole runs to the
	// lead's state, reaching a place the attempt reaches only o.leadMin+ ticks later; the lane hands them to the one
	// search's archive as footholds, whose cells there then hold the earlier arrival)
	const leadRuns = [];
	if (info.attempt && p.leadRuns > 0) {
		const sg = new Set();
		for (const h of leads) {
			if (leadRuns.length >= p.leadRuns || h.j - h.t < p.leadMin) break;
			if (!h.same) continue;
			const k = info.seg[h.j];
			if (sg.has(k)) continue;
			sg.add(k);
			leadRuns.push({ ms: Array.from(concat([pre, pathOf(r.layers, h.d, h.idx)])), gain: h.j - h.t, j: h.j, tile: [h.tile % info.W, (h.tile / info.W) | 0] });
		}
	}
	return { best, stats: Object.assign(r.stats, { bfsMs, quickMs, trackMs, tailsMs, joinMs, ms: Date.now() - t0, region: win.region }), hits: r.hits.length, rejoins: r.rejoins.length, tracks, leadsJoined: joined.length, joinBfs, joinStats, cands, tried, top, unjoined, leadRuns };
}

/**
 * The carry-over of a shortcut to another lineage (the lane: an attempt or a route that shares no state with its
 * library: another worker's, another strategy's): where the target (info: an attempt, prepare's attempt mode, or a
 * route) is in a tile a shortened attempt
 * of src ([{ms, skipAt, what}]: its states from skipAt on are the early ones) reached at least 2 x minGain ticks sooner
 * (every CROSS_EVERY ticks for CROSS_SPAN ticks past skipAt), and its state there within CROSS_D (|dpos| + 3 |dvel|) of
 * the library's: from the library's state the target's own inputs from next to its visit (tail: re-anchored at landings
 * and wall stops, checked every tick for the target's state); every candidate replayed (an attempt: attemptJudge; a
 * route: C.evaluate + C.judge, run ticks saved). At most CROSS_TAILS tails and o.crossMs ms. -> {ms, saved, how, ev} | null
 */
const CROSS_EVERY = 15, CROSS_SPAN = 3000, CROSS_D = 40, CROSS_TAILS = 400;
function carryOver(level, src, info, o) {
	if (!src.length || !info) return null;
	const P = Object.assign({}, DEFAULTS, o);
	const judge = info.attempt ? (cand) => { const v = attemptJudge(info, cand); return v.accept && !v.route ? { ms: v.ev.ms, saved: v.saved, ev: v.ev } : null; }
		: (cand) => {
			const ev = C.evaluate(level, cand);
			if (!ev || !(ev.runTicks < info.ev.runTicks) || !C.judge(ev, info.ev, info.ev.deaths).accept) return null;
			return { ms: ev.ms, saved: info.ev.runTicks - ev.runTicks, ev };
		};
	const visits = goalsOf(info, 0, info.n);
	const sim = new E.EESim(level), s2 = new E.EESim(level), inp = new E.EEInput(), inp2 = new E.EEInput();
	const deadline = Date.now() + (P.crossMs || 2000);
	const oo = Object.assign({}, P, { deadline });
	const played = new Uint8Array(oo.tailH);
	let best = null, tails = 0;
	for (const R of src) {
		sim.reset();
		const end = Math.min(R.ms.length, R.skipAt + CROSS_SPAN);
		for (let r = 0; r < end && tails < CROSS_TAILS && Date.now() < deadline; r++) {
			E.applyMask(inp, R.ms[r]);
			sim.tick(inp);
			if (sim.is_dead || sim.has_silver_crown) break;
			const tr = r + 1;
			if (tr < R.skipAt || (tr - R.skipAt) % CROSS_EVERY !== 0) continue;
			const tx = Math.floor((sim.px + 8) / 16), ty = Math.floor((sim.py + 8) / 16);
			const vis = visits.get(ty * info.W + tx);
			if (!vis) continue;
			// (the target's visit of this tile nearest the library's state, at least 2 x minGain later)
			let bt = -1, bd = CROSS_D;
			for (const t of vis) {
				if (t - tr < 2 * P.minGain || t >= info.n) continue;
				const d = Math.abs(sim.px - info.X[t]) + Math.abs(sim.py - info.Y[t]) + 3 * (Math.abs(sim.speed_x - info.VX[t]) + Math.abs(sim.speed_y - info.VY[t]));
				if (d < bd) { bd = d; bt = t; }
			}
			if (bt < 0 || (best && bt - tr <= best.saved)) continue;
			const sn = sim.snapshot();
			for (const off of [0, -2, 2, -5, 5]) {
				const r0 = bt + off;
				if (r0 <= tr || r0 >= info.n) continue;
				tails++;
				const c = tail(info, s2, inp2, sn, tr, r0, oo, played);
				if (!c || c.kind === 2 || (best && c.claim <= best.saved)) continue;
				const v = judge(concat([R.ms.subarray(0, tr), c.seq, restOf(info, c)]));
				if (v && (!best || v.saved > best.saved)) best = Object.assign(v, { how: `carried over: the library's ${R.what || 'run'} to its tick ${tr}, then ${c.how}` });
			}
		}
	}
	return best;
}

module.exports = { DEFAULTS, prepare, stateAt, excessOf, startsOf, goalsOf, bfs, pathOf, join, tail, track, quickTails, searchStart, ctxKey, physKey, attemptOf, attemptJudge, carryOver };

// ---------------------------------------------------------------- workers
if (!isMainThread && workerData && workerData.skipfind) {
	const wd = workerData;
	if (wd.ticksBuf) E.setTickCounter(new BigInt64Array(wd.ticksBuf));
	// (--nice, Linux: this worker thread alone, like goexplore.js's workers next to the editor's GPU tools)
	if (wd.nice > 0 && process.platform === 'linux') { try { os.setPriority(0, Math.min(19, Math.round(wd.nice))); } catch (e) { /* as it is */ } }
	const level = wd.levelJson ? E.prepareLevel(JSON.parse(wd.levelJson)) : E.loadLevel(wd.levelFile);
	// (the lane: a run message says whether it is an attempt (Find a route before a route: its end state sooner) or a
	// finishing run; its nocoins too)
	const optsOf = (msg) => (msg && msg.attempt !== undefined ? Object.assign({}, wd.o, { attempt: !!msg.attempt, nocoins: msg.nocoins !== undefined ? msg.nocoins : wd.o.nocoins }) : wd.o);
	let info = wd.masks ? prepare(level, Uint8Array.from(wd.masks), optsOf(wd)) : null;
	let version = wd.version;
	parentPort.on('message', (msg) => {
		if (msg.run) { info = prepare(level, Uint8Array.from(msg.run), optsOf(msg)); version = msg.version; return; }
		if (msg.task) {
			const { s, pick } = msg.task;
			let r;
			// (a deep start: the coarse levels' sparse starts search deeper: --deepDepth layers, a 2^--deepLog2 table, --deepPerS seconds)
			const deep = msg.task.deep ? { depth: wd.o.deepDepth || DEFAULTS.deepDepth, log2: wd.o.deepLog2 || DEFAULTS.deepLog2, perS: wd.o.deepPerS || DEFAULTS.deepPerS } : {};
			// (the lane: an attempt's searches with the attempt cap, but from a landing after a long fall: the default cap
			// there (Egg Quest II's GPU random runs' route from its landing: the chimney line at 60,000, not at 30,000))
			const att = info && info.attempt && !msg.task.land ? { cap: wd.o.attemptCap || DEFAULTS.attemptCap } : {};
			try { r = searchStart(info, s, pick, Object.assign({}, wd.o, deep, att, { deadline: msg.deadline })); } catch (e) { r = { error: String(e && e.stack || e) }; }
			E.flushTicks();
			const out = Object.assign({ s, pick, version, h: info.H[s] }, r);
			if (r.best) out.best = { ms: Array.from(r.best.ms), saved: r.best.saved, runTicks: r.best.ev.runTicks, how: r.best.how, edge: r.best.edge, m: r.best.m, route: !!r.best.route };
			parentPort.postMessage(out);
		}
	});
}

// ---------------------------------------------------------------- the lane: Find a route's "path skips"
/**
 * The lane (--lane=1; editor.js strategy 'skips', "path skips"): the skip finder inside Find a route, a long-lived
 * process of --workers threads fed on stdin. Its target:
 *   - before any route: the searches' furthest attempts ("attempt:<search> <inputs>": each strategy's own nearest attempt,
 *     the newest per search, the searches in turn): the skip finder on the ATTEMPT (prepare's attempt mode: a later point
 *     of it reached sooner; a candidate must end in its end state, or the same physical state and room, sooner:
 *     attemptJudge), from its states in run order: every --laneStep ticks and every landing after a long fall (--laneAir
 *     ticks in the air) deep (--deepDepth layers), then every laneStep / 2 and / 4 at --depth; a start's goal window
 *     complete first (the attempt reaches s + depth + horizon). Why run order: a shortcut early on the attempts' common
 *     trunk helps every attempt that passes there, and the trunk's states are stable while the frontier's change every
 *     few seconds.
 *     Every shortened attempt is printed ({"ev":"shortcut"}: the editor imports it into the one search's archive, every
 *     cell along it with its earlier arrival) and kept in the library; the best leads of a search (a place the attempt
 *     reaches --leadMin+ ticks later, reached sooner) too ({"ev":"shortcut","kind":"lead"}: footholds);
 *   - once a route is known ("route <inputs>": the best route, any strategy's): the skip finder on the route (the same
 *     order), every faster route printed ({"ev":"result","kind":"finish"}) and searched on.
 * The library (every attempt, shortened attempt and route seen, newest --laneLib): a new target is first spliced with
 * it (the target reaches a state (its physical state and room) the library reached sooner: the library's inputs to there
 * + the target's from there, replayed and judged): a shortcut found on one attempt carries over at once to the newer
 * attempts of its lineage and to the routes that pass there.
 * usage: node src/skipfind.js --lane=1 --level=<level.eelvl | .json | level id> [--workers=2] [--seconds=3600]
 *        [--laneStep=200] [--laneLib=24] [--nice=0] (every DEFAULTS key); stdin: "attempt[:<search>] <inputs>", "route <inputs>",
 *        "stop" (its end stops it too); stdout: JSON lines {ev: start | shortcut | result | search | progress | done}
 */
const LANE_PER_S = 400;
async function lane(a) {
	const t0 = Date.now();
	// (EEAT_LANE_LOG=<file>: every event appended there too, the inputs left out: measurement scripts)
	const logFile = process.env.EEAT_LANE_LOG || '';
	const emit = (ev) => {
		const line = JSON.stringify(Object.assign({ t: Math.round((Date.now() - t0) / 100) / 10 }, ev));
		try { process.stdout.write(line + '\n'); } catch (e) { /* gone */ }
		if (logFile && ev.ev !== 'progress') { try { fs.appendFileSync(logFile, (ev.inputs ? JSON.stringify(Object.assign({ t: Math.round((Date.now() - t0) / 100) / 10 }, ev, { inputs: ev.inputs.length })) : line) + '\n'); } catch (e) { /* no log */ } }
	};
	// the level: the editor's .eelvl built as the editor builds it, as JSON for the workers (and coinsIrrelevant)
	// (no temp file: the editor kills the lane at the search's end)
	const levelJson = a.level && /\.eelvl$/i.test(a.level)
		? JSON.stringify(require('./eelvl.js').toSimLevel(require('./eelvl.js').readEelvl(fs.readFileSync(a.level)), { id: 'editor', file: 'editor.eelvl' }))
		: fs.readFileSync(C.levelData(a.level), 'utf8');
	const level = E.prepareLevel(JSON.parse(levelJson));
	/** common.js coinsIrrelevant on the level JSON (a fresh copy: it shuts the coin doors) */
	const coinsIrrelevant = (ms, ev) => {
		const L2 = E.prepareLevel(JSON.parse(levelJson));
		let doors = 0;
		for (let i = 0; i < L2.fg.length; i++) {
			const v = L2.fg[i];
			if (v === 43 || v === 213) { L2.lookup0[i] = 9999; doors++; } else if (v === 165 || v === 214) { L2.lookup0[i] = 0; doors++; }
		}
		if (doors === 0) return true;
		const r = C.replay(L2, ms);
		return r.complete === ev.complete && r.runTicks === ev.runTicks;
	};
	// (the lane's time per search: LANE_PER_S deep, LANE_PER_S / 2 else, unless given: its threads run beside the whole
	// search, at nice 10 on Linux; on the loaded EPYC a deep search reached 240-300 of its 450 layers in the default 170 s
	// of bfs, where Egg Quest II's chimney line joins the route after 441)
	const o = { deepPerS: LANE_PER_S, perS: LANE_PER_S / 2 };
	for (const k of Object.keys(DEFAULTS)) if (a[k] !== undefined) o[k] = Array.isArray(DEFAULTS[k]) ? String(a[k]).split(',').map(Number) : typeof DEFAULTS[k] === 'string' ? a[k] : +a[k];
	const P = Object.assign({}, DEFAULTS, o);
	const step = Math.max(10, +(a.laneStep || 200) | 0), libMax = Math.max(1, +(a.laneLib || 24) | 0), LAND_AIR = Math.max(1, +(a.laneAir || 90) | 0);
	const nw = Math.max(1, +(a.workers || 1) | 0);
	const deadlineAll = t0 + (+(a.seconds || 3600)) * 1000;
	const ticksBuf = new SharedArrayBuffer(8), ticksTotal = new BigInt64Array(ticksBuf);
	E.setTickCounter(ticksTotal);
	let target = null, version = 0, route = null, queue = [], ended = false;
	const done = new Set(), stateDone = new Set();
	const stats = { searches: 0, shortcuts: 0, splices: 0, leads: 0, routes: 0, attempts: 0 };
	// ---- the library: {ms, map: physical state + room key -> the earliest tick}
	const lib = [];
	const RK = roomKeyOf(level);
	const keyOf = (sim) => { const k = physKey(sim), r = RK(sim) >>> 0; return (k + r * 2654435761) % 9007199254740881; };
	/** a run's keys per tick 0..n (index t = after t inputs), up to its first death or finish */
	const keysOf = (ms) => {
		const sim = new E.EESim(level), inp = new E.EEInput();
		sim.reset();
		const K = new Float64Array(ms.length + 1);
		K[0] = keyOf(sim);
		for (let t = 0; t < ms.length; t++) {
			E.applyMask(inp, ms[t]);
			sim.tick(inp);
			if (sim.is_dead || sim.has_silver_crown) return K.subarray(0, t + 1);
			K[t + 1] = keyOf(sim);
		}
		return K;
	};
	// (skipAt: a shortened attempt's first tick off the attempt it shortened: its states from there on are the early ones)
	const libAdd = (ms, what, skipAt = -1) => {
		const K = keysOf(ms), map = new Map();
		for (let t = K.length - 1; t >= 0; t--) map.set(K[t], t);   // (the earliest tick of each key wins)
		lib.push({ ms: Uint8Array.from(ms), map, what, skipAt });
		if (lib.length > libMax) lib.shift();
	};
	const CROSS_LIB = 3;
	const libCross = (info) => carryOver(level, lib.filter((R) => R.skipAt >= 0).slice(-CROSS_LIB).reverse(), info, P);
	/**
	 * The target (masks; kind 'attempt' | 'route', ev the route's C.evaluate) spliced with the library: the best
	 * candidates by claimed gain (the library reaches the target's state at tick t by tick r < t), each replayed and
	 * judged; -> {ms, ev, saved, how, route} | null
	 */
	const libSplice = (ms, kind, ev) => {
		if (!lib.length) return null;
		const K = keysOf(ms), cands = [];
		for (const R of lib) {
			let bg = 0, br = -1, bt = -1;
			for (let t = K.length - 1; t > P.minGain; t--) {
				const r = R.map.get(K[t]);
				if (r !== undefined && t - r > bg) { bg = t - r; br = r; bt = t; }
			}
			if (bg >= P.minGain) cands.push({ R, r: br, t: bt, g: bg });
		}
		cands.sort((x, y) => y.g - x.g);
		let info = null;
		for (const c of cands.slice(0, 4)) {
			const cand = concat([c.R.ms.subarray(0, c.r), ms.subarray(c.t)]);
			if (kind === 'attempt') {
				if (!info) info = prepare(level, ms, { attempt: true, nocoins: 0 });
				if (!info || !info.attempt) return null;
				const v = attemptJudge(info, cand);
				if (v.accept) return { ms: v.ev.ms, ev: v.ev, saved: v.saved, route: v.route || null, how: `the library's ${c.R.what} to its tick ${c.r}, then the attempt's own from its tick ${c.t} (-${c.g})` };
			} else {
				const e2 = C.evaluate(level, cand);
				const v = C.judge(e2, ev, ev.deaths);
				if (v.accept && e2.runTicks < ev.runTicks) return { ms: e2.ms, ev: e2, saved: ev.runTicks - e2.runTicks, how: `the library's ${c.R.what} to its tick ${c.r}, then the route's own from its tick ${c.t}` };
			}
		}
		return null;
	};
	const str = (ms) => C.eetasBytes(ms).toString('latin1');
	// ---- the starts
	const depthOf = (deep) => (deep ? P.deepDepth : P.depth);
	// (a start's key: its state, its goal window's end state, the pick, deep, and whether it is an attempt's; searched
	// before by state (stateDone: another goal window) = searched again after every fresh start. Only a search whose goal
	// window was complete (the target reached s + depth + horizon) marks its state: Egg Quest II's GPU random runs' landing,
	// searched on their short early attempt, is fresh again on their route; an attempt's search (a smaller layer cap) does
	// not mark the state for the route's)
	const keyOfStart = (info, s, deep, pk) => `${info.H[s]}:${info.H[Math.min(info.n, s + depthOf(deep) + P.horizon)]}:${pk}:${deep ? 1 : 0}:${info.attempt ? 'a' : 'r'}`;
	const stateOfKey = (k) => { const q = k.split(':'); return `${q[0]}:${q[2]}:${q[3]}:${q[4]}`; };
	const picks = String(P.picks).split(',').filter(Boolean);
	let workers = [];
	const refill = () => {
		const info = target.info, n = info.n;
		const list = [];
		// run order: every step ticks and every landing after a long fall (LAND_AIR+ ticks in the air: where a path is
		// chosen, e.g. Egg Quest II's opening fall, after which the user's chimney climb starts) deep, then every step / 2
		// and step / 4 at the normal depth; an attempt's complete goal windows first (a route's too: the earliest first, as
		// Find a route hands its routes on at once). (The landings first, before the grid, kept the lane on a route's 17
		// landings, 150-270 s each on the loaded EPYC, where the grid's tick 200 found -54 in 3 s.)
		const lv = [step, Math.max(10, step >> 1), Math.max(10, step >> 2)], seen = new Set(), land = new Set();
		for (let t = 1, air = 0; t < n - P.minGain - 1; t++) {
			if (!info.OG[t]) { air++; continue; }
			if (air >= LAND_AIR) land.add(t);
			air = 0;
		}
		const ok = (s, deep, complete) => !seen.has(s) && !(target.kind === 'attempt' && s > n - depthOf(deep) / 2) &&
			!(target.kind === 'attempt' && (s + depthOf(deep) + P.horizon <= n) !== complete);
		for (const complete of [true, false]) {
			for (let li = 0; li < lv.length; li++) {
				const deep = li === 0;
				const ticks = [];
				for (let s = 0; s < n - P.minGain - 1; s += lv[li]) ticks.push(s);
				if (deep) { for (const t of land) ticks.push(t); ticks.sort((x, y) => x - y); }
				for (const s of ticks) {
					if (!ok(s, deep, complete)) continue;
					seen.add(s);
					list.push({ s, deep, land: land.has(s) });
				}
			}
		}
		const fresh = [], again = [];
		for (const x of list) for (const pk of picks) {
			const key = keyOfStart(info, x.s, x.deep, pk);
			if (done.has(key)) continue;
			(stateDone.has(stateOfKey(key)) ? again : fresh).push({ s: x.s, pick: pk, deep: x.deep, land: !!x.land, key, complete: target.kind === 'route' || x.s + depthOf(x.deep) + P.horizon <= n });
		}
		queue = fresh.concat(again);
	};
	const give = (w) => {
		if (ended || w.dead || !target || Date.now() > deadlineAll - 2000) return;
		while (queue.length && done.has(queue[0].key)) queue.shift();
		if (!queue.length) return;
		const task = queue.shift();
		done.add(task.key);
		if (task.complete) stateDone.add(stateOfKey(task.key));
		if (w.version !== target.version) { w.postMessage({ run: Array.from(target.ms), version: target.version, attempt: target.kind === 'attempt', nocoins: target.nc }); w.version = target.version; }
		w.busy = true; w.task = task; w.kind = target.kind; w.since = Date.now();
		w.postMessage({ task, deadline: deadlineAll });
	};
	const setTarget = (kind, ms, nc) => {
		const info = prepare(level, ms, { attempt: kind === 'attempt', nocoins: nc });
		if (!info || (kind === 'attempt') !== !!info.attempt) return false;
		target = { kind, ms: info.masks, info, nc, version: ++version };
		refill();
		for (const w of workers) if (!w.busy) give(w);
		return true;
	};
	// ---- a route (the editor's best, or one this lane found): judged, spliced with the library, the new target
	const offerRoute = (ms, how, own) => {
		const ev = C.evaluate(level, Uint8Array.from(ms));
		if (!ev) return false;
		// (the route itself again: only when the library makes it faster)
		const again = !!route && ev.ms.length === route.ev.ms.length && ev.runTicks === route.ev.runTicks;
		if (route && !again && !(C.judge(ev, route.ev, route.ev.deaths).accept && ev.runTicks < route.ev.runTicks)) return false;
		let best = ev, bhow = how;
		const sp = libSplice(ev.ms, 'route', ev);
		if (sp) { best = sp.ev; bhow = `${how}; spliced: ${sp.how}`; stats.splices++; }
		// (another lineage's route, the GPU random runs' above all: the library's shortened attempts carried over into it)
		const cx = libCross(prepare(level, best.ms, { nocoins: 0 }));
		if (cx) { best = cx.ev; bhow = `${bhow}; ${cx.how}`; stats.carries = (stats.carries || 0) + 1; }
		if (again && best === ev) return false;
		if ((own && !again) || best !== ev) {
			stats.routes++;
			emit({ ev: 'result', kind: 'finish', ticks: best.ms.length, runTicks: best.runTicks, time: C.fmt(best.runTicks), inputs: str(best.ms), how: bhow, saved: route ? route.ev.runTicks - best.runTicks : ev.runTicks - best.runTicks });
		}
		route = { ev: best };
		libAdd(best.ms, 'route');
		let nc = 0;
		try { nc = coinsIrrelevant(best.ms, best) ? 1 : 0; } catch (e) { /* exact */ }
		setTarget('route', best.ms, nc);
		return true;
	};
	// ---- an attempt (the editor's: each search's own nearest, "attempt:<search> <inputs>"; coalesced: the newest one per
	// search, the searches in turn, at most one every ATTEMPT_MS: each search's lineage is followed, as the first route can
	// come from any of them)
	const pending = new Map();
	let attemptTimer = null, attemptAt = 0, turn = 0;
	const ATTEMPT_MS = 1000, CROSS_MS = 5000;
	let crossAt = 0;
	const takeAttempt = () => {
		attemptTimer = null;
		const keys = [...pending.keys()];
		if (!keys.length || route || ended) return;
		const src = keys[turn++ % keys.length], ms0 = pending.get(src);
		pending.delete(src);
		if (pending.size) attemptTimer = setTimeout(takeAttempt, ATTEMPT_MS);
		attemptAt = Date.now();
		stats.attempts++;
		let ms = ms0;
		const sp = libSplice(ms0, 'attempt');
		if (sp && sp.route) { offerRoute(sp.ms, `a route: ${sp.how}`, true); return; }
		if (sp) { stats.splices++; stats.shortcuts++; ms = sp.ms; emit({ ev: 'shortcut', kind: 'splice', inputs: str(ms), ticks: ms.length, from: ms0.length, saved: sp.saved, how: sp.how }); }
		else if (Date.now() - crossAt >= CROSS_MS) {
			// (no state in common with the library: the carry-over to another lineage, at most every CROSS_MS)
			crossAt = Date.now();
			const info0 = prepare(level, ms0, { attempt: true, nocoins: 0 });
			const cx = info0 && info0.attempt ? libCross(info0) : null;
			if (cx) { stats.carries = (stats.carries || 0) + 1; stats.shortcuts++; ms = cx.ms; emit({ ev: 'shortcut', kind: 'carry', inputs: str(ms), ticks: ms.length, from: ms0.length, saved: cx.saved, how: cx.how }); }
		}
		if (setTarget('attempt', ms, 0)) libAdd(target.ms, 'attempt', ms !== ms0 ? 0 : -1);
	};
	const onAttempt = (ms, src) => {
		pending.set(src || '', ms);
		if (!attemptTimer) attemptTimer = setTimeout(takeAttempt, Math.max(0, ATTEMPT_MS - (Date.now() - attemptAt)));
	};
	// ---- the workers' results
	const onResult = (w, r) => {
		w.busy = false;
		stats.searches++;
		const kind = w.kind, cur = !!target && r.version === target.version;
		if (r.error) emit({ ev: 'search', s: r.s, error: String(r.error).slice(0, 300) });
		else emit({ ev: 'search', kind, s: r.s, pick: r.pick, deep: !!(w.task && w.task.deep), layers: r.stats.layers, cells: r.stats.cells, sec: Math.round(r.stats.ms / 100) / 10, hits: r.hits, top: r.top, saved: r.best ? r.best.saved : 0, cur });
		if (r.best && r.best.route) offerRoute(r.best.ms, `a route from the attempt's tick ${r.s}: ${r.best.how}`, true);
		else if (r.best && kind === 'route') {
			// a faster route (made on an older best: spliced with the current one)
			let ms = Uint8Array.from(r.best.ms), how = `skip from tick ${r.s}: ${r.best.how}`;
			if (!cur && route) {
				const sp = require('./splice.js').splice(level, [route.ev.ms, ms], !!(target && target.nc));
				if (sp) { const e2 = C.evaluate(level, sp.ms); if (e2 && C.judge(e2, route.ev, route.ev.deaths).accept && e2.runTicks < route.ev.runTicks) { ms = e2.ms; how += ' + spliced with the current route'; } }
			}
			// (the skip route into the library, its states from the skip on the early ones: made on an older best that
			// another strategy's route has beaten meanwhile, it is carried over into the current one)
			libAdd(Uint8Array.from(r.best.ms), `skip route (from its tick ${r.s})`, r.s);
			if (!offerRoute(ms, how, true) && route) offerRoute(route.ev.ms, 'the best route', true);
		} else if (r.best && kind === 'attempt' && route) {
			// (an attempt's search that ended after the first route: its shortened attempt into the library, and from there
			// spliced or carried over into the route)
			libAdd(Uint8Array.from(r.best.ms), `shortened attempt (from its tick ${r.s})`, r.s);
			offerRoute(route.ev.ms, 'the best route', true);
		} else if (r.best && kind === 'attempt' && !route) {
			// a shortened attempt: to the one search's archive and the library; the current attempt spliced with it
			const ms = Uint8Array.from(r.best.ms);
			stats.shortcuts++;
			emit({ ev: 'shortcut', kind: 'skip', inputs: str(ms), ticks: ms.length, saved: r.best.saved, s: r.s, how: r.best.how, cur });
			libAdd(ms, `shortened attempt (from its tick ${r.s})`, r.s);
			if (target && target.kind === 'attempt') {
				const base = target.ms, sp = cur ? { ms, saved: r.best.saved } : libSplice(base, 'attempt');
				if (sp && sp.route) offerRoute(sp.ms, `a route: ${sp.how}`, true);
				else if (sp) {
					if (!cur) { stats.splices++; emit({ ev: 'shortcut', kind: 'splice', inputs: str(sp.ms), ticks: sp.ms.length, from: base.length, saved: sp.saved, how: sp.how }); }
					if (setTarget('attempt', sp.ms, 0)) libAdd(target.ms, 'attempt', cur ? r.s : 0);
				}
			}
		}
		// (an attempt's best leads: footholds for the one search's archive)
		if (!r.error && kind === 'attempt' && !route && Array.isArray(r.leadRuns)) {
			for (const x of r.leadRuns) { stats.leads++; emit({ ev: 'shortcut', kind: 'lead', inputs: str(Uint8Array.from(x.ms)), ticks: x.ms.length, gain: x.gain, j: x.j, tile: x.tile, s: r.s }); }
		}
		give(w);
	};
	const perWorkerMB = (2 ** Math.max(P.log2, P.deepLog2) * 8) / 1048576 + 700;
	const memW = Math.max(1, Math.floor((os.freemem() / 1048576) * 0.5 / perWorkerMB));
	const nWorkers = Math.max(1, Math.min(nw, memW));
	for (let k = 0; k < nWorkers; k++) {
		const w = new Worker(__filename, { workerData: { skipfind: true, levelJson, masks: null, o: Object.assign({}, o), version: 0, ticksBuf, nice: +(a.nice || 0) } });
		w.version = 0; w.busy = false;
		w.on('message', (r) => onResult(w, r));
		w.on('error', (e) => { emit({ ev: 'warning', text: `a worker failed: ${String(e && e.message || e).slice(0, 300)}` }); w.busy = false; w.dead = true; });
		workers.push(w);
	}
	emit({ ev: 'start', workers: nWorkers, memWorkers: memW, step, level: `${level.width}x${level.height}` });
	// ---- the end, the progress, stdin: attempt / route / stop
	let prog = null;
	const end = (why) => {
		if (ended) return;
		ended = true;
		if (prog) clearInterval(prog);
		for (const w of workers) { try { w.terminate(); } catch (e) { /* gone */ } }
		E.flushTicks();
		emit({ ev: 'done', why, searches: stats.searches, shortcuts: stats.shortcuts, splices: stats.splices, carries: stats.carries || 0, routes: stats.routes, leads: stats.leads, attempts: stats.attempts, ticks: Number(Atomics.load(ticksTotal, 0)) });
		setTimeout(() => process.exit(0), 50);
	};
	let lastTicks = 0, lastAt = Date.now();
	prog = setInterval(() => {
		if (Date.now() > deadlineAll) { end('time'); return; }
		E.flushTicks();
		const tk = Number(Atomics.load(ticksTotal, 0)), now = Date.now();
		const tps = Math.round((tk - lastTicks) / Math.max(0.001, (now - lastAt) / 1000));
		lastTicks = tk; lastAt = now;
		emit({ ev: 'progress', target: target ? target.kind : null, n: target ? target.info.n : 0, running: workers.filter((w) => w.busy).length, queue: queue.length, searches: stats.searches,
			shortcuts: stats.shortcuts, splices: stats.splices, routes: stats.routes, leads: stats.leads, lib: lib.length, ticks: tk, ticksPerSec: tps, workers: nWorkers });
		for (const w of workers) if (!w.busy) give(w);
	}, 2000);
	let buf = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (d) => {
		buf += d;
		let k;
		while ((k = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, k).trim();
			buf = buf.slice(k + 1);
			if (line === 'stop') { end('stopped'); return; }
			const m = /^(attempt|route)(?::(\w+))? ([0-O]+)$/.exec(line);
			if (!m) continue;
			const ms = Uint8Array.from(m[3], (c) => (c.charCodeAt(0) - 48) & 31);
			if (m[1] === 'route') offerRoute(ms, 'the best route', false);
			else onAttempt(ms, m[2]);
		}
	});
	process.stdin.on('end', () => end('stdin'));
	process.stdin.on('error', () => end('stdin'));
}

// ---------------------------------------------------------------- the command line
async function main() {
	const a = C.parseArgs(process.argv.slice(2));
	if (a.lane) return lane(a);
	if (!a.tas) { console.log('usage: node src/skipfind.js --tas=<run.eetas> [--level=<level id | job id | .json>] [--out=] [--seconds=600] [--workers=N] (see the header)'); process.exit(2); }
	const levelFile = C.levelData(a.level, a.tas);
	const level = E.loadLevel(levelFile);
	const masks0 = C.readEetas(a.tas);
	const o = {};
	for (const k of Object.keys(DEFAULTS)) if (a[k] !== undefined) o[k] = Array.isArray(DEFAULTS[k]) ? String(a[k]).split(',').map(Number) : typeof DEFAULTS[k] === 'string' ? a[k] : +a[k];
	for (const k of ['from', 'to']) if (a[k] !== undefined) o[k] = +a[k];
	if (a.starts) o.starts = String(a.starts).split(',').map(Number);
	// --targets=<run.eetas,...>: other runs of the level whose states are joins too (the grind: the job's earlier bests)
	if (a.targets) o.targets = String(a.targets).split(',').filter((f) => f && fs.existsSync(f)).map((f) => Array.from(C.readEetas(f)));
	const ev0 = C.evaluate(level, masks0);
	if (!ev0) { console.log(JSON.stringify({ error: 'the run does not finish the level' })); process.exit(1); }
	o.nocoins = a.nocoins === undefined || a.nocoins === 'auto' ? (C.coinsIrrelevant(levelFile, ev0.ms, ev0) ? 1 : 0) : +a.nocoins;
	const seconds = +(a.seconds || 600);
	// the workers: as asked, at most what half of the free memory holds (a worker: its cell table, 2^log2 x 8 bytes, + ~700 MB of
	// layers and snapshots at the default cap: one Egg Quest II search, 1,041 MB RSS, heap 659 MB, array buffers 212 MB)
	const perWorkerMB = (2 ** Math.max(o.log2 || DEFAULTS.log2, o.deepLog2 || DEFAULTS.deepLog2) * 8) / 1048576 + 700;
	const memW = Math.max(1, Math.floor((os.freemem() / 1048576) * 0.5 / perWorkerMB));
	const nw = Math.max(1, Math.min(memW, +(a.workers || Math.max(1, os.cpus().length - 2))));
	const out = a.out ? path.resolve(a.out) : path.join(C.SRC, 'out', 'skipfind_best.eetas');
	const picks = String(o.picks || DEFAULTS.picks).split(',').filter(Boolean);
	const t0 = Date.now();
	const deadlineAll = Math.min(t0 + seconds * 1000, a.deadline ? +a.deadline : Infinity);
	const meter = C.tickMeter();
	const emit = (ev) => console.log(JSON.stringify(Object.assign({ t: Math.round((Date.now() - t0) / 100) / 10 }, ev)));
	let info = prepare(level, ev0.ms, o);
	let bestMs = info.masks, bestEv = info.ev, version = 1;
	const startEv = bestEv;
	// the searches done: (the start's state, the goal window's end state, the pick); with --done=<file> kept across calls
	// (the grind's stage continues its pass where the last one stopped: a start is searched again only when its state or
	// the run over its goal window changed)
	const P = Object.assign({}, DEFAULTS, o);
	// deep starts: in the coarse order the starts at multiples of --deepEvery x --every (the 8x and 4x levels by default:
	// sparse, so each searches deeper; Egg Quest II's base route: the chimney from t600 needs ~350 layers)
	const isDeep = (s) => P.order === 'coarse' && P.deepEvery > 0 && s % (P.deepEvery * Math.max(1, P.every | 0)) === 0;
	const depthOf = (s) => (isDeep(s) ? P.deepDepth : P.depth);
	const keyOf = (s, pk) => `${info.H[s]}:${info.H[Math.min(info.n, s + depthOf(s) + P.horizon)]}:${pk}`;
	const done = new Set();
	const doneFile = a.done ? path.resolve(a.done) : null;
	if (doneFile) { try { for (const l of fs.readFileSync(doneFile, 'utf8').split('\n')) if (l) done.add(l); } catch (e) { /* none yet */ } }
	// the queue: the starts whose state was never searched first (in startsOf's order), then the ones searched before whose
	// goal window changed since (a find elsewhere): with finds spread over a run, re-searching the coarse levels' starts
	// first kept Egg Quest II's base-route pass from ever reaching t600 (the chimney) in 25 min
	const stateOfKey = (k) => { const q = k.split(':'); return `${q[0]}:${q[2]}`; };
	const stateDone = new Set([...done].map(stateOfKey));
	const markDone = (key) => { done.add(key); stateDone.add(stateOfKey(key)); if (doneFile) { try { fs.appendFileSync(doneFile, key + '\n'); } catch (e) { /* ignore */ } } };
	let queue = [];
	const refill = () => {
		const st = startsOf(info, o);
		const fresh = [], again = [];
		for (const s of st) for (const pk of picks) {
			const key = keyOf(s, pk);
			if (done.has(key)) continue;
			(stateDone.has(stateOfKey(key)) ? again : fresh).push({ s, pick: pk, key, deep: isDeep(s) });
		}
		queue = fresh.concat(again);
	};
	refill();
	emit({ ev: 'start', n: info.n, runTicks: bestEv.runTicks, nocoins: o.nocoins, clockblind: info.cb, workers: nw, memWorkers: memW, tasks: queue.length, searched: done.size, picks });
	let finds = 0, searches = 0;
	const workers = [];
	/** a candidate run (full masks) judged against the current best; accepted: the new best, the workers told */
	const offer = (ms0, how, meta, oldVersion) => {
		let ms = Uint8Array.from(ms0);
		let ev = C.evaluate(level, ms);
		let v = C.judge(ev, bestEv, startEv.deaths);
		if (!(v.accept && ev && ev.runTicks < bestEv.runTicks) && oldVersion !== version && ev) {
			// made on an older run: spliced with the current one
			const sp = require('./splice.js').splice(level, [bestMs, ms], !!o.nocoins);
			if (sp) { const e2 = C.evaluate(level, sp.ms); const v2 = C.judge(e2, bestEv, startEv.deaths); if (v2.accept && e2.runTicks < bestEv.runTicks) { ms = e2.ms; ev = e2; v = v2; how += ' + spliced with the current run'; } }
		}
		if (!(v.accept && ev.runTicks < bestEv.runTicks)) return false;
		finds++;
		const saved = bestEv.runTicks - ev.runTicks;
		bestMs = ev.ms; bestEv = ev; version++;
		C.writeEetas(out, bestMs);
		emit(Object.assign({ ev: 'skip' }, meta, { saved, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how, total: startEv.runTicks - ev.runTicks }));
		info = prepare(level, bestMs, o);
		for (const x of workers) x.postMessage({ run: Array.from(bestMs), version });
		refill();
		return true;
	};
	// the finisher (--gpu=1): leads no CPU join closed, the biggest gains first, one per run stretch and run version: every
	// move from the lead to the trophy on the GPU (eegpu explore --prefix --finish=1: exhaustive at the --gpuCq* grain,
	// ordered by the reach field), bounded by the run's own finish (a finish counts only when it is faster); each finish
	// replayed and judged. One lane: --gpuS seconds a lead.
	const G = require('./gpu.js');
	const tool = a.gpu === '1' ? (a.tool ? path.resolve(a.tool) : G.nativeTool()) : null;
	const gpu = { q: [], seen: new Set(), busy: false, runs: 0, finds: 0, files: null, child: null };
	if (a.gpu === '1' && !tool) emit({ ev: 'gpu', error: 'no native tool (node tools/build-native.js)' });
	if (tool && G.unsupported(level)) { emit({ ev: 'gpu', error: G.unsupported(level) }); }
	const gpuOn = !!tool && !G.unsupported(level);
	const gpuFiles = () => {
		if (gpu.files) return gpu.files;
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-skipfind-'));
		const blob = G.levelBlob(level);
		const f = { work, bin: path.join(work, 'level.bin'), reach: '', prefix: path.join(work, 'prefix.eetas'), stop: path.join(work, 'stop') };
		fs.writeFileSync(f.bin, blob);
		try { const RF = require('./reach.js'); const field = RF.reachField(level, {}); fs.writeFileSync(path.join(work, 'reach.bin'), RF.reachFileBytes(field, G.blobFp(blob))); f.reach = path.join(work, 'reach.bin'); } catch (e) { /* unordered */ }
		gpu.files = f;
		return f;
	};
	const gpuPump = (onIdle) => {
		if (!gpuOn || gpu.busy || !gpu.q.length || Date.now() > deadlineAll - (P.gpuS + 5) * 1000) { if (!gpu.busy && onIdle) onIdle(); return; }
		gpu.q.sort((x, y) => y.gain - x.gain);
		const job = gpu.q.shift();
		if (job.version !== version) { gpuPump(onIdle); return; }
		gpu.busy = true;
		const f = gpuFiles();
		C.writeEetas(f.prefix, job.prefix);
		try { fs.unlinkSync(f.stop); } catch (e) { /* none */ }
		// mode: rejoin (a state equal to the run's, --rejoin=1 against the run: the rest of the run as it is) or finish
		const mode = job.mode;
		const depth = mode === 'rejoin' ? P.gpuRejoinDepth : Math.max(1, info.n - P.minGain - job.prefix.length);
		if (mode === 'rejoin') C.writeEetas(path.join(f.work, 'run.eetas'), bestMs);
		const args = ['explore', f.bin, mode === 'rejoin' ? path.join(f.work, 'run.eetas') : '-', `--prefix=${f.prefix}`,
			...(mode === 'rejoin' ? [`--from=${job.prefix.length}`, '--rejoin=1', `--nocoins=${o.nocoins ? 1 : 0}`, `--gain=${P.minGain}`] : ['--finish=1']),
			'--discrete=1', `--depth=${depth}`, `--seconds=${P.gpuS}`, '--coarse=0',
			`--cqx=${P.gpuCqx}`, `--cqv=${P.gpuCqv}`, `--qy=${P.gpuQy}`, `--qvy=${P.gpuQvy}`, `--cells=${P.gpuCells}`, `--cap=${P.gpuCap}`,
			...(f.reach ? [`--reach=${f.reach}`, `--prune=${mode === 'rejoin' ? 0 : 1}`] : []), `--stopfile=${f.stop}`, `--parent=${process.pid}`, ...(a.cachedir ? [`--cachedir=${a.cachedir}`] : G.cacheArgs())];
		const t1 = Date.now();
		let buf = '', done = null, err = '', hits = 0, got = false;
		const ch = require('child_process').spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
		gpu.child = ch;
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let e;
				try { e = JSON.parse(line); } catch (x) { continue; }
				if (e.ev === 'hit' && e.inputs && !got && mode === 'finish') {
					hits++;
					const ms = Uint8Array.from(String(e.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
					if (offer(ms, `finish from the lead on the GPU (path ${job.d} ticks from ${job.s} to a place the run reaches at ${job.j}, then ${ms.length - job.prefix.length} ticks of every move to the trophy)`,
						{ s: job.s, pick: 'gpu', edge: ms.length - job.s, m: info.n }, job.version)) { gpu.finds++; got = true; try { fs.writeFileSync(f.stop, '1'); } catch (x) { /* gone */ } }
				} else if (e.ev === 'rejoin' && e.inputs && !got && mode === 'rejoin') {
					hits++;
					const pre2 = Uint8Array.from(String(e.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
					const ms = concat([pre2, bestMs.subarray(e.j, bestMs.length)]);
					if (offer(ms, `exact rejoin on the GPU (path ${job.d} ticks from ${job.s} to a place the run reaches at ${job.j}, then ${pre2.length - job.prefix.length} ticks of every move to the run's state at ${e.j})`,
						{ s: job.s, pick: 'gpu', edge: pre2.length - job.s, m: e.j }, job.version)) { gpu.finds++; got = true; try { fs.writeFileSync(f.stop, '1'); } catch (x) { /* gone */ } }
				} else if (e.ev === 'done') done = e;
				else if (e.error) err = String(e.error);
			}
		});
		ch.stderr.on('data', (d) => { err = (err + d).slice(-300); });
		ch.on('error', (e) => { err = e.message; });
		ch.on('close', () => {
			gpu.busy = false; gpu.child = null; gpu.runs++;
			emit({ ev: 'gpu', mode, s: job.s, j: job.j, gain: Math.round(job.gain), depth, hits, found: got, end: done ? done.end : `failed: ${err.trim().split('\n').pop()}`, layers: done ? done.layers : 0,
				sec: Math.round((Date.now() - t1) / 100) / 10 });
			gpuPump(onIdle);
			if (!gpu.busy && gpu.onIdle) gpu.onIdle();
		});
	};
	await new Promise((resolve) => {
		let busy = 0, ended = false;
		const finish = () => { if (!ended && busy === 0 && !gpu.busy && (!gpuOn || !gpu.q.length || Date.now() > deadlineAll - (P.gpuS + 5) * 1000)) { ended = true; resolve(); } };
		gpu.onIdle = () => { if (!queue.length || Date.now() > deadlineAll - 2000) finish(); };
		const give = (w) => {
			while (queue.length && done.has(queue[0].key)) queue.shift();
			if (!queue.length || Date.now() > deadlineAll - 2000) { finish(); return; }
			const task = queue.shift();
			done.add(task.key);
			w.busy = true; busy++;
			w.task = task;
			w.postMessage({ task, deadline: deadlineAll });
		};
		for (let k = 0; k < nw; k++) {
			const w = new Worker(__filename, { workerData: { skipfind: true, levelFile, masks: Array.from(bestMs), o, version, ticksBuf: meter.buf } });
			w.on('message', (r) => {
				w.busy = false; busy--;
				searches++;
				// (a search the deadline cut short is not remembered as done: the next call does it again)
				if (w.task && !r.error && !(r.stats && r.stats.time)) markDone(w.task.key);
				if (r.error) emit({ ev: 'search', s: r.s, pick: r.pick, error: r.error });
				else emit({ ev: 'search', s: r.s, pick: r.pick, layers: r.stats.layers, cells: r.stats.cells, peak: r.stats.peak, cut: r.stats.cut, full: r.stats.full, time: r.stats.time, hits: r.hits, rejoins: r.rejoins,
					joined: r.leadsJoined, joinBfs: r.joinBfs, cands: r.cands, tried: r.tried, top: r.top, sec: Math.round(r.stats.ms / 100) / 10, bfsSec: Math.round(r.stats.bfsMs / 100) / 10,
					tailsSec: Math.round(r.stats.tailsMs / 100) / 10, joinSec: Math.round(r.stats.joinMs / 100) / 10, saved: r.best ? r.best.saved : 0 });
				if (r.best) offer(r.best.ms, r.best.how, { s: r.s, pick: r.pick, edge: r.best.edge, m: r.best.m }, r.version);
				else if (gpuOn && r.unjoined && r.version === version) {
					for (const u of r.unjoined) {
						const key = `${version}:${info.seg[u.j]}`;
						if (gpu.seen.has(key)) continue;
						gpu.seen.add(key);
						const prefix = concat([bestMs.subarray(0, r.s), Uint8Array.from(u.P)]);
						String(P.gpuModes).split(',').filter(Boolean).forEach((mode, k) => gpu.q.push({ s: r.s, d: u.d, j: u.j, gain: u.gain - k * 0.5, version, prefix, mode }));
					}
					gpuPump(null);
				}
				give(w);
			});
			w.on('error', (e) => { emit({ ev: 'error', error: String(e && e.stack || e) }); w.busy = false; busy = Math.max(0, busy - 1); finish(); });
			workers.push(w);
		}
		for (const w of workers) give(w);
	});
	for (const w of workers) w.terminate();
	if (gpu.files) { try { fs.rmSync(gpu.files.work, { recursive: true, force: true }); } catch (e) { /* busy */ } }
	meter.stop();
	emit({ ev: 'done', searches, finds, gpuRuns: gpu.runs, gpuFinds: gpu.finds, runTicks: bestEv.runTicks, saved: startEv.runTicks - bestEv.runTicks, left: queue.length, sec: Math.round((Date.now() - t0) / 1000) });
	process.exit(finds ? 0 : 1);
}
if (isMainThread && require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
