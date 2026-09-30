'use strict';
// test/admbounds_truth.js: T-LB-ADMISSIBLE on the ground truth (n4u study 4). For every known route (src/plan/truthset.js:
// the user's jobs + the benchmark runs) it replays the route and checks every tick-bound a tick field gives against what
// the route itself did:
//   LEG checks   for every feature event e_j (a coin, key, switch, team, ... changing at tick e_j) the target is the centre
//                tile at tick k = e_j - 1 (the tile the touch read), the door state is levelNow() at the segment's start
//                (no feature changes inside a segment), and at EVERY tick t of the segment [e_(j-1), k]
//                bound(state_t -> target) <= k - t.
//   PAIR checks  the same targets from every earlier event's state and the start, with the RELAXED level (every door
//                open that can open): bound <= k - e_i.
//   TROPHY       leg(state_t, trophy) <= complete - t in the last segment, and the relaxed trophy bound from the start
//                <= complete.
// A violation is a bound above the ticks the route took: the physics the bound missed. Tightness = bound / actual.
// Bounds: adm (src/plan/admbounds.js), prim (the primitives' src/plan/bounds.js, when present or --prim=<file>), eg
// (endgame.js lowerBound, legs <= --egmax ticks without a death in them), max (the max of all three), math (n4-math:
// src/math/lb.js, the event-graph bound of the exact per-axis recurrences from the exact state, adm's field as the rest
// after a source; --math=0 off) and best (the max of all four).
// usage: node test/admbounds_truth.js [--root=<truth root>] [--shard=i/n] [--only=<name part>] [--out=<file.jsonl>]
//        [--prim=<bounds.js>] [--egmax=128] [--pairs=1] [--limit=N] [--quick] (--quick: the first 3 routes)
const fs = require('fs');
const path = require('path');
const E = require('../src/eesim.js');
const S = require('../src/plan/truthset.js');
const T = require('../src/plan/types.js');
const A = require('../src/plan/admbounds.js');
const EG = require('../src/endgame.js');
const MLB = require('../src/math/lb.js');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const root = arg('root', process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..'));
const outFile = arg('out', null);
const egMax = +arg('egmax', 128);
const doPairs = arg('pairs', '1') !== '0';
let P = null;
{
	const pf = arg('prim', path.join(__dirname, '..', 'src', 'plan', 'bounds.js'));
	try { if (fs.existsSync(pf)) P = require(path.resolve(pf)); } catch (e) { console.error(`prim bounds: ${e.message}`); }
}

let list = S.knownRoutes({ root });
if (arg('only', null)) list = list.filter((e) => e.name.toLowerCase().includes(arg('only').toLowerCase()) || e.route.includes(arg('only')));
if (arg('shard', null)) { const [i, n] = arg('shard').split('/').map(Number); list = list.filter((e, k) => k % n === i); }
if (flag('quick')) list = list.slice(0, 3);
if (arg('limit', null)) list = list.slice(0, +arg('limit'));

const NAMES = ['adm', 'fb', 'prim', 'eg', 'max', 'whatif', 'math', 'best'];
const MATH = arg('math', '1') !== '0';
const WHATIF = arg('whatif', '0') === '1';   // a what-if: the fallback with the PLAIN sups on every level (not admissible: how much the sups cost)
function newAgg() { const a = {}; for (const b of NAMES) a[b] = { n: 0, viol: 0, sumR: 0, hist: new Array(21).fill(0), worst: [] }; return a; }
function note(agg, b, bound, actual, ctx) {
	if (bound === null || bound === undefined || Number.isNaN(bound)) return;
	const g = agg[b];
	g.n++;
	if (bound > actual) { g.viol++; if (g.worst.length < 8) g.worst.push(Object.assign({ bound, actual }, ctx)); return; }
	if (actual >= 10) { const r = bound / actual; g.sumR += r; g.hist[Math.min(20, Math.floor(r * 20))]++; }
}

function runRoute(entry) {
	const t0 = Date.now();
	const tr = S.loadTruth(entry);
	if (!tr) return { name: entry.name, route: entry.route, stale: true };
	const L = tr.L, W = L.width, H = L.height, N = W * H;
	const ev = S.routeEvents(L, tr.masks);
	const complete = tr.complete;
	// the event ticks (unique, ascending; the finish too)
	const evTicks = [...new Set(ev.events.map((e) => e.tick).filter((t) => t >= 1 && t <= complete))].sort((a, b) => a - b);
	if (!evTicks.length || evTicks[evTicks.length - 1] !== complete) evTicks.push(complete);
	// pass 1: the centre tile after every tick, snapshots at the segment starts (tick 0 and each event tick)
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const tile = new Int32Array(complete + 1);
	const deadAt = new Uint8Array(complete + 1);
	tile[0] = T.tileOf(sim, W, H);
	const starts = [0, ...evTicks.slice(0, -1)];
	const startSet = new Set(starts);
	const snaps = new Map();
	snaps.set(0, sim.snapshot());
	for (let t = 0; t < complete; t++) {
		E.applyMask(inp, tr.masks[t] & 31);
		sim.tick(inp);
		tile[t + 1] = T.tileOf(sim, W, H);
		deadAt[t + 1] = sim.is_dead ? 1 : 0;
		if (startSet.has(t + 1)) snaps.set(t + 1, sim.snapshot());
	}
	const deathPS = new Int32Array(complete + 2);
	for (let t = 0; t <= complete; t++) deathPS[t + 1] = deathPS[t] + deadAt[t];
	const diedIn = (a, b) => deathPS[b + 1] - deathPS[a] > 0;   // a dead tick in [a, b]
	const adm = A.createAdmBounds(L, { memo: 4 });
	const mlb = MATH ? MLB.createMathLB(L, {}) : null;
	let mathMs = 0;
	const mathAt = (s, goalTiles, f, hor) => { if (!mlb) return null; const tm = Date.now(); const r = mlb.leg(s, { tiles: goalTiles, mode: 'touch' }, { field: f, horizon: hor }); mathMs += Date.now() - tm; return r.lb; };
	const prim = P ? P.createBounds(L, {}) : null;
	const whatif = WHATIF ? A.createAdmBounds(L, { memo: 4, accX: false, up: false, vmax: { xp: A.terminal(1 / E.constants.MULT, E.constants.BASE_DRAG) + 0.02, xn: A.terminal(1 / E.constants.MULT, E.constants.BASE_DRAG) + 0.02, yp: A.terminal(2 / E.constants.MULT, E.constants.BASE_DRAG) + 0.02, yn: (2 * 26) / E.constants.MULT + 0.02 } }) : null;
	const trophies = [];
	for (let i = 0; i < N; i++) if (L.fg[i] === 121) trophies.push(i);
	const aggLeg = newAgg(), aggPair = newAgg(), aggTick = newAgg();
	const legs = [];   // [actual, adm, prim, eg] at the segment start
	const globalB = { actual: complete, adm: null, prim: null };
	const sim2 = new E.EESim(L);
	const egCtx = new Map();
	const egOf = (goals) => { const k = goals.join(','); let B = egCtx.get(k); if (!B) { B = EG.boundContext(L, { goals }); egCtx.set(k, B); if (egCtx.size > 4) egCtx.delete(egCtx.keys().next().value); } return B; };
	// pass 2: segment by segment
	sim.reset();
	let t = 0;
	let admMs = 0, primMs = 0;
	for (let j = 0; j < evTicks.length; j++) {
		const s0 = starts[j];
		// the target: the centre tile at the event's tick start (e - 1), ALIVE (a goal needs the ball alive: types.js);
		// a dead ball there (a death's respawn is the event): the respawn tick e itself; dead at both: no checks
		let k = evTicks[j] - 1;
		if (deadAt[k]) k = evTicks[j] <= complete && !deadAt[evTicks[j]] ? evTicks[j] : -1;
		if (k < s0) {
			while (t < evTicks[j] && t < complete) { E.applyMask(inp, tr.masks[t] & 31); sim.tick(inp); t++; }
			continue;
		}
		// the state at s0 is in sim (t === s0)
		const goal = [tile[k]];
		const Lc = T.levelNow(L, sim);
		let ta = Date.now();
		const fA = adm.field(goal, Lc);
		admMs += Date.now() - ta;
		ta = Date.now();
		const fP = prim ? prim.field(goal, Lc) : null;
		const fW = whatif ? whatif.field(goal, Lc) : null;
		primMs += Date.now() - ta;
		const isLast = j === evTicks.length - 1;
		const fAT = isLast ? adm.field(trophies, null, { touch: true }) : null;
		for (;;) {
			const actual = k - t;
			const ctx = { t, k, tile: tile[t], goal: goal[0], seg: j };
			const bA = adm.at(fA, sim);
			const pa = adm.parts(fA, sim);
			const bP = fP ? prim.at(fP, sim) : null;
			let bE = null;
			if (actual <= egMax && !diedIn(t, k) && !sim.is_dead) { const B = egOf(goal); bE = EG.lowerBound(B, sim, actual + 1); if (bE > actual + 1) bE = actual + 1; }
			const bM = Math.max(bA, bP === null ? 0 : bP, bE === null ? 0 : bE);
			const bMath = mathAt(sim, goal, fA, actual + 1);
			if (bMath !== null) note(aggTick, 'math', bMath, actual, ctx);
			const bBest = Math.max(bM, bMath === null ? 0 : bMath);
			note(aggTick, 'best', bBest, actual, ctx);
			note(aggTick, 'fb', pa.fb, actual, ctx);
			if (pa.accX !== null && pa.accX !== Infinity && pa.accX > actual) note(aggTick, 'adm', pa.accX, actual, Object.assign({ tier: 'accX' }, ctx));
			if (pa.up !== null && pa.up !== Infinity && pa.up > actual) note(aggTick, 'adm', pa.up, actual, Object.assign({ tier: 'up' }, ctx));
			note(aggTick, 'adm', bA, actual, ctx);
			if (bP !== null) note(aggTick, 'prim', bP, actual, ctx);
			if (bE !== null) note(aggTick, 'eg', bE, actual, ctx);
			note(aggTick, 'max', bM, actual, ctx);
			const bW = fW ? whatif.at(fW, sim) : null;
			if (bW !== null) note(aggTick, 'whatif', bW, actual, ctx);
			if (t === s0) {
				legs.push([actual, bA, bP, bE, j, bW, bMath, bBest]);
				if (bMath !== null) note(aggLeg, 'math', bMath, actual, ctx);
				note(aggLeg, 'best', bBest, actual, ctx);
				note(aggLeg, 'adm', bA, actual, ctx);
				if (bP !== null) note(aggLeg, 'prim', bP, actual, ctx);
				if (bE !== null) note(aggLeg, 'eg', bE, actual, ctx);
				note(aggLeg, 'max', bM, actual, ctx);
			}
			if (isLast) {
				const actT = complete - t;
				const bT = adm.leg(sim, { kind: 'trophy' }, { relaxed: false });
				note(aggTick, 'adm', bT, actT, Object.assign({ trophy: 1 }, ctx));
				if (prim) note(aggTick, 'prim', prim.leg(sim, { kind: 'trophy', tiles: trophies }), actT, Object.assign({ trophy: 1 }, ctx));
				if (mlb) { const bt = mathAt(sim, trophies, fAT, actT); if (bt !== null) note(aggTick, 'math', bt === Infinity ? bt : bt + 1, actT, Object.assign({ trophy: 1 }, ctx)); }
				void fAT;
			}
			if (t >= k) break;
			E.applyMask(inp, tr.masks[t] & 31);
			sim.tick(inp);
			t++;
		}
		// catch up to the next segment start (the event tick itself)
		while (t < evTicks[j] && t < complete) { E.applyMask(inp, tr.masks[t] & 31); sim.tick(inp); t++; }
		// PAIRS: the relaxed field to this target from every earlier segment start
		if (doPairs && j > 0) {
			const fR = adm.field(goal, null);
			const fRP = prim ? prim.field(goal, null) : null;
			for (let i = 0; i < j; i++) {
				const si = starts[i];
				sim2.restore(snaps.get(si));
				const actual = k - si;
				const ctx = { t: si, k, goal: goal[0], pair: 1 };
				const bA = adm.at(fR, sim2);
				const bP = fRP ? prim.at(fRP, sim2) : null;
				note(aggPair, 'adm', bA, actual, ctx);
				if (bP !== null) note(aggPair, 'prim', bP, actual, ctx);
				note(aggPair, 'max', Math.max(bA, bP === null ? 0 : bP), actual, ctx);
				const bMp = mathAt(sim2, goal, fR, actual + 1);
				if (bMp !== null) note(aggPair, 'math', bMp, actual, ctx);
			}
		}
	}
	// the global bound: the relaxed trophy field from the start
	sim2.restore(snaps.get(0));
	globalB.adm = adm.leg(sim2, { kind: 'trophy' }, { relaxed: true });
	if (prim) { sim2.restore(snaps.get(0)); globalB.prim = prim.leg(sim2, { kind: 'trophy', tiles: trophies }, { relaxed: true }); }
	note(aggPair, 'adm', globalB.adm, complete, { global: 1 });
	if (prim) note(aggPair, 'prim', globalB.prim, complete, { global: 1 });
	const St = adm.static;
	return {
		name: entry.name, source: entry.source, route: path.relative(root, entry.route), W, H, complete, runTicks: tr.runTicks, deaths: tr.deaths,
		events: evTicks.length, tame: St.tameLevel, upOk: St.upOk, srcFrac: +(St.src.reduce((a, b) => a + b, 0) / N).toFixed(3),
		vmax: St.vmax, primVmax: prim ? { xp: prim.vmax.xp, xn: prim.vmax.xn, yp: prim.vmax.yp, yn: prim.vmax.yn } : null,
		legs, globalB, sumLegs: { actual: legs.reduce((a, l) => a + l[0], 0), adm: legs.reduce((a, l) => a + l[1], 0), prim: prim ? legs.reduce((a, l) => a + (l[2] || 0), 0) : null },
		leg: aggLeg, pair: aggPair, tick: aggTick, admMs, primMs, mathMs, ms: Date.now() - t0,
	};
}

let tot = { routes: 0, stale: 0 };
const totV = { adm: 0, prim: 0, eg: 0, max: 0, math: 0, best: 0 };
for (const e of list) {
	let r;
	try { r = runRoute(e); } catch (err) { r = { name: e.name, route: e.route, error: String(err && err.stack || err) }; }
	tot.routes++;
	if (r.stale) tot.stale++;
	if (outFile) fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
	if (r.error) { console.log(`ERR ${e.name}: ${r.error.split('\n')[0]}`); continue; }
	if (r.stale) { console.log(`stale ${e.name}`); continue; }
	const v = (b) => r.tick[b].viol + r.pair[b].viol;
	for (const b of NAMES) totV[b] += v(b);
	const med = (i) => { const a = r.legs.filter((l) => l[0] >= 10 && l[i] !== null).map((l) => l[i] / l[0]).sort((x, y) => x - y); return a.length ? a[a.length >> 1].toFixed(2) : '-'; };
	console.log(`${r.name.slice(0, 28).padEnd(28)} ${String(r.complete).padStart(6)}t ev ${String(r.events).padStart(4)} viol adm ${v('adm')} prim ${v('prim')} eg ${v('eg')} math ${v('math')} | leg med adm ${med(1)} prim ${med(2)} math ${med(6)} best ${med(7)} | global adm ${r.globalB.adm} prim ${r.globalB.prim} / ${r.complete} | ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(`admbounds_truth: routes ${tot.routes} stale ${tot.stale} violations adm ${totV.adm} prim ${totV.prim} eg ${totV.eg} math ${totV.math} best ${totV.best}`);
process.exitCode = totV.adm || totV.math ? 1 : 0;
