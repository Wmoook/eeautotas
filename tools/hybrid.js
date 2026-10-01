'use strict';
// THE HYBRID (n5-hy-race): the compiler (src/compile.js: fast routes, often near the optimum, no search) and the search
// product (src/autotas.js: Find a route, then a job and its optimizer, the grind, with the GPU) side by side on one level,
// a RACE to the first verified route, then the rest of the budget spent improving it.
//   node tools/hybrid.js <level.eelvl> [--seconds=600] [--out=<dir>] [--gpu=<id>] [--cworkers=3] [--sworkers=4]
//        [--pworkers=2] [--stallS=60] [--hint=1] [--feed=1] [--bound=1] [--joins=1] [--cseconds=<the compiler's budget>]
//        [--seed=1] [--name=<label>] [--keep=0] [--quiet=0] [--leg=1] [--polishS=0] [--stallStopS=0]
// - THE LEG (n5-hy-best, --leg=1 by default): the compiler child runs with EEAT_HYBRID=1 (src/plan/hybrid.js: a leg the
//   executor failed goes to goexplore --goalTiles from the anchor's state); --leg=0: the compiler alone, as n5-hy-race.
// - THE EARLY STOPS (the measurement, n5-hy-best; 0 = off, the run to --seconds): --polishS=<s>: the first verified route,
//   then that many seconds of polish, then the end (the compiler, with a route of its own, gets 'stop' 75 s before it: its
//   stages after the moves polish its route); --stallStopS=<s>: no route yet and no progress for that long (no new furthest
//   compiler anchor (a higher gain, or the same gain 3 tiles nearer), no search attempt a tile nearer the trophy, no new
//   room that opens territory, no more coins / switches on the search's progress front): the end. hybrid.json's stop:
//   {why: 'polish' | 'stall' | 'cap' | <signal>, t}.
// - The compiler: its own child process (--json --stdin=1 --sourceDist=1), its budget fitted so that its stages after the
//   moves (joins, loops, endgame: compile.js) end before the hybrid's (--cseconds). Every route it announces ('result') is
//   replayed here (common.js evaluate on the level file, the loader of tools/cmp/verify.js) before it counts.
// - The search: AutoTASer.run in this process (its own EEAT_HOME in TMPDIR, like src/out/lab/atrun.js): Find a route on
//   --sworkers CPU workers and the GPU, a job at its first route, the grind with the GPU searcher.
// - THE STALL HAND-OVER (--hint=1): no route yet and the compiler made no progress (a new furthest anchor: a higher gain,
//   or the same gain at least 3 tiles nearer the trophy) for --stallS: its furthest anchor's inputs go to the search
//   (editor.js hint: into the CPU search's archive, and where the stall escape runs (coarse cells) the next escape, a fresh
//   one search with GPU bursts, starts from there at once); where the level has no escape (fine cells), a search of our
//   own from that prefix (src/goexplore.js --prefix, CPU, --pworkers). A newer furthest anchor that stalls is handed again.
//   The compiler ended without a route, none known and a minute left: its CPU share (--cworkers) to a prefix search of
//   our own from its furthest anchor.
// - THE FEED BACK (--feed=1): while the compiler is stalled and no route exists, the search's nearest attempt goes to the
//   compiler (its stdin "import": a model state it has not seen becomes an anchor it plans from), at most every 20 s,
//   each one nearer than the last by a tile.
// - THE FIRST ROUTE (either side, verified): the prefix search stops; a compiler route goes to the search's AutoTASer
//   (autotas.js outside: the job's base when there is none yet, so the optimizer starts on it at once; else the job's
//   inbox); every faster route or job best bounds the compiler's branch and bound (stdin "route", --bound=1).
// - THE POLISH: the grind on the job (the product's optimizer: mutate, endgame, sweep, the GPU searcher) all the way; the
//   compiler's own perfect pass (joins, loops, endgame) on its route; once the compiler has ended and >= 45 s are left,
//   the compiler's JOINS (tools/perfect/joins.js, plan/joins.js joinRoute) on the best route so far (--joins=1), its
//   result to the job.
// - THE END (--seconds after the start): the AutoTASer stops (the grind paused, its best replayed), the children end,
//   the best verified route of all (the job's best, the compiler's, every route seen) is written to <out>/best.eetas,
//   read back and replayed once more; <out>/hybrid.json says who routed first and when, every route, the hand-overs, the
//   ticks of the first route and after the polish. Exit 0: routed; 2: no route; 1: an error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const argv = process.argv.slice(2);
const opt = {}, pos = [];
for (const a of argv) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? '1' : m[2]; else pos.push(a); }
if (!pos.length) { console.log('usage: node tools/hybrid.js <level.eelvl> [--seconds=600] [--out=<dir>] [--gpu=<id>] [--cworkers=3] [--sworkers=4] [--stallS=60]'); process.exit(1); }
const on = (k, d) => (opt[k] === undefined ? d : opt[k] !== '0');
const LEVEL = path.resolve(pos[0]);
const NAME = opt.name || path.basename(LEVEL).replace(/\.[^.]+$/, '');
const SECONDS = Math.max(30, +(opt.seconds || 600));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(opt.out || path.join(SRC, 'out', 'hybrid', NAME));
const CW = Math.max(1, +(opt.cworkers || 3)), SW = Math.max(1, +(opt.sworkers || 4)), PW = Math.max(1, +(opt.pworkers || 2));
const STALL_S = Math.max(5, +(opt.stallS || 60));
const HINT = on('hint', true), FEED = on('feed', true), BOUND = on('bound', true), JOINS = on('joins', true);
const QUIET = on('quiet', false);
const LEG = on('leg', true);
const POLISH_S = Math.max(0, +(opt.polishS || 0)), STALL_STOP_S = Math.max(0, +(opt.stallStopS || 0));
// the compiler's budget: its moves' seconds S, its stages after them (compile.js: joins min(60, S/2), loops min(10, S/6),
// endgame min(60, S/5)) ending 15 s before the hybrid's end
const tailOf = (s) => Math.min(60, 0.5 * s) + Math.min(10, s / 6) + Math.min(60, 0.2 * s);
let CSECONDS = +opt.cseconds > 0 ? +opt.cseconds : SECONDS;
if (!(+opt.cseconds > 0)) while (CSECONDS > 10 && CSECONDS + tailOf(CSECONDS) > SECONDS - 15) CSECONDS--;
if (opt.gpu !== undefined && opt.gpu !== '') process.env.CUDA_VISIBLE_DEVICES = String(opt.gpu);
fs.mkdirSync(OUT, { recursive: true });
// (a home of its own for the job and the editor's files, as atrun.js: its data/gpu-cache linked to this checkout's)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-hy-'));
process.env.EEAT_HOME = HOME;
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
const CACHE = path.join(SRC, 'data', 'gpu-cache');
try { fs.mkdirSync(CACHE, { recursive: true }); fs.symlinkSync(CACHE, path.join(HOME, 'data', 'gpu-cache'), 'dir'); } catch (e) { /* own */ }
if (!process.env.CUDA_CACHE_PATH) process.env.CUDA_CACHE_PATH = CACHE;
const C = require(path.join(SRC, 'common.js'));
const T = require(path.join(SRC, 'plan', 'types.js'));
const ED = require(path.join(SRC, 'editor.js'));
const J = require(path.join(SRC, 'jobs.js'));
const AT = require(path.join(SRC, 'autotas.js'));

