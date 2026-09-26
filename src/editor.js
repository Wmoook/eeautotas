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
const C = require('./common.js');
const E = C.E;
const EL = require('./eelvl.js');
const G = require('./gpu.js');
const B = require('./blocks.js');
const M = require('./minimap.js');
const RF = require('./reach.js');
const BENCH = require('./bench.js');

const MAX_SIDE = 1000, MAX_CELLS = 1e6;
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
 *  `portals` also from an entered portal to every exit of its target */
function reachFrom(L, sx, sy, portals) {
	const W = L.width, H = L.height, N = W * H;
	const seen = new Uint8Array(N);
	const q = [sy * W + sx];
	seen[q[0]] = 1;
	const push = (j) => { if (!seen[j]) { seen[j] = 1; q.push(j); } };
	while (q.length) {
		const i = q.pop(), x = i % W, y = Math.floor(i / W);
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
	return seen;
}
/**
 * What stands in the way of a route search on this level (.eelvl bytes): problems (it cannot run) and notes.
 * Returns { problems: [{code, text}], notes: [text], start: [x, y] | null, trophies, level (prepared), json }.
 */
function inspect(buf) {
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
	return { problems, notes, start, noSpawn, trophies: trophies.map((i) => [i % W, Math.floor(i / W)]), reach, level, json };
}
/** inspect() for the page: no engine objects */
function check(buf) {
	const r = inspect(buf);
	return { problems: r.problems, notes: r.notes, start: r.start, noSpawn: r.noSpawn, trophies: r.trophies, reach: r.reach, width: r.level.width, height: r.level.height };
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
// ended with a route known (the finest passes found none faster) and none failed. Its depth limit is the request's
// (6000 ticks), not cut by the beams' width. Without an NVIDIA GPU it is the whole search.
const STRATEGIES = {
	explore: { label: 'every move', args: (f, o, q) => { const c = passCells(q.pass); return ['explore', f.bin, '-', '--finish=1', '--discrete=1', `--depth=${q.depth || 100000}`,
		`--seconds=${q.seconds}`, '--coarse=0', `--cqx=${c.cqx}`, `--cqv=${c.cqv}`, `--qy=${c.qy}`, `--qvy=${c.qvy}`, `--reach=${f.reach}`, ...(o.prune ? ['--prune=1'] : []),
		...(q.salt ? [`--salt=${q.salt}`] : []), ...(q.salts ? ['--salts=1000000'] : [])]; } },
	guide: { label: 'along your line', args: (f, o, q) => [...beamArgs(f, o, q), `--guide=${f.guide}`, '--guideWeight=4', '--goalWeight=4'] },
	goal: { label: 'straight for the trophy', args: (f, o, q) => beamArgs(f, o, q) },
	goexplore: { label: 'random runs (CPU)', cpu: true, args: (f, o, q) => [f.eelvl, `--seconds=${q.seconds}`, `--workers=${o.workers}`, `--seed=${o.seed}`,
		`--depth=${q.depth || o.cpuDepth}`, '--stdin=1'] },
};
const beamArgs = (f, o, q) => ['beam', f.bin, '--goal=1', `--width=${o.width}`, `--seconds=${q.seconds}`, `--depth=${o.depth}`, `--reach=${f.reach}`];
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
function save() { try { C.writeJSON(stateFile(), S); } catch (e) { /* read-only data folder: memory only */ } }
function note(s) { S.log.push(`${new Date().toTimeString().slice(0, 8)} ${s}`); S.log = S.log.slice(-30); }
/** the current or last search */
function state() {
	if (!S) {
		S = C.readJSON(stateFile(), null) || { running: false, stage: 'idle', log: [] };
		if (S.running) { S.running = false; S.stage = 'stopped'; S.message = 'The search stopped when the app closed.'; }
	}
	return Object.assign({}, S, { elapsed: S.running ? (Date.now() - S.started) / 1000 : S.elapsed });
}
const alive = (ch) => !!(ch && ch.exitCode === null && ch.signalCode === null);
const running = () => busy.size > 0;
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
 * (px, the ball's centre; optional), seconds (60), width (beam states per tick, 32768), depth (ticks, 6000), name,
 * workers (the CPU search's threads; default cpuWorkers()), seed (the CPU search's first seed, 1) }.
 * gpu: the server's GPU processor record ({available, why}): without one (or without the native engine, or on a level
 * it cannot run) the CPU search runs alone, with a note. Throws with `problems` when the level is not ready.
 * test (test/editor.js; not from HTTP): { tool: [command, ...arguments] } runs that instead of the native engine;
 * cpu: false leaves the CPU search out, [command, ...arguments] runs that instead of node src/goexplore.js.
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
	// (the CPU search keeps no such table: its depth is not cut by the beams' width)
	const cpuDepth = Math.max(100, Math.min(20000, Math.round(+b.depth || 6000)));
	const d = dir();
	fs.mkdirSync(d, { recursive: true });
	const files = { eelvl: path.join(d, 'level.eelvl'), bin: path.join(d, 'level.bin'), guide: path.join(d, 'guide.txt'), route: path.join(d, 'route.eetas'),
		reach: path.join(d, 'reach.bin') };
	fs.writeFileSync(files.eelvl, buf);
	if (!noGpu) fs.writeFileSync(files.bin, G.levelBlob(ins.level));
	// the reach field (src/reach.js): the searches' physics-aware distance; the explore prunes what it rules out
	const rf = RF.reachField(ins.level);
	if (!noGpu) RF.writeReachFile(rf, files.reach);
	const sim0 = new E.EESim(ins.level);
	sim0.reset();
	const startCost = RF.costAt(rf, sim0.px, sim0.py, sim0.speed_y, !!sim0.on_ground);
	const noWayUp = rf.mode === 'physics' && startCost < 0;
	try { fs.unlinkSync(files.route); } catch (e) { /* none */ }
	if (guide.length && !noGpu) fs.writeFileSync(files.guide, guide.map(([x, y]) => `${x} ${y}`).join('\n') + '\n');
	const which = [...(noGpu ? [] : guide.length ? ['explore', 'guide', 'goal'] : ['explore', 'goal']), ...(cpu ? ['goexplore'] : [])];
	const workers = cpuWorkers(b.workers);
	const seed = Number.isInteger(+b.seed) && +b.seed >= 0 ? +b.seed : 1;
	const name = String(b.name || ins.json.world_name || 'level').slice(0, 80);
	const cpuOnly = noGpu ? `No GPU search: ${noGpu}. The CPU searches alone (random runs on ${workers} thread${workers > 1 ? 's' : ''}): it finds routes, ` +
		`but not always the fastest one${guide.length ? ', and it does not follow the guide line' : ''}; with an NVIDIA GPU "every move" also looks for the fastest.` : '';
	S = { running: true, stage: 'starting', started: Date.now(), elapsed: 0, seconds, width, depth, guidePoints: guide.length, name,
		size: [ins.level.width, ins.level.height], start: ins.start, trophies: ins.trophies.length, notes: ins.notes, reach: ins.reach,
		levelHash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16),
		layer: 0, tick: 0, states: 0, ticksPerSec: 0, result: null, closest: null, message: '', log: [], cpuOnly, workers: cpu ? workers : 0,
		physics: { mode: rf.mode, startCost: startCost < 0 ? null : Math.round(startCost * 10) / 10, noWayUp },
		strategies: which.map((k) => ({ key: k, label: STRATEGIES[k].label, cpu: !!STRATEGIES[k].cpu, state: 'starting', layer: 0, deepest: 0, states: 0, ticksPerSec: 0,
			found: null, error: null, live: false, pass: PASS_START, passes: 1, ends: {}, share: 0, depthCap: 0, detail: '', salt: 0, tries: 0 })) };
	note(`searching ${ins.level.width} x ${ins.level.height}${noGpu ? '' : `, ${width} states per tick`}, up to ${seconds} s: ${S.strategies.map((q) => q.label).join(' and ')}` +
		(guide.length && !noGpu ? ` (a ${guide.length}-point line)` : '') + (cpu ? ` (${workers} CPU thread${workers > 1 ? 's' : ''})` : ''));
	if (cpuOnly) note(cpuOnly);
	save();
	if (noWayUp) note(`the physics check finds no way from the start to the trophy (checking with ${noGpu ? 'random runs' : 'every move'})`);
	cur = { level: ins.level, buf, tool, toolArgs, files, opts: { width, depth, cpuDepth, prune: rf.mode === 'physics', workers, seed, salts: !(test && test.salts === false) },
		cpuCmd: test && Array.isArray(test.cpu) ? test.cpu : [process.execPath, path.join(__dirname, 'goexplore.js')] };
	kids = which.map((k, n) => launch(n));
	return state();
}
/** the CPU strategies' processes: their depth bound (a route of `ticks` is known: only faster ones count) */
function tellCpu(ticks) {
	S.strategies.forEach((q, k) => {
		const ch = kids[k];
		if (q.cpu && alive(ch) && ch.stdin && !ch.stdin.destroyed) { try { ch.stdin.write(`depth ${Math.max(1, ticks - 1)}\n`); } catch (e) { /* gone */ } }
	});
}
/** one strategy's eegpu process (a new pass of the exploration too): its JSON lines update S.strategies[n] and the
 *  totals */
