'use strict';
// prep.js <level.eelvl> [outBase]: writes <outBase>.bin (level blob), <outBase>.reach (RCH2), prints an ASCII map
const fs = require('fs');
const ED = require('../editor.js');
const G = require('../gpu.js');
const RF = require('../reach.js');
const E = require('../eesim.js');
const buf = fs.readFileSync(process.argv[2]);
const out = process.argv[3];
const ins = ED.inspect(buf);
const L = ins.level;
if (out) {
	fs.writeFileSync(out + '.bin', G.levelBlob(L));
	const rf = RF.reachField(L);
	RF.writeReachFile(rf, out + '.reach');
	console.log('reach mode', rf.mode);
}
const W = L.width, H = L.height;
const sim = new E.EESim(L); sim.reset();
console.log(`size ${W}x${H} start px ${sim.px} py ${sim.py} tile ${ins.start} trophies ${JSON.stringify(ins.trophies)}`);
const ids = new Map();
let s = '    ' + [...Array(W)].map((_, x) => x % 10).join('') + '\n';
for (let y = 0; y < H; y++) {
	let row = String(y).padStart(3) + ' ';
	for (let x = 0; x < W; x++) {
		const id = L.fg[y * W + x];
		let c;
		if (ins.start && x === ins.start[0] && y === ins.start[1]) c = 'S';
		else if (id === 0) c = ' ';
		else if (id === 121) c = 'T';
		else { c = '#'; ids.set(id, (ids.get(id) || 0) + 1); }
		row += c;
	}
	s += row + '\n';
}
console.log(s);
console.log('ids', JSON.stringify([...ids]));
