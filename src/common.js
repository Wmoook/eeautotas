'use strict';
// Shared helpers for every tool, the web app and the CLI:
// - .eetas files as RAW BYTES with eeo-tas semantics (one byte per tick, mask = (byte - 48) & 31; nothing is
//   trimmed or skipped, see docs/eeo_spec/tick_loop.md section 6.1). Every tool reads and writes runs through
//   readEetas() / writeEetas() so the byte semantics are the same everywhere.
// - atomic file writes (write a temp file, then rename), time formats (m:ss.cc run time or ticks),
// - level lookup by id (src/data/<id>.json, a job id, or inferred from a .eetas inside src/jobs/<id>/),
// - a full replay with a per-tick trace, and the rule that decides if a candidate run replaces the best run.
const fs = require('fs');
const path = require('path');
const E = require('./eesim.js');
const RNG = require('./rng.js');

const SRC = __dirname;
const DATA = path.join(SRC, 'data');
const JOBS = path.join(SRC, 'jobs');

// ---------------------------------------------------------------- .eetas bytes
/** Buffer (raw file bytes) -> Uint8Array of input masks, exactly like eeo-tas reads the file. */
const parseEetasBuffer = E.parseEetasBytes ? (b) => E.parseEetasBytes(b) : (b) => E.parseEetas(b.toString('latin1'));
function readEetas(file) { return parseEetasBuffer(fs.readFileSync(file)); }
/** masks -> the bytes eeo-tas writes ('0' + mask, 48..79). */
function eetasBytes(masks) {
	const b = Buffer.alloc(masks.length);
	for (let i = 0; i < masks.length; i++) b[i] = 48 + (masks[i] & 31);
	return b;
}
function writeEetas(file, masks) { writeAtomic(file, eetasBytes(masks)); }
/** Bytes that are not inputs eeo-tas itself writes (48..79). They still count as ticks in EEO. */
function oddBytes(buf) { let n = 0; for (const x of buf) if (x < 48 || x > 79) n++; return n; }

// ---------------------------------------------------------------- files
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Writes a file so that readers never see a partial file (temp file + rename; retried while Windows has it open). */
function writeAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	fs.writeFileSync(tmp, data);
	for (let k = 0; ; k++) {
		try { fs.renameSync(tmp, file); return; } catch (e) {
			if (k >= 40 || !/EPERM|EBUSY|EACCES/.test(e.code || '')) { try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ } throw e; }
			sleepMs(25);
		}
	}
}
const writeJSON = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 1));
function readJSON(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }

/** A simple cross-process lock (a file created with O_EXCL); stale after `staleMs`. Returns a release function. */
function lock(file, timeoutMs = 20000, staleMs = 120000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const fd = fs.openSync(file, 'wx');
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return () => { try { fs.unlinkSync(file); } catch (e) { /* gone */ } };
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; } } catch (e2) { continue; }
			if (Date.now() - t0 > timeoutMs) throw new Error(`could not lock ${file} (busy)`);
			sleepMs(50);
		}
	}
}

// ---------------------------------------------------------------- time
/** run time (centiseconds = ticks of the in-game timer) -> "m:ss.cc" */
const fmt = (t) => (t == null || t < 0 ? '-' : `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`);
/**
 * "1:10.25" / "1:10" / "70.25s" -> { run: 7025 } (in-game run time, centiseconds);
 * "7025" / "t7025" / "7025t" -> { tick: 7025 } (sim tick index = bytes of the .eetas played); "start" / "end".
 */
function parseTime(s) {
	const v = String(s == null ? '' : s).trim().toLowerCase();
	let m;
	if (v === 'start' || v === 'begin') return { tick: 0 };
	if (v === 'end' || v === 'finish') return { tick: Infinity };
	if ((m = v.match(/^t?(\d+)t?$/))) return { tick: +m[1] };
	if ((m = v.match(/^(\d+):(\d{1,2}(?:\.\d{1,2})?)$/))) return { run: +m[1] * 6000 + Math.round(parseFloat(m[2]) * 100) };
	if ((m = v.match(/^(\d+(?:\.\d{1,2})?)s$/))) return { run: Math.round(parseFloat(m[1]) * 100) };
	throw new Error(`bad time "${s}": use m:ss.cc (run time, e.g. 1:10.25), seconds with s (70.25s) or a tick number (7025)`);
}

