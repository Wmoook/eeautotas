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
const BENCH = require('./bench.js');

const APP = path.join(__dirname, 'app', 'index.html');
const args = C.parseArgs(process.argv.slice(2));
const PORT = +(args.port || 47823);

const children = new Map();   // job id -> grind ChildProcess started by this server (stopped when the server stops)
const focusKids = new Map();  // job id -> focus ChildProcess started by this server

// ---------------------------------------------------------------- processor (CPU benchmark; why no GPU)
const GPU_WHY = 'Exact EE physics needs 64-bit floating point math (every run must replay bit for bit like eeo-tas). WebGPU has no ' +
	'64-bit floats at all, and gaming GPUs run them at about 1/64 of their normal speed; the engine is also full of branches (1 px ' +
	'collision steps, portals, doors) that GPUs handle badly. The CPU is faster for this.';
let bench = BENCH.cached();                    // the benchmark record (src/data/_system.json), measured at startup when missing
let benchState = bench ? 'done' : 'pending';
function systemInfo() {
	const n = os.cpus().length;
	const est = bench ? Array.from({ length: n }, (_, i) => BENCH.estimate(bench, i + 1)) : null;
	return {
		cpus: n, model: (os.cpus()[0] && os.cpus()[0].model || '').trim(), benchState, bench,
		processors: [
			{ id: 'cpu', name: 'CPU', available: true, threads: n, single: bench ? bench.single : null, all: bench ? bench.all : null,
				peakThreads: bench ? bench.peakThreads : null, estimate: est },
			{ id: 'gpu', name: 'GPU', available: false, why: GPU_WHY },
		],
		faster: 'cpu',
		note: 'The CPU is faster: exact EE physics is 64-bit floating point math with many branches, which GPUs run far slower (see README "CPU or GPU").',
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
function levelJson(id) {
	const lj = J.levelJsonOf(id);
	return cached(`lv|${id}|${fileVersion(lj)}`, () => JSON.stringify(V.levelView(C.readJSON(lj, null), J.loadJobLevel(id), C.readJSON(path.join(J.jobDir(id), 'meta.json'), {}))));
}

const ENDPOINTS = [
	['GET', '/api', 'this list'],
	['GET', '/api/state', 'all jobs (summaries), CPU threads, the processor benchmark'],
	['GET', '/api/system', 'processors: CPU (measured engine speed, 1 thread and all threads, estimate per thread count) and GPU (not available, why)'],
	['POST', '/api/jobs', 'import: JSON {name, eelvlName, eetasName, eelvlB64, eetasB64, startMode: "reset" | "load"} (files as base64 of their raw bytes)'],
	['GET', '/api/jobs/:id', 'one job summary (best, history, stage, inbox, focus, files)'],
	['POST', '/api/jobs/:id/start', 'start / resume optimizing: JSON {workers, processor: "cpu"}'],
	['POST', '/api/jobs/:id/stop', 'pause'],
	['POST', '/api/jobs/:id/finish', 'stop and write the final report (report.json)'],
	['DELETE', '/api/jobs/:id', 'delete the job and its files'],
	['GET', '/api/jobs/:id/best.eetas', 'download the best run (also original.eetas)'],
	['GET', '/api/jobs/:id/log', 'the last 300 lines of grind.log'],
	['GET', '/api/jobs/:id/where?t=1:10.00', 'state at a run time (m:ss.cc) or tick: position, velocity, tiles, coins, next inputs/events, ASCII map (&format=text)'],
	['GET', '/api/jobs/:id/render.png?from=1:10&to=1:14', 'PNG of the level around the path in that range (&scale=px per tile, &margin=tiles)'],
	['GET', '/api/jobs/:id/replay', 'summary + timeline of the best run (coins, random portals, odds) (&format=text)'],
	['POST', '/api/jobs/:id/try', 'hand a candidate run to the job: raw .eetas bytes, or JSON {eetasB64, source}; ?wait=seconds for a running job\'s verdict'],
	['POST', '/api/jobs/:id/probe', 'test an idea exactly: JSON {at, inputs: "R+J x3, R x20", try: true|false}; returns the rejoin/candidate'],
	['POST', '/api/jobs/:id/focus', 'search a time window harder: JSON {from, to, seconds, workers}; runs in the background'],
	['GET', '/api/jobs/:id/focus', 'the last focus search: state, results, log tail'],
	['GET', '/api/jobs/:id/trajectory?which=best', 'per-tick positions (1/16 px, base64 Int32), run timer, inputs, flags, events and door states of the best run ' +
		'(which=original: the uploaded TAS); best also has align (original tick at the same point, per best tick)'],
	['GET', '/api/jobs/:id/level', 'the level for the viewer: width, height, fg/bg ids (base64 Uint16), EE minimap color and block kind per id, door numbers, portals, spawns'],
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

function startJob(id, workers) {
	for (const [other, ch] of children) if (other !== id && ch.exitCode === null) stopJob(other);
	const ch = J.startJob(id, workers);
	if (ch) { children.set(id, ch); ch.on('exit', () => { if (children.get(id) === ch) children.delete(id); }); }
}
function stopJob(id) {
	const ch = children.get(id);
	if (ch && ch.exitCode === null) J.killTree(ch.pid);
	children.delete(id);
	J.stopJob(id);
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

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
	try {
		const u = new URL(req.url, 'http://localhost');
		const parts = u.pathname.split('/').filter(Boolean);
		const q = (k) => u.searchParams.get(k);
		if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(res, 200, fs.readFileSync(APP), 'text/html; charset=utf-8');
		if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
		if (req.method === 'GET' && parts.length === 1) return send(res, 200, { app: 'EE Auto TAS', endpoints: ENDPOINTS.map(([m, p, d]) => ({ method: m, path: p, what: d })) });
		if (req.method === 'GET' && parts[1] === 'state') {
			return send(res, 200, { jobs: listJobs(), cpus: os.cpus().length, now: Date.now(), benchState,
				bench: bench ? { single: bench.single, all: bench.all, threads: bench.threads, peakThreads: bench.peakThreads, points: bench.points } : null });
		}
		if (req.method === 'GET' && parts[1] === 'system' && parts.length === 2) return send(res, 200, systemInfo());
		if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
			const b = await readJsonBody(req, 96 << 20);
			const eetas = b.eetasB64 !== undefined ? Buffer.from(String(b.eetasB64), 'base64') : Buffer.from(String(b.eetasText || ''), 'latin1');
			const meta = J.importJob({ eelvl: Buffer.from(String(b.eelvlB64 || ''), 'base64'), eetas, name: b.name, eelvlName: b.eelvlName, eetasName: b.eetasName,
				startMode: b.startMode });
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
				if (proc === 'gpu') throw new Error(`GPU mode is not available: ${GPU_WHY}`);
				if (proc !== 'cpu') throw new Error(`unknown processor "${b.processor}" (cpu)`);
				startJob(id, b.workers);
				return send(res, 200, { ok: true, processor: 'cpu' });
			}
			if (req.method === 'GET' && what === 'trajectory') return send(res, 200, trajectoryJson(id, q('which') || 'best'));
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
	for (const [, ch] of children) if (ch.exitCode === null) J.killTree(ch.pid);
	for (const [, ch] of focusKids) if (ch.exitCode === null) J.killTree(ch.pid);
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
	server.listen(PORT, '127.0.0.1', () => {
		const url = `http://localhost:${PORT}/`;
		console.log(`[app] EE Auto TAS running at ${url} (${os.cpus().length} CPU threads)`);
		console.log('[app] Keep this window open while optimizing. Closing it stops the optimizer (it resumes next time).');
		if (process.env.EEAT_HOME) console.log(`[app] Your runs are saved in ${C.JOBS}`);
		if (args.open) openBrowser(url);
		// resume the job that was optimizing when the app last closed (after the one-time processor benchmark, which
		// needs an idle CPU: a few seconds, then cached in src/data/_system.json)
		const resume = () => {
			const r = C.readJSON(J.RUNNING_FILE, null);
			if (r && r.id && validId(r.id) && !J.runningPid(r.id)) { console.log(`[app] resuming ${r.id}`); startJob(r.id, r.workers); }
		};
		if (bench) { resume(); return; }
		benchState = 'measuring';
		console.log('[app] measuring the engine speed on this CPU (once, a few seconds)...');
		const busy = C.jobIds().some((id) => J.runningPid(id));   // a grind started from the CLI already uses the CPU
		BENCH.run({ busy }).then((rec) => {
			bench = rec; benchState = 'done';
			console.log(`[app] CPU: ${(rec.single / 1e6).toFixed(1)} M ticks/s on 1 thread, ${(rec.all / 1e6).toFixed(1)} M on all ${rec.threads}` +
				`${rec.allMeasured ? '' : ' (estimated)'}; fastest with ${rec.peakThreads} threads`);
		}).catch((e) => { benchState = 'error'; console.log(`[app] benchmark failed: ${e.message}`); }).finally(resume);
	});
}
if (require.main === module) main();
module.exports = { server, readRaw, readJsonBody, startFocus, focusKids };
