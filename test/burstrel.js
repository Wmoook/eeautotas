'use strict';
// test/burstrel.js - the burst server's release and the free-memory fit (n3-burst-server-release, NIGHT3 cycle 8; OPT-IN:
// goexplore.js --burstRel=1, editor.js body burstRel: true / EEAT_BURSTREL=1; native/launch.h checkRelease, waitUnpaused,
// native/explorehost.h serveExplore, native/cudadrv.h fitHeadroom / fitShare / EEAT_GPU_FREE_MB):
//   cpu  (no GPU; the laptop) the editor's choices: gpuFitEnv (the stall escape's bursts a headroom of one context, the one
//        search's bursts and the GPU random runs the native rule, every move / the beams / the breaker / the relay none;
//        none with the flag off), pauseHowOf ("release" only for a burst server's strategy in a wall breaker round with the
//        flag on), the one search's and the escape's command lines (--burstRel=1 with the flag, not without), bursts.js
//        relArgs (the server's --release=1 [--release-ms]), goexplore.js's default (EEAT_BURSTREL=1); goexplore.js's bursts
//        with a stand-in tool whose jobs end "released": ended bursts like a time-out (no failure, no warning, the attempts
//        taken), counted in done.gpu.released
//   gpu  (--gpu [--tool=<eegpu>]; a box, NEVER the laptop) the native server with --release=1: a job paused by a pause file
//        reading "release" ends at once (end "released"; the idle line's release "released" and its freeMB well above the
//        done line's: the buffers freed), a job sent while the pause file exists prints no ready line until the file goes
//        (the idle line's heldMs), a pause that outlives the job's seconds ends it at once (end "time"), --release-ms, a
//        stop file during the held wait (done "stopped", then idle), an unpaused job the same with and without --release
//        (layers, states, end); the fit with a stubbed free-memory probe (EEAT_GPU_FREE_MB): with the share 1 a fit event
//        whose shareMB is the stub less one context (EEAT_GPU_FIT_CTX=1), the default rule's headroom larger, no fit event
//        with plenty free (main's size)
// usage: node test/burstrel.js [--gpu [--tool=<eegpu>]]      Exit code 1 if any check fails. Writes nothing in the repo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const GPU = argv.includes('--gpu');
const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-burstrel-'));
process.env.EEAT_HOME = HOME;   // (before src/ is required: jobs and data go to the temp folder)
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const SRC = path.resolve(__dirname, '..', 'src');
const EL = require('../src/eelvl.js');
const E = require('../src/eesim.js');
const ED = require('../src/editor.js');
const BU = require('../src/bursts.js');
const G = require('../src/gpu.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function room(W, H) {
	const c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
	return c;
}
function goexplore(file, opts, env) {
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, [path.join(SRC, 'goexplore.js'), file, ...opts], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env || process.env });
		ch.stdin.on('error', () => { /* it ended */ });
		ch.stdin.end();
		let out = '', err = '';
		ch.stdout.on('data', (c) => { out += c; });
		ch.stderr.on('data', (c) => { err += c; });
		ch.on('close', (code) => {
			const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return { bad: l }; } });
			resolve({ code, err, events, done: events.find((e) => e.ev === 'done') || null, summary: out.split('\n').find((l) => l.startsWith('[goexplore]')) || err.slice(-300) });
		});
	});
}

