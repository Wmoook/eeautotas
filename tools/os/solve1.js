'use strict';
// THE ONE SHOT ALONE on one level (n5-oneshot part 3): the model, the bounds and the planner built as the compiler builds
// them (strategy.js compile), then src/plan/oneshot/solve.js run for --seconds; the route (if any) replayed by the engine
// from the level alone (common.js evaluate). One JSON line on stdout.
//   node tools/os/solve1.js <level.eelvl | job id> [--seconds=60] [--out=<file.eetas>] [--planner=1] [--trace=0]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const C = require(path.join(root, 'src/common.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const file = pos[0];
	if (!file) { console.error('usage: node tools/os/solve1.js <level> [--seconds=60] [--out=f.eetas]'); process.exit(2); }
	const seconds = +opt('seconds', 60) || 60;
	const t0 = Date.now();
	const L = T.loadLevelFile(file);
	const out = { level: path.basename(String(file)), W: L.width, H: L.height, seconds };
	const MD = require(path.join(root, 'src/plan/model.js'));
	const model = await MD.compileModel(L, { file });
	out.modelMs = Date.now() - t0;
	let bounds = null;
	try { bounds = await require(path.join(root, 'src/plan/bounds.js')).createBounds(L, { model }); } catch (e) { out.boundsErr = e.message; }
	let planner = null;
	if (opt('planner', '1') !== '0') {
		const facts = require(path.join(root, 'src/plan/facts.js')).createFacts({ rungs: 4, model });
		planner = require(path.join(root, 'src/plan/planner.js')).createPlanner(model, facts, { bounds, file, floorAsync: false });
	}
	out.setupMs = Date.now() - t0;
	const OS = require(path.join(root, 'src/plan/oneshot/solve.js'));
	const trace = opt('trace', '0') !== '0';
	// (--graph=1: part 2's whole-level move graph (src/plan/oneshot/edges.js buildGraph) as the solver's graph edges, its
	// build within the seconds; --graphThreads, --cache=<dir>)
	let graph = null;
	if (opt('graph', '0') !== '0') {
		const tg = Date.now();
		try {
			const g = await require(path.join(root, 'src/plan/oneshot/edges.js')).buildGraph(String(file), { threads: +opt('graphThreads', 4) || 4, cache: opt('cache', '') || null });
			graph = OS.graphOf(g, L);
			out.graph = Object.assign({ ms: Date.now() - tg, cached: !!(g.stats && g.stats.cached) }, graph ? graph.stats() : {});
		} catch (e) { out.graphErr = e.message; }
	}
	const os = OS.createOneShot(L, { model, planner, bounds, graph, emit: trace ? (ev) => console.error(JSON.stringify(ev)) : null });
	const left = seconds * 1000 - (Date.now() - t0);
	let r = null;
	const slice = +opt('slice', 0) || 0;
	if (slice > 0) {
		// (in slices, a progress line each)
		const end = Date.now() + left;
		while (Date.now() < end) {
			r = os.run(Math.min(slice, end - Date.now()));
			if (trace) console.error(JSON.stringify({ t: Math.round((Date.now() - t0) / 100) / 10, st: r.stats }));
			if (r.done) break;
		}
	} else r = os.run(Math.max(100, left));
	const st = r.stats;
	out.ok = !!r.best;
	out.closed = r.closed;
	out.done = r.done;
	if (r.best) {
		const ev = C.evaluate(L, r.best.masks);
		out.verified = !!ev;
		if (ev) { out.ticks = ev.complete; out.runTicks = ev.runTicks; out.deaths = ev.deaths; }
		out.firstMs = st.firstMs;
		const of = opt('out', '');
		if (of && ev) C.writeEetas(of, ev.ms);
	}
	const arr = os.arrivals();
	out.states = arr.length;
	out.maxGain = arr.reduce((m, a) => Math.max(m, a.S && Number.isFinite(a.S.gain) ? a.S.gain : 0), 0);
	out.stats = st;
	out.ms = Date.now() - t0;
	out.rssMB = Math.round(process.memoryUsage().rss / 1048576);
	console.log(JSON.stringify(out));
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ level: pos[0], error: e.stack || e.message })); process.exit(1); });
