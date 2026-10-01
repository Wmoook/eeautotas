'use strict';
// tools/cmp/osrun.js - THE ONE SHOT ALONE on a level (src/plan/oneshot/solve.js with the parts osworker.js builds: the model,
// the bounds, the planner; no executor): its route (replayed from the level start by the engine: common.js evaluate's rule,
// the silver crown at the reported tick), its stats every --every seconds, and optional injected states (a .eetas / mask
// string file per line: the executor's anchors, a known route's prefixes) handed in before the run.
//   node tools/cmp/osrun.js <level.eelvl> [--seconds=60] [--every=10] [--inject=<file of mask strings, one a line>]
//        [--graph=1] [--cache=<dir>]
// The knobs are solve.js's own (EEAT_OS_*: EEAT_OS_BW=1 the far legs, EEAT_OS_CHASE=0 no chase, ...). One JSON line at the
// end: {level, ok, ticks, replayed, ms, stats}.
const fs = require('fs');
const path = require('path');
const T = require('../../src/plan/types.js');
const E = require('../../src/eesim.js');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
if (!file) { console.error('usage: node tools/cmp/osrun.js <level.eelvl> [--seconds=60] [--every=10] [--inject=file] [--graph=1] [--cache=dir]'); process.exit(1); }
const seconds = +opt('seconds', 60), every = +opt('every', 10);

(async () => {
	const t0 = Date.now();
	const L = T.loadLevelFile(file);
	const model = await require('../../src/plan/model.js').compileModel(L, { file });
	let bounds = null;
	try { bounds = require('../../src/plan/bounds.js').createBounds(L, { model }); if (bounds && typeof bounds.then === 'function') bounds = await bounds; } catch (e) { bounds = null; }
	const facts = require('../../src/plan/facts.js').createFacts({ rungs: 4, model });
	const planner = require('../../src/plan/planner.js').createPlanner(model, facts, { bounds, file, floorAsync: false });
	const OSM = require('../../src/plan/oneshot/solve.js');
	let graph = null, gstats = null;
	if (opt('graph', '0') === '1') {
		const tg = Date.now();
		const g = await require('../../src/plan/oneshot/edges.js').buildGraph(file, { threads: 1, cache: opt('cache', null) });
		graph = OSM.graphOf(g, L);
		gstats = Object.assign({ ms: Date.now() - tg }, graph ? graph.stats() : {});
	}
	const evs = [];
	const os = OSM.createOneShot(L, { model, planner, bounds, graph, emit: (e) => { if (e.what === 'route') { evs.push(e); console.error(`route ${e.ticks} at ${((Date.now() - t0) / 1000).toFixed(1)} s`); } } });
	const inj = opt('inject', '');
	let injected = 0;
	if (inj) for (const line of fs.readFileSync(inj, 'utf8').split('\n')) { const s = line.replace(/[^0-O]/g, ''); if (s && os.inject(T.masksOf(s), 'file')) injected++; }
	const setupMs = Date.now() - t0;
	const end = t0 + seconds * 1000;
	let r = null;
	while (Date.now() < end) {
		r = os.run(Math.min(every * 1000, end - Date.now()));
		const s = r.stats;
		console.error(`${((Date.now() - t0) / 1000).toFixed(0)} s: best ${s.best} expanded ${s.expanded} nodes ${s.nodes} states ${s.states} legs ${s.legOk}/${s.legs} bw ${s.bwOk}/${s.bwLegs} (${s.bwMs} ms) chased ${s.chased} deep ${s.chaseDeep} byKind ${JSON.stringify(s.byKind)}`);
		if (r.done) break;
	}
	const b = os.best();
	let replayed = null;
	if (b) {
		// (the engine from the level start: the crown at the route's last tick)
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let at = -1;
		for (let t = 0; t < b.masks.length; t++) { E.applyMask(inp, b.masks[t] & 31); sim.tick(inp); if (sim.has_silver_crown) { at = t + 1; break; } }
		replayed = at;
	}
	console.log(JSON.stringify({ level: path.basename(file), ok: !!b, ticks: b ? b.ticks : null, kind: b ? b.kind : null, replayed, injected, setupMs, ms: Date.now() - t0, graph: gstats, stats: r ? r.stats : null }));
	if (b && opt('out', '')) fs.writeFileSync(opt('out', ''), T.strOf(b.masks) + '\n');
	process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
