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
// It prints the JSON lines of the editor's native tools (native/beamhost.h, explorehost.h), one per line:
//   {"ev":"start","workers":n,"seeds":[..],"mode":"physics"|"walk","startCost":c|null,"maxCells":..}
//   {"ev":"progress","layer":L,"tick":L,"states":cells,"ticks":simulated,"ticksPerSec":..,"picks":..,"bestCost":..,
//     "found":T|0,"refined":tiles,"workers":n}                                  (every 0.5 s; L = the deepest cell's tick)
//   {"ev":"closest","dist":reach cost,"tick":T,"inputs":".."}                    (the state nearest the trophy, when it
//                                                                                  improves, at most every 0.5 s)
//   {"ev":"result","kind":"finish","ticks":T,"runTicks":..,"inputs":"..","seed":s,"simTicks":..,"sec":..}
//   {"ev":"done","layers":L,"seconds":..,"ticks":..,"ticksPerSec":..,"states":..,"picks":..,"end":"time"|"ticks"|
//     "exhausted"|"finish"|"stopped"|"unreachable","finish":T|0,"first":{ticks,sec,simTicks,seed}|null,
//     "workers":[{seed,..},..]}      ("unreachable": the reach field rules out the start itself, "exhausted": no cell is
//                                      early enough for a faster route)
// Inputs are .eetas characters ('0' + mask). With --stdin=1 it reads lines from stdin: "depth D" (from now on only
// routes of at most D ticks: a route of D + 1 is known elsewhere) and "stop"; the end of stdin (the editor is gone)
// stops it too. A last line "[goexplore] ..." sums up.
//
// usage: node src/goexplore.js <level.eelvl | level.json> | --level=<level id | job id>  [--seconds=60] [--workers=1]
//        [--seed=1] [--depth=6000] [--maxTicks=0 (per worker; 0 = no limit)] [--first=0|1 (stop at the first route)]
//        [--out=<route.eetas>] [--stdin=0|1] [--lambda=2] [--roll=40] [--rolls=8] [--keep=0.85] [--stall=200]
//        [--refine=6] [--maxres=4] [--mem=<MB per worker; default 1600 / workers, 200 .. 800>] [--maxCells=] [--maxSnaps=]
//        [--prune=1 (0: the reach field rules nothing out: the start is never "unreachable", a ruled-out state costs
//        1e4 + its walking distance; the editor's check of a level the field calls impossible)]
const fs = require('fs');
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
const DEFAULTS = { seconds: 60, workers: 1, seed: 1, depth: 6000, maxTicks: 0, first: 0, stdin: 0, lambda: 2, roll: 40, rolls: 8, keep: 0.85,
	stall: 200, refine: 6, maxres: MAXRES, mem: 0, maxCells: 0, maxSnaps: 0, prune: 1 };
const CHUNK = 16;   // picks between two looks at the clock, the shared bound and the stop flag
// memory (V8 heap, measured): a cell without its snapshot about 260 bytes, a snapshot about 1150; each gets 45% of a
// worker's --mem
const CELL_BYTES = 260, SNAP_BYTES = 1150;

