'use strict';
// test/labbackward.js - the lab's backward solver (src/plan/lab/backward.js, n5-lab-backward) on hand-made rooms, every
// answer replayed by a fresh EESim:
//   1 THE RUN-UP: a 13-tile gap whose only way across from a start at its edge first runs AWAY from it (the momentum a
//     standing jump lacks): found by the meet alone and with the closure (the values: the start's cell has a finite D),
//     the leg replayed onto the target, its lowest x left of the start;
//   2 THE ARROW SHAFT: a 1-wide shaft of up arrows (the gravity queue in the cell key: a ball that just entered an arrow
//     is not its parent's cell), the fall to its floor found;
//   3 A DEAD START (the dead ticks one move, the replay through them) and a start already at the target (0 ticks);
//   4 the executor's tier (EEAT_BACKWARD=1) on the run-up: tool 'backward', the arrival replayed.
// Usage: node test/labbackward.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const BW = require('../src/plan/lab/backward.js');

let pass = 0, fail = 0;
let tierCheck = null;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const levelOf = (name, W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name, width: W, height: H, cells }))));
const settle = (L, n = 40) => { const s = new E.EESim(L), i = new E.EEInput(); s.reset(); for (let t = 0; t < n; t++) { E.applyMask(i, 0); s.tick(i); } return s; };
const replay = (L, snap, masks, tiles) => {
	const s = new E.EESim(L), i = new E.EEInput();
	s.reset(); s.restore(snap);
	const W = L.width, set = new Set(tiles);
	let hit = 0, minX = Infinity, alive = !s.is_dead;
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(i, masks[t]); s.tick(i);
		if (s.is_dead) { if (alive) return { hit: 0, minX }; continue; }
		alive = true;
		if (s.px < minX) minX = s.px;
		if (set.has((Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4))) { hit = t + 1; break; }
	}
	return { hit, minX };
};

// ---------------------------------------------------------------- 1 the run-up
{
	const W = 64, H = 20, F = 16;
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	for (let x = 1; x < W - 1; x++) if (x <= 30 || x >= 44) cells.push([x, F, 9]); else cells.push([x, H - 2, 361]);   // the gap: cols 31-43 (13 tiles), spikes under it
	cells.push([30, 15, 255]);                                                      // the spawn at the gap's edge
	const L = levelOf('bw-runup', W, H, cells);
	const s0 = settle(L);
	ok(s0.on_ground && Math.trunc(s0.px + 8) >> 4 === 30, 'the ball stands at the gap\'s edge');
	const target = { tiles: [15 * W + 48] };
	const B = BW.createBackward(L);
	const x0 = s0.px;
	for (const [name, o] of [['the meet alone', { ms: 8000, closeF: 0, quickF: 1, quick: 400000 }], ['the closure + the meet', { ms: 12000, quick: 1 }]]) {
		const r = B.solve(s0.snapshot(), target, o);
		ok(r.ok, `${name}: the leg across the gap is found (${r.why})`);
		if (!r.ok) continue;
		const rp = replay(L, s0.snapshot(), r.masks, target.tiles);
		ok(rp.hit === r.T, `${name}: replayed onto the target at its last tick (${rp.hit} vs ${r.T})`);
		ok(rp.minX < x0 - 8, `${name}: the leg runs away from the gap first (lowest x ${rp.minX.toFixed(1)} < ${x0} - 8)`);
		if (name.includes('closure')) ok(r.stats.dStart !== null && r.stats.finite > 0, `the values: the start's cell has D ${r.stats.dStart} (${r.stats.finite} cells with a value)`);
	}
	// 4 the executor's tier (EEAT_BACKWARD=1): the run-up waypoint from the edge (run at the end: async)
	tierCheck = async () => {
		process.env.EEAT_BACKWARD = '1';
		const T = require('../src/plan/types.js');
		const EX = require('../src/plan/executor.js'), BM = require('../src/plan/bounds.js'), PM = require('../src/plan/prims.js');
		const bounds = BM.createBounds(L, {});
		const prims = await PM.createPrims(L, { file: null, bounds, model: null, workers: 0 });
		const ex = await EX.createExecutor(L, { file: null, prims, bounds, workers: 0, emit: null });
		const pre = new Uint8Array(40);
		const res = await ex.reach([T.strOf(pre)], { kind: 'region', tiles: target.tiles.slice(), label: 'the far floor' }, { ms: 15000, level: 2, k: 4 });
		const bt = (res.tiers || []).find((x) => x.tier === 'backward');
		ok(res.ok, 'the executor reaches the far floor (' + (res.ok ? res.tool : res.fail && res.fail.why) + ')');
		ok(!!bt && bt.ok, 'its backward tier found the leg (' + JSON.stringify(bt || null).slice(0, 120) + ')');
		delete process.env.EEAT_BACKWARD;
		if (ex.close) await ex.close();
	};
}

// ---------------------------------------------------------------- 2 the arrow shaft
{
	const W = 9, H = 40;
	const cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x !== 4 || y === 0 || y >= H - 2) cells.push([x, y, 9]);
	for (let y = 4; y < 34; y += 3) cells.push([4, y, 2]);                          // up arrows every 3rd row
	cells.push([4, 1, 255]);
	const L = levelOf('bw-shaft', W, H, cells);
	const s = new E.EESim(L); s.reset();
	const target = { tiles: [(H - 3) * W + 4] };
	const B = BW.createBackward(L);
	const r = B.solve(s.snapshot(), target, { ms: 5000, closeF: 0, quickF: 1, quick: 100000 });
	ok(r.ok, `the arrow shaft's floor is found (${r.why}, ${r.stats.meetExpanded} expansions)`);
	if (r.ok) ok(replay(L, s.snapshot(), r.masks, target.tiles).hit === r.T, 'the shaft leg replayed');
}

// ---------------------------------------------------------------- 3 a dead start; a start at the target
{
	const W = 40, H = 12, F = 9;
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); cells.push([x, F, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	cells.push([3, F - 1, 255]);
	cells.push([6, F - 1, 361]);                                                    // spikes 3 tiles right of the spawn
	const L = levelOf('bw-dead', W, H, cells);
	const s = settle(L);
	const i = new E.EEInput();
	let t = 0;
	while (!s.is_dead && t < 200) { E.applyMask(i, 4); s.tick(i); t++; }
	ok(s.is_dead, `the ball runs into the spikes and dies (${t} ticks)`);
	const target = { tiles: [(F - 1) * W + 2] };
	const B = BW.createBackward(L);
	const r = B.solve(s.snapshot(), target, { ms: 5000 });
	ok(r.ok, `from the dead state: the respawn, then the target (${r.why})`);
	if (r.ok) ok(replay(L, s.snapshot(), r.masks, target.tiles).hit === r.T, 'the dead start\'s leg replayed through its dead ticks');
	const s2 = settle(L);
	const here = { tiles: [(Math.trunc(s2.py + 8) >> 4) * W + (Math.trunc(s2.px + 8) >> 4)] };
	const r2 = B.solve(s2.snapshot(), here, { ms: 1000 });
	ok(r2.ok && r2.T === 0, 'a start already at the target: 0 ticks');
}

(async () => {
	if (tierCheck) { try { await tierCheck(); } catch (e) { ok(false, 'the executor tier: ' + (e && e.stack || e)); } }
	console.log(`labbackward: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
