'use strict';
// THE EXECUTOR (n4plan, the compiler's MOVES stage, part 'executor'): from REAL engine states (Arrivals) to a waypoint
// (types.js Waypoint: a trigger touched with its Expect, a region, the trophy), with legs PROVEN optimal where the exact
// search finishes; the compiler's code generation. No search tool of the old paradigm (goexplore, bursts, heat, eegpu):
// every leg is the engine's own simulation, every arrival replayed from the level start before it is returned.
//
//   exec = await createExecutor(L, {file, workers, prims, bounds, model, RM, emit, seed}) ->
//     {reach(starts, wp, budget) -> Promise<StepResult>, polish(masks, o) -> Promise<{masks, runTicks, saved, legs}>,
//      stats(), close()}
//
// reach(): the tiers (the budget: {ms, level (the rung 0..3), k (arrivals, default 4), stop, deadline}; it returns
// within budget.ms + 200 ms ALWAYS: the worker's own clock stops at the deadline less a margin, and a watchdog answers
// 'budget' and replaces the worker when it does not):
//   0. the proof pre-check: the RCH3 field of the level as the doors stand at each start (types.js levelNow + goalField,
//      physics mode only) -1 at EVERY start = a proof that the goal cannot be reached while the doors stay as they are
//      (fail 'proof', blockedBy = the shut gates the all-open field's way crosses);
//   0b. (OPT-IN, EEAT_NEAR=1) the exact end search: solveExact from a near start alone (the relay) and from this call's
//      own nearest state and its ancestors (tier 0b below: measured, no gain on the near-miss levels);
//   1. the primitives (opts.prims: prims.route) when given;
//   2. EXACT (exact.js solveExact): the breadth-first branch and bound over absolute ticks from every start (exact dedup,
//      the admissible bound, deaths dropped unless wp.allowDeath, the -1 cut, the monotone counter cut, a jump that
//      cannot jump not simulated): the first goal = the proven minimum; 35% of the window where the goal can be within
//      40 ticks, else 12% (a lower bound);
//   3. LEG (legs.js): the finders, not proofs: legBest (the default) a best-first search (f = tick + 5 x the goal field's
//      distance at the running pace, or the primitives' tick field when opts.bounds is given) over cells (2 px, 4 px, 1/8,
//      1/4 px/tick, the door-reading state: the first arrival closes a cell; a run out of open states again on finer
//      cells); legBFS (EEAT_EXEC_LEG=beam; 'mix': best-first then the beam bounded by it) a time-layered widening beam;
//   3b. the tightening: best-first again (w 3, the kinematic bound in its ranking) for legs shorter than the one found,
//      half of what is left; then polish.js polishLeg (the mutation pass on the leg, exact windows from its end);
//   2b. EXACT again with the leg's ticks as the budget (maxDepth = its absolute tick - 1): a shorter leg (proven the
//      minimum) or a proof that the leg is optimal;
//   the goal states of the successful tier (up to 4 k) -> T.pickDiverse (the earliest, the fastest, one per class).
//   Every leg found is taught to the primitives (prims.learn) when they exist. On failure a FailReport from the nearest
//   state any tier saw (the goal field's distance): why, closest {masks, tile, dist, vx, vy}, touched (the triggers its
//   way touched), blockedBy (shut gates within 2 tiles of it on the all-open field's way), level.
// WORKERS: every reach() / polish() runs in a worker thread (execworker.js; opts.workers, default min(4, cpus - 1),
// workers 0 = in-process); each worker loads the level once from opts.file and must replay a fixed input sequence to the
// same state hashes as this thread's L (else the executor runs in-process); arrivals cross threads as mask strings and
// are rebuilt (replayed, verified, T.arrivalOf with opts.RM) in this thread.
const os = require('os');
const path = require('path');
const E = require('../eesim.js');
const RF = require('../reach.js');
const T = require('./types.js');
const X = require('./exact.js');
const LG = require('./legs.js');

const X_NEAR = +process.env.EEAT_X_NEAR || 40;   // ticks: the exact tier's full share only where the goal can be this near
const X_SHARE_NEAR = +process.env.EEAT_X_SHARE_NEAR || 0.35, X_SHARE_FAR = +process.env.EEAT_X_SHARE_FAR || 0.12;   // (env: measurements)
// the exact end search (tier 0b, OPT-IN: EEAT_NEAR=1): starts within NEAR_T tiles of the goal (the goal field's unit,
// the FailReport's), its share NEAR_F of the window, the NEAR_STARTS nearest, each from its own state and NEAR_BACK ticks
// back, NEAR_CAP open states a layer (env: measurements)
const NEAR_ON = () => process.env.EEAT_NEAR === '1';
const ORD_FORCED = () => process.env.EEAT_ORD_FORCED === '1';   // (a measurement: the finders' ordering field, tier 3)
const NEAR_T = +process.env.EEAT_NEAR_T || 6, NEAR_F = +process.env.EEAT_NEAR_F || 0.35, NEAR_STARTS = 2, NEAR_CAP = 200000;
const NEAR_RES = process.env.EEAT_NEAR_RES !== undefined ? +process.env.EEAT_NEAR_RES : 0.12;   // the finders' window kept for it
const NEAR_BACK = (process.env.EEAT_NEAR_BACK || '0,10,24').split(',').map(Number).filter((x) => x >= 0);
const VERIFY_MARGIN_MS = 60;    // the worker's clock ends this much before the deadline (this thread's replays)
const WATCHDOG_MS = 150;        // past the deadline + this, an unanswered worker call is answered 'budget'
// (the late worker keeps its slot and its memos until it answers; replaced only when silent this long past the deadline;
// EEAT_WORKER_KEEP=0: the old rule, a late worker terminated and replaced at once)
const WORKER_HANG_MS = +process.env.EEAT_WORKER_HANG_MS || 30000;
const WORKER_KEEP = process.env.EEAT_WORKER_KEEP !== '0';
// the primitives tier's share of a reach window (rung 0 / rung 1 on; env: measurements)
const PRIMS_SHARE = process.env.EEAT_PRIMS_SHARE !== undefined ? +process.env.EEAT_PRIMS_SHARE : 0.5;
const PRIMS_SHARE_HI = process.env.EEAT_PRIMS_SHARE_HI !== undefined ? +process.env.EEAT_PRIMS_SHARE_HI : 0.2;
const REPLAY_CACHE = 64;
const K_DEFAULT = 4;
// the best-first search's cells after one that ran out of open states: finer vy, then everything 2x, then 4x
const LADDER = [[0.5, 0.25, 8, 2], [1, 0.5, 16, 8], [2, 1, 32, 16]];
// the COARSE GRAIN first from rung COARSE_RUNG on: a leg the default cells did not find at rung 0 gets the best-first
// search on cells of coarse speed (1/2 px/tick vx, 1 px/tick vy; the position as the default's) for COARSE_SHARE of
// the finders' window, then the default cells (and their ladder) the rest; a leg it finds is tightened on the default
// cells as before. The default's fine speeds make a long leg's arrivals near-copies of one trajectory (a 400-600-tick
// leg: millions of pops within 10 tiles); the coarse ones spread the pops over the positions. In-process, box 3, 10 s,
// rung 1, the first two root edges of the 16 L3 FIRST-LEG levels (32 legs): coarse cells alone 6 found vs the default's 3
// (MMBA Skull Citadel's blue key 510 ticks, Polar Eclipse's team 582 / coin 438), every leg the default found too; the
// speed coarse inside fields alone (legs.js fieldCell) 3. EEAT_COARSE_SHARE (0 off), EEAT_COARSE_RUNG.
const COARSE_CELL = [0.5, 0.25, 2, 1];
const COARSE_SHARE = process.env.EEAT_COARSE_SHARE !== undefined ? +process.env.EEAT_COARSE_SHARE : 0.5;
const COARSE_RUNG = process.env.EEAT_COARSE_RUNG !== undefined ? +process.env.EEAT_COARSE_RUNG : 1;
const LEG_MODE = () => { const m = String(process.env.EEAT_EXEC_LEG || 'best'); return m === 'beam' || m === 'mix' ? m : 'best'; };
const BASE_FEATS = ['key0', 'key1', 'key2', 'key3', 'key4', 'key5', 'team', 'coins', 'bcoins', 'crown', 'silver', 'deaths', 'cp', 'fx', 'prot'];

// ---- THE COUNTEREXAMPLE WALLS (COMPILE-ALL lane 1, block 2): the goal field is a sound RELAXATION of the physics, so it is
// optimistic: on a one-leg level whose real way is a detour (Unforgiving Climb: the trophy field reads 53 tiles at the top
// conveyor's end (127, 2), the relaxation's way down through the up arrows into the dot room is no way the engine takes,
// the known route rides down the right shaft where the field reads 538 and climbs the whole level) every search ordered by
// it, and every level-set descent (the skeleton), stops at that false near (legBest EXHAUSTED its region there: 586 k pops,
// closest 52 tiles). A leg search that exhausted its region is a counterexample to the field's way: the tiles the field
// ranks below every tile the search reached (the least field cost of any state centred there), within WALL_RING tiles of
// a reached tile, in the search's region and never reached, are the relaxation's false passages out of the reached set:
// they become walls of the ORDERING fields of that waypoint's field tiles (the executor's goal field, the finders' bounds
// field, the primitives' guide; never the exact tier's cut field or a proof: a walled leg's failure is 'budget'), so the
// next calls for the same field (the next rung, the skeleton's sub-legs, a relay start) order by a field that routes around
// them. Ordering and search region only: every arrival is the engine's own replay, verified as before.
// EEAT_WALLS=0: off (the fields as before, byte for byte).
const WALLS_ON = process.env.EEAT_WALLS !== '0';
// (the trophy's field only by default: its one-leg levels are the false nears' class; on the coin legs of PARTIAL levels the
// walls cost progress: MIHB's Dream gain 11 -> 6 and 9 -> 5 in two pairs; EEAT_WALLS=all: every waypoint's field)
const WALLS_ALL = process.env.EEAT_WALLS === 'all';
const WALL_RING = +process.env.EEAT_WALL_RING > 0 ? +process.env.EEAT_WALL_RING : 2;
const WALL_RING_MAX = 6;
const WALLS_MAX = 60000;
const WALL_POPS = +process.env.EEAT_WALL_POPS > 0 ? +process.env.EEAT_WALL_POPS : 100000;
const WALL_PLATEAU = +process.env.EEAT_WALL_PLATEAU > 0 ? +process.env.EEAT_WALL_PLATEAU : 0.5;
const WALL_NEAR = 3;
const PORTAL_IDS = new Set([242, 381, 374]);
/** a level copy with the counterexample walls (tiles) made plain solids (9, as levelNow's shut doors): ordering only */
function withWalls(Lc, walls) {
	if (!walls || !walls.length) return Lc;
	const fg = Lc.fg.slice();
	for (const t of walls) if (t >= 0 && t < fg.length) fg[t] = 9;
	return Object.assign({}, Lc, { fg });
}
const tileMinMemo0 = new WeakMap();
/** per tile the least cost (fifths) of any ball state centred on it by the goal field f (walk mode: its walk); CUT none */
function tileMinOf(f) {
	let m = tileMinMemo0.get(f);
	if (m) return m;
	const N = f.W * f.H, CUT = RF.CUT;
	m = new Uint32Array(N).fill(CUT);
	if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) m[t] = f.walk ? f.walk[t] : CUT; }
	else {
		const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
		for (let t = 0; t < N; t++) {
			let v = CUT;
			for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
			for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
			const rc = f.rowC[t], rx = f.rowX[t];
			if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
			if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
			m[t] = v;
		}
	}
	tileMinMemo0.set(f, m);
	return m;
}
/** the counterexample walls of an exhausted leg search: the unreached tiles of its region within WALL_RING of a reached
 *  one that the field f ranks below every reached tile (not a goal / field tile, not a portal, not already solid in f) */
