'use strict';
// A LEVEL WINDOW as text (a doctor's tool, n5): the foreground of a rectangle, one character a tile ('#' solid, '.' air,
// letters for the other block ids, the legend below), a known route's tiles marked '*' (optionally from / to a tick) and
// marks given as x,y:c.  node tools/cmp/lvmap.js <level.eelvl> x0 y0 x1 y1 [--route=<eetas>] [--from=t] [--to=t]
// [--mark=x,y:c;x,y:c]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const [file, ...nums] = argv.filter((s) => !s.startsWith('--'));
const [x0, y0, x1, y1] = nums.map(Number);
const L = T.loadLevelFile(file), W = L.width;
const ids = new Map(), sym = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const route = new Map();
if (opt('route', null)) {
	const masks = C.readEetas(opt('route'));
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	const from = +opt('from', 0), to = +opt('to', masks.length);
	for (let t = 0; t < Math.min(to, masks.length); t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (t >= from) { const k = T.tileOf(sim, W, L.height); if (!route.has(k)) route.set(k, t); } }
}
const marks = new Map();
for (const m of String(opt('mark', '')).split(';').filter(Boolean)) { const [xy, c] = m.split(':'); const [x, y] = xy.split(',').map(Number); marks.set(y * W + x, c || '@'); }
const solid = (id) => id > 0 && id < L.flags.length && (L.flags[id] & 1) !== 0;
const lines = [];
lines.push('     ' + Array.from({ length: x1 - x0 + 1 }, (_, i) => ((x0 + i) % 10 === 0 ? String(((x0 + i) / 10) % 10) : ' ')).join(''));
for (let y = y0; y <= y1; y++) {
	let s = String(y).padStart(4) + ' ';
	for (let x = x0; x <= x1; x++) {
		const t = y * W + x, id = L.fg[t];
		if (marks.has(t)) { s += marks.get(t); continue; }
		if (route.has(t)) { s += '*'; continue; }
		if (id === 0) { s += '.'; continue; }
		if (id === 9 || (solid(id) && !ids.has(id) && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40].includes(id))) { s += '#'; continue; }
		if (!ids.has(id)) ids.set(id, sym[ids.size % sym.length]);
		s += ids.get(id);
	}
	lines.push(s);
}
console.log(lines.join('\n'));
console.log('legend: ' + Array.from(ids).map(([id, c]) => `${c}=${id}${solid(id) ? 's' : ''}`).join(' '));
