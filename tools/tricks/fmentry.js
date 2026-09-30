'use strict';
// fieldmine.js's passages by HOW THEY ARE ENTERED and LEFT: per field class the entry face relative to the pull (along the
// pull, against it, across it), the exit face (along / against / across), the tile before the entry (air / another field)
// and grounded before; the passages' ticks and the downstream gains of the setup family in each group.
// Usage: node tools/tricks/fmentry.js <dir>
const fs = require('fs');
const dir = process.argv[2];
const rows = [];
for (const f of fs.readdirSync(dir)) if (/^mine_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(dir + '/' + f, 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
const PULL = { arrowU: [0, -1], arrowD: [0, 1], arrowL: [-1, 0], arrowR: [1, 0], boostU: [0, -1], boostD: [0, 1], boostL: [-1, 0], boostR: [1, 0] };
const rel = (face, pull) => {
	if (!pull) return 'free';
	const d = face[0] * pull[0] + face[1] * pull[1];
	if (face[0] === 0 && face[1] === 0) return 'none';
	return d > 0 ? 'along' : d < 0 ? 'against' : 'across';
};
const groups = new Map();
for (const r of rows) {
	const pull = PULL[r.fc] || null;
	const key = `${r.fc.padEnd(6)} in:${rel(r.inFace || [0, 0], pull).padEnd(7)} out:${rel(r.face, pull).padEnd(7)} from:${(r.preFc || '?').padEnd(6)} g:${r.preGround}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}
const list = [...groups].map(([k, a]) => ({ k, n: a.length, t: a.reduce((s, r) => s + r.n, 0), g2: a.reduce((s, r) => s + (r.gain2 > 0 ? r.gain2 : 0), 0), tight: a.filter((r) => r.lbFace !== null && r.lbFace === r.n).length }))
	.sort((a, b) => b.t - a.t);
console.log('group                                                   passages   ticks  atFaceBound  downstreamGain');
for (const g of list.slice(0, +(process.argv[3] || 45))) console.log(`${g.k.padEnd(56)} ${String(g.n).padStart(7)} ${String(g.t).padStart(7)} ${String(g.tight).padStart(11)} ${String(g.g2).padStart(14)}`);
