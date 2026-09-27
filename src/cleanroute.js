'use strict';
// Route cleanup: Find a route's routes come from random runs (goexplore.js's CPU runs, eegpu roll's GPU runs: every
// input drawn from 18 options, jump in half of them), so a route keeps jump presses, up / down presses and direction
// flips that do nothing or cost time. cleanRoute() drops them greedily while the route still finishes and is not slower:
// edits in order through the route (each maximal run of held jump: jump off, else only the ticks whose press jumped;
// each maximal run of up / down: off; each short horizontal run between two equal ones (R L R, R - R): the neighbours'
// direction), each one replayed from a snapshot before it with the route's own inputs after it, and kept when
//   - its state equals the route's at the same tick (stateHash, exact) at or after the edit's end: the rest is the
//     same run (an edit that did nothing);
//   - or its state equals the route's at a LATER tick: the route from there, sooner (a shortcut, mutate.js's rejoin);
//   - or (the second pass only, while the budget lasts; no rejoin within `horizon` ticks) the edited route played on to
//     the end finishes with no more deaths and no more run ticks.
// Passes: rejoins only (cheap), then one with the edited routes played to the end, then rejoins again while a pass keeps
// edits. The result is replayed from the start (C.evaluate) and kept only when it finishes with no more run ticks, no
// more deaths and no lower random-portal chance than the route given; else the route given comes back unchanged.
//
// node src/cleanroute.js <route.eetas> --level=<level id | job id | level.json | level.eelvl> [--out=<file>]
//      [--ms=5000] [--budget=<sim ticks>] [--horizon=240] [--passes=4] [--kinds=jump,vert,flip]
//      [--cosmetic=1 (only edits that change no state: the same states and time, no shortcut)]
// prints the counts before / after (jump presses, input changes per second) and what each kind of edit kept.

const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;

const SNAP_EVERY = 32;     // a snapshot of the route every 32 ticks (the edits replay from the one before them)
const FLIP_MAX = 12;       // a horizontal run of at most 12 ticks between two equal ones is a flip
const JUMP = 1, HORIZ = 6, VERT = 24;

/** counts of a run's inputs: presses (jump off -> on), ticks with jump held, input changes, direction flips (L <-> R
 *  with or without a gap of no direction), per second (100 ticks) too */
function inputStats(masks) {
	const n = masks.length;
	let presses = 0, held = 0, changes = 0, flips = 0, vert = 0, lastH = 0;
	for (let t = 0; t < n; t++) {
		const m = masks[t], p = t ? masks[t - 1] : 0;
		if ((m & JUMP) && !(p & JUMP)) presses++;
		if (m & JUMP) held++;
		if (m & VERT) vert++;
		if (t && m !== p) changes++;
		const h = m & HORIZ;
		if (h === 2 || h === 4) { if (lastH && h !== lastH) flips++; lastH = h; }
	}
	const ps = (x) => Math.round((x * 100 / Math.max(1, n)) * 100) / 100;
	return { ticks: n, presses, pressesPerS: ps(presses), jumpHeld: Math.round(held / Math.max(1, n) * 1000) / 1000, changesPerS: ps(changes),
		flips, flipsPerS: ps(flips), vertHeld: Math.round(vert / Math.max(1, n) * 1000) / 1000 };
}

/**
 * The route's replay: per tick (index = ticks played) the state hash, a map hash -> the last tick with it (a stale
 * entry, whose tick has another hash since, is ignored: `R.H[v] === h` is checked), snapshots every SNAP_EVERY ticks,
 * the deaths so far, the ticks whose input jumped. `replayRef(R, masks, a, u)`: the same for ticks a..u of an edited
 * route whose state at u is the old one's (a kept edit that rejoined at the same tick: the rest stays).
 */
