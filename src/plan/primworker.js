'use strict';
// THE PRIMITIVES' WORKER THREADS (n4plan part 'primitives'): route() calls of src/plan/prims.js on other threads (a
// snapshot is valid only in its own thread and level object: starts and results cross as mask strings, types.js
// strOf / masksOf) and the arc tables' modes (src/plan/tables.js). The level comes from the file (types.js
// loadLevelFile: legsearch.js levelOf for .eelvl / level JSON, common.js loadLevel for a job / level id).
//   createPool(file, n) -> {route(startStrs, wp, budget, o) -> Promise<result with mask strings | null>, table(mode) ->
//                           Promise<Float32Array>, close()}
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread && workerData && workerData.primworker) {
	const T = require('./types.js');
	const P = require('./prims.js');
	let prims = null;
	const ready = (async () => { const L = T.loadLevelFile(workerData.file); prims = await P.createPrims(L, { file: null, tables: false }); })();
	parentPort.on('message', async (m) => {
		try {
			await ready;
			if (m.type === 'route') {
				const L = prims.L;
				const starts = m.starts.map((s) => { const masks = T.masksOf(s); const r = T.playTo(L, masks, { allowDeath: true }); return T.arrivalOf(L, r.sim, masks, null); });
				const goal = T.goalOf(L, m.wp);
				const r = prims.route(starts, goal, m.budget || {}, m.o || {});
				parentPort.postMessage({ id: m.id, ok: true, r: { ok: r.ok, arrivals: r.arrivals.map((a) => T.strOf(a.masks)), best: r.best ? { masks: T.strOf(r.best.masks), ticks: r.best.ticks } : null,
					lb: r.lb, proven: r.proven, expanded: r.expanded, sims: r.sims, why: r.why, ms: r.ms, closest: r.closest ? Object.assign({}, r.closest, { masks: T.strOf(r.closest.masks) }) : null } });
			} else if (m.type === 'table') {
				const TB = require('./tables.js');
				const rows = TB.buildMode(m.mode, P.MACROS.plain);
				parentPort.postMessage({ id: m.id, ok: true, rows }, [rows.buffer]);
			}
		} catch (e) { parentPort.postMessage({ id: m.id, ok: false, error: String(e && e.stack || e) }); }
	});
}

function createPool(file, n) {
	const workers = [], pending = new Map(), idle = [], queue = [];
	let nextId = 1;
	const run = (w, job) => { w.job = job; w.postMessage(job.msg); };
	for (let i = 0; i < Math.max(1, n); i++) {
		const w = new Worker(__filename, { workerData: { primworker: true, file } });
		w.on('message', (m) => {
			const job = pending.get(m.id);
			pending.delete(m.id);
			w.job = null;
			if (job) job.done(m.ok ? (m.r || m.rows) : null);
			const nx = queue.shift();
			if (nx) run(w, nx); else idle.push(w);
		});
		w.on('error', () => { const job = w.job; if (job) { pending.delete(job.msg.id); job.done(null); } });
		workers.push(w); idle.push(w);
	}
	const submit = (msg) => new Promise((resolve) => {
		msg.id = nextId++;
		const job = { msg, done: resolve };
		pending.set(msg.id, job);
		const w = idle.pop();
		if (w) run(w, job); else queue.push(job);
	});
	return {
		route: (starts, wp, budget, o) => submit({ type: 'route', starts, wp, budget, o }),
		table: (mode) => submit({ type: 'table', mode }),
		close: () => { for (const w of workers) w.terminate(); workers.length = 0; },
	};
}

module.exports = { createPool };
