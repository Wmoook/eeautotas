'use strict';
// The reach field v3 (src/reach.js). CPU unless --gpu. Sections:
//   A tables   the engine's numbers and the model's rules: Ra(JV) = 63.42, Rc(2), Rd(16), convex rise tables, VF[13] <
//              8.07 <= VF[14] (the landing-tick jump), the jump levels (7 on a floor, 8 on a lower half block), a 1-row
//              dot strip at rest reaches the upper half of the row above (q 0) but never enters it (q 1), the rise
//              tables against the engine itself, each field's top speed against the engine's, and the lookup's R level
//              of rising balls in open air against the engine's own apex
//   B rooms    hand-made rooms with the answer known from the engine: the start is cut off (no way) or finite, and every
//              state from which a small engine search reached the trophy is finite: the design set (ledges, dot steps and
//              columns, arrows, one-ways, slots, portals, a time door, a diagonal gap, the dot room, landing-tick jumps, a
//              half-block bridge, an up boost), the limits of single rules (a jump 4 rows not 5, 8 px more from a lower
//              half block or a present, a water and an up-arrow column), routed rooms (C.evaluate: deaths as a way to
//              move with 2 spawns / a curse / a 1582 spawn, presents at rotations 0 and 3, a jump with a down boost in the
//              gravity queue), strip-k (a 1-row dot strip does not lift the ball k >= 2 rows), up-pump (finite), shaft-lip
//              (the user's 50x50 level: the start finite, its states ranked), rising-after-jump (never cheaper than
//              standing)
//   C corpus   every state of every job's original and best run (--jobs=<dir>, default src/jobs) and of the known editor
//              routes (the dot stairs, the 40x25 shaft's 251-tick route) is reachable: 0 cut off
//   D fuzz     random rooms and random input runs, fields to the trophy and to random goal tiles: a state cut off at tick
//              t is cut off at t + 1 too (otherwise the model misses a real move); presents and half blocks at every
//              stored rotation, curses, second spawns (followed through deaths and respawns), down boosts by the start
//   E bellman  opts.check (every stored cost is its best edge + the target's cost) on 16 random levels with every block
//              kind; the goals / maxCost options (explore.js --hunt) and writeReachFile's refusal of a goals field
//   F agree    the JS lookup and the native tool's (eegpu reachtest: the host, and with --gpu the GPU) on 10k random
//              states per room give the same fifths, and the beam's blended score (reach.js scoreAt = beam.h reachScore)
//              the same float (skipped without a native tool that reads RCH3)
//   G timing   200x200 and 400x400 random levels: fails above 3x the target (300 / 1200 ms), scaled by the machine's load
//              (the engine's single-thread speed now against its benchmark, --bench=<_system.json>)
//   H dead ends  protection only where a protected ball can be (a route through a spike with the protection effect: every
//              state finite, in walk and physics mode, with and without the death edges; killing tiles no protected ball
//              reaches stay deadly), the death-free field (opts.deaths: false: a pocket only a death leaves is cut off, its
//              -1 a superset of the default field's), the viewing-room trap (walk mode: a spectator box by the trophy behind
//              spikes, reached by a portal, ranks behind the start: Forgotten Helix's box looked 106 tiles from the trophy);
//              the coins stored as collected (110 / 111, coins again after 'reset'): triggers of the room dead ends (a 60 x 50
//              level with one, a 1-coin door and the trophy: every state of the route live, and the one search routes it)
//   J secrets  50, the secret "appear" block (eesim.js F_DOOR, but it always blocks), is a wall to every guidance test
//              (reach.js guideFlags): a corridor with it between the start and the trophy has no way for the engine, the
//              reach field, goexplore.js's lower bound and room dead ends, timed.js's bound and the editor's walk (243
//              "blank": a way, 136 "disappear": none); a 2-high column of it: the field goes over it as over 9s, every
//              state of the engine's routes finite; random rooms with 50 walls: the field = the room with 50 made 9, its
//              -1 set holds the one of 50 as an open door (only tighter), no state finite right after a cut-off one
//   P the plain-ball field (opts.plainFx, COMPILER DOCTOR 6): physics mode with an effect tile, the self-check, a ledge only a
//              jump effect reaches (every state of the engine's route finite; the start cut without the effect tile), random
//              rooms with effect tiles of every kind: every state the engine search reached the trophy from finite
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
// c curse (1 s), w spawn 1582 #0, p / q / r present 1101 at rotation 1 / 0 / 3, h half block 1116 at rotation 2, e / f the
// protection effect on / off, k / b a gold / blue coin, 1 / 2 a gold coin door of 1 / 2, 3 / 4 a blue coin door of 1 / 2,
// a / z / y the secret blocks 50 "appear" (always blocks), 243 "blank" (air), 136 "disappear" (a plain solid)
const ID = { e: [420, 1], f: [420, 0], '#': [9], S: [255], T: [121], o: [4], '^': [2], '<': [1], '>': [3], '~': [119], H: [120], x: [361, 1], '-': [1052, 1], _: [1041, 1], B: [116], D: [117],
	C: [360], t: [156], v: [1518], P: [242, 1, 1, 2], Q: [242, 3, 2, 1], L: [118], I: [1064], g: [453], c: [421, 1], w: [1582, 0], p: [1101, 1], q: [1101, 0], r: [1101, 3], h: [1116, 2],
	k: [100], b: [101], '1': [43, 1], '2': [43, 2], '3': [213, 1], '4': [213, 2], a: [50], z: [243], y: [136] };
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
/** a small breadth-first search over inputs (cells of 1 px and 1/8 px/tick): a route to the trophy, or null. With
 *  `tree`: {route, ahead}: `extra` more layers after the first finish, and every state from which the search reached the
 *  trophy (the ancestors of every finish, as snapshots) */
function engineRoute(L, maxTicks, maxStates, tree, extra) {
	const OPTS = [0, 2, 4, 1, 3, 5, 8, 10, 12, 9, 11, 13, 16, 18, 20];
	const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput();
	let layer = [{ snap: sim.snapshot(), up: null, m: -1 }];
	const seen = new Set(), fins = [];
	const pathOf = (nd, m) => { const o = [m]; for (let n = nd; n.up; n = n.up) o.push(n.m); return o.reverse(); };
	let stopAt = maxTicks;
	for (let t = 0; t < stopAt && layer.length; t++) {
		const next = [];
		for (const nd of layer) {
			for (const m of OPTS) {
				sim.restore(nd.snap); E.applyMask(inp, m); sim.tick(inp);
				if (sim.is_dead) continue;
				if (sim.has_silver_crown) {
					if (!tree) return pathOf(nd, m);
					if (!fins.length) stopAt = Math.min(maxTicks, t + 1 + (extra || 0));
					fins.push([nd, m]);
					continue;
				}
				const key = `${Math.round(sim.px)},${Math.round(sim.py)},${Math.round(sim.speed_x * 8)},${Math.round(sim.speed_y * 8)},${sim.on_ground ? 1 : 0},${sim.jump_count},${sim._q0},${sim._q1}`;
				if (seen.has(key)) continue;
				seen.add(key);
				next.push({ snap: sim.snapshot(), up: nd, m });
			}
		}
		layer = next.length > maxStates ? next.slice(0, maxStates) : next;
	}
	if (!tree) return null;
	if (!fins.length) return { route: null, ahead: [] };
	const ahead = new Set();
	for (const [nd] of fins) for (let n = nd; n && !ahead.has(n); n = n.up) ahead.add(n);
	return { route: pathOf(fins[0][0], fins[0][1]), ahead: [...ahead].map((n) => n.snap) };
}
/** every state from which the small engine search reached the trophy: the number cut off (and the first) */
function aheadCut(L, f, ahead) {
	const sim = new E.EESim(L); sim.reset();
	let cut = 0, first = null;
	for (const s of ahead) { sim.restore(s); if (R.costAt(f, sim) < 0) { cut++; if (!first) first = R.stateAt(f, sim); } }
	return { n: ahead.length, cut, first };
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
	// the lookup's rise: a rising ball in open air (the gravity queue: air or up arrows) gets the R level of the engine's own
	// apex (never below it: that would cut a real state off; at most one above)
	{
		const W = 12, H = 60, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		cells.push([6, 1, 121], [6, H - 2, 255], [1, 20, 2]);
		const La = levelOfCells(W, H, cells), fa = R.reachField(La);
		const sa = startSim(La, 1), I = new E.EEInput(), s0 = sa.snapshot();
		let seed = 9;
		const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
		let low = 0, high = 0, eq = 0, first = null;
		for (let k = 0; k < 4000; k++) {
			sa.restore(s0);
			sa.px = 48 + rnd() * 64; sa.py = 16 * 30 + rnd() * 16 * 25; sa.speed_x = 0; sa.speed_y = -rnd() * 16; sa.on_ground = false;
			sa._q0 = rnd() < 0.5 ? 0 : 2; sa._q1 = rnd() < 0.5 ? 0 : 2;
			const st = R.stateOf(fa, sa.px, sa.py, sa.speed_y, sa._q0, sa._q1, sa._slippery), top = 16 * (Math.trunc(sa.py + 8) >> 4);
			const ql = st.rise.find((r) => r[0] === R.R_)[1];
			let minY = sa.py;
			for (let t = 0; t < 200 && sa.speed_y <= 0; t++) { sa.tick(I); if (sa.py < minY) minY = sa.py; }
			const qe = R.qOf(top - (minY + 8), fa.Q);
			if (ql < qe) { low++; if (!first) first = { q: ql, engine: qe }; } else if (ql > qe + 1) high++; else if (ql === qe) eq++;
		}
		check('the lookup\'s rise: 4000 rising balls in open air (a queue of air or up arrows) get the R level of the engine\'s own apex (never below, at most one above)',
			low === 0 && high === 0, `${low} below, ${high} more than one above, ${eq} equal${first ? `; first ${JSON.stringify(first)}` : ''}`);
	}
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
	// the limits of single rules, each at what the engine just reaches (and just beyond): a jump from a floor lifts the
	// centre 63.42 px (4 rows, not 5); from a lower half block (or a present at rotation 1) 8 px more (a 4-tile ledge);
	// a water column and an up-arrow column lift the ball out onto the ledge beside them
	['float3', 'yes', ['......', '......', '......', '......', '..T...', '......', '......', '..S...']],
	['float4', 'yes', ['......', '......', '......', '..T...', '......', '......', '......', '..S...']],
	['float5', 'no', ['......', '......', '..T...', '......', '......', '......', '......', '..S...']],
	['halfledge4', 'yes', ['..............', '..............', '..............', '.........T....', '........######', '........######', '........######', '..S.___.######']],
	['presentfloat4', 'yes', ['......', '......', '......', '..T...', '......', '......', '..S...', '..p...']],
	['halffloat5', 'no', ['......', '......', '..T...', '......', '......', '......', '..S...', '..____']],
	['watercol', 'yes', ['..............', '..............', '..............', '..............', '....T.........', '....#~#.......', '....#~#.......', '.S..#~#.......', '~~~~~~#.......']],
	['upcol3', 'yes', ['.........', '.........', '.........', '..T......', '.#.#.....', '.#^#.....', '.#^#.....', '.#^#.....', 'S.^......']],
];
/** rooms with a known route (checked by C.evaluate): the start finite and every live state of the route finite. The
 *  review's counterexamples of the first v3: deaths as a way to move (2 spawns, curse, 1582 #0 spawns), presents at
 *  other rotations, the jump with a down boost in the gravity queue */
