'use strict';
// window2.js <level.eelvl> <route> <tick> <pxLo,pxHi,pyLo,pyHi> [pxRange pyRange]: from the route's state at <tick>,
// varies px and py (speeds kept) and marks which reach the box after one tick of some input
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
const masks = [...fs.readFileSync(process.argv[3], 'latin1')].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const T = +process.argv[4];
const [x0, x1, y0, y1] = process.argv[5].split(',').map(Number);
const R = +(process.argv[6] || 2), YR = +(process.argv[7] || 2);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const snap = sim.snapshot();
console.log(`route state at ${T}: px ${sim.px} py ${sim.py} vx ${sim.speed_x} vy ${sim.speed_y} g ${sim.on_ground}`);
const inBox = (s) => s.px >= x0 && s.px <= x1 && s.py >= y0 && s.py <= y1;
const pxSteps = 80, pySteps = 40;
const rows = [];
for (let j = 0; j <= pySteps; j++) {
	const dy = -YR + (2 * YR * j) / pySteps;
	let row = '';
	for (let i = 0; i <= pxSteps; i++) {
		const dx = -R + (2 * R * i) / pxSteps;
		let ok = false;
		for (const m of [0, 1, 2, 3, 4, 5]) {
			sim.restore(snap);
			sim.px += dx; sim.py += dy;
			E.applyMask(inp, m); sim.tick(inp);
			if (inBox(sim)) { ok = true; break; }
		}
		row += ok ? '#' : '.';
	}
	rows.push(`${(dy >= 0 ? '+' : '') + dy.toFixed(3)} ${row}`);
}
console.log(`px offsets -${R}..+${R} (${(2 * R / pxSteps).toFixed(3)} px per char), py offsets per row`);
console.log(rows.join('\n'));
