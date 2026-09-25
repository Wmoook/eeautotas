'use strict';
// Beam-search TAS optimizer (Everybody Edits Offline physics, bit-exact JS port in ./eesim.js).
//
// Beam search that follows a reference run (an .eetas that already completes the level) and tries every
// input combination on every tick for every beam state, keeping the W states that are furthest along the
// reference route. A state's "progress" is the index of the nearest reference point with the same discrete
// context (coins, blue coins, crown, keys, switches, gravity) inside a window after its parent's progress,
// with position + velocity distance. The first state to complete the level ends the search; its inputs are
// rebuilt by walking the per-step parent links. States are never copied between threads: every worker keeps
// an identical beam (replicated), expands its share of it, and writes child summaries to shared memory; the
// main thread picks the survivors and broadcasts (parent, input) pairs, which every worker re-applies.
//
// usage: node src/optimize.js --tas=<run.eetas> [--level=<level id | job id>] [--width=2000] [--workers=16]
//        [--out=src/out/opt.eetas] [--passes=1] [--dist=24] [--prefix=<segment.eetas>]
//        [--from=<tick>] (reuse the reference inputs verbatim up to this tick, search after it)
// (--level can be left out for a .eetas inside src/jobs/<id>/)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const C = require('./common.js');
const E = C.E;

// 18 input options: horizontal (none, left, right) x vertical (none, up, down) x jump (no, yes).
// eeo-tas mask bits: 1 jump, 2 left, 4 right, 8 up, 16 down.
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
const NOPT = OPTIONS.length;

const WIN_BACK = 24;       // progress may slip back this many reference ticks
const WIN_AHEAD = 90;      // ... and look this far ahead for the nearest reference point
const VEL_W = 3.0;         // px per (px/tick) of velocity mismatch in the distance
const MAX_D = 40.0;        // beyond this distance from its best reference point a state is off-route: no progress credit
const BUCKET_CAP = 2;      // diversity: at most this many survivors per (progress, 4px cell, direction) bucket
const SLOTS = 7;           // per child in the shared output: score, key hash, bucket hash, flags, progress, px, py
let DIST_TICK = 24;        // score: this many px of position/velocity mismatch with the route cost one tick of progress

function parseArgs() {
	const a = { level: '', tas: null, width: 2000, workers: Math.max(1, os.cpus().length), out: null,
		from: 0, maxSteps: 0, passes: 1, dist: 24, debug: 0, prefix: null };
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) continue;
		const k = m[1], v = m[2];
		if (k === 'width' || k === 'workers' || k === 'from' || k === 'maxSteps' || k === 'passes' || k === 'debug') a[k] = parseInt(v, 10);
		else if (k === 'dist') a[k] = parseFloat(v);
		else a[k] = v;
	}
	if (!a.tas) { console.log('usage: node src/optimize.js --tas=<run.eetas> [--level=<id>] [--width=] [--out=] (see the header)'); process.exit(2); }
	if (!a.out) a.out = path.join(__dirname, 'out', 'opt.eetas');
	a.levelData = C.levelData(a.level, a.tas);
	return a;
}

// Discrete context of a state: must match for two states to be "at the same point of the route".
// (eesim.js: keys = _keysMask bits; purple / orange switches = Maps id -> bool, read as sorted "on" sets.)
function onSet(m) {
	if (!m || m.size === 0) return '';
	const ids = [];
	for (const [id, v] of m) if (v === true) ids.push(id);
	return ids.sort((a, b) => a - b).join('.');
}
function contextKey(sim) {
	return sim.coins + ',' + sim.blue_coins + ',' + (sim.has_crown ? 1 : 0) + ',' + (sim._keysMask | 0) + ',' +
		onSet(sim._switches) + ',' + onSet(sim._oswitches);
}

// 53-bit FNV-style hash of a state key (string or number).
function hashKey(k) {
	if (typeof k === 'number') return k;
	let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
	for (let i = 0; i < k.length; i++) {
		const c = k.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 16777619);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995);
		h2 ^= h2 >>> 15;
	}
	return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

