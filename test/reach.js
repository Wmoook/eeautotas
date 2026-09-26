'use strict';
// The reach field v3 (src/reach.js). CPU unless --gpu. Sections:
//   A tables   the engine's numbers and the model's rules: Ra(JV) = 63.42, Rc(2), Rd(16), convex rise tables, VF[13] <
//              8.07 <= VF[14] (the landing-tick jump), the jump levels (7 on a floor, 8 on a lower half block), a 1-row
//              dot strip at rest reaches the upper half of the row above (q 0) but never enters it (q 1), the rise
//              tables against the engine itself, and each field's top speed against the engine's
//   B rooms    hand-made rooms with the answer known from the engine: the start is cut off (no way) or finite, and every
//              state of a real route is finite: the design set (ledges, dot steps and columns, arrows, one-ways, slots,
//              portals, a time door, a diagonal gap, the dot room, landing-tick jumps, a half-block bridge, an up boost),
//              strip-k (a 1-row dot strip does not lift the ball k >= 2 rows), up-pump (finite), shaft-lip (the user's
//              50x50 level: the start finite, its states ranked), rising-after-jump (never cheaper than standing)
//   C corpus   every state of every job's original and best run (--jobs=<dir>, default src/jobs) and of the known editor
//              routes (the dot stairs, the 40x25 shaft's 251-tick route) is reachable: 0 cut off
//   D fuzz     random rooms and random input runs, fields to the trophy and to random goal tiles: a state cut off at tick
//              t is cut off at t + 1 too (otherwise the model misses a real move)
//   E bellman  opts.check (every stored cost is its best edge + the target's cost) on 16 random levels with every block
//              kind; the goals / maxCost options (explore.js --hunt) and writeReachFile's refusal of a goals field
//   F agree    the JS lookup and the native tool's (eegpu reachtest: the host, and with --gpu the GPU) on 10k random
//              states per room give the same fifths (skipped without a native tool that reads RCH3)
//   G timing   200x200 and 400x400 random levels: fails above 3x the target (300 / 1200 ms), scaled by the machine's load
//              (the engine's single-thread speed now against its benchmark, --bench=<_system.json>)
// usage: node test/reach.js [--only=A,B,..] [--gpu] [--tool=<eegpu.exe>] [--jobs=<dir>] [--bench=<file>] [--quick]
// Exit code 1 if any check fails. Run the --gpu part through the machine's GPU lock (src/out/gpulock.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const R = require('../src/reach.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').toUpperCase().split(',').filter(Boolean);
const GPU = argv.includes('--gpu'), QUICK = argv.includes('--quick');
const want = (s) => !ONLY.length || ONLY.includes(s);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const fmt = (v) => (v < 0 ? 'CUT' : v.toFixed(1));
const levelOfCells = (W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells }))));
const levelOfB64 = (b) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(Buffer.from(b, 'base64'))));
// ASCII rooms: # wall, . air, S spawn, T trophy, o dot, ^ up arrow, < left arrow, > right arrow, ~ water, H ladder, x spike,
// - one-way rot 1, _ lower half block, B up boost, D down boost, C checkpoint, t time door, v down arrow, I ice, g low gravity,
// P portal id 1 -> 2 (rot 1), Q portal id 2 -> 1 (rot 3)
const ID = { '#': [9], S: [255], T: [121], o: [4], '^': [2], '<': [1], '>': [3], '~': [119], H: [120], x: [361, 1], '-': [1052, 1], _: [1041, 1], B: [116], D: [117],
	C: [360], t: [156], v: [1518], P: [242, 1, 1, 2], Q: [242, 3, 2, 1], L: [118], I: [1064], g: [453] };
function ascii(rows) {
	const H = rows.length, W = rows[0].length, cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; const v = ID[ch]; if (!v) throw new Error(`legend ${ch}`); cells.push([x, y, ...v]); }));
	return levelOfCells(W, H, cells);
}
const box = (inner) => ['#'.repeat(inner[0].length + 2), ...inner.map((r) => `#${r}#`), '#'.repeat(inner[0].length + 2)];
/** the level's start state after `settle` idle ticks */
function startSim(L, settle) { const s = new E.EESim(L); s.reset(); const I = new E.EEInput(); for (let t = 0; t < (settle || 0); t++) s.tick(I); return s; }
/** play masks from the start: every live state's cost; {n, cut, first, finished} */
function walk(L, f, masks) {
	const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput();
	let n = 0, cut = 0, first = null;
	const look = (t) => { if (sim.is_dead) return; n++; if (R.costAt(f, sim) < 0) { cut++; if (!first) first = { t, tile: [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4], state: R.stateAt(f, sim) }; } };
	look(0);
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (sim.has_silver_crown) return { n, cut, first, finished: true };
		look(t + 1);
	}
	return { n, cut, first, finished: false };
}
/** a small breadth-first search over inputs (cells of 1 px and 1/8 px/tick): a route to the trophy, or null */
function engineRoute(L, maxTicks, maxStates) {
	const OPTS = [0, 2, 4, 1, 3, 5, 8, 10, 12, 9, 11, 13, 16, 18, 20];
	const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput();
	let layer = [{ snap: sim.snapshot(), path: [] }];
	const seen = new Set();
	for (let t = 0; t < maxTicks && layer.length; t++) {
		const next = [];
		for (const nd of layer) {
			for (const m of OPTS) {
				sim.restore(nd.snap); E.applyMask(inp, m); sim.tick(inp);
				if (sim.is_dead) continue;
				if (sim.has_silver_crown) return nd.path.concat([m]);
				const key = `${Math.round(sim.px)},${Math.round(sim.py)},${Math.round(sim.speed_x * 8)},${Math.round(sim.speed_y * 8)},${sim.on_ground ? 1 : 0},${sim.jump_count},${sim._q0},${sim._q1}`;
				if (seen.has(key)) continue;
				seen.add(key);
				next.push({ snap: sim.snapshot(), path: nd.path.concat([m]) });
			}
		}
		layer = next.length > maxStates ? next.slice(0, maxStates) : next;
	}
	return null;
}
const seqOf = (...parts) => { const o = []; for (const [m, n] of parts) for (let k = 0; k < n; k++) o.push(m); return o; };

