'use strict';
// THE PLANNER'S LOOP (n4plan, part 'strategy'): UNDERSTAND -> PLAN -> EXECUTE -> REFINE as a Find a route strategy.
//
//   model = compileModel(L)            the level model: triggers, the doors they open, regions (src/plan/model.js)
//   facts = createFacts({rungs: 4})    what the loop learnt (CEGAR: an edge that failed from a state class)
//   planner = createPlanner(model, facts)
//   prims = createPrims(L)             exact motion primitives (optional part)
//   exec = createExecutor(L, {prims, gpu, RM})
//   anchors = {start}: real states (arrivals replayed by the engine), one per model state (S.key)
//   loop: pick an anchor -> plans = planner.plan(anchor) -> the first step of the best plan not in flight ->
//         exec.reach(anchor's arrivals, step.waypoint, budget(step.rung)) -> planner.learn(step, result) ->
//         every verified arrival with a new model state is a new anchor (a 'source' event: the one search's archive)
//   receding horizon: only a plan's first step runs; the planner plans again from the real arrival.
//
// THE NO-STALL CLOCK: a step's budget is its rung's (RUNG_MS: 3, 10, 30, 90 s of CPU; RUNG_GPU_S with a GPU), times
// `mult` (2^deepenings). The planner moves a failed (edge, nodeClass) up a rung (facts), a proof blocks it. Here: every
// executed step must add an anchor or change a fact (else a 'bug' event and the triple blocked here); no triple (edge,
// nodeClass, rung) runs twice in one deepening epoch; everything exhausted -> a global deepening (facts.reset keepProofs,
// budgets x2) or the end 'exhausted'; the watchdog (WATCH_MS) calls a STALL when no anchor was added and no fact changed
// for STALL_S while no step is inside its budget: a 'stall' event, the first one a deepening, later ones exploration steps
// (region waypoints on each anchor's unvisited walk frontier); with stallS > 0 no progress for stallS s ends 'stalled'.
//
// Every route is C.evaluate'd (the trophy step) and every arrival is replayed here (T.playTo + the waypoint's goal test)
// before it becomes an anchor: a part that returns an arrival that does not replay is a 'bug' event, the arrival dropped.
//
// Events (JSON lines through emit): start, model, plan, step, fact, source, closest (only with a steer file), result,
// progress (every PROGRESS_MS: detail = the page's status line), stall, bug, deepen, warning, done.
const fs = require('fs');
const path = require('path');
const T = require('./types.js');
const E = require('../eesim.js');

const RUNG_MS = [3000, 10000, 30000, 90000];
const RUNG_GPU_S = [5, 15, 45, 90];
const PROGRESS_MS = 2000, WATCH_MS = 10000, STALL_S = 60, SAVE_MS = 60000;
// the anchor pick: cost (the planner's, ticks) + TICK_W x the arrival's tick - GAIN_W x triggers gained + FAIL_W x fails
// - UCB_C x sqrt(ln N / (1 + picks))
const TICK_W = 0.2, GAIN_W = 100, FAIL_W = 50, UCB_C = 200;
const ARRIVALS_K = 4, MAX_DEEPEN = 4, STEER_MISS = 6000;
// exploration steps (the second stall on): frontier tiles within FRONTIER_STEPS walk steps of an anchor, at most FRONTIER_MAX
const FRONTIER_STEPS = 60, FRONTIER_MAX = 400;

