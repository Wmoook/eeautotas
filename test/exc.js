'use strict';
// test/exc.js - goexplore.js --exc=1 (THE EXCURSION HEAD X, EXC_BANDS; OPT-IN, default off) and tools/excdata.js:
//   units    the running minimum along a toy lineage with a room change (excRm: the reset), the bands (excBand), the
//            deficit band order (excOrder), --excBands parsing (excBandsOf); excdata's band math on a numeric fixture
//            (profileOf: the running minimum reset at every room change, sharesOf, meanOf, gapList) and its tar reader
//   toy      the false near (400 x 12, coarse cells: the trophy behind a 1-coin door by the spawn, the coin 384 tiles
//            uphill by the door-blind reach field): --exc=0 has no "exc" in its done event; --exc=1 picks by head X in
//            the uphill bands, counts rm in the budget (bytes = cells x B_EX), routes (replayed), and the same seed and
//            budget give the same search
//   levels   (with --levels=<the campaign folder>, --main=<main's src/goexplore.js>) 1 worker + a tick budget: the flag
//            off = main on 04_1, 37_3, 05_2, 26_1, 33_3 (ticks, cells, picks, replays, rooms, route inputs)
// usage: node test/exc.js [--only=units,toy,levels] [--levels=<dir>] [--main=<main's goexplore.js>] [--ticks=3000000]
//        Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-exc-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const XD = require('../tools/excdata.js');
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
	delete env.EEAT_EXC;   // (the flag only by the command line here)
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, env });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
/** the search's numbers that must match: ticks, cells, picks, replays, rooms, the first route and every route's inputs */
const sig = (ev) => {
	const d = doneOf(ev), w = (d.workers || [])[0] || {};
	return JSON.stringify({ ticks: d.ticks, states: d.states, picks: d.picks, replays: w.replays, impr: w.impr, cells: w.cells, rooms: w.rooms, visTiles: d.visTiles, maxCoins: d.maxCoins,
		first: d.first ? [d.first.ticks, d.first.simTicks] : null, routes: routesOf(ev).map((r) => [r.ticks, r.simTicks, r.inputs]) });
};
const near = (x, y) => Math.abs(x - y) < 1e-9;

