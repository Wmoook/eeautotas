'use strict';
// window.js <level.eelvl> <route> <tick> <pxLo,pxHi,pyLo,pyHi> [dpx dvx range]: from the route's state at <tick>, varies
// px and vx and reports which (px, vx) reach the box [pxLo,pxHi] x [pyLo,pyHi] (grounded) after one tick of any input
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
const masks = [...fs.readFileSync(process.argv[3], 'latin1')].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const T = +process.argv[4];
const [x0, x1, y0, y1] = process.argv[5].split(',').map(Number);
const R = +(process.argv[6] || 2), VR = +(process.argv[7] || 0.5), ahead = +(process.argv[8] || 1);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const snap = sim.snapshot();
console.log(`route state at ${T}: px ${sim.px} py ${sim.py} vx ${sim.speed_x} vy ${sim.speed_y} g ${sim.on_ground}`);
const OPTS = [0, 1, 2, 3, 4, 5];
const inBox = (s) => s.px >= x0 && s.px <= x1 && s.py >= y0 && s.py <= y1;
let rows = [];
const pxSteps = 80, vxSteps = 40;
for (let j = 0; j <= vxSteps; j++) {
	const dv = -VR + (2 * VR * j) / vxSteps;
	let row = '';
	for (let i = 0; i <= pxSteps; i++) {
		const dx = -R + (2 * R * i) / pxSteps;
		// any input sequence of `ahead` ticks (same input each tick) reaching the box
		let ok = false;
		for (const m of OPTS) {
			sim.restore(snap);
			sim.px += dx; sim.speed_x += dv;
			for (let k = 0; k < ahead; k++) { E.applyMask(inp, m); sim.tick(inp); if (inBox(sim)) { ok = true; break; } }
			if (ok) break;
		}
		row += ok ? '#' : '.';
	}
	rows.push(`${(dv >= 0 ? '+' : '') + dv.toFixed(3)} ${row}`);
}
console.log(`px offsets -${R}..+${R} (${(2 * R / pxSteps).toFixed(3)} px per char), vx offsets per row`);
console.log(rows.join('\n'));
