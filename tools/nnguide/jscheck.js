'use strict';
// Checks src/nnguide.js's inference against PyTorch: replays a held-out group's judge route in the JS engine, computes
// the model's cost at every tick and compares it with the series train.py saved (<tag>_<hold>_series.npy row 1).
//   node jscheck.js <model.json> <series.npy> <group> [--bundle=bundle]
const fs = require('fs');
const path = require('path');
const { C, E, NG } = require('./feat.js');
const [mf, sf, group] = process.argv.slice(2);
const WORK = process.env.NN_WORK || path.join(__dirname, '..', '..', 'src', 'out', 'nnguide');
const bundle = path.resolve(WORK, (process.argv.find((s) => s.startsWith('--bundle=')) || '--bundle=bundle').slice(9));
const cat = JSON.parse(fs.readFileSync(path.join(bundle, 'catalog.json'), 'utf8'));
let lv = null, route = null;
for (const c of cat) for (const r of c.routes) if (r.eval === group) { lv = c.lv; route = r.name; }
const L = E.prepareLevel(JSON.parse(fs.readFileSync(path.join(bundle, 'levels', lv + '.json'), 'utf8')));
const m = NG.load(mf);
const ctx = NG.levelCtx(L);
// the .npy: a float64 array [4][n]
const buf = fs.readFileSync(sf);
const hl = buf.readUInt16LE(8), data = new Float64Array(buf.buffer.slice(buf.byteOffset + 10 + hl, buf.byteOffset + buf.length));
const n = data.length / 4;
const ms = C.readEetas(path.join(bundle, 'routes', lv, route));
const sim = new E.EESim(L);
const inp = new E.EEInput();
sim.reset();
let maxRel = 0, worst = -1, t0 = Date.now(), calls = 0;
for (let t = 0; t <= ms.length && t < n; t++) {
	if (t > 0) { E.applyMask(inp, ms[t - 1]); sim.tick(inp); }
	const js = NG.cost(m, ctx, sim);
	calls++;
	const py = data[n + t];
	const rel = Math.abs(js - py) / Math.max(1, Math.abs(py));
	if (rel > maxRel) { maxRel = rel; worst = t; }
}
const ms1 = (Date.now() - t0) / calls;
console.log(`${group}: ${lv} ${route}, ${calls} ticks: max relative difference JS vs PyTorch ${maxRel.toExponential(2)} at tick ${worst} (JS ${worst >= 0 ? 'see above' : ''}); ${(ms1 * 1000).toFixed(1)} us per call with the code cache (${ctx.list.length} door states)`);
