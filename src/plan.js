'use strict';
// The planner's headless runner (n4plan): UNDERSTAND -> PLAN -> EXECUTE -> REFINE (src/plan/strategy.js) on one level,
// JSON lines on stdout (the editor's strategy 'plan', EEAT_PLAN=1 / Find a route's body plan: true, reads them).
//   node src/plan.js <level.eelvl | level.json | job id> [--seconds=300] [--workers=2] [--seed=1]
//       [--gpu=1 [--tool=<eegpu, default gpu.js nativeTool()>] [--pausefile=] [--cachedir=]] [--work=<dir>]
//       [--steer=<RCH4 file: the CPU's steer field (the 'source' / 'closest' distances)>] [--stdin=1] [--first=1]
//       [--stallS=0] [--depth=D] [--out=<dir, default src/out/n4plan/runs/<name>_<stamp>, or <work>/run>] [--verbose]
//   stdin (--stdin=1): "depth D", "stop", "import <inputs>" (a state of another search: a new model state is an anchor),
//   "route <inputs>" (a known route: its ticks the bound), "steer <file>" / "steerd <file>" (the distances' steer field);
//   the end of stdin stops it.
//   The box's GPUs: the caller's CUDA_VISIBLE_DEVICES. Exit 0 on a clean end; {"error": ...} and exit 1 on an exception.
const fs = require('fs');
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
function levelOf(arg) {
	try { return T.loadLevelFile(arg); } catch (e) {
		// (a job id or part of its name: its level JSON)
		try { const J = require('./jobs.js'); return J.loadJobLevel(J.resolve(arg)); } catch (e2) { throw e; }
	}
}
async function main() {
	const a = parse(process.argv.slice(2));
	if (!a._.length) throw new Error('usage: node src/plan.js <level.eelvl|.json|job id> [--seconds=300] [--workers=2] [--gpu=1] [--stdin=1] [--first=1] [--out=dir]');
	const file = a._[0];
	const L = levelOf(file);
	const name = String(L.world_name || L.name || path.basename(String(file)).replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'level';
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
	const out = a.out ? path.resolve(a.out) : a.work ? path.join(path.resolve(a.work), 'run') : path.join(__dirname, 'out', 'n4plan', 'runs', `${name}_${stamp}`);
	let gpu = null;
	if (a.gpu === '1') {
		const G = require('./gpu.js');
		const tool = a.tool || G.nativeTool();
		if (!tool) throw new Error('--gpu=1: no GPU tool (node tools/build-native.js, or --tool=)');
		gpu = { tool, pausefile: a.pausefile || '', work: a.work ? path.resolve(a.work) : out, cacheArgs: a.cachedir ? [`--cachedir=${a.cachedir}`] : G.cacheArgs(), allowed: () => true };
	}
	let stdinLines = null;
	if (a.stdin === '1') {
		const rl = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
		stdinLines = rl;
	}
	const emit = T.emitter(process.stdout);
	const opts = { file: path.resolve(String(file)), seconds: +a.seconds || 300, workers: +a.workers || 2, seed: Number.isFinite(+a.seed) ? +a.seed : 1, gpu, steer: a.steer || null,
		first: a.first === '1', stallS: +a.stallS || 0, depth: +a.depth || 0, out, stdinLines, stopOnStdinEnd: true, verbose: a.verbose === '1' };
	// (tests: a module of mock parts, --parts=<file.js> exporting {compileModel, createFacts, createPlanner, createExecutor, createPrims})
	if (a.parts) opts.parts = require(path.resolve(a.parts));
	if (a.stallWindowS) opts.stallWindowS = +a.stallWindowS;
	if (a.watchMs) opts.watchMs = +a.watchMs;
	if (a.progressMs) opts.progressMs = +a.progressMs;
	const S = require('./plan/strategy.js');
	const r = await S.run(L, opts, emit);
	if (stdinLines) stdinLines.close();
	return r;
}
// (the end: stdout drained first, then out, whatever worker threads a part left)
const exitWith = (code) => { process.exitCode = code; try { process.stdout.write('', () => process.exit(code)); } catch (e) { process.exit(code); } };
main().then(() => exitWith(0), (e) => {
	try { process.stdout.write(JSON.stringify({ error: String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) }) + '\n'); } catch (e2) { /* closed */ }
	exitWith(1);
});
