'use strict';
// tools/gpuproof/cmplayers.js: the GPU exact search's breadth-first layers (exact.js / eegpu exact JSON lines, the first layer
// bound's "layer" events) against the CPU census (tools/perfect/layercensus.js): the census's --C is the LAYER bound (= wholepar
// C = the GPU's Cl = eegpu --C + 1), so census --C=26 pairs with exact.js --C=25.
//   node tools/gpuproof/cmplayers.js <census.jsonl> <gpu.jsonl>   -> {layersCompared, same, diff, rows}
// compare layer counts: CPU census (layercensus.js jsonl) vs GPU exact (exact.js jsonl, the first Cl's BFS layers)
const fs = require('fs');
const [cenF, gpuF] = process.argv.slice(2);
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const cen = lines(cenF).filter((o) => o.ev === 'layer');
const gl = lines(gpuF).filter((o) => o.ev === 'layer');
const Cl0 = gl.length ? gl[0].Cl : null;
const gpu = gl.filter((o) => o.Cl === Cl0);
const gby = new Map(gpu.map((o) => [o.layer, o]));
let same = 0, diff = 0, last = 0;
const rows = [];
for (const c of cen) {
	const g = gby.get(c.d);
	if (!g) continue;
	const ok = g.states === c.states;
	if (ok) same++; else diff++;
	last = c.d;
	rows.push(`${c.d}:${c.states}${ok ? '' : '!=' + g.states}`);
}
console.log(JSON.stringify({ census: cenF.replace(/^.*\//, ''), gpu: gpuF.replace(/^.*\//, ''), Cl: Cl0, layersCompared: same + diff, same, diff, lastLayer: last, cenStates: cen.reduce((a, c) => a + (gby.has(c.d) ? c.states : 0), 0), rows: rows.join(' ') }));
