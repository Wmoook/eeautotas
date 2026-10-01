'use strict';
// THE HYBRID's batch (n5-hy-best): tools/hybrid.js on a list of levels, as many at once as the box allows, each on the GPU
// with the fewest levels; resumable (a level already in <out>/results.jsonl is skipped).
//   node tools/hybrid_batch.js --list=<file.jsonl: {rel, seconds, stallStopS?}> --lv=<levels dir> --out=<dir> [--gpus=0,1]
//        [--par=8] [--maxLoad=<loadavg 1 min; default the CPUs>] [--minFreeGB=40] [--gapS=4] [--deadline=<ISO: no launch after>]
//        [--args="<more tools/hybrid.js options>"] [--tmp=<TMPDIR of the children>]
// - a level: node tools/hybrid.js <lv>/<rel> --seconds=<its> [--stallStopS=<its>] <args> --out=<out>/runs/<id> --gpu=<g>
//   --name=<id> --quiet=1, its own process group (killed whole at its end: no orphan children), hard-stopped at
//   seconds + 150 s (SIGTERM; SIGKILL 60 s later).
// - a launch waits for: fewer than --par running, the 1-min load average under --maxLoad, MemAvailable over --minFreeGB,
//   --gapS since the last launch.
// - <out>/results.jsonl: a line a level (hybrid.json's summary: the first route, the final, the stop, the compiler's leg
//   stats); <out>/batch.log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? '1' : m[2]; }
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(opt.out || 'hybrid_batch');
const LV = path.resolve(opt.lv || '.');
const GPUS = String(opt.gpus || '0').split(',').filter((s) => s !== '');
const PAR = Math.max(1, +(opt.par || 8));
const MAX_LOAD = +(opt.maxLoad || os.cpus().length);
const MIN_FREE = +(opt.minFreeGB || 40) * 1e9;
const GAP = +(opt.gapS || 4) * 1000;
const DEADLINE = opt.deadline ? Date.parse(opt.deadline) : Infinity;
const EXTRA = String(opt.args || '').split(/\s+/).filter(Boolean);
const TMP = opt.tmp ? path.resolve(opt.tmp) : os.tmpdir();
fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const resF = path.join(OUT, 'results.jsonl');
const logF = path.join(OUT, 'batch.log');
const T0 = Date.now();
const log = (s) => { const l = `[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - T0) / 1000)}s] ${s}`; console.log(l); fs.appendFileSync(logF, l + '\n'); };

const list = fs.readFileSync(path.resolve(opt.list), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const done = new Set();
try { for (const l of fs.readFileSync(resF, 'utf8').split('\n')) { if (!l.trim()) continue; try { done.add(JSON.parse(l).rel); } catch (e) { /* torn */ } } } catch (e) { /* none */ }
const queue = list.filter((x) => !done.has(x.rel));
const idOf = (rel) => rel.replace(/\.eelvl$/i, '').replace(/[\\/]/g, '__');
const running = new Map();   // id -> {rel, gpu, ch, t0, x, hard, kill}
const perGpu = new Map(GPUS.map((g) => [g, 0]));
let lastLaunch = 0;

function memAvail() { try { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); return m ? +m[1] * 1024 : Infinity; } catch (e) { return Infinity; } }
function killGroup(pid, sig) { try { process.kill(-pid, sig); } catch (e) { /* gone */ } }

function summary(x, id, gpu, code, wallS) {
	const dir = path.join(OUT, 'runs', id);
	let R = null, CJ = null;
	try { R = JSON.parse(fs.readFileSync(path.join(dir, 'hybrid.json'), 'utf8')); } catch (e) { /* none */ }
	try { CJ = JSON.parse(fs.readFileSync(path.join(dir, 'compile.json'), 'utf8')); } catch (e) { /* none */ }
	const r = R || {};
	const c = r.compiler || {}, s = r.search || {};
	return { rel: x.rel, id, gpu, exit: code, wallS, seconds: x.seconds, stallStopS: x.stallStopS || null,
		routed: !!(r.final && r.final.verified), first: r.first || null, final: r.final ? { runTicks: r.final.runTicks, by: r.final.by, t: r.final.t, verified: r.final.verified, deaths: r.final.deaths } : null,
		stop: r.stop || null, lastProgress: r.lastProgress || null, polish: r.polish || null,
		compiler: { firstRoute: c.firstRoute || null, routes: c.routes || 0, anchors: c.anchors || 0, maxGain: c.maxGain || 0, furthest: c.furthest ? { gain: c.furthest.gain, dist: c.furthest.dist, t: c.furthest.t } : null,
			exit: c.exit === undefined ? null : c.exit, stopped: c.stopped || null, hybrid: CJ && CJ.hybrid ? CJ.hybrid : null },
		search: { firstRoute: s.firstRoute || null, nearest: s.nearest || null, job: !!s.job, end: s.end ? s.end.why || null : null },
		hints: (r.hints || []).length, feeds: (r.feeds || []).length, prefix: (r.prefix || []).map((p) => ({ t: p.t, routed: p.routed, why: p.why })),
		joins: r.joins ? { before: r.joins.before, after: r.joins.after, saved: r.joins.saved } : null,
		routes: (r.routes || []).filter((q) => q.verified).map((q) => [q.t, q.by, q.runTicks]),
		errors: (r.errors || []).slice(0, 5), started: r.started || null };
}

