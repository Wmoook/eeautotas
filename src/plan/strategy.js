'use strict';
// THE COMPILER'S DRIVER (n4plan, part 'strategy'; contract v2 "THE COMPILER" in src/plan/types.js):
//   .eelvl -> parse -> MODEL -> BOUNDS -> PLAN -> MOVES -> VERIFY -> POLISH -> .eetas + a report (run ticks, the
//   admissible lower bound, the gap, per leg: ticks / bound / proven / tool, the best known TAS of the level).
// No search here and no GPU: the parts plan (planner), derive moves from the physics (executor, primitives) and bound
// (bounds); this file runs UNDERSTAND -> PLAN -> EXECUTE -> REFINE (CEGAR) on them and never calls goexplore.js' search,
// bursts.js, heat.js or an eegpu tool (goexplore.js roomOf, a pure function, keys the arrivals' rooms: the contract's RM).
//
//   model   = await compileModel(L, {file})           the level model (src/plan/model.js)
//   bounds  = createBounds(L, {model})                admissible tick bounds (src/plan/bounds.js; optional)
//   facts   = createFacts({rungs: 4, model})          what the loop learnt (CEGAR)
//   planner = createPlanner(model, facts, {bounds})
//   prims   = await createPrims(L, {...})             exact motion primitives (optional)
//   exec    = await createExecutor(L, {...})          reach(starts, waypoint, budget), polish(masks, o)
//   anchors = {start}: REAL states (arrivals replayed by the engine here), one per model state (S.key), up to 4 diverse
//   loop:   pick an anchor (the most progress, then the lowest plan cost + its arrival tick) -> plans = planner.plan(anchor)
//           -> the first step of the best plan not in flight -> exec.reach(anchor's arrivals, step.waypoint, budget(rung))
//           -> planner.learn(step, result, anchor) -> every verified arrival with a new model state is a new anchor
//   receding horizon: only a plan's first step runs; the planner plans again from the real arrival.
//   after a route: branch and bound over the trigger orders (plans whose admissible lb cannot beat the best are not run;
//   arrivals whose run ticks already reach the best are dropped: both proofs), then the polish (exec.polish, else the
//   route cleanup src/cleanroute.js), then the verify (C.evaluate: it finishes, no more deaths).
//
// THE NO-STALL CLOCK: a step's budget is its rung's (RUNG_MS 1.5, 5, 15, 45 s) x 2^deepenings, capped by the time left
// (the polish's reserve kept once a route is known). The planner moves a failed (edge, nodeClass) up a rung (facts), a
// proof blocks it. Here: every executed step must add an anchor or change a fact (else a 'bug' event and the triple
// blocked here); no triple (edge, nodeClass, rung) runs twice in one deepening epoch; everything exhausted -> a global
// deepening (facts.reset keepProofs, budgets x2) or the end 'exhausted'; the watchdog calls a STALL when no anchor was
// added and no fact changed for its window while no step is inside its budget: a 'stall' event with WHY (the last steps,
// their fail reports, the planner's explain()), the first one a deepening, later ones exploration steps (region waypoints
// on each anchor's unvisited walk frontier); with stallS > 0 no progress for stallS s ends 'stalled'.
//
// Every route is C.evaluate'd and every arrival replayed here (T.playTo's rule + the waypoint's goal test, its beforeTick
// too) before it becomes an anchor: a part that returns an arrival that does not replay is a 'bug' event, the arrival
// dropped.
//
// Events (JSON lines through emit, t = s since the start): start, stage {name, ms, text}, model, plan, step, fact, source
// ({inputs, key, tick, room, desc, gain, anchor, label}: a verified arrival with a new model state), import, result
// ({kind 'finish', runTicks, ticks, inputs, lb, gap, how}), progress ({detail: the page's status line, e.g. "plan: step
// 5/12 'purple switch 3' rung 1 · 7 anchors · route 6,234 (lb 3,210, gap 48%)"}), stall ({why}), bug, deepen, warning,
// done ({end, runTicks, lb, gap}).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./types.js');
const E = require('../eesim.js');

const RUNG_MS = [1500, 5000, 15000, 45000];
// THE ONE SHOT (n5-oneshot part 3, OPT-IN EEAT_ONESHOT=1; off = the loop below byte for byte): the MOVES stage's first
// tier: src/plan/oneshot/solve.js, ONE A* over (the move graph x the trigger state) from the level start with the
// planner's plans and the bounds as its heuristic, for OS_SHARE of the time left before the loop; then in the loop's
// idle moments OS_SLICE ms at a time while it has open nodes. Its route (the trophy) is a route like any other
// (C.evaluate'd, routeOf); every abstract state it reaches first is an anchor (the executor plans from it); every new
// anchor of the executor's legs goes INTO its graph (inject: the exact fallback's edges). With EEAT_OS_GRAPH=1 and
// src/plan/oneshot/edges.js present, part 2's whole-level graph (buildGraph) adds its edges.
const OS_ON = process.env.EEAT_ONESHOT === '1';
const OS_SHARE = process.env.EEAT_OS_SHARE !== undefined ? +process.env.EEAT_OS_SHARE : 0.3;
const OS_SLICE = process.env.EEAT_OS_SLICE !== undefined ? +process.env.EEAT_OS_SLICE : 100;
// (THE ONE SHOT IN ITS OWN THREAD, the default with EEAT_ONESHOT=1 and a level file: src/plan/oneshot/osworker.js builds
// its own model / bounds / planner from the file and runs the A* from the compile's start to its end, in parallel with the
// executor, which keeps its workers and the main thread all their time (the main-thread mode above ran the A* for OS_SHARE
// of the moves' time before the executor's first step). Its routes and first nodes per abstract state arrive as mask
// strings (routeOf / addArrival here, as the main-thread harvest); the executor's new anchors and every better route go to
// it (inject: a route is its bound: its ladder then searches only for faster ones). EEAT_OS_THREAD=0: the main-thread mode.)
const OS_THREAD = process.env.EEAT_OS_THREAD !== '0';
// (THE ONE SHOT'S OWN PROCESS, the default of the thread mode: osworker.js forked as a child process at nice 19 (Linux),
// its V8 heap --max-old-space-size = EEAT_OS_HEAP_MB + 512: in a worker thread its garbage collection shared the V8
// platform threads of the process with the executor's worker threads and the main thread. EEAT_OS_PROC=0: the worker
// thread. The same messages either way: osProc() gives the child the Worker's face.)
const OS_PROC = process.env.EEAT_OS_PROC !== '0';
// (THE SHARED SESSION, lane 6 push 3 block 3; OPT-IN EEAT_OS_BW_ST=1 with EEAT_OS_BW=1 and the stretch solver (EEAT_STRETCH,
// a compiler default): the one shot's far legs go to the compile's stretch child (one backward solver and its closed
// closures' values a compile, the executor's stretches and the one shot's far legs in turn) instead of a second backward
// solver of 2-3 GB in the one shot's own process; one far leg out at a time; its answer replayed there and again in the
// one shot (an injected node, chased). Off: the far legs in the one shot's process as before)
const OS_BW_ST = process.env.EEAT_OS_BW_ST === '1' && process.env.EEAT_OS_BW === '1';
/** osworker.js as a child process with a Worker's face (on / once 'message' 'error' 'exit', postMessage, unref, terminate) */
function osProc(file, data, heapMB) {
	const cp = require('child_process'), EventEmitter = require('events');
	const env = Object.assign({}, process.env, { EEAT_OS_WORKERDATA: JSON.stringify(data) });
	const child = cp.fork(file, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: heapMB > 0 ? [`--max-old-space-size=${Math.round(heapMB + 512)}`] : [] });
	const ee = new EventEmitter();
	let err = '';
	if (child.stderr) child.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
	child.on('message', (m) => ee.emit('message', m));
	child.on('error', (e) => ee.emit('error', e));
	child.on('exit', (code, sig) => { if (code && err) ee.emit('error', new Error(`exit ${code}: ${err.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''}`)); ee.emit('exit', code == null ? sig : code); });
	return {
		pid: child.pid,
		on: (ev, fn) => { ee.on(ev, fn); },
		once: (ev, fn) => { if (ev === 'exit' && child.exitCode !== null) { fn(child.exitCode); return; } ee.once(ev, fn); },
		postMessage: (m) => { if (child.connected) child.send(m); },
		unref: () => { try { child.unref(); if (child.channel) child.channel.unref(); if (child.stderr) child.stderr.unref(); } catch (e) { /* ended */ } },
		terminate: () => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (e) { /* gone */ } return Promise.resolve(); },
	};
}
const OS_DRAIN_MAX = 64;   // the thread's arrivals replayed here per loop turn at most (the rest wait for the next turn)
// (THE GATE: the thread's arrivals are held until the executor needs them: its first stall (the watchdog's) or its end
// ('exhausted' / nothing left: the loop's hold) with no route; from then on they go to it as they come. Given at once, the
// one shot's first arrivals (the greedy phase's: not the fewest ticks) became the executor's anchors and its routes were
// built on them: the 40-level A/B's first 15, routes slower on 8 of 12 both-compiled levels, 6 of them with the one shot's
// arrival as the first leg. EEAT_OS_GATE=0: at once.)
const OS_GATE = process.env.EEAT_OS_GATE !== '0';
// (EEAT_OS_OPEN=1, OPT-IN: the gate also opens with no route when the executor has made no new anchor for OS_OPEN_F of the
// budget (at least OS_OPEN_MIN_S), or past OS_OPEN_HALF of the budget: the CEGAR's facts keep changing on a level the
// executor cannot pass, so its watchdog's stall never comes there. NEGATIVE as the default: the 300-s A/B's Tutorial 1 (the
// base's first route at 62 s) opened it at 78 s, took 8 anchors of the one shot and ended with no route)
const OS_OPEN = process.env.EEAT_OS_OPEN === '1';
const OS_OPEN_F = 0.2, OS_OPEN_MIN_S = 10, OS_OPEN_HALF = 0.5;
const REPLAN_FIRST = process.env.EEAT_REPLAN_FIRST === '1';
const PROGRESS_MS = 2000, WATCH_MS = 2000, SAVE_MS = 60000;
// the watchdog's window: STALL_F of the budget, at least STALL_MIN_S, at most STALL_S
const STALL_S = 60, STALL_MIN_S = 5, STALL_F = 1 / 6;
// the anchor pick: the most progress (model gain), then the plan's cost + the arrival tick + FAIL_TICKS x its failed
// steps - UCB_C x sqrt(ln N / (1 + picks)) (a little fairness among equals)
const FAIL_TICKS = 200, UCB_C = 100;
// (THE TIMER's anchor pick: planner.js EEAT_PLAN_TIMER=1)
const TIMER_PICK = process.env.EEAT_PLAN_TIMER === '1';
// THE CRUMB RANK (C6 lane 5 block 2; EEAT_CRUMB_RANK, unset = the anchor pick as before, byte for byte): a crumb (a coin
// no gate reads, model.js EEAT_CRUMBS) is a relay of a long leg, not progress, but its arrival counts as gain (model.js
// mkState: the coins taken), so the anchors past a crumb outrank every crumb-free anchor of the same real progress and
// the compile follows the crumb path to the end (Tutorial 2: a blue coin 101 walk steps off its way taken from the level
// start, every later anchor past it; the first route 5,022-6,069 run ticks vs 2,901-3,266 with the crumbs off, the direct
// checkpoint leg found at rung 2). EEAT_CRUMB_RANK=1: once a route is known, the pick's gain leaves the crumbs out (the
// crumb plans already stop there, planner.js); =2: always (the crumbs' own anchors by the score alone). =2 slowed a level
// whose only relevant trigger is the trophy and whose crumbs ARE its way (On And On And On: the deepest crumb (118,64) at
// 272 s vs 169 s, the workers on the lower anchors' 45-s trophy legs; 1 route in 2 runs); =3 THE F GATE: an anchor keeps
// its crumbs' gain while its f (its arrival tick + its plan's cost) is within CR_F_SLACK x (+ CR_F_ABS ticks) of the least
// f among the live anchors of its real gain: a crumb ON the route's way keeps the trail depth first (On And On's crumbs:
// detours of at most 0.114 of a leg, a few % of the route), one off it (Tutorial 2's blue coin (30,10): ~600 ticks on a
// ~1,600-tick estimate) counts nothing.
const CRUMB_RANK = process.env.EEAT_CRUMB_RANK === '1' ? 1 : process.env.EEAT_CRUMB_RANK === '2' ? 2 : process.env.EEAT_CRUMB_RANK === '3' ? 3 : 0;
const CR_F_SLACK = +process.env.EEAT_CR_F_SLACK || 0.1, CR_F_ABS = +process.env.EEAT_CR_F_ABS || 60;
// THE FAR TROPHY (C6 push 3 lane 2 block 2, RATE; OPT-IN EEAT_FAR_TROPHY=<est ticks>, unset / 0: off, the compile byte for
// byte as before): a plan whose first step is the trophy and whose est walk to it is longer than that runs at most at rung
// EEAT_FAR_TROPHY_RUNG (1: a 5-s window) whatever rung its facts reached; its failures still climb the facts' ladder (the
// planner moves on as before), only the window is cut. Why: the chief's 300-s full compile (box 5's 122 levels): 73% of the
// failed steps' worker time went to (anchor, edge) pairs that climbed to the 45-s rung and never resolved; on the RATE
// levels the trophy steps took 25% of the failed time with no success at any rung (the whole level left as one leg)
const FAR_TROPHY = +process.env.EEAT_FAR_TROPHY > 0 ? +process.env.EEAT_FAR_TROPHY : 0;
const FAR_TROPHY_RUNG = process.env.EEAT_FAR_TROPHY_RUNG !== undefined ? +process.env.EEAT_FAR_TROPHY_RUNG : 1;
// THE FAR WALK (C6 push 3 lane 2 block 3, RATE; OPT-IN EEAT_FAR_WALK=<walk ticks>, unset / 0: off, the compile byte for
// byte as before): the far trophy's window cap for EVERY waypoint kind, by the step's WALK: its est, or for an est at or
// past the planner's PENALTY (1e6: an edge only the relaxation reaches, est = 3 x the relaxation's walk x the pace +
// PENALTY; a floor / zone / rch price adds PENALTY too) the rest past the penalties / 3 (the relaxation's own price is
// 3x). A step whose walk is longer runs at most at rung EEAT_FAR_WALK_RUNG (1) whatever rung its facts reached; its
// failures still climb the facts' ladder (the planner moves on as before). A death step (its est the dead ticks, its
// window the respawn's) and a synthetic step keep their rung. Why (lane 2 block 3, the far-trophy arm's step events, the
// 18 RATE levels, 300 s, 4,021 steps with their est): '1e6+' is NOT a whole level: 144 of those steps succeeded (33 at
// the 45-s rung), the rest past the penalty is the relaxation's walk; by the WALK, no step of a plain est >= 3,000 ticks
// succeeded at any rung (0 of ~470) and 1 of 230 of a penalty est with a rest >= 10,000 (an Inferno coin at rung 3).
const FAR_WALK = +process.env.EEAT_FAR_WALK > 0 ? +process.env.EEAT_FAR_WALK : 0;
const FAR_WALK_RUNG = process.env.EEAT_FAR_WALK_RUNG !== undefined ? +process.env.EEAT_FAR_WALK_RUNG : 1;
const EST_PENALTY = 1e6;   // (planner.js PENALTY)
/** a step's walk est: its est, or past the planner's penalties the relaxation's walk (the rest / 3) */
const walkOf = (step) => { const e = +step.estTicks; return !Number.isFinite(e) ? 0 : e >= EST_PENALTY ? (e % EST_PENALTY) / 3 : e; };
const farWalk = (step) => FAR_WALK > 0 && step && !step.synthetic && !String(step.edge).startsWith('death:') && !(step.waypoint && step.waypoint.allowDeath) && walkOf(step) > FAR_WALK;
/** the rung a step's window is sized by: its own, or the far trophy's / the far walk's cap */
const windowRung = (step) => (FAR_TROPHY > 0 && step && !step.synthetic && (!step.waypoint || step.waypoint.kind === 'trophy') && +step.estTicks > FAR_TROPHY ? Math.min(step.rung | 0, FAR_TROPHY_RUNG)
	: farWalk(step) ? Math.min(step.rung | 0, FAR_WALK_RUNG) : step.rung);
