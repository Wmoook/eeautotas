'use strict';
// EE Auto TAS web app: a small local web server (http://localhost:47823) around the optimizer tools.
// Drop an Everybody Edits Offline level (.eelvl) and a TAS for it (.eetas, eeo-tas format) into the page. The app
// reads the level with its own EEO-exact reader (eelvl.js), checks that the TAS finishes the level in the exact
// physics port (eesim.js), then runs grind.js on it until you stop it. Every improvement is verified by a full
// replay and kept in src/jobs/<id>/ (best.eetas, best_<ticks>.eetas). One job optimizes at a time (it uses all the
// CPU threads you give it); the running job resumes when the app starts again. No AI is needed for any of this.
// Everything the page does is also a JSON API (GET /api lists it; README.md and CLAUDE.md document it), and
// src/tas.js does the same from a terminal, with or without this server running.
// Launch: START.bat, `npm start`, or: node src/server.js [--port=47823] [--open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const C = require('./common.js');
const J = require('./jobs.js');
const V = require('./viewer.js');
const G = require('./gpu.js');
const BENCH = require('./bench.js');
const GFX = require('./eegfx.js');
const ED = require('./editor.js');
const LC = require('./levelcheck.js');

const APP = path.join(__dirname, 'app', 'index.html');
const EDITOR = path.join(__dirname, 'app', 'editor.html');
const args = C.parseArgs(process.argv.slice(2));
const PORT = +(args.port || 47823);

const children = new Map();   // job id -> grind ChildProcess started by this server (stopped when the server stops)
const focusKids = new Map();  // job id -> focus ChildProcess started by this server

// ---------------------------------------------------------------- processors (CPU and GPU benchmarks)
// GPU mode = the CPU stages plus the GPU searcher (src/gpusearch.js on native/eegpu.exe, NVIDIA GPUs): both engines
// are bit-exact copies of eeo-tas's physics (test/gpu.js), and every GPU find is re-checked by the exact JS engine.
let bench = BENCH.cached();                    // the benchmark record (src/data/_system.json), measured at startup when missing
let benchState = bench ? 'done' : 'pending';
let gpuBench = G.cachedBench();                // data/_gpu.json: { gpu: {name, ...} | null, why, ticksPerSec }
let gpuState = gpuBench ? 'done' : 'pending';
const gpuAvailable = () => !!(gpuBench && gpuBench.gpu && gpuBench.ticksPerSec > 0);
const CPU_MODEL = (os.cpus()[0] && os.cpus()[0].model || '').trim();   // the detected CPU (texts name it: C.cpuName)
function systemInfo() {
	const n = os.cpus().length;
	const est = bench ? Array.from({ length: n }, (_, i) => BENCH.estimate(bench, i + 1)) : null;
	return {
		cpus: n, model: CPU_MODEL, benchState, bench,
		processors: [
			{ id: 'cpu', name: 'CPU', model: C.cpuName(CPU_MODEL), text: BENCH.describe(bench), available: true, threads: n, single: bench ? bench.single : null,
				all: bench ? bench.all : null, peakThreads: bench ? bench.peakThreads : null, estimate: est },
			gpuAvailable()
				? { id: 'gpu', name: 'GPU + CPU', model: gpuBench.gpu.name, available: true, ticksPerSec: gpuBench.ticksPerSec, text: G.describeBench(gpuBench), state: gpuState }
				: { id: 'gpu', name: 'GPU + CPU', available: false, state: gpuState,
					why: gpuState === 'pending' || gpuState === 'measuring' ? 'preparing the GPU (once per update: compiling for this graphics card can take a minute or two, then a short speed test)...' : (gpuBench && gpuBench.why) || 'no NVIDIA GPU found' },
		],
		faster: gpuAvailable() && bench && gpuBench.ticksPerSec > bench.all ? 'gpu' : 'cpu',
		note: gpuAvailable() && bench
			? `Measured on the same random-input test: ${C.cpuName(CPU_MODEL)} ${(bench.all / 1e6).toFixed(1)} M ticks/s on all threads, ${gpuBench.gpu.name} ${(gpuBench.ticksPerSec / 1e6).toFixed(0)} M ticks/s. GPU mode runs both.`
			: 'The CPU runs the optimizer; GPU mode (NVIDIA graphics cards) adds a GPU search next to it.',
	};
}

// ---------------------------------------------------------------- viewer data (cached per job and file version)
const viewCache = new Map();   // key -> value (small LRU)
function cached(key, make) {
	if (viewCache.has(key)) { const v = viewCache.get(key); viewCache.delete(key); viewCache.set(key, v); return v; }
	const v = make();
	viewCache.set(key, v);
	while (viewCache.size > 12) viewCache.delete(viewCache.keys().next().value);
	return v;
}
const fileVersion = (f) => { try { const s = fs.statSync(f); return `${Math.round(s.mtimeMs)}-${s.size}`; } catch (e) { return ''; } };   // = summary().bestVersion
/** trajectory of the job's best or original run in the job's exact engine (level JSON: rng_script, start_mode) */
function runTrajectory(id, which) {
	const file = path.join(J.jobDir(id), which === 'original' ? 'original.eetas' : 'best.eetas');
	const lj = J.levelJsonOf(id);
	const version = fileVersion(file);
	return cached(`tr|${id}|${which}|${version}|${fileVersion(lj)}`, () => {
		const level = J.loadJobLevel(id);
		return { version, level, tr: V.trajectory(level, C.readEetas(file)) };
	});
}
function trajectoryJson(id, which) {
	const w = which === 'original' ? 'original' : 'best';
	const r = runTrajectory(id, w);
	const extra = { which: w, version: r.version, name: C.readJSON(path.join(J.jobDir(id), 'meta.json'), {}).name || id };
	if (w === 'best') {
		const o = runTrajectory(id, 'original');
		// for each tick of the best run, the first tick of the original at the same point (the ghost's time difference)
		const al = cached(`al|${id}|${r.version}|${o.version}`, () => V.align(r.tr, o.tr));
		extra.align = Buffer.from(al.buffer, al.byteOffset, al.byteLength).toString('base64');
		extra.original = { ticks: o.tr.n, runTicks: o.tr.runTicks, time: C.fmt(o.tr.runTicks), finished: o.tr.complete >= 0, version: o.version };
	}
	return cached(`trj|${id}|${w}|${r.version}|${extra.original ? extra.original.version : ''}`, () => JSON.stringify(V.json(r.tr, extra)));
}
/** the job's best run as a path only (the level editor's "best route" once its optimizer runs: Find and optimize): its
 *  version, run ticks and the box's top-left per tick (base64 Int32, px x 16, like the trajectory's x / y); none of the
 *  trajectory's alignment with the original (a DTW of up to 40 M cells) or its events */
