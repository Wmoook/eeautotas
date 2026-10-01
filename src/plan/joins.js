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
//   o: {ms (default 60000), F (frontier classes a waypoint, 10), M (the most supports a leg spans, 6), A (alts, 3),
//       span (the most route ticks a leg spans, 200), legMs (a leg's clock, 60), prove (true), proveMs (40), stop, log}
//   waypointsOf(L, masks) -> {wps [{t, tile, cls, tele, fixed, prog}], finish, n}
//   progKey(sim) -> a number (the trigger state: what a later door, gate or respawn reads)
const C = require('../common.js');
const E = C.E;
const MS = require('./msolve.js');
const X = require('./exact.js');

const TELEPORT_PX = 20;
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);
const TRIG = process.env.EEAT_JOINS_TRIG === '1';   // OPT-IN: more waypoints, less clock each (Gingerbread House 60 s: 5,173 with vs 5,131 without; Tutorial 1 2,423 vs 2,399)
// EXACT EDGES (the exact per-leg re-derivation at every join): from the whole kept frontier of a waypoint at once (every
// kept state injected at its own absolute tick), exact.js exactLeg to the next waypoints (tile + class + trigger state,
// alive): its first goal layer is the minimum over EVERY input sequence from EVERY kept state (up to 53-bit hash
// collisions), and every goal state of that layer (the speed classes at the minimum) goes into the DP.
// OPT-IN EEAT_JOINS_EXACT=1 (box 6, 24 stacked routes, 90 s, arms side by side: 58,791 vs 58,638 without: better 5, worse 8; the exact edges take 40% of each waypoint's clock); off = the DP of before byte for byte.
const EXACT = process.env.EEAT_JOINS_EXACT === '1';
// EXACT PROOFS: a leg no certified bound reaches is searched exhaustively from its exact start state to depth ticks - 1:
// the search running out of states = no input sequence reaches the support sooner (PROVEN OPTIMAL, provenBy 'exact'); a
// goal found = a faster leg from that very state (fasterExact). EEAT_JOINS_XPROVE=0: off.
const XPROVE = process.env.EEAT_JOINS_XPROVE !== '0';
// LONG SKIPS (OPT-IN EEAT_JOINS_LONG=1): every third pass is the sparse pass (every 4th support a waypoint, legs by msolve's
// chain tier: a new path over several supports, the speed carried as ever)
const LONGJ = process.env.EEAT_JOINS_LONG === '1';
// THE WIDE DP (the default since round 3 of the stack: box 6, the 24 stacked routes, 150 s a level, arms side by side:
// 57,897 vs 58,095 run ticks, better 6 / worse 1: Frostbitten 8,640 vs 8,749, Fish Gods 3,933 vs 4,010): 10 classes a
// waypoint, legs over up to 6 supports and 200 route ticks, 8 ticks of diversity slack; EEAT_JOINS_NARROW=1: the first
// version's 6 / 4 / 120 / 6
const DEF = process.env.EEAT_JOINS_NARROW === '1' ? { F: 6, M: 4, span: 120, div: 6 } : { F: 10, M: 6, span: 200, div: 8 };
// SHIFTED FOLLOWS: a kept state that is not the route's replays the route's segment inputs from s = 1 .. SHIFT0 ticks in
// too (EEAT_JOINS_SHIFT=<n>, 0: off)
const SHIFT0 = process.env.EEAT_JOINS_SHIFT !== undefined ? Math.max(0, +process.env.EEAT_JOINS_SHIFT | 0) : 0;
// THE BRIDGE (VERSUS, default on; EEAT_JOINS_BRIDGE=0 off): a gain in hand at a waypoint (the route's tick less the earliest
// arrival) that no follow or leg carries to the next waypoints is carried by bridgeTo from its earliest carriers (the
// route's inputs SHIFTED, msolve on a longer clock, the exact search on short spans), BR_MS a carrier, BR_NODES carriers
const BRIDGE = process.env.EEAT_JOINS_BRIDGE !== '0';
const BR_SPAN = 16, BR_MS = +(process.env.EEAT_JOINS_BRIDGE_MS || 300), BR_CAP = 4000, BR_NODES = 2;
const BR_SHIFTS = [1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8, 12, -12, 16, -16];
// THE DETOUR SKIPS (P4, OPT-IN EEAT_JOINS_LOOP=1, off = the DP of before byte for byte): a leg from a kept state at
// waypoint k to a LATER waypoint j past the span (j.t - k.t > span) whose tile is within LOOP_R tiles of k's (Chebyshev)
// and whose trigger state (the blind key) is k's: the route left that place and came back with nothing a later door,
// gate or respawn reads (the slow routes' crumb detours: Tutorial 2's blue coin (29,10), +1,971 ticks between two
// visits of the coin-2 area; Trick Or Treat's coin (146,100); Tutorial 4's three blue coins); at most LOOP_J such j a
// state, the farthest first, LOOP_MS a leg; every arrival replayed and put like any leg's (the arrival test: the tile,
// the class, the trigger state, alive), the whole chain replayed and judged at the end as ever
const LOOP = process.env.EEAT_JOINS_LOOP === '1';
const LOOP_R = +process.env.EEAT_JOINS_LOOP_R > 0 ? +process.env.EEAT_JOINS_LOOP_R : 6;
const LOOP_J = +process.env.EEAT_JOINS_LOOP_J > 0 ? +process.env.EEAT_JOINS_LOOP_J : 3;
const LOOP_MS = +process.env.EEAT_JOINS_LOOP_MS > 0 ? +process.env.EEAT_JOINS_LOOP_MS : 500;
const LOOP_FMS = +process.env.EEAT_JOINS_LOOP_FMS > 0 ? +process.env.EEAT_JOINS_LOOP_FMS : 200;
const LOOP_SHARE = +process.env.EEAT_JOINS_LOOP_SHARE > 0 ? +process.env.EEAT_JOINS_LOOP_SHARE : 0.3;

