'use strict';
// THE ROUTE PROOF with a longer clock (n5-perfect, part 4): the compile's prove stage (strategy.js PROVE) as a tool, on the
// exact tier directly (src/plan/exact.js exactLeg: every input sequence tick by tick, states merged by stateHash, the
// endgame's admissible bound as the cut), with the clock and the layer cap given here. The run timer starts at the first
// input, so waiting is free; the start rests after R idle ticks. The route costs C = its arrival tick - its idle ticks. From
// each S_k (the start after k = 0..R idle ticks) one exhaustive search to the trophy bounded by the absolute tick k + C - 1:
// every route whose first input is at tick k' <= R is in S_k' 's search, one that waits longer is one that waits R, shifted.
// All R + 1 searches exhausted = PROVEN OPTIMAL (no route finishes with fewer run ticks); a search that finds the trophy
// sooner = a faster route (replayed, written). The exact search drops dying runs: the proof counts only where nothing
// kills (goexplore.js deathsOf null), else it is "optimal among the routes without a death" and says so.
//   node tools/perfect/proveroute.js <level.eelvl> <route.eetas> [--seconds=120] [--cap=2000000] [--out=<faster.eetas>]
const path = require('path');
const C = require('../../src/common.js');
const E = C.E;
const T = require('../../src/plan/types.js');
const X = require('../../src/plan/exact.js');

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? '1' : m[2]]; }));
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function proveRoute(L, masks, o) {
	const ev = C.evaluate(L, masks);
	if (!ev) return { verdict: 'error', why: 'the route does not finish' };
	masks = ev.ms;
	let kStar = 0;
	while (kStar < masks.length && masks[kStar] === 0) kStar++;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let A = -1;
	for (let n = 0; n < masks.length; n++) { E.applyMask(inp, masks[n]); sim.tick(inp); if (!sim.is_dead && sim.has_silver_crown) { A = n + 1; break; } }
	const Cost = A - kStar;
	// the idle ticks until the start rests
	let R = -1;
	{
		sim.reset();
		let h = sim.stateHash();
		for (let k = 0; k <= 64; k++) { E.applyMask(inp, 0); sim.tick(inp); if (sim.is_dead) break; const h2 = sim.stateHash(); if (h2 === h) { R = k; break; } h = h2; }
	}
	if (R < 0) return { verdict: 'unsupported', why: 'the start does not rest within 64 idle ticks', runTicks: ev.runTicks };
	let noDeath = false;
	try { noDeath = require('../../src/goexplore.js').deathsOf(L) === null; } catch (e) { noDeath = false; }
	const B = X.boundFor(L, { kind: 'trophy', tiles: [] });
	const goal = { kind: 'trophy', tiles: Int32Array.from(B.cells), test: (s) => !!s.has_silver_crown, allowDeath: false };
	const t0 = Date.now(), deadline = t0 + (o.seconds || 120) * 1000;
	const starts = [];
	let proved = 0, faster = null, lbMin = Infinity;
	const why = [];
	for (let k = 0; k <= R; k++) {
		const ms = Math.max(200, (deadline - Date.now()) / (R + 1 - k));
		sim.reset();
		for (let i = 0; i < k; i++) { E.applyMask(inp, 0); sim.tick(inp); }
		const st = [{ snap: sim.snapshot(), tick: k }];
		const r = X.exactLeg(L, st, goal, { maxDepth: Cost - 1, beforeTick: k + Cost - 1, cap: o.cap || 2000000, deadline: Date.now() + ms, allowDeath: false, B, collect: 1 });
		starts.push({ k, status: r.status, depth: r.depth, layers: r.stats ? r.stats.layers : undefined, states: r.stats ? r.stats.states || r.stats.seen : undefined });
		if (r.status === 'found') {
			const cand = T.concat(new Uint8Array(k), r.tail);
			const e2 = C.evaluate(L, cand);
			if (e2 && e2.runTicks < ev.runTicks) { faster = { masks: e2.ms, runTicks: e2.runTicks, k }; break; }
			why.push(`start +${k}: a goal found but not faster on its replay`);
		} else if (r.status === 'proof') proved++;
		else { why.push(`start +${k}: ${r.status}`); lbMin = Math.min(lbMin, 0); }
	}
	const verdict = faster ? 'faster' : proved === R + 1 ? (noDeath ? 'optimal' : 'optimal without deaths') : 'open';
	return { verdict, runTicks: ev.runTicks, cost: Cost, idle: kStar, restIdle: R, noDeath, proved, starts, faster, why, ms: Date.now() - t0 };
}

if (require.main === module) {
	const L = T.loadLevelFile(pos[0]);
	const r = proveRoute(L, C.readEetas(pos[1]), { seconds: +argv.seconds || 120, cap: +argv.cap || 2000000 });
	if (r.faster && argv.out) C.writeEetas(path.resolve(argv.out), r.faster.masks);
	console.log(JSON.stringify(Object.assign({}, r, { faster: r.faster ? { runTicks: r.faster.runTicks, k: r.faster.k } : null })));
}
module.exports = { proveRoute };
