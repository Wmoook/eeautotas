'use strict';
// THE CEGAR FACT STORE (n4plan, part 'planner': the compiler's REFINE memory). Every executed plan step leaves a fact;
// the planner reads them so that a failed step always changes the next plan (NO STALLING: the same (edge, nodeClass, rung)
// triple is never proposed twice) and a succeeded one prices its edge by what it really cost.
//
// createFacts(o) -> {version(), add(fact), reset({keepProofs}), toJSON(), rungOf(edge, nodeClass), blocked(edge, nodeClass,
//   sKey), okTicks(edge, nodeClass), needsOf(edge, nodeClass), list()}
// Fact kinds (plain JSON):
//   {kind: 'ok', edge, nodeClass, ticks, lb}        the step reached its waypoint in `ticks`: the edge's estimate
//   {kind: 'fail', edge, nodeClass, rung, why, closest, blockedBy}   a failed rung (the next plan asks the next rung)
//   {kind: 'needs', edge, nodeClass, feat, value}   a shut gate near the closest approach: the edge needs that value first
//   {kind: 'proof', edge, sKey}                     an RCH3 -1 from that abstract state: never tried from it again
//   {kind: 'block', edge, nodeClass}                RUNG_MAX failures: the edge is out for that node class
// o.rungMax (or o.rungs, the strategy's budget rungs; default 3). The version counts every add (and every reset).
const RUNG_MAX = 3;
const KINDS = new Set(['ok', 'fail', 'needs', 'proof', 'block']);
// THE RUNG'S PROGRESS (n5 lane 6, OPT-IN EEAT_RUNG_PROG=1; off = the rungs as before): a failure at rung r >= 1 whose
// closest approach is no nearer (by RUNG_PROG_TILES) than the best of the earlier rungs of the same (edge, node class)
// ends that edge's climb for the class (as a failure at the last rung does): a bigger window that bought no progress.
// Bridge Builder (box 5, 300 s): the same (anchor, psw 996) failed at rung 2 after 14.9 s and at rung 3 after 44.9 s,
// both at the same closest 3.4 tiles; Two's coin (125,190) at 7.4 tiles on every rung, 21-23 tries (237-327 s of 300).
// Ordering / time only: no plan edge dropped outside that class, the strategy's deepening (reset) forgets it like a rung
const RUNG_PROG = process.env.EEAT_RUNG_PROG === '1';
const RUNG_PROG_TILES = 0.5;

function createFacts(o = {}) {
	// (o.rungs: the strategy's number of budget rungs, e.g. 4 = 1.5 / 5 / 15 / 45 s: the block after that many failures)
	const rungMax = o.rungMax || o.rungs || RUNG_MAX;
	let ver = 0, facts = [];
	let fails = new Map(), blocks = new Set(), proofs = new Set(), needs = new Map(), oks = new Map(), nearest = new Map();
	const rungProg = o.rungProg !== undefined ? !!o.rungProg : RUNG_PROG;
	const ek = (edge, cls) => `${edge}\u0001${cls}`;
	function index(f) {
		switch (f.kind) {
			case 'ok': { const k = ek(f.edge, f.nodeClass), had = oks.get(k); oks.set(k, had === undefined ? f.ticks : Math.min(had, f.ticks)); break; }
			case 'fail': {
				const k = ek(f.edge, f.nodeClass);
				fails.set(k, Math.max(fails.get(k) || 0, (f.rung | 0) + 1));
				// (the rung's progress: no nearer than the earlier rungs' best -> the climb ends for this class)
				const d = f.closest && Number.isFinite(+f.closest.dist) && +f.closest.dist >= 0 ? +f.closest.dist : null;
				if (rungProg && d !== null) {
					const had = nearest.get(k);
					if ((f.rung | 0) >= 1 && had !== undefined && d > had - RUNG_PROG_TILES) fails.set(k, rungMax);
					nearest.set(k, had === undefined ? d : Math.min(had, d));
				}
				break;
			}
			case 'needs': { const k = ek(f.edge, f.nodeClass); if (!needs.has(k)) needs.set(k, []); const l = needs.get(k); if (!l.some((x) => x.feat === f.feat && x.value === f.value)) l.push({ feat: f.feat, value: f.value }); break; }
			case 'proof': proofs.add(ek(f.edge, f.sKey)); break;
			case 'block': blocks.add(ek(f.edge, f.nodeClass)); break;
			default: break;
		}
	}
	const api = {
		RUNG_MAX: rungMax,
		version: () => ver,
		/** add(fact) -> the fact (a copy, JSON only); bumps the version */
		add(f) {
			if (!f || !KINDS.has(f.kind)) throw new Error(`facts.add: bad fact ${JSON.stringify(f)}`);
			const c = JSON.parse(JSON.stringify(f));
			facts.push(c); index(c); ver++;
			return c;
		},
		/** the rung the next try of (edge, nodeClass) is at: the failures so far */
		rungOf: (edge, cls) => fails.get(ek(edge, cls)) || 0,
		/** 'block' | 'proof' | null: the edge is out from that node class / abstract state */
		blocked(edge, cls, sKey) {
			if (sKey !== undefined && proofs.has(ek(edge, sKey))) return 'proof';
			if (blocks.has(ek(edge, cls))) return 'block';
			if ((fails.get(ek(edge, cls)) || 0) >= rungMax) return 'block';
			return null;
		},
		/** the learned ticks of the edge from that node class (undefined: none) */
		okTicks: (edge, cls) => oks.get(ek(edge, cls)),
		/** [{feat, value}] the edge needs first (from 'needs' facts) */
		needsOf: (edge, cls) => needs.get(ek(edge, cls)) || [],
		list: () => facts.slice(),
		/** reset({keepProofs}): forget the rungs, blocks, needs and estimates (the strategy's deepening); proofs stay on
		 *  request; the version still bumps */
		reset(ro = {}) {
			const keep = ro.keepProofs ? facts.filter((f) => f.kind === 'proof') : [];
			facts = []; fails = new Map(); blocks = new Set(); proofs = new Set(); needs = new Map(); oks = new Map(); nearest = new Map();
			for (const f of keep) { facts.push(f); index(f); }
			ver++;
		},
		toJSON: () => ({ version: ver, rungMax, facts: facts.slice() }),
	};
	if (o.facts) for (const f of o.facts) api.add(f);
	return api;
}

module.exports = { createFacts, RUNG_MAX };
