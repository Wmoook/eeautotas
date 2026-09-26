'use strict';
// The GPU searcher's failure handling (src/gpusearch.js), without a GPU: gpusearch runs against a stand-in for eegpu
// (--tool=<file.js>) that follows a plan, one step per invocation, on a job imported into a temp folder.
//  1. failures that are not launch failures (out of GPU memory: no kernel ran) are retried after waits that double
//     (--failWait: the first), and a run that works starts them over;
//  2. launch failures (the driver's watchdog) wait, halve --launch-ms, and stop the searcher after 3 in a row (exit 5);
//  3. a quit (the grind gone: --parent) asks the running tool to stop through its stop file and never kills it.
//   node test/gpusearch.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eegpu-gs-'));
process.env.EEAT_HOME = TMP;   // (before common.js is loaded: the job lives in the temp folder)
const C = require('../src/common.js');
const J = require('../src/jobs.js');
const ED = require('../src/editor.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

// a room: the start on the left, the trophy on the floor at the right; the run: right held
const W = 30, H = 8, cells = [];
for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
for (let y = 0; y < H; y++) cells.push([0, y, 9], [W - 1, y, 9]);
cells.push([2, 6, 255], [27, 6, 121]);
const eelvl = ED.eelvlOf({ name: 'gpusearch test', width: W, height: H, cells });
const meta = J.importJob({ eelvl, eetas: Buffer.from('4'.repeat(400)), name: 'gpusearch test', eelvlName: 'room.eelvl', eetasName: 'room.eetas' });
const dir = J.jobDir(meta.id);
const statusFile = path.join(dir, 'status.json');
C.writeJSON(statusFile, Object.assign(C.readJSON(statusFile, {}), { coinsOptional: false, state: 'stopped' }));

// the stand-in: step k of PLAN (a file) for its k-th invocation: oom (an error line, exit 4), launch (a launch timeout,
// exit 7), ok (an empty edges file, done), slow (runs until its stop file appears, then done with end "stopped"); every
// invocation is logged with its time and arguments
const TOOL = path.join(TMP, 'tool.js');
fs.writeFileSync(TOOL, `'use strict';
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const opt = (k) => { const x = a.find((s) => s.startsWith('--' + k + '=')); return x ? x.slice(k.length + 3) : ''; };
const dir = ${JSON.stringify(TMP)};
const plan = fs.readFileSync(path.join(dir, 'plan.txt'), 'utf8').trim().split(',');
const cnt = path.join(dir, 'calls.txt');
const k = fs.existsSync(cnt) ? +fs.readFileSync(cnt, 'utf8') : 0;
fs.writeFileSync(cnt, String(k + 1));
const step = plan[Math.min(k, plan.length - 1)];
const log = (s) => fs.appendFileSync(path.join(dir, 'tool.log'), JSON.stringify(Object.assign({ t: Date.now(), k, step }, s)) + '\\n');
log({ launchMs: +opt('launch-ms'), stopfile: opt('stopfile'), parent: +opt('parent') });
const empty = () => { const b = Buffer.alloc(16); b.writeUInt32LE(0x44454545, 0); b.writeUInt32LE(1, 4); fs.writeFileSync(a[3], b); };
const done = (x) => console.log(JSON.stringify(Object.assign({ ev: 'done', gpu: { name: 'stand-in' }, ticks: 0, ticksPerSec: 0, seconds: 0.1, edges: 0, families: {} }, x)));
if (step === 'oom') { console.log(JSON.stringify({ error: 'cuMemAlloc_v2 failed: CUDA error 2 (out of memory)' })); process.exit(4); }
if (step === 'launch') { console.log(JSON.stringify({ error: 'the GPU driver stopped the search kernel after 2100 ms (CUDA error 702, launch timeout)', cuda: 702, launchError: true, timeout: true })); process.exit(7); }
if (step === 'ok') { empty(); done({}); process.exit(0); }
// slow: until the stop file appears (what eegpu does between two launches)
const stop = opt('stopfile');
const iv = setInterval(() => {
	if (stop && fs.existsSync(stop)) { log({ stopped: true }); empty(); done({ end: 'stopped' }); clearInterval(iv); process.exit(0); }
}, 50);
setTimeout(() => { log({ timeout: true }); process.exit(0); }, 60000);
`);

/** one gpusearch session with a plan: until `until(calls)` is true (or 60 s), then its parent goes away; resolves
 *  {code, out, calls: the tool's log lines} */
function session(plan, extra, until) {
	fs.writeFileSync(path.join(TMP, 'plan.txt'), plan.join(','));
	for (const f of ['calls.txt', 'tool.log']) fs.rmSync(path.join(TMP, f), { force: true });
	fs.rmSync(path.join(dir, 'gpu'), { recursive: true, force: true });
	const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
	const ch = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'gpusearch.js'), `--job=${dir}`, `--tool=${TOOL}`, '--round=10', `--parent=${parent.pid}`, ...extra],
		{ env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	ch.stdout.on('data', (d) => { out += d; });
	ch.stderr.on('data', (d) => { out += d; });
	const calls = () => { try { return fs.readFileSync(path.join(TMP, 'tool.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
	return new Promise((resolve) => {
		const t0 = Date.now();
		let gone = false;
		const iv = setInterval(() => {
			if (!gone && (until(calls()) || Date.now() - t0 > 60000)) { gone = true; parent.kill(); }
		}, 100);
		ch.on('close', (code) => { clearInterval(iv); if (!gone) parent.kill(); resolve({ code, out, calls: calls() }); });
	});
}

(async () => {
	console.log(`job ${meta.id} in ${TMP}`);
	// 1. out of memory 4 times, a run that works, out of memory once more, then runs that work
	{
		const r = await session(['oom', 'oom', 'oom', 'oom', 'ok', 'oom', 'ok'], ['--failWait=0.3'], (c) => c.length >= 8);
		const gaps = r.calls.slice(1).map((c, i) => (c.t - r.calls[i].t) / 1000);
		const lines = r.out.split('\n').filter((l) => l.includes('round failed'));
		// (the time between two invocations is the wait plus the round's own work and the stand-in's start: at least the wait)
		check('out of memory: the waits double (at least 0.3, 0.6, 1.2, 2.4 s between the tries)', gaps.length >= 6 && [0.3, 0.6, 1.2, 2.4].every((w, i) => gaps[i] >= w - 0.05),
			`gaps ${gaps.map((g) => g.toFixed(2)).join(', ')} s`);
		check('... and start over after a run that works (0.3 s again)', gaps.length >= 6 && gaps[5] >= 0.25 && lines.length >= 4 && /0\.3 s \(failure 1 in a row\)/.test(lines[3]),
			`gap after the 6th try ${gaps[5] && gaps[5].toFixed(2)} s; ${lines[3] || 'no log line'}`);
		check('... with a log line for the first failures in a row and the repeat after the run that worked', lines.length === 4 &&
			/trying again in 0\.3 s \(failure 1 in a row\)/.test(lines[0]) && /1\.2 s \(failure 3 in a row\)/.test(lines[2]) && /0\.3 s \(failure 1 in a row\)/.test(lines[3]), lines.join(' | '));
		check('... and no launch back-off (the launch target stays 50 ms)', r.calls.every((c) => c.launchMs === 50), r.calls.map((c) => c.launchMs).join(', '));
		check('... the searcher quits when its parent goes away (exit 0)', r.code === 0, `exit ${r.code}`);
	}
	// 2. launch failures: waits, the launch target halves, and the third in a row stops the searcher (exit 5)
	{
		const r = await session(['launch'], ['--launchWait=0.3'], () => false);
		const gaps = r.calls.slice(1).map((c, i) => (c.t - r.calls[i].t) / 1000);
		check('launch failures: 3 tries, then the searcher stops (exit 5)', r.calls.length === 3 && r.code === 5 && /stopping the GPU searcher for this session/.test(r.out), `${r.calls.length} tries, exit ${r.code}`);
		check('... launch targets 50, 25, 12.5 ms', r.calls.map((c) => c.launchMs).join(',') === '50,25,12.5', r.calls.map((c) => c.launchMs).join(', '));
		check('... after waits of 0.3 and 0.6 s', gaps.length === 2 && gaps[0] >= 0.25 && gaps[1] >= 0.55, gaps.map((g) => g.toFixed(2)).join(', '));
	}
	// 3. a quit while the tool runs: its stop file, no kill; the tool ends by itself with end "stopped"
	{
		const r = await session(['slow'], [], (c) => c.length >= 1 && Date.now() - c[0].t > 1000);
		const stopped = r.calls.find((c) => c.stopped);
		check('quit: the running tool is asked to stop (its stop file) and ends by itself', !!stopped && r.code === 0, `${r.calls.length} calls, exit ${r.code}${stopped ? '' : '; the tool never saw its stop file'}`);
		check('... it was started with --stopfile and --parent', r.calls.length >= 1 && !!r.calls[0].stopfile && r.calls[0].parent > 0, JSON.stringify(r.calls[0] || {}));
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	fs.rmSync(TMP, { recursive: true, force: true });
	process.exit(fail ? 1 : 0);
})();
