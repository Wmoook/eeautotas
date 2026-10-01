'use strict';
// THE PROVEN LOWER BOUND BY EXHAUSTIVE SEARCH: node tools/perfect/proveladder.js <level.eelvl> --from=<C0> [--to=<C1>]
//   [--route=<route.eetas>] [--threads=8] [--seconds=3600] [--split=3] [--json=<out.json>]
// Runs src/plan/levelproof.js for C = from, from + 1, ... (each a proof that no route takes fewer than C run ticks) while
// the clock lasts; the largest C proven is a PROVEN lower bound on the level's run ticks. A route found at a C (its
// run ticks = C - 1 when C - 1 was proven, the ladder climbing from below) is the optimum: TAS-PERFECT. --to defaults to the
// route's run ticks (proving it optimal at the top).
const fs = require('fs');
const path = require('path');
const Cm = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const LP = require('../../src/plan/levelproof.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
(async () => {
	const t0 = Date.now();
	const total = (+args.seconds || 3600) * 1000;
	let routeRun = Infinity, route = null;
	if (args.route) {
		const L = T.loadLevelFile(file);
		route = Cm.readEetas(args.route);
		const ev = Cm.evaluate(L, route, false);
		if (ev) routeRun = ev.runTicks;
	}
	const from = +args.from || 1, to = args.to ? +args.to : routeRun;
	const out = { level: path.basename(file), from, to, routeRun: Number.isFinite(routeRun) ? routeRun : null, steps: [], provenLB: from - 1, optimal: false, best: null };
	for (let C = from; C <= to; C++) {
		const left = total - (Date.now() - t0);
		if (left < 5000) break;
		const r = await LP.proveLevel({ file }, { C, threads: +args.threads || 8, seconds: Math.floor(left / 1000), split: args.split !== undefined ? +args.split : 3, ttBits: +args.ttBits || 22, taskNodes: +args.taskNodes || 20e6 });
		const step = { C, status: r.status, nodes: r.nodes, ms: r.ms, tasks: r.tasks, bestRun: Number.isFinite(r.bestRun) ? r.bestRun : null, collisionP: r.collisionP };
		out.steps.push(step);
		console.log(JSON.stringify(Object.assign({ ev: 'step' }, step)));
		if (r.best && Number.isFinite(r.bestRun)) {
			// (a route found below C: with C - 1 proven before it, its run ticks are the optimum)
			out.best = { runTicks: r.bestRun, masks: Buffer.from(r.best).toString('base64') };
			if (r.status === 'proof') { out.provenLB = r.C; out.optimal = r.C >= r.bestRun; }
			if (args.out) Cm.writeEetas(args.out, r.best);
			break;
		}
		if (r.status !== 'proof') break;
		out.provenLB = C;
		if (C >= routeRun) { out.optimal = true; break; }
	}
	out.ms = Date.now() - t0;
	console.log(JSON.stringify(Object.assign({ ev: 'result' }, out, { best: out.best ? out.best.runTicks : null })));
	if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
	process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
