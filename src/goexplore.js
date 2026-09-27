'use strict';
// The CPU route search of the level editor's "Find a route" (src/editor.js, strategy "random runs (CPU)"): Go-Explore
// from the level start to the trophy in the exact JS engine, so it needs no GPU. On open levels it finds a first route
// after tens of thousands of simulated ticks (a fraction of a second); the GPU's "every move" passes then look for
// faster ones below its length (editor.js launch: --depth = route - 1).
//
// An archive keeps one cell per situation: the tile of the box centre, on the ground or not, the sign of vx, a class of
// vy (rising fast, rising, still, falling), the jump count, the gravity queue (the tiles of the last two ticks) and the
// discrete state (coins and which ones, keys, switches, effects, checkpoint, gates, portal draws). Each cell keeps the
// EARLIEST state that reached it (its inputs; a snapshot once it is picked, within a memory budget: --mem MB per
// worker). A heap picks the cell with the lowest
//   reach cost (src/reach.js: the physics-aware distance to the trophy) + --lambda x sqrt(times picked),
// so the optimism of a cell fades with use and a local minimum of the reach field is left by itself. From the picked
// cell, --rolls random runs of --roll ticks (each tick keeps the last input with probability --keep, else draws one of
// the 18); every state on the way that reaches a new cell, or a known one sooner, updates the archive. A state the reach
// field rules out (-1, a proof) ends its run. Where the search is stuck (the lowest reach cost has not improved for
// --stall picks, and the picked cell's pick count is a multiple of --refine) the 3 x 3 tiles around the picked cell get
// finer cells: position and speed to 4 px and 1/2 px/tick, then 1 px and 1/8, 1/4 px and 1/32, 1/16 px and 1/128
// (--maxres levels), so pixel-precise spots get precision and the rest of the level does not.
// A route (the trophy touched after T ticks) is replayed in the exact engine (common.js evaluate) before it is printed.
// From then on only routes of fewer ticks count (a cell at tick T - 1 or later is no longer picked), so the search keeps
// improving its earliest states and prints each faster route. Each worker thread runs its own archive with its own
// seed (--seed, --seed + 1, ...); the fastest route bounds them all. One worker is exactly reproducible: the same seed
// and tick budget (--maxTicks) give the same routes (with several workers, which one finds what first is a race).
//
// Two kinds of cells (--cells; auto: by the level's size):
//   fine    (levels of at most 50 x 50 = FINE_MAX_TILES tiles: the pixel-exact levels) everything above: the discrete
//           state's hash, the jump count and gravity queue in every cell, refinement, the one heap.
//   coarse  (bigger levels) the "Find a route" research's design B (a local prototype, ngx.js --mode=novold; the
//           research notes are not in the repository): on a 200 x 200 level the fine cells and their refinement filled
//           the archive (Infinity Pain: 2.36 M cells after 12 M ticks) and the one heap stayed in the reach field's traps
//           (the ice level: 739 tiles out, where the prototype found routes in 4 of 6 seeds, the first after 87 M ticks
//           on one thread). A cell is (tile, ROOM, on the ground, sign of vx, class of vy), plus the time-door phase in
//           --phase-tick buckets on levels with time doors (a ball waiting for a door makes new cells); no jump count, no
//           gravity queue, no refinement. The ROOM (roomOf) is the part of the discrete state that opens or shuts
//           doors or changes the physics (keys, switches, effects, team / coin counts / crowns / deaths where a door
//           reads them, time doors open or shut), not coin identities, checkpoints or timers. Three heads pick:
//             A (--pA of the picks when no discovery is due): the heap above, on the reach field's cost;
//             B (novelty, the rest): a room by a tournament of 4 (weight (1 + ln(1 + gain)) x (2 if the trophy is
//               walkable in the room) / sqrt(1 + picks / 50); gain = the tiles its door-aware flood fill reaches that no
//               earlier room's did), then the best of --sample random cells of it by 1 / sqrt(1 + seen) + 1 / sqrt(1 +
//               picks) (seen: how often a run came through the cell);
//             C (discovery, half the picks while one is due): --burst picks of each new room's first cell, only for
//               rooms that open new territory (gain > 0: on a level of many switches most rooms open nothing).
//           The room's fields (flood fill, trophy walkable) are cached by the passable set (the doors' states and
//           protection), the least recently used dropped beyond a budget: rooms that share doors cost a hash. A room is
//           made (its fields walked) only when its first cell enters the archive: a state in a new room while the
//           archive is full, or too late for a faster route, makes none (it would stay empty, outside the budget). The
//           room measure only orders: a state is ruled out only by the reach field's -1, as with fine cells.
//           It picks like the prototype except in two ways: the discovery burst goes only to rooms with territory gain
//           (the prototype bursts every new room, and a burst draws random numbers, so a room without gain changes the
//           draws after it), and crowns are keyed by _collide_crown, what crown doors read (the prototype: has_crown).
//           Where every new room opens territory and no crown door stands both give the same routes after the same
//           simulated ticks (test/editor.js pins the prototype's first route on a key-door level); on the ice level
//           they differ (seed 1's first route after 82.8 M ticks here, 87.2 M in the prototype).
//           The ice level: one worker, seed 1, its first route (9,982 ticks) after 82.8 M simulated ticks (23-26 s on
//           the i7-11800H laptop); 4 workers as the editor starts them (seed 1, depth 100000): the same route from the
//           same worker after the same 82.8 M ticks (a worker's draws do not depend on the others'), so the time is that
//           worker's speed: 32-36 s on the laptop otherwise idle, 50-56 s while other jobs' GPU work heats its shared
//           cooler; 9,661 ticks after 180 s.
//
// It prints the JSON lines of the editor's native tools (native/beamhost.h, explorehost.h), one per line:
//   {"ev":"start","workers":n,"seeds":[..],"mode":"physics"|"walk","cells":"fine"|"coarse","startCost":c|null,"maxCells":..}
//   {"ev":"progress","layer":L,"tick":L,"states":cells,"ticks":simulated,"ticksPerSec":..,"picks":..,"bestCost":..,
//     "found":T|0,"refined":tiles,"rooms":n,"workers":n}                   (every 0.5 s; L = the deepest cell's tick;
//                                                                            rooms: the most one worker has found)
//   {"ev":"closest","dist":reach cost,"tick":T,"inputs":".."}                    (the state nearest the trophy, when it
//                                                                                  improves, at most every 0.5 s)
//   {"ev":"source","kind":"room"|"best","room":key,"desc":"..","gain":tiles,"tick":T,"dist":reach cost,"inputs":"..",
//     "seed":s}            (coarse cells: starting points for the editor's relay. "room": a new room's first cell (each
//                          room with territory gain, the others at most one per SOURCE_S per worker); "best": every
//                          SOURCE_S s the lowest-cost cell of the 4 rooms with the most gain and the fewest sources so
//                          far, when it changed. A room key only once per kind unless its tick / cost improved.)
//   {"ev":"result","kind":"finish","ticks":T,"runTicks":..,"inputs":"..","seed":s,"simTicks":..,"sec":..}
//   {"ev":"done","layers":L,"seconds":..,"ticks":..,"ticksPerSec":..,"states":..,"picks":..,"end":"time"|"ticks"|
//     "exhausted"|"finish"|"stopped"|"unreachable","finish":T|0,"first":{ticks,sec,simTicks,seed}|null,
//     "workers":[{seed,..},..]}      ("unreachable": the reach field rules out the start itself, "exhausted": no cell is
//                                      early enough for a faster route)
// Inputs are .eetas characters ('0' + mask). With --stdin=1 it reads lines from stdin: "depth D" (from now on only
// routes of at most D ticks: a route of D + 1 is known elsewhere) and "stop"; the end of stdin (the editor is gone)
// stops it too. A last line "[goexplore] ..." sums up.
//
// Memory (--mem, MB per worker): fine cells 1600 / workers, 200 .. 800 (as before); coarse cells MEM_SHARE (a quarter)
// of the machine's memory (os.totalmem()) over the workers, 200 .. 1500 (the research's runs used 1.5 GB per worker:
// 15 workers on a 16-thread laptop with 32 GB get 542 MB each, 8 GB in all; 4 workers 1500 each). A cell without its
// snapshot costs about 260 bytes (300 with coarse cells: its room and counts), a snapshot about 1150; each gets 45% of
// the budget (Good Egg with --mem=300: the archive full at 472 K cells, 61 K snapshots, a 279 MB heap). The default
// depends only on the machine and the workers, so one worker with --maxTicks is reproducible on it (give --mem to
// reproduce a run on another machine).
//
// usage: node src/goexplore.js <level.eelvl | level.json> | --level=<level id | job id>  [--seconds=60] [--workers=1]
//        [--seed=1] [--depth=100000] [--maxTicks=0 (per worker; 0 = no limit)] [--first=0|1 (stop at the first route)]
//        [--out=<route.eetas>] [--stdin=0|1] [--lambda=2] [--roll=40] [--rolls=8] [--keep=0.85] [--stall=200]
//        [--refine=6] [--maxres=4 (fine cells)] [--cells=auto|fine|coarse] [--pA=0.5] [--burst=8] [--sample=16]
//        [--phase=50] [--mem=<MB per worker; see above>] [--maxCells=] [--maxSnaps=]
//        [--prune=1 (0: the reach field rules nothing out: the start is never "unreachable", a ruled-out state costs
//        1e4 + its walking distance; the editor's check of a level the field calls impossible)]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;
const EL = require('./eelvl.js');
const RF = require('./reach.js');

