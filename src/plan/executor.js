'use strict';
// THE EXECUTOR (n4plan, the compiler's MOVES stage, part 'executor'): from REAL engine states (Arrivals) to a waypoint
// (types.js Waypoint: a trigger touched with its Expect, a region, the trophy), with legs PROVEN optimal where the exact
// search finishes; the compiler's code generation. No search tool of the old paradigm (goexplore, bursts, heat, eegpu):
// every leg is the engine's own simulation, every arrival replayed from the level start before it is returned.
//
//   exec = await createExecutor(L, {file, workers, prims, bounds, model, RM, emit, seed}) ->
//     {reach(starts, wp, budget) -> Promise<StepResult>, polish(masks, o) -> Promise<{masks, runTicks, saved, legs}>,
//      stats(), close()}
//
// reach(): the tiers (the budget: {ms, level (the rung 0..3), k (arrivals, default 4), stop, deadline}; it returns
// within budget.ms + 200 ms ALWAYS: the worker's own clock stops at the deadline less a margin, and a watchdog answers
// 'budget' and replaces the worker when it does not):
//   0. the proof pre-check: the RCH3 field of the level as the doors stand at each start (types.js levelNow + goalField,
//      physics mode only) -1 at EVERY start = a proof that the goal cannot be reached while the doors stay as they are
//      (fail 'proof', blockedBy = the shut gates the all-open field's way crosses);
//   0b. (OPT-IN, EEAT_NEAR=1) the exact end search: solveExact from a near start alone (the relay) and from this call's
//      own nearest state and its ancestors (tier 0b below: measured, no gain on the near-miss levels);
//   M. THE MATH (before the proof pre-check's goal fields: the MATH TIER below): the move solver's direct legs
//      (src/plan/msolve.js, proofs by its certified bound / src/math/lb.js), a short unproven one checked by the exact
//      search bounded by it; after the goal fields (M2), msolve's chains ordered by them; EEAT_MATH=0 off;
//   1. the primitives (opts.prims: prims.route) when given;
//   2. EXACT (exact.js solveExact): the breadth-first branch and bound over absolute ticks from every start (exact dedup,
//      the admissible bound, deaths dropped unless wp.allowDeath, the -1 cut, the monotone counter cut, a jump that
//      cannot jump not simulated): the first goal = the proven minimum; 35% of the window where the goal can be within
//      40 ticks, else 12% (a lower bound);
//   3. LEG (legs.js): the finders, not proofs: legBest (the default) a best-first search (f = tick + 5 x the goal field's
//      distance at the running pace, or the primitives' tick field when opts.bounds is given) over cells (2 px, 4 px, 1/8,
//      1/4 px/tick, the door-reading state: the first arrival closes a cell; a run out of open states again on finer
//      cells); legBFS (EEAT_EXEC_LEG=beam; 'mix': best-first then the beam bounded by it) a time-layered widening beam;
//   3b. the tightening: best-first again (w 3, the kinematic bound in its ranking) for legs shorter than the one found,
//      half of what is left; then polish.js polishLeg (the mutation pass on the leg, exact windows from its end);
//   2b. EXACT again with the leg's ticks as the budget (maxDepth = its absolute tick - 1): a shorter leg (proven the
//      minimum) or a proof that the leg is optimal;
//   the goal states of the successful tier (up to 4 k) -> T.pickDiverse (the earliest, the fastest, one per class).
//   Every leg found is taught to the primitives (prims.learn) when they exist. On failure a FailReport from the nearest
//   state any tier saw (the goal field's distance): why, closest {masks, tile, dist, vx, vy}, touched (the triggers its
//   way touched), blockedBy (shut gates within 2 tiles of it on the all-open field's way), level.
// WORKERS: every reach() / polish() runs in a worker thread (execworker.js; opts.workers, default min(4, cpus - 1),
// workers 0 = in-process); each worker loads the level once from opts.file and must replay a fixed input sequence to the
// same state hashes as this thread's L (else the executor runs in-process); arrivals cross threads as mask strings and
// are rebuilt (replayed, verified, T.arrivalOf with opts.RM) in this thread.
const os = require('os');
const path = require('path');
const E = require('../eesim.js');
const RF = require('../reach.js');
const T = require('./types.js');
const X = require('./exact.js');
const LG = require('./legs.js');

const X_NEAR = +process.env.EEAT_X_NEAR || 40;   // ticks: the exact tier's full share only where the goal can be this near
const X_SHARE_NEAR = +process.env.EEAT_X_SHARE_NEAR || 0.35, X_SHARE_FAR = +process.env.EEAT_X_SHARE_FAR || 0.12;   // (env: measurements)
// the exact end search (tier 0b, OPT-IN: EEAT_NEAR=1): starts within NEAR_T tiles of the goal (the goal field's unit,
// the FailReport's), its share NEAR_F of the window, the NEAR_STARTS nearest, each from its own state and NEAR_BACK ticks
// back, NEAR_CAP open states a layer (env: measurements)
const NEAR_ON = () => process.env.EEAT_NEAR === '1';
const ORD_FORCED = () => process.env.EEAT_ORD_FORCED === '1';   // (a measurement: the finders' ordering field, tier 3)
const NEAR_T = +process.env.EEAT_NEAR_T || 6, NEAR_F = +process.env.EEAT_NEAR_F || 0.35, NEAR_STARTS = 2, NEAR_CAP = 200000;
const NEAR_RES = process.env.EEAT_NEAR_RES !== undefined ? +process.env.EEAT_NEAR_RES : 0.12;   // the finders' window kept for it
const NEAR_BACK = (process.env.EEAT_NEAR_BACK || '0,10,24').split(',').map(Number).filter((x) => x >= 0);
const VERIFY_MARGIN_MS = 60;    // the worker's clock ends this much before the deadline (this thread's replays)
const WATCHDOG_MS = 150;        // past the deadline + this, an unanswered worker call is answered 'budget'
// (the late worker keeps its slot and its memos until it answers; replaced only when silent this long past the deadline;
// EEAT_WORKER_KEEP=0: the old rule, a late worker terminated and replaced at once)
const WORKER_HANG_MS = +process.env.EEAT_WORKER_HANG_MS || 30000;
const WORKER_KEEP = process.env.EEAT_WORKER_KEEP !== '0';
const QUEUE_TIMER = process.env.EEAT_QUEUE_TIMER !== '0';
// the primitives tier's share of a reach window (rung 0 / rung 1 on; env: measurements)
const PRIMS_SHARE = process.env.EEAT_PRIMS_SHARE !== undefined ? +process.env.EEAT_PRIMS_SHARE : 0.5;
const PRIMS_SHARE_HI = process.env.EEAT_PRIMS_SHARE_HI !== undefined ? +process.env.EEAT_PRIMS_SHARE_HI : 0.2;
// ---- THE MOVE SOLVER TIER (tier M, OPT-IN EEAT_MSOLVE=1; the compiler side of the MATH program's Wire): the leg COMPUTED
// by n4-math's src/plan/msolve.js (docs/ee_math.md section 4: the exact per-axis recurrences, the landing ticks in closed
// form, the x axis by branch and bound on the hold tables, every candidate replayed by the engine) instead of searched:
// from each live start the direct leg (S.leg: plain -> field -> coupled, short horizon), then the chain (S.chain: A* over
// support states with solved legs as edges, ordered by this call's goal field (the level as the doors stand, the walls)),
// the target = the waypoint's tiles (a trigger's tiles, a skeleton sub-level set, the trophies). Every leg it returns is
// replayed HERE from the start's state by this executor's own goal test (X.goalAt: the Expect, the touch that reads the
// tile a tick after the centre reaches it), so a leg is the engine's; a leg that does not meet the goal is dropped. No
// proof and no claim from this tier (its failure is the other tiers' to settle). Its share of the window MSOLVE_SHARE
// (env: measurements); off = the executor byte for byte as before.
const MSOLVE_ON = () => process.env.EEAT_MSOLVE === '1';
// THE PROFILE TIER (n5-lab-profile, approach B, src/plan/lab/profile.js): OPT-IN EEAT_PROFILE=1 (off: nothing of it runs,
// the executor as before byte for byte); its share of the window EEAT_PROFILE_SHARE (0.4), EEAT_PROFILE_SHARE0 at rung 0 (the same;
// the 4-move chains through the executor at 1.5 s: 214 vs 213 of 311 found at 0.4, the legs 2.5x sooner)
const PROFILE_ON = () => process.env.EEAT_PROFILE === '1';
const PROFILE_SHARE = process.env.EEAT_PROFILE_SHARE !== undefined ? +process.env.EEAT_PROFILE_SHARE : 0.4;
const PROFILE_SHARE0 = process.env.EEAT_PROFILE_SHARE0 !== undefined ? +process.env.EEAT_PROFILE_SHARE0 : PROFILE_SHARE;
// the first rung it runs at (EEAT_PROFILE_RUNG, 2: a leg the finders failed at rungs 0-1; at every rung (0) the compile A/B of
// the 29 compiled levels lost 4 (13 vs 9 compiled at 60 s) and its routes were slower: its first arrival replaced the
// finders' tightened, polished legs (The Ten Commandments 669 -> 1,531 ticks), and it took 40% of every call)
const PROFILE_RUNG = process.env.EEAT_PROFILE_RUNG !== undefined ? +process.env.EEAT_PROFILE_RUNG : 2;
const PROFILE_AT = process.env.EEAT_PROFILE_AT === 'early' ? 'early' : 'leg';
// (the 'leg' placement: a leg the tier finds is a BOUND for the finders, not their end: the best-first finder searches for a
// shorter one in EEAT_PROFILE_TIGHT (0.7) of what is left of the window (0: none, the tier's leg as it is). My level 730c:
// the tier's 144-tick leg at rung 2 kept the finder from its 105-tick leg (141 vs 104 compiled, 3 of 3 A/Bs))
const PROFILE_TIGHT = process.env.EEAT_PROFILE_TIGHT !== undefined ? +process.env.EEAT_PROFILE_TIGHT : 0.7;
const PROFILE_YIELD = process.env.EEAT_PROFILE_YIELD !== undefined ? +process.env.EEAT_PROFILE_YIELD : 0;
const MSOLVE_SHARE = process.env.EEAT_MSOLVE_SHARE !== undefined ? +process.env.EEAT_MSOLVE_SHARE : 0.2;        // the direct legs' cap
const MSOLVE_CHAIN_SHARE = process.env.EEAT_MSOLVE_CHAIN !== undefined ? +process.env.EEAT_MSOLVE_CHAIN : 0.3;   // the chains' share, after the primitives
const MSOLVE_LEGT = +process.env.EEAT_MSOLVE_LEGT || 150;       // the direct leg's horizon (ticks)
const MSOLVE_TMAX = +process.env.EEAT_MSOLVE_TMAX || 4000;      // the chain's horizon (ticks)
const MSOLVE_STARTS = +process.env.EEAT_MSOLVE_STARTS || 3;     // the live starts it computes from (the earliest first)
const MSOLVE_TAIL = 3;                                          // ticks played on past a solved leg for the goal's touch
const REPLAY_CACHE = 64;
const K_DEFAULT = 4;
// the best-first search's cells after one that ran out of open states: finer vy, then everything 2x, then 4x
const LADDER = [[0.5, 0.25, 8, 2], [1, 0.5, 16, 8], [2, 1, 32, 16]];
// the COARSE GRAIN first from rung COARSE_RUNG on: a leg the default cells did not find at rung 0 gets the best-first
// search on cells of coarse speed (1/2 px/tick vx, 1 px/tick vy; the position as the default's) for COARSE_SHARE of
// the finders' window, then the default cells (and their ladder) the rest; a leg it finds is tightened on the default
// cells as before. The default's fine speeds make a long leg's arrivals near-copies of one trajectory (a 400-600-tick
// leg: millions of pops within 10 tiles); the coarse ones spread the pops over the positions. In-process, box 3, 10 s,
// rung 1, the first two root edges of the 16 L3 FIRST-LEG levels (32 legs): coarse cells alone 6 found vs the default's 3
// (MMBA Skull Citadel's blue key 510 ticks, Polar Eclipse's team 582 / coin 438), every leg the default found too; the
// speed coarse inside fields alone (legs.js fieldCell) 3. EEAT_COARSE_SHARE (0 off), EEAT_COARSE_RUNG.
const COARSE_CELL = [0.5, 0.25, 2, 1];
// THE COVERAGE FINDER (doctor 7, n5-doc-7; legs.js legCover): OPT-IN EEAT_COVER=1: from rung COVER_RUNG on the finders'
// window starts with COVER_SHARE of it for the coverage finder (novelty-picked coarse cells, sticky random rollouts; it
// does not follow the goal field, so a leg whose way first goes away from the goal, a run-up or a detour the relaxation
// crosses, is not ranked behind the false near's whole region); a leg it finds goes on to the tightening (legBest bounded
// by it) like any finder's; off = the executor byte for byte as before
const COVER_ON = () => process.env.EEAT_COVER === '1' || process.env.EEAT_COVER === '2' || process.env.EEAT_COVER === '3';
// COVER V2 (EEAT_COVER=2, doctor 7 after the box-6 A/B): the coverage finder is the FALLBACK, only BEFORE the compile's first
// route (budget.fast): the field-following finders first (the core's best-first search with 1 - COVER_SHARE of its window,
// then the cover with the rest if it found nothing; the skeleton wrapper's direct leg, then the cover slot on the whole leg
// with COVER_SLOT of what is left, then the skeleton). V1 (EEAT_COVER=1) ran the cover FIRST on every call from rung 1 on:
// its legs (random rollouts, 1.0-2.3x the route's own before the tightening) took the legs the best-first search finds
// whole, and the controls' routes came 8-20% slower (box 6, 60 s: Ruins 1,614 vs 1,339, Desolate Caverns 1,923 vs 1,638,
// Bygone Tutorial 2,397 vs 1,990; the first routes 2,851 vs 1,819 on Desolate Caverns); after the first route the calls look
// for shorter legs, which random rollouts do not give
const COVER_V2 = () => process.env.EEAT_COVER === '2' || process.env.EEAT_COVER === '3';
// COVER V3 (EEAT_COVER=3): v2's core fallback, and the wrapper's slot NOT after the direct leg but after the SKELETON GOT
// STUCK (a sub-level set failed twice: the skeleton's own evidence that the field's way is not the ball's, the detour
// legs' signature: K Underground's sub-legs from the arrow block's face 10-52 cells each), with COVER_STUCK of what is
// left, the coverage finder alone on the whole leg from the step's starts; a skeleton that progresses keeps all its time
// (v1 / v2's slot took 40% / 26% of a far leg's budget from it: Accident Prone's trophy and switch legs, found by the
// skeleton at rung 3 (skel+math), were lost with v1)
const COVER_V3 = () => process.env.EEAT_COVER === '3';
const COVER_STUCK = process.env.EEAT_COVER_STUCK !== undefined ? Math.max(0.1, Math.min(1, +process.env.EEAT_COVER_STUCK || 0.6)) : 0.6;
const COVER_SHARE = process.env.EEAT_COVER_SHARE !== undefined ? Math.max(0.05, Math.min(0.95, +process.env.EEAT_COVER_SHARE || 0.4)) : 0.4;
const COVER_RUNG = process.env.EEAT_COVER_RUNG !== undefined ? +process.env.EEAT_COVER_RUNG : 1;
// (the skeleton wrapper's cover slot: that share of a far waypoint's budget, the coverage finder alone on the whole leg)
// (the coverage finder's region: the tiles the goal field's walk reaches within COVER_M tiles of the starts and the goal (the other
// finders' 24: a run-up can go 50 tiles away from both, K Underground's checkpoint (87,44) turns at (18,46)); 0 = no region)
const COVER_M = process.env.EEAT_COVER_M !== undefined ? Math.max(0, +process.env.EEAT_COVER_M || 0) : 64;
const COVER_SLOT = process.env.EEAT_COVER_SLOT !== undefined ? Math.max(0, Math.min(0.9, +process.env.EEAT_COVER_SLOT || 0)) : 0.4;
// THE CLOSEST IN THE WAYPOINT'S UNIT (doctor 7, n5-doc-7): OPT-IN EEAT_CLOSEST_UNIT=1. A call with no goal field (none fit
// its time: fieldFits, the field's measured build time x N over 0.4 of what is left) ran its finders on field null, and a
// finder's distance with no field is 0 for every state (legs.js distOf(null) = 0: the ranking by the tick alone), so the
// call's closest was its first child, ONE tick past the start, "closest 0 tiles". The skeleton's last leg to the waypoint
// from the starts (both sub-legs failed at the first level: stuck at the starts) gets what is left of the call (53 ms on
// EXPro Forgotten Veil's coin (13,110) at rung 0: a 400x200 level whose field needs more), and its report was returned
// as the call's: 15 of 226 failing steps of doctor 7's 19 levels (60 s) read "closest 0" at the anchor's own tile. The
// strategy read it as a near miss: the relay set at a state 1 tick from the anchor with dist 0 (then dropped with the
// floor below 0: no relay ever again for that (anchor, edge)), the trophy's precision landing (The Burj: 2 runs of 1.7-3.3
// s from a state 150+ tiles from the trophy, "no target"), the planner's est walls and cuts at the anchor's own tile.
// On: (1) the finders' closest is noted only when the call has a goal field (else the start, by the all-open field, as
// for a call that got nowhere); (2) the skeleton's last leg from the starts reports its closest re-measured on the
// waypoint's field f0 (skelClosest), like the skeleton's other failures. Off = the executor byte for byte as before.
const CLOSEST_UNIT = () => process.env.EEAT_CLOSEST_UNIT === '1';
// THE FIELD MEMO (doctor 9, n5; OPT-IN EEAT_FIELD_MEMO=1): a leg call builds its goal field only when fieldFits (the thread's
// slowest build so far x the level's tiles < 0.4 x the window); else it ran with NO field: every finder's distance reads 0
// (legs.js distOf), legBest orders by ticks alone and its closest is 0 at whatever state it kept first. On a big level that
// is most skeleton sub-legs: CDB Inc (400x200) in a 40-s compile: 54 leg calls without a field (sub-legs of 234-1,089 ms,
// the estimate 568-573 ms), though the waypoint's field (the sub-legs' own: goal.fieldTiles) was built for the wrapper,
// and the final's failure lines say "closest 0 tiles" at tiles 2,000+ field units from the target (the ball on a coin at
// (80,1), (75,9)); the planner's relays and CEGAR cuts read that 0. 163 of the 230 levels have >= 40,000 tiles (7 of them
// compiled in night 4's final vs 17 of the 67 smaller). With the knob: a field the thread has (the types.js memo) is used
// whatever the window, a skeleton sub-leg's field is built even past its window (the next sub-legs read it from the memo),
// and a call left without a field reports no closest (not a false 0). Off = the executor byte for byte as before.
const FIELD_MEMO = () => process.env.EEAT_FIELD_MEMO === '1';
// (EEAT_FIELD_SHARE=1, OPT-IN: the goal fields shared between the compile's threads, types.js THE SHARED FIELDS; the pool
// forwards a worker's fields to the main thread and the other workers; off = the executor byte for byte)
const FIELD_SHARE = process.env.EEAT_FIELD_SHARE === '1';
// (EEAT_FIELD_FIT: fieldFits' share of the window a build may take, 0.4; a measurement / test knob)
const FIELD_FIT = () => (process.env.EEAT_FIELD_FIT !== undefined ? +process.env.EEAT_FIELD_FIT : 0.4);
const COARSE_SHARE = process.env.EEAT_COARSE_SHARE !== undefined ? +process.env.EEAT_COARSE_SHARE : 0.5;
const COARSE_RUNG = process.env.EEAT_COARSE_RUNG !== undefined ? +process.env.EEAT_COARSE_RUNG : 1;
// THE RATE RULE (COMPILE-ALL lane 6, block 4): before the compile's first route the strategy marks its steps' budgets fast;
// a leg the finders found in such a call is tightened (3b), polished (polishLeg) and bounded by the exact search (2b) only
// for RATE_F x the time the call took to find it (at least RATE_MIN_MS), not for the rest of the window: those three used
// the whole window after every find (MIHB's Dream / Gingerbread House / Pancake Quest: 35% of the successful calls' worker
// time, a rung-1 leg found at 1 s answered at 5 s), and a PARTIAL level's legs run one after another from each other's
// arrivals. After the first route the budgets are not fast: the branch and bound's legs are tightened as before, and the
// polish stage polishes the route. Measured (box 3, 60 s, --workers=3, the lane's 12 RATE levels, side by side with the
// base): triggers 195 vs 173 on the 11 levels neither compiled (Tutorial 3 6 vs 1, Level 1 Overworld 48 vs 38, Pancake
// 16 vs 12), a second run 189; the cost: a first route built of untightened legs is slower (the shared gate: Accident
// Prone 4,243 vs 3,422 / 3,311 with EEAT_RATE=0, Rosa dei Venti 4,184 vs 3,815). OPT-IN since the check on the newer
// base (origin f18d62d, the box loaded ~120-145 of 192, side by side): the same 11 levels 137 vs 153 (The Glitch 5 vs 19,
// MIHB's Dream 16 vs 21; Level 1 Overworld 43 vs 37): the gain did not repeat, the route cost did; RATE_F 1.0 vs 0.5
// the same within the noise. EEAT_RATE=1: on; unset / 0: off, the executor byte for byte as before; EEAT_RATE_F,
// EEAT_RATE_MIN_MS.
const RATE_ON = process.env.EEAT_RATE === '1';
const RATE_F = process.env.EEAT_RATE_F !== undefined ? +process.env.EEAT_RATE_F : 0.5;
const RATE_MIN_MS = process.env.EEAT_RATE_MIN_MS !== undefined ? +process.env.EEAT_RATE_MIN_MS : 100;
const LEG_MODE = () => { const m = String(process.env.EEAT_EXEC_LEG || 'best'); return m === 'beam' || m === 'mix' ? m : 'best'; };
const BASE_FEATS = ['key0', 'key1', 'key2', 'key3', 'key4', 'key5', 'team', 'coins', 'bcoins', 'crown', 'silver', 'deaths', 'cp', 'fx', 'prot'];

// ---- THE COUNTEREXAMPLE WALLS (COMPILE-ALL lane 1, block 2): the goal field is a sound RELAXATION of the physics, so it is
// optimistic: on a one-leg level whose real way is a detour (Unforgiving Climb: the trophy field reads 53 tiles at the top
// conveyor's end (127, 2), the relaxation's way down through the up arrows into the dot room is no way the engine takes,
// the known route rides down the right shaft where the field reads 538 and climbs the whole level) every search ordered by
// it, and every level-set descent (the skeleton), stops at that false near (legBest EXHAUSTED its region there: 586 k pops,
// closest 52 tiles). A leg search that exhausted its region is a counterexample to the field's way: the tiles the field
// ranks below every tile the search reached (the least field cost of any state centred there), within WALL_RING tiles of
// a reached tile, in the search's region and never reached, are the relaxation's false passages out of the reached set:
// they become walls of the ORDERING fields of that waypoint's field tiles (the executor's goal field, the finders' bounds
// field, the primitives' guide; never the exact tier's cut field or a proof: a walled leg's failure is 'budget'), so the
// next calls for the same field (the next rung, the skeleton's sub-legs, a relay start) order by a field that routes around
// them. Ordering and search region only: every arrival is the engine's own replay, verified as before.
// EEAT_WALLS=0: off (the fields as before, byte for byte).
const WALLS_ON = process.env.EEAT_WALLS !== '0';
// (the trophy's field only by default: its one-leg levels are the false nears' class; on the coin legs of PARTIAL levels the
// walls cost progress: MIHB's Dream gain 11 -> 6 and 9 -> 5 in two pairs; EEAT_WALLS=all: every waypoint's field)
const WALLS_ALL = process.env.EEAT_WALLS === 'all';
// (COMPILE-ALL lane 4, block 3: every OTHER waypoint's field is walled too, but only once it is STUCK: its calls failed
// WALLS_STUCK_N times in a row with no nearer closest (by 1 tile, in one wall unit) — a field whose leg only needed more
// budget keeps its unwalled ordering (MIHB's loss with 'all'); the waypoint's tabu as the trophy's; EEAT_WALLS=trophy:
// the trophy's field alone, as before; EEAT_WALLS_STUCK: the count). Measured (box 3, 60 s, --workers=3, a137f8e): the
// lane's 23 levels side by side, progress 73 vs 72 (SPOT THE DIDFERNECE 9 vs 1, Rosa dei Venti 3,807 vs 3,969 run ticks;
// Ice Cream Expedition 2 vs 8), 'all' 77 (MIHB's Dream 23 vs 25); with the true skeleton closest and the planner's near
// plans on (both default since this block) the shared gate compiled 10 vs 9, worse 0, better 10 (Starlight 28, MIHB's
// Dream 24, Pancake Quest 12 vs 18 / 16 / 10; Ruins 1,303 vs 1,395 run ticks), The Glitch 12 vs the baseline's 4
const WALLS_STUCK = WALLS_ON && !WALLS_ALL && process.env.EEAT_WALLS !== 'trophy';
const WALLS_STUCK_N = +process.env.EEAT_WALLS_STUCK > 0 ? +process.env.EEAT_WALLS_STUCK : 2;
const WALL_RING = +process.env.EEAT_WALL_RING > 0 ? +process.env.EEAT_WALL_RING : 2;
const WALL_RING_MAX = 6;
const WALLS_MAX = 60000;
const WALL_POPS = +process.env.EEAT_WALL_POPS > 0 ? +process.env.EEAT_WALL_POPS : 100000;
const WALL_PLATEAU = +process.env.EEAT_WALL_PLATEAU > 0 ? +process.env.EEAT_WALL_PLATEAU : 0.5;
const WALL_NEAR = 3;
// (n5 lane 4, NEAR: the plateau at the goal's door walls too. The plateau rule left out a nearest within WALL_NEAR tiles,
// the last mile being the exact landing's, but that tier is opt-in (EEAT_NEAR) and its own measure found those near
// misses FALSE nears of the relaxation (lane 4 block 2): a trophy of several behind a one-way platform the field passes
// (Ice Cream Expedition, 300 s: 18 of its 26 trophy calls ended at (5,175) '2 tiles' from the trophy (5,177), solid on
// three sides under the platform (5,176)), a coin under a boost. With
// NEAR_WALLS the plateau there is a counterexample like any other: the tiles its field ranks below the nearest reached
// one, next to it, never entered (the platform) are walled for the ordering fields, and the field orders the other
// goal tiles / ways; walls that cut every start off are dropped as before. Ordering only. OPT-IN (EEAT_NEAR_WALLS=1;
// off = the rule before, byte for byte): box 5, the lane's 11 levels, 300 s, one run each (n5 lane 4 block 1): 143
// triggers on the 10 levels that fail vs 162 without it (the same code's runs differ by up to 10: Pancake Quest 33 /
// 42), Frostbitten compiled in both; Ice Cream Expedition 5 vs 9 (no wall was added to its trophy field: the cause not
// found yet); not shown to pay.
const NEAR_WALLS = process.env.EEAT_NEAR_WALLS === '1';
const PORTAL_IDS = new Set([242, 381, 374]);

// ---- THE MATH TIER (the MATH program's Wire stage, 2026-09-30): the leg EVALUATED by the mathematics of docs/ee_math.md
// before any search: src/plan/msolve.js (the move solver: the plain regime's closed-form gravity family x the input axis'
// exact 1D solver, the field extension src/math/fieldsolve.js, the coupled one-change piece; every answer replayed by the
// engine) from each start to the waypoint's tiles (the centre there: its 'any' class), then the executor's own goal test
// on the engine's replay (a trigger's touch is read at the next tick's start: the leg + 1 tick); the proof by the solver's
// certified plain bound or src/math/lb.js's event-graph bound (a leg of T = the bound ticks is PROVEN OPTIMAL). When no
// direct leg exists: CHAINS, msolve's A* (Dijkstra with an admissible claim) over support states with solved legs as
// edges, ordered by the goal field the executor built anyway. The search tiers (primitives, exact, finders) only for
// what the math does not cover; each leg they find is recorded as a PATTERN (its run-length inputs, its start's support
// class and speeds: the legs the mathematics must learn to evaluate) and gets the math's bound (lb.js certify: a proof
// where the bound reaches its ticks). EEAT_MATH=0: off (the executor as before, byte for byte).
// Its cost is kept in check (the gate's first two versions lost levels: the math took half of every window where it had
// nothing, and its cheapest entries into the skeleton's level sets were poor footholds): the direct legs get MATH_DIRECT
// of the window (at most MATH_DIRECT_MS), only from starts the endgame's sound bound puts within the solver's horizon,
// the coupled piece only where it puts the goal within MATH_COUPLED_NEAR ticks; the chains only from a start the goal
// field puts within MATH_CHAIN_TILES tiles; both shares follow the math's yield on the level (mathShare); no math on the
// skeleton's sub-legs (a sub-level set of the waypoint's field: the search tiers), on death steps or allowDeath legs.
// (lane 2's opt-in move-solver tier, EEAT_MSOLVE=1, takes its place: one math tier at a time)
const MATH_ON = () => process.env.EEAT_MATH !== '0' && process.env.EEAT_MSOLVE !== '1';
// THE CORRIDOR TIER (n5 chains lab, approach C; OPT-IN EEAT_CORRIDOR=1, off = the executor as before byte for byte:
// src/plan/lab/corridor.js is not even loaded): a FAR waypoint (every live start more than CORR_MIN tiles out by the goal
// field, where tier M2's chain does not run) gets a best-first search over the level's footholds (the goal field's
// sub-level sets of support spans), each expansion the move solver's short legs aimed at the next spans plus its cheap
// fans, K arrival states a foothold (the speed carries); CORR_SHARE of the window (at most CORR_MS), RESUMED by a later
// call from the same start state to the same tiles (the rungs add up); its chain is masks the engine replayed, checked
// here by the executor's goal test like every math leg (mathCands / finishMath)
const CORR_ON = () => process.env.EEAT_CORRIDOR === '1';
const CORR_MIN = +process.env.EEAT_CORR_MIN >= 0 && process.env.EEAT_CORR_MIN !== undefined && process.env.EEAT_CORR_MIN !== '' ? +process.env.EEAT_CORR_MIN : 30;
const CORR_SHARE = +process.env.EEAT_CORR_SHARE > 0 ? +process.env.EEAT_CORR_SHARE : 0.4;
const CORR_MS = +process.env.EEAT_CORR_MS > 0 ? +process.env.EEAT_CORR_MS : 6000;
const CORR_TMAX = +process.env.EEAT_CORR_TMAX > 0 ? +process.env.EEAT_CORR_TMAX : 3000;
// EEAT_CORR_REPLACE=1 (with EEAT_CORR_MIN=0): the corridor also takes tier M2's near chains (msolve.chain off)
const CORR_REPLACE = process.env.EEAT_CORR_REPLACE === '1';
const CORR_CLOSEST = process.env.EEAT_CORR_CLOSEST !== '0';
const CORR_OPTS = (() => { try { return process.env.EEAT_CORR_OPTS ? JSON.parse(process.env.EEAT_CORR_OPTS) : {}; } catch (e) { return {}; } })();
// EEAT_CORR_FIELDS=1 (n5-s99-fields; off = the corridor tier as before): the corridor's fields pass (lab/corridor.js o.goalFan,
// o.directShare, o.restKey, o.refine: the finer field cells only where a search ran out): the 681 field chains of the moves
// study 59.8-61.1% -> 80.3%+ side by side (tools/lab/corridor_chain.js)
const CORR_FIELDS = process.env.EEAT_CORR_FIELDS === '1' ? { goalFan: true, directShare: 0.15, restKey: true, refine: true, more: 1 } : null;
// NO RESTART PER RUNG (n5 lane 2): tier M2's chain search is RESUMED by a later call from the same start state to the same
// target tiles and horizon (msolve.js chain o.resume: its open list, seen states and best chain kept per worker, the newest
// 6): a stuck waypoint is retried from the same anchor's arrival at every rung and relay, and each 800-ms call re-expanded
// the same first nodes (a compile chain is ~4-10 expansions); now the calls add up. Ordering / time only: every chain is
// still the solver's replayed answer, checked here by the executor's goal test. EEAT_CHAIN_RESUME=0: a fresh search a call
const CHAIN_RESUME = process.env.EEAT_CHAIN_RESUME !== '0';
const MATH_DIRECT = +process.env.EEAT_MATH_DIRECT > 0 ? +process.env.EEAT_MATH_DIRECT : 0.15;   // the direct legs' share of the window
const MATH_CHAIN_SHARE = process.env.EEAT_MATH_CHAIN !== undefined ? +process.env.EEAT_MATH_CHAIN : 0.2;   // the chains' share (0: no chain)
const MATH_TMAX = +process.env.EEAT_MATH_TMAX > 0 ? +process.env.EEAT_MATH_TMAX : 120;   // a direct leg's horizon (the hold tables' 160 at most)
const MATH_CHAIN_TMAX = +process.env.EEAT_MATH_CHAIN_TMAX > 0 ? +process.env.EEAT_MATH_CHAIN_TMAX : 1200;
const MATH_STARTS = 4;
const MATH_DIRECT_MS = +process.env.EEAT_MATH_DIRECT_MS > 0 ? +process.env.EEAT_MATH_DIRECT_MS : 600;   // a call's direct legs at most this long
const MATH_CHAIN_MS = +process.env.EEAT_MATH_CHAIN_MS > 0 ? +process.env.EEAT_MATH_CHAIN_MS : 800;      // a call's chain at most this long
const MATH_CHAIN_TILES = +process.env.EEAT_MATH_CHAIN_TILES > 0 ? +process.env.EEAT_MATH_CHAIN_TILES : 30;   // a chain only from a start the goal field puts this near
/** the math's share of a window by its yield on this level so far (per core): the base share until minTries calls,
 *  then scaled by 4 x its success rate, between 0.15 and 1 of the base (a level whose legs the mathematics does not
 *  cover gives the search tiers their time back: First Person Maze's switch legs, 58 chains and direct calls, 0 legs,
 *  half of every window) */
