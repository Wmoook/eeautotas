'use strict';
// test/admbounds.js: src/plan/admbounds.js's tables against the engine, and its bound against random engine runs in toy
// rooms where its tame tiers act (the bound never above the ticks a run took). Fast (seconds).
// usage: node test/admbounds.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const A = require('../src/plan/admbounds.js');
const T = require('../src/plan/types.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const levelOf = (rows, ID) => {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
};
const ID = { '#': [9], S: [255], T: [121], c: [100] };

// 1. the x curve: holding right on a long floor from rest never travels more than S(n; 0), and gets close to it
{
	const row = '#' + 'S' + '.'.repeat(195) + '#';
	const L = levelOf(['#'.repeat(198), '#' + '.'.repeat(196) + '#', row, '#'.repeat(198)], ID);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let k = 0; k < 30; k++) { E.applyMask(inp, 0); sim.tick(inp); }   // settle on the floor
	const x0 = sim.px;
	const c = A.curveOf(1 / E.constants.MULT, false);
	let worst = 0, tight = 1;
	for (let n = 1; n <= 300 && sim.px < 16 * 190; n++) {
		E.applyMask(inp, 4); sim.tick(inp);
		const d = sim.px - x0, s = c.up.S[n];
		if (d > s + 1e-6) worst = Math.max(worst, d - s);
		if (n >= 20) tight = Math.min(tight, d / s);
	}
	check('holding right from rest: travel <= S(n; 0)', worst === 0, `worst excess ${worst}`);
	check('... and within 10% of it (the align margin below 1.2 px/tick)', tight > 0.9, `min ratio ${tight.toFixed(4)}`);
}
// 2. the rise: one jump rises 63.42 px; a jump's rise over its ticks + the grounded one never beats rate
{
	const r = A.riseOf((2 * 26) / E.constants.MULT, 2 / E.constants.MULT);
	check('one jump rises 63.42 px (the engine\'s jump)', Math.abs(r.R[r.R.length - 1] - 63.42) < 0.2, r.R[r.R.length - 1].toFixed(2));
	check('the climb rate is below the jump speed', r.rate < 6.708 && r.rate > 4, r.rate.toFixed(3));
	const L = levelOf(['#'.repeat(12), ...Array.from({ length: 10 }, () => '#' + '.'.repeat(10) + '#'), '#....S.....#', '#'.repeat(12)], ID);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let k = 0; k < 30; k++) { E.applyMask(inp, 0); sim.tick(inp); }
	const y0 = sim.py;
	let best = 0, n = 0;
	E.applyMask(inp, 1); sim.tick(inp);
	for (let k = 1; k < 40; k++) { E.applyMask(inp, 0); sim.tick(inp); const h = y0 - sim.py; if (h > best) { best = h; n = k + 1; } }
	check('the engine\'s jump: rise / (ticks incl. the grounded one) <= rate', best / (n + 1) <= r.rate + 1e-9, `${best.toFixed(2)} px in ${n} ticks`);
}
// 3. random runs in toy rooms (sticky random inputs): for alive ticks k and earlier ticks t of the run (no feature
// changes in these rooms), bound(state_t -> the centre tile at k) <= k - t
function walkCheck(name, rows, runs, len, seed) {
	const L = levelOf(rows, ID);
	const W = L.width, H = L.height;
	const B = A.createAdmBounds(L);
	let s = seed >>> 0;
	const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
	const MASKS = [0, 1, 2, 3, 4, 5, 4, 5, 2, 3];
	let viol = 0, n = 0, sumR = 0, nR = 0, tame = 0;
	const sim = new E.EESim(L), inp = new E.EEInput();
	for (let r = 0; r < runs; r++) {
		sim.reset();
		const snaps = [sim.snapshot()], tiles = [T.tileOf(sim, W, H)], dead = [0];
		let m = 0;
		for (let t = 0; t < len; t++) {
			if (t === 0 || rnd() < 0.12) m = MASKS[Math.floor(rnd() * MASKS.length)];
			E.applyMask(inp, m); sim.tick(inp);
			snaps.push(sim.snapshot()); tiles.push(T.tileOf(sim, W, H)); dead.push(sim.is_dead ? 1 : 0);
		}
		for (let k = 10; k <= len; k += 7) {
			if (dead[k]) continue;
			const f = B.field([tiles[k]], null);
			for (let t = 0; t < k; t += 3) {
				sim.restore(snaps[t]);
				const b = B.at(f, sim), p = B.parts(f, sim);
				if (p.accX !== null || p.up !== null) tame++;
				n++;
				if (b > k - t) viol++;
				else if (k - t >= 10) { sumR += b / (k - t); nR++; }
			}
		}
	}
	check(`${name}: bound <= the ticks a run took, every pair`, viol === 0 && n > 0, `${n} pairs, ${viol} above, mean ratio ${(sumR / Math.max(1, nR)).toFixed(3)}, tame tiers at ${tame}`);
}
walkCheck('a floor run', ['#'.repeat(40), '#' + '.'.repeat(38) + '#', '#' + '.'.repeat(38) + '#', '#S' + '.'.repeat(37) + '#', '#'.repeat(40)], 30, 240, 1);
walkCheck('ledges', ['#'.repeat(30), '#............................#', '#............................#', '#..........#####.......####..#', '#......###..........##.......#', '#S...........................#', '#'.repeat(30)], 30, 300, 2);
walkCheck('a pit and a shaft', ['#'.repeat(30), '#............................#', '#S...................#.......#', '####....######.......#.......#', '#..#....#....#.......#..###..#', '#..######....##############..#', '#'.repeat(30)], 30, 300, 3);
console.log(`admbounds: ${pass}/${fail}`);
process.exitCode = fail ? 1 : 0;
