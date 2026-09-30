// tools/cmp/stageprof.js: the compiler's bounds + plan stages, each part timed alone (lane 6's profile of STAGE-TIME).
// node tools/cmp/stageprof.js <level.eelvl>...   (one JSON line a level; PROF_PLAN_MS = the first plan's budget, 2000)
// The parts in strategy.js's order: model, bounds (createBounds), facts, the planner (its floor probe), roomOf, the start,
// the planner's lowerBound (EEAT_LB0_MS, 500 ms: strategy.js LB0_MS), idleRunLB (bounds.leg on the idle trajectory), the first plan.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const E = require(path.join(root, 'src/eesim.js'));
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const B = require(path.join(root, 'src/plan/bounds.js'));
const F = require(path.join(root, 'src/plan/facts.js'));
const P = require(path.join(root, 'src/plan/planner.js'));
const GX = require(path.join(root, 'src/goexplore.js'));
const planMs = +(process.env.PROF_PLAN_MS || 2000);
for (const file of process.argv.slice(2)) {
	const r = { level: path.basename(file).replace(/\.eelvl$/, '') };
	let t = Date.now();
	const lap = (k) => { const n = Date.now(); r[k] = n - t; t = n; };
	try {
		const L = T.loadLevelFile(file); lap('load');
		r.WH = `${L.width}x${L.height}`;
		const model = M.compileModel(L, { file }); lap('model');
		B.staticOf(L); lap('static');
		const bounds = B.createBounds(L, { model }); lap('createBounds');
		const facts = F.createFacts({ rungs: 4, model }); lap('facts');
		const planner = P.createPlanner(model, facts, { bounds, file, floorAsync: process.env.EEAT_PLAN_FLOOR_ASYNC !== '0' }); lap('createPlanner');
		const pst = planner.stats ? planner.stats() : {};
		r.floorMs = pst.floorMs; r.floors = pst.floors;
		const RM = GX.roomOf(L); lap('roomOf');
		const r0 = T.playTo(L, new Uint8Array(0));
		const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0, leg: null });
		const S0 = model.stateOf(r0.sim); lap('start');
		const bs0 = bounds.stats();
		const A = { arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 };
		const lb = planner.lowerBound(A, { ms: +process.env.EEAT_LB0_MS || 500 }); lap('lowerBound');
		const bs1 = bounds.stats();
		r.lbTicks = lb && lb.ticks; r.lbComplete = lb && lb.complete; r.lbFields = bs1.fields - bs0.fields; r.lbFieldMs = bs1.ms - bs0.ms;
		r.idleLB = require(path.join(root, 'src/plan/strategy.js')).idleRunLB(L, bounds, T.goalOf(L, { kind: 'trophy', label: 'trophy' }));
		lap('idleRunLB');
		const bs2 = bounds.stats(); r.idleFields = bs2.fields - bs1.fields; r.idleFieldMs = bs2.ms - bs1.ms;
		const pr = planner.plan(A, { k: 3, depth: Infinity, runBound: Infinity, tickBound: Infinity, epoch: 0, ms: planMs }); lap('plan');
		const bs3 = bounds.stats(); r.planFields = bs3.fields - bs2.fields; r.planFieldMs = bs3.ms - bs2.ms;
		const pl = Array.isArray(pr) ? pr : (pr && pr.plans) || [];
		r.planWhy = (pr && pr.why) || ''; r.nPlans = pl.length; r.steps = pl[0] ? pl[0].steps.length : 0; r.est = pl[0] ? pl[0].cost : null;
		const ps = planner.stats(); r.expands = ps.expands; r.pl = { lbCalls: ps.lbCalls, lbMs: ps.lbMs, lbExpands: ps.lbExpands, costOf: ps.costOf };
		r.floorProbe = planner.stats().floorProbe || null;
		r.boundsStage = r.createBounds + r.static + r.facts + r.createPlanner + r.roomOf + r.start + r.lowerBound + r.idleRunLB;
	} catch (e) { r.err = e.stack.split('\n').slice(0, 3).join(' | '); }
	process.stdout.write(JSON.stringify(r) + '\n');
}
