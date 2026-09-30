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
// exploration steps (the second stall on): frontier tiles within FRONTIER_STEPS walk steps of an anchor, at most FRONTIER_MAX
const FRONTIER_STEPS = 60, FRONTIER_MAX = 400;

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
/** a lowerBound() answer's ticks (admissible), else 0 */
const lbTicks = (r) => (r && Number.isFinite(+r.ticks) && +r.ticks > 0 ? +r.ticks : Number.isFinite(+r) && +r > 0 ? +r : 0);
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
	const stages = { parse: Math.round(+opts.parseMs || 0), model: 0, bounds: 0, plan: 0, moves: 0, verify: 0, polish: 0 };
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
	const planner = parts.createPlanner(model, facts, { bounds, seed: opts.seed });
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
	const startAnchorArg = { arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 };
	let lbPlanner = 0, lbBounds = 0, lbComplete = false;
	try { const r = planner.lowerBound ? planner.lowerBound(startAnchorArg) : null; lbPlanner = lbTicks(r); lbComplete = !!(r && r.complete); } catch (e) { say({ ev: 'bug', what: 'lowerBound', error: e.message }); }
	if (bounds && typeof bounds.leg === 'function') {
		try { lbBounds = lbTicks(bounds.leg(r0.sim, T.goalOf(L, { kind: 'trophy', label: 'trophy' }))); } catch (e) { say({ ev: 'warning', text: `bounds.leg: ${e.message}` }); }
	}
	let LB = Math.max(lbPlanner, lbBounds);
	stage('bounds', Date.now() - tm, LB > 0 ? `lower bound ${num(LB)} ticks from the start${lbPlanner && lbBounds ? ` (planner ${num(lbPlanner)}, physics ${num(lbBounds)})` : lbBounds ? ' (physics)' : ''}${lbComplete ? '' : ' (search cut: the open list\'s least f)'}` : 'no admissible bound (none of the parts gives one): 0');

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
	let anchorSeq = 0, lastProgress = Date.now(), progressVer = factsVer(facts), steps = 0, okSteps = 0, failSteps = 0, picksN = 0, bnbPlans = 0, bnbArrivals = 0;
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
	const planOfAnchor = (A) => {
		const v = factsVer(facts);
		if (A.plans && A.planVer === v && A.planEpoch === epoch && A.planBound === runBound()) return A.plans;
		const rb = runBound(), runMin = runMinOf(A);
		let r;
		try { r = planner.plan(anchorArg(A), { k: 3, depth: rb, left: Number.isFinite(rb) ? rb - runMin : Infinity, tickBound, epoch }); } catch (e) { bug('plan', { error: e.message, anchor: A.id }); r = { plans: [], why: `error: ${e.message}` }; }
		const p = plansOf(r);
		// (branch and bound: a plan whose admissible lb from this anchor cannot beat the bound is not run: a proof. Only
		// where every arrival's run timer runs: before the first input idle ticks are free, the lb says nothing of run ticks)
		if (Number.isFinite(rb) && startedOf(A)) {
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
		for (const A of live) if (A.costVer < 0 && !Number.isFinite(A.costEst)) { const p = planOfAnchor(A); if (!p.plans.length) { A.exhausted = true; A.why = p.why || 'exhausted'; } }
		// (the most progress first, then the lowest plan cost + the arrival tick)
		const list = live.filter((A) => !A.exhausted).sort((a, b) => (b.gain - a.gain) || (scoreOf(a, N) - scoreOf(b, N)));
		for (const A of list) {
			if (left() < 200 || stopped) return null;
			const { plans, why } = planOfAnchor(A);
			if (!plans.length) { A.exhausted = true; A.why = why || 'exhausted'; continue; }
			for (const plan of plans) {
				const step = plan.steps[0];
				const ek = edgeKey(step);
				if (inflight.has(ek) || localBlock.has(`${A.key}|${ek}`)) continue;
				const tk = `${ek}|${step.rung}|${epoch}`;
				if (tried.has(tk)) {
					// (a triple already run in this epoch: the planner proposes it again; blocked here so it never runs twice)
					localBlock.add(`${A.key}|${ek}`);
					bug('repeat', { edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, label: labelOf(step) });
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
		const room = left() - (best ? polishReserve : 0) - 100;
		const ms = Math.max(50, Math.min(rungMs[r] * mult, room));
		const deadline = Date.now() + ms;
		return { ms, level: r, k: ARRIVALS_K, deadline, stop: () => stopped || left() <= 0 || Date.now() > deadline + 2000 };
	};
	/** the waypoint a step runs to: its own, with beforeTick filled from beforeTickFrom (ticks after the earliest start) */
	const waypointOf = (step, A) => {
		const wp = step.waypoint || { kind: 'trophy', label: 'trophy' };
		const rel = Number.isFinite(+step.beforeTickFrom) ? +step.beforeTickFrom : Number.isFinite(+wp.beforeTickFrom) ? +wp.beforeTickFrom : NaN;
		if (!Number.isFinite(rel)) return wp;
		const t = A.arrivals.reduce((m, a) => Math.min(m, a.tick), Infinity);
		return Object.assign({}, wp, { beforeTick: t + rel });
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
			if (Number.isFinite(+wp.beforeTick) && r.goalAt > +wp.beforeTick) { bug('arrival', { label: labelOf(step), tick: masks.length, why: `the goal holds at tick ${r.goalAt}, past its beforeTick ${wp.beforeTick}` }); return; }
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
		const rec = { ev: 'step', n: steps, anchor: A.id, label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, epoch, tool: res.tool || null, ok: !!res.ok, ms, budgetMs: Math.round(budget.ms),
			why: res.ok ? '' : (fail && fail.why) || '', arrivals: arr.length, news, routes: routes.length };
		if (fail && fail.closest) rec.closest = { tile: fail.closest.tile, dist: fail.closest.dist };
		if (fail && Array.isArray(fail.blockedBy) && fail.blockedBy.length) rec.blockedBy = fail.blockedBy.slice(0, 4);
		say(rec);
		lastSteps.push({ n: steps, label: rec.label, rung: step.rung, ok: rec.ok, why: rec.why, ms, anchor: A.id });
		if (lastSteps.length > 8) lastSteps.shift();
		if (fail) { lastFails.push({ n: steps, label: rec.label, rung: step.rung, why: fail.why, closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [], touched: (fail.touched || []).length }); if (lastFails.length > 6) lastFails.shift(); }
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
	let exploreTurn = 0;
	const exploreJob = () => {
		const list = [...anchors.values()].filter((A) => !uselessA(A));
		for (let i = 0; i < list.length; i++) {
			const A = list[(exploreTurn + i) % list.length];
			const tiles = frontierOf(A);
			if (!tiles.length) continue;
			exploreTurn += i + 1;
			const step = { n: 0, edge: `explore:${A.key}:${stalls}`, nodeClass: `x${A.key}`, rung: Math.min(3, Math.max(0, stalls - 1)), synthetic: true, estTicks: 0,
				waypoint: { kind: 'region', tiles, expect: null, label: `explore ${tiles.length} tiles` } };
			return { anchor: A, plan: { id: 'explore', steps: [step], cost: 0, partial: true, why: 'stall' }, step };
		}
		return null;
	};
	const exploreQ = [];
	const deepen = (why) => {
		if (deepenings >= maxDeepen || rungMs[0] * mult * 2 > left() - (best ? polishReserve : 0)) return false;
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
			if (best && left() <= polishReserve && !inflight.size) { end = 'time'; break; }
			if (anchors.size !== anchorsSeen || best !== bestSeen) { anchorsSeen = anchors.size; bestSeen = best; progressAt = Date.now(); }
			if (stallEnd && Date.now() - progressAt > stallEnd) { end = 'stalled'; break; }
			while (inflight.size < P && !(best && left() <= polishReserve)) {
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
				// (every anchor exhausted: a global deepening, else the end)
				if (exploreQ.length) continue;
				if (best && left() <= polishReserve) { end = 'time'; break; }
				if (nothingSince >= 0 && nothingSince === steps) { end = 'exhausted'; break; }
				nothingSince = steps;
				if (!deepen('exhausted')) { end = 'exhausted'; break; }
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
		const tools = Object.entries(c).map(([k, v]) => `${k} ${v}${k === 'exact' && proven ? ` (${proven} proven)` : ''}`).join(', ');
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
		const ms = Math.max(200, Math.min(polishReserve, left() - 200));
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

	// ---- the bound again (the planner's facts may have raised it), the report
	try { const r = planner.lowerBound ? planner.lowerBound(startAnchorArg) : null; const t = lbTicks(r); if (t > LB) LB = t; if (r && r.complete) lbComplete = true; } catch (e) { /* the first one stands */ }
	if (best && LB > best.runTicks) { bug('bound', { why: `the lower bound ${LB} is above the route's ${best.runTicks} run ticks: inadmissible`, lb: LB }); LB = 0; }
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
		lb: LB, lbComplete, gap: best ? gapOf(best.runTicks) : null, legs: best ? best.legs : [], stages, known, why, end, anchors: anchors.size, steps, okSteps, bugs, deepenings, stalls, bnbPlans, bnbArrivals };
}

/** run(L, opts, emit): the compile loop as a Find a route strategy (src/plan.js): 300 s by default, the source events'
 *  distances on the editor's scale; returns compile()'s result (end, route, anchors, steps, okSteps, bugs, deepenings,
 *  stalls too) */
function run(L, opts = {}, emit = () => {}) {
	return compile(L, Object.assign({ seconds: 300, sourceDist: true }, opts), emit);
}

module.exports = { compile, run, knownOf, md5Of, partsOf, plansOf, RUNG_MS, STALL_S, POLISH_MS, POLISH_F };