// ---------------------------------------------------------------- A tables
function sectionA() {
	section('A tables: the engine-measured rises and falls, and the rules built on them');
	const T = R.TABLES[0];
	check('Ra(JV) = 63.420 (a standing jump)', Math.abs(R.riseQ(R.JV, R.G, R.G, 0) - 63.42) < 0.01, R.riseQ(R.JV, R.G, R.G, 0).toFixed(3));
	check('Rc(2) = 11.58 (2 ticks of dots in the queue, U held)', Math.abs(R.interp(T.RC, 2) - 11.58) < 0.05, R.interp(T.RC, 2).toFixed(3));
	check('Rd(16) = 309.54 (2 ticks of up arrows in the queue)', Math.abs(R.interp(T.RD, 16) - 309.54) < 0.05, R.interp(T.RD, 16).toFixed(3));
	let convex = true, upper = true;
	for (const a of [T.RA, T.RC, T.RD]) for (let i = 1; i + 1 < a.length; i++) if (a[i + 1] - 2 * a[i] + a[i - 1] < -1e-9) convex = false;
	check('the rise tables are convex (a chord between grid points lies above: interpolation errs toward more reach)', convex);
	// the ice tables (10 ticks of less drag) bend down at the 16 px/tick cap: there the lookup takes the upper grid value;
	// either way the value between grid points is at least the engine's
	for (const tb of R.TABLES) for (const [k, m0] of [['RA', R.G], ['RC', -1 / 7.752], ['RD', -2 / 7.752]]) for (let i = 0; i < 256; i++) for (const fr of [0.25, 0.5, 0.75]) {
		const v = (i + fr) / 16;
		if (R.interp(tb[k], v) < R.riseQ(-v, m0, m0, tb.nIce) - 1e-9) upper = false;
	}
	check('every rise table between its grid points is at least the engine\'s rise (the ice tables too)', upper);
	check('VF[13] < 8.07 <= VF[14] (the landing-tick jump needs 8.07 px/tick; the model allows it from VF level 13)', R.VF[13] < 8.07 && 8.07 <= R.VF[14] && R.KLJ <= 14, `VF ${R.VF[13].toFixed(3)} ${R.VF[14].toFixed(3)}, KLJ ${R.KLJ}`);
	// the rise from a real engine run: a jump from a floor, and from 2 dot ticks in the queue
	const L = ascii(box(['......', '......', '......', '......', '......', '......', '..S...']));
	const s = startSim(L, 20), I = new E.EEInput(), y0 = s.py;
	E.applyMask(I, 1); s.tick(I);
	let top = s.py; E.applyMask(I, 0);
	for (let t = 0; t < 60; t++) { s.tick(I); top = Math.min(top, s.py); }
	check('a real standing jump rises 63.42 px (the engine)', Math.abs(y0 - top - 63.42) < 0.01, (y0 - top).toFixed(3));
	// the jump levels: 7 on a floor (55.42 px above the tile's top edge), 8 on a lower half block (63.42)
	const Lh = ascii(box(['......', '......', '......', '......', '..S...', '...___']));
	const fh = R.reachField(Lh, { debug: true }), J = fh._m.J;
	check('the jump: level 7 on a floor, 8 on a lower half block', J[6 * 8 + 1] === 7 && J[6 * 8 + 5] === 8, `floor ${J[6 * 8 + 1]}, half ${J[6 * 8 + 5]}`);
	// a 1-row dot strip at rest: the centre reaches the upper half of the row above (q 0), never into it (q 1)
	const Ld = ascii(box(['..........', '..........', '..........', '...S......', 'oooooooooo']));
	const fd = R.reachField(Ld, { debug: true }), m = fd._m;
	let q = -9;
	const t0 = 5 * 12 + 4;   // a dot tile of the strip
	const cStop = m.stopC(t0);
	m.fwd(m.prof[m.pid[t0]], m.prof[m.pid[t0 - 12]], 0, -1, R.C_, cStop, (ty, l) => { if (ty === R.R_) q = l; });
	check('a 1-row dot strip at rest: the row above with q 0 (its upper half), never q 1', q === 0, `C level ${cStop}, q ${q}`);
	// every field's top speed (the model's cap) against the engine: a tall column held up (and not), from rest
	const caps = [];
	let capsOk = true;
	for (const [id, cls] of [[4, R.DOTS], [1, R.DOTS], [120, R.CLIMB], [459, R.CLIMB], [119, R.WATER], [369, R.MUD], [416, R.MUD], [2, R.UP]]) {
		// a field 5 wide and 24 rows high over a floor, the ball walks in from the right at the bottom (at rest vertically)
		// and then holds up (and left, or jump too)
		const W = 9, H = 28, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) { cells.push([0, y, 9], [W - 1, y, 9]); if (y >= 2) for (let x = 1; x <= 5; x++) cells.push([x, y, id]); }
		cells.push([7, H - 2, 255]);
		const Lc = levelOfCells(W, H, cells);
		let best = 0;
		for (const mask of [8, 10, 9]) {
			const sc = startSim(Lc, 0), Ic = new E.EEInput();
			for (let t = 0; t < 600; t++) {
				E.applyMask(Ic, t < 30 ? 2 : mask); sc.tick(Ic);
				const tx = Math.trunc(sc.px + 8) >> 4, ty = Math.trunc(sc.py + 8) >> 4;
				if (tx >= 1 && tx <= 5 && ty >= 2 && ty <= H - 2 && -sc.speed_y > best) best = -sc.speed_y;
			}
		}
		caps.push(`${id} ${best.toFixed(3)} <= ${R.CAP_CLASS[cls].toFixed(3)}`);
		if (best > R.CAP_CLASS[cls] + 1e-9 || best <= 0) capsOk = false;
	}
	check('every field class: the engine\'s top upward speed in a tall column is within the model\'s cap', capsOk, caps.join('; '));
}