function wallsOf(L, f, vis, region, goal) {
	const W = L.width, H = L.height, N = W * H, CUT = RF.CUT;
	const tm = tileMinOf(f);
	let cmin = CUT, nv = 0;
	for (let t = 0; t < N; t++) if (vis[t]) { nv++; if (tm[t] < cmin) cmin = tm[t]; }
	if (!nv || cmin >= CUT || cmin === 0) return [];
	const keep = new Uint8Array(N);
	for (const t of goal.tiles) if (t >= 0 && t < N) keep[t] = 1;
	for (const t of T.fieldTilesOf(goal)) if (t >= 0 && t < N) keep[t] = 1;
	// (the ring widens, up to WALL_RING_MAX, while it finds no tile: the relaxation's way may leave the reached tiles by a
	// flight over a gap wider than the ring; tabu tiles (walls that once cut every start off) never)
	const tabu = goal.tabu || null;
	for (let R = WALL_RING; R <= WALL_RING_MAX; R++) {
		const out = [], seen = new Uint8Array(N);
		for (let t = 0; t < N; t++) {
			if (!vis[t]) continue;
			const x = t % W, y = (t / W) | 0;
			for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const u = yy * W + xx;
				if (seen[u] || vis[u] || keep[u] || tm[u] >= cmin) continue;
				if (region && !region[u]) continue;
				if (PORTAL_IDS.has(L.fg[u]) || (tabu && tabu.has(u))) continue;
				seen[u] = 1; out.push(u);
			}
		}
		if (out.length) return out;
	}
	return [];
}

// ================================================================ the core (one thread: a worker, or in-process)
/**
 * makeCore(L, co) -> {reach(startStrs, wp, budget) -> Promise<result with mask strings>, polish(str, o), stats}
 * co: {prims (a primitives object of THIS thread, or null), bounds (this thread's, or null), model (this thread's, or
 * null)}. budget: {ms, level, k, deadline, stop}.
 */
