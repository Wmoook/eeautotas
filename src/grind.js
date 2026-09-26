'use strict';
// Keeps optimizing one job's TAS by cycling the search tools on the current best run, forever or until a deadline:
//   mutate.js (input mutations), explore.js (route explorer with exact rejoins, every coin-to-coin segment in
//   windows), shortcuts.js (dense local exact shortcuts), phase.js (time-door / coin-door shortcuts, on levels where
//   exact rejoins cannot see them), optimize.js (beam with verified leads, every other round),
// and splice.js (joins every result into the best run at equal states). Every accepted run is verified by a clean
// replay (common.judge): it must finish the level, faster, with no more deaths than the starting run and no lower
// random-portal chance.
//
// A round takes about --roundMin minutes (10): mutate, the exact endgame solver (endgame.js, when the ending changed),
// deep exploring windows (the run's loops first, then from where the last one stopped; every other one skip hunting),
// the skip search (skips.js, once per best: pass-bys and loops, entrances, every move from them), mutate, a slice of
// the dense shortcuts pass (from its cursor), the time-door pass (levels with time doors, or coin doors when the coins
// count), mutate, a beam every other round, a splice of all results. Where it is (round, stage, the deep and shortcuts
// cursors as ticks + state hashes, the seed counter, the best the skip search last covered) is saved in status.json
// `cursor` after every stage, so a restart continues there instead of repeating round 1.
// Without the GPU, mutate only searches the start ticks whose next ~800 ticks changed since its last full pass
// (grind_mutref.eetas); mutate is deterministic, so the rest would find the same shortcuts again.
// Nothing found is lost: a finishing run that is not accepted (a stage output that went stale while the best moved
// on, a run from the inbox) is logged and spliced with the best at once (splice.js, well under a second); stage
// outputs are also kept for the round's splice while they still have states the best lacks.
//
// Everything lives in the job directory (src/jobs/<id>/): best.eetas, best_<ticks>.eetas, grind.log, status.json
// (read by the web app and tas.js). The job inbox (inbox/*.eetas, dropped by `tas.js try`, POST /api/jobs/:id/try
// and `tas.js focus`) is checked every few seconds, also while a stage runs; finishing runs from outside that are
// not accepted are kept in pieces/ (the GPU searcher's in pieces/gpu/, with their own cap) and spliced in at the end
// of every round (a partial improvement still helps).
//
// usage: node src/grind.js --job=src/jobs/<id> [--level=<level id>] [--until=HH:MM | --forever=1] [--workers=N]
//        [--nocoins=auto|0|1] [--rot=N] [--skip=A,deep,beam] [--gpu=1] [--roundMin=10] [--deepS=<s>] [--anchored=1] [--tails=1]
//        [--hunt=1] [--endgame=1] [--skips=1]
//        (--rot: rounds done, for a status.json without a cursor; --skip: stages skipped in this session's first
//        round; --anchored=0 / --tails=0: without mutate's --anchor --dprune --fixpoint and explore's --tails)
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./common.js');
const S = require('./splice.js');
const LP = require('./loops.js');
const E = C.E;

const a = { until: '', forever: '', level: '', workers: os.cpus().length, job: '', nocoins: 'auto', gpu: '0', roundMin: '10', anchored: '1', tails: '1' };
for (const s of process.argv.slice(2)) {
	const m = s.match(/^--([^=]+)=(.*)$/);
	if (m) a[m[1]] = m[2];
}
if (!a.job) { console.log('usage: node src/grind.js --job=src/jobs/<id> [--level=<id>] [--until=HH:MM | --forever=1] [--workers=N]'); process.exit(2); }
let deadline;
if (a.forever === '1' || !a.until) deadline = new Date(8.6e15);   // "forever": stop with Ctrl+C / the app's Stop button
else {
	const [hh, mm] = a.until.split(':').map(Number);
	deadline = new Date(); deadline.setHours(hh, mm, 0, 0);
	if (deadline.getTime() <= Date.now()) deadline.setDate(deadline.getDate() + 1);   // --until=05:56 in the evening = tomorrow
}
const FOREVER = deadline.getTime() > 4e15;
const OUT = path.resolve(a.job);
const BEST = path.join(OUT, 'best.eetas');
const REF = path.join(OUT, 'grind_ref.eetas');   // the stage's private copy of best (best.eetas may change mid-stage)
const MUTREF = path.join(OUT, 'grind_mutref.eetas');   // the run the last complete mutate pass covered (CPU mode)
const INBOX = path.join(OUT, 'inbox');
const PIECES = path.join(OUT, 'pieces');
const GPU_PIECES = path.join(PIECES, 'gpu');   // the GPU searcher's runs that went stale: their own cap
const JOB_ID = path.basename(OUT);
const LEVEL_ID = a.level || C.jobLevelId(JOB_ID);
const LEVEL_JSON = C.levelData(LEVEL_ID);
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(PIECES, { recursive: true });
const level = E.loadLevel(LEVEL_JSON);
const W = +a.workers || os.cpus().length;
const ROUND_MS = Math.max(1, +a.roundMin || 10) * 60e3;
const DEEP_S = Math.max(0, +a.deepS || 0);   // --deepS: seconds per deep window (default: 150-210, rotating)
const MUT_HORIZON = 800;
// the search tools' newer options (they ignore options they do not know): mutate's re-anchored continuation,
// dominance pruning and in-process fixpoint, explore's replays of the reference's own inputs from near states
const MUT_EXTRA = a.anchored !== '0' ? ['--anchor=1', '--dprune=1', '--fixpoint=1'] : [];
const EXP_EXTRA = a.tails !== '0' ? ['--tails=1'] : [];
const fmt = C.fmt;