// ---------------------------------------------------------------- B rooms
const USER50 = 'xZTZTsJAFIY/wA3FBcUNxRYo++4LeGG8MPEBjHdGS2KCkJio8c431/yVQqc1xMSI82XaOefMxXxnmpIYjp5JX1zb50/uq31559pX7os7AE41z97hA2PESD3e3rv2qN8fPAxdIPlViN941TgJFlhkiWVWSLLKGinW2WCTLdJss0OGXfbY54BDshxxTI4TLGzyFCjiUKJMhSo16jRo0qJNhy49+Lc5PZsindVfmW/LWPn7c1iTtensZ2d1JrgnG4qsmXEGy4ii9d9n5nDr3tf19yPmuchGPjKSk6zkJTO5yU5+MpSjLOUpU7nKVr4ylrOs5S1zucte/uqAeqAuBLEn5McUxhQnOAFKAcrfUvkBVYNaiHqIhkEzQitCO0InQjdCbw7A2/j+4zjes8j0x+fnGp8=';
const SHAFT = 'rZFrTgIxFEYPoLxmeM0ABUUZ5LkLVuAiSCyJyfgIP0jmnwtxr5o7wNDWqCGZnrS5t1/SnrSU3+NNondUH5Mo1nsdAytguP7AHQX8l82Tjt622/j5VQO1Y/CZpkVKXHFNmQpVatTx8GnQpEWbDgEhXXr0UQwYcsMtI+64Z0zEhAemzJizYAn/TvOEQy8n2ZXcc8pVVh1szOzkaRqes8Cq1a+djzJqN7ukz/kt0//JdxRSR7EUTzEVV7EVXzG2qWd4Gb5BI6P5g9YftA06FoFFaNB16Dn0HZTDIGcgOb5qkVG6esCXsxd+Aw==';
const SHAFT_ROUTE = '222222323232322504442422220222222222222222222222223232323240402022222222222222222222322322222222222222004444044444444444444444444544444444444444444444444444445445445444444444445444545402222222222222222222222222222245454544544445444444444444444444444000000';
const DOTSTAIRS = 'rZPLTsJAFIa/YimlLTdBKoqCd9e+gE/glj2JJSGpl7gwdueba+Z0pszQuCAyX3pmcub29z8twXu+LLIPwqdinmefWQ7cA5PHb7abR/KyfM7mb6tVvn7NgLae+JLZBgf4hLSJiEno0KVHnwGHDBlxxJiUYyaccMqUM86ZMeeCS6645oZb7sB5urW4fXKZM73JtGSUynizqr6vzGxGMyfvqnRvNwrtd7OV2y7YeeNTk4DW/90S7/fVPFGn9CmFvqhsitJA1NYJNe2KyCLWJDU6FV2H3p/0HQbik8tQfFPOuYzFSeXlfgFf+7bYqZpmzq2qybr/wsKqjKmOXSG3OqGDqUZsYbyHQp/coC8xAG+tcw+yardvUe1SN6Y7od4Mf6rv9UWj6iPpPf2UOhOJscSyhdX3VI7N3/xT7Ykkjn4B';
const DOTSTAIRS_ROUTE = 'NTQwNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDU0NDQ0NDQ0NDQyMjA0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0MDU0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0MjUwNDQ0MDAwMDAwMjIyMjI6Ojo6MjJCQjIyMkJCMjJCQjoyOjoyMjIyMjIyMjoyMjo6Ojo6Ojo6Ojo6OjoyMjo6Ojo6MjIyMkI6OjI6OjoyMjIyMjJCQjIyMjIyMjIyMjA=';
const ROOMS = [
	// [name, expected: 'yes' (the engine finishes: finite, a route's states finite) / 'no' (the model proves no way: cut off) /
	//  'finite' (unknown to the engine search here, or the model's known optimism: finite), rows (a wall border is added)]
	['ledge3', 'yes', ['..............', '..............', '..............', '..............', '.........T....', '........######', '........######', '..S.....######']],
	['ledge4', 'no', ['..............', '..............', '..............', '.........T....', '........######', '........######', '........######', '..S.....######']],
	['dotstep1', 'yes', ['..............', '..............', '..............', '..............', '..S.......T...', 'oooooooooo####']],
	['dotstep2', 'no', ['..............', '..............', '..............', '..........T...', '..S.......####', 'oooooooooo####']],
	['dotcol4', 'yes', ['..............', '..............', '..............', '..............', '....T.........', '....#o#.......', '....#o#.......', '.S..#o#.......', 'oooooo#.......']],
	['dotcol4hi', 'no', ['..............', '..............', '....T.........', '....#.#.......', '....#.#.......', '....#o#.......', '....#o#.......', '.S..#o#.......', 'oooooo#.......']],
	['shaftjump', 'no', ['#####.....#####', '#####...T.#####', '#####...#######', '#####...#######', '#####...#######', '#####...#######', '#####.S.#######']],
	['pocket', 'finite', ['#####.....#####', '#####...T.#####', '#####...#######', '####....#######', '#####...#######', '#####...#######', '#####.S.#######']],
	['oneway', 'yes', ['..............', '.......-......', '.......-......', '.......-......', '.......-......', '..S....-...T..']],
	['upshaft', 'yes', ['..............', '..............', '..............', '..............', '.......T......', '......####....', '.....^####....', '.....^####....', '.....^####....', '.....^####....', '.....^####....', '..S..^####....']],
	['boost', 'yes', ['..............', '.........T....', '........######', ...Array(9).fill('..............'), '..S..B........']],
	['portal', 'yes', ['.........#####', '.........#.T.#', '.........#Q..#', '.........#####', '..S..P........']],
	['timedoor', 'yes', ['..........#...', '..........#...', '..S.......t..T']],
	['slot', 'yes', ['................', '................', '.......#########', '..............T.', '......##########', '.....###########', '....############', '.S.#############']],
	['slothi', 'finite', ['................', '.......#########', '..............T.', '.......#########', '......##########', '.....###########', '....############', '.S.#############']],
	['diag', 'no', ['..............', '..............', '.......#######', '.......#....T#', '.......#.....#', '......########', '..S...........']],
	['dotroom', 'no', ['..............', '..............', '.#########....', '.#T.oooo.#....', '.#.......#....', '.#...S...#....', '.#ooooooo#....', '.#########....']],
	['pit26', 'finite', ['..............................', '..............................', '..............................', '.S..........................T.', '##xxxxxxxxxxxxxxxxxxxxxxxxxx##']],
	['jump3', 'yes', ['......', '......', '....T.', '.#####', '......', 'S.....']],
	['jump4', 'no', ['......', '....T.', '.#####', '......', '......', 'S.....']],
	['jumpdots', 'finite', ['.....', '..T..', '.....', '.....', '..o..', '..o..', '.....', '..S..']],
	['lj16', 'yes', ['.S.########', ...Array(13).fill('...########'), '...########', '...#.....##', '...#..T..##', '...#.######', '..........', '..........', '<<<<<<<<<<']],
	['lj10', 'no', [...Array(9).fill('##########'), '.S.#######', ...Array(4).fill('...#######'), '...#######', '...#.....#', '...#..T..#', '...#.#####', '..........', '..........', '<<<<<<<<<<']],
	['halfbridge', 'yes', ['..................', '..................', '..................', '..................', '..................', '..................', '..................', '..................', '..................', '..................', '..................', '..................', '..........T.......', '.........####.....', '..................', '.....S............', '..______..........', 'xxxxxxxxxxxxxxxxxx']],
	['upboost', 'yes', ['..T..', ...Array(16).fill('.....'), '.....', '..B..', 'S....']],
];
/** strip-k: a 1-row dot strip on a floor, air beside it over spikes, the trophy k rows above the strip's row */
function stripK(k) {
	const rows = [];
	for (let y = 1; y <= 9; y++) {
		if (y === 8 - k) rows.push('....T.....');
		else if (y === 7) rows.push('..S.......');
		else if (y === 8) rows.push('ooooo.....');
		else if (y === 9) rows.push('####xxxxxx');
		else rows.push('..........');
	}
	return ascii(box(rows));
}
/** up-pump: a 1-wide shaft, an up-arrow column of h rows, the spawn 2 rows above it, the trophy k rows above its top */
function pump(h, k) {
	const H = 14 + h, W = 7, cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x !== 3 || y === 0 || y === H - 1) cells.push([x, y, 9]);
	const colTop = H - 1 - h;
	for (let y = colTop; y < H - 1; y++) cells.push([3, y, 2]);
	cells.push([3, colTop - 2, 255], [3, colTop - k, 121]);
	return levelOfCells(W, H, cells);
}
function sectionB() {
	section('B rooms: the start\'s value against the engine\'s answer');
	for (const [name, want, rows] of ROOMS) {
		const L = ascii(box(rows));
		const f = R.reachField(L, { check: true });
		const s = startSim(L, 30), c = R.costAt(f, s);
		let ok = want === 'no' ? c < 0 : c >= 0;
		let detail = `start ${fmt(c)}, ${f.mismatches} mismatches`;
		if (want === 'yes' && !QUICK && L.width * L.height <= 400) {
			// the engine's route (a small search): every state on it finite
			const route = engineRoute(L, 700, 1500);
			if (route) { const w = walk(L, f, route); ok = ok && w.cut === 0 && w.finished; detail += `; engine route ${route.length} ticks, ${w.cut} states cut off${w.first ? ` (first ${JSON.stringify(w.first)})` : ''}`; }
			else detail += '; (the small engine search found no route)';
		}
		check(`${name}: ${want === 'no' ? 'no way (cut off)' : want === 'yes' ? 'the engine finishes: finite' : 'finite'}`, ok && f.mismatches === 0, detail);
	}
	for (const k of [2, 3, 4, 7]) {
		const L = stripK(k), f = R.reachField(L), c = R.costAt(f, startSim(L, 30));
		check(`strip-k, the trophy ${k} rows above a 1-row dot strip: cut off`, c < 0, fmt(c));
	}
	{
		const L = stripK(1), f = R.reachField(L), c = R.costAt(f, startSim(L, 30));
		check('strip-k with k = 1 (the row right above the strip, which the ball does reach): finite', c >= 0, fmt(c));
	}
	for (const h of [3, 5]) {
		const L = pump(h, 3), f = R.reachField(L), c = R.costAt(f, startSim(L, 0));
		const s = startSim(L, 0), I = new E.EEInput();
		let got = false;
		for (let t = 0; t < 3000 && !got; t++) { s.tick(I); if (s.has_silver_crown) got = true; }
		check(`up-pump: a ${h}-row up-arrow column, the trophy 3 rows above it: finite (the engine gets there with no input)`, c >= 0 && got, `${fmt(c)}, engine ${got ? 'yes' : 'no'}`);
	}
	// shaft-lip: the user's 50x50 level (no route: every move runs out of states at tick 185): the start stays finite
	// (the model cannot prove it), and the states are ranked
	{
		const L = levelOfB64(USER50), f = R.reachField(L, { check: true });
		const s0 = startSim(L, 0), base = (s0.tick(new E.EEInput()), s0.snapshot());
		const at = (cx, cy, vy, g) => { s0.restore(base); s0.px = cx * 16 - 8; s0.py = cy * 16 - 8; s0.speed_y = vy; s0.speed_x = 0; s0.on_ground = !!g; s0.jump_count = g ? 0 : 1; s0._q0 = 0; s0._q1 = 0; return R.costAt(f, s0); };
		const start = R.costAt(f, startSim(L, 0));
		const notch = at(35.5, 36.5, -3, 0), mouth = at(33.5, 37.9, -1, 0), lip = at(31.9, 40.5, 0, 1), fromLip = at(32.4, 40.2, -6.5, 0), pocket = at(32.5, 37.5, 0, 1);
		check('shaft-lip (user50): the start finite (only "every move" running out of states shows there is no route)', start >= 0 && f.mismatches === 0, fmt(start));
		check('shaft-lip: rising at 3 px/tick under the notch costs >= 5 tiles (not "almost there")', notch >= 5, fmt(notch));
		check('shaft-lip: the pocket mouth rising at 1 px/tick > standing on the lip > rising from the lip > standing in the pocket', mouth > lip && lip > fromLip && fromLip > pocket && pocket >= 0,
			`${fmt(mouth)} > ${fmt(lip)} > ${fmt(fromLip)} > ${fmt(pocket)}`);
	}
	// rising-after-jump: the first rising ticks of a jump never cost less than standing (the grid rounding bug of rf2 / pf)
	for (const name of ['ledge4', 'ledge3']) {
		const L = ascii(box(ROOMS.find((r) => r[0] === name)[2])), f = R.reachField(L);
		const s = startSim(L, 30), stand = R.costAt(f, s), I = new E.EEInput();
		let worst = Infinity, wrong = 0, n = 0;
		const tile = (Math.trunc(s.py + 8) >> 4) * L.width + (Math.trunc(s.px + 8) >> 4);
		E.applyMask(I, 1); s.tick(I); E.applyMask(I, 0);
		for (let t = 0; t < 10 && (Math.trunc(s.py + 8) >> 4) * L.width + (Math.trunc(s.px + 8) >> 4) === tile; t++) {   // (while in the standing tile)
			const c = R.costAt(f, s);
			n++;
			if (stand < 0 ? c >= 0 : c < 0 || c < stand - 1e-9) wrong++;
			worst = Math.min(worst, c);
			s.tick(I);
		}
		check(`rising-after-jump (${name}): the jump's rising ticks in the standing tile cost no less than standing`, wrong === 0 && n > 0, `standing ${fmt(stand)}, ${n} rising ticks there, min ${fmt(worst)}`);
	}
}

