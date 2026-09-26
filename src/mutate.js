'use strict';
// Input-mutation search: the classic manual TAS moves, tried everywhere, verified exactly.
//
// For every tick t of the reference run and every mutation M of the inputs around t (delete tick t; replace the
// input at t by each other option; delete tick t and replace the next input; delete ticks t and t+1; replace two
// consecutive inputs by one option), replay the mutated inputs followed by the reference inputs from S(t). If
// the state ever equals (stateHash) a reference state S(j) whose tick j is later than the mutated run's tick,
// the mutation is a verified shortcut t -> j. Stop a candidate after --horizon ticks or when it drifts more than
// --drift px from where the reference is at the same shifted time. All shortcuts are combined by DP over the
// reference ticks, verified by a clean replay (C.evaluate) and THE rule (C.judge; if a faster combination lowers the
// random-portal chance, the DP runs again without the shortcuts that replace a random draw) and written.
//
// Options (all off by default):
//   --dprune=1    exact dominance pruning: per start tick a table (state hash, next reference input r) -> the fewest
//                 ticks any candidate needed to get there (per number of anchors left); a candidate that reaches a
//                 recorded pair with as many ticks or more (and no more anchors left) would replay exactly what the
//                 recorded one replays, only later, so it stops. The held-option mutations share their prefixes (each
//                 option is simulated up to 4 ticks once per start, then branches on the dropped ticks), and pairs
//                 keep only the distinct states after the first change. Same shortcuts, a fraction of the ticks.
//   --anchor=1    re-anchoring: a plain continuation plays the reference inputs from a fixed r = t + skip. When the
//                 candidate lands (on_ground false -> true) or a wall / ceiling zeroes a speed of >= 1 px/tick, it
//                 ALSO continues (a branch) with the inputs of the reference tick q in [r-8, r+--ahead] with the same
//                 gravity whose state is nearest (|dx|+|dy|+3(|dvx|+|dvy|) < --athr); at most --anchors per path.
//                 A mutation that lands earlier then plays the inputs timed for where it actually is.
//   --fixpoint=1  in-process fixpoint: apply the DP result, rebuild the reference, search again only the start ticks
//                 whose searched span (the reference ticks their candidates read or rejoined) overlaps a changed span
//                 (plus the new ticks), until nothing improves; then pairs, and so on. The shortcuts live in a library
//                 keyed by state hashes, so every one stays usable on the new reference.
//
// usage: node src/mutate.js --tas=<run.eetas> [--out=...] [--horizon=600] [--drift=96] [--workers=16] [--from=0]
//        [--to=<end>] [--nocoins=0|1] [--pairs=1] [--deadline=<epoch ms>] [--level=<level id | job id>]
//        [--dprune=0|1] [--anchor=0|1 [--anchors=2] [--ahead=150] [--athr=6]] [--fixpoint=0|1]
// (--level can be left out for a .eetas inside src/jobs/<id>/)

const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;

let NOCOINS = false;   // --nocoins=1: rejoins ignore which coins were collected (coins are optional)
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
const PAIR_GAP = 5;   // pairs: the second change 1..5 ticks after the first

function parseArgs() {
	const a = { level: '', tas: '', out: path.join(__dirname, 'out', 'mutate_best.eetas'),
		horizon: 600, drift: 96, workers: os.cpus().length, from: 0, to: 0, deadline: 0, pairs: 1, nocoins: 0,
		dprune: 0, anchor: 0, anchors: 2, ahead: 150, athr: 6, fixpoint: 0 };
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (m) a[m[1]] = (m[1] === 'tas' || m[1] === 'out' || m[1] === 'level') ? m[2] : parseFloat(m[2]);
	}
	if (!a.tas) { console.log('usage: node src/mutate.js --tas=<run.eetas> [--level=<id>] [--out=] (see the header)'); process.exit(2); }
	a.levelData = C.levelData(a.level, a.tas);
	a.workers = Math.max(1, a.workers | 0);
	return a;
}

