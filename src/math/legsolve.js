'use strict';
// THE LEG SOLVER OF THE BOUND'S PROOFS (n4-math, Build / bounds, 2026-09-30): the least T >= lb (src/math/lb.js, an
// admissible lower bound) for which a member of the free-air family reaches a leg's target from an EXACT engine state:
//   x  a pattern of <= k input changes (L / none / R runs) whose exact x_T lies in the target tile's centre window
//      (src/plan/kin1d.js solveIA: THEOREM M's branch and bound, no search of states: the patterns ARE the answers of
//      the 1D recurrence)
//   y  no jump, or ONE jump pressed on a tick whose move was grounded in the no-jump replay (the engine's jump rule:
//      the bit fires on a grounded tick, the hop included)
// Every candidate is replayed by the engine (the goal: the centre tile in the target, alive, and grounded for 'land').
// T is tried from lb upward, so a find at T = lb is a PROOF that the leg is optimal from that state (no input sequence
// of any kind reaches the target sooner: lb is admissible). Not a search over engine states: the candidates per T are
// the 1D solver's patterns x the grounded ticks of their own replay.
//
// solveLeg(L, sim, target, o) -> {T, masks: Uint8Array, proven: T === o.lb, tried, ms} | null (o.tmax passed or o.ms
//   spent). target {tiles, mode}; o {lb, tmax, k (2), limit (16 patterns per T and window), ms (500)}
const E = require('../eesim.js');
const K = require('../plan/kin1d.js');
const T_ = require('../plan/types.js');

const MASK = [0, 2, 4];   // kin1d input index -> the mask bits: '-', L, R

function solveLeg(L, sim, target, o = {}) {
	const t0 = Date.now();
	const W = L.width, H = L.height;
	const lb = Math.max(0, o.lb | 0), tmax = o.tmax === undefined ? lb + 60 : o.tmax;
	const k = o.k === undefined ? 2 : o.k, limit = o.limit || 16, msBudget = o.ms || 500;
	const tiles = new Set(Array.from(target.tiles));
	const land = target.mode === 'land';
	const goal = (s) => !s.is_dead && tiles.has(T_.tileOf(s, W, H)) && (!land || s.on_ground);
	const snap0 = sim.snapshot();
	const eng = new E.EESim(L), inp = new E.EEInput();
	const ctx = K.ctxOf(sim);
	const x0 = sim.px, v0 = sim.speed_x;
	const cols = [...new Set([...tiles].map((t) => t % W))];
	let tried = 0;
	if (lb === 0) { eng.restore(snap0); if (goal(eng)) return { T: 0, masks: new Uint8Array(0), proven: true, tried, ms: Date.now() - t0 }; }
	for (let T = Math.max(1, lb); T <= tmax; T++) {
		if (Date.now() - t0 > msBudget) return null;
		const pats = new Map();
		for (const tx of cols) {
			const lo = 16 * tx - 8, hi = 16 * tx + 8 - 1e-9;
			let res;
			try { res = K.solveIA(x0, v0, T, lo, hi, { k, ctx, limit, maxNodes: 200000 }); } catch (e) { res = []; }
			for (const r of res) pats.set(r.code, r);
			// the extremes too (walls may stop a pattern; hold toward the window)
		}
		for (const code of pats.keys()) {
			const mk = new Uint8Array(T);
			for (let j = 0; j < T; j++) mk[j] = MASK[K.inputAt(code, j + 1)];
			// the no-jump replay: its grounded ticks are the jump options
			eng.restore(snap0);
			const grounded = [];
			let dead = false;
			for (let j = 0; j < T; j++) {
				E.applyMask(inp, mk[j]);
				eng.tick(inp);
				if (eng.is_dead) { dead = true; break; }
				if (eng.on_ground) grounded.push(j);
			}
			tried++;
			if (!dead && goal(eng)) return { T, masks: mk, proven: T === o.lb, tried, ms: Date.now() - t0 };
			for (const g of grounded) {
				eng.restore(snap0);
				let ok = true;
				for (let j = 0; j < T; j++) {
					E.applyMask(inp, mk[j] | (j === g ? 1 : 0));
					eng.tick(inp);
					if (eng.is_dead) { ok = false; break; }
				}
				tried++;
				if (ok && goal(eng)) { const m2 = mk.slice(); m2[g] |= 1; return { T, masks: m2, proven: T === o.lb, tried, ms: Date.now() - t0 }; }
				if (Date.now() - t0 > msBudget) return null;
			}
		}
	}
	return null;
}

module.exports = { solveLeg };
