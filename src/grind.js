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
// the sweep (explore --hunt windows over the whole run, several at once, src/sweep.js; windows that came back empty
// rest), deep exploring windows (the run's loops first, then from where the last one stopped; every other one skip hunting),
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
//        [--hunt=1] [--endgame=1] [--skips=1] [--sweep=1] [--sweepLoops=lane|first] [--coinfree=1] [--coinprop=1]
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
const SW = require('./sweep.js');
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
const W_ALL = +a.workers || os.cpus().length;
// the corridor beam's own CPU share (--flybeamShare=K or EEAT_FLYBEAM_SHARE=K threads; flybeamLane): K threads run
// flybeam.js next to the stages for the whole session, the stages get the rest (W); by default 1 thread from 3 workers
// on (the A/B of 2026-09-28, 3 workers a level: Infinity Pain 39,110 vs main's 39,352, ice 4,579 vs 4,622, Octorage and
// Forgotten Veil no loss); 0: no lane (then --flybeam=1 / EEAT_FLYBEAM=1 is the slice-per-round stage instead)
const FLY_K = (() => {
	const set = a.flybeamShare !== undefined ? a.flybeamShare : process.env.EEAT_FLYBEAM_SHARE;
	const k = set !== undefined && set !== '' ? Math.floor(+set) || 0 : (W_ALL >= 3 ? 1 : 0);
	return k > 0 && W_ALL >= 2 ? Math.min(k, W_ALL - 1) : 0;
})();
const W = W_ALL - FLY_K;
// the corridor beam's per-axis joins (flybeam.js --axisTails; --flybeamAxis=0: off): Infinity Pain's shaft start 33000 -41
// where the beam without them joined nothing
const FLY_AXIS = a.flybeamAxis !== undefined ? Math.max(0, Math.floor(+a.flybeamAxis) || 0) : 8;
// its finer start grids (flybeam.js --refine; --flybeamRefine=0: the grid alone): Infinity Pain's shaft joins depend on the
// start tick (33250 -142, 33200 0 on the 39,410 run)
const FLY_REFINE = a.flybeamRefine !== undefined ? Math.max(0, Math.min(2, Math.floor(+a.flybeamRefine) || 0)) : 2;
// Find a route next to this job (the AutoTASer, src/autotas.js, until its handoff): while <job>/cpu_share is fresh (touched
// every few seconds) a stage starts with the thread count in it instead of W
const CPU_SHARE = path.join(OUT, 'cpu_share');
function stageWorkers() {
	try {
		if (Date.now() - fs.statSync(CPU_SHARE).mtimeMs > 15000) return W;
		const n = Math.floor(+fs.readFileSync(CPU_SHARE, 'utf8'));
		return n >= 1 ? Math.min(W, n) : W;
	} catch (e) { return W; }
}
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