function mathShare(base, tries, ok, minTries) {
	if (tries < minTries) return base;
	const rate = (ok + 0.5) / (tries + 1);
	return base * Math.max(0.15, Math.min(1, 4 * rate));
}
// an unproven math leg this short (ticks from the first start): the exact search bounded by it (a shorter leg, proven,
// or the proof that the math's leg is the minimum), at most MATH_UB_MS and a fifth of the window
const MATH_UB_MAX = process.env.EEAT_MATH_UB !== undefined ? +process.env.EEAT_MATH_UB : 40;
const MATH_UB_MS = +process.env.EEAT_MATH_UB_MS > 0 ? +process.env.EEAT_MATH_UB_MS : 500;
// the coupled piece (the one-change family over the 9 direction masks, the engine's replays: the solver's last resort)
// only where the endgame's sound bound puts the goal this near (ticks), at most MATH_COUPLED_TICKS simulated ticks
const MATH_COUPLED_NEAR = +process.env.EEAT_MATH_COUPLED_NEAR > 0 ? +process.env.EEAT_MATH_COUPLED_NEAR : 40;
const MATH_COUPLED_TICKS = +process.env.EEAT_MATH_COUPLED_TICKS > 0 ? +process.env.EEAT_MATH_COUPLED_TICKS : 150000;
// THE RUN-UP HORIZON (n5 lane 1): a leg whose only way first runs AWAY from the goal to build speed (a coin behind an
// opposing side-arrow band, a gap wider than a standing jump) is longer than MATH_TMAX and its one-change coupled member
// costs more than MATH_COUPLED_TICKS: Snow Jumping's coin (2,30) behind 4 right arrows from a standstill on its floor 5-11
// tiles out: hold left never gets there (stops 2-5 tiles short), the solver's coupled member "right 64-85 ticks, then left"
// is 156-192 ticks and 0.47-1.0 M simulated ticks (msolve.leg, Tmax 200 / 400); at Tmax 120 or 150 k ticks: 'budget'. So
// from rung MATH_RUNUP_RUNG on (the waypoint failed its short windows) the direct legs get the horizon MATH_RUNUP_TMAX,
// the coupled piece MATH_RUNUP_TICKS, the tier MATH_RUNUP_MS (x2 from the next rung) and at least MATH_RUNUP_SHARE of the
// window whatever the yield. EEAT_MATH_RUNUP=0: off, the tier as before byte for byte.
const MATH_RUNUP = process.env.EEAT_MATH_RUNUP !== '0';
const MATH_RUNUP_RUNG = +process.env.EEAT_MATH_RUNUP_RUNG > 0 ? +process.env.EEAT_MATH_RUNUP_RUNG : 2;
const MATH_RUNUP_TMAX = +process.env.EEAT_MATH_RUNUP_TMAX > 0 ? +process.env.EEAT_MATH_RUNUP_TMAX : 240;
const MATH_RUNUP_TICKS = +process.env.EEAT_MATH_RUNUP_TICKS > 0 ? +process.env.EEAT_MATH_RUNUP_TICKS : 1500000;
const MATH_RUNUP_MS = +process.env.EEAT_MATH_RUNUP_MS > 0 ? +process.env.EEAT_MATH_RUNUP_MS : 2500;
const MATH_RUNUP_SHARE = +process.env.EEAT_MATH_RUNUP_SHARE > 0 ? +process.env.EEAT_MATH_RUNUP_SHARE : 0.25;
const MATH_CERT = () => process.env.EEAT_MATH_CERT !== '0';   // the math bound on the search tiers' legs
// THE ARRIVALS a math leg leaves (iterate lane 'chains'): the direct leg's cheapest T is ONE end state (mostly full speed or
// launched), where the search tiers leave up to k diverse ones (T.pickDiverse over every goal state at the least depth);
// the next leg starts from them. The plain solver lists up to MATH_ALTS more verified legs with DISTINCT END STATES (vx,
// vy rounded, grounded) within MATH_ALT_SLACK ticks of its cheapest (the cheapest per class; the answer and its proof
// unchanged), each an arrival candidate here (EEAT_MATH_ALTS=0: the cheapest leg and its hop alone, as before)
// THE BACKWARD TIER (n5-lab-backward, OPT-IN EEAT_BACKWARD=1; off = the executor as before, byte for byte): a waypoint's
// leg by src/plan/lab/backward.js (the Bellman time to go of a macro-move closure of the leg's corridor, seeded around
// the target independently of the start, then A* over exact engine states from the real start with it: the meet), after
// the direct math legs and before the goal fields; BW_SHARE of the window (at most BW_MS), from the first BW_STARTS live
// starts; its legs go through the math tier's candidates (the engine's replay to the executor's goal, finishMath)
const BW_ON = () => process.env.EEAT_BACKWARD === '1';
const BW_SHARE = +process.env.EEAT_BW_SHARE > 0 ? +process.env.EEAT_BW_SHARE : 0.5;
const BW_MS = +process.env.EEAT_BW_TIERMS > 0 ? +process.env.EEAT_BW_TIERMS : 30000;
const BW_STARTS = +process.env.EEAT_BW_STARTS > 0 ? +process.env.EEAT_BW_STARTS : 2;
const BW_RUNGS = process.env.EEAT_BW_RUNGS !== '0';
// THE PORTFOLIO TIER (n5-s99-portfolio, OPT-IN EEAT_PORTFOLIO=1; off = the executor as before, byte for byte: portfolio.js
// is not even loaded): ONE call per stretch (src/plan/portfolio.js) runs the chains lab's solvers (the backward meet, the
// speed profile, the executor's own best-first leg finder, the corridor, msolve.chain) in one budget, in place of tiers
// M2 (msolve.chain), MC (the corridor), P (the profile) and B (the backward), which it contains; its share of the window by
// the rung (EEAT_PF_SHARES, default 0.3 / 0.4 / 0.5 / 0.6), at most EEAT_PF_MS (40 s) a call; A SESSION PER STRETCH (the
// start's state + the target): the rungs' calls are one continuous budget, projected as its share of the rungs to come
// (RUNG_PROJ), so a one-piece arm (the backward meet, the profile, the leg finder) runs once, whole, in the first call
// that holds its piece, and the resumable ones (the corridor, msolve.chain) go on where they stopped; its answer replayed
// by the executor's goal test like every math leg (mathCands / finishMath)
const PF_ON = () => process.env.EEAT_PORTFOLIO === '1';
const PF_SHARES = (process.env.EEAT_PF_SHARES || '0.3,0.4,0.5,0.6').split(',').map(Number);
const PF_MS = +process.env.EEAT_PF_MS > 0 ? +process.env.EEAT_PF_MS : 40000;
const PF_STARTS = +process.env.EEAT_PF_STARTS > 0 ? +process.env.EEAT_PF_STARTS : 1;
// (its arms: not the leg finder, which is this executor's own tier 3 on the rest of the window)
const PF_ARMS = process.env.EEAT_PF_ARMS || 'bw,prof,corr,chain';
const RUNG_PROJ = [1500, 5000, 15000, 45000];
const MATH_ALTS = process.env.EEAT_MATH_ALTS !== undefined ? +process.env.EEAT_MATH_ALTS : 6;
const MATH_ALT_SLACK = process.env.EEAT_MATH_ALT_SLACK !== undefined ? +process.env.EEAT_MATH_ALT_SLACK : 3;
// THE NEXT WAYPOINT (iterate 2 lane 'chains'): a chain's leg failed from the arrivals the leg before kept, not for the leg
// itself (test/planexec.js T-EXEC-CHAIN --chainStep=60 --chainRetry, box 3, 40 known routes: 26 of 29 first failures
// solve from the ROUTE's own state at the leg's start with the same budget, 17 of them by the math tier; the chain's
// arrival: the goal's first entry at its edge with the speed the cheapest leg left). budget.next (the plan's next
// waypoint) ranks the goal states by the arrival's tick + the NEXT leg's cost from it: the move solver's direct leg to the
// next waypoint (NEXT_TRY arrivals, NEXT_MS each, where it solves), else the endgame's sound bound; the best one is kept
// among the picked (EEAT_NEXT_FIRST=1: FIRST; one arrival more than k at most), and the math tier's own leg asks for NEXT_ALTS end states within NEXT_SLACK
// ticks. Ordering only: every arrival is still a verified first entry of this waypoint. OPT-IN (EEAT_NEXT=1; off = as
// before): on the chain harness (docs/ee_math.md 7.9) the rule with 12 alts in 6 ticks lost legs (1,125 vs 1,158 / 1,163 of
// 3,763), with the math tier's own 6 in 3 (the defaults here) a tie (1,162; kept among the picked, EEAT_NEXT_FIRST=0 the
// default: EEAT_NEXT_FIRST=1 puts it first, 987 vs 986 on 37 routes).
const NEXT_ON = () => process.env.EEAT_NEXT === '1';   // OPT-IN (7.9: a tie on the chain harness)
const NEXT_FIRST = process.env.EEAT_NEXT_FIRST === '1';   // (1: the next-best arrival first; else among the picked)
const NEXT_EVAL = 64, NEXT_TRY = +process.env.EEAT_NEXT_TRY > 0 ? +process.env.EEAT_NEXT_TRY : 6, NEXT_MS = +process.env.EEAT_NEXT_MS > 0 ? +process.env.EEAT_NEXT_MS : 25;
const NEXT_ALTS = +process.env.EEAT_NEXT_ALTS >= 0 && process.env.EEAT_NEXT_ALTS !== undefined ? +process.env.EEAT_NEXT_ALTS : 6;
const NEXT_SLACK = +process.env.EEAT_NEXT_SLACK >= 0 && process.env.EEAT_NEXT_SLACK !== undefined ? +process.env.EEAT_NEXT_SLACK : 3;
const PATTERNS_MAX = 400;
// THE SETTLE TEMPLATES (tier S, doctor 5; OPT-IN EEAT_SETTLE=1, off = the executor as before): d x k x rest x jump runs
// (reach(): settleCands), at most SETTLE_MS and SETTLE_F of the window, from the first SETTLE_STARTS live starts
const SETTLE_ON = () => process.env.EEAT_SETTLE === '1';
const SETTLE_MS = +process.env.EEAT_SETTLE_MS > 0 ? +process.env.EEAT_SETTLE_MS : 600;
const SETTLE_F = 0.35, SETTLE_STARTS = 2, SETTLE_K = 80, SETTLE_IDLE = 90, SETTLE_BRANCH = 30, SETTLE_TAIL = 60;
const SETTLE_JUMPS = [1, 4, 8, 14, 22];
/** a leg's inputs as runs: 'mask x count' joined by spaces (the pattern's code) */
function runsOf(tail) {
	const out = [];
	for (let i = 0; i < tail.length;) { let j = i; while (j < tail.length && (tail[j] & 31) === (tail[i] & 31)) j++; out.push(`${tail[i] & 31}x${j - i}`); i = j; }
	return out.join(' ');
}
/** the goal's extra tick after the centre enters its tiles: a coin or the trophy is TOUCHED at the next tick's start
 *  (1); a region is the centre's own tile (0); other triggers: null (their Expect may hold before the touch: no proof
 *  across the extra tick) */
function touchLagOf(goal, wp) {
	if (goal.kind === 'trophy') return 1;
	if (!wp.expect) return 0;
	return wp.expect.feat === 'coins' || wp.expect.feat === 'bcoins' ? 1 : null;
}
/** a level copy with the counterexample walls (tiles) made plain solids (9, as levelNow's shut doors): ordering only */
function withWalls(Lc, walls) {
	if (!walls || !walls.length) return Lc;
	const fg = Lc.fg.slice();
	for (const t of walls) if (t >= 0 && t < fg.length) fg[t] = 9;
	return Object.assign({}, Lc, { fg });
}
const tileMinMemo0 = new WeakMap();
/** per tile the least cost (fifths) of any ball state centred on it by the goal field f (walk mode: its walk); CUT none */
function tileMinOf(f) {
	let m = tileMinMemo0.get(f);
	if (m) return m;
	const N = f.W * f.H, CUT = RF.CUT;
	m = new Uint32Array(N).fill(CUT);
	if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) m[t] = f.walk ? f.walk[t] : CUT; }
	else {
		const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
		for (let t = 0; t < N; t++) {
			let v = CUT;
			for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
			for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
			const rc = f.rowC[t], rx = f.rowX[t];
			if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
			if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
			m[t] = v;
		}
	}
	tileMinMemo0.set(f, m);
	return m;
}
/** the counterexample walls of an exhausted leg search: the unreached tiles of its region within WALL_RING of a reached
 *  one that the field f ranks below every reached tile (not a goal / field tile, not a portal, not already solid in f) */
function wallsOf(L, f, vis, region, goal) {
	const W = L.width, H = L.height, N = W * H, CUT = RF.CUT;
	const tm = tileMinOf(f);
	let cmin = CUT, nv = 0;
	for (let t = 0; t < N; t++) if (vis[t]) { nv++; if (tm[t] < cmin) cmin = tm[t]; }
	if (!nv || cmin >= CUT || cmin === 0) return [];
	const keep = new Uint8Array(N);
	for (const t of goal.tiles) if (t >= 0 && t < N) keep[t] = 1;
	for (const t of T.fieldTilesOf(goal)) if (t >= 0 && t < N) keep[t] = 1;
	// (the ring widens, up to WALL_RING_MAX, while it finds no tile: the relaxation's way may leave the reached tiles by a
	// flight over a gap wider than the ring; tabu tiles (walls that once cut every start off) never)
	const tabu = goal.tabu || null;
	for (let R = WALL_RING; R <= WALL_RING_MAX; R++) {
		const out = [], seen = new Uint8Array(N);
		for (let t = 0; t < N; t++) {
			if (!vis[t]) continue;
			const x = t % W, y = (t / W) | 0;
			for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const u = yy * W + xx;
				if (seen[u] || vis[u] || keep[u] || tm[u] >= cmin) continue;
				if (region && !region[u]) continue;
				if (PORTAL_IDS.has(L.fg[u]) || (tabu && tabu.has(u))) continue;
				seen[u] = 1; out.push(u);
			}
		}
		if (out.length) return out;
	}
	return [];
}

// ================================================================ the core (one thread: a worker, or in-process)
/**
 * makeCore(L, co) -> {reach(startStrs, wp, budget) -> Promise<result with mask strings>, polish(str, o), stats}
 * co: {prims (a primitives object of THIS thread, or null), bounds (this thread's, or null), model (this thread's, or
 * null)}. budget: {ms, level, k, deadline, stop}.
 */
