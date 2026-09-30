'use strict';
// The executor's worker thread (src/plan/executor.js): the level loaded ONCE from the file (types.js loadLevelFile: an
// .eelvl as the editor and goexplore.js read it, a level JSON, a level / job id), the executor's core (makeCore) on it,
// and the primitives / bounds of THIS thread when the main thread has them (prims.js / bounds.js required lazily; absent
// or failing: skipped). Messages: {id, type 'fp'} -> {id, fp} (the fingerprint: the level's state hashes after a fixed
// input sequence, the main thread's check that the level is the same); {id, type 'reach', starts (mask strings), wp
// (plain data), budget {ms, level, k, deadline}, stopFlag (SharedArrayBuffer: 1 = stop)} -> {id, result}; {id, type
// 'polish', masks (string), o} -> {id, result}. Arrivals leave as mask strings: snapshots never cross threads.
const { parentPort, workerData } = require('worker_threads');
const T = require('./types.js');
const EX = require('./executor.js');

let core = null, L = null, loadError = null;
let ready = null;
async function init() {
	try {
		L = T.loadLevelFile(workerData.file);
		let prims = null, bounds = null;
		if (workerData.useBounds) {
			try { const BM = require('./bounds.js'); bounds = BM.createBounds(L, {}); if (bounds && typeof bounds.then === 'function') bounds = await bounds; } catch (e) { bounds = null; }
		}
		if (workerData.usePrims) {
			try { const PM = require('./prims.js'); prims = await PM.createPrims(L, { file: workerData.file, bounds, model: null, workers: 0 }); } catch (e) { prims = null; }
		}
		core = EX.makeCore(L, { prims, bounds, model: null });
	} catch (e) { loadError = String(e && e.message || e); }
}
ready = init();

parentPort.on('message', async (msg) => {
	await ready;
	const id = msg.id;
	if (loadError) { parentPort.postMessage({ id, error: `the level: ${loadError}` }); return; }
	try {
		if (msg.type === 'fp') { parentPort.postMessage({ id, fp: EX.fingerprint(L) }); return; }
		const flag = msg.stopFlag ? new Int32Array(msg.stopFlag) : null;
		const stop = flag ? () => Atomics.load(flag, 0) !== 0 : null;
		if (msg.type === 'reach') {
			const result = await core.reach(msg.starts, msg.wp, Object.assign({}, msg.budget, { stop }));
			parentPort.postMessage({ id, result });
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