function launch(n) {
	const V = S.strategies[n];
	const left = Math.max(1, Math.round(S.seconds - (Date.now() - S.started) / 1000));
	// salts: the tool itself starts over with the next salt after a try without a route (the finest pass, the last rung of
	// the ladder, from its first run; any pass in a salt rerun)
	const q = { seconds: left, pass: V.pass, depth: 0, salt: V.salt || 0, salts: cur.opts.salts && (V.pass >= PASS_MAX || V.salt > 0) };
	if (V.key === 'explore') {
		q.seconds = V.share = passSeconds(V.pass, V.ends, left);
		// a route of T ticks known: only the first T - 1 ticks (a route there is faster)
		q.depth = V.depthCap = S.result ? Math.max(1, S.result.ticks - 1) : 0;
	}
	const args = STRATEGIES[V.key].args(cur.files, cur.opts, q);
	const cpu = V.cpu;
	// the GPU tool's stop file (halt: it ends between two kernel launches; a kill during a kernel resets the driver)
	const stopFile = cpu ? '' : path.join(dir(), `stop_${n}`);
	if (stopFile) { try { fs.unlinkSync(stopFile); } catch (e) { /* none */ } }
	// the CPU search: node src/goexplore.js (its stdin takes the depth bound: tellCpu)
	const cmd = cpu ? [...cur.cpuCmd, ...args] : [cur.tool, ...cur.toolArgs, ...args, `--stopfile=${stopFile}`];
	const ch = spawn(cmd[0], cmd.slice(1), { stdio: [cpu ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, env: cpu ? C.heapEnv(1024) : undefined });
	ch.stopFile = stopFile;
	if (ch.stdin) ch.stdin.on('error', () => { /* it ended */ });
	busy.add(ch);
	V.live = true;
	let hits = 0, end = '', overflow = null, lastSalt = 0;
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
	const onEvent = (ev) => {
		if (!mine()) return;
		// (halted: its state stays as the halt left it; a GPU tool asked to stop still prints until its next launch)
		if (ch.stopWhy && (ev.ev === 'progress' || ev.ev === 'layer' || ev.ev === 'try')) return;
		if (ev.ev === 'progress' || ev.ev === 'layer') {
			Object.assign(V, { state: cpu && V.found ? 'found' : 'running', layer: ev.layer, deepest: Math.max(V.deepest || 0, ev.layer), states: ev.ev === 'layer' ? ev.kept : ev.states,
				ticksPerSec: Math.round(movesPerSec(ev)) });
			if (ev.ev === 'layer') {
				V.detail = `${(ev.states / 1e6).toFixed(ev.states < 1e7 ? 1 : 0)} M places tried, table ${Math.round(Math.min(1, ev.full) * 100)}% full · pass ${V.passes}, ` +
					`cells of ${passGrain(V.pass)}`;
			} else if (cpu) {
				V.detail = `${ev.workers} thread${ev.workers > 1 ? 's' : ''}, ${ev.states >= 1e6 ? `${(ev.states / 1e6).toFixed(1)} M` : `${Math.round(ev.states / 1e3)} k`} situations kept` +
					(Number.isFinite(ev.bestCost) && !V.found ? `, nearest ${ev.bestCost.toFixed(1)} tiles from the trophy` : '') + (V.found ? ', looking for a faster route' : '');
			}
			if (!S.result && S.stage !== 'error') S.stage = 'searching';
			totals();
			// deeper than the best route: it cannot find a faster one (the CPU search's deepest situation says nothing of
			// the kind: it is told the bound instead, and looks only for faster routes)
			if (!cpu && S.result && ev.layer >= S.result.ticks && alive(ch)) { V.state = 'beaten'; halt(ch, 'beaten'); }
			save();
		} else if (ev.ev === 'result' && ev.kind === 'finish') {
			// (the CPU search goes on looking for faster routes)
			found(ev.inputs, n, cpu);
		} else if (ev.ev === 'try') {
			// a salt rerun's try that ran out of situations (no layer cut, no route bounding it): the evidence counts it
			if (ev.end === 'exhausted' && ev.overflow === 0 && !V.depthCap && !V.found && V.pass >= 0) {
				V.tries = (V.tries || 0) + 1;
				if (!V.exhausted) V.exhausted = { pass: V.pass, tick: ev.layers, grain: passGrain(V.pass) };
				yieldBeams(n);
			}
			if (Number.isFinite(ev.salt)) lastSalt = ev.salt;
		} else if (ev.ev === 'warning') {
			note(`${V.label}: ${ev.text}`);
		} else if (ev.ev === 'closest') {
			closer(ev, n);
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
			S.gpu = ev.gpu && ev.gpu.name ? ev.gpu.name : S.gpu;
		} else if (ev.error) {
			V.error = ev.error;
			note(`${V.label}: error: ${ev.error}`);
			if (!cpu && ev.launchError) gpuFailed(n);
			save();
		}
	};
	ch.stdout.on('data', (chunk) => {
		out += chunk;
		let k;
		while ((k = out.indexOf('\n')) >= 0) {
			const line = out.slice(0, k).trim();
			out = out.slice(k + 1);
			if (!line.startsWith('{')) continue;
			let ev;
			try { ev = JSON.parse(line); } catch (e) { continue; }
			onEvent(ev);
		}
	});
	ch.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
	ch.on('error', (e) => { err += e.message; });
	ch.on('close', (code) => {
		busy.delete(ch);
		if (ch.haltTimer) clearTimeout(ch.haltTimer);
		if (!mine()) return;
		V.live = false;
		// eegpu's kernel launch failed (exit 6, 7 = the driver's watchdog) or it crashed: the GPU may have been reset.
		// No next pass, no salt rerun (V.error), and the other GPU searches stop too: the GPU gets no new work now
		if (!cpu && !ch.stopWhy && !V.error && (code === 6 || code === 7 || (Number.isFinite(code) && (code < 0 || code > 255)))) {
			V.error = `the GPU tool ${code === 7 ? 'was stopped by the display driver\'s watchdog' : code === 6 ? 'had a GPU launch failure' : `crashed (exit code ${code})`}` +
				`${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}`;
			note(`${V.label}: error: ${V.error}`);
		}
		if (!cpu && V.error && (code === 6 || code === 7 || (Number.isFinite(code) && (code < 0 || code > 255)))) gpuFailed(n);
		if (V.key === 'explore') {
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
			if (verdict && !why) V.tries = (V.tries || 0) + 1;
			const left = S.seconds - (Date.now() - S.started) / 1000;
			const next = how && how !== 'stopped' && !V.error ? nextPass(V.pass, how, V.ends, S.result ? S.result.ticks : 0, left) : null;
			if (next !== null && S.running && !S.halted && S.stage !== 'stopped' && left > 2) {
				const what = { full: 'the table is full', time: `no route in its ${V.share} s`, exhausted: 'every situation tried', finish: 'route found', depth: 'no faster route',
					beaten: 'a faster route is known' }[how];
				note(`${V.label}: ${what} at tick ${V.layer}${why}; again with ${next < V.pass ? 'coarser' : 'finer'} cells${S.result ? `, for a route under ${S.result.ticks} ticks` : ''}`);
				Object.assign(V, { pass: next, passes: V.passes + 1, layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: '' });
				kids[n] = launch(n);
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
				V.salt = Math.max(V.salt || 0, lastSalt) + 1;
				if (how === 'exhausted' && V.pass >= 0 && overflow === 0) yieldBeams(n);
				if (V.salt === 1 || V.salt % 10 === 0) {
					note(`${V.label}: ${how === 'exhausted' ? `every situation tried at tick ${V.layer}` : 'no faster route'}; again with other states standing for merged situations (try ${V.salt + 1})`);
				}
				Object.assign(V, { passes: V.passes + 1, layer: 0, states: 0, ticksPerSec: 0, state: 'starting', detail: '' });
				kids[n] = launch(n);
				save();
				return;
			}
		}
		if (V.state === 'running' || V.state === 'starting') {
			if (V.error || (code !== 0 && code !== null && !ch.killed)) {
				V.state = 'error';
				V.error = V.error || `exit code ${code}${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 300)}` : ''}`;
			} else V.state = V.found ? 'found' : S.stage === 'stopped' ? 'stopped' : 'ended';
		}
		totals();
		// every GPU strategy has ended with a route known (the exploration's finest passes found none faster): the CPU
		// search stops too; not when one of them failed (then the CPU search is the search, as without a GPU)
		if (!cpu && S.result && ![...busy].some((c) => !c.cpuSearch) && !S.strategies.some((q) => !q.cpu && q.state === 'error')) {
			S.strategies.forEach((q, k) => { if (q.cpu && alive(kids[k])) { if (!q.found) q.state = 'beaten'; halt(kids[k], 'finish'); } });
		}
		if (!running()) finish();
		else save();
	});
	ch.cpuSearch = cpu;
	return ch;
}
/**
 * "every move" (strategy n) tried every situation at a fine grain with nothing cut and found no route: the GPU beams (a
 * subset of those situations, exact) give way, so its tries with other salts get the whole GPU (a beam beside them made
 * them about 3x slower on the shaft level).
 */
function yieldBeams(n) {
	if (S.result) return;
	for (let k = 0; k < kids.length; k++) {
		const Q = S.strategies[k];
		// (a beam already told to stop is still alive until its process exits: noted once)
		if (k === n || !alive(kids[k]) || kids[k].stopWhy || (Q.key !== 'goal' && Q.key !== 'guide')) continue;
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
function finish() {
	S.running = false;
	S.elapsed = (Date.now() - S.started) / 1000;
	// (the exploration's deepest pass: a later, finer one can end sooner)
	S.layer = Math.max(...S.strategies.map((q) => Math.max(q.layer, q.deepest || 0)));
	S.tick = S.layer;
	if (S.result) S.stage = 'found';
	else if (S.stage === 'stopped') S.message = S.message || 'The search was stopped before it found a route.';
	else if (S.strategies.every((q) => q.state === 'error')) {
		S.stage = 'error';
		S.message = `The ${S.cpuOnly ? 'CPU' : 'GPU'} search failed: ${S.strategies.map((q) => q.error).filter(Boolean).join('; ')}`;
	} else if (S.stage !== 'error') {
		S.stage = 'not found';
		const capped = S.strategies.some((q) => q.key !== 'explore' && !q.cpu && q.layer >= S.depth);   // (the beams' depth limit)
		const XE = S.strategies.find((q) => q.key === 'explore' && q.exhausted);
		const X = S.strategies.find((q) => q.key === 'explore');
		const R = S.strategies.find((q) => q.cpu);
		const xd = X ? Math.max(X.layer, X.deepest || 0) : 0;
		const what = [];
		if (xd) what.push(`every move to tick ${xd.toLocaleString('en-US')}${X.passes > 1 ? ` in ${X.passes} passes` : ''}`);
		if (!S.cpuOnly) what.push(`the beams kept ${S.width.toLocaleString('en-US')} states per tick`);
		if (R && R.states) what.push(`random runs kept ${R.states.toLocaleString('en-US')} situations`);
		S.message = `No route to the trophy found in ${S.elapsed.toFixed(0)} s (${S.layer.toLocaleString('en-US')} ticks deep${what.length ? `; ${what.join('; ')}` : ''})` +
			(capped ? `: the search reached its depth limit of ${S.depth} ticks (${C.fmt(S.depth)} of play).` : '.') +
			(S.cpuOnly ? ' Try a longer search (without an NVIDIA GPU only the CPU searches).'
				: ` Try a longer search or more states per tick${S.guidePoints ? ', or another guide line' : ', or draw a guide line that shows the way'}.`);
		if (S.physics && S.physics.noWayUp) {
			// the reach field is optimistic (generous jumps, dots, arrows; sideways moves free), so this is a proof
			S.impossible = { by: 'physics' };
			S.message = 'No route: the trophy cannot be reached from the start. There is no way up to it: a jump rises about 4 tiles, a dot about 1, ' +
				'arrows and liquids by their height (the check is generous), and walls and spikes block the rest.';
		} else if (XE) {
			// merged situations are not a proof: one exact pixel can hide between them
			const tries = XE.tries > 1 ? ` in all ${XE.tries} tries (each with other states standing for merged situations)` : '';
			S.message = `No route found: "every move" ran out of new situations by tick ${XE.exhausted.tick.toLocaleString('en-US')}${tries} (positions and speeds told apart to ${XE.exhausted.grain}, ` +
				'and every gravity, jump and pickup state; the physics check ruled out the rest). That is evidence, not proof: a route that needs pixel-exact moves can hide between merged situations. A longer search tries more.';
		}
	}
	note(S.stage === 'found' ? `route ${S.result.time} (${S.result.ticks} ticks, ${S.result.strategy})` : S.message);
	cur = null;
	save();
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
	if (!V.found || ev.runTicks < V.found.runTicks) V.found = { ticks: ev.ms.length, runTicks: ev.runTicks, time: C.fmt(ev.runTicks) };
	const better = !S.result || ev.runTicks < S.result.runTicks || (ev.runTicks === S.result.runTicks && ev.ms.length < S.result.ticks);
	if (first || (V.cpu && better)) note(`${V.label}: ${first ? 'route' : 'a faster route'} ${C.fmt(ev.runTicks)} (${ev.ms.length} ticks)`);
	if (better) {
		const tr = C.replay(cur.level, ev.ms, { trace: true });
		const pathPts = [];
		for (let t = 0; t <= tr.n; t++) pathPts.push([Math.round((tr.X[t] + 8) * 10) / 10, Math.round((tr.Y[t] + 8) * 10) / 10]);
		C.writeEetas(path.join(dir(), 'route.eetas'), ev.ms);
		S.result = { ticks: ev.ms.length, completeTick: ev.complete, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), deaths: ev.deaths, coins: ev.coins,
			chance: ev.chance, inputs: C.eetasBytes(ev.ms).toString('latin1'), foundAfter: Math.round((Date.now() - S.started) / 100) / 10, path: pathPts,
			strategy: V.label, verified: 'replayed in the exact JS engine: it finishes' };
	}
	S.stage = 'found';
	// the other strategies: those already deeper than this route cannot find a faster one; the CPU search is told the
	// bound (it goes on looking for a faster route)
	S.strategies.forEach((q, k) => {
		if (k !== n && !q.cpu && alive(kids[k]) && q.layer >= S.result.ticks) { q.state = 'beaten'; halt(kids[k], 'beaten'); }
	});
	if (better) tellCpu(S.result.ticks);
	save();
}
/** a strategy's closest attempt (ev: {dist (tiles to the trophy), tick, inputs}): kept when it is the nearest so far
 *  (or as near and shorter), replayed in the JS engine for its path */
function closer(ev, n) {
	if (!cur) return;
	const dist = +ev.dist, old = S.closest;
	if (!Number.isFinite(dist) || dist >= 1e5 || (old && !(dist < old.dist - 1e-3 || (Math.abs(dist - old.dist) <= 1e-3 && ev.tick < old.ticks)))) return;
	const masks = Uint8Array.from(String(ev.inputs || ''), (c) => (c.charCodeAt(0) - 48) & 31);
	if (!masks.length) return;
	const tr = C.replay(cur.level, masks, { trace: true });
	const pathPts = [];
	for (let t = 0; t <= tr.n; t++) pathPts.push([Math.round((tr.X[t] + 8) * 10) / 10, Math.round((tr.Y[t] + 8) * 10) / 10]);
	try { C.writeEetas(path.join(dir(), 'closest.eetas'), masks); } catch (e) { /* read-only data folder */ }
	S.closest = { dist, tiles: Math.round(dist * 10) / 10, ticks: masks.length, runTicks: tr.runTicks, time: C.fmt(tr.runTicks), deaths: tr.deaths,
		inputs: C.eetasBytes(masks).toString('latin1'), path: pathPts, strategy: S.strategies[n].label, foundAfter: Math.round((Date.now() - S.started) / 100) / 10 };
	save();
}
/** stops the running search (a route found so far stays) */
function stop() {
	if (!running()) return state();
	S.halted = true;   // (no next pass either)
	S.stage = S.result ? 'found' : 'stopped';
	S.message = S.result ? '' : 'The search was stopped before it found a route.';
	S.strategies.forEach((q, k) => { if (alive(kids[k])) { q.state = 'stopped'; halt(kids[k], 'stopped'); } });
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
	if (S) S.halted = true;
	for (const ch of kids) halt(ch, 'stopped');
}

module.exports = { normalize, records, eelvlOf, levelOf, blockInfo, inspect, check, reachFrom, start, state, stop, found, solveFile, makeJob, shutdown,
	safeName, passCells, passGrain, nextPass, passSeconds, cpuWorkers, STRATEGIES, MAX_SIDE, MAX_CELLS, PASS_MIN, PASS_MAX, PASS_START };
