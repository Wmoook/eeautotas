'use strict';
// Jobs: one level + one TAS being optimized, everything in src/jobs/<id>/ (see CLAUDE.md "Job files"). Shared by
// the web app (server.js) and the CLI (tas.js), so both work with or without the other running:
//   import, start / stop (the grind process), summary, finish report, try (hand a candidate run to a job),
//   where (the state at a time), replay timeline, render (PNG), focus (search one time window harder).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const C = require('./common.js');
const EELVL = require('./eelvl.js');
const B = require('./blocks.js');
const E = C.E, RNG = C.RNG, fmt = C.fmt;

const JOBS = C.JOBS, DATA = C.DATA;
const RUNNING_FILE = path.join(JOBS, '_running.json');
fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const jobDir = (id) => path.join(JOBS, id);
const slug = (s) => String(s || 'level').toLowerCase().replace(/\.(eelvl|eetas)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'level';
const levelJsonOf = (id) => path.join(DATA, C.jobLevelId(id) + '.json');
const loadJobLevel = (id) => E.loadLevel(levelJsonOf(id));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15) + '_' + crypto.randomBytes(2).toString('hex');
const pct = (x) => `${(x * 100).toFixed(x >= 0.9995 || x === 0 ? 0 : 1)}%`;

/** job id, unique prefix or name part -> id; throws a helpful error */
function resolve(q) {
	const id = C.findJob(q);
	if (!id) throw new Error(`unknown job "${q}" (jobs: ${C.jobIds().join(', ') || 'none - import one first'})`);
	return id;
}

// ---------------------------------------------------------------- processes
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
/** pid of the job's grind if it runs (status.json written by grind.js, heartbeat every 30 s), else 0 */
function runningPid(id) {
	const st = C.readJSON(path.join(jobDir(id), 'status.json'), {});
	if (st.state === 'running' && pidAlive(st.pid) && Date.now() - (st.updated || 0) < 15 * 60e3) return st.pid;
	return 0;
}
function killTree(pid) {
	if (!pid) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
	else { try { process.kill(-pid, 'SIGTERM'); } catch (e) { try { process.kill(pid, 'SIGTERM'); } catch (e2) { /* gone */ } } }
}
function updateStatus(id, patch) {
	const sp = path.join(jobDir(id), 'status.json');
	const st = C.readJSON(sp, {});
	if (!Array.isArray(st.history)) st.history = [];
	const next = typeof patch === 'function' ? (patch(st) || st) : Object.assign(st, patch);
	C.writeJSON(sp, next);
	return next;
}

/** Starts the grind (src/grind.js) for a job. detached: keeps running after this process exits (CLI). */
function startJob(id, workers, opts) {
	const o = opts || {};
	if (runningPid(id)) return null;
	for (const other of C.jobIds()) if (other !== id && runningPid(other)) stopJob(other);   // one job at a time: it uses the whole CPU
	const dir = jobDir(id);
	const st = C.readJSON(path.join(dir, 'status.json'), {});
	const W = Math.max(1, Math.min(os.cpus().length, +workers || Math.max(1, os.cpus().length - 2)));
	const logFd = fs.openSync(path.join(dir, 'console.log'), 'a');
	const ch = spawn(process.execPath, [path.join(__dirname, 'grind.js'), `--job=${dir}`, `--level=${C.jobLevelId(id)}`, '--forever=1',
		`--workers=${W}`, `--rot=${st.rounds || 0}`, ...(o.gpu ? ['--gpu=1'] : [])], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', logFd, logFd], windowsHide: true,
		detached: !!o.detached });
	fs.closeSync(logFd);
	if (o.detached) ch.unref();
	updateStatus(id, { state: 'running', pid: ch.pid, updated: Date.now(), stage: 'starting', workers: W, gpu: !!o.gpu, error: null });
	C.writeJSON(RUNNING_FILE, { id, workers: W, gpu: !!o.gpu });
	return ch;
}
function stopJob(id) {
	killTree(runningPid(id));
	if (fs.existsSync(path.join(jobDir(id), 'status.json'))) updateStatus(id, (st) => { st.state = 'stopped'; st.stage = ''; });
	const r = C.readJSON(RUNNING_FILE, {});
	if (r.id === id) { try { fs.unlinkSync(RUNNING_FILE); } catch (e) { /* gone */ } }
}
function deleteJob(id) {
	stopJob(id);
	const f = focusState(id);
	if (f.running) killTree(f.pid);
	const lj = levelJsonOf(id);
	fs.rmSync(jobDir(id), { recursive: true, force: true });
	try { fs.unlinkSync(lj); } catch (e) { /* gone */ }
}

// ---------------------------------------------------------------- import
/**
 * How the TAS was started in eeo-tas (the level JSON's start_mode, read by every tool through eesim.loadLevel):
 * 'reset' = load the level, /reset, /playtas (the eeo-tas README workflow; /reset moves to the next spawn point)
 * or 'load' = /playtas right after loading the level (the first spawn point, collected coins in the file stay
 * collected). See eesim.js EESim.reset().
 */
const START_MODES = { reset: 'after /reset', load: 'right after loading the level' };
// Sanity limits for files from outside (a crafted or damaged file must not make the import allocate gigabytes or
// block the web server for minutes): EEO's block ids are below 2000 (docs/eeo_spec/blocks.json), the sample levels
// are at most 400 x 400, and real runs are well under an hour (1 tick = 10 ms; Infinity Pain is 41 277 ticks).
const MAX_BLOCK_ID = 65535, MAX_CELLS = 4e6, MAX_TICKS = 5e6;
/** A level that eeo-tas could not really have made: refused before anything is sized by it (see the limits above). */
function checkLevelLimits(p) {
	if (p.width * p.height > MAX_CELLS) {
		throw new Error(`this level is ${p.width} x ${p.height} tiles (${(p.width * p.height / 1e6).toFixed(1)} million); the limit is ${MAX_CELLS / 1e6} million tiles ` +
			'(EEO levels are far smaller): it is probably not an EEO level, or it is damaged');
	}
	for (const r of p.records) {
		if (r.id > MAX_BLOCK_ID) {
			throw new Error(`not an EEO level: block id ${r.id} in the record at byte ${r.offset} of the unpacked file (EEO block ids are below 2000; ` +
				'the file is probably damaged)');
		}
	}
}
/** A run far longer than any real one (see MAX_TICKS): refused before it is replayed. */
function checkTicks(n, what) {
	if (n > MAX_TICKS) throw new Error(`${what} has ${n} ticks (${fmt(n)} of play); the limit is ${MAX_TICKS} ticks (${fmt(MAX_TICKS)}): is this really an .eetas?`);
}
const normStart = (s) => {
	const v = String(s || 'reset').toLowerCase();
	if (!START_MODES[v]) throw new Error(`unknown start "${s}" (use reset or load)`);
	return v;
};

/**
 * New job from a level file and a TAS (both raw bytes). Reads the level with eelvl.js (EEO's own format rules),
 * finds the random-portal outcomes the TAS needs (rng.js), checks that it finishes, writes src/jobs/<id>/ and
 * src/data/job_<id>.json. Throws a readable error if the TAS does not finish the level.
 * startMode: 'reset' (default) or 'load', how the TAS was started in eeo-tas (see START_MODES).
 */