function makeCore(L, co) {
	co = co || {};
	const W = L.width, H = L.height, N = W * H;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const cache = new Map();
	const st = { calls: 0, ok: 0, fail: 0, byTool: {}, byWhy: {}, sims: 0, ms: 0, proven: 0 };
	const fieldMs = { n: 0, perTile: 0 };
	let analysis = null;

	/** the state after a masks string (a cached replay: the longest cached prefix, then the rest) */
	function startOf(str) {
		let e = cache.get(str);
		if (e) { cache.delete(str); cache.set(str, e); return e; }
		let from = null;
		for (const [k, v] of cache) if (k.length < str.length && (from === null || k.length > from.tick) && str.startsWith(k)) from = v;
		const masks = T.masksOf(str);
		let dead = false, deadAt = -1;
		if (from) sim.restore(from.snap); else sim.reset();
		for (let t = from ? from.tick : 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			if (sim.is_dead && deadAt < 0) deadAt = t + 1;
		}
		dead = !!sim.is_dead;
		e = { str, masks, tick: masks.length, snap: sim.snapshot(), dead, deadAt: from && from.deadAt >= 0 ? from.deadAt : deadAt, disc: X.discKey(sim), hash: sim.stateHash() };
		cache.set(str, e);
		if (cache.size > REPLAY_CACHE) cache.delete(cache.keys().next().value);
		return e;
	}
	/** an ordering goal field (no proof: reach.js portalForced + oneWayEntry) of the level as the doors stand at start s */
	const ordMemo = new Map();
	function ordFieldOf(s, goal, allowDeath) {
		sim.restore(s.snap);
		const Lc = T.levelNow(L, sim);
		const tiles = T.fieldTilesOf(goal);
		const key = `${T.fgHash(Lc.fg)}|${Array.from(tiles).sort((a, b) => a - b).join(',')}|${allowDeath ? 1 : 0}`;
		let f = ordMemo.get(key);
		if (f) return f;
		f = RF.reachField(Lc, { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: !!allowDeath, portalForced: true, oneWayEntry: true });
		ordMemo.set(key, f);
		if (ordMemo.size > 8) ordMemo.delete(ordMemo.keys().next().value);
		return f;
	}
	/** the goal field of the level as the doors stand in the state now in sim (memoized in types.js) */
	function fieldNow(goal, allowDeath) {
		const Lc = goal.walls ? withWalls(T.levelNow(L, sim), goal.walls) : T.levelNow(L, sim);
		const t0 = Date.now();
		const f = T.goalField(Lc, T.fieldTilesOf(goal), { deaths: allowDeath });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		return f;
	}
	/** a field build expected to fit the time left (an unknown level: yes) */
	const fieldFits = (left) => fieldMs.n === 0 || fieldMs.perTile * N < 0.4 * left;
	function steerA() {
		if (analysis) return analysis;
		try { analysis = require('../steer.js').analyze(L); } catch (e) { analysis = { cls: new Uint8Array(N), gateFeat: [] }; }
		return analysis;
	}

	async function reach(startStrs, wp, budget) {
		const tIn = Date.now();
		budget = budget || {};
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + (budget.ms > 0 ? budget.ms : 3000));
		const wEnd = deadline - VERIFY_MARGIN_MS;
		const stop = typeof budget.stop === 'function' ? budget.stop : null;
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		const rung = budget.level | 0;
		const goal = T.goalOf(L, wp);
		goal.over = X.overOf(wp);
		// (the counterexample walls of this waypoint's field, from the main thread's memo: ordering fields only)
		const walled = WALLS_ON && Array.isArray(wp.walls) && wp.walls.length > 0;
		if (walled) { goal.walls = wp.walls; goal.wallLc = withWalls(L, wp.walls); }
		if (WALLS_ON && Array.isArray(wp.wallsTabu) && wp.wallsTabu.length) goal.tabu = new Set(wp.wallsTabu);
		const allowDeath = !!wp.allowDeath;
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		st.calls++;
		let sims = 0;
		const tiers = [];
		const out = (r) => {
			r.ms = Date.now() - tIn; r.sims = sims; r.tiers = tiers;
			st.ms += r.ms; st.sims += sims;
			if (r.ok) { st.ok++; st.byTool[r.tool] = (st.byTool[r.tool] || 0) + 1; if (r.legs && r.legs.some((l) => l.proven)) st.proven++; }
			else { st.fail++; st.byWhy[r.fail.why] = (st.byWhy[r.fail.why] || 0) + 1; }
			return r;
		};
		const starts = startStrs.map((s) => startOf(String(s)));
		const t0 = Math.min(...starts.map((s) => s.tick));
		// (a start already at the goal: that start is the arrival, 0 ticks)
		const here = [];
		starts.forEach((s, i) => { sim.restore(s.snap); if (!s.dead && X.goalAt(goal, sim, s.tick, beforeTick)) here.push(i); });
		if (here.length) {
			const cands = here.map((i) => ({ start: i, tail: new Uint8Array(0), depth: starts[i].tick - t0 }));
			const r = finishFound(cands, 'exact', here.map((i) => ({ start: i, ticks: 0, lb: 0, proven: true, tool: 'exact' })), 0);   // (0 ticks: the exact search's depth 0)
			if (r) return out(r);
		}
		const live = starts.filter((s) => allowDeath || !s.dead);
		if (!live.length) return out(failResult('dies', null, 'every start is dead', rung, starts, goal, { deadline }));
		// -------- tier 0: the proof pre-check (and the goal fields for the cuts and the distances)
		let field0 = null, proofAll = true, anyField = false;
		const fields = new Map();   // disc -> field
		const startCost = [];
		for (const s of starts) {
			sim.restore(s.snap);
			let f = fields.get(s.disc);
			if (f === undefined) {
				f = fieldFits(wEnd - Date.now()) ? fieldNow(goal, allowDeath) : null;
				fields.set(s.disc, f);
			}
			if (f === null) { proofAll = false; startCost.push(-2); continue; }
			anyField = true;
			if (field0 === null) field0 = f;
			const c = RF.costAt(f, sim);
			startCost.push(c);
			if (!(c < 0 && f.mode !== 'walk')) proofAll = false;
		}
		tiers.push({ tier: 'proof', ms: Date.now() - tIn, proof: anyField && proofAll });
		// (a death step's field is an ORDERING field (the tiles a death starts from, planner.js dieField), no proof)
		if (anyField && proofAll && !wp.dieField && !walled) return out(proofFail(starts[0], goal, wp, rung, 'the goal field of the level as the doors stand is -1 at every start', deadline));
		// (walls that cut every start off the waypoint were no counterexample of the field's way: the main thread drops them)
		if (anyField && proofAll && walled) { const fw = failResult('budget', null, 'the counterexample walls cut every start off', rung, null, null, { deadline }); fw.fail.wallsCut = true; return out(fw); }
		const disc0 = starts[0].disc;
		const sameDisc = starts.every((s) => s.disc === disc0);
		const cutField = sameDisc && field0 && field0.mode !== 'walk' && !walled ? field0 : null;
		const snaps = starts.map((s) => ({ snap: s.snap, tick: s.tick }));
		const stopFn = () => (stop !== null && stop());
		let closest = { dist: -1, masks: null };
		const noteClosest = (dist, sIdx, tail) => {
			if (!(dist >= 0) || tail === null || sIdx < 0) return;
			if (closest.dist < 0 || dist < closest.dist) closest = { dist, masks: T.concat(starts[sIdx].masks, tail) };
		};
		// -------- tier 0b: THE EXACT END SEARCH from a NEAR state (within NEAR_T tiles of the goal by the goal field): a later
		// start (the strategy's relay: the last rung's nearest state) and, after the primitives and the exact tier, this
		// call's own nearest state; each alone and a few of its own ancestors (its masks cut NEAR_BACK ticks back: a near
		// state is often past its window, a coin passed, a gap overshot), the exact search (solveExact: every input tick by
		// tick, exact dedup, the admissible bound) from THAT state's own tick. The exact tier runs from every start at once
		// over absolute ticks from the earliest: a near start 300 ticks later enters only after 300 layers of the anchor's
		// states (it never got there), and nothing searched on from the finders' nearest state: Pancake Quest's coin legs
		// ended "closest 0" with the ball ON the coin's tile, the coin taken by the next tick's touch (lane 4 block 2). Not a
		// proof (a subset of the starts' futures): found = the finders' kind ('leg': the tightening and the exact bounded
		// search below run on it). OPT-IN (EEAT_NEAR=1; off = the code before, byte for byte): lane 4 block 2 (box 3, the 18
		// near-miss levels of b1, 60 s, --workers=3) ran it 91 times and it found 1 leg (Booty Return); gain sum 45 vs 48 /
		// 48 / 51 off (the 12% reserve of the finders' window costs more than it finds): those "near misses" are FALSE nears
		// of the goal field (Level 1 Overworld's coin (186,45) 1.4 tiles from a ball IN the portal column (187,42..45) that
		// teleports it; Two's coin (125,190) under an up boost, reached only from the shaft beside it; Katwalk's trophy 2
		// tiles through walls), not windows an exact search closes.
		const nearJobs = (strs) => {
			const jobs = [], seenJ = new Set();
			for (const s0 of strs) {
				for (const back of NEAR_BACK) {
					const len = s0.length - back;
					// (the base: the latest start this prefix extends; none, or a start itself when back > 0: skipped)
					let j = -1;
					for (let q = 0; q < starts.length; q++) if (starts[q].tick <= len && (j < 0 || starts[q].tick > starts[j].tick) && s0.startsWith(starts[q].str)) j = q;
					if (j < 0 || (back > 0 && starts[j].tick === len)) continue;
					const str = s0.slice(0, len);
					if (seenJ.has(str)) continue;
					seenJ.add(str);
					jobs.push({ str, base: j, w: back === 0 ? 2 : 1 });
				}
			}
			return jobs;
		};
		const nearEnd = (jobs, nEnd, what, nearest) => {
			const tN = Date.now();
			const wSum = jobs.reduce((a, x) => a + x.w, 0);
			let nFound = null, nRuns = 0;
			for (const jb of jobs) {
				const now = Date.now();
				if (now >= nEnd - 5 || stopFn()) break;
				const e = startOf(jb.str);
				if (e.dead) continue;
				sim.restore(e.snap);
				if (X.goalAt(goal, sim, e.tick, beforeTick)) { const b = starts[jb.base]; nFound = [{ start: jb.base, tail: e.masks.slice(b.tick), depth: e.tick - t0 }]; break; }
				const f = fields.get(e.disc);
				const jEnd = Math.min(nEnd, now + (nEnd - tN) * jb.w / wSum);
				const r = X.solveExact(L, [{ snap: e.snap, tick: e.tick }], goal, { sim, allowDeath: false, beforeTick, bounds: co.bounds || null, field: f && f.mode !== 'walk' ? f : null, discKey: X.discKey, disc0: e.disc, stop: stopFn, cap: NEAR_CAP, deadline: jEnd });
				nRuns++;
				sims += sumTicks(r);
				if (r.status === 'found' && r.goals && r.goals.length) {
					const b = starts[jb.base], pre = e.masks.subarray(b.tick);
					nFound = r.goals.map((g) => ({ start: jb.base, tail: T.concat(pre, g.tail), depth: e.tick - t0 + g.tail.length }));
					break;
				}
			}
			tiers.push({ tier: 'near', what, ms: Date.now() - tN, runs: nRuns, jobs: jobs.length, ok: !!nFound, nearest });
			if (!nFound) return null;
			const r = finishFound(nFound, 'leg', null, 0, false);
			if (r) delete r.arrivalsRaw;
			return r;
		};
		const nearOn = NEAR_ON() && !allowDeath;
		if (nearOn && Date.now() < wEnd - 50) {
			const near = [];
			starts.forEach((s, i) => { const c = startCost[i]; if (s.tick > t0 && !s.dead && c >= 0 && c <= NEAR_T) near.push(i); });
			near.sort((a, b) => startCost[a] - startCost[b] || starts[b].tick - starts[a].tick);
			if (near.length) {
				const r = nearEnd(nearJobs(near.slice(0, NEAR_STARTS).map((i) => starts[i].str)), Date.now() + NEAR_F * (wEnd - Date.now()), 'start', startCost[near[0]]);
				if (r) return out(r);
			}
		}
		// -------- tier 1: the primitives
		if (co.prims && typeof co.prims.route === 'function' && Date.now() < wEnd) {
			const t1 = Date.now();
			try {
				// (the primitives' share of the window: PRIMS_SHARE at rung 0, PRIMS_SHARE_HI from rung 1 on: a leg the primitives
				// did not find at rung 0 is mostly one their moves do not cover, and there they spent half of every rung while the
				// best-first finder needed it: Late christmas' first coin (26,44), 15 s, in-process: the primitives 7.4 s and the
				// finder's 6 s no leg, the primitives 0.7 s and the finder 10 s a 245-tick leg)
				const pEnd = t1 + (rung >= 1 ? PRIMS_SHARE_HI : PRIMS_SHARE) * (wEnd - t1);
				const arr = live.map((s) => { sim.restore(s.snap); return T.arrivalOf(L, sim, s.masks, null); });
				// (beforeTick: this file's -1 is 'none'; the primitives' is undefined: -1 there pruned every child, so the
				// primitives tier never found a leg in a compile)
				const nr = await co.prims.route(arr, goal, { ms: pEnd - t1, deadline: pEnd, stop: stopFn, k }, { allowDeath, beforeTick: beforeTick >= 0 ? beforeTick : undefined });
				sims += (nr && nr.sims) || 0;
				tiers.push({ tier: 'prims', ms: Date.now() - t1, ok: !!(nr && nr.ok) });
				if (nr && nr.ok && nr.arrivals && nr.arrivals.length) {
					const cands = [];
					for (const a of nr.arrivals) {
						const m = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
						const si = starts.findIndex((s) => m.length >= s.tick && T.strOf(m.subarray(0, s.tick)) === s.str);
						if (si >= 0) cands.push({ start: si, tail: m.slice(starts[si].tick), depth: m.length - t0 });
					}
					const legsP = cands.length ? [{ start: cands[0].start, ticks: cands[0].tail.length, lb: nr.lb >= 0 ? nr.lb : 0, proven: !!nr.proven, tool: 'prims' }] : [];
					const r = finishFound(cands, 'prims', legsP, nr.lb >= 0 ? nr.lb : 0);
					if (r) return out(r);
				}
				if (nr && nr.closest && nr.closest.masks) {
					// (measured again in the finders' unit, field0's tiles: the primitives' own number is another field's (or
					// the bound's ticks), and the smaller number of two units made the closest the start in every compile)
					const m = nr.closest.masks instanceof Uint8Array ? nr.closest.masks : T.masksOf(nr.closest.masks);
					const d = field0 && process.env.EEAT_CLOSEST_NEAR !== '0' ? fieldDistOf(m, starts, field0) : (nr.closest.dist >= 0 ? nr.closest.dist : 1e9);
					if (d >= 0 && (closest.dist < 0 || d < closest.dist)) closest = { dist: d, masks: m };
				}
			} catch (e) { tiers.push({ tier: 'prims', error: String(e && e.message || e) }); }
		}
		// -------- tier 2: the exact search, short (iterative deepening)
		const cap = rung <= 0 ? 150000 : rung === 1 ? 250000 : 300000;
		const baseX = { sim, allowDeath, beforeTick, bounds: co.bounds || null, field: cutField, discKey: X.discKey, disc0, stop: stopFn, cap };
		let lbAbs = 0, exactProof = false, legTime = false;
		let found = null;   // {cands, tool, proven, lbAbs}
		// (the counterexample walls: the tiles the finders reached, their region, whether the last best-first run exhausted it)
		let visW = null, regionW = null, bestExhausted = false;
		{
			const t2 = Date.now();
			// (its share: 35% where the goal can be near (the least start bound within X_NEAR ticks: the exact search's
			// reach, each tick of slack multiplying its states), else 12%: then it proves a lower bound and the finders get the
			// time)
			let h0 = Infinity;
			if (!allowDeath) { const B0 = X.boundFor(L, goal); for (const s of starts) { sim.restore(s.snap); const h = require('../endgame.js').lowerBound(B0, sim, X_NEAR + 1) + (s.tick - t0); if (h < h0) h0 = h; } }
			const xEnd = t2 + (h0 <= X_NEAR ? X_SHARE_NEAR : X_SHARE_FAR) * (wEnd - t2);
			const track = { dist: undefined };
			const r = X.solveExact(L, snaps, goal, Object.assign({}, baseX, { deadline: xEnd, track, distField: field0 }));
			sims += sumTicks(r);
			lbAbs = Math.max(lbAbs, r.lb || 0);
			tiers.push({ tier: 'exact', ms: Date.now() - t2, status: r.status, lb: r.lb, runs: r.runs });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else {
				if (r.exhausted && !goal.fieldTiles && !walled) exactProof = true;   // (a skeleton sub-leg's bound is its waypoint's: no proof)
				if (track.layer >= 0 && r.layers) { const p = X.pathOfKept(r.layers, track.layer, track.idx, snaps, r.t0); if (p) noteClosest(track.dist, p.start, p.tail); }
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- tier 0b again: the exact end search from this call's own nearest state (the primitives' or the exact tier's)
		if (nearOn && !found && !exactProof && closest.masks && closest.dist >= 0 && closest.dist <= NEAR_T && Date.now() < wEnd - 50) {
			const r = nearEnd(nearJobs([T.strOf(closest.masks)]), Date.now() + NEAR_F * (wEnd - Date.now()), 'closest', closest.dist);
			if (r) return out(r);
		}
		// -------- tier 3: the fine-cell leg search
		if (!found && !exactProof && Date.now() < wEnd - 5) {
			// (the finders: the best-first search dives (the first leg, soonest), then the time-layered beam bounded by it
			// (a faster leg of the same kind); LEG_MODE 'beam' / 'best' (env EEAT_EXEC_LEG) for measurements)
			const region = regionOf(field0, starts, goal);
			// (EEAT_ORD_FORCED=1, a measurement: the best-first finder's field is an ORDERING field that is no proof, the
			// steer's options: portalForced (a portal tile with exits is left only through them) and oneWayEntry; with
			// EEAT_LEG_BF=0 it orders the search, else only its distances. The -1 cuts keep field0.)
			const fOrd = ORD_FORCED() && field0 && field0.mode !== 'walk' ? ordFieldOf(starts[0], goal, allowDeath) : null;
			regionW = region;
			const depthMax = beforeTick >= 0 ? beforeTick - t0 : 4000;
			const runBeam = (end, dmax) => LG.legBFS(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null,
				width0: 300, widthMax: 80000, depthMax: dmax, stall: 150 + 100 * rung });
			const cell0 = process.env.EEAT_BEST_CELL ? process.env.EEAT_BEST_CELL.split(',').map(Number) : null;
			const runBest = (end, cell) => LG.legBest(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: fOrd || field0, region, bounds: co.bounds || null, depthMax, w: +process.env.EEAT_BEST_W || 0, cell: cell || cell0, visited: visW });
			const mode = LEG_MODE();
			if (WALLS_ON && (WALLS_ALL || T.fieldTouchOf(goal)) && mode === 'best' && field0 && field0.mode !== 'walk') visW = new Uint8Array(N);
			const t3 = Date.now();
			// (EEAT_BEST_PORT=<f>: the first cells get that share of the window, then the next grain of the ladder the rest (a
			// measurement knob: a portfolio of grains instead of one)
			const port = +process.env.EEAT_BEST_PORT || 0;
			// (the finders end NEAR_RES of the window early: the exact end search from their nearest state gets it, below)
			const bEnd = nearOn ? wEnd - 3 - NEAR_RES * (wEnd - t3) : wEnd - 3;
			// (the coarse grain first from rung COARSE_RUNG on: COARSE_CELL above)
			let rC = null;
			if (mode === 'best' && !cell0 && !port && COARSE_SHARE > 0 && rung >= COARSE_RUNG) {
				rC = runBest(t3 + COARSE_SHARE * (bEnd - t3), COARSE_CELL);
				sims += rC.sims;
				tiers.push({ tier: 'best', ms: Date.now() - t3, status: rC.status, passes: rC.passes, cell: COARSE_CELL });
				if (rC.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
				if (rC.status !== 'found' && rC.closest && rC.closest.tail) noteClosest(rC.closest.dist, rC.closest.start, rC.closest.tail);
			}
			const t3b = Date.now();
			let r = rC !== null && rC.status === 'found' ? rC : mode === 'beam' ? runBeam(bEnd, depthMax) : runBest(mode === 'best' ? (port > 0 && port < 1 ? t3 + port * (wEnd - t3) : bEnd) : t3 + 0.7 * (wEnd - t3));
			if (r !== rC) {
				sims += r.sims;
				tiers.push({ tier: mode === 'beam' ? 'leg' : 'best', ms: Date.now() - t3b, status: r.status, passes: r.passes });
			}
			// (the refinement ladder: a best-first search that ran out of open states (its cells closed every way: the first
			// arrival's rule on coarse cells) goes again on finer cells while time is left; EEAT_BEST_LADDER=0 off)
			if (mode === 'best' && process.env.EEAT_BEST_LADDER !== '0') {
				for (const cell of LADDER) {
					if (!(r.status === 'exhausted' || (port > 0 && r.status === 'time')) || Date.now() >= wEnd - 20) break;
					if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail);
					const t7 = Date.now();
					r = runBest(bEnd, cell);
					sims += r.sims;
					tiers.push({ tier: 'best', ms: Date.now() - t7, status: r.status, passes: r.passes, cell });
				}
			}
			// (stuck: the region exhausted, or a plateau: no state nearer by the field in the last WALL_PLATEAU of its pops,
			// at least WALL_POPS of them, the nearest past WALL_NEAR tiles (the last mile is the exact landing's))
			{
				const pops = r.passes && r.passes[0] ? r.passes[0].pops : 0;
				const cp = r.closest && r.closest.pop >= 0 ? r.closest.pop : -1;
				const plateau = r.status === 'time' && cp >= 0 && pops >= WALL_POPS && cp < (1 - WALL_PLATEAU) * pops && r.closest.dist > WALL_NEAR;
				bestExhausted = mode === 'best' && (r.status === 'exhausted' || plateau);
			}
			if (mode === 'mix' && r.status !== 'stopped' && Date.now() < wEnd - 5) {
				const ub = r.status === 'found' ? Math.min(...r.goals.map((c) => c.depth)) : depthMax + 1;
				if (ub > 1) {
					const t5 = Date.now();
					const r2 = runBeam(r.status === 'found' ? t5 + 0.5 * (wEnd - t5) : wEnd - 3, ub - 1);
					sims += r2.sims;
					tiers.push({ tier: 'leg', ms: Date.now() - t5, status: r2.status, passes: r2.passes });
					if (r2.status === 'found' || r.status !== 'found') { if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail); r = r2; }
				}
			}
			if (r.status === 'found') found = { cands: r.goals, tool: 'leg', proven: false, lbAbs };
			// (the tightening: a leg found, the best-first search again with the kinematic bound in its order and only legs
			// shorter than it, half of what is left: T-EXEC-LEGS, box 3, 3 s: 77.0% vs 76.6%, the legs found 1.020 vs 1.046 of
			// the route's (median), shorter in 91 of the 202 both found, longer in none; EEAT_TIGHTEN=0 off; its weight 3
			// (EEAT_TIGHT_W): 77.4% either way, the legs 1.000 vs 1.007 (median), 1.303 vs 1.438 (p90), shorter in 66 of 204)
			if (found && process.env.EEAT_TIGHTEN !== '0' && Date.now() < wEnd - 50) {
				const tm = String(process.env.EEAT_TIGHTEN_MODE || 'best');
				// (EEAT_TIGHTEN_MODE: 'best' (the default), 'beam' (legBFS bounded by the leg: layered by tick, it keeps the
				// fastest state per cell), 'both' (the beam, then best-first on what is left of the share))
				const t8 = Date.now(), tEnd = t8 + (+process.env.EEAT_TIGHT_SHARE || 0.5) * (wEnd - t8);
				if (tm === 'beam' || tm === 'both') {
					const ub = Math.min(...found.cands.map((c) => c.depth));
					const rb = runBeam(tm === 'both' ? t8 + 0.6 * (tEnd - t8) : tEnd, ub - 1);
					sims += rb.sims;
					tiers.push({ tier: 'beam-tighten', ms: Date.now() - t8, status: rb.status, depth: rb.depth });
					if (rb.status === 'found' && rb.depth < ub) found.cands = rb.goals.concat(found.cands);
				}
				if (tm !== 'beam' && Date.now() < tEnd - 20) {
					const t9 = Date.now();
					const ub = Math.min(...found.cands.map((c) => c.depth));
					const r3 = LG.legBest(L, snaps, goal, { sim, deadline: tEnd, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null, depthMax: ub - 1, w: +process.env.EEAT_TIGHT_W || 3, cell: cell0, kbOn: true, noFinish: true });
					sims += r3.sims;
					tiers.push({ tier: 'best-tighten', ms: Date.now() - t9, status: r3.status, depth: r3.depth });
					if (r3.status === 'found' && r3.depth < ub) found.cands = r3.goals.concat(found.cands);
				}
			}
			else {
				if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail);
				if (r.status === 'time' || r.status === 'depth') legTime = true;
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- tier 0b a third time: the exact end search from the finders' nearest state, in the window they left
		if (nearOn && !found && !exactProof && closest.masks && closest.dist >= 0 && closest.dist <= NEAR_T && Date.now() < wEnd - 30) {
			const r = nearEnd(nearJobs([T.strOf(closest.masks)]), wEnd - 5, 'late', closest.dist);
			if (r) return out(r);
		}
		// -------- the leg found made shorter: polish.js polishLeg (exact windows from its end back: the waypoint sooner, the
		// leg's own state region sooner, exact rejoins; every change replayed from the start)
		if (found && found.tool === 'leg' && Date.now() < wEnd - 20 && process.env.EEAT_LEG_POLISH !== '0') {
			const t6 = Date.now();
			const c0 = found.cands.reduce((m, c) => (c.depth < m.depth ? c : m), found.cands[0]);
			const PO = require('./polish.js');
			const pl = PO.polishLeg(L, snaps[c0.start], c0.tail, goal, { sim, deadline: t6 + 0.6 * (wEnd - t6), allowDeath, beforeTick, stop: stopFn });
			tiers.push({ tier: 'leg-polish', ms: Date.now() - t6, saved: pl.saved, mutated: pl.mutated, windows: pl.windows });
			if (pl.saved > 0) found.cands.unshift({ start: c0.start, tail: pl.tail, depth: c0.depth - pl.saved });
		}
		// -------- tier 2b: the exact search bounded by the leg found (a shorter leg, or a proof that it is optimal)
		if (found && found.tool === 'leg' && Date.now() < wEnd - 5) {
			const t4 = Date.now();
			const ub = Math.min(...found.cands.map((c) => c.depth));
			const r = X.exactLeg(L, snaps, goal, Object.assign({}, baseX, { maxDepth: ub - 1, deadline: wEnd - 2 }));
			sims += r.stats.ticks;
			tiers.push({ tier: 'exact-ub', ms: Date.now() - t4, status: r.status, maxDepth: ub - 1 });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else if (r.status === 'proof') { found.proven = true; found.lbAbs = ub; }
		}
		if (found) {
			const minDepth = Math.min(...found.cands.map((c) => c.depth));
			const legs = [];
			const r = finishFound(found.cands, found.tool, null, found.proven ? minDepth : lbAbs, found.proven, minDepth);
			if (r) {
				// (teach the primitives every leg found: the move they lacked, derived from the physics)
				if (co.prims && typeof co.prims.learn === 'function' && found.tool !== 'prims') {
					try { for (const a of r.arrivalsRaw) { const s = starts[a.start]; sim.restore(s.snap); const from = T.arrivalOf(L, sim, s.masks, null); co.prims.learn(from, a.tail, a.arrival); } } catch (e) { /* optional */ }
				}
				delete r.arrivalsRaw;
				return out(r);
			}
			void legs;
		}
		let why = exactProof ? 'exhausted' : (legTime || Date.now() >= wEnd - 5 ? 'budget' : 'exhausted');
		if (walled && why === 'exhausted') why = 'budget';   // (a walled field's region is no claim)
		const fr = failResult(why, closest, null, rung, starts, goal, { lbAbs, startCost, deadline });
		// (an exhausted best-first search: its reached tiles against the field, the counterexample walls; the relaxation's
		// way it could not take is no proof of anything: 'budget')
		if (visW && bestExhausted && field0) {
			try {
				const ws = wallsOf(L, field0, visW, regionW, goal);
				if (ws.length) { fr.fail.walls = ws; if (fr.fail.why === 'exhausted') fr.fail.why = 'budget'; }
			} catch (e) { /* ordering only */ }
		}
		return out(fr);

		// ---------------------------------------------------------------- the pieces
		/** a result from goal candidates {start, tail, depth}: arrivals built, verified from the level start, picked */
		function finishFound(cands, tool, legsIn, lbA, proven, minDepth) {
			const arr = [];
			const seenH = new Set();
			for (const c of cands.slice(0, 4000)) {
				const s = starts[c.start];
				sim.restore(s.snap);
				for (let t = 0; t < c.tail.length; t++) { E.applyMask(inp, c.tail[t]); sim.tick(inp); }
				const masks = T.concat(s.masks, c.tail);
				const a = T.arrivalOf(L, sim, masks, null);
				if (seenH.has(a.hash)) continue;
				seenH.add(a.hash);
				a._c = c;
				arr.push(a);
				if (Date.now() > deadline - 20 && arr.length >= 1) break;
			}
			const picked = T.pickDiverse(arr, k);
			// (a CALM arrival too: pickDiverse ranks equal ticks by |vx| + |vy|, so a jump pressed on the goal tick is its
			// "earliest" and "fastest"; the next leg from a ball launched upward can be much longer (test/planexec.js's key
			// door level: 38 ticks from the calm state, none found in 3 s from the four launched ones))
			const calm = (a) => a.vy >= -0.5;
			if (picked.length && !picked.some(calm)) {
				let best = null;
				for (const a of arr) if (calm(a) && (!best || a.tick < best.tick || (a.tick === best.tick && Math.abs(a.vx) > Math.abs(best.vx)))) best = a;
				if (best) { if (picked.length >= k) picked[picked.length - 1] = best; else picked.push(best); }
			}
			const good = [];
			for (const a of picked) {
				const c = a._c;
				const s0 = starts[c.start];
				if (verifyTail(sim, inp, s0.snap, s0.tick, c.tail, goal, beforeTick, allowDeath)) good.push(a);
			}
			if (!good.length) return null;
			const md = minDepth !== undefined ? minDepth : Math.min(...cands.map((c) => c.depth));
			const legs = legsIn || good.map((a) => {
				const c = a._c, off = starts[c.start].tick - t0;
				return { start: c.start, ticks: c.tail.length, lb: Math.max(0, lbA - off), proven: !!proven && c.depth === md, tool };
			});
			const lb = Math.min(...starts.map((s, i) => Math.max(0, lbA - (s.tick - t0))));
			return { ok: true, arrivals: good.map((a) => ({ masks: T.strOf(a.masks), start: a._c.start, ticks: a._c.tail.length })), tool, legs, lb, fail: null,
				arrivalsRaw: good.map((a) => ({ start: a._c.start, tail: a._c.tail, arrival: a })) };
		}
	}

	/** the region of the leg search: tiles the goal field's walk reaches (dilated by a tile) in a box around the starts
	 *  and the goal */
	function regionOf(field, starts, goal) {
		let x0 = W, y0 = H, x1 = -1, y1 = -1;
		const add = (t) => { const x = t % W, y = (t / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
		for (const s of starts) { sim.restore(s.snap); add(T.tileOf(sim, W, H)); }
		for (const t of goal.tiles) add(t);
		const M = +process.env.EEAT_REGION_M || 24;   // (tiles around the starts and the goal; env: measurements)
		x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(W - 1, x1 + M); y1 = Math.min(H - 1, y1 + M);
		const reg = new Uint8Array(N);
		const walk = field && field.walk ? field.walk : null;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const t = y * W + x;
			if (walk === null || walk[t] !== RF.CUT) { reg[t] = 1; continue; }
			// (a tile next to a reached one: the centre in a half block's tile, a door's edge)
			for (let dy = -1; dy <= 1 && !reg[t]; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < W && yy < H && walk[yy * W + xx] !== RF.CUT) { reg[t] = 1; break; }
			}
		}
		// (and anywhere in the level the tiles the walk puts no more than M tiles farther from the goal than the farthest
		// start: a portal's exits outside the box (Santa's Workshop: the start's portal to x 38, the goal at x 299; every
		// child cut, the search 'exhausted' after one pop))
		if (walk !== null) {
			let w0 = -1;
			for (const s of starts) { sim.restore(s.snap); const v = walk[T.tileOf(sim, W, H)]; if (v !== RF.CUT && v > w0) w0 = v; }
			if (w0 >= 0) {
				const lim = w0 + 5 * M;
				const add2 = [];
				for (let t = 0; t < N; t++) if (!reg[t] && walk[t] !== RF.CUT && walk[t] <= lim) add2.push(t);
				for (const t of add2) {
					reg[t] = 1;
					const x = t % W, y = (t / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) reg[yy * W + xx] = 1; }
				}
			}
		}
		// (the starts' own tiles always)
		for (const s of starts) { sim.restore(s.snap); reg[T.tileOf(sim, W, H)] = 1; }
		return reg;
	}

	/** a FailReport result: the closest state's details, the triggers its way touched, the gates blocking it */
	function failResult(why, closest, note, rung, starts, goal, extra) {
		const fail = { why, closest: null, touched: [], blockedBy: [], level: rung | 0, note: note || null };
		const dl = extra && extra.deadline ? extra.deadline : Infinity;
		if (closest && closest.masks && starts && goal) {
			const c = describe(closest.masks, closest.dist, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		} else if (starts && starts.length && goal) {
			// (no nearer state than the start: the start itself, by the all-open field)
			const c = describe(starts[0].masks, -1, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		}
		const r = { ok: false, arrivals: [], tool: null, legs: [], lb: extra && extra.lbAbs >= 0 ? extra.lbAbs : 0, fail };
		if (fail.closest) fail.closest.masks = T.strOf(fail.closest.masks);
		return r;
	}
	function proofFail(start, goal, wp, rung, note, dl) {
		const r = failResult('proof', null, note, rung, [start], goal, { deadline: dl });
		// (the proof's blockedBy: every shut gate on the all-open field's way from the start, not only near it)
		sim.restore(start.snap);
		r.fail.blockedBy = blockedOnWay(goal, sim, Infinity, wp.allowDeath, dl);
		return r;
	}
	/** the all-open goal field (the level itself: every door a door, open), when it is built already or fits the time */
	const plainBuilt = new Set();
	function plainField(goal, allowDeath, dl) {
		const key = `${Array.from(T.fieldTilesOf(goal)).join(',')}|${allowDeath ? 1 : 0}`;
		if (!plainBuilt.has(key) && !fieldFits(dl - Date.now())) return null;
		const t0 = Date.now();
		const f = T.goalField(L, T.fieldTilesOf(goal), { deaths: !!allowDeath });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		plainBuilt.add(key);
		return f;
	}
	/** a field's tiles at the end of masks that extend one of the starts (the longest start prefix; -1: no start, or the
	 *  field has no way there) */
	function fieldDistOf(masks, starts, field) {
		let s = null;
		for (const x of starts) if (masks.length >= x.tick && (!s || x.tick > s.tick) && T.strOf(masks.subarray(0, x.tick)) === x.str) s = x;
		if (!s) return -1;
		sim.restore(s.snap);
		for (let t = s.tick; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
		const c = RF.costAt(field, sim);
		return c < 0 ? -1 : c;
	}
	/** the closest state's report: replay its masks (the touched triggers since the leg's start), its tile, speed,
	 *  distance, and the gates blocking it */
	function describe(masks, dist, starts, goal, dl) {
		const s0 = starts[0];
		// (the start the masks extend: the longest start prefix)
		let si = 0;
		for (let i = 0; i < starts.length; i++) if (masks.length >= starts[i].tick && T.strOf(masks.subarray(0, starts[i].tick)) === starts[i].str) { si = i; break; }
		const s = starts[si] || s0;
		sim.restore(s.snap);
		const touched = [];
		const fv = featsOf(sim);
		for (let t = s.tick; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			const f2 = featsOf(sim);
			for (const [k, v] of f2) if (fv.get(k) !== v) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: v });
			for (const k of fv.keys()) if (!f2.has(k)) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: 0 });
			fv.clear(); for (const [k, v] of f2) fv.set(k, v);
		}
		const tile = T.tileOf(sim, W, H);
		let d = dist;
		if (!(d >= 0)) {
			try { const f = plainField(goal, false, dl); if (f) { const c = RF.costAt(f, sim); d = c < 0 ? -1 : c; } else d = -1; } catch (e) { d = -1; }
		}
		const closest = { masks, tile, dist: d, vx: sim.speed_x, vy: sim.speed_y, px: sim.px, py: sim.py, dead: !!sim.is_dead };
		const blockedBy = blockedOnWay(goal, sim, 2, false, dl);
		return { closest, touched: touched.slice(0, 64), blockedBy };
	}
	/**
	 * The gates (steer.js analyze: cls 3 with a feature) SHUT in the state in sim (is_tile_solid_now) on the all-open
	 * field's way from its tile to the goal (the RCH3 field of the level itself, every door open: its walk, descended), within
	 * `near` tiles (Chebyshev) of the state's tile (Infinity: all of them on the way).
	 */
	function blockedOnWay(goal, s, near, allowDeath, dl) {
		const A = steerA();
		let f;
		try { f = plainField(goal, allowDeath, dl === undefined ? Infinity : dl); } catch (e) { return []; }
		if (!f) return [];
		const walk = f.walk;
		if (!walk) return [];
		const t0 = T.tileOf(s, W, H);
		const x0 = t0 % W, y0 = (t0 / W) | 0;
		const out = [], got = new Set();
		const gateAt = (t) => {
			if (A.cls[t] !== 3) return;
			const feat = A.gateFeat[t];
			if (!feat || feat === 'static' || feat === 'open') return;
			const x = t % W, y = (t / W) | 0;
			if (Math.max(Math.abs(x - x0), Math.abs(y - y0)) > near) return;
			if (!s.is_tile_solid_now(x, y) || got.has(t)) return;
			got.add(t); out.push({ tile: t, feat, x, y });
		};
		// the way: the steepest descent of the walk from the tile (8-way), and the gates next to it
		let t = t0;
		if (walk[t] === RF.CUT) {
			// (the state's tile has no walk value: the nearest neighbour that has one)
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x0 + dx, yy = y0 + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (walk[j] !== RF.CUT && (bt < 0 || walk[j] < walk[bt])) bt = j; }
			if (bt < 0) return out;
			t = bt;
		}
		for (let steps = 0; steps < N && walk[t] > 0; steps++) {
			gateAt(t);
			const x = t % W, y = (t / W) | 0;
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (walk[j] !== RF.CUT && walk[j] < walk[t] && (bt < 0 || walk[j] < walk[bt])) bt = j;
			}
			if (bt < 0) break;   // (a portal: the way goes on at an exit the descent does not follow)
			t = bt;
		}
		gateAt(t);
		return out;
	}
	function featsOf(s) {
		const m = new Map();
		for (const f of (co.model && co.model.feats) || BASE_FEATS) { const v = T.featValue(s, f); if (!Number.isNaN(v)) m.set(f, v); }
		for (const [k, v] of s._switches) if (v === true) m.set(`psw:${k}`, 1);
		for (const [k, v] of s._oswitches) if (v === true) m.set(`osw:${k}`, 1);
		return m;
	}

	async function polish(str, o) {
		const P = require('./polish.js');
		return P.polishRoute(L, T.masksOf(str), Object.assign({}, o, { core: true }));
	}
	return { reach, polish, stats: () => Object.assign({}, st), startOf, L };
}
const sumTicks = (r) => (r && r.runs ? r.runs.reduce((a, x) => a + (x.ticks || 0), 0) : r && r.stats ? r.stats.ticks : 0);

