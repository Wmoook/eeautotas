'use strict';
// THE POLISH (n4plan, the compiler's last stage, part 'executor'): a finished route made faster by exact local search,
// never slower, every candidate replayed by the engine (common.js evaluate + judge).
//   (a2) FIRST the mutation pass (mutatePass; half of the time, passes while they gain; its first pass o.first when the
//       caller has it: the executor's workers scan the route's ranges in parallel): src/mutate.js's classic moves at
//       every tick (delete one or two ticks, replace an input by any other, delete one and replace the next), each
//       followed by the route's own inputs until an exact rejoin with a LATER route state (a proven shortcut), a rejoin
//       that is not later, 200 ticks or 96 px of drift; the shortcuts combined by DP (weighted interval scheduling), the
//       combination judged (else the largest one alone); re-anchoring at landings and wall stops (mutate.js --anchor):
//       rounds: the default reach, then 600 ticks / 200 px; T-POLISH's 10 routes (8 s each) saved 550 ticks (513 with one
//       round, 430 with the cleanup's 0.4 first, 176 without the anchors, 3
//       without the pass);
//       a raw Find a route route (Are You A God's 7,290) 6,918 in 30 s vs 7,255 (o.noMutate: off; o.horizon, o.drift,
//       o.anchors);
//   (a) then src/cleanroute.js cleanRoute (0.15 of the time): useless presses and flips dropped, rejoins and shortcuts
//       kept (it had 0.4 of the time first: no change on T-POLISH's routes);
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
	// (o.startSnap: the masks from that state (a leg), else from the level start (a route))
	if (o.startSnap) sim.restore(o.startSnap); else sim.reset();
	const H = new Float64Array(n + 1), PX = new Float64Array(n + 1), PY = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1), G = new Int8Array(n + 1);
	const last = new Map();
	const grav = (x) => x.gravity_dir.x * 3 + x.gravity_dir.y;
	const rec = (t) => { const h = sim.stateHash(); H[t] = h; PX[t] = sim.px; PY[t] = sim.py; VX[t] = sim.speed_x; VY[t] = sim.speed_y; G[t] = grav(sim); last.set(h, t); };
	// (re-anchoring, src/mutate.js --anchor: at a landing or a wall / ceiling stop of >= 1 px/tick a path ALSO goes on (a
	// branch) with the inputs of the route tick in [r - 8, r + AHEAD] of the same gravity whose state is nearest
	// (|dx| + |dy| + 3 (|dvx| + |dvy|) < ATHR), at most ANCH times a path: a move that lands sooner plays the inputs timed
	// for where it is)
	const ANCH = o.anchors >= 0 ? o.anchors : 2, AHEAD = 150, ATHR = 6;
	rec(0);
	const snaps = [sim.snapshot()];
	for (let t = 0; t < n; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); rec(t + 1); if ((t + 1) % 64 === 0) snaps[(t + 1) / 64] = sim.snapshot(); }
	const shortcuts = [];
	let ticks = 0;
	const from = Math.max(0, o.from | 0);
	// (o.ranges: [a, b) spans of start ticks to search, in order; else every tick from o.from)
	const ranges = Array.isArray(o.ranges) && o.ranges.length ? o.ranges : [[from, n - 1]];
	const seen = new Set(), seenB = new Set();
	const stack = [];
	let t = from, timeUp = false;
	outer: for (const [ra0, rb0] of ranges) {
	const ra = Math.max(0, ra0), rb = Math.min(rb0, n - 1);
	if (ra >= rb) continue;
	sim.restore(snaps[Math.floor(ra / 64)]);
	for (let u = Math.floor(ra / 64) * 64; u < ra; u++) { E.applyMask(inp, masks[u]); sim.tick(inp); }
	for (t = ra; t < rb; t++) {
		if (Date.now() > deadline || ((t & 15) === 0 && stop !== null && stop())) { timeUp = true; break outer; }
		if (!sim.is_dead) {
			const sT = sim.snapshot();
			seen.clear();
			// the moves [the first input played from S(t), the route's input index after it]: replace t by another input;
			// delete t (masks[t + 1] first) or delete t and replace t + 1 (any input, then from t + 2); delete t and t + 1
			const moves = [];
			for (const a of OPTIONS) {
				if (a !== masks[t]) moves.push([a, t + 1]);
				if (t + 2 <= n) moves.push([a, t + 2]);
			}
			if (t + 3 <= n) moves.push([masks[t + 2], t + 3]);
			seenB.clear();
			for (const [a, r0] of moves) {
				ws.restore(sT);
				E.applyMask(inp, a); ws.tick(inp); ticks++;
				// (the first state after the change: once per state and t)
				const h1 = ws.stateHash();
				if (seen.has(h1)) continue;
				seen.add(h1);
				stack.length = 0;
				stack.push({ snap: null, q: 1, r: r0, segs: [], anchors: ANCH });
				while (stack.length) {
					const P = stack.pop();
					if (P.snap !== null) ws.restore(P.snap);
					let q = P.q, r = P.r;
					const segs = P.segs, segStart = r;
					let h = P.snap !== null ? ws.stateHash() : h1;
					let pg = ws.on_ground, pvx = ws.speed_x, pvy = ws.speed_y;
					for (;;) {
						if (ws.is_dead) break;
						const j = last.get(h);
						if (j !== undefined) {
							if (j > t + q) {
								const ins = new Uint8Array(q);
								ins[0] = a;
								let k = 1;
								for (const [s0, e0] of segs) for (let u = s0; u < e0; u++) ins[k++] = masks[u];
								for (let u = segStart; u < r; u++) ins[k++] = masks[u];
								shortcuts.push({ t, j, ins, saved: j - (t + q) });
							}
							break;
						}
						if (q >= HOR || r >= n) break;
						if (Math.abs(ws.px - PX[r]) + Math.abs(ws.py - PY[r]) > DRIFT) break;
						E.applyMask(inp, masks[r]); ws.tick(inp); ticks++; q++; r++;
						h = ws.stateHash();
						if (P.anchors > 0 && !ws.is_dead) {
							const land = !pg && ws.on_ground, sx = Math.abs(pvx) >= 1 && ws.speed_x === 0, sy = Math.abs(pvy) >= 1 && ws.speed_y === 0;
							if (land || sx || sy) {
								const g = grav(ws);
								let bq = -1, bd = ATHR;
								for (let k = Math.max(t + 1, r - 8), k1 = Math.min(n - 1, r + AHEAD); k <= k1; k++) {
									if (k === r || G[k] !== g) continue;
									const d = Math.abs(ws.px - PX[k]) + Math.abs(ws.py - PY[k]) + 3 * (Math.abs(ws.speed_x - VX[k]) + Math.abs(ws.speed_y - VY[k]));
									if (d < bd) { bd = d; bq = k; }
								}
								if (bq >= 0) {
									const kb = h + ':' + bq;
									if (!seenB.has(kb)) { seenB.add(kb); stack.push({ snap: ws.snapshot(), q, r: bq, segs: segs.concat([[segStart, r]]), anchors: P.anchors - 1 }); }
								}
							}
						}
						pg = ws.on_ground; pvx = ws.speed_x; pvy = ws.speed_y;
					}
				}
			}
		}
		E.applyMask(inp, masks[t]); sim.tick(inp);
	}
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
/** the spans the shortcuts' inputs take in the spliced route, each widened by m ticks, merged */
function spansOf(set, m, n) {
	const out = [];
	let shift = 0;
	for (const c of set) {
		const a = c.t - shift, b = a + c.ins.length;
		const lo = Math.max(0, a - m), hi = Math.min(n, b + m);
		if (out.length && lo <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi); else out.push([lo, hi]);
		shift += (c.j - c.t) - c.ins.length;
	}
	return out;
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
		steps.push({ how, from: best.runTicks, to: ev.runTicks, at: Date.now() - t0 });
		best = ev;
		return true;
	};
	// (a2) the mutation pass: the classic moves everywhere, exact rejoins combined by DP (a combination the judge refuses:
	// its shortcuts one at a time, the largest first); passes while they find time and there is time (o.mutShare of it)
	if (!o.noMutate) {
		const mEnd = Math.min(deadline, Date.now() + (o.mutShare > 0 ? o.mutShare : 0.5) * (deadline - Date.now()));
		// (the first pass searches every tick; a later one only around the spans the last one spliced in: elsewhere the route
		// has the same states, so the same moves rejoin the same way, except into the new spans' own states)
		// (rounds: the default reach, then, once it gains no more, a wide one (600 ticks, 200 px: Are You A God's raw route 6,899
		// vs 6,918 in 30 s))
		const rounds = [{ horizon: o.horizon, drift: o.drift }, { horizon: 600, drift: 200 }];
		for (let ri = 0; ri < rounds.length && Date.now() < mEnd; ri++) {
		let ranges = null;
		for (let pass = 0; pass < 64 && Date.now() < mEnd; pass++) {
			const cur = best.ms;
			// (o.first: the first pass's shortcuts on this very route, found by the caller (the executor's workers in parallel))
			const mp = ri === 0 && pass === 0 && Array.isArray(o.first)
				? { shortcuts: o.first.map((c) => ({ t: c.t, j: c.j, saved: c.saved, ins: typeof c.ins === 'string' ? T.masksOf(c.ins) : Uint8Array.from(c.ins) })).filter((c) => c.j <= cur.length), timeUp: !!o.firstTimeUp }
				: mutatePass(L, cur, Object.assign({ deadline: mEnd, stop, ranges }, rounds[ri]));
			if (!mp.shortcuts.length) break;
			const set = bestShortcutSet(cur.length, mp.shortcuts);
			const saved = set.reduce((a, c) => a + c.saved, 0);
			let applied = null;
			if (accept(spliceShortcuts(cur, set), `mutate ${set.length} (${saved})`)) applied = set;
			else {
				for (const c of mp.shortcuts.slice().sort((x, y) => y.saved - x.saved).slice(0, 64)) {
					if (Date.now() > mEnd) break;
					if (accept(spliceShortcuts(cur, [c]), `mutate 1 (${c.saved})`)) { applied = [c]; break; }
				}
			}
			if (!applied || mp.timeUp) break;
			ranges = spansOf(applied, 100, best.ms.length);
		}
		}
	}
	// (a25) THE LOOPS (lane 5, TAS-perfect): a stretch where the ball comes back within LOOP_R px of where it was with nothing
	// collected or toggled in between (src/loops.js revisits: the optimizer's loop windows) is a detour the mutation's local
	// moves and the 150-tick segments cannot remove when it is longer than their reach: from the route's state LOOP_PRE ticks
	// before the loop, best-first (legs.js legBest) to the route's state region LOOP_POST ticks after it, sooner than the
	// route; spliced and re-anchored like a segment, judged. The 300-s baseline's routes hold 200-1,500 ticks of such loops
	// (Trick Or Treat 1,380, TPs The Horror 1,478, One Minute Descent 475, Tree Decorating 248, Accident Prone 201).
	// (o.noLoops or EEAT_POLISH_LOOPS=0: off; o.loopShare)
	if (!o.noLoops && process.env.EEAT_POLISH_LOOPS !== '0' && Date.now() < deadline) {
		const LG = require('./legs.js');
		const lEnd = Math.min(deadline, Date.now() + (o.loopShare > 0 ? o.loopShare : 0.25) * ms);
		const LOOP_R = 48, LOOP_PRE = 10, LOOP_POST = 40, LOOP_MS = 2000;
		const lsim = new E.EESim(L), linp = new E.EEInput();
		const grav = (x) => x.gravity_dir.x * 3 + x.gravity_dir.y;
		let loops = [];
		try { loops = require('../loops.js').revisits(L, best.ms, { coins: true, radius: LOOP_R, min: 40, max: 900, keep: 24 }); } catch (e) { loops = []; }
		// (the loops' ticks are the route's as it was when they were found; every accepted change [at, to) shifts the ticks
		// after it by its saving, and a loop overlapping a changed span is not searched)
		const edits = [];
		const mapT = (p) => { let q = p; for (const e of edits) { if (p >= e.to) q -= e.saved; else if (p > e.at) return -1; } return q; };
		for (let li = 0; li < loops.length && Date.now() < lEnd && !(stop && stop()); li++) {
			const cur = best.ms;
			const lp = loops[li];
			const a0 = mapT(Math.max(0, lp.a - LOOP_PRE)), b0 = mapT(lp.b + LOOP_POST);
			if (a0 < 0 || b0 < 0) continue;
			const a = a0, b = Math.min(cur.length - 1, b0);
			if (b - a < 20) continue;
			const R4 = traceRoute(L, cur);
			const sB = stateAt(R4, cur, b);
			if (sB.is_dead) continue;
			const W0 = L.width, H0 = L.height, tile = T.tileOf(sB, W0, H0), dk = X.discKey(sB);
			const goal = { kind: 'region', tiles: Int32Array.of(tile), mask: null, allowDeath: false, test: (x) => !x.is_dead && T.tileOf(x, W0, H0) === tile && X.discKey(x) === dk };
			const sA = stateAt(R4, cur, a);
			if (sA.is_dead) continue;
			const snapA = sA.snapshot();
			const field = T.goalField(T.levelNow(L, sA), goal.tiles);
			const r = LG.legBest(L, [{ snap: snapA, tick: a }], goal, { sim: lsim, field, deadline: Math.min(lEnd, Date.now() + LOOP_MS), stop, depthMax: b - a - 1, kbOn: true, w: 3, noFinish: true });
			if (r.status !== 'found' || !(r.depth < b - a)) continue;
			const tail = r.tail;
			const cands = [];
			{ const c = new Uint8Array(a + tail.length + (cur.length - b)); c.set(cur.subarray(0, a), 0); c.set(tail, a); c.set(cur.subarray(b), a + tail.length); cands.push(['plain', c]); }
			lsim.restore(snapA);
			for (let t = 0; t < tail.length; t++) { E.applyMask(linp, tail[t]); lsim.tick(linp); }
			const px = lsim.px, py = lsim.py, vx = lsim.speed_x, vy = lsim.speed_y, g = grav(lsim);
			const q0 = Math.max(a + 1, b - 8), q1 = Math.min(cur.length - 1, b + 150);
			const rs = stateAt(R4, cur, q0), ranked = [];
			for (let q = q0; q <= q1; q++) {
				if (grav(rs) === g) ranked.push([Math.abs(px - rs.px) + Math.abs(py - rs.py) + 3 * (Math.abs(vx - rs.speed_x) + Math.abs(vy - rs.speed_y)), q]);
				E.applyMask(R4.inp, cur[q]); rs.tick(R4.inp);
			}
			ranked.sort((x, y) => x[0] - y[0]);
			for (const [, q] of ranked.slice(0, 6)) { if (q === b) continue; const c = new Uint8Array(a + tail.length + (cur.length - q)); c.set(cur.subarray(0, a), 0); c.set(tail, a); c.set(cur.subarray(q), a + tail.length); cands.push([`anchor ${q}`, c]); }
			for (const [how, c] of cands) {
				if (Date.now() > deadline) break;
				const n0 = cur.length;
				// (in the loops' own ticks: the change spans the loop's window; the route after it is shorter by the saving)
				if (accept(c, `loop ${a}->${b} in ${tail.length} (${how})`)) { edits.push({ at: Math.max(0, lp.a - LOOP_PRE), to: lp.b + LOOP_POST + (how === 'plain' ? 0 : 150), saved: n0 - best.ms.length }); break; }
			}
		}
	}
	// (a28) THE TROPHY TAILS (lane 5, TAS-perfect): the route's last W ticks (W = TAIL_WINS 200, 400, 800, 1600, ... up to
	// the route) searched again from the route's state at F - W with the TROPHY as the goal (not the route's state region:
	// that holds the route's door-reading state, keys and coins taken included, so a segment keeps every detour the route
	// made for an optional trigger), best-first (legs.js legBest, the kinematic bound in its ranking), depth W - 1: any
	// finish it finds is faster; judged. Tutorial 1's route takes 2 keys after its 3rd coin (key doors on the executor's
	// way: 965 ticks to the trophy, the best known 790 without keys). OPT-IN (o.tails or EEAT_POLISH_TAILS=1; o.tailShare):
	// NEGATIVE as measured (tools/cmp/polcurve.js, box 5, 60 s on the 300-s baseline's routes of 6 levels): one tail found
	// (TPs The Horror -2), and the time it took from the segments lost Accident Prone's -88 (3,206 vs 3,118) and One Minute
	// Descent's -18: best-first over 200-1,600 ticks in 1.5-30 s does not find the other ways.
	if ((o.tails || process.env.EEAT_POLISH_TAILS === '1') && Date.now() < deadline) {
		const LG = require('./legs.js');
		const tEnd = Math.min(deadline, Date.now() + (o.tailShare > 0 ? o.tailShare : 0.2) * ms);
		const TAIL_MS = 1500;
		const tsim = new E.EESim(L);
		let bt = null;
		try { bt = X.boundFor(L, { kind: 'trophy', tiles: [] }); } catch (e) { bt = null; }
		const cells = bt && bt.cells ? Int32Array.from(bt.cells) : null;
		for (let W = 200; cells && cells.length && Date.now() < tEnd && !(stop && stop()); W *= 2) {
			const cur = best.ms;
			const F = cur.length;
			const a = Math.max(0, F - W);
			const R5 = traceRoute(L, cur);
			const sA = stateAt(R5, cur, a);
			if (sA.is_dead) { if (a === 0) break; continue; }
			const snapA = sA.snapshot();
			const goal = { kind: 'trophy', tiles: cells, mask: null, allowDeath: false, test: (x) => !!x.has_silver_crown };
			const field = T.goalField(T.levelNow(L, sA), goal.tiles);
			const share = Math.max(TAIL_MS, (tEnd - Date.now()) / 2);
			const r = LG.legBest(L, [{ snap: snapA, tick: a }], goal, { sim: tsim, field, deadline: Math.min(tEnd, Date.now() + share), stop, depthMax: F - a - 1, kbOn: true, w: 3, noFinish: true });
			if (r.status === 'found' && r.depth < F - a) accept(T.concat(cur.subarray(0, a), r.tail), `tail ${a}->${F} to the trophy in ${r.tail.length}`);
			if (a === 0) break;
		}
	}
	// (a3) the segments: from the route's state at a, best-first (legs.js legBest: the kinematic bound in its ranking,
	// w 3) to the route's state region at b = a + SEG (the tile, the door-reading state) sooner, windows from the end back
	// every SEG_STEP ticks, SEG_MS each at most; spliced with the route's inputs from b, else re-anchored at the nearest
	// route state of the same gravity in [b - 8, b + 150] (6 tried); judged. The mutation's local moves cannot change a
	// route's way over 150 ticks: a compiled route (test/planexec.js --only=chain, Tutorial 1 from a 150-tick skeleton)
	// 2,450 -> 2,382 in 26 s where the mutation and the windows gave 2,411 in 30 s. (o.noSegments: off; o.segShare)
	if (!o.noSegments && process.env.EEAT_POLISH_SEG !== '0') {
		const LG = require('./legs.js');
		const sEnd = Math.min(deadline, Date.now() + (o.segShare > 0 ? o.segShare : 0.35) * ms);
		const SEG = o.segWin > 0 ? o.segWin : 150, STEP = o.segStep > 0 ? o.segStep : 50, SEG_MS = 1000;
		const ssim = new E.EESim(L), sinp = new E.EEInput();
		const grav = (x) => x.gravity_dir.x * 3 + x.gravity_dir.y;
		let R3 = traceRoute(L, best.ms);
		for (let b = best.ms.length - 1; b > SEG && Date.now() < sEnd && !(stop && stop()); b -= STEP) {
			const cur = best.ms;
			const a = b - SEG;
			const sB = stateAt(R3, cur, b);
			if (sB.is_dead) continue;
			const W0 = L.width, H0 = L.height, tile = T.tileOf(sB, W0, H0), dk = X.discKey(sB);
			const goal = { kind: 'region', tiles: Int32Array.of(tile), mask: null, allowDeath: false, test: (x) => !x.is_dead && T.tileOf(x, W0, H0) === tile && X.discKey(x) === dk };
			const sA = stateAt(R3, cur, a);
			if (sA.is_dead) continue;
			const snapA = sA.snapshot();
			const field = T.goalField(T.levelNow(L, sA), goal.tiles);
			const r = LG.legBest(L, [{ snap: snapA, tick: a }], goal, { sim: ssim, field, deadline: Math.min(sEnd, Date.now() + SEG_MS), stop, depthMax: SEG - 1, kbOn: true, w: 3, noFinish: true });
			if (r.status !== 'found' || !(r.depth < SEG)) continue;
			const tail = r.tail;
			const cands = [];
			{ const c = new Uint8Array(a + tail.length + (cur.length - b)); c.set(cur.subarray(0, a), 0); c.set(tail, a); c.set(cur.subarray(b), a + tail.length); cands.push(['plain', c]); }
			// (the anchors: the route's states near b, by the rule of mutatePass)
			ssim.restore(snapA);
			for (let t = 0; t < tail.length; t++) { E.applyMask(sinp, tail[t]); ssim.tick(sinp); }
			const px = ssim.px, py = ssim.py, vx = ssim.speed_x, vy = ssim.speed_y, g = grav(ssim);
			const q0 = Math.max(a + 1, b - 8), q1 = Math.min(cur.length - 1, b + 150);
			const rs = stateAt(R3, cur, q0), ranked = [];
			for (let q = q0; q <= q1; q++) {
				if (grav(rs) === g) ranked.push([Math.abs(px - rs.px) + Math.abs(py - rs.py) + 3 * (Math.abs(vx - rs.speed_x) + Math.abs(vy - rs.speed_y)), q]);
				E.applyMask(R3.inp, cur[q]); rs.tick(R3.inp);
			}
			ranked.sort((x, y) => x[0] - y[0]);
			for (const [, q] of ranked.slice(0, 6)) { if (q === b) continue; const c = new Uint8Array(a + tail.length + (cur.length - q)); c.set(cur.subarray(0, a), 0); c.set(tail, a); c.set(cur.subarray(q), a + tail.length); cands.push([`anchor ${q}`, c]); }
			for (const [how, c] of cands) {
				if (Date.now() > deadline) break;
				if (accept(c, `segment ${a}->${b} in ${tail.length} (${how})`)) {
					// (the mutation's passes around the new span: its states are new rejoin targets and starts)
					let ranges = [[Math.max(0, a - 100), Math.min(best.ms.length, a + tail.length + 100)]];
					const mEnd2 = Math.min(sEnd, Date.now() + 1000);
					for (let pass = 0; pass < 8 && Date.now() < mEnd2 && !o.noMutate; pass++) {
						const cur2 = best.ms;
						const mp = mutatePass(L, cur2, { deadline: mEnd2, stop, ranges, horizon: o.horizon, drift: o.drift });
						if (!mp.shortcuts.length) break;
						const set = bestShortcutSet(cur2.length, mp.shortcuts);
						if (!accept(spliceShortcuts(cur2, set), `mutate ${set.length} (${set.reduce((x, y) => x + y.saved, 0)})`)) break;
						ranges = spansOf(set, 100, best.ms.length);
					}
					R3 = traceRoute(L, best.ms);
					break;
				}
			}
		}
	}
	// (a) the cleanup (src/cleanroute.js: presses and flips dropped where they rejoin or finish sooner)
	if (!o.noClean && Date.now() < deadline) {
		try {
			const CR = require('../cleanroute.js');
			const r = CR.cleanRoute(L, best.ms, { ms: Math.max(50, Math.min(deadline - Date.now(), 0.15 * ms)) });
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
	// (the mutation pass first, as polishRoute's (a2): the classic moves with exact rejoins on the leg's own states, from
	// its start state; half of the time)
	let mutated = 0;
	if (!o.noMutate && process.env.EEAT_LEG_MUT !== '0') {
		const mEnd = Math.min(deadline, t0 + (o.mutShare > 0 ? o.mutShare : 0.5) * (deadline - t0));
		let ranges = null;
		for (let pass = 0; pass < 32 && Date.now() < mEnd && !(o.stop && o.stop()); pass++) {
			const mp = mutatePass(L, tail, { startSnap: start.snap, deadline: mEnd, stop: o.stop, ranges });
			if (!mp.shortcuts.length) break;
			const set = bestShortcutSet(tail.length, mp.shortcuts);
			let applied = null;
			const c0 = spliceShortcuts(tail, set);
			if (good(c0)) { applied = set; tail = c0; }
			else {
				for (const c of mp.shortcuts.slice().sort((x, y) => y.saved - x.saved).slice(0, 32)) {
					const c1 = spliceShortcuts(tail, [c]);
					if (good(c1)) { applied = [c]; tail = c1; break; }
				}
			}
			if (!applied) break;
			mutated += applied.reduce((a, c) => a + c.saved, 0);
			if (mp.timeUp) break;
			ranges = spansOf(applied, 100, tail.length);
		}
	}
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
	return { tail, saved: tail0.length - tail.length, mutated, windows, ms: Date.now() - t0 };
}

module.exports = { polishRoute, polishLeg, traceRoute, mutatePass, bestShortcutSet, spliceShortcuts, spansOf };
