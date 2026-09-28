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
//              situations" verdict only from pass 0 or finer with no layer cut, a beam's route bounding the exploration;
//              the relay's plan (with a stand-in for the CPU search that reports sources: the nearest attempt 60 / 150 /
//              400 back, the newest source, the source with territory gain, 1000 back, the larger table, the next salt); the
//              steer field on a key level: an explore that cannot use the steer file ({"error":...,"steer":0}) runs again
//              at once without it, the beams keep theirs
//   cpu        the CPU route search (src/goexplore.js, no GPU; one or two threads, a few seconds): routes replayed in the
//              JS engine, the same seed and tick budget give the same routes (also with 64 snapshots, states rebuilt by
//              replaying), --first, --depth, "stop" and the end of stdin; coarse cells (--cells=auto above 50 x 50, the
//              memory rule, the same routes for the same seed, the first route pinned to the research prototype's, the
//              key room's source event, no rooms once the archive is full, the editor keeping the sources); the editor
//              without an NVIDIA GPU (the CPU search alone, with a note; a route; the physics verdict), and next to the
//              eegpu stand-in (its first route bounds the exploration's next pass, it stops when the GPU strategies have
//              ended with a route, not when they failed)
//   prove      the proof next to the searches (eegpu prove: the native tool, CPU only; no GPU; skipped without a build that
//              knows prove): user50 with its left run-up 2 tiles shorter (the physics check finds a way, the proof none, with
//              the editor's reach file: "No route (proven)" with its explanation), user50 itself never "impossible", the
//              cached proof and the search capped at NO_WAY_UP_S; with stand-ins: a route on a level the proof rules out
//              (model_miss.json), a failing proof, a search that waits for a slow proof (no busy file meanwhile), every
//              strategy failing (the error at once), a silent proof (the watchdog), the cache (time limits not kept, memory
//              limits kept), the CPU search stopping with the GPU strategies while the proof runs. Elsewhere EEAT_PROOF=0.
//   lane       the path skips (src/skipfind.js --lane=1, the real one) next to a stand-in CPU search: a shortened attempt
//              into the CPU search's archive before any route, a faster route from its slow route after
//   gpu        (--gpu) short route searches on the GPU (at most 60 s each), verified in the JS engine
// usage: node test/editor.js [--gpu] [--seed=N] [--only=app,passes,cpu,prove,lane,gpu]      Exit code 1 if any check
//        fails. Writes nothing inside the repo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const argv = process.argv.slice(2);
const GPU = argv.includes('--gpu');
// --gpuOnly=a,b: only the GPU cases whose names contain one of these (short GPU runs, one at a time)
const GPU_ONLY = ((argv.find((a) => a.startsWith('--gpuOnly=')) || '').slice(10)).split(',').filter(Boolean);
const SEED = +((argv.find((a) => a.startsWith('--seed=')) || '--seed=1').slice(7));
// --only=a,b: only the sections whose names are given (app, passes, cpu, prove, lane, gpu); the fast ones always run
const ONLY = ((argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-editor-'));
process.env.EEAT_HOME = HOME;   // (before src/ is required: jobs and data go to the temp folder)
process.env.EEAT_PROOF = '0';   // (the proof, eegpu prove, only where the prove section asks for it: not next to the stand-ins)
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
		check('POST /api/editor/solve without a GPU: the CPU search alone (and the precision stage, a CPU strategy waiting for a stall), with the reason', r.status === 200 && r.json.running && r.json.strategies.map((q) => q.key).join() === 'goexplore,precision' &&
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
// (its launchError line, exit 7), and the beams run until their --stopfile appears, then end "stopped" (logged). A run's
// `closest` ({dist, tick, ch}) reports a nearest attempt of `tick` inputs `ch` ('4': right). A relay's --prefix is logged
// with its launch: "#pf=<length>:<first input>".
const FAKE = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a === undefined ? undefined : a.slice(k.length + 3); };
if (args[0] === 'info') return void setTimeout(() => process.stdout.write(JSON.stringify({ gpu: { name: 'fake' }, reach: SC.reach === undefined ? 3 : SC.reach, steer: SC.steer || 0 }) + '\\n'), SC.infoDelay || 0);
const passOf =(a) => Math.round(Math.log2(+a.find((x) => x.startsWith('--cqx=')).slice(6) / 0.5));
const prev = fs.existsSync(SC.log) ? fs.readFileSync(SC.log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
// (a relay's --prefix: its length and first input logged with the launch, as "#pf=<length>:<first>")
const pfx = opt('prefix'), pfs = pfx && fs.existsSync(pfx) ? fs.readFileSync(pfx, 'latin1') : null;
fs.appendFileSync(SC.log, JSON.stringify(pfs === null ? args : args.concat(['#pf=' + pfs.length + ':' + pfs.slice(0, 1)])) + '\\n');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (SC.fail) return void setTimeout(() => { say({ error: 'test: the GPU failed' }); process.exit(1); }, SC.fail);
// (oom: the first oom launches of each command find no GPU memory for a context, as next to another process holding it)
if (SC.oom && prev.filter((a) => a[0] === args[0]).length < SC.oom) return void setTimeout(() => { say({ error: 'cuCtxSetLimit(0 , stackBytes) failed: CUDA error 2 (out of memory)' }); process.exit(4); }, 50);
// (steerFail: an explore given --steer cannot use it, as eegpu says when the upload finds no GPU memory)
if (SC.steerFail && args[0] === 'explore' && opt('steer')) return void setTimeout(() => { say({ error: 'the steer field cannot be used: test: out of memory', steer: 0 }); process.exit(3); }, 50);
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
	const isBrk = (a) => a.includes('--cap=2097152');   // (the wall breaker's runs: SC.breaker)
	const relayN = prev.filter((a) => a[0] === 'explore' && a.some((x) => x.startsWith('--prefix=')) && !isBrk(a)).length;
	const brkN = prev.filter((a) => a[0] === 'explore' && isBrk(a)).length;
	const run = isBrk(args) ? ((SC.breaker || [])[brkN] || { end: 'time', layers: 1 }) : opt('prefix') ? ((SC.relay || [])[relayN] || { end: 'exhausted', layers: 1, overflow: 0 }) : (SC.runs[p] || [])[k] || { end: 'exhausted', layers: 1, overflow: 0 };
	const depth = +opt('depth');
	if (run.error) return void setTimeout(() => { say({ error: run.error }); process.exit(3); }, run.wait || 0);   // (a run that fails: "the prefix dies")
	const done = () => { const d = { ev: 'done', gpu: { name: 'fake' }, layers: run.layers, end: run.end }; if (run.overflow !== undefined) d.overflow = run.overflow; if (run.lanes) d.lanes = run.lanes; if (run.lastSalt !== undefined) d.salt = run.lastSalt; say(d); };
	setTimeout(() => {
		if (run.lanes) say({ ev: 'lanes', lanes: run.lanes, from: +opt('lanes') || 1, why: 'full', layers: run.layers });   // (--lanes: its batch filled the table)
		if (run.refine) say(Object.assign({ ev: 'refine' }, run.refine));   // (--refine: this try ran out, the next is refined)
		if (run.try) say(Object.assign({ ev: 'try' }, run.try));   // (--salts: a try ran through)
		if (run.closest) say({ ev: 'closest', dist: run.closest.dist, tick: run.closest.tick, inputs: (run.closest.ch || '4').repeat(run.closest.tick) });   // (the nearest attempt so far)
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
// A stand-in for the CPU search (src/goexplore.js): after `wait` ms it prints the scenario's source events (the relay's
// starting points), then progress lines until "stop" or the end of its stdin.
const FAKE_CPU = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'coarse', startCost: 40 });
setTimeout(() => { for (const s of SC.sources || []) say(Object.assign({ ev: 'source', seed: 1 }, s)); }, SC.wait || 0);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 40, found: 0, refined: 0, rooms: 3, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (SC.stdinLog) fs.appendFileSync(SC.stdinLog, String(d)); if (/stop/.test(String(d))) end(); });
process.stdin.on('end', end);
`;
// A stand-in for the GPU random runs (src/goexplore.js --gpu=1): logs its arguments, says ready and start, after `wait` ms
// reports the scenario's route, then progress lines until its --stopfile appears (logged "stopped"); what comes on its
// stdin is logged.
const FAKE_ROLLS = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a === undefined ? undefined : a.slice(k.length + 3); };
const log = (x) => fs.appendFileSync(SC.log, JSON.stringify(x) + '\\n');
log(args);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'ready', loadMs: 1, allocMs: 1 });
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'coarse', gpu: 'fake', startCost: 40 });
setTimeout(() => say({ ev: 'result', kind: 'finish', ticks: SC.route.length, inputs: SC.route }), SC.wait || 0);
const sf = opt('stopfile');
const iv = setInterval(() => {
	if (sf && fs.existsSync(sf)) { clearInterval(iv); log(['stopped']); say({ ev: 'done', layers: 5, end: 'stopped', finish: SC.route.length }); process.exit(0); }
	say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 40, found: 0, refined: 0, rooms: 1, workers: 1, gpu: true });
}, 100);
process.stdin.on('data', (d) => log(['stdin', String(d)]));
process.stdin.on('end', () => log(['stdin end']));
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
	// the relay's plan: a run that ran out of situations (however deep: 500 ticks) goes on from the same point with the next
	// finer cells (1/4 px/tick speeds, then 1/16), then further back; with its plan used up (the attempt is too short to go
	// further back) it starts over with the next salt instead of waiting; every run has its cost ceiling
	{
		const scR = path.join(HOME, 'relay2.json'), logR = path.join(HOME, 'relay2.log');
		const ex = { end: 'exhausted', layers: 500, overflow: 0 };
		fs.writeFileSync(scR, JSON.stringify({ log: logR, R, runs: { '-1': [{ end: 'time', layers: 5000, wait: 200, hold: 20000, closest: { dist: 30, tick: 150 } }] },
			relay: [ex, ex, ex, ex, ex, { end: 'finish', idle: 0, layers: 3 }], beam: null }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024 }, { available: true }, { tool: [process.execPath, fake, scR], cpu: false, salts: true, relay: true });
		const t0r = Date.now();
		let str = ED.state();
		while (str.running && !str.result && Date.now() - t0r < 30000) { await new Promise((z) => setTimeout(z, 100)); str = ED.state(); }
		if (str.running) { ED.stop(); while (ED.state().running) await new Promise((z) => setTimeout(z, 50)); }
		const LR = fs.readFileSync(logR, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore' && a.some((x) => x.startsWith('--prefix=')));
		const runs = LR.map((a) => {
			const o = Object.fromEntries(a.filter((x) => /^--\w+=/.test(x)).map((x) => x.slice(2).split('=')));
			return `${o.cqx}/${o.cqv}${o.salt ? ` salt ${o.salt}` : ''}${o.costslack ? '' : ' no ceiling'}`;
		});
		const want = ['0.5/4', '0.125/16', '0.25/16', '0.5/16', '0.5/4 salt 1', '0.125/16 salt 1'];
		check('the relay\'s plan: out of situations 500 ticks deep, finer cells from the same point (1/4 then 1/16 px/tick speeds); the plan used up, the next salt (no waiting); a cost ceiling on every run',
			JSON.stringify(runs) === JSON.stringify(want) && str.result && str.result.strategy === 'from the nearest attempt', `runs ${runs.join(' | ')}; ${str.result ? `route by ${str.result.strategy}` : str.stage}`);
	}
	// the relay's sources (RELAY_PLAN): the nearest attempt (1200 idle ticks, every move's) 60, 150 and 400 ticks back; then
	// the newest source not relayed from yet, from where it entered its room (the CPU search's room 333: 500 inputs '1');
	// then the source with territory gain relayed from least (room 111, gain 40: its lowest-cost attempt, 300 inputs '2',
	// 60 back; room 333 has been relayed from, room 222 has no gain, every move's own room is the nearest attempt itself);
	// then the nearest attempt 1000 back (2000: too near the start), the larger table (400 back, no cost ceiling), and the
	// next salt from the top. Every relay run fills its table (no finer cells from the same point).
	{
		const scR = path.join(HOME, 'relay3.json'), logR = path.join(HOME, 'relay3.log'), scC = path.join(HOME, 'relay3cpu.json'), fakeCpu = path.join(HOME, 'fake-cpu.js');
		fs.writeFileSync(fakeCpu, FAKE_CPU);
		fs.writeFileSync(scR, JSON.stringify({ log: logR, R, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0, closest: { dist: 30, tick: 1200, ch: '0' } }] },
			relay: Array.from({ length: 12 }, () => ({ end: 'full', layers: 50 })), beam: null }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100, sources: [
			{ kind: 'room', room: 111, desc: 'key:red', gain: 40, tick: 300, dist: 50, inputs: '2'.repeat(300) },
			{ kind: 'room', room: 222, desc: 'key:green', gain: 0, tick: 400, dist: 45, inputs: '8'.repeat(400) },
			{ kind: 'room', room: 333, desc: 'key:blue', gain: 25, tick: 500, dist: 60, inputs: '1'.repeat(500) }] }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scR], cpu: [process.execPath, fakeCpu, scC], salts: false, relay: true });
		const relayRuns = () => (fs.existsSync(logR) ? fs.readFileSync(logR, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore' && a.some((x) => x.startsWith('--prefix='))) : []);
		const t0r = Date.now();
		while (ED.state().running && relayRuns().length < 8 && Date.now() - t0r < 40000) await new Promise((z) => setTimeout(z, 100));
		const str = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		const runs = relayRuns().slice(0, 8).map((a) => {
			const o = Object.fromEntries(a.filter((x) => /^--\w+=/.test(x)).map((x) => x.slice(2).split('=')));
			return `${(a.find((x) => x.startsWith('#pf=')) || '#pf=?').slice(4)}${o.costslack ? '' : ' no ceiling'}${o.salt ? ` salt ${o.salt}` : ''}`;
		});
		const want = ['1140:0', '1050:0', '800:0', '500:1', '240:2', '200:0', '800:0 no ceiling', '1140:0 salt 1'];
		const so = (str.sources || []).map((s) => `${s.desc}:${s.runs}`).sort().join(', ');
		check('the relay goes through its sources in order: the nearest attempt 60 / 150 / 400 back, the newest source not relayed from (from its room\'s entry), ' +
			'the source with territory gain relayed from least, 1000 back, the larger table, the next salt',
			JSON.stringify(runs) === JSON.stringify(want) && (str.sources || []).length === 4 && /key:blue:1/.test(so) && /key:red:1/.test(so) && /key:green:0/.test(so),
			`runs ${runs.join(' | ')}; sources ${so}`);
	}
	// the wall breaker (strategy 'breaker'; clocks shortened: a round after 1 s without progress, a 2^26 table): every move's
	// nearest attempt (600 ticks) stalls, the relay's runs fill their tables and get no nearer, the CPU search reports
	// nothing: a round from the nearest attempt 150 ticks back (450; 400 back is 200); its run has the GPU (the others
	// paused), 4 px / 1/16 px/tick cells, the whole table, the layer cap, a box around its start (2^26 <= 2^28), no cost
	// ceiling; its nearer attempt (800 ticks) is the next step's start 60 ticks short (740) and the CPU search's seed; that
	// step runs out of situations: finer cells (2 px) from the same start, whose finish is the route
	{
		const scB = path.join(HOME, 'brk.json'), logB = path.join(HOME, 'brk.log'), scC = path.join(HOME, 'brkcpu.json'), fakeCpu = path.join(HOME, 'fake-cpu.js'), inB = path.join(HOME, 'brk-stdin.log');
		fs.writeFileSync(fakeCpu, FAKE_CPU);
		fs.writeFileSync(scB, JSON.stringify({ log: logB, R, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0, closest: { dist: 30, tick: 600, ch: '0' } }] },
			relay: Array.from({ length: 40 }, () => ({ end: 'full', layers: 50, wait: 300 })),
			breaker: [{ end: 'time', layers: 700, wait: 300, closest: { dist: 20, tick: 800, ch: '4' } }, { end: 'exhausted', layers: 10, overflow: 0, wait: 300 }, { end: 'finish', idle: 0, layers: 3, wait: 300 }],
			beam: null }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100, stdinLog: inB }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scB], cpu: [process.execPath, fakeCpu, scC], salts: false, relay: true, breaker: true, breakWait: [1, 2, 4], breakCells: 26 });
		const t0b = Date.now();
		let str = ED.state(), turn = false;
		while (str.running && !str.result && Date.now() - t0b < 40000) { await new Promise((z) => setTimeout(z, 100)); str = ED.state(); if (str.gpuTurn === 'breaker') turn = true; }
		if (str.running) { ED.stop(); while (ED.state().running) await new Promise((z) => setTimeout(z, 50)); }
		const LA = fs.readFileSync(logB, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore');
		const LB = LA.filter((a) => a.includes('--cap=2097152'));
		// (while its round runs no other GPU process starts: the relay's next run waits for the round's end)
		const b0 = LA.findIndex((a) => a.includes('--cap=2097152')), b1 = LA.length - 1 - [...LA].reverse().findIndex((a) => a.includes('--cap=2097152'));
		const between = b0 >= 0 ? LA.slice(b0, b1 + 1).filter((a) => !a.includes('--cap=2097152')).length : -1;
		const opts = LB.map((a) => Object.fromEntries(a.filter((x) => /^--\w+=/.test(x)).map((x) => x.slice(2).split('='))));
		const pfs = LB.map((a) => (a.find((x) => x.startsWith('#pf=')) || '#pf=?').slice(4));
		const cells = opts.map((o) => `${o.cqx}/${o.cqv}/${o.qy}/${o.qvy}`);
		const seeds = fs.existsSync(inB) ? fs.readFileSync(inB, 'utf8').split('\n').filter((l) => l.startsWith('seed ')) : [];
		const logged = (str.log || []).join('\n');
		check('the wall breaker: a stalled search starts a round from the nearest attempt 150 ticks back with the GPU to itself (4 px / 1/16 px/tick cells, the whole table, ' +
			'the 2M layer cap, room left for others, a box around its start, no cost ceiling; no other GPU process starts meanwhile); its nearer attempt is the next step\'s start 60 ticks short and the CPU search\'s seed; ' +
			'out of situations: finer cells from the same start; its finish is the route',
			LB.length === 3 && pfs.join() === '450:0,740:4,740:4' && cells.join() === '0.25/16/0.25/16,0.25/16/0.25/16,0.5/16/0.5/16' &&
			opts.every((o) => o.cells === '26' && o.cap === '2097152' && +o.reserve >= 1024 && !o.costslack && /^-?\d+,-?\d+,\d+,\d+$/.test(o.region || '')) && turn && between === 0 &&
			seeds.some((l) => l === 'seed ' + '4'.repeat(800)) && /round 1, 2 starting points/.test(logged) && str.result && str.result.strategy === 'past the wall' &&
			!!str.breaker && str.breaker.rounds === 1,
			`breaker runs ${LB.length}: prefixes ${pfs.join(' | ')}, cells ${cells.join(' | ')}, opts ${JSON.stringify(opts.map((o) => [o.cells, o.cap, o.costslack || '-', o.region || '-']))}; ` +
			`GPU turn seen ${turn}; other launches during the round ${between}; seeds ${seeds.map((l) => l.length - 5).join(',')}; ${str.result ? `route by ${str.result.strategy}` : str.stage}; breaker ${JSON.stringify(str.breaker)}`);
	}
	// a breaker run that fails ("the prefix dies"): the round goes on from its next starting point (the nearest attempt 400
	// back: 200 ticks), whose finish is the route; no CPU search: while every move and the relay wait for the round and
	// the breaker has not started yet no process runs, and the search must not end there
	{
		const scB = path.join(HOME, 'brk2.json'), logB = path.join(HOME, 'brk2.log'), scC = path.join(HOME, 'brk2cpu.json'), fakeCpu = path.join(HOME, 'fake-cpu.js');
		fs.writeFileSync(fakeCpu, FAKE_CPU);
		fs.writeFileSync(scB, JSON.stringify({ log: logB, R, runs: { '-1': [{ end: 'time', layers: 5000, wait: 200, hold: 30000, closest: { dist: 30, tick: 600, ch: '0' } }] },
			relay: Array.from({ length: 40 }, () => ({ end: 'full', layers: 50, wait: 300 })),
			breaker: [{ error: 'the prefix dies', wait: 200 }, { end: 'finish', idle: 0, layers: 3, wait: 300 }], beam: null }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100 }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scB], cpu: false, salts: false, relay: true, breaker: true, breakWait: [1], breakCells: 26 });
		const t0b = Date.now();
		let str = ED.state();
		while (str.running && !str.result && Date.now() - t0b < 40000) { await new Promise((z) => setTimeout(z, 100)); str = ED.state(); }
		if (str.running) { ED.stop(); while (ED.state().running) await new Promise((z) => setTimeout(z, 50)); }
		const pfs = fs.readFileSync(logB, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore' && a.includes('--cap=2097152'))
			.map((a) => (a.find((x) => x.startsWith('#pf=')) || '#pf=?').slice(4));
		check('the wall breaker: a run that fails ("the prefix dies") is not an error of the search: the round goes on from its next starting point, whose finish is the route',
			pfs.join() === '450:0,200:0' && str.result && str.result.strategy === 'past the wall', `prefixes ${pfs.join(' | ')}; ${str.result ? `route by ${str.result.strategy}` : str.stage}`);
	}
	// the table by the GPU's memory (BREAK_MEM_F at 16 bytes a cell): 8 GB 2^27, 24 GB 2^29, 40 GB 2^30, 80 GB 2^31
	check("the wall breaker's table: 2^27 cells on 8 GB, 2^29 on 24 GB, 2^30 on 40 GB (40,326 MB), 2^31 on 80 GB (81,559 MB)",
		[8192, 24564, 40326, 81559].map(ED.breakCells).join() === '27,29,30,31', [8192, 24564, 40326, 81559].map(ED.breakCells).join());
	// the one search's bursts by the GPU's memory (burstBig): the laptop sizing below 20 GB, 2 lanes of 2^26 cells with the
	// settings' own caps from 20 GB; the gated share (breakShare): the bursts go on beside a breaker round only on such a GPU
	// and only once a run of the round got no gate and no progress of its own (a run that got on closes it again)
	{
		const sz = [8192, 16384, 24564, 40326, 81559].map((mb) => ED.burstSizeArgs(mb).join(' ') || '-');
		const on = { breakShare: true }, off = { breakShare: false };
		const open = [
			ED.breakShareOpen(on, 40326, { dry: 1 }), ED.breakShareOpen(on, 40326, { dry: 0 }), ED.breakShareOpen(on, 40326, {}),
			ED.breakShareOpen(on, 8192, { dry: 3 }), ED.breakShareOpen(off, 81559, { dry: 3 }), ED.breakShareOpen(on, 81559, null),
			// the time gate: a whole breakStep (20 s) of the round without its own progress or a gate (R.quiet, else R.t0)
			ED.breakShareOpen(on, 40326, { dry: 1, t0: 1e6 }, 1e6 + 5000), ED.breakShareOpen(on, 40326, { dry: 1, t0: 1e6 }, 1e6 + 20000),
			ED.breakShareOpen(on, 40326, { dry: 2, t0: 1e6, quiet: 1e6 + 50000 }, 1e6 + 60000), ED.breakShareOpen({ breakShare: true, breakStep: 5 }, 40326, { dry: 1, t0: 1e6 }, 1e6 + 6000)];
		// runs: no gate / no own progress, again, a gate, own progress, nothing
		let d = 0; const dry = [];
		for (const [hit, own, own0] of [[false, 0, 0], [false, 2, 2], [true, 2, 2], [false, 3, 3], [false, 5, 3], [false, 5, 5]]) { d = ED.breakDryAfter(d, hit, own, own0); dry.push(d); }
		check('the bursts by the GPU: the laptop sizing below 20 GB, --burstPar=2 --gpuCells=26 --burstCap=0 from 20 GB; the gated share opens only on such a GPU after a dry run and a whole breakStep of the round without its own progress, and a gate or its own progress closes it',
			sz.join('|') === '-|-|--burstPar=2 --gpuCells=26 --burstCap=0|--burstPar=2 --gpuCells=26 --burstCap=0|--burstPar=2 --gpuCells=26 --burstCap=0' &&
			open.join() === 'true,false,false,false,false,false,false,true,false,true' && dry.join() === '1,2,0,1,0,1',
			`sizes ${sz.join(' | ')}; open ${open.join()}; dry ${dry.join()}`);
	}
	// the GPU random runs (strategy 'gorolls': node src/goexplore.js --gpu=1, here a stand-in): a GPU strategy with the
	// stop and pause files, the level blob, the reach file and the tool; its route counts, it is told the depth bound on
	// its stdin and goes on; once every other GPU strategy has ended with the route known it stops with the CPU search
	// (its stop file)
	{
		const scX = path.join(HOME, 'rolls-x.json'), logX = path.join(HOME, 'rolls-x.log'), scG = path.join(HOME, 'rolls.json'), logG = path.join(HOME, 'rolls.log');
		const scC = path.join(HOME, 'rolls-cpu.json'), fakeCpu = path.join(HOME, 'fake-cpu.js'), fakeRolls = path.join(HOME, 'fake-rolls.js');
		fs.writeFileSync(fakeCpu, FAKE_CPU);
		fs.writeFileSync(fakeRolls, FAKE_ROLLS);
		fs.writeFileSync(scX, JSON.stringify({ log: logX, R, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0, wait: 1500 }] }, beam: null }));
		fs.writeFileSync(scG, JSON.stringify({ log: logG, route: '4'.repeat(R), wait: 200 }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100 }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scX], cpu: [process.execPath, fakeCpu, scC], rollsCmd: [process.execPath, fakeRolls, scG], rolls: true, salts: false });
		const t0g = Date.now();
		while (ED.state().running && Date.now() - t0g < 30000) await new Promise((z) => setTimeout(z, 100));
		const str = ED.state();
		if (str.running) { ED.stop(); while (ED.state().running) await new Promise((z) => setTimeout(z, 50)); }
		const LG = fs.existsSync(logG) ? fs.readFileSync(logG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
		const a0 = LG[0] || [];
		const has = (p) => a0.some((x) => String(x).startsWith(p));
		const G0 = (str.strategies || []).find((q) => q.key === 'gorolls');
		check('the GPU random runs: a GPU strategy (the tool, the level blob, the reach file, the stop and pause files), its route counts, it is told the depth bound and stops with the CPU search once every move has ended',
			!!G0 && G0.label === 'random runs (GPU)' && G0.rolls && !G0.cpu && ['--gpu=1', '--tool=', '--bin=', '--reach=', '--stdin=1', '--stopfile=', '--pausefile=', '--parent='].every(has) &&
			str.stage === 'found' && str.result && str.result.strategy === 'random runs (GPU)' && str.result.ticks === R &&
			LG.some((x) => x[0] === 'stdin' && x[1].includes(`depth ${R - 1}`)) && LG.some((x) => x[0] === 'stopped') && !str.running && Date.now() - t0g < 30000,
			`${str.stage}; ${str.result ? `route ${str.result.ticks} ticks by ${str.result.strategy}` : 'no route'}; rolls log ${LG.map((x) => (x[0] === 'stdin' ? `stdin ${x[1].trim()}` : String(x[0]).slice(0, 20))).join(' | ')}; ` +
			`strategies ${(str.strategies || []).map((q) => `${q.key}:${q.state}`).join(' ')}`);
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
	check(`the physics check rules the start out: "every move" alone, without the prune, at most ${ED.NO_WAY_UP_S} s`, st.strategies.map((q) => q.key).join() === 'explore' && st.seconds === ED.NO_WAY_UP_S &&
		LM.length > 0 && LM.every((a) => a[0] === 'explore' && !a.includes('--prune=1')) && +LM[0].find((x) => x.startsWith('--seconds=')).slice(10) <= ED.NO_WAY_UP_S && !!st.physics && st.physics.noWayUp,
		`${st.strategies.map((q) => q.key).join()}; ${st.seconds} s; ${LM.map((a) => `${a[0]} ${a.filter((x) => /^--(prune|seconds)=/.test(x)).join(' ')}`).join(' | ')}`);
	check('... and a route found anyway: a mistake in the model, kept in model_miss.json (the level and the route) and said in the log', st.stage === 'found' && !!mj && !!mj.eelvlB64 &&
		typeof mj.inputs === 'string' && mj.inputs.length > 0 && st.log.some((x) => /mistake in the physics model/.test(x)), `${st.stage}; model_miss.json ${mj ? 'written' : 'missing'}`);
	try { fs.unlinkSync(miss); } catch (e) { /* none */ }

	// the steer field (a key off the way: 2 layers): an explore that cannot use the steer file ("steer":0) runs again at
	// once without it and goes on; the beams keep theirs (4 copies fit the budget); no strategy error
	{
		const KW = 40, KH = 7;
		const kcells = [...room(KW, KH), [18, 5, 255], [1, 5, 6], [KW - 4, 5, 121]];
		for (let y = 1; y < KH - 1; y++) kcells.push([KW - 6, y, 23]);
		const kbuf = ED.eelvlOf({ name: 'steerkey', width: KW, height: KH, cells: kcells });
		const sc = path.join(HOME, 'steer-sc.json'), log = path.join(HOME, 'steer-sc.log');
		fs.writeFileSync(sc, JSON.stringify({ log, R: 50, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0 }] }, beam: null, steer: 4, steerFail: true }));
		ED.start({ eelvlB64: kbuf.toString('base64'), seconds: 8, width: 1024 }, { available: true }, { tool: [process.execPath, fake, sc], cpu: false, salts: false });
		let st = ED.state();
		for (const t0 = Date.now(); st.running && Date.now() - t0 < 45000; st = ED.state()) await new Promise((res) => setTimeout(res, 40));
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((res) => setTimeout(res, 40)); }
		const LS = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const ex = LS.filter((a) => a[0] === 'explore'), bm = LS.filter((a) => a[0] === 'beam');
		const hasSteer = (a) => a.some((x) => x.startsWith('--steer='));
		const X = st.strategies.find((q) => q.key === 'explore');
		check('the steer field: an explore that cannot use the steer file ("steer":0) runs again at once without it, the beams keep theirs, no error',
			!!st.steer && st.steer.gpu && st.steer.beams && ex.length >= 2 && hasSteer(ex[0]) && ex.slice(1).every((a) => !hasSteer(a)) && bm.length > 0 && bm.every(hasSteer) &&
			!X.error && st.log.some((x) => /the steer field cannot be used: test: out of memory; again without it/.test(x)),
			`steer ${JSON.stringify(st.steer)}; explore ${ex.map((a) => (hasSteer(a) ? 'steer' : 'plain')).join(', ')}; beams ${bm.map((a) => (hasSteer(a) ? 'steer' : 'plain')).join(', ')}; error ${X && X.error}`);
	}
}

// ---------------------------------------------------------------- the CPU route search (src/goexplore.js; no GPU)
/** runs src/goexplore.js on an .eelvl; feed(child) right after the spawn (its stdin stays open; what it writes waits
 *  in the pipe until the tool reads it, before its workers start); how: {node: [Node's own flags], env}. Resolves to its
 *  events, results, done event and summary line. */
function goexplore(file, opts, feed, how = {}) {
	return new Promise((resolve) => {
		const ch = require('child_process').spawn(process.execPath, [...(how.node || []), path.join(SRC, 'goexplore.js'), file, ...opts],
			{ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: how.env || process.env });
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
	// stdin "seed <inputs>" (the wall breaker's attempts): cells along them; a route's inputs less its last 5 ticks make the
	// search finish within a quarter of the ticks its own first route took (without the seed: none in that budget)
	if (a1.results.length) {
		const rt = a1.results[0], lim = Math.max(2000, Math.floor(rt.simTicks / 4));
		const s4 = await goexplore(platFile, ['--workers=1', `--maxTicks=${lim}`, '--seconds=30', '--stdin=1', '--seed=3'], (ch) => ch.stdin.write(`seed ${rt.inputs.slice(0, rt.ticks - 5)}\n`));
		const s5 = await goexplore(platFile, ['--workers=1', `--maxTicks=${lim}`, '--seconds=30', '--stdin=1', '--seed=3']);
		const w4 = s4.done && s4.done.workers[0];
		check('stdin "seed <inputs>" (the wall breaker\'s attempts): cells along them, and a route from there within a quarter of the ticks (none without the seed)',
			s4.results.length >= 1 && replays(platLevel, s4.results) && w4 && w4.seeded === 1 && w4.seedCells >= 1 && s5.results.length === 0,
			`budget ${lim} ticks; seeded ${w4 ? `${w4.seeded} (${w4.seedCells} cells)` : '-'}: ${s4.results.length} routes; without: ${s5.results.length}; ${s4.summary}`);
	}
	// a trophy the reach field rules out: at once
	const hiCells = room(20, 10);
	for (let x = 8; x <= 12; x++) hiCells.push([x, 3, 9]);
	hiCells.push([10, 2, 121], [3, 8, 255]);
	const hiBuf = ED.eelvlOf({ name: 'way too high', width: 20, height: 10, cells: hiCells });
	const hiFile = path.join(HOME, 'toohigh.eelvl');
	fs.writeFileSync(hiFile, hiBuf);
	const u = await goexplore(hiFile, ['--workers=1', '--seconds=30']);
	check('a trophy the reach field rules out from the start: "unreachable" at once', u.done && u.done.end === 'unreachable' && u.results.length === 0 && u.done.seconds < 5, u.summary);

	// coarse cells (the levels above 50 x 50: rooms, the novelty and discovery heads, no refinement). A 60 x 50 level: a
	// red key on the floor, a wall of red doors, the trophy behind it
	const GX = require('../src/goexplore.js');
	const startOf = (r) => r.events.find((e) => e.ev === 'start') || {};
	const kd = room(60, 50);
	for (let y = 1; y < 49; y++) kd.push([30, y, 23]);
	kd.push([12, 48, 6], [50, 48, 121], [3, 48, 255]);
	const kdBuf = ED.eelvlOf({ name: 'key door', width: 60, height: 50, cells: kd });
	const kdFile = path.join(HOME, 'keydoor.eelvl');
	fs.writeFileSync(kdFile, kdBuf);
	const kdLevel = E.prepareLevel(EL.toSimLevel(EL.readEelvl(kdBuf)));
	check('--cells=auto: fine cells up to 50 x 50 tiles (the platforms, 40 x 20), coarse above (60 x 50); coarse cells never refine',
		startOf(a1).cells === 'fine' && GX.cellsFor(kdLevel) === 'coarse' && GX.cellsFor({ width: 50, height: 50 }) === 'fine' && GX.cellsFor({ width: 51, height: 50 }) === 'coarse' &&
		GX.settle(GX.parseArgs(['x.eelvl']), kdLevel).maxres === 0 && GX.settle(GX.parseArgs(['x.eelvl']), platLevel).maxres === 4, `platforms ${startOf(a1).cells}; key door ${GX.cellsFor(kdLevel)}`);
	// the memory budget per worker: fine cells 1600 / workers (200 .. 800 MB), coarse cells 1500 MB, both within the machine:
	// the search's process memory (workers x (1.5 x budget + 208 MB): each worker's heap limit and its young generation) at
	// most a quarter of the machine's memory, all searches on it (the registry) at most half, at most half of what is free;
	// never below 128 MB
	const GB = 2 ** 30, mach = (total, free, others) => ({ total: total * GB, free: (free === undefined ? total : free) * GB, others: (others || 0) * GB });
	const dm = (cells, w, m) => GX.defaultMem(cells, w, m).mem;
	// 5 searches of 36 workers start one after another on a 251 GB machine (the EPYC box: before, each took 1500 MB per
	// worker, 270 GB of budgets, more than the machine)
	let others = 0;
	const claims = [];
	for (let k = 0; k < 5; k++) { const d = GX.defaultMem('coarse', 36, mach(251, 240, others / 1024)); const mb = GX.processMB(36, d.mem); claims.push([d.mem, mb]); others += mb; }
	check('memory per worker: 1500 MB on a big machine, a quarter of a laptop (32 GB, 15 workers: 225 MB; 4: 1226), at least 128; fine cells 1600 / workers',
		dm('coarse', 8, mach(708)) === 1500 && dm('coarse', 15, mach(32)) === 225 && dm('coarse', 4, mach(32)) === 1226 && dm('coarse', 7, mach(8)) === 128 &&
		dm('fine', 4, mach(32)) === 400 && dm('fine', 1, mach(32)) === 800 && GX.defaultMem('coarse', 15, mach(32)).why === 'a quarter of the machine' &&
		GX.settle(GX.parseArgs(['x.eelvl', '--workers=4']), platLevel, mach(32)).mem === 400 && GX.settle(GX.parseArgs(['x.eelvl', '--workers=4', '--mem=300']), kdLevel).mem === 300 &&
		GX.settle(GX.parseArgs(['x.eelvl', '--workers=4', '--memTotal=4000']), kdLevel).mem === 528 && GX.processMB(4, 528) <= 4000,
		`8 workers on 708 GB: ${dm('coarse', 8, mach(708))} MB; 15 on 32 GB: ${dm('coarse', 15, mach(32))}; 4: ${dm('coarse', 4, mach(32))}; 7 on 8 GB: ${dm('coarse', 7, mach(8))}`);
	check('... the searches on one machine: its free memory and the others\' claims bound a new one (5 x 36 workers on 251 GB: in all at most three quarters of it)',
		dm('coarse', 15, mach(32, 6)) === 128 && GX.defaultMem('coarse', 15, mach(32, 6)).why.startsWith('the memory free') && claims[0][0] === 1051 && claims[1][0] === 1051 &&
		claims[2][0] === 128 && claims.reduce((x, c) => x + c[1], 0) <= 0.75 * 251 * 1024,
		`5 searches: ${claims.map((c) => `${c[0]} MB/worker (${(c[1] / 1024).toFixed(1)} GB)`).join(', ')}`);
	// the registry: a file per search in a folder (the temp folder's eeautotas-goexplore); a dead process's file, or one not
	// refreshed for 10 minutes, is removed; the others' claims count
	const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-reg-'));
	const regFile = (pid, bytes, age) => fs.writeFileSync(path.join(reg, `${pid}.json`), JSON.stringify({ pid, bytes, at: Date.now() - (age || 0) }));
	const deadPid = 4194000 + (process.pid % 1000);
	regFile(process.ppid, 3 * GB);
	regFile(deadPid, 5 * GB);
	regFile(process.pid, 7 * GB);
	fs.writeFileSync(path.join(reg, `${process.ppid}.tmp`), 'half written');
	const regSum = GX.registryOthers(reg);
	regFile(process.ppid, 3 * GB, 11 * 60 * 1000);
	const regStale = GX.registryOthers(reg);
	GX.registryClaim(2 * GB, reg);
	const mine = JSON.parse(fs.readFileSync(path.join(reg, `${process.pid}.json`), 'utf8'));
	GX.registryClaim(0, reg);
	check('the registry of searches: a live process\'s claim counts, a dead one\'s file and a stale one go, this process\'s own claim is written and removed',
		regSum === 3 * GB && regStale === 0 && !fs.existsSync(path.join(reg, `${deadPid}.json`)) && !fs.existsSync(path.join(reg, `${process.ppid}.json`)) && mine.bytes === 2 * GB &&
		!fs.existsSync(path.join(reg, `${process.pid}.json`)), `others ${regSum / GB} GB, then ${regStale / GB}; ${fs.readdirSync(reg).join(', ')}`);
	fs.rmSync(reg, { recursive: true, force: true });
	// a V8 heap flag for the whole process (NODE_OPTIONS --max-old-space-size, as the editor once passed 1024) caps every
	// worker's heap whatever its own limit asks: the budget fits it (before: 1500 MB budgets in 1 GB heaps, all 8 workers
	// of the lab's Stupid Fox run ran out); the editor passes none (C.workerHeapEnv)
	const flagged = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=3', '--mem=500'], null, { env: Object.assign({}, process.env, { NODE_OPTIONS: '--max-old-space-size=300' }) });
	const envNow = process.env.NODE_OPTIONS;
	process.env.NODE_OPTIONS = '--max-old-space-size=1024 --trace-warnings';
	const stripped = C.workerHeapEnv().NODE_OPTIONS;
	if (envNow === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = envNow;
	check('a V8 heap flag for the process: the workers\' budget fits it (300 MB: 114 MB each), no worker runs out; the editor starts the CPU search without one',
		startOf(flagged).mem === 114 && /max-old-space-size=300/.test(startOf(flagged).memWhy) && flagged.done && flagged.done.end === 'time' &&
		!flagged.events.some((e) => e.ev === 'warning') && stripped === '--trace-warnings', `${JSON.stringify(startOf(flagged))}; ${flagged.summary}; NODE_OPTIONS -> ${stripped}`);
	const k1 = await goexplore(kdFile, ['--workers=1', '--seed=3', '--maxTicks=1500000', '--seconds=40', '--mem=1500']);
	const k2 = await goexplore(kdFile, ['--workers=1', '--seed=3', '--maxTicks=1500000', '--seconds=40', '--mem=1500']);
	check('coarse cells, 1 thread, a tick budget: routes (through the key\'s room), all finishing in the JS engine; the same seed gives the same routes after the same ticks',
		startOf(k1).cells === 'coarse' && k1.results.length > 0 && replays(kdLevel, k1.results) && sig(k1) === sig(k2) && k1.done.ticks === k2.done.ticks && k1.done.workers[0].rooms === 2,
		`${k1.results.map((x) => `${x.ticks}@${x.simTicks}`).join(' ')}; ${k1.summary}`);
	// pinned: the research prototype (a local ngx.js --mode=novold --seed=3, not in the repository: the same cells and
	// heads; here every new room opens territory and no crown door stands, so also the same random draws) found its first
	// route here, 416 ticks, after 8,163 simulated ticks
	check('coarse cells pick like the research prototype where every room opens territory: the first route 416 ticks after 8,163 simulated ticks (seed 3)',
		k1.results.length > 0 && k1.results[0].ticks === 416 && k1.results[0].simTicks === 8163, `${k1.results.length ? `${k1.results[0].ticks}@${k1.results[0].simTicks}` : 'no route'}`);
	// the speed cells (--spd, coarse cells): a 60 x 50 level whose trophy stands behind a 5-coin door and no coin exists:
	// the search stalls at the door, so after --spd seconds without progress the frontier room gets the fastest arrival's
	// cells next to the earliest (EEAT_SPDLOG records the flag); --spd=0 never flags; neither finds a route (the door never
	// opens: the flags add cells, they never let a state through). --roomDead=0: the room dead ends (dead-end-traps) prove
	// this start a dead end (no coin to open the door: the whole room is cut at once, 1 cell), and the stall is the point
	const sd = room(60, 50);
	for (let y = 1; y < 49; y++) sd.push([30, y, 43, 5]);
	for (let x = 5; x < 28; x += 4) sd.push([x, 44 - (x % 8), 9]);
	sd.push([3, 48, 255], [50, 48, 121]);
	const sdFile = path.join(HOME, 'spdstall.eelvl');
	fs.writeFileSync(sdFile, ED.eelvlOf({ name: 'speed cells stall', width: 60, height: 50, cells: sd }));
	const sdLog = path.join(HOME, 'spdstall.jsonl');
	const sdOn = await goexplore(sdFile, ['--workers=1', '--seed=3', '--seconds=6', '--spd=2', '--roomDead=0'], null, { env: Object.assign({}, process.env, { EEAT_SPDLOG: sdLog }) });
	const sdOff = await goexplore(sdFile, ['--workers=1', '--seed=3', '--seconds=6', '--spd=0', '--roomDead=0']);
	const sdFlags = fs.existsSync(sdLog) ? fs.readFileSync(sdLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ev === 'flag') : [];
	const sdW = (r) => (r.done && r.done.workers && r.done.workers[0]) || {};
	check('speed cells: a search stalled for --spd seconds flags its frontier room (the fastest arrival next to the earliest cell); --spd=0 flags nothing; no route in either (the 5-coin door never opens)',
		sdFlags.length >= 1 && sdFlags[0].s >= 2 && sdW(sdOn).spdFlags >= 1 && sdW(sdOn).spdPeak >= 1 && sdW(sdOff).spdFlags === 0 && sdOn.results.length === 0 && sdOff.results.length === 0 &&
		sdOn.done.end === 'time' && sdOff.done.end === 'time',
		`flags ${sdFlags.map((e) => `${e.s} s ${e.desc}`).join(', ')}; on: spdFlags ${sdW(sdOn).spdFlags}, cells ${sdW(sdOn).cells}; off: spdFlags ${sdW(sdOff).spdFlags}, cells ${sdW(sdOff).cells}`);
	// the source events: the key's room once (its first cell: its inputs end where the ball entered it, with the key)
	const RM = GX.roomOf(kdLevel);
	const roomAt = (inputs) => { const s = new E.EESim(kdLevel), inp = new E.EEInput(); s.reset(); let k = RM.key(s), prev = k; for (const ch of inputs) { E.applyMask(inp, ch.charCodeAt(0) - 48); s.tick(inp); prev = k; k = RM.key(s); } return { key: k, entered: k !== prev, desc: RM.desc(s) }; };
	const ks = k1.events.filter((e) => e.ev === 'source');
	const kr = ks.find((e) => e.kind === 'room');
	const at = kr ? roomAt(kr.inputs) : null;
	check('coarse cells: a "source" event for the key\'s new room (territory gain; its inputs end as the ball enters it), each room once per kind',
		!!kr && kr.desc === 'key:red' && kr.gain > 0 && kr.tick === kr.inputs.length && at.key === kr.room && at.entered && at.desc === 'key:red' &&
		ks.filter((e) => e.kind === 'room').length === new Set(ks.filter((e) => e.kind === 'room').map((e) => e.room)).size,
		ks.map((e) => `${e.kind} "${e.desc}" gain ${e.gain} tick ${e.tick}`).join('; '));
	// the viewing-room trap (test/reach.js H; Forgotten Helix's spectator box): 80 x 40, walk mode, the trophy's half a dot
	// field behind a spike wall, reached by a portal; a spectator box by the trophy (spike walls) whose only way out is its
	// portal back; the protection effect by the trophy; a pocket only a death leaves. When the protection effect made every
	// spike air the box was 8.6 tiles from the trophy, the start 19.6, and the CPU search's first route came after 47,878 /
	// 81,202 / 99,482 simulated ticks (seeds 1-3, one worker); the box now ranks behind the start (53.8 vs 50.8 tiles):
	// 8,358 / 12,105 / 7,188
	{
		const W = 80, H = 40, c = room(W, H);
		for (let y = 1; y < H - 1; y++) for (let x = 42; x < W - 1; x++) c.push([x, y, 4]);
		for (let y = 1; y < H - 1; y++) c.push([40, y, 361, 1]);
		for (let x = 68; x <= 72; x++) c.push([x, 6, 361, 1], [x, 10, 9]);
		for (let y = 7; y <= 9; y++) c.push([68, y, 361, 1], [72, y, 361, 1], [69, y, 0], [70, y, 0], [71, y, 0]);
		c.push([70, 9, 242, 0, 3, 4], [12, 38, 242, 0, 4, 3], [6, 38, 242, 0, 1, 2], [45, 38, 242, 0, 2, 1], [18, 38, 242, 0, 5, 7]);
		for (let x = 23; x <= 27; x++) c.push([x, 2, 9], [x, 6, 9]);
		for (let y = 3; y <= 5; y++) c.push([23, y, 9], [27, y, 9]);
		c.push([25, 5, 361, 1], [25, 3, 242, 0, 7, 99], [2, 38, 255], [30, 38, 360], [77, 5, 121], [77, 3, 420, 1], [78, 38, 453, 0]);
		const trapBuf = ED.eelvlOf({ name: 'viewing room trap', width: W, height: H, cells: c });
		const trapFile = path.join(HOME, 'trap.eelvl');
		fs.writeFileSync(trapFile, trapBuf);
		const trapLevel = E.prepareLevel(EL.toSimLevel(EL.readEelvl(trapBuf)));
		const tr = [];
		for (const sd of [1, 2, 3]) tr.push(await goexplore(trapFile, ['--workers=1', `--seed=${sd}`, '--maxTicks=30000', '--seconds=30', '--mem=300', '--first=1']));
		check('the viewing-room trap: the CPU search\'s first route within 30,000 simulated ticks (seeds 1-3, one worker; when every spike was air: 47,878-99,482), each one finishing in the JS engine',
			tr.every((r) => r.results.length > 0 && r.results[0].simTicks <= 30000) && tr.every((r) => replays(trapLevel, r.results)),
			tr.map((r) => (r.results.length ? `${r.results[0].ticks}@${r.results[0].simTicks}` : `none (${r.summary})`)).join(', '));
	}
	// a full archive sweeps: a 60 x 50 level of 10 purple switches, a purple door wall and a trophy walled in (no route;
	// --prune=0, as the editor runs a level the reach field calls impossible). With room for 300 cells (--maxCells) the
	// cells no run touched for longest go and the search goes on; no room is left without cells (a room is made with its
	// first cell, and goes with its last)
	const sw = room(60, 50);
	for (let k = 0; k < 10; k++) sw.push([4 + 2 * k, 48, 113, k + 1]);
	for (let y = 1; y < 49; y++) sw.push([45, y, 184, 1]);
	sw.push([2, 48, 255], [55, 47, 121], [54, 47, 9], [56, 47, 9]);
	for (let x = 54; x <= 56; x++) sw.push([x, 46, 9], [x, 48, 9]);
	const swFile = path.join(HOME, 'switches.eelvl');
	fs.writeFileSync(swFile, ED.eelvlOf({ name: 'switches', width: 60, height: 50, cells: sw }));
	const swRun = (ticks) => goexplore(swFile, ['--workers=1', '--seed=1', '--prune=0', '--maxCells=300', `--maxTicks=${ticks}`, '--seconds=30']);
	const r1 = await swRun(500000), r2 = await swRun(2000000);
	const sw1 = r1.done && r1.done.workers[0], sw2 = r2.done && r2.done.workers[0];
	check('coarse cells, the archive full (--maxCells=300): sweeps, at most 300 cells, no room without cells, the search goes on (more cells swept after 2 M ticks than 0.5 M)',
		!!sw1 && !!sw2 && sw1.full && sw2.full && sw1.cells <= 300 && sw2.cells <= 300 && sw1.sweeps > 0 && sw2.evicted > sw1.evicted && sw1.rooms <= sw1.cells + 1 &&
		sw2.rooms <= sw2.cells + 1 && r2.done.end === 'ticks' && !r2.events.some((e) => e.ev === 'warning'),
		`rooms ${sw1 ? sw1.rooms : '-'} / ${sw2 ? sw2.rooms : '-'}, cells ${sw1 ? sw1.cells : '-'} / ${sw2 ? sw2.cells : '-'}, swept ${sw1 ? sw1.evicted : '-'} / ${sw2 ? sw2.evicted : '-'}; ${r2.summary}`);
	// the byte budget (--mem=24 MB on the switches level: 1024 switch states): the archive's count within it, and the heap
	// (after a collection: node --expose-gc) within it plus the worker's own few MB (the engine, the level, the code)
	const b24 = await goexplore(swFile, ['--workers=1', '--seed=1', '--prune=0', '--mem=24', '--maxTicks=10000000', '--seconds=60'], null, { node: ['--expose-gc'] });
	const bw = b24.done && b24.done.workers[0];
	check('the memory budget (24 MB; 1024 switch states): counted within it, the heap within it + 10 MB, sweeps, rooms only with cells, no warning',
		!!bw && b24.done.end === 'ticks' && bw.memMB <= 24 && bw.heapMB <= 34 && bw.sweeps > 0 && bw.rooms > 100 && bw.rooms <= bw.cells + 1 && !b24.events.some((e) => e.ev === 'warning'),
		bw ? `${bw.cells} cells in ${bw.rooms} rooms, ${bw.snaps} snapshots, counted ${bw.memMB} MB, heap ${bw.heapMB} MB, ${bw.sweeps} sweeps (${bw.evicted} cells)` : b24.summary);
	// the one search (coarse cells): --share=1: 2 workers share the rooms they find first (the key's room, found by one,
	// goes into the other's archive: its 'import'); by default each archive on its own, as before
	const imports = (r) => (r.done ? r.done.workers.reduce((x, w) => x + (w.imports || 0), 0) : -1);
	const o1 = await goexplore(kdFile, ['--workers=2', '--seed=3', '--seconds=5', '--mem=300', '--share=1']);
	const o0 = await goexplore(kdFile, ['--workers=2', '--seed=3', '--seconds=5', '--mem=300']);
	check('the one search: --share=1: 2 workers share the rooms they find first (the key\'s room goes into the other archive), routes replay; by default nothing is shared',
		!!o1.done && o1.done.shared >= 1 && imports(o1) >= 1 && o1.done.workers.every((w) => w.rooms === 2) && o1.results.length > 0 && replays(kdLevel, o1.results) &&
		!!o0.done && imports(o0) === 0 && !o0.done.shared, `shared ${o1.done && o1.done.shared}, imports ${imports(o1)} (share=0: ${imports(o0)}); ${o1.summary}`);
	// the GPU bursts (src/bursts.js) with a stand-in for eegpu: it prints a nearer attempt at a target (distance 0) one
	// tick short of the key: the operator goes on into the room the trigger makes (its last input again), and the attempt
	// goes into every worker's archive
	const BU = require('../src/bursts.js');
	// target-fair rooms (--burstFair): a room's score divided by 1 + failed chains / (3 x its untried targets): after 6
	// failed chains a room of 1 target (a phantom behind a lid) ranks below a room of 13 targets with the same bandit score;
	// a room with no failure keeps its score; the order only (an untried room's UNTRIED score is never divided)
	const fs1 = BU.fairScore(0.5, 6, 1), fs13 = BU.fairScore(0.5, 6, 13);
	check('target-fair rooms: the score per untried target not yet failed (1 target, 6 failed chains: a third; 13 targets: 0.87 of it; no failure: as before; 0 targets counts 1)',
		Math.abs(fs1 - 0.5 / 3) < 1e-9 && Math.abs(fs13 - 0.5 / (1 + 6 / 39)) < 1e-9 && fs13 > fs1 && BU.fairScore(0.5, 0, 1) === 0.5 && BU.fairScore(0.5, 3, 0) === BU.fairScore(0.5, 3, 1),
		`1 target ${fs1.toFixed(3)}, 13 targets ${fs13.toFixed(3)}`);
	const TRk = BU.triggersOf(kdLevel);
	const standin = path.join(HOME, 'burst_standin.js');
	fs.writeFileSync(standin, [
		"'use strict';",
		"const inputs = process.env.EEAT_TEST_BURST || '';",
		"const a = process.argv.slice(2);",
		"if (a[0] !== 'explore' || !a.some((x) => x.startsWith('--prefix=')) || !a.some((x) => x.startsWith('--reach='))) { console.log(JSON.stringify({ error: 'bad args ' + a.join(' ') })); process.exit(2); }",
		"console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"if (inputs) console.log(JSON.stringify({ ev: 'closest', dist: 0, tick: inputs.length, inputs }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'exhausted', layers: 1, states: 1 })), 50);",
	].join('\n'));
	process.env.EEAT_TEST_BURST = kr ? kr.inputs.slice(0, -1) : '';
	const ob = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=5', '--mem=300', '--bursts=1', `--tool=${standin}`, `--work=${path.join(HOME, 'bursts')}`]);
	delete process.env.EEAT_TEST_BURST;
	const b1 = ob.events.find((e) => e.ev === 'burst');
	check('the one search\'s GPU bursts (a stand-in for eegpu): the key is the level\'s one trigger; a burst from the start\'s room reaches it, goes on into the key\'s room and its attempt goes into the archive',
		TRk.n === 1 && !!b1 && b1.room === '(start)' && b1.reached && b1.changed && !!ob.done && ob.done.gpu && ob.done.gpu.imports >= 1 && ob.done.workers[0].imports >= 1 &&
		!ob.events.some((e) => e.ev === 'warning'), `${TRk.n} trigger(s); ${JSON.stringify(b1 || null)}; ${JSON.stringify(ob.done && ob.done.gpu)}; ${ob.events.filter((e) => e.ev === 'warning').map((e) => e.text).join(' | ')}`);
	// after the first route (src/out/night/macro.md). The sound lower bound per tile (goexplore.js lowerBoundTiles): along
	// every route of the key level, at every tick t, t + the bound at the ball's tile is at most the route's length (it never
	// cuts a real route), and it is not all zeros
	const lbt = GX.lowerBoundTiles(kdLevel);
	let lbBad = 0, lbMax = 0;
	for (const r of k1.results) {
		const s = new E.EESim(kdLevel), inp = new E.EEInput();
		s.reset();
		for (let t = 0; t < r.inputs.length; t++) {
			E.applyMask(inp, r.inputs.charCodeAt(t) - 48);
			s.tick(inp);
			const b = lbt[(Math.trunc(s.py + 8) >> 4) * kdLevel.width + (Math.trunc(s.px + 8) >> 4)];
			if (t + 1 + b > r.inputs.length) lbBad++;
			if (b < 0xffff && b > lbMax) lbMax = b;
		}
	}
	check('the sound lower bound on the ticks to the trophy (4 tile steps a tick, every door open): never above what a route of the key level takes; not all zeros',
		k1.results.length > 0 && lbBad === 0 && lbMax > 0, `${lbBad} states over; the largest bound on the routes ${lbMax} ticks`);
	// head L (a route known: "route <inputs>" on stdin; bursts by a stand-in that finds nothing): the route given is the bound
	// (a "route" event, no result of this search's), head L picks cells along it at its full share (--pL) in its first
	// LEAD_GRACE_S, and nothing goes to the GPU beyond the bursts' own sizing (the route relay of the macro branch is gone)
	const nothingTool = path.join(HOME, 'burst_nothing.js');
	fs.writeFileSync(nothingTool, ["'use strict';", "console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'exhausted', layers: 1, states: 1 })), 20);"].join('\n'));
	const kBest = k1.results.length ? k1.results[k1.results.length - 1] : null;
	const orr = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=8', '--mem=300', '--bursts=1', `--tool=${nothingTool}`, `--work=${path.join(HOME, 'bursts4')}`, '--stdin=1'],
		(ch) => { if (kBest) ch.stdin.write(`route ${kBest.inputs}\n`); });
	const ow = orr.done && orr.done.workers && orr.done.workers[0];
	check('after a route given on stdin: it is the bound, head L picks cells along it at its full share in its first minutes; no route relay',
		!!kBest && !!ow && ow.leadPicks > 0 && ow.leadShare === 0.3 && orr.events.some((e) => e.ev === 'route' && e.ticks === kBest.inputs.length) &&
		!(orr.done.gpu && orr.done.gpu.relayBursts) && !orr.events.some((e) => e.ev === 'warning'),
		`${JSON.stringify(ow && { leadPicks: ow.leadPicks, leadShare: ow.leadShare, picks: ow.picks })}; ${orr.events.filter((e) => e.ev === 'warning').map((e) => e.text).join(' | ').slice(0, 300)}`);
	// head W (the path gap): with the route known, cells off head L's (room, tile) schedule are picked by their key-blind
	// lead (the route's first tick at the tile in any room) from the picks head L leaves
	check('after a route head W picks cells off the route schedule of (room, tile) by their key-blind lead, next to the head L picks along it',
		!!ow && ow.wayPicks > 0 && ow.leadPicks > 0 && ow.wayPicks < ow.picks, ow ? `wayPicks ${ow.wayPicks}, leadPicks ${ow.leadPicks}, picks ${ow.picks}` : 'no worker stats');
	// the GPU random runs as an operator of the one search (the editor's feed, goexplore.js stdin "import <inputs>"): a run
	// into the key's room given on stdin goes into the archive of every worker (2 workers, nothing shared otherwise)
	const of = await goexplore(kdFile, ['--workers=2', '--seed=3', '--seconds=4', '--mem=300', '--bursts=1', `--tool=${standin}`, `--work=${path.join(HOME, 'bursts2')}`, '--stdin=1'],
		(ch) => { if (kr) ch.stdin.write(`import ${kr.inputs}\n`); ch.stdin.write('import not-inputs\n'); });
	check('the one search takes in another operator\'s run on its stdin ("import <inputs>": the editor\'s GPU random runs): into both workers\' archives, a bad line ignored',
		!!kr && !!of.done && of.done.fed === 1 && of.done.workers.every((w) => w.imports >= 1) && !of.events.some((e) => e.ev === 'warning'),
		`fed ${of.done && of.done.fed}, imports ${of.done ? of.done.workers.map((w) => w.imports).join(' / ') : '-'}; ${of.summary}`);
	// a full GPU (the other tools' tables, other searches on a shared GPU): a burst that finds no memory waits and tries
	// again (--burstOomS, doubled while it lasts), never the bursts' end; a dying start is its arm's failure only
	const oomTool = path.join(HOME, 'burst_oom.js'), oomCount = path.join(HOME, 'burst_oom.count');
	fs.writeFileSync(oomTool, [
		"'use strict';",
		"const fs = require('fs');",
		`const f = ${JSON.stringify(oomCount)};`,
		"let n = 0; try { n = +fs.readFileSync(f, 'utf8') || 0; } catch (e) { /* first */ }",
		"fs.writeFileSync(f, String(n + 1));",
		"if (n < 4) { console.log(JSON.stringify({ error: 'cuMemAlloc_v2(&p, bytes) failed: CUDA error 2 (out of memory)' })); process.exit(4); }",
		"if (n < 7) { console.log(JSON.stringify({ error: 'the prefix dies' })); process.exit(3); }",
		"console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'exhausted', layers: 1, states: 1 })), 50);",
	].join('\n'));
	const oo = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=20', '--mem=300', '--bursts=1', `--tool=${oomTool}`, `--work=${path.join(HOME, 'bursts3')}`, '--burstOomS=0.2']);
	const og = oo.done && oo.done.gpu;
	check('the one search\'s bursts on a full GPU: 4 "out of memory" failures wait and try again, 3 dying starts count as their arms\' failures only, then bursts run; never "no more GPU bursts"',
		!!og && og.oom === 4 && og.failed === 7 && og.bursts >= 1 && !oo.events.some((e) => e.ev === 'warning' && /no more GPU bursts/.test(e.text)),
		`${JSON.stringify(og)}; ${oo.events.filter((e) => e.ev === 'warning').map((e) => e.text).join(' | ').slice(0, 400)}`);
	// the big sizing (the editor's burstBig: 2 lanes, 2^26 cells, 1 M layers) on a full GPU: its first out-of-memory failure
	// takes the small sizing at once (lane 0 alone, 2^25 cells, <= 262,144 states a layer, no wait) for --burstSmallS, then
	// the big one again; the bursts' longest launch (eegpu's done lines) is kept
	const bigTool = path.join(HOME, 'burst_big.js'), bigLog = path.join(HOME, 'burst_big.log');
	fs.writeFileSync(bigTool, [
		"'use strict';",
		"const fs = require('fs');",
		`const f = ${JSON.stringify(bigLog)};`,
		"const a = process.argv.slice(2), opt = (k) => (a.find((x) => x.startsWith('--' + k + '=')) || '').split('=')[1];",
		// (the first launch of either lane, by an exclusive create: the one out-of-memory failure)
		"let oom = false; try { fs.closeSync(fs.openSync(f + '.oom', 'wx')); oom = true; } catch (e) { /* not the first */ }",
		"fs.appendFileSync(f, JSON.stringify({ t: Date.now(), cells: +opt('cells'), cap: +opt('cap'), oom }) + '\\n');",
		"if (oom) { console.log(JSON.stringify({ error: 'cuMemAlloc_v2(&p, bytes) failed: CUDA error 2 (out of memory)' })); process.exit(4); }",
		"console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'exhausted', layers: 1, states: 1, maxLaunchMs: 12.5, maxKernelMs: 7.25 })), 200);",
	].join('\n'));
	const ogb = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=16', '--mem=300', '--bursts=1', `--tool=${bigTool}`, `--work=${path.join(HOME, 'bursts5')}`,
		'--burstPar=2', '--gpuCells=26', '--burstCap=0', '--burstSmallS=4']);
	const gb = ogb.done && ogb.done.gpu;
	let bl = [];
	try { bl = fs.readFileSync(bigLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { /* none */ }
	const b0 = bl.find((x) => x.oom), tOom = b0 ? b0.t : 0;
	const inSmall = bl.filter((x) => x.t > tOom + 400 && x.t < tOom + 3600), after = bl.filter((x) => x.t > tOom + 5000);
	check('the big burst sizing on a full GPU: the first "out of memory" takes the small sizing at once (lane 0 alone, 2^25 cells, 262,144 states a layer) for --burstSmallS, then the big one again; the longest launch kept',
		!!gb && gb.oom === 1 && gb.small === 1 && !!b0 && b0.cells === 26 && inSmall.length >= 2 && inSmall.every((x) => x.cells === 25 && x.cap <= 262144) &&
		// (lane 0 alone: one burst of 200 ms at a time, not two side by side)
		inSmall.every((x, i) => i === 0 || x.t - inSmall[i - 1].t >= 150) && after.some((x) => x.cells === 26) &&
		gb.maxLaunchMs === 12.5 && gb.maxKernelMs === 7.25 && !ogb.events.some((e) => e.ev === 'warning' && /again in/.test(e.text)),
		`${JSON.stringify(gb)}; launches ${bl.map((x) => `${x.t - tOom}:${x.cells}/${x.cap}`).join(' ')}; ${ogb.events.filter((e) => e.ev === 'warning').map((e) => e.text).join(' | ').slice(0, 300)}`);
	// the editor keeps the CPU search's sources (no GPU: no relay, but they are shown)
	ED.start({ eelvlB64: kdBuf.toString('base64'), seconds: 3, workers: 1 }, { available: false, why: 'test: no GPU' });
	for (const t0 = Date.now(); ED.state().running && Date.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));
	const ss = ED.state();
	check('the editor keeps the CPU search\'s sources (per room: where it was entered, its nearest attempt, the relay runs from it)', ss.stage === 'found' && Array.isArray(ss.sources) &&
		ss.sources.some((s) => s.desc === 'key:red' && s.gain > 0 && s.entered >= 100 && s.best && s.runs === 0 && s.from === 'random runs (CPU)'),
		JSON.stringify(ss.sources));

	// the editor without an NVIDIA GPU: the CPU search alone, with a note
	const waitDone = async (limit) => {
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < limit) { await new Promise((r) => setTimeout(r, 100)); st = ED.state(); }
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 50)); st = ED.state(); }
		return st;
	};
	let st0 = ED.start({ eelvlB64: platBuf.toString('base64'), seconds: 4, workers: 1 }, { available: false, why: 'test: no GPU' });
	check('no NVIDIA GPU: the search starts anyway, only the CPU strategies (the random runs; the precision stage waiting for a stall), with a note', st0.running && st0.strategies.length === 2 &&
		st0.strategies[0].key === 'goexplore' && st0.strategies[1].key === 'precision' && ['starting', 'waiting'].includes(st0.strategies[1].state) &&
		st0.strategies.every((q) => q.cpu) && /no NVIDIA GPU is available \(test: no GPU\)/.test(st0.cpuOnly) && st0.log.some((x) => /CPU searches alone/.test(x)), JSON.stringify(st0.strategies.map((q) => `${q.key} ${q.state}`)));
	let st = await waitDone(20000);
	let ev = st.result ? C.evaluate(platLevel, Uint8Array.from(st.result.inputs, (c) => c.charCodeAt(0) - 48)) : null;
	check('no NVIDIA GPU: a route from the CPU search, verified, route.eetas', st.stage === 'found' && st.result.strategy === 'random runs (CPU)' && ev && ev.runTicks === st.result.runTicks &&
		!!ED.solveFile('route.eetas') && st.elapsed >= 3.5 && st.elapsed < 15, `${st.stage} ${st.result ? `${st.result.time} (${st.result.ticks} ticks) after ${st.result.foundAfter} s` : st.message}; ${st.elapsed.toFixed(1)} s`);
	const u0 = await goexplore(hiFile, ['--workers=1', '--seconds=2', '--prune=0']);
	check('--prune=0 (the editor\'s check of a level the field rules out): it searches, the ruled-out states behind (reach cost 1e4 + walking distance)', u0.done && u0.done.end === 'time' && u0.done.ticks > 0 &&
		u0.results.length === 0, u0.summary);
	ED.start({ eelvlB64: hiBuf.toString('base64'), seconds: 5, workers: 1 }, { available: false, why: 'test: no GPU' });
	st = await waitDone(20000);
	check('no NVIDIA GPU, a trophy out of reach: the random runs check it without the physics check (their time, at most NO_WAY_UP_S), then the physics verdict',
		st.stage === 'not found' && st.impossible && st.impossible.by === 'physics' && st.elapsed >= 4 && st.elapsed < 15 && st.log.some((x) => /checking that with random runs \(CPU\), without the physics check/.test(x)),
		`${st.elapsed.toFixed(1)} s: ${st.message}`);
	check('... and no proof (eegpu prove) runs: the physics check has proven it already', !st.proof, JSON.stringify(st.proof || null));
	// a steer field built after the search started (the wait forced to 0 ms; a key off the way: 2 layers, on a level no
	// earlier search built it for): the CPU search takes it when it arrives (goexplore.js stdin "steer <file>", its
	// "steer" event), the distances stay the reach field's
	const LW = 44, LH = 7, lcells = [...room(LW, LH), [18, 5, 255], [1, 5, 6], [LW - 4, 5, 121]];
	for (let y = 1; y < LH - 1; y++) lcells.push([LW - 6, y, 23]);
	const kdLate = ED.eelvlOf({ name: 'late steer', width: LW, height: LH, cells: lcells });
	ED.start({ eelvlB64: kdLate.toString('base64'), seconds: 6, workers: 1 }, { available: false, why: 'test: no GPU' }, { steerWaitMs: 0 });
	st = await waitDone(25000);
	check('a late steer field: taken when its build ends (the CPU search\'s head A from then on, its "steer" event), the distances still the reach field\'s',
		st.stage === 'found' && !!st.steer && Number.isFinite(st.steer.late) && Number.isFinite(st.steer.cpuAt) && !st.steer.gpu && st.log.some((x) => /the steer field is still building/.test(x)) &&
		st.log.some((x) => /arrived [\d.]+ s into the search: from now on it orders the CPU search/.test(x)) && !(st.closest && st.closest.steer !== undefined),
		`${st.stage}; steer ${JSON.stringify(st.steer)}; ${st.log.filter((x) => /steer/.test(x)).join(' | ')}`);

	// the precision stage (src/precision.js, "exact landings"): the user's pocket puzzle (test.eelvl's shape: a trophy pocket
	// under a spike whose right side is a half block) at x 1976: the ball must drop in with px == 1976.0 exactly. The
	// random runs stall on the half block, 3.8 tiles out; the stage (its first wait 3 s here) lands the ball there
	{
		const OX = 120, PW = OX + 15, PH = 12;
		const cells = room(PW, PH), inner = [];
		['..##########.', '..#^.....#S#.', '..#^.....#.#.', '.##^.......#.', '.#..|#######.', '.#..|#.#.....', '.#T.|#.......', '.#####.......'].forEach((row, j) => [...row].forEach((ch, i) => {
			const x = OX + i, y = 2 + j;
			if (x >= PW - 1 || y >= PH - 1) return;
			const id = { '#': [9], '^': [361, 1], '|': [1116, 0], T: [121], S: [255] }[ch];
			if (id) inner.push([x, y, ...id]);
		}));
		const at = new Set(inner.map(([x, y]) => `${x},${y}`));
		const pBuf = ED.eelvlOf({ name: 'pocket', width: PW, height: PH, cells: [...cells.filter(([x, y]) => !at.has(`${x},${y}`)), ...inner] });
		const pLevel = E.prepareLevel(EL.toSimLevel(EL.readEelvl(pBuf)));
		ED.start({ eelvlB64: pBuf.toString('base64'), seconds: 30, workers: 2 }, { available: false, why: 'test: no GPU' }, { precision: true, precWait: 3 });
		st = await waitDone(60000);
		const pr = st.result ? Uint8Array.from(st.result.inputs, (c) => (c.charCodeAt(0) - 48) & 31) : null;
		const pev = pr ? C.evaluate(pLevel, pr) : null;
		let drop = null;
		if (pr) {
			const s = new E.EESim(pLevel), inp = new E.EEInput();
			s.reset();
			for (let k = 0; k < pr.length && !drop; k++) { const py0 = s.py; E.applyMask(inp, pr[k]); s.tick(inp); if (py0 === 80 && s.py > py0 && s.px <= 2000) drop = s.px; }
		}
		const PS = st.strategies.find((q) => q.key === 'precision');
		check('the precision stage: the pocket puzzle (a drop at px == 1976.0 exactly) routed by "exact landings" (CPU only), replayed, 0 deaths',
			st.stage === 'found' && st.result.strategy === 'exact landings' && pev && pev.deaths === 0 && pev.runTicks === st.result.runTicks && drop === 1976 && PS.state === 'found' &&
			st.log.some((x) => /exactly x = 1976 px/.test(x)), `${st.stage} ${st.result ? `${st.result.time} by ${st.result.strategy} after ${st.result.foundAfter} s, the drop at px ${drop}` : st.message}; ` +
			`${PS ? `${PS.state}: ${PS.detail}` : 'no precision strategy'}; ${st.log.filter((x) => /exact landings/.test(x)).slice(0, 4).join(' | ')}`);
	}

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
	// a GPU strategy whose tool finds no GPU memory for its context (another process holds it for a while: the game on the
	// laptop, a second search on the same GPU) starts again after GPU_RETRY_S (5 s), logged, instead of staying in error
	// for the whole search (cycle 5 on the shared H100: every move, straight and the GPU random runs lost for 30 min)
	const sc4 = path.join(HOME, 'cpu-oom.json'), log4 = path.join(HOME, 'cpu-oom.log');
	fs.writeFileSync(sc4, JSON.stringify({ log: log4, R, runs: {}, beam: null, oom: 1 }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 9, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, sc4], salts: false });
	st = await waitDone(40000);
	const L4 = fs.readFileSync(log4, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const G4 = st.strategies.filter((q) => !q.cpu), n4 = (c) => L4.filter((a) => a[0] === c).length;
	check('a GPU strategy out of GPU memory at its start (cuCtxSetLimit "out of memory"): started again after 5 s, logged, not in error for the search',
		G4.length === 2 && G4.every((q) => q.state !== 'error') && n4('explore') >= 2 && n4('beam') >= 2 &&
		st.log.filter((x) => /out of memory\); again in 5 s \(retry 1\)/.test(x)).length === 2 && st.stage === 'found' && st.elapsed >= 5,
		`GPU strategies ${G4.map((q) => `${q.key} ${q.state}${q.error ? ` (${q.error})` : ''}`).join(', ')}; launches explore ${n4('explore')}, beam ${n4('beam')}; ` +
		`${st.log.filter((x) => /again in/.test(x)).join(' | ')}; ${st.stage}; ${st.elapsed.toFixed(1)} s`);
}

// ---------------------------------------------------------------- the proof (eegpu prove: CPU only, no GPU)
// A stand-in for `eegpu prove`: logs its arguments, then prints the scenario's done line (after `wait` ms), or fails
// (`fail`: exit code 1).
const FAKE_PROVER = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
fs.appendFileSync(SC.log, JSON.stringify(args) + '\\n');
if (SC.fail) { process.stderr.write('test: the proof crashed\\n'); process.exit(1); }
setTimeout(() => process.stdout.write(JSON.stringify(Object.assign({ ev: 'done' }, SC.done)) + '\\n'), SC.wait || 0);
`;
/** user50 with the left run-up s tiles shorter (the wall and the ledge at (20, 43) moved right): no route, which only the
 *  proof shows (the reach field finds a way: it cannot measure a run-up) */
function user50Shorter(s) {
	const lv = ED.levelOf(Buffer.from(USER50, 'base64'));
	const W = lv.width;
	const cells = new Map(lv.cells.map((c) => [c[1] * W + c[0], c]));
	const set = (x, y) => cells.set(y * W + x, [x, y, 9]);
	for (let k = 0; k < s; k++) { for (let y = 40; y <= 42; y++) set(20 + k, y); for (let y = 43; y <= 48; y++) set(21 + k, y); }
	return ED.eelvlOf(Object.assign({}, lv, { cells: [...cells.values()] }));
}
async function proveSection() {
	section('prove: the proof next to the searches (eegpu prove, CPU only; no GPU)');
	const G = require('../src/gpu.js');
	const waitDone = async (limit) => {
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < limit) { await new Promise((r) => setTimeout(r, 100)); st = ED.state(); }
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 50)); st = ED.state(); }
		return st;
	};
	const noGpu = { available: false, why: 'test: no GPU' };
	const buf2 = user50Shorter(2);
	// ---- the real tool (the app's default: the native tool's `prove`, EEAT_PROOF unset); skipped without a build that
	// knows `prove` (an older one answers "unknown command prove" before it would load the NVIDIA driver)
	const tool = G.nativeTool();
	let skip = '';
	if (!tool) skip = 'no native build (node tools/build-native.js --exe is enough for the proof)';
	else {
		const r = require('child_process').spawnSync(tool, ['prove'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
		if (!/usage: eegpu prove/.test(`${r.stdout}${r.stderr}`)) skip = `the native build (${tool}) is older than eegpu prove: rebuild it (node tools/build-native.js --exe)`;
	}
	if (skip) console.log(`  skip the checks with the real proof: ${skip}`);
	else {
		delete process.env.EEAT_PROOF;
		// user50 with the left run-up 2 tiles shorter: the physics check finds a way, the proof shows there is none (with
		// the editor's reach file: it names this level, so the tool uses its cut-offs)
		ED.start({ eelvlB64: buf2.toString('base64'), seconds: 30, workers: 1 }, noGpu);
		let st = await waitDone(120000);
		check('user50 with the left run-up 2 tiles shorter: the physics check finds a way, the proof none: "No route (proven)", explained (the highest the ball gets, ' +
			'the nearest tile, the fastest run toward the trophy)', st.stage === 'not found' && st.impossible && st.impossible.by === 'prover' && st.physics && !st.physics.noWayUp &&
			st.physics.startCost > 0 && /^No route \(proven\): the trophy cannot be reached/.test(st.message) && /y = 624 \(row 39; the trophy is in row 35\)/.test(st.message) &&
			/the closest it gets is tile \(35, 39\), 4\.1 tiles from the trophy/.test(st.message) && /fastest rightward speed is 4\.26 px\/tick/.test(st.message) &&
			st.log.some((x) => /the proof: no input sequence reaches the trophy/.test(x)), `${st.stage} ${JSON.stringify(st.impossible || null)}: ${st.message}`);
		check('... the proof used the editor\'s reach file (its level fingerprint matches the proof\'s level: states cut off), and the search stopped at the check\'s ' +
			`${ED.NO_WAY_UP_S} s`, st.proof && st.proof.reach === 1 && st.proof.pruned > 0 && st.seconds === ED.NO_WAY_UP_S && st.elapsed < 25,
			`${JSON.stringify(st.proof && { reach: st.proof.reach, pruned: st.proof.pruned, sec: st.proof.sec })}; ${st.seconds} s; ${st.elapsed.toFixed(1)} s`);
		// user50 itself (a 263-tick route): never "impossible"
		ED.start({ eelvlB64: USER50, seconds: 15, workers: 1 }, noGpu);
		st = await waitDone(120000);
		check('user50 itself (a 263-tick route): the proof does not rule it out, and the verdict is not "impossible"', !st.impossible && st.proof && st.proof.verdict === 'reached' &&
			['not found', 'found'].includes(st.stage) && !/proven/.test(st.message) && st.log.some((x) => /the proof: it cannot rule a route out/.test(x)),
			`${st.stage}; proof ${st.proof ? `${st.proof.verdict} in ${st.proof.sec} s` : '-'}; ${st.message.slice(0, 140)}`);
		// the shorter level again, a 300 s search: the cached proof at once, the search capped at NO_WAY_UP_S (stopped here)
		ED.start({ eelvlB64: buf2.toString('base64'), seconds: 300, workers: 1 }, noGpu);
		for (const t0 = Date.now(); !(ED.state().proof) && ED.state().running && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 50));
		st = ED.state();
		check(`the same level again: the proof from the cache (no process), and the 300 s search capped at ${ED.NO_WAY_UP_S} s as a check`, st.running && st.proof && st.proof.cached &&
			st.proof.verdict === 'impossible' && st.seconds === ED.NO_WAY_UP_S && st.log.some((x) => new RegExp(`the proof: .*from the cache.*once it has searched ${ED.NO_WAY_UP_S} s`).test(x)),
			`${st.seconds} s; ${JSON.stringify(st.proof)}`);
		ED.stop();
		st = await waitDone(20000);
		check('... stopped: "stopped", not a verdict', st.stage === 'stopped' && !st.impossible, `${st.stage}: ${st.message}`);
		process.env.EEAT_PROOF = '0';
	}
	// ---- stand-ins for the proof (no native build needed)
	// a proof on a level with a route (a stand-in's answer): the route found anyway is a mistake in the proof, kept in
	// model_miss.json (the level, the route) and said in the log; the verdict is the route
	const plat = room(40, 20);
	for (let x = 10; x <= 14; x++) plat.push([x, 16, 9]);
	for (let x = 18; x <= 22; x++) plat.push([x, 13, 9]);
	for (let x = 26; x <= 31; x++) plat.push([x, 10, 9]);
	plat.push([29, 9, 121], [2, 17, 255]);
	const platBuf = ED.eelvlOf({ name: 'platforms', width: 40, height: 20, cells: plat });
	const fake = path.join(HOME, 'fake-prover.js');
	fs.writeFileSync(fake, FAKE_PROVER);
	const logOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
	const scenario = (name, sc) => { const f = path.join(HOME, `prove-${name}.json`), log = path.join(HOME, `prove-${name}.log`); fs.writeFileSync(f, JSON.stringify(Object.assign({ log }, sc))); return { f, log }; };
	const miss = path.join(C.DATA, 'editor', 'model_miss.json');
	try { fs.unlinkSync(miss); } catch (e) { /* none */ }
	const scI = scenario('imp', { wait: 300, done: { verdict: 'impossible', end: 'fixpoint', sec: 0.3, cells: 1000, pruned: 0, explain: null } });
	let st;
	ED.start({ eelvlB64: platBuf.toString('base64'), seconds: 6, workers: 1 }, noGpu, { prover: [process.execPath, fake, scI.f], proveSeconds: 7 });
	st = await waitDone(60000);
	const mj = C.readJSON(miss, null);
	const LI = logOf(scI.log);
	check('the proof (a stand-in) rules out a level with a route: the route wins, a mistake in the proof kept in model_miss.json and said in the log; its budget at most the search\'s',
		st.stage === 'found' && !st.impossible && mj && mj.by === 'prover' && !!mj.eelvlB64 && typeof mj.inputs === 'string' && mj.inputs.length > 0 && st.log.some((x) => /a mistake in the proof/.test(x)) &&
		LI.length === 1 && LI[0][0] === 'prove' && LI[0].includes('--seconds=6') && LI[0].some((a) => a.startsWith('--reach=')), `${st.stage}; model_miss ${mj ? mj.by : 'missing'}; ${JSON.stringify(LI[0])}`);
	check('... the page hides "Proven: no route exists." once a route is known', /st\.proof\.verdict === 'impossible' && !st\.result\)/.test(PAGE));
	try { fs.unlinkSync(miss); } catch (e) { /* none */ }
	// a failing proof: said in the log, the search as without it
	const scF = scenario('fail', { fail: true });
	ED.start({ eelvlB64: platBuf.toString('base64'), seconds: 4, workers: 1 }, noGpu, { prover: [process.execPath, fake, scF.f] });
	st = await waitDone(60000);
	check('a failing proof: said in the log, the search goes on as without it', st.stage === 'found' && !st.impossible && st.proof && st.proof.verdict === 'error' &&
		st.log.some((x) => /the proof failed: exit code 1: test: the proof crashed/.test(x)), `${st.stage}; ${JSON.stringify(st.proof)}`);
	// the searches end before the proof: the search waits for it (a slow stand-in), then says "No route (proven)"; while it
	// waits, only the proof runs (a CPU process): no busy file keeps a job's GPU searcher paused
	const scW = scenario('wait', { wait: 5000, done: { verdict: 'impossible', end: 'fixpoint', sec: 5, cells: 1000, pruned: 0,
		explain: { topY: 100, maxVxRight: 1, maxVxLeft: 2, nearest: [3, 6], nearestDist: 2, trophy: [3, 4], start: [3, 8], size: [8, 10] } } });
	// (the shorter user50: no route to find; the stand-in's explanation is its own)
	ED.start({ eelvlB64: buf2.toString('base64'), seconds: 3, workers: 1 }, noGpu, { prover: [process.execPath, fake, scW.f] });
	let busyWhileWaiting = null;
	for (const t0 = Date.now(); ED.state().running && Date.now() - t0 < 30000;) {
		if (busyWhileWaiting === null && ED.state().log.some((x) => /waiting for the proof/.test(x))) busyWhileWaiting = fs.existsSync(path.join(C.DATA, 'editor', 'busy'));
		await new Promise((r) => setTimeout(r, 50));
	}
	st = await waitDone(60000);
	check('the searches end first: the search waits for the proof ("waiting for the proof"), then "No route (proven)" with its explanation', st.stage === 'not found' &&
		st.impossible && st.impossible.by === 'prover' && st.log.some((x) => /waiting for the proof/.test(x)) && /no higher than y = 100 \(row 6; the trophy is in row 4\)/.test(st.message) &&
		/fastest speeds are 1\.00 px\/tick to the right and 2\.00 to the left/.test(st.message) && st.elapsed >= 4.5, `${st.stage} after ${st.elapsed.toFixed(1)} s: ${st.message}`);
	check('... while it waited for the proof alone, no busy file (a job\'s GPU searcher is not held for a CPU process)', busyWhileWaiting === false, String(busyWhileWaiting));
	// every strategy fails at once: the error at once, not after the proof
	const failCpu = path.join(HOME, 'fail-cpu.js');
	fs.writeFileSync(failCpu, '\'use strict\'; process.stderr.write(\'test: the CPU search crashed\\n\'); process.exit(3);');
	const scS = scenario('slow', { wait: 60000, done: { verdict: 'reached', end: 'goal', sec: 60, cells: 10, pruned: 0 } });
	ED.start({ eelvlB64: platBuf.toString('base64'), seconds: 60, workers: 1 }, noGpu, { prover: [process.execPath, fake, scS.f], cpu: [process.execPath, failCpu] });
	st = await waitDone(90000);
	check('every strategy fails at once: the error at once (the proof stopped, not waited for)', st.stage === 'error' && /test: the CPU search crashed/.test(st.message) &&
		st.proof && st.proof.state === 'stopped' && st.elapsed < 10, `${st.stage} after ${st.elapsed.toFixed(1)} s: ${String(st.message).slice(0, 100)}; proof ${st.proof && st.proof.state}`);
	// a proof that does not answer: killed its watchdog time after its budget, an error; the search goes on without it
	const scH = scenario('hang', { wait: 600000, done: { verdict: 'impossible', end: 'fixpoint', sec: 600, cells: 10, pruned: 0 } });
	ED.start({ eelvlB64: buf2.toString('base64'), seconds: 6, workers: 1 }, noGpu, { prover: [process.execPath, fake, scH.f], proveSeconds: 1, proveWatchdogS: 1 });
	st = await waitDone(60000);
	check('a proof that does not answer: killed 1 s after its 1 s budget (an error in the log), the search ends as without it', st.stage === 'not found' && !st.impossible &&
		st.proof && st.proof.verdict === 'error' && st.log.some((x) => /the proof failed: no answer 1 s after its 1 s/.test(x)) && st.elapsed < 15,
		`${st.stage} after ${st.elapsed.toFixed(1)} s; ${JSON.stringify(st.proof)}`);
	// the cache: a time limit is not kept (a busy machine's budget says nothing of the next search), a memory limit is
	const scT = scenario('time', { done: { verdict: 'limit', end: 'time', sec: 3, cells: 5000, pruned: 0 } });
	const scC = scenario('cells', { done: { verdict: 'limit', end: 'cells', sec: 3, cells: 6000001, pruned: 0 } });
	const runs = [];
	for (const sc of [scT, scT, scC, scC]) {
		ED.start({ eelvlB64: buf2.toString('base64'), seconds: 2, workers: 1 }, noGpu, { prover: [process.execPath, fake, sc.f] });
		st = await waitDone(30000);
		runs.push(st.proof ? `${st.proof.verdict}/${st.proof.end}${st.proof.cached ? ' (cache)' : ''}` : '-');
	}
	check('the cache: a time limit runs the proof again, a memory limit is read back', logOf(scT.log).length === 2 && logOf(scC.log).length === 1 && runs[3] === 'limit/cells (cache)' &&
		st.log.some((x) => /the proof: no verdict within its memory \(from the cache\)/.test(x)), `${runs.join(', ')}; runs: time ${logOf(scT.log).length}, cells ${logOf(scC.log).length}`);
	// every GPU strategy has ended with a route (stand-ins for eegpu), the proof still running: the CPU search stops with
	// them, the proof with it (the proof, a CPU process, is no GPU strategy)
	const W = 30, H = 8;
	const ladder = ED.eelvlOf({ name: 'ladder', width: W, height: H, cells: [...room(W, H), [2, 6, 255], [20, 6, 121]] });
	const R = C.evaluate(E.prepareLevel(EL.toSimLevel(EL.readEelvl(ladder))), new Uint8Array(300).fill(4)).ms.length;
	const fakeGpu = path.join(HOME, 'fake-eegpu-prove.js');
	fs.writeFileSync(fakeGpu, FAKE);
	const scG = path.join(HOME, 'prove-ladder.json');
	fs.writeFileSync(scG, JSON.stringify({ log: path.join(HOME, 'prove-ladder.log'), R, runs: { '-1': [{ end: 'time', layers: 5000, wait: 4000, hold: 4000 }], 0: [{ end: 'finish', idle: 0, layers: 3 }] }, beam: null }));
	const scP = scenario('ladder-proof', { wait: 20000, done: { verdict: 'reached', end: 'goal', sec: 20, cells: 10, pruned: 0 } });
	ED.start({ eelvlB64: ladder.toString('base64'), seconds: 60, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fakeGpu, scG], salts: false, prover: [process.execPath, fake, scP.f] });
	st = await waitDone(60000);
	const Qc = st.strategies.find((q) => q.cpu);
	check('the GPU strategies end with a route while the proof runs: the CPU search stops with them (not after the proof), the proof too', st.stage === 'found' && Qc && !Qc.live &&
		st.proof && st.proof.state === 'stopped' && st.elapsed < 15, `${st.stage} after ${st.elapsed.toFixed(1)} s; ${st.strategies.map((q) => `${q.key}:${q.state}`).join(' ')}; proof ${st.proof && st.proof.state}`);
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
// A stand-in for the CPU search next to the path skips (strategy 'skips', the real src/skipfind.js --lane=1): it reports
// the scenario's attempt as its closest attempt, logs every stdin line, and once a "seed" or "import" line came (a
// shortcut from the path skips) reports the scenario's slow route
const FAKE_CPU_LANE = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'fine', startCost: 40 });
setTimeout(() => say({ ev: 'closest', dist: 5, tick: SC.attempt.length, inputs: SC.attempt }), 200);
let routed = false;
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 5, found: routed ? SC.route.length : 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
let buf = '';
process.stdin.on('data', (d) => {
	buf += String(d);
	let k;
	while ((k = buf.indexOf('\\n')) >= 0) {
		const line = buf.slice(0, k); buf = buf.slice(k + 1);
		fs.appendFileSync(SC.stdinLog, line + '\\n');
		if (line === 'stop') end();
		if (!routed && /^(seed|import) /.test(line)) { routed = true; setTimeout(() => say({ ev: 'result', kind: 'finish', ticks: SC.route.length, inputs: SC.route }), 300); }
	}
});
process.stdin.on('end', end);
`;
async function laneSection() {
	section('path skips: the skip finder inside Find a route (the real src/skipfind.js --lane=1 next to a stand-in CPU search; no GPU)');
	// the skip finder's loop room (test/skipfind.js room 2): the run walks right, turns back left for a while (a misguided
	// loop), then walks right into a block, pushes against it, jumps over it and walks to the trophy. The stand-in's
	// nearest attempt is that run's first 300 ticks; its route (reported once a shortcut reached it) the whole run
	const W = 160, H = 8, cells = room(W, H);
	cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [22, H - 2, 9]);
	const buf = ED.eelvlOf({ name: 'lane loop', width: W, height: H, cells });
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
	const raw = [];
	for (const [m, n] of [[4, 40], [2, 60], [4, 120], [5, 3], [4, 600]]) for (let k = 0; k < n; k++) raw.push(m);
	const ev = C.evaluate(L, Uint8Array.from(raw));
	check('the loop room: the slow run finishes', !!ev, ev && `${ev.runTicks} run ticks`);
	if (!ev) return;
	const str = (ms) => C.eetasBytes(ms).toString('latin1');
	const attempt = ev.ms.subarray(0, 300);
	const endOf = (ms) => { const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput(); for (const m of ms) { E.applyMask(inp, m); sim.tick(inp); if (sim.is_dead) return null; } return sim.stateHash(); };
	const hEnd = endOf(attempt);
	const fake = path.join(HOME, 'fake-cpu-lane.js'), sc = path.join(HOME, 'lane.json'), stdinLog = path.join(HOME, 'lane-stdin.log');
	fs.writeFileSync(fake, FAKE_CPU_LANE);
	fs.writeFileSync(sc, JSON.stringify({ attempt: str(attempt), route: str(ev.ms), stdinLog }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 4 }, { available: false },
		{ cpu: [process.execPath, fake, sc], skips: true, laneArgs: ['--depth=200', '--deepDepth=200', '--horizon=600', '--cap=20000', '--log2=22', '--deepLog2=22', '--perS=20', '--deepPerS=20'] });
	const t0 = Date.now();
	let st = ED.state(), firstR = null;
	while (st.running && !(st.result && /path skips/.test(st.result.strategy)) && Date.now() - t0 < 60000) {
		await new Promise((z) => setTimeout(z, 50));
		st = ED.state();
		if (st.result && !firstR) firstR = st.result;
	}
	if (st.result && !firstR) firstR = st.result;
	ED.stop();
	while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
	const lines = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8').split('\n').filter(Boolean) : [];
	const lane = st.strategies.find((q) => q.key === 'skips');
	check('the path skips run next to the CPU search: "path skips", its own threads (a quarter of the CPU search\'s 4, from idle threads or its own)',
		!!lane && lane.label === 'path skips' && lane.cpu && st.strategies.some((q) => q.key === 'goexplore'), st.strategies.map((q) => `${q.key}:${q.label}:${q.state}`).join(', '));
	// the CPU search got the shortcut as a seed (CPU only: no one search): whole inputs that end in the attempt's end state,
	// sooner
	const seeds = lines.filter((l) => l.startsWith('seed ')).map((l) => Uint8Array.from(l.slice(5), (c) => (c.charCodeAt(0) - 48) & 31));
	const short = seeds.filter((ms) => ms.length <= attempt.length - 20 && endOf(ms) === hEnd);
	check('before any route: a later point of the nearest attempt reached sooner, into the CPU search\'s archive (a seed line: the attempt\'s end state, 20+ ticks sooner)',
		short.length > 0, `${seeds.length} seed line(s), ${short.length} ending in the attempt's end state sooner${short.length ? ` (${attempt.length} -> ${Math.min(...short.map((x) => x.length))} ticks)` : ''}; ${(st.log || []).filter((x) => /path skips/.test(x)).slice(-2).join(' | ')}`);
	// the CPU search's slow route: spliced with the path skips' shortened attempt before it counts (found(): the editor's
	// library of the lane's shortcuts), so the FIRST route the search reports already takes the skip: replayed, S.result
	const r = firstR;
	const rv = r ? C.evaluate(L, Uint8Array.from(r.inputs, (c) => (c.charCodeAt(0) - 48) & 31)) : null;
	check('the first route the search reports already takes the skip: the CPU search\'s slow route spliced with the path skips\' shortcut (replayed in the JS engine), at least 20 run ticks faster',
		!!r && /path skips/.test(r.strategy) && !!rv && rv.runTicks === r.runTicks && r.runTicks <= ev.runTicks - 20, r ? `${ev.runTicks} -> ${r.runTicks} (${r.strategy}${r.spliced ? `: ${r.spliced}` : ''}) after ${r.foundAfter} s` : `no result (${st.stage}); ${(st.log || []).slice(-3).join(' | ')}`);
	// (the lane's own route search: test/skipfind.js, "the whole run as the best route -> a faster route")
}
const USER50 = 'xZTZTsJAFIY/wA3FBcUNxRYo++4LeGG8MPEBjHdGS2KCkJio8c431/yVQqc1xMSI82XaOefMxXxnmpIYjp5JX1zb50/uq31559pX7os7AE41z97hA2PESD3e3rv2qN8fPAxdIPlViN941TgJFlhkiWVWSLLKGinW2WCTLdJss0OGXfbY54BDshxxTI4TLGzyFCjiUKJMhSo16jRo0qJNhy49+Lc5PZsindVfmW/LWPn7c1iTtensZ2d1JrgnG4qsmXEGy4ii9d9n5nDr3tf19yPmuchGPjKSk6zkJTO5yU5+MpSjLOUpU7nKVr4ylrOs5S1zucte/uqAeqAuBLEn5McUxhQnOAFKAcrfUvkBVYNaiHqIhkEzQitCO0InQjdCbw7A2/j+4zjes8j0x+fnGp8=';

(async () => {
	roundtripSection();
	checksSection();
	await physicsCheckSection();
	if (want('app')) await appSection();
	if (want('passes')) await passesSection();
	if (want('cpu')) await cpuSection();
	if (want('prove')) await proveSection();
	if (want('lane')) await laneSection();
	if (GPU && want('gpu')) await gpuSection();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