function importJob({ eelvl, eetas, name, eelvlName, eetasName, startMode }) {
	if (!eelvl || !eelvl.length) throw new Error('no .eelvl level file');
	if (!eetas || !eetas.length) throw new Error('no .eetas TAS file');
	const start = normStart(startMode);
	let p;
	try { p = EELVL.readEelvl(eelvl); } catch (e) { throw new Error(`this does not look like an .eelvl level file (${e.message})`); }
	checkLevelLimits(p);
	checkTicks(eetas.length, 'the .eetas file');
	const masks = C.parseEetasBuffer(eetas);
	if (!masks.length) throw new Error('the .eetas file has no inputs');
	const odd = C.oddBytes(eetas);
	const id = `${slug(name || p.name || eelvlName)}-${crypto.randomBytes(3).toString('hex')}`;
	const dir = jobDir(id);
	const lid = 'job_' + id.replace(/-/g, '_');
	const dataFile = path.join(DATA, lid + '.json');
	fs.mkdirSync(dir, { recursive: true });
	try {
		fs.writeFileSync(path.join(dir, 'original.eelvl'), eelvl);
		fs.writeFileSync(path.join(dir, 'original.eetas'), eetas);
		const ld = EELVL.toSimLevel(p, { id: lid, file: eelvlName || 'level.eelvl' });
		ld.start_mode = start;   // every tool simulates the run from this start (eesim.prepareLevel reads it)
		let level = E.prepareLevel(ld);
		const startMatters = require('./viewer.js').startMatters(level);
		// the other start, only to explain a failure ("it does finish when started after /reset")
		const otherFinishes = () => {
			if (!startMatters) return false;
			const other = start === 'reset' ? 'load' : 'reset';
			const lo = E.prepareLevel(Object.assign({}, ld, { start_mode: other }));
			const ro = RNG.analyze(lo, masks);
			if (ro.draws && ro.bestScript) lo.rngScript = Int32Array.from(ro.bestScript);
			return C.replay(lo, masks).complete >= 0 ? other : false;
		};
		const startHint = () => {
			const o = otherFinishes();
			return o ? ` It does finish when started ${START_MODES[o]}: choose "${o === 'reset' ? 'After /reset' : 'Right after loading the level'}" ` +
				'under "How did you start the TAS in eeo-tas?" and import again.' : '';
		};
		// random portals (EEO picks their exit with Math.random): the outcomes this TAS needs, and the odds
		const rng = RNG.analyze(level, masks);
		if (rng.draws && rng.bestScript) ld.rng_script = rng.bestScript;   // every tool simulates with this outcome script
		else if (level.multiTargetPortals) ld.rng_script = [];   // random portals exist but this run uses none
		level = E.prepareLevel(ld);
		C.writeAtomic(dataFile, JSON.stringify(ld));
		const r = C.replay(level, masks);
		// what to check when it does not finish: the other start mode, else the file itself
		const advice = () => startHint() || (` Check that the .eetas belongs to this level` +
			(odd ? ` (it contains ${odd} bytes that are not inputs eeo-tas writes, e.g. line breaks; EEO plays them as inputs too)` : '') + '.');
		if (r.complete < 0 && rng.draws && rng.chance === 0) {
			const lo = rng.drawsMin || 1, hi = Math.max(lo, rng.drawsMax || 1);
			const n = lo === hi ? `${lo} random exit choice${lo === 1 ? '' : 's'}` : `${lo} to ${hi} random exit choices (depending on the exits taken)`;
			throw new Error(`the TAS goes through random portals (${n}${rng.truncated ? ', outcome tree truncated' : ''}) but no combination of exits lets it ` +
				`finish this level when started ${START_MODES[start]}.${advice()}`);
		}
		if (r.complete < 0) {
			throw new Error(`the TAS does not finish this level${startMatters ? ` when started ${START_MODES[start]}` : ''}: after all ${masks.length} ticks ` +
				`the ball is at tile (${r.end.x}, ${r.end.y}) with ${r.coins} coins${r.deaths ? `, died ${r.deaths} time(s)` : ''}.${advice()}`);
		}
		const best = masks.slice(0, r.complete);
		C.writeEetas(path.join(dir, 'best.eetas'), best);
		C.writeEetas(path.join(dir, `best_${r.runTicks}.eetas`), best);
		const meta = {
			id, levelId: lid, name: String(name || p.name || slug(eelvlName)).slice(0, 80), created: Date.now(),
			level: { name: p.name || '', owner: p.owner || '', file: eelvlName || 'level.eelvl', width: p.width, height: p.height,
				compression: p.compression, warnings: p.warnings.slice(0, 20) },
			tas: { file: eetasName || 'input.eetas', ticks: masks.length, completeTick: r.complete, runTicks: r.runTicks, time: fmt(r.runTicks),
				timerStart: r.timerStart, coins: r.coins, blueCoins: r.blueCoins, deaths: r.deaths, oddBytes: odd },
			rng: { chance: rng.draws ? rng.chance : 1, uses: rng.uses, truncated: rng.truncated },
			// how the TAS was started in eeo-tas (level JSON start_mode); it only changes anything when startMatters
			startMode: start, startMatters, spawns: level.spawnsX.length, timeDoors: !!level.hasTimeDoors,
		};
		C.writeJSON(path.join(dir, 'meta.json'), meta);
		C.writeJSON(path.join(dir, 'status.json'), { state: 'new', bestRunTicks: r.runTicks, chance: meta.rng.chance, history: [], updated: Date.now() });
		return meta;
	} catch (e) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
		try { fs.unlinkSync(dataFile); } catch (e2) { /* ignore */ }
		throw e;
	}
}

// ---------------------------------------------------------------- summaries
function focusState(id) {
	const f = C.readJSON(path.join(jobDir(id), 'focus.json'), null);
	if (!f) return { running: false };
	f.running = f.state === 'running' && pidAlive(f.pid);
	if (f.state === 'running' && !f.running) f.state = 'stopped';
	return f;
}
function inboxPending(id) {
	try { return fs.readdirSync(path.join(jobDir(id), 'inbox')).filter((f) => f.endsWith('.eetas')).length; } catch (e) { return 0; }
}
/** the last n lines of grind.log (reads only the end of the file: it grows for as long as a job runs) */
function logTail(id, n) {
	let fd = -1;
	try {
		const f = path.join(jobDir(id), 'grind.log');
		const size = fs.statSync(f).size;
		const len = Math.min(size, Math.max(16384, n * 400));
		const buf = Buffer.alloc(len);
		fd = fs.openSync(f, 'r');
		fs.readSync(fd, buf, 0, len, size - len);
		const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
		if (len < size) lines.shift();   // probably a partial first line
		return lines.slice(-n);
	} catch (e) { return []; } finally { if (fd >= 0) fs.closeSync(fd); }
}
/** Everything the web app and `tas.js status` show about a job. extraPid: a grind the caller started itself. */
function summary(id, extraPid) {
	const dir = jobDir(id);
	const meta = C.readJSON(path.join(dir, 'meta.json'), {});
	const st = C.readJSON(path.join(dir, 'status.json'), {});
	const pid = runningPid(id) || (extraPid && pidAlive(extraPid) ? extraPid : 0);
	const orig = meta.tas ? meta.tas.runTicks : 0;
	const bestTicks = st.bestRunTicks || orig;
	let bestVersion = '';   // changes whenever best.eetas is replaced (the viewer's "newer version found")
	try { const s = fs.statSync(path.join(dir, 'best.eetas')); bestVersion = `${Math.round(s.mtimeMs)}-${s.size}`; } catch (e) { /* none */ }
	// the "Finish run" report describes the best run at that moment; once a faster run replaces it (Resume, try, focus)
	// it is out of date (its time, odds and "Download final" label), so it is not shown until the next Finish
	// (also a run of the same time that is more likely to work replaces the best: then the report's odds are out of date)
	const rep = C.readJSON(path.join(dir, 'report.json'), null);
	const report = rep && rep.runTicks === bestTicks && (st.chance === undefined || rep.chance === undefined || Math.abs(rep.chance - st.chance) < 1e-9) ? rep : null;
	// the live speed (grind.js writes live.json every second): only while the job runs and the file is fresh
	const lv = pid ? C.readJSON(path.join(dir, 'live.json'), null) : null;
	const live = lv && lv.cpu && Date.now() - (+lv.t || 0) < 5000 ? lv : null;
	return { ...meta, startMode: meta.startMode || 'reset', levelId: meta.levelId || C.jobLevelId(id), running: !!pid, pid: pid || null, bestVersion,
		state: pid ? 'running' : (st.state === 'error' ? 'error' : (st.state === 'finished' ? 'finished' : 'stopped')), error: st.error || null,
		best: { runTicks: bestTicks, time: fmt(bestTicks) }, original: { runTicks: orig, time: fmt(orig) },
		savedTicks: orig - bestTicks, history: st.history || [], stage: pid ? (st.stage || '') : '', round: st.rounds || 0,
		coinsOptional: st.coinsOptional, optimizingSince: pid ? st.sessionStarted : null, lastUpdate: st.updated || null, workers: st.workers,
		chance: st.chance !== undefined ? st.chance : (meta.rng ? meta.rng.chance : 1), report, live,
		inbox: inboxPending(id), focus: focusState(id), logTail: logTail(id, 14),
		files: { dir, best: path.join(dir, 'best.eetas'), level: levelJsonOf(id) } };
}
const listJobs = (extraPids) => C.jobIds().map((id) => summary(id, extraPids && extraPids.get(id))).sort((x, y) => (y.created || 0) - (x.created || 0));

