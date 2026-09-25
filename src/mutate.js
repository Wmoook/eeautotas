'use strict';
// Input-mutation search: the classic manual TAS moves, tried everywhere, verified exactly.
//
// For every tick t of the reference run and every mutation M of the inputs around t (delete tick t; replace the
// input at t by each other option; delete tick t and replace the next input; delete ticks t and t+1; replace two
// consecutive inputs by one option), replay the mutated inputs followed by the reference inputs from S(t). If
// the state ever equals (stateHash) a reference state S(j) whose tick j is later than the mutated run's tick,
// the mutation is a verified shortcut t -> j. Stop a candidate after --horizon ticks or when it drifts more than
// --drift px from where the reference is at the same shifted time. All shortcuts are combined by DP over the
// reference ticks, verified by a clean replay and written.
//
// usage: node tools/tas/mutate.js [--tas=tools/tas/out/best.eetas] [--out=...] [--horizon=600] [--drift=96]
//        [--workers=16] [--from=0] [--to=<end>] [--level=forgotten_veil] [--deadline=<epoch ms>]

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('./eesim.js');

let NOCOINS = false;   // --nocoins=1: rejoins ignore which coins were collected (coins are optional)
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);

function parseArgs() {
	const a = { level: 'forgotten_veil', tas: path.join(__dirname, 'out', 'best.eetas'), out: path.join(__dirname, 'out', 'mutate_best.eetas'),
		horizon: 600, drift: 96, workers: os.cpus().length, from: 0, to: 0, deadline: 0, pairs: 1, nocoins: 0 };
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (m) a[m[1]] = (m[1] === 'tas' || m[1] === 'out' || m[1] === 'level') ? m[2] : parseFloat(m[2]);
	}
	a.levelData = path.join(__dirname, 'data', a.level + '.json');
	return a;
}

