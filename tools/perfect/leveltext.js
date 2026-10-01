'use strict';
// THE LEVEL AS TEXT (box 7 lane 'proof', cycle 5): a level's foreground one char per tile with a route's centre cells '*',
// and (ROWS=1) the route's state per run tick: what a bound has to know about the way the route goes.
//   node tools/perfect/leveltext.js <level.eelvl> [<route.eetas> | -] [x0 x1 y0 y1]
const T = require('../../src/plan/types.js');
const E = require('../../src/eesim.js');
const C = require('../../src/common.js');

const [file, route, x0s, x1s, y0s, y1s] = process.argv.slice(2);
const L = T.loadLevelFile(file);
const W = L.width, H = L.height;
const masks = route && route !== '-' ? C.readEetas(route) : [];
const sim = new E.EESim(L), inp = new E.EEInput();
const path = new Map(); let first = -1;
const rows = [];
for (let t = 0; t < masks.length; t++) {
	E.applyMask(inp, masks[t]); sim.tick(inp);
	if (first < 0 && masks[t]) first = t;
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	if (first >= 0) {
		const k = cy * W + cx;
		if (!path.has(k)) path.set(k, t - first);
		rows.push([t - first, masks[t], sim.px.toFixed(2), sim.py.toFixed(2), (sim.speed_x + sim.modifier_x).toFixed(3), (sim.speed_y + sim.modifier_y).toFixed(3), cx, cy, L.fg[cy * W + cx]]);
	}
	if (sim.has_silver_crown) break;
}
const ids = new Map(); const sym = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'; let si = 0;
const x0 = +x0s || 0, x1 = +x1s || W - 1, y0 = +y0s || 0, y1 = +y1s || H - 1;
const lines = [];
for (let y = y0; y <= y1; y++) {
	let s = String(y).padStart(3) + ' ';
	for (let x = x0; x <= x1; x++) {
		const id = L.fg[y * W + x];
		let c;
		if (path.has(y * W + x)) c = '*';
		else if (id === 0) c = '.';
		else { if (!ids.has(id)) ids.set(id, sym[si++ % sym.length]); c = ids.get(id); }
		s += c;
	}
	lines.push(s);
}
console.log(lines.join('\n'));
console.log('legend', [...ids].map(([k, v]) => v + '=' + k).join(' '));
console.log('spawn', L.spawnsX[0], L.spawnsY[0], 'route run ticks', rows.length);
if (process.env.ROWS) for (const r of rows) console.log(r.join(' '));
