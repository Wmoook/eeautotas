'use strict';
// THE COINS OUTSIDE THE LAYER PRODUCT (src/steer.js coinLegsFree, buildSteer's free DP / tour; d4-coins-over-budget):
// when the build's budget leaves the gold coins out of the layer product ("coins: over 31 layers": CTM_2, LoZ Skyward
// Sword, Pretty How Town, Fizio1, ...) the layer field walks through the coin doors it does not model, and the CPU search
// had no coin guidance at all. Now the CPU file carries a coin value FIRST below the walk plan's door count: the
// distinct-coin DP (18 coins or fewer, leg bodies after the layer bodies, flags 1 | 4) or the walk-leg tour (more).
// A unit level (64 x 44, coarse cells): the spawn at x 30, a purple switch (id 1) left of it, a purple door column (id 1)
// at x 34 (so the switch is a kept feature: 2 layers), N coins right of the door on the floor / a ledge band, an N-coin
// door column at x 56, the trophy at x 60; built with maxLayers 4 (the coins' N + 1 values x 2 > 4: left out).
//   1 the DP (N 6): the coins left out, the switch kept; the free DP over the 6 coins, T 6 (the plan's door), a tour from
//     the start; the plain (GPU) file = the build with freeDP false, byte for byte; the CPU file flags 1 | 4, its lookup =
//     the build's along a random run; the start value: the DP's (higher than the layer field's walk through the door)
//   2 the value along the DP's own tour falls at every coin; past T the layer field's value (the DP says nothing)
//   3 the CPU search (goexplore.js, 1 worker, seed 1, a tick budget): with the CPU file a route in fewer simulated ticks
//     than with the plain file (main's search); reproducible
//   4 the tour (N 20 > 18): the walk-leg tour first below T 20 (the plan's door), the plain file = freeDP false's
//   5 freeDP false: no DP, no tour, the CPU file = the plain file (main's build)
// usage: node test/coinfree.js [--only=1,2,3,4,5] [--ticks=30000000]
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
const TICKS = +arg('ticks', '30000000');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-coinfree-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

const W = 64, H = 44, ML = 4;
function levelOf(N) {
	const cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const inside = x >= 1 && x <= W - 2 && y >= 36 && y <= 42;
		if (!inside) cells.push([x, y, 9]);
	}
	const coins = [];
	for (let x = 36; x <= 55 && coins.length < N; x++) coins.push([x, coins.length % 2 ? 40 : 42]);
	for (let x = 29; x >= 2 && coins.length < N; x -= 2) if (x !== 30 && x > 34 || x < 20) coins.push([x, coins.length % 2 ? 40 : 42]);
	for (const [x, y] of coins) cells.push([x, y, 100]);
	cells.push([30, 42, 255]);
	cells.push([24, 42, 113, 1]);
	for (let y = 36; y <= 42; y++) cells.push([34, y, 184, 1]);
	for (let y = 36; y <= 42; y++) cells.push([56, y, 43, N]);
	cells.push([60, 42, 121]);
	const buf = ED.eelvlOf({ name: `coinfree${N}`, width: W, height: H, cells });
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
	return { buf, L, coins };
}
const place = (sim, x, y) => { sim.px = x * 16; sim.py = y * 16; };
function setCoins(L, sim, taken) {
	sim._coinBits = new Int32Array(L.coinWords); sim._coinOwned = true;
	for (const [x, y] of taken) { const b = L.coinBit[y * W + x]; sim._coinBits[b >> 5] |= 1 << (b & 31); }
	sim.coins = taken.length;
}
function sameAlongRun(L, a, b) {
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let seed = 7, same = 0, n = 0;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	for (let t = 0; t < 3000; t++) {
		E.applyMask(inp, [0, 2, 4, 5, 3, 1][(rnd() * 6) | 0]);
		sim.tick(inp);
		if (t % 10) continue;
		n++;
		if (SF.steerFifths(a, sim) === SF.steerFifths(b, sim)) same++;
	}
	return [same, n];
}

