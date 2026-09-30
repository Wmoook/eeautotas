'use strict';
// THE POLISH (n4plan, the compiler's last stage, part 'executor'): a finished route made faster by exact local search,
// never slower, every candidate replayed by the engine (common.js evaluate + judge).
//   (a) src/cleanroute.js cleanRoute (0.4 of the time): useless presses and flips dropped, rejoins and shortcuts kept;
//   (a2) the mutation pass (mutatePass; half of the time left, passes while they gain): src/mutate.js's classic moves at
//       every tick (delete one or two ticks, replace an input by any other, delete one and replace the next), each
//       followed by the route's own inputs until an exact rejoin with a LATER route state (a proven shortcut), a rejoin
//       that is not later, 200 ticks or 96 px of drift; the shortcuts combined by DP (weighted interval scheduling), the
//       combination judged (else the largest one alone): T-POLISH's 10 routes (8 s each) saved 176 ticks vs 3 without;
//       a raw Find a route route (Are You A God's 7,290) 7,042 in 30 s vs 7,255 (o.noMutate: off; o.horizon, o.drift);
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
// ---------------------------------------------------------------- the mutation pass (src/mutate.js's moves)
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
/**
 * mutatePass(L, masks, o) -> {shortcuts [{t, j, ins, saved}], ticks, next (the first tick not searched), timeUp}:
 * for every tick t from o.from, from the route's exact state S(t) the classic moves (src/mutate.js): delete tick t,
 * delete t and t + 1, replace t by any other input, delete t and replace t + 1; each followed by the route's own inputs
 * until its state equals a route state S(j) (stateHash: identical futures): j later than the candidate's own tick is a
 * PROVEN shortcut t -> j (inputs ins from S(t) reach S(j) sooner), j not later ends it (the route's own future, no
 * gain); also ended after o.horizon ticks or o.drift px from the route at the shifted time, or a death. The states after
 * the first change are deduplicated per t (equal states play the same continuation).
 */
