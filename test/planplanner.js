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
const { LEVELS, level } = require('./planmodel.js');

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
	// the strategy's 4 budget rungs (createFacts({rungs: 4})): out after at most 4 failures, no triple twice
	{
		const f5 = F.createFacts({ rungs: 4 }), p5 = P.createPlanner(m, f5, {});
		const seen5 = new Set();
		let gone5 = -1, dup5 = 0;
		for (let r = 0; r < 8; r++) {
			const s = (p5.plan({}, { k: 1 })[0] || { steps: [] }).steps[0];
			if (!s || s.edge !== 'trig:0') { gone5 = r; break; }
			const trip = `${s.edge}|${s.nodeClass}|${s.rung}`;
			if (seen5.has(trip)) dup5++;
			seen5.add(trip);
			p5.learn(s, { ok: false, arrivals: [], fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: s.rung } }, {});
		}
		check('T-CEGAR-PROGRESS: with 4 rungs (the strategy\'s) the edge is out after 4 failures, rungs 0-3, no triple twice', gone5 === 4 && dup5 === 0, `gone at ${gone5}`);
	}
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
		// (the ball's tile at every tick: a press queued while the ball overlapped a door it closes, a team change
		// retried, a key queued fire a tick or more after the touch: the trigger is where the ball was up to 8 ticks before)
		const tileAt = new Int32Array(tr.masks.length + 2);
		{ const E = require('../src/eesim.js'), sim = new E.EESim(L), inp = new E.EEInput(); sim.reset(); tileAt[0] = T.tileOf(sim, W, L.height); for (let t = 0; t < tr.masks.length; t++) { E.applyMask(inp, tr.masks[t] & 31); sim.tick(inp); tileAt[t + 1] = T.tileOf(sim, W, L.height); } }
		const order = [], ticks = [];
		for (const x of S.orderOf(ev.events, { all: true })) {
			if (!(m.featSet.has(x.feat) || (x.feat === 'cp' && m.cpTracked)) || (x.feat.startsWith('key') && x.value === 0) || x.feat === 'deaths') continue;
			let id = -1, at = x.tick;
			for (let back = 0; back <= 8 && id < 0; back++) {
				const tb = back === 0 ? x.tile : tileAt[Math.max(0, x.tick - back)];
				const x0 = tb % W, y0 = (tb / W) | 0;
				for (let r = 0; r <= 1 && id < 0; r++) for (let dy = -r; dy <= r && id < 0; dy++) for (let dx = -r; dx <= r && id < 0; dx++) {
					const nx = x0 + dx, ny = y0 + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= L.height) continue;
					const k = m.trigOf[ny * W + nx];
					// (a reset switch only turns an id off: a press that turned it on is no reset's)
					const K = k >= 0 ? m.triggers[k] : null;
					const dirOK = !K || !((K.kind === 'pswR' || K.kind === 'oswR') && x.value === 1);
					if (K && K.relevant && dirOK && (K.feat === x.feat || (K.feat || '').endsWith(':*') || (K.kind === 'reset' && x.feat === 'prot'))) { id = k; at = Math.max(0, x.tick - back); }
				}
			}
			if (id >= 0) { order.push(id); ticks.push(at); }
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
		// mid-route anchors (the strategy's arrivals: its B&B drops by their lb): right after sampled events (a deferred
		// press pending there) and a few ticks later; lowerBound <= the ticks the route still took
		{
			const cand = [];
			for (const t of ticks) { cand.push(t + 1); cand.push(t + 4); }
			const nA = +argOf('anchors', 6);
			const stepA = Math.max(1, Math.floor(cand.length / nA));
			for (let i = 0; i < cand.length; i += stepA) {
				const t = cand[i];
				if (t <= 0 || t >= tr.complete) continue;
				const pre = tr.masks.subarray(0, t);
				const r = T.playTo(L, pre, { allowDeath: true });
				if (r.sim.is_dead) continue;
				const arr = T.arrivalOf(L, r.sim, pre, null);
				const lbA = pl.lowerBound({ arrival: arr, arrivals: [arr], S: m.stateOf(r.sim) }, { ms: +argOf('lbams', 300) });
				tot.anchorChecks = (tot.anchorChecks || 0) + 1;
				if (lbA.ticks > tr.complete - t) { tot.anchorViol = (tot.anchorViol || 0) + 1; viol.push(`anchor lb ${lbA.ticks} > ${tr.complete - t} ticks left at ${t}: ${e.name}`); }
			}
		}
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
	// (for the shards' sum: the ratios and the counts as one JSON line)
	console.log(`  JSON ${JSON.stringify({ ratios, tot })}`);
	console.log(`  totals ${JSON.stringify(tot)} lb/run median ${med.toFixed(3)} (p10 ${(ratios[Math.floor(ratios.length * 0.1)] || 0).toFixed(3)}, p90 ${(ratios[Math.floor(ratios.length * 0.9)] || 0).toFixed(3)})`);
	check('T-PLAN-FEASIBLE: every route\'s own order feasible in the model', tot.infeasible === 0, `${tot.infeasible} of ${tot.routes} (${tot.stale} stale)`);
	check('T-PLAN-FEASIBLE: costOf lb <= run ticks (admissible)', tot.costViol === 0, `${tot.costViol} violations`);
	check('T-PLAN-FEASIBLE: every leg lb <= its ticks', tot.legViol === 0, `${tot.legViol} of ${tot.legs} legs`);
	check('T-PLAN-FEASIBLE: lowerBound(mid-route anchors) <= the ticks left (admissible)', !tot.anchorViol, `${tot.anchorViol || 0} of ${tot.anchorChecks || 0}`);
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
			console.log(`    Cold World: the first plan's blue coin step: ${bIdx} (the relaxations (the walk, RCH3, the ordering field) reach the trophy from the start through chapter 1's pool, the false near)`);
			// CEGAR: the product's searches pin in chapter 1's pool ((227,151): the closest approach of every run); a mock
			// executor fails every step past the pool there: the planner must turn to the chapter-2 blue coin
			const W = L.width, pin = 227 + 151 * W;
			const f2 = F.createFacts({ rungs: 4 }), p2 = P.createPlanner(m, f2, {});
			let turned = -1, lastP = null;
			for (let r = 0; r < 16 && turned < 0; r++) {
				const q = p2.plan({}, { k: 1, ms: 1500 })[0];
				if (!q) break;
				lastP = q;
				const s0 = q.steps[0];
				const X = s0.waypoint.kind === 'trigger' ? m.triggers[s0.waypoint.trig] : null;
				if (X && X.kind === 'bcoin' && (X.tiles[0] / W | 0) > 150) { turned = r; break; }
				const tt = X ? X.tiles[0] : m.trophyTiles[0], tx = tt % W, ty = (tt / W) | 0;
				if (!(s0.waypoint.kind === 'trophy' || (tx >= 270 && ty >= 75 && ty <= 100))) break;
				p2.learn(s0, { ok: false, arrivals: [], fail: { why: 'exhausted', closest: { tile: pin, dist: 35 }, touched: [], blockedBy: [], level: s0.rung } }, {});
			}
			console.log(`    Cold World after the pool's failures: ${lastP ? planStr(m, lastP).slice(0, 400) : 'none'}`);
			check('T-SCALE Cold World: CEGAR at the pool pin turns the plan to the chapter-2 blue coin first', turned >= 0, `round ${turned}`);
		}
		if (/bad_ee_level_9/i.test(name)) {
			const p = plans[0];
			const nsw = p ? p.steps.filter((s) => s.waypoint.kind === 'trigger' && m.triggers[s.waypoint.trig].kind === 'psw').length : 0;
			check('T-SCALE Bad EE Level 9: a plan through the switch waves (partial allowed)', nsw >= 4, `${nsw} switch steps`);
		}
		check(`T-SCALE ${name}: model + first plan under 5 s`, t2 - t0 < 5000, `${t2 - t0} ms`);
	}
}

