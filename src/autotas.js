'use strict';
// The AutoTASer: from a level alone to a near-optimal TAS in as little time as possible, anytime (the best so far is
// always a verified TAS). One pipeline, every piece fed by the others:
//   1. Find a route (src/editor.js start(): every move, the relay, the beams, the CPU search) until its first route.
//   2. At once a job from that route (jobs.importJob) and its optimizer (grind.js, with the GPU searcher when a GPU
//      is there: gpusearch.js, whose bandit splits the GPU between its search families and "every move" windows along
//      the run by their measured ticks saved per second, and runs the idle-start windows).
//   3. Every newer route of Find a route goes to the job (jobs.tryCandidate: the inbox; the grind splices a slower one
//      with its best, so its faster stretches are kept).
//   4. The handoff: Find a route has the GPU first (the job's GPU searcher waits while the editor's busy marker is
//      fresh). Once Find a route has had no new route for as long as it took to find its last one (at least
//      --handoffMin 20 s), it is stopped and the optimizer gets the GPU. Measured (the night of 2026-09-26,
//      src/out/night/fast_curves.md): after 3-37 s Find a route found nothing more in 10-20 min, and on the ice level
//      it ended by itself at 41.6 s while its GPU sat idle for 29 min.
//   5. Until the time budget (--minutes); then the job is paused (its best stays; the app can go on with it). When Find a
//      route ends without a route (stopped, a failed physics check, a proof that none exists), the AutoTASer ends too.
// The CPU: until the handoff Find a route keeps its W workers (the CPU search found the ice level's route) and the grind's
// stages get SHARE_OF_W = max(1, min(W / 4, threads - W)) threads (<job>/cpu_share, touched while Find a route runs;
// grind.js reads it at each stage's start); after it, W. (Both at W: 2 x 14 workers on the laptop's 16 threads.)
// The first route's job is started like the app's Resume: one job at a time, so a job that runs (the user's too) is
// paused; at the end the AutoTASer pauses its own job only if it still runs the session it started.
// Every TAS on the way is replayed (C.evaluate) and judged by the job's own rule (common.judge).
//   node src/autotas.js <level.eelvl> [--minutes=30] [--workers=N] [--name=] [--out=<dir>] [--handoffMin=20] [--cpu=1]
// (Like the app's Resume, its job pauses any other running job, the user's own included: one job at a time.)
// Prints one JSON line per event ({t, ev: start|route|job|fed|best|handoff|end, ...}; t = seconds since the start) and
// writes them to <out>/timeline.jsonl with <out>/final.eetas (default out: src/out/autotas/<level name>).
// As a module: run(opts) -> {stop(), state()} (opts: {eelvl: Buffer, minutes, workers, name, out, handoffMin, cpu,
// startJob, stopJob, gpu (the server's GPU info), onEvent}).
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common.js');

const HANDOFF_MIN_S = 20;