const D6 = levelOf(6);
const st = SF.buildSteer(D6.L, { maxLayers: ML });
const stOff = SF.buildSteer(D6.L, { maxLayers: ML, freeDP: false });
const cpuFile = path.join(tmp, 'cpu.steer'), plainFile = path.join(tmp, 'plain.steer'), lf = path.join(tmp, 'coinfree6.eelvl');
fs.writeFileSync(lf, D6.buf);
fs.writeFileSync(cpuFile, SF.steerFileBytes(st, null, true));
fs.writeFileSync(plainFile, SF.steerFileBytes(st, null));

function section1() {
	section('1 the DP outside the layer product (6 coins)');
	const fsOk = st.info.features.indexOf('coins') < 0 && st.info.features.indexOf('psw:1') >= 0;
	check('the budget leaves the coins out, the switch kept', fsOk && /^coins/.test(String(st.info.over)), `features ${JSON.stringify(st.info.features)}, over ${st.info.over}`);
	const d = st.info.dp;
	check('the free DP over the 6 coins, T 6, a tour of 6 from the start', !!d && d.free === true && d.n === 6 && d.T === 6 && d.tour && d.tour.length === 6, JSON.stringify(d));
	check('no coin tour next to it', !st.tour && st.info.tour === null);
	check('the plain (GPU) file = the build with freeDP false, byte for byte', Buffer.compare(SF.steerFileBytes(st, null), SF.steerFileBytes(stOff, null)) === 0);
	check('... its bodies the layer bodies only, the leg bodies after them', st.nPlain === stOff.bodies.length && st.bodies.length === st.nPlain + 6, `${st.nPlain} + ${st.bodies.length - st.nPlain}`);
	const rd = SF.readSteerFile(fs.readFileSync(cpuFile)), rp = SF.readSteerFile(fs.readFileSync(plainFile));
	check('the CPU file: the DP (flags 1 | 4: the larger of it and the layer field\'s), the plain file: no DP', !!rd.dp && rd.dp.max === true && rd.dp.n === 6 && !rp.dp);
	const [same, n] = sameAlongRun(D6.L, st, rd);
	check('the CPU file\'s lookup = the build\'s along a random run', same === n, `${same} / ${n}`);
	const sim = new E.EESim(D6.L); sim.reset();
	const v = SF.steerAt(st, sim), v0 = SF.steerAt(stOff, sim);
	const g = SF.nextGate(st, sim), c0 = st.info.dp.tour[0];
	check('the start value: the larger of the DP\'s and the layer field\'s; the DP\'s next gate the tour\'s first coin',
		Number.isFinite(v) && Number.isFinite(v0) && !!g && g.bit === D6.L.coinBit[c0[1] * W + c0[0]] && Math.abs(v - Math.max(v0, g.v / 5)) < 0.2, `${v}: DP ${g && g.v / 5}, layer ${v0} tiles, gate ${g && g.bit}`);
	// (by the coin door with no coin: the layer field's walk through the door is short, the DP's way over the coins long)
	setCoins(D6.L, sim, []); place(sim, 55, 42);
	const vd = SF.steerAt(st, sim), vl = SF.steerAt(stOff, sim);
	check('at the coin door with no coin: the DP\'s value (the coins to fetch), far above the layer field\'s', vd > vl + 10, `${vd} vs ${vl} tiles`);
}

