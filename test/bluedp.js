'use strict';
// THE BLUE COIN DP (src/steer.js kindPlan, kindLegs, blueDP; d4-blue-coin-dp): the distinct-coin DP over the BLUE coins
// where the walk plan passes a blue door before any gold door (Animaly: 4 blue coins each behind a team door of another
// team, the trophy over a 4-blue door; Beat the Spikes 2: 4 blue coins in the corners). The layer fields count a coin at
// every touch (the walk model's relaxation), so without it the search sat on the first coin. Its legs are LAYERED: per
// coin and per layer of the model without the blue count, the field to the coin with the tiles that change the layer as
// goals (a ball of the wrong team goes to the team's effect first, not to the shut door); the lookup below T blue coins
// the larger of the DP's and the layer field's; the CPU file's alone (flags 1 | 4 | 16 | 32), the plain file main's.
// A unit level (64 x 44, coarse cells): the corridor (1..62, 30..36), the spawn at (30, 36); three team effects above the
// floor at (8, 33) team 1, (14, 33) team 2, (20, 33) team 3 (a jump touches them, a walk does not); three pits in the
// floor, each under a team door of its own team (36-37 team 1, 42-43 team 2, 48-49 team 3), a blue coin at each pit's
// bottom (36, 39), (42, 39), (48, 39); a 3-blue-coin door column at x 54, the trophy at (58, 36).
//   1 the build: the blue DP over the 3 coins, T 3 (the plan's door), kind bcoins, the larger of both; its legs per layer;
//     the plain (GPU) file = the build with blueDP false, byte for byte; the CPU file flags 1 | 4 | 16 | 32, read back:
//     the same lookup along a random run
//   2 the layered legs: a ball of the wrong team at a coin's door is valued above a ball of the coin's team there (the
//     effect first), by at least the walk to the effect; the next gate names the coin; along the DP's own tour (the
//     right teams) the value falls at every coin; past T blue coins the layer field's value
//   3 the CPU search (goexplore.js, 1 worker, seed 1, a tick budget): with the CPU file a route; reproducible
//   4 blueDP false: no DP, the CPU file = the plain file (main's build); EEAT_BLUEDP=0 the same
//   5 a gold coin DP (a 1-coin door on the plan): main's build, no blue DP (a level with both keeps its gold DP)
// usage: node test/bluedp.js [--only=1,2,3,4,5] [--ticks=40000000]
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-bluedp-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

const W = 64, H = 44;
const TEAMS = [[8, 1], [14, 2], [20, 3]], PITS = [[36, 1], [42, 2], [48, 3]];
/** the unit level; goldFirst: a 1-gold-coin door column at x 33 between the spawn and the pits, its coin at (31, 36)
 *  (the plan passes the gold door first: the gold DP) */
function levelOf(goldFirst) {
	const cells = [];
	const open = new Set();
	for (let y = 30; y <= 36; y++) for (let x = 1; x <= 62; x++) open.add(`${x},${y}`);
	for (const [x] of PITS) for (let y = 37; y <= 39; y++) { open.add(`${x},${y}`); open.add(`${x + 1},${y}`); }
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!open.has(`${x},${y}`)) cells.push([x, y, 9]);
	cells.push([30, 36, 255]);
	for (const [x, t] of TEAMS) cells.push([x, 33, 423, t]);
	for (const [x, t] of PITS) { cells.push([x, 37, 1027, t], [x + 1, 37, 1027, t]); cells.push([x, 39, 101]); }
	for (let y = 30; y <= 36; y++) cells.push([54, y, 213, 3]);
	if (goldFirst) { cells.push([31, 36, 100]); for (let y = 30; y <= 36; y++) cells.push([33, y, 43, 1]); }
	cells.push([58, 36, 121]);
	const buf = ED.eelvlOf({ name: `bluedp${goldFirst ? 'g' : ''}`, width: W, height: H, cells });
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
	return { buf, L };
}
const place = (sim, x, y) => { sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0; };
function setBlue(L, sim, taken) {
	sim._coinBits = new Int32Array(L.coinWords); sim._coinOwned = true;
	for (const [x, y] of taken) { const b = L.coinBit[y * W + x]; sim._coinBits[b >> 5] |= 1 << (b & 31); }
	sim.blue_coins = taken.length;
}
function sameAlongRun(L, a, b) {
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let seed = 11, same = 0, n = 0;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	for (let t = 0; t < 4000; t++) {
		E.applyMask(inp, [0, 2, 4, 5, 3, 1, 2, 4][(rnd() * 8) | 0]);
		sim.tick(inp);
		if (t % 8) continue;
		n++;
		if (SF.steerFifths(a, sim) === SF.steerFifths(b, sim)) same++;
	}
	return [same, n];
}

