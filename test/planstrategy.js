'use strict';
// test/planstrategy.js: the planner's loop (src/plan/strategy.js) and its headless runner (src/plan.js) with MOCK parts
// (test/planmock.js): a toy level (a red key, its door, a sealed coin pocket, the trophy), a planner over three edges, an
// executor that holds right. (a) the loop: a route (C.evaluate'd), the sealed coin failing up the rungs and blocked, no
// (edge, nodeClass, rung) twice, progress with the page's status line; without --first the end 'exhausted' after a
// deepening; (a3) a planner that never learns: 'bug' events, the watchdog's 'stall' within its window, exploration steps,
// the end 'stalled'; (a4) stdin: import, depth, stop. (b) src/plan.js end to end: the exit code, route.eetas replayed, a
// bad level's {"error"} and exit 1.   usage: node test/planstrategy.js [--only=a,b]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const T = require('../src/plan/types.js');
const S = require('../src/plan/strategy.js');
const MOCK = require('./planmock.js');

const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };

// # wall, S spawn, k red key, d red key door, T trophy, a walled pocket with a coin c
const rows = [
	'######################',
	'#..........###.......#',
	'#..........#c#.......#',
	'#..........###.......#',
	'#S....k.........d..T.#',
	'######################',
];
const ID = { '#': [9], S: [255], k: [6], d: [23], c: [100], T: [121] };
const cells = [];
rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
const BUF = ED.eelvlOf({ name: 'plan toy', width: rows[0].length, height: rows.length, cells });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'planstrat-'));
const FILE = path.join(TMP, 'toy.eelvl');
fs.writeFileSync(FILE, BUF);
const L = T.loadLevelFile(FILE);
const tests = { rungMs: [400, 800, 1600, 3200], progressMs: 100, watchMs: 200 };

