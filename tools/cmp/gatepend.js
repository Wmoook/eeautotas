'use strict';
// THE PENDING GATE COUNTS' CHECK (types.js EEAT_GATE_PENDING): along a route (or any input string) every tick, the level
// copy levelNow builds with the knob must hold every coin / blue coin gate as the NEXT tick's state holds it (the engine's
// shown count after PlayState.tick's copy), wherever the counts do not change in between; prints the gates, the ticks
// checked, the ticks where the knob's copy differs from the plain one (the pending ticks) and the mismatches (must be 0).
//   node tools/cmp/gatepend.js <level.eelvl> <route.eetas | inputs.txt>
const path = require('path');
const fs = require('fs');
process.env.EEAT_GATE_PENDING = '1';
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const E = require(path.join(root, 'src/eesim.js'));
const C = require(path.join(root, 'src/common.js'));
const [lf, rf] = process.argv.slice(2);
if (!lf || !rf) { console.error('usage: gatepend.js <level.eelvl> <route.eetas | inputs.txt>'); process.exit(2); }
const L = T.loadLevelFile(lf), W = L.width;
const masks = rf.endsWith('.eetas') ? C.readEetas(rf) : Uint8Array.from(fs.readFileSync(rf, 'utf8').trim(), (ch) => (ch.charCodeAt(0) - 48) & 31);
const gates = [];
for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === 165 || L.fg[i] === 214) gates.push(i);
const sim = new E.EESim(L); sim.reset();
const inp = new E.EEInput();
let prev = null, bad = 0, checked = 0, pend = 0;
for (let t = 0; t <= masks.length; t++) {
	const lv = T.levelNow(L, sim);
	const cur = gates.map((i) => lv.fg[i]);
	const plain = gates.map((i) => (sim.is_tile_solid_now(i % W, (i / W) | 0) ? 9 : 0));
	if (prev && prev.c === sim.coins && prev.b === sim.blue_coins && !sim.is_dead) {
		checked++;
		for (let k = 0; k < gates.length; k++) if (prev.p[k] !== plain[k]) { bad++; if (bad <= 5) console.log('mismatch at tick', t, `(${gates[k] % W},${(gates[k] / W) | 0})`, 'knob', prev.p[k], 'next tick', plain[k]); }
	}
	if (cur.some((v, k) => v !== plain[k])) pend++;
	prev = { p: cur, c: sim.coins, b: sim.blue_coins };
	if (t < masks.length) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
}
console.log(JSON.stringify({ gates: gates.length, ticks: checked, pending: pend, mismatch: bad }));
