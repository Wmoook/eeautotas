'use strict';
// tolerance.js <level.eelvl> <route> <tick> [pxRange vxRange steps]: perturbs the route's state at <tick> (px, vx) and
// replays the route's own remaining inputs: marks which perturbations still finish (at the same tick or any tick)
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
const masks = [...fs.readFileSync(process.argv[3], 'latin1')].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const T = +process.argv[4];
const R = +(process.argv[5] || 0.5), VR = +(process.argv[6] || 0.02), N = +(process.argv[7] || 40);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
const snap = sim.snapshot();
console.log(`route at ${T}: px ${sim.px} vx ${sim.speed_x} py ${sim.py} vy ${sim.speed_y}`);
let ok = 0;
const rows = [];
for (let j = 0; j <= 20; j++) {
	const dv = -VR + (2 * VR * j) / 20;
	let row = '';
	for (let i = 0; i <= N; i++) {
		const dx = -R + (2 * R * i) / N;
		sim.restore(snap);
		sim.px += dx; sim.speed_x += dv;
		let fin = -1;
		for (let t = T; t < masks.length + 3; t++) {
			E.applyMask(inp, t < masks.length ? masks[t] : 0); sim.tick(inp);
			if (sim.has_silver_crown) { fin = t + 1; break; }
		}
		row += fin === masks.length ? '#' : fin > 0 ? '+' : '.';
		if (fin > 0) ok++;
	}
	rows.push(`${(dv >= 0 ? '+' : '') + dv.toFixed(4)} ${row}`);
}
console.log(`px -${R}..+${R} (${(2 * R / N).toFixed(4)} per char); # = finishes at the same tick, + = later`);
console.log(rows.join('\n'));
