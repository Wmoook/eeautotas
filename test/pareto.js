'use strict';
// test/pareto.js - goexplore.js --pareto=1, the Pareto head (head P: the rooms on the non-dominated front of useful
// resources held vs the room's order cost; OPT-IN, default off):
//   units    paretoFront / paretoRooms on synthetic rooms (a dominated room, ties of vector and cost kept, key colours as
//            sets (incomparable colours both on the front), rooms with no live cells or no resources left out, the
//            cheapest room left to head A); paretoOf on levels (a coin door's threshold, a coin gate does not raise it,
//            key doors / gates read, a level with none: null)
//   toy      src/goexplore.js on a coin-door toy (the trophy by the spawn behind an N-coin door, the N coins far AWAY
//            from it, down a stepped corridor: the door-blind reach field pins head A at the door): the flag off = no
//            head P and no "pareto" numbers; --pareto=1: head P picks, its front, the most useful gold; routes replayed;
//            the same seed and budget = the same search; the ticks to the first room holding N coins and to the first
//            route, --pareto=1 vs 0 over seeds 1-3 (printed: a measurement, not a pass / fail); --pCell=1 (head P's cell
//            by head B's count weights): picks, a route replayed, deterministic; --pCell=0 = the flag as first built
//   noop     a level without a coin door or key door (05_2 On And On And On, when the campaign folder is there, and the
//            toy with its door removed): --pareto=1 = the flag off, the same search (no draw more)
//   levels   (with --main=<main's src/goexplore.js>) 1 worker + a tick budget: the flag off = main (ticks, cells, picks,
//            replays, route inputs) on 04_1, 37_3, 05_2, 26_1, 28_3 (the test/jcell.js --main pattern)
// usage: node test/pareto.js [--only=units,toy,noop,levels] [--levels=<campaign dir>] [--main=<main's src/goexplore.js>]
//        [--ticks=3000000] [--toyTicks=40000000] [--seeds=1,2,3]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-pareto-'));
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
	delete env.EEAT_PARETO;   // (the flag only by the command line here)
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

// The coin toy (220 x 12 = 2,640 tiles: coarse cells): a corridor (rows 5-8), the spawn at (110, 8), the trophy at (212, 8)
// behind an N-coin door (205, 5-8); the N coins far to the LEFT, away from the trophy (x 70, 58, 46, ... on the floor), and
// a 1-tile step every 8 tiles on the corridor floor. The door-blind reach field puts the start 102 tiles from the trophy
// and every coin farther: head A pushes at the door, the coins are a backtrack. door: false = no door (no resource).
function coinToy(file, N, door = true) {
	const W = 220, H = 12, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 218; x++) g[y][x] = 0;
	for (let x = 14; x < 200; x += 8) if (x !== 110 && x !== 102) g[8][x] = 9;
	const extra = [[110, 7, 255], [212, 8, 121]];
	for (let k = 0; k < N; k++) extra.push([71 - 12 * k, 7, 100]);
	if (door) for (let y = 5; y <= 8; y++) extra.push([205, y, 43, N]);
	return levelOf(file, `pareto coin toy ${N}`, W, H, g, extra);
}

