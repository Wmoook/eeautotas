'use strict';
// THE PLANNER's shared contract (n4plan, 2026-09-29, the architect): UNDERSTAND -> PLAN -> EXECUTE -> REFINE.
// Every part imports this file; no builder edits it (a change goes through the integration step). It holds the shapes
// the parts exchange and the few helpers they must agree on bit for bit: the masks' text form, a replay to a state, the
// WAYPOINT's goal test, the ARRIVAL record, the diverse pick of arrivals, the level "as the doors stand now" and the goal
// field on it. Nothing here searches or prunes; every route is still replayed by the engine (common.js evaluate).
//
// CONTRACT v2: THE COMPILER (the architect, 2026-09-29 20:45; the user: "it shouldnt search at all, no heatmap or any gpu
// burst ... just a program that compiles .eelvl into .eetas" and "it should be able to find the OPTIMAL ALWAYS").
//   .eelvl -> parse -> MODEL -> BOUNDS -> PLAN -> MOVES -> VERIFY -> POLISH -> .eetas + a report (run ticks, the
//   admissible lower bound, the gap, per leg: ticks / bound / proven / tool). No part calls goexplore.js, bursts.js,
//   heat.js or an eegpu tool (explore / beam / roll / search). Every emitted piece is masks replayed by the engine.
// Files (one owner each; this file and truthset.js change only at the integration):
//   planner    src/plan/model.js facts.js planner.js; test/planmodel.js test/planplanner.js
//   executor   src/plan/executor.js exact.js legs.js polish.js execworker.js; test/planexec.js
//   primitives src/plan/bounds.js prims.js navgraph.js tables.js primworker.js; test/planbounds.js test/planprims.js
//   strategy   src/plan/strategy.js truth.js, src/plan.js, src/compile.js, the hunks of src/editor.js, src/server.js,
//              src/app/editor.html (Find a route's 'plan' behind EEAT_PLAN=1 / body plan: true; the COMPILE action);
//              test/planstrategy.js test/planmock.js test/plancompile.js
// Interfaces (a missing optional part is skipped with a warning, never a crash):
//   model   = await compileModel(L, {file}) -> {W, H, N, A (steer.js analyze(L)), feats: string[] (Expect keys some gate
//             reads), init {feat: value}, triggers [{id, kind, tiles, feat, param, label}], gates [{id, tiles, feat, pol,
//             param}], stateOf(sim) -> S {key, feats, gain}, levelOf(S) -> Lc (gates as S holds them), regionOf(S, tile),
//             reachable(S, fromTile | sim, tiles) -> {cost (tiles, -1 = RCH3 proof), proof}}
//   facts   = createFacts(o) -> {version(), add(fact), reset({keepProofs}), toJSON()}
//   planner = createPlanner(model, facts, {bounds}) -> {plan(anchor, {k, depth, epoch}) -> Plan[] (.why when empty),
//             learn(step, result, anchor) -> Fact[] (>= 1 whenever !result.ok), lowerBound(anchor) -> {ticks, complete},
//             costOf(order, anchor) -> {lb, est, feasible, why}, explain(), stats()}
//             anchor {arrival, arrivals, S, key}; Plan {id, steps, cost (est ticks), lb (admissible ticks to the trophy),
//             partial, why}; Step {n, edge, nodeClass, rung, waypoint, estTicks, lb}
//   bounds  = createBounds(L, {model}) -> {vmax, field(goalTiles, Lc?) -> Float32Array(N) ticks (Infinity: no way),
//             at(field, sim) -> ticks, pair(fromTiles, toTiles, Lc?) -> ticks, leg(sim, goal) -> ticks}: ADMISSIBLE
//   prims   = await createPrims(L, {file, bounds, model, workers}) -> {support(sim), expand(arrival, o) -> Edge[],
//             route(starts, goal, budget, o) -> NavResult, learn(fromArrival, masks, toArrival), stats(), close()}
//             Edge {macro, masks, ticks, to: Arrival, event}; NavResult {ok, arrivals, best {masks, ticks} | null, lb,
//             proven, expanded, sims, why, closest}
//   exec    = await createExecutor(L, {file, workers, prims, bounds, model, RM, emit}) -> {reach(starts, wp, budget) ->
//             Promise<StepResult>, polish(masks, o) -> Promise<{masks, runTicks, saved, legs}>, close()}
//   compile = await require('./strategy.js').compile(L, opts, emit) -> {ok, masks, runTicks, lb, gap, legs, stages, why}
// v2 additions to the shapes below: Waypoint.beforeTick (optional: the goal counts only at a tick <= it, e.g. a key's
//   door within KEY_TICKS 500); StepResult.legs [{start (index into starts), ticks, lb, proven, tool}], StepResult.lb;
//   StepResult.tool 'prims' | 'exact' | 'leg' | null in the compiler; Budget.deadline (epoch ms). The ground truth for
//   every part's offline checks: src/plan/truthset.js (known routes, their trigger order).
//
// SHAPES (plain objects; tiles are indices y * W + x of the level's grid, W = L.width)
//   Masks: Uint8Array of input masks (1 jump, 2 left, 4 right, 8 up, 16 down), from the level start (sim.reset()).
//     Text form: one char '0' + mask per tick ('0'..'O'), the form of .eetas files, events and stdin lines.
//   Waypoint: where a plan step must bring the ball (goalOf below gives its exact test):
//     { kind: 'trigger', tiles: number[], trig: number, expect: Expect|null, label: string }  the centre tile in `tiles`
//        (one trigger: a component of touching tiles of one block, the model's trigger `trig`) and, if given, `expect` holds
//     { kind: 'region', tiles: number[], expect: Expect|null, label }   the centre tile in `tiles` (a region, a portal's
//        exit tiles, a door's far side) and, if given, `expect` holds
//     A death step (a respawn at a checkpoint / the next spawn, a death count a death door or gate reads): kind 'region',
//        tiles = the respawn tile(s), expect {feat: 'deaths', value: d + 1}, allowDeath: true (playTo / the searches keep
//        the dying runs for this step only)
//     every test also needs the ball alive (not in its 54 dead ticks)
//     { kind: 'trophy', label }                    the level is complete (sim.has_silver_crown)
//   Expect: { feat: string, value: number }: featValue(sim, feat) === value after the touch. feat keys (steer.js names,
//     plus a few): 'key0'..'key5' (red green blue cyan magenta yellow), 'psw:<id>', 'osw:<id>', 'team', 'prot', 'coins',
//     'bcoins', 'crown', 'silver', 'deaths', 'cp' (the checkpoint tile, -1 none), 'fx' (0 plain physics, 1 an effect on),
//     'coin@<tile>' (1 when that coin tile is collected)
//   Arrival: a REAL state (replayed by the engine from the level start): { masks, tick, snap (sim.snapshot(); valid for
//     EESim instances of the same level object only: across threads send masks), tile, px, py, vx, vy, onGround, jumps,
//     room (goexplore.js roomOf key, 0 without RM), desc, hash (sim.stateHash()), dead, finished }
//   StepResult (executor -> planner / strategy): { ok, arrivals: Arrival[] (ok: 1..k, each verified by playTo + the goal
//     test), tool: 'prims'|'leg'|'gpu'|'beam'|null, ms, sims, fail: null | FailReport }
//   FailReport: { why: 'budget'|'exhausted'|'proof'|'dies'|'stopped', closest: null | {masks, tile, dist (tiles, goal
//     field), vx, vy}, touched: [{tile, kind, tick}] (triggers the nearest attempts touched on the way), blockedBy: [{tile,
//     feat}] (shut doors / gates within 2 tiles of the closest approach), level: number (the budget rung tried) }
//   Budget: { ms, level (the rung: 0, 1, 2, ...), k (arrivals wanted), stop (() => bool, optional) }
const E = require('../eesim.js');
const RF = require('../reach.js');