function reference(level, masks, wantSnaps) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const R = { X: new Float64Array(n + 1), Y: new Float64Array(n + 1), hashTick: new Map(), snaps: wantSnaps ? new Array(n + 1) : null,
		complete: -1, runTicks: 0, n };
	let complete = -1;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); };
	const rec = (j) => {
		R.X[j] = sim.px; R.Y[j] = sim.py;
		R.hashTick.set(sim.stateHash(false, NOCOINS), j);
		if (wantSnaps) R.snaps[j] = sim.snapshot();
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
		for (let g = 1; g <= 5; g++) {
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

function workerMain() {
	const { a, ticks } = workerData;
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = E.parseEetas(fs.readFileSync(a.tas, 'utf8'));
	const R = reference(level, masks, true);
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	let dead = false;
	sim.onEvent = (k) => { if (k === 'death') dead = true; };
	const stop = new Int32Array(workerData.stopBuf);
	const found = [];
	let done = 0;
	for (const t of ticks) {
		if (Atomics.load(stop, 0) !== 0) break;
		if (t >= R.complete) continue;
		for (const mu of mutationsAt(masks, t, workerData.pairs)) {
			sim.restore(R.snaps[t]);
			dead = false;
			let k = 0;   // ticks played by the mutated run since S(t)
			for (const o of mu.rep) { E.applyMask(inp, o); sim.tick(inp); k++; }
			let r = t + mu.skip;   // next reference input to play
			let hit = -1, hitK = 0;
			while (k < a.horizon && r < masks.length && !dead && !sim.is_dead) {
				// verified rejoin: the state equals the reference state at a later reference tick
				const j = R.hashTick.get(sim.stateHash(false, NOCOINS));
				if (j !== undefined) {
					if (j > t + k) { hit = j; hitK = k; }
					break;   // back on the reference: ahead (a shortcut), level (no effect) or behind (slower)
				}
				// drifted away from the reference (compared at the same reference input position r)?
				if (Math.abs(sim.px - R.X[r]) + Math.abs(sim.py - R.Y[r]) > a.drift) break;
				E.applyMask(inp, masks[r]); sim.tick(inp); k++; r++;
			}
			if (hit >= 0 && !dead) {
				// shortcut t -> hit in hitK ticks: the inputs are rep + masks[t+skip .. t+skip+hitK-rep.length)
				const seq = mu.rep.slice();
				for (let q = t + mu.skip; seq.length < hitK; q++) seq.push(masks[q]);
				found.push({ i: t, j: hit, seq });
			}
		}
		if (++done % 200 === 0) parentPort.postMessage({ type: 'progress', done });
	}
	parentPort.postMessage({ type: 'res', found });
}

async function main() {
	const a = parseArgs();
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = E.parseEetas(fs.readFileSync(a.tas, 'utf8'));
	const R = reference(level, masks, false);
	const to = Math.min(a.to || R.complete, R.complete);
	console.log(`[mut] ${a.tas}: completes at ${R.complete}, run_ticks ${R.runTicks}; ticks ${a.from}..${to}, horizon ${a.horizon}, ` +
		`${a.workers} workers, ${mutationsAt(masks, 100, false).length} single / ${mutationsAt(masks, 100, true).length} pair mutations per tick`);
	const t0 = Date.now();
	const stopBuf = new SharedArrayBuffer(4), stop = new Int32Array(stopBuf);
	const dl = a.deadline ? setInterval(() => { if (Date.now() >= a.deadline) Atomics.store(stop, 0, 1); }, 1000) : null;
	const all = [];
	const runAll = (pairs) => Promise.all(Array.from({ length: a.workers }, (_, w) => new Promise((res) => {
		const ticks = [];
		for (let t = a.from + w; t < to; t += a.workers) ticks.push(t);
		const wk = new Worker(__filename, { workerData: { a, ticks, stopBuf, pairs } });
		wk.on('message', (m) => { if (m.type === 'res') { for (const f of m.found) all.push(f); res(); } });
		wk.on('error', (e) => { console.log('[mut] worker error', e); res(); });
	})));
	await runAll(false);
	if (!all.some((s) => s.j - s.i - s.seq.length > 0) && a.pairs !== 0) {
		console.log(`[mut] single changes found nothing (${((Date.now() - t0) / 1000).toFixed(0)} s): trying pairs of changes`);
		await runAll(true);
	}
	if (dl) clearInterval(dl);
	const n = R.complete;
	const saving = all.filter((s) => s.j - s.i - s.seq.length > 0);
	console.log(`[mut] ${all.length} rejoins, ${saving.length} saving time, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
	// DP
	const cost = new Float64Array(n + 1).fill(Infinity), via = new Array(n + 1).fill(null);
	cost[0] = 0;
	const byStart = new Map();
	for (const s of saving) if (s.j <= n) { if (!byStart.has(s.i)) byStart.set(s.i, []); byStart.get(s.i).push(s); }
	for (let i = 0; i < n; i++) {
		if (cost[i] + 1 < cost[i + 1]) { cost[i + 1] = cost[i] + 1; via[i + 1] = { i, seq: null }; }
		const list = byStart.get(i);
		if (list) for (const s of list) if (cost[i] + s.seq.length < cost[s.j]) { cost[s.j] = cost[i] + s.seq.length; via[s.j] = { i, seq: s.seq }; }
	}
	const parts = [], used = [];
	for (let j = n; j > 0;) { const v = via[j]; parts.push(v.seq ? v.seq : [masks[v.i]]); if (v.seq) used.push(`${v.i}->${j} (-${j - v.i - v.seq.length})`); j = v.i; }
	parts.reverse();
	const seq = [].concat(...parts);
	const V = reference(level, seq, false);
	console.log(`[mut] DP: ${n} -> ${cost[n]} ticks; result completes at ${V.complete}, run_ticks ${V.runTicks} (was ${R.runTicks})`);
	console.log(`[mut] used: ${used.reverse().join(', ')}`);
	if (V.complete >= 0 && V.runTicks < R.runTicks) {
		fs.writeFileSync(a.out, seq.map((m) => String.fromCharCode(48 + m)).join(''));
		console.log(`[mut] written ${a.out}`);
	}
}

if (isMainThread) main();
else workerMain();
