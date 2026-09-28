'use strict';
// The level editor's server side (the page: src/app/editor.html, GET /editor). You build a level from blocks, place a
// start (the spawn point, block 255) and the trophy (the finish block, 121), maybe draw a guide line, and the GPU
// brute-forces a route to the trophy:
// - the editor's level JSON <-> .eelvl bytes (src/eelvl.js writeEelvl / readEelvl), so the file EE Offline opens is
//   exactly the level the search ran on;
// - block info for the palette (names, kinds, EE minimap colors, argument kinds);
// - the checks before a search (a start, a trophy, an open way to it) and the search itself: `eegpu explore
//   <level.bin> - --finish=1` (native/explorehost.h: from the level start, every input every tick, near-identical
//   states merged, so the first tick with a finish is the fastest route; in passes of coarser and finer cells, and once
//   a route is known, finer passes look for faster ones until the time is up: nextPass) next to `eegpu beam --goal=1`
//   (native/beamhost.h: the states closest to the trophy kept; with a guide line a second beam follows the line; see
//   STRATEGIES), and on the CPU src/goexplore.js (Go-Explore: random runs from an archive of the earliest state per
//   situation, steered by the reach field; a first route fast, whose length then bounds the exploration's passes).
//   Without an NVIDIA GPU (or the native engine) the CPU search runs alone. Every route is replayed in the exact JS
//   engine (common.js evaluate) before it is shown. The tools also report their closest attempt (the state nearest the
//   trophy by the reach field, src/reach.js); the nearest one is kept (closest.eetas), so a search that finds no route
//   still shows how far it got. One search at a time; its state is in memory and in <data>/editor/solve.json (with
//   level.eelvl, level.bin, reach.bin, guide.txt, route.eetas and closest.eetas next to it).
//
// The editor's level JSON: { name, width, height, gravity (1), bgColor (ARGB, 0 = none), owner, description,
//   cells: [[x, y, id, ...args], ...] (the foreground, empty cells left out), bg: [[x, y, id, ...args], ...] }
// with the arguments of eelvl.argKind(id): [n] a rotation or number, [rotation, id, target] a portal, [text, type] a
// sign, [target, spawn] a world portal, [text, color, wrap] a label, [name, 3 messages] an NPC.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const C = require('./common.js');
const E = C.E;
const EL = require('./eelvl.js');
const G = require('./gpu.js');
const B = require('./blocks.js');
const M = require('./minimap.js');
const RF = require('./reach.js');
const SF = require('./steer.js');
const PV = require('./prove.js');
const BENCH = require('./bench.js');
const GX = require('./goexplore.js');   // (its rooms: roomOf, roomFields, for the relay's sources)
const BU = require('./bursts.js');     // (roomAim: the wall breaker's room target, roomGate)

const MAX_SIDE = 1000, MAX_CELLS = 1e6;
const RF_VERSION = RF.VERSION;   // the reach file eegpu must read (its `info` says "reach": this)
const SPAWN = 255, TROPHY = 121;
// eesim.js block flags (prepareLevel `flags[id]`), for the reachability check (native/beamhost.h's goal field)
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
const ARG_SHAPE = { none: '', int: 'i', portal: 'iii', sign: 'si', world_portal: 'si', label: 'ssi', npc: 'ssss' };
const ARG_DEFAULT = { none: [], int: [0], portal: [0, 0, 0], sign: ['', 0], world_portal: ['', 0], label: ['', '#FFFFFF', 200], npc: ['', '', '', ''] };
const dir = () => path.join(C.DATA, 'editor');
const safeName = (s) => String(s || 'level').replace(/[^\w .()-]/g, '').trim().slice(0, 60) || 'level';

// ---------------------------------------------------------------- level JSON <-> .eelvl
function argsFor(id, given, where) {
	const kind = EL.argKind(id), shape = ARG_SHAPE[kind];
	const out = ARG_DEFAULT[kind].slice();
	for (let k = 0; k < shape.length && k < given.length; k++) {
		const v = given[k];
		if (v === null || v === undefined) continue;
		if (shape[k] === 'i') {
			if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new Error(`block ${id} at ${where}: argument ${k + 1} must be a whole number (got ${JSON.stringify(v)})`);
			out[k] = v;
		} else out[k] = String(v);
	}
	return out;
}
/** The editor's level JSON, checked: { name, width, height, gravity, bgColor, owner, description, fg, bg (Int32Array),
 *  fgArgs, bgArgs (Map index -> args) } */
function normalize(lv) {
	if (!lv || typeof lv !== 'object' || Array.isArray(lv)) throw new Error('bad level (expected a JSON object {name, width, height, cells})');
	const W = lv.width, H = lv.height;
	if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_CELLS) {
		throw new Error(`bad level size ${W} x ${H} (1 to ${MAX_SIDE} tiles per side, at most ${MAX_CELLS / 1e6} million tiles)`);
	}
	const gravity = lv.gravity === undefined || lv.gravity === null ? 1 : +lv.gravity;
	if (!Number.isFinite(gravity)) throw new Error(`bad gravity ${lv.gravity}`);
	const n = { name: String(lv.name || '').slice(0, 200), width: W, height: H, gravity, bgColor: (+lv.bgColor || 0) >>> 0,
		owner: lv.owner === undefined ? 'player' : String(lv.owner).slice(0, 200), description: String(lv.description || '').slice(0, 2000),
		fg: new Int32Array(W * H), bg: new Int32Array(W * H), fgArgs: new Map(), bgArgs: new Map() };
	const put = (list, grid, argMap, what) => {
		if (list === undefined || list === null) return;
		if (!Array.isArray(list)) throw new Error(`bad level: "${what}" must be a list of [x, y, id, ...args]`);
		for (const c of list) {
			if (!Array.isArray(c) || c.length < 3) throw new Error(`bad ${what} entry ${JSON.stringify(c).slice(0, 80)} (expected [x, y, id, ...args])`);
			const [x, y, id] = c;
			if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H) throw new Error(`${what}: (${x}, ${y}) is outside the ${W} x ${H} level`);
			if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error(`${what}: bad block id ${JSON.stringify(id)} at (${x}, ${y})`);
			const i = y * W + x;
			grid[i] = id;
			argMap.delete(i);
			if (id && ARG_SHAPE[EL.argKind(id)].length) argMap.set(i, argsFor(id, c.slice(3), `(${x}, ${y})`));
		}
	};
	put(lv.bg, n.bg, n.bgArgs, 'bg');
	put(lv.cells, n.fg, n.fgArgs, 'cells');
	return n;
}
/**
 * Block records like EEO's DownloadLevel (eelvl_format.md section 9): one record per (id, layer, args), positions in
 * row-major order. The background comes first, so that where both layers of a cell carry a number the foreground's
 * is the one the AS3 Lookup keeps (it is position keyed, last write wins).
 */
function records(n) {
	const out = [];
	for (const [layer, grid, am] of [[1, n.bg, n.bgArgs], [0, n.fg, n.fgArgs]]) {
		const byKey = new Map();
		for (let i = 0; i < grid.length; i++) {
			const id = grid[i];
			if (!id) continue;
			const args = am.get(i) || [];
			const key = `${id}|${JSON.stringify(args)}`;
			let r = byKey.get(key);
			if (!r) { r = { id, layer, xs: [], ys: [], args }; byKey.set(key, r); out.push(r); }
			r.xs.push(i % n.width); r.ys.push(Math.floor(i / n.width));
		}
	}
	return out;
}
/** The editor's level JSON -> .eelvl bytes (what EE Offline opens) */
function eelvlOf(lv) {
	const n = normalize(lv);
	return EL.writeEelvl({ width: n.width, height: n.height, name: n.name, owner: n.owner, gravity: n.gravity, bgColor: n.bgColor,
		description: n.description, records: records(n) });
}
/**
 * .eelvl bytes -> the editor's level JSON, read the way EEO reads it (eelvl.js): the last block written to a cell
 * wins; a foreground number or portal comes from the AS3 Lookup (position keyed across layers), like the game uses it.
 */
function levelOf(buf) {
	let p;
	try { p = EL.readEelvl(buf); } catch (e) { throw new Error(`this does not look like an .eelvl level file (${e.message})`); }
	if (p.width > MAX_SIDE || p.height > MAX_SIDE || p.width * p.height > MAX_CELLS) {
		throw new Error(`this level is ${p.width} x ${p.height} tiles; the editor takes up to ${MAX_SIDE} tiles per side (${MAX_CELLS / 1e6} million tiles)`);
	}
	const W = p.width, N = W * p.height;
	const last = new Map();   // "layer|index" -> the last record entry with arguments there
	for (const b of p.blocks) last.set(`${b.layer}|${b.y * W + b.x}`, b);
	const cells = [], bg = [], odd = new Set();
	for (let i = 0; i < N; i++) {
		const x = i % W, y = Math.floor(i / W);
		for (const layer of [0, 1]) {
			const id = layer ? p.bg[i] : p.fg[i];
			if (!id) continue;
			if (id < 0 || id > 65535) { odd.add(id); continue; }
			const kind = EL.argKind(id);
			let args = [];
			if (layer === 0 && kind === 'int') args = [p.lookup.int.has(i) ? p.lookup.int.get(i) : 0];
			else if (layer === 0 && kind === 'portal') { const q = p.lookup.portals.get(i); args = q ? [q.rotation, q.id, q.target] : [0, 0, 0]; }
			else if (kind !== 'none') { const b = last.get(`${layer}|${i}`); args = b && b.id === id ? b.args.slice() : ARG_DEFAULT[kind].slice(); }
			(layer ? bg : cells).push([x, y, id, ...args]);
		}
	}
	const warnings = p.warnings.slice(0, 20);
	if (odd.size) warnings.push(`block ids the editor cannot keep were left out: ${[...odd].slice(0, 10).join(', ')}`);
	return { name: p.name, width: W, height: p.height, gravity: p.gravity, bgColor: p.bgColor, owner: p.owner, description: p.description,
		cells, bg, warnings };
}

// ---------------------------------------------------------------- block info (the palette, and any level's ids)
/** For the page: per block id its name, kind ([kind, dir/sub, solid] like GET /api/jobs/:id/level), EE minimap color
 *  ("aarrggbb", null without the table) and argument kind (eelvl.argKind). */
function blockInfo(ids) {
	const haveTable = M.table().size > 0;
	const names = {}, kinds = {}, palette = {}, args = {};
	for (const v of ids) {
		const id = +v;
		if (!Number.isInteger(id) || id < 0 || id > 65535) continue;
		const k = B.kindOf(id);
		names[id] = B.blockName(id);
		kinds[id] = [k.kind, k.dir || k.sub || (k.rotatable ? 'rot' : ''), B.isSolidId(id) ? 1 : 0];
		palette[id] = haveTable ? (M.colorOf(id) >>> 0).toString(16).padStart(8, '0') : null;
		args[id] = EL.argKind(id);
	}
	return { names, kinds, palette, args, colors: haveTable ? 'ee-minimap' : 'app' };
}

// ---------------------------------------------------------------- checks
/** tiles the goal field of the GPU search walks through (native/beamhost.h `open`): not a static solid block */
function openTile(L, i) {
	const f = L.flags[L.fg[i]] || 0;
	return (f & F_SOLID) === 0 || (f & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) !== 0;
}
/** tiles reachable from (sx, sy): 8-way over open tiles (no corner cutting, like the goal field), and with
 *  `portals` also from an entered portal to every exit of its target; a death (where the ball can die: a killing tile,
 *  anywhere with a timed killer: curse, zombie, poison with a time, lava) takes it to a checkpoint it touched or, with
 *  2+ spawn points, to the next spawn of EE's rotation: every spawn */
function reachFrom(L, sx, sy, portals) {
	const W = L.width, H = L.height, N = W * H;
	const seen = new Uint8Array(N);
	const q = [sy * W + sx];
	seen[q[0]] = 1;
	const push = (j) => { if (j >= 0 && j < N && !seen[j]) { seen[j] = 1; q.push(j); } };
	let timed = false;
	for (let i = 0; i < N; i++) { const t = L.fg[i]; if (((t === 421 || t === 422 || t === 1584) && L.lookup0[i] > 0) || t === 416) { timed = true; break; } }
	let died = false;
	for (;;) {
		while (q.length) {
			const i = q.pop(), x = i % W, y = Math.floor(i / W);
			if (!died && (timed || (L.gFlags[L.fg[i]] & 4) !== 0)) died = true;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const j = ny * W + nx;
					if (!openTile(L, j) || (dx && dy && (!openTile(L, y * W + nx) || !openTile(L, ny * W + x)))) continue;
					push(j);
				}
			}
			const t = L.fg[i], s = L.portalSlot[i];
			if (portals && (t === 242 || t === 381) && s >= 0) {
				const ex = L.portalsById.get(L.pTarget[s]);
				if (ex) for (let k = 0; k < ex.n; k++) push((ex.ys[k] >> 4) * W + (ex.xs[k] >> 4));
			}
		}
		// (a death: a checkpoint the ball touched is a tile it reached; the spawns, then on from there)
		if (!died || L.spawnsX.length < 2) break;
		for (let k = 0; k < L.spawnsX.length; k++) push(L.spawnsY[k] * W + L.spawnsX[k]);
		if (!q.length) break;
	}
	return seen;
}
/** the physics check's cache per level: <data>/editor/reach_<level hash>_v<RCH version>_<model fingerprint>.json / .bin.
 *  The fingerprint is of the model's sources (reach.js and the engine it measures its tables with), so a changed rule
 *  (a fix that makes the model more generous) never meets a verdict or a reach file of the old one. */
let RF_FP = '';
function reachFp() {
	if (!RF_FP) {
		const h = crypto.createHash('sha1');
		for (const f of ['reach.js', 'eesim.js', 'eelvl.js']) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (e) { h.update(f); } }
		RF_FP = h.digest('hex').slice(0, 10);
	}
	return RF_FP;
}
const levelHashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
/** the searches take deaths as moves (EEAT_DEATHS=moves; the deaths-as-moves design): their reach file keeps the death
 *  edges. Otherwise (today: every search drops a dead ball) the file the searches read is the field without them, where a
 *  state only a death leads to the trophy from is cut off (src/reach.js opts.deaths; the verdicts keep them) */
const deathsTaken = () => process.env.EEAT_DEATHS === 'moves';
const reachBase = (hash) => path.join(dir(), `reach_${hash}_v${RF_VERSION}_${reachFp()}${deathsTaken() ? '_dm' : ''}`);
/** the physics check of a level (.eelvl bytes, prepared level): {mode, startCost (tiles; -1 = no way), explain}, from the
 *  cache (memo, or the search's file); none yet: null, and for a level up to 40k tiles the check starts in a worker
 *  thread (the newest level asked for; the page asks again while `pending`) */
const physicsMemo = new Map();
let physicsNext = null, physicsBusy = false;
function physicsOf(buf, level) {
	const hash = levelHashOf(buf);
	let r = physicsMemo.get(hash) || null;
	if (!r) { const c = C.readJSON(`${reachBase(hash)}.json`, null); if (c && c.v === RF_VERSION && c.fp === reachFp()) r = c; }
	if (r) { physicsMemo.set(hash, r); if (physicsMemo.size > 8) physicsMemo.delete(physicsMemo.keys().next().value); return r; }
	if (level.width * level.height <= 40000) {
		physicsNext = { buf, hash };
		if (!physicsBusy) physicsRun();
		return { pending: true };
	}
	return null;
}
function physicsRun() {
	const job = physicsNext;
	physicsNext = null;
	if (!job) { physicsBusy = false; return; }
	physicsBusy = true;
	// (a failed check: no note, and not asked again for this level; a search says why)
	reachInfo(job.buf, job.hash).then((r) => { physicsMemo.set(job.hash, r); }, () => { physicsMemo.set(job.hash, { failed: true }); }).then(physicsRun);
}
/** the "no way up" note (null: none): the physics check proves the trophy out of reach */
function noWayNote(ph) {
	if (!ph || ph.pending || ph.failed || ph.mode !== 'physics' || ph.startCost >= 0) return null;
	const ex = ph.explain;
	const high = ex && ex.row >= 0 && ex.trophyRow >= 0 && ex.row > ex.trophyRow ? ` (the ball's centre gets no higher than row ${ex.row}; the trophy is in row ${ex.trophyRow})` : '';
	return `No way up: the physics check finds no way from the start to the trophy${high}. A search checks that for up to a minute, then says so.`;
}
/** the "only through a death" note (null: none): the physics check's only way to the trophy is a death (a respawn at a
 *  checkpoint or another spawn), which the searches do not follow (they drop dead balls) */
function deathNote(ph) {
	// (onlyDeath: the start is cut off without the death edges and finite with them; a check of an older cache: the start's
	// cost priced as a death's. Infinity Pain's way around by the walk is 3,178 tiles, above DEATH_TILES)
	if (!ph || ph.pending || ph.failed || !(ph.onlyDeath !== undefined ? ph.onlyDeath : ph.startCost >= RF.DEATH_TILES)) return null;
	return 'The physics check finds a way to the trophy only through a death (the respawn at a checkpoint or another spawn point). The searches drop dead balls, so they cannot find it.';
}
/**
 * What stands in the way of a route search on this level (.eelvl bytes): problems (it cannot run) and notes (with
 * opts.physics also the physics check's "no way up").
 * Returns { problems: [{code, text}], notes: [text], start: [x, y] | null, trophies, level (prepared), json }.
 */
function inspect(buf, opts) {
	let p;
	try { p = EL.readEelvl(buf); } catch (e) { throw new Error(`not an .eelvl level (${e.message})`); }
	if (p.width * p.height > MAX_CELLS) throw new Error(`the level is ${p.width} x ${p.height} tiles; the editor's search takes up to ${MAX_CELLS / 1e6} million tiles`);
	for (const r of p.records) if (r.id < 0 || r.id > 65535) throw new Error(`block id ${r.id} is not an EEO block`);
	const json = EL.toSimLevel(p, { id: 'editor', file: 'editor.eelvl' });
	const level = E.prepareLevel(json);
	const W = level.width, N = W * level.height;
	const problems = [], notes = [];
	const trophies = [];
	for (let i = 0; i < N; i++) if (level.fg[i] === TROPHY) trophies.push(i);
	// no spawn block: EE puts the ball at the top-left, tile (1, 1) (Player.placeAtSpawn; eesim.js _placeAtSpawn)
	const noSpawn = !level.spawnsX.length;
	let start = null;
	{
		const sim = new E.EESim(level);
		sim.reset();
		start = [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4];
		if (noSpawn) notes.push(`No start block: the ball starts at the top-left, tile (${start[0]}, ${start[1]}), like in EE.`);
		if (level.spawnsX.length > 1) notes.push(`${level.spawnsX.length} spawn points: the run starts at (${start[0]}, ${start[1]}) (eeo-tas /reset moves to the second one)`);
	}
	if (!trophies.length) problems.push({ code: 'trophy', text: 'Place the trophy (the finish block): the search looks for the fastest way to it.' });
	let reach = null;
	if (start && trophies.length) {
		const walk = reachFrom(level, start[0], start[1], false);
		if (trophies.some((i) => walk[i])) reach = 'open';
		else {
			const viaPortals = reachFrom(level, start[0], start[1], true);
			if (trophies.some((i) => viaPortals[i])) {
				reach = 'portals';
				notes.push('The way to the trophy goes through portals (the search follows them).');
			} else {
				reach = 'none';
				problems.push({ code: 'unreachable', text: 'The trophy cannot be reached: it is walled in (no open tiles lead from the start to it, not even through portals).' });
			}
		}
	}
	if (level.multiTargetPortals) notes.push('Some portals have several exits: EE picks one at random, so the route may need a few tries in EEO.');
	let physicsPending = false;
	if (opts && opts.physics && start && trophies.length && reach !== 'none') {
		const ph = physicsOf(buf, level);
		physicsPending = !!(ph && ph.pending);
		for (const n of [noWayNote(ph), deathNote(ph)]) if (n) notes.push(n);
	}
	return { problems, notes, start, noSpawn, trophies: trophies.map((i) => [i % W, Math.floor(i / W)]), reach, level, json, physicsPending };
}
/** inspect() for the page: no engine objects (physicsPending: the physics check runs in a worker thread; ask again) */
function check(buf) {
	const r = inspect(buf, { physics: true });
	return { problems: r.problems, notes: r.notes, start: r.start, noSpawn: r.noSpawn, trophies: r.trophies, reach: r.reach, width: r.level.width, height: r.level.height,
		physicsPending: r.physicsPending };
}

