'use strict';
// Splices TAS runs at exactly equal states: if run A at tick i is in the same state (EESim.stateHash) as run B at
// tick j, then A[0..i) + B[j..] behaves exactly like B from j on, finishing (j - i) ticks sooner than B does.
// Given several runs that all complete the level, finds the fastest combination (shortest path over the union of
// the runs' state graphs: a node per distinct state, an edge per tick of every run) and writes it, verified by a
// clean replay. Runs are simulated in the given level, so a run made for another job of the same level works too
// (one that does not finish here simply drops out).
// Also a module (grind.js splices a rejected run with the best at once; gpusearch.js adds the GPU's edge library):
//   trace(level, masks, nc, withR), traceCache(level, nc, withR), unionGraph(runs).path({lib, avoidRng}), splice(...)
// usage: node src/splice.js out.eetas run1.eetas run2.eetas ... [--level=<level id | job id>] [--nocoins]
// (--level can be left out when run1.eetas is inside src/jobs/<id>/)
const path = require('path');
const fs = require('fs');
const C = require('./common.js');
const E = C.E;

/**
 * Replays a run: H[t] = stateHash after t ticks (nc: coin-blind), up to the finish. n = the finish tick (-1: does not
 * finish), masks = the inputs cut at the finish, R[t] = random-portal draws so far (withR).
 */
function trace(level, masks, nc, withR) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const NC = !!nc;
	const H = new Float64Array(masks.length + 1);
	const R = withR ? new Int32Array(masks.length + 1) : null;
	H[0] = sim.stateHash(false, NC);
	if (R) R[0] = sim._rngSteps;
	const crown0 = sim.has_silver_crown;
	let n = -1;
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		H[t + 1] = sim.stateHash(false, NC);
		if (R) R[t + 1] = sim._rngSteps;
		if (!crown0 && sim.has_silver_crown) { n = t + 1; break; }
	}
	if (n < 0) return { H: null, R: null, n: -1, masks: null };
	const ms = new Uint8Array(n);
	for (let t = 0; t < n; t++) ms[t] = masks[t];
	return { H: H.slice(0, n + 1), R: R ? R.slice(0, n + 1) : null, n, masks: ms };
}

/**
 * Traces by file (path + size + mtime) or by a caller's key, so a run is simulated once per process. get(file) and
 * of(key, masks) return the trace (n -1: does not finish) or null when the file cannot be read.
 */
function traceCache(level, nc, withR) {
	const m = new Map();
	return {
		get(file) {
			let st;
			try { st = fs.statSync(file); } catch (e) { return null; }
			const key = `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`;
			let tr = m.get(key);
			if (tr === undefined) {
				try { tr = trace(level, C.readEetas(file), nc, withR); } catch (e) { tr = null; }
				m.set(key, tr);
			}
			return tr;
		},
		of(key, masks) {
			let tr = m.get(key);
			if (tr === undefined) { tr = trace(level, masks, nc, withR); m.set(key, tr); }
			return tr;
		},
		/** forget everything but the traces for which keep(key) is true */
		prune(keep) { for (const k of [...m.keys()]) if (!keep(k)) m.delete(k); },
		get size() { return m.size; },
	};
}

/**
 * State hash -> dense id (0, 1, 2, ... in first-seen order): open addressing on typed arrays (a Map with 53-bit
 * number keys is 10-20x slower at a million states). id(h) adds, get(h) returns -1 when unknown.
 */
class HashIndex {
	constructor(expect) {
		let cap = 1024;
		while (cap < 2 * expect) cap *= 2;
		this.keys = new Float64Array(cap); this.vals = new Int32Array(cap).fill(-1); this.mask = cap - 1; this.size = 0;
	}
	slot(h) {
		const x = Math.imul((h >>> 0) ^ Math.imul((h / 4294967296) >>> 0, 0x9e3779b1), 0x85ebca6b);   // both halves of the 53 bits
		const keys = this.keys, vals = this.vals, mask = this.mask;
		let i = (x ^ (x >>> 15)) & mask;
		while (vals[i] >= 0 && keys[i] !== h) i = (i + 1) & mask;
		return i;
	}
	id(h) {
		let i = this.slot(h);
		const v = this.vals[i];
		if (v >= 0) return v;
		if (2 * (this.size + 1) > this.keys.length) {
			const ok = this.keys, ov = this.vals;
			this.keys = new Float64Array(2 * ok.length); this.vals = new Int32Array(2 * ok.length).fill(-1); this.mask = 2 * ok.length - 1;
			for (let j = 0; j < ok.length; j++) if (ov[j] >= 0) { const s = this.slot(ok[j]); this.keys[s] = ok[j]; this.vals[s] = ov[j]; }
			i = this.slot(h);
		}
		this.keys[i] = h; this.vals[i] = this.size;
		return this.size++;
	}
	get(h) { return this.vals[this.slot(h)]; }
}
const hashIndex = (expect) => new HashIndex(expect);