/** P-CRUMBS (doctor 9, EEAT_CRUMBS=1): coins no gate reads are crumbs (state features, X.crumb), left out of the plan
 *  search, the nearest one offered as a plan in front when the trophy's leg is long; off: the model and plans as before */
function crumbsUnit() {
	const mk = () => level([
		'######################################################################',
		'#....................................................................#',
		'#S.......c...................c...................c.................T.#',
		'######################################################################',
	], { c: [100] });
	const L = mk();
	const saved = process.env.EEAT_CRUMBS;
	try {
		delete process.env.EEAT_CRUMBS;
		const m0 = M.compileModel(L), p0 = P.createPlanner(m0, F.createFacts(), {}).plan({}, { k: 3 });
		check('P-CRUMBS off: coins not relevant, no crumbs, the first plan the trophy alone', !m0.feats.includes('coins') && !m0.triggers.some((X) => X.crumb) && p0[0] && kindsOf(m0, p0[0]).join(',') === 'trophy', planStr(m0, p0[0]));
		process.env.EEAT_CRUMBS = '1';
		// (the crumbs wait for one failed rung of the long leg (EEAT_CRUMB_AFTER 1): none before)
		{
			const mA = M.compileModel(L), plA = P.createPlanner(mA, F.createFacts(), {}), pA = plA.plan({}, { k: 3 });
			check('P-CRUMBS on: no crumb plan before the long leg failed a rung', pA.length && !pA.some((p) => p.crumb), planStr(mA, pA[0]));
			const s0 = pA[0].steps[0];
			plA.learn(s0, { ok: false, arrivals: [], fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: s0.rung } }, {});
			const pB = plA.plan({}, { k: 3 });
			check('P-CRUMBS on: after the trophy leg failed its rung 0, the crumb plans come first', pB.length && pB[0].crumb, pB[0] ? planStr(mA, pB[0]) : 'none');
		}
		process.env.EEAT_CRUMB_AFTER = '0';
		const m1 = M.compileModel(L), pl = P.createPlanner(m1, F.createFacts(), {}), p1 = pl.plan({}, { k: 3 });
		const cr = m1.triggers.filter((X) => X.crumb);
		check('P-CRUMBS on: 3 crumbs, coins a feature, relevant', m1.feats.includes('coins') && cr.length === 3 && cr.every((X) => X.relevant), `${cr.length} crumbs, feats ${m1.feats.join(',')}`);
		const c0 = p1[0], near = cr.slice().sort((a, b) => a.tiles[0] % L.width - b.tiles[0] % L.width)[0];
		check('P-CRUMBS on: the crumb plan first, to the nearest crumb, one step', c0 && c0.crumb && c0.steps.length === 1 && c0.steps[0].waypoint.trig === near.id, c0 ? planStr(m1, c0) : 'none');
		const own = p1.find((p) => !p.crumb), nCr = p1.filter((p) => p.crumb).length;
		check('P-CRUMBS on: 2 crumb plans (EEAT_CRUMB_K), then the plan search own plans (the trophy alone: crumbs left out)', nCr === 2 && p1[1].crumb && own && kindsOf(m1, own).join(',') === 'trophy', `${nCr} crumb plans; ${own ? planStr(m1, own) : 'none'}`);
		// from the nearest crumb's arrival (a gain of 1) the crumb plan goes to the next one
		let t = 0; const masks = [];
		for (; t < 400; t++) { masks.push(4); const r = T.playTo(L, Uint8Array.from(masks)); if (r.sim.coins >= 1) break; }
		const A = anchorAfter(L, m1, Uint8Array.from(masks));
		const p2 = pl.plan(A, { k: 3 });
		const second = cr.slice().sort((a, b) => a.tiles[0] % L.width - b.tiles[0] % L.width)[1];
		check('P-CRUMBS on: from the first crumb (gain > 0: its count and its tile) the crumb plan takes the next crumb', A.S.gain > 0 && p2[0] && p2[0].crumb && p2[0].steps[0].waypoint.trig === second.id, p2[0] ? `gain ${A.S.gain}: ${planStr(m1, p2[0])}` : 'none');
	} finally {
		if (saved === undefined) delete process.env.EEAT_CRUMBS; else process.env.EEAT_CRUMBS = saved;
		delete process.env.EEAT_CRUMB_AFTER;
	}
}

