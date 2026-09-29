'use strict';
// test/roomval.js - THE ROOM VALUE (src/roomval.js; goexplore.js --gpu=1 --gpuVal=1, OFF by default):
//   features  a toy coin-door level (coin doors 43:2 and 43:4, a red key door): the thresholds, the key colours with
//             doors; a room with 0 coins and no keys has offset 0 (its cells score exactly the reach cost); more useful
//             coins score lower; coins above the highest door add nothing; a key colour without a door adds nothing;
//             a level with no doors has offset 0 everywhere (levelInfo any = false: --gpuVal is a no-op there)
//   weights   the committed weights (src/roomval_w.json) read and checked; a weights file with a positive count
//             weight or a w_rc <= 0 is refused
//   search    (only with --tool=<eegpu>: needs a GPU) goexplore.js --gpu=1 on the toy level (the coins behind the spawn,
//             the door towards the trophy): with --gpuVal=1 a route and rooms with an offset in the done event; the same
//             seed and tick budget give the same search twice; flag off vs --main=<main's src/goexplore.js>: the same
//             done numbers (picks, cells, rooms, records, batches); a missing weights file fails at the start
// usage: node test/roomval.js [--tool=<eegpu>] [--main=<path to origin/main's src/goexplore.js>]   Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-roomval-'));
process.env.EEAT_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const RV = require('../src/roomval.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const opt = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);

// The toy level (40 x 10): the spawn in the middle (x 14), two coins behind it (x 3, 6), two more on a ledge (x 9, 11),
// a column of coin doors 43:2 at x 22 and 43:4 at x 28 across the corridor, a red key door (23) above the floor at x 34
// (not in the way: a ceiling pocket), the trophy at x 37
const LW = 40, LH = 10;
function toy(file, doors) {
	const cells = [];
	for (let x = 0; x < LW; x++) cells.push([x, 0, 9], [x, LH - 1, 9]);
	for (let y = 1; y < LH - 1; y++) cells.push([0, y, 9], [LW - 1, y, 9]);
	cells.push([14, 8, 255], [37, 8, 121], [3, 8, 100], [6, 8, 100], [9, 8, 100], [11, 8, 100]);
	if (doors) {
		for (let y = 1; y < LH - 1; y++) cells.push([22, y, 43, 2], [28, y, 43, 4]);
		cells.push([34, 1, 23]);
	}
	fs.writeFileSync(file, ED.eelvlOf({ name: 'room value toy', width: LW, height: LH, cells }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}

function sectionFeatures(L, L0) {
	section('features: useful counts, thresholds, keys with doors');
	const I = RV.levelInfo(L);
	check('the coin thresholds 2 and 4, the highest 4', I.cTh.join(',') === '2,4' && I.cMax === 4, I.cTh.join(','));
	check('no blue thresholds', I.bTh.length === 0 && I.bMax === 0);
	check('the red key colour has a door (bit 1), no other', I.kd === 1, String(I.kd));
	check('the level counts (any)', I.any === true);
	const W = RV.readWeights();
	const off = (c, b, k) => RV.offsetOf(W, RV.featsOf(I, c, b, k));
	check('0 coins, no keys: offset exactly 0 (the cells score exactly the reach cost)', off(0, 0, 0) === 0 && Object.is(off(0, 0, 0), 0), String(off(0, 0, 0)));
	check('more useful coins score lower (0 > 1 > 2 > 3 > 4)', off(0, 0, 0) > off(1, 0, 0) && off(1, 0, 0) > off(2, 0, 0) && off(2, 0, 0) > off(3, 0, 0) && off(3, 0, 0) > off(4, 0, 0),
		[0, 1, 2, 3, 4].map((c) => off(c, 0, 0).toFixed(1)).join(' '));
	check('coins above the highest door add nothing (4 = 5 = 40)', off(4, 0, 0) === off(5, 0, 0) && off(4, 0, 0) === off(40, 0, 0));
	check('blue coins on a level without blue doors add nothing', off(2, 0, 0) === off(2, 7, 0));
	check('the red key (a door) scores lower or the same; the green key (no door) adds nothing', off(1, 0, 1) <= off(1, 0, 0) && off(1, 0, 2) === off(1, 0, 0), `${off(1, 0, 1).toFixed(1)} / ${off(1, 0, 0).toFixed(1)} / ${off(1, 0, 2).toFixed(1)}`);
	check('every offset <= 0 and above -OFF_CAP', [0, 1, 2, 3, 4, 9].every((c) => off(c, 0, 1) <= 0 && off(c, 0, 1) > -RV.OFF_CAP));
	// many coins: still ordered by the count near the cap (tanh is monotone)
	const I9 = RV.levelInfo(Object.assign({}, L, { coinDoorThresholds: Int32Array.from([50]) }));
	check('near the cap still monotone (0 > 10 > 30 > 50 coins of a 50-coin door)', [0, 10, 30, 50].map((c) => RV.offsetOf(W, RV.featsOf(I9, c, 0, 0))).every((v, i, a) => i === 0 || v < a[i - 1]),
		[0, 10, 30, 50].map((c) => RV.offsetOf(W, RV.featsOf(I9, c, 0, 0)).toFixed(1)).join(' '));
	const I0 = RV.levelInfo(L0);
	check('a level with no doors: any = false, offset 0 for any counts', I0.any === false && RV.offsetOf(W, RV.featsOf(I0, 9, 3, 63)) === 0);
	// the engine's own state: a sim's features
	const sim = new E.EESim(L); sim.reset();
	sim.coins = 3; sim.blue_coins = 0; sim._keysMask = 1;
	const f = RV.featsOfSim(I, sim);
	check('featsOfSim reads coins, blue coins, keys', f.length === RV.FEATS.length - 1 && f[0] === 0.75 && f[1] === 0.5 && f[6] === 1, f.map((x) => +x.toFixed(3)).join(' '));
}

function sectionWeights() {
	section('weights: the committed file, the checks');
	let W = null;
	try { W = RV.readWeights(); } catch (e) { /* below */ }
	check('src/roomval_w.json reads (w_rc > 0, the count weights <= 0)', !!W, W ? W.w.join(' ') : 'refused');
	check('some count weight < 0 (the value is count-aware)', !!W && W.w.slice(1).some((x) => x < 0));
	const bad = (w) => { const f = path.join(HOME, 'w.json'); fs.writeFileSync(f, JSON.stringify({ w })); try { RV.readWeights(f); return false; } catch (e) { return true; } };
	check('a positive count weight is refused', bad([1, 0.5, 0, 0, 0, 0, 0, 0]));
	check('w_rc <= 0 is refused', bad([0, -1, 0, 0, 0, 0, 0, 0]));
	check('a wrong length is refused', bad([1, -1]));
}

function gox(tool, file, args, timeoutMs = 300000) {
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const sig = (ev) => { const d = doneOf(ev); return JSON.stringify([d.ticks, d.states, d.picks, d.finish, d.rooms, d.records, d.batches, routesOf(ev).map((r) => r.ticks)]); };

function sectionSearch(file) {
	section('search: goexplore.js --gpu=1 with and without --gpuVal (needs a GPU)');
	const base = ['--gpu=1', `--tool=${path.resolve(opt.tool)}`, '--seconds=60', '--maxTicks=20000000', '--seed=1', '--batch=512'];
	const v1 = gox(GOX, file, [...base, '--gpuVal=1']), v2 = gox(GOX, file, [...base, '--gpuVal=1']);
	const d1 = doneOf(v1);
	check('--gpuVal=1: a route', routesOf(v1).length > 0, routesOf(v1).map((r) => r.ticks).join(',') || JSON.stringify(d1).slice(0, 200));
	check('--gpuVal=1: rooms with an offset (done val)', !!d1.val && d1.val.rooms > 0 && d1.val.minOff < 0, JSON.stringify(d1.val));
	check('--gpuVal=1: the same seed and tick budget give the same search', sig(v1) === sig(v2), `${sig(v1)} vs ${sig(v2)}`);
	const off1 = gox(GOX, file, base), off2 = gox(GOX, file, base);
	check('flag off: no val in the done event', doneOf(off1).val === undefined);
	check('flag off: the same search twice', sig(off1) === sig(off2), sig(off1));
	const bad = gox(GOX, file, [...base, '--gpuVal=1', `--gpuValW=${path.join(HOME, 'nope.json')}`]);
	check('a missing weights file fails at the start (an error line, no search)', bad.some((e) => e.error && /--gpuVal/.test(e.error)) && !bad.some((e) => e.ev === 'done'));
	if (opt.main) {
		const m = gox(path.resolve(opt.main), file, base);
		check('flag off = main (the same done numbers)', sig(off1) === sig(m), `${sig(off1)} vs ${sig(m)}`);
	}
}

const file = path.join(HOME, 'toy.eelvl');
const L = toy(file, true), L0 = toy(path.join(HOME, 'toy0.eelvl'), false);
sectionFeatures(L, L0);
sectionWeights();
if (opt.tool) sectionSearch(file);
else console.log('\n(the search section needs a GPU: --tool=<eegpu>)');
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