// Coins. NC = 1: the best needs no coin door or gate (coin-blind search everywhere); decided again at every round's start
// (redecideCoins: a route through a coin door no longer keeps the whole session coin-exact once the best leaves it).
// NC = 0: exact states, except past the best's coin-free tick (COINFREE; common.coinFreeTick: its box touches no coin door or
// gate any more, nothing reads the coins from there on): windows that start there search coin-blind (ncAt), and the
// splices join coin-blind past each run's own coin-free tick (splice.js trace 'free'): a line that takes or skips a
// coin after the last coin door rejoins; the sweep's windows before it search coin-blind too, but their rejoins are only
// proposals, each replayed in full by phase.js --edges (COINPROP; the clock-blind edges' way on time-door levels).
// --coinfree=0: off (exact up to the finish, as before); --coinprop=0: the windows before it exact.
let NC = a.nocoins === 'auto' ? (C.coinsIrrelevant(LEVEL_JSON, best.ms, best) ? 1 : 0) : (+a.nocoins ? 1 : 0);
const COINFREE = a.coinfree !== '0' && C.coinFreeOk(level);
const COINPROP = a.coinprop !== '0';
/** the traces' coin mode (splice.js trace): blind, or exact with coin-blind twins past each run's coin-free tick */
const tmode = () => (NC ? true : COINFREE ? 'free' : false);
log(`start: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks}), ${best.deaths} deaths, coins ${NC ? 'optional (coin-blind search)' : `needed (coin-aware search${COINFREE ? '; coin-blind past the last coin door' : ''})`}, ` +
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
let TC = S.traceCache(level, tmode(), RANDOM);
let bestIdx = null;   // { key, tr, has: hashIndex of the best's states }
/** the best run's trace and state set (for splicing at once and for "still has states the best lacks") */
function bestTrace() {
	const key = sha1(C.eetasBytes(best.ms));
	if (!bestIdx || bestIdx.key !== key) {
		const tr = S.trace(level, best.ms, tmode(), RANDOM);
		const has = S.hashIndex(tr.n + 1);
		for (let t = 0; t <= tr.n; t++) has.id(tr.H[t]);
		bestIdx = { key, tr, has };
	}
	return bestIdx;
}
/** --nocoins for a window of the current best that starts at tick w0: 1 when coins are optional, or when w0 is at or
 *  past the best's coin-free tick (every rejoin target j > w0 is then followed by no coin door or gate); else 0 */
function ncAt(w0) {
	if (NC) return 1;
	return COINFREE && w0 >= bestTrace().tr.cf ? 1 : 0;
}
const CB = ', coin-blind: past the last coin door';   // (the log's note on such a window)
/** At a round's start: are the coins optional for the best now (common.coinsIrrelevant)? A change switches the coin
 *  mode of the searches and the traces (and of the GPU searcher: status.json coinsOptional) */
function redecideCoins() {
	if (a.nocoins !== 'auto') return;
	const nc = C.coinsIrrelevant(LEVEL_JSON, best.ms, best) ? 1 : 0;
	if (nc === NC) return;
	NC = nc;
	TC = S.traceCache(level, tmode(), RANDOM);
	bestIdx = null;
	saveStatus({ coinsOptional: !!NC });
	log(NC ? 'coins optional now: the best needs no coin door or gate any more (coin-blind search)'
		: 'coins needed now: the best goes through a coin door or gate (coin-aware search)');
}

/** Offers a finished run file to the best (THE rule: common.judge). Returns { accepted, r, verdict, spliced }.
 *  A finishing run that is not accepted is logged and spliced with the best at once (opts.noSplice: it is a splice);
 *  spliced = that splice was accepted. */
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
		const spliced = splice ? spliceNow(r, what) : false;
		return { accepted: false, r, verdict: v, spliced };
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
 * is judged like any run; with random portals a second try keeps the draws of the best. Returns true when accepted.
 */
function spliceNow(r, what) {
	try {
		const rt = S.trace(level, r.ms, tmode(), RANDOM);
		if (rt.n >= 0) return spliceWithBest([rt], what, `${what} + best`);
	} catch (e) { log(`${what}: splice failed: ${e && e.message || e}`); }
	return false;
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
// (the sweep runs several tools at once: each running tool's latest count, summed)
let ticksDone = 0, ticksStage = 0, laneSeq = 0;
const laneTicks = new Map();
let tickSamples = [];   // [time, session total] per `[ticks]` line of the running stage(s)
function stageTicks(lane, n) {
	laneTicks.set(lane, n);
	ticksStage = 0;
	for (const v of laneTicks.values()) ticksStage += v;
	const now = Date.now();
	tickSamples.push([now, ticksDone + ticksStage]);
	while (tickSamples.length > 2 && now - tickSamples[1][0] >= 3000) tickSamples.shift();   // keep ~3 s (+ one older sample)
}
function stageStart() {
	const lane = ++laneSeq;
	if (!laneTicks.size) tickSamples = [];
	laneTicks.set(lane, 0);
	return lane;
}
function stageEnd(lane) {
	ticksDone += laneTicks.get(lane) || 0;
	laneTicks.delete(lane);
	ticksStage = 0;
	for (const v of laneTicks.values()) ticksStage += v;
	if (!laneTicks.size) tickSamples = [];
}
function ticksPerSec() {
	if (!laneTicks.size || tickSamples.length < 2) return 0;
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
function tickLines(lane) {
	let carry = '';
	const take = (s) => s.replace(/^\[ticks\] (\d+)\r?\n/gm, (m, n) => { stageTicks(lane, +n); return ''; });
	return {
		data(s) { s = carry + s; const cut = s.lastIndexOf('\n') + 1; carry = s.slice(cut); return take(s.slice(0, cut)); },
		end() { const s = take(carry + '\n'); carry = ''; return s === '\n' ? '' : s.slice(0, -1); },
	};
}

// ---------------------------------------------------------------- stages (child processes, awaited)
/** Runs a tool; while it runs the inbox is checked every 3 s and the status heartbeat written every 30 s.
 *  Resolves { code, out (the stage's log text), killed (stopped by maxMs, or grown), grown (started on Find a route's
 *  CPU share, stopped when that share ended: the stage again with every thread, see stage()) }. */
function runTool(script, args, maxMs, logFile) {
	const sw = stageWorkers();
	const cut = sw < W && args.includes(`--workers=${W}`);
	if (cut) args = args.map((x) => (x === `--workers=${W}` ? `--workers=${sw}` : x));
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
			env: C.heapEnv(12000) });
		const chunks = [];
		let size = 0, killed = false, ended = false, grown = false;
		const keep = (d) => { if (size < (64 << 20)) { chunks.push(d); size += d.length; } };
		const lane = stageStart();
		const out = tickLines(lane);
		ch.stdout.setEncoding('utf8');
		ch.stdout.on('data', (s) => { const k = out.data(s); if (k) keep(Buffer.from(k)); });
		ch.stderr.on('data', keep);
		// (a stage started on Find a route's share (the AutoTASer, cpu_share) is stopped once the share has ended: at its
		// handoff the AutoTASer frees W threads, and a 1-thread mutate pass of the ice level had run on alone 6+ minutes)
		const inbox = setInterval(() => {
			checkInbox();
			if (cut && !killed && stageWorkers() >= Math.min(W, 2 * sw)) { grown = killed = true; try { ch.kill(); } catch (e) { /* gone */ } }
		}, 3000);
		const beat = setInterval(() => saveCursor(), 30000);
		const kill = setTimeout(() => { killed = true; try { ch.kill(); } catch (e) { /* gone */ } }, maxMs);
		const end = () => { if (ended) return false; ended = true; clearInterval(inbox); clearInterval(beat); clearTimeout(kill); return true; };
		ch.on('close', (code) => {
			if (!end()) return;
			const rest = out.end();
			if (rest) keep(Buffer.from(rest));
			stageEnd(lane);
			const text = Buffer.concat(chunks);
			if (logFile) { try { fs.writeFileSync(logFile, text); } catch (e) { /* ignore */ } }
			resolve({ code, out: text.toString('utf8'), killed, grown });
		});
		ch.on('error', () => { if (!end()) return; stageEnd(lane); resolve({ code: -1, out: '', killed, grown }); });
	});
}

