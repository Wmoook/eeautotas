'use strict';
// TAS Optimizer app: a small local web server (http://localhost:47823) around the optimizer tools.
// Drop an Everybody Edits level (.eelvl) and a TAS for it (.eetas, eeo-tas format) into the page; the app converts
// the level with the game's own parser (Godot, tools/tas/export_level.gd), checks that the TAS finishes the level
// in the exact physics port (tools/tas/eesim.js), then runs tools/tas/grind.js on it until you stop it. Every
// improvement is verified by a full replay and kept in tools/tas/jobs/<id>/ (best.eetas, best_<ticks>.eetas).
// One job optimizes at a time (it uses all the CPU threads you give it); the running job resumes when the app
// starts again. Launch: TAS_OPTIMIZER.bat in the repo root, or: node tools/tas/server.js [--port=47823] [--open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const E = require('./eesim.js');
const RNG = require('./rng.js');

const ROOT = path.resolve(__dirname, '..', '..');
const JOBS = path.join(__dirname, 'jobs');
const DATA = path.join(__dirname, 'data');
const APP = path.join(__dirname, 'app', 'index.html');
const RUNNING_FILE = path.join(JOBS, '_running.json');
const args = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)(?:=(.*))?$/); if (m) args[m[1]] = m[2] === undefined ? '1' : m[2]; }
const PORT = +(args.port || 47823);
fs.mkdirSync(JOBS, { recursive: true });