const T0 = Date.now(), END0 = T0 + SECONDS * 1000;
let END = END0;   // (--polishS: the first route's time + polishS, when sooner)
let progAt = T0, progWhy = 'the start';   // (--stallStopS: the last progress of either side)
const progress = (why) => { progAt = Date.now(); progWhy = why; };
const sec = () => Math.round((Date.now() - T0) / 100) / 10;
const logF = path.join(OUT, 'hybrid.log');
const log = (s) => { const l = `[hy ${sec().toFixed(1).padStart(6)}s] ${s}`; if (!QUIET) console.log(l); try { fs.appendFileSync(logF, l + '\n'); } catch (e) { /* read-only */ } };
const L = T.loadLevelFile(LEVEL);
const buf = fs.readFileSync(LEVEL);

// ---- the report
const R = { level: NAME, file: LEVEL, seconds: SECONDS, cseconds: CSECONDS, gpu: opt.gpu !== undefined ? String(opt.gpu) : null, host: os.hostname(),
	workers: { compiler: CW, search: SW, prefix: PW }, stallS: STALL_S, flags: { hint: HINT, feed: FEED, bound: BOUND, joins: JOINS, leg: LEG }, polishS: POLISH_S, stallStopS: STALL_STOP_S,
	started: new Date(T0).toISOString(), stop: null, lastProgress: null,
	first: null, routes: [], best: null, final: null, polish: null,
	compiler: { firstRoute: null, routes: 0, anchors: 0, maxGain: 0, furthest: null, stalls: 0, imports: 0, stages: [], end: null, exit: null, report: null },
	search: { firstRoute: null, job: null, jobFrom: null, handoff: null, bests: [], end: null, nearest: null },
	hints: [], feeds: [], prefix: [], joins: null, errors: [] };