/** Finish run: the final report (time saved, random-portal odds in EEO), kept in report.json */
function finishReport(id) {
	const dir = jobDir(id);
	const meta = C.readJSON(path.join(dir, 'meta.json'), {});
	const level = loadJobLevel(id);
	const masks = C.readEetas(path.join(dir, 'best.eetas'));
	const r = C.replay(level, masks);
	const rng = RNG.analyze(level, masks);
	const rep = { finished: Date.now(), runTicks: r.runTicks, time: fmt(r.runTicks), originalRunTicks: meta.tas.runTicks, originalTime: fmt(meta.tas.runTicks),
		savedTicks: meta.tas.runTicks - r.runTicks, coins: r.coins, deaths: r.deaths,
		chance: rng.draws ? rng.chance : 1, originalChance: meta.rng ? meta.rng.chance : 1, uses: rng.uses, truncated: rng.truncated };
	C.writeJSON(path.join(dir, 'report.json'), rep);
	return rep;
}

// ---------------------------------------------------------------- try: hand a candidate run to a job
const brief = (r) => (r ? { runTicks: r.runTicks, time: fmt(r.runTicks), deaths: r.deaths, coins: r.coins, chance: r.chance } : null);
function logLine(id, s) {
	try { fs.appendFileSync(path.join(jobDir(id), 'grind.log'), `[try ${new Date().toTimeString().slice(0, 8)}] ${s}\n`); } catch (e) { /* ignore */ }
}
/**
 * Verifies a candidate (raw .eetas bytes) against the job's best with THE acceptance rule (common.judge, the same
 * as grind.js). Running job: the candidate goes to src/jobs/<id>/inbox/ and the grind decides within seconds
 * (opts.wait = seconds to wait for its verdict). Stopped job: decided here; an accepted run replaces best.eetas and
 * status.json atomically. A candidate that finishes but is not accepted is kept in pieces/ so the grind can
 * still splice its good parts in (at equal states) - partial improvements are not wasted.
 */
async function tryCandidate(id, buf, opts) {
	const o = opts || {};
	const dir = jobDir(id);
	const source = String(o.source || 'try').replace(/[^\w .:@()+-]/g, '').slice(0, 60) || 'try';
	checkTicks(buf.length, 'the candidate .eetas');
	const level = loadJobLevel(id);
	const cand = C.evaluate(level, C.parseEetasBuffer(buf));
	const best = C.evaluate(level, C.readEetas(path.join(dir, 'best.eetas')));
	const res = { job: id, source, candidate: brief(cand), best: brief(best), verdict: C.judge(cand, best, best ? best.deaths : Infinity), accepted: false, handed: false };
	if (!cand) return res;
	if (runningPid(id)) {
		const name = `${stamp()}_${slug(source)}.eetas`;
		C.writeJSON(path.join(dir, 'inbox', name + '.json'), { source, submitted: Date.now() });
		C.writeEetas(path.join(dir, 'inbox', name), cand.ms);
		res.handed = 'inbox'; res.inboxFile = name;
		const until = Date.now() + (+o.wait || 0) * 1000;
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, 500));
			const rec = inboxResult(id, name);
			if (rec) { res.result = rec; res.accepted = !!rec.accepted; break; }
		}
		return res;
	}
	const release = C.lock(path.join(dir, '.lock'));
	try {
		const cur = C.evaluate(level, C.readEetas(path.join(dir, 'best.eetas')));   // re-read under the lock
		const v = C.judge(cand, cur, cur ? cur.deaths : Infinity);
		res.verdict = v; res.best = brief(cur); res.handed = 'direct';
		if (v.accept) {
			const was = cur ? cur.runTicks : cand.runTicks;
			C.writeEetas(path.join(dir, `best_${cand.runTicks}.eetas`), cand.ms);
			C.writeEetas(path.join(dir, 'best.eetas'), cand.ms);
			updateStatus(id, (st) => {
				st.history.push({ t: Date.now(), runTicks: cand.runTicks, saved: was - cand.runTicks, what: `try: ${source}`, chance: cand.chance });
				st.bestRunTicks = cand.runTicks; st.chance = cand.chance; st.updated = Date.now();
			});
			logLine(id, `${source}: ${fmt(was)} -> ${fmt(cand.runTicks)} (-${was - cand.runTicks}) accepted`);
			res.accepted = true;
		} else {
			// (the GPU searcher's runs in pieces/gpu/ with their own cap: they never crowd out runs from try and focus)
			const gpu = /^gpu\b/i.test(source);
			C.writeEetas(path.join(dir, 'pieces', ...(gpu ? ['gpu'] : []), `${stamp()}_${slug(source)}.eetas`), cand.ms);
			prunePieces(id, gpu ? 10 : 30, gpu ? 'gpu' : '');
			logLine(id, `${source}: ${fmt(cand.runTicks)} not accepted (${v.reason}); kept for splicing`);
		}
	} finally { release(); }
	return res;
}
function inboxResult(id, name) {
	let lines = [];
	try { lines = fs.readFileSync(path.join(jobDir(id), 'inbox', 'results.jsonl'), 'utf8').split('\n'); } catch (e) { return null; }
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes(name)) continue;
		try { const r = JSON.parse(lines[i]); if (r.file === name) return r; } catch (e) { /* partial line */ }
	}
	return null;
}
/** keeps the newest `keep` runs in pieces/ (sub 'gpu': pieces/gpu/, the GPU searcher's) */
function prunePieces(id, keep = 30, sub = '') {
	const pd = path.join(jobDir(id), 'pieces', sub);
	let fl = [];
	try { fl = fs.readdirSync(pd).filter((f) => f.endsWith('.eetas')).sort(); } catch (e) { return; }
	for (const f of fl.slice(0, Math.max(0, fl.length - keep))) { try { fs.unlinkSync(path.join(pd, f)); } catch (e) { /* gone */ } }
}

