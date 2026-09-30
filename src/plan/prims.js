'use strict';
// THE MOTION PRIMITIVES (n4plan part 'primitives'): EXACT macro moves of the engine from real states, the navigation
// graph over them (src/plan/navgraph.js: an A* with the admissible bounds of src/plan/bounds.js) and a cache of the
// executor's derived legs. Every edge is the engine's own simulation from the node's exact state (src/eesim.js); the
// tables (src/plan/tables.js) only order candidates, never replace a simulation.
//
//   prims = await createPrims(L, {file, bounds, model, workers}) -> {support(sim) -> key | null, expand(arrival, o) ->
//           Edge[], route(starts, goal, budget, o) -> NavResult, routeAsync(...) -> Promise<NavResult> (a worker pool:
//           src/plan/primworker.js), learn(fromArrival, masks, toArrival), stats(), close()}
//   Edge {macro, masks (the edge's own inputs), ticks, to: Arrival (masks from the level start), event}
//   route o: {classDedup (default true; false: exact stateHash dedup only), step (the STEP family; default: with
//           classDedup false), family ('all' | 'step'), w (one weighted pass), quick (the greedy pass alone: the first
//           route found), bound (ticks: only routes faster), beforeTick, allowDeath, guide (false: no reach-field order)}
//   NavResult {ok, arrivals (T.pickDiverse of the goal nodes, each replayed from the level start by T.playTo), best
//           {masks, ticks} | null, lb (the bound at the best start), proven, expanded, sims, why ('found' | 'budget' |
//           'exhausted' | 'stopped'), closest {masks, tile, dist (the reach field's tiles there; GUIDE_FAR + the bound's
//           ticks where the field has no way), vx, vy}}
//
// THE MACRO FAMILY (<= 160 ticks, each stopping at its first EVENT: a landing, a change of a relevant feature, a
// teleport (|dpos| > 20 px in a tick), a death (dropped unless allowDeath), the goal test, the macro's end):
//   plain support (on the ground, gravity down, no effect): RUN(L|R, n), IDLE(n), JUMP(L|none|R, release, turn, second
//   press), WALKOFF(L|R, hold | release), STEP(m); any other node (air, fields, effects, other gravity): HOLD(m, n) and
//   STEP(m) over the probe-reduced masks (endgame.js probeMasks: masks whose unread axis provably does nothing give the
//   same state). With STEP every route is expressible (completeness).
// SUPPORT key (class dominance, the learned-edge cache): `${tile},${floor(px)},${round(vx * 16)},${ground},${jumps},
// ${features}`: a heuristic key (two states of one key may differ), so a search with it is not proven.
const os = require('os');
const E = require('../eesim.js');
const EG = require('../endgame.js');
const RF = require('../reach.js');
const T = require('./types.js');
const NG = require('./navgraph.js');

const MAXT = 160;
const RUN_N = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const IDLE_N = [1, 2, 4, 8, 16];
const REL = [Infinity, 2, 4, 8, 12, 16, 24];
const TURN = [4, 8, 16];
const JUMP2 = [4, 8, 12, 16];
const HOLD_N = [2, 6, 16];
const TELEPORT_PX = 20;
const DEATH_WAIT = 80;
const DEAD_WAIT_ALL = process.env.EEAT_PRIMS_DEADWAIT !== '0';   // (the WAIT edge through every dead tick; 0: a tick an edge, as before)
const GUIDE_K = 2;          // ticks per reach-field tile in the greedy passes' order
const GUIDE_FAR = 1e5;
// the closest approach by an unweighted nearness (the reach field's tiles) instead of the pass's weighted h (1, the
// default; EEAT_CLOSEST_NEAR=0: the weighted h as before, whose start always won a greedy pass: navgraph.js astar)
const CLOSEST_NEAR = process.env.EEAT_CLOSEST_NEAR !== '0';
const GREEDY_W = +process.env.EEAT_PRIMS_GREEDY_W || 0;   // OPT-IN (0 = off): a far leg's first pass's weight (100: the reach field's order almost alone)
const GREEDY_TILES = +process.env.EEAT_PRIMS_GREEDY_TILES || 24;   // a leg is far from this many reach-field tiles at every start

