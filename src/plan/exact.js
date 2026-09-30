'use strict';
// THE EXACT LEG SEARCH (n4plan, the compiler's MOVES stage, part 'executor'): from real engine states to a waypoint, every
// input sequence tick by tick, a breadth-first branch and bound over ABSOLUTE ticks. It generalises src/endgame.js
// search() (which goes to the trophy from one state) to any waypoint goal (types.js goalOf: the centre tile in the goal
// tiles and an Expect, the ball alive; or the trophy) from several starts at once, each injected at its own tick:
//   - the masks from endgame.probeMasks: the 18 inputs, those whose unread axis provably does nothing simulated once;
//   - exact dedup by sim.stateHash() in an endgame.HashSet (an earlier copy of a state dominates every later one: equal
//     hash = identical future; the clocks' phase is in the hash);
//   - deaths dropped unless o.allowDeath (the waypoint needs the ball alive at the goal; a death on the way is not allowed
//     by the leg's rules unless the step is a death step);
//   - a state at depth c cut when c + h + tr > maxDepth, h = the admissible lower bound on the ticks until the centre can be
//     in a goal cell (endgame.lowerBound on boundContext(L, {goals}); with the primitives' bounds.leg the larger of the two),
//     tr = 1 for the trophy (the complete fires the tick after the centre is in the trophy cell), else 0;
//   - RCH3 -1 states dropped (o.field: the goal field of the level as the doors stood at the start, types.js levelNow +
//     goalField; physics mode only): a proof, valid only while the ball's door-reading state (discKey) is the start's, so
//     the cut is taken only then;
//   - nothing else is dropped. With o.allowDeath the bound is not used (a respawn is a teleport the envelope does not see).
// The FIRST goal found at absolute tick T is the minimum over every input sequence from every start (up to 53-bit hash
// collisions); a run that ends with no open state is a proof that nothing reaches the goal by maxDepth (lb = maxDepth + 1).
// A cap or the clock ending a run proves nothing.
//
//   exactLeg(L, starts, goal, o) -> {status 'found' | 'proof' | 'cap' | 'time' | 'stopped', depth (absolute layers from
//        the earliest start), tick (absolute), start (index), tail (Uint8Array: the found leg's inputs from its start),
//        goals [{start, tail, depth}] (every goal state of the found layer, up to o.collect), stats, closest, rejoin}
//     starts: [{snap (a snapshot of an EESim of L in this thread), tick (absolute: its masks' length)}]
//     o: {sim, maxDepth, cap (open states per layer, default 300000), deadline (epoch ms), stop (() => bool), allowDeath,
//         beforeTick (absolute; -1 none), B (endgame.boundContext; built when absent), bounds (primitives' bounds: .leg),
//         noBound (tests: no cut), collect (goal states to keep, default 4000), field (RCH3 goal field for the -1 cut),
//         discKey (sim -> number), disc0 (the starts' discKey), track (closest by o.field / o.distField: {dist, layer,
//         idx}), rejoin (Map stateHash -> the LATER absolute tick of a reference run: exact shortcuts, polish.js)}
//   solveExact(L, starts, goal, o) -> iterative deepening: maxDepth from max(8, the start bound) growing by 1 (each tick
//        of slack multiplies the open states: o.growth > 1.5 multiplies instead) while the clock lasts; the first 'found' (proven minimum), else the last proof (lb) and why it stopped.
const E = require('../eesim.js');
const EG = require('../endgame.js');
const RF = require('../reach.js');

const MAX_SEEN = 1 << 24;   // distinct states per search (the table's size then: 256 MB)
const DEF_CAP = 300000;
const DEF_COLLECT = 4000;

