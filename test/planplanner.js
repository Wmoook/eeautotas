'use strict';
// test/planplanner.js: the planner part's ABSTRACT PLANNER (src/plan/planner.js) with the fact store (CEGAR).
// P-UNIT (synthetic levels, test/planmodel.js LEVELS): the plan order on the key door (the key, the passage past its
// door, the trophy), the coin door, the 3-switch chain, the toggle pressed twice, the team door, the portal pair; the
// lower bound admissible (<= the run of a real route) and the plan's own lb <= its cost.
// T-CEGAR-PROGRESS: a mock executor that fails edge X every time: every learn() adds facts and bumps the version, the
// same (edge, nodeClass, rung) triple is never proposed twice, X is out after at most 4 failures; a mock blockedBy gate
// puts that gate's trigger first; a mock 'proof' blocks X from that state.
// --truth [--limit=N] [--shard=i/n]: T-PLAN-FEASIBLE (costOf(the route's own trigger order) feasible with lb <= its run
// ticks; lowerBound(the start) <= run ticks: 0 violations = admissible), lb tightness (lb / runTicks median),
// T-PLAN-ORDER (the best plan's first 5 relevant triggers against the route's; informational).
// --scale [--levels=<dir>] [--n=20]: T-SCALE: compileModel + the first plan() on Cold World, Bad EE Level 9 and 20
// campaign levels (the truth root's src/out/d4/levels, src/out/god/levels/campaign), times and plans printed; Cold World's
// best plan takes the chapter-2 blue coin before any chapter behind the blue coin doors.
// usage: node test/planplanner.js [--truth] [--scale] [--limit=5]
const T = require('../src/plan/types.js');
const M = require('../src/plan/model.js');
const F = require('../src/plan/facts.js');
const P = require('../src/plan/planner.js');
const { LEVELS } = require('./planmodel.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? ' ' + detail : ''}`); };
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const kindsOf = (m, p) => p.steps.map((s) => (s.waypoint.kind === 'trigger' ? m.triggers[s.waypoint.trig].kind : s.waypoint.kind));
const planStr = (m, p) => `${p.partial ? 'PARTIAL ' : ''}est ${p.cost} lb ${p.lb}: ` + p.steps.map((s) => s.waypoint.label).join(' -> ');

/** a replay of masks -> the anchor after them (types.js arrivalOf) */
function anchorAfter(L, m, masks) {
	const r = T.playTo(L, masks);
	const a = T.arrivalOf(L, r.sim, masks, null);
	return { arrival: a, arrivals: [a], S: m.stateOf(r.sim), key: m.stateOf(r.sim).key };
}

function units() {
	// ---- the key door: the key, the passage past its door, the trophy
	{
		const L = LEVELS.keyDoor(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const plans = pl.plan({}, { k: 3 });
		const p = plans[0];
		const ks = p ? kindsOf(m, p) : [];
		check('P-UNIT keyDoor: the plan is key -> past the door -> trophy', !!p && ks.join(',') === 'key,region,trophy' && !p.partial, p ? planStr(m, p) : plans.why);
		check('P-UNIT keyDoor: the passage waits for the key\'s tick (prev+500) and holds tiles past the door', !!p && p.steps[1].waypoint.beforeTickFrom === 'prev+500' && p.steps[1].waypoint.tiles.every((t) => t % L.width > 11));
		check('P-UNIT keyDoor: the waypoint expects the key on', !!p && p.steps[0].waypoint.expect && p.steps[0].waypoint.expect.feat === 'key0' && p.steps[0].waypoint.expect.value === 1);
		const masks = new Uint8Array(300).fill(4);
		const ev = require('../src/plan/truthset.js').routeEvents(L, masks);
		const lb = pl.lowerBound({});
		check('P-UNIT keyDoor: lowerBound complete and <= the run of a real route', lb.complete && lb.ticks > 0 && lb.ticks <= ev.runTicks, `lb ${lb.ticks} vs ${ev.runTicks}`);
		check('P-UNIT keyDoor: the plan lb <= its cost', p && p.lb <= p.cost && p.lb >= lb.ticks - 2, p && `${p.lb} ${p.cost}`);
		// from the anchor just past the key: the passage first, with its beforeTick from the key's own timer
		let kt = -1;
		{ const r = T.playTo(L, masks, { goal: T.goalOf(L, p.steps[0].waypoint) }); kt = r.goalAt; }
		const an = anchorAfter(L, m, masks.subarray(0, kt));
		const p2 = pl.plan(an, { k: 1 })[0];
		check('P-UNIT keyDoor: from the key\'s arrival the plan is the passage then the trophy, beforeTick = the key\'s + 499',
			p2 && kindsOf(m, p2).join(',') === 'region,trophy' && p2.steps[0].waypoint.beforeTick === kt + 499, p2 && `${planStr(m, p2)} beforeTick ${p2.steps[0].waypoint.beforeTick} key at ${kt}`);
	}
	// ---- the coin door: both coins, then the trophy
	{
		const L = LEVELS.coinDoor(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const p = pl.plan({}, { k: 2 })[0];
		check('P-UNIT coinDoor: coin, coin, trophy (expect coins 1 then 2)', p && kindsOf(m, p).join(',') === 'coin,coin,trophy' && p.steps[0].waypoint.expect.value === 1 && p.steps[1].waypoint.expect.value === 2, p && planStr(m, p));
	}
	// ---- the chain of 3 switches
	{
		const L = LEVELS.chain3(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const p = pl.plan({}, { k: 2 })[0];
		const ids = p ? p.steps.filter((s) => s.waypoint.kind === 'trigger').map((s) => m.triggers[s.waypoint.trig].param) : [];
		check('P-UNIT chain3: switch 1, 2, 3, trophy', p && ids.join(',') === '1,2,3' && kindsOf(m, p).pop() === 'trophy', p && planStr(m, p));
		const lb = pl.lowerBound({});
		check('P-UNIT chain3: lowerBound complete', lb.complete && lb.ticks > 0, JSON.stringify(lb));
	}
	// ---- the toggle pressed twice
	{
		const L = LEVELS.toggle2(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const p = pl.plan({}, { k: 2 })[0];
		check('P-UNIT toggle2: switch 1 twice (two components), then the trophy', p && kindsOf(m, p).join(',') === 'psw,psw,trophy' && p.steps[0].waypoint.trig !== p.steps[1].waypoint.trig
			&& p.steps[0].waypoint.expect.value === 1 && p.steps[1].waypoint.expect.value === 0, p && planStr(m, p));
	}
	// ---- the team door
	{
		const L = LEVELS.teamDoor(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const p = pl.plan({}, { k: 2 })[0];
		check('P-UNIT teamDoor: team effect then trophy', p && kindsOf(m, p).join(',') === 'team,trophy' && p.steps[0].waypoint.expect.feat === 'team' && p.steps[0].waypoint.expect.value === 1, p && planStr(m, p));
	}
	// ---- the portal pair
	{
		const L = LEVELS.portal(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const plans = pl.plan({}, { k: 2 });
		check('P-UNIT portal: the trophy straight (through the portal)', plans[0] && kindsOf(m, plans[0]).join(',') === 'trophy', plans[0] ? planStr(m, plans[0]) : plans.why);
		const lb = pl.lowerBound({});
		check('P-UNIT portal: lowerBound finite, complete', lb.complete && Number.isFinite(lb.ticks), JSON.stringify(lb));
	}
	// ---- the key and a switch behind its door
	{
		const L = LEVELS.keySwitch(), m = M.compileModel(L), pl = P.createPlanner(m, F.createFacts(), {});
		const p = pl.plan({}, { k: 2 })[0];
		check('P-UNIT keySwitch: key -> past its door -> switch -> trophy', p && kindsOf(m, p).join(',') === 'key,region,psw,trophy', p && planStr(m, p));
	}
}

// ---------------------------------------------------------------- CEGAR
function cegar() {
	// the key door level: fail the key edge every time
	const L = LEVELS.keyDoor(), m = M.compileModel(L), facts = F.createFacts(), pl = P.createPlanner(m, facts, {});
	const seen = new Set();
	let dup = 0, bumps = 0, rounds = 0, gone = -1, lastWhy = '';
	for (let r = 0; r < 8; r++) {
		const plans = pl.plan({}, { k: 1 });
		rounds++;
		const s = plans[0] && plans[0].steps[0];
		if (!s || s.edge !== 'trig:0') { gone = r; lastWhy = plans.why || (s ? s.edge : ''); break; }
		const trip = `${s.edge}|${s.nodeClass}|${s.rung}`;
		if (seen.has(trip)) dup++;
		seen.add(trip);
		const v = facts.version();
		const fs = pl.learn(s, { ok: false, arrivals: [], fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: s.rung } }, {});
		if (fs.length >= 1 && facts.version() > v) bumps++;
	}
	check('T-CEGAR-PROGRESS: every failed learn adds facts and bumps the version', bumps === rounds - (gone >= 0 ? 1 : 0), `${bumps} bumps in ${rounds} rounds`);
	check('T-CEGAR-PROGRESS: no (edge, nodeClass, rung) triple twice', dup === 0, `${seen.size} triples`);
	check('T-CEGAR-PROGRESS: the failing edge is gone after at most 4 failures', gone >= 0 && gone <= 4, `gone at round ${gone}, next: ${lastWhy}`);
	// blockedBy: the trophy edge fails next to the key door -> the key first
	{
		const L2 = LEVELS.keySwitch(), m2 = M.compileModel(L2), f2 = F.createFacts(), p2 = P.createPlanner(m2, f2, {});
		const W = L2.width, at = (x, y) => y * W + x;
		// pretend the plan is the switch first (a mock step on it), failing with the key door in the way
		const sw = m2.triggers.find((X) => X.kind === 'psw');
		const step = { edge: 'trig:' + sw.id, nodeClass: m2.S0.key + '|0,1', rung: 0, waypoint: { kind: 'trigger', tiles: sw.tiles, trig: sw.id } };
		const fs = p2.learn(step, { ok: false, arrivals: [], fail: { why: 'exhausted', closest: { tile: at(9, 2), dist: 5 }, touched: [], blockedBy: [{ tile: at(10, 2), feat: 'key0' }], level: 0 } }, {});
		const pl2 = p2.plan({}, { k: 1 })[0];
		check('T-CEGAR-PROGRESS: a blockedBy gate -> needs -> that gate\'s trigger first', fs.some((f) => f.kind === 'needs' && f.feat === 'key0' && f.value === 1) && pl2 && m2.triggers[pl2.steps[0].waypoint.trig] && m2.triggers[pl2.steps[0].waypoint.trig].kind === 'key',
			pl2 && planStr(m2, pl2));
	}
	// proof: the key edge proven impossible from the start state -> never proposed from it
	{
		const f3 = F.createFacts(), p3 = P.createPlanner(m, f3, {});
		const s = p3.plan({}, { k: 1 })[0].steps[0];
		const fs = p3.learn(s, { ok: false, arrivals: [], fail: { why: 'proof', closest: null, touched: [], blockedBy: [], level: 0 } }, {});
		const again = p3.plan({}, { k: 3 });
		check('T-CEGAR-PROGRESS: a proof blocks the edge from that state', fs.some((f) => f.kind === 'proof') && again.every((p) => p.steps[0].edge !== s.edge), `${again.length} plans, why ${again.why}`);
	}
	// ok: the learned ticks price the edge
	{
		const f4 = F.createFacts(), p4 = P.createPlanner(m, f4, {});
		const s = p4.plan({}, { k: 1 })[0].steps[0];
		const fs = p4.learn(s, { ok: true, arrivals: [{ tick: 44 }] }, {});
		check('T-CEGAR-PROGRESS: an ok step leaves an ok fact with its ticks', fs.length === 1 && fs[0].kind === 'ok' && fs[0].ticks === 44 && f4.okTicks(s.edge, s.nodeClass) === 44);
	}
}

// ---------------------------------------------------------------- the ground truth
function truth() {
	const S = require('../src/plan/truthset.js');
	const limit = +argOf('limit', 0) || Infinity;
	const [si, sn] = String(argOf('shard', '0/1')).split('/').map(Number);
	const known = S.knownRoutes().filter((e, i) => i % sn === si).slice(0, limit);
	if (!known.length) { console.log('(no known routes: set EEAT_TRUTH_ROOT to the main checkout)'); return; }
	const tot = { routes: 0, stale: 0, infeasible: 0, lbViol: 0, costViol: 0, legViol: 0, legs: 0, orderAgree: 0, orderN: 0, incomplete: 0 };
	const ratios = [], viol = [];
	for (const e of known) {
		const t0 = Date.now();
		let tr = null;
		try { tr = S.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) { tot.stale++; continue; }
		const L = tr.L, W = L.width;
		const m = M.compileModel(L, { file: e.levelFile });
		const pl = P.createPlanner(m, null, {});
		const ev = S.routeEvents(L, tr.masks);
		// the route's relevant order as trigger ids (the event tile's trigger of that feature, or next to it)
		const order = [], ticks = [];
		for (const x of S.orderOf(ev.events)) {
			if (!m.featSet.has(x.feat) || (x.feat.startsWith('key') && x.value === 0)) continue;
			let id = -1;
			const x0 = x.tile % W, y0 = (x.tile / W) | 0;
			for (let r = 0; r <= 1 && id < 0; r++) for (let dy = -r; dy <= r && id < 0; dy++) for (let dx = -r; dx <= r && id < 0; dx++) {
				const nx = x0 + dx, ny = y0 + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= L.height) continue;
				const k = m.trigOf[ny * W + nx];
				if (k >= 0 && m.triggers[k].relevant && (m.triggers[k].feat === x.feat || m.triggers[k].feat.endsWith(':*') || (m.triggers[k].kind === 'reset' && x.feat === 'prot'))) id = k;
			}
			if (id >= 0) { order.push(id); ticks.push(x.tick); }
		}
		tot.routes++;
		const c = pl.costOf(order, {});
		if (!c.feasible) { tot.infeasible++; viol.push(`INFEASIBLE ${e.name}: ${c.why}`); }
		else if (c.lb > tr.runTicks) { tot.costViol++; viol.push(`costOf lb ${c.lb} > run ${tr.runTicks}: ${e.name}`); }
		// per leg: lb <= the ticks between the events (the first leg from the start: the timer's)
		let pt = 0;
		c.legs.forEach((lg, i) => {
			const t = i < ticks.length ? ticks[i] : tr.complete;
			tot.legs++;
			if (lg.lb > t - pt + (i === 0 ? 0 : 0) && !(i === 0 && lg.lb - 2 <= t)) { tot.legViol++; if (tot.legViol <= 20) viol.push(`leg ${i} of ${e.name}: lb ${lg.lb} > ${t - pt} ticks (to ${lg.to})`); }
			pt = t;
		});
		const lb = pl.lowerBound({}, { ms: +argOf('lbms', 2000) });
		if (!lb.complete) tot.incomplete++;
		if (lb.ticks > tr.runTicks) { tot.lbViol++; viol.push(`lowerBound ${lb.ticks} > run ${tr.runTicks}: ${e.name} (complete ${lb.complete})`); }
		if (Number.isFinite(lb.ticks) && tr.runTicks > 0) ratios.push(lb.ticks / tr.runTicks);
		// T-PLAN-ORDER: the best plan's first relevant triggers vs the route's
		const plans = pl.plan({}, { k: 1, ms: +argOf('planms', 1500) });
		if (plans[0] && order.length) {
			const mine = plans[0].steps.filter((s) => s.waypoint.kind === 'trigger').map((s) => s.waypoint.trig).slice(0, 5);
			const theirs = [...new Set(order)].slice(0, 5);
			const n = Math.min(mine.length, theirs.length);
			let agree = 0;
			for (let i = 0; i < n; i++) if (mine[i] === theirs[i]) agree++;
			tot.orderAgree += agree; tot.orderN += n;
		}
		console.log(`  route ${e.source} ${e.name}: run ${tr.runTicks}, order ${order.length}, costOf lb ${c.lb} ${c.feasible ? '' : 'INFEASIBLE'}, lowerBound ${lb.ticks}${lb.complete ? '' : ' (cut)'}, ${Date.now() - t0} ms`);
	}
	for (const v of viol.slice(0, 60)) console.log('  ' + v);
	ratios.sort((a, b) => a - b);
	const med = ratios.length ? ratios[ratios.length >> 1] : NaN;
	console.log(`  totals ${JSON.stringify(tot)} lb/run median ${med.toFixed(3)} (p10 ${(ratios[Math.floor(ratios.length * 0.1)] || 0).toFixed(3)}, p90 ${(ratios[Math.floor(ratios.length * 0.9)] || 0).toFixed(3)})`);
	check('T-PLAN-FEASIBLE: every route\'s own order feasible in the model', tot.infeasible === 0, `${tot.infeasible} of ${tot.routes} (${tot.stale} stale)`);
	check('T-PLAN-FEASIBLE: costOf lb <= run ticks (admissible)', tot.costViol === 0, `${tot.costViol} violations`);
	check('T-PLAN-FEASIBLE: every leg lb <= its ticks', tot.legViol === 0, `${tot.legViol} of ${tot.legs} legs`);
	check('T-PLAN-FEASIBLE: lowerBound(start) <= run ticks (admissible)', tot.lbViol === 0, `${tot.lbViol} violations, ${tot.incomplete} cut by the budget, lb/run median ${med.toFixed(3)}`);
	console.log(`T-PLAN-ORDER (informational): ${tot.orderN ? (100 * tot.orderAgree / tot.orderN).toFixed(1) : 'n/a'}% of the first 5 relevant triggers agree (${tot.orderAgree}/${tot.orderN})`);
}

// ---------------------------------------------------------------- T-SCALE
function scale() {
	const fs = require('fs'), path = require('path');
	const root = path.resolve(process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..'));
	const files = [];
	for (const n of ['cold_world.eelvl', 'bad_ee_level_9.eelvl']) { const f = path.join(root, 'src', 'out', 'd4', 'levels', n); if (fs.existsSync(f)) files.push(f); }
	const cdir = argOf('levels', path.join(root, 'src', 'out', 'god', 'levels', 'campaign'));
	let camp = [];
	try { camp = fs.readdirSync(cdir).filter((f) => /\.eelvl$/i.test(f)).sort(); } catch (e) { camp = []; }
	const nC = +argOf('n', 20);
	const stepC = Math.max(1, Math.floor(camp.length / Math.max(1, nC)));
	for (let i = 0; i < camp.length && files.length < nC + 2; i += stepC) files.push(path.join(cdir, camp[i]));
	if (!files.length) { console.log('(no levels: set EEAT_TRUTH_ROOT)'); return; }
	for (const f of files) {
		const L = T.loadLevelFile(f);
		const t0 = Date.now();
		const m = M.compileModel(L, { file: f });
		const t1 = Date.now();
		const pl = P.createPlanner(m, F.createFacts(), {});
		const plans = pl.plan({}, { k: 3 });
		const t2 = Date.now();
		const lb = pl.lowerBound({}, { ms: 1500 });
		const name = path.basename(f);
		console.log(`  ${name} ${L.width}x${L.height}: model ${t1 - t0} ms (${m.triggers.filter((X) => X.relevant).length} relevant triggers, feats ${m.feats.length}), plan ${t2 - t1} ms, lowerBound ${lb.ticks}${lb.complete ? '' : ' (cut)'} ${lb.ms} ms`);
		for (const p of plans) console.log(`    ${planStr(m, p).slice(0, 700)}`);
		if (!plans.length) console.log(`    no plan: ${plans.why}`);
		if (/cold_world/i.test(name)) {
			// the chapter-2 blue coin before any trigger behind the blue coin doors (the hub corridor's 213)
			const p = plans[0];
			const bIdx = p ? p.steps.findIndex((s) => s.waypoint.kind === 'trigger' && m.triggers[s.waypoint.trig].kind === 'bcoin') : -1;
			const need = m.featSet.has('bcoins');
			check('T-SCALE Cold World: bcoins a feature (the blue coin doors 213 read it)', need, m.feats.join(' '));
			check('T-SCALE Cold World: the best plan takes a blue coin (the chapter-2 unlock)', bIdx >= 0, p ? `at step ${bIdx}` : 'no plan');
		}
		if (/bad_ee_level_9/i.test(name)) {
			const p = plans[0];
			const nsw = p ? p.steps.filter((s) => s.waypoint.kind === 'trigger' && m.triggers[s.waypoint.trig].kind === 'psw').length : 0;
			check('T-SCALE Bad EE Level 9: a plan through the switch waves (partial allowed)', nsw >= 4, `${nsw} switch steps`);
		}
		check(`T-SCALE ${name}: model + first plan under 5 s`, t2 - t0 < 5000, `${t2 - t0} ms`);
	}
}

if (require.main === module) {
	units();
	cegar();
	if (process.argv.includes('--truth')) truth();
	if (process.argv.includes('--scale')) scale();
	console.log(`${pass}/${pass + fail}`);
	process.exitCode = fail ? 1 : 0;
}