// ---------------------------------------------------------------- the macros: mask(k, sim) -> mask | -1 (end)
function mkMacros() {
	const plain = [];
	for (const d of [2, 4]) for (const n of RUN_N) plain.push({ name: `RUN(${d === 2 ? 'L' : 'R'},${n})`, fam: 'RUN', max: n, mask: (k) => (k < n ? d : -1) });
	for (const n of IDLE_N) plain.push({ name: `IDLE(${n})`, fam: 'IDLE', max: n, mask: (k) => (k < n ? 0 : -1) });
	plain.push({ name: 'JUMP(-)', fam: 'JUMP', max: MAXT, land: true, mask: (k) => (k === 0 ? 1 : 0) });
	for (const d of [2, 4]) {
		const o = d === 2 ? 4 : 2, dn = d === 2 ? 'L' : 'R';
		for (const r of REL) plain.push({ name: `JUMP(${dn},rel${r === Infinity ? '-' : r})`, fam: 'JUMP', max: MAXT, land: true, mask: (k) => (k === 0 ? 1 | d : k < r ? d : 0) });
		for (const t of TURN) plain.push({ name: `JUMP(${dn},turn${t})`, fam: 'JUMP', max: MAXT, land: true, mask: (k) => (k === 0 ? 1 | d : k < t ? d : o) });
		for (const hold of [true, false]) plain.push({ name: `WALKOFF(${dn},${hold ? 'hold' : 'rel'})`, fam: 'WALKOFF', max: MAXT, land: true, walk: true, mask: (k, sim, st) => {
			if (!st.air && !sim.on_ground && k > 0) st.air = true;
			if (!st.air) return k < 48 ? d : -1;
			return hold ? d : 0;
		} });
	}
	const multi = [];
	for (const d of [0, 2, 4]) for (const j2 of JUMP2) multi.push({ name: `JUMP2(${d === 0 ? '-' : d === 2 ? 'L' : 'R'},${j2})`, fam: 'JUMP2', max: MAXT, land: true, mask: (k) => (k === 0 || k === j2 ? 1 | d : d) });
	const hold = [];
	for (let m = 0; m < 32; m++) {
		if ((m & 6) === 6 || (m & 24) === 24) continue;   // left + right / up + down cancel: the same as neither
		for (const n of HOLD_N) hold.push({ name: `HOLD(${m},${n})`, fam: 'HOLD', m, max: n, mask: (k) => (k < n ? m : -1) });
		hold.push({ name: `HOLD(${m},land)`, fam: 'HOLD', m, max: MAXT, land: true, mask: () => m });
	}
	// chains: the macros that are prefixes of one another played once, an edge at every stop (RUN(d, n), IDLE(n),
	// HOLD(m, n) / until the landing): the same masks and events as the single macros, a third of the ticks
	const chains = { run: [], idle: null, hold: [] };
	for (const d of [2, 4]) chains.run.push({ name: `RUN(${d === 2 ? 'L' : 'R'}`, fam: 'RUN', max: RUN_N[RUN_N.length - 1], stops: new Set(RUN_N), mask: () => d });
	chains.idle = { name: 'IDLE(', fam: 'IDLE', max: IDLE_N[IDLE_N.length - 1], stops: new Set(IDLE_N), mask: () => 0 };
	for (let m = 0; m < 32; m++) {
		if ((m & 6) === 6 || (m & 24) === 24) continue;
		chains.hold.push({ name: `HOLD(${m}`, fam: 'HOLD', m, max: MAXT, land: true, stops: new Set(HOLD_N), mask: () => m });
	}
	return { plain, multi, hold, chains };
}
const MACROS = mkMacros();

// ---------------------------------------------------------------- features (the events' "relevant feature change")
/** a 32-bit signature of the discrete state the doors and physics read (without a model) */
function featSig(sim) {
	let h = 0x811c9dc5;
	const mix = (v) => { h ^= v | 0; h = Math.imul(h, 0x01000193); };
	mix(sim.coins); mix(sim.blue_coins); mix(sim._keysMask); mix(sim.team); mix(sim.flip_gravity); mix(sim.jump_boost); mix(sim.speed_boost);
	mix(sim.low_gravity ? 1 : 0); mix(sim.has_levitation ? 1 : 0); mix(sim.max_jumps); mix(sim.is_invulnerable ? 1 : 0); mix(sim.is_zombie ? 1 : 0);
	mix(sim.is_cursed ? 1 : 0); mix(sim.is_poisoned ? 1 : 0); mix(sim.has_crown ? 1 : 0); mix(sim._collide_crown ? 1 : 0); mix(sim.has_silver_crown ? 1 : 0);
	mix(sim.checkpoint.x); mix(sim.checkpoint.y);
	for (const [k, v] of sim._switches) if (v === true) mix(k + 7919);
	for (const [k, v] of sim._oswitches) if (v === true) mix(k + 104729);
	return h >>> 0;
}
const plainFx = (sim) => !sim.has_levitation && sim.flip_gravity === 0 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity && !sim.is_zombie;