// ---------------------------------------------------------------- the route search (one at a time)
// "every move": the exhaustive exploration. Every input from every state, every tick; a state is dropped when one
// already seen falls in the same cell (position, speed, gravity queue, jumps; eegpu explore --cqx/--cqv/--qy/--qvy set
// the cell size). It walks away from the trophy as readily as towards it (a run-up, a block to jump from, an exit
// the other way), and walls and floors snap the ball to exact positions, so precise moves (a one-tile gap entered at
// exactly the right pixel) survive the merging. Its first finish is the fastest route up to that merging. It runs in
// passes of different cell sizes (passCells, nextPass): coarse first, then coarser when a pass fills its visited-cell
// table or uses up its share of the time, finer when it runs out of states without a finish (every merged state tried)
// or finds a route; with a route of T ticks known, a pass looks only at the first T - 1 ticks (`--depth`), so it can
// only find faster routes, and it stops by itself when there is none at its grain.
// Next to it the beams: without a guide line one, scored by the walking distance to the trophy. With one: two beams side by side (the
// tool is mostly single-threaded host work, so the second costs little): "along your line" (the line's progress minus 4
// per px away from it, plus 4 per tile closer to the trophy: it follows the line, and still leaves it where the ball
// must) and "straight for the trophy" (the line can be wrong). The beam's own guide score takes the best of (progress
// minus weight x distance) over the whole line, so with a loose weight a state far from the line can claim the line's
// later progress (e.g. the floor under a ledge the line reaches by stairs elsewhere): 4 keeps the line in charge.
// Each beam's first finish is its fastest; a beam that is already deeper than the best route found stops (it cannot
// find a faster one), and the fastest verified route wins.
// On the CPU (`cpu: true`: node src/goexplore.js, N - 1 worker threads with their own seeds, where N is the number of
// threads, at most the measured fastest thread count, at most N / 2 while a job's optimizer runs): random runs from an
// archive that keeps the earliest state per situation, the one nearest the trophy (reach field) picked first with an
// optimism that fades with its picks. On open levels its first route comes long before the GPU's; the exploration's
// next pass then runs with --depth = route - 1, and each faster route found anywhere is passed to it on its stdin
// ("depth D"), so it only looks for faster ones. It keeps improving until the time is up, unless every GPU strategy has
// ended with a route known (the finest passes found none faster) and none failed. Its depth limit is the request's,
// else 100000 ticks, not the beams' (their route store is 4 bytes per state per tick): the 200x200 ice level's routes are
// ~10000 ticks, and with the old 6000 the CPU search could not find one. Without an NVIDIA GPU it is the whole search.
// On levels above 50 x 50 it runs with coarse cells (goexplore.js --cells=auto: rooms, a novelty and a discovery head
// next to the reach field's heap, no refinement) and reports "source" events: starting points for the relay (the
// sources, RELAY_PLAN).
// There, with a GPU, the same search also runs on the GPU (strategy 'gorolls', "random runs (GPU)", `rolls: true`: node
// src/goexplore.js --gpu=1, which drives `eegpu roll`: the archive and the three heads in that process, a batch of
// ROLL_BATCH picks' runs at a time on the GPU): a GPU strategy for the scheduler (its eegpu gets the stop and pause
// files), a search like the CPU one for the rest (its events, the depth bound on its stdin, it goes on after a route and
// stops with the CPU search: cpuDone). The ice level (200 x 200) on the rented H100 shared with other work, Find a route
// for 120 s with 16 CPU workers: the first route after 18.2 / 33.9 s (5,271 / 5,319 ticks), without it 61.5 / 66.9 /
// 67.0 s (10,297 / 9,894 / 10,297 ticks, the CPU search's and the relay's).
const STRATEGIES = {
	explore: { label: 'every move', args: (f, o, q) => { const c = passCells(q.pass); return ['explore', f.bin, '-', '--finish=1', '--discrete=1', `--depth=${q.depth || 100000}`,
		`--seconds=${q.seconds}`, '--coarse=0', `--cqx=${c.cqx}`, `--cqv=${c.cqv}`, `--qy=${c.qy}`, `--qvy=${c.qvy}`, `--reach=${f.reach}`, ...steerArg(f, q.V), ...(o.prune ? ['--prune=1'] : []),
		...(q.salt ? [`--salt=${q.salt}`] : []), ...(q.salts ? ['--salts=1000000'] : []), ...(q.refine ? ['--refine=1'] : []),
		...(q.lanes ? ['--lanes=auto', `--lanesMax=${q.lanes.max}`, `--lanesStart=${q.lanes.start}`] : [])]; } },
	// the relay: "every move" again from a point of the nearest attempt so far (its inputs as --prefix, a fresh table,
	// coarse speed cells: see RELAY_CELLS)
	relay: { label: 'from the nearest attempt', args: (f, o, q) => ['explore', f.bin, '-', `--prefix=${q.prefixFile}`, '--finish=1', '--discrete=1', `--depth=${q.depth || 100000}`,
		`--seconds=${q.seconds}`, '--coarse=0', `--cqx=${q.cells.cqx}`, `--cqv=${q.cells.cqv}`, `--qy=${q.cells.qy}`, `--qvy=${q.cells.qvy}`, `--reach=${f.reach}`, ...steerArg(f, q.V),
		// (a small table and layer cap: its layers hold tens of thousands of states, and a full-size second explore next
		// to every move's (2 GB of cells + ~2.7 GB of states) overcommitted the 8 GB laptop GPU: paged, 5x slower)
		q.alone ? '--cells=27' : q.big ? '--cells=26' : '--cells=25', q.big || q.alone ? '--cap=1048576' : '--cap=262144', ...(o.prune ? ['--prune=1'] : []), ...(q.salt ? [`--salt=${q.salt}`] : []),
		// (a ceiling: states farther from the trophy than the start by RELAY_SLACK tiles + RELAY_SLACK_F of its distance are
		// dropped, except in the last-resort run with the larger table)
		...(q.slack > 0 ? [`--costslack=${q.slack}`] : [])] },
	// the wall breaker ("past the wall", see BREAK_WAIT_S): "every move" from a stalled search's frontier states (--prefix)
	// with the largest table the GPU holds (--cells, up to 2^31), a 2M layer cap, 4 px / 1/16 px/tick cells first and no
	// cost ceiling; a box of BREAK_REGION tiles around its start only with a table of 2^28 cells or fewer
	breaker: { label: 'past the wall', args: (f, o, q) => ['explore', f.bin, '-', `--prefix=${q.prefixFile}`, '--finish=1', '--discrete=1', `--depth=${q.depth || 100000}`,
		`--seconds=${q.seconds}`, '--coarse=0', `--cqx=${q.cells.cqx}`, `--cqv=${q.cells.cqv}`, `--qy=${q.cells.qy}`, `--qvy=${q.cells.qvy}`, `--reach=${q.gateReach || f.reach}`, ...(q.gateReach ? [] : steerArg(f, q.V)),
		`--cells=${q.cellLog}`, `--reserve=${q.reserve}`, `--cap=${BREAK_CAP}`, ...(q.region ? [`--region=${q.region}`] : []), ...(o.prune && !q.gateReach ? ['--prune=1'] : [])] },
	guide: { label: 'along your line', args: (f, o, q) => [...beamArgs(f, o, q), `--guide=${f.guide}`, '--guideWeight=4', '--goalWeight=4'] },
	goal: { label: 'straight for the trophy', args: (f, o, q) => beamArgs(f, o, q) },
	goexplore: { label: 'random runs (CPU)', cpu: true, args: (f, o, q) => [f.eelvl, `--seconds=${q.seconds}`, `--workers=${o.workers}`, `--seed=${o.seed}`,
		`--depth=${q.depth || o.cpuDepth}`, '--stdin=1', ...(o.noWayUp ? ['--prune=0'] : []), ...(o.deathFree ? [] : ['--deaths=1']), ...(f.steerCpu && !o.noWayUp ? [`--steer=${f.steerCpu}`, ...(f.steerDist ? [] : ['--steerDist=0'])] : []),
		// (the one search: the GPU bursts from its archive, src/bursts.js; they wait between two launches while the editor's
		// scheduler gives the GPU to another strategy: its pause file; the trophy arm's bursts order by the steer field when
		// the GPU tools read it, as the relay did)
		...(o.bursts ? ['--bursts=1', `--tool=${q.tool}`, ...G.cacheArgs(), `--pausefile=${q.pauseFile}`, `--work=${q.work}`, ...(f.steer && !o.noWayUp ? [`--burstSteer=${f.steer}`] : [])] : [])] },
	gorolls: { label: 'random runs (GPU)', rolls: true, args: (f, o, q) => [f.eelvl, '--gpu=1', `--tool=${o.tool}`, `--bin=${f.bin}`, `--reach=${f.reach}`, `--seconds=${q.seconds}`,
		`--seed=${o.seed}`, `--depth=${q.depth || o.cpuDepth}`, `--batch=${ROLL_BATCH}`, '--stdin=1', ...(o.deathFree ? [] : ['--deaths=1'])] },
};
// the GPU random runs' picks per batch (goexplore.js --batch; each plays 8 runs of 40 ticks)
const ROLL_BATCH = 4096;
const beamArgs = (f, o, q) => ['beam', f.bin, '--goal=1', `--width=${o.width}`, `--seconds=${q.seconds}`, `--depth=${o.depth}`, `--reach=${f.reach}`, ...(f.steerBeam && !(q.V && q.V.noSteer) ? [`--steer=${f.steerBeam}`] : [])];
// the steer field (src/steer.js, RCH4: the gate-aware order; the prune stays the reach field's): passed to the GPU tools
// when it models anything the reach field does not (2+ layers or the coin DP) and their copies fit STEER_GPU_SHARE of the
// GPU's memory in all (each tool uploads its own: every move and the relay (or the one search's trophy arm) first, the two
// beams too when four copies fit), to the CPU search whenever it models anything
const steerArg = (f, V) => (f.steer && !(V && V.noSteer) ? [`--steer=${f.steer}`] : []);
const STEER_GPU_SHARE = 1 / 40;
// the steer build: at most this long before the search starts (it goes on in its worker, cached for the next search; this
// one orders by the reach field)
const STEER_WAIT_MS = 15000;
// The one search (the friend's "one optimal search" instead of three searches built one after another): on levels above
// 50 x 50 tiles (goexplore.js coarse cells) with the GPU, the CPU search's archive is the only one: its random runs, and
// GPU bursts (src/bursts.js: "every move" from its cells, aimed at each room's untried triggers, a bandit choosing the
// room and the settings; its trophy arm is the relay, ordered by the steer field) whose attempts go back into it. It
// replaces the relay there. The GPU random runs (gorolls) are one more operator of the same archive: every room they
// enter first and their nearer attempts go into it (the one search's stdin: "import <inputs>", ONE_FEED_MS apart at
// least), and their GPU slices follow their yield (ROLLS_DRY_MAX). Every move and the beams still run (they end early on
// such levels: Infinity Pain's at 21 s); the bursts take their GPU slices (schedule).
const ONE_LABEL = 'one search (CPU runs + GPU bursts)';
/** the CPU search's worker threads: `want` (the request) or N - 1 of the N threads (one left for the app and the GPU
 *  tools' host work), at most the thread count the CPU benchmark measured fastest (src/bench.js; on many laptops more
 *  threads are slower), and at most half of them while a job's optimizer runs (as for a focus search) */
function cpuWorkers(want) {
	const n = os.cpus().length || 1;
	if (Number.isInteger(+want) && +want >= 1) return Math.min(n, +want);
	const bench = BENCH.cached();
	let grind = false;
	try { const J = require('./jobs.js'); grind = C.jobIds().some((id) => J.runningPid(id)); } catch (e) { /* no jobs folder */ }
	return Math.max(1, Math.min(grind ? Math.floor(n / 2) : n - 1, bench && bench.peakThreads ? bench.peakThreads : n));
}
// the exploration's cell size: pass 0 = 2 px and 1/16 px/tick in x, 1 px and 1/16 px/tick in y. The finer passes (1, 2)
// halve positions and speeds, and the finest keeps heights and vertical speeds exact. The coarser passes (-1, -2)
// double the positions only: their speed cells stay at pass 0's 1/16 px/tick (a ball speeding up gains about 0.13
// px/tick per tick, so a coarser speed cell holds it in place: a pass -2 with 1/4 px/tick cells ran out of situations
// after 16 ticks on a level solved in 143). The search starts coarse (PASS_START): coarse cells fill the table slowly
// and reach far soon (a level whose pass 0 spent 195 s filling its table by tick 185 was solved at pass -1 in 16 s), and
// the finer passes then shorten the route. Whatever the pass, a whole-pixel position or a zero speed (what a wall,
// floor or ceiling hit leaves) never shares a cell with a near miss, and which state stands for a cell is fixed (the
// nearest to the trophy by the reach field, then the state itself): a pass on the same level gives the same states.
const PASS_MIN = -2, PASS_MAX = 2, PASS_START = -1;
// The probe: "every move" first runs the finest pass (its salt loop, with near-miss refinement) and gives it PROBE_S s of
// search time (from its ready event) for its first try. A try that runs through in that time (a route, or every
// situation tried) says the finest cells are cheap here: the pass keeps the whole time (the beams yield to its tries as
// usual). A try still going (or a full table) says they are not: the probe is stopped between two launches and the ladder
// runs from PASS_START as if it had not been. The user's 50x50 levels: a try takes 0.4-0.5 s alone on the laptop GPU, the
// ladder's coarse passes took 33 s there next to the beams and the CPU search (route after 59.7 s, the finest pass after
// 58 s); staircase / dotstairs: the finest pass explodes (60M+ states), the ladder solves them.
const PROBE_S = 15, PROBE_WALL = 3;
// the sanity search after the physics check proves the trophy out of reach (a route there would be a bug in the model):
// NO_WAY_UP_S s (60 kept the user waiting a minute for a verdict the proof had already given)
const NO_WAY_UP_S = 10;
// (no time limit for a refined try: cut at 10 s next to the beams and the relay, shaft's refined try, the one that finds
// its route in 2.5 s alone, had reached tick 111; a try ends by itself: a finish, every situation tried, a full table.
// The relay waits for it: RELAY_WAIT_S)
// A GPU tool that has said nothing for STALL_S s after loading (it prints a line per tick layer) is stopped: its stop
// file, then the kill 2 s later (halt). Once, next to the relay's process, an explore sat at 100% of a core and of the
// GPU on one layer for 7 minutes, deaf to its stop file; the search never ended.
const STALL_S = 20;
let stallTimer = null;
// The GPU scheduler: one GPU strategy runs at a time (eegpu --pausefile: the others wait between two launches, keeping
// everything). Side by side, each got far less than its share: the relay, with its small launches waiting behind every
// move's 50 ms ones, ran 15x slower than alone (the dot ring's route from tick 249: 2.4 s alone, 20-35 s beside every
// move). Slices of SLICE_MS in turn; a strategy that got nearer the trophy in its slice keeps the GPU (up to SLICE_MAX
// slices in a row); every move's probe runs alone. The CPU search is not scheduled.
// The leader (the strategy whose own nearest attempt is nearest the trophy) gets every other slice; the others take
// the slices between in turn; only a strategy within LEAD_TILES of the leader keeps the GPU for getting nearer (every
// move's refined try, 78 tiles out and inching on, held it for 10 s at a time while the relay, 34 tiles out, waited).
const SLICE_MS = 2500, SLICE_MAX = 4, LEAD_TILES = 10;
// The GPU random runs (gorolls) get a slice whenever they have waited ROLLS_WAIT_MS since their last one (every other
// slice), every move's probe included: a single long-lived process whose early attempts are far from the trophy, they won
// neither the leader's slices nor the turns of fresh processes (every new pass and relay run is one): on the ice level
// (200 x 200) they had 2 s of the GPU in the search's first 76 s, where alone they find a route in 8 s. On levels of at
// most ROLLS_PROBE_TILES tiles (100 x 100) every move's probe keeps the GPU to itself (its finest pass may run through
// there in its PROBE_S; on the 200 x 200 levels it never did, and its 15 s were the random runs' lost time); above, its
// PROBE_S counts its own GPU time (the ice level's probe, sharing: 4.9 s of kernels in its 15 s of the clock, 11.7 s alone).
const ROLLS_WAIT_MS = 2500, ROLLS_PROBE_TILES = 10000;
// With the one search (its bursts a GPU strategy too) the random runs' wait follows their yield: every slice of theirs in
// which they got no nearer and found no new room doubles it, up to ROLLS_DRY_MAX times (2.5 s -> 40 s: a slice in 16),
// and a slice that found something starts it over; the bursts are the one search's arm for the rest of the GPU (on
// Infinity Pain the GPU engine does ~0.4 M ticks/s in the play area, where the rolls do not pay, and every other slice
// was theirs)
const ROLLS_DRY_MAX = 4;
let sched = null, schedTimer = null;   // { owner: strategy index, since, slices, lastOther }
const pauseFileOf = (k) => path.join(dir(), `pause_${k}`);
function setPaused(k, on) {
	const ch = kids[k];
	if (!ch || !!ch.paused === on) return;
	try { if (on) fs.writeFileSync(pauseFileOf(k), 'pause'); else fs.unlinkSync(pauseFileOf(k)); } catch (e) { /* gone */ }
	ch.paused = on;
	if (on) ch.pausedSince = Date.now();
	else {
		ch.lastOut = Date.now();   // (the stall watchdog counts from its turn)
		if (ch.pausedSince) ch.pausedMs = (ch.pausedMs || 0) + Date.now() - ch.pausedSince;
		ch.pausedSince = 0;
	}
}
/** the ms a strategy's process has spent paused (other strategies' slices) so far */
const pausedMsOf = (ch) => (ch.pausedMs || 0) + (ch.paused && ch.pausedSince ? Date.now() - ch.pausedSince : 0);
function schedule() {
	if (!S || !S.running) return;
	const now = Date.now();
	const gpu = [];
	S.strategies.forEach((q, k) => { if ((!q.cpu || q.gpuShare) && alive(kids[k]) && !kids[k].stopWhy) gpu.push(k); });
	if (!gpu.length) { sched = null; return; }
	// (the wall breaker's round has the GPU to itself: the others wait between two launches, keeping their tables; also
	// between its processes (every move and the relay handing over the memory, one run's end and the next's start), so
	// the beams and the random runs do not get the GPU back for those seconds)
	const BK = S.strategies.findIndex((q) => q.key === 'breaker');
	if (BK >= 0 && (gpu.includes(BK) || (!!brk && !!brk.round))) {
		if (!sched || sched.owner !== BK) sched = { owner: BK, since: now, slices: 1 };
		for (const k of gpu) setPaused(k, k !== BK);
		if (gpu.includes(BK)) { kids[BK].hadTurn = true; kids[BK].lastTurn = now; }
		S.gpuTurn = 'breaker';
		return;
	}
	let owner = sched && gpu.includes(sched.owner) ? sched.owner : -1;
	const X = S.strategies.findIndex((q) => q.key === 'explore');
	const RW = S.strategies.findIndex((q) => q.rolls);
	const rollsSlice = owner >= 0 && owner === RW && now - sched.since < SLICE_MS;   // (the random runs' slice, not over yet)
	const probing = gpu.includes(X) && S.strategies[X].probe === 'running';
	const probeAlone = probing && S.size && S.size[0] * S.size[1] <= ROLLS_PROBE_TILES;
	// (the random runs' slice that just ended: did it find anything? with the one search, their next wait follows it)
	if (RW >= 0 && sched && sched.owner === RW && sched.rollsFrom && now - sched.since >= SLICE_MS) {
		const q = S.strategies[RW], got = (q.bestAt || 0) > sched.since || (q.rooms || 0) > sched.rollsFrom.rooms;
		q.dry = got ? 0 : Math.min(ROLLS_DRY_MAX, (q.dry || 0) + 1);
		sched.rollsFrom = null;
	}
	const rollsWait = RW >= 0 && cur && cur.opts.bursts ? ROLLS_WAIT_MS * (1 << (S.strategies[RW].dry || 0)) : ROLLS_WAIT_MS;
	if (RW >= 0 && gpu.includes(RW) && owner !== RW && !probeAlone && (owner < 0 || now - sched.since >= SLICE_MS) && now - (kids[RW].lastTurn || kids[RW].startedAt) >= rollsWait) {
		sched = { owner: RW, since: now, slices: 1, lastOther: sched ? sched.lastOther : undefined, rollsFrom: { rooms: S.strategies[RW].rooms || 0 } };
	} else if (probing) {
		if (owner !== X && !rollsSlice) sched = { owner: X, since: now, slices: 1 };
	} else if (owner < 0) {
		sched = { owner: gpu[0], since: now, slices: 1 };
	} else if (now - sched.since >= SLICE_MS) {
		const q = S.strategies[owner];
		let lead = Infinity, leader = -1;
		for (const k of gpu) { const b = S.strategies[k].best; if (b !== undefined && b < lead) { lead = b; leader = k; } }
		const nearLead = leader < 0 || (q.best !== undefined && q.best <= lead + LEAD_TILES);
		// (a process that has not had the GPU yet (a new relay run, a new pass) gets the next slice: the relay's run waited
		// 5 s behind every move's extensions, and then found the dot ring's route in 3 s)
		const fresh = gpu.find((k) => k !== owner && !kids[k].hadTurn);
		if (fresh !== undefined) sched = { owner: fresh, since: now, slices: 1, lastOther: sched.lastOther };
		else if (q.bestAt && q.bestAt > sched.since && sched.slices < SLICE_MAX && nearLead) sched = Object.assign({}, sched, { since: now, slices: sched.slices + 1 });
		else if (leader >= 0 && owner !== leader) sched = { owner: leader, since: now, slices: 1, lastOther: owner };
		else {
			// (the leader has had its turn: the next of the others)
			const others = gpu.filter((k) => k !== leader);
			const last = sched.lastOther !== undefined ? others.indexOf(sched.lastOther) : -1;
			const next = others.length ? others[(last + 1) % others.length] : owner;
			sched = { owner: next, since: now, slices: 1, lastOther: next };
		}
	}
	for (const k of gpu) setPaused(k, k !== sched.owner);
	kids[sched.owner].hadTurn = true;
	kids[sched.owner].lastTurn = now;
	S.gpuTurn = S.strategies[sched.owner].key;   // (the page and the tools: which search has the GPU now)
}
function checkStalls() {
	if (!S || !S.running) return;
	relayKick();   // (a relay still waiting: the nearest attempt came before the search's first seconds)
	breakKick();   // (a stalled search: a round of the wall breaker)
	const now = Date.now();
	S.strategies.forEach((q, k) => {
		const ch = kids[k];
		if (q.cpu || !alive(ch) || ch.stopWhy || ch.paused || !q.readyAt || now - (ch.lastOut || ch.startedAt) < STALL_S * 1000) return;
		note(`${q.label}: no word from the GPU tool for ${STALL_S} s: stopped${q.key === 'explore' ? '; the next pass goes on' : ''}`);
		halt(ch, q.key === 'explore' ? 'time' : 'stalled');
	});
}   // (the beams run beside it: a beam next to the probe's first try made an 8 s probe miss on the throttled GPU)
// A beam still getting nearer the trophy (its own closest attempt better within BEAM_PROGRESS_MS) keeps running when every
// move's tries want the GPU (yieldBeams): on a 50x50 level with a 477-tick route the beam was about to reach the trophy
// when it gave way, and every move then took far longer.
const BEAM_PROGRESS_MS = 15000;
// A beam whose own nearest attempt has not improved for BEAM_STALL_MS stops (it is stuck in a trap of the physics check's
// optimism: the dot ring's beam spent 90 s at the same 102.4 tiles, a third of the GPU), while every move or the relay
// still searches.
const BEAM_STALL_MS = 10000;
// The relay (strategy 'relay'): a long route needs more situations than one table holds (every move from the start of a
// 50x50 level with a ring of dots filled its 33M at tick 535, 30 tiles from the trophy), and a beam walks into the traps
// of the physics check's optimism (a run-up detour that first leads away; a corner it thinks it can cut). So once an
// attempt has gone RELAY_MIN_TICKS, every move starts again from a point of the nearest attempt so far, RELAY_BACK
// ticks before its end (room to correct its last moves), with a fresh table: exhaustive from there, so no trap holds
// it. Its speed cells are coarse (1/4 px/tick: in a field of dots both speeds are free and 1/16 filled the table in 76
// ticks; from there the dot ring's route took 2.7 s); a run that runs out at once (a ball starting from rest merges
// with the ball at rest in coarse speed cells) tries pass 0's cells. A run without a nearer attempt starts further back;
// a nearer attempt from any strategy is the next run's start.
// the relay starts once every move's first refined try has ended (the pixel-exact levels' route comes from it, and it
// needs the GPU), every move runs the ladder (the probe found the finest cells too many), or after RELAY_WAIT_S
const RELAY_WAIT_S = 20, RELAY_AFTER_REFINE_MS = 3000;   // (a refined try still going after 3 s is not the quick pixel-exact case
// (user30s, shaft: 2-3 s alone): on the dot ring it filled its table after 8 s, and the relay waited for it)
// Every move gives the GPU to a relay far ahead of it (its own nearest attempt 10+ tiles behind the relay's, not better
// for EXPLORE_YIELD_MS): the dot ring's relay reached the ring at 35 s next to every move's coarse passes from the start
// (10 s with the GPU to itself). It goes on (the same pass) when the relay waits for a nearer attempt, or once a route
// is known (faster routes).
const EXPLORE_YIELD_MS = 15000, EXPLORE_YIELD_TILES = 10;
function resumeExplore() {
	if (!S || !S.running || S.halted || S.stage === 'stopped' || breakerBusy()) return;
	S.strategies.forEach((q, k) => { if (q.key === 'explore' && q.state === 'waiting' && !alive(kids[k])) { Object.assign(q, { state: 'starting', detail: '' }); kids[k] = launch(k); } });
}
// A relay that finds nothing nearer goes on along its plan (RELAY_PLAN): further back along the nearest attempt, from
// other starting points (sources: the newest room not relayed from yet, then the room with territory gain relayed from
// least; on the 200x200 ice level the relay stalled 545-740 tiles out while the route passes that very spot: the place
// was right, the one attempt it kept restarting from was not), further back again, then from the other strategies' own
// nearest attempts (another branch of the level: on a 200x200 key maze the relay stalled 740 tiles out, behind a wall of
// the physics check's optimism, while the CPU search's attempt lay elsewhere), then once more from the nearest attempt
// with a larger table, coarser cells and twice the time.
const RELAY_MIN_TICKS = 100, RELAY_BACK = [60, 150, 400, 1000, 2000], RELAY_S = 30, RELAY_SWITCH_MS = 3000, RELAY_MIN_KEEP = 50, RELAY_STALL_MS = 8000;
// the plan's steps (R.back indexes it): ticks back along the nearest attempt, or a source ('new': the newest source not
// relayed from yet, from the tick its room was entered; 'gain': the source with territory gain relayed from least, from
// RELAY_BACK[0] ticks before the end of its lowest-cost attempt); after them the other strategies' attempts and the
// larger table
const RELAY_PLAN = [RELAY_BACK[0], RELAY_BACK[1], RELAY_BACK[2], 'new', 'gain', RELAY_BACK[3], RELAY_BACK[4]];
// The sources: starting points for the relay besides the nearest attempt, per room (goexplore.js roomOf: the keys,
// switches, effects, ... that open doors or change the physics): the earliest arrival in it (an attempt that ends where
// it entered the room) and its lowest-cost attempt, with the relay runs made from it (S.sources: the page's summary, no
// inputs). From the CPU search's "source" events (coarse cells: each new room's first cell, every 5 s the best cells of
// the rooms with the most territory gain) and from every strategy's own nearer attempts (closer(): the room its last
// state is in and the tick it entered that room, from one replay in the JS engine; its territory gain from the
// editor's own room fields up to SOURCE_WALK_TILES). At most RELAY_SOURCES: when full, the ones relayed from, without
// gain, oldest go first.
const RELAY_SOURCES = 64;
// a strategy's own nearer attempt that is not the nearest of all: its room at most every SOURCE_REPLAY_MS (each is a
// replay in the JS engine on the server's thread; a beam improves every layer)
const SOURCE_REPLAY_MS = 1000;
// the territory gain of a strategy's own attempt's room is a walk of the level on the server's thread (once per room:
// 5 ms on 200 x 200 tiles, 50-180 ms on 1000 x 1000), so only on levels of at most this many tiles (400 x 400); above,
// a room's gain comes from the CPU search's source events alone (its walks run in its own threads), 0 until one names it
const SOURCE_WALK_TILES = 160000;
let sources = new Map(), sourceSeq = 0;   // room key -> {room, desc, gain, runs, at, from, early, best}
let roomsCur = null;                      // the running search's rooms: {RM, fields, walk, gain: Map(room key -> gain)}
const srcPending = new Map();             // strategy index -> {at (its last replay), next (the attempt waiting), timer}
/** the running search's room key function (goexplore.js), made at the first use; its room fields at the first walk */
function roomsOfSearch() {
	if (!roomsCur && cur) roomsCur = { RM: GX.roomOf(cur.level), fields: null, walk: cur.level.width * cur.level.height <= SOURCE_WALK_TILES, gain: new Map() };
	return roomsCur;
}
/** forgets the sources and the rooms (a new search, or the end of one: the attempts' inputs, up to 100000 characters
 *  each, would stay in the server; S.sources, the page's summary, stays) */
function dropSources() {
	sources = new Map(); sourceSeq = 0; roomsCur = null;
	for (const p of srcPending.values()) if (p.timer) clearTimeout(p.timer);
	srcPending.clear();
}
/** the sources with their inputs (measurement scripts: how far along a known route the search got) */
const sourcesOf = () => [...sources.values()].map((x) => ({ room: x.room, desc: x.desc, gain: x.gain, early: x.early, best: x.best }));
/** the page's summary of the sources (no inputs) */
function publishSources() {
	S.sources = [...sources.values()].sort((x, y) => y.at - x.at).map((s) => ({ room: s.room, desc: s.desc, gain: s.gain, runs: s.runs, from: s.from,
		entered: s.early ? s.early.ticks : null, best: s.best ? { ticks: s.best.ticks, tiles: Math.round(s.best.dist * 10) / 10 } : null }));
}
/** a starting point o: {room, desc, gain, from, inputs, dist, arrival (the ticks of its inputs up to where it entered the
 *  room; 0 = not known)} */