function reference(level, masks) {
	const n = masks.length;
	const R = { H: new Float64Array(n + 1), D: new Int32Array(n + 1), J: new Uint8Array(n + 1), at: new Map(), snaps: [], complete: -1, runTicks: 0,
		deaths: 0, n, sim: new E.EESim(level), inp: new E.EEInput() };
	R.sim.reset();
	replayRef(R, masks, 0, n);
	return R;
}
function replayRef(R, masks, a, u) {
	const sim = R.sim, inp = R.inp, whole = a === 0 && u === R.n;
	const s = whole ? 0 : Math.floor(a / SNAP_EVERY) * SNAP_EVERY;
	if (!whole) sim.restore(R.snaps[s / SNAP_EVERY]);
	let deaths = whole ? 0 : R.D[s];
	sim.onEvent = (k) => {
		if (k === 'complete') { if (whole && R.complete < 0) R.complete = sim.ticks(); }
		else if (k === 'death') deaths++;
		else if (k === 'jump') R.J[sim.ticks()] = 1;   // (the tick whose input jumped: index = ticks played after it)
	};
	const rec = (j) => {
		const h = sim.stateHash(false);
		R.H[j] = h; R.at.set(h, j); R.D[j] = deaths;
		if (j % SNAP_EVERY === 0) R.snaps[j / SNAP_EVERY] = sim.snapshot();
	};
	if (whole) rec(0);
	R.J.fill(0, s + 1, u + 1);
	for (let t = s; t < u && !(whole && R.complete >= 0); t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		rec(t + 1);
	}
	if (whole) { R.runTicks = sim.run_ticks; R.deaths = deaths; }
}

/**
 * Greedy cleanup (see the header). level: a loaded level (E.loadLevel / prepareLevel), masks: a route that finishes.
 * o: {ms (a time budget, default 5000), budget (simulated ticks, default 40 M), horizon (240), kinds ('jump,vert,flip'),
 * passes (4)}. Returns {ms (the cleaned inputs, cut at the finish), ev (C.evaluate of them), before, after (inputStats),
 * kept {kind: {same, sooner, finish, saved}}, passes (edits kept per pass), tried, simTicks, out (the budget ran out),
 * sec, changed (false: the route given)}, or null when the route given does not finish.
 */
