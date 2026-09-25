'use strict';
// Replays an .eetas (raw bytes, eeo-tas semantics) with the JS sim and reports completion, run timer, coins, deaths
// and the coin timeline. For a fuller report (random portals, keys, switches, odds) use: node src/tas.js replay
// usage: node src/run.js <file.eetas> [--level=<level id | job id>]   (--level optional inside src/jobs/<id>/)
const path = require('path');
const C = require('./common.js');
const E = C.E;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const level = (args.find((a) => a.startsWith('--level=')) || '--level=').slice(8);
if (!file) { console.log('usage: node src/run.js <file.eetas> [--level=<level id | job id>]'); process.exit(1); }
const lvl = E.loadLevel(C.levelData(level, file));
const masks = C.readEetas(file);
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
const fmt = C.fmt;
console.log(`${path.basename(file)}: ${masks.length} ticks, complete ${complete >= 0 ? 'at tick ' + complete : 'NO'}, ` +
	`run_ticks ${sim.run_ticks} (${fmt(sim.run_ticks)}), coins ${sim.coins}, deaths ${deaths}, ${ms.toFixed(1)} ms`);
console.log('coins at run time: ' + coins.map((c, i) => `${i + 1}@${fmt(c[1])}`).join(' '));