// ------------------------------------------------------------------ reference run
function buildReference(level, masks) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const RX = new Float64Array(n + 1), RY = new Float64Array(n + 1);
	const RVX = new Float64Array(n + 1), RVY = new Float64Array(n + 1);
	const RC = new Int32Array(n + 1);
	const ctxIds = new Map();
	const ctxOf = (sim) => {
		const k = contextKey(sim);
		let id = ctxIds.get(k);
		if (id === undefined) { id = ctxIds.size; ctxIds.set(k, id); }
		return id;
	};
	let complete = -1;
	sim.onEvent = (kind) => { if (kind === 'complete' && complete < 0) complete = sim.ticks(); };
	const keyTick = new Map();   // exact state (hashed stateKey) -> latest reference tick in that state
	const rec = (j) => {
		RX[j] = sim.px; RY[j] = sim.py; RVX[j] = sim.speed_x; RVY[j] = sim.speed_y; RC[j] = ctxOf(sim);
		keyTick.set(sim.stateHash(), j);
	};
	rec(0);
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		rec(t + 1);
	}
	sim.onEvent = null;
	return { RX, RY, RVX, RVY, RC, n, complete, runTicks: sim.run_ticks,
		ctx: Array.from(ctxIds.keys()), keyTick };
}

// ------------------------------------------------------------------ worker
function workerMain() {
	const { levelData, ref, width, idx, nworkers, shared, ctxKeys, distTick } = workerData;
	DIST_TICK = distTick;
	const level = E.loadLevel(levelData);
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	const ctxIds = new Map();
	ctxKeys.forEach((k, i) => ctxIds.set(k, i));
	const RX = ref.RX, RY = ref.RY, RVX = ref.RVX, RVY = ref.RVY, RC = ref.RC, RN = ref.n;
	// shared buffers
	const ctl = new Int32Array(shared.ctl);             // [0] step counter, [1] survivors count, [2] command, [3..] done flags
	const surv = new Int32Array(shared.surv);            // per survivor: parent, input, progress
	const out = new Float64Array(shared.out);            // per child: score, keyHash, bucketHash, flags, progress
	let beamSnap = [], beamP = [];
	let complete = false, dead = false;
	sim.onEvent = (kind) => { if (kind === 'complete') complete = true; else if (kind === 'death') dead = true; };

	function progressOf(p) {
		// context of the current sim state
		const ck = contextKey(sim);
		let c = ctxIds.get(ck);
		const x = sim.px, y = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		let lo = p - WIN_BACK, hi = p + WIN_AHEAD;
		if (lo < 0) lo = 0;
		if (hi > RN) hi = RN;
		let best = -1, bestD = 1e18;
		if (c !== undefined) {
			for (let j = lo; j <= hi; j++) {
				if (RC[j] !== c) continue;
				const d = Math.abs(x - RX[j]) + Math.abs(y - RY[j]) + VEL_W * (Math.abs(vx - RVX[j]) + Math.abs(vy - RVY[j]));
				if (d <= bestD) { bestD = d; best = j; }
			}
			if (best < 0) {
				// context reached ahead of schedule (e.g. a coin taken earlier): jump to where the reference gets it
				let j0 = -1;
				for (let j = hi + 1; j <= RN; j++) if (RC[j] === c) { j0 = j; break; }
				if (j0 >= 0) {
					const h2 = Math.min(RN, j0 + WIN_AHEAD);
					for (let j = j0; j <= h2; j++) {
						if (RC[j] !== c) continue;
						const d = Math.abs(x - RX[j]) + Math.abs(y - RY[j]) + VEL_W * (Math.abs(vx - RVX[j]) + Math.abs(vy - RVY[j]));
						if (d <= bestD) { bestD = d; best = j; }
					}
				}
			}
		}
		if (best >= 0 && bestD > MAX_D) {
			// off the route: keep it alive (it may rejoin) but give it no more progress than its parent
			return [-2 - p, bestD];
		}
		return [best, bestD];
	}

	function applySurvivors(count) {
		const ns = new Array(count), np = new Array(count);
		for (let i = 0; i < count; i++) {
			const par = surv[i * 3], m = surv[i * 3 + 1];
			np[i] = surv[i * 3 + 2];
			if (par < 0) { sim.reset(); ns[i] = sim.snapshot(); continue; }
			sim.restore(beamSnap[par]);
			E.applyMask(inp, m);
			sim.tick(inp);
			ns[i] = sim.snapshot();
		}
		beamSnap = ns; beamP = np;
	}

	// Expansion with exact pruning of no-op inputs: up/down only move the ball in zero-g, liquids, on climbables
	// or under sideways gravity (ee_sim: _my = 0 when moy != 0), left/right likewise under sideways gravity.
	// Probe once per parent (none / up / down, none / left / right, no jump); if a direction's variants all
	// give the same state as "none", its other combinations are skipped (they would be identical children).
	function simChild(i, o, at) {
		sim.restore(beamSnap[i]);
		complete = false; dead = false;
		E.applyMask(inp, OPTIONS[o]);
		sim.tick(inp);
		if (dead || sim.is_dead) { out[at] = -1e18; out[at + 3] = 2; return -1; }
		const pd = progressOf(beamP[i]);
		let p = pd[0];
		const d = pd[1];
		let off = false;
		if (p <= -2) { p = -2 - p; off = true; }   // off-route: parent's progress, penalized by the distance
		const key = sim.stateHash();
		out[at] = complete ? 1e18 : (p < 0 ? -1e17 : Math.floor((p - Math.min(d, 1e5) / DIST_TICK - (off ? 8 : 0)) * 1e4));
		out[at + 1] = key;
		out[at + 2] = p * 131071 + Math.floor(sim.px / 4) * 8191 + Math.floor(sim.py / 4) * 127 +
			(Math.sign(sim.speed_x) + 1) * 3 + Math.sign(sim.speed_y) + 1;   // diversity bucket (numeric, no strings)
		out[at + 3] = complete ? 1 : 0;
		out[at + 4] = complete ? RN : p;
		out[at + 5] = sim.px;
		out[at + 6] = sim.py;
		return key;
	}
	// option index = h * 6 + v * 2 + j  (h: none,left,right; v: none,up,down; j: no,yes) - see OPTIONS
	const OI = (h, v, j) => h * 6 + v * 2 + j;
	function expand() {
		const count = beamSnap.length;
		for (let i = idx; i < count; i += nworkers) {
			const base = i * NOPT * SLOTS;
			const k0 = simChild(i, OI(0, 0, 0), base + OI(0, 0, 0) * SLOTS);
			const ku = simChild(i, OI(0, 1, 0), base + OI(0, 1, 0) * SLOTS);
			const kd = simChild(i, OI(0, 2, 0), base + OI(0, 2, 0) * SLOTS);
			const kl = simChild(i, OI(1, 0, 0), base + OI(1, 0, 0) * SLOTS);
			const kr = simChild(i, OI(2, 0, 0), base + OI(2, 0, 0) * SLOTS);
			// beam slot 0 is the reference line (elitism): all its children are computed so main can always pick
			// the reference input's child
			const vertNoop = i !== 0 && k0 >= 0 && ku === k0 && kd === k0;
			const horzNoop = i !== 0 && k0 >= 0 && kl === k0 && kr === k0;
			for (let h = 0; h < 3; h++) {
				for (let v = 0; v < 3; v++) {
					for (let j = 0; j < 2; j++) {
						const o = OI(h, v, j);
						const at = base + o * SLOTS;
						if (j === 0 && (h === 0 || v === 0)) continue;   // probed above
						if ((vertNoop && v !== 0) || (horzNoop && h !== 0)) { out[at] = -1e18; out[at + 3] = 3; continue; }
						simChild(i, o, at);
					}
				}
			}
		}
	}

	// loop: wait for a command, act, signal done
	let last = 0;
	for (;;) {
		Atomics.wait(ctl, 0, last);
		last = Atomics.load(ctl, 0);
		const cmd = Atomics.load(ctl, 2);
		if (cmd === 9) break;
		if (cmd === 0) applySurvivors(Atomics.load(ctl, 1));
		else if (cmd === 1) expand();
		Atomics.add(ctl, 3, 1);
		Atomics.notify(ctl, 3);
	}
}