/**
 * THE BLIND KEY (VERSUS, default on; EEAT_JOINS_BLIND=0 off): what no later door, gate or respawn of this level / route can
 * read is left out of the trigger state, so a join that skips it is a join: a coin colour with no coin door or gate of its
 * colour in the level (gold 43 / 165, blue 213 / 214; not with portal entries on coin cells: common.js coinFreeOk) and the
 * checkpoint on a route with no death (a checkpoint is read only by a respawn; every leg and follow that dies is refused,
 * and the whole chain is replayed and judged: no more deaths). A colour is blind on THIS ROUTE too when the route never
 * holds as many coins of it as its lowest door / gate number (`maxC` {gold, blue}: the route's counts at its finish; its
 * doors stay shut and its gates open all along the route: Trick Or Treat's 14-coin doors, the route's 1-6 coins).
 * -> {gold, blue, cp (true = blind), keep (the coin words' masks)} or null
 */
function blindOf(L, deaths, maxC) {
	if (process.env.EEAT_JOINS_BLIND === '0') return null;
	let gold = true, blue = true, gMin = Infinity, bMin = Infinity;
	for (let i = 0; i < L.fg.length; i++) {
		const v = L.fg[i];
		if (v === 43 || v === 165) { gold = false; gMin = Math.min(gMin, L.lookup0[i] | 0); } else if (v === 213 || v === 214) { blue = false; bMin = Math.min(bMin, L.lookup0[i] | 0); }
	}
	if (maxC && !gold && maxC.gold < gMin) gold = true;
	if (maxC && !blue && maxC.blue < bMin) blue = true;
	if (!C.coinFreeOk(L)) gold = blue = false;
	const cp = deaths === 0;
	if (!gold && !blue && !cp) return null;
	const keep = new Int32Array(L.coinWords || 0).fill(-1);
	if (L.coinTiles) for (let k = 0; k < L.coinTiles.length; k++) {
		const g = L.coinBaseId[k] === 100;   // eesim.js COIN_GOLD 100, COIN_BLUE 101
		if ((g && gold) || (!g && blue)) keep[k >> 5] &= ~(1 << (k & 31));
	}
	return { gold, blue, cp, keep };
}