function evalRun(file) {
	try { return C.evaluate(level, C.readEetas(file), false); } catch (e) { return null; }
}
function coinTicks(ms) {
	const tr = C.replay(level, ms, { trace: true });
	const out = [0];
	for (const e of tr.events) if (e.kind === 'coin') out.push(e.t);
	out.push(tr.complete);
	return out;   // out[k] = tick of coin k (out[0] = 0), last = the finish
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ---------------------------------------------------------------- status (read by the web app and tas.js)
const statusPath = path.join(OUT, 'status.json');
let status = C.readJSON(statusPath, {});
if (!Array.isArray(status.history)) status.history = [];
function saveStatus(extra) {
	Object.assign(status, extra || {}, { updated: Date.now(), pid: process.pid });
	try { C.writeAtomic(statusPath, JSON.stringify(status)); } catch (e) { /* ignore */ }
}
const log = (s) => {
	const line = `[grind ${new Date().toTimeString().slice(0, 8)}] ${s}`;
	console.log(line);
	try { fs.appendFileSync(path.join(OUT, 'grind.log'), line + '\n'); } catch (e) { /* ignore */ }
};

let best = evalRun(BEST);
if (!best) { log('best.eetas does not finish the level'); saveStatus({ state: 'error', error: 'best.eetas does not finish the level' }); process.exit(1); }
const baseDeaths = best.deaths;   // never accept a run with more deaths than we started with
if (status.startRunTicks === undefined) status.startRunTicks = best.runTicks;

const NC = a.nocoins === 'auto' ? (C.coinsIrrelevant(LEVEL_JSON, best.ms, best) ? 1 : 0) : (+a.nocoins ? 1 : 0);
log(`start: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks}), ${best.deaths} deaths, coins ${NC ? 'optional (coin-blind search)' : 'needed (coin-aware search)'}, ` +
	`${W} workers, ${FOREVER ? 'runs until stopped' : 'deadline ' + deadline.toString().slice(0, 21)}`);
saveStatus({ state: 'running', error: null, level: LEVEL_ID, bestRunTicks: best.runTicks, coinsOptional: !!NC, workers: W, started: status.started || Date.now(),
	sessionStarted: Date.now(), stage: 'starting' });

function publish() {
	if (!best || !best.ms || best.ms.length === 0) return;
	const chk = path.join(OUT, 'publish_check.eetas');
	C.writeEetas(chk, best.ms);
	const v = evalRun(chk);
	if (!v || v.runTicks !== best.runTicks) { log(`publish: verification FAILED (${v ? v.runTicks : 'no finish'}), not published`); return; }
	C.writeEetas(path.join(OUT, `best_${best.runTicks}.eetas`), best.ms);
	C.writeEetas(BEST, best.ms);
	saveStatus({ bestRunTicks: best.runTicks });
}
publish();

// random portals (level.rngScript set): the chance that a run finishes over all portal outcomes must never drop
const RANDOM = C.isRandom(level);
const chanceOf = (r) => C.chanceOf(level, r.ms);
best.chance = chanceOf(best);
if (RANDOM) log(`random portals: this run finishes in ${(best.chance * 100).toFixed(1)}% of EEO plays; improvements must keep at least that`);
saveStatus({ chance: best.chance });

// ---------------------------------------------------------------- runs as state-hash traces (splice.js)
const TC = S.traceCache(level, NC, RANDOM);
let bestIdx = null;   // { key, tr, has: hashIndex of the best's states }
/** the best run's trace and state set (for splicing at once and for "still has states the best lacks") */
function bestTrace() {
	const key = sha1(C.eetasBytes(best.ms));
	if (!bestIdx || bestIdx.key !== key) {
		const tr = S.trace(level, best.ms, NC, RANDOM);
		const has = S.hashIndex(tr.n + 1);
		for (let t = 0; t <= tr.n; t++) has.id(tr.H[t]);
		bestIdx = { key, tr, has };
	}
	return bestIdx;
}

/** Offers a finished run file to the best (THE rule: common.judge). Returns { accepted, r, verdict }.
 *  A finishing run that is not accepted is logged and spliced with the best at once (opts.noSplice: it is a splice). */
function consider(file, what, opts) {
	// best.eetas may have been improved from outside (tas.js try while this grind was not running yet)
	const disk = evalRun(BEST);
	if (disk && disk.runTicks < best.runTicks) {
		log(`(best.eetas was improved outside: ${fmt(best.runTicks)} -> ${fmt(disk.runTicks)})`);
		disk.chance = chanceOf(disk); best = disk;
		const onDisk = C.readJSON(statusPath, {});
		if (Array.isArray(onDisk.history) && onDisk.history.length > status.history.length) status.history = onDisk.history;
	}
	const r = evalRun(file);
	if (!r) return { accepted: false, r: null, verdict: { accept: false, reason: 'does not finish the level' } };
	// (a slower run is rejected without its odds: chance null = not computed, not "never finishes")
	r.chance = r.runTicks <= best.runTicks ? chanceOf(r) : null;
	const v = C.judge(r, best, baseDeaths);
	if (!v.accept) {
		const splice = !(opts && opts.noSplice);
		log(`${what}: ${fmt(r.runTicks)} not accepted (${v.reason})${splice ? '; splicing it with the best' : ''}`);
		if (splice) spliceNow(r, what);
		return { accepted: false, r, verdict: v };
	}
	log(`${what}: ${fmt(best.runTicks)} -> ${fmt(r.runTicks)} (-${best.runTicks - r.runTicks})` + (RANDOM ? `, chance ${(r.chance * 100).toFixed(1)}%` : ''));
	status.history.push({ t: Date.now(), runTicks: r.runTicks, saved: best.runTicks - r.runTicks, what, chance: r.chance });
	best = r;
	saveStatus({ chance: r.chance });
	publish();
	return { accepted: true, r, verdict: v };
}
/**
 * A finishing run that was not accepted: the fastest combination of it and the best at equal states (it may still
 * hold a faster stretch: a stage output that went stale while the best moved on keeps ~90% of its find). The result
 * is judged like any run; with random portals a second try keeps the draws of the best.
 */
function spliceNow(r, what) {
	try {
		const rt = S.trace(level, r.ms, NC, RANDOM);
		if (rt.n >= 0) spliceWithBest([rt], what, `${what} + best`);
	} catch (e) { log(`${what}: splice failed: ${e && e.message || e}`); }
}
/** The fastest run over the best and `runs` (traces) at equal states, judged; with random portals a second try keeps
 *  the draws of the best. Returns true when it was accepted. */
function spliceWithBest(runs, what, name) {
	const t0 = Date.now();
	const b = bestTrace();
	const g = S.unionGraph([b.tr, ...runs]);
	for (const avoidRng of RANDOM ? [false, true] : [false]) {
		const u = g.path({ avoidRng });
		if (!u || u.run >= best.runTicks) { if (!avoidRng) log(`${what}: spliced with the best, nothing faster (${Date.now() - t0} ms)`); return false; }
		const out = path.join(OUT, 'grind_now.eetas');
		C.writeEetas(out, u.ms);
		const res = consider(out, `${name} (splice, ${u.switches} switch${u.switches === 1 ? '' : 'es'})`, { noSplice: true });
		if (res.accepted) return true;
		if (!RANDOM || avoidRng || !res.r || res.r.runTicks >= best.runTicks) return false;
	}
	return false;
}

// ---------------------------------------------------------------- the job inbox
let inboxBusy = false;
function checkInbox() {
	if (inboxBusy) return;
	inboxBusy = true;
	try {
		let files = [];
		try { files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.eetas')).sort(); } catch (e) { /* none */ }
		let kept = false;
		for (const f of files) {
			const fp = path.join(INBOX, f);
			const meta = C.readJSON(fp + '.json', {});
			const source = meta.source || 'inbox';
			const res = consider(fp, `inbox (${source})`);
			if (!res.r) log(`inbox (${source}): not accepted (${res.verdict.reason})`);
			const rec = { file: f, source, t: Date.now(), accepted: res.accepted, runTicks: res.r ? res.r.runTicks : null, time: res.r ? fmt(res.r.runTicks) : null,
				chance: res.r ? res.r.chance : null, best: best.runTicks, bestTime: fmt(best.runTicks), reason: res.accepted ? '' : res.verdict.reason };
			try { fs.appendFileSync(path.join(INBOX, 'results.jsonl'), JSON.stringify(rec) + '\n'); } catch (e) { /* ignore */ }
			// an accepted run is best_<ticks>.eetas now; one that finishes but was not accepted is kept for the round's
			// splice (the GPU searcher's own runs, which it combines itself, in pieces/gpu/: they never crowd out the others)
			try {
				if (res.r && !res.accepted) {
					const dir = /^gpu\b/i.test(source) ? GPU_PIECES : PIECES;
					fs.mkdirSync(dir, { recursive: true });
					fs.renameSync(fp, path.join(dir, f));
					kept = true;
				} else fs.unlinkSync(fp);
			} catch (e) { try { fs.unlinkSync(fp); } catch (e2) { /* gone */ } }
			try { fs.unlinkSync(fp + '.json'); } catch (e) { /* none */ }
		}
		if (kept) { prunePieces(PIECES, 30); prunePieces(GPU_PIECES, 10); }
	} finally { inboxBusy = false; }
}
function prunePieces(dir, keep) {
	let fl = [];
	try { fl = fs.readdirSync(dir).filter((f) => f.endsWith('.eetas')).sort(); } catch (e) { return; }
	for (const f of fl.slice(0, Math.max(0, fl.length - keep))) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* gone */ } }
}