// ---------------------------------------------------------------- per level memo: the bound contexts per goal
const BMEMO = new WeakMap();
/** endgame.boundContext for these goal tiles (the trophy: its own default), memoized per level (16, LRU) */
function boundFor(L, goal) {
	let m = BMEMO.get(L);
	if (!m) { m = new Map(); BMEMO.set(L, m); }
	const key = goal.kind === 'trophy' ? 'trophy' : Array.from(goal.tiles).sort((a, b) => a - b).join(',');
	let B = m.get(key);
	if (B) { m.delete(key); m.set(key, B); return B; }
	B = goal.kind === 'trophy' ? EG.boundContext(L) : EG.boundContext(L, { goals: Array.from(goal.tiles) });
	m.set(key, B);
	if (m.size > 16) m.delete(m.keys().next().value);
	return B;
}

// ---------------------------------------------------------------- the door-reading state
/**
 * discKey(sim) -> a number: every value eesim.js _doorPassable reads for a door that levelNow turns into air / a wall
 * (keys, purple / orange switches, crowns, coins, blue coins, deaths, the coin / death gates' shown counts, the team, the
 * zombie state). Time doors are kept open by levelNow (the optimistic side), so the clock is not in it. Two states with
 * the same key see every such door the same (the RCH3 -1 cut of a field built for one holds for the other).
 */
