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
//   {type: 'bwans', id, ok, masks, ms, why}   (workerData.bwShare) the answer to a far leg's request
//   {type: 'stop'}            end the loop (the worker then exits by itself)
//   {type: 'stats'}           a 'stats' answer now
// THE ONE SHOT'S OWN PROCESS (strategy.js OS_PROC, the default with EEAT_ONESHOT=1: EEAT_OS_PROC=0 the worker thread): the
// same code as a child process (child_process.fork: its messages on the IPC channel, its workerData in EEAT_OS_WORKERDATA),
// so its garbage collection runs on its own V8 platform threads and its whole process at OS_NICE, not on the pool the
// executor's worker threads share with it; it ends when the compile's channel closes.
const WT = require('worker_threads');
const IS_PROC = !WT.parentPort && typeof process.send === 'function';
const parentPort = IS_PROC ? { on: (ev, fn) => process.on(ev, fn), postMessage: (m) => process.send(m) } : WT.parentPort;
const workerData = IS_PROC ? JSON.parse(process.env.EEAT_OS_WORKERDATA || '{}') : WT.workerData;
if (IS_PROC) process.on('disconnect', () => process.exit(0));
const T = require('../types.js');

const SLICE_MS = +process.env.EEAT_OS_TSLICE || 250;     // one run() of the A* between two looks at the port
const STATS_MS = 2000;
const ARR_GAIN = +process.env.EEAT_OS_ARR_GAIN || 5;     // a sooner arrival of a state already sent goes out again past this
// THE ONE SHOT TAKES NOTHING AWAY (lane 6, push 3). The thread shares the machine with the executor's workers and the main
// thread; its A* is busy all the time (295 of 300 s on the failing levels) and its store grows ~1 KB a node (1-2 M nodes:
// +1.7 GB peak RSS a compile). Two limits keep the executor's clock and memory what they are without it:
// - OS_NICE: on Linux this thread's own nice value (setpriority on its thread id, /proc/thread-self) is raised to OS_NICE:
//   the scheduler gives it only the cycles the executor's threads leave (a compile that runs alone on free cores: the same
//   speed; a loaded machine: the executor first). Elsewhere nothing. EEAT_OS_NICE=0: the thread's nice as the process's.
// - OS_HEAP_MB: past this much live heap in this thread the A* stops growing (no more expansions; its route, its arrivals
//   and its injected states stay; the stats say heapStop). The live heap is measured (a full collection of this thread's
//   isolate, at most every 10 s) only when the used heap is past the limit. strategy.js also gives the thread's isolate an
//   old-space limit of OS_HEAP_MB + 512 MB (V8 collects near it: the garbage between two collections stays bounded).
//   EEAT_OS_HEAP_MB=0: no limit.
const envNum = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(+process.env[k]) ? +process.env[k] : d);
const OS_NICE = envNum('EEAT_OS_NICE', 19);
const OS_HEAP_MB = envNum('EEAT_OS_HEAP_MB', 1024);
/** this thread's nice value raised to OS_NICE (Linux: its own thread id) -> {tid, nice} or null */
function niceSelf() {
	if (!(OS_NICE > 0) || process.platform !== 'linux') return null;
	try {
		const fs = require('fs'), os = require('os');
		const tid = +String(fs.readlinkSync('/proc/thread-self')).split('/').pop();
		if (!(tid > 0)) return null;
		// (a process of its own: every thread it has now (V8's platform threads, libuv's), later ones inherit the main
		// thread's value; a worker thread: its own thread only, the executor's threads keep theirs)
		const tids = IS_PROC ? fs.readdirSync('/proc/self/task').map(Number).filter((t) => t > 0) : [tid];
		for (const t of tids) {
			try { const cur = os.getPriority(t); const want = Math.min(19, Math.max(cur, OS_NICE)); if (want !== cur) os.setPriority(t, want); } catch (e) { /* gone */ }
		}
		return { tid, nice: os.getPriority(tid), threads: tids.length, proc: IS_PROC };
	} catch (e) { return null; }
}
const heapMB = () => { try { return require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (e) { return 0; } };
/** the live heap (MB): a full collection first (this thread's isolate only), then the used heap */
let gcFn = null, liveAt = 0;
const liveHeapMB = () => {
	if (Date.now() - liveAt < 10000) return 0;
	liveAt = Date.now();
	try {
		if (!gcFn) { require('v8').setFlagsFromString('--expose-gc'); gcFn = require('vm').runInNewContext('gc'); }
		if (typeof gcFn === 'function') gcFn();
	} catch (e) { /* the used heap as it is */ }
	return heapMB();
};

let stopped = false;
const inbox = [];
parentPort.on('message', (m) => {
	if (!m || typeof m !== 'object') return;
	if (m.type === 'stop') { stopped = true; return; }
	inbox.push(m);
});
const post = (m) => { try { parentPort.postMessage(m); } catch (e) { /* the main thread is gone */ } };
// (the process mode: the compile gone = the channel closed: post throws or disconnect fires, and the loop ends)

(async () => {
	const t0 = Date.now();
	const niced = niceSelf();
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
	// (THE SHARED SESSION, workerData.bwShare (strategy.js: EEAT_OS_BW_ST=1 with the compile's stretch solver on): the far
	// legs go out as requests {type: 'bwreq', id, masks, wp, ms} to the compile's stretch child, whose backward solver serves
	// the executor's stretches too: no second backward solver in this process)
	const farLeg = workerData.bwShare ? (q) => post({ type: 'bwreq', id: q.id, masks: T.strOf(q.masks), wp: q.wp, ms: q.ms }) : null;
	const os = OSM.createOneShot(L, Object.assign({ model, planner, bounds, graph }, farLeg ? { farLeg } : {}));
	post({ type: 'ready', ms: Date.now() - t0, setupMs, nice: niced ? niced.nice : null });
	let bestT = Infinity, lastStats = 0, done = false, heapStop = false;
	const statsOf = () => Object.assign(os.stats(), { nice: niced ? niced.nice : null, heapMB: Math.round(heapMB()), heapStop });
	const sent = new Map();   // abstract state key -> the g of the arrival sent (sent again when the A* finds it sooner)
	const drain = () => {
		while (inbox.length) {
			const m = inbox.shift();
			if (m.type === 'inject' && m.masks) { try { if (os.inject(T.masksOf(m.masks), m.why || 'exec') && !heapStop) done = false; } catch (e) { /* not a state of this level */ } }
			else if (m.type === 'bwans') { try { if (os.farDone(m) && !heapStop) done = false; } catch (e) { /* not a state of this level */ } }
			else if (m.type === 'stats') post({ type: 'stats', stats: statsOf(), done });
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
		if (Date.now() - lastStats > STATS_MS) {
			lastStats = Date.now();
			// (the heap limit: the used heap past OS_HEAP_MB is measured again after a full collection: the live heap decides)
			if (OS_HEAP_MB > 0 && !heapStop && heapMB() > OS_HEAP_MB && liveHeapMB() > OS_HEAP_MB) { heapStop = true; done = true; }
			post({ type: 'stats', stats: statsOf(), done });
		}
		// (the port's messages: an inject may open the A* again after its open list ran out)
		await new Promise((res) => setTimeout(res, done ? 50 : 0));
	}
	harvest();
	post({ type: 'stats', stats: statsOf(), done, end: true });
	process.exit(0);
})().catch((e) => { post({ type: 'error', error: String(e && e.stack || e) }); process.exit(1); });
