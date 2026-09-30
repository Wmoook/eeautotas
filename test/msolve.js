'use strict';
// test/msolve.js - the move solver (src/plan/msolve.js) against the engine:
//   1 legs on a hand-made room (a walk, a gap, a step up, a ceiling that bonks the jump), every answer and its landing
//     hop replayed by a fresh EESim onto the target tile with the class asked;
//   2 THE BOUND'S ENGINE CHECK: random input sequences (sticky, with jump presses anywhere: each one a real input word)
//     record the least tick the ball stands on each tile; the certified lower bound must never exceed it (one sample
//     below the bound would be a counterexample) and a PROVEN leg (the plain certificate or the event-graph bound of
//     src/math/lb.js) must never be beaten by any sample;
//   3 the forward fan-out (every landing replayed) and a chain (A* over support states) across the gap and the step.
// Usage: node test/msolve.js [--samples=40000] [--quick]
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const MS = require('../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// a room with a floor at row 16, a 3-tile gap (cols 20-22), a step up (cols 28-31 one tile higher), a low ceiling
// (cols 8-10, row 13) and a spawn at (3, 15)
const W = 44, H = 20, F = 16;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if (x < 20 || x > 22) cells.push([x, F, 9]);
for (let x = 28; x <= 31; x++) cells.push([x, F - 1, 9]);
for (let x = 8; x <= 10; x++) cells.push([x, 13, 9]);
cells.push([3, 15, 255]);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'msolve', width: W, height: H, cells }))));
const sim0 = new E.EESim(L), inp0 = new E.EEInput();
sim0.reset();
for (let t = 0; t < 40; t++) { E.applyMask(inp0, 0); sim0.tick(inp0); }
ok(sim0.on_ground && sim0.speed_y === 0, 'the ball stands at the spawn');
/** a standing start at column c (x = 16 c + dx), speed vx: walk there from the spawn is not needed, the state is set */
function startAt(c, dx, vx) {
	const s = new E.EESim(L);
	s.restore(sim0.snapshot());
	s.px = 16 * c + dx; s.speed_x = vx;
	const inp = new E.EEInput();
	E.applyMask(inp, 0); s.tick(inp);        // one tick: the engine's own grounded / queue state at that place
	return s.snapshot();
}
const S = MS.createSolver(L, {});
const chk = new E.EESim(L), cinp = new E.EEInput();
chk.reset();
const tileAt = (s) => (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4);
const replayCheck = (snap, masks, tile, cls) => {
	chk.restore(snap);
	for (let t = 0; t < masks.length; t++) { E.applyMask(cinp, masks[t]); chk.tick(cinp); if (chk.is_dead) return false; }
	return tileAt(chk) === tile && MS.clsOf(chk, chk._flags) === cls;
};

// ---------------------------------------------------------------- 1 legs
const starts = [['the spawn', sim0.snapshot()], ['col 14 at 3 px/tick', startAt(14, 3, 3)], ['col 6 at rest', startAt(6, 0, 0)]];
const targets = [[12, 15, 'a walk'], [25, 15, 'over the gap'], [29, 14, 'up the step'], [9, 15, 'under the ceiling'], [36, 15, 'past the step']];
let legsOk = 0, legsN = 0;
for (const [sname, snap] of starts) {
	for (const [tx, ty, what] of targets) {
		const tile = ty * W + tx;
		const r = S.leg(snap, { tiles: [tile], cls: 'G' }, { Tmax: 110 });
		legsN++;
		if (!r.ok) { console.log(`  from ${sname} to ${what}: not solved (${r.why})`); continue; }
		legsOk++;
		ok(replayCheck(snap, r.masks, tile, 'G'), `from ${sname} to ${what}: the answer replays onto the tile, class G`);
		ok(!r.cert || r.lb <= r.T, `from ${sname} to ${what}: certified lb ${r.lb} <= T ${r.T}`);
		if (r.hop) ok(replayCheck(snap, r.hop, tile, 'G'), `from ${sname} to ${what}: its landing hop replays onto the tile too`);
		console.log(`  from ${sname} to ${what}: T ${r.T} lb ${r.lb} cert ${r.cert} proven ${r.proven} ${r.tool} ${r.member || ''} ${Math.round(r.us)} us`);
	}
}
ok(legsOk >= legsN - 3, `legs solved ${legsOk} / ${legsN}`);

