'use strict';
// THE LEVEL AS A CHAIN OF BACKWARD LEGS, as a child process of the compiler (strategy.js, OPT-IN EEAT_BW_CHAIN=1; n5-s99-gated):
// a level whose trophy needs no trigger first gets the whole-level stage's own solve first (bwlevel_child.js's schedule:
// 0.4 of the clock, then the rest), a GATED level (the trophy behind doors a trigger opens: 'the start is not in the
// target's walk', 77 of the 206 failing levels) goes straight to the chain (src/plan/lab/bwchain.js: a best-first search
// over trigger orders with the backward solver as its edge oracle, the end states carried exactly); a one-leg level whose
// solve failed with time left goes on as a chain too. Every chain node (a new trigger state, its exact masks from the level
// start) is printed as an ANCHOR for the compile (its 'import': the executor goes on from the chain's progress); every
// route is C.evaluate'd here and again by the compiler (routeOf).
//   node src/plan/lab/bwchain_child.js <level.eelvl | level.json> [--ms=120000]
//   stdout: {"ev":"anchor","inputs":"0..O","gain":g,"tick":t} ..., {"ev":"result","kind":"finish","inputs":"0..O","runTicks":N,
//   "deaths":D}, {"ev":"done","end":"finish"|why,"ms":N,"mode":"one"|"chain"|"one+chain"}
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const BC = require(path.join(root, 'src/plan/lab/bwchain.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const file = argv.find((s) => !s.startsWith('--'));
const ms = +opt('ms', 120000);
const IMPORT = process.env.EEAT_BWC_IMPORT !== undefined && process.env.EEAT_BWC_IMPORT !== '' ? +process.env.EEAT_BWC_IMPORT : 1;
let topGain = 0;
const t0 = Date.now();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const left = () => ms - (Date.now() - t0);
let end = 'none', mode = '';
const finish = (L, masks) => {
	// (the trophy is touched a tick after the centre is in its tile: the last direction held, then released)
	const last = masks.length ? masks[masks.length - 1] & 30 : 0;
	for (const tail of [[], [last], [last, last], [0], [last, 0, 0]]) {
		const ev = C.evaluate(L, Uint8Array.from([...masks, ...tail]));
		if (ev) { out({ ev: 'result', kind: 'finish', inputs: T.strOf(ev.ms), runTicks: ev.runTicks, deaths: ev.deaths }); return true; }
	}
	return false;
};
try {
	const L = T.loadLevelFile(file);
	const M = MD.compileModel(L);
	const sim = new E.EESim(L); sim.reset();
	const B = BW.createBackward(L);
	const tgt = { tiles: M.trophyTiles.slice() }, snap = sim.snapshot();
	// the walk test: a gated level answers at once
	let r = B.solve(snap, tgt, { ms: 50 });
	const gated = !r.ok && /walk/.test(r.why || '');
	if (r.ok && finish(L, r.masks)) end = 'finish';
	if (end !== 'finish' && !gated) {
		// the whole-level stage's schedule (bwlevel_child.js): 0.4 of the clock, then the rest (at most half the clock here:
		// the chain takes the other half)
		mode = 'one';
		const oneMs = Math.round(ms * 0.5);
		const sched = [Math.round(oneMs * 0.4), oneMs];
		for (let i = 0; i < sched.length; i++) {
			const rest = oneMs - (Date.now() - t0);
			if (i > 0 && (rest < 15000 || r.ok || /walk|bug|target/.test(r.why || ''))) break;
			r = B.solve(snap, tgt, { ms: i < sched.length - 1 ? Math.min(sched[i], rest) : rest });
			out({ ev: 'try', n: i + 1, ok: !!r.ok, why: r.why || null, ms: Date.now() - t0 });
			if (r.ok) break;
		}
		if (r.ok && finish(L, r.masks)) end = 'finish';
	}
	if (end !== 'finish' && left() > 5000) {
		mode = mode ? 'one+chain' : 'chain';
		const c = BC.chainLevel(L, {
			ms: left() - 500, model: M, backward: B, file,
			// (EEAT_BWC_IMPORT: 1 (the default) only the chain's FRONTIER (a node of more gain than every one printed before: the
			// executor goes on from the chain's progress, not from every order it tried), 2 every node, 0 none)
			onAnchor: (masks, info) => {
				if (IMPORT === 0 || (IMPORT === 1 && !(info.gain > topGain))) return;
				topGain = Math.max(topGain, info.gain);
				out({ ev: 'anchor', inputs: T.strOf(masks), gain: info.gain, tick: info.tick, label: info.label });
			},
		});
		out({ ev: 'chain', ok: c.ok, why: c.why, legs: c.stats.legs, legsOk: c.stats.legsOk, nodes: c.stats.nodes, gain: c.gain, ms: Date.now() - t0 });
		if (c.ok) { out({ ev: 'result', kind: 'finish', inputs: T.strOf(c.masks), runTicks: c.runTicks, deaths: c.deaths }); end = 'finish'; }
		else end = c.why || 'none';
	} else if (end !== 'finish') end = r.why || 'none';
} catch (e) { end = 'error: ' + String(e && e.message || e).slice(0, 200); }
out({ ev: 'done', end, ms: Date.now() - t0, mode });