const VERSION = 2;
const F_SOLID = 1, F_DOOR = 16;
// doors whose state the clock (time doors), the death count (death doors / gates) or a key's expiry can change without
// a touch: levelNow keeps their door block (open in the reach field: the optimistic side)
const CLOCK_DOORS = new Set([156, 157, 1011, 1012]);
const KEY_DOOR_BIT = new Map([[23, 1], [24, 2], [25, 4], [26, 1], [27, 2], [28, 4], [1005, 8], [1006, 16], [1007, 32], [1008, 8], [1009, 16], [1010, 32]]);

// ---------------------------------------------------------------- masks
/** masks -> text ('0' + mask per tick) */
function strOf(masks) {
	const b = Buffer.allocUnsafe(masks.length);
	for (let i = 0; i < masks.length; i++) b[i] = 48 + (masks[i] & 31);
	return b.toString('latin1');
}
/** text -> masks */
function masksOf(s) {
	s = String(s);
	const m = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) m[i] = (s.charCodeAt(i) - 48) & 31;
	return m;
}
/** a + b as one Masks */
function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }

// ---------------------------------------------------------------- levels and replays
/** a level from an .eelvl file, a level JSON file, or a job / level id (legsearch.js levelOf, common.js loadLevel) */
function loadLevelFile(file) {
	const fs = require('fs');
	if (/\.(eelvl|json)$/i.test(String(file)) || fs.existsSync(String(file))) return require('../legsearch.js').levelOf({ file: String(file) });
	return require('../common.js').loadLevel(String(file));
}
/** the centre tile of the ball (options.js / bursts.js rule), clamped into the level */
function tileOf(sim, W, H) {
	let x = Math.trunc(sim.px + 8) >> 4, y = Math.trunc(sim.py + 8) >> 4;
	if (x < 0) x = 0; else if (x >= W) x = W - 1;
	if (y < 0) y = 0; else if (y >= H) y = H - 1;
	return y * W + x;
}
/**
 * the tile the last tick's touch read (eesim.js _touchBlock: the centre cell at the tick's start, after the half-block
 * remap: _pastx / _pasty), -1 outside the level: every trigger (coin, switch, key, effect, checkpoint) fires there
 */
