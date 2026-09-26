'use strict';
// trace.js <level.eelvl> <inputs file | "chars"> [every]: replays and prints px py vx vy ground per tick; finish tick
const fs = require('fs');
const ED = require('../editor.js');
const E = require('../eesim.js');
const ins = ED.inspect(fs.readFileSync(process.argv[2]));
let s = process.argv[3];
if (fs.existsSync(s)) s = fs.readFileSync(s, 'latin1');
const masks = [...s].map((c) => c.charCodeAt(0)).filter((c) => c >= 48 && c < 80).map((c) => (c - 48) & 31);
const every = +(process.argv[4] || 1);
const sim = new E.EESim(ins.level); sim.reset();
const inp = new E.EEInput();
const names = (m) => (m & 2 ? 'L' : '') + (m & 4 ? 'R' : '') + (m & 8 ? 'U' : '') + (m & 16 ? 'D' : '') + (m & 1 ? 'J' : '') || '-';
for (let t = 0; t < masks.length; t++) {
	E.applyMask(inp, masks[t]); sim.tick(inp);
	const done = sim.has_silver_crown || sim.has_crown;
	if (t % every === 0 || done) console.log(`${t + 1}\t${names(masks[t])}\tpx ${sim.px.toFixed(4)}\tpy ${sim.py.toFixed(4)}\tvx ${sim.speed_x.toFixed(5)}\tvy ${sim.speed_y.toFixed(5)}\tg ${sim.on_ground ? 1 : 0}\ttile ${(Math.trunc(sim.px + 8) >> 4)},${(Math.trunc(sim.py + 8) >> 4)}`);
	if (sim.has_silver_crown) { console.log('FINISH at tick', t + 1); break; }
}
