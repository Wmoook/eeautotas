'use strict';
// THE BREADTH-FIRST PROVER ON WORKER THREADS (box 7 lane 'proof', cycle 6, 2026-10-01): layercensus.js's breadth-first
// search over EXACT engine states (every idle start, every input of every tick (endgame.probeMasks; the first layer's inputs
// non-zero), deaths kept where the level kills, wholepar.js's admissible cut at C: a state at layer d is cut when d + h > C)
// with FULL stateHash dedup ACROSS LAYERS in ONE SHARED TABLE (a state first seen at layer d is the same state with no more
// run ticks at any later layer: dropped), run on N worker threads, every layer a barrier. Where the depth-first search
// thrashes (NC Naos C 58: 6.09 B nodes on 61 of 171 tasks, its tasks' prefixes searched again and its table cleared every C)
// the breadth-first one visits every distinct state once.
// THE CLAIM (wholepar.js's convention: a finish at layer d is a route of d - 1 run ticks): the front empties with no finish =
// C CLOSED: every route takes >= C run ticks; the first layer with a finish = THE OPTIMUM (every state of every shorter route
// has d + h <= its run ticks <= C, so none is cut, and the dedup keeps the earliest copy of each): the route is rebuilt from
// the parent links, REPLAYED from the level file (common.js evaluate), `FASTER` and written to --out when below the routes
// given, else `PROVEN`. A closed C at the route's run ticks (C = U) = the route PROVEN optimal. Every tier set is CHECKED on
// every route given first (h <= the ticks left at every tick; a violation: no claim). The hash is stateHash (53 bits): a
// closed C is wrong only if a collision merged away EVERY shortest route's states (each of its ~C states against the n seen:
// ~C n / 2^53, 1e-6 at n = 1e8).
//   node tools/perfect/bfsprove.js <level.eelvl> --C=<layer bound> [--route=<a.eetas>,..] [--U=] [--threads=16]
//        [--seconds=1800] [--ttBits=28] [--tiers=kin,rel,gate] [--out=<faster.eetas>] [--check=1] [--initPer=64]
//        [--maxGB=12 (the process's RSS: past it the run stops, 'memory')] [--heapMB=4096 (a worker's old space)]
// Prints JSON lines: {ev 'check'} {ev 'start'} {ev 'layer', d, states, cut, merged, seen, minW, maxW, s, rssGB} {ev 'result',
// verdict 'PROVEN' | 'FASTER' | 'CLOSED' (lb = C, below U) | 'OPEN' (time / table) | 'violation', lb, opt, ...}.
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../../src/eesim.js');
const EG = require('../../src/endgame.js');
const T = require('../../src/plan/types.js');
const LP = require('../../src/plan/levelproof.js');
const WPAR = require('./wholepar.js');

// ---------------------------------------------------------------- the shared seen table (insert-only)
// a slot = 2 int32: the hash's low word (0 = empty; a low word 0 is stored as 1) and its high word + 1 (0 = being written:
// a reader that meets a matching low word with the high word not yet stored waits for it). A full probe run = no merge
// (the state is kept: never unsound, at most searched twice).
const PROBE = 512;
function seenTable(sab) {
	const K = new Int32Array(sab), mask = (K.length >>> 1) - 1;
	return function insert(hs) {   // true = new (claimed now), false = seen before, null = the probe run is full
		let lo = (hs % 4294967296) | 0;
		const hv = (Math.floor(hs / 4294967296) | 0) + 1;
		if (lo === 0) lo = 1;
		let i = ((lo >>> 0) ^ (hv * 0x9e3779b1)) & mask;
		for (let p = 0; p < PROBE; p++) {
			const b = i << 1;
			let v = Atomics.load(K, b);
			if (v === 0) {
				const old = Atomics.compareExchange(K, b, 0, lo);
				if (old === 0) { Atomics.store(K, b + 1, hv); return true; }
				v = old;
			}
			if (v === lo) {
				let w = Atomics.load(K, b + 1);
				while (w === 0) w = Atomics.load(K, b + 1);
				if (w === hv) return false;
			}
			i = (i + 1) & mask;
		}
		return null;
	};
}

