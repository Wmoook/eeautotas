'use strict';
// test/jcell.js - goexplore.js --jcell=1 (JCELL in explore(): the air jumps left as a coarse-cell word; OPT-IN, default off):
//   toy      a multijump level (coarse cells: --cells=coarse; the multijump effect 461 x2 at the spawn, a wall only a double
//            jump clears, the trophy behind it): --jcell=1 makes cells with the word, keeps later arrivals with a jump in
//            hand as their own cells (jcell.kept: a cell of the same place with fewer jumps left got there no later, the
//            state the key without the word drops) and drops arrivals a cell with more jumps left beat (jcell.dominated);
//            a route (replayed); the flag off has no "jcell" in its done event; the same seed and budget give the same
//            search with the flag on
//   single   a single-jump toy level: --jcell=1 is a no-op (the same done numbers and route inputs, no cells with the word)
//   levels   (with --levels=<the campaign folder>) 1 worker + a tick budget: the flag off gives main's cells, picks,
//            replays and route inputs (with --main=<main's src/goexplore.js>) on 04_1, 37_3, 05_2, 26_1, 02_3, and the flag
//            on is a no-op byte for byte where max_jumps is 1 or 1000+ (04_1, 37_3)
// usage: node test/jcell.js [--only=toy,single,levels] [--levels=<dir of campaign .eelvl>] [--main=<path to main's src/goexplore.js>]
//        [--ticks=3000000]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-jcell-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const opt = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }
const ONLY = (opt.only || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
function gox(tool, file, args, timeoutMs = 240000) {
	const env = Object.assign({}, process.env);
	delete env.EEAT_JCELL;   // (the flag only by the command line here)
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, env });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
/** the search's numbers that must match: ticks, cells, picks, replays, the first route (ticks and when) and every route's inputs */
const sig = (ev) => {
	const d = doneOf(ev), w = (d.workers || [])[0] || {};
	return JSON.stringify({ ticks: d.ticks, states: d.states, picks: d.picks, replays: w.replays, impr: w.impr, cells: w.cells, rooms: w.rooms, visTiles: d.visTiles, maxCoins: d.maxCoins,
		first: d.first ? [d.first.ticks, d.first.simTicks] : null, routes: routesOf(ev).map((r) => [r.ticks, r.simTicks, r.inputs]) });
};

/** a level from a grid of block ids (9 solid) and extra cells [x, y, id, ...args] */
function levelOf(file, name, w, h, g, extra) {
	const cells = [];
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] === 9) cells.push([x, y, 9]);
	for (const c of extra) { g[c[1]][c[0]] = -1; cells.push(c); }
	fs.writeFileSync(file, ED.eelvlOf({ name, width: w, height: h, cells: cells.filter((c) => c[2] !== 9 || g[c[1]][c[0]] === 9) }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}

// The wall (40 x 24): a floor at row 21, the spawn at (3, 20) on the multijump effect (461, 2 jumps; none in the single
// variant), a wall at x 20 from row `top` down to the floor, the trophy at (30, 20) behind it. A single jump rises about 3
// tiles, a double jump about 6: the wall's top at row 15 (6 tiles above the floor's air row) needs the air jump.
function wall(file, jumps, top = 15) {
	const W = 40, H = 24, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 1; y <= 20; y++) for (let x = 1; x <= 38; x++) g[y][x] = 0;
	for (let y = top; y <= 20; y++) g[y][20] = 9;
	const extra = [[3, 20, 255], [30, 20, 121]];
	if (jumps > 1) extra.push([4, 20, 461, jumps]);
	return levelOf(file, `jcell wall ${jumps}`, W, H, g, extra);
}

