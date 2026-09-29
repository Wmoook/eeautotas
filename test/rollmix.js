'use strict';
// node test/rollmix.js: the roll mix's class choice (goexplore.js mixPick, mixCostOf): every class once in order, then
// each class the same share of the GPU TIME (times its weight), not of the simulated ticks; the cost of a batch from its
// kernel time, else its roll kernel's, else its wall. No GPU needed.
const GX = require('../src/goexplore.js');
let fails = 0, n = 0;
const ok = (c, what) => { n++; if (!c) { fails++; console.log(`FAIL ${what}`); } else console.log(`ok   ${what}`); };

// (a mix of 3 classes whose batches cost 1, 6 and 12 ms of GPU time, and 1.3 M, 3.9 M, 7.9 M simulated ticks)
const classes = [{ roll: 40, keep: 0.85, w: 1 }, { roll: 120, keep: 0.95, w: 1 }, { roll: 240, keep: 0.97, w: 1 }];
const cost = [1, 6, 12], tk = [1.3e6, 3.9e6, 7.9e6];
const st = classes.map(() => ({ batches: 0, ticks: 0, ms: 0 }));
const order = [];
for (let b = 0; b < 190; b++) {
	const j = GX.mixPick(st, classes);
	order.push(j);
	st[j].batches++; st[j].ms += cost[j]; st[j].ticks += tk[j];
}
ok(order[0] === 0 && order[1] === 1 && order[2] === 2, 'the first batch of every class in order');
const tot = st.reduce((s, q) => s + q.ms, 0);
ok(st.every((q) => Math.abs(q.ms / tot - 1 / 3) < 0.03), `the GPU time shared equally (${st.map((q) => (q.ms / tot).toFixed(3)).join(' / ')})`);
ok(st[0].batches > 5 * st[2].batches, `the cheap class gets the more batches (${st.map((q) => q.batches).join(' / ')})`);
ok(st[0].ticks > 1.5 * st[2].ticks, 'not the same share of the ticks: the class whose ticks cost less GPU time gets the more ticks');

// (weights: a class of weight 2 twice the GPU time of the others)
const cw = [{ roll: 40, keep: 0.85, w: 2 }, { roll: 120, keep: 0.95, w: 1 }];
const sw = cw.map(() => ({ batches: 0, ticks: 0, ms: 0 }));
for (let b = 0; b < 300; b++) { const j = GX.mixPick(sw, cw); sw[j].batches++; sw[j].ms += j ? 3 : 1; }
ok(Math.abs(sw[0].ms / sw[1].ms - 2) < 0.1, `weight 2: twice the GPU time (${sw[0].ms} vs ${sw[1].ms} ms)`);

// (one class: always it; ties go to the first)
ok(GX.mixPick([{ batches: 5, ms: 9 }], [classes[0]]) === 0, 'one class: always the first');
ok(GX.mixPick([{ batches: 1, ms: 4 }, { batches: 1, ms: 4 }], classes.slice(0, 2)) === 0, 'a tie: the first');

// (the cost of a batch)
ok(GX.mixCostOf({ kernelMs: 7.5, rollMs: 6, ms: 40 }) === 7.5, 'the cost: the kernels\' time');
ok(GX.mixCostOf({ rollMs: 6, ms: 40 }) === 6, 'no kernelMs: the roll kernel\'s time');
ok(GX.mixCostOf({ ms: 40 }) === 40, 'an older tool: the batch\'s wall');
ok(GX.mixCostOf({}) === 0 && GX.mixCostOf({ kernelMs: -1 }) === 0, 'no time: 0');

// (parseArgs keeps the mix the default)
const a = GX.parseArgs(['x.eelvl', '--gpu=1']);
ok(a.rollMix === '40:0.85,120:0.95,240:0.97', 'the default mix unchanged');
// (the editor's dry slices of the random runs (editor.js rollsDryAfter): judged per completed batch; n3-roll-launch-sizing)
const ED = require('../src/editor.js');
ok(ED.rollsDryAfter(2, true, 7, 7) === 0, 'dry: a slice that got nearer or found a room starts over (no batch completed: still 0)');
ok(ED.rollsDryAfter(2, false, 8, 7) === 3, 'dry: a batch completed and nothing found: one more');
ok(ED.rollsDryAfter(2, false, 7, 7) === 2, 'dry: no batch completed in the slice: as it was');
ok(ED.rollsDryAfter(undefined, false, 0, 0) === 0 && ED.rollsDryAfter(undefined, false, 1, 0) === 1, 'dry: from none');
ok(ED.rollsDryAfter(4, false, 9, 7) === 4, 'dry: at most ROLLS_DRY_MAX');
ok(ED.rollsDryAfter(2, false, 7, 7, false) === 3, 'dry: per slice (EEAT_ROLLSIZE=0) every slice judged, as before');