/**
 * Replays the run: per tick (index = ticks played) position, speed, gravity (x*3+y), state hash and random-draw count,
 * hash -> the LAST tick with that state, and snapshots at the ticks in `snapAt` (a Set, or null).
 */
function reference(level, masks, snapAt) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const R = { X: new Float64Array(n + 1), Y: new Float64Array(n + 1), VX: new Float64Array(n + 1), VY: new Float64Array(n + 1),
		G: new Int8Array(n + 1), H: new Float64Array(n + 1), RS: new Int32Array(n + 1), hashTick: new Map(), snaps: new Map(),
		complete: -1, runTicks: 0, n };
	let complete = -1;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); };
	const rec = (j) => {
		R.X[j] = sim.px; R.Y[j] = sim.py; R.VX[j] = sim.speed_x; R.VY[j] = sim.speed_y;
		R.G[j] = sim.gravity_dir.x * 3 + sim.gravity_dir.y; R.RS[j] = sim._rngSteps;
		const h = sim.stateHash(false, NOCOINS);
		R.H[j] = h; R.hashTick.set(h, j);
		if (snapAt !== null && snapAt.has(j)) R.snaps.set(j, sim.snapshot());
	};
	rec(0);
	for (let t = 0; t < n; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); rec(t + 1); }
	R.complete = complete; R.runTicks = sim.run_ticks;
	return R;
}

// mutations at tick t: { del: ticks of the reference skipped, rep: inputs played instead }
// after them the reference continues at masks[t + del + rep.length]... (see apply below)
function mutationsAt(masks, t, pairs) {
	const out = [];
	const n = masks.length;
	if (pairs) {
		// two single-tick changes g ticks apart (same length): e.g. jump a tick later AND release a tick earlier
		for (let g = 1; g <= PAIR_GAP; g++) {
			if (t + g >= n) break;
			const mid = masks.slice(t + 1, t + g);
			for (const o1 of OPTIONS) {
				if (o1 === masks[t]) continue;
				for (const o2 of OPTIONS) {
					if (o2 === masks[t + g]) continue;
					out.push({ skip: g + 1, rep: [o1, ...mid, o2] });
				}
			}
		}
		return out;
	}
	if (t + 1 < n) out.push({ skip: 1, rep: [] });                                   // delete tick t
	if (t + 2 < n) out.push({ skip: 2, rep: [] });                                   // delete ticks t, t+1
	// replace a window of L ticks by one held option o, dropping D more reference ticks (L + D consumed)
	for (let L = 1; L <= 4; L++) {
		for (let D = 0; D <= 2; D++) {
			if (t + L + D >= n) continue;
			for (const o of OPTIONS) {
				if (D === 0) {   // same length: skip if identical to the reference window
					let same = true;
					for (let q = 0; q < L; q++) if (masks[t + q] !== o) { same = false; break; }
					if (same) continue;
				}
				out.push({ skip: L + D, rep: new Array(L).fill(o) });
			}
		}
	}
	return out;
}

/**
 * The exact dominance table of one start tick (--dprune=1), an open-addressing hash table on typed arrays (numeric
 * keys: a string Map costs more per lookup than a tick). Key (state hash h, next reference input r); value m[l] = the
 * fewest ticks played by a path that got there with at least l anchors left (l = 0..nv-1). From (h, r) every path
 * replays the same inputs from the same state, so a path with k >= m[left] finds nothing a recorded one does not find
 * sooner. reset() empties it in O(1) (generation stamps).
 */
