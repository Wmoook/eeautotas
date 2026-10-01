'use strict';
// THE ABSTRACT PLANNER (n4plan, part 'planner': the compiler's PLAN stage and the CEGAR loop's planning side).
// createPlanner(model, facts, {bounds, seed}) -> {plan, learn, lowerBound, costOf, explain, stats}.
//
// The abstract graph: a node = (S, position): S the model's abstract state (the features some gate reads, the coin tiles
// taken, the checkpoint where a death moves the ball), the position the tiles of the last trigger touched (or the
// anchor's tile; the respawn after a death step). Edges: "touch trigger X next" for every relevant trigger whose touch
// changes S and that the lb walk relaxation under S reaches from the position (the walk BFS: killers and one-ways
// passable, keys sticky, portal hops, the death shortcut: its INF is a proof for the relaxation, so no edge is dropped
// without one); the trophy edge; a death step where only a death reaches a target (est).
//   - est (the plans' ranking): facts.okTicks when learned, else max(lb, est walk steps x the pace (the median of the
//     learned ticks / steps, 4 at first)); the est walk walls killers unless protected and the CEGAR cuts; an edge only
//     the relaxation reaches, or that RCH3 calls impossible from the position at rest or rising (verifyPath), a heavy
//     penalty (never a drop; RCH3's -1 from the anchor's REAL state: a proof, dropped). The plans: weighted A* on est
//     (k-best, diverse by the first step), greedy on the level's LANDMARKS in a puzzle (3+ left: LAMA's greedy best
//     first), a one-step partial plan at least whatever the budget.
//   - lb: ADMISSIBLE ticks (model.pairLb: ceil(16 (D - 1) / 16.25) of the lb walk steps D, a portal hop's entry step
//     free, the death shortcut to the respawn the state holds; o.bounds.pair where no death can shortcut and no coin
//     gate, the larger of both). A touch that shuts a gate the ball overlaps is DEFERRED by the engine: the next leg
//     starts from its deferral region (posOf). lowerBound(anchor): A* on lb, h = the same bound on the level with every
//     gate open (admissible; nodes re-opened on a better g), the optimum when it completes, else the least f on the open
//     list; an anchor with a change still queued is bounded from the state it will be (model.pendingOf).
//   - B&B: plan(anchor, {depth}) drops every node whose lb to the trophy puts it at depth or past.
// Waypoints (types.js): a trigger -> {kind 'trigger', tiles (a coin trigger's untaken tiles), trig, expect, label}; the
// trophy -> {kind 'trophy'}; a key followed by its door -> a region step past the door (beforeTickFrom 'prev+500', or
// beforeTick when the key is the anchor's own); a death step -> {kind 'region', tiles: the respawn tiles, expect deaths +
// 1, allowDeath}.
// learn(step, result, anchor) -> Fact[] (>= 1, the version bumped, whenever !result.ok): fail -> the next rung; the
// facts' rungs -> block; why 'proof' -> proof (never from that S again); blockedBy -> needs (the gate's feature first);
// a failure at its second rung or exhausted with a closest approach -> a CUT of the est walk just past it (the next plans
// go another way: Cold World's pool); ok -> ok (the edge's ticks, the pace).
const E = require('../eesim.js');
const T = require('./types.js');
const { lbOfSteps, INF, DEAD_TICKS } = require('./model.js');

const PACE0 = 4;              // est ticks per walk step before any learned leg
const EST_W = 1.5;            // the plan search's heuristic weight (est only; the lb search is plain A*)
const PENALTY = 1e6;          // est of an edge only the relaxation reaches (no est walk) or RCH3 calls impossible
// THE LONG LEG'S CONVEX PRICE (n5 doctor 2, OPT-IN EEAT_PLAN_LEGT=<ticks>, default 0 = off; EEAT_PLAN_LEGK, default 1): 11 of
// batch 2's 21 failing levels (12 of FINAL's first 51) plan the level as the trophy alone or 1-2 legs of lb 150-3,000 ticks (the
// gravity-blind est walk finds the trophy open, so nothing between is relevant), and every such compile ends at gain 0-2, while
// the known-route test finds the same level's 400-600-tick checkpoint legs at rung 1 (EE mountain world: from the spawn 661 ticks,
// from hit-600 / 400 630 / 400): a leg's est past LEG_T costs LEG_K more a tick, so the plan search prefers a chain through the
// relevant triggers on the way (checkpoints where a death can move the ball, coins) to one long leg. Ordering only (the lb and the
// B&B untouched)
const LEG_T = Math.max(0, +process.env.EEAT_PLAN_LEGT || 0), LEG_K = +process.env.EEAT_PLAN_LEGK > 0 ? +process.env.EEAT_PLAN_LEGK : 1;
const LM_W = 60;              // ticks of the plan search's f per landmark not yet achieved (src/landmarks.js, LAMA's count)
const GAIN_BONUS = 3;         // walk steps of the plan search's f per unit of gain (the relevant triggers achieved)
const INC_ON = process.env.EEAT_PLAN_INC !== '0';   // the plan search's incumbent (search(): a generated goal at the budget's end)
const KEY_TICKS = 500;
// THE STATE TRICKS (n5-tricks, TRICK MINING 3; tools/cmp/tricks3.js over the 218 known routes that replay: 61 deaths in
// 22 routes, 30 of them RESPAWN SKIPS in 7 levels: the respawn nearer the route's next trigger by more than the dead
// ticks' worth of running, 23 walk tiles: Good Egg Galaxy, Katwalk 74 / 86, Operation Planet X 254, Your Decision 37,
// Ice Slide Ride 39, Inferno 43, First Person Maze (its switch column fallen twice: a death back to the checkpoint above
// it)). OPT-IN EEAT_TRICKS: '1' / 'all' every rule, else a list of names; unset = the planner before, byte for byte.
//   warp  DEATH WARP: an edge the est walk reaches is taken as a death (the nearest killer, the dead ticks, the state's
//         respawn) when that is cheaper by WARP_MIN est ticks and WARP_F of the walk (before: a death step only where no
//         est walk reached the target)
//   exh   EXHAUSTED -> DEATH: an edge whose leg the executor's exact search EXHAUSTED from a node class (no way there
//         without a death: a fall that cannot be climbed back, a one-way drop, a door shut behind) is offered from that
//         class only as its death variant (edge + '~w': a death back at a respawn, then the trigger; its own rungs), where
//         the level can kill and respawn; the claim was a claim about deathless ways only (goalOf: allowDeath false)
const TRK = require('./tricks.js');
const TR_WARP = TRK.has('warp');
const TR_EXH = TRK.has('exh');
const TR_DBG = process.env.EEAT_TRICKS_DEBUG === '1';
// (a forced chain's plan: its boost tile first as a region step, EEAT_CHAIN_HEAD=0: the chain's step alone)
const CHAIN_HEAD = process.env.EEAT_CHAIN_HEAD !== '0';
const WARP_MIN = +process.env.EEAT_WARP_MIN || 30;       // est ticks a warp must save at least
const WARP_F = +process.env.EEAT_WARP_F || 0.8;          // and the death's est at most this share of the walk's
// the diversification rule (nearPlans): one-step plans to the nearest untried triggers once every plan's first leg
// failed its rung; DEFAULT 1 since COMPILE-ALL block 3 lane 4 (with the executor's true skeleton closest,
// EEAT_SKEL_CLOSEST): EEAT_PLAN_NEAR=K (K near plans; 0: off, the planner as before)
const NEAR_K = process.env.EEAT_PLAN_NEAR !== undefined ? Math.max(0, +process.env.EEAT_PLAN_NEAR | 0) : 1;
const NEAR_RUNG = process.env.EEAT_NEAR_RUNG !== '0';   // (the rung balance of the near plans: nearPlans; EEAT_NEAR_RUNG=0 off)
const NEAR_FAR = () => process.env.EEAT_NEAR_FAR === '1';   // (no nearer trigger: the nearest farther one; nearPlans; OPT-IN)
// THE CROSS-CLASS FAILURE PRICE (n5 doctor b9; OPT-IN EEAT_PLAN_FAILEST=<ticks a failed rung>, 0 / unset: off, the planner
// as before): the facts' rung ladder is per (edge, node class), and the node class is the whole abstract state (every
// switch, the checkpoint) + the start's speed, so a leg that failed every rung from one anchor comes back at rung 0, 1, 2,
// 3 from the next anchor, and the plan search, pricing it by the est walk alone, puts it first again (Bad EE Level 9, 180 s:
// purple switch 3's mini (a low-gravity spike corridor) failed its 45-s rung from the start, then from the mini's own
// entrance at the same closest (40.6 tiles, (130,160)), then from 4 more anchors: 17 steps, 190 of the 360 worker-s, never
// reached, while its sibling minis waited). Every failed rung of an edge from ANY class (facts.failsAny) adds FAIL_EST
// ticks to its est unless some class reached it (facts.okAnyOf): an untried sibling goes first, a hard leg comes back
// after the others' rungs (iterative deepening across the plan's independent steps). Ordering only (the est; the lb, the
// proofs and the blocks untouched).
const FAIL_EST = process.env.EEAT_PLAN_FAILEST !== undefined ? Math.max(0, +process.env.EEAT_PLAN_FAILEST || 0) : 0;
// THE TOGGLE-BACK (n5 doctor b9; OPT-IN EEAT_PLAN_UNTOGGLE=1, else the planner as before): a purple / orange switch toggles,
// so touching the trigger that just turned a switch ON (the plan node's own entering edge, or the anchor's arrival edge:
// strategy anchorArg `via`), or its reset, turns it OFF again: the abstract state goes back to the one before (a no-op
// pair), only the ball's modelled position moved. The plan search's alternatives (plans 2 and 3 exclude the best plan's
// first edge) took exactly such pairs ("purple switch 2 > purple switch 2 > blue key", "purple switch 1 > purple switch 1
// > blue key"), and the strategy ran their first step: a leg whose start stands ON the switch (closest "0 tiles",
// 'exhausted' at rungs 0 and 1) or, when found, an anchor that UNDID the progress (Bad EE Level 9, 180 s: 5 such steps,
// one 'purple switch 2' arrival with switch 2 off again); the near rule offered the reset next to it ("purple reset 2
// (66,86)", lb 0). Such an edge is skipped where it undoes the node's / anchor's own last toggle. Ordering only: a
// toggle-back after any other trigger stays an edge (a plan may need a switch off later), the lb and the proofs untouched.
const UNTOGGLE = process.env.EEAT_PLAN_UNTOGGLE === '1';
// THE LANDMARK PARTIAL (B7 lane b9 cycle 6; OPT-IN EEAT_PLAN_LMPART=1, off = the plan search byte for byte): a plan search
// whose budget ends before the trophy picks its partial plan by the fewest landmarks left, then the most gain, then the
// least f (search(): `better`), but only among the nodes it EXPANDED; on a switch level an expansion is ~20 ms (Bad EE
// Level 9: 2-11 nodes in a 100-ms search), so a child that achieves a landmark is generated at the root and never
// expanded when its est is the PENALTY (a relaxation-only edge: the est walls of the failed steps accumulate over every
// state until a deepening), and the cheap children (checkpoints, toggles back) are expanded and win. Box 7's c17DL
// (1,800 s): the leader (ids 1-13, 15) tried its last wave-3 switch 14 twice (rungs 0-1 at 1,238 s) and from 1,244 s no
// plan of any anchor held switch 14 again (20 of 505 plans), 94 of its 139 plans from 1,400 s a lone checkpoint; the same
// anchor's plan call with fresh facts plans 'purple switch 14' first (tools/cmp/planat.js). With the knob the partial
// pick reads every GENERATED node too (the same order), so a landmark one edge away is planned whatever its est.
// Ordering only: no edge added or dropped, the lb and the proofs untouched.
const LM_PART = process.env.EEAT_PLAN_LMPART === '1';
const TOGGLE_FEAT = /^(psw|osw):\d+$/;
// the floor probe's time (steer.js buildSteer on a level with count gates: the plan the steer's physics layers walk, run
// again with the gates the model leaves open as floors; env EEAT_PLAN_FLOOR=0: off)
const FLOOR_MS = +process.env.EEAT_PLAN_FLOOR_MS || 8000;
// (and its layers: the steer build grows its layer product a feature at a time and checks its clock only between
// features, so a switch maze (23_4 Switcher Puzzle: 14 switches, 224 layers) took 61.6 s against the 8 s asked, in the
// bounds stage, 51 s of a 60-s compile; the floors found so far need 6-20 layers: Aedan Garden 11, MoonBase 7, Rotcil
// Illusions 6, Springopolis 20; at 32 layers Switcher Puzzle stops at its cap)
const FLOOR_LAYERS = +process.env.EEAT_PLAN_FLOOR_LAYERS || 32;
// (off the critical path, o.floorAsync (the strategy's): the probe in a worker thread (src/plan/floorworker.js), the plans
// made before its answer without floors, the floors added when it answers (floorVersion() bumps: the strategy's plan memo
// re-plans); a probe still running at FLOOR_HARD_MS of wall time is terminated (no floors). The profile (lane 6, box 3):
// the probe was 8-45 s of the bounds stage on 13 of the 14 STAGE-TIME levels (MKco Mushroom Cup 45 s: 5 purple switches'
// 40 layers, 255 physics fields, no floor found; Dreamland 40 s, VVVVVV 37 s), where the floors it finds took 1.9-6.3 s
// (Tropical Trials' coins >= 20: 25-30 s on the loaded box, so the cap is 30 s)
const FLOOR_HARD_MS = +process.env.EEAT_PLAN_FLOOR_HARD_MS || 30000;
// THE LONG PLAN CALL (C6 push 3 block 4 lane 1; OPT-IN EEAT_PLAN_LONG=<ms>, 0 / unset = off: the planner as before, byte for
// byte): a plan call is 0.3 s (2 s the first), so on a switch level the plan search's budget ends before any trophy plan is
// generated and the strategy gets only PARTIAL "most gain" plans: First Person Maze (best known 832 run ticks) after its
// 31-switch column (gain 33-34) planned only switches 36 / 37, deaths and team 1, rung after rung, while a 30-s plan call from
// the known route's own state there finds a whole trophy plan (est 808), one that toggles the column's switches back OFF
// (src/out/n5/lanes/c6_lane1_b3.md (4)). The rule: when every plan of a plan call is partial (or priced by the PENALTY) and
// the first plan's first step has failed LONG_R rungs from the anchor's class (EEAT_PLAN_LONG_R, default 1: stuck, not just
// new), one LONG search from that anchor's abstract state (once a state, at most LONG_MAX a compile, at most a quarter of
// the compile's time left); a trophy plan found along est walks (its g below the PENALTY) goes first, and its path is kept:
// an anchor later in a state on that path gets the path's REST (a search guided along its edges, cheap) when its own plans
// are all partial again. Ordering only: no edge dropped, the lb and the proofs untouched. (The gain bonus is KEPT in the long
// search: from the route's tick-545 state (gain 33) 20 s with it found the 808 plan (1,237 nodes: the plan search expands
// ~60 nodes a second there), 20 s without it none (1,017 nodes); EEAT_PLAN_LONG_GAIN=0: without.)
// (its knobs are read per planner: createPlanner)
const COUNT_GATES = new Set([165, 214]);
const COLOURS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];

// THE TIMER (C6 push 3 lane 3; OPT-IN EEAT_PLAN_TIMER=1, off = the planner as before, byte for byte): a ball carrying a
// running timed killer (curse 421, zombie 422, poison 1584, fire: eesim.js kills it at start + duration) dies where the
// plan search's est walk does not know it: One Minute Descent's zombie (60 s, picked up on the only way down at tick ~50)
// kills every plan that takes the 15 blue coins (they open only the crown's doors) before team 6 (16,378) at the bottom
// and the levitation climb back to the trophy (65,49): its anchors reached team 6 at tick ~4,960 with ~1,100 ticks left
// for a 2,100-tick climb, every trophy leg 'budget' (the finders' states die), and the only routes (n5-plan and main
// alike) went through a death: 11,203-12,352 run ticks vs the known route's 3,550 (the zombie, the bottom, the climb).
// With the knob an anchor with a timer running first gets a DEADLINE plan search (its own half of the plan call's clock:
// a node whose est arrival from the anchor + the open level's walk to the trophy passes the ticks left is not generated):
// a whole plan to the trophy in time goes first (`timer`), the plan search's own plans after it; no such plan and no
// remover of that killer (its block numbered 0) within the ticks left = a LATE anchor, which the strategy's pick puts after
// the anchors in time. Ordering only (the est walk is no bound): no edge dropped from the plan search itself, the lb
// untouched, no claim.
const TIMER = process.env.EEAT_PLAN_TIMER === '1';
const TIMER_START = TIMER && process.env.EEAT_PLAN_TIMER_START !== '0';
// (the late rule alone: EEAT_PLAN_TIMER_LATE=0 = no anchor marked late, the deadline plans kept; the 36 timed levels' A/B, block 2:
// the knob on lost progress on 12 of 21 unrouted levels, gained on 2, and every one of 3 both-routed routes was slower)
const TIMER_LATE = TIMER && process.env.EEAT_PLAN_TIMER_LATE !== '0';
// THE TROPHY AS RANKED COMPONENTS (C6 lane 3 block 4; OPT-IN EEAT_TROPHY_COMP=1, off = the planner byte for byte): the
// trophy edge's target was the UNION of every trophy tile, so its est and the executor's goal field went to the NEAREST
// trophy, and a decorative one decoys the whole compile: Ice Cream Expedition has 6 trophy tiles, (5,177) sealed (solids
// on three sides, a one-way above that passes only a ball moving left), the routes end at (95,339); the chief's run ended
// 'trophy rung 3, closest 2 tiles at (5,175)'; DEEPER's (25,91) stands on live portals, the real one (42,91). With the
// knob a trophy step that fails at rung >= TCOMP_RUNG with its closest tile within TCOMP_NEAR tiles (Chebyshev) of a
// trophy component, while another component is still a target, adds a 'tdrop' fact (facts.js) for the anchor's abstract
// state (its doors / counts): the trophy edge from that state then goes to the other components only (edge
// 'trophy~t<ids>', its own rungs from 0; the waypoint carries their tiles, types.js goalOf: the field to them, the test
// still the crown). Ordering only: the lb / proofs read every trophy tile as before, the crown on any tile finishes.
const NEEDS_DEATHS = process.env.EEAT_NEEDS_DEATHS === '1';   // (THE DEATH DOOR'S NEED: openValue, executor.js blockedOnWay)
const TCOMP = process.env.EEAT_TROPHY_COMP === '1';
const TCOMP_RUNG = Math.max(0, +(process.env.EEAT_TROPHY_COMP_RUNG || 2) | 0);
const TCOMP_NEAR = Math.max(0, +(process.env.EEAT_TROPHY_COMP_NEAR || 2));
const TCOMP_GLOBAL = process.env.EEAT_TROPHY_COMP_GLOBAL !== undefined ? Math.max(0, +process.env.EEAT_TROPHY_COMP_GLOBAL | 0) : 2;
/** {left, id}: the ticks a ball has before its soonest running timed killer kills it (Infinity: none running; eesim.js's
 *  rule, Player.as:399-404: it dies on the first tick t with t - start > duration) and that killer's effect block (421
 *  curse, 422 zombie, 1584 poison, 0 fire: no remover block) */
function timerOf(s) {
	const r = { left: Infinity, id: -1 };
	if (!s || s.is_dead) return r;
	const t = s._ticks, god = !!s.in_god_mode;
	const one = (on, start, dur, id) => { if (on && dur) { const l = Math.floor(start + dur - t); if (l < r.left) { r.left = l; r.id = id; } } };
	one(s.is_cursed, s._curse_time_start, s._curse_duration, 421);
	if (!god) one(s.is_zombie, s._zombie_time_start, s._zombie_duration, 422);
	one(s.is_on_fire, s._fire_time_start, s._fire_duration, 0);
	if (!god) one(s.is_poisoned, s._poison_time_start, s._poison_duration, 1584);
	return r;
}

