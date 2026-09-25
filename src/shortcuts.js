'use strict';
// Local shortcut finder for a TAS (Everybody Edits physics, ./eesim.js).
//
// From the reference run's exact state at every --step-th tick i, a local beam search (all 18 inputs per tick,
// exact-state dedupe, --cap states per tick, ranked by progress along the reference route) runs for --depth ticks.
// Whenever a searched state is EXACTLY a later reference state (same EESim.stateKey) S(j) after d ticks with
// i + d < j, the inputs are a verified shortcut i -> j saving j - (i + d) ticks: from S(j) the reference inputs
// replay exactly. All shortcuts are then combined by dynamic programming over the reference ticks (shortest path)
// and the result is verified by a clean replay. Workers search different start ticks independently.
//
// usage: node tools/tas/shortcuts.js [--tas=tools/tas/out/best.eetas] [--out=...] [--step=10] [--depth=80]
//        [--cap=3000] [--workers=16] [--from=0] [--to=<ticks>] [--level=forgotten_veil]

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('./eesim.js');
const ROOT = path.resolve(__dirname, '..', '..');

const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
const NOPT = 18;
const OI = (h, v, j) => h * 6 + v * 2 + j;
const WIN_BACK = 24, WIN_AHEAD = 90, VEL_W = 3.0, MAX_D = 40.0, BUCKET_CAP = 2;

function parseArgs() {
	const a = { level: 'forgotten_veil', tas: path.join(__dirname, 'out', 'best.eetas'), out: null, step: 10, depth: 80, cap: 3000,
		workers: os.cpus().length, from: 0, to: 0, dist: 24, verbose: 0, bucket: 1, bcap: 8, nocoins: 0 };
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) continue;
		a[m[1]] = (m[1] === 'tas' || m[1] === 'level' || m[1] === 'out') ? m[2] : parseFloat(m[2]);
	}
	if (!a.out) a.out = path.join(__dirname, 'out', 'shortcuts_best.eetas');
	a.levelData = path.join(__dirname, 'data', a.level + '.json');
	return a;
}

function onSet(m) {
	if (!m || m.size === 0) return '';
	const ids = [];
	for (const [id, v] of m) if (v === true) ids.push(id);
	return ids.sort((x, y) => x - y).join('.');
}
let NOCOINS = false;   // --nocoins=1: contexts and rejoins ignore which coins were collected (coins are optional)
function contextKey(sim) {
	return (NOCOINS ? '' : sim.coins + ',' + sim.blue_coins + ',') + (sim.has_crown ? 1 : 0) + ',' + (sim._keysMask | 0) + ',' +
		onSet(sim._switches) + ',' + onSet(sim._oswitches);
}
function hashKey(k) {
	let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
	for (let i = 0; i < k.length; i++) {
		const c = k.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 16777619);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995);
		h2 ^= h2 >>> 15;
	}
	return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

// replay the reference: per-tick route data, exact-state map, snapshots at wanted ticks
function reference(level, masks, wantSnap) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const R = { RX: new Float64Array(n + 1), RY: new Float64Array(n + 1), RVX: new Float64Array(n + 1), RVY: new Float64Array(n + 1),
		RC: new Int32Array(n + 1), keyTick: new Map(), snaps: new Map(), complete: -1, runTicks: 0, n };
	const ctxIds = new Map();
	let complete = -1;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); };
	const rec = (j) => {
		R.RX[j] = sim.px; R.RY[j] = sim.py; R.RVX[j] = sim.speed_x; R.RVY[j] = sim.speed_y;
		const ck = contextKey(sim);
		let id = ctxIds.get(ck);
		if (id === undefined) { id = ctxIds.size; ctxIds.set(ck, id); }
		R.RC[j] = id;
		R.keyTick.set(sim.stateHash(false, NOCOINS), j);
		if (wantSnap && wantSnap(j)) R.snaps.set(j, sim.snapshot());
	};
	rec(0);
	for (let t = 0; t < n; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); rec(t + 1); }
	R.complete = complete; R.runTicks = sim.run_ticks; R.ctxIds = ctxIds;
	return R;
}

