'use strict';
// test/prove.js - the proof of Find a route (native/prove.h, `eegpu prove`: CPU only, it never loads the GPU driver):
//   check    the transfer against the engine: random boxes (px inside one pixel, a vx interval, exact py / vy) near walls,
//            floors, ceilings, corners and ledge edges of user50, the shaft level, test/reach.js's rooms and random rooms;
//            every sample state in a box gets one engine tick (eesim.js) with the case's input, and its successor must lie
//            in one of the tool's abstract successors (position, speed, exact vy, the run-up bounds); the run-up
//            distance's property D(F(v)) <= D(v) + F(v) for every input
//   rooms    rooms with known answers: none with a route is called impossible (a soundness bug); those the model is known
//            to prove are proven (precision): test/reach.js's rooms, run-up gaps at the shortest run-up that clears them
//            and one tile shorter, user50 (the user's 50x50 level: a 263-tick route) and its variants (the left run-up
//            1-4 tiles shorter, the upper room's entry narrowed), the shaft level, "jump too high"
//   contain  known routes lie in the fixpoint tick by tick (--noStop --states): user50's 263 ticks, the shaft level's 251,
//            the gap rooms' jumps; also with the reach field's cut-off (a route's states can all reach the trophy)
//   random   random rooms the reach field does not rule out: the verdict against a concrete search (breadth-first over the
//            6 inputs, then sticky random walks); "impossible" with a route found, or a route state outside the fixpoint,
//            is a soundness bug
//   reach    --reach (the reach field's cut-off): never impossible where the plain run finds the trophy on a room with a
//            route, the same proofs on the rooms, fewer boxes; user50's variants several times faster
//   scope    unsupported levels are refused with the reason (dots, arrows, ice, world gravity, a start inside a block, no
//            trophy, an effect block); the done line's fields
//   mutants  (--mutants: builds 6 broken copies of the tool with tools/.cache's zig, about a minute each, one at a time)
//            every deliberately broken transfer but one must fail "check"
// usage: node test/prove.js [--only=check,rooms,contain,random,reach,scope] [--cases=12000] [--rooms=10] [--seed=1]
//        [--mutants] [--tool=<eegpu.exe>]     Exit code 1 if any check fails. Writes nothing inside the repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const G = require('../src/gpu.js');
const RF = require('../src/reach.js');
const ED = require('../src/editor.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
const NCASES = +arg('cases', 12000), NROOMS = +arg('rooms', 10);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-prove-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
let TOOL = arg('tool', '') || G.nativeTool();

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
function rngOf(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const hex = (d) => { const b = Buffer.alloc(8); b.writeDoubleLE(d, 0); return b.toString('hex'); };

// ---------------------------------------------------------------- levels
const ID = { '#': [9], S: [255], T: [121], o: [4], '<': [1], I: [1064], J: [417] };
function levelOfBuf(buf) { return E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))); }
function ascii(rows, extra) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; const v = ID[ch]; if (!v) throw new Error(`legend ${ch}`); cells.push([x, y, ...v]); }));
	return levelOfBuf(ED.eelvlOf(Object.assign({ name: 't', width: rows[0].length, height: rows.length, cells }, extra || {})));
}
const box = (inner) => ['#'.repeat(inner[0].length + 2), ...inner.map((r) => `#${r}#`), '#'.repeat(inner[0].length + 2)];
// test/reach.js's rooms of solids, air, the spawn and the trophy: [name, expected ('yes' a route, 'no' none, '?' unknown), rows]
const REACH_ROOMS = [
	['ledge3', 'yes', ['..............', '..............', '..............', '..............', '.........T....', '........######', '........######', '..S.....######']],
	['ledge4', 'no', ['..............', '..............', '..............', '.........T....', '........######', '........######', '........######', '..S.....######']],
	['shaftjump', 'no', ['#####.....#####', '#####...T.#####', '#####...#######', '#####...#######', '#####...#######', '#####...#######', '#####.S.#######']],
	['pocket', '?', ['#####.....#####', '#####...T.#####', '#####...#######', '####....#######', '#####...#######', '#####...#######', '#####.S.#######']],
	['slot', 'yes', ['................', '................', '.......#########', '..............T.', '......##########', '.....###########', '....############', '.S.#############']],
	['slothi', '?', ['................', '.......#########', '..............T.', '.......#########', '......##########', '.....###########', '....############', '.S.#############']],
	['diag', 'no', ['..............', '..............', '.......#######', '.......#....T#', '.......#.....#', '......########', '..S...........']],
	['jump3', 'yes', ['......', '......', '....T.', '.#####', '......', 'S.....']],
	['jump4', 'no', ['......', '....T.', '.#####', '......', '......', 'S.....']],
	['float3', 'yes', ['......', '......', '......', '......', '..T...', '......', '......', '..S...']],
	['float4', 'yes', ['......', '......', '......', '..T...', '......', '......', '......', '..S...']],
	['float5', 'no', ['......', '......', '..T...', '......', '......', '......', '......', '..S...']],
];
/** a run-up platform of L tiles, a pit G tiles wide and 6 deep (no way out), the trophy on the far platform; a ceiling
 *  C tiles above the platforms (0: none) */