const R4 = (m, n) => Array(n).fill(m);
const ROUTED = [
	['death warp: a pit, a spike, 2 spawns (the respawn at the other one)', ['S..T....', '####....', '####....', '####....', '####....', '####S..x'], R4(4, 200)],
	['death warp: a pit, a curse, 2 spawns and a checkpoint', ['S..T...C', '####....', '####....', '####....', '####....', '####S..c'], R4(4, 400)],
	['death warp: a walled room, a curse, 2 spawns', ['S...T#......', '######S....c'], R4(4, 600)],
	['death warp: a walled room, a spike, a 1582 #0 spawn and a checkpoint out of reach', ['w...T#......', '######S....x', '######C#####'], R4(4, 600)],
	['a present at rotation 0 (its left half open)', ['S...', '#hq#', '..T.'], R4(4, 40)],
	['a present at rotation 3 (a floor at its top)', ['.....', '...T.', '.....', '.....', '.....', '..S..', 'xxrxx'], [0, 0, 1, ...R4(5, 30)]],
	['a jump with a down boost in the gravity queue (a 4-tile ledge)', [...Array(6).fill('.'.repeat(32)), '.'.repeat(15) + 'T' + '.'.repeat(16), '.'.repeat(14) + '#'.repeat(18),
		'.'.repeat(14) + '#'.repeat(18), '.'.repeat(9) + 'D' + '.'.repeat(4) + '#'.repeat(18), 'S' + '.'.repeat(13) + '#'.repeat(18)], [...R4(4, 31), 5, ...R4(0, 11), ...R4(13, 60)]],
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
/**
 * The rise caps (n3 rise-q16): an up boost and a portal exit rise a finite height (every speed is capped at 16 px/tick by
 * the speed update; a rotated exit's x 1.42 is clamped the tick after), where the field had R(INF) ("anywhere up") before.
 * (1) an up boost under open sky: the engine's highest centre over input patterns (walk onto it, up held or not, a jump)
 * is below the field's cap: the trophy 20 rows above the boost finite, 21 rows above cut off; (2) a ball that falls 43 rows
 * into a portal whose exit reverses it (rot 1 -> 3: dir 2) likewise: 20 rows finite, 21 cut off; (3) ice below the boost
 * row (the ice drag's longer rise: the cap is not proven in Q levels): the field keeps "anywhere up", finite at 30 rows;
 * (4) a portal exit on a down boost (a stale portal entry under a 117; the soundness review's counterexample): the ball
 * teleports up out of the exit tile and rises to a trophy 10 rows above it: no state of the idle run cut
 */
function riseCaps() {
	const boostRoom = (k, floor) => box([...Array(40 - k).fill('.....'), '..T..', ...Array(k - 1).fill('.....'), '..B..', 'S....', ...(floor ? [floor] : [])]);
	{
		const L = ascii(boostRoom(30));
		let best = 1e9;
		for (let k = 1; k <= 30; k++) for (const hold of [0, 8]) for (const jumpAt of [-1, 0, 2, 5]) {
			const s = new E.EESim(L); s.reset(); const I = new E.EEInput();
			for (let t = 0; t < 200; t++) { E.applyMask(I, (t < k ? 4 : 0) | hold | (t === jumpAt ? 1 : 0)); s.tick(I); if (s.py + 8 < best) best = s.py + 8; }
		}
		const rise = 16 * 41 - best;   // px above the boost tile's top edge (the boost at row 41 with the border)
		const c20 = R.costAt(R.reachField(ascii(boostRoom(20)), {}), startSim(ascii(boostRoom(20)), 0));
		const f21 = R.reachField(ascii(boostRoom(21)), { check: true }), c21 = R.costAt(f21, startSim(ascii(boostRoom(21)), 0));
		check('rise cap: an up boost under open sky: the engine rises < 20 rows, the trophy 20 rows above finite, 21 rows above cut off (not "anywhere up")',
			rise < 20 * 16 && rise > 18 * 16 && c20 >= 0 && c21 < 0 && f21.mismatches === 0, `the engine ${(rise / 16).toFixed(2)} rows, 20: ${fmt(c20)}, 21: ${fmt(c21)}`);
	}
	{
		const portalRoom = (k) => {
			const rows = [];
			for (let y = 0; y < 44; y++) rows.push(y === 0 ? 'S##.......' : y === 43 ? 'P##......Q' : y === 43 - k ? '.##......T' : '.##.......');
			return box([...rows, '##########']);
		};
		const L = ascii(portalRoom(40));
		let best = 1e9;
		for (const m of [0, 8, 16, 1, 2, 4]) {
			const s = new E.EESim(L); s.reset(); const I = new E.EEInput(); let tele = false;
			for (let t = 0; t < 400; t++) { E.applyMask(I, m); s.tick(I); if (s.teleported) tele = true; if (tele && (Math.trunc(s.px + 8) >> 4) >= 5 && s.py + 8 < best) best = s.py + 8; }
		}
		const rise = 16 * 44 - best;
		const c20 = R.costAt(R.reachField(ascii(portalRoom(20)), {}), startSim(ascii(portalRoom(20)), 0));
		const f21 = R.reachField(ascii(portalRoom(21)), { check: true }), c21 = R.costAt(f21, startSim(ascii(portalRoom(21)), 0));
		check('rise cap: a fall into a portal whose exit reverses it (x 1.42): the engine rises < 20 rows above the exit, the trophy 20 rows above finite, 21 cut off',
			rise < 20 * 16 && rise > 0 && c20 >= 0 && c21 < 0 && f21.mismatches === 0, `the engine ${(rise / 16).toFixed(2)} rows, 20: ${fmt(c20)}, 21: ${fmt(c21)}`);
	}
	{
		const L = ascii(boostRoom(30, 'IIIII'));
		const c = R.costAt(R.reachField(L, {}), startSim(L, 0));
		check('rise cap: ice in the level (the ice drag rises further than Q levels hold): the boost keeps "anywhere up" (the trophy 30 rows above finite)', c >= 0, `30: ${fmt(c)}`);
	}
	{
		// (4) the soundness review's counterexample (bd1767c): a portal exit whose tile holds a DOWN boost (a portal record,
		// then a 117 record at the same cell: EEO keeps the stale portal entry, eesim.js likewise). The teleport tick moves
		// the ball up out of the exit tile, so no tick of it starts in the boost and it rises ~18 rows; R has no moves in a
		// down boost, so the exit there keeps R("anywhere up"). The ball falls 43 rows into P and the exit reverses it: the
		// idle run finishes at the trophy 10 rows above the exit, and none of its states may be cut (a -1 is a proof)
		const exitRoom = (exitId) => {
			const W = 12, H = 46, recs = [], walls = [];
			const add = (id, pos, args) => recs.push({ id, layer: 0, xs: pos.map((p) => p[0]), ys: pos.map((p) => p[1]), args: args || [] });
			for (let x = 0; x < W; x++) walls.push([x, 0], [x, H - 1]);
			for (let y = 1; y < H - 1; y++) walls.push([0, y], [W - 1, y], [2, y], [3, y]);
			add(9, walls); add(255, [[1, 1]]); add(121, [[10, 34]]);
			add(242, [[1, 44]], [1, 1, 2]); add(242, [[10, 44]], [3, 2, 1]);
			if (exitId) add(exitId, [[10, 44]]);
			return E.prepareLevel(EL.toSimLevel(EL.readEelvl(EL.writeEelvl({ width: W, height: H, name: 't', owner: 't', records: recs }))));
		};
		for (const exitId of [117, 0]) {
			const L = exitRoom(exitId);
			const f = R.reachField(L, { check: true });
			const s = new E.EESim(L); s.reset(); const I = new E.EEInput();
			let fin = -1, cut = 0, n = 0;
			for (let t = 0; t < 400 && fin < 0; t++) {
				if (!s.is_dead) { n++; if (R.costAt(f, s) < 0) cut++; }
				E.applyMask(I, 0); s.tick(I);
				if (s.has_silver_crown) fin = t + 1;
			}
			const ev = fin > 0 ? C.evaluate(L, new Uint8Array(fin)) : null;
			check(`rise cap: a portal exit on ${exitId ? 'a down boost (a stale portal entry under a 117)' : 'a plain portal'}: the idle run up out of the exit finishes and none of its states is cut`,
				fin > 0 && !!ev && cut === 0 && L.fg[44 * 12 + 10] === (exitId || 242) && f.mismatches === 0, `finish ${fin}, ${cut} of ${n} states cut, start ${fmt(R.costAt(f, startSim(L, 0)))}`);
		}
	}
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
			// the engine's routes (a small search, 30 layers past its first finish): every state from which it reached the
			// trophy is finite
			const tr = engineRoute(L, 700, 1500, true, 30);
			if (tr.route) {
				const w = walk(L, f, tr.route), a = aheadCut(L, f, tr.ahead);
				ok = ok && w.cut === 0 && w.finished && a.cut === 0;
				detail += `; engine route ${tr.route.length} ticks, ${a.n} states lead to the trophy, ${a.cut} cut off${a.first ? ` (first ${JSON.stringify(a.first)})` : ''}`;
			} else detail += '; (the small engine search found no route)';
		}
		check(`${name}: ${want === 'no' ? 'no way (cut off)' : want === 'yes' ? 'the engine finishes: finite' : 'finite'}`, ok && f.mismatches === 0, detail);
	}
	riseCaps();
	for (const [name, rows, masks] of ROUTED) {
		const L = ascii(box(rows)), f = R.reachField(L, { check: true });
		const ev = C.evaluate(L, Uint8Array.from(masks));
		const w = ev ? walk(L, f, ev.ms) : null, c = R.costAt(f, startSim(L, 0));
		check(`${name}: the route finishes (C.evaluate), the start and every live state finite`, !!ev && c >= 0 && w.cut === 0 && f.mismatches === 0,
			`start ${fmt(c)}${ev ? `, ${ev.runTicks} run ticks, ${ev.deaths} deaths, ${w.n} states, ${w.cut} cut off${w.first ? ` (first ${JSON.stringify(w.first)})` : ''}` : ', NO FINISH'}${f.deaths ? ' (deaths)' : ''}, ${f.mismatches} mismatches`);
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
	// (presents 1101-1105 and the half block 1116 at every stored rotation, 4 = a full solid; a curse; some rooms with a
	// second spawn point: deaths as a way to move, followed through the death and the respawn)
	const IDS = [9, 9, 9, 9, 9, 4, 4, 1, 2, 3, 2, 119, 369, 416, 116, 117, 114, 120, 361, 1052, 1041, 1518, 23, 43, 360, 2, 4, 1064, 1101, 1103, 1105, 1116, 421, 420, 361];
	const rot = (id) => id === 1052 || id === 1041 || (id >= 1101 && id <= 1105) || id === 1116;
	const rotOf = (id) => Math.floor(rnd() * (id === 1052 || id === 1041 ? 4 : 5));
	const cellOf = (x, y, id) => (rot(id) ? [x, y, id, rotOf(id)] : id === 43 || id === 23 || id === 421 ? [x, y, id, 1] : id === 420 ? [x, y, id, rnd() < 0.8 ? 1 : 0] : [x, y, id]);
	function randomRoom(k) {
		const W = 12 + Math.floor(rnd() * 20), H = 10 + Math.floor(rnd() * 12), cells = room(W, H);
		const dens = 0.12 + rnd() * 0.25, kinds = IDS.filter(() => rnd() < 0.5);
		if (!kinds.length) kinds.push(9);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			if (rnd() >= dens) continue;
			const id = rnd() < 0.5 ? 9 : kinds[Math.floor(rnd() * kinds.length)];
			cells.push(cellOf(x, y, id));
		}
		for (let n = 0; n < 3; n++) {
			const id = kinds[Math.floor(rnd() * kinds.length)], x0 = 1 + Math.floor(rnd() * (W - 3)), y0 = 1 + Math.floor(rnd() * (H - 3)), len = 2 + Math.floor(rnd() * 5), vert = rnd() < 0.5;
			for (let i = 0; i < len; i++) { const x = vert ? x0 : x0 + i, y = vert ? y0 + i : y0; if (x > 0 && y > 0 && x < W - 1 && y < H - 1) cells.push(cellOf(x, y, id)); }
		}
		if (k % 3 === 0) cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 0, 1, 2], [1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 1, 2, 1]);
		cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * Math.max(1, (H - 2) / 2)), 121], [1 + Math.floor(rnd() * (W - 2)), H - 2, 255]);
		if (k % 4 === 1) cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 255]);
		// (every 5th room in walk mode: a low-gravity tile (off) in a corner; walk mode's -1 prunes the CPU search and the GPU runs)
		if (k % 5 === 2) cells.push([W - 2, H - 2, 453, 0]);
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
		// (a present or a down boost by the start now and then: jumps from presents, a boost in the gravity queue)
		if (rnd() < 0.3) put(3, fl, 1101 + Math.floor(rnd() * 5), Math.floor(rnd() * 5));
		if (rnd() < 0.3) put(3 + Math.floor(rnd() * 3), fl - 1 - Math.floor(rnd() * 2), 117);
		cells.push([tx, Math.max(1, ty), 121], [2, fl, 255]);
		return { W, H, cells };
	}
	const OPTS = [0, 1, 2, 4, 8, 16, 3, 5, 9, 10, 12, 17, 18, 20, 24, 11, 13];
	const ROOMSN = QUICK ? 12 : 40, RUNS = QUICK ? 20 : 50, TICKS = 300, GOALS = 3;
	let pairs = 0, cut = 0, viol = 0, runs = 0, first = null, deathPairs = 0;
	for (let k = 0; k < ROOMSN; k++) {
		const rm = k % 2 ? puzzleRoom() : randomRoom(k);
		let L;
		try { L = levelOfCells(rm.W, rm.H, rm.cells); } catch (e) { continue; }
		const fields = [R.reachField(L)];
		// (the searches' field without death edges: compared until the ball's first death, which ends a search's run)
		const deathFree = [false];
		if (fields[0].deaths) { fields.push(R.reachField(L, { deaths: false })); deathFree.push(true); }
		for (let g = 0; g < GOALS; g++) {
			for (let tries = 0; tries < 50; tries++) {
				const x = 1 + Math.floor(rnd() * (rm.W - 2)), y = 1 + Math.floor(rnd() * (rm.H - 2) * (rnd() < 0.7 ? 0.6 : 1)), i = y * rm.W + x;
				if (fields[0].cls[i] === R.WALL || fields[0].cls[i] === R.DEADLY) continue;
				fields.push(R.reachField(L, { goals: [{ tile: i, cost: 0 }] }));
				deathFree.push(false);
				break;
			}
		}
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let r = 0; r < RUNS; r++) {
			runs++;
			sim.reset();
			let m = OPTS[Math.floor(rnd() * OPTS.length)];
			let prev = fields.map((f) => R.fifthsAt(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery)), prevS = null, died = false;
			for (let t = 0; t < TICKS; t++) {
				if (rnd() < 0.12) m = OPTS[Math.floor(rnd() * OPTS.length)];
				E.applyMask(inp, m);
				sim.tick(inp);
				// (a death: followed through the dead ticks and the respawn when the model has deaths as a way to move)
				if (sim.has_silver_crown || (sim.is_dead && !fields[0].deaths)) break;
				const now = fields.map((f) => R.fifthsAt(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery));
				if (sim.is_dead) { deathPairs++; died = true; }
				for (let fi = 0; fi < fields.length; fi++) {
					if (died && deathFree[fi]) continue;
					pairs++;
					if (now[fi] < 0) cut++;
					if (prev[fi] < 0 && now[fi] >= 0) { viol++; if (!first) first = { room: k, field: fi, run: r, tick: t, before: prevS && prevS[fi], after: R.stateAt(fields[fi], sim) }; }
				}
				prev = now;
				if (!first) prevS = fields.map((f) => R.stateAt(f, sim));
			}
		}
	}
	check(`${runs} random runs of ${TICKS} ticks in ${ROOMSN} rooms (fields to the trophy and ${GOALS} goal tiles each, the death-free field where deaths move the ball; protection tiles; every 5th room in walk mode): no state finite right after a cut-off one`, viol === 0 && pairs > 0,
		`${pairs} pairs (${deathPairs} dead ticks followed), ${cut} cut off, ${viol} violations${first ? `; first ${JSON.stringify(first)}` : ''}`);
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

