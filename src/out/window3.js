'use strict';
// window3.js <level.eelvl> <route> <tick> <mask> <k> [pxRange vxRange]: from the route's state at <tick>, varies px and
// vx, plays the route's next k inputs, and marks whether the state after k ticks has the route's py and vy exactly
// (the same vertical phase) and on the same side (px within 2 px of the route's)
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
const masks = [...fs.readFileSync(process.argv[3], 'latin1')].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const T = +process.argv[4], K = +process.argv[5];
const R = +(process.argv[6] || 3), VR = +(process.argv[7] || 0.5);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const snap = sim.snapshot();
const p0 = [sim.px, sim.py, sim.speed_x, sim.speed_y];
for (let t = T; t < T + K; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const goal = [sim.px, sim.py, sim.speed_x, sim.speed_y];
console.log(`route state at ${T}: px ${p0[0]} py ${p0[1]} vx ${p0[2]} vy ${p0[3]}; at ${T + K}: px ${goal[0]} py ${goal[1]} vx ${goal[2]} vy ${goal[3]}`);
const pxSteps = 80, vxSteps = 30;
const rows = [];
for (let j = 0; j <= vxSteps; j++) {
	const dv = -VR + (2 * VR * j) / vxSteps;
	let row = '';
	for (let i = 0; i <= pxSteps; i++) {
		const dx = -R + (2 * R * i) / pxSteps;
		sim.restore(snap);
		sim.px += dx; sim.speed_x += dv;
		for (let t = T; t < T + K; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
		const ok = sim.py === goal[1] && sim.speed_y === goal[3];
		row += ok ? '#' : '.';
	}
	rows.push(`${(dv >= 0 ? '+' : '') + dv.toFixed(3)} ${row}`);
}
console.log(`px offsets -${R}..+${R} (${(2 * R / pxSteps).toFixed(3)} px per char), vx offsets per row`);
console.log(rows.join('\n'));
