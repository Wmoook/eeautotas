'use strict';
// THE ORDER ORACLE (P4 gated, 2026-09-30): the known routes' trigger orders (src/plan/truthset.js routeEvents, the model's
// triggers in the route's own order) as the test oracle of the planner's order. At the route's own state after each of
// its relevant trigger events (the level start first) the planner is asked what it would do next, and the route's NEXT
// action in the planner's terms (the first of the route's remaining events that is an edge of the planner at that state)
// is ranked among: the plans' first steps (plan 1 = what the compile and the chain try first), the edges by est, by lb
// and by the chain's candidate order (bwchain.js candsOf: the plans' first steps, then the nearest edges by est). Where
// the planner's first step is not the route's, its place in the route's rest says how: taken later (an ORDER
// difference), never (a trigger the route does not take: a detour or an off-route target).
//   node tools/cmp/orderoracle.js <level.eelvl> <route.eetas> [--k=3] [--ms=600] [--max=60] [--bounds=0] [--label=]
//     -> one JSON line an event (stderr: --verbose) and a summary line (stdout)
// Run under any planner knob (EEAT_PHYS_EST=1, EEAT_PLAN_LEGT=..): the same oracle, the knob's order.
const path = require('path');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'src/plan/defaults.js')).apply();
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const { createFacts } = require(path.join(root, 'src/plan/facts.js'));
const { createPlanner } = require(path.join(root, 'src/plan/planner.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
const verbose = argv.includes('--verbose');

/** the route's relevant trigger events: [{i, tick, trig, tile, label, feat}] + the trophy last */
function routeTriggers(L, M, route, complete) {
	const evs = TS.routeEvents(L, route);
	// (the tile each tick's touch read: eesim.js _touchBlock's cell (types.js touchedTile), where every trigger fires: a coin
	// is taken off the centre tile as often as on it (Wine Quest I: 4 of its 10 coins))
	const W = L.width, H = L.height;
	const touched = new Int32Array(route.length + 2).fill(-1);
	{
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < route.length; t++) { E.applyMask(inp, route[t] & 31); sim.tick(inp); touched[t + 1] = T.touchedTile(sim, W, H); }
	}
	const out = [];
	for (const e of evs.events) {
		if (e.feat === 'deaths' || e.feat === 'fx') continue;
		let tr = M.trigOf ? M.trigOf[e.tile] : -1;
		const tt = touched[e.tick];
		if (tt >= 0 && M.trigOf && M.trigOf[tt] >= 0) { tr = M.trigOf[tt]; e.tile = tt; }
		if (tr === undefined || tr < 0) continue;
		const X = M.triggers[tr];
		if (!X || !X.tiles || !X.tiles.length || X.kind === 'trophy') continue;
		// (one touch can change several features: one event a trigger and tick)
		const last = out[out.length - 1];
		if (last && last.trig === tr && last.tick === e.tick) continue;
		out.push({ i: out.length, tick: e.tick, trig: tr, tile: e.tile, label: X.label, feat: e.feat, kind: X.kind });
	}
	out.push({ i: out.length, tick: complete, trig: -1, tile: -1, label: 'trophy', feat: 'silver', kind: 'trophy' });
	return out;
}

/** does planner edge e stand for route event r? (the same trigger, a member of its any-of group, the trophy) */
function matches(e, r) {
	if (!e) return false;
	if (r.trig < 0) return !e.X;
	if (!e.X) return false;
	if (e.X.id === r.trig) return true;
	if (e.anyOf > 1 && e.live && e.live.indexOf(r.tile) >= 0) return true;
	return false;
}
const edgeName = (e) => (e && e.X ? e.X.label + (e.anyOf > 1 ? ` (any of ${e.anyOf})` : '') : e ? 'trophy' : null);

async function oracle(file, rfile, o = {}) {
	const L = T.loadLevelFile(file);
	const M = MD.compileModel(L);
	const masks0 = C.readEetas(rfile);
	const ev0 = C.evaluate(L, masks0, false);
	if (!ev0) return { level: path.basename(file), error: 'the route does not finish' };
	const route = masks0.subarray(0, ev0.complete);
	const evs = routeTriggers(L, M, route, ev0.complete);
	const complete0 = ev0.complete;
	let bounds = null;
	if (o.bounds) { try { bounds = await require(path.join(root, 'src/plan/bounds.js')).createBounds(L, { model: M }); } catch (e) { bounds = null; } }
	const facts = createFacts({ rungs: 4, model: M });
	const planner = createPlanner(M, facts, { bounds, file, floorAsync: false });
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let t = 0;
	const rows = [];
	const max = o.max || 60;
	// the anchors: the level start, then the route's state right after each event (not after the trophy)
	for (let a = 0; a < evs.length && rows.length < max; a++) {
		const at = a === 0 ? 0 : evs[a - 1].tick;
		if (at >= complete0) break;
		while (t < at) { E.applyMask(inp, route[t] & 31); sim.tick(inp); t++; }
		if (sim.is_dead) continue;
		const masks = route.slice(0, at);
		const arr = Object.assign(T.arrivalOf(L, sim, masks, null), { run: sim.run_ticks });
		const S = M.stateOf(sim);
		const anchor = { arrival: arr, arrivals: [arr], S, key: String(S.key), tick: at, run: arr.run };
		const t0 = Date.now();
		let plans = [];
		try { plans = planner.plan(anchor, { k: o.k || 3, ms: o.ms || 600 }) || []; } catch (e) { plans = []; }
		const planMs = Date.now() - t0;
		let edges = [];
		try {
			const A = planner._anchorOf(anchor);
			const cls = A.S.key + '|' + A.cls;
			edges = (planner._edgesOf(A.S, A.pos, A.base, 'plan', true, cls, A) || []).filter((e) => !e.viaDeath || true);
		} catch (e) { edges = []; }
		const usable = edges.filter((e) => !e.relaxOnly && !(e.X && e.X.kind === 'die'));
		// the route's next action in the planner's terms
		const rest = evs.slice(a);
		let nxt = null, skipped = 0;
		for (const r of rest) { if (edges.some((e) => matches(e, r))) { nxt = r; break; } skipped++; }
		const row = { a, at, next: nxt ? nxt.label : null, nextI: nxt ? nxt.i : -1, skipped, edges: edges.length, usable: usable.length, planMs };
		// (plan 1's first trigger / trophy step: a key door passage, a death and a CRUMB (a coin no gate reads, crumbStep) before
		// it are the way to it; the chain (bwchain candsOf) takes steps[0] itself: crumbFirst counts where that is a crumb)
		const isReal = (s) => s && s.waypoint && (s.waypoint.kind === 'trigger' || s.waypoint.kind === 'trophy') && !s.crumb;
		const p1 = plans[0] && plans[0].steps ? plans[0].steps.find(isReal) || null : null;
		row.crumbFirst = !!(plans[0] && plans[0].steps && plans[0].steps[0] && plans[0].steps[0].crumb);
		row.plan1Crumb = !!(plans[0] && plans[0].crumb);
		const p1e = p1 ? { X: p1.waypoint && p1.waypoint.kind === 'trophy' ? null : (p1.waypoint && p1.waypoint.trig !== undefined ? M.triggers[p1.waypoint.trig] : null), anyOf: 0, live: p1.waypoint ? p1.waypoint.tiles || [] : [] } : null;
		if (p1e && p1.waypoint && p1.waypoint.kind === 'trigger' && !p1e.X) p1e.X = { id: -99, label: p1.waypoint.label };
		if (p1e && p1.waypoint && p1.waypoint.label && /any of/.test(p1.waypoint.label)) p1e.anyOf = 2;
		row.plan1 = p1 ? (p1.waypoint && p1.waypoint.label) || p1.edge : null;
		row.plan1Why = plans[0] ? plans[0].why : null;
		row.plan1Kind = p1 && p1.waypoint ? p1.waypoint.kind : null;
		if (nxt) {
			row.top1 = !!(p1e && matches(p1e, nxt));
			// (the plans' first steps, in order)
			const firsts = [];
			for (const p of plans) {
				const s = p.steps && p.steps.find(isReal);
				if (!s || !s.waypoint) continue;
				const fe = { X: s.waypoint.kind === 'trophy' ? null : (s.waypoint.trig !== undefined ? M.triggers[s.waypoint.trig] : { id: -99 }), anyOf: /any of/.test(s.waypoint.label || '') ? 2 : 0, live: s.waypoint.tiles || [] };
				if (!firsts.some((f) => f.X === fe.X || (f.X && fe.X && f.X.id === fe.X.id))) firsts.push(fe);
			}
			row.planRank = firsts.findIndex((f) => matches(f, nxt)) + 1;
			const rank = (key) => { const s = usable.slice().sort((x, y) => x[key] - y[key] || x.lb - y.lb); return s.findIndex((e) => matches(e, nxt)) + 1; };
			row.estRank = rank('est');
			row.lbRank = rank('lb');
			row.stepsRank = rank('steps');
			// (the chain's candidate order: bwchain.js candsOf)
			const cand = firsts.slice();
			const byEst = usable.slice().sort((x, y) => (x.est - y.est) || (x.lb - y.lb));
			for (const e of byEst.slice(0, 8)) if (!cand.some((f) => (f.X === e.X) || (f.X && e.X && f.X.id === e.X.id))) cand.push(e);
			row.chainRank = cand.findIndex((f) => matches(f, nxt)) + 1;
			const ne = usable.find((e) => matches(e, nxt)) || edges.find((e) => matches(e, nxt));
			if (ne) { row.nextEst = Math.round(ne.est); row.nextLb = Math.round(ne.lb); row.nextRelax = !!ne.relaxOnly; }
			// (where the planner's first step is in the route's rest: 0 = the next, k = k events later, -1 = never)
			if (p1e) {
				const j = rest.findIndex((r) => matches(p1e, r));
				row.plan1At = j < 0 ? -1 : rest[j].i - nxt.i;
				const pe = usable.find((e) => matches(e, { trig: p1e.X ? p1e.X.id : -1, tile: (p1e.live || [])[0] }));
				if (pe) { row.plan1Est = Math.round(pe.est); row.plan1Lb = Math.round(pe.lb); }
			}
			// (the route's actual leg ticks to that event)
			row.routeLeg = nxt.tick - at;
		}
		rows.push(row);
		if (verbose) process.stderr.write(JSON.stringify(row) + '\n');
	}
	const withNext = rows.filter((r) => r.nextI >= 0);
	const n = withNext.length;
	const pct = (f) => (n ? Math.round(1000 * withNext.filter(f).length / n) / 10 : null);
	const firstDiv = withNext.findIndex((r) => !r.top1);
	return {
		level: path.basename(file, '.eelvl'), runTicks: ev0.runTicks, events: evs.length, anchors: rows.length, n,
		top1: pct((r) => r.top1), planTop3: pct((r) => r.planRank >= 1 && r.planRank <= 3), estTop1: pct((r) => r.estRank === 1),
		estTop3: pct((r) => r.estRank >= 1 && r.estRank <= 3), lbTop1: pct((r) => r.lbRank === 1), chainTop3: pct((r) => r.chainRank >= 1 && r.chainRank <= 3),
		absent: withNext.filter((r) => r.estRank === 0).length, later: withNext.filter((r) => !r.top1 && r.plan1At > 0).length,
		never: withNext.filter((r) => !r.top1 && r.plan1At < 0).length, firstDiv, rows: o.rows ? rows : undefined,
	};
}

module.exports = { oracle, routeTriggers, matches };

if (require.main === module) {
	(async () => {
		const [file, rfile] = pos;
		const r = await oracle(file, rfile, { k: +opt('k', 3), ms: +opt('ms', 600), max: +opt('max', 60), bounds: opt('bounds', '0') === '1', rows: argv.includes('--rows') });
		if (opt('label', '')) r.label = opt('label', '');
		console.log(JSON.stringify(r));
		process.exit(0);
	})();
}
