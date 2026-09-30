'use strict';
// A GATED LEVEL AS A CHAIN OF BACKWARD LEGS (src/plan/lab/bwchain.js): the planner's next trigger from the chain's exact
// state, one continuous backward leg to it, the end state carried; the route evaluated by the engine from the level file.
//   node tools/cmp/bwchain.js <level.eelvl>... [--ms=120000] [--out=<dir>] [--sched=6000,40000]  (one JSON line a level)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'src/plan/defaults.js')).apply();
const T = require(path.join(root, 'src/plan/types.js'));
const C = require(path.join(root, 'src/common.js'));
const BC = require(path.join(root, 'src/plan/lab/bwchain.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const files = argv.filter((s) => !s.startsWith('--'));
const ms = +opt('ms', 120000), outDir = opt('out', '');
const sched = opt('sched', '') ? String(opt('sched')).split(',').map(Number).filter((x) => x > 0) : undefined;
const verbose = argv.includes('--verbose');
for (const file of files) {
	const t0 = Date.now();
	const row = { level: path.basename(file) };
	try {
		const L = T.loadLevelFile(file);
		const r = BC.chainLevel(L, { ms, sched, file, log: verbose ? (s) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}\n`) : null });
		row.ok = r.ok; row.why = r.why; row.runTicks = r.runTicks; row.deaths = r.deaths; row.depth = r.depth; row.deepestTick = r.deepestTick;
		row.legs = r.legs.length; row.legsOk = r.legs.filter((x) => x.ok).length; row.stats = r.stats;
		row.legList = r.legs.map((x) => [x.label, x.depth, x.from, x.ok ? x.T : null, Math.round(x.ms / 100) / 10, x.ok ? '' : x.why]);
		if (r.ok && outDir) { fs.mkdirSync(outDir, { recursive: true }); const ev = C.evaluate(L, r.masks, false); if (ev) C.writeEetas(path.join(outDir, path.basename(file, '.eelvl') + '.eetas'), ev.ms); }
	} catch (e) { row.error = String(e && e.stack || e).slice(0, 400); }
	row.ms = Date.now() - t0;
	console.log(JSON.stringify(row));
}
