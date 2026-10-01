'use strict';
// The executor's worker thread (src/plan/executor.js): the level loaded ONCE from the file (types.js loadLevelFile: an
// .eelvl as the editor and goexplore.js read it, a level JSON, a level / job id), the executor's core (makeCore) on it,
// and the primitives / bounds of THIS thread when the main thread has them (prims.js / bounds.js required lazily; absent
// or failing: skipped). Messages: {id, type 'fp'} -> {id, fp} (the fingerprint: the level's state hashes after a fixed
// input sequence, the main thread's check that the level is the same); {id, type 'reach', starts (mask strings), wp
// (plain data), budget {ms, level, k, deadline}, stopFlag (SharedArrayBuffer: 1 = stop)} -> {id, result}; {id, type
// 'polish', masks (string), o} -> {id, result}; {id, type 'mutscan', masks, o {ranges, deadline}} -> {id, result {shortcuts}}
// (polish.js mutatePass on those ranges: the executor's parallel first pass). Arrivals leave as mask strings: snapshots never cross threads.
const { parentPort, workerData } = require('worker_threads');
const T = require('./types.js');
const EX = require('./executor.js');

// (EEAT_EXEC_PROF=1, a measurement: each answer carries {prof}: the worker's start-up, the wait for it, the RCH3 fields
// built (reach.js reachField) and the bounds fields (bounds.field) inside the call, the call's own time)
const PROF = process.env.EEAT_EXEC_PROF === '1';
const acc = { rf: 0, rfN: 0, bf: 0, bfN: 0 };
let initMs = -1, firstAnswer = true;
if (PROF) {
	const RF = require('../reach.js');
	const rf0 = RF.reachField;
	RF.reachField = function () { const t = Date.now(); try { return rf0.apply(this, arguments); } finally { acc.rf += Date.now() - t; acc.rfN++; } };
}
let core = null, L = null, loadError = null;
let ready = null;
async function init() {
	const tI = Date.now();
	try {
		L = T.loadLevelFile(workerData.file);
		let prims = null, bounds = null;
		if (workerData.useBounds) {
			try { const BM = require('./bounds.js'); bounds = BM.createBounds(L, {}); if (bounds && typeof bounds.then === 'function') bounds = await bounds; } catch (e) { bounds = null; }
		}
		if (workerData.usePrims) {
			try { const PM = require('./prims.js'); prims = await PM.createPrims(L, { file: workerData.file, bounds, model: null, workers: 0 }); } catch (e) { prims = null; }
		}
		if (PROF && bounds && typeof bounds.field === 'function') {
			const bf0 = bounds.field;
			bounds.field = function () { const t = Date.now(); try { return bf0.apply(this, arguments); } finally { const d = Date.now() - t; if (d >= 1) { acc.bf += d; acc.bfN++; } } };
		}
		core = EX.makeCore(L, { prims, bounds, model: null });
	} catch (e) { loadError = String(e && e.message || e); }
	initMs = Date.now() - tI;
}
ready = init();

parentPort.on('message', async (msg) => {
	const tRecv = Date.now();
	await ready;
	const tReady = Date.now();
	const a0 = PROF ? Object.assign({}, acc) : null;
	const id = msg.id;
	if (loadError) { parentPort.postMessage({ id, error: `the level: ${loadError}` }); return; }
	try {
		if (msg.type === 'fp') { parentPort.postMessage({ id, fp: EX.fingerprint(L) }); return; }
		const flag = msg.stopFlag ? new Int32Array(msg.stopFlag) : null;
		const stop = flag ? () => Atomics.load(flag, 0) !== 0 : null;
		if (msg.type === 'reach') {
			const result = await core.reach(msg.starts, msg.wp, Object.assign({}, msg.budget, { stop }));
			if (PROF && result) {
				result.prof = { post: msg.tPost || 0, recv: tRecv, wait: tReady - tRecv, run: Date.now() - tReady, init: firstAnswer ? initMs : 0,
					rf: acc.rf - a0.rf, rfN: acc.rfN - a0.rfN, bf: acc.bf - a0.bf, bfN: acc.bfN - a0.bfN, ms: msg.budget && msg.budget.ms, end: Date.now() };
				// (this worker's own isolate: its used and total heap, MB: where a compile's memory goes)
				try { const hs = require('v8').getHeapStatistics(); result.prof.heapUsed = Math.round(hs.used_heap_size / 1048576); result.prof.heapTotal = Math.round(hs.total_heap_size / 1048576); result.prof.ext = Math.round(hs.external_memory / 1048576); } catch (e) { /* none */ }
				firstAnswer = false;
			}
			parentPort.postMessage({ id, result });
			return;
		}
		if (msg.type === 'mutscan') {
			// (a range of polish.js's first mutation pass: the shortcuts found, their inputs as strings)
			const P = require('./polish.js');
			const r = P.mutatePass(L, T.masksOf(msg.masks), Object.assign({}, msg.o, { stop }));
			parentPort.postMessage({ id, result: { shortcuts: r.shortcuts.map((c) => ({ t: c.t, j: c.j, saved: c.saved, ins: T.strOf(c.ins) })), timeUp: r.timeUp, ticks: r.ticks } });
			return;
		}
		if (msg.type === 'polish') {
			const result = await core.polish(msg.masks, Object.assign({}, msg.o, { stop }));
			if (result && result.masks && typeof result.masks !== 'string') result.masks = T.strOf(result.masks);
			parentPort.postMessage({ id, result });
			return;
		}
		parentPort.postMessage({ id, error: `unknown message ${msg.type}` });
	} catch (e) {
		parentPort.postMessage({ id, error: String(e && e.stack || e) });
	}
});
