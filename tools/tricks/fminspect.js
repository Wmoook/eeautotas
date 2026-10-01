'use strict';
// fieldmine.js's passages, listed: the setup variants that exit the field sooner AND reach the route's tile D ticks after
// the exit sooner, with the route's and the variant's entry along the face axis (the offset in the tile, the speed toward
// the face) and across it. Usage: node tools/tricks/fminspect.js <dir> [--n=40] [--fc=arrowU] [--shift=same|later|any]
const fs = require('fs');
const argv = Object.fromEntries(process.argv.slice(3).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const dir = process.argv[2];
const rows = [];
for (const f of fs.readdirSync(dir)) if (/^mine_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(dir + '/' + f, 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
const shift = argv.shift || 'any';
const sel = rows.filter((r) => r.gain > 0 && r.gain2 !== null && r.gain2 > 0 && (!argv.fc || r.fc === argv.fc)
	&& (shift === 'any' ? r.entryShift >= 0 : shift === 'same' ? r.entryShift === 0 : r.entryShift > 0))
	.sort((a, b) => b.gain2 - a.gain2);
const ax = (r, st) => (r.axis === 'x' ? [st[0], st[2], st[1], st[3]] : [st[1], st[3], st[0], st[2]]);
const off = (p) => { const c = p + 8; return c - 16 * Math.floor(c / 16); };
for (const r of sel.slice(0, +(argv.n || 40))) {
	const [p0, v0, q0, w0] = ax(r, r.entry), [p1, v1, q1, w1] = ax(r, r.bestEntryState);
	console.log(`${r.name.slice(0, 16).padEnd(16)} ${r.fc.padEnd(6)} a ${r.a} n ${r.n} lb ${r.lbFace} gain ${r.gain} g2 ${r.gain2} shift ${r.entryShift} back ${r.bestS} m ${r.bestM} | along: route off ${off(p0).toFixed(2)} v ${(v0 * r.sgn).toFixed(3)} var off ${off(p1).toFixed(2)} v ${(v1 * r.sgn).toFixed(3)} | across: route off ${off(q0).toFixed(2)} v ${w0.toFixed(2)} var off ${off(q1).toFixed(2)} v ${w1.toFixed(2)} | keys ${r.keys.join('/')} dF ${r.dFwd}`);
}
console.log(`${sel.length} passages`);
