'use strict';
// corridor.js <level.eelvl> <route> <tick> <entryTick> <pxLo,pxHi,pyLo,pyHi> [pxRange vxRange]: from the route's state
// at <tick> with px / vx offsets, tries the x inputs {R, -, L} for the first 3 ticks, then L until entryTick - 1, then
// every x input for the last tick; marks whether the ball is in the box (grounded) at entryTick. Shows the corridor.
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
const masks = [...fs.readFileSync(process.argv[3], 'latin1')].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const T = +process.argv[4], TE = +process.argv[5];
const [x0, x1, y0, y1] = process.argv[6].split(',').map(Number);
const R = +(process.argv[7] || 2), VR = +(process.argv[8] || 0.2);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const snap = sim.snapshot();
console.log(`route at ${T}: px ${sim.px} vx ${sim.speed_x} py ${sim.py} vy ${sim.speed_y}`);
const X = [4, 0, 2];
let found = 0;
const pxSteps = 100, vxSteps = 30;
const rows = [];
for (let j = 0; j <= vxSteps; j++) {
	const dv = -VR + (2 * VR * j) / vxSteps;
	let row = '';
	for (let i = 0; i <= pxSteps; i++) {
		const dx = -R + (2 * R * i) / pxSteps;
		let ok = false;
		for (let a = 0; a < 27 && !ok; a++) {
			for (let last = 0; last < 3 && !ok; last++) {
				sim.restore(snap);
				sim.px += dx; sim.speed_x += dv;
				for (let t = T; t < TE; t++) {
					const k = t - T;
					const m = k < 3 ? X[Math.floor(a / 3 ** k) % 3] : t === TE - 1 ? X[last] : 2;
					E.applyMask(inp, m); sim.tick(inp);
				}
				if (sim.px >= x0 && sim.px <= x1 && sim.py >= y0 && sim.py <= y1) ok = true;
			}
		}
		if (ok) found++;
		row += ok ? '#' : '.';
	}
	rows.push(`${(dv >= 0 ? '+' : '') + dv.toFixed(4)} ${row}`);
}
console.log(`px offsets -${R}..+${R} (${(2 * R / pxSteps).toFixed(3)} px per char), vx offsets per row; ${found} cells ok`);
console.log(rows.join('\n'));
