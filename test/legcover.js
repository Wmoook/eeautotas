'use strict';
// test/legcover.js: the coverage leg finder (src/plan/legs.js legCover) and its executor slot (EEAT_COVER=1, executor.js
// COVER_*). Prints 'name: ok|FAIL', ends 'N/M' (passed / checks), exit 1 on a failure.
// usage: node test/legcover.js [--truth]   (--truth, EEAT_TRUTH_ROOT: K Underground's detour leg from its known route's own
//        state, the leg the field-following finders fail at rungs 1-2; the level and the route are local files, never in git)
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const LG = require('../src/plan/legs.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legcover-'));
function levelOf(rows, ID, name) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.' && ID[ch]) cells.push([x, y, ...ID[ch]]); }));
	const buf = ED.eelvlOf({ name: name || 't', width: rows[0].length, height: rows.length, cells });
	const file = path.join(tmpDir, `${name || 't'}.eelvl`);
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	return { L, file, at: (x, y) => y * L.width + x };
}
/** replay start masks + tail from the level start: does the ball's centre enter a goal tile, and when */
function replayHits(L, pre, tail, tiles) {
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	const set = new Set(tiles);
	const all = T.concat(pre, tail);
	for (let t = 0; t < all.length; t++) { E.applyMask(inp, all[t] & 31); sim.tick(inp); if (set.has(T.tileOf(sim, L.width, L.height))) return t + 1; }
	return -1;
}