function addSource(o) {
	let s = sources.get(o.room);
	if (!s) {
		if (sources.size >= RELAY_SOURCES) {
			// (the least useful goes: relayed from already, no territory gain, the oldest)
			let v = null;
			const rank = (x) => (x.runs > 0 ? 4 : 0) + (x.gain > 0 ? 0 : 2);
			for (const x of sources.values()) if (!v || rank(x) > rank(v) || (rank(x) === rank(v) && x.at < v.at)) v = x;
			sources.delete(v.room);
		}
		s = { room: o.room, desc: String(o.desc || ''), gain: 0, runs: 0, at: 0, from: o.from, early: null, best: null };
		sources.set(o.room, s);
		if (brk && !brk.seen.has(o.room)) { brk.seen.add(o.room); S.roomsSeen = brk.seen.size; }
	}
	if (o.gain > s.gain) s.gain = o.gain;
	// (the wall breaker's stall clock: a room no attempt was in before that opens territory; on Good Egg, a level of time
	// doors, rooms without it kept coming (1,355 in 900 s) and the breaker never started)
	if (brk && s.gain > 0 && !brk.rooms.has(o.room)) { brk.rooms.add(o.room); breakProgress('room'); }
	const inputs = String(o.inputs);
	if (o.arrival > 0 && (!s.early || o.arrival < s.early.ticks)) {
		if (!s.early) s.at = ++sourceSeq;   // ("newest": when its room's entry became known)
		s.early = { inputs: inputs.slice(0, o.arrival), ticks: o.arrival, dist: o.dist };
	}
	if (!s.best || o.dist < s.best.dist - 1e-3) s.best = { inputs, ticks: inputs.length, dist: o.dist };
	publishSources();
}
/** the source for the relay plan's step ('new' or 'gain'); c: the nearest attempt (its own step, not again here) */
function pickSource(step, c) {
	const same = (a) => !!c && a.ticks === c.ticks && Math.abs(a.dist - c.dist) < 1e-3;
	const usable = (a) => !!a && a.ticks >= RELAY_MIN_TICKS && a.dist < deathTiles() && !same(a);
	let b = null;
	for (const s of sources.values()) {
		if (step === 'new') {
			if (s.runs === 0 && usable(s.early) && (!b || s.at > b.at)) b = s;
		} else if (s.gain > 0 && usable(s.best) && (!b || s.runs < b.runs || (s.runs === b.runs && (s.gain > b.gain || (s.gain === b.gain && s.at > b.at))))) b = s;
	}
	return b;
}
/** masks replayed in the JS engine like common.js replay (to the finish, if any): the path, run ticks, deaths, and the
 *  room of its last state ({key, desc, since: the tick it entered that room}) */
function replayRooms(masks, withPath) {
	const R = roomsOfSearch();
	const sim = new E.EESim(cur.level), inp = new E.EEInput();
	sim.reset();
	let deaths = 0, complete = -1, key = R.RM.key(sim), since = 0;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); else if (k === 'death') deaths++; };
	const path = withPath ? [[Math.round((sim.px + 8) * 10) / 10, Math.round((sim.py + 8) * 10) / 10]] : null;
	for (let t = 0; t < masks.length && complete < 0; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (path) path.push([Math.round((sim.px + 8) * 10) / 10, Math.round((sim.py + 8) * 10) / 10]);
		const k = R.RM.key(sim);
		if (k !== key) { key = k; since = t + 1; }
	}
	// (the room's territory gain: from the state it ends in, once per room; 0 above SOURCE_WALK_TILES)
	let gain = R.gain.get(key);
	if (gain === undefined) {
		if (R.walk && !R.fields) {
			// (the start's room first, as in the CPU search: a room's gain is the territory no earlier room's walk reached,
			// so the first room walked must not count the start's own territory as its gain)
			R.fields = GX.roomFields(cur.level, 16 << 20);
			const s0 = new E.EESim(cur.level);
			s0.reset();
			R.gain.set(R.RM.key(s0), R.fields.enter(s0).gain);
		}
		gain = R.gain.get(key);
		if (gain === undefined) { gain = R.walk ? R.fields.enter(sim).gain : 0; R.gain.set(key, gain); }
	}
	// (with the steer field the attempts' distances are its own; the page shows the reach field's: reachTiles)
	const rc = cur.reachLookup ? RF.costAt(cur.reachLookup, sim) : -1;
	return { path, runTicks: sim.run_ticks, deaths, room: { key, desc: R.RM.desc(sim), since, gain }, reachTiles: rc >= 0 ? rc : null };
}
/** the distance (tiles) from which an attempt's way is a death's: RF.DEATH_TILES, but none (1e4: cut off) when the searches'
 *  reach file has no death edges (cur.opts.fileDeaths false: the death-free file, or a level without deaths; a long real way,
 *  Infinity Pain's 3,178 tiles without the deaths, Egg Quest II's start 3,386, is no death) */
const deathTiles = () => (cur && cur.opts && cur.opts.fileDeaths === false ? 1e4 : RF.DEATH_TILES);
/** a strategy V's distance d (tiles) on the scale the attempts are ranked by: a strategy without the steer field while
 *  the others order by it (a beam over the memory budget, a tool that could not load it, the GPU random runs, which never
 *  read it) reports the reach field's, ranked like the steer field's "no value" ones: STEER_MISS + d */
function steerDist(V, d) {
	const steerless = !!cur && cur.distBySteer && (V.noSteer || V.rolls || ((V.key === 'goal' || V.key === 'guide') && !cur.files.steerBeam));
	return steerless && d < 1e4 ? Math.min(9990, STEER_MISS + d) : d;
}
/** strategy n's own nearer attempt a {inputs, ticks, dist}: a source for its room (at most every SOURCE_REPLAY_MS per
 *  strategy; the latest one waiting is taken then). rm: its room, when the attempt was replayed already. */
function attemptSource(n, a, rm) {
	const V = S.strategies[n];
	if (!rm) {
		const now = Date.now();
		let p = srcPending.get(n);
		if (!p) srcPending.set(n, p = { at: 0, next: null, timer: null });
		if (now - p.at < SOURCE_REPLAY_MS) {
			p.next = a;
			if (!p.timer) {
				const S0 = S;
				p.timer = setTimeout(() => { p.timer = null; const b = p.next; p.next = null; if (S === S0 && S.running && cur && b) attemptSource(n, b); }, SOURCE_REPLAY_MS - (now - p.at));
				if (p.timer.unref) p.timer.unref();
			}
			return;
		}
		p.at = now;
		rm = replayRooms(Uint8Array.from(a.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31), false).room;
	}
	addSource({ room: rm.key, desc: rm.desc, gain: rm.gain, from: V.label, inputs: a.inputs, dist: a.dist, arrival: rm.since });
}
// the relay's cost ceiling (explore --costslack): the ice level's open arrow fields filled even the large table with
// states going back the way the relay came. With the steer field a state is dropped only above both fields' ceilings
// (each field's cost at the start + the slack): never one the relay keeps without the steer field
const RELAY_SLACK = 30, RELAY_SLACK_F = 0.1;
// (at most: the steer field's distances run into the thousands of tiles on a level of gates)
const RELAY_SLACK_MAX = 200;
// the steer field's "no value" distances start here (native/beam.h steerMiss, goexplore.js: 6000 + the reach field's cost;
// a real steer distance is at most 5999: native/beam.h STEER_REAL_MAX)
const STEER_MISS = 6000;
// (1/4 px/tick speed cells first: fast, and enough for the dot ring; a relay that runs out of situations goes on with 1/16:
// a key press changes the speed by 0.129 px/tick, so with 1/4 px/tick cells the child that pressed it mostly shares its
// sibling's cell and speed builds up only across cell edges: the ice level's relay could not run up to a staircase shaft
// it climbs with 1/16 px/tick cells, even with 8 px positions)
const RELAY_CELLS = [{ cqx: 0.25, cqv: 4, qy: 0.25, qvy: 4 }, { cqx: 0.5, cqv: 4, qy: 0.5, qvy: 4 }, { cqx: 0.125, cqv: 16, qy: 0.125, qvy: 16 },
	{ cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16 }, { cqx: 0.5, cqv: 16, qy: 1, qvy: 16 }];
/** starts the relay (strategy n) from the nearest attempt so far; false when there is nothing to start from */
function relayFrom(n) {
	const V = S.strategies[n], R = V.relay || (V.relay = { back: 0, cells: 0, runs: 0 });
	// (the wall breaker's round: after it, from this step of the plan)
	if (breakerBusy()) { V.deferred = true; return false; }
	// (every move no longer running: the relay's table is 4x larger from now on (launch), so its plan starts over from the
	// nearest attempt: on the ice level every move ended at 35 s, the relay was 3 steps back by then, and the larger table
	// from the nearest attempt went 100 tiles on)
	const alone = !S.strategies.some((x, k) => x.key === 'explore' && alive(kids[k]));
	if (alone && !R.alone && R.runs > 0) Object.assign(R, { back: 0, cells: 0, cellsSet: false, pick: null });
	R.alone = alone;
	// the attempt to go on from (RELAY_PLAN): the nearest one (R.back steps back along it) or a source (R.pick: the same
	// one while its point runs again with finer cells), then the others' own (R.alt), then the nearest with a larger table
	// (R.big)
	let c = S.closest, back = RELAY_BACK[0], src = null;
	R.big = false;
	// (the next step of the plan: another starting point, so its own cells, as after a run that went nowhere)
	const next = () => { R.back++; R.pick = null; R.cellsSet = false; return relayFrom(n); };
	if (R.back < RELAY_PLAN.length) {
		const step = RELAY_PLAN[R.back];
		if (typeof step === 'number') back = step;
		else {
			src = R.pick && R.pick.back === R.back ? sources.get(R.pick.room) || null : null;
			if (!src) src = pickSource(step, c);
			const a = src ? (step === 'new' ? src.early : src.best) : null;
			if (!a) return next();
			// (only the same source keeps the finer cells its last run went on with: a new one gets its own)
			if (!R.pick || R.pick.back !== R.back || R.pick.room !== src.room) R.cellsSet = false;
			R.pick = { back: R.back, room: src.room };
			c = { inputs: a.inputs, ticks: a.ticks, dist: a.dist, tiles: Math.round(a.dist * 10) / 10 };
			back = step === 'new' ? 0 : RELAY_BACK[0];
		}
	} else {
		const alts = S.strategies.filter((q) => q !== V && q.bestTry && q.bestTry.ticks >= RELAY_MIN_TICKS && (!c || Math.abs(q.bestTry.dist - c.dist) > 1));
		const ai = R.back - RELAY_PLAN.length;
		if (ai < alts.length) { const b = alts[ai].bestTry; c = { inputs: b.inputs, ticks: b.ticks, dist: b.dist, tiles: Math.round(b.dist * 10) / 10 }; back = RELAY_BACK[0]; }
		else if (ai === alts.length) { back = RELAY_BACK[2]; R.big = true; }
		// (the plan used up: again from the nearest attempt with the next salt, other states standing for the merged cells,
		// rather than an idle GPU; only after a round that ran)
		// (a yielded every move goes on too: it waited for the relay to run out of starting points)
		else if (R.cycleRuns > 0) { R.salt = (R.salt || 0) + 1; R.back = 0; R.pick = null; R.cycleRuns = 0; R.cellsSet = false; setImmediate(resumeExplore); return relayFrom(n); }
		else return false;
	}
	if (!cur || !c || c.cut || c.viaDeath || c.ticks < RELAY_MIN_TICKS || S.seconds - searchClock(Date.now()) < 3) return false;
	const X = S.strategies.find((q) => q.key === 'explore');
	if (X && !(X.probe === 'slow' || X.refinedOnce || X.state === 'ended' || X.state === 'error' || searchClock(Date.now()) >= RELAY_WAIT_S ||
		(X.refine && X.refine.at && Date.now() - X.refine.at > RELAY_AFTER_REFINE_MS))) return false;
	const keep = c.ticks - Math.min(back, c.ticks - 1);
	// (a start near the level's start is every move's own work: no relay from there)
	if (keep < RELAY_MIN_KEEP) return next();   // (too near the start: the next step of the plan)
	// (a route of T ticks known: only a relay that can still end sooner; a source that cannot: the next step)
	if (S.result && keep >= boundTicks() - 1) return src ? next() : false;
	const file = path.join(dir(), `relay_${n}.eetas`);
	try { fs.writeFileSync(file, Buffer.from(String(c.inputs).slice(0, keep), 'latin1')); } catch (e) { return false; }
	// the cells by where the relay starts: where no gravity pulls (dots, and the like: both speeds free) 4 px cells, else
	// 2 px (a run-up in the start's maze of the dot ring needed them); both with 1/4 px/tick speeds
	// (a new starting point only: a relay that ran out of situations goes on from the same point with finer cells)
	if (!R.cellsSet || !R.src || c.dist < R.src.dist - 0.5) {
		const sim = new E.EESim(cur.level), inp = new E.EEInput();
		sim.reset();
		const str = String(c.inputs);
		for (let t = 0; t < keep; t++) { E.applyMask(inp, (str.charCodeAt(t) - 48) & 31); sim.tick(inp); }
		R.cells = sim.morx === 0 && sim.mory === 0 ? 0 : 1;
		R.cellsSet = true;
	}
	// (src.best: the nearest of all attempts when this run began: "nearer" means nearer than that, also for a run from
	// another strategy's farther attempt)
	Object.assign(R, { file, keep, src: { dist: c.dist, ticks: c.ticks, best: S.closest ? Math.min(S.closest.dist, c.dist) : c.dist } });
	R.runs++; R.cycleRuns = (R.cycleRuns || 0) + 1;
	R.what = src ? `an attempt in room "${src.desc}"` : 'the nearest attempt';
	if (src) { src.runs++; publishSources(); }
	Object.assign(V, { layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: `from tick ${keep} of ${R.what} (${c.tiles} tiles from the trophy)`, passes: R.runs });
	kids[n] = launch(n);
	return true;
}
/** a nearer attempt: a waiting relay starts from it */
function relayKick() {
	if (!S || !S.running || S.halted || S.stage === 'stopped') return;
	S.strategies.forEach((q, k) => {
		if (q.key !== 'relay') return;
		if (q.state === 'waiting' && !alive(kids[k]) && searchClock(Date.now()) >= 3) {
			// (a relay that went through its starting points waits for a nearer attempt than its last, or a new source: then
			// its plan from that step)
			const c0 = S.closest, R0 = q.relay;
			const nearer = !(R0 && R0.src) || !!(c0 && c0.dist < R0.src.best - 0.5);
			if (!nearer && !pickSource('new', c0)) return;
			// (another starting point: its own cells, not the finer ones a run that ran out of situations left behind)
			if (R0) { R0.back = nearer ? 0 : RELAY_PLAN.indexOf('new'); R0.pick = null; R0.cellsSet = false; }
			relayFrom(k);
			return;
		}
		// running from an attempt that is now far behind the nearest one: stopped between two launches, and it starts
		// again from the nearer one (its close handler)
		const R = q.relay, c = S.closest;
		// a run that has not got nearer for RELAY_STALL_MS, well past its start: again from its own nearest attempt (a fresh
		// table, and the cells for where it is now: the dot ring's first run came from outside the dots with 2 px cells and
		// stalled at the ring's top for 10 s; from there with 4 px cells the route took 10 s)
		// (only a run that got nearer itself: a run from further back whose nearest attempt is an earlier run's was sent
		// back there after 8 s, so on the ice level the relay went between two starting points for 2 minutes)
		if (R && R.src && c && c.strategy === q.label && alive(kids[k]) && !kids[k].stopWhy && q.bestAt > kids[k].startedAt && Date.now() - q.bestAt > RELAY_STALL_MS &&
			Date.now() - kids[k].startedAt > RELAY_STALL_MS && c.ticks > R.keep + RELAY_BACK[0] + 30) { R.src = { dist: c.dist + 1, ticks: c.ticks, best: c.dist + 1 }; halt(kids[k], 'nearer'); return; }
		// (not for its own nearer attempts: it is making them, and a restart would throw its table away)
		if (R && R.src && c && c.strategy !== q.label && alive(kids[k]) && !kids[k].stopWhy && Date.now() - kids[k].startedAt > RELAY_SWITCH_MS && c.dist < R.src.best - Math.max(3, 0.1 * R.src.best)) halt(kids[k], 'nearer');
	});
}
// The wall breaker (strategy 'breaker', "past the wall", GPU). The walls analysis (the night of 2026-09-27: the fillers'
// 75 stall records and 776 explores from the known routes' states before three walls, src/out/walls) found the three
// known walls passable for the relay's explore with three settings changed, each tested on its own: no cost ceiling (with
// --costslack 0 of 25 Forgotten Veil explores passed at any grain: the climb raises the reach cost from 191 to 373), 4 px
// positions with 1/16 px/tick speeds (the relay's first 1/4 px/tick cells died at all three walls: slow acceleration, on
// ice or in a run-up, never leaves its cell) and a larger table (2^30 cells, a 2M layer cap: 2^27 failed Forgotten Veil
// and the ice level, 2^28 passed Forgotten Veil from 400 ticks before its wall only); and most stalls are the wrong room
// (5 of 6 stall spots: the needed room was never entered), so the starting points are the rooms' attempts, not only the
// nearest one. So: once the search has had no attempt nearer by BREAK_TILES and no new room for BREAK_WAIT_S (90 s; the
// fillers' longest gap that still ended in progress was 200 s, p90 20-120 s; each trap was reached 20-140 s in, then 300+ s
// of nothing), a round: up to BREAK_STARTS starting points (breakStarts: the nearest attempt BREAK_BACK 150 and 400 ticks
// back, never its end, which can be a dead end; then per room, those the breaker started from least first, rooms with
// territory gain first, where it was entered and its lowest-cost attempt 150 back; a start once per search), each "every
// move" (explore --prefix) with a table of BREAK_MEM_F of the GPU's memory (2^30 cells on 40 GB, 2^31 on 80 GB, 2^27 on
// 8 GB; eegpu halves it when an allocation fails), BREAK_CAP states a layer, BREAK_GRAINS (4 px and 1/16 px/tick; a run
// that runs out of situations the next finer), no --costslack, for BREAK_STEP_S (20 s) steps chained up to BREAK_CHAIN
// times from 60 ticks short of the step's own nearest attempt; the whole round at most BREAK_ROUND_S (300 s). While it
// runs it has the GPU (the scheduler pauses the others). Its attempts are every strategy's: closer() (the nearest attempt,
// the relay's restart), attemptSource() (a source per room: the relay's plan) and the CPU search (stdin "seed <inputs>":
// its workers make cells along them, goexplore.js addSeed). A round that brought nothing (no nearer attempt, no new room
// from any strategy) makes the next wait longer: 90, 180, 360 s. Measured in the analysis's scratch chains (the A100, 2^30):
// Forgotten Veil from 400 / 1000 ticks before its wall one 21-22 s step, the ice level from 150 / 400 / 1000 / 2000 in
// 19 / 20 / 43 / 63 s; Octorage's wall (+75 tiles of climb from a pocket) not: the nearest-cost restarts are its trap.
const BREAK_WAIT_S = [90, 180, 360], BREAK_TILES = 0.5, BREAK_STARTS = 8, BREAK_BACK = [150, 400], BREAK_RESTART = 60, BREAK_CHAIN = 4;
const BREAK_STEP_S = 20, BREAK_ROUND_S = 300, BREAK_CAP = 2097152, BREAK_MEM_F = 0.42, BREAK_REGION = 40, BREAK_REGION_LOG = 28;
const BREAK_GRAINS = [{ cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16 }, { cqx: 0.5, cqv: 16, qy: 0.5, qvy: 16 }, { cqx: 1, cqv: 32, qy: 1, qvy: 32 }];
const BREAK_GRAIN_TEXT = ['4 px and 1/16', '2 px and 1/16', '1 px and 1/32'];
// the GPU memory its table leaves free (explore --reserve, MB: BREAK_RESERVE_F of the GPU's, at least 1 GB): its table
// and states fit the free memory less that, so on a shared GPU the other processes keep room (on the rented H100, shared
// with 31-42 GB of other work, a 2^31 table left the relay's new processes no memory for a context)
const BREAK_RESERVE_F = 0.15;
// A GPU strategy whose tool fails for want of GPU memory (a context it cannot create, an allocation: another process
// holds the memory for a while, e.g. the game or a second search on the same GPU) is started again after GPU_RETRY_S
// (then every last value) instead of staying in error for the whole search (cycle 5: a cuCtxCreate "out of memory" in
// the first seconds on the shared H100 cost Infinity Pain every move, straight and the GPU random runs for 30 min). The
// breaker waits the same way for the table it planned (BREAK_MEM_WAITS a round) before it takes a smaller one.
const GPU_RETRY_S = [5, 20, 60], BREAK_MEM_WAITS = 3;
/** a GPU tool's error that another process's memory explains (and that passes when it frees it) */
const gpuTransient = (e) => /out of memory|CUDA error (2|46)\b|cuCtxCreate|cuDevicePrimaryCtx/i.test(String(e || ''));
const retryTimers = [];   // (strategy k's pending start again, a timeout; the search holds open while one waits)
const retryHolds = () => retryTimers.some(Boolean);
function clearRetries() { for (let k = 0; k < retryTimers.length; k++) { if (retryTimers[k]) clearTimeout(retryTimers[k]); retryTimers[k] = null; } }
/** strategy n's process ended with a transient GPU error (ch: that process): start it again after the back-off (again:
 *  what starts it, launchOrWait by default); false when the search is over or out of time */
function gpuRetry(n, ch, again) {
	const V = S.strategies[n], S0 = S, wait0 = V.retries || 0;
	if (!S.running || S.halted || S.stage === 'stopped' || S.gpuFailed) return false;
	// (a process that ran a while before it failed: the back-off starts over)
	const k = V.retries = ch && ch.startedAt && Date.now() - ch.startedAt > 120000 ? 1 : wait0 + 1;
	const wait = GPU_RETRY_S[Math.min(k - 1, GPU_RETRY_S.length - 1)];
	if (S.seconds - searchClock(Date.now()) - wait < 3) return false;
	S.gpuRetries = (S.gpuRetries || 0) + 1;
	note(`${V.label}: ${V.error}; again in ${wait} s (retry ${k})`);
	Object.assign(V, { state: 'waiting', detail: `the GPU's memory was taken; again in ${wait} s (retry ${k})`, error: null });
	if (retryTimers[n]) clearTimeout(retryTimers[n]);
	retryTimers[n] = setTimeout(() => {
		retryTimers[n] = null;
		if (S !== S0) return;
		// (the breaker's step: breakLaunch ends its round itself when the search is over or out of time)
		if (again && S.running && !alive(kids[n])) { again(); save(); return; }
		if (!S.running || S.halted || S.stage === 'stopped' || S.gpuFailed || alive(kids[n]) || S.seconds - searchClock(Date.now()) < 2) {
			if (V.state === 'waiting' && !alive(kids[n])) V.state = 'ended';
			if (S.running && !running()) finish(); else save();
			return;
		}
		Object.assign(V, { state: 'starting', detail: '' });
		if (again) again(); else launchOrWait(n);
		save();
	}, wait * 1000);
	return true;
}
/** the wall breaker's round is running (from its start to its end, or its process alive): the others' new processes wait (resumeDeferred) */
const breakerBusy = () => !!S && ((!!brk && !!brk.round) || (Array.isArray(S.strategies) && S.strategies.some((q, k) => q.key === 'breaker' && alive(kids[k]))));
/** strategy n's next process, or, while the wall breaker's round runs (its table took the memory), a wait for its end */
function launchOrWait(n) {
	if (!breakerBusy()) { kids[n] = launch(n); return; }
	Object.assign(S.strategies[n], { state: 'waiting', detail: 'waits while the wall breaker has the GPU', deferred: true });
}
/** the round is over: the processes that waited for it start (the relay from its plan's step) */
function resumeDeferred() {
	if (!S || !S.running || breakerBusy()) return;
	// (a search stopped, out of time or with a failed GPU: they end)
	const go = !S.halted && S.stage !== 'stopped' && !S.gpuFailed && S.seconds - searchClock(Date.now()) >= 2;
	S.strategies.forEach((q, k) => {
		if (!q.deferred || alive(kids[k])) return;
		q.deferred = false;
		if (!go) { if (q.state === 'waiting') q.state = 'ended'; return; }
		if (q.key === 'relay') { if (!relayFrom(k)) Object.assign(q, { state: 'waiting', detail: 'waits for a nearer attempt to go on from' }); }
		else { Object.assign(q, { state: 'starting', detail: '' }); kids[k] = launch(k); }
	});
	if (!running()) finish(); else save();
}
/** a round of the wall breaker holds the search open: from its start (the others stopped for it, the breaker not yet
 *  started) until the processes that waited for it have started again */
