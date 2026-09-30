'use strict';
// THE POLISH (n4plan, the compiler's last stage, part 'executor'): a finished route made faster by exact local search,
// never slower, every candidate replayed by the engine (common.js evaluate + judge).
//   (a) src/cleanroute.js cleanRoute (0.4 of the time): useless presses and flips dropped, rejoins and shortcuts kept;
//   (b) per leg (the route's feature changes, or o.legs: tick marks), from the route's exact state at a window's start
//       (windows of o.win ticks, from the end of the route backwards: an accepted change leaves every earlier window as it
//       was), exact.js exactLeg toward the route's state region at the window's end: the centre in the same tile and the
//       same door-reading state (exact.discKey; the last window: the trophy itself, as endgame.js) with maxDepth = the
//       window's ticks - 1; a goal found sooner is spliced (the route's prefix + the found tail + the route's inputs from
//       the window's end) and kept only when it finishes faster (judge: no more deaths than the rule allows, no lower
//       random-portal chance); a search that runs out of states proves that window's leg the fastest to that region;
//   (c) the exact rejoin inside every such search: a state equal (stateHash) to the route's state at a LATER tick j is a
//       proven shortcut: the prefix + the found tail + the route's inputs from j (mutate.js's and cleanroute.js's rule).
//   polishRoute(L, masks, o) -> {masks, runTicks, saved, legs [{from, to, ticks, lb, proven, how}], steps, why}
//   o: {ms (default 30000), legs (tick marks), allowDeaths (default true: the judge's any-deaths rule; false = no more
//       deaths than the route), win (window ticks, default 32), cap (open states per layer, default 60000), stop, noClean}
const C = require('../common.js');
const E = C.E;
const T = require('./types.js');
const X = require('./exact.js');

const SNAP = 32;

/** the route's replay: per tick its state hash, snapshots every SNAP ticks, the latest tick of each hash */
function traceRoute(L, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	const H = new Float64Array(n + 1), snaps = [];
	const last = new Map();
	const rec = (t) => { const h = sim.stateHash(); H[t] = h; last.set(h, t); if (t % SNAP === 0) snaps[t / SNAP] = sim.snapshot(); };
	rec(0);
	for (let t = 0; t < n; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); rec(t + 1); }
	return { H, snaps, last, n, sim, inp };
}
/** the sim at tick t of the traced route */
function stateAt(R, masks, t) {
	const s = Math.floor(t / SNAP) * SNAP;
	R.sim.restore(R.snaps[s / SNAP]);
	for (let u = s; u < t; u++) { E.applyMask(R.inp, masks[u]); R.sim.tick(R.inp); }
	return R.sim;
}
/** the region goal of the route's state now in sim: the same centre tile and door-reading state, alive */
function regionGoal(L, sim) {
	const W = L.width, H = L.height;
	const tile = T.tileOf(sim, W, H), dk = X.discKey(sim);
	return { kind: 'region', tiles: Int32Array.of(tile), mask: null, allowDeath: false,
		test: (s) => !s.is_dead && T.tileOf(s, W, H) === tile && X.discKey(s) === dk };
}

