'use strict';
// Summaries of tools/math/sepcheck.js outputs: node tools/math/sepsum.js <routes|free|trans|ground>.json ...
const fs = require('fs');
const R = require('../../src/math/regime.js');
const BITS = ['CORNER', 'ONEWAY', 'PORTAL', 'STUCK', 'DOORQ', 'DEAD', 'EFFECT', 'GOD', 'XHIT+', 'XHIT-', 'YHIT+', 'YHIT-', 'ALIGNX', 'ALIGNY',
	'HALFCUR', 'ICEMEM', 'ENVCHG', 'GROUND', 'JUMP', 'MISS', 'TRI_XY', 'TRI_YX', 'NEAR'];
const pct = (a, b) => (b ? (100 * a / b).toFixed(2) + '%' : '-');

function routes(d) {
	const r = d.results.filter((x) => x && !x.error && !x.stale);
	const err = d.results.filter((x) => x && x.error), stale = d.results.filter((x) => x && x.stale);
	const tot = { ticks: 0, sep: 0, sepExact: 0, sepMiss: 0, allExact: 0, envChanges: 0, tri: 0, triExact: 0, triMiss: 0 };
	const bits = {}, bitExact = {}, byCur = {}, modes = {}, m18 = { tested: 0, sepMasks: 0, violX: 0, violY: 0, groupsX: 0, groupsY: 0 };
	const free = { n: 0, sum: 0, ge10: 0, ge30: 0 }, sepr = { n: 0, sum: 0, ge10: 0, ge30: 0 };
	const legs = { pure: { n: 0, ticks: 0 }, switch: { n: 0, ticks: 0 }, tri: { n: 0, ticks: 0 }, coupled: { n: 0, ticks: 0 },
		takeoff: { product: 0, tri: 0, coupled: 0 }, landing: { product: 0, tri: 0, coupled: 0 }, n: 0, sum: 0, ge10: 0, ge30: 0 };
	const perRoute = [];
	for (const x of r) {
		for (const k of Object.keys(tot)) tot[k] += x[k] || 0;
		for (const [b, n] of Object.entries(x.bits)) bits[b] = (bits[b] || 0) + n;
		for (const [b, n] of Object.entries(x.bitExact || {})) bitExact[b] = (bitExact[b] || 0) + n;
		for (const [c, g] of Object.entries(x.byCur)) { const a = byCur[c] || (byCur[c] = { ticks: 0, sep: 0, free: 0 }); a.ticks += g.ticks; a.sep += g.sep; a.free += g.free; }
		for (const [m, n] of Object.entries(x.modes)) modes[m] = (modes[m] || 0) + n;
		if (x.m18) for (const k of Object.keys(m18)) m18[k] += x.m18[k] || 0;
		for (const k of ['n', 'sum', 'ge10', 'ge30']) { free[k] += x.freeRuns[k]; sepr[k] += x.sepRuns[k]; }
		if (x.legs) {
			for (const c of ['pure', 'switch', 'tri', 'coupled']) { legs[c].n += x.legs[c].n; legs[c].ticks += x.legs[c].ticks; }
			for (const e of ['takeoff', 'landing']) for (const w of ['product', 'tri', 'coupled']) legs[e][w] += x.legs[e][w];
			legs.n += x.legs.len.n; legs.sum += x.legs.len.sum; legs.ge10 += x.legs.len.ge10; legs.ge30 += x.legs.len.ge30;
		}
		perRoute.push({ name: x.name, ticks: x.ticks, sep: x.sep / x.ticks, miss: x.sepMiss });
	}
	console.log(`routes: ${r.length} replayed (${stale.length} stale, ${err.length} errors), ${tot.ticks} ticks`);
	console.log(`  separable ticks ${tot.sep} (${pct(tot.sep, tot.ticks)}); per-axis model = engine on ${tot.sepExact} of them, MISSES ${tot.sepMiss}; model exact on ${tot.allExact} of all ticks (${pct(tot.allExact, tot.ticks)})`);
	console.log(`  triangular ticks (one axis's collisions depend on the other's sub-steps, nothing else coupled) ${tot.tri} (${pct(tot.tri, tot.ticks)}): the independent axis = its 1D map on ${tot.triExact}, misses ${tot.triMiss}`);
	console.log(`  environment changes ${tot.envChanges} (${pct(tot.envChanges, tot.ticks)} of ticks)`);
	console.log('  bits: ' + Object.entries(bits).map(([b, n]) => `${BITS[b]} ${n} (${pct(n, tot.ticks)})`).join(', '));
	console.log('  coupling bits where the per-axis model is still exact: ' + Object.entries(bits).filter(([b]) => +b < 8 || +b === 20 || +b === 21).map(([b, n]) => `${BITS[b]} ${bitExact[b] || 0}/${n} (${pct(bitExact[b] || 0, n)})`).join(', '));
	console.log('  separable modes: ' + Object.entries(modes).map(([m, n]) => `${m} ${n} (${pct(n, tot.ticks)})`).join(', '));
	console.log('  by centre class: ' + Object.entries(byCur).sort((a, b) => b[1].ticks - a[1].ticks).map(([c, g]) => `${c} ${g.ticks} (sep ${pct(g.sep, g.ticks)}, free ${pct(g.free, g.ticks)})`).join('; '));
	console.log(`  free-uniform runs (sep, both axes free, no env change / align / ice): ${free.n} runs, ${free.sum} ticks (${pct(free.sum, tot.ticks)}), >= 10 ticks ${free.ge10}, >= 30 ticks ${free.ge30}`);
	console.log(`  separable constant-env runs: ${sepr.n} runs, ${sepr.sum} ticks, mean ${(sepr.sum / Math.max(1, sepr.n)).toFixed(1)}, >= 10 ${sepr.ge10}, >= 30 ${sepr.ge30}`);
	if (legs.n) {
		console.log(`  legs (support to support): ${legs.n}, ${legs.sum} ticks, mean ${(legs.sum / legs.n).toFixed(1)}, >= 10 ticks ${legs.ge10}, >= 30 ticks ${legs.ge30}; interior ` +
			['pure', 'switch', 'tri', 'coupled'].map((c) => `${c} ${legs[c].n} (${pct(legs[c].n, legs.n)} of legs, ${pct(legs[c].ticks, legs.sum)} of leg ticks)`).join(', '));
		console.log(`  take-off ticks: ${JSON.stringify(legs.takeoff)}; landing ticks: ${JSON.stringify(legs.landing)}`);
	}
	console.log(`  18 masks:${m18.tested} states, ${m18.sepMasks} separable (state, mask) ticks, ${m18.groupsX} x groups, ${m18.groupsY} y groups, violations x ${m18.violX} y ${m18.violY}`);
	const misses = r.filter((x) => x.sepMiss > 0);
	for (const x of misses.slice(0, 10)) console.log('  MISS', x.name, x.sepMiss, JSON.stringify(x.miss[0]));
	if (err.length) console.log('  error:', err[0].error.slice(0, 400));
	return { tot, bits, modes, byCur, free, sepr, m18 };
}

