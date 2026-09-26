'use strict';
// The GPU launch bound (native/launch.h): every eegpu command splits its work into kernel launches sized toward
// --launch-ms, so no launch nears the display driver's 2 s watchdog, even on a laptop GPU that throttles to 1/6 of its
// clock. Short workloads of every GPU command (bench, explore, beam, search, the GPU trace), each a few seconds; each
// must finish and report its longest launch under 3 x the target ("maxKernelMs", by the GPU's clock; "maxLaunchMs", by
// the host clock, is reported too: it also counts waits for another process's GPU work). These workloads are small
// (one launch per phase on a fast GPU), so explore, search and the trace also run split into small launches
// (--launch-items=N: at most N items per launch) and must give exactly what the ordinary run gives: the splitting is
// what keeps the launches short on a big level, and a split that changed a result would show here.
//   node test/gpulaunch.js [--launch-ms=50] [--tool=<eegpu.exe>] [--ptxdir=<dir>] [--lock=<gpulock.js>]
// --lock: each eegpu run goes through that lock script (node <lock> <exe> ...: one GPU user at a time on a shared
// machine). Needs an NVIDIA GPU (the CPU emulation of the kernels works too: --tool=<emu.exe> --ptxdir=<its dir>).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/common.js');
const E = C.E;
const G = require('../src/gpu.js');
const EL = require('../src/eelvl.js');
const RF = require('../src/reach.js');
const ED = require('../src/editor.js');
const BENCH = require('../src/bench.js');

const args = C.parseArgs(process.argv.slice(2));
const TARGET = +(args['launch-ms'] || 50);
const LIMIT = 3 * TARGET;
const TOOL = args.tool ? path.resolve(args.tool) : G.nativeTool();
const LOCK = args.lock ? path.resolve(args.lock) : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eegpu-launch-'));
let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
if (!TOOL) { console.log('the native tool is missing: node tools/build-native.js'); process.exit(2); }

/** one eegpu run (through the lock when given): its JSON lines */
function eegpu(a, timeoutS) {
	const full = [...a, `--launch-ms=${TARGET}`, ...(args.ptxdir ? [`--ptxdir=${path.resolve(args.ptxdir)}`] : [])];
	const [cmd, argv] = LOCK ? [process.execPath, [LOCK, TOOL, ...full]] : [TOOL, full];
	const t0 = Date.now();
	// (through a lock, the wait for the GPU counts too: a long timeout)
	const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: (LOCK ? 3600 : timeoutS || 120) * 1000, windowsHide: true });
	const lines = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
	return { code: r.status, lines, ms: Date.now() - t0, err: String(r.stderr || '').trim().split('\n').pop() };
}
/** the summary line: the done event, or the last line */
const summary = (r) => r.lines.find((l) => l.ev === 'done') || r.lines[r.lines.length - 1] || {};
// (the fields that depend on the clock or on how the work was split)
const TIMING = new Set(['ticksPerSec', 'sec', 'seconds', 'gpu', 'launchMs', 't', 'twinSeconds', 'listSeconds', 'launches', 'maxLaunchMs', 'maxLaunchKernel',
	'maxKernelMs', 'maxKernelKernel', 'gpuClock', 'busy', 'launchTarget', 'kernelLaunches', 'loadMs', 'allocMs', 'ctxMs', 'module', 'waitMs', 'families']);
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !TIMING.has(k))));
/** the same events, timing apart (progress and closest lines come on a timer; ready is the load) */
function sameEvents(a, b, kinds) {
	const pick = (r) => r.lines.filter((l) => kinds.includes(l.ev)).map(norm);
	const x = pick(a), y = pick(b);
	const i = x.findIndex((l, k) => l !== y[k]);
	return { same: x.length === y.length && i < 0, n: x.length, at: i < 0 ? (x.length !== y.length ? Math.min(x.length, y.length) : -1) : i, x, y };
}
/** the longest launch by the GPU's clock (maxKernelMs; maxLaunchMs by the host clock also counts waits for another
 *  process's GPU work, so it is only reported) must be under 3 x the target */