(async () => {
	// ---- a detour room: the goal (G) sits right of the spawn behind a wall; the only way is left, up through the gap and over
	const rows = [
		'##########################',
		'#........................#',
		'#........................#',
		'#...##################...#',
		'#....................#...#',
		'#.........S..........#.G.#',
		'##########################',
	];
	const { L, at } = levelOf(rows, { '#': [9], S: [255], G: [100] }, 'detour');
	const sim = new E.EESim(L); sim.reset();
	const goalTiles = [at(23, 5)];
	const set = new Set(goalTiles);
	const goal = { kind: 'trigger', tiles: goalTiles, test: (s) => set.has(T.tileOf(s, L.width, L.height)) };
	const field = T.goalField(L, goalTiles);
	const start = [{ snap: sim.snapshot(), tick: 0 }];
	const r1 = LG.legCover(L, start, goal, { sim: new E.EESim(L), field, seed: 7, deadline: Date.now() + 20000 });
	check('cover: the detour room found', r1.status === 'found', `${r1.status}, ${r1.depth} ticks, ${r1.passes[0].cells} cells, ${r1.sims} sims`);
	const hit = r1.status === 'found' ? replayHits(L, new Uint8Array(0), r1.tail, goalTiles) : -1;
	check('cover: its path replays into the goal from the level start', hit > 0 && hit <= r1.depth, `hit ${hit}, depth ${r1.depth}`);
	const r2 = LG.legCover(L, start, goal, { sim: new E.EESim(L), field, seed: 7, deadline: Date.now() + 20000 });
	check('cover: the same seed, the same leg', r2.status === r1.status && r2.depth === r1.depth && T.strOf(r2.tail) === T.strOf(r1.tail), `${r2.depth} vs ${r1.depth}`);
	// the time limit: a sealed goal ends 'time' with a closest
	const sealed = levelOf(['#######', '#S...##', '#######', '#.G...#', '#######'], { '#': [9], S: [255], G: [100] }, 'sealed');
	const sim2 = new E.EESim(sealed.L); sim2.reset();
	const gt = [sealed.at(2, 3)], gs = new Set(gt);
	const r3 = LG.legCover(sealed.L, [{ snap: sim2.snapshot(), tick: 0 }], { kind: 'trigger', tiles: gt, test: (s) => gs.has(T.tileOf(s, sealed.L.width, sealed.L.height)) }, { sim: new E.EESim(sealed.L), seed: 1, deadline: Date.now() + 300 });
	check('cover: a sealed goal: no leg, ended by its clock', r3.status === 'time' && !r3.goals, r3.status);

	// ---- the executor slot: off by default (no cover tier), on with EEAT_COVER=1 from rung 1
	const EX = require('../src/plan/executor.js');
	const { L: L2, file } = levelOf(rows, { '#': [9], S: [255], G: [100] }, 'detour2');
	for (const on of [false, true]) {
		if (on) process.env.EEAT_COVER = '1'; else delete process.env.EEAT_COVER;
		const ex = await EX.createExecutor(L2, { file, workers: 0 });
		const wp = { kind: 'trigger', tiles: goalTiles, label: 'coin', expect: null };
		const res = await ex.reach([''], wp, { ms: 4000, level: 1, k: 4 });
		const tiers = (res.tiers || []).map((t) => t.tier);
		check(`executor ${on ? 'EEAT_COVER=1' : 'default'}: the leg found`, !!res.ok, `${res.tool}, ${res.ok ? res.arrivals[0].tick : res.fail && res.fail.why} (tiers ${tiers.join(',')})`);
		if (!on) check('executor default: no cover tier ran', !tiers.includes('cover'));
		await ex.close();
	}
	// ---- cover v2 (EEAT_COVER=2): the fallback before the first route (budget.fast); none after it
	process.env.EEAT_COVER = '2';
	for (const fast of [true, false]) {
		const ex = await EX.createExecutor(L2, { file, workers: 0 });
		const wp = { kind: 'trigger', tiles: goalTiles, label: 'coin', expect: null };
		const res = await ex.reach([''], wp, { ms: 4000, level: 1, k: 4, fast });
		const tiers = (res.tiers || []).map((t) => t.tier);
		if (fast) check('executor EEAT_COVER=2, before a route (fast): the leg found', !!res.ok, `${res.tool}, ${res.ok ? res.arrivals[0].tick : res.fail && res.fail.why} (tiers ${tiers.join(',')})`);
		else check('executor EEAT_COVER=2, after a route (not fast): no cover tier ran', !tiers.includes('cover'), `tiers ${tiers.join(',')}`);
		// (v2: the cover is never the call's FIRST tier: the field-following finders run before it)
		if (fast && tiers.includes('cover')) check('executor EEAT_COVER=2: the cover after the best-first search', tiers.indexOf('best') >= 0 && tiers.indexOf('best') < tiers.indexOf('cover'), `tiers ${tiers.join(',')}`);
		await ex.close();
	}
	delete process.env.EEAT_COVER;

	// ---- the truth: K Underground's detour leg (checkpoint (17,80) -> (64,84), the route's own state at tick 225)
	if (args.truth) {
		const root = process.env.EEAT_TRUTH_ROOT;
		const lf = root && path.join(root, 'src', 'out', 'god', 'levels', 'campaign', '37_5_K_Underground.eelvl');
		const rf = root && path.join(root, 'src', 'out', 'god', 'baseline', 'box1', 'resA', 'runs', '37_5_K_Underground', 'final.eetas');
		if (!lf || !fs.existsSync(lf) || !fs.existsSync(rf)) check('truth: K Underground files', false, 'EEAT_TRUTH_ROOT with src/out/god');
		else {
			const LK = T.loadLevelFile(lf);
			const masks = require('../src/common.js').readEetas(rf);
			const MD = require('../src/plan/model.js');
			const X = MD.compileModel(LK).triggers.find((x) => x.label === 'checkpoint (64,84)');
			const sk = new E.EESim(LK), inp = new E.EEInput(); sk.reset();
			for (let t = 0; t < 225; t++) { E.applyMask(inp, masks[t] & 31); sk.tick(inp); }
			const kt = new Set(X.tiles);
			const g = { kind: 'trigger', tiles: X.tiles, test: (s) => kt.has(T.tileOf(s, LK.width, LK.height)) };
			const fk = T.goalField(T.levelNow(LK, sk), X.tiles);
			let found = 0;
			for (const seed of [1, 2, 3]) {
				const r = LG.legCover(LK, [{ snap: sk.snapshot(), tick: 225 }], g, { sim: new E.EESim(LK), field: fk, seed, deadline: Date.now() + 10000 });
				if (r.status === 'found' && replayHits(LK, masks.subarray(0, 225), r.tail, X.tiles) > 0) found++;
			}
			check('truth: K Underground checkpoint (64,84) from the route\'s tick 225, 3 seeds x 10 s', found === 3, `${found} of 3`);
		}
	}
	console.log(`${pass}/${pass + fail}`);
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* left */ }
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