const breakHolds = () => !!S && S.running && !S.halted && S.stage !== 'stopped' && !S.gpuFailed && ((!!brk && !!brk.round) || S.strategies.some((q) => q.deferred));
// The stall target (C-steer, 2026-09-27): on a level whose steer field has the coin DP (a coin door on the plan), a
// breaker run aims at the coin plan's next gate (steer.js nextGate: the untaken coin with the least leg + rest of the
// tour from the run's start), ordered by that coin's leg field (--reach, no --steer; --finish kept: explore reports its
// closest attempt only then); its closest attempt on the coin (GATE_AT) ends the run and the chain goes on from it with
// the next gate (at most BREAK_GATES a chain). The gate order checked against the known routes
// (src/out/csteer): the DP's first choice was the route's next coin on Forgotten Veil in 11 of 15, Good Egg 12 of 17,
// Stupid Fox 6 of 14, while the steer lookup (the least of the DP and the layer's own field) took the layer field, the
// way that needs no more coins, before Forgotten Veil's coins 1-4 and Stupid Fox's 1-8: the search went for a way the
// known routes never take. No DP (or no leg with a value): the trophy, as before. `b.breakGate === false`: off.
const BREAK_GATES = 16;
// a gate run's closest attempt at most this far (tiles, by the coin's leg field) is at the gate: 0 = on the coin's tile
const GATE_AT = 0.2;
/** the coin plan's next gate from the state after inputs: {x, y} (tiles) or null; the steer file read once a search */
function breakGate(inputs) {
	if (!cur || !cur.opts.breakGate || !S.steer || !S.steer.dp || !cur.files.steerCpu) return null;
	try {
		if (cur.gateSteer === undefined) {
			cur.gateSteer = null;
			const buf = fs.readFileSync(cur.files.steerCpu);
			const st = SF.readSteerFile(buf);
			if (st && st.dp) {
				const tiles = new Map(), cb = cur.level.coinBit;
				if (cb) for (let t = 0; t < cb.length; t++) if (cb[t] >= 0) tiles.set(cb[t], t);
				cur.gateSteer = { st, tiles, buf, files: new Map() };
			}
		}
		const G0 = cur.gateSteer;
		if (!G0) return null;
		const sim = new E.EESim(cur.level), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < inputs.length; t++) { E.applyMask(inp, (inputs.charCodeAt(t) - 48) & 31); sim.tick(inp); }
		const g = SF.nextGate(G0.st, sim);
		const t = g ? G0.tiles.get(g.bit) : undefined;
		if (t === undefined) return null;
		// the run's order: the coin's own leg field (RCH3, the coin its only goal: the file's body, written once), not the
		// steer field, which on Forgotten Veil points the other way (the layer field) and cut the states heading for the coin
		const b = G0.st.dp.leg[g.i];
		let reach = G0.files.get(b);
		if (!reach) {
			reach = path.join(dir(), `gate_${b}.rch3`);
			fs.writeFileSync(reach, G0.buf.subarray(G0.st.bodyOff[b], G0.st.bodyOff[b] + G0.st.bodySize[b]));
			G0.files.set(b, reach);
		}
		return { x: t % cur.level.width, y: Math.floor(t / cur.level.width), reach };
	} catch (e) { return null; }
}
// The room's next target (the guidance study, 2026-09-28): where the coin plan gives no gate (no steer field, a late
// one, or one with no value there: Forgotten Helix's has none at the start), a breaker run aims at the targets the
// state's own room reaches (bursts.js roomAim: the walk with the doors as that room holds them, killing tiles closed,
// portals forward; its goals the triggers whose touch makes a room the search has not seen, and the trophy), not at
// the trophy by the reach field's walk through every door. On Forgotten Helix that walk ranked a viewing pocket behind
// two 16-coin doors (15 coins in the level) nearest of all, and every breaker round went there (58 runs, 'nothing
// nearer, no new room'), while the frontier (3 coins) needed coin 4. Its closest attempt on a goal is a gate as with the
// coin plan (GATE_AT). No such target: the trophy, as before. `b.roomGate === false`: off.
function roomGate(inputs) {
	if (!cur || !cur.opts.roomGate) return null;
	try {
		const L = cur.level;
		// (the reach file's header and classes: cur.reachLookup only while the steer field is used, so read here once)
		if (!cur.roomAimT) cur.roomAimT = { RM: GX.roomOf(L), TR: BU.triggersOf(L), PT: BU.portalsOf(L), fp: G.blobFp(G.levelBlob(L)), n: 0,
			look: cur.reachLookup || SF.readReachBytes(fs.readFileSync(cur.files.reach)) };
		const T = cur.roomAimT;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < inputs.length; t++) { E.applyMask(inp, (inputs.charCodeAt(t) - 48) & 31); sim.tick(inp); }
		if (sim.is_dead) return null;
		const known = (k) => sources.has(k) || (!!brk && brk.seen.has(k));
		const aim = BU.roomAim(L, T.RM, sim, known, T);
		if (!aim || !(aim.start < RF.CUT)) return null;
		const reach = path.join(dir(), `gate_room_${T.n++ % 8}.rch3`);
		const f = Object.assign({}, T.look, { mode: 'walk', walk: aim.walk, prioShift: Math.max(0, (32 - Math.clz32(aim.mx)) - 12) });
		RF.writeReachFile(f, reach, T.fp);
		return { x: aim.x, y: aim.y, reach, room: true, goals: aim.goals.length };
	} catch (e) {
		if (cur && !cur.roomAimErr) { cur.roomAimErr = true; note(`past the wall: no room target (${e.message}); the trophy as before`); }
		return null;
	}
}
/** the coins the state after inputs holds, as the room keys count them (gold where a coin door or gate reads them, blue
 *  where a blue one does; goexplore.js roomOf): the wall breaker's progress order of its starting points */
function coinsOf(inputs) {
	const L = cur.level;
	if (!cur.countDoors) {
		let gold = false, blue = false;
		for (let i = 0; i < L.fg.length; i++) { const id = L.fg[i]; if (id === 43 || id === 165) gold = true; else if (id === 213 || id === 214) blue = true; }
		cur.countDoors = { gold, blue };
	}
	const D = cur.countDoors;
	if (!D.gold && !D.blue) return 0;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < inputs.length; t++) { E.applyMask(inp, (inputs.charCodeAt(t) - 48) & 31); sim.tick(inp); }
	return (D.gold ? sim.coins | 0 : 0) + (D.blue ? sim.blue_coins | 0 : 0);
}
/** a room's coins from its description (goexplore.js roomOf desc: 'coins=N', 'bluecoins=N' where a door reads them) */
const coinsOfDesc = (desc) => { let n = 0; for (const m of String(desc || '').matchAll(/(?:^|\s)(?:blue)?coins=(\d+)/g)) n += +m[1]; return n; };
/** the breaker's table (log2 cells) for a GPU of memMB: BREAK_MEM_F of it at 16 bytes a cell, 2^24 .. 2^31 */
const breakCells = (memMB) => Math.max(24, Math.min(31, Math.floor(Math.log2((memMB > 0 ? memMB : 8192) * 1048576 * BREAK_MEM_F / 16))));
// the stall clock and the rounds: {at (the last progress, ms), mark (S.closest.dist then), rooms (the room keys seen),
// level (BREAK_WAIT_S index), tried (the starting points used: sha1 of the inputs), rounds, round, seeds}
let brk = null;
/** the search got somewhere (why: 'nearer' by BREAK_TILES, or 'room' for a new room): the stall clock starts over */
function breakProgress(why) {
	if (!brk) return;
	brk.at = Date.now();
	if (brk.round) brk.round.progress.push(why);
	if (S.breaker) S.breaker.last = { why, after: Math.round((Date.now() - S.started) / 100) / 10 };
}
/** the round's starting points: up to BREAK_STARTS {inputs, what, dist, key, room} not used before in this search */
function breakStarts() {
	// (breakFrom, the measurements' walls: the one starting point of the first round)
	if (cur.opts.breakFrom) return brk.rounds ? [] : [{ inputs: cur.opts.breakFrom, what: 'the given start', dist: 0, key: 'from', room: undefined }];
	// (the progress order, `breakProg`: the candidates' coins held first, the most first (a coin-sequence level's frontier:
	// Forgotten Helix's rounds started from its viewing pocket at 0 coins, the trophy-nearest attempt by a walk through
	// every door, and from rooms 0-2, while the search's frontier held 3 coins); among equals the order as before. No
	// coin door (no coins in the room keys): the order as before)
	const prog = cur.opts.breakProg, lim = prog ? 4 * BREAK_STARTS : BREAK_STARTS;
	const out = [], seen = new Set();
	const add = (inputs, keep, what, dist, room, coins) => {
		keep = Math.min(keep, inputs.length);
		if (out.length >= lim || keep < RELAY_MIN_KEEP || (S.result && keep >= boundTicks() - 1)) return;
		const pre = inputs.slice(0, keep), key = crypto.createHash('sha1').update(pre).digest('hex');
		if (seen.has(key) || brk.tried.has(key)) return;
		seen.add(key);
		out.push({ inputs: pre, what, dist, key, room, coins: prog ? (coins !== undefined ? coins : coinsOf(pre)) : 0, n: out.length });
	};
	// (the gate front: the last gate a breaker chain entered, that state itself, so the next gate is the plan's next)
	// (with the progress order by its own coins, first among equals: a room target's gate can be a lateral room, e.g.
	// Forgotten Helix's low gravity at 2 coins, and the frontier of 3 coins goes first then)
	if (brk.front) add(brk.front.inputs, brk.front.inputs.length, `the last gate the breaker entered (gate ${brk.front.gates} of its chain)`, 0, undefined);
	const c = S.closest;
	if (c && !c.cut && c.inputs) for (const b of BREAK_BACK) add(String(c.inputs), c.ticks - b, `the nearest attempt, ${b} ticks back`, c.dist, undefined);
	const far = (x) => (x.best ? x.best.dist : 1e9);
	const rooms = [...sources.values()].sort((x, y) => (x.brk || 0) - (y.brk || 0) || (y.gain > 0) - (x.gain > 0) || far(x) - far(y));
	for (const r of rooms) {
		if (out.length >= lim) break;
		const k = coinsOfDesc(r.desc);
		if (r.early) add(r.early.inputs, r.early.ticks, `where room "${r.desc}" was entered`, r.early.dist, r.room, k);
		if (r.best) add(r.best.inputs, r.best.ticks - BREAK_BACK[0], `room "${r.desc}"'s nearest attempt, ${BREAK_BACK[0]} ticks back`, r.best.dist, r.room, k);
	}
	if (prog) out.sort((x, y) => y.coins - x.coins || x.n - y.n);
	return out.slice(0, BREAK_STARTS);
}
/** every 5 s (checkStalls): a stalled search starts a round of the wall breaker */
function breakKick() {
	if (!S || !S.running || S.halted || S.stage === 'stopped' || S.result || S.gpuFailed || !brk || !cur || brk.round) return;
	const n = S.strategies.findIndex((q) => q.key === 'breaker');
	if (n < 0 || alive(kids[n]) || S.strategies[n].state !== 'waiting') return;
	const wait = cur.opts.breakWait[Math.min(brk.level, cur.opts.breakWait.length - 1)];
	if (Date.now() - brk.at < wait * 1000 || S.seconds - searchClock(Date.now()) < 10) return;
	const starts = breakStarts();
	if (!starts.length) { brk.at = Date.now(); return; }   // (nothing new to start from: the clock again)
	brk.rounds++;
	brk.round = { starts, i: 0, t0: Date.now(), progress: [], runs: 0, chain: null, wait };
	S.breaker = Object.assign(S.breaker || {}, { rounds: brk.rounds, round: { n: brk.rounds, starts: starts.length, runs: 0, after: Math.round((Date.now() - S.started) / 100) / 10 } });
	note(`${S.strategies[n].label}: no attempt nearer by ${BREAK_TILES} tiles and no new room for ${wait} s: round ${brk.rounds}, ${starts.length} starting point${starts.length > 1 ? 's' : ''} (${starts.map((x) => x.what).join('; ')})`);
	// every move's and the relay's processes stop (between two launches) and wait for the round's end: their tables and
	// states (every move's up to a third of the GPU) are the breaker's table; the random runs and the beams stay, paused
	const freed = [];
	S.strategies.forEach((q, k) => { if ((q.key === 'explore' || q.key === 'relay') && alive(kids[k]) && !kids[k].stopWhy) { halt(kids[k], 'breaker'); freed.push(k); } });
	Object.assign(S.strategies[n], { state: 'starting', detail: `round ${brk.rounds}: waits for every move and the relay to hand over the GPU's memory` });
	const t0 = Date.now(), S0 = S;
	const go = () => {
		if (S !== S0 || !brk || !brk.round) return;
		// (their processes end at their next launch; a halt kills them after HALT_KILL_MS)
		if (freed.some((k) => alive(kids[k])) && Date.now() - t0 < HALT_KILL_MS + 3000) { const t = setTimeout(go, 100); if (t.unref) t.unref(); return; }
		breakLaunch(n);
	};
	go();
}
/** the round's next run (the chain's next step, or the next starting point); false when the round is over */
function breakLaunch(n) {
	const V = S.strategies[n], R = brk && brk.round;
	if (!R || !cur || !S.running || S.halted || S.stage === 'stopped' || S.gpuFailed) return breakEnd(n);
	while (!R.chain && R.i < R.starts.length) {
		const st = R.starts[R.i++];
		brk.tried.add(st.key);
		const src = st.room !== undefined ? sources.get(st.room) : null;
		if (src) { src.brk = (src.brk || 0) + 1; publishSources(); }
		R.chain = { inputs: st.inputs, step: 1, grain: 0, what: st.what };
	}
	const roundLeft = cur.opts.breakRound - (Date.now() - (R.clock || R.t0)) / 1000, left = S.seconds - searchClock(Date.now());
	if (!R.chain || S.result || roundLeft < 3 || left < 3) return breakEnd(n);
	const ch = R.chain, file = path.join(dir(), `break_${n}.eetas`);
	try { fs.writeFileSync(file, Buffer.from(ch.inputs, 'latin1')); } catch (e) { return breakEnd(n); }
	const cellLog = cur.opts.breakCells || breakCells(toolInfo && toolInfo.memMB);
	// (a small table: a box of BREAK_REGION tiles around the start, as the analysis's 2^28 runs had)
	let region = '';
	if (cellLog <= BREAK_REGION_LOG) {
		const sim = new E.EESim(cur.level), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < ch.inputs.length; t++) { E.applyMask(inp, (ch.inputs.charCodeAt(t) - 48) & 31); sim.tick(inp); }
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		region = `${tx - BREAK_REGION},${ty - BREAK_REGION},${tx + BREAK_REGION},${ty + BREAK_REGION}`;
	}
	const reserve = Math.max(1024, Math.round(BREAK_RESERVE_F * (toolInfo && toolInfo.memMB > 0 ? toolInfo.memMB : 8192)));
	// (the stall target: the coin plan's next gate from this start, once per chain step; none: the trophy)
	if (ch.gate === undefined) ch.gate = breakGate(ch.inputs) || roomGate(ch.inputs);
	// (a gate run keeps --finish, ordered by the coin's leg field, and its closest attempt at the coin (cost 0) is the
	// gate: closer(); explore --enter would report no closest attempt, so no chain)
	V.brk = { file, keep: ch.inputs.length, cells: BREAK_GRAINS[ch.grain], cellLog, region, reserve, gateReach: ch.gate ? ch.gate.reach : '', gateHit: null, seconds: Math.max(1, Math.round(Math.min(cur.opts.breakStep, roundLeft, left))) };
	R.runs++;
	if (S.breaker && S.breaker.round) S.breaker.round.runs = R.runs;
	if (S.breaker) S.breaker.cellLog = cellLog;   // (the table asked; a warn line says when it got less)
	// (its own nearest attempt per run: the chain's next step starts from it, and each run's nearer attempts are sources)
	Object.assign(V, { layer: 0, states: 0, ticksPerSec: 0, state: 'starting', best: undefined, bestAt: 0, bestTry: null, passes: (V.passes || 0) + 1,
		detail: `round ${brk.rounds}: from tick ${ch.inputs.length} of ${ch.what}${ch.step > 1 ? ` (step ${ch.step})` : ''}${ch.gate ? `, to ${ch.gate.room ? `the room's next target${ch.gate.goals > 1 ? ` (of ${ch.gate.goals} goal tiles)` : ''} at` : 'the coin at'} (${ch.gate.x}, ${ch.gate.y})` : ''}, cells of ${BREAK_GRAIN_TEXT[ch.grain]} px/tick, 2^${cellLog} of them` });
	kids[n] = launch(n);
	return true;
}
/** a breaker run ended (how: its end): finer cells from the same start, the chain's next step, or the next starting point */
function breakAfter(n, how) {
	const V = S.strategies[n], R = brk && brk.round;
	if (!R) return breakEnd(n);
	if (!R.chain) return breakLaunch(n);   // (its run failed: the next starting point)
	const ch = R.chain, b = V.bestTry;
	const hit = V.brk && V.brk.gateHit;
	if (hit) {
		// the coin plan's next gate entered: the attempt goes to the other strategies (the CPU search's archive: a new
		// room where a door reads the coins; a new room with territory gain is the stall clock's progress there) and the
		// chain's next step starts from it with the next gate (at most BREAK_GATES a chain)
		seedCpu(hit);
		// (the gate front: a chain that keeps entering gates is not cut by the round's clock (BREAK_ROUND_S counts from
		// its last gate), and the next round starts from its last gate first: breakStarts)
		if (cur.opts.breakFront) { R.clock = Date.now(); brk.front = { inputs: hit, gates: (ch.gates || 0) + 1 }; }
		R.chain = (ch.gates || 0) + 1 < BREAK_GATES ? { inputs: hit, step: ch.step, grain: 0, what: ch.what, gates: (ch.gates || 0) + 1 } : null;
	} else if (how === 'exhausted' && ch.grain + 1 < BREAK_GRAINS.length) ch.grain++;   // (every situation tried at this grain: finer, the same start)
	else if (b && ch.step < BREAK_CHAIN && b.ticks - BREAK_RESTART >= ch.inputs.length + BREAK_RESTART) {
		// its nearest attempt went on: the next step from 60 ticks short of it (a fresh table)
		R.chain = { inputs: b.inputs.slice(0, b.ticks - BREAK_RESTART), step: ch.step + 1, grain: 0, what: ch.what };
		seedCpu(b.inputs);
	} else {
		if (b) seedCpu(b.inputs);
		R.chain = null;
	}
	return breakLaunch(n);
}
/** the round is over: the breaker waits (the next round after BREAK_WAIT_S without progress; longer after one that brought
 *  nothing) */
function breakEnd(n) {
	const V = S.strategies[n], R = brk && brk.round;
	if (brk) {
		brk.round = null;
		if (R && cur) {
			brk.level = R.progress.length ? 0 : Math.min(brk.level + 1, cur.opts.breakWait.length - 1);
			note(`${V.label}: round ${brk.rounds} over (${R.runs} run${R.runs === 1 ? '' : 's'}, ${Math.round((Date.now() - R.t0) / 1000)} s): ` +
				`${R.progress.length ? `the search got on (${[...new Set(R.progress)].join(', ')})` : 'nothing nearer, no new room'}; the next after ${cur.opts.breakWait[brk.level]} s without progress`);
			if (S.breaker) S.breaker.round = null;
		}
		brk.at = Date.now();
	}
	setImmediate(resumeDeferred);
	if (V.state === 'found' || !S.running || S.halted || S.stage === 'stopped') return false;
	Object.assign(V, { state: 'waiting', detail: `waits for the search to stall (no attempt nearer by ${BREAK_TILES} tiles and no new room for ${cur && brk ? cur.opts.breakWait[brk.level] : BREAK_WAIT_S[0]} s)` });
	return false;
}
/** the CPU search's workers make cells along an attempt (goexplore.js "seed <inputs>") */
function seedCpu(inputs) {
	if (!S || !inputs || !brk) return;
	S.strategies.forEach((q, k) => {
		const ch = kids[k];
		if (q.cpu && alive(ch) && ch.stdin && !ch.stdin.destroyed) { try { ch.stdin.write(`seed ${inputs}\n`); } catch (e) { /* gone */ } }
	});
	brk.seeds = (brk.seeds || 0) + 1;
	if (S.breaker) S.breaker.seeds = brk.seeds;
}
// the salt tries (the finest pass, and any pass's salt reruns) run up to LANES salts side by side in one eegpu process
// (explore --lanes=auto: lane k = salt + k, cells of its own; the tool starts with --lanesStart (the last run's lanes,
// 1 at first) and doubles them while that raises the tries per second by 10% or more, halves them when a batch fills
// the cell table). Measured on the RTX 3080 Laptop GPU (throttled to 210-780 MHz, shared with a job's GPU searcher):
// a try of the finest pass on user30s keeps the GPU ~65% busy with one lane; fixed 4 or more lanes were no faster there
// and filled the table on the shaft level, so the tool picks the count by what it measures.
const LANES = 8;
// near-miss refinement (explore --refine=1, on by default; start option refine: false = off): after a salt try runs out of
// situations, the tool takes the states that came nearest to the tiles no state entered next to reached ones, and the
// later tries tell situations on those states' paths apart 4x finer in x and in x speed. A pixel-exact route shares its
// floors and jump arcs with those near misses. user30s (the user's 50x50 shaft level, a 263-tick route through a one-tile
// pocket): the route 2.9 s after the tool's start, in the first refined try, where 17 salt tries in 90 s found none; the
// 40x25 shaft level: 2.5 s (before: the 17th salt). Side by side lanes made a refined try slower (5.5 s on user30s:
// both lanes refined), so with refinement the tries run one at a time.
/** the exploration's cells in pass p: px x cqx, vx x cqv to whole numbers; py x qy, vy x qvy likewise (0 = exact) */
function passCells(p) {
	const v = 2 ** Math.max(0, p);   // (the speed cells: pass 0's in the coarser passes)
	return { cqx: 0.5 * 2 ** p, cqv: 16 * v, qy: p >= PASS_MAX ? 0 : 2 ** p, qvy: p >= PASS_MAX ? 0 : 16 * v };
}
/** how finely the exploration's pass p tells situations apart: x position and speeds (heights are twice as fine) */
const passGrain = (p) => ({ '-2': '8 px and 1/16 px/tick', '-1': '4 px and 1/16 px/tick', 0: '2 px and 1/16 px/tick', 1: '1 px and 1/32 px/tick', 2: '1/2 px and 1/64 px/tick, heights exact' })[p];
/**
 * The exploration's next pass after pass p ended `how` (null = none): 'full' (its visited-cell table filled) or
 * 'time' (its share of the time ran out) -> the coarser pass (none left: the finer one again, if it ran out of its
 * share); 'exhausted' (every situation tried), 'finish' (a route), 'depth' or 'beaten' (no route faster than the known
 * one got to) -> the finer pass. ends: how the earlier passes ended ({pass: {how, seconds, layer}}); a pass does not run
 * twice (it would find the same), except one that ran out of its share of the time, when more time is left now and it
 * had not already searched as deep as a faster route would be. With a route known, a finer pass that already ended
 * without a faster one is passed over for the next finer one, unless it filled its table or used up its time short of
 * that depth (a finer one would too, sooner). routeTicks: the fastest route's ticks (0 = none yet); left: the seconds left.
 */
function nextPass(p, how, ends, routeTicks, left) {
	if (routeTicks && routeTicks <= 1) return null;
	const again = (e) => e.how === 'time' && left > e.seconds + 1 && !(routeTicks && e.layer >= routeTicks - 1);
	if (how === 'full' || how === 'time') {
		const e = ends[p - 1], f = ends[p + 1];
		if (p - 1 >= PASS_MIN && (!e || again(e))) return p - 1;
		return p + 1 <= PASS_MAX && f && again(f) ? p + 1 : null;
	}
	if (!(how === 'exhausted' || how === 'finish' || how === 'beaten' || (how === 'depth' && routeTicks))) return null;
	for (let q = p + 1; q <= PASS_MAX; q++) {
		const e = ends[q];
		if (!e || again(e)) return q;
		if (!routeTicks || ((e.how === 'full' || e.how === 'time') && e.layer < routeTicks - 1)) return null;
	}
	return null;
}
/** the seconds pass p gets (left: what is left of the search): while a coarser pass is untried, a share (a third, at
 *  least 20 s), so that the coarser pass gets the rest if this one is slow; else all of it */