const ARRIVALS_K = 4, MAX_DEEPEN = 4, STEER_MISS = 6000;
// the polish's share of the budget once a route is known: min(POLISH_MS, POLISH_F x the budget)
const POLISH_MS = 15000, POLISH_F = 0.25;
// (lane 5, TAS-perfect: time is secondary, the ticks are not) past 60 s the polish's reserve grows by POLISH_LONG_F of the
// budget past 60 s (at most POLISH_F of it): 60 s 15 s (as before), 300 s 63 s, 900 s 183 s; then THE REST polishes again
// (REST_ROUNDS rounds while they gain, each at least REST_MIN_MS, all in REST_F of the time left; the proof gets what they
// leave). EEAT_POLISH_REST=0: as before (15 s, the proof to the end).
const POLISH_REST = process.env.EEAT_POLISH_REST !== '0';
const POLISH_LONG_F = 0.2, REST_F = 0.5, REST_ROUNDS = 8, REST_MIN_MS = 1500;
// the proof's share once a route is known (a static level start only): min(PROVE_MS, PROVE_F x the budget) kept for the
// PROVE stage (one exact search from the level start bounded by the route's own arrival), and all the time the moves leave
const PROVE_MS = 30000, PROVE_F = 0.2;
// THE PERFECT PASS (n5-perfect, src/plan/perfect.js; DEFAULT ON since the C6 merge into n5-plan (the 300-s A/B on the merged
// head: CLAUDE.md section 11, PERFECT IN n5-plan); EEAT_PERFECT=0: off, and with it every n5-perfect compile-time knob (the
// precision fast rests, the loop cuts, the LOOPS stage: EEAT_JOINS=0 turns the joins off); EEAT_PERFECT_PASS=0: only this
// pass and its reserve off): once a route is known, min(PERFECT_MS, PERFECT_F x the budget) is kept for it (like the
// polish's reserve): branch and bound over the planner's trigger orders from the route's own states with the route as the
// incumbent, then the polish with the route's joins (its model-state changes and its legs' starts) as its window marks
const PERFECT = process.env.EEAT_PERFECT !== '0' && process.env.EEAT_PERFECT_PASS !== '0';
const PERFECT_MS = +process.env.EEAT_PERFECT_MS || 20000, PERFECT_F = 0.25;
// (with it, the PROVE stage only for a route the exact search from the start can bound: at most PROVE_MAX_TICKS run
// ticks (its reach in the final compile: ~70 layers in 10 s on NC Naos; no route of the 24 compiled was proven by it, and
// it took 10-30 s from the polish on Tree Decorating (polish 0.25 s, prove 10.5 s), Gingerbread House (27.7 s), Endless
// Space (30 s)); a longer route's prove reserve goes to the polish, whose time is the route's best return once it exists
// (the pass offline, 16 s of polish at the joins on the final compile's routes: The Blank Page 3,190 -> 2,466, Trick Or
// Treat 5,035 -> 4,424, whose compiles had 0.2 / 5.7 s of polish); the perfect stage's own share of its reserve for the
// polish: PERFECT_POLISH, 0.75: on the 24 routes the order pass's 29 s gave 195 ticks in all and the polish's 16 s 2,255
// (0.28 vs 5.9 ticks a second); Tutorial 1 with the whole 45 s on the polish 2,441 -> 2,267, with 29 + 16 s 2,374)
const PROVE_MAX_TICKS = +process.env.EEAT_PROVE_MAX || 300, PERFECT_POLISH = +process.env.EEAT_PERFECT_POLISH || 0.75;
// the exact landing (precision.js): a trophy leg's nearest state within PREC_NEAR tiles (the goal field's), at most
// PREC_RUNS runs a compile of at most PREC_S s (at least PREC_MIN_S left), its PREC_ATTEMPTS nearest attempts
const PREC_NEAR = 8, PREC_RUNS = 3, PREC_S = 40, PREC_MIN_S = 6, PREC_ATTEMPTS = 8;
// (lane 5, TAS-perfect) the child's landings: the FASTEST of them, not the first (precision.js without --first: after its
// first route its lookups go on PREC_AFTER_S s for faster ones and it ends when its tables are searched). Measured (box 5,
// precision.js alone from the compiled route's approach): NC Naos d3c6 routes 358, 319, ... in 9 s (the first 358, the
// fastest 319), the precision puzzle 358, 335, 333 (the first 358): the compiles took 319 or 358 by which hit came first.
// EEAT_PREC_FIRST=1: the first, as before.
const PREC_FIRST = process.env.EEAT_PREC_FIRST === '1', PREC_AFTER_S = 10;
// n5-perfect (versus the best known): the exact landing's rests braked from the attempts' moving states (precision.js FAST
// RESTS) instead of coasted to rest; the precision puzzle 358 -> 153 run ticks from the same attempt (the known TAS 111)
// (with the fast rests the coasted pass stops at its first route (--first=1, as measured): the fast pass is the one that
// looks for the fastest, and precision.js's --after clock (from that first route) would cut it short)
const PREC_FAST = process.env.EEAT_PREC_FAST !== '0' && process.env.EEAT_PERFECT !== '0';
// (B8 speed, cycle 2) THE EXACT LANDING WITHOUT THE IDLE WAIT (OPT-IN EEAT_PREC_ASYNC=1; off = the step awaits the child,
// byte for byte as before): the trophy step that started the precision child returned only when the child ended (up to
// PREC_S = 40 s), and that step's edge stayed in flight, so on a one-trigger level the whole loop waited: the precision
// puzzle and NC Naos d3c6 (box 8, n5-plan 8a5d9a6, 300 s, W3) spent 68 / 73 s of their 91 / 96 s first route in that wait
// (the executor's worker use 0.07); the child's first run, from rung 0's one nearest state, ran out its 40 s, then rungs 1-2
// ran (20 s), then the second run with their nearest states found the 154-tick route in 24 s. With the knob the child runs
// in the background (its route goes through routeOf like the stretch child's), the step returns at once, the next rungs
// run beside it, and a run that ends without a route starts again AT ONCE with the nearest states that came meanwhile
// (still at most PREC_RUNS runs); the moves' end with no route waits for a running child (precHold) as for the stretch
// child; the child is killed when the moves end, and a route it prints after that is not taken.
const PREC_ASYNC = process.env.EEAT_PREC_ASYNC === '1';
// (B8 speed, cycle 2) THE EXACT LANDING'S ROUTES AS THEY COME (EEAT_PREC_STREAM=1: a compiler default, src/plan/defaults.js;
// unset here / =0: off, byte for byte): the child
// prints every faster route it finds (precision.js with the fast rests: the coasted rests' route first, then the braked
// rests' faster one), but the compile took its route only when the child ENDED; with the knob each better route is verified
// (routeOf) the moment it is printed, so the first route comes at the coasted pass's find; the child, its later faster
// routes and the step that waits for it are as before.
const PREC_STREAM = process.env.EEAT_PREC_STREAM === '1';
// the proof's starts: the level start after k = 0..R idle ticks, R = the idle ticks until the state rests (the timer starts
// at the first input: waiting is free); at most PROVE_IDLE_MAX (one exact search each)
const PROVE_IDLE_MAX = 64;
// the proof's rounds: a faster route found by its searches becomes the best and the proof starts over with its cost
const PROVE_ROUNDS = 12;
// (lane 5, TAS-perfect) a route of more than PROVE_SHORT ticks after its first input: the proof at most PROVE_LONG_MS (then
// THE LAST polishes); EEAT_POLISH_LAST=0: the proof takes all the time left, as before
const PROVE_SHORT = 600, PROVE_LONG_MS = 3000;
// (lane 5) a route of at most PROVE_TINY run ticks: the moves stop PROVE_TINY_F of the budget before its end (the proof's)
const PROVE_TINY = 100, PROVE_TINY_F = 0.5, PROVE_TINY_ON = process.env.EEAT_PROVE_TINY !== '0';
const PROVE_KEEP = process.env.EEAT_PROVE_KEEP !== '0';
// exploration steps (the second stall on): frontier tiles within FRONTIER_STEPS walk steps of an anchor, at most FRONTIER_MAX
const FRONTIER_STEPS = 60, FRONTIER_MAX = 400;
// the fallbacks when the planner has nothing left (fallbackJob): at most this many without a new anchor
const FALLBACK_MAX = 6;
const ANCHOR_QUAL = process.env.EEAT_ANCHOR_QUAL !== '0';   // (re-entry by another trigger: an anchor of its own, addArrival)
// THE RUNG BREADTH (doctor 5, n5; OPT-IN EEAT_RUNG_BREADTH=1, off = the job pick as before): an anchor's plans are run in
// the order of their first step's RUNG, then the planner's order (iterative deepening over the offered first legs), not in
// the planner's cost order alone. The planner re-offers a failed first leg at its next rung with the same cost, so the
// cost order ran the cheapest plans' first legs depth first (1.5 -> 5 -> 15 -> 45 s windows) while the plans behind them,
// untried, waited for the whole budget: box 5, 60 s, --workers 2 (src/out/n5/doctor/batch5.md): Unforgiving Climb spent
// all 60 s on 'trophy' and 'green key (165,16)' (rungs 0-3, closest 53-167 tiles; the third plan 'blue coin (172,47)'
// got its rung 0 at 59.9 s), The way of the north 39 s of worker time on 'trophy' / 'coin (367,7)' (closest 266-381 tiles)
// before its third-plan route's first coin (6,29), found at rung 0 in 1.1 s, Stupid Fox 39 s on 'trophy' / 'coin
// (128,114)' (closest 429-561 tiles). The planner's near plans (nearPlans) fire only once EVERY plan's first leg has
// failed a rung, which the untried third plan blocked. Ordering only: the same plans, the same rungs and budgets.
const RUNG_BREADTH = () => process.env.EEAT_RUNG_BREADTH === '1';
/** the plans in their first step's rung order (stable: the planner's order among equal rungs) */
function breadthOrder(plans) {
	if (!RUNG_BREADTH() || plans.length < 2) return plans;
	const r0 = (p) => (p.steps && p.steps[0] ? p.steps[0].rung | 0 : 0);
	return plans.map((p, i) => ({ p, i, r: r0(p) })).sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((x) => x.p);
}
// (the arrivals' replay: a death in the leg's start prefix is a move of the route, not the leg's (deaths are moves: the
// acceptance rule takes them); before, every arrival after a die step (or any death) was dropped by its own replay:
// 'the goal test never holds' / 'a trophy arrival that does not finish'. EEAT_PREFIX_DEATH=0: as before)
const PREFIX_DEATH = process.env.EEAT_PREFIX_DEATH !== '0';
// the arrivals' own bounds for the branch and bound (the planner's lowerBound from one arrival: a short search); the start's
// bound gets LB_MS; a lowerBound call that took LB_SLOW_MS or more is not made again that compile (a synchronous part that
// overruns its budget cannot be cut: Moving Ice Puzzle's took 90 s with 1.5 s asked)
const ARR_LB_MS = 25, ARR_LB_EXPAND = 20000, LB_MS = 1500, LB_SLOW_MS = 5000;
// (the start's bound in the bounds stage gets LB0_MS: it only reports (the report's lb, the polish's stop) until the end,
// where the refresh takes the whole LB_MS again and keeps the larger; the stage's clock goes to the moves instead)
const LB0_MS = +process.env.EEAT_LB0_MS || 500;
// THE WHOLE LEVEL AS ONE LEG (the lab's backward solver, src/plan/lab/bwlevel_child.js, a child process next to the moves
// stage; OPT-IN EEAT_BW_LEVEL=1, off = the compile byte for byte): the level's start -> the trophy in one solve, at most
// BW_LEVEL_F of the budget and BW_LEVEL_MAX_S; its route is a route like the moves' (routeOf), the moves go on
// EEAT_BW_LEVEL=last (the chains-lab judge, 2026-09-30): the child's route is a LAST RESORT, taken only when the moves stage
// ends with no route of its own (a level the compile would fail); where the moves have a route the compile is theirs, byte
// for byte (the child's earlier route, taken at once with =1, became the refinement's seed in place of the executor's: Rosa
// dei Venti 3,602 / 3,698 vs 3,546 / 3,550 in two pairs)
const BW_LEVEL_MODE = process.env.EEAT_BW_LEVEL === 'last' ? 'last' : process.env.EEAT_BW_LEVEL === '1' ? 'now' : '';
const BW_LEVEL = !!BW_LEVEL_MODE, BW_LEVEL_F = +process.env.EEAT_BW_LEVEL_F || 0.5, BW_LEVEL_MAX_S = +process.env.EEAT_BW_LEVEL_MAX_S || 150;
// (=last: the whole level alone, no legs, no arrivals: BW_LEGS / BW_GATE below act with =1 only; EEAT_BW_CHAIN=1 its own)
// (THE WHOLE LEVEL AS LEGS, with BW_LEVEL: a trophy behind a gate gets the first plan's waypoints; each leg's new model state
// comes back as an imported anchor; EEAT_BW_LEGS=0: the trophy alone, as before)
const BW_LEGS = process.env.EEAT_BW_LEGS !== '0';
// (THE CUTS, with BW_LEVEL, OPT-IN EEAT_BW_CUTS=1: a trophy leg the first clock did not solve is cut at the start walk's
// narrowest exact cuts, bwlevel_child.js cutChain)
const BW_CUTS = process.env.EEAT_BW_CUTS === '1';
// THE LEVEL AS A CHAIN OF BACKWARD LEGS (n5-s99-gated, src/plan/lab/bwchain_child.js; OPT-IN EEAT_BW_CHAIN=1, off = the compile
// byte for byte): the whole-level stage's child for every level: a one-leg level gets the whole-level solve first, a GATED level
// (the trophy behind doors a trigger opens) the chain at once (a best-first search over trigger orders, one continuous backward
// leg a trigger, the end states carried exactly: bwchain.js); every chain node goes to the loop as an import (an anchor the
// executor goes on from); at most BWC_F of the budget and BWC_MAX_S (the child is one thread next to the workers)
const BW_CHAIN = process.env.EEAT_BW_CHAIN === '1', BWC_F = +process.env.EEAT_BWC_F || 0.98, BWC_MAX_S = +process.env.EEAT_BWC_MAX_S || 900;
const BWC_IMPORT = process.env.EEAT_BWC_IMPORT !== '0';
// (THE GATE, as the one shot's: the chain's anchors are held until the executor needs them: a stall of the watchdog or the
// loop's end with no route; EEAT_BWC_GATE=0: at once)
const BWC_GATE = process.env.EEAT_BWC_GATE !== '0';   // (the child reads it too: 1 the chain's frontier only (the default), 2 every node)
// (THE GATE, with BW_LEVEL: the one shot's gate for the child's legs: their arrivals (a leg's new model state) are held until
// the executor needs them, its watchdog's first stall or the loop's end with no route, then they go to it as they come; its
// routes are taken at once. Given at once, the imported anchors outranked the executor's own (Ruins, local 100 s: 1,510 vs
// 1,302 run ticks). EEAT_BW_GATE=0: at once, as before)
const BW_GATE = process.env.EEAT_BW_GATE !== '0';
// THE STRETCH SOLVER IN ITS OWN PROCESS (n5-s99-budget; OPT-IN EEAT_STRETCH=1, off = the compile byte for byte): the
// executor's rung windows (RUNG_MS 1.5 / 5 / 15 / 45 s) restart every solver of a stretch (an anchor's leg to its plan's
// next waypoint) at every rung; the backward solve of a long leg needs 30-40 s in ONE piece. One child process a compile
// (src/plan/lab/stretch_child.js, the lab's backward solver; its closed closures' values kept across requests) gets ONE
// stretch at a time on ONE continuous clock (ST_MS), next to the executor (whose rungs go on): (1) at the moves' start, a
// SHORT first plan (at most ST_SHORT steps: the ONE-LEG levels) from the level start, its steps in order on one clock
// (ST_SHORT_F of the budget, at most ST_SHORT_MAX_S; each leg's arrival an anchor as it comes, the trophy's a route);
// (2) then, before the first route, the stretch the executor failed at rung ST_RUNG or above from the anchor of the most
// progress (a trigger or the trophy, no deadline, no death step), from its anchor's earliest arrival; a stretch whose
// clock ran out once again on twice the clock when nothing else waits. Its arrivals are verified here like the
// executor's (verified: the engine's replay from the level start and the waypoint's goal test).
const ST_ON = process.env.EEAT_STRETCH === '1';
const ST_MS = +process.env.EEAT_ST_MS || 40000, ST_RUNG = process.env.EEAT_ST_RUNG !== undefined ? +process.env.EEAT_ST_RUNG : 1;
const ST_SHORT = process.env.EEAT_ST_SHORT !== undefined ? +process.env.EEAT_ST_SHORT : 3, ST_SHORT_F = +process.env.EEAT_ST_SHORT_F || 0.9, ST_SHORT_MAX_S = +process.env.EEAT_ST_SHORT_MAX_S || 270;
const ST_MIN_MS = 3000, ST_TRIES = 2;
// (a stretch the child did not finish hands back its node of the least time to go (the backward model's), replayed here:
// the relay start of that stretch's next executor rung when it has none (the executor's own closest replaces it at its
// next rung, as a relay does); EEAT_ST_RELAY=0: off)
const ST_RELAY = process.env.EEAT_ST_RELAY !== '0', ST_CHAIN = process.env.EEAT_ST_CHAIN !== '0', ST_STALE_MS = 5000;
// (EEAT_ST_N: the children a compile, each with a request of its own (default 1, at most 4))
const ST_N = Math.max(1, Math.min(4, +process.env.EEAT_ST_N || 1));
// (THE SHORT REQUEST'S SECOND CHILD, B8 speed cycle 4; OPT-IN EEAT_ST_N=short, off (unset or a number) = the compile byte
// for byte: one child at the start as ST_N 1, and a second one only once the first takes the short first plan's request
// (the whole level from the start, up to ST_SHORT_MAX_S on one clock): it takes the executor's failed stretches from then
// on, which the first child never got before a first route on the one-leg levels the executor routes; a level whose first
// plan is long keeps one child)
const ST_SHORT2 = process.env.EEAT_ST_N === 'short';
// (EEAT_ST_GENERAL=0: the short first plan's request alone, no failed stretches after it)
const ST_GENERAL = process.env.EEAT_ST_GENERAL !== '0';
const ST_NICE = process.env.EEAT_ST_NICE !== undefined && process.env.EEAT_ST_NICE !== '' ? +process.env.EEAT_ST_NICE : 10;
/** a relative deadline (a step's or a waypoint's beforeTickFrom): a number, or 'prev+N' (N ticks after the previous
 *  step's arrival, i.e. this anchor's arrival: a key's KEY_TICKS) -> ticks | NaN */
function relOf(x) {
	if (typeof x === 'number') return x;
	const m = /^\s*(?:prev\s*\+\s*)?(\d+)\s*$/.exec(String(x === undefined || x === null ? '' : x));
	return m ? +m[1] : NaN;
}

const MOD = { compileModel: './model.js', createFacts: './facts.js', createPlanner: './planner.js', createExecutor: './executor.js' };
/** the parts: opts.parts (an object, or a module path: tests inject mocks), else src/plan/*.js (lazy); the bounds and the
 *  primitives are optional (null: a 'warning' event, never a crash) */
function partsOf(opts, say) {
	let given = opts.parts || {};
	if (typeof given === 'string') given = require(path.resolve(given));
	const P = Object.assign({}, given);
	for (const [name, file] of Object.entries(MOD)) {
		if (typeof P[name] === 'function') continue;
		let m;
		try { m = require(file); } catch (e) {
			if (e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(`'${file}'`)) throw new Error(`the compiler's part ${path.basename(file)} is not built yet (src/plan/${path.basename(file)} missing)`);
			throw e;
		}
		if (typeof m[name] !== 'function') throw new Error(`src/plan/${path.basename(file)} has no ${name}()`);
		P[name] = m[name];
	}
	const optional = (name, file, what) => {
		if (typeof P[name] === 'function' || P[name] === null) return;
		try { const m = require(file); P[name] = typeof m[name] === 'function' ? m[name] : null; if (!P[name]) say({ ev: 'warning', text: `${what}: ${path.basename(file)} has no ${name}()` }); } catch (e) {
			P[name] = null;
			const missing = e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(`'${file}'`);
			say({ ev: 'warning', text: `${what} (${missing ? `src/plan/${path.basename(file)} missing` : e.message}): the compiler without them` });
		}
	};
	optional('createBounds', './bounds.js', 'no admissible bounds');
	optional('createPrims', './prims.js', 'no motion primitives');
	return P;
}

const factsVer = (facts) => (facts ? (typeof facts.version === 'function' ? facts.version() : +facts.version || 0) : 0);
const edgeKey = (step) => `${step.edge}|${step.nodeClass === undefined ? '' : step.nodeClass}`;
const labelOf = (step) => (step && step.waypoint && step.waypoint.label) || (step && String(step.edge)) || '?';
const cnt = (x) => (x == null ? undefined : Array.isArray(x) ? x.length : x instanceof Map || x instanceof Set ? x.size : typeof x === 'number' ? x : typeof x === 'object' ? Object.keys(x).length : undefined);
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n));
const fmt = (t) => require('../common.js').fmt(t);
/** a plan() answer as {plans, why}: an array (maybe with .why) or {plans, why} */
function plansOf(r) {
	if (Array.isArray(r)) return { plans: r.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || (r.length ? '' : 'exhausted') };
	if (r && Array.isArray(r.plans)) return { plans: r.plans.filter((p) => p && Array.isArray(p.steps) && p.steps.length), why: r.why || '' };
	return { plans: [], why: (r && r.why) || 'exhausted' };
}
/** a lowerBound() answer's ticks (admissible; Infinity: no way in the planner's relaxation, a proof there), else 0 */
const lbTicks = (r) => {
	const v = r && typeof r === 'object' ? +r.ticks : +r;
	return v === Infinity ? Infinity : Number.isFinite(v) && v > 0 ? v : 0;
};
/**
 * idleRunLB(L, bounds, goal) -> run ticks: an admissible bound on a route's RUN ticks from the level start by the bounds'
 * leg() (ticks from a state to the goal): the timer starts at the end of the first tick with an input, and before it the
 * ball follows its idle trajectory for free, so a route whose first input is at tick i finishes at least leg(idle_i) - 1
 * run ticks after its timer's start: the least of those over the idle trajectory (until the ball rests: its state no
 * longer changes); 0 when it has not come to rest within IDLE_MAX ticks (no claim)
 */
const IDLE_MAX = 3000;
function idleRunLB(L, bounds, goal) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	// (first the idle trajectory alone: a ball that does not rest within IDLE_MAX ticks gets 0 (no claim) either way, so its
	// IDLE_MAX + 1 bounds.leg calls (1.2-3.7 s on 8 of the 15 STAGE-TIME levels: a clock in the state never repeats) are
	// not made)
	{
		sim.reset(); E.applyMask(inp, 0);
		let h = sim.stateHash(), rests = false;
		for (let i = 0; i <= IDLE_MAX && !rests; i++) {
			if (sim.has_silver_crown) return 0;
			sim.tick(inp);
			const h2 = sim.stateHash();
			if (h2 === h && !sim.is_dead) rests = true;
			h = h2;
		}
		if (!rests) return 0;
	}
	sim.reset();
	E.applyMask(inp, 0);
	let lb = Infinity, h = sim.stateHash();
	for (let i = 0; i <= IDLE_MAX; i++) {
		if (sim.has_silver_crown) return 0;
		const v = lbTicks(bounds.leg(sim, goal));
		lb = Math.min(lb, v === Infinity ? Infinity : v - 1);
		if (lb <= 0) return 0;
		sim.tick(inp);
		const h2 = sim.stateHash();
		if (h2 === h && !sim.is_dead) return Number.isFinite(lb) ? Math.max(0, lb) : 0;
		h = h2;
	}
	return 0;
}
/** the md5 of a file (null: none) */
function md5Of(file) { try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; } }

// ---------------------------------------------------------------- the best known TAS of a level (src/plan/truthset.js)
let KNOWN = null;   // {root, byMd5: Map(md5 -> [entry])}
/** knownOf(file, o) -> {runTicks, source, name} | null: the fastest known route (the user's jobs, the benchmark runs) of the
 *  level whose file has the same bytes (md5), each replayed (truthset.loadTruth: a stale one does not count) */
function knownOf(file, o = {}) {
	const md5 = o.md5 || (file ? md5Of(file) : null);
	if (!md5) return null;
	const TS = require('./truthset.js');
	const root = o.root || process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..');
	if (!KNOWN || KNOWN.root !== root) {
		const byMd5 = new Map(), fileMd5 = new Map();
		let list = [];
		try { list = TS.knownRoutes({ root }); } catch (e) { list = []; }
		for (const e of list) {
			let m = fileMd5.get(e.levelFile);
			if (m === undefined) { m = md5Of(e.levelFile); fileMd5.set(e.levelFile, m); }
			if (!m) continue;
			if (!byMd5.has(m)) byMd5.set(m, []);
			byMd5.get(m).push(e);
		}
		KNOWN = { root, byMd5 };
	}
	let best = null;
	for (const e of KNOWN.byMd5.get(md5) || []) {
		let t = null;
		try { t = TS.loadTruth(e); } catch (err) { t = null; }
		if (t && (!best || t.runTicks < best.runTicks)) best = { runTicks: t.runTicks, source: e.source === 'job' ? `job '${e.name}'` : `benchmark run ${path.relative(root, e.route).replace(/\\/g, '/')}`, name: e.name };
	}
	return best;
}

/**
 * compile(L, opts, emit) -> Promise<CompileResult {ok, masks, runTicks, ticks, deaths, lb, gap, legs: [{label, fromTick,
 * ticks, lb, proven, tool}], stages: {parse, model, bounds, plan, moves, verify, polish} (ms), known: {runTicks, source} |
 * null, why, end, route, anchors, steps, okSteps, bugs, deepenings, stalls}>
 * opts: {file, seconds (60), workers (2), inflight (workers: steps in flight), seed (1), first (stop at the first route),
 * polish (true), stallS (0: none), out (a dir: facts.json, anchors.json, events.jsonl, route.eetas), parts (mocks: an
 * object or a module path), stdinLines (an async iterable of lines: depth / stop / route / import / steer), stopOnStdinEnd,
 * depth (ticks: only routes of at most this many ticks), bound (run ticks: a known route's, the B&B's bound), known (an
 * object, false: none; default: looked up by the file's md5), md5, parseMs, sourceDist (the source events' dist on the
 * editor's scale: a reach field), steer, RM, rungMs / stallWindowS / watchMs / progressMs (tests), maxDeepen}
 */