/**
 * The union of the runs' state graphs: a node per distinct state hash, an edge per tick of every run (cost 1, that
 * run's input). runs: traces (trace(); every one must finish). Built once, searched as often as needed with
 * path(opts) (gpusearch.js searches it again after every GPU round, with the grown edge library).
 */
function unionGraph(runs) {
	let T = 0;
	const off = new Int32Array(runs.length + 1);
	for (let r = 0; r < runs.length; r++) { off[r] = T; T += runs[r].n + 1; }
	off[runs.length] = T;
	// node ids: the distinct hashes (g = a global tick index: run r's tick t is g = off[r] + t)
	const index = hashIndex(1 << 16);
	const nodeOf = new Int32Array(T), runOf = new Int32Array(T);
	for (let r = 0; r < runs.length; r++) {
		const H = runs[r].H;
		for (let t = 0, g = off[r]; t < H.length; t++, g++) { nodeOf[g] = index.id(H[t]); runOf[g] = r; }
	}
	const N = index.size;
	// occurrences per node, runs[0] first (ties keep its inputs)
	const occHead = new Int32Array(N).fill(-1), occNext = new Int32Array(T);
	for (let r = runs.length - 1; r >= 0; r--) {
		for (let g = off[r + 1] - 1; g >= off[r]; g--) { const a = nodeOf[g]; occNext[g] = occHead[a]; occHead[a] = g; }
	}
	const GOAL = N;   // (a virtual node: the finish reached by a library edge)
	const isGoal = new Uint8Array(N + 1);
	isGoal[GOAL] = 1;
	for (let r = 0; r < runs.length; r++) isGoal[nodeOf[off[r] + runs[r].n]] = 1;
	let nodeR = null;   // random-portal draws per node (the hash contains them on levels with random portals)
	const drawsOf = () => {
		if (!nodeR) {
			nodeR = new Int32Array(N);
			for (let r = 0; r < runs.length; r++) for (let t = 0; t <= runs[r].n; t++) nodeR[nodeOf[off[r] + t]] = runs[r].R[t];
		}
		return nodeR;
	};
	/**
	 * The fastest run from runs[0]'s start: Dijkstra with a bucket queue over the graph plus every `lib` edge (start
	 * hash -> Map(end hash, or 'F' = the level finish, -> {seq, fam}); cost = its length); the first finish state
	 * reached wins, ties keep runs[0]'s own inputs. opts.avoidRng: no step of another run and no library edge may
	 * change the random-portal draw count (the runs need R). Returns null or { ms, ticks, libUsed: [{h0, h1, seq,
	 * fam, at}], runsUsed (Set of run indices), switches, checks: [[tick, hash]] (the state after each library edge) }.
	 */
	function path(opts) {
		const o = opts || {};
		const lib = o.lib || null;
		const avoidRng = !!o.avoidRng && runs.every((r) => r.R);
		const R = avoidRng ? drawsOf() : null;
		const finalR = avoidRng ? runs[0].R[runs[0].n] : 0;
		// library edges by start node
		const libList = [];
		let libHead = null, libNext = null;
		if (lib && lib.size) {
			const from = [];
			for (const [h0, m] of lib) {
				const a = index.get(h0);
				if (a < 0) continue;
				for (const [endKey, e] of m) {
					const b = endKey === 'F' ? GOAL : index.get(endKey);
					if (b < 0) continue;
					if (avoidRng && (b === GOAL ? R[a] !== finalR : R[a] !== R[b])) continue;
					from.push(a);
					libList.push({ to: b, h0, h1: endKey, seq: e.seq, fam: e.fam });
				}
			}
			libHead = new Int32Array(N).fill(-1); libNext = new Int32Array(libList.length);
			for (let k = libList.length - 1; k >= 0; k--) { libNext[k] = libHead[from[k]]; libHead[from[k]] = k; }
		}
		// Dijkstra (integer costs >= 1): buckets by distance; among equally short paths the one with the fewest library
		// edges (an edge that only repeats a run's own stretch is not used). Exact: every relaxation into a node of
		// distance D comes from a node popped before it (distance < D).
		const INF = 0x7fffffff;
		const dist = new Int32Array(N + 1).fill(INF), prev = new Int32Array(N + 1).fill(-1), via = new Int32Array(N + 1);
		const nlib = new Int32Array(N + 1);
		const done = new Uint8Array(N + 1);
		const s0 = nodeOf[0];
		const buckets = [[s0]];
		dist[s0] = 0;
		let found = -1;
		for (let d = 0; d < buckets.length && found < 0; d++) {
			const q = buckets[d];
			if (!q) continue;
			buckets[d] = null;
			for (let i = 0; i < q.length; i++) {
				const a = q[i];
				if (done[a] || dist[a] !== d) continue;
				done[a] = 1;
				if (isGoal[a]) { found = a; break; }
				const la = nlib[a];
				for (let g = occHead[a]; g >= 0; g = occNext[g]) {
					const r = runOf[g];
					if (g + 1 >= off[r + 1]) continue;   // the run's finish state: nothing after it
					if (avoidRng && r !== 0) { const t = g - off[r]; if (runs[r].R[t + 1] !== runs[r].R[t]) continue; }
					const b = nodeOf[g + 1];
					if (d + 1 < dist[b]) { dist[b] = d + 1; prev[b] = a; via[b] = g; nlib[b] = la; (buckets[d + 1] || (buckets[d + 1] = [])).push(b); }
					else if (d + 1 === dist[b] && la < nlib[b] && !done[b]) { prev[b] = a; via[b] = g; nlib[b] = la; }
				}
				if (libHead) {
					for (let k = libHead[a]; k >= 0; k = libNext[k]) {
						const b = libList[k].to, nd = d + libList[k].seq.length;
						if (nd < dist[b]) { dist[b] = nd; prev[b] = a; via[b] = -1 - k; nlib[b] = la + 1; (buckets[nd] || (buckets[nd] = [])).push(b); }
						else if (nd === dist[b] && la + 1 < nlib[b] && !done[b]) { prev[b] = a; via[b] = -1 - k; nlib[b] = la + 1; }
					}
				}
			}
		}
		if (found < 0) return null;
		// rebuild: walk back from the finish
		const parts = [];
		for (let b = found; b !== s0; b = prev[b]) parts.push(via[b]);
		parts.reverse();
		const ms = new Uint8Array(dist[found]);
		const libUsed = [], runsUsed = new Set(), checks = [];
		let p = 0, lastRun = -1, switches = 0;
		for (const v of parts) {
			if (v >= 0) {
				const r = runOf[v];
				ms[p++] = runs[r].masks[v - off[r]];
				runsUsed.add(r);
				if (r !== lastRun) { if (lastRun >= 0) switches++; lastRun = r; }
			} else {
				const e = libList[-1 - v];
				const at = p;
				for (let q = 0; q < e.seq.length; q++) ms[p++] = e.seq[q];
				libUsed.push({ h0: e.h0, h1: e.h1, seq: e.seq, fam: e.fam, at });
				if (e.h1 !== 'F') checks.push([p, e.h1]);
				lastRun = -1;
			}
		}
		return { ms, ticks: ms.length, libUsed, runsUsed, switches, checks, nodes: N };
	}
	return { runs, nodes: N, ticks: T, has: (h) => index.get(h) >= 0, path };
}
/** unionGraph(runs).path(opts): see there. */
const unionPath = (runs, opts) => unionGraph(runs).path(opts);