// ---------------------------------------------------------------- C corpus
function sectionC() {
	section('C corpus: every state of every known run is reachable');
	const JOBS = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	const DATA = path.join(JOBS, '..', 'data');
	let jobs = [];
	try { jobs = fs.readdirSync(JOBS).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(JOBS, d, 'meta.json'))); } catch (e) { /* none */ }
	if (!jobs.length) console.log(`  (no jobs in ${JOBS})`);
	for (const id of jobs) {
		const lf = path.join(DATA, `job_${id.replace(/-/g, '_')}.json`);
		let level;
		try { level = fs.existsSync(lf) ? E.loadLevel(lf) : E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(JOBS, id, 'original.eelvl'))))); } catch (e) { console.log(`  (${id}: ${e.message})`); continue; }
		if (QUICK && level.width * level.height > 20000) continue;
		const f = R.reachField(level);
		for (const run of ['original.eetas', 'best.eetas']) {
			const file = path.join(JOBS, id, run);
			if (!fs.existsSync(file)) continue;
			const w = walk(level, f, C.readEetas(file));
			check(`${id} ${run} (${f.mode})`, w.cut === 0, `${w.n} states, ${w.cut} cut off${w.first ? `, first ${JSON.stringify(w.first)}` : ''}`);
		}
	}
	const route = (s) => Uint8Array.from(s, (c) => (c.charCodeAt(0) - 48) & 31);
	for (const [name, lv, rt] of [['the dot stairs route (197 ticks)', DOTSTAIRS, route(Buffer.from(DOTSTAIRS_ROUTE, 'base64').toString('latin1'))], ['the 40x25 shaft\'s 251-tick route (salt 8)', SHAFT, route(SHAFT_ROUTE)]]) {
		const L = levelOfB64(lv), f = R.reachField(L), w = walk(L, f, rt);
		check(`${name}: finishes, every state reachable`, w.finished && w.cut === 0, `${w.n} states, ${w.cut} cut off`);
	}
	// the editor's last closest attempt and its level, when there is one
	const ed = path.join(JOBS, '..', 'data', 'editor');
	if (fs.existsSync(path.join(ed, 'level.eelvl')) && fs.existsSync(path.join(ed, 'closest.eetas'))) {
		const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(ed, 'level.eelvl'))))), f = R.reachField(L), w = walk(L, f, C.readEetas(path.join(ed, 'closest.eetas')));
		check('the editor\'s closest attempt on its level', w.cut === 0, `${w.n} states, ${w.cut} cut off`);
	}
}

