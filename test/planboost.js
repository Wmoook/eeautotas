'use strict';
// test/planboost.js: THE BOOST'S WAY in the compiler's est walk (src/plan/model.js, OPT-IN EEAT_EST_BOOSTDIR=1).
// A 1-tall corridor, the spawn on the right, a right boost between it and the trophy: the engine never passes the boost
// leftward (held left for 400 ticks the ball's centre never leaves the boost's column toward the trophy); with the knob
// the est walk reaches no trophy (it took the boost against its push before), the lb walk (the proofs) is unchanged
// (finite, the same steps) and a boost of the walk's own way is taken; without the knob the est walk is the one before.
// usage: node test/planboost.js
const cp = require('child_process');
const path = require('path');
if (process.argv[2] !== '--child') {
	let fails = 0;
	for (const knob of ['1', '0']) {
		const out = cp.execFileSync(process.execPath, [__filename, '--child'], { env: Object.assign({}, process.env, { EEAT_EST_BOOSTDIR: knob }), encoding: 'utf8' });
		for (const ln of out.trim().split('\n')) { console.log(`knob ${knob}: ${ln}`); if (/FAIL/.test(ln)) fails++; }
	}
	console.log(fails ? `FAIL ${fails}` : 'ok');
	process.exit(fails ? 1 : 0);
}
const E = require('../src/eesim.js'), EL = require('../src/eelvl.js'), ED = require('../src/editor.js');
const { compileModel } = require('../src/plan/model.js');
function level(rows, legend) {
	const ID = Object.assign({ '#': [9], S: [255], T: [121] }, legend || {});
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'b', width: rows[0].length, height: rows.length, cells }))));
}
const knob = process.env.EEAT_EST_BOOSTDIR === '1';
const check = (name, ok, detail) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
(async () => {
	const fin = (v) => v < 1e9;
	// (1) the trophy behind a right boost, the spawn on the right
	const L = level([
		'########################',
		'#......................#',
		'#......................#',
		'########################',
		'#...T.....>........S...#',
		'########################',
	], { '>': [115] });
	const m = await compileModel(L, {});
	const sim = new E.EESim(L); sim.reset();
	const S = m.stateOf(sim);
	const pos = { id: 'st', tiles: [m.startTile], extra: 0 };
	const minOf = (d) => { let b = Infinity; for (const t of m.trophyTiles) b = Math.min(b, d[t]); return b; };
	const est = minOf(m.dist(S, pos, 'est', null)), lb = minOf(m.dist(S, pos, 'lb', null)), estNW = minOf(m.dist(S, pos, 'estNW', null));
	check('lb walk finite and unchanged', fin(lb) && lb === 15, `lb ${lb}`);
	if (knob) { check('est walk: no way against the boost', !fin(est), `est ${est}`); check('estNW too', !fin(estNW), `estNW ${estNW}`); }
	else check('est walk as before (through the boost)', est === 15, `est ${est}`);
	const inp = new E.EEInput(); let minX = 99;
	for (let k = 0; k < 400; k++) { E.applyMask(inp, 2); sim.tick(inp); minX = Math.min(minX, (sim.px + 8) >> 4); }
	check('the engine: held left, the ball never passes the boost', minX >= 10, `least x tile ${minX}`);
	// (2) the same corridor mirrored: the spawn left, the trophy right of the right boost: the boost's own way stays open
	const L2 = level([
		'########################',
		'#......................#',
		'#......................#',
		'########################',
		'#...S.....>........T...#',
		'########################',
	], { '>': [115] });
	const m2 = await compileModel(L2, {});
	const s2 = new E.EESim(L2); s2.reset();
	const S2 = m2.stateOf(s2);
	let e2 = Infinity; const d2 = m2.dist(S2, { id: 'st', tiles: [m2.startTile], extra: 0 }, 'est', null);
	for (const t of m2.trophyTiles) e2 = Math.min(e2, d2[t]);
	check('a boost of the walk\'s own way is taken', e2 === 15, `est ${e2}`);
	// (3) the corner: the trophy left of a right boost, a solid under the trophy, an open tile under the boost: the walk's
	// diagonal from under the boost up-left to the trophy passes the boost's side tile against its push (Daybreak's switch)
	const L3 = level([
		'############',
		'#..........#',
		'############',
		'#...T>S....#',
		'#...#......#',
		'############',
	], { '>': [115] });
	const m3 = await compileModel(L3, {});
	const s3 = new E.EESim(L3); s3.reset();
	const S3 = m3.stateOf(s3);
	const p3 = { id: 'st', tiles: [m3.startTile], extra: 0 };
	const minT = (mm, d) => { let b = Infinity; for (const t of mm.trophyTiles) b = Math.min(b, d[t]); return b; };
	const e3 = minT(m3, m3.dist(S3, p3, 'est', null)), l3 = minT(m3, m3.dist(S3, p3, 'lb', null));
	check('the corner: the lb walk finite', fin(l3), `lb ${l3}`);
	if (knob) check('the corner: the est walk has no diagonal past the boost', !fin(e3), `est ${e3}`);
	else check('the corner: the est walk as before (the diagonal)', fin(e3), `est ${e3}`);
	// the engine: 300 seeded random input runs of 300 ticks (an input held 1-20 ticks) never reach the trophy
	let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
	let won = 0, tried = 0;
	for (let r = 0; r < 300; r++) {
		const sm = new E.EESim(L3); sm.reset(); const ip = new E.EEInput();
		let k = 0, mask = 0, hold = 0;
		while (k < 300) {
			if (hold-- <= 0) { mask = (rnd() * 32) | 0; hold = 1 + ((rnd() * 20) | 0); }
			E.applyMask(ip, mask); sm.tick(ip); k++;
			if (((sm.px + 8) >> 4) === 4 && ((sm.py + 8) >> 4) === 3) { won++; break; }
		}
		tried++;
	}
	check('the corner: the engine never reaches the trophy (300 random runs)', won === 0, `${won} of ${tried}`);
})();