/** The first check [tick, hash] the run does not meet (a library edge that is not exact here), or null. */
function firstBadCheck(level, ms, checks, nc) {
	if (!checks.length) return null;
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	let k = 0;
	for (let t = 0; t < ms.length && k < checks.length; t++) {
		E.applyMask(inp, ms[t]);
		sim.tick(inp);
		while (k < checks.length && checks[k][0] === t + 1) {
			if (sim.stateHash(false, !!nc) !== checks[k][1]) return k;
			k++;
		}
	}
	return null;
}

/** Splices finishing runs (masks) in `level`: the union path from the first run's start, or null. */
function splice(level, runMasks, nc, opts) {
	const o = opts || {};
	const runs = runMasks.map((m) => trace(level, m, nc, !!o.avoidRng)).filter((r) => r.n >= 0);
	if (!runs.length) return null;
	return unionPath(runs, o);
}

function main() {
	const args = process.argv.slice(2);
	const levelArg = (args.find((a) => a.startsWith('--level=')) || '--level=').slice(8);
	const files = args.filter((a) => !a.startsWith('--'));
	const NOCOINS = args.includes('--nocoins');   // join at states equal apart from collected coins (coins are optional)
	const outFile = files.shift();
	if (!outFile || !files.length) { console.log('usage: node src/splice.js out.eetas run1.eetas run2.eetas ... [--level=<id>] [--nocoins]'); process.exit(2); }
	const L = E.loadLevel(C.levelData(levelArg, files[0]));
	const runs = [];
	for (const f of files) {
		let tr = null;
		try { tr = trace(L, C.readEetas(f), NOCOINS, false); } catch (e) { console.log(`[splice] ${f}: ${e.message}, skipped`); continue; }
		if (tr.n < 0) { console.log(`[splice] ${f} does not complete, skipped`); continue; }
		tr.f = f;
		runs.push(tr);
	}
	if (!runs.length) { console.log('[splice] no run completes the level'); process.exit(1); }
	for (const r of runs) console.log(`[splice] ${path.basename(r.f)}: completes at ${r.n}`);
	const t0 = Date.now();
	const u = unionPath(runs);
	console.log(`[splice] ${u.nodes} distinct states; path: ${u.ticks} ticks over ${[...u.runsUsed].map((r) => path.basename(runs[r].f)).join(', ')} ` +
		`(${u.switches} splices, ${Date.now() - t0} ms)`);
	const v = C.replay(L, u.ms);
	console.log(`[splice] result: completes at ${v.complete}, run_ticks ${v.runTicks}`);
	if (v.complete >= 0) C.writeEetas(outFile, u.ms);
}

if (require.main === module) main();
module.exports = { trace, traceCache, unionGraph, unionPath, firstBadCheck, splice, hashIndex };