/** the parts: opts.parts (tests inject mocks), else src/plan/*.js (lazy); a missing prims part is optional */
function partsOf(opts, emit) {
	const P = Object.assign({}, opts.parts || {});
	const need = (name, file) => {
		if (typeof P[name] === 'function') return;
		const m = require(file);
		if (typeof m[name] !== 'function') throw new Error(`${path.basename(file)} has no ${name}()`);
		P[name] = m[name];
	};
	need('compileModel', './model.js');
	need('createFacts', './facts.js');
	need('createPlanner', './planner.js');
	need('createExecutor', './executor.js');
	if (typeof P.createPrims !== 'function' && P.createPrims !== null) {
		try { const m = require('./prims.js'); P.createPrims = typeof m.createPrims === 'function' ? m.createPrims : null; } catch (e) {
			P.createPrims = null;
			emit({ ev: 'warning', text: `no motion primitives (${e.code === 'MODULE_NOT_FOUND' ? 'src/plan/prims.js missing' : e.message}): the executor without them` });
		}
	}
	return P;
}

const factsVer = (facts) => (facts ? (typeof facts.version === 'function' ? facts.version() : +facts.version || 0) : 0);
const edgeKey = (step) => `${step.edge}|${step.nodeClass === undefined ? '' : step.nodeClass}`;
const labelOf = (step) => (step && step.waypoint && step.waypoint.label) || (step && String(step.edge)) || '?';
/** a plan() answer as {plans, why}: an array (maybe with .why) or {plans, why} */
function plansOf(r) {
	if (Array.isArray(r)) return { plans: r.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || (r.length ? '' : 'exhausted') };
	if (r && Array.isArray(r.plans)) return { plans: r.plans.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || '' };
	return { plans: [], why: (r && r.why) || 'exhausted' };
}

/**
 * run(L, opts, emit) -> Promise<{end, route: Masks|null, anchors, steps}>
 * opts: {file, seconds (300), workers (2), seed (1), gpu (null | {tool, pausefile, work, cacheArgs, allowed}), steer (an
 * RCH4 file for the CPU: the 'closest' / 'source' distances), first (stop at the first route), stallS (0: none), out (a dir:
 * facts.json, anchors.json, events.jsonl every SAVE_MS and at the end), parts, stdinLines (an async iterable of lines),
 * depth (only routes of at most this many ticks), stallWindowS / watchMs / progressMs / rungMs (tests), maxDeepen}
 */