function sectionUnits() {
	section('units: the running minimum, the bands, the deficit order, excdata\'s band math');
	// (1) a toy lineage: rc 10, 8, 12, 30 in room A, then a room change (room B) at 25, 40, 20, 60
	const seq = [[10, 'A'], [8, 'A'], [12, 'A'], [30, 'A'], [25, 'B'], [40, 'B'], [20, 'B'], [60, 'B']];
	let rm = null, room = null;
	const got = [];
	for (const [rc, r] of seq) { rm = GX.excRm(rm === null ? 0 : rm, rc, rm !== null && r === room); room = r; got.push([rm / 5, rc - rm / 5]); }
	check('rm along the lineage: 10, 8, 8, 8 in room A; reset to 25 at the room change; 25, 20, 20 in room B', JSON.stringify(got.map((x) => x[0])) === JSON.stringify([10, 8, 8, 8, 25, 25, 20, 20]), JSON.stringify(got.map((x) => x[0])));
	check('ex = rc - rm: 0, 0, 4, 22 | 0, 15, 0, 40 (the room change starts the detour over)', JSON.stringify(got.map((x) => x[1])) === JSON.stringify([0, 0, 4, 22, 0, 15, 0, 40]), JSON.stringify(got.map((x) => x[1])));
	check('rm in fifths is exact for the field\'s fifths (8.2 -> 41, 7.6 -> 38)', GX.excRm(41, 7.6, true) === 38 && GX.excRm(38, 8.2, true) === 38 && GX.excRm(38, 8.2, false) === 41);
	check('the bands: [0,5) [5,20) [20,60) [60,150) [150,inf)', [0, 4.99, 5, 19.9, 20, 59.9, 60, 149.9, 150, 1e4].map(GX.excBand).join('') === '0011223344');
	// (2) the deficit band order
	const T = [0.6, 0.2, 0.1, 0.06, 0.04];
	check('no picks yet: the bands by their target share (1, 2, 3, 4)', JSON.stringify(GX.excOrder(T, [0, 0, 0, 0, 0])) === '[1,2,3,4]');
	check('picks all in band 0: the band furthest below its share first (1: 0.2 short)', GX.excOrder(T, [100, 0, 0, 0, 0])[0] === 1);
	check('band 1 over its share, band 3 the most short: 3 first, band 1 not in the list', (() => { const o = GX.excOrder(T, [50, 40, 8, 0, 2]); return o[0] === 3 && !o.includes(1) && !o.includes(0); })(), JSON.stringify(GX.excOrder(T, [50, 40, 8, 0, 2])));
	check('every band at its share or over: no band short (head A)', GX.excOrder(T, [50, 30, 10, 6, 4]).length === 0);
	check('--excBands parsed and normalized; the default is EXC_BANDS', (() => { const v = GX.excBandsOf({ excBands: '2,1,1,0,0' }); return near(v[0], 0.5) && near(v[1], 0.25) && GX.excBandsOf({ excBands: '' }).join() === GX.EXC_BANDS.join(); })());
	check('--excBands with 4 shares or a negative one refused', (() => { let n = 0; for (const s of ['1,1,1,1', '1,1,1,1,-1', '0,0,0,0,0']) { try { GX.excBandsOf({ excBands: s }); } catch (e) { n++; } } return n === 3; })());
	check('EXC_BANDS: 5 shares summing to 1', GX.EXC_BANDS.length === 5 && Math.abs(GX.EXC_BANDS.reduce((x, y) => x + y, 0) - 1) < 0.002, GX.EXC_BANDS.join(' '));
	check('parseArgs: --exc / --pX / --excBands, off by default', (() => { const a = GX.parseArgs(['x.eelvl']), b = GX.parseArgs(['x.eelvl', '--exc=1', '--pX=0.2', '--excBands=1,1,1,1,1']); return a.exc === 0 && a.pX === 0.15 && b.exc === 1 && b.pX === 0.2 && b.excBands === '1,1,1,1,1'; })());
	// (3) excdata: the band math on a numeric fixture
	const p = XD.profileOf([[10, 1], [8, 1], [30, 1], [100, 1], [200, 1], [50, 2], [60, 2], [20, 2]]);
	// room 1: min 10, 8, 8, 8, 8: ex 0, 0, 22, 92, 192 -> bands 0, 0, 2, 3, 4; room 2: min 50, 50, 20: ex 0, 10, 0 -> 0, 1, 0
	check('excdata profileOf: the running minimum reset at the room change (counts 4 / 1 / 1 / 1 / 1)', JSON.stringify(p.h) === '[4,1,1,1,1]' && p.n === 8, JSON.stringify(p));
	const s = XD.sharesOf(p);
	check('excdata sharesOf: counts / n', near(s[0], 0.5) && near(s[4], 0.125));
	const m = XD.meanOf([[1, 0, 0, 0, 0], [0, 0, 1, 0, 0], null]);
	check('excdata meanOf: each lineage weight 1, null ones skipped', near(m[0], 0.5) && near(m[2], 0.5) && XD.meanOf([null]) === null);
	const g = XD.gapList([{ file: 'a', route: [0.5, 0.1, 0.2, 0.1, 0.1], stalled: [0.9, 0.1, 0, 0, 0] }, { file: 'b', route: [0.8, 0.1, 0.1, 0, 0], stalled: [0.8, 0.1, 0.05, 0.05, 0] }, { file: 'c', route: [1, 0, 0, 0, 0], stalled: null }]);
	check('excdata gapList: route >= 20 share minus stalled >= 20 share, largest first, only levels with both', g.length === 2 && g[0].file === 'a' && near(g[0].gap, 0.4) && near(g[1].gap, 0), JSON.stringify(g));
	// (3b) the departures: sustained excursions (>= 20 above the room's running min for >= 100 ticks, samples every 5)
	const sm = [];
	for (let i = 0; i < 10; i++) sm.push([50 - i, 1]);   // down to 41 in room 1
	for (let i = 0; i < 30; i++) sm.push([41 + 25 + i, 1]);   // 150 ticks at 66..95: >= 20 above 41
	for (let i = 0; i < 10; i++) sm.push([60, 1]);   // 19 above: ends it
	for (let i = 0; i < 10; i++) sm.push([100, 2]);   // room 2: reset (0 above)
	for (let i = 0; i < 10; i++) sm.push([130, 2]);   // 30 above for 50 ticks: too short
	const ex = XD.excursionsOf(sm, 5);
	check('excdata excursionsOf: one sustained excursion (tick 55, from 41, peak 54, 150 ticks); the short one and the room change none', ex.length === 1 && ex[0].at === 55 && ex[0].dep === 41 && ex[0].peak === 54 && ex[0].len === 150 && ex[0].room === 1, JSON.stringify(ex));
	// (4) excdata's tar reader on a hand-made gzip'd tar (ustar, two files, a directory)
	const hdr = (name, size, type) => { const b = Buffer.alloc(512); b.write(name, 0, 'latin1'); b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116); b.write(size.toString(8).padStart(11, '0') + '\0', 124); b.write('00000000000\0', 136); b.write('        ', 148); b[156] = type.charCodeAt(0); b.write('ustar\0', 257); b.write('00', 263); let sum = 0; for (const x of b) sum += x; b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return b; };
	const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
	const f1 = Buffer.from('0444J4'), f2 = Buffer.from('000');
	const tar = Buffer.concat([hdr('run/', 0, '5'), hdr('run/route_1_6.eetas', f1.length, '0'), pad(f1), hdr('run/closest.eetas', f2.length, '0'), pad(f2), Buffer.alloc(1024)]);
	const t = XD.tarEntries(zlib.gzipSync(tar), (b) => /^route_1_\d+\.eetas$/.test(b) || b === 'closest.eetas');
	check('excdata tarEntries: the route and the closest attempt read in memory', t.size === 2 && t.get('route_1_6.eetas').equals(f1) && t.get('closest.eetas').equals(f2));
}

