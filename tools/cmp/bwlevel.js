'use strict';
// A WHOLE LEVEL AS ONE LEG: the lab's backward solver (src/plan/lab/backward.js) from the level's start state to the trophy's
// tiles, the run then evaluated by the engine from the level file alone (common.js evaluate: the finish, the run ticks, the
// deaths, the random-portal chance). For levels whose trophy needs no trigger first (else the corridor has no way:
// 'the start is not in the target's walk').
//   node tools/cmp/bwlevel.js <level.eelvl>... [--ms=120000] [--out=<dir>]  (one JSON line a level)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const files = argv.filter((s) => !s.startsWith('--'));
const ms = +opt('ms', 120000), outDir = opt('out', '');
for (const file of files) {
	const t0 = Date.now();
	const row = { level: path.basename(file) };
	try {
		const L = T.loadLevelFile(file);
		const M = MD.compileModel(L);
		const sim = new E.EESim(L); sim.reset();
		const B = BW.createBackward(L);
		const r = B.solve(sim.snapshot(), { tiles: M.trophyTiles.slice() }, { ms });
		row.ok = r.ok; row.why = r.why || null; row.T = r.ok ? r.T : null;
		row.st = { quick: !!(r.stats && r.stats.quick), relay: r.stats && r.stats.relay || 0, cells: r.stats && r.stats.cells, minH: r.stats && r.stats.minH };
		if (r.ok) {
			// the trophy is touched a tick after the centre is in its tile: the last direction held, then released
			const last = r.masks.length ? r.masks[r.masks.length - 1] & 30 : 0;
			for (const tail of [[last], [last, last], [0], [last, 0, 0]]) {
				const ev = C.evaluate(L, Uint8Array.from([...r.masks, ...tail]));
				if (ev) { row.runTicks = ev.runTicks; row.deaths = ev.deaths; row.chance = ev.chance; if (outDir) { fs.mkdirSync(outDir, { recursive: true }); C.writeEetas(path.join(outDir, path.basename(file, '.eelvl') + '.eetas'), ev.ms); } break; }
			}
			row.finished = row.runTicks !== undefined;
		}
	} catch (e) { row.error = String(e && e.stack || e).slice(0, 300); }
	row.ms = Date.now() - t0;
	console.log(JSON.stringify(row));
}
