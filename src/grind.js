'use strict';
// Keeps optimizing a TAS by cycling the search tools on the current best run, forever or until a deadline:
//   mutate.js (input mutations), explore.js (route explorer with exact rejoins, every coin-to-coin segment in
//   windows), shortcuts.js (dense local exact shortcuts), optimize.js (beam with verified leads, every other round),
// and splice.js (joins every result into the best run at equal states). Every accepted run is verified by a clean
// replay: it must finish the level, faster, with no more deaths than the starting run.
//
// Two modes:
// - game mode (default, no --job): tools/tas/out/best.eetas; every improvement is also copied to
//   levels/tas/<level>_fast.eetas and "tas_fast_name" in levels/config/<level>.json (Settings > RUN FASTEST).
// - job mode (--job=<dir>, used by tools/tas/server.js): everything lives in <dir> (best.eetas, best_<ticks>.eetas,
//   grind.log, status.json for the web app); the level is tools/tas/data/<--level>.json.
//
// usage: node tools/tas/grind.js [--until=HH:MM | --forever=1] [--level=forgotten_veil] [--workers=16]
//        [--job=<dir>] [--nocoins=auto|0|1] [--rot=N] [--skip=A,deep,beam]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const E = require('./eesim.js');
const RNG = require('./rng.js');
const ROOT = path.resolve(__dirname, '..', '..');

const a = { until: '', forever: '', level: 'forgotten_veil', workers: os.cpus().length, job: '', nocoins: 'auto' };
for (const s of process.argv.slice(2)) {
	const m = s.match(/^--([^=]+)=(.*)$/);
	if (m) a[m[1]] = m[2];
}
let deadline;
if (a.forever === '1' || !a.until) deadline = new Date(8.6e15);   // "forever": stop with Ctrl+C / the app's Stop button
else {
	const [hh, mm] = a.until.split(':').map(Number);
	deadline = new Date(); deadline.setHours(hh, mm, 0, 0);
	if (deadline.getTime() <= Date.now()) deadline.setDate(deadline.getDate() + 1);   // --until=05:56 in the evening = tomorrow
}
const FOREVER = deadline.getTime() > 4e15;
const JOB = a.job ? path.resolve(a.job) : '';
const OUT = JOB || path.join(__dirname, 'out');
const BEST = path.join(OUT, 'best.eetas');
fs.mkdirSync(OUT, { recursive: true });
const level = E.loadLevel(path.join(__dirname, 'data', a.level + '.json'));
const W = +a.workers || os.cpus().length;