// ---------------------------------------------------------------- a layer of states, packed
// A snapshot object holds ~110 fields (~1.2 KB of V8 heap: its doubles boxed); a layer keeps per state only the fields that
// differ from the worker's BASE snapshot (Object.is: -0 and NaN exact), each as (field index, type, Float64 value):
// type 0 a number, 1 true, 2 false, 3 null, 4 undefined, 5 anything else (a reference kept in `refs`: the switch maps and
// queues, shared copy-on-write by the engine), ~25 fields = ~270 B a state. Every state read back is checked: restored,
// its stateHash must be the one stored at its insert (else the run throws: no claim).
const FIELDS = Object.keys(new E.EESnapshot());
function makeStore() {
	let n = 0, m = 0, off = new Int32Array(1024), hs = new Float64Array(1024), fi = new Uint8Array(16384), ty = new Uint8Array(16384), va = new Float64Array(16384);
	const refs = [];
	const grow = (a, k) => { const b = new a.constructor(Math.max(k, a.length * 2)); b.set(a); return b; };
	return {
		get n() { return n; },
		push(snap, base, h) {
			if (n + 2 > off.length) { off = grow(off, n + 2); hs = grow(hs, n + 2); }
			if (m + FIELDS.length > fi.length) { const k = m + FIELDS.length; fi = grow(fi, k); ty = grow(ty, k); va = grow(va, k); }
			off[n] = m; hs[n] = h;
			for (let f = 0; f < FIELDS.length; f++) {
				const k = FIELDS[f], v = snap[k];
				if (Object.is(v, base[k])) continue;
				fi[m] = f;
				if (typeof v === 'number') { ty[m] = 0; va[m] = v; } else if (v === true) ty[m] = 1; else if (v === false) ty[m] = 2;
				else if (v === null) ty[m] = 3; else if (v === undefined) ty[m] = 4; else { ty[m] = 5; va[m] = refs.length; refs.push(v); }
				m++;
			}
			n++; off[n] = m;
		},
		get(i, base, out) {
			for (let f = 0; f < FIELDS.length; f++) out[FIELDS[f]] = base[FIELDS[f]];
			for (let j = off[i], e = off[i + 1]; j < e; j++) {
				const t = ty[j], k = FIELDS[fi[j]];
				out[k] = t === 0 ? va[j] : t === 1 ? true : t === 2 ? false : t === 3 ? null : t === 4 ? undefined : refs[va[j]];
			}
			return hs[i];
		},
		bytes: () => off.byteLength + hs.byteLength + fi.byteLength + ty.byteLength + va.byteLength,
	};
}

// ---------------------------------------------------------------- a worker: its own front, every layer on the barrier
function workerMain() {
	const { file, tiers, C, sab, deadline, maxBytes } = workerData;
	const L = T.loadLevelFile(file);
	const ctx = WPAR.makeCtx(L, new Set(tiers));
	const insert = seenTable(sab);
	const { sources } = LP.sourcesOf(L, 3000);
	const sim = new E.EESim(L), inp = new E.EEInput();
	let roots = [], front = null, base = null;
	const cur = new E.EESnapshot(), tmp = new E.EESnapshot();
	const par = [], mk = [];   // per layer (from the roots on): the parent's index in the layer before, the input
	parentPort.on('message', (m) => {
		if (m.type === 'roots') {
			roots = m.roots; front = makeStore();
			for (const r of roots) {
				sim.restore(sources[r.src]);
				for (const x of r.path) { E.applyMask(inp, x); sim.tick(inp); }
				const s = sim.snapshot();
				if (base === null) base = s;
				front.push(s, base, sim.stateHash());
			}
			parentPort.postMessage({ type: 'ready', n: front.n });
		} else if (m.type === 'layer') {
			const d = m.d;
			const next = makeStore(), np = [], nm = [];
			let cut = 0, merged = 0, full = 0, crown = null, stopped = false;
			const lim = C - (d + 1);
			for (let i = 0; i < front.n && crown === null; i++) {
				const h0 = front.get(i, base, cur);
				sim.restore(cur);
				if (sim.stateHash() !== h0) throw new Error(`bfsprove: a packed state read back wrong (layer ${d}, state ${i})`);
				const masks = EG.probeMasks(sim, inp, cur);
				for (const x of masks) {
					sim.restore(cur); E.applyMask(inp, x); sim.tick(inp);
					if (sim.has_silver_crown) { crown = { i, x }; break; }
					if (sim.is_dead && !ctx.canDie) continue;
					if (lim < 1 || ctx.h(sim, lim) > lim) { cut++; continue; }
					const hs = sim.stateHash();
					const r = insert(hs);
					if (r === false) { merged++; continue; }
					if (r === null) full++;
					next.push(sim.snapshot(tmp), base, hs); np.push(i); nm.push(x);
				}
				if ((i & 1023) === 0 && (Date.now() > deadline || process.memoryUsage.rss() > maxBytes)) { stopped = Date.now() > deadline ? 'time' : 'memory'; break; }
			}
			let route = null;
			if (crown !== null) {
				// the parent links back to this worker's root (a child stays on its parent's worker)
				const back = [crown.x];
				let j = crown.i;
				for (let k = par.length - 1; k >= 0; k--) { back.push(mk[k][j]); j = par[k][j]; }
				const r = roots[j];
				route = { src: r.src, path: r.path.concat(back.reverse()) };
			}
			const states = stopped ? 0 : next.n, bytes = next.bytes();
			front = stopped || crown !== null ? makeStore() : next;
			if (!stopped && crown === null) { par.push(Int32Array.from(np)); mk.push(Uint8Array.from(nm)); }
			parentPort.postMessage({ type: 'done', d, states, cut, merged, full, stopped, route, bytes });
		} else if (m.type === 'quit') process.exit(0);
	});
}