// ---------------------------------------------------------------- I coin doors that never open
function sectionI() {
	section('I coin doors above the level coins are walls (sound: the count never passes the coin tiles)');
	const cost = (rows) => { const L = ascii(box(rows)); const f = R.reachField(L); return { L, start: R.costAt(f, startSim(L, 30)) }; };
	// gold: one coin, a door of 2 in front of the trophy: cut off; a door of 1: a way
	const a = cost(['S.k.2.T']), b = cost(['S.k.1.T']);
	check('one gold coin, a 2-coin door before the trophy: the start is cut off', a.start < 0, fmt(a.start));
	check('one gold coin, a 1-coin door before the trophy: the start has a way', b.start >= 0, fmt(b.start));
	const na = R.neverOpenDoors(a.L), nb = R.neverOpenDoors(b.L);
	check('neverOpenDoors: the 2-coin door only', na !== null && na.reduce((x, y) => x + y, 0) === 1 && nb === null);
	// blue coins count apart from gold: two gold coins do not open a blue door of 2
	const c = cost(['S.kkb.4.T']), d = cost(['S.kbb.4.T']);
	check('two gold + one blue coin, a 2-blue-coin door: cut off', c.start < 0, fmt(c.start));
	check('one gold + two blue coins, a 2-blue-coin door: a way', d.start >= 0, fmt(d.start));
	// the door is only a wall where it stands: a way around it stays open
	const e = cost(['.........', '.........', '.........', 'S.k.2..T.']);
	check('a way over the never-open door stays open', e.start >= 0, fmt(e.start));
}

// ---------------------------------------------------------------- J secret blocks
/**
 * 50, the secret "appear" block: eesim.js flags it F_DOOR, but overlaps() reveals it and then blocks in every state
 * (eesim.js _ovSlow, eecore.h overlaps; docs/eeo_spec/blocks.md 3.2), so every guidance wall test takes it for a wall
 * (reach.js guideFlags); before 2026-09-28 they took it for an open door (the campaign doctor: Snowblind's ball inside a
 * box of 64, This is not snow's trophy fenced by six). 243 ("blank") is not solid (air), 136 ("disappear") a plain solid.
 */
function sectionJ() {
	section('J secret blocks: 50 ("appear", always blocks) a wall to every guidance test, 243 ("blank") air, 136 ("disappear") a wall');
	const GX = require('../src/goexplore.js'), TMD = require('../src/timed.js');
	const corridor = (ch) => ascii(box([`S.${ch}.T`]));
	const L0 = corridor('a'), gf = R.guideFlags(L0);
	let other = 0;
	for (let id = 0; id < gf.length; id++) if (id !== 50 && gf[id] !== L0.flags[id]) other++;
	check('guideFlags: 50 a plain solid (F_SOLID, no F_DOOR) = 9\'s flags; the engine\'s own table keeps its F_DOOR; every other id as the engine\'s; one table per level',
		gf[50] === gf[9] && (gf[50] & 16) === 0 && (L0.flags[50] & 17) === 17 && other === 0 && R.guideFlags(L0) === gf && R.ALWAYS_SHUT.length === 1,
		`guide ${gf[50]} (9: ${gf[9]}), engine ${L0.flags[50]}, ${other} other ids differ`);
	// a 1-row corridor: the block between the start and the trophy
	for (const [ch, name, open] of [['a', '50 (appear)', false], ['z', '243 (blank)', true], ['y', '136 (disappear)', false], ['.', 'air', true], ['#', '9 (a wall)', false]]) {
		const L = corridor(ch), f = R.reachField(L, { check: true }), c = R.costAt(f, startSim(L, 0));
		const eng = engineRoute(L, 200, 2000) !== null;
		const tile = (Math.trunc(startSim(L, 0).py + 8) >> 4) * L.width + (Math.trunc(startSim(L, 0).px + 8) >> 4), trophy = L.fg.indexOf(121);
		const lb = GX.lowerBoundTiles(L)[tile], lbT = TMD.lowerBoundTo(L, [trophy])[tile];
		const live = GX.liveAt(GX.roomDead(L, 1 << 24).liveFor(startSim(L, 0)), tile);
		const walked = ED.reachFrom(L, tile % L.width, (tile / L.width) | 0, true)[trophy] === 1;
		const all = [c >= 0, lb !== 0xffff, lbT !== 0xffff, live, walked];
		check(`a corridor with ${name} between the start and the trophy: ${open ? 'a way' : 'no way'} for the engine, the reach field, goexplore's lower bound and room dead ends, timed.js's bound, the editor's walk`,
			eng === open && all.every((v) => v === open) && f.mismatches === 0,
			`engine ${eng ? 'route' : 'none'}; reach ${fmt(c)}, lb ${lb}, timed lb ${lbT}, live ${live}, walk ${walked}`);
	}
	// a 2-high column with the way over it: the field goes around (as over a wall of 9), not through (as through air)
	const over = (ch) => ascii(box(['.........', '.........', '.........', `....${ch}....`, `S...${ch}...T`]));
	const Lo = over('a'), fo = R.reachField(Lo, { check: true }), fw = R.reachField(over('#')), fa = R.reachField(over('.'));
	const co = R.costAt(fo, startSim(Lo, 30)), cw = R.costAt(fw, startSim(over('#'), 30)), ca = R.costAt(fa, startSim(over('.'), 30));
	let sameCls = true;
	for (let i = 0; i < fo.cls.length; i++) if (fo.cls[i] !== fw.cls[i]) sameCls = false;
	const tr = engineRoute(Lo, 300, 2000, true, 20);
	const w = tr.route ? walk(Lo, fo, tr.route) : null, a = tr.route ? aheadCut(Lo, fo, tr.ahead) : null;
	let on50 = 0;
	if (tr.route) { const s = new E.EESim(Lo); s.reset(); const I = new E.EEInput(); for (const m of tr.route) { E.applyMask(I, m); s.tick(I); if (Lo.fg[(Math.trunc(s.py + 8) >> 4) * Lo.width + (Math.trunc(s.px + 8) >> 4)] === 50) on50++; } }
	check('a 2-high column of 50 with the way over it: the field goes over it (the cost of a column of 9, the same classes; more than through air), and every state from which the engine reached the trophy is finite',
		co >= 0 && co === cw && sameCls && co > ca && fo.mismatches === 0 && !!w && w.finished && w.cut === 0 && a.cut === 0 && on50 === 0,
		`50 ${fmt(co)}, 9 ${fmt(cw)}, air ${fmt(ca)}; engine route ${tr.route ? tr.route.length : '-'} ticks (${a ? a.n : 0} states lead to the trophy, ${a ? a.cut : '-'} cut off, ${on50} on a 50 tile)`);
	secretFuzz();
}
/** random rooms with 50 in the mix: its field = the same room with 50 made 9 (a plain wall), its -1 set holds the one of
 *  50 as an open door (the room with 156, a door the model opens: the fields before 2026-09-28), and D's property along
 *  random runs in the engine (cut off at tick t implies cut off at t + 1) */
function secretFuzz() {
	let seed = 20260928;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const IDS = [9, 9, 4, 2, 1, 3, 119, 120, 361, 1052, 1041, 360, 50, 50, 50];
	const OPTS = [0, 1, 2, 4, 8, 16, 3, 5, 9, 10, 12, 17, 18, 20, 24, 11, 13];
	const ROOMSN = QUICK ? 10 : 30, RUNS = QUICK ? 15 : 40, TICKS = 300;
	let rooms = 0, pairs = 0, cutNew = 0, cutOld = 0, diffWall = 0, loose = 0, viol = 0, first = null, tighter = 0;
	for (let k = 0; k < ROOMSN; k++) {
		const W = 12 + Math.floor(rnd() * 18), H = 10 + Math.floor(rnd() * 10), cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			if (rnd() >= 0.2) continue;
			const id = IDS[Math.floor(rnd() * IDS.length)];
			cells.push(id === 1052 || id === 1041 ? [x, y, id, Math.floor(rnd() * 4)] : [x, y, id]);
		}
		// (a column and a row of 50 across the room: the walls the fields used to walk through)
		const cx = 2 + Math.floor(rnd() * (W - 4)), cy = 2 + Math.floor(rnd() * (H - 4));
		for (let y = 1; y < H - 1; y++) if (rnd() < 0.8) cells.push([cx, y, 50]);
		for (let x = 1; x < W - 1; x++) if (rnd() < 0.5) cells.push([x, cy, 50]);
		if (k % 3 === 0) cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 0, 1, 2], [1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 1, 2, 1]);
		cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * Math.max(1, (H - 2) / 2)), 121], [1 + Math.floor(rnd() * (W - 2)), H - 2, 255]);
		const as = (from, to) => cells.map((c) => (c[2] === from ? [c[0], c[1], to] : c));
		let L, Lw, Ld;
		try { L = levelOfCells(W, H, cells); Lw = levelOfCells(W, H, as(50, 9)); Ld = levelOfCells(W, H, as(50, 156)); } catch (e) { continue; }
		rooms++;
		const f = R.reachField(L), fw = R.reachField(Lw), fd = R.reachField(Ld);
		for (let i = 0; i < f.cls.length; i++) if (f.cls[i] !== fw.cls[i]) diffWall++;
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let r = 0; r < RUNS; r++) {
			sim.reset();
			let m = OPTS[Math.floor(rnd() * OPTS.length)];
			const at = (ff) => R.fifthsAt(ff, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
			let prev = at(f);
			for (let t = 0; t < TICKS; t++) {
				if (rnd() < 0.12) m = OPTS[Math.floor(rnd() * OPTS.length)];
				E.applyMask(inp, m);
				sim.tick(inp);
				if (sim.has_silver_crown || sim.is_dead) break;
				const now = at(f), nw = at(fw), nd = at(fd);
				pairs++;
				if (now < 0) cutNew++;
				if (nd < 0) cutOld++;
				if (now !== nw) diffWall++;
				if (nd < 0 && now >= 0) loose++;
				if (now < 0 && nd >= 0) tighter++;
				if (prev < 0 && now >= 0) { viol++; if (!first) first = { room: k, run: r, tick: t, state: R.stateAt(f, sim) }; }
				prev = now;
			}
		}
	}
	check(`${rooms} random rooms with 50 walls, ${pairs} run states: the field = the room with 50 made 9 (classes and fifths), its -1 set holds the one of 50 as an open door, and no state finite right after a cut-off one`,
		rooms > 0 && pairs > 0 && diffWall === 0 && loose === 0 && viol === 0,
		`${cutNew} cut off (50 as an open door: ${cutOld}; ${tighter} newly cut), ${diffWall} differences to 9, ${loose} looser, ${viol} violations${first ? `; first ${JSON.stringify(first)}` : ''}`);
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
		['every block (portals, deaths)', randomLevels()[4].level], ['death warp (a curse: every tile a death source)', ascii(box(ROUTED[1][1]))], ['ice', ascii(box(['..........', '..........', '....oo..^.', '..S.....^.', 'IIIIIIIIII']))], ['walk (low gravity)', ascii(box(['.....T....', '..######..', '..........', '..S..g....']))],
		['protection, walk mode (spikes open only where a protected ball can be; the protected walk behind the unprotected one)', ascii(box(['.....T.e..', '..xxxxxx..', '..........', '..S..g..x.']))],
		['protection, physics mode', ascii(box(['.....T.e..', '..xxxxxx..', '..........', '..S.....x.']))],
		['death warp without the death edges (the searches\' field)', ascii(box(ROUTED[1][1])), { deaths: false }]];
	for (const [name, L, fo] of rooms) {
		const f = R.reachField(L, fo);
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
		// (--gpu: the kernel cache, so the driver compiles a build's kernels once; no timeout: an eegpu process is never killed
		// while a kernel may run, and the first load after a build compiles for minutes)
		const args = ['reachtest', path.join(tmp, 'l.bin'), path.join(tmp, 'r.bin'), path.join(tmp, 's.bin'), ...(GPU ? ['--gpu=1', ...G.cacheArgs()] : [])];
		try { out = JSON.parse(execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 1 << 27, timeout: GPU ? 0 : 120000 }).trim().split('\n').pop()); } catch (e) { out = { error: e.message }; }
		if (out.error) { check(`${name}: eegpu reachtest`, false, out.error); continue; }
		let bad = 0, firstBad = null, badS = 0, firstBadS = null;
		const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
		const bitsOf = (x) => { fb[0] = x; return ub[0]; };
		for (let i = 0; i < n; i++) {
			const q = Array.from(st.slice(i * 6, i * 6 + 6));
			const js = R.fifthsAt(f, ...q);
			if (js !== out.host[i] || (out.gpu && js !== out.gpu[i])) { bad++; if (!firstBad) firstBad = { s: q, js, host: out.host[i], gpu: out.gpu ? out.gpu[i] : null }; }
			if (out.hostScore) {
				const sj = bitsOf(R.scoreAt(f, ...q));
				if (sj !== out.hostScore[i] || (out.gpuScore && sj !== out.gpuScore[i])) { badS++; if (!firstBadS) firstBadS = { s: q, js: R.scoreAt(f, ...q), host: out.hostScore[i], gpu: out.gpuScore ? out.gpuScore[i] : null }; }
			}
		}
		check(`${name} (${f.mode}${f.ice ? ', ice' : ''}${f.deaths ? ', deaths' : ''}): ${n} states, the same fifths${out.gpu ? ' on the host and the GPU' : ' on the host'}`, bad === 0 && (!GPU || !!out.gpu), `${bad} differ${firstBad ? `; first ${JSON.stringify(firstBad)}` : ''}`);
		check(`${name}: the beam's blended score, the same float${out.gpuScore ? ' on the host and the GPU' : ' on the host'}`, !!out.hostScore && badS === 0 && (!GPU || !!out.gpuScore),
			`${out.hostScore ? `${badS} differ${firstBadS ? `; first ${JSON.stringify(firstBadS)}` : ''}` : 'the tool gives no score (older than the app: rebuild it)'}`);
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