function sectionUnits() {
	section('units: the front, the rooms, the resources');
	const F = (items) => GX.paretoFront(items).map((it) => it.id).sort().join(',');
	// a (0 coins, cost 10), b (2, 30), c (1, 40: b dominates it), d (2, 30: a tie with b), e (0 coins, key 1, cost 50),
	// f (0 coins, key 2, cost 50: incomparable with e), g (0, 10: a tie with a), h (0 coins, cost 12: a dominates it)
	const items = [
		{ id: 'a', g: 0, b: 0, k: 0, cost: 10 }, { id: 'b', g: 2, b: 0, k: 0, cost: 30 }, { id: 'c', g: 1, b: 0, k: 0, cost: 40 },
		{ id: 'd', g: 2, b: 0, k: 0, cost: 30 }, { id: 'e', g: 0, b: 0, k: 1, cost: 50 }, { id: 'f', g: 0, b: 0, k: 2, cost: 50 },
		{ id: 'g', g: 0, b: 0, k: 0, cost: 10 }, { id: 'h', g: 0, b: 0, k: 0, cost: 12 }];
	check('the front: dominated rooms out, ties of vector and cost both kept, incomparable key colours both kept', F(items) === 'a,b,d,e,f,g', F(items));
	check('a room with more of everything and no higher cost dominates', F([{ id: 'x', g: 3, b: 1, k: 3, cost: 5 }, { id: 'y', g: 2, b: 1, k: 1, cost: 9 }, { id: 'z', g: 3, b: 1, k: 3, cost: 5 }]) === 'x,z');
	check('keys as sets: {red, green} dominates {red} at the same cost, not {blue}', F([{ id: 'rg', g: 0, b: 0, k: 3, cost: 7 }, { id: 'r', g: 0, b: 0, k: 1, cost: 7 }, { id: 'bl', g: 0, b: 0, k: 4, cost: 7 }]) === 'bl,rg');
	check('blue coins count like gold', F([{ id: 'p', g: 1, b: 0, k: 0, cost: 5 }, { id: 'q', g: 1, b: 2, k: 0, cost: 6 }, { id: 's', g: 0, b: 2, k: 0, cost: 9 }]) === 'p,q');
	check('an empty front', GX.paretoFront([]).length === 0);
	// paretoRooms: rooms {pr, live, cost}; no resources (pr undefined) and no live cells left out; the cheapest to head A
	const R = (id, pr, cost, live = true) => ({ id, pr, cost, live });
	const rooms = [R('r0', [0, 0, 0], 10), R('r1', [3, 0, 0], 40), R('r2', [1, 0, 0], 50), R('dead', [5, 0, 0], 20, false), R('nores', undefined, 1), R('r3', [3, 0, 0], 40)];
	const pr = GX.paretoRooms(rooms, (r) => r.live, (r) => r.cost);
	check('paretoRooms: the front over the live rooms with resources (no-cell and no-resource rooms left out)', pr.front === 3 && pr.list.map((r) => r.id).sort().join(',') === 'r1,r3', `front ${pr.front}, list ${pr.list.map((r) => r.id)}`);
	check('paretoRooms: the cheapest room (head A\'s) is not in head P\'s list', !pr.list.some((r) => r.id === 'r0'));
	const one = GX.paretoRooms([R('only', [2, 0, 0], 5)], () => true, (r) => r.cost);
	check('paretoRooms: a front of one room (the cheapest): head P has no room (head A picks)', one.front === 1 && one.list.length === 0);
	const tie = GX.paretoRooms([R('t1', [0, 0, 0], 5), R('t2', [2, 0, 0], 5)], () => true, (r) => r.cost);
	check('paretoRooms: rooms at the cheapest cost are all head A\'s', tie.list.length === 0 && tie.front === 1, `front ${tie.front}`);
	check('paretoRooms: no rooms with resources', GX.paretoRooms([R('n', undefined, 3)], () => true, (r) => r.cost).front === 0);
	// paretoOf: the toy's door, a gate that does not raise the useful count, keys, none
	const L = coinToy(path.join(HOME, 'toy_units.eelvl'), 4);
	const P = GX.paretoOf(L);
	check('paretoOf: the coin door\'s threshold is the useful gold', P && P.gMax === 4 && P.bMax === 0 && P.keys === 0, P && JSON.stringify({ g: P.gMax, b: P.bMax, k: P.keys }));
	const sim = new E.EESim(L); sim.reset();
	sim.coins = 9; sim.blue_coins = 2; sim._keysMask = 5;
	check('paretoOf.of: gold capped at the door, unread blue and keys 0', JSON.stringify(P.of(sim)) === '[4,0,0]', JSON.stringify(P.of(sim)));
	// a coin gate of 9 and a blue door of 3, key doors / gates red (23) and cyan gate (1008)
	const W = 60, H = 50, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) g[y][x] = 0;
	const L2 = levelOf(path.join(HOME, 'gates.eelvl'), 'pareto gates', W, H, g, [[2, 47, 255], [55, 47, 121], [30, 47, 165, 9], [31, 47, 43, 2], [32, 47, 213, 3], [33, 47, 23], [34, 47, 1008]]);
	const P2 = GX.paretoOf(L2);
	check('paretoOf: a coin gate does not raise the useful gold (door 2, gate 9: 2), blue door 3, keys red + cyan', P2 && P2.gMax === 2 && P2.bMax === 3 && P2.keys === (1 | 8), P2 && JSON.stringify({ g: P2.gMax, b: P2.bMax, k: P2.keys }));
	const s2 = new E.EESim(L2); s2.reset();
	s2.coins = 7; s2.blue_coins = 1; s2._keysMask = 1 | 2 | 8;
	check('paretoOf.of: [min(coins, 2), min(blue, 3), keys read]', JSON.stringify(P2.of(s2)) === '[2,1,9]', JSON.stringify(P2.of(s2)));
	const L3 = coinToy(path.join(HOME, 'toy_nodoor.eelvl'), 3, false);
	check('paretoOf: a level with no coin door and no key door or gate: null (no head P)', GX.paretoOf(L3) === null);
}

