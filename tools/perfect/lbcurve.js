'use strict';
// THE MATH BOUND ALONG THE ROUTES (box 7 lane 'proof', cycle 6): at every run tick of a known route the ticks it has left
// to the crown, what the proofs' tiers read (wholepar.js makeCtx: kin,rel,gate) and what src/math/lb.js's event-graph leg
// bound reads to a trophy touch (the trophies and the half blocks whose touch goes to one: bounds.js touchers), with its
// time a call. A violation = a bound above the ticks left (lb.js: lb > left - 1, the crown a tick after the touch, and the
// plain lb > left are counted apart). Prints one JSON line a route.
//   node tools/perfect/lbcurve.js <level.eelvl> <route.eetas>[,<route2>..] [--every=1] [--cap=4000] [--ms=50]
const path = require('path');
const E = require('../../src/eesim.js');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const B = require('../../src/plan/bounds.js');
const LB = require('../../src/math/lb.js');
const WPAR = require('./wholepar.js');

function trophyTouch(L) {
	const S = B.staticOf(L);
	const out = new Set();
	for (let t = 0; t < L.fg.length; t++) if (L.fg[t] === 121) for (const c of S.touchers(t)) out.add(c);
	return Int32Array.from(out);
}

function main() {
	const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
	const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
	const L = T.loadLevelFile(path.resolve(pos[0]));
	const every = +args.every || 1, cap = +args.cap || 4000, ms = +args.ms || 50;
	const M = LB.createMathLB(L, { cap });
	const tiles = trophyTouch(L);
	const ctx = WPAR.makeCtx(L, new Set((args.tiers || 'kin,rel,gate').split(',')));
	for (const f of pos[1].split(',')) {
		const ev = C.evaluate(L, C.readEetas(f), false);
		if (!ev) { console.log(JSON.stringify({ route: path.basename(f), ok: false })); continue; }
		const masks = ev.ms;
		const sim = new E.EESim(L); sim.reset();
		const inp = new E.EEInput();
		let F = -1;
		for (let k = 0; k < masks.length; k++) { E.applyMask(inp, masks[k]); sim.tick(inp); if (sim.has_silver_crown) { F = k + 1; break; } }
		sim.reset();
		let first = -1;
		for (let k = 0; k < masks.length; k++) if (masks[k] !== 0) { first = k; break; }
		let viol = 0, viol1 = 0, nulls = 0, n = 0, sumT = 0, sumM = 0, sumH = 0, worst = 0, at0 = null, h0 = null, t0lb = null, msum = 0, mmax = 0;
		const rows = [];
		for (let t = 0; t < F; t++) {
			if (t >= first && (t - first) % every === 0) {
				const left = F - t;
				const tt = Date.now();
				let r = null;
				try { r = M.leg(sim, { tiles, mode: 'touch' }, { ms, horizon: left + 2 }); } catch (e) { r = { lb: null, why: 'throw ' + e.message }; }
				const dt = Date.now() - tt; msum += dt; if (dt > mmax) mmax = dt;
				const h = ctx.h(sim, left);
				const lbm = r && r.lb !== null && r.lb !== undefined ? r.lb : null;
				if (lbm === null) nulls++;
				else { if (lbm > left) viol++; if (lbm + 1 > left) viol1++; sumM += lbm; }
				sumH += h; sumT += left; n++;
				if (lbm !== null && lbm - h > worst) worst = lbm - h;
				if (at0 === null) { at0 = left; h0 = h; t0lb = lbm; }
				if (rows.length < 400 && args.rows) rows.push([t - first, left, h, lbm, r && r.why]);
			}
			E.applyMask(inp, masks[t]); sim.tick(inp);
		}
		console.log(JSON.stringify({ route: path.basename(f), runTicks: ev.runTicks, F, first, n, at0, h0, lb0: t0lb, nulls, viol, viol1, meanH: +(sumH / n).toFixed(2), meanLeft: +(sumT / n).toFixed(2), meanLbOverNonNull: n - nulls ? +(sumM / (n - nulls)).toFixed(2) : null, bestGain: worst, msMean: +(msum / n).toFixed(2), msMax: mmax, rows: args.rows ? rows : undefined }));
	}
}
if (require.main === module) main();
module.exports = { trophyTouch };