const passSeconds = (p, ends, left) => (p > PASS_MIN && !ends[p - 1] ? Math.min(left, Math.max(20, Math.round(left / 3))) : left);
let S = null;        // the current / last search (public state, also in solve.json)
let kids = [];       // the processes of the running search (one per strategy: eegpu, or node src/goexplore.js)
const busy = new Set();   // those whose end is not handled yet (a strategy's next pass is launched there)
let cur = null;      // { level, buf } of the running search
const stateFile = () => path.join(dir(), 'solve.json');
// solve.json keeps the search for the next start of the app (the page reads S from memory): written at most every
// SAVE_MS while a search runs (every event used to write it, an atomic write each: ~90 "layer" events per second from
// every move's fast tries plus the beams' kept the server's thread busy for most of a search, so the page and Stop
// waited 20 s and more for an answer), and at once when a search starts or ends
const SAVE_MS = 500;
let saveTimer = null;
function saveNow() {
	if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
	try { C.writeJSON(stateFile(), S); } catch (e) { /* read-only data folder: memory only */ }
}
function save() {
	if (saveTimer) return;
	saveTimer = setTimeout(saveNow, SAVE_MS);
	if (saveTimer.unref) saveTimer.unref();
}
function note(s) { S.log.push(`${new Date().toTimeString().slice(0, 8)} ${s}`); S.log = S.log.slice(-30); }
// The clocks. Each eegpu process first loads its kernels (the first load after a build is the NVIDIA driver compiling
// them for this graphics card: a minute or more on a laptop CPU, then seconds) and says {"ev":"ready"}; its --seconds
// count from there. A strategy's time (V.usedMs + the running process's time since its ready) is what its passes and
// shares are cut from; the search's clock (the page's "N s of M s") runs from the first GPU strategy's ready (from the
// start when the CPU searches alone). The CPU strategy searches from its start.
const PREP_NOTE_MS = 3000;   // a GPU strategy still loading after this: the page says the engine is being prepared
/** a strategy's search seconds so far */
const usedSec = (V, now) => (V.usedMs + (V.readyAt ? (now || Date.now()) - V.readyAt : 0)) / 1000;
/** a GPU strategy whose process has not loaded its kernels yet */
const loading = (q) => !q.cpu && q.live && !q.readyAt;
/** the search's clock (s): from the first GPU strategy's ready; from the start without one (CPU only, or none got ready) */
function searchClock(now) {
	if (S.searchStarted) return Math.max(0, (now - S.searchStarted) / 1000);
	return S.strategies.some(loading) ? 0 : (now - S.started) / 1000;
}
/** the current or last search */
function state() {
	if (!S) {
		S = C.readJSON(stateFile(), null) || { running: false, stage: 'idle', log: [] };
		if (S.running) { S.running = false; S.stage = 'stopped'; S.message = 'The search stopped when the app closed.'; }
	}
	const now = Date.now();
	const o = Object.assign({}, S, { elapsed: S.running ? (now - S.started) / 1000 : S.elapsed });
	if (S.running && Array.isArray(S.strategies)) {
		// preparing: a GPU strategy has been loading its kernels for a while (the first search after an update)
		o.strategies = S.strategies.map((q) => (loading(q) && now - q.launchedAt > PREP_NOTE_MS ? Object.assign({}, q, { preparing: true }) : q));
		o.preparing = !S.searchStarted && o.strategies.some((q) => q.preparing);
		o.searchElapsed = searchClock(now);
	}
	return o;
}
const alive = (ch) => !!(ch && ch.exitCode === null && ch.signalCode === null);
let building = false;       // the physics check of a starting search (a worker thread) is under way
let searchGen = 0;          // the search whose physics check / tool check is awaited (a stop or a newer search ends the wait)
const running = () => busy.size > 0 || building || breakHolds() || retryHolds();
/** ends a strategy's process; why: how its pass counts ('beaten', 'finish', 'stopped'). The GPU tool is asked to stop
 *  (its stop file: it ends between two kernel launches, within about one; killing it while a kernel runs makes the
 *  NVIDIA driver reset the GPU) and killed only if it is still running 2 s later; the CPU search is killed. */
const HALT_KILL_MS = 2000;
function halt(ch, why) {
	if (!alive(ch)) return;
	ch.stopWhy = ch.stopWhy || why;
	if (ch.stopFile) {
		if (ch.haltTimer) return;
		try { fs.writeFileSync(ch.stopFile, why); } catch (e) { /* the kill below */ }
		ch.haltTimer = setTimeout(() => { if (alive(ch)) { try { ch.kill(); } catch (e) { /* gone */ } } }, HALT_KILL_MS);
		if (ch.haltTimer.unref) ch.haltTimer.unref();
		return;
	}
	try { ch.kill(); } catch (e) { /* gone */ }
}

/**
 * Starts a route search. b: { eelvlB64 (the level as .eelvl bytes; or `level`, the editor's JSON), guide: [[x, y], ...]
 * (px, the ball's centre; optional), seconds (60), width (beam states per tick, 32768), depth (ticks; the beams 6000, the
 * CPU search 100000), name,
 * workers (the CPU search's threads; default cpuWorkers()), seed (the CPU search's first seed, 1) }.
 * gpu: the server's GPU processor record ({available, why}): without one (or without the native engine, or on a level
 * it cannot run) the CPU search runs alone, with a note. Throws with `problems` when the level is not ready.
 * test (test/editor.js; not from HTTP): { tool: [command, ...arguments] } runs that instead of the native engine;
 * cpu: false leaves the CPU search out, [command, ...arguments] runs that instead of node src/goexplore.js; beams:
 * false leaves the GPU beams out (measurements of "every move" alone); reach: fields that override the physics check's
 * answer (e.g. {startCost: -1}: the model rules the start out); prover: [command, ...arguments] runs that instead of
 * the native tool's `prove` (false: no proof), proveSeconds its budget (at most the search's), proveWatchdogS the time
 * after it before a silent proof is killed (PV.WATCHDOG_S).
 */
function start(b, gpu, test) {
	if (running()) throw new Error('a route search is already running (one at a time): wait for it, or stop it');
	const buf = b.eelvlB64 ? Buffer.from(String(b.eelvlB64), 'base64') : b.level ? eelvlOf(b.level) : null;
	if (!buf || !buf.length) throw new Error('missing eelvlB64 (the level as .eelvl bytes, base64)');
	const ins = inspect(buf);
	if (ins.problems.length) { const e = new Error(ins.problems.map((q) => q.text).join(' ')); e.problems = ins.problems; throw e; }
	const [tool, ...toolArgs] = test && test.tool ? test.tool : [G.nativeTool()];
	// no GPU search: no native engine in this build, no NVIDIA GPU, or a level the native engine cannot run
	let noGpu = '';
	if (gpu && !gpu.available) noGpu = `no NVIDIA GPU is available (${gpu.why || 'none found'})`;
	else if (!tool) noGpu = 'the GPU engine is not part of this build (node tools/build-native.js)';
	else { const why = G.unsupported(ins.level); if (why) noGpu = `the GPU engine cannot run this level (${why})`; }
	const cpu = !(test && test.cpu === false);
	if (noGpu && !cpu) throw new Error(`the route search cannot run: ${noGpu}, and the CPU search is off`);
	const pts = Array.isArray(b.guide) ? b.guide.filter((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)) : [];
	if (pts.length > 4000) throw new Error('the guide line has too many points (at most 4000)');
	const guide = pts.length >= 2 ? pts : [];
	const seconds = Math.max(3, Math.min(10800, Math.round(+b.seconds || 60)));
	const width = Math.max(1024, Math.min(131072, Math.round(+b.width || 32768)));
	// ticks deep; the tool keeps 4 bytes per state per tick to spell out the route (at most ~0.6 GB per search)
	const depth = Math.max(100, Math.min(20000, Math.floor(6e8 / (4 * width)), Math.round(+b.depth || 6000)));
	// (the CPU search keeps no such table: its depth is neither cut by the beams' width nor their default)
	const cpuDepth = Math.max(100, Math.min(200000, Math.round(+b.depth || 100000)));
	const d = dir();
	fs.mkdirSync(d, { recursive: true });
	const levelHash = levelHashOf(buf);
	const files = { eelvl: path.join(d, 'level.eelvl'), bin: path.join(d, 'level.bin'), guide: path.join(d, 'guide.txt'), route: path.join(d, 'route.eetas'),
		reach: `${reachBase(levelHash)}.bin` };
	fs.writeFileSync(files.eelvl, buf);
	if (!noGpu) fs.writeFileSync(files.bin, G.levelBlob(ins.level));
	try { fs.unlinkSync(files.route); } catch (e) { /* none */ }
	if (guide.length && !noGpu) fs.writeFileSync(files.guide, guide.map(([x, y]) => `${x} ${y}`).join('\n') + '\n');
	const beams = !(test && test.beams === false);
	const relay = b.relay !== false && (!test || test.relay === true);
	// (the wall breaker: with the relay, whose sources it starts from; test: breaker true)
	const breaker = relay && b.breaker !== false && (!test || test.breaker === true);
	// (the GPU random runs: on the levels the CPU search gives coarse cells, above 50 x 50)
	const rolls = !noGpu && b.rolls !== false && (test ? test.rolls === true : GX.cellsFor(ins.level) === 'coarse');
	// the one search (ONE_LABEL): coarse cells (above GX.FINE_MAX_TILES), the GPU, the CPU search; b.one === false: the
	// relay as before (tests: test.one === true); the wall breaker next to either (its attempts go into the CPU search's
	// archive: the one search's archive where it runs)
	const one = !noGpu && cpu && ins.level.width * ins.level.height > GX.FINE_MAX_TILES && b.one !== false && (!test || test.one === true);
	const which = [...(noGpu ? [] : !beams ? ['explore'] : guide.length ? ['explore', 'guide', 'goal'] : ['explore', 'goal']), ...(noGpu || !relay || one ? [] : ['relay']), ...(noGpu || !breaker ? [] : ['breaker']),
		...(rolls ? ['gorolls'] : []),
		...(cpu ? ['goexplore'] : [])];
	const workers = cpuWorkers(b.workers);
	const seed = Number.isInteger(+b.seed) && +b.seed >= 0 ? +b.seed : 1;
	// the most salt tries the exploration runs side by side (eegpu explore --lanes=auto --lanesMax): LANES by default
	const lanes = Number.isInteger(+b.lanes) && +b.lanes >= 1 ? Math.min(64, +b.lanes) : LANES;
	const name = String(b.name || ins.json.world_name || 'level').slice(0, 80);
	const t0 = Date.now();
	S = { running: true, stage: 'checking the physics', started: t0, searchStarted: 0, prepSec: 0, elapsed: 0, seconds, width, depth, guidePoints: guide.length, name,
		size: [ins.level.width, ins.level.height], start: ins.start, trophies: ins.trophies.length, notes: ins.notes, reach: ins.reach, levelHash,
		layer: 0, tick: 0, states: 0, ticksPerSec: 0, result: null, closest: null, message: '', log: [], workers: cpu ? workers : 0,
		cleanMode: cleanModeOf(b.clean),
		physics: null, cpuOnly: noGpu ? cpuOnlyText(noGpu, workers, guide) : '',
		strategies: which.map((k) => ({ key: k, label: k === 'goexplore' && one ? ONE_LABEL : STRATEGIES[k].label, cpu: !!STRATEGIES[k].cpu, rolls: !!STRATEGIES[k].rolls,
			...(k === 'goexplore' && one ? { gpuShare: true } : {}), state: 'starting', layer: 0, deepest: 0, states: 0, ticksPerSec: 0,
			found: null, error: null, live: false, pass: k === 'explore' && (!test || test.probe) ? PASS_MAX : PASS_START, probe: k === 'explore' && (!test || test.probe) ? 'running' : '',
			passes: 1, ends: {}, share: 0, depthCap: 0, detail: '', salt: 0, tries: 0, lanes: 1, saltNoted: 0,
			launchedAt: 0, readyAt: 0, usedMs: 0, prepSec: 0 })) };
	cur = { level: ins.level, buf, tool, toolArgs, files, opts: { width, depth, cpuDepth, prune: false, workers, seed, salts: !(test && test.salts === false), lanes, tool, bursts: one,
		refine: b.refine !== false && !(test && test.refine === false), probeS: test && test.probeS ? test.probeS : PROBE_S,
		// (the wall breaker's clocks and table; tests: shorter, and a small table)
		breakWait: test && Array.isArray(test.breakWait) ? test.breakWait : BREAK_WAIT_S, breakStep: test && test.breakStep ? test.breakStep : BREAK_STEP_S,
		breakRound: test && test.breakRound ? test.breakRound : BREAK_ROUND_S, breakCells: test && test.breakCells ? test.breakCells : 0, breakFront: b.breakFront !== false,
		breakFrom: test && test.breakFrom ? String(test.breakFrom) : '', breakGate: b.breakGate !== false && !(test && test.breakGate === false),
		roomGate: b.roomGate !== false && !(test && test.roomGate === false), breakProg: b.breakProg !== false && !(test && test.breakProg === false) },
		cpuCmd: test && Array.isArray(test.cpu) ? test.cpu : [process.execPath, path.join(__dirname, 'goexplore.js')],
		cpuNice: !(test && Array.isArray(test.cpu)),   // (goexplore.js takes --nice; a test's stand-in need not)
		rollsCmd: test && Array.isArray(test.rollsCmd) ? test.rollsCmd : [process.execPath, path.join(__dirname, 'goexplore.js')],
		// the proof (eegpu prove: CPU only, so also without an NVIDIA GPU, whenever the native tool is there; EEAT_PROOF=0: none)
		prover: test && test.prover !== undefined ? (Array.isArray(test.prover) ? test.prover : null) : process.env.EEAT_PROOF === '0' ? null : G.nativeTool() ? [G.nativeTool()] : null,
		proveSeconds: test && test.proveSeconds ? test.proveSeconds : PV.SECONDS, proveWatchdogS: test ? test.proveWatchdogS : undefined };
	// the relay's sources start over (see RELAY_SOURCES); the wall breaker's clock too
	dropSources();
	S.sources = [];
	brk = { at: Date.now(), mark: Infinity, rooms: new Set(), seen: new Set(), level: 0, tried: new Set(), rounds: 0, round: null, seeds: 0 };
	S.breaker = which.includes('breaker') ? { rounds: 0, round: null, last: null, seeds: 0 } : null;
	if (S.cpuOnly) note(S.cpuOnly);
	saveNow();
	// the physics check (src/reach.js, in a worker thread; cached per level) and the search tool's version, then the
	// strategies
	building = true;
	markBusy();
	if (!stallTimer) { stallTimer = setInterval(checkStalls, 5000); if (stallTimer.unref) stallTimer.unref(); }
	sched = null;
	if (!schedTimer) { schedTimer = setInterval(schedule, 250); if (schedTimer.unref) schedTimer.unref(); }
	// (the steer field next to it: its own worker; b.steer === false or test.steer === false: none)
	const wantSteer = b.steer !== false && !(test && test.steer === false);
	const steerP = !wantSteer ? Promise.resolve(null) : Promise.race([steerInfo(buf, levelHash), new Promise((res) => { const t = setTimeout(() => res({ late: true }), STEER_WAIT_MS); if (t.unref) t.unref(); })]);
	const ready = Promise.all([reachInfo(buf, levelHash), noGpu ? Promise.resolve('') : toolVersionProblem([tool, ...toolArgs]), steerP]);
	const gen = ++searchGen;
	ready.then(([rf, toolWhy, sf]) => { if (gen === searchGen) { useSteer(sf, noGpu || toolWhy); launchAll(test && test.reach ? Object.assign({}, rf, test.reach) : rf, noGpu || toolWhy, !!toolWhy, which, cpu, ins, guide); } }, (e) => {
		if (gen !== searchGen) return;   // (stopped while checking, maybe another search since)
		building = false;
		S.stage = 'error'; S.running = false;
		S.message = `The physics check failed: ${e.message}`;
		note(S.message);
		cur = null;
		save();
	});
	return state();
}
/** the steer field for this search (sf: steerInfo's answer or null): the CPU search gets it whenever it models anything
 *  the reach field does not, the GPU tools when their build reads RCH4 and the file fits STEER_GPU_SHARE of the GPU's
 *  memory (each GPU tool loads its own copy); the attempts' distances are then the steer field's, the page's tiles stay
 *  the reach field's (cur.reachLookup) */
