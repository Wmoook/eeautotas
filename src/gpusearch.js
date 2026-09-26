'use strict';
// The GPU searcher of one job. grind.js starts it next to its CPU stages when the job runs with the GPU on:
//   node src/gpusearch.js --job=<job dir> [--parent=<grind pid>] [--round=30] [--once=1] [--union=40] [--siblings=1]
// Round after round it runs the native tool (native/eegpu.exe search, see src/gpu.js) on the job's newest best run.
// The GPU tries millions of input variants from the run's own states and returns every exact shortcut it proved (a
// variant that reaches a later state of the run in fewer ticks; the tool re-checks each one on the CPU with two
// independent hashes). Here the shortcuts go into an edge library keyed by state hashes, so they stay valid when the
// run changes; it is kept in gpu/library.bin (fingerprinted by the engine, the level and the coin mode).
// A round (--round seconds) is split into separate eegpu invocations, each from its own saved cursor, because eegpu
// runs every systematic family before any random one and restarts at --from every time:
//   m1 + del (the systematic single changes): up to --sysShare (0.3) of the round, until one full pass over the
//     current best is done (windows sized by the measured speed, so a window finishes);
//   m2 (pairs of changes, 250-300x fewer shortcuts per tick than m1): up to --m2Share (0.2), its own wrapping cursor;
//   pert / flip / sticky (random perturbations, one family per round in turn): the rest, at least half.
// Cursors, the seed counter and per-family numbers are kept in gpu/state.json, so a restart continues.
// After every invocation that found something, the library is combined with the UNION of every run the job knows
// (splice.js unionGraph: the current best, the runs this searcher judged, best_*.eetas, pieces/, the grind's stage
// outputs and, with --siblings=1, the best runs of other jobs of the same level, simulated in this job's level; the
// --union most recent ones): the shortest path over their states plus the library's edges. The result is replayed by
// the exact JS engine (C.evaluate: finish, deaths, random-portal chance) and judged with THE rule (C.judge); a faster
// run goes to the grind through the job inbox (J.tryCandidate), which checks it once more, and becomes the reference
// of the next invocation at once (no waiting for the grind to publish it).
// With --every=1, every other round is an "every move" round instead (off by default: on real levels the exact windows
// explode, 20-40 s per 40-60 ticks on a laptop GPU, and the search families find more per second): eegpu explore --rejoin=1 from the run's state at tick T tries
// every input sequence over the next --everyDepth ticks (60; states that match to the exact position and speed are
// merged), and every state equal to a later state of the run is a proven shortcut (re-checked on the CPU). Windows
// start every --everyStep ticks (25) along the run, continuing where the last round stopped, --everyS seconds each (5).
// Live numbers for the page go to <job>/gpu_status.json (t, state, name, ticks, ticksPerSec, edges, round, families, ...).
// GPU launch failures (eegpu's {"error":...,"launchError":true} line, exit 6 / 7 = the driver's watchdog stopped a
// kernel, or a crash): the driver may have reset the GPU, so the searcher backs off instead of relaunching at once: it
// waits 60 s (120 s after a second failure in a row), halves the launch target (eegpu --launch-ms, from --launchMs=50),
// and stops for this session after 3 failures in a row or 5 in all, with a log line; the grind's CPU stages go on.
// Quitting (SIGINT / SIGTERM, the grind gone) asks the running eegpu to stop between two launches (gpu/stop, its
// --stopfile; jobs.js stopGpuSearcher writes it too) and never kills it: a kill while a kernel runs makes the driver
// reset the GPU. eegpu runs detached with --parent, so it also ends at its next launch when this process is killed.
// (--tool=<file.js>: a script that answers like `eegpu search`, for tests without a GPU.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common.js');
const J = require('./jobs.js');
const G = require('./gpu.js');
const S = require('./splice.js');

const args = C.parseArgs(process.argv.slice(2));
const DIR = path.resolve(args.job || '');
const ID = path.basename(DIR);
const ROUND_S = Math.max(5, +(args.round || 30));
const SYS_SHARE = Math.max(0, Math.min(0.5, args.sysShare !== undefined ? +args.sysShare : 0.3));
const M2_SHARE = Math.max(0, Math.min(0.5, args.m2Share !== undefined ? +args.m2Share : 0.2));
const MIN_SLICE = 4;   // s: shorter invocations are mostly start-up (reference upload, kernel load)
const UNION_K = Math.max(1, +(args.union || 40));   // the most recent runs in the union (30 Infinity Pain runs ~ 1.4 M states)
const SIBLINGS = String(args.siblings === undefined ? '1' : args.siblings) !== '0';
const LIB_MAX = 300000;   // edges kept; above it, edges that start on no known run are dropped
// every-move rounds: opt in with --every=1 (exact every-move windows are slow on big levels; see the header)
const EVERY_ON = args.every !== undefined && String(args.every) !== '0';
const EVERY_DEPTH = Math.max(5, +(args.everyDepth || 60)), EVERY_STEP = Math.max(1, +(args.everyStep || 25)), EVERY_S = Math.max(1, +(args.everyS || 5));
const PARENT = +(args.parent || 0);
// eegpu's launch target (ms per kernel launch; halved after each launch failure) and the failures so far
let launchMs = Math.max(5, Math.min(1000, +(args.launchMs || 50)));
let launchFails = 0, launchFailsAll = 0;
const FAILS_IN_A_ROW = 3, FAILS_IN_ALL = 5;
/** a failed eegpu run that looks like a GPU launch failure: its launchError line, exit 6 / 7, or a crash (no JSON) */
const isLaunchFailure = (code, sawLaunchError, done) => !done && (sawLaunchError || code === 6 || code === 7 || (Number.isFinite(code) && (code < 0 || code > 255)));
const GDIR = path.join(DIR, 'gpu');
const STATUS = path.join(DIR, 'gpu_status.json');
const STATE = path.join(GDIR, 'state.json');
const LIBRARY = path.join(GDIR, 'library.bin');
const FAMS = ['m1', 'del', 'm2', 'pert', 'flip', 'sticky'];   // eegpu's family numbers
const LIB_FAMS = [...FAMS, 'every'];                           // (+ the every-move windows)
const RANDOM_FAMS = ['pert', 'flip', 'sticky'];
fs.mkdirSync(GDIR, { recursive: true });