// ---------------------------------------------------------------- H dead ends
function sectionH() {
	section('H dead ends: protection where a protected ball can be, the death-free field, the viewing-room trap');
	// a route through a spike with the protection effect: hold right from the spawn through e, then over x to T
	const rows = ['..........', '..........', 'S.e...x.T.', '##########'];
	for (const [what, extra] of [['physics', '.'], ['walk', 'g']]) {
		const L = ascii(box(rows.map((r, y) => (y === 0 ? r.slice(0, 9) + extra : r))));
		const route = seqOf([4, 120]);
		const ev = C.evaluate(L, route);
		const f = R.reachField(L), fnd = R.reachField(L, { deaths: false });
		const a = walk(L, f, route), b = walk(L, fnd, route);
		check(`${what} mode: a route through a spike with the protection effect finishes (0 deaths) and every state of it is finite, with and without the death edges`,
			f.mode === what && ev && ev.deaths === 0 && a.finished && a.cut === 0 && b.cut === 0 && f.prot && f.prot.on === 1,
			`mode ${f.mode}, ${ev ? `${ev.runTicks} run ticks, ${ev.deaths} deaths` : 'no finish'}; ${a.n} states, cut ${a.cut} / ${b.cut}${a.first ? ` first ${JSON.stringify(a.first)}` : ''}; prot ${JSON.stringify(f.prot)}`);
	}
	// killing tiles no protected ball reaches stay deadly: the protection effect behind the trophy's wall, a spike pit the start
	// falls into: cut off (before: any protection tile in the level made every spike air, and the pit finite)
	{
		const L = ascii(box(['S......#e.', '.......#..', '....x..#.T', '########..']));
		const f = R.reachField(L);
		const sim = new E.EESim(L); sim.reset();
		sim.px = 5 * 16; sim.py = 3 * 16; sim.speed_y = 0;   // (in the spike's tile, (5, 3))
		const inSpike = R.costAt(f, sim);
		check('a spike no protected ball can reach is deadly: its tile cut off, the protection effect\'s own side open', inSpike < 0 && f.cls[3 * 12 + 5] === R.DEADLY && f.prot.tiles > 0,
			`spike tile ${fmt(inSpike)}, cls ${f.cls[3 * 12 + 5]}; prot ${JSON.stringify(f.prot)}`);
	}
	// the death-free field: a pocket only a death leaves (a one-way portal into a sealed room with a spike floor; a checkpoint
	// by the start): finite with the death edges, cut off without; everywhere the death-free field's -1 covers the default's
	{
		const W = 30, H = 12, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let x = 18; x <= 24; x++) cells.push([x, 2, 9], [x, 7, 9]);
		for (let y = 3; y <= 6; y++) cells.push([18, y, 9], [24, y, 9]);
		cells.push([21, 6, 361, 1], [21, 3, 242, 0, 7, 99], [8, H - 2, 242, 0, 5, 7], [2, H - 2, 255], [4, H - 2, 360], [27, H - 2, 121]);
		const L = levelOfCells(W, H, cells);
		const f = R.reachField(L), fnd = R.reachField(L, { deaths: false });
		const pocket = 4 * W + 21;
		let covers = true;
		for (let i = 0; i < W * H; i++) if (f.cls[i] !== R.WALL && (f.walk[i] === 0xffff) && fnd.walk[i] !== 0xffff) covers = false;
		const sim = new E.EESim(L); sim.reset();
		check('the death-free field: a pocket only a death leaves is cut off there (finite with the death edges), the start finite in both, its -1 a superset',
			f.deaths && !fnd.deaths && f.walk[pocket] !== 0xffff && fnd.walk[pocket] === 0xffff && R.costAt(f, sim) >= 0 && R.costAt(fnd, sim) >= 0 && covers,
			`pocket ${f.walk[pocket] / 5} / ${fnd.walk[pocket] === 0xffff ? 'CUT' : fnd.walk[pocket] / 5} tiles; start ${fmt(R.costAt(f, sim))} / ${fmt(R.costAt(fnd, sim))}`);
	}
	// the viewing-room trap (walk mode, as Forgotten Helix): the trophy's half a dot field behind a spike wall, reached by a
	// portal; in it by the trophy a spectator box (spike walls, a solid floor) whose only way out is its portal back; the
	// protection effect by the trophy. The box ranks behind the start (before: the spikes were air, the box 8.6 tiles from
	// the trophy, the start 19.6)
	{
		const t = trapLevel();
		const L = levelOfCells(t.W, t.H, t.cells);
		const f = R.reachField(L);
		const at = (x, y) => f.walk[y * t.W + x] / 5;
		check('the viewing-room trap: the spectator box by the trophy ranks behind the start and the real way\'s portal (its only way out is its portal back)',
			f.mode === 'walk' && at(70, 9) > at(2, 38) && at(70, 9) > at(6, 37) && at(45, 37) < at(2, 38),
			`box ${at(70, 9)} tiles, start ${at(2, 38)}, the real way's portal ${at(6, 37)}, its exit ${at(45, 37)}`);
	}
}
/** the room dead ends and the coins the FILE stores as collected (110 gold / 111 blue): the default 'reset' start turns
 *  them back into coins that count for coin doors (eesim.js _resetCoinTiles), so they are triggers of roomDead
 *  (goexplore.js TRIGGER_IDS). The wq-int-1 review's repro: a 60 x 50 level with one such coin, a 1-coin door across the
 *  level and the trophy behind it; holding right takes the coin, opens the door and finishes. Before the fix the start
 *  was a dead end (no trigger walkable from it with the door shut): every state before the coin not live, and the one
 *  search (roomDead on) kept 1 cell and found no route in 10 s where --roomDead=0 found it in 0.2 s */
function storedCoinDeadEnds() {
	const GX = require('../src/goexplore.js');
	for (const [coin, door, what] of [[110, 43, 'gold'], [111, 213, 'blue']]) {
		const W = 60, H = 50, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([12, y, door, 1]);
		cells.push([2, H - 2, 255], [6, H - 2, coin], [20, H - 2, 121]);
		const buf = ED.eelvlOf({ name: `stored${coin}`, width: W, height: H, cells });
		const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 't', file: `stored${coin}.eelvl` }));
		const route = new Uint8Array(400).fill(4);
		const ev = C.evaluate(L, route);
		// every state of the route in its room: live (roomDead), and its reach cost finite (the death-free field too)
		const RD = GX.roomDead(L, 1 << 24), f = R.reachField(L), fnd = R.reachField(L, { deaths: false });
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let n = 0, dead = 0, cut = 0, firstDead = -1;
		for (let t = 0; ev && t <= ev.ms.length; t++) {
			if (t > 0) { E.applyMask(inp, route[t - 1]); sim.tick(inp); }
			if (sim.has_silver_crown) break;
			const tile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
			n++;
			if (!GX.liveAt(RD.liveFor(sim), tile)) { dead++; if (firstDead < 0) firstDead = t; }
			if (R.costAt(f, sim) < 0 || R.costAt(fnd, sim) < 0) cut++;
		}
		check(`a ${what} coin stored as collected (${coin}, 'reset' makes it a coin), a 1-coin door (${door}) and the trophy: holding right finishes, every state of it live in its room (roomDead) and finite`,
			!!ev && ev.deaths === 0 && n > 20 && dead === 0 && cut === 0,
			`${ev ? `${ev.ms.length} ticks, ${ev.runTicks} run ticks, ${ev.deaths} deaths` : 'no finish'}; ${n} states, ${dead} not live${firstDead >= 0 ? ` (first at tick ${firstDead})` : ''}, ${cut} cut off`);
		// the one search itself (coarse cells: above 50 x 50; roomDead on, deaths as moves off: nothing kills): a route
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachH-'));
		const file = path.join(dir, `stored${coin}.eelvl`);
		fs.writeFileSync(file, buf);
		let found = null, start = null, err = '';
		try {
			const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), file, '--seconds=20', '--workers=1', '--first=1', '--mem=200'], { encoding: 'utf8', timeout: 60000 });
			for (const line of out.split('\n')) {
				if (!line.startsWith('{')) continue;
				const e = JSON.parse(line);
				if (e.ev === 'start') start = e;
				if (e.ev === 'result' && e.kind === 'finish' && !found) found = e;
			}
		} catch (e) { err = e.message.slice(0, 200); }
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* in use */ }
		const rep = found ? C.evaluate(L, Uint8Array.from(found.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31)) : null;
		check(`the one search on it (goexplore.js, 1 worker, roomDead on): a route, replayed`, !!start && start.cells === 'coarse' && start.deathMoves === false && !!rep && rep.deaths === 0,
			`${found ? `${found.ticks} ticks after ${found.sec} s, replayed ${rep ? `${rep.runTicks} run ticks` : 'NO FINISH'}` : `no route${err ? ` (${err})` : ''}`}; cells ${start && start.cells}, deaths as moves ${start && start.deathMoves}`);
	}
}
/** the room dead ends and a DEFERRED trigger (the n2-int soundness review's blocker 1, its repro rvs_defer60.eelvl): a
 *  60 x 50 level (coarse cells; nothing kills, so deaths as moves are off and roomDead is on) whose only route walks off a
 *  ledge into a 1-wide shaft, touches purple switch 1 while its box overlaps switch 1's gate just below (the press waits in
 *  the engine's tile queue, eesim.js _pressPurpleSwitch), falls through the still-open gate onto a one-way portal and comes
 *  out in a room sealed by switch 1's doors; the press lands one tick later, the doors open, the trophy is a short walk.
 *  roomDead calls the states after the teleport (the switch pending) dead ends of the old room: without goexplore.js
 *  pendingTrigger the one search (roomDead on) found no route in 42 M ticks where --roomDead=0 found one in 0.2 s */
function deferredTriggerDeadEnds() {
	const GX = require('../src/goexplore.js');
	const W = 60, H = 50, S = 40, R0 = 1, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9], [6, y, 9]);
	for (let y = 1; y < H - 1; y++) for (let x = 1; x <= 4; x++) if (y !== R0) cells.push([x, y, 9]);   // the corridor at row R0
	for (let y = 1; y < R0; y++) cells.push([5, y, 9]);                                                  // the shaft from row R0 down
	cells.push([2, R0, 255]);
	cells.push([5, S, 113, 1], [5, S + 1, 185, 1], [5, S + 2, 242, 1, 1, 2]);   // switch 1, its gate, the portal down
	for (let y = S + 3; y < H - 1; y++) cells.push([5, y, 9]);
	cells.push([10, H - 2, 242, 1, 2, 9]);                 // the exit (one way)
	for (let y = 1; y < H - 1; y++) cells.push([30, y, 184, 1]);   // switch 1's doors
	cells.push([45, H - 2, 121]);
	const buf = ED.eelvlOf({ name: 'defer1', width: W, height: H, cells });
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 't', file: 'defer1.eelvl' }));
	const route = new Uint8Array(400).fill(4);
	const ev = C.evaluate(L, route);
	// along the route: the states roomDead calls dead ends of their room, and those the product cuts (not while pending)
	const RD = GX.roomDead(L, 1 << 24);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let n = 0, dead = 0, pendDead = 0, cut = 0, firstCut = -1;
	for (let t = 0; ev && t <= ev.ms.length; t++) {
		if (t > 0) { E.applyMask(inp, route[t - 1]); sim.tick(inp); }
		if (sim.has_silver_crown || sim.is_dead) break;
		const tile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
		n++;
		if (GX.liveAt(RD.liveFor(sim), tile)) continue;
		dead++;
		if (GX.pendingTrigger(sim)) pendDead++;
		else { cut++; if (firstCut < 0) firstCut = t; }
	}
	check('a purple switch pressed while its gate overlaps the ball (the press deferred) and a one-way portal into its doors\' room: holding right finishes; the states roomDead calls dead ends all have the press pending, none is cut (goexplore.js pendingTrigger)',
		!!ev && ev.deaths === 0 && GX.deathMovesFor(L) === false && pendDead > 0 && cut === 0,
		`${ev ? `${ev.ms.length} ticks, ${ev.runTicks} run ticks, ${ev.deaths} deaths` : 'no finish'}; ${n} states, ${dead} not live in their room, ${pendDead} of them with a trigger pending, ${cut} cut${firstCut >= 0 ? ` (first at tick ${firstCut})` : ''}`);
	// the one search itself (roomDead on): a route
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachH-'));
	const file = path.join(dir, 'defer1.eelvl');
	fs.writeFileSync(file, buf);
	let found = null, start = null, err = '';
	const wk = [];
	try {
		const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), file, '--seconds=20', '--workers=1', '--seed=1', '--first=1', '--mem=200'], { encoding: 'utf8', timeout: 60000 });
		for (const line of out.split('\n')) {
			if (!line.startsWith('{')) continue;
			const e = JSON.parse(line);
			if (e.ev === 'start') start = e;
			if (e.ev === 'done' && Array.isArray(e.workers)) wk.push(...e.workers);
			if (e.ev === 'result' && e.kind === 'finish' && !found) found = e;
		}
	} catch (e) { err = e.message.slice(0, 200); }
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* in use */ }
	const rep = found ? C.evaluate(L, Uint8Array.from(found.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31)) : null;
	const w0 = wk.find((w) => w && w.roomDead !== undefined) || null;
	check('the one search on it (goexplore.js, 1 worker, roomDead on): a route through the deferred press, replayed',
		!!start && start.cells === 'coarse' && start.deathMoves === false && !!rep && rep.deaths === 0,
		`${found ? `${found.ticks} ticks after ${found.sec} s, replayed ${rep ? `${rep.runTicks} run ticks` : 'NO FINISH'}` : `no route${err ? ` (${err})` : ''}`}; cells ${start && start.cells}, deaths as moves ${start && start.deathMoves}${w0 ? `, roomDead ${w0.roomDead}, cut ${w0.deadCut}` : ''}`);
}
/** the room-aware dead ends (goexplore.js roomDead, --roomDead): random rooms of coin / switch / key / team doors and
 *  gates, their triggers, spikes, protection, time doors, portals; states of random runs on a tile that is not live in
 *  their room, each checked by a bounded exhaustive search from it (1 px / 1/8 px/tick cells): it never finishes and never
 *  changes the room alive */
