'use strict';
// THE BOUND LADDER probe (n5-perfect): from the level start, the executor's trophy leg with a TIGHT deadline
// (beforeTick = each bound given): the exact tier prunes by it, so a tight bound can find what the incumbent's loose one
// (the compile's prove stage: the route's own ticks) does not.
//   node tools/perf/ladder.js <level.eelvl> --bounds=120,160,240 [--ms=15000] [--workers=2]
const T = require('../../src/plan/types.js');
const C = require('../../src/common.js');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
(async () => {
	const L = T.loadLevelFile(file);
	const workers = +opt('workers', 2), ms = +opt('ms', 15000);
	const model = await require('../../src/plan/model.js').compileModel(L, { file });
	let bounds = null;
	try { bounds = await require('../../src/plan/bounds.js').createBounds(L, { model }); } catch (e) { bounds = null; }
	const RM = require('../../src/goexplore.js').roomOf(L);
	let prims = null;
	try { prims = await require('../../src/plan/prims.js').createPrims(L, { file, bounds, model, workers }); } catch (e) { prims = null; }
	const exec = await require('../../src/plan/executor.js').createExecutor(L, { file, workers, prims, bounds, model, RM, emit: null, seed: 1, gpu: null });
	const r0 = T.playTo(L, new Uint8Array(0));
	const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0 });
	const trophy = T.goalOf(L, { kind: 'trophy' });
	for (const b of String(opt('bounds', '200')).split(',').map(Number)) {
		const t0 = Date.now();
		const wp = { kind: 'trophy', tiles: Array.from(trophy.tiles), expect: null, label: 'trophy (ladder)', beforeTick: b };
		const r = await exec.reach([a0], wp, { ms, level: 3, k: 4, deadline: Date.now() + ms, stop: () => Date.now() > t0 + ms + 2000 });
		let best = null;
		for (const a of (r && r.arrivals) || []) { const m = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks); const ev = C.evaluate(L, m); if (ev && (!best || ev.runTicks < best.runTicks)) best = ev; }
		console.log(JSON.stringify({ bound: b, ok: !!(r && r.ok), runTicks: best ? best.runTicks : null, lb: r ? r.lb : null, why: r && r.fail ? r.fail.why : null, tool: r ? r.tool : null, ms: Date.now() - t0 }));
	}
	try { await exec.close(); } catch (e) { /* closed */ }
	try { if (prims && prims.close) await prims.close(); } catch (e) { /* closed */ }
	process.exit(0);
})();
