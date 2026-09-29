'use strict';
// test/runup.js - RUN-UP CELLS (goexplore.js --ru=1, the default; n3-run-up-cells, 2026-09-29): a stalled room's states
// next to a speed feature also make speed-bucketed cells, so a later, faster arrival at a coarse cell is kept apart from
// the earlier, slower one (more cells, nothing dropped):
//   features  runupFeatures: arrows, boosts, portals and one-ways marked; a level without one: null (no zone ever)
//   chute     a speed-gated left-arrow chute (4 tiles in a 1-tall tunnel: only a ball entering at ~6 px/tick or more
//             gets through; the spawn 4 tiles before it, the run-up 30 tiles back along the corridor): with a tight
//             fast-cell slack (--spdSlack=20: the one fast cell of --spdMode=1 takes only arrivals 20 ticks after the
//             coarse cell's earliest, as a run-up that comes much later) the bucket cells route it (replayed through the
//             chute), --ru=0 does not (the earliest, slow arrivals hold the runway's cells); the zone and its cells counted
//   nostall   before any stall (the default --spd=60 s: no flag in a short run) --ru=1 is --ru=0 (one worker, a tick
//             budget: the same done numbers and routes); with --main=<main's goexplore.js> also main's
// usage: node test/runup.js [--main=<file>] [--only=features,chute,nostall]   Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-runup-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const arg = (k) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const ONLY = arg('only') ? new Set(arg('only').split(',')) : null;
const MAIN = arg('main');
const on = (s) => !ONLY || ONLY.has(s);

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
// ASCII levels: # wall, S spawn, T trophy, < left arrow, ^ up arrow, @ portal, = one-way, } boost right
const ID = { '#': [9], S: [255], T: [121], '<': [1], '^': [2], '=': [61], '}': [115] };
function levelFile(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
/** goexplore.js (or another copy of it) on a level file: its JSON events */
function gox(file, args, tool = GOX, timeoutMs = 120000) {
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
const w0 = (ev) => ((doneOf(ev).workers || [])[0]) || {};

// the chute: 90 x 12, the corridor row 9 (floor row 10), the left arrows x 70..73 in a 1-tall tunnel (rows 8 and 10
// walls) that goes on to the trophy (87, 9); the spawn (66, 9): held right from there the ball enters at ~3 px/tick and is
// pushed back; from rest it passes from x 46 or further back (5.8+ px/tick at the mouth)
function chuteRows() {
	const W = 90, cx = 70, n = 4, sx = 66, rows = [];
	for (let y = 0; y < 12; y++) {
		let r = '';
		for (let x = 0; x < W; x++) {
			let ch = '.';
			if (y === 0 || y >= 10 || x === 0 || x === W - 1) ch = '#';
			else if (y <= 8 && x >= cx - 1) ch = '#';
			else if (y === 9 && x >= cx && x < cx + n) ch = '<';
			else if (y === 9 && x === W - 3) ch = 'T';
			else if (y === 9 && x === sx) ch = 'S';
			r += ch;
		}
		rows.push(r);
	}
	return rows;
}
const CHUTE = levelFile('chute', chuteRows());
const PLAIN = levelFile('plain', [
	'##############################################################',
	'#............................................................#',
	'#............................................................#',
	'#............................................................#',
	'#............................................................#',
	'#.....................................................T......#',
	'#..................................................#######...#',
	'#.S.............................#####..............#######...#',
	'#..............................######....................#...#',
	'##############################################################',
]);

/** hold right from a spawn moved to x: does the ball get through the chute? (the chute's speed gate, engine only) */
function passesFrom(x) {
	const rows = chuteRows().map((r, y) => (y === 9 ? r.replace('S', '.').slice(0, x) + 'S' + r.replace('S', '.').slice(x + 1) : r));
	const { level } = levelFile(`chute_from_${x}`, rows);
	const sim = new E.EESim(level); sim.reset();
	const inp = new E.EEInput();
	for (let t = 0; t < 800; t++) { E.applyMask(inp, 4); sim.tick(inp); if (sim.has_silver_crown) return true; }
	return false;
}

if (on('features')) {
	section('features: runupFeatures marks the speed features');
	const f = GX.runupFeatures(CHUTE.level);
	const W = CHUTE.level.width;
	let n = 0; for (let i = 0; i < f.length; i++) n += f[i];
	check('the chute: its 4 left arrows and nothing else', f !== null && n === 4 && f[9 * W + 70] === 1 && f[9 * W + 73] === 1 && f[9 * W + 69] === 0, `${n} marked`);
	check('a level without a speed feature: null (no zone can form: ruMark needs one)', GX.runupFeatures(PLAIN.level) === null);
	const mix = levelFile('mix', ['########', '#S.^=}.#', '#......#', '#.....T#', '########']);
	const fm = GX.runupFeatures(mix.level), Wm = mix.level.width;
	check('an up arrow, a one-way and a boost', fm !== null && fm[1 * Wm + 3] === 1 && fm[1 * Wm + 4] === 1 && fm[1 * Wm + 5] === 1 && fm[1 * Wm + 2] === 0 && fm[1 * Wm + 6] === 0);
	check('the options: --ru / --ruR / --ruB / --ruSlack (defaults 1, 12, 1.5, 0), EEAT_RUNUP', (() => {
		const a = GX.parseArgs(['x.eelvl']);
		const b = GX.parseArgs(['x.eelvl', '--ru=0', '--ruR=20', '--ruB=2', '--ruSlack=100']);
		return a.ru === (process.env.EEAT_RUNUP !== undefined ? +process.env.EEAT_RUNUP : 1) && a.ruR === 12 && a.ruB === 1.5 && a.ruSlack === 0 && b.ru === 0 && b.ruR === 20 && b.ruB === 2 && b.ruSlack === 100;
	})());
}

if (on('chute')) {
	section('chute: a late fast arrival kept apart from the early slow one');
	check('the engine: held right from the spawn the ball is pushed back', !passesFrom(66));
	check('the engine: a run-up from x 40 gets through', passesFrom(40));
	// a stall clock of 2 s, a zone over the whole corridor (--ruR=40), and a tight fast-cell slack in both arms
	const base = ['--cells=coarse', '--workers=1', '--seconds=25', '--spd=2', '--spdSlack=20', '--ruR=40', '--first=1', '--mem=300'];
	for (const seed of [1, 2]) {
		const t0 = Date.now();
		const evR = gox(CHUTE.file, [...base, `--seed=${seed}`, '--ru=1']);
		const sR = (Date.now() - t0) / 1000;
		const rR = routesOf(evR), wR = w0(evR);
		const ok = rR.length > 0 && rR.every((r) => { const ev = C.evaluate(CHUTE.level, masksOf(r.inputs)); return ev !== null && ev.runTicks === r.runTicks; });
		check(`seed ${seed} --ru=1: a route, replayed (C.evaluate)`, ok, rR.length ? `${rR[0].ticks} ticks after ${sR.toFixed(1)} s` : 'none');
		check(`seed ${seed} --ru=1: a zone and its bucket cells`, (wR.ruZones || 0) >= 1 && (wR.ruCells || 0) > 0 && (wR.ruBetter || 0) > 0, `zones ${wR.ruZones} cells ${wR.ruCells} better ${wR.ruBetter}`);
		const ev0 = gox(CHUTE.file, [...base, `--seed=${seed}`, '--ru=0']);
		const w00 = w0(ev0);
		check(`seed ${seed} --ru=0: no route in 25 s (the runway's cells hold the slow arrivals)`, routesOf(ev0).length === 0, `bestCost ${JSON.stringify(ev0.filter((e) => e.ev === 'progress').slice(-1).map((e) => e.bestCost))}`);
		check(`seed ${seed} --ru=0: no ru stats`, w00.ruZones === undefined && (w00.spdFlags || 0) >= 1, `spdFlags ${w00.spdFlags}`);
	}
}

if (on('nostall')) {
	section('nostall: before a stall --ru=1 searches exactly as --ru=0');
	const args = ['--cells=coarse', '--workers=1', '--seed=3', '--maxTicks=4000000', '--mem=300', '--seconds=60'];
	const key = (ev) => { const d = doneOf(ev), w = w0(ev); return JSON.stringify({ ticks: d.ticks, states: d.states, picks: d.picks, first: d.first && d.first.ticks, cells: w.cells, impr: w.impr, rooms: w.rooms, routes: routesOf(ev).map((r) => r.inputs) }); };
	for (const lv of [CHUTE, PLAIN]) {
		const a = key(gox(lv.file, [...args, '--ru=1'])), b = key(gox(lv.file, [...args, '--ru=0']));
		check(`${path.basename(lv.file)}: --ru=1 = --ru=0`, a === b, a.slice(0, 160));
		if (MAIN) {
			const m = key(gox(lv.file, args, path.resolve(MAIN)));
			check(`${path.basename(lv.file)}: --ru=1 = main (${MAIN})`, a === m, m.slice(0, 160));
		}
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