function makeCore(L, co) {
	co = co || {};
	const W = L.width, H = L.height, N = W * H;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const cache = new Map();
	const st = { calls: 0, ok: 0, fail: 0, byTool: {}, byWhy: {}, sims: 0, ms: 0, proven: 0 };
	// (the math: the move solver and the event-graph bound of this level, made on first use)
	let MS_ = null, MLB_ = null;
	const mathSolver = () => MS_ || (MS_ = require('./msolve.js').createSolver(L, { prove: true }));
	const mathLB = () => MLB_ || (MLB_ = require('../math/lb.js').createMathLB(L));
	let CR_ = null;
	const corridor = () => CR_ || (CR_ = require('./lab/corridor.js').createCorridor(L, { solver: mathSolver() }));
	const cY = { tries: 0, ok: 0 };   // (the corridor tier's yield on this level)
	let BW_ = null;
	const bwSolver = () => BW_ || (BW_ = require('./lab/backward.js').createBackward(L));
	let PF_ = null;
	const portfolio = () => PF_ || (PF_ = require('./portfolio.js').createPortfolio(L, { solver: mathSolver() }));
	const mY = { dTry: 0, dOk: 0, cTry: 0, cOk: 0 };   // (the math's yield on this level: calls and calls with a leg)
	const pY = { t: 0, ok: 0 };   // (the profile tier's yield on this level, EEAT_PROFILE=1: calls and calls with a leg)
	const fieldMs = { n: 0, perTile: 0 };
	let noFieldLegs = 0, noFieldMemo = 0, noFieldBuilt = 0;   // (FIELD_MEMO diagnostics: calls without a field, memo hits, sub-leg builds past the window)
	let analysis = null;

	/** the state after a masks string (a cached replay: the longest cached prefix, then the rest) */
	function startOf(str) {
		let e = cache.get(str);
		if (e) { cache.delete(str); cache.set(str, e); return e; }
		let from = null;
		for (const [k, v] of cache) if (k.length < str.length && (from === null || k.length > from.tick) && str.startsWith(k)) from = v;
		const masks = T.masksOf(str);
		let dead = false, deadAt = -1;
		if (from) sim.restore(from.snap); else sim.reset();
		for (let t = from ? from.tick : 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			if (sim.is_dead && deadAt < 0) deadAt = t + 1;
		}
		dead = !!sim.is_dead;
		e = { str, masks, tick: masks.length, snap: sim.snapshot(), dead, deadAt: from && from.deadAt >= 0 ? from.deadAt : deadAt, disc: X.discKey(sim), hash: sim.stateHash() };
		cache.set(str, e);
		if (cache.size > REPLAY_CACHE) cache.delete(cache.keys().next().value);
		return e;
	}
	/** an ordering goal field (no proof: reach.js portalForced + oneWayEntry) of the level as the doors stand at start s */
	const ordMemo = new Map();
	function ordFieldOf(s, goal, allowDeath) {
		sim.restore(s.snap);
		const Lc = T.levelNow(L, sim);
		const tiles = T.fieldTilesOf(goal);
		// (types.js plainOf: true = the plain-ball field (EEAT_FX_FIELD); an object = the ball's effect state (EEAT_FX_STATE))
		return ordFieldFx(Lc, tiles, allowDeath, T.wildOf(Lc.fg) ? T.plainOf(sim) : false);
	}
	function ordFieldFx(Lc, tiles, allowDeath, pfx, depth) {
		const key = `${T.fgHash(Lc.fg)}|${Array.from(tiles).sort((a, b) => a - b).join(',')}|${allowDeath ? 1 : 0}${T.fxSuffix(pfx)}${depth ? '|d1' : ''}`;
		let f = ordMemo.get(key);
		if (f) return f;
		const oo = { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: !!allowDeath, portalForced: true, oneWayEntry: true };
		if (pfx && typeof pfx === 'object') {
			oo.fxState = pfx;
			// (an exit seeded at the next state's ordering field there, one layer deep: types.js goalField's rule)
			if (!depth) oo.fxSeedCost = (i, s2) => {
				if (!s2) return -1;
				const g = ordFieldFx(Lc, tiles, allowDeath, s2, 1);
				if (!g || !g.fx) return -1;
				const c = RF.costAt(g, (i % Lc.width) * 16, ((i / Lc.width) | 0) * 16, 0);
				return c < 0 ? -1 : Math.round(c * 5);
			};
		} else if (pfx) oo.plainFx = true;
		f = RF.reachField(Lc, oo);
		// (EEAT_FX_STATE: a ball met in another modelled state: that state's ordering field, made on first use)
		if (pfx && typeof pfx === 'object') Object.defineProperty(f, 'fxOf', { value: (s2) => ordFieldFx(Lc, tiles, allowDeath, s2), enumerable: false });
		ordMemo.set(key, f);
		if (ordMemo.size > 8) ordMemo.delete(ordMemo.keys().next().value);
		return f;
	}
	/** THE PHYSICS ORDERING FIELD ON AN EFFECT LEVEL (doctor 8, n5-doc-8; OPT-IN EEAT_PHYS_STRIP=1): a level with jump / fly /
	 *  speed / low-gravity / multijump / gravity effect blocks makes the reach field a WALK (reach.js: gravity- and speed-
	 *  blind), and the finders order by it: 9 of the batch's 19 levels (Eurus, Fizio1, Polar Eclipse, Beat the Spikes 2,
	 *  Dreamland, Chain Link Clamber, NSFW Spring Relics, Gifts of Gaia, Forgotten Helix). Eurus's blue coin (61, 7): the
	 *  walk is lowest along rows 10-11 under the coin (a dead end from below), the known route builds -6.3 px/tick flying
	 *  up-left through a staircase of left arrows (rows 5-9) that legBest never visits (from 120 route ticks out, 5 s: rows
	 *  0-7 unvisited). While the ball has none of those effects (and the world gravity is 1) the field of the level with the
	 *  effect blocks as AIR (goexplore.js --fPhys's strip) is the physics the ball is in until it touches one: the finders'
	 *  ORDER only (their distances, the closest, the cuts stay the walk field's) */
	const STRIP_ON = process.env.EEAT_PHYS_STRIP === '1';
	const STRIP_WILD = new Set([417, 418, 419, 453, 461, 1517, 1618]);
	const stripMemo = new WeakMap();
	function stripFieldNow(goal, allowDeath, f0) {
		if (!STRIP_ON || !f0 || f0.mode !== 'walk' || L.gravityMult !== 1) return null;
		if (sim.has_levitation || sim.low_gravity || sim.speed_boost || sim.jump_boost || sim.max_jumps !== 1 || sim.flip_gravity) return null;
		if (sim.gravity_dir && (sim.gravity_dir.x !== 0 || sim.gravity_dir.y !== 1)) return null;
		let Ls = stripMemo.get(L);
		if (Ls === undefined) {
			let any = false;
			for (let i = 0; i < N; i++) if (STRIP_WILD.has(L.fg[i])) { any = true; break; }
			Ls = any ? L : null;
			stripMemo.set(L, Ls);
		}
		if (Ls === null) return null;
		const Lc0 = goal.walls ? withWalls(T.levelNow(L, sim), goal.walls) : T.levelNow(L, sim);
		const fg = Int32Array.from(Lc0.fg);
		for (let i = 0; i < N; i++) if (STRIP_WILD.has(fg[i])) fg[i] = 0;
		let f = null;
		try { f = T.goalField(Object.assign({}, Lc0, { fg }), T.fieldTilesOf(goal), { deaths: allowDeath }); } catch (e) { f = null; }
		return f && f.mode !== 'walk' ? f : null;
	}
	/** the goal field of the level as the doors stand in the state now in sim (memoized in types.js) */
	function fieldNow(goal, allowDeath) {
		const Lc = goal.walls ? withWalls(T.levelNow(L, sim), goal.walls) : T.levelNow(L, sim);
		const t0 = Date.now();
		const f = T.goalField(Lc, T.fieldTilesOf(goal), { deaths: allowDeath, plainFx: T.plainOf(sim) });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		return f;
	}
	/** a field build expected to fit the time left (an unknown level: yes) */
	const fieldFits = (left) => fieldMs.n === 0 || fieldMs.perTile * N < FIELD_FIT() * left;
	/** the goal field if this thread built it already (types.js memo), else null: no build */
	function fieldNowCached(goal, allowDeath) {
		const Lc = goal.walls ? withWalls(T.levelNow(L, sim), goal.walls) : T.levelNow(L, sim);
		return T.goalField(Lc, T.fieldTilesOf(goal), { deaths: allowDeath, plainFx: T.plainOf(sim), cachedOnly: true });
	}
	/** the move solver of this thread (n4-math msolve.js), made on first use */
	let msol = null;
	function msolver() { return msol || (msol = require('./msolve.js').createSolver(L, {})); }
	function steerA() {
		if (analysis) return analysis;
		try { analysis = require('../steer.js').analyze(L); } catch (e) { analysis = { cls: new Uint8Array(N), gateFeat: [] }; }
		return analysis;
	}

	async function reach(startStrs, wp, budget) {
		const tIn = Date.now();
		budget = budget || {};
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + (budget.ms > 0 ? budget.ms : 3000));
		const wEnd = deadline - VERIFY_MARGIN_MS;
		// (THE RATE RULE: before the compile's first route (budget.fast) a leg the finders found is tightened, polished and
		// bounded by the exact search only until pEnd, RATE_F x the time it took to find it (at least RATE_MIN_MS), not to
		// the window's end: the next leg starts from its arrival that much sooner)
		let pEnd = wEnd;
		const fast = RATE_ON && !!budget.fast;
		const stop = typeof budget.stop === 'function' ? budget.stop : null;
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		const rung = budget.level | 0;
		const goal = T.goalOf(L, wp);
		goal.over = X.overOf(wp);
		// (the counterexample walls of this waypoint's field, from the main thread's memo: ordering fields only)
		const walled = WALLS_ON && Array.isArray(wp.walls) && wp.walls.length > 0;
		if (walled) { goal.walls = wp.walls; goal.wallLc = withWalls(L, wp.walls); }
		if (WALLS_ON && Array.isArray(wp.wallsTabu) && wp.wallsTabu.length) goal.tabu = new Set(wp.wallsTabu);
		const allowDeath = !!wp.allowDeath;
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		st.calls++;
		let sims = 0;
		const tiers = [];
		// (the plan's next waypoint: the arrivals ranked by the next leg's cost from them, NEXT_ON above)
		let nextGoal = null;
		if (NEXT_ON() && budget.next && !allowDeath) { try { nextGoal = T.goalOf(L, budget.next); if (!nextGoal || !nextGoal.tiles || !nextGoal.tiles.length || nextGoal.fieldTiles) nextGoal = null; } catch (e) { nextGoal = null; } }
		const out = (r) => {
			r.ms = Date.now() - tIn; r.sims = sims; r.tiers = tiers;
			st.ms += r.ms; st.sims += sims;
			if (r.ok) { st.ok++; st.byTool[r.tool] = (st.byTool[r.tool] || 0) + 1; if (r.legs && r.legs.some((l) => l.proven)) st.proven++; }
			else { st.fail++; st.byWhy[r.fail.why] = (st.byWhy[r.fail.why] || 0) + 1; }
			return r;
		};
		const starts = startStrs.map((s) => startOf(String(s)));
		const t0 = Math.min(...starts.map((s) => s.tick));
		// (a start already at the goal: that start is the arrival, 0 ticks)
		const here = [];
		starts.forEach((s, i) => { sim.restore(s.snap); if (!s.dead && X.goalAt(goal, sim, s.tick, beforeTick)) here.push(i); });
		if (here.length) {
			const cands = here.map((i) => ({ start: i, tail: new Uint8Array(0), depth: starts[i].tick - t0 }));
			const r = finishFound(cands, 'exact', here.map((i) => ({ start: i, ticks: 0, lb: 0, proven: true, tool: 'exact' })), 0);   // (0 ticks: the exact search's depth 0)
			if (r) return out(r);
		}
		const live = starts.filter((s) => allowDeath || !s.dead);
		if (!live.length) return out(failResult('dies', null, 'every start is dead', rung, starts, goal, { deadline }));
		// (the coverage finder's own call, budget.cover 1 (the skeleton wrapper's COVER slot): the goal fields, then the
		// coverage finder alone for the whole window; its find goes on to the tightening like any finder's)
		const coverOnly = budget.cover === 1 && COVER_ON();
		// -------- tier M: THE MATH, the direct legs (before the goal fields: a leg the mathematics evaluates needs none)
		const mathOn = !coverOnly && MATH_ON() && !allowDeath && !wp.dieField && !goal.fieldTiles && goal.tiles.length > 0;
		const lag = touchLagOf(goal, wp);
		const mTarget = mathOn ? { tiles: Array.from(goal.tiles), cls: 'any' } : null;
		const mathLbE = new Map();   // start index -> the math's lower bound on its leg (the executor's ticks)
		if (mathOn && Date.now() < wEnd - 20) {
			const rUp = MATH_RUNUP && rung >= MATH_RUNUP_RUNG;
			const tM = Date.now(), mEnd = tM + (rUp ? Math.min(MATH_RUNUP_MS * (rung > MATH_RUNUP_RUNG ? 2 : 1), Math.max(MATH_RUNUP_SHARE, mathShare(MATH_DIRECT, mY.dTry, mY.dOk, 8)) * (wEnd - tM))
				: Math.min(MATH_DIRECT_MS, mathShare(MATH_DIRECT, mY.dTry, mY.dOk, 8) * (wEnd - tM)));
			const cands = [];
			let tries = 0, why = '', best = null, far = 0;
			const MS = mathSolver();
			let B0 = null;
			// (not for a skeleton sub-leg: its bound context is the waypoint's tiles, not the sub-level set's)
			const prof = { bMs: 0, hbMs: 0, legs: [] };
			if (!goal.fieldTiles) { const tb = Date.now(); try { B0 = X.boundFor(L, goal); } catch (e) { B0 = null; } prof.bMs = Date.now() - tb; }
			const mStarts = live.slice(0, MATH_STARTS);
			for (let mi = 0; mi < mStarts.length; mi++) {
				const s = mStarts[mi];
				const left = mEnd - Date.now();
				// (each start its share of the tier's clock: 1.5 x an even split of what is left, the last start all of it)
				const nLeft = mStarts.length - mi, dlS = Date.now() + (nLeft > 1 ? Math.min(left, 1.5 * left / nLeft) : left);
				if (left < 5) { why = why || 'time'; break; }
				const si = starts.indexOf(s);
				const Tmax = Math.min(rUp ? MATH_RUNUP_TMAX : MATH_TMAX, beforeTick >= 0 ? beforeTick - s.tick : Infinity);
				if (!(Tmax >= 1)) continue;
				// (a start the endgame's sound bound puts past the horizon: no direct leg exists there)
				let hb = 0;
				if (B0) { const th = Date.now(); sim.restore(s.snap); hb = require('../endgame.js').lowerBound(B0, sim, Tmax + 1); prof.hbMs += Date.now() - th; if (hb > Tmax) { far++; continue; } }
				const near = B0 !== null && hb <= MATH_COUPLED_NEAR;
				let r;
				try {
					r = MS.leg(s.snap, mTarget, { Tmax, chain: false, prove: true, proveMs: Math.max(2, Math.min(50, left / 4)), fieldMs: Math.max(5, Math.min(120, left / 2)),
						coupled: near, coupledTicks: Math.max(5000, Math.min(rUp ? MATH_RUNUP_TICKS : MATH_COUPLED_TICKS, Math.round(800 * left))), nodes: 400000,
						alts: nextGoal ? Math.max(MATH_ALTS, NEXT_ALTS) : MATH_ALTS > 0 ? MATH_ALTS : 0, altSlack: nextGoal ? Math.max(MATH_ALT_SLACK, NEXT_SLACK) : MATH_ALT_SLACK, deadline: dlS });
				} catch (e) { why = `error: ${e && e.message || e}`; continue; }
				tries++;
				prof.legs.push({ us: Math.round(r.us || 0), ok: !!r.ok, tool: r.tool || null, T: r.T || 0, pUs: Math.round(r.proveUs || 0), it: r.items || 0, v: r.verifies || 0, tk: r.ticks || 0, why: r.ok ? undefined : r.why, sp: r.split, su: r.plainSetup });
				sims += r.ticks || 0;
				// (the bound: the solver's plain bound only with its certificate, the event-graph bound when it has one)
				const lbE = Math.max(r.cert ? r.lb || 0 : 0, r.lbMath > 0 ? r.lbMath : 0) + (lag === 1 ? 1 : 0);
				if (lbE > (lag === 1 ? 1 : 0)) mathLbE.set(si, lbE);
				if (!r.ok) { why = r.why || why; continue; }
				const n0 = cands.length;
				mathCands(si, r.masks, r, cands, 'math:' + r.tool);
				if (r.hop) mathCands(si, r.hop, r, cands, 'math:' + r.tool);
				// (the solver's other end states: arrivals too, proven only at the cheapest leg's T)
				if (Array.isArray(r.alts)) for (const a of r.alts) mathCands(si, a.masks, Object.assign({}, r, { T: a.T, proven: !!r.proven && a.T === r.T }), cands, 'math:' + r.tool);
				for (let i = n0; i < cands.length; i++) if (!best || cands[i].depth < best.depth) best = cands[i];
			}
			if (tries > 0) { mY.dTry++; if (cands.length) mY.dOk++; }
			tiers.push({ tier: 'math', ms: Date.now() - tM, prof, tries, far, ok: cands.length > 0, tool: best ? best.leg.tool : null, T: best ? best.leg.ticks : null, proven: !!(best && best.leg.proven), provenBy: best ? best.leg.provenBy || null : null, why: cands.length ? null : why });
			if (cands.length) {
				// (a short leg the math found but did not prove: the exact search bounded by it (the tier 2b of the finders'
				// legs), a shorter leg (proven the minimum) or the proof that the math's leg is the minimum; the math's
				// families are not every input sequence (a key leg 39 ticks by the coupled piece, 37 by the exact search))
				const ub = best.depth;
				if (!best.leg.proven && MATH_UB_MAX > 0 && ub <= MATH_UB_MAX && Date.now() < wEnd - 20) {
					const tX = Date.now();
					const d0 = starts[0].disc;
					const rx = X.exactLeg(L, starts.map((s) => ({ snap: s.snap, tick: s.tick })), goal, { sim, allowDeath, beforeTick, bounds: co.bounds || null, field: null, discKey: X.discKey, disc0: d0,
						stop: () => (stop !== null && stop()), cap: rung <= 0 ? 150000 : 250000, maxDepth: ub - 1, deadline: tX + Math.min(MATH_UB_MS, 0.2 * (wEnd - tX)) });
					sims += rx.stats && rx.stats.ticks || 0;
					tiers.push({ tier: 'math-exact-ub', ms: Date.now() - tX, status: rx.status, maxDepth: ub - 1 });
					if (rx.status === 'found' && rx.goals && rx.goals.length) {
						const r = finishFound(rx.goals, 'exact', null, rx.depth, true, rx.depth);
						if (r) { delete r.arrivalsRaw; return out(r); }
					} else if (rx.status === 'proof') {
						for (const c of cands) if (c.depth === ub) { c.leg.proven = true; c.leg.provenBy = 'exact'; c.leg.lb = c.leg.ticks; }
					}
				}
				const r = finishMath(cands);
				if (r) return out(r);
			}
		}
		// -------- tier S: THE SETTLE TEMPLATES (OPT-IN EEAT_SETTLE=1; doctor 5): run d for k ticks, rest (no input) i ticks,
		// press jump j ticks, rest; the engine plays each and the goal test decides (settleCands). The x auto-align puts a
		// ball at rest exactly on the pixel grid only after it has stood a while (eesim.js: px = px | 0 once the remainder is
		// under 0.2), and that grid position is what a 1-tile-wide vertical gap takes; the finders' cells (2 px, 1/8 px/tick)
		// hold the FIRST arrival, so the later, aligned state of a resting ball is dropped. Stupid Fox's first leg (a 1-wide
		// shaft to the protection): no tier in 1.5 / 5 s from the spawn or from the run (closest 4 tiles at the shaft's
		// portal tile); the template from the spawn reaches it at tick 177 (the known route 181, which rests 55 ticks there).
		if (SETTLE_ON() && !allowDeath && !wp.dieField && goal.tiles.length > 0 && Date.now() < wEnd - 20) {
			const tS = Date.now(), sEnd = tS + Math.min(SETTLE_MS, SETTLE_F * (wEnd - tS));
			const cands = [];
			let n = 0;
			for (const s of live.slice(0, SETTLE_STARTS)) { n += settleCands(starts.indexOf(s), cands, sEnd); if (Date.now() >= sEnd) break; }
			tiers.push({ tier: 'settle', ms: Date.now() - tS, runs: n, ok: cands.length > 0 });
			if (cands.length) {
				cands.sort((a, b) => a.depth - b.depth);
				const r = finishFound(cands.slice(0, 64), 'settle', null, 0, false);
				if (r) { delete r.arrivalsRaw; return out(r); }
			}
		}
		// -------- tier PF: THE PORTFOLIO (OPT-IN EEAT_PORTFOLIO=1; the header's PF_*)
		const pfOn = PF_ON() && mathOn && !walled;
		if (pfOn && Date.now() < wEnd - 50) {
			const pr = Math.min(rung, 3);
			const share = PF_SHARES[Math.min(pr, PF_SHARES.length - 1)];
			const tP = Date.now(), pEndPF = tP + Math.min(PF_MS, share * (wEnd - tP));
			const cands = [];
			const pst = { tier: 'portfolio', tries: 0, ok: false, T: null, arm: null, arms: null, deferred: null, resumed: false };
			try {
				const P = portfolio();
				const pStarts = live.slice(0, PF_STARTS);
				for (let pi = 0; pi < pStarts.length && cands.length === 0; pi++) {
					const left = pEndPF - Date.now();
					if (left < 50) break;
					const s = pStarts[pi], si = starts.indexOf(s);
					const Tmax = Math.min(6000, beforeTick >= 0 ? beforeTick - s.tick : Infinity);
					if (!(Tmax >= 2)) continue;
					// (the session's projection: this call's piece and the shares of the rungs to come)
					let proj = 0;
					for (let q = pr + 1; q < RUNG_PROJ.length; q++) proj += PF_SHARES[Math.min(q, PF_SHARES.length - 1)] * RUNG_PROJ[q];
					const ms = pi === pStarts.length - 1 ? left : left / (pStarts.length - pi);
					const r = P.solve(s.snap, mTarget, { ms, deadline: Date.now() + ms, Tmax, total: Math.min(PF_MS * 2, ms + proj), arms: PF_ARMS });
					pst.tries++; pst.arms = r.arms; pst.deferred = r.deferred; pst.resumed = r.resumed;
					if (!r.ok) { pst.why = r.why; continue; }
					sims += r.T;
					pst.arm = r.arm;
					mathCands(si, r.masks, { T: r.T, proven: false, lb: 0, cert: false, lbMath: null }, cands, 'portfolio:' + r.arm);
				}
			} catch (e) { pst.why = 'error: ' + (e && e.message || e); }
			pst.ms = Date.now() - tP; pst.ok = cands.length > 0;
			if (cands.length) pst.T = Math.min(...cands.map((c) => c.leg.ticks));
			tiers.push(pst);
			if (cands.length) {
				const r = finishMath(cands, 'portfolio');
				if (r) return out(r);
			}
		}
		// -------- tier B: THE BACKWARD TIER (OPT-IN EEAT_BACKWARD=1; the header's BW_*)
		if (!pfOn && BW_ON() && !allowDeath && !wp.dieField && !goal.fieldTiles && goal.tiles.length > 0 && Date.now() < wEnd - 50) {
			// (BW_RUNGS: the tier by the rung: rung 0 the meet alone at 0.2 of the window, rungs 1-2 the closure too at 0.3,
			// from rung 3 at 0.6: the other tiers keep most of a short window (with 0.5 at rung 1 Endless Pain's known-route
			// leg, found by the leg tier alone in 1.8 s, failed its rung 1; with 0.6 at rung 2 Egg Quest II's and Frostbitten's,
			// found by the skeleton in its whole 15 s, failed); EEAT_BW_RUNGS=0: every rung at BW_SHARE)
			const bwR = BW_RUNGS ? Math.min(rung, 3) : 1;
			const bwShare = BW_RUNGS ? [0.2, 0.3, 0.3, 0.6][bwR] : BW_SHARE;
			const bwO = BW_RUNGS ? [{ closeF: 0, quickF: 1, quick: 400000 }, {}, {}, {}][bwR] : {};
			const tB = Date.now(), bEnd = tB + Math.min(BW_MS, bwShare * (wEnd - tB));
			const cands = [];
			const bst = { tier: 'backward', tries: 0, ok: false, T: null, why: null, stats: null };
			try {
				const B = bwSolver();
				const bStarts = live.slice(0, BW_STARTS);
				for (let bi = 0; bi < bStarts.length && cands.length === 0; bi++) {
					const left = bEnd - Date.now();
					if (left < 30) break;
					const s = bStarts[bi], si = starts.indexOf(s);
					const r = B.solve(s.snap, { tiles: Array.from(goal.tiles) }, Object.assign({ ms: bi === bStarts.length - 1 ? left : left / (bStarts.length - bi) }, bwO));
					bst.tries++;
					bst.stats = r.stats ? { cells: r.stats.cells, finite: r.stats.finite, meet: r.stats.meetExpanded, quick: !!r.stats.quick } : null;
					if (!r.ok) { bst.why = r.why; continue; }
					sims += r.T;
					mathCands(si, r.masks, { T: r.T, proven: false, lb: 0, cert: false, lbMath: null }, cands, 'backward');
				}
			} catch (e) { bst.why = 'error: ' + (e && e.message || e); }
			bst.ms = Date.now() - tB; bst.ok = cands.length > 0;
			if (cands.length) bst.T = Math.min(...cands.map((c) => c.leg.ticks));
			tiers.push(bst);
			if (cands.length) {
				const r = finishMath(cands, 'backward');
				if (r) return out(r);
			}
		}
		// -------- tier 0: the proof pre-check (and the goal fields for the cuts and the distances)
		let field0 = null, proofAll = true, anyField = false;
		const fields = new Map();   // disc -> field
		const startCost = [];
		for (const s of starts) {
			sim.restore(s.snap);
			let f = fields.get(s.disc);
			if (f === undefined) {
				if (fieldFits(wEnd - Date.now())) f = fieldNow(goal, allowDeath);
				else if (FIELD_MEMO()) {
					// (FIELD_MEMO: a field this thread has is used whatever the window; a skeleton sub-leg's field (the waypoint's
					// own, goal.fieldTiles) is built even past the window: every next sub-leg of the waypoint reads it from the memo)
					f = fieldNowCached(goal, allowDeath);
					if (f === null && goal.fieldTiles) { f = fieldNow(goal, allowDeath); noFieldBuilt++; st.fieldBuilt = noFieldBuilt; }
					else if (f !== null) { noFieldMemo++; st.fieldMemo = noFieldMemo; }
				} else f = null;
				if (f === null) { noFieldLegs++; st.noField = noFieldLegs; }
				fields.set(s.disc, f);
			}
			if (f === null) { proofAll = false; startCost.push(-2); continue; }
			anyField = true;
			if (field0 === null) field0 = f;
			const c = RF.costAt(f, sim);
			startCost.push(c);
			if (!(c < 0 && f.mode !== 'walk')) proofAll = false;
		}
		tiers.push({ tier: 'proof', ms: Date.now() - tIn, proof: anyField && proofAll, field: anyField ? 1 : 0 });
		if (!anyField && process.env.EEAT_NOFIELD_DBG === '1') console.error(`NOFIELD ${wp.label || wp.kind} left ${wEnd - Date.now()} ms est ${(fieldMs.perTile * N).toFixed(0)} ms rung ${budget.level | 0} (no field ${noFieldLegs}, memo ${noFieldMemo}, built ${noFieldBuilt})`);
		else if (FIELD_MEMO() && process.env.EEAT_NOFIELD_DBG === '1' && (noFieldMemo + noFieldBuilt) % 20 === 1) console.error(`FIELDMEMO memo ${noFieldMemo} built ${noFieldBuilt} none ${noFieldLegs}`);
		// (a death step's field is an ORDERING field (the tiles a death starts from, planner.js dieField), no proof)
		if (anyField && proofAll && !wp.dieField && !walled) return out(proofFail(starts[0], goal, wp, rung, 'the goal field of the level as the doors stand is -1 at every start', deadline));
		// (walls that cut every start off the waypoint were no counterexample of the field's way: the main thread drops them)
		if (anyField && proofAll && walled) { const fw = failResult('budget', null, 'the counterexample walls cut every start off', rung, null, null, { deadline }); fw.fail.wallsCut = true; return out(fw); }
		const disc0 = starts[0].disc;
		const sameDisc = starts.every((s) => s.disc === disc0);
		const cutField = sameDisc && field0 && field0.mode !== 'walk' && !walled ? field0 : null;
		const snaps = starts.map((s) => ({ snap: s.snap, tick: s.tick }));
		const stopFn = () => (stop !== null && stop());
		let closest = { dist: -1, masks: null };
		const noteClosest = (dist, sIdx, tail) => {
			if (!(dist >= 0) || tail === null || sIdx < 0) return;
			// (no goal field in this call: every finder's distance was 0, no measure: CLOSEST_UNIT / FIELD_MEMO above)
			if (field0 === null && (CLOSEST_UNIT() || FIELD_MEMO())) return;
			if (closest.dist < 0 || dist < closest.dist) closest = { dist, masks: T.concat(starts[sIdx].masks, tail) };
		};
		// -------- tier P: THE PROFILE (n5-lab-profile, approach B; OPT-IN EEAT_PROFILE=1, off = the executor before byte for
		// byte): src/plan/lab/profile.js, the bang-bang family's reachable set tick by tick from every live start (x holds one
		// key between switching events, the jump bit on the ticks whose move hits the floor, states merged by stateHash, the
		// front cut by this call's goal field's time to go, msolve.leg finishing from the front's best states), from rung
		// PROFILE_RUNG on, PROFILE_SHARE of the window; its arrivals replayed by the executor's own goal test. WHERE
		// (EEAT_PROFILE_AT): 'leg' (the default) in the leg finders' place (after the math, the primitives and the short exact
		// search, before tier 3; a leg it finds goes through the leg polish and the exact search bounded by it, as the finders'
		// legs), 'early' here (its first arrivals returned as they are)
		const profileTier = (pEnd) => {
			const tP = Date.now();
			const pst = { tier: 'profile', ok: false, at: PROFILE_AT };
			try {
				const PFm = require('./lab/profile.js');
				const idx = [];
				starts.forEach((s, i) => { if (!s.dead) idx.push(i); });
				if (!idx.length) return null;
				const f0 = fields.get(starts[idx[0]].disc) || null;
				const r = PFm.profileLeg(L, idx.map((i) => ({ snap: starts[i].snap, tick: starts[i].tick })), goal,
					{ deadline: pEnd, stop: stopFn, collect: 4 * k, extra: 2, beforeTick, field: f0 || undefined });
				sims += r.sims || 0;
				Object.assign(pst, { ms: Date.now() - tP, why: r.why, layers: r.layers, sims: r.sims, fin: r.finCalls, closest: r.closest });
				const cands = [];
				if (r.ok) for (const a of r.arrivals || []) { const i = idx[a.start]; cands.push({ start: i, tail: Uint8Array.from(a.masks), depth: starts[i].tick - t0 + a.masks.length }); }
				cands.sort((a, b) => a.depth - b.depth);
				pst.ok = cands.length > 0;
				pY.t++; if (pst.ok) pY.ok++;
				tiers.push(pst);
				return cands.length ? cands : null;
			} catch (e) { pst.error = String(e && e.message || e); pst.ms = Date.now() - tP; tiers.push(pst); return null; }
		};
		const profileOn = !pfOn && PROFILE_ON() && rung >= PROFILE_RUNG && !allowDeath && !wp.dieField;
		// (its share can follow its yield on the level, as the math's (mathShare): EEAT_PROFILE_YIELD=4 from its 4th call (0, the
		// default: the fixed share); measured (box 5, 60 s, W3): fail20 progress 45 vs 38, comp29 15 vs 13 compiled: no gain)
		const profileShare = () => {
			const b = rung <= 0 ? PROFILE_SHARE0 : PROFILE_SHARE;
			return PROFILE_YIELD > 0 ? mathShare(b, pY.t, pY.ok, PROFILE_YIELD) : b;
		};
		if (profileOn && PROFILE_AT === 'early' && Date.now() < wEnd - 50) {
			const cands = profileTier(Date.now() + profileShare() * (wEnd - Date.now()));
			if (cands) {
				const c0 = cands[0];
				const rP = finishFound(cands, 'profile', [{ start: c0.start, ticks: c0.tail.length, lb: 0, proven: false, tool: 'profile' }], 0);
				if (rP) { delete rP.arrivalsRaw; return out(rP); }
			}
		}
		// -------- tier 0b: THE EXACT END SEARCH from a NEAR state (within NEAR_T tiles of the goal by the goal field): a later
		// start (the strategy's relay: the last rung's nearest state) and, after the primitives and the exact tier, this
		// call's own nearest state; each alone and a few of its own ancestors (its masks cut NEAR_BACK ticks back: a near
		// state is often past its window, a coin passed, a gap overshot), the exact search (solveExact: every input tick by
		// tick, exact dedup, the admissible bound) from THAT state's own tick. The exact tier runs from every start at once
		// over absolute ticks from the earliest: a near start 300 ticks later enters only after 300 layers of the anchor's
		// states (it never got there), and nothing searched on from the finders' nearest state: Pancake Quest's coin legs
		// ended "closest 0" with the ball ON the coin's tile, the coin taken by the next tick's touch (lane 4 block 2). Not a
		// proof (a subset of the starts' futures): found = the finders' kind ('leg': the tightening and the exact bounded
		// search below run on it). OPT-IN (EEAT_NEAR=1; off = the code before, byte for byte): lane 4 block 2 (box 3, the 18
		// near-miss levels of b1, 60 s, --workers=3) ran it 91 times and it found 1 leg (Booty Return); gain sum 45 vs 48 /
		// 48 / 51 off (the 12% reserve of the finders' window costs more than it finds): those "near misses" are FALSE nears
		// of the goal field (Level 1 Overworld's coin (186,45) 1.4 tiles from a ball IN the portal column (187,42..45) that
		// teleports it; Two's coin (125,190) under an up boost, reached only from the shaft beside it; Katwalk's trophy 2
		// tiles through walls), not windows an exact search closes.
		const nearJobs = (strs) => {
			const jobs = [], seenJ = new Set();
			for (const s0 of strs) {
				for (const back of NEAR_BACK) {
					const len = s0.length - back;
					// (the base: the latest start this prefix extends; none, or a start itself when back > 0: skipped)
					let j = -1;
					for (let q = 0; q < starts.length; q++) if (starts[q].tick <= len && (j < 0 || starts[q].tick > starts[j].tick) && s0.startsWith(starts[q].str)) j = q;
					if (j < 0 || (back > 0 && starts[j].tick === len)) continue;
					const str = s0.slice(0, len);
					if (seenJ.has(str)) continue;
					seenJ.add(str);
					jobs.push({ str, base: j, w: back === 0 ? 2 : 1 });
				}
			}
			return jobs;
		};
		const nearEnd = (jobs, nEnd, what, nearest) => {
			const tN = Date.now();
			const wSum = jobs.reduce((a, x) => a + x.w, 0);
			let nFound = null, nRuns = 0;
			for (const jb of jobs) {
				const now = Date.now();
				if (now >= nEnd - 5 || stopFn()) break;
				const e = startOf(jb.str);
				if (e.dead) continue;
				sim.restore(e.snap);
				if (X.goalAt(goal, sim, e.tick, beforeTick)) { const b = starts[jb.base]; nFound = [{ start: jb.base, tail: e.masks.slice(b.tick), depth: e.tick - t0 }]; break; }
				const f = fields.get(e.disc);
				const jEnd = Math.min(nEnd, now + (nEnd - tN) * jb.w / wSum);
				const r = X.solveExact(L, [{ snap: e.snap, tick: e.tick }], goal, { sim, allowDeath: false, beforeTick, bounds: co.bounds || null, field: f && f.mode !== 'walk' ? f : null, discKey: X.discKey, disc0: e.disc, stop: stopFn, cap: NEAR_CAP, deadline: jEnd });
				nRuns++;
				sims += sumTicks(r);
				if (r.status === 'found' && r.goals && r.goals.length) {
					const b = starts[jb.base], pre = e.masks.subarray(b.tick);
					nFound = r.goals.map((g) => ({ start: jb.base, tail: T.concat(pre, g.tail), depth: e.tick - t0 + g.tail.length }));
					break;
				}
			}
			tiers.push({ tier: 'near', what, ms: Date.now() - tN, runs: nRuns, jobs: jobs.length, ok: !!nFound, nearest });
			if (!nFound) return null;
			const r = finishFound(nFound, 'leg', null, 0, false);
			if (r) delete r.arrivalsRaw;
			return r;
		};
		const nearOn = NEAR_ON() && !allowDeath && !coverOnly;
		if (nearOn && Date.now() < wEnd - 50) {
			const near = [];
			starts.forEach((s, i) => { const c = startCost[i]; if (s.tick > t0 && !s.dead && c >= 0 && c <= NEAR_T) near.push(i); });
			near.sort((a, b) => startCost[a] - startCost[b] || starts[b].tick - starts[a].tick);
			if (near.length) {
				const r = nearEnd(nearJobs(near.slice(0, NEAR_STARTS).map((i) => starts[i].str)), Date.now() + NEAR_F * (wEnd - Date.now()), 'start', startCost[near[0]]);
				if (r) return out(r);
			}
		}
		// -------- tier M: the move solver (OPT-IN EEAT_MSOLVE=1; the header's MSOLVE_*): the DIRECT legs here, before the
		// primitives (a solved move costs 20-500 ms); the CHAINS after them (below), only from rung 1 on and only when the
		// primitives found nothing (a chain costs 20-60 ms an expansion: at 35% of every window before the primitives the lane's
		// levels lost first legs, gain sum 140 vs the base's 153 / 139)
		const msolveTier = (phase, mEnd) => {
			const tM = Date.now();
			const mst = { tier: 'msolve', phase, legs: 0, chains: 0, found: 0, rejected: 0, expanded: 0, error: null };
			try {
				const S = msolver();
				const target = { tiles: Array.from(goal.tiles), cls: 'any' };
				const order = [];
				starts.forEach((s, i) => { if (!s.dead) order.push(i); });
				order.sort((a, b) => starts[a].tick - starts[b].tick);
				// (rung r: the r + 1 earliest starts, at most MSOLVE_STARTS: a failed direct leg costs 100-400 ms, the whole share of
				// a 1.5-s rung-0 window)
				const use = order.slice(0, Math.min(MSOLVE_STARTS, rung + 1));
				const cands = [];
				const horizon = beforeTick >= 0 ? beforeTick : Infinity;
				for (let q = 0; q < use.length && Date.now() < mEnd - 5 && !stopFn(); q++) {
					const i = use[q], s = starts[i];
					const tmax = Math.max(1, Math.min(MSOLVE_TMAX, horizon - s.tick));
					let r = null;
					if (phase === 'direct') {
						r = S.leg(s.snap, target, { Tmax: Math.min(MSOLVE_LEGT, tmax), chain: false, nodes: 100000, fieldMs: 100, coupledTicks: 300000, prove: true, proveMs: 30 });
						mst.legs++;
					} else if (tmax > 40) {
						// (the chain's clock: this start's share of what is left; ordered by this call's goal field)
						const ms = Math.max(5, (mEnd - Date.now()) / (use.length - q));
						const f = fields.get(s.disc);
						r = S.chain(s.snap, target, { ms, Tmax: tmax, legT: 80, fieldMs: 100, field: f ? f : undefined });
						mst.chains++;
						mst.expanded += (r && r.expanded) || 0;
					}
					if (!(r && r.ok && r.masks && r.masks.length)) continue;
					// (the leg replayed here by the executor's own goal test, a few ticks past its end for the touch; its landing
					// hop too when the solver verified one: the same leg with the jump on its last tick, another arrival state)
					for (const ms0 of r.hop ? [r.masks, r.hop] : [r.masks]) {
						sim.restore(s.snap);
						const n = ms0.length;
						const tail = [];
						let hit = -1;
						for (let t = 0; t < n + MSOLVE_TAIL; t++) {
							const m = t < n ? ms0[t] : (ms0[n - 1] & 30);
							E.applyMask(inp, m); sim.tick(inp); tail.push(m);
							sims++;
							if (sim.is_dead) break;
							if (X.goalAt(goal, sim, s.tick + t + 1, beforeTick)) { hit = t + 1; break; }
						}
						if (hit < 0) { mst.rejected++; continue; }
						mst.found++;
						// (PROVEN when the solver proved its T (no input sequence puts the centre in the target's tiles sooner from this
						// state: its certified plain bound or the event-graph bound, docs/ee_math.md 3.2 / 5) and the goal held at that
						// very tick: the goal needs the centre there at t or t - 1 (the touch), and the Expect only adds conditions)
						const proven = !!(r.proven && hit === r.T && ms0.length === r.T);
						if (proven) mst.proven = (mst.proven | 0) + 1;
						cands.push({ start: i, tail: Uint8Array.from(tail.slice(0, hit)), depth: s.tick + hit - t0, proven });
					}
				}
				mst.ms = Date.now() - tM;
				tiers.push(mst);
				if (cands.length) {
					// (the leg's claim is its own start's: lb and proven per leg; the result's lb over every start stays 0)
					cands.sort((a, b) => a.depth - b.depth);
					const c0 = cands[0];
					const legsM = [{ start: c0.start, ticks: c0.tail.length, lb: c0.proven ? c0.tail.length : 0, proven: !!c0.proven, tool: 'msolve' }];
					const rM = finishFound(cands, 'msolve', legsM, 0);
					if (rM) { delete rM.arrivalsRaw; return rM; }
				}
			} catch (e) { mst.error = String(e && e.message || e); mst.ms = Date.now() - tM; tiers.push(mst); }
			return null;
		};
		if (!coverOnly && MSOLVE_ON() && !allowDeath && Date.now() < wEnd - 20) {
			const rM = msolveTier('direct', Date.now() + MSOLVE_SHARE * (wEnd - Date.now()));
			if (rM) return out(rM);
		}
		// -------- tier M2: THE MATH, chains (msolve's A* over support states, solved legs as edges, the claim its certified
		// plain bound; ordered by the goal field this call built anyway (its -1 a proof in physics mode): from the start the
		// goal field puts nearest
		const nearMin = Math.min(...startCost.map((c, i) => (c >= 0 && !starts[i].dead ? c : Infinity)));
		if (!pfOn && mathOn && MATH_CHAIN_SHARE > 0 && nearMin <= MATH_CHAIN_TILES && !(CORR_ON() && CORR_REPLACE) && Date.now() < wEnd - 50) {
			const tC = Date.now(), cEnd = tC + Math.min(MATH_CHAIN_MS, mathShare(MATH_CHAIN_SHARE, mY.cTry, mY.cOk, 4) * (wEnd - tC));
			let bi = -1;
			starts.forEach((s, i) => {
				if (s.dead) return;
				const c = startCost[i];
				if (bi < 0 || (c >= 0 && (startCost[bi] < 0 || c < startCost[bi] || (c === startCost[bi] && s.tick < starts[bi].tick)))) bi = i;
			});
			const cands = [];
			let rc = null;
			if (bi >= 0) {
				const s = starts[bi];
				const Tmax = Math.min(MATH_CHAIN_TMAX, beforeTick >= 0 ? beforeTick - s.tick : Infinity);
				const f = !walled ? fields.get(s.disc) || null : null;
				if (Tmax >= 2) {
					// (CHAIN_RESUME: the same start state, target and horizon continue this worker's chain search where the last
					// call left it, instead of expanding the same first nodes again at every rung and relay)
					let resume;
					if (CHAIN_RESUME) {
						const MSv = mathSolver();
						MSv.sim.restore(s.snap);
						let th = 0x811c9dc5;
						for (const t of mTarget.tiles) { th ^= t; th = Math.imul(th, 0x01000193); }
						resume = `${MSv.sim.stateHash()}|${Tmax}|${mTarget.cls}|${mTarget.tiles.length}|${th >>> 0}`;
					}
					try { rc = mathSolver().chain(s.snap, mTarget, { ms: Math.max(10, cEnd - Date.now()), Tmax, field: f || null, rootLeg: false, resume }); }
					catch (e) { rc = { ok: false, error: String(e && e.message || e) }; }
					if (rc && rc.ok) mathCands(bi, rc.masks, { T: rc.T, proven: false, lb: 0 }, cands, 'math:chain');
				}
			}
			if (rc) { mY.cTry++; if (cands.length) mY.cOk++; }
			tiers.push({ tier: 'math-chain', ms: Date.now() - tC, ok: cands.length > 0, T: rc && rc.ok ? rc.T : null, closed: !!(rc && rc.closed), expanded: rc ? rc.expanded : 0, nodes: rc ? rc.nodes : 0, error: rc && rc.error ? rc.error : undefined });
			if (cands.length) { const r = finishMath(cands); if (r) return out(r); }
		}
		// -------- tier MC: THE CORRIDOR (opt-in, EEAT_CORRIDOR=1): a far waypoint's leg as a chain of short solver legs
		// between footholds, resumed across calls from the same start state
		if (!pfOn && CORR_ON() && mathOn && !walled && nearMin > CORR_MIN && Date.now() < wEnd - 100) {
			// (a near start in place of tier M2 (EEAT_CORR_REPLACE): M2's own share and cap, like for like)
			const nearC = CORR_REPLACE && nearMin <= MATH_CHAIN_TILES;
			const tC = Date.now(), cEnd = tC + (nearC ? Math.min(MATH_CHAIN_MS, mathShare(MATH_CHAIN_SHARE, mY.cTry, mY.cOk, 4) * (wEnd - tC)) : Math.min(CORR_MS, mathShare(CORR_SHARE, cY.tries, cY.ok, 6) * (wEnd - tC)));
			let bi = -1;
			starts.forEach((s, i) => {
				if (s.dead) return;
				const c = startCost[i];
				if (bi < 0 || (c >= 0 && (startCost[bi] < 0 || c < startCost[bi] || (c === startCost[bi] && s.tick < starts[bi].tick)))) bi = i;
			});
			const cands = [];
			let rc = null, corrCl = false;
			if (bi >= 0) {
				const s = starts[bi];
				const Tmax = Math.min(CORR_TMAX, beforeTick >= 0 ? beforeTick - s.tick : Infinity);
				if (Tmax >= 2) {
					const MSv = mathSolver();
					MSv.sim.restore(s.snap);
					let th = 0x811c9dc5;
					for (const t of mTarget.tiles) { th = (th ^ t) >>> 0; th = Math.imul(th, 0x01000193); }
					const resume = `${MSv.sim.stateHash()}|${Tmax}|${mTarget.tiles.length}|${th >>> 0}`;
					try { rc = corridor().solve(s.snap, mTarget, Object.assign({ M: 3, Mu: 1, legT: 90, RX: 18, RD: 30, subStop: 2, plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false }, CORR_FIELDS, CORR_OPTS, { ms: Math.max(10, cEnd - Date.now()), deadline: cEnd, Tmax, resume, first: true })); }
					catch (e) { rc = { ok: false, error: String(e && e.message || e) }; }
					if (rc && rc.ok) mathCands(bi, rc.masks, { T: rc.T, proven: false, lb: 0 }, cands, 'math:corridor');
					// (no chain: the corridor's most advanced state is the call's closest when it is nearer by the call's own goal
					// field: the strategy relays the next rung from it, so the corridor's progress carries; EEAT_CORR_CLOSEST=0 off)
					else if (rc && rc.bestMasks && rc.bestMasks.length && CORR_CLOSEST) {
						const full = T.concat(s.masks, rc.bestMasks);
						const d = field0 ? fieldDistOf(full, starts, field0) : rc.bestC;
						if (d >= 0 && (closest.dist < 0 || d < closest.dist)) { closest = { dist: d, masks: full }; corrCl = true; }
					}
				}
			}
			if (rc) { if (nearC) { mY.cTry++; if (cands.length) mY.cOk++; } else { cY.tries++; if (cands.length) cY.ok++; } }
			tiers.push({ tier: 'corridor', ms: Date.now() - tC, ok: cands.length > 0, T: rc && rc.ok ? rc.T : null, expanded: rc ? rc.expanded : 0, nodes: rc ? rc.nodes : 0, resumed: !!(rc && rc.resumed), closest: corrCl, c0: rc ? rc.c0 : null, bestC: rc ? rc.bestC : null, error: rc && rc.error ? rc.error : undefined });
			if (cands.length) { const r = finishMath(cands); if (r) return out(r); }
		}
		// -------- tier 1: the primitives
		if (!coverOnly && co.prims && typeof co.prims.route === 'function' && Date.now() < wEnd) {
			const t1 = Date.now();
			try {
				// (the primitives' share of the window: PRIMS_SHARE at rung 0, PRIMS_SHARE_HI from rung 1 on: a leg the primitives
				// did not find at rung 0 is mostly one their moves do not cover, and there they spent half of every rung while the
				// best-first finder needed it: Late christmas' first coin (26,44), 15 s, in-process: the primitives 7.4 s and the
				// finder's 6 s no leg, the primitives 0.7 s and the finder 10 s a 245-tick leg)
				const pEnd = t1 + (rung >= 1 ? PRIMS_SHARE_HI : PRIMS_SHARE) * (wEnd - t1);
				const arr = live.map((s) => { sim.restore(s.snap); return T.arrivalOf(L, sim, s.masks, null); });
				// (beforeTick: this file's -1 is 'none'; the primitives' is undefined: -1 there pruned every child, so the
				// primitives tier never found a leg in a compile)
				const nr = await co.prims.route(arr, goal, { ms: pEnd - t1, deadline: pEnd, stop: stopFn, k }, { allowDeath, beforeTick: beforeTick >= 0 ? beforeTick : undefined });
				sims += (nr && nr.sims) || 0;
				tiers.push({ tier: 'prims', ms: Date.now() - t1, ok: !!(nr && nr.ok) });
				if (nr && nr.ok && nr.arrivals && nr.arrivals.length) {
					const cands = [];
					for (const a of nr.arrivals) {
						const m = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
						const si = starts.findIndex((s) => m.length >= s.tick && T.strOf(m.subarray(0, s.tick)) === s.str);
						if (si >= 0) cands.push({ start: si, tail: m.slice(starts[si].tick), depth: m.length - t0 });
					}
					const legsP = cands.length ? [{ start: cands[0].start, ticks: cands[0].tail.length, lb: nr.lb >= 0 ? nr.lb : 0, proven: !!nr.proven, tool: 'prims' }] : [];
					const r = finishFound(cands, 'prims', legsP, nr.lb >= 0 ? nr.lb : 0);
					if (r) return out(mathCert(r));
				}
				if (nr && nr.closest && nr.closest.masks) {
					// (measured again in the finders' unit, field0's tiles: the primitives' own number is another field's (or
					// the bound's ticks), and the smaller number of two units made the closest the start in every compile)
					const m = nr.closest.masks instanceof Uint8Array ? nr.closest.masks : T.masksOf(nr.closest.masks);
					// (no goal field in this call: the primitives' number is their own unit's, no measure: CLOSEST_UNIT / FIELD_MEMO)
					const d = field0 && process.env.EEAT_CLOSEST_NEAR !== '0' ? fieldDistOf(m, starts, field0) : field0 === null && CLOSEST_UNIT() ? -1 : FIELD_MEMO() ? -1 : (nr.closest.dist >= 0 ? nr.closest.dist : 1e9);
					if (d >= 0 && (closest.dist < 0 || d < closest.dist)) closest = { dist: d, masks: m };
				}
			} catch (e) { tiers.push({ tier: 'prims', error: String(e && e.message || e) }); }
		}
		// -------- tier M, the chains (OPT-IN EEAT_MSOLVE=1, from rung 1 on: the primitives found nothing)
		if (!coverOnly && MSOLVE_ON() && !allowDeath && rung >= 1 && Date.now() < wEnd - 50) {
			const rM = msolveTier('chain', Date.now() + MSOLVE_CHAIN_SHARE * (wEnd - Date.now()));
			if (rM) return out(rM);
		}
		// -------- tier 2: the exact search, short (iterative deepening)
		const cap = rung <= 0 ? 150000 : rung === 1 ? 250000 : 300000;
		const baseX = { sim, allowDeath, beforeTick, bounds: co.bounds || null, field: cutField, discKey: X.discKey, disc0, stop: stopFn, cap };
		let lbAbs = 0, exactProof = false, legTime = false;
		let found = null;   // {cands, tool, proven, lbAbs}
		// (the counterexample walls: the tiles the finders reached, their region, whether the last best-first run exhausted it)
		let visW = null, regionW = null, bestExhausted = false, closedAll = false;
		if (!coverOnly) {
			const t2 = Date.now();
			// (its share: 35% where the goal can be near (the least start bound within X_NEAR ticks: the exact search's
			// reach, each tick of slack multiplying its states), else 12%: then it proves a lower bound and the finders get the
			// time)
			let h0 = Infinity;
			if (!allowDeath) { const B0 = X.boundFor(L, goal); for (const s of starts) { sim.restore(s.snap); const h = require('../endgame.js').lowerBound(B0, sim, X_NEAR + 1) + (s.tick - t0); if (h < h0) h0 = h; } }
			const xEnd = t2 + (h0 <= X_NEAR ? X_SHARE_NEAR : X_SHARE_FAR) * (wEnd - t2);
			const track = { dist: undefined };
			const r = X.solveExact(L, snaps, goal, Object.assign({}, baseX, { deadline: xEnd, track, distField: field0 }));
			sims += sumTicks(r);
			lbAbs = Math.max(lbAbs, r.lb || 0);
			tiers.push({ tier: 'exact', ms: Date.now() - t2, status: r.status, lb: r.lb, runs: r.runs });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else {
				if (r.exhausted && !goal.fieldTiles && !walled) exactProof = true;   // (a skeleton sub-leg's bound is its waypoint's: no proof)
				if (track.layer >= 0 && r.layers) { const p = X.pathOfKept(r.layers, track.layer, track.idx, snaps, r.t0); if (p) noteClosest(track.dist, p.start, p.tail); }
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- tier 0b again: the exact end search from this call's own nearest state (the primitives' or the exact tier's)
		if (nearOn && !found && !exactProof && closest.masks && closest.dist >= 0 && closest.dist <= NEAR_T && Date.now() < wEnd - 50) {
			const r = nearEnd(nearJobs([T.strOf(closest.masks)]), Date.now() + NEAR_F * (wEnd - Date.now()), 'closest', closest.dist);
			if (r) return out(r);
		}
		// -------- tier P in the finders' place (EEAT_PROFILE_AT=leg, the default; see tier P above)
		if (profileOn && PROFILE_AT === 'leg' && !found && !exactProof && Date.now() < wEnd - 50) {
			const cands = profileTier(Date.now() + profileShare() * (wEnd - Date.now()));
			if (cands) {
				found = { cands, tool: 'profile', proven: false, lbAbs };
				// (the finders bounded by it: the best-first search for a leg shorter than the tier's, its own first leg)
				if (PROFILE_TIGHT > 0 && Math.min(...cands.map((c) => c.depth)) > 1 && Date.now() < pEnd - 50) {
					const tq = Date.now();
					const ub = Math.min(...cands.map((c) => c.depth));
					const rq = LG.legBest(L, snaps, goal, { sim, deadline: tq + PROFILE_TIGHT * (pEnd - tq), stop: stopFn, allowDeath, beforeTick, field: field0, region: regionOf(field0, starts, goal), bounds: co.bounds || null, depthMax: ub - 1, w: +process.env.EEAT_BEST_W || 0, dieStep: !!wp.dieField });
					sims += rq.sims;
					tiers.push({ tier: 'profile-finders', ms: Date.now() - tq, status: rq.status, depth: rq.depth, ub });
					if (rq.status === 'found') found = { cands: rq.goals.concat(cands), tool: 'leg', proven: false, lbAbs };
				}
			}
		}
		// -------- tier 3: the fine-cell leg search
		if (!found && !exactProof && Date.now() < wEnd - 5) {
			// (the finders: the best-first search dives (the first leg, soonest), then the time-layered beam bounded by it
			// (a faster leg of the same kind); LEG_MODE 'beam' / 'best' (env EEAT_EXEC_LEG) for measurements)
			const region = regionOf(field0, starts, goal);
			// (EEAT_ORD_FORCED=1, a measurement: the best-first finder's field is an ORDERING field that is no proof, the
			// steer's options: portalForced (a portal tile with exits is left only through them) and oneWayEntry; with
			// EEAT_LEG_BF=0 it orders the search, else only its distances. The -1 cuts keep field0.)
			const fOrd = ORD_FORCED() && field0 && field0.mode !== 'walk' ? ordFieldOf(starts[0], goal, allowDeath) : null;
			regionW = region;
			const depthMax = beforeTick >= 0 ? beforeTick - t0 : 4000;
			const runBeam = (end, dmax) => LG.legBFS(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null,
				width0: 300, widthMax: 80000, depthMax: dmax, stall: 150 + 100 * rung });
			const cell0 = process.env.EEAT_BEST_CELL ? process.env.EEAT_BEST_CELL.split(',').map(Number) : null;
			// (EEAT_PHYS_STRIP=1: on an effect level whose field is a walk, the physics field with the effect blocks as air orders
			// the best-first search while the ball has no such effect; its closest is re-measured on the walk field (one unit))
			let fStrip = null;
			if (!fOrd && field0 && field0.mode === 'walk' && STRIP_ON) { sim.restore(starts[0].snap); fStrip = stripFieldNow(goal, allowDeath, field0); if (fStrip) st.stripUsed = (st.stripUsed || 0) + 1; }
			const runBest = (end, cell) => {
				const rb = LG.legBest(L, snaps, goal, { sim, deadline: end, stop: stopFn, allowDeath, beforeTick, field: fOrd || fStrip || field0, region, bounds: co.bounds || null, depthMax, w: +process.env.EEAT_BEST_W || 0, cell: cell || cell0, visited: visW, dieStep: !!wp.dieField });
				if (fStrip && rb && rb.closest && rb.closest.tail && rb.closest.start >= 0) {
					sim.restore(snaps[rb.closest.start].snap);
					for (let k = 0; k < rb.closest.tail.length; k++) { E.applyMask(inp, rb.closest.tail[k] & 31); sim.tick(inp); }
					const c = RF.costAt(field0, sim);
					rb.closest.dist = c < 0 ? 1e9 : c;
				}
				return rb;
			};
			const mode = LEG_MODE();
			if (WALLS_ON && (WALLS_ALL || T.fieldTouchOf(goal) || wp.wallsOn) && mode === 'best' && field0 && field0.mode !== 'walk') visW = new Uint8Array(N);
			const t3 = Date.now();
			// (EEAT_BEST_PORT=<f>: the first cells get that share of the window, then the next grain of the ladder the rest (a
			// measurement knob: a portfolio of grains instead of one)
			const port = +process.env.EEAT_BEST_PORT || 0;
			// (the finders end NEAR_RES of the window early: the exact end search from their nearest state gets it, below)
			const bEnd = nearOn ? wEnd - 3 - NEAR_RES * (wEnd - t3) : wEnd - 3;
			// (the coverage finder first from rung COVER_RUNG on, EEAT_COVER=1: COVER_SHARE of the finders' window)
			// (in the cover slot (coverOnly) the whole window and nothing after it; else not on a skeleton sub-leg (a sub-level
			// set: the field-following finders' job) nor on a call whose wrapper gave the cover its slot (budget.cover 2))
			let rV = null, rVf = null;
			// (V2: not first; the fallback below, before the compile's first route only)
			const coverV2 = COVER_V2() && !coverOnly && rung >= COVER_RUNG && !goal.fieldTiles && budget.cover !== 2 && !!budget.fast;
			const bEndB = coverV2 ? t3 + (1 - COVER_SHARE) * (bEnd - t3) : bEnd;
			if (COVER_ON() && (coverOnly || (!COVER_V2() && rung >= COVER_RUNG && !goal.fieldTiles && budget.cover !== 2)) && Date.now() < bEnd - 50) {
				const tv = Date.now();
				rV = LG.legCover(L, snaps, goal, { sim, deadline: tv + (coverOnly ? 0.97 : COVER_SHARE) * (bEnd - tv), stop: stopFn, allowDeath, beforeTick, field: field0, region: COVER_M > 0 ? regionOf(field0, starts, goal, COVER_M) : null, depthMax, seed: (t0 * 2654435761 + rung * 97 + goal.tiles.length) >>> 0 });
				sims += rV.sims;
				tiers.push({ tier: 'cover', ms: Date.now() - tv, status: rV.status, passes: rV.passes });
				if (process.env.EEAT_COVER_DBG === '1') console.error(`cover: rung ${rung} ${Date.now() - tv} ms of ${Math.round(COVER_SHARE * (bEnd - tv))} ${rV.status} cells ${rV.passes[0].cells} picks ${rV.passes[0].pops} sims ${rV.sims} closest ${rV.closest.dist} region ${region ? region.reduce((a, b) => a + b, 0) : 'none'}`);
				if (rV.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
				if (rV.status !== 'found' && rV.closest && rV.closest.tail) noteClosest(rV.closest.dist, rV.closest.start, rV.closest.tail);
				if (rV.status !== 'found') { rVf = rV; rV = null; }
			}
			if (coverOnly && rV === null) rV = rVf || { status: 'time', passes: [{ pops: 0, cells: 0, why: 'time' }], sims: 0, closest: { dist: -1, start: -1, tail: null, pop: -1 } };
			// (the coarse grain first from rung COARSE_RUNG on: COARSE_CELL above)
			let rC = null;
			if (rV === null && mode === 'best' && !cell0 && !port && COARSE_SHARE > 0 && rung >= COARSE_RUNG) {
				rC = runBest(t3 + COARSE_SHARE * (bEnd - t3), COARSE_CELL);
				sims += rC.sims;
				tiers.push({ tier: 'best', ms: Date.now() - t3, status: rC.status, passes: rC.passes, cell: COARSE_CELL });
				if (rC.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
				if (rC.status !== 'found' && rC.closest && rC.closest.tail) noteClosest(rC.closest.dist, rC.closest.start, rC.closest.tail);
			}
			const t3b = Date.now();
			let r = rV !== null ? rV : rC !== null && rC.status === 'found' ? rC : mode === 'beam' ? runBeam(bEndB, depthMax) : runBest(mode === 'best' ? (port > 0 && port < 1 ? t3 + port * (wEnd - t3) : bEndB) : t3 + 0.7 * (wEnd - t3));
			// (the default grain closed every way without a death (the ladder's finer grains may still run out of time): the
			// death leg's trigger, reachWp; an order, no claim)
			if (mode === 'best' && r.status === 'exhausted' && r !== rV) closedAll = true;
			if (r !== rC && r !== rV) {
				sims += r.sims;
				tiers.push({ tier: mode === 'beam' ? 'leg' : 'best', ms: Date.now() - t3b, status: r.status, passes: r.passes });
			}
			// (the refinement ladder: a best-first search that ran out of open states (its cells closed every way: the first
			// arrival's rule on coarse cells) goes again on finer cells while time is left; EEAT_BEST_LADDER=0 off)
			if (mode === 'best' && r !== rV && process.env.EEAT_BEST_LADDER !== '0') {
				for (const cell of LADDER) {
					if (!(r.status === 'exhausted' || (port > 0 && r.status === 'time')) || Date.now() >= wEnd - 20) break;
					if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail);
					const t7 = Date.now();
					r = runBest(bEndB, cell);
					sims += r.sims;
					tiers.push({ tier: 'best', ms: Date.now() - t7, status: r.status, passes: r.passes, cell });
				}
			}
			// (stuck: the region exhausted, or a plateau: no state nearer by the field in the last WALL_PLATEAU of its pops,
			// at least WALL_POPS of them, the nearest past WALL_NEAR tiles (the last mile is the exact landing's); with
			// NEAR_WALLS a plateau at the goal's door too: see its constant)
			{
				const pops = r.passes && r.passes[0] ? r.passes[0].pops : 0;
				const cp = r.closest && r.closest.pop >= 0 ? r.closest.pop : -1;
				const plateau = r.status === 'time' && cp >= 0 && pops >= WALL_POPS && cp < (1 - WALL_PLATEAU) * pops && (NEAR_WALLS || r.closest.dist > WALL_NEAR);
				bestExhausted = mode === 'best' && r !== rV && (r.status === 'exhausted' || plateau);
				if (mode === 'best' && r !== rV && r.status === 'exhausted') closedAll = true;
			}
			// (COVER V2: the coverage finder with the rest of the window when the field-following finders found nothing)
			if (coverV2 && r.status !== 'found' && r.status !== 'stopped' && Date.now() < bEnd - 50) {
				const tv = Date.now();
				const rv2 = LG.legCover(L, snaps, goal, { sim, deadline: bEnd, stop: stopFn, allowDeath, beforeTick, field: field0, region: COVER_M > 0 ? regionOf(field0, starts, goal, COVER_M) : null, depthMax, seed: (t0 * 2654435761 + rung * 97 + goal.tiles.length) >>> 0 });
				sims += rv2.sims;
				tiers.push({ tier: 'cover', ms: Date.now() - tv, status: rv2.status, passes: rv2.passes });
				if (rv2.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
				if (rv2.status === 'found') { if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail); r = rv2; rV = rv2; }
				else if (rv2.closest && rv2.closest.tail) noteClosest(rv2.closest.dist, rv2.closest.start, rv2.closest.tail);
			}
			if (mode === 'mix' && r !== rV && r.status !== 'stopped' && Date.now() < wEnd - 5) {
				const ub = r.status === 'found' ? Math.min(...r.goals.map((c) => c.depth)) : depthMax + 1;
				if (ub > 1) {
					const t5 = Date.now();
					const r2 = runBeam(r.status === 'found' ? t5 + 0.5 * (wEnd - t5) : wEnd - 3, ub - 1);
					sims += r2.sims;
					tiers.push({ tier: 'leg', ms: Date.now() - t5, status: r2.status, passes: r2.passes });
					if (r2.status === 'found' || r.status !== 'found') { if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail); r = r2; }
				}
			}
			if (r.status === 'found') found = { cands: r.goals, tool: 'leg', proven: false, lbAbs };
			if (found && fast) { const tf = Date.now(); pEnd = Math.min(wEnd, tf + Math.max(RATE_MIN_MS, RATE_F * (tf - tIn))); }
			// (the tightening: a leg found, the best-first search again with the kinematic bound in its order and only legs
			// shorter than it, half of what is left: T-EXEC-LEGS, box 3, 3 s: 77.0% vs 76.6%, the legs found 1.020 vs 1.046 of
			// the route's (median), shorter in 91 of the 202 both found, longer in none; EEAT_TIGHTEN=0 off; its weight 3
			// (EEAT_TIGHT_W): 77.4% either way, the legs 1.000 vs 1.007 (median), 1.303 vs 1.438 (p90), shorter in 66 of 204)
			if (found && process.env.EEAT_TIGHTEN !== '0' && Date.now() < pEnd - 50) {
				const tm = String(process.env.EEAT_TIGHTEN_MODE || 'best');
				// (EEAT_TIGHTEN_MODE: 'best' (the default), 'beam' (legBFS bounded by the leg: layered by tick, it keeps the
				// fastest state per cell), 'both' (the beam, then best-first on what is left of the share))
				const t8 = Date.now(), tEnd = t8 + (+process.env.EEAT_TIGHT_SHARE || 0.5) * (pEnd - t8);
				if (tm === 'beam' || tm === 'both') {
					const ub = Math.min(...found.cands.map((c) => c.depth));
					const rb = runBeam(tm === 'both' ? t8 + 0.6 * (tEnd - t8) : tEnd, ub - 1);
					sims += rb.sims;
					tiers.push({ tier: 'beam-tighten', ms: Date.now() - t8, status: rb.status, depth: rb.depth });
					if (rb.status === 'found' && rb.depth < ub) found.cands = rb.goals.concat(found.cands);
				}
				if (tm !== 'beam' && Date.now() < tEnd - 20) {
					const t9 = Date.now();
					const ub = Math.min(...found.cands.map((c) => c.depth));
					const r3 = LG.legBest(L, snaps, goal, { sim, deadline: tEnd, stop: stopFn, allowDeath, beforeTick, field: field0, region, bounds: co.bounds || null, depthMax: ub - 1, w: +process.env.EEAT_TIGHT_W || 3, cell: cell0, kbOn: true, noFinish: true });
					sims += r3.sims;
					tiers.push({ tier: 'best-tighten', ms: Date.now() - t9, status: r3.status, depth: r3.depth });
					if (r3.status === 'found' && r3.depth < ub) found.cands = r3.goals.concat(found.cands);
				}
			}
			else {
				if (r.closest && r.closest.tail) noteClosest(r.closest.dist, r.closest.start, r.closest.tail);
				if (r.status === 'time' || r.status === 'depth') legTime = true;
				if (r.status === 'stopped') return out(failResult('stopped', closest, 'stopped', rung, starts, goal, { deadline }));
			}
		}
		// -------- tier 0b a third time: the exact end search from the finders' nearest state, in the window they left
		if (nearOn && !found && !exactProof && closest.masks && closest.dist >= 0 && closest.dist <= NEAR_T && Date.now() < wEnd - 30) {
			const r = nearEnd(nearJobs([T.strOf(closest.masks)]), wEnd - 5, 'late', closest.dist);
			if (r) return out(r);
		}
		// -------- the leg found made shorter: polish.js polishLeg (exact windows from its end back: the waypoint sooner, the
		// leg's own state region sooner, exact rejoins; every change replayed from the start)
		if (found && (found.tool === 'leg' || found.tool === 'profile') && Date.now() < pEnd - 20 && process.env.EEAT_LEG_POLISH !== '0') {
			const t6 = Date.now();
			const c0 = found.cands.reduce((m, c) => (c.depth < m.depth ? c : m), found.cands[0]);
			const PO = require('./polish.js');
			const pl = PO.polishLeg(L, snaps[c0.start], c0.tail, goal, { sim, deadline: t6 + 0.6 * (pEnd - t6), allowDeath, beforeTick, stop: stopFn });
			tiers.push({ tier: 'leg-polish', ms: Date.now() - t6, saved: pl.saved, mutated: pl.mutated, windows: pl.windows });
			if (pl.saved > 0) found.cands.unshift({ start: c0.start, tail: pl.tail, depth: c0.depth - pl.saved });
		}
		// -------- tier 2b: the exact search bounded by the leg found (a shorter leg, or a proof that it is optimal)
		if (found && (found.tool === 'leg' || found.tool === 'profile') && Date.now() < pEnd - 5) {
			const t4 = Date.now();
			const ub = Math.min(...found.cands.map((c) => c.depth));
			const r = X.exactLeg(L, snaps, goal, Object.assign({}, baseX, { maxDepth: ub - 1, deadline: pEnd - 2 }));
			sims += r.stats.ticks;
			tiers.push({ tier: 'exact-ub', ms: Date.now() - t4, status: r.status, maxDepth: ub - 1 });
			if (r.status === 'found') found = { cands: r.goals, tool: 'exact', proven: true, lbAbs: r.depth };
			else if (r.status === 'proof') { found.proven = true; found.lbAbs = ub; }
		}
		if (found) {
			const minDepth = Math.min(...found.cands.map((c) => c.depth));
			const legs = [];
			const r = finishFound(found.cands, found.tool, null, found.proven ? minDepth : lbAbs, found.proven, minDepth);
			if (r) {
				// (teach the primitives every leg found: the move they lacked, derived from the physics)
				if (co.prims && typeof co.prims.learn === 'function' && found.tool !== 'prims') {
					try { for (const a of r.arrivalsRaw) { const s = starts[a.start]; sim.restore(s.snap); const from = T.arrivalOf(L, sim, s.masks, null); co.prims.learn(from, a.tail, a.arrival); } } catch (e) { /* optional */ }
				}
				delete r.arrivalsRaw;
				return out(mathCert(r));
			}
			void legs;
		}
		let why = exactProof ? 'exhausted' : (legTime || Date.now() >= wEnd - 5 ? 'budget' : 'exhausted');
		if (walled && why === 'exhausted') why = 'budget';   // (a walled field's region is no claim)
		const fr = failResult(why, closest, null, rung, starts, goal, { lbAbs, startCost, deadline });
		// (every best-first pass ran out of open states: the finders closed every way without a death; reachWp's death leg)
		if (closedAll && !allowDeath) fr.fail.closedAll = true;
		// (an exhausted best-first search: its reached tiles against the field, the counterexample walls; the relaxation's
		// way it could not take is no proof of anything: 'budget')
		if (visW && bestExhausted && field0) {
			try {
				const ws = wallsOf(L, field0, visW, regionW, goal);
				if (ws.length) { fr.fail.walls = ws; if (fr.fail.why === 'exhausted') fr.fail.why = 'budget'; }
			} catch (e) { /* ordering only */ }
		}
		return out(fr);

		// ---------------------------------------------------------------- the pieces
		/** a math leg (masks from start si; the solver's goal, the centre in the waypoint's tiles, first holds at its last
		 *  tick) as the executor's candidates: the engine's replay to the first tick the EXECUTOR's goal holds (a coin or
		 *  the trophy is touched at the next tick's start: up to 2 ticks more, the last direction held, released, with the
		 *  jump). The leg's proof carries over where that tick is the solver's T (+ the touch's lag of a coin / trophy) */
		function mathCands(si, masks, res, cands, tool) {
			const s = starts[si];
			const last = masks.length ? masks[masks.length - 1] & 30 : 0;
			const exts = [last, 0, last | 1].filter((e, i, a) => a.indexOf(e) === i);
			for (const e of exts) {
				sim.restore(s.snap);
				const n = masks.length + 2;
				const tail = new Uint8Array(n);
				let hit = 0;
				for (let t = 0; t < n; t++) {
					const m = t < masks.length ? masks[t] & 31 : e;
					tail[t] = m;
					E.applyMask(inp, m);
					sim.tick(inp);
					if (sim.is_dead) break;
					if (beforeTick >= 0 && s.tick + t + 1 > beforeTick) break;
					if (goal.test(sim)) { hit = t + 1; break; }
				}
				sims += n;
				if (!hit) continue;
				const proven = !!res.proven && (hit === res.T || (lag === 1 && hit === res.T + 1));
				const lbM = Number.isFinite(res.lbMath) ? res.lbMath : null;
				const lbE = proven ? hit : Math.min(hit, Math.max(res.cert ? res.lb || 0 : 0, lbM > 0 ? lbM : 0) + (lag === 1 ? 1 : 0));
				cands.push({ start: si, tail: tail.slice(0, hit), depth: s.tick + hit - t0,
					leg: { ticks: hit, lb: lbE, proven, provenBy: proven ? res.provenBy || 'plain' : null, lbMath: lbM, tool, T: res.T } });
				if (hit <= masks.length) break;   // (the goal within the solver's own leg: the extension did not matter)
			}
		}
		/** THE SETTLE TEMPLATES from start si (tier S): for d in (none, left, right), k = 0..SETTLE_K ticks of d, then rest
		 *  up to SETTLE_IDLE ticks, with a branch at every SETTLE_BRANCH-th rest tick (and the first tick at rest) pressing
		 *  jump j (SETTLE_JUMPS) ticks and resting SETTLE_TAIL more; every tick the executor's goal test (and beforeTick, a
		 *  death ends the run). The candidates (the goal's first tick of each run) go to cands; returns the runs played */
		function settleCands(si, cands, endT) {
			const s = starts[si];
			if (!s || s.dead) return 0;
			let runs = 0;
			const play = (m, tail) => { E.applyMask(inp, m); sim.tick(inp); sims++; tail.push(m); };
			const hitNow = (tail) => (!sim.is_dead && goal.test(sim) && !(beforeTick >= 0 && s.tick + tail.length > beforeTick));
			const push = (tail) => { cands.push({ start: si, tail: Uint8Array.from(tail), depth: s.tick + tail.length - t0, leg: null }); };
			// (k outer, the direction inner: the shortest runs of both directions first, so a clock cut keeps both)
			const pres = { 2: [], 4: [] }, snaps = { 2: s.snap, 4: s.snap }, done = { 2: false, 4: false };
			for (let k = 0; k <= SETTLE_K; k++) for (const d of k === 0 ? [0] : [2, 4]) {
				if (d !== 0 && done[d]) continue;
				if (Date.now() >= endT) return runs;
				const pre = d === 0 ? [] : pres[d];
				sim.restore(d === 0 ? s.snap : snaps[d]);
				if (d !== 0) {
					play(d, pre);
					if (sim.is_dead) { done[d] = true; continue; }
					if (hitNow(pre)) { push(pre); done[d] = true; continue; }
					snaps[d] = sim.snapshot();
				}
				{
					const snapK = sim.snapshot();
					const idle = pre.slice();
					let rested = false;
					for (let i = 0; i <= SETTLE_IDLE; i++) {
						if (i > 0) { play(0, idle); if (sim.is_dead) break; if (hitNow(idle)) { push(idle); break; } }
						const atRest = Math.abs(sim.speed_x) < 1e-3 && Math.abs(sim.speed_y) < 1e-3;
						if (!(i % SETTLE_BRANCH === 0 || (atRest && !rested))) continue;
						if (atRest) rested = true;
						const snapI = sim.snapshot();
						for (const j of SETTLE_JUMPS) {
							runs++;
							sim.restore(snapI);
							const tail = idle.slice();
							let hit = false;
							for (let q = 0; q < j + SETTLE_TAIL; q++) { play(q < j ? 1 : 0, tail); if (sim.is_dead) break; if (hitNow(tail)) { hit = true; break; } }
							if (hit) push(tail);
						}
						sim.restore(snapI);
					}
					sim.restore(snapK);
				}
			}
			return runs;
		}
		/** the math tier's result: the candidates verified and picked as every tier's (finishFound), each arrival's leg its
		 *  own (the proof per start) */
		function finishMath(cands, toolName) {
			let lbA = Infinity;
			for (let i = 0; i < starts.length; i++) {
				if (starts[i].dead) continue;
				const b = cands.some((c) => c.start === i && c.leg.proven) ? Math.min(...cands.filter((c) => c.start === i).map((c) => c.leg.ticks)) : mathLbE.get(i);
				lbA = Math.min(lbA, b === undefined ? 0 : starts[i].tick - t0 + b);
			}
			const r = finishFound(cands, toolName || 'math', (a) => Object.assign({ start: a._c.start }, a._c.leg), Number.isFinite(lbA) ? lbA : 0, false);
			if (r) delete r.arrivalsRaw;
			return r;
		}
		/** the math's bound on a search tier's legs (src/math/lb.js certify: admissible for the centre in the tiles; a leg
		 *  whose ticks it reaches is PROVEN OPTIMAL from its start), in the window left */
		function mathCert(r) {
			if (!mathOn || !MATH_CERT() || !r || !Array.isArray(r.legs)) return r;
			// (its own small clock: a search tier's leg mostly comes at its window's end, where wEnd leaves nothing (the
			// first full compile: a bound on 19 of 1,793 trigger / trophy legs); at most 120 ms, never past the deadline + 80 ms: the
			// call still answers within its budget + 200 ms)
			const certEnd = Math.max(wEnd, Math.min(deadline + 80, Date.now() + 120));
			for (const lg of r.legs) {
				const left = certEnd - Date.now();
				if (left < 10) break;
				if (!lg || lg.proven || !(lg.ticks > 0) || !starts[lg.start]) continue;
				const Tc = lg.ticks - (lag === 1 ? 1 : 0);
				if (!(Tc > 0)) continue;
				try {
					sim.restore(starts[lg.start].snap);
					const c = mathLB().certify(sim, { tiles: mTarget.tiles, mode: 'touch' }, Tc, { cap: 4000, ms: Math.min(30, left / 3) });
					if (c && c.lb !== null && c.lb >= 0) {
						lg.lbMath = c.lb;
						const lbE = c.lb + (lag === 1 ? 1 : 0);
						if (!(lg.lb >= lbE)) lg.lb = Math.min(lg.ticks, lbE);
						if (c.lb === Tc && c.proven) { lg.proven = true; lg.provenBy = 'events'; }
					}
				} catch (e) { /* the bound is optional */ }
			}
			return r;
		}
		/** the goal state (of arr: T.arrivalOf's) the NEXT waypoint's leg costs least from: the earliest NEXT_EVAL and the
		 *  picked ones ranked by tick + the endgame's sound bound to the next goal; the first NEXT_TRY of them get the move
		 *  solver's direct leg (NEXT_MS each, within the deadline); the least tick + T among those it solves, else the least
		 *  tick + bound. Ordering only (no claim). null: nothing to rank */
		function nextBest(arr, picked) {
			const tN = Date.now();
			const EGm = require('../endgame.js');
			let Bn = null;
			// (the bound context of the next goal: memoized per goal (exact.js boundFor); not built in the last 200 ms)
			if (deadline - tN > 200) { try { Bn = X.boundFor(L, nextGoal); } catch (e) { Bn = null; } }
			const byT = arr.slice().sort((a, b) => a.tick - b.tick).slice(0, NEXT_EVAL);
			for (const a of picked) if (!byT.includes(a)) byT.push(a);
			for (const a of byT) {
				let h = 0;
				if (Bn) { try { sim.restore(a.snap); h = EGm.lowerBound(Bn, sim, 240); } catch (e) { h = 0; } }
				a._nh = h;
			}
			byT.sort((a, b) => (a.tick + a._nh) - (b.tick + b._nh) || a.tick - b.tick);
			let best = null, bestS = Infinity;
			const MS = mathSolver(), nT = { tiles: Array.from(nextGoal.tiles), cls: 'any' };
			// (its own clock: at most a fifth of the call's window, NEXT_MS a leg)
			const nEnd = tN + Math.max(30, Math.min(NEXT_MS * NEXT_TRY, 0.2 * (deadline - tIn)));
			for (let i = 0; i < byT.length && i < NEXT_TRY; i++) {
				const now = Date.now();
				if (now > deadline - 60 || now > nEnd) break;
				const a = byT[i];
				let r = null;
				try { r = MS.leg(a.snap, nT, { Tmax: MATH_TMAX, chain: false, prove: false, fieldMs: Math.min(NEXT_MS, 20), coupled: false, nodes: 60000, deadline: Math.min(deadline - 50, nEnd, now + NEXT_MS) }); } catch (e) { r = null; }
				sims += r && r.ticks || 0;
				if (r && r.ok && a.tick + r.T < bestS) { bestS = a.tick + r.T; best = a; }
			}
			tiers.push({ tier: 'next', ms: Date.now() - tN, n: byT.length, ok: !!best, T: best ? bestS - best.tick : null });
			return best || byT[0] || null;
		}
		/** a result from goal candidates {start, tail, depth}: arrivals built, verified from the level start, picked */
		function finishFound(cands, tool, legsIn, lbA, proven, minDepth) {
			const arr = [];
			const seenH = new Set();
			for (const c of cands.slice(0, 4000)) {
				const s = starts[c.start];
				sim.restore(s.snap);
				for (let t = 0; t < c.tail.length; t++) { E.applyMask(inp, c.tail[t]); sim.tick(inp); }
				const masks = T.concat(s.masks, c.tail);
				const a = T.arrivalOf(L, sim, masks, null);
				if (seenH.has(a.hash)) continue;
				seenH.add(a.hash);
				a._c = c;
				arr.push(a);
				if (Date.now() > deadline - 20 && arr.length >= 1) break;
			}
			const picked = T.pickDiverse(arr, k);
			// (a CALM arrival too: pickDiverse ranks equal ticks by |vx| + |vy|, so a jump pressed on the goal tick is its
			// "earliest" and "fastest"; the next leg from a ball launched upward can be much longer (test/planexec.js's key
			// door level: 38 ticks from the calm state, none found in 3 s from the four launched ones))
			const calm = (a) => a.vy >= -0.5;
			if (picked.length && !picked.some(calm)) {
				let best = null;
				for (const a of arr) if (calm(a) && (!best || a.tick < best.tick || (a.tick === best.tick && Math.abs(a.vx) > Math.abs(best.vx)))) best = a;
				if (best) { if (picked.length >= k) picked[picked.length - 1] = best; else picked.push(best); }
			}
			// (the plan's next waypoint: the goal state the next leg costs least from, FIRST)
			if (nextGoal && arr.length > 1 && Date.now() < deadline - 60) {
				const nb = nextBest(arr, picked);
				if (nb && NEXT_FIRST) {
					const i = picked.indexOf(nb);
					if (i > 0) picked.splice(i, 1);
					if (i !== 0) picked.unshift(nb);
					if (picked.length > k + 1) picked.pop();
				} else if (nb && !picked.includes(nb)) {
					// (EEAT_NEXT_FIRST=0: kept among the picked, the order of before; one more than k at most)
					if (picked.length > k) picked[picked.length - 1] = nb; else picked.push(nb);
				}
			}
			const good = [];
			for (const a of picked) {
				const c = a._c;
				const s0 = starts[c.start];
				if (verifyTail(sim, inp, s0.snap, s0.tick, c.tail, goal, beforeTick, allowDeath)) good.push(a);
			}
			if (!good.length) return null;
			const md = minDepth !== undefined ? minDepth : Math.min(...cands.map((c) => c.depth));
			const legs = typeof legsIn === 'function' ? good.map(legsIn) : legsIn || good.map((a) => {
				const c = a._c, off = starts[c.start].tick - t0;
				return { start: c.start, ticks: c.tail.length, lb: Math.max(0, lbA - off), proven: !!proven && c.depth === md, tool };
			});
			const lb = Math.min(...starts.map((s, i) => Math.max(0, lbA - (s.tick - t0))));
			return { ok: true, arrivals: good.map((a) => ({ masks: T.strOf(a.masks), start: a._c.start, ticks: a._c.tail.length })), tool, legs, lb, fail: null,
				arrivalsRaw: good.map((a) => ({ start: a._c.start, tail: a._c.tail, arrival: a })) };
		}
	}

	/** the region of the leg search: tiles the goal field's walk reaches (dilated by a tile) in a box around the starts
	 *  and the goal */
	function regionOf(field, starts, goal, margin) {
		let x0 = W, y0 = H, x1 = -1, y1 = -1;
		const add = (t) => { const x = t % W, y = (t / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
		for (const s of starts) { sim.restore(s.snap); add(T.tileOf(sim, W, H)); }
		for (const t of goal.tiles) add(t);
		const M = margin > 0 ? margin : (+process.env.EEAT_REGION_M || 24);   // (tiles around the starts and the goal; env: measurements)
		x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(W - 1, x1 + M); y1 = Math.min(H - 1, y1 + M);
		const reg = new Uint8Array(N);
		const walk = field && field.walk ? field.walk : null;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const t = y * W + x;
			if (walk === null || walk[t] !== RF.CUT) { reg[t] = 1; continue; }
			// (a tile next to a reached one: the centre in a half block's tile, a door's edge)
			for (let dy = -1; dy <= 1 && !reg[t]; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < W && yy < H && walk[yy * W + xx] !== RF.CUT) { reg[t] = 1; break; }
			}
		}
		// (and anywhere in the level the tiles the walk puts no more than M tiles farther from the goal than the farthest
		// start: a portal's exits outside the box (Santa's Workshop: the start's portal to x 38, the goal at x 299; every
		// child cut, the search 'exhausted' after one pop))
		if (walk !== null) {
			let w0 = -1;
			for (const s of starts) { sim.restore(s.snap); const v = walk[T.tileOf(sim, W, H)]; if (v !== RF.CUT && v > w0) w0 = v; }
			if (w0 >= 0) {
				const lim = w0 + 5 * M;
				const add2 = [];
				for (let t = 0; t < N; t++) if (!reg[t] && walk[t] !== RF.CUT && walk[t] <= lim) add2.push(t);
				for (const t of add2) {
					reg[t] = 1;
					const x = t % W, y = (t / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) reg[yy * W + xx] = 1; }
				}
			}
		}
		// (the starts' own tiles always)
		for (const s of starts) { sim.restore(s.snap); reg[T.tileOf(sim, W, H)] = 1; }
		return reg;
	}

	/** a FailReport result: the closest state's details, the triggers its way touched, the gates blocking it */
	function failResult(why, closest, note, rung, starts, goal, extra) {
		const fail = { why, closest: null, touched: [], blockedBy: [], level: rung | 0, note: note || null };
		const dl = extra && extra.deadline ? extra.deadline : Infinity;
		if (closest && closest.masks && starts && goal) {
			const c = describe(closest.masks, closest.dist, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		} else if (starts && starts.length && goal) {
			// (no nearer state than the start: the start itself, by the all-open field)
			const c = describe(starts[0].masks, -1, starts, goal, dl);
			fail.closest = c.closest; fail.touched = c.touched; fail.blockedBy = c.blockedBy;
		}
		const r = { ok: false, arrivals: [], tool: null, legs: [], lb: extra && extra.lbAbs >= 0 ? extra.lbAbs : 0, fail };
		if (fail.closest) fail.closest.masks = T.strOf(fail.closest.masks);
		return r;
	}
	function proofFail(start, goal, wp, rung, note, dl) {
		const r = failResult('proof', null, note, rung, [start], goal, { deadline: dl });
		// (the proof's blockedBy: every shut gate on the all-open field's way from the start, not only near it)
		sim.restore(start.snap);
		r.fail.blockedBy = blockedOnWay(goal, sim, Infinity, wp.allowDeath, dl);
		return r;
	}
	/** the all-open goal field (the level itself: every door a door, open), when it is built already or fits the time */
	const plainBuilt = new Set();
	function plainField(goal, allowDeath, dl) {
		const key = `${Array.from(T.fieldTilesOf(goal)).join(',')}|${allowDeath ? 1 : 0}`;
		if (!plainBuilt.has(key) && !fieldFits(dl - Date.now())) return null;
		const t0 = Date.now();
		const f = T.goalField(L, T.fieldTilesOf(goal), { deaths: !!allowDeath });
		const dt = Date.now() - t0;
		if (dt > 2) { fieldMs.n++; fieldMs.perTile = Math.max(fieldMs.perTile, dt / N); }
		plainBuilt.add(key);
		return f;
	}
	/** a field's tiles at the end of masks that extend one of the starts (the longest start prefix; -1: no start, or the
	 *  field has no way there) */
	function fieldDistOf(masks, starts, field) {
		let s = null;
		for (const x of starts) if (masks.length >= x.tick && (!s || x.tick > s.tick) && T.strOf(masks.subarray(0, x.tick)) === x.str) s = x;
		if (!s) return -1;
		sim.restore(s.snap);
		for (let t = s.tick; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
		const c = RF.costAt(field, sim);
		return c < 0 ? -1 : c;
	}
	/** the closest state's report: replay its masks (the touched triggers since the leg's start), its tile, speed,
	 *  distance, and the gates blocking it */
	function describe(masks, dist, starts, goal, dl) {
		const s0 = starts[0];
		// (the start the masks extend: the longest start prefix)
		let si = 0;
		for (let i = 0; i < starts.length; i++) if (masks.length >= starts[i].tick && T.strOf(masks.subarray(0, starts[i].tick)) === starts[i].str) { si = i; break; }
		const s = starts[si] || s0;
		sim.restore(s.snap);
		const touched = [];
		const fv = featsOf(sim);
		for (let t = s.tick; t < masks.length; t++) {
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			const f2 = featsOf(sim);
			for (const [k, v] of f2) if (fv.get(k) !== v) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: v });
			for (const k of fv.keys()) if (!f2.has(k)) touched.push({ tile: T.tileOf(sim, W, H), kind: k, tick: t + 1, value: 0 });
			fv.clear(); for (const [k, v] of f2) fv.set(k, v);
		}
		const tile = T.tileOf(sim, W, H);
		let d = dist;
		if (!(d >= 0)) {
			try { const f = plainField(goal, false, dl); if (f) { const c = RF.costAt(f, sim); d = c < 0 ? -1 : c; } else d = -1; } catch (e) { d = -1; }
		}
		const closest = { masks, tile, dist: d, vx: sim.speed_x, vy: sim.speed_y, px: sim.px, py: sim.py, dead: !!sim.is_dead };
		const blockedBy = blockedOnWay(goal, sim, 2, false, dl);
		return { closest, touched: touched.slice(0, 64), blockedBy };
	}
	/**
	 * The gates (steer.js analyze: cls 3 with a feature) SHUT in the state in sim (is_tile_solid_now) on the all-open
	 * field's way from its tile to the goal (the RCH3 field of the level itself, every door open: its walk, descended), within
	 * `near` tiles (Chebyshev) of the state's tile (Infinity: all of them on the way).
	 */
	function blockedOnWay(goal, s, near, allowDeath, dl) {
		const A = steerA();
		let f;
		try { f = plainField(goal, allowDeath, dl === undefined ? Infinity : dl); } catch (e) { return []; }
		if (!f) return [];
		const walk = f.walk;
		if (!walk) return [];
		const t0 = T.tileOf(s, W, H);
		const x0 = t0 % W, y0 = (t0 / W) | 0;
		const out = [], got = new Set();
		const gateAt = (t) => {
			if (A.cls[t] !== 3) return;
			// (THE DEATH DOOR'S NEED, OPT-IN EEAT_NEEDS_DEATHS=1: a death door (1011, open from its number of deaths on) is an
			// 'open' gate to steer.js; shut on the way it is named as feature 'deaths', so the planner learns the step needs
			// that many deaths first: planner.js openValue)
			const feat = NEEDS_DEATHS() && A.gateFeat[t] === 'open' && L.fg[t] === 1011 ? 'deaths' : A.gateFeat[t];
			if (!feat || feat === 'static' || feat === 'open') return;
			const x = t % W, y = (t / W) | 0;
			if (Math.max(Math.abs(x - x0), Math.abs(y - y0)) > near) return;
			if (!s.is_tile_solid_now(x, y) || got.has(t)) return;
			got.add(t); out.push({ tile: t, feat, x, y });
		};
		// the way: the steepest descent of the walk from the tile (8-way), and the gates next to it
		let t = t0;
		if (walk[t] === RF.CUT) {
			// (the state's tile has no walk value: the nearest neighbour that has one)
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x0 + dx, yy = y0 + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (walk[j] !== RF.CUT && (bt < 0 || walk[j] < walk[bt])) bt = j; }
			if (bt < 0) return out;
			t = bt;
		}
		for (let steps = 0; steps < N && walk[t] > 0; steps++) {
			gateAt(t);
			const x = t % W, y = (t / W) | 0;
			let bt = -1;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (walk[j] !== RF.CUT && walk[j] < walk[t] && (bt < 0 || walk[j] < walk[bt])) bt = j;
			}
			if (bt < 0) break;   // (a portal: the way goes on at an exit the descent does not follow)
			t = bt;
		}
		gateAt(t);
		return out;
	}
	function featsOf(s) {
		const m = new Map();
		for (const f of (co.model && co.model.feats) || BASE_FEATS) { const v = T.featValue(s, f); if (!Number.isNaN(v)) m.set(f, v); }
		for (const [k, v] of s._switches) if (v === true) m.set(`psw:${k}`, 1);
		for (const [k, v] of s._oswitches) if (v === true) m.set(`osw:${k}`, 1);
		return m;
	}

	async function polish(str, o) {
		const P = require('./polish.js');
		return P.polishRoute(L, T.masksOf(str), Object.assign({}, o, { core: true }));
	}
	return { reach, polish, stats: () => Object.assign({}, st), startOf, L };
}
const sumTicks = (r) => (r && r.runs ? r.runs.reduce((a, x) => a + (x.ticks || 0), 0) : r && r.stats ? r.stats.ticks : 0);

