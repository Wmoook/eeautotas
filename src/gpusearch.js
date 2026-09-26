'use strict';
// The GPU searcher of one job. grind.js starts it next to its CPU stages when the job runs with the GPU on:
//   node src/gpusearch.js --job=<job dir> [--parent=<grind pid>] [--round=30] [--once=1]
// Round after round it runs the native tool (native/eegpu.exe search, see src/gpu.js) on the job's current best run.
// The GPU tries millions of input variants from the run's own states and returns every exact shortcut it proved (a
// variant that reaches a later state of the run in fewer ticks; the tool re-checks each one on the CPU with two
// independent hashes). Here the shortcuts go into an edge library keyed by state hashes, so they stay valid when
// best.eetas changes; the library is combined with the shortest-path DP of mutate.js on the current best; the result
// is replayed by the exact JS engine (C.evaluate: finish, deaths, random-portal chance) and judged with THE rule
// (C.judge); a faster run goes to the grind through the job inbox (J.tryCandidate), which checks it once more.
// With --every=1, every other round is an "every move" round instead (off by default: on real levels the exact windows
// explode, 20-40 s per 40-60 ticks on a laptop GPU, and the search families find more per second): eegpu explore --rejoin=1 from the run's state at tick T tries
// every input sequence over the next --everyDepth ticks (60; states that match to the exact position and speed are
// merged), and every state equal to a later state of the run is a proven shortcut (re-checked on the CPU). Windows
// start every --everyStep ticks (25) along the run, continuing where the last round stopped, --everyS seconds each (5).
// Live numbers for the page go to <job>/gpu_status.json (t, state, name, ticks, ticksPerSec, edges, round, ...).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.js');
const J = require('./jobs.js');
const G = require('./gpu.js');
const E = C.E;

const args = C.parseArgs(process.argv.slice(2));
const DIR = path.resolve(args.job || '');
const ID = path.basename(DIR);
const ROUND_S = Math.max(5, +(args.round || 30));
// every-move rounds: opt in with --every=1 (exact every-move windows are slow on big levels; see the header)
const EVERY_ON = args.every !== undefined && String(args.every) !== '0';
const EVERY_DEPTH = Math.max(5, +(args.everyDepth || 60)), EVERY_STEP = Math.max(1, +(args.everyStep || 25)), EVERY_S = Math.max(1, +(args.everyS || 5));
const PARENT = +(args.parent || 0);
const GDIR = path.join(DIR, 'gpu');
const STATUS = path.join(DIR, 'gpu_status.json');
fs.mkdirSync(GDIR, { recursive: true });

const log = (s) => {
	const line = `[gpu ${new Date().toTimeString().slice(0, 8)}] ${s}`;
	console.log(line);
	try { fs.appendFileSync(path.join(DIR, 'grind.log'), line + '\n'); } catch (e) { /* ignore */ }
};
const st = { t: 0, state: 'starting', name: null, ticks: 0, ticksPerSec: 0, edges: 0, round: 0, found: 0, submitted: 0, saved: 0, why: null };
function status(extra) {
	Object.assign(st, extra || {}, { t: Date.now() });
	try { C.writeAtomic(STATUS, JSON.stringify(st)); } catch (e) { /* ignore */ }
}
let child = null;
function quit(code) {
	if (child && child.exitCode === null) { try { child.kill(); } catch (e) { /* gone */ } }
	status({ state: code ? 'error' : 'stopped', ticksPerSec: 0 });
	process.exit(code);
}
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
if (PARENT) setInterval(() => { try { process.kill(PARENT, 0); } catch (e) { quit(0); } }, 2000).unref();

// ---------------------------------------------------------------- the reference (the current best) in JS
/** Replays the run: per-tick state hash (the search's rejoin key), random-portal draw count, and the finish. */
function reference(level, masks, nc) {
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	const H = [sim.stateHash(false, nc)], R = [sim._rngSteps];
	let complete = -1;
	const crown0 = sim.has_silver_crown;
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		H.push(sim.stateHash(false, nc)); R.push(sim._rngSteps);
		if (!crown0 && sim.has_silver_crown) { complete = t + 1; break; }
	}
	return { H, R, n: complete, masks: complete > 0 ? masks.slice(0, complete) : masks };
}