function cleanRoute(level, masks0, o) {
	o = o || {};
	const t0 = Date.now();
	const msBudget = o.ms > 0 ? o.ms : 5000, tickBudget = o.budget > 0 ? o.budget : 40e6, horizon = o.horizon > 0 ? o.horizon : 240;
	// (o.cosmetic: only edits whose state equals the route's at the same tick: the same states, the same time, no shortcut)
	const cosmetic = !!o.cosmetic;
	const kinds = String(o.kinds || 'jump,vert,flip').split(',');
	const ev0 = C.evaluate(level, masks0);
	if (!ev0) return null;
	let ms = Uint8Array.from(ev0.ms);
	const before = inputStats(ms);
	let R = reference(level, ms);
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	let simTicks = R.n, tried = 0, out = false, full = false, nKept = 0;
	const kept = {}, passes = [], maxPasses = o.passes > 0 ? o.passes : 4;
	for (const k of [...kinds, 'press']) kept[k] = { same: 0, sooner: 0, finish: 0, saved: 0 };
	let cand = new Uint8Array(ms.length);
	let dead = 0, finished = -1;
	sim.onEvent = (k) => { if (k === 'death') dead++; else if (k === 'complete' && finished < 0) finished = sim.ticks(); };
	const spent = () => simTicks >= tickBudget || Date.now() - t0 >= msBudget;
	/** replays the edit [a, b) -> e (the masks of those ticks) from the snapshot before a, the route's own inputs after
	 *  it; returns {ms (the new route), how, u (same: the tick it rejoined)} or null */
	const tryEdit = (a, b, e) => {
		tried++;
		const s = Math.floor(a / SNAP_EVERY) * SNAP_EVERY;
		sim.restore(R.snaps[s / SNAP_EVERY]);
		dead = R.D[s]; finished = -1;
		for (let t = s; t < a; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
		simTicks += a - s;
		const n = ms.length;
		for (let t = a; t < n; t++) {
			const m = t < b ? e[t - a] : ms[t];
			cand[t] = m;
			E.applyMask(inp, m);
			sim.tick(inp);
			simTicks++;
			const u = t + 1;
			if (finished >= 0) {
				if (cosmetic) return null;
				// (the edited run finishes: by the route's rule, no more deaths and no more run ticks)
				if (dead > R.deaths || sim.run_ticks > R.runTicks) return null;
				const r = new Uint8Array(u);
				r.set(ms.subarray(0, a)); r.set(cand.subarray(a, u), a);
				return { ms: r, how: 'finish' };
			}
			if (dead > R.deaths) return null;
			if (u < b) continue;
			const h = sim.stateHash(false);
			if (h === R.H[u] && dead === R.D[u]) {
				// (the same state at the same tick: the rest is the route's own)
				const r = Uint8Array.from(ms);
				r.set(cand.subarray(a, u), a);
				return { ms: r, how: 'same', u };
			}
			const v = cosmetic ? undefined : R.at.get(h);
			if (v !== undefined && v > u && R.H[v] === h && R.D[v] >= dead) {
				// (the route's state of tick v, sooner: the route from there)
				const r = new Uint8Array(u + n - v);
				r.set(ms.subarray(0, a)); r.set(cand.subarray(a, u), a); r.set(ms.subarray(v), u);
				return { ms: r, how: 'sooner' };
			}
			if (u - b >= horizon && (!full || spent())) { if (full) out = true; return null; }
		}
		return null;
	};
	/** a kept edit: the new route and its replay (from the edit to where it rejoined when it rejoined at the same tick,
	 *  else the whole route again) */
	const accept = (k, a, r) => {
		ms = r.ms;
		if (cand.length < ms.length) cand = new Uint8Array(ms.length);
		kept[k][r.how]++;
		nKept++;
		const old = R.runTicks;
		if (r.how === 'same') { replayRef(R, ms, a, r.u); simTicks += r.u - a + SNAP_EVERY; }
		else { R = reference(level, ms); simTicks += R.n; }
		kept[k].saved += old - R.runTicks;
	};
	/** one pass through the route, the edits in order of their start (jump off, up / down off, a flip merged); returns
	 *  the number of edits kept */
	const pass = () => {
		const k0 = nKept;
		for (let a = 0; a < ms.length; a++) {
			if (spent()) { out = true; break; }
			if (kinds.includes('jump') && (ms[a] & JUMP) && !(a && (ms[a - 1] & JUMP))) {
				let b = a;
				while (b < ms.length && (ms[b] & JUMP)) b++;
				// (the whole press off; else only the ticks whose press made a jump kept: every tick with the jump bit is a
				// fresh press, so a held jump jumps again at each landing)
				let r = tryEdit(a, b, ms.slice(a, b).map((x) => x & ~JUMP));
				if (r) accept('jump', a, r);
				else {
					const e2 = ms.slice(a, b).map((x, k) => (R.J[a + k + 1] ? x : x & ~JUMP));
					if (e2.some((x, k) => x !== ms[a + k])) { r = tryEdit(a, b, e2); if (r) accept('press', a, r); }
				}
			}
			if (a < ms.length && kinds.includes('vert') && (ms[a] & VERT) && !(a && (ms[a - 1] & VERT))) {
				let b = a;
				while (b < ms.length && (ms[b] & VERT)) b++;
				const r = tryEdit(a, b, ms.slice(a, b).map((x) => x & ~VERT));
				if (r) accept('vert', a, r);
			}
			if (a > 0 && a < ms.length && kinds.includes('flip') && (ms[a] & HORIZ) !== (ms[a - 1] & HORIZ)) {
				const h = ms[a] & HORIZ, hl = ms[a - 1] & HORIZ;
				let b = a;
				while (b < ms.length && (ms[b] & HORIZ) === h) b++;
				if (hl && b < ms.length && b - a <= FLIP_MAX && (ms[b] & HORIZ) === hl) {
					const r = tryEdit(a, b, ms.slice(a, b).map((x) => (x & ~HORIZ) | hl));
					if (r) accept('flip', a, r);
				}
			}
		}
		return nKept - k0;
	};
	// the passes: rejoins only (cheap: an edit that does not rejoin within `horizon` ticks is dropped), then one with the
	// edited route played on to the end, then rejoins again while a pass keeps edits
	passes.push(pass());
	for (let k = 1; k < maxPasses && !out; k++) {
		full = k === 1 && !cosmetic;
		const c = pass();
		passes.push(c);
		if (!c && !full) break;
	}
	let ev = C.evaluate(level, ms);
	let changed = true;
	if (!ev || ev.runTicks > ev0.runTicks || ev.deaths > ev0.deaths || ev.chance < ev0.chance - 1e-9) { ev = ev0; ms = ev0.ms; changed = false; }
	else ms = ev.ms;
	return { ms, ev, changed, before, after: inputStats(ms), kept, passes, tried, simTicks, out, sec: (Date.now() - t0) / 1000 };
}

/** the level of the editor's search from its .eelvl bytes, as editor.js inspect() builds it */
function editorLevel(buf) {
	const EL = require('./eelvl.js');
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(Buffer.from(buf)), { id: 'editor', file: 'editor.eelvl' }));
}