const D = levelOf(false);
const st = SF.buildSteer(D.L, { legThreads: 0 });
const stOff = SF.buildSteer(D.L, { legThreads: 0, blueDP: false });
const cpuFile = path.join(tmp, 'cpu.steer'), plainFile = path.join(tmp, 'plain.steer'), lf = path.join(tmp, 'bluedp.eelvl');
fs.writeFileSync(lf, D.buf);
fs.writeFileSync(cpuFile, SF.steerFileBytes(st, null, true));
fs.writeFileSync(plainFile, SF.steerFileBytes(st, null));
const coinTile = (x, y) => y * W + x;

function section1() {
	section('1 the build');
	const d = st.info.dp;
	check('the blue count and the team modelled', st.info.features.includes('bcoins') && st.info.features.includes('team'), JSON.stringify(st.info.features));
	check('the blue DP over the 3 blue coins, T 3 (the plan\'s door), a tour of 3 from the start', !!d && d.kind === 'bcoins' && d.free === true && d.n === 3 && d.T === 3 && d.tour && d.tour.length === 3, JSON.stringify(d));
	check('... its legs per layer (legS: n x S bodies), the larger of both (max)', !!st.dp && !!st.dp.legS && st.dp.legS.length === 3 * st.S && st.dp.max === true, st.dp && `S ${st.S}, legS ${st.dp.legS && st.dp.legS.length}`);
	check('... built by the value iteration over the team layers', !!st.info.blue && st.info.blue.layers >= 4 && st.info.blue.builds >= 3 * st.info.blue.layers, JSON.stringify(st.info.blue));
	check('no gold DP, no coin tour next to it', !st.tour && st.info.tour === null);
	check('the plain (GPU) file = the build with blueDP false, byte for byte', Buffer.compare(SF.steerFileBytes(st, null), SF.steerFileBytes(stOff, null)) === 0);
	check('... its bodies the layer bodies only, the leg bodies after them', st.nPlain === stOff.bodies.length && st.bodies.length > st.nPlain, `${st.nPlain} + ${st.bodies.length - st.nPlain}`);
	const buf = fs.readFileSync(cpuFile);
	const flags = buf.readInt32LE(4 + 4 * 6);
	check('the CPU file\'s flags 1 | 4 | 16 | 32, the plain file\'s no DP', flags === (1 | 4 | 16 | 32) && !SF.readSteerFile(fs.readFileSync(plainFile)).dp, `flags ${flags}`);
	const rd = SF.readSteerFile(buf);
	check('read back: the blue count, the legs per layer', !!rd.dp && rd.dp.kind === 'bcoins' && rd.dp.max === true && rd.dp.legS && rd.dp.legS.length === 3 * rd.S && rd.dp.legS.every((v, k) => v === st.dp.legS[k]));
	const [same, n] = sameAlongRun(D.L, st, rd);
	check('the CPU file\'s lookup = the build\'s along a random run', same === n, `${same} / ${n}`);
	const sim = new E.EESim(D.L); sim.reset();
	const v = SF.steerAt(st, sim), v0 = SF.steerAt(stOff, sim), g = SF.nextGate(st, sim);
	check('the start value: the DP\'s (the 3 trips), above the layer field\'s (the count relaxation: one coin touched 3 times)', Number.isFinite(v) && Number.isFinite(v0) && !!g && v > v0 + 10 && Math.abs(v - g.v / 5) < 0.3, `${v} vs ${v0} tiles, gate ${g && g.v / 5}`);
}

