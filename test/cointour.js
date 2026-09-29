'use strict';
// The coin tour (src/steer.js buildTour / tourFifths): past the coin DP's 18 coins the steer field below the door's count
// had no value at all (the layer fields count only the ways that need no more coins; Level 1 Overworld: NaN below 80
// coins), so the CPU search had no gradient toward the coins. A unit level: 25 coins on two floors left and right of
// the spawn, a 25-coin door column before the trophy (64 x 44: coarse cells, as the campaign levels get them).
//   1 the build: a tour over the 25 coins (no DP), T 25, the coins modelled (first false); the plain file (the GPU's) the
//     same bytes as a build without the tour; the CPU file's round trip gives the same values
//   2 the value: finite below 25 coins where the layer field has none; along the tour's own order (the ball on the k-th
//     coin with the k before it taken) it falls at every coin; a new distinct coin taken lowers it, a taken coin
//     touched again does not
//   3 the CPU search (goexplore.js, 1 worker, seed 1, a tick budget): with the CPU file a route in fewer simulated ticks
//     than with the plain file (the search before the tour); both reproducible
//   4 the coins not modelled (the budget leaves the coin feature out): no tour, the CPU file = the plain file = the
//     build without a tour, the same lookup; opt-in tourFirst keeps the unmodelled tour (first below T)
// usage: node test/cointour.js [--only=1,2,3,4] [--ticks=40000000]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SF = require('../src/steer.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
const TICKS = +arg('ticks', '40000000');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-cointour-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

// the level: solid rock with a corridor (rows 36-42, floor row 43), the spawn at x 30, coins on the floor (row 42) and
// on a ledge band (row 40: a jump), the door column (43, 25 coins) at x 56, the trophy at x 60
const W = 64, H = 44, NEED = 25;
function levelBuf() {
	const cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const inside = x >= 1 && x <= W - 2 && y >= 36 && y <= 42;
		if (!inside) cells.push([x, y, 9]);
	}
	const coins = [];
	for (let x = 2; x <= 26; x += 2) coins.push([x, coins.length % 2 ? 40 : 42]);
	for (let x = 33; x <= 55 && coins.length < NEED; x += 2) coins.push([x, coins.length % 2 ? 40 : 42]);
	for (const [x, y] of coins) cells.push([x, y, 100]);
	cells.push([30, 42, 255]);
	for (let y = 36; y <= 42; y++) cells.push([56, y, 43, NEED]);
	cells.push([60, 42, 121]);
	return { buf: ED.eelvlOf({ name: 'cointour', width: W, height: H, cells }), coins };
}
const { buf, coins } = levelBuf();
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
const lf = path.join(tmp, 'cointour.eelvl');
fs.writeFileSync(lf, buf);
const st = SF.buildSteer(L);
const stPlain = SF.buildSteer(L, { noTour: true });
const cpuFile = path.join(tmp, 'cpu.steer'), plainFile = path.join(tmp, 'plain.steer');
fs.writeFileSync(cpuFile, SF.steerFileBytes(st, null, true));
fs.writeFileSync(plainFile, SF.steerFileBytes(st, null));

function section1() {
	section('1 the build');
	const ti = st.info.tour;
	check('a tour over the 25 coins, T 25, no DP, the coins modelled', !!st.tour && !st.dp && ti && ti.n === coins.length && ti.T === NEED && ti.first === false, JSON.stringify(ti));
	check('the plain file (the GPU tools\') = the build without the tour, byte for byte', Buffer.compare(fs.readFileSync(plainFile), SF.steerFileBytes(stPlain, null)) === 0);
	const rd = SF.readSteerFile(fs.readFileSync(cpuFile));
	const rp = SF.readSteerFile(fs.readFileSync(plainFile));
	check('the CPU file carries the tour (flags 2), the plain one not', !!rd.tour && rd.tour.n === st.tour.n && !rp.tour);
	let same = 0, n = 0;
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let seed = 5;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	for (let t = 0; t < 3000; t++) {
		E.applyMask(inp, [0, 2, 4, 5, 3, 1][(rnd() * 6) | 0]);
		sim.tick(inp);
		if (t % 10) continue;
		n++;
		if (SF.steerFifths(st, sim) === SF.steerFifths(rd, sim)) same++;
	}
	check('the CPU file\'s lookup = the build\'s along a random run', same === n, `${same} / ${n}`);
}