function run(o) {
	const ED = require('./editor.js');
	const J = require('./jobs.js');
	const G = require('./gpu.js');
	const L = require('./eelvl.js');
	const E = C.E;
	const t0 = Date.now();
	const since = () => Math.round((Date.now() - t0) / 100) / 10;
	const budgetMs = Math.max(0.5, +o.minutes || 30) * 60e3;
	const threads = os.cpus().length;
	const W = Math.max(1, Math.min(threads, +o.workers || Math.max(1, threads - 2)));
	const handoffMin = Math.max(1, +(o.handoffMin || HANDOFF_MIN_S));
	const startJob = o.startJob || ((id, w, opts) => J.startJob(id, w, opts));
	const stopJob = o.stopJob || ((id) => J.stopJob(id));
	const out = o.out || null;
	if (out) fs.mkdirSync(out, { recursive: true });
	const level = E.prepareLevel(Object.assign(L.toSimLevel(L.readEelvl(o.eelvl)), { start_mode: 'reset' }));
	const S = { state: 'finding', job: null, best: null, bestT: null, routes: 0, handoff: null, events: [] };
	const emit = (ev) => {
		const rec = Object.assign({ t: since() }, ev);
		S.events.push(rec);
		if (out) { try { fs.appendFileSync(path.join(out, 'timeline.jsonl'), JSON.stringify(rec) + '\n'); } catch (e) { /* read-only */ } }
		if (o.onEvent) o.onEvent(rec);
	};
	const better = (rt) => { if (S.best === null || rt < S.best) { S.best = rt; S.bestT = since(); return true; } return false; };
	const gpuOk = !o.cpu && !!G.nativeTool() && !G.unsupported(level) && !(o.gpu && o.gpu.available === false);
	emit({ ev: 'start', name: o.name || '', minutes: budgetMs / 60e3, workers: W, gpu: gpuOk, level: `${level.width}x${level.height}` });
	ED.start({ eelvlB64: o.eelvl.toString('base64'), seconds: Math.ceil(budgetMs / 1000), width: 65536, workers: W }, o.gpu || { available: gpuOk });
	let lastKey = '', lastRouteAt = 0, frDone = false, hist = 0, ended = false, busy = false;
	const pending = [];   // Find a route's routes waiting for the job
	let jobPid = 0;       // (the grind the AutoTASer started: finish stops the job only while it still runs that one)
	const share = Math.max(1, Math.min(Math.floor(W / 4), threads - W));
	let shareAt = 0;
	const shareFile = () => (S.job ? path.join(J.jobDir(S.job), 'cpu_share') : null);
	function holdShare(on) {
		const f = shareFile();
		if (!f) return;
		try { if (on) { if (Date.now() - shareAt >= 3000) { fs.writeFileSync(f, String(share)); shareAt = Date.now(); } } else fs.unlinkSync(f); } catch (e) { /* none */ }
	}
	async function feedRoutes() {
		while (S.job && pending.length) {
			const r = pending.shift();
			const res = await J.tryCandidate(S.job, C.eetasBytes(r.ms), { source: `Find a route (${r.strategy || 'route'})`, wait: 0 });
			emit({ ev: 'fed', runTicks: r.runTicks, handed: res.handed, bestThen: res.best ? res.best.runTicks : null });
		}
	}
	function onRoute(r) {
		const masks = Uint8Array.from(String(r.inputs), (ch) => (ch.charCodeAt(0) - 48) & 31);
		const ev = C.evaluate(level, masks);
		if (!ev) { emit({ ev: 'route', runTicks: r.runTicks, verified: null, strategy: r.strategy, note: 'does not replay: dropped' }); return; }
		lastRouteAt = Date.now();
		S.routes++;
		// (only the first route counts as a best here: it is the job's base; a newer one counts once the job accepts it by
		// its own rule, C.judge: deaths, random-portal chance, and appears in its history)
		const faster = !S.job && !ended ? better(ev.runTicks) : false;
		emit({ ev: 'route', runTicks: ev.runTicks, verified: true, strategy: r.strategy, best: faster });
		if (out) C.writeEetas(path.join(out, `route_${S.routes}_${ev.runTicks}.eetas`), ev.ms);
		if (!S.job) {
			let meta;
			try {
				meta = J.importJob({ eelvl: o.eelvl, eetas: Buffer.from(C.eetasBytes(ev.ms)), name: o.name || 'AutoTAS', eelvlName: `${o.name || 'level'}.eelvl`, eetasName: 'route.eetas', startMode: 'reset' });
			} catch (e) { finish(`the first route could not be made a job: ${e && e.message || e}`); return; }
			S.job = meta.id;
			S.state = 'optimizing';
			if (!frDone) holdShare(true);   // (before the grind starts: its first stage reads it)
			const ch = startJob(S.job, W, { gpu: gpuOk && !G.unsupported(J.loadJobLevel(S.job)) });
			jobPid = (ch && ch.pid) || J.runningPid(S.job) || 0;
			emit({ ev: 'job', job: S.job, runTicks: ev.runTicks, pid: jobPid });
		} else pending.push({ ms: ev.ms, runTicks: ev.runTicks, strategy: r.strategy });
	}
	function pollJob() {
		if (!S.job) return;
		const st = C.readJSON(path.join(J.jobDir(S.job), 'status.json'), {});
		const h = Array.isArray(st.history) ? st.history : [];
		for (; hist < h.length; hist++) {
			const e = h[hist];
			if (better(e.runTicks)) emit({ ev: 'best', runTicks: e.runTicks, saved: e.saved, what: e.what });
		}
	}
	function handoff(why) {
		if (frDone) return;
		frDone = true;
		S.handoff = { t: since(), why };
		emit({ ev: 'handoff', why });
		holdShare(false);
		try { ED.stop(); } catch (e) { /* ended */ }
	}
	const iv = setInterval(async () => {
		if (busy || ended) return;
		busy = true;
		try {
			const st = ED.state();
			const r = st.result;
			if (r && r.inputs) {
				const key = `${r.runTicks}:${r.ticks}:${r.inputs.length}`;
				if (key !== lastKey) { lastKey = key; onRoute(r); }
			}
			if (!frDone && !st.running) {
				frDone = true;
				holdShare(false);
				emit({ ev: 'handoff', why: `Find a route ended (${st.stage})` });
				// (no route: nothing to optimize, so the AutoTASer ends here instead of at the budget)
				if (!S.job && !ended) finish(`Find a route ended without a route (${st.stage}${st.message ? `: ${st.message}` : ''})`);
			}
			if (!frDone) holdShare(true);
			// the handoff: no new route for as long as it took to find the last one (at least handoffMin s)
			if (!frDone && S.job && lastRouteAt && Date.now() - lastRouteAt > Math.max(handoffMin * 1000, lastRouteAt - t0)) {
				handoff(`no new route for ${Math.round((Date.now() - lastRouteAt) / 1000)} s`);
			}
			if (!ended) { await feedRoutes(); pollJob(); }
		} catch (e) { emit({ ev: 'error', error: String(e && e.message || e) }); }
		busy = false;
		if (!ended && Date.now() - t0 >= budgetMs) finish('the time budget');
	}, 250);
	function finish(why) {
		if (ended) return;
		ended = true;
		clearInterval(iv);
		if (!frDone) { frDone = true; try { ED.stop(); } catch (e) { /* ended */ } }
		holdShare(false);
		let final = null;
		if (S.job) {
			// (only the session the AutoTASer started: a job the user resumed or took over in the meantime goes on)
			const rp = J.runningPid(S.job);
			if (rp && (!jobPid || rp === jobPid)) { try { stopJob(S.job); } catch (e) { /* stopped */ } }
			pollJob();
			try {
				const ms = C.readEetas(path.join(J.jobDir(S.job), 'best.eetas'));
				final = C.evaluate(level, ms);
				if (final && out) C.writeEetas(path.join(out, 'final.eetas'), final.ms);
			} catch (e) { /* none */ }
		}
		S.state = 'done';
		emit({ ev: 'end', why, job: S.job, best: S.best, verified: final ? final.runTicks : null });
		if (o.onEnd) o.onEnd(S);
	}
	return { stop: () => finish('stopped'), state: () => S };
}

module.exports = { run, HANDOFF_MIN_S };

if (require.main === module) {
	const args = C.parseArgs(process.argv.slice(2));
	const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
	if (!file || !fs.existsSync(file)) { console.log('usage: node src/autotas.js <level.eelvl> [--minutes=30] [--workers=N] [--name=] [--out=<dir>] [--handoffMin=20] [--cpu=1]\n(its job pauses any other running job, yours included: one job at a time)'); process.exit(2); }
	const name = args.name || path.basename(file, path.extname(file));
	const out = path.resolve(args.out || path.join(__dirname, 'out', 'autotas', name.replace(/[^\w.-]+/g, '_')));
	const ctl = run({ eelvl: fs.readFileSync(file), minutes: args.minutes, workers: args.workers, name, out, handoffMin: args.handoffMin, cpu: args.cpu === '1',
		onEvent: (e) => console.log(JSON.stringify(e)), onEnd: () => setTimeout(() => process.exit(0), 3000) });
	const stop = () => ctl.stop();
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}