function evalRun(file, lvl) {
	try {
		const ms = E.parseEetas(fs.readFileSync(file, 'utf8'));
		const sim = new E.EESim(lvl || level);
		sim.reset();
		const inp = new E.EEInput();
		let complete = -1, deaths = 0;
		sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); else if (k === 'death') deaths++; };
		for (let t = 0; t < ms.length && complete < 0; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
		return complete >= 0 ? { runTicks: sim.run_ticks, complete, deaths, coins: sim.coins, ms: ms.slice(0, complete) } : null;
	} catch (e) { return null; }
}
function coinTicks(ms) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const out = [0];
	let fin = -1;
	sim.onEvent = (k) => { if (k === 'coin') out.push(sim.ticks()); else if (k === 'complete' && fin < 0) fin = sim.ticks(); };
	for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
	out.push(fin);
	return out;   // out[k] = tick of coin k (out[0] = 0), last = the finish
}
const fmt = (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`;

// ---------------------------------------------------------------- status (read by the web app)
const statusPath = path.join(OUT, 'status.json');
let status = {};
try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch (e) { status = {}; }
if (!Array.isArray(status.history)) status.history = [];
function saveStatus(extra) {
	Object.assign(status, extra || {}, { updated: Date.now(), pid: process.pid });
	try { fs.writeFileSync(statusPath + '.tmp', JSON.stringify(status)); fs.renameSync(statusPath + '.tmp', statusPath); } catch (e) { /* ignore */ }
}
const log = (s) => {
	const line = `[grind ${new Date().toTimeString().slice(0, 8)}] ${s}`;
	console.log(line);
	fs.appendFileSync(path.join(OUT, 'grind.log'), line + '\n');
};

let best = evalRun(BEST);
if (!best) { log('best.eetas does not finish the level'); saveStatus({ state: 'error', error: 'best.eetas does not finish the level' }); process.exit(1); }
const baseDeaths = best.deaths;   // never accept a run with more deaths than we started with
if (status.startRunTicks === undefined) status.startRunTicks = best.runTicks;

// coins: are they only collected on the way (no coin door / gate on the route)? Then the searches may ignore which
// coins were collected (rejoins "apart from coins"), which finds more shortcuts and allows skipping coins.
function coinsIrrelevant() {
	const L2 = E.loadLevel(path.join(__dirname, 'data', a.level + '.json'));
	let doors = 0;
	for (let i = 0; i < L2.fg.length; i++) {
		const v = L2.fg[i];
		if (v === 43 || v === 213) { L2.lookup0[i] = 9999; doors++; }   // coin doors never open
		else if (v === 165 || v === 214) { L2.lookup0[i] = 0; doors++; } // coin gates always closed
	}
	if (doors === 0) return true;
	const r = evalRun(BEST, L2);
	return !!(r && r.runTicks === best.runTicks && r.complete === best.complete);
}
const NC = a.nocoins === 'auto' ? (coinsIrrelevant() ? 1 : 0) : (+a.nocoins ? 1 : 0);
log(`start: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks}), ${best.deaths} deaths, coins ${NC ? 'optional (coin-blind search)' : 'needed (coin-aware search)'}, ` +
	`${W} workers, ${FOREVER ? 'runs until stopped' : 'deadline ' + deadline.toString().slice(0, 21)}`);
saveStatus({ state: 'running', level: a.level, bestRunTicks: best.runTicks, coinsOptional: !!NC, workers: W, started: status.started || Date.now(),
	sessionStarted: Date.now(), stage: 'starting' });

// game mode publishes to the game's files if this level has a config with a "tas_fast_name"
const cfgPath = path.join(ROOT, 'levels', 'config', `${a.level}.json`);
const GAME = !JOB && fs.existsSync(cfgPath) && /"tas_fast_name"/.test(fs.readFileSync(cfgPath, 'utf8'));
function publish() {
	if (!best || !best.ms || best.ms.length === 0) return;
	const str = Array.from(best.ms, (m) => String.fromCharCode(48 + m)).join('');   // (a typed array's map would not give strings)
	const chk = path.join(OUT, 'publish_check.eetas');
	fs.writeFileSync(chk, str);
	const v = evalRun(chk);
	if (!v || v.runTicks !== best.runTicks) { log(`publish: verification FAILED (${v ? v.runTicks : 'no finish'}), not published`); return; }
	fs.writeFileSync(BEST, str);
	fs.writeFileSync(path.join(OUT, `best_${best.runTicks}.eetas`), str);
	if (GAME) {
		fs.writeFileSync(path.join(ROOT, 'levels', 'tas', `${a.level}_fast.eetas`), str);
		fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/"tas_fast_name": "[^"]*"/, `"tas_fast_name": "Optimized TAS ${fmt(best.runTicks)}"`));
	}
	saveStatus({ bestRunTicks: best.runTicks });
}
publish();

// random portals (EEO mode, level.rngScript set): the chance that a run finishes over all portal outcomes must never drop
const RANDOM = !!(level.rngScript && level.multiTargetPortals);
const chanceOf = (r) => (RANDOM ? RNG.analyze(level, r.ms).chance : 1);
let bestChance = chanceOf(best);
if (RANDOM) log(`random portals: this run finishes in ${(bestChance * 100).toFixed(1)}% of EEO plays; improvements must keep at least that`);
saveStatus({ chance: bestChance });
function consider(file, what) {
	// best.eetas may have been improved from outside (tools/tas/offer.js): never publish anything slower than it
	const disk = evalRun(BEST);
	if (disk && disk.runTicks < best.runTicks) { log(`(best.eetas was improved outside: ${fmt(best.runTicks)} -> ${fmt(disk.runTicks)})`); best = disk; bestChance = chanceOf(best); }
	const r = evalRun(file);
	if (!r || r.deaths > baseDeaths || r.runTicks > best.runTicks) return false;
	const ch = chanceOf(r);
	const faster = r.runTicks < best.runTicks && ch >= bestChance - 1e-9;
	const safer = r.runTicks === best.runTicks && ch > bestChance + 1e-9;   // same time, works in more EEO plays
	if (!faster && !safer) {
		if (r.runTicks < best.runTicks) log(`${what}: ${fmt(r.runTicks)} rejected: finishes in only ${(ch * 100).toFixed(1)}% of plays (need ${(bestChance * 100).toFixed(1)}%)`);
		return false;
	}
	log(`${what}: ${fmt(best.runTicks)} -> ${fmt(r.runTicks)} (-${best.runTicks - r.runTicks})` + (RANDOM ? `, chance ${(ch * 100).toFixed(1)}%` : ''));
	status.history.push({ t: Date.now(), runTicks: r.runTicks, saved: best.runTicks - r.runTicks, what, chance: ch });
	best = r; bestChance = ch;
	saveStatus({ chance: ch });
	publish();
	return true;
}
let results = [];
function spliceAll() {
	results = results.slice(-80);   // bounded: an endless run would otherwise splice thousands of files
	const out = path.join(OUT, 'grind_splice.eetas');
	const ex = results.filter((f) => fs.existsSync(f));
	if (ex.length === 0) return;
	saveStatus({ stage: 'splice' });
	spawnSync(process.execPath, [path.join(__dirname, 'splice.js'), out, BEST, ...ex, `--level=${a.level}`, ...(NC ? ['--nocoins'] : [])], { encoding: 'utf8' });
	consider(out, 'splice');
}
const skip1 = new Set(String(a.skip || '').split(',').filter(Boolean));   // --skip=A,deep,beam: skipped in round 1
let curRound = 0;
function stage(name, script, args, outFile, maxMs) {
	const tag = name.startsWith('shortcuts') ? 'A' : name.startsWith('deep') ? 'deep' : name.startsWith('beam') ? 'beam' : '';
	if (curRound === 1 && tag && skip1.has(tag)) { log(`${name}: skipped (--skip)`); return false; }
	const left = deadline - Date.now();
	if (left < 60000) return false;
	try { fs.unlinkSync(outFile); } catch (e) { /* none */ }
	log(`${name}...`);
	saveStatus({ stage: name, round: curRound });
	const r = spawnSync(process.execPath, ['--max-old-space-size=12000', path.join(__dirname, script), ...args],
		{ encoding: 'utf8', maxBuffer: 256 << 20, timeout: Math.min(maxMs, left + 240e3) });   // grace: stages with --deadline wrap up themselves
	fs.writeFileSync(path.join(OUT, `grind_${name.replace(/[^\w.-]/g, '_')}.log`), (r.stdout || '') + (r.stderr || ''));
	if (fs.existsSync(outFile)) consider(outFile, name);
	return true;
}
const dl = () => (FOREVER ? [] : [`--deadline=${deadline.getTime() - 90e3}`]);

// cheap input-mutation passes (seconds each), repeated while they keep finding time
function mutateLoop(tag) {
	for (let k = 1; k <= 8; k++) {
		const mo = path.join(OUT, `grind_mut_${tag}_${k}.eetas`);
		const before = best.runTicks;
		stage(`mutate_${tag}_${k}`, 'mutate.js', [`--tas=${BEST}`, `--out=${mo}`, '--horizon=800', `--workers=${W}`, `--level=${a.level}`,
			`--nocoins=${NC}`, ...dl()], mo, 1800e3);
		if (best.runTicks >= before) break;
	}
}
// hot segments (explored first on even rounds): the rooms that gave the most on Forgotten Veil
const HOT = a.level === 'forgotten_veil' ? [[0, 1], [5, 6], [6, 7], [10, 11], [3, 4]] : [];

for (let round = 1; Date.now() < deadline - 120000; round++) {
	curRound = round;
	const tas = `--tas=${BEST}`;
	const R = (arr) => arr[(round - 1 + (+a.rot || 0)) % arr.length];   // --rot=N continues the parameter rotation after a restart
	mutateLoop(`${round}a`);
	// 1) deep exact-rejoin exploring of EVERY coin-to-coin segment (a level without coins is one segment), in windows
	const ct = coinTicks(best.ms);
	const segs = [];
	for (let k = 1; k < ct.length; k++) segs.push([k - 1, k]);
	const hot = HOT.filter(([h]) => h < segs.length);
	const rest = segs.filter(([x]) => !hot.some(([h]) => h === x));
	const off = (round - 1 + (+a.rot || 0)) % Math.max(1, rest.length);
	const restRot = [...rest.slice(off), ...rest.slice(0, off)];
	const order = ((round + (+a.rot || 0)) % 2 === 0) ? [...hot, ...restRot] : [...restRot, ...hot];
	for (const [k0, k1] of order) {
		const c = coinTicks(best.ms);   // ticks move as the run improves
		if (!(c[k0] >= 0 && c[k1] > c[k0])) continue;
		const lo = Math.max(0, c[k0] - 20), hi = c[k1] + 80;
		const wins = [];
		const WSZ = R([600, 400, 500, 350]), WSTEP = WSZ - 100;   // smaller windows = more focused exploring
		if (hi - lo <= WSZ + 150) wins.push([lo, hi]);
		else for (let w0 = lo; w0 < hi - 100; w0 += WSTEP) wins.push([w0, Math.min(hi, w0 + WSZ)]);
		for (let wi = 0; wi < wins.length; wi++) {
			const [w0, w1] = wins[wi];
			const dp = path.join(OUT, `grind_deep_${round}_${k0}_${wi}.eetas`);
			stage(`deep${round}_seg${k1}${wins.length > 1 ? '.' + (wi + 1) : ''}`, 'explore.js', [tas, `--out=${dp}`, `--from=${w0}`, `--join=${w0}`,
				`--until=${w1}`, `--seconds=${R([150, 180, 150, 210])}`, `--workers=${W}`, '--exact=1', '--roll=100',
				`--seed=${round * 17 + k0 * 5 + wi + 300}`, `--cell=${R([8, 6, 12, 8])}`, `--vcell=${R([2, 1.5, 3, 1])}`, `--ahead=${R([0.5, 0.6, 0.4, 0.7])}`,
				`--nocoins=${NC}`, '--maxEntries=1500000', `--level=${a.level}`], dp, 900e3);
			results.push(dp);
		}
	}
	mutateLoop(`${round}b`);
	// 2) one dense local-shortcut pass (alternating settings)
	const sc = path.join(OUT, `grind_sc_${round}.eetas`);
	stage(`shortcuts${round}`, 'shortcuts.js', [tas, `--out=${sc}`, '--step=10', `--from=${R([5, 2, 7, 4])}`,
		`--depth=${R([180, 150, 200, 160])}`, `--cap=${R([2000, 3000, 1800, 2500])}`, `--dist=${R([24, 16, 32, 40])}`, `--bcap=${R([8, 12, 16, 6])}`,
		`--workers=${W}`, `--level=${a.level}`, `--nocoins=${NC}`, ...dl()], sc, 3 * 3600e3);
	results.push(sc);
	mutateLoop(`${round}c`);
	// 3) beam with verified leads, every other round
	if (round % 2 === 0) {
		const bm = path.join(OUT, `grind_beam_${round}.eetas`);
		stage(`beam${round}`, 'optimize.js', [tas, `--out=${bm}`, `--width=${R([4000, 6000, 3000, 8000])}`, `--dist=${R([24, 16, 32, 24])}`,
			'--passes=1', `--workers=${W}`, `--level=${a.level}`], bm, 3 * 3600e3);
		results.push(bm);
	}
	spliceAll();
	log(`round ${round} done: best ${fmt(best.runTicks)}`);
	saveStatus({ rounds: round });
}
log(`finished: best ${fmt(best.runTicks)} (run_ticks ${best.runTicks})`);
saveStatus({ state: 'finished', stage: 'finished' });