function domTable(nv) {
	let cap = 1 << 15, mask = cap - 1, used = 0, gen = 1;
	let K = new Float64Array(cap), RR = new Int32Array(cap), GN = new Int32Array(cap), V = new Int32Array(cap * nv);
	const slotOf = (h, r) => {
		let x = (h % 4194304) ^ Math.imul(r, 0x9E3779B1);
		x = Math.imul(x ^ (x >>> 15), 0x85EBCA6B);
		return (x ^ (x >>> 13)) & mask;
	};
	const grow = () => {
		const oK = K, oR = RR, oG = GN, oV = V, oc = cap;
		cap *= 2; mask = cap - 1;
		K = new Float64Array(cap); RR = new Int32Array(cap); GN = new Int32Array(cap); V = new Int32Array(cap * nv);
		for (let s = 0; s < oc; s++) {
			if (oG[s] !== gen) continue;
			let d = slotOf(oK[s], oR[s]);
			while (GN[d] === gen) d = (d + 1) & mask;
			GN[d] = gen; K[d] = oK[s]; RR[d] = oR[s];
			for (let l = 0; l < nv; l++) V[d * nv + l] = oV[s * nv + l];
		}
	};
	return {
		reset() { gen++; used = 0; },
		/** true if a recorded path dominates (h, r, left, k); nothing is recorded */
		peek(h, r, left, k) {
			for (let s = slotOf(h, r); GN[s] === gen; s = (s + 1) & mask) if (K[s] === h && RR[s] === r) return V[s * nv + left] <= k;
			return false;
		},
		/** true if dominated; else records the path */
		check(h, r, left, k) {
			let s = slotOf(h, r);
			for (; GN[s] === gen; s = (s + 1) & mask) {
				if (K[s] === h && RR[s] === r) {
					const b = s * nv;
					if (V[b + left] <= k) return true;
					for (let l = 0; l <= left; l++) if (V[b + l] > k) V[b + l] = k;
					return false;
				}
			}
			GN[s] = gen; K[s] = h; RR[s] = r;
			for (let l = 0; l < nv; l++) V[s * nv + l] = l <= left ? k : 0x7fffffff;
			if (++used * 2 > cap) grow();
			return false;
		},
	};
}

