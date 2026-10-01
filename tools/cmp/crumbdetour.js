'use strict';
// THE CRUMBS' DETOURS (C6 lane 5): along a route, every arrival at a CRUMB (a coin / blue coin no gate reads: model.js
// EEAT_CRUMBS) and its detour by the planner's 'now' walk: d(prev -> crumb) + d(crumb -> next) - d(prev -> next), where
// prev is the ball's tile at the route's previous model-state change (the level start first) and next its tile at the
// next change that is not a crumb (the trophy last). A calibration tool for the crumb plans' detour test (planner.js
// crumbPlan): a known route's crumbs (the designer's breadcrumbs) vs a compiled route's detours.
//   node tools/cmp/crumbdetour.js <level.eelvl> <route.eetas> [--json=1]
process.env.EEAT_CRUMBS = '1';
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const pos = argv.filter((s) => !s.startsWith('--'));
const json = argv.includes('--json=1');
const [file, rfile] = pos;
if (!file || !rfile) { console.error('usage: node tools/cmp/crumbdetour.js <level.eelvl> <route.eetas> [--json=1]'); process.exit(2); }
const L = T.loadLevelFile(file), W = L.width, H = L.height;
const masks = C.readEetas(rfile);
const M = MD.compileModel(L);
const crumbFeats = new Set(M.triggers.filter((X) => X.crumb).map((X) => X.feat));
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
let S = M.stateOf(sim);
const ch = [{ t: 0, tile: T.tileOf(sim, W, H), S, crumb: false }];
for (let t = 0; t < masks.length; t++) {
	E.applyMask(inp, masks[t] & 31); sim.tick(inp);
	if (sim.is_dead) continue;
	const S2 = M.stateOf(sim);
	const fin = !!sim.has_silver_crown;
	if (S2.key !== S.key || fin) {
		let onlyCrumb = !fin && S2.cp === S.cp;
		for (const f of Object.keys(S2.feats)) if ((S2.feats[f] || 0) !== (S.feats[f] || 0) && !crumbFeats.has(f)) onlyCrumb = false;
		ch.push({ t: t + 1, tile: T.tileOf(sim, W, H), S: S2, crumb: onlyCrumb, fin });
		S = S2;
	}
	if (fin) break;
}
const base = (s) => ({ coins: s.feats.coins || 0, bcoins: s.feats.bcoins || 0, deaths: s.feats.deaths || 0 });
const d = (s, a, b) => { const f = M.dist(s, { id: 'cd' + a, tiles: [a], extra: 0 }, 'now', base(s)); return f[b]; };
const rows = [];
for (let i = 1; i < ch.length; i++) {
	if (!ch[i].crumb) continue;
	let j = i + 1; while (j < ch.length && ch[j].crumb) j++;
	if (j >= ch.length) break;
	const p = ch[i - 1], c = ch[i], n = ch[j];
	const D = d(p.S, p.tile, n.tile), d1 = d(p.S, p.tile, c.tile), d2 = d(c.S, c.tile, n.tile);
	const r = { tick: c.t, at: `(${c.tile % W},${(c.tile / W) | 0})`, from: `(${p.tile % W},${(p.tile / W) | 0})`, to: `(${n.tile % W},${(n.tile / W) | 0})`, D, d1, d2, detour: d1 + d2 - D, rel: D > 0 ? +((d1 + d2 - D) / D).toFixed(3) : null, legTicks: c.t - p.t, nextTicks: n.t - c.t };
	rows.push(r);
	if (!json) console.log(`${String(r.tick).padStart(6)} crumb ${r.at.padEnd(10)} from ${r.from.padEnd(10)} to ${r.to.padEnd(10)} D ${D} d1 ${d1} d2 ${d2} detour ${r.detour} (${r.rel}) ticks ${r.legTicks}+${r.nextTicks}`);
}
const summary = { level: path.basename(file), crumbs: rows.length, changes: ch.length - 1, maxDetour: rows.reduce((m, r) => Math.max(m, r.detour), 0), maxRel: rows.reduce((m, r) => Math.max(m, r.rel || 0), 0) };
if (json) console.log(JSON.stringify({ summary, rows })); else console.log(JSON.stringify(summary));
