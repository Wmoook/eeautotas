'use strict';
// THE JOINS (n5-perfect, part 1 + 4): a finished route re-derived as a CHAIN OF SOLVED LEGS WITH THE SPEED CARRIED ACROSS
// THE JOINS, and every leg of the result offered to the certified bounds (PROOFS).
//
// A chain of individually optimal legs is not optimal: the cheapest leg to a support ends with the speed it happens to
// have, and the next leg pays for it. So the route is cut at its SUPPORTS (the moves study's boundaries: a landing, a
// field entered, a teleport, a death and its respawn; kept where the route's own first arrival at the support's centre
// tile + class + trigger state is the boundary itself: the waypoints), and a DP runs over
//     (waypoint k, the ARRIVAL CLASS: the speed rounded to 1/2 px/tick, grounded, the jump count, the position in 4 px
//      cells: the sub-pixel / speed class of the join)
// keeping the earliest exact engine state per class (a frontier of at most F classes a waypoint, the route's own state
// always among them). Its edges, from every kept state:
//   - FOLLOW: the route's own inputs to the next waypoint (from the route's state: the route itself, exact);
//   - LEGS: src/plan/msolve.js's solved leg to waypoint k + 1 .. k + M (a SKIP over supports: the polish's skips as
//     derivations), with its landing hop and up to A more verified legs with distinct end states (`alts`: the speed
//     carried), each replayed by the engine from the state and kept only when it arrives at the waypoint's tile, class
//     and trigger state (the progress key: keys, coins taken (which ones), switches, the checkpoint, effects) alive.
// The waypoints are ordered, so the DP is a forward pass (a DAG); the answer is the earliest state at the finish, its
// inputs the chain of its edges, replayed by the engine as a whole route (common.js evaluate) and kept only when it
// finishes sooner (judge). Never slower: the route's own chain is always in the frontier.
//
// PROOFS: every leg of the result is offered to the event-graph bound (src/math/lb.js certify) and the plain certificate
// (msolve): a leg whose ticks equal a certified bound from its exact start state is PROVEN OPTIMAL (no input sequence
// reaches that support sooner from that state). A route is proven optimal only by a bound from the level's start (the
// compile's own proof stage): the report gives the gap to the compile's route bound otherwise.
//
//   joinRoute(L, masks, o) -> {masks, runTicks, before, saved, waypoints, legs [{from, to, ticks, lb, proven, provenBy,
//       tool, skip}], proven, stats, ms}
//   o: {ms (default 60000), F (frontier classes a waypoint, 6), M (the most supports a leg spans, 4), A (alts, 3),
//       span (the most route ticks a leg spans, 120), legMs (a leg's clock, 60), prove (true), proveMs (40), stop, log}
//   waypointsOf(L, masks) -> {wps [{t, tile, cls, tele, fixed, prog}], finish, n}
//   progKey(sim) -> a number (the trigger state: what a later door, gate or respawn reads)
const C = require('../common.js');
const E = C.E;
const MS = require('./msolve.js');
const X = require('./exact.js');

const TELEPORT_PX = 20;
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);

/** the trigger state a later door, gate, respawn or effect reads: discKey + which coins + switches + checkpoint + effects */
function progKey(sim) {
	let h = X.discKey(sim) >>> 0;
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	sim._fillKey();
	const I = sim._keyI, Lv = sim.level;
	if (Lv.coinTiles && Lv.coinTiles.length !== 0) for (let w = 0; w < Lv.coinWords; w++) mix(I[sim._coinOff + w] | 0);
	mix(I[8] | 0);                                   // the checkpoint
	mix(I[4] | 0); mix(I[5] | 0); mix(I[6] | 0); mix(I[7] | 0);   // max_jumps, jump / speed boosts, flip
	mix(I[0] & (8 | 16 | 32 | 64 | 128 | 256 | 65536 | 131072 | 512 | 262144 | 524288));   // crowns, low gravity, protection, timed effects, levitation
	let s1 = 0, s2 = 0;
	if (sim._switches && sim._switches.size) for (const [k, v] of sim._switches) if (v === true) s1 = (s1 + Math.imul((k | 0) + 0x9e37, 0x85ebca6b)) | 0;
	if (sim._oswitches && sim._oswitches.size) for (const [k, v] of sim._oswitches) if (v === true) s2 = (s2 + Math.imul((k | 0) + 0x7f4a, 0xc2b2ae35)) | 0;
	mix(s1); mix(s2);
	return h >>> 0;
}

