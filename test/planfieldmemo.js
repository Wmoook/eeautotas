'use strict';
// test/planfieldmemo.js: THE FIELD MEMO (doctor 9, n5; executor.js EEAT_FIELD_MEMO=1). A leg call whose goal field does
// not fit its window (fieldFits) ran with NO field: every finder distance reads 0 and the FailReport says "closest 0
// tiles" wherever the ball is. EEAT_FIELD_FIT=1e-9 makes every build after the thread's first timed one "not fit" here
// (the big levels' short skeleton sub-legs). EEAT_SKEL_MIN past any distance: the calls are the core's own, as a skeleton
// sub-leg's are (the wrapper re-measures its closest in the waypoint's field by skelClosest; the core's closest is what a
// direct leg, a relay or a near plan reports). On a 400 x 100 room with regions 350-390 tiles right of the spawn on top
// of a 60-step staircase (the calls get 300 ms each):
//   F-MEMO off: a sub-leg call (a region goal with the waypoint's fieldTiles) has no field (tiers 'proof' field 0) and
//     its FailReport reads the false near "closest 0"
//   F-MEMO on: the same kind of call reads the field this thread built from the memo (field 1, fieldMemo) and reaches
//     the region in its 300 ms (or reports its true distance), where the blind call above fails with "closest 0"
//   F-MEMO on: a sub-leg whose field this thread never built is built past its window (fieldBuilt), not run blind
//   F-MEMO on: a call left without a field (not a sub-leg, nothing cached) reports no closest distance, not a false 0
// usage: node test/planfieldmemo.js ; prints 'name: ok|FAIL', ends 'N/M'
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const EX = require('../src/plan/executor.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planfieldmemo-'));
const W = 400, H = 100;

function room() {
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	// a staircase of 60 one-tile steps, one every 5 tiles from x 100 (solid below its surface)
	for (let k = 0; k < 60; k++) for (let x = 100 + 5 * k; x < W - 1; x++) cells.push([x, H - 2 - k, 9]);
	cells.push([2, H - 2, 255]);
	const buf = ED.eelvlOf({ name: 'fieldmemo', width: W, height: H, cells });
	const file = path.join(tmpDir, 'fieldmemo.eelvl');
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	return { L, file, at: (x, y) => y * W + x };
}

(async () => {
	const { L, file, at } = room();
	// (a region `up` rows deep just above the staircase's surface over columns x0..x1; the goal-field memo (types.js) is
	// the process's, so every phase uses regions of its own)
	const box = (x0, x1, up) => {
		const t = [];
		for (let x = x0; x < x1; x++) { const sy = H - 2 - Math.min(59, Math.floor((x - 100) / 5)); for (let y = sy - up; y < sy; y++) t.push(at(x, y)); }
		return t;
	};
	const sub = (tiles, label) => ({ kind: 'region', tiles: tiles.slice(), expect: null, fieldTiles: tiles.slice(), label });
	const plain = (tiles, label) => ({ kind: 'region', tiles: tiles.slice(), expect: null, label });
	const proofTier = (r) => (r.tiers || []).find((t) => t.tier === 'proof') || {};
	const closestOf = (r) => (r.fail && r.fail.closest ? r.fail.closest.dist : null);
	const saved = { memo: process.env.EEAT_FIELD_MEMO, fit: process.env.EEAT_FIELD_FIT, skel: process.env.EEAT_SKEL_MIN };
	process.env.EEAT_SKEL_MIN = '1000000000';
	// (a call whose field fits: built and timed by this thread; then no build fits any more)
	const warmC = async (c, tiles) => {
		process.env.EEAT_FIELD_FIT = '0.4';
		await c.reach([''], EX.wpData(plain(tiles, 'warm')), { ms: 3000, level: 0 });
		process.env.EEAT_FIELD_FIT = '1e-9';
	};
	try {
		// ---- knob off: the core as a worker thread runs it (its own goal-field timing; no main-thread wrapper)
		delete process.env.EEAT_FIELD_MEMO;
		let core = EX.makeCore(L, {});
		const call = (c, wp) => c.reach([''], EX.wpData(wp), { ms: 300, level: 0 });
		await warmC(core, box(390, 392, 2));
		const r0 = await call(core, sub(box(380, 390, 3), 'sub off'));
		check('F-MEMO off: the sub-leg call has no goal field (fieldFits false)', proofTier(r0).field === 0, JSON.stringify(proofTier(r0)));
		check('F-MEMO off: its FailReport reads the false near "closest 0" (the ball ~380 tiles off)', !r0.ok && closestOf(r0) === 0, 'ok ' + r0.ok + ' closest ' + closestOf(r0));
		// ---- knob on
		process.env.EEAT_FIELD_MEMO = '1';
		core = EX.makeCore(L, {});
		const T2 = box(370, 380, 3);
		await warmC(core, T2);
		const r1 = await call(core, sub(T2, 'sub on'));
		check('F-MEMO on: the sub-leg call reads its field from the memo', proofTier(r1).field === 1 && (core.stats().fieldMemo | 0) >= 1, JSON.stringify(proofTier(r1)) + ' memo ' + core.stats().fieldMemo);
		check('F-MEMO on: with the field the call reaches the region or reports its true distance (> 100 tiles), not 0', r1.ok || closestOf(r1) > 100, 'ok ' + r1.ok + ' closest ' + closestOf(r1));
		const r2 = await call(core, sub(box(360, 370, 3), 'sub new'));
		check('F-MEMO on: a sub-leg field not in the memo is built past the window (not run blind)', proofTier(r2).field === 1 && (core.stats().fieldBuilt | 0) >= 1, JSON.stringify(proofTier(r2)) + ' built ' + core.stats().fieldBuilt);
		const r3 = await call(core, plain(box(350, 360, 3), 'plain new'));
		check('F-MEMO on: a call left without a field reports no closest distance (not a false 0)', proofTier(r3).field === 0 && !r3.ok && !(closestOf(r3) >= 0), JSON.stringify(proofTier(r3)) + ' closest ' + closestOf(r3));
	} finally {
		if (saved.memo === undefined) delete process.env.EEAT_FIELD_MEMO; else process.env.EEAT_FIELD_MEMO = saved.memo;
		if (saved.fit === undefined) delete process.env.EEAT_FIELD_FIT; else process.env.EEAT_FIELD_FIT = saved.fit;
		if (saved.skel === undefined) delete process.env.EEAT_SKEL_MIN; else process.env.EEAT_SKEL_MIN = saved.skel;
	}
	console.log(`${pass}/${pass + fail}`);
	process.exitCode = fail ? 1 : 0;
})();