function pathJson(id) {
	const r = runTrajectory(id, 'best'), tr = r.tr;
	const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
	return cached(`path|${id}|${r.version}`, () => JSON.stringify({ version: r.version, ticks: tr.n, runTicks: tr.runTicks, time: C.fmt(tr.runTicks), finished: tr.complete >= 0, posScale: 16, x: b64(tr.X), y: b64(tr.Y) }));
}
function levelJson(id) {
	const lj = J.levelJsonOf(id);
	return cached(`lv|${id}|${fileVersion(lj)}`, () => JSON.stringify(V.levelView(C.readJSON(lj, null), J.loadJobLevel(id), C.readJSON(path.join(J.jobDir(id), 'meta.json'), {}))));
}

const ENDPOINTS = [
	['GET', '/api', 'this list'],
	['GET', '/api/state', 'all jobs (summaries, with the live speed of a running job and remote: its copy on a rented machine while src/jobs/<id>/remote.json is fresh), ' +
		'rented (the rented machines: their jobs, GPUs, speeds, the gains tonight), the CPU model and threads, the processor benchmark'],
	['GET', '/api/system', 'processors: CPU (measured engine speed, 1 thread and all threads, estimate per thread count) and GPU (name and measured speed, or why not available), and which is faster'],
	['POST', '/api/jobs', 'import: JSON {name, eelvlName, eetasName, eelvlB64, eetasB64, startMode: "reset" | "load", eeoCopy: true (import EEO\'s own copy of that campaign level instead of the file)} (files as base64 of their raw bytes)'],
	['POST', '/api/levelcheck', 'the level check of an .eelvl (src/levelcheck.js): JSON {eelvlB64} -> {md5, campaign (a file with the name and size of one of EEO\'s campaign levels: the same blocks, or how it differs from EEO\'s own copy), noops (effect blocks that can never do anything, with their cells), warnings, notes}'],
	['GET', '/api/levelcheck/eeo-copy?entry=41/1.eelvl', 'EEO\'s own copy of a campaign level: its .eelvl bytes from eeo-tas media/campaigns/campaigns.zip (the entry a level check names)'],
	['GET', '/api/jobs/:id', 'one job summary (best, history, stage, live speed, remote (on a rented machine: machine, GPU, speeds, stage, best, log), inbox, focus, files)'],
	['POST', '/api/jobs/:id/guide', 'GPU guided search: JSON {from, points: [[x, y], ...] (pixels of the ball centre; tiles with tiles: true), seconds, width}; exact faster rejoins go to the job'],
	['GET', '/api/jobs/:id/guide', 'the guided search: running, layer, tick, states, ticksPerSec, results, log'],
	['POST', '/api/jobs/:id/start', 'start / resume optimizing: JSON {workers, processor: "cpu" | "gpu"} ("gpu" = the CPU stages plus the GPU searcher)'],
	['POST', '/api/jobs/:id/stop', 'pause'],
	['POST', '/api/jobs/:id/finish', 'stop and write the final report (report.json)'],
	['DELETE', '/api/jobs/:id', 'delete the job and its files'],
	['GET', '/api/jobs/:id/best.eetas', 'download the best run (also original.eetas)'],
	['GET', '/api/jobs/:id/original.eelvl', 'the job\'s level file, byte for byte as imported (404 when it is missing); the level editor opens it: /editor#job=<id>'],
	['GET', '/api/jobs/:id/log', 'the last 300 lines of grind.log'],
	['GET', '/api/jobs/:id/where?t=1:10.00', 'state at a run time (m:ss.cc) or tick: position, velocity, tiles, coins, next inputs/events, ASCII map (&format=text)'],
	['GET', '/api/jobs/:id/render.png?from=1:10&to=1:14', 'PNG of the level around the path in that range (&scale=px per tile, &margin=tiles)'],
	['GET', '/api/jobs/:id/replay', 'summary + timeline of the best run (coins, random portals, odds) (&format=text)'],
	['POST', '/api/jobs/:id/try', 'hand a candidate run to the job: raw .eetas bytes, or JSON {eetasB64, source}; ?wait=seconds for a running job\'s verdict'],
	['POST', '/api/jobs/:id/probe', 'test an idea exactly: JSON {at, inputs: "R+J x3, R x20", try: true|false}; returns the rejoin/candidate'],
	['POST', '/api/jobs/:id/focus', 'search a time window harder: JSON {from, to, seconds, workers}; runs in the background'],
	['GET', '/api/jobs/:id/focus', 'the last focus search: state, results, log tail'],
	['GET', '/api/jobs/:id/trajectory?which=best', 'per-tick positions (1/16 px, base64 Int32), run timer, inputs, flags, events, door states and effects (protection, curse, ' +
		'fly, ... with their timers) of the best run (which=original: the uploaded TAS); best also has align (original tick at the same point, per best tick)'],
	['GET', '/api/jobs/:id/path', 'the best run as a path only: version, runTicks, ticks, x / y (per tick, 1/16 px, base64 Int32): the level editor\'s best route while Find and optimize runs'],
	['GET', '/api/jobs/:id/level', 'the level for the viewer: width, height, fg/bg ids (base64 Uint16), EE minimap color and block kind per id, door numbers, lookup numbers, portals, spawns'],
	['GET', '/api/eegfx', 'EE graphics for the viewer, read from your eeo-tas folder: {available, dir, why, sheets, blocks: {id: [sheet, frame, y, layer, shadow]}, sprites, rot, smiley, ...}'],
	['POST', '/api/eegfx', 'set the eeo-tas folder for EE graphics: JSON {dir} (checked: media/blocks.png and src/items/ItemManager.as; "" = find it automatically)'],
	['GET', '/api/eegfx/sheet/<name>.png', 'one sprite sheet from the eeo-tas media folder (only the sheets the map lists)'],
	['GET', '/editor', 'the level editor (place blocks, a start and the trophy; the GPU and the CPU find a route); /editor#job=<id> opens a job\'s level (&path=1: with its best run\'s path)'],
	['GET', '/api/editor/blocks?ids=9,121,...', 'block info for the editor: names, kinds ([kind, dir/sub, solid]), EE minimap colors, argument kinds'],
	['GET', '/api/editor/levels', 'the editor\'s "Open a level", in two sections: campaign (EEO\'s campaign levels from campaigns.zip, in EEO\'s order: {entry, name, title, campaign, tier, tiers, width, height}; GET /api/levelcheck/eeo-copy opens one) and other (the levels of your runs that are no campaign level, one per file: {job, name, jobName, width, height}); why (no campaigns.zip)'],
	['POST', '/api/editor/eelvl', 'the editor\'s level JSON {name, width, height, cells: [[x, y, id, ...args]]} -> .eelvl bytes (what EE Offline opens)'],
	['POST', '/api/editor/parse', 'an .eelvl -> the editor\'s level JSON: JSON {eelvlB64}'],
	['POST', '/api/editor/check', 'what stands in the way of a route search: JSON {eelvlB64} or {level}: problems (no start, no trophy, walled in), notes, start, trophies'],
	['POST', '/api/editor/solve', 'find a route to the trophy on the GPU and the CPU (the CPU alone without an NVIDIA GPU; one at a time, in the background): JSON {eelvlB64, guide: [[x, y], ...] (px, ball centre; optional), seconds, width, workers (CPU threads), seed}'],
	['GET', '/api/editor/solve', 'the route search: running, stage, layer, tick, states, ticksPerSec, result {time, runTicks, inputs, path}, message'],
	['GET', '/api/editor/solve/heat?search=&since=&trail=', 'the route search\'s exploration view (the page\'s heat and trails, src/heat.js): search (its start, ms), running, t (ms since its start), w, h, version, full, n, visited, idx / count / first / last (base64: uint32 LE tiles, uint16 LE visit counts, uint32 LE first and last visits in ms) changed since version `since` (every visited tile for another search or since=0), trailId, trails [{id, k, label, t, ticks, pts, br}] newer than `trail`'],
	['POST', '/api/editor/solve/stop', 'stop the route search'],
	['GET', '/api/editor/solve/route.eetas', 'download the found route (also level.eelvl: the level it was found on)'],
	['POST', '/api/editor/autotas', 'the AutoTASer: from the level alone to a near-optimal TAS within a time budget (Find a route, a job from its first route optimized at once, fed with its newer routes, the GPU handed to the optimizer when Find a route stops finding faster routes): JSON {eelvlB64, minutes (30), workers, name}'],
	['GET', '/api/editor/autotas', 'the AutoTASer: running, state (finding / optimizing / done), job, best (run ticks), bestT (s), routes, handoff, events [{t, ev, ...}] (the last 60), t0 (its start, ms), bests [{t, runTicks, what}] (the base route of its job and every faster best: the first and the newest 64)'],
	['POST', '/api/editor/autotas/stop', 'stop the AutoTASer (Find a route stops, the job pauses with its best)'],
	['POST', '/api/editor/job', 'a job from a found route: JSON {eelvlB64, eetasB64, name, start: true|false, processor: "cpu" | "gpu"} (import, optionally start)'],
	['POST', '/api/editor/compile', 'the compiler (src/compile.js: the level -> a verified .eetas; no search, no GPU; one at a time, in the background): JSON {eelvlB64 (or level), seconds (60), workers, name}'],
	['GET', '/api/editor/compile', 'the compile: running, stage, stages [{name, ms, text}] (parse, model, bounds, plan, moves, verify, polish), detail, notes, result {runTicks, time, lb, gap, legs, known, ...}, job (the run made from its route), loadtas (the eeo-tas line: /loadtas <its best.eetas>), message'],
	['POST', '/api/editor/compile/stop', 'stop the compile'],
	['POST', '/api/editor/hybrid', 'Hybrid (best) (tools/hybrid.js: the compiler and the search side by side, every route replayed; no time cap: until a route and its polish, or stop; before any route a fresh restart after restartS (1800) s with no progress; the workers and the GPU as Find a route takes them; one at a time, in the background): JSON {eelvlB64 (or level), name, source, workers, restartS (0: none), polishS (180)}'],
	['GET', '/api/editor/hybrid', 'the hybrid: running, stage (none / starting / running / polish / ending / done / stopped / no route / error), elapsed, workers, cpu, restartS, polishS, live (the compiler: anchors, gain, furthest, round; the search: nearest, rooms, run; restarts; routes [{t, by, runTicks, time}]; best), log, result {runTicks, time, by, first, polish}, loadtas (/loadtas <its route file>), message'],
	['POST', '/api/editor/hybrid/stop', 'stop the hybrid (its best route so far is its result)'],
	['GET', '/api/editor/hybrid/route.eetas', 'download the hybrid\'s route (the final, else the best so far; also level.eelvl: the level it ran on); ?started=<its started>: the run the page shows (another run since: 409)'],
];