// (flag off = main: the class is chosen before the picks now (goexplore.js gpuMain): mixPick draws no random number and
// leaves its state as it was, so the class before the picks is the class after them)
{
	const st2 = classes.map((c, j) => ({ batches: 3 + j, ticks: 1e6 * j, ms: [7, 5, 9][j] }));
	const snap = JSON.stringify(st2);
	const r0 = Math.random; let draws = 0;
	Math.random = () => { draws++; return r0(); };
	const j1 = GX.mixPick(st2, classes), j2 = GX.mixPick(st2, classes);
	Math.random = r0;
	ok(j1 === j2 && j1 === 1 && JSON.stringify(st2) === snap && draws === 0, 'pickClass: pure (no random draw, the state unchanged): the same class before and after the picks');
}
ok(process.env.EEAT_MIXBANDIT !== undefined || GX.parseArgs(['x.eelvl', '--gpu=1']).mixBandit === 0, 'the yield mix off by default');
ok(GX.parseArgs(['x.eelvl', '--gpu=1', '--mixBandit=0']).rollMix === GX.ROLL_MIX, 'flag off: the default mix');
ok(GX.rollMixOf(GX.ROLL_MIX).every((c) => !('blind' in c)), 'flag off: no blind class (every batch picks with --pA)');
// (flag on: the classes, the blind part)
ok(GX.parseArgs(['x.eelvl', '--gpu=1', '--mixBandit=1']).rollMix === GX.MIX_BANDIT, 'flag on: the classes of the yield mix');
ok(GX.parseArgs(['x.eelvl', '--gpu=1', '--mixBandit=1', '--roll=120', '--keep=0.95']).rollMix === '0', 'flag on with --roll / --keep: one class, as before');
const mb = GX.rollMixOf(GX.MIX_BANDIT);
ok(mb.length === 5 && mb[3].roll === 255 && mb[4].blind === true && mb[4].roll === 120 && mb[4].keep === 0.95 && mb.slice(0, 4).every((c) => !c.blind), 'MIX_BANDIT: 4 run classes + a blind 120:0.95');
ok(GX.rollMixOf('120:0.95:2:b')[0].w === 2 && GX.rollMixOf('120:0.95:2:b')[0].blind === true, 'a blind part with a weight');
let bad = false; try { GX.rollMixOf('120:b'); } catch (e) { bad = true; }
ok(bad, 'a part with no keep is refused');
ok(Math.abs(GX.mixReward({ roomsG: 2, rooms: 5, nearer: 100, fresh: 400000 }) - (2 + 0.9 + 1 + 4)) < 1e-9, 'the reward (v2 defaults): rooms that open territory x1, other rooms x0.3, nearer x0.01, new cells / 100000');
ok(Math.abs(GX.mixReward({ roomsG: 2, rooms: 5, nearer: 1, fresh: 4000 }, { near: 1, fresh: 2000 }) - (2 + 0.9 + 1 + 2)) < 1e-9, 'the reward (v1: --mixNear=1 --mixFresh=2000)');
ok(mb.map((c) => c.w).join() === '0.91,1.45,0.84,0.71,0.92', 'MIX_BANDIT carries the data prior (tools/mixdata.js): 120:0.95 x1.45');
// (flag on, synthetic yields: class 3 yields 4x per GPU second, the others 1x, noisy; batch costs differ)
const sim = (yieldOf, B, seed) => {
	let x = seed >>> 0;
	const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
	// (the classes without the prior: the bandit's own behaviour)
	const cls = mb.map((c) => Object.assign({}, c, { w: 1 })), st3 = cls.map(() => ({ batches: 0, ms: 0 })), b = GX.mixBanditNew(cls.length, { half: 20, c: 0.5, floor: 0.5 });
	const costs = [40, 120, 240, 255, 120], trace = [];
	let minRecent = 1;
	for (let t = 0; t < B; t++) {
		const j = GX.mixBanditPick(b, st3, cls);
		const ms = costs[j] * (0.8 + 0.4 * rnd());
		const r = (ms / 1000) * yieldOf(j, t) * (rnd() < 0.5 ? 0 : 2);
		st3[j].batches++; st3[j].ms += ms;
		GX.mixBanditAdd(b, j, ms, r);
		trace.push(j);
		if (t > 200) { const tot = b.T.reduce((s, v) => s + v, 0); for (let k = 0; k < cls.length; k++) minRecent = Math.min(minRecent, b.T[k] / tot); }
	}
	const tot = st3.reduce((s, q) => s + q.ms, 0);
	return { share: st3.map((q) => q.ms / tot), trace, minRecent, b };
};
const s1 = sim((j) => (j === 3 ? 40 : 10), 3000, 7);
ok(s1.trace.slice(0, 5).join() === '0,1,2,3,4', 'flag on: every class once first, in order');
ok(s1.share.every((v) => v >= 0.1 - 0.02), `flag on: the floor holds (1 / (2K) = 0.1 of the GPU time: ${s1.share.map((v) => v.toFixed(3)).join(' / ')})`);
ok(s1.minRecent >= 0.1 - 0.03, `flag on: the floor holds in the recent window too (least ${s1.minRecent.toFixed(3)})`);
ok(s1.share[3] > 0.4 && s1.share[3] === Math.max(...s1.share), `flag on: converges on the class with the most yield (255: ${s1.share[3].toFixed(3)})`);
// (the best class changes half-way: the discount follows it)
const s2 = sim((j, t) => (t < 1500 ? (j === 0 ? 40 : 10) : (j === 4 ? 40 : 10)), 3000, 11);
const late = s2.trace.slice(2500), cnt = [0, 0, 0, 0, 0];
for (const j of late) cnt[j]++;
ok(cnt[4] === Math.max(...cnt), `flag on: the best class changes (blind from batch 1500): it follows (last 500 batches ${cnt.join(' / ')})`);
// (no yield anywhere: mixPick's equal time shares)
const s0 = sim(() => 0, 1000, 3);
ok(s0.share.every((v) => Math.abs(v - 0.2) < 0.03), `no yield: equal shares of the GPU time (${s0.share.map((v) => v.toFixed(3)).join(' / ')})`);
// (equal yields: roughly equal shares, none starved)
const s4 = sim(() => 10, 3000, 5);
ok(s4.share.every((v) => v > 0.12 && v < 0.3), `equal yields: no class takes the GPU (${s4.share.map((v) => v.toFixed(3)).join(' / ')})`);
// (the reward's weights: --mixRoom, --mixNear, --mixFresh)
ok(Math.abs(GX.mixReward({ roomsG: 2, rooms: 5, nearer: 100, fresh: 50000 }, { room: 0.3, near: 0.01, fresh: 100000 }) - (2 + 0.9 + 1 + 0.5)) < 1e-9, 'the reward with weights: nearer x0.01, new cells / 100000');
// (a data prior: a class's --rollMix weight multiplies its mean; equal yields then favour the heavier class, the floor holds)
{
	const cw2 = GX.rollMixOf('40:0.85:0.9,120:0.95:1.5,240:0.97:0.85,255:0.985:0.7,120:0.95:0.9:b');
	const st5 = cw2.map(() => ({ batches: 0, ms: 0 })), b5 = GX.mixBanditNew(cw2.length, { half: 20, c: 0.5, floor: 0.5 });
	for (let t = 0; t < 3000; t++) { const j = GX.mixBanditPick(b5, st5, cw2); const ms = 100; st5[j].batches++; st5[j].ms += ms; GX.mixBanditAdd(b5, j, ms, 0.1 * (0.5 + ((t * 7919) % 100) / 100)); }
	const tt = st5.reduce((s, q) => s + q.ms, 0), sh = st5.map((q) => q.ms / tt);
	ok(sh[1] === Math.max(...sh) && sh.every((v) => v >= 0.08), `a prior weight 1.5 on 120:0.95 with equal yields: it leads, the floor holds (${sh.map((v) => v.toFixed(3)).join(' / ')})`);
}
ok(GX.parseArgs(['x.eelvl', '--gpu=1', '--mixBandit=1']).mixNear === 0.01 && GX.parseArgs(['x.eelvl', '--mixNear=1']).mixNear === 1 && GX.parseArgs(['x.eelvl', '--mixFresh=2000']).mixFresh === 2000, 'the reward weights are options (defaults v2)');
console.log(`${n - fails} / ${n} passed`);
process.exitCode = fails ? 1 : 0;