// ---------------------------------------------------------------- where / replay
const CHARS = { empty: ' ', solid: '#', deco: '.', oneway: '=', half: 'h', door: 'D', dot: ':', boost: 'B', liquid: '~', climbable: 'H', spike: 'X',
	fire: 'X', coin: 'o', bluecoin: 'b', coin_taken: ' ', worldportal: 'W', key: 'k', switch: 's', reset: 'r', crown: 'C', complete: 'F',
	checkpoint: 'c', spawn: 'S', effect: 'e', secret: ' ' };
const ARROWCH = { left: '<', right: '>', up: '^', down: 'v' };
/**
 * The state of a run at a time (m:ss.cc run time or tick): position, velocity, tiles around the ball, coins,
 * keys, switches, the inputs before and after, the next events, and an ASCII map (text for terminals and AIs).
 */
function where(level, masks, spec, opts) {
	const o = opts || {};
	const tr = C.replay(level, masks, { trace: true });
	const t = C.tickOf(tr, typeof spec === 'object' ? spec : C.parseTime(spec));
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	for (let k = 0; k < t; k++) { E.applyMask(inp, masks[k]); sim.tick(inp); }
	const W = level.width;
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	const gd = sim.gravity_dir || { x: 0, y: 1 };
	let gx = gd.x | 0, gy = gd.y | 0;
	if (gx === 0 && gy === 0) gy = 1;   // no gravity here (dot, climbable): report the tile below
	const tile = (x, y) => {
		if (x < 0 || y < 0 || x >= W || y >= level.height) return { x, y, id: -1, desc: 'outside the world (solid)' };
		const id = sim.get_tile ? sim.get_tile(x, y) : level.fg[y * W + x];
		const rot = sim.get_tile_number ? sim.get_tile_number(x, y) : 0;
		return { x, y, id, desc: B.describe(id, rot) };
	};
	const keys = (E.COLORS || []).filter((c) => sim.is_key_active && sim.is_key_active(c));
	// active effects (they change what the inputs do: with levitation J thrusts instead of jumping, etc.)
	const effects = [];
	if (sim.in_god_mode) effects.push('god mode (no gravity, no collisions)');
	if (sim.has_levitation) effects.push(`levitation (thrust ${(+sim._current_thrust || 0).toFixed(2)}${sim.is_thrusting ? ', thrusting' : ''}; J thrusts, no jumps)`);
	if (sim.low_gravity) effects.push('low gravity (gravity x0.15)');
	if (sim.speed_boost) effects.push(`speed effect ${sim.speed_boost}${sim.speed_boost === 1 ? ' (run x1.5)' : sim.speed_boost === 2 ? ' (run x0.6)' : ''}`);
	if (sim.jump_boost) effects.push(`jump effect ${sim.jump_boost}${sim.jump_boost === 1 ? ' (jump x1.3)' : sim.jump_boost === 2 ? ' (jump x0.75)' : ''}`);
	if (sim.max_jumps !== 1) effects.push(`multijump ${sim.max_jumps >= 1000 ? 'infinite' : sim.max_jumps}`);
	if (sim.flip_gravity) effects.push(`gravity effect ${sim.flip_gravity}${['', ' (gravity left)', ' (gravity up)', ' (gravity right)', ' (no gravity)'][sim.flip_gravity] || ''}`);
	if (sim.is_invulnerable) effects.push('protection (spikes, fire, toxic and timed effects do not kill)');
	const timed = (on, start, dur, name) => {   // killed at the first tick with level ticks - start > duration
		if (on) effects.push(dur ? `${name} (kills in ${start + Math.floor(dur) + 1 - sim.level_ticks()} ticks)` : `${name} (no timer)`);
	};
	timed(sim.is_cursed, sim._curse_time_start, sim._curse_duration, 'curse');
	timed(sim.is_zombie, sim._zombie_time_start, sim._zombie_duration, 'zombie (run x0.6, jump x0.75, zombie doors)');
	timed(sim.is_on_fire, sim._fire_time_start, sim._fire_duration, 'on fire');
	timed(sim.is_poisoned, sim._poison_time_start, sim._poison_duration, 'poison');
	if (sim.team) effects.push(`team ${sim.team}`);
	const onIds = (m) => { const a = []; if (m) for (const [k, v] of m) if (v === true) a.push(k); return a.sort((x, y) => x - y); };
	const dirName = (x, y) => (x === 0 && y === 1 ? 'down' : x === 0 && y === -1 ? 'up' : x === 1 && y === 0 ? 'right' : x === -1 && y === 0 ? 'left' : 'none');
	const rel = (e) => ({ in: e.t - t, at: e.t, time: fmt(tr.RUN[Math.min(e.t, tr.n)]), kind: e.kind, data: e.data });
	const horizon = o.horizon || 300;
	const upcoming = tr.events.filter((e) => (e.t > t && e.t <= t + horizon && !/^(gravity_changed|land)$/.test(e.kind)) ||
		(e.kind === 'land' && e.t > t && e.t <= t + 120)).map(rel);
	const recent = tr.events.filter((e) => e.t <= t && e.t > t - 100 && e.kind !== 'gravity_changed').map(rel);
	// ASCII map around the ball: '@' ball, '+' path in the next `horizon` ticks, '-' path in the last 100
	const R = o.radius || [14, 7];
	const pathMark = new Map();
	for (let k = Math.max(0, t - 100); k <= Math.min(tr.n, t + horizon); k++) {
		const key = (Math.trunc(tr.Y[k] + 8) >> 4) * W + (Math.trunc(tr.X[k] + 8) >> 4);
		if (k > t) pathMark.set(key, '+'); else if (!pathMark.has(key)) pathMark.set(key, '-');
	}
	const rows = [];
	const xs = cx - R[0], xe = cx + R[0];
	rows.push(`  y \\ x ${xs}..${xe} (| marks every x divisible by 5)`);
	let hdr = '      ';
	for (let x = xs; x <= xe; x++) hdr += x % 5 === 0 ? '|' : ' ';
	rows.push(hdr);
	for (let y = cy - R[1]; y <= cy + R[1]; y++) {
		let s = String(y).padStart(5) + ' ';
		for (let x = xs; x <= xe; x++) {
			if (x < 0 || y < 0 || x >= W || y >= level.height) { s += '#'; continue; }
			if (x === cx && y === cy) { s += '@'; continue; }
			const id = sim.get_tile ? sim.get_tile(x, y) : level.fg[y * W + x];
			const k = B.kindOf(id);
			let ch = k.kind === 'arrow' ? ARROWCH[k.dir] : k.kind === 'portal' ? 'P' : (CHARS[k.kind] !== undefined ? CHARS[k.kind] : '?');
			if (ch === ' ' || ch === '.') ch = pathMark.get(y * W + x) || ch;
			s += ch;
		}
		rows.push(s);
	}
	return {
		tick: t, runTicks: sim.run_ticks, time: fmt(sim.run_ticks), timerStart: tr.timerStart, finishTick: tr.complete, finishTime: fmt(tr.runTicks),
		pos: { x: sim.px, y: sim.py, tileX: +(sim.px / 16).toFixed(3), tileY: +(sim.py / 16).toFixed(3) },
		centreTile: { x: cx, y: cy },
		speed: { x: sim.speed_x, y: sim.speed_y },
		onGround: !!sim.on_ground, dead: !!sim.is_dead, gravity: dirName(gx, gy), jumpCount: sim.jump_count, maxJumps: sim.max_jumps,
		coins: sim.coins, blueCoins: sim.blue_coins, deaths: sim.deaths, crown: !!sim.has_crown, keys, effects,
		switches: { purple: onIds(sim._switches), orange: onIds(sim._oswitches) },
		// ahead: the next tile in the horizontal direction of motion (null when not moving sideways)
		tiles: { centre: tile(cx, cy), below: tile(cx + gx, cy + gy), ahead: sim.speed_x !== 0 ? tile(cx + (sim.speed_x > 0 ? 1 : -1), cy) : null },
		inputs: { last30: C.inputRuns(masks, t - 30, t), next100: C.inputRuns(masks, t, t + 100), next: C.maskName(masks[t] || 0) },
		recent, upcoming, map: rows,
	};
}