// ---------------------------------------------------------------- 2 THE BOUND'S ENGINE CHECK (random input words)
function boundCheck(Lx, Sx, startsX, name) {
	const N = +(argv.samples || (argv.quick ? 12000 : 40000)), T = 90;
	let seed = 12345;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	const MASKS = [0, 2, 4];
	const sim = new E.EESim(Lx), inp = new E.EEInput();
	const first = startsX.map(() => new Map());
	for (let si = 0; si < startsX.length; si++) {
		const snap = startsX[si][1];
		for (let n = 0; n < N; n++) {
			sim.restore(snap);
			let m = MASKS[(rnd() * 3) | 0];
			const keep = 0.8 + 0.19 * rnd();
			for (let t = 1; t <= T; t++) {
				if (rnd() > keep) m = MASKS[(rnd() * 3) | 0];
				E.applyMask(inp, m | (rnd() < 0.08 ? 1 : 0)); sim.tick(inp);
				if (sim.is_dead) break;
				if (sim.on_ground) { const k = tileAt(sim); const f = first[si].get(k); if (f === undefined || t < f) first[si].set(k, t); }
			}
		}
	}
	let checked = 0, bad = 0, provenN = 0, certN = 0;
	for (let si = 0; si < startsX.length; si++) {
		for (const [tile, tmin] of first[si]) {
			const r = Sx.leg(startsX[si][1], { tiles: [tile], cls: 'G' }, { Tmax: T, coupled: false, fields: false, prove: true });
			checked++;
			if (r.cert) { certN++; if (r.lb > tmin) { bad++; console.log(`  BOUND ${r.lb} > a sample's ${tmin} (start ${si}, tile ${tile % W},${(tile / W) | 0})`); } }
			if (r.proven) { provenN++; if (r.T > tmin) { bad++; console.log(`  PROVEN ${r.T} beaten by a sample's ${tmin} (start ${si}, tile ${tile % W},${(tile / W) | 0})`); } }
		}
	}
	ok(bad === 0, `${name}: no sample below a certified bound or a proven leg (${checked} (start, tile) pairs, ${certN} certified, ${provenN} proven, ${N} words of ${T} ticks a start)`);
	console.log(`  bound check (${name}): ${checked} pairs, certified ${certN}, proven ${provenN}, violations ${bad}`);
	return { checked, certN, provenN, bad };
}
boundCheck(L, S, starts, 'the room');
// the certificate's TILE TEST: the same room with boosts (16 px/tick: faster than any plain move) and a dot field in
// the plain extremes' rectangle; a boost the ball can reach before the bound voids it, one it cannot does not, and no
// random word may beat a certified bound
{
	const cells2 = cells.slice();
	cells2.push([13, 15, 116], [33, 15, 114], [17, 15, 115], [24, 11, 4], [25, 11, 4]);
	const L2 = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'msolve2', width: W, height: H, cells: cells2 }))));
	const s2 = new E.EESim(L2), i2 = new E.EEInput();
	s2.reset();
	for (let t = 0; t < 40; t++) { E.applyMask(i2, 0); s2.tick(i2); }
	const at = (c, dx, vx) => { const s = new E.EESim(L2); s.restore(s2.snapshot()); s.px = 16 * c + dx; s.speed_x = vx; const q = new E.EEInput(); E.applyMask(q, 0); s.tick(q); return s.snapshot(); };
	const starts2 = [['the spawn', s2.snapshot()], ['col 6 at rest', at(6, 0, 0)], ['col 28 at rest', at(29, 0, 0)]];
	const S2 = MS.createSolver(L2, {});
	const S2t = MS.createSolver(L2, { certSpeed: false });
	const S2r = MS.createSolver(L2, { certTiles: false });
	const a = boundCheck(L2, S2, starts2, 'boosts, the tile test + the speed limit');
	const c = boundCheck(L2, S2t, starts2, 'boosts, the tile test');
	const b = boundCheck(L2, S2r, starts2, 'boosts, the rectangle alone');
	ok(a.certN >= c.certN && c.certN >= b.certN, `each refinement certifies at least what the one before does (${a.certN} >= ${c.certN} >= ${b.certN})`);
}

// ---------------------------------------------------------------- 3 the fan-out and a chain
{
	const snap = starts[1][1];
	const lands = S.landings(snap, { Tmax: 60 });
	ok(lands.length >= 5, `the fan-out lands on >= 5 tiles (${lands.length})`);
	let good = 0;
	for (const e of lands) if (replayCheck(snap, e.masks, e.tile, 'G')) good++;
	ok(good === lands.length, `every fan-out landing replays onto its tile (${good} / ${lands.length})`);
	const target = 15 * W + 38;
	const r = S.chain(starts[0][1], { tiles: [target], cls: 'G' }, { ms: 5000 });
	ok(r.ok, `chain from the spawn to (38, 15) found (${r.expanded} expanded, ${r.legs} legs, ${r.ms} ms)`);
	if (r.ok) ok(replayCheck(starts[0][1], r.masks, target, 'G'), 'the chain replays onto its target');
	console.log(`  chain: T ${r.T} closed ${r.closed} expanded ${r.expanded} legs ${r.legs} nodes ${r.nodes} ${r.ms} ms`);
}

console.log(`msolve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
