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
//              parse, check, solve refusals, a job from a route (Watch / Optimize); the search frontier, the exploration
//              view (the heat merged from the server's answers, its pixels by the first visit, the blocks cut out of it,
//              the trails and their palette) and Follow (its replay, camera lead and bounds, no restart on a new nearest
//              attempt, the route switch, the seek bar and End / Home, what stops it, a stopping click paints nothing):
//              the page's code cut out and run on fake canvases
//   explore    the exploration view's data: src/heat.js (the first visits too); goexplore.js --heat=1 (one worker: its heat's tiles = the tiles its
//              archive made cells in; off: the same search, no event); the GPU random runs' heat with a stand-in for eegpu
//              roll (on or off: the same search); the editor's merge of a stand-in search's heat and attempts, its trails,
//              GET /api/editor/solve/heat (deltas since a version, another search starting over)
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
//   escape     the stall escape (the real src/goexplore.js --prefix next to a stand-in CPU search that stalls): the escape
//              from the nearest attempt 60 ticks back routes, on half the workers (the stalled search parks the rest and
//              gets them back), its attempts into the stalled search's archive; the rotation: a nearest attempt in a pit (the
//              first escape ends there), the next from 600 ticks back routes; the frontier (a short nearest attempt by the
//              spawn: the escape starts from a room's long attempt); the retarget (that escape stays while nothing gets
//              nearer, and gives way once the search gets clearly nearer after its start); escape: false = none (these
//              with the rotation of before: every escape as the search, from the nearest attempt's starts); the stall
//              rotation: its configurations' list, kinds of start and turns (pure), then with stand-ins (escapes that log
//              their command line): the configurations in order on each escape's command line (reach skipped without a
//              steer field, deaths taken where something kills), the starts in rotation (a room's first arrival, the least
//              explored room, the nearest attempt), the first escape after escFirst, the next one at once
//   gpu        (--gpu) short route searches on the GPU (at most 60 s each), verified in the JS engine
// usage: node test/editor.js [--gpu] [--seed=N] [--only=app,explore,passes,cpu,prove,lane,escape,gpu]      Exit code 1 if any check
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
// --only=a,b: only the sections whose names are given (app, explore, passes, cpu, prove, lane, escape, gpu); the fast ones always run
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
const HX = require('../src/heat.js');

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
/** a function of the page's script by its name (`function name(` at column 0 up to its closing `}` at column 0), and a
 *  one-line `const name = ...` (the review suite's way of running the page's own code) */