// ---------------------------------------------------------------- live speed (live.json: the web app's and `tas.js status`'s "Speed now")
// The search tools print `[ticks] <total>` every second (the ticks they simulated so far, common.tickMeter). The grind
// sums them over this session (finished stages + the running stage's latest count) and writes live.json every second:
// the speed over the last ~3 s (0 between stages). A GPU search's gpu_status.json is copied in while it is fresh.
const LIVE = path.join(OUT, 'live.json');
const GPU_STATUS = path.join(OUT, 'gpu_status.json');   // {t, name, ticks, ticksPerSec, state, edges}, written by the GPU side
const CPU_MODEL = ((os.cpus()[0] && os.cpus()[0].model) || '').trim();
let ticksDone = 0, ticksStage = 0, inStage = false;
let tickSamples = [];   // [time, session total] per `[ticks]` line of the running stage
function stageTicks(n) {
	ticksStage = n;
	const now = Date.now();
	tickSamples.push([now, ticksDone + n]);
	while (tickSamples.length > 2 && now - tickSamples[1][0] >= 3000) tickSamples.shift();   // keep ~3 s (+ one older sample)
}
function stageEdge(start) {
	ticksDone += ticksStage; ticksStage = 0; tickSamples = []; inStage = start;
}
function ticksPerSec() {
	if (!inStage || tickSamples.length < 2) return 0;
	const [t0, n0] = tickSamples[0], [t1, n1] = tickSamples[tickSamples.length - 1];
	if (Date.now() - t1 > 5000 || t1 <= t0) return 0;   // the tool stopped reporting
	return Math.round((n1 - n0) * 1000 / (t1 - t0));
}
function writeLive() {
	const now = Date.now();
	const g = C.readJSON(GPU_STATUS, null);
	const gpu = g && typeof g === 'object' && now - (+g.t || 0) < 5000 ? g : null;
	try { C.writeAtomic(LIVE, JSON.stringify({ t: now, cpu: { ticks: ticksDone + ticksStage, ticksPerSec: ticksPerSec(), threads: W, model: CPU_MODEL }, gpu })); } catch (e) { /* ignore */ }
}
const liveTimer = setInterval(writeLive, 1000);
liveTimer.unref();   // (never keeps the grind alive)
writeLive();
/** A stage's stdout: `[ticks] N` lines update the live speed and are left out of the stage log; the rest is kept. */
function tickLines() {
	let carry = '';
	const take = (s) => s.replace(/^\[ticks\] (\d+)\r?\n/gm, (m, n) => { stageTicks(+n); return ''; });
	return {
		data(s) { s = carry + s; const cut = s.lastIndexOf('\n') + 1; carry = s.slice(cut); return take(s.slice(0, cut)); },
		end() { const s = take(carry + '\n'); carry = ''; return s === '\n' ? '' : s.slice(0, -1); },
	};
}

