'use strict';
// THE PERFECT PASS OFFLINE (n5-perfect): src/plan/perfect.js on finished routes, one level after another in ONE process
// (the compiler's parts built as src/plan/strategy.js builds them: model, bounds, facts, planner, primitives, executor).
//   node tools/perf/perfect.js <level.eelvl>=<route.eetas> ... [--seconds=40] [--workers=2] [--out=<dir>] [--json]
// Per level one JSON line: before / after run ticks, the order pass's and the polish's savings, what was found, the
// planner's admissible lower bound from the start. Every route written is C.evaluate'd (finishes, no more deaths).
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const { perfectRoute } = require('../../src/plan/perfect.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const seconds = +opt('seconds', 40), workers = +opt('workers', 2), outDir = opt('out', ''), json = args.includes('--json');
const polishShare = +opt('polishShare', 0.35);
const pairs = args.filter((a) => !a.startsWith('--'));
if (outDir) fs.mkdirSync(outDir, { recursive: true });

(async () => {
	for (const p of pairs) {
		const i = p.lastIndexOf('=');
		const file = p.slice(0, i), routeFile = p.slice(i + 1);
		const name = path.basename(routeFile, '.eetas');
		const t0 = Date.now();
		let row = { level: name, file };
		let exec = null, prims = null;
		try {
			const L = T.loadLevelFile(file);
			const masks = C.readEetas(routeFile);
			const ev0 = C.evaluate(L, masks);
			row.before = ev0 ? ev0.runTicks : null;
			const model = await require('../../src/plan/model.js').compileModel(L, { file });
			let bounds = null;
			try { bounds = await require('../../src/plan/bounds.js').createBounds(L, { model }); } catch (e) { bounds = null; }
			const facts = require('../../src/plan/facts.js').createFacts({ rungs: 4, model });
			const planner = require('../../src/plan/planner.js').createPlanner(model, facts, { bounds, file, floorAsync: false });
			const RM = require('../../src/goexplore.js').roomOf(L);
			try { prims = await require('../../src/plan/prims.js').createPrims(L, { file, bounds, model, workers }); } catch (e) { prims = null; }
			exec = await require('../../src/plan/executor.js').createExecutor(L, { file, workers, prims, bounds, model, RM, emit: null, seed: 1, gpu: null });
			// (the planner's admissible bound from the start: the report's lb)
			try {
				const r0 = T.playTo(L, new Uint8Array(0));
				const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0 });
				const S0 = model.stateOf(r0.sim);
				const lb = planner.lowerBound({ arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 }, { ms: 1500 });
				row.lbPlanner = lb && Number.isFinite(+lb.ticks) ? +lb.ticks : null;
			} catch (e) { row.lbPlanner = null; }
			row.setupMs = Date.now() - t0;
			const r = await perfectRoute({ L, model, planner, exec, RM }, ev0.ms, { ms: seconds * 1000, polishShare, log: json ? null : (s) => console.log(s) });
			Object.assign(row, { after: r.runTicks, saved: r.saved, orderSaved: r.orderSaved, polishSaved: r.polishSaved, found: r.found, expanded: r.expanded, legs: r.legs, legsOk: r.legsOk,
				pruned: r.pruned, seeds: r.seeds, queueLeft: r.queueLeft, exhausted: r.exhausted, ms: r.ms });
			const ev1 = C.evaluate(L, r.masks);
			row.verified = !!ev1 && ev1.runTicks === r.runTicks;
			if (outDir && ev1) C.writeEetas(path.join(outDir, `${name}.eetas`), ev1.ms);
		} catch (e) { row.error = e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e); }
		try { if (exec && exec.close) await exec.close(); } catch (e) { /* closed */ }
		try { if (prims && prims.close) await prims.close(); } catch (e) { /* closed */ }
		row.sec = Math.round((Date.now() - t0) / 100) / 10;
		console.log(JSON.stringify(row));
		if (outDir) fs.appendFileSync(path.join(outDir, 'rows.jsonl'), JSON.stringify(row) + '\n');
	}
	process.exit(0);
})();