// ---------------------------------------------------------------- createPrims
async function createPrims(L, o = {}) {
	if (!L && o.file) L = T.loadLevelFile(o.file);
	const W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput(), sim2 = new E.EESim(L);
	const model = o.model || null;
	const feats = model && model.feats ? model.feats.slice() : null;
	// (the features' getters, each key parsed once: fsig runs on every simulated tick, and T.featValue's string parsing
	// was 12.5% of a leg's time; model.keyOf = model.stateOf(s).key without the state object: the same key)
	const fget = feats ? feats.map((f) => T.featGetter(f)) : null;
	const fsig = fget ? (s) => { let h = 0x811c9dc5; for (let i = 0; i < fget.length; i++) { h ^= (fget[i](s) | 0); h = Math.imul(h, 0x01000193); } return h >>> 0; } : featSig;
	const featKey0 = model && model.keyOf ? (s) => model.keyOf(s) : model && model.stateOf ? (s) => model.stateOf(s).key : (s) => fsig(s).toString(36);
	// the parent's key for its children (an expansion's): a child with the parent's feature values, coin counts and
	// checkpoint has the parent's key (the key = the values, the taken coins' bitmaps and the checkpoint; within one edge a
	// coin is only ever taken, which raises its count, so equal counts = the same coins taken). keyOf was 12.9% of a coin
	// level's leg (Booty Return: the taken bitmaps over its coin tiles, hashed per child). EEAT_PRIMS_KEYCACHE=0: off.
	const KEYCACHE = process.env.EEAT_PRIMS_KEYCACHE !== '0' && fget !== null;
	let kc = null;   // {vals, coins, bcoins, cpx, cpy, key} of the parent being expanded, or null
	const KEYCHECK = process.env.EEAT_PRIMS_KEYCHECK === '1';   // (tests: every cached key checked against keyOf)
	let kcChecks = 0;
	// (every key string interned to a small number: the class keys carry the number, a bijection with the string, so the
	// same equalities; a class key's Map lookup hashes a short string instead of the feature values and coin hashes)
	const internMap = new Map();
	const intern = (k) => { let v = internMap.get(k); if (v === undefined) { v = internMap.size; internMap.set(k, v); } return v; };
	const kcOf = (s) => { const key = featKey0(s); return { vals: fget.map((g) => g(s)), coins: s.coins, bcoins: s.blue_coins, cpx: s.checkpoint.x, cpy: s.checkpoint.y, key, id: intern(key) }; };
	const featKey = !KEYCACHE ? (s) => intern(featKey0(s)) : (s) => {
		const c = kc;
		if (c !== null && c.coins === s.coins && c.bcoins === s.blue_coins && c.cpx === s.checkpoint.x && c.cpy === s.checkpoint.y) {
			let same = true;
			for (let i = 0; i < fget.length; i++) if (fget[i](s) !== c.vals[i]) { same = false; break; }
			if (same) {
				if (KEYCHECK) { const k0 = featKey0(s); if (k0 !== c.key) throw new Error(`prims key cache: ${c.key} vs ${k0}`); kcChecks++; }
				return c.id;
			}
		}
		return intern(featKey0(s));
	};
	let bounds = o.bounds || null;
	if (!bounds) { const BO = require('./bounds.js'); bounds = BO.createBounds(L, { model }); }
	let tables = null;
	if (o.tables !== false) { try { tables = require('./tables.js'); } catch (e) { tables = null; } }
	const learned = new Map();     // support key -> [{masks: Uint8Array, ticks}]
	const st = { expands: 0, edges: 0, sims: 0, ticks: 0, routes: 0, found: 0, proven: 0, learnHits: 0, learnTries: 0, macroUse: {}, ms: 0 };
	let pool = null;

	/** the support class key of a state, or null (a state in the air with |v| >= 0.5 outside fields, dead) */
	function support(s) {
		if (s.is_dead) return null;
		const onG = !!s.on_ground;
		if (!onG) {
			const inField = s.mox === 0 && s.moy === 0;   // dots, climbables, liquids (no gravity pull this tick)
			if (!(inField && Math.abs(s.speed_x) < 0.5 && Math.abs(s.speed_y) < 0.5) && !s.teleported) return null;
		}
		return `${T.tileOf(s, W, H)},${Math.floor(s.px)},${Math.floor(s.py)},${Math.round(s.speed_x * 16)},${Math.round(s.speed_y * 16)},${onG ? 1 : 0},${s.jump_count},${featKey(s)}`;
	}

	/** the class key of a state in the air (the class dominance of a search that is not proven anyway) */
	function airKey(s) {
		return `a${Math.floor(s.px / 2)},${Math.floor(s.py / 2)},${Math.round(s.speed_x * 4)},${Math.round(s.speed_y * 4)},${s.jump_count},${s.is_dead ? 1 : 0},${featKey(s)}`;
	}

	/**
	 * one edge: the macro from the state now in `s` (restored from `snap`) until its first event. Returns the edge record
	 * with the child's snapshot, or null when it moved nothing (the same state).
	 */
	let hopPre = null;
	/** n4u hop: the landing tick (buf[n - 1]) replayed from the pre-landing state with the jump bit: a child when it jumps */
	function hopChild(s, buf, n, name, fam, ctx, out) {
		if (!hopPre || (buf[n - 1] & 1) === 1) return;
		s.restore(hopPre);
		const m = buf[n - 1] | 1;
		E.applyMask(inp, m);
		s.tick(inp);
		st.ticks++;
		if (s.is_dead || !s.on_ground || s.jump_count === 0) return;
		const hash = s.stateHash();
		if (hash === ctx.parentHash) return;
		const goal = !!(ctx.goal && ctx.goal.test(s));
		const e = { macro: name + '+HOP', fam, edge: null, ticks: n, event: goal ? 'goal' : 'land', goal, dead: false, hash, snap: null, tile: T.tileOf(s, W, H),
			px: s.px, py: s.py, vx: s.speed_x, vy: s.speed_y, onGround: !!s.on_ground, jumps: s.jump_count, finished: !!s.has_silver_crown };
		if (ctx.onChild && !ctx.onChild(s, e)) return;
		const ed = buf.slice(0, n); ed[n - 1] = m;
		e.edge = ed;
		e.snap = s.snapshot();
		out.push(e);
	}
	function simEdge(s, snap, macro, ctx, buf0) {
		const buf = macro.max > buf0.length ? new Uint8Array(macro.max) : buf0;
		s.restore(snap);
		const h0 = ctx.parentHash;
		let onG = !!s.on_ground, sig = ctx.parentSig, px = s.px, py = s.py;
		const stt = {};
		let n = 0, event = 'end', goal = false;
		for (let k = 0; k < macro.max; k++) {
			const m = macro.mask(k, s, stt);
			if (m < 0) break;
			if (!onG && !macro.whole) hopPre = s.snapshot(hopPre);
			E.applyMask(inp, m);
			s.tick(inp);
			buf[n++] = m;
			// (the dead ball's WAIT plays on through its dead ticks to the respawn in ONE edge: before, every dead tick was a
			// node of its own (54 expansions a death), and a death step's search spent its budget there)
			if (s.is_dead && !macro.dead) { event = 'dead'; break; }
			if (ctx.goal && ctx.goal.test(s)) { event = 'goal'; goal = true; break; }
			if (macro.whole) continue;   // a learned leg plays whole (only a death or the goal ends it early)
			if (Math.abs(s.px - px) > TELEPORT_PX || Math.abs(s.py - py) > TELEPORT_PX) { event = 'portal'; break; }
			const g = fsig(s);
			if (g !== sig) { event = 'trigger'; break; }
			if (!onG && s.on_ground && (macro.land || k > 0)) { event = 'land'; break; }
			onG = !!s.on_ground; px = s.px; py = s.py;
		}
		st.ticks += n;
		if (n === 0) return null;
		if (event === 'land' && ctx.hops) {
			const keep = s.snapshot();
			hopChild(s, buf, n, macro.name, macro.fam, ctx, ctx.hops);
			s.restore(keep);
		}
		const hash = s.stateHash();
		if (hash === h0) return null;
		const e = { macro: macro.name, fam: macro.fam, edge: null, ticks: n, event, goal, dead: !!s.is_dead, hash, snap: null, tile: T.tileOf(s, W, H),
			px: s.px, py: s.py, vx: s.speed_x, vy: s.speed_y, onGround: !!s.on_ground, jumps: s.jump_count, finished: !!s.has_silver_crown };
		// the caller's look at the child while the sim holds it (its bound, its class; false: a duplicate, no snapshot)
		if (ctx.onChild && !ctx.onChild(s, e)) return null;
		e.edge = buf.slice(0, n);
		e.snap = s.snapshot();
		return e;
	}

	/** a chain: its mask held from the state in snap, an edge at each stop and at the first event (which ends it) */
	function simChain(s, snap, chain, ctx, buf, push) {
		s.restore(snap);
		const h0 = ctx.parentHash;
		let onG = !!s.on_ground, sig = ctx.parentSig, px = s.px, py = s.py;
		const emit = (n, event, goal) => {
			const hash = s.stateHash();
			if (hash === h0) return;
			const e = { macro: `${chain.name},${event === 'end' ? n : event})`, fam: chain.fam, edge: null, ticks: n, event, goal, dead: !!s.is_dead, hash, snap: null,
				tile: T.tileOf(s, W, H), px: s.px, py: s.py, vx: s.speed_x, vy: s.speed_y, onGround: !!s.on_ground, jumps: s.jump_count, finished: !!s.has_silver_crown };
			if (ctx.onChild && !ctx.onChild(s, e)) return;
			e.edge = buf.slice(0, n);
			e.snap = s.snapshot();
			push(e);
		};
		for (let k = 0, n = 0; k < chain.max; k++) {
			const m = chain.mask(k, s);
			if (!onG) hopPre = s.snapshot(hopPre);
			E.applyMask(inp, m);
			s.tick(inp);
			buf[n++] = m;
			st.ticks++;
			if (s.is_dead) { emit(n, 'dead', false); return; }
			if (ctx.goal && ctx.goal.test(s)) { emit(n, 'goal', true); return; }
			if (Math.abs(s.px - px) > TELEPORT_PX || Math.abs(s.py - py) > TELEPORT_PX) { emit(n, 'portal', false); return; }
			const g = fsig(s);
			if (g !== sig) { emit(n, 'trigger', false); return; }
			if (!onG && s.on_ground) { emit(n, 'land', false); const hh = []; hopChild(s, buf, n, chain.name + ',land', chain.fam, ctx, hh); for (const e of hh) push(e); return; }
			if (chain.stops.has(n) || n === chain.max) emit(n, 'end', false);
			onG = !!s.on_ground; px = s.px; py = s.py;
		}
	}

	/** the macros for the state in `s` (restored from snap): the family by its support, STEP last */
	function familyOf(s, snap, fo) {
		const list = [];
		if (s.is_dead) { list.push({ name: 'WAIT', fam: 'WAIT', max: DEATH_WAIT, dead: DEAD_WAIT_ALL, mask: (k, x) => (x.is_dead ? 0 : -1) }); return { list, steps: null }; }
		const ground = !!s.on_ground && s.flip_gravity === 0 && s.moy > 0 && s.mox === 0;
		const chains = [];
		if (ground && plainFx(s) && fo.family !== 'step') {
			for (const m of MACROS.plain) if (m.fam !== 'RUN' && m.fam !== 'IDLE') list.push(m);
			if (s.max_jumps > 1) for (const m of MACROS.multi) list.push(m);
			for (const c of MACROS.chains.run) chains.push(c);
			chains.push(MACROS.chains.idle);
		} else if (fo.family !== 'step') {
			const ms = EG.probeMasks(s, inp, snap);
			const allow = new Set(ms);
			for (const c of MACROS.chains.hold) if (allow.has(c.m)) chains.push(c);
		}
		// STEP: every probe-reduced mask for one tick (completeness)
		const steps = fo.step === false ? null : EG.probeMasks(s, inp, snap);
		return { list, steps, chains };
	}

	/** the children of a node (the navgraph's expand): learned edges first, the family, STEP */
	function expandNode(node, s, ctx, fo) {
		try {
			kc = null;
			s.restore(node.snap);
			if (KEYCACHE) kc = kcOf(s);   // (the parent's key for its children: featKey)
			return expandNode0(node, s, ctx, fo);
		} finally { kc = null; }
	}
	function expandNode0(node, s, ctx, fo) {
		st.expands++;
		const snap = node.snap;
		s.restore(snap);
		ctx.parentHash = node.hash;
		ctx.parentSig = fsig(s);
		const key = support(s);
		const buf = new Uint8Array(MAXT + 1);
		const out = [];
		const seen = new Set();
		const push = (e) => {
			if (!e || seen.has(e.hash)) return;
			seen.add(e.hash);
			out.push(e);
		};
		if (key !== null && learned.has(key)) {
			for (const le of learned.get(key)) {
				st.learnTries++;
				const e = simEdge(s, snap, { name: 'LEARNED', fam: 'LEARNED', whole: true, max: le.masks.length, mask: (k) => (k < le.masks.length ? le.masks[k] : -1) }, ctx, buf);
				if (e) { st.learnHits++; push(e); }
			}
		}
		s.restore(snap);
		const fam = familyOf(s, snap, fo);
		ctx.hops = [];
		for (const m of fam.list) { push(simEdge(s, snap, m, ctx, buf)); for (const e of ctx.hops) push(e); ctx.hops.length = 0; }
		if (fam.chains) for (const c of fam.chains) simChain(s, snap, c, ctx, buf, push);
		ctx.hops = null;
		if (fam.steps) for (const m of fam.steps) push(simEdge(s, snap, { name: `STEP(${m})`, fam: 'STEP', max: 1, mask: (k) => (k === 0 ? m : -1) }, ctx, buf));
		st.edges += out.length;
		for (const e of out) st.sims += e.ticks;
		return out;
	}

	// ---------------------------------------------------------------- expand(arrival): the edges from a real state
	function snapOf(a) {
		// an arrival's snapshot is valid for this level object and thread only: checked by its hash, else replayed
		if (a.snap) {
			try { sim.restore(a.snap); if (a.hash === undefined || sim.stateHash() === a.hash) return a.snap; } catch (e) { /* another level object */ }
		}
		const r = T.playTo(L, a.masks, { allowDeath: true });
		return r.sim.snapshot();
	}
	function expand(arrival, eo = {}) {
		const snap = snapOf(arrival);
		const node = { snap, hash: (sim.restore(snap), sim.stateHash()), tick: arrival.masks.length };
		const goal = eo.goal || null;
		const ctx = { goal };
		const kids = expandNode(node, sim, ctx, eo);
		return kids.map((e) => {
			sim.restore(e.snap);
			const masks = T.concat(arrival.masks, e.edge);
			return { macro: e.macro, masks: e.edge, ticks: e.ticks, event: e.event, to: T.arrivalOf(L, sim, masks, null) };
		});
	}

	// ---------------------------------------------------------------- route(starts, goal, budget, o)
	function route(starts, goal, budget = {}, ro = {}) {
		const t0 = Date.now();
		st.routes++;
		const fieldR = bounds.field(T.fieldTilesOf(goal), null, { touch: T.fieldTouchOf(goal) });
		const trophy = goal.kind === 'trophy';
		// (a dead ball of a death step 0: it respawns by itself; the killer's tile has no value on the field, and h
		// Infinity dropped every dying child: a death step was never found by the primitives)
		const deadOK = !!goal.allowDeath || !!ro.allowDeath;
		const h = (s) => { if (deadOK && s.is_dead) return 0; const v = bounds.at(fieldR, s); return v === Infinity ? Infinity : (trophy ? v + 1 : v); };
		const sts = [];
		for (const a of starts) {
			const snap = snapOf(a);
			if (!snap) continue;
			sts.push({ snap, masks: a.masks, tick: a.masks.length });
		}
		const ctx = { goal };
		const classDedup = ro.classDedup !== false;
		// the greedy passes' guide (ordering only, never a prune, never in a w = 1 pass): the reach field (RCH3, physics-
		// aware: rises, falls, fields) to the goal tiles, in tiles x GUIDE_K ticks
		let guide = null;
		if (ro.guide !== false && classDedup) {
			try {
				const gf = T.goalField(L, T.fieldTilesOf(goal), { deaths: false });
				guide = (s) => { if (deadOK && s.is_dead) return 0; const c = RF.costAt(gf, s); return c < 0 ? GUIDE_FAR : c * GUIDE_K; };
			} catch (e) { guide = null; }
		}
		// (the closest approach's measure, the same in every pass: the reach field's tiles where it has the state (guide / GUIDE_K),
		// else the admissible bound's ticks + GUIDE_FAR: a state the field reaches is nearer than one it does not)
		const nearOf = (x, h0) => { if (guide) { const g = guide(x); if (g < GUIDE_FAR) return g / GUIDE_K; } return GUIDE_FAR + (h0 === Infinity ? GUIDE_FAR : h0); };
		const fo = { family: ro.family || 'all', step: ro.step !== undefined ? !!ro.step : (ro.family === 'step' || ro.classDedup === false) };
		// anytime: weighted A* first (a route soon), then w = 1 bounded by the best so far (every prune by the admissible
		// bound: a node whose tick + h reaches the best cannot beat it). OPT-IN (EEAT_PRIMS_GREEDY_W=100): a FAR leg (the
		// reach field GREEDY_TILES or more from every start) takes a GREEDY pass first (w = GREEDY_W: the reach field's
		// order, a route soon), then w = 3 and 1. (lane 2, box 3, 10 s a leg, prims alone, the first legs of 8 failing
		// levels, all far: w 3 found 0, w 10 2, w 30 3, w 100 4 (Tutorial 2's checkpoint 234 tiles away, Bygone Tutorial, A
		// Dreary Day, Golden Nightingale); in the 60-s compile its first legs came but no level compiled, and I Wanna be the
		// Guy lost its progress (gain 15 -> 1 / 9 / 1, 3 runs; with it off 15 / 15): off by default)
		let far = false;
		if (guide && GREEDY_W > 0) {
			far = sts.length > 0;
			for (const x of sts) { sim.restore(x.snap); if (guide(sim) / GUIDE_K < GREEDY_TILES) { far = false; break; } }
		}
		const ws = ro.w > 0 ? [ro.w] : ro.quick ? [3] : (classDedup ? (far ? [GREEDY_W, 3, 1] : [3, 1.5, 1]) : [1]);
		const tEnd = Math.min(budget.deadline || Infinity, t0 + (budget.ms > 0 ? budget.ms : 1000));
		const goalsAll = [];
		let R = null, incumbent = ro.bound !== undefined ? ro.bound : Infinity, expanded = 0, sims = 0, nodes = 0, closestN = null, lbStart = Infinity, proven = false, whyLast = 'exhausted';
		for (let wi = 0; wi < ws.length; wi++) {
			const w = ws[wi];
			const left = tEnd - Date.now();
			if (left <= 5) { whyLast = 'budget'; break; }
			// the first (greediest) pass runs until it finds a route (or 85% of the budget); the others share the rest
			const share = wi === ws.length - 1 ? left : wi === 0 ? left * 0.85 : Math.max(20, left / (ws.length - wi));
			R = NG.astar({
				sim, starts: sts, h, isGoal: (s) => goal.test(s), budget: { ms: share, deadline: tEnd, stop: budget.stop, k: budget.k || 1 }, classDedup,
				allowDeath: !!goal.allowDeath || !!ro.allowDeath, beforeTick: ro.beforeTick !== undefined ? ro.beforeTick : goal.beforeTick,
				k: budget.k || 1, slack: ro.slack || 0, stepAll: fo.step && w === 1, bound: incumbent === Infinity ? undefined : incumbent, greedy: w > 1, near: CLOSEST_NEAR ? (x) => nearOf(x, h(x)) : null,
				expand: (n, s, best, cls) => {
					ctx.onChild = (x, c) => {
						st.macroUse[c.fam] = (st.macroUse[c.fam] || 0) + 1;
						const tick = n.tick + c.ticks;
						const had = best.get(c.hash);
						if (had !== undefined && had <= tick) return false;
						c.key = classDedup && !c.goal ? (support(x) || airKey(x)) : null;
						if (cls && c.key !== null) { const ck = cls.get(c.key); if (ck !== undefined && ck <= tick) return false; }
						c.h0 = c.goal ? 0 : h(x);
						if (CLOSEST_NEAR) c.near = c.goal ? 0 : nearOf(x, c.h0);
						c.h = c.goal ? 0 : (w > 1 && guide ? Math.max(c.h0, guide(x)) : c.h0) * w;
						return true;
					};
					const kids = expandNode(n, s, ctx, fo);
					ctx.onChild = null;
					return kids;
				},
			});
			expanded += R.expanded; sims += R.sims; nodes += R.nodes;
			if (R.lbStart < lbStart) lbStart = R.lbStart;
			if (R.closest && (!closestN || R.closest.near < closestN.near)) closestN = R.closest;
			for (const g of R.goals) { goalsAll.push(g); if (g.tick < incumbent) incumbent = g.tick; }
			whyLast = R.why;
			if (w === 1 && R.proven) proven = true;
			if (w === 1 && R.why === 'exhausted') { whyLast = goalsAll.length ? 'found' : 'exhausted'; if (goalsAll.length && !classDedup && fo.step) proven = true; break; }
			if (budget.stop && budget.stop()) { whyLast = 'stopped'; break; }
		}
		R = { goals: goalsAll.sort((a, b) => a.tick - b.tick), expanded, sims, nodes, closest: closestN, lbStart, why: whyLast, proven };
		// the arrivals: each goal node replayed from the level start (the goal test at its end, the same state)
		const arrivals = [];
		for (const gn of R.goals) {
			const masks = NG.masksOf(gn);
			const r = T.playTo(L, masks, { allowDeath: true });   // (a death in the prefix, before the leg: the replay goes on through it)
			if (!goal.test(r.sim) || r.sim.stateHash() !== gn.hash) continue;
			arrivals.push(T.arrivalOf(L, r.sim, masks, null));
		}
		const picked = T.pickDiverse(arrivals, budget.k || 4);
		const bestA = picked.length ? picked.reduce((a, b) => (a.tick <= b.tick ? a : b)) : null;
		let closest = null;
		if (R.closest) {
			const cm = NG.masksOf(R.closest);
			closest = { masks: cm, tile: R.closest.tile, dist: R.closest.near, vx: R.closest.vx, vy: R.closest.vy, tick: R.closest.tick };
		}
		const ms = Date.now() - t0;
		st.ms += ms;
		if (picked.length) st.found++;
		if (R.proven && picked.length) st.proven++;
		return { ok: picked.length > 0, arrivals: picked, best: bestA ? { masks: bestA.masks, ticks: bestA.tick } : null, lb: R.lbStart, proven: R.proven && picked.length > 0,
			expanded: R.expanded, sims: R.sims, why: picked.length ? 'found' : R.why, closest, ms, nodes: R.nodes };
	}

	// ---------------------------------------------------------------- learn: a derived leg as a cached candidate
	function learn(fromArrival, masks, toArrival) {
		const snap = snapOf(fromArrival);
		if (!snap) return false;
		sim.restore(snap);
		const key = support(sim);
		if (key === null) return false;
		const m = masks instanceof Uint8Array ? masks : T.masksOf(masks);
		const l = learned.get(key) || [];
		if (l.some((x) => x.masks.length === m.length && x.masks.every((v, i) => v === m[i]))) return true;
		l.push({ masks: Uint8Array.from(m), ticks: m.length, to: toArrival ? toArrival.hash : 0 });
		if (l.length > 8) l.shift();
		learned.set(key, l);
		return true;
	}

	// ---------------------------------------------------------------- the worker pool (routeAsync)
	function routeAsync(starts, goal, wp, budget = {}, ro = {}) {
		if (!o.file || !(o.workers > 0)) return Promise.resolve(route(starts, goal, budget, ro));
		if (!pool) pool = require('./primworker.js').createPool(o.file, o.workers);
		return pool.route(starts.map((a) => T.strOf(a.masks)), wp, { ms: budget.ms, deadline: budget.deadline, k: budget.k }, ro).then((r) => {
			if (!r) return route(starts, goal, budget, ro);
			r.arrivals = r.arrivals.map((s) => { const masks = T.masksOf(s); const p = T.playTo(L, masks, { allowDeath: true }); return T.arrivalOf(L, p.sim, masks, null); });
			if (r.best) r.best.masks = T.masksOf(r.best.masks);
			if (r.closest) r.closest.masks = T.masksOf(r.closest.masks);
			return r;
		});
	}

	return {
		L, bounds, support, expand, route, routeAsync, learn,
		stats: () => Object.assign({}, st, { learned: learned.size, tables: !!tables, keyChecks: kcChecks }),
		close: () => { if (pool) { pool.close(); pool = null; } },
	};
}

module.exports = { createPrims, featSig, MACROS, MAXT };
