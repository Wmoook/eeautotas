'use strict';
// Random portals in EE Offline: a portal whose target id has several exits picks one with Math.random, so a TAS through
// it only works with some outcomes. analyze() replays a run under every combination of outcomes (a small tree: one
// branch per exit at each random draw, ~20 ms per replay) and reports:
//   chance      - probability that the run finishes in EEO (sum over finishing outcome paths of prod 1/exits)
//   bestScript  - the outcome path with the fastest finish (the optimizer simulates with this script, see eesim.js)
//   uses        - along bestScript: each random portal (tick, run time, position, exits, how many exits still finish)
// usage (CLI): node src/rng.js <file.eetas> [--level=<level id | job id>]   (--level optional inside src/jobs/<id>/)
const E = require('./eesim.js');

const fmt = (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`;

// one replay with a fixed outcome script; stops at the first draw beyond the script
function play(level, masks, script) {
	const lv = Object.assign({}, level, { rngScript: Int32Array.from(script) });
	const sim = new E.EESim(lv);
	sim.reset();
	sim.rngNeed = 0;
	const inp = new E.EEInput();
	let complete = -1, deaths = 0, lastPortal = null;
	const draws = [];   // per draw along this play: {tick, run, from, to}
	let steps = sim._rngSteps;
	sim.onEvent = (k, d) => {
		if (k === 'complete' && complete < 0) complete = sim.ticks();
		else if (k === 'death') deaths++;
		else if (k === 'portal') lastPortal = d;
	};
	for (let t = 0; t < masks.length && complete < 0; t++) {
		E.applyMask(inp, masks[t]);
		lastPortal = null;
		sim.tick(inp);
		if (sim._rngSteps !== steps) {
			steps = sim._rngSteps;
			draws.push({ tick: sim.ticks(), run: sim.run_ticks, from: lastPortal && lastPortal.from, to: lastPortal && lastPortal.to });
		}
		if (sim.rngNeed) return { need: sim.rngNeed, draws, tick: sim.ticks() };
	}
	return { complete, runTicks: complete >= 0 ? sim.run_ticks : null, deaths, draws };
}

function analyze(level, masks, opts) {
	const maxPlays = (opts && opts.maxPlays) || 4000;
	let plays = 0, truncated = false;
	const leaves = [];
	const nodes = new Map();   // script prefix (string) -> {n, draw}
	function dfs(script, prob) {
		if (plays >= maxPlays) { truncated = true; return; }
		plays++;
		const r = play(level, masks, script);
		if (r.need) {
			nodes.set(script.join(','), { n: r.need, draw: r.draws[r.draws.length - 1] });
			for (let c = 0; c < r.need; c++) dfs(script.concat([c]), prob / r.need);
		} else leaves.push({ script, prob, complete: r.complete, runTicks: r.runTicks, deaths: r.deaths, draws: r.draws });
	}
	dfs([], 1);
	const ok = leaves.filter((l) => l.complete >= 0);
	const chance = ok.reduce((a, l) => a + l.prob, 0);
	if (ok.length === 0) return { draws: nodes.size > 0, chance: 0, bestScript: null, bestRunTicks: null, uses: [], truncated, plays };
	const best = ok.reduce((x, y) => (y.runTicks < x.runTicks || (y.runTicks === x.runTicks && y.prob > x.prob) ? y : x));
	// along the best outcome path: at each draw, how many exits still lead to a finish (and the chance from there)
	const chanceUnder = (prefix) => ok.filter((l) => prefix.every((c, i) => l.script[i] === c)).reduce((a, l) => a + l.prob, 0);
	const uses = [];
	for (let k = 0; k < best.script.length; k++) {
		const pre = best.script.slice(0, k);
		const node = nodes.get(pre.join(','));
		const reach = pre.reduce((p, c, i) => p / nodes.get(best.script.slice(0, i).join(',')).n, 1);
		let working = 0;
		for (let c = 0; c < node.n; c++) if (chanceUnder(pre.concat([c])) > 0) working++;
		const d = best.draws[k] || node.draw || {};
		uses.push({ index: k, tick: d.tick, run: d.run, time: d.run != null ? fmt(d.run) : null, from: d.from || null, exit: d.to || null,
			exits: node.n, working, conditional: working / node.n,
			reach });
	}
	return { draws: nodes.size > 0, chance, bestScript: best.script, bestRunTicks: best.runTicks, uses, truncated, plays,
		outcomes: ok.map((l) => ({ script: l.script, prob: l.prob, runTicks: l.runTicks })) };
}

module.exports = { analyze, play };

if (require.main === module) {
	const args = process.argv.slice(2);
	const file = args.find((x) => !x.startsWith('--'));
	const lid = (args.find((x) => x.startsWith('--level=')) || '--level=').slice(8);
	const C = require('./common.js');   // (lazily: common.js requires this file)
	if (!file) { console.log('usage: node src/rng.js <file.eetas> [--level=<level id | job id>]'); process.exit(1); }
	const level = E.loadLevel(C.levelData(lid, file));
	const masks = C.readEetas(file);
	const r = analyze(level, masks);
	console.log(`[rng] ${r.plays} replays; chance to finish in EEO: ${(r.chance * 100).toFixed(1)}%${r.truncated ? ' (tree truncated)' : ''}; ` +
		`best outcome path [${(r.bestScript || []).join(',')}] -> ${r.bestRunTicks != null ? fmt(r.bestRunTicks) : 'no finish'}`);
	for (const u of r.uses) console.log(`[rng]   ${u.time} (tick ${u.tick}): random portal at ${JSON.stringify(u.from)}, ${u.exits} exits, ` +
		`${u.working} of them still finish (${(100 * u.working / u.exits).toFixed(0)}%)`);
}