async function runMock(o, lines) {
	const evs = [];
	const r = await S.run(L, Object.assign({ file: FILE, seconds: 20, workers: 2, parts: MOCK }, tests, o), (ev) => evs.push(ev));
	return { r, evs, of: (k) => evs.filter((e) => e.ev === k) };
}
async function sectionA() {
	console.log('(a) the loop with mock parts (the toy: key, door, sealed coin, trophy)');
	process.env.PLANMOCK_MODE = 'normal';
	// (a1) to the first route
	let x = await runMock({ first: true, out: path.join(TMP, 'a1') });
	const res = x.of('result')[0];
	const ev = res ? C.evaluate(L, T.masksOf(res.inputs)) : null;
	check('a route: the key, then (the sealed coin failed and blocked) the trophy; the result event C.evaluate\'d, the end "finish"',
		x.r.end === 'finish' && !!res && !!ev && ev.runTicks === res.runTicks && ev.complete === res.ticks && x.r.route && T.strOf(x.r.route) === res.inputs, `${x.r.end} ${res ? res.ticks : '-'} ticks`);
	const st = x.of('step');
	const coin = st.filter((s) => s.edge === 'coin');
	check('the sealed coin: failed at rungs 0, 1, 2, 3 then blocked (4 steps, rising rungs), never run twice at one rung',
		coin.length === 4 && coin.every((s, i) => s.rung === i && !s.ok), coin.map((s) => `${s.rung}:${s.ok}`).join(' '));
	const trip = st.map((s) => `${s.edge}|${s.nodeClass}|${s.rung}|${s.epoch}`);
	check('no (edge, nodeClass, rung) twice', new Set(trip).size === trip.length, trip.join(' '));
	const src = x.of('source');
	check('every new model state a "source" event (room, desc, gain, tick, dist on the editor\'s scale: 6000 + the reach field\'s tiles without a steer file, inputs)',
		src.length === 1 && Number.isFinite(src[0].room) && src[0].gain === 1 && src[0].dist >= 6000 && src[0].dist < 9990 && /^[0-O]+$/.test(src[0].inputs) && x.of('closest').length === 0,
		JSON.stringify(src.map((s) => ({ room: s.room, dist: s.dist, tick: s.tick }))));
	const pg = x.of('progress');
	check('progress events with the page\'s status line (detail "plan N steps: ... · k states · f facts") and the editor\'s fields (states, rooms, layer, workers)',
		pg.length >= 2 && pg.every((p) => /^plan \d+ steps: /.test(p.detail) && Number.isFinite(p.states) && Number.isFinite(p.layer) && p.workers === 2), pg.length ? pg[pg.length - 1].detail : '-');
	const fct = x.of('fact');
	check('fact events for every learnt fact (kind, edge, rung)', fct.length >= 6 && fct.every((f) => f.kind && f.edge !== undefined), fct.map((f) => `${f.kind}:${f.edge}`).join(' '));
	check('start / model / done events; out/facts.json, anchors.json, events.jsonl, route.eetas written',
		x.of('start').length === 1 && x.of('model').length === 1 && x.of('done').length === 1 && ['facts.json', 'anchors.json', 'events.jsonl', 'route.eetas'].every((f) => fs.existsSync(path.join(TMP, 'a1', f))),
		fs.readdirSync(path.join(TMP, 'a1')).join(','));
	check('no bug events on a sound planner', x.of('bug').length === 0, JSON.stringify(x.of('bug')));
	// (a2) without --first: after the route every edge done or blocked: a deepening, then the end "exhausted"
	x = await runMock({ first: false, maxDeepen: 1 });
	check('without --first: the route, then every anchor exhausted: one deepening (rungs reset, budgets x2), then the end "exhausted"',
		x.r.end === 'exhausted' && x.of('result').length === 1 && x.of('deepen').length === 1 && x.of('deepen')[0].mult === 2, `${x.r.end}, deepen ${x.of('deepen').length}`);
	const trip2 = x.of('step').map((s) => `${s.edge}|${s.nodeClass}|${s.rung}|${s.epoch}`);
	check('no (edge, nodeClass, rung) twice in a deepening epoch', new Set(trip2).size === trip2.length, trip2.join(' '));
	// (a3) a planner that never learns and proposes a new edge every time: 'bug' events, the watchdog's stall
	process.env.PLANMOCK_MODE = 'stuck';
	const t3 = Date.now();
	x = await runMock({ first: false, stallWindowS: 1, stallS: 4, seconds: 30 });
	const stall = x.of('stall');
	check('a planner that never learns: a "bug" event per step (no anchor, no fact: the triple blocked here)', x.of('bug').length >= 3 && x.of('bug').every((b) => b.what === 'no progress'), `${x.of('bug').length} bugs`);
	check('the watchdog: a "stall" within its window (1 s here), the first a deepening, later ones exploration steps (region waypoints on the unvisited frontier)',
		stall.length >= 2 && stall[0].t <= 2.5 && x.of('deepen').some((d) => d.why === 'stall') && x.of('step').some((s) => /^explore \d+ tiles$/.test(s.label)),
		`${stall.map((s) => s.t).join(', ')} s; ${x.of('step').filter((s) => /^explore/.test(s.label)).length} explore steps`);
	check('--stallS: no new state for stallS (4 s here): the end "stalled"', x.r.end === 'stalled' && (Date.now() - t3) / 1000 < 12, `${x.r.end} after ${((Date.now() - t3) / 1000).toFixed(1)} s`);
	process.env.PLANMOCK_MODE = 'normal';
	// (a4) stdin: import (a state of another search), depth (only shorter routes count), stop
	const key = T.playTo(L, new Uint8Array(40).fill(4), { goal: T.goalOf(L, { kind: 'trigger', tiles: MOCK.compileModel(L).key, expect: { feat: 'key0', value: 1 } }) });
	const imp = new Uint8Array(40).fill(4).subarray(0, key.goalAt);
	let push = null;
	const q = [];
	const lines = { [Symbol.asyncIterator]() { return { next: () => new Promise((res) => { if (q.length) res({ value: q.shift(), done: false }); else push = (v) => res({ value: v, done: false }); }) }; } };
	const say = (l) => { if (push) { const p = push; push = null; p(l); } else q.push(l); };
	// (the stuck planner: it runs until told to stop, a step every 20 ms)
	process.env.PLANMOCK_MODE = 'stuck';
	process.env.PLANMOCK_DELAY = '20';
	const evs = [];
	const pr2 = S.run(L, Object.assign({ file: FILE, seconds: 20, workers: 2, parts: MOCK, stdinLines: lines }, tests), (e) => evs.push(e));
	await new Promise((r) => setTimeout(r, 300));
	say(`import ${T.strOf(imp)}`);
	await new Promise((r) => setTimeout(r, 400));
	const importEv = evs.filter((e) => e.ev === 'import');
	const picked = new Set(evs.filter((e) => e.ev === 'step').map((e) => e.anchor));
	say('depth 5');
	await new Promise((r) => setTimeout(r, 100));
	const idx = evs.length;
	await new Promise((r) => setTimeout(r, 500));
	say('stop');
	const r4 = await pr2;
	process.env.PLANMOCK_MODE = 'normal'; delete process.env.PLANMOCK_DELAY;
	check('stdin "import <inputs>": a state of another search replayed, its model state (the key held) a new anchor, which the loop then picks', importEv.length === 1 && importEv[0].key === 'k1' && picked.has(importEv[0].anchor),
		`${JSON.stringify(importEv)}; anchors picked ${[...picked].join(',')}`);
	const after = evs.slice(idx).filter((e) => e.ev === 'step');
	check('stdin "depth 5": no anchor past tick 5 picked after it (a route through it is longer: a proof)', after.length >= 3 && after.every((e) => e.anchor === 1), `${after.length} steps, anchors ${[...new Set(after.map((e) => e.anchor))].join(',')}`);
	check('stdin "stop": the end "stopped"', r4.end === 'stopped', r4.end);
}
function sectionB() {
	console.log('(b) src/plan.js end to end (mock parts through --parts)');
	const out = path.join(TMP, 'b1');
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'plan.js'), FILE, `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=20', '--first=1', `--out=${out}`, '--progressMs=100'],
		{ encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { PLANMOCK_MODE: 'normal' }) });
	const lines = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{'));
	let evs = [];
	try { evs = lines.map((l) => JSON.parse(l)); } catch (e) { evs = []; }
	const done = evs.find((e) => e.ev === 'done');
	const route = fs.existsSync(path.join(out, 'route.eetas')) ? C.readEetas(path.join(out, 'route.eetas')) : null;
	const ev = route ? C.evaluate(L, route) : null;
	check('node src/plan.js <toy> --first=1: exit 0, JSON lines, the end "finish", route.eetas replayed by C.evaluate',
		r.status === 0 && evs.length === lines.length && lines.length > 5 && done && done.end === 'finish' && !!ev && ev.complete === done.best,
		`exit ${r.status}, ${lines.length} lines, ${done ? done.end : '-'}; ${String(r.stderr || '').slice(-300)}`);
	const bad = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'plan.js'), path.join(TMP, 'nope.eelvl'), `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=5'], { encoding: 'utf8', timeout: 30000 });
	const bl = String(bad.stdout || '').split('\n').filter((l) => l.startsWith('{'));
	check('a level that is not there: {"error": ...} and exit 1', bad.status === 1 && bl.length >= 1 && !!JSON.parse(bl[bl.length - 1]).error, `exit ${bad.status}: ${bl.join(' ').slice(0, 200)}`);
}

(async () => {
	if (want('a')) await sectionA();
	if (want('b')) sectionB();
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* busy */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
