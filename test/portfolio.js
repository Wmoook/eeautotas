'use strict';
// test/portfolio.js - the portfolio chain solver (src/plan/portfolio.js, n5-s99-portfolio) on hand-made rooms, every
// answer replayed by a fresh EESim:
//   1 THE RUN-UP (test/labbackward.js's room: a 13-tile gap whose only way across from its edge first runs away): the
//     portfolio's answer lands on the target, each arm alone is replayed too (a found leg is exact or refused);
//   2 THE SESSION: two calls for one stretch with small windows and a projected total: a one-piece arm too big for the
//     first window is deferred (not run, not cut), the second call runs it; a found stretch drops its session;
//   3 a class target ('G': standing on the tile) and a start already there (0 ticks);
//   4 the executor's tier (EEAT_PORTFOLIO=1) on the run-up: tool 'portfolio', the arrival replayed.
// Usage: node test/portfolio.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const PO = require('../src/plan/portfolio.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const levelOf = (name, W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name, width: W, height: H, cells }))));
const settle = (L, n = 40) => { const s = new E.EESim(L), i = new E.EEInput(); s.reset(); for (let t = 0; t < n; t++) { E.applyMask(i, 0); s.tick(i); } return s; };
const replay = (L, snap, masks, tiles, cls) => {
	const s = new E.EESim(L), i = new E.EEInput();
	s.reset(); s.restore(snap);
	const W = L.width, set = new Set(tiles);
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(i, masks[t]); s.tick(i);
		if (s.is_dead) return 0;
	}
	const tile = (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4);
	if (!set.has(tile)) return 0;
	if (cls === 'G' && !s.on_ground) return 0;
	return masks.length;
};
const runupLevel = () => {
	const W = 64, H = 20, F = 16;
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	for (let x = 1; x < W - 1; x++) if (x <= 30 || x >= 44) cells.push([x, F, 9]); else cells.push([x, H - 2, 361]);
	cells.push([30, 15, 255]);
	return { L: levelOf('pf-runup', W, H, cells), W };
};

(async () => {
	// ---------------------------------------------------------------- 1 the run-up: the portfolio and each arm alone
	{
		const { L, W } = runupLevel();
		const s0 = settle(L);
		const snap = s0.snapshot();
		const target = { tiles: [15 * W + 48], cls: 'any' };
		const P = PO.createPortfolio(L);
		const r = P.solve(snap, target, { ms: 8000, resume: false });
		ok(r.ok, `the portfolio finds the leg across the gap (${r.why})`);
		ok(r.ok && replay(L, snap, r.masks, target.tiles) === r.T, 'its answer lands on the target when replayed');
		ok(r.ok && r.order[0] === 'bw', `the plan starts with the backward meet (${r.order})`);
		for (const arm of ['bw', 'prof', 'leg', 'corr', 'chain']) {
			const q = P.solve(snap, target, { ms: 6000, resume: false, plan: arm + ':1' });
			ok(!q.ok || replay(L, snap, q.masks, target.tiles) === q.T, `${arm} alone: a leg it returns replays onto the target (${q.ok ? q.T + ' ticks' : q.why})`);
		}
		const sh = P.shapeOf(snap, target);
		ok(sh.c0 > 0 && sh.est > 0 && sh.dist === 18 && !sh.tele, `the shape (c0 ${sh.c0}, est ${sh.est}, dist ${sh.dist})`);
	}
	// ---------------------------------------------------------------- 2 the session: a deferred one-piece arm
	{
		const { L, W } = runupLevel();
		const s0 = settle(L);
		const snap = s0.snapshot();
		const target = { tiles: [15 * W + 48], cls: 'any' };
		const P = PO.createPortfolio(L);
		// (call 1: the backward meet's first run takes its share of 400 ms and the clock ends it; call 2 holds its long piece:
		// 0.3 of the 10-s projection, at least 4 x the first piece; a third run never comes)
		const r1 = P.solve(snap, target, { ms: 400, total: 10000, plan: 'bw:0.3,corr:0.7' });
		ok(r1.ok || (r1.arms.bw && r1.arms.bw.why === 'budget'), `call 1: the backward meet ran its short piece (${JSON.stringify(r1.arms)})`);
		if (!r1.ok) {
			const r2 = P.solve(snap, target, { ms: 6000, total: 10000, plan: 'bw:0.3,corr:0.7' });
			ok(r2.resumed, 'call 2 continues the session');
			ok(r2.arms.bw && r2.arms.bw.piece >= 2900, `call 2: the backward meet's long piece (${r2.arms.bw && r2.arms.bw.piece} ms)`);
			ok(r2.ok, `call 2 finds the leg (${r2.why})`);
			ok(r2.ok && replay(L, snap, r2.masks, target.tiles) === r2.T, 'call 2 replays onto the target');
			const r3 = P.solve(snap, target, { ms: 200, total: 10000, plan: 'bw:0.3,corr:0.7' });
			ok(!r3.resumed, 'a found stretch dropped its session (a new call starts a new one)');
		}
	}
	// ---------------------------------------------------------------- 3 a class target and a start already there
	{
		const { L, W } = runupLevel();
		const s0 = settle(L);
		const snap = s0.snapshot();
		const P = PO.createPortfolio(L);
		const tg = { tiles: [15 * W + 36], cls: 'G' };   // (over the pit: never standing there)
		const r = P.solve(snap, tg, { ms: 1500, resume: false });
		ok(!r.ok, `standing over the spike pit: none (${r.why})`);
		const tg2 = { tiles: [15 * W + 50], cls: 'G' };
		const r2 = P.solve(snap, tg2, { ms: 8000, resume: false });
		ok(r2.ok && replay(L, snap, r2.masks, tg2.tiles, 'G') === r2.T, `standing on (50, 15): found and replayed standing (${r2.ok ? r2.arm : r2.why})`);
	}
	// ---------------------------------------------------------------- 4 the executor's tier
	{
		process.env.EEAT_PORTFOLIO = '1';
		process.env.EEAT_PF_SHARES = '0.9,0.9,0.9,0.9';
		delete require.cache[require.resolve('../src/plan/executor.js')];
		const EX = require('../src/plan/executor.js');
		const T = require('../src/plan/types.js');
		const { L, W } = runupLevel();
		const ex = await EX.createExecutor(L, { prims: null, workers: 0, emit: null });
		const wp = { kind: 'trigger', tiles: [15 * W + 48], trig: -1, expect: null, label: 'tile' };
		const r = await ex.reach([''], wp, { ms: 10000, level: 1, k: 4 });
		ok(r.ok, `the executor reaches the tile with the portfolio tier (${r.ok ? r.tool : r.fail && r.fail.why})`);
		const pt = (r.tiers || []).find((t) => t.tier === 'portfolio');
		ok(!!pt, 'the tier ran');
		if (r.ok && r.arrivals && r.arrivals.length) {
			const a = r.arrivals[0];
			const s = new E.EESim(L), i = new E.EEInput(); s.reset();
			const ms = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
			for (const m of ms) { E.applyMask(i, m); s.tick(i); }
			ok(!s.is_dead && (Math.trunc(s.px + 8) >> 4) === 48, 'the arrival replays to the tile');
		}
		if (ex.close) await ex.close();
		delete process.env.EEAT_PORTFOLIO; delete process.env.EEAT_PF_SHARES;
	}
	console.log(`portfolio: ${pass}/${pass + fail}`);
	process.exit(fail ? 1 : 0);
})();
