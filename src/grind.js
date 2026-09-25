'use strict';
// Keeps optimizing one job's TAS by cycling the search tools on the current best run, forever or until a deadline:
//   mutate.js (input mutations), explore.js (route explorer with exact rejoins, every coin-to-coin segment in
//   windows), shortcuts.js (dense local exact shortcuts), optimize.js (beam with verified leads, every other round),
// and splice.js (joins every result into the best run at equal states). Every accepted run is verified by a clean
// replay (common.judge): it must finish the level, faster, with no more deaths than the starting run and no lower
// random-portal chance.
//
// Everything lives in the job directory (src/jobs/<id>/): best.eetas, best_<ticks>.eetas, grind.log, status.json
// (read by the web app and tas.js). The job inbox (inbox/*.eetas, dropped by `tas.js try`, POST /api/jobs/:id/try
// and `tas.js focus`) is checked every few seconds, also while a stage runs; finishing runs from outside that are
// not accepted are kept in pieces/ and spliced in at the end of every round (a partial improvement still helps).
//
// usage: node src/grind.js --job=src/jobs/<id> [--level=<level id>] [--until=HH:MM | --forever=1] [--workers=N]
//        [--nocoins=auto|0|1] [--rot=N] [--skip=A,deep,beam]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const C = require('./common.js');
const E = C.E;

const a = { until: '', forever: '', level: '', workers: os.cpus().length, job: '', nocoins: 'auto' };
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
const INBOX = path.join(OUT, 'inbox');
const PIECES = path.join(OUT, 'pieces');
const JOB_ID = path.basename(OUT);
const LEVEL_ID = a.level || C.jobLevelId(JOB_ID);
const LEVEL_JSON = C.levelData(LEVEL_ID);
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(PIECES, { recursive: true });
const level = E.loadLevel(LEVEL_JSON);
const W = +a.workers || os.cpus().length;
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

/** Offers a finished run file to the best (THE rule: common.judge). Returns { accepted, r, verdict }. */
function consider(file, what) {
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
	if (r.runTicks <= best.runTicks) r.chance = chanceOf(r); else r.chance = 0;
	const v = C.judge(r, best, baseDeaths);
	if (!v.accept) {
		if (r.runTicks < best.runTicks) log(`${what}: ${fmt(r.runTicks)} rejected: ${v.reason}`);
		return { accepted: false, r, verdict: v };
	}
	log(`${what}: ${fmt(best.runTicks)} -> ${fmt(r.runTicks)} (-${best.runTicks - r.runTicks})` + (RANDOM ? `, chance ${(r.chance * 100).toFixed(1)}%` : ''));
	status.history.push({ t: Date.now(), runTicks: r.runTicks, saved: best.runTicks - r.runTicks, what, chance: r.chance });
	best = r;
	saveStatus({ chance: r.chance });
	publish();
	return { accepted: true, r, verdict: v };
}

