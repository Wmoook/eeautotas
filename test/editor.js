'use strict';
// test/editor.js - the level editor (src/editor.js, src/app/editor.html, src/eelvl.js writeEelvl):
//   roundtrip  every editor level -> .eelvl (writeEelvl) -> readEelvl / toSimLevel / prepareLevel: the same blocks, the
//              same numbers and portals (the AS3 Lookup), the same spawn, the header; the editor reads its own file back
//              identically and writes it again byte for byte; a crafted file (several records per cell, layer-1 numbers)
//              keeps the numbers EEO uses. Levels: every palette block with every rotation / number, random levels with
//              backgrounds, signs, labels, world portals and NPCs.
//   checks     no start, no trophy, walled in, only through portals, several spawns, only through a death; bad input is
//              refused clearly; the physics check of the page's checks (from the cache, else in a worker thread: check()
//              answers at once, the page asks again; the "No way up" note; the cache named by the model's fingerprint)
//   app        the page's script parses; the HTTP API (in-process server, temp data folder): the page, blocks, eelvl,
//              parse, check, solve refusals, a job from a route (Watch / Optimize)
//   passes     the "every move" pass ladder (src/editor.js passCells / passSeconds / nextPass) and the whole search
//              driven by a stand-in for eegpu (a Node script playing scripted passes; no GPU): coarse first with pass 0's
//              speed cells, a share of the time, finer passes bounded by the route found (--depth), the "ran out of
//              situations" verdict only from pass 0 or finer with no layer cut, a beam's route bounding the exploration
//   cpu        the CPU route search (src/goexplore.js, no GPU; one or two threads, a few seconds): routes replayed in the
//              JS engine, the same seed and tick budget give the same routes (also with 64 snapshots, states rebuilt by
//              replaying), --first, --depth, "stop" and the end of stdin; the editor without an NVIDIA GPU (the CPU
//              search alone, with a note; a route; the physics verdict), and next to the eegpu stand-in (its first route
//              bounds the exploration's next pass, it stops when the GPU strategies have ended with a route, not when
//              they failed)
//   gpu        (--gpu) short route searches on the GPU (at most 60 s each), verified in the JS engine
// usage: node test/editor.js [--gpu] [--seed=N]      Exit code 1 if any check fails. Writes nothing inside the repo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const argv = process.argv.slice(2);
const GPU = argv.includes('--gpu');
// --gpuOnly=a,b: only the GPU cases whose names contain one of these (short GPU runs, one at a time)
const GPU_ONLY = ((argv.find((a) => a.startsWith('--gpuOnly=')) || '').slice(10)).split(',').filter(Boolean);
const SEED = +((argv.find((a) => a.startsWith('--seed=')) || '--seed=1').slice(7));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-editor-'));
process.env.EEAT_HOME = HOME;   // (before src/ is required: jobs and data go to the temp folder)
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const SRC = path.resolve(__dirname, '..', 'src');
const EL = require('../src/eelvl.js');
const E = require('../src/eesim.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
function rngOf(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); }
function room(W, H) {
	const c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
	return c;
}

// ---------------------------------------------------------------- the palette (read from the page, so the test follows it)
const PAGE = fs.readFileSync(path.join(SRC, 'app', 'editor.html'), 'utf8');
function paletteIds() {
	const consts = {};
	for (const m of PAGE.matchAll(/const (ONEWAYS|HALVES) = \[([\d,\s]+)\]/g)) consts[m[1]] = m[2].split(',').map(Number);
	const block = PAGE.slice(PAGE.indexOf('const PAL = ['), PAGE.indexOf('];', PAGE.indexOf('const PAL = [')));
	const ids = [];
	for (const m of block.matchAll(/ids: (\[[^\]]*\]|ONEWAYS|HALVES)/g)) {
		if (m[1] === 'ONEWAYS' || m[1] === 'HALVES') ids.push(...consts[m[1]]);
		else ids.push(...m[1].slice(1, -1).split(',').map((s) => s.trim()).map((s) => (s === 'SPAWN' ? 255 : s === 'TROPHY' ? 121 : +s)));
	}
	return [...new Set(ids)];
}
const ARG_VALUES = { int: [[0], [1], [2], [3], [1000], [-1], [2147483647], [-2147483648]], portal: [[0, 1, 2], [3, 2, 1], [1, 0, 0], [2, 999999, -5]],
	sign: [['hello', 0], ['ünïcødé ✓ text', 3]], world_portal: [['PWxyz', 1]], label: [['label text', '#FF00FF', 120]], npc: [['Bob', 'hi', '', 'bye']] };

// ---------------------------------------------------------------- roundtrip
/** readEelvl(eelvlOf(lv)) and toSimLevel agree with lv in every cell; returns a list of differences */
function roundtripDiffs(lv) {
	const n = ED.normalize(lv);
	const buf = ED.eelvlOf(lv);
	const p = EL.readEelvl(buf);
	const W = n.width, N = W * n.height;
	const d = [];
	const dd = (s) => { if (d.length < 8) d.push(s); };
	if (p.compression !== 'raw-deflate' || !p.hasHeader) dd(`compression ${p.compression}, header ${p.hasHeader}`);
	if (p.warnings.length) dd(`warnings: ${p.warnings.join('; ')}`);
	if (p.width !== n.width || p.height !== n.height || p.name !== n.name || p.owner !== n.owner || p.description !== n.description) dd('header fields');
	if (p.gravity !== Math.fround(n.gravity) || p.bgColor !== n.bgColor || p.minimap !== true || p.ownerId !== 'made offline') dd(`gravity ${p.gravity} bg ${p.bgColor}`);
	// one record per (id, layer, args), positions row-major
	const keys = new Set();
	for (const r of p.records) {
		const k = `${r.layer}|${r.id}|${JSON.stringify(r.args)}`;
		if (keys.has(k)) dd(`two records for ${k}`);
		keys.add(k);
		for (let o = 1; o < r.xs.length; o++) if (r.ys[o] * W + r.xs[o] <= r.ys[o - 1] * W + r.xs[o - 1]) { dd(`record ${k} not row-major`); break; }
	}
	for (let i = 0; i < N; i++) {
		if (p.fg[i] !== n.fg[i]) dd(`fg ${i}: ${p.fg[i]} vs ${n.fg[i]}`);
		if (p.bg[i] !== n.bg[i]) dd(`bg ${i}: ${p.bg[i]} vs ${n.bg[i]}`);
		const a = n.fgArgs.get(i), kind = n.fg[i] ? EL.argKind(n.fg[i]) : 'none';
		if (kind === 'int' && p.lookup.int.get(i) !== a[0]) dd(`lookup int ${i}: ${p.lookup.int.get(i)} vs ${a[0]}`);
		if (kind === 'portal') { const q = p.lookup.portals.get(i); if (!q || q.rotation !== a[0] || q.id !== a[1] || q.target !== a[2]) dd(`portal ${i}`); }
		if (kind !== 'int' && kind !== 'portal' && !n.bgArgs.has(i) && p.lookup.int.has(i)) dd(`stray lookup int at ${i}`);
	}
	// the editor reads its file back identically, and writes the same bytes again
	const back = ED.levelOf(buf);
	const sorted = (list) => (list || []).map((c) => JSON.stringify(c)).sort().join('\n');
	const norm = (grid, am) => { const o = []; for (let i = 0; i < N; i++) if (grid[i]) o.push([i % W, Math.floor(i / W), grid[i], ...(am.get(i) || [])]); return o; };
	if (sorted(back.cells) !== sorted(norm(n.fg, n.fgArgs))) dd('levelOf cells');
	if (sorted(back.bg) !== sorted(norm(n.bg, n.bgArgs))) dd('levelOf bg');
	if (Buffer.compare(ED.eelvlOf(back), buf) !== 0) dd('eelvlOf(levelOf(file)) is not the same bytes');
	// toSimLevel / prepareLevel: the Lookup numbers, portals and the spawn the engine uses
	const js = EL.toSimLevel(p);
	const li = new Map(js.lookup_int);
	for (let i = 0; i < N; i++) {
		const a = n.fgArgs.get(i);
		if (a && EL.argKind(n.fg[i]) === 'int' && li.get(i) !== a[0]) dd(`lookup_int ${i}`);
	}
	const nPortals = [...n.fgArgs.keys()].filter((i) => EL.argKind(n.fg[i]) === 'portal').length + [...n.bgArgs.keys()].filter((i) => EL.argKind(n.bg[i]) === 'portal').length;
	if (js.portals.length !== nPortals) dd(`portals ${js.portals.length} vs ${nPortals}`);
	// World.spawnPoints[0]: every 255, and every world-portal spawn 1582 with number 0
	const spawns = [];
	for (let i = 0; i < N; i++) if (n.fg[i] === 255 || (n.fg[i] === 1582 && n.fgArgs.get(i)[0] === 0)) spawns.push([i % W, Math.floor(i / W)]);
	if (JSON.stringify((js.spawn_points[0] || []).slice().sort()) !== JSON.stringify(spawns.slice().sort())) dd('spawn points');
	const L = E.prepareLevel(js);
	for (let i = 0; i < N; i++) {
		if (L.fg[i] !== n.fg[i]) { dd(`prepared fg ${i}`); break; }
		const a = n.fgArgs.get(i);
		if (a && EL.argKind(n.fg[i]) === 'int' && L.lookup0[i] !== a[0]) { dd(`prepared lookup0 ${i}: ${L.lookup0[i]} vs ${a[0]}`); break; }
	}
	return d;
}
function roundtripSection() {
	section('roundtrip: editor level -> .eelvl (writeEelvl) -> readEelvl / toSimLevel / prepareLevel');
	const ids = paletteIds();
	check(`the page's palette has the blocks asked for (${ids.length} ids)`, ids.length > 60 && [255, 121, 9, 1001, 1116, 1, 2, 3, 1518, 411, 4, 114, 361, 100, 101, 119, 369, 416, 1585,
		417, 419, 453, 461, 1517, 418, 420, 421, 422, 1584, 6, 7, 8, 23, 26, 242].every((x) => ids.includes(x)), ids.join(','));
	// every palette block with every argument value that matters
	const cells = [], W = 60;
	let x = 1, y = 1;
	const put = (id, args) => { cells.push([x, y, id, ...args]); x += 2; if (x >= W - 1) { x = 1; y += 2; } };
	for (const id of ids) {
		const kind = EL.argKind(id);
		if (id === 255) continue;
		if (kind === 'none') put(id, []); else for (const a of ARG_VALUES[kind]) put(id, a);
	}
	cells.push([W - 2, y + 2, 255]);
	const all = { name: 'Every block', width: W, height: y + 4, cells, gravity: 1, bgColor: 0xff203040, description: 'test ✓' };
	let dif = roundtripDiffs(all);
	check(`every palette block with every rotation / number (${cells.length} cells)`, dif.length === 0, dif.join(' | '));
	// rotations: the four of each rotatable block
	const rot = { name: 'rotations', width: 12, height: 40, cells: [] };
	const rotIds = ids.filter((id) => EL.argKind(id) === 'int');
	rotIds.forEach((id, k) => { for (let r = 0; r < 4; r++) rot.cells.push([1 + r * 2, 1 + (k % 38), id, r]); });
	dif = roundtripDiffs(rot);
	check(`rotations 0-3 of the ${rotIds.length} blocks with a number`, dif.length === 0, dif.join(' | '));
	// random levels: sizes, gravity, backgrounds, texts
	const R = rngOf(SEED);
	let bad = 0, first = '';
	const extra = [385, 1000, 374, 1550, 1582, 110, 111, 50, 243, 5];
	for (let t = 0; t < 60; t++) {
		const W2 = 3 + Math.floor(R() * 70), H2 = 3 + Math.floor(R() * 50);
		const lv = { name: `random ${t}`, width: W2, height: H2, gravity: [1, 0.5, 2.7, 0, -1][t % 5], bgColor: t % 3 ? 0 : (0xff000000 | Math.floor(R() * 0xffffff)) >>> 0,
			owner: t % 4 ? 'player' : 'someone', cells: t % 2 ? room(W2, H2) : [], bg: [] };
		const n = Math.floor(R() * W2 * H2 * 0.6);
		for (let k = 0; k < n; k++) {
			const pool = R() < 0.1 ? extra : ids;
			const id = pool[Math.floor(R() * pool.length)];
			const kind = EL.argKind(id);
			const a = kind === 'none' ? [] : ARG_VALUES[kind][Math.floor(R() * ARG_VALUES[kind].length)];
			lv.cells.push([Math.floor(R() * W2), Math.floor(R() * H2), id, ...a]);
			if (R() < 0.2) lv.bg.push([Math.floor(R() * W2), Math.floor(R() * H2), 500 + Math.floor(R() * 200)]);
		}
		const d = roundtripDiffs(lv);
		if (d.length) { bad++; if (!first) first = `random ${t}: ${d.join(' | ')}`; }
	}
	check('60 random levels (sizes 3..72 x 3..52, world gravity 0 / -1 / 2.7, background colors, backgrounds, signs, labels, NPCs, world portals)', bad === 0, first || '60 identical');

	// a crafted file (not the editor's): two records on a cell, a later layer-1 number on a foreground spike's cell,
	// a background portal record: the editor keeps what EEO uses, and its file makes the same engine level
	const recs = [...[{ id: 9, xs: [0, 1, 2, 3, 4, 5, 6, 7, 0, 7, 0, 7, 0, 1, 2, 3, 4, 5, 6, 7], ys: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3] }],
		{ id: 361, xs: [2, 3], ys: [2, 2], args: [1] }, { id: 1116, layer: 1, xs: [2], ys: [2], args: [3] },
		{ id: 1002, xs: [4], ys: [2], args: [0] }, { id: 1003, xs: [4], ys: [2], args: [2] }, { id: 255, xs: [1], ys: [2] }, { id: 121, xs: [6], ys: [2] }];
	const crafted = EL.writeEelvl({ width: 8, height: 4, name: 'crafted', records: recs });
	const lvC = ED.levelOf(crafted);
	const L1 = E.prepareLevel(EL.toSimLevel(EL.readEelvl(crafted))), L2 = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf(lvC))));
	const same = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
	check('a crafted file: the editor keeps the numbers EEO uses (a later layer-1 record wins the Lookup; the last record on a cell wins) and makes the same engine level',
		same(L1.fg, L2.fg) && same(L1.lookup0, L2.lookup0) && L2.lookup0[2 * 8 + 2] === 3 && L2.lookup0[2 * 8 + 3] === 1 && L2.fg[2 * 8 + 4] === 1003 && L2.lookup0[2 * 8 + 4] === 2 &&
		JSON.stringify(lvC.cells.find((c) => c[0] === 2 && c[1] === 2)) === '[2,2,361,3]', JSON.stringify(lvC.cells.filter((c) => c[1] === 2)));

	// the writer refuses what would make a broken file
	const e1 = errOf(() => EL.writeEelvl({ width: 4, height: 4, records: [{ id: 361, xs: [1], ys: [1] }] }));
	const e2 = errOf(() => EL.writeEelvl({ width: 4, height: 4, records: [{ id: 9, xs: [70000], ys: [1] }] }));
	const e3 = errOf(() => EL.writeEelvl({ width: 4, height: 4, records: [{ id: 242, xs: [1], ys: [1], args: [0, 1] }] }));
	const e4 = errOf(() => EL.writeEelvl({ width: 4, height: 4, records: [{ id: 385, xs: [1], ys: [1], args: [5, 0] }] }));
	check('writeEelvl refuses a wrong argument shape, a position past 65535, a number where a text belongs', e1 && /takes 1 argument/.test(e1.message) && e2 && /not 0\.\.65535/.test(e2.message) &&
		e3 && /takes 3/.test(e3.message) && e4 && /must be a string/.test(e4.message), [e1, e2, e3, e4].map((e) => (e ? e.message : 'accepted')).join(' | '));
	const n1 = errOf(() => ED.normalize({ width: 5000, height: 5, cells: [] }));
	const n2 = errOf(() => ED.normalize({ width: 5, height: 5, cells: [[7, 1, 9]] }));
	const n3 = errOf(() => ED.normalize({ width: 5, height: 5, cells: [[1, 1, 70000]] }));
	const n4 = errOf(() => ED.normalize({ width: 5, height: 5, cells: [[1, 1, 461, 2.5]] }));
	check('the editor JSON is checked: size, positions, ids, whole numbers', n1 && /bad level size/.test(n1.message) && n2 && /outside/.test(n2.message) && n3 && /bad block id/.test(n3.message) &&
		n4 && /whole number/.test(n4.message), [n1, n2, n3, n4].map((e) => (e ? e.message : 'accepted')).join(' | '));
	const missing = ED.normalize({ width: 5, height: 5, cells: [[1, 1, 242], [2, 1, 361]] });
	check('missing arguments get the defaults (portal [0, 0, 0], rotation 0)', JSON.stringify(missing.fgArgs.get(6)) === '[0,0,0]' && JSON.stringify(missing.fgArgs.get(7)) === '[0]');
}