// the 18 inputs: nothing / left / right x nothing / up / down x jump or not (explore.js's order)
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
// the cell grain per refinement level: position x QP and speed x QV to whole numbers (level 0: the sign of vx and a
// class of vy only)
const QP = [0, 0.25, 1, 4, 16], QV = [0, 2, 8, 32, 128];
const MAXRES = QP.length - 1;
const DEFAULTS = { seconds: 60, workers: 1, seed: 1, depth: 100000, maxTicks: 0, first: 0, stdin: 0, lambda: 2, roll: 40, rolls: 8, keep: 0.85,
	stall: 200, refine: 6, maxres: MAXRES, mem: 0, maxCells: 0, maxSnaps: 0, prune: 1, pA: 0.5, burst: 8, sample: 16, phase: 50 };
const CHUNK = 16;   // picks between two looks at the clock, the shared bound and the stop flag
// memory (V8 heap, measured): a cell without its snapshot about 260 bytes (coarse cells: 300, with their room and
// counts), a snapshot about 1150; each gets 45% of a worker's --mem
const CELL_BYTES = 260, CELL_BYTES_COARSE = 300, SNAP_BYTES = 1150;
// the biggest level (tiles) that gets fine cells by default (--cells=auto): 50 x 50, the size of the pixel-exact levels
// the editor's suite checks (sfox50, user30s, user50, the dot ring; shaft, staircase, dotstairs 40 x 25, ...)
const FINE_MAX_TILES = 2500;
// coarse cells' default budget: this share of the machine's memory over the workers, MEM_MIN .. MEM_MAX MB each
const MEM_SHARE = 0.25, MEM_MIN = 200, MEM_MAX = 1500;
// coarse cells: every SOURCE_S s the "best" source events; SOURCE_MIN_TICKS: shorter attempts are no source (the
// editor's relay starts from 100 ticks)
const SOURCE_S = 5, SOURCE_MIN_TICKS = 100;

function parseArgs(argv) {
	const a = Object.assign({}, DEFAULTS, { file: '', level: '', out: '', cells: 'auto' });
	for (const s of argv) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) {
			if (s.startsWith('--')) throw new Error(`bad option ${s} (use --name=value)`);
			a.file = s;
			continue;
		}
		if (m[1] === 'level' || m[1] === 'out') a[m[1]] = m[2];
		else if (m[1] === 'cells') {
			if (!['auto', 'fine', 'coarse'].includes(m[2])) throw new Error(`bad --cells=${m[2]} (auto, fine or coarse)`);
			a.cells = m[2];
		} else if (m[1] in DEFAULTS) {
			a[m[1]] = +m[2];
			if (!Number.isFinite(a[m[1]])) throw new Error(`bad --${m[1]}=${m[2]} (a number)`);
		} else throw new Error(`unknown option --${m[1]} (see the header of src/goexplore.js)`);
	}
	if (!a.file && !a.level) throw new Error('usage: node src/goexplore.js <level.eelvl | level.json> [--seconds=60] [--workers=1] [--seed=1] (see the header)');
	a.workers = Math.max(1, Math.min(64, Math.round(a.workers)));
	a.roll = Math.max(1, Math.round(a.roll));
	a.rolls = Math.max(1, Math.round(a.rolls));
	a.depth = Math.max(1, Math.round(a.depth));
	a.maxres = Math.max(0, Math.min(MAXRES, Math.round(a.maxres)));
	a.refine = Math.max(1, Math.round(a.refine));
	a.burst = Math.max(0, Math.round(a.burst));
	a.sample = Math.max(1, Math.round(a.sample));
	a.phase = Math.max(1, Math.round(a.phase));
	return a;
}
/** the cells for level L: 'fine' up to FINE_MAX_TILES tiles, else 'coarse' */
const cellsFor = (L) => (L.width * L.height > FINE_MAX_TILES ? 'coarse' : 'fine');
/** coarse cells' default memory per worker (MB): MEM_SHARE of the machine's memory over the workers, MEM_MIN .. MEM_MAX */
const coarseMem = (workers, totalBytes) => Math.max(MEM_MIN, Math.min(MEM_MAX, Math.round((totalBytes || os.totalmem()) / 1048576 * MEM_SHARE / Math.max(1, workers))));
/** the options that depend on the level: the cells (--cells=auto), and then the memory budget (see the header) */
function settle(a, L) {
	if (a.cells === 'auto') a.cells = cellsFor(L);
	const coarse = a.cells === 'coarse';
	if (coarse) a.maxres = 0;   // (no refinement with coarse cells)
	if (!a.mem) a.mem = coarse ? coarseMem(a.workers) : Math.max(200, Math.min(800, Math.round(1600 / a.workers)));
	if (!a.maxCells) a.maxCells = Math.round(a.mem * 1048576 * 0.45 / (coarse ? CELL_BYTES_COARSE : CELL_BYTES));
	if (!a.maxSnaps) a.maxSnaps = Math.round(a.mem * 1048576 * 0.45 / SNAP_BYTES);
	a.maxSnaps = Math.max(64, a.maxSnaps);
	return a;
}