function bound(name, r) {
	const d = summary(r);
	const gpu = d.gpu && d.gpu.name ? d.gpu.name : '';
	const k = Number.isFinite(d.maxKernelMs) ? d.maxKernelMs : d.maxLaunchMs;
	const ok = r.code === 0 && !d.error && Number.isFinite(k) && k <= LIMIT;
	check(`${name}: the longest launch under ${LIMIT} ms`, ok, d.error ? `error: ${d.error}` : `maxKernelMs ${d.maxKernelMs} (${d.maxKernelKernel}), ` +
		`maxLaunchMs ${d.maxLaunchMs} (${d.maxLaunchKernel}; host clock, with waits for other GPU work), ${d.kernelLaunches} launches in ${(r.ms / 1000).toFixed(1)} s` +
		`${gpu ? ` on ${gpu}` : ''}${r.code ? `, exit ${r.code} ${r.err}` : ''}`);
	return d;
}

// a room: the start on the left, bumps to hop over, the trophy on the floor at the right; a route: right and jump held
const W = 40, H = 16, cells = [];
for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
for (let y = 0; y < H; y++) cells.push([0, y, 9], [W - 1, y, 9]);
for (const wx of [9, 17, 25]) cells.push([wx, 14, 9]);
for (let x = 29; x <= 31; x++) cells.push([x, 10, 9]);
cells.push([2, 14, 255], [38, 14, 121]);
const buf = ED.eelvlOf({ name: 'launch test', width: W, height: H, cells });
const level = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
const held = C.evaluate(level, new Uint8Array(600).fill(5));   // (R + J every tick)
if (!held) { console.log('the test room: right + jump held does not finish'); process.exit(2); }
const bin = path.join(TMP, 'level.bin'), reach = path.join(TMP, 'reach.bin');
fs.writeFileSync(bin, G.levelBlob(level));
RF.writeReachFile(RF.reachField(level), reach);
const arena = path.join(TMP, 'arena.bin');
fs.writeFileSync(arena, G.levelBlob(E.prepareLevel(BENCH.arenaJson())));

console.log(`eegpu: ${TOOL}${LOCK ? ` (through ${LOCK})` : ''}; launch target ${TARGET} ms`);
// 1. bench: the raw engine speed, 2 s
const b = eegpu(['bench', arena, '--seconds=2']);
if (b.lines.length && summary(b).gpu === null) { console.log(`no GPU: ${summary(b).why}`); process.exit(2); }
bound('bench', b);
// 2. explore: every move from the start toward the trophy (cells of 2 px), 6 s
const x = eegpu(['explore', bin, '-', '--finish=1', '--discrete=1', '--depth=1000', '--seconds=6', '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', `--reach=${reach}`, '--prune=1']);
bound('explore', x);
const hit = x.lines.find((l) => l.ev === 'hit');
check('explore: a route to the trophy, as fast as right + jump held or faster', !!hit && hit.inputs.length <= held.complete,
	hit ? `${hit.inputs.length} ticks (held: ${held.complete})` : summary(x).end);