function section2() {
	section('2 the value along the DP\'s tour');
	const order = st.info.dp.tour;
	const sim = new E.EESim(D6.L); sim.reset();
	let falls = 0, prev = Infinity;
	const vals = [];
	for (let k = 0; k < order.length; k++) {
		setCoins(D6.L, sim, order.slice(0, k));
		place(sim, order[k][0], order[k][1]);
		const v = SF.steerFifths(st, sim);
		vals.push(v);
		if (v >= 0 && v < prev) falls++;
		prev = v;
	}
	check('along the DP\'s tour the value falls at every coin', falls === order.length, `${falls} / ${order.length}: ${vals.map((x) => (x / 5).toFixed(0)).join(' ')}`);
	let larger = 0;
	for (let k = 0; k < order.length; k++) {
		setCoins(D6.L, sim, order.slice(0, k)); place(sim, order[k][0], order[k][1]);
		const g = SF.nextGate(st, sim), l = SF.steerFifths(stOff, sim), x = SF.steerFifths(st, sim);
		if (g && x === Math.max(l, Math.floor(g.v + 0.5))) larger++;
	}
	check('... the larger of the DP\'s and the layer field\'s there', larger === order.length, `${larger} / ${order.length}`);
	setCoins(D6.L, sim, order); place(sim, 50, 42);
	check('past T coins: the layer field\'s value (the DP says nothing)', SF.steerFifths(st, sim) === SF.steerFifths(stOff, sim) && SF.steerFifths(st, sim) >= 0, `${SF.steerAt(st, sim)} tiles`);
}

function goex(file) {
	const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=1', `--maxTicks=${TICKS}`, '--mem=300', '--seconds=600', '--first=1', `--steer=${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
	const evs = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
	return { route: evs.find((j) => j.ev === 'result') || null };
}
function section3() {
	section('3 the CPU search');
	const a = goex(cpuFile), b = goex(plainFile);
	const sa = a.route ? a.route.simTicks : Infinity, sb = b.route ? b.route.simTicks : Infinity;
	console.log(`  (the free DP: ${a.route ? `a route of ${a.route.ticks} ticks after ${sa} simulated` : `none in ${TICKS}`}; plain: ${b.route ? `${b.route.ticks} ticks after ${sb}` : `none in ${TICKS}`})`);
	check('with the free DP a route (replayed)', !!a.route);
	check('... in fewer simulated ticks than the plain steer field (main\'s)', sa < sb, `${sa} vs ${sb}`);
	const a2 = goex(cpuFile);
	check('... reproducible (one worker, a tick budget)', !!a2.route && a2.route.inputs === a.route.inputs && a2.route.simTicks === sa);
}

function section4() {
	section('4 the tour outside the layer product (20 coins)');
	const D20 = levelOf(20);
	const s = SF.buildSteer(D20.L, { maxLayers: ML });
	const off = SF.buildSteer(D20.L, { maxLayers: ML, freeDP: false });
	const t = s.info.tour;
	check('the budget leaves the coins out, the switch kept', s.info.features.indexOf('coins') < 0 && s.info.features.indexOf('psw:1') >= 0 && /^coins/.test(String(s.info.over)), `${JSON.stringify(s.info.features)}, ${s.info.over}`);
	check('no DP (20 > 18), the walk-leg tour below T 20 (the plan\'s door), the larger of it and the layer field\'s', !s.dp && !!t && t.max === true && t.T === 20 && t.n === 20, JSON.stringify(t));
	check('the plain (GPU) file = the build with freeDP false, byte for byte', Buffer.compare(SF.steerFileBytes(s, null), SF.steerFileBytes(off, null)) === 0);
	const sim = new E.EESim(D20.L); sim.reset();
	const rd = SF.readSteerFile(SF.steerFileBytes(s, null, true));
	check('the CPU file carries the tour (first 2), its start value = the build\'s = the larger of both', !!rd.tour && rd.tour.first === 2 && SF.steerAt(rd, sim) === SF.steerAt(s, sim) && SF.steerAt(s, sim) >= SF.steerAt(off, sim), `${SF.steerAt(rd, sim)} vs ${SF.steerAt(s, sim)} (layer ${SF.steerAt(off, sim)})`);
}

function section5() {
	section('5 freeDP false: main\'s build');
	check('no DP, no tour', !stOff.dp && !stOff.tour && stOff.info.tour === null);
	check('the CPU file = the plain file, byte for byte', Buffer.compare(SF.steerFileBytes(stOff, null, true), SF.steerFileBytes(stOff, null)) === 0);
}

if (want('1')) section1();
if (want('2')) section2();
if (want('3')) section3();
if (want('4')) section4();
if (want('5')) section5();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