/** the prepared level: an .eelvl (read like the editor does), a level JSON, or --level=<level id | job id> */
function levelOf(a) {
	if (a.file && /\.eelvl$/i.test(a.file)) return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(a.file)), { id: 'goexplore', file: path.basename(a.file) }));
	if (a.file) return E.loadLevel(a.file);
	return C.loadLevel(a.level);
}

/** mulberry32 -> [0, 1) */
function rngOf(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return h ^ (h >>> 16); };

/** the discrete state's hash (what a cell tells apart besides the ball's motion): coins (and which ones), keys,
 *  switches, crowns, effects, checkpoint, team, the time-door phase, gates, death count (death doors), portal draws */
function discreteOf(L) {
	const coinW = L.coinTiles.length ? L.coinWords : 0, secretW = L.secretTiles.length ? L.secretWords : 0;
	const onSum = (m, salt) => { let s = 0; for (const [id, v] of m) if (v === true) s = (s + fmix((id ^ salt) | 0)) | 0; return s; };
	return (sim) => {
		let h = 0x3c6ef372;
		const w = (v) => { h = Math.imul(h ^ v, 0x5bd1e995); h ^= h >>> 13; };
		w(sim.coins); w(sim.blue_coins); w(sim._keysMask);
		w((sim.has_crown ? 1 : 0) | (sim.low_gravity ? 2 : 0) | (sim.is_invulnerable ? 4 : 0) | (sim.in_god_mode ? 8 : 0) | (sim.is_cursed ? 16 : 0) |
			(sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | (sim.has_levitation ? 256 : 0) |
			(L.hasTimeDoors && sim._timedoor_state ? 512 : 0));
		w(sim.max_jumps); w(sim.jump_boost); w(sim.speed_boost); w(sim.flip_gravity); w(sim.team);
		w((sim.checkpoint.x + 1) | ((sim.checkpoint.y + 1) << 16));
		if (L.hasDeathDoor) w(sim.deaths);
		if (L.hasCoinGate) w(sim._show_coin_gate);
		if (L.hasBlueCoinGate) w(sim._show_blue_coin_gate);
		if (L.hasDeathGate) w(sim._show_death_gate);
		if (L.multiTargetPortals) w(sim._rngSteps);
		for (let k = 0; k < coinW; k++) w(sim._coinBits[k]);
		for (let k = 0; k < secretW; k++) w(sim._secretBits[k]);
		if (sim._switches.size !== 0) w(onSum(sim._switches, 0x1234567));
		if (sim._oswitches.size !== 0) w(onSum(sim._oswitches, 0x7654321));
		return h | 0;
	};
}

// ---------------------------------------------------------------- rooms (coarse cells)
/**
 * roomOf(L) -> {key(sim) (int32), desc(sim) (text)}: the room, the part of the discrete state that opens or shuts doors
 * or changes the physics: the keys active, the effects (protection, curse, zombie, fire, poison, levitation, low
 * gravity; the multijump, jump, speed and gravity values), the purple and orange switches on, whether the time doors are
 * open, and only where a door reads them: the team (team doors 1027 / 1028), the coin and blue-coin counts (coin doors
 * and gates 43 / 165, 213 / 214; a gate's shown count too), the crowns (crown doors 1094 / 1095, 1152 / 1153: what the
 * doors read, _collide_crown and _collide_silver_crown), the deaths (death doors and gates). Coin identities, secrets,
 * the checkpoint, key timers and portal draws are left out (they would split every room into thousands; merged cells
 * cost completeness only: every route is replayed).
 */
function roomOf(L) {
	let team = false, coins = false, blue = false, crown = false, silver = false;
	for (let i = 0; i < L.width * L.height; i++) {
		const id = L.fg[i];
		if (id === 1027 || id === 1028) team = true;
		else if (id === 43 || id === 165) coins = true;
		else if (id === 213 || id === 214) blue = true;
		else if (id === 1094 || id === 1095) crown = true;
		else if (id === 1152 || id === 1153) silver = true;
	}
	const onSum = (m, salt) => { let s = 0; for (const [id, v] of m) if (v === true) s = (s + fmix((id ^ salt) | 0)) | 0; return s; };
	const onList = (m) => { const a = []; for (const [id, v] of m) if (v === true) a.push(id); return a.sort((x, y) => x - y); };
	const key = (sim) => {
		let h = 0x3c6ef372;
		const w = (v) => { h = Math.imul(h ^ v, 0x5bd1e995); h ^= h >>> 13; };
		w(sim._keysMask);
		w((crown && sim._collide_crown ? 1 : 0) | (sim.low_gravity ? 2 : 0) | (sim.is_invulnerable ? 4 : 0) | (silver && sim._collide_silver_crown ? 8 : 0) |
			(sim.is_cursed ? 16 : 0) | (sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | (sim.has_levitation ? 256 : 0) |
			(L.hasTimeDoors && sim._timedoor_state ? 512 : 0));
		w(sim.max_jumps); w(sim.jump_boost); w(sim.speed_boost); w(sim.flip_gravity);
		if (team) w(sim.team);
		if (coins) w(sim.coins);
		if (L.hasCoinGate) w(sim._show_coin_gate);
		if (blue) w(sim.blue_coins);
		if (L.hasBlueCoinGate) w(sim._show_blue_coin_gate);
		if (L.hasDeathDoor) w(sim.deaths);
		if (L.hasDeathGate) w(sim._show_death_gate);
		if (sim._switches.size !== 0) w(onSum(sim._switches, 0x1234567));
		if (sim._oswitches.size !== 0) w(onSum(sim._oswitches, 0x7654321));
		return h | 0;
	};
	const COL = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];
	const desc = (sim) => {
		const p = [];
		for (let c = 0; c < 6; c++) if (sim._keysMask & (1 << c)) p.push(`key:${COL[c]}`);
		if (sim.is_invulnerable) p.push('protection');
		if (sim.is_cursed) p.push('curse');
		if (sim.is_zombie) p.push('zombie');
		if (sim.is_on_fire) p.push('fire');
		if (sim.is_poisoned) p.push('poison');
		if (sim.has_levitation) p.push('fly');
		if (sim.low_gravity) p.push('lowgrav');
		if (sim.max_jumps !== 1) p.push(`jumps=${sim.max_jumps}`);
		if (sim.jump_boost) p.push(`jump=${sim.jump_boost}`);
		if (sim.speed_boost) p.push(`speed=${sim.speed_boost}`);
		if (sim.flip_gravity) p.push(`grav=${sim.flip_gravity}`);
		if (L.hasTimeDoors) p.push(sim._timedoor_state ? 'timedoors:open' : 'timedoors:shut');
		if (team && sim.team) p.push(`team=${sim.team}`);
		if (coins) p.push(`coins=${sim.coins}`);
		if (blue) p.push(`bluecoins=${sim.blue_coins}`);
		if (L.hasDeathDoor) p.push(`deaths=${sim.deaths}`);
		const s = onList(sim._switches), o = onList(sim._oswitches);
		if (s.length) p.push(`purple=[${s.join(',')}]`);
		if (o.length) p.push(`orange=[${o.join(',')}]`);
		if (crown && sim._collide_crown) p.push('crown');
		if (silver && sim._collide_silver_crown) p.push('silvercrown');
		return p.join(' ') || '(start)';
	};
	return { key, desc };
}

/**
 * roomFields(L, budget) -> {enter(sim) -> {gain, troOk, cached}, stats()}: a room's fields, from the state that entered
 * it (its tile): the tiles the ball can walk to (8-way, portals, doors as they are now, spikes and other killing tiles
 * only with protection; one-ways and half blocks open, as src/reach.js), `troOk` whether a trophy is among them, and
 * `gain` how many no earlier room's walk reached (the territory the room opens). A walk depends only on the passable set
 * (the doors' states and protection) and the tile it starts from, so walks are cached by a hash of the passable set: a
 * room whose passable set and start component are known costs that hash and has no gain. Cached walks (a bitset each)
 * beyond `budget` bytes go, the least recently used first. One per worker (its own union).
 */
function roomFields(L, budget) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
	const wall = new Uint8Array(N), deadly = new Uint8Array(N), doors = [], trophies = [];
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) !== 0) doors.push(i);
		else if ((f & F_SOLID) !== 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0) wall[i] = 1;
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
		if (id === 121) trophies.push(i);
	}
	// portals: tile -> its exits' tiles
	const exits = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			const list = [];
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && !list.includes(j)) list.push(j); }
			if (list.length) exits.set(i, list);
		}
	}
	const union = new Uint8Array(N), shut = new Uint8Array(N), seen = new Int32Array(N), q = new Int32Array(N);
	const words = new Int32Array(((doors.length + 31) >> 5) + 1);
	const cache = new Map();   // passable-set hash -> [{bits, troOk, used}]
	let gen = 0, clock = 0, bytes = 0, walks = 0, hits = 0, ms = 0;
	const evict = () => {
		// (the least recently used walk; rare: a walk is added only for a new passable set or component)
		let bk = 0, bi = -1, bu = Infinity;
		for (const [k, list] of cache) for (let i = 0; i < list.length; i++) if (list[i].used < bu) { bu = list[i].used; bk = k; bi = i; }
		if (bi < 0) return false;
		const list = cache.get(bk);
		bytes -= list[bi].bits.length;
		list.splice(bi, 1);
		if (!list.length) cache.delete(bk);
		return true;
	};
	const enter = (sim) => {
		const t0 = Date.now();
		const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		const prot = !!sim.is_invulnerable;
		// the passable set's hash: protection and each door shut or open
		words.fill(0);
		words[words.length - 1] = prot ? 1 : 0;
		for (let k = 0; k < doors.length; k++) if (sim.is_tile_solid_now(doors[k] % W, (doors[k] / W) | 0)) words[k >> 5] |= 1 << (k & 31);
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < words.length; k++) {
			let x = Math.imul(words[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ words[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		const hk = (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
		const list = cache.get(hk);
		if (list) {
			for (const c of list) {
				if ((c.bits[tile >> 3] & (1 << (tile & 7))) === 0) continue;
				c.used = ++clock; hits++;
				ms += Date.now() - t0;
				return { gain: 0, troOk: c.troOk, cached: true };
			}
		}
		// the walk (8-way, no corner cut between two walls, through portals) from the room's tile
		for (let k = 0; k < doors.length; k++) if (words[k >> 5] & (1 << (k & 31))) shut[doors[k]] = 1;
		const pass = (i) => !wall[i] && !shut[i] && (prot || !deadly[i]);
		const g = ++gen;
		const bits = new Uint8Array((N + 7) >> 3);
		let qh = 0, qt = 0, gain = 0, troOk = false;
		seen[tile] = g; q[qt++] = tile;
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			bits[t >> 3] |= 1 << (t & 7);
			if (!union[t]) { union[t] = 1; gain++; }
			if (fg[t] === 121) troOk = true;
			const ex = exits.get(t);
			if (ex) for (const e of ex) if (seen[e] !== g && pass(e)) { seen[e] = g; q[qt++] = e; }
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const j = yy * W + xx;
					if (seen[j] === g || !pass(j)) continue;
					if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
					seen[j] = g; q[qt++] = j;
				}
			}
		}
		for (let k = 0; k < doors.length; k++) shut[doors[k]] = 0;
		walks++;
		const c = { bits, troOk, used: ++clock };
		if (list) list.push(c); else cache.set(hk, [c]);
		bytes += bits.length;
		while (bytes > budget && evict()) { /* the least recently used first */ }
		ms += Date.now() - t0;
		return { gain, troOk, cached: false };
	};
	return { enter, trophies: trophies.length, stats: () => ({ walks, hits, walkMs: ms, walkBytes: bytes }) };
}