// ------------------------------------------------------------------ main
async function main() {
	const args = parseArgs();
	const t0 = Date.now();
	const level = E.loadLevel(args.levelData);
	let masks = C.readEetas(args.tas);
	const first = buildReference(level, masks);
	console.log(`[opt] start: ${masks.length} ticks, completes at tick ${first.complete}, run_ticks ${first.runTicks} ` +
		`(${fmt(first.runTicks)})`);
	if (first.complete < 0) { console.log('[opt] the reference does not complete the level'); return; }
	let bestRun = first.runTicks;
	for (let pass = 1; pass <= args.passes; pass++) {
		const res = await searchPass(level, masks, args, pass, t0);
		if (!res || res.runTicks >= bestRun) { console.log(`[opt] pass ${pass}: no improvement, stopping`); break; }
		bestRun = res.runTicks;
		masks = res.masks;
		C.writeEetas(args.out, masks);
		console.log(`[opt] pass ${pass}: ${fmt(res.runTicks)} (run_ticks ${res.runTicks}, ${first.runTicks - res.runTicks} ticks ` +
			`saved in total) -> ${args.out}`);
	}
	console.log(`[opt] best ${fmt(bestRun)} vs start ${fmt(first.runTicks)}; total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// One beam search along `masks` (the reference). Returns {masks, runTicks} of the fastest completion found.
async function searchPass(level, masks, args, pass, t0) {
	const ref = buildReference(level, masks);
	console.log(`[opt] pass ${pass}: reference completes at tick ${ref.complete}, run_ticks ${ref.runTicks}, ` +
		`${ref.ctx.length} route contexts, width ${args.width}, ${args.workers} workers`);
	const W = args.width, NW = args.workers;
	const shared = {
		ctl: new SharedArrayBuffer(4 * 8),
		surv: new SharedArrayBuffer(4 * 3 * W),
		out: new SharedArrayBuffer(8 * SLOTS * W * NOPT),
	};
	const ctl = new Int32Array(shared.ctl), surv = new Int32Array(shared.surv), out = new Float64Array(shared.out);
	const refData = { RX: ref.RX, RY: ref.RY, RVX: ref.RVX, RVY: ref.RVY, RC: ref.RC, n: ref.n };
	const workers = [];
	for (let i = 0; i < NW; i++) {
		workers.push(new Worker(__filename, { workerData: { levelData: args.levelData, ref: refData, width: W, idx: i,
			nworkers: NW, shared, ctxKeys: ref.ctx, distTick: args.dist } }));
	}
	let step = 0;
	const run = (count, cmd) => {
		Atomics.store(ctl, 1, count);
		Atomics.store(ctl, 2, cmd);
		Atomics.store(ctl, 3, 0);
		step++;
		Atomics.store(ctl, 0, step);
		Atomics.notify(ctl, 0);
		while (Atomics.load(ctl, 3) < NW) Atomics.wait(ctl, 3, Atomics.load(ctl, 3), 50);
	};
	const histPar = [], histIn = [];
	let count = 1;
	surv[0] = -1; surv[1] = 0; surv[2] = 0;
	histPar.push(Int32Array.of(-1)); histIn.push(Uint8Array.of(0));
	run(1, 0);
	// --prefix: play these inputs verbatim first (e.g. a new route segment from explore.js), then search; the
	// reference line (elitism) continues with the reference inputs from the reference tick the prefix rejoins
	let pre = null, refShift = 0;
	if (args.prefix && pass === 1) pre = C.readEetas(args.prefix);
	const from = pre ? pre.length : Math.min(args.from, masks.length);
	let startProg = from;
	if (pre) {
		const ps = new E.EESim(level);
		ps.reset();
		const pi = new E.EEInput();
		for (let t = 0; t < pre.length; t++) { E.applyMask(pi, pre[t]); ps.tick(pi); }
		const ck = contextKey(ps);
		let bj = -1, bd = 1e18;
		for (let j = 0; j <= ref.n; j++) {
			if (ref.ctx[ref.RC[j]] !== ck) continue;
			const d = Math.abs(ps.px - ref.RX[j]) + Math.abs(ps.py - ref.RY[j]) + VEL_W * (Math.abs(ps.speed_x - ref.RVX[j]) + Math.abs(ps.speed_y - ref.RVY[j]));
			if (d < bd) { bd = d; bj = j; }
		}
		startProg = bj;
		refShift = bj - from;
		console.log(`[opt] prefix ${args.prefix}: ${pre.length} ticks, rejoins reference tick ${bj} (d ${bd.toFixed(2)}, ` +
			`${refShift >= 0 ? '+' : ''}${refShift} ticks)`);
	}
	for (let t = 0; t < from; t++) {
		const m = pre ? pre[t] : masks[t];
		surv[0] = 0; surv[1] = m; surv[2] = t + 1 === from ? startProg : t + 1;
		histPar.push(Int32Array.of(0)); histIn.push(Uint8Array.of(m));
		run(1, 0);
	}
	const MUL = 1048576;   // packing: (integer score) * MUL + child index (children < 2^20)
	const keys = new Float64Array(W * NOPT);
	let bestTick = -1, bestIdx = -1;
	let refLine = true;   // beam slot 0 = the reference run itself
	const tPass = Date.now();
	for (let t = from; ; t++) {
		run(count, 1);   // expand
		const nc = count * NOPT;
		let m = 0;
		for (let ci = 0; ci < nc; ci++) {
			const sc = out[ci * SLOTS];
			if (sc <= -1e17) continue;
			keys[m++] = (sc >= 1e17 ? 2e9 : Math.floor(sc)) * MUL + ci;
		}
		const sub = keys.subarray(0, m);
		sub.sort();
		const seenKey = new Set(), bucketN = new Map();
		const par = [], inp = [], prog = [];
		let done = -1;
		// elitism: slot 0 always continues the reference inputs, shifted by the best VERIFIED lead: a child whose
		// exact state (stateKey) is the reference state of a later tick j is j - (t + 1) ticks ahead for sure, and
		// the reference inputs from j on replay exactly from it. So a found lead can never be lost again.
		let lineChild = -1, lineProg = 0;
		if (refLine && t + refShift < masks.length) {
			const oi = OPTIONS.indexOf(masks[t + refShift]);
			if (oi >= 0 && out[oi * SLOTS] > -1e17) { lineChild = oi; lineProg = out[oi * SLOTS + 4]; }   // parent 0
			else {
				refLine = false;
				console.log(`[opt]   reference line lost at tick ${t} (mask ${masks[t + refShift]})`);
			}
		}
		for (let ci = 0; ci < nc; ci++) {
			if (out[ci * SLOTS] <= -1e17) continue;
			const j = ref.keyTick.get(out[ci * SLOTS + 1]);
			if (j !== undefined && j - (t + 1) > refShift) {
				console.log(`[opt]   tick ${t + 1}: verified lead ${j - (t + 1)} (exact state of reference tick ${j})`);
				refShift = j - (t + 1); lineChild = ci; lineProg = j; refLine = true;
			}
		}
		if (lineChild >= 0) {
			const at = lineChild * SLOTS;
			seenKey.add(out[at + 1]);
			bucketN.set(out[at + 2], 1);
			if (out[at + 3] === 1) done = 0;
			par.push((lineChild / NOPT) | 0); inp.push(OPTIONS[lineChild % NOPT]); prog.push(lineProg);
		}
		for (let r = m - 1; r >= 0 && done < 0; r--) {
			const kv = sub[r];
			const ci = kv - Math.floor(kv / MUL) * MUL;
			const at = ci * SLOTS;
			const isDone = out[at + 3] === 1;
			const key = out[at + 1];
			if (!isDone && seenKey.has(key)) continue;
			const b = out[at + 2];
			const nb = bucketN.get(b) || 0;
			if (!isDone && nb >= BUCKET_CAP) continue;
			seenKey.add(key); bucketN.set(b, nb + 1);
			if (isDone && done < 0) done = par.length;
			par.push((ci / NOPT) | 0); inp.push(OPTIONS[ci % NOPT]);
			prog.push(out[at + 4]);
			if (done >= 0 || par.length >= W) break;
		}
		if (par.length === 0) { console.log(`[opt] beam died at tick ${t}`); break; }
		histPar.push(Int32Array.from(par)); histIn.push(Uint8Array.from(inp));
		count = par.length;
		for (let i = 0; i < count; i++) { surv[i * 3] = par[i]; surv[i * 3 + 1] = inp[i]; surv[i * 3 + 2] = prog[i]; }
		let bestP = prog[0], bestI = 0;
		for (let i = 1; i < count; i++) if (prog[i] > bestP) { bestP = prog[i]; bestI = i; }
		if (args.debug && (t + 1) % args.debug === 0) {
			const ci = par[bestI] * NOPT + OPTIONS.indexOf(inp[bestI]);
			const bx = out[ci * SLOTS + 5], by = out[ci * SLOTS + 6];
			console.log(`[dbg] t ${t + 1}: best p ${bestP} at (${(bx / 16).toFixed(2)}, ${(by / 16).toFixed(2)}); ref@p (${(ref.RX[bestP] / 16).toFixed(2)}, ` +
				`${(ref.RY[bestP] / 16).toFixed(2)}); ref@t (${(ref.RX[t + 1] / 16).toFixed(2)}, ${(ref.RY[t + 1] / 16).toFixed(2)}); ` +
				`ctx ${ref.ctx[ref.RC[t + 1]]}`);
		}
		const lead = bestP - (t + 1);
		if ((t + 1) % 500 === 0 || done >= 0) {
			const el = (Date.now() - tPass) / 1000;
			console.log(`[opt]   tick ${t + 1}: beam ${count}, best progress ${bestP} (${lead >= 0 ? '+' : ''}${lead} vs ref), ` +
				`${el.toFixed(0)} s, ${((t + 1 - from) / Math.max(el, 0.001)).toFixed(0)} steps/s`);
		}
		if (done >= 0) { bestTick = t + 1; bestIdx = done; break; }
		if (args.maxSteps && t + 1 >= args.maxSteps) break;
		// termination: nothing completes by the reference's own finish (+ margin) -> give up on this pass
		if (t + 1 > ref.complete - refShift + 300) { console.log(`[opt] no completion by tick ${t + 1}, giving up`); break; }
		run(count, 0);   // apply survivors (every worker rebuilds the same new beam)
	}
	Atomics.store(ctl, 2, 9); step++; Atomics.store(ctl, 0, step); Atomics.notify(ctl, 0);
	await Promise.all(workers.map((w) => new Promise((res) => w.once('exit', res))));
	if (bestTick < 0) return null;
	const seq = new Uint8Array(bestTick);
	let k = bestIdx;
	for (let s = bestTick; s >= 1; s--) {
		seq[s - 1] = histIn[s][k];
		k = histPar[s][k];
	}
	// verify with a clean single-thread replay (never trust the beam's bookkeeping)
	const v = new E.EESim(level);
	v.reset();
	let vc = -1;
	v.onEvent = (kind) => { if (kind === 'complete' && vc < 0) vc = v.ticks(); };
	const vi = new E.EEInput();
	for (let i = 0; i < seq.length && vc < 0; i++) { E.applyMask(vi, seq[i]); v.tick(vi); }
	console.log(`[opt] pass ${pass} result: completes at tick ${vc}, run_ticks ${v.run_ticks} (${fmt(v.run_ticks)}) vs ` +
		`reference ${ref.runTicks} (${fmt(ref.runTicks)})`);
	if (vc < 0) return null;
	return { masks: seq.slice(0, vc), runTicks: v.run_ticks };
}

function fmt(ticks) {
	const s = ticks / 100;
	return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

if (isMainThread) main();
else workerMain();
