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

// the lane after the handoff (laneEndWhy, laneThreadsOf): a fifth of the workers, at least 1; it ends when Find a route
// ends, or LANE_IDLE_S after its last route that gained the job anything (or the handoff)
console.log('the lane after the handoff');
check('the lane\'s threads: a fifth of the workers, at least 1', AT.laneThreadsOf(1) === 1 && AT.laneThreadsOf(5) === 1 && AT.laneThreadsOf(14) === 3 && AT.laneThreadsOf(20) === 4);
const lw = (o) => AT.laneEndWhy(Object.assign({ running: true, stage: 'found' }, o));
check('the lane goes on within LANE_IDLE_S of the handoff', lw({ now: 100 * s + (AT.LANE_IDLE_S - 1) * s, laneAt: 100 * s, frAt: 50 * s }) === '');
const e1 = lw({ now: 100 * s + (AT.LANE_IDLE_S + 1) * s, laneAt: 100 * s, frAt: 50 * s });
check('the lane ends LANE_IDLE_S after the handoff without a route gain', new RegExp(`no route gained the job anything for ${AT.LANE_IDLE_S + 1} s`).test(e1), e1);
check('a route gain after the handoff starts the wait over', lw({ now: 100 * s + (AT.LANE_IDLE_S + 1) * s, laneAt: 100 * s, frAt: 400 * s }) === '');
const e2 = lw({ now: 101 * s, laneAt: 100 * s, frAt: 0, running: false, stage: 'not found' });
check('the lane ends with Find a route', e2 === 'Find a route ended (not found)', e2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