function touchedTile(sim, W, H) {
	const x = sim._pastx, y = sim._pasty;
	return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1;
}
/**
 * playTo(L, masks, o) -> {sim, tick, dead, finished, goalAt}: the masks from the level start in a fresh EESim.
 * dead: the first tick the ball was dead (-1 never; the replay stops there unless o.allowDeath); finished: the first
 * tick with the level complete (-1 never); goalAt: the first tick o.goal.test(sim) held (-1 never; o.goal from goalOf).
 * o.from: {snap, tick} a snapshot of this level's sim after `tick` of the same masks (skips replaying those ticks).
 */
function playTo(L, masks, o = {}) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let t0 = 0;
	if (o.from && o.from.snap && o.from.tick <= masks.length) { sim.restore(o.from.snap); t0 = o.from.tick; }
	let dead = -1, finished = -1, goalAt = -1;
	const goal = o.goal || null;
	for (let t = t0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		if (sim.is_dead && dead < 0) { dead = t + 1; if (!o.allowDeath) break; }
		if (finished < 0 && sim.has_silver_crown) finished = t + 1;
		if (goal !== null && goalAt < 0 && goal.test(sim)) goalAt = t + 1;
	}
	return { sim, tick: sim.ticks(), dead, finished, goalAt };
}

// ---------------------------------------------------------------- features and the waypoint's goal test
/** a feature's value in a real state (the Expect keys above; NaN for an unknown key) */
function featValue(sim, feat) {
	if (feat.startsWith('key')) return (sim._keysMask >> +feat.slice(3)) & 1;
	if (feat.startsWith('psw:')) return sim._switches.get(+feat.slice(4)) === true ? 1 : 0;
	if (feat.startsWith('osw:')) return sim._oswitches.get(+feat.slice(4)) === true ? 1 : 0;
	if (feat.startsWith('coin@')) { const t = +feat.slice(5), W = sim.width; return sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }
	switch (feat) {
		case 'team': return sim.team;
		case 'prot': return sim.is_invulnerable ? 1 : 0;
		case 'coins': return sim.coins;
		case 'bcoins': return sim.blue_coins;
		case 'crown': return sim._collide_crown ? 1 : 0;
		case 'silver': return sim._collide_silver_crown ? 1 : 0;
		case 'deaths': return sim.deaths;
		case 'cp': return sim.checkpoint.x < 0 ? -1 : sim.checkpoint.y * sim.width + sim.checkpoint.x;
		case 'fx': return !sim.has_levitation && sim.flip_gravity === 0 && sim.max_jumps === 1 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity ? 0 : 1;
		default: return NaN;
	}
}
/**
 * featGetter(feat) -> (sim) => featValue(sim, feat): the same value, the feature's key parsed ONCE (featValue parses
 * the string on every call: the primitives read every feature on every simulated tick, 12.5% of a leg's time in it)
 */
