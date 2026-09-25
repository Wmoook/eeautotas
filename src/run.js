'use strict';
// Replays an .eetas with the JS sim and reports completion, run timer, coins, deaths and the coin timeline.
// usage: node tools/tas/run.js <file.eetas> [--level=forgotten_veil]
const fs = require('fs');
const path = require('path');
const E = require('./eesim.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const level = (args.find((a) => a.startsWith('--level=')) || '--level=forgotten_veil').slice(8);
if (!file) { console.log('usage: node tools/tas/run.js <file.eetas> [--level=id]'); process.exit(1); }
const lvl = E.loadLevel(path.join(__dirname, 'data', level + '.json'));
const masks = E.parseEetas(fs.readFileSync(file, 'utf8'));
const sim = new E.EESim(lvl);
sim.reset();
const inp = new E.EEInput();
let complete = -1, deaths = 0;
const coins = [];
sim.onEvent = (kind) => {
	if (kind === 'complete' && complete < 0) complete = sim.ticks();
	else if (kind === 'death') deaths++;
	else if (kind === 'coin') coins.push([sim.ticks(), sim.run_ticks]);
};
const t0 = process.hrtime.bigint();
for (let i = 0; i < masks.length; i++) {
	E.applyMask(inp, masks[i]);
	sim.tick(inp);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const fmt = (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`;
console.log(`${path.basename(file)}: ${masks.length} ticks, complete ${complete >= 0 ? 'at tick ' + complete : 'NO'}, ` +
	`run_ticks ${sim.run_ticks} (${fmt(sim.run_ticks)}), coins ${sim.coins}, deaths ${deaths}, ${ms.toFixed(1)} ms`);
console.log('coins at run time: ' + coins.map((c, i) => `${i + 1}@${fmt(c[1])}`).join(' '));
