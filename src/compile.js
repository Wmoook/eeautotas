'use strict';
// THE COMPILER (n4plan): .eelvl in -> a verified .eetas out, like a compiler turns source into machine code. No search, no
// GPU: the level model (its triggers, the doors they open), admissible bounds, an abstract plan (which trigger next, to
// the trophy), moves derived from the physics (exact motion primitives, exact branch and bound over engine states), a
// verify (the engine's own replay: it finishes) and a polish. It prints its stages like a compiler, with their times:
//   parse    0.02 s  cold_world.eelvl 400x200, md5 ...
//   model    0.84 s  12 triggers, 5 features, 34 gates
//   bounds   0.10 s  lower bound 3,210 ticks from the start
//   plan     0.05 s  8 steps: blue coin (98,207) -> ... -> trophy
//   moves   22.40 s  8 legs (prims 5, exact 2 (2 proven), leg 1), 3 re-plans, ...
//   verify   0.10 s  finishes: 1:02.34 (6,234 run ticks), 0 deaths
//   polish   4.10 s  -112 ticks
//   result   6,122 run ticks (1:01.22); lower bound 3,210 (gap 2,912 = 47.6%); proven legs 2 of 8; best known 5,480 (job 'X')
//   wrote    <out file>
//   node src/compile.js <level.eelvl | level.json | job id> [--out=<file.eetas>] [--seconds=60] [--workers=N] [--json]
//       [--report=<file.json>] [--quiet] [--verbose] [--known=0] [--seed=1] [--first=1] [--polish=0] [--stallS=0] [--joins=<s>]
//       [--parts=<module of mock parts: tests>]
//   --out: default <level name>.eetas next to the level (src/out/compile/<name>.eetas for a job id); --json: the compile
//   loop's events as JSON lines (src/plan/strategy.js), then {"ev":"report", ...}; --report: the report as a JSON file.
//   Exit codes: 0 = routed, the .eetas written (the evaluated inputs, cut at the finish) and read back to the same finish;
//   2 = no route (the report says why and where it stalled); 1 = an error.
// The eeo-tas line to play it: /loadtas <the .eetas file>, then /reset and /playtas (CLAUDE.md section 1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function parse(argv) {
	const a = { _: [] };
	for (const s of argv) {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		if (m) a[m[1]] = m[2] === undefined ? '1' : m[2];
		else a._.push(s);
	}
	return a;
}
// The hard watchdog (a worker thread: it runs while this thread is blocked in a part's synchronous call). Past its
// limit it prints why (the budget, the last stage and step this thread passed it) and ends the process (exit 1).
const WATCHDOG_MIN_S = 30, WATCHDOG_F = 0.5;
const JOINS_MAX_S = 60, JOINS_F = 0.5, LOOPS_MAX_S = 10, ENDGAME_MAX_S = 60, ENDGAME_F = 0.2;
// (the watchdog thread's code: its own isolate, so it runs while the compile's thread is blocked)
function watchdogThread() {
	const { parentPort, workerData } = require('worker_threads');
	const fs = require('fs');
	let last = null;
	parentPort.on('message', (m) => { if (m && m.stop) process.exit(0); else last = m; });
	setTimeout(() => {
		const at = !last ? 'before the first stage' : last.ev === 'stage' ? `after the stage ${last.name}`
			: `in the moves (the last ${last.ev} at ${last.sec || 0} s${last.label ? `: ${last.label}` : ''})`;
		const why = `the watchdog: the compile passed its hard limit of ${Math.round(workerData.ms / 1000)} s, blocked ${at} (a part's call that ignores its budget); the process ends`;
		try { fs.writeSync(1, workerData.json ? JSON.stringify({ ev: 'error', error: why, watchdog: true }) + '\n' : `error    ${why}\n`); } catch (e) { /* closed */ }
		try { process.kill(process.pid, 'SIGKILL'); } catch (e) { process.exit(1); }
	}, workerData.ms);
}
function watchdog(ms, json) {
	let W = null;
	try {
		const { Worker } = require('worker_threads');
		W = new Worker(`(${watchdogThread.toString()})();`, { eval: true, workerData: { ms, json } });
		W.unref();
		W.on('error', () => { W = null; });
	} catch (e) { W = null; }
	return {
		note(ev) { if (W) try { W.postMessage({ ev: ev.ev, name: ev.name, sec: ev.sec, label: ev.label || (ev.step && ev.step.label) || '' }); } catch (e) { /* gone */ } },
		stop() { if (W) { try { W.postMessage({ stop: true }); } catch (e) { /* gone */ } try { W.terminate(); } catch (e) { /* gone */ } W = null; } },
	};
}
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n));
const safe = (s) => String(s || 'level').replace(/[^\w .()-]/g, '').trim().slice(0, 60) || 'level';