/** Summary + timeline of a run (coins, random portals, deaths, keys, switches, checkpoints, finish) + portal odds. */
function replayInfo(level, masks) {
	const tr = C.replay(level, masks, { trace: true });
	const rng = RNG.analyze(level, masks.slice(0, tr.complete >= 0 ? tr.complete : masks.length));
	const tl = [];
	let coin = 0, draws = 0;
	const drawAt = new Map();   // tick -> random-portal use (rng.js: exits, how many still finish)
	for (const u of rng.uses || []) drawAt.set(u.tick, u);
	for (const e of tr.events) {
		const d = e.data || {};
		const at = { tick: e.t, time: fmt(tr.RUN[Math.min(e.t, tr.n)]) };
		if (e.kind === 'coin' || e.kind === 'blue_coin') tl.push({ ...at, kind: e.kind, n: e.kind === 'coin' ? ++coin : undefined, tile: d.tile });
		else if (e.kind === 'portal') {
			const u = drawAt.get(e.t);
			if (u) draws++;
			tl.push({ ...at, kind: 'portal', from: d.from, to: d.to, random: u ? { exits: u.exits, working: u.working } : false });
		} else if (/^(death|checkpoint|key|key_expired|switch|crown|complete|secret)$/.test(e.kind)) tl.push({ ...at, kind: e.kind, data: d });
	}
	return { ticks: masks.length, complete: tr.complete, runTicks: tr.runTicks, time: fmt(tr.runTicks), timerStart: tr.timerStart,
		coins: tr.coins, blueCoins: tr.blueCoins, deaths: tr.deaths, randomPortals: draws,
		chance: rng.draws ? rng.chance : 1, rngUses: rng.uses, truncated: rng.truncated, timeline: tl };
}

/** PNG of the level around the run's path from..to (parseTime specs); returns { png, ... } (see render.js) */
function renderJob(level, levelJson, masks, fromSpec, toSpec, opts) {
	const R = require('./render.js');
	const tr = C.replay(level, masks, { trace: true });
	const from = C.tickOf(tr, C.parseTime(fromSpec === undefined || fromSpec === '' ? 'start' : fromSpec));
	const to = C.tickOf(tr, C.parseTime(toSpec === undefined || toSpec === '' ? 'end' : toSpec));
	if (to < from) throw new Error('the end of the range is before its start');
	const o = opts || {};
	const title = `${o.name || ''}  ${fmt(tr.RUN[from])}-${fmt(tr.RUN[to])} (TICKS ${from}-${to})  FINISH ${fmt(tr.runTicks)}`;
	const num = (v) => (Number.isFinite(v) ? v : undefined);   // ?margin=abc / --margin= (NaN) -> the default
	const out = R.renderPath({ levelJson, trace: tr, from, to, title, fmt: (t) => fmt(tr.RUN[t]), margin: num(o.margin), scale: num(o.scale) });
	return Object.assign(out, { from, to, fromTime: fmt(tr.RUN[from]), toTime: fmt(tr.RUN[to]) });
}

// ---------------------------------------------------------------- probe: test a hand-written idea exactly
const MASK_BITS = { J: 1, L: 2, R: 4, U: 8, D: 16 };
const MAX_PROBE_INPUTS = 100000;   // 1000 s of play: far more than any idea (the probe replays them synchronously)
/** "R+J x3, R x20, - x5" (the format `where` prints) -> masks. Also "R+J*3", "R 20" is not accepted (use x). */
function parseInputs(spec) {
	const out = [];
	for (const raw of String(spec).split(/[,;\n]+/)) {
		const tok = raw.trim();
		if (!tok) continue;
		const m = tok.match(/^([-LRUDJ+ ]+?|none)\s*(?:[x*]\s*(\d+))?$/i);
		if (!m) throw new Error(`bad input "${tok}": use e.g. "R+J x3, R x20, - x5" (L left, R right, U up, D down, J jump, - nothing)`);
		let mask = 0;
		const name = m[1].trim().toUpperCase();
		if (name !== '-' && name !== 'NONE') for (const p of name.split('+')) { const b = MASK_BITS[p.trim()]; if (!b) throw new Error(`bad key "${p}" in "${tok}"`); mask |= b; }
		const n = m[2] ? +m[2] : 1;
		if (out.length + n > MAX_PROBE_INPUTS) throw new Error(`too many inputs (${out.length + n} ticks or more; at most ${MAX_PROBE_INPUTS} per probe)`);
		for (let k = 0; k < n; k++) out.push(mask);
	}
	return out;
}
/**
 * Plays `inputs` (masks) from the exact state of the best run at time `at`, then tries to rejoin the best run
 * EXACTLY (stateHash equal to the best run's state at a later tick): directly during the inputs, or by continuing
 * with the best run's own inputs from any nearby offset. A rejoin is a proven shortcut; the candidate run
 * (best[0..t0) + inputs + best[...]) is verified by a full replay. Returns what happened (also when it fails:
 * where the inputs ended up and the closest reference state).
 */
/** The reference data probe() needs (trace, exact state hashes, a snapshot per tick). Build it once and pass it
 *  as opts.ctx to probe many variants of the same run quickly. */