function roomDeadFuzz() {
	const GX = require('../src/goexplore.js');
	let seed = 20260928;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const OPTS = [0, 1, 2, 4, 8, 16, 3, 5, 9, 10, 12, 17, 18, 20, 24, 11, 13];
	const KINDS = [[43, 1], [43, 2], [165, 1], [100], [100], [113, 1], [184, 1], [185, 1], [6], [23], [26], [423, 1], [1027, 1], [1028, 1], [420, 1], [361, 1], [361, 1], [156], [157], [360], [4], [2], [1052, 1], [9], [9], [9]];
	let rooms = 0, runs = 0, dead = 0, checked = 0, viol = 0, first = null;
	const ROOMS = QUICK ? 10 : 30;
	for (let k = 0; k < ROOMS; k++) {
		const W = 14 + Math.floor(rnd() * 14), H = 10 + Math.floor(rnd() * 8), cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		// walls of doors splitting the room, then random blocks of every kind
		for (let n = 0; n < 2; n++) { const x = 3 + Math.floor(rnd() * (W - 6)), d = KINDS[Math.floor(rnd() * 14)]; if (d[0] === 100 || d[0] === 6 || d[0] === 113 || d[0] === 423 || d[0] === 420) continue; for (let y = 1; y < H - 1; y++) cells.push([x, y, ...d]); }
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rnd() < 0.12) { const d = KINDS[Math.floor(rnd() * KINDS.length)]; cells.push([x, y, ...d]); }
		if (k % 3 === 0) cells.push([1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 0, 1, 2], [1 + Math.floor(rnd() * (W - 2)), 1 + Math.floor(rnd() * (H - 2)), 242, 0, 2, k % 2 ? 1 : 9]);
		cells.push([W - 2, 1 + Math.floor(rnd() * (H - 2)), 121], [1, H - 2, 255]);
		let L;
		try { L = levelOfCells(W, H, cells); } catch (e) { continue; }
		rooms++;
		const RM = GX.roomOf(L), RD = GX.roomDead(L, 1 << 24);
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let r = 0; r < (QUICK ? 15 : 30); r++) {
			runs++;
			sim.reset();
			let m = OPTS[Math.floor(rnd() * OPTS.length)];
			for (let t = 0; t < 250; t++) {
				if (rnd() < 0.12) m = OPTS[Math.floor(rnd() * OPTS.length)];
				E.applyMask(inp, m); sim.tick(inp);
				if (sim.is_dead || sim.has_silver_crown) break;
				const tile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
				if (GX.liveAt(RD.liveFor(sim), tile) || GX.pendingTrigger(sim)) continue;   // (the product's cut: not live, nothing pending)
				dead++;
				if (checked >= (QUICK ? 40 : 120)) continue;
				checked++;
				// a bounded exhaustive search from this state: a finish or a room change alive disproves the dead end
				const key0 = RM.key(sim), s2 = new E.EESim(L), i2 = new E.EEInput();
				let layer = [sim.snapshot()];
				const seen = new Set();
				let bad = null;
				for (let d = 0; d < 90 && layer.length && !bad; d++) {
					const next = [];
					for (const sn of layer) {
						for (const mm of OPTS) {
							s2.restore(sn); E.applyMask(i2, mm); s2.tick(i2);
							if (s2.is_dead) continue;
							if (s2.has_silver_crown || RM.key(s2) !== key0) { bad = { d: d + 1, finish: s2.has_silver_crown, room: RM.desc(s2) }; break; }
							const kk = `${Math.round(s2.px)},${Math.round(s2.py)},${Math.round(s2.speed_x * 8)},${Math.round(s2.speed_y * 8)},${s2.on_ground ? 1 : 0},${s2.jump_count},${s2._q0},${s2._q1}`;
							if (seen.has(kk)) continue;
							seen.add(kk);
							next.push(s2.snapshot());
						}
						if (bad) break;
					}
					layer = next.length > 20000 ? next.slice(0, 20000) : next;
				}
				if (bad) { viol++; if (!first) first = { room: k, run: r, t, tile: [tile % W, (tile / W) | 0], room0: RM.desc(sim), bad }; }
			}
		}
	}
	// the corpus: every state of every job's original and best run up to its first death (the searches drop dead balls; a run
	// that dies uses the death as a move) is live in its room (or has a trigger pending: the product's cut), and none is cut
	// off by the death-free field; only levels where deaths are not moves (goexplore.js deathMovesFor false): roomDead and
	// the death-free field apply only there (with deaths as moves a run may die on purpose: Good Egg's runs 1-2 ticks
	// before a deliberate death are dead ends of their room, and the product uses neither there: the soundness review's
	// blocker 2)
	const JOBS = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	let jobs = [];
	try { jobs = fs.readdirSync(JOBS).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(JOBS, d, 'meta.json'))); } catch (e) { /* none */ }
	let cn = 0, cdead = 0, cfirst = null, cruns = 0, cndf = 0, cdf = 0, cfirstDf = null, cdfDying = 0, cdm = 0, clv = 0;
	const seenLv = new Map();
	for (const id of jobs) {
		const lf = path.join(JOBS, '..', 'data', `job_${id.replace(/-/g, '_')}.json`);
		let L;
		try { L = fs.existsSync(lf) ? E.loadLevel(lf) : E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(JOBS, id, 'original.eelvl'))))); } catch (e) { continue; }
		if (L.width * L.height <= 2500) continue;   // (coarse cells only: the levels above 50 x 50)
		if (GX.deathMovesFor(L)) { cdm++; continue; }   // (deaths as moves: neither roomDead nor the death-free field)
		clv++;
		const RM = GX.roomOf(L), RD = GX.roomDead(L, 1 << 26), FD = R.reachField(L, { deaths: false });
		for (const run of ['original.eetas', 'best.eetas']) {
			const file = path.join(JOBS, id, run);
			if (!fs.existsSync(file)) continue;
			const masks = C.readEetas(file);
			cruns++;
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			for (let t = 0; t <= masks.length; t++) {
				if (t > 0) { E.applyMask(inp, masks[t - 1]); sim.tick(inp); }
				if (sim.is_dead || sim.has_silver_crown) break;
				const tile = (Math.trunc(sim.py + 8) >> 4) * L.width + (Math.trunc(sim.px + 8) >> 4);
				cn++;
				if (!GX.liveAt(RD.liveFor(sim), tile) && !GX.pendingTrigger(sim)) { cdead++; if (!cfirst) cfirst = { id, run, t, tile: [tile % L.width, (tile / L.width) | 0], room: RM.desc(sim) }; }
				cndf++;
				if (R.costAt(FD, sim) < 0) { const nx = t < masks.length ? (() => { const s3 = new E.EESim(L); s3.restore(sim.snapshot()); const i3 = new E.EEInput(); E.applyMask(i3, masks[t]); s3.tick(i3); return s3.is_dead; })() : false; if (!nx) { cdf++; if (!cfirstDf) cfirstDf = { id, run, t, tile: [tile % L.width, (tile / L.width) | 0] }; } else cdfDying++; }
			}
		}
	}
	// (nothing to test: no jobs folder, or no job above 50 x 50 without deaths as moves: said, not passed; with --jobs= given
	// that is a failure: the green run of a worktree without src/jobs tested nothing)
	if (cruns === 0) {
		const why = `${jobs.length} jobs in ${JOBS}, ${clv} levels above 50 x 50 without deaths as moves, ${cdm} with them (skipped)`;
		if (arg('jobs', null) !== null) check('the job corpus (roomDead, the death-free field): tested something', false, `NOTHING TESTED: ${why}`);
		else console.log(`  (skipped: the job corpus tested nothing: ${why}; give --jobs=<the app's src/jobs>)`);
	} else {
		check(`every state of every job's runs above 50 x 50 without deaths as moves up to its first death (${cruns} runs of ${clv} levels; ${cdm} levels with deaths as moves skipped): live in its room (roomDead, or a trigger pending) and not cut off by the death-free field`, cdead === 0 && cdf === 0,
			`${cn} states, ${cdead} cut as dead ends, ${cdf} cut off by the death-free field (${cdfDying} more on a killing tile the tick before the run's death)${cfirst ? `; first ${JSON.stringify(cfirst)}` : ''}${cfirstDf ? `; first cut ${JSON.stringify(cfirstDf)}` : ''}`);
	}
	check(`the room-aware dead ends (goexplore roomDead): ${rooms} random rooms of doors, triggers, spikes, portals; ${runs} random runs: from every state on a tile not live in its room that a bounded exhaustive search checked (90 ticks), no finish and no room change alive`,
		viol === 0 && checked > 0, `${dead} dead states, ${checked} checked, ${viol} violations${first ? `; first ${JSON.stringify(first)}` : ''}`);
}
/** the viewing-room trap level (test/editor.js's one search runs on it too): 80 x 40, walk mode */
/**
 * the silent portals (reach.js silentPortals: portal tiles EE never teleports from, no exits in any builder). A trophy
 * pocket open to the left holds a self-target portal A (id 0 -> 0) next to the trophy; another id-0 self-target B sits
 * by the spawn (Christmas Tree Quest: 611 id-0 portals, one 5 tiles from the trophy). A portal S (id 5 -> 7) sends the ball
 * to T (id 7 -> 8), whose 8 neighbours are walls: a ball there keeps lastPortal and can never leave, so T's own exit U
 * (id 8, by the pocket) is none of its ways (a sealed exit read lower than the start). An open exit X (id 12 -> 8) of V
 * (id 11 -> 12) keeps its exits. Checked: the marks, the engine (S puts the ball on T and it stays there through random
 * inputs; a ball on B never reaches A), the reach field (T cut off: a proof, it truly never gets out; S and B far), the
 * burst walk's and the steer field's portal tables, the searches' sound lower bounds (goexplore.js, timed.js).
 */
function silentPortalRooms() {
	const GX = require('../src/goexplore.js'), BU = require('../src/bursts.js'), SF = require('../src/steer.js'), TM = require('../src/timed.js');
	const W = 40, H = 14, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
	for (let x = 28; x <= 32; x++) cells.push([x, 2, 9], [x, 4, 9]);
	cells.push([32, 3, 9], [30, 3, 121], [31, 3, 242, 0, 0, 0], [27, 3, 242, 0, 8, 9]);   // the pocket, A, U
	for (let x = 35; x <= 37; x++) cells.push([x, 6, 9], [x, 8, 9]);
	cells.push([35, 7, 9], [37, 7, 9], [36, 7, 242, 0, 7, 8]);   // T sealed
	cells.push([2, H - 2, 255], [6, H - 2, 242, 0, 0, 0], [10, H - 2, 242, 0, 5, 7], [14, H - 2, 242, 0, 11, 12], [20, H - 2, 242, 0, 12, 8]);   // spawn, B, S, V, X
	const L = levelOfCells(W, H, cells);
	const at = (x, y) => y * W + x, A = at(31, 3), U = at(27, 3), T = at(36, 7), B = at(6, H - 2), S = at(10, H - 2), V = at(14, H - 2), X = at(20, H - 2);
	const sil = R.silentPortals(L);
	check('silent portals: self-target A and B, the sealed exit T; not S, U, V or the open exit X', sil[A] && sil[B] && sil[T] && !sil[S] && !sil[U] && !sil[V] && !sil[X],
		`A ${sil[A]} B ${sil[B]} T ${sil[T]} S ${sil[S]} U ${sil[U]} V ${sil[V]} X ${sil[X]}`);
	// the engine: S -> T, then T holds the ball whatever it presses; B never teleports
	const sim = new E.EESim(L); sim.reset();
	sim.px = 10 * 16; sim.py = (H - 2) * 16; sim.speed_x = 0.5; sim.speed_y = 0; sim._last_portal_set = false;
	const inp = new E.EEInput();
	sim.tick(inp);
	const onT = () => ((sim.px + 8) >> 4) === 36 && ((sim.py + 8) >> 4) === 7;
	let arrived = onT(), stayed = arrived, rnd = 12345;
	for (let t = 0; t < 400 && stayed; t++) { rnd = (rnd * 1103515245 + 12345) >>> 0; E.applyMask(inp, (rnd >>> 16) % 32); sim.tick(inp); if (!onT()) stayed = false; }
	const sb = new E.EESim(L); sb.reset();
	sb.px = 6 * 16; sb.py = (H - 2) * 16; sb.speed_x = 0.5; sb._last_portal_set = false;
	let neverA = true;
	for (let t = 0; t < 60; t++) { E.applyMask(inp, t < 20 ? 0 : 4); sb.tick(inp); if (((sb.px + 8) >> 4) === 31 && ((sb.py + 8) >> 4) === 3) neverA = false; }
	check('the engine: S puts the ball on the sealed T, where it stays through 400 random ticks; a ball on the self-target B never reaches A', arrived && stayed && neverA,
		`arrived ${arrived}, stayed ${stayed}, B never at A ${neverA}`);
	for (const deaths of [true, false]) {
		const f = R.reachField(L, { deaths });
		const c = (x, y) => R.costAt(f, x * 16, y * 16, 0);
		const cT = c(36, 7), cS = c(10, H - 2), cB = c(6, H - 2), cX = c(20, H - 2), cU = c(27, 3), cV = c(14, H - 2);
		check(`reach field (${deaths ? 'with' : 'without'} death edges): the sealed T cut off, S and B not near the trophy through teleports EE never makes (their way is the walk to V: V + 3 or more; the base code: S 5 through T, B 2 through A), the open exit X keeps U's way`,
			cT < 0 && cV >= 0 && (cS < 0 || cS >= cV + 3) && (cB < 0 || cB >= cV + 3) && cX >= 0 && cU >= 0 && (cX <= cU + 1.5),
			`T ${fmt(cT)}, S ${fmt(cS)}, B ${fmt(cB)}, V ${fmt(cV)}, X ${fmt(cX)}, U ${fmt(cU)}`);
	}
	const pe = BU.portalsOf(L).exits, st = SF.analyze(L, {}).portalExits;
	const tab = (m) => [A, B, T, S, V, X].map((i) => (m.has(i) ? 1 : 0)).join('');
	check('the burst walk (bursts.js portalsOf) and the steer field (steer.js analyze) give A, B and T no exits, S, V and X theirs', tab(pe) === '000111' && tab(st) === '000111',
		`A B T S V X: bursts ${tab(pe)}, steer ${tab(st)}`);
	const lb = GX.lowerBoundTiles(L), tro = [at(30, 3)], lt = TM.lowerBoundTo(L, tro);
	check('the sound lower bounds (goexplore.js lowerBoundTiles, timed.js lowerBoundTo): the sealed T no way to the trophy, S by its walk to V (V -> X -> U; not through T)',
		lb[T] === 0xffff && lb[S] >= 2 && lb[S] > lb[U] && lt[T] === 0xffff && lt[S] >= 2 && lt[S] > lt[U],
		`goexplore T ${lb[T]} S ${lb[S]} U ${lb[U]}; timed T ${lt[T]} S ${lt[S]} U ${lt[U]}`);
}
/** S: the side-arrow and slot prices (ordering only): the engine's crossing numbers the rule stands on, a toy tunnel of 5
 *  opposing arrows priced (its far side dearer by the price, the start then valued by the detour) and not priced with a
 *  side boost before it, the -1 set of every mode the plain model's (random rooms and the toys), the slot rule, the knob */