// ---------------------------------------------------------------- the edge library
// start hash -> Map(end key -> seq): end key = the end state's hash, or 'F' = the level finish
const lib = new Map();
let libSize = 0;
function addEdge(hStart, endKey, seq) {
	let m = lib.get(hStart);
	if (!m) { m = new Map(); lib.set(hStart, m); }
	const old = m.get(endKey);
	if (!old || seq.length < old.length) { if (!old) libSize++; m.set(endKey, seq); return true; }
	return false;
}
function readEdges(file, ref) {
	const b = fs.readFileSync(file);
	if (b.length < 16 || b.readUInt32LE(0) !== 0x44454545) throw new Error('bad edges file');
	const count = b.readUInt32LE(8);
	let p = 16, added = 0;
	for (let e = 0; e < count; e++) {
		const t = b.readInt32LE(p), j = b.readInt32LE(p + 4), k = b.readInt32LE(p + 8), flags = b[p + 13];
		p += 16;
		const seq = Uint8Array.from(b.subarray(p, p + k));
		p += k;
		if (t < 0 || t > ref.n || j < 0 || j > ref.n) continue;
		if (addEdge(ref.H[t], (flags & 1) ? 'F' : ref.H[j], seq)) added++;
	}
	return { count, added };
}

/** Shortest run over the library on `ref` (mutate.js's DP). avoidRng: skip edges whose replaced part draws random exits. */
function combine(ref, avoidRng) {
	const n = ref.n;
	const last = new Map();
	for (let t = 0; t <= n; t++) last.set(ref.H[t], t);
	const cost = new Float64Array(n + 1).fill(Infinity);
	const via = new Array(n + 1).fill(null);
	cost[0] = 0;
	for (let i = 0; i < n; i++) {
		if (cost[i] + 1 < cost[i + 1]) { cost[i + 1] = cost[i] + 1; via[i + 1] = { i, seq: null }; }
		const m = lib.get(ref.H[i]);
		if (!m) continue;
		for (const [endKey, seq] of m) {
			const j = endKey === 'F' ? n : last.get(endKey);
			if (j === undefined || j - i - seq.length <= 0) continue;
			if (avoidRng && ref.R[j] !== ref.R[i]) continue;
			if (cost[i] + seq.length < cost[j]) { cost[j] = cost[i] + seq.length; via[j] = { i, seq }; }
		}
	}
	if (cost[n] >= n) return null;
	const parts = [];
	let used = 0;
	for (let j = n; j > 0;) { const v = via[j]; parts.push(v.seq ? v.seq : [ref.masks[v.i]]); if (v.seq) used++; j = v.i; }
	parts.reverse();
	const ms = new Uint8Array(cost[n]);
	let o = 0;
	for (const part of parts) for (const x of part) ms[o++] = x;
	return { ms, used, ticks: cost[n] };
}

// ---------------------------------------------------------------- one round on the GPU
function runRound(tool, blobFile, refFile, edgesFile, seconds, nc, seed, families) {
	return new Promise((resolve) => {
		const a = ['search', blobFile, refFile, edgesFile, `--seconds=${seconds}`, `--nocoins=${nc ? 1 : 0}`, `--seed=${seed}`, `--families=${families}`];
		child = spawn(tool, a, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let buf = '', done = null, err = '';
		const base = st.ticks;
		child.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let ev;
				try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'progress') status({ state: 'running', ticks: base + ev.ticks, ticksPerSec: Math.round(ev.ticksPerSec), family: ev.family });
				else if (ev.ev === 'done') done = ev;
				else if (ev.error) err = ev.error;
			}
		});
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => { child = null; resolve({ code, done, err: err.trim() }); });
	});
}