// ---------------------------------------------------------------- the main thread
async function main() {
	const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
	const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
	const Cm = require('../../src/common.js');
	const WPF = require('./wholeproof.js');
	const say = (o) => console.log(JSON.stringify(o));
	const t0 = Date.now();
	const L = T.loadLevelFile(file);
	const tiers = (args.tiers || 'kin,rel,gate').split(',').filter(Boolean);
	const ctx = WPAR.makeCtx(L, new Set(tiers));
	const src = LP.sourcesOf(L, 3000);
	const out = { ev: 'result', level: path.basename(file), tiers, verdict: 'OPEN' };
	if (src.rests < 0) { Object.assign(out, { verdict: 'unsupported', why: src.why }); say(out); return; }
	const sources = src.sources;
	let U = Infinity, best = null;
	for (const f of (args.route || '').split(',').filter(Boolean)) {
		const ev = Cm.evaluate(L, Cm.readEetas(f), false);
		if (!ev) { say({ ev: 'check', route: path.basename(f), ok: false, why: 'does not finish' }); continue; }
		if (ev.runTicks < U) { U = ev.runTicks; best = path.basename(f); }
		if (args.check !== '0') {
			const ck = WPF.checkRoute(L, ev.ms, { h: (s) => ctx.h(s, 1e9) });
			say(Object.assign({ ev: 'check', route: path.basename(f), runTicks: ev.runTicks }, ck));
			if (!ck.ok) { Object.assign(out, { verdict: 'violation', why: 'the bound is above the ticks left on a real route: no claim' }); say(out); return; }
		}
	}
	if (+args.U > 0 && +args.U < U) { U = +args.U; best = 'given U'; }
	const C = args.C !== undefined ? +args.C : U;
	if (!Number.isFinite(C) || C < 1) { console.error('bfsprove: --C (or a route / --U) is needed'); process.exit(2); }
	const threads = Math.max(1, +args.threads || 16), ttBits = Math.min(30, +args.ttBits || 28);
	const deadline = t0 + 1000 * (+args.seconds || 1800);
	const sab = new SharedArrayBuffer(8 * (2 ** ttBits));
	const insert = seenTable(sab);
	const sim = new E.EESim(L), inp = new E.EEInput();
	let h0 = Infinity;
	for (const s of sources) { sim.restore(s); const v = ctx.h(sim, 1e9); if (v < h0) h0 = v; }
	say({ ev: 'start', level: path.basename(file), C, U: Number.isFinite(U) ? U : null, h0, starts: sources.length, rests: src.rests, threads, ttBits, tiers });
	// the first layers on this thread (the sources deduped, the first inputs non-zero) until the front can feed every worker
	let front = [];
	for (let k = 0; k < sources.length; k++) { sim.restore(sources[k]); if (insert(sim.stateHash()) !== false) front.push({ src: k, path: [], snap: sources[k] }); }
	const firstMasks = Array.from(EG.MASK_SETS[3]).filter((m) => m !== 0);
	const initPer = +args.initPer || 64;
	let d = 0, found = null, seen = front.length;
	const finish = (route) => { found = route; };
	while (front.length > 0 && found === null && (d === 0 || front.length < initPer * threads)) {   // (layer 0 here: its inputs non-zero)
		const next = [];
		let cut = 0, merged = 0;
		const lim = C - (d + 1);
		for (const e of front) {
			sim.restore(e.snap);
			const masks = d === 0 ? firstMasks : EG.probeMasks(sim, inp, e.snap);
			for (const x of masks) {
				sim.restore(e.snap); E.applyMask(inp, x); sim.tick(inp);
				if (sim.has_silver_crown) { finish({ src: e.src, path: e.path.concat([x]) }); break; }
				if (sim.is_dead && !ctx.canDie) continue;
				if (lim < 1 || ctx.h(sim, lim) > lim) { cut++; continue; }
				if (insert(sim.stateHash()) === false) { merged++; continue; }
				next.push({ src: e.src, path: e.path.concat([x]), snap: sim.snapshot() });
			}
			if (found !== null) break;
		}
		seen += next.length;
		d++;
		say({ ev: 'layer', d, states: next.length, cut, merged, seen, main: true, s: Math.round((Date.now() - t0) / 100) / 10 });
		front = next;
	}
	const Cs = [];
	if (found === null && front.length > 0) {
		const wk = [];
		const maxBytes = (+args.maxGB || 12) * 1e9, heapMB = +args.heapMB || 4096;
		for (let w = 0; w < threads; w++) wk.push(new Worker(__filename, { workerData: { file, tiers, C, sab, deadline, maxBytes }, resourceLimits: { maxOldGenerationSizeMb: heapMB } }));
		const ask = (w, msg, type) => new Promise((res) => { const f = (m) => { if (m.type === type) { w.off('message', f); res(m); } }; w.on('message', f); w.postMessage(msg); });
		const roots = Array.from({ length: threads }, () => []);
		front.forEach((e, i) => roots[i % threads].push({ src: e.src, path: e.path }));
		front = null;
		await Promise.all(wk.map((w, i) => ask(w, { type: 'roots', roots: roots[i], d0: d }, 'ready')));
		for (;;) {
			const rs = await Promise.all(wk.map((w) => ask(w, { type: 'layer', d }, 'done')));
			d++;
			let states = 0, cut = 0, merged = 0, full = 0, stopped = false, minW = Infinity, maxW = 0, bytes = 0;
			for (const r of rs) {
				states += r.states; cut += r.cut; merged += r.merged; full += r.full; stopped = stopped || r.stopped; bytes += r.bytes || 0;
				if (r.states < minW) minW = r.states; if (r.states > maxW) maxW = r.states;
				if (r.route && found === null) found = r.route;
			}
			seen += states;
			say({ ev: 'layer', d, states, cut, merged, full, seen, minW, maxW, frontMB: Math.round(bytes / 1e6), s: Math.round((Date.now() - t0) / 100) / 10, rssGB: Math.round(process.memoryUsage().rss / 1e8) / 10 });
			if (found !== null) break;
			if (stopped) { out.why = stopped; break; }
			if (states === 0) break;
			if (seen > 0.7 * 2 ** ttBits) { out.why = 'table'; break; }
		}
		for (const w of wk) { try { w.postMessage({ type: 'quit' }); } catch (e) { /* gone */ } }
	}
	let lb = Math.max(0, h0 - 1);
	if (found !== null) {
		const masks = new Uint8Array(found.src + found.path.length);
		masks.set(found.path, found.src);
		const ev = Cm.evaluate(L, masks, false);
		out.opt = found.path.length - 1;
		if (ev) {
			out.optReplay = ev.runTicks;
			if (Number.isFinite(U) && ev.runTicks < U) {
				out.verdict = 'FASTER';
				if (args.out) { Cm.writeEetas(path.resolve(args.out), ev.ms); out.written = args.out; }
			} else out.verdict = 'PROVEN';
			lb = ev.runTicks;
		} else out.verdict = 'replay-failed';
	} else if (!out.why) {
		lb = C;
		out.verdict = Number.isFinite(U) && C >= U ? 'PROVEN' : 'CLOSED';
	} else lb = Math.max(lb, d - 1);   // (every layer done with no finish: no route of <= d - 2 run ticks... the weak anytime bound)
	Object.assign(out, { C, U: Number.isFinite(U) ? U : null, best, h0, lb, gap: Number.isFinite(U) ? U - lb : null, layers: d, seen, seconds: (Date.now() - t0) / 1000 });
	say(out);
}

if (!isMainThread) workerMain();
else if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { seenTable, makeStore, FIELDS };