function useSteer(sf, noGpu) {
	if (!cur) return;
	cur.files.steer = ''; cur.files.steerBeam = ''; cur.files.steerCpu = ''; cur.files.steerDist = false; cur.reachLookup = null; cur.distBySteer = false;
	S.steer = null;
	if (sf && sf.late) { note('the steer field is still building: this search orders by the reach field (the next one uses it, once built)'); return; }
	if (sf && sf.over) note(`the steer field ${sf.over}`);
	if (!sf || !sf.useful || !fs.existsSync(sf.file)) return;
	const mb = sf.bytes / 1048576, gpuMB = toolInfo && toolInfo.memMB ? toolInfo.memMB : 8192;
	// (STEER_GPU_SHARE in all: two copies (every move, the relay), four with the beams')
	const copies = mb * 4 <= gpuMB * STEER_GPU_SHARE ? 4 : mb * 2 <= gpuMB * STEER_GPU_SHARE ? 2 : 0;
	const gpuOk = !noGpu && toolInfo && toolInfo.steer === SF.VERSION && copies > 0;
	cur.files.steerCpu = sf.file;
	if (gpuOk) cur.files.steer = sf.file;
	if (gpuOk && copies === 4) cur.files.steerBeam = sf.file;
	// (the attempts' distances: the steer field's when every strategy orders by it, else the reach field's for all: the CPU
	// search then reports those, --steerDist=0)
	cur.distBySteer = cur.files.steerDist = gpuOk || !!noGpu;
	try { cur.reachLookup = SF.readReachBytes(fs.readFileSync(cur.files.reach)); } catch (e) { /* no reach file: the page shows the steer tiles */ }
	S.steer = { layers: sf.layers, bodies: sf.bodies, features: sf.features, dp: sf.dp, mb: Math.round(mb * 10) / 10, start: sf.start, ms: sf.ms, gpu: gpuOk, beams: gpuOk && copies === 4, cpu: true };
	note(`the steer field (gates, switches, coins: ${(sf.features || []).join(', ') || 'none'}; ${sf.layers} layer${sf.layers === 1 ? '' : 's'}${sf.dp ? `, the coin DP over ${sf.dp.n} coins` : ''}; ${S.steer.mb} MB, built in ${(sf.ms / 1000).toFixed(1)} s) orders the ` +
		(gpuOk ? `${copies === 4 ? 'GPU' : 'every move, relay'} and CPU searches${copies === 4 ? '' : ` (not the beams': 4 copies are over ${Math.round(gpuMB * STEER_GPU_SHARE)} MB, ${Math.round(STEER_GPU_SHARE * 100 * 10) / 10}% of the GPU's memory)`}`
			: `CPU search${noGpu ? '' : ` (not the GPU's: ${toolInfo && toolInfo.steer === SF.VERSION ? `2 copies are over ${Math.round(gpuMB * STEER_GPU_SHARE)} MB, ${Math.round(STEER_GPU_SHARE * 100 * 10) / 10}% of its memory` : 'its tool is older: rebuild it'})`}`) +
		'; only the reach field rules states out');
}
/** start()'s second half, once the physics check is done: rf {mode, startCost (tiles, -1 = cut off), explain, file}; noGpu:
 *  why the GPU strategies do not run ('' = they do); stale: the reason is an old search tool */
function launchAll(rf, noGpu, stale, which, cpu, ins, guide) {
	building = false;
	if (!cur) return;
	if (S.halted) { S.stage = S.result ? 'found' : 'stopped'; finish(); return; }
	const noWayUp = rf.mode === 'physics' && rf.startCost < 0;
	S.physics = { mode: rf.mode, startCost: rf.startCost < 0 ? null : Math.round(rf.startCost * 10) / 10, noWayUp, explain: rf.explain || null, viaDeath: !!deathNote(rf) };
	if (noGpu) {
		which = which.filter((k) => STRATEGIES[k].cpu);
		S.strategies = S.strategies.filter((q) => q.cpu);
		cur.opts.bursts = false;
		for (const q of S.strategies) if (q.gpuShare) { q.gpuShare = false; q.label = STRATEGIES[q.key].label; }
		if (stale) { S.cpuOnly = cpuOnlyText(noGpu, cur.opts.workers, guide); note(S.cpuOnly); }
		if (!which.length) {
			S.stage = 'error'; S.running = false; S.message = `The route search cannot run: ${noGpu}, and the CPU search is off.`;
			note(S.message); cur = null; save(); return;
		}
	}
	// no way up (the physics check proves the trophy out of reach): only "every move" and the random runs, without the
	// physics check (with it the start state itself is cut), for NO_WAY_UP_S s: a route found there would be a bug in
	// the model (model_miss.json)
	if (noWayUp) {
		which = which.filter((k) => k === 'explore' || k === 'goexplore');
		S.strategies = S.strategies.filter((q) => q.key === 'explore' || q.key === 'goexplore');
		S.seconds = Math.min(S.seconds, NO_WAY_UP_S);
	}
	cur.opts.prune = rf.mode === 'physics' && !noWayUp;
	// (the reach file the searches read has no death edges: goexplore.js builds its field the same way, --deaths)
	cur.opts.deathFree = !!rf.deathFree;
	// (the searches' file has death edges: a distance of RF.DEATH_TILES or more is a way through a death; an older cache
	// without the flag: as it had)
	cur.opts.fileDeaths = rf.deaths === undefined ? true : !!rf.deaths && !rf.deathFree;
	cur.opts.noWayUp = noWayUp;
	// (the check of a level the reach field calls impossible runs as before: no steer field)
	if (noWayUp) { cur.files.steer = ''; cur.files.steerBeam = ''; cur.files.steerCpu = ''; cur.distBySteer = false; }
	// the physics check finds a way: the proof (next to the searches) may still show there is none
	if (cur.opts.prune) startProof(ins);
	S.stage = 'starting';
	if (noGpu && !S.searchStarted) S.searchStarted = Date.now();   // (the CPU alone: the search's clock from its start)
	note(`searching ${ins.level.width} x ${ins.level.height}${noGpu ? '' : `, ${S.width} states per tick`}, up to ${S.seconds} s: ${S.strategies.map((q) => q.label).join(' and ')}` +
		(guide.length && !noGpu ? ` (a ${guide.length}-point line)` : '') + (cpu && which.includes('goexplore') ? ` (${cur.opts.workers} CPU thread${cur.opts.workers > 1 ? 's' : ''})` : ''));
	if (noWayUp) note(`the physics check finds no way from the start to the trophy (checking that with ${S.strategies.map((q) => q.label).join(' and ')}, without the physics check, for up to ${S.seconds} s)`);
	if (S.physics.viaDeath) note(deathNote(rf));
	save();
	if (brk) brk.at = Date.now();   // (the stall clock from the search's start)
	kids = which.map((k, n) => {
		if (k === 'breaker') { breakEnd(n); return null; }
		if (k !== 'relay') return launch(n);
		Object.assign(S.strategies[n], { state: 'waiting', detail: `waits for an attempt of ${RELAY_MIN_TICKS}+ ticks to go on from` });
		return null;
	});
}
// ---------------------------------------------------------------- the proof (src/prove.js: eegpu prove, CPU only)
// Once the physics check finds a way (a finite start cost), `eegpu prove` (native/prove.h: the engine's tick over boxes
// of positions and speeds, run-ups included; one thread, up to PV.SECONDS) runs next to the searches: levels of plain
// solids, air-like blocks and the trophy where the run-up speed decides are beyond the reach field. A proof caps the
// search at PROOF_CHECK_S of search time (the rest is a check: a route found anyway is a mistake in the proof, kept in
// model_miss.json) and the verdict is "No route (proven)" with the proof's explanation. Verdicts are cached per level
// and model (PV.cacheFile). A search whose strategies end first waits for the proof, unless a route is known or every
// strategy failed (the error at once). The proof gets the search's time at most (a 10 s search does not wait 30 s),
// and one that has not answered PV.WATCHDOG_S after its budget is killed (an error). The proof is a CPU process of its
// own: it does not keep the CPU search going (every GPU strategy ended with a route: cpuDone) nor a job's GPU searcher
// paused (markBusy).
const PROOF_CHECK_S = NO_WAY_UP_S;   // (the check after a proof: like the physics check's, a verdict already given)
let proofKid = null;
function startProof(ins) {
	S.proof = null;
	if (!cur || !cur.prover) return;
	const S0 = S, seconds = Math.max(1, Math.min(cur.proveSeconds, Math.round(S.seconds)));
	const file = PV.cacheFile(dir(), S.levelHash, cur.prover);
	const cached = PV.readCache(file);
	if (cached) { proofDone(Object.assign({}, cached, { cached: true })); return; }
	const bin = path.join(dir(), 'prove.bin');
	try { fs.writeFileSync(bin, G.levelBlob(ins.level)); } catch (e) { return; }
	S.proof = { state: 'running', started: Date.now() };
	// (the reach field's cut-off drops states that cannot reach the trophy anyway: several times faster)
	const ch = PV.run(cur.prover, bin, { reach: fs.existsSync(cur.files.reach) ? cur.files.reach : '', seconds, watchdogS: cur.proveWatchdogS }, (r) => {
		busy.delete(ch);
		if (proofKid === ch) proofKid = null;
		if (S !== S0) return;
		if (ch.stopWhy) { if (S.proof) S.proof.state = 'stopped'; }
		else { PV.writeCache(dir(), file, r); proofDone(r); }
		if (S.running) cpuDone();
		if (!running()) finish();
		else save();
	});
	proofKid = ch;
	busy.add(ch);
}
/** the proof's verdict r (the tool's done line, or from the cache) */
function proofDone(r) {
	S.proof = { state: 'done', verdict: r.verdict, end: r.end || '', sec: r.sec, cells: r.cells, pruned: r.pruned || 0, reach: r.reach || 0, explain: r.explain || null,
		why: r.why || null, error: r.error || null, cached: !!r.cached, checkS: PROOF_CHECK_S };
	const took = `${r.cached ? 'from the cache' : `${(+r.sec || 0).toFixed(1)} s`}`;
	if (r.verdict === 'impossible') {
		note(`the proof: no input sequence reaches the trophy (${(r.cells || 0).toLocaleString('en-US')} boxes of states, ${took}); the search ends once it has searched ${PROOF_CHECK_S} s (a check)`);
		if (S.result) proofMiss(S.result.strategy, S.result.inputs);
		else capSearch();
	} else if (r.verdict === 'reached') note(`the proof: it cannot rule a route out (its model reaches the trophy; ${took})`);
	else if (r.verdict === 'limit') note(`the proof: no verdict within its ${r.end === 'cells' ? 'memory' : 'time'} (${took})`);
	else if (r.verdict === 'error') note(`the proof failed: ${r.error}`);
	save();
}
/** a proof: the search ends PROOF_CHECK_S s into its clock (its processes stopped then; no new passes after it) */
function capSearch() {
	if (S.seconds <= PROOF_CHECK_S) return;
	S.seconds = PROOF_CHECK_S;
	const S0 = S;
	const tick = () => {
		if (S !== S0 || !S.running) return;
		const left = S.seconds - searchClock(Date.now());
		if (left > 0.2) { const t = setTimeout(tick, left * 1000); if (t.unref) t.unref(); return; }
		S.strategies.forEach((q, k) => { if (alive(kids[k]) && !kids[k].stopWhy) halt(kids[k], 'time'); });
	};
	tick();
}
/** a route on a level the proof ruled out: a mistake in the proof (native/prove.h), kept in model_miss.json */
function proofMiss(label, inputs) {
	if (S.proofMissed) return;
	S.proofMissed = true;
	try { C.writeJSON(path.join(dir(), 'model_miss.json'), { t: new Date().toISOString(), by: 'prover', levelHash: S.levelHash, eelvlB64: cur ? cur.buf.toString('base64') : null, inputs, strategy: label, proof: S.proof }); } catch (e) { /* read-only */ }
	note(`the proof ruled this level out, but ${label} found a route: a mistake in the proof (saved in model_miss.json; please report it)`);
}
/** the strategies have ended and the proof still runs: a route known, a stop or every strategy failed ends it, else the
 *  search waits for it */
function proofAlone() {
	if (!alive(proofKid) || proofKid.stopWhy || [...busy].some((c) => c !== proofKid)) return;
	if (!S.result && !S.halted && !S.strategies.every((q) => q.state === 'error')) {
		if (S.proof && !S.proof.waited) { S.proof.waited = true; note('the searches are done: waiting for the proof'); markBusy(); }
		return;
	}
	proofKid.stopWhy = 'stopped';
	try { proofKid.kill(); } catch (e) { /* gone */ }
}
/** the note of a search the CPU runs alone (why: the reason the GPU does not) */
const cpuOnlyText = (why, workers, guide) => `No GPU search: ${why}. The CPU searches alone (random runs on ${workers} thread${workers > 1 ? 's' : ''}): it finds routes, ` +
	`but not always the fastest one${guide.length ? ', and it does not follow the guide line' : ''}; with an NVIDIA GPU "every move" also looks for the fastest.`;
/** the reach field of a level (.eelvl bytes, its hash) for a search and the page's check: {v, fp, mode, startCost (tiles;
 *  -1 = cut off), explain, ms}, and its RCH3 file for eegpu (reachBase(hash).bin). Built in a worker thread (a big level
 *  takes seconds; one build per level at a time) and cached next to it (reachBase(hash).json / .bin; the newest few
 *  kept). */
const reachBuilds = new Map();
function reachInfo(buf, hash) {
	const base = reachBase(hash), meta = `${base}.json`, file = `${base}.bin`;
	const cached = C.readJSON(meta, null);
	if (cached && cached.v === RF_VERSION && cached.fp === reachFp() && fs.existsSync(file)) return Promise.resolve(cached);
	if (reachBuilds.has(hash)) return reachBuilds.get(hash);
	const p = new Promise((resolve, reject) => {
		try { fs.mkdirSync(dir(), { recursive: true }); } catch (e) { /* read-only data folder */ }
		const code = `const { workerData: d, parentPort } = require('worker_threads'); const fs = require('fs');
			const E = require(d.mods.eesim), EL = require(d.mods.eelvl), RF = require(d.mods.reach), G = require(d.mods.gpu);
			const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(Buffer.from(d.buf)), { id: 'editor', file: 'editor.eelvl' }));
			const f = RF.reachField(L, { explain: true });
			const sim = new E.EESim(L); sim.reset();
			// (the searches' file: without the death edges when they drop dead balls, unless that cuts the start off: then the
			// only way is a death, and the file keeps them as before, the verdict's note says so)
			let fs2 = f, deathFree = false, onlyDeath = false;
			if (f.deaths) { const g = RF.reachField(L, { deaths: false }); if (RF.costAt(g, sim) >= 0) { if (!d.deathsTaken) { fs2 = g; deathFree = true; } } else onlyDeath = RF.costAt(f, sim) >= 0; }
			// (the level's fingerprint in the file: eegpu prove uses a field only for its own level; none: it does not use it)
			let lfp = null;
			try { lfp = G.blobFp(G.levelBlob(L)); } catch (e) { /* a level the native tool cannot take */ }
			try { fs.writeFileSync(d.file + '.tmp', RF.reachFileBytes(fs2, lfp)); fs.renameSync(d.file + '.tmp', d.file); } catch (e) { /* read-only data folder */ }
			parentPort.postMessage({ v: d.v, fp: d.fp, mode: f.mode, startCost: RF.costAt(f, sim), explain: f.explain || null, ms: f.ms, deathFree, onlyDeath, deaths: !!f.deaths,
				...(deathFree ? { searchStartCost: RF.costAt(fs2, sim) } : {}), ...(f.prot ? { prot: f.prot } : {}) });`;
		const w = new Worker(code, { eval: true, workerData: { buf: Uint8Array.from(buf), file, v: RF_VERSION, fp: reachFp(), deathsTaken: deathsTaken(),
			mods: { eesim: require.resolve('./eesim.js'), eelvl: require.resolve('./eelvl.js'), reach: require.resolve('./reach.js'), gpu: require.resolve('./gpu.js') } } });
		w.once('message', (r) => {
			try { fs.mkdirSync(dir(), { recursive: true }); C.writeJSON(meta, r); pruneReachCache(); } catch (e) { /* read-only data folder */ }
			resolve(r);
		});
		w.once('error', reject);
		w.once('exit', (code) => { if (code) reject(new Error(`the physics check stopped (exit code ${code})`)); });
	});
	reachBuilds.set(hash, p);
	const done = () => { reachBuilds.delete(hash); };
	p.then(done, done);
	return p;
}
/** the steer field's cache: <data>/editor/reach_<level hash>_s4_<fingerprint of steer.js and the model it builds on>.bin /
 *  .json */
let steerFpMemo = null;
function steerFp() {
	if (steerFpMemo) return steerFpMemo;
	const h = crypto.createHash('sha1');
	for (const f of ['steer.js', 'reach.js', 'eesim.js', 'eelvl.js']) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (e) { h.update(f); } }
	return (steerFpMemo = h.digest('hex').slice(0, 12));
}
const steerBase = (hash) => path.join(dir(), `reach_${hash}_s${SF.VERSION}_${steerFp()}`);
/** the steer field of a level (.eelvl bytes, its hash) for a search: {v, fp, layers, bodies, dp, bytes, useful (it models
 *  something the reach field does not: 2+ layers or the coin DP), features, start (tiles), ms}, and its RCH4 file
 *  (steerBase(hash).bin). Built in a worker thread next to the reach field's (2-8 s on a 200 x 200 level of gates and
 *  coins), cached like it (the newest 4). null when it cannot be built (the search then orders by the reach field). */
const steerBuilds = new Map();
function steerInfo(buf, hash) {
	const base = steerBase(hash), meta = `${base}.json`, file = `${base}.bin`;
	const cached = C.readJSON(meta, null);
	if (cached && cached.v === SF.VERSION && cached.fp === steerFp() && (!cached.useful || fs.existsSync(file))) return Promise.resolve(Object.assign(cached, { file }));
	if (steerBuilds.has(hash)) return steerBuilds.get(hash);
	const p = new Promise((resolve) => {
		try { fs.mkdirSync(dir(), { recursive: true }); } catch (e) { /* read-only data folder */ }
		const code = `const { workerData: d, parentPort } = require('worker_threads'); const fs = require('fs');
			const E = require(d.mods.eesim), EL = require(d.mods.eelvl), SF = require(d.mods.steer), G = require(d.mods.gpu);
			const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(Buffer.from(d.buf)), { id: 'editor', file: 'editor.eelvl' }));
			const st = SF.buildSteer(L);
			const useful = st.S > 1 || !!st.dp;
			let lfp = null, bytes = 0;
			try { lfp = G.blobFp(G.levelBlob(L)); } catch (e) { /* a level the native tool cannot take */ }
			if (useful) { const b = SF.steerFileBytes(st, lfp); bytes = b.length; try { fs.writeFileSync(d.file + '.tmp', b); fs.renameSync(d.file + '.tmp', d.file); } catch (e) { /* read-only data folder */ } }
			parentPort.postMessage({ v: d.v, fp: d.fp, useful, layers: st.info.layers, bodies: st.bodies.length, features: st.info.features, dp: st.info.dp,
				bytes, start: Number.isFinite(st.info.start) ? st.info.start : null, ms: st.info.ms, over: st.info.over ? \`leaves out \${st.info.over}\` : null });`;
		const w = new Worker(code, { eval: true, workerData: { buf: Uint8Array.from(buf), file, v: SF.VERSION, fp: steerFp(),
			mods: { eesim: require.resolve('./eesim.js'), eelvl: require.resolve('./eelvl.js'), steer: require.resolve('./steer.js'), gpu: require.resolve('./gpu.js') } } });
		w.once('message', (r) => {
			try { fs.mkdirSync(dir(), { recursive: true }); C.writeJSON(meta, r); pruneSteerCache(); } catch (e) { /* read-only data folder */ }
			resolve(Object.assign(r, { file }));
		});
		w.once('error', () => resolve(null));
		w.once('exit', (code) => { if (code) resolve(null); });
	});
	steerBuilds.set(hash, p);
	const done = () => { steerBuilds.delete(hash); };
	p.then(done, done);
	return p;
}
/** the steer cache: the newest 4 levels' files (a 200 x 200 level of coins: up to ~0.5 GB) */
function pruneSteerCache() {
	const d = dir(), fp = steerFp();
	const fl = fs.readdirSync(d).filter((f) => /^reach_[0-9a-f]+_s\d+_[0-9a-f]+\.json$/.test(f)).map((f) => ({ f, cur: f.endsWith(`_s${SF.VERSION}_${fp}.json`), t: fs.statSync(path.join(d, f)).mtimeMs }))
		.sort((a, b) => (b.cur - a.cur) || (b.t - a.t));
	for (const { f } of fl.filter((x, k) => k >= 4 || !x.cur)) for (const x of [f, f.replace(/\.json$/, '.bin')]) { try { fs.unlinkSync(path.join(d, x)); } catch (e) { /* gone */ } }
}
/** the reach cache: the newest 8 levels' files (older versions and fingerprints go first: never read again) */
function pruneReachCache() {
	const d = dir(), fp = reachFp();
	const fl = fs.readdirSync(d).filter((f) => /^reach_[0-9a-f]+_v\d+(_[0-9a-f]+)?(_dm)?\.json$/.test(f)).map((f) => ({ f, cur: f.endsWith(`_v${RF_VERSION}_${fp}.json`) || f.endsWith(`_v${RF_VERSION}_${fp}_dm.json`), t: fs.statSync(path.join(d, f)).mtimeMs }))
		.sort((a, b) => (b.cur - a.cur) || (b.t - a.t));
	for (const { f } of fl.filter((x, k) => k >= 8 || !x.cur)) for (const x of [f, f.replace(/\.json$/, '.bin')]) { try { fs.unlinkSync(path.join(d, x)); } catch (e) { /* gone */ } }
}
/** why the native tool cannot run this app's searches ('' = it can): its `info` must say it reads the reach file of this
 *  version (an older build refuses every RCH3 file); asked once per build of the tool */
const toolChecked = new Map();
let toolInfo = null;   // the last native tool's `info`: {steer (the steer file version it reads; 0 none), memMB (its GPU's memory)}
function toolVersionProblem(cmd) {
	let key = cmd.join('\u0000');
	try { key += `|${fs.statSync(cmd[0] === process.execPath ? cmd[1] : cmd[0]).mtimeMs}`; } catch (e) { /* (no file: the spawn fails anyway) */ }
	if (toolChecked.has(key)) return toolChecked.get(key);
	const p = new Promise((resolve) => {
		// (with the kernel cache: the compile after an update happens once, here or in the first strategy; no timeout: an
		// eegpu process is never killed while it may run a kernel; `info` launches one: detached with --parent, like the
		// strategies, so the app's exit does not kill it mid-kernel)
		const native = cmd[0] !== process.execPath;
		require('child_process').execFile(cmd[0], [...cmd.slice(1), 'info', ...(native ? [...G.cacheArgs(), `--parent=${process.pid}`] : [])],
			{ encoding: 'utf8', windowsHide: true, detached: native }, (err, out) => {
			let info = null;
			for (const line of String(out || '').split('\n')) { try { const j = JSON.parse(line); if (j && typeof j === 'object') info = j; } catch (e) { /* not JSON */ } }
			// (its steer file version and the GPU's memory: the steer field's budget, launchAll)
			if (info && info.reach === RF_VERSION) { toolInfo = { steer: info.steer || 0, memMB: info.gpu && info.gpu.memMB > 0 ? info.gpu.memMB : 0 }; resolve(''); }
			// (its one kernel launch failed: launch.h's {"error":...,"launchError":true} line, exit 6 / 7)
			else if (info && info.launchError) resolve(`the GPU failed (${String(info.error || 'a kernel launch failed').slice(0, 200)})`);
			else resolve('the search tool is older than the app: rebuild it (node tools/build-native.js)');
		});
	});
	toolChecked.set(key, p);
	p.then((why) => { if (why) toolChecked.delete(key); });   // (asked again after a rebuild)
	return p;
}
/** the CPU strategies' processes: their depth bound (a route of `ticks` is known: only faster ones count); the one search
 *  (its head L follows the best route: goexplore.js) gets the route itself when another strategy found it (n) */
function tellCpu(ticks, inputs, n) {
	S.strategies.forEach((q, k) => {
		const ch = kids[k];
		if ((q.cpu || q.rolls) && alive(ch) && ch.stdin && !ch.stdin.destroyed) {
			try {
				ch.stdin.write(`depth ${Math.max(1, ticks - 1)}\n`);
				if (q.gpuShare && k !== n && inputs) ch.stdin.write(`route ${inputs}\n`);
			} catch (e) { /* gone */ }
		}
	});
}
/** one strategy's eegpu process (a new pass of the exploration too): its JSON lines update S.strategies[n] and the
 *  totals */
function launch(n) {
	const V = S.strategies[n];
	// (the strategy's own search time: the loads of its processes do not count)
	const left = Math.max(1, Math.round(S.seconds - usedSec(V)));
	// salts: the tool itself starts over with the next salt after a try without a route (the finest pass, the last rung of
	// the ladder, from its first run; any pass in a salt rerun)
	const q = { seconds: left, pass: V.pass, depth: 0, salt: V.salt || 0, salts: cur.opts.salts && (V.pass >= PASS_MAX || V.salt > 0), V };
	// the salt tries run several salts side by side (--lanes=auto: from V.lanes, the last run's; the tool doubles them
	// while that raises the tries per second, up to cur.opts.lanes, and halves them when a batch fills the table)
	// (with near-miss refinement one at a time: see LANES)
	if (q.salts && cur.opts.refine) q.refine = true;
	else if (q.salts && cur.opts.lanes > 1) q.lanes = { max: cur.opts.lanes, start: Math.max(1, Math.min(cur.opts.lanes, V.lanes || 1)) };
	if (V.key === 'relay') {
		// (the search's clock: the relay waits between its runs, so its own run time would let it run past the search's end)
		q.prefixFile = V.relay.file; q.cells = RELAY_CELLS[V.relay.big ? 0 : V.relay.cells]; q.big = !!V.relay.big; q.salt = V.relay.salt || 0;
		// (every move not running: the GPU memory is the relay's, a table 4x larger: on the ice level the small one filled
		// 422 ticks into the climb above (64, 58), the large one went 1072 ticks and 100 tiles nearer)
		q.alone = !S.strategies.some((x, k) => x.key === 'explore' && alive(kids[k]));
		q.slack = V.relay.big || !V.relay.src ? 0 : Math.round(Math.min(RELAY_SLACK_MAX, RELAY_SLACK + RELAY_SLACK_F * V.relay.src.dist));
		q.seconds = V.share = Math.max(1, Math.min(RELAY_S * (q.big ? 2 : 1), Math.round(S.seconds - searchClock(Date.now()))));
		q.depth = S.result ? Math.max(1, boundTicks() - 1 - V.relay.keep) : 0;
	}
	if (V.gpuShare) { q.tool = cur.tool; q.pauseFile = pauseFileOf(n); q.work = path.join(dir(), 'bursts'); }
	if (V.key === 'breaker') {
		q.prefixFile = V.brk.file; q.cells = V.brk.cells; q.cellLog = V.brk.cellLog; q.region = V.brk.region; q.reserve = V.brk.reserve; q.gateReach = V.brk.gateReach;
		q.seconds = V.share = V.brk.seconds;
		q.depth = S.result ? Math.max(1, boundTicks() - 1 - V.brk.keep) : 0;
	}
	if (V.key === 'explore') {
		V.refine = null;   // (a new process: no refined try running yet)
		q.seconds = V.share = V.probe === 'running' || V.probe === 'passed' ? left : passSeconds(V.pass, V.ends, left);
		// a route of T ticks known: only the first T - 1 ticks (a route there is faster)
		q.depth = V.depthCap = S.result ? Math.max(1, boundTicks() - 1) : 0;
	}
	const args = STRATEGIES[V.key].args(cur.files, cur.opts, q);
	const cpu = V.cpu;
	// (the GPU random runs: node src/goexplore.js --gpu=1, a GPU strategy (stop and pause files for its eegpu) that is told
	// the depth bound on its stdin like the CPU search)
	const rolls = !!V.rolls;
	// the GPU tool's stop file (halt: it ends between two kernel launches; a kill during a kernel resets the driver)
	const stopFile = cpu ? '' : path.join(dir(), `stop_${n}`);
	if (stopFile) { try { fs.unlinkSync(stopFile); } catch (e) { /* none */ } }
	// the CPU search: node src/goexplore.js (its stdin takes the depth bound: tellCpu); eegpu with the kernel cache (the
	// strategies start together: one compiles the kernels after an update, the others wait for it and load them)
	// (the GPU tool detached, with this process as its --parent: Node kills the children it did not start detached the
	// moment it exits, mid-kernel too; a detached eegpu ends at its next kernel launch once the app is gone)
	const pauseFile = cpu && !V.gpuShare ? '' : pauseFileOf(n);
	const pausedNow = (!cpu || !!V.gpuShare) && !!(sched && sched.owner !== n && alive(kids[sched.owner]));
	if (pauseFile) { try { if (pausedNow) fs.writeFileSync(pauseFile, 'pause'); else fs.unlinkSync(pauseFile); } catch (e) { /* none */ } }
	// (Linux, next to GPU strategies: the CPU search's worker threads at nice 10 (goexplore.js --nice), each lowering its
	// own thread. The GPU tools' above-normal priority (launch.h) needs root or CAP_SYS_NICE there, which a container (a
	// rented cloud GPU) lacks, and next to busy CPU threads "every move" was 3-7x slower without it. Before, the whole
	// process was reniced, so its main thread and the one search's GPU bursts (its eegpu children inherit the main
	// thread's value) ran at nice 10 too: below every normal process of a shared machine (the cycle 7 test's A100).)
	const niceCpu = cpu && !S.cpuOnly && process.platform === 'linux' && cur.cpuNice;
	const cmd = cpu ? [...cur.cpuCmd, ...args, ...(niceCpu ? ['--nice=10'] : [])] : [...(rolls ? cur.rollsCmd : [cur.tool, ...cur.toolArgs]), ...args, ...G.cacheArgs(), `--stopfile=${stopFile}`, `--pausefile=${pauseFile}`,
		`--parent=${process.pid}`];
	// (the CPU search sizes its workers' heaps from its memory budget: no heap flag for it, which would cap them all; the
	// GPU random runs are one thread, their cells' states outside the V8 heap)
	const ch = spawn(cmd[0], cmd.slice(1), { stdio: [cpu || rolls ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, env: cpu ? C.workerHeapEnv() : rolls ? C.heapEnv(4096) : undefined,
		detached: !cpu });
	ch.stopFile = stopFile;
	ch.startedAt = Date.now();
	ch.paused = pausedNow;
	if (ch.stdin) ch.stdin.on('error', () => { /* it ended */ });
	busy.add(ch);
	V.live = true;
	// (the CPU search searches at once; an eegpu process from its ready event)
	V.launchedAt = Date.now();
	V.readyAt = cpu ? V.launchedAt : 0;
	let hits = 0, end = '', overflow = null, lastSalt = 0, lanesNow = q.lanes ? q.lanes.start : 1;
	const lanesRun = lanesNow;   // (this run's first batch: salts q.salt .. q.salt + lanesRun - 1 at least)
	const mine = () => kids[n] === ch;
	let out = '', err = '';
	const totals = () => {
		S.layer = Math.max(...S.strategies.map((q) => q.layer));
		S.tick = S.layer;
		S.states = S.strategies.reduce((a, q) => a + (q.state === 'running' || (q.cpu && q.live) ? q.states : 0), 0);
		S.ticksPerSec = S.strategies.reduce((a, q) => a + (q.state === 'running' || (q.cpu && q.live) ? q.ticksPerSec : 0), 0);
		S.elapsed = (Date.now() - S.started) / 1000;
	};
	// moves per second: the ticks simulated plus the twins (moves the tool skipped because a lower option is proven to
	// give exactly the same state): the moves tried, the number the page shows
	const movesPerSec = (ev) => (ev.ticks > 0 && ev.twins > 0 ? ev.ticksPerSec * (ev.ticks + ev.twins) / ev.ticks : ev.ticksPerSec || 0);
	// the process has its kernels loaded (its ready event; a tool without one: its first event): its time counts from now
	const ready = (ev) => {
		const now = Date.now();
		V.readyAt = now;
		V.prepSec = Math.round((now - V.launchedAt) / 100) / 10;
		if (ev) V.load = { loadMs: ev.loadMs, allocMs: ev.allocMs, module: ev.module || null, waitMs: ev.waitMs || 0 };
		if (!S.searchStarted) {
			S.searchStarted = now;
			S.prepSec = (now - S.started) / 1000;
		}
		// the probe (see PROBE_S): its first try must run through within PROBE_S s of search time, its own: the time it waits
		// while another strategy has the GPU (the random runs' slices, above ROLLS_PROBE_TILES) does not count, up to
		// PROBE_WALL x PROBE_S of the clock (on the ice level the random runs' slices left the probe 40% of its GPU time)
		if (V.probe === 'running' && !ch.probeTimer) {
			const from = now, paused0 = pausedMsOf(ch), budget = cur.opts.probeS * 1000;
			const check = () => {
				ch.probeTimer = null;
				if (V.probe !== 'running' || !mine() || !alive(ch)) return;
				const wall = Date.now() - from, left = budget - (wall - (pausedMsOf(ch) - paused0));
				if (left > 20 && wall < PROBE_WALL * budget) {
					ch.probeTimer = setTimeout(check, Math.min(left, PROBE_WALL * budget - wall));
					if (ch.probeTimer.unref) ch.probeTimer.unref();
					return;
				}
				halt(ch, 'probe');
			};
			ch.probeTimer = setTimeout(check, budget);
			if (ch.probeTimer.unref) ch.probeTimer.unref();
		}
		if (V.prepSec >= 5) {
			// (module: "compiled" = this process compiled the kernels for the card; "cache" after a wait = another one did)
			const how = !ev || !Number.isFinite(ev.loadMs) ? '' : ev.module === 'compiled' ? ` (compiling the kernels for this graphics card: ${(ev.loadMs / 1000).toFixed(0)} s)`
				: ev.waitMs >= 1000 ? ` (waiting for another strategy's compile of the kernels: ${(ev.waitMs / 1000).toFixed(0)} s)`
				: ` (kernels ${(ev.loadMs / 1000).toFixed(1)} s, memory ${(ev.allocMs / 1000).toFixed(1)} s)`;
			note(`${V.label}: the GPU engine took ${V.prepSec.toFixed(0)} s to start${how}; the search time counts from now`);
		}
	};
	const onEvent = (ev) => {
		if (!mine()) return;
		if (ev.ev === 'ready') { if (!V.readyAt) { ready(ev); save(); } return; }
		if (!V.readyAt && !ev.error) ready(null);
		// (halted: its state stays as the halt left it; a GPU tool asked to stop still prints until its next launch)
		if (ch.stopWhy && (ev.ev === 'progress' || ev.ev === 'layer' || ev.ev === 'try')) return;
		if (ev.ev === 'progress' || ev.ev === 'layer') {
			if ((cpu || rolls) && Number.isFinite(ev.rooms)) V.rooms = ev.rooms;
			if (cpu && Number.isFinite(ev.cpuS)) V.cpuS = ev.cpuS;   // (the CPU search's CPU seconds: a route's time per core-second)
			Object.assign(V, { state: (cpu || rolls) && V.found ? 'found' : 'running', layer: ev.layer, deepest: Math.max(V.deepest || 0, ev.layer), states: ev.ev === 'layer' ? ev.kept : ev.states,
				ticksPerSec: Math.round(movesPerSec(ev)) });
			if (ev.ev === 'layer' && V.key === 'relay' && V.relay) {
				V.detail = `from tick ${V.relay.keep} of ${V.relay.what || 'the nearest attempt'} (run ${V.relay.runs}) · ${(ev.states / 1e6).toFixed(ev.states < 1e7 ? 1 : 0)} M places tried, table ${Math.round(Math.min(1, ev.full) * 100)}% full`;
			} else if (ev.ev === 'layer') {
				V.detail = `${(ev.states / 1e6).toFixed(ev.states < 1e7 ? 1 : 0)} M places tried, table ${Math.round(Math.min(1, ev.full) * 100)}% full · pass ${V.passes}, ` +
					`cells of ${passGrain(V.pass)}${lanesNow > 1 ? ` · ${lanesNow} tries side by side` : ''}`;
			} else if (cpu || rolls) {
				V.detail = `${rolls ? 'GPU' : `${ev.workers} thread${ev.workers > 1 ? 's' : ''}`}, ${ev.states >= 1e6 ? `${(ev.states / 1e6).toFixed(1)} M` : `${Math.round(ev.states / 1e3)} k`} situations kept` +
					(ev.rooms > 1 ? ` in ${ev.allRooms > ev.rooms ? ev.allRooms : ev.rooms} rooms` : '') + (ev.gpu && ev.gpu.bursts ? `, ${ev.gpu.bursts} GPU bursts` : '') +
					(ev.fed ? `, ${ev.fed} GPU random runs taken in` : '') + (Number.isFinite(ev.bestCost) && !V.found ? `, nearest ${ev.bestCost.toFixed(1)} tiles from the trophy` : '') +
					(V.found ? ', looking for a faster route' : '');
			}
			if (!S.result && S.stage !== 'error') S.stage = 'searching';
			totals();
			// deeper than the best route: it cannot find a faster one (the CPU search's deepest situation says nothing of
			// the kind: it is told the bound instead, and looks only for faster routes)
			if (!cpu && !rolls && S.result && ev.layer >= boundTicks() && alive(ch)) { V.state = 'beaten'; halt(ch, 'beaten'); }
			// every move far behind a running relay (EXPLORE_YIELD_MS) gives it the GPU
			if (V.key === 'explore' && !S.result && alive(ch) && !ch.stopWhy) {
				const rk = S.strategies.findIndex((q) => q.key === 'relay'), Rv = S.strategies[rk];
				if (Rv && alive(kids[rk]) && Rv.best !== undefined && !(V.best <= Rv.best + EXPLORE_YIELD_TILES) && Date.now() - (V.bestAt || ch.startedAt) > EXPLORE_YIELD_MS) {
					note(`${V.label}: gave the GPU to ${Rv.label} (${Rv.best.toFixed(1)} tiles from the trophy, this one ${V.best !== undefined ? V.best.toFixed(1) : '-'}); it goes on when that one stops`);
					halt(ch, 'yield');
				}
			}
			// a stuck beam (BEAM_STALL_MS) gives way while another GPU strategy searches
			if ((V.key === 'goal' || V.key === 'guide') && !S.result && alive(ch) && !ch.stopWhy && Date.now() - (V.bestAt || ch.startedAt) > BEAM_STALL_MS &&
				S.strategies.some((q, k) => k !== n && !q.cpu && (q.key === 'explore' || q.key === 'relay') && alive(kids[k]))) {
				V.state = 'stopped'; V.detail = `no nearer attempt in ${BEAM_STALL_MS / 1000} s: gave the GPU to the others`;
				halt(ch, 'stopped');
				note(`${V.label}: stopped (${V.best !== undefined ? `stuck at ${(V.best).toFixed(1)} tiles` : 'no attempt'} for ${BEAM_STALL_MS / 1000} s; the GPU goes to the others)`);
			}
			save();
		} else if (ev.ev === 'result' && ev.kind === 'finish') {
			// (the CPU search goes on looking for faster routes)
			found(ev.inputs, n, cpu || rolls);
		} else if (ev.ev === 'try' && V.probe === 'running' && (ev.end === 'exhausted' || ev.end === 'depth') && ev.overflow > 0) {
			// the first try ran out only because its layers were cut (over the layer cap: the cut keeps the states nearest
			// the trophy by the physics check, a greedy beam that walks into the check's dead ends; the user's 200x200 ice
			// level "ran out" at tick 71 that way): the finest cells are too many here, the ladder from the coarse end
			if (ch.probeTimer) clearTimeout(ch.probeTimer);
			halt(ch, 'probe');
		} else if (ev.ev === 'try' && V.probe === 'running' && (ev.end === 'exhausted' || ev.end === 'depth')) {
			// the probe passed: the finest cells run through here; the pass goes on with the whole time
			V.probe = 'passed';
			if (ch.probeTimer) clearTimeout(ch.probeTimer);
			note(`${V.label}: the finest cells ran through in ${usedSec(V).toFixed(1)} s (every situation tried at tick ${ev.layers}): trying them first`);
			onEvent(Object.assign({}, ev, { probeSeen: true }));
		} else if (ev.ev === 'try') {
			if (V.refine && V.refine.at) V.refinedOnce = true;
			if (V.refine) V.refine.at = 0;
			V.lastTryMs = Date.now() - (ch.tryFrom || V.readyAt || ch.startedAt);
			ch.tryFrom = Date.now();
			// a salt rerun's try that ran out of situations (no layer cut, no route bounding it): the evidence counts it
			// (a batch of --lanes salts side by side: one event for its ev.lanes tries)
			if (ev.end === 'exhausted' && ev.overflow === 0 && !V.depthCap && !V.found && V.pass >= 0) {
				V.tries = (V.tries || 0) + (ev.lanes || 1);
				if (!V.exhausted) V.exhausted = { pass: V.pass, tick: ev.layers, grain: passGrain(V.pass) };
				yieldBeams(n);
			}
			if (Number.isFinite(ev.salt)) lastSalt = ev.salt;
			if (Number.isFinite(ev.lanes)) lanesNow = V.lanes = ev.lanes;
		} else if (ev.ev === 'refine') {
			// the try before ran out of situations: the next ones tell the situations along its near misses apart 4x finer
			V.refine = { tiles: ev.frontierTiles, nearMisses: ev.nearMisses, situations: ev.situations, at: Date.now(),
			};
			if (ev.new > 0) note(`${V.label}: ${ev.frontierTiles} tile${ev.frontierTiles === 1 ? '' : 's'} next to reached ones not entered: the next try looks 4x finer along the ${ev.nearMisses} nearest attempts (${ev.situations} situations)`);
		} else if (ev.ev === 'lanes') {
			// the tool changed how many salts it tries side by side: a batch filled the cell table (it runs them again with
			// fewer), or (--lanes=auto) the tries per second said so; the next run starts with that many
			lanesNow = V.lanes = ev.lanes;
			if (ev.why === 'full') note(`${V.label}: ${ev.from} tries side by side filled the table at tick ${ev.layers}; ${ev.lanes > 1 ? `${ev.lanes} at a time` : 'one at a time'} now`);
		} else if (ev.ev === 'warning') {
			note(`${V.label}: ${ev.text}`);
		} else if (ev.ev === 'closest') {
			closer(ev, n);
		} else if (ev.ev === 'source') {
			// the CPU search's starting points for the relay (goexplore.js, coarse cells): a new room's first cell ("room":
			// its inputs end where it entered the room), a room's lowest-cost cell ("best")
			// (the GPU random runs' too: their distances the reach field's, steerDist)
			const dist = steerDist(V, +ev.dist), inputs = String(ev.inputs || '');
			if (cur && inputs && Number.isFinite(dist) && Number.isFinite(+ev.room)) {
				addSource({ room: +ev.room, desc: ev.desc, gain: +ev.gain || 0, from: V.label, inputs, dist, arrival: ev.kind === 'room' ? inputs.length : 0 });
				// (the GPU random runs' first arrival in a room: into the one search's archive)
				if (rolls && ev.kind === 'room') feedOne(inputs, true);
				setImmediate(relayKick);
			}
		} else if (ev.ev === 'hit') {
			// the exploration's finishes: all in its last layer (equally many ticks); a few are enough (the timer start
			// can differ)
			if (++hits <= 12) found(ev.inputs, n, hits < 12);
		} else if (ev.ev === 'done') {
			V.layer = ev.layers;
			V.deepest = Math.max(V.deepest || 0, ev.layers || 0);
			end = ev.end || '';
			// the situations the exploration left out of its over-full layers (null: the engine does not say)
			overflow = Number.isFinite(ev.overflow) ? ev.overflow : null;
			if (Number.isFinite(ev.salt)) lastSalt = ev.salt;
			if (Number.isFinite(ev.lanes)) lanesNow = V.lanes = ev.lanes;
			S.gpu = ev.gpu && ev.gpu.name ? ev.gpu.name : S.gpu;
		} else if (ev.warn && V.key === 'breaker' && Number.isFinite(ev.cellLog)) {
			// (the table it got: smaller than asked where the free memory less the reserve did not hold it)
			if (V.brk) V.brk.cellLogGot = ev.cellLog;
			if (S.breaker) S.breaker.cellLog = ev.cellLog;
			// (once per table size: a round of 30 runs noted it 30 times, and the log keeps 30 lines)
			if (brk && brk.cellLogNoted !== ev.cellLog) { brk.cellLogNoted = ev.cellLog; note(`${V.label}: ${ev.warn}${Number.isFinite(ev.freeMB) ? ` (${ev.freeMB} MB free)` : ''}`); }
			// (under a quarter of the table it planned: another process holds the memory; it waits for it, the round's
			// first BREAK_MEM_WAITS times, rather than run on a table too small for its wall (2^24 on the shared H100))
			if (V.brk && ev.cellLog <= V.brk.cellLog - 2 && brk && brk.round && brk.round.chain && (brk.round.memWaits || 0) < BREAK_MEM_WAITS) halt(ch, 'memwait');
		} else if (ev.error && ev.steer === 0 && !V.noSteer) {
			// the tool cannot use the steer file (the GPU's memory, a stale file): this strategy again without it, now and
			// from now on (its distances the reach field's: closer() ranks them behind the steer field's)
			V.noSteer = true; ch.steerRetry = true;
			note(`${V.label}: ${ev.error}; again without it`);
		} else if (ev.error) {
			V.error = ev.error;
			note(`${V.label}: error: ${ev.error}`);
			if (!cpu && ev.launchError) gpuFailed(n);
			save();
		}
	};
	// a chunk of the tool's output (many lines when the app fell behind): of its progress lines ("layer" / "progress",
	// counters only) just the last one is handled; every other event in order. Handling each of a backlog of progress
	// lines (the totals and texts per line) blocked the server's thread for 2 s at a time during a search.
	ch.stdout.on('data', (chunk) => {
		ch.lastOut = Date.now();
		out += chunk;
		const k = out.lastIndexOf('\n');
		if (k < 0) return;
		const lines = out.slice(0, k).split('\n');
		out = out.slice(k + 1);
		const isProgress = (l) => l.startsWith('{"ev":"layer"') || l.startsWith('{"ev":"progress"');
		let lastProgress = -1;
		for (let i = lines.length - 1; i >= 0; i--) if (isProgress(lines[i].trim())) { lastProgress = i; break; }
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line.startsWith('{') || (i !== lastProgress && isProgress(line))) continue;
			let ev;
			try { ev = JSON.parse(line); } catch (e) { continue; }
			onEvent(ev);
		}
	});
	ch.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
	ch.on('error', (e) => { err += e.message; });
	ch.on('close', (code, sig) => {
		busy.delete(ch);
		if (ch.haltTimer) clearTimeout(ch.haltTimer);
		if (!mine()) return;
		V.live = false;
		if (V.readyAt) { V.usedMs += Date.now() - V.readyAt; V.readyAt = 0; }   // (its search time; the next process loads first)
		// (a retry without the steer file: during the wall breaker's round after it, the beams too; the breaker's own now)
		if (ch.steerRetry && !ch.stopWhy && S.running && !S.halted && S.stage !== 'stopped') { if (V.key === 'relay' && breakerBusy()) Object.assign(V, { deferred: true, state: 'waiting', detail: 'waits while the wall breaker has the GPU' }); else if (V.key !== 'breaker') launchOrWait(n); else kids[n] = launch(n); save(); return; }
		// eegpu's kernel launch failed (exit 6, 7 = the driver's watchdog) or it crashed: the GPU may have been reset.
		// No next pass, no salt rerun (V.error), and the other GPU searches stop too: the GPU gets no new work now
		// (a crash: an exception code above 255 on Windows; on Linux a signal, exit code null, that no halt sent)
		const crashed = (Number.isFinite(code) && (code < 0 || code > 255)) || (code === null && !!sig && !ch.stopWhy);
		if (!cpu && !ch.stopWhy && !V.error && (code === 6 || code === 7 || crashed)) {
			V.error = `the GPU tool ${code === 7 ? 'was stopped by the display driver\'s watchdog' : code === 6 ? 'had a GPU launch failure' : `crashed (${code === null ? `signal ${sig}` : `exit code ${code}`})`}` +
				`${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}`;
			note(`${V.label}: error: ${V.error}`);
		}
		if (!cpu && V.error && (code === 6 || code === 7 || crashed)) gpuFailed(n);
		// (out of GPU memory, at its context or an allocation: another process holds it for now; the strategy starts again
		// after a back-off, gpuRetry. The relay and the breaker go on their own way below.)
		else if (!cpu && V.error && !ch.stopWhy && gpuTransient(V.error) && V.key !== 'relay' && V.key !== 'breaker' && gpuRetry(n, ch)) {
			if (ch.probeTimer) clearTimeout(ch.probeTimer);
			totals();
			save();
			return;
		}
		if (V.key === 'explore') {
			// the probe (PROBE_S) ended before its first try ran through: too many situations at the finest cells here (its
			// time, or a full table): the ladder from PASS_START, as if the probe had not been. A route: it passed.
			if (ch.probeTimer) clearTimeout(ch.probeTimer);
			if (V.refine && V.refine.at) V.refinedOnce = true;   // (the refined try ended with its process: full, time)
			if (ch.stopWhy === 'breaker' && S.running && !S.halted && S.stage !== 'stopped') {
				// (stopped for the wall breaker's round, its memory freed: the same pass again after the round)
				Object.assign(V, { state: 'waiting', detail: 'waits while the wall breaker has the GPU', deferred: true });
				totals();
				if (!running()) finish(); else save();
				return;
			}
			if (ch.stopWhy === 'yield' && S.running && !S.halted && S.stage !== 'stopped') {
				Object.assign(V, { state: 'waiting', detail: 'gave the GPU to the relay, far ahead; goes on when it stops' });
				totals();
				if (!running()) finish(); else save();
				return;
			}
			if (V.probe === 'running') {
				const h = ch.stopWhy || (code === 0 && !V.error ? end : '');
				if ((h === 'probe' || h === 'full') && !V.error && S.running && !S.halted && S.stage !== 'stopped' && S.seconds - usedSec(V) > 2) {
					V.probe = 'slow';
					note(`${V.label}: the finest cells are too many here (${h === 'full' ? 'the table filled' : `no try through in ${cur.opts.probeS} s`}); from coarse cells up`);
					Object.assign(V, { pass: PASS_START, passes: V.passes + 1, layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: '', salt: 0, saltNoted: 0 });
					launchOrWait(n);
					save();
					return;
				}
				V.probe = h === 'finish' ? 'passed' : 'ended';
			}
			// how this pass ended: why the editor stopped it, else the tool's own verdict
			const how = ch.stopWhy || (code === 0 && !V.error ? end : '');
			if (how) V.ends[V.pass] = { how, seconds: V.share, layer: V.layer };
			// every situation tried without a finish: the evidence that there is no route, but only when every layer kept
			// all its situations (the tool counts those it left out) and the cells were not coarse (they merge too much:
			// a ball speeding up slowly shares a cell with the ball at rest)
			const verdict = how === 'exhausted' && !V.depthCap && !V.found;
			const why = !verdict ? '' : V.pass < 0 ? ' (coarse cells: that proves little)' : overflow === null ? ' (the engine does not say whether full layers were cut)'
				: overflow > 0 ? ` (${overflow.toLocaleString('en-US')} situations were cut from full layers)` : '';
			if (verdict && !why && (!V.exhausted || V.pass > V.exhausted.pass)) V.exhausted = { pass: V.pass, tick: V.layer, grain: passGrain(V.pass) };
			if (verdict && !why) V.tries = (V.tries || 0) + lanesNow;   // (its last batch's tries)
			const left = S.seconds - usedSec(V);
			const next = how && how !== 'stopped' && !V.error ? nextPass(V.pass, how, V.ends, S.result ? boundTicks() : 0, left) : null;
			if (next !== null && S.running && !S.halted && S.stage !== 'stopped' && left > 2) {
				const what = { full: 'the table is full', time: `no route in its ${V.share} s`, exhausted: 'every situation tried', finish: 'route found', depth: 'no faster route',
					beaten: 'a faster route is known' }[how];
				note(`${V.label}: ${what} at tick ${V.layer}${why}; again with ${next < V.pass ? 'coarser' : 'finer'} cells${S.result ? `, for a route under ${boundTicks()} ticks` : ''}`);
				Object.assign(V, { pass: next, passes: V.passes + 1, layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: '' });
				launchOrWait(n);
				save();
				return;
			}
			if (why) note(`${V.label}: every situation tried at tick ${V.layer}${why}`);
			// no next pass, time left, and this pass went through its whole depth (no route, or none faster): the same pass
			// again with another salt. Merged situations are not a proof: which state stands for a cell decides whether a
			// pixel-exact move survives (the 40x25 shaft level: its 251-tick route comes out of the finest pass with 2
			// salts of 13, 1.2 s each), so each salt explores another merged graph
			if (next === null && cur.opts.salts && (how === 'exhausted' || how === 'depth' || how === 'finish' || how === 'beaten') && S.running && !S.halted &&
				S.stage !== 'stopped' && left > 2 && !V.error) {
				// (the next salt after the last one tried: the tool reports it; else this run's first batch covered lanesRun)
				V.salt = Math.max((V.salt || 0) + lanesRun - 1, lastSalt) + 1;
				if (how === 'exhausted' && V.pass >= 0 && overflow === 0) yieldBeams(n);
				if (!V.saltNoted || V.salt - V.saltNoted >= 10) {
					V.saltNoted = V.salt;
					note(`${V.label}: ${how === 'exhausted' ? `every situation tried at tick ${V.layer}` : 'no faster route'}; again with other states standing for merged situations (try ${V.salt + 1}` +
						`${V.lanes > 1 ? `, ${V.lanes} side by side` : ''})`);
				}
				Object.assign(V, { passes: V.passes + 1, layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: '' });
				launchOrWait(n);
				save();
				return;
			}
		}
		if (V.key === 'relay' && ch.stopWhy === 'breaker' && S.running && !S.halted && S.stage !== 'stopped' && !S.gpuFailed) {
			// (stopped for the wall breaker's round: after it, from the same step of its plan)
			Object.assign(V, { state: 'waiting', detail: 'waits while the wall breaker has the GPU', deferred: true });
			totals();
			if (!running()) finish(); else save();
			return;
		}
		if (V.key === 'relay' && S.running && !S.halted && S.stage !== 'stopped' && !S.gpuFailed) {
			const how = ch.stopWhy || (code === 0 ? end : '');
			const R = V.relay;
			if (how !== 'stopped' && how !== 'beaten' && how !== 'finish' && R) {
				if (how === 'nearer') V.state = 'starting';
				// ("the prefix dies" and the like: another point, not an error of the search)
				V.error = null;
				const nearer = S.closest && R.src && S.closest.dist < R.src.best - 0.5;
				// (ran out of situations: finer cells from the same point first, however deep it got: the ice level's 4 px
				// relay ran 900 ticks through everything its cells could tell apart and never climbed the one-tile staircase
				// shaft at (69, 96) that its finest cells climb in 113 ticks; only then further back)
				if (nearer) { R.back = 0; R.pick = null; R.cellsSet = false; }
				else if (how === 'exhausted' && R.cells + 1 < RELAY_CELLS.length) R.cells++;   // (a source: the same one, R.pick)
				else { R.back++; R.pick = null; R.cellsSet = false; }
				if (relayFrom(n)) { save(); return; }
				Object.assign(V, { state: 'waiting', detail: 'waits for a nearer attempt to go on from' });
				setImmediate(resumeExplore);
			}
		}
		if (V.key === 'breaker') {
			const how = ch.stopWhy || (code === 0 ? end : '');
			if (S.running && !S.halted && S.stage !== 'stopped' && !S.gpuFailed && how !== 'stopped' && how !== 'beaten' && how !== 'finish') {
				// (out of GPU memory, or a table smaller than planned (memwait): the same step again after a back-off, at most
				// BREAK_MEM_WAITS times a round; then as before)
				const R = brk && brk.round;
				if (R && R.chain && (how === 'memwait' || (V.error && gpuTransient(V.error))) && (R.memWaits || 0) < BREAK_MEM_WAITS) {
					V.retries = R.memWaits || 0;
					R.memWaits = V.retries + 1;
					if (!V.error) V.error = `2^${V.brk.cellLog} cells do not fit the GPU's free memory now (2^${V.brk.cellLogGot})`;
					if (gpuRetry(n, null, () => { if (!breakLaunch(n) && !running()) finish(); })) { save(); return; }
				}
				// ("the prefix dies", out of GPU memory and the like: the next starting point, not an error of the search)
				if (V.error) { note(`${V.label}: ${V.error}; the next starting point`); V.error = null; if (brk && brk.round) brk.round.chain = null; }
				if (breakAfter(n, how)) { save(); return; }
			} else if (brk && brk.round) breakEnd(n);   // (a stop, a route, a failed GPU: the round is over)
		}
		if (V.state === 'running' || V.state === 'starting') {
			if (V.error || (code !== 0 && code !== null && !ch.killed)) {
				V.state = 'error';
				V.error = V.error || `exit code ${code}${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 300)}` : ''}`;
			} else V.state = V.found ? 'found' : S.stage === 'stopped' ? 'stopped' : 'ended';
		}
		totals();
		if (!cpu) cpuDone();
		proofAlone();
		if (!running()) finish();
		else save();
	});
	ch.cpuSearch = cpu;
	ch.rollsSearch = rolls;
	return ch;
}
/** every GPU strategy has ended with a route known (the exploration's finest passes found none faster): the CPU search
 *  stops too, and the GPU random runs with it (a search like the CPU one); not when one of them failed (then the CPU
 *  search is the search, as without a GPU). The proof (a CPU process) does not count: its end asks again. */
function cpuDone() {
	if (!S.result || !S.strategies.some((q) => !q.cpu && !q.rolls) || [...busy].some((c) => !c.cpuSearch && !c.rollsSearch && c !== proofKid) ||
		S.strategies.some((q) => !q.cpu && !q.rolls && q.state === 'error') || retryHolds()) return;
	// (the one search is a GPU search too: it goes on looking for faster routes, its bursts bounded by the route, until
	// the time is up)
	S.strategies.forEach((q, k) => { if ((q.cpu || q.rolls) && !q.gpuShare && alive(kids[k])) { if (!q.found) q.state = 'beaten'; halt(kids[k], 'finish'); } });
}
/**
 * "every move" (strategy n) tried every situation at a fine grain with nothing cut and found no route: the GPU beams (a
 * subset of those situations, exact) give way, so its tries with other salts get the whole GPU (a beam beside them made
 * them about 3x slower on the shaft level). A beam still getting nearer the trophy keeps running (BEAM_PROGRESS_MS).
 */
function yieldBeams(n) {
	if (S.result) return;
	for (let k = 0; k < kids.length; k++) {
		const Q = S.strategies[k];
		// (a beam already told to stop is still alive until its process exits: noted once)
		if (k === n || !alive(kids[k]) || kids[k].stopWhy || (Q.key !== 'goal' && Q.key !== 'guide')) continue;
		if (Q.bestAt && Date.now() - Q.bestAt < BEAM_PROGRESS_MS) continue;   // (still getting nearer the trophy: asked again at the next try)
		Q.state = 'stopped'; Q.detail = 'gave the GPU to every move\'s tries';
		halt(kids[k], 'stopped');
		note(`${Q.label}: stopped (every move tried every situation; its tries with other states get the GPU)`);
	}
}
/**
 * A GPU strategy's kernel launch failed (eegpu's {"error":...,"launchError":true}, exit 6 / 7 = the display driver's
 * watchdog, or a crash): the driver may have reset the GPU. The other GPU strategies stop too, and none is relaunched
 * (no next pass, no salt rerun); the CPU search goes on. The page shows the error with the strategy.
 */
function gpuFailed(n) {
	if (S.gpuFailed) return;
	S.gpuFailed = true;
	for (let k = 0; k < kids.length; k++) {
		const Q = S.strategies[k];
		if (k === n || Q.cpu || !alive(kids[k]) || kids[k].stopWhy) continue;
		Q.state = 'stopped'; Q.detail = 'the GPU failed';
		halt(kids[k], 'stopped');
	}
	note(`the GPU failed: the GPU searches stop${S.strategies.some((q) => q.cpu) ? ' (the CPU search goes on)' : ''}; search again in a minute or two (a hot GPU slows down)`);
}
/** all strategies have ended: the verdict */
// Find a route has the GPU first: <data>/editor/busy is touched every 5 s while a search runs (a job's GPU searcher,
// src/gpusearch.js, stops its eegpu between two launches and waits while it is fresh) and removed when none runs (the
// proof alone, a CPU process, leaves the GPU to the job)
let busyTimer = null;
function markBusy() {
	const f = path.join(dir(), 'busy'), on = building || [...busy].some((c) => c !== proofKid);
	try { if (on) { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(f, String(Date.now())); } else fs.unlinkSync(f); } catch (e) { /* none */ }
	if (on && !busyTimer) { busyTimer = setInterval(markBusy, 5000); busyTimer.unref(); }
	if (!on && busyTimer) { clearInterval(busyTimer); busyTimer = null; }
}
function finish() {
	S.running = false;
	if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
	if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
	clearRetries();
	sched = null;
	for (let k = 0; k < S.strategies.length; k++) { try { fs.unlinkSync(pauseFileOf(k)); } catch (e) { /* none */ } }
	S.strategies.forEach((q) => { if (q.state === 'waiting') Object.assign(q, { state: 'ended' }); });
	setImmediate(markBusy);
	S.elapsed = (Date.now() - S.started) / 1000;
	S.searchElapsed = searchClock(Date.now());
	// (the first search after an update: the GPU engine's start took a while; the search time did not count it)
	const prep = S.searchStarted && S.prepSec >= 5 ? `, after ${S.prepSec.toFixed(0)} s preparing the GPU engine` : '';
	// (the exploration's deepest pass: a later, finer one can end sooner)
	S.layer = Math.max(0, ...S.strategies.map((q) => Math.max(q.layer, q.deepest || 0)));
	S.tick = S.layer;
	if (S.result) S.stage = 'found';
	else if (S.stage === 'stopped') S.message = S.message || 'The search was stopped before it found a route.';
	else if (S.strategies.every((q) => q.state === 'error') && !(S.proof && S.proof.verdict === 'impossible')) {
		S.stage = 'error';
		S.message = `The ${S.cpuOnly ? 'CPU' : 'GPU'} search failed: ${S.strategies.map((q) => q.error).filter(Boolean).join('; ')}`;
	} else if (S.stage !== 'error') {
		S.stage = 'not found';
		// (the beams' depth limit: only when nothing went deeper (Infinity Pain's hour said "reached its depth limit of 2288
		// ticks" while the CPU search had gone 7,730 ticks deep), and only the beams' own layers: the relay's and the GPU
		// random runs' are not bound by it (the random runs' 6,282 ticks deep made a search the beams had ended at tick 529 say
		// it had reached the limit of 2,288)
		const capped = S.layer <= S.depth && S.strategies.some((q) => (q.key === 'goal' || q.key === 'guide') && q.layer >= S.depth);
		const XE = S.strategies.find((q) => q.key === 'explore' && q.exhausted);
		const X = S.strategies.find((q) => q.key === 'explore');
		const R = S.strategies.find((q) => q.cpu);
		const xd = X ? Math.max(X.layer, X.deepest || 0) : 0;
		const what = [];
		if (xd) what.push(`every move to tick ${xd.toLocaleString('en-US')}${X.passes > 1 ? ` in ${X.passes} passes` : ''}`);
		if (!S.cpuOnly) what.push(`the beams kept ${S.width.toLocaleString('en-US')} states per tick`);
		if (R && R.states) what.push(`random runs kept ${R.states.toLocaleString('en-US')} situations`);
		S.message = `No route to the trophy found in ${S.searchElapsed.toFixed(0)} s${prep} (${S.layer.toLocaleString('en-US')} ticks deep${what.length ? `; ${what.join('; ')}` : ''})` +
			(capped ? `: the search reached its depth limit of ${S.depth} ticks (${C.fmt(S.depth)} of play).` : '.') +
			(S.cpuOnly ? ' Try a longer search (without an NVIDIA GPU only the CPU searches).'
				: ` Try a longer search or more states per tick${S.guidePoints ? ', or another guide line' : ', or draw a guide line that shows the way'}.`);
		if (S.physics && S.physics.noWayUp) {
			// the reach field is optimistic (generous jumps, dots, arrows; sideways moves free), so this is a proof
			S.impossible = { by: 'physics' };
			const ex = S.physics.explain;
			const high = ex && ex.row >= 0 && ex.trophyRow >= 0 && ex.row > ex.trophyRow ? ` The ball's centre gets no higher than row ${ex.row}; the trophy is in row ${ex.trophyRow}.` : '';
			S.message = `No route: the trophy cannot be reached from the start.${high} There is no way up to it: a jump rises 63.4 px (the box stands on ledges up to 3 tiles high), ` +
				'one row of dots lifts the ball about 1 row, arrows and liquids by their height (the check is generous), and walls and spikes block the rest ' +
				'(a death that takes the ball to a checkpoint or another spawn point counts as a way too).';
		} else if (S.proof && S.proof.verdict === 'impossible') {
			// the proof (eegpu prove) holds no state with the ball at the trophy: no input sequence gets there
			S.impossible = { by: 'prover' };
			S.message = PV.message(S.proof);
		} else if (XE) {
			// merged situations are not a proof: one exact pixel can hide between them
			const tries = XE.tries > 1 ? ` in all ${XE.tries} tries (each with other states standing for merged situations)` : '';
			S.message = `No route found: "every move" ran out of new situations by tick ${XE.exhausted.tick.toLocaleString('en-US')}${tries} (positions and speeds told apart to ${XE.exhausted.grain}, ` +
				'and every gravity, jump and pickup state; the physics check ruled out the rest). That is evidence, not proof: a route that needs pixel-exact moves can hide between merged situations. A longer search tries more.';
		}
		// (the model's only way is a death: the searches cannot find it)
		if (S.physics && S.physics.viaDeath) S.message += ` ${deathNote(S.physics)}`;
	}
	note(S.stage === 'found' ? `route ${S.result.time} (${S.result.ticks} ticks, ${S.result.strategy})` : S.message);
	cur = null;
	dropSources();
	saveNow();
}
/** a route from strategy n: replayed in the exact JS engine before it counts; the fastest one is kept. more: the
 *  strategy reports more routes of the same length (its process ends by itself) */
function found(inputs, n, more) {
	const V = S.strategies[n];
	if (!cur) return;
	const masks = Uint8Array.from(String(inputs), (c) => (c.charCodeAt(0) - 48) & 31);
	const ev = C.evaluate(cur.level, masks);
	// a beam ends at the first finish (the fastest it reached); the tool would still re-check every other state that
	// finished in the same tick before it exits, which only costs time
	if (!more) halt(kids[n], 'finish');
	if (!ev) {
		V.state = 'error';
		V.error = 'it reported a route that does not finish in the exact JS engine (please report this: the two engines disagree)';
		note(`${V.label}: ${V.error}`);
		save();
		return;
	}
	const first = V.state !== 'found';
	V.state = 'found';
	if (S.physics && S.physics.noWayUp && first) {
		// the physics check called this level impossible, and a route replays: a bug in the model (src/reach.js), kept
		try { C.writeJSON(path.join(dir(), 'model_miss.json'), { t: new Date().toISOString(), levelHash: S.levelHash, eelvlB64: cur.buf.toString('base64'), inputs: C.eetasBytes(ev.ms).toString('latin1'), strategy: V.label }); } catch (e) { /* read-only */ }
		note(`the physics check ruled this level out, but ${V.label} found a route: a mistake in the physics model (saved in model_miss.json; please report it)`);
	}
	if (S.proof && S.proof.verdict === 'impossible') proofMiss(V.label, C.eetasBytes(ev.ms).toString('latin1'));
	if (!V.found || ev.runTicks < V.found.runTicks) V.found = { ticks: ev.ms.length, runTicks: ev.runTicks, time: C.fmt(ev.runTicks) };
	const better = !S.result || ev.runTicks < S.result.runTicks || (ev.runTicks === S.result.runTicks && ev.ms.length < S.result.ticks);
	// (the fastest route as found: the search's bounds, as without the cleanup; each one is cleaned, and a cleaned route
	// replaces S.result when it is better)
	const rb = S.rawBest, rawBetter = !rb || ev.runTicks < rb.runTicks || (ev.runTicks === rb.runTicks && ev.ms.length < rb.ticks);
	if (rawBetter) S.rawBest = { runTicks: ev.runTicks, ticks: ev.ms.length };
	if (first || ((V.cpu || V.rolls) && better)) note(`${V.label}: ${first ? 'route' : 'a faster route'} ${C.fmt(ev.runTicks)} (${ev.ms.length} ticks)`);
	if (better) {
		setResult(cur.level, ev, { foundAfter: Math.round((Date.now() - S.started) / 100) / 10,
			cpuAfter: Math.round(S.strategies.reduce((a, q) => a + (q.cpu && q.cpuS > 0 ? q.cpuS : 0), 0) * 10) / 10, strategy: V.label });
	}
	if (rawBetter) cleanLater(ev, V.label);
	S.stage = 'found';
	// the other strategies: those already deeper than this route cannot find a faster one; the CPU search is told the
	// bound (it goes on looking for a faster route)
	S.strategies.forEach((q, k) => {
		if (k !== n && !q.cpu && !q.rolls && alive(kids[k]) && q.layer >= boundTicks()) { q.state = 'beaten'; halt(kids[k], 'beaten'); }
	});
	if (better || rawBetter) tellCpu(boundTicks(), S.result.inputs, n);
	// (a route: every move, if it gave way to the relay, goes on and looks for a faster one)
	if (better) setImmediate(resumeExplore);
	save();
}
/** S.result from a replayed route (ev: C.evaluate) and route.eetas; o: {foundAfter, cpuAfter, strategy, cleaned} */
function setResult(level, ev, o) {
	const tr = C.replay(level, ev.ms, { trace: true });
	const pathPts = [];
	for (let t = 0; t <= tr.n; t++) pathPts.push([Math.round((tr.X[t] + 8) * 10) / 10, Math.round((tr.Y[t] + 8) * 10) / 10]);
	try { C.writeEetas(path.join(dir(), 'route.eetas'), ev.ms); } catch (e) { /* read-only data folder */ }
	S.result = { ticks: ev.ms.length, completeTick: ev.complete, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), deaths: ev.deaths, coins: ev.coins,
		chance: ev.chance, inputs: C.eetasBytes(ev.ms).toString('latin1'), foundAfter: o.foundAfter, cpuAfter: o.cpuAfter, path: pathPts,
		strategy: o.strategy, verified: 'replayed in the exact JS engine: it finishes', ...(o.cleaned ? { cleaned: o.cleaned } : {}) };
}
// ---------------------------------------------------------------- the route cleanup (src/cleanroute.js)
// Every new best route is cleaned in a worker thread (the random runs' pointless jump presses, up / down presses and
// direction flips dropped while it still finishes and is not slower; every edit replayed, the result by C.evaluate):
// S.result.clean is 'pending' meanwhile (the AutoTASer waits for it before it makes the job: the job's base is the
// cleaned route), then 'done' (S.result is the cleaned route, `cleaned` {fromRunTicks, fromTicks, presses, sec}) or
// 'kept' (nothing to drop, or it failed: the route as found). One cleanup at a time; a newer best waits (the newest).
const CLEAN_MS = 20000;   // a route's cleanup budget (the laptop: 1-8 s for the AutoTAS base routes)
let cleaning = null, cleanNext = null;
/** the cleanup's mode: the request's `clean` (false / 'off', 'cosmetic', 'full'), else EEAT_CLEAN (0 = off), else
 *  CLEAN_DEFAULT; 'cosmetic': only edits that change no state (the same states and time), 'full': shortcuts too */
