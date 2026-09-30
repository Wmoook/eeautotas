'use strict';
// THE COMPILER'S DRIVER (n4plan, part 'strategy'; contract v2 "THE COMPILER" in src/plan/types.js):
//   .eelvl -> parse -> MODEL -> BOUNDS -> PLAN -> MOVES -> VERIFY -> POLISH -> .eetas + a report (run ticks, the
//   admissible lower bound, the gap, per leg: ticks / bound / proven / tool, the best known TAS of the level).
// No search here and no GPU: the parts plan (planner), derive moves from the physics (executor, primitives) and bound
// (bounds); this file runs UNDERSTAND -> PLAN -> EXECUTE -> REFINE (CEGAR) on them and never calls goexplore.js' search,
// bursts.js, heat.js or an eegpu tool (goexplore.js roomOf, a pure function, keys the arrivals' rooms: the contract's RM).
//
//   model   = await compileModel(L, {file})           the level model (src/plan/model.js)
//   bounds  = createBounds(L, {model})                admissible tick bounds (src/plan/bounds.js; optional)
//   facts   = createFacts({rungs: 4, model})          what the loop learnt (CEGAR)
//   planner = createPlanner(model, facts, {bounds})
//   prims   = await createPrims(L, {...})             exact motion primitives (optional)
//   exec    = await createExecutor(L, {...})          reach(starts, waypoint, budget), polish(masks, o)
//   anchors = {start}: REAL states (arrivals replayed by the engine here), one per model state (S.key), up to 4 diverse
//   loop:   pick an anchor (the most progress, then the lowest plan cost + its arrival tick) -> plans = planner.plan(anchor)
//           -> the first step of the best plan not in flight -> exec.reach(anchor's arrivals, step.waypoint, budget(rung))
//           -> planner.learn(step, result, anchor) -> every verified arrival with a new model state is a new anchor
//   receding horizon: only a plan's first step runs; the planner plans again from the real arrival.
//   after a route: branch and bound over the trigger orders (plans whose admissible lb cannot beat the best are not run;
//   arrivals whose run ticks already reach the best are dropped: both proofs), then the polish (exec.polish, else the
//   route cleanup src/cleanroute.js), then the verify (C.evaluate: it finishes, no more deaths).
//
// THE NO-STALL CLOCK: a step's budget is its rung's (RUNG_MS 1.5, 5, 15, 45 s) x 2^deepenings, capped by the time left
// (the polish's reserve kept once a route is known). The planner moves a failed (edge, nodeClass) up a rung (facts), a
// proof blocks it. Here: every executed step must add an anchor or change a fact (else a 'bug' event and the triple
// blocked here); no triple (edge, nodeClass, rung) runs twice in one deepening epoch; everything exhausted -> a global
// deepening (facts.reset keepProofs, budgets x2) or the end 'exhausted'; the watchdog calls a STALL when no anchor was
// added and no fact changed for its window while no step is inside its budget: a 'stall' event with WHY (the last steps,
// their fail reports, the planner's explain()), the first one a deepening, later ones exploration steps (region waypoints
// on each anchor's unvisited walk frontier); with stallS > 0 no progress for stallS s ends 'stalled'.
//
// Every route is C.evaluate'd and every arrival replayed here (T.playTo's rule + the waypoint's goal test, its beforeTick
// too) before it becomes an anchor: a part that returns an arrival that does not replay is a 'bug' event, the arrival
// dropped.
//
// Events (JSON lines through emit, t = s since the start): start, stage {name, ms, text}, model, plan, step, fact, source
// ({inputs, key, tick, room, desc, gain, anchor, label}: a verified arrival with a new model state), import, result
// ({kind 'finish', runTicks, ticks, inputs, lb, gap, how}), progress ({detail: the page's status line, e.g. "plan: step
// 5/12 'purple switch 3' rung 1 · 7 anchors · route 6,234 (lb 3,210, gap 48%)"}), stall ({why}), bug, deepen, warning,
// done ({end, runTicks, lb, gap}).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./types.js');
const E = require('../eesim.js');

const RUNG_MS = [1500, 5000, 15000, 45000];
const PROGRESS_MS = 2000, WATCH_MS = 2000, SAVE_MS = 60000;
// the watchdog's window: STALL_F of the budget, at least STALL_MIN_S, at most STALL_S
const STALL_S = 60, STALL_MIN_S = 5, STALL_F = 1 / 6;
// the anchor pick: the most progress (model gain), then the plan's cost + the arrival tick + FAIL_TICKS x its failed
// steps - UCB_C x sqrt(ln N / (1 + picks)) (a little fairness among equals)
const FAIL_TICKS = 200, UCB_C = 100;
const ARRIVALS_K = 4, MAX_DEEPEN = 4, STEER_MISS = 6000;
// the polish's share of the budget once a route is known: min(POLISH_MS, POLISH_F x the budget)
const POLISH_MS = 15000, POLISH_F = 0.25;
// the proof's share once a route is known (a static level start only): min(PROVE_MS, PROVE_F x the budget) kept for the
// PROVE stage (one exact search from the level start bounded by the route's own arrival), and all the time the moves leave
const PROVE_MS = 30000, PROVE_F = 0.2;
// the exact landing (precision.js): a trophy leg's nearest state within PREC_NEAR tiles (the goal field's), at most
// PREC_RUNS runs a compile of at most PREC_S s (at least PREC_MIN_S left), its PREC_ATTEMPTS nearest attempts
const PREC_NEAR = 8, PREC_RUNS = 3, PREC_S = 40, PREC_MIN_S = 6, PREC_ATTEMPTS = 8;
// the proof's starts: the level start after k = 0..R idle ticks, R = the idle ticks until the state rests (the timer starts
// at the first input: waiting is free); at most PROVE_IDLE_MAX (one exact search each)
const PROVE_IDLE_MAX = 64;
// the proof's rounds: a faster route found by its searches becomes the best and the proof starts over with its cost
const PROVE_ROUNDS = 12;
// exploration steps (the second stall on): frontier tiles within FRONTIER_STEPS walk steps of an anchor, at most FRONTIER_MAX
const FRONTIER_STEPS = 60, FRONTIER_MAX = 400;
// the fallbacks when the planner has nothing left (fallbackJob): at most this many without a new anchor
const FALLBACK_MAX = 6;
// the arrivals' own bounds for the branch and bound (the planner's lowerBound from one arrival: a short search); the start's
// bound gets LB_MS; a lowerBound call that took LB_SLOW_MS or more is not made again that compile (a synchronous part that
// overruns its budget cannot be cut: Moving Ice Puzzle's took 90 s with 1.5 s asked)
const ARR_LB_MS = 25, ARR_LB_EXPAND = 20000, LB_MS = 1500, LB_SLOW_MS = 5000;
// (the start's bound in the bounds stage gets LB0_MS: it only reports (the report's lb, the polish's stop) until the end,
// where the refresh takes the whole LB_MS again and keeps the larger; the stage's clock goes to the moves instead)
const LB0_MS = +process.env.EEAT_LB0_MS || 500;
/** a relative deadline (a step's or a waypoint's beforeTickFrom): a number, or 'prev+N' (N ticks after the previous
 *  step's arrival, i.e. this anchor's arrival: a key's KEY_TICKS) -> ticks | NaN */
function relOf(x) {
	if (typeof x === 'number') return x;
	const m = /^\s*(?:prev\s*\+\s*)?(\d+)\s*$/.exec(String(x === undefined || x === null ? '' : x));
	return m ? +m[1] : NaN;
}

const MOD = { compileModel: './model.js', createFacts: './facts.js', createPlanner: './planner.js', createExecutor: './executor.js' };
/** the parts: opts.parts (an object, or a module path: tests inject mocks), else src/plan/*.js (lazy); the bounds and the
 *  primitives are optional (null: a 'warning' event, never a crash) */
function partsOf(opts, say) {
	let given = opts.parts || {};
	if (typeof given === 'string') given = require(path.resolve(given));
	const P = Object.assign({}, given);
	for (const [name, file] of Object.entries(MOD)) {
		if (typeof P[name] === 'function') continue;
		let m;
		try { m = require(file); } catch (e) {
			if (e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(`'${file}'`)) throw new Error(`the compiler's part ${path.basename(file)} is not built yet (src/plan/${path.basename(file)} missing)`);
			throw e;
		}
		if (typeof m[name] !== 'function') throw new Error(`src/plan/${path.basename(file)} has no ${name}()`);
		P[name] = m[name];
	}
	const optional = (name, file, what) => {
		if (typeof P[name] === 'function' || P[name] === null) return;
		try { const m = require(file); P[name] = typeof m[name] === 'function' ? m[name] : null; if (!P[name]) say({ ev: 'warning', text: `${what}: ${path.basename(file)} has no ${name}()` }); } catch (e) {
			P[name] = null;
			const missing = e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(`'${file}'`);
			say({ ev: 'warning', text: `${what} (${missing ? `src/plan/${path.basename(file)} missing` : e.message}): the compiler without them` });
		}
	};
	optional('createBounds', './bounds.js', 'no admissible bounds');
	optional('createPrims', './prims.js', 'no motion primitives');
	return P;
}

const factsVer = (facts) => (facts ? (typeof facts.version === 'function' ? facts.version() : +facts.version || 0) : 0);
const edgeKey = (step) => `${step.edge}|${step.nodeClass === undefined ? '' : step.nodeClass}`;
const labelOf = (step) => (step && step.waypoint && step.waypoint.label) || (step && String(step.edge)) || '?';
const cnt = (x) => (x == null ? undefined : Array.isArray(x) ? x.length : x instanceof Map || x instanceof Set ? x.size : typeof x === 'number' ? x : typeof x === 'object' ? Object.keys(x).length : undefined);
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n));
const fmt = (t) => require('../common.js').fmt(t);
/** a plan() answer as {plans, why}: an array (maybe with .why) or {plans, why} */
function plansOf(r) {
	if (Array.isArray(r)) return { plans: r.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || (r.length ? '' : 'exhausted') };
	if (r && Array.isArray(r.plans)) return { plans: r.plans.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || '' };
	return { plans: [], why: (r && r.why) || 'exhausted' };
}
/** a lowerBound() answer's ticks (admissible; Infinity: no way in the planner's relaxation, a proof there), else 0 */
const lbTicks = (r) => {
	const v = r && typeof r === 'object' ? +r.ticks : +r;
	return v === Infinity ? Infinity : Number.isFinite(v) && v > 0 ? v : 0;
};
/**
 * idleRunLB(L, bounds, goal) -> run ticks: an admissible bound on a route's RUN ticks from the level start by the bounds'
 * leg() (ticks from a state to the goal): the timer starts at the end of the first tick with an input, and before it the
 * ball follows its idle trajectory for free, so a route whose first input is at tick i finishes at least leg(idle_i) - 1
 * run ticks after its timer's start: the least of those over the idle trajectory (until the ball rests: its state no
 * longer changes); 0 when it has not come to rest within IDLE_MAX ticks (no claim)
 */