// ---------------------------------------------------------------- one "every move" round (windows along the run)
let everyCursor = Math.max(0, +(args.everyFrom || 0));
/** one window: every move from tick T; its shortcuts go into the library. Resolves {added, done, err}. */
function runWindow(tool, blobFile, refFile, ref, nc, T) {
	return new Promise((resolve) => {
		const a = ['explore', blobFile, refFile, `--from=${T}`, '--rejoin=1', `--nocoins=${nc ? 1 : 0}`, `--depth=${EVERY_DEPTH}`, `--seconds=${EVERY_S}`,
			'--qy=0', '--qvy=0', '--discrete=1', '--cap=1000000'];
		child = spawn(tool, a, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let buf = '', done = null, err = '', added = 0, last = 0;
		const base = st.ticks;
		child.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let ev;
				try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'rejoin') {
					if (ev.from >= 0 && ev.from <= ref.n && ev.j > ev.from && ev.j <= ref.n && ev.saving > 0) {
						const seq = Uint8Array.from(String(ev.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
						if (addEdge(ref.H[ev.from], ref.H[ev.j], seq)) added++;
					}
				} else if (ev.ev === 'layer') {
					last = ev.ticks;
					status({ state: 'running', ticks: base + ev.ticks, ticksPerSec: Math.round(ev.ticksPerSec), family: `every move from tick ${T}` });
				} else if (ev.ev === 'done') done = ev;
				else if (ev.error) err = ev.error;
			}
		});
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => { child = null; if (done) st.ticks = base + (done.ticks || last); resolve({ code, done, err: err.trim(), added }); });
	});
}
/** windows from the cursor on for about ROUND_S seconds */
async function runEvery(tool, blobFile, refFile, ref, nc) {
	const t0 = Date.now();
	let added = 0, windows = 0, from = everyCursor % Math.max(1, ref.n), gpu = null, ticks = 0;
	while ((Date.now() - t0) / 1000 < ROUND_S) {
		const T = everyCursor % Math.max(1, ref.n);
		everyCursor = T + EVERY_STEP;
		const r = await runWindow(tool, blobFile, refFile, ref, nc, T);
		if (!r.done) return { err: r.err || `the GPU tool exited with code ${r.code}`, added, windows };
		windows++; added += r.added; gpu = r.done.gpu; ticks += r.done.ticks || 0;
		if (everyCursor >= ref.n) { everyCursor = 0; log(`GPU: every move covered the whole run (windows of ${EVERY_DEPTH} ticks every ${EVERY_STEP})`); break; }
	}
	return { added, windows, from, to: everyCursor, gpu, ticks, seconds: (Date.now() - t0) / 1000 };
}