function tileOfSim(sim, W, H) {
	let tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
	if (tx < 0) tx = 0; else if (tx >= W) tx = W - 1;
	if (ty < 0) ty = 0; else if (ty >= H) ty = H - 1;
	return ty * W + tx;
}

/**
 * the route's waypoints: the support boundaries (movesOf's rule: a teleport, a respawn, a class change INTO a support
 * class), kept where the route's first arrival after the previous waypoint at (tile, class, trigger state) is the
 * boundary itself; the last one the finish (the first tick with the silver crown). fixed: a death or a respawn (FOLLOW
 * edges only, no leg across it)
 */
function waypointsOf(L, masks) {
	const W = L.width, H = L.height, flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	const cls = new Array(n + 1), tile = new Int32Array(n + 1), tp = new Uint8Array(n + 1), prog = new Float64Array(n + 1);
	cls[0] = MS.clsOf(sim, flags); tile[0] = tileOfSim(sim, W, H); prog[0] = progKey(sim);
	let finish = -1;
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		E.applyMask(inp, masks[t]); sim.tick(inp);
		cls[t + 1] = MS.clsOf(sim, flags); tile[t + 1] = tileOfSim(sim, W, H); prog[t + 1] = progKey(sim);
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		if (sim.has_silver_crown) { finish = t + 1; break; }
	}
	if (finish < 0) return null;
	const bnd = [];
	for (let t = 1; t < finish; t++) {
		const a = cls[t - 1], b = cls[t];
		if (tp[t] || (a === 'D' && b !== 'D') || (b !== a && SUPPORT.has(b))) bnd.push(t);
	}
	const wps = [{ t: 0, tile: tile[0], cls: cls[0], tele: false, fixed: false, prog: prog[0] }];
	const clsT = (c) => (c === 'A' ? 'any' : c);
	const match = (u, b) => tile[u] === tile[b] && prog[u] === prog[b] && (clsT(cls[b]) === 'any' || cls[u] === cls[b]) && (!tp[b] || tp[u] === 1) && (cls[b] === 'D' || cls[u] !== 'D');
	for (const b of bnd) {
		const a = wps[wps.length - 1].t;
		let first = true;
		for (let u = a + 1; u < b; u++) if (match(u, b)) { first = false; break; }
		if (!first) continue;
		const fixed = cls[b] === 'D' || cls[b - 1] === 'D';
		wps.push({ t: b, tile: tile[b], cls: clsT(cls[b]), tele: !!tp[b], fixed, prog: prog[b] });
	}
	wps.push({ t: finish, tile: tile[finish], cls: 'any', tele: false, fixed: false, prog: -1, finish: true });
	return { wps, finish, n, cls, tile, tp, prog };
}

/** the DP's class of a join state: the speed to 1/2 px/tick, grounded, the jump count, the position in 4 px cells */
function classKey(s) {
	return `${Math.round(s.speed_x * 2)},${Math.round(s.speed_y * 2)},${s.on_ground ? 1 : 0},${s.jump_count},${Math.floor(s.px / 4)},${Math.floor(s.py / 4)}`;
}

