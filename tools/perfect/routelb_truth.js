'use strict';
// T-ROUTELB-ADMISSIBLE: the order-aware route bound (src/math/routelb.js) against every known route (src/plan/truthset.js).
//   EEAT_TRUTH_ROOT=<checkout with src/jobs, src/out> node tools/perfect/routelb_truth.js [--shard=i/n] [--states=12]
//     [--ms=4000] [--only=<name substring>] [--out=<file.jsonl>] [--limit=N]
// Per route: the run bound from the level start (runBound) <= the route's run ticks, and at the route's trigger events
// and --states evenly spread ticks the bound from the route's own exact state (bound) <= the ticks left to its finish.
// A violation is printed with its state; the summary: routes, states, violations, the start bound / run ticks ratio.
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const R = require('../../src/math/routelb.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const [shI, shN] = (args.shard || '0/1').split('/').map(Number);
const nStates = args.states !== undefined ? +args.states : 12;
const ms = +args.ms || 4000;
const out = args.out ? fs.openSync(args.out, 'a') : null;
const routes = TS.knownRoutes({});
let nR = 0, nS = 0, viol = 0, skipped = 0;
const ratios = [];
const t0 = Date.now();
const levelCache = new Map();
// (--reverse=1: the shard from its end: a second machine meets the first in the middle; the records carry ri)
const order = [...routes.entries()];
if (args.reverse === '1') order.reverse();
for (const [ri, e] of order) {
	if (ri % shN !== shI) continue;
	if (args.limit && nR >= +args.limit) break;
	if (args.only && !String(e.name).toLowerCase().includes(String(args.only).toLowerCase())) continue;
	let tr = null;
	try { tr = TS.loadTruth(e); } catch (err) { tr = null; }
	if (!tr) { skipped++; continue; }
	nR++;
	const L = tr.L;
	const tq = Date.now();
	let rl = null;
	try { rl = R.createRouteLB(L, {}); } catch (err) { console.log(`  ERROR ${e.name}: ${err.message}`); continue; }
	const rec = { ri, name: e.name, source: e.source, route: path.basename(path.dirname(e.route)), run: tr.runTicks, complete: tr.complete, W: L.width, H: L.height };
	// the start
	const rb = rl.runBound({ ms });
	rec.start = rb.lb; rec.startComplete = rb.complete; rec.order = (rb.order || []).slice(0, 12);
	if (rb.lb > tr.runTicks) { viol++; rec.startViolation = true; console.log(`  VIOLATION start ${e.name} (${e.source}): run bound ${rb.lb} > route run ticks ${tr.runTicks}`); }
	ratios.push(rb.lb / tr.runTicks);
	// the states: the trigger events and evenly spread ticks
	const ticks = new Set();
	try { for (const x of TS.routeEvents(L, tr.masks, { until: tr.complete }).events) if (x.tick < tr.complete) ticks.add(x.tick); } catch (err) { /* none */ }
	for (let k = 1; k <= nStates; k++) ticks.add(Math.floor((tr.complete * k) / (nStates + 1)));
	const list = [...ticks].filter((t) => t > 0 && t < tr.complete).sort((a, b) => a - b);
	// (at most 60 states a route: the events of a long route are many)
	const pick = list.length > 60 ? list.filter((t, i) => i % Math.ceil(list.length / 60) === 0) : list;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let t = 0, worst = 0;
	rec.states = 0; rec.viol = 0;
	for (const tk of pick) {
		while (t < tk) { E.applyMask(inp, tr.masks[t]); sim.tick(inp); t++; }
		const left = tr.complete - t;
		let b;
		try { b = rl.bound(sim, { ms }); } catch (err) { console.log(`  ERROR ${e.name} t${t}: ${err.message}`); continue; }
		nS++; rec.states++;
		if (b.lb > left) {
			viol++; rec.viol++;
			if (rec.viol <= 3) console.log(`  VIOLATION ${e.name} (${e.source}) t${t}: bound ${b.lb.toFixed(2)} > ${left} left; pos ${(sim.px / 16).toFixed(2)},${(sim.py / 16).toFixed(2)} v ${sim.speed_x.toFixed(2)},${sim.speed_y.toFixed(2)} dead ${sim.is_dead} order ${(b.order || []).slice(0, 4).join(' -> ')}`);
		}
		if (left > 0 && b.lb / left > worst) worst = b.lb / left;
	}
	rec.worstRatio = Math.round(worst * 1000) / 1000;
	rec.ms = Date.now() - tq;
	rec.stats = rl.stats();
	if (out) fs.writeSync(out, JSON.stringify(rec) + '\n');
	console.log(`  ${nR} ${e.name} (${e.source}) ${L.width}x${L.height} run ${tr.runTicks} start bound ${rb.lb} (${(rb.lb / tr.runTicks).toFixed(3)}) states ${rec.states} viol ${rec.viol} worst ${rec.worstRatio} ${rec.ms} ms`);
}
const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`T-ROUTELB-ADMISSIBLE routes ${nR} (skipped ${skipped}) states ${nS} violations ${viol} start ratio median ${med(ratios).toFixed(3)} ${((Date.now() - t0) / 1000).toFixed(0)} s: ${viol === 0 ? 'PASS' : 'FAIL'}`);
