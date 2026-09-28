'use strict';
// flybeam.js: the corridor beam, a NON-EXACT optimizer for long low-contact stretches (fly, low gravity, ice arcs) where
// a faster line shares no exact state with the run for 1,000+ ticks, so the exact-rejoin windows (<= ~800 ticks) cannot
// carry it. The guide line is the run itself (never another TAS).
//
// From the run's exact state at tick A an every-move beam (all 18 inputs every tick):
//   - progress g of a state = the LATEST tick of the run (within `look` ticks ahead) whose ball is within rMatch px of the
//     state's ball (a line that skips one of the run's loops or zigzags jumps ahead), else the nearest such tick in the
//     5 x 5 tiles around, else the nearest in a small window; score = g - alpha * (distance to the run's ball at g) /
//     (the run's speed there); states farther than `corridor` px from the run's path are dropped;
//   - states merged one per cell (Q-px position, V px/tick velocity, the discrete state: goexplore.js discreteOf), the
//     best score per cell; the next beam = the run's own next state (always: the beam can leave the run at any tick),
//     then at most capT states per tile by score (diversity: a purely greedy beam on Infinity Pain's shaft ran all its
//     states into one spike line and died out in 128 ticks), then the rest by score, W in all;
//   - optional homing channel (--convF, off by default): convF x W of the beam for the states AHEAD of the run nearest
//     the run's own state there (position + vw x velocity), one per fine cell (1 px, 1/16 px/tick).
// Rejoins (exact: the rest of the run stays valid): a child whose x equals one of the run's later x values is hashed and
// looked up among the run's later states (a DIRECT rejoin); each layer the tailP beam states ahead of the run nearest the
// run's state at g-1..g+1 get a TAIL probe: the run's own inputs from there, up to tailH ticks, an exact rejoin checked
// every tick. A rejoin into the run's tick T from a beam state at A + k saves T - (A + k + tail) ticks. Every task (one
// start A, one setting) keeps its best rejoin per 25-tick bucket of T; the main thread picks the best non-overlapping
// set over all tasks (DP over [A, T)), splices it into the run and replay-verifies it (C.evaluate + C.judge).
//
// node src/flybeam.js --level=<level .json | id | job> --tas=<run.eetas> [--from=0] [--to=<finish>] [--starts=<every N>]
//   [--startList=a,b,..] [--toEnd=1 (every start runs to --to)] [--threads=8 | --workers=] [--W=4096] [--Q=4] [--V=0.25]
//   [--alpha=0.3] [--corridor=48] [--rMatch=12] [--look=800] [--ext=600 (past B)] [--tailP=24] [--tailH=300] [--vw=16]
//   [--convF=0] [--timeS=300 (per task)] [--seconds= (all tasks)] [--deadline=<ms epoch>] [--nocoins=1]
//   [--state=<file> (a pass continued across calls: the next start by tick + state hash)] [--cfg=<json list of setting
//   overrides: each start runs every one>] [--out=<file.eetas> (written only when judged faster)] [--json=<file>]
//   [--debug=<every N layers>] [--axes=1 (diagnostic: children whose x or y state alone equals a later run state)]
//   [--order=stretch (with --starts: the starts by their longest low-contact stretch first; --state then keeps the starts done;
//   a start whose task the call's end cut short is not done)] [--wrap=0 (with --order=stretch: every start done = no search,
//   "every start done"; default: the pass starts over)]
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const C = require('./common.js');
const E = C.E;

const MASKS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) MASKS.push(h | v | j);

/** The run's per-tick trace: X, Y, VX, VY (ball after t inputs), hashes, the first tick of each hash (t > 0). */
function traceRun(level, ms, noCoins) {
	const n = ms.length;
	const sim = new E.EESim(level); sim.reset();
	const inp = new E.EEInput();
	const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1), H = new Float64Array(n + 1);
	// K[t] = 1: a contact at tick t (on the ground, or a velocity stopped by a wall / ceiling): where lines re-merge
	const K = new Uint8Array(n + 1);
	const rec = (t) => {
		X[t] = sim.px; Y[t] = sim.py; VX[t] = sim.speed_x; VY[t] = sim.speed_y; H[t] = sim.stateHash(false, noCoins === true);
		K[t] = sim.on_ground || (t > 0 && ((VX[t] === 0 && VX[t - 1] !== 0) || (VY[t] === 0 && VY[t - 1] !== 0))) ? 1 : 0;
	};
	rec(0);
	let complete = -1;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); };
	for (let t = 0; t < n; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); rec(t + 1); }
	sim.onEvent = null;
	return { n, X, Y, VX, VY, H, K, complete };
}

