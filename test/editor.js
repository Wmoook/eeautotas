'use strict';
// test/editor.js - the level editor (src/editor.js, src/app/editor.html, src/eelvl.js writeEelvl):
//   roundtrip  every editor level -> .eelvl (writeEelvl) -> readEelvl / toSimLevel / prepareLevel: the same blocks, the
//              same numbers and portals (the AS3 Lookup), the same spawn, the header; the editor reads its own file back
//              identically and writes it again byte for byte; a crafted file (several records per cell, layer-1 numbers)
//              keeps the numbers EEO uses. Levels: every palette block with every rotation / number, random levels with
//              backgrounds, signs, labels, world portals and NPCs.
//   checks     no start, no trophy, walled in, only through portals, several spawns; bad input is refused clearly
//   app        the page's script parses; the HTTP API (in-process server, temp data folder): the page, blocks, eelvl,
//              parse, check, solve refusals, a job from a route (Watch / Optimize)
//   passes     the "every move" pass ladder (src/editor.js passCells / passSeconds / nextPass) and the whole search
//              driven by a stand-in for eegpu (a Node script playing scripted passes; no GPU): coarse first with pass 0's
//              speed cells, a share of the time, finer passes bounded by the route found (--depth), the "ran out of
//              situations" verdict only from pass 0 or finer with no layer cut, a beam's route bounding the exploration
//   gpu        (--gpu) short route searches on the GPU (at most 60 s each), verified in the JS engine
// usage: node test/editor.js [--gpu] [--seed=N]      Exit code 1 if any check fails. Writes nothing inside the repo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const argv = process.argv.slice(2);
const GPU = argv.includes('--gpu');
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
// (if any) and ends.
const FAKE = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a === undefined ? undefined : a.slice(k.length + 3); };
const passOf = (a) => Math.round(Math.log2(+a.find((x) => x.startsWith('--cqx=')).slice(6) / 0.5));
const prev = fs.existsSync(SC.log) ? fs.readFileSync(SC.log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(SC.log, JSON.stringify(args) + '\\n');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] !== 'explore') {
	if (SC.beam) say({ ev: 'result', kind: 'finish', inputs: SC.beam });
	say({ ev: 'done', layers: 3, end: SC.beam ? 'finish' : 'time' });
	return;
}
const p = passOf(args), k = prev.filter((a) => a[0] === 'explore' && passOf(a) === p).length;
const run = (SC.runs[p] || [])[k] || { end: 'exhausted', layers: 1, overflow: 0 };
const depth = +opt('depth');
const done = () => { const d = { ev: 'done', gpu: { name: 'fake' }, layers: run.layers, end: run.end }; if (run.overflow !== undefined) d.overflow = run.overflow; say(d); };
setTimeout(() => {
	say({ ev: 'layer', layer: run.layers, tick: run.layers, new: 5, kept: 5, states: 1000, hits: 0, sec: 0.1, ticks: 18000, ticksPerSec: 1e6, full: 0.01 });
	if (run.end !== 'finish') return void setTimeout(done, run.hold || 0);
	const ticks = run.idle + SC.R;
	if (ticks > depth) return void say({ ev: 'done', layers: depth, end: 'depth', overflow: 0 });
	say({ ev: 'hit', layer: ticks - 1, tick: ticks, inputs: '0'.repeat(run.idle) + '4'.repeat(SC.R + 10) });
	say({ ev: 'done', layers: ticks, end: 'finish', overflow: 0 });
}, run.wait || 0);
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
	const drive = async (runs, beam, during) => {
		const sc = path.join(HOME, `ladder-${++nSc}.json`), log = path.join(HOME, `ladder-${nSc}.log`);
		fs.writeFileSync(sc, JSON.stringify({ log, R, runs, beam: beam || null }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 60, width: 1024 }, { available: true }, { tool: [process.execPath, fake, sc] });
		const t0 = Date.now();
		let st = ED.state();
		while (st.running && Date.now() - t0 < 20000) { if (during) during(st); await new Promise((r) => setTimeout(r, 40)); st = ED.state(); }
		if (st.running) { ED.stop(); while (ED.state().running) await new Promise((r) => setTimeout(r, 40)); }
		const launches = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore')
			.map((a) => { const o = {}; for (const x of a) { const m = /^--(\w+)=(.*)$/.exec(x); if (m) o[m[1]] = m[2]; } return o; });
		const X = st.strategies.find((q) => q.key === 'explore');
		return { st, X, launches, text: `${st.stage}; passes ${launches.map((o) => Math.round(Math.log2(o.cqx / 0.5))).join(', ')}; depth ${launches.map((o) => o.depth).join(', ')}; ` +
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
	// Stop while a finer pass looks for a faster route: no further pass, the route stays
	let stopped = false, t1 = 0;
	r = await drive({ '-1': [{ end: 'finish', idle: 20, layers: 3 }], 0: [{ end: 'time', layers: 50, wait: 8000 }] }, null, (st) => {
		if (st.result && st.strategies[0].pass === 0 && !t1) t1 = Date.now();
		if (t1 && Date.now() - t1 > 600 && !stopped) { stopped = true; ED.stop(); }   // (pass 0 under way)
	});
	L = r.launches;
	check('Stop while refining: the route stays, no further pass starts', stopped && r.st.stage === 'found' && r.st.result.ticks === 20 + R && L.length === 2 && r.X.passes === 2 &&
		r.X.ends['0'] && r.X.ends['0'].how === 'stopped' && !r.st.running, r.text);
}

// ---------------------------------------------------------------- GPU searches (--gpu)
/** one route search on a level; the route replayed in the JS engine */
async function solve(name, W, H, cells, seconds) {
	const buf = ED.eelvlOf({ name, width: W, height: H, cells });
	ED.start({ eelvlB64: buf.toString('base64'), seconds, width: 16384 }, { available: true });
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
	// platforms up to a ledge
	let cells = room(40, 20);
	for (let x = 10; x <= 14; x++) cells.push([x, 16, 9]);
	for (let x = 18; x <= 22; x++) cells.push([x, 13, 9]);
	for (let x = 26; x <= 31; x++) cells.push([x, 10, 9]);
	cells.push([29, 9, 121], [2, 17, 255]);
	let r = await solve('gpu test', 40, 20, cells, 60);
	check('platforms: a route to the trophy, and it finishes in the JS engine', r.ok, r.text);
	// a time door (156) between the start and the trophy: shut for the first 5 s, so the route has to wait for it
	cells = room(20, 8);
	for (let y = 1; y <= 5; y++) cells.push([12, y, 9]);
	cells.push([12, 6, 156], [17, 6, 121], [2, 6, 255]);
	r = await solve('time door', 20, 8, cells, 60);
	check('a time door: the route waits for it (finishes after tick 500) and finishes in the JS engine', r.ok && r.ev.complete >= 500, r.text);
	// a coin door (43, 1 coin) in front of the trophy and the coin behind the start: away from the trophy first
	cells = room(24, 8);
	for (let y = 1; y <= 5; y++) cells.push([16, y, 9]);
	cells.push([16, 6, 43, 1], [21, 6, 121], [8, 6, 255], [2, 6, 100]);
	r = await solve('coin door', 24, 8, cells, 60);
	check('a coin door: the route takes the coin behind the start first, and finishes in the JS engine', r.ok && r.ev.coins >= 1, r.text);
	// the trophy sealed off behind a wall, reachable only through a portal pair (no guide line)
	cells = room(20, 8);
	for (let y = 1; y <= 6; y++) cells.push([13, y, 9]);
	cells.push([8, 6, 242, 0, 1, 2], [15, 6, 242, 0, 2, 1], [17, 6, 121], [2, 6, 255]);
	r = await solve('portal', 20, 8, cells, 60);
	check('a portal: the route goes through it without a guide line, and finishes in the JS engine', r.ok, r.text);
	// the trophy above a spike, reached by a 37-row fall: the tick that takes the trophy starts on it and ends over the
	// spike, where the reach field rules the ball out; "every move" must still count that finish (its finish test comes
	// before the prune), not only a beam
	cells = room(9, 44);
	cells.push([4, 1, 255], [4, 38, 121], [4, 39, 361, 1]);
	r = await solve('trophy over a spike', 9, 44, cells, 30);
	const XF = r.st.strategies.find((q) => q.key === 'explore');
	check('a trophy above a spike after a long fall: "every move" finds the route too, and it finishes in the JS engine', r.ok && !!(XF && XF.found),
		`${r.text}; every move: ${XF ? `${XF.state}${XF.found ? ` ${XF.found.time}` : ''}` : 'none'}`);
	// no route, proven: the trophy on a ledge two tiles above any jump (the physics check finds no way up)
	cells = room(20, 10);
	for (let x = 8; x <= 12; x++) cells.push([x, 3, 9]);
	cells.push([10, 2, 121], [3, 8, 255]);
	r = await solve('way too high', 20, 10, cells, 10);
	check('no route, proven: the physics check finds no way up, and the verdict says so', !r.st.result && r.st.stage === 'not found' && r.st.impossible && r.st.impossible.by === 'physics' &&
		/cannot be reached/.test(r.st.message), r.st.message);
	// no route, not provable by the model (the ledge is 1 px too high for a jump): the closest attempt is kept
	cells = room(20, 10);
	for (let x = 8; x <= 12; x++) cells.push([x, 4, 9]);
	cells.push([10, 3, 121], [3, 8, 255]);
	r = await solve('just too high', 20, 10, cells, 10);
	const cl = r.st.closest;
	check('no route: "not found", with the closest attempt (its distance, path, closest.eetas)', !r.st.result && r.st.stage === 'not found' && !r.st.impossible && cl && cl.tiles > 0 && cl.tiles < 8 &&
		cl.path.length === cl.ticks + 1 && !!ED.solveFile('closest.eetas'), cl ? `${cl.tiles} tiles at tick ${cl.ticks} (${cl.strategy}); ${r.st.message.slice(0, 120)}` : `${r.st.stage}: no closest attempt`);
}

(async () => {
	roundtripSection();
	checksSection();
	await appSection();
	await passesSection();
	if (GPU) await gpuSection();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