function parseArgs(argv) {
	const a = Object.assign({}, DEFAULTS, { file: '', level: '', out: '' });
	for (const s of argv) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) {
			if (s.startsWith('--')) throw new Error(`bad option ${s} (use --name=value)`);
			a.file = s;
			continue;
		}
		if (m[1] === 'level' || m[1] === 'out') a[m[1]] = m[2];
		else if (m[1] in DEFAULTS) {
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
	if (!a.mem) a.mem = Math.max(200, Math.min(800, Math.round(1600 / a.workers)));
	if (!a.maxCells) a.maxCells = Math.round(a.mem * 1048576 * 0.45 / CELL_BYTES);
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
 * One explorer (a worker thread; a = the options, seed its seed). ctrl (Int32Array on a SharedArrayBuffer): [0] the
 * longest route that still counts (ticks), [1] stop. post(msg): to the main thread ('finish', 'closest', 'stat', 'done').
 */
function explore(L, field, a, seed, ctrl, post) {
	const W = L.width, H = L.height, N = W * H;
	const rnd = rngOf(seed);
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	const disc = discreteOf(L);
	const res = new Uint8Array(N);   // the cell grain per tile (0 .. maxres)
	const t0 = Date.now(), tEnd = t0 + a.seconds * 1000;
	let maxT = Math.min(a.depth, Atomics.load(ctrl, 0));
	// the cell key: two 32-bit hash lanes over the cell's numbers (53 bits; two cells collide with probability ~2^-53 per
	// pair, and a collision only merges two cells of this archive: every route is replayed exactly anyway)
	const KV = new Int32Array(10);
	let tile = 0;
	const cellKey = () => {
		const px = sim.px, py = sim.py;
		const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
		tile = Math.min(N - 1, Math.max(0, ty * W + tx));
		const r = res[tile];
		KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (r << 1); KV[2] = sim.jump_count; KV[3] = sim._q0; KV[4] = sim._q1; KV[5] = disc(sim);
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
	/** the live state (tick t, reach cost rc; reached from cell pc's state by the inputs of node) into the archive */
	const add = (t, rc, pc, up, buf, o, n) => {
		if (t >= maxT) return;   // (a route from there would not be faster)
		const k = cellKey();
		const c = cells.get(k);
		if (c !== undefined) {
			if (c.t <= t) return;
			if (c.snap !== null) { c.snap = null; nSnaps--; }
			c.t = t; c.pc = pc; c.pgen = pc.gen; c.node = { up, buf, o, n }; c.rc = rc; c.gen++; c.ver++;
			hpush(c);
			return;
		}
		if (cells.size >= a.maxCells) { full = true; return; }
		const nc = { t, snap: null, pc, pgen: pc.gen, node: { up, buf, o, n }, rc, picks: 0, tile, ver: 0, gen: 0, used: false };
		cells.set(k, nc);
		hpush(nc);
		if (t > deepest) deepest = t;
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
	{
		// the start (the reach field rules it out: no route, a proof; the search ends at once, unless --prune=0)
		const rc = costOf();
		const k = cellKey();
		const c = { t: 0, snap: null, pc: null, pgen: 0, node: null, rc, picks: 0, tile, ver: 0, gen: 0, used: false };
		cells.set(k, c);
		hpush(c);
		keepSnap(c, startSnap);
		if (rc < 0) end = 'unreachable';
	}
	let ticks = 0, picks = 0, lastProgress = 0, refined = 0, minRc = Infinity;
	let first = null, best = null;   // routes: {t, sec, simTicks}
	let near = null, nearSent = null, lastSent = 0, lastStat = 0;   // the closest state: {rc, t, node}
	const stat = () => ({ type: 'stat', seed, ticks, cells: cells.size, picks, deepest, minRc: Number.isFinite(minRc) ? minRc : null, refined, full,
		snaps: nSnaps, dropped, replays });
	const sendNear = () => {
		if (!near || near === nearSent) return;
		nearSent = near;
		post({ type: 'closest', seed, rc: near.rc, t: near.t, inputs: C.eetasBytes(inputsOf(near.node)).toString('latin1') });
	};
	while (!end) {
		// between chunks: the clock, the stop flag, the shared bound (a faster route from another worker or the editor)
		const now = Date.now();
		if (Atomics.load(ctrl, 1) !== 0) { end = 'stopped'; break; }
		if (now >= tEnd) { end = 'time'; break; }
		maxT = Math.min(maxT, Atomics.load(ctrl, 0));
		if (now - lastStat >= 250) { lastStat = now; post(stat()); }
		if (now - lastSent >= 250) { lastSent = now; sendNear(); }
		for (let k = 0; k < CHUNK && !end; k++) {
			// the pick: the lowest priority whose entry is live and whose state is early enough
			let e = null;
			while (hv.length) {
				const c = hpop();
				if (popVer !== c.ver || c.t >= maxT) continue;
				e = c;
				break;
			}
			if (e === null) { end = 'exhausted'; break; }
			e.picks++; e.ver++; picks++;
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
					if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
					if (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) near = { rc, t, node: { up, buf, o, n: s + 1 } };
					add(t, rc, e, up, buf, o, s + 1);
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
	say({ ev: 'start', workers: a.workers, seeds, mode: field.mode, startCost: startCost < 0 ? null : Math.round(startCost * 100) / 100, mem: a.mem, maxCells: a.maxCells,
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
		let deepest = 0, minRc = null;
		for (const v of stats.values()) { deepest = Math.max(deepest, v.deepest || 0); if (v.minRc !== null && (minRc === null || v.minRc < minRc)) minRc = v.minRc; }
		say({ ev: 'progress', layer: deepest, tick: deepest, states: total('cells'), ticks: tk, ticksPerSec: now > ta ? Math.round((tk - ka) / ((now - ta) / 1000)) : 0,
			picks: total('picks'), bestCost: minRc === null || minRc >= 1e4 ? null : Math.round(minRc * 100) / 100, found: route ? route.ticks : 0, refined: total('refined'), workers: a.workers });
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
		workers: seeds.map((s) => { const d = dones.get(s) || stats.get(s) || {}; return { seed: s, end: d.end || null, ticks: d.ticks || 0, cells: d.cells || 0, first: d.first || null, best: d.best || null, full: !!d.full,
			snaps: d.snaps || 0, dropped: d.dropped || 0, replays: d.replays || 0, heapMB: d.heapMB || 0 }; }) });
	console.log(`[goexplore] ${a.workers} worker${a.workers > 1 ? 's' : ''} (seed ${a.seed}${a.workers > 1 ? `..${a.seed + a.workers - 1}` : ''}), ${secs.toFixed(1)} s, ` +
		`${(tk / 1e6).toFixed(2)} M ticks, ${total('cells').toLocaleString('en-US')} cells, end ${end}: ` +
		(route ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks of worker ${first.seed}); best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s` +
			(a.out ? ` -> ${a.out}` : '') : `no route (closest: reach cost ${near ? near.rc.toFixed(2) : '-'} at tick ${near ? near.t : '-'})`));
}

if (!isMainThread && workerData && workerData.goexplore) workerMain();
else if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; });

module.exports = { OPTIONS, QP, QV, parseArgs, discreteOf, inputsOf, rngOf };
