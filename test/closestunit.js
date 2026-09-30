'use strict';
// test/closestunit.js: the executor's fail report in the waypoint's unit (executor.js CLOSEST_UNIT, EEAT_CLOSEST_UNIT=1).
// A call whose goal field does not fit its time (fieldFits: the measured build time x N over 0.4 of what is left) ran its
// finders on field null, whose distance is 0 for every state (legs.js distOf(null)), so the call reported "closest 0" one
// tick past its start. Checks: (1) the mechanism with the knob off (a short call after a field was measured: closest 0,
// one tick past the start); (2) with the knob on no finder's closest of such a call (the start itself, not 0); (3) a call
// with its field: the same report either way. Prints 'name: ok|FAIL', ends 'N/M', exit 1 on a failure.
// usage: node test/closestunit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closestunit-'));
function levelOf(W, H, cells, name) {
	const buf = ED.eelvlOf({ name, width: W, height: H, cells });
	const file = path.join(tmpDir, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	return { L, file };
}

(async () => {
	process.env.EEAT_MATH = '0';   // (the math tier's share would take the short call's time: the finders' report is the point)
	// a 400 x 200 room (its goal field takes ~100+ ms to build): a floor, stairs of ledges, the spawn bottom left, the
	// goal (a coin) at the top right
	const W = 400, H = 200, cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	for (let k = 1; k <= 64; k++) for (let x = 6 * k; x < 6 * k + 5; x++) cells.push([x, H - 1 - 3 * k, 9]);
	cells.push([3, H - 2, 255]);
	cells.push([390, 5, 100]);
	cells.push([200, 100, 100]);
	cells.push([389, 5, 100]);
	cells.push([201, 100, 100]);
	const { file } = levelOf(W, H, cells, 'closestroom');
	const T = require('../src/plan/types.js');
	const EX = require('../src/plan/executor.js');
	// (beforeRel: the plain leg, no skeleton; two goals: the second call needs a field of its own, the first measured its time)
	// (each arm its own two coins: the fields are cached by content across executors, and a cached build measures nothing)
	const wpOf = (x, y) => ({ kind: 'trigger', tiles: [y * W + x], label: `coin (${x},${y})`, expect: null, beforeRel: 1e9 });
	const WP = { false: [wpOf(390, 5), wpOf(200, 100)], true: [wpOf(389, 5), wpOf(201, 100)] };
	const start = '0'.repeat(20);
	const runArm = async (on) => {
		if (on) process.env.EEAT_CLOSEST_UNIT = '1'; else delete process.env.EEAT_CLOSEST_UNIT;
		const L = T.loadLevelFile(file);   // (a level object of its own: no field cached by the other arm)
		const ex = await EX.createExecutor(L, { file, workers: 0 });
		// the first call builds coin A's field (its build time measured) and fails with a real closest
		const r1 = await ex.reach([start], WP[on][0], { ms: 700, level: 0, k: 4 });
		// the second call's field (coin B) does not fit its 150 ms: its finders run on no field
		const t0 = Date.now();
		const r2 = await ex.reach([start], WP[on][1], { ms: 150, level: 0, k: 4 });
		const ms2 = Date.now() - t0;
		await ex.close();
		return { r1, r2, ms2 };
	};
	const off = await runArm(false), on = await runArm(true);
	if (process.env.DBG) for (const r of [off.r1, off.r2, on.r1, on.r2]) console.log(JSON.stringify({ why: r.fail && r.fail.why, cl: r.fail && r.fail.closest && r.fail.closest.dist, tiers: r.tiers }).slice(0, 700));
	const c = (r) => (r && r.fail && r.fail.closest ? r.fail.closest : null);
	const lenOf = (cl) => (cl && cl.masks ? (typeof cl.masks === 'string' ? cl.masks.length : cl.masks.length) : -1);
	const c2off = c(off.r2), c2on = c(on.r2), c1off = c(off.r1), c1on = c(on.r1);
	check('the field-less call (knob off): closest 0, one tick past the start (the mechanism)',
		!off.r2.ok && c2off && c2off.dist === 0 && lenOf(c2off) === start.length + 1, c2off ? `dist ${c2off.dist}, len ${lenOf(c2off)}, ${off.ms2} ms` : 'no closest');
	check('the field-less call (EEAT_CLOSEST_UNIT=1): no finder closest of dist 0, the start itself',
		!on.r2.ok && (!c2on || (c2on.dist !== 0 && lenOf(c2on) === start.length)), c2on ? `dist ${c2on.dist}, len ${lenOf(c2on)}` : 'no closest');
	const real = (r, cl) => r.ok || (cl && cl.dist > 0);
	check('the call with its field: found or a real closest (> 0 tiles) either way',
		real(off.r1, c1off) && real(on.r1, c1on), `${off.r1.ok ? 'found' : c1off && c1off.dist} / ${on.r1.ok ? 'found' : c1on && c1on.dist}`);
	console.log(`${pass}/${pass + fail}`);
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* gone */ }
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(1); });