function featGetter(feat) {
	if (feat.startsWith('key')) { const b = +feat.slice(3); return (sim) => (sim._keysMask >> b) & 1; }
	if (feat.startsWith('psw:')) { const id = +feat.slice(4); return (sim) => (sim._switches.get(id) === true ? 1 : 0); }
	if (feat.startsWith('osw:')) { const id = +feat.slice(4); return (sim) => (sim._oswitches.get(id) === true ? 1 : 0); }
	if (feat.startsWith('coin@')) { const t = +feat.slice(5); return (sim) => { const W = sim.width; return sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }; }
	switch (feat) {
		case 'team': return (sim) => sim.team;
		case 'prot': return (sim) => (sim.is_invulnerable ? 1 : 0);
		case 'coins': return (sim) => sim.coins;
		case 'bcoins': return (sim) => sim.blue_coins;
		case 'crown': return (sim) => (sim._collide_crown ? 1 : 0);
		case 'silver': return (sim) => (sim._collide_silver_crown ? 1 : 0);
		case 'deaths': return (sim) => sim.deaths;
		case 'cp': return (sim) => (sim.checkpoint.x < 0 ? -1 : sim.checkpoint.y * sim.width + sim.checkpoint.x);
		case 'fx': return (sim) => (!sim.has_levitation && sim.flip_gravity === 0 && sim.max_jumps === 1 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity ? 0 : 1);
		default: return () => NaN;
	}
}
/**
 * goalOf(L, wp) -> {kind, tiles: Int32Array (the goal tiles for a goal field; for the trophy the level's trophies),
 * mask: Uint8Array(N) | null, test(sim) -> bool, allowDeath (the step may die on its way: playTo(..., {allowDeath}))}:
 * THE success rule of a waypoint, the same in every part (the primitives' A*, the leg search, the GPU finds' replay
 * check, the planner's truth scoring).
 */