/**
 * The leg's check, a replay from the level start: no death after the start tick (unless allowDeath), the goal test true
 * at the end with the ball alive (and at a tick <= beforeTick), and not before in the leg (the arrival is the leg's FIRST
 * goal state). (types.js playTo(...).goalAt === masks.length is the same test when the start's own masks never held the
 * goal: CONTRACT REQUEST in the report.)
 */
/** the verification of a leg from its start state (a snapshot of the state this thread reached by replaying the start's
 *  masks from the level start: startOf): the tail played, no death (unless allowed), the goal first at its end, beforeTick;
 *  the sim holds the arrival after a true */
function verifyTail(sim, inp, snap, startTick, tail, goal, beforeTick, allowDeath) {
	sim.restore(snap);
	const n = startTick + tail.length;
	for (let t = 0; t < tail.length; t++) {
		E.applyMask(inp, tail[t] & 31);
		sim.tick(inp);
		const u = startTick + t + 1;
		if (sim.is_dead && !allowDeath) return false;
		if (u < n && !sim.is_dead && (beforeTick < 0 || u <= beforeTick) && goal.test(sim)) return false;
	}
	return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || n <= beforeTick);
}

function verifyLeg(L, masks, goal, startTick, beforeTick, allowDeath) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const u = t + 1;
		if (u <= startTick) continue;
		if (sim.is_dead && !allowDeath) return null;
		if (u < n && !sim.is_dead && (beforeTick < 0 || u <= beforeTick) && goal.test(sim)) return null;
	}
	return !sim.is_dead && goal.test(sim) && (beforeTick < 0 || n <= beforeTick) ? sim : null;
}

