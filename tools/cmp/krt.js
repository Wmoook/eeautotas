'use strict';
// THE KNOWN-ROUTE TEST of a stuck leg (the compiler lanes' diagnosis, block 4): the executor (in-process, workers 0) from
// the KNOWN ROUTE'S OWN engine states to the compile's failing waypoint. A leg found from the route's state at the previous
// trigger means the compile's own arrival states (or its order) are the fault; a leg found only from a later route state
// (hit-300 / hit-120) means the finder fails on the leg's length / its field; none found means the finder (or the
// waypoint) is the fault. The route's states are exact (replayed by the engine), so a find is a real leg.
//   node tools/cmp/krt.js <level.eelvl> <route.eetas> "<label>" [--rungs=1,2] [--backs=300,120] [--prev=1] [--scale=1] [--fast=1]
// (--fast=1: the budgets marked fast, as the strategy marks them before the compile's first route)
// <label>: the model's trigger label as the compile reports it ("coin (93,41)", "purple switch 1 (196,14)", a trailing
//   " xN" is dropped) or "trophy". --rungs: the calls, one per rung listed, on the same executor (its memos and the
//   counterexample walls carry over between calls, as in a compile: "1,1,2,2,3" = 5 calls). --backs: starts that many
//   ticks before the route first enters the target (0 / empty = none). --prev=0: no start at the route's previous trigger.
// Prints one JSON line per call to stderr and a summary JSON line to stdout: the route's hit tick, its trigger order up to
// the hit, per call {start, tick, routeLeg (the route's own ticks from there), rung, ok, ms, tool, ticks, why, closest,
// ctile}. Env as the compiler's (EEAT_*): an A/B of a knob on the known route's legs.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const RUNG_MS = [1500, 5000, 15000, 45000];
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const [file, rfile, label0] = pos;
	if (!file || !rfile || !label0) { console.error('usage: node tools/cmp/krt.js <level.eelvl> <route.eetas> "<label>" [--rungs=1,2] [--backs=300,120] [--prev=1]'); process.exit(2); }
	const label = String(label0).replace(/ x\d+$/, '');
	const rungs = String(opt('rungs', '1,2')).split(',').filter(Boolean).map(Number);
	const backs = String(opt('backs', '300,120')).split(',').filter(Boolean).map(Number).filter((b) => b > 0);
	const usePrev = opt('prev', '1') !== '0', scale = +opt('scale', 1) || 1, fast = opt('fast', '0') === '1';
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const masks = C.readEetas(rfile);
	const ev = TS.routeEvents(L, masks);
	const out = { level: path.basename(file), label, complete: ev.complete, runTicks: ev.runTicks };
	let wp, inTarget;
	if (label === 'trophy') {
		wp = { kind: 'trophy', label: 'trophy' };
		inTarget = (sim) => !!sim.has_silver_crown;
	} else {
		const M = MD.compileModel(L);
		const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) { out.err = 'no trigger ' + label; console.log(JSON.stringify(out)); process.exit(0); }
		const tiles = new Set(X.tiles);
		wp = { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
		inTarget = (sim) => tiles.has(T.tileOf(sim, W, H));
		out.tiles = X.tiles.length;
	}
	// (the route's first tick in the target)
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	let hit = -1;
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (inTarget(sim)) { hit = t + 1; break; } if (sim.has_silver_crown) break; }
	out.hit = hit;
	if (hit < 0) { out.err = 'the known route never enters the target'; console.log(JSON.stringify(out)); process.exit(0); }
	const prevEv = ev.events.filter((e) => e.tick < hit && e.feat !== 'deaths' && e.feat !== 'fx').pop();
	const order = TS.orderOf(ev.events.filter((e) => e.tick <= hit));
	out.nOrder = order.length;
	out.routeOrder = order.slice(-4).map((s) => `${s.feat}@${s.tick}(${s.tile % W},${(s.tile / W) | 0})`);
	const bounds = BM.createBounds(L, {});
	const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
	const ex = await EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
	const starts = [];
	if (usePrev && prevEv) starts.push(['prevEvent ' + prevEv.feat, prevEv.tick]); else if (usePrev) starts.push(['spawn', 0]);
	// (with the previous trigger's start: only starts after it; --prev=0: any start from the level's start on, e.g. the route's
	// state before triggers the plan leaves out)
	for (const b of backs) if (hit - b > (usePrev && prevEv ? prevEv.tick : 0)) starts.push(['hit-' + b, hit - b]);
	out.res = [];
	for (const [name, tk] of starts) {
		for (const r of rungs) {
			const t0 = Date.now();
			const res = await ex.reach([T.strOf(masks.subarray(0, tk))], wp, { ms: RUNG_MS[Math.max(0, Math.min(3, r))] * scale, level: r, k: 4, fast });
			const cl = res.fail && res.fail.closest;
			const row = { start: name, tick: tk, routeLeg: hit - tk, rung: r, ok: res.ok, ms: Date.now() - t0, tool: res.tool,
				ticks: res.ok ? res.arrivals[0].tick - tk : null, why: res.fail ? res.fail.why : null,
				closest: cl && cl.dist >= 0 ? +(+cl.dist).toFixed(1) : null, ctile: cl && cl.tile >= 0 ? [cl.tile % W, (cl.tile / W) | 0] : null };
			out.res.push(row);
			console.error(JSON.stringify(row));
			if (res.ok) break;
		}
	}
	console.log(JSON.stringify(out));
	await ex.close();
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 400) })); process.exit(0); });
