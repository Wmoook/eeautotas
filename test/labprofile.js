'use strict';
// test/labprofile.js - the lab's profile solver (src/plan/lab/profile.js, n5-lab-profile) on hand-made rooms: every arrival
// it returns is replayed by a fresh EESim onto the goal, the passes and the finish work, the knob-free default is the
// family alone where no field exists.
// Usage: node test/labprofile.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const PF = require('../src/plan/lab/profile.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// a course: floor at row 20 with two gaps (cols 18-20, 40-43), a step up (cols 26-30, two rows), a wall to jump over (col
// 34, rows 17-19), a low ceiling (cols 50-54, row 17), a goal tile (the coin's tile) at (60, 19)
const W = 64, H = 24, F = 20;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if ((x < 18 || x > 20) && (x < 40 || x > 43)) cells.push([x, F, 9]);
for (let x = 26; x <= 30; x++) { cells.push([x, F - 1, 9]); cells.push([x, F - 2, 9]); }
for (let y = 17; y <= 19; y++) cells.push([34, y, 9]);
for (let x = 50; x <= 54; x++) cells.push([x, 17, 9]);
cells.push([3, F - 1, 255]);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'labprofile', width: W, height: H, cells }))));
const sim0 = new E.EESim(L), inp0 = new E.EEInput();
sim0.reset();
for (let t = 0; t < 30; t++) { E.applyMask(inp0, 0); sim0.tick(inp0); }
ok(sim0.on_ground, 'the ball stands at the spawn');
const goalTile = (F - 1) * W + 60;
const goal = T.goalOf(L, { kind: 'trigger', tiles: [goalTile] });
const replayTo = (snap, masks) => {
	const s = new E.EESim(L), inp = new E.EEInput();
	s.restore(snap);
	let hit = -1;
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); s.tick(inp); if (s.is_dead) return -2; if (hit < 0 && goal.test(s)) hit = t + 1; }
	return hit;
};

// 1 the course from the spawn
const snap0 = sim0.snapshot();
const r = PF.profileLeg(L, [{ snap: snap0, tick: 30 }], goal, { ms: 8000, collect: 6, extra: 2 });
ok(r.ok, `the course is found (${r.why}, ${r.layers} layers, ${r.ms} ms)`);
if (r.ok) {
	ok(replayTo(snap0, r.masks) === r.masks.length, `its answer replays onto the goal at its last tick (${r.tick} ticks)`);
	ok(r.arrivals.length >= 1 && r.arrivals.every((a) => replayTo(snap0, a.masks) === a.masks.length), `every arrival (${r.arrivals.length}) replays onto the goal at its last tick`);
	ok(r.arrivals.every((a, i) => i === 0 || a.masks.length >= r.arrivals[i - 1].masks.length), 'the arrivals earliest first');
	// the 1D minimum time of x from the spawn to the goal's column (hold right from rest: THEOREM M) bounds every answer
	let x = sim0.px, v = 0, n = 0;
	while (x + 8 < 60 * 16 - 8 && n < 2000) { v = (v + 1 / 7.752) * 0.9813195279915707; x += v; n++; }
	ok(r.tick >= n, `the answer (${r.tick}) is no faster than the x axis' minimum time (${n})`);
	ok(r.tick <= 3 * n, `the answer (${r.tick}) is within 3x the x axis' minimum time (${n})`);
}
// 2 a start past the first gap, a second start later: the earliest start's tick is layer 0, the answer from either
const s1 = new E.EESim(L), i1 = new E.EEInput();
s1.restore(snap0);
for (let t = 0; t < 60; t++) { E.applyMask(i1, 4 | (t === 20 ? 1 : 0)); s1.tick(i1); }
const r2 = PF.profileLeg(L, [{ snap: snap0, tick: 30 }, { snap: s1.snapshot(), tick: 90 }], goal, { ms: 8000 });
ok(r2.ok, 'two starts: found');
if (r2.ok) ok(replayTo(r2.start === 0 ? snap0 : s1.snapshot(), r2.masks) === r2.masks.length, `two starts: the answer replays from its start ${r2.start}`);
// 3 the passes: one pass of a narrow front on the course still ends with an answer or a pass reason
const r3 = PF.profileLeg(L, [{ snap: snap0, tick: 30 }], goal, { ms: 4000, width: 8, quota: 1, passes: 3 });
ok(r3.pass >= 1 && r3.pass <= 3 && typeof r3.why === 'string', `narrow front: pass ${r3.pass}, ${r3.why}`);
if (r3.ok) ok(replayTo(snap0, r3.masks) === r3.masks.length, 'narrow front: its answer replays');
// 4 an unreachable goal (a tile inside the wall): no answer, no crash
const gBad = T.goalOf(L, { kind: 'trigger', tiles: [0 * W + 10] });   // (a tile of the top wall)
const r4 = PF.profileLeg(L, [{ snap: snap0, tick: 30 }], gBad, { ms: 1500 });
ok(!r4.ok, `an unreachable goal: no answer (${r4.why})`);
console.log(`labprofile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
