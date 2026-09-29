'use strict';
// test/plantypes.js: the planner's shared contract (src/plan/types.js): masks text, playTo, the waypoint goal test with
// an Expect, levelNow (doors as they stand), the goal field's proof, pickDiverse. usage: node test/plantypes.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const RF = require('../src/reach.js');
const T = require('../src/plan/types.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
// # wall, S spawn, k red key, d red key door, W a walled pocket with a coin c
const rows = [
	'####################',
	'#..................#',
	'#..........###.....#',
	'#..........#c#.....#',
	'#S....k....###..d..#',
	'####################',
];
const ID = { '#': [9], S: [255], k: [6], d: [23], c: [100] };
const cells = [];
rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
const W = L.width, at = (x, y) => y * W + x;
const RM = GX.roomOf(L);

const m = Uint8Array.from([0, 4, 4, 5, 1, 2, 31, 16]);
check('strOf / masksOf round trip', T.strOf(T.masksOf(T.strOf(m))) === T.strOf(m) && T.masksOf(T.strOf(m)).every((v, i) => v === (m[i] & 31)), T.strOf(m));

// walk right to the key: hold right until the goal test holds
const wpKey = { kind: 'trigger', tiles: [at(6, 4)], trig: 0, expect: { feat: 'key0', value: 1 }, label: 'red key' };
const gk = T.goalOf(L, wpKey);
const run = new Uint8Array(200).fill(4);
const r = T.playTo(L, run, { goal: gk });
check('playTo + goalOf: holding right touches the red key (the Expect key0 = 1 holds there)', r.goalAt > 0 && r.dead < 0, `goalAt ${r.goalAt}`);
const pre = run.subarray(0, r.goalAt);
const r2 = T.playTo(L, pre);
check('the prefix up to goalAt ends with the goal test true', gk.test(r2.sim) && T.featValue(r2.sim, 'key0') === 1);
const a = T.arrivalOf(L, r2.sim, pre, RM);
check('arrivalOf: tile, room desc, hash', a.tile === at(6, 4) && /key:red/.test(a.desc) && a.tick === pre.length, `${a.desc} tick ${a.tick}`);

// levelNow: the key door shut at the start (-> 9), kept a door while the key is active
const s0 = T.playTo(L, new Uint8Array(0)).sim;
const L0 = T.levelNow(L, s0), L1 = T.levelNow(L, r2.sim);
check('levelNow: the red key door is a plain solid while no red key is active', L0.fg[at(16, 4)] === 9 && L.fg[at(16, 4)] === 23);
check('levelNow: an active key keeps its door block (it runs out)', L1.fg[at(16, 4)] === 23);

// the goal field: the key reachable from the start; the walled coin a proof (-1)
const fk = T.goalField(L0, [at(6, 4)]);
const ck = RF.costAt(fk, s0);
check('goalField: the key is at a finite cost from the start', ck > 0 && ck < 20, ck);
const fc = T.goalField(L0, [at(12, 3)]);
check('goalField: the walled coin is cut off (a proof)', RF.costAt(fc, s0) === -1, RF.costAt(fc, s0));
const fk2 = T.goalField(L0, [at(6, 4)]);
check('goalField: memoized (the same object for the same copy and goals)', fk2 === fk);

// pickDiverse: the earliest, the fastest, one per class, no duplicate states
const list = [];
for (const n of [10, 20, 30]) { const p = new Uint8Array(n).fill(4); const q = T.playTo(L, p); list.push(T.arrivalOf(L, q.sim, p, RM)); }
list.push(list[0]);
const d = T.pickDiverse(list, 4);
check('pickDiverse: the earliest first, the fastest second, no duplicate', d[0].tick === 10 && d[1].tick === 30 && new Set(d.map((x) => x.hash)).size === d.length, d.map((x) => x.tick).join(','));

// a death step: a checkpoint, then a spike; the waypoint is the checkpoint tile with deaths = 1 (allowDeath)
const rows2 = [
	'############',
	'#..........#',
	'#S..C...x..#',
	'############',
];
const ID2 = { '#': [9], S: [255], C: [360], x: [361, 1] };
const cells2 = [];
rows2.forEach((r2, y) => [...r2].forEach((ch, x) => { if (ch !== '.') cells2.push([x, y, ...ID2[ch]]); }));
const L2 = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'd', width: rows2[0].length, height: rows2.length, cells: cells2 }))));
const gd = T.goalOf(L2, { kind: 'region', tiles: [2 * L2.width + 4], expect: { feat: 'deaths', value: 1 }, allowDeath: true, label: 'die, back at the checkpoint' });
const runD = new Uint8Array(260).map((v, i) => (i < 60 ? 4 : 0));
const noD = T.playTo(L2, runD, { goal: gd });
const withD = T.playTo(L2, runD, { goal: gd, allowDeath: gd.allowDeath });
check('a death step: without allowDeath the replay stops at the death; with it the respawn at the checkpoint meets deaths = 1',
	gd.allowDeath && noD.goalAt < 0 && noD.dead > 0 && withD.dead > 0 && withD.goalAt > withD.dead, `dead ${withD.dead}, goalAt ${withD.goalAt}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