/** the level of an argument: {L, file (the level file: its bytes' md5 matches the known routes), name, md5, what} */
function levelOf(arg) {
	const T = require('./plan/types.js');
	if (fs.existsSync(arg)) {
		const L = T.loadLevelFile(arg);
		const buf = fs.readFileSync(arg);
		return { L, file: path.resolve(arg), name: String(L.world_name || L.name || path.basename(arg).replace(/\.[^.]+$/, '')), md5: crypto.createHash('md5').update(buf).digest('hex'), job: null };
	}
	if (/\.(eelvl|json)$/i.test(String(arg))) throw new Error(`no such level file: ${arg}`);
	// (a job id or part of its name: the job's level JSON (its start mode), its original.eelvl for the md5)
	const J = require('./jobs.js');
	const id = J.resolve(arg);
	const L = J.loadJobLevel(id);
	const lf = path.join(J.jobDir(id), 'original.eelvl');
	let name = id, md5 = null;
	try { name = JSON.parse(fs.readFileSync(path.join(J.jobDir(id), 'meta.json'), 'utf8')).name || id; } catch (e) { /* the id */ }
	try { md5 = crypto.createHash('md5').update(fs.readFileSync(lf)).digest('hex'); } catch (e) { md5 = null; }
	return { L, file: fs.existsSync(lf) ? lf : null, name, md5, job: id };
}

