'use strict';
// THE BOUND ALONG A ROUTE (box 7 lane 'proof', cycle 5): at every run tick of a known route, the ticks it has left to its
// finish and what each admissible tier of wholepar.js reads there (kin, rel, gate, togo, and their max): where a bound is
// far below the truth, an exact proof must search every state the slack lets in, so this curve says where a better bound
// has to come from (the chambers: the bound reads ~4 for 40+ ticks of the speed the route builds).
//   node tools/perfect/hcurve.js <level.eelvl> <route.eetas> [--every=1] [--tiers=kin;rel;gate;togo;kin,rel,gate]
// Prints JSON lines {t, left, cell, vy, h: {tier: value}} and a summary {ev 'sum', tier: {at0, meanRatio, minSlack}}.
const T = require('../../src/plan/types.js');
const E = require('../../src/eesim.js');
const C = require('../../src/common.js');
const WP = require('./wholepar.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const [file, route] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file || !route) { console.error('usage: node tools/perfect/hcurve.js <level.eelvl> <route.eetas> [--every=1] [--tiers=a;b,c]'); process.exit(2); }
const L = T.loadLevelFile(file);
const W = L.width;
const masks = C.readEetas(route);
const every = Math.max(1, +args.every || 1);
const tierSets = String(args.tiers || 'kin;rel;gate;togo;kin,rel,gate').split(';').filter(Boolean);
const ctxs = tierSets.map((s) => ({ name: s, ctx: WP.makeCtx(L, new Set(s.split(','))) }));
const sim = new E.EESim(L), inp = new E.EEInput();
// the run timer starts at the end of the first tick with an input; the finish tick is not counted
const snaps = [];
let first = -1, fin = -1;
for (let t = 0; t < masks.length; t++) {
	if (first < 0 && masks[t]) first = t;
	if (first >= 0) snaps.push({ t: t - first, s: sim.snapshot() });
	E.applyMask(inp, masks[t]); sim.tick(inp);
	if (sim.has_silver_crown) { fin = t - first; break; }
}
if (fin < 0) { console.error('the route does not finish'); process.exit(1); }
const sum = {};
for (const { name } of ctxs) sum[name] = { at0: null, n: 0, ratio: 0, minSlack: Infinity, viol: 0 };
for (const { t, s } of snaps) {
	if (t % every !== 0 && t !== fin) continue;
	sim.restore(s);
	// the state before run tick t's input: run ticks left = fin - t + 1 (wholepar's layers: a finish at layer d = d - 1 run ticks)
	const left = fin - t + 1;
	const h = {};
	for (const { name, ctx } of ctxs) {
		// lim = the ticks left, as the search at C = the route passes (C - layer): endgame.lowerBound takes its one-jump-a-landing
		// rise table only for lim < 256 (with lim = Infinity fef0 run tick 54 reads 2, with 6 it reads 3; celeste 74 vs 87 at the start)
		const v = ctx.h(sim, left);
		h[name] = v;
		const S = sum[name];
		if (S.at0 === null) S.at0 = v;
		S.n++; S.ratio += Math.min(1, v / left); S.minSlack = Math.min(S.minSlack, left - v);
		if (v > left) S.viol++;
	}
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	console.log(JSON.stringify({ t, left, cell: [cx, cy], id: L.fg[cy * W + cx], vy: +(sim.speed_y + sim.modifier_y).toFixed(3), h }));
}
for (const k of Object.keys(sum)) { const S = sum[k]; S.meanRatio = +(S.ratio / Math.max(1, S.n)).toFixed(3); delete S.ratio; }
console.log(JSON.stringify({ ev: 'sum', level: file.replace(/^.*[\\/]/, ''), runTicks: fin, sum }));
