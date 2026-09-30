'use strict';
// THE WHOLE LEVEL AS ONE LEG, as a child process of the compiler (strategy.js, OPT-IN EEAT_BW_LEVEL=1): the lab's backward
// solver (backward.js) from the level's start state to the trophy's tiles, next to the compile's own moves (it never blocks
// the compiler's thread). A level whose trophy needs no trigger first is one leg: the planner's triggers are stepping stones
// the moves stage may not cross, while one solve over the whole corridor can (Stone Ruin Speedrun: 3,892 run ticks in 37 s
// where the compile's moves stage found no route in 300 s). Gated levels end at once ('the start is not in the target's
// walk'). Every route printed is C.evaluate'd here and again by the compiler (routeOf).
//   node src/plan/lab/bwlevel_child.js <level.eelvl | level.json> [--ms=120000]
//   stdout: {"ev":"result","kind":"finish","inputs":"0..O","runTicks":N,"deaths":D} then {"ev":"done","end":"finish"|why,"ms":N}
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const file = argv.find((s) => !s.startsWith('--'));
const ms = +opt('ms', 120000);
const t0 = Date.now();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let end = 'none';
try {
	const L = T.loadLevelFile(file);
	const M = MD.compileModel(L);
	const sim = new E.EESim(L); sim.reset();
	const B = BW.createBackward(L);
	const r = B.solve(sim.snapshot(), { tiles: M.trophyTiles.slice() }, { ms });
	if (r.ok) {
		// (the trophy is touched a tick after the centre is in its tile: the last direction held, then released)
		const last = r.masks.length ? r.masks[r.masks.length - 1] & 30 : 0;
		end = 'no finish';
		for (const tail of [[last], [last, last], [0], [last, 0, 0]]) {
			const ev = C.evaluate(L, Uint8Array.from([...r.masks, ...tail]));
			if (ev) { out({ ev: 'result', kind: 'finish', inputs: T.strOf(ev.ms), runTicks: ev.runTicks, deaths: ev.deaths }); end = 'finish'; break; }
		}
	} else end = r.why || 'none';
} catch (e) { end = 'error: ' + String(e && e.message || e).slice(0, 200); }
out({ ev: 'done', end, ms: Date.now() - t0 });