// ---------------------------------------------------------------- D fuzz
function sectionD() {
	section('D fuzz: cut off at tick t implies cut off at t + 1');
	let seed = 20260926;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
	const IDS = [9, 9, 9, 9, 9, 4, 4, 1, 2, 3, 2, 119, 369, 416, 116, 117, 114, 120, 361, 1052, 1041, 1518, 23, 43, 360, 2, 4, 1064];
	const rot = (id) => id === 1052 || id === 1041;
	function randomRoom(k) {
		const W = 12 + Math.floor(rnd() * 20), H = 10 + Math.floor(rnd() * 12), cells = room(W, H);
		const dens = 0.12 + rnd() * 0.25, kinds = IDS.filter(() => rnd() < 0.5);
		if (!kinds.length) kinds.push(9);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			if (rnd() >= dens) continue;
			const id = rnd() < 0.5 ? 9 : kinds[Math.floor(rnd() * kinds.length)];
			cells.push(rot(id) ? [x, y, id, Math.floor(rnd() * 4)] : id === 43 || id === 23 ? [x, y, id, 1] : [x, y, id]);
		}
		for (let n = 0; n < 3; n++) {
			const id = kinds[Math.floor(rnd() * kinds.length)], x0 = 1 + Math.floor(rnd() * (W - 3)), y0 = 1 + Math.floor(rnd() * (H - 3)), len = 2 + Math.floor(rnd() * 5), vert = rnd() < 0.5;
			for (let i = 0; i < len; i++) { const x = vert ? x0 : x0 + i, y = vert ? y0 + i : y0; if (x > 0 && y > 0 && x < W - 1 && y < H - 1) cells.push(rot(id) ? [x, y, id, Math.floor(rnd() * 4)] : [x, y, id]); }
		}
		if (k % 3 === 0) cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 0, 1, 2], [1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 1, 2, 1]);
		cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * Math.max(1, (H - 2) / 2)), 121], [1 + Math.floor(rnd() * (W - 2)), H - 2, 255]);
		return { W, H, cells };
	}
	function puzzleRoom() {   // the trophy at the edge of what one mechanism reaches
		const W = 16 + Math.floor(rnd() * 10), H = 14 + Math.floor(rnd() * 8), cells = room(W, H);
		const put = (x, y, ...a) => { if (x > 0 && y > 0 && x < W - 1 && y < H - 1) cells.push([x, y, ...a]); };
		const fx = 6 + Math.floor(rnd() * (W - 12)), fl = H - 2;
		const kind = ['ledge', 'col', 'col', 'col', 'strip', 'half', 'oneway', 'lj'][Math.floor(rnd() * 8)];
		const h = 1 + Math.floor(rnd() * 5), d = Math.floor(rnd() * 4) - 1;
		let tx = fx + 1, ty = fl - h;
		if (kind === 'ledge') { for (let x = fx; x <= fx + 2; x++) for (let y = fl - h + 1; y <= fl; y++) put(x, y, 9); if (rnd() < 0.4) put(fx - 1, fl, 1041, 1); }
		else if (kind === 'col') {
			const id = [4, 2, 119, 120, 369, 416, 1, 3, 2, 4][Math.floor(rnd() * 10)];
			for (let y = fl - h + 1; y <= fl; y++) put(fx, y, id);
			if (rnd() < 0.5) for (let y = fl - h + 1; y <= fl; y++) put(fx - 1, y, 9);
			const top = Math.max(1, fl - h - d);
			for (let x = fx + 1; x <= fx + 2; x++) for (let y = top + 1; y <= fl; y++) put(x, y, 9);
			ty = top;
		} else if (kind === 'strip') {
			const id = [4, 4, 1, 3, 119, 120][Math.floor(rnd() * 6)];
			for (let x = fx - 2; x <= fx + 2; x++) put(x, fl, id);
			tx = fx; ty = fl - 1 - Math.floor(rnd() * 4);
		} else if (kind === 'half') { for (let x = fx; x <= fx + 3; x++) { for (let y = fl - h + 2; y <= fl; y++) put(x, y, 9); put(x, fl - h + 1, 1041, 1); } }
		else if (kind === 'oneway') { for (let y = fl - h + 1; y <= fl; y++) put(fx, y, 1052, Math.floor(rnd() * 4)); tx = fx + 2; ty = fl - Math.floor(rnd() * 4); for (let y = ty + 1; y <= fl; y++) put(fx + 2, y, 9); }
		else { const id = [4, 1, 2, 119, 120][Math.floor(rnd() * 5)]; for (let x = fx - 2; x <= fx + 2; x++) put(x, fl, id); for (let x = fx + 3; x <= fx + 4; x++) for (let y = fl - 3 - (d + 1); y <= fl; y++) put(x, y, 9); tx = fx + 3; ty = fl - 4 - (d + 1); }
		for (let n = 0; n < W * H * 0.03; n++) put(1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 3)), [9, 4, 2, 361, 1052][Math.floor(rnd() * 5)]);
		cells.push([tx, Math.max(1, ty), 121], [2, fl, 255]);
		return { W, H, cells };
	}
	const OPTS = [0, 1, 2, 4, 8, 16, 3, 5, 9, 10, 12, 17, 18, 20, 24, 11, 13];
	const ROOMSN = QUICK ? 12 : 40, RUNS = QUICK ? 20 : 50, TICKS = 300, GOALS = 3;
	let pairs = 0, cut = 0, viol = 0, runs = 0, first = null;
	for (let k = 0; k < ROOMSN; k++) {
		const rm = k % 2 ? puzzleRoom() : randomRoom(k);
		let L;
		try { L = levelOfCells(rm.W, rm.H, rm.cells); } catch (e) { continue; }
		const fields = [R.reachField(L)];
		if (fields[0].mode !== 'physics') continue;
		for (let g = 0; g < GOALS; g++) {
			for (let tries = 0; tries < 50; tries++) {
				const x = 1 + Math.floor(rnd() * (rm.W - 2)), y = 1 + Math.floor(rnd() * (rm.H - 2) * (rnd() < 0.7 ? 0.6 : 1)), i = y * rm.W + x;
				if (fields[0].cls[i] === R.WALL || fields[0].cls[i] === R.DEADLY) continue;
				fields.push(R.reachField(L, { goals: [{ tile: i, cost: 0 }] }));
				break;
			}
		}
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let r = 0; r < RUNS; r++) {
			runs++;
			sim.reset();
			let m = OPTS[Math.floor(rnd() * OPTS.length)];
			let prev = fields.map((f) => R.fifthsAt(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery)), prevS = null;
			for (let t = 0; t < TICKS; t++) {
				if (rnd() < 0.12) m = OPTS[Math.floor(rnd() * OPTS.length)];
				E.applyMask(inp, m);
				sim.tick(inp);
				if (sim.has_silver_crown || sim.is_dead) break;
				const now = fields.map((f) => R.fifthsAt(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery));
				for (let fi = 0; fi < fields.length; fi++) {
					pairs++;
					if (now[fi] < 0) cut++;
					if (prev[fi] < 0 && now[fi] >= 0) { viol++; if (!first) first = { room: k, field: fi, run: r, tick: t, before: prevS && prevS[fi], after: R.stateAt(fields[fi], sim) }; }
				}
				prev = now;
				if (!first) prevS = fields.map((f) => R.stateAt(f, sim));
			}
		}
	}
	check(`${runs} random runs of ${TICKS} ticks in ${ROOMSN} rooms (fields to the trophy and ${GOALS} goal tiles each): no state finite right after a cut-off one`, viol === 0 && pairs > 0,
		`${pairs} pairs, ${cut} cut off, ${viol} violations${first ? `; first ${JSON.stringify(first)}` : ''}`);
}

