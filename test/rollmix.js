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
console.log(`${n - fails} / ${n} passed`);
process.exitCode = fails ? 1 : 0;
