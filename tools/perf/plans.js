'use strict';
// THE PLANNER'S PLANS FROM THE START (n5-perfect, a probe): model + bounds + planner on a level, the k best plans from
// the level start with their steps, est and admissible lb. node tools/perf/plans.js <level.eelvl> [--k=6] [--ms=4000]
const T = require('../../src/plan/types.js');
const { compileModel } = require('../../src/plan/model.js');
const { createFacts } = require('../../src/plan/facts.js');
const { createPlanner } = require('../../src/plan/planner.js');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? +a.split('=')[1] : d; };
(async () => {
	const L = T.loadLevelFile(file);
	const model = await compileModel(L, { file });
	let bounds = null;
	try { bounds = await require('../../src/plan/bounds.js').createBounds(L, { model }); } catch (e) { console.log('no bounds', e.message); }
	const facts = createFacts({ rungs: 4, model });
	const planner = createPlanner(model, facts, { bounds, file, floorAsync: false });
	const GX = require('../../src/goexplore.js');
	const RM = GX.roomOf(L);
	const r0 = T.playTo(L, new Uint8Array(0));
	const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0, leg: null });
	const S0 = model.stateOf(r0.sim);
	const anchor = { arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 };
	const lb = planner.lowerBound(anchor, { ms: 3000 });
	console.log('lowerBound', JSON.stringify(lb));
	const ps = planner.plan(anchor, { k: opt('k', 6), ms: opt('ms', 4000) });
	console.log('why', ps.why, 'plans', ps.length);
	for (const p of ps) console.log(`${p.id} cost ${p.cost} lb ${p.lb} partial ${p.partial} ${p.why}\n   ${p.steps.map((s) => `${s.waypoint && s.waypoint.label}[lb ${s.lb} est ${s.est}]`).join(' -> ')}`);
	process.exit(0);
})();