function workerMain() {
	const { a, starts, masks, pairs } = workerData;
	E.setTickCounter(workerData.ticksBuf);
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const n = masks.length;
	const R = reference(level, masks, new Set(starts));
	const { X, Y, VX, VY, G, H, hashTick } = R;
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	let dead = false;
	sim.onEvent = (k) => { if (k === 'death') dead = true; };
	const stop = new Int32Array(workerData.stopBuf);
	const HOR = a.horizon, DRIFT = a.drift;
	const ANCH = a.anchor ? Math.max(1, a.anchors | 0) : 0, AHEAD = a.ahead | 0, ATHR = a.athr;
	const dom = a.dprune ? domTable(ANCH + 1) : null;
	const found = [];
	const reach = [];   // per searched start: t, lo, hi = the reference ticks its candidates read, anchored to or rejoined
	let t = 0, lo = 0, hi = 0;
	const tick = (m) => { E.applyMask(inp, m); sim.tick(inp); };
	// the inputs of a hit: the mutation's own, then the reference inputs of each segment [k0, r0] (anchors start new ones)
	const seqOf = (rep, segs, kEnd) => {
		const seq = rep.slice();
		for (let s = 0; s < segs.length; s += 2) {
			const k1 = s + 2 < segs.length ? segs[s + 2] : kEnd;
			for (let q = 0; q < k1 - segs[s]; q++) seq.push(masks[segs[s + 1] + q]);
		}
		return seq;
	};
	// --anchor: the reference tick in [r - 8, r + AHEAD] (same gravity, not r) nearest to the live state, or -1
	const anchorOf = (r) => {
		const g = sim.gravity_dir.x * 3 + sim.gravity_dir.y;
		const px = sim.px, py = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		let bq = -1, bd = ATHR;
		const q1 = Math.min(n - 1, r + AHEAD);
		for (let q = Math.max(0, r - 8); q <= q1; q++) {
			if (q === r || G[q] !== g) continue;
			const dp = Math.abs(px - X[q]) + Math.abs(py - Y[q]);
			if (dp >= bd) continue;
			const d = dp + 3 * (Math.abs(vx - VX[q]) + Math.abs(vy - VY[q]));
			if (d < bd) { bd = d; bq = q; }
		}
		return bq;
	};
	const stack = [];
	/**
	 * Continues the live state (k0 ticks played since S(t), next reference input r0, h0 = its hash or -1) with the
	 * reference inputs; an exact rejoin with a later reference tick is a hit. With anchors, branches are continued too.
	 */
	const follow = (rep, k0, r0, h0) => {
		let segs = [k0, r0];
		let k = k0, r = r0, left = ANCH, h = h0;
		let wasGround = sim.on_ground, pvx = NaN, pvy = NaN;
		if (r0 > hi) hi = r0;
		for (;;) {
			while (k < HOR && r < n && !dead && !sim.is_dead) {
				if (h < 0) h = sim.stateHash(false, NOCOINS);
				// verified rejoin: the state equals the reference state at a later reference tick
				const j = hashTick.get(h);
				if (j !== undefined) {
					if (j > t + k) found.push({ i: t, j, seq: seqOf(rep, segs, k) });
					if (j > hi) hi = j;
					if (j < lo) lo = j;
					break;   // back on the reference: ahead (a shortcut), level (no effect) or behind (slower)
				}
				// drifted away from the reference (compared at the same reference input position r)?
				if (Math.abs(sim.px - X[r]) + Math.abs(sim.py - Y[r]) > DRIFT) break;
				// --anchor: a landing, or a wall / ceiling that stopped a real speed: also continue from the nearest reference tick
				if (left > 0 && ((sim.on_ground && !wasGround) || (sim.speed_x === 0 && Math.abs(pvx) >= 1) || (sim.speed_y === 0 && Math.abs(pvy) >= 1))) {
					const q = anchorOf(r);
					if (q >= 0) {
						stack.push({ snap: sim.snapshot(), k, r: q, left: left - 1, segs: segs.concat(k, q) });
						if (q < lo) lo = q;
						if (q > hi) hi = q;
					}
				}
				// --dprune: a path that got to (h, r) in as few ticks with as many anchors left replays all of this sooner
				if (dom !== null && dom.check(h, r, left, k)) break;
				wasGround = sim.on_ground; pvx = sim.speed_x; pvy = sim.speed_y;
				tick(masks[r]); k++; r++; h = -1;
				if (r > hi) hi = r;
			}
			if (stack.length === 0) return;
			const p = stack.pop();
			sim.restore(p.snap); dead = false;
			k = p.k; r = p.r; left = p.left; segs = p.segs; h = -1;
			wasGround = sim.on_ground; pvx = NaN; pvy = NaN;
		}
	};
	const EMPTY = [];
	// --dprune: the single mutations as a prefix trie (deletes, then every option held 1..4 ticks, level by level)
	const ps = new Array(OPTIONS.length).fill(null), alive = new Uint8Array(OPTIONS.length), sameRef = new Uint8Array(OPTIONS.length);
	const singlesPruned = (snap) => {
		sim.restore(snap); dead = false;
		const h0 = H[t];
		for (let D = 1; D <= 2; D++) {
			if (t + D >= n || dom.peek(h0, t + D, ANCH, 0)) continue;
			sim.restore(snap); dead = false;
			follow(EMPTY, 0, t + D, h0);
		}
		alive.fill(1); sameRef.fill(1);
		for (let L = 1; L <= 4 && t + L < n; L++) {
			for (let oi = 0; oi < OPTIONS.length; oi++) {
				if (!alive[oi]) continue;
				const o = OPTIONS[oi];
				sim.restore(L === 1 ? snap : ps[oi]); dead = false;
				tick(o);
				if (dead || sim.is_dead) { alive[oi] = 0; continue; }
				if (masks[t + L - 1] !== o) sameRef[oi] = 0;
				const h = sim.stateHash(false, NOCOINS);
				ps[oi] = sim.snapshot(ps[oi]);
				let live = true;
				for (let D = 0; D <= 2; D++) {
					const r = t + L + D;
					if (r >= n) break;
					if (D === 0 && sameRef[oi]) continue;   // the reference itself
					if (dom.peek(h, r, ANCH, L)) continue;
					if (!live) { sim.restore(ps[oi]); dead = false; }
					live = false;
					follow(new Array(L).fill(o), L, r, h);
				}
			}
		}
	};
	// --dprune: pairs from the distinct states after the first change (one equal to S(t+1) is a single change at t+g)
	const pairsPruned = (snap) => {
		const firsts = [], seen = new Set();
		for (const o1 of OPTIONS) {
			if (o1 === masks[t]) continue;
			sim.restore(snap); dead = false;
			tick(o1);
			if (dead || sim.is_dead) continue;
			const h = sim.stateHash(false, NOCOINS);
			if (h === H[t + 1] || seen.has(h)) continue;
			seen.add(h);
			firsts.push({ o1, snap: sim.snapshot() });
		}
		for (const f of firsts) {
			let mid = f.snap;
			for (let g = 1; g <= PAIR_GAP && t + g < n; g++) {
				if (g > 1) {
					sim.restore(mid); dead = false;
					tick(masks[t + g - 1]);
					if (dead || sim.is_dead) break;
					mid = sim.snapshot();
				}
				for (const o2 of OPTIONS) {
					if (o2 === masks[t + g]) continue;
					sim.restore(mid); dead = false;
					tick(o2);
					const h = sim.stateHash(false, NOCOINS);
					if (dom.peek(h, t + g + 1, ANCH, g + 1)) continue;
					const rep = [f.o1];
					for (let q = t + 1; q < t + g; q++) rep.push(masks[q]);
					rep.push(o2);
					follow(rep, g + 1, t + g + 1, h);
				}
			}
		}
	};
	let done = 0;
	for (const t0 of starts) {
		if (Atomics.load(stop, 0) !== 0) break;
		t = t0; lo = t0; hi = t0;
		if (t >= R.complete) continue;
		const snap = R.snaps.get(t);
		if (dom !== null) {
			dom.reset();
			if (pairs) pairsPruned(snap); else singlesPruned(snap);
		} else {
			for (const mu of mutationsAt(masks, t, pairs)) {
				sim.restore(snap); dead = false;
				for (const o of mu.rep) tick(o);
				follow(mu.rep, mu.rep.length, t + mu.skip, -1);
			}
		}
		reach.push(t, lo, hi);
		if (++done % 200 === 0) parentPort.postMessage({ type: 'progress', done });
	}
	E.flushTicks();
	parentPort.postMessage({ type: 'res', found, reach: Int32Array.from(reach) });
}