// the ball placed on a coin tile (standing on the floor below it or in the air: the lookup reads the tile)
function place(sim, x, y) { sim.px = x * 16; sim.py = y * 16; }
function setCoins(sim, taken) {
	sim._coinBits = new Int32Array(L.coinWords); sim._coinOwned = true;
	for (const [x, y] of taken) { const b = L.coinBit[y * W + x]; sim._coinBits[b >> 5] |= 1 << (b & 31); }
	sim.coins = taken.length;
}
function section2() {
	section('2 the value');
	const sim = new E.EESim(L); sim.reset();
	check('below 25 coins the layer field has no value (plain), the tour has', !(SF.steerFifths(stPlain, sim) >= 0) && SF.steerFifths(st, sim) >= 0, `${SF.steerAt(stPlain, sim)} vs ${SF.steerAt(st, sim)} tiles`);
	const R = st.tour;
	const order = Array.from(R.order).map((i) => { const t = R.coin[i]; return [t % W, Math.floor(t / W)]; });
	let falls = 0, prev = Infinity;
	const vals = [];
	for (let k = 0; k < order.length; k++) {
		setCoins(sim, order.slice(0, k));
		place(sim, order[k][0], order[k][1]);
		const v = SF.steerFifths(st, sim);
		vals.push(v);
		if (v >= 0 && v < prev) falls++;
		prev = v;
	}
	check('along the tour\'s order the value falls at every coin', falls === order.length, `${falls} / ${order.length}: ${vals.map((v) => (v / 5).toFixed(0)).join(' ')}`);
	// a new distinct coin vs the same place without it (between coin 5 and coin 6: without coin 5 the way goes back to
	// it; on the coin's own tile both are the same, the cost to go is continuous), a taken coin again
	const mx = (order[5][0] + order[6][0]) >> 1;
	setCoins(sim, order.slice(0, 5)); place(sim, mx, 42);
	const before = SF.steerFifths(st, sim);
	setCoins(sim, order.slice(0, 6));
	const after = SF.steerFifths(st, sim);
	check('with a new coin taken the value is lower at the same place', after < before, `${before / 5} -> ${after / 5} tiles`);
	setCoins(sim, order.slice(0, 6)); place(sim, order[2][0], order[2][1]);
	const back = SF.steerFifths(st, sim);
	check('back on a coin already taken: no lower than on the last one taken', back >= after, `${back / 5} vs ${after / 5}`);
}

function goex(file) {
	const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=1', `--maxTicks=${TICKS}`, '--mem=300', '--seconds=600', '--first=1', `--steer=${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
	const evs = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
	const res = evs.find((j) => j.ev === 'result');
	const done = evs.find((j) => j.ev === 'done');
	return { route: res || null, done };
}
function section3() {
	section('3 the CPU search');
	const a = goex(cpuFile), b = goex(plainFile);
	const sa = a.route ? a.route.simTicks : Infinity, sb = b.route ? b.route.simTicks : Infinity;
	console.log(`  (tour: ${a.route ? `a route of ${a.route.ticks} ticks after ${sa} simulated` : `none in ${TICKS}`}; plain: ${b.route ? `${b.route.ticks} ticks after ${sb}` : `none in ${TICKS}`})`);
	check('with the tour a route (replayed)', !!a.route);
	check('... in fewer simulated ticks than the plain steer field', sa < sb, `${sa} vs ${sb}`);
	const a2 = goex(cpuFile);
	check('... reproducible (one worker, a tick budget)', !!a2.route && a2.route.inputs === a.route.inputs && a2.route.simTicks === sa);
}

// the coins NOT modelled (the build's budget leaves the coin feature out: 26 coin layers over 4): no tour, the layer
// field as main's (the unmodelled tour came FIRST below T, replacing the layer field, and over-demanded coins on routed
// campaign levels: Weird Perfection T 99 vs the 70 its routes take); the CPU file = the plain file byte for byte; the
// opt-in `tourFirst` keeps the unmodelled tour for measurement
function section4() {
	section('4 no tour where the coins are not modelled');
	const s4 = SF.buildSteer(L, { maxLayers: 4 });
	const s4n = SF.buildSteer(L, { maxLayers: 4, noTour: true });
	const unmod = s4.info.features.indexOf('coins') < 0;
	check('the budget leaves the coins out (not modelled)', unmod && /^coins/.test(String(s4.info.over)), `features ${JSON.stringify(s4.info.features)}, over ${s4.info.over}`);
	check('no tour (info.tour null, no tour section)', !s4.tour && s4.info.tour === null, JSON.stringify(s4.info.tour));
	check('the CPU file = the plain file = the build without a tour, byte for byte',
		Buffer.compare(SF.steerFileBytes(s4, null, true), SF.steerFileBytes(s4, null)) === 0 && Buffer.compare(SF.steerFileBytes(s4, null), SF.steerFileBytes(s4n, null)) === 0);
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let seed = 9, same = 0, n = 0;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	for (let t = 0; t < 3000; t++) {
		E.applyMask(inp, [0, 2, 4, 5, 3, 1][(rnd() * 6) | 0]);
		sim.tick(inp);
		if (t % 10) continue;
		n++;
		if (SF.steerFifths(s4, sim) === SF.steerFifths(s4n, sim)) same++;
	}
	check('the lookup = the build without a tour along a random run', same === n, `${same} / ${n}`);
	const s4f = SF.buildSteer(L, { maxLayers: 4, tourFirst: true });
	check('opt-in tourFirst: the unmodelled tour (first below T) as before', !!s4f.tour && s4f.info.tour && s4f.info.tour.first === true && s4f.info.tour.T === NEED, JSON.stringify(s4f.info.tour));
}

if (want('1')) section1();
if (want('2')) section2();
if (want('3')) section3();
if (want('4')) section4();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
