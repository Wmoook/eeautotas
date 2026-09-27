'use strict';
// The grind's whole-run hunt sweep and its window memory (used by grind.js; test/sweep.js).
//
// The sweep: early in a session the grind runs `explore.js --hunt=1` windows over the WHOLE run, several at once (lanes
// of the CPU threads), the windows ranked by a cheap estimate of the time they may hold, instead of one window per
// 10-minute round walking from tick 0 (the ice level's night of 2026-09-26: the grind's windows had covered ticks
// 0-1865 after 2 h, while one hunt window over its top right took 4899 -> 4792 in 180 s; src/out/night/autotas_gaps.md).
//
// The window memory: every explored window (sweep and loop windows) leaves a record: a content-defined sample of the
// run's state hashes in it (the hashes whose low bits are 0: the same states give the same sample wherever the window
// starts, so a window shifted by an improvement before it still matches), how often it came back empty and until which
// round it rests. A window whose span and route were already searched FAILS_N times without a find rests 2, 4, 8, ...
// rounds (exponential back-off); it opens again at once when the run inside it changed (more than CHANGED of its inner
// sampled states are new: a shortcut found there by another tool, a new line through it), never for a boundary shift or
// a few-tick tweak. (The ice level's loop at (56-57, 93), which the known route also has, was explored 8 times in 2 h.)
//
// windows(n, len, step) -> [[w0, w1], ...] covering [0, n]
// sigOf(H, w0, w1) -> sorted sampled state hashes of ticks w0..w1 (H = splice.js trace().H)
// lossEstimate(tr, w0, w1, loops) -> ticks the window may hold (tr = common.replay trace; loops = loops.revisits)
// Memo(records) -> {state(sig, round), record(sig, saved, round), records}
const SAMPLE = 8;          // keep the states whose hash is 0 mod SAMPLE (content-defined: shift-invariant)
const SPAN = 0.6;          // the same span: at least 60% of each sample is in the other (windows of other sizes differ)
const EDGE = 100;          // ticks at each end left out of the "changed" test (boundary shifts)
const CHANGED = 0.05;      // the run inside changed: more than 5% of the inner sample is new
const FAILS_N = 2;         // back off after this many empty searches of the same span and route
const KEEP = 96;           // records kept (the most recently used)

const low = (h) => ((h % SAMPLE) + SAMPLE) % SAMPLE === 0;

/** Windows of `len` ticks every `step` ticks over [0, n] (the last one ends at n). */
function windows(n, len = 800, step = 600) {
	const out = [];
	if (n <= 0) return out;
	if (n <= len + step / 2) return [[0, n]];
	for (let w0 = 0; ; w0 += step) {
		const w1 = Math.min(n, w0 + len);
		if (n - w1 < step / 2 && w1 < n) { out.push([w0, n]); break; }   // (no short tail window: the last one reaches the end)
		out.push([w0, w1]);
		if (w1 >= n) break;
	}
	return out;
}

/** The sampled state hashes of ticks w0..w1 (sorted, unique). */
function sigOf(H, w0, w1) {
	const s = new Set();
	for (let t = Math.max(0, w0); t <= Math.min(H.length - 1, w1); t++) if (low(H[t])) s.add(H[t]);
	return [...s].sort((x, y) => x - y);
}
/** the sample of the inner part (EDGE ticks in from both ends; the whole window when it is short) */
function innerOf(H, w0, w1) {
	const e = w1 - w0 > 4 * EDGE ? EDGE : 0;
	return sigOf(H, w0 + e, w1 - e);
}
/** |a ∩ b| for sorted arrays */
function common(a, b) {
	let i = 0, j = 0, k = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { k++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
	}
	return k;
}

/**
 * A cheap estimate of the ticks a window may hold, from the run alone (no reference): slow ticks (at rest or crawling:
 * 1 - speed / 3 px/tick, landings, waits, bonks) plus half the length of every loop inside the window (the run comes back
 * to where it was: loops.js).
 */
function lossEstimate(tr, w0, w1, loops) {
	let slow = 0;
	for (let t = Math.max(0, w0); t < Math.min(w1, tr.X.length - 1); t++) {
		const v = Math.hypot(tr.VX[t], tr.VY[t]);
		if (v < 3) slow += 1 - v / 3;
	}
	let lp = 0;
	for (const l of loops || []) if (l.a >= w0 && l.b <= w1) lp += l.len;
	return Math.round(slow + 0.5 * lp);
}

