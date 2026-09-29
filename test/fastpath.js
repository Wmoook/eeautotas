'use strict';
// test/fastpath.js - the one search's fast paths give the same results as the code they replace (fast-engine, 2026-09-28):
//   cellmap  goexplore.js CellMap = a Map where explore uses one (get / set / delete / size / values / entries in
//            insertion order, a delete while an iteration runs, a key deleted and set again at the end): random operations
//            side by side with a Map
//   fifths   reach.js fifthsAt (allocation-free) = fifthsAtRef (stateOf's objects) at every state of random runs, with
//            the gravity queue known and unknown, and a tile over (scoreAt's lookups); both fields (death edges or not)
//   search   goexplore.js, one worker, the same seed and tick budget, the cell index as a Map (EEAT_CELLMAP=0) and as a
//            CellMap: the same done event (cells, picks, rooms, snapshots, sweeps, routes: everything but the clocks),
//            with --maxCells small enough that the sweeps delete cells while they iterate; --spd=0: the speed cells' stall
//            clock is wall time (a run of more than --spd s is another search on a faster or slower machine or arm)
// The engine (src/eesim.js) is not changed by these: its runs are the same tick for tick by construction.
// usage: node test/fastpath.js [--only=cellmap,fifths,search] [--levels=<folder of .eelvl>] [--ticks=4000000]
//   (--levels: every level there too, e.g. the user's campaign copies, which are never in git)
//   Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-fastpath-'));
process.env.EEAT_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const RF = require('../src/reach.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only') ? new Set(arg('only').split(',')) : null;
const want = (s) => !ONLY || ONLY.has(s);
const TICKS = +arg('ticks', 4000000);
let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const rngOf = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };

// a coarse-cell level (above 50 x 50 tiles): a floor, platforms, a dot field, coins, a spike row, the trophy far right
function arena() {
	const W = 90, H = 56, cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, H - 1, 9]); cells.push([x, 0, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	for (let k = 0; k < 14; k++) { const x0 = 6 + k * 6, y0 = H - 5 - (k % 5) * 6; for (let d = 0; d < 4; d++) cells.push([x0 + d, y0, 9]); }
	for (let y = 20; y < 30; y++) for (let x = 40; x < 46; x++) cells.push([x, y, 4]);
	for (let x = 20; x < 30; x++) cells.push([x, H - 2, 361]);
	for (let k = 0; k < 6; k++) cells.push([10 + k * 12, H - 9, 100]);
	cells.push([2, H - 2, 255]);
	cells.push([W - 3, H - 2, 121]);
	return ED.eelvlOf({ name: 'fastpath arena', width: W, height: H, cells });
}
const levels = [{ name: 'arena', buf: arena() }];
const dir = arg('levels');
if (dir) for (const f of fs.readdirSync(dir).filter((f) => /\.eelvl$/i.test(f)).sort()) levels.push({ name: f, buf: fs.readFileSync(path.join(dir, f)), file: path.join(dir, f) });
const prep = (buf) => E.prepareLevel(Object.assign(EL.toSimLevel(EL.readEelvl(buf)), { start_mode: 'reset' }));

if (want('cellmap')) {
	console.log('cellmap: CellMap = Map');
	const rnd = rngOf(11);
	const m = new Map(), c = new GX.CellMap();
	let bad = 0, ops = 0;
	const keyOf = () => (((rnd() * 4294967296) >>> 0) % 5000) * 2097152 + (((rnd() * 2097152) >>> 0) % 7);   // (collisions of the high lane on purpose)
	const same = () => { const a = [...m], b = [...c]; if (a.length !== b.length || m.size !== c.size) return false; for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false; return true; };
	for (let round = 0; round < 60; round++) {
		for (let k = 0; k < 4000; k++) {
			const r = rnd(), key = keyOf();
			ops++;
			if (r < 0.55) { const v = { v: ops }; m.set(key, v); c.set(key, v); }
			else if (r < 0.8) { if (m.delete(key) !== c.delete(key)) bad++; }
			else if (m.get(key) !== c.get(key)) bad++;
		}
		// a sweep: delete while iterating (the entries and the values iterators), in the same order
		const seenM = [], seenC = [];
		for (const [k, v] of m) { seenM.push(k); if (v.v % 3 === 0) m.delete(k); }
		for (const [k, v] of c) { seenC.push(k); if (v.v % 3 === 0) c.delete(k); }
		if (seenM.join() !== seenC.join()) bad++;
		const vm = [...m.values()], vc = [...c.values()];
		if (vm.length !== vc.length || vm.some((v, i) => v !== vc[i])) bad++;
		if (!same()) bad++;
	}
	check('random get / set / delete and sweeps: the same answers, sizes and order', bad === 0, `${ops} operations, ${m.size} keys at the end, ${bad} different`);
}

if (want('fifths')) {
	console.log('fifths: fifthsAt = fifthsAtRef');
	for (const lv of levels) {
		const L = prep(lv.buf);
		for (const deaths of [true, false]) {
			const f = RF.reachField(L, deaths ? {} : { deaths: false });
			const sim = new E.EESim(L); sim.reset();
			const inp = new E.EEInput(), snaps = [sim.snapshot()], rnd = rngOf(7);
			let n = 0, bad = 0, cut = 0;
			const one = (px, py, vy, q0, q1, sl) => {
				const a = RF.fifthsAt(f, px, py, vy, q0, q1, sl), b = RF.fifthsAtRef(f, px, py, vy, q0, q1, sl);
				if (!Object.is(a, b)) bad++;
				if (a < 0) cut++;
				n++;
			};
			while (n < 150000) {
				sim.restore(snaps[(rnd() * snaps.length) | 0]);
				let mk = GX.OPTIONS[(rnd() * 18) | 0];
				for (let k = 0; k < 40; k++) {
					if (rnd() >= 0.85) mk = GX.OPTIONS[(rnd() * 18) | 0];
					E.applyMask(inp, mk); sim.tick(inp);
					if (sim.is_dead || sim.has_silver_crown) break;
					one(sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
					one(sim.px, sim.py, sim.speed_y, -1, -1, f.ice ? 2 : 0);
					one(sim.px + 16, sim.py - 16, sim.speed_y, sim._q0, sim._q1, sim._slippery);
					if (RF.costAt(f, sim) < 0) break;
				}
				if (snaps.length < 20000 && rnd() < 0.5) snaps.push(sim.snapshot());
			}
			check(`${lv.name} (${f.mode}, ${deaths ? 'death edges' : 'death-free'})`, bad === 0, `${n} lookups, ${cut} cut off, ${bad} different`);
		}
	}
}

if (want('search')) {
	console.log('search: the same search with a Map and a CellMap');
	const CLOCKS = new Set(['seconds', 'ticksPerSec', 'cpuS', 'heapMB', 'walkMs', 'sec', 'ms', 'pickMs', 'hostMs', 'waitMs']);
	const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (CLOCKS.has(k) ? undefined : v)));
	for (const lv of levels) {
		let file = lv.file;
		if (!file) { file = path.join(HOME, 'arena.eelvl'); fs.writeFileSync(file, lv.buf); }
		const run = (cellmap) => {
			const r = spawnSync(process.execPath, [GOX, file, '--workers=1', '--seed=3', `--maxTicks=${TICKS}`, '--seconds=900', '--mem=400', '--maxCells=1500', '--spd=0'],
				{ env: Object.assign({}, process.env, { EEAT_CELLMAP: cellmap }), encoding: 'utf8', maxBuffer: 256 << 20 });
			const lines = (r.stdout || '').split('\n').filter((s) => s.startsWith('{'));
			const done = lines.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).find((o) => o && o.ev === 'done');
			const results = lines.filter((s) => s.includes('"ev":"result"')).map((s) => { const o = JSON.parse(s); return [o.runTicks, o.ticks, o.inputs].join(':'); });
			return { done, results, err: r.stderr };
		};
		const a = run('0'), b = run('1');
		const ok = !!a.done && !!b.done && JSON.stringify(strip(a.done)) === JSON.stringify(strip(b.done)) && a.results.join() === b.results.join();
		const w = b.done && b.done.workers ? b.done.workers[0] : {};
		check(`${lv.name}: the same cells, picks, sweeps and routes`, ok, a.done && b.done ? `${w.ticks} ticks, ${w.cells} cells, ${w.picks} picks, ${w.sweeps} sweeps (${w.evicted} cells swept), ${b.results.length} routes` : `no done event: ${(a.err || b.err || '').slice(-300)}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