async function cpuSection() {
	section('cpu: the editor\'s choices and the bursts\' "released" end (no GPU)');
	const keys = ['escape', 'goexplore', 'gorolls', 'explore', 'breaker', 'relay', 'goal', 'guide'];
	const on = keys.map((k) => JSON.stringify(ED.gpuFitEnv(k, true))), off = keys.map((k) => ED.gpuFitEnv(k, false));
	check('gpuFitEnv: the escape\'s bursts the share 1 and a headroom of one context (the stall tools first), the one search\'s bursts and the GPU random runs the share 1 and the native rule, every move / the breaker / the relay / the beams none; none with the flag off',
		on[0] === JSON.stringify({ EEAT_GPU_FIT: '1', EEAT_GPU_FIT_SHARE: '1', EEAT_GPU_FIT_CTX: '1' }) &&
		on[1] === JSON.stringify({ EEAT_GPU_FIT: '1', EEAT_GPU_FIT_SHARE: '1' }) && on[2] === on[1] && on.slice(3).every((x) => x === 'null') && off.every((x) => x === null),
		on.join(' | '));
	const hw = [ED.pauseHowOf({ gpuShare: true }, true, true), ED.pauseHowOf({ gpuShare: true }, false, true), ED.pauseHowOf({ gpuShare: true }, true, false),
		ED.pauseHowOf({ key: 'explore' }, true, true), ED.pauseHowOf(null, true, true)];
	check('pauseHowOf: "release" only for a burst server\'s strategy (gpuShare) in a wall breaker round with the flag on, else "pause"',
		hw.join() === 'release,pause,pause,pause,pause', hw.join());
	const rel = [BU.relArgs({ burstRel: 1 }), BU.relArgs({ burstRel: 1, burstRelS: 2.5 }), BU.relArgs({ burstRel: 0, burstRelS: 3 }), BU.relArgs({})].map((a) => a.join(' ') || '-');
	check('bursts.js relArgs: the server\'s --release=1 with --burstRel=1 (and --release-ms from --burstRelS), nothing without',
		rel.join('|') === '--release=1|--release=1 --release-ms=2500|-|-', rel.join(' | '));
	const f = { eelvl: 'l.eelvl', steerCpu: '', steer: '', steerDist: true };
	const q = { seconds: 60, tool: 'eegpu', pauseFile: 'pause_1', work: 'w', workers: 4, seed: 1001, prefixFile: 'p.eetas', escFlags: [] };
	const base = { workers: 8, seed: 1, cpuDepth: 100000, deaths: false, bursts: true, burstBig: false };
	const one1 = ED.STRATEGIES.goexplore.args(f, Object.assign({}, base, { burstRel: true }), q), one0 = ED.STRATEGIES.goexplore.args(f, base, q);
	const esc1 = ED.STRATEGIES.escape.args(f, Object.assign({}, base, { burstRel: true }), q);
	const cpu1 = ED.STRATEGIES.goexplore.args(f, Object.assign({}, base, { bursts: false, burstRel: true }), q);
	check('the one search\'s and the escape\'s command lines: --burstRel=1 with the flag (next to --bursts=1), not without it, not without bursts',
		one1.includes('--burstRel=1') && esc1.includes('--burstRel=1') && !one0.includes('--burstRel=1') && !cpu1.includes('--burstRel=1') && one1.includes('--bursts=1'),
		`${one1.filter((x) => /burst/.test(x)).join(' ')} | ${one0.filter((x) => /burst/.test(x)).join(' ')}`);
	// goexplore.js's default: off, EEAT_BURSTREL=1 on (the child processes of an editor run with it inherit it)
	const src = fs.readFileSync(path.join(SRC, 'goexplore.js'), 'utf8');
	check('goexplore.js: --burstRel off by default, EEAT_BURSTREL=1 on (its DEFAULTS), --burstRelS 0',
		/burstRel: process\.env\.EEAT_BURSTREL === '1' \? 1 : 0, burstRelS: 0/.test(src), (src.match(/burstRel: [^,]+, burstRelS: \d+/) || ['-'])[0]);

	// goexplore.js's bursts with a stand-in tool (a process per burst: a .js tool) whose jobs print an attempt nearer than
	// their start and end "released" (as the server's release does): ended bursts, not failures; the attempts imported
	const kd = room(60, 50);
	for (let y = 1; y < 49; y++) kd.push([30, y, 23]);
	kd.push([12, 48, 6], [50, 48, 121], [3, 48, 255]);
	const kdBuf = ED.eelvlOf({ name: 'key door', width: 60, height: 50, cells: kd });
	const kdFile = path.join(HOME, 'keydoor.eelvl');
	fs.writeFileSync(kdFile, kdBuf);
	const tool = path.join(HOME, 'burst_rel.js'), log = path.join(HOME, 'burst_rel.log');
	fs.writeFileSync(tool, [
		"'use strict';",
		"const fs = require('fs');",
		`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
		"console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'released', layers: 3, states: 40, maxLaunchMs: 4, maxKernelMs: 3 })), 100);",
	].join('\n'));
	const r = await goexplore(kdFile, ['--workers=1', '--seed=3', '--seconds=8', '--mem=300', '--bursts=1', `--tool=${tool}`, `--work=${path.join(HOME, 'bursts')}`, '--burstRel=1']);
	const g = r.done && r.done.gpu;
	let calls = [];
	try { calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { /* none */ }
	check('the bursts\' "released" end: an ended burst like a time-out (counted in bursts and released, no failure, no warning, the bursts go on)',
		!!g && g.bursts >= 2 && g.released === g.bursts && g.failed === 0 && g.oom === 0 && !r.events.some((e) => e.ev === 'warning' && /burst/.test(e.text || '')) && calls.length >= 2,
		`${JSON.stringify(g && { bursts: g.bursts, released: g.released, relTime: g.relTime, failed: g.failed, oom: g.oom })}; ${calls.length} calls; ${r.summary}`);
	// (a process per burst never gets the server's flags: --release=1 goes to the server only, relArgs)
	check('a process per burst (the .js stand-in, an older eegpu) gets no --release flag', calls.length > 0 && calls.every((a) => !a.some((x) => /^--release/.test(x))),
		calls.length ? calls[0].filter((x) => /^--(release|serve|pausefile)/.test(x)).join(' ') || 'none' : '-');
}

// ---------------------------------------------------------------- the native server on a GPU (a box only)
/** a long-lived `eegpu explore <bin> --serve=1 ...` with its lines collected; job(args) sends one job */
function server(tool, bin, extra, env) {
	const ch = spawn(tool, ['explore', bin, '--serve=1', `--parent=${process.pid}`, ...extra], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, env || {}) });
	const S = { ch, lines: [], buf: '', err: '' };
	ch.stdout.on('data', (d) => {
		S.buf += d;
		let k;
		while ((k = S.buf.indexOf('\n')) >= 0) {
			const l = S.buf.slice(0, k); S.buf = S.buf.slice(k + 1);
			if (l.startsWith('{')) { try { S.lines.push(Object.assign(JSON.parse(l), { _t: Date.now() })); } catch (e) { /* cut */ } }
		}
	});
	ch.stderr.on('data', (d) => { S.err = (S.err + d).slice(-2000); });
	S.job = (args) => { S.mark = S.lines.length; ch.stdin.write(`${args.join('\t')}\n`); };
	S.since = () => S.lines.slice(S.mark);
	S.wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const l = S.since().find(pred); if (l) return l; await sleep(20); } return null; };
	S.quit = async () => { try { ch.stdin.write('quit\n'); ch.stdin.end(); } catch (e) { /* gone */ } for (let k = 0; k < 100 && ch.exitCode === null; k++) await sleep(50); };
	return S;
}
async function gpuSection() {
	section('gpu: the burst server\'s release and the free-memory fit (eegpu explore --serve --release=1)');
	const tool = arg('tool') ? path.resolve(arg('tool')) : G.nativeTool();
	if (!tool) { check('the native tool', false, 'missing: node tools/build-native.js'); return; }
	// an open 200 x 100 room: every move from the start runs for a while (many states), the trophy far away
	const lv = room(200, 100);
	for (let x = 20; x < 190; x += 7) lv.push([x, 90 - (x % 23), 9]);
	lv.push([3, 97, 255], [196, 3, 121]);
	const buf = ED.eelvlOf({ name: 'open room', width: 200, height: 100, cells: lv });
	const level = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	const bin = path.join(HOME, 'open.bin');
	fs.writeFileSync(bin, G.levelBlob(level));
	const pause = path.join(HOME, 'pause'), stop = path.join(HOME, 'stop');
	const job = (seconds, more = []) => ['-', '--finish=1', '--discrete=1', '--depth=100000', `--seconds=${seconds}`, '--coarse=0', '--cqx=0.25', '--cqv=16', '--qy=1', '--qvy=16',
		'--cells=26', '--cap=1048576', `--stopfile=${stop}`, ...more];
	const rm = (f) => { try { fs.unlinkSync(f); } catch (e) { /* none */ } };
	rm(pause); rm(stop);
	const S = server(tool, bin, ['--release=1', `--pausefile=${pause}`]);
	const serving = await S.wait((l) => l.ev === 'serving' || l.error, 120000);
	check('the server starts with --release=1 (its serving line says so)', !!serving && serving.ev === 'serving' && serving.release === 1, JSON.stringify(serving || S.err.slice(-300)));
	if (!serving || serving.ev !== 'serving') { await S.quit(); return; }
	// (1) a running job paused with "release": ends at once, its buffers freed
	S.job(job(60));
	const rd = await S.wait((l) => l.ev === 'ready', 60000);
	await sleep(1500);
	fs.writeFileSync(pause, 'pause');
	await sleep(1500);
	const still = S.since().find((l) => l.ev === 'done');
	const tRel = Date.now();
	fs.writeFileSync(pause, 'release');
	const dn = await S.wait((l) => l.ev === 'done', 5000), id1 = await S.wait((l) => l.ev === 'idle', 5000);
	check('a paused job holds on while the pause file says "pause", and ends at once when it says "release" (end "released")',
		!!rd && !still && !!dn && dn.end === 'released' && dn._t - tRel < 1000 && !!id1 && id1.release === 'released',
		`ready ${!!rd}, done while paused ${!!still}, end ${dn && dn.end} after ${dn ? dn._t - tRel : '-'} ms, idle ${JSON.stringify(id1)}`);
	const freeJob = dn && dn.gpu ? dn.gpu.freeMB : NaN, freeIdle = id1 ? id1.freeMB : NaN;
	check('... its buffers freed: the idle line\'s free memory well above the done line\'s (the 2^26 table and 1 M-state layers: 1+ GB)',
		freeIdle - freeJob >= 1000, `free during the job ${freeJob} MB, after ${freeIdle} MB`);
	// (2) a job sent while the pause file exists: no ready line until it goes (heldMs)
	S.job(job(3));
	await sleep(2000);
	const early = S.since().find((l) => l.ev === 'ready');
	rm(pause);
	const rd2 = await S.wait((l) => l.ev === 'ready', 30000), id2 = await S.wait((l) => l.ev === 'idle', 30000);
	check('a job sent during a pause allocates nothing until its turn: no ready line while the pause file exists, then the job runs (heldMs)',
		!early && !!rd2 && !!id2 && id2.heldMs >= 1500 && id2.code === 0, `early ready ${!!early}; idle ${JSON.stringify(id2)}`);
	// (3) a pause that outlives the job's seconds: it ends at once, "time"
	S.job(job(2));
	await S.wait((l) => l.ev === 'ready', 30000);
	const tp = Date.now();
	fs.writeFileSync(pause, 'pause');
	const dn3 = await S.wait((l) => l.ev === 'done', 8000), id3 = await S.wait((l) => l.ev === 'idle', 8000);
	check('a pause that outlives the job\'s seconds ends it at once (end "time", idle release "time"), not after the pause',
		!!dn3 && dn3.end === 'time' && dn3._t - tp < 3000 && !!id3 && id3.release === 'time', `end ${dn3 && dn3.end} after ${dn3 ? dn3._t - tp : '-'} ms; ${JSON.stringify(id3)}`);
	// (4) a stop file during the held wait: done "stopped", then idle
	S.job(job(30));
	await sleep(500);
	fs.writeFileSync(stop, '1');
	const dn4 = await S.wait((l) => l.ev === 'done', 5000), id4 = await S.wait((l) => l.ev === 'idle', 5000);
	check('a stop file during the held wait: done "stopped" with nothing searched, then idle', !!dn4 && dn4.end === 'stopped' && dn4.states === 0 && !!id4, `${JSON.stringify(dn4)} ${JSON.stringify(id4)}`);
	rm(stop); rm(pause);
	await S.quit();
	// (5) --release-ms: a pause of that long ends the job
	const S2 = server(tool, bin, ['--release=1', '--release-ms=700', `--pausefile=${pause}`]);
	await S2.wait((l) => l.ev === 'serving', 120000);
	S2.job(job(60));
	await S2.wait((l) => l.ev === 'ready', 60000);
	await sleep(1000);
	const t5 = Date.now();
	fs.writeFileSync(pause, 'pause');
	const dn5 = await S2.wait((l) => l.ev === 'done', 5000);
	check('--release-ms=700: a pause of 0.7 s ends the job ("released")', !!dn5 && dn5.end === 'released' && dn5._t - t5 >= 600 && dn5._t - t5 < 2500, `end ${dn5 && dn5.end} after ${dn5 ? dn5._t - t5 : '-'} ms`);
	rm(pause);
	await S2.quit();
	// (6) an unpaused job: the same with and without --release (layers, states, end; a fixed depth, no clock)
	const same = [];
	for (const extra of [['--release=1', `--pausefile=${pause}`], [`--pausefile=${pause}`]]) {
		const S3 = server(tool, bin, extra);
		await S3.wait((l) => l.ev === 'serving', 120000);
		S3.job(['-', '--finish=1', '--discrete=1', '--depth=120', '--seconds=120', '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', '--cells=24', '--cap=65536']);
		const d = await S3.wait((l) => l.ev === 'done', 120000);
		same.push(d ? `${d.end}/${d.layers}/${d.states}/${d.ticks}` : 'none');
		await S3.quit();
	}
	check('an unpaused job: the same layers, states and end with and without --release', same[0] === same[1] && same[0] !== 'none', same.join(' vs '));
	// (7) the fit with a stubbed free-memory probe (EEAT_GPU_FREE_MB): share 1 = the stub less the headroom
	const fitRun = async (env) => {
		const S4 = server(tool, bin, [], env);
		const sv = await S4.wait((l) => l.ev === 'serving', 120000);
		S4.job(['-', '--finish=1', '--discrete=1', '--depth=20', '--seconds=10', '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', '--cells=26', '--cap=1048576']);
		const d = await S4.wait((l) => l.ev === 'done' || l.error, 60000);
		const fit = S4.since().find((l) => l.ev === 'fit') || null;
		await S4.quit();
		// (the context's estimate after the job took its kernels: the done line's; a kernel's stack need can raise it)
		return { fit, done: d, ctxMB: d && d.gpu && Number.isFinite(d.gpu.ctxMB) ? d.gpu.ctxMB : sv && sv.gpu ? sv.gpu.ctxMB : NaN };
	};
	const f1 = await fitRun({ EEAT_GPU_FIT: '1', EEAT_GPU_FIT_SHARE: '1', EEAT_GPU_FIT_CTX: '1', EEAT_GPU_FREE_MB: '4000' });
	const f2 = await fitRun({ EEAT_GPU_FIT: '1', EEAT_GPU_FIT_SHARE: '1', EEAT_GPU_FREE_MB: '4000' });
	const f3 = await fitRun({ EEAT_GPU_FIT: '1', EEAT_GPU_FIT_SHARE: '1', EEAT_GPU_FIT_CTX: '1' });
	const f0 = await fitRun({ EEAT_GPU_FREE_MB: '4000' });
	const head1 = f1.fit ? 4000 - f1.fit.shareMB : NaN, head2 = f2.fit ? 4000 - f2.fit.shareMB : NaN;
	check('the fit, the share 1 and one context of headroom (the stall tools): a stubbed 4,000 MB free gives a share of 4,000 MB less about one context, the table and cap fitted into it',
		!!f1.fit && Math.abs(head1 - Math.max(512, f1.ctxMB)) <= 2 && !!f1.done && f1.done.end !== undefined && !f1.done.error, `${JSON.stringify(f1.fit)} (ctx ${f1.ctxMB} MB; headroom ${head1} MB)`);
	check('... the default headroom (two contexts, at least 1.5 GB and 1/20 of the GPU: the one search\'s bursts, the GPU random runs) is larger',
		!!f2.fit && head2 > head1 && head2 >= 1536 - 2, `${JSON.stringify(f2.fit)} (headroom ${head2} MB)`);
	check('... with plenty of free memory no fit event: the size asked (main\'s); without EEAT_GPU_FIT the stub changes nothing',
		!f3.fit && !!f3.done && !f3.done.error && !f0.fit, `${JSON.stringify(f3.fit)} / ${JSON.stringify(f0.fit)}`);
}

(async () => {
	await cpuSection();
	if (GPU) await gpuSection();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