const IDLE_MAX = 3000;
function idleRunLB(L, bounds, goal) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	// (first the idle trajectory alone: a ball that does not rest within IDLE_MAX ticks gets 0 (no claim) either way, so its
	// IDLE_MAX + 1 bounds.leg calls (1.2-3.7 s on 8 of the 15 STAGE-TIME levels: a clock in the state never repeats) are
	// not made)
	{
		sim.reset(); E.applyMask(inp, 0);
		let h = sim.stateHash(), rests = false;
		for (let i = 0; i <= IDLE_MAX && !rests; i++) {
			if (sim.has_silver_crown) return 0;
			sim.tick(inp);
			const h2 = sim.stateHash();
			if (h2 === h && !sim.is_dead) rests = true;
			h = h2;
		}
		if (!rests) return 0;
	}
	sim.reset();
	E.applyMask(inp, 0);
	let lb = Infinity, h = sim.stateHash();
	for (let i = 0; i <= IDLE_MAX; i++) {
		if (sim.has_silver_crown) return 0;
		const v = lbTicks(bounds.leg(sim, goal));
		lb = Math.min(lb, v === Infinity ? Infinity : v - 1);
		if (lb <= 0) return 0;
		sim.tick(inp);
		const h2 = sim.stateHash();
		if (h2 === h && !sim.is_dead) return Number.isFinite(lb) ? Math.max(0, lb) : 0;
		h = h2;
	}
	return 0;
}
/** the md5 of a file (null: none) */
function md5Of(file) { try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; } }

// ---------------------------------------------------------------- the best known TAS of a level (src/plan/truthset.js)
let KNOWN = null;   // {root, byMd5: Map(md5 -> [entry])}
/** knownOf(file, o) -> {runTicks, source, name} | null: the fastest known route (the user's jobs, the benchmark runs) of the
 *  level whose file has the same bytes (md5), each replayed (truthset.loadTruth: a stale one does not count) */
function knownOf(file, o = {}) {
	const md5 = o.md5 || (file ? md5Of(file) : null);
	if (!md5) return null;
	const TS = require('./truthset.js');
	const root = o.root || process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..');
	if (!KNOWN || KNOWN.root !== root) {
		const byMd5 = new Map(), fileMd5 = new Map();
		let list = [];
		try { list = TS.knownRoutes({ root }); } catch (e) { list = []; }
		for (const e of list) {
			let m = fileMd5.get(e.levelFile);
			if (m === undefined) { m = md5Of(e.levelFile); fileMd5.set(e.levelFile, m); }
			if (!m) continue;
			if (!byMd5.has(m)) byMd5.set(m, []);
			byMd5.get(m).push(e);
		}
		KNOWN = { root, byMd5 };
	}
	let best = null;
	for (const e of KNOWN.byMd5.get(md5) || []) {
		let t = null;
		try { t = TS.loadTruth(e); } catch (err) { t = null; }
		if (t && (!best || t.runTicks < best.runTicks)) best = { runTicks: t.runTicks, source: e.source === 'job' ? `job '${e.name}'` : `benchmark run ${path.relative(root, e.route).replace(/\\/g, '/')}`, name: e.name };
	}
	return best;
}

/**
 * compile(L, opts, emit) -> Promise<CompileResult {ok, masks, runTicks, ticks, deaths, lb, gap, legs: [{label, fromTick,
 * ticks, lb, proven, tool}], stages: {parse, model, bounds, plan, moves, verify, polish} (ms), known: {runTicks, source} |
 * null, why, end, route, anchors, steps, okSteps, bugs, deepenings, stalls}>
 * opts: {file, seconds (60), workers (2), inflight (workers: steps in flight), seed (1), first (stop at the first route),
 * polish (true), stallS (0: none), out (a dir: facts.json, anchors.json, events.jsonl, route.eetas), parts (mocks: an
 * object or a module path), stdinLines (an async iterable of lines: depth / stop / route / import / steer), stopOnStdinEnd,
 * depth (ticks: only routes of at most this many ticks), bound (run ticks: a known route's, the B&B's bound), known (an
 * object, false: none; default: looked up by the file's md5), md5, parseMs, sourceDist (the source events' dist on the
 * editor's scale: a reach field), steer, RM, rungMs / stallWindowS / watchMs / progressMs (tests), maxDeepen}
 */