const fmt = (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

// ---------------------------------------------------------------- Godot (the game's .eelvl parser)
function findGodot() {
	const c = [];
	if (process.env.GODOT_BIN) c.push(process.env.GODOT_BIN);
	const dl = path.join(os.homedir(), 'Downloads', 'Godot_v4.6.1-stable_win64.exe');
	c.push(path.join(dl, 'Godot_v4.6.1-stable_win64_console.exe'), path.join(dl, 'Godot_v4.6.1-stable_win64.exe'));
	for (const f of c) if (f && fs.existsSync(f)) return f;
	try {
		const w = execFileSync('where', ['godot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
		if (w && fs.existsSync(w)) return w;
	} catch (e) { /* not on PATH */ }
	return null;
}
const GODOT = findGodot();

// .eelvl files come zlib-wrapped (78 xx), raw-deflated (EE Offline saves) or uncompressed; the game's parser takes
// zlib or uncompressed, so raw deflate is re-wrapped as zlib.
function normalizeEelvl(buf) {
	if (buf.length < 4) throw new Error('the level file is empty');
	if (buf[0] === 0x78) { zlib.inflateSync(buf); return { data: buf, kind: 'zlib' }; }
	try { return { data: zlib.deflateSync(zlib.inflateRawSync(buf)), kind: 'raw deflate' }; } catch (e) { /* not raw deflate */ }
	try { return { data: zlib.deflateSync(zlib.gunzipSync(buf)), kind: 'gzip' }; } catch (e) { /* not gzip */ }
	if (buf[0] === 0 && buf[1] === 0) return { data: buf, kind: 'uncompressed' };
	throw new Error('this does not look like an .eelvl level file (unknown compression)');
}

function runGodotExport(levelFile, id) {
	return new Promise((resolve, reject) => {
		if (!GODOT) return reject(new Error('Godot 4.6.1 was not found (set GODOT_BIN to Godot_v4.6.1-stable_win64_console.exe)'));
		const p = spawn(GODOT, ['--headless', '--audio-driver', 'Dummy', '--path', ROOT, '-s', 'res://tools/tas/export_level.gd', '--',
			`file=${levelFile}`, `id=${id}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let out = '';
		p.stdout.on('data', (d) => { out += d; });
		p.stderr.on('data', (d) => { out += d; });
		const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } reject(new Error('the level converter timed out')); }, 180e3);
		p.on('close', () => {
			clearTimeout(timer);
			const f = path.join(DATA, id + '.json');
			const m = out.match(/\[export\] \S+: (\d+)x(\d+)/);
			if (!fs.existsSync(f) || !m || +m[1] < 2) return reject(new Error('the game could not read this level file' +
				(/Decompression failed|incorrect header/.test(out) ? ' (unknown compression)' : '')));
			resolve(f);
		});
	});
}

// replays a TAS in the exact physics port
function replay(level, masks) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	let complete = -1, deaths = 0, coins = 0;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); else if (k === 'death') deaths++; };
	let t = 0;
	for (; t < masks.length && complete < 0; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	coins = sim.coins;
	return { complete, runTicks: sim.run_ticks, deaths, coins, blueCoins: sim.blue_coins, ticks: t,
		end: { x: Math.round(sim.px / 16), y: Math.round(sim.py / 16) } };
}

// ---------------------------------------------------------------- jobs
const slug = (s) => String(s || 'level').toLowerCase().replace(/\.(eelvl|eetas)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'level';
const jobDir = (id) => path.join(JOBS, id);
const levelId = (id) => 'job_' + id.replace(/-/g, '_');
let children = new Map();   // job id -> ChildProcess (started by this server)

function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function jobRunningPid(id) {
	const ch = children.get(id);
	if (ch && ch.exitCode === null) return ch.pid;
	const st = readJSON(path.join(jobDir(id), 'status.json'), {});
	// a grind from an earlier app session may still run: accept its pid only if it is alive and recently active
	if (st.state === 'running' && pidAlive(st.pid) && Date.now() - (st.updated || 0) < 30 * 60e3) return st.pid;
	return 0;
}
function listJobs() {
	let ids = [];
	try { ids = fs.readdirSync(JOBS).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(JOBS, d, 'meta.json'))); } catch (e) { /* none */ }
	return ids.map((id) => {
		const meta = readJSON(path.join(jobDir(id), 'meta.json'), {});
		const st = readJSON(path.join(jobDir(id), 'status.json'), {});
		const pid = jobRunningPid(id);
		const bestTicks = st.bestRunTicks || meta.tas.runTicks;
		let logTail = [];
		try { logTail = fs.readFileSync(path.join(jobDir(id), 'grind.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-14); } catch (e) { /* none */ }
		return { ...meta, running: !!pid, state: pid ? 'running' : (st.state === 'error' ? 'error' : 'stopped'), error: st.error || null,
			best: { runTicks: bestTicks, time: fmt(bestTicks) }, original: { runTicks: meta.tas.runTicks, time: fmt(meta.tas.runTicks) },
			savedTicks: meta.tas.runTicks - bestTicks, history: st.history || [], stage: pid ? (st.stage || '') : '', round: st.rounds || 0,
			coinsOptional: st.coinsOptional, optimizingSince: pid ? st.sessionStarted : null, lastUpdate: st.updated || null, workers: st.workers,
			chance: st.chance !== undefined ? st.chance : (meta.rng ? meta.rng.chance : 1), report: readJSON(path.join(jobDir(id), 'report.json'), null),
			logTail };
	}).sort((x, y) => (y.created || 0) - (x.created || 0));
}

function stopJob(id) {
	const pid = jobRunningPid(id);
	if (pid) {
		// the whole tree: grind.js and the search tool it is running (plus that tool's worker threads)
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
	}
	children.delete(id);
	const sp = path.join(jobDir(id), 'status.json');
	const st = readJSON(sp, null);
	if (st) { st.state = 'stopped'; st.stage = ''; try { fs.writeFileSync(sp, JSON.stringify(st)); } catch (e) { /* ignore */ } }
	const r = readJSON(RUNNING_FILE, {});
	if (r.id === id) { try { fs.unlinkSync(RUNNING_FILE); } catch (e) { /* ignore */ } }
}

function startJob(id, workers) {
	for (const j of listJobs()) if (j.running && j.id !== id) stopJob(j.id);   // one job at a time: it uses the whole CPU
	if (jobRunningPid(id)) return;
	const dir = jobDir(id);
	const st = readJSON(path.join(dir, 'status.json'), {});
	const W = Math.max(1, Math.min(os.cpus().length, +workers || Math.max(1, os.cpus().length - 2)));
	const logFd = fs.openSync(path.join(dir, 'console.log'), 'a');
	const ch = spawn(process.execPath, [path.join(__dirname, 'grind.js'), `--job=${dir}`, `--level=${levelId(id)}`, '--forever=1', `--workers=${W}`,
		`--rot=${st.rounds || 0}`], { cwd: ROOT, stdio: ['ignore', logFd, logFd], windowsHide: true });
	ch.on('exit', () => { fs.closeSync(logFd); });
	children.set(id, ch);
	fs.writeFileSync(RUNNING_FILE, JSON.stringify({ id, workers: W }));
}

async function importJob(body) {
	const eelvl = Buffer.from(String(body.eelvlB64 || ''), 'base64');
	const tasText = String(body.eetasText || '');
	if (!eelvl.length) throw new Error('no .eelvl level file');
	if (!tasText.trim()) throw new Error('no .eetas TAS file');
	const norm = normalizeEelvl(eelvl);
	const masks = E.parseEetas(tasText);
	const odd = [...tasText.replace(/^﻿/, '').trim()].filter((ch) => { const c = ch.charCodeAt(0) - 48; return c < 0 || c > 31; }).length;
	const id = `${slug(body.name || body.eelvlName)}-${crypto.randomBytes(3).toString('hex')}`;
	const dir = jobDir(id);
	fs.mkdirSync(dir, { recursive: true });
	try {
		fs.writeFileSync(path.join(dir, 'original.eelvl'), eelvl);
		fs.writeFileSync(path.join(dir, 'level.eelvl'), norm.data);
		fs.writeFileSync(path.join(dir, 'original.eetas'), tasText);
		const lid = levelId(id);
		const dataFile = await runGodotExport(path.join(dir, 'level.eelvl'), lid);
		const ld = readJSON(dataFile, {});
		let level = E.loadLevel(dataFile);
		// random portals (EEO picks their exit with Math.random): find the outcomes this TAS needs, and the odds
		const rng = RNG.analyze(level, masks);
		if (rng.draws && rng.bestScript) {
			ld.rng_script = rng.bestScript;   // every tool simulates with this outcome script
			fs.writeFileSync(dataFile, JSON.stringify(ld));
			level = E.loadLevel(dataFile);
		} else if (level.multiTargetPortals) {
			ld.rng_script = [];   // random portals exist but this run uses none: any new use shows up as a lower chance
			fs.writeFileSync(dataFile, JSON.stringify(ld));
			level = E.loadLevel(dataFile);
		}
		const r = replay(level, masks);
		if (r.complete < 0 && rng.draws && rng.chance === 0) {
			throw new Error(`the TAS goes through ${rng.uses.length || 'some'} random portal(s) but no combination of exits lets it finish this level.`);
		}
		if (r.complete < 0) {
			const died = r.deaths ? `, died ${r.deaths} time(s)` : '';
			throw new Error(`the TAS does not finish this level in the game's physics: after all ${masks.length} ticks the ball is at tile ` +
				`(${r.end.x}, ${r.end.y}) with ${r.coins} coins${died}. Check that the .eetas belongs to this level` +
				(odd ? ` (it also contains ${odd} characters that are not inputs)` : '') + '.');
		}
		const str = Array.from(masks.slice(0, r.complete), (m) => String.fromCharCode(48 + m)).join('');
		fs.writeFileSync(path.join(dir, 'best.eetas'), str);
		fs.writeFileSync(path.join(dir, `best_${r.runTicks}.eetas`), str);
		const meta = {
			id, name: String(body.name || ld.world_name || slug(body.eelvlName)).slice(0, 80), created: Date.now(),
			level: { name: ld.world_name || '', file: body.eelvlName || 'level.eelvl', width: level.width, height: level.height, compression: norm.kind },
			tas: { file: body.eetasName || 'input.eetas', ticks: masks.length, completeTick: r.complete, runTicks: r.runTicks, time: fmt(r.runTicks),
				coins: r.coins, blueCoins: r.blueCoins, deaths: r.deaths, oddChars: odd },
			rng: { chance: rng.chance, uses: rng.uses, truncated: rng.truncated },
		};
		fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
		return meta;
	} catch (e) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
		try { fs.unlinkSync(path.join(DATA, levelId(id) + '.json')); } catch (e2) { /* ignore */ }
		throw e;
	}
}

// Finish run: the final report (time saved, random-portal odds in EEO), kept in report.json
function finishReport(id) {
	const dir = jobDir(id);
	const meta = readJSON(path.join(dir, 'meta.json'), {});
	const level = E.loadLevel(path.join(DATA, levelId(id) + '.json'));
	const masks = E.parseEetas(fs.readFileSync(path.join(dir, 'best.eetas'), 'utf8'));
	const r = replay(level, masks);
	const rng = RNG.analyze(level, masks);
	const rep = { finished: Date.now(), runTicks: r.runTicks, time: fmt(r.runTicks), originalRunTicks: meta.tas.runTicks, originalTime: fmt(meta.tas.runTicks),
		savedTicks: meta.tas.runTicks - r.runTicks, coins: r.coins, deaths: r.deaths,
		chance: rng.draws ? rng.chance : 1, originalChance: meta.rng ? meta.rng.chance : 1, uses: rng.uses, truncated: rng.truncated };
	fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep, null, 1));
	return rep;
}

function deleteJob(id) {
	stopJob(id);
	fs.rmSync(jobDir(id), { recursive: true, force: true });
	try { fs.unlinkSync(path.join(DATA, levelId(id) + '.json')); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- http
function send(res, code, body, type) {
	res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('upload too large')); req.destroy(); } else chunks.push(c); });
		req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad request')); } });
		req.on('error', reject);
	});
}
const validId = (id) => /^[a-z0-9-]+$/.test(id) && fs.existsSync(path.join(jobDir(id), 'meta.json'));

