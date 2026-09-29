'use strict';
// src/autotas.js's handoff rule (handoffWhy), pure, no GPU, no jobs:
//   - no job yet: never; the window = the time the first route took, within [handoffMin, HANDOFF_WIN_MAX_S]
//   - due once no route gained the job anything for a window (a faster route that the job's best is already ahead of
//     gains it nothing: only the job's history entries of Find a route's runs count, FR_WHAT)
//   - due when in the last window the optimizer's own stages gained more than the routes; not while the routes gain more
//   - due when in the last window the routes gained the job less than HANDOFF_MIN_GAIN (1%) of its best
// routeGate: the first route waits for its cleanup at most FIRST_CLEAN_WAIT_MS from the first one seen (faster pending routes
// do not restart its clock), later routes at most CLEAN_WAIT_MS each, as before.
// run() against stand-ins for the editor and the jobs (a few seconds): Find a route ending while its route is still in
// the cleanup waits for the cleaned route (the first route at most FIRST_CLEAN_WAIT_MS, then the route as found); no
// route: it ends at once.
// usage: node test/autotas.js        Exit code 1 if any check fails.
const AT = require('../src/autotas.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const s = 1000;
const why = (o) => AT.handoffWhy(Object.assign({ t0: 0, handoffMin: 20, gains: [] }, o));

console.log('handoffWhy');
check('no job: never', why({ now: 500 * s, jobAt: 0, frAt: 0 }) === '');
// the first route after 30 s: a window of 30 s
check('a new job within its window: not yet', why({ now: 55 * s, jobAt: 30 * s, frAt: 30 * s }) === '');
const w1 = why({ now: 61 * s, jobAt: 30 * s, frAt: 30 * s });
check('no route gained the job anything for the window (30 s): due', /no route gained the job anything for 31 s/.test(w1), w1);
// the window is at least handoffMin and at most HANDOFF_WIN_MAX_S
check('a first route after 5 s: the window is handoffMin (20 s)', why({ now: 24 * s, jobAt: 5 * s, frAt: 5 * s }) === '' && why({ now: 26 * s, jobAt: 5 * s, frAt: 5 * s }) !== '');
const lateJob = 900 * s;
check(`a first route after 900 s: the window is ${AT.HANDOFF_WIN_MAX_S} s`, why({ now: lateJob + (AT.HANDOFF_WIN_MAX_S - 1) * s, jobAt: lateJob, frAt: lateJob }) === '' &&
	why({ now: lateJob + (AT.HANDOFF_WIN_MAX_S + 1) * s, jobAt: lateJob, frAt: lateJob }) !== '');
// the routes keep gaining the job more than the optimizer: Find a route keeps the GPU
const g1 = [{ at: 40 * s, saved: 30, fr: false }, { at: 55 * s, saved: 200, fr: true }];
check('the routes gained more in the window: not yet', why({ now: 70 * s, jobAt: 30 * s, frAt: 55 * s, gains: g1 }) === '');
// the optimizer gained more in the last window
const g2 = [{ at: 45 * s, saved: 150, fr: false }, { at: 55 * s, saved: 20, fr: true }, { at: 60 * s, saved: 90, fr: false }];
const w2 = why({ now: 70 * s, jobAt: 30 * s, frAt: 55 * s, gains: g2 });
check('the optimizer gained more in the last window: due', /the optimizer gained 240 ticks, the routes 20/.test(w2), w2);
// a trickle of route gains under HANDOFF_MIN_GAIN (1%) of the job's best in the last window: due; 1% or more: not yet
const g4 = [{ at: 40 * s, saved: 300, fr: true }, { at: 62 * s, saved: 5, fr: true }, { at: 68 * s, saved: 4, fr: true }];
const w4 = why({ now: 70 * s, jobAt: 30 * s, frAt: 68 * s, gains: g4, best: 9000 });
check('the routes gained under 1% of the job\'s best in the last window: due', /the routes gained the job 9 ticks, under 1% of its 9000/.test(w4), w4);
check('the routes gained 1% or more: not yet', why({ now: 70 * s, jobAt: 30 * s, frAt: 68 * s, gains: g4.concat([{ at: 50 * s, saved: 81, fr: true }]), best: 9000 }) === '');
check('the trickle rule waits for a full window after the job', why({ now: 55 * s, jobAt: 30 * s, frAt: 54 * s, gains: [{ at: 54 * s, saved: 1, fr: true }], best: 9000 }) === '');
check('no best given: the trickle rule is off', why({ now: 70 * s, jobAt: 30 * s, frAt: 68 * s, gains: g4 }) === '');
// gains before the window do not count
const g3 = [{ at: 31 * s, saved: 500, fr: false }, { at: 65 * s, saved: 20, fr: true }];
check('gains before the window do not count', why({ now: 70 * s, jobAt: 30 * s, frAt: 65 * s, gains: g3 }) === '');
// the history entries that count as a route's: its inbox run and that run's splice with the best, not the GPU searcher's
check('FR_WHAT: a route\'s inbox run and its splice', AT.FR_WHAT.test('inbox (Find a route (random runs (GPU)))') &&
	AT.FR_WHAT.test('inbox (Find a route (route)) + best (splice, 2 switches)') && AT.FR_WHAT.test('try: Find a route (route)') &&
	!AT.FR_WHAT.test('inbox (gpu m1 3)') && !AT.FR_WHAT.test('sweep1_2') && !AT.FR_WHAT.test('try: focus 0:01.00-0:02.00'));

console.log('routeGate (the route to the job; its cleanup wait)');
{
	const R = (runTicks, clean) => ({ runTicks, ticks: runTicks + 5, inputs: 'x'.repeat(runTicks + 5), clean });
	// a first route whose cleanup is done at once: handed on at once
	let g = { lastKey: '', waitKey: '', waitAt: null };
	check('a cleaned first route: at once', AT.routeGate(g, R(900, 'done'), 0) === true);
	check('the same route again: not twice', AT.routeGate(g, R(900, 'done'), 100) === false);
	// the first route pending, a faster pending route every second (EXCrew: the cleanup of a 20 k-tick route takes 3-6 s)
	g = { lastKey: '', waitKey: '', waitAt: null };
	let at = -1;
	for (let t = 0; t <= 20; t++) if (at < 0 && AT.routeGate(g, R(20000 - 100 * t, 'pending'), t * s)) at = t;
	check('the first route: the clock not restarted by faster pending routes, handed on after FIRST_CLEAN_WAIT_MS', at * s === AT.FIRST_CLEAN_WAIT_MS, `at ${at} s`);
	check('its cleaned version goes again', AT.routeGate(g, R(20000 - 100 * at, 'done'), (at + 3) * s) === true);
	// later routes: the wait per route as before (CLEAN_WAIT_MS, restarted by a newer one)
	let later = -1;
	for (let t = 30; t <= 60; t++) if (later < 0 && AT.routeGate(g, R(15000 - (t < 40 ? 10 * t : 400), 'pending'), t * s)) later = t;
	check('a later route: CLEAN_WAIT_MS from the newest pending route, as before', later * s === 40 * s + AT.CLEAN_WAIT_MS, `at ${later} s`);
	g = { lastKey: '', waitKey: '', waitAt: null };
	check('a first route cleaned before the cap: at once', AT.routeGate(g, R(5000, 'pending'), 0) === false && AT.routeGate(g, R(4900, 'done'), 2 * s) === true);
	check('routeKey: the gate\'s key (the race test\'s "still in the cleanup" reads it)', AT.routeKey(R(900, 'pending')) === '900:905:905:p' && AT.routeKey(R(900, 'done')) === '900:905:905:c');
}

// the stall rotation in the timeline: each escape of Find a route once (its configuration and kind of start), a route
// of an escape names its configuration
console.log('the stall rotation in the timeline');
const seen = new Set();
const e1 = { runs: 2, run: { n: 2, cfg: 'reach' }, last: { n: 1, cfg: 'blind' }, hist: [{ n: 1, cfg: 'blind', kind: 'arrival', from: 'where room "coins=2" was entered', ticks: 260, tiles: 40, after: 61.2 },
	{ n: 2, cfg: 'reach', kind: 'frontier', from: 'the least explored room "coins=1"\'s nearest attempt', ticks: 220, tiles: 50, after: 181.5 }] };
const x1 = AT.escapeEvents(seen, e1), x2 = AT.escapeEvents(seen, e1);
check('escapeEvents: one event per escape, in order, with its configuration and start; none again at the next poll',
	x1.length === 2 && x1[0].ev === 'escape' && x1[0].n === 1 && x1[0].cfg === 'blind' && x1[0].kind === 'arrival' && x1[1].cfg === 'reach' && x1[1].ticks === 220 && x2.length === 0,
	JSON.stringify(x1));
check('escapeEvents: no escape state (escape off, a small level): nothing', AT.escapeEvents(new Set(), null).length === 0 && AT.escapeEvents(new Set(), { runs: 0, run: null }).length === 0);
const rx = AT.routeEscape({ strategy: 'escape: a fresh one search' }, e1), rl = AT.routeEscape({ strategy: 'escape: a fresh one search + path skips' }, { run: null, last: { n: 1, cfg: 'blind' } });
check('routeEscape: an escape\'s route names the live escape (else the last one) and its configuration; another strategy\'s route none',
	!!rx && rx.n === 2 && rx.cfg === 'reach' && !!rl && rl.cfg === 'blind' && AT.routeEscape({ strategy: 'random runs (GPU)' }, e1) === null && AT.routeEscape({ strategy: 'escape: a fresh one search' }, null) === null,
	JSON.stringify([rx, rl]));

// ---- run(): Find a route ending while its route is still in the cleanup (editor.js cleanLater), stand-ins for the editor
// and the jobs (a real 12 x 6 level, every route replayed). The race (the defaults A/B, Desolate Caverns): Find a route
// stopped as soon as a strategy found a route; the same 250-ms poll saw the route 'pending' and the search ended, and the
// AutoTASer ended "without a route (found)", dropping the route the editor kept.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/common.js');
const EL = require('../src/eelvl.js');
const stubs = {};
function stub(rel, exp) {
	const f = require.resolve(`../src/${rel}`);
	const m = new Module(f);
	m.filename = f; m.loaded = true; m.exports = exp;
	require.cache[f] = m;
	stubs[rel] = exp;
}
// the level: a closed room, the trophy 4 tiles right of the spawn; the route: one input held (found by trying each)
const LW = 12, LH = 6, bx = [], by = [];
for (let x = 0; x < LW; x++) { bx.push(x, x); by.push(0, LH - 1); }
for (let y = 1; y < LH - 1; y++) { bx.push(0, LW - 1); by.push(y, y); }
const eelvl = EL.writeEelvl({ width: LW, height: LH, name: 'race', records: [{ id: 9, xs: bx, ys: by }, { id: 255, xs: [2], ys: [4] }, { id: 121, xs: [6], ys: [4] }] });
const level = C.E.prepareLevel(Object.assign(EL.toSimLevel(EL.readEelvl(eelvl)), { start_mode: 'reset' }));
let held = null;
for (let m = 1; m < 32 && !held; m++) { const ev = C.evaluate(level, new Uint8Array(300).fill(m)); if (ev) held = ev; }
const inputsOf = (ms) => C.eetasBytes(ms).toString('latin1');
// the cleaned route (the held input alone) and the raw one (as found: another button pressed with it that changes nothing
// the route needs, still finishing): the job's base tells which one it was made from
let rawEv = null;
for (let b = 1; b < 32 && held && !rawEv; b <<= 1) {
	if (held.ms[0] & b) continue;
	const ev = C.evaluate(level, held.ms.map((m) => m | b));
	if (ev) rawEv = ev;
}
const asRoute = (ev) => ({ inputs: inputsOf(ev.ms), runTicks: ev.runTicks, ticks: ev.ms.length });
const raw = rawEv ? asRoute(rawEv) : null;
const cleaned = held ? asRoute(held) : null;
const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-autotas-test-'));
let imported = [];
stub('jobs.js', {
	jobDir: (id) => path.join(jobsDir, id),
	importJob: (o) => { imported.push(o.eetas.toString('latin1')); fs.mkdirSync(path.join(jobsDir, `j${imported.length}`), { recursive: true }); return { id: `j${imported.length}` }; },
	runningPid: () => 0, loadJobLevel: () => level, tryCandidate: async () => ({ handed: true, best: null }),
});
// the editor: searching for `endAt` ms, then ended ('found') with the raw route 'pending'; the cleaned route (clean 'done')
// `cleanAfter` ms later (Infinity: the cleanup never comes back); `route` false: ended without a route ('stopped')
let ed = null;
stub('editor.js', {
	start: () => { ed.at = Date.now(); },
	stop: () => {},
	state: () => {
		const t = Date.now() - ed.at;
		if (t < ed.endAt) return { running: true, stage: 'searching', result: null };
		if (!ed.route) return { running: false, stage: 'stopped', message: 'The search was stopped before it found a route.', result: null };
		const done = t >= ed.endAt + ed.cleanAfter;
		return { running: false, stage: 'found', result: Object.assign({}, done ? cleaned : raw, { clean: done ? 'done' : 'pending' }) };
	},
});
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
/** one AutoTASer run against the stand-ins; its events; `onPending` once the route is pending (the clock can jump) */
function runRace(o) {
	ed = Object.assign({ at: Date.now(), endAt: 300, route: true, cleanAfter: 700 }, o);
	imported = [];
	return new Promise((resolve) => {
		const evs = [];
		const t0 = realNow();
		let ctl = null, jumped = false;
		const guard = setTimeout(() => ctl && ctl.stop(), 8000);
		const poke = setInterval(() => { if (!jumped && o.jump && realNow() - t0 > ed.endAt + 600) { jumped = true; skew += o.jump; } }, 50);
		ctl = AT.run({ eelvl, minutes: 5, workers: 1, cpu: true, name: 'race', startJob: () => ({ pid: 0 }), stopJob: () => {},
			onEvent: (e) => { evs.push(e); if (e.ev === 'job') setTimeout(() => ctl.stop(), 300); },
			onEnd: () => { clearTimeout(guard); clearInterval(poke); resolve({ evs, ms: realNow() - t0, st: ctl.state(), t0 }); } });
	});
}
(async () => {
	console.log('\nrun(): Find a route ends while its route is in the cleanup (the race)');
	check('the stand-in level has a route, raw and cleaned', !!held && !!rawEv && raw.inputs !== cleaned.inputs, held ? `${held.runTicks} run ticks` : 'none');
	if (held && rawEv) {
		const a = await runRace({});
		const endA = a.evs.find((e) => e.ev === 'end'), jobA = a.evs.find((e) => e.ev === 'job');
		check('the search ended with the route pending: the AutoTASer waits for the cleanup and makes the job from the cleaned route',
			!!jobA && imported.length === 1 && imported[0] === cleaned.inputs && !/without a route/.test(endA && endA.why), `${endA && endA.why}; job ${jobA ? jobA.runTicks : 'none'}, imported ${imported.map((x) => x.length).join(',') || 'nothing'}`);
		const iH = a.evs.findIndex((e) => e.ev === 'handoff'), iJ = a.evs.findIndex((e) => e.ev === 'job');
		check('then the handoff: "Find a route ended (found)", after the job', iJ >= 0 && iH > iJ && /Find a route ended \(found\)/.test(a.evs[iH].why), iH >= 0 ? a.evs[iH].why : 'no handoff');
		// (the editor page's "best route" panel: the AutoTASer's start and the job's bests, its base route first)
		const bs = a.st.bests || [];
		check('the state carries its start (t0, ms) and the job\'s bests {t, runTicks, what}: the base route first ("the first route"), at most BESTS_KEEP',
			typeof a.st.t0 === 'number' && Math.abs(a.st.t0 - a.t0) < 1000 && bs.length === 1 && bs[0].what === 'the first route' && bs[0].runTicks === jobA.runTicks && bs[0].t === jobA.t && AT.BESTS_KEEP === 64,
			JSON.stringify({ t0: a.st.t0 - a.t0, bs }));
		// (the first route's cap is FIRST_CLEAN_WAIT_MS since n3-slow-first-route-hunt: routeGate; later routes CLEAN_WAIT_MS)
		const b = await runRace({ cleanAfter: Infinity, jump: AT.FIRST_CLEAN_WAIT_MS + 1000 });
		const endB = b.evs.find((e) => e.ev === 'end');
		check(`the cleanup never comes back: after FIRST_CLEAN_WAIT_MS (${AT.FIRST_CLEAN_WAIT_MS} ms) the route as found is the job's base`,
			imported.length === 1 && imported[0] === raw.inputs && !/without a route/.test(endB && endB.why), `${endB && endB.why}; imported ${imported.map((x) => x.length).join(',') || 'nothing'}`);
	}
	const c = await runRace({ route: false });
	const endC = c.evs.find((e) => e.ev === 'end');
	check('no route when the search ended: the AutoTASer ends at once, as before', !!endC && /Find a route ended without a route \(stopped: The search was stopped/.test(endC.why) && imported.length === 0 && c.ms < 2000,
		`${endC && endC.why} after ${c.ms} ms`);
	Date.now = realNow;
	try { fs.rmSync(jobsDir, { recursive: true, force: true }); } catch (e) { /* in use */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
