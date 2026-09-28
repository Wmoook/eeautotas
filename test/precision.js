'use strict';
// precision.js (Find a route's precision stage, "exact landings"), CPU only, on levels built here (~1 min):
//   model    the lateral model (latTick: the speed update, the 1 px sub-steps, the auto-align) = the engine bit for bit
//            along random left / none / right walks on a long floor (several binades of doubles); from rest a pattern's
//            move is the same wherever it starts in one binade (the pieces add up exactly)
//   pocket   the user's puzzle (a trophy pocket under a spike whose right side is a half block, test.eelvl's shape) at
//            x 1976 px (the gap in [1024, 2048): a grid of 2^-42 px): the nudge test finds the one spot (x = 1976 exactly
//            reaches the trophy, 1976 +- 1/64 does not), the command line lands the ball there from a plain attempt
//            (fall, run left, coast) and finishes: replayed by C.evaluate, 0 deaths, the ball leaves the floor at
//            px == 1976.0 exactly; the reach field never says -1 along it (sound)
//   sealed   the same level with the half block a full block (no route: the drop needs the centre in the spike's
//            column): the stage names no spot and reports no route
// usage: node test/precision.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const RF = require('../src/reach.js');
const P = require('../src/precision.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-precision-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
function rngOf(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); }
const levelOf = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));

// the user's puzzle (test.eelvl, x 354-366, y 78-85): # solid, ^ spike (361), | half block (1116, rotation 0: its right
// half solid), T trophy, S spawn
const POCKET = [
	'..##########.',
	'..#^.....#S#.',
	'..#^.....#.#.',
	'.##^.......#.',
	'.#..|#######.',
	'.#..|#.#.....',
	'.#T.|#.......',
	'.#####.......',
];
function pocketLevel(W, H, ox, oy, half) {
	const c = room(W, H), inner = [];
	POCKET.forEach((row, j) => [...row].forEach((ch, i) => {
		const x = ox + i, y = oy + j;
		if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return;
		if (ch === '#') inner.push([x, y, 9]);
		else if (ch === '^') inner.push([x, y, 361, 1]);
		else if (ch === '|') inner.push(half === false ? [x, y, 9] : [x, y, 1116, 0]);
		else if (ch === 'T') inner.push([x, y, 121]);
		else if (ch === 'S') inner.push([x, y, 255]);
	}));
	const at = new Set(inner.map(([x, y]) => `${x},${y}`));
	return ED.eelvlOf({ name: 'pocket', width: W, height: H, cells: [...c.filter(([x, y]) => !at.has(`${x},${y}`)), ...inner] });
}

/** fall from the spawn, run left until 2 tiles right of the gap's x, then no input until at rest */
function plainAttempt(level) {
	const sim = new E.EESim(level), inp = new E.EEInput(), out = [];
	sim.reset();
	const step = (m) => { E.applyMask(inp, m); sim.tick(inp); out.push(m); };
	for (let t = 0; t < 60 && !(sim.on_ground && t > 5); t++) step(0);
	while (sim.px > X + 32 && out.length < 400) step(2);
	for (let t = 0; t < 200 && sim.speed_x !== 0; t++) step(0);
	return Uint8Array.from(out);
}
// ---------------------------------------------------------------- the lateral model
console.log('\n== model: the lateral model = the engine, bit for bit');
{
	const W = 620, H = 6, cells = room(W, H);
	cells.push([1, H - 2, 255]);
	const level = levelOf(ED.eelvlOf({ name: 'floor', width: W, height: H, cells }));
	const sim = new E.EESim(level), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < 40; t++) { E.applyMask(inp, 0); sim.tick(inp); }
	const floor = sim.snapshot();
	const rnd = rngOf(7);
	let ticks = 0, bad = 0, first = '';
	const LAT = [2, 0, 4];
	for (let w = 0; w < 400; w++) {
		// a start at rest anywhere between x 40 and 9600 (binades 2^5 .. 2^13), a random walk of held inputs
		const x0 = 40 + rnd() * 9560 + (rnd() < 0.3 ? 0 : rnd());
		sim.restore(floor);
		sim.px = x0; sim.prev_px = x0; sim._ox = x0; sim.speed_x = 0;
		const st = { px: x0, sx: 0 };
		let mx = 0, left = 0;
		for (let t = 0; t < 120; t++) {
			if (left-- <= 0) { mx = Math.floor(rnd() * 3) - 1; left = Math.floor(rnd() * 12); }
			E.applyMask(inp, LAT[mx + 1]);
			sim.tick(inp);
			P.latTick(st, mx, true);
			if (sim.px < 24 || sim.px > W * 16 - 40) break;   // (near a wall: not the model's case)
			ticks++;
			if (sim.px !== st.px || sim.speed_x !== st.sx) { bad++; if (!first) first = `walk ${w} tick ${t}: engine ${sim.px} ${sim.speed_x}, model ${st.px} ${st.sx}`; break; }
		}
	}
	check('random walks on a floor: the model\'s x and x speed equal the engine\'s after every tick', bad === 0 && ticks > 30000, `${ticks} ticks, ${bad} different${first ? `; ${first}` : ''}`);
	// from rest, a pattern's move (no auto-align) is the same at every start of one binade
	let same = 0, diff = 0;
	for (let k = 0; k < 300; k++) {
		const pat = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => Math.floor(rnd() * 3) - 1);
		if (pat.every((m) => m === 0)) continue;
		const moves = [];
		for (const x0 of [4096 + rnd() * 4000, 4096 + rnd() * 4000, 4096 + rnd() * 4000]) {
			const st = { px: x0, sx: 0 };
			for (const m of pat) P.latTick(st, m, false);
			while (st.sx !== 0) P.latTick(st, 0, false);
			moves.push(st.px - x0);
		}
		if (moves.every((d) => d === moves[0])) same++; else diff++;
	}
	check('from rest a pattern and its coast move the ball by the same exact amount anywhere in [4096, 8192)', diff === 0 && same > 200, `${same} the same, ${diff} different`);
}