function sectionS() {
	section('S: side-arrow and slot prices (ordering only)');
	// (a) the engine: a runway into k left arrows (a 1-tall tunnel), the ball put 2 tiles before at v, R held
	const crosses = (k, v) => {
		const W = 60, H = 8, c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9], [x, H - 2, 9]);
		for (let y = 0; y < H; y++) c.push([0, y, 9], [W - 1, y, 9]);
		for (let i = 0; i < k; i++) c.push([30 + i, H - 3, 1]);
		for (let x = 27; x < 33 + k; x++) c.push([x, H - 4, 9]);
		c.push([2, H - 3, 255], [W - 3, H - 3, 121]);
		const L = levelOfCells(W, H, c), sim = new E.EESim(L); sim.reset(); const I = new E.EEInput();
		sim.px = 28 * 16; sim.py = (H - 3) * 16; sim.speed_x = v; sim.speed_y = 0;
		for (let t = 0; t < 300; t++) { E.applyMask(I, 4); sim.tick(I); if ((Math.trunc(sim.px + 8) >> 4) >= 30 + k) return true; }
		return false;
	};
	check('engine: 4 opposing arrows crossed at 6.7 px/tick (the running speed after ~60 tiles), 5 not', crosses(4, 6.7) && !crosses(5, 6.7));
	check('engine: 5 need at least 6.75 (the running limit 6.78), 6 more than 6.78', crosses(5, 6.8) && !crosses(5, 6.7) && !crosses(6, 6.78));
	check('engine: from a side boost (16 px/tick) 12 opposing arrows are crossed', crosses(12, 16));
	// (b) a toy: the spawn left, a 1-tall tunnel of 5 left arrows to the trophy's room, a long way round over the top
	const toy = (boost) => {
		// the spawn (2, 11) in the left room (x 1-28), a 1-tall tunnel of 5 left arrows (30-34, 11) under a roof (row 10) into
		// the right room (x 36-58) with the trophy (45, 11); the way round: a ladder (28, 2-11) up to row 1, over the dividing
		// walls (x 29 and 35, rows 2-10), down into the right room
		const W = 60, H = 14, c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9], [x, 12, 9]);
		for (let y = 0; y < H; y++) c.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 2; y <= 10; y++) c.push([29, y, 9], [35, y, 9]);
		for (let x = 30; x <= 34; x++) c.push([x, 10, 9], [x, 11, 1]);
		for (let y = 2; y <= 11; y++) c.push([28, y, 120]);
		c.push([2, 11, 255], [45, 11, 121]);
		if (boost) c.push([20, 11, 115]);
		return levelOfCells(W, H, c);
	};
	for (const boost of [false, true]) {
		const L = toy(boost), sim = new E.EESim(L); sim.reset();
		const f0 = R.reachField(L, { sideArrow: 'off' }), f1 = R.reachField(L, { sideArrow: 'arrows' });
		const W = L.width, last = 34 + 11 * W, past = 35 + 11 * W;   // (the tunnel's last arrow and the tile past it)
		const s0 = R.costAt(f0, sim), s1 = R.costAt(f1, sim);
		const cF = (f, t) => f.costF[t * (R.KF + 1)] / 5;
		let same = true;
		for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) for (let i = 0; i < f0[k].length; i++) if ((f0[k][i] === R.CUT) !== (f1[k][i] === R.CUT)) same = false;
		check(`toy ${boost ? 'with a right boost before the tunnel' : 'tunnel'}: the -1 set = the plain model's`, same);
		if (!boost) {
			check('toy tunnel: its last arrow valued by the way back and round, not by the 1 tile past it (priced)', f1.sideArrow.arrows > 0 && cF(f1, last) > cF(f0, last) + 20 && cF(f1, past) === cF(f0, past), `${cF(f0, last)} -> ${cF(f1, last)} (past it ${cF(f0, past)} -> ${cF(f1, past)})`);
			check('toy tunnel: the start valued by the way round (dearer than the plain tunnel way, far below the price)', s1 > s0 + 5 && s1 < s0 + 2500, `${s0.toFixed(1)} -> ${s1.toFixed(1)}`);
		} else check('toy with a boost: the run is fed (no price), the start value the plain model\'s', f1.sideArrow.arrows === 0 && f1.sideArrow.fed >= 1 && s1 === s0, `${s0.toFixed(1)} / ${s1.toFixed(1)}`);
	}
	// (c) the -1 sets of every mode on random rooms (arrows, dots, boosts, portals, spikes, doors): the plain model's
	let diff = 0, priced = 0, n = 0;
	for (const { level } of randomLevels()) {
		const f0 = R.reachField(level, { sideArrow: 'off' });
		for (const mode of ['arrows', 'all']) {
			const f1 = R.reachField(level, { sideArrow: mode, check: true });
			n++;
			if (f1.mismatches) diff += 1000;
			priced += (f1.sideArrow.arrows || 0) + (f1.sideArrow.slots || 0);
			if (f0.mode === 'walk') continue;
			for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) for (let i = 0; i < f0[k].length; i++) if ((f0[k][i] === R.CUT) !== (f1[k][i] === R.CUT)) diff++;
		}
	}
	check(`random rooms (${n} fields): the -1 sets of both modes = the plain model's, the Bellman self-check holds with the prices`, diff === 0, `${diff} differ, ${priced} priced moves`);
	// (d) the slot rule ('all'): a slot entered sideways from the air is priced, from a floor at its height not
	{
		const W = 30, H = 12, c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 0; y < H; y++) c.push([0, y, 9], [W - 1, y, 9]);
		for (let x = 12; x <= 18; x++) c.push([x, 5, 9], [x, 7, 9]);   // the slot: row 6, x 12-18
		for (let x = 1; x <= 11; x++) c.push([x, 10, 9]);
		c.push([3, 9, 255], [22, 9, 121]);
		const L = levelOfCells(W, H, c), f = R.reachField(L, { sideArrow: 'all', debug: true });
		let fromAir = 0, fromFloor = 0;
		f._m.edgesOf(6 * W + 11, 1, 0, (t2, ty2, l2, add) => { if (t2 === 6 * W + 12 && add > 100) fromAir++; });
		const L2 = levelOfCells(W, H, [...c, [11, 7, 9]]), f2 = R.reachField(L2, { sideArrow: 'all', debug: true });
		f2._m.edgesOf(6 * W + 11, 1, 0, (t2, ty2, l2, add) => { if (t2 === 6 * W + 12 && add > 100) fromFloor++; });
		check('slots: a sideways entry from the air priced, from a floor at the slot\'s height not', fromAir > 0 && fromFloor === 0, `${fromAir} / ${fromFloor}`);
	}
	// (e) the knob: EEAT_SIDEARROW=0 = the plain model (the same tables byte for byte)
	{
		const L = toy(false);
		const prev = process.env.EEAT_SIDEARROW;
		process.env.EEAT_SIDEARROW = '0';
		const a = R.reachField(L);
		if (prev === undefined) delete process.env.EEAT_SIDEARROW; else process.env.EEAT_SIDEARROW = prev;
		const b = R.reachField(L, { sideArrow: 'off' }), d = R.reachField(L);
		let same = true;
		for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) if (Buffer.compare(Buffer.from(a[k].buffer), Buffer.from(b[k].buffer)) !== 0) same = false;
		check('knob: EEAT_SIDEARROW=0 = the plain model byte for byte; the default prices (arrows)', same && d.sideArrow.on && d.sideArrow.mode === 'arrows' && d.sideArrow.arrows > 0);
	}
}
/** Q: the half-block quadrants (exact: the moves the box cannot make next to half blocks). (a) The Spring Relics capsule:
 *  a portal P (id 1 -> 2) at (6, 5) under a roof, a wall under it (the shut team door), a right half block (1043, rotation
 *  0) at (7, 5) beside it: the ball below reaches P neither up the half block's tile (its centre only at x = 16 x 7, where
 *  the box overlaps the wall under P) nor diagonally past it; the trophy is behind P's exit. The engine's search finds no
 *  route; the field with the rule cuts the start off (a proof), without it the diagonal was open. With the wall under P
 *  made air the engine routes and the field is finite. (b) Random rooms full of half blocks at every rotation: every state
 *  from which a small engine search reached the trophy finite; the Bellman self-check. (c) The knob and the byte-for-byte
 *  fields of a level without half blocks. */
