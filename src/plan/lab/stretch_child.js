'use strict';
// THE STRETCH SOLVER IN ITS OWN PROCESS (n5-s99-budget; the compiler's child, strategy.js EEAT_STRETCH=1, opt-in): a stretch
// (a leg of the plan: a real state -> a waypoint's tiles) solved by the lab's backward solver (backward.js) on ONE
// continuous clock, next to the compile's executor, whose rung windows (1.5 / 5 / 15 / 45 s) restart every solver of a
// stretch: the backward solve of a long leg needs 30-40 s in one piece (Stone Ruin's whole level 37 s, 12 / 24 long
// known-route legs at 90 s where the executor's rungs 1-2 found 0). ONE process a compile, its solver (and the values' memo
// of its closed closures: a later request to the same target from the same discrete state takes them) kept across requests.
//   node src/plan/lab/stretch_child.js <level file>
//   stdin, a JSON line a request: {id, from: "<inputs 0..O from the level start>", legs: [{wp: {kind, tiles, expect}, w}],
//     ms}: the legs in order from the state after `from`, each on its share of the time left (by w), one after the other
//     from the last one's arrival; a trophy leg's arrival is the finish
//   stdout, JSON lines: {ev:'arrival', id, k, inputs (from the level start, ending where the waypoint's goal test first
//     holds)}, {ev:'done', id, ok, why, ms, k (legs solved)}; {ev:'ready'} once loaded
// Every answer is replayed by the engine here (the waypoint's goal test, T.goalOf) and again by the compiler (strategy.js
// verified / routeOf) before it is an anchor or a route.
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const file = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let L, B, sim, inp;
try {
	L = T.loadLevelFile(file);
	B = BW.createBackward(L);
	sim = new E.EESim(L); inp = new E.EEInput();
} catch (e) { out({ ev: 'done', id: null, ok: false, why: 'error: ' + String(e && e.message || e).slice(0, 200) }); process.exit(0); }

/** the state after masks from the level start -> the snapshot (dead ticks played as they are) */
const stateOf = (masks) => {
	sim.reset();
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
	return sim.snapshot();
};
/** masks (from the level start) + a leg: the prefix up to the first tick the goal holds (tails tried as the whole-level
 *  child does: the trophy is touched a tick after the centre is in its tile), or null */
const finishOf = (pre, leg, goal) => {
	const last = leg.length ? leg[leg.length - 1] & 30 : 0;
	for (const tail of [[], [last], [last, last], [0], [last, 0, 0], [last, last, last, last]]) {
		const m = new Uint8Array(pre.length + leg.length + tail.length);
		m.set(pre, 0); m.set(leg, pre.length); m.set(tail, pre.length + leg.length);
		sim.reset();
		for (let t = 0; t < m.length; t++) {
			E.applyMask(inp, m[t] & 31); sim.tick(inp);
			if (t >= pre.length && sim.is_dead && !goal.allowDeath) break;
			if (t >= pre.length && goal.test(sim)) return m.subarray(0, t + 1);
		}
	}
	return null;
};

function run(req) {
	const t0 = Date.now(), ms = +req.ms || 30000;
	let masks = T.masksOf(String(req.from || '').replace(/[^0-O]/g, ''));
	const legs = Array.isArray(req.legs) ? req.legs : [];
	let k = 0, why = '', lastClosest = null;
	for (; k < legs.length; k++) {
		const rest = ms - (Date.now() - t0);
		if (rest < 500) { why = 'budget'; break; }
		const wS = legs.slice(k).reduce((s, g) => s + (g.w > 0 ? +g.w : 1), 0);
		const share = k === legs.length - 1 ? rest : rest * (legs[k].w > 0 ? +legs[k].w : 1) / wS;
		const wp = legs[k].wp || { kind: 'trophy' };
		let goal;
		try { goal = T.goalOf(L, wp); } catch (e) { why = 'goal: ' + e.message; break; }
		const tgt = { tiles: Array.from(goal.tiles) };
		if (!tgt.tiles.length) { why = 'no target tiles'; break; }
		const snap = stateOf(masks);
		if (sim.is_dead) { why = 'a dead start'; break; }
		// (the whole-level child's two clocks: 0.4 of the share, then what is left of it (a longer clock is not a superset of a
		// shorter one: the solve's shares are fractions of its clock))
		const tL = Date.now();
		let r = null, closest = null;
		for (const f of [0.4, 1]) {
			const left = share - (Date.now() - tL);
			if (left < 300 || (r && (r.ok || /walk|bug|target/.test(r.why || '')))) break;
			try { r = B.solve(snap, tgt, { ms: f < 1 ? Math.round(share * f) : left, closest: !!req.closest }); } catch (e) { r = { ok: false, why: 'error: ' + String(e && e.message || e).slice(0, 120) }; }
			if (r && r.closest && r.closest.masks && r.closest.masks.length && (!closest || r.closest.h < closest.h)) closest = r.closest;
		}
		if (!r || !r.ok) {
			why = (r && r.why) || 'none';
			// (the solve's partial progress: its node of the least time to go, from the level start; the compiler replays it)
			if (closest) lastClosest = { k, inputs: T.strOf(T.concat(masks, closest.masks)), h: closest.h };
			break;
		}
		const m = finishOf(masks, r.masks, goal);
		if (!m) { why = 'the goal test never holds on the leg\'s replay'; break; }
		masks = m;
		out({ ev: 'arrival', id: req.id, k, inputs: T.strOf(masks), ms: Date.now() - t0 });
		if (wp.kind === 'trophy') { k++; break; }
	}
	out(Object.assign({ ev: 'done', id: req.id, ok: k >= legs.length && legs.length > 0, k, why, ms: Date.now() - t0 }, lastClosest ? { closest: lastClosest } : {}));
}

out({ ev: 'ready' });
let buf = '';
const queue = [];
let busy = false;
const pump = () => {
	if (busy) return;
	busy = true;
	while (queue.length) { const q = queue.shift(); try { run(q); } catch (e) { out({ ev: 'done', id: q && q.id, ok: false, why: 'error: ' + String(e && e.message || e).slice(0, 200) }); } }
	busy = false;
};
process.stdin.on('data', (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let q = null;
		try { q = JSON.parse(line); } catch (e) { continue; }
		if (q && q.quit) process.exit(0);
		queue.push(q);
	}
	setImmediate(pump);
});
process.stdin.on('end', () => process.exit(0));