// ---------------------------------------------------------------- the pocket
console.log('\n== pocket: the user\'s puzzle at x 1976 (a grid of 2^-42 px)');
const OX = 120, W = OX + 15, H = 12, OY = 2;
const X = (OX + 3.5) * 16;   // (the one x: 1976)
{
	const buf = pocketLevel(W, H, OX, OY, true);
	const level = levelOf(buf);
	const file = path.join(TMP, 'pocket.eelvl');
	fs.writeFileSync(file, buf);
	// a plain attempt: fall from the spawn, run left until 2 tiles from the gap, coast to rest on the half block
	const inp = new E.EEInput();
	const att = plainAttempt(level);
	const s1 = new E.EESim(level);
	s1.reset();
	let dead = false;
	for (const m of att) { E.applyMask(inp, m); s1.tick(inp); if (s1.is_dead) dead = true; }
	check('the attempt does not finish and does not die (it rests on the half block)', !C.evaluate(level, att) && !dead && s1.speed_x === 0 && s1.px > X, `px ${s1.px}`);
	const ctx = P.makeCtx(level);
	const st = P.stallStates(ctx, [att]);
	const nt = P.nudgeTest(ctx, st.stall, st.cmin, {});
	const tg = nt.targets[0];
	check('the nudge test: one spot, the ball at x = 1976 exactly reaches the trophy', nt.targets.length === 1 && tg.x === X && tg.finish && nt.routes.length === 0,
		nt.targets.map((q) => `x ${q.x} py ${q.py} ${q.finish ? 'finish' : `gain ${q.gain}`}`).join('; ') || 'none');
	// (the window is a point: 1/64 px either side does not get there)
	const near = [X - 1 / 64, X + 1 / 64].map((x) => { const n = P.nudged(ctx, st.stall[0].snap, x); return n ? P.localSearch(ctx, n, { nodes: 2500 }) : null; });
	check('... and 1/64 px either side of it does not (a window of zero width)', near.every((r) => !r || (!r.finish && r.cost > 1)), near.map((r) => (r ? `${r.finish ? 'finish' : r.cost.toFixed(1)}` : 'blocked')).join(', '));
	const attFile = path.join(TMP, 'att.txt');
	fs.writeFileSync(attFile, Array.from(att, (m) => String.fromCharCode(48 + m)).join('') + '\n');
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'precision.js'), file, `--attempts=${attFile}`, '--workers=2', '--seconds=90', '--after=1'], { encoding: 'utf8' });
	const evs = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
	const res = evs.filter((e) => e.ev === 'result'), done = evs.find((e) => e.ev === 'done');
	const route = res.length ? Uint8Array.from(res[res.length - 1].inputs, (c) => (c.charCodeAt(0) - 48) & 31) : null;
	const ev = route ? C.evaluate(level, route) : null;
	check('the command line: a route from the plain attempt, replayed by C.evaluate, 0 deaths', !!ev && ev.deaths === 0 && ev.runTicks === res[res.length - 1].runTicks,
		`${ev ? `${C.fmt(ev.runTicks)} (${route.length} ticks)` : 'none'} after ${((Date.now() - t0) / 1000).toFixed(1)} s; done ${JSON.stringify(done)}${r.status ? `; exit ${r.status}: ${(r.stderr || '').slice(-300)}` : ''}`);
	if (route) {
		// the tick the ball leaves the corridor's floor at the pocket: px exactly X; the reach field never -1 along it
		const field = RF.reachField(level);
		const s = new E.EESim(level);
		s.reset();
		let leave = null, cut = -1, done2 = false;
		s.onEvent = (k) => { if (k === 'complete') done2 = true; };
		for (let k = 0; k < route.length && !done2; k++) {
			const py0 = s.py;
			E.applyMask(inp, route[k]); s.tick(inp);
			if (!leave && py0 === (OY + 3) * 16 && s.py > py0 && s.px <= X + 16) leave = { t: k + 1, px: s.px };
			if (!done2 && cut < 0 && RF.costAt(field, s) < 0) cut = k + 1;
		}
		check('the ball drops into the pocket at px == 1976.0 exactly', !!leave && leave.px === X, leave ? `t${leave.t}: px ${leave.px}` : 'no drop seen');
		check('the reach field (a proof where it says -1) allows every state of the route', cut < 0, cut < 0 ? `start cost ${RF.costAt(field, (() => { const q = new E.EESim(level); q.reset(); return q; })()).toFixed(1)} tiles` : `cut at t${cut}`);
	}
}

// ---------------------------------------------------------------- sealed: no route
console.log('\n== sealed: the half block a full block (no route)');
{
	const buf = pocketLevel(W, H, OX, OY, false);
	const file = path.join(TMP, 'sealed.eelvl');
	fs.writeFileSync(file, buf);
	const level = levelOf(buf);
	const att = Array.from(plainAttempt(level));
	const attFile = path.join(TMP, 'att2.txt');
	fs.writeFileSync(attFile, att.map((m) => String.fromCharCode(48 + m)).join('') + '\n');
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'precision.js'), file, `--attempts=${attFile}`, '--workers=2', '--seconds=30'], { encoding: 'utf8' });
	const evs = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
	const done = evs.find((e) => e.ev === 'done');
	check('no spot, no route, a quick end', !!done && done.targets === 0 && !evs.some((e) => e.ev === 'result') && done.sec < 20, JSON.stringify(done));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
