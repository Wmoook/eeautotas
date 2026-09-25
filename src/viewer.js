'use strict';
// Data for the web app's run viewer ("Watch"): GET /api/jobs/:id/trajectory and GET /api/jobs/:id/level.
// - trajectory(): replays a run in the job's exact engine (the level JSON with its rng_script and start_mode, the
//   same one every optimizer tool loads) and returns per-tick positions (1/16 px), the run timer, inputs, flags
//   (dead, on ground, gravity), the events (coins, portals, deaths, keys, switches, finish) and the door states
//   over time (exact: sim.is_tile_solid_now on one tile per door kind + number).
// - align(): which tick of the original run is "at the same point" as each tick of the best run (dynamic time
//   warping over the two paths, in a band around the diagonal), for the viewer's "the original is 0.42 s behind".
// - levelView(): width, height, the fg/bg block ids, EE's own minimap color per id (src/minimap.js) and the block
//   kind per id (src/blocks.js) so the page can draw arrows, portals, coins, doors, spikes and the finish.
// Typed arrays travel as base64 of their little-endian bytes.
const C = require('./common.js');
const B = require('./blocks.js');
const M = require('./minimap.js');
const E = C.E;

const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const GRAV = (x, y) => (x === 0 && y === 1 ? 0 : x === 0 && y === -1 ? 1 : x === -1 && y === 0 ? 2 : x === 1 && y === 0 ? 3 : 4);

/**
 * Replays `masks` from the level start until the finish (or the end of the inputs). Returns the raw typed arrays
 * (for align()) and the JSON the page reads (json()).
 */
function trajectory(level, masks) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const X = new Int32Array(n + 1), Y = new Int32Array(n + 1), RUN = new Int32Array(n + 1), FL = new Uint8Array(n + 1);
	const W = level.width, H = level.height;
	// door groups: every door tile of one id + number behaves alike; watch one tile of each
	const groups = new Map();   // "id:num" -> {x, y, solid, toggles: []}
	for (let i = 0; i < W * H; i++) {
		const id = level.fg[i];
		if (!id || B.kindOf(id).kind !== 'door') continue;
		const x = i % W, y = (i / W) | 0;
		const key = `${id}:${sim.get_tile_number(x, y) | 0}`;
		if (!groups.has(key)) groups.set(key, { x, y, solid: sim.is_tile_solid_now(x, y), toggles: [] });
	}
	const doorList = [...groups.values()];
	for (const g of doorList) g.solid0 = g.solid;
	// coins already collected at the start (110/111 stored in the file stay collected after a plain load)
	const taken0 = [];
	for (let k = 0; k < level.coinTiles.length; k++) {
		const i = level.coinTiles[k];
		if (sim.is_coin_collected(i % W, (i / W) | 0)) taken0.push(i);
	}
	const events = [];
	let complete = -1, deaths = 0, timerStart = -1;
	sim.onEvent = (k, d) => {
		const t = sim.ticks();
		const tile = d && d.tile;
		switch (k) {
			case 'complete': if (complete < 0) complete = t; events.push([t, k, tile.x, tile.y]); break;
			case 'coin': case 'blue_coin': case 'checkpoint': case 'crown': events.push([t, k, tile.x, tile.y]); break;
			case 'portal': events.push([t, k, d.from.x, d.from.y, d.to.x, d.to.y]); break;
			case 'death': deaths++; events.push([t, k]); break;
			case 'respawn': case 'jump': events.push([t, k]); break;
			case 'key': events.push([t, k, d.color, tile.x, tile.y]); break;
			case 'key_expired': events.push([t, k, d.color]); break;
			case 'switch': events.push([t, k, d.kind, d.id, d.on ? 1 : 0]); break;
			default: break;
		}
	};
	const rec = (t) => {
		X[t] = Math.round(sim.px * 16); Y[t] = Math.round(sim.py * 16); RUN[t] = sim.run_ticks;
		const g = sim.gravity_dir || { x: 0, y: 1 };
		FL[t] = (sim.is_dead ? 1 : 0) | (sim.on_ground ? 2 : 0) | (GRAV(g.x, g.y) << 2);
	};
	rec(0);
	let t = 0;
	for (; t < n && complete < 0; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (timerStart < 0 && sim.run_ticks > 0) timerStart = t + 1;
		rec(t + 1);
		for (const g of doorList) {
			const s = sim.is_tile_solid_now(g.x, g.y);
			if (s !== g.solid) { g.solid = s; g.toggles.push(t + 1); }
		}
	}
	const len = t + 1;
	const doors = {};
	for (const [key, g] of groups) doors[key] = [g.solid0 ? 1 : 0, ...g.toggles];
	return {
		n: t, complete, runTicks: sim.run_ticks, timerStart, deaths, coins: sim.coins, blueCoins: sim.blue_coins,
		X: X.subarray(0, len), Y: Y.subarray(0, len), RUN: RUN.subarray(0, len), FL: FL.subarray(0, len),
		inputs: Uint8Array.from(masks.subarray ? masks.subarray(0, t) : masks.slice(0, t)), events, doors, taken0,
	};
}

/** the page's JSON for a trajectory (align: Int32Array from align(), or null) */
function json(tr, extra) {
	return Object.assign({
		ticks: tr.n, complete: tr.complete, finished: tr.complete >= 0, runTicks: tr.runTicks, time: C.fmt(tr.runTicks), timerStart: tr.timerStart,
		deaths: tr.deaths, coins: tr.coins, blueCoins: tr.blueCoins, posScale: 16,
		x: b64(tr.X), y: b64(tr.Y), run: b64(tr.RUN), flags: b64(tr.FL), inputs: b64(tr.inputs),
		events: tr.events, doors: tr.doors, coinsTaken0: tr.taken0,
	}, extra || {});
}

