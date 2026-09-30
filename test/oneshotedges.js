'use strict';
// test/oneshotedges.js - the one-shot move graph's edges (src/plan/oneshot/edges.js) on a hand-made room:
//   1 every edge's input string, replayed by a fresh engine from its source support's representative, ends in the
//     edge's (tile, class) with the edge's exact end state after exactly T ticks (a death edge: alive again at the
//     respawn); landings and hops end grounded; the room's spike pit gives death edges, its coin a touch;
//   2 the parallel build (worker threads) = the build in one thread, edge for edge (deterministic);
//   3 the cache per level md5: the second build is read back, the same graph;
//   4 applyEdge from the representative = T; indexGraph's adjacency.
// Usage: node test/oneshotedges.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const OE = require('../src/plan/oneshot/edges.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// a room: a floor at row 14, a 3-wide pit with spikes at its bottom (cols 12-14), a step up (cols 20-23), a coin on the
// step, a checkpoint by the spawn, a small water pool (cols 26-29) and a dot patch in the air (cols 5-6, rows 9-10)
const W = 34, H = 18, F = 14;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if (x < 12 || x > 14) cells.push([x, F, 9]);
for (let x = 12; x <= 14; x++) cells.push([x, F + 2, 361]);
for (let x = 20; x <= 23; x++) cells.push([x, F - 1, 9]);
cells.push([21, F - 2, 100]);
cells.push([3, F - 1, 360]);
for (let x = 26; x <= 29; x++) cells.push([x, F - 1, 119]);
for (let x = 5; x <= 6; x++) for (let y = 9; y <= 10; y++) cells.push([x, y, 4]);
cells.push([2, F - 1, 255]);
const bytes = ED.eelvlOf({ name: 'oneshotedges', width: W, height: H, cells });
const file = path.join(os.tmpdir(), `oneshotedges_${process.pid}.eelvl`);
fs.writeFileSync(file, bytes);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(bytes)));
const OPT = { rounds: 0, landNodes: 20000, land2Nodes: 20000 };

(async () => {
	const g = OE.buildLocal(L, OPT);
	ok(g.sups.length > 20 && g.edges.length > 100, `a graph (${g.sups.length} supports, ${g.edges.length} edges)`);
	const ctx = OE.ctxOf(L, OPT);
	ctx.sups = g.sups;
	const sim = new E.EESim(L), inp = new E.EEInput();
	let bad = 0, deaths = 0, lands = 0, landBad = 0, touches = 0, coinTouched = false;
	const coinTile = (F - 2) * W + 21;
	for (const e of g.edges) {
		const snap = OE.supportState(ctx, e.f);
		sim.restore(snap);
		const ms = OE.masksOf(e.m);
		for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
		if (ms.length !== e.T) bad++;
		if (e.cls === 'R') { deaths++; if (sim.is_dead) bad++; }
		else {
			if (OE.tileOf(sim, W, H) !== e.tile || (e.cls !== 'P' && OE.clsOf(sim, sim._flags) !== e.cls)) bad++;
			if (sim.px !== e.end[0] || sim.py !== e.end[1] || sim.speed_x !== e.end[2] || sim.speed_y !== e.end[3]) bad++;
		}
		if (e.k === 'land' || e.k === 'hop' || e.k === 'land2') { lands++; if (e.cls !== 'G') landBad++; }
		if (e.k === 'touch') touches++;
		if (e.tr.length) for (const k of e.tr) if (ctx.triggers[k] && ctx.triggers[k].tiles.includes(coinTile)) coinTouched = true;
	}
	ok(bad === 0, `every edge replays to its end (tile, class, exact state) in T ticks (${bad} bad of ${g.edges.length})`);
	ok(lands > 0 && landBad === 0, `landings and hops end grounded (${lands}, ${landBad} not)`);
	ok(deaths > 0, `the spike pit gives death edges (${deaths})`);
	ok(coinTouched, `the coin is touched by some edge (touch edges ${touches})`);
	ok(g.sups.some((u) => u.cls === 'W') && g.sups.some((u) => u.cls === 'Z'), 'the water and dot entries are supports');
	ok(g.stats.p1 && g.stats.p1.edges > 0, `edges classified by part 1 (${g.stats.p1 && g.stats.p1.edges})`);
	// 4: applyEdge from the representative, indexGraph
	let applied = 0, appliedOk = 0;
	for (const e of g.edges.slice(0, 200)) {
		if (e.cls === 'R') continue;
		sim.restore(OE.supportState(ctx, e.f));
		applied++;
		if (OE.applyEdge(sim, e, W, H) > 0) appliedOk++;
	}
	ok(applied > 0 && appliedOk === applied, `applyEdge from the representative arrives (${appliedOk} of ${applied})`);
	const ix = OE.indexGraph(g);
	ok(ix.out.length === g.sups.length && ix.out.reduce((a, l) => a + l.length, 0) === g.edges.length, 'indexGraph: every edge out of its support');
	// 2: parallel = local (the file: the same level)
	const gl = OE.buildLocal(file, OPT);
	const gp = await OE.buildGraph(file, Object.assign({ threads: 3 }, OPT));
	const key = (x) => JSON.stringify(x.edges.map((e) => [e.f, e.k, e.tile, e.cls, e.T, e.m, e.end, e.to]));
	ok(gp.edges.length === gl.edges.length && key(gp) === key(gl), `the parallel build = the local build (${gp.edges.length} / ${gl.edges.length} edges)`);
	ok(gp.sups.length === gl.sups.length, 'the same supports');
	// 3: the cache
	const dir = path.join(os.tmpdir(), `oneshotedges_cache_${process.pid}`);
	const g1 = await OE.buildGraph(file, Object.assign({ threads: 2, cache: dir }, OPT));
	const g2 = await OE.buildGraph(file, Object.assign({ threads: 2, cache: dir }, OPT));
	ok(!g1.stats.cached && g2.stats.cached && key(g1) === key(g2), 'the cache per level md5 reads the graph back');
	const g3 = await OE.buildGraph(file, Object.assign({ threads: 2, cache: dir, landT: 40 }, OPT));
	ok(!g3.stats.cached, 'other options: another cache entry');
	try { fs.rmSync(dir, { recursive: true, force: true }); fs.unlinkSync(file); } catch (e) { /* temp */ }
	console.log(`oneshotedges: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