// ---------------------------------------------------------------- E bellman
function randomLevels() {
	let seed = 11;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const ids = [9, 9, 9, 9, 4, 4, 1, 2, 3, 361, 1052, 1041, 119, 369, 416, 120, 116, 117, 114, 1518, 23, 43, 360];
	const out = [];
	for (let k = 0; k < 16; k++) {
		const W = 14 + (k % 4) * 6, H = 10 + (k % 3) * 5, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rnd() < 0.22) { const id = ids[Math.floor(rnd() * ids.length)]; cells.push(id === 1052 || id === 1041 ? [x, y, id, Math.floor(rnd() * 4)] : id === 43 || id === 23 ? [x, y, id, 1] : [x, y, id]); }
		if (k % 4 === 0) cells.push([2, 2, 242, 0, 1, 2], [W - 3, 2, 242, 0, 2, 1]);
		cells.push([Math.floor(W / 2), 2, 121], [2, H - 2, 255]);
		out.push({ W, H, level: levelOfCells(W, H, cells) });
	}
	return out;
}
function sectionE() {
	section('E bellman: every stored cost is its best edge + the target\'s cost');
	const levels = randomLevels();
	let bad = 0, states = 0;
	for (const { level } of levels) { const f = R.reachField(level, { check: true }); if (f.mismatches) bad++; states += f.labels; }
	check(`${levels.length} random levels with every block kind: 0 mismatches`, bad === 0, `${bad} with mismatches (${states} labels)`);
	// the goals option (explore.js --hunt): the trophy tiles as goals give the default field; goals at their own costs pass
	// the self-check; maxCost keeps every cost up to it and cuts the rest; a goals field is never written for eegpu
	let same = 0;
	for (const { level } of levels) {
		const tr = [];
		for (let i = 0; i < level.fg.length; i++) if (level.fg[i] === 121) tr.push({ tile: i, cost: 0 });
		const a = R.reachField(level), b = R.reachField(level, { goals: tr });
		if (['costR', 'costF', 'costL', 'costC', 'costX'].every((k) => a[k].length === b[k].length && a[k].every((v, i) => v === b[k][i]))) same++;
	}
	check('the trophy tiles as goals give the default field', same === levels.length, `${same} of ${levels.length}`);
	let seed = 5;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	let badG = 0, badCut = 0, kept = 0, cutN = 0;
	for (const { W, H, level } of levels) {
		const goals = [];
		for (let k = 0; k < 12; k++) goals.push({ tile: (1 + Math.floor(rnd() * (H - 2))) * W + 1 + Math.floor(rnd() * (W - 2)), cost: Math.floor(rnd() * 40) / 2 });
		const f = R.reachField(level, { goals, check: true });
		if (f.mismatches) badG++;
		let top = 0;
		for (const k of ['costR', 'costF']) for (const v of f[k]) if (v !== R.CUT && v > top) top = v;
		const maxCost = top / 5 / 2, g = R.reachField(level, { goals, maxCost, check: true });
		let wrong = g.mismatches;
		for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) for (let i = 0; i < f[k].length; i++) {
			if (f[k][i] !== R.CUT && f[k][i] <= maxCost * 5) { kept++; if (g[k][i] !== f[k][i]) wrong++; } else { cutN++; if (g[k][i] !== R.CUT) wrong++; }
		}
		if (wrong) badCut++;
	}
	check('12 goal tiles at their own costs per level: 0 mismatches', badG === 0, `${badG} levels with mismatches`);
	check(`maxCost = half the highest cost: the same costs up to it (${kept} states), cut off beyond (${cutN})`, badCut === 0 && kept > 0 && cutN > 0, `${badCut} levels wrong`);
	let refused = false;
	try { R.writeReachFile(R.reachField(levels[0].level, { goals: [{ tile: 0, cost: 0 }] }), path.join(os.tmpdir(), `reach_goals_${process.pid}.bin`)); } catch (e) { refused = true; }
	check('writeReachFile refuses a goals field (its cut-off states are no proof)', refused);
}

