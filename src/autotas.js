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
//      fresh). A route counts only by what it gains the JOB: the job's history entries of its inbox runs and their
//      splices with the best (a route slower than the job's best that adds nothing is no progress). Within a window of
//      the time the first route took (at least --handoffMin 20 s, at most HANDOFF_WIN_MAX_S 120 s), Find a route is
//      stopped and the optimizer gets the GPU once no route has gained the job anything for that long, or the
//      optimizer's own stages gained more in the last window than Find a route's routes, on their share of the CPU and
//      without the GPU, or the routes gained the job less than 1% of its best in the last window (HANDOFF_MIN_GAIN: on
//      the ice level, CPU only, a splice of 1-16 ticks every ~5-25 s kept Find a route going for the whole budget). Before (2026-09-27), any faster route restarted the wait: the GPU random runs found a slightly
//      faster route every 3-35 s on the ice level, so the job's GPU searcher never ran; and the night of 2026-09-26
//      (src/out/night/fast_curves.md) after 3-37 s Find a route found nothing more in 10-20 min.
//   5. Until the time budget (--minutes); then the job is paused (its best stays; the app can go on with it). When Find a
//      route ends without a route (stopped, a failed physics check, a proof that none exists), the AutoTASer ends too.
// The CPU: until the handoff Find a route keeps its W workers (the CPU search found the ice level's route) and the grind's
// stages get SHARE_OF_W = max(1, min(W / 4, threads - W)) threads (<job>/cpu_share, touched while Find a route runs;
// grind.js reads it at each stage's start); after it, W: a stage started on the share is stopped when the share ends and
// runs again on W threads (grind.js runTool `grown`). (Both at W: 2 x 14 workers on the laptop's 16 threads.)
// The first route's job is started like the app's Resume: one job at a time, so a job that runs (the user's too) is
// paused; at the end the AutoTASer pauses its own job only if it still runs the session it started.
// Every TAS on the way is replayed (C.evaluate) and judged by the job's own rule (common.judge).
//   node src/autotas.js <level.eelvl> [--minutes=30] [--workers=N] [--name=] [--out=<dir>] [--handoffMin=20] [--cpu=1] [--seed=N]
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
const HANDOFF_WIN_MAX_S = 120;
/** routes that gained the job less than this share of its best in the last window count as stalled (a trickle of
 *  1-10-tick splices kept Find a route, and the optimizer on its CPU share, going for the whole budget) */
const HANDOFF_MIN_GAIN = 0.01;
/** a route of Find a route waits at most this long for its cleanup (editor.js cleanLater) before it goes to the job */
const CLEAN_WAIT_MS = 15000;
/** a job history entry that Find a route's route made (its inbox run, that run's splice with the best, or a direct try
 *  while the job's grind was not running) */