function workerMain() {
	const { a, starts } = workerData;
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = E.parseEetas(fs.readFileSync(a.tas, 'utf8'));
	const startSet = new Set(starts);
	const R = reference(level, masks, (j) => startSet.has(j));
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	let dead = false;
	sim.onEvent = (k) => { if (k === 'death') dead = true; };
	const RN = R.n;

	function progressOf(p) {
		const c = R.ctxIds.get(contextKey(sim));
		const x = sim.px, y = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		let lo = p - WIN_BACK, hi = p + WIN_AHEAD;
		if (lo < 0) lo = 0;
		if (hi > RN) hi = RN;
		let best = -1, bestD = 1e18;
		if (c !== undefined) {
			for (let j = lo; j <= hi; j++) {
				if (R.RC[j] !== c) continue;
				const d = Math.abs(x - R.RX[j]) + Math.abs(y - R.RY[j]) + VEL_W * (Math.abs(vx - R.RVX[j]) + Math.abs(vy - R.RVY[j]));
				if (d <= bestD) { bestD = d; best = j; }
			}
		}
		return [best, bestD];
	}

	const cap = a.cap, depth = a.depth;
	const stop = new Int32Array(workerData.stopBuf);
	// per-layer storage
	for (const i of starts) {
		if (Atomics.load(stop, 0) !== 0) break;   // --deadline reached: main combines what was found
		const s0 = R.snaps.get(i);
		if (!s0) continue;
		let snaps = [s0], progs = [i];
		const hPar = [], hIn = [];
		const found = new Map();   // j -> {d, layer, idx}
		const keys = new Float64Array(cap * NOPT);
		let cProg = new Float64Array(cap * NOPT), cKey = new Float64Array(cap * NOPT),
			cBuck = new Float64Array(cap * NOPT), cPar = new Int32Array(cap * NOPT), cIn = new Uint8Array(cap * NOPT);
		for (let d = 1; d <= depth && snaps.length > 0; d++) {
			let m = 0;
			const tNow = i + d;   // reference-time of the children if they were on schedule
			for (let pi = 0; pi < snaps.length; pi++) {
				// probes for no-op pruning (up/down, left/right), like optimize.js
				let k0 = -1, ku = -2, kd = -3, kl = -4, kr = -5;
				for (let o = 0; o < NOPT; o++) {
					const h = (o / 6) | 0, v = ((o % 6) / 2) | 0, jb = o & 1;
					if (!(jb === 0 && (h === 0 || v === 0))) {
						// skip combinations whose direction probe was a no-op
						if (v !== 0 && ku === k0 && kd === k0) continue;
						if (h !== 0 && kl === k0 && kr === k0) continue;
					}
					sim.restore(snaps[pi]);
					dead = false;
					E.applyMask(inp, OPTIONS[o]);
					sim.tick(inp);
					if (dead || sim.is_dead) continue;
					const key = sim.stateHash(false, NOCOINS);
					if (jb === 0) {
						if (h === 0 && v === 0) k0 = key; else if (h === 0 && v === 1) ku = key; else if (h === 0 && v === 2) kd = key;
						else if (v === 0 && h === 1) kl = key; else if (v === 0 && h === 2) kr = key;
					}
					// exact reconvergence with a later reference state?
					const j = R.keyTick.get(key);
					if (j !== undefined && j > tNow) {
						const f = found.get(j);
						if (!f || d < f.d) found.set(j, { d, layer: hPar.length, par: pi, inp: OPTIONS[o] });
					}
					const pd = progressOf(progs[pi]);
					let p = pd[0];
					if (p < 0) continue;
					const off = pd[1] > MAX_D;
					const sc = p - Math.min(pd[1], 1e5) / a.dist - (off ? 8 : 0);
					cProg[m] = off ? progs[pi] : p; cKey[m] = key;   // no snapshot: survivors are re-simulated below
					cBuck[m] = (p * 131071 + Math.floor(sim.px / a.bucket) * 8191 + Math.floor(sim.py / a.bucket) * 127 + (Math.sign(sim.speed_x) + 1) * 3 + Math.sign(sim.speed_y) + 1);
					cPar[m] = pi; cIn[m] = OPTIONS[o];
					keys[m] = Math.floor(sc * 1e4) * 1048576 + m;
					m++;
				}
			}
			// select
			const sub = keys.subarray(0, m);
			sub.sort();
			const seen = new Set(), buck = new Map();
			const nS = [], nP = [], par = [], ins = [];
			for (let r = m - 1; r >= 0 && nS.length < cap; r--) {
				const kv = sub[r];
				const ci = kv - Math.floor(kv / 1048576) * 1048576;
				if (seen.has(cKey[ci])) continue;
				const b = cBuck[ci], nb = buck.get(b) || 0;
				if (nb >= a.bcap) continue;
				seen.add(cKey[ci]); buck.set(b, nb + 1);
				// re-simulate the survivor from its parent (one tick) instead of snapshotting every child
				sim.restore(snaps[cPar[ci]]);
				E.applyMask(inp, cIn[ci]);
				sim.tick(inp);
				nS.push(sim.snapshot()); nP.push(cProg[ci]); par.push(cPar[ci]); ins.push(cIn[ci]);
			}
			hPar.push(Int32Array.from(par)); hIn.push(Uint8Array.from(ins));
			if (a.verbose && (d % 10 === 0 || d < 4)) console.log(`[sc/w] start ${i} depth ${d}: ${m} children -> ${nS.length} kept`);
			snaps = nS; progs = nP;
		}
		// report shortcuts (rebuild inputs: the found child's parent chain)
		const res = [];
		for (const [j, f] of found) {
			const seq = new Uint8Array(f.d);
			seq[f.d - 1] = f.inp;
			let k = f.par;
			for (let L = f.layer - 1; L >= 0; L--) { seq[L] = hIn[L][k]; k = hPar[L][k]; }
			res.push({ i, j, d: f.d, seq: Array.from(seq) });
		}
		parentPort.postMessage({ type: 'res', i, res });
	}
	parentPort.postMessage({ type: 'done' });
}