/** exact.js discKey with a blind colour's count and shown gate count left out (the same mixing otherwise) */
function discBlind(sim, bl) {
	let h = 0x811c9dc5;
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	mix(sim._keysMask | 0); mix(bl.gold ? 0 : sim.coins | 0); mix(bl.blue ? 0 : sim.blue_coins | 0); mix(sim.deaths | 0); mix(sim.team | 0);
	mix((sim._collide_crown ? 1 : 0) | (sim._collide_silver_crown ? 2 : 0) | (sim.is_zombie ? 4 : 0));
	mix(bl.gold ? 0 : sim._show_coin_gate | 0); mix(bl.blue ? 0 : sim._show_blue_coin_gate | 0); mix(sim._show_death_gate | 0);
	let s1 = 0, s2 = 0;
	for (const [k, v] of sim._switches) if (v === true) { s1 = (s1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; s2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
	mix(s1); mix(s2);
	let o1 = 0, o2 = 0;
	for (const [k, v] of sim._oswitches) if (v === true) { o1 = (o1 + Math.imul((k | 0) + 1, 0x9e3779b1)) | 0; o2 ^= Math.imul((k | 0) + 7, 0x85ebca6b); }
	mix(o1); mix(o2);
	return h >>> 0;
}

/** the exact.js goal of a waypoint (no teleport waypoint: its test reads the last tick's position): the tile, the class,
 *  the trigger state (bl: the blind key's), alive; the finish: the silver crown (exactLeg's trophy rule: the complete a
 *  tick after the tile) */
function wpGoal(L, w, bl) {
	const W = L.width, H = L.height;
	if (w.finish) {
		const tr = [];
		for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) tr.push(i);
		return { kind: 'trophy', tiles: Int32Array.from(tr), test: (s) => !!s.has_silver_crown };
	}
	const flags = L.flags;
	return {
		kind: 'support', tiles: Int32Array.from([w.tile]),
		test: (s) => !s.is_dead && tileOfSim(s, W, H) === w.tile && (w.cls === 'any' || MS.clsOf(s, flags) === w.cls) && progKey(s, bl) === w.prog,
	};
}

/** the trigger state a later door, gate, respawn or effect reads: discKey + which coins + switches + checkpoint + effects
 *  (bl: blindOf's parts left out) */
function progKey(sim, bl) {
	let h = bl ? discBlind(sim, bl) : (X.discKey(sim) >>> 0);
	const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
	sim._fillKey();
	const I = sim._keyI, Lv = sim.level;
	if (Lv.coinTiles && Lv.coinTiles.length !== 0) for (let w = 0; w < Lv.coinWords; w++) mix((I[sim._coinOff + w] & (bl ? bl.keep[w] : -1)) | 0);
	if (!bl || !bl.cp) mix(I[8] | 0);                 // the checkpoint
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
function waypointsOf(L, masks, o) {
	const W = L.width, H = L.height, flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const n = masks.length;
	const cls = new Array(n + 1), tile = new Int32Array(n + 1), tp = new Uint8Array(n + 1), prog = new Float64Array(n + 1);
	cls[0] = MS.clsOf(sim, flags); tile[0] = tileOfSim(sim, W, H); prog[0] = progKey(sim, o && o.blind);
	let finish = -1;
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		E.applyMask(inp, masks[t]); sim.tick(inp);
		cls[t + 1] = MS.clsOf(sim, flags); tile[t + 1] = tileOfSim(sim, W, H); prog[t + 1] = progKey(sim, o && o.blind);
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		if (sim.has_silver_crown) { finish = t + 1; break; }
	}
	if (finish < 0) return null;
	const bnd = [];
	for (let t = 1; t < finish; t++) {
		const a = cls[t - 1], b = cls[t];
		// (a TRIGGER is a boundary too (OPT-IN EEAT_JOINS_TRIG=1; o.triggers false: never): the first tick of a new trigger state (a coin, a key,
		// a switch taken in the air): a leg that reaches the next support sooner but misses it arrives in another trigger state
		// and is refused; with the trigger its own waypoint the chain goes to it first)
		const trig = TRIG && !(o && o.triggers === false) && prog[t] !== prog[t - 1] && b !== 'D' && a !== 'D';
		if (tp[t] || (a === 'D' && b !== 'D') || (b !== a && SUPPORT.has(b)) || trig) bnd.push(t);
	}
	const wps = [{ t: 0, tile: tile[0], cls: cls[0], tele: false, fixed: false, prog: prog[0] }];
	const clsT = (c) => (c === 'A' ? 'any' : c);
	const match = (u, b) => tile[u] === tile[b] && prog[u] === prog[b] && (clsT(cls[b]) === 'any' || cls[u] === cls[b]) && (!tp[b] || tp[u] === 1) && (cls[b] === 'D' || cls[u] !== 'D');
	// (a long stretch with no support (a flight through fields, a long fall) gets TILE-ENTRY waypoints every `gap` ticks:
	// the first tick the route's centre enters the tile it is in then (class any), so the speed is carried there too)
	const gap = o && o.gap > 0 ? o.gap : 0;
	const fill = (a, b) => {
		if (!gap || cls[a] === 'D') return;
		let cur = a;
		for (let u = a + gap; u < b - 4; u += 4) {
			if (u - cur < gap) continue;
			if (cls[u] === 'D' || tp[u]) continue;
			let v = u;
			for (let q = cur + 1; q <= u; q++) if (tile[q] === tile[u] && prog[q] === prog[u] && cls[q] !== 'D') { v = q; break; }
			if (v - cur < 4 || b - v < 4) continue;
			wps.push({ t: v, tile: tile[v], cls: 'any', tele: false, fixed: false, prog: prog[v], entry: true });
			cur = v;
		}
	};
	for (const b of bnd) {
		const a = wps[wps.length - 1].t;
		let first = true;
		for (let u = a + 1; u < b; u++) if (match(u, b)) { first = false; break; }
		if (!first) continue;
		fill(a, b);
		const fixed = cls[b] === 'D' || cls[b - 1] === 'D';
		wps.push({ t: b, tile: tile[b], cls: clsT(cls[b]), tele: !!tp[b], fixed, prog: prog[b] });
	}
	fill(wps[wps.length - 1].t, finish);
	wps.push({ t: finish, tile: tile[finish], cls: 'any', tele: false, fixed: false, prog: -1, finish: true });
	// (the SPARSE pass: every stride-th support only (and every fixed / teleport waypoint and the ones next to them, the
	// start and the finish): legs between them span several supports, solved with msolve's chain tier: the long skips)
	const stride = o && o.stride > 1 ? o.stride | 0 : 1;
	if (stride > 1) {
		const keep = wps.filter((w, i) => i === 0 || i === wps.length - 1 || w.fixed || w.tele || (i > 0 && (wps[i - 1].fixed || wps[i - 1].tele)) || i % stride === 0);
		return { wps: keep, finish, n, cls, tile, tp, prog };
	}
	return { wps, finish, n, cls, tile, tp, prog };
}

/** the DP's class of a join state: the speed to 1/2 px/tick, grounded, the jump count, the position in 4 px cells */
function classKey(s) {
	return `${Math.round(s.speed_x * 2)},${Math.round(s.speed_y * 2)},${s.on_ground ? 1 : 0},${s.jump_count},${Math.floor(s.px / 4)},${Math.floor(s.py / 4)}`;
}

/** one DP pass over the route's waypoints (the chain re-derived with the speed carried), until `deadline` */
function joinOnce(L, ev0, o, deadline, S) {
	const t0 = Date.now();
	const F = o.F > 0 ? o.F : DEF.F, M = o.M > 0 ? o.M : DEF.M, A = o.A >= 0 ? o.A : 3, SPAN = o.span > 0 ? o.span : DEF.span;
	const LEG_MS = o.legMs > 0 ? o.legMs : 60, DIV = o.div >= 0 ? o.div : DEF.div;
	const CHAIN = !!o.chain;
	const SHIFT = o.shift >= 0 ? o.shift : SHIFT0;
	const stop = typeof o.stop === 'function' ? o.stop : null;
	const log = typeof o.log === 'function' ? o.log : null;
	const W = L.width, H = L.height;
	const masks = ev0.ms;
	const WP = waypointsOf(L, masks, o);
	if (!WP) return { masks, ev: ev0, accepted: false, why: 'no finish in the trace' };
	const wps = WP.wps, m = wps.length - 1;
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
	const stats = { legs: 0, legOk: 0, cands: 0, arrivals: 0, follow: 0, skips: 0, nodes: 0, pruned: 0, legMs: 0, ex: 0, exFound: 0, exGoals: 0, exBest: 0, exMs: 0, shift: 0, bridge: 0, brShift: 0, brLeg: 0, brExact: 0, loops: 0, loopMs: 0, pads: 0 };
	let loopReach = 0, padPhase = false;
	const useExact = o.exact === undefined ? EXACT : !!o.exact;
	const EXF = o.exShare >= 0 ? o.exShare : 0.4, EXM = o.exM > 0 ? o.exM : 2, EXSPAN = o.exSpan > 0 ? o.exSpan : 64;
	const EXCAP = o.exCap > 0 ? o.exCap : 30000, EXDIV = o.exDiv >= 0 ? o.exDiv : 2;
	const goalsWp = new Array(m + 1);
	const goalWp = (j) => goalsWp[j] || (goalsWp[j] = wpGoal(L, wps[j], o.blind));
	const exSim = useExact ? new E.EESim(L) : null;
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
		return progKey(s, o.blind) === w.prog;
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
	/** a leg from node nd to waypoint j (msolve, its hop and alts), each arrival replayed and put */
	const legTo = (nd, k, j, wEnd, legMs, fMs) => {
		const w = wps[j];
		const span = w.t - wps[k].t;
		// (worth it only when it can arrive before the best arrival there + the diversity slack)
		const Tmax = Math.min(Math.max(span + 4, 8), Math.max(0, best[j] + DIV - nd.g));
		if (Tmax < 1) return false;
		const lt = Date.now();
		let r = null;
		try {
			r = S.leg(nd.snap, targets[j], { Tmax, chain: CHAIN, chainMs: CHAIN ? Math.max(100, legMs) : undefined, prove: false, alts: A, altSlack: 4, fieldMs: fMs > 0 ? fMs : Math.min(40, legMs), coupledTicks: 150000, nodes: 60000, deadline: Math.min(wEnd, lt + legMs) });
		} catch (e) { r = null; }
		stats.legs++; stats.legMs += Date.now() - lt;
		if (!r || !r.ok) return false;
		stats.legOk++;
		if (j > k + 1) stats.skips++;
		const cands = [r.masks];
		if (r.hop) cands.push(r.hop);
		if (Array.isArray(r.alts)) for (const x of r.alts) cands.push(x.masks);
		let any = false;
		for (const c of cands) {
			stats.cands++;
			const h = replayTo(nd.snap, c, j, w.finish ? 3 : 0);
			if (h <= 0) continue;
			const ms_ = new Uint8Array(h);
			for (let t = 0; t < h; t++) ms_[t] = t < c.length ? c[t] : (c[c.length - 1] & 30);
			put(j, child(j, nd, ms_, j > k + 1 ? `leg skip ${j - k}` : 'leg', r.tool));
			any = true;
			// (THE PHASE PAD, a detour skip on a time-door level: the skip moves the doors' phase (the level clock mod
			// TIMEDOOR_PERIOD) by its gain, and the route's later stretches meet shut doors; the same arrival padded with idle
			// ticks to the route's phase at j (the gain less its remainder mod the period) is a candidate too, when the ball
			// still holds the waypoint after them)
			if (padPhase && !w.finish) {
				const d = ((w.t - (nd.g + h)) % E.TIMEDOOR_PERIOD + E.TIMEDOOR_PERIOD) % E.TIMEDOOR_PERIOD;
				if (d > 0 && nd.g + h + d < w.t) {
					sim.restore(nd.snap);
					for (let t = 0; t < h; t++) { E.applyMask(inp, ms_[t]); sim.tick(inp); }
					let px = sim.px, py = sim.py, ok = true;
					for (let t = 0; t < d && ok; t++) { px = sim.px; py = sim.py; E.applyMask(inp, 0); sim.tick(inp); if (sim.is_dead) ok = false; }
					if (ok && arrives(j, sim, px, py)) {
						const ms2 = new Uint8Array(h + d);
						ms2.set(ms_, 0);
						put(j, child(j, nd, ms2, `leg skip ${j - k} +${d} idle`, r.tool));
						stats.pads++;
					}
				}
			}
		}
		return any;
	};
	/** EXACT EDGES from the kept live frontier of waypoint k to waypoint j: one exactLeg with every kept state injected at
	 *  its own absolute tick; every goal state of its first goal layer replayed and put */
	const exactTo = (live, k, j, exEnd) => {
		const w = wps[j];
		let t0 = Infinity;
		for (const nd of live) if (nd.g < t0) t0 = nd.g;
		if (!Number.isFinite(t0)) return false;
		// (the arrivals worth keeping: up to the best arrival there + EXDIV; the route's own span caps it)
		const upTo = Math.min(best[j] + EXDIV, t0 + (w.t - wps[k].t) + EXDIV);
		const maxDepth = upTo - t0;
		if (maxDepth < 1) return false;
		const starts = live.filter((nd) => nd.g <= upTo - 1).map((nd) => ({ snap: nd.snap, tick: nd.g, nd }));
		if (!starts.length) return false;
		const lt = Date.now();
		let r = null;
		try {
			r = X.exactLeg(L, starts, goalWp(j), { sim: exSim, maxDepth, cap: EXCAP, deadline: Math.min(exEnd, lt + (o.exMs > 0 ? o.exMs : 400)), collect: 64 });
		} catch (e) { r = null; }
		stats.ex++; stats.exMs += Date.now() - lt;
		if (!r || r.status !== 'found') return false;
		stats.exFound++;
		const bestBefore = best[j];
		let any = false;
		for (const gl of r.goals || []) {
			const s = starts[gl.start];
			if (!s || !gl.tail || gl.tail.length < 1) continue;
			const h = replayTo(s.nd.snap, gl.tail, j, w.finish ? 3 : 0);
			if (h <= 0) continue;
			const ms_ = new Uint8Array(h);
			for (let t = 0; t < h; t++) ms_[t] = t < gl.tail.length ? gl.tail[t] : (gl.tail[gl.tail.length - 1] & 30);
			stats.exGoals++;
			put(j, child(j, s.nd, ms_, j > k + 1 ? `exact skip ${j - k}` : 'exact', 'exact'));
			any = true;
		}
		if (best[j] < bestBefore) stats.exBest++;
		return any;
	};
	/** THE BRIDGE from a gain carrier nd at k to k + 1 (.. k + 3): (a) the route's own inputs SHIFTED (from the route's tick
	 *  at k + d: a carrier ahead in speed often meets the route's motion a few ticks off), (b) msolve's legs on a longer
	 *  clock, (c) the exact search from nd alone on spans of at most BR_SPAN route ticks; the first arrival is put */
	const brSim = BRIDGE ? new E.EESim(L) : null;
	const bridgeTo = (nd, k, xEnd) => {
		const j = k + 1, w = wps[j], span = w.t - wps[k].t;
		stats.bridge++;
		for (const d of BR_SHIFTS) {
			if (Date.now() >= xEnd) return false;
			const a = wps[k].t + d;
			if (a < 0 || a >= masks.length) continue;
			const seg = masks.subarray(a, Math.min(masks.length, a + span + 8));
			const h = replayTo(nd.snap, seg, j, 8);
			if (h <= 0) continue;
			const ms_ = new Uint8Array(h);
			for (let t = 0; t < h; t++) ms_[t] = t < seg.length ? seg[t] : (seg[seg.length - 1] & 30);
			put(j, child(j, nd, ms_, `bridge shift ${d}`, 'route'));
			stats.brShift++;
			return true;
		}
		for (let jj = j; jj <= Math.min(m, k + 3); jj++) {
			if (Date.now() >= xEnd) return false;
			if (wps[jj].fixed) break;
			if (wps[jj].tele) continue;
			if (legTo(nd, k, jj, xEnd, Math.max(20, xEnd - Date.now()))) { stats.brLeg++; return true; }
		}
		if (span > BR_SPAN || w.tele || w.finish || Date.now() >= xEnd) return false;
		const Tmax = Math.min(span + 6, Math.max(0, best[j] + DIV - nd.g));
		if (Tmax < 1) return false;
		let r = null;
		try { r = X.exactLeg(L, [{ snap: nd.snap, tick: 0 }], goalWp(j), { sim: brSim, maxDepth: Tmax, cap: BR_CAP, deadline: xEnd, allowDeath: false, beforeTick: -1, collect: 1 }); } catch (e) { r = null; }
		if (!r || r.status !== 'found' || !r.tail || !r.tail.length) return false;
		const h = replayTo(nd.snap, r.tail, j, 0);
		if (h <= 0) return false;
		put(j, child(j, nd, r.tail.slice(0, h), 'bridge exact', 'exact'));
		stats.brExact++;
		return true;
	};
	for (let k = 0; k < m; k++) {
		if (Date.now() > deadline || (stop && stop())) { timeUp = true; }
		// the frontier: the route's state first, then the earliest classes (F in all); once the clock is out, the route's
		// state and the earliest other one (its gain so far carried to the finish by the route's own inputs, else a leg)
		const all = Array.from(front[k].values()).sort((x, y) => (y.route - x.route) || x.g - y.g);
		if (typeof o.onWp === "function") o.onWp(k, all, wps);   // (a measurement hook: the frontier at waypoint k before its edges)
		const keep = timeUp ? all.filter((x, i) => x.route || i === all.findIndex((q) => !q.route)).slice(0, 2) : all.slice(0, F);
		stats.pruned += all.length - keep.length;
		stats.nodes += keep.length;
		const share = timeUp ? 0 : Math.max(5, (deadline - Date.now()) / Math.max(1, m - k));
		const wEnd = Date.now() + share;
		// FOLLOW: the route's own inputs to waypoint k + 1, from every kept state
		const followed = new Set();
		for (const nd of keep) {
			const j = k + 1;
			const seg = masks.subarray(wps[k].t, wps[j].t);
			if (nd.route) {
				put(j, { snap: rSnap[j], g: wps[j].t, hash: rHash[j], route: true, par: nd, ms: seg, how: 'follow', tool: 'route', k: j, key: 'route' });
				stats.follow++; followed.add(nd);
			} else if (nd.g + 1 <= best[j] + DIV) {
				const h = replayTo(nd.snap, seg, j, 8);
				if (h > 0) {
					const ms_ = new Uint8Array(h);
					for (let t = 0; t < h; t++) ms_[t] = t < seg.length ? seg[t] : (seg[seg.length - 1] & 30);
					put(j, child(j, nd, ms_, 'follow', 'route'));
					stats.follow++; followed.add(nd);
				}
				// SHIFTED FOLLOWS (a state ahead of the route is further along its path: the route's own inputs from s ticks
				// into the segment, s = 1 .. SHIFT; every arrival replayed): the tail rejoin that carries a gain to the next
				// waypoint where the plain follow of the whole segment overshoots or lands in another class
				for (let s = 1; s <= SHIFT && s < seg.length; s++) {
					const sg = seg.subarray(s);
					if (nd.g + 1 > best[j] + DIV) break;
					const h2 = replayTo(nd.snap, sg, j, 8);
					if (h2 <= 0) continue;
					const ms2 = new Uint8Array(h2);
					for (let t = 0; t < h2; t++) ms2[t] = t < sg.length ? sg[t] : (sg[sg.length - 1] & 30);
					stats.shift++;
					put(j, child(j, nd, ms2, `follow +${s}`, 'route'));
					followed.add(nd);
				}
			}
		}
		const live = keep.filter((nd) => { sim.restore(nd.snap); return !sim.is_dead; });
		if (timeUp) {
			// (the clock is out: a leg only for the earliest other state whose follow failed, on a short clock)
			for (const nd of live) if (!nd.route && !followed.has(nd) && !wps[k + 1].fixed && !wps[k + 1].tele) legTo(nd, k, k + 1, Date.now() + 40, 40);
		} else {
			// EXACT EDGES first (their own share of the waypoint's clock): the frontier's exact minimum to k + 1 .. k + EXM
			// (spans of at most EXSPAN route ticks; never across a fixed or teleport waypoint)
			if (useExact && live.length) {
				const exEnd = Math.min(wEnd, Date.now() + share * EXF);
				for (let j = k + 1; j <= Math.min(m, k + EXM); j++) {
					const w = wps[j];
					if (w.fixed || w.tele || (j > k + 1 && (wps[j - 1].fixed || wps[j - 1].tele))) break;
					if (w.t - wps[k].t > EXSPAN) break;
					if (Date.now() > exEnd) break;
					exactTo(live, k, j, exEnd);
				}
			}
			// LEGS from every kept state (the route's first, then the earliest) to k + 1 and the SKIPS to k + 2 .. k + M (never
			// across a fixed waypoint: a death / respawn is followed, not solved); per state all its targets: the skips are
			// where the chain gains (a first try that went over the targets first, then the states, gained less on the same clock)
			for (const nd of live) {
				if (Date.now() > wEnd) break;
				for (let j = k + 1; j <= Math.min(m, k + M); j++) {
					if (Date.now() > wEnd) break;
					const w = wps[j];
					if (j > k + 1 && wps[j - 1].fixed) break;
					if (w.fixed) break;
					if (w.tele) continue;
					if (j > k + 1 && w.t - wps[k].t > SPAN) break;
					legTo(nd, k, j, wEnd, LEG_MS);
				}
			}
			// THE DETOUR SKIPS (EEAT_JOINS_LOOP=1): the later waypoints near k's tile in k's trigger state, past the span
			// (not inside a detour a skip already crossed, and at most LOOP_SHARE of the pass's clock in all)
			if (LOOP && live.length && k >= loopReach && stats.loopMs < LOOP_SHARE * Math.max(1, deadline - t0)) {
				const tL0 = Date.now();
				const wk = wps[k], kx = wk.tile % W, ky = (wk.tile / W) | 0;
				const cand = [];
				for (let j = k + 1; j <= m; j++) {
					const w = wps[j];
					if (w.fixed) break;   // (never across a death / respawn)
					if (w.tele || w.finish || w.t - wk.t <= SPAN || w.prog !== wk.prog) continue;
					const jx = w.tile % W, jy = (w.tile / W) | 0;
					if (Math.max(Math.abs(jx - kx), Math.abs(jy - ky)) <= LOOP_R) cand.push(j);
				}
				cand.sort((a, b) => wps[b].t - wps[a].t);
				const lEnd = Math.max(wEnd, Date.now() + LOOP_MS * LOOP_J);
				for (const nd of live.slice(0, 2)) {
					for (const j of cand.slice(0, LOOP_J)) {
						if (Date.now() > lEnd) break;
						padPhase = !!L.hasTimeDoors;
						const ok = legTo(nd, k, j, lEnd, LOOP_MS, LOOP_FMS);
						padPhase = false;
						if (log) log(`loop k ${k} t ${wk.t} g ${nd.g} -> j ${j} t ${wps[j].t}: ${ok ? 'best ' + best[j] : 'none'}`);
						if (ok) { stats.loops++; if (j > loopReach) loopReach = j; break; }
					}
				}
				stats.loopMs += Date.now() - tL0;
			}
		}
		// THE BRIDGE: the gain in hand at k (the route's tick less the earliest arrival) that reaches k + 1 .. k + M less by
		// more than 2 ticks is carried by bridgeTo from the earliest carriers (a switch toggled on and off, a ladder, a portal:
		// what the plain leg solver does not model and the route's inputs from another state miss), BR_MS a carrier (at most
		// BR_MS past the pass's clock), so it survives the join instead of dying there
		if (BRIDGE && !wps[k + 1].fixed && !wps[k + 1].finish) {
			const gainK = wps[k].t - best[k];
			let gainDown = 0;
			for (let jj = k + 1; jj <= Math.min(m, k + M); jj++) gainDown = Math.max(gainDown, wps[jj].t - best[jj]);
			if (gainK > 0 && gainDown < gainK - 2) {
				const carriers = live.filter((nd) => !nd.route && nd.g < wps[k].t).sort((x, y) => x.g - y.g).slice(0, BR_NODES);
				for (const nd of carriers) if (bridgeTo(nd, k, Math.min(deadline + BR_MS, Date.now() + (timeUp ? BR_MS / 2 : BR_MS)))) break;
			}
		}
		// (the frontier of k is done: its snapshots are no longer needed (the parents keep their inputs))
		for (const nd of front[k].values()) nd.snap = null;
		if (log && (k % 50 === 0 || process.env.EEAT_JOINS_LOGALL === "1")) log(`wp ${k}/${m} t ${wps[k].t} best ${best[k]} front ${front[k].size} legs ${stats.legs} ok ${stats.legOk}`);
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
	const ev = fin ? C.evaluate(L, out, true) : null;
	let accepted = false;
	if (ev) {
		const v = C.judge(ev, ev0, o.maxDeaths === undefined ? Infinity : o.maxDeaths);
		if (v.accept && ev.runTicks < ev0.runTicks) accepted = true;
	}
	const skips = accepted ? chain.filter((x) => String(x.how).startsWith('leg skip')).length : 0;
	const legsUsed = accepted ? chain.filter((x) => String(x.how).startsWith('leg')).length : 0;
	return { ev: accepted ? ev : ev0, accepted, chainTicks: fin ? fin.g : -1, routeFinish: WP.finish, waypoints: m, stats, skips, legsUsed, timeUp, ms: Date.now() - t0 };
}

/**
 * PROOFS: the route cut at its own waypoints, each leg from its exact start state (the route's replay) against the
 * event-graph bound (src/math/lb.js certify: lb = the leg's ticks = PROVEN OPTIMAL from that state to that support) and,
 * where the start is plain, msolve's certified plain bound (THEOREM B + its certificate) through a solve of the leg (the
 * solver's answer at the certified bound, T <= the route's ticks: the route's leg is optimal when T equals them).
 * -> {legs [{from, to, ticks, lb, proven, provenBy, faster}], proven, provenTicks, asked, lbSum, faster (legs msolve does
 * in fewer ticks from the same state: a join the chain could not use)}
 */
function proveRoute(L, masks, o) {
	o = o || {};
	const WP = waypointsOf(L, masks, { gap: 0 });
	if (!WP) return null;
	const wps = WP.wps, m = wps.length - 1;
	const S = o.S || MS.createSolver(L, {});
	const MLB = require('../math/lb.js').createMathLB(L);
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const pEnd = Date.now() + (o.ms > 0 ? o.ms : 20000);
	const legs = [];
	let t = 0, proven = 0, provenTicks = 0, asked = 0, lbSum = 0, faster = 0;
	let xAsked = 0, fasterExact = 0, fasterExactTicks = 0;
	const useX = o.xprove === undefined ? XPROVE : !!o.xprove;
	const XSPAN = o.xSpan > 0 ? o.xSpan : 90, XCAP = o.xCap > 0 ? o.xCap : 100000, XMS = o.xMs > 0 ? o.xMs : 600;
	const xSim = new E.EESim(L);
	const xq = [];
	for (let j = 1; j <= m; j++) {
		const a = wps[j - 1].t, b = wps[j].t, w = wps[j];
		while (t < a) { E.applyMask(inp, masks[t]); sim.tick(inp); t++; }
		const lg = { from: a, to: b, ticks: b - a, lb: null, proven: false, provenBy: null, cls: w.cls, finish: !!w.finish };
		legs.push(lg);
		if (Date.now() > pEnd || sim.is_dead || w.cls === 'D' || w.tele || wps[j - 1].fixed) continue;
		const snap = sim.snapshot();
		const tiles = [w.tile];
		asked++;
		try {
			const r = MLB.certify(sim, { tiles, mode: !w.finish && w.cls === 'G' ? 'land' : 'touch' }, lg.ticks, { cap: 4000, ms: o.proveMs > 0 ? o.proveMs : 40 });
			if (r && r.lb !== null && r.lb !== undefined) {
				lg.lb = r.lb;
				if (r.proven && r.lb >= lg.ticks) { lg.proven = true; lg.provenBy = 'events'; }
			}
		} catch (e) { /* no bound */ }
		sim.restore(snap);
		if (!lg.proven && lg.ticks <= 120) {
			// the plain certificate: msolve's leg at most the route's ticks, its certified bound
			try {
				const r = S.leg(snap, { tiles, cls: w.finish ? 'any' : w.cls }, { Tmax: lg.ticks, chain: false, prove: false, fieldMs: 20, coupledTicks: 50000, nodes: 60000, deadline: Math.min(pEnd, Date.now() + 60) });
				if (r) {
					if (r.cert && r.lb > 0 && (lg.lb === null || r.lb > lg.lb)) lg.lb = r.lb;
					if (r.cert && r.lb >= lg.ticks) { lg.proven = true; lg.provenBy = 'plain'; }
					if (r.ok && r.T < lg.ticks) { lg.faster = r.T; faster++; }
				}
			} catch (e) { /* none */ }
			sim.restore(snap);
		}
		if (!lg.proven && useX && lg.ticks <= XSPAN) xq.push({ lg, snap, w });
		if (lg.proven) { proven++; provenTicks += lg.ticks; }
		if (Number.isFinite(lg.lb)) lbSum += lg.lb;
	}
	// phase 2, THE EXACT PROOFS (after every leg had the cheap certificates), the shortest legs first: every input sequence
	// from the leg's exact start state to depth ticks - 1 (exact.js exactLeg: the bound cut and the stateHash merge are
	// exact); no open state left = nothing reaches the support sooner from that state
	xq.sort((x, y) => x.lg.ticks - y.lg.ticks);
	for (const q of xq) {
		if (Date.now() > pEnd) break;
		const lg = q.lg;
		xAsked++;
		try {
			const r = X.exactLeg(L, [{ snap: q.snap, tick: 0 }], wpGoal(L, q.w), { sim: xSim, maxDepth: lg.ticks - 1, cap: XCAP, deadline: Math.min(pEnd, Date.now() + XMS), collect: 1 });
			if (r.status === 'proof') {
				if (Number.isFinite(lg.lb)) lbSum -= lg.lb;
				lg.proven = true; lg.provenBy = 'exact'; lg.lb = lg.ticks;
				proven++; provenTicks += lg.ticks; lbSum += lg.lb;
			} else if (r.status === 'found') { lg.fasterExact = r.depth; fasterExact++; fasterExactTicks += lg.ticks - r.depth; }
			else lg.xStatus = r.status;
		} catch (e) { lg.xStatus = 'error ' + e.message; }
	}
	const by = legs.reduce((a, g) => { if (g.proven) a[g.provenBy] = (a[g.provenBy] || 0) + 1; return a; }, {});
	return { legs, proven, provenTicks, asked, lbSum, faster, xAsked, fasterExact, fasterExactTicks, provenBy: by, waypoints: m };
}

/**
 * joinRoute(L, masks, o): passes of the DP (each on the route the last one made: new waypoints, new joins) while they gain
 * and the clock lasts; the gap waypoints (o.gap, default 24) in every other pass; then the proofs of the result's legs.
 */
function joinRoute(L, masks0, o) {
	o = o || {};
	const t0 = Date.now();
	const ms = o.ms > 0 ? o.ms : 60000, deadline = t0 + ms;
	const ev0 = C.evaluate(L, masks0, true);
	if (!ev0) return { masks: masks0, runTicks: -1, before: -1, saved: 0, why: 'the route does not finish' };
	const S = MS.createSolver(L, {});
	// (the blind key of this level and route: blindOf; o.blind given (null: none) wins)
	if (o.blind === undefined) {
		// (the route's coin counts at its finish: a colour whose lowest door / gate number it never reaches is blind too)
		const sm = new E.EESim(L), ip = new E.EEInput();
		sm.reset();
		for (let t = 0; t < ev0.ms.length && !sm.has_silver_crown; t++) { E.applyMask(ip, ev0.ms[t]); sm.tick(ip); }
		o = Object.assign({}, o, { blind: blindOf(L, ev0.deaths, { gold: sm.coins | 0, blue: sm.blue_coins | 0 }) });
	}
	const proveShare = o.prove === false ? 0 : Math.min(20000, Math.max(1500, 0.15 * ms));
	const dEnd = deadline - proveShare;
	let cur = ev0;
	const passes = [];
	const stats = { legs: 0, legOk: 0, cands: 0, arrivals: 0, follow: 0, skips: 0, nodes: 0, pruned: 0, legMs: 0, ex: 0, exFound: 0, exGoals: 0, exBest: 0, exMs: 0, shift: 0, bridge: 0, brShift: 0, brLeg: 0, brExact: 0, loops: 0, loopMs: 0, pads: 0 };
	let gainless = 0;
	for (let p = 0; p < (o.passes > 0 ? o.passes : 8) && Date.now() < dEnd - 500; p++) {
		// (the pass kinds in turn: tile-entry waypoints every 24 ticks, the supports alone, and with LONG (EEAT_JOINS_LONG=1 /
		// o.long) the sparse pass: every LSTRIDE-th support, legs by msolve's chain tier over up to 400 route ticks)
		const kinds = LONGJ || o.long ? 3 : 2;
		const kind = p % kinds;
		const gap = kind === 2 || o.gap === 0 ? 0 : (kind === 0 ? (o.gap > 0 ? o.gap : 24) : 0);
		const left = dEnd - Date.now();
		// (a pass gets the rest of the clock, but the first pass at most 2/3 of it (half with the long passes): a second pass on the new route)
		const pEnd = Date.now() + (p === 0 ? Math.max(1000, left * (kinds === 3 ? 0.5 : 2 / 3)) : (kinds === 3 && p === 1 ? left * 0.5 : left));
		const po = kind === 2 ? { gap: 0, stride: o.lStride > 1 ? o.lStride : 4, chain: true, span: o.lSpan > 0 ? o.lSpan : 400, M: o.lM > 0 ? o.lM : 3, legMs: o.lLegMs > 0 ? o.lLegMs : 500, exact: false } : { gap };
		const r = joinOnce(L, cur, Object.assign({}, o, po), pEnd, S);
		for (const k of Object.keys(stats)) stats[k] += (r.stats && r.stats[k]) || 0;
		passes.push({ pass: p, gap, kind: kind === 2 ? `stride ${po.stride}` : (gap ? `gap ${gap}` : `supports`), from: cur.runTicks, to: r.ev.runTicks, accepted: r.accepted, waypoints: r.waypoints, chainTicks: r.chainTicks, skips: r.skips, legsUsed: r.legsUsed, timeUp: r.timeUp, ms: r.ms });
		if (typeof o.log === 'function') o.log(`pass ${p} gap ${gap}: ${cur.runTicks} -> ${r.ev.runTicks} (${r.waypoints} waypoints, ${r.ms} ms${r.timeUp ? ', time up' : ''})`);
		if (r.accepted) { cur = r.ev; gainless = 0; } else if (++gainless >= kinds) break;
	}
	const pr = o.prove === false ? null : proveRoute(L, cur.ms, { S, ms: Math.max(1000, deadline - Date.now()), proveMs: o.proveMs, xprove: o.xprove, xSpan: o.xSpan, xCap: o.xCap, xMs: o.xMs });
	return {
		masks: cur.ms, runTicks: cur.runTicks, before: ev0.runTicks, saved: ev0.runTicks - cur.runTicks, accepted: cur !== ev0,
		passes, stats, blind: o.blind ? { gold: o.blind.gold, blue: o.blind.blue, cp: o.blind.cp } : null, legs: pr ? pr.legs : [], proven: pr ? pr.proven : 0, provenTicks: pr ? pr.provenTicks : 0, proveAsked: pr ? pr.asked : 0,
		lbSum: pr ? pr.lbSum : 0, fasterLegs: pr ? pr.faster : 0, waypoints: pr ? pr.waypoints : 0, provenRoute: false, ms: Date.now() - t0,
		xAsked: pr ? pr.xAsked : 0, fasterExact: pr ? pr.fasterExact : 0, fasterExactTicks: pr ? pr.fasterExactTicks : 0, provenBy: pr ? pr.provenBy : {},
	};
}

module.exports = { joinRoute, joinOnce, proveRoute, waypointsOf, progKey, classKey, blindOf };
