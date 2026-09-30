'use strict';
// T-PLAN-ORACLE (n4u-order, the compiler's plan oracle): does a plan of the compiler's planner contain the level's
// NECESSARY triggers (the landmarks of the delete relaxation, tools/n4u/order/lib.js: sound, validated on the known
// routes) in a COMPATIBLE order (every pair [A, B] of the oracle's order: A achieved no later than B)?
//
// usage: node test/planoracle.js [--oracle=<oracle.json>] [--limit=N] [--shard=i/n] [--only=<name part>] [--ms=1500]
//        [--k=3] [--sets=campaign,hard,d4] [--routes] [--json=<out.json>]
//   --oracle: default <EEAT_TRUTH_ROOT or this repo>/src/out/n4plan/understand/order/oracle.json
//   --routes: also the oracle's self-check (every known route satisfies its level's oracle: 0 missing, 0 violations)
// Checks per level (the planner of this tree: src/plan/model.js + facts.js + planner.js; plan({}, {k, ms})):
//   T-PLAN-ORACLE-LM   a COMPLETE plan (ends at the trophy) achieves every landmark (loose relaxation: always sound)
//   T-PLAN-ORACLE-ORD  no plan (complete or partial) achieves B before A for an order pair [A, B]
//   (informational) the tight relaxation's landmarks (killers deadly unless protected), the plan's first-5 landmark
//   order vs the known route's (levels with a route), the planner's time
// Exit 1 when a check fails. The plans are the planner's as it stands: a failure is the planner's (or the model's)
// bug, the oracle's facts are proven for the relaxation and checked against every known route (--routes).
const fs = require('fs');
const path = require('path');