function probeContext(level, best, nocoins) {
	const NC = !!nocoins;
	const tr = C.replay(level, best, { trace: true });
	const n = tr.complete >= 0 ? tr.complete : best.length;
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const hashTick = new Map();   // exact state -> the LAST reference tick in that state
	const snaps = new Array(n + 1);
	snaps[0] = sim.snapshot();
	hashTick.set(sim.stateHash(false, NC), 0);
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, best[t]); sim.tick(inp);
		snaps[t + 1] = sim.snapshot();
		hashTick.set(sim.stateHash(false, NC), t + 1);
	}
	return { level, best, NC, tr, n, hashTick, snaps };
}
function probe(level, best, atSpec, inputs, opts) {
	const o = opts || {};
	const ctx = o.ctx && o.ctx.best === best && o.ctx.level === level && o.ctx.NC === !!o.nocoins ? o.ctx : probeContext(level, best, o.nocoins);
	const { NC, tr, n, hashTick } = ctx;
	// (clamped: a huge horizon / shift from the API would only block the server)
	const H = Math.max(1, Math.min(n + 1, o.horizon || 400)), SH = Math.max(0, Math.min(n + 1, o.shift === undefined ? 90 : o.shift | 0));
	const t0 = Math.min(n, C.tickOf(tr, typeof atSpec === 'object' ? atSpec : C.parseTime(atSpec)));
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	const snap0 = ctx.snaps[t0];
	let dead = false, done = false;
	sim.onEvent = (k) => { if (k === 'death') dead = true; else if (k === 'complete') done = true; };
	let bestHit = null;   // { saved, seq (inputs after t0), j }
	const consider = (seq, cur, allowLoss) => {
		const j = hashTick.get(sim.stateHash(false, NC));
		if (j === undefined || j < t0 || (!allowLoss && j <= cur)) return;
		if (!bestHit || j - cur > bestHit.saved) bestHit = { saved: j - cur, seq: seq.slice(), j, via: '' };
	};
	// where the inputs first differ from the best run's own (before that, "rejoins" are trivially the best run itself)
	let dv = -1;
	for (let k = 0; k < inputs.length; k++) if (t0 + k >= n || inputs[k] !== best[t0 + k]) { dv = k; break; }
	// 1) the inputs themselves (after the divergence, also rejoins that gain nothing or lose time: reported, not handed in)
	sim.restore(snap0);
	const played = [];
	let finishedIn = -1;
	for (let k = 0; k < inputs.length && !dead; k++) {
		E.applyMask(inp, inputs[k]); sim.tick(inp); played.push(inputs[k]);
		if (done) { finishedIn = k + 1; break; }
		if (dv >= 0 && k >= dv) consider(played, t0 + k + 1, true);
	}
	const endState = { tick: t0 + played.length, x: sim.px, y: sim.py, vx: sim.speed_x, vy: sim.speed_y, dead: dead || sim.is_dead };
	// closest reference state (position + 3 x velocity), a hint when nothing rejoins
	let near = null;
	for (let j = t0; j <= n; j++) {
		const d = Math.abs(sim.px - tr.X[j]) + Math.abs(sim.py - tr.Y[j]) + 3 * (Math.abs(sim.speed_x - tr.VX[j]) + Math.abs(sim.speed_y - tr.VY[j]));
		if (!near || d < near.d) near = { j, d, time: fmt(tr.RUN[j]) };
	}
	// 2) continue with the best run's inputs from offsets around where the inputs ended
	const snapEnd = sim.snapshot();
	const tp = t0 + played.length;
	if (finishedIn < 0 && !endState.dead) {
		for (let s = -SH; s <= SH; s++) {
			const j0 = tp + s;
			if (j0 < t0 || j0 >= n || (dv < 0 && s === 0)) continue;   // (the unchanged best run itself)
			sim.restore(snapEnd); dead = false; done = false;
			const seq = played.slice();
			for (let k = 0; k < H && j0 + k < n && !dead; k++) {
				E.applyMask(inp, best[j0 + k]); sim.tick(inp); seq.push(best[j0 + k]);
				if (done) { const saved = n - (t0 + seq.length); if (!bestHit || saved > bestHit.saved) bestHit = { saved, seq: seq.slice(), j: n, via: `best run from tick ${j0}`, finish: true }; break; }
				const before = bestHit;
				consider(seq, t0 + seq.length, false);   // only real shortcuts here (shifted inputs often match trivially)
				if (bestHit !== before) bestHit.via = `best run from tick ${j0}`;
			}
		}
	}
	const res = { at: t0, atTime: fmt(tr.RUN[t0]), inputs: inputs.length, played: played.length, differsAt: dv < 0 ? null : t0 + dv,
		finishedDuringInputs: finishedIn >= 0, end: endState, nearest: near,
		reference: { runTicks: tr.runTicks, time: fmt(tr.runTicks) }, rejoin: null, candidate: null };
	let full = null;   // a candidate only when it can be faster (a finish during the inputs, or a rejoin that saves ticks)
	if (finishedIn >= 0) full = Array.from(best.slice(0, t0)).concat(played);
	else if (bestHit && bestHit.saved > 0) full = Array.from(best.slice(0, t0)).concat(bestHit.seq, bestHit.finish ? [] : Array.from(best.slice(bestHit.j, n)));
	if (bestHit) res.rejoin = { refTick: bestHit.j, saved: bestHit.saved, via: bestHit.via || 'the inputs themselves', finish: !!bestHit.finish };
	if (full) {
		const ev = C.evaluate(level, Uint8Array.from(full));
		res.candidate = ev ? { runTicks: ev.runTicks, time: fmt(ev.runTicks), saved: tr.runTicks - ev.runTicks, deaths: ev.deaths, chance: ev.chance, masks: ev.ms } : null;
	}
	return res;
}

// ---------------------------------------------------------------- focus: search one window harder
function runTool(script, args, log) {
	return new Promise((res) => {
		const p = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
			env: C.heapEnv(8000) });
		const onData = (d) => { for (const line of String(d).split(/\r?\n/)) if (line.trim() && !line.startsWith('[ticks] ')) log(line); };   // ([ticks]: the live speed, not for the log)
		p.stdout.on('data', onData); p.stderr.on('data', onData);
		p.on('close', (code) => res(code));
	});
}
/**
 * Runs explore.js --exact=1 (new routes that rejoin the run exactly), shortcuts.js (dense local shortcuts) and
 * mutate.js on the window [from, to] of the job's best run, splices everything, and hands every result that
 * finishes to the job with tryCandidate (inbox if it runs, else decided directly). from/to: parseTime specs.
 */
