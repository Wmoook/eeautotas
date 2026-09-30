'use strict';
// THE EFFECT SHARE OF THE KNOWN ROUTES (a doctor's tool, n5): per level with effect tiles (jump 417, fly 418, speed 419,
// low gravity 453, multijump 461, gravity 1517: the tiles that make reach.js's goal field the gravity-blind walk), the
// share of its known route's ticks the ball has an effect on (max_jumps != 1, jump / speed boost, low gravity, levitation,
// a gravity rotation): the ticks a plain-ball physics field (doctor 6's EEAT_FX_FIELD) cannot order, which read the walk.
//   EEAT_TRUTH_ROOT=<checkout with src/jobs, src/out> node tools/cmp/fxshare.js [--json=1]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const TS = require(path.join(root, 'src/plan/truthset.js'));
const E = require(path.join(root, 'src/eesim.js'));
const FX = new Set([417, 418, 419, 453, 461, 1517]);
const json = process.argv.includes('--json=1');
const seen = new Set(), rows = [];
for (const k of TS.knownRoutes({})) {
	if (seen.has(k.name)) continue;
	let t;
	try { t = TS.loadTruth(k); } catch (e) { continue; }
	if (!t) continue;
	const L = t.L;
	let fxTiles = 0;
	for (let i = 0; i < L.fg.length; i++) if (FX.has(L.fg[i])) fxTiles++;
	if (!fxTiles) continue;
	seen.add(k.name);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let on = 0, n = 0;
	for (let i = 0; i < t.masks.length; i++) {
		E.applyMask(inp, t.masks[i] & 31); sim.tick(inp); n++;
		if (sim.max_jumps !== 1 || sim.jump_boost || sim.speed_boost || sim.low_gravity || sim.has_levitation || sim.flip_gravity) on++;
		if (sim.has_silver_crown) break;
	}
	rows.push({ name: k.name, fxTiles, ticks: n, fxTicks: on, share: +(on / Math.max(1, n)).toFixed(3) });
}
rows.sort((a, b) => b.share - a.share);
if (json) console.log(JSON.stringify(rows));
else {
	for (const r of rows) console.log(`${String(r.share.toFixed(3)).padStart(6)}  ${String(r.fxTicks).padStart(6)} / ${String(r.ticks).padStart(6)}  fx tiles ${String(r.fxTiles).padStart(4)}  ${r.name}`);
	const b = [0, 0, 0, 0];
	for (const r of rows) b[r.share < 0.1 ? 0 : r.share < 0.5 ? 1 : r.share < 0.9 ? 2 : 3]++;
	console.log(`levels with effect tiles and a known route: ${rows.length}; effect on for <10% of the route: ${b[0]}, 10-50%: ${b[1]}, 50-90%: ${b[2]}, >=90%: ${b[3]}`);
}