// ---------------------------------------------------------------- F agree
function sectionF() {
	section(`F agree: the JS lookup = the native tool's (host${GPU ? ' and GPU' : ''})`);
	const tool = arg('tool', require('../src/gpu.js').nativeTool());
	// (the host check needs no GPU: an old tool without reachtest is skipped, not asked for its `info`, which opens the GPU)
	let usage = '';
	if (tool) { try { execFileSync(tool, ['reachtest'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { usage = String(e.stderr || ''); } }
	if (!tool || !/reachtest/.test(usage)) { console.log(`  (skipped: ${tool ? `${tool} has no reachtest (older than the app: rebuild it, node tools/build-native.js)` : 'no native tool'})`); return; }
	const G = require('../src/gpu.js');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-reach-'));
	let seed = 3;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const rooms = [['user50', levelOfB64(USER50)], ['shaft', levelOfB64(SHAFT)], ['dot stairs', levelOfB64(DOTSTAIRS)], ...['upshaft', 'boost', 'portal', 'halfbridge', 'lj16', 'dotroom'].map((n) => [n, ascii(box(ROOMS.find((r) => r[0] === n)[2]))]),
		['every block (portals, deaths)', randomLevels()[4].level], ['ice', ascii(box(['..........', '..........', '....oo..^.', '..S.....^.', 'IIIIIIIIII']))], ['walk (low gravity)', ascii(box(['.....T....', '..######..', '..........', '..S..g....']))]];
	for (const [name, L] of rooms) {
		const f = R.reachField(L);
		fs.writeFileSync(path.join(tmp, 'l.bin'), G.levelBlob(L));
		R.writeReachFile(f, path.join(tmp, 'r.bin'));
		const n = QUICK ? 2000 : 10000, st = new Float64Array(n * 6), ids = [...new Set(L.fg)];
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let i = 0; i < n; i++) {
			if (i % 2 === 0) {   // real states of random runs
				E.applyMask(inp, [0, 1, 2, 4, 5, 9, 12, 16, 3][Math.floor(rnd() * 9)]);
				sim.tick(inp);
				if (sim.is_dead || sim.has_silver_crown || rnd() < 0.003) sim.reset();
				st.set([sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery], i * 6);
			} else if (i % 10 === 1) {   // edges: off the level, huge speeds, odd queue ids, long slipperiness
				const pick = (a) => a[Math.floor(rnd() * a.length)];
				st.set([pick([-40, -8.0001, -8, 0, L.width * 16 - 8, L.width * 16 - 7.99, L.width * 16 + 50, rnd() * L.width * 16]), pick([-40, -8.0001, -8, 0, L.height * 16 - 8, L.height * 16 - 7.99, L.height * 16 + 50, rnd() * L.height * 16]),
					pick([-1e9, -30, -22.72, -16.0001, -16, -1e-300, 0, -0, 1e-300, 13.6, 16, 22.72, 30, 1e9]), pick([-1, -100, 0, 4095, 4096, 65535, 1e6]), pick([-1, 2, 4, 119, 2e6]), pick([0, 1e-300, 0.2, 2, 5, 100])], i * 6);
			} else st.set([rnd() * (L.width * 16 - 16), rnd() * (L.height * 16 - 16), (rnd() - 0.5) * 36, ids[Math.floor(rnd() * ids.length)], rnd() < 0.1 ? -1 : ids[Math.floor(rnd() * ids.length)], rnd() < 0.3 ? rnd() * 2 : 0], i * 6);
		}
		fs.writeFileSync(path.join(tmp, 's.bin'), Buffer.from(st.buffer));
		let out;
		try { out = JSON.parse(execFileSync(tool, ['reachtest', path.join(tmp, 'l.bin'), path.join(tmp, 'r.bin'), path.join(tmp, 's.bin'), ...(GPU ? ['--gpu=1'] : [])], { encoding: 'utf8', maxBuffer: 1 << 27, timeout: 120000 }).trim().split('\n').pop()); } catch (e) { out = { error: e.message }; }
		if (out.error) { check(`${name}: eegpu reachtest`, false, out.error); continue; }
		let bad = 0, firstBad = null;
		for (let i = 0; i < n; i++) {
			const js = R.fifthsAt(f, st[i * 6], st[i * 6 + 1], st[i * 6 + 2], st[i * 6 + 3], st[i * 6 + 4], st[i * 6 + 5]);
			if (js !== out.host[i] || (out.gpu && js !== out.gpu[i])) { bad++; if (!firstBad) firstBad = { s: Array.from(st.slice(i * 6, i * 6 + 6)), js, host: out.host[i], gpu: out.gpu ? out.gpu[i] : null }; }
		}
		check(`${name} (${f.mode}${f.ice ? ', ice' : ''}${f.deaths ? ', deaths' : ''}): ${n} states, the same fifths${out.gpu ? ' on the host and the GPU' : ' on the host'}`, bad === 0 && (!GPU || !!out.gpu), `${bad} differ${firstBad ? `; first ${JSON.stringify(firstBad)}` : ''}`);
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- G timing
async function sectionG() {
	section('G timing: the build on big random levels');
	// the machine's load: the engine's single-thread speed now against its benchmark (src/bench.js), when known
	let load = 1;
	const BENCH = require('../src/bench.js');
	let ref = null;
	try { ref = JSON.parse(fs.readFileSync(arg('bench', BENCH.CACHE), 'utf8')).single; } catch (e) { ref = null; }
	if (ref > 0) { const now = await BENCH.measure(1, 400); if (now > 0) load = Math.max(1, ref / now); }
	let seed = 7;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	for (const [W, H, target] of QUICK ? [[200, 200, 300]] : [[200, 200, 300], [400, 400, 1200]]) {
		const cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		const ids = [9, 9, 9, 9, 9, 9, 4, 4, 2, 1, 3, 361, 1052, 119, 116, 114, 120];
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rnd() < 0.2) { const id = ids[Math.floor(rnd() * ids.length)]; cells.push(id === 1052 ? [x, y, id, 1] : [x, y, id]); }
		cells.push([Math.floor(W / 2), 2, 121], [2, H - 2, 255]);
		const L = levelOfCells(W, H, cells);
		const t0 = Date.now(), f = R.reachField(L), ms = Date.now() - t0;
		check(`${W}x${H} (20% blocks of every kind): ${ms} ms (target ${target} ms, the machine at ${load.toFixed(1)}x its benchmark's time)`, ms <= 3 * target * load, `${f.labels} labels, ${f.kinds} inverse tables`);
	}
}

(async () => {
	if (want('A')) sectionA();
	if (want('B')) sectionB();
	if (want('C')) sectionC();
	if (want('D')) sectionD();
	if (want('E')) sectionE();
	if (want('F')) sectionF();
	if (want('G')) await sectionG();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