/**
 * Shortest run over the reference ticks (1 tick each) plus shortcut edges: edgesAt(i) -> [[j, seq], ...] or undefined.
 * avoidRng: no edge that replaces a stretch with a random-portal draw. Returns { ms, used: [{i, j, len}], ticks } or null.
 */
function shortest(R, masks, edgesAt, avoidRng) {
	const n = R.complete;
	const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1).fill(-1), vseq = new Array(n + 1).fill(null);
	// no shortcut starts before the first input: the run timer only starts there, so those ticks are free, and cutting them
	// would start the timer sooner (a run with fewer ticks but a longer time)
	const firstInput = Math.max(0, masks.findIndex((m) => m !== 0));
	cost[0] = 0;
	for (let i = 0; i < n; i++) {
		if (cost[i] + 1 < cost[i + 1]) { cost[i + 1] = cost[i] + 1; from[i + 1] = i; vseq[i + 1] = null; }
		const list = i < firstInput ? undefined : edgesAt(i);
		if (list === undefined) continue;
		for (const [j, seq] of list) {
			if (j > n || j - i - seq.length <= 0) continue;
			if (avoidRng && R.RS[j] !== R.RS[i]) continue;
			if (cost[i] + seq.length < cost[j]) { cost[j] = cost[i] + seq.length; from[j] = i; vseq[j] = seq; }
		}
	}
	if (!(cost[n] < n)) return null;
	const parts = [], used = [];
	for (let j = n; j > 0;) {
		const i = from[j];
		if (vseq[j] !== null) { parts.push(vseq[j]); used.push({ i, j, len: vseq[j].length }); } else parts.push([masks[i]]);
		j = i;
	}
	parts.reverse(); used.reverse();
	const ms = new Uint8Array(cost[n]);
	let o = 0;
	for (const p of parts) for (const x of p) ms[o++] = x;
	return { ms, used, ticks: cost[n] };
}
const usedText = (used) => used.map((u) => `${u.i}->${u.j} (-${u.j - u.i - u.len})`).join(', ');