// ---------------------------------------------------------------- the job inbox
let inboxBusy = false;
function checkInbox() {
	if (inboxBusy) return;
	inboxBusy = true;
	try {
		let files = [];
		try { files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.eetas')).sort(); } catch (e) { /* none */ }
		for (const f of files) {
			const fp = path.join(INBOX, f);
			const meta = C.readJSON(fp + '.json', {});
			const source = meta.source || 'inbox';
			const res = consider(fp, `inbox (${source})`);
			if (!res.accepted) log(`inbox (${source}): ${res.r ? fmt(res.r.runTicks) : 'no finish'} not accepted (${res.verdict.reason})` + (res.r ? '; kept for splicing' : ''));
			const rec = { file: f, source, t: Date.now(), accepted: res.accepted, runTicks: res.r ? res.r.runTicks : null, time: res.r ? fmt(res.r.runTicks) : null,
				chance: res.r ? res.r.chance : null, best: best.runTicks, bestTime: fmt(best.runTicks), reason: res.accepted ? '' : res.verdict.reason };
			try { fs.appendFileSync(path.join(INBOX, 'results.jsonl'), JSON.stringify(rec) + '\n'); } catch (e) { /* ignore */ }
			try {
				if (res.r) fs.renameSync(fp, path.join(PIECES, f)); else fs.unlinkSync(fp);
			} catch (e) { try { fs.unlinkSync(fp); } catch (e2) { /* gone */ } }
			try { fs.unlinkSync(fp + '.json'); } catch (e) { /* none */ }
		}
		if (files.length) prunePieces();
	} finally { inboxBusy = false; }
}
function prunePieces(keep = 30) {
	let fl = [];
	try { fl = fs.readdirSync(PIECES).filter((f) => f.endsWith('.eetas')).sort(); } catch (e) { return; }
	for (const f of fl.slice(0, Math.max(0, fl.length - keep))) { try { fs.unlinkSync(path.join(PIECES, f)); } catch (e) { /* gone */ } }
}

// ---------------------------------------------------------------- stages (child processes, awaited)
/** Runs a tool; while it runs the inbox is checked every 3 s and the status heartbeat written every 30 s. */
function runTool(script, args, maxMs, logFile) {
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, ['--max-old-space-size=12000', path.join(__dirname, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const chunks = [];
		let size = 0;
		const keep = (d) => { if (size < (64 << 20)) { chunks.push(d); size += d.length; } };
		ch.stdout.on('data', keep); ch.stderr.on('data', keep);
		const inbox = setInterval(checkInbox, 3000);
		const beat = setInterval(() => saveStatus(), 30000);
		const kill = setTimeout(() => { try { ch.kill(); } catch (e) { /* gone */ } }, maxMs);
		ch.on('close', (code) => {
			clearInterval(inbox); clearInterval(beat); clearTimeout(kill);
			if (logFile) { try { fs.writeFileSync(logFile, Buffer.concat(chunks)); } catch (e) { /* ignore */ } }
			resolve(code);
		});
		ch.on('error', () => { clearInterval(inbox); clearInterval(beat); clearTimeout(kill); resolve(-1); });
	});
}

let results = [];
async function spliceAll() {
	results = results.slice(-80);   // bounded: an endless run would otherwise splice thousands of files
	let pieces = [];
	try { pieces = fs.readdirSync(PIECES).filter((f) => f.endsWith('.eetas')).map((f) => path.join(PIECES, f)); } catch (e) { /* none */ }
	const ex = results.concat(pieces).filter((f) => fs.existsSync(f));
	if (ex.length === 0) return;
	const out = path.join(OUT, 'grind_splice.eetas');
	try { fs.unlinkSync(out); } catch (e) { /* none */ }
	C.writeEetas(REF, best.ms);
	saveStatus({ stage: 'splice' });
	await runTool('splice.js', [out, REF, ...ex, `--level=${LEVEL_ID}`, ...(NC ? ['--nocoins'] : [])], 3600e3, path.join(OUT, 'grind_splice.log'));
	if (fs.existsSync(out)) consider(out, 'splice');
}
const skip1 = new Set(String(a.skip || '').split(',').filter(Boolean));   // --skip=A,deep,beam: skipped in round 1
let curRound = 0;
async function stage(name, script, args, outFile, maxMs) {
	const tag = name.startsWith('shortcuts') ? 'A' : name.startsWith('deep') ? 'deep' : name.startsWith('beam') ? 'beam' : '';
	if (curRound === 1 && tag && skip1.has(tag)) { log(`${name}: skipped (--skip)`); return false; }
	const left = deadline - Date.now();
	if (left < 60000) return false;
	checkInbox();
	try { fs.unlinkSync(outFile); } catch (e) { /* none */ }
	C.writeEetas(REF, best.ms);   // the stage searches from this exact copy of the current best
	log(`${name}...`);
	saveStatus({ stage: name, round: curRound });
	await runTool(script, args, Math.min(maxMs, left + 240e3), path.join(OUT, `grind_${name.replace(/[^\w.-]/g, '_')}.log`));   // grace: stages with --deadline wrap up themselves
	if (fs.existsSync(outFile)) consider(outFile, name);
	return true;
}
const dl = () => (FOREVER ? [] : [`--deadline=${deadline.getTime() - 90e3}`]);
const TAS = `--tas=${REF}`;
const LVL = `--level=${LEVEL_ID}`;

// cheap input-mutation passes (seconds each), repeated while they keep finding time
async function mutateLoop(tag) {
	for (let k = 1; k <= 8; k++) {
		const mo = path.join(OUT, `grind_mut_${tag}_${k}.eetas`);
		const before = best.runTicks;
		await stage(`mutate_${tag}_${k}`, 'mutate.js', [TAS, `--out=${mo}`, '--horizon=800', `--workers=${W}`, LVL, `--nocoins=${NC}`, ...dl()], mo, 1800e3);
		if (best.runTicks >= before) break;
	}
}

async function main() {
	checkInbox();
	for (let round = 1; Date.now() < deadline - 120000; round++) {
		curRound = round;
		const R = (arr) => arr[(round - 1 + (+a.rot || 0)) % arr.length];   // --rot=N continues the parameter rotation after a restart
		await mutateLoop(`${round}a`);
		// 1) deep exact-rejoin exploring of EVERY coin-to-coin segment (a level without coins is one segment), in windows
		const ct = coinTicks(best.ms);
		const segs = [];
		for (let k = 1; k < ct.length; k++) segs.push([k - 1, k]);
		const off = (round - 1 + (+a.rot || 0)) % Math.max(1, segs.length);
		const order = [...segs.slice(off), ...segs.slice(0, off)];   // start with a different segment every round
		for (const [k0, k1] of order) {
			const c = coinTicks(best.ms);   // ticks move as the run improves
			if (!(c[k0] >= 0 && c[k1] > c[k0])) continue;
			const lo = Math.max(0, c[k0] - 20), hi = c[k1] + 80;
			const wins = [];
			const WSZ = R([600, 400, 500, 350]), WSTEP = WSZ - 100;   // smaller windows = more focused exploring
			if (hi - lo <= WSZ + 150) wins.push([lo, hi]);
			else for (let w0 = lo; w0 < hi - 100; w0 += WSTEP) wins.push([w0, Math.min(hi, w0 + WSZ)]);
			for (let wi = 0; wi < wins.length; wi++) {
				const [w0, w1] = wins[wi];
				const dp = path.join(OUT, `grind_deep_${round}_${k0}_${wi}.eetas`);
				await stage(`deep${round}_seg${k1}${wins.length > 1 ? '.' + (wi + 1) : ''}`, 'explore.js', [TAS, `--out=${dp}`, `--from=${w0}`, `--join=${w0}`,
					`--until=${w1}`, `--seconds=${R([150, 180, 150, 210])}`, `--workers=${W}`, '--exact=1', '--roll=100',
					`--seed=${round * 17 + k0 * 5 + wi + 300}`, `--cell=${R([8, 6, 12, 8])}`, `--vcell=${R([2, 1.5, 3, 1])}`, `--ahead=${R([0.5, 0.6, 0.4, 0.7])}`,
					`--nocoins=${NC}`, '--maxEntries=1500000', LVL], dp, 900e3);
				results.push(dp);
			}
		}
		await mutateLoop(`${round}b`);
		// 2) one dense local-shortcut pass (alternating settings)
		const sc = path.join(OUT, `grind_sc_${round}.eetas`);
		await stage(`shortcuts${round}`, 'shortcuts.js', [TAS, `--out=${sc}`, '--step=10', `--from=${R([5, 2, 7, 4])}`,
			`--depth=${R([180, 150, 200, 160])}`, `--cap=${R([2000, 3000, 1800, 2500])}`, `--dist=${R([24, 16, 32, 40])}`, `--bcap=${R([8, 12, 16, 6])}`,
			`--workers=${W}`, LVL, `--nocoins=${NC}`, ...dl()], sc, 3 * 3600e3);
		results.push(sc);
		await mutateLoop(`${round}c`);
		// 3) beam with verified leads, every other round
		if (round % 2 === 0) {
			const bm = path.join(OUT, `grind_beam_${round}.eetas`);
			await stage(`beam${round}`, 'optimize.js', [TAS, `--out=${bm}`, `--width=${R([4000, 6000, 3000, 8000])}`, `--dist=${R([24, 16, 32, 24])}`,
				'--passes=1', `--workers=${W}`, LVL], bm, 3 * 3600e3);
			results.push(bm);
		}
		await spliceAll();
		log(`round ${round} done: best ${fmt(best.runTicks)}`);
		saveStatus({ rounds: round });
	}
	log(`finished: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks})`);
	saveStatus({ state: 'finished', stage: 'finished' });
}
main().catch((e) => { log(`error: ${e && e.stack || e}`); saveStatus({ state: 'error', error: String(e && e.message || e) }); process.exit(1); });