async function main() {
	const a = parseArgs();
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = E.parseEetas(fs.readFileSync(a.tas, 'utf8'));
	const R = reference(level, masks, null);
	const to = a.to || R.complete;
	console.log(`[sc] reference ${a.tas}: completes at ${R.complete}, run_ticks ${R.runTicks}; starts ${a.from}..${to} every ${a.step}, ` +
		`depth ${a.depth}, cap ${a.cap}, ${a.workers} workers`);
	const starts = [];
	for (let i = a.from; i < to; i += a.step) starts.push(i);
	const t0 = Date.now();
	const all = [];
	let doneStarts = 0;
	const stopBuf = new SharedArrayBuffer(4), stop = new Int32Array(stopBuf);
	const dl = a.deadline ? setInterval(() => {
		if (Date.now() >= a.deadline && Atomics.load(stop, 0) === 0) { Atomics.store(stop, 0, 1); console.log('[sc] deadline: finishing the current starts'); }
	}, 1000) : null;
	await Promise.all(Array.from({ length: a.workers }, (_, w) => new Promise((res) => {
		const mine = starts.filter((_, k) => k % a.workers === w);
		const wk = new Worker(__filename, { workerData: { a, starts: mine, stopBuf } });
		wk.on('message', (msg) => {
			if (msg.type === 'res') {
				doneStarts++;
				for (const s of msg.res) all.push(s);
				const good = msg.res.filter((s) => s.j - (s.i + s.d) > 0);
				if (good.length) {
					const b = good.reduce((x, y) => (y.j - y.i - y.d > x.j - x.i - x.d ? y : x));
					console.log(`[sc]   start ${msg.i}: ${good.length} shortcuts, best ${b.i} -> ${b.j} in ${b.d} ticks (saves ${b.j - b.i - b.d}) ` +
						`[${doneStarts}/${starts.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s]`);
				}
			} else if (msg.type === 'done') res();
		});
		wk.on('error', (e) => { console.log('[sc] worker error', e); res(); });
	})));
	if (dl) clearInterval(dl);
	// DP over reference ticks: cost[j] = fewest ticks to reach the exact reference state S(j)
	const n = R.complete;
	const cost = new Float64Array(n + 1).fill(Infinity), via = new Array(n + 1).fill(null);
	cost[0] = 0;
	const byStart = new Map();
	for (const s of all) { if (s.j <= n) { if (!byStart.has(s.i)) byStart.set(s.i, []); byStart.get(s.i).push(s); } }
	for (let i = 0; i < n; i++) {
		if (cost[i] + 1 < cost[i + 1]) { cost[i + 1] = cost[i] + 1; via[i + 1] = { i, seq: null }; }
		const list = byStart.get(i);
		if (list) for (const s of list) if (cost[i] + s.d < cost[s.j]) { cost[s.j] = cost[i] + s.d; via[s.j] = { i, seq: s.seq }; }
	}
	console.log(`[sc] ${all.length} shortcuts found in ${((Date.now() - t0) / 1000).toFixed(0)} s; DP: ${n} -> ${cost[n]} ticks`);
	// rebuild
	const parts = [];
	for (let j = n; j > 0;) { const v = via[j]; parts.push(v.seq ? v.seq : [masks[v.i]]); j = v.i; }
	parts.reverse();
	const seq = [].concat(...parts);
	// verify
	const V = reference(level, seq, null);
	console.log(`[sc] result: ${seq.length} ticks, completes at ${V.complete}, run_ticks ${V.runTicks} (was ${R.runTicks})`);
	const used = [];
	for (let j = n; j > 0;) { const v = via[j]; if (v.seq) used.push(`${v.i}->${j} (-${j - v.i - v.seq.length})`); j = v.i; }
	console.log(`[sc] shortcuts used: ${used.reverse().join(', ')}`);
	if (V.complete >= 0 && V.runTicks < R.runTicks) {
		fs.writeFileSync(a.out, seq.map((m) => String.fromCharCode(48 + m)).join(''));
		console.log(`[sc] written ${a.out}`);
	}
}

if (isMainThread) main();
else workerMain();