// ---------------------------------------------------------------- checks
function checksSection() {
	section('checks: what stands in the way of a route search');
	const lv = (cells, W = 16, H = 10) => ED.eelvlOf({ name: 'c', width: W, height: H, cells: [...room(W, H), ...cells] });
	let r = ED.check(lv([[2, 8, 255], [12, 8, 121]]));
	check('start + trophy + an open way: no problems', r.problems.length === 0 && r.reach === 'open' && JSON.stringify(r.start) === '[2,8]', JSON.stringify(r));
	r = ED.check(lv([[12, 8, 121]]));
	check('no start block: the ball starts at the top-left (1, 1) like in EE; a note, not a problem', r.problems.length === 0 && JSON.stringify(r.start) === '[1,1]' && r.noSpawn && r.notes.some((s) => /top-left/.test(s)), JSON.stringify(r));
	r = ED.check(lv([[2, 8, 255]]));
	check('no trophy', r.problems.some((q) => q.code === 'trophy'), JSON.stringify(r.problems));
	const box = [[11, 4, 9], [12, 4, 9], [13, 4, 9], [11, 5, 9], [13, 5, 9], [11, 6, 9], [12, 6, 9], [13, 6, 9]];
	r = ED.check(lv([[2, 8, 255], [12, 5, 121], ...box]));
	check('a walled-in trophy (8 ways, no corner cutting)', r.problems.some((q) => q.code === 'unreachable') && r.reach === 'none', JSON.stringify(r.problems));
	r = ED.check(lv([[2, 8, 255], [12, 5, 121], ...box.filter((c) => !(c[0] === 13 && c[1] === 4))]));
	check('a diagonal gap between two blocks does not count (the ball is a whole tile)', r.reach === 'none', r.reach);
	r = ED.check(lv([[2, 8, 255], [12, 5, 121], ...box.filter((c) => !(c[0] === 13 && c[1] === 5)), [13, 5, 23]]));
	check('a door counts as open (it can open)', r.reach === 'open', r.reach);
	const box5 = [];   // a closed 5 x 5 box (walls 9..13 x 2..6) with the trophy and the exit portal (id 2) inside
	for (let x = 9; x <= 13; x++) box5.push([x, 2, 9], [x, 6, 9]);
	for (let y = 3; y <= 5; y++) box5.push([9, y, 9], [13, y, 9]);
	r = ED.check(lv([[2, 8, 255], [12, 4, 121], ...box5, [10, 5, 242, 0, 2, 1], [5, 8, 242, 0, 1, 2]]));
	check('a trophy reachable only through a portal: a note, not a problem', r.problems.length === 0 && r.reach === 'portals' && r.notes.some((s) => /portals/.test(s)), `${r.reach} ${r.notes.join(' ')}`);
	r = ED.check(lv([[2, 8, 255], [4, 8, 255], [12, 8, 121]]));
	check('two spawn points: the start after /reset (the second one) and a note', JSON.stringify(r.start) === '[4,8]' && r.notes.some((s) => /2 spawn points/.test(s)), JSON.stringify(r));
	// a death as a way to move: the start (the second spawn after /reset) walled in with a curse, the trophy by the first
	// spawn: the curse kills, EE respawns the ball at the next spawn of its rotation
	const wall = [];
	for (let y = 1; y <= 8; y++) wall.push([7, y, 9]);
	r = ED.check(lv([[2, 8, 255], [11, 8, 255], [5, 8, 121], [14, 8, 421, 1], ...wall]));
	check('a trophy reachable only through a death (2 spawn points, a curse): open, not "walled in"', r.problems.length === 0 && r.reach === 'open', `${r.reach} ${JSON.stringify(r.problems)}`);
	r = ED.check(lv([[2, 8, 255], [11, 8, 255], [5, 8, 121], ...wall]));
	check('... and without the curse (no way to die): walled in', r.problems.some((q) => q.code === 'unreachable'), JSON.stringify(r.problems));
}
// ---------------------------------------------------------------- the page's physics check (never on the server's thread)
async function physicsCheckSection() {
	section('the physics check of the page\'s checks: from the cache, else built in a worker thread (the page asks again)');
	const rnd = rngOf(5);
	const W = 200, H = 200, cells = room(W, H);
	for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rnd() < 0.08) cells.push([x, y, rnd() < 0.7 ? 9 : [4, 2, 361, 1052][Math.floor(rnd() * 4)]]);
	cells.push([100, 3, 121], [3, H - 2, 255]);
	const big = ED.eelvlOf({ name: 'sparse 200', width: W, height: H, cells });
	let t0 = Date.now();
	let r = ED.check(big);
	const ms = Date.now() - t0;
	// (a timer set now fires on time: the build runs on another thread)
	t0 = Date.now();
	await new Promise((res) => setTimeout(res, 10));
	const late = Date.now() - t0 - 10;
	check('a 200 x 200 level: check() answers at once, the physics check runs in a worker thread (pending)', r.physicsPending === true && ms < 2000 && late < 500, `${ms} ms, a 10 ms timer ${late} ms late, pending ${r.physicsPending}`);
	for (t0 = Date.now(); r.physicsPending && Date.now() - t0 < 60000; r = ED.check(big)) await new Promise((res) => setTimeout(res, 200));
	check('... then (asked again, as the page does) the check has its answer: no note for an open level', !r.physicsPending && !r.notes.some((x) => /No way up/.test(x)), `${((Date.now() - t0) / 1000).toFixed(1)} s; ${r.notes.join(' ')}`);
	// the trophy on a ledge two tiles above any jump: the note, with the highest row the ball gets to
	const hi = room(20, 10);
	for (let x = 8; x <= 12; x++) hi.push([x, 3, 9]);
	hi.push([10, 2, 121], [3, 8, 255]);
	const hiBuf = ED.eelvlOf({ name: 'way too high', width: 20, height: 10, cells: hi });
	for (t0 = Date.now(), r = ED.check(hiBuf); r.physicsPending && Date.now() - t0 < 30000; r = ED.check(hiBuf)) await new Promise((res) => setTimeout(res, 100));
	check('a trophy out of reach: the "No way up" note (the highest row the ball gets to)', r.notes.some((x) => /No way up/.test(x) && /no higher than row 4; the trophy is in row 2/.test(x)), r.notes.join(' '));
	// the cache: named by the model's fingerprint (a changed model never reads an old verdict)
	const files = fs.readdirSync(path.join(C.DATA, 'editor')).filter((f) => /^reach_/.test(f));
	check('the cache files carry the model\'s fingerprint (reach_<level>_v3_<model>.json / .bin)', files.length >= 4 && files.every((f) => /^reach_[0-9a-f]{16}_v3_[0-9a-f]{10}\.(json|bin)$/.test(f)), files.join(', '));
}

