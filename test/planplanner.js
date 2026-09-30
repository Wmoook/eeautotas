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
	// ---- THE PHYSICS PRICE (planner.js PHYS_PRICE, EEAT_PHYS_PRICE=1): the trophy on a shelf whose 1-tile hole the
	// gravity-blind est walk climbs straight up (11 steps); the physics (RCH3) goes round by the stairs (96 tiles)
	{
		const Wd = 56, Hd = 14, g = [];
		for (let y = 0; y < Hd; y++) g.push(Array(Wd).fill('.'));
		for (let x = 0; x < Wd; x++) { g[0][x] = '#'; g[Hd - 1][x] = '#'; }
		for (let y = 0; y < Hd; y++) { g[y][0] = '#'; g[y][Wd - 1] = '#'; }
		for (let x = 1; x <= 40; x++) if (x !== 4) g[3][x] = '#';
		for (let i = 0; i < 9; i++) for (let y = 11 - i; y <= 12; y++) g[y][44 + i] = '#';
		g[2][2] = 'T'; g[12][2] = 'S';
		const L = level(g.map((r) => r.join('')), {}), m = M.compileModel(L);
		const off = P.createPlanner(m, F.createFacts(), { physPrice: false }), on = P.createPlanner(m, F.createFacts(), { physPrice: true });
		const p0 = off.plan({}, { k: 1 })[0], p1 = on.plan({}, { k: 1 })[0];
		const sim = new (require('../src/eesim.js').EESim)(L); sim.reset();
		const rc = m.reachable(m.stateOf(sim), sim, m.trophyTiles).cost;
		check('P-UNIT physics price: off = the walk\'s est (no RCH3 cost read)', !!p0 && p0.cost < 100 && !(off.stats().physPriced > 0), p0 && planStr(m, p0));
		check('P-UNIT physics price: on = the RCH3 cost x the pace, the lb untouched', !!p1 && p1.cost >= rc * 4 && rc > 2 * 11 + 24 && p1.lb === p0.lb && on.stats().physPriced >= 1, p1 && `${planStr(m, p1)} (RCH3 ${rc} tiles)`);
	}
	// ---- THE STEPPING STONES (planner.js STONES, EEAT_PLAN_STONES=1): a 120-tile corridor, the trophy at its far end, 5
	// irrelevant coins on the way (no coin gate) and one 6 rows off it: the plan goes through coins of the corridor in order (the weighted A* may skip some: the next plans from the stone's anchor split the rest), never the 6th
	{
		const Wd = 124, Hd = 12, g = [];
		for (let y = 0; y < Hd; y++) g.push(Array(Wd).fill('.'));
		for (let x = 0; x < Wd; x++) { g[0][x] = '#'; g[Hd - 1][x] = '#'; }
		for (let y = 0; y < Hd; y++) { g[y][0] = '#'; g[y][Wd - 1] = '#'; }
		g[10][2] = 'S'; g[10][120] = 'T';
		for (const x of [22, 42, 62, 82, 102]) g[10][x] = 'c';
		g[3][60] = 'c';
		const L = level(g.map((r) => r.join('')), { c: [100] }), m = M.compileModel(L);
		const coins = m.triggers.filter((X) => X.kind === 'coin');
		const off = P.createPlanner(m, F.createFacts(), { stones: false }), on = P.createPlanner(m, F.createFacts(), { stones: true });
		const p0 = off.plan({}, { k: 1 })[0], p1 = on.plan({}, { k: 1 })[0];
		const xs = p1 ? p1.steps.filter((s) => s.waypoint.kind === 'trigger').map((s) => s.waypoint.tiles[0] % Wd) : [];
		check('P-UNIT stepping stones: the coins irrelevant (no coin gate)', coins.length === 6 && coins.every((X) => !X.relevant), coins.map((X) => X.relevant).join(','));
		check('P-UNIT stepping stones: off = the trophy alone', !!p0 && kindsOf(m, p0).join(',') === 'trophy', p0 && planStr(m, p0));
		check('P-UNIT stepping stones: on = coins of the corridor in order, then the trophy, never the coin off the way',
			!!p1 && kindsOf(m, p1).pop() === 'trophy' && xs.length >= 1 && xs.every((x, i) => i === 0 || x > xs[i - 1]) && !xs.includes(60) && p1.steps.every((s) => s.waypoint.kind !== 'trigger' || s.waypoint.expect === null), p1 && planStr(m, p1));
		// (a failed stone cuts nothing and is blocked from its second rung on; the same failure of a relevant step cuts)
		const s0 = p1 && p1.steps.find((s) => s.waypoint.kind === 'trigger');
		if (s0) {
			const fl = { ok: false, fail: { why: 'budget', closest: { tile: 10 * Wd + 12, dist: 5 } } };
			const f1 = on.learn(Object.assign({}, s0, { rung: 0 }), fl, {}), f2 = on.learn(Object.assign({}, s0, { rung: 1 }), fl, {});
			const all = f1.concat(f2);
			check('P-UNIT stepping stones: a failed stone cuts nothing, blocked at its second rung', all.every((f) => !f.cut) && f2.some((f) => f.kind === 'block') && !f1.some((f) => f.kind === 'block'), JSON.stringify(all.map((f) => [f.kind, f.rung, !!f.cut])));
		} else check('P-UNIT stepping stones: a failed stone cuts nothing', false, 'no stone step');
		// (a stone the anchor took already is no step: held right until the coin at x 22 is taken, then plan)
		{
			const E2 = require('../src/eesim.js');
			const sim = new E2.EESim(L); sim.reset(); const inp = new E2.EEInput();
			let n = 0; for (; n < 400 && !sim.is_coin_collected(22, 10); n++) { E2.applyMask(inp, 4); sim.tick(inp); }
			const an = anchorAfter(L, m, new Uint8Array(n).fill(4));
			const pA = sim.is_coin_collected(22, 10) ? on.plan(an, { k: 1 })[0] : null;
			const a2 = on._anchorOf(an);
			const es2 = pA ? on._edgesOf(a2.S, a2.pos, a2.base, 'plan', true, a2.S.key + '|' + a2.cls) : [];
			const xsA = es2.filter((e) => e.X && e.X.kind === 'coin').map((e) => e.X.tiles[0] % Wd);
			check('P-UNIT stepping stones: a stone the anchor took already is no edge', !!pA && !xsA.includes(22) && xsA.includes(42) && kindsOf(m, pA).pop() === 'trophy', pA ? `${planStr(m, pA)}; stone edges at x ${xsA.join(',')}` : 'coin not taken');
		}
		// (THE WALLED PRICE, EEAT_WALL_PRICE=1: a 1-row tunnel to the trophy; a rung-1 failure's cut in it severs the est walk:
		// off the trophy edge costs the 1e6 penalty, on WALL_F x the unwalled walk)
		{
			const tw = ['##############################################################', '#S...........................................................T#', '##############################################################'];
			const L2 = level([tw[0], tw[1].slice(0, 62), tw[2]], {}), m2 = M.compileModel(L2);
			const run = (wp) => {
				const pl2 = P.createPlanner(m2, F.createFacts(), { wallPrice: wp });
				const st = pl2.plan({}, { k: 1 })[0].steps[0];
				const fl = { ok: false, fail: { why: 'budget', closest: { tile: 1 * 62 + 20, dist: 30 } } };
				pl2.learn(Object.assign({}, st, { rung: 0 }), fl, {}); pl2.learn(Object.assign({}, st, { rung: 1 }), fl, {});
				return pl2.plan({}, { k: 1 })[0];
			};
			const q0 = run(false), q1 = run(true);
			check('P-UNIT walled price: off = the penalty past a severing cut, on = a finite 3x price', !!q0 && q0.cost >= 1e6 && !!q1 && q1.cost < 1e6 && q1.cost >= 3 * 50 && q1.lb === q0.lb, `${q0 && q0.cost} vs ${q1 && q1.cost}`);
		}
		// (THE STONES' WAY, EEAT_PLAN_STONE_WAY=1: the spawn at x 40, a coin behind it at x 5, 7 coins on the way at x 50-110:
		// with the way only the 4 nearest of those on the way and the farthest are root edges, never the one behind; the plan goes through the
		// corridor's coins in order to the trophy)
		{
			const g3 = [];
			for (let y = 0; y < Hd; y++) g3.push(Array(Wd).fill('.'));
			for (let x = 0; x < Wd; x++) { g3[0][x] = '#'; g3[Hd - 1][x] = '#'; }
			for (let y = 0; y < Hd; y++) { g3[y][0] = '#'; g3[y][Wd - 1] = '#'; }
			g3[10][40] = 'S'; g3[10][120] = 'T';
			for (const x of [5, 50, 60, 70, 80, 90, 100, 110]) g3[10][x] = 'c';
			const L3 = level(g3.map((r) => r.join('')), { c: [100] }), m3 = M.compileModel(L3);
			const noWay = P.createPlanner(m3, F.createFacts(), { stones: true, stoneWay: false });
			const way = P.createPlanner(m3, F.createFacts(), { stones: true, stoneWay: true });
			const rootXs = (pl) => { const a3 = pl._anchorOf({}); return pl._edgesOf(a3.S, a3.pos, a3.base, 'plan', true, a3.S.key + '|' + a3.cls).filter((e) => e.X && e.X.kind === 'coin').map((e) => e.X.tiles[0] % Wd).sort((x, y) => x - y); };
			const xn = rootXs(noWay), xw = rootXs(way);
			check('P-UNIT stones\' way: off = every stone a root edge (the one behind the spawn too)', xn.length === 8 && xn.includes(5), xn.join(','));
			check('P-UNIT stones\' way: on = the 4 nearest stones on the way and the farthest, never the one behind', xw.join(',') === '50,60,70,80,110', xw.join(','));
			const pw = way.plan({}, { k: 1 })[0];
			const xsw = pw ? pw.steps.filter((s) => s.waypoint.kind === 'trigger').map((s) => s.waypoint.tiles[0] % Wd) : [];
			check('P-UNIT stones\' way: the plan = the corridor\'s coins in order, then the trophy', !!pw && kindsOf(m3, pw).pop() === 'trophy' && xsw.length >= 1 && xsw.every((x, i) => x > 40 && (i === 0 || x > xsw[i - 1])), pw && planStr(m3, pw));
		}
		const lbOff = off.lowerBound({}), lbOn = on.lowerBound({});
		check('P-UNIT stepping stones: lowerBound unchanged (stones never in the lb)', lbOff.ticks === lbOn.ticks && lbOff.complete === lbOn.complete, `${lbOff.ticks} ${lbOn.ticks}`);
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

if (require.main === module) {
	units();
	cegar();
	if (process.argv.includes('--truth')) truth();
	if (process.argv.includes('--scale')) scale();
	console.log(`${pass}/${pass + fail}`);
	process.exitCode = fail ? 1 : 0;
}