function gapRows(L, Gw, C) {
	const W = L + Gw + 6, F = 8, rows = [];
	for (let y = 0; y < F + 8; y++) {
		let s = '';
		for (let x = 0; x < W; x++) {
			const border = x === 0 || x === W - 1 || y === 0 || y === F + 7, inGap = x >= L + 1 && x <= L + Gw;
			s += border || (y >= F && !inGap) || (C && y === F - 1 - C) ? '#' : '.';
		}
		rows.push(s);
	}
	const put = (x, y, ch) => { rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1); };
	put(1, F - 1, 'S');
	put(L + Gw + 2, F - 1, 'T');
	return rows;
}
// [G, C, L*, j]: the shortest run-up L* that clears the gap (hold right, jump at tick j, hold right: a route; found by a
// concrete search of every jump tick and pause), the room at L* - 1 has no route of that kind ('no?')
const GAPS = [[6, 0, 1, 0], [8, 0, 1, 6], [10, 0, 1, 13], [12, 0, 3, 27], [4, 2, 3, 29], [5, 2, 8, 51], [6, 2, 15, 75], [5, 3, 2, 21], [6, 3, 3, 29],
	[7, 3, 6, 43], [8, 3, 11, 62], [6, 4, 1, 12], [7, 4, 2, 20], [8, 4, 3, 27], [9, 4, 4, 34]];
const gapRoute = (j, n) => Array.from({ length: n }, (_, t) => (t === j ? 5 : 4));
// the user's 50x50 level (test/editor.js USER50; a 263-tick route through a one-tile pocket) and its route
const USER50 = 'xZTZTsJAFIY/wA3FBcUNxRYo++4LeGG8MPEBjHdGS2KCkJio8c431/yVQqc1xMSI82XaOefMxXxnmpIYjp5JX1zb50/uq31559pX7os7AE41z97hA2PESD3e3rv2qN8fPAxdIPlViN941TgJFlhkiWVWSLLKGinW2WCTLdJss0OGXfbY54BDshxxTI4TLGzyFCjiUKJMhSo16jRo0qJNhy49+Lc5PZsindVfmW/LWPn7c1iTtensZ2d1JrgnG4qsmXEGy4ii9d9n5nDr3tf19yPmuchGPjKSk6zkJTO5yU5+MpSjLOUpU7nKVr4ylrOs5S1zucte/uqAeqAuBLEn5McUxhQnOAFKAcrfUvkBVYNaiHqIhkEzQitCO0InQjdCbw7A2/j+4zjes8j0x+fnGp8=';
const USER50_ROUTE = '323232223222232544442222022022222222222222222222223223223004002222222222222222232322232322222222222220000440440444444444444444444544444444444444444444444444454454545444444444444545445402222222222222222222222222222245444454544541042044444444444244444444404444000000';
// the 40x25 shaft level and its 251-tick route
const SHAFT = 'rZFrTgIxFEYPoLxmeM0ABUUZ5LkLVuAiSCyJyfgIP0jmnwtxr5o7wNDWqCGZnrS5t1/SnrSU3+NNondUH5Mo1nsdAytguP7AHQX8l82Tjt622/j5VQO1Y/CZpkVKXHFNmQpVatTx8GnQpEWbDgEhXXr0UQwYcsMtI+64Z0zEhAemzJizYAn/TvOEQy8n2ZXcc8pVVh1szOzkaRqes8Cq1a+djzJqN7ukz/kt0//JdxRSR7EUTzEVV7EVXzG2qWd4Gb5BI6P5g9YftA06FoFFaNB16Dn0HZTDIGcgOb5qkVG6esCXsxd+Aw==';
const SHAFT_ROUTE = '22222232323232250444242222022222222222222222222222323232324040202222222222222222222232232222222222222200444404444444444444444444454444444444444444444444444444544544544444444444544454540222222222222222222222222222224545454454444544444444444444444444400';
// "jump too high": the trophy on a ledge above any jump
const JTH = 'lY1LDoJAEETfMIAwoqJ4AG/CWUgYEhP8xLCBlTfXdIf4YQVd6Vp0dV4R39uq9w9MBxwBVz6ZjiG7VLU/3ZqmPV89kI7JoGmAJSQiZkVCimNNxoYtO3L2HCjgb79f06RYQByYO0aZQhXuryJtkR5pkq55gn5kBzh1C7w+N6uevAE=';
const masksOf = (s) => Uint8Array.from(s, (c) => (c.charCodeAt(0) - 48) & 31);
/** user50 with the left run-up s tiles shorter (the wall and the ledge at (20, 43) moved right), or the upper room's
 *  entry narrowed ('entry34': (33, 38) solid) */
function user50Variant(name) {
	const lv = ED.levelOf(Buffer.from(USER50, 'base64'));
	const W = lv.width;
	const cells = new Map(lv.cells.map((c) => [c[1] * W + c[0], c]));
	const set = (x, y) => cells.set(y * W + x, [x, y, 9]);
	const m = /^shift(\d)$/.exec(name);
	if (m) for (let k = 0; k < +m[1]; k++) { for (let y = 40; y <= 42; y++) set(20 + k, y); for (let y = 43; y <= 48; y++) set(21 + k, y); }
	if (name === 'entry34') set(33, 38);
	return levelOfBuf(ED.eelvlOf(Object.assign({}, lv, { cells: [...cells.values()] })));
}