/** the inputs of a path node {up, buf, o, n} (those of `up`, then buf[o .. o + n); immutable: a cell that improves gets
 *  a new node) as masks */
function inputsOf(node) {
	const parts = [];
	let len = 0;
	for (let q = node; q !== null; q = q.up) { parts.push(q); len += q.n; }
	const out = new Uint8Array(len);
	let o = 0;
	for (let k = parts.length - 1; k >= 0; k--) { const q = parts[k]; out.set(q.buf.subarray(q.o, q.o + q.n), o); o += q.n; }
	return out;
}

/**
 * One explorer (a worker thread; a = the options, settled for the level, seed its seed). ctrl (Int32Array on a
 * SharedArrayBuffer): [0] the longest route that still counts (ticks), [1] stop. post(msg): to the main thread
 * ('finish', 'closest', 'source', 'stat', 'done').
 */
function explore(L, field, a, seed, ctrl, post) {
	const W = L.width, H = L.height, N = W * H;
	const rnd = rngOf(seed);
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	const coarse = a.cells === 'coarse';
	const disc = coarse ? null : discreteOf(L);
	const res = new Uint8Array(N);   // the cell grain per tile (0 .. maxres)
	const t0 = Date.now(), tEnd = t0 + a.seconds * 1000;
	let maxT = Math.min(a.depth, Atomics.load(ctrl, 0));
	// coarse cells: the rooms (roomOf), each with its fields (roomFields: territory gain, trophy walkable), its cells
	// (head B samples them), its picks, its lowest-cost cell and how often it was a source; roomKey = the live state's
	const RM = coarse ? roomOf(L) : null;
	const fields = coarse ? roomFields(L, Math.max(1 << 20, Math.min(64 << 20, a.mem * 1048576 * 0.03))) : null;
	const rooms = new Map(), roomList = [];
	let roomKey = 0, bursts = 0;
	const newRoom = (key, t) => {
		const f = fields.enter(sim);
		const r = { key, desc: RM.desc(sim), t, gain: f.gain, troOk: f.troOk, picks: 0, arr: [], best: null, isNew: true, sent: 0, sentAt: null };
		rooms.set(key, r);
		roomList.push(r);
		return r;
	};
	const TD = coarse && !!L.hasTimeDoors;
	// the cell key: two 32-bit hash lanes over the cell's numbers (53 bits; two cells collide with probability ~2^-53 per
	// pair, and a collision only merges two cells of this archive: every route is replayed exactly anyway)
	const KV = new Int32Array(10);
	let tile = 0;
	const cellKey = () => {
		const px = sim.px, py = sim.py;
		const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
		tile = Math.min(N - 1, Math.max(0, ty * W + tx));
		const r = res[tile];
		if (coarse) {
			// (tile, room, ground, the time-door phase in buckets of --phase ticks; no jump count or gravity queue)
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (TD ? (((sim.level_ticks() % E.TIMEDOOR_PERIOD) / a.phase) | 0) << 8 : 0); KV[2] = 0; KV[3] = 0; KV[4] = 0; KV[5] = roomKey;
		} else {
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (r << 1); KV[2] = sim.jump_count; KV[3] = sim._q0; KV[4] = sim._q1; KV[5] = disc(sim);
		}
		let n;
		if (r === 0) {
			const vy = sim.speed_y;
			KV[6] = Math.sign(sim.speed_x); KV[7] = vy < -3 ? 0 : vy < 0 ? 1 : vy === 0 ? 2 : 3;
			n = 8;
		} else {
			const qp = QP[r], qv = QV[r];
			KV[6] = Math.floor(px * qp); KV[7] = Math.floor(py * qp); KV[8] = Math.floor(sim.speed_x * qv); KV[9] = Math.floor(sim.speed_y * qv);
			n = 10;
		}
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < n; k++) {
			let x = Math.imul(KV[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ KV[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		return (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
	};
	// the archive and the heap of (priority, cell, version): a cell has one live entry (its version); others are stale
	const cells = new Map();
	const hv = [], hc = [], hver = [];
	const prio = (c) => c.rc + a.lambda * Math.sqrt(c.picks);
	const hpush = (c) => {
		let i = hv.length;
		const v = prio(c);
		hv.push(v); hc.push(c); hver.push(c.ver);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (hv[p] <= v) break;
			hv[i] = hv[p]; hc[i] = hc[p]; hver[i] = hver[p];
			i = p;
		}
		hv[i] = v; hc[i] = c; hver[i] = c.ver;
	};
	let popVer = 0;
	const hpop = () => {
		const c = hc[0];
		popVer = hver[0];
		const v = hv.pop(), lc = hc.pop(), lver = hver.pop();
		const n = hv.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === i) break;
				hv[i] = hv[m]; hc[i] = hc[m]; hver[i] = hver[m];
				i = m;
			}
			hv[i] = v; hc[i] = lc; hver[i] = lver;
		}
		return c;
	};
	/** the heap without its stale entries (when they are most of it) */
	const compact = () => {
		let n = 0;
		for (let i = 0; i < hv.length; i++) if (hver[i] === hc[i].ver) { hv[n] = hv[i]; hc[n] = hc[i]; hver[n] = hver[i]; n++; }
		hv.length = n; hc.length = n; hver.length = n;
		for (let i = (n >> 1) - 1; i >= 0; i--) {
			const v = hv[i], c = hc[i], ver = hver[i];
			let j = i;
			for (;;) {
				const l = 2 * j + 1, r = l + 1;
				let m = j, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === j) break;
				hv[j] = hv[m]; hc[j] = hc[m]; hver[j] = hver[m];
				j = m;
			}
			hv[j] = v; hc[j] = c; hver[j] = ver;
		}
	};
	// Snapshots (about 1150 bytes each) only for picked cells, at most --maxSnaps of them. A cell that was not picked yet
	// (most never are) is its parent cell (the one whose runs reached it; `gen` counts the parent's state changes) plus
	// the inputs of its run so far (node.buf[node.o ..+ node.n)): its first pick replays those from the parent's snapshot,
	// or, when that is gone (the budget) or the parent's state changed, its whole path from the start. The budget drops
	// the snapshot picked least recently (a second chance for one picked since it last came up). Exact either way: the
	// same inputs from the same state give the same state.
	const startSnap = sim.snapshot();
	let nSnaps = 0, replays = 0, dropped = 0, qh = 0;
	let queue = [];
	/** cell c keeps snapshot s (c has none now). Room is made first, so the new one is never the one dropped: c's runs
	 *  start from it right after (c's older entries in the queue see no snapshot while the budget is enforced). */
	const keepSnap = (c, s) => {
		while (nSnaps >= a.maxSnaps && qh < queue.length) {
			const d = queue[qh++];
			if (d.snap === null) continue;
			if (d.used) { d.used = false; queue.push(d); continue; }
			d.snap = null; nSnaps--; dropped++;
		}
		c.snap = s; c.used = true; nSnaps++;
		queue.push(c);
		if (qh > 65536 && qh * 2 > queue.length) { queue = queue.slice(qh); qh = 0; }
	};
	let deepest = 0, full = false;
	/** the live state (tick t, reach cost rc; reached from cell pc's state by the inputs of node; coarse cells: in room)
	 *  into the archive; returns the cell when it is new */
	const add = (t, rc, pc, up, buf, o, n, room) => {
		if (t >= maxT) return null;   // (a route from there would not be faster)
		const k = cellKey();
		const c = cells.get(k);
		if (c !== undefined) {
			c.seen++;
			if (c.t <= t) return null;
			if (c.snap !== null) { c.snap = null; nSnaps--; }
			c.t = t; c.pc = pc; c.pgen = pc.gen; c.node = { up, buf, o, n }; c.rc = rc; c.gen++; c.ver++;
			hpush(c);
			if (room !== null && (room.best === null || rc < room.best.rc)) room.best = c;
			return null;
		}
		if (cells.size >= a.maxCells) { full = true; return null; }
		const nc = { t, snap: null, pc, pgen: pc.gen, node: { up, buf, o, n }, rc, picks: 0, seen: 1, tile, room, ver: 0, gen: 0, used: false };
		cells.set(k, nc);
		hpush(nc);
		if (t > deepest) deepest = t;
		if (room !== null) {
			room.arr.push(nc);
			if (room.best === null || rc < room.best.rc) room.best = nc;
		}
		return nc;
	};
	let end = '';
	/** the reach cost of the live state (tiles); -1 = ruled out. With --prune=0 (the editor's check of a level the reach
	 *  field rules out) nothing is ruled out: a ruled-out state costs 1e4 + its walking distance (behind the others) */
	const costOf = () => {
		const rc = RF.costAt(field, sim);
		if (rc >= 0 || a.prune) return rc;
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		const w = tx >= 0 && ty >= 0 && tx < field.W && ty < field.H ? field.walk[ty * field.W + tx] : RF.CUT;
		return 1e4 + (w === RF.CUT ? 9999 : w / 5);
	};
	let room0 = null;
	{
		// the start (the reach field rules it out: no route, a proof; the search ends at once, unless --prune=0)
		const rc = costOf();
		if (coarse) { roomKey = RM.key(sim); room0 = newRoom(roomKey, 0); room0.isNew = false; }
		const k = cellKey();
		const c = { t: 0, snap: null, pc: null, pgen: 0, node: null, rc, picks: 0, seen: 1, tile, room: room0, ver: 0, gen: 0, used: false };
		cells.set(k, c);
		hpush(c);
		if (room0 !== null) { room0.arr.push(c); room0.best = c; }
		keepSnap(c, startSnap);
		if (rc < 0) end = 'unreachable';
	}
	let ticks = 0, picks = 0, lastProgress = 0, refined = 0, minRc = Infinity;
	let first = null, best = null;   // routes: {t, sec, simTicks}
	let near = null, nearSent = null, lastSent = 0, lastStat = 0;   // the closest state: {rc, t, node}
	const stat = () => Object.assign({ type: 'stat', seed, ticks, cells: cells.size, picks, deepest, minRc: Number.isFinite(minRc) ? minRc : null, refined, full,
		snaps: nSnaps, dropped, replays }, coarse ? Object.assign({ rooms: roomList.length, bursts }, fields.stats()) : {});
	const sendNear = () => {
		if (!near || near === nearSent) return;
		nearSent = near;
		post({ type: 'closest', seed, rc: near.rc, t: near.t, inputs: C.eetasBytes(inputsOf(near.node)).toString('latin1') });
	};
	// sources (coarse cells): starting points for the editor's relay (see the header). A room without territory gain is a
	// "room" source at most once per SOURCE_S (on a level of many switches most rooms open nothing)
	let lastBlandSource = -1e9, lastSources = t0;
	const source = (kind, r, c) => {
		r.sent++; r.sentAt = c;
		post({ type: 'source', seed, kind, room: r.key, desc: r.desc, gain: r.gain, t: c.t, rc: c.rc, inputs: C.eetasBytes(inputsOf(c.node)).toString('latin1') });
	};
	/** every SOURCE_S s: the lowest-cost cell of the 4 rooms with the most territory gain and the fewest sources so far
	 *  (by (1 + ln(1 + gain)) / (1 + sources)), when it is not the one already sent */
	const bestSources = () => {
		const cand = [];
		for (const r of roomList) if (r.best !== null && r.best.node !== null && r.best.t >= SOURCE_MIN_TICKS && r.best !== r.sentAt) cand.push(r);
		cand.sort((x, y) => (1 + Math.log(1 + y.gain)) / (1 + y.sent) - (1 + Math.log(1 + x.gain)) / (1 + x.sent) || x.t - y.t);
		for (let k = 0; k < 4 && k < cand.length; k++) source('best', cand[k], cand[k].best);
	};
	// the picks: head A, the lowest priority whose entry is live and whose state is early enough
	const popA = () => {
		while (hv.length) {
			const c = hpop();
			if (popVer !== c.ver || c.t >= maxT) continue;
			return c;
		}
		return null;
	};
	// head B (novelty; coarse cells): a room by a tournament of 4 (territory gain, the trophy walkable, few picks), then
	// the best of --sample random cells of it by Go-Explore's count weights (cells runs rarely come through first)
	const popB = () => {
		let br = null, bw = -1;
		for (let k = 0; k < 4; k++) {
			const r = roomList[(rnd() * roomList.length) | 0];
			if (!r.arr.length) continue;
			const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50);
			if (w > bw) { bw = w; br = r; }
		}
		if (br === null) return popA();
		const arr = br.arr;
		let bc = null, bs = -1;
		for (let k = 0; k < a.sample; k++) {
			const c = arr[(rnd() * arr.length) | 0];
			if (c.t >= maxT) continue;
			const sc = 1 / Math.sqrt(1 + c.seen) + 1 / Math.sqrt(1 + c.picks);
			if (sc > bs) { bs = sc; bc = c; }
		}
		return bc || popA();
	};
	const discovery = [];   // head C (coarse cells): [cell, picks left], the newest room's last
	while (!end) {
		// between chunks: the clock, the stop flag, the shared bound (a faster route from another worker or the editor)
		const now = Date.now();
		if (Atomics.load(ctrl, 1) !== 0) { end = 'stopped'; break; }
		if (now >= tEnd) { end = 'time'; break; }
		maxT = Math.min(maxT, Atomics.load(ctrl, 0));
		if (now - lastStat >= 250) { lastStat = now; post(stat()); }
		if (now - lastSent >= 250) { lastSent = now; sendNear(); }
		if (coarse && now - lastSources >= SOURCE_S * 1000) { lastSources = now; bestSources(); }
		for (let k = 0; k < CHUNK && !end; k++) {
			let e = null;
			if (!coarse) e = popA();
			else if (discovery.length && rnd() < 0.5) {
				// head C: a new room's first cell, --burst times
				const d = discovery[discovery.length - 1];
				e = d[0];
				if (--d[1] <= 0) discovery.pop();
				if (e.t >= maxT) continue;
			} else if (rnd() < a.pA) e = popA();
			else e = popB();
			if (e === null) { end = 'exhausted'; break; }
			e.picks++; e.ver++; picks++;
			if (coarse) e.room.picks++;
			hpush(e);
			if (e.snap === null) {
				// its state: its run's inputs from its parent's snapshot, else its whole path from the start
				const q = e.node, p = e.pc;
				if (p !== null && p.snap !== null && p.gen === e.pgen) {
					sim.restore(p.snap);
					for (let s = 0; s < q.n; s++) { E.applyMask(inp, q.buf[q.o + s]); sim.tick(inp); }
					ticks += q.n;
				} else {
					const ms = inputsOf(q);
					sim.restore(startSnap);
					for (let s = 0; s < ms.length; s++) { E.applyMask(inp, ms[s]); sim.tick(inp); }
					ticks += ms.length;
					replays++;
				}
				keepSnap(e, sim.snapshot());
				e.pc = null;
			}
			e.used = true;
			if (hv.length > 3 * cells.size + 4096) compact();
			// stuck: finer cells around here
			if (picks - lastProgress > a.stall && e.picks % a.refine === 0) {
				lastProgress = picks;
				const tx = e.tile % W, ty = (e.tile / W) | 0, r0 = res[e.tile];
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const x = tx + dx, y = ty + dy;
						if (x < 0 || y < 0 || x >= W || y >= H) continue;
						const j = y * W + x;
						if (res[j] < a.maxres && res[j] <= r0) { res[j]++; refined++; }
					}
				}
			}
			// the pick's runs: one input buffer for all of them (run r at r x roll)
			const buf = new Uint8Array(a.rolls * a.roll), base = e.snap, up = e.node;
			for (let r = 0; r < a.rolls; r++) {
				sim.restore(base);
				const o = r * a.roll;
				let m = OPTIONS[(rnd() * 18) | 0];
				let room = e.room;
				for (let s = 0; s < a.roll; s++) {
					const t = e.t + s + 1;
					if (t > maxT) break;
					if (rnd() >= a.keep) m = OPTIONS[(rnd() * 18) | 0];
					buf[o + s] = m;
					E.applyMask(inp, m);
					sim.tick(inp);
					ticks++;
					if (sim.has_silver_crown) {
						// a route of t ticks: from now on only faster ones
						maxT = t - 1;
						const sec = (Date.now() - t0) / 1000;
						const f = { t, sec, simTicks: ticks };
						if (!first) first = f;
						best = f;
						post({ type: 'finish', seed, t, sec, simTicks: ticks, inputs: C.eetasBytes(inputsOf({ up, buf, o, n: s + 1 })).toString('latin1') });
						if (a.first) end = 'finish';
						break;
					}
					if (sim.is_dead) break;
					const rc = costOf();
					if (rc < 0) break;   // the reach field rules it out: no route from here
					// (coarse cells: the live state's room; a new one is made (its fields walked from this state) only when its
					// first cell can enter the archive: a full archive or a state too late for a faster route would leave an
					// empty room, and walks for nothing, outside the memory budget)
					let into = true;
					if (coarse) {
						roomKey = RM.key(sim);
						if (roomKey !== room.key) {
							const r = rooms.get(roomKey);
							if (r !== undefined) room = r;
							else if (t < maxT && cells.size < a.maxCells) room = newRoom(roomKey, t);
							else { into = false; if (t < maxT) full = true; }
						}
					}
					if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
					if (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) near = { rc, t, node: { up, buf, o, n: s + 1 } };
					const nc = into ? add(t, rc, e, up, buf, o, s + 1, room) : null;
					if (nc !== null && room !== null && room.isNew) {
						// a new room's first cell: head C's burst and a source, if it opens new territory
						room.isNew = false;
						if (room.gain > 0) { if (a.burst > 0) { discovery.push([nc, a.burst]); bursts++; } }
						if ((room.gain > 0 || Date.now() - lastBlandSource >= SOURCE_S * 1000) && t >= SOURCE_MIN_TICKS) {
							if (room.gain <= 0) lastBlandSource = Date.now();
							source('room', room, nc);
						}
					}
				}
				if (end) break;
			}
			if (a.maxTicks && ticks >= a.maxTicks && !end) end = 'ticks';
		}
	}
	sendNear();
	E.flushTicks();
	post(Object.assign(stat(), { type: 'done', end, first, best, sec: (Date.now() - t0) / 1000, heapMB: Math.round(require('v8').getHeapStatistics().used_heap_size / 1048576) }));
}

