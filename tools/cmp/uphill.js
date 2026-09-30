'use strict';
// THE UPHILL TEST (compiler doctor 1, n5): how far a KNOWN ROUTE climbs the executor's goal field on its way to a stuck
// target. The executor orders every leg by the goal field (reach.js to the target's tiles, the doors as they stand) and
// its skeleton descends that field's level sets c0 - 12, c0 - 24, ... (executor.js SKEL_STEP 12 tiles): a way that must
// first go UP the field by more than a step is one the skeleton cannot follow and the best-first order punishes. Along the
// route's own stretch (from its previous trigger, else the spawn, to its first tick in the target) the field's value at
// every tick: the start value, the running minimum, the largest rise above it (maxRise, where), the share of ticks more
// than a tile above it (aboveShare), ticks the field calls cut off (-1: a field error along a real route).
//   node tools/cmp/uphill.js <level.eelvl> <route.eetas> "<label>|trophy"           one JSON line
//   node tools/cmp/uphill.js --krt=<krt jsonl> [--root=<checkout with src/out, src/jobs>]   every row with a route hit
// <label>: the model's trigger label as the compile reports it (a trailing " xN" dropped) or "trophy". --krt: the rows of
// tools/cmp/krt.js runs ({rel, label, kind, hit}), the routes from src/plan/truthset.js knownRoutes (EEAT_TRUTH_ROOT /
// --root); per row a JSON line with the krt kind, then a summary per kind (rise > 12 = past one skeleton step).
// Measured (n5, the 48 rows of src/out/n4plan/krt_b4.jsonl with a hit): LONG legs (found only 120-300 route ticks before
// the target) climb the field by more than 12 tiles in 11 of 17 (median 15.4 tiles), ARRIVAL legs (found from the route's
// own previous-trigger state) in 3 of 28 (median 1 tile), FINDER 2 of 3.
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const RF = require(path.join(root, 'src/reach.js'));
const SKEL_STEP = 12;

/** uphill(L, masks, label) -> the row (null: the route never enters the target) */
function uphill(L, masks, label0) {
	const label = String(label0).replace(/ x\d+$/, '');
	const W = L.width, H = L.height;
	let tiles, inTarget;
	if (label === 'trophy') { tiles = Array.from(T.goalOf(L, { kind: 'trophy' }).tiles); inTarget = (s) => !!s.has_silver_crown; }
	else {
		const X = MD.compileModel(L).triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) return { err: 'no trigger ' + label };
		tiles = X.tiles.slice();
		const set = new Set(tiles);
		inTarget = (s) => set.has(T.tileOf(s, W, H));
	}
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let hit = -1;
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (inTarget(sim)) { hit = t + 1; break; } if (sim.has_silver_crown) break; }
	if (hit < 0) return { err: 'the route never enters the target' };
	const ev = TS.routeEvents(L, masks);
	const prev = ev.events.filter((e) => e.tick < hit && e.feat !== 'deaths' && e.feat !== 'fx').pop();
	const t0 = prev ? prev.tick : 0;
	sim.reset();
	for (let t = 0; t < t0; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
	const vals = [], tileAt = [];
	let lastFg = null, f = null;
	for (let t = t0; t < hit; t++) {
		const Lc = T.levelNow(L, sim);
		if (Lc.fg !== lastFg) { f = T.goalField(Lc, tiles, {}); lastFg = Lc.fg; }
		vals.push(RF.costAt(f, sim));
		tileAt.push(T.tileOf(sim, W, H));
		E.applyMask(inp, masks[t] & 31); sim.tick(inp);
	}
	let run = Infinity, rise = 0, riseAt = -1, above = 0, cut = 0;
	for (let i = 0; i < vals.length; i++) {
		const v = vals[i];
		if (v < 0) { cut++; continue; }
		if (v < run) run = v;
		if (v - run > rise) { rise = v - run; riseAt = i; }
		if (v > run + 1) above++;
	}
	const samples = [];
	for (let q = 0; q <= 10; q++) { const i = Math.min(vals.length - 1, Math.round(q * (vals.length - 1) / 10)); samples.push(Math.round(vals[i])); }
	const k = riseAt >= 0 ? tileAt[riseAt] : -1;
	return { label, from: prev ? `${prev.feat}@${prev.tick}` : 'spawn', t0, hit, leg: hit - t0, start: +(+vals[0]).toFixed(1), min: +(+run).toFixed(1),
		maxRise: +rise.toFixed(1), riseTick: riseAt >= 0 ? t0 + riseAt : -1, riseTile: k >= 0 ? [k % W, (k / W) | 0] : null,
		aboveShare: +(above / Math.max(1, vals.length)).toFixed(2), cutTicks: cut, pastStep: rise > SKEL_STEP, samples };
}

if (require.main === module) {
	const argv = process.argv.slice(2);
	const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
	const pos = argv.filter((s) => !s.startsWith('--'));
	const krt = opt('krt', '');
	if (krt) {
		if (opt('root', '')) process.env.EEAT_TRUTH_ROOT = opt('root', '');
		const rows = fs.readFileSync(krt, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((r) => r && r.hit > 0 && r.label);
		const byName = new Map();
		for (const e of TS.knownRoutes()) if (!byName.has(e.name)) byName.set(e.name, e);
		const kinds = {};
		for (const r of rows) {
			const name = path.basename(r.rel || r.level || '').replace(/\.eelvl$/, '');
			const e = byName.get(name);
			if (!e) continue;
			let j;
			try { j = uphill(T.loadLevelFile(e.levelFile), C.readEetas(e.route), r.label); } catch (x) { j = { err: String(x && x.message || x).slice(0, 160) }; }
			j = Object.assign({ level: name, kind: r.kind || '?' }, j);
			console.log(JSON.stringify(j));
			if (j.err) continue;
			const s = kinds[j.kind] || (kinds[j.kind] = { n: 0, pastStep: 0, rises: [] });
			s.n++; if (j.pastStep) s.pastStep++; s.rises.push(j.maxRise);
		}
		for (const k of Object.keys(kinds)) { const a = kinds[k].rises.sort((x, y) => x - y); console.log(JSON.stringify({ summary: k, n: kinds[k].n, pastStep: kinds[k].pastStep, medianRise: a[a.length >> 1] })); }
	} else {
		const [file, rfile, label] = pos;
		if (!file || !rfile || !label) { console.error('usage: node tools/cmp/uphill.js <level.eelvl> <route.eetas> "<label>|trophy" | --krt=<krt jsonl>'); process.exit(2); }
		console.log(JSON.stringify(Object.assign({ level: path.basename(file) }, uphill(T.loadLevelFile(file), C.readEetas(rfile), label))));
	}
}
module.exports = { uphill, SKEL_STEP };
