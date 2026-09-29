'use strict';
// test/tedge.js - goexplore.js --tedge=1, the subgoal head (head T: a UCB over the rooms' subtree rewards among the rooms
// with an untried relevant trigger, a walk field to the room's untried triggers nearest its entry, the room's cells
// nearest them; OPT-IN, default off):
//   units    roomUseful's target list (want: the target tiles with their walk steps from the entry; no trophy; a coin taken
//            no target; without want none); goexplore's teField is exercised through the searches
//   toys     src/goexplore.js on toy A (the pareto coin toy: the trophy by the spawn behind a 4-coin door, the 4 coins far
//            BEHIND the spawn down a stepped corridor) and toy B (a 3-switch chain behind the spawn: switch 1 opens the
//            door to switch 2, which opens the door to switch 3, which opens the trophy's door): the flag off = no head T
//            and no "tedge" numbers; --tedge=1: head T picks, builds, fetches triggers; routes replayed; the same seed and
//            budget = the same search; 1 worker, no steer, seeds 1-8: the first route in simulated ticks, off vs on
//            (printed: a measurement), and the flag on routes on every seed the flag off routes
//   noop     the toy with no door (no trigger any door reads): --tedge=1 runs, no room holds a target, no head-T pick;
//            --tedge=1 --useful=0 = --useful=0 (head T needs the useful territory's targets; in the toys section)
//   levels   (with --main=<main's src/goexplore.js>) 1 worker + a tick budget: the flag off = main (ticks, cells, picks,
//            replays, rooms, routes) on 04_1, 37_3, 05_2, 26_1, 28_3 (pareto's --main compare)
// usage: node test/tedge.js [--only=units,toys,noop,levels] [--levels=<campaign dir>] [--main=<main's src/goexplore.js>]
//        [--ticks=3000000] [--toyTicks=20000000] [--seeds=1,2,3,4,5,6,7,8]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-tedge-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
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
function gox(tool, file, args, timeoutMs = 300000) {
	const env = Object.assign({}, process.env);
	delete env.EEAT_TEDGE; delete env.EEAT_PARETO;   // (the flags only by the command line here)
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, env });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
/** head T's numbers but its build time */
const teSig = (ev) => { const t = Object.assign({}, doneOf(ev).tedge || {}); delete t.ms; return JSON.stringify(t); };
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
/** the corridor of both toys (220 x 12 = 2,640 tiles: coarse cells): rows 5-8, a 1-tile step every 8 tiles on its floor,
 *  the spawn at (110, 8), the trophy at (212, 8) */
function corridor() {
	const W = 220, H = 12, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 218; x++) g[y][x] = 0;
	for (let x = 14; x < 200; x += 8) if (x !== 110 && x !== 102) g[8][x] = 9;
	return { W, H, g };
}
// Toy A (the pareto coin toy): the trophy behind an N-coin door (205, 5-8), the N coins far to the LEFT (x 71, 59, 47, ...).
// door: false = no door (no trigger any door reads)
function toyA(file, N = 4, door = true) {
	const { W, H, g } = corridor();
	const extra = [[110, 7, 255], [212, 8, 121]];
	for (let k = 0; k < N; k++) extra.push([71 - 12 * k, 7, 100]);
	if (door) for (let y = 5; y <= 8; y++) extra.push([205, y, 43, N]);
	return levelOf(file, `tedge toy A ${N}`, W, H, g, extra);
}
// Toy B: a 3-switch chain behind the spawn: purple switch 1 at (70, 8), its door (60, 5-8); switch 2 at (45, 8), its door
// (35, 5-8); switch 3 at (20, 8), its door (205, 5-8) before the trophy
function toyB(file) {
	const { W, H, g } = corridor();
	const extra = [[110, 7, 255], [212, 8, 121], [70, 7, 113, 1], [45, 7, 113, 2], [20, 7, 113, 3]];
	for (let y = 5; y <= 8; y++) extra.push([60, y, 184, 1], [35, y, 184, 2], [205, y, 184, 3]);
	return levelOf(file, 'tedge toy B', W, H, g, extra);
}