// ---------------------------------------------------------------- the app (the page, the HTTP API)
function request(port, method, p, body) {
	return new Promise((resolve) => {
		const b = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
		const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers: b ? { 'Content-Type': 'application/json', 'Content-Length': b.length } : {} }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const buf = Buffer.concat(chunks);
				let json = null;
				try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not JSON */ }
				resolve({ status: res.statusCode, type: res.headers['content-type'] || '', disp: res.headers['content-disposition'] || '', buf, json });
			});
		});
		rq.on('error', (e) => resolve({ status: -1, error: e.message }));
		rq.end(b || undefined);
	});
}
async function appSection() {
	section('app: the page and the HTTP API (in-process server, temp data folder)');
	const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	check('the editor page\'s script parses', scripts.length === 1 && !errOf(() => new Function(scripts[0])), scripts.map((s) => { const x = errOf(() => new Function(s)); return x ? x.message : 'ok'; }).join('; '));
	const SV = require('../src/server.js');
	await new Promise((res) => SV.server.listen(0, '127.0.0.1', res));
	const port = SV.server.address().port;
	try {
		let r = await request(port, 'GET', '/editor');
		check('GET /editor', r.status === 200 && /text\/html/.test(r.type) && r.buf.toString().includes('Level editor'), `${r.status}`);
		r = await request(port, 'GET', '/');
		check('the main page links to the editor', r.status === 200 && r.buf.toString().includes('href="/editor"'));
		r = await request(port, 'GET', '/api/editor/blocks?ids=9,121,242,1001,461,abc');
		check('GET /api/editor/blocks: names, kinds, colors, argument kinds', r.status === 200 && r.json.kinds[1001][0] === 'oneway' && r.json.args[242] === 'portal' && r.json.args[461] === 'int' &&
			r.json.names[121] && !('abc' in r.json.names), JSON.stringify(r.json).slice(0, 200));
		const W = 30, H = 8;
		const level = { name: 'API: test/1', width: W, height: H, cells: [...room(W, H), [2, 6, 255], [20, 6, 121], [8, 6, 461, 2], [10, 5, 242, 1, 3, 4]] };
		r = await request(port, 'POST', '/api/editor/eelvl', { level });
		check('POST /api/editor/eelvl: the bytes of eelvlOf, a safe file name', r.status === 200 && Buffer.compare(r.buf, ED.eelvlOf(level)) === 0 && /filename="API test1\.eelvl"/.test(r.disp), `${r.status} ${r.disp}`);
		const b64 = r.buf.toString('base64');
		r = await request(port, 'POST', '/api/editor/parse', { eelvlB64: b64 });
		check('POST /api/editor/parse: the level back', r.status === 200 && r.json.cells.length === level.cells.length && r.json.name === 'API: test/1', `${r.status} ${r.json && r.json.cells.length}`);
		r = await request(port, 'POST', '/api/editor/parse', { eelvlB64: Buffer.from('not a level').toString('base64') });
		check('POST /api/editor/parse of junk: 400 with the reason', r.status === 400 && /does not look like an \.eelvl/.test(r.json.error), `${r.status} ${r.json && r.json.error}`);
		r = await request(port, 'POST', '/api/editor/check', { eelvlB64: b64 });
		check('POST /api/editor/check', r.status === 200 && r.json.problems.length === 0 && r.json.reach === 'open' && r.json.gpu && r.json.gpu.id === 'gpu', JSON.stringify(r.json).slice(0, 160));
		r = await request(port, 'POST', '/api/editor/solve', { level: { name: 'x', width: 10, height: 6, cells: room(10, 6) } });
		check('POST /api/editor/solve without a trophy: 400 with the problem (before any GPU work)', r.status === 400 && r.json.problems.length === 1 && r.json.problems[0].code === 'trophy', `${r.status} ${r.json && r.json.error}`);
		r = await request(port, 'GET', '/api/editor/solve');
		check('GET /api/editor/solve before any search: idle', r.status === 200 && r.json.stage === 'idle' && !r.json.running, JSON.stringify(r.json));
		r = await request(port, 'GET', '/api/editor/solve/route.eetas');
		check('GET /api/editor/solve/route.eetas without a route: 404', r.status === 404);
		// no GPU here (the test server measures none: "preparing the GPU", or no native build): Find a route runs on the
		// CPU alone
		r = await request(port, 'POST', '/api/editor/solve', { eelvlB64: b64, seconds: 3, workers: 1 });
		check('POST /api/editor/solve without a GPU: the CPU search alone, with the reason', r.status === 200 && r.json.running && r.json.strategies.map((q) => q.key).join() === 'goexplore' &&
			/^No GPU search: no NVIDIA GPU is available \(.+\)\. The CPU searches alone/.test(r.json.cpuOnly), `${r.status} ${JSON.stringify(r.json && (r.json.cpuOnly || r.json.error))}`);
		const t0 = Date.now();
		while (r.json && r.json.running && Date.now() - t0 < 20000) { await new Promise((res) => setTimeout(res, 200)); r = await request(port, 'GET', '/api/editor/solve'); }
		const solved = r.json;
		r = await request(port, 'GET', '/api/editor/solve/route.eetas');
		check('... a route (random runs on the CPU), and GET .../route.eetas has its inputs', solved && solved.stage === 'found' && solved.result.strategy === 'random runs (CPU)' && r.status === 200 &&
			r.buf.toString('latin1') === solved.result.inputs, solved ? `${solved.stage} ${solved.result ? `${solved.result.time} (${solved.result.ticks} ticks)` : solved.message}` : 'no state');
		r = await request(port, 'GET', '/api/editor/nope');
		check('an unknown editor path: 404', r.status === 404);
		// a job from a route (what Watch and Optimize do): here a hand-made route, right until the trophy
		const route = Buffer.from('4'.repeat(250));
		r = await request(port, 'POST', '/api/editor/job', { eelvlB64: b64, eetasB64: route.toString('base64'), name: 'Editor job', start: false });
		const job = r.json && r.json.job;
		check('POST /api/editor/job: a job from the level and the route, not started', r.status === 200 && job && job.tas.completeTick > 0 && r.json.started === false && job.startMode === 'reset',
			`${r.status} ${job ? `${job.id} ${job.tas.time}` : JSON.stringify(r.json)}`);
		if (job) {
			r = await request(port, 'GET', `/api/jobs/${job.id}`);
			check('the job\'s summary: the route\'s time', r.status === 200 && r.json.best.runTicks === job.tas.runTicks, `${r.status} ${r.json && r.json.best && r.json.best.time}`);
			r = await request(port, 'POST', '/api/editor/job', { eelvlB64: b64, eetasB64: Buffer.from('0'.repeat(10)).toString('base64'), name: 'x' });
			check('a route that does not finish: 400, no job', r.status === 400 && /does not finish/.test(r.json.error), `${r.status} ${r.json && r.json.error}`);
			await request(port, 'DELETE', `/api/jobs/${job.id}`);
		}
		r = await request(port, 'GET', '/api');
		check('GET /api lists the editor endpoints', r.json.endpoints.filter((e) => /editor/.test(e.path)).length >= 9);
	} finally {
		await new Promise((res) => SV.server.close(res));
	}
}