function goalOf(L, wp) {
	const W = L.width, H = L.height, N = W * H;
	if (wp.kind === 'trophy') {
		const tr = [];
		for (let i = 0; i < N; i++) if (L.fg[i] === 121) tr.push(i);
		return { kind: 'trophy', tiles: Int32Array.from(tr), mask: null, test: (sim) => !!sim.has_silver_crown, allowDeath: !!wp.allowDeath };
	}
	const mask = new Uint8Array(N);
	for (const t of wp.tiles) if (t >= 0 && t < N) mask[t] = 1;
	const ex = wp.expect ? wp.expect : null;
	// a trigger's goal: the Expect holds and the ball's centre is on the trigger now OR the last tick's touch read it
	// (touchedTile): the engine touches the centre cell at the tick's START and then moves, so a ball that crosses a coin /
	// switch / checkpoint in one tick (a boost's 16 px/tick, any fast pass) has left the tile by the time the feature shows
	// the touch, and "on the tile with the feature changed" never holds (the leg searches' "closest 0 tiles" failures)
	// the COUNTS (coins, blue coins, deaths) only grow within a leg: the Expect is the count right after the touch
	// (model.js touch: + 1), so a way that takes another coin first (a coin of another component on the way: the est walk
	// is coin-blind) reaches the target at + 2 and "=== + 1" never held; at least the Expect is the touch's own semantics
	// (a coin: the tile the ball is on or touched last is one of the target's AND its coin is taken: with ">=" the count
	// alone could be another coin's while the ball stands on the target's untaken coin)
	const ge = ex && (ex.feat === 'coins' || ex.feat === 'bcoins' || ex.feat === 'deaths');
	const coin = ex && (ex.feat === 'coins' || ex.feat === 'bcoins');
	const fv = ex ? featGetter(ex.feat) : null;
	const okF = ex ? (ge ? (sim) => fv(sim) >= ex.value : (sim) => fv(sim) === ex.value) : null;
	const onT = coin ? (sim, t) => t >= 0 && mask[t] === 1 && sim.is_coin_collected(t % W, (t / W) | 0) : (sim, t) => t >= 0 && mask[t] === 1;
	const test = ex ? (sim) => !sim.is_dead && okF(sim) && (onT(sim, tileOf(sim, W, H)) || onT(sim, touchedTile(sim, W, H)))
		: (sim) => !sim.is_dead && mask[tileOf(sim, W, H)] === 1;
	// (fieldTiles: the tiles the ordering fields and bounds are built to, when not the goal's own (the executor's skeleton:
	// a sub-level set of the waypoint's field, ordered by the waypoint's own fields, memoized across its sub-legs))
	return { kind: wp.kind, tiles: Int32Array.from(wp.tiles), mask, test, allowDeath: !!wp.allowDeath,
		fieldTiles: wp.fieldTiles && wp.fieldTiles.length ? Int32Array.from(wp.fieldTiles) : null, fieldTouch: !!wp.fieldTouch };
}

// ---------------------------------------------------------------- arrivals
/** the Arrival record of a live sim after `masks` (RM: goexplore.js roomOf(L), optional) */
function arrivalOf(L, sim, masks, RM) {
	return { masks, tick: masks.length, snap: sim.snapshot(), tile: tileOf(sim, L.width, L.height), px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y,
		onGround: !!sim.on_ground, jumps: sim.jump_count, room: RM ? RM.key(sim) : 0, desc: RM ? RM.desc(sim) : '', hash: sim.stateHash(), dead: !!sim.is_dead,
		finished: !!sim.has_silver_crown };
}
/** an arrival's diversity class: the speed (1 px/tick bins, signed), ground contact, jumps left, the room */
const classOf = (a) => `${Math.round(a.vx)},${Math.round(a.vy)},${a.onGround ? 1 : 0},${a.jumps},${a.room}`;
/**
 * pickDiverse(list, k) -> at most k arrivals: the earliest; the fastest (|vx| + |vy|); then one per new diversity class
 * (classOf) in order of arrival; equal states (hash) once. Deterministic.
 */
function pickDiverse(list, k = 4) {
	const byTick = list.slice().sort((a, b) => a.tick - b.tick || (Math.abs(b.vx) + Math.abs(b.vy)) - (Math.abs(a.vx) + Math.abs(a.vy)));
	const out = [], hashes = new Set(), classes = new Set();
	const take = (a) => { if (!a || out.length >= k || hashes.has(a.hash)) return; out.push(a); hashes.add(a.hash); classes.add(classOf(a)); };
	take(byTick[0]);
	let fast = null;
	for (const a of byTick) if (!fast || Math.abs(a.vx) + Math.abs(a.vy) > Math.abs(fast.vx) + Math.abs(fast.vy)) fast = a;
	take(fast);
	for (const a of byTick) if (!classes.has(classOf(a))) take(a);
	return out;
}