/**
 * The leg's check, a replay from the level start: no death after the start tick (unless allowDeath), the goal test true
 * at the end with the ball alive (and at a tick <= beforeTick), and not before in the leg (the arrival is the leg's FIRST
 * goal state). (types.js playTo(...).goalAt === masks.length is the same test when the start's own masks never held the
 * goal: CONTRACT REQUEST in the report.)
 */
/** the verification of a leg from its start state (a snapshot of the state this thread reached by replaying the start's
 *  masks from the level start: startOf): the tail played, no death (unless allowed), the goal first at its end, beforeTick;
 *  the sim holds the arrival after a true */
function verifyTail(sim, inp, snap, startTick, tail, goal, beforeTick, allowDeath) {
	sim.restore(snap);
	const n = startTick + tail.length;
	for (let t = 0; t < tail.length; t++) {
		E.applyMask(inp, tail[t] & 31);
		sim.tick(inp);
		const u = startTick + t + 1;
		if (sim.is_dead && !allowDeath) return false;
		if (u < n && !sim.is_dead && (beforeTick < 0 || u <= beforeTick) && goal.test(sim)) return false;
	}
	return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || n <= beforeTick);
}

function verifyLeg(L, masks, goal, startTick, beforeTick, allowDeath) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const u = t + 1;
		if (u <= startTick) continue;
		if (sim.is_dead && !allowDeath) return null;
		if (u < n && !sim.is_dead && (beforeTick < 0 || u <= beforeTick) && goal.test(sim)) return null;
	}
	return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || n <= beforeTick) ? sim : null;
}

