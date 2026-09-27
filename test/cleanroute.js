'use strict';
// test/cleanroute.js - the route cleanup (src/cleanroute.js; editor.js runs it on every new best route of Find a route):
//   - a noisy route over a room with a wall to jump (random jump presses, up / down, direction flips on top of R):
//     the cleaned route finishes (C.evaluate), no slower, no more deaths, with fewer jump presses and input changes,
//     and it still jumps the wall
//   - a clean route (R and one jump) comes back no slower, its one needed press kept
//   - a route that does not finish: null
//   - the worker thread (editor.js cleanStart) gives the same route as the direct call
// usage: node test/cleanroute.js        Exit code 1 if any check fails. No GPU, a few seconds.
const { Worker } = require('worker_threads');
const path = require('path');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const CR = require('../src/cleanroute.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
function rngOf(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); }

// a 40 x 10 room: the start at (2, 8), a wall 2 tiles high at x = 20, the trophy at (36, 8)
const W = 40, H = 10, cells = [];
for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
cells.push([20, 8, 9], [20, 7, 9], [2, 8, 255], [36, 8, 121]);
const buf = ED.eelvlOf({ name: 'clean', width: W, height: H, cells, bg: [] });
const level = CR.editorLevel(buf);

/** R every tick, jump once before the wall (ticks j..j+3); with noise: random jump presses, up / down and short L flips
 *  on top */
function route(seed, noise, j) {
	const rnd = rngOf(seed), ms = [];
	for (let t = 0; t < 3000; t++) {
		let m = 4;
		if (t >= j && t < j + 4) m |= 1;   // (the wall's jump: a few ticks of held jump)
		if (noise) {
			if (rnd() < 0.3) m |= 1;
			if (rnd() < 0.5) m |= rnd() < 0.5 ? 8 : 16;
			if (t > 60 && rnd() < 0.03) m = (m & ~4) | 2;
		}
		ms.push(m);
	}
	return Uint8Array.from(ms);
}
// (the first jump tick that clears the wall; a noisy route with it that finishes)
let plain = null, j = 10;
for (; j < 300 && !plain; j++) plain = C.evaluate(level, route(1, false, j));
j--;
let noisy = null, seed = 1;
for (; seed < 200 && !noisy; seed++) { const ms = route(seed, true, j), ev = C.evaluate(level, ms); if (ev) noisy = ev; }
check('the test routes finish', !!noisy && !!plain, `noisy ${noisy && noisy.runTicks} (seed ${seed - 1}), plain ${plain && plain.runTicks} (the jump at tick ${j})`);

console.log('a noisy route');
const r = CR.cleanRoute(level, noisy.ms, { ms: 20000 });
const ev = r && C.evaluate(level, r.ms);
check('it finishes, no slower, no more deaths', !!ev && ev.runTicks <= noisy.runTicks && ev.deaths <= noisy.deaths, ev ? `${noisy.runTicks} -> ${ev.runTicks}, deaths ${ev.deaths}` : 'no finish');
check('fewer jump presses and input changes', r.after.presses < r.before.presses && r.after.changesPerS < r.before.changesPerS,
	`presses ${r.before.presses} -> ${r.after.presses}, changes/s ${r.before.changesPerS} -> ${r.after.changesPerS}, held ${r.before.jumpHeld} -> ${r.after.jumpHeld}`);
check('up / down presses dropped', r.after.vertHeld < r.before.vertHeld / 4, `${r.before.vertHeld} -> ${r.after.vertHeld}`);
const tr = C.replay(level, r.ms, { trace: true });
check('it still jumps (the wall)', tr.events.some((e) => e.kind === 'jump'));

console.log('a clean route');
const r2 = CR.cleanRoute(level, plain.ms, { ms: 20000 });
const ev2 = r2 && C.evaluate(level, r2.ms);
check('no slower, the needed press kept', !!ev2 && ev2.runTicks <= plain.runTicks && r2.after.presses >= 1, ev2 ? `${plain.runTicks} -> ${ev2.runTicks}, presses ${r2.after.presses}` : 'no finish');
check('a route that does not finish: null', CR.cleanRoute(level, new Uint8Array(50).fill(4)) === null);

console.log('the worker thread');
const w = new Worker(path.join(__dirname, '..', 'src', 'cleanroute.js'), { workerData: { cleanRoute: true, eelvl: Uint8Array.from(buf), inputs: C.eetasBytes(noisy.ms).toString('latin1'), ms: 20000 } });
w.once('message', (m) => {
	check('the same route as the direct call', !!m && m.inputs === C.eetasBytes(r.ms).toString('latin1') && m.runTicks === ev.runTicks && m.changed === true,
		m && `${m.runTicks} ticks, ${m.sec} s`);
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
});
w.once('error', (e) => { check('the worker thread', false, String(e && e.message || e)); process.exit(1); });