// ---------------------------------------------------------------- the level as the doors stand now, the goal field
/**
 * levelNow(L, sim) -> a copy of L (fg only replaced) where every door / gate a touch alone can change stands as it does
 * in `sim` now: open -> 0 (air), shut -> 9 (a plain solid). Kept as door blocks (open in the reach field): time doors,
 * death doors / gates, key doors of an ACTIVE key (it runs out). A reach field on the copy prices a leg that touches no
 * other trigger: its -1 is a proof that the goal cannot be reached while the doors stay as they are now (other triggers
 * on the way are air: touching one is a side effect the executor reports).
 */
function levelNow(L, sim) {
	const W = L.width, N = W * L.height, fg = Int32Array.from(L.fg), fl = L.flags;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id <= 0 || id >= fl.length || (fl[id] & F_DOOR) === 0 || (fl[id] & F_SOLID) === 0) continue;
		if (CLOCK_DOORS.has(id)) continue;
		const kb = KEY_DOOR_BIT.get(id);
		if (kb !== undefined && (sim._keysMask & kb) !== 0) continue;
		if (id === 50) continue;   // (the secret "appear" block: reach.js guideFlags walls it)
		fg[i] = sim.is_tile_solid_now(i % W, (i / W) | 0) ? 9 : 0;
	}
	return Object.assign({}, L, { fg });
}
/** a small hash of a level copy's foreground (the goal fields' memo key) */
function fgHash0(fg) { let h = 0x811c9dc5; for (let i = 0; i < fg.length; i++) { h ^= fg[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ':' + fg.length; }
// (memoized per foreground ARRAY: a level copy's fg is never written after it is built (levelNow, model.levelOf, withWalls
// write a fresh copy first), and the planner's edge pricing hashed the SAME copy on every trigger edge of every expansion
// (bounds.hasField / bounds.field's memo key: O(N) each): Moving Ice Puzzle (400 x 200, 3,346 triggers) spent 34 s of its
// 60-s compile's main thread there while the workers waited on it. The same string; EEAT_FGHASH_CHECK=1 recomputes every
// memoized hash and throws on a difference; EEAT_FGHASH_MEMO=0: none)
const FGH = new WeakMap();
const FGH_ON = process.env.EEAT_FGHASH_MEMO !== '0', FGH_CHECK = process.env.EEAT_FGHASH_CHECK === '1';
function fgHash(fg) {
	if (!FGH_ON || !fg || typeof fg !== 'object') return fgHash0(fg);
	let h = FGH.get(fg);
	if (h === undefined) { h = fgHash0(fg); FGH.set(fg, h); }
	else if (FGH_CHECK && h !== fgHash0(fg)) throw new Error('fgHash: a hashed foreground was written after its hash');
	return h;
}
// (the goal fields' memo: by BYTES (an RCH3 field is ~250 bytes a tile: 10 MB on 200 x 200, 20 MB on 400 x 200), at least
// FIELDS_MIN fields: the planner's path checks (model.reachable), the skeleton's measures and the workers' tiers share it,
// and 8 fields thrashed between them (EEAT_FIELDS_MB, default 256; 0: the old 8)
const FIELDS = new Map(), FIELDS_MIN = 8, FIELDS_CAP = 64;
// THE PLAIN-BALL FIELD (COMPILER DOCTOR 6, n5): reach.js falls back to its gravity-blind walk mode for the WHOLE level when
// any effect tile (jump 417, fly 418, speed 419, low gravity 453, multijump 461, gravity 1517) is anywhere in it: 93 of the
// 228 benchmark levels (4 compiled in night 4's final vs 20 of the other 135; Witch's House has ONE jump effect tile). A
// ball with no effect on is plain physics until it touches an effect tile that changes it: goalField(Lc, tiles, {plainFx:
// true}) (the caller's start state plain: plainOf(sim)) builds the physics field with those tiles as goals at their walk
// cost (reach.js opts.plainFx): a lower bound still (its -1 a proof for the plain ball), the physics ordering elsewhere.
// EEAT_FX_FIELD=1: on; unset / 0: off (the walk as before, byte for byte).
const FX_FIELD = process.env.EEAT_FX_FIELD === '1';
// (a level copy with no effect tile: the field is the physics one anyway, so plainFx is ignored there: the same memo key
// and field as before, byte for byte)
const WILD_IDS = new Set([417, 418, 419, 453, 461, 1517]), WILDM = new WeakMap();
const wildOf = (fg) => { let w = WILDM.get(fg); if (w === undefined) { w = false; for (let i = 0; i < fg.length; i++) if (WILD_IDS.has(fg[i])) { w = true; break; } WILDM.set(fg, w); } return w; };
/** the state in sim has no effect on (featValue 'fx' 0) and the plain-ball field is on */
const plainOf = (sim) => FX_FIELD && !sim.has_levitation && sim.flip_gravity === 0 && sim.max_jumps === 1 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity;
const FIELDS_MB = process.env.EEAT_FIELDS_MB !== undefined ? +process.env.EEAT_FIELDS_MB : 256;
let FIELDS_MAX = FIELDS_MIN;
const fieldBytes = (f) => { let b = 0; for (const k in f) { const a = f[k]; if (ArrayBuffer.isView(a)) b += a.byteLength; } return b; };
/**
 * goalField(Lc, tiles, o) -> the RCH3 field (src/reach.js reachField) of level copy Lc (levelNow) seeded from the goal
 * tiles at cost 0 (the trophy is no goal), memoized (8 fields, LRU). RF.costAt(field, sim) -> tiles to the goal (-1 = a
 * proof: not reachable while the doors stay as in Lc); RF.writeReachFile(field, file, G.blobFp(G.levelBlob(L))) -> the
 * file eegpu explore / beam read as --reach (ordering and the closest distance; dist 0 = on a goal tile).
 * o.deaths: reachField's deaths option (false: no death edges, the executor's searches drop dead balls: the default).
 */
function goalField(Lc, tiles, o = {}) {
	const pfx = o.plainFx === true && FX_FIELD && wildOf(Lc.fg);
	const key = `${fgHash(Lc.fg)}|${Array.from(tiles).sort((a, b) => a - b).join(',')}|${o.deaths === true ? 1 : 0}${pfx ? '|p' : ''}`;
	const had = FIELDS.get(key);
	if (had) { FIELDS.delete(key); FIELDS.set(key, had); return had; }
	if (o.cachedOnly === true) return null;   // (the memo only: executor.js FIELD_MEMO)
	const f = RF.reachField(Lc, pfx ? { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: o.deaths === true, plainFx: true } : { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: o.deaths === true });
	if (FIELDS.size === 0 && FIELDS_MB > 0) FIELDS_MAX = Math.max(FIELDS_MIN, Math.min(FIELDS_CAP, Math.floor(FIELDS_MB * 1048576 / Math.max(1, fieldBytes(f)))));
	FIELDS.set(key, f);
	while (FIELDS.size > FIELDS_MAX) FIELDS.delete(FIELDS.keys().next().value);
	return f;
}

// ---------------------------------------------------------------- JSON-line events (src/plan.js, like goexplore.js)
/** emitter(stream) -> (ev) => void: one JSON object per line */
const emitter = (stream = process.stdout) => (ev) => { try { stream.write(JSON.stringify(ev) + '\n'); } catch (e) { /* closed */ } };

/** the tiles a goal's ordering fields are built to, and their touch rule (the trophy's) */
const fieldTilesOf = (goal) => (goal.fieldTiles ? goal.fieldTiles : goal.tiles);
const fieldTouchOf = (goal) => (goal.fieldTiles ? !!goal.fieldTouch : goal.kind === 'trophy');
module.exports = { VERSION, fieldTilesOf, fieldTouchOf, strOf, masksOf, concat, loadLevelFile, tileOf, touchedTile, playTo, featValue, featGetter, goalOf, arrivalOf, classOf, pickDiverse, levelNow, goalField, plainOf, wildOf, fgHash, emitter, CLOCK_DOORS };