const CLEAN_DEFAULT = 'full';
function cleanModeOf(v) {
	const e = process.env.EEAT_CLEAN;
	const m = v === false ? 'off' : typeof v === 'string' ? v : e === '0' ? 'off' : e === 'cosmetic' || e === 'full' ? e : CLEAN_DEFAULT;
	return m === 'off' || m === 'cosmetic' || m === 'full' ? m : CLEAN_DEFAULT;
}
/** the search's bound: the fastest route as found (S.rawBest; the cleanup never tightens it: the searches run as they
 *  would without it), else S.result's */
const boundTicks = () => (S.rawBest ? S.rawBest.ticks : S.result ? S.result.ticks : 0);
function cleanLater(ev, label) {
	if (!S || !cur) return;
	const inputs = C.eetasBytes(ev.ms).toString('latin1');
	if (S.cleanMode === 'off') return;
	const R0 = S.result;
	cleanNext = { S, level: cur.level, buf: cur.buf, inputs, runTicks: ev.runTicks, ticks: ev.ms.length, label,
		foundAfter: Math.round((Date.now() - S.started) / 100) / 10, cpuAfter: R0 ? R0.cpuAfter : 0 };
	if (R0 && R0.inputs === inputs) R0.clean = 'pending';
	if (!cleaning) cleanStart();
}
function cleanStart() {
	const job = cleanNext;
	cleanNext = null;
	if (!job || job.S !== S) return;
	let w;
	try {
		w = new Worker(require.resolve('./cleanroute.js'), { workerData: { cleanRoute: true, eelvl: Uint8Array.from(job.buf), inputs: job.inputs, ms: CLEAN_MS,
			cosmetic: job.S.cleanMode === 'cosmetic' } });
	} catch (e) { cleanDone(job, { error: String(e && e.message || e) }); return; }
	if (w.unref) w.unref();
	cleaning = w;
	let over = false;
	const done = (r) => {
		if (over) return;
		over = true;
		cleaning = null;
		cleanDone(job, r);
		if (cleanNext) cleanStart();
	};
	w.once('message', done);
	w.once('error', (e) => done({ error: String(e && e.message || e) }));
	w.once('exit', () => done({ error: 'the cleanup ended' }));
}
/** a route's cleanup is back: S.result becomes the cleaned route when it is better (or it is the route it was made
 *  from); `clean` 'done' / 'kept' on the route it was made from */