// ---------------------------------------------------------------- http helpers
function send(res, code, body, type) {
	res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readRaw(req, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		// too large: the rest is read and dropped (not req.destroy(), which reset the connection before the error reached the page)
		let over = false;
		req.on('data', (c) => {
			size += c.length;
			if (size <= limit) { chunks.push(c); return; }
			if (!over) { over = true; chunks.length = 0; reject(new Error(`upload too large (limit ${limit >= 1 << 20 ? (limit >> 20) + ' MB' : (limit >> 10) + ' KB'})`)); }
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}
async function readJsonBody(req, limit) {
	const b = await readRaw(req, limit);
	let v;
	try { v = JSON.parse(b.toString('utf8') || '{}'); } catch (e) { throw new Error('bad request (expected JSON)'); }
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad request (expected a JSON object)');   // null, 5, [..]
	return v;
}
const validId = (id) => /^[a-z0-9-]+$/.test(id) && fs.existsSync(path.join(J.jobDir(id), 'meta.json'));
const listJobs = () => J.listJobs(new Map([...children].filter(([, ch]) => ch.exitCode === null).map(([id, ch]) => [id, ch.pid])));

function startJob(id, workers, opts) {
	for (const [other, ch] of children) if (other !== id && ch.exitCode === null) stopJob(other);
	const ch = J.startJob(id, workers, opts);
	if (ch) { children.set(id, ch); ch.on('exit', () => { if (children.get(id) === ch) children.delete(id); }); }
}
function stopJob(id) {
	const ch = children.get(id);
	J.stopGpuSearcher(id);   // (before the tree kill: it would reach the searcher's eegpu, mid-kernel)
	if (ch && ch.exitCode === null) J.killTree(ch.pid);
	children.delete(id);
	J.stopJob(id);
}
/** The guided search (src/guide.js) in the background: JSON {from, points: [[x, y], ...] (px, ball centre), seconds, width, tiles}. */
const guideKids = new Map();
function startGuide(id, b) {
	const GD = require('./guide.js');
	const mine = guideKids.get(id);
	if (GD.guideState(id).running || (mine && mine.exitCode === null)) throw new Error('a guided search is already running for this job');
	if (!gpuAvailable()) throw new Error(`the guided search runs on the GPU, which is not available: ${systemInfo().processors[1].why}`);
	if (b.from === undefined || b.from === '') throw new Error('missing "from" (m:ss.cc or a tick)');
	C.parseTime(b.from);
	const pts = Array.isArray(b.points) ? b.points.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) : [];
	if (pts.length < 2 || pts.length > 2000) throw new Error('the guide line needs 2 to 2000 points [x, y]');
	const seconds = Math.max(5, Math.min(3600, +b.seconds || 60));
	const line = pts.map((p) => p.join(',')).join(' ');
	const fd = fs.openSync(path.join(J.jobDir(id), 'guide.log'), 'w');
	const ch = spawn(process.execPath, [path.join(__dirname, 'tas.js'), 'guide', id, String(b.from), line, String(seconds),
		...(b.width ? [`--width=${+b.width}`] : []), ...(b.tiles ? ['--tiles'] : [])], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', fd, fd], windowsHide: true });
	fs.closeSync(fd);
	guideKids.set(id, ch);
	ch.on('exit', () => { if (guideKids.get(id) === ch) guideKids.delete(id); });
	return { ok: true, started: true, seconds };
}
function startFocus(id, b) {
	const f = J.focusState(id);
	const mine = focusKids.get(id);
	if (f.running || (mine && mine.exitCode === null)) throw new Error(`a focus search is already running for this job${f.running ? ` (${f.fromTime}-${f.toTime})` : ''}`);
	for (const k of ['from', 'to']) { if (b[k] === undefined || b[k] === '') throw new Error(`missing "${k}" (m:ss.cc or a tick)`); C.parseTime(b[k]); }
	// the range must be a non-empty part of the current best run: checked here, because the search runs in the
	// background and a failure there would only reach focus.log (the page would keep showing the previous search)
	const tr = C.replay(J.loadJobLevel(id), C.readEetas(path.join(J.jobDir(id), 'best.eetas')), { trace: true });
	const from = C.tickOf(tr, C.parseTime(b.from)), to = C.tickOf(tr, C.parseTime(b.to));
	if (!(to > from)) {
		throw new Error(`empty range: ${b.from} is tick ${from} and ${b.to} is tick ${to} of the best run (${C.fmt(tr.runTicks)}, ${tr.n} ticks); ` +
			'"To" must be later than "From" and before the finish');
	}
	const seconds = Math.max(10, Math.min(3600, +b.seconds || 120));
	const logFile = path.join(J.jobDir(id), 'focus.log');
	const fd = fs.openSync(logFile, 'w');
	const ch = spawn(process.execPath, [path.join(__dirname, 'tas.js'), 'focus', id, String(b.from), String(b.to), String(seconds),
		...(b.workers ? [`--workers=${+b.workers}`] : [])], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', fd, fd], windowsHide: true });
	fs.closeSync(fd);
	// replaces the previous search's focus.json at once (tas.js focus rewrites it within a second); if the search dies
	// before that, the page shows this range as stopped instead of the previous search's result
	C.writeJSON(path.join(J.jobDir(id), 'focus.json'), { state: 'running', stage: 'starting', pid: ch.pid, started: Date.now(), from, to,
		fromTime: C.fmt(tr.RUN[from]), toTime: C.fmt(tr.RUN[to]), seconds });
	focusKids.set(id, ch);
	ch.on('exit', () => { if (focusKids.get(id) === ch) focusKids.delete(id); });
	return { ok: true, started: true, pid: ch.pid, seconds, log: logFile };
}

// ---------------------------------------------------------------- the level editor (src/editor.js, src/app/editor.html)
/** the level of an editor request: {eelvlB64} (.eelvl bytes) or {level} (the editor's JSON) */
let autotas = null;   // the AutoTASer (src/autotas.js), one at a time
const autotasState = () => { const s = autotas ? autotas.state() : null; return s ? { running: s.state !== 'done', state: s.state, job: s.job, best: s.best, bestT: s.bestT, routes: s.routes, handoff: s.handoff, events: s.events.slice(-60), t0: s.t0, bests: s.bests } : { running: false, state: 'none' }; };
const editorLevel = (b) => (b.eelvlB64 ? Buffer.from(String(b.eelvlB64), 'base64') : b.level ? ED.eelvlOf(b.level) : null);
async function editorRoute(req, res, parts, q) {
	const what = parts[2] || '', sub = parts[3] || '';
	if (req.method === 'GET' && what === 'blocks' && !sub) return send(res, 200, ED.blockInfo(String(q('ids') || '').split(',').filter(Boolean)));
	// (the page's "Open a level": its campaign section and its other section)
	if (req.method === 'GET' && what === 'levels' && !sub) return send(res, 200, ED.levelList());
	if (req.method === 'POST' && what === 'eelvl' && !sub) {
		const b = await readJsonBody(req, 64 << 20);
		const lv = b.level || b;
		const buf = ED.eelvlOf(lv);
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${ED.safeName(lv.name)}.eelvl"`, 'Cache-Control': 'no-store' });
		return res.end(buf);
	}
	if (req.method === 'POST' && what === 'parse' && !sub) {
		const b = await readJsonBody(req, 64 << 20);
		return send(res, 200, ED.levelOf(Buffer.from(String(b.eelvlB64 || ''), 'base64')));
	}
	if (req.method === 'POST' && what === 'check' && !sub) {
		const b = await readJsonBody(req, 64 << 20);
		const buf = editorLevel(b);
		if (!buf) throw new Error('missing eelvlB64 or level');
		// (source {name, md5}: the file the page's level came from, unchanged since it was opened: the verdicts name it)
		return send(res, 200, Object.assign(ED.check(buf, b.source), { gpu: systemInfo().processors[1] }));
	}
	if (what === 'solve') {
		if (req.method === 'GET' && !sub) return send(res, 200, ED.state());
		// (the page's exploration view: where the search has been, its latest attempts; src/heat.js)
		if (req.method === 'GET' && sub === 'heat') return send(res, 200, ED.heatState(q('since'), q('trail'), q('search')));
		if (req.method === 'POST' && !sub) {
			const b = await readJsonBody(req, 64 << 20);
			try { return send(res, 200, ED.start(b, systemInfo().processors[1])); } catch (e) { return send(res, 400, { error: e.message, problems: e.problems }); }
		}
		if (req.method === 'POST' && sub === 'stop') return send(res, 200, ED.stop());
		if (req.method === 'GET' && (sub === 'route.eetas' || sub === 'level.eelvl')) {
			const f = ED.solveFile(sub);
			if (!f) return send(res, 404, { error: sub === 'route.eetas' ? 'no route found yet' : 'no search yet' });
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' });
			return res.end(fs.readFileSync(f.file));
		}
	}
	if (what === 'autotas') {
		if (req.method === 'GET' && !sub) return send(res, 200, autotasState());
		if (req.method === 'POST' && sub === 'stop') { if (autotas) autotas.stop(); return send(res, 200, autotasState()); }
		if (req.method === 'POST' && !sub) {
			const b = await readJsonBody(req, 64 << 20);
			if (autotas && autotas.state().state !== 'done') return send(res, 400, { error: 'the AutoTASer is already running (one at a time): wait for it, or stop it' });
			const buf = editorLevel(b);
			if (!buf || !buf.length) return send(res, 400, { error: 'missing eelvlB64 or level' });
			try {
				autotas = require('./autotas.js').run({ eelvl: buf, minutes: b.minutes, workers: b.workers, name: b.name ? String(b.name).slice(0, 80) : 'AutoTAS',
					gpu: systemInfo().processors[1], startJob, stopJob, source: b.source });
			} catch (e) { return send(res, 400, { error: e.message, problems: e.problems }); }
			return send(res, 200, autotasState());
		}
	}
	// the COMPILE action (src/compile.js: the level -> a verified .eetas, no search, no GPU; one at a time): its stage
	// lines, then a job from its route and the eeo-tas line for it (loadtas), which the page copies
	if (what === 'compile') {
		if (req.method === 'GET' && !sub) return send(res, 200, ED.compileState());
		if (req.method === 'POST' && sub === 'stop') return send(res, 200, ED.compileStop());
		if (req.method === 'POST' && !sub) {
			const b = await readJsonBody(req, 64 << 20);
			try { return send(res, 200, ED.compileStart(b)); } catch (e) { return send(res, 400, { error: e.message, problems: e.problems }); }
		}
	}
	// the HYBRID action (tools/hybrid.js: the compiler and the search side by side, no time cap, a fresh restart after a
	// stall; one at a time): its live state, then its best route (route.eetas) and the eeo-tas line for it (loadtas); the
	// workers and the GPU as Find a route takes them (no GPU: CPU only)
	if (what === 'hybrid') {
		if (req.method === 'GET' && !sub) return send(res, 200, ED.hybridState());
		if (req.method === 'POST' && sub === 'stop') return send(res, 200, ED.hybridStop());
		if (req.method === 'POST' && !sub) {
			const b = await readJsonBody(req, 64 << 20);
			try { return send(res, 200, ED.hybridStart(b, systemInfo().processors[1])); } catch (e) { return send(res, 400, { error: e.message, problems: e.problems }); }
		}
		if (req.method === 'GET' && (sub === 'route.eetas' || sub === 'level.eelvl')) {
			// (?started=: the run the page shows; another run since: 409, never that run's files under this one's name)
			const f = ED.hybridFile(sub, q('started'));
			if (f && f.stale) return send(res, 409, { error: 'another hybrid has started since this one: its files are gone (run it again)' });
			if (!f) return send(res, 404, { error: sub === 'route.eetas' ? 'the hybrid has no route yet' : 'no hybrid yet' });
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' });
			return res.end(fs.readFileSync(f.file));
		}
	}
	if (req.method === 'POST' && what === 'job' && !sub) {
		const b = await readJsonBody(req, 64 << 20);
		let proc = null;
		if (b.start) {   // checked before the job is made: a refused start leaves no job behind
			proc = String(b.processor || (gpuAvailable() ? 'gpu' : 'cpu')).toLowerCase();
			if (proc !== 'cpu' && proc !== 'gpu') throw new Error(`unknown processor "${b.processor}" (cpu or gpu)`);
			if (proc === 'gpu' && !gpuAvailable()) {
				if (b.processor) throw new Error(`GPU mode is not available: ${systemInfo().processors[1].why}`);
				proc = 'cpu';
			}
		}
		const meta = ED.makeJob(b);
		if (proc === 'gpu' && G.unsupported(J.loadJobLevel(meta.id))) proc = 'cpu';
		if (proc) startJob(meta.id, b.workers, { gpu: proc === 'gpu' });
		return send(res, 200, { ok: true, job: meta, started: !!proc, processor: proc });
	}
	return send(res, 404, { error: 'not found (GET /api lists the endpoints)' });
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
	try {
		const u = new URL(req.url, 'http://localhost');
		const parts = u.pathname.split('/').filter(Boolean);
		const q = (k) => u.searchParams.get(k);
		if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(res, 200, fs.readFileSync(APP), 'text/html; charset=utf-8');
		if (req.method === 'GET' && (u.pathname === '/editor' || u.pathname === '/editor.html')) return send(res, 200, fs.readFileSync(EDITOR), 'text/html; charset=utf-8');
		if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
		if (req.method === 'GET' && parts.length === 1) return send(res, 200, { app: 'EE Auto TAS', endpoints: ENDPOINTS.map(([m, p, d]) => ({ method: m, path: p, what: d })) });
		if (req.method === 'GET' && parts[1] === 'state') {
			const jobs = listJobs(), now = Date.now();
			return send(res, 200, { jobs, rented: J.rentedMachines(jobs, now), cpus: os.cpus().length, cpuModel: CPU_MODEL, now, benchState,
				bench: bench ? { single: bench.single, all: bench.all, threads: bench.threads, peakThreads: bench.peakThreads, points: bench.points, model: bench.model } : null,
				gpu: systemInfo().processors[1], faster: systemInfo().faster });
		}
		if (req.method === 'GET' && parts[1] === 'system' && parts.length === 2) return send(res, 200, systemInfo());
		// EE graphics (the viewer): the sprite map built from the user's eeo-tas folder, and its sheet images
		if (parts[1] === 'eegfx') {
			if (req.method === 'GET' && parts.length === 2) return send(res, 200, GFX.info());
			if (req.method === 'POST' && parts.length === 2) { const b = await readJsonBody(req, 1 << 14); return send(res, 200, GFX.setDir(b.dir)); }
			if (req.method === 'GET' && parts[2] === 'sheet' && parts.length === 4) {
				const m = /^([\w.-]+)\.png$/.exec(parts[3]);
				const f = m && GFX.sheetFile(m[1]);
				if (!f) return send(res, 404, { error: 'unknown sheet' });
				res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
				return res.end(fs.readFileSync(f));
			}
		}
		if (parts[1] === 'editor') return await editorRoute(req, res, parts, q);
		// the level check (src/levelcheck.js): EEO's own copy of a campaign level, effect blocks that do nothing, the md5
		if (parts[1] === 'levelcheck') {
			if (req.method === 'POST' && parts.length === 2) {
				const b = await readJsonBody(req, 64 << 20);
				const buf = Buffer.from(String(b.eelvlB64 || ''), 'base64');
				if (!buf.length) throw new Error('missing eelvlB64 (the level as .eelvl bytes, base64)');
				let r;
				try { r = LC.checkLevel(buf); } catch (e) { throw new Error(`this does not look like an .eelvl level file (${e.message})`); }
				return send(res, 200, LC.brief(r));
			}
			if (req.method === 'GET' && parts[2] === 'eeo-copy' && parts.length === 3) {
				const entry = String(q('entry') || '');
				const bytes = /^[\w .-]+\/\d+\.eelvl$/.test(entry) ? LC.campaignCopy(entry) : null;
				if (!bytes) return send(res, 404, { error: `EEO has no campaign level ${JSON.stringify(entry)}${LC.campaignsZip().file ? '' : ` (${LC.campaignsZip().why})`}` });
				const l = LC.campaignIndex().levels.find((x) => x.entry === entry);
				const nice = `${String((l && l.name) || 'level').replace(/[^\w .()-]/g, '').trim() || 'level'} (EEO's copy).eelvl`;
				res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nice.replace(/'/g, '')}"`, 'Cache-Control': 'no-store' });
				return res.end(bytes);
			}
		}
		if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
			const b = await readJsonBody(req, 96 << 20);
			const eetas = b.eetasB64 !== undefined ? Buffer.from(String(b.eetasB64), 'base64') : Buffer.from(String(b.eetasText || ''), 'latin1');
			const meta = J.importJob({ eelvl: Buffer.from(String(b.eelvlB64 || ''), 'base64'), eetas, name: b.name, eelvlName: b.eelvlName, eetasName: b.eetasName,
				startMode: b.startMode, deaths: b.deaths === 'forbid' ? 'forbid' : undefined, eeoCopy: b.eeoCopy === true });
			return send(res, 200, { ok: true, job: meta });
		}
		if (parts[1] === 'jobs' && parts[2]) {
			const id = parts[2];
			if (!validId(id)) return send(res, 404, { error: 'unknown job' });
			const dir = J.jobDir(id);
			const what = parts[3] || '';
			if (req.method === 'GET' && !what) return send(res, 200, J.summary(id, children.get(id) && children.get(id).pid));
			if (req.method === 'POST' && what === 'start') {
				const b = await readJsonBody(req, 1 << 16);
				const proc = String(b.processor || 'cpu').toLowerCase();
				if (proc !== 'cpu' && proc !== 'gpu') throw new Error(`unknown processor "${b.processor}" (cpu or gpu)`);
				if (proc === 'gpu') {
					if (!gpuAvailable()) throw new Error(`GPU mode is not available: ${systemInfo().processors[1].why}`);
					const why = G.unsupported(J.loadJobLevel(id));
					if (why) throw new Error(`GPU mode cannot run this level: ${why}`);
				}
				startJob(id, b.workers, { gpu: proc === 'gpu' });
				return send(res, 200, { ok: true, processor: proc });
			}
			if (req.method === 'GET' && what === 'trajectory') return send(res, 200, trajectoryJson(id, q('which') || 'best'));
			if (req.method === 'GET' && what === 'path') return send(res, 200, pathJson(id));
			if (req.method === 'GET' && what === 'level') return send(res, 200, levelJson(id));
			if (req.method === 'POST' && what === 'stop') { stopJob(id); return send(res, 200, { ok: true }); }
			if (req.method === 'POST' && what === 'finish') { stopJob(id); return send(res, 200, { ok: true, report: J.finishReport(id) }); }
			if (req.method === 'DELETE' && !what) {
				stopJob(id);
				const fk = focusKids.get(id);
				if (fk && fk.exitCode === null) J.killTree(fk.pid);
				J.deleteJob(id);
				return send(res, 200, { ok: true });
			}
			if (req.method === 'GET' && (what === 'best.eetas' || what === 'original.eetas')) {
				const meta = C.readJSON(path.join(dir, 'meta.json'), {});
				let t = meta.tas && meta.tas.runTicks;
				if (what === 'best.eetas') t = (C.readJSON(path.join(dir, 'status.json'), {}).bestRunTicks) || t;
				const nice = `${(meta.name || id).replace(/[^\w .()-]/g, '')} ${what === 'best.eetas' ? 'optimized' : 'original'} ${C.fmt(t).replace(':', 'm')}.eetas`;
				res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nice}"`, 'Cache-Control': 'no-store' });
				return res.end(fs.readFileSync(path.join(dir, what)));
			}
			// the job's level file as imported, byte for byte (the level editor opens it: /editor#job=<id>)
			if (req.method === 'GET' && what === 'original.eelvl') {
				const f = path.join(dir, 'original.eelvl');
				if (!fs.existsSync(f)) return send(res, 404, { error: 'this job has no level file (original.eelvl is missing from its folder)' });
				const meta = C.readJSON(path.join(dir, 'meta.json'), {});
				const base = String((meta.level && meta.level.file) || meta.name || id).replace(/\.eelvl$/i, '').replace(/[^\w .()-]/g, '').trim() || 'level';
				res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${base}.eelvl"`, 'Cache-Control': 'no-store' });
				return res.end(fs.readFileSync(f));
			}
			if (req.method === 'GET' && what === 'log') return send(res, 200, { lines: J.logTail(id, 300) });
			if (req.method === 'GET' && what === 'where') {
				const w = J.where(J.loadJobLevel(id), C.readEetas(path.join(dir, 'best.eetas')), q('t') || q('time') || q('tick') || '0');
				if (q('format') === 'text') return send(res, 200, J.formatWhere(w), 'text/plain; charset=utf-8');
				return send(res, 200, w);
			}
			if (req.method === 'GET' && what === 'render.png') {
				const r = J.renderJob(J.loadJobLevel(id), C.readJSON(J.levelJsonOf(id), null), C.readEetas(path.join(dir, 'best.eetas')), q('from') || undefined,
					q('to') || undefined, { name: C.readJSON(path.join(dir, 'meta.json'), {}).name, scale: +q('scale') || undefined,
						margin: q('margin') !== null ? +q('margin') : undefined });
				return send(res, 200, r.png, 'image/png');
			}
			if (req.method === 'GET' && what === 'replay') {
				const r = J.replayInfo(J.loadJobLevel(id), C.readEetas(path.join(dir, 'best.eetas')));
				if (q('format') === 'text') return send(res, 200, J.formatReplay(r, id), 'text/plain; charset=utf-8');
				return send(res, 200, r);
			}
			if (req.method === 'POST' && what === 'try') {
				const raw = await readRaw(req, 16 << 20);
				let buf = raw, source = q('source') || 'api';
				if (/json/.test(req.headers['content-type'] || '') || raw[0] === 0x7B) {
					let b;
					try { b = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Error('bad JSON (send the raw .eetas bytes, or JSON {eetasB64, source})'); }
					if (!b || !b.eetasB64) throw new Error('missing eetasB64');
					buf = Buffer.from(String(b.eetasB64), 'base64');
					source = b.source || source;
				}
				const r = await J.tryCandidate(id, buf, { source, wait: Math.min(120, +q('wait') || 0) });
				return send(res, 200, r);
			}
			if (req.method === 'POST' && what === 'probe') {
				const b = await readJsonBody(req, 1 << 20);
				const st = C.readJSON(path.join(dir, 'status.json'), {});
				const p = J.probe(J.loadJobLevel(id), C.readEetas(path.join(dir, 'best.eetas')), String(b.at === undefined ? '' : b.at), J.parseInputs(b.inputs || ''),
					{ nocoins: !!st.coinsOptional, horizon: +b.horizon || undefined, shift: +b.shift || undefined });
				if (p.candidate) {
					p.file = path.join(dir, 'probes', `${J.stamp()}.eetas`);
					C.writeEetas(p.file, p.candidate.masks);
					if (b.try && p.candidate.saved > 0) p.try = await J.tryCandidate(id, fs.readFileSync(p.file), { source: b.source || `probe ${p.atTime}`, wait: Math.min(60, +b.wait || 20) });
					delete p.candidate.masks;
				}
				return send(res, 200, p);
			}
			if (req.method === 'POST' && what === 'focus') return send(res, 200, startFocus(id, await readJsonBody(req, 1 << 16)));
			if (req.method === 'POST' && what === 'guide') return send(res, 200, startGuide(id, await readJsonBody(req, 1 << 20)));
			if (req.method === 'GET' && what === 'guide') return send(res, 200, require('./guide.js').guideState(id));
			if (req.method === 'GET' && what === 'focus') {
				let lines = [];
				try { lines = fs.readFileSync(path.join(dir, 'focus.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-40); } catch (e) { /* none */ }
				return send(res, 200, { ...J.focusState(id), logTail: lines });
			}
		}
		return send(res, 404, { error: 'not found (GET /api lists the endpoints)' });
	} catch (e) {
		return send(res, 400, { error: e.message || String(e) });
	}
});

function openBrowser(url) { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); }
function shutdown() {
	// (never a tree kill that reaches eegpu: killing it while a kernel runs makes Windows reset the display driver. The
	// GPU searcher and the guided search start it detached with --parent: it ends at its next kernel launch)
	for (const [id, ch] of children) if (ch.exitCode === null) { J.stopGpuSearcher(id); J.killTree(ch.pid); }
	for (const [, ch] of focusKids) if (ch.exitCode === null) J.killTree(ch.pid);
	for (const [, ch] of guideKids) if (ch.exitCode === null) { try { ch.kill(); } catch (e) { /* gone */ } }
	ED.shutdown();
	process.exit(0);
}
/** The app: listen on PORT, benchmark the CPU once, resume the last running job. (require()d, e.g. by the tests,
 *  this file only builds `server`: nothing listens, benchmarks or resumes.) */
function main() {
	server.on('error', (e) => {
		if (e.code === 'EADDRINUSE') {   // already running: just open it
			console.log(`[app] already running on port ${PORT}`);
			if (args.open) openBrowser(`http://localhost:${PORT}/`);
			process.exit(0);
		}
		throw e;
	});
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	process.on('SIGHUP', shutdown);   // Windows: the console window was closed
	// the app's own thread above normal priority: with every core busy (Find a route's CPU search, a job's workers, other
	// programs) the page, its polling and Stop waited tens of seconds for the server. The tools it starts keep the normal
	// priority (Windows gives a child of an above-normal process the normal class).
	try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { /* not allowed: normal */ }
	server.listen(PORT, '127.0.0.1', () => {
		const url = `http://localhost:${PORT}/`;
		console.log(`[app] EE Auto TAS running at ${url} (CPU: ${C.cpuName(CPU_MODEL)}, ${os.cpus().length} threads)`);
		console.log('[app] Keep this window open while optimizing. Closing it stops the optimizer (it resumes next time).');
		if (process.env.EEAT_HOME) console.log(`[app] Your runs are saved in ${C.JOBS}`);
		if (args.open) openBrowser(url);
		// (the temp homes of hybrids that ended without removing theirs: editor.js hybridSweep)
		try { const sw = ED.hybridSweep(); if (sw.length) console.log(`[app] removed ${sw.length} temp folder${sw.length > 1 ? 's' : ''} of ended hybrids`); } catch (e) { /* next time */ }
		// resume the job that was optimizing when the app last closed (after the one-time processor benchmark, which
		// needs an idle CPU: a few seconds, then cached in src/data/_system.json)
		const resume = () => {
			const r = C.readJSON(J.RUNNING_FILE, null);
			if (r && r.id && validId(r.id) && !J.runningPid(r.id)) {
				console.log(`[app] resuming ${r.id}${r.gpu ? ' (GPU on)' : ''}`);
				startJob(r.id, r.workers, { gpu: !!r.gpu && gpuAvailable() });
			}
		};
		// the GPU benchmark (once per GPU / build: the driver first compiles the kernels for this card, up to a minute or two
		// on a laptop CPU, then a few seconds of measuring), after the CPU one so they do not disturb each other
		// then, in the background, the kernels of the other state sizes (gpu.js warmKernels: once per build; before, the
		// first Find a route on a level of another size waited minutes for their compile with its GPU strategies stopped)
		const gpuWarm = () => {
			if (!gpuBench || !gpuBench.gpu) return;
			G.warmKernels({ log: (r) => { if (r.module === 'compiled') console.log(`[app] GPU kernels for ${r.tw}-word states compiled (${Math.round(r.loadMs / 1000)} s, once per update)`); } })
				.catch((e) => console.log(`[app] GPU kernel compile failed: ${e.message}`));
		};
		const gpuMeasure = () => {
			if (gpuBench) { gpuWarm(); return Promise.resolve(); }
			gpuState = 'measuring';
			console.log('[app] preparing the GPU (once per update: compiling for this graphics card, up to a minute or two)...');
			return G.runBench().then((r) => {
				gpuBench = r; gpuState = 'done';
				console.log(`[app] ${G.describeBench(r)}`);
				gpuWarm();
			}).catch((e) => { gpuState = 'error'; console.log(`[app] GPU benchmark failed: ${e.message}`); });
		};
		if (bench) { gpuMeasure().finally(resume); return; }
		benchState = 'measuring';
		console.log(`[app] measuring the engine speed of the ${BENCH.describe(null)}: once, a few seconds...`);
		const busy = C.jobIds().some((id) => J.runningPid(id));   // a grind started from the CLI already uses the CPU
		BENCH.run({ busy }).then((rec) => {
			bench = rec; benchState = 'done';
			console.log(`[app] ${BENCH.describe(rec)}; all ${rec.threads} threads together: ${(rec.all / 1e6).toFixed(1)} M ticks/s${rec.allMeasured ? '' : ' (estimated)'}`);
		}).catch((e) => { benchState = 'error'; console.log(`[app] benchmark failed: ${e.message}`); }).finally(() => gpuMeasure().finally(resume));
	});
}
if (require.main === module) main();
module.exports = { server, readRaw, readJsonBody, startFocus, focusKids };