async function compile(L, opts = {}, emit = () => {}) {
	const t0 = Date.now();
	const seconds = +opts.seconds > 0 ? +opts.seconds : 60;
	const total = seconds * 1000;
	const workers = Math.max(1, Math.round(+opts.workers || 2));
	const P = Math.max(1, Math.round(+opts.inflight || workers));
	const rungMs = Array.isArray(opts.rungMs) ? opts.rungMs : RUNG_MS;
	const stallWindow = (+opts.stallWindowS > 0 ? +opts.stallWindowS : Math.max(STALL_MIN_S, Math.min(STALL_S, seconds * STALL_F))) * 1000;
	const watchMs = +opts.watchMs > 0 ? +opts.watchMs : WATCH_MS;
	const progressMs = +opts.progressMs > 0 ? +opts.progressMs : PROGRESS_MS;
	const maxDeepen = Number.isFinite(+opts.maxDeepen) ? +opts.maxDeepen : MAX_DEEPEN;
	const polishOn = opts.polish !== false;
	const polishReserve = polishOn ? Math.min(POLISH_MS + (POLISH_REST ? POLISH_LONG_F * Math.max(0, total - 60000) : 0), POLISH_F * total) : 0;
	const perfectOn = PERFECT && opts.perfect !== false;
	const perfectReserve = perfectOn ? Math.min(PERFECT_MS, PERFECT_F * total) : 0;
	const proveOn = opts.prove !== false;
	// (the reserve kept once a route is known: the polish's, and the proof's where the start is static (set below))
	let proveReserve = 0, endReserve = polishReserve + perfectReserve;
	const C = require('../common.js');
	// ---- the event log (out/events.jsonl) next to emit
	const out = opts.out ? String(opts.out) : '';
	let evBuf = [];
	if (out) { try { fs.mkdirSync(out, { recursive: true }); } catch (e) { /* none */ } }
	const flushEvents = () => { if (!out || !evBuf.length) return; try { fs.appendFileSync(path.join(out, 'events.jsonl'), evBuf.join('\n') + '\n'); } catch (e) { /* read-only */ } evBuf = []; };
	const say = (ev) => {
		ev.t = Math.round((Date.now() - t0) / 100) / 10;
		emit(ev);
		if (out) { evBuf.push(JSON.stringify(ev)); if (evBuf.length > 5000) flushEvents(); }
	};
	const secNow = () => (Date.now() - t0) / 1000;
	const left = () => total - (Date.now() - t0);
	const stages = { parse: Math.round(+opts.parseMs || 0), model: 0, bounds: 0, plan: 0, moves: 0, verify: 0, perfect: 0, polish: 0, prove: 0 };
	const stage = (name, ms, text) => { stages[name] = Math.round(ms); say({ ev: 'stage', name, ms: Math.round(ms), text }); };

	// ---- the parts
	const parts = partsOf(opts, say);
	// ---- THE ONE SHOT's thread (OS_ON + OS_THREAD, a level file, the real parts): started first, it builds its own parts
	let osw = null, osStats = null, osReady = null, osErr = '', osThreadDone = false, osOpen = !OS_GATE, osReleased = 0, osWantOpen = '';
	const osQ = [];
	let osBwReq = null;            // (THE SHARED SESSION) the one shot's far leg waiting for an idle stretch child
	const osPending = new Map();   // (the gate) abstract state key -> the one shot's soonest arrival's masks, held
	if (OS_ON && OS_THREAD && opts.file && !opts.parts) {
		try {
			const { Worker } = require('worker_threads');
			// (its isolate's old space: osworker.js OS_HEAP_MB (the live heap where its A* stops growing) + 512 MB; 0: V8's own)
			const osHeap = process.env.EEAT_OS_HEAP_MB !== undefined && process.env.EEAT_OS_HEAP_MB !== '' && Number.isFinite(+process.env.EEAT_OS_HEAP_MB) ? +process.env.EEAT_OS_HEAP_MB : 1024;
			const osData = { file: path.resolve(String(opts.file)), graph: process.env.EEAT_OS_GRAPH === '1', graphThreads: 1, cache: process.env.EEAT_OS_CACHE || null };
			if (OS_BW_ST && ST_ON) osData.bwShare = 1;
			const osFile = path.join(__dirname, 'oneshot', 'osworker.js');
			osw = OS_PROC ? osProc(osFile, osData, osHeap)
				: new Worker(osFile, { workerData: osData, ...(osHeap > 0 ? { resourceLimits: { maxOldGenerationSizeMb: Math.round(osHeap + 512) } } : {}) });
			osw.on('message', (m) => {
				if (!m || typeof m !== 'object') return;
				if (m.type === 'route' || m.type === 'arr') osQ.push(m);
				else if (m.type === 'bwreq') osBwReq = m;   // (THE SHARED SESSION: one out at a time; stSchedule sends it)
				else if (m.type === 'stats') { osStats = m.stats; osThreadDone = !!m.done; }
				else if (m.type === 'ready') { osReady = m; say({ ev: 'oneshot', what: 'ready', ms: m.ms, setupMs: m.setupMs }); }
				else if (m.type === 'error') { osErr = String(m.error || '').split('\n')[0]; say({ ev: 'warning', text: `the one shot's thread: ${osErr}` }); }
			});
			osw.on('error', (e) => { osErr = String(e && e.message || e); say({ ev: 'warning', text: `the one shot's thread: ${osErr}` }); });
			osw.unref();   // (a compile that ends another way never waits for it)
		} catch (e) { osw = null; say({ ev: 'warning', text: `the one shot's thread could not start (${e.message})` }); }
	}
	/** a real state (masks from the level start: an executor anchor, a route) into the one shot (its thread or its object) */
	const osInject = (masks, why) => {
		if (osw) { try { osw.postMessage({ type: 'inject', masks: typeof masks === 'string' ? masks : T.strOf(masks), why }); return true; } catch (e) { return false; } }
		return false;
	};
	let tm = Date.now();
	const model = await parts.compileModel(L, { file: opts.file, seed: opts.seed });
	const nTrig = cnt(model.triggers), nFeat = cnt(model.feats), nGate = cnt(model.gates !== undefined ? model.gates : model.doors);
	say({ ev: 'model', triggers: nTrig, feats: nFeat, gates: nGate, regions: cnt(model.regions), ms: Date.now() - tm });
	stage('model', Date.now() - tm, `${nTrig === undefined ? '?' : nTrig} trigger${nTrig === 1 ? '' : 's'}, ${nFeat === undefined ? '?' : nFeat} feature${nFeat === 1 ? '' : 's'}, ${nGate === undefined ? '?' : nGate} gate${nGate === 1 ? '' : 's'}`);
	tm = Date.now();
	let bounds = null;
	if (parts.createBounds) {
		try { bounds = await parts.createBounds(L, { model }); } catch (e) { bounds = null; say({ ev: 'warning', text: `the bounds could not be built (${e.message}): no admissible bound but the planner's` }); }
	}
	const facts = parts.createFacts({ rungs: 4, model });
	// (the planner's floor probe runs in a worker thread off the bounds stage: EEAT_PLAN_FLOOR_ASYNC=0 in line, as before)
	const planner = parts.createPlanner(model, facts, { bounds, seed: opts.seed, file: opts.file, floorAsync: process.env.EEAT_PLAN_FLOOR_ASYNC !== '0' });
	const floorVerOf = () => { try { return typeof planner.floorVersion === 'function' ? planner.floorVersion() : 0; } catch (e) { return 0; } };
	// (the arrivals' room: goexplore.js roomOf, a pure function of the level: the contract's RM, no search)
	const GX = opts.RM ? null : require('../goexplore.js');
	const RM = opts.RM || GX.roomOf(L);
	// (the primitives and the executor start after the first plan: their start-up counts in the moves)
	let prims = null, exec = null;

	// ---- a scratch engine for model states
	const scratch = new E.EESim(L);
	/** the sim at an arrival's end: its snapshot (checked by its hash) or a replay of its masks */
	const simOf = (a) => {
		if (a.snap) { try { scratch.reset(); scratch.restore(a.snap); if (!a.hash || scratch.stateHash() === a.hash) return scratch; } catch (e) { /* replay */ } }
		return T.playTo(L, a.masks, { allowDeath: true }).sim;
	};
	const visited = new Uint8Array(L.width * L.height);   // tiles along verified arrivals (the exploration frontier)
	/** a replay of masks from the level start: the goal's first tick (and beforeTick), deaths, the finish, the run timer at
	 *  the end; marks the visited tiles. from: the leg's start tick (its start's masks, verified before): a death in that
	 *  prefix is a move of the route (a die step, a death an earlier leg took), not this leg's; only a death that begins
	 *  at or after it counts (dead) and ends the replay unless allowDeath (EEAT_PREFIX_DEATH=0: every death, as before) */
	const replay = (masks, goal, allowDeath, from) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let dead = -1, finished = -1, goalAt = -1, was = false;
		const W = L.width, H = L.height;
		const f0 = PREFIX_DEATH && from > 0 ? from : 0;
		for (let t = 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t] & 31);
			sim.tick(inp);
			if (sim.is_dead) {
				if (t >= f0 && !was) { if (dead < 0) dead = t + 1; if (!allowDeath) break; }
				was = true;
			} else { was = false; visited[T.tileOf(sim, W, H)] = 1; }
			if (finished < 0 && sim.has_silver_crown) finished = t + 1;
			if (goal && goalAt < 0 && goal.test(sim)) goalAt = t + 1;
		}
		return { sim, dead, finished, goalAt, run: sim.run_ticks };
	};

	// ---- the start, the admissible lower bound
	const r0 = T.playTo(L, new Uint8Array(0));
	const a0 = Object.assign(T.arrivalOf(L, r0.sim, new Uint8Array(0), RM), { run: 0, leg: null });
	const S0 = model.stateOf(r0.sim);
	// (a static start: one idle tick leaves the state as it is (no fall, no clock the state holds: time doors): waiting before
	// the first input then changes nothing, so the fewest ticks from the start is the fewest run ticks + 1)
	const startStatic = (() => { try { const r1 = T.playTo(L, new Uint8Array(1)); return !r1.sim.is_dead && r1.sim.stateHash() === r0.sim.stateHash(); } catch (e) { return false; } })();
	const startAnchorArg = { arrival: a0, arrivals: [a0], S: S0, key: String(S0.key), tick: 0, run: 0 };
	// (the idle ticks until the start rests: its state hash repeats; -1 = not within PROVE_IDLE_MAX, or the ball dies idling)
	const restIdle = (() => {
		try {
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			let h = sim.stateHash();
			for (let k = 0; k <= PROVE_IDLE_MAX; k++) { E.applyMask(inp, 0); sim.tick(inp); if (sim.is_dead) return -1; const h2 = sim.stateHash(); if (h2 === h) return k; h = h2; }
		} catch (e) { /* none */ }
		return -1;
	})();
	if (proveOn && restIdle >= 0) { proveReserve = Math.min(PROVE_MS, PROVE_F * total); endReserve = polishReserve + perfectReserve + proveReserve; }
	// (lane 5, TAS-perfect: a SHORT route, at most PROVE_TINY run ticks, keeps PROVE_TINY_F of the budget for the proof: its
	// exhaustive exact searches from the start are within reach and find the faster routes too (Switch Labyrinth at 300 s:
	// the moves found 32 at ~3 s and nothing in 205 s more; the proof then found 27 (5 rounds of -1) and proved 26 of its 39
	// starts in 76 s, the 27th at the exact bound 27 of the 28 needed when its share ran out). EEAT_PROVE_TINY=0: off)
	const endRes = () => endReserve + (best && proveOn && restIdle >= 0 && PROVE_TINY_ON && best.runTicks <= PROVE_TINY ? Math.max(0, PROVE_TINY_F * total - proveReserve) : 0);
	let lbPlanner = 0, lbBounds = 0, lbComplete = false, lbInf = false;
	// (a part that overruns its own budget cannot be cut here (a synchronous call): the call is timed, and one that took
	// LB_SLOW_MS or more is not made again this compile (the arrivals' bounds, the refresh at the end))
	let lbSlow = false, planSlowSaid = false;
	try { const tq = Date.now(); const r = planner.lowerBound ? planner.lowerBound(startAnchorArg, { ms: LB0_MS }) : null; lbPlanner = lbTicks(r); lbComplete = !!(r && r.complete); if (Date.now() - tq >= LB_SLOW_MS) { lbSlow = true; say({ ev: 'warning', text: `the planner's lowerBound took ${((Date.now() - tq) / 1000).toFixed(1)} s (asked ${LB0_MS / 1000} s): not called again this compile` }); } } catch (e) { say({ ev: 'bug', what: 'lowerBound', error: e.message }); }
	if (lbPlanner === Infinity) { lbInf = true; lbPlanner = 0; say({ ev: 'warning', text: 'the planner\'s lower bound from the start is infinite: no way to the trophy in its relaxation (a proof there, if the model is sound); the moves try anyway' }); }
	if (bounds && typeof bounds.leg === 'function') {
		try { lbBounds = idleRunLB(L, bounds, T.goalOf(L, { kind: 'trophy', label: 'trophy' })); } catch (e) { say({ ev: 'warning', text: `bounds.leg: ${e.message}` }); }
	}
	let LB = Math.max(lbPlanner, lbBounds);
	stage('bounds', Date.now() - tm, (LB > 0 ? `lower bound ${num(LB)} run ticks from the start${lbPlanner && lbBounds ? ` (planner ${num(lbPlanner)}, physics ${num(lbBounds)})` : lbBounds ? ' (physics)' : ''}${lbPlanner && !lbComplete ? ' (the planner\'s search cut: its open list\'s least f)' : ''}`
		: 'no admissible bound (none of the parts gives one): 0') + (lbInf ? '; the planner\'s relaxation finds no way to the trophy' : ''));

	// ---- the distances of the 'source' events (the editor's scale: the steer field's tiles, else STEER_MISS + the reach
	// field's; only with opts.sourceDist or a steer file: a reach field costs a build)
	const RF = require('../reach.js');
	let reachF = null, steer = null;
	const reachOf = () => { if (!reachF) { try { reachF = RF.reachField(L, { deaths: false }); } catch (e) { reachF = false; } } return reachF || null; };
	const loadSteer = (file) => {
		try { const SF = require('../steer.js'); steer = { SF, st: SF.readSteerFile(fs.readFileSync(file)), file }; return true; } catch (e) { say({ ev: 'warning', text: `steer file ${file}: ${e.message}` }); return false; }
	};
	if (opts.steer) loadSteer(opts.steer);
	const distOf = (sim) => {
		if (steer) { const v = steer.SF.steerAt(steer.st, sim); if (Number.isFinite(v)) return v; }
		if (!opts.sourceDist) return undefined;
		const f = reachOf(); const c = f ? RF.costAt(f, sim) : -1;
		return c >= 0 ? Math.min(9990, STEER_MISS + c) : 9990;
	};

	// ---- legs: every verified arrival's leg (the step that made it, from which start), for the route's report
	const legs = new Map();   // legId -> {label, fromTick, ticks, lb, proven, tool, prev (legId | null)}
	let legSeq = 0;
	const addLeg = (o) => { const id = ++legSeq; legs.set(id, o); return id; };
	const chainOf = (id) => {
		const list = [];
		for (let k = id, n = 0; k && n < 10000; n++) { const g = legs.get(k); if (!g) break; list.push(g); k = g.prev; }
		return list.reverse().map((g) => ({ label: g.label, fromTick: g.fromTick, ticks: g.ticks, lb: Number.isFinite(g.lb) ? g.lb : null, proven: !!g.proven, provenBy: g.provenBy || null, lbMath: Number.isFinite(g.lbMath) ? g.lbMath : null, tool: g.tool || null }));
	};

	// ---- anchors
	const anchors = new Map();   // S.key -> anchor
	let anchorSeq = 0, lastProgress = Date.now(), progressVer = factsVer(facts), steps = 0, okSteps = 0, failSteps = 0, picksN = 0, bnbPlans = 0, bnbArrivals = 0, lateArrivals = 0;
	// (the relay starts: per (anchor id, edge) the nearest state its failed rungs reached, a start of its next rung;
	// EEAT_RELAY=0: off)
	const RELAY = process.env.EEAT_RELAY !== '0', RELAY_GAIN = 1;
	const relays = new Map(), relayFloor = new Map();
	let relayRuns = 0, relaySet = 0, relayDrop = 0;
	const runMinOf = (A) => A.arrivals.reduce((m, a) => Math.min(m, a.run > 0 ? a.run : 0), Infinity);
	const startedOf = (A) => A.arrivals.every((a) => a.run > 0);
	const gainOf = (S, parent) => {
		if (S && Number.isFinite(+S.gain)) return +S.gain;
		if (S && S.triggers && (Array.isArray(S.triggers) || S.triggers instanceof Set)) return Array.isArray(S.triggers) ? S.triggers.length : S.triggers.size;
		return parent ? parent.gain + 1 : 0;
	};
	/** a verified arrival a (its model state S): a new anchor, or one more diverse arrival of a known one -> {anchor, isNew, changed}.
	 *  RE-ENTRY BY ANOTHER TRIGGER (EEAT_ANCHOR_QUAL=0: off): an arrival whose state class is known already but that came
	 *  by touching ANOTHER trigger than the one that made that class's anchor (a switch toggled back from another switch
	 *  tile, the same switch id at another place) is an anchor of its own, keyed by the class and that edge: the planner
	 *  plans from an anchor's first arrival (its tile), so such an arrival, merged into the old anchor, was never planned
	 *  from, and a plan through it ("purple switch 0 (197,15) -> purple switch 0 (239,15) -> trophy") came back to its
	 *  first step from the old anchor's place forever: Fish Gods' 25 steps toggled psw 0 between two anchors, then 'end
	 *  exhausted' with 5 s of its 60 left. The facts' node class carries the edge too (planner anchorOf `qual`) */
	const addArrival = (a, S, parent, why, step) => {
		let key = String(S.key);
		let A = anchors.get(key);
		let qual = null;
		if (A && ANCHOR_QUAL && step && !step.synthetic && /^trig:/.test(String(step.edge)) && A.edgeVia !== step.edge) {
			qual = String(step.edge);
			key = `${key}@${qual}`;
			A = anchors.get(key);
		}
		if (!A) {
			A = { id: ++anchorSeq, key, S, arrivals: [a], firstTick: a.tick, picks: 0, fails: 0, exhausted: false, why: '', gain: gainOf(S, parent), parent: parent ? parent.key : null,
				depth: parent ? parent.depth + 1 : 0, costEst: parent && Number.isFinite(parent.nextCost) ? parent.nextCost : Infinity, costVer: -1, plans: null, via: why,
				edgeVia: step && !step.synthetic ? String(step.edge) : null, qual };
			anchors.set(key, A);
			lastProgress = Date.now();
			return { anchor: A, isNew: true };
		}
		const before = A.arrivals.map((x) => x.hash).join(',');
		A.arrivals = T.pickDiverse(A.arrivals.concat([a]), ARRIVALS_K);
		if (a.tick < A.firstTick) A.firstTick = a.tick;
		return { anchor: A, isNew: false, changed: A.arrivals.map((x) => x.hash).join(',') !== before };
	};
	addArrival(a0, S0, null, 'start');

	// ---- the route and the bounds: tickBound (stdin "depth D": only routes of at most D ticks), the B&B's run-tick bound
	// (the best route's, or a known route's: stdin "route", opts.bound)
	let tickBound = Number.isFinite(+opts.depth) && +opts.depth > 0 ? +opts.depth : Infinity;
	let extBound = Number.isFinite(+opts.bound) && +opts.bound > 0 ? +opts.bound : Infinity;
	let best = null;   // {masks, ticks, runTicks, deaths, chance, legs, how}
	const runBound = () => Math.min(best ? best.runTicks : Infinity, extBound);
	// (the anchor pick's gain: EEAT_CRUMB_RANK leaves the crumbs' part out (1: once a route is known, 2: always))
	const pickGain = CRUMB_RANK === 3 ? (A) => (A.S && A.S.cgain > 0 && !A.crumbOnWay ? A.gain - A.S.cgain : A.gain)
		: CRUMB_RANK ? (A) => (A.S && A.S.cgain > 0 && (CRUMB_RANK === 2 || best) ? A.gain - A.S.cgain : A.gain) : (A) => A.gain;
	/** (=3, THE F GATE) each live anchor's crumbOnWay: its f within the slack of the least f of its real gain */
	const crumbGate = (list) => {
		const fOf = (A) => A.firstTick + (Number.isFinite(A.costEst) ? A.costEst : Infinity);
		const realOf = (A) => A.gain - (A.S && A.S.cgain > 0 ? A.S.cgain : 0);
		const fMin = new Map();
		for (const A of list) { const g = realOf(A), f = fOf(A); if (!(fMin.get(g) <= f)) fMin.set(g, f); }
		for (const A of list) { const m = fMin.get(realOf(A)); A.crumbOnWay = Number.isFinite(m) && fOf(A) <= m * (1 + CR_F_SLACK) + CR_F_ABS; }
	};
	const gapOf = (rt) => (Number.isFinite(rt) ? Math.max(0, rt - LB) : null);
	/** a route (masks that finish): C.evaluate'd; the best when faster (run ticks, then ticks) -> {ev, better} | null */
	const routeOf = (masks, how, legId) => {
		const ev = C.evaluate(L, masks);
		if (!ev) return null;
		if (ev.complete > tickBound) return { ev, better: false };
		const better = !best || ev.runTicks < best.runTicks || (ev.runTicks === best.runTicks && ev.complete < best.ticks);
		if (!better) return { ev, better: false };
		best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: legId ? chainOf(legId) : [], how };
		say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
		if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
		lastProgress = Date.now();
		// (the one shot's thread: every better route of another tool is its bound)
		if (osw && how !== 'the one shot') osInject(ev.ms, 'route');
		return { ev, better: true };
	};

	// ---- THE EXACT LANDING (src/precision.js as a child process: it never blocks this thread): a trophy leg whose nearest
	// state is within PREC_NEAR tiles of the trophy and that no tier reached is the signature of a ZERO-WIDTH window: a way
	// that needs ONE exact sub-pixel x (a spike's centre rule on one side, a half block's solid half on the other: the box
	// must drop at px == 5720.0 exactly, one double on a grid of 2^-40 px). Every static x constraint of the engine sits on
	// a multiple of 8 px, so the target x is COMPUTED (the nudge test), and the inputs that reach it exactly are COMPUTED
	// too (a meet in the middle of the engine's own rest-to-rest moves: exact pieces that sum to the target). No search of
	// the old paradigm; every route it prints is C.evaluate'd there and again here (routeOf). The attempts: the trophy
	// legs' nearest states (fail.closest), nearest first.
	const precOn = opts.precision !== false && process.env.EEAT_PLAN_PREC !== '0' && !!opts.file;
	const precAtt = new Map();   // masks string -> dist
	let precRuns = 0, precBusy = false, precChild = null;
	// (EEAT_PREC_ASYNC: the attempts the last run was given; the moves ended: no new run, no late route)
	let precGiven = 0, precOver = false;
	const precision = async (closest, again) => {
		if (again) {
			// (EEAT_PREC_ASYNC: a run ended without a route: again at once when nearest states came meanwhile)
			if (!precOn || precOver || precBusy || precRuns >= PREC_RUNS || precAtt.size === precGiven || stopped) return null;
		} else {
			if (!precOn || !closest || !closest.masks || !(closest.dist >= 0) || closest.dist > PREC_NEAR) return null;
			const str = typeof closest.masks === 'string' ? closest.masks : T.strOf(closest.masks);
			if (!/^[0-O]+$/.test(str)) return null;
			const had = precAtt.size;
			if (!precAtt.has(str)) precAtt.set(str, +closest.dist);
			if (precBusy || precRuns >= PREC_RUNS || precAtt.size === had || stopped || precOver) return null;
		}
		precGiven = precAtt.size;
		const secs = Math.floor(Math.min(PREC_S * 1000, left() - endReserve - 2000) / 1000);
		if (secs < PREC_MIN_S) return null;
		precBusy = true; precRuns++;
		const os = require('os'), cp = require('child_process');
		const att = [...precAtt].sort((a, b) => a[1] - b[1]).slice(0, PREC_ATTEMPTS).map((e) => e[0]);
		const file = path.join(os.tmpdir(), `eeat_prec_${process.pid}_${precRuns}.txt`);
		const t1 = Date.now();
		let found = null, done = null, foundRun = Infinity, streamEv = null;
		try {
			fs.writeFileSync(file, att.join('\n') + '\n');
			say({ ev: 'precision', run: precRuns, attempts: att.length, nearest: Math.round(+precAtt.get(att[0]) * 10) / 10, seconds: secs });
			await new Promise((resolve) => {
				const pw = Math.max(1, Math.min(workers, 4));
				// (n5-perfect: the fast rests, braked from the attempts' moving states: EEAT_PREC_FAST=0 / EEAT_PERFECT=0 off; with
				// them the coasted pass stops at its first route; without them lane 5's rule: the fastest landing (--after))
				const mode = PREC_FAST ? ['--first=1', '--fast=1'] : PREC_FIRST ? ['--first=1'] : [`--after=${PREC_AFTER_S}`];
				const ch = cp.spawn(process.execPath, [path.join(__dirname, '..', 'precision.js'), String(opts.file), `--attempts=${file}`, `--workers=${pw}`, `--seconds=${secs}`, ...mode], { stdio: ['ignore', 'pipe', 'ignore'] });
				precChild = ch;
				const onExit = () => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } };
				process.once('exit', onExit);
				ch.on('close', () => process.removeListener('exit', onExit));
				let buf = '';
				const kill = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }, (secs + 10) * 1000);
				const poll = setInterval(() => { if (stopped || left() <= 0) { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } } }, 500);
				ch.stdout.on('data', (d) => {
					buf += d;
					let k;
					while ((k = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, k); buf = buf.slice(k + 1);
						let ev = null;
						try { ev = JSON.parse(line); } catch (e) { continue; }
						// (the fewest run ticks of its results: the fast pass and --after print each faster one)
						if (ev.ev === 'result' && ev.kind === 'finish' && typeof ev.inputs === 'string' && (!found || (Number.isFinite(+ev.runTicks) && +ev.runTicks < foundRun))) {
							found = ev.inputs; foundRun = Number.isFinite(+ev.runTicks) ? +ev.runTicks : Infinity;
							// (EEAT_PREC_STREAM: the route at once, not at the child's end)
							if (PREC_STREAM && !precOver) { const x = routeOf(T.masksOf(found.replace(/[^0-O]/g, '')), 'the exact landing (precision)', null); if (x && x.better) streamEv = x.ev; }
						}
						else if (ev.ev === 'done') done = ev.end;
					}
				});
				ch.on('error', () => { clearTimeout(kill); clearInterval(poll); resolve(); });
				ch.on('close', () => { clearTimeout(kill); clearInterval(poll); precChild = null; resolve(); });
			});
		} catch (e) { say({ ev: 'warning', text: `precision: ${e.message}` }); }
		try { fs.unlinkSync(file); } catch (e) { /* gone */ }
		precBusy = false;
		say({ ev: 'precision', run: precRuns, end: found ? 'finish' : done || 'ended', ms: Date.now() - t1 });
		if (PREC_ASYNC && !found && !precOver) setImmediate(() => { precision(null, true).catch((e) => bug('precision', { error: e.message })); });
		if (!found || (PREC_ASYNC && precOver)) return null;
		if (PREC_STREAM) return streamEv;
		const x = routeOf(T.masksOf(found.replace(/[^0-O]/g, '')), 'the exact landing (precision)', null);
		return x && x.better ? x.ev : null;
	};
	/** EEAT_PREC_ASYNC: the executor has nothing left and would end: while the precision child runs (no route yet, time
	 *  left) the loop waits a turn for it (-> true: go on) */
	const precHold = async () => {
		if (!precBusy || best || stopped || left() <= 1000) return false;
		await new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
		return true;
	};

	// ---- THE WHOLE LEVEL AS ONE LEG (EEAT_BW_LEVEL=1; BW_LEVEL above): started with the moves loop, killed at its end
	let bwlChild = null, bwlDone = null, bwlWpFile = null, bwlWpKey = '', bwlPending = null;
	// (the gate: BW_GATE above; the held arrivals' inputs in the order they came)
	let bwlOpen = !BW_GATE, bwlWant = '', bwlReleased = 0;
	const bwlHeld = [];
	// (a plan's waypoints from the start anchor, in order, up to the trophy: the child's legs; null without a trigger step)
	const bwlWpsOf = (pl, A) => {
		const wps = [];
		if (pl) for (const st of pl.steps) {
			if (st.synthetic) break;
			const wp = waypointOf(st, A);
			if (!wp || wp.allowDeath || wp.dieField) break;
			if (wp.kind === 'trophy') { wps.push({ kind: 'trophy', label: 'trophy' }); break; }
			const tiles = wp.tiles ? Array.from(wp.tiles) : [];
			if (!tiles.length) break;
			wps.push({ kind: wp.kind, label: wp.label || wp.kind, tiles, expect: !!wp.expect });
		}
		return wps.some((w) => w.kind !== 'trophy') ? wps : null;
	};
	// (BW_LEGS: a later plan of the start anchor with a trigger step rewrites the file; the child reads it after its first
	// clock: a ONE-LEG level's first plan is the trophy alone, and its later plans (the facts of the failed trophy legs)
	// name the triggers)
	const bwlPlan = (A) => {
		if (!bwlWpFile || !bwlChild || best || !A || String(A.key) !== String(S0.key)) return;
		try {
			// (the anchor's best plan now (its memo's first), not the alternative a job runs)
			const pl = A.plans && Array.isArray(A.plans.plans) ? A.plans.plans[0] : null;
			const wps = bwlWpsOf(pl, A);
			if (!wps) return;
			const k = wps.map((w) => w.label).join('>');
			if (k === bwlWpKey) return;
			bwlWpKey = k;
			require('fs').writeFileSync(bwlWpFile + '.tmp', JSON.stringify(wps));
			require('fs').renameSync(bwlWpFile + '.tmp', bwlWpFile);
			say({ ev: 'bwlevel', waypoints: wps.length, plan: k.slice(0, 200) });
		} catch (e) { /* the file: next time */ }
	};
	let bwcOpen = !BWC_GATE, bwcReleased = 0;
	const bwcHeld = [];
	/** the chain's gate opens: its held anchors go to the loop (import) -> true when an anchor is new */
	const bwcRelease = (why) => {
		if (!BW_CHAIN || bwcOpen) return false;
		bwcOpen = true;
		const n0 = anchors.size;
		for (const m of bwcHeld) onLine('import ' + m);
		bwcReleased = bwcHeld.length;
		bwcHeld.length = 0;
		say({ ev: 'bwchain', what: 'gate', why, held: bwcReleased, anchors: anchors.size - n0 });
		return anchors.size !== n0;
	};
	const wholeLevel = () => {
		if (!(BW_LEVEL || BW_CHAIN) || !opts.file || bwlDone) return;
		const secs = BW_CHAIN ? Math.floor(Math.min(BWC_MAX_S, (+seconds || 60) * BWC_F, (left() - 3000) / 1000))   // (the chain: to the budget's end; with no route the loop waits for it there)
			: Math.floor(Math.min(BW_LEVEL_MAX_S, (+seconds || 60) * BW_LEVEL_F, (left() - endReserve - 2000) / 1000));
		if (!(secs >= 5)) return;
		const cp = require('child_process'), t1 = Date.now();
		// (BW_LEGS: the first plan's waypoints from the start, in order, for the child's legs when the trophy is gated)
		let wpFile = null, nWp = 0;
		if (BW_LEGS && !BW_CHAIN && BW_LEVEL_MODE !== 'last') {
			try {
				wpFile = path.join(require('os').tmpdir(), `eeat_bwl_${process.pid}_${Date.now()}.json`);
				const A = anchors.get(String(S0.key));
				const p = A ? planOfAnchor(A) : null;
				const wps = bwlWpsOf(p && p.plans[0], A);
				require('fs').writeFileSync(wpFile, JSON.stringify(wps || []));
				if (wps) { nWp = wps.length; bwlWpKey = wps.map((w) => w.label).join('>'); }
				bwlWpFile = wpFile;
			} catch (e) { wpFile = null; say({ ev: 'warning', text: `bwlevel legs: ${e.message}` }); }
		}
		if (BW_CHAIN) say({ ev: 'bwlevel', seconds: secs, chain: BW_CHAIN }); else say({ ev: 'bwlevel', seconds: secs, waypoints: nWp });
		let imported = 0;
		bwlDone = new Promise((resolve) => {
			let found = null, done = null, buf = '';
			// (the chain with the stretch solver on: only a GATED level, --gatedOnly=1; the stretch child takes a one-leg level's
			// whole-level solve)
			const ch = cp.spawn(process.execPath, ['--max-old-space-size=2000', path.join(__dirname, 'lab', BW_CHAIN ? 'bwchain_child.js' : 'bwlevel_child.js'), String(opts.file), `--ms=${secs * 1000}`, ...(wpFile ? [`--wps=${wpFile}`] : []), ...(BW_CUTS && !BW_CHAIN ? ['--cuts=1'] : []), ...(BW_CHAIN && ST_ON ? ['--gatedOnly=1'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
			bwlChild = ch;
			const onExit = () => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } };
			process.once('exit', onExit);
			const kill = setTimeout(onExit, (secs + 20) * 1000);
			// (=last: the moves' first route ends the child: its route would never be taken)
			const poll = setInterval(() => { if (stopped || left() <= 0 || (BW_LEVEL_MODE === 'last' && !BW_CHAIN && best)) onExit(); }, 500);
			if (kill.unref) kill.unref();
			if (poll.unref) poll.unref();
			ch.stdout.on('data', (d) => {
				buf += d;
				let k;
				while ((k = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, k); buf = buf.slice(k + 1);
					let ev = null;
					try { ev = JSON.parse(line); } catch (e) { continue; }
					if (ev.ev === 'result' && ev.kind === 'finish' && typeof ev.inputs === 'string') {
						found = ev.inputs;
						if (BW_LEVEL_MODE === 'last' && !BW_CHAIN) { bwlPending = found; say({ ev: 'bwlevel', end: 'finish', runTicks: typeof ev.runTicks === 'number' ? ev.runTicks : null, deferred: true, ms: Date.now() - t1 }); continue; }
						const x = routeOf(T.masksOf(found.replace(/[^0-O]/g, '')), BW_CHAIN ? 'the level as a chain of backward legs' : 'the whole level as one leg (backward)', null);
						say({ ev: 'bwlevel', end: 'finish', runTicks: x && x.ev ? x.ev.runTicks : null, better: !!(x && x.better), ms: Date.now() - t1 });
					} else if (ev.ev === 'arrival' && typeof ev.inputs === 'string' && !best && (BW_LEVEL_MODE !== 'last' || BW_CHAIN)) {
						// (a leg of the whole level: its new model state an anchor, as an imported state: replayed, addArrival)
						say({ ev: 'bwlevel', leg: ev.label || '', ticks: ev.ticks, ms: Date.now() - t1, ...(bwlOpen ? {} : { held: true }) });
						if (bwlOpen) onLine(`import ${ev.inputs.replace(/[^0-O]/g, '')}`);
						else bwlHeld.push(ev.inputs.replace(/[^0-O]/g, ''));
					} else if (ev.ev === 'anchor' && BWC_IMPORT && typeof ev.inputs === 'string' && !best && !stopped) {
						// (a chain node: the loop's import (replayed; a model state not seen yet is an anchor))
						imported++;
						if (bwcOpen) onLine('import ' + ev.inputs.replace(/[^0-O]/g, ''));
						else bwcHeld.push(ev.inputs.replace(/[^0-O]/g, ''));
					} else if (ev.ev === 'chain') say({ ev: 'bwchain', ok: ev.ok, why: ev.why, legs: ev.legs, legsOk: ev.legsOk, nodes: ev.nodes, gain: ev.gain, imported, ms: Date.now() - t1 });
					else if (ev.ev === 'leg') say({ ev: 'bwlevel', legTry: ev.n, of: ev.of, label: ev.label, ok: ev.ok, T: ev.T, why: ev.why, ms: Date.now() - t1 });
					else if (ev.ev === 'done') done = ev.end;
				}
			});
			let finished = false;
			const fin = () => { if (finished) return; finished = true; clearTimeout(kill); clearInterval(poll); process.removeListener('exit', onExit); bwlChild = null; if (wpFile) { bwlWpFile = null; try { require('fs').unlinkSync(wpFile); } catch (e) { /* gone */ } } if (!found) say({ ev: 'bwlevel', end: done || 'ended', ms: Date.now() - t1 }); resolve(); };
			ch.on('error', fin);
			ch.on('close', fin);
		});
	};

	/** the gate opens (BW_GATE: the executor stalled or has nothing left, no route): the held arrivals go to it as imports,
	 *  and every later one as it comes */
	const bwlRelease = (why) => {
		if (bwlOpen) return;
		bwlOpen = true;
		const n0 = anchors.size, h = bwlHeld.splice(0, bwlHeld.length);
		for (const x of h) onLine(`import ${x}`);
		bwlReleased = h.length;
		say({ ev: 'bwlevel', gate: why, arrivals: h.length, anchors: anchors.size - n0 });
	};
	/** (BW_GATE) the executor has nothing left to run and would end: the held arrivals go to it; while the child still
	 *  solves (no route yet, time left) the loop waits a turn for its arrivals / route (-> true: go on) */
	const bwlHold = async () => {
		if (!BW_LEVEL || !BW_GATE || !bwlDone || best || stopped) return false;
		const n0 = anchors.size;
		bwlRelease('the executor has nothing left');
		if (anchors.size !== n0) { nothingSince = -1; return true; }
		if (!bwlChild || left() <= 1000) return false;
		await new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
		if (anchors.size !== n0) nothingSince = -1;
		return true;
	};
	// ---- THE STRETCH SOLVER IN ITS OWN PROCESS (EEAT_STRETCH=1; ST_* above): ST_N children, one stretch each at a time on
	// one clock; slot 0 takes the short first plan, every slot the failed stretches
	const stSlots = [];              // {ch, busy}: busy = the request in hand {id, A, a, legs, k, ms, cand, t, short}
	let stSeq = 0, stShortSent = false, stLastOs = false;
	const stQ = [];                  // the children's messages, harvested in the loop's turns (stHarvest)
	const stCands = new Map();       // `${anchor id}|${edge key}` -> {A, step, wp, cost, rung, n, tries, lastMs, why, solved, inflight}
	const stStats = { requests: 0, ok: 0, anchors: 0, routes: 0, legs: 0, ms: 0, relays: 0, stale: 0, children: 0, short: null };
	if (OS_BW_ST) Object.assign(stStats, { osReq: 0, osOk: 0, osMs: 0 });
	/** (THE SHARED SESSION) the answer to the one shot's far leg id: masks (a string from the level start) or null */
	const osBwAns = (id, masks, why, ms) => {
		if (!osw) return;
		try { osw.postMessage({ type: 'bwans', id, ok: !!masks, masks: masks || '', why: why || '', ms: +ms || 0 }); } catch (e) { /* the one shot is gone */ }
	};
	const stBusyAny = () => stSlots.some((s) => s.busy);
	const stOkWp = (step, wp) => {
		if (!step || !wp || step.synthetic || wp.allowDeath || wp.dieField || (wp.fieldTiles && wp.fieldTiles.length)) return false;
		if (!(wp.kind === 'trophy' || (wp.kind === 'trigger' && (Array.isArray(wp.tiles) || ArrayBuffer.isView(wp.tiles)) && wp.tiles.length > 0))) return false;
		// (no deadline: a key's timed leg, an absolute beforeTick)
		if ((wp.beforeTick !== undefined && wp.beforeTick !== null && Number.isFinite(+wp.beforeTick)) || Number.isFinite(relOf(step.beforeTickFrom !== undefined ? step.beforeTickFrom : wp.beforeTickFrom))) return false;
		return true;
	};
	const stWpOf = (wp) => (wp.kind === 'trophy' ? { kind: 'trophy' } : { kind: wp.kind, tiles: Array.from(wp.tiles), expect: wp.expect || null, label: wp.label || '' });
	/** a child in slot i (a slot without one) */
	const stSpawn = (i) => {
		const slot = stSlots[i] || (stSlots[i] = { ch: null, busy: null });
		if (slot.ch) return;
		const cp = require('child_process');
		let ch;
		try { ch = cp.spawn(process.execPath, ['--max-old-space-size=3000', path.join(__dirname, 'lab', 'stretch_child.js'), String(opts.file)], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { say({ ev: 'warning', text: `the stretch solver: ${e.message}` }); return; }
		slot.ch = ch; stStats.children++;
		// (below the compile's own priority: on a busy machine the executor's workers keep their CPU, the child takes what is
		// idle; EEAT_ST_NICE=0: the same priority)
		if (ST_NICE > 0) { try { require('os').setPriority(ch.pid, Math.min(19, (require('os').getPriority(process.pid) | 0) + ST_NICE)); } catch (e) { /* not allowed */ } }
		const onExit = () => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } };
		process.once('exit', onExit);
		let buf = '';
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k); buf = buf.slice(k + 1);
				try { stQ.push(JSON.parse(line)); } catch (e) { /* not a message */ }
			}
		});
		ch.stdin.on('error', () => { /* the child ended */ });
		const gone = () => { if (slot.ch === ch) { slot.ch = null; if (slot.busy && slot.busy.os && !slot.busy.osSent) osBwAns(slot.busy.os, null, 'the stretch child ended'); if (slot.busy && slot.busy.cand) slot.busy.cand.inflight = false; slot.busy = null; } };
		ch.on('error', gone);
		ch.on('close', () => { process.removeListener('exit', onExit); gone(); });
	};
	const stStart = () => { if (!ST_ON || !opts.file) return; for (let i = 0; i < ST_N; i++) stSpawn(i); };
	const stKill = (slot) => { if (slot.ch) { try { slot.ch.kill('SIGKILL'); } catch (e) { /* gone */ } } if (slot.busy && slot.busy.cand) slot.busy.cand.inflight = false; slot.ch = null; slot.busy = null; };
	const stStop = () => { for (const s of stSlots) stKill(s); };
	/** the executor has nothing left and would end: while a stretch solver works (no route, time left) the loop waits a turn
	 *  for its arrivals instead (-> true: go on) */
	const stHold = async () => {
		if (!ST_ON || best || stopped || left() <= 1000) return false;
		stHarvest(); stSchedule();
		if (!stBusyAny()) return false;
		const n0 = anchors.size;
		await new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
		stHarvest();
		if (anchors.size !== n0) nothingSince = -1;
		return true;
	};
	/** a request in slot: legs [{step, wp}] from the arrival a of anchor A on a clock of ms */
	const stSend = (slot, A, a, legs, ms, cand) => {
		if (!slot.ch || slot.busy) return false;
		const id = ++stSeq;
		slot.busy = { id, A, a, legs, k: 0, ms, cand, t: Date.now() };
		if (cand) cand.inflight = true;
		stStats.requests++;
		const req = { id, from: T.strOf(a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks)), legs: legs.map((g) => ({ wp: stWpOf(g.wp), w: Math.max(1, +g.step.estTicks || 1) })), ms: Math.round(ms), closest: ST_RELAY };
		try { slot.ch.stdin.write(JSON.stringify(req) + '\n'); } catch (e) { if (cand) cand.inflight = false; slot.busy = null; return false; }
		say({ ev: 'stretch', what: 'request', id, slot: stSlots.indexOf(slot), anchor: A.id, legs: legs.map((g) => labelOf(g.step)), ms: Math.round(ms), from: a.tick });
		return true;
	};
	/** the children's messages: an arrival verified like the executor's (verified) and an anchor (addArrival), or a route */
	const stHarvest = () => {
		while (stQ.length) {
			const m = stQ.shift();
			const slot = stSlots.find((s) => s.busy && s.busy.id === m.id) || null;
			const q = slot ? slot.busy : null;
			if (q && q.os) {
				// (THE SHARED SESSION: the one shot's far leg: its arrival to the one shot (replayed there, an injected node),
				// none at the done)
				if (m.ev === 'arrival' && !q.osSent) { q.osSent = true; stStats.osOk++; osBwAns(q.os, String(m.inputs || ''), '', m.ms); }
				else if (m.ev === 'done') {
					stStats.osMs += Date.now() - q.t;
					if (!q.osSent) osBwAns(q.os, null, m.why || 'none', m.ms);
					say({ ev: 'stretch', what: 'done', id: q.id, oneshot: q.os, ok: !!q.osSent, why: m.why || '', ms: m.ms });
					slot.busy = null;
				}
				continue;
			}
			if (m.ev === 'arrival' && q && q.legs[m.k]) {
				const g = q.legs[m.k];
				const masks = T.masksOf(String(m.inputs || ''));
				const res = { ok: true, arrivals: [{ masks }], legs: [{ start: 0, ticks: masks.length - q.a.tick, lb: null, proven: false, tool: 'stretch' }], tool: 'stretch' };
				const { arr, routes } = verified(g.step, g.wp, res, [q.a]);
				stStats.legs++;
				for (const r of routes) { const x = routeOf(r.masks, `the stretch solver (${labelOf(g.step)})`, r.leg); stStats.routes++; if (x && x.better) say({ ev: 'stretch', what: 'route', id: q.id, runTicks: x.ev.runTicks }); }
				let next = null;
				for (const a of arr) {
					let S2;
					try { S2 = model.stateOf(simOf(a)); } catch (e) { bug('stateOf', { error: e.message }); continue; }
					const { anchor: B, isNew } = addArrival(a, S2, q.A, labelOf(g.step), g.step);
					if (isNew) {
						stStats.anchors++;
						say({ ev: 'source', kind: 'room', room: a.room, desc: a.desc, key: B.key, gain: 1, tick: a.tick, inputs: T.strOf(a.masks), anchor: B.id, label: `${labelOf(g.step)} (stretch)` });
					}
					next = { A: B, a };
				}
				if (q.cand && m.k === 0) q.cand.solved = true;
				say({ ev: 'stretch', what: 'arrival', id: q.id, k: m.k, label: labelOf(g.step), tick: masks.length, ok: arr.length + routes.length > 0, ms: m.ms });
				// (the next leg of a chain starts from this one's verified arrival: its anchor the parent)
				if (next) { q.A = next.A; q.a = next.a; }
				q.k = m.k + 1;
			} else if (m.ev === 'done' && q) {
				stStats.ms += Date.now() - q.t;
				if (m.ok) stStats.ok++;
				if (q.cand) { q.cand.tries++; q.cand.lastMs = q.ms; q.cand.why = m.why || ''; q.cand.inflight = false; }
				if (q.short) stStats.short = { legs: q.legs.length, solved: m.k | 0, why: m.why || '', ms: m.ms };
				// (the partial progress of the leg it stopped on: a relay start of that stretch when it has none)
				if (ST_RELAY && m.closest && typeof m.closest.inputs === 'string' && q.legs[m.closest.k] && RELAY && !Number.isFinite(runBound())) {
					const g = q.legs[m.closest.k], rk = `${q.A.id}|${edgeKey(g.step)}`;
					const mk = T.masksOf(m.closest.inputs);
					if (!relays.has(rk) && mk.length > q.a.tick && mk.length < tickBound) {
						const r = replay(mk, null, false, q.a.tick);
						const h = r.sim.stateHash();
						if (r.dead < 0 && !r.sim.is_dead && r.finished < 0 && !q.A.arrivals.some((x) => x.hash === h)) {
							const leg = addLeg({ label: `relay ${labelOf(g.step)} (stretch)`, fromTick: q.a.tick, ticks: mk.length - q.a.tick, lb: null, proven: false, tool: 'relay', prev: q.a.leg || null });
							relays.set(rk, { arrival: Object.assign(T.arrivalOf(L, r.sim, mk, RM), { run: r.run, leg, relay: true }), dist: Infinity, wallsN: 0 });
							stStats.relays++;
						}
					}
				}
				say({ ev: 'stretch', what: 'done', id: q.id, ok: !!m.ok, k: m.k | 0, why: m.why || '', ms: m.ms });
				slot.busy = null;
			}
		}
	};
	/** a failed step: its stretch a candidate (the rung it failed at); a done step: solved */
	const stNote = (A, step, wp, plan, ok) => {
		if (!ST_ON || !stOkWp(step, wp)) return;
		const rk = `${A.id}|${edgeKey(step)}`;
		let c = stCands.get(rk);
		if (!c) { c = { A, step, wp, cost: Number.isFinite(+plan.cost) ? +plan.cost : Infinity, rung: -1, n: 0, tries: 0, lastMs: 0, why: '', solved: false, inflight: false, seq: stCands.size }; stCands.set(rk, c); }
		if (ok) { c.solved = true; return; }
		c.rung = Math.max(c.rung, step.rung | 0); c.n++;
	};
	/** the failed stretch of the most progress a child may take now (the fewest tries, the most gain, the least cost), or null */
	const stPickCand = () => {
		let bestC = null;
		for (const c of stCands.values()) {
			if (c.solved || c.inflight || c.rung < ST_RUNG || c.tries >= ST_TRIES || (c.tries > 0 && !/budget/.test(c.why)) || c.A.exhausted || !c.A.arrivals.length) continue;
			if (!bestC || c.tries < bestC.tries || (c.tries === bestC.tries && (c.A.gain > bestC.A.gain || (c.A.gain === bestC.A.gain && (c.cost < bestC.cost || (c.cost === bestC.cost && c.seq < bestC.seq)))))) bestC = c;
		}
		return bestC;
	};
	/** (THE SHARED SESSION) the one shot's far leg waiting (osBwReq) to the idle child in slot: one leg from its node's masks
	 *  to the waypoint's tiles (the trophy: the crown) on its clock -> true when sent */
	const stSendOs = (slot) => {
		const m = osBwReq;
		if (!m || !slot.ch || slot.busy) return false;
		osBwReq = null;
		const id = ++stSeq;
		const ms = Math.max(500, Math.min(+m.ms || 1000, left() - 3000));
		const wp = m.wp && m.wp.kind === 'trophy' ? { kind: 'trophy' } : { kind: 'tiles', tiles: Array.from((m.wp && m.wp.tiles) || []), expect: null, label: 'the one shot\'s far leg' };
		slot.busy = { id, os: m.id, A: null, a: null, legs: [], k: 0, ms, cand: null, t: Date.now() };
		const req = { id, from: String(m.masks || ''), legs: [{ wp, w: 1 }], ms: Math.round(ms), closest: false };
		try { slot.ch.stdin.write(JSON.stringify(req) + '\n'); } catch (e) { slot.busy = null; osBwAns(m.id, null, 'the stretch child is gone'); return false; }
		stStats.osReq++; stLastOs = true;
		say({ ev: 'stretch', what: 'request', id, slot: stSlots.indexOf(slot), oneshot: m.id, legs: [wp.kind === 'trophy' ? 'trophy' : 'far leg'], ms: Math.round(ms), from: String(m.masks || '').length });
		return true;
	};
	/** an idle child: the next request (slot 0: the short first plan once; then the failed stretch of the most progress not
	 *  in hand in another slot) */
	const stSchedule = () => {
		if (!ST_ON) return;
		// (a request gone stale: its stretch done by the executor before the child's first leg, or a route known and it is no
		// whole-level request (whose route may be faster): the child is stopped and started again (its memo lost))
		for (let i = 0; i < stSlots.length; i++) {
			const s = stSlots[i], b = s.busy;
			if (s.ch && b && !b.short && !b.os && Date.now() - b.t < b.ms - ST_STALE_MS && ((b.cand && b.cand.solved && b.k === 0) || best)) {
				say({ ev: 'stretch', what: 'stale', id: b.id, slot: i, why: best ? 'a route' : 'the executor did it', ms: Date.now() - b.t });
				stStats.stale++;
				stKill(s);
				if (!best && !stopped) stSpawn(i);
			}
		}
		// (THE SHARED SESSION: the one shot's far leg to an idle child, after the short first plan, in turn with the
		// executor's stretches (one of each while both wait); also once a route is known: the one shot looks for faster ones)
		if (OS_BW_ST && osBwReq && !stopped && left() - 3000 >= ST_MIN_MS) {
			for (let i = 0; i < stSlots.length && osBwReq; i++) {
				const slot = stSlots[i];
				if (!slot.ch || slot.busy || (i === 0 && !stShortSent && !best)) continue;
				if (stLastOs && !best && ST_GENERAL && stPickCand()) continue;
				stSendOs(slot);
			}
		}
		if (stopped || best) return;
		// (before a route the moves have the whole budget: the polish's and the proof's reserves are kept only once a route
		// is known, and a route of the child's own is one; the whole-level backward solve needed 37 s in one piece on Stone
		// Ruin at a 90-s clock and failed at 45 s)
		const room = left() - 3000;
		if (room < ST_MIN_MS) return;
		for (let i = 0; i < stSlots.length; i++) {
			const slot = stSlots[i];
			if (!slot.ch || slot.busy) continue;
			if (i === 0 && !stShortSent) {
				stShortSent = true;
				const A = anchors.get(String(S0.key));
				const p = A ? planOfAnchor(A) : null;
				const pl = p && p.plans[0];
				if (pl && ST_SHORT > 0 && pl.steps.length <= ST_SHORT) {
					const legs = [];
					for (const st of pl.steps) { const wp = st.waypoint || { kind: 'trophy', label: 'trophy' }; if (!stOkWp(st, wp)) break; legs.push({ step: st, wp }); }
					if (legs.length) {
						const ms = Math.min(ST_SHORT_MAX_S * 1000, ST_SHORT_F * total, room);
						// (its first leg is the stretch (the start, the plan's first step): the candidate's first try)
						stNote(A, legs[0].step, legs[0].wp, pl, false);
						const c0 = stCands.get(`${A.id}|${edgeKey(legs[0].step)}`) || null;
						if (c0) c0.n--;
						if (stSend(slot, A, A.arrivals.reduce((m, x) => (x.tick < m.tick ? x : m), A.arrivals[0]), legs, ms, c0)) {
							slot.busy.short = true;
							// (EEAT_ST_N=short: the failed stretches get a child of their own next to it: slot 1, taken by this loop)
							if (ST_SHORT2 && !stSlots[1]) stSpawn(1);
							continue;
						}
					}
				}
			}
			if (!ST_GENERAL) continue;
			const bestC = stPickCand();
			if (!bestC) {
				// (THE SHARED SESSION: no stretch of the executor's waits: the one shot's far leg)
				if (OS_BW_ST && osBwReq && stSendOs(slot)) continue;
				return;
			}
			stLastOs = false;
			// (THE REST OF A SHORT PLAN: the anchor's plan through this stretch has at most ST_SHORT steps: its legs in order on
			// one clock, ST_MS a leg, from its first arrival (the whole-level request's rule from the frontier); EEAT_ST_CHAIN=0:
			// the stretch alone)
			let legs = [{ step: bestC.step, wp: bestC.wp }];
			if (ST_CHAIN && ST_SHORT > 1) {
				let pl = null;
				try { const p = planOfAnchor(bestC.A); pl = p && p.plans ? p.plans.find((x) => x.steps && x.steps[0] && edgeKey(x.steps[0]) === edgeKey(bestC.step)) : null; } catch (e) { pl = null; }
				if (pl && pl.steps.length > 1 && pl.steps.length <= ST_SHORT) {
					const more = [];
					for (const st of pl.steps.slice(1)) { const wp = st.waypoint || { kind: 'trophy', label: 'trophy' }; if (!stOkWp(st, wp)) break; more.push({ step: st, wp }); }
					legs = legs.concat(more);
				}
			}
			const ms = Math.min(ST_MS * legs.length * (1 << bestC.tries), room);
			const a = bestC.A.arrivals.reduce((m, x) => (x.tick < m.tick ? x : m), bestC.A.arrivals[0]);
			stSend(slot, bestC.A, a, legs, ms, bestC);
		}
	};

	// ---- control: stdin lines
	let stopped = false, end = '', imports = 0;
	const onLine = (line) => {
		const s = String(line).trim();
		if (!s) return;
		const sp = s.indexOf(' '), cmd = sp < 0 ? s : s.slice(0, sp), arg = sp < 0 ? '' : s.slice(sp + 1).trim();
		if (cmd === 'stop') stopped = true;
		else if (cmd === 'depth' && +arg > 0) tickBound = Math.min(tickBound, +arg);
		else if ((cmd === 'steer' || cmd === 'steerd') && arg) loadSteer(arg);
		else if (cmd === 'route' && /^[0-O]+$/.test(arg)) {
			// (a known route: its run ticks bound the B&B; not a route of this search)
			const ev = C.evaluate(L, T.masksOf(arg), false);
			if (ev && ev.runTicks < extBound) { extBound = ev.runTicks; say({ ev: 'bound', runTicks: ev.runTicks, from: 'route' }); }
		} else if (cmd === 'import' && /^[0-O]+$/.test(arg)) {
			// (a state of another search: replayed; a model state not seen yet is an anchor)
			try {
				const masks = T.masksOf(arg);
				const r = replay(masks, null, true);
				if (!r.sim.is_dead && !r.sim.has_silver_crown) {
					const a = Object.assign(T.arrivalOf(L, r.sim, masks, RM), { run: r.run, leg: addLeg({ label: 'import', fromTick: 0, ticks: masks.length, lb: null, proven: false, tool: 'import', prev: null }) });
					const res = addArrival(a, model.stateOf(r.sim), null, cmd);
					if (res.isNew) { imports++; say({ ev: 'import', anchor: res.anchor.id, key: res.anchor.key, tick: a.tick }); }
				}
			} catch (e) { say({ ev: 'warning', text: `${cmd}: ${e.message}` }); }
		}
	};
	if (opts.stdinLines) {
		(async () => { try { for await (const line of opts.stdinLines) onLine(line); } catch (e) { /* closed */ } if (opts.stopOnStdinEnd) stopped = true; })();
	}

	// ---- the no-stall bookkeeping
	const tried = new Map();   // `${edge}|${nodeClass}|${rung}|${epoch}` -> {ok}
	const localBlock = new Set();   // `${anchor.key}|${edge}|${nodeClass}`: blocked here (a part's bug)
	let epoch = 0, mult = 1, deepenings = 0, stalls = 0, lastSteps = [], lastFails = [], bugs = 0, nothingSince = -1;
	const inflight = new Map();   // edgeKey -> {promise, job, started, budgetMs}
	let cur = null;   // the last plan (the page's line)
	const bug = (what, o) => { bugs++; say(Object.assign({ ev: 'bug', what }, o || {})); };
	const anchorArg = (A) => ({ arrival: A.arrivals[0], arrivals: A.arrivals, S: A.S, key: A.key, tick: A.firstTick, run: runMinOf(A), qual: A.qual || null, via: A.edgeVia || null });
	/** an anchor that cannot lead to a route that beats the bounds: every arrival's run ticks already at the B&B bound, or
	 *  its ticks at the depth bound (proofs: a route through it is at least that long) */
	const uselessA = (A) => {
		const rb = runBound();
		return A.arrivals.every((a) => a.tick >= tickBound || (a.run > 0 && a.run >= rb));
	};
	/** an arrival's admissible run ticks to the trophy (the planner's lowerBound from it alone, a short search: its open
	 *  list's least f when cut; cached by the state) */
	const arrLbCache = new Map();
	const arrLB = (A, a) => {
		let v = arrLbCache.get(a.hash);
		if (v !== undefined) return v;
		v = 0;
		try {
			if (planner.lowerBound && !lbSlow) {
				const tq = Date.now();
				v = lbTicks(planner.lowerBound({ arrival: a, arrivals: [a], S: A.S, key: A.key, tick: a.tick, run: a.run }, { ms: ARR_LB_MS, maxExpand: ARR_LB_EXPAND }));
				if (Date.now() - tq >= LB_SLOW_MS) { lbSlow = true; say({ ev: 'warning', text: `the planner's lowerBound from an arrival took ${((Date.now() - tq) / 1000).toFixed(1)} s (asked ${ARR_LB_MS} ms): not called again this compile` }); }
			}
		} catch (e) { v = 0; }
		arrLbCache.set(a.hash, v);
		return v;
	};
	/** branch and bound on the arrivals: an arrival whose run ticks + its admissible bound reach the B&B bound (or whose
	 *  ticks the depth bound) is dropped from its anchor: no route through it can beat the best (a proof) */
	const pruneArrivals = (A) => {
		const rb = runBound();
		if (!Number.isFinite(rb) && !Number.isFinite(tickBound)) return;
		const keep = A.arrivals.filter((a) => !(a.tick >= tickBound || (a.run > 0 && a.run >= rb) || (Number.isFinite(rb) && (a.run > 0 ? a.run : 0) + arrLB(A, a) >= rb)));
		if (keep.length < A.arrivals.length) { bnbArrivals += A.arrivals.length - keep.length; A.arrivals = keep; }
	};
	/** the planner's depth for anchor A: its plan search drops a node whose tick (the anchor arrival's) + lb reaches it, so
	 *  the run-tick bound goes in as rb + the arrival's timer start; sound only where every arrival is on the planner's
	 *  tile with its timer running (the lb is the planner's from arrivals[0]'s tile): else none (Infinity) */
	const depthOf = (A) => {
		const a0 = A.arrivals[0], rb = runBound();
		const alike = A.arrivals.every((a) => a.tile === a0.tile && a.run > 0);
		const d = alike && Number.isFinite(rb) ? rb + (a0.tick - a0.run) : Infinity;
		return Math.min(d, Number.isFinite(tickBound) ? tickBound + 1 : Infinity);
	};
	const planOfAnchor = (A) => {
		// (the plan memo's version: the facts', and the planner's floors (an async floor probe's answer re-plans))
		const v = factsVer(facts) + floorVerOf() * 1e9;
		if (A.plans && A.planVer === v && A.planEpoch === epoch && A.planBound === runBound()) return A.plans;
		const rb = runBound();
		pruneArrivals(A);
		if (!A.arrivals.length) { const p0 = { plans: [], why: `bound: no arrival can beat ${num(rb)} run ticks` }; A.plans = p0; A.planVer = v; A.planEpoch = epoch; A.planBound = rb; A.costEst = Infinity; A.costVer = v; return p0; }
		const runMin = runMinOf(A);
		let r;
		// (the plan's own budget: the planner's default (2 s first, 0.3 s after) within a quarter of the time left; a call that
		// overran it by far is said once (a synchronous call cannot be cut here: the CLI's watchdog is the backstop))
		// (a plan cut by its budget ('budget': no proof of anything) doubles the anchor's next budget, up to 16x)
		// (the first plan's 2 s is the anchor's FIRST plan's: every step sets A.plans = null (the receding horizon), and a level
		// that has only its start anchor re-planned with the first plan's 2 s after every step, synchronously, in the thread
		// that dispatches the workers' steps and takes their answers: the moves stage's workers were idle 12-67% of their time
		// on big levels (Moving Ice Puzzle 67%, Unforgiving Climb 34%, The Glitch 34%: every re-plan a 2.0-s gap in the event
		// log, the workers' answers waiting in it). EEAT_REPLAN_FIRST=1: the rule before)
		const firstPlan = REPLAN_FIRST ? !A.plans : !A.planned;
		const planMs = Math.max(100, Math.min((firstPlan && anchors.size <= 1 ? 2000 : 300) * (1 << Math.min(4, A.budgetCuts || 0)), (left() - (best ? endRes() : 0)) / 4));
		A.planned = true;
		const tp = Date.now();
		try { r = planner.plan(anchorArg(A), { k: 3, depth: depthOf(A), runBound: rb, tickBound, epoch, ms: planMs }); } catch (e) { bug('plan', { error: e.message, anchor: A.id }); r = { plans: [], why: `error: ${e.message}` }; }
		const tpMs = Date.now() - tp;
		if (tpMs > 3 * planMs + 1000 && !planSlowSaid) { planSlowSaid = true; say({ ev: 'warning', text: `the planner's plan() took ${(tpMs / 1000).toFixed(1)} s (asked ${(planMs / 1000).toFixed(1)} s): a synchronous overrun the loop cannot cut` }); }
		const p = plansOf(r);
		// (branch and bound: a plan whose admissible lb from this anchor cannot beat the bound is not run: a proof. Only
		// where every arrival's run timer runs (before the first input idle ticks are free) and every arrival is on the
		// planner's tile (its lb is from arrivals[0]'s tile))
		if (Number.isFinite(rb) && startedOf(A) && A.arrivals.every((a) => a.tile === A.arrivals[0].tile)) {
			const n0 = p.plans.length;
			p.plans = p.plans.filter((q) => !(Number.isFinite(+q.lb) && runMin + +q.lb >= rb));
			if (p.plans.length < n0) { bnbPlans += n0 - p.plans.length; if (!p.plans.length) p.why = `bound: no plan can beat ${num(rb)} run ticks (lb)`; }
		}
		A.plans = p; A.planVer = v; A.planEpoch = epoch; A.planBound = rb;
		A.costEst = p.plans.length ? +p.plans[0].cost || 0 : Infinity; A.costVer = v;
		return p;
	};
	const scoreOf = (A, N) => (Number.isFinite(A.costEst) ? A.costEst : 1e7) + A.firstTick + FAIL_TICKS * A.fails - UCB_C * Math.sqrt(Math.log(N + 1) / (1 + A.picks));
	/** the next job: {anchor, plan, step} not in flight, or null (none: every anchor exhausted or busy) */
	const nextJob = () => {
		const N = picksN + 1;
		const open = [...anchors.values()].filter((A) => !A.exhausted);
		for (const A of open) if (uselessA(A)) { A.exhausted = true; A.why = 'bound'; }
		const live = open.filter((A) => !A.exhausted);
		// (an anchor never planned (the start, an import, a new state): planned once for its cost)
		// (an empty plan list cut by the planner's budget is no proof: the anchor stays open and replans with twice the budget)
		const budgetCut = (A, why) => { if (why !== 'budget' || (A.budgetCuts || 0) >= 4) return false; A.budgetCuts = (A.budgetCuts || 0) + 1; A.planVer = -1; return true; };
		for (const A of live) if (A.costVer < 0 && !Number.isFinite(A.costEst)) { const p = planOfAnchor(A); if (!p.plans.length && !budgetCut(A, p.why)) { A.exhausted = true; A.why = p.why || 'exhausted'; } }
		// (the most progress first, then the lowest plan cost + the arrival tick; THE TIMER (planner.js, EEAT_PLAN_TIMER=1): an
		// anchor with no plan in its timed killer's time and no remover in time (a LATE anchor) after the others, whatever its gain)
		const lateOf = (A) => (TIMER_PICK && A.plans && A.plans.late ? 1 : 0);
		if (CRUMB_RANK === 3) crumbGate(live);
		const list = live.filter((A) => !A.exhausted).sort((a, b) => (lateOf(a) - lateOf(b)) || (pickGain(b) - pickGain(a)) || (scoreOf(a, N) - scoreOf(b, N)));
		for (const A of list) {
			if (left() < 200 || stopped) return null;
			const { plans, why } = planOfAnchor(A);
			if (!plans.length) { if (!budgetCut(A, why)) { A.exhausted = true; A.why = why || 'exhausted'; } continue; }
			for (const plan of breadthOrder(plans)) {
				const step = plan.steps[0];
				const ek = edgeKey(step);
				if (inflight.has(ek) || localBlock.has(`${A.key}|${ek}`)) continue;
				const tk = `${ek}|${step.rung}|${epoch}`;
				if (tried.has(tk)) {
					// (a triple already run in this epoch: the planner proposes it again; blocked here so it never runs twice: a
					// failed one is the planner's bug (a failure must change its plan), a done one just done for this epoch)
					localBlock.add(`${A.key}|${ek}`);
					if (!tried.get(tk).ok) bug('repeat', { edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, label: labelOf(step) });
					continue;
				}
				return { anchor: A, plan, step, plans };
			}
		}
		return null;
	};
	/** a step's budget: its rung's x 2^deepenings, capped by the time left (the polish's reserve kept once a route is known) */
	const budgetOf = (rung) => {
		const r = Math.max(0, Math.min(rungMs.length - 1, rung | 0));
		const room = left() - (best ? endRes() : 0) - 100;
		const ms = Math.max(50, Math.min(rungMs[r] * mult, room));
		const deadline = Date.now() + ms;
		// (fast: before the first route a found leg's tightening is capped by the time it took to find it: executor.js RATE_ON)
		return { ms, level: r, k: ARRIVALS_K, deadline, fast: !best, stop: () => stopped || left() <= 0 || Date.now() > deadline + 2000 };
	};
	/** the waypoint a step runs to: its own, with beforeTick filled from beforeTickFrom (ticks after the earliest start) */
	const waypointOf = (step, A) => {
		const wp = step.waypoint || { kind: 'trophy', label: 'trophy' };
		const rel = relOf(step.beforeTickFrom !== undefined ? step.beforeTickFrom : wp.beforeTickFrom);
		if (!Number.isFinite(rel)) return wp;
		// (per start its own deadline, its arrival tick + rel (the previous step's arrival: the key's touch); the executor
		// gets the latest, and the verify holds each arrival to its own start's)
		const t = A.arrivals.reduce((m, a) => Math.max(m, a.tick), -Infinity);
		return Object.assign({}, wp, { beforeTick: t + rel, beforeRel: rel });
	};
	/** which of the starts an arrival grew from: the result's leg for it (legs[i].start), else the longest start whose masks
	 *  begin it */
	const startOf = (starts, a, i, res) => {
		const lg = Array.isArray(res.legs) ? res.legs[i] : null;
		if (lg && Number.isInteger(lg.start) && starts[lg.start]) return { s: starts[lg.start], lg };
		let s = null;
		for (const x of starts) {
			if (x.masks.length > a.length || (s && x.masks.length <= s.masks.length)) continue;
			let ok = true;
			for (let t = 0; t < x.masks.length; t++) if ((x.masks[t] & 31) !== (a[t] & 31)) { ok = false; break; }
			if (ok) s = x;
		}
		return { s, lg };
	};
	/** a StepResult's arrivals checked here (replayed from the level start, the goal test (and its beforeTick), alive at the
	 *  end): the verified ones, each with its run ticks and its leg; routes (a finish) go to routeOf */
	const verified = (step, wp, res, starts) => {
		const out2 = [], routes = [];
		if (!res || !res.ok || !Array.isArray(res.arrivals)) return { arr: out2, routes };
		const trophy = wp.kind === 'trophy';
		const goal = trophy ? null : T.goalOf(L, wp);
		const rb = runBound();
		res.arrivals.forEach((a, i) => {
			if (!a || !a.masks) return;
			const masks = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			const { s, lg } = startOf(starts, masks, i, res);
			const leg = addLeg({ label: labelOf(step), fromTick: s ? s.tick : 0, ticks: masks.length - (s ? s.tick : 0), lb: lg && Number.isFinite(+lg.lb) ? +lg.lb : Number.isFinite(+res.lb) ? +res.lb : null,
				proven: !!(lg && lg.proven), provenBy: (lg && lg.provenBy) || null, lbMath: lg && Number.isFinite(+lg.lbMath) && lg.lbMath !== null ? +lg.lbMath : null, tool: (lg && lg.tool) || res.tool || null, prev: s && s.leg ? s.leg : null });
			const r = replay(masks, goal, !!(goal && goal.allowDeath) || !!res.deathLeg, s ? s.tick : 0);
			if (r.finished > 0) { routes.push({ masks: masks.subarray(0, r.finished), leg }); return; }
			if (trophy) { bug('arrival', { label: labelOf(step), tick: masks.length, why: 'a trophy arrival that does not finish on its replay' }); return; }
			if (r.goalAt < 0 || r.sim.is_dead) { bug('arrival', { label: labelOf(step), tick: masks.length, why: r.goalAt < 0 ? 'the goal test never holds on its replay' : 'dead at its end' }); return; }
			// (beforeTick: a relative one (beforeTickFrom) is each start's own, the executor had the latest: late ones dropped
			// quietly; an absolute one past its tick is the executor's bug)
			if (Number.isFinite(+wp.beforeRel) && s && r.goalAt > s.tick + +wp.beforeRel) { lateArrivals++; return; }
			if (!Number.isFinite(+wp.beforeRel) && Number.isFinite(+wp.beforeTick) && r.goalAt > +wp.beforeTick) { bug('arrival', { label: labelOf(step), tick: masks.length, why: `the goal holds at tick ${r.goalAt}, past its beforeTick ${wp.beforeTick}` }); return; }
			// (no route through it can beat the bounds: a proof, it is at least that long already)
			if (masks.length >= tickBound || (r.run > 0 && r.run >= rb)) { bnbArrivals++; return; }
			out2.push(Object.assign(T.arrivalOf(L, r.sim, masks, RM), { run: r.run, leg }));
		});
		return { arr: out2, routes };
	};
	const learnFrom = (step, res, A) => {
		let fs2 = [];
		if (step.synthetic) return fs2;
		try { fs2 = planner.learn(step, res, anchorArg(A)) || []; } catch (e) { bug('learn', { error: e.message, label: labelOf(step) }); }
		for (const f of fs2) say({ ev: 'fact', kind: f.kind || f.type || '?', edge: f.edge !== undefined ? f.edge : step.edge, rung: f.rung !== undefined ? f.rung : step.rung, why: f.why });
		return fs2;
	};
	const failOf = (res, budget) => (res && res.fail) || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level };
	// ---- THE LEG TRANSPLANT (n5 doctor b9; OPT-IN EEAT_PLAN_TRANSPLANT=1, else as before): the anchors of a level of
	// independent sub-goals diverge into lineages (Bad EE Level 9, 600 s: {1,2,4}+5 and {1,2,3,4}+5), and every lineage
	// searches the same mini again from scratch (switch 5's ladder mini found 4 times, 121 of its 271 worker-s, each at
	// rung 2-3). Every verified leg of a trigger step (its arrival's inputs past its start) is kept per edge (the newest
	// TP_LEGS); a later step of that edge first REPLAYS the kept legs from each of its starts (the engine, the waypoint's own
	// goal test each tick): a leg that meets the goal is the step's arrival (verified again like any executor arrival, from
	// the level start), and the executor is not called. Offline on that 600-s run: 5 of 21 (anchor, leg) pairs met the goal
	// as they stand (switch 5's leg from 3 other anchors, switch 6's from 2). Exact (every arrival the engine's replay);
	// ~a few thousand ticks a step
	const TRANSPLANT = process.env.EEAT_PLAN_TRANSPLANT === '1';
	const TP_LEGS = 6, TP_MAX = 4000;
	const legLib = new Map();   // step.edge -> [leg mask strings], newest first
	let tpHits = 0, tpTries = 0;
	const tpSim = new E.EESim(L), tpInp = new E.EEInput();
	const tpOk = (wp) => wp && wp.kind === 'trigger' && !wp.allowDeath && !(Number.isFinite(+wp.beforeTick)) && wp.beforeRel === undefined;
	const libAdd = (step, wp, arr, starts, res) => {
		if (!tpOk(wp) || step.synthetic) return;
		arr.forEach((a, i) => {
			const masks = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			const { s } = startOf(starts, masks, i, res);
			if (!s || masks.length <= s.masks.length || masks.length - s.masks.length > TP_MAX) return;
			const leg = T.strOf(masks.subarray(s.masks.length));
			const list = legLib.get(step.edge) || [];
			if (list.includes(leg)) return;
			list.unshift(leg);
			if (list.length > TP_LEGS) list.length = TP_LEGS;
			legLib.set(step.edge, list);
		});
	};
	/** the kept legs of step's edge replayed from each start: a StepResult (ok, the arrivals) or null */
	const transplant = (step, wp, starts) => {
		if (!tpOk(wp) || step.synthetic) return null;
		const list = legLib.get(step.edge);
		if (!list || !list.length) return null;
		const t0 = Date.now();
		const goal = T.goalOf(L, wp);
		const out = [], legs = [];
		for (let si = 0; si < starts.length && out.length < ARRIVALS_K; si++) {
			const s = starts[si];
			for (const str of list) {
				if (out.length >= ARRIVALS_K) break;
				tpTries++;
				let ok = false;
				try { tpSim.reset(); tpSim.restore(s.snap); ok = !s.hash || tpSim.stateHash() === s.hash; } catch (e) { ok = false; }
				if (!ok) { const r = T.playTo(L, s.masks, { allowDeath: true }); tpSim.reset(); tpSim.restore(r.sim.snapshot()); }
				if (tpSim.is_dead) continue;
				const leg = T.masksOf(str);
				let hit = -1;
				for (let t = 0; t < leg.length; t++) {
					E.applyMask(tpInp, leg[t] & 31);
					tpSim.tick(tpInp);
					if (tpSim.is_dead && !goal.allowDeath) break;
					if (goal.test(tpSim)) { hit = t + 1; break; }
				}
				if (hit < 0) continue;
				const sm = s.masks instanceof Uint8Array ? s.masks : T.masksOf(String(s.masks));
				const masks = new Uint8Array(sm.length + hit);
				masks.set(sm, 0); masks.set(leg.subarray(0, hit), sm.length);
				if (out.some((x) => x.masks.length === masks.length && T.strOf(x.masks) === T.strOf(masks))) continue;
				out.push({ masks });
				legs.push({ start: si, ticks: hit, lb: null, proven: false, tool: 'transplant' });
			}
		}
		if (!out.length) return null;
		tpHits++;
		say({ ev: 'transplant', label: labelOf(step), edge: step.edge, arrivals: out.length, ms: Date.now() - t0, hits: tpHits, tries: tpTries });
		return { ok: true, arrivals: out, tool: 'transplant', ms: Date.now() - t0, legs, lb: null };
	};
	/** one job run: exec.reach, verify, learn, anchors; resolves when done */
	const runJob = async (job) => {
		const { anchor: A, step, plan } = job;
		const ek = edgeKey(step), tk = `${ek}|${step.rung}|${epoch}`;
		tried.set(tk, { ok: false });
		A.picks++; picksN++;
		const budget = budgetOf(windowRung(step));
		const wp = waypointOf(step, A);
		// (the plan's next waypoint: the executor ranks this step's arrivals by the next leg's cost from them, executor.js
		// NEXT_ON; a death step, a synthetic step or a plan of one step: none)
		const nx = !step.synthetic && Array.isArray(plan.steps) && plan.steps[0] === step && plan.steps[1] ? plan.steps[1] : null;
		const nwp = nx && !nx.synthetic ? (nx.waypoint || { kind: 'trophy', label: 'trophy' }) : null;
		if (nwp && !nwp.allowDeath && !wp.allowDeath && (nwp.kind === 'trophy' || (Array.isArray(nwp.tiles) || ArrayBuffer.isView(nwp.tiles)) && nwp.tiles.length)) budget.next = { kind: nwp.kind, tiles: nwp.kind === 'trophy' ? undefined : Array.from(nwp.tiles), expect: nwp.expect || null, label: nwp.label || '' };
		const starts = A.arrivals.slice();
		// (the relay start: this (anchor, edge)'s nearest state from its failed rungs, a start too: the next rung goes on from
		// the frontier the last one reached instead of only from the anchor; before a route only: no bound to keep)
		const rk = `${A.id}|${ek}`;
		const rl = RELAY ? relays.get(rk) : null;
		let rlUsed = false;
		if (rl && !Number.isFinite(runBound()) && rl.arrival.masks.length < tickBound && !starts.some((s) => s.hash === rl.arrival.hash)) { starts.push(rl.arrival); relayRuns++; rlUsed = true; }
		const t1 = Date.now();
		steps++;
		const verBefore = factsVer(facts), anchorsBefore = anchors.size;
		let res = TRANSPLANT ? transplant(step, wp, starts) : null;
		if (!res) {
			try { res = await exec.reach(starts, wp, budget); } catch (e) { res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: Object.assign(failOf(null, budget), { error: e.message }) }; bug('reach', { error: e.message, label: labelOf(step) }); }
		}
		if (!res) res = { ok: false, arrivals: [], tool: null, ms: Date.now() - t1, fail: failOf(null, budget) };
		const { arr, routes } = verified(step, wp, res, starts);
		const hadArrivals = res.ok && Array.isArray(res.arrivals) && res.arrivals.length > 0;
		if (res.ok && !arr.length && !routes.length) res = Object.assign({}, res, { ok: false, fail: failOf(res, budget), dropped: hadArrivals });
		else if (res.ok) res = Object.assign({}, res, { arrivals: arr });
		tried.get(tk).ok = !!res.ok;
		let news = 0, route = null;
		for (const r of routes) { const x = routeOf(r.masks, labelOf(step), r.leg); if (x && x.better) route = x.ev; }
		if (res.ok) {
			okSteps++;
			if (TRANSPLANT) libAdd(step, wp, arr, starts, res);
			for (const a of arr) {
				const sim = simOf(a);
				let S2;
				try { S2 = model.stateOf(sim); } catch (e) { bug('stateOf', { error: e.message }); continue; }
				A.nextCost = Number.isFinite(+plan.cost) && Number.isFinite(+step.estTicks) ? Math.max(0, plan.cost - step.estTicks) : undefined;
				const { anchor: B, isNew, changed } = addArrival(a, S2, A, labelOf(step), step);
				if (isNew) {
					news++;
					// (the one shot: the exact fallback's leg into its graph)
					if (os) { try { if (os.inject(a.masks, 'exec')) osInjected++; } catch (e) { /* the one shot's own */ } }
					else if (osw && osInject(a.masks, 'exec')) osInjected++;
					const d = distOf(sim);
					say({ ev: 'source', kind: 'room', room: a.room, desc: a.desc, key: B.key, gain: 1, tick: a.tick, ...(d !== undefined ? { dist: Math.round(d * 10) / 10 } : {}), inputs: T.strOf(a.masks), anchor: B.id, label: labelOf(step) });
					if (steer) say({ ev: 'closest', dist: Math.round(distOf(sim) * 10) / 10, tick: a.tick, inputs: T.strOf(a.masks), anchor: B.id });
				} else if (changed && step.synthetic) lastProgress = Date.now();
			}
		} else { A.fails++; failSteps++; }
		learnFrom(step, res, A);
		if (ST_ON) stNote(A, step, wp, plan, !!res.ok);
		const ms = Date.now() - t1;
		const fail = res.ok ? null : res.fail || null;
		// (a relay that got its rung no nearer by RELAY_GAIN tiles is dropped (a false near: the next rung from the anchor
		// alone), and a new one must beat it by as much)
		// (the executor's closest is in the unit of the goal field with the counterexample walls it had (fail.wallsN): a relay
		// and a floor of another unit are no measure of this one: replaced, not compared)
		const unitN = fail && fail.wallsN > 0 ? fail.wallsN | 0 : 0;
		if (RELAY && rlUsed && !res.ok) {
			const nd = fail && fail.closest && fail.closest.dist >= 0 ? fail.closest.dist : Infinity;
			if ((rl.wallsN | 0) === unitN && !(nd < rl.dist - RELAY_GAIN)) { relays.delete(rk); relayFloor.set(rk, { d: rl.dist - RELAY_GAIN, n: unitN }); relayDrop++; }
		}
		if (RELAY && fail && fail.closest && fail.closest.masks && !fail.closest.dead && fail.closest.dist >= 0 && !Number.isFinite(runBound())) {
			const prev0 = relays.get(rk);
			const prev = prev0 && (prev0.wallsN | 0) === unitN ? prev0 : null;
			const fl = relayFloor.get(rk);
			const floor = fl && fl.n === unitN ? fl.d : Infinity;
			if ((!prev || fail.closest.dist < prev.dist) && fail.closest.dist < floor) {
				const m = fail.closest.masks instanceof Uint8Array ? fail.closest.masks : T.masksOf(fail.closest.masks);
				const { s } = startOf(starts, m, -1, {});
				const r = replay(m, null, false, s ? s.tick : 0);
				const h = r.sim.stateHash();
				if (r.dead < 0 && !r.sim.is_dead && r.finished < 0 && !starts.some((x) => x.hash === h)) {
					const leg = addLeg({ label: `relay ${labelOf(step)}`, fromTick: s ? s.tick : 0, ticks: m.length - (s ? s.tick : 0), lb: null, proven: false, tool: 'relay', prev: s && s.leg ? s.leg : null });
					relays.set(rk, { arrival: Object.assign(T.arrivalOf(L, r.sim, m, RM), { run: r.run, leg, relay: true }), dist: fail.closest.dist, wallsN: unitN });
					relaySet++;
				}
			}
		}
		const rec = { ev: 'step', n: steps, anchor: A.id, label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, epoch, tool: res.tool || null, ok: !!res.ok, ms, budgetMs: Math.round(budget.ms),
			why: res.ok ? '' : (fail && fail.why) || '', arrivals: arr.length, news, routes: routes.length };
		if (fail && fail.closest) rec.closest = { tile: fail.closest.tile, dist: fail.closest.dist };
		if (FAR_TROPHY > 0 || FAR_WALK > 0) { rec.est = Number.isFinite(+step.estTicks) ? Math.round(+step.estTicks) : null; if (windowRung(step) !== step.rung) rec.farTrophy = windowRung(step); }
		// (the executor's exact end search from a near start, when it ran: tier 0b)
		const nearT = Array.isArray(res.tiers) ? res.tiers.find((x) => x && x.tier === 'near') : null;
		if (nearT) rec.near = { ok: nearT.ok, runs: nearT.runs, ms: nearT.ms, nearest: nearT.nearest };
		// (the move solver's tier, when it ran: EEAT_MSOLVE=1)
		const msT = Array.isArray(res.tiers) ? res.tiers.find((x) => x && x.tier === 'msolve') : null;
		if (msT) rec.msolve = { found: msT.found, legs: msT.legs, chains: msT.chains, expanded: msT.expanded, rejected: msT.rejected, ms: msT.ms, error: msT.error || undefined };
		// (EEAT_STEP_CLOSEST=1: the closest state's inputs too, for the near-miss diagnoses)
		if (fail && fail.closest && fail.closest.masks && process.env.EEAT_STEP_CLOSEST === '1') rec.closest.inputs = typeof fail.closest.masks === 'string' ? fail.closest.masks : T.strOf(fail.closest.masks);
		if (fail && Array.isArray(fail.blockedBy) && fail.blockedBy.length) rec.blockedBy = fail.blockedBy.slice(0, 4);
		say(rec);
		lastSteps.push({ n: steps, label: rec.label, rung: step.rung, ok: rec.ok, why: rec.why, ms, anchor: A.id });
		if (lastSteps.length > 8) lastSteps.shift();
		if (fail) { lastFails.push({ n: steps, label: rec.label, rung: step.rung, why: fail.why, closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [], touched: (fail.touched || []).length }); if (lastFails.length > 6) lastFails.shift(); }
		// (a trophy leg that ended within PREC_NEAR tiles of the trophy: the exact landing, above)
		if (fail && wp.kind === 'trophy' && fail.closest && !route) {
			if (PREC_ASYNC) precision(fail.closest).catch((e) => bug('precision', { error: e.message }));   // (in the background: EEAT_PREC_ASYNC)
			else {
				const pr = await precision(fail.closest);
				if (pr) route = pr;
			}
		}
		const verAfter = factsVer(facts);
		if (verAfter !== verBefore) lastProgress = Date.now();
		// (the invariant: every step adds an anchor or changes a fact; else the planner would propose it again: blocked here)
		if (!step.synthetic && anchors.size === anchorsBefore && verAfter === verBefore && !route) {
			localBlock.add(`${A.key}|${ek}`);
			bug('no progress', { label: labelOf(step), edge: step.edge, nodeClass: step.nodeClass, rung: step.rung, anchor: A.id, ok: !!res.ok });
		}
		A.plans = null;   // (plan again from here: receding horizon)
		cur = { plan, step, anchor: A.id, ok: rec.ok, depth: A.depth };
		return { route };
	};

	// ---- the stall watchdog's exploration steps: region waypoints on an anchor's unvisited walk frontier
	const frontierOf = (A) => {
		const W = L.width, H = L.height, N = W * H, fl = RF.guideFlags ? RF.guideFlags(L) : L.flags;
		const wall = (t) => { const id = L.fg[t]; return id > 0 && id < fl.length && (fl[id] & 1) !== 0 && (fl[id] & 16) === 0; };
		const t0a = A.arrivals[0].tile;
		const dist = new Int16Array(N).fill(-1), q = [t0a];
		dist[t0a] = 0;
		const front = [];
		for (let h = 0; h < q.length; h++) {
			const t = q[h], x = t % W, y = (t / W) | 0;
			if (!visited[t] && dist[t] >= 3) front.push(t);
			if (dist[t] >= FRONTIER_STEPS) continue;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const u = ny * W + nx;
				if (dist[u] >= 0 || wall(u)) continue;
				dist[u] = dist[t] + 1; q.push(u);
			}
		}
		// (the farthest first: the frontier being pushed)
		front.sort((a, b) => dist[b] - dist[a]);
		return front.slice(0, FRONTIER_MAX);
	};
	let exploreTurn = 0, exploreSeq = 0;
	const exploreJob = () => {
		const list = [...anchors.values()].filter((A) => !uselessA(A));
		for (let i = 0; i < list.length; i++) {
			const A = list[(exploreTurn + i) % list.length];
			const tiles = frontierOf(A);
			if (!tiles.length) continue;
			exploreTurn += i + 1;
			const step = { n: 0, edge: `explore:${A.key}:${++exploreSeq}`, nodeClass: `x${A.key}`, rung: Math.min(3, Math.max(0, stalls - 1)), synthetic: true, estTicks: 0,
				waypoint: { kind: 'region', tiles, expect: null, label: `explore ${tiles.length} tiles` } };
			return { anchor: A, plan: { id: 'explore', steps: [step], cost: 0, partial: true, why: 'stall' }, step };
		}
		return null;
	};
	const exploreQ = [];
	/** the fallbacks when the planner has nothing left and time remains (at most FALLBACK_MAX without a new anchor): from
	 *  the anchor of the most progress a direct trophy step (the executor's exact tiers derive the whole way), its rung
	 *  rising each time, then an exploration step on its unvisited frontier; never the same triple twice */
	let fallbacks = 0, fallbackAnchors = -1;
	const fallbackJob = () => {
		if (anchors.size !== fallbackAnchors) { fallbackAnchors = anchors.size; fallbacks = 0; }
		if (fallbacks >= FALLBACK_MAX || stopped || left() < 1000) return null;
		const fbList = [...anchors.values()].filter((A) => A.arrivals.length && !uselessA(A));
		if (CRUMB_RANK === 3) crumbGate(fbList);
		const list = fbList.sort((a, b) => pickGain(b) - pickGain(a) || a.firstTick - b.firstTick);
		for (const A of list) {
			for (let r = 0; r < rungMs.length; r++) {
				const step = { n: 0, edge: `fallback:trophy:${A.key}`, nodeClass: `f${A.key}`, rung: r, synthetic: true, fallback: true, estTicks: 0, waypoint: { kind: 'trophy', label: 'trophy (fallback: no plan left)' } };
				if (tried.has(`${edgeKey(step)}|${r}|${epoch}`)) continue;
				fallbacks++;
				say({ ev: 'fallback', kind: 'trophy', anchor: A.id, rung: r, why: A.why || 'no plan' });
				return { anchor: A, plan: { id: 'fallback', steps: [step], cost: 0, partial: true, why: 'fallback' }, step };
			}
		}
		const j = exploreJob();
		if (j) { fallbacks++; say({ ev: 'fallback', kind: 'explore', anchor: j.anchor.id, rung: j.step.rung }); }
		return j;
	};
	const deepen = (why) => {
		if (deepenings >= maxDeepen || rungMs[0] * mult * 2 > left() - (best ? endRes() : 0)) return false;
		deepenings++; epoch++; mult *= 2;
		try { if (facts && typeof facts.reset === 'function') facts.reset({ keepProofs: true, boost: 2 }); } catch (e) { bug('reset', { error: e.message }); }
		for (const A of anchors.values()) { if (A.why !== 'bound') { A.exhausted = false; A.why = ''; } A.plans = null; }
		localBlock.clear();
		say({ ev: 'deepen', why, n: deepenings, mult, anchors: anchors.size });
		lastProgress = Date.now();
		return true;
	};

	// ---- progress, the watchdog and the files
	const pct = (x) => `${Math.round(x * 1000) / 10}%`;
	const detail = () => {
		const pl = cur && cur.plan, st = cur && cur.step;
		const run = [...inflight.values()][0];
		const js = run ? run.job : null;
		const step = js ? js.step : st, dep = js ? js.anchor.depth : cur ? cur.depth : 0, plan = js ? js.plan : pl;
		const where = step ? `step ${dep + 1}/${dep + (plan && Array.isArray(plan.steps) ? plan.steps.length : 1)} '${labelOf(step)}' rung ${step.rung | 0}${js ? (step.synthetic ? ' (explore)' : '') : cur && cur.ok !== null ? cur.ok ? ' (ok)' : ' (failed)' : ''}` : 'planning';
		const rt = best ? ` · route ${num(best.runTicks)} (lb ${num(LB)}, gap ${best.runTicks > 0 ? pct(Math.max(0, best.runTicks - LB) / best.runTicks) : '0%'})` : LB ? ` · lb ${num(LB)}` : '';
		return `plan: ${where} · ${anchors.size} anchor${anchors.size === 1 ? '' : 's'}${rt}`;
	};
	const factsCount = () => { try { const s = planner.stats ? planner.stats() : null; if (s && Number.isFinite(+s.facts)) return +s.facts; } catch (e) { /* none */ } return factsVer(facts); };
	const progress = () => {
		const maxTick = Math.max(0, ...[...anchors.values()].map((A) => A.firstTick));
		say({ ev: 'progress', states: anchors.size, rooms: anchors.size, anchors: anchors.size, triggers: Math.max(0, ...[...anchors.values()].map((A) => A.gain)), steps, okSteps, facts: factsCount(), sec: Math.round(secNow() * 10) / 10,
			workers, layer: maxTick, tick: maxTick, ticksPerSec: 0, imports, bugs, deepenings, stalls, exhausted: [...anchors.values()].filter((A) => A.exhausted).length,
			...(best ? { runTicks: best.runTicks, lb: LB, gap: gapOf(best.runTicks) } : { lb: LB }), detail: detail() });
	};
	const saveFiles = () => {
		if (!out) return;
		flushEvents();
		try {
			const fj = facts && typeof facts.toJSON === 'function' ? facts.toJSON() : planner.stats ? planner.stats() : { version: factsVer(facts) };
			fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(fj, null, 1));
			fs.writeFileSync(path.join(out, 'anchors.json'), JSON.stringify([...anchors.values()].map((A) => ({ id: A.id, key: A.key, via: A.via, parent: A.parent, depth: A.depth, firstTick: A.firstTick, picks: A.picks, fails: A.fails,
				exhausted: A.exhausted, why: A.why, gain: A.gain, cost: Number.isFinite(A.costEst) ? A.costEst : null, arrivals: A.arrivals.map((a) => ({ tick: a.tick, run: a.run, tile: a.tile, vx: a.vx, vy: a.vy, room: a.room, desc: a.desc })) })), null, 1));
		} catch (e) { /* read-only */ }
	};
	/** WHY the search is where it is: the last steps, their fail reports, the planner's explanation, the most progress */
	const whyNow = () => {
		let ex = '';
		try { ex = planner.explain ? String(planner.explain() || '') : ''; } catch (e) { ex = `explain: ${e.message}`; }
		const top = [...anchors.values()].sort((a, b) => b.gain - a.gain || a.firstTick - b.firstTick)[0];
		const fails = lastFails.slice(-3).map((f) => `'${f.label}' rung ${f.rung}: ${f.why}${f.closest ? ` (closest ${f.closest.dist} tiles at tile ${f.closest.tile})` : ''}${f.blockedBy.length ? ` blocked by ${f.blockedBy.map((b) => b.feat).join(', ')}` : ''}`);
		return { steps: lastSteps.slice(), fails: lastFails.slice(), explain: ex.slice(0, 2000), text: `${anchors.size} anchors, the most progress: anchor ${top ? `${top.id} (gain ${top.gain}, tick ${top.firstTick}, ${top.exhausted ? `exhausted: ${top.why}` : 'open'})` : '-'}` +
			`${fails.length ? `; last failures: ${fails.join('; ')}` : ''}${ex ? `; planner: ${ex.slice(0, 400)}` : ''}` };
	};
	const watchdog = () => {
		const now = Date.now();
		// (a long step inside its budget is working: no stall while one runs; steps that come and go without progress are it)
		const busy = [...inflight.values()].some((f) => now - f.started >= 1000 && now - f.started < f.budgetMs + 5000);
		const v = factsVer(facts);
		if (v !== progressVer) { progressVer = v; lastProgress = now; }
		if (busy) return;
		if (now - lastProgress >= stallWindow) {
			stalls++;
			let fsum = null;
			try { fsum = planner.stats ? planner.stats() : null; } catch (e) { /* none */ }
			const w = whyNow();
			say({ ev: 'stall', why: `no new state and no fact changed for ${Math.round((now - lastProgress) / 1000)} s: ${w.text}`, n: stalls, lastSteps: w.steps, fails: w.fails, explain: w.explain, anchors: anchors.size,
				exhausted: [...anchors.values()].filter((A) => A.exhausted).length, facts: fsum });
			if (stalls === 1) deepen('stall');
			else { const j = exploreJob(); if (j) exploreQ.push(j); }
			lastProgress = now;
			if (osw && !best && !osWantOpen) osWantOpen = 'stall';   // (the one shot's gate: opened at the loop's next turn)
			if (!best) bwcRelease('stall');   // (the chain's gate: EEAT_BW_CHAIN)
			if (BW_LEVEL && bwlDone && !bwlOpen && !best && !bwlWant) bwlWant = 'stall';   // (the child's gate, the same)
		}
	};
	const timers = [setInterval(progress, progressMs), setInterval(watchdog, watchMs), setInterval(saveFiles, SAVE_MS)];
	for (const tt of timers) if (tt.unref) tt.unref();
	const stallEnd = +opts.stallS > 0 ? +opts.stallS * 1000 : 0;
	let progressAt = Date.now();   // (the last real progress: a new anchor or a route, for --stallS)
	let anchorsSeen = anchors.size, bestSeen = null;

	// ---- PLAN: the first plan from the start (its time is the plan stage's)
	tm = Date.now();
	{
		const A = anchors.get(String(S0.key));
		const p = planOfAnchor(A);
		const pl = p.plans[0];
		stage('plan', Date.now() - tm, pl ? `${pl.steps.length} step${pl.steps.length === 1 ? '' : 's'}: ${pl.steps.slice(0, 6).map(labelOf).join(' -> ')}${pl.steps.length > 6 ? ' -> ...' : ''}${Number.isFinite(+pl.cost) ? ` (est ${num(+pl.cost)} ticks)` : ''}` : `no plan: ${p.why || 'exhausted'}`);
		if (pl) say({ ev: 'plan', anchor: A.id, steps: pl.steps.map(labelOf), cost: pl.cost, lb: pl.lb, partial: !!pl.partial, why: pl.why || '', rung: pl.steps[0].rung, first: true });
	}

	// ---- the one shot's harvest (OS_ON): its route, and the first node of every abstract state it reached as an anchor
	let os = null, osDone = false, osBestT = Infinity, osAnchors = 0, osInjected = 0;
	const osSeen = new Map();   // abstract state key -> the ticks of the one shot's arrival taken
	/** a route of the one shot (masks from the level start): verified by routeOf, the best when faster */
	const osRoute = (masks, ticks) => {
		if (!(ticks < osBestT)) return;
		osBestT = ticks;
		const lid = addLeg({ label: 'the one shot', fromTick: 0, ticks: masks.length, lb: null, proven: false, tool: 'oneshot', prev: null });
		routeOf(masks, 'the one shot', lid);
	};
	/** the first node of an abstract state the one shot reached: replayed, an anchor (addArrival) */
	const osArrival = (key, masks) => {
		// (a state seen before only again with a sooner arrival: the thread sends one when its A* finds it)
		const had = osSeen.get(key);
		if (had !== undefined && !(masks.length < had)) return;
		osSeen.set(key, masks.length);
		if (!masks.length) return;
		const r = replay(masks, null, false);
		if (r.dead >= 0 || r.finished >= 0) return;
		const a = Object.assign(T.arrivalOf(L, r.sim, masks, RM), { run: r.run, leg: addLeg({ label: 'the one shot', fromTick: 0, ticks: masks.length, lb: null, proven: false, tool: 'oneshot', prev: null }) });
		let S2;
		try { S2 = model.stateOf(r.sim); } catch (e) { return; }
		const res = addArrival(a, S2, anchors.get(String(S0.key)), 'the one shot');
		if (res.isNew) { osAnchors++; say({ ev: 'source', kind: 'room', room: a.room, desc: a.desc, key: res.anchor.key, gain: 1, tick: a.tick, inputs: T.strOf(a.masks), anchor: res.anchor.id, label: 'the one shot' }); }
	};
	const osHarvest = () => {
		if (osw) {
			// (the gate: the watchdog saw a stall with no route)
			if (osWantOpen && !osOpen && !best) osRelease(osWantOpen);
			// (the thread's messages: its routes at once, its arrivals OS_DRAIN_MAX a turn)
			let n = 0;
			const q = osQ.splice(0, osQ.length), keep = [];
			for (const m of q) {
				if (m.type === 'route') osRoute(T.masksOf(m.masks), m.ticks);
				else if (!osOpen) { const k = String(m.key), had = osPending.get(k); if (!had || m.masks.length < had.length) osPending.set(k, m.masks); }
				else if (n < OS_DRAIN_MAX) { n++; osArrival(String(m.key), T.masksOf(m.masks)); }
				else keep.push(m);
			}
			for (const m of keep) osQ.push(m);
			return;
		}
		if (!os) return;
		const b = os.best();
		if (b && b.masks && b.kind !== 'inj') osRoute(b.masks, b.ticks);
		for (const x of os.arrivals()) osArrival(x.key, x.masks);
	};
	/** the gate opens (the executor stalled or has nothing left, no route): the held arrivals go to it (addArrival), and
	 *  every later one as it comes */
	const osRelease = (why) => {
		if (!osw || osOpen) return;
		osOpen = true;
		const n0 = anchors.size;
		for (const [k, s] of osPending) osArrival(k, T.masksOf(s));
		osReleased = osPending.size;
		osPending.clear();
		say({ ev: 'oneshot', what: 'gate', why, arrivals: osReleased, anchors: anchors.size - n0 });
	};
	/** the executor has nothing left to run and would end: while the one shot's thread still searches (no route yet, time
	 *  left) the loop waits a turn for its anchors / route instead (-> true: go on) */
	const osHold = async () => {
		if (!osw || best || stopped) return false;
		const n0 = anchors.size;
		osRelease('the executor has nothing left');
		if (anchors.size !== n0) { nothingSince = -1; return true; }   // (the held arrivals: new anchors, the planner's jobs again)
		if (osThreadDone || osErr || left() <= 1000) return false;
		await new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
		osHarvest();
		if (anchors.size !== n0) nothingSince = -1;   // (new anchors: the planner's jobs again)
		return true;
	};

	// ---- MOVES: the parts that move (the primitives, the executor), then the loop
	const tMoves = Date.now();
	try {
		if (parts.createPrims) {
			try { prims = await parts.createPrims(L, { file: opts.file, bounds, model, workers }); } catch (e) { prims = null; say({ ev: 'warning', text: `the motion primitives could not start (${e.message}): the executor without them` }); }
		}
		exec = await parts.createExecutor(L, { file: opts.file, workers, prims, bounds, model, RM, emit: say, seed: opts.seed, gpu: null });
	} catch (e) {
		for (const tt of timers) clearInterval(tt);
		try { if (prims && prims.close) await prims.close(); } catch (e2) { /* closed */ }
		throw e;
	}
	say({ ev: 'start', triggers: nTrig, feats: nFeat, workers, inflight: P, prims: !!prims, bounds: !!bounds, lb: LB, seconds, partsMs: Date.now() - tMoves });
	// ---- THE ONE SHOT (EEAT_ONESHOT=1): the moves' first tier (OS_ON above); in its thread (osw) it runs already: its
	// messages so far harvested here and at every turn of the loop
	if (osw) osHarvest();
	else if (OS_ON) {
		const tO = Date.now();
		try {
			const OSM = require('./oneshot/solve.js');
			let graph = null;
			if (process.env.EEAT_OS_GRAPH === '1') {
				try {
					const EG = require('./oneshot/edges.js');
					const g = await EG.buildGraph(opts.file || L, { threads: Math.max(1, workers), cache: process.env.EEAT_OS_CACHE || null });
					graph = OSM.graphOf(g, L);
					say({ ev: 'oneshot', what: 'graph', ms: Date.now() - tO, ...(graph ? graph.stats() : {}) });
				} catch (e) { say({ ev: 'warning', text: `the one shot's graph (src/plan/oneshot/edges.js): ${e.message}` }); }
			}
			os = OSM.createOneShot(L, { model, planner, bounds, graph, emit: say });
			const r = os.run(Math.max(0, OS_SHARE * (left() - endReserve)), { stop: () => stopped });
			osDone = r.done;
			osHarvest();
			const s = r.stats;
			stage('oneshot', Date.now() - tO, `${best ? `route ${num(best.runTicks)} run ticks` : 'no route'}${r.closed ? ' (closed: optimal within the graph)' : ''}, ${num(s.expanded)} expanded, ${num(s.nodes)} nodes, ${s.states} states, ${osSeen.size} anchors given`);
		} catch (e) { os = null; say({ ev: 'warning', text: `the one shot: ${e.message}` }); }
	}
	lastProgress = progressAt = Date.now();   // (the stall clocks from the loop's start)
	progress();
	wholeLevel();
	if (ST_ON) stStart();
	try {
		while (true) {
			if (stopped) { end = 'stopped'; break; }
			if (left() <= 0) { end = 'time'; break; }
			if (best && opts.first) { end = 'finish'; break; }
			// (a route known: the moves stop where the polish's reserve begins)
			// (EEAT_PERFECT: a route too long for the prove stage gives its reserve to the moves / perfect / polish)
			if (perfectOn && best && best.runTicks > PROVE_MAX_TICKS && proveReserve > 0) { proveReserve = 0; endReserve = polishReserve + perfectReserve; }
			if (best && left() <= endRes() && !inflight.size) { end = 'time'; break; }
			if (anchors.size !== anchorsSeen || best !== bestSeen) { anchorsSeen = anchors.size; bestSeen = best; progressAt = Date.now(); }
			if (stallEnd && Date.now() - progressAt > stallEnd) { end = 'stalled'; break; }
			if (OS_OPEN && osw && !osOpen && !best && !osWantOpen) {
				// (the gate with no route: no new anchor for a while, or half the budget gone)
				if (Date.now() - progressAt > Math.max(OS_OPEN_MIN_S, OS_OPEN_F * seconds) * 1000) osWantOpen = 'no new anchor';
				else if (secNow() > OS_OPEN_HALF * seconds) osWantOpen = 'half the budget';
			}
			if (osw) osHarvest();   // (the one shot's thread: its routes and new anchors before the next jobs are picked)
			if (bwlWant && !bwlOpen && !best) bwlRelease(bwlWant);   // (the child's gate: the watchdog saw a stall with no route)
			if (ST_ON) { stHarvest(); stSchedule(); }   // (the stretch solver: its arrivals, then its next stretch while it is idle)
			while (inflight.size < P && !(best && left() <= endRes())) {
				const job = exploreQ.length ? exploreQ.shift() : nextJob();
				if (!job) break;
				const ek = edgeKey(job.step);
				if (inflight.has(ek)) continue;
				cur = { plan: job.plan, step: job.step, anchor: job.anchor.id, ok: null, depth: job.anchor.depth };
				if (bwlWpFile) bwlPlan(job.anchor);
				say({ ev: 'plan', anchor: job.anchor.id, steps: job.plan.steps.map(labelOf), cost: job.plan.cost, lb: job.plan.lb, partial: !!job.plan.partial, why: job.plan.why || '', rung: job.step.rung });
				const f = { job, started: Date.now(), budgetMs: budgetOf(windowRung(job.step)).ms };
				f.promise = runJob(job).catch((e) => { bug('job', { error: e.message }); return {}; }).then((r) => { inflight.delete(ek); return r; });
				inflight.set(ek, f);
			}
			if (!inflight.size) {
				// (every anchor exhausted: a global deepening; nothing new since the last one, or no deepening left: the
				// fallbacks (a direct trophy step, then the frontier) while time is left; else the end)
				if (exploreQ.length) continue;
				if (left() < 250 || (best && left() <= endRes())) { end = 'time'; break; }
				if (nothingSince >= 0 && nothingSince === steps) { const fb = fallbackJob(); if (fb) { exploreQ.push(fb); continue; } if (osw && await osHold()) continue; if (!best && bwcRelease('the executor has nothing left')) { nothingSince = -1; continue; } if (await bwlHold()) continue; if (ST_ON && await stHold()) continue; if (PREC_ASYNC && await precHold()) continue; end = 'exhausted'; break; }
				nothingSince = steps;
				// (a deepening refused for the clock alone (its doubled first rung past the time left) is no exhaustion: the
				// end is the time's, not a claim that no plan is left (The Flighty Slighty, The Tunnels, Fish Gods, OCTOS:
				// "end exhausted" 1-5 s before the 60-s budget; every level is possible))
				if (!deepen('exhausted')) { const fb = fallbackJob(); if (fb) { exploreQ.push(fb); continue; } if (osw && await osHold()) continue; if (!best && bwcRelease('the executor has nothing left')) continue; if (await bwlHold()) continue; if (ST_ON && await stHold()) continue; if (PREC_ASYNC && await precHold()) continue; end = deepenings < maxDeepen ? 'time' : 'exhausted'; break; }
				continue;
			}
			if (osw) { /* (the thread runs on its own) */ } else if (os && !osDone && !stopped && !(best && left() <= endReserve)) {
				// (the one shot's slice while the workers run the steps in flight)
				try { const r = os.run(Math.min(OS_SLICE, Math.max(0, left() - endReserve - 50)), { stop: () => stopped }); osDone = r.done; osHarvest(); } catch (e) { bug('oneshot', { error: e.message }); os = null; }
			}
			const tick = new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
			await Promise.race([...[...inflight.values()].map((f) => f.promise), tick]);
		}
		// (the whole level as one leg still running and no route: it has the time left)
		if (bwlChild && !best && !stopped && left() > 1000) {
			const wms = Math.max(0, left() - 500);
			await Promise.race([bwlDone, new Promise((res) => { const tt = setTimeout(res, wms); if (tt.unref) tt.unref(); })]);
		}
		// (EEAT_BW_LEVEL=last: the child's route only now, and only when the moves stage has none)
		if (BW_LEVEL_MODE === 'last' && !BW_CHAIN && bwlPending && !best) {
			const x = routeOf(T.masksOf(bwlPending.replace(/[^0-O]/g, '')), 'the whole level as one leg (backward, last resort)', null);
			say({ ev: 'bwlevel', end: 'taken', runTicks: x && x.ev ? x.ev.runTicks : null, better: !!(x && x.better) });
		}
		// (in-flight steps: told to stop, awaited briefly)
		const wasStopped = stopped;
		stopped = true;
		const wait = Promise.all([...inflight.values()].map((f) => f.promise));
		await Promise.race([wait, new Promise((res) => { const tt = setTimeout(res, 3000); if (tt.unref) tt.unref(); })]);
		stopped = wasStopped;
	} finally {
		for (const tt of timers) clearInterval(tt);
		if (bwlChild) { try { bwlChild.kill('SIGKILL'); } catch (e) { /* gone */ } }
		if (ST_ON) { stHarvest(); stStop(); }
		if (PREC_ASYNC) { precOver = true; if (precChild) { try { precChild.kill('SIGKILL'); } catch (e) { /* gone */ } } }
	}
	if (osw) osHarvest();   // (the one shot's thread: what arrived during the last turn)
	const legTools = (lg) => { const c = {}; for (const g of lg) c[g.tool || '?'] = (c[g.tool || '?'] || 0) + 1; return c; };
	{
		const lg = best ? best.legs : [];
		const c = legTools(lg), proven = lg.filter((g) => g.proven).length;
		const tools = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') + (proven ? `; ${proven} proven` : '');
		stage('moves', Date.now() - tMoves, best ? `${lg.length} leg${lg.length === 1 ? '' : 's'}${tools ? ` (${tools})` : ''}, ${failSteps} re-plan${failSteps === 1 ? '' : 's'}, ${steps} steps, ${anchors.size} anchors (end ${end})`
			: `no route: ${steps} steps, ${failSteps} failed, ${anchors.size} anchors, ${deepenings} deepening${deepenings === 1 ? '' : 's'}, ${stalls} stall${stalls === 1 ? '' : 's'} (end ${end})`);
	}

	// ---- VERIFY (the route as found) and POLISH (the executor's, else the route cleanup), then the final verify
	if (best) {
		tm = Date.now();
		const ev = C.evaluate(L, best.masks);
		if (!ev) { bug('verify', { why: 'the best route does not finish on its replay' }); best = null; }
		stage('verify', Date.now() - tm, ev ? `finishes: ${fmt(ev.runTicks)} (${num(ev.runTicks)} run ticks), ${ev.deaths} death${ev.deaths === 1 ? '' : 's'}${ev.chance < 1 ? `, ${Math.round(ev.chance * 1000) / 10}% of EEO plays (random portals)` : ''}` : 'the route does not finish: dropped (a bug)');
	}
	// ---- PERFECT (EEAT_PERFECT=1): the order B&B from the route's own states, the route the incumbent (src/plan/perfect.js)
	let perfectInfo = null;
	if (best && perfectOn && exec && typeof exec.reach === 'function' && !stopped) {
		tm = Date.now();
		const ms = Math.max(200, Math.min(perfectReserve, left() - 200 - polishReserve - proveReserve));
		let text = 'no gain';
		try {
			const PF = require('./perfect.js');
			const r = await PF.perfectRoute({ L, model, planner, exec, RM, emit: say }, best.masks, { ms, polishShare: PERFECT_POLISH });
			perfectInfo = { saved: r.saved, expanded: r.expanded, legs: r.legs, legsOk: r.legsOk, pruned: r.pruned, seeds: r.seeds, exhausted: !!r.exhausted, found: r.found };
			const ev = r && r.saved > 0 ? C.evaluate(L, r.masks) : null;
			if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && ev.runTicks < best.runTicks) {
				const saved = best.runTicks - ev.runTicks;
				best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: best.legs, how: `${best.how} + perfect` };
				say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, perfect: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
				if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
				text = `-${num(saved)} ticks (${r.found.map((f) => f.how).join(', ')})`;
			}
			text += `; ${r.expanded} nodes, ${r.legsOk} / ${r.legs} legs, ${r.pruned} pruned by the bound${r.exhausted ? ', the queue exhausted' : ''}`;
		} catch (e) { say({ ev: 'warning', text: `the perfect pass: ${e.message}` }); text = `error: ${e.message}`; }
		stage('perfect', Date.now() - tm, text);
	}
	/** one polish of the best route for ms (the executor's, else the route cleanup): the best replaced when it is faster
	 *  (or as fast and shorter) -> {saved, text}. (EEAT_PERFECT, n5-perfect's "the polish takes whatever the prove stage does
	 *  not keep": here THE REST and THE LAST (lane 5) give it that time in rounds, and a route over PROVE_MAX_TICKS skips the
	 *  prove stage, so its reserve goes to THE LAST) */
	const polishBest = async (ms) => {
		let how = '', pr = null;
		try {
			// (the window marks: polish.js reads o.legs as TICKS; the legs are objects, so with EEAT_PERFECT the joins' ticks: the
			// route's model-state changes and its legs' starts)
			const marks = perfectOn ? (() => { try { const J = require('./perfect.js').joinTicks(L, model, best.masks); for (const g of best.legs || []) if (g && g.fromTick > 0) J.push(g.fromTick); return [...new Set(J)]; } catch (e) { return best.legs; } })() : best.legs;
			if (exec && typeof exec.polish === 'function') { pr = await exec.polish(best.masks, { ms, legs: marks, bound: LB }); how = 'the executor'; }
			else {
				const CR = require('../cleanroute.js');
				const r = CR.cleanRoute(L, best.masks, { ms });
				pr = r ? { masks: r.ms, runTicks: r.ev.runTicks } : null; how = 'the route cleanup';
			}
		} catch (e) { say({ ev: 'warning', text: `the polish: ${e.message}` }); pr = null; }
		let text = 'no gain', saved = 0;
		if (pr && pr.masks) {
			const masks = pr.masks instanceof Uint8Array ? pr.masks : T.masksOf(pr.masks);
			const ev = C.evaluate(L, masks);
			if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && (ev.runTicks < best.runTicks || (ev.runTicks === best.runTicks && ev.complete < best.ticks))) {
				saved = best.runTicks - ev.runTicks;
				const lg = Array.isArray(pr.legs) && pr.legs.length ? pr.legs.map((g) => ({ label: g.label || '?', fromTick: g.fromTick, ticks: g.ticks, lb: Number.isFinite(+g.lb) ? +g.lb : null, proven: !!g.proven, tool: g.tool || null })) : best.legs;
				best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: lg, how: String(best.how || '').endsWith(' + polish') ? best.how : `${best.how} + polish` };
				say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, polish: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
				if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
				text = saved > 0 ? `-${num(saved)} ticks (${how})` : `the same time, ${num(best.ticks)} ticks (${how})`;
			} else if (ev) text = `no gain (${how}: ${fmt(ev.runTicks)}, ${ev.deaths} deaths: kept the route)`;
			else text = `refused (${how}: it does not finish)`;
		}
		return { saved, text };
	};
	if (best && polishOn && !stopped) {
		tm = Date.now();
		const ms = Math.max(200, Math.min(polishReserve, left() - 200 - (best ? proveReserve : 0)));
		const r = await polishBest(ms);
		stage('polish', Date.now() - tm, r.text);
	} else stage('polish', 0, best ? 'off' : 'no route');

	// ---- THE REST (lane 5, TAS-perfect): the polish again, rounds while they gain, with at most REST_F of the time left (the
	// proof gets the rest, and all of it where the polish gains nothing): a polished route has new states, so the mutation
	// pass and the segments find new rejoins. Before, a compile whose moves stage ended early gave the proof all its time
	// (Rosa dei Venti 264 s of 300 s, no proof, where the polish's 15 s had saved 354 ticks; celeste 176 s, My level fef0
	// 110 s). Measured: a second polish of 60 s on the 300-s baseline's routes of lane 5's levels: Tutorial 1 -88, TPs The
	// Horror -354, Trick Or Treat -282, Accident Prone -45, Tree Decorating -31 (tools/cmp/polcurve.js).
	if (best && polishOn && POLISH_REST && !stopped && left() > REST_MIN_MS) {
		tm = Date.now();
		const notes = [];
		let saved = 0;
		const restEnd = Date.now() + REST_F * left();
		for (let round = 0; round < REST_ROUNDS && !stopped && restEnd - Date.now() > REST_MIN_MS; round++) {
			const r = await polishBest(restEnd - Date.now());
			if (!(r.saved > 0)) { if (!round) notes.push(r.text); break; }
			saved += r.saved;
			notes.push(r.text);
		}
		if (saved > 0) stage('repolish', Date.now() - tm, `-${num(saved)} ticks in ${notes.length} round${notes.length === 1 ? '' : 's'} (${notes.join('; ')})`);
		else say({ ev: 'repolish', ms: Date.now() - tm, text: notes.join('; ') || 'no gain' });
	}
	// ---- PROVE: the route optimal where the exact search can say so. The run timer starts at the first input, so waiting is
	// free; the start rests after R idle ticks (restIdle). The route costs C = its arrival tick - its idle ticks. From each
	// S_k (the start after k = 0..R idle ticks) one exact search to the trophy bounded by beforeTick = k + C - 1: every route
	// whose first input is at tick k' <= R is in S_k' 's search, and one that waits longer is one that waits R, shifted.
	// Every search exhausted (the executor's EXACT tier: its lb, in layers from its start, reaches C) = no route costs less
	// than C run ticks: the lower bound is the route's (PROVEN OPTIMAL). Deaths are moves where something kills (the search
	// then keeps dying runs: allowDeath). An arrival a search finds is a faster route (from the exact tier, the minimum
	// from its start). The proof rests on the exact tier's cuts: the endgame bound (sound by construction), the bounds'
	// leg() (admissible: the primitives' T-LB-ADMISSIBLE check) and the -1 field while the doors stand as at the start.
	const noDeath = (() => { try { return require('../goexplore.js').deathsOf(L) === null; } catch (e) { return false; } })();
	let proveProof = '';
	const proveLong = perfectOn && best && best.runTicks > PROVE_MAX_TICKS;
	if (best && proveOn && restIdle >= 0 && !proveLong && exec && typeof exec.reach === 'function' && !stopped && left() > 300) {
		tm = Date.now();
		let text = '';
		try {
			// (rounds: a faster route a search finds becomes the best, and the proof starts over with its cost: prove or improve)
			const trophy = T.goalOf(L, { kind: 'trophy' });
			const how = noDeath ? 'nothing kills' : 'deaths as moves';
			const notes = [];
			// (lane 5: a start proven for a cost C (no route from it arrives within C ticks after its first input) stays proven for
			// every smaller cost: a later round (after a faster route) searches only the starts not proven yet. Before, every round
			// searched every start again: Switch Labyrinth's 5 rounds of -1 re-proved its first 10-14 starts 5 times. EEAT_PROVE_KEEP=0: off)
			const provenAt = new Map();
			for (let round = 0; round < PROVE_ROUNDS; round++) {
				let kStar = 0;
				while (kStar < best.masks.length && best.masks[kStar] === 0) kStar++;
				const sim = new E.EESim(L), inp = new E.EEInput();
				sim.reset();
				let A = -1;
				for (let n = 0; n < best.masks.length; n++) { E.applyMask(inp, best.masks[n]); sim.tick(inp); if (!sim.is_dead && sim.has_silver_crown) { A = n + 1; break; } }
				const Cost = A - kStar;
				if (A < 1 || Cost < 1) { notes.push('the route does not reach the trophy on its replay (a bug)'); break; }
				let proved = 0, faster = null, fail = '', lbMin = Infinity;
				const provedBefore = [...provenAt.values()].filter((c) => c >= Cost).length;
				// (lane 5: a long route's proof gets PROVE_LONG_MS, THE LAST the rest: the proofs and the faster routes the
				// proof found in the 300-s baseline were all on routes of 27-98 run ticks (Switch Labyrinth, My level 730c /
				// fef0); on 1,500-3,000-tick routes its exact bound reached 9-146 ticks in 12-15 s)
				const capEnd = POLISH_REST && process.env.EEAT_POLISH_LAST !== '0' && Cost > PROVE_SHORT ? tm + PROVE_LONG_MS : Infinity;
				for (let k = 0; k <= restIdle && !faster; k++) {
					const room = Math.min(left() - 250, capEnd - Date.now());
					if (PROVE_KEEP && provenAt.get(k) >= Cost) { proved++; lbMin = Math.min(lbMin, Cost); continue; }
					if (room < 100) { fail = fail || 'no time left'; lbMin = 0; break; }
					let todo = 0;
					for (let j = k; j <= restIdle; j++) if (!(PROVE_KEEP && provenAt.get(j) >= Cost)) todo++;
					const ms = Math.max(100, Math.floor(room / Math.max(1, todo)));
					const deadline = Date.now() + ms;
					const idle = new Uint8Array(k);
					const Sk = k === 0 ? a0 : T.arrivalOf(L, T.playTo(L, idle).sim, idle, RM);
					const wp = { kind: 'trophy', tiles: Array.from(trophy.tiles), expect: null, label: 'trophy (the proof)', beforeTick: k + Cost - 1, allowDeath: !noDeath };
					const r = await exec.reach([Sk], wp, { ms, level: rungMs.length - 1, k: ARRIVALS_K, deadline, stop: () => stopped || Date.now() > deadline + 2000 });
					if (r && r.ok) {
						const arr = (r.arrivals || []).filter((a) => a && a.masks && a.tick <= k + Cost - 1).sort((a, b) => a.tick - b.tick);
						if (!arr.length) { bug('prove', { why: `the executor returned arrivals past the waypoint's beforeTick ${k + Cost - 1}` }); fail = 'its arrivals were past the bound (a bug)'; lbMin = 0; break; }
						faster = { a: arr[0], r, k };
					} else if (r && Number(r.lb) >= Cost) { proved++; provenAt.set(k, Cost); }
					else if (!fail) fail = `start +${k} idle: ${r && r.fail ? r.fail.why : '?'}, the exact search's bound ${r ? num(r.lb || 0) : '?'} of the ${num(Cost)} needed`;
					// (each search's lb: no arrival within lb - 1 layers of its start; the least over the starts bounds every route)
					if (!(r && r.ok)) lbMin = Math.min(lbMin, r && Number(r.lb) > 0 ? Math.min(Number(r.lb), Cost) : 0);
				}
				if (faster) {
					const m = faster.a.masks instanceof Uint8Array ? faster.a.masks : T.masksOf(faster.a.masks);
					const ev = C.evaluate(L, m);
					const lg0 = (faster.r.legs || [])[0] || {};
					if (ev && ev.runTicks < best.runTicks && (!noDeath || ev.deaths === 0) && ev.chance >= best.chance - 1e-9) {
						const saved = best.runTicks - ev.runTicks;
						const proven = !!lg0.proven && (lg0.tool === 'exact' || String(lg0.tool || '').startsWith('math'));   // (a math leg's proof: its certified bound = its ticks)
						best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance,
							legs: [{ label: 'trophy', fromTick: faster.k, ticks: ev.complete - faster.k, lb: proven ? ev.complete - faster.k : null, proven, provenBy: proven ? lg0.provenBy || 'exact' : null, tool: lg0.tool || faster.r.tool || null }], how: 'the proof search' };
						say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
						if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
						notes.push(`-${num(saved)} (${lg0.tool || faster.r.tool || '?'}, +${faster.k} idle)`);
						continue;
					}
					notes.push(`its arrival did not replay faster (${ev ? fmt(ev.runTicks) : 'no finish'})`);
					break;
				}
				if (proved === restIdle + 1) {
					proveProof = `${restIdle + 1} exhaustive exact search${restIdle ? 'es' : ''} from the level start (after 0..${restIdle} idle ticks; ${how}): no route reaches the trophy in fewer than ${num(Cost)} ticks after its first input`;
					notes.push(`PROVEN: no route reaches the trophy in fewer than ${num(Cost)} ticks after its first input (${restIdle + 1} exact search${restIdle ? 'es' : ''}, ${how})`);
					break;
				}
				// (no proof, but every start's search ran: the least of their bounds is a bound on every route (the same offset
				// between ticks after the first input and run ticks as the route's own))
				const part = Number.isFinite(lbMin) && lbMin > 0 ? lbMin - (Cost - best.runTicks) : 0;
				let raised = '';
				if (part > LB && part <= best.runTicks) { raised = `; the lower bound raised ${num(LB)} -> ${num(part)} run ticks by the exact searches`; LB = part; }
				// (lane 5: time left and this pass proved starts: another pass over the unproven ones with all of it (their share
				// grows); Switch Labyrinth's 300-s proof ended at 27 of 39 starts, the 28th at the bound 27 of the 28 needed, with
				// ~70 s of the compile left unused)
				if (PROVE_KEEP && proved > provedBefore && left() - 250 > 2000 && !stopped) { notes.push(`pass: ${proved} of ${restIdle + 1} starts proven`); continue; }
				notes.push(`no proof in ${((Date.now() - tm) / 1000).toFixed(1)} s (${proved} of ${restIdle + 1} starts; ${fail})${raised}`);
				break;
			}
			text = notes.join('; ') || 'no round ran';
		} catch (e) { bug('prove', { error: e.message }); text = `no proof: ${e.message}`; }
		stage('prove', Date.now() - tm, text);
	} else if (best) stage('prove', 0, !proveOn ? 'off' : proveLong ? `skipped: a route of ${num(best.runTicks)} run ticks (EEAT_PERFECT: over ${PROVE_MAX_TICKS}, past the exact search's reach)` : restIdle < 0 ? `skipped: the start does not rest within ${PROVE_IDLE_MAX} idle ticks` : stopped ? 'skipped: stopped' : 'skipped: no time left');

	// ---- THE LAST (lane 5, TAS-perfect): the time the proof leaves (it ends early where its exact search's bound is far
	// below the route: no proof possible) goes to the polish again, rounds while they gain, to the budget's end. Before, the
	// compile ended there: the 300-s runs of THE REST ended at 284.5 s on Tutorial 1 (its repolish round had just saved 134
	// ticks in 16 s, the proof took 0.5 s) and at 282-300 s elsewhere. Not after a proof (the route is optimal).
	// EEAT_POLISH_LAST=0: off. (The last stage inside the budget: the LOOPS and JOINS stages below have their own clocks after it.)
	if (osw) osHarvest();   // (a faster route of the one shot's thread meanwhile: polished below like any)
	if (best && polishOn && POLISH_REST && process.env.EEAT_POLISH_LAST !== '0' && !proveProof && !stopped && left() - 300 > REST_MIN_MS) {
		tm = Date.now();
		const notes = [];
		let saved = 0;
		for (let round = 0; round < REST_ROUNDS && !stopped && left() - 300 > REST_MIN_MS; round++) {
			const r = await polishBest(left() - 300);
			if (!(r.saved > 0)) { if (!round) notes.push(r.text); break; }
			saved += r.saved;
			notes.push(r.text);
		}
		if (saved > 0) stage('lastpolish', Date.now() - tm, `-${num(saved)} ticks in ${notes.length} round${notes.length === 1 ? '' : 's'} (${notes.join('; ')})`);
		else say({ ev: 'lastpolish', ms: Date.now() - tm, text: notes.join('; ') || 'no gain' });
	}
	// ---- the one shot's thread: told to stop, its last messages taken (a faster route verified by routeOf), ended
	if (osw) {
		tm = Date.now();
		try { osw.postMessage({ type: 'stop' }); } catch (e) { /* gone */ }
		await new Promise((res) => { const tt = setTimeout(res, 1500); osw.once('exit', () => { clearTimeout(tt); res(); }); });
		const b0 = best;
		osHarvest();
		try { await osw.terminate(); } catch (e) { /* ended */ }
		const s = osStats || {};
		stage('oneshot', Date.now() - tm, `${Number.isFinite(osBestT) ? `its route ${num(osBestT)} ticks${best && best !== b0 ? ' (the best: taken at the end)' : ''}` : 'no route'}${s.closedLevel >= 0 ? `, closed at ladder step ${s.closedLevel}` : ''}, ${num(s.expanded || 0)} expanded, ${num(s.nodes || 0)} nodes, ${s.states || 0} states, ${osAnchors} anchors given, ${osInjected} injected${OS_GATE ? `, the gate ${osOpen ? `opened (${osReleased} held arrivals)` : `shut (${osPending.size} arrivals held)`}` : ''}${osErr ? `, error: ${osErr}` : ''}`);
	}

	// ---- LOOPS (n5-perfect, versus the best known: polish.js's loop pass (a1) alone, its own clock after the budget like
	// the joins below: a route that came late had no polish (The Blank Page's at 56 s of 60, polish 0.3 s), and its loops
	// (the portal pit and back, a climb done twice, a back-and-forth run-up, a detour to a coin nothing needs) are the
	// biggest single savings: every cut a proven rejoin, exact or coin-blind, every combination replayed and judged (no
	// more deaths, no lower chance, faster): never slower. opts.loopsS (compile.js --loops=<s>, EEAT_LOOPS_S; default a
	// sixth of the budget, at most 10 s); EEAT_POLISH_LOOPS=0 / EEAT_PERFECT=0 (compile.js): off.
	if (best && opts.loopsS > 0 && !stopped) {
		tm = Date.now();
		let text = '';
		try {
			const PL = require('./polish.js');
			const r = PL.polishRoute(L, best.masks, { ms: opts.loopsS * 1000, loopsOnly: true, allowDeaths: false });
			const ev = r.runTicks < best.runTicks ? C.evaluate(L, r.masks) : null;
			if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && ev.runTicks < best.runTicks) {
				const saved = best.runTicks - ev.runTicks;
				best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: best.legs, how: `${best.how} + loops` };
				say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, loops: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
				if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
				text = `-${num(saved)} ticks (${r.steps.length} cut${r.steps.length === 1 ? '' : 's'} accepted)`;
			} else text = 'no gain';
		} catch (e) { bug('loops', { error: e.message }); text = `failed: ${e.message}`; }
		stage('loops', Date.now() - tm, text);
	}

	// ---- JOINS (n5-perfect, src/plan/joins.js): the finished route re-derived as a chain of solved legs with the SPEED
	// carried across its joins (a DP over the route's supports x the arrival's speed / position class, msolve legs and skips
	// as edges, the route's own inputs always one of them), then every leg of the result against the certified bounds. Its
	// own clock (opts.joinsS, after the budget and after the perfect pass: the stages before it are unchanged), kept only when
	// the engine replays it faster with no more deaths and no lower chance: never slower. EEAT_JOINS=0 (compile.js): off.
	let joinsInfo = null;
	if (best && opts.joinsS > 0 && !stopped) {
		tm = Date.now();
		let text = '';
		try {
			const JN = require('./joins.js');
			const r = JN.joinRoute(L, best.masks, { ms: opts.joinsS * 1000, maxDeaths: best.deaths });
			joinsInfo = { before: r.before, after: r.runTicks, saved: r.saved, passes: (r.passes || []).map((p) => ({ gap: p.gap, from: p.from, to: p.to, waypoints: p.waypoints, skips: p.skips, legs: p.legsUsed, ms: p.ms })),
				waypoints: r.waypoints, legs: (r.legs || []).length, proven: r.proven, provenTicks: r.provenTicks, lbSum: r.lbSum, fasterLegs: r.fasterLegs, stats: r.stats, ms: r.ms };
			let took = false;
			if (r.accepted && r.runTicks < best.runTicks) {
				const ev = C.evaluate(L, r.masks);
				if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && ev.runTicks < best.runTicks) {
					const lg = (r.legs || []).map((g) => ({ label: `${g.finish ? 'trophy' : `support ${g.cls}`}`, fromTick: g.from, ticks: g.ticks, lb: Number.isFinite(g.lb) ? g.lb : null, proven: !!g.proven, provenBy: g.provenBy || null, lbMath: null, tool: 'joins' }));
					const saved = best.runTicks - ev.runTicks;
					best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: lg.length ? lg : best.legs, how: `${best.how} + joins` };
					say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, joins: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
					if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
					took = true;
					text = `-${num(saved)} ticks (${r.passes.length} pass${r.passes.length === 1 ? '' : 'es'} over ${num(r.waypoints)} supports)`;
				}
			}
			if (!took) text = `no gain (${(r.passes || []).length} pass${(r.passes || []).length === 1 ? '' : 'es'})`;
			text += `; ${r.proven} of ${(r.legs || []).length} support legs proven optimal (${num(r.provenTicks)} ticks)${r.fasterLegs ? `, ${r.fasterLegs} solved sooner alone` : ''}`;
		} catch (e) { bug('joins', { error: e.message }); text = `failed: ${e.message}`; }
		stage('joins', Date.now() - tm, text);
	}

	// ---- THE ENDGAME (C6 lane 5 block 3; OPT-IN opts.endgameS (compile.js EEAT_ENDGAME_S / --endgame=<s>), 0 / unset: off,
	// the compile byte for byte): the exact endgame ladder of src/endgame.js on the finished route: from the route's own state
	// K = 8, 16, .. 64 ticks before its finish EVERY input sequence (stateHash merge, the admissible trophy bound's cut), the
	// first finish the fastest from that state, a give-up / an exhausted search a proof that none is faster from there;
	// kept only when the engine replays it faster with no more deaths and no lower chance. Its own clock after the joins.
	// (celeste x2: the route's last 34 ticks where the best known takes 16; the ladder 239 -> 238, no faster finish within
	// the last 31 ticks proven)
	let endgameInfo = null;
	if (best && opts.endgameS > 0 && !stopped) {
		tm = Date.now();
		let text = '';
		try {
			const EG = require('../endgame.js');
			const r = EG.ladder(L, [{ name: 'route', masks: best.masks }], { K: { max: +process.env.EEAT_ENDGAME_K || 64 }, seconds: opts.endgameS });
			let provedK = 0;
			for (const p of r.proofs || []) if (!p.rejected && p.start === 'route') provedK = Math.max(provedK, p.K);
			endgameInfo = { before: best.runTicks, found: (r.found || []).length, proofs: (r.proofs || []).length, provedK, searches: r.searches, ms: Date.now() - tm };
			const ev = r.masks ? C.evaluate(L, r.masks) : null;
			if (ev && ev.deaths <= best.deaths && ev.chance >= best.chance - 1e-9 && ev.runTicks < best.runTicks) {
				const saved = best.runTicks - ev.runTicks;
				best = { masks: ev.ms, ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, legs: best.legs, how: `${best.how} + endgame` };
				endgameInfo.after = ev.runTicks;
				say({ ev: 'result', kind: 'finish', ticks: ev.complete, runTicks: ev.runTicks, deaths: ev.deaths, chance: ev.chance, how: best.how, endgame: saved, lb: LB, gap: gapOf(ev.runTicks), inputs: T.strOf(ev.ms) });
				if (out) { try { C.writeEetas(path.join(out, 'route.eetas'), ev.ms); } catch (e) { /* read-only */ } }
				text = `-${num(saved)} ticks`;
			} else text = 'no gain';
			text += `; ${endgameInfo.proofs} proofs${endgameInfo.provedK ? `, no faster finish within the last ${endgameInfo.provedK} ticks` : ''}`;
		} catch (e) { bug('endgame', { error: e.message }); text = `failed: ${e.message}`; }
		stage('endgame', Date.now() - tm, text);
	}

	// ---- the bound again (the planner's facts may have raised it), the report
	// (a proof of optimality: the route is one exact leg from the level start, proven the fewest ticks, and the start is
	// static: no route has fewer run ticks)
	let lbProof = proveProof;
	if (proveProof && best && best.runTicks > LB) { LB = best.runTicks; lbComplete = true; }
	// (the exact search drops dying runs: only where nothing kills (goexplore.js deathsOf: no killing tile, no timed killer)
	// is its minimum every route's; a death back to the one spawn keeps the keys and coins taken: a move)
	if (!lbProof && best && startStatic && noDeath && best.legs.length === 1 && best.legs[0].fromTick === 0 && best.legs[0].proven && (best.legs[0].tool === 'exact' || String(best.legs[0].tool || '').startsWith('math')) && !String(best.how || '').includes('polish')) {
		if (best.runTicks > LB) { LB = best.runTicks; lbComplete = true; lbProof = `one ${best.legs[0].tool === 'exact' ? 'exact' : 'math'} leg from the static level start, proven the fewest ticks${best.legs[0].provenBy ? ` (${best.legs[0].provenBy})` : ''}`; }
	}
	if (!lbSlow && !lbProof && planner.lowerBound) {
		try {
			const r = planner.lowerBound(startAnchorArg, { ms: LB_MS });
			const t = lbTicks(r);
			if (Number.isFinite(t) && t > LB) { LB = t; if (r && r.complete) lbComplete = true; }
			if (t === Infinity && best) bug('bound', { why: 'the planner\'s lower bound is infinite while a route exists: its relaxation is unsound here' });
		} catch (e) { /* the first one stands */ }
	}
	if (best && LB > best.runTicks) { bug('bound', { why: `the lower bound ${LB} is above the route's ${best.runTicks} run ticks: inadmissible`, lb: LB, planner: lbPlanner, bounds: lbBounds }); LB = Math.max(0, ...[lbPlanner, lbBounds].filter((x) => Number.isFinite(x) && x <= best.runTicks)); }
	let execStats = null;
	try { execStats = exec && exec.stats ? exec.stats() : null; } catch (e) { execStats = null; }
	try { if (exec && exec.close) await exec.close(); } catch (e) { /* closed */ }
	try { if (prims && prims.close) await prims.close(); } catch (e) { /* closed */ }
	let known = null;
	if (opts.known && typeof opts.known === 'object') known = opts.known;
	else if (opts.known !== false && (opts.file || opts.md5)) { try { known = knownOf(opts.file, { md5: opts.md5 }); } catch (e) { known = null; } }
	progress();
	const why = best ? '' : `no route (end ${end}): ${whyNow().text}`;
	// THE ANCHOR DUMP (a diagnosis aid, OPT-IN EEAT_ANCHOR_DUMP=<file.jsonl>; unset = nothing written): one JSON line per
	// anchor {id, gain, tick, fails, via, masks (every arrival's input string)}, so the last mile of a NEAR level (a failed
	// leg 1-3 tiles from its target) can be replayed from the anchor's exact engine state (tools/cmp/nearkrt.js)
	if (process.env.EEAT_ANCHOR_DUMP) {
		try {
			const lines = [...anchors.values()].map((A) => JSON.stringify({ id: A.id, gain: A.gain, tick: A.firstTick, fails: A.fails, via: A.via || '', edgeVia: A.edgeVia || null,
				masks: A.arrivals.map((a) => (typeof a.masks === 'string' ? a.masks : T.strOf(a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks)))) }));
			const fs = require('fs'); let f = process.env.EEAT_ANCHOR_DUMP;
			// (a directory: one file a level, <dir>/<level>.anchors.jsonl, for a full compile's levels)
			try { if (fs.statSync(f).isDirectory()) f = path.join(f, path.basename(String(opts.file || 'level'), '.eelvl') + '.anchors.jsonl'); } catch (e) { /* a file name */ }
			fs.writeFileSync(f, lines.join('\n') + '\n');
		} catch (e) { /* a diagnosis file only */ }
	}
	say({ ev: 'done', end, sec: Math.round(secNow() * 10) / 10, steps, okSteps, anchors: anchors.size, routes: best ? 1 : 0, best: best ? best.ticks : null, runTicks: best ? best.runTicks : null, lb: LB, gap: best ? gapOf(best.runTicks) : null,
		bugs, deepenings, stalls, bnbPlans, bnbArrivals, layers: Math.max(0, ...[...anchors.values()].map((A) => A.firstTick)), ...(why ? { why } : {}) });
	saveFiles();
	return { ok: !!best, masks: best ? best.masks : null, route: best ? best.masks : null, runTicks: best ? best.runTicks : null, ticks: best ? best.ticks : null, deaths: best ? best.deaths : null, chance: best ? best.chance : null,
		lb: LB, lbComplete, lbProof, gap: best ? gapOf(best.runTicks) : null, legs: best ? best.legs : [], stages, known, why, end, anchors: anchors.size, steps, okSteps, bugs, deepenings, stalls, bnbPlans, bnbArrivals, relayRuns, relaySet, relayDrop, ...(ST_ON ? { stretch: stStats } : {}), exec: execStats, perfect: perfectInfo, joins: joinsInfo, ...(endgameInfo ? { endgame: endgameInfo } : {}),
		...(OS_ON ? { oneshot: os || osw ? Object.assign(os ? os.stats() : Object.assign({}, osStats || {}), { thread: !!osw, readyMs: osReady ? osReady.ms : null, error: osErr || null, gate: osw && OS_GATE ? (osOpen ? 'open' : 'shut') : null, released: osReleased, held: osPending.size, anchorsGiven: osAnchors, injected: osInjected, routeTicks: Number.isFinite(osBestT) ? osBestT : null, how: best ? best.how : null }) : null } : {}) };
}

/** run(L, opts, emit): the compile loop as a Find a route strategy (src/plan.js): 300 s by default, the source events'
 *  distances on the editor's scale; returns compile()'s result (end, route, anchors, steps, okSteps, bugs, deepenings,
 *  stalls too) */
function run(L, opts = {}, emit = () => {}) {
	return compile(L, Object.assign({ seconds: 300, sourceDist: true }, opts), emit);
}

module.exports = { compile, run, knownOf, md5Of, partsOf, plansOf, idleRunLB, RUNG_MS, STALL_S, POLISH_MS, POLISH_F };