function sectionToy() {
	section('toy: a multijump wall, --jcell=0 / 1 (coarse cells)');
	const file = path.join(HOME, 'wall2.eelvl');
	const L = wall(file, 2);
	const T = +(opt.toyTicks || 1500000);
	const base = ['--workers=1', '--seconds=120', `--maxTicks=${T}`, '--mem=300', '--cells=coarse', '--classW=0'];
	const off = gox(GOX, file, [...base, '--seed=1']);
	const on = gox(GOX, file, [...base, '--seed=1', '--jcell=1']);
	const d0 = doneOf(off), d1 = doneOf(on);
	check('the level has 2 jumps after the effect (the sim)', (() => { const s = new E.EESim(L), inp = new E.EEInput(); s.reset(); for (let t = 0; t < 40; t++) { E.applyMask(inp, 4); s.tick(inp); } return s.max_jumps === 2; })());
	check('--jcell=0: no "jcell" in the done event (the search as before)', d0.jcell === undefined && d0.ticks > 0, `${d0.states} cells`);
	const j = d1.jcell || {};
	check('--jcell=1: cells with the air-jumps word', j.cells > 0, JSON.stringify(j));
	check('--jcell=1: later arrivals with a jump in hand kept as their own cells (a cell of the same place with fewer jumps left got there no later)', j.kept > 0, `kept ${j.kept}`);
	check('--jcell=1: arrivals a cell with more jumps left beat dropped (dominated)', j.dominated > 0, `dominated ${j.dominated}`);
	check('--jcell=1: more cells than the flag off at the same budget (the arrivals the earliest-arrival rule merged)', d1.states > d0.states && Math.abs(d1.ticks - d0.ticks) < 0.01 * T, `${d1.states} vs ${d0.states} (ticks ${d1.ticks} vs ${d0.ticks})`);
	for (const [k, ev] of [['off', off], ['on', on]]) {
		const r = routesOf(ev);
		if (!r.length) { check(`${k}: a route in ${T / 1e6} M ticks`, false, `nearest ${JSON.stringify(ev.filter((e) => e.ev === 'closest').slice(-1).map((e) => e.dist))}`); continue; }
		const e2 = C.evaluate(L, masksOf(r[0].inputs));
		check(`${k}: a route (replayed)`, !!e2 && e2.ms.length === r[0].ticks, `first ${r[0].ticks} ticks after ${(r[0].simTicks / 1e6).toFixed(2)} M simulated, best ${r[r.length - 1].ticks}`);
	}
	const again = gox(GOX, file, [...base, '--seed=1', '--jcell=1']);
	check('--jcell=1: the same seed and budget give the same search', sig(again) === sig(on) && JSON.stringify(doneOf(again).jcell) === JSON.stringify(j), `${doneOf(again).picks} / ${d1.picks} picks`);
}

function sectionSingle() {
	section('single: a single-jump wall level, --jcell=1 is a no-op');
	const file = path.join(HOME, 'wall1.eelvl');
	wall(file, 1, 18);
	const base = ['--workers=1', '--seconds=120', '--maxTicks=3000000', '--mem=300', '--cells=coarse', '--classW=0', '--first=1', '--seed=2'];
	const off = gox(GOX, file, base), on = gox(GOX, file, [...base, '--jcell=1']);
	const j = doneOf(on).jcell || {};
	check('no cell with the word, none dominated, none kept', j.cells === 0 && j.dominated === 0 && j.kept === 0, JSON.stringify(j));
	check('the same search as the flag off (cells, picks, replays, routes)', sig(off) === sig(on), `${doneOf(on).states} / ${doneOf(off).states} cells`);
}

function sectionLevels() {
	section('levels: the flag off = main, the flag on a no-op where max_jumps is 1 or 1000+');
	const dir = opt.levels || path.join(__dirname, '..', 'src', 'out', 'god', 'levels', 'campaign');
	if (!fs.existsSync(dir)) { console.log(`  (skipped: no level folder ${dir}; pass --levels=)`); return; }
	const main = opt.main || null;
	if (!main) console.log('  (no --main=: the flag off vs main not checked, only the flag on no-op)');
	const T = +(opt.ticks || 3000000);
	const base = ['--workers=1', '--seconds=300', `--maxTicks=${T}`, '--mem=600', '--classW=0', '--seed=1'];
	const files = fs.readdirSync(dir);
	for (const id of ['04_1', '37_3', '05_2', '26_1', '02_3']) {
		const f = files.find((s) => s.startsWith(id + '_') && s.endsWith('.eelvl'));
		if (!f) { check(`${id}: the level file`, false, 'missing'); continue; }
		const file = path.join(dir, f);
		const off = gox(GOX, file, base, 600000);
		const d = doneOf(off);
		if (main) {
			const m = gox(main, file, base, 600000);
			check(`${id}: the flag off = main (ticks, cells, picks, replays, routes)`, sig(off) === sig(m) && d.ticks > 0, `${d.states} cells, ${d.picks} picks, ${routesOf(off).length} routes`);
		}
		if (id === '04_1' || id === '37_3') {
			const on = gox(GOX, file, [...base, '--jcell=1'], 600000);
			const j = doneOf(on).jcell || {};
			check(`${id}: --jcell=1 a no-op (max_jumps 1 or 1000+: no cell with the word, the same search)`, j.cells === 0 && sig(on) === sig(off), `${JSON.stringify(j)}, ${doneOf(on).states} / ${d.states} cells`);
		}
	}
}

if (want('toy')) sectionToy();
if (want('single')) sectionSingle();
if (want('levels')) sectionLevels();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