function pageFnSrc(name) {
	const lines = PAGE.split('\n');
	const k = lines.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l));
	if (k < 0) return '';
	// (a one-line function: that line)
	let depth = 0;
	for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
	if (depth === 0 && /\}\s*$/.test(lines[k])) return lines[k];
	const e = lines.indexOf('}', k);
	return e < 0 ? '' : lines.slice(k, e + 1).join('\n');
}
const pageConstSrc = (name) => { const x = PAGE.match(new RegExp(`^const ${name} = .*$`, 'm')); return x ? x[0] : ''; };
/** a stand-in for a canvas 2D context: the calls (with the styles they drew in), the standard methods the page may use */
function fakeCtx() {
	const calls = [], st = [];
	const g = { calls, strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter', lineCap: 'butt', dash: [] };
	const rec = (name) => (...a) => { calls.push({ name, a, stroke: g.strokeStyle, fill: g.fillStyle, width: g.lineWidth, alpha: g.globalAlpha, dash: g.dash.slice(), font: g.font }); };
	for (const m of ['beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'closePath', 'stroke', 'fill', 'fillText', 'clearRect', 'fillRect', 'strokeRect', 'rect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'translate', 'scale', 'clip', 'setTransform']) g[m] = rec(m);
	g.save = () => { st.push({ strokeStyle: g.strokeStyle, fillStyle: g.fillStyle, lineWidth: g.lineWidth, globalAlpha: g.globalAlpha, dash: g.dash }); calls.push({ name: 'save', a: [] }); };
	g.restore = () => { Object.assign(g, st.pop() || {}); calls.push({ name: 'restore', a: [] }); };
	g.setLineDash = (d) => { g.dash = d.slice(); };
	g.getLineDash = () => g.dash.slice();
	g.measureText = (s) => ({ width: String(s).length * 7 });
	g.createRadialGradient = (...a) => ({ a, stops: [], addColorStop(k, c) { this.stops.push([k, c]); } });
	g.drawImage = rec('drawImage');
	return g;
}
/**
 * The search frontier (editor.html: frontierOf, drawFrontier, gotoFrontier, glideStep cut out of the page and run): the
 * toggle in the map toolbar (on by default, remembered), F and the closest attempt's "Go to", the layer above the map; the
 * marker's drawing on a fake canvas context from a sample closest path: the ring at the path's end (its size at every
 * zoom), the pulse while the search runs (none once it stopped or the level changed), the brighter trail, the label;
 * off the view an arrow on its edge; hidden once a route is known or turned off.
 */
function frontierChecks() {
	const tools = (PAGE.match(/<div class="tools" id="tools">[\s\S]*?<\/div>/) || [''])[0];
	check('the search frontier: a "search frontier" toggle in the map toolbar (on by default, remembered), its own layer above the map (clicks pass through), F and the closest attempt\'s "Go to" take the map there',
		/<label class="ck"[^>]*><input type="checkbox" id="cFrontier" checked> search frontier<\/label>/.test(tools) &&
		/<canvas id="cv"><\/canvas><canvas id="cvFx" class="fx" aria-hidden="true"><\/canvas>/.test(PAGE) && /\.stage canvas\.fx \{ pointer-events: none; \}/.test(PAGE) &&
		/^const FX = \{ on: store\.get\('eeat\.editor\.frontier'\) !== '0',/m.test(PAGE) && /store\.set\('eeat\.editor\.frontier', FX\.on \? '1' : '0'\)/.test(PAGE) &&
		/^\$\('cFrontier'\)\.checked = FX\.on;$/m.test(PAGE) && /if \(k === 'f' \|\| k === 'F'\) \{ gotoFrontier\(\); return; \}/.test(PAGE) &&
		/<button class="small" id="cGoto"[^>]*>[^<]*Go to<\/button>/.test(PAGE) && /\$\('cGoto'\)\.onclick = \(\) => gotoFrontier\(\);/.test(PAGE) &&
		// (the layer redraws with the map, and on its own while it pulses; it follows the window's size)
		/if \(VW\.dirty\) \{ VW\.dirty = false; draw\(\); FX\.dirty = true; \} else mapIdle\(now\);\n\tif \(FX\.dirty \|\| \(FX\.live && now - FX\.at >= FX_FRAME_MS\)\) drawFx\(now\);/.test(PAGE) &&
		/if \(fx\.width !== w \|\| fx\.height !== h\) \{ fx\.width = w; fx\.height = h; again = true; \}/.test(PAGE));
	// (FOL, followSet: F / "Go to" stop Follow, see followChecks)
	const env = { $: () => ({ textContent: '' }), SOLVE: { st: null }, VW: { zi: 2, camX: 0, camY: 0, glide: null, dirty: false }, performance: { now: () => 1000 }, changedView: () => {},
		FOL: { on: false }, followSet: () => {} };
	const code = [pageConstSrc('fmt'), pageConstSrc('clamp'), pageConstSrc('ZOOMS'), ...['tracePath', 'frontierOf', 'drawFrontier', 'gotoFrontier', 'glideStep'].map(pageFnSrc)].join('\n');
	let F = null;
	const fe = errOf(() => { F = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { frontierOf, drawFrontier, gotoFrontier, glideStep, ZOOMS };`)(...Object.values(env)); });
	check('the search frontier\'s functions cut out of the page run', !!F, fe ? fe.message : undefined);
	if (!F) return;
	// a sample closest attempt: 320 ticks right along a floor, up a step, a portal jump (not joined) and on
	const path = [];
	for (let t = 0; t <= 320; t++) path.push(t < 200 ? [40 + t * 2, 88] : t < 260 ? [440 + (t - 200), 88 - (t - 200)] : [900 + (t - 260) * 3, 40]);
	const closest = { dist: 13.4, tiles: 13.4, ticks: 320, runTicks: 312, time: '0:03.12', path, strategy: 'random runs (CPU)', inputs: '4'.repeat(320) };
	const st = { running: true, stage: 'searching', result: null, closest };
	const f = F.frontierOf(st, true, false);
	const end = path[path.length - 1];
	check('frontierOf: the end of the closest attempt\'s path, "nearest: <tiles> · <time> · <strategy>", pulsing while the search runs',
		f && f.x === end[0] && f.y === end[1] && f.label === 'nearest: 13.4 tiles · 0:03.12 · random runs (CPU)' && f.pulse && !f.stale && f.P === path, JSON.stringify(f && { x: f.x, y: f.y, label: f.label, pulse: f.pulse }));
	const lab = (c) => { const x = F.frontierOf({ running: true, closest: Object.assign({}, closest, c) }, true, false); return x && x.label; };
	const stopped = F.frontierOf(Object.assign({}, st, { running: false, stage: 'stopped' }), true, false), stale = F.frontierOf(st, true, true);
	check('frontierOf: a stopped search keeps it (still), an edited level dims it (still); hidden once a route is known, with the toggle off, without a closest attempt or its path; labels',
		stopped && !stopped.pulse && !stopped.stale && stale && !stale.pulse && stale.stale &&
		F.frontierOf(Object.assign({}, st, { result: { time: '0:05.00', path } }), true, false) === null && F.frontierOf(st, false, false) === null &&
		F.frontierOf({ running: true, closest: null }, true, false) === null && F.frontierOf({ running: true, closest: Object.assign({}, closest, { path: [] }) }, true, false) === null &&
		F.frontierOf(null, true, false) === null && lab({ tiles: 280 }) === 'nearest: 280 tiles · 0:03.12 · random runs (CPU)' && lab({ tiles: 1 }) === 'nearest: 1 tile · 0:03.12 · random runs (CPU)' &&
		lab({ tiles: 0 }) === 'nearest: at the trophy · 0:03.12 · random runs (CPU)' && lab({ strategy: 'x'.repeat(60) }).endsWith(`${'x'.repeat(42)}…`),
		JSON.stringify([stopped && stopped.pulse, stale && stale.pulse, lab({ tiles: 280 }), lab({ tiles: 1 }), lab({ tiles: 0 })]));
	// drawn: the level's origin (30, 20) on a 1200 x 700 canvas, 16 px a tile (s = 1), device pixel ratio 1
	const draw = (fr, s, d, now, ox, oy, cw, ch) => { const g = fakeCtx(); const e = errOf(() => F.drawFrontier(g, fr, ox, oy, s, d, now, cw, ch)); return { g, e, c: g.calls }; };
	const finite = (c) => c.every((q) => q.a.every((v) => typeof v !== 'number' || Number.isFinite(v)));
	const inside = (c, cw, ch) => c.filter((q) => q.name === 'fillText').every((q) => q.a[1] >= 0 && q.a[1] <= cw && q.a[2] >= 0 && q.a[2] <= ch);
	const X = 30 + end[0], Y = 20 + end[1];
	const A = draw(f, 1, 1, 250, 30, 20, 1200, 700);
	const arcs = A.c.filter((q) => q.name === 'arc' && Math.abs(q.a[0] - X) < 1e-9 && Math.abs(q.a[1] - Y) < 1e-9);
	const ring = arcs.filter((q) => q.a[2] === 12), pulse = arcs.filter((q) => q.a[2] > 12 + 1e-9);
	const text = A.c.filter((q) => q.name === 'fillText').map((q) => q.a[0]).join('');
	// the trail: the last 300 ticks in 6 pieces (a glow and a bright core each), older fainter; the jump of more than 40 px not joined
	const trail = A.c.filter((q) => (q.name === 'moveTo' || q.name === 'lineTo') && q.a[1] <= 20 + 88 + 1e-9 && q.a[0] >= 30 + path[20][0]);
	const alphas = A.c.filter((q) => q.name === 'stroke' && /^rgba\(255,228,184,/.test(q.stroke)).map((q) => +q.stroke.split(',')[3].replace(')', ''));
	check('drawFrontier (a fake canvas context, the sample path, 16 px a tile): the ring at the path\'s end (12 px of the level), two pulse rings outside it, the attempt\'s last 300 ticks brighter toward the end, ' +
		'the label "nearest: 13.4 tiles · 0:03.12 · random runs (CPU)" inside the map, nothing but finite numbers, save / restore paired',
		!A.e && ring.length === 1 && pulse.length === 2 && text === 'nearest: 13.4 tiles · 0:03.12 · random runs (CPU)' && finite(A.c) && inside(A.c, 1200, 700) &&
		A.c.filter((q) => q.name === 'save').length === A.c.filter((q) => q.name === 'restore').length &&
		alphas.length === 6 && alphas.every((a, k) => k === 0 || a > alphas[k - 1]) && Math.abs(alphas[5] - 0.95) < 1e-9 &&
		trail.filter((q) => q.name === 'lineTo').length >= 290 * 2 - 30 && A.c.filter((q) => q.name === 'moveTo' && q.a[0] === 30 + 900 && q.a[1] === 20 + 40).length >= 2,
		A.e ? A.e.stack : JSON.stringify({ ring: ring.length, pulse: pulse.map((q) => q.a[2]), text, alphas, trail: trail.length }));
	// the pulse moves; a stopped search and an edited level: no pulse; the edited level dashed and dim
	const B = draw(f, 1, 1, 700, 30, 20, 1200, 700), S = draw(stopped, 1, 1, 0, 30, 20, 1200, 700), D = draw(stale, 1, 1, 0, 30, 20, 1200, 700);
	const radii = (r) => r.c.filter((q) => q.name === 'arc' && q.a[2] > 12 + 1e-9 && Math.abs(q.a[0] - X) < 1e-9).map((q) => q.a[2]).sort((a, b) => a - b).join();
	const dashedRing = D.c.some((q) => q.name === 'arc' && q.a[2] === 12) && D.c.some((q) => q.name === 'stroke' && q.dash.length === 2 && q.stroke === '#ff9f43' && q.alpha === 0.55);
	check('drawFrontier: the pulse rings grow with the time; a stopped search: the ring alone (no pulse); an edited level: no pulse, the ring dashed at 55%',
		!B.e && !S.e && !D.e && radii(A) !== radii(B) && radii(B).split(',').length === 2 && radii(S) === '' && radii(D) === '' && dashedRing &&
		S.c.some((q) => q.name === 'arc' && q.a[2] === 12), `${radii(A)} | ${radii(B)} | ${radii(S)} | ${radii(D)} dashed ${dashedRing}`);
	// its size at every zoom: 12 px of the level, at least 10 and at most 56 CSS px (d: the device pixel ratio)
	const ringR = (s, d) => { const r = draw(f, s, d, 0, 0, 0, 1e5, 1e5); const q = r.c.filter((c) => c.name === 'arc' && Math.abs(c.a[0] - end[0] * s) < 1e-9 && Math.abs(c.a[1] - end[1] * s) < 1e-9); return r.e ? NaN : Math.min(...q.map((c) => c.a[2]).filter((v) => v > 4 * d)); };
	const sizes = [[1 / 16, 1], [1 / 16, 2], [0.5, 1], [1, 1], [2, 1.5], [4, 1], [4, 2], [8, 1]].map(([s, d]) => ringR(s, d));
	check('drawFrontier: the ring 12 px of the level (3/4 of a tile), at least 10 and at most 56 CSS px (canvas px: x the device pixel ratio): 10 at 1 canvas px a tile (20 at a ratio of 2), ' +
		'10 at 8, 12 at 16, 24 at 32, 48 at 64, 56 at 128', sizes.join() === [10, 20, 10, 12, 24, 48, 48, 56].join(), sizes.join());
	// off the view: an arrow on the right edge pointing at it, the label with "F goes there", no ring
	const O = draw(f, 1, 1, 0, 30 + 2000, 20, 1200, 700);
	const tri = O.c.findIndex((q) => q.name === 'fill' && q.fill === '#ff9f43');
	const otext = O.c.filter((q) => q.name === 'fillText').map((q) => q.a[0]).join('');
	const pts = O.c.slice(0, tri).filter((q) => q.name === 'moveTo' || q.name === 'lineTo').slice(-3);
	check('drawFrontier off the view: an orange arrow on the map\'s edge (pointing at it), the label "... · F goes there" inside the map, no ring',
		!O.e && tri > 0 && pts.length === 3 && pts.every((q) => q.a[0] > 1150 && q.a[0] <= 1200 && q.a[1] > 0 && q.a[1] < 700) && pts[0].a[0] > pts[1].a[0] &&
		otext === 'nearest: 13.4 tiles · 0:03.12 · random runs (CPU) · F goes there' && inside(O.c, 1200, 700) && finite(O.c) &&
		!O.c.some((q) => q.name === 'arc' && q.a[2] === 12), O.e ? O.e.stack : JSON.stringify({ tri, pts: pts.map((q) => q.a), otext }));
	// F / "Go to": at least 16 px a tile, the map glides to the end of the path
	env.SOLVE.st = st;
	F.gotoFrontier();
	const g0 = env.VW.glide && Object.assign({}, env.VW.glide), z0 = env.VW.zi;
	F.glideStep(1150);
	const mid = [env.VW.camX, env.VW.camY];
	if (env.VW.glide) F.glideStep(1400);
	const at = [env.VW.camX, env.VW.camY];
	env.VW.zi = 12;   // (already nearer: the zoom stays)
	F.gotoFrontier();
	const z1 = env.VW.zi;
	env.SOLVE.st = Object.assign({}, st, { result: { time: '0:05.00', path } });
	env.VW.glide = null; env.VW.zi = 3;
	F.gotoFrontier();
	check('F / "Go to": the map glides to the frontier (300 ms) at 16 px a tile or more, a nearer zoom kept; nothing once a route is known',
		g0 && g0.x1 === end[0] && g0.y1 === end[1] && F.ZOOMS[z0] === 16 && z1 === 12 && mid[0] > 0 && mid[0] < end[0] && at[0] === end[0] && at[1] === end[1] &&
		env.VW.glide === null && env.VW.zi === 3, JSON.stringify({ g0, z0, z1, mid, at, zi: env.VW.zi }));
}
/** a `const name = ...` of the page's script over as many lines as its brackets take (to a line ending in ';' where they
 *  balance) */
function pageBlockSrc(name) {
	const lines = PAGE.split('\n');
	const k = lines.findIndex((l) => l.startsWith(`const ${name} = `));
	if (k < 0) return '';
	let depth = 0;
	for (let e = k; e < lines.length; e++) {
		for (const ch of lines[e]) { if ('{(['.includes(ch)) depth++; else if ('})]'.includes(ch)) depth--; }
		if (depth === 0 && /;\s*$/.test(lines[e])) return lines.slice(k, e + 1).join('\n');
	}
	return '';
}
/** a stand-in for a page element: text, html, hidden, a class list, children by selector none */
function fakeEl() { const cls = new Set(); return { textContent: '', innerHTML: '', hidden: true, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) } }; }
/**
 * The exploration view and Follow (editor.html: heatReset, heatAdd, heatApply, heatPixel, heatGlow, heatRefresh, heatSolid,
 * heatPlace, drawTrails, drawExplore, followSrc, sameStart, followRetarget, followAim, followStep, followSet, followSeek,
 * followToEnd, drawFollow cut out of the page and run): the toolbar's "exploration" toggle (on by default, remembered) and
 * Follow (V), their canvases under the frontier's; the page's merge of the server's heat answers (src/heat.js
 * HeatMap.since: a full answer, a delta, the first visits (an older server's answer without them: the last visit when first
 * seen), another search starting over; the trails kept, at most EXP_TRAILS); the heat's pixels (the colour by the FIRST
 * visit: just found = cyan, found at the search's start = purple even when visited again now, the scale the search's time;
 * stronger with more visits (log), unvisited clear, a glow only for newly found tiles, in the same image); the solid blocks
 * clear (not a door it went through); the heat updated incrementally (the answers one at a time = the whole heat at once; a
 * new tile draws its 3 x 3; the colours' ageing in slices); the heat's canvas a pixel a tile placed by a CSS transform, never
 * resized by an update; the trails on a fake canvas context (a jump not joined, faded by age, gone after EXP_TRAIL_FADE, the
 * newest brightest, at most EXP_TRAILS_K a search, one stroke per colour and alpha, only what is in the canvas) and their
 * palette; drawExplore on stand-in canvases (a pan moves the layers by their transforms, the trails drawn again past their
 * margin, on a zoom and while fading); the map's level cache (mapCacheChecks); the best route's panel (improveChecks);
 * Follow (followChecks).
 */
async function exploreViewChecks() {
	const tools = (PAGE.match(/<div class="tools" id="tools">[\s\S]*?<\/div>/) || [''])[0];
	check('the exploration view: an "exploration" toggle in the map toolbar (on by default, remembered), a Follow button and V, the heat and trail canvases under the frontier\'s (clicks pass through; the heat\'s a pixel a tile, placed by a CSS transform), the heat polled with the search\'s state',
		/<input type="checkbox" id="cExplore" checked> exploration<\/label>/.test(tools) && /<button id="bFollow"[^>]*>[^<]*Follow<\/button>/.test(tools) &&
		/<canvas id="cvHeat" class="fx heat" aria-hidden="true"><\/canvas><canvas id="cvTrail" class="fx" aria-hidden="true"><\/canvas>/.test(PAGE) &&
		/#cvHeat \{ z-index: 1; mix-blend-mode: screen; \} #cvTrail \{ z-index: 2; \} #cvFx \{ z-index: 3; \}/.test(PAGE) &&
		/\.stage canvas\.heat \{ inset: auto; left: 0; top: 0; width: auto; height: auto; transform-origin: 0 0; will-change: transform; \}/.test(PAGE) &&
		/^const EXP = \{ on: store\.get\('eeat\.editor\.explore'\) !== '0',/m.test(PAGE) && /store\.set\('eeat\.editor\.explore', EXP\.on \? '1' : '0'\)/.test(PAGE) &&
		/if \(k === 'v' \|\| k === 'V'\) \{ followSet\(!FOL\.on\); return; \}/.test(PAGE) && /\n\tif \(EXP\.on\) pollHeat\(\);/.test(PAGE) &&
		/\/api\/editor\/solve\/heat\?search=\$\{EXP\.search\}&since=\$\{EXP\.version\}&trail=\$\{EXP\.trailId\}/.test(PAGE) &&
		/if \(EXP\.on \|\| EXP\.shown\) drawExplore\(now\);/.test(PAGE) && /if \(FOL\.on\) followStep\(now\);/.test(PAGE));
	// (a pan, a drag or a click on the map, the wheel, a zoom (the buttons, + / -), Fit, F / "Go to" and Escape stop Follow)
	const stops = ['cv.addEventListener(\'pointerdown\'', 'cv.addEventListener(\'wheel\'', 'function zoom(', 'function fit(', 'function gotoFrontier(', 'if (k === \'Escape\')'].map((h) => {
		const i = PAGE.indexOf(h);
		return i >= 0 && /if \(FOL\.on\) \{?\s*followSet\(false\);/.test(PAGE.slice(i, i + 260));
	});
	check('Follow stops on a pan, a drag or a click on the map, the wheel, a zoom, Fit, F / "Go to" and Escape', stops.every(Boolean), stops.join());
	{
		// (the UI review, 2026-09-29: with Follow on and the paint tool, one click stopped Follow AND painted a block: the level
		// then no longer the one searched, the heat dimmed, the trails gone)
		const i = PAGE.indexOf('cv.addEventListener(\'pointerdown\''), body = PAGE.slice(i, PAGE.indexOf('\n});', i));
		const stopAt = body.indexOf('followSet(false);'), retAt = body.indexOf('if (e.button === 0 && !VW.space) { e.preventDefault(); return; }'), paintAt = body.indexOf('paintCell(');
		check('a plain left click that stops Follow paints nothing (the handler returns before the tools; a right / middle / Space drag still pans)', stopAt > 0 && retAt > stopAt && paintAt > retAt &&
			body.indexOf('VW.pan = {') > retAt && body.slice(stopAt, retAt).split('}').length === 1, JSON.stringify({ stopAt, retAt, paintAt }));
		check('Follow\'s keys: End to the frontier, Home to the start (only while following); the panel\'s seek bar and end button',
			/if \(FOL\.on && \(k === 'End' \|\| k === 'Home'\)\) \{ e\.preventDefault\(\); if \(k === 'End'\) followToEnd\(\); else followSeek\(0\); return; \}/.test(PAGE) &&
			/<input type="range" id="fSeek"/.test(PAGE) && /<button id="fEnd"/.test(PAGE) && /\$\('fEnd'\)\.onclick = \(\) => followToEnd\(\);/.test(PAGE) && /sk\.addEventListener\('input', \(\) => followSeek\(\+sk\.value\)\);/.test(PAGE));
	}
	// ---- the page's merge of the server's answers (the server's own HeatMap)
	const perf = { t: 0, now() { return this.t; } };
	const LVh = { W: 4, H: 2, fg: new Int32Array(8), kind: new Map() };
	const env = { performance: perf, atob: (s) => Buffer.from(String(s), 'base64').toString('latin1'), LV: LVh, editVersion: 0 };
	const consts = ['TRAIL_MARGIN', 'HEAT_SPAN_MIN', 'HEAT_STOPS', 'heatSpan', 'solidIds'].map(pageConstSrc).join('\n');
	const heatFns = ['b64u8', 'heatReset', 'heatTodo', 'heatAdd', 'heatApply', 'heatPixel', 'heatGlow', 'heatRefresh', 'solidBlock', 'heatSolid', 'traceFlat', 'drawTrails'];
	const code = [pageConstSrc('clamp'), consts, pageBlockSrc('HEAT_LUT'), pageBlockSrc('EXP_COLORS'), pageConstSrc('expColor'), ...heatFns.map(pageFnSrc)].join('\n');
	let F = null;
	const fe = errOf(() => {
		F = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { ${heatFns.join(', ')}, EXP_TRAILS, EXP_TRAILS_K, EXP_TRAIL_FADE, EXP_TAIL, EXP_GLOW_MS, EXP_AGE_MS, EXP_AGE_SLICES, ` +
			'HEAT_SPAN_MIN, HEAT_GLOW, HEAT_GLOW_A, HEAT_A, EXP_COLORS, expColor };')(...Object.values(env));
	});
	check('the exploration view\'s functions cut out of the page run', !!F && heatFns.every((f) => typeof F[f] === 'function'), fe ? fe.message : undefined);
	if (!F) return;
	const W = 30, H = 20, HM = new HX.HeatMap(W, H);
	HM.merge([5, 6, 7], 1000); HM.merge([7, 100], 3000);
	const E = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
	const answer = (since, extra) => Object.assign({ search: 111, running: true, t: 3500, w: W, h: H }, HM.since(since), { trailId: 0, trails: [] }, extra || {});
	F.heatApply(E, answer(0), 50);
	const s1 = { v: E.version, visited: E.visited, c7: E.count[7], f7: E.first[7], l7: E.last[7], c5: E.count[5], f100: E.first[100], l100: E.last[100], list: E.list.slice().sort((a, b) => a - b).join() };
	HM.merge([100, 200], 5000);
	F.heatApply(E, answer(E.version, { t: 5200 }), 90);
	const s2 = { v: E.version, visited: E.visited, c100: E.count[100], f100: E.first[100], l100: E.last[100], c200: E.count[200], f200: E.first[200], c7: E.count[7], t: E.t, tAt: E.tAt };
	check('the page\'s heat from the server\'s answers (src/heat.js HeatMap.since): every visited tile at first (counts, first and last visits), then the delta since its version (a tile seen again: its new count and last visit, its first visit kept)',
		s1.v === 2 && s1.visited === 4 && s1.c7 === 2 && s1.f7 === 1000 && s1.l7 === 3000 && s1.c5 === 1 && s1.f100 === 3000 && s1.l100 === 3000 && s1.list === '5,6,7,100' &&
		s2.v === 3 && s2.visited === 5 && s2.c100 === 2 && s2.f100 === 3000 && s2.l100 === 5000 && s2.c200 === 1 && s2.f200 === 5000 && s2.c7 === 2 && s2.t === 5200 && s2.tAt === 90, JSON.stringify({ s1, s2 }));
	{
		// (an older server: no first visits in the answer; the first is the last visit when the page first sees the tile)
		const E0 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
		const HO = new HX.HeatMap(W, H);
		const ans = (since) => { const a = Object.assign({ search: 112, running: true, t: 9000, w: W, h: H }, HO.since(since), { trailId: 0, trails: [] }); delete a.first; return a; };
		HO.merge([9], 2000); F.heatApply(E0, ans(0), 1); HO.merge([9, 10], 8000); F.heatApply(E0, ans(E0.version), 2);
		check('... an answer without first visits (an older server): the first is the last visit when the page first saw the tile', E0.first[9] === 2000 && E0.last[9] === 8000 && E0.first[10] === 8000 && E0.count[9] === 2,
			JSON.stringify({ f9: E0.first[9], l9: E0.last[9], f10: E0.first[10] }));
	}
	// another search: from scratch (another level size too)
	const HM2 = new HX.HeatMap(10, 10);
	HM2.merge([3], 100);
	F.heatApply(E, Object.assign({ search: 222, running: true, t: 200, w: 10, h: 10 }, HM2.since(0), { trailId: 0, trails: [] }), 100);
	check('another search starts the page\'s heat over (its size, no tile of the last one)', E.search === 222 && E.W === 10 && E.count.length === 100 && E.first.length === 100 && E.visited === 1 && E.count[3] === 1 && E.version === 1 &&
		E.s0.length === 100 && E.all === true, JSON.stringify({ search: E.search, W: E.W, visited: E.visited, v: E.version }));
	// the trails: appended, at most EXP_TRAILS (the newest)
	const mk = (id, k, t) => ({ id, k, label: k, t, ticks: 100, pts: [0, 0, 16, 0, 32, 0, 48, 16], br: [] });
	F.heatApply(E, Object.assign({ search: 222, running: true, t: 300, w: 10, h: 10 }, HM2.since(1), { trailId: 70, trails: Array.from({ length: 70 }, (_, k) => mk(k + 1, 'goexplore', k * 10)) }), 110);
	check('the trails: appended as they come, the newest EXP_TRAILS (60) kept, the page\'s trail id the newest', E.trails.length === F.EXP_TRAILS && F.EXP_TRAILS === 60 && E.trails[0].id === 11 && E.trails[59].id === 70 && E.trailId === 70 && E.trailsDirty === true,
		`${E.trails.length} ${E.trails[0] && E.trails[0].id} ${E.trailId}`);
	// ---- the heat's pixels (heatRefresh into E.px, a pixel a tile, the glow in it): lone tiles (no visited neighbour: their own
	// colours), at tNow 100 s (the scale: 100 s)
	const mkE = (w, h) => { const X = { W: w, H: h, running: true, solid: null }; F.heatReset(X, w, h); X.px = new Uint8ClampedArray(w * h * 4); return X; };
	const visit = (X, t, c, f, l) => { X.count[t] = c; X.first[t] = f; X.last[t] = l; X.list.push(t); F.heatAdd(X, t, f, 1); X.fresh.push(t); };
	const rgba = (a, i) => Array.from(a.slice(4 * i, 4 * i + 4));
	const P = mkE(9, 9);
	visit(P, 10, 1, 100000, 100000);   // found just now, once
	visit(P, 16, 16, 100000, 100000);  // found just now, 16 visits
	visit(P, 64, 1, 5000, 99500);      // found at the start, visited again half a second ago
	visit(P, 70, 16, 99000, 99000);    // found a second ago, 16 visits
	const box0 = F.heatRefresh(P, 100000, 0);
	const ga = Array.from(P.galpha), lit = [10, 0, 40].map((i) => rgba(P.px, i));
	P.all = true;
	F.heatRefresh(P, 100000 + F.HEAT_GLOW + 1, 1000);
	const [f1, f16, old, sec] = [10, 16, 64, 70].map((i) => rgba(P.px, i));
	check('the heat\'s pixels by the FIRST visit: found just now cyan-white, found at the search\'s start purple (red above green) though visited again just now, more visits stronger (16 vs 1 at the same age), at most HEAT_A without the glow, unvisited clear',
		box0 && box0.join() === '0,0,8,8' && f1[1] > 200 && f1[2] > 200 && old[0] > old[1] && old[2] > 100 && old[1] < 80 && f16[3] > f1[3] && f1[3] > old[3] && sec[3] > 0 &&
		Math.max(f1[3], f16[3], old[3], sec[3]) <= Math.round(255 * F.HEAT_A) && rgba(P.px, 0)[3] === 0 && rgba(P.px, 40)[3] === 0,
		JSON.stringify({ box0, f1, f16, old, sec }));
	check('the glow in the heat\'s image: only around the tiles found in the last HEAT_GLOW (the tile and its neighbours, blurred), none for the old tile visited again; brighter where it glows; none at all once every tile was found longer ago',
		ga[10] > 0 && ga[11] > 0 && ga[10] > ga[11] && ga[70] > 0 && ga[64] === 0 && ga[63] === 0 && Math.abs(ga[10] - 0.25 * F.HEAT_GLOW_A / 255) < 1e-6 &&
		lit[0][3] > f1[3] && lit[1][3] > 0 && lit[2][3] === 0 && P.galpha.every((v) => v === 0) && P.glowSet.length === 0 && P.fresh.length === 0,
		JSON.stringify({ g10: ga[10], g11: ga[11], g64: ga[64], lit }));
	{
		// (the scale is the search's time: a tile found 100 s ago is purple in a 100-s search, still blue-cyan in a 400-s one)
		const Q = mkE(9, 9), Q2 = mkE(9, 9);
		visit(Q, 40, 1, 300000, 300000); F.heatRefresh(Q, 400000, 0);
		visit(Q2, 40, 1, 0, 0); F.heatRefresh(Q2, 100000, 0);
		const young = rgba(Q.px, 40), aged = rgba(Q2.px, 40);
		check('the heat\'s colour scale is the search\'s time (at least HEAT_SPAN_MIN): found 100 s ago in a 400-s search blue-cyan (green above red), in a 100-s search at its start deep purple',
			young[1] > young[0] && young[2] > 200 && aged[0] > aged[1] && F.HEAT_SPAN_MIN === 8000, JSON.stringify({ young, aged }));
	}
	{
		// ---- the blocks cut out of the heat: plain solids the search never visited stay clear, glow and all (not a door, not
		// unknown blocks, not a visited tile)
		LVh.fg.set([9, 9, 0, 23, 100, 9, 777, 0]);   // 9 solid, 23 a door, 100 a coin, 777 unknown
		for (const [id, k] of [[9, 'solid'], [23, 'door'], [100, 'coin']]) LVh.kind.set(id, { kind: k });
		const M = mkE(4, 2);
		visit(M, 5, 2, 1000, 1000);        // (a solid tile the search was in: e.g. a door that is now shut, or a block since painted)
		visit(M, 2, 1, 99000, 99000);      // (found just now: its glow over the tiles around it)
		F.heatSolid(M);
		F.heatRefresh(M, 100000, 0);
		const solid = Array.from(M.solid).join(''), shown = Array.from({ length: 8 }, (_, i) => (M.px[4 * i + 3] > 0 ? 1 : 0)).join('');
		check('the heat\'s cut: the plain solid blocks the search never visited clear though the glow reaches them (a door, an unknown block, a visited solid tile and the air stay lit)',
			solid === '11000100' && M.galpha[1] > 0 && shown === '00110111', JSON.stringify({ solid, shown, g1: M.galpha[1] }));
	}
	{
		// ---- INCREMENTAL: the answers one by one, each refresh's rectangle copied into a "canvas" (what putImageData does) =
		// the whole image made at once from the full answer; a new tile draws only the 3 x 3 around it
		const w = 40, h = 30, HI = new HX.HeatMap(w, h), tNow = 60000;
		const E1 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
		const canvas = new Uint8ClampedArray(w * h * 4);
		const put = (X, b) => { for (let y = b[1]; y <= b[3]; y++) for (let x = b[0]; x <= b[2]; x++) { const o = 4 * (y * w + x); for (let c = 0; c < 4; c++) canvas[o + c] = X.px[o + c]; } };
		let rs = 12345;
		const R = () => ((rs = (rs * 1103515245 + 12345) >>> 0) / 4294967296);
		const ans = (HMx, X, extra) => Object.assign({ search: 7, running: false, t: tNow, w, h }, HMx.since(X.version), { trailId: 0, trails: [] }, extra || {});
		let now = 0, boxes = [];
		for (let step = 0; step < 12; step++) {
			const tiles = new Set(Array.from({ length: 1 + Math.floor(R() * 30) }, () => Math.floor(R() * w * h)));
			HI.merge([...tiles], Math.min(tNow - 200, 1000 + step * 5400));   // (the last ones within HEAT_GLOW of tNow: glowing)
			F.heatApply(E1, ans(HI, E1), now);
			if (!E1.px) E1.px = new Uint8ClampedArray(w * h * 4);
			now += 150;
			const b = F.heatRefresh(E1, tNow, now);
			if (b) { put(E1, b); boxes.push(b); }
		}
		const E2 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
		F.heatApply(E2, ans(HI, E2), 0);
		E2.px = new Uint8ClampedArray(w * h * 4);
		F.heatRefresh(E2, tNow, 0);
		let diff = 0;
		for (let i = 0; i < canvas.length; i++) if (canvas[i] !== E2.px[i]) diff++;
		const part = boxes.slice(1).filter((b) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1) < w * h).length;
		// (one more tile, far from the others, found long ago: no glow; the refresh's rectangle the 3 x 3 around it)
		const E3 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 }, H3 = new HX.HeatMap(w, h);
		H3.merge([0, 1, 2], 100);
		F.heatApply(E3, ans(H3, E3), 0); E3.px = new Uint8ClampedArray(w * h * 4); F.heatRefresh(E3, tNow, 0);
		H3.merge([15 * w + 20], 200);
		F.heatApply(E3, ans(H3, E3), 150);
		const b3 = F.heatRefresh(E3, tNow, 300), b4 = F.heatRefresh(E3, tNow, 450);
		check('the heat is updated incrementally: 12 answers one at a time, only each refresh\'s rectangle put into the canvas, give the same image as the whole heat made at once; a new tile draws only the 3 x 3 tiles around it, a frame with nothing new nothing',
			diff === 0 && boxes.length === 12 && boxes[0].join() === `0,0,${w - 1},${h - 1}` && part >= 6 && b3 && b3.join() === '19,14,21,16' && b4 === null,
			JSON.stringify({ diff, boxes: boxes.map((b) => b.join('-')), b3, b4 }));
		// (the colours' ageing while the search runs: a pass over the rows every EXP_AGE_MS, EXP_AGE_SLICES slices of rows a
		// frame; after a pass the image = the whole heat made at that time)
		const E4 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
		F.heatApply(E4, ans(HI, E4, { running: true, t: 80000 }), 0); E4.px = new Uint8ClampedArray(w * h * 4);
		canvas.fill(0);
		put(E4, F.heatRefresh(E4, 80000, 0));
		const quiet = F.heatRefresh(E4, 80000, F.EXP_AGE_MS - 1);
		const slices = [];
		for (let k = 0; k < F.EXP_AGE_SLICES; k++) { const b = F.heatRefresh(E4, 95000, F.EXP_AGE_MS + 20 * k); if (b) { put(E4, b); slices.push(b); } }
		const after = F.heatRefresh(E4, 95000, F.EXP_AGE_MS + 20 * F.EXP_AGE_SLICES + 20);
		const E5 = { search: 0, W: 0, H: 0, version: 0, trailId: 0, trails: [], list: [], visited: 0 };
		F.heatApply(E5, ans(HI, E5, { running: true, t: 95000 }), 0); E5.px = new Uint8ClampedArray(w * h * 4); F.heatRefresh(E5, 95000, 0);
		let d5 = 0;
		for (let i = 0; i < canvas.length; i++) if (canvas[i] !== E5.px[i]) d5++;
		const rows = Math.ceil(h / F.EXP_AGE_SLICES);
		check('the colours\' ageing while the search runs: nothing between passes, then a pass over the rows every EXP_AGE_MS in EXP_AGE_SLICES slices of whole rows (one a frame); after it the image = the whole heat made at that time',
			quiet === null && slices.length === F.EXP_AGE_SLICES && slices.every((b, k) => b[0] === 0 && b[2] === w - 1 && b[3] - b[1] + 1 <= rows + 2 && b[1] <= k * rows) && after === null && d5 === 0,
			JSON.stringify({ quiet, slices: slices.map((b) => b.join('-')), after, d5 }));
	}
	{
		// ---- heatPlace: the heat's canvas over the map by a CSS transform (the level's origin in CSS px, the tile's CSS px)
		const style = {};
		let sets = 0;
		const st = new Proxy(style, { set(o, k, v) { sets++; o[k] = v; return true; } });
		const org = { T: 20, ox: -150, oy: 40 };
		const penv = { $: () => ({ style: st }), origin: () => Object.assign({}, org), dpr: () => 1.25, EXP: { W: 300, H: 200, placed: '' } };
		let hp = null;
		const pe = errOf(() => { hp = new Function(...Object.keys(penv), `'use strict';\n${pageFnSrc('heatPlace')}\nreturn heatPlace;`)(...Object.values(penv)); });
		let t1, s1, s2, t2;
		if (hp) { hp(); t1 = style.transform; s1 = sets; hp(); s2 = sets; org.ox = -170; hp(); t2 = style.transform; }
		check('heatPlace: the heat\'s canvas (a pixel a tile) over the map by a CSS transform (translate: the level\'s origin in CSS px, scale: a tile\'s CSS px), its CSS size the level\'s tiles; written only when the view changed',
			!pe && t1 === 'translate(-120px, 32px) scale(16)' && style.width === '300px' && style.height === '200px' && s2 === s1 && t2 === 'translate(-136px, 32px) scale(16)', pe ? pe.message : JSON.stringify({ t1, t2, s1, s2 }));
	}
	drawExploreChecks();
	// ---- the trails on a fake canvas context (s = 1, the origin (10, 20), d = 1)
	const draw = (trails, tNow) => { const g = fakeCtx(); let n = -1; const e = errOf(() => { n = F.drawTrails(g, trails, 10, 20, 1, 1, tNow); }); return { g, e, n, c: g.calls }; };
	const pts = [];
	for (let i = 0; i < 20; i++) pts.push(i * 8, 50);
	pts.push(400, 300, 408, 300);   // (a portal: points 20, 21 a piece of their own)
	const T1 = { id: 1, k: 'explore', label: 'every move', t: 0, ticks: 300, pts, br: [20] }, T2 = { id: 2, k: 'gorolls', label: 'random runs (GPU)', t: 5000, ticks: 200, pts: pts.slice(0, 20), br: [] };
	const A = draw([T1, T2], 6000);
	const strokes = (r, col) => r.c.filter((q) => q.name === 'stroke' && q.stroke === col);
	const tip = (r, col) => Math.max(...strokes(r, col).filter((q) => q.width < 3).map((q) => q.alpha));
	const jumped = A.c.filter((q) => q.name === 'lineTo' && q.a[0] === 10 + 400);
	const moved = A.c.filter((q) => q.name === 'moveTo' && q.a[0] === 10 + 400 && q.a[1] === 20 + 300);
	check('drawTrails: each attempt in its search\'s colour (every move magenta, the GPU random runs white), a faint tail and a bright tip, the portal\'s jump not joined, the newer brighter, a dot at its end',
		!A.e && A.n === 2 && strokes(A, F.expColor('explore')).length >= 2 && strokes(A, F.expColor('gorolls')).length >= 2 && F.expColor('explore') !== F.expColor('gorolls') &&
		jumped.length === 0 && moved.length === 1 && tip(A, F.expColor('gorolls')) > tip(A, F.expColor('explore')) &&
		A.c.filter((q) => q.name === 'arc').length === 2 && A.c.filter((q) => q.name === 'save').length === A.c.filter((q) => q.name === 'restore').length,
		A.e ? A.e.stack : JSON.stringify({ n: A.n, jumped: jumped.length, moved: moved.length, tips: [tip(A, F.expColor('explore')), tip(A, F.expColor('gorolls'))] }));
	const fade = [0, 2000, 5000, 9000].map((t) => tip(draw([T1], t), F.expColor('explore')));
	const gone = draw([T1, T2], 5000 + F.EXP_TRAIL_FADE);
	check('drawTrails: fading with age (EXP_TRAIL_FADE 10 s), then gone', fade.every((a, k) => k === 0 || a < fade[k - 1]) && fade[3] > 0 && gone.n === 0 && !gone.c.some((q) => q.name === 'stroke'),
		JSON.stringify({ fade, gone: gone.n }));
	const many = Array.from({ length: 14 }, (_, k) => Object.assign({}, T2, { id: 10 + k, k: 'goexplore', t: 1000 + k }));
	const M = draw([T1, ...many], 2000);
	// (the strokes: one per colour, alpha step and pass, not one per attempt: 11 attempts of 2 searches, 4 passes)
	const nStrokes = M.c.filter((q) => q.name === 'stroke').length;
	check('drawTrails: at most EXP_TRAILS_K (10) a search (its newest), the other searches\' too; the attempts of one colour, alpha and pass in one stroke (11 attempts, a few strokes)',
		M.n === F.EXP_TRAILS_K + 1 && F.EXP_TRAILS_K === 10 && nStrokes <= 12, `${M.n} strokes ${nStrokes}`);
	{
		// (only what is in the canvas: a trail far outside it draws its dot nowhere and its lines as a few points)
		const far = { id: 3, k: 'explore', t: 0, ticks: 1000, pts: Array.from({ length: 400 }, (_, i) => (i % 2 ? 50 : 5000 + i * 4)), br: [] };
		const g = fakeCtx();
		F.drawTrails(g, [far], 0, 0, 1, 1, 100, 800, 600);
		const pts2 = g.calls.filter((q) => q.name === 'lineTo' || q.name === 'moveTo').length;
		check('drawTrails: only the parts in the canvas (a trail far to the right of it: no dot, no points)', pts2 === 0 && !g.calls.some((q) => q.name === 'arc'), `${pts2}`);
	}
	{
		// ---- the palette (the UI review: 3 oranges, 3 pinks and yellows next to the route's gold and Follow's streak): no two
		// searches that can run together alike (the relay only up to 50 x 50 tiles, the escape only above: they may share; the
		// path skips and exact landings rarely leave a trail: they may share), none the route's gold, the nearest attempt's
		// orange, the guide line's red-pink or the job run's light blue, none in the gold / orange hues
		const hsl = (hx) => { const r = parseInt(hx.slice(1, 3), 16) / 255, g = parseInt(hx.slice(3, 5), 16) / 255, b = parseInt(hx.slice(5, 7), 16) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
			let hue = 0; if (d) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hue = (hue * 60 + 360) % 360; const l = (mx + mn) / 2; return { hue, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0 }; };
		const Cl = F.EXP_COLORS, keys = Object.keys(Cl), shared = new Set(['escape|relay', 'relay|escape', 'precision|skips', 'skips|precision']);
		const clash = [];
		for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (Cl[keys[i]].toLowerCase() === Cl[keys[j]].toLowerCase() && !shared.has(`${keys[i]}|${keys[j]}`)) clash.push(`${keys[i]}=${keys[j]}`);
		const reserved = ['#ffd23f', '#ff9f43', '#ff4d6d', '#6ec8ff'], bad = keys.filter((k) => reserved.includes(Cl[k].toLowerCase()) || (hsl(Cl[k]).s > 0.3 && hsl(Cl[k]).hue >= 20 && hsl(Cl[k]).hue <= 65));
		const all = ['explore', 'relay', 'breaker', 'guide', 'goal', 'goexplore', 'escape', 'skips', 'gorolls', 'precision'];
		check('the trails\' palette: every search a colour, no two that run together alike, none the route\'s, the nearest attempt\'s, the guide line\'s or the job run\'s colour, none gold / orange',
			all.every((k) => /^#[0-9a-f]{6}$/i.test(Cl[k] || '')) && clash.length === 0 && bad.length === 0, JSON.stringify({ clash, bad }));
	}
	// ---- the map's level cache; the best route's panel; Follow
	mapCacheChecks();
	await improveChecks();
	followChecks();
}
/** a stand-in canvas: its size (every width / height set counted), a style, a context of its own (fakeCtx) */
function fakeCanvas(w, h, ctx) {
	const c = { _w: w, _h: h, sizes: 0, style: {} };
	Object.defineProperty(c, 'width', { get() { return c._w; }, set(v) { c._w = v; c.sizes++; } });
	Object.defineProperty(c, 'height', { get() { return c._h; }, set(v) { c._h = v; c.sizes++; } });
	const g = ctx || fakeCtx();
	g.canvas = c;
	c.getContext = () => g;
	c.g = g;
	return c;
}
/**
 * drawExplore (editor.html, cut out with the heat's functions and run on stand-in canvases): the heat's canvas sized to the
 * level (a pixel a tile) once, then only the changed rectangle put into it (no canvas resize on a heat update: a resize
 * clears the canvas, the flash); a pan moves it by its CSS transform alone; the trails drawn again when they change, fade
 * (EXP_TRAIL_MS), the map moves past their canvas's margin or zooms, else only moved.
 */
function drawExploreChecks() {
	const puts = [];
	const hctx = fakeCtx();
	hctx.putImageData = (img, x, y, dx, dy, dw, dh) => puts.push([dx, dy, dw, dh]);
	hctx.createImageData = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
	const heatCv = fakeCanvas(300, 150, hctx), trailCv = fakeCanvas(1000 + 400, 700 + 400);
	const org = { T: 20, s: 1.25, ox: 100, oy: 50 };
	const els = {};
	const LVd = { W: 40, H: 30, fg: new Int32Array(1200), kind: new Map() };
	const denv = { $: (id) => (id === 'cvHeat' ? heatCv : id === 'cvTrail' ? trailCv : (els[id] = els[id] || fakeEl())), origin: () => Object.assign({}, org), dpr: () => 1.25, trailMargin: () => 200,
		SOLVE: { sig: null }, currentSig: () => 'x', editVersion: 0, LV: LVd, expLegend: () => {}, store: { get: () => null }, atob: (s) => Buffer.from(String(s), 'base64').toString('latin1') };
	const fns = ['b64u8', 'heatReset', 'heatTodo', 'heatAdd', 'heatApply', 'heatPixel', 'heatGlow', 'heatRefresh', 'solidBlock', 'heatSolid', 'heatPlace', 'traceFlat', 'drawTrails', 'drawExplore'];
	const code = [pageConstSrc('clamp'), ...['TRAIL_MARGIN', 'HEAT_SPAN_MIN', 'HEAT_STOPS', 'heatSpan', 'solidIds'].map(pageConstSrc), pageBlockSrc('HEAT_LUT'), pageBlockSrc('EXP_COLORS'), pageConstSrc('expColor'),
		pageBlockSrc('EXP'), ...fns.map(pageFnSrc)].join('\n');
	let D = null;
	const de = errOf(() => { D = new Function(...Object.keys(denv), `'use strict';\n${code}\nreturn { drawExplore, heatApply, EXP, EXP_TRAIL_MS };`)(...Object.values(denv)); });
	check('drawExplore and the heat\'s functions cut out of the page run', !!D, de ? de.stack : undefined);
	if (!D) return;
	const { EXP } = D, HM = new HX.HeatMap(40, 30);
	HM.merge([100, 101, 102, 141, 142], 1000);
	const tr = { id: 1, k: 'goexplore', label: 'random runs (CPU)', t: 4800, ticks: 100, pts: [0, 0, 160, 0, 160, 160, 320, 160], br: [] };
	const answer = (extra) => Object.assign({ search: 9, running: true, t: 5000, w: 40, h: 30 }, HM.since(EXP.version), { trailId: 0, trails: [] }, extra || {});
	const clears = () => trailCv.g.calls.filter((q) => q.name === 'clearRect').length;
	D.heatApply(EXP, answer({ trailId: 1, trails: [tr] }), 0);
	D.drawExplore(10);
	const first = { sizes: heatCv.sizes, w: heatCv.width, h: heatCv.height, puts: puts.slice(), tf: heatCv.style.transform, cw: heatCv.style.width, clears: clears() };
	// a new tile (found long ago: no glow): only its 3 x 3 put, no resize, the trails as they were
	HM.merge([15 * 40 + 20], 1200);
	D.heatApply(EXP, answer(), 50);
	D.drawExplore(60);
	const second = { sizes: heatCv.sizes, put: puts[puts.length - 1], n: puts.length, clears: clears() };
	// a pan within the trails' margin: the heat's transform, the trails' canvas moved (not drawn), nothing put
	org.ox = 140; EXP.viewDirty = true;
	D.drawExplore(100);
	const pan = { tf: heatCv.style.transform, tt: trailCv.style.transform, n: puts.length, clears: clears() };
	// past the margin: the trails drawn again (the canvas back in place); a zoom: again, the heat's scale
	org.ox = 400; EXP.viewDirty = true;
	D.drawExplore(150);
	const far = { tt: trailCv.style.transform, clears: clears() };
	org.T = 40; org.s = 2.5; EXP.viewDirty = true;
	D.drawExplore(200);
	const zoomed = { tf: heatCv.style.transform, clears: clears() };
	// fading: again every EXP_TRAIL_MS, not every frame
	D.drawExplore(300);
	const c300 = clears();
	D.drawExplore(200 + D.EXP_TRAIL_MS);
	const cFade = clears();
	check('drawExplore: the heat\'s canvas sized to the level (a pixel a tile) once and put whole, placed by its CSS transform; a new tile: only its 3 x 3 put, no canvas resize (a resize clears it: the flash), the trails not drawn again',
		first.sizes === 2 && first.w === 40 && first.h === 30 && first.puts.length === 1 && first.puts[0].join() === '0,0,40,30' && first.tf === 'translate(80px, 40px) scale(16)' && first.cw === '40px' && first.clears === 1 &&
		second.sizes === 2 && second.n === 2 && second.put.join() === '19,14,3,3' && second.clears === 1, JSON.stringify({ first, second }));
	check('drawExplore on a pan: the heat moved by its transform (nothing put), the trails\' canvas moved by its transform within its margin (not drawn); past the margin and on a zoom drawn again; while they fade at most every EXP_TRAIL_MS',
		pan.tf === 'translate(112px, 40px) scale(16)' && pan.n === 2 && pan.tt === 'translate(32px, 0px)' && pan.clears === 1 && far.clears === 2 && far.tt === '' &&
		zoomed.tf === 'translate(320px, 40px) scale(32)' && zoomed.clears === 3 && c300 === 3 && cFade === 4 && heatCv.sizes === 2 && puts.length === 2,
		JSON.stringify({ pan, far, zoomed, c300, cFade, sizes: heatCv.sizes, puts: puts.length }));
}
/**
 * The map's level cache (editor.html: draw, ovEnsure, ovStep, ovBlit, mapIdle, buildChunk, dirtyCell cut out and run on
 * stand-in canvases, a stand-in clock, the simple block drawing counted): at the fit zoom the overview, one blit, no block
 * drawn; its bands with the block images within MAP_BUDGET_MS a frame; nearer, the chunks within the budget and the rest from
 * the overview (no part of the view left blank, however slow the drawing); a pan reuses the chunks (no block drawn again);
 * an edited cell drops only its chunk(s); in the page's frames an edit at the fit zoom (an undo) and a loaded level's last
 * band are drawn after the overview painted them.
 */
function mapCacheChecks() {
	const clock = { t: 0, now() { return this.t; } };
	let tiles = 0, tileCost = 0.002;
	const seen = new Uint32Array(300 * 300);
	const LVm = { W: 300, H: 300, fg: new Int32Array(90000).fill(9), bg: new Int32Array(90000), pal: new Map([[9, [100, 100, 100]]]), kind: new Map([[9, { kind: 'solid' }]]), bgColor: null };
	const vwTile = (g, L, i) => { tiles++; seen[i]++; clock.t += tileCost; };
	const mkCv = () => {
		const g = fakeCtx();
		g.createImageData = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
		g.putImageData = () => {};
		return fakeCanvas(0, 0, g);
	};
	const cv = fakeCanvas(1165, 850);
	const env = { $: (id) => (id === 'cv' ? cv : fakeEl()), document: { createElement: () => mkCv() }, performance: clock, store: { get: () => null }, window: { devicePixelRatio: 1.25 },
		LV: LVm, GX: { on: false }, FOL: { on: false }, gxReady: () => false, vwTile, KIND_FALLBACK: { solid: [110, 118, 134] }, startAndTrophies: () => ({ start: -1, trophies: [] }),
		ring: () => {}, ball: () => {}, drawJobPath: () => {}, drawRoute: () => {}, drawGuide: () => {}, gxBelow: () => {}, gxAbove: () => {}, S0: null };
	const fns = ['dirtyCell', 'paintCells', 'buildChunk', 'flushCanvas', 'fitZi', 'miniColor', 'ovEnsure', 'ovStep', 'ovBlit', 'mapIdle', 'origin', 'draw'];
	const code = [pageConstSrc('clamp'), pageConstSrc('ZOOMS'), pageBlockSrc('VW'), pageConstSrc('dpr'), pageConstSrc('tileT'), pageConstSrc('chunkSize'), pageConstSrc('MAP_BUDGET_MS'), pageConstSrc('OV'),
		pageConstSrc('ovBuilding'), 'let flushCv = null;', ...fns.map(pageFnSrc)].join('\n');
	let M = null;
	const me = errOf(() => { M = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { ${fns.join(', ')}, VW, OV, MAP_BUDGET_MS, tileT, chunkSize, ovBuilding };`)(...Object.values(env)); });
	check('the map\'s level cache cut out of the page runs', !!M, me ? me.stack : undefined);
	if (!M) return;
	const { VW, OV } = M, g = cv.g;
	const imgs = () => g.calls.filter((q) => q.name === 'drawImage');
	// ---- at the fit zoom: the overview, one blit
	VW.zi = M.fitZi(); VW.camX = 2400; VW.camY = 2400;
	g.calls.length = 0;
	M.draw();
	const T0 = M.tileT(), fitImgs = imgs(), o0 = M.origin();
	const fitOk = fitImgs.length === 1 && fitImgs[0].a[0] === OV.c && OV.T === T0 && tiles === 0 && VW.chunks.size === 0 && VW.holes === 0 &&
		fitImgs[0].a[5] === o0.ox && fitImgs[0].a[6] === o0.oy && fitImgs[0].a[7] === 300 * T0 && fitImgs[0].a[8] === 300 * T0;
	// its bands with the block images, within the budget a frame, each cell once
	let calls = 0, worst = 0, dirtied = 0;
	while (M.ovBuilding() && calls < 5000) { const t0 = clock.t; VW.dirty = false; M.mapIdle(clock.t); worst = Math.max(worst, clock.t - t0); if (VW.dirty) dirtied++; clock.t += 16; calls++; }
	const once = seen.every((v) => v === 1);
	check('the map at the fit zoom: the overview (the whole level at the fit tile size, made at once in EE\'s minimap colours), one blit, no block drawn; then its bands with the block images while nothing else draws, each cell once, within MAP_BUDGET_MS (4 ms) and a band a frame, the map shown again as they come',
		fitOk && M.MAP_BUDGET_MS === 4 && !M.ovBuilding() && once && tiles === 90000 && worst <= M.MAP_BUDGET_MS + 4 && calls > 20 && dirtied > 0,
		JSON.stringify({ fitOk, T0, ovT: OV.T, imgs: fitImgs.length, tiles, calls, worst, dirtied, once }));
	// ---- 16 px a tile: the chunks within the budget, the rest from the overview; every chunk of the view drawn one way or
	// the other (no hole), until all are built
	VW.zi = 9; VW.dirty = true; tiles = 0; tileCost = 0.01;
	const T = M.tileT(), CH = M.chunkSize(T);
	const covered = () => {
		const { T: t, ox, oy } = M.origin(), ch = M.chunkSize(t), CT = ch * t, n = Math.ceil(300 / ch), ii = imgs(), miss = [];
		for (let cy = Math.max(0, Math.floor(-oy / CT)); cy <= Math.min(n - 1, Math.floor((850 - oy) / CT)); cy++) {
			for (let cx = Math.max(0, Math.floor(-ox / CT)); cx <= Math.min(n - 1, Math.floor((1165 - ox) / CT)); cx++) {
				const X = ox + cx * CT, Y = oy + cy * CT;
				if (!ii.some((q) => (q.a.length === 3 && q.a[1] === X && q.a[2] === Y) || (q.a.length === 9 && q.a[0] === OV.c && q.a[5] === X && q.a[6] === Y))) miss.push([cx, cy]);
			}
		}
		return miss;
	};
	g.calls.length = 0; clock.t += 16;
	const t0 = clock.t;
	M.draw();
	const firstMs = clock.t - t0, firstHoles = VW.holes, firstMiss = covered(), firstBuilt = VW.chunks.size, centre = VW.chunks.has(`s|${T}|9|9`);
	let frames = 1;
	while (VW.dirty && frames < 100) { VW.dirty = false; g.calls.length = 0; clock.t += 16; M.draw(); frames++; if (covered().length) break; }
	const lastMiss = covered();
	check('the map nearer (16 px a tile): the chunks of the view built within the budget, the view\'s centre first, the rest the overview scaled up (no part of the view blank), built in the next frames',
		centre && firstBuilt >= 1 && firstBuilt < 20 && firstHoles > 0 && firstMiss.length === 0 && firstMs <= M.MAP_BUDGET_MS + CH * CH * tileCost + 1 && VW.holes === 0 && lastMiss.length === 0 && frames > 2,
		JSON.stringify({ T, CH, firstBuilt, firstHoles, firstMiss, firstMs, frames, holes: VW.holes, lastMiss }));
	// the ring around the view while nothing else draws; then a pan of 3 tiles: every chunk from the cache, no block drawn
	let idle = 0;
	for (let k = 0, n = -1; k < 200 && n !== VW.chunks.size; k++) { n = VW.chunks.size; clock.t += 16; M.mapIdle(clock.t); idle++; }
	tiles = 0; g.calls.length = 0;
	VW.camX += 48; VW.camY -= 32;
	M.draw();
	const panTiles = tiles, panHoles = VW.holes, panMiss = covered();
	check('a pan (Follow, a drag) reuses the level\'s chunks: after the ring around the view was built while idle, a move of 3 tiles draws no block (the chunks blitted, no hole)',
		panTiles === 0 && panHoles === 0 && panMiss.length === 0 && idle > 1, JSON.stringify({ panTiles, panHoles, panMiss, idle, chunks: VW.chunks.size }));
	// ---- a slow machine (a chunk takes 64 ms): the first chunk alone, the whole view still drawn (the overview under the rest)
	VW.zi = 10; tileCost = 1; tiles = 0; g.calls.length = 0; clock.t += 16;
	M.draw();
	const slow = { built: tiles / (M.chunkSize(M.tileT()) ** 2), holes: VW.holes, miss: covered().length, dirty: VW.dirty };
	check('a slow machine (a chunk\'s blocks 64 ms): one chunk a frame, the rest of the view the overview (no blank part), the map drawn again next frame',
		slow.built === 1 && slow.holes > 0 && slow.miss === 0 && slow.dirty === true, JSON.stringify(slow));
	// ---- an edited cell: its chunk (and a neighbour's where the 3 x 3 around it reaches) dropped, the other chunks kept; the
	// overview's cells again
	VW.zi = 9; tileCost = 0.001; VW.dirty = true;
	for (let k = 0; k < 50 && VW.dirty; k++) { VW.dirty = false; clock.t += 16; M.draw(); }
	const n0 = [...VW.chunks.keys()].filter((k) => k.startsWith(`s|${T}|`)).length;
	const mid = (9 * CH + 7) * 300 + 9 * CH + 7, corner = (9 * CH) * 300 + 11 * CH;
	M.dirtyCell(mid);
	const n1 = [...VW.chunks.keys()].filter((k) => k.startsWith(`s|${T}|`)).length, ovd = OV.dirty.slice();
	M.dirtyCell(corner);
	const n2 = [...VW.chunks.keys()].filter((k) => k.startsWith(`s|${T}|`)).length;
	tiles = 0; clock.t += 16; M.draw();
	const rebuilt = tiles;
	check('an edited cell drops only its chunk (a cell at a chunk\'s corner the 4 around it), the others kept; its 3 x 3 cells of the overview again; the next frame builds only those',
		n0 - n1 === 1 && n1 - n2 === 4 && ovd.length === 1 && ovd[0].join() === `${9 * CH + 6},${9 * CH + 6},${9 * CH + 9},${9 * CH + 9}` && rebuilt === 5 * CH * CH,
		JSON.stringify({ n0, n1, n2, ovd, rebuilt, CH }));
	// ---- the page's frames (frame(): the map drawn when dirty, else mapIdle), 16 ms apart. The merge review (2026-09-29):
	// at the fit zoom the map is the overview, and the overview's work that ended within OV_FRAME_MS of the last draw was
	// never shown: an undo at Fit (no pointer-up redraw after it) left 13 of 13 undone blocks drawn, a loaded level's last
	// bands stayed in minimap colours. Now the map is drawn once more after the overview's last paint.
	const run = (max) => {
		let paintAt = -1, drawAt = -1, draws = 0, k = 0;
		for (; k < max; k++) {
			const t0 = tiles;
			if (VW.dirty) { VW.dirty = false; M.draw(); drawAt = k; draws++; } else {
				M.mapIdle(clock.t);
				if (tiles > t0) paintAt = k; else if (!VW.dirty && !M.ovBuilding()) break;
			}
			clock.t += 16;
		}
		return { paintAt, drawAt, draws, k };
	};
	VW.zi = M.fitZi(); VW.dirty = true; tileCost = 0.002;
	const settle = run(400);
	M.dirtyCell(150 * 300 + 150);   // (an undo: applyCell -> dirtyCell, nothing else)
	tiles = 0; g.calls.length = 0;
	const ed = run(50), edTiles = tiles, edBlit = imgs().filter((q) => q.a[0] === OV.c).length;
	check('an edit at the fit zoom (an undo: no redraw after it) is shown: the map drawn again after the overview painted the edited cells (it was drawn only before them)',
		settle.k < 400 && ed.paintAt >= 0 && ed.drawAt > ed.paintAt && edTiles === 9 && edBlit === 2 && ed.k < 50 && !VW.dirty, JSON.stringify({ settle, ed, edTiles, edBlit }));
	// (a level loaded at the fit zoom: the overview made again, its bands with the block images, the last one shown too;
	// with several drawing speeds, so that the last band also ends within OV_FRAME_MS of a draw)
	const loads = [0.0014, 0.0018, 0.002, 0.0024, 0.003, 0.0036, 0.0042, 0.005].map((c) => {
		tileCost = c; OV.c = null; VW.chunks.clear(); VW.px = 0; VW.dirty = true; tiles = 0;
		const ld = run(5000);
		return Object.assign(ld, { c, tiles, ok: !M.ovBuilding() && tiles === 90000 && ld.paintAt > 0 && ld.drawAt > ld.paintAt && ld.draws > 2 && ld.k < 5000 && OV.unshown === false });
	});
	check('a level loaded at the fit zoom (8 drawing speeds): the map drawn again after the overview\'s last band (none left in minimap colours), shown as the bands come (at most every OV_FRAME_MS), then nothing more to draw',
		loads.every((q) => q.ok), JSON.stringify(loads));
}
/**
 * The best route's panel and the improvements (editor.html: impUpdate, bestRoute, changedSpan, impJob, bestPanel,
 * bestChart, drawImpFlash cut out of the page and run): the steps of the best time from Find a route's improvements (GET
 * /api/editor/solve `improve`) and, with Find and optimize, the optimizer's (GET /api/editor/autotas `t0`, `bests`); a new
 * best route: its flash (the one before it a ghost, the stretch that changed); the job's best run as the route once faster.
 */
function improveChecks() {
	const els = {};
	const $ = (id) => (els[id] = els[id] || (id === 'bpChart' ? fakeCanvas(212, 42) : fakeEl()));
	const clock = { t: 100000, now() { return this.t; } };
	const apiCalls = [];
	let apiAnswer = null;
	const env = { $, SOLVE: { st: null, sig: null }, AUTO: { st: null }, FX: { dirty: false }, dpr: () => 1, currentSig: () => 'L', performance: clock, mapPathCheck: () => {},
		api: async (u) => { apiCalls.push(u); return apiAnswer; }, atob: (s) => Buffer.from(String(s), 'base64').toString('latin1') };
	const fns = ['bestRoute', 'changedSpan', 'impUpdate', 'impJob', 'tracePath', 'drawImpFlash', 'bestPanel', 'bestChart', 'b64i32'];
	const code = [pageConstSrc('esc'), pageConstSrc('fmt'), pageConstSrc('clamp'), pageBlockSrc('IMP'), pageConstSrc('BEST_CHART_MS'), pageConstSrc('autoOf'), pageConstSrc('impFlashOn'), pageConstSrc('agoShort'),
		pageConstSrc('impTicking'), ...fns.map(pageFnSrc)].join('\n');
	let F = null;
	const fe = errOf(() => { F = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { ${fns.join(', ')}, IMP, impTicking, impFlashOn, IMP_FLASH_MS, IMP_JOB_MS, IMP_NEW_MS };`)(...Object.values(env)); });
	check('the best route\'s panel: its functions cut out of the page run; the panel on the map (hidden until a route), its chart',
		!!F && /<div class="bestp" id="bestP" title="click: fold \/ unfold" hidden><div class="bt"><span>best route<\/span><b id="bpTime"><\/b><\/div><div class="bs" id="bpSub"><\/div><div class="bl" id="bpLast"><\/div><canvas id="bpChart" width="212" height="42"><\/canvas><\/div>/.test(PAGE) &&
		/if \(IMP\.dirty \|\| \(impTicking\(now\) && now - IMP\.chartAt >= BEST_CHART_MS\)\) bestPanel\(now\);/.test(PAGE) && /impUpdate\(performance\.now\(\)\); impJob\(\); mapPathCheck\(\);/.test(PAGE),
		fe ? fe.stack : undefined);
	if (!F) return;
	const { IMP } = F;
	const S0 = Date.now() - 60000;
	// paths: P1 a straight line of 200 ticks; P2 the same with a detour in the middle, shorter
	const P1 = Array.from({ length: 200 }, (_, t) => [16 + 2 * t, 88]);
	const P2 = [...P1.slice(0, 50), ...Array.from({ length: 50 }, (_, k) => [116 + 4 * k, 60]), ...P1.slice(150)];
	const res = (P, run, what) => ({ path: P, ticks: P.length - 1, runTicks: run, time: '', strategy: what, foundAfter: 1 });
	const st = { started: S0, running: true, improve: [{ t: 5, runTicks: 900, ticks: 910, strategy: 'every move' }, { t: 12, runTicks: 850, ticks: 860, strategy: 'one search (CPU runs + GPU bursts)', clean: true }],
		result: res(P1, 850, 'one search (CPU runs + GPU bursts)') };
	const A = { t0: S0 + 400, running: true, job: 'j1', best: 800, bests: [{ t: 10, runTicks: 850, what: 'the first route' }, { t: 20, runTicks: 800, what: 'mutate' }, { t: 30, runTicks: 810, what: 'late' }] };
	env.SOLVE.st = st; env.AUTO.st = A;
	F.impUpdate(clock.t);
	const L1 = IMP.list.map((e) => `${e.runTicks}${e.job ? 'j' : ''}:${e.what}`).join(' | '), n1 = IMP.n, live = IMP.live, dirty = IMP.dirty;
	env.AUTO.st = Object.assign({}, A, { t0: S0 + 60000 });   // (another run's AutoTASer: not this search's)
	F.impUpdate(clock.t);
	const L2 = IMP.list.map((e) => e.runTicks).join();
	check('the improvements: Find a route\'s faster routes (the cleaned ones said so) and, with Find and optimize, the optimizer\'s bests merged by time, each step faster than the one before; another run\'s AutoTASer not counted',
		L1 === '900:every move | 850j:the optimizer: the first route | 800j:the optimizer: mutate' && n1 === 2 && live && dirty && L2 === '900,850', JSON.stringify({ L1, n1, L2 }));
	// a new best route (the search's): its flash, the one before it the ghost, the stretch that changed
	env.AUTO.st = null; env.FX.dirty = false;
	st.improve.push({ t: 14, runTicks: 820, ticks: 150, strategy: 'every move' });
	st.result = res(P2, 820, 'every move');
	clock.t += 500;
	F.impUpdate(clock.t);
	const flash = { prev: IMP.prev === P1, cur: IMP.cur === P2, span: IMP.span && IMP.span.join(), at: IMP.flashAt === clock.t, fx: env.FX.dirty, newAt: IMP.newAt === clock.t, on: F.impFlashOn(clock.t + 100), off: F.impFlashOn(clock.t + F.IMP_FLASH_MS + 1) };
	check('a new best route: flashed on the map for IMP_FLASH_MS (the best before it the ghost, the stretch that changed: changedSpan), the panel "new"', flash.prev && flash.cur && flash.span === '49,100' && flash.at && flash.fx && flash.newAt && flash.on && !flash.off &&
		F.changedSpan(P1, P1.slice(0, 120).map(([x, y]) => [x, y + 50])).join() === '0,119' && F.changedSpan(P1, P1).join() === '199,199', JSON.stringify(flash));
	// the flash drawn: the ghost dashed and faint, the changed stretch gold (its points only)
	{
		const g = fakeCtx();
		const e = errOf(() => F.drawImpFlash(g, 0, 0, 1, 1, clock.t + 1000, 4000, 4000));
		const strokes = g.calls.filter((q) => q.name === 'stroke');
		const gold = strokes.filter((q) => /^rgba\(255,(210|243),/.test(q.stroke)), ghost = strokes.filter((q) => q.dash.length === 2 && /^rgba\(235,240,255,/.test(q.stroke));
		const pts = g.calls.filter((q) => q.name === 'lineTo' || q.name === 'moveTo').length;
		check('the new best\'s flash: the best before it a faint dashed ghost, the stretch that changed gold (a glow and a line), fading', !e && ghost.length === 1 && gold.length === 2 &&
			+ghost[0].stroke.split(',')[3].replace(')', '') < 0.55 && pts <= 200 + 2 * 60, e ? e.stack : JSON.stringify({ strokes: strokes.map((q) => [q.stroke, q.dash.length]), pts }));
	}
	// the panel
	env.AUTO.st = A; st.improve.pop(); st.result = res(P1, 850, 'one search (CPU runs + GPU bursts)');
	F.impUpdate(clock.t);
	F.bestPanel(clock.t);
	const panel = { hidden: $('bestP').hidden, time: $('bpTime').textContent, sub: $('bpSub').textContent, last: $('bpLast').innerHTML };
	const cg = $('bpChart').g, cs = cg.calls.filter((q) => q.name === 'stroke'), dots = cg.calls.filter((q) => q.name === 'arc');
	check('the best route\'s panel: the best time, how many faster routes since the first (and by how much), still looking while the search runs, the latest one\'s gain and source; its step chart: a step a route (the search\'s gold, the optimizer\'s light blue), a dot each, the latest larger',
		!panel.hidden && panel.time === '0:08.00' && panel.sub === '2 faster since the first (0:09.00, −100 ticks) · still looking' && /^latest <b>−50 ticks<\/b> · the optimizer: mutate · \d+ s ago$/.test(panel.last) &&
		cs.length === 4 && cs[1].stroke === '#ffd23f' && cs[2].stroke === '#6ec8ff' && cs[3].stroke === '#6ec8ff' && dots.length === 3 && dots[2].a[2] > dots[1].a[2] && dots[0].a[0] === 4,
		JSON.stringify({ panel, strokes: cs.map((q) => q.stroke), dots: dots.map((q) => q.a.slice(0, 3)) }));
	// folded (a click): the title line only, no chart drawn
	cg.calls.length = 0;
	$('bestP').classList.toggle('min', true);
	F.bestPanel(clock.t);
	const folded = { hidden: $('bestP').hidden, time: $('bpTime').textContent, chart: cg.calls.length };
	$('bestP').classList.toggle('min', false);
	env.SOLVE.sig = 'other';
	F.bestPanel(clock.t);
	const hid = $('bestP').hidden;
	env.SOLVE.sig = null;
	check('the panel folded (a click on it, remembered): its title line (the time) only, no chart drawn; hidden once the level changed (the route is not this level\'s)',
		!folded.hidden && folded.time === '0:08.00' && folded.chart === 0 && hid === true && /\$\('bestP'\)\.onclick = \(\) => \{ const m = !\$\('bestP'\)\.classList\.contains\('min'\);/.test(PAGE) &&
		/\.bestp\.min \.bs, \.bestp\.min \.bl, \.bestp\.min canvas \{ display: none; \}/.test(PAGE), JSON.stringify({ folded, hid }));
	// the job's best run (Find and optimize) as the route once it is faster: fetched at most every IMP_JOB_MS, only for a faster best
	return (async () => {
		const Pj = Array.from({ length: 150 }, (_, t) => [16 + 3 * t, 88]);
		const b64 = (a) => Buffer.from(new Int32Array(a).buffer).toString('base64');
		apiAnswer = { version: 3, ticks: 149, runTicks: 700, finished: true, posScale: 16, x: b64(Pj.map((p) => (p[0] - 8) * 16)), y: b64(Pj.map((p) => (p[1] - 8) * 16)) };
		env.AUTO.st = Object.assign({}, A, { best: 700 });
		await F.impJob();
		const r = F.bestRoute(st);
		clock.t += 100;
		await F.impJob();
		const calls1 = apiCalls.length;
		clock.t += F.IMP_JOB_MS + 1;
		await F.impJob();
		const calls2 = apiCalls.length;
		check('Find and optimize: the job\'s best run (GET /api/jobs/:id/path) the route shown once faster than the search\'s (Follow and the map take it), fetched only for a faster best and at most every IMP_JOB_MS',
			apiCalls[0] === '/api/jobs/j1/path' && r && r.job && r.runTicks === 700 && r.path.length === 150 && Math.abs(r.path[10][0] - Pj[10][0]) < 1e-9 && calls1 === 1 && calls2 === 1 &&
			F.bestRoute(Object.assign({}, st, { started: S0 + 1 })) !== r, JSON.stringify({ calls: apiCalls, r: r && [r.runTicks, r.path.length, r.job] }));
	})();
}
/** Follow (see exploreViewChecks): its replay, camera, route switch, seek and smiley, cut out of the page */
function followChecks() {
	const els = {};
	const $ = (id) => (els[id] = els[id] || fakeEl());
	const env = { $, SOLVE: { st: null }, VW: { zi: 2, camX: 0, camY: 0, glide: null, dirty: false, play: null }, FX: { dirty: false }, store: { get: () => null, set: () => {} },
		document: { querySelectorAll: () => [] }, gxReady: () => false, GX: {}, toolInfo: () => {}, renderSolve: () => {}, changedView: () => {},
		LV: { W: 100, H: 60 }, tileT: () => 16, performance: { now: () => 0 } };
	const code = [pageConstSrc('fmt'), pageConstSrc('clamp'), pageConstSrc('ZOOMS'), pageBlockSrc('FOL'), pageConstSrc('FOL_TAU'), pageBlockSrc('IMP'),
		...['bestRoute', 'followSrc', 'sameStart', 'followRetarget', 'followAim', 'followStep', 'followHud', 'followSeek', 'followToEnd', 'followSet', 'drawFollow', 'ball'].map(pageFnSrc)].join('\n');
	let F = null;
	const fe = errOf(() => { F = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { FOL, FOL_HOLD, FOL_SNAP, FOL_END, followSrc, sameStart, followRetarget, followStep, followSet, followSeek, followToEnd, drawFollow, ZOOMS };`)(...Object.values(env)); });
	check('Follow\'s functions cut out of the page run', !!F, fe ? fe.message : undefined);
	if (!F) return;
	const { FOL } = F, VW = env.VW;
	// a nearest attempt: 400 ticks right along a floor at y 88 (2 px a tick), then 100 ticks up
	const path = [];
	for (let t = 0; t <= 500; t++) path.push(t <= 400 ? [40 + 2 * t, 88] : [840, 88 - (t - 400)]);
	const closest = { dist: 13, tiles: 13, ticks: 500, runTicks: 490, time: '0:04.90', path, strategy: 'one search (CPU runs + GPU bursts)', foundAfter: 12.3 };
	env.SOLVE.st = { running: true, closest, result: null };
	F.followSet(true);
	const on = { on: FOL.on, zi: VW.zi, hud: !$('fHud').hidden, btn: $('bFollow').classList.contains('on') };
	F.followStep(1000);
	const t0 = FOL.tick;
	F.followStep(1100);   // (100 ms at 1x: 10 ticks)
	const t1 = FOL.tick, x1 = FOL.x, cam1 = VW.camX;
	FOL.speed = 4;
	F.followStep(1200);   // (100 ms at 4x: 40 ticks)
	const t2 = FOL.tick;
	let now = 1200;
	for (let k = 0; k < 60; k++) { now += 20; F.followStep(now); }   // (1.2 s at 4x, 8 ticks a frame: to the end at tick 500, where it holds)
	const atEnd = FOL.tick, held = FOL.endAt > 0 && now - FOL.endAt < F.FOL_HOLD;
	F.followStep(FOL.endAt + F.FOL_HOLD + 10);
	const looped = FOL.tick;
	check('Follow: on (V, the button): the zoom at least 16 px a tile, its panel shown; the tick moves on by the speed (100 ticks a second at 1x, 4x at 4x), the smiley between ticks, the camera eased toward it; it holds at the end, then plays again from the start',
		on.on && F.ZOOMS[on.zi] === 16 && on.hud && on.btn && t0 === 0 && Math.abs(t1 - 10) < 1e-9 && Math.abs(x1 - (40 + 2 * 10)) < 1e-9 && cam1 > 0 && cam1 < x1 &&
		Math.abs(t2 - 50) < 1e-9 && atEnd === 500 && held && looped === 0,
		JSON.stringify({ on, t0, t1, x1, cam1, t2, atEnd, held, looped }));
	// the camera at a steady 4x (2 px a tick, 0.8 px a ms): it leads by the smiley's speed, so it sits on the smiley (the UI
	// review: 233 CSS px behind at 4x before, the speed x FOL_TAU)
	{
		FOL.speed = 4; F.followSeek(0); VW.camX = 120; VW.camY = 88;
		let tt = 50000;
		F.followStep(tt);
		for (let k = 0; k < 40; k++) { tt += 16; F.followStep(tt); }   // (0.64 s at 4x: tick 296, on the floor; the corner at 400 past the aim)
		const lag = Math.abs(VW.camX - FOL.x), tick = FOL.tick;
		check('Follow\'s camera at a steady 4x: on the smiley (it aims where the smiley will be ~FOL_TAU on, followAim; aimed at the smiley it would trail by ~122 px)', tick > 250 && tick < 330 && lag < 2, JSON.stringify({ tick, lag, x: FOL.x, cam: VW.camX }));
	}
	// the camera kept in the level: an 800 x 600 view at 16 px a tile (half a view 400 x 300 level px) on a 100 x 60 level
	// (1600 x 960 px): at the smiley's x 40..220 the camera stops a tile past the left edge; a level smaller than the view:
	// centred
	{
		$('cv').width = 800; $('cv').height = 600;
		FOL.speed = 1; F.followSeek(5); VW.camX = 300; VW.camY = 200;
		let tt = 60000;
		for (let k = 0; k < 60; k++) { tt += 16; F.followStep(tt); }
		const inLevel = { x: VW.camX, y: VW.camY };
		env.LV.W = 30; env.LV.H = 20;
		for (let k = 0; k < 200; k++) { tt += 16; F.followStep(tt); }
		const small = { x: VW.camX, y: VW.camY };
		$('cv').width = 0; $('cv').height = 0; env.LV.W = 100; env.LV.H = 60;
		check('Follow\'s camera kept in the level: at its left edge a tile past it at most (not centred on the smiley), a level smaller than the view centred',
			Math.abs(inLevel.x - (400 - 16)) < 1 && Math.abs(inLevel.y - (300 - 16)) < 1 && Math.abs(small.x - 240) < 1 && Math.abs(small.y - 160) < 1, JSON.stringify({ inLevel, small }));
	}
	// a new nearest attempt: sharing its start with the one playing (the same ticks up to now): from the same tick; another
	// start: from its point nearest the smiley (within FOL_SNAP px), else the same tick: never back to the start; a route: the route
	FOL.speed = 1; F.followSeek(0);
	for (let k = 0; k < 30; k++) F.followStep(10000 + 10 * k);   // (to tick ~29)
	const before = FOL.tick;
	const longer = path.concat(Array.from({ length: 100 }, (_, k) => [840, -12 - k]));
	env.SOLVE.st = { running: true, closest: Object.assign({}, closest, { path: longer, ticks: 600, runTicks: 590, foundAfter: 20 }), result: null };
	F.followStep(10300);
	const kept = FOL.tick, keptLen = FOL.P.length;
	const other = path.map(([x, y]) => [x, y + 32]);   // (32 px below: within FOL_SNAP)
	env.SOLVE.st = { running: true, closest: Object.assign({}, closest, { path: other, foundAfter: 25 }), result: null };
	F.followStep(10310);
	const near = FOL.tick;
	const far = path.map(([x, y]) => [x, y + 400]);   // (400 px below: nothing near the smiley)
	env.SOLVE.st = { running: true, closest: Object.assign({}, closest, { path: far, foundAfter: 26 }), result: null };
	F.followStep(10320);
	const farTick = FOL.tick;
	const route = { time: '0:05.00', runTicks: 500, ticks: 510, path: other.concat([[900, 0]]), strategy: 'every move', foundAfter: 30 };
	env.SOLVE.st = { running: false, closest: null, result: route };
	F.followStep(10330);
	const kind = FOL.kind, rtick = FOL.tick;
	check('Follow: a new nearest attempt never sends the smiley back to the start: one that shares its start plays on from the same tick, one from another start from its point nearest the smiley, one with nothing near the same tick; a found route replaces it',
		before > 25 && Math.abs(kept - before - 1) < 1e-6 && keptLen === 601 && Math.abs(near - kept - 1) <= 1.5 && Math.abs(farTick - near - 1) <= 1.5 && kind === 'route' && Math.abs(rtick - farTick - 1) <= 1.5 &&
		F.sameStart(path, longer, 400) && !F.sameStart(path, other, 0) && !F.sameStart(path, longer.slice(0, 10), 20), JSON.stringify({ before, kept, keptLen, near, farTick, kind, rtick }));
	{
		// followRetarget: nothing played yet -> 0; the nearest point's tick nearest the one playing (a path that passes the
		// smiley's place twice: the pass nearest in time)
		const loop = [];
		for (let t = 0; t <= 300; t++) loop.push(t <= 100 ? [2 * t, 0] : t <= 200 ? [200 - 2 * (t - 100), 8] : [2 * (t - 200), 16]);
		const r0 = F.followRetarget(null, loop, 50, 100, 0), r1 = F.followRetarget(path, loop, 240, 80, 16), r2 = F.followRetarget(path, loop, 100, 80, 16);
		check('followRetarget: nothing played yet: the start; a path passing the smiley\'s place several times: the pass nearest the tick playing', r0 === 0 && r1 === 240 && r2 === 137, JSON.stringify({ r0, r1, r2 }));
	}
	// the seek bar and End / Home: to a tick, to the attempt's last FOL_END ticks (where the search has got)
	{
		F.followToEnd();
		const end = FOL.tick;
		F.followSeek(7);
		const seek = FOL.tick, bar = { max: $('fSeek').max, value: $('fSeek').value };
		check('Follow: End (the panel\'s end button) to the attempt\'s last FOL_END (300) ticks, the seek bar / Home to a tick; the bar shows the attempt\'s length and the tick',
			F.FOL_END === 300 && end === route.path.length - 1 - 300 && seek === 7 && bar.max === String(route.path.length - 1) && bar.value === '7', JSON.stringify({ end, seek, bar }));
	}
	// the smiley drawn (no EE graphics: the drawn ball) where the replay is; off: nothing more, the panel hidden
	const g = fakeCtx();
	const de = errOf(() => F.drawFollow(g, 5, 7, 1, 1));
	const X = 5 + FOL.x, Y = 7 + FOL.y;
	const ballArc = g.calls.find((q) => q.name === 'arc' && Math.abs(q.a[0] - X) < 1e-9 && Math.abs(q.a[1] - Y) < 1e-9 && q.fill === '#ffd23f');
	F.followSet(false);
	check('Follow: the smiley (the drawn one without EE graphics) where the replay is, a light under it; off: its panel hidden, the button off', !de && !!ballArc &&
		g.calls.some((q) => q.name === 'fill') && !FOL.on && $('fHud').hidden && !$('bFollow').classList.contains('on'), de ? de.stack : JSON.stringify({ X, Y, arcs: g.calls.filter((q) => q.name === 'arc').map((q) => q.a.slice(0, 3)) }));
	// nothing to follow yet: waiting (the panel says so)
	env.SOLVE.st = { running: true, closest: null, result: null };
	F.followSet(true);
	F.followStep(20000);
	check('Follow with no attempt yet: waits (the panel says so), draws nothing', FOL.P === null && /waiting for the search's first attempt/.test($('fWhat').textContent), $('fWhat').textContent);
	F.followSet(false);
}
async function appSection() {
	section('app: the page and the HTTP API (in-process server, temp data folder)');
	const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	check('the editor page\'s script parses', scripts.length === 1 && !errOf(() => new Function(scripts[0])), scripts.map((s) => { const x = errOf(() => new Function(s)); return x ? x.message : 'ok'; }).join('; '));
	frontierChecks();
	await exploreViewChecks();
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
// A stand-in for the CPU search that ends on its own (the one search's supervisor, src/editor.js oneEnded): logs its
// arguments (argLog) and its stdin (stdinLog); its first launch (a --seed below 1000) prints the scenario's sources, then
// after crashMs ends with exit code 137 (how: 'exit', as the OOM killer's SIGKILL shows in a container's shell) or an
// uncaught throw (how: 'throw'); a restart (seed + 1000 x k) runs until "stop" or the end of its stdin.
const FAKE_CPU_CRASH = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const seed = +((process.argv.find((x) => x.startsWith('--seed=')) || '--seed=0').slice(7));
if (SC.argLog) fs.appendFileSync(SC.argLog, JSON.stringify(process.argv.slice(3)) + '\\n');
say({ ev: 'start', workers: 1, seeds: [seed], mode: 'physics', cells: 'coarse', startCost: 40 });
const first = seed < 1000;
if (first) setTimeout(() => { for (const s of SC.sources || []) say(Object.assign({ ev: 'source', seed: 1 }, s)); }, SC.wait || 0);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 40, found: 0, refined: 0, rooms: 3, workers: 1, heapMB: 123 }), 200);
if (first) setTimeout(() => { clearInterval(iv); process.stderr.write('FATAL ERROR: stand-in heap limit\\n'); if (SC.how === 'throw') throw new Error('stand-in worker crash'); process.exit(137); }, SC.crashMs);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (!first && SC.stdinLog) fs.appendFileSync(SC.stdinLog, String(d)); if (/stop/.test(String(d))) end(); });
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
	// the one search's supervisor (src/editor.js oneEnded): the CPU search ends on its own (exit code 137, as the OOM
	// killer's SIGKILL shows in a shell; an uncaught throw) with no route known: the cause is logged (V.crashes: the code,
	// the stderr tail, the last progress line), it starts again with seed + 1000 and its archive gets the sources' attempts
	// on stdin ("seed <inputs>"); with a route known it is not started again
	for (const how of ['exit', 'throw']) {
		const scR = path.join(HOME, `sup_${how}.json`), logR = path.join(HOME, `sup_${how}.log`), scC = path.join(HOME, `sup_${how}cpu.json`), fakeCpu = path.join(HOME, 'fake-cpu-crash.js');
		const argLog = path.join(HOME, `sup_${how}_args.log`), inLog = path.join(HOME, `sup_${how}_stdin.log`);
		fs.writeFileSync(fakeCpu, FAKE_CPU_CRASH);
		fs.writeFileSync(scR, JSON.stringify({ log: logR, R, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0, closest: { dist: 30, tick: 1200, ch: '0' } }] }, beam: null }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100, crashMs: 1500, how, argLog, stdinLog: inLog, sources: [
			{ kind: 'room', room: 111, desc: 'key:red', gain: 40, tick: 300, dist: 50, inputs: '2'.repeat(300) },
			{ kind: 'room', room: 333, desc: 'key:blue', gain: 25, tick: 500, dist: 60, inputs: '1'.repeat(500) }] }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 200, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scR], cpu: [process.execPath, fakeCpu, scC], salts: false });
		const argsOf = () => (fs.existsSync(argLog) ? fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
		const t0s = Date.now();
		while (ED.state().running && (argsOf().length < 2 || !fs.existsSync(inLog)) && Date.now() - t0s < 20000) await new Promise((z) => setTimeout(z, 100));
		await new Promise((z) => setTimeout(z, 500));
		const st = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		const seeds = argsOf().map((a) => +((a.find((x) => x.startsWith('--seed=')) || '--seed=-1').slice(7)));
		const V = (st.strategies || []).find((q) => q.key === 'goexplore') || {};
		const fedIn = fs.existsSync(inLog) ? fs.readFileSync(inLog, 'utf8').split('\n').filter((l) => l.startsWith('seed ')) : [];
		const cr = (V.crashes || [])[0] || {};
		check(`the one search ends on its own (${how === 'exit' ? 'exit code 137' : 'an uncaught throw'}) with no route: logged (code, stderr, last progress), started again with seed + 1000, its archive fed with the sources' attempts`,
			seeds.length === 2 && seeds[1] === seeds[0] + 1000 && V.restarts === 1 && cr.code === (how === 'exit' ? 137 : 1) && cr.restarted === true &&
			(cr.stderr || []).some((l) => /stand-in heap limit/.test(l)) && cr.progress && cr.progress.heapMB === 123 &&
			fedIn.some((l) => /^seed 2{300}$/.test(l)) && fedIn.some((l) => /^seed 1+$/.test(l)) && (st.notes || st.log || []).concat([]).length >= 0,
			`seeds ${seeds.join(',')}; restarts ${V.restarts}; crash ${JSON.stringify(cr).slice(0, 300)}; fed ${fedIn.length}; state ${V.state}`);
	}
	// ... and with a route already known (every move's first pass finishes; its next pass holds the GPU, so the CPU search
	// is not stopped by cpuDone): the end is logged, and the search is not started again
	{
		const scR = path.join(HOME, 'sup_route.json'), logR = path.join(HOME, 'sup_route.log'), scC = path.join(HOME, 'sup_routecpu.json'), fakeCpu = path.join(HOME, 'fake-cpu-crash.js');
		const argLog = path.join(HOME, 'sup_route_args.log');
		fs.writeFileSync(fakeCpu, FAKE_CPU_CRASH);
		fs.writeFileSync(scR, JSON.stringify({ log: logR, R, runs: { '-1': [{ end: 'finish', idle: 20, layers: 3 }], 0: [{ end: 'time', layers: 5000, wait: 8000, hold: 8000 }] }, beam: null }));
		fs.writeFileSync(scC, JSON.stringify({ wait: 100, crashMs: 3000, how: 'exit', argLog }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 200, width: 1024, workers: 1 }, { available: true },
			{ tool: [process.execPath, fake, scR], cpu: [process.execPath, fakeCpu, scC], salts: false });
		const t0s = Date.now();
		const V0 = () => (ED.state().strategies || []).find((q) => q.key === 'goexplore') || {};
		while (ED.state().running && !(V0().crashes || []).length && Date.now() - t0s < 15000) await new Promise((z) => setTimeout(z, 100));
		await new Promise((z) => setTimeout(z, 1000));
		const st = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		const n = fs.existsSync(argLog) ? fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean).length : 0;
		const V = (st.strategies || []).find((q) => q.key === 'goexplore') || {};
		const cr = (V.crashes || [])[0] || {};
		check('the one search ends on its own with a route known: logged, not started again',
			!!st.result && n === 1 && !V.restarts && cr.code === 137 && cr.restarted === false, `route ${!!st.result}; launches ${n}; restarts ${V.restarts}; crash ${JSON.stringify(cr).slice(0, 200)}; state ${V.state}`);
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
	// the steer field on the CPU alone (the GPU tools cannot take it: here an older tool; on Forgotten Helix its 614 MB copies
	// are over the GPU's memory share): the attempts are still measured by it (Helix's viewing rooms: the reach field's walk
	// through every coin door ranked a pocket behind a door the coins never open nearest). The CPU search gets --steer
	// without --steerDist=0; every move's attempt (12 tiles by the reach field) ranks behind the CPU search's (50 by the
	// steer field): STEER_MISS + 12; every move keeps its own nearest attempt (its chain) by its own field
	{
		const KW = 40, KH = 7;
		const kcells = [...room(KW, KH), [18, 5, 255], [1, 5, 6], [KW - 4, 5, 121]];
		for (let y = 1; y < KH - 1; y++) kcells.push([KW - 6, y, 23]);
		const kbuf = ED.eelvlOf({ name: 'steerkey', width: KW, height: KH, cells: kcells });
		const sc = path.join(HOME, 'steer-cpu.json'), log = path.join(HOME, 'steer-cpu.log'), scC = path.join(HOME, 'steer-cpu-c.json'), cpuLog = path.join(HOME, 'steer-cpu-args.log');
		const stub = path.join(HOME, 'fake-cpu-steer.js');
		fs.writeFileSync(stub, `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(SC.log, JSON.stringify(process.argv.slice(3)));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'fine', startCost: 40 });
setTimeout(() => say({ ev: 'closest', dist: 50, tick: 10, inputs: '4'.repeat(10) }), 600);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 50, found: 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (/stop/.test(String(d))) end(); });
process.stdin.on('end', end);
`);
		fs.writeFileSync(sc, JSON.stringify({ log, R: 50, runs: { '-1': [{ end: 'exhausted', layers: 5, overflow: 0, closest: { dist: 12, tick: 20, ch: '4' } }] }, beam: null, steer: 0 }));
		fs.writeFileSync(scC, JSON.stringify({ log: cpuLog }));
		ED.start({ eelvlB64: kbuf.toString('base64'), seconds: 20, width: 1024, workers: 1 }, { available: true }, { tool: [process.execPath, fake, sc], cpu: [process.execPath, stub, scC], salts: false });
		let st = ED.state();
		const both = (s) => s.closest && s.closest.dist === 50 && (s.strategies || []).some((q) => q.key === 'explore' && q.best >= 0);
		for (const t0 = Date.now(); st.running && !both(st) && Date.now() - t0 < 30000; st = ED.state()) await new Promise((res) => setTimeout(res, 40));
		const X = (st.strategies || []).find((q) => q.key === 'explore') || {};
		const bestTry = X.bestTry ? X.bestTry.dist : null;
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((res) => setTimeout(res, 40)); }
		const ca = fs.existsSync(cpuLog) ? JSON.parse(fs.readFileSync(cpuLog, 'utf8')) : [];
		check('the steer field on the CPU alone: the CPU search measures by it (--steer, no --steerDist=0), its attempt (50) is the nearest, every move\'s (12 by the reach field) ranks behind (6012) and keeps its own chain',
			!!st.steer && !st.steer.gpu && ca.some((x) => x.startsWith('--steer=')) && !ca.includes('--steerDist=0') && st.closest && st.closest.dist === 50 && st.closest.steer === 50 &&
			X.best === 6012 && bestTry === 6012,
			`steer ${JSON.stringify(st.steer && { gpu: st.steer.gpu, cpu: st.steer.cpu })}; cpu args ${ca.filter((x) => /steer/i.test(x)).join(' ')}; closest ${JSON.stringify(st.closest && { dist: st.closest.dist, steer: st.closest.steer, strategy: st.closest.strategy })}; every move best ${X.best}, own chain ${bestTry}`);
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
	// (a proof about a level is a proof about a FILE: the verdict names it and its md5, src/levelcheck.js)
	const hiMd5 = require('crypto').createHash('md5').update(hiBuf).digest('hex');
	check('... and the verdict names the level file and its md5 (the summary line and the done event\'s levelFile)', u.done && u.done.levelFile === `toohigh.eelvl, md5 ${hiMd5}` &&
		u.summary.endsWith(`(the reach field rules the start out: toohigh.eelvl, md5 ${hiMd5})`), `${u.done && u.done.levelFile} | ${u.summary}`);

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
	// the speed cells (--spd, coarse cells): a 60 x 50 level whose trophy stands behind a 5-coin door, the level's 5 coins
	// behind it too: the search stalls at the door, so after --spd seconds without progress the frontier room gets the
	// fastest arrival's cells next to the earliest (EEAT_SPDLOG records the flag); --spd=0 never flags; neither finds a route
	// (the door never opens: the flags add cells, they never let a state through). --roomDead=0: the room dead ends
	// (dead-end-traps) prove this start a dead end (no coin on its side: the whole room is cut at once, 1 cell), and the
	// stall is the point. (The coins exist: with none, the reach field's never-open coin doors (reach.js neverOpenDoors,
	// hx-int-1) make the door a wall, the start is cut off and the search ends at once: sound, but no stall either)
	const sd = room(60, 50);
	for (let y = 1; y < 49; y++) sd.push([30, y, 43, 5]);
	for (let x = 5; x < 28; x += 4) sd.push([x, 44 - (x % 8), 9]);
	for (let x = 40; x < 45; x++) sd.push([x, 30, 100]);
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
	// (each switch opens a door of its own in the top row: a switch no door reads is no room change, goexplore.js
	// switchReaders, so without them the level had 2 rooms, not 1024)
	const sw = room(60, 50);
	for (let k = 0; k < 10; k++) sw.push([4 + 2 * k, 48, 113, k + 1], [4 + 2 * k, 1, 184, k + 1]);
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
	// the stall ladder (bursts.js stallStep, --stallLadder): an arm's bursts that gained nothing (no target, no room, not a
	// tile nearer) count; at STALL_N the start goes up the ladder, once per start (by its length); a gain starts over; a
	// ladder's own bursts do not count
	{
		const arm = {}, st1 = [];
		const job = (len, extra) => Object.assign({ inputs: 'x'.repeat(len), startDist: 40, chain: 0 }, extra || {});
		const miss = { reached: false, fresh: 0, near: 40 };
		for (let k = 0; k < 3; k++) st1.push(BU.stallStep(arm, job(500), miss));
		const again = [BU.stallStep(arm, job(500), miss), BU.stallStep(arm, job(500), miss), BU.stallStep(arm, job(500), miss)];
		const other = [BU.stallStep(arm, job(300), miss), BU.stallStep(arm, job(300), miss), BU.stallStep(arm, job(300), miss)];
		const arm2 = {};
		const gainReset = [BU.stallStep(arm2, job(500), miss), BU.stallStep(arm2, job(500), miss), BU.stallStep(arm2, job(500), { reached: false, fresh: 0, near: 30 }),
			BU.stallStep(arm2, job(500), miss), BU.stallStep(arm2, job(500), { reached: false, fresh: 1, near: 40 }), BU.stallStep(arm2, job(500), miss)];
		const ladderOwn = BU.stallStep({ stall: 5 }, job(500, { stallLadder: true }), miss);
		check('the stall ladder: 3 bursts of an arm that gain nothing send the start up the ladder (the 3rd), the same start never again, another start at once while the arm stays stalled; a nearer tile or a new room starts the count over; a ladder\'s own bursts do not count',
			BU.STALL_N === 3 && st1.join() === 'false,false,true' && again.join() === 'false,false,false' && other.join() === 'true,false,false' &&
			gainReset.every((x) => x === false) && ladderOwn === false && BU.STALL_WALL.length > 4,
			`${st1} / ${again} / ${other} / ${gainReset} / ${ladderOwn}`);
	}
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
	// (entered: the key is 9 tiles from the spawn, ~55 ticks of running from rest at the least; the search before the
	// DEFAULTS flip entered the key's room after 100+ ticks, Find a route's defaults (editor.js GX_DEFAULTS) after 94)
	ED.start({ eelvlB64: kdBuf.toString('base64'), seconds: 3, workers: 1 }, { available: false, why: 'test: no GPU' });
	for (const t0 = Date.now(); ED.state().running && Date.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));
	const ss = ED.state();
	check('the editor keeps the CPU search\'s sources (per room: where it was entered, its nearest attempt, the relay runs from it)', ss.stage === 'found' && Array.isArray(ss.sources) &&
		ss.sources.some((s) => s.desc === 'key:red' && s.gain > 0 && s.entered >= 50 && s.best && s.runs === 0 && s.from === 'random runs (CPU)'),
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
	check('... the verdict and the log name the level file\'s md5 (a proof about a level is about a file)', st.file === `level file md5 ${hiMd5}` &&
		st.message.includes(`The level: level file md5 ${hiMd5}.`) && st.log.some((x) => x.includes(`the physics check finds no way from the start to the trophy on this level (level file md5 ${hiMd5};`)), st.message);
	check('... and no proof (eegpu prove) runs: the physics check has proven it already', !st.proof, JSON.stringify(st.proof || null));
	// a steer field built after the search started (the wait forced to 0 ms; a key off the way: 2 layers, on a level no
	// earlier search built it for): the CPU search takes it when it arrives (goexplore.js stdin "steerd <file>", its
	// "steer" event) and measures the attempts by it from then on (Forgotten Helix's field arrives ~30 s in: before, the
	// reach field's walk through every coin door measured them for the whole search): the nearest attempt starts over,
	// and one kept after the switch is the steer field's
	const LW = 44, LH = 7, lcells = [...room(LW, LH), [18, 5, 255], [1, 5, 6], [LW - 4, 5, 121]];
	for (let y = 1; y < LH - 1; y++) lcells.push([LW - 6, y, 23]);
	const kdLate = ED.eelvlOf({ name: 'late steer', width: LW, height: LH, cells: lcells });
	ED.start({ eelvlB64: kdLate.toString('base64'), seconds: 6, workers: 1 }, { available: false, why: 'test: no GPU' }, { steerWaitMs: 0 });
	st = await waitDone(25000);
	check('a late steer field: taken when its build ends (the CPU search\'s head A from then on, its "steer" event), the distances its own from then on',
		st.stage === 'found' && !!st.steer && Number.isFinite(st.steer.late) && Number.isFinite(st.steer.cpuAt) && !st.steer.gpu && st.log.some((x) => /the steer field is still building/.test(x)) &&
		st.log.some((x) => /arrived [\d.]+ s into the search: from now on it orders the CPU search.* and measures the attempts \(the nearest starts over\)/.test(x)) && (!st.closest || st.closest.steer !== undefined),
		`${st.stage}; steer ${JSON.stringify(st.steer)}; ${st.log.filter((x) => /steer/.test(x)).join(' | ')}`);
	// ... the attempts on their way at the switch: a CPU search (here a stand-in) that took "steerd" still sends a closest
	// attempt and a source of the reach field's (without sg: its pipe, a worker's chunk). Neither is its own nearest nor the
	// nearest, the source ranks behind (STEER_MISS + its distance); the ones after the switch (sg 1) are. Before, the old
	// closest (10) set the CPU search's own best and its later attempts by the steer field (50) never beat it, and the old
	// source stayed its room's best (Forgotten Helix: reach costs ~925 against the steer field's 1000-2100)
	{
		const SW = 46, SH = 7, scells = [...room(SW, SH), [18, 5, 255], [1, 5, 6], [SW - 4, 5, 121]];
		for (let y = 1; y < SH - 1; y++) scells.push([SW - 6, y, 23]);
		const kdSw = ED.eelvlOf({ name: 'late steer race', width: SW, height: SH, cells: scells });
		const stub = path.join(HOME, 'fake-cpu-steerd.js'), swLog = path.join(HOME, 'steerd-stub.log');
		fs.writeFileSync(stub, `'use strict';
const fs = require('fs');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'coarse', startCost: 40 });
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 50, found: 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
let sb = '';
process.stdin.on('data', (d) => {
	sb += d;
	for (let k; (k = sb.indexOf('\\n')) >= 0;) {
		const line = sb.slice(0, k); sb = sb.slice(k + 1);
		fs.appendFileSync(${JSON.stringify(swLog)}, line + '\\n');
		if (line.startsWith('steerd ')) {
			say({ ev: 'closest', dist: 10, tick: 12, inputs: '4'.repeat(12) });
			say({ ev: 'source', kind: 'best', room: 7, desc: 'test', gain: 0, tick: 12, dist: 10, inputs: '4'.repeat(12), seed: 1 });
			say({ ev: 'steer', sec: 1, dist: true });
			setTimeout(() => {
				say({ ev: 'closest', dist: 50, tick: 14, inputs: '4'.repeat(14), sg: 1 });
				say({ ev: 'source', kind: 'best', room: 7, desc: 'test', gain: 0, tick: 14, dist: 50, inputs: '4'.repeat(14), seed: 1, sg: 1 });
			}, 400);
		}
		if (line === 'stop') end();
	}
});
process.stdin.on('end', end);
`);
		ED.start({ eelvlB64: kdSw.toString('base64'), seconds: 20, workers: 1 }, { available: false, why: 'test: no GPU' }, { steerWaitMs: 0, cpu: [process.execPath, stub] });
		let sw = ED.state();
		const src7 = (x) => (x.sources || []).find((r) => r.room === 7);
		const cpuOf = (x) => (x.strategies || []).find((q) => q.key === 'goexplore') || {};
		const settled = (x) => x.closest && x.closest.dist === 50 && src7(x) && src7(x).best && src7(x).best.tiles === 50 && cpuOf(x).best === 50;
		for (const t0 = Date.now(); sw.running && !settled(sw) && Date.now() - t0 < 25000; sw = ED.state()) await new Promise((res) => setTimeout(res, 50));
		const G = cpuOf(sw), s7 = src7(sw);
		if (sw.running) { ED.stop(); while (ED.state().running) await new Promise((res) => setTimeout(res, 50)); }
		const got = fs.existsSync(swLog) ? fs.readFileSync(swLog, 'utf8') : '';
		check('... an attempt of the reach field\'s on its way at the switch (no sg): not the CPU search\'s own nearest nor the nearest, its source ranked behind; the ones after it (sg 1, 50) are',
			/^steerd /m.test(got) && sw.closest && sw.closest.dist === 50 && G.best === 50 && G.bestTry && G.bestTry.dist === 50 && s7 && s7.best && s7.best.tiles === 50,
			`stdin ${JSON.stringify(got.slice(0, 120))}; closest ${sw.closest && sw.closest.dist}; own best ${G.best} (chain ${G.bestTry && G.bestTry.dist}); room 7 ${JSON.stringify(s7 && s7.best)}`);
	}
	// ... a late field with the coin tour (steer.js buildTour: 25 coins and a 25-coin door, the coins modelled): the running
	// CPU search is sent the CPU file (`<field>_cpu.bin`, flags 2: the tour), not the plain one (the GPU tools'); the
	// cycle-1 branch set steerCpu to the CPU file for later launches but sent the plain file on this line, so the
	// running one search never read the tour where the field came late (Diamond underground: 17-20 s into the search)
	{
		const SFT = require('../src/steer.js');
		const TW = 48, TH = 30, tcells = [...room(TW, TH)];
		for (let y = 1; y < 22; y++) for (let x = 1; x < TW - 1; x++) tcells.push([x, y, 9]);
		let nc = 0;
		for (let x = 2; x <= 42 && nc < 25; x++) { if (x === 28) continue; tcells.push([x, nc % 2 ? 26 : 28, 100]); nc++; }
		tcells.push([28, 28, 255]);
		for (let y = 22; y <= 28; y++) tcells.push([44, y, 43, 25]);
		tcells.push([46, 28, 121]);
		const kdT = ED.eelvlOf({ name: 'late steer tour', width: TW, height: TH, cells: tcells });
		const stubT = path.join(HOME, 'fake-cpu-steertour.js'), tLog = path.join(HOME, 'steertour-stub.log');
		fs.writeFileSync(stubT, `'use strict';
const fs = require('fs');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'fine', startCost: 40 });
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 50, found: 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
let sb = '';
process.stdin.on('data', (d) => {
	sb += d;
	for (let k; (k = sb.indexOf('\\n')) >= 0;) {
		const line = sb.slice(0, k); sb = sb.slice(k + 1);
		fs.appendFileSync(${JSON.stringify(tLog)}, line + '\\n');
		if (line.startsWith('steerd ')) say({ ev: 'steer', sec: 1, dist: true });
		if (line === 'stop') end();
	}
});
process.stdin.on('end', end);
`);
		ED.start({ eelvlB64: kdT.toString('base64'), seconds: 20, workers: 1 }, { available: false, why: 'test: no GPU' }, { steerWaitMs: 0, cpu: [process.execPath, stubT] });
		let tw = ED.state();
		const sent = () => (fs.existsSync(tLog) ? fs.readFileSync(tLog, 'utf8') : '');
		for (const t0 = Date.now(); tw.running && !/^steerd /m.test(sent()) && Date.now() - t0 < 25000; tw = ED.state()) await new Promise((res) => setTimeout(res, 50));
		const logT = (ED.state().log || []).slice();
		if (ED.state().running) { ED.stop(); while (ED.state().running) await new Promise((res) => setTimeout(res, 50)); }
		const line = (/^steerd (.*)$/m.exec(sent()) || [])[1] || '';
		let tour = null;
		try { tour = SFT.readSteerFile(fs.readFileSync(line)).tour; } catch (e) { /* no file */ }
		check('... a late field with the coin tour: the running CPU search is sent the CPU file (the tour), and the note says so',
			/_cpu\.bin$/.test(line) && !!tour && tour.n === 25 && tour.T === 25 && !tour.first && logT.some((x) => /the coin tour over 25 coins.*arrived [\d.]+ s into the search/.test(x)),
			`stdin ${JSON.stringify(sent().slice(0, 160))}; tour ${tour ? `${tour.n} coins, T ${tour.T}, first ${tour.first}` : 'none'}; ${logT.filter((x) => /steer field/.test(x)).join(' | ').slice(0, 300)}`);
	}

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
	const md5b2 = require('crypto').createHash('md5').update(buf2).digest('hex');
	check('... "No route (proven)" names the level file (its md5), in the verdict and the proof\'s log line', /^No route \(proven\): /.test(st.message) &&
		st.message.includes(`The level: level file md5 ${md5b2}.`) && st.log.some((x) => x.includes(`the proof: no input sequence reaches the trophy on this level (level file md5 ${md5b2};`)), st.message);
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
// ---------------------------------------------------------------- the exploration view's data (src/heat.js)
/** a storeyed test level W x H (coarse cells above 50 x 50): floors 12 rows apart, each with holes and a staircase of
 *  short platforms under every hole, coins; the start bottom left, the trophy on the top floor at the right */
function storeys(W, H, seed) {
	const rnd = rngOf(seed);
	const set = new Map();
	const put = (x, y, id, ...a) => { if (x >= 1 && y >= 1 && x < W - 1 && y < H - 1) set.set(y * W + x, [x, y, id, ...a]); };
	const del = (x, y) => set.delete(y * W + x);
	for (let x = 0; x < W; x++) { set.set(x, [x, 0, 9]); set.set((H - 1) * W + x, [x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { set.set(y * W, [0, y, 9]); set.set(y * W + W - 1, [W - 1, y, 9]); }
	let top = H - 1;
	for (let fy = H - 13; fy > 6; fy -= 12) {
		top = fy;
		for (let x = 1; x < W - 1; x++) put(x, fy, 9);
		for (let x = 6 + ((rnd() * 20) | 0); x < W - 6; x += 18 + ((rnd() * 30) | 0)) {
			for (let i = 0; i < 4; i++) del(x + i, fy);
			const dir = rnd() < 0.5 ? -1 : 1;
			for (let k = 1; k <= 3; k++) for (let i = -1; i <= 1; i++) put(x + 1 + dir * 4 * k + i, fy + 3 * k, 9);
		}
		for (let k = 0; k < W / 12; k++) { const px = 2 + ((rnd() * (W - 4)) | 0), py = fy + 11; if (!set.has(py * W + px) && set.has((py + 1) * W + px)) put(px, py, 100); }
	}
	for (let x = 1; x < 5; x++) del(x, H - 2);
	put(2, H - 2, 255);
	for (let x = W - 6; x < W - 1; x++) for (let y = top - 4; y < top; y++) del(x, y);
	put(W - 3, top - 1, 121);
	return { name: `storeys ${W}x${H}`, width: W, height: H, cells: [...set.values()] };
}
// A stand-in for the CPU search (the editor's view of goexplore.js --heat=1): logs its arguments (argLog), then plays the
// scenario's events (heat, closest, source) SC.gap ms apart, progress lines until "stop" or the end of its stdin
const FAKE_HEAT = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (SC.argLog) fs.writeFileSync(SC.argLog, JSON.stringify(process.argv.slice(3)));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'coarse', startCost: 40 });
let k = 0;
const next = () => { const e = SC.events[k++]; if (!e) return; say(e); setTimeout(next, SC.gap || 150); };
setTimeout(next, SC.wait || 100);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 40, found: 0, refined: 0, rooms: 1, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (/stop/.test(String(d))) end(); });
process.stdin.on('end', end);
`;
// A stand-in for eegpu roll (goexplore.js --gpu=1: its protocol, no GPU): ready and start (the start's room 0), then per
// "batch K ..." line and its K pick ids a record of a new cell for each of the first 64 picks (room 0, its run's first 20
// ticks), "seen" the seen counts, "stop" or the end of stdin its done line
const FAKE_ROLL = `'use strict';
const say = (o, data) => { const b = Buffer.from(JSON.stringify(data ? Object.assign({}, o, { bytes: data.length }) : o) + '\\n'); process.stdout.write(data ? Buffer.concat([b, data]) : b); };
say({ ev: 'ready', loadMs: 1, allocMs: 1 });
say({ ev: 'start', room: 0, cap: 1 << 20, memMB: 1, hostMB: 1, gpu: { name: 'stand-in' } });
let buf = Buffer.alloc(0), cells = 1, batches = 0, want = 0, done = false;
const end = () => { if (done) return; done = true; say({ ev: 'done', end: 'stopped', batches }); process.exit(0); };
process.stdin.on('data', (c) => {
	buf = Buffer.concat([buf, c]);
	for (;;) {
		if (want) {
			if (buf.length < want * 4) return;
			const K = want;
			buf = buf.subarray(K * 4); want = 0; batches++;
			const n = Math.min(K, 64), rec = Buffer.alloc(24 * n);
			for (let j = 0; j < n; j++) {
				const d = cells++;
				rec.writeInt32LE(d, 24 * j); rec.writeInt32LE(batches * 20, 24 * j + 4); rec.writeInt32LE(Math.max(5, 50000 - 5 * d), 24 * j + 8);
				rec.writeInt32LE(0, 24 * j + 12); rec.writeInt32LE(j, 24 * j + 16); rec.writeInt32LE((j % 8) | (19 << 16), 24 * j + 20);
			}
			say({ ev: 'batch', n, fin: 0, ticks: K * 8 * 20, ms: 2, kernelMs: 2, rollMs: 1 }, rec);
			continue;
		}
		const k = buf.indexOf(10);
		if (k < 0) return;
		const w = buf.subarray(0, k).toString().trim().split(' ');
		buf = buf.subarray(k + 1);
		if (w[0] === 'batch') want = +w[1];
		else if (w[0] === 'seen') say({ ev: 'seen' }, Buffer.alloc(4 * cells));
		else if (w[0] === 'stop') end();
	}
});
process.stdin.on('end', end);
`;
/**
 * The exploration view's data: src/heat.js (the heat events' encodings, the marks, the HeatMap's merge and its deltas since
 * a version, the downsampled trails, the trails' cap); goexplore.js --heat=1 with one worker (its heat events' tiles = the
 * tiles of every cell its archive made; the flag off: the same search, no heat event); the GPU random runs' heat (a stand-in
 * for eegpu roll: the sampled runs replayed, the tiles in the level, the start's; the flag off: the same search); the
 * editor's merge of a stand-in search's heat events and the tips of its attempts, its trails (the nearest attempts replayed
 * anyway, the sources in turn), GET /api/editor/solve/heat (deltas since a version, the trails since an id, another search
 * starting over), --heat=1 on the CPU search's command line.
 */
async function exploreSection() {
	section('explore: the exploration view\'s data (src/heat.js; goexplore.js --heat=1; the editor\'s heat and trails, GET /api/editor/solve/heat)');
	// ---- src/heat.js
	{
		const e1 = HX.heatEvent(40, 20, [0, 5, 799]), t1 = HX.heatTiles(e1, 40, 20);
		const many = Array.from({ length: 300 }, (_, k) => (k * 7) % 800), e2 = HX.heatEvent(40, 20, [...new Set(many)]), t2 = HX.heatTiles(e2);
		const bad = HX.heatTiles(e1, 41, 20), odd = HX.heatTiles({ ev: 'heat', w: 2, h: 2, enc: 'idx', tiles: Buffer.from(new Uint32Array([1, 9]).buffer).toString('base64') });
		const M = HX.heatMarks(10);
		M.mark(3); M.mark(3); M.mark(7); M.add([7, 8, 20, -1]);
		const took = Array.from(M.take()), after = M.n;
		M.mark(3);
		check('heat.js: the heat event\'s encodings (a few tiles: their indices; many: a bitset of the level) read back the same; another level\'s event refused, indices outside the level dropped; the marks (each tile once until taken)',
			e1.enc === 'idx' && e1.n === 3 && Array.from(t1).join() === '0,5,799' && e2.enc === 'bits' && Array.from(t2).sort((a, b) => a - b).join() === [...new Set(many)].sort((a, b) => a - b).join() &&
			bad === null && Array.from(odd).join() === '1' && took.join() === '3,7,8' && after === 0 && M.n === 1, JSON.stringify({ e1: e1.enc, e2: e2.enc, took, odd: odd && Array.from(odd) }));
		const HM = new HX.HeatMap(10, 10);
		HM.merge([1, 2], 100); HM.merge([2, 3], 250); HM.merge([], 300);
		const full = HM.since(0), delta = HM.since(1), none = HM.since(2);
		const dec = (r) => { const I = Buffer.from(r.idx, 'base64'), Cn = Buffer.from(r.count, 'base64'), Ls = Buffer.from(r.last, 'base64'); return Array.from({ length: r.n }, (_, i) => `${I.readUInt32LE(4 * i)}:${Cn.readUInt16LE(2 * i)}@${Ls.readUInt32LE(4 * i)}`).sort().join(' '); };
		HM.count[5] = 65534; HM.merge([5], 400); HM.merge([5], 500);
		check('heat.js HeatMap: per tile the visits and the last visit, a version per update; since(0) every visited tile, since(v) the tiles changed after v, since(the version) nothing; the count saturates at 65535',
			full.full && full.version === 2 && dec(full) === '1:1@100 2:2@250 3:1@250' && !delta.full && dec(delta) === '2:2@250 3:1@250' && !none.full && none.n === 0 && none.version === 2 &&
			HM.count[5] === 65535 && HM.visited === 3, JSON.stringify({ full: dec(full), delta: dec(delta), none: none.n, c5: HM.count[5] }));
		{
			// (the first visits: the page colours a tile by when the search first got there)
			const HF = new HX.HeatMap(10, 10);
			HF.merge([1, 2], 100); HF.merge([2, 3], 250); HF.merge([1], 400);
			const firsts = (r) => { const I = Buffer.from(r.idx, 'base64'), Fs = Buffer.from(r.first, 'base64'), Ls = Buffer.from(r.last, 'base64'); return Array.from({ length: r.n }, (_, i) => `${I.readUInt32LE(4 * i)}:${Fs.readUInt32LE(4 * i)}-${Ls.readUInt32LE(4 * i)}`).sort().join(' '); };
			const all = firsts(HF.since(0)), d2 = firsts(HF.since(2)), none = HF.since(3);
			check('heat.js HeatMap: each tile\'s first visit kept (a tile seen again keeps it, its last visit moves on), in every answer (the full one and the deltas)',
				all === '1:100-400 2:100-250 3:250-250' && d2 === '1:100-400' && none.n === 0 && none.first === '' && HF.first[2] === 100, JSON.stringify({ all, d2 }));
		}
		const H2 = new HX.HeatMap(4, 4);
		for (let k = 0; k < 600; k++) H2.merge([k % 16], k);
		const old = H2.since(5);
		check('heat.js HeatMap: a version older than its change log keeps (at most 512 updates): every visited tile (full)', old.full && old.n === 16 && H2.log.length <= 512, `${old.full} ${old.n} ${H2.log.length}`);
		const P = [];
		for (let t = 0; t <= 1000; t++) P.push(t < 600 ? [8 + t * 0.5, 100.4] : [2000 + (t - 600), 50]);
		const d = HX.downsample(P, 200), short = HX.downsample(P.slice(0, 50), 200);
		const brk = d.br.map((i) => [d.pts[2 * i], d.pts[2 * i + 1]]);
		check('heat.js downsample: at most ~200 points of whole px, the first and the last kept, a jump of more than 40 px (a portal, a respawn) a new piece; a short path whole',
			d.pts.length / 2 <= 205 && d.pts.length / 2 >= 150 && d.pts[0] === 8 && d.pts[1] === 100 && d.pts[d.pts.length - 2] === 2400 && d.br.length === 1 && brk[0][0] === 2000 &&
			d.pts[2 * d.br[0] - 2] === Math.round(8 + 599 * 0.5) && short.pts.length === 100 && short.br.length === 0, JSON.stringify({ n: d.pts.length / 2, br: d.br, brk }));
		const TR = new HX.Trails();
		for (let k = 0; k < 70; k++) TR.add({ k: 'x', t: k });
		check('heat.js Trails: the newest TRAIL_MAX (60), an id each, since(id) the newer ones', TR.list.length === 60 && TR.list[0].id === 11 && TR.id === 70 && TR.since(65).map((x) => x.id).join() === '66,67,68,69,70' && TR.since(70).length === 0);
	}
	// ---- goexplore.js --heat=1: the CPU search, one worker, a tick budget (the same search with the flag on or off)
	const lv = storeys(80, 40, 7), lvFile = path.join(HOME, 'storeys80.eelvl');
	fs.writeFileSync(lvFile, ED.eelvlOf(lv));
	{
		const opts = ['--workers=1', '--seed=1', '--maxTicks=6000000', '--seconds=60'];
		const [on, off] = [await goexplore(lvFile, [...opts, '--heat=1']), await goexplore(lvFile, opts)];
		const heats = on.events.filter((e) => e.ev === 'heat'), U = new Set();
		let okTiles = true;
		for (const e of heats) { const t = HX.heatTiles(e, 80, 40); if (!t || t.length !== e.n) okTiles = false; else for (const x of t) U.add(x); }
		const d1 = on.done || {}, d0 = off.done || {}, w1 = (d1.workers || [])[0] || {}, w0 = (d0.workers || [])[0] || {};
		const same = ['ticks', 'states', 'picks', 'finish', 'tiles', 'end'].every((k) => d1[k] === d0[k]) && ['cells', 'picks', 'impr', 'rooms', 'evicted'].every((k) => w1[k] === w0[k]) &&
			on.results.map((r) => r.inputs).join() === off.results.map((r) => r.inputs).join();
		check('goexplore.js --heat=1 (one worker): heat events at most every 2 s (and a last one), their tiles every tile its archive made a cell in (its done event\'s tiles, no cell swept)',
			heats.length >= 2 && heats.length <= Math.ceil(d1.seconds / 2) + 2 && okTiles && w1.evicted === 0 && U.size === d1.tiles && d1.tiles > 100,
			JSON.stringify({ events: heats.length, n: heats.map((e) => e.n), union: U.size, tiles: d1.tiles, evicted: w1.evicted, seconds: d1.seconds }));
		check('goexplore.js without --heat: no heat event, the same search (the same ticks, cells, picks, improvements, rooms, routes as with it)', !off.events.some((e) => e.ev === 'heat') && same,
			JSON.stringify({ on: [d1.ticks, d1.states, d1.picks, d1.finish, w1.impr], off: [d0.ticks, d0.states, d0.picks, d0.finish, w0.impr], routes: [on.results.length, off.results.length] }));
	}
	// ---- the GPU random runs' heat (goexplore.js --gpu=1 with a stand-in for eegpu roll: no GPU)
	{
		const fake = path.join(HOME, 'fake-roll.js');
		fs.writeFileSync(fake, FAKE_ROLL);
		const opts = ['--gpu=1', `--tool=${fake}`, '--rollMix=0', '--seed=1', '--maxTicks=6000000', '--seconds=60', '--batch=512'];
		const [on, off] = [await goexplore(lvFile, [...opts, '--heat=1']), await goexplore(lvFile, opts)];
		const heats = on.events.filter((e) => e.ev === 'heat'), U = new Set();
		for (const e of heats) for (const x of HX.heatTiles(e, 80, 40) || []) U.add(x);
		const sim = new E.EESim(ED.inspect(ED.eelvlOf(lv)).level);
		sim.reset();
		const startTile = (Math.trunc(sim.py + 8) >> 4) * 80 + (Math.trunc(sim.px + 8) >> 4);
		const d1 = on.done || {}, d0 = off.done || {};
		check('the GPU random runs\' heat (a stand-in eegpu roll): the sampled cells\' runs replayed while the GPU plays (heatReplays), their tiles and the start\'s in the heat, every tile in the level',
			d1.end === 'ticks' && d1.heatReplays > 0 && heats.length >= 1 && U.has(startTile) && U.size > 5 && [...U].every((t) => t >= 0 && t < 3200),
			JSON.stringify({ end: d1.end, batches: d1.batches, replays: d1.heatReplays, events: heats.length, tiles: U.size, err: on.err.slice(-300) }));
		check('... without --heat: no heat event, the same search (the same batches, ticks, cells, picks)', !off.events.some((e) => e.ev === 'heat') && d0.heatReplays === undefined &&
			['batches', 'ticks', 'states', 'picks', 'rooms', 'end'].every((k) => d1[k] === d0[k]), JSON.stringify({ on: [d1.batches, d1.ticks, d1.states, d1.picks], off: [d0.batches, d0.ticks, d0.states, d0.picks] }));
	}
	// ---- the editor: a stand-in search's heat events and attempts, GET /api/editor/solve/heat
	{
		const fake = path.join(HOME, 'fake-heat.js'), sc = path.join(HOME, 'heat-sc.json'), argLog = path.join(HOME, 'heat-args.json');
		fs.writeFileSync(fake, FAKE_HEAT);
		const A = [81, 82, 83, 162], B = [83, 84, 400];
		const inp = (ch, n) => ch.repeat(n);
		fs.writeFileSync(sc, JSON.stringify({ argLog, wait: 200, gap: 150, events: [HX.heatEvent(80, 40, A), { ev: 'closest', dist: 30, tick: 150, inputs: inp('4', 150) }, HX.heatEvent(80, 40, B),
			{ ev: 'closest', dist: 20, tick: 250, inputs: inp('4', 250) }, { ev: 'source', kind: 'room', room: 5, desc: 'x', gain: 3, tick: 120, dist: 25, inputs: inp('5', 120) }] }));
		const buf = ED.eelvlOf(lv);
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, workers: 1 }, { available: false, why: 'test' }, { cpu: [process.execPath, fake, sc], steer: false });
		const t0 = Date.now();
		while (ED.state().running && !(ED.heatState(0, 0, 0).trails.length >= 3) && Date.now() - t0 < 20000) await new Promise((res) => setTimeout(res, 100));
		const st = ED.state(), h0 = ED.heatState(0, 0, 0);
		// (the expected tips: each attempt replayed as the editor does, its last EXP_TIP ticks' tiles)
		const L = ED.inspect(buf).level;
		const tipTiles = (inputs) => {
			const s = new E.EESim(L), ip = new E.EEInput();
			s.reset();
			const P = [[s.px + 8, s.py + 8]];
			for (const c of inputs) { E.applyMask(ip, (c.charCodeAt(0) - 48) & 31); s.tick(ip); P.push([s.px + 8, s.py + 8]); }
			const T = new Set();
			for (let i = Math.max(0, P.length - ED.EXP_TIP); i < P.length; i++) T.add(Math.floor(P[i][1] / 16) * 80 + Math.floor(P[i][0] / 16));
			return T;
		};
		const want = new Set([...A, ...B, ...tipTiles(inp('4', 150)), ...tipTiles(inp('4', 250)), ...tipTiles(inp('5', 120))]);
		const dec = (r) => { const I = Buffer.from(r.idx, 'base64'), Cn = Buffer.from(r.count, 'base64'); const m = new Map(); for (let i = 0; i < r.n; i++) m.set(I.readUInt32LE(4 * i), Cn.readUInt16LE(2 * i)); return m; };
		const m0 = dec(h0);
		const args = fs.existsSync(argLog) ? JSON.parse(fs.readFileSync(argLog, 'utf8')) : [];
		const trs = h0.trails;
		check('the editor\'s heat: the CPU search started with --heat=1; its heat events and the tips of its attempts (the nearest ones replayed anyway, the room source in turn) merged: every such tile, a tile of two events counted twice',
			args.includes('--heat=1') && h0.search === st.started && h0.w === 80 && h0.h === 40 && h0.full && m0.size === want.size && [...want].every((t) => m0.has(t)) && m0.get(83) === 2 && m0.get(81) === 1 && h0.visited === want.size,
			JSON.stringify({ args: args.includes('--heat=1'), visited: h0.visited, want: want.size, c83: m0.get(83), missing: [...want].filter((t) => !m0.has(t)).slice(0, 8) }));
		check('the editor\'s trails: the attempts downsampled (at most ~200 points, whole px, from the start), each with its search, its ticks and its time; the newer ones since an id',
			trs.length === 3 && trs.every((x) => x.k === 'goexplore' && x.label === 'random runs (CPU)' && x.pts.length >= 4 && x.pts.length <= 2 * (HX.TRAIL_PTS + 4) && Number.isInteger(x.pts[0]) && x.t > 0) &&
			trs.map((x) => x.ticks).sort((a, b) => a - b).join() === '120,150,250' && ED.heatState(h0.version, h0.trailId, h0.search).trails.length === 0 &&
			ED.heatState(h0.version, trs[0].id, h0.search).trails.length === 2, JSON.stringify(trs.map((x) => ({ id: x.id, k: x.k, ticks: x.ticks, n: x.pts.length / 2 }))));
		const hv = ED.heatState(h0.version, h0.trailId, h0.search), hOld = ED.heatState(h0.version - 1, 0, h0.search), mOld = dec(hOld);
		check('GET heat since the page\'s version: nothing new (not full), since the version before: that update\'s tiles only', !hv.full && hv.n === 0 && hv.version === h0.version && !hOld.full && hOld.n > 0 && hOld.n < h0.n &&
			[...mOld.keys()].every((t) => m0.has(t)), JSON.stringify({ hv: [hv.full, hv.n], old: [hOld.full, hOld.n, h0.n] }));
		// over HTTP (an in-process server on its own port)
		const SV = require('../src/server.js');
		await new Promise((res) => SV.server.listen(0, '127.0.0.1', res));
		const port = SV.server.address().port;
		let r1, r2;
		try {
			r1 = await request(port, 'GET', `/api/editor/solve/heat?search=${h0.search}&since=${h0.version}&trail=${h0.trailId}`);
			r2 = await request(port, 'GET', '/api/editor/solve/heat');
		} finally { await new Promise((res) => SV.server.close(res)); }
		check('GET /api/editor/solve/heat: the same answers (the page\'s version and trail id: nothing new; no search given: every tile and trail)', r1.status === 200 && r1.json.n === 0 && !r1.json.full && r1.json.trails.length === 0 &&
			r2.status === 200 && r2.json.full && r2.json.n === h0.n && r2.json.trails.length === 3 && r2.json.search === h0.search, `${r1.status} ${JSON.stringify(r1.json && [r1.json.n, r1.json.full])} ${r2.status}`);
		ED.stop();
		while (ED.state().running) await new Promise((res) => setTimeout(res, 50));
		const hEnd = ED.heatState(h0.version, h0.trailId, h0.search), hEnd2 = ED.heatState(h0.version, h0.trailId, h0.search);
		// another search: from scratch (the page's old version and search: every tile of the new one)
		fs.writeFileSync(sc, JSON.stringify({ wait: 100, gap: 100, events: [HX.heatEvent(80, 40, [5])] }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, workers: 1 }, { available: false, why: 'test' }, { cpu: [process.execPath, fake, sc], steer: false });
		const t1 = Date.now();
		while (ED.state().running && ED.heatState(0, 0, 0).visited < 1 && Date.now() - t1 < 10000) await new Promise((res) => setTimeout(res, 50));
		const hNew = ED.heatState(h0.version, h0.trailId, h0.search);
		ED.stop();
		while (ED.state().running) await new Promise((res) => setTimeout(res, 50));
		check('a stopped search\'s heat stays (its clock stopped at its end); another search starts it over (the page\'s old version: every tile of the new one)', !hEnd.running && hEnd.t === hEnd2.t && hEnd.t > 0 &&
			hNew.search !== h0.search && hNew.full && hNew.visited === 1 && hNew.version === 1 && hNew.trails.length === 0, JSON.stringify({ end: [hEnd.running, hEnd.t, hEnd2.t], new: [hNew.search, hNew.visited, hNew.version] }));
	}
	// ---- the best route's improvements (GET /api/editor/solve `improve`: the page's "best route" panel): a stand-in search
	// reporting a slow route, then a faster one, then the slow one again and the fast one again (no step either)
	{
		const W = 30, H = 8, bufR = ED.eelvlOf({ name: 'improve', width: W, height: H, cells: [...room(W, H), [2, 6, 255], [20, 6, 121]] });
		const LR = E.prepareLevel(EL.toSimLevel(EL.readEelvl(bufR)));
		const slowIn = new Uint8Array(400).fill(4);
		slowIn.fill(2, 0, 20);
		const fast = C.evaluate(LR, new Uint8Array(400).fill(4)), slow = C.evaluate(LR, slowIn);
		const str = (ms) => Array.from(ms, (m) => String.fromCharCode(48 + m)).join('');
		const res = (ev) => ({ ev: 'result', kind: 'finish', ticks: ev.ms.length, inputs: str(ev.ms) });
		const fake = path.join(HOME, 'fake-heat.js'), sc = path.join(HOME, 'improve-sc.json');
		fs.writeFileSync(sc, JSON.stringify({ wait: 100, gap: 300, events: [res(slow), res(fast), res(slow), res(fast)] }));
		ED.start({ eelvlB64: bufR.toString('base64'), seconds: 60, workers: 1, clean: false }, { available: false, why: 'test' }, { cpu: [process.execPath, fake, sc], steer: false });
		const t0 = Date.now();
		while (ED.state().running && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 100));
		const st = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((r) => setTimeout(r, 50));
		const L = st.improve || [];
		check('the best route\'s improvements (GET /api/editor/solve improve): the first route and each faster one as they came {t, runTicks, ticks, strategy}, a slower or an equal route none; the best = the result',
			fast && slow && slow.runTicks > fast.runTicks && L.length === 2 && L[0].runTicks === slow.runTicks && L[1].runTicks === fast.runTicks && L[0].ticks === slow.ms.length &&
			L[0].t <= L[1].t && L[1].t > 0 && L.every((e) => e.strategy === 'random runs (CPU)' && !e.clean) && st.result && st.result.runTicks === fast.runTicks && ED.IMPROVE_KEEP === 64,
			JSON.stringify({ L, slow: slow && slow.runTicks, fast: fast && fast.runTicks, result: st.result && st.result.runTicks }));
	}
}
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
	// the early start (fast-start): the path skips never read the steer field, so they start from the reach field's end,
	// the CPU search (which reads it) once the steer field is built
	const gx = st.strategies.find((q) => q.key === 'goexplore');
	check('the early start: the path skips launched no later than the CPU search (it waits for the steer field)',
		!!lane && !!gx && lane.launchedAt > 0 && gx.launchedAt > 0 && lane.launchedAt <= gx.launchedAt, `${lane && lane.launchedAt} vs ${gx && gx.launchedAt}`);
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
// A stand-in for a stalled CPU search (next to the stall escape, whose goexplore.js is the real one): it reports the
// scenario's attempt as its closest attempt and then only progress (a stall), logs every stdin line
const FAKE_CPU_STALL = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 4, seeds: [1, 2, 3, 4], mode: 'physics', cells: 'coarse', startCost: 40 });
setTimeout(() => say({ ev: 'closest', dist: SC.dist, tick: SC.attempt.length, inputs: SC.attempt }), 200);
if (SC.source) setTimeout(() => say({ ev: 'source', kind: 'room', room: 777, desc: 'coins=1', gain: 5, tick: SC.source.length, dist: SC.dist + 20, inputs: SC.source }), 300);
if (SC.later) setTimeout(() => say({ ev: 'closest', dist: SC.later.dist, tick: SC.later.attempt.length, inputs: SC.later.attempt }), SC.later.at);
for (const s of SC.sources || []) setTimeout(() => say({ ev: 'source', kind: s.kind || 'room', room: s.room, desc: s.desc, gain: s.gain, tick: s.inputs.length, dist: s.dist, inputs: s.inputs }), s.at || 300);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: SC.dist, found: 0, refined: 0, workers: 4, rooms: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
let buf = '';
process.stdin.on('data', (d) => {
	buf += String(d);
	let k;
	while ((k = buf.indexOf('\\n')) >= 0) {
		const line = buf.slice(0, k); buf = buf.slice(k + 1);
		fs.appendFileSync(SC.stdinLog, line + '\\n');
		if (line === 'stop') end();
	}
});
process.stdin.on('end', end);
`;
// A stand-in for an escape that never gets anywhere (no attempt, no room): the retarget alone decides when it goes
const FAKE_ESC_IDLE = `'use strict';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 2, seeds: [1001, 1002], mode: 'physics', cells: 'coarse', startCost: 40 });
const iv = setInterval(() => say({ ev: 'progress', layer: 1, tick: 1, states: 1, ticks: 1000, ticksPerSec: 1000, picks: 1, found: 0, refined: 0, workers: 2, rooms: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 1, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (/(^|\\n)stop(\\n|$)/.test(String(d))) end(); });
process.stdin.on('end', end);
`;
// The same, and it logs its command line (the stall rotation: the configuration's flags each escape gets)
const FAKE_ESC_ARGV = `'use strict';
require('fs').appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 2, seeds: [1001, 1002], mode: 'physics', cells: 'coarse', startCost: 40 });
const iv = setInterval(() => say({ ev: 'progress', layer: 1, tick: 1, states: 1, ticks: 1000, ticksPerSec: 1000, picks: 1, found: 0, refined: 0, workers: 2, rooms: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 1, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (/(^|\\n)stop(\\n|$)/.test(String(d))) end(); });
process.stdin.on('end', end);
`;
// (the escape tests of before the stall rotation: every escape as the search (base), its starts the nearest attempt's
// rotation (near); the rotation's own tests below)
const ESC_OLD = { rot: ['base'], from: ['near'] };
async function escapeSection() {
	// the stall rotation's pure parts: the configurations' list, the kinds of start, the turns
	section('the stall rotation: its configurations, kinds of start and turns');
	const rotD = ED.escRotOf(ED.ESC_ROTATION);
	check('the default rotation (the set cover of the portfolio sweep and the filler): long random runs, the longest, the longer, the reach field alone, no useful territory / dominance, the search as is; each with its goexplore.js flags; the GPU random runs follow it',
		rotD.map((c) => c.name).join(',') === 'longruns,lr3,lr2,reach,plain,base' && rotD[0].flags.join(' ') === '--roll=120 --keep=0.95' && rotD[1].flags.join(' ') === '--roll=480 --keep=0.985' &&
		rotD[2].flags.join(' ') === '--roll=240 --keep=0.97' && rotD[3].flags.join(' ') === '--mix=0 --burstSteer=' && rotD[4].flags.join(' ') === '--useful=0 --dom=0' && rotD[5].flags.length === 0 && ED.ESC_ROLLS === true &&
		ED.escRotOf('blind,reach,deaths').map((c) => c.flags.join(' ')).join('|') === '--pA=0 --burst=16|--mix=0 --burstSteer=', rotD.map((c) => `${c.name}: ${c.flags.join(' ')}`).join('; '));
	// (n3-rotation-rollmix: the GPU random runs started again by the rotation keep main's roll mix, weighted toward the
	// configuration's class; never --roll / --keep, which would turn the mix off in goexplore.js)
	{
		const GXP = require('../src/goexplore.js');
		const rl = rotD.map((c) => ED.rollsOf(c));
		const mixOf = (f) => { const x = (f || []).find((y) => y.startsWith('--rollMix=')); return x ? x.slice(10) : null; };
		// (each mix as goexplore.js --gpu=1 reads it: its classes; roll at most 255, eegpu roll's cap)
		let parsed = true;
		for (const f of rl) if (f && f.length) { try { const a = GXP.parseArgs(['x.eelvl', '--gpu=1', ...f]); if (a.rollMix !== mixOf(f)) parsed = false; } catch (e) { parsed = false; } }
		const cls = (m) => m.split(',').map((c) => c.split(':'));
		const heavy = (m) => cls(m).filter((c) => +c[2] === 3).map((c) => c[0]).join();
		const raw = ED.escRotOf(['--roll=240+--keep=0.97+--pA=0.2', '--rollMix=40:0.85:1,240:0.97:5', '--roll=90']);
		const nx = [ED.rollsNext([], rotD[0]), ED.rollsNext(rl[0], rotD[0]), ED.rollsNext(rl[0], rotD[3]), ED.rollsNext(rl[0], rotD[4]), ED.rollsNext([], rotD[5]), ED.rollsNext(rl[2], rotD[5])];
		check('the GPU random runs in the rotation: longruns / lr3 / lr2 start them again with the roll mix of main weighted 3 to 1 toward 120 / 255 (keep 0.985: the kernel 255-tick cap) / 240 ticks, never --roll / --keep; reach and plain leave them as they are; base back to the own mix of the search; raw flags without --roll / --keep',
			rl.every((f) => !f || f.every((x) => !/^--(roll|keep)=/.test(x))) && parsed &&
			heavy(mixOf(rl[0])) === '120' && heavy(mixOf(rl[1])) === '255' && heavy(mixOf(rl[2])) === '240' && cls(mixOf(rl[1])).some((c) => c[0] === '255' && c[1] === '0.985') &&
			cls(mixOf(rl[0])).map((c) => c[0]).join() === '40,120,240' && rl[3] === null && rl[4] === null && rl[5].length === 0 &&
			ED.rollsOf(raw[0]).join(' ') === '--pA=0.2' && ED.rollsOf(raw[1]).join(' ') === '--rollMix=40:0.85:1,240:0.97:5' && ED.rollsOf(raw[2]) === null &&
			nx[0].join(' ') === rl[0].join(' ') && nx[1] === null && nx[2] === null && nx[3] === null && nx[4] === null && nx[5].length === 0,
			`${rl.map((f, j) => `${rotD[j].name}: ${f ? f.join(' ') || '(own)' : '-'}`).join('; ')}; raw ${raw.map((c) => JSON.stringify(ED.rollsOf(c))).join(' ')}; next ${nx.map((x) => JSON.stringify(x)).join(' ')}`);
		// (INNOLOOP round 2 merge: the weighted restarts keep their fixed shares with the yield mix on: --mixBandit=0 after
		// EEAT_GX, as the gorolls args put q.rollFlags after gxExtra; base's restart (the search's own mix) keeps the flag)
		const args = (f) => GXP.parseArgs(['x.eelvl', '--gpu=1', ...ED.GX_DEFAULTS, '--mixBandit=1', ...f]);
		const on = [0, 1, 2].map((j) => args(rl[j])), own = args(rl[5]), off = GXP.parseArgs(['x.eelvl', '--gpu=1', ...rl[0]]);
		check('the rotation\'s weighted restarts run fixed shares with the yield mix on (--mixBandit=0 last), base\'s restart keeps it; flag off the same as before',
			[0, 1, 2].every((j) => rl[j][rl[j].length - 1] === '--mixBandit=0' && on[j].mixBandit === 0 && on[j].rollMix === mixOf(rl[j])) &&
			own.mixBandit === 1 && own.rollMix === GXP.MIX_BANDIT && off.mixBandit === 0 && off.rollMix === mixOf(rl[0]),
			`${on.map((a) => `${a.mixBandit} ${a.rollMix}`).join('; ')}; base ${own.mixBandit} ${own.rollMix}; off ${off.mixBandit}`);
	}
	// (the merge's soundness review, 2026-09-29: goexplore.js --deaths=1 with the death-free reach file keeps dying balls and
	// prunes by a -1 that only a death reaches; the reach file is the proof field of the search's own deaths setting)
	// (and --dback=0: goexplore.js drops the deaths thrown back past their parent's cost, kept demoted by default: the
	// rotation's soundness review, non-blocking (4))
	const rotP = ED.escRotOf('--deaths=1+--reach=x.bin+--bin=y.bin+--useful=0, --deaths=1, deaths, --dback=0, --dback=0+--pA=0.2');
	check('no configuration prunes without a proof: no "deaths" configuration, and --deaths / --reach / --bin / --dback left out of raw flags',
		!Object.prototype.hasOwnProperty.call(ED.ESC_CONFIGS, 'deaths') && Object.values(ED.ESC_CONFIGS).every((c) => !c.flags.some((x) => /^--(deaths|reach|bin|dback)=/.test(x))) &&
		rotP.map((c) => c.flags.join(' ')).join('|') === '--useful=0|--pA=0.2', JSON.stringify(rotP.map((c) => [c.name, c.flags])));
	// (the GPU random runs started again by the rotation: their own measures start over, as an escape's (the rotation's
	// soundness review, non-blocking (1)); the route, the configuration and the restart count stay)
	{
		const Vr = { key: 'gorolls', rolls: true, label: 'random runs (GPU)', error: 'x', state: 'running', dry: 4, best: 12.5, bestAt: 123, bestTry: { inputs: '44', ticks: 2, dist: 12.5 }, rooms: 57, batches: 412,
			layer: 9, states: 99, ticksPerSec: 5, found: null, rollFlags: ['--rollMix=40:0.85:1'], rollCfg: 'lr3', rollRuns: 2 };
		const Rf = ED.rollsFresh(Vr);
		check('the GPU random runs started again by the rotation: their slices\' wait (dry), nearest (best, its time and try), rooms, completed batches and error start over; the configuration, its flags and the restart count stay',
			Rf === Vr && Vr.dry === 0 && Vr.best === undefined && Vr.bestAt === 0 && Vr.bestTry === null && Vr.rooms === 0 && Vr.batches === 0 && Vr.error === null && Vr.state === 'starting' &&
			Vr.layer === 0 && Vr.states === 0 && Vr.rollCfg === 'lr3' && Vr.rollRuns === 2 && Vr.rollFlags.join() === '--rollMix=40:0.85:1' && Vr.detail === 'again with lr3', JSON.stringify(Vr));
	}
	const rotX = ED.escRotOf('plain, --pA=0.2+--sample=4+--prefix=x+--workers=64, nosuch, longruns');
	check('a rotation from a string: names and raw flags joined by "+" (flags that would change the escape\'s own start, share or files left out), unknown names left out',
		rotX.map((c) => c.name).join('|') === 'plain|--pA=0.2+--sample=4+--prefix=x+--workers=64|longruns' && rotX[1].flags.join(' ') === '--pA=0.2 --sample=4' &&
		rotX[0].flags.join(' ') === '--useful=0 --dom=0', JSON.stringify(rotX.map((c) => c.flags)));
	check('nothing usable: the search\'s own configuration alone; the kinds of start: known names, else the default rotation',
		ED.escRotOf('zzz,--prefix=1').map((c) => c.name).join() === 'base' && ED.escFromOf('near, bogus').join() === 'near' && ED.escFromOf('').join() === ED.ESC_FROM.join() &&
		ED.ESC_FROM.join() === 'arrival,frontier,near');
	const turns = [1, 4, 5, 8, 9, 13, 50].map((k) => ED.escTurnOf(k, 4, 120, 600, 600).stall);
	check('the turns: ESC_TURN_S (120 s) in the rotation\'s first round, doubled every round, at most the escape\'s own clocks (600 s); a test\'s clocks cap it',
		turns.join() === '120,120,240,240,480,600,600' && ED.escTurnOf(3, 4, 120, 1, 3).min === 1 && ED.escTurnOf(3, 4, 120, 1, 3).stall === 3 && ED.ESC_FIRST_S === 60 && ED.ESC_FIRST_S <= ED.ESC_WAIT_S,
		turns.join(', '));
	const args = ED.STRATEGIES.escape.args({ eelvl: 'l.eelvl', steerCpu: 's.bin', steer: 's.bin', steerDist: true }, { workers: 8, seed: 1, cpuDepth: 100000, deaths: false, bursts: false },
		{ seconds: 60, workers: 4, seed: 1001, prefixFile: 'p.eetas', escFlags: ['--deaths=1'] });
	check('the escape\'s command line: the configuration\'s flags after the search\'s own (goexplore.js: the last one wins)',
		args.indexOf('--deaths=0') >= 0 && args.lastIndexOf('--deaths=1') > args.indexOf('--deaths=0') && args[args.length - 1] === '--deaths=1' && args.includes('--prefix=p.eetas'), args.join(' '));
	section('the stall escape: a fresh one search (the real src/goexplore.js --prefix) from a stalled search\'s nearest attempt (a stand-in CPU search; no GPU)');
	// (scenarios (1)-(5) pin main's start rule, test.progStart false: their rooms' coins would make the first start a
	// progress start; (6) is the progress-first starts, on and off)
	// a 160 x 45 level (coarse cells: the CPU search's big-level path): a floor at row 20 over solid ground, the spawn at the
	// left, the trophy at the right; a pit (1 tile wide, 12 deep) at x 30: a ball that falls in never gets out (the reach
	// field rules the trophy out from its bottom); a coin at x 40 and a coin door (1 coin) across the corridor at x 100: the
	// coin's room is a new room that opens territory (the escape's source event, into the stalled search's archive)
	const W = 160, H = 45, cells = room(W, H);
	for (let x = 1; x < W - 1; x++) for (let y = 21; y < H - 1; y++) if (!(x === 30 && y <= 32)) cells.push([x, y, 9]);
	cells.push([2, 20, 255], [W - 4, 20, 121], [40, 20, 100]);
	for (let y = 1; y <= 20; y++) cells.push([100, y, 43, 1]);
	const buf = ED.eelvlOf({ name: 'escape pit', width: W, height: H, cells });
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
	const str = (ms) => C.eetasBytes(ms).toString('latin1');
	const run = (parts) => { const raw = []; for (const [m, n] of parts) for (let k = 0; k < n; k++) raw.push(m); return Uint8Array.from(raw); };
	// (where a run ends: its tile; replayed)
	const endTile = (ms) => { const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput(); for (const m of ms) { E.applyMask(inp, m); sim.tick(inp); } return [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4]; };
	const fake = path.join(HOME, 'fake-cpu-stall.js');
	fs.writeFileSync(fake, FAKE_CPU_STALL);
	const scenario = async (name, attempt, dist, seconds, source) => {
		const sc = path.join(HOME, `esc_${name}.json`), stdinLog = path.join(HOME, `esc_${name}_stdin.log`);
		fs.writeFileSync(sc, JSON.stringify({ attempt: str(attempt), dist, stdinLog, ...(source ? { source: str(source) } : {}) }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds, width: 1024, workers: 4 }, { available: false }, { cpu: [process.execPath, fake, sc], escape: true, escWait: 2, escStall: 3, escMin: 1, escRot: ESC_OLD.rot, escFrom: ESC_OLD.from, progStart: false });
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && !st.result && Date.now() - t0 < seconds * 1000 + 5000) { await new Promise((z) => setTimeout(z, 100)); st = ED.state(); }
		// (after the route: the escape's end and the one search's workers back)
		const t1 = Date.now();
		while (st.running && st.strategies.some((q) => q.key === 'escape' && q.live) && Date.now() - t1 < 10000) { await new Promise((z) => setTimeout(z, 100)); st = ED.state(); }
		await new Promise((z) => setTimeout(z, 500));
		st = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		const lines = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8').split('\n').filter(Boolean) : [];
		return { st, lines, sec: (t1 - t0) / 1000 };
	};
	// (1) the stand-in stalls with its nearest attempt on the floor 5 tiles short of the pit (it never gets further):
	// the escape starts after the stall clock (2 s here) from that attempt ESC_BACK[0] (60) ticks back, on half of the 4
	// workers (the stalled search parks 2: "workers 2"), finds the route (replayed), and the stalled search gets its
	// workers back ("workers 0") and the escape's attempts as seeds (CPU only: no one search)
	const a1 = run([[0, 60], [4, 100]]);
	const [x1] = endTile(a1);
	const r1 = await scenario('near', a1, 31, 60);
	const E1 = r1.st.strategies.find((q) => q.key === 'escape');
	const res1 = r1.st.result;
	const rv1 = res1 ? C.evaluate(L, Uint8Array.from(res1.inputs, (c) => (c.charCodeAt(0) - 48) & 31)) : null;
	check(`a stall escaped by a fresh search from the nearest attempt (${a1.length} ticks, ending at x ${x1}, before the pit): the escape's route over the pit, replayed`,
		!!res1 && !!E1 && res1.strategy === E1.label && !!rv1 && rv1.runTicks === res1.runTicks && res1.inputs.startsWith(str(a1.subarray(0, a1.length - 60))),
		res1 ? `${res1.time} (${res1.strategy}) after ${res1.foundAfter} s` : `no route (${r1.st.stage}); ${(r1.st.log || []).slice(-4).join(' | ')}`);
	const w1 = r1.lines.filter((l) => /^workers \d+$/.test(l));
	check('the escape on half of the CPU search\'s 4 workers: the stalled search parks 2 while it runs ("workers 2"), gets them back after ("workers 0")',
		w1.length >= 2 && w1[0] === 'workers 2' && w1[w1.length - 1] === 'workers 0', w1.join(', ') || 'no workers line');
	const seeds1 = r1.lines.filter((l) => l.startsWith('seed '));
	check('the escape\'s attempts into the stalled search\'s archive (CPU only: "seed" lines, whole runs from the level\'s start through its prefix)',
		seeds1.length > 0 && seeds1.every((l) => l.slice(5).startsWith(str(a1.subarray(0, a1.length - 60)))), `${seeds1.length} seed line(s)`);
	check('the escape\'s notes and state: the escape 1 after the stall, from the nearest attempt; its process gone after the route',
		!!r1.st.escape && r1.st.escape.runs === 1 && (r1.st.log || []).some((l) => /escape: a fresh one search 1: no attempt nearer/.test(l)) && !!E1 && !E1.live,
		`${JSON.stringify(r1.st.escape)}; ${E1 ? E1.state : '-'}`);
	// (2) the rotation: the stand-in's nearest attempt ends in the pit (it idles 900 ticks first): the first escape (60
	// ticks back: in the pit) finds the trophy ruled out and ends; after the stall clock the next one starts from the nearest
	// attempt 600 ticks back (still idling by the spawn) and finds the route over the pit
	const a2 = run([[0, 900], [4, 160], [0, 140]]);
	const [x2, y2] = endTile(a2);
	const r2 = await scenario('pit', a2, 5, 90);
	const E2 = r2.st.strategies.find((q) => q.key === 'escape');
	const res2 = r2.st.result;
	const rv2 = res2 ? C.evaluate(L, Uint8Array.from(res2.inputs, (c) => (c.charCodeAt(0) - 48) & 31)) : null;
	check(`the rotation: the nearest attempt a trap (in the pit at (${x2}, ${y2})): the first escape ends there, the next from 600 ticks back finds the route (replayed)`,
		x2 === 30 && y2 > 25 && !!res2 && !!E2 && res2.strategy === E2.label && !!rv2 && rv2.runTicks === res2.runTicks && !!r2.st.escape && r2.st.escape.runs === 2 &&
		res2.inputs.startsWith(str(a2.subarray(0, a2.length - 600))) && !res2.inputs.startsWith(str(a2.subarray(0, a2.length - 60))),
		res2 ? `${res2.time} after ${res2.foundAfter} s, ${r2.st.escape.runs} escapes; ${(r2.st.log || []).filter((l) => /escape/.test(l)).slice(-3).join(' | ')}` : `no route (${r2.st.stage}); ${(r2.st.log || []).slice(-4).join(' | ')}`);
	// (3) the frontier: the nearest attempt by the search's measure a short one by the spawn (110 ticks idle), a room's
	// attempt far longer (it runs right to x 24): the escape starts from the room's attempt, not from near the start
	const a4 = run([[0, 110]]), s4 = run([[0, 60], [4, 95]]);
	const r4 = await scenario('front', a4, 5, 60, s4);
	const res4 = r4.st.result;
	check('the frontier: no escape from a short nearest attempt by the spawn (under half the longest attempt): it starts from the room\'s long attempt 60 ticks back, and routes',
		!!res4 && res4.inputs.startsWith(str(s4.subarray(0, s4.length - 60))) && (r4.st.log || []).some((l) => /from tick 95 of room "coins=1"'s nearest attempt/.test(l)),
		res4 ? `${res4.time}; ${(r4.st.log || []).filter((l) => /escape/.test(l)).slice(0, 1).join(' | ')}` : `no route (${r4.st.stage}); ${(r4.st.log || []).slice(-3).join(' | ')}`);
	// (3b) the retarget (the soundness review's repro, 2026-09-28): the frontier's escape from the room's attempt (its start
	// 25 tiles out, the nearest attempt a short one by the spawn at 5 tiles all along) is not sent away as "left behind"
	// while nothing gets nearer (before: after the retarget clock, 1 s here, every such escape went); once the search gets
	// clearly nearer after its start (a 1-tile attempt at 12 s) the next one starts from there. The escape a stand-in that
	// never gets anywhere, its own stall clock 60 s
	const fakeEsc = path.join(HOME, 'fake-esc-idle.js');
	fs.writeFileSync(fakeEsc, FAKE_ESC_IDLE);
	const s5 = run([[0, 60], [4, 95], [0, 40]]);
	const sc5 = path.join(HOME, 'esc_retarget.json');
	fs.writeFileSync(sc5, JSON.stringify({ attempt: str(a4), dist: 5, stdinLog: path.join(HOME, 'esc_retarget_stdin.log'), source: str(s4), later: { at: 12000, attempt: str(s5), dist: 1 } }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024, workers: 4 }, { available: false },
		{ cpu: [process.execPath, fake, sc5], escapeCmd: [process.execPath, fakeEsc], escape: true, escWait: 2, escStall: 60, escMin: 60, escRetarget: 1, escRot: ESC_OLD.rot, escFrom: ESC_OLD.from, progStart: false });
	const t5 = Date.now();
	let st5 = ED.state(), away5 = null;
	while (st5.running && Date.now() - t5 < 35000 && !(st5.escape && st5.escape.runs >= 2)) {
		await new Promise((z) => setTimeout(z, 100));
		st5 = ED.state();
		if (away5 === null && (st5.log || []).some((l) => /clearly nearer elsewhere/.test(l))) away5 = (Date.now() - t5) / 1000;
	}
	const log5 = (st5.log || []).filter((l) => /escape/.test(l));
	ED.stop();
	while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
	check('the retarget: an escape from a room\'s attempt keeps going while the nearest attempt (nearer than its start all along) stays; the search clearly nearer after its start (12 s): the next one from there',
		away5 !== null && away5 >= 12 && !!st5.escape && st5.escape.runs === 2 && log5.some((l) => /escape: a fresh one search 1: .*from tick 95 of room "coins=1"'s nearest attempt/.test(l)) &&
		log5.some((l) => /escape: a fresh one search 2: .*from tick 135 of the nearest attempt/.test(l)),
		`sent away after ${away5 === null ? '-' : away5.toFixed(1)} s, ${st5.escape ? st5.escape.runs : 0} escapes; ${log5.slice(-3).join(' | ')}`);
	// (5) THE STALL ROTATION (stand-ins: the stalled search above with two rooms' first arrivals as its sources, escapes
	// that never get anywhere and log their command line): escape k runs with the rotation's configuration k (the body's
	// escRot; "reach" skipped: no steer field, the search's own ordering; "deaths" taken: a spike far above the corridor
	// kills and there is no checkpoint, so deaths are no moves of the search) and a start of the rotation's kind k (the
	// rooms' first arrivals, the least explored room, the nearest attempt); the first escape after escFirst (1 s) though
	// escWait is 1000 s; each one's own turn 1 s and the next one at once
	const bufK = ED.eelvlOf({ name: 'escape pit spike', width: W, height: H, cells: cells.concat([[80, 5, 361]]) });
	const fakeArgv = path.join(HOME, 'fake-esc-argv.js'), argvLog = path.join(HOME, 'esc_rot_argv.log');
	fs.writeFileSync(fakeArgv, FAKE_ESC_ARGV);
	try { fs.unlinkSync(argvLog); } catch (e) { /* none */ }
	const aR = run([[0, 200], [4, 100]]), s1R = run([[0, 180], [4, 100]]), s2R = run([[0, 160], [4, 100]]);
	const sc6 = path.join(HOME, 'esc_rot.json');
	fs.writeFileSync(sc6, JSON.stringify({ attempt: str(aR), dist: 30, stdinLog: path.join(HOME, 'esc_rot_stdin.log'),
		sources: [{ room: 777, desc: 'coins=1', gain: 5, dist: 50, inputs: str(s1R), at: 300 }, { room: 778, desc: 'coins=2', gain: 5, dist: 40, inputs: str(s2R), at: 400 }] }));
	const rot6 = ['blind', 'reach', '--pA=0.25+--sample=4+--seed=9', 'deaths', '--deaths=1+--useful=0+--reach=x.bin', 'base'];
	ED.start({ eelvlB64: bufK.toString('base64'), seconds: 120, width: 1024, workers: 4, steer: false, escRot: rot6 }, { available: false },
		{ cpu: [process.execPath, fake, sc6], escapeCmd: [process.execPath, fakeArgv, argvLog], escape: true, escFirst: 1, escWait: 1000, escStall: 1, escMin: 1, escTurn: 1, escRetarget: 1000, progStart: false });
	const t6 = Date.now();
	let st6 = ED.state();
	while (st6.running && Date.now() - t6 < 70000 && !(st6.escape && st6.escape.runs >= 6)) { await new Promise((z) => setTimeout(z, 200)); st6 = ED.state(); }
	ED.stop();
	while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
	const hist6 = (st6.escape && st6.escape.hist) || [];
	const argv6 = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	const extra6 = argv6.map((a) => a.slice(a.findIndex((x) => String(x).startsWith('--prefix=')) + 1).filter((x) => x !== '--nice=10').join(' '));
	const log6 = (st6.log || []).filter((l) => /escape/.test(l));
	check('the rotation\'s configurations in order, each passed to its escape only (reach skipped without a steer field; a raw flag list without --seed; no "deaths" configuration, a raw list without --deaths / --reach), then round again',
		hist6.length >= 5 && hist6.slice(0, 5).map((h) => h.cfg).join('|') === 'blind|--pA=0.25+--sample=4+--seed=9|--deaths=1+--useful=0+--reach=x.bin|base|blind' &&
		extra6.slice(0, 5).join('|') === '--pA=0 --burst=16|--pA=0.25 --sample=4|--useful=0||--pA=0 --burst=16' && argv6.length >= 3 && argv6[2].includes('--deaths=0') &&
		argv6.every((a) => !a.includes('--deaths=1') && !a.includes('--reach=x.bin')),
		`${hist6.map((h) => h.cfg).join(', ')}; ${extra6.map((x) => `[${x}]`).join(' ')}`);
	const want6 = [['arrival', 'where room "coins=2" was entered', s2R.length], ['frontier', 'the least explored room "coins=1"\'s nearest attempt', s1R.length - 60],
		['near', 'the nearest attempt', aR.length - 60], ['arrival', 'where room "coins=1" was entered', s1R.length], ['frontier', 'the least explored room "coins=2"\'s nearest attempt', s2R.length - 60]];
	check('diverse starts in rotation: a room\'s first arrival (the nearer room first), the least explored room (the one no escape started from), the nearest attempt, then round again; each start once',
		hist6.length >= 5 && want6.every(([k, w, t], j) => hist6[j].kind === k && hist6[j].from === w && hist6[j].ticks === t),
		hist6.map((h) => `${h.n}: ${h.kind} ${h.from} @${h.ticks}`).join('; '));
	const gaps6 = hist6.slice(1).map((h, j) => h.after - hist6[j].after);
	check('the first escape after escFirst (not escWait\'s 1000 s); each escape\'s turn 1 s, the next one at once (within a stall check of 5 s)',
		hist6.length >= 5 && hist6[0].after < 20 && hist6.every((h) => h.turn === 1) && gaps6.length >= 4 && gaps6.every((g) => g < 8) &&
		log6.some((l) => /escape: a fresh one search 1: no attempt nearer by .* for 1 s: from tick 260 of where room "coins=2" was entered, distance-blind novelty \(--pA=0 --burst=16\)/.test(l)),
		`first after ${hist6.length ? hist6[0].after : '-'} s, gaps ${gaps6.map((g) => g.toFixed(1)).join(', ')} s; ${log6.slice(0, 1).join(' | ')}`);
	// (6) THE PROGRESS-FIRST STARTS (cw-progress-starts, 2026-09-29; `progStart`, OPT-IN: EEAT_PROGSTART=1 on): the helpers
	// alone, then the stalled search above with three rooms: 'coins=1 purple=[1]' entered at tick 280 (the most progress),
	// 'coins=1' at 260, and a 'coins=0' room whose lowest-cost attempt is 1,200 ticks long (so the frontier rule, half the
	// longest attempt held, drops every start under 600 ticks); the nearest attempt's room holds no coin
	{
		const P = ED.progOfDesc('coins=1 purple=[1,3] orange=[2] crown silvercrown key:red team=1 deaths=5 protection timedoors:open', null);
		check('progOfDesc: coins, then the read switches on (purple + orange ids) + a crown + a silver crown; keys, effects, team, deaths and time doors count nothing',
			P.c === 1 && P.s === 5 && ED.progOfDesc('deaths=99 key:red team=2 fly', null).c === 0 && ED.progOfDesc('deaths=99 key:red team=2 fly', null).s === 0 &&
			ED.progOfDesc('(start)', null).s === 0 && ED.progGt({ c: 1, s: 0 }, { c: 0, s: 9 }) && ED.progGt({ c: 1, s: 2 }, { c: 1, s: 1 }) && !ED.progGt({ c: 1, s: 1 }, { c: 1, s: 1 }),
			JSON.stringify(P));
		const list = [{ desc: 'coins=1 purple=[1]', early: { ticks: 3000 }, at: 5 }, { desc: 'coins=1 purple=[1]', early: { ticks: 2500 }, at: 9 }, { desc: 'coins=1', early: { ticks: 100 }, at: 1 },
			{ desc: 'coins=0 purple=[1,2]', early: { ticks: 50 }, at: 2 }, { desc: 'deaths=99 key:red', early: { ticks: 10 }, at: 3 }, { desc: 'coins=2', early: null, at: 4 }];
		const pc = ED.progressCands(list, { c: 0, s: 0 }, null, null);
		const same = ED.progressCands(list, { c: 1, s: 1 }, null, null), used = ED.progressCands(list, { c: 0, s: 0 }, { c: 1, s: 1 }, null);
		check('the progress starts: only the rooms of the most progress above the nearest attempt\'s room (coins first, then switches; a room without a first arrival none), the earliest arrival first; the same progress as the nearest attempt\'s room, or no more than a progress start before: none',
			!!pc.top && pc.top.c === 1 && pc.top.s === 1 && pc.cand.map((s) => s.early.ticks).join(',') === '2500,3000' && same.cand.length === 0 && used.cand.length === 0,
			`${JSON.stringify(pc.top)} ${pc.cand.map((s) => s.early.ticks).join(',')}; same ${same.cand.length}, used ${used.cand.length}`);
		const bs = [{ coins: 1, sw: 0, n: 0 }, { coins: 1, sw: 2, n: 1 }, { coins: 2, sw: 0, n: 2 }, { coins: 0, sw: 5, n: 3 }, { coins: 1, sw: 2, n: 4 }].sort(ED.breakCmp);
		const bm = [{ coins: 1, sw: 0, n: 0 }, { coins: 1, sw: 0, n: 1 }, { coins: 2, sw: 0, n: 2 }].sort(ED.breakCmp);
		check('the wall breaker\'s progress order: coins first, then the switches held, then the order before (a coin level without read switches: main\'s order)',
			bs.map((x) => x.n).join(',') === '2,1,4,0,3' && bm.map((x) => x.n).join(',') === '2,0,1', `${bs.map((x) => x.n).join(',')} / ${bm.map((x) => x.n).join(',')}`);
		const srcs = [{ room: 1, desc: 'coins=1 purple=[1]', runs: 3, gain: 0, at: 1 }, { room: 2, desc: 'deaths=5', runs: 0, gain: 4, at: 2 }, { room: 3, desc: 'deaths=6', runs: 1, gain: 0, at: 3 },
			{ room: 4, desc: 'coins=1', runs: 0, gain: 2, at: 4 }];
		const v1 = ED.evictVictim(srcs, null, true), v0 = ED.evictVictim(srcs, null, false);
		const flat = [{ room: 5, desc: 'deaths=1', runs: 0, gain: 0, at: 1 }, { room: 6, desc: 'deaths=2', runs: 1, gain: 0, at: 2 }];
		check('the sources\' eviction: never the source of the most progress (a relayed-from, gainless, oldest room of coins=1 purple=[1] stays, the next goes); off, or every source equal: main\'s rank',
			v1.room === 3 && v0.room === 1 && ED.evictVictim(flat, null, true).room === 6, `on ${v1.room}, off ${v0.room}, equal ${ED.evictVictim(flat, null, true).room}`);
	}
	const fakeArgvP = path.join(HOME, 'fake-esc-argv-p.js'), argvLogP = path.join(HOME, 'esc_prog_argv.log');
	fs.writeFileSync(fakeArgvP, FAKE_ESC_ARGV);
	const sP = run([[0, 180], [4, 100]]), s2P = run([[0, 160], [4, 100]]), sLong = run([[0, 1100], [4, 100]]);
	// (on: the progress start, then main's first (the frontier room's attempt), then nothing new; off: main's first, then
	// nothing new: the stall clock again)
	const progRun = async (tag, on, want) => {
		const sc = path.join(HOME, `esc_prog_${tag}.json`);
		fs.writeFileSync(sc, JSON.stringify({ attempt: str(aR), dist: 30, stdinLog: path.join(HOME, `esc_prog_${tag}_stdin.log`),
			sources: [{ room: 777, desc: 'coins=1 purple=[1]', gain: 5, dist: 50, inputs: str(sP), at: 300 }, { room: 778, desc: 'coins=1', gain: 5, dist: 40, inputs: str(s2P), at: 350 },
				{ room: 779, kind: 'best', desc: 'coins=0', gain: 5, dist: 60, inputs: str(sLong), at: 400 }] }));
		if (on) process.env.EEAT_PROGSTART = '1';
		ED.start({ eelvlB64: bufK.toString('base64'), seconds: 120, width: 1024, workers: 4, steer: false, escRot: ['base'], escFrom: ['arrival', 'frontier', 'near'] }, { available: false },
			{ cpu: [process.execPath, fake, sc], escapeCmd: [process.execPath, fakeArgvP, argvLogP], escape: true, escFirst: 1, escWait: 1000, escStall: 1, escMin: 1, escTurn: 1, escRetarget: 1000 });
		if (on) delete process.env.EEAT_PROGSTART;
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < 30000 && !(st.escape && st.escape.runs >= want)) { await new Promise((z) => setTimeout(z, 200)); st = ED.state(); }
		// (a few more stall checks: no further escape)
		const t1 = Date.now();
		while (st.running && Date.now() - t1 < 11000) { await new Promise((z) => setTimeout(z, 200)); st = ED.state(); }
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		return { hist: (st.escape && st.escape.hist) || [], log: (st.log || []).filter((l) => /escape/.test(l)) };
	};
	const pOn = await progRun('on', true, 2), pOff = await progRun('off', false, 1);
	const fmtH = (h) => h.map((x) => `${x.n}: ${x.kind} ${x.from} @${x.ticks}`).join('; ');
	check('progress first: a room holding a new most of progress (coins=1 purple=[1]) over the nearest attempt\'s room: the first escape starts where it was entered (280 ticks, though the longest attempt held is 1,200: exempt from the frontier rule), said so in the log',
		pOn.hist.length >= 1 && pOn.hist[0].kind === 'progress' && pOn.hist[0].ticks === sP.length && /^where room "coins=1 purple=\[1\]" was entered \(progress 1 coins \/ 1 switches over the nearest attempt's room's 0 \/ 0\)$/.test(pOn.hist[0].from) &&
		pOn.log.some((l) => /escape: a fresh one search 1: .*from tick 280 of where room "coins=1 purple=\[1\]" was entered \(progress/.test(l)), fmtH(pOn.hist));
	check('after a progress start the rotation is main\'s: the next escape = main\'s first (its kind, start and ticks), no second progress start (coins=1 is no new most), each start once',
		pOn.hist.length === 2 && pOff.hist.length >= 1 && pOn.hist[1].kind === pOff.hist[0].kind && pOn.hist[1].from === pOff.hist[0].from && pOn.hist[1].ticks === pOff.hist[0].ticks &&
		pOn.hist.slice(1).every((h) => h.kind !== 'progress') && new Set(pOn.hist.map((h) => `${h.from}@${h.ticks}`)).size === pOn.hist.length, `on ${fmtH(pOn.hist)} | off ${fmtH(pOff.hist)}`);
	check('the default (off, no EEAT_PROGSTART): main\'s picks (no progress start; the frontier rule drops the short arrivals: the 1,200-tick room\'s attempt first)',
		pOff.hist.length === 1 && pOff.hist.every((h) => h.kind !== 'progress') && pOff.hist[0].kind === 'frontier' && pOff.hist[0].ticks === sLong.length - 60 &&
		pOff.hist.every((h) => h.ticks >= sLong.length / 2), fmtH(pOff.hist));
	// (4) no stall, no escape: the escape off (b.escape false) is the search as before (no escape strategy at all)
	const sc3 = path.join(HOME, 'esc_off.json');
	fs.writeFileSync(sc3, JSON.stringify({ attempt: str(a1), dist: 8, stdinLog: path.join(HOME, 'esc_off_stdin.log') }));
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 30, width: 1024, workers: 4, escape: false }, { available: false }, { cpu: [process.execPath, fake, sc3], escape: true, escWait: 1 });
	await new Promise((z) => setTimeout(z, 4000));
	const st3 = ED.state();
	ED.stop();
	while (ED.state().running) await new Promise((z) => setTimeout(z, 100));
	check('the escape off (escape: false): no escape strategy, no workers line', !st3.strategies.some((q) => q.key === 'escape') && !st3.escape &&
		!(fs.existsSync(path.join(HOME, 'esc_off_stdin.log')) && /workers/.test(fs.readFileSync(path.join(HOME, 'esc_off_stdin.log'), 'utf8'))), st3.strategies.map((q) => q.key).join(', '));
}
const USER50 = 'xZTZTsJAFIY/wA3FBcUNxRYo++4LeGG8MPEBjHdGS2KCkJio8c431/yVQqc1xMSI82XaOefMxXxnmpIYjp5JX1zb50/uq31559pX7os7AE41z97hA2PESD3e3rv2qN8fPAxdIPlViN941TgJFlhkiWVWSLLKGinW2WCTLdJss0OGXfbY54BDshxxTI4TLGzyFCjiUKJMhSo16jRo0qJNhy49+Lc5PZsindVfmW/LWPn7c1iTtensZ2d1JrgnG4qsmXEGy4ii9d9n5nDr3tf19yPmuchGPjKSk6zkJTO5yU5+MpSjLOUpU7nKVr4ylrOs5S1zucte/uqAeqAuBLEn5McUxhQnOAFKAcrfUvkBVYNaiHqIhkEzQitCO0InQjdCbw7A2/j+4zjes8j0x+fnGp8=';

// ---------------------------------------------------------------- broken level files (src/levelcheck.js)
/**
 * The level check in the editor (2026-09-28: a damaged Forgotten Helix copy, every gravity effect stored as down, cost a
 * night): effect blocks that can never do anything (noopEffects: gravity all down, the static effects off, removers with
 * nothing to remove, an effect reset with nothing to reset; and where they DO something: none); a copy against EEO's own
 * (a fake eeo-tas, test/review.js campaignFixture "Mini Helix": 3 cells, e.g. 3 gravity effects; a block and the world
 * gravity too); the editor's parse (md5, check), its checks (levelCheck; its own round trip of EEO's copy = the same
 * blocks), the verdicts that name the file (the walled-in problem, "No way up", a Find a route "not found": the file the
 * page sends as source, else the md5 of the bytes); the page's "Use EEO's copy" (useEeoCopy cut out of editor.html, run
 * against the server: EEO's copy through the import path), checkHtml, fileSource after an edit.
 */
async function levelCheckSection() {
	section('levelcheck: broken level files (EEO\'s own copy of a campaign level, effect blocks that do nothing, the md5 in "no route" verdicts)');
	const LC = require('../src/levelcheck.js');
	const R = require('./review.js');
	const md5 = (b) => require('crypto').createHash('md5').update(b).digest('hex');
	const lvl = (tiles, o = {}) => EL.readEelvl(ED.eelvlOf({ name: o.name || 'fx', width: 30, height: 8, gravity: o.gravity, cells: [...room(30, 8), [2, 6, 255], [28, 6, 121], ...tiles] }));
	const ids = (list) => list.map((x) => `${x.id}:${x.n}`).join(',');
	// ---- effect blocks that can never do anything
	let n = LC.noopEffects(lvl([[5, 6, 1517, 0]]));
	check('one gravity effect set to 0 = down: a no-op (its cell), without the damaged-copy hint', ids(n) === '1517:1' && /^The gravity effect \(1517\) is set to 0 = down \(at \(5, 6\)\): gravity starts down and nothing else in this level turns it, so it can never do anything\.$/.test(n[0].text), JSON.stringify(n));
	n = LC.noopEffects(lvl([[5, 6, 1517, 0], [6, 6, 1517, 0], [7, 6, 1517, 0]]));
	check('three gravity effects, all 0: no-ops, with the damaged-copy hint', ids(n) === '1517:3' && /A damaged copy of a level can lose their directions: check the file\.$/.test(n[0].text), JSON.stringify(n));
	n = LC.noopEffects(lvl([[5, 6, 1517, 0], [7, 6, 1517, 3]]));
	check('a gravity effect 0 next to one set to right: both do something (0 turns it back down): nothing said', n.length === 0, JSON.stringify(n));
	n = LC.noopEffects(lvl([[4, 6, 417, 0], [5, 6, 417, 0], [6, 6, 419, 0], [7, 6, 418, 0], [8, 6, 420, 0], [9, 6, 453, 0]]));
	check('jump, speed, fly, protection and low gravity effects set to 0 (what the ball starts with): no-ops, each with its cells', ids(n) === '417:2,419:1,418:1,420:1,453:1' &&
		/^All 2 jump effects \(417\) are set to 0 = normal jumps \(at \(4, 6\), \(5, 6\)\)/.test(n[0].text) && /^The low gravity effect \(453\) is set to 0 = off \(at \(9, 6\)\)/.test(n[4].text), JSON.stringify(n.map((x) => x.text)));
	n = LC.noopEffects(lvl([[4, 6, 417, 0], [5, 6, 417, 1], [6, 6, 420, 1], [7, 6, 420, 0]]));
	check('a jump effect 0 next to a high jump, protection off next to on: nothing said', n.length === 0, JSON.stringify(n));
	n = LC.noopEffects(lvl([[4, 6, 421, 0], [5, 6, 422, 0], [6, 6, 1584, 0]]));
	check('curse, zombie and poison effects set to 0 (they lift it) with nothing that gives it: no-ops', ids(n) === '421:1,422:1,1584:1' &&
		/^The curse effect \(421\) is set to 0, which lifts the curse effect \(at \(4, 6\)\), but nothing in this level gives it: it can never do anything\.$/.test(n[0].text), JSON.stringify(n.map((x) => x.text)));
	n = LC.noopEffects(lvl([[4, 6, 421, 0], [5, 6, 421, 3], [6, 6, 422, 0], [7, 6, 1573]]));
	check('a curse remover with a curse (3 s) in the level, a zombie remover with a zombie NPC: nothing said', n.length === 0, JSON.stringify(n));
	n = LC.noopEffects(lvl([[4, 6, 1618], [5, 6, 461, 1]]));
	const n2 = LC.noopEffects(lvl([[4, 6, 1618], [5, 6, 461, 2]])), n3 = LC.noopEffects(lvl([[4, 6, 1618], [5, 6, 1517, 1]]));
	check('an effect reset with nothing to reset (a multijump of 1 = the default): a no-op; with a double jump or a gravity effect to reset: nothing said', ids(n) === '1618:1' &&
		/^The effect reset \(1618\) \(at \(4, 6\)\) resets jump, speed, fly, protection, low gravity, multijump and gravity effects, but nothing in this level gives the ball one: it can never do anything\.$/.test(n[0].text) &&
		n2.length === 0 && n3.length === 0, JSON.stringify([n, n2, n3]));
	// ---- EEO's own copy (a fake eeo-tas with campaigns.zip, found through $EEO_TAS)
	const F = R.campaignFixture();
	const envBefore = process.env.EEO_TAS;
	process.env.EEO_TAS = R.fakeEeoTas(path.join(HOME, 'fake-eeo'), F.zip);
	const SV = require('../src/server.js');
	let listening = false;
	try {
		const pd = EL.readEelvl(F.damaged);
		let m = LC.campaignMatch(pd);
		check('the damaged copy against EEO\'s: 3 cells differ, all gravity effects (down here, up / right / left there)', m && !m.same && m.cells === 3 && ids(m.kinds) === '1517:3' &&
			m.examples.map((e) => `${e.x},${e.y} ${e.here} / ${e.eeo}`).join('; ') === '6,9 gravity effect down / gravity effect up; 10,9 gravity effect down / gravity effect right; 12,9 gravity effect down / gravity effect left',
			JSON.stringify(m && m.examples));
		// a block gone and another world gravity: counted by EEO's block; the world gravity said
		const pw = EL.readEelvl(EL.writeEelvl({ width: F.W, height: F.H, name: 'Mini Helix', gravity: 0.5, records: EL.readEelvl(F.damaged).records.map((r) => ({ id: r.id, layer: r.layer,
			xs: [...r.xs].filter((x, k) => !(r.id === 9 && x === 7 && r.ys[k] === 5)), ys: [...r.ys].filter((y, k) => !(r.id === 9 && r.xs[k] === 7 && y === 5)), args: r.args })) }));
		m = LC.campaignMatch(pw);
		check('... a wall block gone and the world gravity 0.5: 4 cells (e.g. 3 gravity effects, 1 block 9) and the world gravity, said', m && m.cells === 4 && ids(m.kinds) === '1517:3,9:1' &&
			/in 4 cells \(e\.g\. 3 gravity effects, 1 .* block\) and the world gravity \(0\.5 here, 1 in EEO's copy\): the game plays its own copy\.$/.test(m.text), m && m.text);
		// the editor: parse, check, its own round trip
		const d = ED.levelOf(F.damaged);
		check('the editor\'s parse of the damaged copy: its md5 and level check (the campaign difference first, then the no-op gravity effects)', d.md5 === md5(F.damaged) && d.check &&
			d.check.warnings.length === 2 && /^This file differs from EEO's own copy of Mini Helix \(campaign Worst, level 2 of 3\) in 3 cells \(e\.g\. 3 gravity effects\)/.test(d.check.warnings[0]) &&
			d.check.campaign.entry === '41/1.eelvl' && /^All 3 gravity effects/.test(d.check.warnings[1]), JSON.stringify(d.check).slice(0, 300));
		const rt = ED.eelvlOf({ name: d.name, width: d.width, height: d.height, cells: d.cells, bg: d.bg });
		const rtCopy = (() => { const e = ED.levelOf(F.copy); return ED.eelvlOf({ name: e.name, width: e.width, height: e.height, cells: e.cells, bg: e.bg }); })();
		let c = ED.check(rt), c2 = ED.check(rtCopy), c3 = ED.check(rt, { name: 'Mini Helix.eelvl', md5: md5(F.damaged) }), c4 = ED.check(rt, { name: 'x', md5: 'not an md5' });
		check('the editor\'s checks on its own copy of the level (what the page sends): the damaged one differs (3 cells), EEO\'s is the same blocks; the file: the source the page sends ' +
			'(else the md5 of these bytes)', c.levelCheck.campaign.same === false && c.levelCheck.campaign.cells === 3 && c.levelCheck.noops.length === 1 && c2.levelCheck.campaign.same === true &&
			c2.levelCheck.warnings.length === 0 && c.file === `level file md5 ${md5(rt)}` && c3.file === `file Mini Helix.eelvl, md5 ${md5(F.damaged)}` && c4.file === `level file md5 ${md5(rt)}`,
			JSON.stringify([c.file, c3.file, c4.file, c2.levelCheck.notes]));
		// the verdicts name the file: the walled-in problem, "No way up"
		const box = [[11, 4, 9], [12, 4, 9], [13, 4, 9], [11, 5, 9], [13, 5, 9], [11, 6, 9], [12, 6, 9], [13, 6, 9]];
		const walled = ED.eelvlOf({ name: 'walled', width: 16, height: 10, cells: [...room(16, 10), [2, 8, 255], [12, 5, 121], ...box] });
		c = ED.check(walled, { name: 'walled.eelvl', md5: 'ab'.repeat(16) });
		check('a walled-in trophy: the problem names the file (the source the page sends, its md5)', c.problems.some((q) => q.code === 'unreachable' &&
			q.text.includes(`not even through portals; file walled.eelvl, md5 ${'ab'.repeat(16)}).`)), JSON.stringify(c.problems));
		const hi = room(20, 10);
		for (let x = 8; x <= 12; x++) hi.push([x, 3, 9]);
		hi.push([10, 2, 121], [3, 8, 255]);
		const hiBuf = ED.eelvlOf({ name: 'way too high', width: 20, height: 10, cells: hi });
		let t0 = Date.now();
		for (c = ED.check(hiBuf, { name: 'high.eelvl', md5: 'cd'.repeat(16) }); c.physicsPending && Date.now() - t0 < 30000; c = ED.check(hiBuf, { name: 'high.eelvl', md5: 'cd'.repeat(16) })) await new Promise((r) => setTimeout(r, 100));
		check('"No way up" (the physics check proves the trophy out of reach) names the file', c.notes.some((x) => /^No way up: /.test(x) && x.includes(`(file high.eelvl, md5 ${'cd'.repeat(16)})`)), c.notes.join(' | '));
		// a Find a route verdict on the damaged copy (CPU only, 3 s): "not found", the file and its md5, the campaign difference
		ED.start({ eelvlB64: F.damaged.toString('base64'), seconds: 3, workers: 1, source: { name: 'Mini Helix.eelvl', md5: md5(F.damaged) } }, { available: false, why: 'test: no GPU' });
		for (t0 = Date.now(); ED.state().running && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 100));
		const st = ED.state();
		check('Find a route on the damaged copy: no route, and the verdict names the file and its md5, then says it differs from EEO\'s own copy (e.g. 3 gravity effects) and why its gravity effects do nothing',
			st.stage === 'not found' && !st.result && st.file === `file Mini Helix.eelvl, md5 ${md5(F.damaged)}` && st.message.includes(`The level: file Mini Helix.eelvl, md5 ${md5(F.damaged)}. This file differs from EEO's own copy of Mini Helix`) &&
			/All 3 gravity effects \(1517\) are set to 0 = down/.test(st.message) && st.levelCheck && st.levelCheck.campaign.entry === '41/1.eelvl', `${st.stage}: ${st.message}`);
		// the page: "Use EEO's copy" (useEeoCopy and the import path cut out of editor.html, run against this server)
		await new Promise((res) => SV.server.listen(0, '127.0.0.1', res));
		listening = true;
		const port = SV.server.address().port;
		const pageFn = (name) => {
			const lines = PAGE.split('\n');
			const k = lines.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l));
			const e = k < 0 ? -1 : lines.indexOf('}', k);
			return e < 0 ? '' : lines.slice(k, e + 1).join('\n');
		};
		const pageConst = (name) => { const x = PAGE.match(new RegExp(`^const ${name} = .*$`, 'm')); return x ? x[0] : ''; };
		const fetchStub = async (p, o) => {
			const x = await request(port, (o && o.method) || 'GET', p, o && o.body !== undefined ? o.body : undefined);
			return { ok: x.status >= 200 && x.status < 300, status: x.status, statusText: String(x.status), json: async () => JSON.parse(x.buf.toString('utf8')),
				arrayBuffer: async () => x.buf.buffer.slice(x.buf.byteOffset, x.buf.byteOffset + x.buf.length) };
		};
		const els = {};
		const $ = (k) => (els[k] = els[k] || { innerHTML: '' });
		let sig = 's0', jobCleared = 0;
		const LV = { name: 'x', W: 1, H: 1 };
		const env = { $, fetch: fetchStub, LV, GUIDE: { strokes: [] }, ensureInfo: async () => {}, fit: () => {}, wholeLevel: (fn) => { fn(); sig = `s${Math.random()}`; }, jobClear: () => { jobCleared++; },
			currentSig: () => sig };
		const code = [pageConst('esc'), pageConst('postJson'), pageConst('levelFacts'), pageConst('FILE'), pageConst('fileSource'),
			...['api', 'b64', 'loadJson', 'lvMsg', 'openEelvl', 'checkHtml', 'useEeoCopy'].map(pageFn)].join('\n');
		let P = null;
		const pe = errOf(() => { P = new Function(...Object.keys(env), `'use strict';\n${code}\nreturn { useEeoCopy, checkHtml, FILE, fileSource };`)(...Object.values(env)); });
		if (P) await P.useEeoCopy('41/1.eelvl', 'Mini Helix');
		const g = LV.fg ? LV.fg[9 * F.W + 6] : 0, ga = LV.args ? LV.args.get(9 * F.W + 6) : null;
		const src0 = P ? P.fileSource() : null;
		sig = 'edited';
		const src1 = P ? P.fileSource() : null;
		check('the page\'s "Use EEO\'s copy": EEO\'s copy through the import path (the gravity effect at (6, 9) up), "Opened EEO\'s own copy of Mini Helix (41/1.eelvl in campaigns.zip)", ' +
			'the file its md5 (the source the searches get) until the level is edited', !pe && P && g === 1517 && ga && ga[0] === 2 && LV.name === 'Mini Helix' && jobCleared === 1 &&
			/^<div class="msg info">Opened <b>EEO's own copy of Mini Helix<\/b> \(41\/1\.eelvl in campaigns\.zip\): 16 × 12 tiles, \d+ blocks\. &#10003; The same blocks as EEO&#39;s own copy/.test($('lvMsg').innerHTML) &&
			P.FILE.md5 === md5(F.copy) && P.FILE.name === 'Mini Helix (EEO\'s copy).eelvl' && src0 && src0.md5 === md5(F.copy) && src1 === null,
			pe ? pe.message : JSON.stringify({ g, ga, name: LV.name, msg: $('lvMsg').innerHTML.slice(0, 200), file: P && P.FILE, src0, src1 }));
		const h = P ? P.checkHtml(ED.levelOf(F.damaged).check) : '';
		check('the page\'s checkHtml: the warnings, the "Use EEO\'s copy" button (data-eeo = the entry), both md5s; the checks list and "not found" have the button too; the solve, ' +
			'the AutoTASer and the checks send the source', /class="msg warn"/.test(h) && /<button class="small" data-eeo="41\/1\.eelvl" data-name="Mini Helix"[^>]*>Use EEO's copy<\/button>/.test(h) &&
			h.includes(`this file: md5 ${md5(F.damaged)} · EEO's copy: md5 ${md5(F.copy)}`) && (PAGE.match(/data-eeo="\$\{esc\(k\.entry\)\}"/g) || []).length === 3 &&
			/postJson\('\/api\/editor\/check', \{ level: levelJson\(\), source: fileSource\(\) \}\)/.test(PAGE) && /name: LV\.name, source: fileSource\(\) \};/.test(PAGE) &&
			/postJson\('\/api\/editor\/autotas', \{[^\n]*source: fileSource\(\) \}\)/.test(PAGE) && /closest\('\[data-eeo\]'\)/.test(PAGE), h.slice(0, 300));
	} finally {
		if (listening) await new Promise((res) => SV.server.close(res));
		if (envBefore === undefined) delete process.env.EEO_TAS; else process.env.EEO_TAS = envBefore;
	}
}

(async () => {
	roundtripSection();
	checksSection();
	await physicsCheckSection();
	if (want('app')) await appSection();
	// (after app: that section expects no route search before its own)
	if (want('explore')) await exploreSection();
	if (want('levelcheck')) await levelCheckSection();
	if (want('passes')) await passesSection();
	if (want('cpu')) await cpuSection();
	if (want('prove')) await proveSection();
	if (want('lane')) await laneSection();
	if (want('escape')) await escapeSection();
	if (GPU && want('gpu')) await gpuSection();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