module.exports = { cleanRoute, inputStats, editorLevel, SNAP_EVERY, FLIP_MAX };

if (!isMainThread && workerData && workerData.cleanRoute) {
	// (editor.js: a route of Find a route cleaned in a worker thread; {eelvl, inputs ('0' + mask chars), ms, cosmetic})
	const d = workerData;
	let res = null;
	try {
		const masks = Uint8Array.from(String(d.inputs), (ch) => (ch.charCodeAt(0) - 48) & 31);
		const r = cleanRoute(editorLevel(d.eelvl), masks, { ms: d.ms, cosmetic: !!d.cosmetic });
		if (r) res = { inputs: C.eetasBytes(r.ms).toString('latin1'), runTicks: r.ev.runTicks, ticks: r.ms.length, changed: r.changed, before: r.before, after: r.after,
			kept: r.kept, passes: r.passes, tried: r.tried, simTicks: r.simTicks, out: r.out, sec: r.sec };
	} catch (e) { res = { error: String(e && e.message || e) }; }
	parentPort.postMessage(res);
} else if (require.main === module) {
	const args = C.parseArgs(process.argv.slice(2));
	const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
	if (!file) { console.log('usage: node src/cleanroute.js <route.eetas> --level=<id | job | .json | .eelvl> [--out=] [--ms=5000] [--budget=] [--horizon=240] [--passes=4] [--kinds=jump,vert,flip]'); process.exit(2); }
	let level;
	if (/\.eelvl$/i.test(String(args.level || ''))) {
		const L = require('./eelvl.js');
		level = E.prepareLevel(Object.assign(L.toSimLevel(L.readEelvl(fs.readFileSync(args.level))), { start_mode: 'reset' }));
	} else level = C.loadLevel(args.level, file);
	const masks = C.readEetas(file);
	const r = cleanRoute(level, masks, { ms: +args.ms || 0, budget: +args.budget || 0, horizon: +args.horizon || 0, kinds: args.kinds, passes: +args.passes || 0, cosmetic: args.cosmetic === '1' });
	if (!r) { console.log(JSON.stringify({ error: 'the route does not finish' })); process.exit(1); }
	if (args.out) C.writeEetas(path.resolve(args.out), r.ms);
	console.log(JSON.stringify({ runTicks: r.ev.runTicks, from: C.evaluate(level, masks).runTicks, changed: r.changed, before: r.before, after: r.after, kept: r.kept,
		passes: r.passes, tried: r.tried, simTicks: r.simTicks, out: r.out, sec: r.sec }));
}