/**
 * For each tick i of run a, the first tick j of run b "at the same point": dynamic time warping of the two paths
 * (distance = px between the balls) in a band around the diagonal (0,0)-(na,nb). Monotone: j never goes back.
 */
function align(a, b) {
	const na = a.n, nb = b.n;
	let band = Math.max(400, Math.round(1.5 * Math.abs(na - nb)) + 300);
	band = Math.min(band, Math.max(50, Math.floor(40e6 / (na + 1) / 2)));   // at most ~40 M cells
	const Wd = 2 * band + 1;
	const lo = (i) => Math.max(0, Math.round(i * nb / Math.max(1, na)) - band);
	const hi = (i) => Math.min(nb, Math.round(i * nb / Math.max(1, na)) + band);
	const dir = new Uint8Array((na + 1) * Wd);   // 0 diagonal, 1 from (i-1, j), 2 from (i, j-1)
	let prev = new Float64Array(Wd).fill(Infinity), cur = new Float64Array(Wd).fill(Infinity);
	let plo = 0;
	const ax = a.X, ay = a.Y, bx = b.X, by = b.Y;
	for (let i = 0; i <= na; i++) {
		const l = lo(i), h = hi(i);
		cur.fill(Infinity);
		for (let j = l; j <= h; j++) {
			const dx = (ax[i] - bx[j]) / 16, dy = (ay[i] - by[j]) / 16;
			const d = Math.sqrt(dx * dx + dy * dy);
			let best = Infinity, dd = 0;
			if (i === 0 && j === 0) best = 0;
			if (i > 0) {
				const pd = j - 1 - plo, pu = j - plo;
				if (pd >= 0 && pd < Wd && prev[pd] < best) { best = prev[pd]; dd = 0; }
				if (pu >= 0 && pu < Wd && prev[pu] < best) { best = prev[pu]; dd = 1; }
			}
			if (j > l && cur[j - 1 - l] < best) { best = cur[j - 1 - l]; dd = 2; }
			cur[j - l] = best + d;
			dir[i * Wd + (j - l)] = dd;
		}
		const tmp = prev; prev = cur; cur = tmp; plo = l;
	}
	const first = new Int32Array(na + 1).fill(-1);
	let i = na, j = nb;
	for (;;) {
		first[i] = j;   // walking back, the last write for row i is its smallest j
		if (i === 0 && j === 0) break;
		const l = lo(i);
		const dd = dir[i * Wd + (j - l)];
		if (dd === 0) { i--; j--; } else if (dd === 1) i--; else j--;
		if (i < 0 || j < 0) break;
	}
	for (let k = 1; k <= na; k++) if (first[k] < 0) first[k] = first[k - 1];
	if (first[0] < 0) first[0] = 0;
	return first;
}

/**
 * Does it matter how the TAS was started in eeo-tas (after /reset or right after loading the level)? Yes when
 * the level has 2+ spawn points (/reset moves to the next spawn), time doors (the level clock), or the two start
 * states differ in any other way (e.g. collected coins stored in the file, which /reset puts back).
 */
function startMatters(level) {
	if (level.spawnsX.length >= 2 || level.hasTimeDoors) return true;
	try { return new E.EESim(level, { start: 'reset' }).stateKey() !== new E.EESim(level, { start: 'load' }).stateKey(); } catch (e) { return true; }
}

/** The level for the viewer: ids, EE minimap colors, block kinds, door numbers, portals, spawns. */
function levelView(levelJson, level, meta) {
	const W = level.width, H = level.height, N = W * H;
	const fg = new Uint16Array(N), bg = new Uint16Array(N);
	const used = new Set();
	for (let i = 0; i < N; i++) {
		fg[i] = Math.min(65535, level.fg[i]); used.add(fg[i]);
		if (level.bg) { bg[i] = Math.min(65535, Math.max(0, level.bg[i])); used.add(bg[i]); }
	}
	const palette = {}, kinds = {};
	const haveTable = M.table().size > 0;
	for (const id of used) {
		palette[id] = haveTable ? (M.colorOf(id) >>> 0).toString(16).padStart(8, '0') : null;
		const k = B.kindOf(id);
		kinds[id] = [k.kind, k.dir || k.sub || (k.rotatable ? 'rot' : ''), B.isSolidId(id) ? 1 : 0];
	}
	const nums = [], portals = [];
	const byId = new Map();
	for (const e of levelJson.extras || []) {
		const t = level.fg[e[0]];
		if (t === 242 || t === 381) byId.set(e[2] | 0, (byId.get(e[2] | 0) || 0) + 1);
	}
	for (const e of levelJson.extras || []) {
		const i = e[0], t = level.fg[i];
		if (t === 242 || t === 381) {
			const id = e[2] | 0, target = e[3] | 0;
			portals.push([i, e[1] | 0, id, target, target !== id && (byId.get(target) || 0) > 1 ? 1 : 0]);
		} else if (e[1] !== null && e[1] !== undefined) nums.push([i, e[1] | 0]);
	}
	const spawns = [];
	for (let k = 0; k < level.spawnsX.length; k++) spawns.push([level.spawnsX[k], level.spawnsY[k]]);
	const m = meta || {};
	return {
		width: W, height: H, name: (m.level && m.level.name) || levelJson.world_name || '', fg: b64(fg), bg: b64(bg),
		palette, kinds, nums, portals, spawns, colors: haveTable ? 'ee-minimap' : 'app',
		startMode: m.startMode || level.startMode || 'reset', startMatters: m.startMatters !== undefined ? m.startMatters : startMatters(level),
	};
}

module.exports = { trajectory, json, align, levelView, startMatters };