async function main() {
	if (!args.job || !fs.existsSync(DIR)) { console.log('usage: node src/gpusearch.js --job=<job dir>'); process.exit(2); }
	const tool = G.nativeTool();
	if (!tool) { status({ state: 'unavailable', why: 'the native engine is not built (node tools/build-native.js)' }); log('GPU: native engine missing'); process.exit(3); }
	const level = J.loadJobLevel(ID);
	const why = G.unsupported(level);
	if (why) { status({ state: 'unavailable', why }); log(`GPU: not used for this level: ${why}`); process.exit(3); }
	const blobFile = path.join(GDIR, 'level.bin');
	fs.writeFileSync(blobFile, G.levelBlob(level));
	const refFile = path.join(GDIR, 'ref.eetas'), edgesFile = path.join(GDIR, 'edges.bin');
	const bestFile = path.join(DIR, 'best.eetas');
	// coin-blind search when the grind decided coins are optional (status.json coinsOptional)
	let nc = null;
	for (let i = 0; i < 30 && nc === null; i++) {
		const s = C.readJSON(path.join(DIR, 'status.json'), {});
		if (typeof s.coinsOptional === 'boolean') nc = s.coinsOptional;
		else await new Promise((r) => setTimeout(r, 1000));
	}
	if (nc === null) nc = false;
	let refKey = '', ref = null, round = 0, systematicFor = '';
	log(`GPU search started (${nc ? 'coin-blind' : 'coin-aware'}), rounds of ${ROUND_S} s`);
	for (;;) {
		// the current best (it changes when the grind accepts something)
		const bytes = fs.readFileSync(bestFile);
		const key = C.sha1 ? C.sha1(bytes) : require('crypto').createHash('sha1').update(bytes).digest('hex');
		if (key !== refKey) {
			ref = reference(level, C.parseEetasBuffer(bytes), nc);
			if (ref.n < 0) { log('GPU: best.eetas does not finish; waiting'); await new Promise((r) => setTimeout(r, 5000)); continue; }
			refKey = key;
			C.writeEetas(refFile, ref.masks);
			// the library may already hold a faster combination for the new best
			await offer(level, ref, 'library');
		}
		round++;
		// every other round: every move along the run (not the first: the systematic families go first)
		if ((EVERY_ON && round % 2 === 0) || args.everyOnly) {
			const e = await runEvery(tool, blobFile, refFile, ref, nc);
			if (e.err) {
				status({ state: 'error', why: e.err, ticksPerSec: 0 });
				log(`GPU: every-move round failed: ${e.err}`);
				if (args.once) process.exit(4);
				await new Promise((res) => setTimeout(res, 15000));
				continue;
			}
			status({ state: 'running', round, edges: libSize, found: st.found + e.added, ticksPerSec: e.seconds ? Math.round(e.ticks / e.seconds) : 0,
				lastRound: { kind: 'every move', windows: e.windows, from: e.from, to: e.to, ticks: e.ticks, seconds: e.seconds } });
			if (e.added) { log(`GPU: every move, ticks ${e.from}-${e.to}: ${e.added} new shortcut${e.added > 1 ? 's' : ''}`); await offer(level, ref, `every move ${e.from}-${e.to}`); }
			if (args.once) break;
			continue;
		}
		// the systematic families once per new best, then the random ones (new seeds every round)
		const fams = systematicFor === refKey ? 'pert,flip,sticky' : 'm1,del,m2,pert,flip,sticky';
		systematicFor = refKey;
		const r = await runRound(tool, blobFile, refFile, edgesFile, ROUND_S, nc, round * 7919 + 17, fams);
		if (!r.done) {
			status({ state: 'error', why: r.err || `the GPU tool exited with code ${r.code}`, ticksPerSec: 0 });
			log(`GPU: round failed: ${r.err || 'exit ' + r.code}`);
			if (args.once) process.exit(4);
			await new Promise((res) => setTimeout(res, 15000));
			continue;
		}
		const d = r.done;
		if (!st.name) log(`GPU: ${d.gpu.name}, ${(d.ticksPerSec / 1e6).toFixed(1)} M ticks/s`);
		let added = 0;
		try { added = readEdges(edgesFile, ref).added; } catch (e) { log(`GPU: ${e.message}`); }
		status({ state: 'running', name: d.gpu.name, round, edges: libSize, found: st.found + added, ticksPerSec: Math.round(d.ticksPerSec), lastRound: { ticks: d.ticks, seconds: d.seconds, edges: d.edges, bestSaving: d.bestSaving } });
		if (added) await offer(level, ref, `round ${round}`);
		if (args.once) break;
	}
	quit(0);
}

let lastOffer = '';
/** Combines the library on the reference; if the result is faster and passes THE rule, hands it to the job. */
async function offer(level, ref, what) {
	const best = C.evaluate(level, ref.masks);
	if (!best) return;
	for (const avoidRng of [false, true]) {
		const c = combine(ref, avoidRng);
		if (!c || c.ticks >= ref.n) return;
		const cand = C.evaluate(level, c.ms);
		const v = C.judge(cand, best, best.deaths);
		if (!v.accept) {
			if (cand && cand.runTicks < best.runTicks && !avoidRng && C.isRandom(level)) continue;   // chance dropped: without draws
			log(`GPU: combined ${c.used} shortcuts but the result is not accepted (${v.reason})`);
			return;
		}
		const k = `${ref.n}:${cand.runTicks}`;
		if (k === lastOffer) return;
		lastOffer = k;
		const res = await J.tryCandidate(ID, C.eetasBytes(cand.ms), { source: `gpu (${c.used} shortcuts)`, wait: 0 });
		st.submitted++;
		st.saved = Math.max(st.saved, best.runTicks - cand.runTicks);
		status({ lastSubmit: { t: Date.now(), runTicks: cand.runTicks, saved: best.runTicks - cand.runTicks, handed: res.handed, accepted: res.accepted } });
		log(`GPU: ${what}: ${c.used} shortcuts -> ${C.fmt(best.runTicks)} to ${C.fmt(cand.runTicks)} (-${best.runTicks - cand.runTicks}), handed to the ${res.handed === 'inbox' ? 'grind' : 'job'}${res.accepted ? ' (accepted)' : ''}`);
		return;
	}
}

main().catch((e) => { log(`GPU: error: ${e && e.stack || e}`); status({ state: 'error', why: String(e && e.message || e) }); process.exit(1); });