function mutatePass(L, masks, o) {
	o = o || {};
	const deadline = o.deadline || Infinity, stop = typeof o.stop === 'function' ? o.stop : null;
	const HOR = o.horizon > 0 ? o.horizon : 200, DRIFT = o.drift > 0 ? o.drift : 96;
	const n = masks.length;
	// the route: per tick the state hash, the position, the latest tick of each hash
	const sim = new E.EESim(L), inp = new E.EEInput(), ws = new E.EESim(L);
	sim.reset();
	const H = new Float64Array(n + 1), PX = new Float64Array(n + 1), PY = new Float64Array(n + 1);
	const last = new Map();
	const rec = (t) => { const h = sim.stateHash(); H[t] = h; PX[t] = sim.px; PY[t] = sim.py; last.set(h, t); };
	rec(0);
	const snaps = [sim.snapshot()];
	for (let t = 0; t < n; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); rec(t + 1); if ((t + 1) % 64 === 0) snaps[(t + 1) / 64] = sim.snapshot(); }
	const shortcuts = [];
	let ticks = 0;
	const from = Math.max(0, o.from | 0);
	sim.restore(snaps[Math.floor(from / 64)]);
	for (let u = Math.floor(from / 64) * 64; u < from; u++) { E.applyMask(inp, masks[u]); sim.tick(inp); }
	const seen = new Set();
	let t = from, timeUp = false;
	const pre = new Uint8Array(2);
	for (; t < n - 1; t++) {
		if ((t & 15) === 0 && (Date.now() > deadline || (stop !== null && stop()))) { timeUp = true; break; }
		if (!sim.is_dead) {
			const sT = sim.snapshot();
			seen.clear();
			// the moves: [prefix inputs, the route's input index after them]
			const moves = [];
			moves.push([0, -1, t + 1], [0, -1, t + 2]);
			for (const a of OPTIONS) {
				if (a !== masks[t]) moves.push([1, a, t + 1]);
				if (t + 1 < n && a !== masks[t + 1]) moves.push([1, a, t + 2]);
			}
			for (const [np, a, r0] of moves) {
				if (r0 > n) continue;
				ws.restore(sT);
				let q = 0;
				if (np) { E.applyMask(inp, a); ws.tick(inp); ticks++; q = 1; pre[0] = a; }
				let r = r0;
				// (the first state after the change: once per state and t)
				let h = ws.stateHash();
				if (seen.has(h)) continue;
				seen.add(h);
				for (;;) {
					if (ws.is_dead) break;
					const j = last.get(h);
					if (j !== undefined) {
						if (j > t + q) {
							const ins = new Uint8Array(q);
							if (np) ins[0] = a;
							for (let k = np; k < q; k++) ins[k] = masks[r0 + k - np];
							shortcuts.push({ t, j, ins, saved: j - (t + q) });
						}
						break;
					}
					if (q >= HOR || r >= n) break;
					if (Math.abs(ws.px - PX[r]) + Math.abs(ws.py - PY[r]) > DRIFT) break;
					E.applyMask(inp, masks[r]); ws.tick(inp); ticks++; q++; r++;
					h = ws.stateHash();
				}
			}
		}
		E.applyMask(inp, masks[t]); sim.tick(inp);
	}
	return { shortcuts, ticks, next: t, timeUp };
}
/** the best set of non-overlapping shortcuts (weighted interval scheduling over the route's ticks) */
function bestShortcutSet(n, shortcuts) {
	const byEnd = new Map();
	for (const c of shortcuts) { const l = byEnd.get(c.j); if (l) l.push(c); else byEnd.set(c.j, [c]); }
	const dp = new Float64Array(n + 1), how = new Array(n + 1).fill(null);
	for (let k = 1; k <= n; k++) {
		dp[k] = dp[k - 1]; how[k] = null;
		const l = byEnd.get(k);
		if (l) for (const c of l) if (dp[c.t] + c.saved > dp[k]) { dp[k] = dp[c.t] + c.saved; how[k] = c; }
	}
	const out = [];
	for (let k = n; k > 0;) { const c = how[k]; if (c) { out.push(c); k = c.t; } else k--; }
	return out.reverse();
}
/** the route with the shortcuts (sorted, non-overlapping) spliced in */
function spliceShortcuts(masks, set) {
	const parts = [];
	let at = 0;
	for (const c of set) { parts.push(masks.subarray(at, c.t), c.ins); at = c.j; }
	parts.push(masks.subarray(at));
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
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
	// (a2) the mutation pass: the classic moves everywhere, exact rejoins combined by DP (a combination the judge refuses:
	// its shortcuts one at a time, the largest first); passes while they find time and there is time (o.mutShare of it)
	if (!o.noMutate) {
		const mEnd = Math.min(deadline, Date.now() + (o.mutShare > 0 ? o.mutShare : 0.5) * (deadline - Date.now()));
		for (let pass = 0; pass < 8 && Date.now() < mEnd; pass++) {
			const cur = best.ms;
			const mp = mutatePass(L, cur, { deadline: mEnd, stop, horizon: o.horizon, drift: o.drift });
			if (!mp.shortcuts.length) break;
			const set = bestShortcutSet(cur.length, mp.shortcuts);
			const saved = set.reduce((a, c) => a + c.saved, 0);
			if (!accept(spliceShortcuts(cur, set), `mutate ${set.length} (${saved})`)) {
				let any = false;
				for (const c of mp.shortcuts.slice().sort((x, y) => y.saved - x.saved).slice(0, 64)) {
					if (Date.now() > mEnd) break;
					if (accept(spliceShortcuts(best.ms === cur ? cur : cur, [c]), `mutate 1 (${c.saved})`)) { any = true; break; }
				}
				if (!any) break;
			}
			if (mp.timeUp) break;
		}
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

/**
 * polishLeg(L, start {snap, tick}, tail, goal, o) -> {tail, saved, windows, ms}: a leg a finder found (the inputs `tail`
 * from the start state, the goal (types.js goalOf) first reached at its end) made shorter by the same exact windows as
 * polishRoute, from the end back: the last window's goal is the waypoint itself, the others the leg's own state region
 * at the window's end (tile + door-reading state) or an exact rejoin with a later state of the leg; every change is
 * replayed from the start (the goal first at the new end, no death unless o.allowDeath, o.beforeTick) and kept only
 * when shorter. o: {deadline, win (default 24), cap (40000), stop, allowDeath, beforeTick}.
 */
function polishLeg(L, start, tail0, goal, o) {
	o = o || {};
	const t0 = Date.now();
	const deadline = o.deadline || t0 + 1000;
	const win = o.win > 0 ? o.win : 24, cap = o.cap > 0 ? o.cap : 40000;
	const allowDeath = !!o.allowDeath, beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	let tail = Uint8Array.from(tail0);
	const T0 = start.tick;
	/** the leg's replay: per step its state hash (the latest step of each hash), snapshots every SNAP steps */
	const trace = (tl) => {
		sim.restore(start.snap);
		const n = tl.length, snaps = [sim.snapshot()], last = new Map();
		last.set(sim.stateHash(), T0);
		for (let t = 0; t < n; t++) { E.applyMask(inp, tl[t]); sim.tick(inp); last.set(sim.stateHash(), T0 + t + 1); if ((t + 1) % SNAP === 0) snaps[(t + 1) / SNAP] = sim.snapshot(); }
		return { snaps, last, n };
	};
	const at = (R, tl, t) => {
		const s = Math.floor(t / SNAP) * SNAP;
		sim.restore(R.snaps[s / SNAP]);
		for (let u = s; u < t; u++) { E.applyMask(inp, tl[u]); sim.tick(inp); }
		return sim;
	};
	/** a candidate leg: the goal first at its end, alive, in time */
	const good = (tl) => {
		sim.restore(start.snap);
		for (let t = 0; t < tl.length; t++) {
			E.applyMask(inp, tl[t]); sim.tick(inp);
			if (sim.is_dead && !allowDeath) return false;
			if (t + 1 < tl.length && !sim.is_dead && (beforeTick < 0 || T0 + t + 1 <= beforeTick) && goal.test(sim)) return false;
		}
		return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || T0 + tl.length <= beforeTick);
	};
	let R = trace(tail);
	let windows = 0;
	for (let b = tail.length; b > 0 && Date.now() < deadline && !(o.stop && o.stop()); ) {
		const a = Math.max(0, b - win);
		windows++;
		const last = b === tail.length;
		const sB = at(R, tail, b);
		const g = last ? goal : (() => {
			const W = L.width, H = L.height, tile = T.tileOf(sB, W, H), dk = X.discKey(sB);
			return { kind: 'region', tiles: Int32Array.of(tile), mask: null, allowDeath: false, test: (s) => !s.is_dead && T.tileOf(s, W, H) === tile && X.discKey(s) === dk };
		})();
		const sA = at(R, tail, a);
		const st0 = [{ snap: sA.snapshot(), tick: T0 + a }];
		const left = Math.max(10, (deadline - Date.now()) / Math.max(1, Math.ceil(a / win) + 1));
		const r = X.exactLeg(L, st0, g, { sim, maxDepth: (b - a) - 1, cap, deadline: Math.min(deadline, Date.now() + left), allowDeath: false,
			beforeTick: last ? beforeTick : -1, rejoin: R.last, rejoinMin: 1, collect: 1 });
		let cand = null;
		// (c) an exact rejoin with a later state of the leg (proven: the same state, sooner)
		if (r.rejoin && r.layers && r.layers[r.rejoin.depth - 1]) {
			const p = X.pathOf(r.layers, r.rejoin.depth, r.rejoin.par, r.rejoin.msk, st0, r.t0);
			const j = r.rejoin.tick - T0;
			if (p && j <= tail.length) {
				const c = new Uint8Array(a + p.tail.length + (tail.length - j));
				c.set(tail.subarray(0, a), 0); c.set(p.tail, a); c.set(tail.subarray(j), a + p.tail.length);
				if (c.length < tail.length && good(c)) cand = c;
			}
		}
		// (b) the window's region sooner (the leg's own inputs from its end: replayed to check)
		if (!cand && r.status === 'found') {
			const c = new Uint8Array(a + r.tail.length + (tail.length - b));
			c.set(tail.subarray(0, a), 0); c.set(r.tail, a); c.set(tail.subarray(b), a + r.tail.length);
			if (c.length < tail.length && good(c)) cand = c;
		}
		if (cand) {
			tail = cand; R = trace(tail);
			// (the windows before a keep their ticks: go on from a)
		}
		b = a;
	}
	return { tail, saved: tail0.length - tail.length, windows, ms: Date.now() - t0 };
}

module.exports = { polishRoute, polishLeg, traceRoute, mutatePass, bestShortcutSet, spliceShortcuts };
