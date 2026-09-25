'use strict';
// Splices TAS runs at exactly equal states: if run A at tick i is in the same state (EESim.stateKey) as run B at
// tick j, then A[0..i) + B[j..] behaves exactly like B from j on, finishing (j - i) ticks sooner than B does.
// Given several runs that all complete the level, finds the fastest combination (dynamic programming over
// (run, tick) with jumps between equal states) and writes it, verified by a clean replay.
// usage: node tools/tas/splice.js out.eetas run1.eetas run2.eetas ... [--level=forgotten_veil]
const fs = require('fs');
const path = require('path');
const E = require('./eesim.js');
const args = process.argv.slice(2);
const level = (args.find((a) => a.startsWith('--level=')) || '--level=forgotten_veil').slice(8);
const files = args.filter((a) => !a.startsWith('--'));
const NOCOINS = args.includes('--nocoins');   // join at states equal apart from collected coins (coins are optional)
const keyOf = (sim) => (NOCOINS ? sim.stateHash(false, true) : sim.stateKey());
const outFile = files.shift();
const L = E.loadLevel(path.join(__dirname, 'data', level + '.json'));

function trace(masks) {
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	let complete = -1;
	sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); };
	const keys = [keyOf(sim)];
	for (let t = 0; t < masks.length && complete < 0; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); keys.push(keyOf(sim)); }
	return { keys, complete, runTicks: sim.run_ticks };
}
const runs = files.map((f) => { const m = E.parseEetas(fs.readFileSync(f, 'utf8')); const tr = trace(m); return { f, m, ...tr }; })
	.filter((r) => { if (r.complete < 0) console.log(`[splice] ${r.f} does not complete, skipped`); return r.complete >= 0; });
for (const r of runs) console.log(`[splice] ${path.basename(r.f)}: completes at ${r.complete}, run_ticks ${r.runTicks}`);
// Shortest path over states: V(state) = fewest ticks from that state to the finish, using any run's next input from
// any occurrence of the state (Bellman-Ford style passes until nothing improves). Chains through runs freely:
// run A's faster stretch, then back into run B for B's faster rest.
const V = new Map(), succ = new Map();
for (const r of runs) V.set(r.keys[r.keys.length - 1], 0);
for (let pass = 0, changed = true; changed && pass < 50; pass++) {
	changed = false;
	for (let ri = 0; ri < runs.length; ri++) {
		const r = runs[ri];
		for (let t = r.keys.length - 2; t >= 0; t--) {
			const nx = V.get(r.keys[t + 1]);
			if (nx === undefined) continue;
			const cur = V.get(r.keys[t]);
			if (cur === undefined || nx + 1 < cur) { V.set(r.keys[t], nx + 1); succ.set(r.keys[t], { run: ri, tick: t }); changed = true; }
		}
	}
}
const seq = [];
const jumps = [];
let key = runs[0].keys[0], lastRun = -1;
for (let guard = 0; V.get(key) > 0 && guard < 1e6; guard++) {
	const st = succ.get(key);
	if (st.run !== lastRun) { jumps.push(`${path.basename(runs[st.run].f)}@${st.tick}`); lastRun = st.run; }
	seq.push(runs[st.run].m[st.tick]);
	key = runs[st.run].keys[st.tick + 1];
}
const v = trace(seq);
console.log(`[splice] path: ${jumps.join(' -> ')} (${jumps.length - 1} splices)`);
console.log(`[splice] result: completes at ${v.complete}, run_ticks ${v.runTicks}`);
if (v.complete >= 0) fs.writeFileSync(outFile, seq.map((m) => String.fromCharCode(48 + m)).join(''));