/** a level from a grid of block ids (9 solid) and extra cells [x, y, id, ...args] */
function levelOf(file, name, w, h, g, extra) {
	const cells = [];
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] === 9) cells.push([x, y, 9]);
	for (const c of extra) { g[c[1]][c[0]] = -1; cells.push(c); }
	fs.writeFileSync(file, ED.eelvlOf({ name, width: w, height: h, cells: cells.filter((c) => c[2] !== 9 || g[c[1]][c[0]] === 9) }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}
// the false near of test/frontier.js (400 x 12): the spawn at (12, 8), the trophy at (2, 8) behind a 1-coin door (6, 5-8),
// the coin at (396, 8) at the end of a stepped corridor: the way is a long walk uphill by the door-blind reach field
function falseNear(file) {
	const W = 400, H = 12, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 398; x++) g[y][x] = 0;
	for (let x = 20; x < 395; x += 10) g[8][x] = 9;
	const extra = [[12, 8, 255], [2, 8, 121], [396, 8, 100]];
	for (let y = 5; y <= 8; y++) extra.push([6, y, 43, 1]);
	return levelOf(file, 'exc false near', W, H, g, extra);
}

function sectionToy() {
	section('toy: the false near, --exc=0 / 1 (coarse cells)');
	const file = path.join(HOME, 'falsenear.eelvl');
	const L = falseNear(file);
	check('coarse cells', GX.cellsFor(L) === 'coarse');
	const T = +(opt.toyTicks || 20000000);
	const base = ['--workers=1', '--seconds=180', `--maxTicks=${T}`, '--mem=400', '--first=1', '--classW=0', '--seed=1'];
	const off = gox(GOX, file, base), on = gox(GOX, file, [...base, '--exc=1']);
	const d0 = doneOf(off), d1 = doneOf(on), w0 = (d0.workers || [])[0] || {}, w1 = (d1.workers || [])[0] || {};
	check('--exc=0: no "exc" in the done event', d0.exc === undefined && d0.ticks > 0, `${d0.states} cells, ${d0.picks} picks`);
	const x = d1.exc || {};
	check('--exc=1: head X picks, all in the bands >= 1 (x picks per band)', x.picks > 0 && x.xPicks && x.xPicks[0] === 0 && x.xPicks.slice(1).reduce((a, b) => a + b, 0) === x.picks, JSON.stringify(x));
	check('--exc=1: head X picks cells >= 20 tiles above their lineage\'s minimum (the uphill walk to the coin)', x.xPicks && x.xPicks[2] + x.xPicks[3] + x.xPicks[4] > 0);
	check('--exc=1: the picks\' shares and the target reported, the archive per band counted (every cell)', x.pickShare && x.pickShare.length === 5 && x.target.join() === GX.EXC_BANDS.map((v) => Math.round(1000 * v) / 1000).join() && x.archive.reduce((a, b) => a + b, 0) === d1.states, JSON.stringify(x.archive));
	check('--exc=1: the budget counts rm (bytes = cells x B_EX)', x.bytes === d1.states * GX.B_EX && GX.B_EX === 40, `${x.bytes} bytes, ${d1.states} cells`);
	for (const [k, ev] of [['off', off], ['on', on]]) {
		const r = routesOf(ev);
		if (!r.length) { check(`${k}: a route in ${T / 1e6} M ticks`, false, `nearest ${JSON.stringify(ev.filter((e) => e.ev === 'closest').slice(-1).map((e) => e.dist))}`); continue; }
		const e2 = C.evaluate(L, masksOf(r[0].inputs));
		check(`${k}: a route (replayed)`, !!e2 && e2.ms.length === r[0].ticks, `${r[0].ticks} ticks after ${(r[0].simTicks / 1e6).toFixed(2)} M simulated`);
	}
	const again = gox(GOX, file, [...base, '--exc=1']);
	check('--exc=1: the same seed and budget give the same search', sig(again) === sig(on) && JSON.stringify(doneOf(again).exc) === JSON.stringify(x), `${doneOf(again).picks} / ${d1.picks} picks`);
	// (--excDeep=1, v2: the chains: children that climbed picked first; a route, the same search again)
	const deep = [...base, '--exc=1', '--excDeep=1'];
	const v1 = gox(GOX, file, deep), v2 = gox(GOX, file, deep), xd = doneOf(v1).exc || {}, rd = routesOf(v1);
	check('--excDeep=1: chain picks (deepPicks > 0, pushed >= deepPicks), a route (replayed), the same seed = the same search',
		xd.deepPicks > 0 && xd.pushed >= xd.deepPicks && rd.length > 0 && !!C.evaluate(L, masksOf(rd[0].inputs)) && sig(v1) === sig(v2), JSON.stringify({ deep: xd.deepPicks, pushed: xd.pushed, picks: xd.picks, route: rd.length ? rd[0].ticks : null }));
	check('--exc=1 with --pA=0 (the distance-blind config): no head X (it takes its picks from head A\'s slot), no crash', (() => { const d = doneOf(gox(GOX, file, [...base, '--exc=1', '--pA=0', `--maxTicks=${Math.min(T, 3000000)}`])); return d.ticks > 0 && d.exc && d.exc.picks === 0; })());
	void w0; void w1;
}