const log = (s) => {
	const line = `[gpu ${new Date().toTimeString().slice(0, 8)}] ${s}`;
	console.log(line);
	try { fs.appendFileSync(path.join(DIR, 'grind.log'), line + '\n'); } catch (e) { /* ignore */ }
};
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const st = { t: 0, state: 'starting', name: null, ticks: 0, ticksPerSec: 0, edges: 0, round: 0, found: 0, submitted: 0, saved: 0, why: null, families: {} };
function status(extra) {
	Object.assign(st, extra || {}, { t: Date.now() });
	try { C.writeAtomic(STATUS, JSON.stringify(st)); } catch (e) { /* ignore */ }
}
let child = null, quitting = false;
// the running eegpu's stop file (its --stopfile): killing it while a kernel runs makes the NVIDIA driver reset the GPU,
// so quit() asks it to stop between two launches instead
const STOPFILE = path.join(GDIR, 'stop');
function quit(code) {
	const end = () => {
		try { saveLibrary(true); saveState(); } catch (e) { /* not loaded yet */ }
		status({ state: code ? 'error' : 'stopped', ticksPerSec: 0 });
		process.exit(code);
	};
	if (quitting) return;
	quitting = true;
	const ch = child;
	if (ch && ch.exitCode === null) {
		// (the running eegpu is never killed: killing it mid-kernel makes Windows reset the display driver. Its stop file
		// ends it between two launches; if it has not ended 2 s later (loading its kernels, say), it ends by itself at its
		// next launch or within its --seconds)
		try { fs.writeFileSync(STOPFILE, 'quit'); } catch (e) { /* it ends within its --seconds */ }
		const t = setTimeout(end, 2000);
		ch.once('close', () => { clearTimeout(t); end(); });
		return;
	}
	end();
}
/** eegpu's stop options: its stop file, and this process as its parent. eegpu is started detached: Node kills the
 *  children it did not start detached the moment it exits (also when it is killed), mid-kernel too; a detached eegpu
 *  ends at its next kernel launch once this process is gone (--parent) or the stop file is there */
const EEGPU_OPTS = () => [`--stopfile=${STOPFILE}`, `--parent=${process.pid}`];
/** a new eegpu run: no stop request left over */
const clearStop = () => { try { fs.unlinkSync(STOPFILE); } catch (e) { /* none */ } };
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
if (PARENT) setInterval(() => { try { process.kill(PARENT, 0); } catch (e) { quit(0); } }, 2000).unref();

// ---------------------------------------------------------------- saved state (cursors, seed counter, per-family numbers)
// cursors are {t, h}: a tick of the reference and its state hash, found again by hash when the reference changes
const state = Object.assign({ v: 1, seed: 0, rot: 0, every: 0, cur: {}, left: null, rate: {}, fam: {} }, C.readJSON(STATE, {}));
for (const f of LIB_FAMS) state.fam[f] = Object.assign({ ticks: 0, seconds: 0, hits: 0, edges: 0, used: 0, saved: 0 }, state.fam[f] || {});
function saveState() { try { C.writeAtomic(STATE, JSON.stringify(state)); } catch (e) { /* ignore */ } }
/** the next search seed: a persisted counter, so a restart never repeats the random families' candidates */
function nextSeed() { state.seed = (state.seed | 0) + 1; return state.seed * 7919 + 17; }