async function compile(L, opts = {}, emit = () => {}) {
	const t0 = Date.now();
	const seconds = +opts.seconds > 0 ? +opts.seconds : 60;
	const total = seconds * 1000;
	const workers = Math.max(1, Math.round(+opts.workers || 2));
	const P = Math.max(1, Math.round(+opts.inflight || workers));
	const rungMs = Array.isArray(opts.rungMs) ? opts.rungMs : RUNG_MS;
	const stallWindow = (+opts.stallWindowS > 0 ? +opts.stallWindowS : Math.max(STALL_MIN_S, Math.min(STALL_S, seconds * STALL_F))) * 1000;
	const watchMs = +opts.watchMs > 0 ? +opts.watchMs : WATCH_MS;
	const progressMs = +opts.progressMs > 0 ? +opts.progressMs : PROGRESS_MS;
	const maxDeepen = Number.isFinite(+opts.maxDeepen) ? +opts.maxDeepen : MAX_DEEPEN;
	const polishOn = opts.polish !== false;
	const polishReserve = polishOn ? Math.min(POLISH_MS, POLISH_F * total) : 0;
	const proveOn = opts.prove !== false;
	// (the reserve kept once a route is known: the polish's, and the proof's where the start is static (set below))
	let proveReserve = 0, endReserve = polishReserve;
	const C = require('../common.js');
	// ---- the event log (out/events.jsonl) next to emit
	const out = opts.out ? String(opts.out) : '';
	let evBuf = [];
	if (out) { try { fs.mkdirSync(out, { recursive: true }); } catch (e) { /* none */ } }
	const flushEvents = () => { if (!out || !evBuf.length) return; try { fs.appendFileSync(path.join(out, 'events.jsonl'), evBuf.join('\n') + '\n'); } catch (e) { /* read-only */ } evBuf = []; };
	const say = (ev) => {
		ev.t = Math.round((Date.now() - t0) / 100) / 10;
		emit(ev);
		if (out) { evBuf.push(JSON.stringify(ev)); if (evBuf.length > 5000) flushEvents(); }
	};
	const secNow = () => (Date.now() - t0) / 1000;
	const left = () => total - (Date.now() - t0);
	const stages = { parse: Math.round(+opts.parseMs || 0), model: 0, bounds: 0, plan: 0, moves: 0, verify: 0, polish: 0, prove: 0 };
	const stage = (name, ms, text) => { stages[name] = Math.round(ms); say({ ev: 'stage', name, ms: Math.round(ms), text }); };

	// ---- the parts
	const parts = partsOf(opts, say);
	let tm = Date.now();
	const model = await parts.compileModel(L, { file: opts.file, seed: opts.seed });
	const nTrig = cnt(model.triggers), nFeat = cnt(model.feats), nGate = cnt(model.gates !== undefined ? model.gates : model.doors);
	say({ ev: 'model', triggers: nTrig, feats: nFeat, gates: nGate, regions: cnt(model.regions), ms: Date.now() - tm });
	stage('model', Date.now() - tm, `${nTrig === undefined ? '?' : nTrig} trigger${nTrig === 1 ? '' : 's'}, ${nFeat === undefined ? '?' : nFeat} feature${nFeat === 1 ? '' : 's'}, ${nGate === undefined ? '?' : nGate} gate${nGate === 1 ? '' : 's'}`);
	tm = Date.now();
	let bounds = null;
	if (parts.createBounds) {
		try { bounds = await parts.createBounds(L, { model }); } catch (e) { bounds = null; say({ ev: 'warning', text: `the bounds could not be built (${e.message}): no admissible bound but the planner's` }); }
	}
	const facts = parts.createFacts({ rungs: 4, model });
	// (the planner's floor probe runs in a worker thread off the bounds stage: EEAT_PLAN_FLOOR_ASYNC=0 in line, as before)
	const planner = parts.createPlanner(model, facts, { bounds, seed: opts.seed, file: opts.file, floorAsync: process.env.EEAT_PLAN_FLOOR_ASYNC !== '0' });
	const floorVerOf = () => { try { return typeof planner.floorVersion === 'function' ? planner.floorVersion() : 0; } catch (e) { return 0; } };
	// (the arrivals' room: goexplore.js roomOf, a pure function of the level: the contract's RM, no search)
	const GX = opts.RM ? null : require('../goexplore.js');
	const RM = opts.RM || GX.roomOf(L);
	// (the primitives and the executor start after the first plan: their start-up counts in the moves)
	let prims = null, exec = null;

	// ---- a scratch engine for model states
	const scratch = new E.EESim(L);
	/** the sim at an arrival's end: its snapshot (checked by its hash) or a replay of its masks */
	const simOf = (a) => {
		if (a.snap) { try { scratch.reset(); scratch.restore(a.snap); if (!a.hash || scratch.stateHash() === a.hash) return scratch; } catch (e) { /* replay */ } }
		return T.playTo(L, a.masks, { allowDeath: true }).sim;
	};
	const visited = new Uint8Array(L.width * L.height);   // tiles along verified arrivals (the exploration frontier)
	/** a replay of masks from the level start: the goal's first tick (and beforeTick), deaths, the finish, the run timer at
	 *  the end; marks the visited tiles */
	const replay = (masks, goal, allowDeath) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let dead = -1, finished = -1, goalAt = -1;
		const W = L.width, H = L.height;
		for (let t = 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t] & 31);
			sim.tick(inp);
			if (sim.is_dead) { if (dead < 0) dead = t + 1; if (!allowDeath) break; } else visited[T.tileOf(sim, W, H)] = 1;
			if (finished < 0 && sim.has_silver_crown) finished = t + 1;
			if (goal && goalAt < 0 && goal.test(sim)) goalAt = t + 1;
		}
		return { sim, dead, finished, goalAt, run: sim.run_ticks };
	};

	// ---- the start, the admissible lower bound
	const r0 = T.playTo(L, new Uint8Array(0));
	const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0, leg: null });
	const S0 = model.stateOf(r0.sim);
	// (a static start: one idle tick leaves the state as it is (no fall, no clock the state holds: time doors): waiting before
	// the first input then changes nothing, so the fewest ticks from the start is the fewest run ticks + 1)
	const startStatic = (() => { try { const r1 = T.playTo(L, new Uint8Array(1)); return !r1.sim.is_dead && r1.sim.stateHash() === r0.sim.stateHash(); } catch (e) { return false; } })();
	const startAnchorArg = { arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 };
	// (the idle ticks until the start rests: its state hash repeats; -1 = not within PROVE_IDLE_MAX, or the ball dies idling)
	const restIdle = (() => {
		try {
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			let h = sim.stateHash();
			for (let k = 0; k <= PROVE_IDLE_MAX; k++) { E.applyMask(inp, 0); sim.tick(inp); if (sim.is_dead) return -1; const h2 = sim.stateHash(); if (h2 === h) return k; h = h2; }
		} catch (e) { /* none */ }
		return -1;
	})();
	if (proveOn && restIdle >= 0) { proveReserve = Math.min(PROVE_MS, PROVE_F * total); endReserve = polishReserve + proveReserve; }
	let lbPlanner = 0, lbBounds = 0, lbComplete = false, lbInf = false;
	// (a part that overruns its own budget cannot be cut here (a synchronous call): the call is timed, and one that took
	// LB_SLOW_MS or more is not made again this compile (the arrivals' bounds, the refresh at the end))
	let lbSlow = false, planSlowSaid = false;
	try { const tq = Date.now(); const r = planner.lowerBound ? planner.lowerBound(startAnchorArg, { ms: LB0_MS }) : null; lbPlanner = lbTicks(r); lbComplete = !!(r && r.complete); if (Date.now() - tq >= LB_SLOW_MS) { lbSlow = true; say({ ev: 'warning', text: `the planner's lowerBound took ${((Date.now() - tq) / 1000).toFixed(1)} s (asked ${LB0_MS / 1000} s): not called again this compile` }); } } catch (e) { say({ ev: 'bug', what: 'lowerBound', error: e.message }); }
	if (lbPlanner === Infinity) { lbInf = true; lbPlanner = 0; say({ ev: 'warning', text: 'the planner\'s lower bound from the start is infinite: no way to the trophy in its relaxation (a proof there, if the model is sound); the moves try anyway' }); }
	if (bounds && typeof bounds.leg === 'function') {
		try { lbBounds = idleRunLB(L, bounds, T.goalOf(L, { kind: 'trophy', label: 'trophy' })); } catch (e) { say({ ev: 'warning', text: `bounds.leg: ${e.message}` }); }
	}
	let LB = Math.max(lbPlanner, lbBounds);
	stage('bounds', Date.now() - tm, (LB > 0 ? `lower bound ${num(LB)} run ticks from the start${lbPlanner && lbBounds ? ` (planner ${num(lbPlanner)}, physics ${num(lbBounds)})` : lbBounds ? ' (physics)' : ''}${lbPlanner && !lbComplete ? ' (the planner\'s search cut: its open list\'s least f)' : ''}`
		: 'no admissible bound (none of the parts gives one): 0') + (lbInf ? '; the planner\'s relaxation finds no way to the trophy' : ''));

	// ---- the distances of the 'source' events (the editor's scale: the steer field's tiles, else STEER_MISS + the reach
	// field's; only with opts.sourceDist or a steer file: a reach field costs a build)
	const RF = require('../reach.js');
	let reachF = null, steer = null;
	const reachOf = () => { if (!reachF) { try { reachF = RF.reachField(L, { deaths: false }); } catch (e) { reachF = false; } } return reachF || null; };
	const loadSteer = (file) => {
		try { const SF = require('../steer.js'); steer = { SF, st: SF.readSteerFile(fs.readFileSync(file)), file }; return true; } catch (e) { say({ ev: 'warning', text: `steer file ${file}: ${e.message}` }); return false; }
	};
	if (opts.steer) loadSteer(opts.steer);
	const distOf = (sim) => {
		if (steer) { const v = steer.SF.steerAt(steer.st, sim); if (Number.isFinite(v)) return v; }
		if (!opts.sourceDist) return undefined;
		const f = reachOf(); const c = f ? RF.costAt(f, sim) : -1;
		return c >= 0 ? Math.min(9990, STEER_MISS + c) : 9990;
	};

	// ---- legs: every verified arrival's leg (the step that made it, from which start), for the route's report
	const legs = new Map();   // legId -> {label, fromTick, ticks, lb, proven, tool, prev (legId | null)}
	let legSeq = 0;
	const addLeg = (o) => { const id = ++legSeq; legs.set(id, o); return id; };
	const chainOf = (id) => {
		const list = [];
		for (let k = id, n = 0; k && n < 10000; n++) { const g = legs.get(k); if (!g) break; list.push(g); k = g.prev; }
		return list.reverse().map((g) => ({ label: g.label, fromTick: g.fromTick, ticks: g.ticks, lb: Number.isFinite(g.lb) ? g.lb : null, proven: !!g.proven, tool: g.tool || null }));
	};

	// ---- anchors
	const anchors = new Map();   // S.key -> anchor
	let anchorSeq = 0, lastProgress = Date.now(), progressVer = factsVer(facts), steps = 0, okSteps = 0, failSteps = 0, picksN = 0, bnbPlans = 0, bnbArrivals = 0, lateArrivals = 0;
	// (the relay starts: per (anchor id, edge) the nearest state its failed rungs reached, a start of its next rung;
	// EEAT_RELAY=0: off)
	const RELAY = process.env.EEAT_RELAY !== '0', RELAY_GAIN = 1;
	const relays = new Map(), relayFloor = new Map();
	let relayRuns = 0, relaySet = 0, relayDrop = 0;
	const runMinOf = (A) => A.arrivals.reduce((m, a) => Math.min(m, a.run > 0 ? a.run : 0), Infinity);
	const startedOf = (A) => A.arrivals.every((a) => a.run > 0);
	const gainOf = (S, parent) => {
		if (S && Number.isFinite(+S.gain)) return +S.gain;
		if (S && S.triggers && (Array.isArray(S.triggers) || S.triggers instanceof Set)) return Array.isArray(S.triggers) ? S.triggers.length : S.triggers.size;
		return parent ? parent.gain + 1 : 0;
	};
	/** a verified arrival a (its model state S): a new anchor, or one more diverse arrival of a known one -> {anchor, isNew, changed} */
	const addArrival = (a, S, parent, why) => {
		const key = String(S.key);
		let A = anchors.get(key);
		if (!A) {
			A = { id: ++anchorSeq, key, S, arrivals: [a], firstTick: a.tick, picks: 0, fails: 0, exhausted: false, why: '', gain: gainOf(S, parent), parent: parent ? parent.key : null,
				depth: parent ? parent.depth + 1 : 0, costEst: parent && Number.isFinite(parent.nextCost) ? parent.nextCost : Infinity, costVer: -1, plans: null, via: why };
			anchors.set(key, A);
			lastProgress = Date.now();
			return { anchor: A, isNew: true };
		}
		const before = A.arrivals.map((x) => x.hash).join(',');
		A.arrivals = T.pickDiverse(A.arrivals.concat([a]), ARRIVALS_K);
		if (a.tick < A.firstTick) A.firstTick = a.tick;
		return { anchor: A, isNew: false, changed: A.arrivals.map((x) => x.hash).join(',') !== before };
	};
	addArrival(a0, S0, null, 'start');

	// ---- the route and the bounds: tickBound (stdin "depth D": only routes of at most D ticks), the B&B's run-tick bound
	// (the best route's, or a known route's: stdin "route", opts.bound)
	let tickBound = Number.isFinite(+opts.depth) && +opts.depth > 0 ? +opts.depth : Infinity;
	let extBound = Number.isFinite(+opts.bound) && +opts.bound > 0 ? +opts.bound : Infinity;
	let best = null;   // {masks, ticks, runTicks, deaths, chance, legs, how}
	const runBound = () => Math.min(best ? best.runTicks : Infinity, extBound);
	const gapOf = (rt) => (Number.isFinite(rt) ? Math.max(0, rt - LB) : null);
	/** a route (masks that finish): C.evaluate'd; the best when faster (run ticks, then ticks) -> {ev, better} | null */
	const routeOf = (masks, how, legId) => {
		const ev = C.evaluate(L, masks);
		if (!ev) return null;
		if (ev.complete > tickBound) return { ev, better: false };
		const better = !best || ev.runTicks < best.runTicks || (ev.runTicks === best.runTicks && ev.complete < best.ticks);
		if (!better) return { ev, better: false };
		best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: legId ? chainOf(legId) : [], how };
		say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
		if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
		lastProgress = Date.now();
		return { ev, better: true };
	};

	// ---- THE EXACT LANDING (src/precision.js as a child process: it never blocks this thread): a trophy leg whose nearest
	// state is within PREC_NEAR tiles of the trophy and that no tier reached is the signature of a ZERO-WIDTH window: a way
	// that needs ONE exact sub-pixel x (a spike's centre rule on one side, a half block's solid half on the other: the box
	// must drop at px == 5720.0 exactly, one double on a grid of 2^-40 px). Every static x constraint of the engine sits on
	// a multiple of 8 px, so the target x is COMPUTED (the nudge test), and the inputs that reach it exactly are COMPUTED
	// too (a meet in the middle of the engine's own rest-to-rest moves: exact pieces that sum to the target). No search of
	// the old paradigm; every route it prints is C.evaluate'd there and again here (routeOf). The attempts: the trophy
	// legs' nearest states (fail.closest), nearest first.
	const precOn = opts.precision !== false && process.env.EEAT_PLAN_PREC !== '0' && !!opts.file;
	const precAtt = new Map();   // masks string -> dist
	let precRuns = 0, precBusy = false, precChild = null;
	const precision = async (closest) => {
		if (!precOn || !closest || !closest.masks || !(closest.dist >= 0) || closest.dist > PREC_NEAR) return null;
		const str = typeof closest.masks === 'string' ? closest.masks : T.strOf(closest.masks);
		if (!/^[0-O]+$/.test(str)) return null;
		const had = precAtt.size;
		if (!precAtt.has(str)) precAtt.set(str, +closest.dist);
		if (precBusy || precRuns >= PREC_RUNS || precAtt.size === had || stopped) return null;
		const secs = Math.floor(Math.min(PREC_S * 1000, left() - endReserve - 2000) / 1000);
		if (secs < PREC_MIN_S) return null;
		precBusy = true; precRuns++;
		const os = require('os'), cp = require('child_process');
		const att = [...precAtt].sort((a, b) => a[1] - b[1]).slice(0, PREC_ATTEMPTS).map((e) => e[0]);
		const file = path.join(os.tmpdir(), `eeat_prec_${process.pid}_${precRuns}.txt`);
		const t1 = Date.now();
		let found = null, done = null;
		try {
			fs.writeFileSync(file, att.join('\n') + '\n');
			say({ ev: 'precision', run: precRuns, attempts: att.length, nearest: Math.round(+precAtt.get(att[0]) * 10) / 10, seconds: secs });
			await new Promise((resolve) => {
				const pw = Math.max(1, Math.min(workers, 4));
				const ch = cp.spawn(process.execPath, [path.join(__dirname, '..', 'precision.js'), String(opts.file), `--attempts=${file}`, `--workers=${pw}`, `--seconds=${secs}`, '--first=1'], { stdio: ['ignore', 'pipe', 'ignore'] });
				precChild = ch;
				const onExit = () => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } };
				process.once('exit', onExit);
				ch.on('close', () => process.removeListener('exit', onExit));
				let buf = '';
				const kill = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }, (secs + 10) * 1000);
				const poll = setInterval(() => { if (stopped || left() <= 0) { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } } }, 500);
				ch.stdout.on('data', (d) => {
					buf += d;
					let k;
					while ((k = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, k); buf = buf.slice(k + 1);
						let ev = null;
						try { ev = JSON.parse(line); } catch (e) { continue; }
						if (ev.ev === 'result' && ev.kind === 'finish' && typeof ev.inputs === 'string' && !found) found = ev.inputs;
						else if (ev.ev === 'done') done = ev.end;
					}
				});
				ch.on('error', () => { clearTimeout(kill); clearInterval(poll); resolve(); });
				ch.on('close', () => { clearTimeout(kill); clearInterval(poll); precChild = null; resolve(); });
			});
		} catch (e) { say({ ev: 'warning', text: `precision: ${e.message}` }); }
		try { fs.unlinkSync(file); } catch (e) { /* gone */ }
		precBusy = false;
		say({ ev: 'precision', run: precRuns, end: found ? 'finish' : done || 'ended', ms: Date.now() - t1 });
		if (!found) return null;
		const x = routeOf(T.masksOf(found.replace(/[^0-O]/g, '')), 'the exact landing (precision)', null);
		return x && x.better ? x.ev : null;
	};

	// ---- control: stdin lines
	let stopped = false, end = '', imports = 0;
	const onLine = (line) => {
		const s = String(line).trim();
		if (!s) return;
		const sp = s.indexOf(' '), cmd = sp < 0 ? s : s.slice(0, sp), arg = sp < 0 ? '' : s.slice(sp + 1).trim();
		if (cmd === 'stop') stopped = true;
		else if (cmd === 'depth' && +arg > 0) tickBound = Math.min(tickBound, +arg);
		else if ((cmd === 'steer' || cmd === 'steerd') && arg) loadSteer(arg);
		else if (cmd === 'route' && /^[0-O]+$/.test(arg)) {
			// (a known route: its run ticks bound the B&B; not a route of this search)
			const ev = C.evaluate(L, T.masksOf(arg), false);
			if (ev && ev.runTicks < extBound) { extBound = ev.runTicks; say({ ev: 'bound', runTicks: ev.runTicks, from: 'route' }); }
		} else if (cmd === 'import' && /^[0-O]+$/.test(arg)) {
			// (a state of another search: replayed; a model state not seen yet is an anchor)
			try {
				const masks = T.masksOf(arg);
				const r = replay(masks, null, true);
				if (!r.sim.is_dead && !r.sim.has_silver_crown) {
					const a = Object.assign(T.arrivalOf(L, r.sim, masks, RM), { run: r.run, leg: addLeg({ label: 'import', fromTick: 0, ticks: masks.length, lb: null, proven: false, tool: 'import', prev: null }) });
					const res = addArrival(a, model.stateOf(r.sim), null, cmd);
					if (res.isNew) { imports++; say({ ev: 'import', anchor: res.anchor.id, key: res.anchor.key, tick: a.tick }); }
				}
			} catch (e) { say({ ev: 'warning', text: `${cmd}: ${e.message}` }); }
		}
	};
	if (opts.stdinLines) {
		(async () => { try { for await (const line of opts.stdinLines) onLine(line); } catch (e) { /* closed */ } if (opts.stopOnStdinEnd) stopped = true; })();
	}

	// ---- the no-stall bookkeeping
	const tried = new Map();   // `${edge}|${nodeClass}|${rung}|${epoch}` -> {ok}
	const localBlock = new Set();   // `${anchor.key}|${edge}|${nodeClass}`: blocked here (a part's bug)
	let epoch = 0, mult = 1, deepenings = 0, stalls = 0, lastSteps = [], lastFails = [], bugs = 0, nothingSince = -1;
	const inflight = new Map();   // edgeKey -> {promise, job, started, budgetMs}
	let cur = null;   // the last plan (the page's line)
	const bug = (what, o) => { bugs++; say(Object.assign({ ev: 'bug', what }, o || {})); };
	const anchorArg = (A) => ({ arrival: A.arrivals[0], arrivals: A.arrivals, S: A.S, key: A.key, tick: A.firstTick, run: runMinOf(A) });
	/** an anchor that cannot lead to a route that beats the bounds: every arrival's run ticks already at the B&B bound, or
	 *  its ticks at the depth bound (proofs: a route through it is at least that long) */
	const uselessA = (A) => {
		const rb = runBound();
		return A.arrivals.every((a) => a.tick >= tickBound || (a.run > 0 && a.run >= rb));
	};
	/** an arrival's admissible run ticks to the trophy (the planner's lowerBound from it alone, a short search: its open
	 *  list's least f when cut; cached by the state) */
	const arrLbCache = new Map();
	const arrLB = (A, a) => {
		let v = arrLbCache.get(a.hash);
		if (v !== undefined) return v;
		v = 0;
		try {
			if (planner.lowerBound && !lbSlow) {
				const tq = Date.now();
				v = lbTicks(planner.lowerBound({ arrival: a, arrivals: [a], S: A.S, key: A.key, tick: a.tick, run: a.run }, { ms: ARR_LB_MS, maxExpand: ARR_LB_EXPAND }));
				if (Date.now() - tq >= LB_SLOW_MS) { lbSlow = true; say({ ev: 'warning', text: `the planner's lowerBound from an arrival took ${((Date.now() - tq) / 1000).toFixed(1)} s (asked ${ARR_LB_MS} ms): not called again this compile` }); }
			}
		} catch (e) { v = 0; }
		arrLbCache.set(a.hash, v);
		return v;
	};
	/** branch and bound on the arrivals: an arrival whose run ticks + its admissible bound reach the B&B bound (or whose
	 *  ticks the depth bound) is dropped from its anchor: no route through it can beat the best (a proof) */
	const pruneArrivals = (A) => {
		const rb = runBound();
		if (!Number.isFinite(rb) && !Number.isFinite(tickBound)) return;
		const keep = A.arrivals.filter((a) => !(a.tick >= tickBound || (a.run > 0 && a.run >= rb) || (Number.isFinite(rb) && (a.run > 0 ? a.run : 0) + arrLB(A, a) >= rb)));
		if (keep.length < A.arrivals.length) { bnbArrivals += A.arrivals.length - keep.length; A.arrivals = keep; }
	};
	/** the planner's depth for anchor A: its plan search drops a node whose tick (the anchor arrival's) + lb reaches it, so
	 *  the run-tick bound goes in as rb + the arrival's timer start; sound only where every arrival is on the planner's
	 *  tile with its timer running (the lb is the planner's from arrivals[0]'s tile): else none (Infinity) */
	const depthOf = (A) => {
		const a0 = A.arrivals[0], rb = runBound();
		const alike = A.arrivals.every((a) => a.tile === a0.tile && a.run > 0);
		const d = alike && Number.isFinite(rb) ? rb + (a0.tick - a0.run) : Infinity;
		return Math.min(d, Number.isFinite(tickBound) ? tickBound + 1 : Infinity);
	};
	const planOfAnchor = (A) => {
		// (the plan memo's version: the facts', and the planner's floors (an async floor probe's answer re-plans))
		const v = factsVer(facts) + floorVerOf() * 1e9;
		if (A.plans && A.planVer === v && A.planEpoch === epoch && A.planBound === runBound()) return A.plans;
		const rb = runBound();
		pruneArrivals(A);
		if (!A.arrivals.length) { const p0 = { plans: [], why: `bound: no arrival can beat ${num(rb)} run ticks` }; A.plans = p0; A.planVer = v; A.planEpoch = epoch; A.planBound = rb; A.costEst = Infinity; A.costVer = v; return p0; }
		const runMin = runMinOf(A);
		let r;
		// (the plan's own budget: the planner's default (2 s first, 0.3 s after) within a quarter of the time left; a call that
		// overran it by far is said once (a synchronous call cannot be cut here: the CLI's watchdog is the backstop))
		// (a plan cut by its budget ('budget': no proof of anything) doubles the anchor's next budget, up to 16x)
		const planMs = Math.max(100, Math.min((!A.plans && anchors.size <= 1 ? 2000 : 300) * (1 << Math.min(4, A.budgetCuts || 0)), (left() - (best ? endReserve : 0)) / 4));
		const tp = Date.now();
		try { r = planner.plan(anchorArg(A), { k: 3, depth: depthOf(A), runBound: rb, tickBound, epoch, ms: planMs }); } catch (e) { bug('plan', { error: e.message, anchor: A.id }); r = { plans: [], why: `error: ${e.message}` }; }
		const tpMs = Date.now() - tp;
		if (tpMs > 3 * planMs + 1000 && !planSlowSaid) { planSlowSaid = true; say({ ev: 'warning', text: `the planner's plan() took ${(tpMs / 1000).toFixed(1)} s (asked ${(planMs / 1000).toFixed(1)} s): a synchronous overrun the loop cannot cut` }); }
		const p = plansOf(r);
		// (branch and bound: a plan whose admissible lb from this anchor cannot beat the bound is not run: a proof. Only
		// where every arrival's run timer runs (before the first input idle ticks are free) and every arrival is on the
		// planner's tile (its lb is from arrivals[0]'s tile))
		if (Number.isFinite(rb) && startedOf(A) && A.arrivals.every((a) => a.tile === A.arrivals[0].tile)) {
			const n0 = p.plans.length;
			p.plans = p.plans.filter((q) => !(Number.isFinite(+q.lb) && runMin + +q.lb >= rb));
			if (p.plans.length < n0) { bnbPlans += n0 - p.plans.length; if (!p.plans.length) p.why = `bound: no plan can beat ${num(rb)} run ticks (lb)`; }
		}
		A.plans = p; A.planVer = v; A.planEpoch = epoch; A.planBound = rb;
		A.costEst = p.plans.length ? +p.plans[0].cost || 0 : Infinity; A.costVer = v;
		return p;
	};
	const scoreOf = (A, N) => (Number.isFinite(A.costEst) ? A.costEst : 1e7) + A.firstTick + FAIL_TICKS * A.fails - UCB_C * Math.sqrt(Math.log(N + 1) / (1 + A.picks));
	/** the next job: {anchor, plan, step} not in flight, or null (none: every anchor exhausted or busy) */
	const nextJob = () => {
		const N = picksN + 1;
		const open = [...anchors.values()].filter((A) => !A.exhausted);
		for (const A of open) if (uselessA(A)) { A.exhausted = true; A.why = 'bound'; }
		const live = open.filter((A) => !A.exhausted);
		// (an anchor never planned (the start, an import, a new state): planned once for its cost)
		// (an empty plan list cut by the planner's budget is no proof: the anchor stays open and replans with twice the budget)
		const budgetCut = (A, why) => { if (why !== 'budget' || (A.budgetCuts || 0) >= 4) return false; A.budgetCuts = (A.budgetCuts || 0) + 1; A.planVer = -1; return true; };
		for (const A of live) if (A.costVer < 0 && !Number.isFinite(A.costEst)) { const p = planOfAnchor(A); if (!p.plans.length && !budgetCut(A, p.why)) { A.exhausted = true; A.why = p.why || 'exhausted'; } }
		// (the most progress first, then the lowest plan cost + the arrival tick)
		const list = live.filter((A) => !A.exhausted).sort((a, b) => (b.gain - a.gain) || (scoreOf(a, N) - scoreOf(b, N)));
		for (const A of list) {
			if (left() < 200 || stopped) return null;
			const { plans, why } = planOfAnchor(A);
			if (!plans.length) { if (!budgetCut(A, why)) { A.exhausted = true; A.why = why || 'exhausted'; } continue; }
			for (const plan of plans) {
				const step = plan.steps[0];
				const ek = edgeKey(step);
				if (inflight.has(ek) || localBlock.has(`${A.key}|${ek}`)) continue;
				const tk = `${ek}|${step.rung}|${epoch}`;
				if (tried.has(tk)) {
					// (a triple already run in this epoch: the planner proposes it again; blocked here so it never runs twice: a
					// failed one is the planner's bug (a failure must change its plan), a done one just done for this epoch)
					localBlock.add(`${A.key}|${ek}`);
					if (!tried.get(tk).ok) bug('repeat', { edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, label: labelOf(step) });
					continue;
				}
				return { anchor: A, plan, step, plans };
			}
		}
		return null;
	};
	/** a step's budget: its rung's x 2^deepenings, capped by the time left (the polish's reserve kept once a route is known) */
	const budgetOf = (rung) => {
		const r = Math.max(0, Math.min(rungMs.length - 1, rung | 0));
		const room = left() - (best ? endReserve : 0) - 100;
		const ms = Math.max(50, Math.min(rungMs[r] * mult, room));
		const deadline = Date.now() + ms;
		return { ms, level: r, k: ARRIVALS_K, deadline, stop: () => stopped || left() <= 0 || Date.now() > deadline + 2000 };
	};
	/** the waypoint a step runs to: its own, with beforeTick filled from beforeTickFrom (ticks after the earliest start) */
	const waypointOf = (step, A) => {
		const wp = step.waypoint || { kind: 'trophy', label: 'trophy' };
		const rel = relOf(step.beforeTickFrom !== undefined ? step.beforeTickFrom : wp.beforeTickFrom);
		if (!Number.isFinite(rel)) return wp;
		// (per start its own deadline, its arrival tick + rel (the previous step's arrival: the key's touch); the executor
		// gets the latest, and the verify holds each arrival to its own start's)
		const t = A.arrivals.reduce((m, a) => Math.max(m, a.tick), -Infinity);
		return Object.assign({}, wp, { beforeTick: t + rel, beforeRel: rel });
	};
	/** which of the starts an arrival grew from: the result's leg for it (legs[i].start), else the longest start whose masks
	 *  begin it */
	const startOf = (starts, a, i, res) => {
		const lg = Array.isArray(res.legs) ? res.legs[i] : null;
		if (lg && Number.isInteger(lg.start) && starts[lg.start]) return { s: starts[lg.start], lg };
		let s = null;
		for (const x of starts) {
			if (x.masks.length > a.length || (s && x.masks.length <= s.masks.length)) continue;
			let ok = true;
			for (let t = 0; t < x.masks.length; t++) if ((x.masks[t] & 31) !== (a[t] & 31)) { ok = false; break; }
			if (ok) s = x;
		}
		return { s, lg };
	};
	/** a StepResult's arrivals checked here (replayed from the level start, the goal test (and its beforeTick), alive at the
	 *  end): the verified ones, each with its run ticks and its leg; routes (a finish) go to routeOf */
	const verified = (step, wp, res, starts) => {
		const out2 = [], routes = [];
		if (!res || !res.ok || !Array.isArray(res.arrivals)) return { arr: out2, routes };
		const trophy = wp.kind === 'trophy';
		const goal = trophy ? null : T.goalOf(L, wp);
		const rb = runBound();
		res.arrivals.forEach((a, i) => {
			if (!a || !a.masks) return;
			const masks = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			const { s, lg } = startOf(starts, masks, i, res);
			const leg = addLeg({ label: labelOf(step), fromTick: s ? s.tick : 0, ticks: masks.length - (s ? s.tick : 0), lb: lg && Number.isFinite(+lg.lb) ? +lg.lb : Number.isFinite(+res.lb) ? +res.lb : null,
				proven: !!(lg && lg.proven), tool: (lg && lg.tool) || res.tool || null, prev: s && s.leg ? s.leg : null });
			const r = replay(masks, goal, !!(goal && goal.allowDeath));
			if (r.finished > 0) { routes.push({ masks: masks.subarray(0, r.finished), leg }); return; }
			if (trophy) { bug('arrival', { label: labelOf(step), tick: masks.length, why: 'a trophy arrival that does not finish on its replay' }); return; }
			if (r.goalAt < 0 || r.sim.is_dead) { bug('arrival', { label: labelOf(step), tick: masks.length, why: r.goalAt < 0 ? 'the goal test never holds on its replay' : 'dead at its end' }); return; }
			// (beforeTick: a relative one (beforeTickFrom) is each start's own, the executor had the latest: late ones dropped
			// quietly; an absolute one past its tick is the executor's bug)
			if (Number.isFinite(+wp.beforeRel) && s && r.goalAt > s.tick + +wp.beforeRel) { lateArrivals++; return; }
			if (!Number.isFinite(+wp.beforeRel) && Number.isFinite(+wp.beforeTick) && r.goalAt > +wp.beforeTick) { bug('arrival', { label: labelOf(step), tick: masks.length, why: `the goal holds at tick ${r.goalAt}, past its beforeTick ${wp.beforeTick}` }); return; }
			// (no route through it can beat the bounds: a proof, it is at least that long already)
			if (masks.length >= tickBound || (r.run > 0 && r.run >= rb)) { bnbArrivals++; return; }
			out2.push(Object.assign(T.arrivalOf(L, r.sim, masks, RM), { run: r.run, leg }));
		});
		return { arr: out2, routes };
	};
	const learnFrom = (step, res, A) => {
		let fs2 = [];
		if (step.synthetic) return fs2;
		try { fs2 = planner.learn(step, res, anchorArg(A)) || []; } catch (e) { bug('learn', { error: e.message, label: labelOf(step) }); }
		for (const f of fs2) say({ ev: 'fact', kind: f.kind || f.type || '?', edge: f.edge !== undefined ? f.edge : step.edge, rung: f.rung !== undefined ? f.rung : step.rung, why: f.why });
		return fs2;
	};
	const failOf = (res, budget) => (res && res.fail) || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level };
	/** one job run: exec.reach, verify, learn, anchors; resolves when done */
	const runJob = async (job) => {
		const { anchor: A, step, plan } = job;
		const ek = edgeKey(step), tk = `${ek}|${step.rung}|${epoch}`;
		tried.set(tk, { ok: false });
		A.picks++; picksN++;
		const budget = budgetOf(step.rung);
		const wp = waypointOf(step, A);
		const starts = A.arrivals.slice();
		// (the relay start: this (anchor, edge)'s nearest state from its failed rungs, a start too: the next rung goes on from
		// the frontier the last one reached instead of only from the anchor; before a route only: no bound to keep)
		const rk = `${A.id}|${ek}`;
		const rl = RELAY ? relays.get(rk) : null;
		let rlUsed = false;
		if (rl && !Number.isFinite(runBound()) && rl.arrival.masks.length < tickBound && !starts.some((s) => s.hash === rl.arrival.hash)) { starts.push(rl.arrival); relayRuns++; rlUsed = true; }
		const t1 = Date.now();
		steps++;
		const verBefore = factsVer(facts), anchorsBefore = anchors.size;
		let res;
		try { res = await exec.reach(starts, wp, budget); } catch (e) { res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: Object.assign(failOf(null, budget), { error: e.message }) }; bug('reach', { error: e.message, label: labelOf(step) }); }
		if (!res) res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: failOf(null, budget) };
		const { arr, routes } = verified(step, wp, res, starts);
		const hadArrivals = res.ok && Array.isArray(res.arrivals) && res.arrivals.length > 0;
		if (res.ok && !arr.length && !routes.length) res = Object.assign({}, res, { ok: false, fail: failOf(res, budget), dropped: hadArrivals });
		else if (res.ok) res = Object.assign({}, res, { arrivals: arr });
		tried.get(tk).ok = !!res.ok;
		let news = 0, route = null;
		for (const r of routes) { const x = routeOf(r.masks, labelOf(step), r.leg); if (x && x.better) route = x.ev; }
		if (res.ok) {
			okSteps++;
			for (const a of arr) {
				const sim = simOf(a);
				let S2;
				try { S2 = model.stateOf(sim); } catch (e) { bug('stateOf', { error: e.message }); continue; }
				A.nextCost = Number.isFinite(+plan.cost) && Number.isFinite(+step.estTicks) ? Math.max(0, plan.cost - step.estTicks) : undefined;
				const { anchor: B, isNew, changed } = addArrival(a, S2, A, labelOf(step));
				if (isNew) {
					news++;
					const d = distOf(sim);
					say({ ev: 'source', kind: 'room', room: a.room, desc: a.desc, key: B.key, gain: 1, tick: a.tick, ...(d !== undefined ? { dist: Math.round(d * 10) / 10 } : {}), inputs: T.strOf(a.masks), anchor: B.id, label: labelOf(step) });
					if (steer) say({ ev: 'closest', dist: Math.round(distOf(sim) * 10) / 10, tick: a.tick, inputs: T.strOf(a.masks), anchor: B.id });
				} else if (changed && step.synthetic) lastProgress = Date.now();
			}
		} else { A.fails++; failSteps++; }
		learnFrom(step, res, A);
		const ms = Date.now() - t1;
		const fail = res.ok ? null : res.fail || null;
		// (a relay that got its rung no nearer by RELAY_GAIN tiles is dropped (a false near: the next rung from the anchor
		// alone), and a new one must beat it by as much)
		if (RELAY && rlUsed && !res.ok) {
			const nd = fail && fail.closest && fail.closest.dist >= 0 ? fail.closest.dist : Infinity;
			if (!(nd < rl.dist - RELAY_GAIN)) { relays.delete(rk); relayFloor.set(rk, rl.dist - RELAY_GAIN); relayDrop++; }
		}
		if (RELAY && fail && fail.closest && fail.closest.masks && !fail.closest.dead && fail.closest.dist >= 0 && !Number.isFinite(runBound())) {
			const prev = relays.get(rk);
			const floor = relayFloor.has(rk) ? relayFloor.get(rk) : Infinity;
			if ((!prev || fail.closest.dist < prev.dist) && fail.closest.dist < floor) {
				const m = fail.closest.masks instanceof Uint8Array ? fail.closest.masks : T.masksOf(fail.closest.masks);
				const r = replay(m, null, false);
				const h = r.sim.stateHash();
				if (r.dead < 0 && r.finished < 0 && !starts.some((s) => s.hash === h)) {
					const { s } = startOf(starts, m, -1, {});
					const leg = addLeg({ label: `relay ${labelOf(step)}`, fromTick: s ? s.tick : 0, ticks: m.length - (s ? s.tick : 0), lb: null, proven: false, tool: 'relay', prev: s && s.leg ? s.leg : null });
					relays.set(rk, { arrival: Object.assign(T.arrivalOf(L, r.sim, m, RM), { run: r.run, leg, relay: true }), dist: fail.closest.dist });
					relaySet++;
				}
			}
		}
		const rec = { ev: 'step', n: steps, anchor: A.id, label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, epoch, tool: res.tool || null, ok: !!res.ok, ms, budgetMs: Math.round(budget.ms),
			why: res.ok ? '' : (fail && fail.why) || '', arrivals: arr.length, news, routes: routes.length };
		if (fail && fail.closest) rec.closest = { tile: fail.closest.tile, dist: fail.closest.dist };
		if (fail && Array.isArray(fail.blockedBy) && fail.blockedBy.length) rec.blockedBy = fail.blockedBy.slice(0, 4);
		say(rec);
		lastSteps.push({ n: steps, label: rec.label, rung: step.rung, ok: rec.ok, why: rec.why, ms, anchor: A.id });
		if (lastSteps.length > 8) lastSteps.shift();
		if (fail) { lastFails.push({ n: steps, label: rec.label, rung: step.rung, why: fail.why, closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [], touched: (fail.touched || []).length }); if (lastFails.length > 6) lastFails.shift(); }
		// (a trophy leg that ended within PREC_NEAR tiles of the trophy: the exact landing, above)
		if (fail && wp.kind === 'trophy' && fail.closest && !route) {
			const pr = await precision(fail.closest);
			if (pr) route = pr;
		}
		const verAfter = factsVer(facts);
		if (verAfter !== verBefore) lastProgress = Date.now();
		// (the invariant: every step adds an anchor or changes a fact; else the planner would propose it again: blocked here)
		if (!step.synthetic && anchors.size === anchorsBefore && verAfter === verBefore && !route) {
			localBlock.add(`${A.key}|${ek}`);
			bug('no progress', { label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, ok: !!res.ok });
		}
		A.plans = null;   // (plan again from here: receding horizon)
		cur = { plan, step, anchor: A.id, ok: rec.ok, depth: A.depth };
		return { route };
	};

	// ---- the stall watchdog's exploration steps: region waypoints on an anchor's unvisited walk frontier
	const frontierOf = (A) => {
		const W = L.width, H = L.height, N = W * H, fl = RF.guideFlags ? RF.guideFlags(L) : L.flags;
		const wall = (t) => { const id = L.fg[t]; return id > 0 && id < fl.length && (fl[id] & 1) !== 0 && (fl[id] & 16) === 0; };
		const t0a = A.arrivals[0].tile;
		const dist = new Int16Array(N).fill(-1), q = [t0a];
		dist[t0a] = 0;
		const front = [];
		for (let h = 0; h < q.length; h++) {
			const t = q[h], x = t % W, y = (t / W) | 0;
			if (!visited[t] && dist[t] >= 3) front.push(t);
			if (dist[t] >= FRONTIER_STEPS) continue;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const u = ny * W + nx;
				if (dist[u] >= 0 || wall(u)) continue;
				dist[u] = dist[t] + 1; q.push(u);
			}
		}
		// (the farthest first: the frontier being pushed)
		front.sort((a, b) => dist[b] - dist[a]);
		return front.slice(0, FRONTIER_MAX);
	};
	let exploreTurn = 0, exploreSeq = 0;
	const exploreJob = () => {
		const list = [...anchors.values()].filter((A) => !uselessA(A));
		for (let i = 0; i < list.length; i++) {
			const A = list[(exploreTurn + i) % list.length];
			const tiles = frontierOf(A);
			if (!tiles.length) continue;
			exploreTurn += i + 1;
			const step = { n: 0, edge: `explore:${A.key}:${++exploreSeq}`, nodeClass: `x${A.key}`, rung: Math.min(3, Math.max(0, stalls - 1)), synthetic: true, estTicks: 0,
				waypoint: { kind: 'region', tiles, expect: null, label: `explore ${tiles.length} tiles` } };
			return { anchor: A, plan: { id: 'explore', steps: [step], cost: 0, partial: true, why: 'stall' }, step };
		}
		return null;
	};
	const exploreQ = [];
	/** the fallbacks when the planner has nothing left and time remains (at most FALLBACK_MAX without a new anchor): from
	 *  the anchor of the most progress a direct trophy step (the executor's exact tiers derive the whole way), its rung
	 *  rising each time, then an exploration step on its unvisited frontier; never the same triple twice */
	let fallbacks = 0, fallbackAnchors = -1;
	const fallbackJob = () => {
		if (anchors.size !== fallbackAnchors) { fallbackAnchors = anchors.size; fallbacks = 0; }
		if (fallbacks >= FALLBACK_MAX || stopped || left() < 1000) return null;
		const list = [...anchors.values()].filter((A) => A.arrivals.length && !uselessA(A)).sort((a, b) => b.gain - a.gain || a.firstTick - b.firstTick);
		for (const A of list) {
			for (let r = 0; r < rungMs.length; r++) {
				const step = { n: 0, edge: `fallback:trophy:${A.key}`, nodeClass: `f${A.key}`, rung: r, synthetic: true, fallback: true, estTicks: 0, waypoint: { kind: 'trophy', label: 'trophy (fallback: no plan left)' } };
				if (tried.has(`${edgeKey(step)}|${r}|${epoch}`)) continue;
				fallbacks++;
				say({ ev: 'fallback', kind: 'trophy', anchor: A.id, rung: r, why: A.why || 'no plan' });
				return { anchor: A, plan: { id: 'fallback', steps: [step], cost: 0, partial: true, why: 'fallback' }, step };
			}
		}
		const j = exploreJob();
		if (j) { fallbacks++; say({ ev: 'fallback', kind: 'explore', anchor: j.anchor.id, rung: j.step.rung }); }
		return j;
	};
	const deepen = (why) => {
		if (deepenings >= maxDeepen || rungMs[0] * mult * 2 > left() - (best ? endReserve : 0)) return false;
		deepenings++; epoch++; mult *= 2;
		try { if (facts && typeof facts.reset === 'function') facts.reset({ keepProofs: true, boost: 2 }); } catch (e) { bug('reset', { error: e.message }); }
		for (const A of anchors.values()) { if (A.why !== 'bound') { A.exhausted = false; A.why = ''; } A.plans = null; }
		localBlock.clear();
		say({ ev: 'deepen', why, n: deepenings, mult, anchors: anchors.size });
		lastProgress = Date.now();
		return true;
	};

	// ---- progress, the watchdog and the files
	const pct = (x) => `${Math.round(x * 1000) / 10}%`;
	const detail = () => {
		const pl = cur && cur.plan, st = cur && cur.step;
		const run = [...inflight.values()][0];
		const js = run ? run.job : null;
		const step = js ? js.step : st, dep = js ? js.anchor.depth : cur ? cur.depth : 0, plan = js ? js.plan : pl;
		const where = step ? `step ${dep + 1}/${dep + (plan && Array.isArray(plan.steps) ? plan.steps.length : 1)} '${labelOf(step)}' rung ${step.rung | 0}${js ? (step.synthetic ? ' (explore)' : '') : cur && cur.ok !== null ? cur.ok ? ' (ok)' : ' (failed)' : ''}` : 'planning';
		const rt = best ? ` · route ${num(best.runTicks)} (lb ${num(LB)}, gap ${best.runTicks > 0 ? pct(Math.max(0, best.runTicks - LB) / best.runTicks) : '0%'})` : LB ? ` · lb ${num(LB)}` : '';
		return `plan: ${where} · ${anchors.size} anchor${anchors.size === 1 ? '' : 's'}${rt}`;
	};
	const factsCount = () => { try { const s = planner.stats ? planner.stats() : null; if (s && Number.isFinite(+s.facts)) return +s.facts; } catch (e) { /* none */ } return factsVer(facts); };
	const progress = () => {
		const maxTick = Math.max(0, ...[...anchors.values()].map((A) => A.firstTick));
		say({ ev: 'progress', states: anchors.size, rooms: anchors.size, anchors: anchors.size, triggers: Math.max(0, ...[...anchors.values()].map((A) => A.gain)), steps, okSteps, facts: factsCount(), sec: Math.round(secNow() * 10) / 10,
			workers, layer: maxTick, tick: maxTick, ticksPerSec: 0, imports, bugs, deepenings, stalls, exhausted: [...anchors.values()].filter((A) => A.exhausted).length,
			...(best ? { runTicks: best.runTicks, lb: LB, gap: gapOf(best.runTicks) } : { lb: LB }), detail: detail() });
	};
	const saveFiles = () => {
		if (!out) return;
		flushEvents();
		try {
			const fj = facts && typeof facts.toJSON === 'function' ? facts.toJSON() : planner.stats ? planner.stats() : { version: factsVer(facts) };
			fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(fj, null, 1));
			fs.writeFileSync(path.join(out, 'anchors.json'), JSON.stringify([...anchors.values()].map((A) => ({ id: A.id, key: A.key, via: A.via, parent: A.parent, depth: A.depth, firstTick: A.firstTick, picks: A.picks, fails: A.fails,
				exhausted: A.exhausted, why: A.why, gain: A.gain, cost: Number.isFinite(A.costEst) ? A.costEst : null, arrivals: A.arrivals.map((a) => ({ tick: a.tick, run: a.run, tile: a.tile, vx: a.vx, vy: a.vy, room: a.room, desc: a.desc })) })), null, 1));
		} catch (e) { /* read-only */ }
	};
	/** WHY the search is where it is: the last steps, their fail reports, the planner's explanation, the most progress */
	const whyNow = () => {
		let ex = '';
		try { ex = planner.explain ? String(planner.explain() || '') : ''; } catch (e) { ex = `explain: ${e.message}`; }
		const top = [...anchors.values()].sort((a, b) => b.gain - a.gain || a.firstTick - b.firstTick)[0];
		const fails = lastFails.slice(-3).map((f) => `'${f.label}' rung ${f.rung}: ${f.why}${f.closest ? ` (closest ${f.closest.dist} tiles at tile ${f.closest.tile})` : ''}${f.blockedBy.length ? ` blocked by ${f.blockedBy.map((b) => b.feat).join(', ')}` : ''}`);
		return { steps: lastSteps.slice(), fails: lastFails.slice(), explain: ex.slice(0, 2000), text: `${anchors.size} anchors, the most progress: anchor ${top ? `${top.id} (gain ${top.gain}, tick ${top.firstTick}, ${top.exhausted ? `exhausted: ${top.why}` : 'open'})` : '-'}` +
			`${fails.length ? `; last failures: ${fails.join('; ')}` : ''}${ex ? `; planner: ${ex.slice(0, 400)}` : ''}` };
	};
	const watchdog = () => {
		const now = Date.now();
		// (a long step inside its budget is working: no stall while one runs; steps that come and go without progress are it)
		const busy = [...inflight.values()].some((f) => now - f.started >= 1000 && now - f.started < f.budgetMs + 5000);
		const v = factsVer(facts);
		if (v !== progressVer) { progressVer = v; lastProgress = now; }
		if (busy) return;
		if (now - lastProgress >= stallWindow) {
			stalls++;
			let fsum = null;
			try { fsum = planner.stats ? planner.stats() : null; } catch (e) { /* none */ }
			const w = whyNow();
			say({ ev: 'stall', why: `no new state and no fact changed for ${Math.round((now - lastProgress) / 1000)} s: ${w.text}`, n: stalls, lastSteps: w.steps, fails: w.fails, explain: w.explain, anchors: anchors.size,
				exhausted: [...anchors.values()].filter((A) => A.exhausted).length, facts: fsum });
			if (stalls === 1) deepen('stall');
			else { const j = exploreJob(); if (j) exploreQ.push(j); }
			lastProgress = now;
		}
	};
	const timers = [setInterval(progress, progressMs), setInterval(watchdog, watchMs), setInterval(saveFiles, SAVE_MS)];
	for (const tt of timers) if (tt.unref) tt.unref();
	const stallEnd = +opts.stallS > 0 ? +opts.stallS * 1000 : 0;
	let progressAt = Date.now();   // (the last real progress: a new anchor or a route, for --stallS)
	let anchorsSeen = anchors.size, bestSeen = null;

	// ---- PLAN: the first plan from the start (its time is the plan stage's)
	tm = Date.now();
	{
		const A = anchors.get(String(S0.key));
		const p = planOfAnchor(A);
		const pl = p.plans[0];
		stage('plan', Date.now() - tm, pl ? `${pl.steps.length} step${pl.steps.length === 1 ? '' : 's'}: ${pl.steps.slice(0, 6).map(labelOf).join(' -> ')}${pl.steps.length > 6 ? ' -> ...' : ''}${Number.isFinite(+pl.cost) ? ` (est ${num(+pl.cost)} ticks)` : ''}` : `no plan: ${p.why || 'exhausted'}`);
		if (pl) say({ ev: 'plan', anchor: A.id, steps: pl.steps.map(labelOf), cost: pl.cost, lb: pl.lb, partial: !!pl.partial, why: pl.why || '', rung: pl.steps[0].rung, first: true });
	}

	// ---- MOVES: the parts that move (the primitives, the executor), then the loop
	const tMoves = Date.now();
	try {
		if (parts.createPrims) {
			try { prims = await parts.createPrims(L, { file: opts.file, bounds, model, workers }); } catch (e) { prims = null; say({ ev: 'warning', text: `the motion primitives could not start (${e.message}): the executor without them` }); }
		}
		exec = await parts.createExecutor(L, { file: opts.file, workers, prims, bounds, model, RM, emit: say, seed: opts.seed, gpu: null });
	} catch (e) {
		for (const tt of timers) clearInterval(tt);
		try { if (prims && prims.close) await prims.close(); } catch (e2) { /* closed */ }
		throw e;
	}
	say({ ev: 'start', triggers: nTrig, feats: nFeat, workers, inflight: P, prims: !!prims, bounds: !!bounds, lb: LB, seconds, partsMs: Date.now() - tMoves });
	lastProgress = progressAt = Date.now();   // (the stall clocks from the loop's start)
	progress();
	try {
		while (true) {
			if (stopped) { end = 'stopped'; break; }
			if (left() <= 0) { end = 'time'; break; }
			if (best && opts.first) { end = 'finish'; break; }
			// (a route known: the moves stop where the polish's reserve begins)
			if (best && left() <= endReserve && !inflight.size) { end = 'time'; break; }
			if (anchors.size !== anchorsSeen || best !== bestSeen) { anchorsSeen = anchors.size; bestSeen = best; progressAt = Date.now(); }
			if (stallEnd && Date.now() - progressAt > stallEnd) { end = 'stalled'; break; }
			while (inflight.size < P && !(best && left() <= endReserve)) {
				const job = exploreQ.length ? exploreQ.shift() : nextJob();
				if (!job) break;
				const ek = edgeKey(job.step);
				if (inflight.has(ek)) continue;
				cur = { plan: job.plan, step: job.step, anchor: job.anchor.id, ok: null, depth: job.anchor.depth };
				say({ ev: 'plan', anchor: job.anchor.id, steps: job.plan.steps.map(labelOf), cost: job.plan.cost, lb: job.plan.lb, partial: !!job.plan.partial, why: job.plan.why || '', rung: job.step.rung });
				const f = { job, started: Date.now(), budgetMs: budgetOf(job.step.rung).ms };
				f.promise = runJob(job).catch((e) => { bug('job', { error: e.message }); return {}; }).then((r) => { inflight.delete(ek); return r; });
				inflight.set(ek, f);
			}
			if (!inflight.size) {
				// (every anchor exhausted: a global deepening; nothing new since the last one, or no deepening left: the
				// fallbacks (a direct trophy step, then the frontier) while time is left; else the end)
				if (exploreQ.length) continue;
				if (left() < 250 || (best && left() <= endReserve)) { end = 'time'; break; }
				if (nothingSince >= 0 && nothingSince === steps) { const fb = fallbackJob(); if (fb) { exploreQ.push(fb); continue; } end = 'exhausted'; break; }
				nothingSince = steps;
				// (a deepening refused for the clock alone (its doubled first rung past the time left) is no exhaustion: the
				// end is the time's, not a claim that no plan is left (The Flighty Slighty, The Tunnels, Fish Gods, OCTOS:
				// "end exhausted" 1-5 s before the 60-s budget; every level is possible))
				if (!deepen('exhausted')) { const fb = fallbackJob(); if (fb) { exploreQ.push(fb); continue; } end = deepenings < maxDeepen ? 'time' : 'exhausted'; break; }
				continue;
			}
			const tick = new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
			await Promise.race([...[...inflight.values()].map((f) => f.promise), tick]);
		}
		// (in-flight steps: told to stop, awaited briefly)
		const wasStopped = stopped;
		stopped = true;
		const wait = Promise.all([...inflight.values()].map((f) => f.promise));
		await Promise.race([wait, new Promise((res) => { const tt = setTimeout(res, 3000); if (tt.unref) tt.unref(); })]);
		stopped = wasStopped;
	} finally {
		for (const tt of timers) clearInterval(tt);
	}
	const legTools = (lg) => { const c = {}; for (const g of lg) c[g.tool || '?'] = (c[g.tool || '?'] || 0) + 1; return c; };
	{
		const lg = best ? best.legs : [];
		const c = legTools(lg), proven = lg.filter((g) => g.proven).length;
		const tools = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') + (proven ? `; ${proven} proven` : '');
		stage('moves', Date.now() - tMoves, best ? `${lg.length} leg${lg.length === 1 ? '' : 's'}${tools ? ` (${tools})` : ''}, ${failSteps} re-plan${failSteps === 1 ? '' : 's'}, ${steps} steps, ${anchors.size} anchors (end ${end})`
			: `no route: ${steps} steps, ${failSteps} failed, ${anchors.size} anchors, ${deepenings} deepening${deepenings === 1 ? '' : 's'}, ${stalls} stall${stalls === 1 ? '' : 's'} (end ${end})`);
	}

	// ---- VERIFY (the route as found) and POLISH (the executor's, else the route cleanup), then the final verify
	if (best) {
		tm = Date.now();
		const ev = C.evaluate(L, best.masks);
		if (!ev) { bug('verify', { why: 'the best route does not finish on its replay' }); best = null; }
		stage('verify', Date.now() - tm, ev ? `finishes: ${fmt(ev.runTicks)} (${num(ev.runTicks)} run ticks), ${ev.deaths} death${ev.deaths === 1 ? '' : 's'}${ev.chance < 1 ? `, ${Math.round(ev.chance * 1000) / 10}% of EEO plays (random portals)` : ''}` : 'the route does not finish: dropped (a bug)');
	}
	if (best && polishOn && !stopped) {
		tm = Date.now();
		const ms = Math.max(200, Math.min(polishReserve, left() - 200 - (best ? proveReserve : 0)));
		let how = '', pr = null;
		try {
			if (exec && typeof exec.polish === 'function') { pr = await exec.polish(best.masks, { ms, legs: best.legs, bound: LB }); how = 'the executor'; }
			else {
				const CR = require('../cleanroute.js');
				const r = CR.cleanRoute(L, best.masks, { ms });
				pr = r ? { masks: r.ms, runTicks: r.ev.runTicks } : null; how = 'the route cleanup';
			}
		} catch (e) { say({ ev: 'warning', text: `the polish: ${e.message}` }); pr = null; }
		let text = 'no gain';
		if (pr && pr.masks) {
			const masks = pr.masks instanceof Uint8Array ? pr.masks : T.masksOf(pr.masks);
			const ev = C.evaluate(L, masks);
			if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && (ev.runTicks < best.runTicks || (ev.runTicks === best.runTicks && ev.complete < best.ticks))) {
				const saved = best.runTicks - ev.runTicks;
				const lg = Array.isArray(pr.legs) && pr.legs.length ? pr.legs.map((g) => ({ label: g.label || '?', fromTick: g.fromTick, ticks: g.ticks, lb: Number.isFinite(+g.lb) ? +g.lb : null, proven: !!g.proven, tool: g.tool || null })) : best.legs;
				best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: lg, how: `${best.how} + polish` };
				say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, polish: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
				if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
				text = saved > 0 ? `-${num(saved)} ticks (${how})` : `the same time, ${num(best.ticks)} ticks (${how})`;
			} else if (ev) text = `no gain (${how}: ${fmt(ev.runTicks)}, ${ev.deaths} deaths: kept the route)`;
			else text = `refused (${how}: it does not finish)`;
		}
		stage('polish', Date.now() - tm, text);
	} else stage('polish', 0, best ? 'off' : 'no route');

	// ---- PROVE: the route optimal where the exact search can say so. The run timer starts at the first input, so waiting is
	// free; the start rests after R idle ticks (restIdle). The route costs C = its arrival tick - its idle ticks. From each
	// S_k (the start after k = 0..R idle ticks) one exact search to the trophy bounded by beforeTick = k + C - 1: every route
	// whose first input is at tick k' <= R is in S_k' 's search, and one that waits longer is one that waits R, shifted.
	// Every search exhausted (the executor's EXACT tier: its lb, in layers from its start, reaches C) = no route costs less
	// than C run ticks: the lower bound is the route's (PROVEN OPTIMAL). Deaths are moves where something kills (the search
	// then keeps dying runs: allowDeath). An arrival a search finds is a faster route (from the exact tier, the minimum
	// from its start). The proof rests on the exact tier's cuts: the endgame bound (sound by construction), the bounds'
	// leg() (admissible: the primitives' T-LB-ADMISSIBLE check) and the -1 field while the doors stand as at the start.
	const noDeath = (() => { try { return require('../goexplore.js').deathsOf(L) === null; } catch (e) { return false; } })();
	let proveProof = '';
	if (best && proveOn && restIdle >= 0 && exec && typeof exec.reach === 'function' && !stopped && left() > 300) {
		tm = Date.now();
		let text = '';
		try {
			// (rounds: a faster route a search finds becomes the best, and the proof starts over with its cost: prove or improve)
			const trophy = T.goalOf(L, { kind: 'trophy' });
			const how = noDeath ? 'nothing kills' : 'deaths as moves';
			const notes = [];
			for (let round = 0; round < PROVE_ROUNDS; round++) {
				let kStar = 0;
				while (kStar < best.masks.length && best.masks[kStar] === 0) kStar++;
				const sim = new E.EESim(L), inp = new E.EEInput();
				sim.reset();
				let A = -1;
				for (let n = 0; n < best.masks.length; n++) { E.applyMask(inp, best.masks[n]); sim.tick(inp); if (!sim.is_dead && sim.has_silver_crown) { A = n + 1; break; } }
				const Cost = A - kStar;
				if (A < 1 || Cost < 1) { notes.push('the route does not reach the trophy on its replay (a bug)'); break; }
				let proved = 0, faster = null, fail = '', lbMin = Infinity;
				for (let k = 0; k <= restIdle && !faster; k++) {
					const room = left() - 250;
					if (room < 100) { fail = fail || 'no time left'; lbMin = 0; break; }
					const ms = Math.max(100, Math.floor(room / (restIdle + 1 - k)));
					const deadline = Date.now() + ms;
					const idle = new Uint8Array(k);
					const Sk = k === 0 ? a0 : T.arrivalOf(L, T.playTo(L, idle).sim, idle, RM);
					const wp = { kind: 'trophy', tiles: Array.from(trophy.tiles), expect: null, label: 'trophy (the proof)', beforeTick: k + Cost - 1, allowDeath: !noDeath };
					const r = await exec.reach([Sk], wp, { ms, level: rungMs.length - 1, k: ARRIVALS_K, deadline, stop: () => stopped || Date.now() > deadline + 2000 });
					if (r && r.ok) {
						const arr = (r.arrivals || []).filter((a) => a && a.masks && a.tick <= k + Cost - 1).sort((a, b) => a.tick - b.tick);
						if (!arr.length) { bug('prove', { why: `the executor returned arrivals past the waypoint's beforeTick ${k + Cost - 1}` }); fail = 'its arrivals were past the bound (a bug)'; lbMin = 0; break; }
						faster = { a: arr[0], r, k };
					} else if (r && Number(r.lb) >= Cost) proved++;
					else if (!fail) fail = `start +${k} idle: ${r && r.fail ? r.fail.why : '?'}, the exact search's bound ${r ? num(r.lb || 0) : '?'} of the ${num(Cost)} needed`;
					// (each search's lb: no arrival within lb - 1 layers of its start; the least over the starts bounds every route)
					if (!(r && r.ok)) lbMin = Math.min(lbMin, r && Number(r.lb) > 0 ? Math.min(Number(r.lb), Cost) : 0);
				}
				if (faster) {
					const m = faster.a.masks instanceof Uint8Array ? faster.a.masks : T.masksOf(faster.a.masks);
					const ev = C.evaluate(L, m);
					const lg0 = (faster.r.legs || [])[0] || {};
					if (ev && ev.runTicks < best.runTicks && (!noDeath || ev.deaths === 0) && ev.chance >= best.chance - 1e-9) {
						const saved = best.runTicks - ev.runTicks;
						const proven = !!lg0.proven && lg0.tool === 'exact';
						best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance,
							legs: [{ label: 'trophy', fromTick: faster.k, ticks: ev.complete - faster.k, lb: proven ? ev.complete - faster.k : null, proven, tool: lg0.tool || faster.r.tool || null }], how: 'the proof search' };
						say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
						if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
						notes.push(`-${num(saved)} (${lg0.tool || faster.r.tool || '?'}, +${faster.k} idle)`);
						continue;
					}
					notes.push(`its arrival did not replay faster (${ev ? fmt(ev.runTicks) : 'no finish'})`);
					break;
				}
				if (proved === restIdle + 1) {
					proveProof = `${restIdle + 1} exhaustive exact search${restIdle ? 'es' : ''} from the level start (after 0..${restIdle} idle ticks; ${how}): no route reaches the trophy in fewer than ${num(Cost)} ticks after its first input`;
					notes.push(`PROVEN: no route reaches the trophy in fewer than ${num(Cost)} ticks after its first input (${restIdle + 1} exact search${restIdle ? 'es' : ''}, ${how})`);
					break;
				}
				// (no proof, but every start's search ran: the least of their bounds is a bound on every route (the same offset
				// between ticks after the first input and run ticks as the route's own))
				const part = Number.isFinite(lbMin) && lbMin > 0 ? lbMin - (Cost - best.runTicks) : 0;
				let raised = '';
				if (part > LB && part <= best.runTicks) { raised = `; the lower bound raised ${num(LB)} -> ${num(part)} run ticks by the exact searches`; LB = part; }
				notes.push(`no proof in ${((Date.now() - tm) / 1000).toFixed(1)} s (${proved} of ${restIdle + 1} starts; ${fail})${raised}`);
				break;
			}
			text = notes.join('; ') || 'no round ran';
		} catch (e) { bug('prove', { error: e.message }); text = `no proof: ${e.message}`; }
		stage('prove', Date.now() - tm, text);
	} else if (best) stage('prove', 0, !proveOn ? 'off' : restIdle < 0 ? `skipped: the start does not rest within ${PROVE_IDLE_MAX} idle ticks` : stopped ? 'skipped: stopped' : 'skipped: no time left');

	// ---- the bound again (the planner's facts may have raised it), the report
	// (a proof of optimality: the route is one exact leg from the level start, proven the fewest ticks, and the start is
	// static: no route has fewer run ticks)
	let lbProof = proveProof;
	if (proveProof && best && best.runTicks > LB) { LB = best.runTicks; lbComplete = true; }
	// (the exact search drops dying runs: only where nothing kills (goexplore.js deathsOf: no killing tile, no timed killer)
	// is its minimum every route's; a death back to the one spawn keeps the keys and coins taken: a move)
	if (!lbProof && best && startStatic && noDeath && best.legs.length === 1 && best.legs[0].fromTick === 0 && best.legs[0].proven && best.legs[0].tool === 'exact' && !String(best.how || '').includes('polish')) {
		if (best.runTicks > LB) { LB = best.runTicks; lbComplete = true; lbProof = 'one exact leg from the static level start, proven the fewest ticks'; }
	}
	if (!lbSlow && !lbProof && planner.lowerBound) {
		try {
			const r = planner.lowerBound(startAnchorArg, { ms: LB_MS });
			const t = lbTicks(r);
			if (Number.isFinite(t) && t > LB) { LB = t; if (r && r.complete) lbComplete = true; }
			if (t === Infinity && best) bug('bound', { why: 'the planner\'s lower bound is infinite while a route exists: its relaxation is unsound here' });
		} catch (e) { /* the first one stands */ }
	}
	if (best && LB > best.runTicks) { bug('bound', { why: `the lower bound ${LB} is above the route's ${best.runTicks} run ticks: inadmissible`, lb: LB, planner: lbPlanner, bounds: lbBounds }); LB = Math.max(0, ...[lbPlanner, lbBounds].filter((x) => Number.isFinite(x) && x <= best.runTicks)); }
	try { if (exec && exec.close) await exec.close(); } catch (e) { /* closed */ }
	try { if (prims && prims.close) await prims.close(); } catch (e) { /* closed */ }
	let known = null;
	if (opts.known && typeof opts.known === 'object') known = opts.known;
	else if (opts.known !== false && (opts.file || opts.md5)) { try { known = knownOf(opts.file, { md5: opts.md5 }); } catch (e) { known = null; } }
	progress();
	const why = best ? '' : `no route (end ${end}): ${whyNow().text}`;
	say({ ev: 'done', end, sec: Math.round(secNow() * 10) / 10, steps, okSteps, anchors: anchors.size, routes: best ? 1 : 0, best: best ? best.ticks : null, runTicks: best ? best.runTicks : null, lb: LB, gap: best ? gapOf(best.runTicks) : null,
		bugs, deepenings, stalls, bnbPlans, bnbArrivals, layers: Math.max(0, ...[...anchors.values()].map((A) => A.firstTick)), ...(why ? { why } : {}) });
	saveFiles();
	return { ok: !!best, masks: best ? best.masks : null, route: best ? best.masks : null, runTicks: best ? best.runTicks : null, ticks: best ? best.ticks : null, deaths: best ? best.deaths : null, chance: best ? best.chance : null,
		lb: LB, lbComplete, lbProof, gap: best ? gapOf(best.runTicks) : null, legs: best ? best.legs : [], stages, known, why, end, anchors: anchors.size, steps, okSteps, bugs, deepenings, stalls, bnbPlans, bnbArrivals, relayRuns, relaySet, relayDrop };
}

/** run(L, opts, emit): the compile loop as a Find a route strategy (src/plan.js): 300 s by default, the source events'
 *  distances on the editor's scale; returns compile()'s result (end, route, anchors, steps, okSteps, bugs, deepenings,
 *  stalls too) */
function run(L, opts = {}, emit = () => {}) {
	return compile(L, Object.assign({ seconds: 300, sourceDist: true }, opts), emit);
}

module.exports = { compile, run, knownOf, md5Of, partsOf, plansOf, idleRunLB, RUNG_MS, STALL_S, POLISH_MS, POLISH_F };