function sectionToy() {
	section('toy: coins away from the trophy, --pareto=0 / 1 (coarse cells, 1 worker)');
	const N = +(opt.N || 4);
	const file = path.join(HOME, 'cointoy.eelvl');
	const L = coinToy(file, N);
	check('coarse cells', GX.cellsFor(L) === 'coarse');
	const T = +(opt.toyTicks || 40000000);
	const seeds = String(opt.seeds || '1,2,3').split(',').map(Number);
	const base = ['--workers=1', '--seconds=240', `--maxTicks=${T}`, '--mem=400', '--first=1', '--classW=0', '--rooms=1'];
	const rows = [];
	const nOf = (ev) => {
		// the worker's ticks when the first room holding N coins was registered (the one search's room events: wt)
		const r = ev.find((e) => e.ev === 'room' && new RegExp(`(^| )coins(=|>=)${N}( |$)`).test(e.desc || ''));
		return r ? (r.wt !== undefined ? r.wt : null) : null;
	};
	for (const seed of seeds) {
		const off = gox(GOX, file, [...base, `--seed=${seed}`]);
		const on = gox(GOX, file, [...base, `--seed=${seed}`, '--pareto=1']);
		const d0 = doneOf(off), d1 = doneOf(on), r0 = routesOf(off), r1 = routesOf(on);
		rows.push({ seed, n0: nOf(off), n1: nOf(on), f0: r0.length ? r0[0].simTicks : null, f1: r1.length ? r1[0].simTicks : null, p1: d1.pareto });
		if (seed === seeds[0]) {
			check('--pareto=0: no "pareto" numbers (the search as before)', d0.pareto === undefined && d0.ticks > 0, `${d0.states} cells`);
			check('--pareto=1: head P picks, a front, the useful gold held', d1.pareto && d1.pareto.picks > 0 && d1.pareto.front > 0 && d1.pareto.gold > 0, JSON.stringify(d1.pareto));
		}
		for (const [k, r] of [['off', r0], ['on', r1]]) {
			if (!r.length) { console.log(`  (seed ${seed} ${k}: no route in ${T / 1e6} M ticks)`); continue; }
			const ev = C.evaluate(L, masksOf(r[0].inputs));
			check(`seed ${seed} ${k}: the route replays`, !!ev && ev.ms.length === r[0].ticks, `${r[0].ticks} ticks after ${(r[0].simTicks / 1e6).toFixed(2)} M simulated`);
		}
	}
	const again = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--pareto=1']);
	const on0 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--pareto=1']);
	check('--pareto=1: the same seed and budget give the same search', sig(again) === sig(on0) && JSON.stringify(doneOf(again).pareto) === JSON.stringify(doneOf(on0).pareto), `${doneOf(again).picks} / ${doneOf(on0).picks} picks`);
	// --pCell=1 (head P's cell of its room by head B's count weights): head P picks, a route (replayed), deterministic
	const c1 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--pareto=1', '--pCell=1']), c2 = gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--pareto=1', '--pCell=1']);
	const rc = routesOf(c1), dc = doneOf(c1);
	check('--pareto=1 --pCell=1: head P picks, a route (replayed), the same search again', dc.pareto && dc.pareto.picks > 0 && rc.length > 0 && !!C.evaluate(L, masksOf(rc[0].inputs)) && sig(c1) === sig(c2),
		rc.length ? `${rc[0].ticks} ticks after ${(rc[0].simTicks / 1e6).toFixed(2)} M simulated, ${JSON.stringify(dc.pareto)}` : 'no route');
	// --pCell=0 is the first version's search (the option only chooses the cell)
	check('--pCell=0 = the flag as first built', sig(gox(GOX, file, [...base, `--seed=${seeds[0]}`, '--pareto=1', '--pCell=0'])) === sig(on0));
	const m = (x) => (x == null ? 'none' : `${(x / 1e6).toFixed(2)} M`);
	console.log(`  (the worker's simulated ticks to the first room with ${N} coins, off / on: ${rows.map((r) => `seed ${r.seed} ${m(r.n0)} / ${m(r.n1)}`).join(', ')})`);
	console.log(`  (the simulated ticks to the first route, off / on: ${rows.map((r) => `seed ${r.seed} ${m(r.f0)} / ${m(r.f1)}`).join(', ')})`);
	console.log(`  (head P: ${rows.map((r) => `seed ${r.seed} ${JSON.stringify(r.p1)}`).join(', ')})`);
	check('--pareto=1 routed on every seed the flag off routed', rows.every((r) => r.f0 == null || r.f1 != null), rows.map((r) => `${m(r.f0)} / ${m(r.f1)}`).join(', '));
}