// ---------------------------------------------------------------- levels
function jobIds() {
	try { return fs.readdirSync(JOBS).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(JOBS, d, 'meta.json'))); } catch (e) { return []; }
}
/** job id, a unique prefix of one, or a unique part of a job's name -> job id (or null) */
function findJob(q) {
	if (!q) return null;
	const ids = jobIds();
	if (ids.includes(q)) return q;
	let hit = ids.filter((id) => id.startsWith(q));
	if (hit.length === 1) return hit[0];
	const low = String(q).toLowerCase();
	if (hit.length === 0) hit = ids.filter((id) => id.includes(low) || String((readJSON(path.join(JOBS, id, 'meta.json'), {}).name || '')).toLowerCase().includes(low));
	if (hit.length === 1) return hit[0];
	if (hit.length > 1) throw new Error(`"${q}" matches several jobs: ${hit.join(', ')}`);
	return null;
}
const jobLevelId = (id) => readJSON(path.join(JOBS, id, 'meta.json'), {}).levelId || 'job_' + id.replace(/-/g, '_');
/** The job a file lives in (src/jobs/<id>/...), or null. */
function jobOfFile(file) {
	if (!file) return null;
	const rel = path.relative(JOBS, path.resolve(file));
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	const id = rel.split(/[\\/]/)[0];
	return fs.existsSync(path.join(JOBS, id, 'meta.json')) ? id : null;
}
/**
 * The level JSON (eelvl.js toSimLevel format) for --level=<spec>: a level id (src/data/<id>.json), a job id (or
 * a unique prefix / name part), or a path to a .json. Without a spec the level of the job that `tasFile` lives in.
 */
function levelData(spec, tasFile) {
	if (spec) {
		if (/\.json$/i.test(spec) && fs.existsSync(spec)) return path.resolve(spec);
		const f = path.join(DATA, spec + '.json');
		if (fs.existsSync(f)) return f;
		const j = findJob(spec);
		if (j) return path.join(DATA, jobLevelId(j) + '.json');
		let have = [];
		try { have = fs.readdirSync(DATA).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5)); } catch (e) { /* none */ }
		throw new Error(`unknown level "${spec}" (levels: ${have.join(', ') || 'none'}; jobs: ${jobIds().join(', ') || 'none'})`);
	}
	const j = jobOfFile(tasFile);
	if (j) return path.join(DATA, jobLevelId(j) + '.json');
	throw new Error('which level? pass --level=<level id | job id> (or use a .eetas inside src/jobs/<id>/)');
}
const loadLevel = (spec, tasFile) => E.loadLevel(levelData(spec, tasFile));

// ---------------------------------------------------------------- replay
/**
 * Replays masks from the level start. Stops at the finish unless opts.full. Returns
 * { complete (tick index of the finish or -1), runTicks, deaths, coins, blueCoins, ticks (played), timerStart
 *   (first tick the in-game timer counts, -1 if never), end {x, y} (tile of the box's top-left) }
 * With opts.trace also per-tick arrays X, Y, VX, VY (after t ticks; index 0 = the start) and RUN (run timer),
 * and events [{t, kind, data}] (t = the tick it happened in, 1-based = after t inputs).
 */
function replay(level, masks, opts) {
	const o = opts || {};
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const tr = o.trace ? { X: new Float64Array(n + 1), Y: new Float64Array(n + 1), VX: new Float64Array(n + 1), VY: new Float64Array(n + 1),
		RUN: new Int32Array(n + 1) } : null;
	const events = o.trace ? [] : null;
	let complete = -1, deaths = 0, timerStart = -1;
	sim.onEvent = (k, d) => {
		if (k === 'complete' && complete < 0) complete = sim.ticks();
		else if (k === 'death') deaths++;
		if (events !== null && k !== 'door_state') events.push({ t: sim.ticks(), kind: k, data: d });
	};
	const rec = (t) => { tr.X[t] = sim.px; tr.Y[t] = sim.py; tr.VX[t] = sim.speed_x; tr.VY[t] = sim.speed_y; tr.RUN[t] = sim.run_ticks; };
	if (tr) rec(0);
	let t = 0;
	for (; t < n && (complete < 0 || o.full); t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (timerStart < 0 && sim.run_ticks > 0) timerStart = t + 1;
		if (tr) rec(t + 1);
	}
	const r = { complete, runTicks: sim.run_ticks, deaths, coins: sim.coins, blueCoins: sim.blue_coins, ticks: t, timerStart,
		end: { x: Math.round(sim.px / 16), y: Math.round(sim.py / 16) } };
	if (tr) Object.assign(r, tr, { events, n: t });
	return r;
}
/** tick index for a parseTime() value, given a trace (RUN) of the run */
function tickOf(tr, spec) {
	const n = tr.n;
	if (spec.tick !== undefined) return Math.max(0, Math.min(n, spec.tick === Infinity ? n : spec.tick));
	for (let t = 0; t <= n; t++) if (tr.RUN[t] >= spec.run) return t;
	return n;
}

