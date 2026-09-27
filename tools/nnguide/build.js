'use strict';
// The neural-guidance dataset from bundle/ (catalog.js): per sampled state the scalar features (feat.js), the level
// patch reference (a class grid per (level, door state) + the door-aware walking distance to the trophy per tile), and
// the label: kind 0 = on a finishing route (ticks to go along it), 1 = a random excursion from the level's best route
// (a LOWER bound: ticks to go of the route state it left minus the ticks it took), 2 = a state of a search attempt that
// never finished, 3 = the evaluation routes (every tick; the judge's routes of the held-out levels), 4 = the best
// route's own state at the tick an excursion (the sample before it) ended: the pair it should not beat.
//   node tools/nnguide/build.js [--bundle=bundle] [--out=ds] (both in src/out/nnguide, NN_WORK) [--perGroup=120000] [--rollPerGroup=120000] [--only=lv,..] [--seed=1]
const fs = require('fs');
const path = require('path');
const F = require('./feat.js');
const { C, E, RF } = F;
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const WORK = process.env.NN_WORK || path.join(__dirname, '..', '..', 'src', 'out', 'nnguide');   // (the data stays out of git)
const BUNDLE = path.resolve(WORK, arg('bundle', 'bundle'));
const OUT = path.resolve(WORK, arg('out', 'ds'));
const PER = +arg('perGroup', 120000), ROLL = +arg('rollPerGroup', 120000), ATT = +arg('attPerGroup', 30000);
const only = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
let seed = +arg('seed', 1) >>> 0;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cat = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'catalog.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const groups = [...new Set(cat.map((c) => c.group))];
const W = F.writer(OUT);
const t00 = Date.now();
for (const g of groups) {
	const lvs = cat.filter((c) => c.group === g && (!only || only.has(c.lv) || only.has(g)));
	if (!lvs.length) continue;
	const gi = groups.indexOf(g);
	const totalRoute = lvs.reduce((s, c) => s + c.routes.reduce((a, r) => a + r.ticks, 0), 0);
	const totalAtt = lvs.reduce((s, c) => s + c.attempts.reduce((a, r) => a + r.ticks, 0), 0);
	const stride = Math.max(1, totalRoute / PER), astride = Math.max(1, totalAtt / ATT);
	// rollouts only from each job level's best route (TAS quality: its ticks to go are near the optimum)
	const rollLvs = lvs.filter((c) => c.lv.startsWith('job_') && c.routes.length);
	const rollPer = rollLvs.length ? Math.ceil(ROLL / rollLvs.length) : 0;
	let nR = 0, nB = 0, nA = 0, nE = 0;
	for (const c of lvs) {
		const L = E.prepareLevel(JSON.parse(fs.readFileSync(path.join(BUNDLE, 'levels', c.lv + '.json'), 'utf8')));
		const ctx = W.levelCtx(L, null, c.lv);
		const sim = new E.EESim(L);
		const inp = new E.EEInput();
		const rdir = path.join(BUNDLE, 'routes', c.lv);
		c.routes.forEach((r, ri) => {
			const ms = C.readEetas(path.join(rdir, r.name));
			const T = ms.length;
			const isEval = !!r.eval;
			let next = rnd() * stride;
			sim.reset();
			for (let t = 0; t <= T; t++) {
				if (t > 0) { E.applyMask(inp, ms[t - 1]); sim.tick(inp); }
				if (isEval) { W.add(ctx, sim, { kind: 3, ttg: T - t, group: gi, route: ri, t }); nE++; }
				if (t >= next) { next += stride * (0.5 + rnd()); if (!sim.is_dead) { W.add(ctx, sim, { kind: 0, ttg: T - t, group: gi, route: ri, t }); nR++; } }
			}
			if (isEval) console.log(`  eval ${g}: ${c.lv} ${r.name} ${T} ticks`);
		});
		// excursions from the best route: random runs like the CPU search's (keep the input with p 0.85), 10 .. 640 ticks
		if (rollPer && c.lv.startsWith('job_')) {
			const best = c.routes.reduce((a, r) => (r.ticks < a.ticks ? r : a));
			const ms = C.readEetas(path.join(rdir, best.name));
			const T = ms.length;
			sim.reset();
			const snaps = [];
			const every = 25;
			for (let t = 0; t <= T; t++) { if (t % every === 0) snaps.push(sim.snapshot()); if (t < T) { E.applyMask(inp, ms[t]); sim.tick(inp); } }
			for (let k = 0; k < rollPer; k++) {
				const t0 = Math.min(T - 1, Math.floor(rnd() * T));
				sim.restore(snaps[Math.floor(t0 / every)]);
				for (let t = Math.floor(t0 / every) * every; t < t0; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
				const len = Math.round(10 * Math.pow(64, rnd()));
				let m = F.OPTIONS[(rnd() * 18) | 0];
				let dead = false;
				for (let s = 0; s < len; s++) {
					if (rnd() >= 0.85) m = F.OPTIONS[(rnd() * 18) | 0];
					E.applyMask(inp, m); sim.tick(inp);
					if (sim.is_dead || sim.has_silver_crown) { dead = true; break; }
				}
				if (dead || t0 + len > T) continue;
				const lb = T - t0 - len;
				W.add(ctx, sim, { kind: 1, ttg: lb, group: gi, route: -1, t: t0 + len });
				// its twin: the best route's own state len ticks after t0 (the excursion should not look better)
				const t1 = t0 + len;
				sim.restore(snaps[Math.floor(t1 / every)]);
				for (let t = Math.floor(t1 / every) * every; t < t1; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); }
				W.add(ctx, sim, { kind: 4, ttg: lb, group: gi, route: -1, t: t1 });
				nB++;
			}
		}
		// search attempts that never finished
		c.attempts.forEach((r, ri) => {
			const ms = C.readEetas(path.join(rdir, r.name));
			let next = rnd() * astride;
			sim.reset();
			for (let t = 0; t <= ms.length; t++) {
				if (t > 0) { E.applyMask(inp, ms[t - 1]); sim.tick(inp); }
				if (t >= next) { next += astride * (0.5 + rnd()); if (!sim.is_dead) { W.add(ctx, sim, { kind: 2, ttg: -1, group: gi, route: ri, t }); nA++; } }
			}
		});
	}
	console.log(`${g}: ${lvs.length} levels, routes ${totalRoute} ticks (stride ${stride.toFixed(1)}): ${nR} route, ${nB} excursion, ${nA} attempt, ${nE} eval samples; ${((Date.now() - t00) / 1000).toFixed(1)} s`);
}
W.finish({ groups });
console.log(`done: ${W.n} samples, ${W.nGrids} grids, ${((Date.now() - t00) / 1000).toFixed(1)} s`);
