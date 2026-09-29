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
function gox(tool, file, args, timeoutMs = 240000, nodeArgs = []) {
	const env = Object.assign({}, process.env);
	delete env.EEAT_JCELL;   // (the flag only by the command line here)
	const r = spawnSync(process.execPath, [...nodeArgs, tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, env });
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

// The switches level (test/editor.js's archive-sweep level: 60 x 50, 10 purple switches on the floor, each read by a door of
// its own in the top row, a wall of switch-1 doors, the trophy walled in: no route, --prune=0; 1,024 switch states): a
// single-jump level, so --jcell=1 makes no cell with the word and the search is the flag off's, but every cell carries its
// `jw` (3): the budget must count it (B_JW a cell, goexplore.js archiveBytes), and the heap holds it.
function switchesLevel(file) {
	const W = 60, H = 50, c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
	for (let k = 0; k < 10; k++) c.push([4 + 2 * k, 48, 113, k + 1], [4 + 2 * k, 1, 184, k + 1]);
	for (let y = 1; y < 49; y++) c.push([45, y, 184, 1]);
	c.push([2, 48, 255], [55, 47, 121], [54, 47, 9], [56, 47, 9]);
	for (let x = 54; x <= 56; x++) c.push([x, 46, 9], [x, 48, 9]);
	fs.writeFileSync(file, ED.eelvlOf({ name: 'jcell switches', width: W, height: H, cells: c }));
}

function sectionMem() {
	section('mem: the budget counts every cell\'s jw with the flag on (B_JW), the --mem cap holds; the flag off counts none');
	const GX = require(GOX);
	const MB = 1048576;
	check('B_JW is 40 bytes (a new out-of-object property array: 16 bytes of header + 3 slots, the most one more property costs a cell)', GX.B_JW === 40, `B_JW ${GX.B_JW}`);
	const file = path.join(HOME, 'switches.eelvl');
	switchesLevel(file);
	const T = +(opt.memTicks || 6000000);
	const base = ['--workers=1', '--seed=1', '--prune=0', '--cells=coarse', '--classW=0', '--seconds=120', `--maxTicks=${T}`];
	const gc = ['--expose-gc'];   // (the done event's heapMB after a collection: goexplore.js explore()'s end)
	// (1) room for everything (--mem=600): the same search either way; the counted archive grows by exactly B_JW a cell
	const off = gox(GOX, file, [...base, '--mem=600'], 300000, gc), on = gox(GOX, file, [...base, '--mem=600', '--jcell=1'], 300000, gc);
	const d0 = doneOf(off), d1 = doneOf(on), w0 = (d0.workers || [])[0] || {}, w1 = (d1.workers || [])[0] || {}, j = d1.jcell || {};
	check('the flag off: no "jcell" in the done event', d0.jcell === undefined && d0.ticks > 0);
	check('--jcell=1 on a single-jump level: no cell with the word, the same search (cells, picks, replays, rooms)', j.cells === 0 && sig(on) === sig(off) && !w0.full && !w1.full,
		`${d1.states} / ${d0.states} cells, ${w1.rooms} rooms`);
	check('the cells the budget counts a jw for: every cell, B_JW each (jcell.bytes = cells x B_JW)', j.bytes === d1.states * GX.B_JW && d1.states > 50000,
		`${j.bytes} bytes for ${d1.states} cells (${(j.bytes / MB).toFixed(2)} MB)`);
	const dm = w1.memMB - w0.memMB, want = j.bytes / MB;
	check('the counted archive (memMB) grows by the jw bytes (within the MB rounding)', Math.abs(dm - want) <= 1 && dm >= 1, `${w1.memMB} vs ${w0.memMB} MB: +${dm}, jw ${want.toFixed(2)} MB`);
	const dh = w1.heapMB - w0.heapMB;
	check('the heap after a collection grows by about that too (the count is the property\'s real cost here: no timed killer, no frontier field)', dh >= 0.5 * want - 1 && dh <= want + 1.5,
		`heap ${w1.heapMB} vs ${w0.heapMB} MB: +${dh}, counted +${want.toFixed(2)}`);
	// (2) the cap (--mem=24, as test/editor.js): with the flag on the archive's count, jw included, stays within the budget
	// and the heap within it + 10 MB; it sweeps; at the same total it holds fewer cells
	const cap = ['--mem=24'];
	const offC = gox(GOX, file, [...base, ...cap], 300000, gc), onC = gox(GOX, file, [...base, ...cap, '--jcell=1'], 300000, gc);
	const c0 = (doneOf(offC).workers || [])[0] || {}, c1 = (doneOf(onC).workers || [])[0] || {}, jc = doneOf(onC).jcell || {};
	const warn = (ev) => ev.some((e) => e.ev === 'warning');
	check('--mem=24 with the flag on: full, sweeps, counted within the budget (jw included), the heap within it + 10 MB, no warning',
		c1.full && c1.sweeps > 0 && c1.memMB <= 24 && c1.heapMB <= 34 && jc.bytes === c1.cells * GX.B_JW && !warn(onC),
		`${c1.cells} cells, ${c1.sweeps} sweeps (${c1.evicted} cells), counted ${c1.memMB} MB (jw ${(jc.bytes / MB).toFixed(2)}), heap ${c1.heapMB} MB`);
	check('--mem=24 with the flag off: the same budget holds as before', c0.full && c0.sweeps > 0 && c0.memMB <= 24 && c0.heapMB <= 34 && !warn(offC),
		`${c0.cells} cells, ${c0.sweeps} sweeps (${c0.evicted} cells), counted ${c0.memMB} MB, heap ${c0.heapMB} MB`);
	check('at the cap both arms count about the same total (the eviction sees the jw bytes: it evicts at the same total, not the same cell count)',
		Math.abs(c1.memMB - c0.memMB) <= 2, `${c1.memMB} vs ${c0.memMB} MB; cells ${c1.cells} vs ${c0.cells}, evicted ${c1.evicted} vs ${c0.evicted}`);
	// (3) with --main: the flag off at the cap = main's search (the budget's count, so every sweep, as before)
	if (opt.main) {
		const m = gox(opt.main, file, [...base, ...cap], 300000, gc), cm = (doneOf(m).workers || [])[0] || {};
		const at = (w) => JSON.stringify([w.cells, w.sweeps, w.evicted, w.snaps, w.dropped, w.memMB]);
		check('--mem=24 with the flag off = main (the same search, cells, sweeps, evictions, snapshots and counted MB)', sig(offC) === sig(m) && at(c0) === at(cm),
			`${at(c0)} vs main ${at(cm)}`);
	}
}

if (want('toy')) sectionToy();
if (want('single')) sectionSingle();
if (want('mem')) sectionMem();
if (want('levels')) sectionLevels();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
