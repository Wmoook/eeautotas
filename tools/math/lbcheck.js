'use strict';
// THE MATH BOUND AGAINST THE REAL ROUTES (n4-math, Build / bounds): every known route of the truthset replayed by the
// engine, cut into the moves study's legs (src/out/n4plan/understand/moves/exact_jsonl: support to support, 49,846
// moves), and at EVERY tick t of every leg the bound of src/math/lb.js from the engine's exact state to the leg's end
// (the centre tile at t1; mode 'land' when the leg ends on a landing, else 'touch') checked against the route's own
// ticks: lb(t) <= t1 - t. A violation is a bound above what the route did (never allowed). Tightness = lb / actual at the
// leg start; a leg whose route time equals the bound is PROVEN OPTIMAL from its start state.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/lbcheck.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--limit=N] [--only=<name part>] [--every=1] [--cap=4000] [--adm=1]   then: node tools/math/lbcheck.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const LB = require('../../src/math/lb.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/math/lbcheck';
fs.mkdirSync(OUT, { recursive: true });
const EVERY = argv.every !== '0';
const CAP = +(argv.cap || 4000);
const USE_ADM = argv.adm === '1';
const SOLVE = argv.solve === '1';
const SOLVE_MS = +(argv.solveMs || 400);
const LS = require('../../src/math/legsolve.js');
// --solver=msolve: the move solver of n4-math (src/plan/msolve.js) finds the leg's T (cheapest first); its own plain bound
// (lowerBound) is recorded next to this bound for the comparison
const SOLVER = argv.solver || 'legsolve';
let MS = null;
if (SOLVER === 'msolve' || argv.msb === '1') { try { MS = require('../../src/plan/msolve.js'); } catch (e) { console.error('msolve: ' + e.message); } }

function loadMoves(dir) {
	const byR = new Map(), names = new Map();
	for (const f of fs.readdirSync(dir)) {
		const full = path.join(dir, f);
		if (/^moves_\d+\.jsonl$/.test(f)) {
			for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
				if (!line) continue;
				const m = JSON.parse(line);
				if (!byR.has(m.r)) byR.set(m.r, []);
				byR.get(m.r).push(m);
			}
		} else if (/^routes_\d+\.jsonl$/.test(f)) {
			for (const line of fs.readFileSync(full, 'utf8').split('\n')) { if (line) { const r = JSON.parse(line); if (r.idx !== undefined) names.set(r.idx, r); } }
		}
	}
	return { byR, names };
}

const MV = loadMoves(argv.moves);
const list = TS.knownRoutes({});
const outFile = path.join(OUT, `lb_${SH}.jsonl`);
fs.writeFileSync(outFile, '');
let done = 0;
for (let r = 0; r < list.length; r++) {
	if (r % NSH !== SH) continue;
	if (argv.limit && done >= +argv.limit) break;
	const e = list[r];
	if (argv.only && !e.name.toLowerCase().includes(argv.only.toLowerCase())) continue;
	const meta = MV.names.get(r);
	if (meta && meta.name !== e.name) { console.error(`route ${r}: name mismatch ${meta.name} vs ${e.name}`); continue; }
	const moves = MV.byR.get(r) || [];
	const t0 = Date.now();
	let res;
	try { res = runRoute(e, moves); } catch (err) { res = { error: String(err && err.stack || err) }; }
	res.r = r; res.name = e.name; res.ms = Date.now() - t0;
	fs.appendFileSync(outFile, JSON.stringify(res) + '\n');
	done++;
	console.log(`${String(r).padStart(3)} ${e.name.slice(0, 28).padEnd(28)} ${res.error ? 'ERR ' + res.error.split('\n')[0] : `legs ${res.legs.length} checks ${res.checks} viol ${res.viol} nulls ${res.nulls} capped ${res.capped} ${(res.ms / 1000).toFixed(1)}s`}`);
}

function runRoute(entry, moves) {
	const tr = TS.loadTruth(entry);
	if (!tr) return { stale: true, legs: [], checks: 0, viol: 0, nulls: 0, capped: 0 };
	const L = tr.L, W = L.width, H = L.height;
	const M = LB.createMathLB(L, { cap: CAP });
	const MSV = MS ? MS.createSolver(L, {}) : null;
	let adm = null;
	if (USE_ADM) adm = require('../../src/plan/admbounds.js').createAdmBounds(L, { memo: 4 });
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const byStart = new Map();
	for (const m of moves) byStart.set(m.t0, m);
	const legs = [], worst = [];
	let checks = 0, viol = 0, nulls = 0, capped = 0, proven = 0;
	let cur = null, tgt = null, field = null;
	const complete = tr.complete;
	for (let t = 0; t <= complete; t++) {
		const m0 = byStart.get(t);
		if (m0) {
			cur = m0;
			tgt = { tiles: [m0.tile1], mode: m0.c1 === 'G' ? 'landing' : 'touch' };
			field = adm ? adm.field([m0.tile1], T.levelNow(L, sim)) : null;
		}
		if (cur && t < cur.t1 && (EVERY || t === cur.t0)) {
			const actual = cur.t1 - t;
			const b = M.leg(sim, tgt, { field, horizon: actual + 1 });
			checks++;
			if (b.lb === null) nulls++;
			else {
				if (b.capped) capped++;
				if (b.lb > actual) { viol++; if (worst.length < 12) worst.push({ t, t0: cur.t0, t1: cur.t1, label: cur.label, mode: tgt.mode, lb: b.lb, actual, why: b.why, px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y, g: sim.on_ground }); }
			}
			if (t === cur.t0) {
				const lbv = b.lb;
				if (lbv !== null && lbv === actual) proven++;
				let tsol = null, sms = 0, mslb = null;
				if (MSV) { try { const snapM = sim.snapshot(); mslb = MSV.lowerBound(snapM, { tiles: [cur.tile1], cls: cur.c1 === 'G' ? 'G' : 'any' }); } catch (e) { mslb = null; } }
				if (SOLVE && lbv !== null && lbv < actual) {
					const snap = sim.snapshot();
					const tm = Date.now();
					if (SOLVER === 'msolve' && MSV) {
						try {
							const r = MSV.leg(snap, { tiles: [cur.tile1], cls: cur.c1 === 'G' ? 'G' : 'any' }, { Tmax: actual });
							if (r && r.ok) tsol = r.T;
						} catch (e) { /* no answer */ }
					} else {
						const r = LS.solveLeg(L, sim, tgt, { lb: lbv, tmax: actual - 1, ms: SOLVE_MS });
						if (r) tsol = r.T;
					}
					sim.restore(snap);
					sms = Date.now() - tm;
					if (tsol !== null && tsol < lbv) { viol++; if (worst.length < 12) worst.push({ t, kind: 'solver below lb', lb: lbv, T: tsol }); }
				}
				legs.push([cur.t0, actual, lbv, cur.label, tgt.mode === 'touch' ? 0 : 1, b.why || '', b.arc === undefined ? null : b.arc, b.tx === undefined ? null : b.tx, b.nodes || 0, tsol, sms, mslb]);
			}
		}
		if (t === complete) break;
		E.applyMask(inp, tr.masks[t] & 31);
		sim.tick(inp);
		if (cur && t + 1 >= cur.t1) cur = null;
	}
	return { W, H, complete, legs, checks, viol, nulls, capped, proven, worst, stats: M.stats() };
}