/** a fixed input sequence's state hashes (the worker's level = this thread's level?) */
function fingerprint(L) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let x = 0x2545f491;
	const out = [L.width, L.height];
	for (let t = 1; t <= 400; t++) {
		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		E.applyMask(inp, (x >>> 0) % 18 === 17 ? 0 : [0, 1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 16, 17, 18, 20, 21, 6, 7][(x >>> 0) % 18] & 31);
		sim.tick(inp);
		if (t % 100 === 0) out.push(sim.stateHash());
	}
	return out.join(',');
}

// ================================================================ the main thread's executor
/** the Waypoint as plain data (it crosses threads)
 *  THE DEATH STEP'S FLAG (B7 cold, OPT-IN EEAT_WP_DIEFIELD=1; off = the data before byte for byte): the planner's death step
 *  (planner.js dieField: "die, back at a respawn") carries `dieField`, which the reach behind this copy reads (legBest's
 *  `dieStep`: the dead ball and the ball at a kill cell's door first, legs.js diePri; the proof pre-check's "an ordering
 *  field, no proof"; the math / settle / backward tiers' skip), but this copy dropped it: every death step ran its best-first
 *  search without the death priority, and its dive stopped on the killer's doorstep (Cold World: from the 4 anchors at
 *  chapter 1's end the step failed 30 rungs of 1.5-45 s, 9-14 M sims each; legBest alone with dieStep finds it in 0.1 s) */
const WP_DIEFIELD = () => process.env.EEAT_WP_DIEFIELD === '1';
const NEEDS_DEATHS = () => process.env.EEAT_NEEDS_DEATHS === '1';
const wpData = (wp) => Object.assign({ kind: wp.kind, tiles: wp.tiles ? Array.from(wp.tiles) : [], trig: wp.trig, expect: wp.expect ? { feat: wp.expect.feat, value: wp.expect.value } : null,
	label: wp.label || '', allowDeath: !!wp.allowDeath, beforeTick: wp.beforeTick >= 0 ? wp.beforeTick : -1,
	fieldTiles: wp.fieldTiles ? Array.from(wp.fieldTiles) : null, fieldTouch: !!wp.fieldTouch, wallsOn: !!wp.wallsOn },
	WP_DIEFIELD() && wp.dieField ? { dieField: true } : null);