const FR_WHAT = /^(inbox \(|try: )Find a route\b/;

/**
 * The handoff's reason, or '' (Find a route keeps the GPU). o: {now, t0 (the AutoTASer's start), jobAt (the job's start,
 * at the first route), frAt (the last gain a route made the job, else jobAt), gains [{at, saved, fr}] (the job's
 * improvements, fr: made by a route), handoffMin (s), best (the job's best run ticks, optional)}; times in ms. The
 * window: the time the first route took, within [handoffMin, HANDOFF_WIN_MAX_S]. Due when no route gained the job
 * anything for a window, when in the last window the optimizer's own stages gained more than the routes, or when the
 * routes gained it less than HANDOFF_MIN_GAIN of its best.
 */
function handoffWhy(o) {
	if (!o.jobAt) return '';
	const win = 1000 * Math.max(o.handoffMin || HANDOFF_MIN_S, Math.min(HANDOFF_WIN_MAX_S, (o.jobAt - o.t0) / 1000));
	const s = (ms) => Math.round(ms / 1000);
	if (o.now - Math.max(o.jobAt, o.frAt || 0) > win) return `no route gained the job anything for ${s(o.now - Math.max(o.jobAt, o.frAt || 0))} s`;
	if (o.now - o.jobAt < win) return '';
	let fr = 0, opt = 0;
	for (const g of o.gains) if (g.at > o.now - win) { if (g.fr) fr += g.saved; else opt += g.saved; }
	if (opt > fr) return `in the last ${s(win)} s the optimizer gained ${opt} ticks, the routes ${fr}`;
	return o.best > 0 && fr < HANDOFF_MIN_GAIN * o.best ? `in the last ${s(win)} s the routes gained the job ${fr} ticks, under ${Math.round(100 * HANDOFF_MIN_GAIN)}% of its ${o.best}` : '';
}

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
	// the level check (src/levelcheck.js): the file's md5, a file that differs from EEO's own copy of a campaign level, effect
	// blocks that can never do anything (warnings: the start event and the timeline say so before any search)
	let lc = null;
	try { lc = require('./levelcheck.js').checkLevel(o.eelvl); } catch (e) { lc = null; }
	emit(Object.assign({ ev: 'start', name: o.name || '', minutes: budgetMs / 60e3, workers: W, gpu: gpuOk, level: `${level.width}x${level.height}` },
		lc ? { md5: lc.md5, ...(lc.warnings.length ? { warnings: lc.warnings } : {}), ...(lc.notes.length ? { notes: lc.notes } : {}) } : {}));
	// o.seed: Find a route's seed (editor.js start(): 1 when none), so two runs of one level can differ (problem 10)
	ED.start({ eelvlB64: o.eelvl.toString('base64'), seconds: Math.ceil(budgetMs / 1000), width: 65536, workers: W, seed: o.seed, source: o.source }, o.gpu || { available: gpuOk });
	let lastKey = '', waitKey = '', waitAt = 0, frDone = false, hist = 0, ended = false, busy = false;
	// the handoff's measures: when the job started, when a route of Find a route last gained it something, and every gain
	// of the job's best ({at: ms, saved, fr: made by a route})
	let jobAt = 0, frAt = 0;
	const gains = [];
	const pending = [];   // Find a route's routes waiting for the job
	const classSeen = new Set();   // (the routes of other classes handed on: signature:run ticks)
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
		S.routes++;
		// (only the first route counts as a best here: it is the job's base; a newer one counts once the job accepts it by
		// its own rule, C.judge: deaths, random-portal chance, and appears in its history)
		const faster = !S.job && !ended ? better(ev.runTicks) : false;
		// (cpuS: the CPU search's CPU seconds when Find a route found it, editor.js cpuAfter: the time to route per
		// core-second on a shared machine, next to t)
		emit(Object.assign({ ev: 'route', runTicks: ev.runTicks, verified: true, strategy: r.strategy, best: faster }, r.cpuAfter > 0 ? { cpuS: r.cpuAfter } : {},
			r.foundAfter > 0 ? { foundAfter: r.foundAfter } : {}, r.cleaned ? { cleanedFrom: r.cleaned.fromRunTicks, presses: r.cleaned.presses, cleanS: r.cleaned.sec } : {}));
		if (out) C.writeEetas(path.join(out, `route_${S.routes}_${ev.runTicks}.eetas`), ev.ms);
		if (!S.job) {
			let meta;
			try {
				meta = J.importJob({ eelvl: o.eelvl, eetas: Buffer.from(C.eetasBytes(ev.ms)), name: o.name || 'AutoTAS', eelvlName: `${o.name || 'level'}.eelvl`, eetasName: 'route.eetas', startMode: 'reset' });
			} catch (e) { finish(`the first route could not be made a job: ${e && e.message || e}`); return; }
			S.job = meta.id;
			S.state = 'optimizing';
			jobAt = frAt = Date.now();
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
			const at = Math.min(Date.now(), +e.t || Date.now()), fr = FR_WHAT.test(String(e.what || ''));
			if (+e.saved > 0) { gains.push({ at, saved: +e.saved, fr }); if (fr) frAt = Math.max(frAt, at); }
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
			let key = '';
			if (r && r.inputs) {
				// (a route being cleaned (editor.js cleanLater) waits for its cleanup, at most CLEAN_WAIT_MS: the job's base
				// is the cleaned route; a route handed on before its cleanup ended goes again once cleaned)
				key = `${r.runTicks}:${r.ticks}:${r.inputs.length}:${r.clean === 'pending' ? 'p' : 'c'}`;
				if (key !== lastKey) {
					if (r.clean === 'pending' && waitKey !== key) { waitKey = key; waitAt = Date.now(); }
					if (r.clean !== 'pending' || Date.now() - waitAt >= CLEAN_WAIT_MS) { lastKey = key; onRoute(r); }
				}
			}
			// routes of another class (editor.js classRoutes: other doors / triggers than the best's, even slower ones): saved
			// next to the timeline and handed to the job (its pieces: a class the optimizer can splice from; a second optimizer
			// lane per class is not built yet)
			if (S.job && typeof ED.classRoutes === 'function') {
				for (const c of ED.classRoutes()) {
					const key = `${c.gates}:${c.runTicks}`;
					if (classSeen.has(key)) continue;
					classSeen.add(key);
					const ms = Uint8Array.from(String(c.inputs), (ch) => (ch.charCodeAt(0) - 48) & 31);
					if (out) { try { C.writeEetas(path.join(out, `class_${c.n}_${c.runTicks}.eetas`), ms); } catch (e) { /* read-only */ } }
					emit({ ev: 'class', runTicks: c.runTicks, gates: c.gates, avoid: c.avoid, foundAfter: c.foundAfter });
					pending.push({ ms, runTicks: c.runTicks, strategy: `another class, avoiding ${c.avoid}` });
				}
			}
			// (Find a route can end with its first route still in the cleanup: it stops as soon as a strategy finds a route,
			// e.g. the relay. The end waits for the cleaned route, and after CLEAN_WAIT_MS the route as found is taken above;
			// before, the same poll saw the route 'pending' and the search ended, and the AutoTASer ended "without a route
			// (found)": the defaults A/B's Desolate Caverns, 4 runs)
			const cleaning = !S.job && !!(r && r.inputs) && r.clean === 'pending' && key !== lastKey;
			if (!frDone && !st.running && !cleaning) {
				frDone = true;
				holdShare(false);
				emit({ ev: 'handoff', why: `Find a route ended (${st.stage})` });
				// (no route: nothing to optimize, so the AutoTASer ends here instead of at the budget)
				if (!S.job && !ended) finish(`Find a route ended without a route (${st.stage}${st.message ? `: ${st.message}` : ''})`);
			}
			if (!frDone) holdShare(true);
			if (!ended) { await feedRoutes(); pollJob(); }
			// the handoff: the routes gain the job less than the optimizer does (handoffWhy)
			if (!frDone && !ended && S.job) { const why = handoffWhy({ now: Date.now(), t0, jobAt, frAt, gains, handoffMin, best: S.best }); if (why) handoff(why); }
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

module.exports = { run, handoffWhy, HANDOFF_MIN_S, HANDOFF_WIN_MAX_S, HANDOFF_MIN_GAIN, FR_WHAT, CLEAN_WAIT_MS };

if (require.main === module) {
	const args = C.parseArgs(process.argv.slice(2));
	const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
	if (!file || !fs.existsSync(file)) { console.log('usage: node src/autotas.js <level.eelvl> [--minutes=30] [--workers=N] [--name=] [--out=<dir>] [--handoffMin=20] [--cpu=1] [--seed=N]\n(its job pauses any other running job, yours included: one job at a time)'); process.exit(2); }
	const name = args.name || path.basename(file, path.extname(file));
	const out = path.resolve(args.out || path.join(__dirname, 'out', 'autotas', name.replace(/[^\w.-]+/g, '_')));
	const ctl = run({ eelvl: fs.readFileSync(file), minutes: args.minutes, workers: args.workers, name, out, handoffMin: args.handoffMin, cpu: args.cpu === '1',
		seed: args.seed != null ? +args.seed : undefined, onEvent: (e) => console.log(JSON.stringify(e)), onEnd: () => setTimeout(() => process.exit(0), 3000) });
	const stop = () => ctl.stop();
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}