const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const has = (k) => process.argv.includes(`--${k}`);
const root = path.resolve(process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..'));
const oracleFile = argOf('oracle', path.join(root, 'src', 'out', 'n4plan', 'understand', 'order', 'oracle.json'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };

if (!fs.existsSync(oracleFile)) { console.log(`(no oracle at ${oracleFile}: build it with tools/n4u/order/build.js + merge.js, or set EEAT_TRUTH_ROOT)`); process.exit(0); }
const ORC = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
const O = require('../tools/n4u/order/lib.js');
const T = require('../src/plan/types.js');
let M = null, F = null, P = null;
try { M = require('../src/plan/model.js'); F = require('../src/plan/facts.js'); P = require('../src/plan/planner.js'); } catch (e) { console.log(`(no planner in this tree: ${e.message}); the route self-check only`); }

// ---------------------------------------------------------------- the oracle's self-check on the known routes
if (has('routes')) {
	let n = 0, miss = 0, viol = 0, stale = 0, tmiss = 0, tviol = 0;
	const bad = [];
	for (const r of ORC.routes || []) {
		if (r.stale) { stale++; continue; }
		n++;
		if (r.check && r.check.missing.length) { miss++; bad.push(`${r.name}: missing ${r.check.missing.join(',')}`); }
		if (r.check && r.check.violations.length) { viol++; bad.push(`${r.name}: order ${r.check.violations.slice(0, 3).map((v) => v.slice(0, 2).join('<')).join(' ')}`); }
		if (r.tcheck && r.tcheck.missing.length) tmiss++;
		if (r.tcheck && r.tcheck.violations.length) tviol++;
	}
	for (const b of bad.slice(0, 20)) console.log('   ' + b);
	check('T-ORACLE-SOUND: every known route achieves its level\'s loose landmarks', miss === 0, `${miss} of ${n} routes miss one (${stale} stale)`);
	check('T-ORACLE-SOUND: every known route keeps the loose order pairs', viol === 0, `${viol} of ${n} routes`);
	console.log(`     (tight relaxation: ${tmiss} routes miss a landmark, ${tviol} break an order pair: informational)`);
}

// ---------------------------------------------------------------- the planner's plans
if (P) {
	const limit = +argOf('limit', 0) || Infinity;
	const [si, sn] = String(argOf('shard', '0/1')).split('/').map(Number);
	const only = argOf('only', '');
	const sets = new Set(String(argOf('sets', 'campaign,hard,d4')).split(','));
	const ms = +argOf('ms', 1500), k = +argOf('k', 3);
	const levels = (ORC.levels || []).filter((l, i) => i % sn === si && sets.has(l.set) && (!only || l.name.toLowerCase().includes(only.toLowerCase()))).slice(0, limit);
	const routeOf = new Map();
	for (const r of ORC.routes || []) if (!r.stale && r.check && !routeOf.has(r.name)) routeOf.set(r.name, r);
	const tot = { levels: 0, withLm: 0, plans: 0, complete: 0, lmMiss: 0, ordViol: 0, noPlan: 0, cover: 0, coverN: 0, agree: 0, agreeN: 0, tMiss: 0, ms: 0 };
	const bad = [], rows = [];
	for (const lv of levels) {
		const orc = lv.orc;
		if (!orc || !orc.landmarks) continue;
		tot.levels++;
		if (orc.landmarks.length) tot.withLm++;
		const t0 = Date.now();
		let plans = [], err = null;
		try {
			const L = T.loadLevelFile(path.join(root, lv.file));
			const model = M.compileModel(L, { file: lv.file });
			const planner = P.createPlanner(model, F.createFacts({}), {});
			plans = planner.plan({}, { k, ms });
			const row = { name: lv.name, lm: orc.landmarks.length, plans: [] };
			if (!plans.length) { tot.noPlan++; row.why = plans.why; }
			for (const pl of plans) {
				tot.plans++;
				const c = O.checkPlan(orc, model, pl);
				const tc = orc.tight && orc.tight.landmarks ? O.checkPlan(orc.tight, model, pl) : null;
				if (c.complete) tot.complete++;
				if (c.missing.length) { tot.lmMiss++; if (bad.length < 40) bad.push(`${lv.name} ${pl.id}: complete plan misses ${c.missing.slice(0, 4).join(',')}`); }
				if (c.violations.length) { tot.ordViol++; if (bad.length < 40) bad.push(`${lv.name} ${pl.id}: order ${c.violations.slice(0, 3).map((v) => v.join('<')).join(' ')}`); }
				if (tc && tc.complete && tc.missing.length) tot.tMiss++;
				if (orc.landmarks.length) { tot.cover += c.coverage; tot.coverN++; }
				row.plans.push({ id: pl.id, complete: c.complete, steps: pl.steps.length, cost: pl.cost, lb: pl.lb, missing: c.missing, missingPartial: c.missingPartial.length, violations: c.violations.length, coverage: +c.coverage.toFixed(3) });
			}
			// the plan's landmark order vs the route's (first 5 landmarks)
			const rt = routeOf.get(lv.name);
			if (rt && plans[0] && orc.landmarks.length) {
				const mine = O.checkPlan(orc, model, plans[0]).planOrder.filter((f) => orc.landmarks.some((l) => l.f === f)).slice(0, 5);
				const theirs = rt.check.routeLandmarkOrder.slice(0, 5);
				const n = Math.min(mine.length, theirs.length);
				for (let i = 0; i < n; i++) { tot.agreeN++; if (mine[i] === theirs[i]) tot.agree++; }
				row.routeOrder = theirs; row.planOrder = mine;
			}
			rows.push(row);
		} catch (e) { err = String(e && e.stack || e).slice(0, 300); tot.noPlan++; rows.push({ name: lv.name, err }); }
		const dt = Date.now() - t0;
		tot.ms += dt;
		console.log(`  ${lv.set}/${lv.name}: lm ${orc.landmarks.length}, plans ${plans.length}${plans.length ? ` (complete ${plans.filter((p) => !p.partial).length})` : ` why ${plans.why || err}`}, ${dt} ms`);
	}
	for (const b of bad) console.log('   ' + b);
	console.log(`  totals ${JSON.stringify(tot)}; mean landmark coverage ${(tot.coverN ? tot.cover / tot.coverN : 1).toFixed(3)}; first-5 landmark order agreement with the routes ${tot.agreeN ? (100 * tot.agree / tot.agreeN).toFixed(1) : 'n/a'}%`);
	check('T-PLAN-ORACLE-LM: every complete plan achieves the level\'s landmarks', tot.lmMiss === 0, `${tot.lmMiss} of ${tot.complete} complete plans miss one`);
	check('T-PLAN-ORACLE-ORD: no plan breaks an order pair', tot.ordViol === 0, `${tot.ordViol} of ${tot.plans} plans`);
	console.log(`     (informational: ${tot.tMiss} complete plans miss a TIGHT landmark; ${tot.noPlan} levels without a plan)`);
	const js = argOf('json', '');
	if (js) fs.writeFileSync(js, JSON.stringify({ tot, rows }, null, 1));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