function workerMain() {
	const d = workerData;
	const L = levelOf(d.a);
	explore(L, d.field, d.a, d.seed, d.ctrl, (m) => parentPort.postMessage(m));
}

async function main() {
	let a;
	try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2; return; }
	let L;
	try { L = levelOf(a); } catch (e) { console.log(JSON.stringify({ error: `cannot read the level: ${e.message}` })); process.exitCode = 2; return; }
	settle(a, L);   // (the cells and the memory budget, for the workers too)
	const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
	const t0 = Date.now();
	const sec = () => Math.round((Date.now() - t0) / 100) / 10;
	// the field's tables in shared memory: the workers read them, and a copy per worker (the cost tables are about 120 MB
	// on a 1000 x 1000 level) would cost memory and start-up time on every thread
	const field = RF.shareField(RF.reachField(L));
	const sim0 = new E.EESim(L);
	sim0.reset();
	const startCost = RF.costAt(field, sim0);
	const ctrl = new Int32Array(new SharedArrayBuffer(8));
	ctrl[0] = a.depth;
	const seeds = Array.from({ length: a.workers }, (_, i) => (a.seed + i) >>> 0);
	say({ ev: 'start', workers: a.workers, seeds, mode: field.mode, cells: a.cells, startCost: startCost < 0 ? null : Math.round(startCost * 100) / 100, mem: a.mem, maxCells: a.maxCells,
		maxSnaps: a.maxSnaps });
	// the fastest verified route; the closest state
	let route = null, first = null, near = null, nearPending = false;
	const stats = new Map(), dones = new Map();
	const total = (k) => { let s = 0; for (const v of stats.values()) s += v[k] || 0; return s; };
	const samples = [[Date.now(), 0]];
	const bound = (d) => { if (d < Atomics.load(ctrl, 0)) Atomics.store(ctrl, 0, Math.max(0, d)); };
	const progress = () => {
		const now = Date.now(), tk = total('ticks');
		samples.push([now, tk]);
		while (samples.length > 2 && now - samples[1][0] >= 2000) samples.shift();
		const [ta, ka] = samples[0];
		let deepest = 0, minRc = null, nRooms = 0;
		for (const v of stats.values()) {
			deepest = Math.max(deepest, v.deepest || 0);
			nRooms = Math.max(nRooms, v.rooms || 0);
			if (v.minRc !== null && (minRc === null || v.minRc < minRc)) minRc = v.minRc;
		}
		say(Object.assign({ ev: 'progress', layer: deepest, tick: deepest, states: total('cells'), ticks: tk, ticksPerSec: now > ta ? Math.round((tk - ka) / ((now - ta) / 1000)) : 0,
			picks: total('picks'), bestCost: minRc === null || minRc >= 1e4 ? null : Math.round(minRc * 100) / 100, found: route ? route.ticks : 0, refined: total('refined') },
		a.cells === 'coarse' ? { rooms: nRooms } : {}, { workers: a.workers }));
	};
	// the workers' sources, each room key once per kind unless it improved (an earlier arrival, a lower cost): every
	// worker finds the same rooms
	const sourcesSent = new Map();   // room key -> {tick: the earliest "room" arrival sent, dist: the lowest "best" cost sent}
	const onSource = (msg) => {
		let s = sourcesSent.get(msg.room);
		if (!s) sourcesSent.set(msg.room, s = { tick: Infinity, dist: Infinity });
		if (msg.kind === 'room') { if (msg.t >= s.tick) return; s.tick = msg.t; } else { if (msg.rc >= s.dist - 0.5) return; s.dist = msg.rc; }
		say({ ev: 'source', kind: msg.kind, room: msg.room, desc: msg.desc, gain: msg.gain, tick: msg.t, dist: Math.round(msg.rc * 1000) / 1000, inputs: msg.inputs, seed: msg.seed });
	};
	const flushNear = () => {
		if (!nearPending) return;
		nearPending = false;
		say({ ev: 'closest', dist: Math.round(near.rc * 1000) / 1000, tick: near.t, inputs: near.inputs });
	};
	const timer = setInterval(() => { progress(); flushNear(); }, 500);
	if (a.stdin) {
		// the editor: "depth D" (a route of D + 1 ticks is known) and "stop"
		let buf = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (s) => {
			buf += s;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				const m = /^depth (\d+)$/.exec(line);
				if (m) bound(+m[1]);
				else if (line === 'stop') Atomics.store(ctrl, 1, 1);
			}
		});
		// the end of stdin: the editor went away (a crash, or a kill that missed its children): stop, rather than run on
		// every thread for the rest of --seconds
		process.stdin.on('end', () => Atomics.store(ctrl, 1, 1));
		process.stdin.on('error', () => Atomics.store(ctrl, 1, 1));
	}
	const onMessage = (msg) => {
		if (msg.type === 'stat' || msg.type === 'done') stats.set(msg.seed, msg);
		if (msg.type === 'closest') {
			if (!near || msg.rc < near.rc - 1e-3 || (msg.rc <= near.rc + 1e-3 && msg.t < near.t)) { near = msg; nearPending = true; }
		} else if (msg.type === 'source') {
			onSource(msg);
		} else if (msg.type === 'finish') {
			if (route && msg.t >= route.ticks) return;
			// replayed in the exact engine before it counts (the same engine found it, from snapshots and replays: a
			// mismatch would be a bug)
			const masks = Uint8Array.from(msg.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31);
			const ev = C.evaluate(L, masks);
			if (!ev || ev.ms.length !== msg.t) { say({ ev: 'warning', text: `worker ${msg.seed}: a route of ${msg.t} ticks does not replay (${ev ? `finishes after ${ev.ms.length}` : 'does not finish'})` }); return; }
			bound(msg.t - 1);
			route = { ticks: msg.t, runTicks: ev.runTicks, inputs: msg.inputs, seed: msg.seed, simTicks: msg.simTicks, sec: sec() };
			if (!first) first = { ticks: msg.t, sec: route.sec, simTicks: msg.simTicks, seed: msg.seed };
			say({ ev: 'result', kind: 'finish', ticks: msg.t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), inputs: msg.inputs, seed: msg.seed, simTicks: msg.simTicks,
				sec: route.sec });
			if (a.out) { try { C.writeEetas(a.out, ev.ms); } catch (e) { say({ ev: 'warning', text: `cannot write ${a.out}: ${e.message}` }); } }
			if (a.first) Atomics.store(ctrl, 1, 1);
		} else if (msg.type === 'done') dones.set(msg.seed, msg);
	};
	await Promise.all(seeds.map((seed) => new Promise((res) => {
		// (the heap limit leaves room above the budget: the sizes per cell and snapshot are estimates)
		const w = new Worker(__filename, { workerData: { goexplore: true, a, seed, ctrl, field }, resourceLimits: { maxOldGenerationSizeMb: Math.round(a.mem * 2 + 256) } });
		w.on('message', onMessage);
		w.on('error', (e) => { say({ ev: 'warning', text: `worker ${seed}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}` }); res(); });
		w.on('exit', () => res());
	})));
	clearInterval(timer);
	if (a.stdin) { try { process.stdin.pause(); process.stdin.destroy(); } catch (e) { /* gone */ } }
	progress();
	flushNear();
	const ends = [...dones.values()].map((d) => d.end);
	const end = ends.includes('unreachable') ? 'unreachable' : ends.includes('stopped') && !(a.first && route) ? 'stopped' : a.first && route ? 'finish'
		: ends.includes('time') ? 'time' : ends.includes('ticks') ? 'ticks' : ends.length && ends.every((x) => x === 'exhausted') ? 'exhausted' : ends[0] || 'error';
	const tk = total('ticks'), secs = (Date.now() - t0) / 1000;
	let deepest = 0;
	for (const v of stats.values()) deepest = Math.max(deepest, v.deepest || 0);
	say({ ev: 'done', layers: deepest, seconds: Math.round(secs * 100) / 100, ticks: tk, ticksPerSec: Math.round(tk / Math.max(1e-3, secs)), states: total('cells'),
		picks: total('picks'), end, finish: route ? route.ticks : 0, first,
		cells: a.cells, workers: seeds.map((s) => {
			const d = dones.get(s) || stats.get(s) || {};
			return Object.assign({ seed: s, end: d.end || null, ticks: d.ticks || 0, cells: d.cells || 0, first: d.first || null, best: d.best || null, full: !!d.full,
				snaps: d.snaps || 0, dropped: d.dropped || 0, replays: d.replays || 0, heapMB: d.heapMB || 0 },
			a.cells === 'coarse' ? { rooms: d.rooms || 0, bursts: d.bursts || 0, walks: d.walks || 0, walkHits: d.hits || 0, walkMs: d.walkMs || 0 } : {});
		}) });
	console.log(`[goexplore] ${a.workers} worker${a.workers > 1 ? 's' : ''} (seed ${a.seed}${a.workers > 1 ? `..${a.seed + a.workers - 1}` : ''}), ${a.cells} cells, ${secs.toFixed(1)} s, ` +
		`${(tk / 1e6).toFixed(2)} M ticks, ${total('cells').toLocaleString('en-US')} cells${a.cells === 'coarse' ? ` in ${Math.max(0, ...[...stats.values()].map((v) => v.rooms || 0))} rooms` : ''}, end ${end}: ` +
		(route ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks of worker ${first.seed}); best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s` +
			(a.out ? ` -> ${a.out}` : '') : `no route (closest: reach cost ${near ? near.rc.toFixed(2) : '-'} at tick ${near ? near.t : '-'})`));
}

if (!isMainThread && workerData && workerData.goexplore) workerMain();
else if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; });

module.exports = { OPTIONS, QP, QV, FINE_MAX_TILES, parseArgs, settle, cellsFor, coarseMem, discreteOf, roomOf, roomFields, inputsOf, rngOf };