const server = http.createServer(async (req, res) => {
	try {
		const u = new URL(req.url, 'http://localhost');
		const parts = u.pathname.split('/').filter(Boolean);
		if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(res, 200, fs.readFileSync(APP), 'text/html; charset=utf-8');
		if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
		if (req.method === 'GET' && parts[1] === 'state') {
			return send(res, 200, { jobs: listJobs(), cpus: os.cpus().length, godot: !!GODOT, now: Date.now() });
		}
		if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
			const body = await readBody(req, 64 << 20);
			const meta = await importJob(body);
			return send(res, 200, { ok: true, job: meta });
		}
		if (parts[1] === 'jobs' && parts[2]) {
			const id = parts[2];
			if (!validId(id)) return send(res, 404, { error: 'unknown job' });
			const dir = jobDir(id);
			if (req.method === 'POST' && parts[3] === 'start') { const b = await readBody(req, 1 << 16); startJob(id, b.workers); return send(res, 200, { ok: true }); }
			if (req.method === 'POST' && parts[3] === 'stop') { stopJob(id); return send(res, 200, { ok: true }); }
			if (req.method === 'POST' && parts[3] === 'finish') { stopJob(id); return send(res, 200, { ok: true, report: finishReport(id) }); }
			if (req.method === 'DELETE' && parts.length === 3) { deleteJob(id); return send(res, 200, { ok: true }); }
			if (req.method === 'GET' && (parts[3] === 'best.eetas' || parts[3] === 'original.eetas')) {
				const meta = readJSON(path.join(dir, 'meta.json'), {});
				const file = path.join(dir, parts[3]);
				let t = meta.tas && meta.tas.runTicks;
				if (parts[3] === 'best.eetas') t = (readJSON(path.join(dir, 'status.json'), {}).bestRunTicks) || t;
				const nice = `${(meta.name || id).replace(/[^\w .()-]/g, '')} ${parts[3] === 'best.eetas' ? 'optimized' : 'original'} ${fmt(t).replace(':', 'm')}.eetas`;
				res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${nice}"`, 'Cache-Control': 'no-store' });
				return res.end(fs.readFileSync(file));
			}
			if (req.method === 'GET' && parts[3] === 'log') {
				let lines = [];
				try { lines = fs.readFileSync(path.join(dir, 'grind.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-300); } catch (e) { /* none */ }
				return send(res, 200, { lines });
			}
		}
		return send(res, 404, { error: 'not found' });
	} catch (e) {
		return send(res, 400, { error: e.message || String(e) });
	}
});

function openBrowser(url) { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); }
server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {   // already running: just open it
		console.log(`[app] already running on port ${PORT}`);
		if (args.open) openBrowser(`http://localhost:${PORT}/`);
		process.exit(0);
	}
	throw e;
});
server.listen(PORT, '127.0.0.1', () => {
	const url = `http://localhost:${PORT}/`;
	console.log(`[app] TAS Optimizer running at ${url}`);
	console.log(`[app] Godot: ${GODOT || 'NOT FOUND (set GODOT_BIN)'}; ${os.cpus().length} CPU threads`);
	console.log('[app] Keep this window open while optimizing. Closing it stops the optimizer (it resumes next time).');
	// resume the job that was optimizing when the app last closed
	const r = readJSON(RUNNING_FILE, null);
	if (r && r.id && validId(r.id) && !jobRunningPid(r.id)) { console.log(`[app] resuming ${r.id}`); startJob(r.id, r.workers); }
	if (args.open) openBrowser(url);
});
function shutdown() { for (const [, ch] of children) { try { spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
