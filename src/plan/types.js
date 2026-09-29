'use strict';
// THE PLANNER's shared contract (n4plan, 2026-09-29, the architect): UNDERSTAND -> PLAN -> EXECUTE -> REFINE.
// Every part imports this file; no builder edits it (a change goes through the integration step). It holds the shapes
// the parts exchange and the few helpers they must agree on bit for bit: the masks' text form, a replay to a state, the
// WAYPOINT's goal test, the ARRIVAL record, the diverse pick of arrivals, the level "as the doors stand now" and the goal
// field on it. Nothing here searches or prunes; every route is still replayed by the engine (common.js evaluate).
//
// Files of the planner (one owner each): src/plan/model.js, planner.js, facts.js (part 'planner'); executor.js, legs.js
// (part 'executor'); prims.js, navgraph.js, primworker.js (part 'primitives'); strategy.js, truth.js, src/plan.js and the
// editor.js / page hunks behind EEAT_PLAN=1 (part 'strategy').
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

const VERSION = 1;
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
	const test = ex ? (sim) => !sim.is_dead && mask[tileOf(sim, W, H)] === 1 && featValue(sim, ex.feat) === ex.value : (sim) => !sim.is_dead && mask[tileOf(sim, W, H)] === 1;
	return { kind: wp.kind, tiles: Int32Array.from(wp.tiles), mask, test, allowDeath: !!wp.allowDeath };
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
function fgHash(fg) { let h = 0x811c9dc5; for (let i = 0; i < fg.length; i++) { h ^= fg[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ':' + fg.length; }
const FIELDS = new Map(), FIELDS_MAX = 8;
/**
 * goalField(Lc, tiles, o) -> the RCH3 field (src/reach.js reachField) of level copy Lc (levelNow) seeded from the goal
 * tiles at cost 0 (the trophy is no goal), memoized (8 fields, LRU). RF.costAt(field, sim) -> tiles to the goal (-1 = a
 * proof: not reachable while the doors stay as in Lc); RF.writeReachFile(field, file, G.blobFp(G.levelBlob(L))) -> the
 * file eegpu explore / beam read as --reach (ordering and the closest distance; dist 0 = on a goal tile).
 * o.deaths: reachField's deaths option (false: no death edges, the executor's searches drop dead balls: the default).
 */
function goalField(Lc, tiles, o = {}) {
	const key = `${fgHash(Lc.fg)}|${Array.from(tiles).sort((a, b) => a - b).join(',')}|${o.deaths === true ? 1 : 0}`;
	const had = FIELDS.get(key);
	if (had) { FIELDS.delete(key); FIELDS.set(key, had); return had; }
	const f = RF.reachField(Lc, { goals: Array.from(tiles, (t) => ({ tile: t, cost: 0 })), deaths: o.deaths === true });
	FIELDS.set(key, f);
	if (FIELDS.size > FIELDS_MAX) FIELDS.delete(FIELDS.keys().next().value);
	return f;
}

// ---------------------------------------------------------------- JSON-line events (src/plan.js, like goexplore.js)
/** emitter(stream) -> (ev) => void: one JSON object per line */
const emitter = (stream = process.stdout) => (ev) => { try { stream.write(JSON.stringify(ev) + '\n'); } catch (e) { /* closed */ } };

module.exports = { VERSION, strOf, masksOf, concat, loadLevelFile, tileOf, playTo, featValue, goalOf, arrivalOf, classOf, pickDiverse, levelNow, goalField, fgHash, emitter, CLOCK_DOORS };