async function focus(id, fromSpec, toSpec, seconds, opts) {
	const o = opts || {};
	const log = o.log || ((s) => console.log(s));
	const dir = jobDir(id);
	const lid = C.jobLevelId(id);
	const level = loadJobLevel(id);
	const ts = stamp();
	const fd = path.join(dir, 'focus', ts);
	const ref = path.join(fd, 'ref.eetas');
	const refMasks = C.readEetas(path.join(dir, 'best.eetas'));
	const tr = C.replay(level, refMasks, { trace: true });
	const from = C.tickOf(tr, C.parseTime(fromSpec)), to = C.tickOf(tr, C.parseTime(toSpec));
	if (!(to > from)) throw new Error(`empty window: ${fromSpec} (tick ${from}) .. ${toSpec} (tick ${to})`);
	fs.mkdirSync(fd, { recursive: true });   // (after the check: a refused window leaves no empty focus/<stamp>/ behind)
	C.writeEetas(ref, refMasks);
	const S = Math.max(10, Math.min(3600, +seconds || 120));
	const running = !!runningPid(id);
	const Wk = Math.max(1, Math.min(os.cpus().length, +o.workers || (running ? Math.max(1, Math.floor(os.cpus().length / 2)) : os.cpus().length)));
	const st = C.readJSON(path.join(dir, 'status.json'), {});
	const NC = st.coinsOptional !== undefined ? (st.coinsOptional ? 1 : 0)
		: (C.coinsIrrelevant(levelJsonOf(id), refMasks, { complete: tr.complete, runTicks: tr.runTicks }) ? 1 : 0);
	const fstate = { state: 'running', pid: process.pid, started: Date.now(), from, to, fromTime: fmt(tr.RUN[from]), toTime: fmt(tr.RUN[to]), seconds: S,
		workers: Wk, bestBefore: tr.runTicks, dir: fd };
	C.writeJSON(path.join(dir, 'focus.json'), fstate);
	log(`[focus] ${id}: ticks ${from}-${to} (${fmt(tr.RUN[from])}-${fmt(tr.RUN[to])}) of best ${fmt(tr.runTicks)}, ${S} s per search, ${Wk} workers` +
		`${running ? ' (the job is running: sharing the CPU)' : ''}, coins ${NC ? 'optional' : 'needed'}`);
	const outs = [];
	const lvl = `--level=${lid}`;
	const exp = path.join(fd, 'explore.eetas');
	fstate.stage = 'explore'; C.writeJSON(path.join(dir, 'focus.json'), fstate);
	await runTool('explore.js', [`--tas=${ref}`, `--out=${exp}`, `--from=${Math.max(0, from - 10)}`, `--join=${Math.max(0, from - 10)}`, `--until=${Math.min(tr.n, to + 80)}`,
		`--seconds=${S}`, `--workers=${Wk}`, '--exact=1', '--roll=100', `--seed=${(Date.now() % 100000) | 0}`, '--cell=8', '--vcell=2', '--ahead=0.5',
		`--nocoins=${NC}`, '--maxEntries=1500000', lvl], (s) => log('  ' + s));
	if (fs.existsSync(exp)) outs.push(exp);
	const sc = path.join(fd, 'shortcuts.eetas');
	fstate.stage = 'shortcuts'; C.writeJSON(path.join(dir, 'focus.json'), fstate);
	await runTool('shortcuts.js', [`--tas=${ref}`, `--out=${sc}`, `--from=${Math.max(0, from - 10)}`, `--to=${to}`, '--step=3', '--depth=160', '--cap=2500',
		'--dist=24', '--bcap=8', `--workers=${Wk}`, lvl, `--nocoins=${NC}`, `--deadline=${Date.now() + S * 1000}`], (s) => log('  ' + s));
	if (fs.existsSync(sc)) outs.push(sc);
	const mu = path.join(fd, 'mutate.eetas');
	fstate.stage = 'mutate'; C.writeJSON(path.join(dir, 'focus.json'), fstate);
	await runTool('mutate.js', [`--tas=${ref}`, `--out=${mu}`, `--from=${Math.max(0, from - 10)}`, `--to=${to}`, '--horizon=800', `--workers=${Wk}`, lvl,
		`--nocoins=${NC}`, `--deadline=${Date.now() + Math.min(S, 120) * 1000}`], (s) => log('  ' + s));
	if (fs.existsSync(mu)) outs.push(mu);
	const handed = [];
	if (outs.length) {
		const sp = path.join(fd, 'splice.eetas');
		fstate.stage = 'splice'; C.writeJSON(path.join(dir, 'focus.json'), fstate);
		await runTool('splice.js', [sp, ref, ...outs, lvl, ...(NC ? ['--nocoins'] : [])], (s) => log('  ' + s));
		const cands = (fs.existsSync(sp) ? [sp] : []).concat(outs);
		const seen = new Set();
		for (const f of cands) {
			const ev = C.evaluate(level, C.readEetas(f), false);
			if (!ev || ev.runTicks >= tr.runTicks) continue;
			const key = C.eetasBytes(ev.ms).toString('latin1');
			if (seen.has(key)) continue;   // the splice often equals one of the inputs
			seen.add(key);
			const now = C.readJSON(path.join(dir, 'status.json'), {}).bestRunTicks;
			if (now && ev.runTicks > now && handed.length) continue;   // an earlier candidate of this search already did better
			const r = await tryCandidate(id, fs.readFileSync(f), { source: `focus ${fmt(tr.RUN[from])}-${fmt(tr.RUN[to])} ${path.basename(f, '.eetas')}`, wait: o.wait === undefined ? 20 : o.wait });
			handed.push({ file: f, runTicks: ev.runTicks, time: fmt(ev.runTicks), handed: r.handed, accepted: r.accepted, verdict: r.verdict });
			log(`[focus] ${path.basename(f)}: ${fmt(ev.runTicks)} (-${tr.runTicks - ev.runTicks} vs the reference) -> ${r.handed === 'inbox' ? 'inbox of the running job' : 'job'}: ` +
				`${r.accepted ? 'ACCEPTED' : (r.result ? 'not accepted' : (r.handed === 'inbox' ? 'waiting for the grind' : 'not accepted'))}` +
				`${!r.accepted && r.verdict && !r.verdict.accept ? ' (' + r.verdict.reason + ')' : ''}`);
		}
	}
	if (!handed.length) log('[focus] nothing faster found in this window');
	const after = C.readJSON(path.join(dir, 'status.json'), {}).bestRunTicks;
	Object.assign(fstate, { state: 'done', stage: '', finished: Date.now(), handed, bestAfter: after, found: handed.length ? Math.min(...handed.map((h) => h.runTicks)) : null });
	C.writeJSON(path.join(dir, 'focus.json'), fstate);
	log(`[focus] done: best of this search ${fstate.found ? fmt(fstate.found) : '-'}; the job's best is now ${fmt(after)}`);
	return fstate;
}

