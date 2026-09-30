'use strict';
// The compiler's headless runner (n4plan): the compile loop of src/plan/strategy.js (MODEL -> BOUNDS -> PLAN -> MOVES ->
// VERIFY -> POLISH) on one level, JSON lines on stdout. The level editor's Find a route strategy 'plan' ("the planner
// (compile)", only with EEAT_PLAN=1 or the body's plan: true) reads them: 'result' routes (found()), 'source' states
// (the one search's archive), 'progress' (its detail: the strategy row's status line). The product CLI is src/compile.js.
//   node src/plan.js <level.eelvl | level.json | job id> [--seconds=300] [--workers=2] [--seed=1] [--stdin=1] [--first=1]
//       [--polish=1] [--stallS=0] [--depth=D] [--out=<dir, default src/out/n4plan/runs/<name>_<stamp>>] [--known=0]
//       [--nice=N] [--gpu=1 (accepted: reserved for the primitives' table builder; the compiler uses no GPU)]
//       [--parts=<module of mock parts: tests>]
//   stdin (--stdin=1): "depth D" (only routes of at most D ticks), "stop", "route <inputs>" (a known route: its run ticks
//   bound the branch and bound), "import <inputs>" (a state of another search: a new model state is an anchor),
//   "steer <file>" / "steerd <file>" (the source events' distances); the end of stdin stops it.
//   Exit 0 on a clean end; {"error": ...} and exit 1 on an exception.
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./plan/types.js');

function parse(argv) {
	const a = { _: [] };
	for (const s of argv) {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		if (m) a[m[1]] = m[2] === undefined ? '1' : m[2];
		else a._.push(s);
	}
	return a;
}
/** the level of a file (.eelvl / level JSON) or a job id (its level JSON: the job's start mode) */
function levelOf(arg) {
	try { return T.loadLevelFile(arg); } catch (e) {
		try { const J = require('./jobs.js'); return J.loadJobLevel(J.resolve(arg)); } catch (e2) { throw e; }
	}
}
async function main() {
	const a = parse(process.argv.slice(2));
	if (!a._.length) throw new Error('usage: node src/plan.js <level.eelvl|.json|job id> [--seconds=300] [--workers=2] [--stdin=1] [--first=1] [--out=dir]');
	const emit = T.emitter(process.stdout);
	const file = a._[0];
	const L = levelOf(file);
	// (Linux, next to the editor's GPU strategies: this process below them, as the CPU search's workers)
	if (+a.nice > 0) { try { os.setPriority(0, Math.min(19, +a.nice)); } catch (e) { /* not allowed */ } }
	if (a.gpu === '1') emit({ ev: 'warning', text: '--gpu: reserved for the primitives\' table builder; the compiler uses no GPU tonight' });
	const name = String(L.world_name || L.name || path.basename(String(file)).replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'level';
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
	const out = a.out ? path.resolve(a.out) : a.work ? path.join(path.resolve(a.work), 'run') : path.join(__dirname, 'out', 'n4plan', 'runs', `${name}_${stamp}`);
	let stdinLines = null;
	if (a.stdin === '1') stdinLines = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
	const exists = fs.existsSync(String(file));
	const opts = { file: exists ? path.resolve(String(file)) : String(file), seconds: +a.seconds || 300, workers: +a.workers || 2, seed: Number.isFinite(+a.seed) ? +a.seed : 1, steer: a.steer || null,
		first: a.first === '1', polish: a.polish !== '0', stallS: +a.stallS || 0, depth: +a.depth || 0, out, stdinLines, stopOnStdinEnd: true, known: a.known === '1' && exists ? undefined : false };
	// (tests: a module of mock parts, --parts=<file.js> exporting {compileModel, createFacts, createPlanner, createExecutor, ...})
	if (a.parts) opts.parts = path.resolve(a.parts);
	if (a.stallWindowS) opts.stallWindowS = +a.stallWindowS;
	if (a.watchMs) opts.watchMs = +a.watchMs;
	if (a.progressMs) opts.progressMs = +a.progressMs;
	if (a.rungMs) opts.rungMs = String(a.rungMs).split(',').map(Number);
	const S = require('./plan/strategy.js');
	// (the CLI's hard watchdog: a part's synchronous call past the budget ends the process with its reason, as in compile.js)
	const CP = require('./compile.js');
	const wdS = +process.env.EEAT_COMPILE_WATCHDOG_S > 0 ? +process.env.EEAT_COMPILE_WATCHDOG_S : opts.seconds + Math.max(CP.WATCHDOG_MIN_S, CP.WATCHDOG_F * opts.seconds);
	const wd = CP.watchdog(wdS * 1000, true);
	const emitW = (ev) => { if (ev.ev === 'stage' || ev.ev === 'step' || ev.ev === 'plan') wd.note(ev); emit(ev); };
	let r;
	try { r = await S.run(L, opts, emitW); } finally { wd.stop(); }
	if (stdinLines) stdinLines.close();
	return r;
}
// (the end: stdout drained first, then out, whatever worker threads a part left)
const exitWith = (code) => { process.exitCode = code; try { process.stdout.write('', () => process.exit(code)); } catch (e) { process.exit(code); } };
// (a ref'd keep-alive until main settles: see src/compile.js)
const keepAlive = setInterval(() => {}, 1 << 30);
main().then(() => { clearInterval(keepAlive); exitWith(0); }, (e) => {
	clearInterval(keepAlive);
	try { process.stdout.write(JSON.stringify({ error: String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) }) + '\n'); } catch (e2) { /* closed */ }
	exitWith(1);
});
