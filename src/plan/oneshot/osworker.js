'use strict';
// src/plan/oneshot/osworker.js - THE ONE SHOT in a thread of its own (the compiler's MOVES stage's first tier, strategy.js
// OS_THREAD): the level loaded from its file, the model, the bounds and the planner built here as the compiler builds them
// (a copy of the main thread's: nothing crosses threads but mask strings), then src/plan/oneshot/solve.js run in slices
// for as long as the compile lets it. The executor's workers and the main thread keep all their time: this tier costs one
// thread (before, strategy.js ran the A* on the main thread for 0.3 of the moves' time BEFORE the executor's first step).
//
// workerData: {file, graph (0 / 1: part 2's whole-level graph, EEAT_OS_GRAPH), graphThreads, cache}
// messages out (every inputs field a mask string, T.strOf):
//   {type: 'ready', ms, setupMs}                         the parts built, the A* about to start
//   {type: 'route', masks, ticks}                        a better route of the one shot (the main thread verifies it)
//   {type: 'arr', key, masks, g}                         the first node of an abstract state not reported before
//   {type: 'stats', stats, done}                         every STATS_MS and at the end of a run with nothing left
//   {type: 'error', error}
// messages in:
//   {type: 'inject', masks}   a real state from the level start (an executor anchor, or a whole route: its bound)
//   {type: 'stop'}            end the loop (the worker then exits by itself)
//   {type: 'stats'}           a 'stats' answer now
const { parentPort, workerData } = require('worker_threads');
const T = require('../types.js');

const SLICE_MS = +process.env.EEAT_OS_TSLICE || 250;     // one run() of the A* between two looks at the port
const STATS_MS = 2000;
const ARR_GAIN = +process.env.EEAT_OS_ARR_GAIN || 5;     // a sooner arrival of a state already sent goes out again past this

let stopped = false;
const inbox = [];
parentPort.on('message', (m) => {
	if (!m || typeof m !== 'object') return;
	if (m.type === 'stop') { stopped = true; return; }
	inbox.push(m);
});
const post = (m) => { try { parentPort.postMessage(m); } catch (e) { /* the main thread is gone */ } };

(async () => {
	const t0 = Date.now();
	const L = T.loadLevelFile(workerData.file);
	const model = await require('../model.js').compileModel(L, { file: workerData.file });
	let bounds = null;
	try { bounds = require('../bounds.js').createBounds(L, { model }); if (bounds && typeof bounds.then === 'function') bounds = await bounds; } catch (e) { bounds = null; }
	const facts = require('../facts.js').createFacts({ rungs: 4, model });
	const planner = require('../planner.js').createPlanner(model, facts, { bounds, file: workerData.file, floorAsync: false });
	const OSM = require('./solve.js');
	let graph = null;
	if (workerData.graph) {
		try {
			const g = await require('./edges.js').buildGraph(workerData.file, { threads: Math.max(1, workerData.graphThreads | 0 || 1), cache: workerData.cache || null });
			graph = OSM.graphOf(g, L);
		} catch (e) { graph = null; }
	}
	const setupMs = Date.now() - t0;
	const os = OSM.createOneShot(L, { model, planner, bounds, graph });
	post({ type: 'ready', ms: Date.now() - t0, setupMs });
	let bestT = Infinity, lastStats = 0, done = false;
	const sent = new Map();   // abstract state key -> the g of the arrival sent (sent again when the A* finds it sooner)
	const drain = () => {
		while (inbox.length) {
			const m = inbox.shift();
			if (m.type === 'inject' && m.masks) { try { if (os.inject(T.masksOf(m.masks), m.why || 'exec')) done = false; } catch (e) { /* not a state of this level */ } }
			else if (m.type === 'stats') post({ type: 'stats', stats: os.stats(), done });
		}
	};
	const harvest = () => {
		const b = os.best();
		// (a route handed in whole is the bound, not news: only the one shot's own routes go out)
		if (b && b.masks && b.ticks < bestT) { bestT = b.ticks; if (b.kind !== 'inj') post({ type: 'route', masks: T.strOf(b.masks), ticks: b.ticks }); }
		// (per abstract state its earliest node: new, or sooner by ARR_GAIN ticks (2% of its tick at least) than the one sent;
		// a state handed in (inject) or the root is the main thread's own)
		for (const x of os.firsts()) {
			if (x.kind === 'inj' || x.kind === 'root') continue;
			const had = sent.get(x.key);
			if (had !== undefined && !(x.g < had - Math.max(ARR_GAIN, 0.02 * had))) continue;
			sent.set(x.key, x.g);
			const m = os.masksOf(x.id);
			if (m && m.length) post({ type: 'arr', key: String(x.key), masks: T.strOf(m), g: x.g });
		}
	};
	while (!stopped) {
		drain();
		if (!done) {
			let r = null;
			try { r = os.run(SLICE_MS, { stop: () => stopped }); } catch (e) { post({ type: 'error', error: String(e && e.stack || e) }); break; }
			harvest();
			if (r && r.done) { done = true; post({ type: 'stats', stats: r.stats, done: true }); }
		}
		if (Date.now() - lastStats > STATS_MS) { lastStats = Date.now(); post({ type: 'stats', stats: os.stats(), done }); }
		// (the port's messages: an inject may open the A* again after its open list ran out)
		await new Promise((res) => setTimeout(res, done ? 50 : 0));
	}
	harvest();
	post({ type: 'stats', stats: os.stats(), done, end: true });
	process.exit(0);
})().catch((e) => { post({ type: 'error', error: String(e && e.stack || e) }); process.exit(1); });
