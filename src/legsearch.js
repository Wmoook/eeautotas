'use strict';
// The leg search: the one search's CPU operator for a burst arm that stalls (src/bursts.js). From a state (the level
// start + a prefix of inputs), a breadth-first search over FINE cells (1 px x, 2 px y, 1/16 px/tick vx, 1/8 px/tick vy,
// on the ground, the jump count, the room) that keeps the FASTEST state of each cell (|vx| + |vy|), where the coarse
// archive and the GPU bursts keep the first one to arrive; a layer over `cap` keeps its states by novelty per tile first
// (the tiles seen least in earlier layers), then speed. Its goal: the room changes by a trigger (goexplore.js roomOf:
// a coin, key, switch, effect, ...) into a room not in `known`.
// Why: a leg whose speed has to be built far from its target is lost by searches that rank by distance or keep the first
// arrival. NC Naos Antediluvian's coin 8 (after coin 7 at (270, 84) and the portal to (266, 111)): the known route goes
// right to the dots below the portal pocket (300, 102), then 15 rows DOWN and back up at 5.7 px/tick to rise into it;
// the one search's bursts there filled their 16.8 M-state tables 4 tiles short for 15 minutes. Forgotten Helix's coin 4:
// the fall into the shaft's portal (249, 123) must be 9.5+ px/tick (engine tests), built on the arrows 200+ ticks before.
// Every find is a whole run (the prefix + the leg) that the caller replays; nothing here prunes the archive.
//   legSearch(L, prefix, { depth, cap, ms, box, region (Uint8Array over the tiles: 1 = the centre may be there), known, stop }) -> { found (Uint8Array | null), desc, layers, sims, sec, tiles, why }
//   run as a worker thread: workerData { legsearch: true, file | level (goexplore.js's a.file / a.level), prefix (string of
//   '0'+mask chars), o } -> posts { found (string | null), ... }
const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('./eesim.js');

// the 18 inputs (left / none / right x up / none / down x jump or not)
const OPT = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPT.push(h | v | j);
const DEFAULTS = { depth: 900, cap: 80000, ms: 900000 };

function legSearch(L, prefix, o) {
	o = Object.assign({}, DEFAULTS, o || {});
	const GX = require('./goexplore.js');
	const RM = o.RM || GX.roomOf(L);
	const W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < prefix.length; t++) { E.applyMask(inp, prefix[t] & 31); sim.tick(inp); if (sim.is_dead) return { found: null, why: 'the prefix dies', layers: 0, sims: 0, sec: 0, tiles: 0 }; }
	const key0 = RM.key(sim), cause0 = RM.cause(sim);
	const known = o.known || null;
	const box = o.box || null, region = o.region || null;
	const t0 = Date.now();
	let cur = [{ sn: sim.snapshot(), p: null }];
	const seen = new Set(), tileSeen = new Map();
	let sims = 0, found = null, layers = 0, why = 'depth';
	for (let l = 0; l < o.depth && !found; l++) {
		layers = l + 1;
		if (Date.now() - t0 > o.ms) { why = 'time'; break; }
		if (o.stop && o.stop()) { why = 'stopped'; break; }
		const nx = new Map();
		for (const c of cur) {
			for (const m of OPT) {
				sim.restore(c.sn); E.applyMask(inp, m); sim.tick(inp); sims++;
				if (sim.is_dead) continue;
				const k2 = RM.key(sim);
				if (k2 !== key0 && RM.byTrigger(cause0, RM.cause(sim)) && !(known && known.has(k2))) { found = { node: { p: c.p, m }, desc: RM.desc(sim) }; break; }
				const cx = (sim.px + 8) >> 4, cy = (sim.py + 8) >> 4;
				if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
				if (box && (cx < box[0] || cx > box[2] || cy < box[1] || cy > box[3])) continue;
				if (region && !region[cy * W + cx]) continue;
				const k = `${Math.floor(sim.px)},${Math.floor(sim.py * 0.5)},${Math.floor(sim.speed_x * 16)},${Math.floor(sim.speed_y * 8)},${sim.on_ground ? 1 : 0},${sim.jump_count},${k2}`;
				if (seen.has(k)) continue;
				const v = Math.abs(sim.speed_x) + Math.abs(sim.speed_y);
				const e = nx.get(k);
				if (e) { if (v > e.v) { e.sn = sim.snapshot(); e.v = v; e.node = { p: c.p, m }; } continue; }
				nx.set(k, { sn: sim.snapshot(), v, t: cy * W + cx, node: { p: c.p, m } });
			}
			if (found) break;
		}
		if (found) break;
		for (const k of nx.keys()) seen.add(k);
		// (the seen set is a memory of the layers before: past a few million keys it starts over, so it never takes GBs)
		if (seen.size > 4e6) seen.clear();
		let arr = [...nx.values()];
		if (arr.length > o.cap) { arr.sort((x, y) => (tileSeen.get(x.t) || 0) - (tileSeen.get(y.t) || 0) || y.v - x.v); arr.length = o.cap; }
		for (const x of arr) tileSeen.set(x.t, (tileSeen.get(x.t) || 0) + 1);
		cur = arr.map((x) => ({ sn: x.sn, p: x.node }));
		if (!cur.length) { why = 'exhausted'; break; }
	}
	const sec = (Date.now() - t0) / 1000;
	if (!found) return { found: null, why, layers, sims, sec, tiles: tileSeen.size };
	const leg = [];
	for (let n = found.node; n; n = n.p) leg.push(n.m);
	leg.reverse();
	const out = new Uint8Array(prefix.length + leg.length);
	out.set(prefix, 0); out.set(leg, prefix.length);
	return { found: out, desc: found.desc, legTicks: leg.length, layers, sims, sec, tiles: tileSeen.size, why: 'found' };
}

/** the level as goexplore.js loads it (an .eelvl like the editor, a level JSON, or a level / job id) */
function levelOf(d) {
	if (d.file && /\.eelvl$/i.test(d.file)) {
		const EL = require('./eelvl.js');
		return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(d.file)), { id: 'goexplore', file: path.basename(d.file) }));
	}
	if (d.file) return E.loadLevel(d.file);
	return require('./common.js').loadLevel(d.level);
}

if (!isMainThread && workerData && workerData.legsearch) {
	const d = workerData;
	let res;
	try {
		const L = levelOf(d);
		const prefix = Uint8Array.from(d.prefix, (ch) => (ch.charCodeAt(0) - 48) & 31);
		const o = Object.assign({}, d.o, { known: d.known ? new Set(d.known) : null });
		const r = legSearch(L, prefix, o);
		res = Object.assign({}, r, { found: r.found ? String.fromCharCode(...Array.from(r.found.subarray(prefix.length), (m) => 48 + m)) : null, prefixLen: prefix.length });
		if (res.found) res.found = d.prefix + res.found;
	} catch (e) { res = { found: null, why: `error: ${e.message}` }; }
	parentPort.postMessage(res);
}

module.exports = { legSearch, levelOf, DEFAULTS };
