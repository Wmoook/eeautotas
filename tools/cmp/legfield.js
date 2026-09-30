'use strict';
// THE FIELD ALONG A KNOWN LEG (COMPILER DOCTOR 6, n5): the executor's ordering field (the waypoint's goal field on the level
// as the doors stand at the leg's start, types.js goalField, reach.js costAt) read along the known route's own leg, tick by
// tick. A field that rises along the true way (the way climbs out of a sub-level set it entered, or the start's cost is below
// the cost the route has to pass through) is a FALSE NEAR: the skeleton's level-set descent and the best-first finders order
// toward the wrong places. Prints per leg: the start cost, the max cost on the way, the total rise (sum of increases), the
// ticks spent above the start's cost, the first tick the leg's cost is below c0 - 12 (the skeleton's first sub-level set) and
// where, plus a coarse profile (the cost every ~N ticks).
//   node tools/cmp/legfield.js <level.eelvl> <route.eetas> [--minleg=200] [--every=50]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const RF = require(path.join(root, 'src/reach.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
const [file, rfile] = pos;
const minleg = +opt('minleg', 200), every = +opt('every', 50), max = +opt('max', 40);
const L = T.loadLevelFile(file), W = L.width, H = L.height;
const masks = C.readEetas(rfile);
const ev = TS.routeEvents(L, masks);
const M = MD.compileModel(L);
const trigOfTile = new Map();
for (const X of M.triggers) for (const t of X.tiles) if (!trigOfTile.has(t)) trigOfTile.set(t, X);
const near = (tile) => {
	if (trigOfTile.has(tile)) return trigOfTile.get(tile);
	const x0 = tile % W, y0 = (tile / W) | 0;
	let best = null, bd = 9;
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
		const X = trigOfTile.get((y0 + dy) * W + x0 + dx);
		if (X && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = X; }
	}
	return best;
};
const steps = [];
for (const e of ev.events) {
	if (e.feat === 'deaths' || e.feat === 'fx' || e.feat === 'cp') continue;
	if (e.feat === 'silver' || e.feat === 'crown') { steps.push({ tick: e.tick, label: 'trophy', wp: { kind: 'trophy', label: 'trophy' } }); break; }
	const X = near(e.tile);
	if (X) steps.push({ tick: e.tick, label: X.label, wp: { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label: X.label } });
}
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
let t = 0, prev = 0, n = 0;
for (const s of steps) {
	const tk = prev, leg = s.tick - tk;
	prev = s.tick;
	while (t < tk) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); t++; }
	if (leg < minleg || n >= max) continue;
	n++;
	const goal = T.goalOf(L, s.wp);
	const f = T.goalField(T.levelNow(L, sim), T.fieldTilesOf(goal), { deaths: false, plainFx: T.plainOf(sim) });
	const mode = f.mode + (f.fxSeeds ? '+fx' + f.fxSeeds : '');
	const snap = sim.snapshot();
	const c0 = RF.costAt(f, sim);
	let cmax = c0, rise = 0, above = 0, last = c0, firstSub = -1, subTile = null, cut = 0, cmin = c0, cminAt = 0;
	const prof = [];
	for (let k = 0; k < leg; k++) {
		E.applyMask(inp, masks[tk + k] & 31); sim.tick(inp);
		const c = RF.costAt(f, sim);
		if (c < 0) { cut++; continue; }
		if (c > cmax) cmax = c;
		if (c < cmin) { cmin = c; cminAt = k + 1; }
		if (last >= 0 && c > last) rise += c - last;
		if (c > c0) above++;
		if (firstSub < 0 && c0 >= 0 && c <= c0 - 12) { firstSub = k + 1; subTile = T.tileOf(sim, W, H); }
		last = c;
		if ((k + 1) % every === 0) prof.push(Math.round(c));
	}
	console.log(JSON.stringify({ label: s.label, mode, start: tk, leg, c0: +c0.toFixed(1), cmax: +cmax.toFixed(1), rise: +rise.toFixed(1), aboveTicks: above, cutTicks: cut,
		firstSub, subTile: subTile !== null ? [subTile % W, (subTile / W) | 0] : null, prof: prof.join(' ') }));
	sim.restore(snap);
	// (back to the leg start: the outer loop plays on from tk)
	t = tk;
}