// ---------------------------------------------------------------- the "every move" pass ladder (no GPU)
// A stand-in for eegpu: logs every launch's arguments, and "explore" plays the scenario's next run for its pass (the
// pass read back from --cqx): a layer event, then a finish (a route of `idle` idle ticks and then right to the trophy,
// when it fits in --depth) or a done event with the scripted end and overflow. "beam" reports the scenario's beam route
// (if any) and ends. With `fail` (ms) every launch fails after that long (an error line, exit code 1). With `ready` (ms)
// the first launch of each command loads its kernels that long before it says {"ev":"ready"} and starts. With
// `launchFail` (ms) "explore" fails that long after its start like a kernel launch the display driver's watchdog stopped
// (its launchError line, exit 7), and the beams run until their --stopfile appears, then end "stopped" (logged).
const FAKE = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a === undefined ? undefined : a.slice(k.length + 3); };
if (args[0] === 'info') return void setTimeout(() => process.stdout.write(JSON.stringify({ gpu: { name: 'fake' }, reach: SC.reach === undefined ? 3 : SC.reach }) + '\\n'), SC.infoDelay || 0);
const passOf =(a) => Math.round(Math.log2(+a.find((x) => x.startsWith('--cqx=')).slice(6) / 0.5));
const prev = fs.existsSync(SC.log) ? fs.readFileSync(SC.log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(SC.log, JSON.stringify(args) + '\\n');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (SC.fail) return void setTimeout(() => { say({ error: 'test: the GPU failed' }); process.exit(1); }, SC.fail);
if (SC.launchFail && args[0] === 'explore') return void setTimeout(() => { say({ error: 'test: the GPU driver stopped the explore expand kernel', cuda: 702, launchError: true, timeout: true }); process.exit(7); }, SC.launchFail);
if (SC.launchFail) {
	const sf = opt('stopfile');
	const iv = setInterval(() => {
		if (sf && fs.existsSync(sf)) { clearInterval(iv); fs.appendFileSync(SC.log, JSON.stringify(['stopped', args[0]]) + '\\n'); say({ ev: 'done', layers: 3, end: 'stopped' }); process.exit(0); }
		say({ ev: 'progress', layer: 3, tick: 3, states: 100, ticksPerSec: 1000 });
	}, 100);
	return;
}
const go = () => {
	if (args[0] !== 'explore') {
		if (SC.beam) say({ ev: 'result', kind: 'finish', inputs: SC.beam });
		say({ ev: 'done', layers: 3, end: SC.beam ? 'finish' : 'time' });
		return;
	}
	const p = passOf(args), k = prev.filter((a) => a[0] === 'explore' && passOf(a) === p && !a.some((x) => x.startsWith('--prefix='))).length;
	const relayN = prev.filter((a) => a[0] === 'explore' && a.some((x) => x.startsWith('--prefix='))).length;
	const run = opt('prefix') ? ((SC.relay || [])[relayN] || { end: 'exhausted', layers: 1, overflow: 0 }) : (SC.runs[p] || [])[k] || { end: 'exhausted', layers: 1, overflow: 0 };
	const depth = +opt('depth');
	const done = () => { const d = { ev: 'done', gpu: { name: 'fake' }, layers: run.layers, end: run.end }; if (run.overflow !== undefined) d.overflow = run.overflow; if (run.lanes) d.lanes = run.lanes; if (run.lastSalt !== undefined) d.salt = run.lastSalt; say(d); };
	setTimeout(() => {
		if (run.lanes) say({ ev: 'lanes', lanes: run.lanes, from: +opt('lanes') || 1, why: 'full', layers: run.layers });   // (--lanes: its batch filled the table)
		if (run.refine) say(Object.assign({ ev: 'refine' }, run.refine));   // (--refine: this try ran out, the next is refined)
		if (run.try) say(Object.assign({ ev: 'try' }, run.try));   // (--salts: a try ran through)
		if (run.closest) say({ ev: 'closest', dist: run.closest.dist, tick: run.closest.tick, inputs: '4'.repeat(run.closest.tick) });   // (the nearest attempt so far)
		say({ ev: 'layer', layer: run.layers, tick: run.layers, new: 5, kept: 5, states: 1000, hits: 0, sec: 0.1, ticks: 18000, ticksPerSec: 1e6, full: 0.01 });
		if (run.end !== 'finish') return void setTimeout(done, run.hold || 0);
		const ticks = run.idle + SC.R;
		if (ticks > depth) return void say({ ev: 'done', layers: depth, end: 'depth', overflow: 0 });
		say({ ev: 'hit', layer: ticks - 1, tick: ticks, inputs: '0'.repeat(run.idle) + '4'.repeat(SC.R + 10) });
		say({ ev: 'done', layers: ticks, end: 'finish', overflow: 0 });
	}, run.wait || 0);
};
if (SC.ready && !prev.some((a) => a[0] === args[0])) setTimeout(() => { say({ ev: 'ready', loadMs: SC.ready, allocMs: 1 }); go(); }, SC.ready);
else go();
`;
async function passesSection() {
	section('passes: the "every move" pass ladder (a stand-in for eegpu, no GPU)');
	const cells = (p) => JSON.stringify(ED.passCells(p));
	check('cells: coarse passes coarsen positions only (speeds stay at 1/16 px/tick); finer passes halve both; the finest keeps heights exact',
		cells(-2) === '{"cqx":0.125,"cqv":16,"qy":0.25,"qvy":16}' && cells(-1) === '{"cqx":0.25,"cqv":16,"qy":0.5,"qvy":16}' && cells(0) === '{"cqx":0.5,"cqv":16,"qy":1,"qvy":16}' &&
		cells(1) === '{"cqx":1,"cqv":32,"qy":2,"qvy":32}' && cells(2) === '{"cqx":2,"cqv":64,"qy":0,"qvy":0}' && ED.PASS_START === -1, [-2, -1, 0, 1, 2].map(cells).join(' '));
	const T = { how: 'time', seconds: 20, layer: 30 };
	const nx = [
		[ED.nextPass(-1, 'full', {}, 0, 50), -2], [ED.nextPass(-1, 'time', {}, 0, 50), -2], [ED.nextPass(-2, 'full', {}, 0, 50), null], [ED.nextPass(-1, 'exhausted', {}, 0, 50), 0],
		[ED.nextPass(2, 'exhausted', {}, 0, 50), null], [ED.nextPass(-2, 'exhausted', { '-1': { how: 'full' } }, 0, 50), null],
		[ED.nextPass(-2, 'exhausted', { '-1': T }, 0, 50), -1], [ED.nextPass(-2, 'exhausted', { '-1': T }, 0, 15), null], [ED.nextPass(-2, 'finish', { '-1': T }, 25, 50), 0],
		[ED.nextPass(-2, 'finish', { '-1': T }, 90, 50), -1], [ED.nextPass(0, 'depth', {}, 0, 50), null], [ED.nextPass(0, 'depth', {}, 100, 50), 1], [ED.nextPass(-1, 'finish', {}, 100, 50), 0],
		[ED.nextPass(0, 'beaten', {}, 100, 50), 1], [ED.nextPass(0, 'full', { '-1': { how: 'finish' } }, 100, 50), null], [ED.nextPass(0, 'finish', {}, 1, 50), null],
		[ED.nextPass(0, 'exhausted', { 1: { how: 'exhausted' } }, 0, 50), null],
		// with a route: a finer pass that ended without a faster one is passed over, unless it filled up short of the depth
		[ED.nextPass(-2, 'finish', { '-1': { how: 'full', layer: 60 } }, 40, 50), 0], [ED.nextPass(-2, 'finish', { '-1': { how: 'full', layer: 20 } }, 40, 50), null],
		[ED.nextPass(-2, 'finish', { '-1': { how: 'full', layer: 60 }, 0: { how: 'exhausted', layer: 30 } }, 40, 50), 1],
		// the coarsest pass fills up: the finer one that ran out of its share again, with all the time left
		[ED.nextPass(-2, 'full', { '-1': T }, 0, 50), -1], [ED.nextPass(-2, 'full', { '-1': T }, 0, 15), null]];
	check('the next pass: coarser after a full table or a used-up share, finer after every situation or a route; a pass never twice (one that ran out of time again only with more time, and not when it already searched deep enough)',
		nx.every(([a, b]) => a === b), nx.map(([a, b]) => `${a}${a === b ? '' : ` (want ${b})`}`).join(' '));
	const sh = [ED.passSeconds(-1, {}, 60), ED.passSeconds(-1, {}, 600), ED.passSeconds(-1, {}, 10), ED.passSeconds(-2, {}, 600), ED.passSeconds(0, { '-1': T }, 600)];
	check('the time share: a third of what is left (at least 20 s) while a coarser pass is untried, else all of it', JSON.stringify(sh) === '[20,200,10,600,600]', JSON.stringify(sh));

	// the whole search, driven by the stand-in: a flat room, holding right reaches the trophy in R ticks
	const W = 30, H = 8;
	const buf = ED.eelvlOf({ name: 'ladder', width: W, height: H, cells: [...room(W, H), [2, 6, 255], [20, 6, 121]] });
	const level = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	const R = C.evaluate(level, new Uint8Array(300).fill(4)).ms.length;
	const fake = path.join(HOME, 'fake-eegpu.js');
	fs.writeFileSync(fake, FAKE);
	let nSc = 0;
	const drive = async (runs, beam, during, salts, ready, body) => {
		const sc = path.join(HOME, `ladder-${++nSc}.json`), log = path.join(HOME, `ladder-${nSc}.log`);
		fs.writeFileSync(sc, JSON.stringify({ log, R, runs, beam: beam || null, ready: ready || 0 }));
		const { _test, ...b2 } = body || {};   // (_test: more of start()'s test options, e.g. the probe)
		ED.start(Object.assign({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024 }, b2), { available: true }, Object.assign({ tool: [process.execPath, fake, sc], cpu: false, salts: !!salts }, _test || {}));
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < 45000) { if (during) during(st); await new Promise((r) => setTimeout(r, 40)); st = ED.state(); }
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 40)); }
		const raw = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const kinds = raw.map((a) => (a[0] === 'explore' ? `explore ${Math.round(Math.log2(+a.find((x) => x.startsWith('--cqx=')).slice(6) / 0.5))}` : a[0]));
		const launches = raw.filter((a) => a[0] === 'explore')
			.map((a) => { const o = {}; for (const x of a) { const m = /^--(\w+)=(.*)$/.exec(x); if (m) o[m[1]] = m[2]; } return o; });
		const X = st.strategies.find((q) => q.key === 'explore');
		return { st, X, launches, kinds, text: `${st.stage}; passes ${launches.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join(', ')}; depth ${launches.map((o) => o.depth).join(', ')}; ` +
			`seconds ${launches.map((o) => o.seconds).join(', ')}${st.result ? `; route ${st.result.ticks} ticks (${st.result.strategy})` : ''}; ${st.message || ''}` };
	};
	const cellsOf = (o) => `${o.cqx}|${o.cqv}|${o.qy}|${o.qvy}`;
	// the live case: the coarse first pass finds a route, the finer ones (bounded by it) a faster one, and run out
	let r = await drive({ '-1': [{ end: 'finish', idle: 20, layers: 3 }], 0: [{ end: 'finish', idle: 5, layers: 3 }], 1: [{ end: 'exhausted', layers: 40, overflow: 0 }], 2: [{ end: 'depth', layers: 3 }] });
	let L = r.launches;
	check('a route from the coarse first pass (4 px cells, speeds at 1/16 px/tick, a 20 s share of 60 s), then finer passes look only for faster routes (--depth = route - 1) and find one',
		r.st.stage === 'found' && r.st.result.ticks === 5 + R && r.st.result.strategy === 'every move' && L.length === 4 && cellsOf(L[0]) === '0.25|16|0.5|16' && L[0].depth === '100000' &&
		L[0].seconds === '20' && cellsOf(L[1]) === '0.5|16|1|16' && +L[1].depth === 20 + R - 1 && +L[1].seconds >= 55 && cellsOf(L[2]) === '1|32|2|32' && +L[2].depth === 5 + R - 1 &&
		cellsOf(L[3]) === '2|64|0|0' && r.X.passes === 4 && r.X.state === 'found' && !r.st.running, r.text);
	// the old false verdict: a full pass, then a coarse pass that runs out of situations, is no evidence of anything
	r = await drive({ '-1': [{ end: 'full', layers: 50 }], '-2': [{ end: 'exhausted', layers: 16, overflow: 0 }] });
	L = r.launches;
	check('a coarse pass that runs out of situations gives no verdict ("not found", not "ran out of new situations")', r.st.stage === 'not found' && !r.st.impossible && !r.X.exhausted &&
		L.length === 2 && cellsOf(L[1]) === '0.125|16|0.25|16' && /^No route to the trophy found/.test(r.st.message) && !/ran out of new situations/.test(r.st.message), r.text);
	// a pass out of its share of the time -> coarser; that one runs out -> the first again with all the time left; then
	// finer: the verdict from pass 0 (no layer cut); a finer pass whose layers were cut does not replace it
	r = await drive({ '-1': [{ end: 'time', layers: 30 }, { end: 'exhausted', layers: 60, overflow: 0 }], '-2': [{ end: 'exhausted', layers: 16, overflow: 0 }],
		0: [{ end: 'exhausted', layers: 70, overflow: 0 }], 1: [{ end: 'exhausted', layers: 80, overflow: 4 }], 2: [{ end: 'full', layers: 50 }] });
	L = r.launches;
	check('out of its share -> coarser, then the slow pass again with all the time left; "ran out of new situations" from pass 0 (no layer cut, 2 px cells)',
		L.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join() === '-1,-2,-1,0,1,2' && L[0].seconds === '20' && +L[1].seconds >= 55 && +L[2].seconds >= 55 && r.st.stage === 'not found' &&
		r.X.exhausted && r.X.exhausted.pass === 0 && /ran out of new situations by tick 70 \(positions and speeds told apart to 2 px and 1\/16 px\/tick/.test(r.st.message) &&
		/not proof/.test(r.st.message), r.text);
	// passes that ran out but cut some layers (or did not say): no verdict
	r = await drive({ '-1': [{ end: 'exhausted', layers: 20, overflow: 0 }], 0: [{ end: 'exhausted', layers: 30, overflow: 3 }], 1: [{ end: 'exhausted', layers: 40 }], 2: [{ end: 'full', layers: 50 }] });
	check('passes that cut layers when they ran out (or do not say) give no verdict', r.st.stage === 'not found' && !r.X.exhausted && !/ran out of new situations/.test(r.st.message) &&
		r.launches.length === 4 && r.st.log.some((s) => /3 situations were cut/.test(s)) && r.st.log.some((s) => /does not say whether full layers were cut/.test(s)), r.text);
	// a beam's route first: the exploration deeper than it stops, and the finer passes look for a faster one
	r = await drive({ '-1': [{ end: 'time', layers: 5000, wait: 1500, hold: 4000 }], 0: [{ end: 'finish', idle: 10, layers: 3 }] }, '0'.repeat(30) + '4'.repeat(R + 10));
	L = r.launches;
	check('a beam\'s route: the exploration stops once deeper, and the next pass (finer, --depth = route - 1) finds a faster one', r.st.stage === 'found' && r.st.result.ticks === 10 + R &&
		r.st.result.strategy === 'every move' && r.X.ends['-1'] && r.X.ends['-1'].how === 'beaten' && L.length === 4 && +L[1].depth === 30 + R - 1 && cellsOf(L[1]) === '0.5|16|1|16' &&
		+L[2].depth === 10 + R - 1, r.text);
	// a route from the coarsest pass after pass -1 filled up deeper than that route: pass -1 cannot find a faster one (it
	// saw every layer up to there), so the refining goes on with pass 0
	r = await drive({ '-1': [{ end: 'full', layers: 200 }], '-2': [{ end: 'finish', idle: 20, layers: 3 }], 0: [{ end: 'finish', idle: 5, layers: 3 }] });
	L = r.launches;
	check('a route from the coarsest pass after pass -1 filled up beyond it: refining goes on with pass 0 (--depth = route - 1) and finds a faster one',
		r.st.stage === 'found' && r.st.result.ticks === 5 + R && L.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join() === '-1,-2,0,1,2' && +L[2].depth === 20 + R - 1 &&
		+L[3].depth === 5 + R - 1, r.text);
	// the finest pass ran out of situations and no pass is left: the same pass again with other states standing for merged
	// cells (--salt=1, 2, ...) until one finds the route (merged situations are no proof: which state stands for a cell
	// decides whether a pixel-exact move survives); the salt tries run side by side (--lanes=auto, up to ED.LANES, from the
	// last run's count: a run that ended with 4 lanes (its "lanes" event) makes the next start with 4), and the next salt
	// comes after the last one the tool tried (its done event's "salt": 9 here)
	let got = false;
	r = await drive({ '-1': [{ end: 'exhausted', layers: 20, overflow: 0 }], 0: [{ end: 'exhausted', layers: 30, overflow: 0 }], 1: [{ end: 'exhausted', layers: 40, overflow: 0 }],
		2: [{ end: 'exhausted', layers: 50, overflow: 0 }, { end: 'exhausted', layers: 52, overflow: 0, lanes: 4, lastSalt: 9 }, { end: 'finish', idle: 3, layers: 3 }] }, null,
		(st) => { if (st.result && !got) { got = true; ED.stop(); } }, true, 0, { refine: false });
	L = r.launches;
	const NL = String(ED.LANES);
	check(`the finest pass ran out of situations: the same pass again with other states standing for merged cells, several salts side by side (--lanes=auto --lanesMax=${NL}; ` +
		'--salt=1, then after the last salt the tool tried, starting with as many lanes as the last run ended with) until one finds the route',
		r.st.stage === 'found' && r.st.result.ticks === 3 + R && L.slice(0, 6).map((o) => Math.round(Math.log2(o.cqx / 0.5))).join() === '-1,0,1,2,2,2' && ED.LANES > 1 &&
		L.slice(0, 3).every((o) => o.lanes === undefined) && L.slice(3, 6).every((o) => o.lanes === 'auto' && o.lanesMax === NL) &&
		L[3].salt === undefined && L[3].lanesStart === '1' && L[4].salt === '1' && L[4].lanesStart === '1' && L[5].salt === '10' && L[5].lanesStart === '4' &&
		r.st.log.some((s) => /tries side by side filled the table/.test(s)),
		`${r.text}; salts ${L.map((o) => o.salt || 0).join(', ')}; lanes ${L.map((o) => `${o.lanes || 1}/${o.lanesStart || '-'}`).join(', ')}`);
	// near-miss refinement (on by default): the finest pass's salt tries run with --refine=1, one at a time (no lanes), and
	// the tool's refine event (the try before ran out) is noted in the log
	got = false;
	r = await drive({ '-1': [{ end: 'exhausted', layers: 20, overflow: 0 }], 0: [{ end: 'exhausted', layers: 30, overflow: 0 }], 1: [{ end: 'exhausted', layers: 40, overflow: 0 }],
		2: [{ end: 'exhausted', layers: 50, overflow: 0, refine: { frontierTiles: 19, nearMisses: 46, situations: 422, new: 422 } }, { end: 'finish', idle: 3, layers: 3 }] }, null,
		(st) => { if (st.result && !got) { got = true; ED.stop(); } }, true);
	L = r.launches;
	check('near-miss refinement: the salt tries of the finest pass run with --refine=1 and no lanes; the refine event is noted',
		r.st.stage === 'found' && L.slice(0, 3).every((o) => o.refine === undefined) && L.slice(3).length >= 1 && L.slice(3).every((o) => o.refine === '1' && o.lanes === undefined) &&
		r.st.log.some((x) => /19 tiles next to reached ones not entered: the next try looks 4x finer along the 46 nearest attempts \(422 situations\)/.test(x)),
		`${r.text}; refine ${L.map((o) => o.refine || '-').join(', ')}; lanes ${L.map((o) => o.lanes || '-').join(', ')}`);
	// the probe: "every move" starts with the finest pass; its first try runs through within the probe time (a try event):
	// it keeps the finest pass (the salt loop), no coarse pass runs
	got = false;
	r = await drive({ 2: [{ end: 'exhausted', layers: 50, overflow: 0, try: { salt: 0, end: 'exhausted', layers: 50, overflow: 0, states: 1000 }, hold: 200, lastSalt: 0 },
		{ end: 'finish', idle: 3, layers: 3 }] }, null, (st) => { if (st.result && !got) { got = true; ED.stop(); } }, true, 0, { _test: { probe: true, probeS: 5 } });
	L = r.launches;
	check('the probe: the finest pass first; its first try ran through in time, so it keeps the finest cells (the salt loop) and no coarse pass runs',
		r.st.stage === 'found' && L.length >= 2 && L.every((o) => Math.round(Math.log2(o.cqx / 0.5)) === 2) && r.st.log.some((x) => /the finest cells ran through in [\d.]+ s/.test(x)),
		`${r.text}; passes ${L.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join(', ')}`);
	// the probe's first try does not run through in time: it is stopped and the ladder runs from the coarse end
	got = false;
	r = await drive({ 2: [{ end: 'time', layers: 5000, wait: 6000, hold: 6000 }], '-1': [{ end: 'finish', idle: 20, layers: 3 }] }, null,
		(st) => { if (st.result && !got) { got = true; ED.stop(); } }, true, 0, { _test: { probe: true, probeS: 1 } });
	L = r.launches;
	check('the probe: a first try still going after the probe time is stopped; the ladder then starts at the coarse end (pass -1) and finds the route',
		r.st.stage === 'found' && L.length >= 2 && Math.round(Math.log2(L[0].cqx / 0.5)) === 2 && Math.round(Math.log2(L[1].cqx / 0.5)) === -1 &&
		r.st.log.some((x) => /the finest cells are too many here \(no try through in 1 s\); from coarse cells up/.test(x)),
		`${r.text}; passes ${L.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join(', ')}`);
	// the relay: a nearest attempt of 100+ ticks (the ladder's pass -1 reports one of 150, then keeps searching): "every
	// move" again from 60 ticks before its end (--prefix = its first 90 inputs, coarse speed cells), and its finish is the route
	{
		const scR = path.join(HOME, 'relay.json'), logR = path.join(HOME, 'relay.log');
		fs.writeFileSync(scR, JSON.stringify({ log: logR, R, runs: { '-1': [{ end: 'time', layers: 5000, wait: 200, hold: 8000, closest: { dist: 30, tick: 150 } }] },
			relay: [{ end: 'finish', idle: 0, layers: 3 }], beam: null }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024 }, { available: true }, { tool: [process.execPath, fake, scR], cpu: false, salts: true, relay: true });
		const t0r = Date.now();
		let str = ED.state();
		while (str.running && !str.result && Date.now() - t0r < 30000) { await new Promise((z) => setTimeout(z, 100)); str = ED.state(); }
		if (str.running) { ED.stop(); while (ED.state().running) await new Promise((z) => setTimeout(z, 50)); }
		const LR = fs.readFileSync(logR, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore');
		const rl = LR.find((a) => a.some((x) => x.startsWith('--prefix=')));
		const pf = rl ? rl.find((x) => x.startsWith('--prefix=')).slice(9) : '';
		const pfLen = pf && fs.existsSync(pf) ? fs.readFileSync(pf).length : -1;
		const opts = rl ? Object.fromEntries(rl.filter((x) => /^--\w+=/.test(x)).map((x) => x.slice(2).split('='))) : {};
		check('the relay: from a nearest attempt of 150 ticks, "every move" again from 60 ticks before its end (a --prefix of 90 inputs, 1/4 px/tick speed cells), and its finish is the route',
			!!rl && pfLen === 90 && opts.cqv === '4' && opts.qvy === '4' && str.result && str.result.strategy === 'from the nearest attempt',
			`relay launch: ${rl ? 'yes' : 'no'}, prefix ${pfLen} inputs, cells ${opts.cqx}/${opts.cqv}/${opts.qy}/${opts.qvy}; ${str.result ? `route ${str.result.ticks} ticks by ${str.result.strategy}` : str.stage}`);
	}
	// Stop while a finer pass looks for a faster route: no further pass, the route stays
	let stopped = false, t1 = 0;
	r = await drive({ '-1': [{ end: 'finish', idle: 20, layers: 3 }], 0: [{ end: 'time', layers: 50, wait: 8000 }] }, null, (st) => {
		// (from the stand-in's start for pass 0: a loaded machine can take over half a second to start node)
		const started = () => { try { return fs.readFileSync(path.join(HOME, `ladder-${nSc}.log`), 'utf8').split('\n').filter((l) => l.startsWith('["explore"')).length >= 2; } catch (e) { return false; } };
		if (st.result && st.strategies[0].pass === 0 && !t1 && started()) t1 = Date.now();
		if (t1 && Date.now() - t1 > 600 && !stopped) { stopped = true; ED.stop(); }   // (pass 0 under way)
	});
	L = r.launches;
	check('Stop while refining: the route stays, no further pass starts', stopped && r.st.stage === 'found' && r.st.result.ticks === 20 + R && L.length === 2 && r.X.passes === 2 &&
		r.X.ends['0'] && r.X.ends['0'].how === 'stopped' && !r.st.running, r.text);
	// the first search after an update: the engine loads its kernels for 3.5 s before its ready event. The page says the
	// GPU engine is being prepared, the search's clock starts at the ready, and the next pass's time is cut from the
	// strategy's search time only (the wall clock would leave 56 s)
	let prep = false, clock = null;
	r = await drive({ '-1': [{ end: 'time', layers: 30, wait: 400 }], '-2': [{ end: 'exhausted', layers: 16, overflow: 0 }] }, null, (st) => {
		const X0 = st.strategies.find((q) => q.key === 'explore');
		if (st.preparing && X0.preparing) prep = true;
		if (!clock && X0.state === 'running') clock = { search: st.searchElapsed, wall: st.elapsed };
	}, false, 3500);
	L = r.launches;
	check('a slow first load (3.5 s to the ready event): "preparing the GPU engine" meanwhile, the search\'s clock from the ready, the next pass gets the time the first did not search',
		prep && clock && clock.wall >= 3.4 && clock.search < 1.5 && L[0].seconds === '20' && +L[1].seconds >= 59 && r.st.stage === 'not found' && r.st.prepSec >= 3.4,
		`preparing seen ${prep}; clock at the first layer ${clock ? `${clock.search.toFixed(1)} s (wall ${clock.wall.toFixed(1)} s)` : '-'}; ${r.text}`);
	check('the physics check found a way: every pass of "every move" prunes the states it rules out (--prune=1)', L.length > 0 && L.every((o) => o.prune === '1'), L.map((o) => o.prune || '-').join());
	// the physics check rules the start out (a stand-in answer): "every move" alone, without the prune, for at most a
	// minute; a route it finds anyway is a mistake in the model: kept in model_miss.json and said in the log
	const miss = path.join(C.DATA, 'editor', 'model_miss.json');
	try { fs.unlinkSync(miss); } catch (e) { /* none */ }
	const scM = path.join(HOME, 'miss.json'), logM = path.join(HOME, 'miss.log');
	fs.writeFileSync(scM, JSON.stringify({ log: logM, R, runs: { '-1': [{ end: 'finish', idle: 5, layers: 3 }] }, beam: null }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 300, width: 1024 }, { available: true }, { tool: [process.execPath, fake, scM], cpu: false, salts: false, reach: { startCost: -1 } });
	let st = ED.state();
	for (const t0 = Date.now(); st.running && Date.now() - t0 < 45000; st = ED.state()) await new Promise((res) => setTimeout(res, 40));
	if (st.running) { ED.stop(); while (ED.state().running) await new Promise((res) => setTimeout(res, 40)); }
	const LM = fs.readFileSync(logM, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const mj = C.readJSON(miss, null);
	check('the physics check rules the start out: "every move" alone, without the prune, at most 60 s', st.strategies.map((q) => q.key).join() === 'explore' && st.seconds === 60 &&
		LM.length > 0 && LM.every((a) => a[0] === 'explore' && !a.includes('--prune=1')) && +LM[0].find((x) => x.startsWith('--seconds=')).slice(10) <= 60 && !!st.physics && st.physics.noWayUp,
		`${st.strategies.map((q) => q.key).join()}; ${st.seconds} s; ${LM.map((a) => `${a[0]} ${a.filter((x) => /^--(prune|seconds)=/.test(x)).join(' ')}`).join(' | ')}`);
	check('... and a route found anyway: a mistake in the model, kept in model_miss.json (the level and the route) and said in the log', st.stage === 'found' && !!mj && !!mj.eelvlB64 &&
		typeof mj.inputs === 'string' && mj.inputs.length > 0 && st.log.some((x) => /mistake in the physics model/.test(x)), `${st.stage}; model_miss.json ${mj ? 'written' : 'missing'}`);
	try { fs.unlinkSync(miss); } catch (e) { /* none */ }
}

// ---------------------------------------------------------------- the CPU route search (src/goexplore.js; no GPU)
/** runs src/goexplore.js on an .eelvl; feed(child) right after the spawn (its stdin stays open; what it writes waits
 *  in the pipe until the tool reads it, before its workers start). Resolves to its events, results, done event and
 *  summary line. */
function goexplore(file, opts, feed) {
	return new Promise((resolve) => {
		const ch = require('child_process').spawn(process.execPath, [path.join(SRC, 'goexplore.js'), file, ...opts], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		ch.stdin.on('error', () => { /* it ended */ });
		if (feed) feed(ch); else ch.stdin.end();
		let out = '', err = '';
		ch.stdout.on('data', (c) => { out += c; });
		ch.stderr.on('data', (c) => { err += c; });
		ch.on('close', (code) => {
			const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return { bad: l }; } });
			resolve({ code, err, events, results: events.filter((e) => e.ev === 'result'), done: events.find((e) => e.ev === 'done') || null,
				summary: out.split('\n').find((l) => l.startsWith('[goexplore]')) || err.slice(-300) });
		});
	});
}
async function cpuSection() {
	section('cpu: the CPU route search (src/goexplore.js, no GPU)');
	// its threads: N - 1 (at most the benchmark's fastest count), at most half while a job's optimizer runs (a status
	// "running" with a live pid: this process), a request as it is
	const n = os.cpus().length, w0 = ED.cpuWorkers();
	const fakeJob = path.join(C.JOBS, 'grind-test-000000');
	fs.mkdirSync(fakeJob, { recursive: true });
	fs.writeFileSync(path.join(fakeJob, 'meta.json'), '{}');
	fs.writeFileSync(path.join(fakeJob, 'status.json'), JSON.stringify({ state: 'running', pid: process.pid, updated: Date.now() }));
	const w1 = ED.cpuWorkers();
	fs.rmSync(fakeJob, { recursive: true, force: true });
	check('the CPU search\'s threads: N - 1, at most half while a job is optimizing, a request as it is', w0 >= 1 && w0 <= Math.max(1, n - 1) && w1 >= 1 &&
		w1 <= Math.max(1, Math.floor(n / 2)) && ED.cpuWorkers(3) === Math.min(n, 3), `${n} threads: ${w0}; with a job optimizing ${w1}`);
	const plat = room(40, 20);
	for (let x = 10; x <= 14; x++) plat.push([x, 16, 9]);
	for (let x = 18; x <= 22; x++) plat.push([x, 13, 9]);
	for (let x = 26; x <= 31; x++) plat.push([x, 10, 9]);
	plat.push([29, 9, 121], [2, 17, 255]);
	const platBuf = ED.eelvlOf({ name: 'platforms', width: 40, height: 20, cells: plat });
	const platFile = path.join(HOME, 'platforms.eelvl');
	fs.writeFileSync(platFile, platBuf);
	const platLevel = E.prepareLevel(EL.toSimLevel(EL.readEelvl(platBuf)));
	const replays = (level, rs) => rs.every((r) => { const ev = C.evaluate(level, Uint8Array.from(r.inputs, (c) => c.charCodeAt(0) - 48)); return ev && ev.ms.length === r.ticks && ev.runTicks === r.runTicks; });
	// one worker, a tick budget: every route replays, each faster than the one before; the same seed gives the same routes
	const a1 = await goexplore(platFile, ['--workers=1', '--seed=3', '--maxTicks=300000', '--seconds=40']);
	const a2 = await goexplore(platFile, ['--workers=1', '--seed=3', '--maxTicks=300000', '--seconds=40']);
	const sig = (r) => r.results.map((x) => `${x.ticks}@${x.simTicks}:${x.inputs}`).join('|');
	check('platforms, 1 thread, 300k ticks: routes, each faster than the last, all finishing in the JS engine (ticks and run time)',
		a1.results.length > 0 && replays(platLevel, a1.results) && a1.results.every((x, k) => !k || x.ticks < a1.results[k - 1].ticks) && a1.done && a1.done.end === 'ticks' &&
		a1.done.finish === a1.results[a1.results.length - 1].ticks, a1.summary);
	check('the same seed and tick budget: the same routes, found after the same number of ticks', sig(a1) !== '' && sig(a1) === sig(a2) && a1.done.ticks === a2.done.ticks,
		`${a1.results.map((x) => `${x.ticks}@${x.simTicks}`).join(' ')} vs ${a2.results.map((x) => `${x.ticks}@${x.simTicks}`).join(' ')}`);
	const a3 = await goexplore(platFile, ['--workers=1', '--seed=4', '--maxTicks=300000', '--seconds=40']);
	check('another seed: other runs', sig(a3) !== sig(a1), `${a3.results.map((x) => `${x.ticks}@${x.simTicks}`).join(' ')}`);
	// a snapshot budget of 64 (most picks rebuild their state by replaying inputs, from the parent's snapshot or the
	// start): exactly the same search, so the same routes in the same order (found after more simulated ticks)
	const m = await goexplore(platFile, ['--workers=1', '--seed=3', '--maxTicks=600000', '--seconds=40', '--maxSnaps=64']);
	const routes = (r) => r.results.map((x) => `${x.ticks}:${x.inputs}`);
	const mw = m.done && m.done.workers[0];
	check('64 snapshots at most (states rebuilt by replaying their inputs): the same routes in the same order, no failure',
		a1.results.length > 0 && routes(a1).every((x, k) => x === routes(m)[k]) && mw && mw.dropped > 0 && mw.replays > 0 && mw.snaps <= 64 && m.done.end === 'ticks' &&
		!m.events.some((e) => e.ev === 'warning'), `${m.results.map((x) => `${x.ticks}@${x.simTicks}`).join(' ')}; ${mw ? `${mw.dropped} dropped, ${mw.replays} replays` : ''}; ${m.summary}`);
	// two threads, stop at the first route
	const b = await goexplore(platFile, ['--workers=2', '--seed=5', '--first=1', '--seconds=30']);
	check('2 threads, --first=1: stops at the first route, which finishes in the JS engine', b.results.length >= 1 && replays(platLevel, b.results) && b.done && b.done.end === 'finish' &&
		b.done.workers.length === 2 && b.done.first && [5, 6].includes(b.done.first.seed), b.summary);
	// a depth below any route: no cell at or past it, no route
	const d = await goexplore(platFile, ['--workers=1', '--depth=20', '--maxTicks=200000', '--seconds=30']);
	check('--depth=20 (no route that short): no route, no situation kept at tick 20 or later', d.results.length === 0 && d.done && d.done.end === 'ticks' && d.done.finish === 0 &&
		d.done.layers < 20, `${d.summary}; deepest ${d.done && d.done.layers}`);
	// stdin: "depth" (written before the workers start) and "stop" (the editor's messages)
	const s1 = await goexplore(platFile, ['--workers=1', '--maxTicks=200000', '--seconds=30', '--stdin=1', '--seed=3'], (ch) => ch.stdin.write('depth 30\n'));
	const s2 = await goexplore(platFile, ['--workers=1', '--seconds=30', '--stdin=1', '--seed=3'], (ch) => setTimeout(() => ch.stdin.write('stop\n'), 600));
	check('stdin (the editor): "depth 30" (a route of 31 ticks known elsewhere) bounds the search; "stop" ends it',
		s1.done && s1.done.end === 'ticks' && s1.results.length === 0 && s1.done.layers < 30 && s2.done && s2.done.end === 'stopped' && s2.done.seconds < 10,
		`${s1.summary}; deepest ${s1.done && s1.done.layers} | ${s2.summary}`);
	const s3 = await goexplore(platFile, ['--workers=1', '--seconds=30', '--stdin=1', '--seed=3'], (ch) => setTimeout(() => ch.stdin.end(), 600));
	check('the end of stdin (the editor is gone): it stops, not after its 30 s', s3.done && s3.done.end === 'stopped' && s3.done.seconds < 10, s3.summary);
	// a trophy the reach field rules out: at once
	const hiCells = room(20, 10);
	for (let x = 8; x <= 12; x++) hiCells.push([x, 3, 9]);
	hiCells.push([10, 2, 121], [3, 8, 255]);
	const hiBuf = ED.eelvlOf({ name: 'way too high', width: 20, height: 10, cells: hiCells });
	const hiFile = path.join(HOME, 'toohigh.eelvl');
	fs.writeFileSync(hiFile, hiBuf);
	const u = await goexplore(hiFile, ['--workers=1', '--seconds=30']);
	check('a trophy the reach field rules out from the start: "unreachable" at once', u.done && u.done.end === 'unreachable' && u.results.length === 0 && u.done.seconds < 5, u.summary);

	// the editor without an NVIDIA GPU: the CPU search alone, with a note
	const waitDone = async (limit) => {
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < limit) { await new Promise((r) => setTimeout(r, 100)); st = ED.state(); }
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 50)); st = ED.state(); }
		return st;
	};
	let st0 = ED.start({ eelvlB64: platBuf.toString('base64'), seconds: 4, workers: 1 }, { available: false, why: 'test: no GPU' });
	check('no NVIDIA GPU: the search starts anyway, only the CPU strategy, with a note', st0.running && st0.strategies.length === 1 && st0.strategies[0].key === 'goexplore' &&
		st0.strategies[0].cpu && /no NVIDIA GPU is available \(test: no GPU\)/.test(st0.cpuOnly) && st0.log.some((x) => /CPU searches alone/.test(x)), JSON.stringify(st0.strategies.map((q) => q.key)));
	let st = await waitDone(20000);
	let ev = st.result ? C.evaluate(platLevel, Uint8Array.from(st.result.inputs, (c) => c.charCodeAt(0) - 48)) : null;
	check('no NVIDIA GPU: a route from the CPU search, verified, route.eetas', st.stage === 'found' && st.result.strategy === 'random runs (CPU)' && ev && ev.runTicks === st.result.runTicks &&
		!!ED.solveFile('route.eetas') && st.elapsed >= 3.5 && st.elapsed < 15, `${st.stage} ${st.result ? `${st.result.time} (${st.result.ticks} ticks) after ${st.result.foundAfter} s` : st.message}; ${st.elapsed.toFixed(1)} s`);
	const u0 = await goexplore(hiFile, ['--workers=1', '--seconds=2', '--prune=0']);
	check('--prune=0 (the editor\'s check of a level the field rules out): it searches, the ruled-out states behind (reach cost 1e4 + walking distance)', u0.done && u0.done.end === 'time' && u0.done.ticks > 0 &&
		u0.results.length === 0, u0.summary);
	ED.start({ eelvlB64: hiBuf.toString('base64'), seconds: 5, workers: 1 }, { available: false, why: 'test: no GPU' });
	st = await waitDone(20000);
	check('no NVIDIA GPU, a trophy out of reach: the random runs check it without the physics check (their time, at most a minute), then the physics verdict',
		st.stage === 'not found' && st.impossible && st.impossible.by === 'physics' && st.elapsed >= 4 && st.elapsed < 15 && st.log.some((x) => /checking that with random runs \(CPU\), without the physics check/.test(x)),
		`${st.elapsed.toFixed(1)} s: ${st.message}`);

	// next to the eegpu stand-in: the CPU's first route bounds the exploration's next pass, and the CPU search stops
	// when the GPU strategies have ended with a route
	const W = 30, H = 8;
	const buf = ED.eelvlOf({ name: 'ladder', width: W, height: H, cells: [...room(W, H), [2, 6, 255], [20, 6, 121]] });
	const level = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	const R = C.evaluate(level, new Uint8Array(300).fill(4)).ms.length;
	const fake = path.join(HOME, 'fake-eegpu-cpu.js');
	fs.writeFileSync(fake, FAKE);
	const sc = path.join(HOME, 'cpu-ladder.json'), log = path.join(HOME, 'cpu-ladder.log');
	// pass -1 reports a deep layer after 4 s (by then the CPU has a route: it is beaten), pass 0 finds the R-tick route
	fs.writeFileSync(sc, JSON.stringify({ log, R, runs: { '-1': [{ end: 'time', layers: 5000, wait: 4000, hold: 4000 }], 0: [{ end: 'finish', idle: 0, layers: 3 }] }, beam: null }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, sc], salts: false });
	st = await waitDone(45000);
	const L = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore')
		.map((a) => { const o = {}; for (const x of a) { const m = /^--(\w+)=(.*)$/.exec(x); if (m) o[m[1]] = m[2]; } return o; });
	const X = st.strategies.find((q) => q.key === 'explore'), Q = st.strategies.find((q) => q.cpu);
	const cpuRoute = st.log.map((x) => /random runs \(CPU\): route [\d:.]+ \((\d+) ticks\)/.exec(x)).find(Boolean);
	check('with the GPU strategies: the CPU\'s first route bounds the next pass (--depth = route - 1), "every move" then finds a faster one, and the CPU search stops with them',
		st.stage === 'found' && st.result.ticks === R && st.result.strategy === 'every move' && L.length >= 2 && L[0].depth === '100000' && cpuRoute && +L[1].depth <= +cpuRoute[1] - 1 &&
		+L[1].depth >= R && X.ends['-1'] && X.ends['-1'].how === 'beaten' && Q && Q.found && Q.found.ticks >= R && !Q.live && st.elapsed < 30,
		`${st.stage}; passes ${L.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join(', ')}; depth ${L.map((o) => o.depth).join(', ')}; CPU route ${cpuRoute ? cpuRoute[1] : '-'} ticks; ` +
		`${st.result ? `route ${st.result.ticks} ticks (${st.result.strategy}), R = ${R}` : st.message}; ${st.elapsed.toFixed(1)} s`);
	// Stop while the search still checks the physics / the GPU tool (the GPU's first load after an update can take
	// minutes; it once looked like a Stop button that did nothing): the search ends at once, a new one can start right
	// away, and the first check's late answer launches nothing
	const scSlow = path.join(HOME, 'cpu-slowinfo.json'), logSlow = path.join(HOME, 'cpu-slowinfo.log');
	fs.writeFileSync(scSlow, JSON.stringify({ log: logSlow, R, runs: { '-1': [{ end: 'finish', idle: 0, layers: 3 }] }, beam: null, infoDelay: 2500 }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, scSlow], salts: false });
	await new Promise((r) => setTimeout(r, 300));
	const tStop = Date.now(), stStop = ED.stop();
	const stoppedNow = !stStop.running && !ED.state().running && ED.state().stage === 'stopped';
	const scNext = path.join(HOME, 'cpu-afterstop.json'), logNext = path.join(HOME, 'cpu-afterstop.log');
	fs.writeFileSync(scNext, JSON.stringify({ log: logNext, R, runs: { '-1': [{ end: 'finish', idle: 0, layers: 3 }] }, beam: null }));
	let restartErr = '';
	try { ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, scNext], salts: false }); } catch (e) { restartErr = e.message; }
	st = await waitDone(30000);
	await new Promise((r) => setTimeout(r, Math.max(0, 3000 - (Date.now() - tStop))));   // (the first search's check has answered by now)
	const slowLaunched = fs.existsSync(logSlow) ? fs.readFileSync(logSlow, 'utf8').split('\n').filter(Boolean).length : 0;
	check('Stop during the physics / GPU tool check ends the search at once; a new search starts right away and the first check\'s late answer launches nothing',
		stoppedNow && !restartErr && st.stage === 'found' && !ED.state().running && slowLaunched === 0 && ED.state().stage === 'found',
		`stopped at once: ${stoppedNow}; restart ${restartErr || 'ok'}; next: ${st.stage}; the stopped search's launches: ${slowLaunched}`);
	// a native tool older than the app (its `info` does not say it reads this reach file version): no GPU strategy, the
	// CPU search alone, with the reason
	const scOld = path.join(HOME, 'cpu-old.json');
	fs.writeFileSync(scOld, JSON.stringify({ log: path.join(HOME, 'cpu-old.log'), R, runs: {}, beam: null, reach: 2 }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 3, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, scOld], salts: false });
	st = await waitDone(20000);
	check('a native tool older than the app: the GPU strategies do not start; the CPU searches alone and says why', st.strategies.map((q) => q.key).join() === 'goexplore' &&
		/the search tool is older than the app: rebuild it/.test(st.cpuOnly) && st.stage === 'found', `${st.strategies.map((q) => q.key).join()}; ${st.cpuOnly.slice(0, 120)}`);
	// the GPU strategies fail after the CPU's first route: the CPU search is then the whole search and goes on until the
	// time is up (it is not stopped "with them")
	const sc2 = path.join(HOME, 'cpu-fail.json');
	fs.writeFileSync(sc2, JSON.stringify({ log: path.join(HOME, 'cpu-fail.log'), R, runs: {}, beam: null, fail: 3000 }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 7, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, sc2], salts: false });
	st = await waitDone(30000);
	const gpuStates = st.strategies.filter((q) => !q.cpu).map((q) => q.state);
	// (the strategies start after the physics check: the CPU's route before the stand-in's failure 3 s after its launch)
	const launched = (Math.min(...st.strategies.map((q) => q.launchedAt || Infinity)) - st.started) / 1000;
	check('the GPU strategies fail after the CPU\'s first route: the CPU search goes on until the time is up', st.stage === 'found' && st.result.strategy === 'random runs (CPU)' &&
		st.result.foundAfter < 3 + launched && gpuStates.length === 2 && gpuStates.every((s) => s === 'error') && st.elapsed >= 6.5,
		`${st.stage}; GPU strategies ${gpuStates.join(', ')}; ${st.result ? `route ${st.result.ticks} ticks after ${st.result.foundAfter} s (${st.result.strategy})` : st.message}; ${st.elapsed.toFixed(1)} s`);
	// a GPU strategy's kernel launch fails (eegpu's launchError line, exit 7: the display driver's watchdog; the driver may
	// have reset the GPU): the other GPU strategies are asked to stop (their stop files: never a kill mid-kernel), none
	// starts again (no next pass), and the CPU search goes on until the time is up
	const sc3 = path.join(HOME, 'cpu-launchfail.json'), log3 = path.join(HOME, 'cpu-launchfail.log');
	fs.writeFileSync(sc3, JSON.stringify({ log: log3, R, runs: {}, beam: null, launchFail: 1500 }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 6, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, sc3], salts: false });
	st = await waitDone(30000);
	const L3 = fs.readFileSync(log3, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const X3 = st.strategies.find((q) => q.key === 'explore'), B3 = st.strategies.filter((q) => !q.cpu && q.key !== 'explore');
	// (the two start together: either may log first)
	const launches3 = L3.filter((a) => a[0] !== 'stopped').map((a) => a[0]), stopped3 = L3.filter((a) => a[0] === 'stopped').map((a) => a[1]);
	check('a GPU launch failure (the driver\'s watchdog, exit 7): the other GPU strategies stop through their stop files, none starts again, the CPU search goes on',
		X3.state === 'error' && /stopped the explore/.test(X3.error || '') && B3.length === 1 && B3.every((q) => q.state === 'stopped' && q.detail === 'the GPU failed') &&
		launches3.slice().sort().join() === 'beam,explore' && stopped3.join() === 'beam' && st.log.some((x) => /the GPU failed: the GPU searches stop \(the CPU search goes on\)/.test(x)) &&
		st.stage === 'found' && st.result.strategy === 'random runs (CPU)' && st.elapsed >= 5.5,
		`explore ${X3.state} (${X3.error}); beams ${B3.map((q) => `${q.state} (${q.detail})`).join(', ')}; launches ${launches3.join(', ')}; stopped by file: ${stopped3.join(', ') || '-'}; ` +
		`${st.stage} ${st.result ? `(${st.result.strategy})` : ''}; ${st.elapsed.toFixed(1)} s`);
}

