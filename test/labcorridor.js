'use strict';
// test/labcorridor.js - the chains lab's corridor (src/plan/lab/corridor.js, approach C) on a hand-made climb:
//   1 a staircase of 7 platforms (3-tile gaps, 3 rows up each: one jump a step, ~6 moves) from the spawn to the top:
//     every mode (the fans alone with the plain stops and the x-direction store: the executor's default; the sub-legs
//     always; the lazy pass with the widened fan) finds a chain and a fresh EESim replays it onto the target tile alive;
//   2 the resumed search: a call cut short keeps its store and the next call with the same key goes on (resumed, a chain);
//   3 a portal-free cut target (a sealed box): 'cut' at once (the goal field's -1);
//   4 the executor's knob: with EEAT_CORRIDOR unset, loading the executor does not load the corridor.
//   5 the fields pass (goalFan, directShare, restKey, refine, more): the staircase, the start on its jump tick, a shaft
//     of up arrows onto a ledge (replayed standing); 6 EEAT_CORR_FIELDS=1 is the pass in the tier's options.
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

// 5 the fields pass (n5-s99-fields: goalFan, directShare, restKey, refine, more; EEAT_CORR_FIELDS=1): the staircase, a
// shaft of up arrows to a ledge, and the start on its jump tick (restKey: the standing key dominated its children)
const PASS = { plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false, goalFan: true, directShare: 0.15, restKey: true, refine: true, more: 1 };
{
	const X = CR.createCorridor(L, { solver: S });
	const r = X.solve(snap0, { tiles: top, cls: 'any' }, Object.assign({ ms: 20000, first: true }, PASS));
	ok(r.ok && replays(r.masks, top), `the pass: the staircase's chain replays onto the top (${r.ok ? r.T + ' ticks' : r.why})`);
	// the jump tick's start: grounded with speed_y the jump's
	const s1 = new E.EESim(L); s1.restore(snap0); E.applyMask(inp0, 1); s1.tick(inp0);
	const r1 = X.solve(s1.snapshot(), { tiles: top, cls: 'any' }, Object.assign({ ms: 20000, first: true }, PASS));
	ok(r1.ok && r1.expanded > 1, `the pass from a jump tick: a chain (${r1.ok ? r1.T + ' ticks' : r1.why}, ${r1.expanded} expanded)`);
}
{
	// a shaft of up arrows (x 8-9, rows 4-28) beside a wall, the ledge (x 12-16, row 3) at its top right
	const W2 = 24, H2 = 32, c2 = [];
	for (let x = 0; x < W2; x++) { c2.push([x, 0, 9]); c2.push([x, H2 - 1, 9]); }
	for (let y = 0; y < H2; y++) { c2.push([0, y, 9]); c2.push([W2 - 1, y, 9]); }
	for (let x = 1; x < W2 - 1; x++) if (x < 8 || x > 9) c2.push([x, 29, 9]);
	for (let y = 4; y <= 29; y++) { c2.push([8, y, 2]); c2.push([9, y, 2]); }
	for (let y = 5; y < 29; y++) c2.push([10, y, 9]);
	for (let x = 11; x <= 16; x++) c2.push([x, 4, 9]);
	c2.push([3, 28, 255]);
	const L2 = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'labcorridor2', width: W2, height: H2, cells: c2 }))));
	const s2 = new E.EESim(L2), i2 = new E.EEInput(); s2.reset();
	for (let t = 0; t < 30; t++) { E.applyMask(i2, 0); s2.tick(i2); }
	const sn2 = s2.snapshot(), ledge = [3 * W2 + 13, 3 * W2 + 14, 3 * W2 + 15];
	const X2 = CR.createCorridor(L2, { solver: MS.createSolver(L2, {}) });
	const r2 = X2.solve(sn2, { tiles: ledge, cls: 'G' }, Object.assign({ ms: 20000, first: true }, PASS));
	let rep = false;
	if (r2.ok) { const c = new E.EESim(L2), ci = new E.EEInput(); c.restore(sn2); let dead = false; for (let t = 0; t < r2.masks.length; t++) { E.applyMask(ci, r2.masks[t]); c.tick(ci); if (c.is_dead) dead = true; } rep = !dead && ledge.includes((Math.trunc(c.py + 8) >> 4) * W2 + (Math.trunc(c.px + 8) >> 4)) && c.on_ground; }
	ok(r2.ok && rep, `the pass: up the arrow shaft onto the ledge, replayed standing (${r2.ok ? r2.T + ' ticks' : r2.why}, ${r2.expanded} expanded)`);
	console.log(`  the pass: arrow shaft ${r2.ok ? r2.T + ' ticks' : r2.why}, ${r2.expanded} expanded, ${r2.ms} ms`);
}
// 6 the executor's knob: EEAT_CORR_FIELDS=1 is the pass, off nothing
{
	const src = require('fs').readFileSync(require.resolve('../src/plan/executor.js'), 'utf8');
	ok(/const CORR_FIELDS = process\.env\.EEAT_CORR_FIELDS === '1' \? \{ goalFan: true, directShare: 0\.15, restKey: true, refine: true, more: 1 \} : null;/.test(src) && /CORR_FIELDS, CORR_OPTS/.test(src), 'EEAT_CORR_FIELDS=1 = the pass in the tier\'s options, null (nothing) without it');
}

// 4 the knob off: the executor does not load the corridor
{
	delete process.env.EEAT_CORRIDOR;
	require('../src/plan/executor.js');
	const loaded = Object.keys(require.cache).filter((k) => /lab[\\/]corridor\.js$/.test(k));
	// (this test loaded it itself: the executor's own lazy require is what is checked, by its source)
	const src = require('fs').readFileSync(require.resolve('../src/plan/executor.js'), 'utf8');
	ok(/const corridor = \(\) => CR_ \|\| \(CR_ = require\('\.\/lab\/corridor\.js'\)/.test(src) && /if \((!pfOn && )?CORR_ON\(\) && mathOn/.test(src), 'the executor loads the corridor lazily, behind CORR_ON()');
	ok(loaded.length === 1, 'one corridor module in the cache (this test\'s)');
}

console.log(`labcorridor: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