// ---------------------------------------------------------------- the edge library
// start hash -> Map(end key -> {seq, fam}): end key = the end state's hash, or 'F' = the level finish
const lib = new Map();
let libSize = 0, libDirty = false, libSaved = 0;
function addEdge(hStart, endKey, seq, fam) {
	let m = lib.get(hStart);
	if (!m) { m = new Map(); lib.set(hStart, m); }
	const old = m.get(endKey);
	if (!old || seq.length < old.seq.length) { if (!old) libSize++; m.set(endKey, { seq, fam }); libDirty = true; return true; }
	return false;
}
function dropEdge(hStart, endKey) {
	const m = lib.get(hStart);
	if (m && m.delete(endKey)) { libSize--; libDirty = true; if (!m.size) lib.delete(hStart); }
}
function readEdges(file, ref) {
	const b = fs.readFileSync(file);
	if (b.length < 16 || b.readUInt32LE(0) !== 0x44454545) throw new Error('bad edges file');
	const count = b.readUInt32LE(8);
	let p = 16, added = 0;
	const byFam = {};
	for (let e = 0; e < count; e++) {
		const t = b.readInt32LE(p), j = b.readInt32LE(p + 4), k = b.readInt32LE(p + 8), fam = FAMS[b[p + 12]] || 'm1', flags = b[p + 13];
		p += 16;
		const seq = Uint8Array.from(b.subarray(p, p + k));
		p += k;
		if (t < 0 || t > ref.n || j < 0 || j > ref.n) continue;
		if (addEdge(ref.H[t], (flags & 1) ? 'F' : ref.H[j], seq, fam)) { added++; byFam[fam] = (byFam[fam] || 0) + 1; }
	}
	return { count, added, byFam };
}
// gpu/library.bin: "EELB", version 1, count, fingerprint (40 hex chars), then per edge: start hash (f64), end hash (f64,
// 0 for the finish), flags (u8, 1 = the finish), family (u8), length (u32), the inputs
const LIB_MAGIC = 0x424c4545;
let fingerprint = '';
/** Edges are valid only for the same engine (state hash layout and physics: eesim.js), level blob and coin mode. */
function libraryFingerprint(blob, nc) {
	let engine = '';
	try { engine = sha1(fs.readFileSync(require.resolve('./eesim.js'))); } catch (e) { /* bundled */ }
	return sha1(`EELB1|engine ${engine}|level ${sha1(blob)}|nocoins ${nc ? 1 : 0}`);
}
function loadLibrary() {
	let b;
	try { b = fs.readFileSync(LIBRARY); } catch (e) { return 0; }
	if (b.length < 52 || b.readUInt32LE(0) !== LIB_MAGIC || b.readUInt32LE(4) !== 1) { log('GPU: gpu/library.bin is not a library file; starting a new one'); return 0; }
	if (b.toString('latin1', 12, 52) !== fingerprint) { log('GPU: the saved shortcut library is for another engine, level or coin mode; starting a new one'); return 0; }
	const count = b.readUInt32LE(8);
	let p = 52, n = 0;
	for (let e = 0; e < count && p + 22 <= b.length; e++) {
		const h0 = b.readDoubleLE(p), h1 = b.readDoubleLE(p + 8), flags = b[p + 16], fam = LIB_FAMS[b[p + 17]] || 'm1', k = b.readUInt32LE(p + 18);
		p += 22;
		if (p + k > b.length) break;
		addEdge(h0, (flags & 1) ? 'F' : h1, Uint8Array.from(b.subarray(p, p + k)), fam);
		p += k;
		n++;
	}
	libDirty = false;
	return n;
}
function saveLibrary(force) {
	if (!fingerprint || !libDirty || (!force && Date.now() - libSaved < 15000)) return;
	let bytes = 52;
	for (const m of lib.values()) for (const e of m.values()) bytes += 22 + e.seq.length;
	const b = Buffer.alloc(bytes);
	b.writeUInt32LE(LIB_MAGIC, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(libSize, 8); b.write(fingerprint, 12, 'latin1');
	let p = 52;
	for (const [h0, m] of lib) {
		for (const [endKey, e] of m) {
			b.writeDoubleLE(h0, p); b.writeDoubleLE(endKey === 'F' ? 0 : endKey, p + 8); b[p + 16] = endKey === 'F' ? 1 : 0;
			b[p + 17] = Math.max(0, LIB_FAMS.indexOf(e.fam)); b.writeUInt32LE(e.seq.length, p + 18);
			p += 22;
			b.set(e.seq, p); p += e.seq.length;
		}
	}
	try { C.writeAtomic(LIBRARY, b); libDirty = false; libSaved = Date.now(); } catch (e) { /* retried next time */ }
}
/** Over LIB_MAX edges: drop the ones whose start state is on no run of the union (they can never be used). */
function pruneLibrary(graph) {
	if (libSize <= LIB_MAX || !graph) return;
	const before = libSize;
	for (const [h0, m] of [...lib]) if (!graph.has(h0)) { libSize -= m.size; lib.delete(h0); }
	libDirty = true;
	log(`GPU: shortcut library over ${LIB_MAX} edges: dropped ${before - libSize} that start on no known run (${libSize} left)`);
}

// ---------------------------------------------------------------- the reference: the newest judged best
let level = null, nc = false, RANDOM = false, TC = null;
let ref = null;          // { key, masks, n, H, R, ev (C.evaluate), tickOf (hash -> last tick) }
let own = null;          // the last run this searcher judged faster: { key, ms, ev, inbox (its inbox file while the grind decides) }
const ownRuns = [];      // the runs this searcher judged (for the union), newest last
let diskKey = '', disk = null;
const sameOrBetter = (a, b) => a.runTicks < b.runTicks || (a.runTicks === b.runTicks && a.chance >= b.chance - 1e-9);
/** best.eetas or this searcher's own judged run, whichever is faster: the reference of the next invocation */
async function refresh() {
	let bytes;
	try { bytes = fs.readFileSync(path.join(DIR, 'best.eetas')); } catch (e) { return false; }
	const key = sha1(bytes);
	if (key !== diskKey) {
		const ms = C.parseEetasBuffer(bytes);
		const ev = C.evaluate(level, ms);
		if (!ev) { if (!ref) { log('GPU: best.eetas does not finish; waiting'); } return !!ref; }
		diskKey = key; disk = { key, ms: ev.ms, ev };
	}
	if (own && own.inbox) {
		// the grind's verdict on it (e.g. a best with a higher random-portal chance came from the CPU meanwhile): a run
		// it did not take must not stay the reference, or every later run built on it is refused too
		const rec = J.inboxResult(ID, own.inbox);
		if (rec) {
			own.inbox = '';
			if (!rec.accepted && !sameOrBetter(disk.ev, own.ev)) { log(`GPU: the grind did not take ${C.fmt(own.ev.runTicks)} (${rec.reason}); searching the job's best again`); own = null; }
		}
	}
	if (own && sameOrBetter(disk.ev, own.ev)) own = null;   // the grind has it (or something better)
	const pick = own || disk;
	if (ref && pick.key === ref.key) return true;
	const tr = TC.of('run:' + pick.key, pick.ms);
	if (tr.n < 0) return !!ref;
	const old = ref;
	ref = { key: pick.key, masks: tr.masks, n: tr.n, H: tr.H, R: tr.R, ev: pick.ev, tickOf: new Map() };
	for (let t = 0; t <= ref.n; t++) ref.tickOf.set(ref.H[t], t);
	C.writeEetas(path.join(GDIR, 'ref.eetas'), ref.masks);
	// a new reference: the systematic families need a full pass over it again (their cursors continue by state hash)
	if (!state.left || state.left.key !== ref.key) {
		state.left = { key: ref.key, sys: ref.n, m2: ref.n };
		// ... from just before the first state the old reference never reached: a new stretch is unpolished (after a route
		// change most follow-up finds are inside it), and the pass still covers the whole run
		if (old) {
			let first = -1;
			for (let t = 0; t <= ref.n && first < 0; t++) if (!old.tickOf.has(ref.H[t])) first = t;
			if (first >= 0) { setCursor('sys', Math.max(0, first - 300)); log(`GPU: the new best differs from tick ${first} on: the single changes start there (tick ${Math.max(0, first - 300)})`); }
		}
	}
	if (old) await offer('new best');
	saveState();
	return true;
}
/** a cursor's tick on the current reference (found by its state hash, else its old tick) */
function cursorAt(name) {
	const c = state.cur[name];
	if (!c) return 0;
	const t = c.h !== undefined ? ref.tickOf.get(c.h) : undefined;
	return Math.max(0, Math.min(ref.n - 1, t !== undefined ? t : c.t | 0));
}
function setCursor(name, t) {
	const tt = t >= ref.n ? 0 : Math.max(0, t | 0);   // (wraps at the end)
	state.cur[name] = { t: tt, h: ref.H[tt] };
}

// ---------------------------------------------------------------- the union of every known run
let graph = null, graphSig = '';
function unionSources() {
	const out = [];
	const add = (dir, re, tag) => {
		let fl = [];
		try { fl = fs.readdirSync(dir).filter((f) => re.test(f)); } catch (e) { return; }
		for (const f of fl) {
			const file = path.join(dir, f);
			try { out.push({ file, tag, mtime: fs.statSync(file).mtimeMs }); } catch (e) { /* gone */ }
		}
	};
	add(DIR, /^best_\d+\.eetas$/, 'best');
	add(path.join(DIR, 'pieces'), /\.eetas$/, 'piece');
	add(path.join(DIR, 'pieces', 'gpu'), /\.eetas$/, 'piece');
	add(DIR, /^grind_(?!ref|mutref).*\.eetas$/, 'stage');
	if (SIBLINGS) {
		// other jobs of the same level (size): their best runs, simulated in this job's level (a run that does not
		// finish here drops out)
		const me = C.readJSON(path.join(DIR, 'meta.json'), {});
		const lv = me.level || {};
		for (const id of C.jobIds()) {
			if (id === ID) continue;
			const m = C.readJSON(path.join(C.JOBS, id, 'meta.json'), {});
			if (!m.level || m.level.width !== lv.width || m.level.height !== lv.height) continue;
			const file = path.join(C.JOBS, id, 'best.eetas');
			try { out.push({ file, tag: `job ${id}`, mtime: fs.statSync(file).mtimeMs }); } catch (e) { /* none */ }
		}
	}
	out.sort((x, y) => y.mtime - x.mtime);
	return out;
}
/** the union graph: the reference first (its start is the path's start), then this searcher's runs, then the files */
function unionGraph() {
	const runs = [{ tr: TC.of('run:' + ref.key, ref.masks), tag: 'best' }];
	for (let i = ownRuns.length - 1; i >= 0; i--) if (ownRuns[i].key !== ref.key) runs.push({ tr: TC.of('run:' + ownRuns[i].key, ownRuns[i].ms), tag: 'gpu' });
	const keys = new Set(['run:' + ref.key, ...ownRuns.map((o) => 'run:' + o.key)]);
	for (const s of unionSources()) {
		if (runs.length >= UNION_K + 1) break;
		keys.add(s.file);
		const tr = TC.get(s.file);
		if (!tr || tr.n < 0) continue;
		runs.push({ tr, tag: s.tag, file: s.file, mtime: s.mtime });
	}
	// (a file rewritten in place, grind_now.eetas or another job's best, is a new run: its mtime is in the signature)
	const sig = runs.map((r) => (r.file ? `${r.file}:${r.mtime}:${r.tr.n}` : r.tr.n)).join('|') + '|' + ref.key;
	if (graph && sig === graphSig) return graph;
	TC.prune((k) => keys.has(k) || keys.has(k.split('|')[0]));
	graph = S.unionGraph(runs.map((r) => r.tr));
	graph.tags = runs.map((r) => r.tag);
	graphSig = sig;
	pruneLibrary(graph);
	return graph;
}

let refOnly = null;
/** the reference alone as a graph (the library's edges on the current best, like mutate's DP) */
function refGraph() {
	if (!refOnly || refOnly.key !== ref.key) {
		refOnly = S.unionGraph([TC.of('run:' + ref.key, ref.masks)]);
		refOnly.key = ref.key; refOnly.tags = ['best'];
	}
	return refOnly;
}
let lastNote = '';
const note = (s, what) => { if (s !== lastNote) { lastNote = s; log(`GPU: ${what}: ${s}`); } };   // (not the same line every round)
/**
 * The fastest run over graph g plus the library that passes THE rule against `base`: {u, cand}, or 'none' (nothing
 * faster) or 'refused' (the fastest combination is not accepted, or it does not replay here).
 */
function combineOn(g, base, what) {
	for (const avoidRng of RANDOM ? [false, true] : [false]) {
		let u = null, cand = null;
		for (let tries = 0; tries < 8; tries++) {
			u = g.path({ lib, avoidRng });
			if (!u || u.run >= base.runTicks) return avoidRng ? 'refused' : 'none';
			cand = C.evaluate(level, u.ms);
			if (cand && cand.complete <= u.ticks) break;
			// a library edge that is not exact here (it cannot happen with a matching fingerprint): drop it, try again
			const k = S.firstBadCheck(level, u.ms, u.checks, nc);
			const bad = k !== null ? u.libUsed.filter((e) => e.h1 !== 'F')[k] : u.libUsed.find((e) => e.h1 === 'F');
			if (!bad) { note(`the combined run${g.runs.length > 1 ? ' of the known runs' : ''} does not replay as its parts (${u.ticks} ticks)`, what); return 'refused'; }
			dropEdge(bad.h0, bad.h1);
			log(`GPU: dropped a shortcut that does not replay exactly (${bad.fam}, ${bad.seq.length} ticks)`);
			cand = null;
		}
		if (!cand) return 'refused';
		const v = C.judge(cand, base, base.deaths);
		if (v.accept) return { u, cand };
		if (cand.runTicks < base.runTicks && !avoidRng && RANDOM) continue;   // chance dropped: again without new draws
		if (cand.runTicks < base.runTicks) note(`combined ${u.libUsed.length} shortcuts${g.runs.length > 1 ? ' and the known runs' : ''} but the result is not accepted (${v.reason})`, what);
		return 'refused';
	}
	return 'refused';
}

let lastOffer = '';
/** Combines the library with the union of every known run; if the result is faster and passes THE rule, hands it to
 *  the job and makes it the reference. */
async function offer(what) {
	if (!ref) return;
	const base = ref.ev;
	// when the union's fastest combination is refused (another run dies more often, a coin-blind join meets a coin
	// door, a lower chance), the reference alone with the library: no other run may hold back the GPU's own shortcuts
	let g = unionGraph();
	let got = combineOn(g, base, what);
	if (got === 'refused' && g.runs.length > 1) { g = refGraph(); got = combineOn(g, base, what); }
	if (typeof got === 'string') return;
	const { u, cand } = got;
	const bytes = C.eetasBytes(cand.ms);
	const key = sha1(bytes);
	if (key === lastOffer) return;
	lastOffer = key;
	// credit: per family, the shortcuts used and the ticks they save on the reference
	const used = {};
	let credited = 0;
	for (const e of u.libUsed) {
		const i = ref.tickOf.get(e.h0), j = e.h1 === 'F' ? ref.n : ref.tickOf.get(e.h1);
		const s = i !== undefined && j !== undefined && j > i ? Math.max(0, j - i - e.seq.length) : 0;
		const f = used[e.fam] || (used[e.fam] = { n: 0, saved: 0 });
		f.n++; f.saved += s; credited += s;
		state.fam[e.fam].used++; state.fam[e.fam].saved += s;
	}
	const saved = base.runTicks - cand.runTicks;
	const others = [...u.runsUsed].filter((r) => r > 0).map((r) => g.tags[r]);
	const sib = [...new Set(others.filter((t) => t.startsWith('job ')))];
	const res = await J.tryCandidate(ID, bytes, { source: `gpu (${u.libUsed.length} shortcuts)`, wait: 0 });
	st.submitted++;
	st.saved = Math.max(st.saved, saved);
	const mine = { key, ms: cand.ms, ev: cand, inbox: res.handed === 'inbox' ? res.inboxFile : '' };
	ownRuns.push(mine);
	if (ownRuns.length > 5) ownRuns.shift();
	own = res.handed === 'direct' && !res.accepted ? null : mine;   // (refused by a stopped job at once: no reference)
	const parts = Object.entries(used).map(([f, x]) => `${f} ${x.n}${x.saved ? ` -${x.saved}` : ''}`);
	if (others.length && saved > credited) parts.push(`other runs -${saved - credited}`);
	status({ lastSubmit: { t: Date.now(), runTicks: cand.runTicks, saved, handed: res.handed, accepted: res.accepted }, families: famStatus() });
	log(`GPU: ${what}: ${u.libUsed.length} shortcuts${others.length ? ` + ${new Set(others).size} other run${new Set(others).size > 1 ? 's' : ''}` : ''} -> ` +
		`${C.fmt(base.runTicks)} to ${C.fmt(cand.runTicks)} (-${saved}) [${parts.join(', ') || 'splices'}]` +
		`${sib.length ? `; uses the route of ${sib.map((t) => t.slice(4)).join(', ')}` : ''}, handed to the ${res.handed === 'inbox' ? 'grind' : 'job'}${res.accepted ? ' (accepted)' : ''}`);
	await refresh();   // the next invocation searches this run
}
const famStatus = () => Object.fromEntries(LIB_FAMS.map((f) => [f, state.fam[f]]));

// ---------------------------------------------------------------- one eegpu search invocation
function toolCommand(tool, a) {
	return /\.js$/i.test(tool) ? [process.execPath, [tool, ...a]] : [tool, a];
}
/** eegpu's ready event (its kernels loaded; its --seconds count from there): a slow load is the driver compiling the
 *  kernels for this graphics card (the first run after an update), worth a line in the log */
function loaded(ev) {
	const ms = (+ev.loadMs || 0) + (+ev.allocMs || 0);
	if (ms >= 5000) log(`GPU: the engine took ${(ms / 1000).toFixed(0)} s to start (kernels ${((+ev.loadMs || 0) / 1000).toFixed(1)} s, memory ${((+ev.allocMs || 0) / 1000).toFixed(1)} s${ev.module ? `, ${ev.module}` : ''})`);
}
/** Runs `eegpu search`; resolves {code, done, err, at: {family: {max, last, wrapped}}} (the progress positions per
 *  family: every start tick below `max` is done; wrapped = its pass over [from, to) ended). */
function runSearch(tool, blobFile, refFile, edgesFile, o) {
	return new Promise((resolve) => {
		const a = ['search', blobFile, refFile, edgesFile, `--seconds=${o.seconds.toFixed(1)}`, `--nocoins=${nc ? 1 : 0}`, `--seed=${o.seed}`,
			`--families=${o.families}`, `--from=${o.from}`, `--to=${o.to}`, `--launch-ms=${launchMs}`, ...EEGPU_OPTS(), ...G.cacheArgs()];
		const [cmd, argv] = toolCommand(tool, a);
		clearStop();
		child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });   // (EEGPU_OPTS)
		let buf = '', done = null, err = '', launchError = false;
		const at = {};
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
				if (ev.ev === 'ready') loaded(ev);
				else if (ev.ev === 'progress') {
					status({ state: 'running', ticks: base + ev.ticks, ticksPerSec: Math.round(ev.ticksPerSec), family: ev.family });
					// eegpu prints the next start tick of the running family (its pass over [from, to) restarts at from)
					const p = at[ev.family] || (at[ev.family] = { max: o.from, last: o.from, wrapped: false });
					if (typeof ev.at === 'number') {
						if (ev.at < p.last || (ev.at <= o.from && p.max > o.from)) p.wrapped = true;   // (its pass ended and started over)
						else if (!p.wrapped) p.max = Math.max(p.max, ev.at);
						p.last = ev.at;
					}
				} else if (ev.ev === 'done') done = ev;
				else if (ev.error) { err = ev.error; if (ev.launchError) launchError = true; }
			}
		});
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => {
			child = null;
			if (done) st.ticks = base + (done.ticks || 0);
			resolve({ code, done, err: err.trim(), at, launchError: isLaunchFailure(code, launchError, done) });
		});
	});
}