function launch(x) {
	const id = idOf(x.rel);
	const gpu = [...perGpu.entries()].sort((a, b) => a[1] - b[1] || GPUS.indexOf(a[0]) - GPUS.indexOf(b[0]))[0][0];
	const dir = path.join(OUT, 'runs', id);
	fs.mkdirSync(dir, { recursive: true });
	const args = [path.join(ROOT, 'tools', 'hybrid.js'), path.join(LV, x.rel), `--seconds=${x.seconds}`, ...(x.stallStopS ? [`--stallStopS=${x.stallStopS}`] : []), ...EXTRA,
		`--out=${dir}`, `--gpu=${gpu}`, `--name=${id}`, '--quiet=1'];
	const fd = fs.openSync(path.join(dir, 'console.log'), 'w');
	const ch = spawn(process.execPath, args, { cwd: ROOT, detached: true, env: Object.assign({}, process.env, { TMPDIR: TMP }), stdio: ['ignore', fd, fd] });
	fs.closeSync(fd);
	const rec = { x, id, gpu, ch, t0: Date.now() };
	rec.hard = setTimeout(() => { log(`HARD STOP ${id} (${x.seconds + 150} s)`); killGroup(ch.pid, 'SIGTERM'); rec.kill = setTimeout(() => killGroup(ch.pid, 'SIGKILL'), 60e3); }, (x.seconds + 150) * 1000);
	running.set(id, rec);
	perGpu.set(gpu, perGpu.get(gpu) + 1);
	lastLaunch = Date.now();
	ch.on('exit', (code, sig) => {
		clearTimeout(rec.hard); if (rec.kill) clearTimeout(rec.kill);
		// (the level's whole process group: its compiler's and searches' children that outlived it)
		setTimeout(() => killGroup(ch.pid, 'SIGKILL'), 3000);
		running.delete(id);
		perGpu.set(gpu, perGpu.get(gpu) - 1);
		const wallS = Math.round((Date.now() - rec.t0) / 100) / 10;
		const sm = summary(x, id, gpu, code != null ? code : sig, wallS);
		fs.appendFileSync(resF, JSON.stringify(sm) + '\n');
		log(`END ${id} gpu ${gpu} ${wallS} s: ${sm.routed ? `ROUTED first ${sm.first.by} ${sm.first.t} s ${sm.first.runTicks}, final ${sm.final.runTicks} (${sm.final.by})` : 'no route'}; stop ${sm.stop ? `${sm.stop.why} ${sm.stop.t} s` : '-'}; ${running.size} running, ${queue.length} queued`);
	});
	log(`START ${id} gpu ${gpu} (${x.seconds} s${x.stallStopS ? `, stall ${x.stallStopS} s` : ''}); ${running.size} running, ${queue.length} queued`);
}

function loop() {
	if (!queue.length && !running.size) { log(`ALL DONE (${list.length} in the list)`); fs.writeFileSync(path.join(OUT, 'DONE'), new Date().toISOString()); process.exit(0); }
	if (queue.length && Date.now() > DEADLINE && !loop.past) { loop.past = true; log(`the deadline: ${queue.length} not launched`); queue.length = 0; }
	if (queue.length && running.size < PAR && Date.now() - lastLaunch >= GAP) {
		const load = os.loadavg()[0], mem = memAvail();
		if (load < MAX_LOAD && mem > MIN_FREE) launch(queue.shift());
		else if (Date.now() - (loop.lastWait || 0) > 60e3) { loop.lastWait = Date.now(); log(`waiting: load ${load.toFixed(0)} / ${MAX_LOAD}, MemAvailable ${(mem / 1e9).toFixed(0)} GB, ${running.size} running`); }
	}
	if (Date.now() - (loop.lastStat || 0) > 120e3) { loop.lastStat = Date.now(); log(`STAT load ${os.loadavg().map((v) => v.toFixed(0)).join('/')}, MemAvailable ${(memAvail() / 1e9).toFixed(0)} GB, ${running.size} running [${[...perGpu.values()].join(',')}], ${queue.length} queued`); }
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { log(`${s}: stopping ${running.size}`); for (const r of running.values()) killGroup(r.ch.pid, 'SIGTERM'); setTimeout(() => process.exit(130), 90e3); });
process.on('SIGHUP', () => { /* nohup */ });
log(`the batch: ${queue.length} of ${list.length} to run (${done.size} done), par ${PAR}, GPUs ${GPUS.join(',')}, max load ${MAX_LOAD}, args ${EXTRA.join(' ')}`);
setInterval(loop, 1000);