// ---------------------------------------------------------------- text output (tas.js and ?format=text)
const sgn = (v) => (v > 0 ? '+' : '') + (+v).toFixed(3);
function evText(e) {
	const d = e.data || {};
	const tile = (p) => (p ? `(${p.x}, ${p.y})` : '');
	switch (e.kind) {
		case 'coin': case 'blue_coin': return `${e.kind.replace('_', ' ')} at ${tile(d.tile)}`;
		case 'portal': return `portal ${tile(d.from)} -> ${tile(d.to)}`;
		case 'key': return `${d.color} key at ${tile(d.tile)}`;
		case 'switch': return `${d.kind} switch ${d.id} ${d.on ? 'on' : 'off'}`;
		case 'checkpoint': case 'crown': case 'complete': case 'secret': return `${e.kind} at ${tile(d.tile)}`;
		case 'death': case 'respawn': case 'jump': return `${e.kind}${d.pos ? ` at tile (${(d.pos.x / 16).toFixed(2)}, ${(d.pos.y / 16).toFixed(2)})` : ''}`;
		case 'land': return `land (impact speed ${d.impact_speed !== undefined ? (+d.impact_speed).toFixed(2) : '?'})`;
		case 'effect': return `${d.effect || 'effect'} ${d.on ? 'on' : 'off'}${d.tile ? ' at ' + tile(d.tile) : ''}`;
		case 'team': return `team ${d.from} -> ${d.team}${d.tile ? ' at ' + tile(d.tile) : ''}`;
		case 'tick_aborted': return `tick aborted: ${d.reason} #${d.note} at ${tile(d.tile)} has no sound (eeo-tas throws; the run timer and auto-align skip this tick)`;
		default: return e.kind;
	}
}
function formatWhere(w) {
	const L = [];
	L.push(`tick ${w.tick} = run time ${w.time}   (timer starts at tick ${w.timerStart}; finish at tick ${w.finishTick} = ${w.finishTime})`);
	L.push(`position   tile (${w.pos.tileX}, ${w.pos.tileY}) = px (${w.pos.x}, ${w.pos.y})  [top-left of the 16x16 box; centre tile (${w.centreTile.x}, ${w.centreTile.y})]`);
	L.push(`velocity   x ${sgn(w.speed.x)}  y ${sgn(w.speed.y)} px/tick   ${w.onGround ? 'on ground' : 'airborne'}${w.dead ? ', DEAD' : ''}, gravity ${w.gravity}, ` +
		`jumps used ${w.jumpCount}/${w.maxJumps >= 1000 ? 'inf' : w.maxJumps}`);
	L.push(`tiles      centre ${w.tiles.centre.desc}`);
	L.push(`           below  ${w.tiles.below.desc}  at (${w.tiles.below.x}, ${w.tiles.below.y})`);
	L.push(`           ahead  ${w.tiles.ahead ? `${w.tiles.ahead.desc}  at (${w.tiles.ahead.x}, ${w.tiles.ahead.y})` : '-  (not moving sideways)'}`);
	L.push(`state      coins ${w.coins}, blue coins ${w.blueCoins}, deaths ${w.deaths}${w.crown ? ', crown' : ''}, keys [${w.keys.join(', ')}], ` +
		`purple switches on [${w.switches.purple.join(', ')}], orange [${w.switches.orange.join(', ')}]`);
	if (w.effects && w.effects.length) L.push(`effects    ${w.effects.join(', ')}`);
	L.push(`inputs     last 30 ticks: ${w.inputs.last30 || '-'}`);
	L.push(`           next 100 ticks: ${w.inputs.next100 || '-'}   (L left, R right, U up, D down, J jump, - nothing)`);
	L.push('recent     ' + (w.recent.length ? w.recent.slice(-8).map((e) => `${e.in} ticks: ${evText(e)}`).join('; ') : '-'));
	L.push('next       ' + (w.upcoming.length ? w.upcoming.slice(0, 14).map((e) => `+${e.in} (${e.time}) ${evText(e)}`).join('; ') : '-'));
	L.push('map        @ ball, + path in the next 3 s, - last 1 s, # solid, = one-way, < > ^ v arrows, : dot, P portal, o coin, b blue coin,');
	L.push('           D door/gate, k key, s switch, ~ liquid, H climbable, X spike/fire, B boost, F finish, c checkpoint, e effect, . deco');
	for (const r of w.map) L.push('  ' + r);
	return L.join('\n') + '\n';
}
function formatReplay(r, name) {
	const L = [];
	L.push(`${name || 'run'}: ${r.ticks} ticks, ${r.complete >= 0 ? `finishes at tick ${r.complete}, run time ${r.time} (run_ticks ${r.runTicks})` : 'DOES NOT FINISH'}; ` +
		`timer starts at tick ${r.timerStart}; coins ${r.coins}, blue ${r.blueCoins}, deaths ${r.deaths}`);
	if (r.randomPortals || r.rngUses.length) {
		L.push(`random portals: ${r.rngUses.length} random exit(s) used; works in ${pct(r.chance)} of EEO plays${r.truncated ? ' (outcome tree truncated)' : ''}`);
		for (const u of r.rngUses) L.push(`  ${u.time} (tick ${u.tick}): portal at (${u.from ? u.from.x + ', ' + u.from.y : '?'}) has ${u.exits} exits, ${u.working} of them still finish`);
	} else L.push('random portals: none used (works every time)');
	L.push('timeline:');
	for (const e of r.timeline) {
		let s = `  ${e.time.padStart(8)}  tick ${String(e.tick).padStart(6)}  `;
		if (e.kind === 'coin' || e.kind === 'blue_coin') s += `${e.kind === 'coin' ? `coin ${e.n}` : 'blue coin'} at (${e.tile.x}, ${e.tile.y})`;
		else if (e.kind === 'portal') s += `portal (${e.from.x}, ${e.from.y}) -> (${e.to.x}, ${e.to.y})${e.random ? `  RANDOM: ${e.random.exits} exits, ${e.random.working} finish` : ''}`;
		else s += evText({ kind: e.kind, data: e.data });
		L.push(s);
	}
	return L.join('\n') + '\n';
}
/** 12400000 -> "12.4 M ticks/s", 153000000 -> "153 M ticks/s" */
const rateText = (x) => (x > 0 ? `${(x / 1e6).toFixed(x >= 1e8 ? 0 : 1)} M ticks/s` : '-');
/** 4.2e9 -> "4.2 billion" */
function countText(n) {
	for (const [v, w] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million']]) if (n >= v) return `${(n / v).toFixed(n >= v * 100 ? 0 : 1)} ${w}`;
	return String(Math.round(n || 0));
}
/** summary().live -> "12.4 M ticks/s on the CPU (Intel Core i7-11800H, 8 threads) + ... on the GPU (...) = ...; 4.2 billion ticks simulated this session" */
function liveText(lv) {
	const c = lv.cpu || {}, g = lv.gpu;
	let s = `${rateText(c.ticksPerSec)} on the CPU (${C.cpuName(c.model)}, ${c.threads} thread${c.threads === 1 ? '' : 's'})`;
	if (g) s += ` + ${rateText(g.ticksPerSec)} on the GPU (${g.name || 'GPU'}) = ${rateText((c.ticksPerSec || 0) + (g.ticksPerSec || 0))}`;
	return `${s}; ${countText((c.ticks || 0) + ((g && g.ticks) || 0))} ticks simulated this session`;
}
function formatStatus(s) {
	const L = [];
	const since = s.optimizingSince ? new Date(s.optimizingSince).toTimeString().slice(0, 5) : '-';   // (- until the grind's first status)
	L.push(`${s.name}  (${s.id})  ${s.running ? `RUNNING pid ${s.pid}, ${s.workers || '?'} workers, since ${since}, round ${s.round}, now: ${s.stage || '-'}` : s.state.toUpperCase()}`);
	if (s.live) L.push(`speed now  ${liveText(s.live)}`);
	if (s.error) L.push(`error: ${s.error}`);
	L.push(`level      ${s.level ? `${s.level.name} by ${s.level.owner || '?'} ${s.level.width}x${s.level.height} (${s.level.file})` : '?'}; data ${s.files.level}`);
	L.push(`start      TAS started ${START_MODES[s.startMode] || s.startMode} in eeo-tas` + (s.startMatters === false ? ' (makes no difference on this level: one spawn point, no time doors)'
		: s.startMatters ? ` (matters here: ${s.spawns >= 2 ? `${s.spawns} spawn points` : ''}${s.spawns >= 2 && s.timeDoors ? ', ' : ''}${s.timeDoors ? 'time doors' : ''}${!(s.spawns >= 2) && !s.timeDoors ? 'the start states differ' : ''})` : ''));
	L.push(`times      original ${s.original.time} (${s.original.runTicks}) -> best ${s.best.time} (${s.best.runTicks}): ` +
		(s.savedTicks > 0 ? `-${(s.savedTicks / 100).toFixed(2)} s (${s.savedTicks} ticks, ${(100 * s.savedTicks / s.original.runTicks).toFixed(2)}%)` : 'no improvement yet'));
	L.push(`odds       ${s.chance < 1 ? `random portals: finishes in ${pct(s.chance)} of EEO plays (never lowered)` : 'no random portals on the route (works every time)'}; ` +
		`coins ${s.coinsOptional === undefined ? '?' : s.coinsOptional ? 'optional (coin-blind search)' : 'needed'}`);
	L.push(`inbox      ${s.inbox} pending`);
	const f = s.focus || {};
	if (f.state) L.push(`focus      ${f.state}${f.stage ? ' (' + f.stage + ')' : ''}: ${f.fromTime}-${f.toTime} (ticks ${f.from}-${f.to}), ${f.seconds} s` +
		(f.state === 'done' ? `, found ${f.found ? fmt(f.found) : 'nothing faster'}` : ''));
	L.push(`files      ${s.files.dir}  (best.eetas, status.json, grind.log, inbox/, pieces/)`);
	const h = (s.history || []).slice(-8);
	if (h.length) {
		L.push('improvements (latest last):');
		for (const p of h) L.push(`  ${new Date(p.t).toTimeString().slice(0, 8)}  -${p.saved} -> ${fmt(p.runTicks)}  ${p.what}`);
	}
	if (s.logTail.length) { L.push('log:'); for (const l of s.logTail.slice(-10)) L.push('  ' + l); }
	return L.join('\n') + '\n';
}

module.exports = {
	formatWhere, formatReplay, formatStatus, evText, liveText,
	JOBS, DATA, RUNNING_FILE, jobDir, slug, resolve, levelJsonOf, loadJobLevel, pct,
	pidAlive, runningPid, killTree, updateStatus, startJob, stopJob, deleteJob, importJob,
	summary, listJobs, focusState, finishReport, tryCandidate, inboxResult, prunePieces, where, replayInfo, renderJob, focus, logTail,
	parseInputs, probe, probeContext, stamp, START_MODES, normStart,
	MAX_BLOCK_ID, MAX_CELLS, MAX_TICKS, MAX_PROBE_INPUTS,
};