function section2() {
	section('2 the layered legs');
	const sim = new E.EESim(D.L); sim.reset();
	let wrong = 0, ok = 0;
	const det = [];
	for (let k = 0; k < PITS.length; k++) {
		const [x, t] = PITS[k];
		// (the other two coins taken: this coin is the DP's only way on)
		setBlue(D.L, sim, PITS.filter((p, j) => j !== k).map(([px]) => [px, 39]));
		place(sim, x, 36);
		sim.team = t;
		const vRight = SF.steerAt(st, sim);
		sim.team = t === 1 ? 2 : 1;
		const vWrong = SF.steerAt(st, sim);
		// (the walk to the coin's effect and back: at least the distance between the door and the effect)
		const walkTo = Math.abs(x - TEAMS[t - 1][0]);
		det.push(`pit ${x}: team ${t} ${vRight}, wrong ${vWrong}`);
		if (vWrong > vRight + walkTo) ok++; else wrong++;
	}
	check('the last coin: at its door a ball of the wrong team is valued above the coin\'s team by more than the walk to the effect', ok === 3 && !wrong, det.join('; '));
	// (the next gate from the start: a coin; its leg in the start's layer (team 0) leads to that coin's effect first)
	setBlue(D.L, sim, []); sim.reset();
	const g = SF.nextGate(st, sim);
	check('the next gate from the start: one of the 3 coins, its leg body the start layer\'s', !!g && g.body === st.dp.legS[g.i * st.S + SF.layerIndex(st, sim)], g && JSON.stringify(g));
	// along the DP's own tour with the right teams: the value falls at every coin
	const order = st.info.dp.tour;
	const pitOf = (cx) => PITS.find(([x]) => x === cx);
	let falls = 0, prev = Infinity;
	const vals = [];
	for (let k = 0; k < order.length; k++) {
		const [cx, cy] = order[k];
		setBlue(D.L, sim, order.slice(0, k));
		place(sim, cx, cy); sim.team = pitOf(cx)[1];
		const v = SF.steerFifths(st, sim);
		vals.push(v);
		if (v >= 0 && v < prev) falls++;
		prev = v;
	}
	check('along the DP\'s tour (the right teams) the value falls at every coin', falls === order.length, `${falls} / ${order.length}: ${vals.map((x) => (x / 5).toFixed(1)).join(' ')}`);
	setBlue(D.L, sim, order); place(sim, 50, 36); sim.team = 3;
	check('past T blue coins: the layer field\'s value (the DP says nothing)', SF.steerFifths(st, sim) === SF.steerFifths(stOff, sim) && SF.steerFifths(st, sim) >= 0, `${SF.steerAt(st, sim)} tiles`);
}

function goex(file) {
	const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=1', `--maxTicks=${TICKS}`, '--mem=300', '--seconds=600', '--first=1', `--steer=${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
	const evs = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
	return { route: evs.find((j) => j.ev === 'result') || null, done: evs.find((j) => j.ev === 'done') || null };
}
function section3() {
	section('3 the CPU search');
	const a = goex(cpuFile), b = goex(plainFile);
	const sa = a.route ? a.route.simTicks : Infinity, sb = b.route ? b.route.simTicks : Infinity;
	console.log(`  (the blue DP: ${a.route ? `a route of ${a.route.ticks} ticks after ${sa} simulated` : `none in ${TICKS}`}; plain: ${b.route ? `${b.route.ticks} ticks after ${sb}` : `none in ${TICKS}`})`);
	check('with the blue DP a route (replayed)', !!a.route);
	check('... in no more simulated ticks than with the plain steer field (main\'s)', sa <= sb, `${sa} vs ${sb}`);
	const a2 = goex(cpuFile);
	check('... reproducible (one worker, a tick budget)', !!a2.route && !!a.route && a2.route.inputs === a.route.inputs && a2.route.simTicks === sa);
}

function section4() {
	section('4 blueDP false: main\'s build');
	check('no DP, no tour', !stOff.dp && !stOff.tour && stOff.info.tour === null && !stOff.info.dp);
	check('the CPU file = the plain file, byte for byte', Buffer.compare(SF.steerFileBytes(stOff, null, true), SF.steerFileBytes(stOff, null)) === 0);
	const was = process.env.EEAT_BLUEDP;
	process.env.EEAT_BLUEDP = '0';
	const sEnv = SF.buildSteer(D.L, { legThreads: 0 });
	if (was === undefined) delete process.env.EEAT_BLUEDP; else process.env.EEAT_BLUEDP = was;
	check('EEAT_BLUEDP=0: the same (CPU file = main\'s)', Buffer.compare(SF.steerFileBytes(sEnv, null, true), SF.steerFileBytes(stOff, null, true)) === 0);
}

function section5() {
	section('5 a gold coin DP: main\'s build');
	const G = levelOf(true);
	const s = SF.buildSteer(G.L, { legThreads: 0 });
	const off = SF.buildSteer(G.L, { legThreads: 0, blueDP: false });
	const d = s.info.dp;
	check('the gold DP (main\'s), no blue DP (a level with a gold DP keeps it)', !!d && !d.kind && !d.free && d.n === 1 && !s.info.blue, `${JSON.stringify(d)}, ${JSON.stringify(s.info.blue)}`);
	check('both files = the build with blueDP false, byte for byte', Buffer.compare(SF.steerFileBytes(s, null), SF.steerFileBytes(off, null)) === 0 && Buffer.compare(SF.steerFileBytes(s, null, true), SF.steerFileBytes(off, null, true)) === 0);
}

if (want('1')) section1();
if (want('2')) section2();
if (want('3')) section3();
if (want('4')) section4();
if (want('5')) section5();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