// ---------------------------------------------------------------- stages (child processes, awaited)
/** Runs a tool; while it runs the inbox is checked every 3 s and the status heartbeat written every 30 s.
 *  Resolves { code, out (the stage's log text), killed (stopped by maxMs) }. */
function runTool(script, args, maxMs, logFile) {
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
			env: C.heapEnv(12000) });
		const chunks = [];
		let size = 0, killed = false;
		const keep = (d) => { if (size < (64 << 20)) { chunks.push(d); size += d.length; } };
		const out = tickLines();
		stageEdge(true);
		ch.stdout.setEncoding('utf8');
		ch.stdout.on('data', (s) => { const k = out.data(s); if (k) keep(Buffer.from(k)); });
		ch.stderr.on('data', keep);
		const inbox = setInterval(checkInbox, 3000);
		const beat = setInterval(() => saveCursor(), 30000);
		const kill = setTimeout(() => { killed = true; try { ch.kill(); } catch (e) { /* gone */ } }, maxMs);
		ch.on('close', (code) => {
			clearInterval(inbox); clearInterval(beat); clearTimeout(kill);
			const rest = out.end();
			if (rest) keep(Buffer.from(rest));
			stageEdge(false);
			const text = Buffer.concat(chunks);
			if (logFile) { try { fs.writeFileSync(logFile, text); } catch (e) { /* ignore */ } }
			resolve({ code, out: text.toString('utf8'), killed });
		});
		ch.on('error', () => { clearInterval(inbox); clearInterval(beat); clearTimeout(kill); stageEdge(false); resolve({ code: -1, out: '', killed }); });
	});
}

// stage outputs, spliced at the end of every round while they still have states the best lacks
let results = [];
try {
	// (outputs of an earlier session: a stale find is still a find)
	results = fs.readdirSync(OUT).filter((f) => /^grind_(deep|sc|mut|beam)_.*\.eetas$/.test(f)).map((f) => path.join(OUT, f))
		.sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs);
} catch (e) { /* none */ }
function addResult(file) {
	results = results.filter((f) => f !== file);
	results.push(file);
}
/** Keeps the results that still have a state the best lacks (the others are part of it now), the newest 80 at most. */
function pruneResults() {
	const b = bestTrace();
	const keep = [];
	for (const f of results) {
		const tr = TC.get(f);
		if (!tr || tr.n < 0) continue;
		let novel = false;
		for (let t = 0; t <= tr.n && !novel; t++) if (b.has.get(tr.H[t]) < 0) novel = true;
		if (novel) keep.push(f);
	}
	results = keep.slice(-80);
	const live = new Set(results.map((f) => path.resolve(f)));
	TC.prune((k) => live.has(k.split('|')[0]));
}
/** At the start: the outputs an earlier session left (a stage stopped mid-way leaves the best find it wrote so far)
 *  and pieces/ (runs handed to the stopped job), spliced with the best in-process. */
function recoverOutputs() {
	pruneResults();
	const files = results.concat(pieceFiles());
	const runs = files.map((f) => TC.get(f)).filter((tr) => tr && tr.n >= 0);
	if (!runs.length) return;
	const what = `${runs.length} earlier run${runs.length > 1 ? 's' : ''} (stage outputs, pieces/)`;
	spliceWithBest(runs, what, `${what} + best`);
}
function pieceFiles() {
	let out = [];
	for (const d of [PIECES, GPU_PIECES]) {
		try { out = out.concat(fs.readdirSync(d).filter((f) => f.endsWith('.eetas')).map((f) => path.join(d, f))); } catch (e) { /* none */ }
	}
	return out;
}
async function spliceAll() {
	pruneResults();
	const ex = results.concat(pieceFiles()).filter((f) => fs.existsSync(f));
	if (ex.length === 0) return;
	const out = path.join(OUT, 'grind_splice.eetas');
	try { fs.unlinkSync(out); } catch (e) { /* none */ }
	C.writeEetas(REF, best.ms);
	saveStatus({ stage: 'splice' });
	await runTool('splice.js', [out, REF, ...ex, `--level=${LEVEL_ID}`, ...(NC ? ['--nocoins'] : [])], 3600e3, path.join(OUT, 'grind_splice.log'));
	// (the best itself when nothing is faster: not worth a "not accepted" line every round)
	let same = false;
	try { same = sha1(fs.readFileSync(out)) === sha1(C.eetasBytes(best.ms)); } catch (e) { /* no output */ }
	if (same) log('splice: nothing faster than the best');
	else if (fs.existsSync(out)) consider(out, 'splice', { noSplice: true });
}
const skip1 = new Set(String(a.skip || '').split(',').filter(Boolean));   // --skip=A,deep,beam: skipped in this session's first round
let curRound = 0, firstRound = 0;
/** Runs one stage on a copy of the best; its output (if any) is offered. Resolves the runTool result, or null (skipped).
 *  note: shown in the log line (e.g. the window's ticks). */
async function stage(name, script, args, outFile, maxMs, note) {
	const tag = name.startsWith('shortcuts') ? 'A' : name.startsWith('deep') ? 'deep' : name.startsWith('beam') ? 'beam' : '';
	if (curRound === firstRound && tag && skip1.has(tag)) { log(`${name}: skipped (--skip)`); return null; }
	const left = deadline - Date.now();
	if (left < 60000) return null;
	checkInbox();
	try { fs.unlinkSync(outFile); } catch (e) { /* none */ }
	C.writeEetas(REF, best.ms);   // the stage searches from this exact copy of the current best
	log(`${name}${note ? ` (${note})` : ''}...`);
	saveStatus({ stage: name, round: curRound });
	const res = await runTool(script, args, Math.min(maxMs, left + 240e3), path.join(OUT, `grind_${name.replace(/[^\w.-]/g, '_')}.log`));   // grace: stages with --deadline wrap up themselves
	if (fs.existsSync(outFile)) consider(outFile, name);
	return res;
}
const dl = () => (FOREVER ? [] : [`--deadline=${deadline.getTime() - 90e3}`]);
const TAS = `--tas=${REF}`;
const LVL = `--level=${LEVEL_ID}`;