function cleanDone(job, r) {
	const S0 = job.S;
	if (S0 !== S) return;
	const R0 = S.result;
	const mine = !!R0 && R0.inputs === job.inputs;
	let ev = null;
	if (r && !r.error && r.changed) {
		const masks = Uint8Array.from(String(r.inputs), (c) => (c.charCodeAt(0) - 48) & 31);
		ev = C.evaluate(job.level, masks);
		if (ev && (ev.runTicks > job.runTicks || (R0 && (ev.deaths > R0.deaths || ev.chance < R0.chance - 1e-9)))) ev = null;
	}
	const better = !!ev && (!R0 || mine || ev.runTicks < R0.runTicks || (ev.runTicks === R0.runTicks && ev.ms.length < R0.ticks));
	if (!better) {
		if (mine) { R0.clean = 'kept'; if (r && r.error) R0.cleanError = r.error; save(); }
		return;
	}
	const cleaned = { fromRunTicks: job.runTicks, fromTicks: job.ticks, presses: [r.before.pressesPerS, r.after.pressesPerS], changesPerS: [r.before.changesPerS, r.after.changesPerS],
		sec: r.sec };
	setResult(job.level, ev, { foundAfter: mine ? R0.foundAfter : job.foundAfter, cpuAfter: mine ? R0.cpuAfter : job.cpuAfter, strategy: job.label, cleaned });
	S.result.clean = 'done';
	note(`the route cleaned: ${C.fmt(job.runTicks)} -> ${C.fmt(ev.runTicks)}, jump presses ${r.before.pressesPerS} -> ${r.after.pressesPerS} a second (${r.sec.toFixed(1)} s)`);
	tellCpu(boundTicks(), S.result.inputs, -1);
	save();
}
/** a strategy's closest attempt (ev: {dist (tiles to the trophy by the reach field), tick, inputs, cut}): kept when it is
 *  the nearest so far (or as near and shorter), replayed in the JS engine for its path. dist >= 1e4 (with "cut":1): the
 *  physics check rules out every state the tool has seen so far, dist - 1e4 is the walking distance; such an attempt
 *  never replaces one the check allows */
/** the one search (ONE_LABEL): another operator's attempt (the GPU random runs' first arrival in a room, their nearer
 *  attempt) into its archive: its stdin "import <inputs>" (goexplore.js), at most one per ONE_FEED_MS, the newest waiting
 *  (a room's first arrival before a nearer attempt) */
const ONE_FEED_MS = 250;
let feedQ = [], feedAt = 0, feedTimer = null, feedS = null;
function feedOne(inputs, room) {
	if (!cur || !cur.opts.bursts || !inputs || !/^[0-O]+$/.test(inputs)) return;
	if (feedS !== S) { feedS = S; feedQ = []; }   // (a new search: nothing of the last one's)
	const k = S.strategies.findIndex((q) => q.gpuShare);
	if (k < 0) return;
	if (room) feedQ.unshift({ inputs, room }); else { feedQ = feedQ.filter((x) => x.room); feedQ.push({ inputs, room }); }
	if (feedQ.length > 64) feedQ.length = 64;
	const S0 = S;
	const flush = () => {
		feedTimer = null;
		if (S !== S0 || !S.running || !feedQ.length) return;
		const ch = kids[k];
		if (!alive(ch) || !ch.stdin || ch.stdin.destroyed) { feedQ = []; return; }
		const x = feedQ.shift();
		try { ch.stdin.write(`import ${x.inputs}\n`); S.strategies[k].fed = (S.strategies[k].fed || 0) + 1; } catch (e) { /* gone */ }
		feedAt = Date.now();
		if (feedQ.length) { feedTimer = setTimeout(flush, ONE_FEED_MS); if (feedTimer.unref) feedTimer.unref(); }
	};
	if (!feedTimer) { const w = Math.max(0, ONE_FEED_MS - (Date.now() - feedAt)); if (w) { feedTimer = setTimeout(flush, w); if (feedTimer.unref) feedTimer.unref(); } else flush(); }
}
function closer(ev, n) {
	if (!cur) return;
	const Vn = S.strategies[n];
	// (a wall breaker run aimed at a gate by the gate's own field: its distances are to the gate, not the trophy: only its
	// own nearest, for its chain; the chain's attempts reach the others as seeds)
	if (Vn.key === 'breaker' && Vn.brk && Vn.brk.gateReach) {
		const d = +ev.dist;
		if (ev.inputs && !ev.cut && Number.isFinite(d) && (!Vn.bestTry || d < Vn.bestTry.dist - 1e-3)) Vn.bestTry = { inputs: String(ev.inputs), ticks: String(ev.inputs).length, dist: d };
		// (at the gate: the leg field's cost 0 is the coin's tile, the ball's centre in it; explore reports the closest
		// attempt only with the finish target, so the run keeps --finish and the gate is this: the chain goes on from it)
		if (ev.inputs && !ev.cut && d <= GATE_AT && !Vn.brk.gateHit) { Vn.brk.gateHit = String(ev.inputs); halt(kids[n], 'gate'); }
		return;
	}
	// (the GPU random runs' nearer attempts: into the one search's archive)
	if (Vn.rolls && ev.inputs && !ev.cut && (!(Vn.best >= 0) || steerDist(Vn, +ev.dist) < Vn.best - 1e-3)) feedOne(String(ev.inputs), false);
	const dist = steerDist(Vn, +ev.dist), old = S.closest;
	// (each strategy's own nearest, and when it last got nearer: a beam still closing in keeps the GPU, yieldBeams; its
	// room becomes a source for the relay: attemptSource)
	// (by the steer field: no deaths in it, and its "no value" states at STEER_MISS tiles and more)
	const deathTilesNow = cur.distBySteer ? STEER_MISS : deathTiles();
	let own = null;
	if (Number.isFinite(dist) && dist < 1e4 && (!(Vn.best >= 0) || dist < Vn.best - 1e-3)) {
		Vn.best = dist; Vn.bestAt = Date.now();
		if (ev.inputs && !ev.cut && dist < deathTilesNow) own = Vn.bestTry = { inputs: String(ev.inputs), ticks: String(ev.inputs).length, dist };
	}
	if (!Number.isFinite(dist) || dist >= 2e4) { if (own) attemptSource(n, own); return; }
	const cut = !!ev.cut || dist >= 1e4;
	if (old && ((cut && !old.cut) || (cut === !!old.cut && !(dist < old.dist - 1e-3 || (Math.abs(dist - old.dist) <= 1e-3 && ev.tick < old.ticks))))) { if (own) attemptSource(n, own); return; }
	const masks = Uint8Array.from(String(ev.inputs || ''), (c) => (c.charCodeAt(0) - 48) & 31);
	if (!masks.length) return;
	// (one replay: the path, and the room it ends in for the sources)
	const tr = replayRooms(masks, true);
	if (own) attemptSource(n, own, tr.room);
	const pathPts = tr.path;
	try { C.writeEetas(path.join(dir(), 'closest.eetas'), masks); } catch (e) { /* read-only data folder */ }
	setImmediate(relayKick);
	// (a way through a death: the reach field prices the death at RF.DEATH_TILES; the tiles shown leave it out)
	const viaDeath = !cut && !cur.distBySteer && dist >= deathTiles();
	// (the tiles shown: the reach field's, also when the steer field ranks the attempts)
	const shown = cur.distBySteer && tr.reachTiles !== null ? tr.reachTiles : cut ? dist - 1e4 : viaDeath ? dist - RF.DEATH_TILES : dist;
	// (the wall breaker's stall clock: a nearer attempt by BREAK_TILES)
	if (brk && !cut && dist < brk.mark - BREAK_TILES) { brk.mark = dist; breakProgress('nearer'); }
	S.closest = { dist, cut, viaDeath, tiles: Math.round(shown * 10) / 10, ticks: masks.length, runTicks: tr.runTicks, time: C.fmt(tr.runTicks), deaths: tr.deaths,
		inputs: C.eetasBytes(masks).toString('latin1'), path: pathPts, strategy: S.strategies[n].label, foundAfter: Math.round((Date.now() - S.started) / 100) / 10,
		...(cur.distBySteer ? { steer: Math.round(dist * 10) / 10 } : {}) };
	// (the nearest by the reach field among the attempts kept: the yardstick of a search without the steer field)
	if (tr.reachTiles !== null && !(S.nearestReach && S.nearestReach.tiles <= tr.reachTiles)) S.nearestReach = { tiles: Math.round(tr.reachTiles * 10) / 10, ticks: masks.length, after: S.closest.foundAfter };
	save();
}
/** stops the running search (a route found so far stays) */
function stop() {
	if (!running()) return state();
	S.halted = true;   // (no next pass either)
	S.stage = S.result ? 'found' : 'stopped';
	S.message = S.result ? '' : 'The search was stopped before it found a route.';
	S.strategies.forEach((q, k) => { if (alive(kids[k])) { q.state = 'stopped'; halt(kids[k], 'stopped'); } });
	for (let k = 0; k < S.strategies.length; k++) { try { fs.unlinkSync(pauseFileOf(k)); } catch (e) { /* none */ } }
	// (a strategy waiting to start again after a GPU memory error: it does not; nothing else running, the search ends)
	if (retryHolds()) {
		clearRetries();
		S.strategies.forEach((q, k) => { if (q.state === 'waiting' && !alive(kids[k])) q.state = 'stopped'; });
		if (!running()) { finish(); return state(); }
	}
	proofAlone();
	saveNow();
	if (building) {
		// still checking the physics / the GPU tool (the GPU's first load can take minutes): nothing runs yet, so the
		// search ends now; the check's late answer is dropped (searchGen) and a new search can start at once
		building = false;
		searchGen++;
		S.strategies.forEach((q) => { if (q.state === 'starting') q.state = 'stopped'; });
		finish();
		return state();
	}
	save();
	return state();
}
/** the last search's files: 'route.eetas' (when a route was found), 'closest.eetas' (its closest attempt) or
 *  'level.eelvl'; null when missing */
function solveFile(what) {
	if (what !== 'route.eetas' && what !== 'level.eelvl' && what !== 'closest.eetas') return null;
	const st = state();
	if (what === 'route.eetas' && !st.result) return null;
	if (what === 'closest.eetas' && !st.closest) return null;
	const f = path.join(dir(), what);
	if (!fs.existsSync(f)) return null;
	const nice = `${safeName(st.name)}${what === 'route.eetas' ? ` route ${st.result.time.replace(':', 'm')}.eetas` : what === 'closest.eetas' ? ' closest attempt.eetas' : '.eelvl'}`;
	return { file: f, name: nice };
}

// ---------------------------------------------------------------- a job from a found route (Watch / Optimize)
/** b: { eelvlB64, eetasB64 } (else the last search's level and route), name. Returns the job's meta (jobs.importJob). */
function makeJob(b) {
	const J = require('./jobs.js');
	const st = state();
	const eelvl = b.eelvlB64 ? Buffer.from(String(b.eelvlB64), 'base64') : fs.existsSync(path.join(dir(), 'level.eelvl')) ? fs.readFileSync(path.join(dir(), 'level.eelvl')) : null;
	const eetas = b.eetasB64 ? Buffer.from(String(b.eetasB64), 'base64') : st.result && fs.existsSync(path.join(dir(), 'route.eetas')) ? fs.readFileSync(path.join(dir(), 'route.eetas')) : null;
	if (!eelvl || !eelvl.length) throw new Error('missing eelvlB64 (the level)');
	if (!eetas || !eetas.length) throw new Error('missing eetasB64 (the route; find one first)');
	const name = String(b.name || st.name || 'Editor level').slice(0, 80);
	// one spawn point: started after /reset or right after loading makes no difference
	return J.importJob({ eelvl, eetas, name, eelvlName: `${safeName(name)}.eelvl`, eetasName: `${safeName(name)} route.eetas`, startMode: 'reset' });
}

/** stops a running search (the server is shutting down) */
function shutdown() {
	if (S) { S.halted = true; saveNow(); }
	for (const ch of kids) halt(ch, 'stopped');
	if (alive(proofKid)) { try { proofKid.kill(); } catch (e) { /* gone */ } }
}

module.exports = { normalize, records, eelvlOf, levelOf, blockInfo, inspect, check, reachFrom, start, state, stop, found, solveFile, makeJob, shutdown,
	safeName, passCells, passGrain, nextPass, passSeconds, cpuWorkers, breakCells, sourcesOf, coinsOfDesc, STRATEGIES, MAX_SIDE, MAX_CELLS, PASS_MIN, PASS_MAX, PASS_START, LANES, NO_WAY_UP_S };