/**
 * The starts in the stretch order (--order=stretch): every `every` ticks in [from, to), ranked by the longest contact-free
 * stretch (no ground, no wall / ceiling stop: K) through the start's window [s, s + every), then by the window's
 * contact-free share, then by tick. The beam pays only there (a faster line in a long low-contact stretch shares no exact
 * state with the run for 1,000+ ticks); in tick order a few threads reach the late stretches after hours: Infinity Pain's
 * 39,410 run has 99 starts and the shaft (the -142 at 33250 -> 34365) ranks 1-6 by this order, 83-88 by tick; the ice
 * level's arc (2400 -> 3278 -49) ranks 1-2 of 12.
 */
function stretchOrder(K, n, from, to, every) {
	const runLen = new Int32Array(n + 1);
	for (let t = 0; t <= n;) {
		if (K[t]) { t++; continue; }
		let u = t; while (u <= n && !K[u]) u++;
		for (let k = t; k < u; k++) runLen[k] = u - t;
		t = u;
	}
	const rows = [];
	for (let s = from; s < to; s += every) {
		let best = 0, free = 0;
		const e = Math.min(n, s + every);
		for (let t = s; t < e; t++) { if (runLen[t] > best) best = runLen[t]; if (!K[t]) free++; }
		rows.push({ s, best, free: free / Math.max(1, e - s) });
	}
	rows.sort((x, y) => y.best - x.best || y.free - x.free || x.s - y.s);
	return rows;
}

