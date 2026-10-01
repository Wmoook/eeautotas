'use strict';
// THE LAYER CENSUS (box 7 lane 'proof', cycle 4, 2026-10-01): how hard is a whole-level proof? Breadth first over EXACT engine
// states from every idle start (levelproof.js sourcesOf: run tick 0 = the first input), every input of every tick
// (endgame.probeMasks; the first layer's inputs non-zero), FULL stateHash dedup across layers (a state seen at a layer <= d is
// the same state with no more run ticks: dropped), deaths kept where the level kills; with --C a state at layer d is cut when
// d + h > C (h = wholepar.js's max of the tiers: the same cut the proof makes). Per layer: the distinct states, the cut, the
// merged, the growth over the last layer. Every layer it prints is a census of EVERY state an exact proof at that C must
// visit at that depth (the DFS's table merges the same states), so the growth tells whether the proof can close: Switch
// Labyrinth's contours grew ~3x a layer and closed at 27; a level whose layers grow 8x with 40 ticks of slack cannot.
//   node tools/perfect/layercensus.js <level.eelvl> [--C=<the route's run ticks>] [--tiers=kin,rel,gate] [--maxLayer=2000000]
//        [--layers=200] [--seconds=600]
// Prints JSON lines: {ev 'start'} {ev 'layer', d, states, cut, merged, crown, growth, seen, s, rssGB} {ev 'end', why}.
const T = require('../../src/plan/types.js');
const E = require('../../src/eesim.js');
const EG = require('../../src/endgame.js');
const LP = require('../../src/plan/levelproof.js');
const WP = require('./wholepar.js');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/perfect/layercensus.js <level.eelvl> [--C=] [--tiers=] [--maxLayer=] [--layers=] [--seconds=]'); process.exit(2); }
const L = T.loadLevelFile(file);
const C = args.C ? +args.C : Infinity;
const tiers = new Set(String(args.tiers || 'kin,rel,gate').split(',').filter(Boolean));
const ctx = WP.makeCtx(L, tiers);
const maxLayer = +args.maxLayer || 2000000;
const layers = +args.layers || 200;
const deadline = Date.now() + 1000 * (+args.seconds || 600);
const out = (o) => console.log(JSON.stringify(o));

const { sources, rests } = LP.sourcesOf(L, 4000);
const sim = new E.EESim(L), inp = new E.EEInput();
// (a V8 Set holds at most 2^24 entries: NC Naos d3c6 at C 58 passes 7 M by layer 20, so the seen states are 64 Sets by the
// hash's low bits; a state hash is a whole number below 2^53)
const SH = Array.from({ length: 64 }, () => new Set());
const seen = { has: (h) => SH[h & 63].has(h), add: (h) => SH[h & 63].add(h), get size() { let n = 0; for (const x of SH) n += x.size; return n; } };
let front = [];
for (const s of sources) { sim.restore(s); const hs = sim.stateHash(); if (!seen.has(hs)) { seen.add(hs); front.push(s); } }
sim.restore(sources[0]);
const h0 = ctx.h(sim, Infinity);
out({ ev: 'start', level: file.replace(/^.*[\\/]/, ''), sources: sources.length, rests, distinct: front.length, C: Number.isFinite(C) ? C : null, tiers: [...tiers], h0 });
const firstMasks = Array.from(EG.MASK_SETS[3]).filter((m) => m !== 0);
const t0 = Date.now();
let last = front.length, why = 'layers', d = 0;
for (; d < layers; d++) {
	const next = [];
	let cut = 0, merged = 0, crown = 0;
	for (let i = 0; i < front.length; i++) {
		const snap = front[i];
		front[i] = null;
		sim.restore(snap);
		const masks = d === 0 ? firstMasks : EG.probeMasks(sim, inp, snap);
		for (const m of masks) {
			sim.restore(snap); E.applyMask(inp, m); sim.tick(inp);
			if (sim.has_silver_crown) { crown++; continue; }
			if (sim.is_dead && !ctx.canDie) continue;
			if (Number.isFinite(C)) { const lim = C - (d + 1); if (lim < 1 || ctx.h(sim, lim) > lim) { cut++; continue; } }
			const hs = sim.stateHash();
			if (seen.has(hs)) { merged++; continue; }
			seen.add(hs);
			next.push(sim.snapshot());
		}
		if ((i & 4095) === 0 && Date.now() > deadline) { why = 'time'; break; }
	}
	if (why === 'time') break;
	const growth = last > 0 ? Math.round(100 * next.length / last) / 100 : null;
	// (the finish at layer d + 1 is a route of d run ticks)
	out({ ev: 'layer', d: d + 1, states: next.length, cut, merged, crown, growth, seen: seen.size, s: Math.round((Date.now() - t0) / 100) / 10, rssGB: Math.round(process.memoryUsage().rss / 1e8) / 10 });
	if (crown) { why = 'crown'; out({ ev: 'crown', layer: d + 1, runTicks: d }); break; }
	if (next.length === 0) { why = 'closed'; break; }
	if (next.length > maxLayer) { why = 'cap'; last = next.length; front = []; break; }
	last = next.length; front = next;
}
out({ ev: 'end', why, layers: d + 1, s: Math.round((Date.now() - t0) / 100) / 10 });