function sectionNoop() {
	section('noop: a level without a coin door or key door, --pareto=1 = the flag off');
	const file = path.join(HOME, 'toy_nodoor.eelvl');
	coinToy(file, 3, false);
	const base = ['--workers=1', '--seconds=120', '--maxTicks=3000000', '--mem=300', '--classW=0', '--seed=1', '--cells=coarse'];
	const off = gox(GOX, file, base), on = gox(GOX, file, [...base, '--pareto=1']);
	check('the toy without its door: the same search (no draw more), no "pareto" numbers', sig(off) === sig(on) && doneOf(on).pareto && doneOf(on).pareto.picks === 0, `${doneOf(on).states} / ${doneOf(off).states} cells, ${JSON.stringify(doneOf(on).pareto)}`);
	const dir = opt.levels || path.join(__dirname, '..', 'src', 'out', 'god', 'levels', 'campaign');
	const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((s) => s.startsWith('05_2_') && s.endsWith('.eelvl')) : null;
	if (!f) { console.log(`  (05_2 skipped: no level folder ${dir}; pass --levels=)`); return; }
	const b2 = ['--workers=1', '--seconds=300', `--maxTicks=${+(opt.ticks || 3000000)}`, '--mem=600', '--classW=0', '--seed=1'];
	const o2 = gox(GOX, path.join(dir, f), b2), n2 = gox(GOX, path.join(dir, f), [...b2, '--pareto=1']);
	check('05_2 (no coin door, no key door): --pareto=1 the same search', sig(o2) === sig(n2) && doneOf(o2).ticks > 0, `${doneOf(n2).states} / ${doneOf(o2).states} cells`);
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
	}
}

if (want('units')) sectionUnits();
if (want('noop')) sectionNoop();
if (want('toy')) sectionToy();
if (want('levels')) sectionLevels();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