let tool = null, blobFile = '', edgesFile = '';
const G9 = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)} G` : `${(x / 1e6).toFixed(0)} M`);
/**
 * One invocation of a slot: 'sys' (m1 + del), 'm2' or a random family. Returns {ok, seconds, edges, text} (text: a
 * piece of the round's log line) or {ok: false, err}.
 */
async function invoke(slot, seconds) {
	const random = RANDOM_FAMS.includes(slot);
	const families = slot === 'sys' ? 'm1,del' : slot;
	const secArg = Math.round(seconds * 10) / 10;
	const n = ref.n;
	const from = cursorAt(slot);
	let to = n;
	if (!random) {
		// size the window so the pass finishes in the time (what is left of the slot goes to the next window or to
		// the random families); the first window measures the speed (start ticks per second of kernel time)
		const rate = state.rate[slot], over = state.rate.overhead || 1;
		const want = rate > 0 ? Math.floor(rate * Math.max(0.5, secArg - over) * 0.8) : 512;
		to = Math.min(n, from + Math.max(64, want), from + state.left[slot]);
	}
	const t0 = Date.now();
	const seed = nextSeed();
	saveState();   // (a restart never repeats a seed, also when this invocation is cut off)
	const r = await runSearch(tool, blobFile, path.join(GDIR, 'ref.eetas'), edgesFile, { seconds: secArg, seed, families, from, to });
	if (!r.done) return { ok: false, err: r.err || `the GPU tool exited with code ${r.code}`, launchError: r.launchError };
	launchFails = 0;   // (a run that finished: the failures in a row start over)
	const d = r.done;
	if (!st.name && d.gpu && d.gpu.name) log(`GPU: ${d.gpu.name}, ${(d.ticksPerSec / 1e6).toFixed(1)} M ticks/s`);
	let got = { added: 0, byFam: {} };
	try { got = readEdges(edgesFile, ref); } catch (e) { log(`GPU: ${e.message}`); }
	// per-family numbers of the done event
	const fams = d.families || {};
	let kernel = 0;
	for (const f of Object.keys(fams)) {
		const x = state.fam[f];
		if (!x) continue;
		x.ticks += fams[f].ticks || 0; x.seconds += fams[f].seconds || 0; x.hits += fams[f].hits || 0; x.edges += got.byFam[f] || 0;
		kernel += fams[f].seconds || 0;
	}
	const sec = d.seconds || (Date.now() - t0) / 1000;
	if (kernel > 0) state.rate.overhead = 0.7 * (state.rate.overhead || 1) + 0.3 * Math.max(0, Math.min(10, sec - kernel));
	// cursors: advance only over what is surely done (eegpu reports the next start tick of the running family)
	const finished = sec < secArg - 0.05;   // a systematic pass that ends early covered its whole window
	let reach = from;
	if (random) {
		const p = r.at[slot];
		reach = p && p.wrapped ? n : p ? p.max : from;
		setCursor(slot, reach);
	} else {
		const m1 = fams.m1 ? fams.m1.seconds || 0 : 0, dl = fams.del ? fams.del.seconds || 0 : 0;
		let full = 0;   // kernel seconds the whole window takes (for the speed)
		if (finished) { reach = to; full = kernel; } else if (slot === 'm2') {
			const p = r.at.m2;
			reach = p ? (p.wrapped ? to : p.max) : from;
			if (reach > from) full = kernel * (to - from) / (reach - from);
		} else if (r.at.del) {
			// m1 covered its whole window before del started; del reached `max`
			const p = r.at.del;
			reach = p.wrapped ? to : p.max;
			full = m1 + (reach > from ? dl * (to - from) / (reach - from) : 8 * dl);
		} else {
			reach = from;
			const p = r.at.m1;
			if (p && p.max > from) full = 1.15 * m1 * (to - from) / (p.max - from);   // (del: ~15% of m1's work)
		}
		if (reach > from) state.left[slot] = Math.max(0, state.left[slot] - (reach - from));
		if (full > 0) state.rate[slot] = (to - from) / Math.max(full, 0.05);
		else if (!finished) state.rate[slot] = (state.rate[slot] || 1000) * 0.5;
		setCursor(slot, reach);
	}
	status({ state: 'running', name: d.gpu ? d.gpu.name : st.name, edges: libSize, found: st.found + got.added, ticksPerSec: Math.round(d.ticksPerSec || 0), families: famStatus(),
		lastRound: { ticks: d.ticks, seconds: d.seconds, edges: d.edges, bestSaving: d.bestSaving } });
	saveLibrary(false);
	saveState();
	const text = `${slot === 'sys' ? 'm1+del' : slot} ${from}-${reach}${random ? '' : finished ? '' : ` (of ${to})`} ${sec.toFixed(1)} s ${G9(d.ticks || 0)} ticks ` +
		`${got.added} new${got.added ? ` (${Object.entries(got.byFam).map(([f, x]) => `${f} ${x}`).join(', ')})` : ''}`;
	return { ok: true, seconds: sec, added: got.added, text };
}

// ---------------------------------------------------------------- one "every move" round (windows along the run)
/** one window: every move from tick T; its shortcuts go into the library. Resolves {added, done, err}. */
function runWindow(T) {
	return new Promise((resolve) => {
		const a = ['explore', blobFile, path.join(GDIR, 'ref.eetas'), `--from=${T}`, '--rejoin=1', `--nocoins=${nc ? 1 : 0}`, `--depth=${EVERY_DEPTH}`, `--seconds=${EVERY_S}`,
			'--qy=0', '--qvy=0', '--discrete=1', '--cap=1000000', `--launch-ms=${launchMs}`, ...EEGPU_OPTS(), ...G.cacheArgs()];
		const [cmd, argv] = toolCommand(tool, a);
		clearStop();
		child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });   // (EEGPU_OPTS)
		let buf = '', done = null, err = '', added = 0, last = 0, launchError = false;
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
				if (ev.ev === 'ready') loaded(ev);
				else if (ev.ev === 'rejoin') {
					if (ev.from >= 0 && ev.from <= ref.n && ev.j > ev.from && ev.j <= ref.n && ev.saving > 0) {
						const seq = Uint8Array.from(String(ev.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
						if (addEdge(ref.H[ev.from], ref.H[ev.j], seq, 'every')) added++;
					}
				} else if (ev.ev === 'layer') {
					last = ev.ticks;
					status({ state: 'running', ticks: base + ev.ticks, ticksPerSec: Math.round(ev.ticksPerSec), family: `every move from tick ${T}` });
				} else if (ev.ev === 'done') done = ev;
				else if (ev.error) { err = ev.error; if (ev.launchError) launchError = true; }
			}
		});
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => {
			child = null;
			if (done) st.ticks = base + (done.ticks || last);
			resolve({ code, done, err: err.trim(), added, launchError: isLaunchFailure(code, launchError, done) });
		});
	});
}
/** windows from the cursor on for about ROUND_S seconds */
async function runEvery() {
	const t0 = Date.now();
	let added = 0, windows = 0, from = (state.every | 0) % Math.max(1, ref.n), gpu = null, ticks = 0;
	while ((Date.now() - t0) / 1000 < ROUND_S) {
		const T = (state.every | 0) % Math.max(1, ref.n);
		state.every = T + EVERY_STEP;
		const r = await runWindow(T);
		if (!r.done) return { err: r.err || `the GPU tool exited with code ${r.code}`, launchError: r.launchError, added, windows };
		launchFails = 0;
		windows++; added += r.added; gpu = r.done.gpu; ticks += r.done.ticks || 0;
		if (state.every >= ref.n) { state.every = 0; log(`GPU: every move covered the whole run (windows of ${EVERY_DEPTH} ticks every ${EVERY_STEP})`); break; }
	}
	saveState();
	return { added, windows, from, to: state.every, gpu, ticks, seconds: (Date.now() - t0) / 1000 };
}

// ---------------------------------------------------------------- the round loop
async function failed(err, launchError) {
	if (launchError) {
		// a kernel launch failed (the driver's watchdog, or a GPU error): the GPU may have been reset. Back off: a pause,
		// shorter launches; after repeated failures no more GPU work this session
		launchFails++; launchFailsAll++;
		if (launchFails >= FAILS_IN_A_ROW || launchFailsAll >= FAILS_IN_ALL) {
			const why = `${launchFails >= FAILS_IN_A_ROW ? `${launchFails} GPU kernel launches failed in a row` : `${launchFailsAll} GPU kernel launches failed`} (last: ${err})`;
			log(`GPU: stopping the GPU searcher for this session: ${why}. The CPU stages go on; start the job again to retry the GPU.`);
			status({ state: 'error', why: `stopped: ${why}`, ticksPerSec: 0 });
			quit(5);
		}
		const wait = 60 * 2 ** (launchFails - 1);
		launchMs = Math.max(5, launchMs / 2);
		status({ state: 'waiting', why: err, ticksPerSec: 0 });
		log(`GPU: a GPU kernel launch failed (${err}); waiting ${wait} s, then launches of ${launchMs} ms (failure ${launchFails} in a row; the searcher stops after ${FAILS_IN_A_ROW})`);
		if (args.once) quit(4);
		await new Promise((res) => setTimeout(res, wait * 1000));
		return;
	}
	status({ state: 'error', why: err, ticksPerSec: 0 });
	log(`GPU: round failed: ${err}`);
	if (args.once) quit(4);
	await new Promise((res) => setTimeout(res, 15000));
}
async function main() {
	if (!args.job || !fs.existsSync(DIR)) { console.log('usage: node src/gpusearch.js --job=<job dir>'); process.exit(2); }
	tool = args.tool ? path.resolve(args.tool) : G.nativeTool();
	if (!tool) { status({ state: 'unavailable', why: 'the native engine is not built (node tools/build-native.js)' }); log('GPU: native engine missing'); process.exit(3); }
	level = J.loadJobLevel(ID);
	const why = G.unsupported(level);
	if (why) { status({ state: 'unavailable', why }); log(`GPU: not used for this level: ${why}`); process.exit(3); }
	blobFile = path.join(GDIR, 'level.bin');
	const blob = G.levelBlob(level);
	fs.writeFileSync(blobFile, blob);
	edgesFile = path.join(GDIR, 'edges.bin');
	// coin-blind search when the grind decided coins are optional (status.json coinsOptional)
	let ncs = null;
	for (let i = 0; i < 30 && ncs === null; i++) {
		const s = C.readJSON(path.join(DIR, 'status.json'), {});
		if (typeof s.coinsOptional === 'boolean') ncs = s.coinsOptional;
		else await new Promise((r) => setTimeout(r, 1000));
	}
	nc = !!ncs;
	RANDOM = C.isRandom(level);
	TC = S.traceCache(level, nc, RANDOM);
	fingerprint = libraryFingerprint(blob, nc);
	const loaded = loadLibrary();
	log(`GPU search started (${nc ? 'coin-blind' : 'coin-aware'}), rounds of ${ROUND_S} s` + (loaded ? `, ${loaded} shortcuts from the saved library` : ''));
	while (!(await refresh())) await new Promise((r) => setTimeout(r, 5000));
	await offer('saved library and known runs');
	let round = 0;
	for (;;) {
		round++;
		// every other round: every move along the run (not the first: the systematic families go first)
		if ((EVERY_ON && round % 2 === 0) || args.everyOnly) {
			const e = await runEvery();
			if (e.err) { await failed(e.err, e.launchError); continue; }
			status({ state: 'running', round, edges: libSize, found: st.found + e.added, ticksPerSec: e.seconds ? Math.round(e.ticks / e.seconds) : 0,
				lastRound: { kind: 'every move', windows: e.windows, from: e.from, to: e.to, ticks: e.ticks, seconds: e.seconds } });
			if (e.added) { log(`GPU: every move, ticks ${e.from}-${e.to}: ${e.added} new shortcut${e.added > 1 ? 's' : ''}`); saveLibrary(false); await offer(`every move ${e.from}-${e.to}`); }
			if (args.once) break;
			continue;
		}
		// the round's slots: m1 + del until a full pass over the current best is done, m2 (a slice, its own cursor),
		// then one random family (in turn) for the rest
		const t0 = Date.now();
		const texts = [];
		let error = null, errorLaunch = false, added = 0;
		const slice = async (slot, share) => {
			const until = Date.now() + share * ROUND_S * 1000;
			while (!error && state.left[slot] > 0) {
				const left = (until - Date.now()) / 1000;
				if (left < MIN_SLICE) break;
				await refresh();
				const r = await invoke(slot, left);
				if (!r.ok) { error = r.err; errorLaunch = !!r.launchError; break; }
				texts.push(r.text); added += r.added;
				if (r.added) await offer(`round ${round}`);
			}
		};
		await slice('sys', SYS_SHARE);
		if (!error) await slice('m2', M2_SHARE);
		if (!error) {
			const fam = RANDOM_FAMS[(state.rot | 0) % RANDOM_FAMS.length];
			state.rot = (state.rot | 0) + 1;
			const left = Math.max(MIN_SLICE, (1 - SYS_SHARE - M2_SHARE) * ROUND_S, ROUND_S - (Date.now() - t0) / 1000);
			await refresh();
			const r = await invoke(fam, left);
			if (!r.ok) { error = r.err; errorLaunch = !!r.launchError; }
			else { texts.push(r.text); added += r.added; if (r.added) await offer(`round ${round}`); }
		}
		if (error) { await failed(error, errorLaunch); continue; }
		status({ state: 'running', round, edges: libSize, families: famStatus() });
		// (every round that found something, and every 10th: the rest is in gpu_status.json `families`)
		if (added || round % 10 === 1) log(`GPU: round ${round} (${((Date.now() - t0) / 1000).toFixed(0)} s, library ${libSize}): ${texts.join('; ')}`);
		saveLibrary(true);
		if (args.once) break;
	}
	quit(0);
}

main().catch((e) => { log(`GPU: error: ${e && e.stack || e}`); status({ state: 'error', why: String(e && e.message || e) }); process.exit(1); });
