'use strict';
// node tools/n4u/dbg_gate.js <route name> <tick> <gate x> <gate y>: the engine's and the model's view of one gate tile
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const E = require(path.join(REPO, 'src', 'eesim.js'));
const TS = require(path.join(REPO, 'src', 'plan', 'truthset.js'));
const PM = require(path.join(REPO, 'src', 'plan', 'model.js'));
const [name, tickS, gx, gy] = process.argv.slice(2);
const e = TS.knownRoutes({ root: process.env.EEAT_TRUTH_ROOT || 'C:\\Users\\super\\eeautotas' }).find((r) => r.name === name && (!process.argv[6] || r.route.includes(process.argv[6])));
const tr = TS.loadTruth(e); const L = tr.L; const W = L.width;
const M = PM.compileModel(L);
const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
const i = +gy * W + +gx;
for (let t = 0; t < +tickS; t++) { E.applyMask(inp, tr.masks[t] & 31); sim.tick(inp); }
const R = M.stateOf(sim);
console.log({ id: L.fg[i], param: L.lookup0[i], coins: sim.coins, show: sim._show_coin_gate, bcoins: sim.blue_coins, bshow: sim._show_blue_coin_gate, px: sim.px, py: sim.py,
	tile: [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4], cur: sim.current_tile, engineOpen: !sim.is_tile_solid_now(+gx, +gy), lb: M.gateOpen(i, R, 'lb', R.feats),
	est: M.gateOpen(i, R, 'est', null), feats: R.feats, gateFeat: M.A.gateFeat[i], pol: M.A.gatePol[i], ov: sim._ovAt(sim.px, sim.py), ovClass: sim._ovClass(sim.px, sim.py), fly: sim.has_levitation });