function sectionQ() {
	section('Q: half-block quadrants (exact)');
	const capsule = (doorWall) => {
		// the ball's room: x 7-14 (6 too without the door wall), y 6-7 on a floor (row 8); over it row 5: P (6, 5), the
		// right half block (7, 5), air (8, 5), a left half block (9, 5), walls; a roof (row 4)
		const W = 24, H = 12, c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
		for (let x = 1; x <= 15; x++) c.push([x, 4, 9], [x, 8, 9]);
		for (let y = 5; y <= 7; y++) c.push([5, y, 9], [15, y, 9]);
		c.push([6, 7, 9]);
		for (let x = 10; x <= 14; x++) c.push([x, 5, 9]);
		c.push([6, 5, 242, 0, 1, 2], [7, 5, 1043, 0], [9, 5, 1043, 2]);
		if (doorWall) c.push([6, 6, 9]);
		// the trophy's box (x 17-22, y 1-3), P's exit Q (id 2 -> 3, nothing is id 3) at (18, 2)
		for (let x = 16; x <= 22; x++) c.push([x, 4, 9]);
		for (let y = 1; y <= 3; y++) c.push([16, y, 9]);
		c.push([18, 2, 242, 0, 2, 3], [20, 2, 121], [12, 7, 255]);
		return levelOfCells(W, H, c);
	};
	{
		const L = capsule(true), s = startSim(L, 0);
		const on = R.reachField(L, { halfQuad: true, check: true }), off = R.reachField(L, { halfQuad: false });
		const tr = engineRoute(L, 700, 4000);
		check('capsule (wall under the portal): the engine finds no route; the field with the rule cuts the start off, without it the start was finite (the diagonal past the half block)',
			!tr && R.costAt(on, s) < 0 && R.costAt(off, s) >= 0 && on.mismatches === 0 && on.halfQuad > 0, `engine ${tr ? tr.length : 'none'}, start ${fmt(R.costAt(on, s))} (off ${fmt(R.costAt(off, s))}), ${on.halfQuad} closed moves`);
		const L2 = capsule(false), s2 = startSim(L2, 0), on2 = R.reachField(L2, { halfQuad: true, check: true });
		const tr2 = engineRoute(L2, 700, 4000, true, 20);
		const a = tr2.route ? aheadCut(L2, on2, tr2.ahead) : null;
		check('capsule with the wall under the portal made air: the engine routes (through the portal), the start finite, no state leading to the trophy cut off',
			!!tr2.route && R.costAt(on2, s2) >= 0 && a && a.cut === 0 && on2.mismatches === 0, `engine ${tr2.route ? tr2.route.length : 'none'}, start ${fmt(R.costAt(on2, s2))}, ${a ? `${a.n} states, ${a.cut} cut` : ''}`);
	}
	// (b) random rooms with half blocks (1043 at rotations 0-3, 1041, presents): every state the engine's search reached the
	// trophy from is finite, the self-check holds
	{
		let seed = 77;
		const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
		let rooms = 0, routed = 0, states = 0, cut = 0, bad = 0, closed = 0, first = null;
		for (let k = 0; k < (QUICK ? 8 : 24); k++) {
			const W = 12 + (k % 3) * 3, H = 9 + (k % 2) * 3, cells = [];
			for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
			for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
			for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
				const r = rnd();
				if (r < 0.14) cells.push([x, y, 9]);
				else if (r < 0.34) cells.push([x, y, [1043, 1041, 1101][Math.floor(rnd() * 3)], Math.floor(rnd() * 4)]);
			}
			cells.push([W - 3, 1, 121], [2, H - 2, 255]);
			const L = levelOfCells(W, H, cells), f = R.reachField(L, { halfQuad: true, check: true });
			rooms++;
			closed += f.halfQuad;
			if (f.mismatches) bad++;
			const tr = engineRoute(L, 500, 3000, true, 15);
			if (!tr.route) continue;
			routed++;
			const a = aheadCut(L, f, tr.ahead);
			states += a.n; cut += a.cut;
			if (a.cut && !first) first = { k, state: a.first };
		}
		check(`random half-block rooms (${rooms}): every state from which the engine reached the trophy finite, the self-check holds`, cut === 0 && bad === 0 && routed > 0 && closed > 0,
			`${routed} routed, ${states} states, ${cut} cut, ${bad} self-check failures, ${closed} closed moves${first ? `; first ${JSON.stringify(first)}` : ''}`);
	}
	// (c) the knob: EEAT_HALFQUAD=0 = halfQuad false byte for byte; a level without half blocks: the same field with the rule
	{
		const L = capsule(true);
		const prev = process.env.EEAT_HALFQUAD;
		process.env.EEAT_HALFQUAD = '0';
		const a = R.reachField(L);
		if (prev === undefined) delete process.env.EEAT_HALFQUAD; else process.env.EEAT_HALFQUAD = prev;
		const b = R.reachField(L, { halfQuad: false });
		let same = a.halfQuad === 0 && Buffer.compare(Buffer.from(a.walk.buffer), Buffer.from(b.walk.buffer)) === 0;
		for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) if (Buffer.compare(Buffer.from(a[k].buffer), Buffer.from(b[k].buffer)) !== 0) same = false;
		let plain = 0, n = 0;
		for (const { level } of randomLevels()) {
			let half = false;
			for (let i = 0; i < level.fg.length; i++) if ((level.flags[level.fg[i]] & 8) !== 0) half = true;
			if (half) continue;
			n++;
			const x = R.reachField(level, { halfQuad: true }), y = R.reachField(level, { halfQuad: false });
			if (Buffer.compare(Buffer.from(x.walk.buffer), Buffer.from(y.walk.buffer)) !== 0) plain++;
			if (x.mode === 'physics') for (const k of ['costR', 'costF', 'costL']) if (Buffer.compare(Buffer.from(x[k].buffer), Buffer.from(y[k].buffer)) !== 0) plain++;
		}
		check('knob: EEAT_HALFQUAD=0 = halfQuad false byte for byte; the random rooms without half blocks: the same fields with the rule', same && plain === 0, `${n} rooms without half blocks, ${plain} differ`);
	}
	// (e) the exit from the entry (opts.exitEntry, the steer's ordering fields): a walk-in portal P (rotation 0) whose exit
	// Q (rotation 0) is the floor of a shaft, the trophy on a ledge 9 rows up: the engine never reaches the ledge (a jump from
	// Q rises ~4 rows; the ball walks into P); the field without it reads the exit's teleport rise ("R(cap)") and the ledge
	// near, with it the start cut off; the random rooms (their portal pairs of rotation 0) keep the self-check and every
	// state the engine reached the trophy from finite
	{
		const W = 30, H = 16, c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) c.push([12, y, 9]);   // the wall between the start room and the shaft
		for (let y = 1; y < H - 1; y++) c.push([18, y, 9]);
		c.push([3, H - 2, 255], [9, H - 2, 242, 0, 1, 2], [15, H - 2, 242, 0, 2, 3]);   // S, P (1 -> 2) on the floor, Q (id 2) at the shaft's bottom
		c.push([13, 5, 9], [14, 5, 9], [13, 4, 121]);   // the ledge (rows up from Q) with the trophy
		const L = levelOfCells(W, H, c), s = startSim(L, 0);
		const on = R.reachField(L, { exitEntry: true, check: true }), off = R.reachField(L, {});
		const tr = engineRoute(L, 500, 4000);
		check('exit from the entry: a walk-in portal into a shaft, the trophy 9 rows up: the engine finds no route; without the rule the field reads the ledge (the teleport\'s rise), with it the start cut off (ordering only)',
			!tr && R.costAt(off, s) >= 0 && R.costAt(on, s) < 0 && on.mismatches === 0, `engine ${tr ? tr.length : 'none'}, start ${fmt(R.costAt(on, s))} (off ${fmt(R.costAt(off, s))})`);
		let bad = 0, cut = 0, st = 0, routed = 0;
		for (const { level } of randomLevels()) {
			const f = R.reachField(level, { exitEntry: true, check: true });
			if (f.mismatches) bad++;
			const t = engineRoute(level, 400, 2500, true, 10);
			if (!t.route) continue;
			routed++;
			const a = aheadCut(level, f, t.ahead);
			st += a.n; cut += a.cut;
		}
		check('exit from the entry on the random rooms (portal pairs of one rotation): the self-check holds, every state the engine reached the trophy from finite', bad === 0 && cut === 0 && routed > 0, `${routed} routed, ${st} states, ${cut} cut, ${bad} self-check failures`);
	}
	// (d) the steer's walk layers: the capsule's portal out of the walk model's reach (layeredField), the old rule reached it
	{
		const SF = require('../src/steer.js');
		const L = capsule(true);
		const A1 = SF.analyze(L, { halfQuad: true }), A0 = SF.analyze(L, { halfQuad: false });
		const c1 = SF.layeredField(A1, SF.makeModel(A1, new Set())).cost, c0 = SF.layeredField(A0, SF.makeModel(A0, new Set())).cost;
		const st = A1.start.t;
		check('steer walk layers: the trophy out of reach from the start with the rule (the old rule: reached through the capsule portal)', c1[st] > 1e9 && c0[st] < 1e9, `start ${c1[st]} (old ${c0[st]})`);
	}
}
// ---------------------------------------------------------------- X the field transit tables (ordering only)
function sectionX() {
	section('X: the field transit tables (src/exitapex.json; reach.js opts.exitApex, ordering fields only)');
	const XT = require('../src/exitapex.json');
	const XG = require('../tools/exitapex.js');
	// (a) the table is this engine's, monotone, and bounds the engine on ids of every class (not only the ids it measured)
	const eng = require('crypto').createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'eesim.js'))).digest('hex').slice(0, 12);
	check('the table was measured on this engine (tools/exitapex.js; after an engine change run it again)', XT.engine === eng, `${XT.engine} / ${eng}`);
	let mono = true;
	for (const k of Object.values(XT.kinds)) for (const a of [k.up, k.in, k.exit]) for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) mono = false;
	check('every table non-decreasing in the speed class (an upper bound for every speed up to c / 8)', mono && Object.keys(XT.kinds).length === 5);
	const CS = QUICK ? [40, 127] : [0, 13, 40, 61, 90, 127];
	let over = 0, n = 0, worst = '';
	for (const id of QUICK ? [4, 120, 119] : [1, 2, 4, 114, 414, 98, 120, 459, 1602, 119, 369, 416]) {
		const L = levelOfCells(4, 4, [[1, 1, 255]]);
		const cl = R.classOfId(R.guideFlags(L), L.gMox, L.gMoy, id), k = XT.kinds[cl];
		const m = XG.measure(id, CS);
		CS.forEach((c, j) => {
			n++;
			const bad = !k || R.cOfV(m.up[j]) > k.up[c] || R.cOfV(m.in[j]) > k.in[c] || m.exit[j] > k.exit[c] + 1e-9;
			if (bad) { over++; if (!worst) worst = `id ${id} c ${c}: up ${m.up[j].toFixed(3)} in ${m.in[j].toFixed(3)} exit ${m.exit[j].toFixed(2)}`; }
		});
	}
	check(`the engine never exceeds the table (block ids x speed classes, ${n} cases)`, over === 0, worst || `${n} cases`);
	// (b) rooms: the ordering field (the steer bodies' options) without / with the tables, the proof field, the engine
	const ORD = (xa) => ({ oneWayEntry: true, portalForced: true, deaths: false, exitApex: xa });
	const room = (W, H, extra) => {
		const c = [];
		for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 0; y < H; y++) c.push([0, y, 9], [W - 1, y, 9]);
		return levelOfCells(W, H, [...c, ...extra]);
	};
	// the hand-made input plans (walk right, hold up (or up + right), then up / jump / none: the climbs of these rooms), and
	// the small breadth-first engine search: the first plan that finishes, else the search's route, else none
	const PLANS = [];
	for (const w of [10, 14, 18, 22, 26]) for (const up of [60, 120, 200]) for (const tail of [8, 9, 12, 13, 0]) PLANS.push(seqOf([4, w], [8, up], [tail, 60]));
	for (const w of [10, 14, 18, 22]) for (const up of [60, 120, 200]) PLANS.push(seqOf([4, w], [12, up], [8, 60]));
	const finishes = (L, p) => { const s = new E.EESim(L); s.reset(); const I = new E.EEInput(); for (const m of p) { E.applyMask(I, m); s.tick(I); if (s.has_silver_crown) return true; } return false; };
	const routeOf = (L, maxT) => {
		for (const p of PLANS) if (finishes(L, p)) return p;
		const eng = engineRoute(L, maxT, 4000);
		return eng || null;
	};
	const probe = (name, L, reach, maxT) => {
		const f0 = R.reachField(L, ORD(false)), f1 = R.reachField(L, ORD(true));
		const sim = startSim(L), s0 = R.costAt(f0, sim), s1 = R.costAt(f1, sim);
		const route = routeOf(L, maxT || 260);
		if (reach) {
			const w = route ? walk(L, f1, route) : null;
			check(`${name}: the engine reaches the trophy; with the tables the start and every state of the route finite`, !!route && s1 >= 0 && w.cut === 0 && w.finished, `route ${route ? route.length + ' ticks' : 'none'}, start ${fmt(s0)} -> ${fmt(s1)}${w ? `, ${w.cut} of ${w.n} cut` : ''}`);
		} else check(`${name}: the engine never reaches the trophy; the plain ordering field says it does (the pump), with the tables not`, !route && s0 >= 0 && s1 < 0, `engine ${route ? 'reached' : 'none'}, start ${fmt(s0)} -> ${fmt(s1)}`);
		return { f0, f1 };
	};
	// a chain top: a 6-tile chain (rows 22-27) on the floor, air beside it; the trophy 13 rows over its top (Happy
	// Spookaween: the model climbed the chain and the air beside it to a 24-row launch), or 1 row over it
	const chain = (ty) => room(20, 30, [...[22, 23, 24, 25, 26, 27].map((y) => [10, y, 120]), [8, 27, 255], [10, ty, 121]]);
	probe('chain top, the trophy 13 rows over it', chain(9), false);
	probe('chain top, the trophy 1 row over it', chain(21), true);
	// a dot rail: 8 dots (rows 30-37) on the floor, air beside; the trophy 14 rows over its top (Barrel Cannon Canyon: the
	// rail and the air beside it pumped to 16 px/tick) or 4 rows over it (the rail's own top speed 6.8 px/tick: 5.4 rows)
	const rail = (ty) => room(20, 40, [...[30, 31, 32, 33, 34, 35, 36, 37].map((y) => [10, y, 4]), [8, 37, 255], [10, ty, 121]]);
	probe('dot rail, the trophy 14 rows over it', rail(16), false);
	probe('dot rail, the trophy 4 rows over it', rail(26), true, 320);
	// a liquid pool under a one-way row (Cold World): the ball in a hole in the pool's floor, 4 rows of water, a row of
	// air, a one-way row; the model kept the jump's speed through the water. The trophy 5 rows over the pool's surface:
	// without the tables finite from the hole (a jump through 4 rows of water rises 6 rows over it), with them the water's
	// drag takes it (the engine: 6.7 -> 3.6 px/tick at the surface, the centre 2 rows over it)
	const pool = (ty, oneway) => {
		const c = [];
		for (let x = 1; x <= 14; x++) { c.push([x, 20, 9]); for (let y = 16; y <= 19; y++) c.push([x, y, 119]); if (oneway) c.push([x, 14, 1052, 1]); }
		c.push([7, 20, 0], [7, 21, 9], [7, 20, 255], [7, ty, 121]);
		return room(16, 24, c);
	};
	probe('pool, the trophy 5 rows over the water', pool(10, false), false, 200);
	probe('pool under a one-way row, the trophy right over the water', pool(15, true), true, 200);
	// (c) the proof field (no oneWayEntry) is never touched, whatever the knob; the knob off = the plain model byte for byte
	{
		const L = chain(9), prev = process.env.EEAT_EXITAPEX;
		process.env.EEAT_EXITAPEX = '1';
		const p1 = R.reachField(L), o1 = R.reachField(L, ORD(undefined));
		process.env.EEAT_EXITAPEX = '0';
		const p0 = R.reachField(L), o0 = R.reachField(L, ORD(undefined));
		if (prev === undefined) delete process.env.EEAT_EXITAPEX; else process.env.EEAT_EXITAPEX = prev;
		const ob = R.reachField(L, ORD(false));
		const same = (a, b) => ['costR', 'costF', 'costL', 'costC', 'costX', 'seg', 'rowC', 'rowX'].every((k) => Buffer.compare(Buffer.from(a[k].buffer), Buffer.from(b[k].buffer)) === 0);
		check('knob: the proof field the same bytes with EEAT_EXITAPEX=1 and 0; the ordering field on with 1, the plain model with 0 (byte for byte)', same(p1, p0) && !p1.exitApex && o1.exitApex && !o0.exitApex && same(o0, ob));
	}
	// (d) random rooms: the Bellman self-check holds with the tables; the states they free (plain -1, finite with them)
	let mis = 0, cut = 0, free = 0, fields = 0;
	for (const { level } of randomLevels()) {
		const f0 = R.reachField(level, ORD(false)), f1 = R.reachField(level, Object.assign(ORD(true), { check: true }));
		if (f1.mode === 'walk') continue;
		fields++;
		mis += f1.mismatches;
		for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) for (let i = 0; i < f0[k].length; i++) { if (f0[k][i] !== R.CUT && f1[k][i] === R.CUT) cut++; else if (f0[k][i] === R.CUT && f1[k][i] !== R.CUT) free++; }
	}
	check(`random rooms (${fields} physics fields): the Bellman self-check with the tables`, mis === 0, `${mis} mismatches; ${cut} states cut by the tables, ${free} freed`);
	// (e) the steer (steer.js buildSteer) with the tables on: a start they leave without a value (their error on a level,
	// which is beatable: the d4 A/B's Happy Spookaween) takes the plain model's steer; a start with a value keeps theirs
	{
		const SF = require('../src/steer.js'), prev = process.env.EEAT_EXITAPEX;
		const steerOf = (L, xa) => { process.env.EEAT_EXITAPEX = xa; try { const st = SF.buildSteer(L, {}); return { st, v: SF.steerAt(st, startSim(L)) }; } finally { if (prev === undefined) delete process.env.EEAT_EXITAPEX; else process.env.EEAT_EXITAPEX = prev; } };
		const L9 = chain(9), a0 = steerOf(L9, '0'), a1 = steerOf(L9, '1');
		check('steer fallback: the tables leave the start without a value (chain top, the trophy 13 rows over it): the plain model\'s steer, its start value, the fallback in info.exitApex',
			a0.v >= 0 && a1.v === a0.v && !!a1.st.info.exitApex && a1.st.info.exitApex.start === null && !a0.st.info.exitApex, `plain ${fmt(a0.v)}, tables ${fmt(a1.v)}${a1.st.info.exitApex ? ` (${a1.st.info.exitApex.off})` : ''}`);
		const L21 = chain(21), b1 = steerOf(L21, '1');
		check('steer fallback: a start with a value with the tables (chain top, the trophy 1 row over it) keeps the tables\' steer', b1.v >= 0 && !b1.st.info.exitApex, `tables ${fmt(b1.v)}`);
	}
}
// ---------------------------------------------------------------- M the air jumps (opts.airJumps, EEAT_AIRJUMP=1)
function sectionM() {
	section('M the air jumps: a level whose only effect tiles are multijumps, the physics field with an air jump anywhere (opts.airJumps)');
	// (m: multijump 2, n: 1000 (unlimited), j: 0 (no jump))
	Object.assign(ID, { m: [461, 2], n: [461, 1000], j: [461, 0] });
	const MJ = [
		// (the spawn right over the effect tile: the ball falls into it at once, so the small engine search, whose state key
		// has no max_jumps, never merges a ball with the effect into one without it)
		['mj-ledge5 (a double jump onto a 5-row ledge)', 'yes', ['..............', '..............', '..............', '.........T....', '........######', '........######', '........######', '..S.....######', '..m.....######']],
		['mj-ledge7 (1000 jumps, a 7-row ledge)', 'yes', ['..............', '..............', '.........T....', '........######', '........######', '........######', '........######', '........######', '..S.....######', '..n.....######']],
		['mj-zero (no jump at all, the ledge3 room: the field stays optimistic)', 'finite', ['..............', '..............', '..............', '..............', '.........T....', '........######', '..S.....######', '..j.....######']],
	];
	for (const [name, want, rows] of MJ) {
		const L = ascii(box(rows));
		const off = R.reachField(L), f = R.reachField(L, { airJumps: true, check: true });
		const s = startSim(L, 30), c = R.costAt(f, s);
		let ok = f.mode === 'physics' && f.airJumps === true && off.mode === 'walk' && f.mismatches === 0 && c >= 0;
		let detail = `off: ${off.mode}; on: ${f.mode}, start ${fmt(c)}, ${f.mismatches} mismatches`;
		if (want === 'yes') {
			// (the double / multi jumps as scripted runs: settle, run right a ticks, jump, b ticks, jump (and again every b
			// ticks with 1000 jumps), right on: every run that finishes, every state of it finite; the small engine search
			// keeps 1,500 states a layer in its masks' order and loses the timed second press)
			let runs = 0, states = 0, cut = 0, first = null;
			for (let a = 0; a <= 60; a += 6) for (let b = 4; b <= 30; b += 2) {
				const ms = [];
				for (let t = 0; t < 20; t++) ms.push(0);
				for (let t = 0; t < a; t++) ms.push(4);
				for (let k = 0; k < 6; k++) { ms.push(5); for (let t = 0; t < b; t++) ms.push(4); }
				for (let t = 0; t < 120; t++) ms.push(4);
				const w = walk(L, f, ms);
				if (!w.finished) continue;
				runs++; states += w.n; cut += w.cut; if (w.first && !first) first = w.first;
			}
			ok = ok && runs > 0 && cut === 0;
			detail += `; ${runs} scripted runs finish, ${states} states, ${cut} cut off${first ? ` (first ${JSON.stringify(first)})` : ''}`;
		}
		check(`${name}: off the walk, on the physics with air jumps, finite${want === 'yes' ? ', every state of the scripted multijump runs that finish finite' : ''}`, ok, detail);
	}
	{
		// (the same 5-row ledge without the multijump tile: a plain level, the physics field proves it cut off, so the air
		// jumps are what the field above gives)
		const L = ascii(box(MJ[0][2].map((r) => r.replace('m', '.'))));
		const f = R.reachField(L, { airJumps: true }), c = R.costAt(f, startSim(L, 30));
		check('mj-ledge5 without the multijump tile: cut off (no air jumps on a plain level)', f.mode === 'physics' && !f.airJumps && c < 0, `${f.mode}, ${fmt(c)}`);
	}
	{
		// (another effect with the multijumps (a low gravity tile): the walk as before)
		const L = ascii(box(MJ[0][2].map((r, y) => (y === 0 ? r.slice(0, 13) + 'g' : r))));
		const f = R.reachField(L, { airJumps: true });
		check('a multijump level with another effect tile (low gravity): the walk as before', f.mode === 'walk' && !f.airJumps, f.mode);
	}
	// random rooms of every block kind with multijump tiles (0, 1, 2, 3, 1000 jumps): the self-check, and every state of the
	// small engine search that reached the trophy finite
	let seed = 29;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const ids = [9, 9, 9, 9, 4, 1, 2, 3, 361, 1052, 1041, 119, 369, 416, 120, 116, 117, 114, 1518];
	let bad = 0, n = 0, routed = 0, states = 0, cut = 0, first = null;
	for (let k = 0; k < (QUICK ? 6 : 16); k++) {
		const W = 12 + (k % 3) * 4, H = 9 + (k % 2) * 3, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			if ((x === 2 || x === 3) && y === H - 2) continue;
			const r = rnd();
			if (r < 0.06) cells.push([x, y, 461, [0, 1, 2, 3, 1000][Math.floor(rnd() * 5)]]);
			else if (r < 0.24) { const id = ids[Math.floor(rnd() * ids.length)]; cells.push(id === 1052 || id === 1041 ? [x, y, id, Math.floor(rnd() * 4)] : [x, y, id]); }
		}
		cells.push([3, H - 2, 461, 2], [Math.floor(W / 2) + (k % 3), 1 + (k % 3), 121], [2, H - 2, 255]);
		const L = levelOfCells(W, H, cells);
		const f = R.reachField(L, { airJumps: true, check: true });
		n++;
		if (f.mismatches || f.mode !== 'physics') { bad++; continue; }
		if (QUICK) continue;
		const tr = engineRoute(L, 400, 1200, true, 20);
		if (!tr.route) continue;
		routed++;
		const a = aheadCut(L, f, tr.ahead);
		states += a.n; cut += a.cut; if (a.first && !first) first = a.first;
	}
	check(`${n} random multijump rooms: physics with air jumps, 0 mismatches${QUICK ? '' : '; every state of the engine searches that reached the trophy finite'}`, bad === 0 && cut === 0,
		`${bad} rooms wrong; ${routed} routed, ${states} states, ${cut} cut off${first ? ` (first ${JSON.stringify(first)})` : ''}`);
}
function trapLevel() {
	const W = 80, H = 40, c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
	for (let y = 1; y < H - 1; y++) for (let x = 42; x < W - 1; x++) c.push([x, y, 4]);
	for (let y = 1; y < H - 1; y++) c.push([40, y, 361, 1]);
	for (let x = 68; x <= 72; x++) c.push([x, 6, 361, 1], [x, 10, 9]);
	for (let y = 7; y <= 9; y++) c.push([68, y, 361, 1], [72, y, 361, 1], [69, y, 0], [70, y, 0], [71, y, 0]);
	c.push([70, 9, 242, 0, 3, 4], [12, 38, 242, 0, 4, 3], [6, 38, 242, 0, 1, 2], [45, 38, 242, 0, 2, 1], [18, 38, 242, 0, 5, 7]);
	for (let x = 23; x <= 27; x++) c.push([x, 2, 9], [x, 6, 9]);
	for (let y = 3; y <= 5; y++) c.push([23, y, 9], [27, y, 9]);
	c.push([25, 5, 361, 1], [25, 3, 242, 0, 7, 99], [2, 38, 255], [30, 38, 360], [77, 5, 121], [77, 3, 420, 1], [78, 38, 453, 0]);
	return { W, H, cells: c };
}

