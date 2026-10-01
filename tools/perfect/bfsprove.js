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
//        [--seconds=1800] [--ttBits=28 (past 30: 2^(ttBits-30) shards of 2^30 slots)] [--replay=1 (THE REPLAY FRONT: 5 B a front state)] [--tiers=kin,rel,gate] [--out=<faster.eetas>] [--check=1] [--initPer=64]
//        [--maxGB=12 (the process's RSS: past it the run stops, 'memory')] [--heapMB=4096 (a worker's old space)]
//        [--rebalance=1.5 (re-root the fronts when the largest is past this factor of the mean; 0 off)]
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
// THE SHARDS (last hour, 2026-10-01): --ttBits past 30 (a slot index past int32, a typed array past 2^31 int32s) = 2^(ttBits
// - 30) tables of 2^30 slots (8.6 GB each), the shard picked by a mix of the hash's low word: one hash = one shard = the same
// probe run, so the dedup is the one table's (an array of SharedArrayBuffers; one buffer = the old table byte for byte).
const PROBE = 512;
function seenTable(sabs) {
	const Ks = (Array.isArray(sabs) ? sabs : [sabs]).map((b) => new Int32Array(b));
	const sm = Ks.length - 1, mask = (Ks[0].length >>> 1) - 1;
	if (Ks.length & sm) throw new Error('seenTable: the shard count must be a power of 2');
	return function insert(hs) {   // true = new (claimed now), false = seen before, null = the probe run is full
		let lo = (hs % 4294967296) | 0;
		const hv = (Math.floor(hs / 4294967296) | 0) + 1;
		if (lo === 0) lo = 1;
		const K = sm === 0 ? Ks[0] : Ks[(Math.imul(lo, 0x85ebca6b) >>> 13) & sm];
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
// THE BYTE PACKING (cycle 6, resumed; `EEAT_BFS_PACK=0`: the triples above): one byte stream a layer, per differing field
// its index, its type and only the bytes the type needs: a number that is a whole int32 (not -0) 4 bytes (type 6), any
// other number a Float64 (type 0), a reference's index 4 bytes (type 5), true / false / null / undefined none (~2x fewer
// bytes a state: NC Naos d3c6's C 59 front 204 B a state as triples); the read-back hash check stays the guard.
const PACK = process.env.EEAT_BFS_PACK !== '0';
function makeStore() {
	return PACK ? makeByteStore() : makeTripleStore();
}
function makeByteStore() {
	let n = 0, m = 0, off = new Float64Array(1024), hs = new Float64Array(1024), buf = new Uint8Array(1 << 16), dv = new DataView(buf.buffer);
	const refs = [];
	const grow = (a, k) => { const b = new a.constructor(Math.max(k, a.length * 2)); b.set(a); return b; };
	return {
		get n() { return n; },
		push(snap, base, h) {
			if (n + 2 > off.length) { off = grow(off, n + 2); hs = grow(hs, n + 2); }
			if (m + FIELDS.length * 10 > buf.length) { buf = grow(buf, m + FIELDS.length * 10); dv = new DataView(buf.buffer); }
			off[n] = m; hs[n] = h;
			for (let f = 0; f < FIELDS.length; f++) {
				const k = FIELDS[f], v = snap[k];
				if (Object.is(v, base[k])) continue;
				buf[m++] = f;
				if (typeof v === 'number') {
					if ((v | 0) === v && !Object.is(v, -0)) { buf[m++] = 6; dv.setInt32(m, v, true); m += 4; } else { buf[m++] = 0; dv.setFloat64(m, v, true); m += 8; }
				} else if (v === true) buf[m++] = 1; else if (v === false) buf[m++] = 2; else if (v === null) buf[m++] = 3; else if (v === undefined) buf[m++] = 4;
				else { buf[m++] = 5; dv.setInt32(m, refs.length, true); m += 4; refs.push(v); }
			}
			n++; off[n] = m;
		},
		get(i, base, out) {
			for (let f = 0; f < FIELDS.length; f++) out[FIELDS[f]] = base[FIELDS[f]];
			for (let j = off[i], e = off[i + 1]; j < e;) {
				const k = FIELDS[buf[j]], t = buf[j + 1];
				j += 2;
				if (t === 0) { out[k] = dv.getFloat64(j, true); j += 8; } else if (t === 6) { out[k] = dv.getInt32(j, true); j += 4; } else if (t === 5) { out[k] = refs[dv.getInt32(j, true)]; j += 4; } else out[k] = t === 1 ? true : t === 2 ? false : t === 3 ? null : undefined;
			}
			return hs[i];
		},
		bytes: () => off.byteLength + hs.byteLength + buf.byteLength,
		used: () => (n + 1) * 16 + m,
	};
}
function makeTripleStore() {
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
		used: () => n * 12 + m * 10,
	};
}

// a layer's parent links / inputs as they are made: typed and doubling (a JS array of numbers is 8 B an element)
function growTyped(Ctor) {
	let a = new Ctor(1024);
	const g = { n: 0, push(v) { if (g.n === a.length) { const b = new Ctor(a.length * 2); b.set(a); a = b; } a[g.n++] = v; }, done() { return a.slice(0, g.n); } };
	return g;
}
const growI32 = () => growTyped(Int32Array), growU8 = () => growTyped(Uint8Array);

// a packed root set {src, off, masks, hs} sorted by (source, path), the bytes compared in order (the lazy roots' order)
function sortRoots(rs) {
	const n = rs.src.length, S = rs.src, O = rs.off, M = rs.masks, idx = new Int32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	idx.sort((a, b) => {
		if (S[a] !== S[b]) return S[a] - S[b];
		const la = O[a + 1] - O[a], lb = O[b + 1] - O[b], l = Math.min(la, lb), oa = O[a], ob = O[b];
		for (let t = 0; t < l; t++) { const d = M[oa + t] - M[ob + t]; if (d !== 0) return d; }
		return la - lb;
	});
	const src = new Int32Array(n), off = new Int32Array(n + 1), masks = new Uint8Array(M.length), hs = rs.hs ? new Float64Array(n) : null;
	let at = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		src[q] = S[i]; off[q] = at;
		masks.set(M.subarray(O[i], O[i + 1]), at); at += O[i + 1] - O[i];
		if (hs) hs[q] = rs.hs[i];
	}
	off[n] = at;
	return { src, off, masks, hs };
}