/** a heap on f (then g) */
class Heap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
	pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && Heap.lt(a[l], a[m])) m = l; if (r < a.length && Heap.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
	peek() { return this.a[0]; }
	static lt(x, y) { return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.seq < y.seq))); }
}

function createPlanner(model, facts, o = {}) {
	// (THE LONG PLAN CALL's knobs: the comment at the top)
	const LONG_MS = process.env.EEAT_PLAN_LONG !== undefined ? Math.max(0, +process.env.EEAT_PLAN_LONG || 0) : 0;
	const LONG_MAX = +process.env.EEAT_PLAN_LONG_MAX > 0 ? +process.env.EEAT_PLAN_LONG_MAX | 0 : 4;
	const LONG_GAIN = process.env.EEAT_PLAN_LONG_GAIN !== '0';
	const LONG_R = process.env.EEAT_PLAN_LONG_R !== undefined ? Math.max(0, +process.env.EEAT_PLAN_LONG_R | 0) : 1;
	const LONG_EXPAND = +process.env.EEAT_PLAN_LONG_EXPAND > 0 ? +process.env.EEAT_PLAN_LONG_EXPAND : 3000000;
	// (THE WALLS LIFTED, EEAT_PLAN_LONG_NOWALL=1, inside the long call only: the est walls (syncWalls: every failed step's
	// closest approach walls its 3 x 3, for EVERY state and position) accumulate, and in a compile the long search found only
	// plans through a relaxation-only edge (The Memory Game 1,008,291 / Fall of Zeal 1,003,176 from the start class, where
	// the same search with fresh facts finds 4,260 / 1,344: a 6-coin plan, the trophy): with the knob a long search that finds
	// nothing below the PENALTY runs once more with the walls lifted (the rungs, blocks and proofs as they are), its plan's
	// first step at its next rung (not one at its last rung from the class); its rest the same way)
	const LONG_NOWALL = process.env.EEAT_PLAN_LONG_NOWALL === '1';
	const L = model.L, W = model.W, H = model.H;
	const bounds = o.bounds && typeof o.bounds.pair === 'function' ? o.bounds : null;
	const ST = { rchChecks: 0, plans: 0, planMs: 0, expands: 0, lbCalls: 0, lbMs: 0, lbExpands: 0, learned: 0, costOf: 0 };
	const paceSamples = [];
	let lastPlans = [], lastWhy = '';
	// (EEAT_TRICKS exh: the (edge, node class) pairs whose leg the exact search exhausted: learn())
	const exhausted = new Set();
	const relevant = model.triggers.filter((X) => X.relevant && X.kind !== 'trophy' && !X.crumb).concat(model.chains || []);   // (+ the FORCED CHAINS, model.js, EEAT_TRICKS chain)
	// (the crumbs: coins no gate reads, relevant only with EEAT_CRUMBS=1 (model.js); left out of the plan search, offered
	// one at a time by crumbPlan)
	const crumbs = model.triggers.filter((X) => X.relevant && X.crumb);
	// ANY MEMBER (doctor 3, COMPILER-PUSH-2): the triggers whose touch makes the SAME abstract state from S (every tile
	// group of one key colour, of one switch id, one team, the crown: model.touch gives one S2) are ONE move. Before, each
	// tile group was an edge of its own and a waypoint of its own tiles: NC Naos Antediluvian (145 triggers, ~100 red-key
	// groups, most of them single tiles) planned 'red key (95,148) x29' / 'red key (75,163) x20' (the est walk's nearest
	// groups), the executor ended 6-13 tiles short of them from the spawn at every rung, the next plans took the next
	// group, and the compile ended with gain 0-1 in 60 and 180 s, where the known route takes the red key at (86,170) (a
	// single-tile group ~15 tiles from the spawn) at tick 374. Now one edge per (kind, S2): its tiles the UNION of the
	// members' live tiles (the goal field seeded at all of them: the finder takes whichever member the physics reaches),
	// its lb / est the least over them (admissible: a min of admissible bounds), its edge id the least member id (stable
	// for the facts whatever member is nearest), its pos2 the nearest member's (the plan's est goes on from there; the
	// next anchor is the real arrival, anchorOf). Coins never merge (their taken bits make S2 differ). o.anyMember /
	// EEAT_PLAN_ANY=1: on; off (the default until measured) = the planner as before, byte for byte.
	const ANY = o.anyMember !== undefined ? !!o.anyMember : process.env.EEAT_PLAN_ANY === '1';
	// (the SET kinds only: a touch sets the feature whatever it was; the toggles (psw / osw: a member the ball just
	// pressed is in the union at cost 0 where it stands) and the coins (their own taken bits) stay one edge a trigger)
	const ANY_KINDS = new Set(['key', 'team', 'prot', 'reset', 'fx', 'crown', 'pswR', 'oswR']);
	// BREADCRUMBS (crumbStep below; o.crumbs / EEAT_PLAN_CRUMBS=1: on; off (the default until measured) = the planner as before)
	const CRUMBS = o.crumbs !== undefined ? !!o.crumbs : process.env.EEAT_PLAN_CRUMBS === '1';
	const CRUMB_MIN = +process.env.EEAT_CRUMB_MIN || 60, CRUMB_REACH = +process.env.EEAT_CRUMB_REACH || 40, CRUMB_NEAR = 6;
	const CRUMB_SLACK = 3, CRUMB_SLACK_F = 0.03;
	const crumbCands = CRUMBS ? model.triggers.filter((X) => !X.relevant && (X.kind === 'coin' || X.kind === 'bcoin' || X.kind === 'cp') && X.tiles && X.tiles.length) : [];
	const trophyTiles = model.trophyTiles;
	const openS = { key: '__open__', dkey: '__open__', vals: [], feats: {} };
	// ---------------------------------------------------------------- floors (a count gate the way STANDS on)
	// The est walk is 8-way and gravity-blind: a coin gate (165 / blue 214, solid from its count on) is a wall in it, never
	// the floor a jump needs, and below its count it is air, so no plan collected the coins that make it solid first
	// (Springopolis, Aedan Garden, MoonBase, Rotcil Illusions: the trophy only from a count gate; the plan went straight to
	// the trophy, est 68 / 556 / 492 / 384 ticks, and every leg ran out of its budget). steer.js's floor probe (buildSteer:
	// its layered physics plan replayed with those gates as floors, a jump whose only support is such a gate names it)
	// gives the count; the trophy edge from a state below it gets the PENALTY (a price, never a drop: the probe is no proof)
	const floorNeeds = [];
	let floorVer = 0;
	// THE FLOOR'S ZONE (lane 4 b4): the probe names the floor the TROPHY's jump needs, and a trigger beside the trophy above
	// the same floor needs it as much: Nightmare Relics' trophy (98,132) is reached only from its 4-coin gate (98,136) (the
	// room's floor 6 rows down, a 3-row jump from the gate), and its protection effect (100,132) stands in the same room at
	// the same height: every PARTIAL plan went there first ("protection on (100,132)" 21 of 25 steps, closest 2 tiles,
	// 'budget' at every rung), the 4 coins never planned. A floor's zone: the tiles a jump from the probe's jump tile
	// (x.from) can reach above its support (x.at below it: gravity down; above it: up; beside it: no zone), within
	// FLOOR_ZX tiles across and FLOOR_ZY tiles up, kept only when the trophy is in it; a trigger edge whose live tiles all
	// lie in a zone gets the floor's need (the PENALTY, a price, never a drop, as the trophy's). EEAT_FLOOR_ZONE=0 off.
	const FLOOR_ZONE = process.env.EEAT_FLOOR_ZONE !== '0';
	const FLOOR_ZX = +process.env.EEAT_FLOOR_ZX || 4, FLOOR_ZY = +process.env.EEAT_FLOOR_ZY || 4;
	const zoneOf = (x) => {
		if (!FLOOR_ZONE || !x || !Array.isArray(x.at) || !Array.isArray(x.from) || !L || !L.fg) return null;
		const [ax, ay] = x.at, [fx, fy] = x.from;
		const up = ay > fy ? 1 : ay < fy ? -1 : 0;
		if (up === 0) return null;
		const z = new Uint8Array(W * H);
		for (let dy = 0; dy <= FLOOR_ZY; dy++) {
			const y = fy - up * dy;
			if (y < 0 || y >= H) continue;
			for (let xx = Math.max(0, fx - FLOOR_ZX); xx <= Math.min(W - 1, fx + FLOOR_ZX); xx++) z[y * W + xx] = 1;
		}
		for (const t of trophyTiles) if (z[t]) return z;
		return null;
	};
	/** the probe's floors (steer.js info.floors) -> floorNeeds: the most each count feature needs (and its zones) */
	const setFloors = (fl) => {
		const most = new Map(), zones = new Map();
		for (const x of fl || []) {
			if (!((x.feat === 'coins' || x.feat === 'bcoins') && x.param > 0 && model.feats.includes(x.feat))) continue;
			most.set(x.feat, Math.max(most.get(x.feat) || 0, x.param));
			const z = zoneOf(x);
			if (z) { if (!zones.has(x.feat)) zones.set(x.feat, []); zones.get(x.feat).push({ z, min: x.param }); }
		}
		floorNeeds.length = 0;
		for (const [feat, min] of most) floorNeeds.push({ feat, min, zones: zones.get(feat) || [] });
		ST.floors = floorNeeds.map((n) => `${n.feat}>=${n.min}${n.zones.length ? `(zones ${n.zones.length})` : ''}`).join(' ') || '';
		if (floorNeeds.length) floorVer++;
	};
	/** a trigger edge's floor need: its live tiles all in a zone of a floor whose count S has not reached */
	const zoneNeed = (S, tiles) => {
		for (const n of floorNeeds) {
			if (!n.zones.length) continue;
			const have = S.feats[n.feat] || 0;
			for (const q of n.zones) {
				if (have >= q.min) continue;
				let all = tiles.length > 0;
				for (const t of tiles) if (!q.z[t]) { all = false; break; }
				if (all) return true;
			}
		}
		return false;
	};
	if (process.env.EEAT_PLAN_FLOOR !== '0' && L && L.fg) {
		let has = false;
		for (let i = 0; i < L.fg.length && !has; i++) if (COUNT_GATES.has(L.fg[i])) has = true;
		if (has && model.feats && (model.feats.includes('coins') || model.feats.includes('bcoins'))) {
			const tf = Date.now();
			let started = false;
			if (o.floorAsync) {
				try {
					const { Worker } = require('worker_threads');
					const wd = { maxMs: FLOOR_MS, maxLayers: FLOOR_LAYERS };
					if (o.file) wd.file = require('path').resolve(String(o.file)); else wd.L = L;
					const w = new Worker(require('path').join(__dirname, 'floorworker.js'), { workerData: wd });
					ST.floorProbe = 'running';
					const hard = setTimeout(() => { if (ST.floorProbe === 'running') { ST.floorProbe = 'cut'; ST.floorMs = Date.now() - tf; } w.terminate().catch(() => {}); }, FLOOR_HARD_MS);
					if (hard.unref) hard.unref();
					w.on('message', (m) => {
						if (ST.floorProbe !== 'running') return;
						ST.floorProbe = m && m.error ? 'error' : 'done'; ST.floorMs = Date.now() - tf;
						if (m && !m.error) setFloors(m.floors);
						clearTimeout(hard); w.terminate().catch(() => {});
					});
					w.on('error', () => { if (ST.floorProbe === 'running') { ST.floorProbe = 'error'; ST.floorMs = Date.now() - tf; } clearTimeout(hard); });
					w.unref();
					started = true;
				} catch (e) { started = false; }
			}
			if (!started) {
				try {
					const st = require('../steer.js').buildSteer(L, { maxMs: FLOOR_MS, noDP: true, maxLayers: FLOOR_LAYERS });
					setFloors((st && st.info && st.info.floors) || []);
				} catch (e) { /* the probe is optional */ }
				ST.floorMs = Date.now() - tf;
			}
		}
	}
	ST.floors = floorNeeds.map((n) => `${n.feat}>=${n.min}${n.zones && n.zones.length ? `(zones ${n.zones.length})` : ''}`).join(' ') || '';
	// ---------------------------------------------------------------- positions
	const posOfTrig = new Map();
	/**
	 * the position after touching X in state S1 (the state before) giving S2. The engine DEFERS a change that would shut a
	 * door on the ball (a purple press in _tileQueue, a key / crown / orange switch in its queue, a team change retried)
	 * while the ball's box overlaps it, so the change's event can come later and elsewhere (The Flighty Slighty's switch
	 * column: each press shuts the door the ball falls through; First Person Maze: a press deferred through a portal hop).
	 * tiles: X's (the plan's waypoint, the est walk); grace: the shut gate components next to X, passable for the next leg;
	 * lbTiles (the lb's sources): X's tiles, and where the touch shuts a gate, the DEFERRAL REGION: the tiles within a tile
	 * of a gate it shuts reachable from X under S1 (portal hops included) and the tiles next to them (where the ball stops
	 * overlapping): every place the event can happen, so the next leg's bound stays sound
	 */
	const graceMemo = new Map();
	/** deferral(tiles, S1, S2) -> {grace, lbTiles, nShut} | null: the grace gates next to the tiles and the deferral region
	 *  of the change S1 -> S2 made there (null: it shuts no gate) */
	const shutMemo = new Map();
	/** the gate components the change S1 -> S2 shuts and the tiles within one of them (by the pass keys; null: none) */
	function shutOf(S1, S2) {
		const k = S1.pkey + '>' + S2.pkey;
		let r = shutMemo.get(k);
		if (r !== undefined) return r;
		r = null;
		for (const g of model.gates) {
			const j = g.tiles[0];
			if (!(model.gateOpen(j, S1, 'est', null) && !model.gateOpen(j, S2, 'est', null))) continue;
			if (!r) r = { near: new Uint8Array(model.N), gates: new Set(), nShut: 0 };
			r.gates.add(g.id);
			for (const t of g.tiles) {
				r.nShut++;
				const x = t % W, y = (t / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) r.near[ny * W + nx] = 1; }
			}
		}
		if (shutMemo.size > 4096) shutMemo.clear();
		shutMemo.set(k, r);
		return r;
	}
	function deferral(tiles, S1, S2) {
		const sh = shutOf(S1, S2);
		if (!sh) return null;
		const near = sh.near;
		let grace = null;
		const gs = new Set();
		for (const t of tiles) {
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const g = model.gateOf[ny * W + nx];
				if (g < 0 || gs.has(g)) continue;
				gs.add(g);
				if (sh.gates.has(g)) { if (!grace) grace = []; for (const tt of model.gates[g].tiles) grace.push(tt); }
			}
		}
		// the deferral region: a flood over the passable tiles (S1, lb) within one of a shut gate, seeded by the tiles and
		// the tiles next to them (the ball's box over them overlaps those, and it moves on while the change waits; First
		// Person Maze's press takes effect one portal hop later); out: the region and the tiles next to it (sparse sets)
		const m1 = model.passMask(S1, 'lb', null);
		const inR = new Set(), out = new Set(tiles), q = [];
		const ok = (j) => m1[j] === 1;   // (a shut gate of another feature is no way: only the tiles passable under S1)
		for (const t of tiles) {
			if (near[t] && !inR.has(t)) { inR.add(t); q.push(t); }
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (!ok(j)) continue;
				out.add(j);
				if (near[j] && !inR.has(j)) { inR.add(j); q.push(j); }
			}
		}
		while (q.length) {
			const c = q.pop(), x = c % W, y = (c / W) | 0;
			const visit = (j) => { if (!ok(j)) return; out.add(j); if (near[j] && !inR.has(j)) { inR.add(j); q.push(j); } };
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) visit(ny * W + nx); }
			const ex = model.A.portalExits.get(c);
			if (ex) for (const e of ex) visit(e);
		}
		const lbTiles = [...out].sort((p, q2) => p - q2);
		return { grace, lbTiles: lbTiles.length > tiles.length ? lbTiles : null, nShut: sh.nShut };
	}
	const posOf = (X, S1, S2) => {
		let rec = null;
		if (S1 && S2 && S1.pkey !== S2.pkey) {
			const gk = X.id + '|' + S1.pkey + '|' + S2.pkey;
			rec = graceMemo.get(gk);
			if (rec === undefined) {
				rec = deferral(X.tiles, S1, S2);
				if (graceMemo.size > 100000) graceMemo.clear();
				graceMemo.set(gk, rec);
			}
		}
		const grace = rec ? rec.grace : null, lbTiles = rec ? rec.lbTiles : null;
		const id = 't' + X.id + (grace ? '~' + grace[0] + ':' + grace.length : '') + (lbTiles ? '^' + lbTiles[0] + ':' + lbTiles.length + ':' + lbTiles[lbTiles.length - 1] : '');
		let p = posOfTrig.get(id);
		if (!p) { p = { id, tiles: X.tiles, trig: X.id, extra: 0, grace, lbTiles }; posOfTrig.set(id, p); }
		return p;
	};
	const respawnPos = { id: 'respawn', tiles: model.respawn, extra: DEAD_TICKS };
	const idlePos = { id: 'idle', tiles: model.idleTiles, extra: 0 };
	// the fully open level (every tile but the static walls): the heuristics
	let openMask = null;
	const openDist = new Map();
	const openOf = () => { if (!openMask) { openMask = new Uint8Array(model.N); for (let i = 0; i < model.N; i++) openMask[i] = model.A.cls[i] !== 0 ? 1 : 0; } return openMask; };
	// (the open level's walks backwards from the trophy and from the killing tiles (model.revDist): the same numbers as one
	// bfs per position (min over the goals), one search for every position; EEAT_PLAN_REVH=0: a bfs per position, as before:
	// Moving Ice Puzzle's root has 3,346 trigger positions, 16.7 s of bfs in its first lowerBound expansion, Cold World's 568
	// most of its first plan's 3.9 s)
	const REVH = process.env.EEAT_PLAN_REVH !== '0' && typeof model.revDist === 'function';
	let revTro = null, revDie = null;
	const hsMemo = new Map();
	const revMin = (R, tiles) => { let b = INF; for (const c of model.hopClosure(openOf(), tiles)) if (R[c] < b) b = R[c]; return b; };
	function hSteps(pos) {
		if (REVH) {
			let h = hsMemo.get(pos.id);
			if (h === undefined) { if (!revTro) revTro = model.revDist(openOf(), trophyTiles); h = revMin(revTro, pos.tiles); hsMemo.set(pos.id, h); }
			return h;
		}
		let d = openDist.get(pos.id);
		if (!d) {
			d = model.bfs(openOf(), pos.tiles);
			openDist.set(pos.id, d);
		}
		let b = INF;
		for (const t of trophyTiles) if (d[t] < b) b = d[t];
		return b;
	}
	/** the open level's walk steps from pos to the nearest tile the ball can die in */
	function dieSteps(pos) {
		if (REVH) {
			if (!revDie) { const g = []; for (let i = 0; i < model.N; i++) if (model.dieTile[i]) g.push(i); revDie = model.revDist(openOf(), g); }
			return revMin(revDie, pos.tiles);
		}
		hSteps(pos);
		const d = openDist.get(pos.id);
		let dk = INF;
		for (let i = 0; i < model.N; i++) if (model.dieTile[i] && d[i] < dk) dk = d[i];
		return dk;
	}
	let openResp = null;
	const hMemo = new Map(), hdMemo = new Map();
	/** the est walk steps from pos to the trophy on the open level, the death shortcut included (a death and a respawn
	 *  where no walk reaches the trophy: hSteps alone is INF there, and INF x pace became a partial plan's est of ~4.3e9:
	 *  The Square). The partial plans' cost only: the plan search's f keeps hSteps (with this in f The Square's first plan
	 *  reached the trophy, 9 steps, but Stupid Fox's first plan changed and lost its progress in the shared gate) */
	function hStepsD(pos) {
		const had = hdMemo.get(pos.id);
		if (had !== undefined) return had;
		let best = hSteps(pos);
		if (model.canDie) {
			const dk = dieSteps(pos);
			if (dk < INF) {
				if (openResp === null) openResp = hSteps(respawnPos);
				if (openResp < INF) best = Math.min(best, dk + openResp + Math.ceil(DEAD_TICKS / PACE0));
			}
		}
		hdMemo.set(pos.id, best);
		return best;
	}
	/** the admissible ticks from pos to the trophy on the open level (the death shortcut included) */
	function hLb(pos) {
		const had = hMemo.get(pos.id);
		if (had !== undefined) return had;
		let best = lbOfSteps(hSteps(pos));
		if (model.canDie) {
			const dk = dieSteps(pos);
			if (dk < INF) {
				if (openResp === null) openResp = hSteps(respawnPos);
				if (openResp < INF) best = Math.min(best, lbOfSteps(dk) + DEAD_TICKS + lbOfSteps(openResp));
			}
		}
		best += pos.extra || 0;
		hMemo.set(pos.id, best);
		return best;
	}
	// ---------------------------------------------------------------- landmarks (the plan search's guide)
	// the level's landmarks (src/landmarks.js: the relaxed planning graph over its triggers from the start; a fact every
	// relaxed plan needs): the plan search's f counts the ones the state does not hold (ordering only, est; the lb and the
	// proofs never read them)
	let LMS = null;
	function landmarks() {
		if (LMS) return LMS;
		LMS = [];
		try {
			const lm = require('../landmarks.js').landmarksOf(L, { maxMs: o.lmMs || 1500 });
			for (const l of lm.landmarks) {
				const fct = l.f;
				if (fct.startsWith('coins>=')) LMS.push((S) => (S.feats.coins !== undefined ? S.feats.coins >= +fct.slice(7) : true));
				else if (fct.startsWith('bcoins>=')) LMS.push((S) => (S.feats.bcoins !== undefined ? S.feats.bcoins >= +fct.slice(8) : true));
				else if (fct.startsWith('team=')) LMS.push((S) => S.feats.team === undefined || S.feats.team === +fct.slice(5));
				else if (fct === 'crown') LMS.push((S) => S.feats.crown === undefined || S.feats.crown === 1);
				else LMS.push((S) => S.feats[fct] === undefined || S.feats[fct] === 1);
			}
			ST.landmarks = LMS.length;
		} catch (e) { LMS = []; }
		return LMS;
	}
	const lmMemo = new Map();
	function hLM(S) {
		let h = lmMemo.get(S.key);
		if (h !== undefined) return h;
		h = 0;
		for (const t of landmarks()) if (!t(S)) h++;
		if (lmMemo.size > 200000) lmMemo.clear();
		lmMemo.set(S.key, h);
		return h;
	}
	const pace = () => {
		if (!paceSamples.length) return PACE0;
		const s = paceSamples.slice().sort((a, b) => a - b);
		return Math.max(1, s[s.length >> 1]);
	};
	// ---------------------------------------------------------------- the anchor
	function anchorOf(anchor) {
		anchor = anchor || {};
		const arr = anchor.arrival || null;
		// (the anchor's real state: its snapshot when it restores to the arrival's own state hash (the same level object),
		// else a replay of its masks)
		let sim = null;
		if (arr && arr.masks && arr.masks.length) {
			if (arr.snap) { try { const s1 = new E.EESim(L); s1.reset(); s1.restore(arr.snap); if (arr.hash === undefined || s1.stateHash() === arr.hash) sim = s1; } catch (e) { sim = null; } }
			if (!sim) sim = T.playTo(L, arr.masks, { allowDeath: true }).sim;
		} else { sim = new E.EESim(L); sim.reset(); }
		let S = anchor.S || model.stateOf(sim);
		const masks = arr && arr.masks ? arr.masks : new Uint8Array(0);
		let idle = true;
		for (let i = 0; i < masks.length; i++) if (masks[i] & 31) { idle = false; break; }
		const tile = arr && arr.tile !== undefined ? arr.tile : model.startTile;
		let pos = idle ? idlePos : { id: 'a' + tile, tiles: [tile], extra: 0 };
		// (a change the engine still holds in a queue: the state it will be, the gates it shuts passable until then and
		// the deferral region as the lb's sources: the anchor's lb stays sound right after a deferred press)
		const Sp = sim ? model.pendingOf(sim, S) : null;
		if (Sp && Sp.key !== S.key) {
			const rec = deferral(pos.tiles, S, Sp);
			pos = { id: pos.id + 'p' + Sp.dkey.length + ':' + (rec && rec.lbTiles ? rec.lbTiles.length : 0), tiles: pos.tiles, extra: 0, grace: rec ? rec.grace : null, lbTiles: rec ? rec.lbTiles : null };
			S = Sp;
		}
		// (an anchor the strategy keeps apart by the trigger edge it was re-entered by (strategy addArrival): its facts too)
		const cls = (arr ? `${Math.round(arr.vx || 0)},${arr.onGround ? 1 : 0}` : '0,1') + (anchor.qual ? `@${anchor.qual}` : '');
		// (the lb's base: the counts the coin / blue coin / death GATES read: the engine's _show_* copies, which lag the
		// live counts by >= 1 tick and freeze while the ball overlaps a gate; the least of the copy and the count)
		const live = (k) => (S.feats[k] !== undefined ? S.feats[k] : 0);
		const base = { coins: live('coins'), bcoins: live('bcoins'), deaths: live('deaths') };
		if (sim) { base.coins = Math.min(base.coins, sim._show_coin_gate | 0); base.bcoins = Math.min(base.bcoins, sim._show_blue_coin_gate | 0); base.deaths = Math.min(base.deaths, sim._show_death_gate | 0); }
		// (the toggle the anchor's own arrival edge made: UNTOGGLE)
		let viaX = null;
		if (UNTOGGLE && anchor.via) { const m = /^trig:(\d+)$/.exec(String(anchor.via)); const X = m ? model.triggers[+m[1]] : null; if (X && TOGGLE_FEAT.test(String(X.feat))) viaX = X; }
		return { S, pos, tick: arr ? arr.tick || 0 : 0, idle, cls, base, sim, arr, viaX };
	}
	// ---------------------------------------------------------------- edges
	const hasCG = model.hasCoinGate.coins || model.hasCoinGate.bcoins;
	const useBounds = !!bounds && !model.canDie && !hasCG;
	// (the primitives' bound per edge is a Dijkstra field per (target, door state): ~0.35 s each on a 400 x 200 level, and
	// a node's edges are every relevant trigger (26_2 Terror In The North: 172 coins, 60 s for the root's edges alone, past
	// the compile's watchdog). A new field only while the calling search is inside its own budget (pairUntil), a memoized
	// one always; else the tier-0 bound alone: both admissible, their max only tighter)
	let pairUntil = Infinity;
	const pairOK = (tiles, lvl) => Date.now() < pairUntil || (typeof bounds.hasField === 'function' && bounds.hasField(tiles, lvl));
	/** the physics check's memo: (door key, position, edge) -> true when RCH3 is -1 from every tile of the position at
	 *  rest and rising at the most (a heavy est penalty in the plan search, never a drop: an abstract position is no real
	 *  state); 'proof' from the anchor's real state (then the edge is dropped at the root: an exact proof) */
	const rchBad = new Map();
	// THE PHYSICS PRICE (n5 doctor 4): the est walk is 8-way and GRAVITY-BLIND, so it prices a climb the ball cannot make
	// as a few steps straight up; verifyPath already builds the RCH3 field of every edge of a found plan (the physics:
	// jumps, falls, fields; a sound relaxation) and kept only its -1 (a proof). Its COST is the physics' own walk: where it
	// exceeds the est walk's steps by PHYS_R x + PHYS_ADD tiles, the edge's est is raised to that cost x the pace (a PRICE,
	// never a drop, the lb untouched: ranking only; a learned ok leg keeps its ticks) and the plan search runs again (as
	// for a new rchBad). Measured on the batch-4 levels (FINAL's failing ones): I Crew Persian Peril's first plan is the
	// trophy at est 1,248 ticks (walk 312 steps from the spawn) while RCH3 reads 1,935 tiles there (every upper trigger
	// 1,850-2,144: the walk climbs straight up, the physics goes round through the lower coins, RCH3 470-625 at walk
	// 377-506); the compile spent 60 s on the trophy / coin (199,83) legs at closest 1,802-1,986 tiles. Where the walk and
	// the physics agree (Octorage: RCH3 / walk 1.0-1.2 on all 18 legs of its known route) nothing changes.
	// EEAT_PHYS_PRICE=1 (OPT-IN: o.physPrice overrides), EEAT_PHYS_R (2), EEAT_PHYS_ADD (24 tiles).
	const PHYS_PRICE = o.physPrice !== undefined ? !!o.physPrice : process.env.EEAT_PHYS_PRICE === '1';
	// (EEAT_PHYS_PRICE=sa, OPT-IN, C6 push 3 lane 4: the price only for an edge whose RCH3 cost holds reach.js's side-arrow
	// price (SA_COST, 2,500 tiles: the physics' only way crosses a run of side arrows against their push, which the
	// relaxation's speedless states cannot do), the rest as without the knob. Don't Stop Jumping: the 64-tick trophy plan
	// (RCH3 2,515 tiles: the priced passage) took ~290 of 300 s; priced, the switch plans go first)
	const PHYS_SA = o.physPrice === undefined && process.env.EEAT_PHYS_PRICE === 'sa', SA_TILES = 2500;
	const PHYS_R = +process.env.EEAT_PHYS_R || 2, PHYS_ADD = process.env.EEAT_PHYS_ADD !== undefined ? +process.env.EEAT_PHYS_ADD : 24;
	const rchPrice = new Map();   // (rchKey -> the RCH3 cost in tiles, where it prices the edge)
	// THE STEPPING STONES (n5 doctor 4): a ONE-LEG level's plan is one leg of thousands of ticks (13_3 Stone Ruin
	// Speedrun: the trophy from the spawn, 3,194 route ticks through arrows and dots; the compile spends its 60 s on it and
	// the far checkpoint, closest 309-493 tiles, 0 triggers), while the finders find legs of <= 300 route ticks from the
	// right state ~90% of the time and 1,000+ tick legs 4 / 28 (the known-route tests). The level's designer marks the way
	// with coins: Stone Ruin's known route takes 10 of its 11 coins in order (legs of 14-629 ticks), every one of them 0-63
	// walk steps off the est walk's way; with no coin gate they are irrelevant to the model, so no plan could use them. Here
	// an irrelevant coin / blue coin is a STONE: a plan step of its own (a trigger waypoint on its tiles, no Expect, the
	// state unchanged; the strategy keeps its arrival as an anchor of its own: ANCHOR_QUAL keys it by the edge), and every
	// edge's est gets est^2 / STONE_LONG on top (plan ranking only: the finders' cost grows much faster than the ticks),
	// so a long leg is split where stones lie on its way and nowhere else (a detour costs its ticks). The lb, costOf and
	// lowerBound never see stones. EEAT_PLAN_STONES=1 (OPT-IN: o.stones overrides), EEAT_PLAN_STONE_LONG (1000 ticks),
	// EEAT_PLAN_STONE_MAX (120: more irrelevant coins than this, no stones).
	const STONES = o.stones !== undefined ? !!o.stones : process.env.EEAT_PLAN_STONES === '1';
	const STONE_LONG = +process.env.EEAT_PLAN_STONE_LONG || 1000, STONE_MAX = +process.env.EEAT_PLAN_STONE_MAX || 120;
	// (THE STONES' WAY, on with the stones (EEAT_PLAN_STONE_WAY=0 / o.stoneWay false: every stone an edge): a stone is a plan edge only where it lies on the way to the
	// trophy (the est walk to it + the open level's walk from it to the trophy within max(STONE_SLACK, STONE_SLACK_F x the
	// node's own) of the node's walk to the trophy) and only the STONE_NEAR nearest of those: every stone of a level of many
	// was an edge of every node, and each new position is one more walk to build, so the plan search ran out of its budget
	// on one stone (Treasure Trove Cove's first plan 'blue coin (49,173)', PARTIAL, 2.3 s; Perilous Endeavor's 'coin
	// (158,37)', 3.1 s; Endeavor's switch plan cut after 3 steps))
	const STONE_WAY = o.stoneWay !== undefined ? !!o.stoneWay : process.env.EEAT_PLAN_STONE_WAY !== '0';
	const STONE_NEAR = process.env.EEAT_PLAN_STONE_NEAR !== undefined ? +process.env.EEAT_PLAN_STONE_NEAR : 4;
	const STONE_SLACK = process.env.EEAT_PLAN_STONE_SLACK !== undefined ? +process.env.EEAT_PLAN_STONE_SLACK : 8;
	const STONE_SLACK_F = process.env.EEAT_PLAN_STONE_SLACK_F !== undefined ? +process.env.EEAT_PLAN_STONE_SLACK_F : 0.15;
	// (the rungs a failed stone gets before it is blocked: 2 = rungs 0 and 1 (1.5 + 5 s); 3 also rung 2 (15 s), where the
	// known routes' 400-800-tick legs are found (krt: Stone Ruin's stone legs 415-629 route ticks); EEAT_PLAN_STONE_RUNGS)
	const STONE_RUNGS = Math.max(1, +process.env.EEAT_PLAN_STONE_RUNGS || 2);
	let stones = STONES ? model.triggers.filter((X) => !X.relevant && (X.kind === 'coin' || X.kind === 'bcoin') && X.tiles && X.tiles.length) : [];
	if (stones.length > STONE_MAX) stones = [];
	const stoneIds = new Set(stones.map((X) => X.id));
	let stoneLive = null;   // (per plan() call: stone id -> its tiles the anchor has not taken; null: every tile)
	// THE WALLED PRICE (n5 doctor 4): the CEGAR walls (a failure's cut just past its closest tile and the 3 x 3 around
	// the closest tile of every failure at rung >= 1) are never taken back, and in a corridor level they SEVER the est
	// walk: then every edge past them is 'relaxation only' and costs the 1e6 PENALTY, and the plan ranking is gone (every
	// plan ~1e6). Night 4's FINAL: 105 of the 206 failing compiles end on a plan of est >= 1e6 at 60 s, 126 at 180 s (16
	// of batch 4's 21). Reproduced (src/out/n5/doctor/batch4.md): Stone Ruin's trophy / checkpoint (357,40) failures of
	// the box-5 trace fed to learn(): after the checkpoint's rung-2 cut at (151,42) both far edges turn relaxOnly (est
	// 1,004,932 / 1,005,448) though that is the corridor the known route takes. With the knob an edge the walled est walk
	// misses but the UNWALLED est walk reaches costs WALL_F (3) x that walk instead of the penalty: a finite, ranked price
	// (the walls still price their way 3x; a proof or an lb-only way keeps the penalty). EEAT_WALL_PRICE=1 (OPT-IN: o.wallPrice
	// overrides), EEAT_WALL_F.
	const WALL_PRICE = o.wallPrice !== undefined ? !!o.wallPrice : process.env.EEAT_WALL_PRICE === '1';
	// THE SCOPED WALL (C6 lane 1 block 5; OPT-IN EEAT_PLAN_WALL_SCOPE=<lift,class,edge>, o.wallScope overrides; unset =
	// the walls byte for byte as before): the CEGAR walls (syncWalls) wall every failed step's closest approach for EVERY
	// state and every edge and are never taken back, and on the stuck levels the est walk reaches no trophy within
	// seconds (C6 lane 1 block 4: The Memory Game's walls-lifted plan at 13 s; every long search from its start class out of
	// nodes in 3-7 ms with only PENALTY plans; B7 b9: the open switch's child generated at the penalty, never expanded).
	// 'lift': a fact's walls go once its edge succeeds from any node class (the wall was no obstacle to that leg);
	// 'class': a fact's walls act only in the est walks of the abstract state its anchor was in; 'edge': an edge with no
	// wall of its own is priced by the unwalled est walk (a failure walls its own leg, not every other target's).
	const WALL_SCOPE = String(o.wallScope !== undefined ? o.wallScope : process.env.EEAT_PLAN_WALL_SCOPE || '');
	const SC_LIFT = /\blift\b/.test(WALL_SCOPE), SC_CLASS = /\bclass\b/.test(WALL_SCOPE), SC_EDGE = /\bedge\b/.test(WALL_SCOPE);
	const SC_ANY = SC_LIFT || SC_CLASS || SC_EDGE;
	const WALL_F = +process.env.EEAT_WALL_F || 3;
	// (a PROOF is keyed by the abstract state AND the position it was proven from: the executor's proof is "the goal field
	// of the level as the doors stand is -1 at every START", a fact about where the ball is (a one-way drop, a portal, a
	// pocket), so it blocks the edge from that (state, position) only, not from every node of the state: the re-entry
	// anchors (a class re-entered by another trigger) and the child nodes at other positions keep the edge.
	// EEAT_PROOF_POS=0: keyed by the state alone, as before)
	const PROOF_POS = process.env.EEAT_PROOF_POS !== '0';
	const proofKey = (S, pos) => (PROOF_POS && pos && pos.id !== undefined ? S.key + '@' + pos.id : S.key);
	const rchKey = (S, pos, edge) => S.pkey + '|' + pos.id + '|' + edge;
	// THE PHYSICS ESTIMATE of a root edge (OPT-IN EEAT_PHYS_EST=1; n5 doctor 'cold'): the est walk has no gravity, so a
	// target over a rise the ball cannot make reads as near as any walk (Cold World: the trophy est 124 ticks from the
	// spawn by the chapter-1 pool, whose rise needs the 33333 portal at speed; its trophy-room crown / blue coin, the
	// pool's coin / crown / protection: 150 of 180 s of rungs spent there, while the chapter-2 blue coin that opens the
	// level ran at rungs 0-1 only). Per anchor ONE forward pass of RCH3's own forward model (reach.js fwd / same-tile /
	// portal edges, field._m.edgesOf, the level as S holds it, with the ice's reach (iceLocal, sound) and the fields'
	// engine-measured transit tables (exitApex: ordering only)) from the anchor's REAL state: per tile the fewest tile
	// moves (0-1 BFS over the abstract states, a level dominated at a (tile, type) pruned); a root edge's est = max(est,
	// those moves x the pace), a target the pass never reaches PHYS_CUT_TILES x the pace: a price only, never a drop (the
	// transit tables are no proof). Off = the planner byte for byte as before.
	const PHYS_EST = process.env.EEAT_PHYS_EST === '1';
	// THE PROGRESS RULE FOR THE CEGAR WALLS (OPT-IN EEAT_CUT_PROG=1; n5 doctor 'cold'): learn() walls a failed step's closest
	// approach (its 3 x 3 in the est walk, and a cut of the est path just past it) at its second rung, as a counterexample
	// to the relaxation's way. A BUDGET failure of a long leg is often no counterexample: the leg ran out of time early on
	// its true way, and the wall then cuts that way. Cold World: the chapter-2 blue coin's rung-1 leg (5 s) ended at the
	// chapter-2 portal exit (158,229), 13 est steps of the 78 from the spawn; the wall there cut chapter 2 off the est walk
	// and the planner turned to the pool / trophy-room targets for the rest of the compile. With the rule a budget failure
	// walls nothing unless its closest approach is at least CUT_PROG_F of the est walk's way from the anchor to the
	// waypoint (the leg went most of the way and stalled: the false-near shape the walls are for); 'exhausted' as before.
	// Off = the planner byte for byte as before.
	const CUT_PROG = process.env.EEAT_CUT_PROG === '1';
	const CUT_PROG_F = +process.env.EEAT_CUT_PROG_F > 0 ? +process.env.EEAT_CUT_PROG_F : 0.5;
	const PHYS_CUT_TILES = 2000, PHYS_MAX_STATES = 4e6, PHYS_MEMO = 16;
	const physMemo = new Map();
	let RFm = null;
	function physFwdOf(a) {
		if (!a || !a.sim) return null;
		const key = a.S.pkey + '|' + a.sim.stateHash();
		let d = physMemo.get(key);
		if (d !== undefined) return d;
		d = null;
		const t0 = Date.now();
		try {
			if (!RFm) RFm = require('../reach.js');
			const goal = trophyTiles.length ? trophyTiles : [model.startTile];
			const f = RFm.reachField(model.levelOf(a.S), { goals: Array.from(goal, (t) => ({ tile: t, cost: 0 })), deaths: false, debug: true, iceLocal: true, exitApex: true });
			if (f && f.mode === 'physics' && f._m && typeof f._m.edgesOf === 'function') {
				const s = a.sim, st = RFm.stateOf(f, s.px, s.py, s.speed_y, s._q0, s._q1, s._slippery);
				const starts = st ? [...(st.base ? [st.base] : []), ...(st.rise || [])] : [];
				const NT = 5, N = model.N;
				const seen = new Int16Array(N * NT).fill(-32768);
				d = new Int32Array(N).fill(INF);
				let cur = [], nxt = [], depth = 0, n = 0;
				const add = (t, ty, l, list) => { const k = t * NT + ty; if (seen[k] >= l) return false; seen[k] = l; list.push(t, ty, l); return true; };
				for (const [ty, l] of starts) add(st.t, ty, l, cur);
				while (cur.length && n < PHYS_MAX_STATES) {
					for (let i = 0; i < cur.length && n < PHYS_MAX_STATES; i += 3) {
						const t = cur[i], ty = cur[i + 1], l = cur[i + 2];
						n++;
						if (d[t] > depth) d[t] = depth;
						f._m.edgesOf(t, ty, l, (t2, ty2, l2) => { add(t2, ty2, l2, t2 === t ? cur : nxt); });
					}
					cur = nxt; nxt = []; depth++;
				}
				ST.physStates = (ST.physStates || 0) + n;
			}
		} catch (e) { d = null; }
		ST.physMs = (ST.physMs || 0) + (Date.now() - t0);
		physMemo.set(key, d);
		if (physMemo.size > PHYS_MEMO) physMemo.delete(physMemo.keys().next().value);
		return d;
	}
	/**
	 * the edges of node (S, pos): [{X (null: the trophy), S2, pos2, expect, lb, est, steps, viaDeath, edge, live}]. The
	 * lb reachability (the walk relaxation: killers passable, keys sticky, the death shortcut) keeps an edge; mode 'plan'
	 * prices it by the est walk (killers walls unless protected; a death step where only a death reaches it; a heavy
	 * penalty where only the relaxation reaches it) and applies the facts (blocks, proofs, needs, learned ticks)
	 */
	function edgesOf(S, pos, base, mode, root, rootCls, anc, only) {
		const out = [];
		const P = pace();
		const extra = pos.extra || 0;
		const physD = PHYS_EST && root && mode === 'plan' && anc ? physFwdOf(anc) : null;   // (the physics estimate: PHYS_EST)
		const dL = model.dist(S, pos, 'lb', base), dvL = model.deathVia(S, pos, 'lb', base);
		const wantEst = mode === 'plan';
		const dE = wantEst ? model.dist(S, pos, 'est', base) : null, dvE = wantEst ? model.deathVia(S, pos, 'est', base) : null;
		const dE0 = dE, dvE0 = dvE;
		const cls = root ? rootCls : S.key + '|*';
		let dNW = null;
		const nwDist = () => dNW || (dNW = model.dist(S, pos, 'estNW', base));
		let dvNW;
		const leg = (tiles, forceDeath, edgeId) => {
			let sL = INF, rL = INF, sE = INF, rE = INF;
			// (THE SCOPED WALL 'edge': an edge that owns no wall walks the unwalled est)
			let dE = dE0, dvE = dvE0;
			if (SC_EDGE && dE && ST.estWalls > 0 && edgeId !== undefined && !walledEdges.has(String(edgeId).replace(/~w$/, ''))) {
				dE = nwDist(); if (dvNW === undefined) dvNW = model.deathVia(S, pos, 'estNW', base); dvE = dvNW; ST.edgeUnwalled = (ST.edgeUnwalled || 0) + 1;
			}
			const drL = dvL ? dvL.dr : null, drE = dvE ? dvE.dr : null;
			for (const t of tiles) {
				if (dL[t] < sL) sL = dL[t];
				if (drL && drL[t] < rL) rL = drL[t];
				if (dE) { if (dE[t] < sE) sE = dE[t]; if (drE && drE[t] < rE) rE = drE[t]; }
			}
			let lb = lbOfSteps(sL);
			if (drL && rL < INF) lb = Math.min(lb, lbOfSteps(dvL.dk) + DEAD_TICKS + lbOfSteps(rL));
			if (!Number.isFinite(lb)) return null;
			lb += extra;
			if (useBounds) { try { const lvl = model.levelOf(S); if (pairOK(tiles, lvl)) { const bb = bounds.pair(pos.tiles, tiles, lvl); if (Number.isFinite(bb)) lb = Math.max(lb, bb + extra); } } catch (e) { /* the tier-0 bound */ } }
			let est = lb, steps = sL, viaDeath = false, relaxOnly = false;
			if (wantEst) {
				if (sE < INF) {
					est = sE * P + extra; steps = sE;
					// (THE DEATH WARP, EEAT_TRICKS warp: the death's est clearly below the walk's)
					// (not on a level with a TIMED killer: there every tile is a death tile (model.dieTile, the lb's sound source)
					// and the est's 0 walk steps to a death are a curse's / poison's timer in truth: Evolution Revolution's
					// first A/B pair planned 10 warps, gain 1 vs 6)
					if ((TR_WARP && !model.timed || forceDeath) && drE && rE < INF) {
						const eD = (dvE.dk + rE) * P + (dvE.dt || 0) + DEAD_TICKS + extra;
						if (forceDeath || (eD + WARP_MIN <= est && eD <= WARP_F * est)) { est = eD; steps = dvE.dk + rE; viaDeath = true; }
					}
				}
				else if (drE && rE < INF) { est = (dvE.dk + rE) * P + (dvE.dt || 0) + DEAD_TICKS + extra; steps = dvE.dk + rE; viaDeath = true; }
				else {
					// (the walled price: the est walk reaches it once the CEGAR walls are left out: WALL_F x that walk)
					let sW = INF;
					if (WALL_PRICE && ST.estWalls > 0) { const dw = nwDist(); for (const t of tiles) if (dw[t] < sW) sW = dw[t]; }
					if (sW < INF) { est = sW * P * WALL_F + extra; steps = sW; ST.walledPriced = (ST.walledPriced || 0) + 1; }
					else {
						// (only the relaxation reaches it: its walk, else its death shortcut; sL is INF when only the lb's
						// death way reaches it, and INF x pace overflowed the plan's est to ~4.3e9: The Square)
						const sR = sL < INF ? sL : drL && rL < INF ? dvL.dk + rL : INF;
						est = (sR < INF ? sR * P * 3 + (sL < INF ? 0 : DEAD_TICKS) : 0) + PENALTY + extra; relaxOnly = true;
					}
				}
				est = Math.max(lb, est);
				// (THE LONG LEG'S CONVEX PRICE, OPT-IN: a leg's est past LEG_T ticks costs LEG_K more a tick, so a chain of
				// shorter legs through the triggers on the way (checkpoints, coins) beats one long leg of the same walk)
				if (LEG_T > 0 && !relaxOnly && est > LEG_T) est += LEG_K * (est - LEG_T);
				// (the stones' price of a long leg: the finders' cost grows much faster than its ticks)
				if (STONES && stones.length && !relaxOnly && est > 0) est += est * est / STONE_LONG;
			}
			// (pen: which penalty priced the edge, a diagnostic for the plan's steps: 'relax' (only the relaxation reaches
			// it), 'rch' (RCH3 -1 at rest / rising), 'floor' / 'zone' (a count floor not reached))
			return { lb, est, steps, viaDeath, relaxOnly, pen: relaxOnly ? 'relax' : '' };
		};
		const finish = (X, tiles, edge, tr, anyOf) => {
			// (EXHAUSTED -> DEATH, EEAT_TRICKS exh: the leg exhausted from this class; its death variant only, where one
			// exists: a level that can kill and a respawn the death way reaches the target from)
			let g = null;
			if (TR_EXH && wantEst && exhausted.has(edge + '\u0001' + cls)) {
				const gd = leg(tiles, true, edge);
				if (TR_DBG) { let rE = INF, sE = INF; const drE = dvE ? dvE.dr : null; for (const t of tiles) { if (drE && drE[t] < rE) rE = drE[t]; if (dE && dE[t] < sE) sE = dE[t]; } process.stderr.write(`[tricks exh] ${edge} viaDeath ${gd ? gd.viaDeath : null} relax ${gd ? gd.relaxOnly : null} dk ${dvE ? dvE.dk : null} sE ${sE} rE ${rE} cp ${S.cp} rsp ${model.respawnOf(S, 'est').id} cls ${String(cls).slice(-28)}\n`); }
				if (gd && gd.viaDeath) { g = gd; edge += '~w'; }
			}
			if (!g) g = leg(tiles, false, edge);
			if (!g) return;
			if (wantEst) {
				if (facts) {
					if (facts.blocked(edge, cls, proofKey(S, pos))) return;
					if (facts.needsOf(edge, cls).some((n) => S.feats[n.feat] !== n.value)) return;
					const ok = facts.okTicks(edge, cls);
					if (ok !== undefined) { g.est = Math.max(g.lb, ok); g.pen = ''; }
					else {
						if (PHYS_PRICE || PHYS_SA) { const pr = rchPrice.get(rchKey(S, pos, edge)); if (pr !== undefined) g.est = Math.max(g.est, pr * P + extra); }
						if (FAIL_EST > 0 && typeof facts.failsAny === 'function') {
							const fa = facts.failsAny(edge);
							if (fa > 0 && !facts.okAnyOf(edge)) { g.est += FAIL_EST * fa; ST.failEst = (ST.failEst || 0) + 1; }
						}
					}
				} else if (PHYS_PRICE || PHYS_SA) { const pr = rchPrice.get(rchKey(S, pos, edge)); if (pr !== undefined) g.est = Math.max(g.est, pr * P + extra); }
				if (X === null) { for (const n of floorNeeds) if (!((S.feats[n.feat] || 0) >= n.min)) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'floor'; break; } }
				else if (floorNeeds.length && zoneNeed(S, tiles)) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'zone'; }
				const bad = rchBad.get(rchKey(S, pos, edge));
				if (bad === 'proof' && root) return;
				if (bad) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'rch'; }
				if (physD) { let dm = INF; for (const t of tiles) if (physD[t] < dm) dm = physD[t]; g.est = Math.max(g.est, (dm < INF ? dm : PHYS_CUT_TILES) * P + extra); }
			}
			const e = { X, S2: tr ? tr.S2 : S, pos2: X ? posOf(X, S, tr ? tr.S2 : S) : null, expect: tr ? tr.expect : null, lb: g.lb, est: g.est, steps: g.steps, viaDeath: g.viaDeath, relaxOnly: g.relaxOnly, pen: g.pen || '', edge, live: tiles };
			if (anyOf > 1) e.anyOf = anyOf;
			out.push(e);
		};
		const groups = ANY ? new Map() : null;
		for (const X of (only || relevant)) {
			if (pos.trig === X.id && !(X.kind === 'psw' || X.kind === 'osw' || X.kind === 'chain')) continue;
			const live = model.liveTiles(S, X);
			if (!live.length) continue;
			// (reachable first: the touch builds a state)
			let sL = INF;
			for (const t of live) if (dL[t] < sL) sL = dL[t];
			if (sL >= INF && !dvL) continue;
			const tr = model.touch(S, X);
			if (!tr.changed) continue;
			if (groups && ANY_KINDS.has(X.kind) && tr.S2 && tr.S2.key !== undefined) {
				const gk = X.kind + '|' + tr.S2.key;
				const g = groups.get(gk);
				if (g) g.push({ X, live, tr }); else groups.set(gk, [{ X, live, tr }]);
				continue;
			}
			finish(X, live, 'trig:' + X.id, tr);
		}
		if (groups) {
			for (const g of groups.values()) {
				if (g.length === 1) { finish(g[0].X, g[0].live, 'trig:' + g[0].X.id, g[0].tr); continue; }
				// (the representative: the member nearest by the est walk (else the lb walk); the edge id: the least id)
				const dd = dE || dL;
				let rep = g[0], repD = INF, minId = g[0].X.id;
				const seen = new Set(), all = [];
				for (const m of g) {
					if (m.X.id < minId) minId = m.X.id;
					let d = INF;
					for (const t of m.live) { if (dd[t] < d) d = dd[t]; if (!seen.has(t)) { seen.add(t); all.push(t); } }
					if (d < repD) { repD = d; rep = m; }
				}
				finish(rep.X, all, 'trig:' + minId, rep.tr, g.length);
			}
		}
		if (only) return out;
		// (THE TROPHY'S COMPONENTS, TCOMP: the components a near miss ruled out from this abstract state are not targets)
		const tdrop = TCOMP && facts && model.trophies.length > 1 && typeof facts.tdropOf === 'function' ? facts.tdropOf(S.key) : null;
		if (tdrop && tdrop.length) {
			const keep = [];
			model.trophies.forEach((X, i) => { if (!tdrop.includes(i)) for (const t of X.tiles) keep.push(t); });
			if (keep.length) finish(null, keep, 'trophy~t' + tdrop.slice().sort((x, y) => x - y).join('.'), null);
			else finish(null, trophyTiles, 'trophy', null);
		} else finish(null, trophyTiles, 'trophy', null);
		// (the stepping stones: an irrelevant coin / blue coin as a step of its own, the state unchanged; plan mode only)
		if (wantEst && STONES && stones.length) {
			// (STONE_WAY: the node's walk to the trophy on the open level, the stones' detour against it)
			let hPos = INF;
			if (STONE_WAY && REVH) { hPos = hSteps(pos); if (!revTro) revTro = model.revDist(openOf(), trophyTiles); }
			const cand = [];
			for (const X of stones) {
				if (pos.trig === X.id) continue;
				// (a stone the anchor's own run took already is none: the model state does not track irrelevant coins)
				const live = stoneLive ? stoneLive.get(X.id) : X.tiles;
				if (!live || !live.length) continue;
				let sE = INF, det = INF;
				if (dE) for (const t of live) { if (dE[t] < sE) sE = dE[t]; if (hPos < INF && dE[t] + revTro[t] < det) det = dE[t] + revTro[t]; }
				if (sE >= INF) continue;
				if (STONE_WAY && REVH) {
					if (!(hPos < INF) || !(det <= hPos + Math.max(STONE_SLACK, STONE_SLACK_F * hPos))) { ST.stoneOff = (ST.stoneOff || 0) + 1; continue; }
				}
				cand.push({ X, live, sE });
			}
			// (the STONE_NEAR nearest, then the ones at 2, 4, 8, ... x STONE_NEAR by distance and the farthest on the way: the
			// plan search can still split a long leg once near its end, as with every stone an edge, at O(log n) edges a node)
			let pick = cand;
			if (STONE_WAY && STONE_NEAR > 0 && cand.length > STONE_NEAR) {
				cand.sort((x, y) => x.sE - y.sE || x.X.id - y.X.id);
				pick = cand.filter((c, i) => { if (i < STONE_NEAR || i === cand.length - 1) return true; const q = (i + 1) / STONE_NEAR; return Number.isInteger(q) && (q & (q - 1)) === 0; });
			}
			for (const c of pick) finish(c.X, c.live, 'trig:' + c.X.id, { S2: S, expect: null });
		}
		// DEATHS AS MOVES (lane 2's die edge, lane 5): where a death door (1011) or gate (1012) reads the death count, a death
		// is an edge of its own (plan mode: the est walk to the nearest killer, the dead ticks, back at the respawn with one
		// death more), so the door that needs N deaths opens in the plan: Tutorial 2's est walk passed its death door only in
		// the relaxation, every plan carried the 1e6 penalty and no death step. The lb needs none (it keeps 1011 open).
		// EEAT_PLAN_DIE=0: none
		if (wantEst && DIE_EDGE && dieIdx !== undefined && dvE && S.vals[dieIdx] < model.deathT && dieNear(S.vals[dieIdx]) && (DIE_ALWAYS || out.some((e) => e.relaxOnly))) {
			const vals = S.vals.slice();
			vals[dieIdx] = S.vals[dieIdx] + 1;
			const S2 = model.mkState(vals, S.taken, S.btaken, S.cp);
			const rp = model.respawnOf(S2, 'est');
			const edge = 'die:' + vals[dieIdx];
			if (rp && !(facts && facts.blocked(edge, cls, proofKey(S, pos)))) {
				const ok = facts ? facts.okTicks(edge, cls) : undefined;
				const lbD = (dvL ? lbOfSteps(dvL.dk) : 0) + DEAD_TICKS + extra;
				const est = Math.max(lbD, ok !== undefined ? ok : dvE.dk * P + (dvE.dt || 0) + DEAD_TICKS + extra);
				const X = { id: -1 - vals[dieIdx], kind: 'die', tiles: rp.tiles, label: `die, back at a respawn (deaths ${vals[dieIdx]})` };
				out.push({ X, S2, pos2: diePos(rp), expect: { feat: 'deaths', value: vals[dieIdx] }, lb: lbD, est, steps: dvE.dk, viaDeath: false, relaxOnly: false, edge, live: rp.tiles });
			}
		}
		return out;
	}
	const DIE_EDGE = process.env.EEAT_PLAN_DIE !== '0';
	// (a death toward a door's count holds back at ANY respawn (a checkpoint touched on the way is where the engine puts
	// the ball): the count opens the door wherever the ball comes back, and the strategy re-anchors on the real state.
	// The Ten Commandments: its start room's only way out is a portal onto the checkpoint (2,21), so a death "back at the
	// spawn" never held (every leg 'budget', closest 0 at a killer, rungs 2-3 spent). A viaDeath step (a death as a
	// teleport to its respawn) keeps its respawn. EEAT_PLAN_DIE_ANY=0: the state's own respawn)
	const DIE_ANY = process.env.EEAT_PLAN_DIE_ANY !== '0';
	// (a viaDeath step (a death as a teleport) holds back at ANY respawn too: the way to a killer may pass a checkpoint the
	// model state's respawn does not know (the est walk is checkpoint-blind), and the engine puts the ball back THERE: The
	// Square's one spike (21, 73) is reached only past checkpoints, so "back at the state's own respawn (2, 168)" never held
	// (every rung 'budget', closest 0: the dead ball), and from the level's start the executor finds the death back at
	// any respawn in 294 ticks (0.8 s). The arrival is a real state: the strategy re-anchors and plans from it.
	// EEAT_PLAN_VIADEATH_ANY=0: the state's own respawn, as before)
	const VIA_ANY = DIE_ANY && process.env.EEAT_PLAN_VIADEATH_ANY !== '0';
	// (a death is offered only where an edge of the node is reachable in the relaxation alone (a shut death door is what
	// the relaxation opens): The Ten Commandments' trophy is reachable without a death (666 run ticks), and offered at every
	// node the death became its plan after one failed trophy rung (2,212 run ticks, 2 of 2; before the gain fix: its
	// compile lost, 3 of 3); Tutorial 2's trophy is behind its death door (relaxation only): offered. EEAT_PLAN_DIE_WHEN=always)
	const DIE_ALWAYS = process.env.EEAT_PLAN_DIE_WHEN === 'always';
	// (a death is a move only toward a death door / gate threshold at most DIE_GAP deaths on: First Person Maze's 999-death
	// door made "die" its first plan step (est 138), a way no route takes; each death costs 54 dead ticks at least)
	const DIE_GAP = +process.env.EEAT_PLAN_DIE_GAP || 3;
	const deathThs = (() => {
		const set = new Set(), fg = model.L && model.L.fg, lk = model.L && model.L.lookup0;
		// (the DOORS' thresholds (1011: open from N deaths on); a death gate (1012) SHUTS at its count, which the est walk
		// (a shut gate a wall, never a floor) can only lose by: a die edge there is branching for nothing (Polar Eclipse's
		// 16 gates at 1..16); EEAT_PLAN_DIE_GATES=1: gates too)
		const gatesToo = process.env.EEAT_PLAN_DIE_GATES === '1';
		if (fg && lk) for (let i = 0; i < fg.length; i++) if ((fg[i] === 1011 || (gatesToo && fg[i] === 1012)) && lk[i] > 0) set.add(lk[i]);
		return [...set].sort((x, y) => x - y);
	})();
	const dieNear = (cur) => deathThs.some((t) => t > cur && t <= cur + DIE_GAP);
	const dieIdx = model.featSet && model.featSet.has('deaths') && model.canDie && model.deathT > 0 ? model.fIdx.get('deaths') : undefined;
	const diePosOf = new Map();
	/** the position after a death: the respawn's tiles, no extra ticks (the die edge priced them) */
	const diePos = (rp) => { let p = diePosOf.get(rp.id); if (!p) { p = { id: 'die@' + rp.id, tiles: rp.tiles, extra: 0 }; diePosOf.set(rp.id, p); } return p; };
	/** the lb of a leg (costOf): the tier-0 bound under the lb relaxation, the primitives' where sound too, the larger */
	function legLb(S, pos, tiles, base) {
		let lb = model.pairLb(S, pos, tiles, 'lb', base);
		if (useBounds && Number.isFinite(lb)) { try { const bb = bounds.pair(pos.tiles, tiles, model.levelOf(S)); if (Number.isFinite(bb)) lb = Math.max(lb, bb + (pos.extra || 0)); } catch (e) { /* tier-0 */ } }
		return lb;
	}
	/** the RCH3 check of the edges on a plan's path; returns the number of edges newly found bad */
	function verifyPath(a, node, deadline) {
		let newBad = 0;
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push(n);
		path.reverse();
		for (const n of path) {
			if (Date.now() > deadline) break;
			const from = n.parent, e = n.e;
			if (e.X && e.X.kind === 'die') continue;   // (a death's goal is the respawn: no walk leg to check)
			const k = rchKey(from.S, from.pos, e.edge);
			if (rchBad.has(k)) continue;
			ST.rchChecks++;
			let r;
			const isRoot = !from.parent;
			if (isRoot && a.sim) r = model.reachable(from.S, a.sim, e.live);
			else r = model.reachable(from.S, from.pos.tiles, e.live, { rising: true });
			const bad = r.proof ? (isRoot && a.sim ? 'proof' : true) : false;
			rchBad.set(k, bad);
			if (bad) newBad++;
			// (the physics price: RCH3's cost well above the est walk's steps of this edge)
			else if ((PHYS_PRICE || (PHYS_SA && r.cost >= SA_TILES)) && r.cost > 0 && Number.isFinite(e.steps) && e.steps < INF && !e.relaxOnly && r.cost > PHYS_R * e.steps + PHYS_ADD) {
				rchPrice.set(k, r.cost); ST.physPriced = (ST.physPriced || 0) + 1; newBad++;
			}
		}
		return newBad;
	}
	// ---------------------------------------------------------------- the lower bound
	/**
	 * lowerBound(anchor, o) -> {ticks, complete, expanded, ms}: the admissible ticks from the anchor's state to the trophy
	 * (the run timer's: an anchor before any input gets its idle trajectory free and 2 ticks off for the first input's
	 * tick). o.ms (1500), o.maxExpand (200000).
	 */
	function lowerBound(anchor, lo = {}) {
		const t0 = Date.now();
		ST.lbCalls++;
		const a = anchorOf(anchor);
		const ms = lo.ms !== undefined ? lo.ms : 1500, maxExpand = lo.maxExpand || 200000;
		pairUntil = t0 + ms;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, goal = Infinity, complete = false;
		// (nodes merged over the coins' identities: one node per (feature values, checkpoint, position) with the least g
		// and the INTERSECTION of the coin tiles taken: an over-approximation of every state merged into it (more coins
		// left, the counts the same), so the bound stays admissible and the coin orders collapse)
		const mkey = (S, pos) => S.dkey + '|c' + S.cp + '#' + pos.id;
		const andBits = (x, y) => { if (!x) return x; const o2 = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) o2[i] = x[i] & y[i]; return o2; };
		const sameBits = (x, y) => { if (!x) return true; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
		best.set(mkey(a.S, a.pos), { g: 0, S: a.S });
		open.push({ S: a.S, pos: a.pos, g: 0, f: hLb(a.pos), seq: seq++, goal: false });
		while (open.size) {
			const n = open.pop();
			if (n.goal) { goal = n.g; complete = true; break; }
			const rec = best.get(mkey(n.S, n.pos));
			if (rec && (rec.g < n.g || rec.S !== n.S)) continue;
			if (expanded >= maxExpand || Date.now() - t0 > ms) { open.push(n); break; }
			expanded++;
			for (const e of edgesOf(n.S, n.pos, a.base, 'lb', false, null)) {
				const g2 = n.g + e.lb;
				if (!e.X) { open.push({ S: n.S, pos: null, g: g2, f: g2, seq: seq++, goal: true }); continue; }
				const k2 = mkey(e.S2, e.pos2);
				const had = best.get(k2);
				let S2 = e.S2, gm = g2;
				if (had) {
					const tk = andBits(had.S.taken, S2.taken), btk = andBits(had.S.btaken, S2.btaken);
					const wider = !sameBits(tk, had.S.taken) || !sameBits(btk, had.S.btaken);
					if (!wider && had.g <= g2) continue;
					gm = Math.min(had.g, g2);
					S2 = wider ? model.mkState(S2.vals, tk, btk, S2.cp) : S2;
					if (!wider && had.g > g2) S2 = model.mkState(S2.vals, tk, btk, S2.cp);
				}
				best.set(k2, { g: gm, S: S2 });
				open.push({ S: S2, pos: e.pos2, g: gm, f: gm + hLb(e.pos2), seq: seq++, goal: false });
			}
		}
		let ticks;
		if (complete) ticks = goal;
		else if (!open.size) { ticks = Infinity; complete = true; }
		else { ticks = Infinity; for (const n of open.a) if (n.f < ticks) ticks = n.f; }
		if (a.idle && Number.isFinite(ticks)) ticks = Math.max(0, ticks - 2);
		ST.lbExpands += expanded; ST.lbMs += Date.now() - t0;
		return { ticks, complete, expanded, ms: Date.now() - t0 };
	}
	/** UNTOGGLE: edge e from state S toggles back the switch feature enterFeat that the node's entering edge (or the
	 *  anchor's arrival) toggled: a no-op pair on the abstract state (on -> off -> on, or off -> on -> off) */
	function untoggles(e, S, enter) {
		if (!enter || !e || !e.X || !e.S2) return false;
		const f = e.X.feat;
		if (f !== enter.feat || !TOGGLE_FEAT.test(String(f))) return false;
		// (the same trigger component again, or a reset of that switch: another component of the same switch id is a real
		// move (a door passed with the switch on, then off again: test/planplanner.js toggle2))
		if (e.X.id !== enter.id && e.X.kind !== 'pswR' && e.X.kind !== 'oswR') return false;
		return S.feats[f] !== e.S2.feats[f];
	}
	// ---------------------------------------------------------------- the plan search
	function search(a, po, exclude, ban) {
		const t0 = Date.now();
		const ms = po.ms, maxExpand = po.maxExpand;
		pairUntil = t0 + ms;
		const budget = po.depth > 0 ? po.depth - a.tick : Infinity;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, found = null, pruned = 0;
		const P = pace();
		const root = { S: a.S, pos: a.pos, g: 0, gl: 0, parent: null, e: null, depth: 0, seq: seq++ };
		// (THE TIMER, EEAT_PLAN_TIMER=1: the deadline search's ticks left (po.tLeft): a node whose est arrival plus the open
		// level's walk to the trophy passes them is not generated; ordering only, the plan() call's extra search)
		const tLeft = po.tLeft > 0 ? po.tLeft : Infinity;
		// (a puzzle, 3+ landmarks left: greedy on the heuristic, g a tie-break (LAMA's greedy best-first); else weighted A*)
		// (the timer's deadline search: the fewest landmarks left first (LAMA's greedy order: the open level's walk is blind to
		// the doors a landmark opens), then A* on the est; no gain bonus: the trophy in time, not the most gain)
		const gw = tLeft < Infinity ? 1 : hLM(a.S) >= 3 ? 0.1 : 1;
		const gainB = tLeft < Infinity || po.noGain ? 0 : GAIN_BONUS, lmW = tLeft < Infinity ? 1e7 : LM_W;
		// (THE LONG PLAN CALL's rest: only the guide's edge at each depth)
		const guide = Array.isArray(po.guide) ? po.guide : null;
		const fOf = (g, S, pos) => gw * g + EST_W * hSteps(pos) * P + lmW * hLM(S) - gainB * P * S.gain;
		root.f = fOf(0, a.S, a.pos);
		open.push(root);
		best.set(a.S.key + '#' + a.pos.id, 0);
		let bestPartial = root;
		// (the partial plan's end: the fewest landmarks left, then the most gain, then the least f)
		const better = (x, y) => { const hx = hLM(x.S), hy = hLM(y.S); return hx < hy || (hx === hy && (x.S.gain > y.S.gain || (x.S.gain === y.S.gain && x.f < y.f))); };
		let rootEdges = -1, bestRootChild = null;   // (-1: the budget ended before the root was expanded: no proof of anything)
		// (THE INCUMBENT, lane 6 n5 block 1: the cheapest goal node GENERATED so far, a complete plan to the trophy by the est
		// walk; the budget's end returns it instead of a partial plan (EEAT_PLAN_INC=0: off). The heuristic hSteps is the
		// relaxed walk's, far below the est of the edges (First Person Maze from the route's own state at tick 676: the
		// root's f 300, its children 158-170, the trophy edge est 584), and the gain bonus lowers every toggle's f by
		// GAIN_BONUS x pace: on a switch level the open list never drains to the goal's f, and the budget's end handed the
		// strategy the "most gain" partial plan (a column of switch toggles) while the trophy leg (486 route ticks) was never
		// planned. Ordering only: the incumbent is a plan the search generated (its est walk), no edge dropped)
		let inc = null;
		while (open.size) {
			const n = open.pop();
			if (n.goal) { found = n; break; }
			const k = n.S.key + '#' + n.pos.id;
			if (best.get(k) < n.g) continue;
			// (the root is always expanded: a plan of one step at least, whatever the budget)
			if (expanded > 0 && (expanded >= maxExpand || Date.now() - t0 > ms)) break;
			expanded++;
			if (better(n, bestPartial)) bestPartial = n;
			const isRoot = n === root;
			const es = edgesOf(n.S, n.pos, a.base, 'plan', isRoot, a.S.key + '|' + a.cls, isRoot ? a : null);
			if (isRoot) rootEdges = es.length;
			// (the landmarks this node reaches only through killers (the est walk walls them unprotected): protection on
			// counts as one more landmark here, so the search takes it first; Bad EE Level 9's switch 7 past the spikes)
			let protBoost = false;
			if (model.featSet.has('prot') && n.S.feats.prot === 0) {
				const h0 = hLM(n.S);
				let est = false, relax = false;
				for (const e of es) if (e.X && hLM(e.S2) < h0) { if (e.relaxOnly) relax = true; else est = true; }
				protBoost = relax && !est;
			}
			for (const e of es) {
				if (isRoot && exclude.has(e.edge)) continue;
				if (ban && ban.has(e.edge)) continue;
				if (guide && guide[n.depth] !== e.edge) continue;
				if (UNTOGGLE && untoggles(e, n.S, n.e && n.e.X ? n.e.X : isRoot ? a.viaX : null)) { ST.untoggled = (ST.untoggled || 0) + 1; continue; }
				const g2 = n.g + e.est, gl2 = n.gl + e.lb;
				if (!e.X) {
					if (gl2 >= budget) { pruned++; continue; }
					if (g2 > tLeft) { pruned++; continue; }
					const gn = { S: n.S, pos: null, g: g2, gl: gl2, f: gw < 1 ? -1e12 + g2 : g2, parent: n, e, depth: n.depth + 1, seq: seq++, goal: true };
					open.push(gn);
					if (INC_ON && g2 < PENALTY && (!inc || g2 < inc.g)) inc = gn;
					continue;
				}
				const hl = hLb(e.pos2);
				if (gl2 + hl >= budget) { pruned++; continue; }
				if (tLeft < Infinity && !(g2 + hSteps(e.pos2) * P <= tLeft)) { pruned++; continue; }
				const k2 = e.S2.key + '#' + e.pos2.id;
				const had = best.get(k2);
				if (had !== undefined && had <= g2) continue;
				best.set(k2, g2);
				const child = { S: e.S2, pos: e.pos2, g: g2, gl: gl2, f: fOf(g2, e.S2, e.pos2) - (protBoost && e.X.kind === 'prot' && e.X.param === 1 ? LM_W : 0), parent: n, e, depth: n.depth + 1, seq: seq++, goal: false };
				open.push(child);
				if (isRoot && (!bestRootChild || child.f < bestRootChild.f)) bestRootChild = child;
				if (LM_PART && better(child, bestPartial)) { bestPartial = child; child.lmGen = true; }
			}
		}
		ST.expands += expanded;
		if (!found && inc) { found = inc; ST.incumbents = (ST.incumbents || 0) + 1; }
		// (the budget out before any child was expanded: the root's best child, a one-step partial plan)
		if (bestPartial === root && bestRootChild) bestPartial = bestRootChild;
		if (LM_PART && !found && bestPartial && bestPartial.lmGen) ST.lmPart = (ST.lmPart || 0) + 1;
		return { found, bestPartial: bestPartial === root ? null : bestPartial, expanded, ms: Date.now() - t0, pruned, rootEdges, exhausted: !open.size && !found };
	}
	/** a death step's ORDERING field: the tiles a death starts from (model.dieSrc), not its goal tiles (the respawn, where
	 *  the leg's start usually stands: every finder's field read 0 there and no search went to a killer; the executor's
	 *  closest read 0, rung after rung). The goal test is the waypoint's own (alive back at the respawn, deaths + 1);
	 *  EEAT_DIE_FIELD=0: the respawn's field as before */
	const DIE_FIELD = process.env.EEAT_DIE_FIELD !== '0';
	const dieSrcArr = model.dieSrc && model.dieSrc.length ? model.dieSrc : null;
	function dieField(wp) {
		if (DIE_FIELD && dieSrcArr) { wp.fieldTiles = dieSrcArr; wp.fieldTouch = false; wp.dieField = true; }
		return wp;
	}
	/** the path of a search node -> the plan's steps (with the key-door passages and death steps inserted) */
	/** BREADCRUMBS (doctor 3, EEAT_PLAN_CRUMBS=1, default off): the root edge's leg is long (its est walk CRUMB_MIN steps
	 *  or more) -> the one crumb step to take first: a trigger that changes no model state (a coin, blue coin or checkpoint
	 *  no gate reads: `relevant` false) whose est-walk detour d(pos -> c) + d(c -> target) - d(pos -> target) is at most
	 *  max(CRUMB_SLACK, CRUMB_SLACK_F x D), the farthest such within CRUMB_REACH steps (else the nearest beyond it), not
	 *  nearer than CRUMB_NEAR, not one that failed twice from this node class. Why: a level whose triggers gate nothing
	 *  is ONE leg for the planner (EX Crew Ice: the plan 'trophy', a 5,145-tick known route, the compile 688 tiles short
	 *  in 60 and 180 s), where the level's designer put its coins along the way: 13 of the known route's 15 coins lie on a
	 *  shortest est walk from the start to the trophy (detour 0-3 steps), and from its own arrivals the executor chains
	 *  those coins leg by leg (src/out/doc3/chain.js). The crumb's edge is 'trig:<id>', so its arrival is an anchor of
	 *  its own (strategy addArrival's re-entry rule: the same model state, another trigger) that the next plan starts
	 *  from (receding horizon: one crumb a plan). Ordering only: the crumb is a waypoint, never a gate. */
	function crumbStep(a, e, cls) {
		if (!CRUMBS || e.viaDeath) return null;
		// (the geometry by the 'now' walk: est's walls (killers unless protected) WITHOUT the CEGAR's cuts: a failed long
		// leg's cuts made its est walk relaxation-only (EX Crew Ice with the first version: 4 crumbs, then the trophy edge
		// at the 1e6 penalty and no crumb from there))
		const S = a.S, tgt = e.live || trophyTiles;
		const dA = model.dist(S, a.pos, 'now', a.base);
		let D = INF;
		for (const t of tgt) if (dA[t] < D) D = dA[t];
		if (!(D >= CRUMB_MIN) || D >= INF) return null;
		const slack = Math.max(CRUMB_SLACK, CRUMB_SLACK_F * D);
		let near = null, far = null;
		for (const X of crumbCands) {
			const edge = 'trig:' + X.id;
			if (facts && facts.rungOf(edge, cls) >= 2) continue;
			const live = model.liveTiles(S, X);
			if (!live.length) continue;
			let d1 = INF;
			for (const t of live) if (dA[t] < d1) d1 = dA[t];
			if (!(d1 >= CRUMB_NEAR) || d1 >= D) continue;
			const dX = model.dist(S, { id: 'crumb' + X.id, tiles: live.slice(), extra: 0 }, 'now', a.base);
			let d2 = INF;
			for (const t of tgt) if (dX[t] < d2) d2 = dX[t];
			if (d2 >= INF || d1 + d2 - D > slack) continue;
			const c = { X, live, d1, edge };
			if (d1 <= CRUMB_REACH) { if (!far || d1 > far.d1) far = c; } else if (!near || d1 < near.d1) near = c;
		}
		const c = far || near;
		if (!c) return null;
		return { edge: c.edge, nodeClass: cls, rung: facts ? facts.rungOf(c.edge, cls) : 0, estTicks: Math.round(c.d1 * pace()), lb: 0, crumb: true,
			waypoint: { kind: 'trigger', tiles: c.live.slice(), trig: c.X.id, expect: null, label: `crumb ${c.X.label}` } };
	}
	function stepsOf(a, node) {
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push({ e: n.e, from: n.parent });
		path.reverse();
		const steps = [];
		let deathsNow = null;
		const push = (st) => { st.n = steps.length; steps.push(st); };
		for (let i = 0; i < path.length; i++) {
			const { e, from } = path[i];
			const isRoot = i === 0;
			const cls = isRoot ? a.S.key + '|' + a.cls : from.S.key + '|*';
			// (breadcrumbs: a long root leg goes by a crumb first)
			if (isRoot && CRUMBS && !(e.X && e.X.kind === 'die')) { const cs = crumbStep(a, e, cls); if (cs) push(cs); }
			// a death first where only a death reaches the target
			if (e.viaDeath) {
				if (deathsNow === null) deathsNow = a.sim ? a.sim.deaths : 0;
				const edge = `death:${deathsNow}`;
				const wpD = { kind: 'region', tiles: VIA_ANY && model.respawn && model.respawn.length ? model.respawn.slice() : model.respawnOf(from.S).tiles.slice(), expect: { feat: 'deaths', value: deathsNow + 1 }, allowDeath: true, label: `die, back at a respawn (deaths ${deathsNow + 1})` };
				dieField(wpD);
				push({ edge, nodeClass: cls, rung: facts ? facts.rungOf(edge, cls) : 0, estTicks: DEAD_TICKS, lb: DEAD_TICKS, waypoint: wpD });
				deathsNow++;
			}
			// the anchor's own active key: its door first, before the key runs out
			if (isRoot && a.sim && (!e.X || e.X.kind !== 'key')) {
				const pass = keyPassage(a.S, a.pos, e, a.base);
				// (once done from this anchor's class its arrivals past the door are the anchor's own (the same model state):
				// the passage is not proposed again, the plan goes on from them)
				if (pass && !(facts && facts.okTicks(`region:key${pass.colour}-door`, cls) !== undefined)) {
					const c = pass.colour, left = KEY_TICKS - (a.sim._ticks - a.sim._kt[c]);
					if (left > 0) push({ edge: `region:key${c}-door`, nodeClass: cls, rung: facts ? facts.rungOf(`region:key${c}-door`, cls) : 0, estTicks: 0, lb: 0,
						waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTick: a.tick + left - 1, label: `past the ${COLOURS[c] || c} key door` } });
				}
			}
			const X = e.X;
			if (X && X.kind === 'die') {
				// (a death as a move: the respawn with one death more; a death shortcut after it counts from there)
				deathsNow = e.expect.value;
				push({ edge: e.edge, nodeClass: cls, rung: facts ? facts.rungOf(e.edge, cls) : 0, estTicks: Math.round(e.est), lb: e.lb,
					waypoint: dieField({ kind: 'region', tiles: DIE_ANY && model.respawn && model.respawn.length ? model.respawn.slice() : e.live.slice(), expect: e.expect, allowDeath: true, label: X.label }) });
				continue;
			}
			// (a FORCED CHAIN, EEAT_TRICKS chain: first the lane's boost tile (a region step: the way there, the doors as they
			// are), then the chain's own step from there (the lane itself is forced: no input needed))
			// (once: after its first failure from a class the chain's step goes alone, no stall on the head)
			if (X && X.kind === 'chain' && X.boost !== undefined && CHAIN_HEAD && !(facts && facts.rungOf(e.edge + '^', cls) > 0)) {
				const eh = e.edge + '^';
				push({ edge: eh, nodeClass: cls, rung: 0, estTicks: Math.max(0, Math.round(e.est) - 8), lb: 0,
					waypoint: { kind: 'region', tiles: [X.boost], expect: null, label: `${X.label}: its boost` } });
			}
			const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: e.anyOf > 1 ? `${X.label} (any of ${e.anyOf})` : X.label }
				: /^trophy~t/.test(e.edge) ? { kind: 'trophy', tiles: e.live.slice(), label: `trophy (${e.live.length} of ${trophyTiles.length} tiles)` } : { kind: 'trophy', label: 'trophy' };
			push({ edge: e.edge, nodeClass: cls, rung: facts ? facts.rungOf(e.edge, cls) : 0, waypoint: wp, estTicks: Math.round(e.est), lb: e.lb, pen: e.pen || '' });
			// a key followed by its door: the passage while the key is on
			if (X && X.kind === 'key' && i + 1 < path.length) {
				const next = path[i + 1].e;
				const pass = keyPassage(e.S2, e.pos2, next, a.base, X.param);
				if (pass) push({ edge: `region:key${X.param}-door`, nodeClass: e.S2.key + '|*', rung: facts ? facts.rungOf(`region:key${X.param}-door`, e.S2.key + '|*') : 0, estTicks: 0, lb: 0,
					waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTickFrom: 'prev+500', label: `past the ${COLOURS[X.param] || X.param} key door` } });
			}
		}
		return steps;
	}
	/** the tiles just past a key door that the next edge needs (null: it needs none): the tiles next to a door of that
	 *  colour that the key-off state cannot reach from the position but the key-on state can */
	function keyPassage(S, pos, next, base, colour) {
		const cols = colour !== undefined ? [colour] : [0, 1, 2, 3, 4, 5].filter((c) => S.feats['key' + c] === 1);
		for (const c of cols) {
			const f = 'key' + c;
			if (S.feats[f] !== 1) continue;
			const vals = S.vals.slice(); vals[model.fIdx.get(f)] = 0;
			const Soff = model.mkState(vals, S.taken, S.btaken);
			const dOff = model.dist(Soff, pos, 'est', base), dOn = model.dist(S, pos, 'est', base);
			const tgt = next.live || trophyTiles;
			let off = INF, on = INF;
			for (const t of tgt) { if (dOff[t] < off) off = dOff[t]; if (dOn[t] < on) on = dOn[t]; }
			if (off < INF && off <= on + 2) continue;
			// the tiles next to a door of colour c, reachable with the key on, not with it off
			const tiles = [];
			for (let i = 0; i < model.N; i++) {
				if (dOff[i] < INF || dOn[i] >= INF || model.A.cls[i] === 0 || model.A.cls[i] === 3) continue;
				const x = i % W, y = (i / W) | 0;
				let near = false;
				for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1) && !near; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
					const j = yy * W + xx;
					if (model.A.cls[j] === 3 && model.A.gateFeat[j] === f && model.A.gatePol[j] === 1) { near = true; break; }
				}
				if (near) tiles.push(i);
			}
			if (tiles.length) return { colour: c, tiles };
		}
		return null;
	}
	/** the est walls from the failures: a failed step's closest approach (at its second rung, or exhausted there) walls
	 *  its 3 x 3 in the est walk (ordering only: the lb and the proofs never read them), so the next plans go another
	 *  way where there is one; rebuilt when the facts' version moves */
	let wallsVer = -1;
	function syncWalls() {
		if (!facts || facts.version() === wallsVer) return;
		wallsVer = facts.version();
		if (SC_ANY) return syncWallsScoped();
		let mask = null, n = 0;
		for (const fct of facts.list()) {
			if (fct.kind === 'fail' && fct.cut) for (const j of fct.cut) { if (!mask) mask = new Uint8Array(model.N); if (!mask[j]) { mask[j] = 1; n++; } }
			if (fct.kind !== 'fail' || !fct.closest || fct.closest.tile === undefined || fct.closest.tile === null) continue;
			if (fct.noWall) continue;   // (CUT_PROG: a budget failure that made too little progress walls nothing)
			if (!((fct.rung | 0) >= 1 || fct.why === 'exhausted')) continue;
			const t = fct.closest.tile, x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (model.trigOf[j] >= 0) continue;
				if (!mask) mask = new Uint8Array(model.N);
				if (!mask[j]) { mask[j] = 1; n++; }
			}
		}
		model.setEstWalls(mask);
		ST.estWalls = n;
	}
	/** THE SCOPED WALL (EEAT_PLAN_WALL_SCOPE): the same walls (a fact's cut, the 3 x 3 of its closest approach at rung >= 1
	 *  or exhausted), but 'lift': none from a fact whose edge has since succeeded from any node class (facts.okAnyOf);
	 *  'class': a fact's walls only in the est walks of its anchor's abstract state (fct.sk, learn() records it; a fact
	 *  without one walls every state as before); 'edge': walledEdges = the edges that own a wall, and edgesOf prices every
	 *  other edge by the unwalled est walk */
	const walledEdges = new Set();
	function syncWallsScoped() {
		let mask = null, n = 0, lifted = 0;
		const byKey = SC_CLASS ? new Map() : null;
		walledEdges.clear();
		const put = (fct, j) => {
			let m;
			if (byKey && fct.sk !== undefined) { m = byKey.get(fct.sk); if (!m) byKey.set(fct.sk, (m = new Uint8Array(model.N))); }
			else { if (!mask) mask = new Uint8Array(model.N); m = mask; }
			if (!m[j]) { m[j] = 1; n++; }
			walledEdges.add(String(fct.edge).replace(/~w$/, ''));
		};
		for (const fct of facts.list()) {
			if (fct.kind !== 'fail') continue;
			if (SC_LIFT && facts.okAnyOf(fct.edge)) { if (fct.cut || fct.closest) lifted++; continue; }
			if (fct.cut) for (const j of fct.cut) put(fct, j);
			if (!fct.closest || fct.closest.tile === undefined || fct.closest.tile === null) continue;
			if (fct.noWall) continue;
			if (!((fct.rung | 0) >= 1 || fct.why === 'exhausted')) continue;
			const t = fct.closest.tile, x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (model.trigOf[j] >= 0) continue;
				put(fct, j);
			}
		}
		// (a keyed state's walls carry the global ones too)
		if (byKey && mask) for (const m of byKey.values()) for (let i = 0; i < m.length; i++) if (mask[i]) m[i] = 1;
		model.setEstWalls(mask, byKey);
		ST.estWalls = n; ST.wallsLifted = lifted; ST.wallKeys = byKey ? byKey.size : 0; ST.walledEdges = walledEdges.size;
	}
	/** THE TIMER: a remover of the anchor's running killer (its block with the number 0) within the ticks left by the est
	 *  walk in the anchor's state */
	let removerTiles = null;
	function removerInTime(a, tm) {
		if (!(tm.id > 0)) return false;
		if (!removerTiles) {
			removerTiles = new Map();
			const fg = L.fg, lk = L.lookup0;
			for (let i = 0; i < fg.length; i++) {
				const id = fg[i];
				if ((id === 421 || id === 422 || id === 1584) && lk && !(lk[i] > 0)) { let r = removerTiles.get(id); if (!r) removerTiles.set(id, (r = [])); r.push(i); }
			}
		}
		const tiles = removerTiles.get(tm.id);
		if (!tiles || !tiles.length) return false;
		const d = model.dist(a.S, a.pos, 'est', a.base);
		let b = INF;
		for (const t of tiles) if (d[t] < b) b = d[t];
		return b < INF && b * pace() <= tm.left;
	}
	/** THE TIMER AT THE START (EEAT_PLAN_TIMER_START, on inside EEAT_PLAN_TIMER=1; =0 off): an anchor with no timer running
	 *  whose est walk reaches NOTHING the plan wants (the trophy, a relevant trigger) without a timed killer's starter tile
	 *  (421 / 422 / 1584 with a time) will carry that killer: One Minute Descent's start falls through its zombie at tick
	 *  54, so the start's plans took 1-3 blue coins before the first timed anchor sent the plan to team 6. Returns the
	 *  {left, id} the anchor will have (the doorway starter's est arrival + its duration, eesim.js effectDuration: (v +
	 *  2 PING) * 100 ticks; the latest among the doorways) or null (not forced). The walk without the CEGAR walls. */
	let starterTiles = null;
	const forcedMemo = new Map();
	function forcedTimer(a) {
		if (!starterTiles) {
			starterTiles = [];
			const fg = L.fg, lk = L.lookup0;
			if (lk) for (let i = 0; i < fg.length; i++) { const id = fg[i]; if ((id === 421 || id === 422 || id === 1584) && lk[i] > 0) starterTiles.push(i); }
		}
		if (!starterTiles.length || !a.pos || !a.pos.tiles) return null;
		const key = a.S.pkey + showKeyOf(a) + '#' + a.pos.id;
		if (forcedMemo.has(key)) return forcedMemo.get(key);
		let out = null;
		try {
			const god = !!(a.sim && a.sim.in_god_mode);
			const st = god ? starterTiles.filter((t) => L.fg[t] === 421) : starterTiles;
			if (st.length) {
				const d = model.dist(a.S, a.pos, 'estNW', a.base);
				const m = Uint8Array.from(model.passMask(a.S, 'estNW', a.base));
				for (const t of st) m[t] = 0;
				const d0 = model.bfs(m, a.pos.tiles);
				let free = false, reach = false;
				const see = (t) => { if (d0[t] < INF) free = true; else if (d[t] < INF) reach = true; };
				for (const t of trophyTiles) see(t);
				for (const X of relevant) { if (free) break; if (X.tiles) for (const t of X.tiles) see(t); }
				if (!free && reach) {
					const P = pace();
					let best = -1, bid = -1;
					for (const t of st) {
						if (!(d[t] < INF)) continue;
						const x = t % W, y = (t / W) | 0;
						let door = false;
						for (let dy = -1; dy <= 1 && !door; dy++) for (let dx = -1; dx <= 1; dx++) {
							const nx = x + dx, ny = y + dy;
							if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
							if (d0[ny * W + nx] < INF) { door = true; break; }
						}
						if (!door) continue;
						const left = Math.floor(d[t] * P + (L.lookup0[t] + 0.4) * 100);
						if (left > best) { best = left; bid = L.fg[t]; }
					}
					if (best > 0) out = { left: best, id: bid, forced: true };
				}
			}
		} catch (e) { out = null; }
		forcedMemo.set(key, out);
		if (forcedMemo.size > 256) forcedMemo.delete(forcedMemo.keys().next().value);
		return out;
	}
	const showKeyOf = (a) => (a.S.show ? '|' + a.S.show.coins + ',' + a.S.show.bcoins + ',' + a.S.show.deaths : '');
	/** THE TIMER's plan: the plan search with the anchor's timed killer as a deadline (po.tLeft: a node whose est arrival
	 *  + the open level's walk to the trophy passes it is not generated), a whole plan to the trophy or null; its own
	 *  clock: half of the plan call's (at least 50 ms) */
	function timerPlan(a, so, deadline, tl) {
		const ms = Math.max(50, (so.ms || 300) / 2);
		const res = search(a, Object.assign({}, so, { ms, tLeft: tl }), new Set());
		if (process.env.EEAT_TIMER_DBG === '1') console.error(`[timer] left ${tl} found ${!!res.found} g ${res.found ? Math.round(res.found.g) : '-'} expanded ${res.expanded} pruned ${res.pruned} exhausted ${res.exhausted} ms ${res.ms} partial ${res.bestPartial ? Math.round(res.bestPartial.g) + ' h ' + hSteps(res.bestPartial.pos) : '-'}`);
		if (!res.found) return null;
		const steps = stepsOf(a, res.found);
		if (!steps.length) return null;
		return { id: `p${ST.plans}.t`, steps, cost: Math.round(res.found.g), lb: res.found.gl, partial: false, why: `trophy in the timer (${tl} ticks left)`, expanded: res.expanded, timer: tl };
	}
	/**
	 * plan(anchor, {k, depth, epoch, ms, maxExpand}) -> Plan[] (with .why when empty: 'exhausted' | 'proof')
	 */
	function plan(anchor, po = {}) {
		landmarks();   // (once, outside the budget)
		const t0 = Date.now();
		ST.plans++;
		syncWalls();
		const a = anchorOf(anchor);
		// (the stones' untaken tiles in the anchor's own state: Treasure Trove Cove's box-5 compile with the stones went back to
		// the blue coins its anchors held already, 6 of 30 stone steps)
		stoneLive = null;
		if (STONES && stones.length && a.sim && typeof a.sim.is_coin_collected === 'function') {
			stoneLive = new Map();
			for (const X of stones) stoneLive.set(X.id, X.tiles.filter((t) => !a.sim.is_coin_collected(t % W, (t / W) | 0)));
		}
		const k = po.k || 3;
		const first = ST.plans === 1;
		const so = { ms: po.ms || (first ? 2000 : 300), maxExpand: po.maxExpand || 200000, depth: po.depth || 0 };
		const plans = [], exclude = new Set();
		let why = '', rootEdges = -1, anyExhausted = false;
		const deadline = t0 + so.ms;
		for (let r = 0; r < k; r++) {
			let res = search(a, Object.assign({}, so, { ms: Math.max(50, (deadline - Date.now()) / Math.max(1, k - r)) }), exclude);
			// (with the physics price a PARTIAL plan's path is checked too: its first legs are what the executor runs next)
			const vNode = (x) => x.found || (PHYS_PRICE && x.bestPartial && x.bestPartial.e ? x.bestPartial : null);
			for (let v = 0; v < 6 && vNode(res) && Date.now() < deadline + so.ms / 2; v++) {
				if (!verifyPath(a, vNode(res), deadline + so.ms / 2)) break;
				res = search(a, Object.assign({}, so, { ms: Math.max(50, (deadline - Date.now()) / Math.max(1, k - r)) }), exclude);
			}
			if (rootEdges < 0) rootEdges = res.rootEdges;
			const node = res.found || res.bestPartial;
			if (!node) { anyExhausted = anyExhausted || res.exhausted; break; }
			const steps = stepsOf(a, node);
			if (!steps.length) break;
			const lbTail = res.found ? 0 : hLb(node.pos);
			plans.push({ id: `p${ST.plans}.${r}`, steps, cost: Math.round(node.g + (res.found ? 0 : pace() * hStepsD(node.pos))), lb: node.gl + lbTail, partial: !res.found, why: res.found ? 'trophy' : 'budget: the most gain', expanded: res.expanded });
			exclude.add(steps[0].edge);
			// (the first step's own edge: a death or passage step was inserted before the real first edge)
			let n = node; while (n.parent && n.parent.parent) n = n.parent;
			if (n.e) exclude.add(n.e.edge);
		}
		// (THE LONG PLAN CALL, EEAT_PLAN_LONG=<ms>: every plan partial: one long search from this abstract state; its plan
		// goes FIRST, in front of the near / crumb plans too (made below as without it: they read the search's own plans))
		let longP = null;
		if (LONG_MS > 0 && plans.length && plans.every((p) => p.partial || !(p.cost < PENALTY))) {
			const stuck = !LONG_R || !!(facts && plans[0].steps[0] && facts.rungOf(plans[0].steps[0].edge, plans[0].steps[0].nodeClass) >= LONG_R);
			try { const lp = longPlan(a, so, po, stuck); if (lp) longP = lp; } catch (e) { if (process.env.EEAT_LONG_DBG === '1') console.error('longPlan', e.stack); }
		}
		// (THE BYPASS, EEAT_PLAN_BYPASS=R: the trophy without the triggers whose legs failed R rungs from this class, first)
		if (BYPASS > 0 && facts && plans.length) {
			try { const bp = bypassPlan(a, plans, so, deadline); if (bp) plans.unshift(bp); } catch (e) { if (process.env.EEAT_BYPASS_DBG === '1') console.error('bypassPlan', e.stack); }
		}
		// (THE TIMER: a whole plan in the anchor's timed killer's time first; none = a late anchor, the strategy's pick puts
		// it after the anchors in time)
		let late = false, timerCost;
		if (TIMER) {
			let tm = timerOf(a.sim);
			// (THE TIMER AT THE START: a killer every way passes counts as running: the deadline plan only, never late)
			let forced = false;
			if (!(tm.left < Infinity) && TIMER_START && a.sim && !a.sim.is_dead) { const f = forcedTimer(a); if (f) { tm = f; forced = true; ST.timerForced = (ST.timerForced || 0) + 1; } }
			const tl = tm.left;
			if (forced) {
				let tp = null;
				try { tp = timerPlan(a, so, deadline, tl); } catch (e) { tp = null; }
				if (tp) { tp.why = `trophy in the coming timer (${tl} ticks)`; plans.unshift(tp); timerCost = tp.cost; ST.timerPlans = (ST.timerPlans || 0) + 1; }
			} else if (tl < Infinity) {
				let tp = null;
				try { tp = timerPlan(a, so, deadline, tl); } catch (e) { tp = null; }
				if (tp) { plans.unshift(tp); timerCost = tp.cost; ST.timerPlans = (ST.timerPlans || 0) + 1; }
				// (late: no plan in time AND no remover of the killer (its block with the number 0) within the ticks left by
				// the est walk in the anchor's state: a remover on the way clears it, the plan search does not model that)
				else if (TIMER_LATE && !removerInTime(a, tm)) { late = true; ST.timerLate = (ST.timerLate || 0) + 1; }
			}
		}
		if (plans.length && NEAR_K > 0 && facts) {
			try { const near = nearPlans(a, plans); if (near.length) plans.unshift(...near); } catch (e) { /* the rule is ordering only */ }
		}
		// (the crumbs are a way to the first route: once a route is known (po.runBound finite) the plans are the plan
		// search's own: box 5, Ruins (2 crumbs), 60 s: 1,597 run ticks with them vs 1,347 without, a crumb's detour kept)
		if (plans.length && crumbs.length && !(po.runBound !== undefined && Number.isFinite(+po.runBound))) {
			try {
				const cp = crumbPlan(a, plans);
				// (THE STUCK CRUMB, EEAT_CRUMB_DEMOTE=R: a crumb plan whose crumb leg has failed R rungs from this anchor's class
				// goes after the plan search's own plans instead of before them; unset = every crumb plan in front, as before)
				if (cp.length && CRUMB_DEMOTE > 0) {
					const fresh = cp.filter((p) => !(p.crumbRung >= CRUMB_DEMOTE)), stale = cp.filter((p) => p.crumbRung >= CRUMB_DEMOTE);
					if (stale.length) ST.crumbDemoted = (ST.crumbDemoted || 0) + stale.length;
					if (fresh.length) plans.unshift(...fresh);
					if (stale.length) plans.push(...stale);
				} else if (cp.length) plans.unshift(...cp);
			} catch (e) { if (process.env.EEAT_CRUMB_DBG === '1') console.error('crumbPlan', e.stack); }
		}
		if (longP) plans.unshift(longP);
		if (!plans.length) {
			why = rootEdges < 0 ? 'budget' : rootEdges === 0 && !(facts && facts.list().length) ? 'proof' : 'exhausted';
			// (no edge at the root because the facts took them all: exhausted; none at all without facts: a walk proof)
			if (rootEdges === 0 && facts && facts.list().length) {
				const raw = edgesOf(a.S, a.pos, a.base, 'lb', false, null);
				why = raw.length ? 'exhausted' : 'proof';
			}
		}
		lastPlans = plans; lastWhy = why;
		ST.planMs += Date.now() - t0;
		const out = plans;
		out.why = why;
		out.plans = plans;
		if (late) out.late = true;
		if (timerCost !== undefined) out.timerCost = timerCost;
		return out;
	}
	/**
	 * THE DIVERSIFICATION RULE (lane 3, COMPILE-ALL block 2; OPT-IN EEAT_PLAN_NEAR=1): the plan search keeps the cheapest whole plan, so a first leg
	 * the executor cannot do in its rung comes back at the next rung, again and again, while nearer triggers that change
	 * the state are never tried (the FIRST-LEG class of the full compile b1: 45 levels, a first target 100-600 tiles away;
	 * the closest-0 false report had diversified by accident: its walls near the goal pushed the est walk to other
	 * triggers). Here: when EVERY plan's first leg has FAILED from this node class (its rung >= 1: the plan search's own
	 * diversity spent), the root's triggers that are nearer by the admissible bound (the edge's lb), not tried from this class yet (rung 0), not only a
	 * relaxation's or a death's way, go first as one-step plans, the nearest first, at most NEAR_K (EEAT_PLAN_NEAR): a leg the executor does in its first rung is a new anchor with more gain (the strategy's most-progress order
	 * goes on from it), one it fails moves to rung 1 and the next nearer trigger is offered at the next plan. Ordering
	 * only: every plan the search found is still there (after them), no edge is dropped, the lb and the proofs untouched.
	 * Measured (box 3, 60 s, --workers=3): a first version (fire when the BEST plan's first leg failed, 2 near plans
	 * first) The Glitch 0 -> 8, MIHB's Dream 6 -> 10, but I Wanna be the Guy 15 -> 3 (its 2nd / 3rd plans, a checkpoint
	 * and a switch, lead to its 15 triggers; the nearest-by-lb 40-coin group and checkpoints took their slots); this one
	 * (all failed, 1 near plan) on lane 3's 45 FIRST-LEG levels 4 triggers vs 2 (noise level), gate20 7 compiled vs 9 of
	 * the same code without it (Tutorial 1 / Bygone Tutorial: they compile in about half the runs), IWBTG 15 / 11 in two
	 * runs: no gain shown, so OPT-IN; with EEAT_SKEL_CLOSEST=1 IWBTG 11 (15 -> 1 without the rule), MIHB 5, The Glitch 0.
	 * DEFAULT ON (K 1) with the true skeleton closest since COMPILE-ALL block 3 lane 4: the pair measured together (box 3,
	 * 60 s, --workers=3, n4-plan a137f8e, env EEAT_SKEL_CLOSEST=1 EEAT_PLAN_NEAR=1): the shared gate compiled 11 vs the
	 * baseline's 9 (Tutorial 1 2,233 and Tree Decorating 1,320 run ticks, both compile in half the base runs), worse 0,
	 * better 10 (Booty Return 25 vs 11, I Wanna be the Guy 16 vs 11, MIHB's Dream 22 vs 16, Starlight 22 vs 18, NC Naos
	 * 319 vs 358 run ticks), The Glitch 8 vs the baseline's 4; the lane's 23 levels side by side with the base: progress
	 * 78 vs 72 (Booty Return 16 vs 11, SPOT THE DIDFERNECE 4 vs 1, Beaches in Space 4 vs 2). EEAT_PLAN_NEAR=0: off.
	 */
	function nearPlans(a, plans) {
		const p0 = plans[0];
		if (!p0 || !p0.steps || !p0.steps.length) return [];
		const cls = a.S.key + '|' + a.cls;
		// (the first real edge of the best plan: a death or a key passage may be inserted before it)
		const s0 = p0.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p0.steps[0];
		if (facts.rungOf(s0.edge, cls) < 1) return [];
		// (only once the plan search's own diversity is spent: every plan's first leg has failed from this class; a plan
		// whose first leg is untried still gets its rung-0 try (I Wanna be the Guy: its 2nd / 3rd plans' first legs, a
		// checkpoint and a switch, lead to 15 triggers; the nearest-by-lb coins / checkpoints ahead of them took their slots:
		// 15 -> 3)
		let rMin = Infinity;
		for (const p of plans) { const f = p.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p.steps[0]; const r = facts.rungOf(f.edge, cls); if (r < 1) return []; if (r < rMin) rMin = r; }
		const lb0 = Number.isFinite(+s0.lb) ? +s0.lb : Infinity;
		const es = edgesOf(a.S, a.pos, a.base, 'plan', true, cls, a);
		const used = new Set(plans.map((p) => p.steps[0] && p.steps[0].edge));
		// (THE RUNG BALANCE, lane 6 block 4, NEAR_RUNG: a near trigger is offered while its rung is below every plan's first
		// leg's, not only while untried: the plans' first legs climbed rung after rung (5 -> 15 -> 45 s windows, three
		// workers on the same failing edges for the second half of a 60-s compile) while a near trigger that failed its
		// rung 0 never got its rung 1 (Bygone Tutorial: the red key (169, 33) found at rung 1 in 1.9 s once the planner
		// offered it, after the coin and the two keys had spent their rungs 2 and 3); the lowest rung first, then the lb.
		// Measured (box 3, 60 s, --workers=3, with the executor's rate rule): Bygone Tutorial COMPILED in 2 of 2 runs (2,123 /
		// 2,129 run ticks at 48 s; 0 of 6 runs at 60 s without it), the lane's other 10 levels 183 vs 186 triggers (noise);
		// T-PLAN-ORACLE unchanged by construction (it fires only after a failed rung): 619 plans, 0 / 0.
		// EEAT_NEAR_RUNG=0: only untried triggers, as before)
		const rCap = NEAR_RUNG ? rMin : 1;
		const cand0 = (e) => e.X && !e.relaxOnly && !e.viaDeath && e.edge !== s0.edge && !used.has(e.edge) && facts.rungOf(e.edge, cls) < rCap && !(UNTOGGLE && untoggles(e, a.S, a.viaX));
		const byRungLb = (x, y) => (NEAR_RUNG ? facts.rungOf(x.edge, cls) - facts.rungOf(y.edge, cls) : 0) || x.lb - y.lb || x.est - y.est;
		let cands = es.filter((e) => cand0(e) && e.lb < lb0).sort(byRungLb);
		// (THE FAR NEAR PLAN, doctor 5, OPT-IN EEAT_NEAR_FAR=1: no trigger nearer by the lb than the failed first leg: the
		// nearest farther one, by the same order. The lb of a false near is small (Unforgiving Climb: the trophy's 47-50
		// ticks, the level's known route 3,914): no trigger was ever nearer and the plans' first legs climbed every rung)
		if (!cands.length && NEAR_FAR()) cands = es.filter(cand0).sort(byRungLb);
		const out = [];
		const root = { S: a.S, pos: a.pos, e: null, parent: null };
		for (const e of cands.slice(0, NEAR_K)) {
			const steps = stepsOf(a, { S: e.S2, pos: e.pos2, e, parent: root });
			if (!steps.length) continue;
			out.push({ id: `p${ST.plans}.n${out.length}`, steps, cost: p0.cost, lb: e.lb + hLb(e.pos2), partial: true, why: `near: '${s0.waypoint && s0.waypoint.label}' failed its rung ${facts.rungOf(s0.edge, cls) - 1}; the nearest untried trigger first`, near: true });
		}
		ST.nearPlans = (ST.nearPlans || 0) + out.length;
		return out;
	}
	/**
	 * THE CRUMB PLANS (doctor 9, n5; EEAT_CRUMBS=1, model.js): the CRUMB_K nearest crumbs (coins no gate reads) by the
	 * admissible bound, as one-step plans in front of the plans, when the best plan's first leg is long (its lb >= CRUMB_LEGMIN ticks)
	 * and the crumb is nearer than that leg's target (lb below CRUMB_F x its lb); the least lb x (1 + its rung) first (a
	 * crumb that failed its rung gives way to the next nearest, a far one waits). An arrival at a crumb is a new anchor with one gain more: the
	 * strategy goes on from it, so the compile follows the level's breadcrumb trail one leg at a time, and every plan from
	 * each crumb is the plan search's own (the trophy's direct leg first). Ordering only: no edge dropped, the lb untouched.
	 */
	// (CRUMB_K crumb plans, the nearest first: a compile's workers run the first plans' legs side by side, so with one the
	// other worker spent every rung on the long leg itself; box 5, On And On, 60 s, 2 workers: the nearest crumb (a blue
	// coin off the route, closest 1 tile) took rungs 0-3 while the route's coin waited at rung 2)
	const CRUMB_LEGMIN = +process.env.EEAT_CRUMB_LEGMIN || 50, CRUMB_F = +process.env.EEAT_CRUMB_F || 0.9;
	const CRUMB_K = process.env.EEAT_CRUMB_K !== undefined ? Math.max(1, +process.env.EEAT_CRUMB_K | 0) : 2;
	const CRUMB_AFTER = process.env.EEAT_CRUMB_AFTER !== undefined ? Math.max(0, +process.env.EEAT_CRUMB_AFTER | 0) : 1;
	// THE CRUMB'S DETOUR (C6 lane 5; EEAT_CRUMB_DETOUR=F, 0 / unset = off: the crumb plans as before, byte for byte): a
	// crumb is a relay of the long leg only when it lies ON ITS WAY: by the 'now' walk (est's walls without the CEGAR's
	// cuts, as crumbStep) d(anchor -> crumb) + d(crumb -> the leg's target) - d(anchor -> the target) at most
	// max(CRUMB_DETOUR_MIN, F x d(anchor -> the target)); and no crumb before a PLANNED DEATH (the plan's first step
	// 'death:' / 'die:': its long leg starts at the respawn, where the next anchor's crumb plans are asked again). Why: the
	// nearest crumb by the lb alone took Tutorial 2's compile to a blue coin 101 walk steps off its way (D 176) and to one
	// beside the checkpoint the plan dies at (1,531 ticks), a route 5,353-6,069 vs 3,070-3,143 without the crumbs; the
	// crumbs the known routes of 45 levels take (tools/cmp/crumbdetour.js) are all within max(8, 0.351 D) but one (Flight
	// Path: +73 on a D 34 leg): EX Crew Fall of Zeal 28 crumbs, up to 0.351; Stone Ruin 0.209; On And On 0.114.
	const CRUMB_DETOUR_F = process.env.EEAT_CRUMB_DETOUR !== undefined ? Math.max(0, +process.env.EEAT_CRUMB_DETOUR || 0) : 0;
	const CRUMB_DETOUR_MIN = process.env.EEAT_CRUMB_DETOUR_MIN !== undefined ? Math.max(0, +process.env.EEAT_CRUMB_DETOUR_MIN || 0) : 8;
	// THE STUCK CRUMB (C6 push 3 block 2 lane 1; EEAT_CRUMB_DEMOTE=R, 0 / unset = off: the crumb plans in front, byte for
	// byte): a crumb is never a plan's need (a coin no gate reads), so once its leg has failed R rungs from the anchor's class
	// its plan goes after the plan search's own (ordering only: still tried when a worker is free). Why: Need for Steed's
	// crumbs took 409 of its 774 worker-s at 300 s (280 s failing at rungs 2-3), Stone Ruin's 676 of 894 (402 s)
	const CRUMB_DEMOTE = process.env.EEAT_CRUMB_DEMOTE !== undefined ? Math.max(0, +process.env.EEAT_CRUMB_DEMOTE | 0) : 0;
	// THE BYPASS (C6 push 3 block 3 lane 1; EEAT_PLAN_BYPASS=R, 0 / unset = off: the plans as before, byte for byte): the
	// stuck crumb's rule for every target. A plan's first trigger whose leg has failed R rungs from the anchor's class may
	// be one the trophy does not need: the plan search's cheapest est walk goes by it (a crown gate's crown, the nearest
	// coins of a coin-count door, a checkpoint), while a real route goes another way. Once the best plan's first trigger
	// has failed R rungs, the plan search runs once more with every such trigger BANNED at every depth (the plans' first
	// triggers failed R rungs, then the bypass's own first trigger if it failed R rungs too, at most BYPASS_MAX of them);
	// a TROPHY plan found without them (the incumbent counts: a whole plan by the est walk) goes in front of the plan
	// search's plans. None found: those triggers are needed (as far as the abstract model can tell) and the plans stay as
	// they were. Ordering only: no edge dropped from the plans, the lb and the proofs untouched. Why (the known-route test
	// of the 77 stuck steps of the 21 STUCK-FIELD levels with a known route, src/out/n5/lanes/c6_lane1_b3.md): 30 are
	// targets the known route never enters, 14 of them the FIRST step of a whole trophy plan (Need for Steed's crown
	// (327,39), The 7 Depths of Hell's coins (76,279) / (78,228) / (64,176) and switch 3, Ice Slide Ride's coins and
	// checkpoint, Octorage's switch 69 and coins, Fall of Zeal's key groups, UT Eternal Galaxy's checkpoint (166,107), The
	// Memory Game's coin (179,188)), climbing rung after rung (45-s windows) in every plan call.
	const longTried = new Set(), longPaths = [];
	/** fn() with the est walls lifted (model.setEstWalls(null)), the walls rebuilt from the facts after */
	const noWalls = (fn) => { model.setEstWalls(null); try { return fn(); } finally { wallsVer = -1; syncWalls(); } };
	let longCalls = 0;
	/** THE LONG PLAN CALL (EEAT_PLAN_LONG): a kept path's rest from this state, else one long search (once a state) */
	function longPlan(a, so, po, stuck) {
		const sk = a.S.key;
		const mk = (node, why) => {
			const steps = stepsOf(a, node);
			if (!steps.length) return null;
			return { id: `p${ST.plans}.L`, steps, cost: Math.round(node.g), lb: node.gl, partial: false, why, long: true };
		};
		// (a path kept from an earlier long call through this abstract state: its rest, along its own edges)
		for (const lp of longPaths) {
			const i = lp.keys.indexOf(sk);
			if (i < 0 || i >= lp.edges.length) continue;
			const rest = () => {
				const res = search(a, Object.assign({}, so, { ms: 300, maxExpand: 20000, guide: lp.edges.slice(i) }), new Set(), null);
				return res.found && res.found.g < PENALTY ? mk(res.found, `long: the rest of a long plan (step ${i + 1} of ${lp.edges.length}${lp.nowall ? ', the walls lifted' : ''})`) : null;
			};
			const r = lp.nowall ? noWalls(rest) : rest();
			if (r) { ST.longRest = (ST.longRest || 0) + 1; return r; }
		}
		// (a new long search only where the first plan's first step is stuck (LONG_R rungs failed); a kept path's rest any time)
		if (!stuck || longTried.has(sk) || longCalls >= LONG_MAX) return null;
		// (a quarter of the compile's time left at most: po.left, the strategy's)
		const room = Number.isFinite(+po.left) ? +po.left / 4 : LONG_MS;
		const ms = Math.min(LONG_MS, room);
		if (!(ms >= 1000)) return null;
		longTried.add(sk); longCalls++;
		ST.longCalls = longCalls;
		const t0 = Date.now();
		const res = search(a, Object.assign({}, so, { ms, maxExpand: LONG_EXPAND, noGain: !LONG_GAIN }), new Set(), null);
		ST.longMs = (ST.longMs || 0) + (Date.now() - t0);
		// (a search that ran out of nodes in under a second is no long call: it does not count to LONG_MAX (The Memory Game:
		// 4 such searches, 3-7 ms each, every trophy plan through a relaxation-only edge, used the compile's 4 calls))
		if (Date.now() - t0 < 1000) { longCalls--; ST.longShort = (ST.longShort || 0) + 1; }
		const node = res.found;
		if (process.env.EEAT_LONG_DBG === '1') console.error(`[long] ${sk.slice(0, 40)} ms ${Date.now() - t0} expanded ${res.expanded} found ${node ? Math.round(node.g) : '-'}`);
		if (!node || !(node.g < PENALTY)) {
			if (LONG_NOWALL && ST.estWalls > 0) {
				const cls = a.S.key + '|' + a.cls;
				const r = noWalls(() => {
					const t1 = Date.now();
					const res2 = search(a, Object.assign({}, so, { ms: Math.max(1000, ms - (t1 - t0)), maxExpand: LONG_EXPAND, noGain: !LONG_GAIN }), new Set(), null);
					const n2 = res2.found;
					if (process.env.EEAT_LONG_DBG === '1') console.error(`[long nowall] ${sk.slice(0, 40)} ms ${Date.now() - t1} expanded ${res2.expanded} found ${n2 ? Math.round(n2.g) : '-'}`);
					if (!n2 || !(n2.g < PENALTY)) return null;
					const p = mk(n2, `long: a trophy plan with the est walls lifted (${res2.expanded} nodes)`);
					if (!p || (facts && facts.rungOf(p.steps[0].edge, cls) >= 3)) return null;   // (its step at its next rung: the ladder; not at the last one)
					const path2 = [];
					for (let n = n2; n && n.e; n = n.parent) path2.push(n);
					path2.reverse();
					longPaths.push({ keys: [a.S.key].concat(path2.map((n) => n.S.key)), edges: path2.map((n) => n.e.edge), nowall: true });
					return p;
				});
				if (r) { ST.longFound = (ST.longFound || 0) + 1; ST.longNoWall = (ST.longNoWall || 0) + 1; return r; }
			}
			ST.longNone = (ST.longNone || 0) + 1; return null;
		}
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push(n);
		path.reverse();
		longPaths.push({ keys: [a.S.key].concat(path.map((n) => n.S.key)), edges: path.map((n) => n.e.edge) });
		ST.longFound = (ST.longFound || 0) + 1;
		return mk(node, `long: a trophy plan from a ${(ms / 1000).toFixed(0)}-s search (${res.expanded} nodes${LONG_GAIN ? '' : ', no gain bonus'})`);
	}
	const BYPASS = process.env.EEAT_PLAN_BYPASS !== undefined ? Math.max(0, +process.env.EEAT_PLAN_BYPASS | 0) : 0;
	const BYPASS_MAX = +process.env.EEAT_BYPASS_MAX || 4;
	function bypassPlan(a, plans, so, deadline) {
		const cls = a.S.key + '|' + a.cls;
		const firstOf = (p) => (p && p.steps ? p.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p.steps[0] : null);
		const failed = (s) => !!s && /^trig:/.test(String(s.edge)) && facts.rungOf(s.edge, cls) >= BYPASS;
		const s0 = firstOf(plans[0]);
		if (!failed(s0)) return null;
		const ban = new Set();
		for (const p of plans) { const s = firstOf(p); if (failed(s)) ban.add(String(s.edge)); }
		const end = Math.max(Date.now() + 50, deadline + so.ms / 2);
		for (let it = 0; it < BYPASS_MAX && Date.now() < end; it++) {
			const res = search(a, Object.assign({}, so, { ms: Math.max(50, (end - Date.now()) / Math.max(1, BYPASS_MAX - it)) }), new Set(), ban);
			const node = res.found;
			if (!node) { ST.bypassNone = (ST.bypassNone || 0) + 1; return null; }
			// (a bypass only along est walks: a plan with an edge only the relaxation reaches (the PENALTY) is no way around;
			// Buuwuu's Stronghold's first bypass plans cost 1,005,570 and 3,010,798)
			if (!(node.g < PENALTY)) { ST.bypassPen = (ST.bypassPen || 0) + 1; return null; }
			const steps = stepsOf(a, node);
			if (!steps.length) return null;
			const f = firstOf({ steps });
			// (the bypass's own first trigger failed R rungs too: banned as well, the search again)
			if (failed(f) && !ban.has(String(f.edge)) && ban.size < BYPASS_MAX) { ban.add(String(f.edge)); continue; }
			if (failed(f)) return null;
			ST.bypassPlans = (ST.bypassPlans || 0) + 1;
			return { id: `p${ST.plans}.b`, steps, cost: Math.round(node.g), lb: node.gl, partial: false, why: `bypass: the trophy without ${ban.size} trigger(s) that failed rung ${BYPASS - 1}+`, bypass: true };
		}
		return null;
	}
	function crumbOnWay(a, s0, cands) {
		const tgt = s0 && s0.waypoint && s0.waypoint.tiles;
		if (!tgt || !tgt.length) return cands;
		const dA = model.dist(a.S, a.pos, 'now', a.base);
		let D = INF;
		for (const t of tgt) if (dA[t] < D) D = dA[t];
		if (!(D < INF)) return cands;
		const slack = Math.max(CRUMB_DETOUR_MIN, CRUMB_DETOUR_F * D);
		return cands.filter((e) => {
			const live = e.live || [];
			let d1 = INF;
			for (const t of live) if (dA[t] < d1) d1 = dA[t];
			if (!(d1 < INF)) return false;
			const dX = model.dist(a.S, { id: 'crumb' + e.X.id, tiles: live.slice(), extra: 0 }, 'now', a.base);
			let d2 = INF;
			for (const t of tgt) if (dX[t] < d2) d2 = dX[t];
			const ok = d2 < INF && d1 + d2 - D <= slack;
			if (!ok) ST.crumbDetours = (ST.crumbDetours || 0) + 1;
			return ok;
		});
	}
	function crumbPlan(a, plans) {
		const p0 = plans.find((p) => !p.near) || plans[0];
		if (!p0 || !p0.steps || !p0.steps.length) return [];
		if (CRUMB_DETOUR_F > 0 && /^(death|die):/.test(String(p0.steps[0].edge))) return [];
		const s0 = p0.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p0.steps[0];
		const lb0 = Number.isFinite(+s0.lb) ? +s0.lb : Infinity;
		if (!(lb0 >= CRUMB_LEGMIN)) return [];
		const cls = a.S.key + '|' + a.cls;
		// (only once that leg has failed CRUMB_AFTER rungs from this anchor's class: a first leg the executor finds at its
		// first rung (the compiled levels' direct legs) keeps both workers; EEAT_CRUMB_AFTER=0: at once)
		if (CRUMB_AFTER > 0 && facts && facts.rungOf(s0.edge, cls) < CRUMB_AFTER) return [];
		const es = edgesOf(a.S, a.pos, a.base, 'plan', true, cls, a, crumbs);
		// (a crumb past the est walk's CEGAR cuts is kept: the cuts come from the long leg's failures, and a way around its
		// deceptive field is what a crumb is for; its lb is the relaxation's, still admissible)
		let cands = es.filter((e) => e.X && e.X.crumb && !e.viaDeath && e.lb < CRUMB_F * lb0)
			.sort((x, y) => (facts ? x.lb * (1 + facts.rungOf(x.edge, cls)) - y.lb * (1 + facts.rungOf(y.edge, cls)) : 0) || x.lb - y.lb || x.est - y.est);
		if (CRUMB_DETOUR_F > 0 && cands.length) cands = crumbOnWay(a, s0, cands);
		if (process.env.EEAT_CRUMB_DBG === '1') console.error(`crumbPlan: lb0 ${lb0} crumb edges ${es.length} cands ${cands.length}: ${es.slice(0, 6).map((e) => `${e.X && e.X.label} lb ${e.lb} pen '${e.pen}' relax ${e.relaxOnly} r ${facts ? facts.rungOf(e.edge, cls) : '-'}`).join('; ')}`);
		const out = [];
		const root = { S: a.S, pos: a.pos, e: null, parent: null };
		for (const e of cands) {
			if (out.length >= CRUMB_K) break;
			const steps = stepsOf(a, { S: e.S2, pos: e.pos2, e, parent: root });
			if (!steps.length) continue;
			const cp = { id: `p${ST.plans}.c${out.length}`, steps, cost: p0.cost, lb: e.lb + hLb(e.pos2), partial: true, why: `crumb: a nearest breadcrumb before '${s0.waypoint && s0.waypoint.label}' (lb ${lb0})`, near: true, crumb: true };
			if (CRUMB_DEMOTE > 0) cp.crumbRung = facts ? facts.rungOf(e.edge, cls) : 0;
			out.push(cp);
		}
		ST.crumbPlans = (ST.crumbPlans || 0) + out.length;
		return out;
	}
	// ---------------------------------------------------------------- CEGAR
	/** the value of the feature gate tile i reads that opens it */
	function openValue(i, S) {
		const A = model.A, k = A.gateFeat[i], pol = A.gatePol[i], p = A.gateParam[i];
		// (THE DEATH DOOR'S NEED, OPT-IN EEAT_NEEDS_DEATHS=1: a death door (1011) opens at its number of deaths (the model's
		// S.feats.deaths, capped at the level's highest death door / gate number): that number is the value the step needs.
		// Tutorial 2's switch 0 behind the door (264,28): every deaths-0 anchor class tried it at rungs 0-3 (closest 61.2 tiles
		// at the door, ~66 worker-s a class) and the CEGAR learned nothing, the door being an 'open' gate to steer.js)
		if (k === 'open' && NEEDS_DEATHS && model.L.fg[i] === 1011) return model.L.lookup0[i];
		if (!k || k === 'open' || k === 'time' || k === 'static') return null;
		if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'crown') return pol === 1 ? 1 : 0;
		if (k === 'team') return pol === 1 ? p : null;
		if (k === 'coins' || k === 'bcoins') return pol === 1 ? p : null;
		return null;
	}
	/** the est walk's path from pos to the tiles under S (tiles, the start first; null: none) */
	function estPath(S, pos, tiles, base) {
		const d = model.dist(S, pos, 'est', base);
		const m = model.passMask(S, 'est', base);
		let v = -1, best = INF;
		for (const t of tiles) if (d[t] < best) { best = d[t]; v = t; }
		if (v < 0) return null;
		const srcOf = new Map();
		for (const [p, ex] of model.A.portalExits) for (const e of ex) { if (!srcOf.has(e)) srcOf.set(e, []); srcOf.get(e).push(p); }
		const path = [v];
		for (let k = 0; k < 100000 && d[v] > 0; k++) {
			let u = -1;
			for (const p of srcOf.get(v) || []) {
				const x = p % W, y = (p / W) | 0;
				for (let dy = -1; dy <= 1 && u < 0; dy++) for (let dx = -1; dx <= 1 && u < 0; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && d[ny * W + nx] === d[v]) u = ny * W + nx;
				}
				if (u >= 0) { path.push(p); break; }
			}
			if (u < 0) {
				const x = v % W, y = (v / W) | 0;
				for (let dy = -1; dy <= 1 && u < 0; dy++) for (let dx = -1; dx <= 1 && u < 0; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && m[ny * W + nx] && d[ny * W + nx] === d[v] - 1) u = ny * W + nx;
				}
			}
			if (u < 0) break;
			path.push(u); v = u;
		}
		return path.reverse();
	}
	/** the est path's tiles just past the point nearest the closest approach c (4 tiles, no trigger): the cut */
	function cutPast(S, pos, tiles, base, c) {
		const path = estPath(S, pos, tiles, base);
		if (!path || path.length < 3) return null;
		const cx = c % W, cy = (c / W) | 0;
		let bi = 0, bd = Infinity;
		path.forEach((t, i) => { const dd = Math.max(Math.abs(t % W - cx), Math.abs(((t / W) | 0) - cy)); if (dd < bd) { bd = dd; bi = i; } });
		const cut = [];
		for (let i = bi + 1; i < path.length - 1 && cut.length < 4; i++) if (model.trigOf[path[i]] < 0) cut.push(path[i]);
		return cut.length ? cut : null;
	}
	/**
	 * learn(step, result, anchor) -> Fact[]: at least one whenever !result.ok (the facts' version bumps with each).
	 */
	function learn(step, result, anchor) {
		ST.learned++;
		const out = [];
		if (!facts) return out;
		const edge = step.edge, cls = step.nodeClass;
		const a = anchor ? anchorOf(anchor) : null;
		if (result && result.ok) {
			const arr = result.arrivals && result.arrivals[0];
			const ticks = arr && a ? Math.max(0, arr.tick - a.tick) : (result.ticks || 0);
			out.push(facts.add({ kind: 'ok', edge, nodeClass: cls, ticks, lb: step.lb || 0 }));
			if (a && step.waypoint && step.waypoint.tiles) {
				const d = model.pairSteps(a.S, a.pos, step.waypoint.tiles, 'est', a.base);
				if (d > 0 && d < INF && ticks > 0) paceSamples.push(ticks / d);
			}
			return out;
		}
		const fail = (result && result.fail) || { why: 'budget' };
		if (TR_EXH && fail.why === 'exhausted' && model.canDie && !/~w$/.test(edge)) exhausted.add(edge + '\u0001' + cls);
		if (TR_DBG) process.stderr.write(`[tricks learn] ${edge} why ${fail.why} canDie ${model.canDie} cls ${String(cls).slice(-24)}\n`);
		const sKey = a ? proofKey(a.S, a.pos) : (cls || '').split('|')[0];
		if (fail.why === 'proof') out.push(facts.add({ kind: 'proof', edge, sKey }));
		for (const b of fail.blockedBy || []) {
			if (!a || b.tile === undefined) continue;
			const f = b.feat || model.A.gateFeat[b.tile];
			const v = openValue(b.tile, a.S);
			if (!f || v === null || v === undefined || a.S.feats[f] === v) continue;
			out.push(facts.add({ kind: 'needs', edge, nodeClass: cls, feat: f, value: v }));
		}
		// (THE DEATH DOOR'S NEED, EEAT_NEEDS_DEATHS=1, planner side: a shut death door within 2 tiles of the closest tile
		// in the anchor's state; the executor's blockedBy needs the all-open field, which a step whose window is used up
		// does not build (blockedBy [] in the compiles: Tutorial 2's switch 0 from deaths-0 anchors, closest 61.2 at the door))
		if (NEEDS_DEATHS && a && a.S.feats && a.S.feats.deaths !== undefined && fail.closest && fail.closest.tile !== undefined && fail.closest.tile !== null && fail.closest.tile >= 0) {
			const cx = fail.closest.tile % W, cy = (fail.closest.tile / W) | 0, d0 = a.S.feats.deaths | 0, had = facts.needsOf(edge, cls);
			let need = 0;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				const x = cx + dx, y = cy + dy;
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const t = y * W + x;
				if (model.L.fg[t] === 1011 && model.L.lookup0[t] > d0 && (need === 0 || model.L.lookup0[t] < need)) need = model.L.lookup0[t];
			}
			if (need > 0 && !had.some((n) => n.feat === 'deaths' && n.value === need)) out.push(facts.add({ kind: 'needs', edge, nodeClass: cls, feat: 'deaths', value: need }));
		}
		const rung = facts.rungOf(edge, cls);
		// (the est walk's path to the waypoint, cut just past the point nearest the closest approach: the next plans'
		// est walk goes another way there, CEGAR's generalization over every edge through that corridor)
		// (a STONE is optional: its failure is no counterexample to the corridor (a cut there walled the est walk's way to
		// every later target: Machu Picchu's stones plan fell back to the penalised trophy leg after two stone failures);
		// the stone is blocked from its second rung on instead (EEAT_PLAN_STONE_RUNGS, 2: the rungs a stone gets). EEAT_PLAN_STONE_CUT=1: the cut as for any trigger)
		const isStone = STONES && stones.length && step.waypoint && step.waypoint.trig !== undefined && stoneIds.has(step.waypoint.trig) && process.env.EEAT_PLAN_STONE_CUT !== '1';
		// (EEAT_FIELD_MEMO=1 (executor.js): a closest of unknown distance (the call had no goal field) cuts nothing)
		let cut = null, noWall = false;
		if (CUT_PROG && a && fail.why !== 'exhausted' && fail.closest && fail.closest.tile !== undefined && fail.closest.tile !== null) {
			// (THE PROGRESS RULE: a budget failure whose closest approach is less than CUT_PROG_F of the est walk's way from
			// the anchor to the waypoint is no counterexample: see CUT_PROG)
			const tiles = step.waypoint && (step.waypoint.kind !== 'trophy' || TCOMP) && step.waypoint.tiles && step.waypoint.tiles.length ? step.waypoint.tiles : trophyTiles;
			const dC = model.pairSteps(a.S, a.pos, [fail.closest.tile], 'est', a.base), dT = model.pairSteps(a.S, a.pos, tiles, 'est', a.base);
			if (dT > 0 && dT < INF && !(dC >= CUT_PROG_F * dT)) { noWall = true; ST.cutSkipped = (ST.cutSkipped || 0) + 1; }
		}
		if (!isStone && !noWall && a && fail.closest && fail.closest.tile !== undefined && fail.closest.tile !== null && !(process.env.EEAT_FIELD_MEMO === '1' && !(fail.closest.dist >= 0)) && (rung + 1 >= 2 || fail.why === 'exhausted')) {
			const tiles = step.waypoint && (step.waypoint.kind !== 'trophy' || TCOMP) && step.waypoint.tiles && step.waypoint.tiles.length ? step.waypoint.tiles : trophyTiles;
			cut = cutPast(a.S, a.pos, tiles, a.base, fail.closest.tile);
		}
		out.push(facts.add(Object.assign({ kind: 'fail', edge, nodeClass: cls, rung, why: fail.why || 'budget', closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [], cut }, noWall ? { noWall: true } : {}, SC_CLASS && a ? { sk: a.S.key } : {})));
		// (THE TROPHY'S COMPONENTS, TCOMP: a near miss beside one trophy component at rung >= TCOMP_RUNG rules it out from
		// this abstract state while another component is still a target)
		if (TCOMP && a && model.trophies.length > 1 && step.waypoint && step.waypoint.kind === 'trophy' && rung >= TCOMP_RUNG && fail.why !== 'stopped'
			&& fail.closest && fail.closest.tile !== undefined && fail.closest.tile !== null && fail.closest.tile >= 0) {
			const cur = step.waypoint.tiles && step.waypoint.tiles.length ? new Set(Array.from(step.waypoint.tiles)) : null;
			const dropped = facts.tdropOf(a.S.key);
			const live = [];
			model.trophies.forEach((X, i) => { if (!dropped.includes(i) && (!cur || X.tiles.some((t) => cur.has(t)))) live.push(i); });
			if (live.length >= 2) {
				const cx = fail.closest.tile % W, cy = (fail.closest.tile / W) | 0;
				let bi = -1, bd = Infinity;
				for (const i of live) for (const t of model.trophies[i].tiles) { const d = Math.max(Math.abs(t % W - cx), Math.abs(((t / W) | 0) - cy)); if (d < bd) { bd = d; bi = i; } }
				if (bi >= 0 && bd <= TCOMP_NEAR) {
					out.push(facts.add({ kind: 'tdrop', sKey: a.S.key, comp: bi })); ST.tdrops = (ST.tdrops || 0) + 1;
					// (a component dropped from TCOMP_GLOBAL abstract states is dropped from every state: a decoy's seal does not
					// depend on the coins held; Ice Cream Expedition's (5,177) near-missed again at rungs 1-2 from every new coin
					// state, 5 drops in 300 s, each state's own; 0 = per state only)
					if (TCOMP_GLOBAL > 0 && facts.tdropKeys(bi) >= TCOMP_GLOBAL && !facts.tdropOf('*').includes(bi)) out.push(facts.add({ kind: 'tdrop', sKey: '*', comp: bi }));
				}
			}
		}
		if (rung + 1 >= facts.RUNG_MAX || (isStone && rung + 1 >= STONE_RUNGS)) out.push(facts.add({ kind: 'block', edge, nodeClass: cls }));
		return out;
	}
	// ---------------------------------------------------------------- the truth checker's price of an order
	/**
	 * costOf(order, anchor) -> {lb, est, feasible, why, legs}: the order's legs priced like the plans' (lb: sound for
	 * any real route that touches the triggers in this order, the trophy last). order: trigger ids (or 'trig:<id>').
	 */
	function costOf(order, anchor) {
		ST.costOf++;
		const a = anchorOf(anchor);
		let S = a.S, pos = a.pos, lb = 0, est = 0, feasible = true, why = 'ok';
		const legs = [];
		const P = pace();
		const ids = order.map((x) => (typeof x === 'string' ? +String(x).replace(/^trig:/, '') : +x));
		for (let i = 0; i <= ids.length; i++) {
			const X = i < ids.length ? model.triggers[ids[i]] : null;
			if (i < ids.length && !X) { feasible = false; why = `no trigger ${ids[i]}`; break; }
			const tiles = X ? X.tiles : trophyTiles;
			const l = legLb(S, pos, tiles, a.base);
			const steps = model.pairInfo(S, pos, tiles, 'est', a.base).steps;
			if (!Number.isFinite(l)) { feasible = false; why = `leg ${i} to ${X ? X.label : 'the trophy'} unreachable in the model`; legs.push({ to: X ? X.id : 'trophy', lb: Infinity }); break; }
			lb += l; est += Math.max(l, steps < INF ? steps * P : l);
			legs.push({ to: X ? X.id : 'trophy', lb: l });
			if (X) { const tr = model.touch(S, X); pos = posOf(X, S, tr.S2); S = tr.S2; }
		}
		if (a.idle && feasible) lb = Math.max(0, lb - 2);
		return { lb, est: Math.round(est), feasible, why, legs };
	}
	function explain() {
		if (!lastPlans.length) return `no plan (${lastWhy || 'none yet'})`;
		const p = lastPlans[0];
		return `${p.partial ? 'PARTIAL ' : ''}plan ${p.id}: est ${p.cost} ticks, lb ${p.lb}: ` + p.steps.map((s) => s.waypoint.label + (s.rung ? `[r${s.rung}]` : '')).join(' -> ');
	}
	const stats = () => Object.assign({}, ST, { pace: pace(), model: model.stats() });
	/** the floors' version: bumps when an async floor probe adds floors (plans made before it priced the trophy edge without) */
	const floorVersion = () => floorVer;
	return { plan, learn, lowerBound, costOf, explain, stats, floorVersion, _edgesOf: edgesOf, _hLb: hLb, _anchorOf: anchorOf, _zoneNeed: zoneNeed, _hLM: hLM, _hSteps: hSteps };
}

module.exports = { createPlanner, PACE0 };
