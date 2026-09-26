'use strict';
// compares dump_emu.txt and dump_xp.txt (px py vx vy g jc pick) by pick
const fs = require('fs');
const rd = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split(' ')).map((a) => ({ px: +a[0], py: +a[1], vx: +a[2], vy: +a[3], g: +a[4], jc: +a[5], pick: +a[6], line: a.slice(0, 6).join(' ') }));
const E = rd('dump_emu.txt'), X = rd('dump_xp.txt');
const ep = new Map(E.map((s) => [s.pick, s])), xp = new Map(X.map((s) => [s.pick, s]));
const onlyX = X.filter((s) => !ep.has(s.pick)), onlyE = E.filter((s) => !xp.has(s.pick));
console.log('only xp', onlyX.length, 'only emu', onlyE.length);
const byParent = (arr, p) => arr.filter((s) => (s.pick >>> 5) === p).map((s) => `o${s.pick & 31} ${s.line}`);
for (const s of onlyX.slice(0, 4)) {
	const p = s.pick >>> 5;
	console.log(`xp-only pick parent ${p} option ${s.pick & 31}: ${s.line}`);
	console.log('  emu children of that parent:', byParent(E, p));
	console.log('  xp children:', byParent(X, p));
}
// the parents of the extra states: how many distinct, and their option
const pc = new Map();
for (const s of onlyX) pc.set(s.pick & 31, (pc.get(s.pick & 31) || 0) + 1);
console.log('options of xp-only', [...pc]);
const parents = new Set(onlyX.map((s) => s.pick >>> 5));
console.log('distinct parents', parents.size, 'max parent', Math.max(...parents), 'layer size', E.length);
const ps = [...parents].sort((a, b) => a - b);
console.log('parent idx range sample', ps.slice(0, 10), ps.slice(-10));
