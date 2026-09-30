'use strict';
// Mock parts for the planner's loop (test/planstrategy.js, src/plan.js --parts=test/planmock.js): a model of states by
// the red key, a planner over three edges (the key, a sealed coin pocket that no executor reaches, the trophy), facts that
// move a failed edge up the rungs, an executor that holds right from its start (real arrivals, replayed by the engine).
// PLANMOCK_MODE=stuck: a planner that proposes a new edge every time and never learns (the loop's watchdog test).
const T = require('../src/plan/types.js');

const mode = () => process.env.PLANMOCK_MODE || 'normal';
function compileModel(L) {
	const W = L.width, tiles = (id) => { const o = []; for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === id) o.push(i); return o; };
	return { triggers: [{ id: 0, kind: 'key', tiles: tiles(6) }, { id: 1, kind: 'coin', tiles: tiles(100) }], feats: ['key0'], doors: tiles(23), W,
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
	const stuck = mode() === 'stuck';
	const step = (edge, cls, wp, est) => ({ n: 0, edge, nodeClass: cls, rung: F.rung.get(`${edge}|${cls}`) || 0, waypoint: wp, estTicks: est });
	const wpKey = { kind: 'trigger', tiles: model.key, trig: 0, expect: { feat: 'key0', value: 1 }, label: 'key red' };
	const wpCoin = { kind: 'trigger', tiles: model.coin, trig: 1, expect: null, label: 'coin (sealed)' };
	const wpTrophy = { kind: 'trophy', label: 'trophy' };
	return {
		plan(anchor) {
			const cls = anchor.S.key;
			if (stuck) { n++; return [{ id: `s${n}`, steps: [step(`e${n}`, cls, wpCoin, 10)], cost: 10, partial: true, why: 'stuck mock' }]; }
			const ok = (e) => !F.blocked.has(`${e}|${cls}`) && !F.done.has(`${e}|${cls}`);
			const plans = [];
			if (cls === 'k0') { if (ok('key')) plans.push({ id: 'a', steps: [step('key', cls, wpKey, 50), step('trophy', 'k1', wpTrophy, 100)], cost: 150 }); }
			else {
				// (the sealed coin first: the planner's cheap false plan; its failures move it up the rungs, then block it)
				if (ok('coin')) plans.push({ id: 'b', steps: [step('coin', cls, wpCoin, 10), step('trophy', cls, wpTrophy, 100)], cost: 110 });
				if (ok('trophy')) plans.push({ id: 'c', steps: [step('trophy', cls, wpTrophy, 100)], cost: 120 });
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
		explain: () => '',
		stats: () => ({ facts: F.version, blocked: F.blocked.size, done: F.done.size }),
	};
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
			const goal = T.goalOf(L, wp);
			const out = [];
			const maxT = Math.min(2000, Math.max(50, Math.round(budget.ms / 2)));
			for (const a of starts) {
				const hold = new Uint8Array(maxT).fill(4);
				const all = T.concat(a.masks, hold);
				const r = T.playTo(L, all, { goal, from: a.snap ? { snap: a.snap, tick: a.tick } : undefined });
				if (r.goalAt > 0) {
					const masks = all.subarray(0, r.goalAt);
					const r2 = T.playTo(L, masks);
					out.push(T.arrivalOf(L, r2.sim, masks, RM));
				}
			}
			if (out.length) return { ok: true, arrivals: T.pickDiverse(out, budget.k || 3), tool: 'leg', ms: 1, sims: 1, fail: null };
			return { ok: false, arrivals: [], tool: null, ms: 1, sims: 1, fail: { why: 'budget', closest: null, touched: [], blockedBy: [], level: budget.level } };
		},
		close() {},
	};
}
module.exports = { compileModel, createFacts, createPlanner, createExecutor, createPrims: null };
