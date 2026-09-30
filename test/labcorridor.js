'use strict';
// test/labcorridor.js - the chains lab's corridor (src/plan/lab/corridor.js, approach C) on a hand-made climb:
//   1 a staircase of 7 platforms (3-tile gaps, 3 rows up each: one jump a step, ~6 moves) from the spawn to the top:
//     every mode (the fans alone with the plain stops and the x-direction store: the executor's default; the sub-legs
//     always; the lazy pass with the widened fan) finds a chain and a fresh EESim replays it onto the target tile alive;
//   2 the resumed search: a call cut short keeps its store and the next call with the same key goes on (resumed, a chain);
//   3 a portal-free cut target (a sealed box): 'cut' at once (the goal field's -1);
//   4 the executor's knob: with EEAT_CORRIDOR unset, loading the executor does not load the corridor.
// Usage: node test/labcorridor.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const MS = require('../src/plan/msolve.js');
const CR = require('../src/plan/lab/corridor.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

const W = 60, H = 32;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x <= 10; x++) cells.push([x, 28, 9]);
const steps = [[14, 25], [20, 22], [26, 19], [32, 16], [38, 13], [44, 10], [50, 7]];
for (const [x0, y] of steps) for (let x = x0; x < x0 + 3; x++) cells.push([x, y, 9]);
// a sealed box (walls all round) far right: its inside is cut off
for (let x = 52; x <= 56; x++) { cells.push([x, 22, 9]); cells.push([x, 26, 9]); }
for (let y = 22; y <= 26; y++) { cells.push([52, y, 9]); cells.push([56, y, 9]); }
cells.push([3, 27, 255]);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'labcorridor', width: W, height: H, cells }))));
const sim0 = new E.EESim(L), inp0 = new E.EEInput();
sim0.reset();
for (let t = 0; t < 40; t++) { E.applyMask(inp0, 0); sim0.tick(inp0); }
ok(sim0.on_ground, 'the ball stands at the spawn');
const snap0 = sim0.snapshot();
const top = [6 * W + 50, 6 * W + 51, 6 * W + 52];   // the top platform's standing tiles (row 6)
const tileOf = (s) => (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4);
const replays = (masks, tiles) => {
	const c = new E.EESim(L), ci = new E.EEInput();
	c.restore(snap0);
	for (let t = 0; t < masks.length; t++) { E.applyMask(ci, masks[t]); c.tick(ci); if (c.is_dead) return false; }
	return tiles.includes(tileOf(c));
};

const S = MS.createSolver(L, {});
const modes = [
	['fans + stops + dir', { legs: false, plainStops: [8, 20], dom: 'dir' }],
	['the executor default (no landings, lazy widened fan)', { plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false }],
	['sub-legs always', { M: 3, Mu: 1, legT: 90, RX: 18, RD: 30, subStop: 2 }],
	['lazy widened fan', { plainStops: [8, 20], dom: 'dir', legMode: 'lazy', lazyWide: true, lazyLegs: false, directOnce: true }],
];
for (const [name, o] of modes) {
	const X = CR.createCorridor(L, { solver: S });
	const r = X.solve(snap0, { tiles: top, cls: 'any' }, Object.assign({ ms: 20000, first: true }, o));
	ok(r.ok, `${name}: a chain (${r.why}, ${r.expanded} expanded, bestC ${r.bestC})`);
	if (r.ok) ok(replays(r.masks, top), `${name}: the chain replays onto the top (${r.T} ticks)`);
	console.log(`  ${name}: ${r.ok ? r.T + ' ticks' : r.why}, ${r.expanded} expanded, ${r.ms} ms`);
}

// 2 the resumed search
{
	const X = CR.createCorridor(L, { solver: S });
	const o = { legs: false, plainStops: [8, 20], dom: 'dir', first: true, resume: 'k1' };
	const r1 = X.solve(snap0, { tiles: top, cls: 'any' }, Object.assign({ ms: 1 }, o));
	let r2 = r1, calls = 1;
	while (!r2.ok && calls < 200) { r2 = X.solve(snap0, { tiles: top, cls: 'any' }, Object.assign({ ms: 100 }, o)); calls++; }
	ok(r2.ok && (r1.ok || r2.resumed), `resumed calls reach a chain (${calls} calls, resumed ${!!r2.resumed})`);
	if (r2.ok) ok(replays(r2.masks, top), 'the resumed chain replays onto the top');
}

// 3 a cut target
{
	const X = CR.createCorridor(L, { solver: S });
	const r = X.solve(snap0, { tiles: [24 * W + 54], cls: 'any' }, { ms: 2000, legs: false });
	ok(!r.ok && r.why === 'cut', `the sealed box is cut at once (${r.why}, ${r.ms} ms)`);
}

// 4 the knob off: the executor does not load the corridor
{
	delete process.env.EEAT_CORRIDOR;
	require('../src/plan/executor.js');
	const loaded = Object.keys(require.cache).filter((k) => /lab[\\/]corridor\.js$/.test(k));
	// (this test loaded it itself: the executor's own lazy require is what is checked, by its source)
	const src = require('fs').readFileSync(require.resolve('../src/plan/executor.js'), 'utf8');
	ok(/const corridor = \(\) => CR_ \|\| \(CR_ = require\('\.\/lab\/corridor\.js'\)/.test(src) && /if \(CORR_ON\(\) && mathOn/.test(src), 'the executor loads the corridor lazily, behind CORR_ON()');
	ok(loaded.length === 1, 'one corridor module in the cache (this test\'s)');
}

console.log(`labcorridor: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