function discKey(sim) {
	let h = 0x811c9dc5;
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	mix(sim._keysMask | 0); mix(sim.coins | 0); mix(sim.blue_coins | 0); mix(sim.deaths | 0); mix(sim.team | 0);
	mix((sim._collide_crown ? 1 : 0) | (sim._collide_silver_crown ? 2 : 0) | (sim.is_zombie ? 4 : 0));
	mix(sim._show_coin_gate | 0); mix(sim._show_blue_coin_gate | 0); mix(sim._show_death_gate | 0);
	let s1 = 0, s2 = 0;
	for (const [k, v] of sim._switches) if (v === true) { s1 = (s1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; s2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
	mix(s1); mix(s2);
	let o1 = 0, o2 = 0;
	for (const [k, v] of sim._oswitches) if (v === true) { o1 = (o1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; o2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
	mix(o1); mix(o2);
	return h >>> 0;
}

/**
 * The primitives' admissible tick fields for this goal (bounds.js createBounds: field(goalTiles, Lc, {touch}) and at(f,
 * sim)), built once per search, never per state (their leg() builds levelNow per call): `rel` on the level itself (every
 * door open: admissible whatever the ball touches), `now` on the level as the doors stood at the starts (only when every
 * start has the same door-reading state; used only for states that still have it). null without a usable bounds object.
 */
const BFIELDS = new WeakMap();
function boundFields(L, bounds, goal, starts, simIn, disc0, sameDisc) {
	if (!bounds || typeof bounds.field !== 'function' || typeof bounds.at !== 'function') return null;
	const touch = goal.kind === 'trophy';
	let rel;
	try { rel = bounds.field(goal.tiles, null, { touch }); } catch (e) { return null; }
	let now = null;
	if (sameDisc && disc0 !== undefined && starts.length) {
		try {
			const sim = simIn || new E.EESim(L);
			sim.restore(starts[0].snap);
			now = bounds.field(goal.tiles, require('./types.js').levelNow(L, sim), { touch });
		} catch (e) { now = null; }
	}
	void BFIELDS;
	return { rel, now };
}

/** the goal test at absolute tick t (types.js goalOf's test + beforeTick) */
const goalAt = (goal, sim, t, beforeTick) => (beforeTick < 0 || t <= beforeTick) && goal.test(sim);

// ---------------------------------------------------------------- one branch-and-bound run
function exactLeg(L, starts, goal, o) {
	o = o || {};
	const sim = o.sim || new E.EESim(L), inp = new E.EEInput();
	const cap = o.cap > 0 ? o.cap : DEF_CAP, collect = o.collect > 0 ? o.collect : DEF_COLLECT;
	const allowDeath = !!o.allowDeath, trophy = goal.kind === 'trophy';
	const tr = trophy ? 1 : 0;
	const useBound = !o.noBound && !allowDeath;
	const B = useBound ? (o.B || boundFor(L, goal)) : null;
	const field = o.field && o.field.mode !== 'walk' ? o.field : null;
	const dk = o.discKey || discKey;
	const disc0 = o.disc0;
	const bf = useBound ? boundFields(L, o.bounds, goal, starts, o.sim || null, disc0, o.sameDisc) : null;
	const legB = bf ? o.bounds : null;
	const deadline = o.deadline || Infinity, stop = o.stop || null;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick || a - b);
	const t0 = starts[order[0]].tick;
	let maxDepth = o.maxDepth >= 0 ? o.maxDepth : 64;
	if (beforeTick >= 0) maxDepth = Math.min(maxDepth, beforeTick - t0);
	const st = { ticks: 0, states: 0, merged: 0, cut: 0, cutField: 0, dead: 0, goals: 0, maxOpen: 0, depth: 0, seconds: 0, maxDepth };
	const tStart = Date.now();
	const track = o.track || null;
	const distField = o.distField || field;
	const rejoin = o.rejoin || null, rjMin = o.rejoinMin > 0 ? o.rejoinMin : 1;
	let bestRj = null;   // {gain, layer, par, msk, tick}
	const done = (status, extra) => { st.seconds = (Date.now() - tStart) / 1000; return Object.assign({ status, stats: st, t0, closest: track, rejoin: bestRj ? { gain: bestRj.gain, tick: bestRj.tick, depth: bestRj.layer, par: bestRj.par, msk: bestRj.msk } : null }, extra || {}); };
	/** the lower bound on the ticks to the goal from the state in sim (lim: only whether it is above lim) */
	const bound = (lim) => {
		if (!useBound) return 0;
		let h = EG.lowerBound(B, sim, lim);
		if (legB !== null && h <= lim) {
			// (the primitives' tick field: the doors as they stood at the start while the ball's door-reading state is the
			// start's, else the relaxed one (every door open); their at() without its own endgame part: h has it)
			const f = bf.now !== null && dk(sim) === disc0 ? bf.now : bf.rel;
			const h2 = legB.at(f, sim, { endgame: false });
			if (h2 > h) h = h2;
		}
		return h;
	};
	const seen = new HashSetLocal();
	const layers = [];   // layers[d] = {par: Int32Array, msk: Uint8Array} of the states of layer d (par < 0: start -1 - s)
	let cur = [], curN = 0, nxt = [];
	let curPar = [], curMsk = [];
	let si = 0;   // next start (in order) to inject
	const goals = [];
	let found = -1;
	let lastPoll = Date.now();
	/** a start injected into layer d (its tick = t0 + d) */
	const inject = (d) => {
		while (si < order.length && starts[order[si]].tick - t0 === d) {
			const s = order[si++];
			sim.restore(starts[s].snap);
			const h = sim.stateHash();
			if (!seen.add(h)) { st.merged++; continue; }
			if (sim.is_dead && !allowDeath) { st.dead++; continue; }
			if (goalAt(goal, sim, t0 + d, beforeTick)) {
				st.goals++;
				if (found < 0) found = d;
				if (goals.length < collect) goals.push({ layer: d, par: -1 - s, msk: -1 });
				continue;
			}
			const lim = maxDepth - d - tr;
			if (lim < 0 || bound(lim) > lim) { st.cut++; continue; }
			if (field !== null && disc0 !== undefined && dk(sim) === disc0 && RF.costAt(field, sim) < 0) { st.cutField++; continue; }
			cur[curN] = sim.snapshot(cur[curN]);
			curPar.push(-1 - s); curMsk.push(0);
			if (track !== null && distField) trackState(track, distField, sim, d, curN);
			curN++;
		}
	};
	for (let d = 0; ; d++) {
		st.depth = d;
		// (the states at layer d: the children of layer d - 1, then the starts whose tick is t0 + d)
		inject(d);
		layers[d] = { par: Int32Array.from(curPar), msk: Uint8Array.from(curMsk) };
		if (found >= 0) break;
		if (d >= maxDepth) break;
		if (curN === 0 && si >= order.length) break;
		if (curN > st.maxOpen) st.maxOpen = curN;
		st.states += curN;
		const c = d + 1;
		const lim = maxDepth - c - tr;
		const par = [], msk = [];
		let n = 0;
		for (let i = 0; i < curN; i++) {
			if ((i & 127) === 0) {
				const now = Date.now();
				if (now > deadline) return done('time', { layers });
				if (stop !== null && now - lastPoll >= 20) { lastPoll = now; if (stop()) return done('stopped', { layers }); }
			}
			const masks = EG.probeMasks(sim, inp, cur[i]);
			st.ticks++;
			for (let k = 0; k < masks.length; k++) {
				const m = masks[k];
				if (k > 0) { sim.restore(cur[i]); E.applyMask(inp, m); sim.tick(inp); st.ticks++; }
				if (sim.is_dead && !allowDeath) { st.dead++; continue; }
				if (!sim.is_dead && goalAt(goal, sim, t0 + c, beforeTick)) {
					st.goals++;
					if (found < 0) found = c;
					if (goals.length < collect) goals.push({ layer: c, par: i, msk: m });
					continue;
				}
				// (the goal's layer is complete once its other goal states are seen: nothing more to keep)
				if (found >= 0) continue;
				const h = sim.stateHash();
				if (rejoin !== null) {
					const j = rejoin.get(h);
					if (j !== undefined && j - (t0 + c) >= rjMin && (bestRj === null || j - (t0 + c) > bestRj.gain)) bestRj = { gain: j - (t0 + c), layer: c, par: i, msk: m, tick: j };
				}
				if (!seen.add(h)) { st.merged++; continue; }
				if (lim < 0 || bound(lim) > lim) { st.cut++; continue; }
				if (field !== null && disc0 !== undefined && dk(sim) === disc0 && RF.costAt(field, sim) < 0) { st.cutField++; continue; }
				nxt[n] = sim.snapshot(nxt[n]);
				par.push(i); msk.push(m);
				if (track !== null && distField) trackState(track, distField, sim, c, n);
				n++;
				if (n > cap) return done('cap', { layers, open: n });
			}
			if (seen.size >= MAX_SEEN) return done('cap', { layers, seen: seen.size });
		}
		// the two layers' snapshot pools swap (the starts' own snapshots are never reused: inject copies them)
		const sw = cur;
		cur = nxt; curN = n; nxt = sw;
		curPar = par; curMsk = msk;
		if (found >= 0) {
			// (the goal states of layer c were all seen while layer d was expanded)
			st.depth = c;
			layers[c] = { par: Int32Array.from(par), msk: Uint8Array.from(msk) };
			break;
		}
	}
	if (found < 0) return done('proof', { layers });
	// the found layer's goal states: their tails (the path from their start)
	const out = [];
	for (const g of goals) out.push(pathOf(layers, g.layer, g.par, g.msk, starts, t0));
	const first = out[0];
	return done('found', { depth: found, tick: t0 + found, start: first.start, tail: first.tail, goals: out, layers });
}
/** the path of a goal (or any) state: {start, tail, depth} (depth = its layer; tail from its start's tick) */
function pathOf(layers, layer, par, msk, starts, t0) {
	const rev = [];
	let e = layer, idx = par;
	if (msk >= 0) rev.push(msk);
	else { const s = -1 - par; return { start: s, tail: new Uint8Array(0), depth: layer }; }
	// idx: the parent's index in layer e - 1
	e = layer - 1;
	for (;;) {
		const L = layers[e];
		const p = L.par[idx];
		if (p < 0) {
			const s = -1 - p;
			const tail = Uint8Array.from(rev.reverse());
			return { start: s, tail, depth: layer, startTick: starts[s].tick, check: starts[s].tick - t0 === e };
		}
		rev.push(L.msk[idx]);
		idx = p;
		e--;
	}
}
/** the path of a kept state (layer, index in that layer) */
function pathOfKept(layers, layer, idx, starts, t0) {
	const L = layers[layer];
	if (!L || idx >= L.par.length) return null;
	const p = L.par[idx];
	if (p < 0) return { start: -1 - p, tail: new Uint8Array(0), depth: layer };
	return pathOf(layers, layer, p, L.msk[idx], starts, t0);
}
/** the closest state by a field (tiles; -1 = none), kept as (layer, index) */
function trackState(track, field, sim, layer, idx) {
	const c = RF.costAt(field, sim);
	if (c < 0) return;
	if (track.dist === undefined || track.dist < 0 || c < track.dist) { track.dist = c; track.layer = layer; track.idx = idx; }
}

// ---------------------------------------------------------------- a HashSet with a size cap (endgame.HashSet's layout)
class HashSetLocal extends EG.HashSet {}

// ---------------------------------------------------------------- iterative deepening
/**
 * solveExact(L, starts, goal, o) -> {status, depth, tick, start, tail, goals, lb (absolute layers from the earliest start:
 * no goal before it), proven, runs [{maxDepth, status, states, seconds}], stats (the last run's), closest}
 * o: exactLeg's options + {startDepth (default max(8, the bound at the earliest start + 1)), growth 1.5, maxDepthCap (the
 * largest maxDepth tried; default beforeTick's or 4096), deadline}.
 */
function solveExact(L, starts, goal, o) {
	o = o || {};
	const sim = o.sim || new E.EESim(L);
	const order = starts.map((s, i) => i).sort((a, b) => starts[a].tick - starts[b].tick);
	const t0 = starts[order[0]].tick;
	const beforeTick = o.beforeTick >= 0 ? o.beforeTick : -1;
	let top = o.maxDepthCap > 0 ? o.maxDepthCap : 4096;
	if (beforeTick >= 0) top = Math.min(top, beforeTick - t0);
	// the bound at each start (ticks), its layer offset: the least is where the search can end first
	let h0 = Infinity;
	const trophy = goal.kind === 'trophy';
	const useBound = !o.noBound && !o.allowDeath;
	const B = useBound ? (o.B || boundFor(L, goal)) : null;
	for (const s of order) {
		sim.restore(starts[s].snap);
		let h = useBound ? EG.lowerBound(B, sim, 4096) : 0;
		if (useBound && o.bounds && typeof o.bounds.leg === 'function') { const h2 = o.bounds.leg(sim, goal); if (h2 > h) h = h2; }
		h += (trophy ? 1 : 0) + (starts[s].tick - t0);
		if (h < h0) h0 = h;
	}
	const lbStart = Number.isFinite(h0) ? h0 : 0;
	let D = o.startDepth > 0 ? o.startDepth : Math.max(8, lbStart);
	const growth = o.growth > 1 ? o.growth : 1;
	const runs = [];
	let lb = lbStart, last = null;
	if (top < 0) return { status: 'proof', lb: 0, proven: false, runs, stats: null, closest: o.track || null, t0, emptyWindow: true };
	for (;;) {
		if (D > top) D = top;
		const r = exactLeg(L, starts, goal, Object.assign({}, o, { sim, maxDepth: D, B }));
		runs.push({ maxDepth: D, status: r.status, states: r.stats.states, ticks: r.stats.ticks, seconds: r.stats.seconds, cut: r.stats.cut, merged: r.stats.merged });
		last = r;
		if (r.status === 'found') return Object.assign(r, { lb: r.depth, proven: true, runs });
		if (r.status !== 'proof') return Object.assign(r, { lb, proven: false, runs });
		lb = Math.max(lb, D + 1);
		// (no state cut by the bound and the open layer ran empty before D: no deeper search finds more)
		if (D >= top || (r.stats.cut === 0 && r.stats.depth < D)) return Object.assign(r, { lb, proven: false, runs, exhausted: true });
		if (Date.now() > (o.deadline || Infinity)) return Object.assign(r, { status: 'time', lb, proven: false, runs });
		// (one tick of slack more multiplies the open states ~4-7x on open ground (the key leg of test/planexec.js: 12 k,
		// 85 k, 550 k states at 38 / 39 / 40): +1 a run costs ~1.2x the last run in all, x1.5 jumped past the cap at once)
		D = growth > 1.5 ? Math.max(D + 1, Math.ceil(D * growth)) : D + 1;
	}
}

module.exports = { exactLeg, solveExact, boundFor, discKey, pathOf, pathOfKept, goalAt, DEF_CAP, MAX_SEEN };