// ---------------------------------------------------------------- where the grind is (status.json `cursor`)
// {round, stage, used (ms of the round before a restart), deep / sc: {t, h} (the next start tick and its state hash,
// found again by hash when the best changes), scRate (shortcuts start ticks per second), seed (explore's seeds)}
const cur = Object.assign({ round: 0, stage: '', used: 0, deep: null, sc: null, scRate: 0, seed: 0 }, status.cursor || {});
function saveCursor(extra) {
	if (roundT0) cur.used = roundUsed();
	Object.assign(cur, extra || {});
	saveStatus({ cursor: cur });
}
/** a cursor's tick on the current best: the tick with its state hash (the nearest to its old tick), else its old tick */
function cursorTick(c) {
	if (!c) return 0;
	const b = bestTrace();
	const old = Math.max(0, Math.min(b.tr.n, c.t | 0));
	let at = -1;
	if (c.h !== undefined) for (let t = 0; t <= b.tr.n; t++) if (b.tr.H[t] === c.h && (at < 0 || Math.abs(t - old) < Math.abs(at - old))) at = t;
	return at >= 0 ? at : old;
}
const cursorAt = (t) => { const b = bestTrace(); const tt = Math.max(0, Math.min(b.tr.n, t | 0)); return { t: tt, h: b.tr.H[tt] }; };

// cheap input-mutation passes (seconds each), repeated while they keep finding time
/** The GPU searcher is running and healthy (its status is fresh): it covers mutate's input changes many times over. */
function gpuBusy() {
	if (!gpuChild) return false;
	const g = C.readJSON(path.join(OUT, 'gpu_status.json'), null);
	return !!(g && g.state === 'running' && Date.now() - g.t < 60000);
}
/**
 * Start ticks of the best whose mutations can differ from the last complete pass (grind_mutref.eetas): a tick is
 * unchanged when the state there and the next MUT_HORIZON + 8 inputs are the same in both runs (or the same up to
 * both finishes). Returns [[from, to], ...] (gaps under 1000 ticks merged) or null (no earlier pass: everything).
 */
function dirtyRanges() {
	let old;
	try { old = C.readEetas(MUTREF); } catch (e) { return null; }
	const A = TC.of('mutref:' + sha1(C.eetasBytes(old)), old), B = bestTrace().tr;
	if (A.n < 0) return null;
	const at = new Map();
	for (let t = 0; t <= A.n; t++) at.set(A.H[t], t);
	const need = MUT_HORIZON + 8, END = 1e9;
	const same = new Float64Array(B.n + 1);   // ticks from t on that replay the old run exactly (END: up to both finishes)
	same[B.n] = at.get(B.H[B.n]) === A.n ? END : 0;
	for (let t = B.n - 1; t >= 0; t--) {
		const o = at.get(B.H[t]);
		same[t] = o !== undefined && o < A.n && A.masks[o] === B.masks[t] ? 1 + same[t + 1] : 0;
	}
	const out = [];
	for (let t = 0; t < B.n; t++) {
		if (same[t] >= need) continue;
		if (out.length && t - out[out.length - 1][1] < 1000) out[out.length - 1][1] = t + 1;
		else out.push([t, t + 1]);
	}
	return out;
}
async function mutateLoop(tag) {
	if (gpuBusy()) { log(`mutate_${tag}: skipped (the GPU searches these input changes)`); return; }
	for (let k = 1; k <= 8; k++) {
		if (k > 1 && gpuBusy()) { log(`mutate_${tag}: the GPU searcher is up, leaving the rest to it`); break; }
		const before = best.runTicks;
		// without the GPU: only the start ticks that changed since the last complete pass
		const ms0 = best.ms, n0 = bestTrace().tr.n;
		let ranges = gpuChild ? null : dirtyRanges();
		if (ranges && ranges.length === 0) { log(`mutate_${tag}: nothing changed since the last pass`); break; }
		if (ranges && ranges.length > 4) ranges = [[ranges[0][0], ranges[ranges.length - 1][1]]];
		if (ranges) {
			const dirty = ranges.reduce((s, r) => s + r[1] - r[0], 0);
			if (dirty < n0) log(`mutate_${tag}_${k}: ${dirty} of ${n0} start ticks changed since the last pass (${ranges.map((r) => `${r[0]}-${r[1]}`).join(', ')})`);
		}
		// the ranges as state hashes: an earlier range's improvement shifts the later ones
		const marks = (ranges || [[0, n0]]).map(([f, t]) => [cursorAt(f), cursorAt(t)]);
		let complete = true;
		for (let i = 0; i < marks.length; i++) {
			const mo = path.join(OUT, `grind_mut_${tag}_${k}${marks.length > 1 ? String.fromCharCode(97 + i) : ''}.eetas`);
			const f = cursorTick(marks[i][0]), t = Math.max(f + 1, cursorTick(marks[i][1]));
			const whole = f === 0 && t >= bestTrace().tr.n;
			const res = await stage(`mutate_${tag}_${k}${marks.length > 1 ? String.fromCharCode(97 + i) : ''}`, 'mutate.js', [TAS, `--out=${mo}`, `--horizon=${MUT_HORIZON}`,
				`--workers=${W}`, LVL, `--nocoins=${NC}`, ...(whole ? [] : [`--from=${f}`, `--to=${t}`]), ...MUT_EXTRA, ...dl()], mo, 1800e3);
			// (with --until, mutate stops at its --deadline without saying so)
			if (!res || res.killed || res.code !== 0 || /worker error/.test(res.out) || (!FOREVER && Date.now() > deadline - 100e3)) complete = false;
			if (res) addResult(mo);
		}
		if (complete && !gpuChild) C.writeEetas(MUTREF, ms0);   // every start tick of ms0 is searched now
		if (best.runTicks >= before) break;
	}
}

