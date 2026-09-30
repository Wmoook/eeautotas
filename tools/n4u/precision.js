'use strict';
// N4U semantics (c): how precise must a compiled move be? Along known routes of the truthset, at sampled ticks, the
// engine's exact state is perturbed (px, vx, py, vy by d = 1e-12 .. 1 px or px/tick) and the route's own inputs are played
// on: does it re-converge to the SAME exact state (stateHash equal to the unperturbed route's at the same tick: the
// perturbation was absorbed), does it still finish, how many run ticks does it lose? Also the sub-pixel census of the
// routes' states (px / py fractional parts: whole pixels, dyadic denominators). Light CPU: a sample.
// node tools/n4u/precision.js [--root=] [--routes=40] [--per=8] [--horizon=400] [--out=]
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const E = require(path.join(REPO, 'src', 'eesim.js'));
const TS = require(path.join(REPO, 'src', 'plan', 'truthset.js'));
const C = require(path.join(REPO, 'src', 'common.js'));
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const root = arg('root', process.env.EEAT_TRUTH_ROOT || 'C:\\Users\\super\\eeautotas');
const outDir = arg('out', path.join(REPO, 'src', 'out', 'n4plan', 'understand', 'semantics'));
const NR = +arg('routes', 40), PER = +arg('per', 8), HOR = +arg('horizon', 400);
const all = TS.knownRoutes({ root });
// one route per level (the smallest file), spread over the list
const byName = new Map();
for (const e of all) if (!byName.has(e.name)) byName.set(e.name, e);
const pick = [...byName.values()].filter((e, k, a) => k % Math.max(1, Math.floor(a.length / NR)) === 0).slice(0, NR);
const PERT = [['px', 1e-12], ['px', 1e-6], ['px', 1 / 1024], ['px', 1 / 16], ['px', 0.5], ['px', 1], ['vx', 1e-12], ['vx', 1e-6], ['vx', 1 / 1024], ['vx', 1 / 16], ['py', 1 / 1024], ['py', 1], ['vy', 1e-12], ['vy', 1 / 1024], ['vy', 1 / 16]];
const FIELD = { px: 'px', py: 'py', vx: 'speed_x', vy: 'speed_y' };
const res = new Map();   // pert key -> {n, conv, convT: [], fin, sameT, lost: []}
const frac = { states: 0, pxWhole: 0, pyWhole: 0, pxDen: new Map(), vx0: 0 };
const denOf = (x) => { const f = x - Math.floor(x); if (f === 0) return 1; for (let k = 1; k <= 60; k++) { const s = f * 2 ** k; if (s === Math.floor(s)) return 2 ** k; } return -1; };
let routes = 0;
for (const e of pick) {
	const tr = TS.loadTruth(e);
	if (!tr) continue;
	routes++;
	const L = tr.L, masks = tr.masks, n = masks.length;
	const ev0 = C.evaluate(L, masks, false);
	// reference hashes per tick
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const H = new Array(n + 1);
	H[0] = sim.stateHash();
	const snaps = new Map();
	const ticks = [];
	for (let k = 1; k <= PER; k++) ticks.push(Math.floor((n * k) / (PER + 1)));
	const tset = new Set(ticks);
	for (let t = 0; t < n; t++) {
		if (tset.has(t)) snaps.set(t, sim.snapshot());
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		H[t + 1] = sim.stateHash();
		frac.states++;
		if (sim.px === Math.floor(sim.px)) frac.pxWhole++;
		if (sim.py === Math.floor(sim.py)) frac.pyWhole++;
		if (sim.speed_x === 0) frac.vx0++;
		const d = denOf(sim.px); frac.pxDen.set(d, (frac.pxDen.get(d) || 0) + 1);
	}
	for (const t0 of ticks) {
		for (const [f, d] of PERT) {
			const key = `${f} +${d}`;
			let r = res.get(key);
			if (!r) { r = { n: 0, conv: 0, convT: [], fin: 0, lost: [], dead: 0 }; res.set(key, r); }
			r.n++;
			const s2 = new E.EESim(L); s2.restore(snaps.get(t0));
			s2[FIELD[f]] += d;
			const in2 = new E.EEInput();
			let conv = -1, finished = -1, dead = false;
			for (let t = t0; t < n + 2000; t++) {
				E.applyMask(in2, t < n ? masks[t] & 31 : 0);
				s2.tick(in2);
				if (s2.is_dead) dead = true;
				if (conv < 0 && t + 1 <= n && t + 1 - t0 <= HOR && s2.stateHash() === H[t + 1]) { conv = t + 1 - t0; break; }
				if (s2.has_silver_crown) { finished = t + 1; break; }
			}
			if (conv >= 0) { r.conv++; r.convT.push(conv); r.fin++; }
			else if (finished > 0) { r.fin++; r.lost.push(finished - ev0.complete); }
			if (dead) r.dead++;
		}
	}
}
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const L2 = [`# Precision: perturbations of an exact route state (${routes} routes, ${PER} ticks each, the route's own inputs after)`, '',
	'| perturbation | cases | re-converged to the exact route state | median / p90 ticks to re-converge | still finish | finish but lost ticks (median / max) | died on the way |', '|---|---|---|---|---|---|---|'];
for (const [k, r] of res) {
	const notConvFin = r.fin - r.conv;
	L2.push(`| ${k} | ${r.n} | ${r.conv} (${(100 * r.conv / r.n).toFixed(0)}%) | ${q(r.convT, 0.5)} / ${q(r.convT, 0.9)} | ${r.fin} (${(100 * r.fin / r.n).toFixed(0)}%) | ${notConvFin}: ${q(r.lost, 0.5)} / ${r.lost.length ? Math.max(...r.lost) : '-'} | ${r.dead} |`);
}
const dens = [...frac.pxDen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, c]) => `${d === -1 ? 'non-dyadic(<2^-60)' : '1/' + d}: ${(100 * c / frac.states).toFixed(1)}%`).join(', ');
L2.push('', `Sub-pixel census of ${frac.states} route states: px whole ${(100 * frac.pxWhole / frac.states).toFixed(1)}%, py whole ${(100 * frac.pyWhole / frac.states).toFixed(1)}%, vx = 0 ${(100 * frac.vx0 / frac.states).toFixed(1)}%; px's fractional part as a dyadic fraction (denominator): ${dens}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'precision.md'), L2.join('\n') + '\n');
console.log(L2.join('\n'));