function sectionUnits() {
	section('units: roomUseful\'s target list');
	const L = toyA(path.join(HOME, 'toyA_units.eelvl'), 4);
	const U = GX.roomUseful(L);
	const sim = new E.EESim(L); sim.reset();
	const x0 = sim.px, y0 = sim.py;
	const r0 = U.of(sim, true);
	check('without want: no target list', r0.tl === null && r0.targets === 4, `targets ${r0.targets} (the 4 coins; the trophy behind its shut door)`);
	const r1 = U.of(sim, true, undefined, true);
	const tiles = [];
	for (let k = 0; k < r1.tl.length; k += 2) tiles.push([r1.tl[k] % L.width, (r1.tl[k] / L.width) | 0, r1.tl[k + 1]]);
	check('want: the 4 coins (no trophy), each with its walk steps from the entry', tiles.length === 4 && tiles.every(([x, y]) => y === 7 && [71, 59, 47, 35].includes(x)), JSON.stringify(tiles));
	check('want: the steps grow with the distance from the spawn', tiles.slice().sort((p, q) => q[0] - p[0]).every((t, i, s) => i === 0 || t[2] > s[i - 1][2]), JSON.stringify(tiles.map((t) => t[2])));
	check('the live state is restored after the targets\' tests', sim.px === x0 && sim.py === y0 && sim.coins === 0);
	check('want from the start: no secondary coins (none held)', r1.tl2 && r1.tl2.length === 0);
	// the ball takes coin 1 (71, 7): a state of the room "coins=1" that holds it; coin 1 is its secondary target (another
	// lineage in the same room may hold another coin), coins 2-4 its targets
	const s1 = new E.EESim(L); s1.reset();
	s1.px = 71 * 16; s1.py = 7 * 16; s1.speed_x = 0; s1.speed_y = 0;
	for (let k = 0; k < 3 && s1.coins === 0; k++) s1.tick(new E.EEInput());
	const r2 = U.of(s1, true, undefined, true);
	const t2 = [], t1 = [];
	for (let k = 0; k < r2.tl.length; k += 2) t1.push(r2.tl[k] % L.width);
	for (let k = 0; k < r2.tl2.length; k += 2) t2.push(r2.tl2[k] % L.width);
	check('with coin 1 held: coins 2-4 the targets, coin 1 the secondary one', s1.coins === 1 && t1.sort().join(',') === '35,47,59' && t2.join(',') === '71', `coins ${s1.coins}, targets x ${t1}, secondary x ${t2}`);
	const LB = toyB(path.join(HOME, 'toyB_units.eelvl'));
	const UB = GX.roomUseful(LB), sB = new E.EESim(LB); sB.reset();
	const rb = UB.of(sB, true, undefined, true);
	const tb = [];
	for (let k = 0; k < rb.tl.length; k += 2) tb.push([rb.tl[k] % LB.width, (rb.tl[k] / LB.width) | 0]);
	check('toy B from the start: switch 1 is the only target (the doors of 1 and 2 shut)', tb.length === 1 && tb[0][0] === 70 && tb[0][1] === 7, JSON.stringify(tb));
}