async function main() {
	// THE AIR JUMPS (n5 lane 3): the compiler's reach fields on a level whose only effect tiles are multijumps are the
	// physics model with an air jump anywhere (reach.js EEAT_AIRJUMP), not the gravity-blind walk; set before any worker
	// thread or child process starts (they copy the environment); EEAT_AIRJUMP=0: off, the fields as before
	if (process.env.EEAT_AIRJUMP === undefined) process.env.EEAT_AIRJUMP = '1';
	// THE DOCTORS' DEFAULTS (src/plan/defaults.js: the cover, the crumbs, the field memo, any member, no toggle-back, the
	// plain-ball / effect-state fields, the local ice rise, the protection layer; each =0 off; EEAT_COMPILER_DEFAULTS=0 none)
	require('./plan/defaults.js').apply();
	const a = parse(process.argv.slice(2));
	if (!a._.length) {
		process.stdout.write('usage: node src/compile.js <level.eelvl | level.json | job id> [--out=<file.eetas>] [--seconds=60] [--workers=N] [--json] [--report=<file.json>] [--quiet]\n');
		return 1;
	}
	const json = a.json === '1', quiet = a.quiet === '1', verbose = a.verbose === '1';
	const line = (s) => { if (!json) process.stdout.write(s + '\n'); };
	const row = (name, ms, text) => line(`${name.padEnd(8)}${ms === null ? '        ' : `${(ms / 1000).toFixed(2).padStart(6)} s`}  ${text}`);
	const T = require('./plan/types.js');
	const C = require('./common.js');
	const S = require('./plan/strategy.js');
	const emitJ = T.emitter(process.stdout);
	const t0 = Date.now();
	const lv = levelOf(a._[0]);
	const parseMs = Date.now() - t0;
	const L = lv.L;
	const out = a.out ? path.resolve(a.out) : lv.job ? path.join(__dirname, 'out', 'compile', `${safe(lv.name)}.eetas`)
		: path.join(path.dirname(lv.file), `${path.basename(lv.file).replace(/\.[^.]+$/, '')}.eetas`);
	const parseText = `${lv.job ? `job ${lv.job}` : path.basename(lv.file)} ${L.width}x${L.height}${lv.md5 ? `, md5 ${lv.md5}` : ''}${lv.name && lv.name !== path.basename(lv.file || '') ? ` ("${lv.name}")` : ''}`;
	if (json) emitJ({ ev: 'stage', name: 'parse', ms: parseMs, text: parseText, t: 0 });
	else if (!quiet) row('parse', parseMs, parseText);
	const seconds = +a.seconds > 0 ? +a.seconds : 60;
	const workers = +a.workers > 0 ? Math.round(+a.workers) : Math.max(1, Math.min(8, (os.cpus().length || 2) - 1));
	let lastProg = 0;
	const emit = (ev) => {
		if (json) { emitJ(ev); return; }
		if (quiet) return;
		if (ev.ev === 'stage') row(ev.name, ev.ms, ev.text);
		else if (ev.ev === 'warning') row('note', null, ev.text);
		else if (ev.ev === 'stall') row('stall', null, ev.why);
		else if (verbose && ev.ev === 'progress' && Date.now() - lastProg >= 5000) { lastProg = Date.now(); row('...', ev.sec * 1000, ev.detail); }
		else if (verbose && ev.ev === 'bug') row('bug', null, `${ev.what}: ${ev.why || ev.error || ev.label || ''}`);
	};
	// (the hard watchdog: a part that blocks this thread past the budget (a synchronous call that ignores its own budget) is
	// not cut by the loop's clocks; a worker thread then prints why, with the last stage and event this thread passed it,
	// and ends the process: never a compile that hangs)
	// (the JOINS stage, src/plan/joins.js: its own clock after the budget; --joins=<s> or EEAT_JOINS_S, default half the
	// budget (at most 60 s); EEAT_JOINS=0 or --joins=0: off)
	const joinsS = process.env.EEAT_JOINS === '0' ? 0 : a.joins !== undefined ? Math.max(0, +a.joins || 0) : process.env.EEAT_JOINS_S !== undefined && process.env.EEAT_JOINS_S !== '' && +process.env.EEAT_JOINS_S >= 0 ? +process.env.EEAT_JOINS_S : Math.min(JOINS_MAX_S, JOINS_F * seconds);
	// (n5-perfect LOOPS: the polish's loop pass alone after the budget, strategy.js; --loops=<s> / EEAT_LOOPS_S, default a
	// sixth of the budget, at most LOOPS_MAX_S; EEAT_POLISH_LOOPS=0 / EEAT_PERFECT=0: off)
	const loopsS = process.env.EEAT_POLISH_LOOPS === '0' || process.env.EEAT_PERFECT === '0' ? 0 : a.loops !== undefined ? Math.max(0, +a.loops || 0) : process.env.EEAT_LOOPS_S !== undefined && process.env.EEAT_LOOPS_S !== '' && +process.env.EEAT_LOOPS_S >= 0 ? +process.env.EEAT_LOOPS_S : Math.min(LOOPS_MAX_S, seconds / 6);
	// (C6 lane 5 THE ENDGAME, strategy.js: the exact endgame ladder on the finished route after the joins, its own clock;
	// DEFAULT ON since C6 lane 5 block 4: a fifth of the budget, at most ENDGAME_MAX_S (60 s at 300 s); --endgame=<s> /
	// EEAT_ENDGAME_S=<s> its clock; EEAT_ENDGAME=0, --endgame=0 or EEAT_ENDGAME_S=0: off, the compile byte for byte as
	// before. It runs only on a found route, after the budget, and its route is kept only when the engine replays it faster
	// with no more deaths and no lower chance: it cannot lose a compile or slow a route)
	const endgameS = process.env.EEAT_ENDGAME === '0' ? 0 : a.endgame !== undefined ? Math.max(0, +a.endgame || 0) : process.env.EEAT_ENDGAME_S !== undefined && process.env.EEAT_ENDGAME_S !== '' ? Math.max(0, +process.env.EEAT_ENDGAME_S || 0) : Math.min(ENDGAME_MAX_S, ENDGAME_F * seconds);
	const wdS = +process.env.EEAT_COMPILE_WATCHDOG_S > 0 ? +process.env.EEAT_COMPILE_WATCHDOG_S : seconds + Math.max(WATCHDOG_MIN_S, WATCHDOG_F * seconds) + joinsS + loopsS + endgameS;
	const wd = watchdog(wdS * 1000, json);
	const emit0 = emit;
	const emitW = (ev) => { if (ev.ev === 'stage' || ev.ev === 'step' || ev.ev === 'plan') wd.note(ev); emit0(ev); };
	const opts = { file: lv.file || undefined, md5: lv.md5 || undefined, seconds, workers, seed: Number.isFinite(+a.seed) ? +a.seed : 1, first: a.first === '1', polish: a.polish !== '0',
		stallS: +a.stallS || 0, parseMs, known: a.known === '0' ? false : undefined, joinsS, loopsS, ...(endgameS > 0 ? { endgameS } : {}) };
	if (a.inflight) opts.inflight = +a.inflight;
	if (a.parts) opts.parts = path.resolve(a.parts);
	if (a.runOut) opts.out = path.resolve(a.runOut);
	let r;
	try { r = await S.compile(L, opts, emitW); } finally { wd.stop(); }
	// ---- the .eetas: the evaluated inputs (cut at the finish), written and read back to the same finish
	let wrote = '', verified = null;
	if (r.ok && r.masks) {
		const ev = C.evaluate(L, r.masks);
		if (!ev) throw new Error('the compiled route does not finish on its replay (a bug in the compiler)');
		fs.mkdirSync(path.dirname(out), { recursive: true });
		C.writeEetas(out, ev.ms);
		const back = C.evaluate(L, C.readEetas(out));
		if (!back || back.runTicks !== ev.runTicks || back.complete !== ev.complete) throw new Error(`the written ${out} does not replay to the same finish`);
		wrote = out;
		verified = { runTicks: back.runTicks, ticks: back.complete, deaths: back.deaths, chance: back.chance };
	}
	const proven = (r.legs || []).filter((g) => g.proven).length;
	// (the math tier's share of the route's legs, the proofs by what proved them (the math's plain certificate / event-graph
	// bound, the exact search), the executor's math numbers and the PATTERNS: the legs the search tiers found)
	const legsR = r.legs || [];
	const provenBy = {};
	for (const g of legsR) if (g.proven) { const b = g.provenBy || (String(g.tool || '').includes('exact') ? 'exact' : 'search'); provenBy[b] = (provenBy[b] || 0) + 1; }
	const mathLegs = legsR.filter((g) => String(g.tool || '').startsWith('math')).length;
	const ex = r.exec || null;
	const math = { on: ex && ex.math ? !!ex.math.on : process.env.EEAT_MATH !== '0', legs: mathLegs, provenBy, exec: ex ? ex.math || null : null, byTool: ex ? ex.byTool || null : null,
		patternsN: ex ? ex.patternsN || 0 : 0 };
	const ratio = r.ok && r.known && r.known.runTicks > 0 ? Math.round((r.runTicks / r.known.runTicks) * 1000) / 1000 : null;
	const report = { level: lv.name, file: lv.file, job: lv.job, md5: lv.md5, ok: !!r.ok, end: r.end, sec: Math.round((Date.now() - t0) / 100) / 10, seconds, workers,
		runTicks: r.runTicks, time: r.ok ? C.fmt(r.runTicks) : null, ticks: r.ticks, deaths: r.deaths, chance: r.chance, lb: r.lb, lbComplete: !!r.lbComplete, lbProof: r.lbProof || '', gap: r.gap,
		gapPct: r.ok && r.runTicks > 0 ? Math.round((r.gap / r.runTicks) * 1000) / 10 : null, legs: r.legs || [], provenLegs: proven, stages: Object.assign({}, r.stages, { parse: parseMs }),
		known: r.known || null, ratio, why: r.why || '', steps: r.steps, anchors: r.anchors, bugs: r.bugs, deepenings: r.deepenings, stalls: r.stalls, relayRuns: r.relayRuns, relaySet: r.relaySet, relayDrop: r.relayDrop, out: wrote || null, verified,
		loadtas: wrote ? `/loadtas ${wrote}` : null, inputs: r.ok ? T.strOf(r.masks) : null, math, patterns: ex && Array.isArray(ex.patterns) ? ex.patterns : [], perfect: r.perfect || null, joins: r.joins || null, ...(r.endgame ? { endgame: r.endgame } : {}), ...(r.stretch ? { stretch: r.stretch } : {}), ...(r.hybrid ? { hybrid: r.hybrid } : {}),
		...(r.oneshot !== undefined ? { oneshot: r.oneshot } : {}) };
	if (a.report) { fs.mkdirSync(path.dirname(path.resolve(a.report)), { recursive: true }); fs.writeFileSync(path.resolve(a.report), JSON.stringify(report, null, 1)); }
	if (json) emitJ(Object.assign({ ev: 'report' }, report));
	else if (r.ok) {
		row('result', null, `${num(r.runTicks)} run ticks (${C.fmt(r.runTicks)}); lower bound ${num(r.lb)} (gap ${num(r.gap)} = ${report.gapPct}%${r.lbProof ? `: PROVEN OPTIMAL, ${r.lbProof}` : ''}); proven legs ${proven} of ${(r.legs || []).length}${Object.keys(provenBy).length ? ` (${Object.entries(provenBy).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; math legs ${mathLegs}` +
			(r.known ? `; best known ${num(r.known.runTicks)} (${r.known.source}; ratio ${ratio})` : '; best known: none'));
		row('wrote', null, `${wrote}  (eeo-tas: /loadtas ${wrote}, /reset, /playtas)`);
	} else row('result', null, r.why || `no route (end ${r.end})`);
	return r.ok ? 0 : 2;
}

// (the end: stdout drained first, then out, whatever worker threads a part left)
const exitWith = (code) => { process.exitCode = code; try { process.stdout.write('', () => process.exit(code)); } catch (e) { process.exit(code); } };
if (require.main === module) {
	// (a ref'd keep-alive until main settles: the executor's workers and most timers are unref'd, so a part awaiting only
	// them left the event loop empty and the process ended with code 0 and no output (a verified route never written: Fish
	// Gods, box 3, lane 4 b4); the hard watchdog still ends a real hang)
	const keep = setInterval(() => {}, 1 << 30);
	main().then((code) => { clearInterval(keep); exitWith(code); }, (e) => {
		clearInterval(keep);
		const msg = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
		try { if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ error: msg }) + '\n'); else process.stdout.write(`error    ${msg}\n`); } catch (e2) { /* closed */ }
		exitWith(1);
	});
}
module.exports = { levelOf, watchdog, WATCHDOG_MIN_S, WATCHDOG_F };