function runTask(task) {
	const level = C.loadLevel(task.level);
	const ms = C.readEetas(task.tas);
	const NC = task.noCoins === true;
	const R = task.R || traceRun(level, ms, NC);
	const { X, Y, VX, VY, H } = R;
	const n = Math.min(R.n, R.complete > 0 ? R.complete : R.n);
	const A = task.A, Zend = Math.min(n, task.B + task.ext);
	const W = task.W, Q = task.Q, V = task.V, alpha = task.alpha, corridor2 = task.corridor * task.corridor, rM2 = task.rMatch * task.rMatch;
	const LOOK = task.look, tailP = task.tailP, tailH = task.tailH, capT = task.capT || Math.max(4, W >> 5), convF = task.convF === undefined ? 0 : task.convF, VW = task.vw || 16, homeMax = task.homeMax || 64, homeFine = task.homing === 'fine';
	const WB = Math.round(W * convF);
	const GX = require('./goexplore.js');
	const disc = GX.discreteOf(level);
	// the run's later states: hash -> first tick > A; x values for a cheap prefilter
	const at = new Map(), xs = new Set();
	for (let t = n; t > A; t--) { at.set(H[t], t); xs.add(X[t]); }
	// (diagnostic, --axes=1) the run's per-axis states: x = (px, vx), y = (py, vy) -> the first tick > A
	const axX = new Map(), axY = new Map();
	if (task.axes) for (let t = n; t > A; t--) { axX.set(X[t] * 1e6 + VX[t], t); axY.set(Y[t] * 1e6 + VY[t], t); }
	let hitX = 0, hitY = 0, leadX = -1, leadY = -1;
	// tile index of the run's ticks A..Zend+LOOK (ball centre)
	const tiles = new Map();
	const tEnd = Math.min(n, Zend + LOOK);
	for (let t = A; t <= tEnd; t++) {
		const k = (Math.floor((X[t] + 8) / 16) << 12) | Math.floor((Y[t] + 8) / 16);
		let a = tiles.get(k); if (!a) tiles.set(k, a = []); a.push(t);
	}
	// run speed per tick (px/tick, at least 0.5)
	const spd = (t) => Math.max(0.5, Math.hypot(VX[t], VY[t]));
	// progress: the latest run tick in [g-8, g+LOOK] within rMatch px, else the nearest in [g-4, g+16]
	const progress = (g, x, y, out) => {
		const cx = Math.floor((x + 8) / 16), cy = Math.floor((y + 8) / 16);
		let best = -1, bd = 0, near = -1, nd = Infinity;
		const lo = g - 8, hi = g + LOOK;
		for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
			const a = tiles.get(((cx + dx) << 12) | (cy + dy));
			if (!a) continue;
			for (let i = a.length - 1; i >= 0; i--) {
				const t = a[i];
				if (t > hi) continue;
				if (t < lo) break;
				const ex = X[t] - x, ey = Y[t] - y, d2 = ex * ex + ey * ey;
				if (d2 <= rM2) { if (t > best) { best = t; bd = d2; } }
				else if (d2 < nd || (d2 === nd && t > near)) { nd = d2; near = t; }
			}
		}
		if (best < 0 && near >= 0) { best = near; bd = nd; }
		if (best < 0) {
			bd = Infinity;
			for (let t = Math.max(A, g - 4), e = Math.min(tEnd, g + 16); t <= e; t++) {
				const ex = X[t] - x, ey = Y[t] - y, d2 = ex * ex + ey * ey;
				if (d2 <= bd) { bd = d2; best = t; }
			}
		}
		out.g = best; out.d2 = bd;
	};

	const sim = new E.EESim(level); sim.reset();
	const inp = new E.EEInput();
	let died = false, done = false;
	sim.onEvent = (k) => { if (k === 'death') died = true; else if (k === 'complete') done = true; };
	for (let t = 0; t < A; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
	if (sim.stateHash(false, NC) !== H[A]) throw new Error('replay mismatch at A');

	// beam storage: per layer the survivors' parent + mask (for the inputs of a rejoin)
	const par = [], msk = [];
	let beam = [{ s: sim.snapshot(), g: A, score: 0, isR: true }];
	par.push(new Int32Array([-1])); msk.push(new Uint8Array([0]));
	const pool = [];
	const t0 = Date.now();
	const found = new Map();          // bucket of T -> {saving, T, inputs}
	let bestSaving = 0, sims = 0, direct = 0, tails = 0, layers = 0, maxLead = -1e9;
	const inputsOf = (k, i) => {      // the beam inputs of survivor i of layer k (k inputs)
		const out = new Array(k);
		for (let l = k; l > 0; l--) { out[l - 1] = msk[l][i]; i = par[l][i]; }
		return out;
	};
	const record = (T, used, mk) => {
		const saving = T - A - used;
		if (saving <= 0) return;
		const b = Math.floor(T / 25);
		const f = found.get(b);
		if (f && f.saving >= saving) return;
		const inputs = mk();
		if (inputs.length !== used) throw new Error('inputs length');
		found.set(b, { A, T, saving, inputs });
		if (saving > bestSaving) bestSaving = saving;
	};
	const pr = { g: 0, d2: 0 };
	let timeCut = false;
	for (let k = 0; ; k++) {
		const tick = A + k;           // the beam's states are at run tick A+k (after k inputs)
		if (beam.length === 0 || tick >= Zend || beam[0].g >= Zend) break;
		if ((Date.now() - t0) / 1000 > task.timeS) { timeCut = true; break; }
		layers = k;
		const cells = new Map(), cellsB = new Map();
		const slots = [], slotsB = [];
		let rSlot = null;             // the run's own next state (kept whatever its score: the beam can always leave the run later)
		for (let i = 0; i < beam.length; i++) {
			const st = beam[i];
			for (let mi = 0; mi < MASKS.length; mi++) {
				const m = MASKS[mi];
				const isR = st.isR === true && m === ms[tick];
				sim.restore(st.s);
				died = false; done = false;
				E.applyMask(inp, m); sim.tick(inp); sims++;
				if (died) continue;
				const x = sim.px, y = sim.py;
				if (isR) {
					rSlot = pool.length ? pool.pop() : { s: null, g: 0, score: 0, p: 0, m: 0, isR: false };
					rSlot.s = sim.snapshot(rSlot.s); rSlot.g = tick + 1; rSlot.score = -Infinity; rSlot.p = i; rSlot.m = m; rSlot.isR = true;
					continue;
				}
				if (done) { record(n, k + 1, () => { const a = inputsOf(k, i); a.push(m); return a; }); continue; }
				if (xs.has(x)) {
					const T = at.get(sim.stateHash(false, NC));
					if (T !== undefined && T > tick + 1) { direct++; record(T, k + 1, () => { const a = inputsOf(k, i); a.push(m); return a; }); }
				}
				if (task.axes) {
					const tx = axX.get(x * 1e6 + sim.speed_x), ty = axY.get(y * 1e6 + sim.speed_y);
					if (tx !== undefined && tx > tick + 2) { hitX++; leadX = Math.max(leadX, tx - tick - 1); }
					if (ty !== undefined && ty > tick + 2) { hitY++; leadY = Math.max(leadY, ty - tick - 1); }
				}
				progress(st.g, x, y, pr);
				if (pr.d2 > corridor2) continue;
				const g = pr.g;
				const score = g - alpha * Math.sqrt(pr.d2) / spd(g);
				const key = Math.floor(x / Q) + 4096 * (Math.floor(y / Q) + 4096 * (Math.round(sim.speed_x / V) + 128 + 256 * (Math.round(sim.speed_y / V) + 128))) + 2 ** 44 * (disc(sim) & 511);
				const si = cells.get(key);
				if (si === undefined) {
					const o = pool.length ? pool.pop() : { s: null, g: 0, score: 0, p: 0, m: 0, isR: false };
					o.s = sim.snapshot(o.s); o.g = g; o.score = score; o.p = i; o.m = m; o.isR = false; o.tile = (Math.floor((x + 8) / 16) << 12) | Math.floor((y + 8) / 16);
					o.x = x; o.y = y; o.vx = sim.speed_x; o.vy = sim.speed_y;
					cells.set(key, slots.length); slots.push(o);
				} else if (score > slots[si].score) {
					const o = slots[si];
					o.s = sim.snapshot(o.s); o.g = g; o.score = score; o.p = i; o.m = m;
					o.x = x; o.y = y; o.vx = sim.speed_x; o.vy = sim.speed_y;
				}
				// the homing channel: a state ahead of the run, by its distance to the run's state (position + VW x velocity)
				// at its progress tick +-2, one per fine cell (1 px, 1/16 px/tick): the nearest kept
				if (WB > 0 && homeFine && g - tick - 1 >= 1) {
					const vx = sim.speed_x, vy = sim.speed_y;
					let bc = Infinity;
					for (let t = Math.max(tick + 2, g - 2), e = Math.min(n - 1, g + 2); t <= e; t++) {
						const c = Math.abs(x - X[t]) + Math.abs(y - Y[t]) + VW * (Math.abs(vx - VX[t]) + Math.abs(vy - VY[t]));
						if (c < bc) bc = c;
					}
					if (bc < homeMax) {
						const kb = Math.floor(x) + 8192 * (Math.floor(y) + 8192 * (Math.round(vx * 16) + 512 + 1024 * (Math.round(vy * 16) + 512)));
						const hi2 = cellsB.get(kb);
						if (hi2 === undefined) {
							const o = pool.length ? pool.pop() : { s: null, g: 0, score: 0, p: 0, m: 0, isR: false };
							o.s = sim.snapshot(o.s); o.g = g; o.score = score; o.p = i; o.m = m; o.isR = false; o.c = bc; o.tile = -1;
							o.x = x; o.y = y; o.vx = vx; o.vy = vy;
							cellsB.set(kb, slotsB.length); slotsB.push(o);
						} else if (bc < slotsB[hi2].c) {
							const o = slotsB[hi2];
							o.s = sim.snapshot(o.s); o.g = g; o.score = score; o.p = i; o.m = m; o.c = bc;
							o.x = x; o.y = y; o.vx = vx; o.vy = vy;
						}
					}
				}
			}
		}
		slots.sort((a, b) => b.score - a.score);
		// selection: at most capT states per tile first (diversity: a greedy beam all ran into one spike line), then the
		// rest by score; the run's own state always
		const next = [];
		if (rSlot) next.push(rSlot);
		const now1 = tick + 1;
		// channel B (convF of the beam): the states AHEAD of the run (their progress tick > now) whose position and velocity
		// are nearest the run's own state there: they ride along the run's line in less time, so where the run's state is
		// absorbed (a wall stop, the grid alignment of a slow ball, a thrust run out) they are absorbed into it too: an
		// exact rejoin. Channel A (the rest): by score, at most capT per tile first.
		if (WB > 0 && !homeFine) {
			// (the default homing, 'slots': the WB states ahead of the run nearest its own state among the score cells'
			// states; Infinity Pain's shaft, 32627 -> 34365: -121, where the beam without it found no rejoin at all)
			for (const o of slots) {
				if (o.g - tick - 1 < 1) continue;
				let bc = Infinity;
				for (let t = Math.max(tick + 2, o.g - 2), e = Math.min(n - 1, o.g + 2); t <= e; t++) {
					const c = Math.abs(o.x - X[t]) + Math.abs(o.y - Y[t]) + VW * (Math.abs(o.vx - VX[t]) + Math.abs(o.vy - VY[t]));
					if (c < bc) bc = c;
				}
				o.c = bc; o.pick = -1; slotsB.push(o);
			}
			slotsB.sort((a, b) => a.c - b.c);
			const nb = Math.min(WB, slotsB.length);
			for (let i = 0; i < nb; i++) { slotsB[i].pick = tick + 1; next.push(slotsB[i]); }
			if (task.debug && k % task.debug === 0 && slotsB.length) console.error(`[flybeam ${task.name}] tick ${tick + 1}: homing ${slotsB.length}, nearest c ${slotsB[0].c.toFixed(4)} (lead ${slotsB[0].g - tick - 1})`);
		} else if (WB > 0) {
			slotsB.sort((a, b) => a.c - b.c);
			const nb = Math.min(WB, slotsB.length);
			for (let i = 0; i < nb; i++) next.push(slotsB[i]);
			for (let i = nb; i < slotsB.length; i++) pool.push(slotsB[i]);
			if (task.debug && k % task.debug === 0 && slotsB.length) console.error(`[flybeam ${task.name}] tick ${tick + 1}: homing ${slotsB.length}, nearest c ${slotsB[0].c.toFixed(4)} (lead ${slotsB[0].g - tick - 1}), 10th ${slotsB[Math.min(9, slotsB.length - 1)].c.toFixed(3)}`);
		}
		const perTile = new Map(), rest = [];
		for (const o of slots) {
			if (!homeFine && o.pick === tick + 1) continue;
			if (next.length >= W) { rest.push(o); continue; }
			const c = perTile.get(o.tile) || 0;
			if (c < capT) { perTile.set(o.tile, c + 1); next.push(o); } else rest.push(o);
		}
		let ri = 0;
		for (; ri < rest.length && next.length < W; ri++) next.push(rest[ri]);
		for (; ri < rest.length; ri++) pool.push(rest[ri]);
		next.sort((a, b) => b.score - a.score);
		for (const st of beam) if (st.p !== undefined) pool.push(st);
		beam = next;
		const P = new Int32Array(beam.length), M = new Uint8Array(beam.length);
		for (let i = 0; i < beam.length; i++) { P[i] = beam[i].p; M[i] = beam[i].m; }
		par.push(P); msk.push(M);
		const now = tick + 1;
		if (beam.length) maxLead = Math.max(maxLead, beam[0].g - now);
		if (task.debug && (k % task.debug === 0 || beam.length < 8)) console.error(`[flybeam ${task.name}] layer ${k + 1} tick ${now}: ${slots.length} cells, beam ${beam.length}, lead ${beam.length ? beam[0].g - now : '-'} (g ${beam.length ? beam[0].g : '-'}), rejoins ${direct}+${tails}, best ${bestSaving}`);
		// tail probes: the beam states ahead of the run, nearest to the run's state at g-1..g+1
		if (tailP > 0) {
			const cand = [];
			for (let i = 0; i < beam.length; i++) {
				const st = beam[i];
				if (st.g - now < 1) continue;
				sim.restore(st.s);
				let bc = Infinity, bt = -1;
				for (let t = Math.max(now + 1, st.g - 1); t <= Math.min(n - 1, st.g + 1); t++) {
					const c = Math.abs(sim.px - X[t]) + Math.abs(sim.py - Y[t]) + VW * (Math.abs(sim.speed_x - VX[t]) + Math.abs(sim.speed_y - VY[t]));
					if (c < bc) { bc = c; bt = t; }
				}
				if (bt >= 0) cand.push([bc, i, bt]);
			}
			cand.sort((a, b) => a[0] - b[0]);
			for (let c = 0; c < Math.min(tailP, cand.length); c++) {
				const [, i, t1] = cand[c];
				sim.restore(beam[i].s);
				died = false; done = false;
				for (let j = 0; j < tailH && t1 + j < n; j++) {
					E.applyMask(inp, ms[t1 + j]); sim.tick(inp); sims++;
					if (died) break;
					if (done) { tails++; record(n, k + 1 + j + 1, () => inputsOf(k + 1, i).concat(Array.from(ms.slice(t1, t1 + j + 1)))); break; }
					if (xs.has(sim.px)) {
						const T = at.get(sim.stateHash(false, NC));
						if (T !== undefined && T > now + j + 1) {
							tails++;
							record(T, k + 1 + j + 1, () => inputsOf(k + 1, i).concat(Array.from(ms.slice(t1, t1 + j + 1))));
							break;
						}
					}
				}
			}
		}
	}
	if (task.axes) console.error(`[flybeam ${task.name}] axis hits: x ${hitX} (max lead ${leadX}), y ${hitY} (max lead ${leadY})`);
	return { A, B: task.B, name: task.name, cfg: task.cfg, layers, sims, direct, tails, bestSaving, maxLead, secs: (Date.now() - t0) / 1000,
		callCut: timeCut && task.shortened === true,
		found: [...found.values()] };
}