// ---------------------------------------------------------------- P the plain-ball field (opts.plainFx, COMPILER DOCTOR 6)
// One effect tile anywhere made the whole field the gravity-blind walk. With plainFx (and goals) the field is the physics
// model for a PLAIN ball, the effect tiles that change a plain ball goals at their walk cost, and costAt(field, sim) of a
// ball with an effect on its walk: every state of an engine route finite (the plain part and the part after an effect).
function sectionP() {
	section('P the plain-ball field (plainFx): physics up to the first effect tile, sound along engine routes');
	const goalsOf = (L) => { const g = []; for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === 121) g.push({ tile: i, cost: 0 }); return g; };
	// (a) a plain room with ONE jump effect in a far corner: physics mode, the self-check, the cost at the start as the room
	// without the effect (the corner is farther than the trophy)
	const rows = box(['..........T', '.......####', '...........', '#####......', '...........', 'S........##']);
	const La = ascii(rows), Lfx = levelOfCells(La.width, La.height, [...(() => { const c = []; rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') c.push([x, y, ...ID[ch]]); })); return c; })(), [1, 1, 417, 1]]);
	const fw = R.reachField(Lfx, { goals: goalsOf(Lfx) }), fp = R.reachField(Lfx, { goals: goalsOf(Lfx), plainFx: true, check: true }), f0 = R.reachField(La, { goals: goalsOf(La) });
	const s0 = startSim(Lfx, 3), s1 = startSim(La, 3);
	check('an effect tile anywhere: walk mode without plainFx, physics with it', fw.mode === 'walk' && fp.mode === 'physics' && fp.plainFx === true && fp.fxSeeds === 1, `${fw.mode} / ${fp.mode} seeds ${fp.fxSeeds}`);
	check('the plain-ball field passes the self-check', fp.mismatches === 0, `${fp.mismatches}`);
	check('the start costs the same as the room without the effect tile (it is farther than the trophy)', R.costAt(fp, s0) === R.costAt(f0, s1), `${fmt(R.costAt(fp, s0))} vs ${fmt(R.costAt(f0, s1))}`);
	// (b) the trophy on a ledge only a jump effect reaches: the effect tile by the spawn; plainFx seeds it: finite at the
	// start, every state of the engine's route finite (after the pickup by the walk); the same room with the tile as air: cut
	const rowsB = box(['..T.......', '..###.....', '..........', '..........', '..........', 'S.J.......']);
	const cellsB = []; rowsB.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === 'J') cellsB.push([x, y, 417, 1]); else if (ch !== '.') cellsB.push([x, y, ...ID[ch]]); }));
	const Lb = levelOfCells(rowsB[0].length, rowsB.length, cellsB), Lb0 = levelOfCells(rowsB[0].length, rowsB.length, cellsB.filter((c) => c[2] !== 417));
	const route = engineRoute(Lb, 160, 3000), route0 = engineRoute(Lb0, 160, 3000);
	const fb = R.reachField(Lb, { goals: goalsOf(Lb), plainFx: true, check: true }), fb0 = R.reachField(Lb0, { goals: goalsOf(Lb0) });
	const wb = route ? walk(Lb, fb, route) : null;
	check('the high ledge: the engine routes it only with the jump effect', !!route && !route0, `${route ? route.length : 'none'} / ${route0 ? route0.length : 'none'}`);
	check('the plain-ball field: finite at the start, every state of the route finite (plain and after the pickup)', R.costAt(fb, startSim(Lb, 0)) >= 0 && wb && wb.cut === 0 && wb.finished, wb ? `${wb.n} states, ${wb.cut} cut${wb.first ? ' ' + JSON.stringify(wb.first) : ''}` : 'no route');
	check('without the effect tile the physics field cuts the start (the proof the seed keeps sound)', R.costAt(fb0, startSim(Lb0, 0)) < 0, fmt(R.costAt(fb0, startSim(Lb0, 0))));
	// (c) random rooms with effect tiles of every kind and number: every state from which a small engine search reached the
	// trophy finite in the plain-ball field (the search's states carry any effects they picked up)
	let seed = 23;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const FX = [[417, 0], [417, 1], [417, 2], [418, 1], [418, 0], [419, 1], [419, 2], [453, 1], [461, 2], [461, 3], [1517, 1], [1517, 2], [1517, 3]];
	const ids = [9, 9, 9, 4, 1, 2, 3, 361, 1052, 119, 116, 117, 114];
	let lv = 0, routed = 0, states = 0, cut = 0, bad = 0, physics = 0, firstBad = null;
	for (let k = 0; k < 24; k++) {
		const W = 14 + (k % 3) * 4, H = 10 + (k % 2) * 4, cells = [];
		for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
		for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			const r = rnd();
			if (r < 0.06) { const e = FX[Math.floor(rnd() * FX.length)]; cells.push([x, y, e[0], e[1]]); } else if (r < 0.24) { const id = ids[Math.floor(rnd() * ids.length)]; cells.push(id === 1052 ? [x, y, id, Math.floor(rnd() * 4)] : [x, y, id]); }
		}
		cells.push([Math.floor(W / 2), 2, 121], [2, H - 2, 255]);
		const L = levelOfCells(W, H, cells);
		lv++;
		const f = R.reachField(L, { goals: goalsOf(L), plainFx: true, check: true });
		if (f.mode === 'physics') physics++;
		if (f.mismatches) bad++;
		const tree = engineRoute(L, 120, 2500, true, 0);
		if (!tree.route) continue;
		routed++;
		const ac = aheadCut(L, f, tree.ahead), wr = walk(L, f, tree.route);
		states += ac.n + wr.n; cut += ac.cut + wr.cut;
		if ((ac.cut || wr.cut) && !firstBad) firstBad = { k, ahead: ac.first, route: wr.first };
	}
	check(`${lv} random rooms with effect tiles: physics mode (${physics}), the self-check`, physics > 0 && bad === 0, `${bad} with mismatches`);
	check(`their engine routes (${routed} rooms): every state from which the search reached the trophy finite`, routed > 0 && cut === 0, `${states} states, ${cut} cut${firstBad ? ' ' + JSON.stringify(firstBad) : ''}`);
}

(async () => {
	if (want('P')) sectionP();
	if (want('A')) sectionA();
	if (want('B')) sectionB();
	if (want('C')) sectionC();
	if (want('D')) sectionD();
	if (want('E')) sectionE();
	if (want('F')) sectionF();
	if (want('G')) await sectionG();
	if (want('H')) { sectionH(); silentPortalRooms(); storedCoinDeadEnds(); deferredTriggerDeadEnds(); roomDeadFuzz(); }
	if (want('I')) sectionI();
	if (want('J')) sectionJ();
	if (want('S')) sectionS();
	if (want('Q')) sectionQ();
	if (want('X')) sectionX();
	if (want('M')) sectionM();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