function aggregate(dir) {
	const rows = [];
	for (const f of fs.readdirSync(dir)) if (/^lb_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
	let checks = 0, viol = 0, nulls = 0, capped = 0, routes = 0, errors = 0;
	const worst = [];
	const byLabel = new Map();
	const add = (k, r) => { if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k).push(r); };
	let proven = 0, legsN = 0, provenPlain = 0, plainN = 0, provenS = 0, provenSFree = 0;
	const FREE = new Set(['hop', 'jump', 'fall', 'walk']);
	for (const r of rows) {
		if (r.error) { errors++; console.log(`ERR ${r.name}: ${r.error.split('\n')[0]}`); continue; }
		if (r.stale) continue;
		routes++; checks += r.checks; viol += r.viol; nulls += r.nulls; capped += r.capped;
		for (const w of r.worst) if (worst.length < 30) worst.push(Object.assign({ name: r.name }, w));
		for (const l of r.legs) {
			const [t0, actual, lbv, label] = l;
			legsN++;
			if (lbv !== null && lbv === actual) proven++;
			if (FREE.has(label)) { plainN++; if (lbv !== null && lbv === actual) provenPlain++; }
			if (lbv === null) { add(label + ':null', 0); continue; }
			const tsol = l[9], mslb = l[11];
			if (mslb !== null && mslb !== undefined) { add('MSLB:ALL', mslb / actual); if (FREE.has(label)) add('MSLB:FREE', mslb / actual); }
			const best = tsol !== null && tsol !== undefined ? Math.min(tsol, actual) : actual;
			const q2 = best === 0 ? 1 : lbv / best;
			add('S:ALL', q2); if (FREE.has(label)) add('S:FREE', q2);
			if (lbv === best) { provenS++; if (FREE.has(label)) provenSFree++; }
			const q = lbv / actual;
			add('ALL', q); add(label, q);
			if (FREE.has(label)) add('FREE', q);
			if (actual >= 10) { add('ALL>=10', q); if (FREE.has(label)) add('FREE>=10', q); }
		}
	}
	const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
	const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
	const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
	console.log(`routes ${routes} errors ${errors} checks ${checks} VIOLATIONS ${viol} nulls ${nulls} (${(100 * nulls / checks).toFixed(1)}%) capped ${capped}`);
	console.log(`legs ${legsN}: proven optimal (route ticks = bound) ${proven} (${(100 * proven / legsN).toFixed(1)}%); free-air legs ${plainN}: proven ${provenPlain} (${(100 * provenPlain / plainN).toFixed(1)}%)`);
	console.log(`with the leg solver (T = lb first): proven optimal ${provenS} legs (${(100 * provenS / legsN).toFixed(1)}%), free-air ${provenSFree} (${(100 * provenSFree / plainN).toFixed(1)}%)`);
	console.log('bound / actual at the leg start (S: = bound / min(solver T, actual)):');
	for (const [k, a] of [...byLabel.entries()].sort()) {
		if (k.endsWith(':null')) { console.log(`  ${k.padEnd(14)} n ${a.length}`); continue; }
		console.log(`  ${k.padEnd(14)} n ${String(a.length).padStart(6)}  p10 ${pct(a, 0.1).toFixed(3)}  median ${med(a).toFixed(3)}  p90 ${pct(a, 0.9).toFixed(3)}  mean ${mean(a).toFixed(3)}  =1 ${(100 * a.filter((q) => q === 1).length / a.length).toFixed(1)}%`);
	}
	if (worst.length) { console.log('violations:'); for (const w of worst) console.log('  ' + JSON.stringify(w)); }
	fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ routes, errors, checks, viol, nulls, capped, proven, legsN, provenPlain, plainN, provenS, provenSFree, worst,
		ratios: Object.fromEntries([...byLabel.entries()].filter(([k]) => !k.endsWith(':null')).map(([k, a]) => [k, { n: a.length, p10: pct(a, 0.1), median: med(a), p90: pct(a, 0.9), mean: mean(a), eq1: a.filter((q) => q === 1).length }])) }, null, 1));
}