const writeReport = () => { R.updated = new Date().toISOString(); R.sec = sec(); try { fs.writeFileSync(path.join(OUT, 'hybrid.json'), JSON.stringify(R, null, 1)); } catch (e) { /* next */ } };

// ---- the routes: every one replayed from the level file before it counts
let best = null;          // {by, runTicks, ms, t}
// (by: 'compiler', 'search' (Find a route), 'optimizer' (the job's best: the grind), 'prefix' (our own prefix search),
// 'joins' (the joins on the best); the routes found outside the search go to its job)
const OUTSIDE = new Set(['compiler', 'prefix', 'joins']);
let ctl = null, atEnded = false, ending = false;
const strOf = (ms) => T.strOf(ms);
function route(by, masks, how) {
	let ev = null;
	try { ev = C.evaluate(L, masks); } catch (e) { ev = null; }
	if (!ev) { R.routes.push({ t: sec(), by, verified: false, how: how || null }); log(`${by}: a route that does not replay (dropped)`); return null; }
	const rec = { t: sec(), by, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, verified: true, ...(how ? { how } : {}) };
	R.routes.push(rec);
	const faster = !best || ev.runTicks < best.runTicks;
	if (faster) {
		best = { by, runTicks: ev.runTicks, ms: ev.ms, t: rec.t };
		R.best = { by, runTicks: ev.runTicks, t: rec.t };
		try { C.writeEetas(path.join(OUT, 'best.eetas'), ev.ms); } catch (e) { /* at the end */ }
	}
	if (!R.first) {
		R.first = { by, t: rec.t, runTicks: ev.runTicks };
		log(`FIRST ROUTE by ${by}: ${ev.runTicks} run ticks (${C.fmt(ev.runTicks)}) after ${rec.t} s${how ? ` (${how})` : ''}`);
		if (POLISH_S > 0 && !ending) { END = Math.min(END, Date.now() + POLISH_S * 1000); log(`the polish: ${POLISH_S} s, the end at ${((END - T0) / 1000).toFixed(1)} s`); }
		prefixStop('a route exists');
	} else if (faster) log(`${by}: ${ev.runTicks} run ticks (best so far)${how ? ` (${how})` : ''}`);
	// a route from outside the search (the compiler's, the prefix search's, the joins'): to the AutoTASer (the job's
	// base, else its inbox)
	if (OUTSIDE.has(by) && !ending) toJob(ev.ms, `hybrid: ${by}${how ? ` (${how})` : ''}`);
	if (faster && by !== 'compiler') boundCompiler(ev.ms);
	if (faster && finalized) { finalize(); log(`after the end: the final is now ${ev.runTicks} by ${by}`); }
	writeReport();
	return ev;
}
let ownJob = null;   // (the AutoTASer ended without a job (Find a route ended): a job of our own for a later route)
let ownJobFailed = false;   // (its import refused the route (jobs.importJob: e.g. random portals no exit combination of which finishes): not again)
function toJob(ms, source) {
	try {
		const r = ctl && !atEnded ? ctl.outside(ms, source) : null;
		if (r) { if (!R.search.job) { R.search.job = r.job; R.search.jobFrom = source; } return; }
	} catch (e) { R.errors.push(`outside: ${e.message}`); }
	// (the AutoTASer's own import of a route failed the same way: jobs.importJob's random-portal analysis can take minutes
	// in this thread (Pretty How Town: 131 s) and refuses again)
	if (ownJobFailed || (R.search.end && /could not be made a job/.test(String(R.search.end.why || '')))) return;
	if (Date.now() > END - 20e3) return;
	try {
		if (!ownJob) {
			const meta = J.importJob({ eelvl: buf, eetas: Buffer.from(C.eetasBytes(ms)), name: NAME, eelvlName: `${NAME}.eelvl`, eetasName: 'route.eetas', startMode: 'reset' });
			ownJob = meta.id;
			const G = require(path.join(SRC, 'gpu.js'));
			const ch = J.startJob(ownJob, SW, { gpu: !!G.nativeTool() && !G.unsupported(J.loadJobLevel(ownJob)) });
			guardGrind(ch && ch.pid);
			R.search.job = ownJob; R.search.jobFrom = `${source} (the hybrid's own job: the AutoTASer had ended)`;
			log(`a job of our own from ${source}: ${ownJob}`);
		} else J.tryCandidate(ownJob, C.eetasBytes(ms), { source, wait: 0 }).catch(() => {});
	} catch (e) { R.errors.push(`own job: ${e.message}`); ownJobFailed = true; }
}
function guardGrind(pid) {
	if (!pid || process.platform === 'win32') return;
	const g = spawn('sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 3; done; kill -TERM -- -${pid} 2>/dev/null; exit 0`], { detached: true, stdio: 'ignore' });
	g.unref();
}

// ---- the compiler
let comp = null, compAlive = false, lastProgAt = Date.now(), furthest = null, lastBoundTicks = Infinity;
const anchors = new Map();
const compEv = fs.createWriteStream(path.join(OUT, 'compile_events.jsonl'));
function compSend(line) { if (compAlive && comp && comp.stdin && !comp.stdin.destroyed) { try { comp.stdin.write(line + '\n'); return true; } catch (e) { /* gone */ } } return false; }
function boundCompiler(ms) {
	if (!BOUND || !compAlive) return;
	const ev = C.evaluate(L, ms);
	if (!ev || ev.runTicks >= lastBoundTicks) return;
	if (compSend(`route ${strOf(ev.ms)}`)) lastBoundTicks = ev.runTicks;
}
function compStart() {
	const args = [path.join(SRC, 'compile.js'), LEVEL, `--seconds=${CSECONDS}`, `--workers=${CW}`, '--json', '--stdin=1', '--sourceDist=1',
		`--out=${path.join(OUT, 'compile.eetas')}`, `--report=${path.join(OUT, 'compile.json')}`];
	const env = Object.assign({}, process.env);
	if (LEG) env.EEAT_HYBRID = '1'; else delete env.EEAT_HYBRID;
	comp = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', fs.openSync(path.join(OUT, 'compile.err'), 'w')] });
	compAlive = true;
	comp.stdin.on('error', () => { /* ended */ });
	const rl = readline.createInterface({ input: comp.stdout, crlfDelay: Infinity });
	rl.on('line', (line) => { let e; try { e = JSON.parse(line); } catch (x) { return; } try { compOn(e); } catch (x) { R.errors.push(`compiler event: ${x.message}`); } });
	comp.on('exit', (code, sig) => {
		compAlive = false;
		R.compiler.exit = code != null ? code : sig;
		R.compiler.endAt = sec();
		try { R.compiler.report = compactReport(JSON.parse(fs.readFileSync(path.join(OUT, 'compile.json'), 'utf8'))); } catch (e) { /* none */ }
		// (the written route, replayed: the compiler's final, after its perfect pass)
		try { const ms = C.readEetas(path.join(OUT, 'compile.eetas')); const ev = C.evaluate(L, ms); if (ev && (!best || ev.runTicks < best.runTicks)) route('compiler', ms, 'its written route'); } catch (e) { /* none */ }
		log(`the compiler ended (exit ${R.compiler.exit}${R.compiler.report ? `, ${R.compiler.report.ok ? `${R.compiler.report.runTicks} run ticks` : R.compiler.report.why || 'no route'}` : ''})`);
		try { compEv.end(); } catch (e) { /* closed */ }
		writeReport();
	});
	log(`the compiler: --seconds=${CSECONDS} --workers=${CW} (pid ${comp.pid})`);
}
function compactReport(r) {
	const cut = (x) => { if (x == null || typeof x !== 'object') return x == null ? null : x; const o = {}; for (const [k, v] of Object.entries(x)) if (v === null || typeof v !== 'object') o[k] = v; return o; };
	return { ok: r.ok, end: r.end, sec: r.sec, runTicks: r.runTicks, lb: r.lb, why: r.why ? String(r.why).slice(0, 300) : '', stages: r.stages, known: cut(r.known),
		perfect: cut(r.perfect), joins: cut(r.joins), endgame: cut(r.endgame), steps: r.steps, anchors: r.anchors };
}
function compOn(e) {
	if (e.ev === 'source' && typeof e.inputs === 'string' && e.inputs.length) {
		R.compiler.anchors++;
		const a = { id: e.anchor, gain: Number.isFinite(+e.again) ? +e.again : 0, dist: Number.isFinite(+e.dist) ? +e.dist : Infinity, tick: e.tick, desc: e.desc || '', inputs: e.inputs, t: sec() };
		anchors.set(a.id, a);
		const f = furthest;
		const ahead = !f || a.gain > f.gain || (a.gain === f.gain && a.dist < f.dist - 3);
		if (a.gain > R.compiler.maxGain) R.compiler.maxGain = a.gain;
		if (ahead) {
			furthest = a;
			lastProgAt = Date.now();
			progress(`the compiler's anchor ${a.id} (gain ${a.gain})`);
			R.compiler.furthest = { id: a.id, gain: a.gain, dist: a.dist, tick: a.tick, desc: a.desc, t: a.t };
		}
		compEv.write(JSON.stringify({ t: sec(), ev: 'source', anchor: a.id, gain: a.gain, dist: a.dist, tick: a.tick, desc: a.desc, ahead }) + '\n');
		return;
	}
	if (e.ev === 'result' && e.kind === 'finish' && typeof e.inputs === 'string') {
		const how = e.perfect ? 'perfect' : e.polish ? 'polish' : e.loops ? 'loops' : e.joins ? 'joins' : e.endgame ? 'endgame' : (e.how || 'moves');
		if (!R.compiler.firstRoute) R.compiler.firstRoute = { t: sec(), runTicks: e.runTicks };
		R.compiler.routes++;
		compEv.write(JSON.stringify({ t: sec(), ev: 'result', runTicks: e.runTicks, how }) + '\n');
		route('compiler', T.masksOf(e.inputs), String(how).slice(0, 80));
		return;
	}
	if (e.ev === 'import') R.compiler.imports++;
	if (e.ev === 'stage') R.compiler.stages.push([sec(), e.name, e.ms]);
	if (e.ev === 'stall') R.compiler.stalls++;
	if (e.ev === 'done') R.compiler.end = { end: e.end, sec: e.sec, anchors: e.anchors, runTicks: e.runTicks };
	if (e.ev === 'error') R.errors.push(`compiler: ${e.error}`);
	if (e.ev !== 'progress' && e.ev !== 'step' && e.ev !== 'bwlevel' && e.ev !== 'closest') {
		const o = Object.assign({}, e); if (typeof o.inputs === 'string') o.inputs = o.inputs.length;
		if (o.ev !== 'report') compEv.write(JSON.stringify(Object.assign({ t: sec() }, o)).slice(0, 2000) + '\n');
	}
}

// ---- the search's prefix search of our own (levels without the editor's stall escape)
let pre = null;
function prefixStart(a, workers, why) {
	prefixStop('a newer start');
	const left = Math.floor((END - Date.now()) / 1000) - 15;
	if (left < 20) return;
	const k = R.prefix.length + 1, file = path.join(OUT, `prefix_${k}.eetas`), w = workers || PW;
	C.writeEetas(file, T.masksOf(a.inputs));
	const args = [path.join(SRC, 'goexplore.js'), LEVEL, `--prefix=${file}`, `--seconds=${left}`, `--workers=${w}`, `--seed=${1000 + k}`, '--first=1',
		'--opts=1', '--frontier=1', '--fBrake=1', '--fPhys=1'];
	const ch = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
	const rec = { k, t: sec(), why: why || 'the compiler stalled', workers: w, anchor: a.id, gain: a.gain, ticks: a.inputs.length, desc: a.desc, nearest: null, routed: null, end: null };
	R.prefix.push(rec);
	pre = { ch, rec };
	const rl = readline.createInterface({ input: ch.stdout, crlfDelay: Infinity });
	rl.on('line', (line) => {
		let e; try { e = JSON.parse(line); } catch (x) { return; }
		if (e.ev === 'closest' && Number.isFinite(+e.dist)) rec.nearest = Math.round(+e.dist * 10) / 10;
		if (e.ev === 'result' && e.kind === 'finish' && e.inputs) {
			let ms = Uint8Array.from(String(e.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
			// (the whole route from the level's start; were it only the part after the prefix: the prefix first)
			if (!C.evaluate(L, ms)) { const p = T.masksOf(a.inputs), m2 = new Uint8Array(p.length + ms.length); m2.set(p); m2.set(ms, p.length); ms = m2; }
			rec.routed = sec();
			route('prefix', ms, `from the compiler's anchor ${a.id} (gain ${a.gain})`);
		}
	});
	ch.on('exit', (code) => { rec.end = sec(); rec.exit = code; if (pre && pre.ch === ch) pre = null; });
	log(`a prefix search of our own (${rec.why}) from the compiler's anchor ${a.id} (gain ${a.gain}, ${a.inputs.length} ticks, ${a.desc}): ${w} workers, ${left} s`);
}
function prefixStop(why) {
	if (!pre) return;
	try { pre.ch.kill('SIGTERM'); } catch (e) { /* gone */ }
	pre.rec.stopped = why;
	pre = null;
}

// ---- the joins on the best route (the compiler's perfect pass on any route)
let joinsCh = null;
function joinsStart() {
	if (!JOINS || R.joins || joinsCh || !best) return;
	const leftMs = END - Date.now() - 20e3;
	if (leftMs < 25e3) return;
	// (the best so far: the job's own best may be newer than the routes seen here)
	jobBestIn();
	const inF = path.join(OUT, 'joins_in.eetas'), outF = path.join(OUT, 'joins_out.eetas');
	C.writeEetas(inF, best.ms);
	try { fs.unlinkSync(outF); } catch (e) { /* none */ }
	const ms = Math.min(60e3, leftMs);
	R.joins = { t: sec(), from: best.by, before: best.runTicks, ms, after: null, saved: null };
	joinsCh = spawn(process.execPath, [path.join(ROOT, 'tools', 'perfect', 'joins.js'), LEVEL, inF, `--ms=${ms}`, `--out=${outF}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
	log(`the joins on the best route (${best.runTicks}, ${best.by}) for ${Math.round(ms / 1000)} s`);
	joinsCh.on('exit', () => {
		joinsCh = null;
		R.joins.end = sec();
		try {
			const m = C.readEetas(outF);
			const ev = route('joins', m, `on ${R.joins.from}'s ${R.joins.before}`);
			if (ev) { R.joins.after = ev.runTicks; R.joins.saved = R.joins.before - ev.runTicks; }
		} catch (e) { R.joins.after = R.joins.before; R.joins.saved = 0; }
		writeReport();
	});
}
/** the job's best.eetas, when it is faster than the best seen: a route of the search's optimizer */
function jobBestIn() {
	const id = R.search.job;
	if (!id) return;
	try {
		const ms = C.readEetas(path.join(J.jobDir(id), 'best.eetas'));
		const ev = C.evaluate(L, ms);
		if (ev && (!best || ev.runTicks < best.runTicks)) route('optimizer', ms, 'the job\'s best');
	} catch (e) { /* none yet */ }
}

// ---- the search: the AutoTASer in this process
let lastBestRead = 0;
function atStart() {
	ctl = AT.run({ eelvl: buf, minutes: SECONDS / 60, workers: SW, name: NAME, out: path.join(OUT, 'search'), seed: +(opt.seed || 1) || 1,
		onEvent: (e) => {
			try {
				if (e.ev === 'route' && e.verified) {
					if (!R.search.firstRoute) R.search.firstRoute = { t: e.t, runTicks: e.runTicks, strategy: e.strategy };
					const n = ctl ? ctl.state().routes : 0;
					setImmediate(() => {
						const f = path.join(OUT, 'search', `route_${n}_${e.runTicks}.eetas`);
						try { route('search', C.readEetas(f), `Find a route (${e.strategy || 'route'})`); } catch (x) { R.errors.push(`search route file: ${x.message}`); }
					});
				} else if (e.ev === 'job') {
					R.search.job = e.job; if (e.from) R.search.jobFrom = e.from; else R.search.jobFrom = R.search.jobFrom || 'Find a route';
					guardGrind(e.pid);
					log(`the job ${e.job} (${e.from || 'Find a route'}): ${e.runTicks} run ticks, the optimizer started`);
				} else if (e.ev === 'best') {
					R.search.bests.push([e.t, e.runTicks, String(e.what || '').slice(0, 60)]);
					if (Date.now() - lastBestRead > 10e3) { lastBestRead = Date.now(); setImmediate(jobBestIn); }
				} else if (e.ev === 'handoff') { R.search.handoff = { t: e.t, why: e.why }; log(`the search's handoff: ${e.why}`); }
				else if (e.ev === 'end') { R.search.end = { t: e.t, why: e.why, verified: e.verified }; atEnded = true; }
				else if (e.ev === 'outside') log(`to the search: ${e.source} ${e.runTicks}`);
				else if (e.ev === 'escape') R.search.escapes = (R.search.escapes || 0) + 1;
			} catch (x) { R.errors.push(`search event: ${x.message}`); }
		},
		onEnd: () => { atEnded = true; } });
	log(`the search: Find a route on ${SW} workers${process.env.CUDA_VISIBLE_DEVICES !== undefined ? `, GPU ${process.env.CUDA_VISIBLE_DEVICES}` : ''}`);
}

// ---- the loop: the stall hand-over, the feed back, the joins, the end
tick.progTiles = Infinity; tick.rooms = new Set(); tick.front = 0;
let lastHintAt = 0, hintedKey = null, lastFeedAt = 0, lastFedTiles = Infinity, compStopAt = 0;
function tick() {
	if (ending) return;
	const now = Date.now();
	let st = null;
	try { st = ED.state(); } catch (e) { st = null; }
	const c = st && st.closest;
	if (c && Number.isFinite(+c.tiles) && (!R.search.nearest || c.tiles < R.search.nearest.tiles)) R.search.nearest = { tiles: c.tiles, ticks: c.ticks, t: sec(), strategy: c.strategy };
	// (--stallStopS: the search's progress: a tile nearer, a new room that opens territory, more coins / switches on its front)
	if (c && Number.isFinite(+c.tiles) && +c.tiles <= tick.progTiles - 1) { tick.progTiles = +c.tiles; progress(`the search ${c.tiles} tiles from the trophy`); }
	if (st && Array.isArray(st.sources)) for (const s of st.sources) if (s && s.gain > 0 && !tick.rooms.has(s.room)) { tick.rooms.add(s.room); progress(`the search's room ${s.room}`); }
	const pf = st && st.progressFront;
	if (pf && (+pf.coins || 0) + (+pf.switches || 0) > tick.front) { tick.front = (+pf.coins || 0) + (+pf.switches || 0); progress(`the search's front ${pf.coins} coins / ${pf.switches} switches`); }
	if (!R.first && STALL_STOP_S > 0 && now - progAt >= STALL_STOP_S * 1000) { R.lastProgress = { t: Math.round((progAt - T0) / 100) / 10, why: progWhy }; finishAll('stall'); return; }
	const stalled = compAlive && now - lastProgAt >= STALL_S * 1000;
	if (!R.first && HINT && stalled && furthest && furthest.gain >= 1 && furthest.id !== hintedKey && now - lastHintAt >= 30e3 && now < END - 45e3) {
		const a = furthest;
		hintedKey = a.id; lastHintAt = now;
		let r = { fed: false, escape: false };
		const what = `the compiler's furthest anchor ${a.id} (gain ${a.gain}${a.desc ? `, ${a.desc}` : ''})`;
		try { r = ED.hint(a.inputs, what) || r; } catch (e) { R.errors.push(`hint: ${e.message}`); }
		R.hints.push({ t: sec(), anchor: a.id, gain: a.gain, dist: Number.isFinite(a.dist) ? a.dist : null, ticks: a.inputs.length, desc: a.desc, fed: !!r.fed, escape: !!r.escape, again: !!r.again });
		log(`the compiler stalled ${STALL_S} s: ${what}, ${a.inputs.length} ticks -> the search (${r.escape ? 'its next escape starts there' : 'no escape here'}${r.fed ? ', into its archive' : ''})`);
		if (!r.escape) prefixStart(a);
		writeReport();
	}
	if (!R.first && FEED && stalled && c && !c.cut && typeof c.inputs === 'string' && c.inputs.length && /^[0-O]+$/.test(c.inputs) && c.tiles < lastFedTiles - 1 && now - lastFeedAt >= 20e3) {
		if (compSend(`import ${c.inputs}`)) {
			lastFeedAt = now; lastFedTiles = c.tiles;
			R.feeds.push({ t: sec(), tiles: c.tiles, ticks: c.inputs.length, strategy: c.strategy });
		}
	}
	// (the job's best into the bound, every 30 s at most)
	if (R.search.job && now - lastBestRead > 30e3) { lastBestRead = now; jobBestIn(); }
	// (the compiler without a route of its own 90 s before the end, a route known: its moves end (stdin "stop"), and the
	// joins get the best route for the last minute)
	if (compAlive && !compStopAt && best && !R.compiler.firstRoute && !POLISH_S && now >= END - 90e3) { compStopAt = sec(); R.compiler.stopped = compStopAt; compSend('stop'); log('the compiler, no route of its own: stopped for the joins on the best'); }
	// (--polishS: the compiler with a route of its own 75 s before the end: its moves end, its stages after them polish it;
	// without one it goes on to the end: its own route may still come, often far faster than the search's first)
	if (compAlive && !compStopAt && best && R.compiler.firstRoute && POLISH_S && now >= END - 75e3) { compStopAt = sec(); R.compiler.stopped = compStopAt; compSend('stop'); log('the polish: the moves of the compiler end, its stages polish its route'); }
	if (!compAlive && comp && best && !R.joins) joinsStart();
	// (the compiler ended without a route, none known, a minute or more left: its CPU share to a prefix search of our own
	// from its furthest anchor (a fresh archive, another seed than the search's escape))
	if (!compAlive && comp && !R.first && HINT && !pre && !R.prefix.some((p) => p.why === 'the compiler ended') && furthest && furthest.gain >= 1 && now < END - 60e3) {
		prefixStart(furthest, CW, 'the compiler ended');
	}
	if (now >= END - 3000) { finishAll(END < END0 ? 'polish' : 'cap'); return; }
	if (now - (tick.lastW || 0) > 15e3) { tick.lastW = now; writeReport(); }
}

let finished = false, finalized = false;
/** the final: the best verified route of all, written, read back and replayed once more (again for a route that arrives
 *  after the end: the AutoTASer's last routes come in while its job import blocks this thread) */
function finalize() {
	finalized = true;
	if (!best) return;
	const f = path.join(OUT, 'best.eetas');
	C.writeEetas(f, best.ms);
	const back = C.evaluate(L, C.readEetas(f));
	R.final = back ? { runTicks: back.runTicks, time: C.fmt(back.runTicks), deaths: back.deaths, chance: back.chance, by: best.by, t: best.t, file: f, verified: back.runTicks === best.runTicks } :
		{ error: 'best.eetas does not replay', file: f, verified: false };
	R.polish = R.first ? { before: R.first.runTicks, after: best.runTicks, saved: R.first.runTicks - best.runTicks, ratio: Math.round((best.runTicks / R.first.runTicks) * 1000) / 1000,
		firstBy: R.first.by, finalBy: best.by } : null;
}
async function finishAll(why) {
	if (ending) return;
	ending = true;
	R.stop = { why, t: sec() };
	if (!R.lastProgress) R.lastProgress = { t: Math.round((progAt - T0) / 100) / 10, why: progWhy };
	log(`the end (${why})`);
	prefixStop('the end');
	if (joinsCh) { try { joinsCh.kill('SIGKILL'); } catch (e) { /* gone */ } }
	if (compAlive) { compSend('stop'); }
	try { if (ctl && !atEnded) ctl.stop(); } catch (e) { R.errors.push(`stop: ${e.message}`); }
	if (ownJob) { try { J.stopJob(ownJob); } catch (e) { /* stopped */ } }
	// (the compiler: 'stop' ends its moves; its stages after them have their own clocks: at most 8 s more here)
	for (let i = 0; i < 16 && compAlive; i++) await new Promise((r) => setTimeout(r, 500));
	if (compAlive) { try { comp.kill('SIGKILL'); } catch (e) { /* gone */ } await new Promise((r) => setTimeout(r, 500)); }
	jobBestIn();
	finalize();
	R.ended = new Date().toISOString();
	writeReport();
	log(`RESULT ${NAME}: ${R.first ? `first route by ${R.first.by} after ${R.first.t} s (${R.first.runTicks}), final ${R.final ? `${R.final.runTicks} by ${R.final.by}${R.final.verified ? ', verified' : ', NOT VERIFIED'}` : '-'}` : 'no route'}`);
	finished = true;
	setTimeout(() => {
		if (!on('keep', false)) { try { fs.unlinkSync(path.join(HOME, 'data', 'gpu-cache')); } catch (e) { /* */ } try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* */ } }
		process.exit(best && R.final && R.final.verified ? 0 : best ? 1 : 2);
	}, 4000);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { log(`${s}`); finishAll(s); setTimeout(() => process.exit(130), 60e3); });
process.on('SIGHUP', () => { /* (nohup: an ssh drop does not stop it) */ });

log(`${NAME}: the hybrid for ${SECONDS} s (the compiler ${CSECONDS} s + its stages after the moves), out ${OUT}, home ${HOME}`);
compStart();
atStart();
setInterval(tick, 2000);
writeReport();