// ---------------------------------------------------------------- the GPU searcher (--gpu=1): src/gpusearch.js
// It runs next to the CPU stages for the whole session and hands its runs in through the inbox (checked every 3 s by
// the stages, see runTool). It exits by itself when this process is gone; killTree stops it with the grind.
let gpuChild = null;
function startGpu() {
	const fd = fs.openSync(path.join(OUT, 'gpu.log'), 'a');
	gpuChild = spawn(process.execPath, [path.join(__dirname, 'gpusearch.js'), `--job=${OUT}`, `--parent=${process.pid}`, ...(a.siblings !== undefined ? [`--siblings=${a.siblings}`] : [])],
		{ stdio: ['ignore', fd, fd], windowsHide: true });
	fs.closeSync(fd);
	saveStatus({ gpuPid: gpuChild.pid });   // (jobs.js stopJob stops it first, alone: its eegpu is never killed mid-kernel)
	gpuChild.on('exit', (code) => { if (code && code !== 3) log(`GPU searcher stopped (exit ${code}); see gpu.log`); gpuChild = null; });
}
process.on('exit', () => { if (gpuChild) { try { gpuChild.kill(); } catch (e) { /* gone */ } } });

// ---------------------------------------------------------------- one round (about ROUND_MS), resumable stage by stage
const STAGES = ['mutA', 'endgame', 'deep', 'skips', 'mutB', 'sc', 'phase', 'mutC', 'beam', 'splice'];
let roundT0 = 0;
const roundUsed = () => Date.now() - roundT0;
/** the deep exploring windows of the whole run: every coin-to-coin segment (a level without coins is one), in tick order */
function deepWindows(wsz) {
	const c = coinTicks(best.ms);
	const wins = [];
	for (let k = 1; k < c.length; k++) {
		if (!(c[k - 1] >= 0 && c[k] > c[k - 1])) continue;
		const lo = Math.max(0, c[k - 1] - 20), hi = c[k] + 80;
		const seg = [];
		if (hi - lo <= wsz + 150) seg.push([lo, hi]);
		else for (let w0 = lo; w0 < hi - 100; w0 += wsz - 100) seg.push([w0, Math.min(hi, w0 + wsz)]);   // smaller windows = more focused exploring
		seg.forEach(([w0, w1], i) => wins.push({ w0, w1, seg: k, i, of: seg.length }));
	}
	return wins;
}
/**
 * Loop windows first (up to 5 per round, 60% of it): stretches where the run comes back to where it was with nothing collected or toggled in between
 * (loops.js), the longest first, each (as the state hashes at its ends) once. The explorer on exactly that window finds
 * a way around the loop directly; tiled windows contain a long loop only in some placements. Not on time-door levels
 * (an exact rejoin there needs a saving that is a multiple of 1000 ticks). Returns the number of windows run.
 */
async function loopWindows(round) {
	if (level.hasTimeDoors) return 0;
	const tried = new Set(cur.loops || []);
	let ran = 0;
	while (ran < 5 && roundUsed() < 0.6 * ROUND_MS && Date.now() < deadline - 120000) {
		let loops;
		const H = bestTrace().tr.H, n = bestTrace().tr.n;
		// the loops that come back within 48 px, then (all tried) the wider ones within 96 px, then 160 px
		let l = null;
		for (const radius of [48, 96, 160]) {
			try { loops = LP.revisits(level, best.ms, { coins: !NC, max: 2000, radius, keep: 60 }); } catch (e) { log(`loops: ${e && e.message || e}`); return ran; }
			l = loops.find((x) => !tried.has(`${H[x.a]}:${H[x.b]}`));
			if (l) break;
		}
		if (!l) { if (!ran && loops.length) log(`deep: every loop of the run (${loops.length}) was explored already`); return ran; }
		tried.add(`${H[l.a]}:${H[l.b]}`);
		cur.loops = [...tried].slice(-400);
		const w0 = Math.max(0, l.a - 40), w1 = Math.min(n, l.b + 40), before = best.runTicks;
		const lp = path.join(OUT, `grind_deep_${round}_loop${ran}.eetas`);
		const res = await stage(`deep${round}_loop${ran + 1}`, 'explore.js', [TAS, `--out=${lp}`, `--from=${w0}`, `--join=${w0}`, `--until=${w1}`,
			`--seconds=${DEEP_S || 120}`, `--workers=${W}`, '--exact=1', '--roll=100', `--seed=${300 + (cur.seed = (cur.seed | 0) + 1)}`, `--nocoins=${NC}`,
			'--maxEntries=1500000', ...EXP_EXTRA, LVL], lp, 600e3, `the run comes back to (${l.x}, ${l.y}) ${l.len} ticks later: ticks ${l.a}-${l.b}`);
		if (!res) return ran;
		addResult(lp);
		log(`deep${round}_loop${ran + 1}: ${best.runTicks < before ? `a way around the loop, -${before - best.runTicks}` : 'no way around the loop found'}`);
		saveCursor();
		ran++;
	}
	return ran;
}
/** 1) deep exact-rejoin exploring: the loop windows, then window after window from the deep cursor, for up to ~55% of
 *  the round (one at least) */