function sectionToys() {
	const T = +(opt.toyTicks || 20000000);
	const seeds = String(opt.seeds || '1,2,3,4,5,6,7,8').split(',').map(Number);
	const base = ['--workers=1', '--seconds=240', `--maxTicks=${T}`, '--mem=400', '--first=1', '--classW=0'];
	for (const [name, mk] of [['A (4 coins behind the spawn, a 4-coin door)', (f) => toyA(f, 4)], ['B (a 3-switch chain behind the spawn)', (f) => toyB(f)]]) {
		section(`toy ${name}: --tedge=0 / 1 (coarse cells, 1 worker, no steer)`);
		const file = path.join(HOME, `toy_${name[0]}.eelvl`);
		const L = mk(file);
		check('coarse cells', GX.cellsFor(L) === 'coarse');
		const rows = [];
		for (const seed of seeds) {
			const off = gox(GOX, file, [...base, `--seed=${seed}`]);
			const on = gox(GOX, file, [...base, `--seed=${seed}`, '--tedge=1']);
			const d0 = doneOf(off), d1 = doneOf(on), r0 = routesOf(off), r1 = routesOf(on);
			rows.push({ seed, f0: r0.length ? r0[0].simTicks : null, f1: r1.length ? r1[0].simTicks : null, t1: d1.tedge });
			if (seed === seeds[0]) {
				check('--tedge=0: no "tedge" numbers (the search as before)', d0.tedge === undefined && d0.ticks > 0, `${d0.states} cells`);
				check('--tedge=1: head T picks, field builds, triggers fetched', d1.tedge && d1.tedge.picks > 0 && d1.tedge.builds > 0 && d1.tedge.fetched > 0, JSON.stringify(d1.tedge));
			}
			for (const [k, r] of [['off', r0], ['on', r1]]) {
				if (!r.length) { console.log(`  (seed ${seed} ${k}: no route in ${T / 1e6} M ticks)`); continue; }
				const ev = C.evaluate(L, masksOf(r[0].inputs));
				check(`seed ${seed} ${k}: the route replays`, !!ev && ev.ms.length === r[0].ticks, `${r[0].ticks} ticks after ${(r[0].simTicks / 1e6).toFixed(2)} M simulated`);
			}
		}
		const again = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--tedge=1']), again2 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--tedge=1']);
		check('--tedge=1: the same seed and budget give the same search', sig(again) === sig(again2) && teSig(again) === teSig(again2), `${doneOf(again).picks} / ${doneOf(again2).picks} picks`);
		const env1 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--tedge=1', '--useful=0']), off1 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--useful=0']);
		check('--tedge=1 --useful=0 = --useful=0 (head T needs the useful territory\'s targets)', sig(env1) === sig(off1) && doneOf(env1).tedge === undefined);
		const m = (x) => (x == null ? 'none' : `${(x / 1e6).toFixed(2)} M`);
		const med = (a) => { const v = a.filter((x) => x != null).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : null; };
		console.log(`  (the simulated ticks to the first route, off / on: ${rows.map((r) => `s${r.seed} ${m(r.f0)} / ${m(r.f1)}`).join(', ')})`);
		console.log(`  (median off ${m(med(rows.map((r) => r.f0)))} (${rows.filter((r) => r.f0 != null).length} routed), on ${m(med(rows.map((r) => r.f1)))} (${rows.filter((r) => r.f1 != null).length} routed); on faster in ${rows.filter((r) => r.f1 != null && (r.f0 == null || r.f1 < r.f0)).length} of ${rows.length})`);
		console.log(`  (head T: ${rows.map((r) => `s${r.seed} ${r.t1 ? `${r.t1.picks} picks ${r.t1.builds} builds ${r.t1.fetched} fetched` : '-'}`).join(', ')})`);
		check('--tedge=1 routed on every seed the flag off routed', rows.every((r) => r.f0 == null || r.f1 != null), rows.map((r) => `${m(r.f0)} / ${m(r.f1)}`).join(', '));
	}
}

function sectionNoop() {
	section('noop: a level with no trigger any door reads');
	const file = path.join(HOME, 'toy_nodoor.eelvl');
	toyA(file, 3, false);
	const base = ['--workers=1', '--seconds=120', '--maxTicks=3000000', '--mem=300', '--classW=0', '--seed=1', '--cells=coarse'];
	const on = gox(GOX, file, [...base, '--tedge=1']), d = doneOf(on);
	check('--tedge=1: no head-T pick (no room holds a target), the search runs', d.ticks > 0 && d.tedge && d.tedge.picks === 0 && d.tedge.rooms === 0, JSON.stringify(d.tedge));
}

function sectionLevels() {
	section('levels: the flag off = main');
	const dir = opt.levels || path.join(__dirname, '..', 'src', 'out', 'god', 'levels', 'campaign');
	if (!fs.existsSync(dir)) { console.log(`  (skipped: no level folder ${dir}; pass --levels=)`); return; }
	const main = opt.main || null;
	if (!main) { console.log('  (skipped: no --main=<main\'s src/goexplore.js>)'); return; }
	const T = +(opt.ticks || 3000000);
	const base = ['--workers=1', '--seconds=300', `--maxTicks=${T}`, '--mem=600', '--classW=0', '--seed=1'];
	const files = fs.readdirSync(dir);
	for (const id of ['04_1', '37_3', '05_2', '26_1', '28_3']) {
		const f = files.find((s) => s.startsWith(id + '_') && s.endsWith('.eelvl'));
		if (!f) { check(`${id}: the level file`, false, 'missing'); continue; }
		const file = path.join(dir, f);
		const off = gox(GOX, file, base, 600000), m = gox(main, file, base, 600000);
		const d = doneOf(off);
		check(`${id}: the flag off = main (ticks, cells, picks, replays, rooms, routes)`, sig(off) === sig(m) && d.ticks > 0, `${d.states} cells, ${d.picks} picks, ${routesOf(off).length} routes, done ${d.seconds} s`);
		if (opt.on) {
			const on = gox(GOX, file, [...base, '--tedge=1'], 600000), d1 = doneOf(on);
			console.log(`    (--tedge=1: ${d1.states} cells, ${d1.picks} picks, ${routesOf(on).length} routes, ${JSON.stringify(d1.tedge)})`);
		}
	}
}

if (want('units')) sectionUnits();
if (want('noop')) sectionNoop();
if (want('toys')) sectionToys();
if (want('levels')) sectionLevels();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