async function main() {
	const a = parseArgs();
	const meter = C.tickMeter();   // `[ticks] N` every second (the page's live speed)
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks0 = C.readEetas(a.tas);
	let R = reference(level, masks0, null);
	if (R.complete < 0) { console.log(`[mut] ${a.tas} does not finish the level`); meter.stop(); return; }
	const to0 = Math.min(a.to || R.complete, R.complete);
	const flags = [a.dprune ? 'dominance pruning' : '', a.anchor ? `re-anchoring (${Math.max(1, a.anchors | 0)} per path, r-8..r+${a.ahead}, < ${a.athr})` : '',
		a.fixpoint ? 'fixpoint' : ''].filter(Boolean);
	console.log(`[mut] ${a.tas}: completes at ${R.complete}, run_ticks ${R.runTicks}; ticks ${a.from}..${to0}, horizon ${a.horizon}, ` +
		`${a.workers} workers, ${mutationsAt(masks0, 100, false).length} single / ${mutationsAt(masks0, 100, true).length} pair mutations per tick` +
		(flags.length ? `; ${flags.join(', ')}` : ''));
	const ev0 = C.evaluate(level, masks0);   // THE rule's baseline (finish, deaths, random-portal chance)
	const baseDeaths = ev0 ? ev0.deaths : 0;
	const t0 = Date.now();
	const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
	const stopBuf = new SharedArrayBuffer(4), stop = new Int32Array(stopBuf);
	const late = () => a.deadline && Date.now() >= a.deadline;
	const dl = a.deadline ? setInterval(() => { if (late()) Atomics.store(stop, 0, 1); }, 1000) : null;
	// one search pass: `starts` spread over the workers (interleaved); resolves to { found, reach: [t, lo, hi]... }
	const runAll = (pairs, masks, starts) => {
		const W = Math.min(a.workers, starts.length);
		const found = [], reach = [];
		return Promise.all(Array.from({ length: W }, (_, w) => new Promise((res) => {
			const mine = [];
			for (let s = w; s < starts.length; s += W) mine.push(starts[s]);
			const wk = new Worker(__filename, { workerData: { a, starts: Int32Array.from(mine), masks, stopBuf, pairs, ticksBuf: meter.buf } });
			wk.on('message', (m) => { if (m.type === 'res') { for (const f of m.found) found.push(f); for (const x of m.reach) reach.push(x); res(); } });
			wk.on('error', (e) => { console.log('[mut] worker error', e); res(); });
		}))).then(() => ({ found, reach }));
	};
	/** The fastest DP run that THE rule accepts against `curEv` (with the avoidRng fallback), or null. */
	const judged = (dp, curEv, tag) => {
		for (const avoidRng of [false, true]) {
			const c = dp(avoidRng);
			if (!c) return null;
			const ev = C.evaluate(level, c.ms);
			const v = C.judge(ev, curEv, baseDeaths);
			if (v.accept) return { c, ev, avoidRng };
			if (!avoidRng && ev && ev.runTicks < curEv.runTicks && C.isRandom(level)) {
				console.log(`[mut] ${tag}: ${c.used.length} shortcuts give ${C.fmt(ev.runTicks)} but ${v.reason}: again without shortcuts over random draws`);
				continue;
			}
			console.log(`[mut] ${tag}: ${c.used.length} shortcuts, result not accepted (${v.reason})`);
			return null;
		}
		return null;
	};
	const range = (lo, hi) => { const s = []; for (let t = lo; t < hi; t++) s.push(t); return s; };

	if (!a.fixpoint) {
		// one pass: single changes, pairs only if they found nothing; DP over the found shortcuts
		let res = await runAll(false, masks0, range(a.from, to0));
		let all = res.found;
		if (!all.some((s) => s.j - s.i - s.seq.length > 0) && a.pairs !== 0 && !late()) {
			console.log(`[mut] single changes found nothing (${secs()} s): trying pairs of changes`);
			res = await runAll(true, masks0, range(a.from, to0));
			all = all.concat(res.found);
		}
		if (dl) clearInterval(dl);
		const n = R.complete;
		const saving = all.filter((s) => s.j - s.i - s.seq.length > 0);
		console.log(`[mut] ${all.length} rejoins, ${saving.length} saving time, in ${secs()} s`);
		const byStart = new Map();
		for (const s of saving) if (s.j <= n) { if (!byStart.has(s.i)) byStart.set(s.i, []); byStart.get(s.i).push([s.j, s.seq]); }
		const J = saving.length ? judged((avoidRng) => shortest(R, masks0, (i) => byStart.get(i), avoidRng), ev0, 'DP') : null;
		if (J) {
			console.log(`[mut] DP: ${n} -> ${J.c.ticks} ticks${J.avoidRng ? ' (no shortcut over a random draw)' : ''}; result completes at ${J.ev.complete}, ` +
				`run_ticks ${J.ev.runTicks} (was ${R.runTicks})`);
			console.log(`[mut] used: ${usedText(J.c.used)}`);
			C.writeEetas(a.out, J.ev.ms);
			console.log(`[mut] written ${a.out}`);
		} else console.log(`[mut] DP: nothing faster (run_ticks ${R.runTicks})`);
		meter.stop();
		return;
	}

	// ---- --fixpoint=1: apply, rebuild the reference, re-search only the start ticks whose searched span changed
	const lib = new Map();   // start state hash -> Map(end state hash -> the shortest inputs between them)
	let libSize = 0;
	const addEdge = (hs, he, seq) => {
		let m = lib.get(hs);
		if (!m) { m = new Map(); lib.set(hs, m); }
		const old = m.get(he);
		if (!old || seq.length < old.length) { if (!old) libSize++; m.set(he, seq); }
	};
	let cur = masks0, curEv = ev0;
	let n = R.complete;
	// per tick of the current reference: in the window, still to search (singles / pairs), searched span (lo, hi; -1 = none)
	const newSpans = (m) => ({ S: [new Int32Array(m + 1).fill(-1), new Int32Array(m + 1).fill(-1)], P: [new Int32Array(m + 1).fill(-1), new Int32Array(m + 1).fill(-1)],
		dS: new Uint8Array(m + 1), dP: new Uint8Array(m + 1) });
	let span = newSpans(n);
	let win = new Uint8Array(n + 1), dirtyS = span.dS, dirtyP = span.dP;
	for (let t = a.from; t < to0; t++) { win[t] = 1; dirtyS[t] = 1; dirtyP[t] = a.pairs !== 0 ? 1 : 0; }
	let pass = 0, phase = 'singles', applied = 0;
	while (!late()) {
		pass++;
		const pairs = phase === 'pairs';
		const dirty = pairs ? dirtyP : dirtyS;
		const starts = [];
		for (let t = 0; t < n; t++) if (win[t] && dirty[t]) starts.push(t);
		if (starts.length === 0) {
			if (!pairs && a.pairs !== 0) { phase = 'pairs'; continue; }
			break;
		}
		const tp = Date.now();
		const res = await runAll(pairs, cur, starts);
		const [slo, shi] = pairs ? span.P : span.S;
		for (let q = 0; q < res.reach.length; q += 3) { const t = res.reach[q]; slo[t] = res.reach[q + 1]; shi[t] = res.reach[q + 2]; dirty[t] = 0; }
		for (const f of res.found) addEdge(R.H[f.i], R.H[f.j], f.seq);
		const head = `[mut] pass ${pass} (${phase}, ${starts.length} start ticks): ${res.found.length} rejoins in ${((Date.now() - tp) / 1000).toFixed(1)} s, library ${libSize}`;
		const edgesAt = (i) => {
			const m = lib.get(R.H[i]);
			if (m === undefined) return undefined;
			const out = [];
			for (const [he, seq] of m) { const j = R.hashTick.get(he); if (j !== undefined) out.push([j, seq]); }
			return out;
		};
		const J = judged((avoidRng) => shortest(R, cur, edgesAt, avoidRng), curEv, `pass ${pass}`);
		if (!J) {
			console.log(`${head}; nothing faster`);
			if (!pairs && a.pairs !== 0) { phase = 'pairs'; continue; }
			break;
		}
		console.log(`${head}; DP: ${n} -> ${J.c.ticks} ticks${J.avoidRng ? ' (no shortcut over a random draw)' : ''}, run_ticks ${J.ev.runTicks} (was ${curEv.runTicks})`);
		console.log(`[mut] used: ${usedText(J.c.used)}`);
		applied++;
		C.writeEetas(a.out, J.ev.ms);   // (every accepted step: a stopped search keeps its best)
		// old tick -> new tick (-1 = replaced); changed old spans [i, j] and the new ticks that replaced them
		const used = J.c.used, nNew = J.ev.complete;
		const newOf = new Int32Array(n + 1);
		const ch = new Int32Array(n + 2);
		{
			let off = 0, u = 0;
			for (let t = 0; t <= n; t++) {
				while (u < used.length && t >= used[u].j) { off += used[u].j - used[u].i - used[u].len; u++; }
				newOf[t] = (u < used.length && t > used[u].i && t < used[u].j) ? -1 : t - off;
			}
			for (const e of used) for (let t = e.i; t <= e.j; t++) ch[t + 1] = 1;
			for (let t = 0; t <= n; t++) ch[t + 1] += ch[t];
		}
		const overlaps = (lo, hi) => { lo = Math.max(0, lo); hi = Math.min(n, hi); return lo <= hi && ch[hi + 1] - ch[lo] > 0; };
		const PP = a.pairs !== 0 ? 1 : 0;
		const win2 = new Uint8Array(nNew + 1), span2 = newSpans(nNew);
		// a start keeps its result if it was searched and its span lies in one unchanged stretch (it moves with it)
		const carry = (d, sp, d2, sp2, on) => {
			for (let t = 0; t <= n; t++) {
				const nt = newOf[t];
				if (nt < 0 || nt > nNew) continue;
				if (d[t] || sp[0][t] < 0 || overlaps(sp[0][t], sp[1][t])) { d2[nt] = on; continue; }
				sp2[0][nt] = sp[0][t] - (t - nt); sp2[1][nt] = sp[1][t] - (t - nt);
			}
		};
		carry(dirtyS, span.S, span2.dS, span2.S, 1);
		carry(dirtyP, span.P, span2.dP, span2.P, PP);
		for (let t = 0; t <= n; t++) if (newOf[t] >= 0 && newOf[t] <= nNew) win2[newOf[t]] = win[t];
		for (const e of used) {   // the new ticks: never searched
			const ni = newOf[e.i];
			for (let q = ni + 1; q < ni + e.len && q <= nNew; q++) { win2[q] = win[e.i]; span2.dS[q] = 1; span2.dP[q] = PP; }
		}
		cur = J.ev.ms; curEv = J.ev; n = nNew;
		win = win2; dirtyS = span2.dS; dirtyP = span2.dP; span = span2;
		R = reference(level, cur, null);
		phase = 'singles';
	}
	if (dl) clearInterval(dl);
	if (applied) console.log(`[mut] fixpoint: ${applied} step${applied > 1 ? 's' : ''}, run_ticks ${ev0.runTicks} -> ${curEv.runTicks} in ${secs()} s; written ${a.out}`);
	else console.log(`[mut] fixpoint: nothing faster in ${secs()} s (run_ticks ${ev0.runTicks})`);
	meter.stop();
}

if (isMainThread) main();
else workerMain();