function free(d) {
	const r = d.results.filter((x) => x && !x.error);
	const by = {};
	for (const x of r) {
		const a = by[x.env] || (by[x.env] = { starts: 0, runs: 0, ticks: 0, missX: 0, missY: 0, left: 0, nx: x.nx, ny: x.ny });
		a.starts++; a.runs += x.runs; a.ticks += x.ticks; a.missX += x.missX; a.missY += x.missY; a.left += x.left;
	}
	let runs = 0, ticks = 0, mx = 0, my = 0;
	for (const [e, a] of Object.entries(by)) {
		console.log(`  ${e.padEnd(30)} starts ${a.starts}  |PX| ${a.nx} x |PY| ${a.ny}  runs ${a.runs}  ticks ${a.ticks}  missX ${a.missX} missY ${a.missY} border ${a.left}`);
		runs += a.runs; ticks += a.ticks; mx += a.missX; my += a.missY;
	}
	console.log(`free: ${r.length} starts, ${runs} runs, ${ticks} ticks, missX ${mx}, missY ${my}; errors ${d.results.length - r.length}`);
}

function trans(d) {
	const agg = {};
	for (const x of d.results) {
		if (!x || x.error) continue;
		for (const [k, c] of Object.entries(x.cat)) {
			const key = x.axis + (x.lowg ? ' lowgrav' : '') + ' | ' + k;
			const a = agg[key] || (agg[key] = { n: 0, same: 0, maxAbs: 0 });
			a.n += c.n; a.same += c.same; a.maxAbs = Math.max(a.maxAbs, c.maxAbs);
		}
	}
	for (const [k, a] of Object.entries(agg).sort()) console.log(`  ${k.padEnd(60)} ${a.n} trajectory pairs, identical offsets ${a.same} (${pct(a.same, a.n)}), max |diff| ${a.maxAbs.toExponential(3)} px`);
}

function ground(d) {
	for (const x of d.results) if (x) console.log(`  ${x.gap ? 'floor with a gap' : 'flat floor'} seed ${x.seed} x0 ${x.px0} vx0 ${x.vx0}: ${x.runs} runs ${x.ticks} ticks, x differs ${x.missX}, y differs ${x.missY}`);
}

for (const f of process.argv.slice(2)) {
	const d = JSON.parse(fs.readFileSync(f, 'utf8'));
	console.log(`== ${f} (${d.job}, ${(d.ms / 1000).toFixed(1)} s)`);
	({ routes, free, trans, ground })[d.job](d);
}