const xs = eegpu(['explore', bin, '-', '--finish=1', '--discrete=1', '--depth=1000', '--seconds=60', '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', `--reach=${reach}`, '--prune=1', '--launch-items=8192']);
{
	const e = sameEvents(x, xs, ['layer', 'hit', 'done']);
	check('explore split into launches of 8192 parents / candidates: the same layers, hits and end', e.same && summary(xs).end === 'finish' && summary(xs).kernelLaunches > 2 * summary(x).kernelLaunches,
		`${e.n} events${e.at >= 0 ? `; first difference at ${e.at}: ${e.x[e.at]} | ${e.y[e.at]}` : ''}; ${summary(x).kernelLaunches} launches vs ${summary(xs).kernelLaunches}`);
}
// 3. beam: the widest the editor uses, 3 s
bound('beam (131072 states per tick)', eegpu(['beam', bin, '--goal=1', '--width=131072', '--seconds=3', '--depth=1000', `--reach=${reach}`]));
// 4. search on the held route, 4 s: the systematic families, then a random one
const run = path.join(TMP, 'route.eetas');
C.writeEetas(run, held.ms);
// (the held route with 40 idle ticks first: the state at rest at the start repeats, so m1 / del find shortcuts)
const idleRun = path.join(TMP, 'route_idle.eetas');
C.writeEetas(idleRun, Uint8Array.from([...new Uint8Array(40), ...held.ms]));
bound('search (m1, del, m2 and pert, 4 s)', eegpu(['search', bin, run, path.join(TMP, 'edges.bin'), '--seconds=4', '--families=m1,del,m2,pert']));
{
	// the systematic families over the whole route (they end by themselves): batches of many start ticks and ticks per
	// launch vs batches of 3 start ticks, 3 ticks per launch (each candidate's state waits on the GPU between launches)
	const a = eegpu(['search', bin, idleRun, path.join(TMP, 'edges_a.bin'), '--seconds=60', '--families=m1,del,m2']);
	const b = eegpu(['search', bin, idleRun, path.join(TMP, 'edges_b.bin'), '--seconds=60', '--families=m1,del,m2', '--launch-items=3']);
	const da = summary(a), db = summary(b);
	const fa = path.join(TMP, 'edges_a.bin'), fb = path.join(TMP, 'edges_b.bin');
	const same = a.code === 0 && b.code === 0 && fs.existsSync(fa) && fs.existsSync(fb) && fs.readFileSync(fa).equals(fs.readFileSync(fb)) && norm(da) === norm(db);
	check('search split into batches of 3 start ticks, 3 ticks per launch: the same edges file, byte for byte, and the same counts', same && da.edges > 0 && db.kernelLaunches > 2 * da.kernelLaunches,
		`${da.edges} / ${db.edges} edges, ${da.candidates} / ${db.candidates} candidates, ${da.ticks} / ${db.ticks} ticks; ${da.kernelLaunches} launches vs ${db.kernelLaunches}` +
		(norm(da) === norm(db) ? '' : `; ${norm(da)} | ${norm(db)}`));
}
// 5. the GPU trace (one thread) of a long run: the route, then random sticky inputs (20000 ticks)
const long = new Uint8Array(20000);
let s = 12345, m = 0;
for (let i = 0; i < long.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; if ((s >>> 24) < 20) m = (s >>> 8) & 31; long[i] = i < held.ms.length ? held.ms[i] : m; }
const lf = path.join(TMP, 'long.eetas');
C.writeEetas(lf, long);
bound('trace --gpu (one thread, 20000 ticks, in segments)', eegpu(['trace', bin, lf, path.join(TMP, 'trace.bin'), '--gpu']));
// the segments continue exactly: the GPU's hashes equal the CPU engine's
const c = spawnSync(TOOL, ['trace', bin, lf, path.join(TMP, 'trace_cpu.bin')], { encoding: 'utf8' });
const same = c.status === 0 && fs.existsSync(path.join(TMP, 'trace.bin')) && fs.readFileSync(path.join(TMP, 'trace.bin')).subarray(24).equals(fs.readFileSync(path.join(TMP, 'trace_cpu.bin')).subarray(24));
check('trace --gpu: every tick\'s hashes equal the native CPU trace', same);
const ts = eegpu(['trace', bin, lf, path.join(TMP, 'trace_split.bin'), '--gpu', '--launch-items=7']);
const sameSplit = ts.code === 0 && fs.existsSync(path.join(TMP, 'trace_split.bin')) && fs.readFileSync(path.join(TMP, 'trace_split.bin')).subarray(24).equals(fs.readFileSync(path.join(TMP, 'trace_cpu.bin')).subarray(24));
check('trace --gpu in segments of 7 ticks: the same hashes', sameSplit, `${summary(ts).kernelLaunches} launches`);
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