// random portals: EEO picks a multi-target portal's exit with Math.random (see rng.js)
const isRandom = (level) => !!(level.rngScript && level.multiTargetPortals);
function chanceOf(level, masks) { return isRandom(level) ? RNG.analyze(level, masks).chance : 1; }

/** Replays a candidate and returns what the acceptance rule needs, or null if it does not finish the level. */
function evaluate(level, masks, withChance = true) {
	const r = replay(level, masks);
	if (r.complete < 0) return null;
	const ms = masks.slice(0, r.complete);
	return { runTicks: r.runTicks, complete: r.complete, deaths: r.deaths, coins: r.coins, ms, chance: withChance ? chanceOf(level, ms) : 1 };
}
/**
 * THE acceptance rule (grind.js consider(), the job inbox, tas.js try): a candidate replaces the best run if it
 * finishes with no more deaths than `baseDeaths` and is faster with no lower random-portal chance, or equally
 * fast with a higher chance. `cand` null = does not finish.
 */
function judge(cand, best, baseDeaths) {
	if (!cand) return { accept: false, reason: 'does not finish the level' };
	if (!best) return { accept: true, saved: 0, reason: 'the current best does not finish (engine changed?)' };
	if (cand.deaths > baseDeaths) return { accept: false, reason: `dies ${cand.deaths} time(s) (allowed: ${baseDeaths})` };
	if (cand.runTicks > best.runTicks) return { accept: false, reason: `slower: ${fmt(cand.runTicks)} vs best ${fmt(best.runTicks)}` };
	const pc = (x) => `${(x * 100).toFixed(1)}%`;
	if (cand.runTicks < best.runTicks) {
		if (cand.chance >= best.chance - 1e-9) return { accept: true, saved: best.runTicks - cand.runTicks };
		return { accept: false, reason: `faster (${fmt(cand.runTicks)}) but finishes in only ${pc(cand.chance)} of EEO plays (need ${pc(best.chance)})` };
	}
	if (cand.chance > best.chance + 1e-9) return { accept: true, saved: 0, safer: true };
	return { accept: false, reason: `same time as the best (${fmt(best.runTicks)}), not more likely to work` };
}

/**
 * Coins only collected on the way (no coin door / gate on the route)? Then searches may ignore which coins were
 * collected ("coin-blind", rejoins apart from coins), which finds more shortcuts and allows skipping coins.
 */
function coinsIrrelevant(levelJson, masks, best) {
	const L2 = E.loadLevel(levelJson);
	let doors = 0;
	for (let i = 0; i < L2.fg.length; i++) {
		const v = L2.fg[i];
		if (v === 43 || v === 213) { L2.lookup0[i] = 9999; doors++; }   // coin doors never open
		else if (v === 165 || v === 214) { L2.lookup0[i] = 0; doors++; } // coin gates always closed
	}
	if (doors === 0) return true;
	const r = replay(L2, masks);
	return r.complete === best.complete && r.runTicks === best.runTicks;
}

// ---------------------------------------------------------------- inputs as text
/** mask -> "R+J", "L", "-" (bits: 1 jump, 2 left, 4 right, 8 up, 16 down) */
function maskName(m) {
	const p = [];
	if (m & 2) p.push('L');
	if (m & 4) p.push('R');
	if (m & 8) p.push('U');
	if (m & 16) p.push('D');
	if (m & 1) p.push('J');
	return p.length ? p.join('+') : '-';
}
/** masks[a..b) -> "R x12, R+J x1, - x3" */
function inputRuns(masks, a, b) {
	const out = [];
	for (let t = Math.max(0, a); t < Math.min(b, masks.length);) {
		let u = t;
		while (u < b && u < masks.length && masks[u] === masks[t]) u++;
		out.push(`${maskName(masks[t])} x${u - t}`);
		t = u;
	}
	return out.join(', ');
}

/** --key=value / --flag and positional arguments */
function parseArgs(argv) {
	const a = { _: [] };
	for (const s of argv) {
		const m = s.match(/^--([^=]+)(?:=(.*))?$/);
		if (m) a[m[1]] = m[2] === undefined ? '1' : m[2];
		else a._.push(s);
	}
	return a;
}

module.exports = {
	SRC, DATA, JOBS, E, RNG,
	parseEetasBuffer, readEetas, eetasBytes, writeEetas, oddBytes,
	writeAtomic, writeJSON, readJSON, lock, sleepMs,
	fmt, parseTime, tickOf,
	jobIds, findJob, jobLevelId, jobOfFile, levelData, loadLevel,
	replay, isRandom, chanceOf, evaluate, judge, coinsIrrelevant,
	maskName, inputRuns, parseArgs,
};
