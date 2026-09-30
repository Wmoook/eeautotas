'use strict';
// T-SKEL-KEEP (COMPILER DOCTOR 10, n5): the executor's skeleton (a far waypoint through the goal field's sub-level sets)
// keeps the levels it reached across new counterexample walls when EEAT_SKEL_KEEP=1: the next call for the same waypoint
// and starts resumes from its deepest level (re-measured on the walled field), where the memo keyed by the walls' count
// started again from the starts. Knob off: the memo as before (a call after new walls does not resume).
//   node test/planskel.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planskel-'));

function levelOf(rows, ID, name) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.' && ID[ch]) cells.push([x, y, ...ID[ch]]); }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(tmpDir, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	return { L, file, at: (x, y) => y * L.width + x };
}

async function run(keep) {
	// (the knobs are read when the executor is made: set them first, a fresh require for each mode)
	process.env.EEAT_SKEL_DIRECT = '0';   // (the skeleton from the first call: no direct leg)
	if (keep) process.env.EEAT_SKEL_KEEP = '1'; else delete process.env.EEAT_SKEL_KEEP;
	for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}plan${path.sep}`)) delete require.cache[k];
	const EX = require('../src/plan/executor.js');
	// a corridor 64 tiles long with steps: the trophy ~60 tiles from the spawn (past the skeleton's 30), sub-level sets of
	// 12 tiles
	const rows = [
		'################################################################',
		'#..............................................................#',
		'#..............................................................#',
		'#..............................................................#',
		'#S.........#...........#...........#...........#.............T.#',
		'################################################################',
	];
	const { L, file, at } = levelOf(rows, { '#': [9], S: [255], T: [121] }, keep ? 'skelkeep' : 'skelbase');
	const skels = [];
	const ex = await EX.createExecutor(L, { file, workers: 0, emit: (ev) => { if (ev.ev === 'exec.skel') skels.push(ev); } });
	const wp = { kind: 'trophy', label: 'trophy' };
	const start = { masks: new Uint8Array(0) };
	const r1 = await ex.reach([start], wp, { ms: 8000, level: 1 });
	const s1 = skels.length ? skels[skels.length - 1] : null;
	const ok1 = r1.ok && r1.arrivals.every((a) => T.playTo(L, a.masks).finished === a.masks.length);
	// (a batch of counterexample walls on the trophy's field, off the corridor's way (the ceiling row's air): the walls'
	// count changes, the field's costs along the way do not)
	const n = ex._addWalls(wp, [at(5, 1), at(6, 1), at(7, 1)]);
	const k0 = skels.length;
	const r2 = await ex.reach([start], wp, { ms: 8000, level: 1 });
	const s2 = skels.length > k0 ? skels[skels.length - 1] : null;
	const ok2 = r2.ok && r2.arrivals.every((a) => T.playTo(L, a.masks).finished === a.masks.length);
	await ex.close();
	return { r1, s1, ok1, n, r2, s2, ok2 };
}

(async () => {
	const base = await run(false);
	check('T-SKEL-KEEP base: the first call descends the skeleton and finishes (replayed)', base.ok1 && base.s1 && base.s1.levels.length > 0,
		base.s1 ? `c0 ${base.s1.c0}, ${base.s1.levels.length} levels` : 'no skeleton');
	check('T-SKEL-KEEP base: walls added (3)', base.n === 3, base.n);
	check('T-SKEL-KEEP base (knob off): the call after new walls does NOT resume (the memo keyed by the walls\' count: as before)',
		base.s2 && base.s2.resumed === false && base.ok2, base.s2 ? `resumed ${base.s2.resumed}, c0 ${base.s2.c0}, ${base.s2.levels.length} levels` : 'no skeleton');
	const keep = await run(true);
	check('T-SKEL-KEEP keep: the first call as the base (the same levels)', keep.ok1 && keep.s1 && base.s1 && JSON.stringify(keep.s1.levels.map((l) => l.c)) === JSON.stringify(base.s1.levels.map((l) => l.c)),
		keep.s1 ? keep.s1.levels.map((l) => l.c).join(',') : 'none');
	check('T-SKEL-KEEP keep (EEAT_SKEL_KEEP=1): the call after new walls RESUMES from the deepest level, re-measured, and finishes (replayed)',
		keep.s2 && keep.s2.resumed === true && keep.ok2 && keep.s2.levels.length < base.s2.levels.length,
		keep.s2 ? `resumed ${keep.s2.resumed}, ${keep.s2.levels.length} vs ${base.s2 ? base.s2.levels.length : '?'} levels, walls ${keep.s2.walls}` : 'no skeleton');
	check('T-SKEL-KEEP keep: the resumed call is no slower in route ticks than the base\'s restart', keep.ok2 && base.ok2 && keep.r2.arrivals[0].masks.length <= base.r2.arrivals[0].masks.length + 8,
		`${keep.r2.ok ? keep.r2.arrivals[0].masks.length : '-'} vs ${base.r2.ok ? base.r2.arrivals[0].masks.length : '-'}`);
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
	console.log(`${pass} pass, ${fail} fail`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