function joinRoute(L, masks0, o) {
	o = o || {};
	const t0 = Date.now();
	const ms = o.ms > 0 ? o.ms : 60000, deadline = t0 + ms;
	const F = o.F > 0 ? o.F : 6, M = o.M > 0 ? o.M : 4, A = o.A >= 0 ? o.A : 3, SPAN = o.span > 0 ? o.span : 120;
	const LEG_MS = o.legMs > 0 ? o.legMs : 60, DIV = o.div >= 0 ? o.div : 6;
	const stop = typeof o.stop === 'function' ? o.stop : null;
	const log = typeof o.log === 'function' ? o.log : null;
	const W = L.width, H = L.height;
	const ev0 = C.evaluate(L, masks0, true);
	if (!ev0) return { masks: masks0, runTicks: -1, before: -1, saved: 0, why: 'the route does not finish' };
	const masks = ev0.ms;
	const WP = waypointsOf(L, masks);
	if (!WP) return { masks, runTicks: ev0.runTicks, before: ev0.runTicks, saved: 0, why: 'no finish in the trace' };
	const wps = WP.wps, m = wps.length - 1;
	const S = MS.createSolver(L, {});
	const sim = new E.EESim(L), inp = new E.EEInput();
	// the route's states at the waypoints (snapshots, hashes)
	const rSnap = new Array(m + 1), rHash = new Float64Array(m + 1);
	{
		sim.reset();
		let k = 0;
		for (let t = 0; t <= WP.finish && k <= m; t++) {
			while (k <= m && wps[k].t === t) { rSnap[k] = sim.snapshot(); rHash[k] = sim.stateHash(); k++; }
			if (t < WP.finish) { E.applyMask(inp, masks[t]); sim.tick(inp); }
		}
	}
	const stats = { legs: 0, legOk: 0, cands: 0, arrivals: 0, follow: 0, skips: 0, nodes: 0, pruned: 0, legMs: 0 };
	// the arrival test of waypoint j on a live state: the tile, the class, the trigger state, a teleport tick, alive; the
	// finish: the silver crown
	const arrives = (j, s, px, py) => {
		const w = wps[j];
		if (w.finish) return !!s.has_silver_crown;
		if (w.cls === 'D') return s.is_dead && tileOfSim(s, W, H) === w.tile;
		if (s.is_dead) return false;
		if (tileOfSim(s, W, H) !== w.tile) return false;
		if (w.cls !== 'any' && MS.clsOf(s, L.flags) !== w.cls) return false;
		if (w.tele && !(Math.abs(s.px - px) > TELEPORT_PX || Math.abs(s.py - py) > TELEPORT_PX)) return false;
		return progKey(s) === w.prog;
	};
	/** replay masks from a snapshot: the first tick (1-based) the waypoint j holds, 0 none (a death ends it unless j is a death) */
	const replayTo = (snap, ms_, j, extraHold) => {
		sim.restore(snap);
		const n = ms_.length + (extraHold || 0);
		for (let t = 0; t < n; t++) {
			const px = sim.px, py = sim.py;
			E.applyMask(inp, t < ms_.length ? ms_[t] : (ms_[ms_.length - 1] & 30));
			sim.tick(inp);
			if (arrives(j, sim, px, py)) return t + 1;
			if (sim.is_dead && wps[j].cls !== 'D') return 0;
			if (sim.has_silver_crown && !wps[j].finish) return 0;
		}
		return 0;
	};
	// the frontier per waypoint: class -> node {snap, g, hash, route (the route's own state), par, ms, how}
	const front = new Array(m + 1);
	for (let k = 0; k <= m; k++) front[k] = new Map();
	const best = new Float64Array(m + 1).fill(Infinity);
	const root = { snap: rSnap[0], g: 0, hash: rHash[0], route: true, par: null, ms: null, how: 'start', k: 0 };
	front[0].set('route', root);
	best[0] = 0;
	const put = (j, node) => {
		stats.arrivals++;
		const key = node.route ? 'route' : node.key;
		const cur = front[j].get(key);
		if (cur && cur.g <= node.g) return false;
		front[j].set(key, node);
		if (node.g < best[j]) best[j] = node.g;
		return true;
	};
	/** a child node at waypoint j from `par` by the inputs ms_ (their first arrival already replayed: sim holds it) */
	const child = (j, par, ms_, how, tool) => {
		const h = sim.stateHash();
		const isRoute = h === rHash[j] && par.g + ms_.length === wps[j].t;
		return { snap: sim.snapshot(), g: par.g + ms_.length, hash: h, route: isRoute, par, ms: ms_, how, tool, k: j, key: classKey(sim) };
	};
	const targets = new Array(m + 1);
	for (let j = 1; j <= m; j++) {
		const w = wps[j];
		targets[j] = { tiles: [w.tile], cls: w.finish ? 'any' : w.cls };
	}
	let timeUp = false;
	for (let k = 0; k < m; k++) {
		if (Date.now() > deadline || (stop && stop())) { timeUp = true; }
		// the frontier: the route's state first, then the earliest classes (F in all)
		const all = Array.from(front[k].values()).sort((a, b) => (b.route - a.route) || a.g - b.g);
		const keep = timeUp ? all.filter((x) => x.route).slice(0, 1) : all.slice(0, F);
		stats.pruned += all.length - keep.length;
		stats.nodes += keep.length;
		// (no route state kept at k (a faster chain replaced it): the route's inputs from the earliest kept state still follow)
		// the time left for this waypoint's legs
		const share = timeUp ? 0 : Math.max(5, (deadline - Date.now()) / Math.max(1, m - k));
		const wEnd = Date.now() + share;
		for (const nd of keep) {
			// FOLLOW: the route's own inputs to waypoint k + 1
			{
				const j = k + 1;
				const seg = masks.subarray(wps[k].t, wps[j].t);
				if (nd.route) {
					sim.restore(rSnap[j]);
					put(j, { snap: rSnap[j], g: wps[j].t, hash: rHash[j], route: true, par: nd, ms: seg, how: 'follow', tool: 'route', k: j, key: 'route' });
					stats.follow++;
				} else if (nd.g + 1 <= best[j] + DIV) {
					const h = replayTo(nd.snap, seg, j, 8);
					if (h > 0) {
						const ms_ = new Uint8Array(h);
						for (let t = 0; t < h; t++) ms_[t] = t < seg.length ? seg[t] : (seg[seg.length - 1] & 30);
						put(j, child(j, nd, ms_, 'follow', 'route'));
						stats.follow++;
					}
				}
			}
			if (timeUp || Date.now() > wEnd) continue;
			// LEGS to k + 1 .. k + M (never across a fixed waypoint: a death / respawn is followed, not solved)
			if (nd.snap && (() => { sim.restore(nd.snap); return sim.is_dead; })()) continue;
			for (let j = k + 1; j <= Math.min(m, k + M); j++) {
				if (Date.now() > wEnd) break;
				const w = wps[j];
				if (wps[j - 1].fixed && j - 1 > k) break;
				if (w.fixed || w.tele) { if (w.fixed) break; continue; }
				const span = w.t - wps[k].t;
				if (span > SPAN && j > k + 1) break;
				// the leg is worth it only when it can arrive before the best arrival there + the diversity slack
				const Tmax = Math.min(Math.max(span + 4, 8), Math.max(0, best[j] + DIV - nd.g));
				if (Tmax < 1) continue;
				const lt = Date.now();
				let r = null;
				try {
					r = S.leg(nd.snap, targets[j], { Tmax, chain: false, prove: false, alts: A, altSlack: 4, fieldMs: Math.min(40, LEG_MS), coupledTicks: 150000, nodes: 60000, deadline: Math.min(wEnd, lt + LEG_MS) });
				} catch (e) { r = null; }
				stats.legs++; stats.legMs += Date.now() - lt;
				if (!r || !r.ok) continue;
				stats.legOk++;
				if (j > k + 1) stats.skips++;
				const cands = [r.masks];
				if (r.hop) cands.push(r.hop);
				if (Array.isArray(r.alts)) for (const a of r.alts) cands.push(a.masks);
				for (const c of cands) {
					stats.cands++;
					const h = replayTo(nd.snap, c, j, w.finish ? 3 : 0);
					if (h <= 0) continue;
					const ms_ = new Uint8Array(h);
					for (let t = 0; t < h; t++) ms_[t] = t < c.length ? c[t] : (c[c.length - 1] & 30);
					put(j, child(j, nd, ms_, j > k + 1 ? `leg skip ${j - k}` : 'leg', r.tool));
				}
			}
		}
		// (the frontier of k is done: its snapshots are no longer needed (the parents keep their inputs))
		for (const nd of front[k].values()) nd.snap = null;
		if (log && (k % 50 === 0)) log(`wp ${k}/${m} t ${wps[k].t} best ${best[k]} front ${front[k].size} legs ${stats.legs} ok ${stats.legOk}`);
	}
	// the finish: the earliest node
	let fin = null;
	for (const nd of front[m].values()) if (!fin || nd.g < fin.g) fin = nd;
	const chain = [];
	for (let x = fin; x && x.par; x = x.par) chain.push(x);
	chain.reverse();
	let total = 0;
	for (const x of chain) total += x.ms.length;
	const out = new Uint8Array(total);
	{ let at = 0; for (const x of chain) { out.set(x.ms, at); at += x.ms.length; } }
	const ev = C.evaluate(L, out, true);
	let result = ev0, accepted = false;
	if (ev) {
		const v = C.judge(ev, ev0, o.maxDeaths === undefined ? Infinity : o.maxDeaths);
		if (v.accept && ev.runTicks < ev0.runTicks) { result = ev; accepted = true; }
	}
	// the legs of the result (its chain when accepted, else the route's own chain)
	let legs = [];
	const legChain = accepted ? chain : (() => {
		const c = [];
		let prev = root;
		for (let j = 1; j <= m; j++) { const x = { par: prev, ms: masks.subarray(wps[j - 1].t, wps[j].t), how: 'follow', tool: 'route', k: j, g: wps[j].t }; c.push(x); prev = x; }
		return c;
	})();
	{
		let g = 0;
		for (const x of legChain) { legs.push({ from: g, to: g + x.ms.length, ticks: x.ms.length, wp: x.k, how: x.how, tool: x.tool, lb: null, proven: false, provenBy: null }); g += x.ms.length; }
	}
	// PROOFS: each leg from its exact start state (the result's own replay) against the certified bounds
	let proven = 0, provenTicks = 0, lbSum = 0, asked = 0;
	if (o.prove !== false) {
		const MLB = require('../math/lb.js').createMathLB(L);
		const res = accepted ? result.ms : masks;
		sim.reset();
		let t = 0;
		const pEnd = Date.now() + (o.proveBudget > 0 ? o.proveBudget : Math.max(2000, Math.min(20000, ms / 4)));
		for (const lg of legs) {
			while (t < lg.from) { E.applyMask(inp, res[t]); sim.tick(inp); t++; }
			if (Date.now() < pEnd && !sim.is_dead) {
				const w = wps[lg.wp];
				const snap = sim.snapshot();
				let lb = null, how = null;
				try {
					// the plain certificate (msolve's bound, certified) and the event-graph bound
					const tg = { tiles: [w.tile], cls: w.finish ? 'any' : w.cls };
					const b = S.lowerBound(snap, tg);
					if (b > 0) { lb = b; how = 'plain?'; }
					sim.restore(snap);
					asked++;
					const r = MLB.certify(sim, { tiles: [w.tile], mode: !w.finish && w.cls === 'G' ? 'land' : 'touch' }, lg.ticks, { cap: 4000, ms: o.proveMs > 0 ? o.proveMs : 40 });
					if (r && r.lb !== null && r.lb !== undefined) {
						if (lb === null || r.lb > lb) { lb = r.lb; how = 'events'; }
						if (r.proven && r.lb === lg.ticks) { lg.proven = true; lg.provenBy = 'events'; }
					}
				} catch (e) { /* no bound */ }
				sim.restore(snap);
				lg.lb = lb;
				if (!lg.proven && how === 'plain?') lg.lb = null;   // (the plain bound is claimed only through leg()'s certificate)
				if (lg.proven) { proven++; provenTicks += lg.ticks; }
				if (Number.isFinite(lg.lb)) lbSum += lg.lb;
			}
		}
	}
	return {
		masks: result.ms, runTicks: result.runTicks, before: ev0.runTicks, saved: ev0.runTicks - result.runTicks, accepted,
		chainTicks: fin ? fin.g : -1, routeFinish: WP.finish, waypoints: m, legs, proven, provenTicks, proveAsked: asked, lbSum,
		provenRoute: false, stats, timeUp, ms: Date.now() - t0,
	};
}

module.exports = { joinRoute, waypointsOf, progKey, classKey };
