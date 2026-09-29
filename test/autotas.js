'use strict';
// src/autotas.js's handoff rule (handoffWhy), pure, no GPU, no jobs (instant):
//   - no job yet: never; the window = the time the first route took, within [handoffMin, HANDOFF_WIN_MAX_S]
//   - due once no route gained the job anything for a window (a faster route that the job's best is already ahead of
//     gains it nothing: only the job's history entries of Find a route's runs count, FR_WHAT)
//   - due when in the last window the optimizer's own stages gained more than the routes; not while the routes gain more
//   - due when in the last window the routes gained the job less than HANDOFF_MIN_GAIN (1%) of its best
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
