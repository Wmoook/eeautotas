'use strict';
// Processor benchmark for the web app's "Processor" selector (GET /api/system): how many ticks per second the exact
// engine (eesim.js) simulates on this machine, on one thread and on all threads at once. It runs a synthetic arena
// (solid floors and walls, gaps, arrows, dots, spikes) with random sticky inputs for about 1 s per measurement, in
// worker threads, and is cached in src/data/_system.json per CPU model, thread count, Node version and engine size.
// The optimizer's searches also snapshot, restore and hash states, so real search throughput is lower; the numbers
// compare processors and thread counts.
//
// Why there is no GPU mode: see README.md ("CPU or GPU"). In short, the engine is bit-exact IEEE double (64-bit)
// EE physics with heavy branching; WebGPU has no f64 at all, and gaming GPUs run f64 at 1/64 of their f32 rate.
//   node src/bench.js [--threads=N] [--ms=1000]   (prints the measurement; does not touch the cache)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const CACHE = path.join(process.env.EEAT_HOME ? path.resolve(process.env.EEAT_HOME) : __dirname, 'data', '_system.json');   // = common.js DATA

/** the synthetic benchmark level (eelvl.js toSimLevel JSON format) */
function arenaJson() {
	const W = 120, H = 60, fg = new Int32Array(W * H);
	let s = 12345;
	const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	for (let y = 8; y < H - 1; y += 8) {   // floors with gaps
		for (let x = 1; x < W - 1; x++) if (rnd() < 0.8) fg[y * W + x] = 9;
	}
	for (let k = 0; k < 400; k++) {   // blocks, arrows, dots, a few spikes
		const x = 1 + ((rnd() * (W - 2)) | 0), y = 1 + ((rnd() * (H - 2)) | 0), r = rnd();
		fg[y * W + x] = r < 0.55 ? 9 : r < 0.7 ? 1 + ((rnd() * 3) | 0) : r < 0.8 ? 4 : r < 0.85 ? 361 : 10;
	}
	fg[2 * W + 2] = 255;
	return { format: 'eesim-level-1', level_id: 'bench_arena', width: W, height: H, gravity: 1, fg_b64: Buffer.from(fg.buffer).toString('base64'),
		bg_b64: Buffer.from(new Int32Array(W * H).buffer).toString('base64'), extras: [], spawn_points: [[[2, 2]]] };
}

/** runs the engine for `ms` milliseconds on this thread; returns ticks simulated */
function spin(ms) {
	const E = require('./eesim.js');
	const level = E.prepareLevel(arenaJson());
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	let s = 777, mask = 0, ticks = 0;
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		sim.reset();
		for (let k = 0; k < 4000; k++) {
			s = (s * 1103515245 + 12345) >>> 0;
			if ((s >>> 24) < 20) mask = (s >>> 8) & 31;   // sticky random inputs
			E.applyMask(inp, mask);
			sim.tick(inp);
		}
		ticks += 4000;
	}
	return { ticks, ms: Date.now() - t0 };
}

if (!isMainThread && workerData && workerData.bench) {
	// warm up (the JIT compiles the engine; with every thread busy that takes a while), wait until every worker is
	// warm, then measure all of them at the same time: the optimizer's workers run for minutes, not 1 s
	spin(workerData.warm);
	const flag = new Int32Array(workerData.go);
	parentPort.postMessage({ ready: true });
	Atomics.wait(flag, 0, 0, 30000);
	parentPort.postMessage(spin(workerData.ms));
}

/** measures `threads` warmed-up workers at once for `ms` ms; resolves to ticks per second (all of them together) */
function measure(threads, ms, warm) {
	return new Promise((resolve, reject) => {
		let ready = 0, done = 0, total = 0;
		const go = new SharedArrayBuffer(4);
		const ws = [];
		for (let i = 0; i < threads; i++) {
			const w = new Worker(__filename, { workerData: { bench: true, ms, warm: warm === undefined ? 700 : warm, go } });
			ws.push(w);
			w.on('message', (r) => {
				if (r.ready) { if (++ready === threads) { Atomics.store(new Int32Array(go), 0, 1); Atomics.notify(new Int32Array(go), 0); } return; }
				total += r.ticks / (r.ms / 1000);
				if (++done === threads) { for (const x of ws) x.terminate(); resolve(total); }
			});
			w.on('error', reject);
		}
	});
}

function cpuKey() {
	const c = os.cpus();
	let engine = 0;
	try { engine = fs.statSync(path.join(__dirname, 'eesim.js')).size; } catch (e) { /* none */ }
	return `${(c[0] && c[0].model || '?').trim()}|${c.length}|${process.version}|${engine}|warm2`;
}
function cached() {
	try { const j = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (j.key === cpuKey() && j.single > 0 && Array.isArray(j.points)) return j; } catch (e) { /* none */ }
	return null;
}

/**
 * The benchmark: from the cache, or measured now (single thread, then all threads unless `busy` says another
 * process uses the CPU: then the all-thread number is an estimate). Resolves to the record kept in the cache.
 */
async function run(opts) {
	const o = opts || {};
	const c = !o.force && cached();
	if (c) return c;
	const threads = os.cpus().length;
	const ms = o.ms || 1000;
	const single = await measure(1, ms);
	const points = [[1, Math.round(single)]];   // [threads, ticks/s] measured
	let allMeasured = false;
	if (!o.busy && threads > 1) {
		const half = Math.floor(threads / 2);
		if (half >= 2 && half < threads) points.push([half, Math.round(await measure(half, ms))]);
		points.push([threads, Math.round(await measure(threads, ms))]);
		allMeasured = true;
	} else if (threads > 1) points.push([threads, Math.round(single * threads * 0.6)]);   // typical SMT scaling when it cannot be measured
	const all = points[points.length - 1][1];
	const peak = points.reduce((p, q) => (q[1] > p[1] ? q : p));
	const rec = { key: cpuKey(), model: (os.cpus()[0] && os.cpus()[0].model || '').trim(), threads, single: Math.round(single), all, points,
		peakThreads: peak[0], allMeasured, measured: Date.now(), node: process.version,
		what: 'eesim ticks per second on a synthetic arena (random inputs), measured with 1, half and all threads at once' };
	try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(rec, null, 1)); } catch (e) { /* read-only */ }
	return rec;
}

/** ticks/s estimate for n threads: piecewise linear between the measured thread counts */
function estimate(rec, n) {
	if (!rec) return null;
	const P = rec.points && rec.points.length ? rec.points : [[1, rec.single], [rec.threads, rec.all]];
	const k = Math.max(1, Math.min(rec.threads || 1, n | 0));
	for (let i = 1; i < P.length; i++) {
		const [x0, y0] = P[i - 1], [x1, y1] = P[i];
		if (k <= x1) return Math.round(y0 + (y1 - y0) * (k - x0) / Math.max(1, x1 - x0));
	}
	return P[P.length - 1][1];
}

module.exports = { run, cached, estimate, measure, spin, arenaJson, CACHE };

if (isMainThread && require.main === module) {
	const a = require('./common.js').parseArgs(process.argv.slice(2));
	(async () => {
		const ms = +a.ms || 1000;
		const s = await measure(1, ms);
		const n = +a.threads || os.cpus().length;
		const all = n > 1 ? await measure(n, ms) : s;
		const f = (x) => `${(x / 1e6).toFixed(1)} M`;
		console.log(`[bench] ${os.cpus()[0].model.trim()}: 1 thread ${f(s)} ticks/s, ${n} threads ${f(all)} ticks/s (${(all / s).toFixed(1)}x)`);
	})();
}