// stage outputs, spliced at the end of every round while they still have states the best lacks
let results = [];
try {
	// (outputs of an earlier session: a stale find is still a find)
	results = fs.readdirSync(OUT).filter((f) => /^grind_(deep|sc|mut|beam|skipf|flyb)_.*\.eetas$/.test(f)).map((f) => path.join(OUT, f))
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
	await runTool('splice.js', [out, REF, ...ex, `--level=${LEVEL_ID}`, ...(NC ? ['--nocoins'] : COINFREE ? ['--coinfree'] : [])], 3600e3, path.join(OUT, 'grind_splice.log'));
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
	const logFile = path.join(OUT, `grind_${name.replace(/[^\w.-]/g, '_')}.log`);
	let res = await runTool(script, args, Math.min(maxMs, left + 240e3), logFile);   // grace: stages with --deadline wrap up themselves
	if (res.grown) {
		// (Find a route's CPU share ended mid-stage: what it found so far, then the stage again on every thread)
		if (fs.existsSync(outFile)) consider(outFile, name);
		log(`${name}: Find a route's CPU share ended: again with ${stageWorkers()} threads`);
		try { fs.unlinkSync(outFile); } catch (e) { /* none */ }
		C.writeEetas(REF, best.ms);
		res = await runTool(script, args, Math.min(maxMs, deadline - Date.now() + 240e3), logFile);
	}
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
		// a range over the best's coin-free tick in two: coin-blind from there on (ncAt)
		const cf = !NC && COINFREE ? bestTrace().tr.cf : Infinity;
		const spans = [];
		for (const [f, t] of ranges || [[0, n0]]) { if (cf > f && cf < t) spans.push([f, cf], [cf, t]); else spans.push([f, t]); }
		// the ranges as state hashes: an earlier range's improvement shifts the later ones
		const marks = spans.map(([f, t]) => [cursorAt(f), cursorAt(t)]);
		let complete = true;
		for (let i = 0; i < marks.length; i++) {
			const mo = path.join(OUT, `grind_mut_${tag}_${k}${marks.length > 1 ? String.fromCharCode(97 + i) : ''}.eetas`);
			const f = cursorTick(marks[i][0]), t = Math.max(f + 1, cursorTick(marks[i][1]));
			const whole = f === 0 && t >= bestTrace().tr.n;
			const res = await stage(`mutate_${tag}_${k}${marks.length > 1 ? String.fromCharCode(97 + i) : ''}`, 'mutate.js', [TAS, `--out=${mo}`, `--horizon=${MUT_HORIZON}`,
				`--workers=${W}`, LVL, `--nocoins=${ncAt(f)}`, ...(whole ? [] : [`--from=${f}`, `--to=${t}`]), ...MUT_EXTRA, ...dl()], mo, 1800e3,
				!NC && ncAt(f) ? `ticks ${f}-${t}${CB}` : '');
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
	gpuChild = spawn(process.execPath, [path.join(__dirname, 'gpusearch.js'), `--job=${OUT}`, `--parent=${process.pid}`, ...(a.siblings !== undefined ? [`--siblings=${a.siblings}`] : []), ...(a.every !== undefined ? [`--every=${a.every}`] : [])],
		{ stdio: ['ignore', fd, fd], windowsHide: true });
	fs.closeSync(fd);
	saveStatus({ gpuPid: gpuChild.pid });   // (jobs.js stopJob stops it first, alone: its eegpu is never killed mid-kernel)
	gpuChild.on('exit', (code) => { if (code && code !== 3) log(`GPU searcher stopped (exit ${code}); see gpu.log`); gpuChild = null; });
}
process.on('exit', () => { if (gpuChild) { try { gpuChild.kill(); } catch (e) { /* gone */ } } });

// ---------------------------------------------------------------- one round (about ROUND_MS), resumable stage by stage
// (on time-door / coin-door levels the phase pass comes right after the first mutate, and again after the endgame when
// the best changed meanwhile (a newer route from Find a route, say): its idle start and re-synced clocks found timedoor's
// -252 (half the run) on a run spliced from Find a route's newer routes, after 7 minutes behind the endgame, deep
// windows and shortcuts)
const STAGES_ALL = ['mutA', 'skipfA', 'endgame', 'deep', 'skips', 'skipf', 'flyb', 'mutB', 'sc', 'phase', 'mutC', 'beam', 'splice'];
const STAGES_PHASE = ['mutA', 'skipfA', 'phase', 'endgame', 'phaseB', 'deep', 'skips', 'skipf', 'flyb', 'mutB', 'sc', 'mutC', 'beam', 'splice'];
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
// ---------------------------------------------------------------- the window memory (src/sweep.js): windows that proved empty rest
// Every explored window (the sweep's, the loop windows, the segment windows) leaves a record in grind_windows.json: the
// run's sampled state hashes in it, its empty searches in a row, the round until which it rests. The same span and route
// searched SW.FAILS_N (2) times without a find rests 2, 4, 8, ... rounds; a change of the run inside it opens it at once.
const MEMO_FILE = path.join(OUT, 'grind_windows.json');
const memo = new SW.Memo((C.readJSON(MEMO_FILE, {}) || {}).records);
const saveMemo = () => { try { C.writeAtomic(MEMO_FILE, JSON.stringify({ records: memo.records })); } catch (e) { /* next time */ } };
/** the window [w0, w1] of the current best as the memory sees it: {sig, inner, st: {run, why, rec}} */
function memoWin(w0, w1, round) {
	const H = bestTrace().tr.H;
	const sig = SW.sigOf(H, w0, w1), inner = SW.innerOf(H, w0, w1);
	return { sig, inner, st: memo.state(sig, inner, round) };
}
/** a window search that counts for the memory: it found time, or it ran to its end (a crash, a kill at the deadline or a
 *  stop is no evidence that the window is empty) */
const searched = (res, saved) => saved > 0 || !!(res && res.code === 0 && !res.killed);
/** the ticks a stage's own output saves against the run it started from (0: none / no output) */
function ownSaving(outFile, refTicks) {
	if (!fs.existsSync(outFile)) return 0;
	const r = evalRun(outFile);
	return r && r.runTicks < refTicks ? refTicks - r.runTicks : 0;
}

// ---------------------------------------------------------------- the sweep: hunt windows over the whole run, several at once
// explore --hunt windows of SWEEP_LEN ticks every SWEEP_STEP ticks over the WHOLE run, run side by side in lanes of the CPU
// threads (up to 4 lanes of at least 2 threads), each window from the best as it is when the window starts. The first sweep
// of a session covers every window (whole-run coverage in the first minutes); later ones get ~40% of a round and take the
// windows that found time last first, then new / changed ones, then the rest in run order from where the last sweep
// stopped; resting windows (the memory) are left out. On the ice level one such window over the top right took 4899 ->
// 4792 and 4904 -> 4760 (180 s, 6 threads), where the grind's one-window-per-round cursor needed 2 h to get there.
// A stale find (its run saved time against the run the window started from, but neither it nor its splice reached the
// best: the GPU searcher had moved the best on meanwhile, so the best no longer holds the find's states) sends its window
// back into the lanes at once, on the current best (once per sweep): the first sweep starts while the GPU still cuts
// whole seconds, and on the A100 12 and 10 of such finds (524 and 546 ticks) never reached the best. On time-door levels
// (an exact rejoin there needs a saving that is a multiple of 1000 ticks) the windows rejoin by the clock-blind hash
// (explore --clockblind=1) and phase.js replays their edges plain or with the clock re-synced in the idle start
// (phase.js --edges). --sweep=0 off.
const SWEEP_LEN = 800, SWEEP_STEP = 600, SWEEP_LOOPS = 2;
/** a find's own states (those of the run file `out` its start run lacks: refTr its trace, refMs its inputs) that the best
 *  holds, a share. On time-door levels by the clock-blind hash (no door phase, no key timers): a find phase.js re-synced
 *  by idle ticks in the start shares no plain state hash with the best even once the best holds it (the time-door sweep's
 *  review: 9 of ~23 Stupid Fox windows "stale (0%)") */
function inBest(out, refTr, refMs) {
	if (level.hasTimeDoors) {
		let ms;
		try { ms = C.readEetas(out); } catch (e) { return 1; }
		const o = blindTrace(ms), r = blindTrace(refMs), b = new Set(blindTrace(best.ms));
		return o.length ? SW.keptShare(o, o.length - 1, r, r.length - 1, (h) => b.has(h)) : 1;
	}
	const tr = TC.get(out);
	if (!tr || tr.n < 0) return 1;
	const b = bestTrace();
	return SW.keptShare(tr.H, tr.n, refTr.H, refTr.n, (h) => b.has.get(h) >= 0);
}
/** the clock-blind state hashes of a run, tick 0 to its finish (none: it does not finish) */
function blindTrace(ms) {
	const sim = new E.EESim(level), inp = new E.EEInput();
	sim.reset();
	const H = [sim.stateHashClockBlind(NC === 1)], crown0 = sim.has_silver_crown;
	for (let t = 0; t < ms.length; t++) {
		E.applyMask(inp, ms[t]);
		sim.tick(inp);
		H.push(sim.stateHashClockBlind(NC === 1));
		if (!crown0 && sim.has_silver_crown) return H;
	}
	return [];
}
// --sweepLoops=lane (default): the 2 longest loops in the sweep's lanes; first: the 2 longest loop windows with all the threads
// before the sweep (an experiment: Forgotten Veil's loop at (326, 90) found -46 with 8 threads and 4 in a 2-thread lane)
const SWEEP_LOOP_MODE = a.sweepLoops || process.env.EEAT_SWEEP_LOOPS || 'lane';
/** the longest loop of the run (48 px, then 96, then 160) not tried yet (tried: the state hashes at its ends) and not
 *  resting in the window memory (those are added to tried); null when none: {l, m: memoWin of its window} */
function nextLoop(round, tried) {
	if (level.hasTimeDoors) return null;
	const H = bestTrace().tr.H, n = bestTrace().tr.n;
	for (const radius of [48, 96, 160]) {
		let loops;
		try { loops = LP.revisits(level, best.ms, { coins: !NC, max: 2000, radius, keep: 60 }); } catch (e) { log(`loops: ${e && e.message || e}`); return null; }
		for (const x of loops) {
			if (tried.has(`${H[x.a]}:${H[x.b]}`)) continue;
			const mw = memoWin(Math.max(0, x.a - 40), Math.min(n, x.b + 40), round);
			if (!mw.st.run) { tried.add(`${H[x.a]}:${H[x.b]}`); log(`deep: the loop at (${x.x}, ${x.y}), ticks ${x.a}-${x.b}: ${mw.st.why}`); continue; }
			return { l: x, m: mw };
		}
	}
	return null;
}
async function sweepStage(round) {
	if (a.sweep === '0') return;
	if (curRound === firstRound && skip1.has('deep')) return;
	const TD = !!level.hasTimeDoors;
	// lanes of >= 2 threads, up to 4; the share can grow during the sweep (the AutoTASer's Find a route hands the CPU over:
	// <job>/cpu_share), so the lanes the whole CPU allows are started and each one waits while the share has no room for it
	const lanesFor = (w) => Math.max(1, Math.min(4, Math.floor(w / 2)));
	const lanes = lanesFor(W);
	const room = () => { const w = stageWorkers(), n = lanesFor(w); return { n, per: Math.max(1, Math.floor(w / n)) }; };
	let over = false;   // (a lane found nothing left: the waiting lanes end too)
	const secs = DEEP_S || 120;
	const first = !cur.swept;
	const budget = first ? 1.5 * ROUND_MS : 0.4 * ROUND_MS;   // (the first: until every window is covered, at most 15 min)
	const t0 = Date.now();
	const done = [], inflight = new Set();   // sigs searched in this sweep / running now
	const skipped = new Map();
	// the frontier: the sweep walks the run's windows in run order from where the last sweep stopped (cur.swOrder), each
	// once; windows that found time in an earlier round go first. A window a find changed meanwhile waits for the next sweep.
	let order = cur.swOrder | 0, ran = 0, found = 0, idx = 0;
	const nWin = () => SW.windows(bestTrace().tr.n, SWEEP_LEN, SWEEP_STEP).length;
	if (order >= nWin()) order = 0;
	/** the next window on the current best, or null when there is none: windows that found time in an earlier round, then
	 *  the frontier; once it has passed the last window (the whole run covered: covered = true), the windows a find of this
	 *  sweep changed (the find's own window again: chained finds, while each keeps finding time) */
	let covered = false;
	const pick = () => {
		const n = bestTrace().tr.n;
		const ws = SW.windows(n, SWEEP_LEN, SWEEP_STEP);
		const same = (sig) => (s) => !!new SW.Memo([{ s, fails: 0 }]).match(sig);
		let front = null, chain = null;
		for (let i = 0; i < ws.length; i++) {
			const [w0, w1] = ws[i];
			const m = memoWin(w0, w1, round);
			if (done.some(same(m.sig)) || [...inflight].some(same(m.sig))) continue;
			const rec = m.st.rec;
			if (m.st.run && rec && rec.found > 0 && rec.last < round) return { w0, w1, i, sig: m.sig, why: `found ${rec.found} last time` };
			if (m.st.run && !chain && (rec && rec.found > 0 && rec.last === round || m.st.why === 'new' || m.st.why === 'changed')) {
				chain = { w0, w1, i, sig: m.sig, why: rec && rec.found > 0 ? `again after its find of ${rec.found}` : `${m.st.why} since this sweep searched it` };
			}
			if (i < order || front) continue;
			if (!m.st.run) { skipped.set(`${w0}`, m.st.why); continue; }
			front = { w0, w1, i, sig: m.sig, why: m.st.why };
		}
		if (front) { order = front.i + 1; return front; }
		covered = true;
		return chain;
	};
	// stale finds (above): their windows on the current best, before any other window; each window once per sweep
	const redo = [], redone = new Set();
	let stale = 0;
	const takeRedo = () => {
		while (redo.length) {
			const r = redo.shift();
			const b = bestTrace().tr;
			const [w0, w1] = SW.mapWindow(r.tr.H, r.tr.n, b.H, b.n, r.w0, r.w1);
			const m = memoWin(w0, w1, round);
			if ([...inflight].some((s) => !!new SW.Memo([{ s, fails: 0 }]).match(m.sig))) continue;
			return { w0, w1, i: -1, sig: m.sig, redo: true, why: `again on the current best: its find of ${r.saved} at ticks ${r.w0}-${r.w1} did not reach it` };
		}
		return null;
	};
	// the longest loops go into the lanes first (SWEEP_LOOPS per sweep, the loop windows' own explorer: Octorage's -356
	// route skip is its loop #1), the rest after the sweep in loopWindows
	const tried = new Set(cur.loops || []);
	let loopsRun = 0;
	const lane = async (k) => {
		while (Date.now() - t0 < budget && Date.now() < deadline - 120000) {
			const rm = room();
			if (k >= rm.n) { if (over) return; await new Promise((r) => setTimeout(r, 5000)); continue; }   // (no room for this lane yet)
			const per = rm.per;
			let win = null;
			if (loopsRun < SWEEP_LOOPS && SWEEP_LOOP_MODE === 'lane') {
				const nl = nextLoop(round, tried);
				if (nl) {
					loopsRun++;
					const n = bestTrace().tr.n, H = bestTrace().tr.H, l = nl.l;
					tried.add(`${H[l.a]}:${H[l.b]}`);
					cur.loops = [...tried].slice(-400);
					win = { w0: Math.max(0, l.a - 40), w1: Math.min(n, l.b + 40), sig: nl.m.sig, loop: l, why: `the run comes back to (${l.x}, ${l.y}) ${l.len} ticks later` };
				}
			}
			if (!win) win = takeRedo();
			if (!win) win = pick();
			if (!win) { over = true; return; }
			inflight.add(win.sig);
			const id = idx++;
			const ref = path.join(OUT, `grind_sweep_ref${k}.eetas`);
			const refMs = best.ms;
			C.writeEetas(ref, refMs);
			const refTicks = best.runTicks;
			const out = path.join(OUT, `grind_deep_${round}_sw${id}.eetas`);
			try { fs.unlinkSync(out); } catch (e) { /* none */ }
			try { fs.unlinkSync(`${out}.edges.json`); } catch (e) { /* none */ }
			const name = `sweep${round}_${id + 1}`;
			const seed = 300 + (cur.seed = (cur.seed | 0) + 1);
			// a window before the last coin door where coins count (NC 0): coin-blind rejoins as proposals, each replayed in
			// full by phase.js --edges (a coin door later that reads the other count fails the replay), as the clock-blind
			// ones on time-door levels; past it (ncAt) coin-blind rejoins are exact
			const cblind = ncAt(win.w0), propose = !cblind && COINPROP && HAS_COIN_DOORS;
			log(`${name} (${win.loop ? 'loop' : 'hunt'} window ticks ${win.w0}-${win.w1} of ${bestTrace().tr.n}, ${win.why}, lane ${k + 1}/${lanes}, ${per} threads` +
				`${!NC && cblind ? CB : propose ? ', coin-blind proposals, each replayed' : ''})...`);
			const mode = win.loop ? ['--roll=100', ...EXP_EXTRA] : a.hunt !== '0' ? ['--hunt=1'] : [...EXP_EXTRA];   // (a copy: mode.push below)
			// (time doors: rejoins by the clock-blind hash, as edges for phase.js; --hunt and --tails write them)
			if (TD) mode.push('--clockblind=1');
			if ((TD || propose) && !mode.includes('--hunt=1') && !mode.includes('--tails=1')) mode.push('--tails=1');
			const res = await runTool('explore.js', [`--tas=${ref}`, `--out=${out}`, `--from=${win.w0}`, `--join=${win.w0}`, `--until=${win.w1}`,
				`--seconds=${secs}`, `--workers=${per}`, '--exact=1', ...mode, `--seed=${seed}`, `--nocoins=${cblind || propose ? 1 : 0}`,
				'--maxEntries=1500000', LVL],
				(secs + 300) * 1000, path.join(OUT, `grind_sweep${round}_${id}.log`));
			let saved = ownSaving(out, refTicks), runOut = out;
			let got = fs.existsSync(out) ? consider(out, name) : null;
			if (got) addResult(out);
			if ((TD || propose) && fs.existsSync(`${out}.edges.json`) && Date.now() < deadline - 60000) {
				// the window's clock-blind (coin-blind) edges, each replayed plain or with the clock re-synced in the idle start, combined
				const po = path.join(OUT, `grind_deep_${round}_sw${id}p.eetas`);
				try { fs.unlinkSync(po); } catch (e) { /* none */ }
				await runTool('phase.js', [`--tas=${ref}`, `--out=${po}`, LVL, `--nocoins=${NC}`, `--edges=${out}.edges.json`, `--from=${win.w0}`, `--to=${win.w0 + 1}`,
					'--random=0', '--seconds=5'], Math.max(30e3, Math.min(300e3, deadline - Date.now() - 30e3)),   // (not past the deadline)
					path.join(OUT, `grind_sweep${round}_${id}p.log`));
				const ps = ownSaving(po, refTicks);
				if (fs.existsSync(po)) {
					const pg = consider(po, `${name} (${TD ? 'time doors' : 'coin-blind, replayed'})`);
					addResult(po);
					if (ps > saved) { saved = ps; runOut = po; got = pg; }
				}
			}
			inflight.delete(win.sig);
			done.push(win.sig);
			if (searched(res, saved)) { memo.record(win.sig, saved, round); saveMemo(); }
			// a stale find: the window again on the current best (once per sweep; a redo's own find is not redone)
			let again = '';
			if (saved > 0 && got && !got.accepted && !got.spliced && !win.redo && !redone.has(win.sig)) {
				const refTr = S.trace(level, refMs, tmode(), RANDOM);
				const share = inBest(runOut, refTr, refMs);
				if (share < 0.5) {
					redone.add(win.sig);
					redo.push({ tr: refTr, w0: win.w0, w1: win.w1, saved });
					stale++;
					again = `; stale (${Math.round(share * 100)}% of its states in the best, which is at ${fmt(best.runTicks)} now): again on the current best`;
				}
			}
			log(`${name}: ${saved > 0 ? `its window saves ${saved}` : 'nothing in this window'}${res && res.killed ? ' (stopped)' : ''}${again}`);
			ran++; if (saved > 0) found++;
		}
	};
	saveStatus({ stage: `sweep${round}`, round });
	log(`sweep${round}: hunt windows of ${SWEEP_LEN} ticks over the whole run (${bestTrace().tr.n} ticks), up to ${lanes} at once x ${room().per} threads, ${secs} s each` +
		`${TD ? ' (time doors: clock-blind rejoins, replayed by phase.js)' : ''}` +
		`${first ? ', every window' : `, up to ${Math.round(budget / 60e3)} min`}`);
	await Promise.all(Array.from({ length: lanes }, (x, k) => lane(k)));
	const o0 = order;
	if (!covered) pick();   // (a look only: the frontier stays where it was)
	order = o0;
	const rest = covered;
	cur.swOrder = rest ? 0 : order;
	if (rest) cur.swept = (cur.swept | 0) + 1;
	saveCursor();
	log(`sweep${round}: ${ran} window${ran === 1 ? '' : 's'} searched, ${found} found time${stale ? ` (${stale} stale: searched again on the best)` : ''}` +
		`${skipped.size ? `, ${skipped.size} resting (${[...new Set(skipped.values())].slice(0, 2).join('; ')})` : ''}` +
		`${rest ? '; every window of the run covered' : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
}

/**
 * Loop windows first (up to 5 per round, 60% of it): stretches where the run comes back to where it was with nothing collected or toggled in between
 * (loops.js), the longest first, each (as the state hashes at its ends) once, and none the window memory rests (the same
 * loop, ends shifted by a few ticks, is the same window). The explorer on exactly that window finds
 * a way around the loop directly; tiled windows contain a long loop only in some placements. Not on time-door levels
 * (an exact rejoin there needs a saving that is a multiple of 1000 ticks). Returns the number of windows run.
 */
async function loopWindows(round, max = 5) {
	if (level.hasTimeDoors) return 0;
	const tried = new Set(cur.loops || []);
	let ran = 0;
	while (ran < max && roundUsed() < 0.6 * ROUND_MS && Date.now() < deadline - 120000) {
		const H = bestTrace().tr.H, n = bestTrace().tr.n;
		// the loops that come back within 48 px, then (all tried) the wider ones within 96 px, then 160 px
		const nl = nextLoop(round, tried);
		cur.loops = [...tried].slice(-400);
		if (!nl) { if (!ran) log('deep: every loop of the run was explored already (or rests)'); return ran; }
		const l = nl.l, m = nl.m;
		tried.add(`${H[l.a]}:${H[l.b]}`);
		cur.loops = [...tried].slice(-400);
		const w0 = Math.max(0, l.a - 40), w1 = Math.min(n, l.b + 40), before = best.runTicks;
		const lp = path.join(OUT, `grind_deep_${round}_loop${ran}.eetas`);
		const res = await stage(`deep${round}_loop${ran + 1}`, 'explore.js', [TAS, `--out=${lp}`, `--from=${w0}`, `--join=${w0}`, `--until=${w1}`,
			`--seconds=${DEEP_S || 120}`, `--workers=${W}`, '--exact=1', '--roll=100', `--seed=${300 + (cur.seed = (cur.seed | 0) + 1)}`, `--nocoins=${ncAt(w0)}`,
			'--maxEntries=1500000', ...EXP_EXTRA, LVL], lp, 600e3, `the run comes back to (${l.x}, ${l.y}) ${l.len} ticks later: ticks ${l.a}-${l.b}${!NC && ncAt(w0) ? CB : ''}`);
		if (!res) return ran;
		addResult(lp);
		const saved = ownSaving(lp, before);
		if (searched(res, saved)) { memo.record(m.sig, saved, round); saveMemo(); }
		log(`deep${round}_loop${ran + 1}: ${saved > 0 ? `a way around the loop, -${saved}` : 'no way around the loop found'}`);
		saveCursor();
		ran++;
	}
	return ran;
}
/** 1) deep exact-rejoin exploring: the loop windows, then window after window from the deep cursor, for up to ~55% of
 *  the round (one at least) */
async function deepStage(round, R) {
	const WSZ = R([600, 400, 500, 350]);
	if (SWEEP_LOOP_MODE === 'first') await loopWindows(round, 2);
	await sweepStage(round);
	await loopWindows(round);
	let done = 0, rested = 0;
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
		// a window the memory rests (searched empty with the same route twice or more) is passed over
		const mw = memoWin(w.w0, w.w1, round);
		if (!mw.st.run && rested < wins.length) {
			rested++;
			log(`deep${round}: window ${wi + 1}/${wins.length}, ticks ${w.w0}-${w.w1}: ${mw.st.why}`);
			saveCursor({ deep: next || cursorAt(0) });
			continue;
		}
		if (!mw.st.run) return;   // (every window rests)
		const before = best.runTicks;
		const seed = 300 + (cur.seed = (cur.seed | 0) + 1);
		const dp = path.join(OUT, `grind_deep_${round}_${w.seg - 1}_${w.i}.eetas`);
		const name = `deep${round}_seg${w.seg}${w.of > 1 ? '.' + (w.i + 1) : ''}`;
		// every other window: guided skip hunting (explore --hunt: states ahead of the reference by a time-to-go field,
		// then its own inputs from there; FV 5760-5830: -15 where the plain explorer finds 0), else tails
		const hunt = a.hunt !== '0' && seed % 2 === 0;
		const res = await stage(name, 'explore.js', [TAS, `--out=${dp}`, `--from=${w.w0}`, `--join=${w.w0}`,
			`--until=${w.w1}`, `--seconds=${DEEP_S || R([150, 180, 150, 210])}`, `--workers=${W}`, '--exact=1', '--roll=100',
			`--seed=${seed}`, `--cell=${R([8, 6, 12, 8])}`, `--vcell=${R([2, 1.5, 3, 1])}`, `--ahead=${R([0.5, 0.6, 0.4, 0.7])}`,
			`--nocoins=${ncAt(w.w0)}`, '--maxEntries=1500000', ...(hunt ? ['--hunt=1'] : EXP_EXTRA), LVL], dp, 900e3,
			`window ${wi + 1}/${wins.length}, ticks ${w.w0}-${w.w1}${hunt ? ', skip hunting' : ''}${!NC && ncAt(w.w0) ? CB : ''}`);
		if (!res) return;
		addResult(dp);
		const saved = ownSaving(dp, before);
		if (searched(res, saved)) { memo.record(mw.sig, saved, round); saveMemo(); }
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
/**
 * The skip finder (skipfind.js): path changes the windows above cannot make (Egg Quest II's chimney: -183 ticks from
 * the run's state at t600, a climb whose line the run meets again only 520 ticks later): from states all along the
 * run, bounded every-move searches with fine cells (1 px, 1/16 px/tick) and lineage-stable picks, whose goal is any
 * later point of the run reached sooner, joined back exactly (the run's own inputs, or a second search) and judged.
 * A slice per round (--skipfindS, default 30% of a round, 120-300 s) on every thread, continuing its pass over the run
 * (`grind_skipfind.txt`: the starts searched, by their state and their goal window's); in the first round right after
 * mutA (a Find a route base route has the most path to gain), later after the sweep's deep windows. Opt-in for now:
 * --skipfind=1 (or EEAT_SKIPFIND=1).
 */
async function skipfindStage(round) {
	// opt-in (--skipfind=1 or EEAT_SKIPFIND=1) until an end-to-end A/B and a review have shown it pays: it was pushed
	// on by default without either (2026-09-27 20:49), and it takes 30% of every round
	if (a.skipfind !== '1' && process.env.EEAT_SKIPFIND !== '1') return;
	const secs = a.skipfindS ? +a.skipfindS : Math.max(120, Math.min(300, Math.round(0.3 * ROUND_MS / 1000)));
	if (deadline - Date.now() < (secs + 120) * 1000) return;
	const so = path.join(OUT, `grind_skipf_${round}.eetas`);
	// (a deep start's budget within the slice, its joins included: a slice of 180 s cut every 200-s deep start)
	const res = await stage(`skipfind${round}`, 'skipfind.js', [TAS, LVL, `--out=${so}`, `--workers=${W}`, `--nocoins=${NC}`, `--seconds=${secs}`,
		`--deepPerS=${Math.min(200, Math.max(60, secs - 20))}`, `--done=${path.join(OUT, 'grind_skipfind.txt')}`, ...dl()], so, (secs + 120) * 1000,
		'from states all along the run: every move to later points of the run');
	if (res) addResult(so);
}
/**
 * The corridor beam (flybeam.js): a non-exact optimizer for long low-contact stretches (fly, low gravity, ice arcs)
 * where no faster line shares a state with the run for 1,000+ ticks, so every exact-rejoin window is too short: from
 * the run's exact state every --flybeamStep (400) ticks an every-move beam that follows the run's own path (progress
 * along the run, one state per position / velocity cell, the run's own state always kept), up to --flybeamExt (1200)
 * ticks past its window, joined back exactly (a child equal to a later run state, or the run's own inputs from the
 * nearest states ahead) and judged. A slice per round (--flybeamS, default 30% of a round, 150-300 s) on every thread,
 * the starts by their longest low-contact stretch first (flybeam.js --order=stretch; `grind_flybeam.json`: the starts
 * done, by state hash: Infinity Pain's shaft ranks 1-6 of 99 starts, 83-88 in tick order). Opt-in:
 * --flybeam=1 (or EEAT_FLYBEAM=1).
 */
async function flybeamStage(round) {
	if (FLY_K || (a.flybeam !== '1' && process.env.EEAT_FLYBEAM !== '1')) return;
	// (a join needs its whole task: Infinity Pain's shaft find took 1,115 layers at W 2048, 326 s on one loaded EPYC thread)
	const secs = a.flybeamS ? +a.flybeamS : Math.max(150, Math.min(300, Math.round(0.3 * ROUND_MS / 1000)));
	if (deadline - Date.now() < (secs + 120) * 1000) return;
	const fo = path.join(OUT, `grind_flyb_${round}.eetas`);
	const res = await stage(`flybeam${round}`, 'flybeam.js', [TAS, LVL, `--out=${fo}`, `--workers=${W}`, `--nocoins=${NC}`, `--seconds=${secs}`,
		`--starts=${+a.flybeamStep || 400}`, `--ext=${+a.flybeamExt || 1200}`, `--W=${+a.flybeamW || 2048}`, `--timeS=${secs}`,
		// two settings per start: the plain beam (the ice level's finds) and the homing share with velocity-weighted tails
		// (Infinity Pain's shaft: -121 where the plain beam found no rejoin)
		`--cfg=${JSON.stringify([{}, { convF: 0.25, vw: 64 }])}`,
		`--order=stretch`, `--refine=${FLY_REFINE}`, `--axisTails=${FLY_AXIS}`, `--state=${path.join(OUT, 'grind_flybeam.json')}`, ...(FOREVER ? [] : [`--deadline=${deadline.getTime() - 90e3}`])], fo, (secs + 120) * 1000,
		'every-move beam along the run own path, joined back exactly');
	if (res) addResult(fo);
}
/**
 * The corridor beam as a CPU share instead of a slice of the rounds (--flybeamShare=K, EEAT_FLYBEAM_SHARE=K): K threads
 * run flybeam.js for the whole session, next to the stages (which get W = the workers - K), in calls of
 * --flybeamShareS (600) s on their own copy of the best (`grind_flyref.eetas`: the stages' copy changes under them), the
 * same starts, settings and stretch order as the stage (`grind_flybeam.json`); every call's find is offered at once
 * (a stale one spliced with the best). A pass over every start of an unchanged best is not repeated (flybeam.js
 * --wrap=0): the lane waits for a new best. Its first call comes at once, so the stretches it ranks first are searched
 * in the session's first minutes, not after round 1's mutate and sweep (Infinity Pain from 39,410 at 3 threads: the
 * stage's first slice ~25 min in).
 */
async function flybeamLane() {
	const secs = Math.max(150, +a.flybeamShareS || 600);
	const ref = path.join(OUT, 'grind_flyref.eetas');
	const logFile = path.join(OUT, 'grind_flybeam_lane.log');
	log(`flybeam lane: ${FLY_K} thread${FLY_K > 1 ? 's' : ''} for the corridor beam, ${W} for the stages`);
	let k = 0, waitFor = -1, held = false;
	while (FOREVER || Date.now() < deadline - (secs / 2 + 120) * 1000) {
		if (waitFor >= 0 && best.runTicks === waitFor) { await new Promise((r) => setTimeout(r, 15000)); continue; }
		// (while Find a route holds the CPU (the AutoTASer's fresh cpu_share: the stages run on its share) the lane waits: its
		// thread would come out of Find a route's)
		if (stageWorkers() < W) {
			if (!held) log('flybeam lane: waiting while Find a route holds the CPU (cpu_share)');
			held = true;
			await new Promise((r) => setTimeout(r, 15000));
			continue;
		}
		held = false;
		waitFor = -1;
		const s = FOREVER ? secs : Math.min(secs, Math.floor((deadline - Date.now()) / 1000) - 120);
		const fo = path.join(OUT, `grind_flyb_lane${++k}.eetas`);
		try { fs.unlinkSync(fo); } catch (e) { /* none */ }
		C.writeEetas(ref, best.ms);
		const from = best.runTicks;
		log(`flybeam lane ${k} (${s} s on ${fmt(from)})...`);
		const res = await runTool('flybeam.js', [`--tas=${ref}`, LVL, `--out=${fo}`, `--threads=${FLY_K}`, `--nocoins=${NC}`, `--seconds=${s}`,
			`--starts=${+a.flybeamStep || 400}`, `--ext=${+a.flybeamExt || 1200}`, `--W=${+a.flybeamW || 2048}`, `--timeS=${s}`,
			`--cfg=${JSON.stringify([{}, { convF: 0.25, vw: 64 }])}`, '--order=stretch', `--refine=${FLY_REFINE}`, '--wrap=0', `--axisTails=${FLY_AXIS}`,
			`--state=${path.join(OUT, 'grind_flybeam.json')}`, ...(FOREVER ? [] : [`--deadline=${deadline.getTime() - 90e3}`])], (s + 120) * 1000, null);
		// (every call's lines kept: the log grows by ~5 KB a call; past 4 MB it starts over)
		try {
			if (fs.existsSync(logFile) && fs.statSync(logFile).size > 4e6) fs.unlinkSync(logFile);
			fs.appendFileSync(logFile, `== lane ${k} (${new Date().toTimeString().slice(0, 8)})\n${res ? res.out : ''}\n`);
		} catch (e) { /* ignore */ }
		if (fs.existsSync(fo)) { consider(fo, `flybeam lane ${k}`); addResult(fo); }
		else log(`flybeam lane ${k}: nothing faster`);
		if (res && /every start done/.test(res.out)) { waitFor = from; log('flybeam lane: every start of this best searched; waiting for a new best'); }
		else if (!res || res.code !== 0) await new Promise((r) => setTimeout(r, 30000));
	}
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
		`--workers=${W}`, LVL, `--nocoins=${ncAt(from)}`, `--deadline=${Math.min(deadline.getTime() - 90e3, Date.now() + budget + 60e3)}`], sc, budget + 600e3,
		`ticks ${from}-${to} of ${n}${!NC && ncAt(from) ? CB : ''}`);
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
const HAS_COIN_DOORS = level.fg.some((id) => C.COIN_DOOR_IDS.has(id));
const phaseOn = () => !!level.hasTimeDoors || (!NC && HAS_COIN_DOORS);   // (NC can change at a round's start)
let phaseKey = '';   // the best the last phase pass searched
async function phaseStage(round, R, tag = '') {
	if (!phaseOn()) return;
	const key = crypto.createHash('sha1').update(C.eetasBytes(best.ms)).digest('hex');
	if (tag && key === phaseKey) return;   // (the second pass of a round: only on a new best)
	phaseKey = key;
	const po = path.join(OUT, `grind_phase${tag}_${round}.eetas`);
	await stage(`phase${tag}${round}`, 'phase.js', [TAS, `--out=${po}`, LVL, `--nocoins=${NC}`, `--step=${R([2, 1, 3, 2])}`, `--from=${R([0, 0, 1, 1])}`, `--workers=${W}`,
		`--horizon=${R([300, 400, 250, 500])}`, `--drift=${R([96, 128, 64, 160])}`, `--seconds=${R([120, 180, 120, 120])}`, `--random=${R([60, 90, 60, 120])}`, `--seed=${round}`], po, 900e3,
		level.hasTimeDoors ? 'time doors' : 'coin doors');
}

async function main() {
	if (a.gpu === '1') { log('GPU on: the GPU searcher runs next to the CPU stages'); startGpu(); }
	checkInbox();
	try { recoverOutputs(); } catch (e) { log(`earlier stage outputs: ${e && e.message || e}`); }
	if (FLY_K) flybeamLane().catch((e) => log(`flybeam lane: ${e && e.stack || e}`));
	// the round to continue: the one in progress when the grind stopped, else the next
	const rounds = +status.rounds || (+a.rot || 0);
	let round = cur.stage && cur.round > rounds ? cur.round : rounds + 1;
	firstRound = round;
	for (; Date.now() < deadline - 120000; round++) {
		curRound = round;
		redecideCoins();
		const STAGES = phaseOn() ? STAGES_PHASE : STAGES_ALL;
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
			else if (sname === 'skipfA') { if (round === firstRound && round === 1) await skipfindStage(round); }
			else if (sname === 'skipf') { if (!(round === firstRound && round === 1)) await skipfindStage(round); }
			else if (sname === 'flyb') await flybeamStage(round);
			else if (sname === 'mutB') await mutateLoop(`${round}b`);
			else if (sname === 'sc') await shortcutsStage(round, R);
			else if (sname === 'phase') await phaseStage(round, R);
			else if (sname === 'phaseB') await phaseStage(round, R, 'b');
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
	// the deadline's end is the process's: the live timer kept it alive and its GPU searcher kept searching and handing
	// runs in past --until (2026-09-28, the flybeam A/B: both arms' grinds and searchers still ran 2+ min after
	// "finished", one arm's best 4,834 -> 4,816 then); the searcher gets SIGTERM (its own quit: eegpu's stop file first)
	clearInterval(liveTimer);
	const ch = gpuChild;
	if (!ch) process.exit(0);
	ch.once('exit', () => process.exit(0));
	setTimeout(() => process.exit(0), 10000).unref();
	try { ch.kill(); } catch (e) { process.exit(0); }
}
main().catch((e) => { log(`error: ${e && e.stack || e}`); saveStatus({ state: 'error', error: String(e && e.message || e) }); process.exit(1); });