// ---------------------------------------------------------------- a worker: its own front, every layer on the barrier
function workerMain() {
	const { file, tiers, C, sab, deadline, maxBytes, replay } = workerData;
	const L = T.loadLevelFile(file);
	const ctx = WPAR.makeCtx(L, new Set(tiers));
	const insert = seenTable(sab);
	const { sources } = LP.sourcesOf(L, 3000);
	const sim = new E.EESim(L), inp = new E.EEInput();
	let roots = null, front = null, base = null;
	const cur = new E.EESnapshot(), tmp = new E.EESnapshot();
	let par = [], mk = [];   // per layer (from the roots on): the parent's index in the layer before, the input
	// THE REPLAY FRONT (last hour, 2026-10-01; --replay=1): no layer past the roots is stored as states: a layer is its
	// parent links + inputs only (5 B a state, kept anyway for the route), and a state is rebuilt when its layer is expanded
	// by the engine from its nearest cached ancestor (one snapshot a depth, cache[q] = the state at index cacheIdx[q] of
	// layer q; layer 0 = the roots, stored): the layer is walked in index order and a parent's children are contiguous, so
	// a state costs ~1 tick more than reading it back (the parent's tick is shared by its children). The front's memory
	// (~105-300 B a state packed) goes; the seen table (8 B a slot) stays. Exact: the same states, the same inputs, the
	// same cut / dedup / finish as the stored front (the engine's tick from a restored snapshot is deterministic).
	const cache = [], cacheIdx = [], anc = [];
	// THE LAZY ROOTS (replay mode): the roots are kept as their paths from the sources only (a re-rooting stores no layer
	// of states: the stored roots were ~105-300 B a state, a whole layer at once), sorted by (source, path) so that
	// consecutive roots share their prefixes, and a root's state is the engine's replay of its path from the nearest
	// state of the last replayed root's path (rc[p] = the state after p inputs of it), checked against the hash it came with
	const rc = [];
	let rcPrev = -1, rcLen = 0;
	const rootState = (j, out) => {
		const s = roots.src[j], o0 = roots.off[j], len = roots.off[j + 1] - o0, M = roots.masks;
		let p = 0;
		if (rcPrev >= 0 && roots.src[rcPrev] === s) {
			const q0 = roots.off[rcPrev], lim = Math.min(len, roots.off[rcPrev + 1] - q0, rcLen);
			while (p < lim && M[o0 + p] === M[q0 + p]) p++;
		}
		sim.restore(p === 0 ? sources[s] : rc[p]);
		for (let t = p; t < len; t++) {
			E.applyMask(inp, M[o0 + t]); sim.tick(inp);
			if (rc[t + 1] === undefined) rc[t + 1] = new E.EESnapshot();
			sim.snapshot(rc[t + 1]);
		}
		rcPrev = j; rcLen = len;
		if (roots.hs && roots.hs[j] !== sim.stateHash()) throw new Error(`bfsprove: a re-rooted state rebuilt wrong (root ${j})`);
		return sim.snapshot(out);
	};
	const derive = (i, k) => {   // the state at index i of layer k (k = par.length: the front) into cache[k]; returns it
		anc[k] = i;
		for (let q = k - 1; q >= 0; q--) anc[q] = par[q][anc[q + 1]];
		let q = k;
		while (q >= 0 && cacheIdx[q] !== anc[q]) q--;
		if (q < 0) {
			if (cache[0] === undefined) cache[0] = new E.EESnapshot();
			rootState(anc[0], cache[0]);
			cacheIdx[0] = anc[0]; q = 0;
		}
		if (q === k) return cache[k];
		sim.restore(cache[q]);
		for (let r = q + 1; r <= k; r++) {
			E.applyMask(inp, mk[r - 1][anc[r]]); sim.tick(inp);
			if (cache[r] === undefined) cache[r] = new E.EESnapshot();
			sim.snapshot(cache[r]); cacheIdx[r] = anc[r];
		}
		return cache[k];
	};
	const frontN = () => (par.length === 0 ? roots.src.length : par[par.length - 1].length);
	parentPort.on('message', (m) => {
		if (m.type === 'roots' && replay) {
			roots = sortRoots(m.rs); front = null; par = []; mk = []; cacheIdx.length = 0; rcPrev = -1; rcLen = 0;
			parentPort.postMessage({ type: 'ready', n: roots.src.length });
		} else if (m.type === 'roots') {
			// a root set (packed paths from the sources: the first layers, or a re-rooting's share of every worker's front),
			// each state rebuilt by its own path and, where the hash came with it, checked against it
			roots = m.rs; front = makeStore(); par = []; mk = []; cacheIdx.length = 0;
			for (let i = 0; i < roots.src.length; i++) {
				sim.restore(sources[roots.src[i]]);
				for (let j = roots.off[i]; j < roots.off[i + 1]; j++) { E.applyMask(inp, roots.masks[j]); sim.tick(inp); }
				const h = sim.stateHash();
				if (roots.hs && roots.hs[i] !== h) throw new Error(`bfsprove: a re-rooted state rebuilt wrong (state ${i})`);
				if (base === null) base = sim.snapshot();
				front.push(sim.snapshot(tmp), base, h);
			}
			parentPort.postMessage({ type: 'ready', n: front.n });
		} else if (m.type === 'dump') {
			// the front as packed paths from the sources (its root's path + the inputs since), with the states' hashes
			const n = replay ? frontN() : front.n, k = par.length, src = new Int32Array(n), off = new Int32Array(n + 1), hs = new Float64Array(n);
			let total = 0;
			const rootOf = new Int32Array(n);
			for (let i = 0; i < n; i++) {
				let j = i;
				for (let q = k - 1; q >= 0; q--) j = par[q][j];
				rootOf[i] = j; total += roots.off[j + 1] - roots.off[j] + k;
			}
			const masks = new Uint8Array(total);
			let at = 0;
			for (let i = 0; i < n; i++) {
				const j0 = rootOf[i];
				src[i] = roots.src[j0]; off[i] = at;
				masks.set(roots.masks.subarray(roots.off[j0], roots.off[j0 + 1]), at);
				at += roots.off[j0 + 1] - roots.off[j0];
				let j = i;
				for (let q = k - 1; q >= 0; q--) { masks[at + q] = mk[q][j]; j = par[q][j]; }
				at += k;
				if (replay) { derive(i, k); sim.restore(cache[k]); hs[i] = sim.stateHash(); } else hs[i] = front.get(i, base, cur);
			}
			off[n] = at;
			front = makeStore(); par = []; mk = []; cacheIdx.length = 0;
			parentPort.postMessage({ type: 'dumped', rs: { src, off, masks, hs } }, [src.buffer, off.buffer, masks.buffer, hs.buffer]);
		} else if (m.type === 'layer') {
			const d = m.d;
			const next = replay ? null : makeStore(), np = growI32(), nm = growU8();   // (typed, doubling: 5 B a child, not 16)
			let cut = 0, merged = 0, full = 0, crown = null, stopped = false;
			const lim = C - (d + 1);
			const n = replay ? frontN() : front.n, k = par.length;
			for (let i = 0; i < n && crown === null; i++) {
				let st = cur;
				if (replay) st = derive(i, k);
				else {
					const h0 = front.get(i, base, cur);
					sim.restore(cur);
					if (sim.stateHash() !== h0) throw new Error(`bfsprove: a packed state read back wrong (layer ${d}, state ${i})`);
				}
				const masks = EG.probeMasks(sim, inp, st);
				for (const x of masks) {
					sim.restore(st); E.applyMask(inp, x); sim.tick(inp);
					if (sim.has_silver_crown) { crown = { i, x }; break; }
					if (sim.is_dead && !ctx.canDie) continue;
					if (lim < 1 || ctx.h(sim, lim) > lim) { cut++; continue; }
					const hs = sim.stateHash();
					const r = insert(hs);
					if (r === false) { merged++; continue; }
					if (r === null) full++;
					if (!replay) next.push(sim.snapshot(tmp), base, hs);
					np.push(i); nm.push(x);
				}
				if ((i & 1023) === 0 && (Date.now() > deadline || process.memoryUsage.rss() > maxBytes)) { stopped = Date.now() > deadline ? 'time' : 'memory'; break; }
			}
			let route = null;
			if (crown !== null) {
				// the parent links back to this worker's root (a child stays on its parent's worker)
				const back = [crown.x];
				let j = crown.i;
				for (let k = par.length - 1; k >= 0; k--) { back.push(mk[k][j]); j = par[k][j]; }
				route = { src: roots.src[j], path: Array.from(roots.masks.subarray(roots.off[j], roots.off[j + 1])).concat(back.reverse()) };
			}
			const states = stopped ? 0 : np.n, bytes = replay ? 5 * np.n : next.bytes(), used = replay ? 5 * np.n : next.used();
			if (stopped || crown !== null) front = makeStore();
			else if (!replay) front = next;
			if (!stopped && crown === null) { par.push(np.done()); mk.push(nm.done()); }
			parentPort.postMessage({ type: 'done', d, states, cut, merged, full, stopped, route, bytes, used });
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
	const threads = Math.max(1, +args.threads || 16), ttBits = Math.min(34, +args.ttBits || 28);
	const deadline = t0 + 1000 * (+args.seconds || 1800);
	const sab = Array.from({ length: 2 ** Math.max(0, ttBits - 30) }, () => new SharedArrayBuffer(8 * (2 ** Math.min(30, ttBits))));
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
		for (let w = 0; w < threads; w++) wk.push(new Worker(__filename, { workerData: { file, tiers, C, sab, deadline, maxBytes, replay: args.replay === '1' || process.env.EEAT_BFS_REPLAY === '1' }, resourceLimits: { maxOldGenerationSizeMb: heapMB } }));
		const ask = (w, msg, type) => new Promise((res) => { const f = (m) => { if (m.type === type) { w.off('message', f); res(m); } }; w.on('message', f); w.postMessage(msg); });
		const packRs = (list) => {   // [{src, path}] -> a packed root set
			const src = new Int32Array(list.length), off = new Int32Array(list.length + 1);
			let total = 0;
			for (const e of list) total += e.path.length;
			const masks = new Uint8Array(total);
			let at = 0;
			list.forEach((e, i) => { src[i] = e.src; off[i] = at; masks.set(e.path, at); at += e.path.length; });
			off[list.length] = at;
			return { src, off, masks, hs: null };
		};
		const first = Array.from({ length: threads }, () => []);
		front.forEach((e, i) => first[i % threads].push({ src: e.src, path: e.path }));
		front = null;
		await Promise.all(wk.map((w, i) => ask(w, { type: 'roots', rs: packRs(first[i]) }, 'ready')));
		// THE RE-ROOTING (--rebalance=1.5, 0 off): a child stays on its parent's worker, so the fronts drift apart (NC Naos:
		// the largest 6.7x the least at layer 25); when the largest is past that factor of the mean, every front comes back
		// as paths from the sources, is dealt out again round robin and rebuilt (each state checked against its hash)
		const rebal = args.rebalance !== undefined ? +args.rebalance : 1.5, rebMin = args.rebalanceMin !== undefined ? +args.rebalanceMin : 2000;
		let rebalances = 0, rebalMs = 0;
		const reroot = async () => {
			const t1 = Date.now();
			const ds = await Promise.all(wk.map((w) => ask(w, { type: 'dump' }, 'dumped')));
			const all = [];
			for (const r of ds) for (let i = 0; i < r.rs.src.length; i++) all.push([r.rs, i]);
			const shares = Array.from({ length: threads }, () => []);
			all.forEach((e, i) => shares[i % threads].push(e));
			const packs = shares.map((sh) => {
				let total = 0;
				for (const [rs, i] of sh) total += rs.off[i + 1] - rs.off[i];
				const src = new Int32Array(sh.length), off = new Int32Array(sh.length + 1), hs = new Float64Array(sh.length), masks = new Uint8Array(total);
				let at = 0;
				sh.forEach(([rs, i], q) => { src[q] = rs.src[i]; hs[q] = rs.hs[i]; off[q] = at; masks.set(rs.masks.subarray(rs.off[i], rs.off[i + 1]), at); at += rs.off[i + 1] - rs.off[i]; });
				off[sh.length] = at;
				return { src, off, masks, hs };
			});
			await Promise.all(wk.map((w, i) => ask(w, { type: 'roots', rs: packs[i] }, 'ready')));
			rebalances++; rebalMs += Date.now() - t1;
			say({ ev: 'rebalance', d, states: all.length, ms: Date.now() - t1 });
		};
		for (;;) {
			const rs = await Promise.all(wk.map((w) => ask(w, { type: 'layer', d }, 'done')));
			d++;
			let states = 0, cut = 0, merged = 0, full = 0, stopped = false, minW = Infinity, maxW = 0, bytes = 0, used = 0;
			for (const r of rs) {
				states += r.states; cut += r.cut; merged += r.merged; full += r.full; stopped = stopped || r.stopped; bytes += r.bytes || 0; used += r.used || 0;
				if (r.states < minW) minW = r.states; if (r.states > maxW) maxW = r.states;
				if (r.route && found === null) found = r.route;
			}
			seen += states;
			say({ ev: 'layer', d, states, cut, merged, full, seen, minW, maxW, frontMB: Math.round(bytes / 1e6), usedMB: Math.round(used / 1e6), s: Math.round((Date.now() - t0) / 100) / 10, rssGB: Math.round(process.memoryUsage().rss / 1e8) / 10 });
			if (found !== null) break;
			if (stopped) { out.why = stopped; break; }
			if (states === 0) break;
			// (--fill: the table's load where the run stops, default 0.7; past it the probe runs grow, and a full run keeps
			// its state unmerged: never unsound)
			if (seen > (+args.fill || 0.7) * 2 ** ttBits) { out.why = 'table'; break; }
			if (rebal > 0 && threads > 1 && states > threads * rebMin && maxW > rebal * states / threads && C - d > 3) await reroot();
		}
		out.rebalances = rebalances; out.rebalanceS = rebalMs / 1000;
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
			out.verdict = Number.isFinite(U) && ev.runTicks < U ? 'FASTER' : 'PROVEN';
			// (last hour: the optimum is written in both cases: FASTER and PROVEN are each the first finish = the optimum)
			if (args.out) { Cm.writeEetas(path.resolve(args.out), ev.ms); out.written = args.out; }
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
