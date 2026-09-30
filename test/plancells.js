'use strict';
// test/plancells.js: the leg finder's cells (src/plan/legs.js legBest), doctor 8 (n5-doc-8). Prints 'name: ok|FAIL', ends
// 'N/M' (passed / checks), exit 1 on a failure.
// usage: node test/plancells.js
//   zero   THE ZERO-SPEED BUCKET (o.zeroCell / EEAT_CELL_ZERO=1): a 1-wide column falls through a dot row into 3 up-arrow
//          rows and a coin below (UT Eternal Galaxy's first coin, cut down): the zero-input fall reaches the coin; a held
//          left / right input pushes into the column's walls and keeps a slow drift (the wall stops the move, not the
//          speed), which the [0, 1/8) px/tick bucket merges with the straight fall; once that drift is the cell's first
//          arrival, the dot row slides it onto the ledge beside the arrow column. With the bucket legBest finds the coin
//          from the column's top; the default cells (the knob off) as before; the found leg replayed by the engine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const LG = require('../src/plan/legs.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plancells-'));

function levelOf(rows, ID, name) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.' && ID[ch]) cells.push([x, y, ...ID[ch]]); }));
	const buf = ED.eelvlOf({ name: name || 't', width: rows[0].length, height: rows.length, cells });
	fs.writeFileSync(path.join(tmpDir, `${name || 't'}.eelvl`), buf);
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
}

function zero() {
	// # wall, S spawn, : dots (4), ^ up arrows (2), o coin
	// (the column opens 3 wide above the dot row, as the level's does: a side input there moves the ball off the grid)
	const rows = [
		'###########',
		'#####S#####',
		'#####.#####',
		'#####.#####',
		'####...####',
		'####...####',
		'####...####',
		'####...####',
		'#:::::::::#',
		'#####^#####',
		'#####^#####',
		'#####^#####',
		'#####.#####',
		'#####.#####',
		'#####o#####',
		'###########',
	];
	const L = levelOf(rows, { '#': [9], S: [255], ':': [4], '^': [2], o: [100] }, 'zerocol');
	const W = L.width, H = L.height;
	const coin = 14 * W + 5;
	const wp = { kind: 'trigger', tiles: [coin], expect: null, label: 'coin (5,14)' };
	const goal = T.goalOf(L, wp);
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	const snap = sim.snapshot();
	// (the zero-input fall reaches the coin: the leg exists)
	let t = 0, got = false;
	for (; t < 200 && !got; t++) { E.applyMask(inp, 0); sim.tick(inp); if (goal.test(sim)) got = true; }
	check('zero: the idle fall reaches the coin', got, `${t} ticks`);
	// (a tap of the side input in the open part: off the grid by less than the 2 px bucket, slower than its 1/8 px/tick)
	sim.restore(snap);
	for (let k = 0; k < 40; k++) { E.applyMask(inp, k === 30 ? 4 : 0); sim.tick(inp); }
	check('zero: a 1-tick tap leaves the ball off the grid within one cell', sim.px !== 80 && Math.floor(sim.px * 0.5) === 40 && Math.abs(sim.speed_x) < 0.125, `px ${sim.px.toFixed(3)}, vx ${sim.speed_x.toFixed(3)}`);
	const field = T.goalField(L, T.fieldTilesOf(goal), {});
	const run = (zc) => {
		sim.restore(snap);
		return LG.legBest(L, [{ snap: sim.snapshot(), tick: 0 }], goal, { sim, deadline: Date.now() + 2000, field, region: null, depthMax: 400, zeroCell: zc, noFinish: true });
	};
	const on = run(true);
	check('zero: legBest finds the coin with the zero bucket', on.status === 'found', `${on.status}, ${on.depth} ticks, ${on.sims} sims`);
	if (on.status === 'found') {
		sim.restore(snap);
		let ok = false;
		for (let k = 0; k < on.tail.length; k++) { E.applyMask(inp, on.tail[k] & 31); sim.tick(inp); if (goal.test(sim)) { ok = k === on.tail.length - 1; break; } }
		check('zero: its leg replays to the coin at its last tick', ok);
	}
	const off = run(false);
	console.log(`  (the default cells: ${off.status}${off.status === 'found' ? `, ${off.depth} ticks` : ''}, ${off.sims} sims)`);
	// (the knob: o.zeroCell false = the cells as before; the same run twice = the same search)
	const off2 = run(false);
	check('zero: the default cells are deterministic', off2.status === off.status && off2.sims === off.sims);
}

zero();
console.log(`${pass}/${pass + fail}`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