/** best non-overlapping set of [A, T) rejoins (DP over the end tick) */
function pickSet(cands) {
	const c = cands.slice().sort((a, b) => a.T - b.T);
	const best = new Array(c.length + 1).fill(0), take = new Array(c.length + 1).fill(null);
	const ends = c.map((x) => x.T);
	for (let i = 0; i < c.length; i++) {
		// the last candidate ending at or before c[i].A
		let lo = 0, hi = i;
		while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] <= c[i].A) lo = m + 1; else hi = m; }
		const w = best[lo] + c[i].saving;
		if (w > best[i]) { best[i + 1] = w; take[i + 1] = [i, lo]; } else { best[i + 1] = best[i]; take[i + 1] = null; }
	}
	const out = [];
	for (let i = c.length; i > 0;) { const tk = take[i]; if (tk) { out.push(c[tk[0]]); i = tk[1]; } else i--; }
	return out.reverse();
}

function splice(ms, set) {
	let out = Array.from(ms);
	for (const s of set.slice().sort((a, b) => b.A - a.A)) out = out.slice(0, s.A).concat(s.inputs, out.slice(s.T));
	return out;
}

async function main() {
	const a = C.parseArgs(process.argv.slice(2));
	const num = (k, d) => (a[k] === undefined ? d : +a[k]);
	const base = { level: a.level, tas: a.tas, W: num('W', 4096), Q: num('Q', 4), V: num('V', 0.25), alpha: num('alpha', 0.3), corridor: num('corridor', 48),
		rMatch: num('rMatch', 12), debug: num('debug', 0), capT: num('capT', 0), axes: num('axes', 0), convF: num('convF', 0), vw: num('vw', 16), homing: a.homing || 'slots', look: num('look', 800), ext: num('ext', 600), tailP: num('tailP', 24), tailH: num('tailH', 300), timeS: num('timeS', 300) };
	const cfgs = a.cfg ? JSON.parse(a.cfg) : [{}];
	const level = C.loadLevel(a.level);
	const ms = C.readEetas(a.tas);
	const ref = C.evaluate(level, ms);
	if (!ref) throw new Error('the run does not finish');
	console.log(`[flybeam] run ${a.tas}: ${ref.runTicks} ticks (${C.fmt(ref.runTicks)}), finish at ${ref.complete}, deaths ${ref.deaths}`);
	const n = ref.complete;
	const every = num('starts', 0);
	let from = num('from', 0), to = Math.min(n, num('to', n));
	// --state=<file>: a pass over the run continued across calls (the grind's slices): the next start as {t, h} (tick +
	// state hash, found again by hash when the run changed), wrapping to the run's start after its end
	// --order=stretch (with --starts): the starts by their longest low-contact stretch (stretchOrder), and --state keeps the
	// starts done (by their state hash: a start whose state the run still has is not searched again) until all are done
	const STRETCH = a.order === 'stretch' && every > 0 && !a.startList;
	let stateH = null, doneH = null;
	const taskKey = (h, ci) => `${h}|${JSON.stringify(cfgs[ci])}`;
	const trace = a.state || STRETCH ? traceRun(level, ms.slice(0, n), a.nocoins === '1') : null;
	if (a.state) {
		const st = C.readJSON(a.state, null);
		stateH = trace.H;
		if (STRETCH) doneH = new Set(st && Array.isArray(st.done) ? st.done.filter((x) => typeof x === 'string') : []);
		else if (st && st.t >= 0) {
			let t = Math.min(n - 1, st.t | 0);
			for (let d = 0; d <= n; d++) {
				if (t - d >= 0 && stateH[t - d] === st.h) { t = t - d; break; }
				if (t + d < n && stateH[t + d] === st.h) { t = t + d; break; }
				if (d === n) t = Math.min(n - 1, st.t | 0);
			}
			from = t >= n - 50 ? 0 : t;
		}
	}
	const tasks = [];
	const starts = [];
	if (a.startList) for (const x of a.startList.split(',')) starts.push(+x);
	else if (STRETCH) {
		let rows = stretchOrder(trace.K, n, from, to, every);
		if (doneH) {
			// (done = per task: the start's state hash and the setting; a start with one setting done runs only the other)
			const left = rows.filter((r) => cfgs.some((c, ci) => !doneH.has(taskKey(trace.H[r.s], ci))));
			if (left.length) rows = left;
			else if (a.wrap === '0') { console.log('[flybeam] every start done (--wrap=0: not searched again)'); return; }
			else doneH.clear();   // every start done: the pass starts over
		}
		for (const r of rows) starts.push(r.s);
		console.log(`[flybeam] stretch order: ${rows.slice(0, 8).map((r) => `${r.s} (${r.best})`).join(', ')}${rows.length > 8 ? `, ... (${rows.length})` : ''}`);
	} else for (let s = from; s < to; s += every > 0 ? every : to - from) starts.push(s);
	for (const A of starts) for (let ci = 0; ci < cfgs.length; ci++) {
		if (doneH && doneH.has(taskKey(trace.H[A], ci))) continue;
		tasks.push(Object.assign({}, base, cfgs[ci], { A, B: every > 0 && a.toEnd !== '1' ? Math.min(to, A + every) : to, name: `A${A}c${ci}`, cfg: ci }));
	}
	// the time budget: --seconds (all tasks) and --deadline (ms since the epoch): no task starts past it, and each gets at
	// most what is left
	const t0 = Date.now();
	const endAt = Math.min(a.seconds ? t0 + 1000 * +a.seconds : Infinity, a.deadline ? +a.deadline : Infinity);
	if (a.workers && !a.threads) a.threads = a.workers;
	if (a.nocoins === '1') for (const t of tasks) t.noCoins = true;
	const threads = Math.min(num('threads', 8), tasks.length);
	console.log(`[flybeam] ${tasks.length} tasks (starts ${starts.join(',')}; ${cfgs.length} settings) on ${threads} threads`);
	const results = [];
	let next = 0;
	const meter = C.tickMeter();   // `[ticks] <total>` every second: the grind's live speed
	await new Promise((resolve) => {
		let live = 0;
		const spawn = () => {
			const left = endAt - Date.now();
			if (next >= tasks.length || left < 5000) { if (live === 0) resolve(); return; }
			const task = tasks[next++];
			if (isFinite(left) && left / 1000 - 3 < task.timeS) { task.timeS = Math.max(5, left / 1000 - 3); task.shortened = true; }
			live++;
			const w = new Worker(__filename, { workerData: { flybeam: task, ticksBuf: meter.buf } });
			w.on('message', (r) => {
				results.push(r);
				console.log(`[flybeam] ${r.name} (A ${r.A}..${r.B}, cfg ${JSON.stringify(cfgs[r.cfg])}): ${r.layers} layers, ${(r.sims / 1e6).toFixed(1)} M ticks, ${r.secs.toFixed(0)} s, ` +
					`max lead ${r.maxLead}, direct ${r.direct}, tail ${r.tails} rejoins, best saving ${r.bestSaving}`);
			});
			w.on('error', (e) => { console.log(`[flybeam] ${task.name} error: ${e.stack || e.message}`); });
			w.on('exit', () => { live--; spawn(); });
		};
		for (let i = 0; i < threads; i++) spawn();
	});
	if (a.state && tasks.length && STRETCH) {
		// a task (start, setting) is done when it ran to its own end (the beam's end or its whole --timeS): one the call's
		// end cut short (--seconds / --deadline) is left for the next call (the grind's slices: a start begun 20 s before
		// the end was marked done and never searched again while the run kept its state; the lane's first call on the ice
		// level ran start 2800's plain task to its end, 109 s, and its homing task was cut after 38 s)
		for (const r of results) if (!r.callCut) doneH.add(taskKey(stateH[r.A], r.cfg));
		C.writeJSON(a.state, { order: 'stretch', done: [...doneH] });
	} else if (a.state && tasks.length) {
		// the next start: the first task not started (its start again: some of its settings may have run), else past the
		// range's end (the run's start again once the whole run was covered)
		const nextA = next >= tasks.length ? (to >= n ? 0 : to) : tasks[next].A;
		C.writeJSON(a.state, { t: nextA, h: stateH[Math.min(nextA, stateH.length - 1)], wrapped: next >= tasks.length && to >= n });
	}
	// every join replayed alone: its saving in RUN ticks (a join before the first input moves the timer's start: the
	// ice run's 0 -> 397 saved 69 ticks but started the timer 69 ticks sooner) and only joins the acceptance rule takes
	meter.stop();
	const cands = [];
	for (const c of results.flatMap((r) => r.found)) {
		const ev = C.evaluate(level, splice(ms, [c]));
		const v = C.judge(ev, ref, ref.deaths);
		if (v.accept && v.saved > 0) cands.push(Object.assign(c, { ticks: c.saving, saving: v.saved }));
	}
	const set = pickSet(cands);
	const total = set.reduce((s, x) => s + x.saving, 0);
	console.log(`[flybeam] ${cands.length} rejoins; the best non-overlapping set: ${set.map((s) => `${s.A}->${s.T} -${s.saving}`).join(', ') || 'none'} (-${total} planned)`);
	let final = null;
	if (set.length) {
		const out = splice(ms, set);
		const ev = C.evaluate(level, out);
		const verdict = C.judge(ev, ref, ref.deaths);
		console.log(`[flybeam] spliced: ${ev ? `${ev.runTicks} ticks (${C.fmt(ev.runTicks)}), deaths ${ev.deaths}` : 'does not finish'}; ${verdict.accept ? `ACCEPT (-${verdict.saved})` : `reject: ${verdict.reason}`}`);
		if (verdict.accept && a.out) { C.writeEetas(a.out, ev.ms); console.log(`[flybeam] -> ${a.out}`); }
		if (ev) final = ev.runTicks;
	}
	if (a.json) fs.writeFileSync(a.json, JSON.stringify({ ref: ref.runTicks, final, set: set.map((s) => ({ A: s.A, T: s.T, saving: s.saving, len: s.inputs.length })),
		cands: cands.map((s) => ({ A: s.A, T: s.T, saving: s.saving, inputs: String.fromCharCode(...s.inputs.map((m) => 48 + m)) })),
		tasks: results.map((r) => ({ name: r.name, A: r.A, B: r.B, cfg: cfgs[r.cfg], layers: r.layers, sims: r.sims, secs: r.secs, direct: r.direct, tails: r.tails, maxLead: r.maxLead, best: r.bestSaving })) }, null, 1));
}

if (!isMainThread && workerData && workerData.flybeam) {
	// the live speed (common.tickMeter): this worker's ticks into the main thread's shared counter
	if (workerData.ticksBuf) E.setTickCounter(new BigInt64Array(workerData.ticksBuf));
	const r = runTask(workerData.flybeam);
	E.flushTicks();
	parentPort.postMessage(r);
}
else if (require.main === module) main().catch((e) => { console.log(`[flybeam] error: ${e.stack || e.message}`); process.exitCode = 1; });

module.exports = { traceRun, runTask, pickSet, splice, stretchOrder, MASKS };