function sectionLevels() {
	section('levels: the flag off = main');
	const dir = opt.levels || path.join(__dirname, '..', 'src', 'out', 'god', 'levels', 'campaign');
	if (!fs.existsSync(dir)) { console.log(`  (skipped: no level folder ${dir}; pass --levels=)`); return; }
	const main = opt.main || null;
	if (!main) { console.log('  (no --main=: the flag off vs main not checked)'); return; }
	const T = +(opt.ticks || 3000000);
	const base = ['--workers=1', '--seconds=300', `--maxTicks=${T}`, '--mem=600', '--classW=0', '--seed=1'];
	const files = fs.readdirSync(dir);
	for (const id of ['04_1', '37_3', '05_2', '26_1', '33_3']) {
		const f = files.find((s) => s.startsWith(id + '_') && s.endsWith('.eelvl'));
		if (!f) { check(`${id}: the level file`, false, 'missing'); continue; }
		const file = path.join(dir, f);
		const off = gox(GOX, file, [...base, '--exc=0'], 600000), m = gox(main, file, base, 600000);
		const d = doneOf(off);
		check(`${id}: --exc=0 = main (ticks, cells, picks, replays, rooms, routes)`, sig(off) === sig(m) && d.ticks > 0 && d.exc === undefined, `${d.states} cells, ${d.picks} picks, ${((d.workers || [])[0] || {}).rooms} rooms, ${routesOf(off).length} routes`);
		// (the observer: --exc=1 --pX=0 draws no random number more and picks nothing by head X: the same search where the
		// budget does not bind (rm's bytes are counted), the picks' bands measured: the A/B's profile of the base arm)
		if (id === '04_1' || id === '33_3') {
			const ob = gox(GOX, file, [...base, '--exc=1', '--pX=0'], 600000), x = doneOf(ob).exc || {};
			check(`${id}: the observer (--exc=1 --pX=0) = the flag off, its picks' bands counted`, sig(ob) === sig(off) && x.picks === 0 && x.pickShare && x.pickShare.reduce((u, v) => u + v, 0) > 0.99, JSON.stringify(x.pickShare));
		}
	}
}

if (want('units')) sectionUnits();
if (want('toy')) sectionToy();
if (want('levels')) sectionLevels();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