// ---------------------------------------------------------------- the tool
let fileN = 0;
function blobFile(level) { const f = path.join(TMP, `l${fileN++}.bin`); fs.writeFileSync(f, G.levelBlob(level)); return f; }
function reachFile(level) {
	const f = path.join(TMP, `r${fileN++}.reach`);
	const field = RF.reachField(level);
	fs.writeFileSync(f, RF.reachFileBytes(field));
	const sim = new E.EESim(level); sim.reset();
	return { file: f, startCost: RF.costAt(field, sim), mode: field.mode };
}
/** eegpu prove on a level: {done, route, check, warning, lines} */
function prove(level, args, tool) {
	const bin = blobFile(level);
	let out;
	try { out = execFileSync(tool || TOOL, ['prove', bin, ...(args || [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch (e) { out = String(e.stdout || ''); }
	const lines = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
	return { done: lines.find((j) => j.ev === 'done') || null, route: lines.find((j) => j.ev === 'route') || null, check: lines.find((j) => j.ev === 'check') || null,
		warning: lines.find((j) => j.ev === 'warning') || null, lines };
}
/** the states of a route (px py vx vy, hex), the start first, until the trophy is taken */
function statesFile(level, masks) {
	const sim = new E.EESim(level); sim.reset();
	const inp = new E.EEInput();
	const out = [[sim.px, sim.py, sim.speed_x, sim.speed_y]];
	let finished = false;
	for (const m of masks) {
		E.applyMask(inp, m); sim.tick(inp);
		if (sim.has_silver_crown) { finished = true; break; }
		out.push([sim.px, sim.py, sim.speed_x, sim.speed_y]);
	}
	const f = path.join(TMP, `s${fileN++}.txt`);
	fs.writeFileSync(f, out.map((s) => s.map(hex).join(' ')).join('\n') + '\n');
	return { file: f, n: out.length, finished };
}
const brief = (d) => (d ? `${d.verdict} (${d.end}) ${d.sec}s, ${d.cells} boxes${d.pruned ? `, ${d.pruned} pruned` : ''}` : 'no done line');

// ---------------------------------------------------------------- check: the transfer against the engine
const JUMPV = ((0 - 2) * 26.0 * 1.0) / 7.752;
const G1 = (vy) => (vy + 2 / 7.752) * 0.98132;
const ORBIT = [0];
{ let v = 0; for (let i = 0; i < 60; i++) { v = (v + 2 / 7.752) * 0.98132; ORBIT.push(v); } v = JUMPV; for (let i = 0; i < 60; i++) { ORBIT.push(v); v = (v + 2 / 7.752) * 0.98132; } }
function randomRoomRows(rnd, k) {
	const W = 12 + (k % 3) * 4, H = 10 + (k % 2) * 4, rows = [];
	for (let y = 0; y < H; y++) {
		let s = '';
		for (let x = 0; x < W; x++) s += (x === 0 || y === 0 || x === W - 1 || y === H - 1 || rnd() < 0.28) ? '#' : '.';
		rows.push(s);
	}
	rows[H - 2] = rows[H - 2].slice(0, 1) + 'S' + rows[H - 2].slice(2);
	rows[1] = rows[1].slice(0, 5) + 'T' + rows[1].slice(6);
	return rows;
}
/** random boxes and engine samples in them (the case file of eegpu prove --check) */
function genCases(level, n, rnd) {
	const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const sim = new E.EESim(level); sim.reset();
	const base = sim.snapshot();
	const inp = new E.EEInput();
	const W = level.width, H = level.height;
	const solid = (x, y) => x < 0 || y < 0 || x >= W || y >= H || level.ovl[y * W + x] === 1;
	const near = [], air = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (solid(x, y)) continue;
		air.push([x, y]);
		let s = false;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (solid(x + dx, y + dy)) s = true;
		if (s) near.push([x, y]);
	}
	// ledge edges (floor below, none beside), ceiling corners, wall corners: [x, y, direction, kind]
	const edges = [];
	for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
		if (solid(x, y)) continue;
		for (const d of [-1, 1]) {
			if (solid(x + d, y)) continue;
			if (solid(x, y + 1) && !solid(x + d, y + 1)) edges.push([x, y, d, 'floor']);
			if (solid(x, y - 1) && !solid(x + d, y - 1)) edges.push([x, y, d, 'ceiling']);
		}
		for (const d of [-1, 1]) {
			if (!solid(x + d, y)) continue;
			if (!solid(x + d, y - 1) && !solid(x, y - 1)) edges.push([x, y, d, 'wallTop']);
			if (!solid(x + d, y + 1) && !solid(x, y + 1)) edges.push([x, y, d, 'wallBottom']);
		}
	}
	const out = [];
	let made = 0, tries = 0;
	while (made < n && tries < n * 20) {
		tries++;
		const [tx, ty] = rnd() < 0.85 && near.length ? pick(near) : pick(air);
		let py;
		const ym = rnd();
		if (ym < 0.35) py = ty * 16 + pick([0, 0, 0, -16, 16]);
		else if (ym < 0.55) py = ty * 16 + ri(-15, 15);
		else if (ym < 0.7) py = ty * 16 + pick([0.25343, 0.2534294, -0.5, 0.75]) + ri(-1, 1) * 16;
		else py = ty * 16 + (rnd() * 24 - 12);
		const q = Math.floor(py);
		let ya, yb;
		const yw = rnd();
		if (yw < 0.5) ya = yb = py;
		else if (yw < 0.7) { ya = q; yb = q + rnd() * 0.999; }
		else { const a = rnd(), b = rnd(); ya = q + Math.min(a, b) * 0.999; yb = q + Math.max(a, b) * 0.999; }
		const vm = rnd();
		let vy;
		if (vm < 0.3) vy = 0;
		else if (vm < 0.45) vy = JUMPV;
		else if (vm < 0.8) vy = pick(ORBIT);
		else vy = rnd() * 17 - 7;
		const k = tx * 16 + ri(-16, 16);
		let pa, pb;
		const pm = rnd();
		if (pm < 0.25) { pa = pb = k; }
		else if (pm < 0.45) { pa = k; pb = k + rnd() * 0.999; }
		else if (pm < 0.65) { pa = pb = k + rnd(); if (pa >= k + 1) pa = pb = k; }
		else { const a = rnd(), b = rnd(); pa = k + Math.min(a, b) * 0.999; pb = k + Math.max(a, b) * 0.999; }
		let vc;
		const cm = rnd();
		if (cm < 0.1) vc = 0;
		else if (cm < 0.35) vc = rnd() * 2.4 - 1.2;
		else if (cm < 0.45) vc = pick([1, -1, 0.0001, -0.0001, 0.12661, -0.12661]) + (rnd() - 0.5) * 0.01;
		else vc = rnd() * 14 - 7;
		const wm = rnd();
		const vw = wm < 0.3 ? 0 : wm < 0.55 ? rnd() / 16 : wm < 0.75 ? rnd() * 0.3 : rnd() * 1.0;   // cells hold up to 1 px/tick
		let va = vc - vw / 2, vb = vc + vw / 2;
		let h = ri(-1, 1);
		const j = rnd() < 0.5 ? 1 : 0;
		if (edges.length && rnd() < 0.35) {
			// a ledge edge (standing, moving off it) or a corner (rising / falling past it): the first y step collides and a
			// retry later in the tick succeeds once x has moved past the corner
			const [ex, ey, d, kind] = pick(edges);
			let k2 = ex * 16 + (d > 0 ? ri(0, 15) : -ri(0, 15));
			if (kind === 'wallTop' || kind === 'wallBottom') k2 = ex * 16 - (d > 0 ? ri(0, 3) : -ri(0, 3));
			const fr = rnd() < 0.4 ? 0 : rnd() * 0.999;
			pa = pb = k2 + fr;
			if (rnd() < 0.4) { pa = k2; pb = k2 + 0.999 * rnd(); }
			const sp = d * (0.3 + rnd() * 6);
			va = sp - 0.01 * rnd(); vb = va + (rnd() < 0.5 ? 0 : 0.03 * rnd());
			h = rnd() < 0.7 ? d : ri(-1, 1);
			ya = yb = ey * 16;
			vy = kind === 'floor' ? pick([0, 0, 0, ORBIT[1], ORBIT[3]]) : pick([JUMPV, ORBIT[62], ORBIT[64], ORBIT[70]]);
			if (kind === 'wallTop') { vy = pick([JUMPV, ORBIT[62], ORBIT[64], ORBIT[66], ORBIT[70]]); ya = yb = ey * 16 - 16 + rnd() * Math.abs(G1(vy)); }
			if (kind === 'wallBottom') { vy = pick([ORBIT[5], ORBIT[10], ORBIT[15], ORBIT[20], ORBIT[30]]); ya = yb = ey * 16 + 16 - rnd() * G1(vy); }
		}
		const mask = (j ? 1 : 0) | (h < 0 ? 2 : 0) | (h > 0 ? 4 : 0);
		const samples = [];
		const pts = [[pa, va], [pa, vb], [pb, va], [pb, vb]];
		for (let i = 0; i < 26; i++) pts.push([pa + (pb - pa) * rnd(), va + (vb - va) * rnd()]);
		if (rnd() < 0.3) {
			const ulp = (x, u) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); let w = b.readBigInt64LE(); w += BigInt(u); b.writeBigInt64LE(w); return b.readDoubleLE(0); };
			for (let i = 0; i < 6; i++) { const b16 = Math.round((pa + pb) / 2 / 16) * 16; const x = ulp(pick([b16, Math.floor(pa), b16 + 16]), ri(-3, 3)); if (x >= pa && x <= pb) pts.push([x, va + (vb - va) * rnd()]); }
		}
		for (const pt of pts) {
			const [px, vx] = pt;
			const ppy = pt === pts[0] ? ya : pt === pts[3] ? yb : ya + (yb - ya) * rnd();
			if (px < 0 || ppy < 0 || px > sim._maxX || ppy > sim._maxY) continue;
			sim.restore(base);
			sim.px = px; sim.py = ppy; sim.speed_x = vx; sim.speed_y = vy;
			if (sim._ovAt(px, ppy) !== 0) continue;   // not a state the engine can be in
			E.applyMask(inp, mask); sim.tick(inp);
			samples.push([px, ppy, vx, vy, sim.px, sim.py, sim.speed_x, sim.speed_y]);
		}
		if (!samples.length) continue;
		out.push(`C ${[pa, pb, ya, yb, va, vb, vy].map(hex).join(' ')} ${h} ${j} ${samples.length}`);
		for (const s of samples) out.push(`S ${s.map(hex).join(' ')}`);
		made++;
	}
	return out;
}
/** the check over the fuzz levels with `tool`: the summed counts */
function fuzz(tool, ncases, seed) {
	const rnd = rngOf(seed);
	const levels = [['user50', levelOfBuf(Buffer.from(USER50, 'base64'))], ['shaft', levelOfBuf(Buffer.from(SHAFT, 'base64'))],
		...REACH_ROOMS.map(([name, , rows]) => [name, ascii(box(rows))])];
	for (let k = 0; k < 6; k++) levels.push([`random${k}`, ascii(randomRoomRows(rnd, k))]);
	const total = { cases: 0, samples: 0, missed: 0, oBoundViolations: 0, dPropertyViolations: 0 }, per = [];
	const n = Math.ceil(ncases / levels.length);
	for (const [name, level] of levels) {
		const cf = path.join(TMP, `c${fileN++}.txt`);
		fs.writeFileSync(cf, genCases(level, n, rnd).join('\n') + '\n');
		const r = prove(level, [`--check=${cf}`], tool);
		if (!r.check) { per.push(`${name}: ${r.done ? r.done.verdict + ' ' + (r.done.why || '') : 'no answer'}`); total.missed++; continue; }
		for (const k of Object.keys(total)) total[k] += r.check[k];
		if (r.check.missed || r.check.oBoundViolations || r.check.dPropertyViolations) per.push(`${name}: ${JSON.stringify(r.check)}`);
	}
	return { total, per };
}
function checkSection() {
	section('check: the transfer against the engine (random boxes near walls, floors, ceilings, corners; one engine tick per sample)');
	const t0 = Date.now();
	const { total, per } = fuzz(TOOL, NCASES, +arg('seed', 1));
	check(`${total.cases} boxes, ${total.samples} engine samples: every successor inside the tool's abstract successors, the run-up bounds hold`,
		total.cases >= NCASES * 0.9 && total.samples > total.cases * 10 && !total.missed && !total.oBoundViolations && !total.dPropertyViolations,
		`${JSON.stringify(total)} in ${((Date.now() - t0) / 1000).toFixed(1)} s${per.length ? `; ${per.join('; ')}` : ''}`);
}

// ---------------------------------------------------------------- rooms with known answers
function roomsSection() {
	section('rooms with known answers: no room with a route called impossible; the known proofs found');
	const rows = [];
	const run = (name, level, expected, route) => {
		const r = prove(level, ['--seconds=120']);
		const d = r.done;
		rows.push({ name, expected, d });
		if (expected === 'yes') check(`${name}: a route exists, not called impossible`, d && d.verdict !== 'impossible' && d.verdict !== 'unsupported', brief(d));
		else if (expected === 'proof') check(`${name}: proven impossible`, d && d.verdict === 'impossible', brief(d));
		else console.log(`  info ${name}: ${brief(d)}`);
		if (route) {
			const ev = require('../src/common.js').evaluate(level, route);
			if (!ev) check(`${name}: its route finishes in the JS engine`, false);
		}
		return d;
	};
	for (const [name, exp, rws] of REACH_ROOMS) run(name, ascii(box(rws)), exp === 'no' ? 'proof' : exp);
	for (const [Gw, C, L, j] of GAPS) {
		run(`gap G${Gw} C${C} L${L}`, ascii(gapRows(L, Gw, C)), 'yes', gapRoute(j, 400));
		// one tile shorter: no route of the simple kind; the model proves one of them (G6 C3: the run-up decides)
		if (L > 1) run(`gap G${Gw} C${C} L${L - 1}`, ascii(gapRows(L - 1, Gw, C)), Gw === 6 && C === 3 ? 'proof' : '?');
	}
	const u = run('user50 (a 263-tick route)', levelOfBuf(Buffer.from(USER50, 'base64')), 'yes', masksOf(USER50_ROUTE));
	check('user50: the model reaches the trophy (not impossible, not a limit)', u && u.verdict === 'reached', brief(u));
	run('user50, left run-up 1 tile shorter', user50Variant('shift1'), '?');
	for (const v of ['shift2', 'shift3', 'shift4']) run(`user50, left run-up ${v.slice(5)} tiles shorter`, user50Variant(v), 'proof');
	run('user50, the upper room\'s entry narrowed', user50Variant('entry34'), 'proof');
	run('the shaft level (a 251-tick route)', levelOfBuf(Buffer.from(SHAFT, 'base64')), 'yes', masksOf(SHAFT_ROUTE));
	run('jump too high', levelOfBuf(Buffer.from(JTH, 'base64')), 'proof');
	// the explanation of user50 two tiles shorter: what the editor says
	const d2 = rows.find((r) => r.name === 'user50, left run-up 2 tiles shorter').d;
	const ex = d2 && d2.explain;
	check('user50 two tiles shorter, the explanation: top at y = 624, nearest tile (35, 39) 4.12 tiles from the trophy (36, 35), 4.26 px/tick right at most',
		ex && ex.topY === 624 && ex.nearest.join() === '35,39' && Math.abs(ex.nearestDist - 4.1231) < 1e-3 && ex.trophy.join() === '36,35' && Math.abs(ex.maxVxRight - 4.2553) < 1e-3 &&
		ex.start.join() === '36,43', JSON.stringify(ex));
}

// ---------------------------------------------------------------- known routes inside the fixpoint
function containSection() {
	section('contain: known routes lie in the fixpoint tick by tick (--noStop --states); also with the reach field\'s cut-off');
	const cases = [['user50', levelOfBuf(Buffer.from(USER50, 'base64')), masksOf(USER50_ROUTE)], ['shaft', levelOfBuf(Buffer.from(SHAFT, 'base64')), masksOf(SHAFT_ROUTE)]];
	for (const [Gw, C, L, j] of GAPS) cases.push([`gap G${Gw} C${C} L${L}`, ascii(gapRows(L, Gw, C)), gapRoute(j, 400)]);
	let all = 0, bad = [], limits = [];
	for (const reach of [false, true]) {
		for (const [name, level, masks] of cases) {
			const st = statesFile(level, masks);
			if (!st.finished) { bad.push(`${name}: its route does not finish`); continue; }
			const args = ['--noStop', `--states=${st.file}`, '--seconds=180'];
			if (reach) args.push(`--reach=${reachFile(level).file}`);
			const r = prove(level, args);
			all++;
			if (!r.route || !r.done) bad.push(`${name}${reach ? ' (reach)' : ''}: no answer`);
			else if (r.done.end === 'time' || r.done.end === 'cells') limits.push(`${name}${reach ? ' (reach)' : ''}: ${r.route.missing} of ${r.route.states} outside so far`);
			else if (r.route.missing) bad.push(`${name}${reach ? ' (reach)' : ''}: ${r.route.missing} of ${r.route.states} states outside (the first at tick ${r.route.firstMissing})`);
		}
	}
	check(`${cases.length} routes, plain and with the reach field's cut-off: every state inside the full fixpoint`, !bad.length && !limits.length,
		`${all} runs${bad.length ? `; ${bad.join('; ')}` : ''}${limits.length ? `; limits: ${limits.join('; ')}` : ''}`);
}

// ---------------------------------------------------------------- random rooms against a concrete search
/** the concrete engine tries to reach the trophy: breadth-first over the 6 inputs (states merged in 1/4 px, 1/32 px/tick
 *  cells), then sticky random walks, for about `seconds` */
function concrete(level, seconds) {
	const t0 = Date.now();
	const sim = new E.EESim(level); sim.reset();
	const base = sim.snapshot(); const inp = new E.EEInput();
	const MASKS = [0, 1, 2, 3, 4, 5];
	const key = () => `${Math.round(sim.px * 4)},${Math.round(sim.py * 4)},${Math.round(sim.speed_x * 32)},${Math.round(sim.speed_y * 32)}`;
	const par = [-1], msk = [-1];
	const pathTo = (i, m) => { const o = [m]; for (; i > 0; i = par[i]) o.push(msk[i]); return o.reverse(); };
	let layer = [[base, 0]], states = 1, found = null;
	const seen = new Set([key()]);
	while (layer.length && Date.now() - t0 < seconds * 500 && !found && states < 2e6) {
		const next = [];
		for (const [s, si] of layer) {
			for (const m of MASKS) {
				sim.restore(s); E.applyMask(inp, m); sim.tick(inp);
				if (sim.has_silver_crown) { found = pathTo(si, m); break; }
				const k = key();
				if (seen.has(k)) continue;
				seen.add(k); par.push(si); msk.push(m); next.push([sim.snapshot(), par.length - 1]); states++;
			}
			if (found) break;
		}
		layer = next;
	}
	const exhausted = !found && layer.length === 0 && states < 2e6;
	let seed = 12345;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	while (!found && !exhausted && Date.now() - t0 < seconds * 1000) {
		sim.restore(base);
		let m = MASKS[Math.floor(rnd() * 6)];
		const ms = [];
		for (let i = 0; i < 600; i++) {
			if (rnd() < 0.1) m = MASKS[Math.floor(rnd() * 6)];
			ms.push(m);
			E.applyMask(inp, m); sim.tick(inp);
			if (sim.has_silver_crown) { found = ms; break; }
		}
	}
	return { found, states, exhausted };
}
function randomSection() {
	section(`random: ${NROOMS} random rooms (every other one hard; those the reach field rules out only among the hard ones), the verdict against a concrete search, ` +
		'found routes inside the fixpoint');
	const rnd = rngOf(+arg('seed', 1) * 7919);
	const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
	let rooms = 0, proven = 0, routes = 0, contained = 0, limits = 0, tries = 0, exhausted = 0, cut = 0;
	const bad = [];
	while (rooms < NROOMS && tries++ < NROOMS * 50) {
		// every other room "hard": more obstacles, the trophy on a floor in the upper half (more rooms without a route)
		const hard = rooms % 2 === 1;
		const W = ri(12, 22), H = ri(9, 14);
		const g = [];
		for (let y = 0; y < H; y++) g.push(Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.')));
		for (let i = 0, n = hard ? ri(8, 16) : ri(3, 9); i < n; i++) {
			const kind = rnd();
			if (kind < 0.45) { const y = ri(2, H - 2), x = ri(1, W - 3), w = ri(1, 6); for (let k = 0; k < w && x + k < W - 1; k++) g[y][x + k] = '#'; }
			else if (kind < 0.8) { const x = ri(1, W - 2), y = ri(2, H - 2), h = ri(1, 5); for (let k = 0; k < h && y + k < H - 1; k++) g[y + k][x] = '#'; }
			else { const x = ri(1, W - 3), y = ri(1, H - 3); g[y][x] = '#'; g[y][x + 1] = '#'; g[y + 1][x] = '#'; }
		}
		const free = [];
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (g[y][x] === '.') free.push([x, y]);
		const floors = free.filter(([x, y]) => g[y + 1][x] === '#');
		if (!floors.length || free.length < 4) continue;
		const [sx, sy] = floors[Math.floor(rnd() * floors.length)];
		g[sy][sx] = 'S';
		const cand = free.filter(([x, y]) => g[y][x] === '.' && Math.abs(x - sx) + Math.abs(y - sy) >= 4 && (!hard || (y < H / 2 && g[y + 1][x] === '#')));
		if (!cand.length) continue;
		const [tx, ty] = cand[Math.floor(rnd() * cand.length)];
		g[ty][tx] = 'T';
		const rows = g.map((r) => r.join(''));
		const level = ascii(rows);
		const rf = reachFile(level);
		// (rooms the reach field rules out: only hard ones, for the plain proofs' sake; the cut-off runs where the field finds a way)
		if (rf.startCost < 0 && !hard) continue;
		rooms++;
		if (rf.startCost < 0) cut++;
		const plain = prove(level, ['--seconds=60']).done, withReach = rf.startCost >= 0 ? prove(level, ['--seconds=60', `--reach=${rf.file}`]).done : null;
		const imp = (plain && plain.verdict === 'impossible') || (withReach && withReach.verdict === 'impossible');
		if (imp) proven++;
		const cc = concrete(level, imp ? 8 : 4);
		if (imp && cc.exhausted) exhausted++;
		if (cc.found) {
			routes++;
			if (imp) bad.push(`${rows.join('/')}: proven impossible (plain ${plain.verdict}, reach ${withReach ? withReach.verdict : '-'}) but a route exists`);
			const st = statesFile(level, cc.found);
			const r = prove(level, ['--noStop', `--states=${st.file}`, '--seconds=90']);
			if (r.done && (r.done.end === 'time' || r.done.end === 'cells')) limits++;
			else if (r.route && r.route.missing === 0) contained++;
			else bad.push(`${rows.join('/')}: ${r.route ? `${r.route.missing}/${r.route.states}` : 'no'} route states outside the fixpoint`);
		}
	}
	check(`${rooms} rooms (${cut} of them ruled out by the reach field): ${proven} proven impossible (${exhausted} of them where the concrete search ran out of states too), ${routes} with a concrete route ` +
		`(${contained} contained, ${limits} over the limit): no proof refuted, every route inside`, rooms === NROOMS && !bad.length, bad.join('; ') || undefined);
}

// ---------------------------------------------------------------- the reach field's cut-off
function reachSection() {
	section('reach: --reach (states the reach field cuts off are dropped): the same answers, fewer boxes, faster');
	const levels = REACH_ROOMS.map(([name, exp, rws]) => [name, exp, ascii(box(rws))]);
	for (const [Gw, C, L] of GAPS.slice(4, 10)) levels.push([`gap G${Gw} C${C} L${L}`, 'yes', ascii(gapRows(L, Gw, C))], [`gap G${Gw} C${C} L${L - 1}`, '?', ascii(gapRows(L - 1, Gw, C))]);
	levels.push(['user50', 'yes', levelOfBuf(Buffer.from(USER50, 'base64'))], ['user50 shift2', 'no', user50Variant('shift2')], ['user50 entry34', 'no', user50Variant('entry34')]);
	const bad = [], lines = [];
	let fewer = 0, compared = 0, plainSec = 0, reachSec = 0;
	for (const [name, exp, level] of levels) {
		const rf = reachFile(level);
		const a = prove(level, ['--seconds=120']).done, b = prove(level, ['--seconds=120', `--reach=${rf.file}`]).done;
		if (!a || !b) { bad.push(`${name}: no answer`); continue; }
		if (exp === 'yes' && b.verdict === 'impossible') bad.push(`${name}: a route exists, but impossible with the reach field`);
		if (a.verdict === 'impossible' && b.verdict !== 'impossible') bad.push(`${name}: proven without the reach field (${a.verdict}) but not with it (${b.verdict})`);
		if (rf.startCost >= 0 && b.reach !== 1) bad.push(`${name}: the reach file was not used`);
		if (rf.startCost >= 0) { compared++; if (b.cells <= a.cells) fewer++; plainSec += a.sec; reachSec += b.sec; }
		lines.push(`${name} ${a.verdict}/${b.verdict} ${a.cells}->${b.cells}`);
	}
	check(`${levels.length} levels: never impossible where a route exists, every plain proof kept, the field read`, !bad.length, bad.join('; ') || undefined);
	check(`no more boxes with the cut-off (${fewer} of ${compared} levels the field leaves open), faster in total (${plainSec.toFixed(1)} s -> ${reachSec.toFixed(1)} s)`,
		compared > 0 && fewer === compared && reachSec < plainSec, lines.join(', '));
	// a reach file of another level: refused with a warning, the proof runs without it
	const other = reachFile(ascii(box(REACH_ROOMS[0][2]))).file;
	const r = prove(user50Variant('shift2'), [`--reach=${other}`]);
	check('a reach file of another level: a warning, the proof without the cut-off', r.warning && /not used/.test(r.warning.text) && r.done && r.done.verdict === 'impossible' && r.done.reach === 0,
		`${r.warning ? r.warning.text : 'no warning'}; ${brief(r.done)}`);
}

// ---------------------------------------------------------------- the scope
function scopeSection() {
	section('scope: levels with blocks the model does not cover are refused with the reason');
	const inner = ['........', '........', '.....T..', '........', '.S......'];
	const cases = [
		['a dot', box(['..o.....', ...inner.slice(1)]), /^blocks 4$/],
		['an arrow', box(['..<.....', ...inner.slice(1)]), /^blocks 1$/],
		['ice', box([...inner.slice(0, 4), '.S.I....']), /^blocks 1064$/],
		['an effect block', box(['..J.....', ...inner.slice(1)]), /^blocks 417$/],
		['no trophy', box(['........', '........', '........', '........', '.S......']), /^no trophy$/],
		['no spawn, a solid at tile (1, 1) (the start inside a block)', ['##########', '##........', '#......T.#', '#........#', '##########'], /the start overlaps a block/],
	];
	for (const [what, rows, re] of cases) {
		const d = prove(ascii(rows)).done;
		check(`${what}: unsupported (${re})`, d && d.verdict === 'unsupported' && re.test(d.why), d ? `${d.verdict}: ${d.why || ''}` : 'no done line');
	}
	const d = prove(ascii(box(inner)), [], TOOL).done;
	check('an open room: the done line (verdict, end, seconds, boxes, explanation)', d && d.verdict === 'reached' && d.end === 'goal' && d.sec >= 0 && d.cells > 0 && d.explain &&
		d.explain.trophy.join() === '6,3' && d.explain.nearestDist === 0 && d.explain.size.join() === '10,7', JSON.stringify(d));
	// world gravity 2 (the level header): out of scope
	const g2 = ascii(box(inner), { gravity: 2 });
	const dg = prove(g2).done;
	check('world gravity 2: unsupported', g2.gravityMult === 2 && dg && dg.verdict === 'unsupported' && /world gravity/.test(dg.why), dg ? `${g2.gravityMult}: ${dg.verdict} ${dg.why || ''}` : 'no done line');
}

// ---------------------------------------------------------------- mutants
const MUT = {
	noYRetry: ['\tif (A.c >= A.n) return 0;', '\tif (A.c >= A.n || (!isX && A.done)) return 0;'],
	noXRetry: ['\tif (A.c >= A.n) return 0;', '\tif (A.c >= A.n || (isX && A.done)) return 0;'],
	noBigStep: ['\tif (S.lo == (double)k) {\n\t\t// from a whole pixel: one big step', '\tif (false) {\n\t\t// from a whole pixel: one big step'],
	noAlign: ['bool aligned = h == 0 && (o.donex || pr.second);', 'bool aligned = false;'],
	groundedAlways: ['if (!isX && !a.done) d.grounded = vy1 > 0.0;', 'if (!isX && !a.done) d.grounded = vy1 >= 0.0 || true;'],
	noThreshold: ['\t\tIv s = ivMeet(Iw, Iv{ above(b), below(thr[t]) });', '\t\tIv s = EMPTY;'],
};
function build(dirIn, exe) {
	const zig = path.join(__dirname, '..', 'tools', '.cache', 'zig-x86_64-windows-0.16.0', 'zig.exe');
	return new Promise((res) => execFile(zig, ['c++', '-O2', '-std=c++17', '-target', 'x86_64-windows-gnu', '-ffp-contract=off', '-fno-fast-math', '-Wno-nullability-completeness',
		path.join(dirIn, 'eegpu.cpp'), '-o', exe], { maxBuffer: 1 << 26 }, (err, out, errOut) => res(err ? String(errOut || err.message).slice(-400) : '')));
}
async function mutantsSection() {
	section('mutants: deliberately broken transfers (native/prove.h edited in a copy) must fail the check');
	const src = fs.readFileSync(path.join(__dirname, '..', 'native', 'prove.h'), 'utf8');
	let caught = 0, n = 0;
	for (const [name, [a, b]] of Object.entries(MUT)) {
		if (!src.includes(a)) { check(`mutant ${name}: its pattern is in prove.h`, false); continue; }
		const d = path.join(TMP, `mut_${name}`);
		fs.mkdirSync(d);
		for (const f of fs.readdirSync(path.join(__dirname, '..', 'native'))) if (/\.(h|cpp|cu)$/.test(f)) fs.copyFileSync(path.join(__dirname, '..', 'native', f), path.join(d, f));
		fs.writeFileSync(path.join(d, 'prove.h'), src.replace(a, b));
		const exe = path.join(d, 'eegpu.exe');
		const t0 = Date.now();
		const err = await build(d, exe);
		if (err) { check(`mutant ${name}: builds`, false, err); continue; }
		const { total } = fuzz(exe, NCASES, 5);
		const hit = total.missed + total.oBoundViolations > 0;
		n++;
		if (hit) caught++;
		console.log(`  info ${name.padEnd(15)} ${hit ? 'caught' : 'NOT caught'}: ${JSON.stringify(total)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
	}
	// (noThreshold, the engine's rounding boundary of tile coverage, matters only for positions within ~1e-14 px of a tile
	// edge, which the samples seldom hit: the prototype's 5 of 6; its effect, a wall jump off a box 1e-10 px inside a wall,
	// showed up in whole fixpoints)
	check(`${caught} of ${n} mutants caught by the check (at least 5)`, n === Object.keys(MUT).length && caught >= 5);
}

(async () => {
	if (!TOOL || !fs.existsSync(TOOL)) {
		check('the native tool is built (node tools/build-native.js, or --exe for the CPU commands alone)', false, TOOL || 'missing');
	} else {
		console.log(`tool: ${TOOL}`);
		const t0 = Date.now();
		if (want('scope')) scopeSection();
		if (want('check')) checkSection();
		if (want('rooms')) roomsSection();
		if (want('contain')) containSection();
		if (want('reach')) reachSection();
		if (want('random')) randomSection();
		if (argv.includes('--mutants')) await mutantsSection();
		console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
