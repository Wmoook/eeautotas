'use strict';
// A gate baseline from several runs of the same code (tools/cmp/summ.js --json of each): per level the LESSER run
// (compiled only where every run compiled, then the slowest route; else the smallest progress 'gain'), so a lane's
// level is WORSE (tools/cmp/gate.js) only when it is below every run of the base code.
//   node tools/cmp/lesser.js <out.json> <summ1.json> <summ2.json> ...
const fs = require('fs');
const [, , out, ...ins] = process.argv;
const runs = ins.map((f) => new Map(JSON.parse(fs.readFileSync(f, 'utf8')).map((r) => [r.rel, r])));
const rels = new Set();
for (const m of runs) for (const k of m.keys()) rels.add(k);
const rows = [];
for (const rel of [...rels].sort()) {
	const rs = runs.map((m) => m.get(rel)).filter(Boolean);
	if (rs.length < runs.length) continue;   // a level not in every run: no baseline
	const notOk = rs.filter((r) => !r.ok);
	const pick = notOk.length ? notOk.reduce((a, b) => ((b.gain | 0) < (a.gain | 0) ? b : a)) : rs.reduce((a, b) => (b.runTicks > a.runTicks ? b : a));
	rows.push(Object.assign({}, pick, { runs: rs.map((r) => (r.ok ? r.runTicks : `gain ${r.gain | 0}`)) }));
}
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log(`${rows.length} levels; compiled in every run ${rows.filter((r) => r.ok).length}`);
