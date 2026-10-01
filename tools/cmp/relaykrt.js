'use strict';
// THE RELAY TEST of a stuck leg (B8 hard, cycle 4): one executor reach (in-process, workers 0) from a fixed engine state
// to a waypoint, then, when it fails, the same leg again from ITS OWN closest state (fail.closest.masks: the relay start
// the compile's next rung would take), on a fresh executor. Tells "the leg is two walls" (the first call gets past wall 1
// and the relay is stuck at wall 2) from "one wall" (the relay stuck where the first call was), and checks that the
// closest state's masks really end at the reported closest tile (closestReplay.passesTile / end).
//   node tools/cmp/relaykrt.js <level.eelvl> <start.eetas> "<label>" [--ms=45000] [--level=3] [--defaults=1]
// <start.eetas>: a whole run from the level start (e.g. a known route cut at a tick); <label>: the model's trigger label as
// the compile prints it ("coin (207,189)"; a trailing " xN" dropped). Env as the compiler's (EEAT_*): e.g. EEAT_SKEL=0 runs
// the executor's direct leg alone. Prints one JSON line.
// Measured (box 8, NC Naos 10a3, the known route nc-naos-antediluvian-8b3249 cut at tick 4125 = its coin (254,174), the
// leg to coin (207,189), 45 s, --defaults=1): the default skeleton stops at (248,189) 42.6 tiles (tick 4265, vx -3.9,
// vy -4.7) and its relay stays there; with EEAT_SKEL=0 the glide is carried to (230,189) 24.6 tiles at tick 4391 (the
// route's own place and time: (227.5,190.6) at 4390) and the relay from it stops at (228,188) 23 tiles, where the route's
// state 2-3 tiles away finds the rest in 0.9 s (tools/cmp/krt.js): two walls.
const path = require('path');
if (process.argv.includes('--defaults=1')) require(path.join(__dirname, '..', '..', 'src/plan/defaults.js')).apply();
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const [file, startF, label0] = pos;
	if (!file || !startF || !label0) { console.error('usage: see the header'); process.exit(2); }
	const ms = +opt('ms', 45000) || 45000, lv = +opt('level', 3);
	const label = String(label0).replace(/ x\d+$/, '');
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const M = MD.compileModel(L);
	const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
	if (!X) { console.log(JSON.stringify({ err: 'no trigger ' + label })); process.exit(0); }
	const wp = { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
	const mk = async () => {
		const bounds = BM.createBounds(L, {});
		const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
		return EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
	};
	const start = C.readEetas(startF);
	const replay = (masks) => {
		const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
		const tiles = new Set();
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (t >= start.length - 1) tiles.add(T.tileOf(sim, W, H)); }
		return { end: T.tileOf(sim, W, H), px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y, tiles };
	};
	const xy = (t) => [t % W, (t / W) | 0];
	const ex = await mk();
	const t0 = Date.now();
	const r1 = await ex.reach([T.strOf(start)], wp, { ms, level: lv, k: 4 });
	const out = { level: path.basename(file), label, start: start.length, ms, ok: r1.ok, firstMs: Date.now() - t0, tool: r1.tool || null, ticks: r1.ok ? r1.arrivals[0].tick - start.length : null, why: r1.fail ? r1.fail.why : null };
	await ex.close();
	if (!r1.ok && r1.fail && r1.fail.closest) {
		const c = r1.fail.closest;
		out.closest = { dist: c.dist, tile: xy(c.tile), vx: c.vx, vy: c.vy, masks: !!c.masks };
		if (c.masks) {
			const m = typeof c.masks === 'string' ? T.masksOf(c.masks) : Uint8Array.from(c.masks);
			const rp = replay(m);
			out.closestReplay = { ticks: m.length, end: xy(rp.end), px: rp.px, py: rp.py, vx: rp.vx, vy: rp.vy, passesTile: rp.tiles.has(c.tile) };
			const ex2 = await mk();
			const t1 = Date.now();
			const r2 = await ex2.reach([T.strOf(m)], wp, { ms, level: lv, k: 4 });
			out.relay = { ok: r2.ok, ms: Date.now() - t1, tool: r2.tool || null, ticks: r2.ok ? r2.arrivals[0].tick - m.length : null, closest: r2.fail && r2.fail.closest ? [r2.fail.closest.dist, ...xy(r2.fail.closest.tile)] : null };
			await ex2.close();
		}
	}
	console.log(JSON.stringify(out));
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 600) })); process.exit(0); });