async function deepStage(round, R) {
	const WSZ = R([600, 400, 500, 350]);
	await loopWindows(round);
	let done = 0;
	while ((done === 0 || roundUsed() < 0.55 * ROUND_MS) && Date.now() < deadline - 120000) {
		const wins = deepWindows(WSZ);
		if (!wins.length) return;
		const from = cursorTick(cur.deep);
		// the first window that reaches past the cursor by more than the usual overlap (the window size rotates with the
		// round: "the first window starting at the cursor" would skip up to a whole window's step at a round change)
		let wi = wins.findIndex((w) => w.w1 > from + 100);
		if (wi < 0) { wi = 0; log(`deep: every window of the run explored (${wins.length} windows); starting over at the first`); }
		const w = wins[wi];
		// where to continue: the next window's start, as a state (found again when the stage improves the best)
		const next = wi + 1 < wins.length ? cursorAt(wins[wi + 1].w0) : null;
		const seed = 300 + (cur.seed = (cur.seed | 0) + 1);
		const dp = path.join(OUT, `grind_deep_${round}_${w.seg - 1}_${w.i}.eetas`);
		const name = `deep${round}_seg${w.seg}${w.of > 1 ? '.' + (w.i + 1) : ''}`;
		// every other window: guided skip hunting (explore --hunt: states ahead of the reference by a time-to-go field,
		// then its own inputs from there; FV 5760-5830: -15 where the plain explorer finds 0), else tails
		const hunt = a.hunt !== '0' && seed % 2 === 0;
		const res = await stage(name, 'explore.js', [TAS, `--out=${dp}`, `--from=${w.w0}`, `--join=${w.w0}`,
			`--until=${w.w1}`, `--seconds=${DEEP_S || R([150, 180, 150, 210])}`, `--workers=${W}`, '--exact=1', '--roll=100',
			`--seed=${seed}`, `--cell=${R([8, 6, 12, 8])}`, `--vcell=${R([2, 1.5, 3, 1])}`, `--ahead=${R([0.5, 0.6, 0.4, 0.7])}`,
			`--nocoins=${NC}`, '--maxEntries=1500000', ...(hunt ? ['--hunt=1'] : EXP_EXTRA), LVL], dp, 900e3,
			`window ${wi + 1}/${wins.length}, ticks ${w.w0}-${w.w1}${hunt ? ', skip hunting' : ''}`);
		if (!res) return;
		addResult(dp);
		if (!next && wins.length > 1) log(`deep: the last of the run's ${wins.length} windows is done; the next one starts over at the first`);
		saveCursor({ deep: next || cursorAt(0) });
		done++;
	}
}
/**
 * The exact endgame solver (endgame.js): every input sequence over the run's last K ticks (K = 8, 16, 24, ... with a
 * sound lower bound), from the best and the job's other runs; finds knife-edge finishes the rejoin tools cannot see
 * (213: 2.36 -> 2.35 from OC's run in about 5 s). Once per ending: again only when the best's last 64 ticks changed.
 */
async function endgameStage(round) {
	if (a.endgame === '0') return;
	const b = bestTrace();
	const key = `${b.tr.H[Math.max(0, b.tr.n - 64)]}:${b.tr.n - Math.max(0, b.tr.n - 64)}`;
	if (cur.endgame === key) return;
	const eo = path.join(OUT, `grind_endgame_${round}.eetas`);
	const res = await stage(`endgame${round}`, 'endgame.js', [TAS, LVL, `--out=${eo}`, '--seconds=90', ...dl()], eo, 300e3, 'the last ticks, every input');
	if (res && !res.killed) saveCursor({ endgame: key });
}
/**
 * Skip search (skips.js): where the run passes near a spot it lands on (or a wall it hits) much later, or comes back to
 * where it was, every move from the run's state there finds the states that touch that spot early (entrances), and
 * every move from the corners of those (the far end of a ledge, the fastest speed either way) finds the way on to an
 * exact rejoin. Forgotten Veil's 88-tick "mini 10" skip from best_11257: -83 by itself after 48 s on 4 threads, -94
 * after the next mutate. Once per best (again when the best changed, at most every third round), a quarter of a round
 * (90-300 s); not on time-door levels (their exact rejoins need savings that are multiples of 1000 ticks); --skips=0
 * off.
 */