/**
 * explore --hunt's own guide as a window's estimate: the run's time-to-go field over [w0, T0] (T0 = w1 + horizon; reach.js
 * with the run's positions as goals at (T0 - j) / kappa, like explore.js --hunt), and the largest lead of a run state in
 * the window: (T0 - t) - kappa x cost = how many ticks sooner the field says a later run state could be reached. A detour
 * whose ends the physics connects faster scores high; a fast straight stretch scores near 0. States: tr = common.replay
 * trace (X, Y), ms the inputs (replayed from 0 to w0 here). Returns {lead, at, ms: build time}.
 */
function leadEstimate(level, ms, tr, w0, w1, opts) {
	const E = require('./eesim.js'), Reach = require('./reach.js');
	const o = Object.assign({ kappa: 2, horizon: 800 }, opts || {});
	const n = tr.X.length - 1, t0 = Date.now();
	const T0 = Math.min(n, w1 + o.horizon);
	const g = new Map();
	for (let j = w0; j <= T0; j++) {
		const k = (Math.trunc(tr.Y[j] + 8) >> 4) * level.width + (Math.trunc(tr.X[j] + 8) >> 4), c = (T0 - j) / o.kappa;
		if (!(g.get(k) <= c)) g.set(k, c);
	}
	const field = Reach.reachField(level, { goals: [...g].map(([tile, cost]) => ({ tile, cost })), maxCost: (T0 - w0 + 100) / o.kappa });
	const sim = o.sim || new E.EESim(level);
	if (!o.sim) sim.reset();
	const inp = new E.EEInput();
	for (let t = o.simAt || 0; t < w0; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
	let lead = 0, at = w0;
	for (let t = w0; t <= w1 && t <= n; t++) {
		const c = Reach.costAt(field, sim);
		const l = c < 0 ? 0 : (T0 - t) - o.kappa * c;
		if (l > lead) { lead = l; at = t; }
		if (t < n) { E.applyMask(inp, ms[t]); sim.tick(inp); }
	}
	return { lead: Math.round(lead), at, ms: Date.now() - t0 };
}

/** The window memory (records as saved in grind_windows.json). */
class Memo {
	constructor(records) { this.records = Array.isArray(records) ? records.filter((r) => r && Array.isArray(r.s)) : []; }
	/** the record of the same span (the one sharing the most sampled states), or null */
	match(sig) {
		let best = null, bestF = 0;
		for (const r of this.records) {
			const k = common(sig, r.s);
			const f = Math.min(sig.length ? k / sig.length : 0, r.s.length ? k / r.s.length : 0);
			if (f >= SPAN && f > bestF) { best = r; bestF = f; }
		}
		return best;
	}
	/**
	 * What to do with a window now: {run: true|false, why, rec}. inner = innerOf() of the window (the changed test).
	 * - new span: run;  - the run inside changed since its record: run ("changed");
	 * - resting (FAILS_N+ empty searches, until round rec.next): skip;  - searched this round already, unchanged: skip.
	 */
	state(sig, inner, round) {
		const r = this.match(sig);
		if (!r) return { run: true, why: 'new', rec: null };
		const fresh = inner.length ? (inner.length - common(inner, r.s)) / inner.length : 0;
		if (fresh > CHANGED) return { run: true, why: 'changed', rec: r };
		if (r.last === round && !(r.found > 0)) return { run: false, why: 'searched this round', rec: r };
		if (r.fails >= FAILS_N && round < r.next) return { run: false, why: `resting until round ${r.next} (${r.fails} empty searches)`, rec: r };
		return { run: true, why: r.fails ? `again (${r.fails} empty)` : 'again', rec: r };
	}
	/** a search of the window ended: saved = the ticks its own output saved (0: nothing) */
	record(sig, saved, round) {
		let r = this.match(sig);
		if (!r) { r = { s: sig, fails: 0, next: 0, found: 0, last: round, n: 0 }; this.records.push(r); }
		r.s = sig; r.last = round; r.n = (r.n || 0) + 1;
		if (saved > 0) { r.fails = 0; r.next = 0; r.found = saved; }
		else {
			r.fails = (r.fails || 0) + 1; r.found = 0;
			r.next = r.fails >= FAILS_N ? round + 2 ** (r.fails - FAILS_N + 1) : 0;
		}
		// the most recently used first; at most KEEP
		this.records.sort((x, y) => (y.last || 0) - (x.last || 0));
		if (this.records.length > KEEP) this.records.length = KEEP;
		return r;
	}
}

module.exports = { windows, sigOf, innerOf, lossEstimate, leadEstimate, Memo, SAMPLE, FAILS_N, CHANGED, EDGE };