/** a fixed input sequence's state hashes (the worker's level = this thread's level?) */
function fingerprint(L) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let x = 0x2545f491;
	const out = [L.width, L.height];
	for (let t = 1; t <= 400; t++) {
		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		E.applyMask(inp, (x >>> 0) % 18 === 17 ? 0 : [0, 1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 16, 17, 18, 20, 21, 6, 7][(x >>> 0) % 18] & 31);
		sim.tick(inp);
		if (t % 100 === 0) out.push(sim.stateHash());
	}
	return out.join(',');
}

// ================================================================ the main thread's executor
/** the Waypoint as plain data (it crosses threads) */
const wpData = (wp) => ({ kind: wp.kind, tiles: wp.tiles ? Array.from(wp.tiles) : [], trig: wp.trig, expect: wp.expect ? { feat: wp.expect.feat, value: wp.expect.value } : null,
	label: wp.label || '', allowDeath: !!wp.allowDeath, beforeTick: wp.beforeTick >= 0 ? wp.beforeTick : -1,
	fieldTiles: wp.fieldTiles ? Array.from(wp.fieldTiles) : null, fieldTouch: !!wp.fieldTouch });

async function createExecutor(L, opts) {
	opts = opts || {};
	const emit = typeof opts.emit === 'function' ? opts.emit : null;
	let nW = opts.workers === undefined || opts.workers === null ? Math.max(0, Math.min(4, os.cpus().length - 1)) : Math.max(0, opts.workers | 0);
	const note = [];
	if (nW > 0 && !opts.file) { note.push('no level file: the executor runs in-process'); nW = 0; }
	const core = makeCore(L, { prims: opts.prims || null, bounds: opts.bounds || null, model: opts.model || null });
	const vsim = new E.EESim(L), vinp = new E.EEInput();
	const RM = opts.RM || null;
	const S = { reach: 0, ok: 0, fail: 0, watchdog: 0, late: 0, hung: 0, verifyDrop: 0, polish: 0, byTool: {}, byWhy: {}, ms: 0, sims: 0, walls: 0, wallsReset: 0 };
	// ---- the pool
	const pool = [];
	let Worker = null;
	const queue = [];
	let jobId = 0;
	const spawn = (i) => {
		const w = new Worker(path.join(__dirname, 'execworker.js'), { workerData: { file: path.resolve(String(opts.file)), usePrims: !!opts.prims, useBounds: !!opts.bounds, seed: opts.seed | 0 } });
		const slot = { w, busy: null, i, dead: false };
		w.on('message', (msg) => {
			const job = slot.busy;
			if (!job || msg.id !== job.id) return;
			slot.busy = null;
			if (job.clear) job.clear();
			job.done(msg);
			pump();
		});
		w.on('error', (e) => { const job = slot.busy; slot.busy = null; slot.dead = true; if (job) job.done({ id: job.id, error: String(e && e.message || e) }); replace(slot); });
		w.on('exit', () => { if (!slot.dead) { slot.dead = true; const job = slot.busy; slot.busy = null; if (job) job.done({ id: job.id, error: 'the worker exited' }); replace(slot); } });
		w.unref();
		return slot;
	};
	const replace = (slot) => {
		if (closed) return;
		const k = pool.indexOf(slot);
		if (k >= 0) pool[k] = spawn(slot.i);
		pump();
	};
	let closed = false;
	if (nW > 0) {
		Worker = require('worker_threads').Worker;
		for (let i = 0; i < nW; i++) pool.push(spawn(i));
		// the workers' level must be this one: the same state hashes after a fixed input sequence
		const fp = fingerprint(L);
		const res = await Promise.all(pool.map((slot) => call(slot, { type: 'fp' }, Date.now() + 60000)));
		if (res.some((r) => !r || r.error || r.fp !== fp)) {
			note.push(`the workers' level differs from this one (${res.map((r) => (r && r.error) || (r && r.fp === fp ? 'same' : 'differs')).join(', ')}): the executor runs in-process`);
			for (const slot of pool) { slot.dead = true; try { slot.w.terminate(); } catch (e) { /* gone */ } }
			pool.length = 0; nW = 0;
		}
	}
	if (emit && note.length) emit({ ev: 'exec.note', note });
	/** a job on a given worker slot (its answer, or {error}) */
	function call(slot, msg, deadline, stopFlag) {
		return new Promise((resolve) => {
			const id = ++jobId;
			let settled = false;
			const done = (m) => { if (settled) return; settled = true; clearTimeout(timer); resolve(m); };
			slot.busy = { id, done };
			slot.w.postMessage(Object.assign({ id, stopFlag }, msg));
			let hang = null;
			const timer = setTimeout(() => {
				if (settled) return;
				S.watchdog++;
				// (the worker did not answer in time: the caller gets 'budget' now, and the worker is told to stop (its next
				// clock check); it KEEPS its slot until its late answer (a synchronous part that overran: a goal field, a
				// bounds field, the primitives' tables, all memoized in that worker). It used to be terminated and replaced
				// here: the new worker's start-up (the level, the bounds, the primitives) and the fields it rebuilt overran
				// the next short budget too, killed again: a spiral with no simulation at all (Late christmas, 3 workers,
				// 1.5-s steps: 24 kills in the first 4 rounds, sims 0; the compiles' first 15-20 s of steps 'budget' with
				// sims 0). Only a worker silent for WORKER_HANG_MS past its deadline is replaced)
				done({ id, error: 'watchdog', watchdog: true });
				if (stopFlag) { try { Atomics.store(new Int32Array(stopFlag), 0, 1); } catch (e) { /* none */ } }
				if (!WORKER_KEEP) { slot.dead = true; slot.busy = null; try { slot.w.terminate(); } catch (e) { /* gone */ } replace(slot); return; }
				S.late++;
				hang = setTimeout(() => {
					if (slot.dead || !slot.busy || slot.busy.id !== id) return;
					S.hung++;
					slot.dead = true; slot.busy = null;
					try { slot.w.terminate(); } catch (e) { /* gone */ }
					replace(slot);
				}, WORKER_HANG_MS);
				if (hang.unref) hang.unref();
			}, Math.max(10, deadline - Date.now()) + WATCHDOG_MS);
			slot.busy.clear = () => { if (hang) clearTimeout(hang); };
		});
	}
	function pump() {
		while (queue.length) {
			const slot = pool.find((s) => !s.busy && !s.dead);
			if (!slot) return;
			const q = queue.shift();
			if (Date.now() > q.deadline - VERIFY_MARGIN_MS) { q.resolve({ id: 0, error: 'queue', queued: true }); continue; }
			call(slot, q.msg, q.deadline, q.stopFlag).then(q.resolve);
		}
	}
	function dispatch(msg, deadline, stopFlag) {
		return new Promise((resolve) => { queue.push({ msg, deadline, stopFlag, resolve }); pump(); });
	}

	// ---- THE SKELETON (lane 3, COMPILE-ALL block 1): a far waypoint (the goal field's cost at the starts past SKEL_MIN
	// tiles) is reached through region sub-waypoints, the goal field's sub-level sets {t : the least cost of any state
	// centred on t <= c} for c = c0 - SKEL_STEP, c0 - 2 SKEL_STEP, ...: every way from the starts to the goal enters each
	// of them (the field's per-tile least cost changes by at most a step's move between neighbours: a sub-level set is a
	// cut of the level for the physics the field models), so a leg of ~SKEL_STEP tiles at a time, each started from the
	// last one's real (replayed) arrivals, k diverse; the arrivals of the deepest level reached are kept per (start,
	// waypoint) and the next call for the same step (the next rung) goes on from there instead of from scratch. Ordering
	// of the search only: every arrival is the engine's own replay, the final ones at the waypoint verified as before.
	// EEAT_SKEL=0: off (the direct leg as before); EEAT_SKEL_STEP / EEAT_SKEL_MIN (tiles).
	const SKEL_ON = process.env.EEAT_SKEL !== '0';
	const SKEL_STEP = +process.env.EEAT_SKEL_STEP > 0 ? +process.env.EEAT_SKEL_STEP : 12;
	const SKEL_MIN = +process.env.EEAT_SKEL_MIN > 0 ? +process.env.EEAT_SKEL_MIN : 30;
	const SKEL_DIRECT = process.env.EEAT_SKEL_DIRECT !== undefined ? Math.max(0, Math.min(0.9, +process.env.EEAT_SKEL_DIRECT || 0)) : 0.35;
	const skelKey = (goal, wp, startStrs, wn) => `${goal.kind}|${Array.from(goal.tiles).slice(0, 64).join(',')}|${goal.tiles.length}|${wp.expect ? wp.expect.feat + '=' + wp.expect.value : ''}|${startStrs[0].length}:${startStrs[0].slice(-64)}|w${wn | 0}`;
	const skelMemo = new Map();   // key (goal, first start, walls) -> [{c, cur: [mask strings]}] (the levels reached, deepest last)
	// (the counterexample walls per field: the waypoint's field tiles, their touch rule and deaths -> a Set of tiles; a
	// skeleton's sub-legs order by their waypoint's field, so they share its walls)
	const wallMemo = new Map(), wallBatches = new Map(), wallTabu = new Map();
	/** the last batch of walls of a field dropped (its walls cut every start off the waypoint: no counterexample of the
	 *  field's way, the batches before it stay; its tiles are never walled again: the relaxation's last way through them
	 *  is the way); false when none is left */
	const wallDropLast = (wk, label) => {
		const s = wallMemo.get(wk), bs = wallBatches.get(wk);
		if (!s || !bs || !bs.length) { wallMemo.delete(wk); wallBatches.delete(wk); return false; }
		const b = bs.pop();
		let tb = wallTabu.get(wk);
		if (!tb) { tb = new Set(); wallTabu.set(wk, tb); }
		for (const t of b) { s.delete(t); tb.add(t); }
		if (!s.size || !bs.length) { wallMemo.delete(wk); wallBatches.delete(wk); }
		S.wallsReset++;
		if (emit) emit({ ev: 'exec.walls', label: label || '', reset: true, total: s.size });
		return true;
	};
	const wallKeyOf = (wp) => {
		const g = T.goalOf(L, wp);
		const ft = Array.from(T.fieldTilesOf(g)).sort((a, b) => a - b);
		return `${ft.length}:${ft.slice(0, 64).join(',')}|${T.fieldTouchOf(g) ? 1 : 0}|${wp.allowDeath ? 1 : 0}`;
	};
	const tileMinMemo = new WeakMap();
	/** per tile the least cost (fifths) of any ball state centred on it by the goal field f (walk mode: its walk); CUT none */
	function tileMin(f) {
		let m = tileMinMemo.get(f);
		if (m) return m;
		const N = f.W * f.H, CUT = RF.CUT;
		m = new Uint32Array(N).fill(CUT);
		if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) m[t] = f.walk ? f.walk[t] : CUT; }
		else {
			const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
			for (let t = 0; t < N; t++) {
				let v = CUT;
				for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
				for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
				const rc = f.rowC[t], rx = f.rowX[t];
				if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
				if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
				m[t] = v;
			}
		}
		tileMinMemo.set(f, m);
		return m;
	}
	/** the goal field at a replayed start (the doors as they stand there) and the start's cost on it (tiles; -1 cut, NaN
	 *  none) */
	function fieldAt(str, goal, allowDeath, walls) {
		const e = core.startOf(String(str));
		vsim.restore(e.snap);
		if (e.dead) return { f: null, c: NaN };
		// (the waypoint's own ordering tiles: a death step's are the tiles a death starts from, planner.js dieField; its
		// goal tiles, the respawn, are where its start stands: c0 0, no skeleton, Tutorial 2's killers 235+ tiles away)
		const f = T.goalField(walls ? withWalls(T.levelNow(L, vsim), walls) : T.levelNow(L, vsim), T.fieldTilesOf(goal), { deaths: !!allowDeath });
		return { f, c: RF.costAt(f, vsim) };
	}
	/** the skeleton's closest in the WAYPOINT's unit (f0: its goal field at the step's starts, the unit of the direct
	 *  leg's FailReport), the deepest level's arrivals as candidates too (the progress the skeleton made). A failed
	 *  skeleton returns its last sub-leg's FailReport, whose closest read "0 tiles" on 84 of the 221 failing levels of the
	 *  chief's full compile b1 (Tutorial 2's trophy leg from the spawn: 0; re-measured here: 347), the number the planner's
	 *  walls / cuts and the strategy's relays take as the waypoint's. OPT-IN (EEAT_SKEL_CLOSEST=1): on 95 levels (gate20 +
	 *  the closest-0 levels, 60 s, par 36) it compiled 5 vs 4 (Tutorial 1) and raised Animaly 1 -> 4, Trail Blazer 3 -> 5,
	 *  Summer Bee / Starlight 0 -> 2, but I Wanna be the Guy 15 -> 1 and The Glitch 5 -> 0: the false 0 was an accidental
	 *  DIVERSIFIER (lane 2's finding for the start-closest): a far leg "reached" makes the planner move on to other
	 *  triggers; with the true number it insists on the far leg. Default on only with an explicit diversification rule. */
	function skelClosest(fc, deep, f0) {
		if (process.env.EEAT_SKEL_CLOSEST !== '1' || !f0) return fc;
		const cands = [];
		if (fc && fc.masks) cands.push(typeof fc.masks === 'string' ? fc.masks : T.strOf(fc.masks));
		for (const s of deep) cands.push(String(s));
		let best = null;
		for (const str of cands) {
			let e;
			try { e = core.startOf(str); } catch (x) { continue; }
			if (e.dead) continue;
			vsim.restore(e.snap);
			const c = RF.costAt(f0, vsim);
			if (!(c >= 0) || (best && c >= best.dist)) continue;
			best = { masks: e.masks, tile: T.tileOf(vsim, L.width, L.height), dist: c, vx: vsim.speed_x, vy: vsim.speed_y, px: vsim.px, py: vsim.py, dead: false };
		}
		if (process.env.EEAT_SKEL_DBG === '1') console.error(`skel closest: sub-leg ${fc ? fc.dist : 'none'} -> waypoint ${best ? best.dist : 'none'} (${cands.length} cands)`);
		return best || fc;
	}
	async function reach(starts, wp, budget) {
		budget = budget || {};
		if (!SKEL_ON || wp.beforeTick >= 0 || wp.beforeRel !== undefined || !starts.length) return reachLeg(starts, wp, budget);
		const tIn = Date.now();
		const ms = budget.ms > 0 ? budget.ms : 3000;
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + ms);
		const startStrs = starts.map((a) => (typeof a === 'string' ? a : T.strOf(a.masks)));
		const goal = T.goalOf(L, wp);
		// (the waypoint field's counterexample walls: the sub-level sets are of the walled field; a call's sub-leg that finds
		// new walls moves the skeleton onto the new field)
		const wk = WALLS_ON ? wallKeyOf(wp) : null;
		let wArr = null, wN = 0;
		const wRefresh = () => { const s = wk ? wallMemo.get(wk) : null; const n = s ? s.size : 0; if (n === wN) return false; wN = n; wArr = n ? Array.from(s) : null; return true; };
		wRefresh();
		let c0 = Infinity, f0 = null;
		const measure = () => {
			c0 = Infinity; f0 = null;
			try {
				for (const s of startStrs) { const r = fieldAt(s, goal, wp.allowDeath, wArr); if (r.f && r.c >= 0 && r.c < c0) { c0 = r.c; f0 = r.f; } }
			} catch (e) { f0 = null; }
			// (walls that cut every start off the waypoint were no counterexample of that field's way: dropped)
			if (wArr && !f0) { wallDropLast(wk, wp.label); wN = -1; wRefresh(); measure(); }
		};
		measure();
		if (!f0 || !(c0 >= SKEL_MIN) || !Number.isFinite(c0)) return reachLeg(starts, wp, budget);
		// (the direct leg first with SKEL_DIRECT of the budget (a leg the finders reach whole keeps its way: the skeleton's
		// split cost PARTIAL levels their progress, SMB3 3 -> 0, Booty Return 14 -> 6); its found leg, or its proof
		// (the exact tier's exhaustion: no time in it), is the answer; else the skeleton with the rest)
		if (SKEL_DIRECT > 0 && !skelMemo.has(skelKey(goal, wp, startStrs, wN))) {
			const dMs = SKEL_DIRECT * (deadline - Date.now());
			const r0 = await reachLeg(starts, wp, { ms: dMs, level: budget.level | 0, k: budget.k, deadline: Math.min(deadline, Date.now() + dMs), stop: budget.stop });
			if (r0.ok || (r0.fail && (r0.fail.why === 'proof' || r0.fail.why === 'stopped' || r0.fail.why === 'dies'))) return r0;
			if (wRefresh()) { measure(); if (!f0 || !Number.isFinite(c0)) return r0; }
		}
		// (resume from the deepest level an earlier call for this step reached)
		let key = skelKey(goal, wp, startStrs, wN);
		const memo = skelMemo.get(key);
		const top = memo && memo.length ? memo[memo.length - 1] : null;
		let cur = top ? top.cur.slice() : startStrs, cCur = top ? top.c : c0;
		const levels = [];
		// (the step adapts: a sub-leg found in under a third of its share doubles it (fast motion: fewer legs, fewer goal
		// fields to build), a failed one halves it for its retry)
		let lastFail = null, sims = 0, retried = false, stuck = false, step = SKEL_STEP;
		while (Date.now() < deadline - 100) {
			// (new counterexample walls from the last sub-leg: the level where the skeleton stands, on the new field)
			if (wRefresh()) {
				let fw;
				try { fw = fieldAt(cur[0], goal, wp.allowDeath, wArr); } catch (e) { fw = { f: null }; }
				if (!fw.f || !(fw.c >= 0)) break;
				cCur = fw.c; step = SKEL_STEP; retried = false; key = skelKey(goal, wp, startStrs, wN);
			}
			const left = deadline - Date.now();
			if (cCur <= SKEL_STEP * 1.5) break;
			const c = Math.max(SKEL_STEP / 2, cCur - step);
			// (the sub-level set on the field of the current arrivals' doors)
			let fr;
			try { fr = fieldAt(cur[0], goal, wp.allowDeath, wArr); } catch (e) { fr = { f: null }; }
			if (!fr.f) break;
			const m = tileMin(fr.f), lim = Math.round(c * 5), tiles = [];
			for (let t = 0; t < m.length; t++) if (m[t] <= lim) tiles.push(t);
			if (!tiles.length) break;
			// (a sub-leg's share: its part of the way (3 steps' worth), at least 300 ms; a failed one once more with half of
			// what is left)
			const share = retried ? Math.max(300, 0.5 * left) : Math.min(left - 50, Math.max(300, left * Math.min(0.5, (3 * step) / cCur)));
			const sub = { kind: 'region', tiles, expect: null, allowDeath: !!wp.allowDeath, fieldTiles: Array.from(T.fieldTilesOf(goal)), fieldTouch: T.fieldTouchOf(goal), label: `${wp.label || wp.kind} (skeleton ${Math.round(c)} tiles)` };
			const r = await reachLeg(cur, sub, { ms: share, level: budget.level | 0, k: budget.k, deadline: Math.min(deadline, Date.now() + share), stop: budget.stop }, true);
			sims += r.sims || 0;
			levels.push({ c: Math.round(c), ok: !!r.ok, ms: r.ms, tool: r.tool });
			if (!r.ok) {
				lastFail = r;
				if (r.fail && r.fail.why === 'stopped') break;
				if (!retried) { retried = true; step = Math.max(SKEL_STEP / 2, step / 2); continue; }
				// (a resumed level whose next sub-leg fails twice: a dead end, one level back next time)
				if (top && levels.length === 2) memo.pop();
				stuck = true;
				break;
			}
			retried = false;
			if (r.ms < share / 3) step = Math.min(SKEL_STEP * 4, step * 2);
			cur = r.arrivals.map((a) => T.strOf(a.masks));
			cCur = c;
			if (!skelMemo.has(key)) skelMemo.set(key, []);
			skelMemo.get(key).push({ c: cCur, cur: cur.slice() });
		}
		if (emit) emit({ ev: 'exec.skel', label: wp.label || '', c0: Math.round(c0), c: Math.round(cCur), resumed: !!memo, levels, walls: wN });
		if (Date.now() >= deadline - 100 || (stuck && cur !== startStrs)) {
			const fail = (lastFail && lastFail.fail) || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: 'skeleton: out of time' };
			const cl = skelClosest(fail.closest, cur !== startStrs ? cur : [], f0);
			return { ok: false, arrivals: [], tool: null, ms: Date.now() - tIn, sims, legs: [], lb: 0, fail: Object.assign({}, fail, { why: 'budget', closest: cl }) };
		}
		// (the last leg to the waypoint itself, from the deepest arrivals reached)
		const r = await reachLeg(cur, wp, { ms: deadline - Date.now(), level: budget.level | 0, k: budget.k, deadline, stop: budget.stop });
		// (a failure after sub-legs is no proof: the time was split)
		if (cur === startStrs) { if (!r.ok && levels.length && r.fail && r.fail.why !== 'stopped') r.fail = Object.assign({}, r.fail, { why: 'budget' }); return r; }
		// (the arrivals' legs are the whole way from the step's own starts: the start that prefixes each)
		if (r.ok) {
			r.legs = r.arrivals.map((a) => {
				let si = -1;
				for (let i = 0; i < startStrs.length; i++) if (a.masks.length >= startStrs[i].length && T.strOf(a.masks.subarray(0, startStrs[i].length)) === startStrs[i] && (si < 0 || startStrs[i].length > startStrs[si].length)) si = i;
				const t0 = si >= 0 ? startStrs[si].length : 0;
				if (a.leg) { a.leg.start = si; a.leg.ticks = a.masks.length - t0; a.leg.tool = 'skel+' + (a.leg.tool || r.tool); }
				return { start: si, ticks: a.masks.length - t0, lb: 0, proven: false, tool: 'skel+' + (r.tool || '') };
			});
			r.lb = 0;
			r.tool = 'skel+' + (r.tool || '');
		} else {
			if (r.fail && r.fail.why !== 'stopped') r.fail = Object.assign({}, r.fail, { why: 'budget' });
		}
		r.ms = Date.now() - tIn;
		return r;
	}
	async function reachLeg(starts, wp, budget, inner) {
		const tIn = Date.now();
		budget = budget || {};
		const ms = budget.ms > 0 ? budget.ms : 3000;
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + ms);
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		S.reach++;
		const startStrs = starts.map((a) => (typeof a === 'string' ? a : T.strOf(a.masks)));
		const w = wpData(wp);
		// (the counterexample walls of this waypoint's field tiles, learnt by the calls before: to the core with the waypoint;
		// walls that cut every start off: their last batch dropped and the call made again without it)
		const wk = WALLS_ON ? wallKeyOf(wp) : null;
		let res;
		for (let attempt = 0; ; attempt++) {
			const wset = wk ? wallMemo.get(wk) : null;
			if (wset && wset.size) w.walls = Array.from(wset); else delete w.walls;
			const wtb = wk ? wallTabu.get(wk) : null;
			if (wtb && wtb.size) w.wallsTabu = Array.from(wtb); else delete w.wallsTabu;
			res = await dispatchLeg(startStrs, w, budget, ms, k, deadline);
			if (!(wk && res && res.fail && res.fail.wallsCut && attempt < 6 && Date.now() < deadline - 100)) break;
			wallDropLast(wk, wp.label);
		}
		// (the walls this call's exhausted search found join its field's; the closest it reports is in the unit of the field
		// with the walls it was given: wallsN, the strategy's relays compare only within one unit)
		if (res && res.fail) {
			const wN0 = w.walls ? w.walls.length : 0;
			if (wk && res.fail.wallsCut) wallDropLast(wk, wp.label);
			else if (wk && Array.isArray(res.fail.walls) && res.fail.walls.length) {
				let s = wallMemo.get(wk);
				if (!s) { s = new Set(); wallMemo.set(wk, s); wallBatches.set(wk, []); }
				const tabu = wallTabu.get(wk);
				const batch = [];
				for (const t of res.fail.walls) { if (s.size >= WALLS_MAX) break; if (!s.has(t) && !(tabu && tabu.has(t))) { s.add(t); batch.push(t); } }
				if (batch.length) { wallBatches.get(wk).push(batch); S.walls += batch.length; if (emit) emit({ ev: 'exec.walls', label: wp.label || '', added: batch.length, total: s.size }); }
			}
			delete res.fail.walls;
			res.fail.wallsN = wN0;
		}
		return finalize(res, starts, wp, tIn);
	}
	/** one core reach (this thread's core without workers, else a worker's): its raw result */
	async function dispatchLeg(startStrs, w, budget, ms, k, deadline) {
		let res;
		if (nW === 0) {
			try { res = await core.reach(startStrs, w, { ms, level: budget.level | 0, k, deadline, stop: budget.stop }); }
			catch (e) { res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: `error: ${e && e.message || e}` } }; }
		} else {
			const sab = new SharedArrayBuffer(4), flag = new Int32Array(sab);
			let poll = null;
			if (typeof budget.stop === 'function') poll = setInterval(() => { try { if (budget.stop()) Atomics.store(flag, 0, 1); } catch (e) { /* ignore */ } }, 20);
			const pending = dispatch({ type: 'reach', starts: startStrs, wp: w, budget: { ms, level: budget.level | 0, k, deadline } }, deadline, sab);
			// (while the worker searches: the starts replayed from the level start in this thread too, for finalize's checks)
			for (const s of startStrs) { try { core.startOf(String(s)); } catch (e) { /* finalize replays it again */ } }
			const msg = await pending;
			if (poll) clearInterval(poll);
			if (msg.error || !msg.result) {
				const why = !msg.watchdog && Atomics.load(flag, 0) ? 'stopped' : 'budget';   // (a late worker told to stop by the watchdog: 'budget', not the caller's stop)
				res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why, closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: msg.error || 'no answer' } };
			} else res = msg.result;
		}
		return res;
	}
	/** the StepResult of a core result: every arrival replayed from the level start in THIS thread (verified: the goal
	 *  first holds at its end, alive, beforeTick), an Arrival with this thread's snapshot and opts.RM's room */
	function finalize(res, starts, wp, tIn) {
		const goal = T.goalOf(L, wp);
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		const out = { ok: false, arrivals: [], tool: res.tool || null, ms: 0, sims: res.sims || 0, legs: res.legs || [], lb: res.lb || 0, fail: res.fail || null, tiers: res.tiers };
		if (res.ok) {
			for (const a of res.arrivals) {
				const masks = T.masksOf(a.masks);
				const st = starts[a.start];
				// (the start's state as this thread replayed it from the level start (core.startOf: cached, the longest
				// replayed prefix reused), then the leg's own inputs)
				const e = st === undefined ? null : core.startOf(typeof st === 'string' ? st : T.strOf(st.masks));
				const vs = e && masks.length >= e.tick && a.masks.startsWith(e.str) ? vsim : null;
				if (!vs || !verifyTail(vs, vinp, e.snap, e.tick, masks.subarray(e.tick), goal, beforeTick, !!wp.allowDeath)) { S.verifyDrop++; continue; }
				const arr = T.arrivalOf(L, vs, masks, RM);
				arr.leg = { start: a.start, ticks: a.ticks, tool: res.tool };
				out.arrivals.push(arr);
			}
			if (out.arrivals.length) out.ok = true;
			else { out.tool = null; out.fail = { why: 'budget', closest: null, touched: [], blockedBy: [], level: 0, note: 'no arrival survived the replay' }; }
		}
		if (out.fail && out.fail.closest && typeof out.fail.closest.masks === 'string') out.fail.closest.masks = T.masksOf(out.fail.closest.masks);
		out.ms = Date.now() - tIn;
		S.ms += out.ms; S.sims += out.sims;
		if (out.ok) { S.ok++; S.byTool[out.tool] = (S.byTool[out.tool] || 0) + 1; } else { S.fail++; const w = out.fail ? out.fail.why : '?'; S.byWhy[w] = (S.byWhy[w] || 0) + 1; }
		if (emit) emit({ ev: 'exec.reach', label: wp.label || '', ok: out.ok, tool: out.tool, ms: out.ms, sims: out.sims, legs: out.legs, lb: out.lb, why: out.fail ? out.fail.why : null });
		return out;
	}

	async function polish(masks, o) {
		o = o || {};
		S.polish++;
		const str = typeof masks === 'string' ? masks : T.strOf(masks);
		const po = { ms: o.ms > 0 ? o.ms : 30000, legs: o.legs || null, allowDeaths: o.allowDeaths !== false };
		let r;
		// (with 2+ workers the first mutation pass (polish.js (a2)) scans the route's ranges on every worker at once, its
		// shortcuts handed to the polish in one worker (o.first); the time it took is taken off the polish)
		if (nW >= 2 && process.env.EEAT_PAR_POLISH !== '0') {
			const t1 = Date.now();
			const n = T.masksOf(str).length;
			const parts = Math.min(nW, Math.max(1, Math.floor(n / 64)));
			const dl = t1 + 0.5 * po.ms;
			const jobs = [];
			for (let k = 0; k < parts; k++) {
				const a = Math.floor((k * n) / parts), b = Math.floor(((k + 1) * n) / parts);
				jobs.push(dispatch({ type: 'mutscan', masks: str, o: { ranges: [[a, b]], deadline: dl } }, dl + 5000, new SharedArrayBuffer(4)));
			}
			const res = await Promise.all(jobs);
			if (res.every((m) => m && m.result)) {
				po.first = [].concat(...res.map((m) => m.result.shortcuts));
				po.firstTimeUp = res.some((m) => m.result.timeUp);
			}
			po.ms = Math.max(1, po.ms - (Date.now() - t1));
		}
		if (nW === 0) r = await core.polish(str, po);
		else {
			const msg = await dispatch({ type: 'polish', masks: str, o: po }, Date.now() + po.ms + 5000, new SharedArrayBuffer(4));
			r = msg && msg.result ? msg.result : null;
			if (!r) r = await core.polish(str, Object.assign({}, po, { ms: Math.min(po.ms, 2000) }));
		}
		// (never a slower or unfinished route: checked here again)
		const C = require('../common.js');
		const m0 = typeof masks === 'string' ? T.masksOf(masks) : masks;
		const ev0 = C.evaluate(L, m0, false);
		const m1 = typeof r.masks === 'string' ? T.masksOf(r.masks) : r.masks;
		const ev1 = C.evaluate(L, m1, false);
		if (!ev1 || (ev0 && (ev1.runTicks > ev0.runTicks))) return { masks: ev0 ? ev0.ms : m0, runTicks: ev0 ? ev0.runTicks : -1, saved: 0, legs: r.legs || [] };
		return { masks: ev1.ms, runTicks: ev1.runTicks, saved: ev0 ? ev0.runTicks - ev1.runTicks : 0, legs: r.legs || [], steps: r.steps };
	}
	function stats() { return Object.assign({ workers: nW, notes: note.slice(), core: nW === 0 ? core.stats() : null }, S); }
	async function close() {
		closed = true;
		for (const slot of pool) { slot.dead = true; try { await slot.w.terminate(); } catch (e) { /* gone */ } }
		pool.length = 0;
		for (const q of queue.splice(0)) q.resolve({ id: 0, error: 'closed' });
	}
	return { reach, polish, stats, close, workers: () => nW };
}

module.exports = { createExecutor, makeCore, verifyLeg, verifyTail, fingerprint, wpData, BASE_FEATS };