async function run(L, opts = {}, emit = () => {}) {
	const t0 = Date.now();
	const seconds = +opts.seconds > 0 ? +opts.seconds : 300;
	const workers = Math.max(1, Math.round(+opts.workers || 2));
	const rungMs = Array.isArray(opts.rungMs) ? opts.rungMs : RUNG_MS;
	const stallWindow = (+opts.stallWindowS > 0 ? +opts.stallWindowS : STALL_S) * 1000;
	const watchMs = +opts.watchMs > 0 ? +opts.watchMs : WATCH_MS;
	const progressMs = +opts.progressMs > 0 ? +opts.progressMs : PROGRESS_MS;
	const maxDeepen = Number.isFinite(+opts.maxDeepen) ? +opts.maxDeepen : MAX_DEEPEN;
	const P = Math.max(1, Math.floor(workers / 3));
	// ---- the event log (out/events.jsonl) next to emit
	const out = opts.out ? String(opts.out) : '';
	let evBuf = [];
	if (out) { try { fs.mkdirSync(out, { recursive: true }); } catch (e) { /* none */ } }
	const say = (ev) => {
		ev.t = Math.round((Date.now() - t0) / 100) / 10;
		emit(ev);
		if (out) { evBuf.push(JSON.stringify(ev)); if (evBuf.length > 5000) flushEvents(); }
	};
	const flushEvents = () => { if (!out || !evBuf.length) return; try { fs.appendFileSync(path.join(out, 'events.jsonl'), evBuf.join('\n') + '\n'); } catch (e) { /* read-only */ } evBuf = []; };
	const secNow = () => (Date.now() - t0) / 1000;
	const left = () => seconds * 1000 - (Date.now() - t0);

	// ---- the parts
	const parts = partsOf(opts, say);
	const tm = Date.now();
	const model = await parts.compileModel(L, { file: opts.file, seed: opts.seed });
	const cnt = (x) => (x == null ? undefined : Array.isArray(x) ? x.length : x instanceof Map || x instanceof Set ? x.size : typeof x === 'number' ? x : typeof x === 'object' ? Object.keys(x).length : undefined);
	say({ ev: 'model', triggers: cnt(model.triggers), feats: cnt(model.feats), doors: cnt(model.doors), regions: cnt(model.regions), ms: Date.now() - tm });
	const facts = parts.createFacts({ rungs: 4, model });
	const planner = parts.createPlanner(model, facts, { seed: opts.seed });
	let prims = null;
	if (parts.createPrims) {
		try { prims = await parts.createPrims(L, { file: opts.file, workers: 1, model }); } catch (e) { prims = null; say({ ev: 'warning', text: `the motion primitives could not start (${e.message}): the executor without them` }); }
	}
	const GX = require('../goexplore.js');
	const RM = opts.RM || GX.roomOf(L);
	const exec = await parts.createExecutor(L, { file: opts.file, workers, prims, gpu: opts.gpu || null, RM, emit: say, model, seed: opts.seed });
	say({ ev: 'start', triggers: cnt(model.triggers), relevant: cnt(model.relevant), workers, gpu: !!opts.gpu, parallel: P, prims: !!prims });

	// ---- distances (the editor's scale: the steer field's tiles, else STEER_MISS + the reach field's)
	const RF = require('../reach.js');
	let reachF = null, steer = null;
	const reachOf = () => { if (!reachF) { try { reachF = RF.reachField(L, { deaths: false }); } catch (e) { reachF = false; } } return reachF || null; };
	const loadSteer = (file) => {
		try { const SF = require('../steer.js'); steer = { SF, st: SF.readSteerFile(fs.readFileSync(file)), file }; return true; } catch (e) { say({ ev: 'warning', text: `steer file ${file}: ${e.message}` }); return false; }
	};
	if (opts.steer) loadSteer(opts.steer);
	const distOf = (sim) => {
		if (steer) { const v = steer.SF.steerAt(steer.st, sim); if (Number.isFinite(v)) return v; }
		const f = reachOf(); const c = f ? RF.costAt(f, sim) : -1;
		return c >= 0 ? Math.min(9990, STEER_MISS + c) : 9990;
	};

	// ---- a scratch engine for model states
	const scratch = new E.EESim(L);
	/** the sim at an arrival's end: its snapshot (checked by its hash) or a replay of its masks */
	const simOf = (a) => {
		if (a.snap) { try { scratch.reset(); scratch.restore(a.snap); if (!a.hash || scratch.stateHash() === a.hash) return scratch; } catch (e) { /* replay */ } }
		return T.playTo(L, a.masks, { allowDeath: true }).sim;
	};

	// ---- anchors
	const anchors = new Map();   // S.key -> anchor
	const visited = new Uint8Array(L.width * L.height);   // tiles along verified arrivals (the exploration frontier)
	let anchorSeq = 0, lastProgress = Date.now(), progressVer = factsVer(facts), steps = 0, okSteps = 0, picksN = 0;
	const tilesOf = (masks) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (!sim.is_dead) visited[T.tileOf(sim, L.width, L.height)] = 1; }
	};
	const gainOf = (S, parent) => {
		if (S && Number.isFinite(+S.gain)) return +S.gain;
		if (S && S.triggers && (Array.isArray(S.triggers) || S.triggers instanceof Set)) return Array.isArray(S.triggers) ? S.triggers.length : S.triggers.size;
		return parent ? parent.gain + 1 : 0;
	};
	/** a verified arrival a (its model state S): a new anchor, or one more diverse arrival of a known one -> {anchor, isNew} */
	const addArrival = (a, S, parent, why) => {
		const key = String(S.key);
		let A = anchors.get(key);
		if (!A) {
			A = { id: ++anchorSeq, key, S, arrivals: [a], firstTick: a.tick, picks: 0, fails: 0, exhausted: false, why: '', gain: gainOf(S, parent), parent: parent ? parent.key : null,
				costEst: parent && Number.isFinite(parent.nextCost) ? parent.nextCost : Infinity, costVer: -1, plans: null, via: why };
			anchors.set(key, A);
			try { tilesOf(a.masks); } catch (e) { /* none */ }
			lastProgress = Date.now();
			return { anchor: A, isNew: true };
		}
		const before = A.arrivals.map((x) => x.hash).join(',');
		A.arrivals = T.pickDiverse(A.arrivals.concat([a]), ARRIVALS_K);
		if (a.tick < A.firstTick) A.firstTick = a.tick;
		return { anchor: A, isNew: false, changed: A.arrivals.map((x) => x.hash).join(',') !== before };
	};
	{
		const r = T.playTo(L, new Uint8Array(0));
		const a0 = T.arrivalOf(L, r.sim, new Uint8Array(0), RM);
		addArrival(a0, model.stateOf(r.sim), null, 'start');
	}

	// ---- the route and the depth bound
	let depth = Number.isFinite(+opts.depth) && +opts.depth > 0 ? +opts.depth : Infinity;
	let best = null;   // {masks, ticks, runTicks}
	const routeOf = (masks, how) => {
		const C = require('../common.js');
		const ev = C.evaluate(L, masks);
		if (!ev) return null;
		if (ev.complete > depth) return { slow: true, ev };
		best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths };
		depth = ev.complete - 1;
		say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how, inputs: T.strOf(ev.ms) });
		if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
		lastProgress = Date.now();
		return { ev };
	};

	// ---- control: stdin lines
	let stopped = false, end = '';
	const onLine = (line) => {
		const s = String(line).trim();
		if (!s) return;
		const sp = s.indexOf(' '), cmd = sp < 0 ? s : s.slice(0, sp), arg = sp < 0 ? '' : s.slice(sp + 1).trim();
		if (cmd === 'stop') stopped = true;
		else if (cmd === 'depth' && +arg > 0) depth = Math.min(depth, +arg);
		else if ((cmd === 'steer' || cmd === 'steerd') && arg) loadSteer(arg);
		else if ((cmd === 'import' || cmd === 'route') && /^[0-O]+$/.test(arg)) {
			const masks = T.masksOf(arg);
			if (cmd === 'route') {
				const C = require('../common.js');
				const ev = C.evaluate(L, masks);
				if (ev && ev.complete - 1 < depth) depth = ev.complete - 1;
			}
			// (the one search's room, or the known route's states along it: a replay; a model state not seen yet is an anchor)
			try {
				const r = T.playTo(L, masks, { allowDeath: true });
				if (!r.sim.is_dead && !r.sim.has_silver_crown) {
					const a = T.arrivalOf(L, r.sim, masks, RM);
					const res = addArrival(a, model.stateOf(r.sim), null, cmd);
					if (res.isNew) { imports++; say({ ev: 'import', anchor: res.anchor.id, key: res.anchor.key, tick: a.tick }); }
				}
			} catch (e) { say({ ev: 'warning', text: `${cmd}: ${e.message}` }); }
		}
	};
	let imports = 0;
	if (opts.stdinLines) {
		(async () => { try { for await (const line of opts.stdinLines) onLine(line); } catch (e) { /* closed */ } if (opts.stopOnStdinEnd) stopped = true; })();
	}

	// ---- the no-stall bookkeeping
	const tried = new Map();   // `${edge}|${nodeClass}|${rung}|${epoch}` -> {ok}
	const localBlock = new Set();   // `${anchor.key}|${edge}|${nodeClass}`: blocked here (a part's bug)
	let epoch = 0, mult = 1, deepenings = 0, stalls = 0, lastSteps = [], bugs = 0, nothingSince = -1;
	const inflight = new Map();   // edgeKey -> {promise, job, started, budgetMs}
	let cur = null;   // the last plan (the page's line)
	const bug = (what, o) => { bugs++; say(Object.assign({ ev: 'bug', what }, o || {})); };
	const planOfAnchor = (A) => {
		const v = factsVer(facts);
		if (A.plans && A.planVer === v && A.planEpoch === epoch) return A.plans;
		let r;
		try { r = planner.plan({ arrival: A.arrivals[0], S: A.S, key: A.key }, { k: 3, depth, epoch }); } catch (e) { bug('plan', { error: e.message, anchor: A.id }); r = { plans: [], why: `error: ${e.message}` }; }
		const p = plansOf(r);
		A.plans = p; A.planVer = v; A.planEpoch = epoch;
		A.costEst = p.plans.length ? +p.plans[0].cost || 0 : Infinity; A.costVer = v;
		return p;
	};
	const scoreOf = (A, N) => (Number.isFinite(A.costEst) ? A.costEst : 1e7) + TICK_W * A.firstTick - GAIN_W * A.gain + FAIL_W * A.fails - UCB_C * Math.sqrt(Math.log(N + 1) / (1 + A.picks));
	/** the next job: {anchor, plan, step} not in flight, or null (none: every anchor exhausted or busy) */
	const nextJob = () => {
		const N = picksN + 1;
		const open = [...anchors.values()].filter((A) => !A.exhausted && A.firstTick <= depth);
		// (an anchor never planned (an import, the start): planned once for its cost; the others keep their last cost until
		// they are picked: planned again then)
		for (const A of open) if (A.costVer < 0 && !Number.isFinite(A.costEst)) { const p = planOfAnchor(A); if (!p.plans.length) { A.exhausted = true; A.why = p.why || 'exhausted'; } }
		const list = open.filter((A) => !A.exhausted).sort((a, b) => scoreOf(a, N) - scoreOf(b, N));
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
	const budgetOf = (rung) => {
		const r = Math.max(0, Math.min(rungMs.length - 1, rung | 0));
		const ms = Math.max(50, Math.min(rungMs[r] * mult, left() - 100));
		return { ms, level: r, k: 3, gpuS: opts.gpu ? Math.min(RUNG_GPU_S[Math.min(3, r)] * mult, ms / 1000) : 0, stop: () => stopped || left() <= 0 };
	};
	/** a StepResult's arrivals checked here (replayed, the goal test, alive at the end): the verified ones */
	const verified = (step, res) => {
		const out2 = [];
		const wp = step.waypoint;
		if (!res || !res.ok || !Array.isArray(res.arrivals)) return out2;
		const goal = wp.kind === 'trophy' ? null : T.goalOf(L, wp);
		for (const a of res.arrivals) {
			if (!a || !a.masks) continue;
			const masks = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			if (masks.length > depth && wp.kind !== 'trophy') continue;   // (no route through it can beat the bound: a proof, it is at least that long)
			if (wp.kind === 'trophy') {
				const ev = require('../common.js').evaluate(L, masks, false);
				if (!ev) { bug('arrival', { label: labelOf(step), tick: masks.length, why: 'a trophy arrival that does not finish on its replay' }); continue; }
				out2.push(Object.assign({}, a, { masks, finished: true }));
				continue;
			}
			const r = T.playTo(L, masks, { goal, allowDeath: goal.allowDeath });
			if (r.goalAt < 0 || r.sim.is_dead) { bug('arrival', { label: labelOf(step), tick: masks.length, why: r.goalAt < 0 ? 'the goal test never holds on its replay' : 'dead at its end' }); continue; }
			out2.push(Object.assign(T.arrivalOf(L, r.sim, masks, RM), {}));
		}
		return out2;
	};
	const learnFrom = (step, res) => {
		let fs2 = [];
		if (step.synthetic) return fs2;
		try { fs2 = planner.learn(step, res) || []; } catch (e) { bug('learn', { error: e.message, label: labelOf(step) }); }
		for (const f of fs2) say({ ev: 'fact', kind: f.kind || f.type || '?', edge: f.edge !== undefined ? f.edge : step.edge, rung: f.rung !== undefined ? f.rung : step.rung, why: f.why });
		return fs2;
	};
	/** one job run: exec.reach, learn, anchors; resolves when done */
	const runJob = async (job) => {
		const { anchor: A, step, plan } = job;
		const ek = edgeKey(step), tk = `${ek}|${step.rung}|${epoch}`;
		tried.set(tk, { ok: false });
		A.picks++; picksN++;
		const budget = budgetOf(step.rung);
		const t1 = Date.now();
		steps++;
		const verBefore = factsVer(facts), anchorsBefore = anchors.size;
		let res;
		try { res = await exec.reach(A.arrivals, step.waypoint, budget); } catch (e) { res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: { why: 'budget', error: e.message, closest: null, touched: [], blockedBy: [], level: budget.level } }; bug('reach', { error: e.message, label: labelOf(step) }); }
		if (!res) res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level } };
		const arr = verified(step, res);
		if (res.ok && !arr.length) { res = Object.assign({}, res, { ok: false, fail: res.fail || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level } }); }
		else if (res.ok) res = Object.assign({}, res, { arrivals: arr });
		tried.get(tk).ok = !!res.ok;
		let news = 0, route = null;
		if (res.ok) {
			okSteps++;
			for (const a of arr) {
				if (step.waypoint.kind === 'trophy' || a.finished) {
					const r = routeOf(a.masks, labelOf(step));
					if (r && r.ev && !r.slow) route = r.ev;
					continue;
				}
				const sim = simOf(a);
				let S2;
				try { S2 = model.stateOf(sim); } catch (e) { bug('stateOf', { error: e.message }); continue; }
				A.nextCost = Number.isFinite(+plan.cost) && Number.isFinite(+step.estTicks) ? Math.max(0, plan.cost - step.estTicks) : undefined;
				const { anchor: B, isNew, changed } = addArrival(a, S2, A, labelOf(step));
				if (isNew) {
					news++;
					say({ ev: 'source', kind: 'room', room: a.room, desc: a.desc, gain: 1, tick: a.tick, dist: Math.round(distOf(sim) * 10) / 10, inputs: T.strOf(a.masks), anchor: B.id, label: labelOf(step) });
					if (steer) say({ ev: 'closest', dist: Math.round(distOf(sim) * 10) / 10, tick: a.tick, inputs: T.strOf(a.masks), anchor: B.id });
				} else if (changed && step.synthetic) lastProgress = Date.now();
			}
		} else A.fails++;
		learnFrom(step, res);
		const ms = Date.now() - t1;
		const rec = { ev: 'step', n: steps, anchor: A.id, label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, epoch, tool: res.tool || null, ok: !!res.ok, ms, why: res.ok ? '' : (res.fail && res.fail.why) || '', arrivals: arr.length, news };
		if (!res.ok && res.fail && res.fail.closest) rec.closest = { tile: res.fail.closest.tile, dist: res.fail.closest.dist };
		say(rec);
		lastSteps.push({ n: steps, label: rec.label, rung: step.rung, ok: rec.ok, why: rec.why, ms });
		if (lastSteps.length > 8) lastSteps.shift();
		const verAfter = factsVer(facts);
		if (verAfter !== verBefore) lastProgress = Date.now();
		// (the invariant: every step adds an anchor or changes a fact; else the planner would propose it again: blocked here)
		if (!step.synthetic && anchors.size === anchorsBefore && verAfter === verBefore && !route) {
			localBlock.add(`${A.key}|${ek}`);
			bug('no progress', { label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, ok: !!res.ok });
		}
		A.plans = null;   // (plan again from here: receding horizon)
		cur = { plan, step, anchor: A.id, ok: rec.ok };
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
		const list = [...anchors.values()].filter((A) => A.firstTick <= depth);
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
	let exploreQ = [];
	const deepen = (why) => {
		if (deepenings >= maxDeepen || rungMs[0] * mult * 2 > left()) return false;
		deepenings++; epoch++; mult *= 2;
		try { if (facts && typeof facts.reset === 'function') facts.reset({ keepProofs: true, boost: 2 }); } catch (e) { bug('reset', { error: e.message }); }
		for (const A of anchors.values()) { A.exhausted = false; A.why = ''; A.plans = null; }
		localBlock.clear();
		say({ ev: 'deepen', why, n: deepenings, mult, anchors: anchors.size });
		lastProgress = Date.now();
		return true;
	};

	// ---- progress, the watchdog and the files
	const detail = () => {
		const pl = cur && cur.plan;
		const lab = pl && Array.isArray(pl.steps) ? pl.steps.slice(0, 4).map(labelOf).join(' -> ') + (pl.steps.length > 4 ? ' -> ...' : '') : 'planning';
		const run = [...inflight.values()][0];
		const st = run ? ` · step ${steps + 1} (rung ${run.job.step.rung}, ${run.job.step.synthetic ? 'explore' : 'running'})` : cur ? ` · last ${cur.ok ? 'ok' : 'failed'}` : '';
		return `plan ${pl ? pl.steps.length : 0} steps: ${lab}${st} · ${anchors.size} states · ${factsCount()} facts${best ? ` · route ${best.ticks} ticks` : ''}`;
	};
	const factsCount = () => { try { const s = planner.stats ? planner.stats() : null; if (s && Number.isFinite(+s.facts)) return +s.facts; } catch (e) { /* none */ } return factsVer(facts); };
	const progress = () => {
		const maxTick = Math.max(0, ...[...anchors.values()].map((A) => A.firstTick));
		say({ ev: 'progress', states: anchors.size, rooms: anchors.size, triggers: Math.max(0, ...[...anchors.values()].map((A) => A.gain)), steps, okSteps, facts: factsCount(), sec: Math.round(secNow() * 10) / 10,
			workers, layer: maxTick, tick: maxTick, ticksPerSec: 0, imports, bugs, deepenings, stalls, exhausted: [...anchors.values()].filter((A) => A.exhausted).length, detail: detail() });
	};
	const saveFiles = () => {
		if (!out) return;
		flushEvents();
		try {
			const fj = facts && typeof facts.toJSON === 'function' ? facts.toJSON() : planner.stats ? planner.stats() : { version: factsVer(facts) };
			fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(fj, null, 1));
			fs.writeFileSync(path.join(out, 'anchors.json'), JSON.stringify([...anchors.values()].map((A) => ({ id: A.id, key: A.key, via: A.via, parent: A.parent, firstTick: A.firstTick, picks: A.picks, fails: A.fails,
				exhausted: A.exhausted, why: A.why, gain: A.gain, cost: Number.isFinite(A.costEst) ? A.costEst : null, arrivals: A.arrivals.map((a) => ({ tick: a.tick, tile: a.tile, vx: a.vx, vy: a.vy, room: a.room, desc: a.desc })) })), null, 1));
		} catch (e) { /* read-only */ }
	};
	let stalledFor = 0;
	const watchdog = () => {
		const now = Date.now();
		// (a long step inside its budget is working (rung 2-3: 30-90 s): no stall while one runs; steps that come and go
		// without progress are the stall)
		const busy = [...inflight.values()].some((f) => now - f.started >= 1000 && now - f.started < f.budgetMs + 5000);
		const v = factsVer(facts);
		if (v !== progressVer) { progressVer = v; lastProgress = now; }
		if (busy) return;
		if (now - lastProgress >= stallWindow) {
			stalls++;
			let fsum = null;
			try { fsum = planner.stats ? planner.stats() : null; } catch (e) { /* none */ }
			say({ ev: 'stall', why: `no new state and no fact changed for ${Math.round((now - lastProgress) / 1000)} s`, n: stalls, lastSteps: lastSteps.slice(), anchors: anchors.size, exhausted: [...anchors.values()].filter((A) => A.exhausted).length, facts: fsum });
			if (stalls === 1) deepen('stall');
			else { const j = exploreJob(); if (j) exploreQ.push(j); }
			stalledFor += now - lastProgress;
			lastProgress = now;
		}
	};
	const timers = [setInterval(progress, progressMs), setInterval(watchdog, watchMs), setInterval(saveFiles, SAVE_MS)];
	for (const tt of timers) if (tt.unref) tt.unref();
	const stallEnd = +opts.stallS > 0 ? +opts.stallS * 1000 : 0;
	let progressAt = Date.now();   // (the last real progress: a new anchor or a route, for --stallS)
	let anchorsSeen = anchors.size;

	// ---- the loop
	progress();
	try {
		while (true) {
			if (stopped) { end = 'stopped'; break; }
			if (left() <= 0) { end = 'time'; break; }
			if (best && opts.first) { end = 'finish'; break; }
			if (anchors.size !== anchorsSeen || (best && best.at === undefined)) { anchorsSeen = anchors.size; progressAt = Date.now(); if (best) best.at = progressAt; }
			if (stallEnd && Date.now() - progressAt > stallEnd) { end = 'stalled'; break; }
			while (inflight.size < P) {
				const job = exploreQ.length ? exploreQ.shift() : nextJob();
				if (!job) break;
				const ek = edgeKey(job.step);
				if (inflight.has(ek)) continue;
				cur = { plan: job.plan, step: job.step, anchor: job.anchor.id, ok: null };
				say({ ev: 'plan', anchor: job.anchor.id, steps: job.plan.steps.map(labelOf), cost: job.plan.cost, partial: !!job.plan.partial, why: job.plan.why || '', rung: job.step.rung });
				const budget = budgetOf(job.step.rung);
				const f = { job, started: Date.now(), budgetMs: budget.ms };
				f.promise = runJob(job).catch((e) => { bug('job', { error: e.message }); return {}; }).then((r) => { inflight.delete(ek); return r; });
				inflight.set(ek, f);
			}
			if (!inflight.size) {
				// (every anchor exhausted: a global deepening, else the end)
				if (exploreQ.length) continue;
				if (nothingSince >= 0 && nothingSince === steps) { end = 'exhausted'; break; }
				nothingSince = steps;
				if (!deepen('exhausted')) { end = 'exhausted'; break; }
				continue;
			}
			const tick = new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
			await Promise.race([...[...inflight.values()].map((f) => f.promise), tick]);
		}
		// (in-flight steps: told to stop, awaited briefly)
		stopped = true;
		const wait = Promise.all([...inflight.values()].map((f) => f.promise));
		await Promise.race([wait, new Promise((res) => { const tt = setTimeout(res, 3000); if (tt.unref) tt.unref(); })]);
	} finally {
		for (const tt of timers) clearInterval(tt);
		try { if (exec && exec.close) await exec.close(); } catch (e) { /* closed */ }
		try { if (prims && prims.close) await prims.close(); } catch (e) { /* closed */ }
	}
	progress();
	say({ ev: 'done', end, sec: Math.round(secNow() * 10) / 10, steps, okSteps, anchors: anchors.size, routes: best ? 1 : 0, best: best ? best.ticks : null, bugs, deepenings, stalls, layers: Math.max(0, ...[...anchors.values()].map((A) => A.firstTick)) });
	saveFiles();
	return { end, route: best ? best.masks : null, anchors: anchors.size, steps, okSteps, bugs, deepenings, stalls };
}

module.exports = { run, RUNG_MS, RUNG_GPU_S, STALL_S, plansOf };