function polishRoute(L, masks0, o) {
	o = o || {};
	const t0 = Date.now();
	const ms = o.ms > 0 ? o.ms : 30000;
	const deadline = t0 + ms;
	const stop = typeof o.stop === 'function' ? o.stop : null;
	const win = o.win > 0 ? o.win : 32;
	const cap = o.cap > 0 ? o.cap : 60000;
	const ev0 = C.evaluate(L, masks0, true);
	if (!ev0) return { masks: masks0, runTicks: -1, saved: 0, legs: [], steps: [], why: 'the route does not finish' };
	const maxDeaths = o.allowDeaths === false ? ev0.deaths : Infinity;
	let best = ev0;
	const steps = [];
	const accept = (cand, how) => {
		const ev = C.evaluate(L, cand, true);
		if (!ev) return false;
		const v = C.judge(ev, best, maxDeaths);
		if (!v.accept) return false;
		steps.push({ how, from: best.runTicks, to: ev.runTicks });
		best = ev;
		return true;
	};
	// (a) the cleanup
	if (!o.noClean) {
		try {
			const CR = require('../cleanroute.js');
			const r = CR.cleanRoute(L, best.ms, { ms: Math.max(50, 0.4 * ms) });
			if (r && r.changed) accept(r.ms, 'clean');
		} catch (e) { steps.push({ how: 'clean', error: String(e && e.message || e) }); }
	}
	// (b) + (c) the windows, from the end backwards
	const legs = [];
	let masks = best.ms;
	let R = traceRoute(L, masks);
	let F = masks.length;
	const unchanged = best === ev0;
	const marks = new Set();
	if (Array.isArray(o.legs) && unchanged) {
		for (const m of o.legs) if (m > 0 && m < F) marks.add(m | 0);
	} else {
		try { const S = require('./truthset.js'); for (const e of S.routeEvents(L, masks).events) if (e.tick > 0 && e.tick < F) marks.add(e.tick); } catch (e) { /* none */ }
	}
	// the windows' ends: every mark, and every `win` ticks back from each mark (and from the finish)
	const ends = [F, ...[...marks].sort((a, b) => b - a)];
	const wins = [];
	for (let k = 0; k < ends.length; k++) {
		const e = ends[k], s = k + 1 < ends.length ? ends[k + 1] : 0;
		for (let b = e; b > s; b -= win) wins.push([Math.max(s, b - win), b]);
	}
	wins.sort((x, y) => y[1] - x[1] || y[0] - x[0]);
	const B = { trophy: X.boundFor(L, { kind: 'trophy', tiles: [] }) };
	let wi = 0;
	for (; wi < wins.length; wi++) {
		const now = Date.now();
		if (now > deadline || (stop && stop())) break;
		const [a, b] = wins[wi];
		if (b > F || a >= b) continue;
		const left = wins.length - wi;
		const wEnd = Math.min(deadline, now + Math.max(40, (deadline - now) / left));
		const sim0 = stateAt(R, masks, b);
		const last = b === F;
		const goal = last ? { kind: 'trophy', tiles: Int32Array.from(B.trophy.cells), test: (s) => !!s.has_silver_crown, allowDeath: false } : regionGoal(L, sim0);
		if (!last && sim0.is_dead) continue;
		const s = stateAt(R, masks, a);
		if (s.is_dead) continue;
		const start = [{ snap: s.snapshot(), tick: a }];
		// (the rejoin map: the route's later states)
		const r = X.exactLeg(L, start, goal, { maxDepth: (b - a) - 1, cap, deadline: wEnd, stop, allowDeath: false, rejoin: R.last, rejoinMin: 1,
			B: last ? B.trophy : undefined, collect: 1 });
		let how = null;
		// (c) a proven shortcut first
		if (r.rejoin && r.layers) {
			const p = rejoinPath(r, start);
			if (p) {
				const cand = new Uint8Array(a + p.tail.length + (F - r.rejoin.tick));
				cand.set(masks.subarray(0, a), 0); cand.set(p.tail, a); cand.set(masks.subarray(r.rejoin.tick), a + p.tail.length);
				if (accept(cand, `rejoin ${a}+${p.tail.length}->${r.rejoin.tick}`)) how = 'rejoin';
			}
		}
		// (b) the region sooner
		if (!how && r.status === 'found') {
			const tail = r.tail;
			const cand = last ? T.concat(masks.subarray(0, a), tail) : new Uint8Array(a + tail.length + (F - b));
			if (!last) { cand.set(masks.subarray(0, a), 0); cand.set(tail, a); cand.set(masks.subarray(b), a + tail.length); }
			if (accept(cand, `leg ${a}->${b} in ${tail.length}`)) how = 'leg';
		}
		legs.push({ from: a, to: b, ticks: r.status === 'found' ? r.depth : b - a, lb: r.status === 'found' ? r.depth : r.status === 'proof' ? b - a : 0,
			proven: r.status === 'found' || r.status === 'proof', how, status: r.status });
		if (how) {
			masks = best.ms; F = masks.length; R = traceRoute(L, masks);
			// (every earlier window keeps its ticks: the change starts at a)
		}
	}
	return { masks: best.ms, runTicks: best.runTicks, saved: ev0.runTicks - best.runTicks, legs, steps, windows: wins.length, done: wi, ms: Date.now() - t0 };
}
/** the path to the best rejoin state of an exactLeg result */
function rejoinPath(r, starts) {
	const rj = r.rejoin;
	if (!rj) return null;
	// (exactLeg keeps the rejoin's layer / parent / mask internally: rebuilt from the layers)
	const L = r.layers;
	const e = rj.depth;
	if (!L || !L[e - 1]) return null;
	return X.pathOf(L, e, rj.par, rj.msk, starts, r.t0);
}

module.exports = { polishRoute, traceRoute };