// ---------------------------------------------------------------- GPU searches (--gpu)
/** one route search on a level; the route replayed in the JS engine. test: ED.start's test options ({cpu: false}: the
 *  GPU strategies alone) */
async function solve(name, W, H, cells, seconds, test) {
	if (GPU_ONLY.length && !GPU_ONLY.some((k) => name.includes(k))) return null;
	const buf = W === 'eelvl' ? H : ED.eelvlOf({ name, width: W, height: H, cells });
	// (the CPU search runs next to the GPU's, as in the app, on one thread here)
	ED.start({ eelvlB64: buf.toString('base64'), seconds, width: 16384, workers: 1 }, { available: true }, test);
	const t0 = Date.now();
	let st = ED.state();
	while (st.running && Date.now() - t0 < (seconds + 30) * 1000) { await new Promise((r) => setTimeout(r, 500)); st = ED.state(); }
	if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 200)); }
	const ok = st.stage === 'found' && st.result;
	const ev = ok ? C.evaluate(E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))), Uint8Array.from(st.result.inputs, (c) => c.charCodeAt(0) - 48)) : null;
	const text = ok ? `${st.result.time} (${st.result.ticks} ticks, ${st.result.strategy}) in ${st.result.foundAfter} s` : `${st.stage}: ${st.message}`;
	return { ok: !!(ok && ev && ev.runTicks === st.result.runTicks), st, ev, text };
}
async function gpuSection() {
	section('gpu: route searches (at most 60 s each: a hot laptop GPU throttles hard)');
	const G = require('../src/gpu.js');
	if (!G.nativeTool()) { check('the GPU engine is built (node tools/build-native.js)', false); return; }
	let cells, r;
	// platforms up to a ledge
	cells = room(40, 20);
	for (let x = 10; x <= 14; x++) cells.push([x, 16, 9]);
	for (let x = 18; x <= 22; x++) cells.push([x, 13, 9]);
	for (let x = 26; x <= 31; x++) cells.push([x, 10, 9]);
	cells.push([29, 9, 121], [2, 17, 255]);
	r = await solve('gpu test', 40, 20, cells, 60);
	if (r) check('platforms: a route to the trophy, and it finishes in the JS engine', r.ok, r.text);
	// a time door (156) between the start and the trophy: shut for the first 5 s, so the route has to wait for it
	cells = room(20, 8);
	for (let y = 1; y <= 5; y++) cells.push([12, y, 9]);
	cells.push([12, 6, 156], [17, 6, 121], [2, 6, 255]);
	r = await solve('time door', 20, 8, cells, 60);
	if (r) check('a time door: the route waits for it (finishes after tick 500) and finishes in the JS engine', r.ok && r.ev.complete >= 500, r.text);
	// a coin door (43, 1 coin) in front of the trophy and the coin behind the start: away from the trophy first
	cells = room(24, 8);
	for (let y = 1; y <= 5; y++) cells.push([16, y, 9]);
	cells.push([16, 6, 43, 1], [21, 6, 121], [8, 6, 255], [2, 6, 100]);
	r = await solve('coin door', 24, 8, cells, 60);
	if (r) check('a coin door: the route takes the coin behind the start first, and finishes in the JS engine', r.ok && r.ev.coins >= 1, r.text);
	// the trophy sealed off behind a wall, reachable only through a portal pair (no guide line)
	cells = room(20, 8);
	for (let y = 1; y <= 6; y++) cells.push([13, y, 9]);
	cells.push([8, 6, 242, 0, 1, 2], [15, 6, 242, 0, 2, 1], [17, 6, 121], [2, 6, 255]);
	r = await solve('portal', 20, 8, cells, 60);
	if (r) check('a portal: the route goes through it without a guide line, and finishes in the JS engine', r.ok, r.text);
	// the trophy above a spike, reached by a 37-row fall: the tick that takes the trophy starts on it and ends over the
	// spike, where the reach field rules the ball out; "every move" must still count that finish (its finish test comes
	// before the prune), not only a beam (without the CPU search: its route, a plain fall, would come first and bound
	// "every move" to faster ones, so it would never report its own)
	cells = room(9, 44);
	cells.push([4, 1, 255], [4, 38, 121], [4, 39, 361, 1]);
	r = await solve('trophy over a spike', 9, 44, cells, 30, { cpu: false });
	if (r) {
		const XF = r.st.strategies.find((q) => q.key === 'explore');
		check('a trophy above a spike after a long fall: "every move" finds the route too, and it finishes in the JS engine', r.ok && !!(XF && XF.found),
			`${r.text}; every move: ${XF ? `${XF.state}${XF.found ? ` ${XF.found.time}` : ''}` : 'none'}`);
	}
	// no route, proven: the trophy on a ledge two tiles above any jump (the physics check finds no way up); "every move"
	// and the random runs check it without the physics check (only they run), and the verdict says where the ball gets
	cells = room(20, 10);
	for (let x = 8; x <= 12; x++) cells.push([x, 3, 9]);
	cells.push([10, 2, 121], [3, 8, 255]);
	r = await solve('way too high', 20, 10, cells, 10);
	if (r) {
		check('no route, proven: the physics check finds no way up, and the verdict says so (with the highest row the ball gets to)', !r.st.result && r.st.stage === 'not found' && r.st.impossible && r.st.impossible.by === 'physics' &&
			/cannot be reached/.test(r.st.message) && /no higher than row 4; the trophy is in row 2/.test(r.st.message), r.st.message);
		check('... "every move" and the random runs only, without the prune (a route there would be a model bug)', ['explore', 'explore,goexplore'].includes(r.st.strategies.map((q) => q.key).join()) &&
			!r.st.log.some((x) => /mistake in the physics model/.test(x)),
			r.st.strategies.map((q) => `${q.key} ${q.state}`).join(', '));
	}
	// no route, not provable by the model (a spike pit 27 tiles wide: far beyond any jump, but the model lets a ball drift
	// sideways as far as it likes): the closest attempt is kept
	cells = room(36, 10);
	for (let x = 5; x <= 31; x++) cells.push([x, 8, 361]);
	cells.push([33, 8, 121], [2, 8, 255]);
	r = await solve('pit too wide', 36, 10, cells, 10);
	if (r) {
		const cl = r.st.closest;
		check('no route: "not found", with the closest attempt (its distance, path, closest.eetas)', !r.st.result && r.st.stage === 'not found' && !r.st.impossible && cl && cl.tiles > 0 && cl.tiles < 40 &&
			cl.path.length === cl.ticks + 1 && !!ED.solveFile('closest.eetas'), cl ? `${cl.tiles} tiles at tick ${cl.ticks} (${cl.strategy})${cl.cut ? ', cut' : ''}; ${r.st.message.slice(0, 120)}` : `${r.st.stage}: no closest attempt`);
	}
	// the user's 50x50 shaft level (no route: every state runs out by tick 185 at 2 px cells; the physics check cannot
	// prove it, the pocket needs a 17 px sideways move inside one row): "every move" runs out of situations, the beams
	// give it the GPU (halted), and the verdict is "No route found" (evidence, not "impossible")
	r = await solve('user50', 'eelvl', Buffer.from(USER50, 'base64'), null, 40, { cpu: false });
	if (r) {
		const X = r.st.strategies.find((q) => q.key === 'explore'), beams = r.st.strategies.filter((q) => q.key === 'goal' || q.key === 'guide');
		check('user50: no route, "every move" ran out of situations, the beams halted for its tries, not called impossible', !r.st.result && r.st.stage === 'not found' && !r.st.impossible &&
			X && X.exhausted && /ran out of new situations/.test(r.st.message) && beams.length > 0 && beams.every((q) => q.state === 'stopped'),
			`${r.st.stage}; ${r.st.strategies.map((q) => `${q.key} ${q.state}`).join(', ')}; ${r.st.message.slice(0, 160)}`);
	}
}
const USER50 = 'xZTZTsJAFIY/wA3FBcUNxRYo++4LeGG8MPEBjHdGS2KCkJio8c431/yVQqc1xMSI82XaOefMxXxnmpIYjp5JX1zb50/uq31559pX7os7AE41z97hA2PESD3e3rv2qN8fPAxdIPlViN941TgJFlhkiWVWSLLKGinW2WCTLdJss0OGXfbY54BDshxxTI4TLGzyFCjiUKJMhSo16jRo0qJNhy49+Lc5PZsindVfmW/LWPn7c1iTtensZ2d1JrgnG4qsmXEGy4ii9d9n5nDr3tf19yPmuchGPjKSk6zkJTO5yU5+MpSjLOUpU7nKVr4ylrOs5S1zucte/uqAeqAuBLEn5McUxhQnOAFKAcrfUvkBVYNaiHqIhkEzQitCO0InQjdCbw7A2/j+4zjes8j0x+fnGp8=';

(async () => {
	roundtripSection();
	checksSection();
	await physicsCheckSection();
	await appSection();
	await passesSection();
	await cpuSection();
	if (GPU) await gpuSection();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