async function createExecutor(L, opts) {
	opts = opts || {};
	const emit = typeof opts.emit === 'function' ? opts.emit : null;
	let nW = opts.workers === undefined || opts.workers === null ? Math.max(0, Math.min(4, os.cpus().length - 1)) : Math.max(0, opts.workers | 0);
	const note = [];
	if (nW > 0 && !opts.file) { note.push('no level file: the executor runs in-process'); nW = 0; }
	const core = makeCore(L, { prims: opts.prims || null, bounds: opts.bounds || null, model: opts.model || null });
	const vsim = new E.EESim(L), vinp = new E.EEInput();
	const RM = opts.RM || null;
	const S = { reach: 0, ok: 0, fail: 0, watchdog: 0, late: 0, hung: 0, verifyDrop: 0, polish: 0, byTool: {}, byWhy: {}, ms: 0, sims: 0, walls: 0, wallsReset: 0, wallsArmed: 0,
		// (the math tier: its calls and legs, and the PATTERNS: the legs the search tiers found, the mathematics' to-do list)
		math: { on: MATH_ON(), direct: 0, directOk: 0, directMs: 0, chain: 0, chainOk: 0, chainMs: 0, legs: 0, byTool: {}, proven: 0, provenBy: {}, certified: 0, arrivals: 0 },
		patternsN: 0, patterns: [] };
	let MSC_ = null;
	const mClsOf = (sim) => { try { MSC_ = MSC_ || require('./msolve.js'); return MSC_.clsOf(sim, L.flags); } catch (e) { return '?'; } };
	// (EEAT_EXEC_PROF=1, a measurement: every worker answer's prof (execworker.js) as an exec.prof event, late ones too;
	// this thread's RCH3 builds (the skeleton's fieldAt, the planner's) and its event-loop delay at close)
	const PROF = process.env.EEAT_EXEC_PROF === '1';
	const accM = { rf: 0, rfN: 0 };
	let rfMain0 = null, eld = null;
	if (PROF) {
		rfMain0 = RF.reachField;
		RF.reachField = function () { const t = Date.now(); try { return rfMain0.apply(this, arguments); } finally { accM.rf += Date.now() - t; accM.rfN++; } };
		try { eld = require('perf_hooks').monitorEventLoopDelay({ resolution: 10 }); eld.enable(); } catch (e) { eld = null; }
	}
	// ---- the pool
	const pool = [];
	let Worker = null;
	const queue = [];
	let jobId = 0;
	const spawn = (i) => {
		const w = new Worker(path.join(__dirname, 'execworker.js'), { workerData: { file: path.resolve(String(opts.file)), usePrims: !!opts.prims, useBounds: !!opts.bounds, seed: opts.seed | 0 } });
		const slot = { w, busy: null, i, dead: false };
		w.on('message', (msg) => {
			// (EEAT_FIELD_SHARE=1: a goal field this worker built: kept here (the skeleton's measure reads it) and handed to the
			// other workers; types.js THE SHARED FIELDS)
			if (FIELD_SHARE && msg && msg.type === 'field') {
				T.shareIn(msg.key, msg.f);
				for (const s of pool) if (s !== slot && !s.dead) { try { s.w.postMessage(msg); } catch (e) { /* gone */ } }
				return;
			}
			const job = slot.busy;
			if (!job || msg.id !== job.id) return;
			if (PROF && emit && msg.result && msg.result.prof) { const p = msg.result.prof; emit({ ev: 'exec.prof', w: i, label: job.label || '', late: !!job.late, ok: !!msg.result.ok, sims: msg.result.sims || 0, tiers: msg.result.tiers || null, queue: job.tDisp ? p.post - job.tDisp : 0, lat: p.recv - p.post, ret: Date.now() - p.end, wait: p.wait, run: p.run, init: p.init, rf: p.rf, rfN: p.rfN, bf: p.bf, bfN: p.bfN, ms: p.ms }); }
			slot.busy = null;
			if (job.clear) job.clear();
			job.done(msg);
			pump();
		});
		w.on('error', (e) => { const job = slot.busy; slot.busy = null; slot.dead = true; if (job) job.done({ id: job.id, error: String(e && e.message || e) }); replace(slot); });
		w.on('exit', () => { if (!slot.dead) { slot.dead = true; const job = slot.busy; slot.busy = null; if (job) job.done({ id: job.id, error: 'the worker exited' }); replace(slot); } });
		w.unref();
		return slot;
	};
	const replace = (slot) => {
		if (closed) return;
		const k = pool.indexOf(slot);
		if (k >= 0) pool[k] = spawn(slot.i);
		pump();
	};
	let closed = false;
	if (nW > 0) {
		Worker = require('worker_threads').Worker;
		for (let i = 0; i < nW; i++) pool.push(spawn(i));
		// (EEAT_FIELD_SHARE=1: the fields this thread builds (the skeleton's measure, the planner's checks) go to every worker)
		if (FIELD_SHARE) T.setFieldShare((key, f) => { for (const s of pool) if (!s.dead) { try { s.w.postMessage({ type: 'field', key, f }); } catch (e) { /* gone */ } } });
		// the workers' level must be this one: the same state hashes after a fixed input sequence
		const fp = fingerprint(L);
		const res = await Promise.all(pool.map((slot) => call(slot, { type: 'fp' }, Date.now() + 60000)));
		if (res.some((r) => !r || r.error || r.fp !== fp)) {
			note.push(`the workers' level differs from this one (${res.map((r) => (r && r.error) || (r && r.fp === fp ? 'same' : 'differs')).join(', ')}): the executor runs in-process`);
			for (const slot of pool) { slot.dead = true; try { slot.w.terminate(); } catch (e) { /* gone */ } }
			pool.length = 0; nW = 0;
		}
	}
	if (emit && note.length) emit({ ev: 'exec.note', note });
	/** a job on a given worker slot (its answer, or {error}) */
	function call(slot, msg, deadline, stopFlag) {
		return new Promise((resolve) => {
			const id = ++jobId;
			let settled = false;
			const done = (m) => { if (settled) return; settled = true; clearTimeout(timer); resolve(m); };
			slot.busy = { id, done, label: PROF && msg.wp ? msg.wp.label : '', tDisp: msg.tDisp || 0, late: false };
			const bj = slot.busy;
			slot.w.postMessage(Object.assign({ id, stopFlag, tPost: Date.now() }, msg));
			let hang = null;
			const timer = setTimeout(() => {
				if (settled) return;
				S.watchdog++;
				// (the worker did not answer in time: the caller gets 'budget' now, and the worker is told to stop (its next
				// clock check); it KEEPS its slot until its late answer (a synchronous part that overran: a goal field, a
				// bounds field, the primitives' tables, all memoized in that worker). It used to be terminated and replaced
				// here: the new worker's start-up (the level, the bounds, the primitives) and the fields it rebuilt overran
				// the next short budget too, killed again: a spiral with no simulation at all (Late christmas, 3 workers,
				// 1.5-s steps: 24 kills in the first 4 rounds, sims 0; the compiles' first 15-20 s of steps 'budget' with
				// sims 0). Only a worker silent for WORKER_HANG_MS past its deadline is replaced)
				done({ id, error: 'watchdog', watchdog: true });
				bj.late = true;
				if (stopFlag) { try { Atomics.store(new Int32Array(stopFlag), 0, 1); } catch (e) { /* none */ } }
				if (!WORKER_KEEP) { slot.dead = true; slot.busy = null; try { slot.w.terminate(); } catch (e) { /* gone */ } replace(slot); return; }
				S.late++;
				hang = setTimeout(() => {
					if (slot.dead || !slot.busy || slot.busy.id !== id) return;
					S.hung++;
					slot.dead = true; slot.busy = null;
					try { slot.w.terminate(); } catch (e) { /* gone */ }
					replace(slot);
				}, WORKER_HANG_MS);
				if (hang.unref) hang.unref();
			}, Math.max(10, deadline - Date.now()) + WATCHDOG_MS);
			slot.busy.clear = () => { if (hang) clearTimeout(hang); };
		});
	}
	function pump() {
		while (queue.length) {
			const slot = pool.find((s) => !s.busy && !s.dead);
			if (!slot) return;
			const q = queue.shift();
			if (Date.now() > q.deadline - VERIFY_MARGIN_MS) { q.resolve({ id: 0, error: 'queue', queued: true }); continue; }
			call(slot, q.msg, q.deadline, q.stopFlag).then(q.resolve);
		}
	}
	function dispatch(msg, deadline, stopFlag) {
		// (a queued job is answered at its deadline at the latest ('queue'), by a ref'd timer: with every slot held by a late
		// worker (WORKER_KEEP) the job waited for an answer from an unref'd worker, nothing kept the event loop alive, and the
		// process ended with code 0 in the polish, its verified route never written (Fish Gods, box 3, lane 4 b4: the moves
		// stage's in-flight steps late, the polish's mutscan jobs queued behind them); EEAT_QUEUE_TIMER=0: the rule before)
		return new Promise((resolve) => {
			const q = { msg, deadline, stopFlag, resolve };
			if (QUEUE_TIMER) {
				const tq = setTimeout(() => {
					const k = queue.indexOf(q);
					if (k >= 0) { queue.splice(k, 1); resolve({ id: 0, error: 'queue', queued: true }); }
				}, Math.max(10, deadline - Date.now()) + WATCHDOG_MS);
				q.resolve = (m) => { clearTimeout(tq); resolve(m); };
			}
			queue.push(q); pump();
		});
	}

	// ---- THE SKELETON (lane 3, COMPILE-ALL block 1): a far waypoint (the goal field's cost at the starts past SKEL_MIN
	// tiles) is reached through region sub-waypoints, the goal field's sub-level sets {t : the least cost of any state
	// centred on t <= c} for c = c0 - SKEL_STEP, c0 - 2 SKEL_STEP, ...: every way from the starts to the goal enters each
	// of them (the field's per-tile least cost changes by at most a step's move between neighbours: a sub-level set is a
	// cut of the level for the physics the field models), so a leg of ~SKEL_STEP tiles at a time, each started from the
	// last one's real (replayed) arrivals, k diverse; the arrivals of the deepest level reached are kept per (start,
	// waypoint) and the next call for the same step (the next rung) goes on from there instead of from scratch. Ordering
	// of the search only: every arrival is the engine's own replay, the final ones at the waypoint verified as before.
	// EEAT_SKEL=0: off (the direct leg as before); EEAT_SKEL_STEP / EEAT_SKEL_MIN (tiles).
	const SKEL_ON = process.env.EEAT_SKEL !== '0';
	const SKEL_STEP = +process.env.EEAT_SKEL_STEP > 0 ? +process.env.EEAT_SKEL_STEP : 12;
	const SKEL_MIN = +process.env.EEAT_SKEL_MIN > 0 ? +process.env.EEAT_SKEL_MIN : 30;
	const SKEL_DIRECT = process.env.EEAT_SKEL_DIRECT !== undefined ? Math.max(0, Math.min(0.9, +process.env.EEAT_SKEL_DIRECT || 0)) : 0.35;
	const DEATH_LEG = process.env.EEAT_DEATH_LEG !== '0';
	const canDieL = !!(opts.model && opts.model.canDie);
	const skelKey = (goal, wp, startStrs, wn) => `${goal.kind}|${Array.from(goal.tiles).slice(0, 64).join(',')}|${goal.tiles.length}|${wp.expect ? wp.expect.feat + '=' + wp.expect.value : ''}|${startStrs[0].length}:${startStrs[0].slice(-64)}|w${wn | 0}`;
	const skelMemo = new Map();   // key (goal, first start, walls) -> [{c, cur: [mask strings]}] (the levels reached, deepest last)
	// (THE FAR WAYPOINT'S WHOLE-LEG SHARES, B8 big cycle 3, OPT-IN EEAT_SKEL_FAR=<tiles>, unset / 0 = off, byte for byte:
	// the skeleton call's whole-leg tries (the direct leg first, its redirect on a bigger rung, the coverage finder's stuck
	// slot from the step's starts, the rest-direct leg from the deepest level) take the same SHARE of the call whatever the
	// way's length, and none of them can cover a way of thousands of tiles inside a rung window: on 20 big failing levels
	// (box 8, 300 s) the waypoints with c0 >= 1,000 tiles spent 2,291 of their 4,397 worker-s of steps in such legs, 0 of
	// 452 found (c0 >= 300: 4,714 s, 2 of 1,038), while their skeletons' sub-legs went 4,083 ok of 4,762. With the knob a
	// whole-leg try over a way of c > F tiles (by the field: c0 from the starts, cCur from the deepest level) gets its
	// share x F / c, and one under 100 ms is not made; the time goes to the skeleton (the direct leg's) or back to the
	// strategy (the stuck slot's, the rest-direct's). Ordering of the call's time only: every arrival as before.)
	const SKEL_FAR = +process.env.EEAT_SKEL_FAR > 0 ? +process.env.EEAT_SKEL_FAR : 0;
	const farF = (c) => (SKEL_FAR > 0 && Number.isFinite(c) && c > SKEL_FAR ? SKEL_FAR / c : 1);
	const SKEL_REDIRECT = process.env.EEAT_SKEL_REDIRECT !== '0';   // (DEFAULT ON since n5 lane 6 block 1; =0: off)
	const REDIRECT_F = +process.env.EEAT_SKEL_REDIRECT_F > 1 ? +process.env.EEAT_SKEL_REDIRECT_F : 2;
	const skelDirectMs = new Map();   // skelKey -> the largest direct-leg share tried (EEAT_SKEL_REDIRECT)
	// ---- THE SHARED APPROACH (n5-b8-big cycle 4, OPT-IN EEAT_SKEL_XLV=1; unset = the executor byte for byte): on a big
	// level the plan's far waypoints are tried from one anchor (Phina and the Rose, 300 s: 17 waypoints from the level start,
	// c0 4,100-4,570 tiles each, each skeleton walked from c0 again: blue coin (145,7) took rungs 1-3 (65 s) to go 4,181 ->
	// 29, the others stopped at 207-416 after their own 4,000-tile walks; no waypoint got a second epoch). The memo is per
	// waypoint, and cycle 2's EEAT_SKEL_XGOAL (another waypoint's DEEPEST level, under 0.5 x c0) never fired: the skeletons
	// end in different places. With the knob every level any waypoint's skeleton reached from the same first start is kept
	// (its arrival tile; XLV_CAP of them, the latest), and a call with no memo for its waypoint ranks them by this waypoint's
	// field at the starts (tileMin(f0) at the level's tile: no build), measures the XLV_TRY best on this waypoint's own field
	// at their doors (fieldAt, as a resumed level is), in XLV_MS at most, and starts from the least one under XLV_F x c0.
	// Its arrivals are real engine states from the same first start (only the arrivals prefixed by one of this call's starts
	// are kept: the final legs are prefixed by it as every resumed level's); a seeded level whose next sub-leg fails twice is
	// popped (the resumed level's rule) and not seeded again for this waypoint. Ordering / time use only, no claim.
	// ---- THE SETS' OWN MEASURE (n5-b8-big cycle 4, OPT-IN EEAT_SKEL_REMEAS=1; unset = byte for byte): a skeleton call's
	// level c is costAt (the ball's own state on the field), its sub-level sets are tileMin (any state at the tile) of the
	// same field, and after a sub-leg the level is set to the target c, not to where the arrivals stand. On an effect-state
	// field (reach.js costAt with f.fx) a state the physics part has no way for is priced walk + FX_FAR (4,000 tiles), so on
	// Phina and the Rose every waypoint's c0 was 4,100-4,600 where its tiles measure 180-600: each call walked ~4,000 phantom
	// tiles in ~90 trivial sub-legs (48-83 ms each, the arrivals already in every set: rung 2 of blue coin (145,7) went 4,181
	// -> 2,453 in its 15 s), 17 waypoints a level, and every new wall set re-measured it back up. With the knob the call's
	// start, a walls refresh and every found sub-leg take the least of that and the arrivals' tiles on the set's own tileMin
	// (they stand in the set, so at or below c): the next level from where they are. Ordering / time use only, no claim.
	const SKEL_REMEAS = process.env.EEAT_SKEL_REMEAS === '1';
	/** the least tileMin (tiles) over the arrivals' tiles (Infinity: none) */
	const tileCOf = (strs, m) => {
		let best = Infinity;
		for (const s of strs) {
			let e;
			try { e = core.startOf(String(s)); } catch (x) { continue; }
			if (!e || e.dead) continue;
			vsim.restore(e.snap);
			const t = T.tileOf(vsim, L.width, L.height);
			const v = t >= 0 && t < m.length ? m[t] : RF.CUT;
			if (v < RF.CUT && v / 5 < best) best = v / 5;
		}
		return best;
	};
	const SKEL_XLV = process.env.EEAT_SKEL_XLV === '1';
	const XLV_F = +process.env.EEAT_SKEL_XLV_F > 0 ? Math.min(0.95, +process.env.EEAT_SKEL_XLV_F) : 0.7;
	const XLV_TRY = +process.env.EEAT_SKEL_XLV_TRY > 0 ? +process.env.EEAT_SKEL_XLV_TRY | 0 : 6;
	const XLV_CAP = 512, XLV_MS = 1200, XLV_DBG = process.env.EEAT_SKEL_XLV_DBG > 0 ? +process.env.EEAT_SKEL_XLV_DBG | 0 : 0;
	const skelXL = new Map();      // the first start's string -> [{id, label, tile, cur}] (the levels of every waypoint's skeleton)
	const skelXLBad = new Set();   // skelKey + '#' + id: a seeded level that failed for that waypoint
	let skelXLId = 0;
	const xlPush = (startStrs, wp, cur) => {
		if (!SKEL_XLV || !cur || !cur.length) return;
		let e;
		try { e = core.startOf(String(cur[0])); } catch (x) { return; }
		if (!e || e.dead) return;
		vsim.restore(e.snap);
		const tile = T.tileOf(vsim, L.width, L.height);
		let xs = skelXL.get(startStrs[0]);
		if (!xs) { xs = []; skelXL.set(startStrs[0], xs); if (skelXL.size > 32) skelXL.delete(skelXL.keys().next().value); }
		xs.push({ id: ++skelXLId, label: wp.label || '', tile, cur: cur.slice() });
		if (xs.length > XLV_CAP) xs.splice(0, xs.length - XLV_CAP);
	};
	// ---- THE SKELETON ACROSS WALLS (n5 lane 4, RATE): the memo's key holds the waypoint field's wall count, and every
	// failed direct leg / sub-leg learns counterexample walls, so the next call for the same step (the next rung, the next
	// deepening) found no memo and started over at the step's starts: Sentinel Ravines' one trophy leg restarted 7 of its 8
	// fresh calls after new walls (c 896 reached at 63 s, c0 910 again at 64 s, 918 at 241 s, 953 at 299 s: 300 s of
	// sub-legs spent on the same first 40 tiles). Now the levels reached are kept per (goal, first start) whatever the walls
	// (SKEL_BASE_K, the latest), and a call with no memo for its walls re-measures them on its walled field (the doors of
	// each level's own arrivals) and resumes from the deepest one below its starts' cost (dead ends skipped). Ordering of
	// the search only: every arrival was the engine's replay, the final ones verified as before. EEAT_SKEL_REUSE=0: off.
	const SKEL_REUSE = process.env.EEAT_SKEL_REUSE !== '0';
	const SKEL_BASE_K = 12;
	const skelBase = new Map();   // key without the walls -> [{cur: [mask strings]}] (the latest SKEL_BASE_K levels)
	const baseKeyOf = (key) => key.replace(/\|w-?\d+$/, '');
	const skelBasePush = (key, cur) => {
		if (!SKEL_REUSE) return;
		const bk = baseKeyOf(key);
		let a = skelBase.get(bk);
		if (!a) { a = []; skelBase.set(bk, a); }
		a.push({ cur: cur.slice() });
		if (a.length > SKEL_BASE_K) a.shift();
	};
	// (the counterexample walls per field: the waypoint's field tiles, their touch rule and deaths -> a Set of tiles; a
	// skeleton's sub-legs order by their waypoint's field, so they share its walls)
	const wallMemo = new Map(), wallBatches = new Map(), wallTabu = new Map();
	// (WALLS_STUCK: per field key {n: failed calls in a row with no nearer closest, d: that closest, u: its wall unit, on})
	const wallStuck = new Map();
	const stuckNote = (wp, r) => {
		if (!WALLS_STUCK || !wp || wp.beforeTick >= 0) return;
		let wk;
		try { wk = wallKeyOf(wp); } catch (e) { return; }
		let s = wallStuck.get(wk);
		if (!s) { s = { n: 0, d: Infinity, u: -1, on: false }; wallStuck.set(wk, s); }
		if (s.on) return;
		if (!r || r.ok) { s.n = 0; s.d = Infinity; return; }
		if (!r.fail || r.fail.why !== 'budget') return;
		const d = r.fail.closest && r.fail.closest.dist >= 0 ? r.fail.closest.dist : Infinity, u = r.fail.wallsN | 0;
		if (u === s.u && !(d < s.d - 1)) s.n++;
		else { s.n = 1; s.d = d; s.u = u; }
		if (s.n >= WALLS_STUCK_N) { s.on = true; S.wallsArmed++; if (emit) emit({ ev: 'exec.walls', label: wp.label || '', armed: true, n: s.n, d }); }
	};
	const stuckOn = (wk) => { const s = wk ? wallStuck.get(wk) : null; return !!(s && s.on); };
	/** the last batch of walls of a field dropped (its walls cut every start off the waypoint: no counterexample of the
	 *  field's way, the batches before it stay; its tiles are never walled again: the relaxation's last way through them
	 *  is the way); false when none is left */
	const wallDropLast = (wk, label) => {
		const s = wallMemo.get(wk), bs = wallBatches.get(wk);
		if (!s || !bs || !bs.length) { wallMemo.delete(wk); wallBatches.delete(wk); return false; }
		const b = bs.pop();
		let tb = wallTabu.get(wk);
		if (!tb) { tb = new Set(); wallTabu.set(wk, tb); }
		for (const t of b) { s.delete(t); tb.add(t); }
		if (!s.size || !bs.length) { wallMemo.delete(wk); wallBatches.delete(wk); }
		S.wallsReset++;
		if (emit) emit({ ev: 'exec.walls', label: label || '', reset: true, total: s.size });
		return true;
	};
	const wallKeyOf = (wp) => {
		const g = T.goalOf(L, wp);
		const ft = Array.from(T.fieldTilesOf(g)).sort((a, b) => a - b);
		return `${ft.length}:${ft.slice(0, 64).join(',')}|${T.fieldTouchOf(g) ? 1 : 0}|${wp.allowDeath ? 1 : 0}`;
	};
	const tileMinMemo = new WeakMap();
	/** per tile the least cost (fifths) of any ball state centred on it by the goal field f (walk mode: its walk); CUT none */
	function tileMin(f) {
		let m = tileMinMemo.get(f);
		if (m) return m;
		const N = f.W * f.H, CUT = RF.CUT;
		m = new Uint32Array(N).fill(CUT);
		if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) m[t] = f.walk ? f.walk[t] : CUT; }
		else {
			const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
			for (let t = 0; t < N; t++) {
				let v = CUT;
				for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
				for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
				const rc = f.rowC[t], rx = f.rowX[t];
				if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
				if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
				m[t] = v;
			}
		}
		tileMinMemo.set(f, m);
		return m;
	}
	/** the goal field at a replayed start (the doors as they stand there) and the start's cost on it (tiles; -1 cut, NaN
	 *  none) */
	function fieldAt(str, goal, allowDeath, walls) {
		const e = core.startOf(String(str));
		vsim.restore(e.snap);
		if (e.dead) return { f: null, c: NaN };
		// (the waypoint's own ordering tiles: a death step's are the tiles a death starts from, planner.js dieField; its
		// goal tiles, the respawn, are where its start stands: c0 0, no skeleton, Tutorial 2's killers 235+ tiles away)
		const f = T.goalField(walls ? withWalls(T.levelNow(L, vsim), walls) : T.levelNow(L, vsim), T.fieldTilesOf(goal), { deaths: !!allowDeath, plainFx: T.plainOf(vsim) });
		return { f, c: RF.costAt(f, vsim) };
	}
	/** the skeleton's closest in the WAYPOINT's unit (f0: its goal field at the step's starts, the unit of the direct
	 *  leg's FailReport), the deepest level's arrivals as candidates too (the progress the skeleton made). A failed
	 *  skeleton returns its last sub-leg's FailReport, whose closest read "0 tiles" on 84 of the 221 failing levels of the
	 *  chief's full compile b1 (Tutorial 2's trophy leg from the spawn: 0; re-measured here: 347), the number the planner's
	 *  walls / cuts and the strategy's relays take as the waypoint's. OPT-IN (EEAT_SKEL_CLOSEST=1): on 95 levels (gate20 +
	 *  the closest-0 levels, 60 s, par 36) it compiled 5 vs 4 (Tutorial 1) and raised Animaly 1 -> 4, Trail Blazer 3 -> 5,
	 *  Summer Bee / Starlight 0 -> 2, but I Wanna be the Guy 15 -> 1 and The Glitch 5 -> 0: the false 0 was an accidental
	 *  DIVERSIFIER (lane 2's finding for the start-closest): a far leg "reached" makes the planner move on to other
	 *  triggers; with the true number it insists on the far leg. Default on only with an explicit diversification rule:
	 *  DEFAULT ON since COMPILE-ALL block 3 lane 4, together with the planner's diversification rule (planner.js NEAR_K 1,
	 *  EEAT_PLAN_NEAR): the shared gate 11 compiled vs 9, worse 0, IWBTG 16 and The Glitch 8 vs the baseline's 11 / 4
	 *  (planner.js nearPlans' comment has the numbers). EEAT_SKEL_CLOSEST=0: off (the sub-leg's FailReport as before). */
	function skelClosest(fc, deep, f0) {
		if (process.env.EEAT_SKEL_CLOSEST === '0' || !f0) return fc;
		const cands = [];
		if (fc && fc.masks) cands.push(typeof fc.masks === 'string' ? fc.masks : T.strOf(fc.masks));
		for (const s of deep) cands.push(String(s));
		let best = null;
		for (const str of cands) {
			let e;
			try { e = core.startOf(str); } catch (x) { continue; }
			if (e.dead) continue;
			vsim.restore(e.snap);
			const c = RF.costAt(f0, vsim);
			if (!(c >= 0) || (best && c >= best.dist)) continue;
			best = { masks: e.masks, tile: T.tileOf(vsim, L.width, L.height), dist: c, vx: vsim.speed_x, vy: vsim.speed_y, px: vsim.px, py: vsim.py, dead: false };
		}
		if (process.env.EEAT_SKEL_DBG === '1') console.error(`skel closest: sub-leg ${fc ? fc.dist : 'none'} -> waypoint ${best ? best.dist : 'none'} (${cands.length} cands)`);
		return best || fc;
	}
	// ---- DEAD-END LEVELS (lane 1, block 3): the skeleton's arrivals at a sub-level set can be states the finders cannot
	// go on from (Endless Space: the skeleton entered c <= 207 at (8,44) at tick 347; from there legBest popped 18 states
	// (30 dead children, the rest closed) and ran out of open states, on every cell grain; from the known route's own state
	// there at tick 345 the same sub-leg (c <= 195) is found in 1.3 s). The skeleton kept them as its deepest level, both
	// tries of the next sub-leg ended 'exhausted' at once, the memo popped a level and the same search found the same
	// arrivals again: every call of every rung ended in 10-700 ms of its 8-45 s. Now a level whose next sub-leg ends
	// 'exhausted' on both tries is a DEAD END: its arrivals' states (stateHash) are marked, the skeleton goes back one level
	// (this call's, else the memo's, else the starts) and its sub-legs ask for DEAD_K arrivals and keep only the unmarked
	// ones, at most DEAD_BACK times a call. Ordering of the skeleton only (which arrivals it goes on from; every arrival
	// is still the engine's replay, verified as before); no claim reads it. EEAT_DEADEND=0 off.
	const DEAD_ON = process.env.EEAT_DEADEND !== '0';
	const DEAD_K = 16, DEAD_BACK = 6, DEAD_REST = 0.3;
	// ---- THE STEP HOLDS AFTER A FAILURE (lane 1, block 4): a sub-leg found in under a third of its share doubles the step
	// (fast motion); after a failed sub-leg the next success doubled it too, and that success was often trivial: new
	// counterexample walls re-measure the level where the skeleton stands (its cost rises), the next sub-level set is
	// found in 2 ms by the exact tier (the arrivals already in it), the step doubles to 24 and that sub-leg fails again
	// with up to half of what is left of the call (The Blank Page's rung 3, 39 s: 24 fail 5.8 s, 37 ok 2 ms, 13 fail
	// 5.0 s, 38 ok 2 ms, 14 fail 4.3 s, ... six times). The 54 L1 levels (60 s, box 3): 431 such failures on 42 levels,
	// 364 s of sub-leg time. Now the step doubles only on the second success in a row after a failure (before any
	// failure of the call: as before), and new walls after a failed sub-leg keep the retry's halved step and its count
	// (the level's second failure ends the call's descent there: the dead-end rule, or the rest's direct leg) instead of
	// a fresh start on the new field (every failed sub-leg learns walls, so the fresh start never let the call end stuck:
	// The Blank Page's same rung with only the doubling held: 23 fail 2.5 s, 23 fail 2.1 s, 23 fail 1.8 s, 23 fail 1.5 s).
	// Ordering / time use only. EEAT_SKEL_HOLD=0: as before.
	const STEP_HOLD = process.env.EEAT_SKEL_HOLD !== '0';
	const deadEnds = new Set();   // stateHash of skeleton arrivals the finders could not go on from
	const hashOf = (str) => { try { return core.startOf(String(str)).hash; } catch (e) { return null; } };
	// THE DEATH LEG (EEAT_DEATH_LEG=0: off): a waypoint whose finders closed every way from the starts without a death
	// (every best-first pass out of open states: fail.closedAll) on a level where a death moves the ball (the model's
	// canDie: a killer and a respawn) goes on with deaths as moves: the same waypoint with allowDeath (a death is a move:
	// the ball respawns at its checkpoint / the next spawn and the leg goes on from there), in the time left. Buuwuu's
	// Stronghold: its known route dies at (6,55) back to the checkpoint (42,11) and falls to the coin (44,81); from the
	// route's own state there every pass closed without a death (the compile's closest 91.6 tiles, rung after rung).
	// The arrivals carry deathLeg: the strategy's replay lets the leg die (every one the engine's replay)
	async function deathLeg(starts, wp, budget, r, end) {
		if (!DEATH_LEG || !canDieL || wp.allowDeath || wp.dieField || !r || r.ok || !r.fail || !r.fail.closedAll) return null;
		if (wp.beforeTick >= 0 || wp.beforeRel !== undefined) return null;
		const t0 = Date.now(), left = end - t0;
		if (!(left >= 300)) return null;
		S.deathLegs = (S.deathLegs || 0) + 1;
		const wpD = Object.assign({}, wp, { allowDeath: true, label: `${wp.label || wp.kind} (through a death)` });
		const rD = await reachLeg(starts, wpD, { ms: left, level: budget.level | 0, k: budget.k, deadline: end, stop: budget.stop });
		if (emit) emit({ ev: 'exec.death', label: wp.label || '', ok: !!rD.ok, ms: Date.now() - t0, why: rD.ok ? '' : (rD.fail && rD.fail.why) || '' });
		if (!rD.ok) return null;
		S.deathLegsOk = (S.deathLegsOk || 0) + 1;
		rD.deathLeg = true;
		return rD;
	}
	// ---- THE GOAL BASIN (doctor 8, n5-doc-8; OPT-IN EEAT_BASIN=1, off = the executor byte for byte as before): the last
	// approach VERIFIED BACKWARD. The finders and the skeleton go FORWARD, ordered by the goal field, a relaxation: where
	// the goal's last approach needs momentum the field does not model, its sub-level sets are false nears (UT Eternal
	// Galaxy's first coin: a 1-wide column falls through a dot row into 3 up-arrow rows; the dot row, entered from the
	// side, is 5-6 tiles from the coin by the field and a dead end by the physics: legBest from the spawn sat there for
	// 15 s, while from the known route's state after its speed boost, 120 ticks out, the leg is found in 0.2 s; the known-
	// route test of the batch: legs found from 60-200 route ticks out and not from the previous trigger). The basin: the
	// tiles near the goal (the goal field's cost within BASIN_R tiles, standing tiles and field tiles, nearest first) from
	// which a ball AT REST, with the start's own discrete state (its snapshot, the ball moved there, two idle ticks), reaches
	// the goal by a short leg (legBest, BASIN_LEG_MS, BASIN_DEPTH ticks): a funnel verified by the engine, grown call after
	// call (memo per waypoint and discrete state). A far waypoint whose direct leg failed then goes START -> BASIN (a region
	// waypoint ordered by the basin's own field: the verified tiles, not the relaxation's false near) -> GOAL from the
	// basin's real arrivals. Ordering and waypoints only: the synthetic states only choose tiles, every leg returned is
	// found from real arrivals and replayed from the level start (finalize), no claim, no proof.
	const BASIN_ON = process.env.EEAT_BASIN === '1';
	const BASIN_R = +process.env.EEAT_BASIN_R > 0 ? +process.env.EEAT_BASIN_R : 30;          // tiles of the goal field
	const BASIN_MIN = +process.env.EEAT_BASIN_MIN > 0 ? +process.env.EEAT_BASIN_MIN : 8;      // a start nearer: no basin
	const BASIN_SHARE = +process.env.EEAT_BASIN_SHARE > 0 ? Math.min(0.9, +process.env.EEAT_BASIN_SHARE) : 0.5;   // of the call left after the direct leg
	const BASIN_BUILD = +process.env.EEAT_BASIN_BUILD > 0 ? Math.min(0.8, +process.env.EEAT_BASIN_BUILD) : 0.3;    // of the basin's share: its growth
	const BASIN_LEG_MS = +process.env.EEAT_BASIN_LEG_MS > 0 ? +process.env.EEAT_BASIN_LEG_MS : 10;
	const BASIN_RIM = process.env.EEAT_BASIN_RIM !== undefined ? Math.max(0, Math.min(1, +process.env.EEAT_BASIN_RIM)) : 0.5;
	const BASIN_DEPTH = +process.env.EEAT_BASIN_DEPTH > 0 ? +process.env.EEAT_BASIN_DEPTH : 200;
	const BASIN_PROBES = [0, 4, 2, 1, 5, 3];   // masks held (eesim bits: 1 jump, 2 left, 4 right)
	const BASIN_WALLS = process.env.EEAT_BASIN_WALLS !== '0';
	const basinMemo = new Map();   // key (the waypoint's field tiles and walls, the start's discrete state) -> basin
	let bsim = null, binp = null;
	/** the basin of goal for the discrete state of the start str, grown until `until`: {tiles: Set, cand, next, tried} */
	function basinGrow(str, goal, wp, until) {
		const e = core.startOf(String(str));
		if (!e || e.dead) return null;
		vsim.restore(e.snap);
		const key = `${wallKeyOf(wp)}|${X.discKey(vsim)}`;
		let B = basinMemo.get(key);
		if (!B) {
			const f = T.goalField(T.levelNow(L, vsim), T.fieldTilesOf(goal), { deaths: !!wp.allowDeath });
			const m = tileMin(f), lim = BASIN_R * 5, fl = L.flags, fg = L.fg, cand = [];
			const Wl = L.width, Hl = L.height;
			const gset = new Set(Array.from(goal.tiles));
			for (let t = 0; t < m.length; t++) {
				if (!(m[t] <= lim) || gset.has(t)) continue;
				const x = t % Wl, y = (t / Wl) | 0;
				// (a standing tile (a solid or a one-way under it) or a field tile (not plain air: arrows, dots, liquids,
				// climbables, boosts), where a ball at rest is a state the searches meet)
				// (eesim.js flags: 1 solid, 2 one-way, 4 rotated half, 8 half, 16 door)
				const below = y + 1 < Hl ? fl[fg[t + Wl]] | 0 : 1;
				const stand = (below & (1 | 2 | 4 | 8)) !== 0 || y + 1 >= Hl;
				const idh = fg[t];
				const fieldTile = idh !== 0 && ((fl[idh] | 0) & (1 | 16)) === 0;
				// (against a wall: a side hit leaves vx 0 there, the top of a 1-wide shaft the ball falls down from)
				const wallL = x > 0 && (fl[fg[t - 1]] & 1) !== 0, wallR = x + 1 < Wl && (fl[fg[t + 1]] & 1) !== 0;
				if (stand || fieldTile || wallL || wallR) cand.push(t);
			}
			cand.sort((a, b) => m[a] - m[b] || a - b);
			B = { f, m, cand, next: 0, tiles: new Set(), fail: new Set(), tried: 0, ms: 0 };
			basinMemo.set(key, B);
		}
		if (!bsim) { bsim = new E.EESim(L); binp = new E.EEInput(); }
		const t0 = Date.now(), Wl = L.width, Hl = L.height;
		while (B.next < B.cand.length && Date.now() < until - 5) {
			const t = B.cand[B.next++];
			bsim.restore(e.snap);
			bsim.px = (t % Wl) * 16; bsim.py = ((t / Wl) | 0) * 16; bsim.speed_x = 0; bsim.speed_y = 0;
			// (two idle ticks: the gravity queue and the touch read the new place)
			E.applyMask(binp, 0); bsim.tick(binp); bsim.tick(binp);
			if (bsim.is_dead) continue;
			B.tried++;
			if (X.goalAt(goal, bsim, e.tick + 2, -1)) { B.tiles.add(t); continue; }
			const snapT = bsim.snapshot();
			// (the held probes first: idle, right, left, jump, right + jump, left + jump, each held until the goal, a death or
			// BASIN_DEPTH ticks: where gravity, a shaft, a conveyor of arrows does the work, ~0.1 ms instead of a search)
			let hit = false;
			for (const pm of BASIN_PROBES) {
				bsim.restore(snapT);
				E.applyMask(binp, pm);
				for (let k = 0; k < BASIN_DEPTH && !bsim.is_dead; k++) { bsim.tick(binp); if (X.goalAt(goal, bsim, e.tick + 3 + k, -1)) { hit = true; break; } }
				if (hit) break;
			}
			if (hit) { B.tiles.add(t); B.probed = (B.probed || 0) + 1; continue; }
			const r = LG.legBest(L, [{ snap: snapT, tick: e.tick + 2 }], goal, { sim: bsim, deadline: Math.min(until, Date.now() + BASIN_LEG_MS), field: B.f, region: null, depthMax: BASIN_DEPTH, noFinish: true });
			if (r.status === 'found') B.tiles.add(t); else B.fail.add(t);
		}
		B.ms += Date.now() - t0;
		S.basinTried = (S.basinTried || 0) + (B.tried - (B.tried0 || 0)); B.tried0 = B.tried;
		return B;
	}
	/** START -> BASIN -> GOAL (null: no basin; else the StepResult, ok or not) */
	async function basinRoute(starts, startStrs, wp, goal, budget, deadline) {
		const tIn = Date.now();
		if (deadline - tIn < 400) return null;
		const B = basinGrow(startStrs[0], goal, wp, tIn + BASIN_BUILD * (deadline - tIn));
		if (!B || !B.tiles.size) { if (emit) emit({ ev: 'exec.basin', label: wp.label || '', tiles: 0, tried: B ? B.tried : 0, cand: B ? B.cand.length : 0 }); return null; }
		// (the target is the basin's RIM: its tiles at BASIN_RIM of its farthest one's cost or more. The whole basin would bring
		// the relaxation's false near back into the sub-leg's ordering field: its inner tiles sit right behind the momentum
		// barrier the false near faces (Eternal Galaxy: the tiles under the up arrows, 2 tiles past the dot row), while the rim
		// (the column's top, the arrow row that feeds it) is far from the false near by the same field. The starts' own
		// tiles are no target: a start in the basin already failed the direct leg)
		const own = new Set();
		for (const s of startStrs) { try { const e = core.startOf(String(s)); vsim.restore(e.snap); own.add(T.tileOf(vsim, L.width, L.height)); } catch (x) { /* ignore */ } }
		let cMax = 0;
		for (const t of B.tiles) if (B.m[t] > cMax) cMax = B.m[t];
		const tiles = Array.from(B.tiles).filter((t) => !own.has(t) && B.m[t] >= BASIN_RIM * cMax);
		if (!tiles.length) return null;
		S.basin = (S.basin || 0) + 1;
		const sub = { kind: 'region', tiles, expect: null, allowDeath: !!wp.allowDeath, label: `${wp.label || wp.kind} (basin ${B.tiles.size})` };
		// (the inner tiles the build tried and refuted (a ball at rest there reaches no goal: the dot row beside the shaft,
		// the arrows under it) are the relaxation's false nears on the way to the rim: walls of the sub-leg's ORDERING field
		// (the executor's counterexample walls, never a cut), so it routes to the rim the way the physics can)
		let nDead = 0;
		if (WALLS_ON && BASIN_WALLS) {
			const thr = BASIN_RIM * cMax, dead = [];
			for (const t of B.fail) if (B.m[t] < thr && !own.has(t)) dead.push(t);
			const wk = wallKeyOf(sub);
			if (dead.length && !wallMemo.has(wk)) { wallMemo.set(wk, new Set(dead)); wallBatches.set(wk, [dead]); }
			nDead = dead.length;
			if (process.env.EEAT_BASIN_DBG === '1') console.error('basin walls', dead.map((t) => `${t % L.width},${(t / L.width) | 0}`).join(';'));
		}
		const share1 = 0.7 * (deadline - Date.now());
		const r1 = await reachWp(starts, sub, { ms: share1, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + share1), stop: budget.stop });
		if (emit) emit({ ev: 'exec.basin', label: wp.label || '', tiles: B.tiles.size, tried: B.tried, cand: B.cand.length, rim: tiles.slice(0, 12).map((t) => [t % L.width, (t / L.width) | 0]), walls: nDead, ok1: !!r1.ok, ms: Date.now() - tIn });
		if (!r1.ok) return r1;
		// (an arrival on the goal itself: the waypoint reached)
		const cur = r1.arrivals.map((a) => T.strOf(a.masks));
		const r2 = await reachLeg(cur, wp, { ms: deadline - Date.now(), level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline, stop: budget.stop, next: budget.next || null });
		if (!r2.ok) { if (r2.fail && r2.fail.why !== 'stopped') r2.fail = Object.assign({}, r2.fail, { why: 'budget' }); return r2; }
		S.basinOk = (S.basinOk || 0) + 1;
		r2.legs = r2.arrivals.map((a) => {
			let si = -1;
			for (let i = 0; i < startStrs.length; i++) if (a.masks.length >= startStrs[i].length && T.strOf(a.masks.subarray(0, startStrs[i].length)) === startStrs[i] && (si < 0 || startStrs[i].length > startStrs[si].length)) si = i;
			const t0 = si >= 0 ? startStrs[si].length : 0;
			if (a.leg) { a.leg.start = si; a.leg.ticks = a.masks.length - t0; a.leg.tool = 'basin+' + (a.leg.tool || r2.tool); }
			return { start: si, ticks: a.masks.length - t0, lb: 0, proven: false, tool: 'basin+' + (r2.tool || '') };
		});
		r2.lb = 0;
		r2.tool = 'basin+' + (r2.tool || '');
		r2.ms = Date.now() - tIn;
		return r2;
	}
	// ---- THE RUN-UP RELAY (C6 push 3 lane 4 block 3; OPT-IN EEAT_RUNUP=1, off = the executor byte for byte): the goal field
	// has no speed, so a sub-level set the ball reaches only with a run-up is a wall to the finders it orders: Sentinel
	// Ravines' skeleton stuck at (90,108), where the known route goes 29 tiles LEFT and up to the far end of a 45-tile dot
	// row, accelerates right along it to 6.4 px/tick and only then climbs (the field +24 tiles above its running minimum on
	// the way; the sub-leg failed at 45 s with every finder knob, from the route's state past the detour prims found it in
	// 3.5 s). From the level's structure: the RUNS (a row's maximal stretch of tiles the ball can move along horizontally: a
	// non-solid tile over a floor (solid, one-way, half block), or a dot tile) of RUNUP_MIN tiles or more within RUNUP_RY rows
	// of the stuck arrival whose span covers its column, the run's end farther from the goal by the sub-leg's own field the
	// run-up's start (at least RUNUP_DMIN tiles from the arrival, the field falling along the run by that much); the longest
	// runs first, RUNUP_K of them: a relay leg to that end (a region waypoint, its own field), then the stuck sub-level set
	// from the relay's arrivals. Waypoints only: every leg is the finders' from real arrivals, replayed as before; no claim.
	const RUNUP_ON = process.env.EEAT_RUNUP === '1';
	const RUNUP_MIN = +process.env.EEAT_RUNUP_MIN > 0 ? +process.env.EEAT_RUNUP_MIN : 16;
	const RUNUP_RY = +process.env.EEAT_RUNUP_RY >= 0 ? +process.env.EEAT_RUNUP_RY : 8;
	const RUNUP_DMIN = +process.env.EEAT_RUNUP_DMIN > 0 ? +process.env.EEAT_RUNUP_DMIN : 8;
	const RUNUP_K = +process.env.EEAT_RUNUP_K > 0 ? +process.env.EEAT_RUNUP_K : 2;
	const RUNUP_SHARE = +process.env.EEAT_RUNUP_SHARE > 0 ? Math.min(0.95, +process.env.EEAT_RUNUP_SHARE) : 0.6;
	const RUNUP_GAP = +process.env.EEAT_RUNUP_GAP > 0 ? +process.env.EEAT_RUNUP_GAP | 0 : 0;
	let runsMemo = null;
	function runsOf() {
		if (runsMemo) return runsMemo;
		const Wl = L.width, Hl = L.height, fl = L.flags, fg = L.fg, runs = [];
		// (eesim.js flags: 1 solid, 2 one-way, 4 rotated half, 8 half, 16 door; 4 / 414 the dots)
		const ok = (x, y) => {
			const t = y * Wl + x, id = fg[t], f = fl[id] | 0;
			if (f & (1 | 16)) return false;
			if (id === 4 || id === 414) return true;
			const below = y + 1 < Hl ? (fl[fg[t + Wl]] | 0) : 1;
			return (below & (1 | 2 | 4 | 8)) !== 0;
		};
		// (EEAT_RUNUP_GAP: a run goes on over gaps of at most that many open (not solid) tiles: a running ball hops them)
		const open = (x, y) => ((fl[fg[y * Wl + x]] | 0) & (1 | 16)) === 0;
		for (let y = 0; y < Hl; y++) {
			let x = 0;
			while (x < Wl) {
				if (!ok(x, y)) { x++; continue; }
				const x0 = x;
				let xe = x;
				while (x < Wl) {
					if (ok(x, y)) { xe = x; x++; continue; }
					let g = 0;
					while (RUNUP_GAP > 0 && x + g < Wl && g <= RUNUP_GAP && !ok(x + g, y) && open(x + g, y)) g++;
					if (g > 0 && g <= RUNUP_GAP && x + g < Wl && ok(x + g, y)) { x += g; continue; }
					break;
				}
				if (xe - x0 + 1 >= RUNUP_MIN) runs.push({ y, x0, x1: xe });
				x = Math.max(x, xe + 1);
			}
		}
		runsMemo = runs;
		return runs;
	}
	/** the stuck sub-level set `sub` again through a run-up relay: the arrivals' mask strings, or null */
	async function runupRelay(cur, sub, fr, budget, deadline) {
		let e;
		try { e = core.startOf(String(cur[0])); } catch (x) { return null; }
		if (!e || e.dead || !fr || !fr.f) return null;
		vsim.restore(e.snap);
		const Wl = L.width, Hl = L.height, at = T.tileOf(vsim, Wl, Hl), ax = at % Wl, ay = (at / Wl) | 0;
		const m = tileMin(fr.f), CUT = RF.CUT, cands = [];
		for (const R of runsOf()) {
			if (Math.abs(R.y - ay) > RUNUP_RY || ax < R.x0 - RUNUP_RY || ax > R.x1 + RUNUP_RY) continue;
			const mL = m[R.y * Wl + R.x0], mR = m[R.y * Wl + R.x1];
			if (!(mL < CUT) || !(mR < CUT) || Math.abs(mL - mR) < 5 * RUNUP_DMIN) continue;
			const fromL = mL > mR, xa = fromL ? R.x0 : R.x1;
			if (Math.abs(xa - ax) < RUNUP_DMIN) continue;
			const tiles = [];
			for (let k = 0; k < 3 && k <= R.x1 - R.x0; k++) tiles.push(R.y * Wl + (fromL ? R.x0 + k : R.x1 - k));
			cands.push({ tiles, x: xa, y: R.y, len: R.x1 - R.x0 + 1, dy: Math.abs(R.y - ay) });
		}
		if (!cands.length) { S.runupNone = (S.runupNone || 0) + 1; return null; }
		cands.sort((a, b) => b.len - a.len || a.dy - b.dy);
		const use = cands.slice(0, RUNUP_K), tIn = Date.now(), total = RUNUP_SHARE * (deadline - tIn);
		for (let i = 0; i < use.length; i++) {
			const cd = use[i], now = Date.now(), share = Math.min(deadline - now - 50, total / use.length);
			if (!(share >= 400)) break;
			S.runups = (S.runups || 0) + 1;
			const wp1 = { kind: 'region', tiles: cd.tiles, expect: null, allowDeath: !!sub.allowDeath, label: `${sub.label || 'sub'} (run-up ${cd.x},${cd.y})` };
			const s1 = 0.4 * share;
			const r1 = await reachLeg(cur, wp1, { ms: s1, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + s1), stop: budget.stop }, true);
			let ok2 = false, r2 = null;
			if (r1.ok) {
				const c1 = r1.arrivals.map((a) => T.strOf(a.masks));
				const s2 = Math.min(deadline - Date.now() - 50, share - (Date.now() - now));
				if (s2 >= 200) {
					r2 = await reachLeg(c1, sub, { ms: s2, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + s2), stop: budget.stop }, true);
					ok2 = !!r2.ok;
				}
			}
			if (emit) emit({ ev: 'exec.runup', label: sub.label || '', from: [ax, ay], to: [cd.x, cd.y], len: cd.len, ok1: !!r1.ok, ok2, ms: Date.now() - now });
			if (ok2) { S.runupOk = (S.runupOk || 0) + 1; return r2.arrivals.map((a) => T.strOf(a.masks)); }
			if ((r1.fail && r1.fail.why === 'stopped') || (r2 && r2.fail && r2.fail.why === 'stopped')) break;
		}
		S.runupMs = (S.runupMs || 0) + (Date.now() - tIn);
		return null;
	}
	// ---- THE STRUCTURE RELAYS (C6 push 3 lane 4 block 4; OPT-IN EEAT_STRUCT=1, off = the executor byte for byte): the
	// ONE-LEG levels (one plan step spanning the level: Infinity Pain's 'team 1' from 417 tiles, Endless Pain's 'team 5' from
	// 704) stall at the skeleton's FIRST sub-level sets (405 / 411, 692: 451 ms - 4.1 s each, both tries 'budget'): the
	// field's descent from the arrival is a false near the physics cannot follow, and the run-up relay sees only horizontal
	// runs. From the level's structure, the places a way bends at: a RUN's ends (8+ tiles of floor or dots), a LEDGE's edge
	// (a floor tile beside an open tile with no floor: the drop), a SHAFT's bottom (a floor under 4 open tiles walled both
	// sides), a FIELD's entry (an arrow / dot tile beside a plain open tile); those within STRUCT_RAD tiles of the stuck
	// arrival, outside the stuck sub-level set and at most STRUCT_UP tiles above the arrival's level by the sub-leg's own
	// field (an energy detour goes up the field), 3+ tiles from it; round-robin over the four classes, the farthest first,
	// STRUCT_K of them 6+ tiles apart: a relay leg to the place (its tile and open neighbours), then the stuck sub-level set
	// from the relay's arrivals. Waypoints only: every leg is the finders' from real arrivals, replayed as before; no claim.
	const STRUCT_ON = process.env.EEAT_STRUCT === '1';
	const STRUCT_RAD = +process.env.EEAT_STRUCT_RAD > 0 ? +process.env.EEAT_STRUCT_RAD : 24;
	const STRUCT_UP = /^\d+(\.\d+)?$/.test(process.env.EEAT_STRUCT_UP || '') ? +process.env.EEAT_STRUCT_UP : 48;
	const STRUCT_K = +process.env.EEAT_STRUCT_K > 0 ? +process.env.EEAT_STRUCT_K | 0 : 4;
	const STRUCT_SHARE = +process.env.EEAT_STRUCT_SHARE > 0 ? Math.min(0.95, +process.env.EEAT_STRUCT_SHARE) : 0.6;
	let featsMemo = null;
	function featsOf() {
		if (featsMemo) return featsMemo;
		const Wl = L.width, Hl = L.height, fl = L.flags, fg = L.fg, out = [];
		const GRV = new Set([1, 2, 3, 4, 411, 412, 413, 414, 1518, 1519]);
		const fO = (x, y) => (x < 0 || y < 0 || x >= Wl || y >= Hl) ? 1 : (fl[fg[y * Wl + x]] | 0);
		const open = (x, y) => x >= 0 && y >= 0 && x < Wl && y < Hl && (fO(x, y) & (1 | 16)) === 0;
		const solid = (x, y) => (fO(x, y) & 1) !== 0;
		const stand = (x, y) => {
			if (!open(x, y)) return false;
			const id = fg[y * Wl + x];
			if (id === 4 || id === 414) return true;
			return (fO(x, y + 1) & (1 | 2 | 4 | 8)) !== 0;
		};
		for (let y = 0; y < Hl; y++) {
			let x0 = -1;
			for (let x = 0; x <= Wl; x++) {
				const s = x < Wl && stand(x, y);
				if (s && x0 < 0) x0 = x;
				if (!s && x0 >= 0) {
					if (x - x0 >= 8) { out.push({ t: y * Wl + x0, x: x0, y, cl: 0 }); out.push({ t: y * Wl + x - 1, x: x - 1, y, cl: 0 }); }
					x0 = -1;
				}
			}
		}
		for (let y = 0; y < Hl; y++) for (let x = 0; x < Wl; x++) {
			const t = y * Wl + x, id = fg[t];
			if (GRV.has(id)) {
				if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => open(x + dx, y + dy) && !GRV.has(fg[(y + dy) * Wl + x + dx]))) out.push({ t, x, y, cl: 3 });
				continue;
			}
			if (!stand(x, y)) continue;
			if ((open(x - 1, y) && !stand(x - 1, y)) || (open(x + 1, y) && !stand(x + 1, y))) out.push({ t, x, y, cl: 1 });
			let walled = 0, up = true;
			for (let k = 1; k <= 4; k++) { if (!open(x, y - k)) { up = false; break; } if (solid(x - 1, y - k) && solid(x + 1, y - k)) walled++; }
			if (up && walled >= 3) out.push({ t, x, y, cl: 2 });
		}
		featsMemo = out;
		return out;
	}
	/** the stuck sub-level set `sub` again through a structure relay: the arrivals' mask strings, or null */
	async function structRelay(cur, sub, fr, cCur, lim, budget, deadline) {
		let e;
		try { e = core.startOf(String(cur[0])); } catch (x) { return null; }
		if (!e || e.dead || !fr || !fr.f) return null;
		vsim.restore(e.snap);
		const Wl = L.width, Hl = L.height, at = T.tileOf(vsim, Wl, Hl), ax = at % Wl, ay = (at / Wl) | 0;
		const m = tileMin(fr.f), CUT = RF.CUT, hi = Math.round((cCur + STRUCT_UP) * 5), byCl = [[], [], [], []];
		for (const F of featsOf()) {
			const dx = Math.abs(F.x - ax), dy = Math.abs(F.y - ay);
			if (dx > STRUCT_RAD || dy > STRUCT_RAD || Math.max(dx, dy) < 3) continue;
			const v = m[F.t];
			if (!(v < CUT) || v <= lim || v > hi) continue;
			byCl[F.cl].push({ t: F.t, x: F.x, y: F.y, cl: F.cl, d: dx * dx + dy * dy });
		}
		for (const a of byCl) a.sort((p, q) => q.d - p.d);
		const use = [], idx = [0, 0, 0, 0];
		for (let more = true; more && use.length < STRUCT_K;) {
			more = false;
			for (let c = 0; c < 4 && use.length < STRUCT_K; c++) {
				const a = byCl[c];
				while (idx[c] < a.length) {
					const F = a[idx[c]++];
					if (use.some((u) => Math.max(Math.abs(u.x - F.x), Math.abs(u.y - F.y)) < 6)) continue;
					use.push(F); more = true; break;
				}
				if (idx[c] < a.length) more = true;
			}
		}
		if (!use.length) { S.structNone = (S.structNone || 0) + 1; return null; }
		const tIn = Date.now(), total = STRUCT_SHARE * (deadline - tIn), CLS = ['run', 'ledge', 'shaft', 'entry'];
		for (let i = 0; i < use.length; i++) {
			const cd = use[i], now = Date.now(), share = Math.min(deadline - now - 50, total / use.length);
			if (!(share >= 400)) break;
			S.structs = (S.structs || 0) + 1;
			const tiles = [cd.t];
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1]]) {
				const x = cd.x + dx, y = cd.y + dy;
				if (x >= 0 && y >= 0 && x < Wl && y < Hl && ((L.flags[L.fg[y * Wl + x]] | 0) & (1 | 16)) === 0) tiles.push(y * Wl + x);
			}
			const wp1 = { kind: 'region', tiles, expect: null, allowDeath: !!sub.allowDeath, label: `${sub.label || 'sub'} (${CLS[cd.cl]} ${cd.x},${cd.y})` };
			const s1 = 0.4 * share;
			const r1 = await reachLeg(cur, wp1, { ms: s1, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + s1), stop: budget.stop }, true);
			let ok2 = false, r2 = null;
			if (r1.ok) {
				const c1 = r1.arrivals.map((a) => T.strOf(a.masks));
				const s2 = Math.min(deadline - Date.now() - 50, share - (Date.now() - now));
				if (s2 >= 200) {
					r2 = await reachLeg(c1, sub, { ms: s2, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + s2), stop: budget.stop }, true);
					ok2 = !!r2.ok;
				}
			}
			if (emit) emit({ ev: 'exec.struct', label: sub.label || '', from: [ax, ay], to: [cd.x, cd.y], cl: CLS[cd.cl], ok1: !!r1.ok, ok2, ms: Date.now() - now });
			if (ok2) { S.structOk = (S.structOk || 0) + 1; S.structMs = (S.structMs || 0) + (Date.now() - tIn); return r2.arrivals.map((a) => T.strOf(a.masks)); }
			if ((r1.fail && r1.fail.why === 'stopped') || (r2 && r2.fail && r2.fail.why === 'stopped')) break;
		}
		S.structMs = (S.structMs || 0) + (Date.now() - tIn);
		return null;
	}
	async function reach(starts, wp, budget) {
		const r = await reachWp(starts, wp, budget);
		stuckNote(wp, r);
		return r;
	}
	async function reachWp(starts, wp, budget) {
		budget = budget || {};
		if (!SKEL_ON || wp.beforeTick >= 0 || wp.beforeRel !== undefined || !starts.length) return reachLeg(starts, wp, budget);
		const tIn = Date.now();
		const ms = budget.ms > 0 ? budget.ms : 3000;
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + ms);
		const startStrs = starts.map((a) => (typeof a === 'string' ? a : T.strOf(a.masks)));
		const goal = T.goalOf(L, wp);
		// (the waypoint field's counterexample walls: the sub-level sets are of the walled field; a call's sub-leg that finds
		// new walls moves the skeleton onto the new field)
		const wk = WALLS_ON ? wallKeyOf(wp) : null;
		let wArr = null, wN = 0;
		const wRefresh = () => { const s = wk ? wallMemo.get(wk) : null; const n = s ? s.size : 0; if (n === wN) return false; wN = n; wArr = n ? Array.from(s) : null; return true; };
		wRefresh();
		let c0 = Infinity, f0 = null;
		const measure = () => {
			c0 = Infinity; f0 = null;
			try {
				for (const s of startStrs) { const r = fieldAt(s, goal, wp.allowDeath, wArr); if (r.f && r.c >= 0 && r.c < c0) { c0 = r.c; f0 = r.f; } }
			} catch (e) { f0 = null; }
			// (walls that cut every start off the waypoint were no counterexample of that field's way: dropped)
			if (wArr && !f0) { wallDropLast(wk, wp.label); wN = -1; wRefresh(); measure(); }
		};
		measure();
		// (the goal basin, OPT-IN: a trigger / trophy waypoint at least BASIN_MIN tiles out by its field)
		const basinOn = BASIN_ON && !wp.allowDeath && !wp.dieField && goal.kind !== 'region' && !!f0 && Number.isFinite(c0) && c0 >= BASIN_MIN;
		if (!f0 || !(c0 >= SKEL_MIN) || !Number.isFinite(c0)) {
			if (basinOn) {
				// (the direct leg with 1 - BASIN_SHARE of the call, then start -> basin -> goal with the rest)
				const dMs = (1 - BASIN_SHARE) * (deadline - Date.now());
				const r0 = await reachLeg(starts, wp, { ms: dMs, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + dMs), stop: budget.stop, next: budget.next || null });
				if (r0.ok || (r0.fail && (r0.fail.why === 'proof' || r0.fail.why === 'stopped' || r0.fail.why === 'dies'))) return r0;
				const rB = await basinRoute(starts, startStrs, wp, goal, budget, deadline);
				if (rB && rB.ok) return rB;
				return (await deathLeg(starts, wp, budget, r0, deadline)) || r0;
			}
			const rS = await reachLeg(starts, wp, budget);
			return (await deathLeg(starts, wp, budget, rS, deadline)) || rS;
		}
		// (the direct leg first with SKEL_DIRECT of the budget (a leg the finders reach whole keeps its way: the skeleton's
		// split cost PARTIAL levels their progress, SMB3 3 -> 0, Booty Return 14 -> 6); its found leg, or its proof
		// (the exact tier's exhaustion: no time in it), is the answer; else the skeleton with the rest)
		// (THE DIRECT LEG AGAIN ON A BIGGER RUNG, default on, EEAT_SKEL_REDIRECT=0 off (doctor 8, n5-doc-8): once a call built the
		// skeleton's memo for these starts, every later call resumed the skeleton and never tried the direct leg again, so
		// the rung ladder's bigger budgets only fed the skeleton's sub-level sets: where those descend into the relaxation's
		// false near (UT Eternal Galaxy's first coin: the dot row beside the shaft) the waypoint failed on every rung
		// (krt: rung 1 then rung 2, both 'budget', closest 4 tiles), while a fresh rung-2 call's direct leg finds it (245
		// ticks at 5.4 s, with EEAT_CELL_ZERO=1). With the knob the direct leg runs again whenever this call's share is
		// REDIRECT_F times the largest direct share tried for the key)
		// (THE COVER SLOT, EEAT_COVER=1 from rung COVER_RUNG on: the coverage finder alone on the WHOLE leg with COVER_SLOT of the
		// budget before the direct leg and the skeleton: the skeleton's sub-level sets make every sub-leg go DOWN the field, so
		// a leg whose way first goes up it (a run-up, a detour) is split at the false near and its sub-legs start from states
		// that cannot go on (K Underground's checkpoint (64,84) from the known route's own state: the skeleton's sub-legs from
		// the arrow field's edge, 10-52 cells each; the coverage finder alone on the whole leg found it in 0.5-1.3 s))
		let coverSlot = false;
		const slotV2 = COVER_V2() && !COVER_V3() && (budget.level | 0) >= COVER_RUNG && COVER_SLOT > 0 && !!budget.fast;
		if (COVER_ON() && !COVER_V2() && (budget.level | 0) >= COVER_RUNG && COVER_SLOT > 0) {
			const vMs = COVER_SLOT * (deadline - Date.now());
			const rv = await reachLeg(starts, wp, { ms: vMs, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + vMs), stop: budget.stop, next: budget.next || null, cover: 1 });
			coverSlot = true;
			if (rv.ok || (rv.fail && (rv.fail.why === 'proof' || rv.fail.why === 'stopped' || rv.fail.why === 'dies'))) return rv;
		}
		const sk0 = skelKey(goal, wp, startStrs, wN);
		const fF0 = SKEL_FAR > 0 ? farF(c0) : 1;
		const dMs0 = SKEL_DIRECT * fF0 * (deadline - Date.now());
		const redirect = SKEL_REDIRECT && skelMemo.has(sk0) && dMs0 >= REDIRECT_F * (skelDirectMs.get(sk0) || Infinity);
		if (fF0 < 1 && dMs0 < 100) S.farDirectSkip = (S.farDirectSkip || 0) + 1;
		if (SKEL_DIRECT > 0 && (!skelMemo.has(sk0) || redirect) && !(fF0 < 1 && dMs0 < 100)) {
			if (fF0 < 1) S.farDirect = (S.farDirect || 0) + 1;
			const dMs = dMs0;
			if (SKEL_REDIRECT) { skelDirectMs.set(sk0, Math.max(skelDirectMs.get(sk0) || 0, dMs)); if (redirect) S.redirects = (S.redirects || 0) + 1; }
			const r0 = await reachLeg(starts, wp, { ms: dMs, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + dMs), stop: budget.stop, next: budget.next || null, cover: coverSlot || slotV2 ? 2 : 0 });
			if (r0.ok || (r0.fail && (r0.fail.why === 'proof' || r0.fail.why === 'stopped' || r0.fail.why === 'dies'))) return r0;
			const rD = await deathLeg(starts, wp, budget, r0, Date.now() + 0.5 * (deadline - Date.now()));
			if (rD) return rD;
			if (wRefresh()) { measure(); if (!f0 || !Number.isFinite(c0)) return r0; }
		}
		// (COVER V2: the cover slot after the direct leg found nothing, before the skeleton)
		if (slotV2 && Date.now() < deadline - 200) {
			const vMs = COVER_SLOT * (deadline - Date.now());
			const rv = await reachLeg(starts, wp, { ms: vMs, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + vMs), stop: budget.stop, next: budget.next || null, cover: 1 });
			coverSlot = true;
			if (rv.ok || (rv.fail && (rv.fail.why === 'proof' || rv.fail.why === 'stopped' || rv.fail.why === 'dies'))) return rv;
		}
		// (the goal basin, OPT-IN: BASIN_SHARE of what is left, before the skeleton; its basin grows call after call)
		if (basinOn) {
			const rB = await basinRoute(starts, startStrs, wp, goal, budget, Date.now() + BASIN_SHARE * (deadline - Date.now()));
			if (rB && rB.ok) return rB;
		}
		// (resume from the deepest level an earlier call for this step reached)
		let key = skelKey(goal, wp, startStrs, wN);
		// (no memo for these walls: the levels an earlier call reached on other walls, re-measured on this walled field)
		if (SKEL_REUSE && !skelMemo.has(key) && skelBase.has(baseKeyOf(key))) {
			let bestL = null;
			for (const lv of skelBase.get(baseKeyOf(key))) {
				if (DEAD_ON && deadEnds.size && lv.cur.every((s) => deadEnds.has(hashOf(s)))) continue;
				let fw;
				try { fw = fieldAt(lv.cur[0], goal, wp.allowDeath, wArr); } catch (e) { continue; }
				if (!fw.f || !(fw.c >= 0) || !Number.isFinite(fw.c)) continue;
				if (!(fw.c < c0 - 0.5) || (bestL && fw.c >= bestL.c)) continue;
				bestL = { c: fw.c, cur: lv.cur.slice() };
			}
			if (bestL) { skelMemo.set(key, [bestL]); S.skelReuse = (S.skelReuse || 0) + 1; }
		}
		// (no memo for this waypoint: the levels other waypoints' skeletons reached from the same first start, nearest by this
		// waypoint's field, EEAT_SKEL_XLV=1 above)
		// (also over a memo whose deepest level the pool beats by the same factor: a call's first rungs leave a shallow memo
		// long before the other waypoints' skeletons are deep)
		const xlSt = SKEL_XLV ? skelMemo.get(key) : null;
		const xlTop = xlSt && xlSt.length ? xlSt[xlSt.length - 1].c : c0;
		if (SKEL_XLV && skelXL.has(startStrs[0]) && f0 && Number.isFinite(xlTop) && xlTop > SKEL_STEP * 4) {
			const tX = Date.now(), m0 = tileMin(f0), lab = wp.label || '';
			const cand = [];
			for (const lv of skelXL.get(startStrs[0])) {
				if (lv.label === lab || skelXLBad.has(key + '#' + lv.id)) continue;
				const v = m0[lv.tile];
				cand.push({ lv, v: v >= 0 && Number.isFinite(v) ? v : Infinity });
			}
			cand.sort((a, b) => a.v - b.v || b.lv.id - a.lv.id);
			let bestL = null, tries = 0;
			// (EEAT_SKEL_XLV_DBG=1, a diagnosis: XLV_DBG candidates measured, each logged with its rank value; slower)
			const dbg = XLV_DBG > 0 ? [] : null;
			// (the diagnosis: half the best by the rank, half a stride over the rest)
			const half = XLV_DBG >> 1, restC = dbg ? cand.slice(half) : null, strideC = dbg ? Math.max(1, Math.floor(restC.length / Math.max(1, half))) : 1;
			const order = dbg ? cand.slice(0, half).concat(restC.filter((x, i) => i % strideC === 0)) : cand;
			for (const { lv, v } of order) {
				if (dbg) {
					if (tries >= XLV_DBG || Date.now() - tX > 8000) break;
					const own = lv.cur.filter((s) => startStrs.some((p) => s.length >= p.length && s.startsWith(p)));
					let fc = null;
					try { const fw = own.length ? fieldAt(own[0], goal, wp.allowDeath, wArr) : null; fc = fw && fw.f && fw.c >= 0 ? Math.round(fw.c) : null; } catch (e) { fc = 'err'; }
					dbg.push([Number.isFinite(v) && v < 1e9 ? Math.round(v / 5) : null, fc, lv.label, lv.tile % L.width, (lv.tile / L.width) | 0]);
				}
				if (tries >= (dbg ? XLV_DBG : XLV_TRY) || Date.now() - tX > (dbg ? 8000 : XLV_MS)) break;
				const own = lv.cur.filter((s) => startStrs.some((p) => s.length >= p.length && s.startsWith(p)));
				if (!own.length) continue;
				if (DEAD_ON && deadEnds.size && own.every((s) => deadEnds.has(hashOf(s)))) continue;
				tries++;
				let fw;
				try { fw = fieldAt(own[0], goal, wp.allowDeath, wArr); } catch (e) { continue; }
				if (!fw.f || !(fw.c >= 0) || !Number.isFinite(fw.c)) continue;
				if (!(fw.c < XLV_F * xlTop) || (bestL && fw.c >= bestL.c)) continue;
				bestL = { c: fw.c, cur: own, xid: lv.id, from: lv.label };
			}
			S.xlvTry = (S.xlvTry || 0) + tries; S.xlvMs = (S.xlvMs || 0) + (Date.now() - tX);
			if (bestL) {
				const ent = { c: bestL.c, cur: bestL.cur, xid: bestL.xid };
				if (xlSt) xlSt.push(ent); else skelMemo.set(key, [ent]);
				S.xlv = (S.xlv || 0) + 1;
			}
			if (emit) emit({ ev: 'exec.xlv', label: lab, c0: Math.round(c0), top: Math.round(xlTop), c: bestL ? Math.round(bestL.c) : null, from: bestL ? bestL.from : null, pool: cand.length, tries, ms: Date.now() - tX });
			if (emit && dbg) emit({ ev: 'exec.xlvdbg', label: lab, top: Math.round(xlTop), cands: dbg });
		}
		const memo = skelMemo.get(key);
		// (a memo level no deeper than the starts' own cost is not resumed: a relay start (the strategy's nearest state of the
		// last rung) can stand deeper than the skeleton's deepest level, and resuming went back up to it; EEAT_DEADEND=0: as
		// before)
		const top0 = memo && memo.length ? memo[memo.length - 1] : null;
		const top = top0 && (!DEAD_ON || top0.c < c0 - 0.5) ? top0 : null;
		let cur = top ? top.cur.slice() : startStrs, cCur = top ? top.c : c0;
		// (EEAT_SKEL_REMEAS=1: the call starts at its arrivals' own level by the sets' measure, above)
		if (SKEL_REMEAS && !top && f0) { const cm = tileCOf(cur, tileMin(f0)); if (cm < cCur) { S.remeasStart = (S.remeasStart || 0) + 1; S.remeasTiles = (S.remeasTiles || 0) + Math.round(cCur - cm); cCur = cm; } }
		const levels = [];
		// (the step adapts: a sub-leg found in under a third of its share doubles it (fast motion: fewer legs, fewer goal
		// fields to build), a failed one halves it for its retry)
		let lastFail = null, sims = 0, retried = false, stuck = false, step = SKEL_STEP, firstExh = false, backs = 0, okRun = 2;
		const runupTried = new Set(), structTried = new Set();
		while (Date.now() < deadline - 100) {
			// (new counterexample walls from the last sub-leg: the level where the skeleton stands, on the new field)
			if (wRefresh()) {
				let fw;
				try { fw = fieldAt(cur[0], goal, wp.allowDeath, wArr); } catch (e) { fw = { f: null }; }
				if (!fw.f || !(fw.c >= 0)) break;
				// (the step holds: new walls after a failed sub-leg re-measure the level, and the retry is the halved step on
				// the new field, not a fresh start: every failed sub-leg learns walls, so the fresh start never let the call
				// end stuck and it spent the rest of its time on the same failing target, 1.5-3 s a try)
				cCur = fw.c; key = skelKey(goal, wp, startStrs, wN);
				if (SKEL_REMEAS) { const cm = tileCOf(cur, tileMin(fw.f)); if (cm < cCur) { S.remeasWalls = (S.remeasWalls || 0) + 1; S.remeasTiles = (S.remeasTiles || 0) + Math.round(cCur - cm); cCur = cm; } }
				if (STEP_HOLD && retried) step = Math.max(SKEL_STEP / 2, Math.min(step, SKEL_STEP));
				else { step = SKEL_STEP; retried = false; }
			}
			const left = deadline - Date.now();
			if (cCur <= SKEL_STEP * 1.5) break;
			const c = Math.max(SKEL_STEP / 2, cCur - step);
			// (the sub-level set on the field of the current arrivals' doors)
			let fr;
			try { fr = fieldAt(cur[0], goal, wp.allowDeath, wArr); } catch (e) { fr = { f: null }; }
			if (!fr.f) break;
			const m = tileMin(fr.f), lim = Math.round(c * 5), tiles = [];
			for (let t = 0; t < m.length; t++) if (m[t] <= lim) tiles.push(t);
			if (!tiles.length) break;
			// (a sub-leg's share: its part of the way (3 steps' worth), at least 300 ms; a failed one once more with half of
			// what is left)
			const share = retried ? Math.max(300, 0.5 * left) : Math.min(left - 50, Math.max(300, left * Math.min(0.5, (3 * step) / cCur)));
			const sub = { kind: 'region', tiles, expect: null, allowDeath: !!wp.allowDeath, fieldTiles: Array.from(T.fieldTilesOf(goal)), fieldTouch: T.fieldTouchOf(goal), label: `${wp.label || wp.kind} (skeleton ${Math.round(c)} tiles)` };
			let r = await reachLeg(cur, sub, { ms: share, level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline: Math.min(deadline, Date.now() + share), stop: budget.stop }, true);
			sims += r.sims || 0;
			// (the dead ends' states dropped from a sub-leg's arrivals (above); every one of them a dead end: the sub-leg once
			// more for DEAD_K arrivals in what is left of its share, else an 'exhausted' sub-leg (a dead end too))
			if (DEAD_ON && r.ok && deadEnds.size) {
				const keep = (x) => { const a = x.arrivals.filter((q) => !deadEnds.has(hashOf(T.strOf(q.masks)))); return a.length ? Object.assign({}, x, { arrivals: a }) : null; };
				let r2 = keep(r);
				if (!r2 && Date.now() < deadline - 150) {
					const s2 = Math.max(200, Math.min(share, deadline - Date.now() - 50));
					const rr = await reachLeg(cur, sub, { ms: s2, level: budget.level | 0, fast: !!budget.fast, k: DEAD_K, deadline: Math.min(deadline, Date.now() + s2), stop: budget.stop }, true);
					sims += rr.sims || 0;
					if (rr.ok) r2 = keep(rr);
				}
				if (!r2) { S.deadLegs = (S.deadLegs || 0) + 1; r = { ok: false, arrivals: [], tool: null, ms: r.ms, sims: 0, fail: { why: 'exhausted', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: 'skeleton: every arrival a dead end' } }; }
				else r = r2;
			}
			levels.push({ c: Math.round(c), ok: !!r.ok, ms: r.ms, tool: r.tool });
			if (!r.ok) {
				lastFail = r;
				okRun = 0;
				if (r.fail && r.fail.why === 'stopped') break;
				const exh = !!(r.fail && r.fail.why === 'exhausted');
				if (!retried) { retried = true; firstExh = exh; step = Math.max(SKEL_STEP / 2, step / 2); continue; }
				// (both tries 'exhausted' from a level the skeleton reached: a dead end: its states marked, one level back)
				if (DEAD_ON && exh && firstExh && cur !== startStrs && backs < DEAD_BACK && Date.now() < deadline - 300) {
					backs++; S.deadEnds = (S.deadEnds || 0) + 1;
					for (const s of cur) { const h = hashOf(s); if (h !== null) deadEnds.add(h); }
					const st = skelMemo.get(key) || [];
					while (st.length && st[st.length - 1].cur.every((s) => deadEnds.has(hashOf(s)))) st.pop();
					const prev = st.length ? st[st.length - 1] : null;
					cur = prev ? prev.cur.slice() : startStrs; cCur = prev ? prev.c : c0;
					retried = false; step = SKEL_STEP;
					levels.push({ back: Math.round(cCur) });
					continue;
				}
				// (THE RUN-UP RELAY, OPT-IN EEAT_RUNUP=1: the stuck sub-level set through a run's far end, once a level)
				if (RUNUP_ON && !runupTried.has(Math.round(cCur)) && Date.now() < deadline - 600) {
					runupTried.add(Math.round(cCur));
					const ru = await runupRelay(cur, sub, fr, budget, deadline);
					if (ru && ru.length) {
						levels.push({ c: Math.round(c), ok: true, runup: true });
						retried = false; okRun = 1; step = SKEL_STEP;
						cur = ru; cCur = c;
						if (!skelMemo.has(key)) skelMemo.set(key, []);
						skelMemo.get(key).push({ c: cCur, cur: cur.slice() });
						skelBasePush(key, cur);
						if (SKEL_XLV) xlPush(startStrs, wp, cur);
						continue;
					}
				}
				// (THE STRUCTURE RELAYS, OPT-IN EEAT_STRUCT=1: the stuck sub-level set through a place the way bends at, once a level)
				if (STRUCT_ON && !structTried.has(Math.round(cCur)) && Date.now() < deadline - 600) {
					structTried.add(Math.round(cCur));
					const sr = await structRelay(cur, sub, fr, cCur, lim, budget, deadline);
					if (sr && sr.length) {
						levels.push({ c: Math.round(c), ok: true, struct: true });
						retried = false; okRun = 1; step = SKEL_STEP;
						cur = sr; cCur = c;
						if (!skelMemo.has(key)) skelMemo.set(key, []);
						skelMemo.get(key).push({ c: cCur, cur: cur.slice() });
						skelBasePush(key, cur);
						continue;
					}
				}
				// (a resumed level whose next sub-leg fails twice: a dead end, one level back next time)
				if (top && levels.length === 2) {
					memo.pop();
					// (and not seeded again from the wall-free memo on the next walls)
					const ba = SKEL_REUSE ? skelBase.get(baseKeyOf(key)) : null;
					if (ba) { const i = ba.findIndex((lv) => lv.cur[0] === top.cur[0]); if (i >= 0) ba.splice(i, 1); }
					// (nor from another waypoint's level again, EEAT_SKEL_XLV)
					if (SKEL_XLV && top.xid !== undefined) skelXLBad.add(key + '#' + top.xid);
				}
				stuck = true;
				break;
			}
			retried = false;
			okRun++;
			if (r.ms < share / 3 && (!STEP_HOLD || okRun >= 2)) step = Math.min(SKEL_STEP * 4, step * 2);
			cur = r.arrivals.map((a) => T.strOf(a.masks));
			cCur = c;
			// (EEAT_SKEL_REMEAS=1: the arrivals' own level by the set's measure: they stand at or below c, often far below)
			if (SKEL_REMEAS) { const cm = tileCOf(cur, m); if (cm < cCur) { S.remeasOk = (S.remeasOk || 0) + 1; S.remeasTiles = (S.remeasTiles || 0) + Math.round(cCur - cm); cCur = Math.max(SKEL_STEP / 2, cm); } }
			if (!skelMemo.has(key)) skelMemo.set(key, []);
			skelMemo.get(key).push({ c: cCur, cur: cur.slice() });
			skelBasePush(key, cur);
			if (SKEL_XLV) xlPush(startStrs, wp, cur);
		}
		if (emit) emit({ ev: 'exec.skel', label: wp.label || '', c0: Math.round(c0), c: Math.round(cCur), resumed: !!memo, levels, walls: wN });
		// (COVER V3: the skeleton stuck, before the first route: the coverage finder alone on the whole leg from the step's
		// starts with COVER_STUCK of what is left; the rest of the call as before)
		const fFs = SKEL_FAR > 0 ? farF(c0) : 1;
		if (fFs < 1 && COVER_V3() && stuck && !!budget.fast && (budget.level | 0) >= COVER_RUNG && COVER_STUCK * fFs * (deadline - Date.now()) < 100) S.farCoverSkip = (S.farCoverSkip || 0) + 1;
		else if (COVER_V3() && stuck && !!budget.fast && (budget.level | 0) >= COVER_RUNG && deadline - Date.now() > 300) {
			const vMs = COVER_STUCK * fFs * (deadline - Date.now());
			const rv = await reachLeg(starts, wp, { ms: vMs, level: budget.level | 0, fast: true, k: budget.k, deadline: Math.min(deadline, Date.now() + vMs), stop: budget.stop, next: budget.next || null, cover: 1 });
			S.coverStuck = (S.coverStuck || 0) + 1;
			if (rv.ok || (rv.fail && (rv.fail.why === 'stopped' || rv.fail.why === 'dies'))) { if (rv.ok) S.coverStuckOk = (S.coverStuckOk || 0) + 1; return rv; }
		}
		// (stuck with DEAD_REST of the call or more left: the direct leg from the deepest level AND the starts with the rest
		// (the sub-level sets' way is the relaxation's; the finders from the starts may know another: Endless Space's direct
		// leg reached route tick ~1,000 of 1,821 in 5 s where the skeleton sat at ~350), instead of returning the time unused)
		let restDirect = false;
		const cur0 = cur;
		if (DEAD_ON && stuck && cur !== startStrs && SKEL_FAR > 0 && farF(cCur) < 1 && deadline - Date.now() > DEAD_REST * ms) S.farRestSkip = (S.farRestSkip || 0) + 1;
		else if (DEAD_ON && stuck && cur !== startStrs && deadline - Date.now() > DEAD_REST * ms) { cur = cur.concat(startStrs.filter((s) => !cur.includes(s))); stuck = false; restDirect = true; S.deadDirect = (S.deadDirect || 0) + 1; }
		if (Date.now() >= deadline - 100 || (stuck && cur !== startStrs)) {
			const fail = (lastFail && lastFail.fail) || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: 'skeleton: out of time' };
			const cl = skelClosest(fail.closest, cur !== startStrs ? cur : [], f0);
			return { ok: false, arrivals: [], tool: null, ms: Date.now() - tIn, sims, legs: [], lb: 0, fail: Object.assign({}, fail, { why: 'budget', closest: cl }) };
		}
		// (the last leg to the waypoint itself, from the deepest arrivals reached)
		const r = await reachLeg(cur, wp, { ms: deadline - Date.now(), level: budget.level | 0, fast: !!budget.fast, k: budget.k, deadline, stop: budget.stop, next: budget.next || null });
		// (a failure after sub-legs is no proof: the time was split)
		if (cur === startStrs) {
			if (!r.ok && levels.length && r.fail && r.fail.why !== 'stopped') r.fail = Object.assign({}, r.fail, { why: 'budget' }, CLOSEST_UNIT() ? { closest: skelClosest(r.fail.closest, startStrs, f0) } : {});
			return r;
		}
		// (the arrivals' legs are the whole way from the step's own starts: the start that prefixes each)
		if (r.ok) {
			r.legs = r.arrivals.map((a) => {
				let si = -1;
				for (let i = 0; i < startStrs.length; i++) if (a.masks.length >= startStrs[i].length && T.strOf(a.masks.subarray(0, startStrs[i].length)) === startStrs[i] && (si < 0 || startStrs[i].length > startStrs[si].length)) si = i;
				const t0 = si >= 0 ? startStrs[si].length : 0;
				if (a.leg) { a.leg.start = si; a.leg.ticks = a.masks.length - t0; a.leg.tool = 'skel+' + (a.leg.tool || r.tool); }
				return { start: si, ticks: a.masks.length - t0, lb: 0, proven: false, tool: 'skel+' + (r.tool || '') };
			});
			r.lb = 0;
			r.tool = 'skel+' + (r.tool || '');
		} else if (restDirect && !(r.fail && r.fail.why === 'stopped')) {
			// (the rest's direct leg found nothing: the stuck skeleton's own report, as before (its sub-leg's closest: the
			// planner and the relays read it; I Wanna be the Guy lost its trigger progress 11 -> 1 when this call reported
			// the direct leg's closest instead: lane 2 / 3's accidental diversifier))
			const fail = (lastFail && lastFail.fail) || { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: 'skeleton: out of time' };
			const cl = skelClosest(fail.closest, cur0, f0);
			return { ok: false, arrivals: [], tool: null, ms: Date.now() - tIn, sims, legs: [], lb: 0, fail: Object.assign({}, fail, { why: 'budget', closest: cl }) };
		} else {
			if (r.fail && r.fail.why !== 'stopped') r.fail = Object.assign({}, r.fail, { why: 'budget' });
		}
		r.ms = Date.now() - tIn;
		return r;
	}
	async function reachLeg(starts, wp, budget, inner) {
		const tIn = Date.now();
		budget = budget || {};
		const ms = budget.ms > 0 ? budget.ms : 3000;
		const deadline = Math.min(budget.deadline > 0 ? budget.deadline : Infinity, tIn + ms);
		const k = budget.k > 0 ? budget.k : K_DEFAULT;
		S.reach++;
		const startStrs = starts.map((a) => (typeof a === 'string' ? a : T.strOf(a.masks)));
		const w = wpData(wp);
		// (the counterexample walls of this waypoint's field tiles, learnt by the calls before: to the core with the waypoint;
		// walls that cut every start off: their last batch dropped and the call made again without it)
		const wk = WALLS_ON ? wallKeyOf(wp) : null;
		if (stuckOn(wk)) w.wallsOn = true;
		let res;
		for (let attempt = 0; ; attempt++) {
			const wset = wk ? wallMemo.get(wk) : null;
			if (wset && wset.size) w.walls = Array.from(wset); else delete w.walls;
			const wtb = wk ? wallTabu.get(wk) : null;
			if (wtb && wtb.size) w.wallsTabu = Array.from(wtb); else delete w.wallsTabu;
			res = await dispatchLeg(startStrs, w, budget, ms, k, deadline);
			if (!(wk && res && res.fail && res.fail.wallsCut && attempt < 6 && Date.now() < deadline - 100)) break;
			wallDropLast(wk, wp.label);
		}
		// (the walls this call's exhausted search found join its field's; the closest it reports is in the unit of the field
		// with the walls it was given: wallsN, the strategy's relays compare only within one unit)
		if (res && res.fail) {
			const wN0 = w.walls ? w.walls.length : 0;
			if (wk && res.fail.wallsCut) wallDropLast(wk, wp.label);
			else if (wk && Array.isArray(res.fail.walls) && res.fail.walls.length) {
				let s = wallMemo.get(wk);
				if (!s) { s = new Set(); wallMemo.set(wk, s); wallBatches.set(wk, []); }
				const tabu = wallTabu.get(wk);
				const batch = [];
				for (const t of res.fail.walls) { if (s.size >= WALLS_MAX) break; if (!s.has(t) && !(tabu && tabu.has(t))) { s.add(t); batch.push(t); } }
				if (batch.length) { wallBatches.get(wk).push(batch); S.walls += batch.length; if (emit) emit({ ev: 'exec.walls', label: wp.label || '', added: batch.length, total: s.size }); }
			}
			delete res.fail.walls;
			res.fail.wallsN = wN0;
		}
		return finalize(res, starts, wp, tIn);
	}
	/** one core reach (this thread's core without workers, else a worker's): its raw result */
	async function dispatchLeg(startStrs, w, budget, ms, k, deadline) {
		let res;
		if (nW === 0) {
			try { res = await core.reach(startStrs, w, { ms, level: budget.level | 0, fast: !!budget.fast, k, deadline, stop: budget.stop, next: budget.next || null, cover: budget.cover | 0 }); }
			catch (e) { res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: `error: ${e && e.message || e}` } }; }
		} else {
			const sab = new SharedArrayBuffer(4), flag = new Int32Array(sab);
			let poll = null;
			if (typeof budget.stop === 'function') poll = setInterval(() => { try { if (budget.stop()) Atomics.store(flag, 0, 1); } catch (e) { /* ignore */ } }, 20);
			const pending = dispatch({ type: 'reach', starts: startStrs, wp: w, budget: { ms, level: budget.level | 0, fast: !!budget.fast, k, deadline, next: budget.next || null, cover: budget.cover | 0 }, tDisp: PROF ? Date.now() : 0 }, deadline, sab);
			// (while the worker searches: the starts replayed from the level start in this thread too, for finalize's checks)
			for (const s of startStrs) { try { core.startOf(String(s)); } catch (e) { /* finalize replays it again */ } }
			const msg = await pending;
			if (poll) clearInterval(poll);
			if (msg.error || !msg.result) {
				const why = !msg.watchdog && Atomics.load(flag, 0) ? 'stopped' : 'budget';   // (a late worker told to stop by the watchdog: 'budget', not the caller's stop)
				res = { ok: false, arrivals: [], tool: null, legs: [], lb: 0, fail: { why, closest: null, touched: [], blockedBy: [], level: budget.level | 0, note: msg.error || 'no answer' } };
			} else res = msg.result;
		}
		return res;
	}
	/** the StepResult of a core result: every arrival replayed from the level start in THIS thread (verified: the goal
	 *  first holds at its end, alive, beforeTick), an Arrival with this thread's snapshot and opts.RM's room */
	function finalize(res, starts, wp, tIn) {
		const goal = T.goalOf(L, wp);
		const beforeTick = wp.beforeTick >= 0 ? wp.beforeTick : -1;
		const out = { ok: false, arrivals: [], tool: res.tool || null, ms: 0, sims: res.sims || 0, legs: res.legs || [], lb: res.lb || 0, fail: res.fail || null, tiers: res.tiers };
		// (the math tier's numbers from the core's tiers: the worker's own stats never cross threads)
		if (Array.isArray(res.tiers)) {
			for (const t of res.tiers) {
				if (!t) continue;
				if (t.tier === 'math') { S.math.direct++; S.math.directMs += t.ms || 0; if (t.ok) S.math.directOk++; }
				else if (t.tier === 'math-chain') { S.math.chain++; S.math.chainMs += t.ms || 0; if (t.ok) S.math.chainOk++; }
				else if (t.tier === 'portfolio') { S.math.pf = (S.math.pf || 0) + 1; S.math.pfMs = (S.math.pfMs || 0) + (t.ms || 0); if (t.ok) { S.math.pfOk = (S.math.pfOk || 0) + 1; const k = 'pfBy_' + (t.arm || '?'); S.math[k] = (S.math[k] || 0) + 1; } if (t.resumed) S.math.pfResumed = (S.math.pfResumed || 0) + 1; if (t.deferred && t.deferred.length) S.math.pfDeferred = (S.math.pfDeferred || 0) + 1; if (t.why && /^error/.test(t.why)) S.math.pfErr = t.why; }
				else if (t.tier === 'corridor') { S.math.corr = (S.math.corr || 0) + 1; S.math.corrMs = (S.math.corrMs || 0) + (t.ms || 0); if (t.ok) S.math.corrOk = (S.math.corrOk || 0) + 1; S.math.corrExp = (S.math.corrExp || 0) + (t.expanded || 0); if (t.resumed) S.math.corrResumed = (S.math.corrResumed || 0) + 1; if (t.closest) S.math.corrClosest = (S.math.corrClosest || 0) + 1; if (t.error) S.math.corrErr = t.error; }
			}
		}
		const legsIn = Array.isArray(res.legs) ? res.legs : [];
		const aligned = res.ok && legsIn.length === (res.arrivals || []).length;
		const legsKept = [];
		if (res.ok) {
			for (let ai = 0; ai < res.arrivals.length; ai++) {
				const a = res.arrivals[ai];
				const masks = T.masksOf(a.masks);
				const st = starts[a.start];
				// (the start's state as this thread replayed it from the level start (core.startOf: cached, the longest
				// replayed prefix reused), then the leg's own inputs)
				const e = st === undefined ? null : core.startOf(typeof st === 'string' ? st : T.strOf(st.masks));
				const vs = e && masks.length >= e.tick && a.masks.startsWith(e.str) ? vsim : null;
				if (!vs || !verifyTail(vs, vinp, e.snap, e.tick, masks.subarray(e.tick), goal, beforeTick, !!wp.allowDeath)) { S.verifyDrop++; continue; }
				const arr = T.arrivalOf(L, vs, masks, RM);
				const lg = aligned ? legsIn[ai] : null;
				arr.leg = { start: a.start, ticks: a.ticks, tool: (lg && lg.tool) || res.tool };
				out.arrivals.push(arr);
				if (aligned) legsKept.push(lg);
				// (the math's legs and proofs; every other tier's leg a PATTERN: its run-length inputs from its start's support
				// class and speeds, what the mathematics must learn to evaluate)
				const tool = String((lg && lg.tool) || res.tool || '');
				if (tool.startsWith('math')) {
					S.math.legs++; S.math.byTool[tool] = (S.math.byTool[tool] || 0) + 1;
					if (lg && lg.proven) { S.math.proven++; const b = lg.provenBy || '?'; S.math.provenBy[b] = (S.math.provenBy[b] || 0) + 1; }
				} else if (tool) {
					if (lg && lg.proven && lg.provenBy === 'events') S.math.certified++;
					S.patternsN++;
					if (S.patterns.length < PATTERNS_MAX) {
						vs.restore(e.snap);
						const tail = masks.subarray(e.tick);
						let ch = 0;
						for (let t = 1; t < tail.length; t++) if ((tail[t] & 31) !== (tail[t - 1] & 31)) ch++;
						S.patterns.push({ label: wp.label || wp.kind || '', kind: wp.kind || '', tool, ticks: tail.length, changes: ch, runs: runsOf(tail),
							from: { cls: mClsOf(vs), tile: T.tileOf(vs, L.width, L.height), px: vs.px, py: vs.py, vx: vs.speed_x, vy: vs.speed_y, ground: !!vs.on_ground, jumps: vs.jump_count },
							lb: lg && Number.isFinite(+lg.lb) ? +lg.lb : null, lbMath: lg && Number.isFinite(+lg.lbMath) ? +lg.lbMath : null, proven: !!(lg && lg.proven) });
					}
				}
			}
			S.math.arrivals += out.arrivals.length;
			if (aligned) out.legs = legsKept;
			if (out.arrivals.length) out.ok = true;
			else { out.tool = null; out.fail = { why: 'budget', closest: null, touched: [], blockedBy: [], level: 0, note: 'no arrival survived the replay' }; }
		}
		if (out.fail && out.fail.closest && typeof out.fail.closest.masks === 'string') out.fail.closest.masks = T.masksOf(out.fail.closest.masks);
		out.ms = Date.now() - tIn;
		S.ms += out.ms; S.sims += out.sims;
		if (out.ok) { S.ok++; S.byTool[out.tool] = (S.byTool[out.tool] || 0) + 1; } else { S.fail++; const w = out.fail ? out.fail.why : '?'; S.byWhy[w] = (S.byWhy[w] || 0) + 1; }
		if (emit) emit({ ev: 'exec.reach', label: wp.label || '', ok: out.ok, tool: out.tool, ms: out.ms, sims: out.sims, legs: out.legs, lb: out.lb, why: out.fail ? out.fail.why : null });
		return out;
	}

	async function polish(masks, o) {
		o = o || {};
		S.polish++;
		const str = typeof masks === 'string' ? masks : T.strOf(masks);
		const po = { ms: o.ms > 0 ? o.ms : 30000, legs: o.legs || null, allowDeaths: o.allowDeaths !== false };
		let r;
		// (with 2+ workers the first mutation pass (polish.js (a2)) scans the route's ranges on every worker at once, its
		// shortcuts handed to the polish in one worker (o.first); the time it took is taken off the polish)
		if (nW >= 2 && process.env.EEAT_PAR_POLISH !== '0') {
			const t1 = Date.now();
			const n = T.masksOf(str).length;
			const parts = Math.min(nW, Math.max(1, Math.floor(n / 64)));
			const dl = t1 + 0.5 * po.ms;
			const jobs = [];
			for (let k = 0; k < parts; k++) {
				const a = Math.floor((k * n) / parts), b = Math.floor(((k + 1) * n) / parts);
				jobs.push(dispatch({ type: 'mutscan', masks: str, o: { ranges: [[a, b]], deadline: dl } }, dl + 5000, new SharedArrayBuffer(4)));
			}
			const res = await Promise.all(jobs);
			if (res.every((m) => m && m.result)) {
				po.first = [].concat(...res.map((m) => m.result.shortcuts));
				po.firstTimeUp = res.some((m) => m.result.timeUp);
			}
			po.ms = Math.max(1, po.ms - (Date.now() - t1));
		}
		if (nW === 0) r = await core.polish(str, po);
		else {
			const msg = await dispatch({ type: 'polish', masks: str, o: po }, Date.now() + po.ms + 5000, new SharedArrayBuffer(4));
			r = msg && msg.result ? msg.result : null;
			if (!r) r = await core.polish(str, Object.assign({}, po, { ms: Math.min(po.ms, 2000) }));
		}
		// (never a slower or unfinished route: checked here again)
		const C = require('../common.js');
		const m0 = typeof masks === 'string' ? T.masksOf(masks) : masks;
		const ev0 = C.evaluate(L, m0, false);
		const m1 = typeof r.masks === 'string' ? T.masksOf(r.masks) : r.masks;
		const ev1 = C.evaluate(L, m1, false);
		if (!ev1 || (ev0 && (ev1.runTicks > ev0.runTicks))) return { masks: ev0 ? ev0.ms : m0, runTicks: ev0 ? ev0.runTicks : -1, saved: 0, legs: r.legs || [] };
		return { masks: ev1.ms, runTicks: ev1.runTicks, saved: ev0 ? ev0.runTicks - ev1.runTicks : 0, legs: r.legs || [], steps: r.steps };
	}
	function stats() { return Object.assign({ workers: nW, notes: note.slice(), core: nW === 0 ? core.stats() : null }, S, FIELD_SHARE ? { fieldShare: T.shareStats() } : {}); }
	async function close() {
		if (PROF && emit) { emit({ ev: 'exec.prof.main', rf: accM.rf, rfN: accM.rfN, eld: eld ? { mean: eld.mean / 1e6, max: eld.max / 1e6, p99: eld.percentile(99) / 1e6 } : null }); if (eld) eld.disable(); }
		if (PROF && rfMain0) { RF.reachField = rfMain0; rfMain0 = null; }
		closed = true;
		for (const slot of pool) { slot.dead = true; try { await slot.w.terminate(); } catch (e) { /* gone */ } }
		pool.length = 0;
		for (const q of queue.splice(0)) q.resolve({ id: 0, error: 'closed' });
	}
	return { reach, polish, stats, close, workers: () => nW };
}

module.exports = { createExecutor, makeCore, verifyLeg, verifyTail, fingerprint, wpData, BASE_FEATS };
