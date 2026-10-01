'use strict';
// THE LEG A/B: one waypoint leg from ONE fixed engine state, called again and again on fresh executors, as the compile's
// rung ladder calls it; the success rate, the ticks and the worker time per find of a hard leg (a mini's switch, a room)
// under the current EEAT_* knobs. Two arms (knob off / on) from the SAME start file = a paired measurement of a finder or
// field change on the leg that stops a compile, far less noisy than whole compiles.
//   node tools/cmp/legab.js <level.eelvl> --start=<file.eetas> "<label>" [--rungs=1,2] [--reps=6] [--seed=1]
//   node tools/cmp/legab.js <level.eelvl> --make=<file.eetas> --path="<label>;<label>;..." [--from=<file.eetas>]
// --make: builds a start: from the level start (or --from's state) the executor reaches each label of --path in turn
//   (rungs 1..3, the first arrival kept) and writes the inputs to the file (an .eetas: exact, replayable).
// <label>: the model's trigger label as the compile prints it ("purple switch 3 (156,177)"; a trailing " xN" dropped).
// Each rep: a fresh executor (no memo or wall carries over between reps); within a rep the rungs listed are called in
// order until one finds the leg ("1,2,3" = the ladder a compile climbs). Prints one JSON line per call to stderr and a
// summary JSON line to stdout {found, reps, ms per find, ticks, closests}.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const RUNG_MS = [1500, 5000, 15000, 45000];
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const file = pos[0];
	if (!file) { console.error('usage: see the header'); process.exit(2); }
	const L = T.loadLevelFile(file), W = L.width;
	const M = MD.compileModel(L);
	const wpOf = (label0) => {
		const label = String(label0).replace(/ x\d+$/, '');
		const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) throw new Error('no trigger ' + label);
		return { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
	};
	const fresh = async () => {
		const bounds = BM.createBounds(L, {});
		const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
		return EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
	};
	const cl = (res) => { const c = res.fail && res.fail.closest; return c && c.dist >= 0 ? [+(+c.dist).toFixed(1), c.tile % W, (c.tile / W) | 0] : null; };
	if (opt('make', '')) {
		let masks = opt('from', '') ? C.readEetas(opt('from', '')) : new Uint8Array(0);
		const ex = await fresh();
		for (const lab of String(opt('path', '')).split(';').filter(Boolean)) {
			let ok = false;
			for (const r of [1, 2, 3, 3]) {
				const res = await ex.reach([T.strOf(masks)], wpOf(lab), { ms: RUNG_MS[r], level: r, k: 4 });
				console.error(JSON.stringify({ leg: lab, rung: r, ok: res.ok, ticks: res.ok ? res.arrivals[0].tick - masks.length : null, closest: cl(res) }));
				if (res.ok) { const a = res.arrivals[0].masks; masks = typeof a === 'string' ? T.masksOf(a) : Uint8Array.from(a); ok = true; break; }
			}
			if (!ok) { console.log(JSON.stringify({ err: 'no leg to ' + lab })); await ex.close(); process.exit(0); }
		}
		C.writeEetas(opt('make', ''), masks);
		console.log(JSON.stringify({ made: opt('make', ''), ticks: masks.length }));
		await ex.close();
		process.exit(0);
	}
	const label = pos[1];
	const start = C.readEetas(opt('start', ''));
	const rungs = String(opt('rungs', '1,2')).split(',').filter(Boolean).map(Number);
	const reps = +opt('reps', 6) || 6;
	const wp = wpOf(label);
	const out = { level: path.basename(file), label, startTick: start.length, rungs, reps, found: 0, ms: 0, ticks: [], okRung: [], closest: [] };
	for (let rep = 0; rep < reps; rep++) {
		const ex = await fresh();
		for (const r of rungs) {
			const t0 = Date.now();
			const res = await ex.reach([T.strOf(start)], wp, { ms: RUNG_MS[Math.max(0, Math.min(3, r))], level: r, k: 4 });
			const ms = Date.now() - t0;
			out.ms += ms;
			const row = { rep, rung: r, ok: res.ok, ms, tool: res.tool, ticks: res.ok ? res.arrivals[0].tick - start.length : null, why: res.fail ? res.fail.why : null, closest: cl(res) };
			console.error(JSON.stringify(row));
			if (res.ok) { out.found++; out.ticks.push(row.ticks); out.okRung.push(r); break; }
			out.closest.push(row.closest && row.closest.join(':'));
		}
		await ex.close();
	}
	out.sPerFind = out.found ? +(out.ms / 1000 / out.found).toFixed(1) : null;
	out.ms = Math.round(out.ms);
	console.log(JSON.stringify(out));
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 400) })); process.exit(0); });