/** THE FAR NEAR PLAN (planner.js nearPlans, EEAT_NEAR_FAR): the trophy 3 tiles from the spawn (a small lb: the false near's
 *  shape) and a red key (its door by the right wall) 7 tiles back: after the trophy's first leg fails, no trigger is nearer
 *  by the lb, so no near plan; with EEAT_NEAR_FAR=1 the key is offered as a one-step near plan at rung 0 */
function nearFar() {
	const { level } = require('./planmodel.js');
	const L = level([
		'################',
		'#k......S..T..d#',
		'################',
	], { k: [6], d: [23] });
	const run = (on) => {
		if (on) process.env.EEAT_NEAR_FAR = '1'; else delete process.env.EEAT_NEAR_FAR;
		const m = M.compileModel(L), facts = F.createFacts({ rungs: 4 }), pl = P.createPlanner(m, facts, {});
		const p0 = pl.plan({}, { k: 1 });
		const s0 = p0[0] && p0[0].steps[0];
		if (s0) pl.learn(s0, { ok: false, arrivals: [], fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: 0 } }, {});
		const p1 = pl.plan({}, { k: 1 });
		delete process.env.EEAT_NEAR_FAR;
		return { p0, p1, s0 };
	};
	const off = run(false), on = run(true);
	const str = (ps) => ps.map((p) => `${p.near ? 'NEAR ' : ''}${p.steps.map((s) => `${s.waypoint.label}[r${s.rung}]`).join(' -> ')}`).join(' | ');
	check('P-NEARFAR: the first plan is the trophy alone (the false near: its lb below the key\'s)', !!off.s0 && off.s0.waypoint.kind === 'trophy', str(off.p0));
	check('P-NEARFAR off: after the trophy\'s rung 0 failed, no near plan (no trigger nearer by the lb): the trophy at rung 1', off.p1.length >= 1 && !off.p1.some((p) => p.near) && off.p1[0].steps[0].waypoint.kind === 'trophy' && off.p1[0].steps[0].rung === 1, str(off.p1));
	check('P-NEARFAR on: the key offered first as a one-step near plan at rung 0, the trophy\'s plan after it (ordering only)',
		on.p1.length >= 2 && on.p1[0].near && on.p1[0].steps.length === 1 && on.p1[0].steps[0].waypoint.kind === 'trigger' && on.p1[0].steps[0].rung === 0 && on.p1.some((p) => !p.near && p.steps[0].waypoint.kind === 'trophy'), str(on.p1));
}

if (require.main === module) {
	units();
	cegar();
	crumbsUnit();
	nearFar();
	if (process.argv.includes('--truth')) truth();
	if (process.argv.includes('--scale')) scale();
	console.log(`${pass}/${pass + fail}`);
	process.exitCode = fail ? 1 : 0;
}
