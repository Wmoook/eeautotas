'use strict';
// Mock parts for the compiler's loop (test/planstrategy.js, test/plancompile.js, src/plan.js / src/compile.js
// --parts=test/planmock.js): a model of states by the red key, a planner over three edges (the key, a sealed coin pocket
// that no executor reaches, the trophy), facts that move a failed edge up the rungs, an executor that holds right from its
// start (real arrivals, replayed by the engine), an admissible lower bound (the trophy's columns at 16.25 px a tick).
// PLANMOCK_MODE: normal; stuck (a planner that proposes a new edge every time and never learns: the watchdog's test);
// fail (an executor that never reaches anything: the facts change every step, the end 'exhausted'); bnb (after the route
// the key's anchor offers a cheap 'detour' whose lb cannot beat it: branch and bound must not run it); nolb (no
// lowerBound()). PLANMOCK_DELAY: ms per reach.
const T = require('../src/plan/types.js');

const mode = () => process.env.PLANMOCK_MODE || 'normal';
function compileModel(L) {
	const tiles = (id) => { const o = []; for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === id) o.push(i); return o; };
	return { triggers: [{ id: 0, kind: 'key', tiles: tiles(6) }, { id: 1, kind: 'coin', tiles: tiles(100) }], feats: ['key0'], gates: tiles(23), doors: tiles(23), W: L.width,
		key: tiles(6), coin: tiles(100), trophy: tiles(121),
		stateOf: (sim) => ({ key: `k${sim._keysMask & 1}`, gain: sim._keysMask & 1 }) };
}
function createFacts() {
	const F = { version: 0, rung: new Map(), blocked: new Set(), done: new Set(), resets: 0 };
	F.reset = (o) => { F.rung.clear(); F.blocked.clear(); F.done.clear(); F.resets++; F.version++; };
	F.toJSON = () => ({ version: F.version, blocked: [...F.blocked], done: [...F.done] });
	return F;
}
function createPlanner(model, F) {
	let n = 0;
	const stuck = mode() === 'stuck', bnb = mode() === 'bnb';
	const step = (edge, cls, wp, est, lb) => ({ n: 0, edge, nodeClass: cls, rung: F.rung.get(`${edge}|${cls}`) || 0, waypoint: wp, estTicks: est, lb });
	const wpKey = { kind: 'trigger', tiles: model.key, trig: 0, expect: { feat: 'key0', value: 1 }, label: 'key red' };
	const wpCoin = { kind: 'trigger', tiles: model.coin, trig: 1, expect: null, label: 'coin (sealed)' };
	const wpTrophy = { kind: 'trophy', label: 'trophy' };
	// (the detour: the door's tile, reachable, but its lb says no route through it can beat the route)
	const wpDetour = { kind: 'region', tiles: model.gates, expect: null, label: 'detour (lb 1e6)' };
	// (the admissible bound: columns to the trophy at 16.25 px a tick, the box's top speed)
	const lbFrom = (tile) => { const W = model.W, tx = model.trophy.length ? model.trophy[0] % W : 0; return Math.max(0, Math.ceil((Math.abs(tx - tile % W) * 16 - 16) / 16.25)); };
	const P = {
		plan(anchor) {
			const cls = anchor.S.key;
			const lb = lbFrom(anchor.arrival.tile);
			if (stuck) { n++; return [{ id: `s${n}`, steps: [step(`e${n}`, cls, wpCoin, 10)], cost: 10, lb, partial: true, why: 'stuck mock' }]; }
			const ok = (e) => !F.blocked.has(`${e}|${cls}`) && !F.done.has(`${e}|${cls}`);
			const plans = [];
			if (cls === 'k0') { if (ok('key')) plans.push({ id: 'a', steps: [step('key', cls, wpKey, 50, lb), step('trophy', 'k1', wpTrophy, 100, lb)], cost: 150, lb }); }
			else if (bnb) {
				if (ok('trophy')) plans.push({ id: 'c', steps: [step('trophy', cls, wpTrophy, 100, lb)], cost: 100, lb });
				if (ok('detour')) plans.push({ id: 'd', steps: [step('detour', cls, wpDetour, 5, 1e6), step('trophy', cls, wpTrophy, 100, lb)], cost: 200, lb: 1e6 });
			} else {
				// (the sealed coin first: the planner's cheap false plan; its failures move it up the rungs, then block it)
				if (ok('coin')) plans.push({ id: 'b', steps: [step('coin', cls, wpCoin, 10, lb), step('trophy', cls, wpTrophy, 100, lb)], cost: 110, lb });
				if (ok('trophy')) plans.push({ id: 'c', steps: [step('trophy', cls, wpTrophy, 100, lb)], cost: 120, lb });
			}
			if (!plans.length) { const r = []; r.why = 'exhausted'; return r; }
			return plans;
		},
		learn(st, res) {
			if (stuck) return [];
			const k = `${st.edge}|${st.nodeClass}`;
			F.version++;
			if (res.ok) { F.done.add(k); return [{ kind: 'ok', edge: st.edge, rung: st.rung }]; }
			const r = (F.rung.get(k) || 0) + 1;
			if (r > 3 || (res.fail && res.fail.why === 'proof')) { F.blocked.add(k); return [{ kind: 'blocked', edge: st.edge, rung: st.rung }]; }
			F.rung.set(k, r);
			return [{ kind: 'rung', edge: st.edge, rung: r }];
		},
		explain: () => `mock planner: ${F.blocked.size} blocked, ${F.done.size} done`,
		stats: () => ({ facts: F.version, blocked: F.blocked.size, done: F.done.size }),
	};
	if (mode() !== 'nolb') P.lowerBound = (anchor) => ({ ticks: lbFrom(anchor.arrival.tile), complete: true });
	// ('block': a part call that ignores its budget: the first lowerBound busy-waits PLANMOCK_BLOCK_MS, the CLI's hard watchdog's test)
	if (mode() === 'block') { const lb0 = P.lowerBound; let once = false; P.lowerBound = (anchor, o) => { if (!once) { once = true; const t = Date.now() + (+process.env.PLANMOCK_BLOCK_MS || 1e9); while (Date.now() < t) { /* blocked */ } } return lb0(anchor, o); }; }
	return P;
}
/** holds right from each start until the waypoint's goal test holds (at most the budget's ticks), a real arrival */
function createExecutor(L, o) {
	const RM = o.RM;
	const calls = [];
	return {
		calls,
		async reach(starts, wp, budget) {
			const delay = +process.env.PLANMOCK_DELAY || (mode() === 'stuck' ? 10 : 0);
			await new Promise((r) => (delay ? setTimeout(r, delay) : setImmediate(r)));
			calls.push({ label: wp.label, level: budget.level, ms: budget.ms });
			if (mode() === 'fail') return { ok: false, arrivals: [], tool: null, ms: 1, sims: 1, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level } };
			const goal = T.goalOf(L, wp);
			const out = [], legs = [];
			const maxT = Math.min(2000, Math.max(50, Math.round(budget.ms / 2)));
			starts.forEach((a, i) => {
				const hold = new Uint8Array(maxT).fill(4);
				const all = T.concat(a.masks, hold);
				const r = T.playTo(L, all, { goal, from: a.snap ? { snap: a.snap, tick: a.tick } : undefined });
				const at = wp.kind === 'trophy' ? r.finished : r.goalAt;
				if (at > 0) {
					const masks = all.subarray(0, at);
					const r2 = T.playTo(L, masks);
					out.push(T.arrivalOf(L, r2.sim, masks, RM));
					legs.push({ start: i, ticks: at - a.tick, lb: 0, proven: wp.kind === 'trophy', tool: wp.kind === 'trophy' ? 'exact' : 'leg' });
				}
			});
			if (out.length) return { ok: true, arrivals: out, legs, tool: 'leg', ms: 1, sims: 1, fail: null };
			return { ok: false, arrivals: [], tool: null, ms: 1, sims: 1, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level } };
		},
		close() {},
	};
}
module.exports = { compileModel, createFacts, createPlanner, createExecutor, createPrims: null, createBounds: null };
