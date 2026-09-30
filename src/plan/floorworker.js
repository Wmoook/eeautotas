'use strict';
// The planner's floor probe off the critical path (src/plan/planner.js, o.floorAsync): steer.js buildSteer on the level
// (loaded here from its file, else the level object the planner posted), noDP, its floors posted back:
// {floors: [{feat, param, at, from}], ms} | {error}. The planner terminates this thread at its hard cap (FLOOR_HARD_MS).
const { parentPort, workerData } = require('worker_threads');
const t0 = Date.now();
try {
	const L = workerData.file ? require('./types.js').loadLevelFile(workerData.file) : workerData.L;
	const st = require('../steer.js').buildSteer(L, { maxMs: workerData.maxMs, noDP: true, maxLayers: workerData.maxLayers });
	const floors = ((st && st.info && st.info.floors) || []).map((x) => ({ feat: x.feat, param: x.param, at: x.at, from: x.from }));
	parentPort.postMessage({ floors, ms: Date.now() - t0 });
} catch (e) {
	parentPort.postMessage({ error: String((e && e.message) || e), ms: Date.now() - t0 });
}
