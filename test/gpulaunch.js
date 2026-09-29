'use strict';
// The GPU launch bound (native/launch.h): every eegpu command splits its work into kernel launches sized toward
// --launch-ms, so no launch nears the display driver's 2 s watchdog, even on a laptop GPU that throttles to 1/6 of its
// clock. Short workloads of every GPU command (bench, explore, beam, search, the GPU trace), each a few seconds; each
// must finish and report its longest launch under 3 x the target ("maxKernelMs", by the GPU's clock; "maxLaunchMs", by
// the host clock, is reported too: it also counts waits for another process's GPU work). When another process keeps
// the GPU busy (nvidia-smi's utilization at 20% or more before the test), the bound is 6 x: the events around a kernel
// then also count the other process's time slices (a search launch measured 143 ms against 150 next to a job's
// searcher); --bound=<factor> sets it. These workloads are small
// (one launch per phase on a fast GPU), so explore, search and the trace also run split into small launches
// (--launch-items=N: at most N items per launch) and must give exactly what the ordinary run gives: the splitting is
// what keeps the launches short on a big level, and a split that changed a result would show here. The explore also
// runs with --wait=spin (the host thread spinning through every launch) and must give the same; both runs' CPU time
// ("hostCpuMs") is printed.
//   node test/gpulaunch.js [--launch-ms=50] [--bound=3] [--tool=<eegpu.exe>] [--ptxdir=<dir>] [--lock=<gpulock.js>]
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
/** the GPU's utilization (%) before the test, the lowest of 3 samples over a second (null without nvidia-smi): another
 *  process's GPU work */
function busyBefore() {
	let low = null;
	for (let i = 0; i < 3; i++) {
		const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
		const v = parseFloat(String(r.stdout || '').trim().split('\n')[0]);
		if (Number.isFinite(v)) low = low === null ? v : Math.min(low, v);
		if (i < 2) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
	}
	return low;
}
const BUSY = args.bound ? null : busyBefore();
const SHARED = BUSY !== null && BUSY >= 20;
const LIMIT = (args.bound ? +args.bound : SHARED ? 6 : 3) * TARGET;
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
	'maxKernelMs', 'maxKernelKernel', 'gpuClock', 'busy', 'launchTarget', 'kernelLaunches', 'loadMs', 'allocMs', 'ctxMs', 'module', 'waitMs', 'families',
	'launchTotalMs', 'kernelTotalMs', 'gapMs', 'wait', 'hostCpuMs']);
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !TIMING.has(k))));
/** the same events, timing apart (progress and closest lines come on a timer; ready is the load) */
function sameEvents(a, b, kinds) {
	const pick = (r) => r.lines.filter((l) => kinds.includes(l.ev)).map(norm);
	const x = pick(a), y = pick(b);
	const i = x.findIndex((l, k) => l !== y[k]);
	return { same: x.length === y.length && i < 0, n: x.length, at: i < 0 ? (x.length !== y.length ? Math.min(x.length, y.length) : -1) : i, x, y };
}
/** the longest launch by the GPU's clock (maxKernelMs; maxLaunchMs by the host clock also counts waits for another
 *  process's GPU work, so it is only reported) must be under 3 x the target (6 x on a GPU another process keeps busy) */
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