async function skipsStage(round) {
	if (a.skips === '0' || level.hasTimeDoors) return;
	const key = bestTrace().key;
	// once per best, and at most every third round (a job whose best changes every round keeps most of its time for the
	// other stages)
	if (cur.skips === key || (cur.skipsRound && round - cur.skipsRound < 3 && round > cur.skipsRound)) return;
	const so = path.join(OUT, `grind_skips_${round}.eetas`);
	const secs = Math.max(90, Math.min(300, Math.round(0.25 * ROUND_MS / 1000)));   // (its own share of a round)
	// targets: the job's earlier bests (the newest 4): a skip's way on after the contact may be theirs, not the best's
	let targets = [];
	try {
		targets = fs.readdirSync(OUT).filter((f) => /^best_\d+\.eetas$/.test(f) && f !== `best_${best.runTicks}.eetas`)
			.map((f) => ({ f: path.join(OUT, f), m: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((x, y) => y.m - x.m).slice(0, 4).map((x) => x.f);
	} catch (e) { /* none */ }
	const res = await stage(`skips${round}`, 'skips.js', [TAS, LVL, `--out=${so}`, `--workers=${W}`, `--nocoins=${NC}`, `--seconds=${secs}`,
		...(targets.length ? [`--targets=${targets.join(',')}`] : [])], so,
		(secs + 180) * 1000, 'where the run passes a spot it reaches much later: entrances, and every move from them');
	if (!res) return;
	addResult(so);
	if (!res.killed) saveCursor({ skips: key, skipsRound: round });
}
/** 2) a slice of the dense local-shortcut pass (alternating settings): from its cursor, sized to the round's time */
async function shortcutsStage(round, R) {
	const budget = Math.max(90e3, 0.8 * ROUND_MS - roundUsed());
	const n = bestTrace().tr.n;
	const from = cursorTick(cur.sc);
	const rate = cur.scRate > 0 ? cur.scRate : W * 5;   // start ticks per second (every 10th tick is a start: ~2 s each)
	const to = Math.min(n, from + Math.max(200, Math.floor(rate * budget / 1000 * 0.7)));
	// where to continue, as states (found again when the stage improves the best): the window's end, or about 70% of
	// it when the deadline cuts the pass (the workers take their starts in tick order)
	const markEnd = to >= n ? cursorAt(0) : cursorAt(to), markCut = cursorAt(from + Math.floor(0.7 * (to - from)));
	const sc = path.join(OUT, `grind_sc_${round}.eetas`);
	const t0 = Date.now();
	const res = await stage(`shortcuts${round}`, 'shortcuts.js', [TAS, `--out=${sc}`, '--step=10', `--from=${from + R([5, 2, 7, 4])}`, `--to=${to}`,
		`--depth=${R([180, 150, 200, 160])}`, `--cap=${R([2000, 3000, 1800, 2500])}`, `--dist=${R([24, 16, 32, 40])}`, `--bcap=${R([8, 12, 16, 6])}`,
		`--workers=${W}`, LVL, `--nocoins=${NC}`, `--deadline=${Math.min(deadline.getTime() - 90e3, Date.now() + budget + 60e3)}`], sc, budget + 600e3,
		`ticks ${from}-${to} of ${n}`);
	if (!res) return;
	addResult(sc);
	const sec = (Date.now() - t0) / 1000;
	const cut = res.killed || /\[sc\] deadline/.test(res.out);
	if (sec > 5) cur.scRate = Math.max(1, (cut ? 0.5 : 1) * (to - from) / sec);
	if (!cut && to >= n) log('shortcuts: the whole run is searched; the next slice starts over at tick 0');
	saveCursor({ sc: cut ? markCut : markEnd });
}

/**
 * time-door shortcuts (phase.js): on a level with time doors every state holds the doors' phase, so an exact rejoin
 * needs a saving that is a multiple of 1000 ticks and the other tools find nothing there; the same for the coins
 * collected after the last coin door when the coins count. phase.js proposes by clock-blind hashes and replays every
 * proposal (the clock re-synced in the idle start when needed). A whole pass over the run, the tick grid rotating.
 */
const PHASE = !!level.hasTimeDoors || (!NC && [43, 165, 213, 214].some((id) => level.fg.includes(id)));
async function phaseStage(round, R) {
	if (!PHASE) return;
	const po = path.join(OUT, `grind_phase_${round}.eetas`);
	await stage(`phase${round}`, 'phase.js', [TAS, `--out=${po}`, LVL, `--nocoins=${NC}`, `--step=${R([2, 1, 3, 2])}`, `--from=${R([0, 0, 1, 1])}`, `--workers=${W}`,
		`--horizon=${R([300, 400, 250, 500])}`, `--drift=${R([96, 128, 64, 160])}`, `--seconds=${R([120, 180, 120, 120])}`, `--random=${R([60, 90, 60, 120])}`, `--seed=${round}`], po, 900e3,
		level.hasTimeDoors ? 'time doors' : 'coin doors');
}

async function main() {
	if (a.gpu === '1') { log('GPU on: the GPU searcher runs next to the CPU stages'); startGpu(); }
	checkInbox();
	try { recoverOutputs(); } catch (e) { log(`earlier stage outputs: ${e && e.message || e}`); }
	// the round to continue: the one in progress when the grind stopped, else the next
	const rounds = +status.rounds || (+a.rot || 0);
	let round = cur.stage && cur.round > rounds ? cur.round : rounds + 1;
	firstRound = round;
	for (; Date.now() < deadline - 120000; round++) {
		curRound = round;
		const R = (arr) => arr[(round - 1) % arr.length];   // the settings rotate with the round (it continues after a restart)
		const resume = cur.round === round && STAGES.includes(cur.stage) ? cur.stage : '';
		roundT0 = Date.now() - (resume ? Math.min(+cur.used || 0, ROUND_MS) : 0);
		if (resume && resume !== 'mutA') log(`round ${round}: continuing at ${resume} (${Math.round(roundUsed() / 60e3)} of ${ROUND_MS / 60e3} min used)`);
		const resumedAt = resume ? STAGES.indexOf(resume) : -1;
		for (let si = resume ? resumedAt : 0; si < STAGES.length && Date.now() < deadline - 120000; si++) {
			const sname = STAGES[si];
			saveCursor({ round, stage: sname, used: roundUsed() });
			if (sname === 'mutA') await mutateLoop(`${round}a`);
			else if (sname === 'endgame') await endgameStage(round);
			else if (sname === 'deep') await deepStage(round, R);
			else if (sname === 'skips') await skipsStage(round);
			else if (sname === 'mutB') await mutateLoop(`${round}b`);
			else if (sname === 'sc') await shortcutsStage(round, R);
			else if (sname === 'phase') await phaseStage(round, R);
			else if (sname === 'mutC') await mutateLoop(`${round}c`);
			else if (sname === 'beam') {
				// 3) beam with verified leads, every other round when there is time left, every 4th round anyway (it has
				// no window: it runs to the finish, so one that a restart stopped is not started over: restarts more often
				// than a beam lasts would repeat it forever)
				if (si === resumedAt) log(`beam${round}: stopped by the restart; not repeated`);
				else if (round % 4 === 0 || (round % 2 === 0 && roundUsed() < 0.9 * ROUND_MS)) {
					const bm = path.join(OUT, `grind_beam_${round}.eetas`);
					const res = await stage(`beam${round}`, 'optimize.js', [TAS, `--out=${bm}`, `--width=${R([4000, 6000, 3000, 8000])}`, `--dist=${R([24, 16, 32, 24])}`,
						'--passes=1', `--workers=${W}`, LVL], bm, Math.max(ROUND_MS - roundUsed(), 5 * 60e3) + 5 * 60e3);
					if (res && res.killed) log(`beam${round}: out of time (${Math.round(roundUsed() / 60e3)} min into the round)`);
					if (res) addResult(bm);
				}
			} else if (sname === 'splice') await spliceAll();
			saveCursor({ used: roundUsed() });
		}
		if (Date.now() >= deadline - 120000) break;
		log(`round ${round} done (${Math.round(roundUsed() / 60e3)} min): best ${fmt(best.runTicks)}`);
		cur.stage = ''; cur.used = 0;
		saveStatus({ rounds: round, cursor: cur });
	}
	log(`finished: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks})`);
	saveStatus({ state: 'finished', stage: 'finished' });
}
main().catch((e) => { log(`error: ${e && e.stack || e}`); saveStatus({ state: 'error', error: String(e && e.message || e) }); process.exit(1); });