console.log(`eegpu: ${TOOL}${LOCK ? ` (through ${LOCK})` : ''}; launch target ${TARGET} ms, bound ${LIMIT} ms` +
	(args.bound ? ' (--bound)' : BUSY === null ? '' : SHARED ? ` (the GPU was ${BUSY}% busy before the test: shared with another process)` : ` (the GPU was ${BUSY}% busy before the test)`));
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
{
	// the host thread spinning through every launch (--wait=spin) instead of sleeping on the launch's event: the same run
	const xw = eegpu(['explore', bin, '-', '--finish=1', '--discrete=1', '--depth=1000', '--seconds=60', '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', `--reach=${reach}`, '--prune=1', '--wait=spin']);
	const e = sameEvents(x, xw, ['layer', 'hit', 'done']);
	const a = summary(x), w = summary(xw);
	check('explore with --wait=spin: the same layers, hits and end', e.same && w.end === 'finish' && w.wait === 'spin',
		`${e.n} events${e.at >= 0 ? `; first difference at ${e.at}` : ''}; wait ${a.wait}: host CPU ${a.hostCpuMs} ms, GPU gaps ${a.gapMs} ms, ${a.kernelTotalMs} ms in kernels; ` +
		`wait ${w.wait}: host CPU ${w.hostCpuMs} ms, GPU gaps ${w.gapMs} ms, ${w.kernelTotalMs} ms in kernels`);
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
// 6. the random runs (eegpu roll, Find a route's "random runs (GPU)"): 3 batches of 512 picks of the start cell, 8 runs of
// 40 ticks each. Every record (a new cell's earliest arrival) is replayed here from its seed in the JS engine: the tick,
// the reach field's fifths and the room (goexplore.js roomOf) must be the GPU's; split into launches of 128 runs / cells
// the batches give the same records in the same order (the canonical order; the dense ids apart: they are handed out in
// the GPU's order). Then a room with every door the room key reads (a team effect and door, coins and a coin door, time
// doors: the phase buckets, a key, two purple switches in a row: on, then off again) and batches that pick the cells of
// the batches before (states that went through the host's pool): every record replayed along its path (the pick's
// path, then this run's inputs)
{
	const GX = require('../src/goexplore.js');
	const field = RF.reachField(level), RM = GX.roomOf(level, { legacy: true });
	const K = 512, seeds = [11, 12, 13];
	const job = Buffer.concat(seeds.flatMap((sd) => [Buffer.from(`batch ${K} 100000 ${sd}\n`), Buffer.alloc(4 * K)]).concat([Buffer.from('stop\n')]));
	const roll = (extra, lvBin, lvReach, input) => {
		const full = ['roll', lvBin || bin, `--reach=${lvReach || reach}`, '--rolls=8', '--roll=40', '--cap=65536', `--launch-ms=${TARGET}`, ...extra, ...(args.ptxdir ? [`--ptxdir=${path.resolve(args.ptxdir)}`] : [])];
		const [cmd, argv] = LOCK ? [process.execPath, [LOCK, TOOL, ...full]] : [TOOL, full];
		const t0 = Date.now();
		const r = spawnSync(cmd, argv, { input: input || job, maxBuffer: 1 << 28, timeout: (LOCK ? 3600 : 120) * 1000, windowsHide: true });
		const out = r.stdout || Buffer.alloc(0), lines = [], batches = [];
		for (let o = 0; o < out.length;) {
			const k = out.indexOf(10, o);
			if (k < 0) break;
			let ev = {};
			try { ev = JSON.parse(out.subarray(o, k).toString('utf8')); } catch (e) { /* not JSON */ }
			o = k + 1;
			lines.push(ev);
			if (ev.ev === 'batch') {
				const recs = [];
				for (let j = 0; j < ev.n; j++) { const q = o + 24 * j; recs.push([out.readInt32LE(q), out.readInt32LE(q + 4), out.readInt32LE(q + 8), out.readInt32LE(q + 12), out.readInt32LE(q + 16), out.readInt32LE(q + 20)]); }
				batches.push(recs);
				o += ev.bytes;
			}
		}
		return { code: r.status, lines, ms: Date.now() - t0, err: String(r.stderr || '').trim().split('\n').pop(), batches };
	};
	const a = roll([]);
	bound('roll (3 batches of 512 picks x 8 runs x 40 ticks)', a);
	let bad = 0, n = 0;
	const sim = new E.EESim(level), inp = new E.EEInput();
	a.batches.forEach((recs, bi) => {
		for (const [d, t, fifths, room, pk, rs] of recs) {
			const ms = new Uint8Array((rs >>> 16) + 1);
			GX.rollInputs(GX.rollSeed(seeds[bi], pk, rs & 0xffff), ms.length, 0.85, ms, 0);
			sim.reset();
			for (const x of ms) { E.applyMask(inp, x); sim.tick(inp); }
			n++;
			if (d < 0 || ms.length !== t || RF.fifthsAt(field, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery) !== fifths || (RM.key(sim) | 0) !== room) bad++;
		}
	});
	check('roll: every new cell\'s state, replayed from its seed in the JS engine, has the GPU\'s tick, reach cost and room', n > 100 && bad === 0, `${n} cells, ${bad} different`);
	const b2 = roll(['--launch-items=128']);
	const key = (r) => r.batches.map((recs) => recs.map((x) => x.slice(1).join(',')).join(';')).join('|');
	check('roll split into launches of 128 runs / cells: the same records in the same order', b2.code === 0 && key(a) === key(b2) && summary(b2).kernelLaunches > summary(a).kernelLaunches,
		`${a.batches.map((x) => x.length).join(' + ')} records; ${summary(a).kernelLaunches} launches vs ${summary(b2).kernelLaunches}`);
	// the roll mix (goexplore.js --rollMix): with --rollMax=120 a batch line may give its own run length and keep ("batch
	// K maxT seed Lr keep"); every record replayed from its seed with its batch's keep (runs of 120 ticks kept with p 0.95,
	// of 25 with p 0.6, then the plain line: --roll / --keep); a run length past --rollMax is a bad job
	{
		const mix = [[120, 0.95], [25, 0.6], [null, null]], mSeeds = [21, 22, 23];
		const mJob = Buffer.concat(mix.flatMap(([lr, kp], i) => [Buffer.from(lr ? `batch ${K} 100000 ${mSeeds[i]} ${lr} ${kp}\n` : `batch ${K} 100000 ${mSeeds[i]}\n`), Buffer.alloc(4 * K)])
			.concat([Buffer.from('stop\n')]));
		const mr = roll(['--rollMax=120'], null, null, mJob);
		bound('roll mix (3 batches: 120 ticks / keep 0.95, 25 / 0.6, the plain 40 / 0.85)', mr);
		const st = mr.lines.find((l) => l.ev === 'start') || {};
		let mn = 0, mBad = 0, longest = [0, 0, 0];
		mr.batches.forEach((recs, bi) => {
			const kp = mix[bi][1] === null ? 0.85 : mix[bi][1];
			for (const [d, t, fifths, room, pk, rs] of recs) {
				const ms = new Uint8Array((rs >>> 16) + 1);
				GX.rollInputs(GX.rollSeed(mSeeds[bi], pk, rs & 0xffff), ms.length, kp, ms, 0);
				sim.reset();
				for (const x of ms) { E.applyMask(inp, x); sim.tick(inp); }
				mn++;
				if (ms.length > longest[bi]) longest[bi] = ms.length;
				if (d < 0 || ms.length !== t || RF.fifthsAt(field, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery) !== fifths || (RM.key(sim) | 0) !== room) mBad++;
			}
		});
		check('roll mix: the start says "mix":1 and the rollMax; every record replayed with its batch\'s run length and keep has the GPU\'s tick, reach cost and room',
			mr.code === 0 && st.mix === 1 && st.rollMax === 120 && mr.batches.length === 3 && mn > 100 && mBad === 0 && longest[0] > 40 && longest[1] <= 25 && longest[2] <= 40,
			`start mix ${st.mix} rollMax ${st.rollMax}; ${mr.batches.map((x) => x.length).join(' + ')} records, ${mBad} different; longest runs ${longest.join(' / ')}${mr.code ? `; exit ${mr.code} ${mr.err}` : ''}`);
		const over = roll(['--rollMax=120'], null, null, Buffer.from(`batch ${K} 100000 5 121 0.9\n`));
		// (the error line quotes the job line with its newline: not one JSON line, so only the exit code and no batch)
		check('roll mix: a run length past --rollMax is a bad job (exit 3, no batch)', over.code === 3 && over.batches.length === 0, `exit ${over.code}`);
	}
	// the doors' room
	const dc = [];
	for (let x = 0; x < W; x++) dc.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 0; y < H; y++) dc.push([0, y, 9], [W - 1, y, 9]);
	dc.push([2, 14, 255], [38, 14, 121], [3, 14, 423, 1], [4, 14, 113, 1], [6, 14, 113, 1], [5, 12, 100], [7, 12, 100], [9, 12, 100], [8, 13, 6],
		[30, 14, 184, 1], [32, 14, 1027, 1], [34, 14, 43, 2], [36, 14, 156], [37, 14, 23]);
	const dl = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'roll doors', width: W, height: H, cells: dc }))));
	const dBin = path.join(TMP, 'doors.bin'), dReach = path.join(TMP, 'doors_reach.bin');
	fs.writeFileSync(dBin, G.levelBlob(dl));
	const dField = RF.reachField(dl), dRM = GX.roomOf(dl, { legacy: true });
	RF.writeReachFile(dField, dReach);
	// (batch 1 picks the start, batch 2 the cells 1..128, batch 3 the cells 150..277, 4 picks each: dense ids the batches
	// before gave out)
	const dSeeds = [21, 22, 23], picksOf = [new Uint32Array(K), new Uint32Array(K).map((_, j) => 1 + (j & 127)), new Uint32Array(K).map((_, j) => 150 + (j & 127))];
	const dJob = Buffer.concat(dSeeds.flatMap((sd, bi) => [Buffer.from(`batch ${K} 100000 ${sd}\n`), Buffer.from(picksOf[bi].buffer)]).concat([Buffer.from('stop\n')]));
	const d = roll(['--cap=200000'], dBin, dReach, dJob);
	bound('roll on the doors\' room (3 batches: the start, then cells of the batches before)', d);
	// (the room as the GPU keys it: a switch that went on and off again leaves an entry in the engine's Map, which roomOf
	// hashes (its sum 0) and the GPU, which keeps only the switches' bits, does not: the same doors, only the name differs)
	const gpuRoom = (sim) => {
		const sw = sim._switches, osw = sim._oswitches;
		const on = (m) => new Map([...m].filter(([, v]) => v === true));
		sim._switches = on(sw); sim._oswitches = on(osw);
		const k = dRM.key(sim) | 0;
		sim._switches = sw; sim._oswitches = osw;
		return k;
	};
	const paths = new Map([[0, new Uint8Array(0)]]);
	let dn = 0, dBad = 0, unordered = 0, offAgain = 0, team = 0, coins = 0, keys = 0, noPath = 0, deep = 0;
	const phases = new Set();
	const dSim = new E.EESim(dl), dInp = new E.EEInput();
	d.batches.forEach((recs, bi) => {
		const upd = [];
		let prev = -1;
		for (const [dd, t, fifths, room, pk, rs] of recs) {
			const run = rs & 0xffff, step = rs >>> 16;
			const k = ((t * K + pk) * 8 + run) * 256 + step;
			if (k <= prev) unordered++;
			prev = k;
			const base = paths.get(picksOf[bi][pk]);
			if (!base) { noPath++; continue; }
			const ms = new Uint8Array(base.length + step + 1);
			ms.set(base);
			GX.rollInputs(GX.rollSeed(dSeeds[bi], pk, run), step + 1, 0.85, ms, base.length);
			dSim.reset();
			for (const x of ms) { E.applyMask(dInp, x); dSim.tick(dInp); }
			dn++;
			if (base.length > 0) deep++;
			if (dd < 0 || ms.length !== t || RF.fifthsAt(dField, dSim.px, dSim.py, dSim.speed_y, dSim._q0, dSim._q1, dSim._slippery) !== fifths || gpuRoom(dSim) !== room) dBad++;
			if ([...dSim._switches.values()].some((v) => v !== true)) offAgain++;
			if (dSim.team) team++;
			if (dSim.coins > 0) coins++;
			if (dSim._keysMask) keys++;
			phases.add(Math.floor((dSim._ticks % 1000) / 50));
			if (dd >= 0) upd.push([dd, ms]);
		}
		for (const [dd, ms] of upd) paths.set(dd, ms);
	});
	check('roll on the doors\' room: every record, replayed along its pick\'s path and its run, has the GPU\'s tick, reach cost and room; in (tick, pick, run, step) order',
		d.code === 0 && d.batches.length === 3 && dn > 1000 && deep > 500 && dBad === 0 && unordered === 0 && noPath === 0 && offAgain > 0 && team > 0 && coins > 0 && keys > 0 && phases.size > 1,
		`${dn} records (${deep} from picked cells), ${dBad} different, ${unordered} out of order, ${noPath} without a path; switches on and off again ${offAgain}, team ${team}, coins ${coins}, ` +
		`key ${keys}, ${phases.size} door phases${d.code ? `; exit ${d.code} ${d.err}` : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
