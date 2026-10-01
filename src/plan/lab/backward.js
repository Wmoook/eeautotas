'use strict';
// src/plan/lab/backward.js - APPROACH A: BACKWARD REACHABILITY + MEET IN THE MIDDLE (n5-lab-backward, 2026-09-30).
//
// A LEG (a real engine state -> a target's tiles; the compiler's long trigger legs: hundreds of ticks through platforms,
// fields and run-ups) as DYNAMIC PROGRAMMING on the level instead of a forward search from the start:
//
//   1. THE MACRO MODEL. A CELL = (the discrete state (coins, keys, switches, team, effects), grounded, the centre's half
//      tile in x and in y, vx in 1 / VXQ px/tick, vy in 1 / VYQ px/tick). A MACRO MOVE from a state = one input mask (the
//      directions that act in its field: left / right under a vertical pull, up / down under a horizontal one, all nine
//      where no pull or a liquid; with and without the jump press on the first tick where a jump can fire) held until the
//      first EVENT: the centre moves to another half tile while grounded or inside a field, the ball lands or leaves the
//      ground (a landing also gives its HOP: the same masks with the jump on the landing tick), the centre's physics class
//      changes (a field entered or left), a teleport, AIR_STEP ticks in plain air (the air control: a new mask every
//      AIR_STEP ticks), MAXT ticks. A move that puts the centre in the target's tiles ends there. Every macro move is
//      played by the engine: its child is an exact state.
//   2. BACKWARD. The cells of a CORRIDOR (the gravity-blind walk distance from the target's tiles: every tile within the
//      start's distance x CORR_F + CORR_ADD) are SEEDED independently of the start (the start's discrete state placed at
//      rest on every standable half tile, settled by the engine) and CLOSED under the macro moves (each cell expanded once,
//      from its representative: the first exact state that made it). The Bellman equation D(c) = min over c's moves
//      (ticks + D(child)), D(target) = 0, solved by Dijkstra on the reversed edges: D = the model's time to go from every
//      cell of the corridor, SPEED INCLUDED (a cell at a run-up's speed has a small D where the same place at rest has a
//      large or no D: the arrival a long leg needs is part of the value, not a search's luck).
//   3. MEET. From the REAL start: A* over exact engine states with the same macro moves (every child replayed by the
//      engine from its parent's exact state; a cell keeps its P.keep earliest exact states, a state twice is one node),
//      h = D(the child's cell) (a cell the closure did not make: the nearest speed class of its place, else THE FALLBACK:
//      the reach field of the doors as they stand (src/reach.js, deaths off) at the top running speed x P.fw + P.fadd):
//      the forward exact states meet the backward values. The first child that touches the target ends it; its masks
//      are replayed from the start once more (a dead start plays its dead ticks first).
//   4. THE EXACT BASIN: a node whose time to go is at most P.finishH ticks asks the move solver's direct leg
//      (src/plan/msolve.js: the plain regime's per-axis closed forms and the field tier, i.e. the target's per-axis
//      backward sets evaluated) within P.finishShare of the meet's time: the macro cells too coarse for a last move.
//   The order of a call: THE QUICK MEET (the fallback order alone, P.quickF of the clock: most short legs need no
//   closure), the closure to P.closeF of the clock (target first: a bucket queue by the walk distance; P.perim: only
//   within that distance), the values, the meet with them, then THE REFINEMENT LADDER (an exhausted meet again with
//   the dedup cells halved and one state more a cell, P.ladder steps).
//
// The model is a relaxation of nothing and a restriction of everything (a cell merges states, the macro set is finite):
// D is an ORDER, not a bound; every leg returned is the engine's own replay. Opt-in lab code: nothing requires it.
//
// API
//   const B = createBackward(L, opts)
//   B.solve(start, target, o) -> {ok, masks, T, why, stats: {cells, seeds, edges, closeMs, dijMs, meetMs, dStart,
//                                  expanded, ...}}
//     start: an EESnapshot of L (or an EESim: its state is read); target: {tiles: number[] (centre tiles)}
//     o: DEF's keys (env EEAT_BW_*), ms (the whole call's clock), probe (masks of a known leg: the values along it),
//        trace, debugWalk, debugReplay (diagnostics)
const E = require('../../eesim.js');
const KN = require('../kin.js');
const RF = require('../../reach.js');
const TY = require('../types.js');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const PORTALS = new Set([242, 381]);
const TELEPORT_PX = 20;
const TD_BUCKET = 50;
const DEAD_T = 70;                             // a dead state's ticks to its respawn (the engine's 54 + a margin)
const KAPPA = 16 / 6.776552880470027;          // ticks a tile at the top running speed
const DIRS_V = [0, 2, 4], DIRS_H = [0, 8, 16], DIRS_ALL = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const ENV = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const DEF = {
	vxq: ENV('EEAT_BW_VXQ', 2), vyq: ENV('EEAT_BW_VYQ', 1), airStep: ENV('EEAT_BW_AIRSTEP', 6), maxT: ENV('EEAT_BW_MAXT', 48),
	corrF: ENV('EEAT_BW_CORRF', 1.5), corrAdd: ENV('EEAT_BW_CORRADD', 40), maxCells: ENV('EEAT_BW_MAXCELLS', 400000),
	w: ENV('EEAT_BW_W', 1.0), closeF: ENV('EEAT_BW_CLOSEF', 0.6), meetNodes: ENV('EEAT_BW_MEET', 400000), maxNodes: ENV('EEAT_BW_MAXNODES', 900000), keep: ENV('EEAT_BW_KEEP', 2), quick: ENV('EEAT_BW_QUICK', 50000), quickF: ENV('EEAT_BW_QUICKF', 0.3), reach: ENV('EEAT_BW_REACH', 1), perim: ENV('EEAT_BW_PERIM', 0), corrReach: ENV('EEAT_BW_CORRREACH', 1), relay: ENV('EEAT_BW_RELAY', 6), memo: ENV('EEAT_BW_MEMO', 2), variants: ENV('EEAT_BW_VARIANTS', 2), relayMin: ENV('EEAT_BW_RELAYMIN', 20), meetF: ENV('EEAT_BW_MEETF', 1), finish: ENV('EEAT_BW_FINISH', 1), ladder: ENV('EEAT_BW_LADDER', 3), finishShare: ENV('EEAT_BW_FINISHSHARE', 0.25), finishH: ENV('EEAT_BW_FINISHH', 100), finishEvery: ENV('EEAT_BW_FINISHEVERY', 8), finishMs: ENV('EEAT_BW_FINISHMS', 25), finishT: ENV('EEAT_BW_FINISHT', 120), fw: ENV('EEAT_BW_FW', 3), fadd: ENV('EEAT_BW_FADD', 200), ell: ENV('EEAT_BW_ELL', 0), sat: ENV('EEAT_BW_SAT', 0), hold: ENV('EEAT_BW_HOLD', 1), rot: ENV('EEAT_BW_ROT', 1), vpen: ENV('EEAT_BW_VPEN', 4), deadPen: ENV('EEAT_BW_DEADPEN', 0), satLazy: ENV('EEAT_BW_SATLAZY', 4), mix: ENV('EEAT_BW_MIX', 0), openWalk: ENV('EEAT_BW_OPENWALK', 0), deaths: ENV('EEAT_BW_DEATHS', 0), mixSat: ENV('EEAT_BW_MIXSAT', 4),
	resume: ENV('EEAT_BW_RESUME', 0),
};

// ------------------------------------------------------------------ a small binary heap (key, value pairs)
function makeHeap() {
	const K = [], V = [];
	const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= K[i]) break; [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p; } };
	const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < K.length && K[l] < K[m]) m = l; if (r < K.length && K[r] < K[m]) m = r; if (m === i) break; [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m; } };
	return {
		get size() { return K.length; },
		push(k, v) { K.push(k); V.push(v); up(K.length - 1); },
		topKey() { return K[0]; },
		pop() { const v = V[0]; const lk = K.pop(), lv = V.pop(); if (K.length) { K[0] = lk; V[0] = lv; down(0); } return v; },
	};
}

function createBackward(L, opts = {}) {
	const W = L.width, H = L.height, N = W * H;
	const flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	// ---------------------------------------------------------------- the tile classes
	KN.flagsOf(flags.length - 1);
	const gt = KN.gravTables();
	const nId = flags.length;
	// the physics class of a centre id: 0 plain air (default gravity, nothing else), else the id itself (a field, an
	// effect, a portal, a killer: its own class; two different ids never merge)
	const clsId = new Int32Array(nId);
	// the directions that act with that id as the current / delayed tile: 1 vertical pull (L / R), 2 horizontal (U / D), 3 both
	const dirKind = new Uint8Array(nId);
	for (let id = 0; id < nId; id++) {
		const f = flags[id] | 0;
		const plain = !(f & (F_LIQUID | F_CLIMB | F_BOOST)) && !DOTS.has(id) && !PORTALS.has(id) && !EFFECT_IDS.has(id) &&
			gt.morx[id] === 0 && gt.mory[id] === 2 && gt.mox[id] === 0 && gt.moy[id] === 2 && (gt.flags[id] & 4) === 0 &&
			!(L.gFlags && (L.gFlags[id] & 4) !== 0);
		clsId[id] = plain ? 0 : id;
		if (f & F_LIQUID) dirKind[id] = 3;
		else if (gt.moy[id] !== 0 && gt.mox[id] === 0) dirKind[id] = 1;
		else if (gt.mox[id] !== 0 && gt.moy[id] === 0) dirKind[id] = 2;
		else dirKind[id] = 3;
	}
	const idOf = (i) => (i >= 0 && i < nId ? i : 0);

	// the static solid map (doors as they stand in the state given: solidOf)
	function solidOf(s, clockOpen, doorsOpen) {
		const sol = new Uint8Array(N);
		for (let i = 0; i < N; i++) {
			const id = s.tiles[i], f = flags[id] | 0;
			if ((f & F_SOLID) === 0) continue;
			if (f & F_JUMPTHRU) sol[i] = 3;
			else if (f & (F_HALF | F_ROTHALF)) sol[i] = 4;
			else if (f & F_DOOR) sol[i] = (doorsOpen && id !== 50) || (clockOpen && (id === 156 || id === 157)) ? 0 : s.is_tile_solid_now(i % W, (i / W) | 0) ? 1 : 0;   // (clockOpen: time doors open: they open every 1000 ticks; doorsOpen: every door but the secret block 50, which never lets the ball through)
			else sol[i] = 1;
		}
		return sol;
	}
	const boxFree = (sol, x, y) => {
		if (x < 0 || y < 0 || x > W * 16 - 16 || y > H * 16 - 16) return false;
		const ox = (x | 0) >> 4, oy = (y | 0) >> 4;
		const cxE = ox + ((x + 16) > ox * 16 + 16 ? 2 : 1), cyE = oy + ((y + 16) > oy * 16 + 16 ? 2 : 1);
		for (let cy = oy; cy < cyE; cy++) for (let cx = ox; cx < cxE; cx++) { const q = sol[cy * W + cx]; if (q === 1 || q === 4) return false; }
		return true;
	};

	// ---------------------------------------------------------------- the discrete state (what the cells keep apart)
	const discIds = new Map();
	const DISC_FIX = (opts.resume !== undefined ? +opts.resume : DEF.resume) > 0;
	const swKeys = new WeakMap();                // a switch map (copy-on-write: its identity holds its content) -> its key
	const swKey = (m, owned) => {
		if (!m || m.size === 0) return '';
		let k = owned ? undefined : swKeys.get(m);          // a map the sim owns may still change in place: no memo
		if (k !== undefined) return k;
		const a = []; for (const [id, v] of m) if (v === true) a.push(id); a.sort((p, q) => p - q);
		k = a.join('.');
		if (!owned) swKeys.set(m, k);
		return k;
	};
	// (a memo of the last state's fields: the discrete state rarely changes along a leg, and the key's string was a fifth of a
	// meet's time)
	const DM = { ok: false, tb: 0, c: 0, b: 0, k: 0, sw: null, osw: null, t: 0, j: 0, mj: 0, jb: 0, sb: 0, fl: 0, fg: 0, d: 0 };
	// (THE DEATHS AS MOVES (P.deaths) on a level with death doors / gates: the death count is part of the discrete state)
	const DEATHK = !!(opts.deaths !== undefined ? +opts.deaths : DEF.deaths) && !!(L.hasDeathDoor || L.hasDeathGate);
	function discOf(s, noClock) {
		const tb = L.hasTimeDoors && !noClock ? Math.floor((s._ticks % 1000) / TD_BUCKET) : 0;
		const fl = (s.low_gravity ? 1 : 0) | (s.is_invulnerable ? 2 : 0) | (s.has_levitation ? 4 : 0) | (s.is_cursed ? 8 : 0) | (s.is_zombie ? 16 : 0) | (s.is_poisoned ? 32 : 0) | (s.is_on_fire ? 64 : 0) | (s.has_crown ? 128 : 0);
		const j = s.max_jumps > 1 ? s.jump_count : 0;
		const dth = DEATHK ? Math.min(s.deaths, 64) : 0;
		if (DM.ok && DM.dth === dth && !s._swOwned && !s._oswOwned && DM.tb === tb && DM.c === s.coins && DM.b === s.blue_coins && DM.k === s._keysMask && DM.sw === s._switches && DM.osw === s._oswitches && DM.t === s.team && DM.j === j && DM.mj === s.max_jumps && DM.jb === s.jump_boost && DM.sb === s.speed_boost && DM.fl === fl && DM.fg === s.flip_gravity) return DM.d;
		const sw = swKey(s._switches, s._swOwned), osw = swKey(s._oswitches, s._oswOwned);
		// (a level with time doors: the clock's phase in TD_BUCKET-tick buckets, so a ball that waits for a door is not its own earlier cell)
		// (DISC_FIX, with THE RESUMABLE CLOSURE: a noClock key without the clock's bucket, as its memo DM.tb says; before, a
		// noClock call (the meet's variants) memoized a key WITH the bucket under tb 0, and the next clocked state of bucket 0
		// took that id: on a time-door level the start's discrete id changed from call to call and no memo matched)
		const k = `${DISC_FIX ? (L.hasTimeDoors && !noClock ? tb : '') : (L.hasTimeDoors ? Math.floor((s._ticks % 1000) / TD_BUCKET) : '')},${s.coins},${s.blue_coins},${s._keysMask},${sw},${osw},${s.team},${s.max_jumps > 1 ? s.jump_count : 0},${s.max_jumps},${s.jump_boost},${s.speed_boost},${s.low_gravity ? 1 : 0},${s.is_invulnerable ? 1 : 0},${s.has_levitation ? 1 : 0},${s.flip_gravity},${s.is_cursed ? 1 : 0},${s.is_zombie ? 1 : 0},${s.is_poisoned ? 1 : 0},${s.is_on_fire ? 1 : 0},${s.has_crown ? 1 : 0}` + (DEATHK ? `,${dth}` : '');
		let d = discIds.get(k);
		if (d === undefined) { d = discIds.size; discIds.set(k, d); }
		if (!s._swOwned && !s._oswOwned) { DM.ok = true; DM.tb = tb; DM.c = s.coins; DM.b = s.blue_coins; DM.k = s._keysMask; DM.sw = s._switches; DM.osw = s._oswitches; DM.t = s.team; DM.j = j; DM.mj = s.max_jumps; DM.jb = s.jump_boost; DM.sb = s.speed_boost; DM.fl = fl; DM.fg = s.flip_gravity; DM.dth = dth; DM.d = d; }
		return d;
	}

	const dcIds = new Map(), dcD = [];     // the numeric keys' (discrete state, queue classes) ids, each id's discrete state
	const valMemo = new Map();             // the values of closed closures (P.memo newest), by target and discrete state
	const cutMemo = new Map();             // THE RESUMABLE CLOSURE (P.resume newest): closures a clock cut, to resume
	let MS_ = null;
	const msol = () => MS_ || (MS_ = opts.solver || require('../msolve.js').createSolver(L, {}));   // (opts.solver: a msolve solver of L to share)
	// the reach field to a target's tiles (deaths off: the meet never dies), the newest 6
	const rfCache = new Map();
	function rfOf(tiles, s) {
		const Lc = TY.levelNow(L, s);                  // the doors as they stand in the start state
		const key = TY.fgHash(Lc.fg) + '|' + Array.from(tiles).sort((a, b) => a - b).join(',');
		if (rfCache.has(key)) return rfCache.get(key);
		const f = RF.reachField(Lc, { goals: Array.from(tiles).map((t) => ({ tile: t, cost: 0 })), deaths: false });
		if (rfCache.size >= 6) rfCache.delete(rfCache.keys().next().value);
		rfCache.set(key, f);
		return f;
	}

	// ---------------------------------------------------------------- one solve
	function solve(start, target, o = {}) {
		const P = Object.assign({}, DEF, opts, o);
		const t0 = Date.now();
		const clock = P.ms || 10000;
		const closeEnd = t0 + clock * P.closeF;
		const tEnd = t0 + clock;
		const stats = { minH: Infinity, minHg: 0, finishCalls: 0, finishMs: 0, finishOk: 0, cells: 0, seeds: 0, edges: 0, targetEdges: 0, expanded: 0, closeMs: 0, dijMs: 0, meetMs: 0, dStart: null, meetExpanded: 0, capped: false };
		const snap0 = start instanceof E.EESnapshot ? start : start.snapshot();
		sim.restore(snap0);
		const tgt = new Uint8Array(N);
		for (const t of target.tiles) if (t >= 0 && t < N) tgt[t] = 1;
		// (a target with a class or a teleport (target.cls other than 'any', target.tele: the moves study's support targets,
		// src/plan/portfolio.js): its end is msolve's exact goal test too; px / py the position before the tick (a teleport))
		const gx = (target.cls && target.cls !== 'any') || target.tele ? msol().goal(target) : null;
		const inTgt = (s, px, py) => {
			let tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4;
			if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
			return tgt[ty * W + tx] === 1 && !s.is_dead && (gx === null || gx(s, px === undefined ? s.px : px, py === undefined ? s.py : py));
		};
		if (inTgt(sim)) return { ok: true, masks: new Uint8Array(0), T: 0, why: 'at the target', stats };
		const sol = solidOf(sim);
		const solC = L.hasTimeDoors ? solidOf(sim, true) : sol;     // (the corridor's: time doors open)
		let solW = solC;                                            // (the walk's: solC, or every door open (P.openWalk))

		// ------------------------------------------------------------ THE CORRIDOR: the gravity-blind walk from the target
		const wd = new Int32Array(N).fill(-1);
		// (the walk from a set of tiles: 8-way, no corner cut between two walls, portals both ways; into dist)
		let walkFrom = null, walkTarget = null;
		{
			// portals: a portal tile and its exits are neighbours both ways (a relaxation: the corridor only)
			const padj = new Map();
			if (L.portalSlot && L.portalsById) {
				const link = (a, b) => { let x = padj.get(a); if (!x) { x = []; padj.set(a, x); } x.push(b); };
				for (let i = 0; i < N; i++) {
					const s = L.portalSlot[i];
					if (s < 0 || L.pTarget[s] === L.pId[s]) continue;
					const ex = L.portalsById.get(L.pTarget[s]);
					if (!ex) continue;
					// (the exits' positions are in px: the exit cell's corner)
					for (let k = 0; k < ex.n; k++) { const e = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (e >= 0 && e < N) { link(i, e); link(e, i); } }
				}
			}
			walkFrom = (srcs, dist) => {
				const q = new Int32Array(N);
				let qh = 0, qt = 0;
				for (const t of srcs) if (t >= 0 && t < N && dist[t] < 0) { dist[t] = 0; q[qt++] = t; }
				while (qh < qt) {
					const t = q[qh++], x = t % W, y = (t / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const u = ny * W + nx;
						if (dist[u] >= 0) continue;
						const qq = solW[u];
						if (qq === 1 || qq === 4) continue;
						if (dx && dy) { const a = solW[y * W + nx], b = solW[ny * W + x]; if ((a === 1 || a === 4) && (b === 1 || b === 4)) continue; }
						dist[u] = dist[t] + 1; q[qt++] = u;
					}
					const pa = padj.get(t);
					if (pa) for (const u of pa) if (dist[u] < 0) { dist[u] = dist[t] + 1; q[qt++] = u; }
				}
				return dist;
			};
			walkTarget = () => {
				const q = new Int32Array(N);
				let qh = 0, qt = 0;
				for (const t of target.tiles) if (t >= 0 && t < N && wd[t] < 0) { wd[t] = 0; q[qt++] = t; }
				while (qh < qt) {
					const t = q[qh++], x = t % W, y = (t / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const u = ny * W + nx;
						if (wd[u] >= 0) continue;
						const qq = solW[u];
						if (qq === 1 || qq === 4) continue;
						// no corner cut between two walls
						if (dx && dy) { const a = solW[y * W + nx], b = solW[ny * W + x]; if ((a === 1 || a === 4) && (b === 1 || b === 4)) continue; }
						wd[u] = wd[t] + 1; q[qt++] = u;
					}
					const pa = padj.get(t);
					if (pa) for (const u of pa) if (wd[u] < 0) { wd[u] = wd[t] + 1; q[qt++] = u; }
				}
			};
			walkTarget();
		}
		const sTile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
		let dS = sTile >= 0 && sTile < N ? wd[sTile] : -1;
		// THE OPEN WALK (P.openWalk): the start outside the target's walk with the doors as they stand: the walk with every door open
		// (the leg takes a key, a switch, coins on its way: the corridor and the fallback a relaxation; the reach field keeps the
		// doors as they stood, its -1 an order behind them, no prune)
		if (dS < 0 && P.openWalk && sTile >= 0 && sTile < N) { solW = solidOf(sim, true, true); wd.fill(-1); walkTarget(); dS = wd[sTile]; stats.openWalk = dS >= 0 ? 1 : 0; }
		if (dS < 0) {
			if (o.debugWalk) {
				let n = 0; for (let t = 0; t < N; t++) if (wd[t] >= 0) n++;
				stats.walkTiles = n; stats.sTile = [sTile % W, (sTile / W) | 0]; stats.solS = sol[sTile];
				const sx = sTile % W, sy = (sTile / W) | 0, rows = [];
				for (let y = Math.max(0, sy - 10); y <= Math.min(H - 1, sy + 3); y++) {
					let r = '';
					for (let x = Math.max(0, sx - 6); x <= Math.min(W - 1, sx + 30); x++) { const t = y * W + x; r += t === sTile ? '@' : wd[t] >= 0 ? 'o' : sol[t] === 1 ? '#' : sol[t] === 3 ? '-' : sol[t] === 4 ? 'h' : '.'; }
					rows.push(r);
				}
				stats.map = rows;
			}
			return { ok: false, why: 'the start is not in the target\'s walk', stats };
		}
		let rfield = null;
		if (P.reach) { try { rfield = rfOf(target.tiles, sim); } catch (e) { rfield = null; } }
		stats.reach = rfield ? rfield.mode : null;
		// THE DEATH'S WAY (P.deaths): a death takes the ball to its respawn (the checkpoint touched last, else the next spawn)
		// with its dead ticks; the fallback of a state is the least of its own and the way to the nearest killer tile + the dead
		// ticks + the respawn's own (the respawn state: a synthetic death of the start at a killer tile, the target's reach field
		// with the doors as they stand after it); on a level with death doors / gates the fallback reads the reach field of the
		// state's own death count (its doors)
		let rKill = null, hResp = Infinity;
		const sim0Deaths = sim.deaths;
		const rfByDeaths = new Map();
		if (P.deaths && rfield) {
			try {
				const kt = [];
				for (let i = 0; i < N; i++) { const id = sim.tiles[i]; if (L.gFlags && (L.gFlags[id] & 4) !== 0 && sol[i] !== 1) kt.push(i); }
				// (a killer tile with no checkpoint in its 3 x 3: the synthetic death touches none)
				let ks = -1;
				for (const i of kt) { const x = i % W, y = (i / W) | 0; let cp = false; for (let dy = -1; dy <= 1 && !cp; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && sim.tiles[yy * W + xx] === 360) { cp = true; break; } } if (!cp) { ks = i; break; } }
				if (ks >= 0) {
					rKill = rfCache.get('kill|' + TY.fgHash(TY.levelNow(L, sim).fg)) || null;
					if (!rKill) { rKill = RF.reachField(TY.levelNow(L, sim), { goals: kt.map((t) => ({ tile: t, cost: 0 })), deaths: false }); rfCache.set('kill|' + TY.fgHash(TY.levelNow(L, sim).fg), rKill); }
					const px = 16 * (ks % W), py = 16 * ((ks / W) | 0), id0 = sim.tiles[ks];
					sim.px = px; sim.py = py; sim.prev_px = px; sim.prev_py = py; sim.speed_x = 0; sim.speed_y = 0; sim.modifier_x = 0; sim.modifier_y = 0;
					sim.on_ground = false; sim.jump_count = 0; sim.teleported = false; sim._pastx = px; sim._pasty = py; sim._ox = px; sim._oy = py; sim._last_portal_set = false;
					sim._q0 = id0; sim._q1 = id0; sim.current_tile = id0; sim._current = id0;
					for (let k = 0; k < 4 && !sim.is_dead; k++) { E.applyMask(inp, 0); sim.tick(inp); }
					if (sim.is_dead) {
						for (let k = 0; k < DEAD_T && sim.is_dead; k++) { E.applyMask(inp, 0); sim.tick(inp); }
						if (!sim.is_dead) { const fR = rfOf(target.tiles, sim); const cR = RF.costAt(fR, sim); if (cR >= 0) hResp = cR * KAPPA; stats.respawn = [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4, Math.round(hResp)]; }
					}
				}
			} catch (e) { rKill = null; }
			sim.restore(snap0);
			if (hResp === Infinity) rKill = null;
		}
		const lim = Math.ceil(dS * P.corrF + P.corrAdd);
		let inCorr = new Uint8Array(N);
		let corrTiles = 0;
		// THE PERIMETER (P.perim > 0): the closure only within that walk distance of the target (a backward region the closure
		// completes; the meet runs on the fallback order outside it and meets the values inside)
		const limC = P.perim > 0 ? Math.min(lim, P.perim) : lim;
		// THE PHYSICS CORRIDOR (P.corrReach, a physics-mode reach field): also within the reach field's band, the tile's cost
		// (at rest, falling) at most the start's x corrF + corrAdd: a maze of killers is a walk corridor of its whole area
		const cS = rfield ? RF.costAt(rfield, sim) : -1;   // (walk mode too: its walk closes the killers)
		const rLim = cS >= 0 ? cS * P.corrF + P.corrAdd : Infinity;
		const rOK = (t) => {
			if (!(P.corrReach && rLim < Infinity)) return true;
			const x = 16 * (t % W), y = 16 * ((t / W) | 0);
			let c = -1;
			for (const vy of [0, 4, -4]) { const q = RF.costAt(rfield, x, y, vy); if (q >= 0 && (c < 0 || q < c)) c = q; }
			return c >= 0 && c <= rLim;
		};
		// THE ELLIPSE (P.ell > 0): also on a walk between the start and the target, the walk from the start + the walk to the
		// target at most dS x P.ell + P.corrAdd (the disc of corrF around the target holds every tile as far from the target
		// as the start, the far side of the target too: on a long leg the closure's cells went there)
		const ws = P.ell > 0 ? walkFrom([sTile], new Int32Array(N).fill(-1)) : null;
		const limE = Math.ceil(dS * P.ell + P.corrAdd);
		for (let t = 0; t < N; t++) if (wd[t] >= 0 && wd[t] <= limC && (ws === null || (ws[t] >= 0 && ws[t] + wd[t] <= limE)) && rOK(t)) { inCorr[t] = 1; corrTiles++; }
		if (sTile >= 0 && sTile < N) inCorr[sTile] = 1;
		stats.corrTiles = corrTiles; stats.dStartTiles = dS;
		const tileOfS = (s) => {
			const tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4;
			return tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : ty * W + tx;
		};
		const hWalk = (t) => (t >= 0 && wd[t] >= 0 ? wd[t] * KAPPA : Infinity);
		// THE FALLBACK ORDER of a state no value covers: the reach field to the target (src/reach.js, deaths off: physics-aware,
		// a relaxation, in tiles) at the top running speed (P.reach; else the gravity-blind walk), x P.fw + P.fadd (a cell
		// with a value is preferred: the meet heads for the backward region)
		const hOwn = (s, t) => {
			let rf = rfield;
			if (DEATHK && rf && s.deaths !== sim0Deaths) {
				const dk = Math.min(s.deaths, 64);
				rf = rfByDeaths.get(dk);
				if (rf === undefined) { try { rf = rfOf(target.tiles, s); } catch (e) { rf = rfield; } rfByDeaths.set(dk, rf); }
			}
			if (rf) { const c = RF.costAt(rf, s); if (c >= 0) return c * KAPPA * P.fw + P.fadd; if (rf.mode === 'physics') return hWalk(t) * P.fw + P.fadd + 1000; }   // (-1: behind the doors as they stood at the start: an order, no prune)
			return hWalk(t) * P.fw + P.fadd;
		};
		const hFall = (s, t) => {
			const h = hOwn(s, t);
			if (rKill === null || s.is_dead) return h;
			const ck = RF.costAt(rKill, s);
			if (!(ck >= 0)) return h;
			const hd = (ck * KAPPA + DEAD_T + hResp) * P.fw + P.fadd;
			return hd < h ? hd : h;
		};

		// ------------------------------------------------------------ cells
		const VXQ = P.vxq, VYQ = P.vyq, AIR = P.airStep, MAXT = P.maxT;
		// THE KEYS AS NUMBERS (the same cells: one key per (discrete state, ground, half tile x, y, speed classes, the gravity
		// queue's classes), injective; a string where a part is out of the packing's range): the discrete state and the
		// queue's classes interned as one id dc (13 bits), then ground, x8, y8 (12 bits each), vx + 64 (7), vy + 128 (8): 53
		// bits; the place (the fallback's index: the key less the speeds and the classes) a number from the same parts. The
		// string keys were a quarter of a solve's time (template literals hashed at every lookup)
		const keyOf = (s) => {
			const d = discOf(s);
			const g = s.on_ground ? 1 : 0;
			const x8 = Math.floor((s.px + 8) / 8), y8 = Math.floor((s.py + 8) / 8);
			const vx = Math.round(s.speed_x * VXQ), vy = Math.round(s.speed_y * VYQ);
			// (the gravity queue's classes too: a field entered acts 2 ticks later, and a cell without them merged a ball that
			// just entered an arrow with its own parent, which the dedup then dropped: a 1-wide arrow shaft ended every search)
			const c0 = clsId[idOf(s._q0)], c1 = clsId[idOf(s._q1)];
			if (x8 >= 0 && x8 < 4096 && y8 >= 0 && y8 < 4096 && vx >= -64 && vx < 64 && vy >= -128 && vy < 128 && c0 < 8192 && c1 < 8192 && d < 67108864) {
				const ck = (d * 8192 + c0) * 8192 + c1;
				let dc = dcIds.get(ck);
				if (dc === undefined) { dc = dcD.length; dcIds.set(ck, dc); dcD.push(d); }
				if (dc < 8192) return (((dc * 2 + g) * 4096 + x8) * 4096 + y8) * 32768 + (vx + 64) * 256 + (vy + 128);
			}
			return `${d}|${g}|${x8}|${y8}|${vx}|${vy}|${c0}.${c1}`;
		};
		// the place key (no speeds, no classes): the fallback's index (a number wherever the place's parts fit)
		const placeOf = (key) => {
			let d, g, x8, y8;
			if (typeof key === 'number') {
				const hi = Math.floor(key / 32768);
				y8 = hi % 4096; const t1 = (hi - y8) / 4096; x8 = t1 % 4096; const t2 = (t1 - x8) / 4096; g = t2 % 2; d = dcD[(t2 - g) / 2];
			} else {
				const p = key.split('|');
				d = +p[0]; g = +p[1]; x8 = +p[2]; y8 = +p[3];
				if (!(x8 >= 0 && x8 < 4096 && y8 >= 0 && y8 < 4096 && d < 67108864)) return `${p[0]}|${p[1]}|${p[2]}|${p[3]}`;
			}
			return ((d * 2 + g) * 4096 + x8) * 4096 + y8;
		};
		// a key's speed classes [vx, vy]
		const speedsOf = (key) => {
			if (typeof key === 'number') { const lo = key % 32768; const vy = lo % 256; return [(lo - vy) / 256 - 64, vy - 128]; }
			const p = key.split('|'); return [+p[4], +p[5]];
		};
		let cellId = new Map();                  // key -> id
		let cellKey = [], cellSnap = [], cellTile = [];
		// (cellOpen: 1 = a cell whose moves the closure did not record in full: not expanded, a move out of the corridor, a
		// child the cap refused; dead (after the values): D Infinity and no open cell reachable from it in the closure's graph:
		// every recorded way from it stays among recorded cells and none meets the target)
		let cellOpen = [], dead = null;
		let revFrom = [], revTicks = [];         // reversed edges per child id: parents and ticks (flat arrays per cell)
		let toTarget = new Map();                // parent id -> least ticks to the target
		let byPlace = new Map();                 // place -> [ids]
		// THE CLOSURE'S ORDER: nearest the target first (the walk distance of the cell's tile: a bucket queue), so the values
		// grow backward from the target and a closure cut by its clock has the target's side, not a start-side generation
		let buckets = [];
		let bCur = 0, bLeft = 0;
		const qPush = (id, tile) => { const w = tile >= 0 && wd[tile] >= 0 ? wd[tile] : lim; let b = buckets[w]; if (!b) b = buckets[w] = []; b.push(id); bLeft++; if (w < bCur) bCur = w; };
		let bHead = [];
		const qPop =() => { while (bCur < buckets.length && (!buckets[bCur] || (bHead[bCur] | 0) >= buckets[bCur].length)) bCur++; if (bCur >= buckets.length) return -1; bLeft--; const h = bHead[bCur] | 0; bHead[bCur] = h + 1; return buckets[bCur][h]; };
		const addCell = (key, s, tile) => {
			let id = cellId.get(key);
			if (id !== undefined) return id;
			if (cellKey.length >= P.maxCells) { stats.capped = true; return -1; }
			id = cellKey.length;
			cellId.set(key, id); cellKey.push(key); cellSnap.push(s.snapshot()); cellTile.push(tile); cellOpen.push(1);
			revFrom.push(null); revTicks.push(null);
			const pl = placeOf(key);
			let a = byPlace.get(pl); if (!a) { a = []; byPlace.set(pl, a); } a.push(id);
			qPush(id, tile);
			return id;
		};
		const addEdge = (from, to, ticks) => {
			if (from === to) return;
			let a = revFrom[to];
			if (!a) { a = revFrom[to] = []; revTicks[to] = []; }
			a.push(from); revTicks[to].push(ticks);
			stats.edges++;
		};

		// ------------------------------------------------------------ the macro moves of a state (sim holds it)
		// (P.rot: the gravity effect turns the ball's gravity (eesim.js tick: flip_gravity 1 / 3 swap mox and moy of every tile
		// that rotates, 2 reverses them, 4 zeroes them), so the inputs that act turn with it: under a sideways gravity up / down
		// act, not left / right; without it (the base) a ball turned sideways had only the moves that do nothing)
		const kindOf = (id, rot) => {
			const k = dirKind[id];
			if (!P.rot || rot === 0 || rot === 2 || (L.gFlags && (L.gFlags[id] & 2) === 0)) return k;
			if (rot === 4) return 3;
			return k === 1 ? 2 : k === 2 ? 1 : k;
		};
		const dirsOf = (s) => {
			const rot = s.flip_gravity | 0;
			const k = kindOf(idOf(s.current_tile), rot) | kindOf(idOf(s._q0), rot) | kindOf(idOf(s._q1), rot);
			return k === 1 ? DIRS_V : k === 2 ? DIRS_H : DIRS_ALL;
		};
		const canJump = (s) => s.on_ground || (s.max_jumps > 1 && s.jump_count < s.max_jumps) || s.has_levitation;
		/**
		 * play the macro (mask m, the jump press on the first tick when p) from the snapshot; calls out(kind, ticks, masks)
		 * with sim at the event's state: kind 0 a child, 1 the target; the landing's hop too (kind 0, its own masks).
		 * masks: a shared buffer (valid until the next call); ticks = its length.
		 */
		const buf = new Uint8Array(MAXT + DEAD_T + 2);
		function play(snap, m, p, out) {
			sim.restore(snap);
			if (sim.is_dead) {
				// a DEAD state (a death on the route before this leg: its dead ticks): one move, no input to the respawn
				if (m !== 0 || p) return;
				for (let t = 0; t < DEAD_T; t++) {
					buf[t] = 0; E.applyMask(inp, 0); sim.tick(inp);
					if (!sim.is_dead) { if (inTgt(sim)) out(1, t + 1, buf); else out(0, t + 1, buf); return; }
				}
				return;
			}
			const c0 = clsId[idOf(sim.current_tile)];
			let g0 = sim.on_ground && sim.speed_y === 0 ? 1 : (sim.on_ground ? 1 : 0);
			const x80 = Math.floor((sim.px + 8) / 8), y80 = Math.floor((sim.py + 8) / 8);
			let air = 0;
			for (let t = 0; t < MAXT; t++) {
				const px = sim.px, py = sim.py;
				const mk = p === 2 || (t === 0 && p) ? (m | 1) : m;
				buf[t] = mk;
				E.applyMask(inp, mk); sim.tick(inp);
				if (sim.is_dead) {
					// THE DEATH AS A MOVE (P.deaths): the dead ticks played to the respawn (no input), its state the child (the earliest
					// arrival per cell survives the dedup: a death that pays is the first one there in its discrete state)
					if (!P.deaths) return;
					for (let k = 0; k < DEAD_T; k++) {
						buf[t + 1 + k] = 0; E.applyMask(inp, 0); sim.tick(inp);
						if (!sim.is_dead) { if (inTgt(sim)) out(1, t + 2 + k, buf); else out(0, t + 2 + k, buf); return; }
					}
					return;
				}
				if (inTgt(sim, px, py)) { out(1, t + 1, buf); return; }
				const tele = Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX;
				const g = sim.on_ground ? 1 : 0;
				const c = clsId[idOf(sim.current_tile)];
				const x8 = Math.floor((sim.px + 8) / 8), y8 = Math.floor((sim.py + 8) / 8);
				if (!g) air++;
				let ev = tele || c !== c0;
				if (!ev && g !== g0) ev = true;                                       // landed / left the ground
				if (!ev && (g || c !== 0) && (x8 !== x80 || y8 !== y80)) ev = true;   // a half tile on the ground / in a field
				if (!ev && !g && c === 0 && air >= AIR) ev = true;                    // the air control step
				if (!ev && t === MAXT - 1) ev = true;
				if (ev) {
					const landed = g && !g0;
					out(0, t + 1, buf);
					if (landed && m !== -1) {
						// THE HOP: the same masks with the jump on the landing tick
						const s1 = sim.snapshot();
						sim.restore(snap);
						let hpx = sim.px, hpy = sim.py;
						for (let q = 0; q <= t; q++) { const mm = q === t ? (buf[q] | 1) : buf[q]; hpx = sim.px; hpy = sim.py; E.applyMask(inp, mm); sim.tick(inp); if (sim.is_dead) break; }
						if (!sim.is_dead) {
							buf[t] |= 1;
							if (inTgt(sim, hpx, hpy)) out(1, t + 1, buf); else out(0, t + 1, buf);
							buf[t] &= ~1;
						}
						sim.restore(s1);
					}
					return;
				}
				g0 = g;
			}
		}
		const macrosOf = () => {
			const dirs = dirsOf(sim), j = canJump(sim);
			const out = [];
			for (const m of dirs) { out.push([m, 0]); if (j) out.push([m, 1]); }
			// THE HELD THRUST (P.hold): levitating, the jump HELD is the thrust (eesim.js: _spacedown with has_levitation sets
			// MAX_THRUST every tick; a press alone gives one tick of it, then the burn-off): the same masks with the jump on every
			// tick of the move (p 2); off levitation nothing changes
			if (P.hold && sim.has_levitation) for (const m of dirs) out.push([m, 2]);
			return out;
		};

		// ------------------------------------------------------------ THE CLOSURE (backward: seeded around the target)
		const tC0 = Date.now();
		const startKey = keyOf(sim);
		let startCell = addCell(startKey, sim, tileOfS(sim));
		// THE VARIANTS: the discrete states other than the start's that the quick meet reached (an effect, a key, a coin taken on
		// the way: the target's side may be reachable only with one; seeding the start's alone left Planets' blue coin, a long
		// rise with an effect, no value anywhere), the first state of each, the nearest P.variants seeded too
		const variants = new Map();
		sim.restore(snap0);
		const disc0 = discOf(sim, true);
		// (only: a tile mask, the seeds of those tiles alone (THE RESUMABLE CLOSURE's grown corridor); none: every corridor tile)
		const seedAll = (only) => {
			if (P.seeds === false) return;
			// (the seeds' base: the start, or a dead start's respawn: its discrete state after the death)
			let base = snap0;
			sim.restore(snap0);
			if (sim.is_dead) { for (let k = 0; k < DEAD_T && sim.is_dead; k++) { E.applyMask(inp, 0); sim.tick(inp); } base = sim.snapshot(); }
			// the start's discrete state (and the variants') at rest on every standable half tile of the corridor, nearest the target first
			const bases = [base];
			for (const v of Array.from(variants.values()).sort((a, b) => a.h - b.h).slice(0, P.variants)) bases.push(v.snap);
			stats.variants = bases.length - 1;
			const order = [];
			for (let t = 0; t < N; t++) if (only ? only[t] : inCorr[t]) order.push(t);
			order.sort((a, b) => wd[a] - wd[b]);
			for (const t of order) {
				const cx = t % W, cy = (t / W) | 0;
				if (cy + 1 >= H) continue;
				const f = sol[t + W];
				const inField = clsId[idOf(sim.tiles[t])] !== 0;
				if (!(f !== 0 || inField)) continue;                 // standable (a floor under), or a field tile (dots, liquids ...)
				for (const bs of bases) for (const px of [16 * cx - 4, 16 * cx + 4]) {
					const py = 16 * cy;
					if (!boxFree(sol, px, py)) continue;
					sim.restore(bs);
					sim.px = px; sim.py = py; sim.prev_px = px; sim.prev_py = py;
					sim.speed_x = 0; sim.speed_y = 0; sim.modifier_x = 0; sim.modifier_y = 0;
					sim.on_ground = false; sim.jump_count = 0; sim.teleported = false;
					sim._pastx = px; sim._pasty = py; sim._ox = px; sim._oy = py;
					sim._last_portal_set = false;
					const id0 = sim.tiles[t];
					sim._q0 = id0; sim._q1 = id0; sim.current_tile = id0; sim._current = id0;
					let ok = true;
					for (let k = 0; k < 2; k++) { E.applyMask(inp, 0); sim.tick(inp); if (sim.is_dead) { ok = false; break; } }
					if (!ok || inTgt(sim)) continue;
					const tl = tileOfS(sim);
					if (tl < 0 || !inCorr[tl]) continue;
					const id = addCell(keyOf(sim), sim, tl);
					if (id >= 0) stats.seeds++;
				}
			}
		};
		// the closure: every cell once (BFS order: the start and the seeds first)
		// (THE RESUMABLE CLOSURE, P.resume: border = the expanded cells with a child in the target's walk but outside the
		// corridor, with their snapshots: a later call whose corridor is wider expands them again)
		let border = new Map();
		const expand = (id) => {
			const snap = cellSnap[id];
			cellSnap[id] = null;                   // (expanded once: its state is no longer needed)
			sim.restore(snap);
			const ms = macrosOf();
			let out = false, esc = 0;
			for (const [m, p] of ms) {
				play(snap, m, p, (kind, ticks) => {
					if (kind === 1) {
						const q = toTarget.get(id);
						if (q === undefined || ticks < q) toTarget.set(id, ticks);
						stats.targetEdges++;
						return;
					}
					const tl = tileOfS(sim);
					if (tl < 0 || !inCorr[tl]) { esc = 1; if (P.resume && tl >= 0 && wd[tl] >= 0) out = true; return; }
					const k = keyOf(sim);
					const cid = addCell(k, sim, tl);
					if (cid >= 0) addEdge(id, cid, ticks); else esc = 1;
				});
			}
			if (out) border.set(id, snap);
			cellOpen[id] = esc;
		};
		const closure = (until) => {
			const tc = Date.now();
			while (bLeft > 0 && Date.now() < until) {
				const id = qPop();
				if (id < 0) break;
				expand(id);
				stats.expanded++;
			}
			stats.closed = bLeft === 0;
			stats.cells = cellKey.length;
			stats.closeMs += Date.now() - tc;
		};

		// ------------------------------------------------------------ BACKWARD: Dijkstra from the target on the reversed edges
		let D = new Float64Array(0);
		const dijkstra = () => {
			const tD0 = Date.now();
			const n = cellKey.length;
			D = new Float64Array(n).fill(Infinity);
			const h = makeHeap();
			for (const [id, tk] of toTarget) { if (tk < D[id]) { D[id] = tk; h.push(tk, id); } }
			while (h.size) {
				const d = h.topKey(), id = h.pop();
				if (d > D[id]) continue;
				const a = revFrom[id];
				if (!a) continue;
				const tk = revTicks[id];
				for (let k = 0; k < a.length; k++) {
					const p = a[k], nd = d + tk[k];
					if (nd < D[p]) { D[p] = nd; h.push(nd, p); }
				}
			}
			let finite = 0;
			for (let i = 0; i < n; i++) if (D[i] < Infinity) finite++;
			stats.finite = finite;
			// THE DEAD CELLS (P.deadPen > 0): back from every open cell over the reversed edges: what can reach an open cell may
			// escape; the rest of the cells without a value are the closure's dead ends
			if (P.deadPen > 0) {
				const may = new Uint8Array(n), q = new Int32Array(n);
				let qh = 0, qt = 0;
				for (let i = 0; i < n; i++) if (cellOpen[i]) { may[i] = 1; q[qt++] = i; }
				while (qh < qt) { const c = q[qh++]; const a = revFrom[c]; if (!a) continue; for (let k = 0; k < a.length; k++) { const p = a[k]; if (!may[p]) { may[p] = 1; q[qt++] = p; } } }
				dead = new Uint8Array(n);
				let nd = 0;
				for (let i = 0; i < n; i++) if (!(D[i] < Infinity) && !may[i]) { dead[i] = 1; nd++; }
				stats.dead = nd;
			}
			stats.dStart = D[startCell] < Infinity ? D[startCell] : null;
			stats.dijMs += Date.now() - tD0;
		};

		// the value of a state's cell: its own, else the nearest speed class of its place, else the walk
		const hOf = (key, tile, hf) => {
			if (D.length === 0) return hf;               // (no values yet: the quick meet)
			const id = cellId.get(key);
			if (id !== undefined && D[id] < Infinity) { stats.hCell = (stats.hCell | 0) + 1; return D[id]; }
			if (id !== undefined) {
				stats.hCellInf = (stats.hCellInf | 0) + 1;
				// (a dead cell: the fallback's order behind every live one)
				if (dead !== null && dead[id]) { stats.hDead = (stats.hDead | 0) + 1; return hf + P.deadPen; }
			}
			const a = byPlace.get(placeOf(key));
			if (a) {
				const [vx, vy] = speedsOf(key);
				let best = Infinity, bd = Infinity;
				for (const c of a) {
					if (!(D[c] < Infinity)) continue;
					const q = speedsOf(cellKey[c]), dd = Math.abs(q[0] - vx) / VXQ + Math.abs(q[1] - vy) / VYQ;
					if (dd < bd || (dd === bd && D[c] < best)) { bd = dd; best = D[c]; }
				}
				if (best < Infinity) { stats.hNear = (stats.hNear | 0) + 1; return best + bd * P.vpen; }
			}
			stats.hFall = (stats.hFall | 0) + 1;
			return hf;
		};

		// ------------------------------------------------------------ MEET: A* over exact states from the real start
		const tM0 = Date.now();
		let nodes = [];
		// the meet's own dedup key at resolution res (0: the value's cell; each step halves the position and speed classes and
		// keeps one state more a cell: THE REFINEMENT LADDER after an exhausted meet, for legs whose cells are too coarse)
		const mkeyOf = (s, res) => {
			if (res === 0) return keyOf(s);
			const q = 8 >> res, d = discOf(s);
			return `${d}|${s.on_ground ? 1 : 0}|${Math.floor((s.px + 8) / q)}|${Math.floor((s.py + 8) / q)}|${Math.round(s.speed_x * VXQ * (1 << res))}|${Math.round(s.speed_y * VYQ * (1 << res))}|${clsId[idOf(s._q0)]}.${clsId[idOf(s._q1)]}|r${res}`;
		};
		// (THE RELAY: a meet from a committed root: its snapshot and the masks from the start to it; lastBest: the expanded node
		// with the least time to go of the last meet, with its snapshot, the relay's next root)
		let lastBest = null, lastBests = [];
		// (o.closest, opt-in (n5-s99-budget, the stretch solver): the node of the least time to go over every meet of the call,
		// with its masks from the start, returned when no leg is found: the call's partial progress, a start for the next
		// rung of the compile's executor; off: the solve as before)
		let bestC = null;
		const pathTo = (id) => { const parts = []; for (let q = id; q >= 0 && nodes[q].masks; q = nodes[q].par) parts.push(nodes[q].masks); parts.reverse(); let n = 0; for (const a of parts) n += a.length; const m = new Uint8Array(n); let off = 0; for (const a of parts) { m.set(a, off); off += a.length; } return m; };
		const root0 = { snap: snap0, prefix: new Uint8Array(0), key: startKey };
		const meet = (cap, until, res = 0, root = root0) => {
			const keep = P.keep + res;
			lastBest = null; lastBests = [];
			const heap = makeHeap();
			nodes = [];                              // {snap, par, masks (Uint8Array of the move), g}
			const seenG = new Map();                   // cell key -> [g, ...] (the P.keep least)
			const seenH = new Set();                  // the exact states pushed (a state twice is one node)
			// THE SATURATION (P.sat > 0): a node's priority + P.sat x the expansions its tile has had (in this meet): a basin of
			// the order (the fallback's false near, a value's dead end) is spread over, not exhausted cell by cell, before the
			// way out that first leads away from the target is taken; lazy: a popped node whose tile's count rose by P.satLazy
			// is pushed again at its new priority
			const satN = P.sat > 0 || P.mix > 0 ? new Uint32Array(N) : null;
			// THE SECOND HEAD (P.mix > 0, P.sat 0): a second heap over the same nodes ordered with the tile saturation (P.mixSat a
			// tile's expansion), popped for the share P.mix of the expansions: the plain order where it leads, the saturated one out
			// of a basin of the plain order's (a node is expanded once, by whichever head pops it first)
			const heap2 = P.mix > 0 && !(P.sat > 0) ? makeHeap() : null;
			let mixAcc = 0;
			const push = (snap, par, masks, g, key, tile, hsh, hf, mkey) => {
				const a = seenG.get(mkey);
				if (a && a.length >= keep && a[a.length - 1] <= g) return;
				if (hsh !== undefined) { if (seenH.has(hsh)) return; seenH.add(hsh); }
				if (!a) seenG.set(mkey, [g]);
				else { let i = a.length; while (i > 0 && a[i - 1] > g) i--; a.splice(i, 0, g); if (a.length > keep) a.pop(); }
				const hv = hOf(key, tile, hf);
				if (!(hv < Infinity)) return;
				addNode(snap, par, masks, g, hsh, hv, hf, tile);
			};
			const addNode = (snap, par, masks, g, hsh, hv, hf, tile) => {
				const id = nodes.length;
				// (hr: the node's time to go in ticks: its value, else the fallback's own ticks without its weight)
				const nd0 = { snap, par, masks, g, hsh, h: hv === hf ? (hf - P.fadd) / P.fw : hv };
				nodes.push(nd0);
				if (heap2 !== null) { const tt = tile >= 0 ? tile : 0; nd0.st = tt; nd0.sc = satN[tt]; nd0.f0 = g + P.w * hv; heap.push(nd0.f0, id); heap2.push(nd0.f0 + P.mixSat * nd0.sc, id); }
				else if (satN !== null) { const tt = tile >= 0 ? tile : 0; nd0.st = tt; nd0.sc = satN[tt]; nd0.f0 = g + P.w * hv; heap.push(nd0.f0 + P.sat * nd0.sc, id); }
				else heap.push(g + P.w * hv, id);
			};
			// a child (sim holds it, its masks the first `ticks` of mbuf): push's tests in push's order, the snapshot, the state's
			// hash and the masks' copy taken only as far as they are needed (5 of 6 children are dropped by the dedup)
			const pushChild = (par, mbuf, ticks, g, key, tile, mkey) => {
				const a = seenG.get(mkey);
				if (a && a.length >= keep && a[a.length - 1] <= g) return;
				const hsh = sim.stateHash();
				if (seenH.has(hsh)) return;
				seenH.add(hsh);
				if (!a) seenG.set(mkey, [g]);
				else { let i = a.length; while (i > 0 && a[i - 1] > g) i--; a.splice(i, 0, g); if (a.length > keep) a.pop(); }
				const hf = hFall(sim, tile);
				const hv = hOf(key, tile, hf);
				if (!(hv < Infinity)) return;
				addNode(sim.snapshot(), par, Uint8Array.from(mbuf.subarray(0, ticks)), g, hsh, hv, hf, tile);
			};
			sim.restore(root.snap);
			push(root.snap, -1, null, 0, root === root0 ? startKey : keyOf(sim), tileOfS(sim), undefined, hFall(sim, tileOfS(sim)), mkeyOf(sim, res));
			let found = null, ex = 0, lastFinish = -Infinity;
			const tMeet0 = Date.now() - 50;
			while ((heap.size || (heap2 !== null && heap2.size)) && !found && Date.now() < until && ex < cap && nodes.length < P.maxNodes) {
				let id, nd;
				if (heap2 !== null) {
					// (the head of this pop: the second one for the share P.mix; an empty head gives its turn to the other)
					mixAcc += P.mix;
					let two = mixAcc >= 1;
					if (two) mixAcc -= 1;
					if (two && !heap2.size) two = false; else if (!two && !heap.size) two = true;
					id = two ? heap2.pop() : heap.pop();
					nd = nodes[id];
					if (nd.snap === null) continue;                 // (expanded by the other head)
					if (two) {
						const c = satN[nd.st];
						if (c >= nd.sc + P.satLazy) { nd.sc = c; heap2.push(nd.f0 + P.mixSat * c, id); continue; }
					}
					satN[nd.st]++;
				} else {
					id = heap.pop();
					nd = nodes[id];
				}
				if (heap2 === null && satN !== null) {
					const c = satN[nd.st];
					if (c >= nd.sc + P.satLazy) { nd.sc = c; heap.push(nd.f0 + P.sat * c, id); continue; }
					satN[nd.st] = c + 1;
				}
				ex++; stats.meetExpanded++;
				if (nd.h < stats.minH) { stats.minH = Math.round(nd.h); stats.minHg = nd.g; }
				if (id > 0 && (!lastBest || nd.h < lastBest.h)) lastBest = { id, h: nd.h, g: nd.g, snap: nd.snap };
				if (id > 0 && P.relay > 0 && (lastBests.length < 4 || nd.h < lastBests[lastBests.length - 1].h)) {
					sim.restore(nd.snap); const tl0 = tileOfS(sim);
					const j = lastBests.findIndex((b) => b.tile === tl0);
					if (j < 0 || nd.h < lastBests[j].h) {
						if (j >= 0) lastBests.splice(j, 1);
						lastBests.push({ id, h: nd.h, snap: nd.snap, tile: tl0 }); lastBests.sort((a, b) => a.h - b.h); if (lastBests.length > 4) lastBests.pop();
					}
				}
				if (o.trace) { sim.restore(nd.snap); o.trace('pop', nd.g, keyOf(sim), sim); }
				const snapE = nd.snap;
				nd.snap = null;
				// THE EXACT BASIN (P.finish): a node near the target by its value is asked for the move solver's direct leg
				// (src/plan/msolve.js: the plain regime's closed forms per axis, the field tier; the per-axis backward sets of the
				// target, evaluated) at most once per P.finishEvery expansions, P.finishMs each: a macro search whose cells are
				// too coarse for the last move meets the exact mathematics there
				if (P.finish && nd.h <= P.finishH && ex - lastFinish >= P.finishEvery && stats.finishMs <= P.finishShare * (Date.now() - tMeet0)) {
					lastFinish = ex;
					const tf = Date.now();
					let r = null;
					try { r = msol().leg(snapE, gx ? { tiles: Array.from(target.tiles), cls: target.cls || 'any', tele: !!target.tele, via: target.via } : { tiles: Array.from(target.tiles), cls: 'any' }, { Tmax: P.finishT, chain: false, prove: false, coupled: nd.h <= 40, fields: true, nodes: 40000, fieldMs: P.finishMs, coupledTicks: 30000, deadline: tf + P.finishMs, alts: 0 }); } catch (e) { r = null; }
					stats.finishCalls++; stats.finishMs += Date.now() - tf;
					if (r && r.ok && r.masks && r.masks.length) { found = { par: id, masks: Uint8Array.from(r.masks), g: nd.g + r.T, prefix: root.prefix }; stats.finishOk++; }
				}
				sim.restore(snapE);
				const ms = found ? [] : macrosOf();
				for (const [m, p] of ms) {
					play(snapE, m, p, (kind, ticks, masks) => {
						if (found && kind === 0) return;
						if (kind === 1) {
							const g = nd.g + ticks;
							if (!found || g < found.g) found = { par: id, masks: Uint8Array.from(masks.subarray(0, ticks)), g, prefix: root.prefix };
							return;
						}
						const tl = tileOfS(sim);
						if (o.trace) o.trace('child', nd.g + ticks, keyOf(sim), sim, m, p, ticks);
						const vk = keyOf(sim);
						if (P.variants > 0 && variants.size < 16 && !sim.is_dead) { const d = discOf(sim, true); if (d !== disc0 && !variants.has(d)) variants.set(d, { snap: sim.snapshot(), h: hFall(sim, tl) }); }
						pushChild(id, masks, ticks, nd.g + ticks, vk, tl, res === 0 ? vk : mkeyOf(sim, res));
					});
				}
			}
			if (o.trace) o.trace('meetEnd', nodes.length, ex, heap.size);
			stats.exhausted = !found && heap.size === 0 && (heap2 === null || heap2.size === 0);
			if (o.closest && !found && lastBest && (!bestC || lastBest.h < bestC.h)) {
				const pm = pathTo(lastBest.id), pre = root.prefix || new Uint8Array(0);
				const mm = new Uint8Array(pre.length + pm.length); mm.set(pre, 0); mm.set(pm, pre.length);
				bestC = { h: Math.round(lastBest.h), masks: mm };
			}
			stats.meetCapped = !found && (heap.size > 0 || (heap2 !== null && heap2.size > 0)) && (ex >= cap || nodes.length >= P.maxNodes);   // (stopped by its node caps, not its clock)
			// (the meets' log: [res, relay root 0 / 1, ms since the call's start, expansions, found, exhausted, capped, the least
			// time to go reached])
			let bt = null;
			if (o.debugBest && lastBest && lastBest.snap) { sim.restore(lastBest.snap); bt = [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4, +sim.speed_x.toFixed(2), +sim.speed_y.toFixed(2), lastBest.g]; }
			(stats.meets || (stats.meets = [])).push([res, root === root0 ? 0 : 1, Date.now() - t0, ex, found ? 1 : 0, stats.exhausted ? 1 : 0, stats.meetCapped ? 1 : 0, lastBest ? Math.round(lastBest.h) : null, bt]);
			return found;
		};
		// 1. THE QUICK MEET: the fallback order alone (a short leg needs no closure)
		let found = meet(P.quick, t0 + clock * P.quickF);
		stats.quick = !!found;
		if (!found && P.closeF > 0) {
			// 2. the closure, target first (the seeds made now); 3. the values; 4. the meet with them
			// (THE VALUES' MEMO: a later call to the same target from the same discrete state within the same corridor takes the
			// values a closed closure left: the compiler asks a stuck waypoint again from its anchors at every rung)
			const mKey = `${Array.from(target.tiles).sort((a, b) => a - b).join(',')}|${discOf(sim.restore(snap0) || sim)}`;
			const mm = P.memo ? valMemo.get(mKey) : null;
			// THE RESUMABLE CLOSURE (P.resume > 0, opt-in EEAT_BW_RESUME=<cut closures kept>; 0 = as before): a closure its clock
			// cut is kept (by the target, the start's discrete state and the cell grain) and the next call to the same target
			// resumes it where it stopped instead of building it again (the stretch child's 0.4 / 1.0 clocks, the one shot's far
			// legs 1 -> 2 -> 4 ... s): the closure's work adds up across calls. The new call's corridor joins the kept one
			// (union); where it grew, the kept cells with a child outside the old corridor are expanded again and the new tiles
			// seeded. The values are the same Bellman values over a bigger cell graph: an order, as before
			const rKey = P.resume > 0 ? `${mKey}|${target.cls || ''}|${target.tele ? 1 : 0}|${VXQ},${VYQ},${AIR},${MAXT},${P.corrF},${P.corrAdd},${P.perim},${P.corrReach},${P.maxCells},${P.variants},${P.seeds === false ? 0 : 1}` : null;
			const cm = rKey && !(mm && mm.lim >= lim && tileOfS(sim) >= 0 && mm.inCorr[tileOfS(sim)]) ? cutMemo.get(rKey) : null;			let limR = lim;
			if (mm && mm.lim >= lim && tileOfS(sim) >= 0 && mm.inCorr[tileOfS(sim)]) {
				cellId = mm.cellId; cellKey = mm.cellKey; byPlace = mm.byPlace; D = mm.D; dead = mm.dead || null;
				stats.memo = true; stats.cells = cellKey.length; stats.finite = mm.finite;
			} else {
				if (cm) {
					cutMemo.delete(rKey);
					cellId = cm.cellId; cellKey = cm.cellKey; cellSnap = cm.cellSnap; cellTile = cm.cellTile; revFrom = cm.revFrom; revTicks = cm.revTicks;
					toTarget = cm.toTarget; cellOpen = cm.cellOpen || cellOpen; byPlace = cm.byPlace; buckets = cm.buckets; bHead = cm.bHead; bCur = cm.bCur; bLeft = cm.bLeft; border = cm.border;
					const nIn = inCorr;
					inCorr = cm.inCorr;
					let grown = null, ng = 0;
					for (let t = 0; t < N; t++) if (nIn[t] && !inCorr[t]) { inCorr[t] = 1; (grown || (grown = new Uint8Array(N)))[t] = 1; ng++; }
					if (ng) {
						for (const [id, s] of border) { cellSnap[id] = s; qPush(id, cellTile[id]); }
						border = new Map();
						seedAll(grown);
					}
					sim.restore(snap0);
					startCell = addCell(startKey, sim, tileOfS(sim));
					limR = Math.max(cm.lim, lim);
					stats.resumed = cellKey.length; stats.grown = ng; stats.resumeN = cm.n + 1; stats.resumeLeft = bLeft;
				} else seedAll();
				closure(closeEnd);
				dijkstra();
				stats.tClose = Date.now() - t0;
				if (P.memo && stats.closed) {
					valMemo.set(mKey, { lim: limR, inCorr, cellId, cellKey, byPlace, D, dead, finite: stats.finite });
					while (valMemo.size > P.memo) valMemo.delete(valMemo.keys().next().value);
				} else if (rKey && !stats.closed) {
					cutMemo.set(rKey, { lim: limR, inCorr, cellId, cellKey, cellSnap, cellTile, revFrom, revTicks, toTarget, cellOpen, byPlace, buckets, bHead, bCur, bLeft, border, n: cm ? cm.n + 1 : 1 });
					while (cutMemo.size > P.resume) cutMemo.delete(cutMemo.keys().next().value);
				}
			}
			found = meet(P.meetNodes, t0 + clock * P.meetF);
		}
		// 5. THE REFINEMENT LADDER: an exhausted meet again with finer cells while the clock lasts
		for (let res = 1; !found && stats.exhausted && res <= P.ladder && Date.now() < tEnd - 20; res++) { stats.ladder = res; found = meet(P.meetNodes, tEnd, res); }
		// 6. THE RELAY (P.relay steps, only after a meet its node caps stopped: its clock is the leg's): no leg yet, commit to the last meet's node of the least time to go (its path from
		// the start kept) and meet again from it, while each step lowers the time to go by P.relayMin: a long leg as a chain
		// of meets (greedy: a committed root in a dead end ends it)
		const pathOf = (id) => { const parts = []; for (let q = id; q >= 0 && nodes[q].masks; q = nodes[q].par) parts.push(nodes[q].masks); parts.reverse(); let n = 0; for (const a of parts) n += a.length; const m = new Uint8Array(n); let off = 0; for (const a of parts) { m.set(a, off); off += a.length; } return m; };
		// (a best-first over committed roots: each meet's 4 best nodes of distinct tiles are candidates, the one of the least time
		// to go next, and a meet's candidates only when they are P.relayMin nearer than its root: a root in a dead end gives none,
		// the next best one is tried)
		const candsOf = (prefix, below) => lastBests.filter((c) => c.h < below - P.relayMin).map((c) => { const pm = pathOf(c.id); const pre = new Uint8Array(prefix.length + pm.length); pre.set(prefix); pre.set(pm, prefix.length); return { snap: c.snap, prefix: pre, h: c.h }; });
		const open = !found && stats.meetCapped ? candsOf(root0.prefix, Infinity) : [];
		for (let k = 0; !found && open.length && k < P.relay && Date.now() < tEnd - 50; k++) {
			open.sort((p, q) => p.h - q.h);
			const root = open.shift();
			stats.relay = k + 1; stats.relayH = Math.round(root.h); stats.relayG = root.prefix.length;
			const share = Math.max(200, (tEnd - Date.now()) / Math.max(1, Math.min(4, P.relay - k)));
			found = meet(P.meetNodes, Math.min(tEnd, Date.now() + share), 0, root);
			if (!found) for (const c of candsOf(root.prefix, root.h)) open.push(c);
		}
		stats.meetMs = Date.now() - tM0;
		if (o.probe) {
			// (a diagnostic: the values along a known leg's own states, every o.probeEvery ticks: [tick, D of its cell or
			// null, the fallback's h, the leg's ticks left])
			if (D.length === 0) dijkstra();
			const pm = o.probe, out = [];
			sim.restore(snap0);
			for (let t = 0; t <= pm.length; t++) {
				if (t % (o.probeEvery || 10) === 0 || t === pm.length) {
					const key = keyOf(sim), id = cellId.get(key);
					out.push([t, id !== undefined && D[id] < Infinity ? D[id] : null, Math.round(hOf(key, tileOfS(sim), hFall(sim, tileOfS(sim)))), pm.length - t, id !== undefined ? 1 : 0]);
				}
				if (t < pm.length) { E.applyMask(inp, pm[t]); sim.tick(inp); }
			}
			stats.probe = out;
		}
		stats.nodes = nodes.length;
		if (!found) return o.closest ? { ok: false, why: stats.exhausted ? 'exhausted' : 'budget', stats, closest: bestC } : { ok: false, why: stats.exhausted ? 'exhausted' : 'budget', stats };
		// the masks: the chain of moves, replayed from the start (the engine's own goal)
		const parts = [found.masks];
		for (let q = found.par; q >= 0 && nodes[q].masks; q = nodes[q].par) parts.push(nodes[q].masks);
		if (found.prefix && found.prefix.length) parts.push(found.prefix);
		parts.reverse();
		let T = 0; for (const a of parts) T += a.length;
		const masks = new Uint8Array(T);
		let off = 0; for (const a of parts) { masks.set(a, off); off += a.length; }
		sim.restore(snap0);
		let hit = 0;
		let alive = !sim.is_dead;   // (a dead start plays its dead ticks first)
		for (let t = 0; t < masks.length; t++) { const px = sim.px, py = sim.py; E.applyMask(inp, masks[t]); sim.tick(inp); if (sim.is_dead) { if (alive && !P.deaths) break; continue; } alive = true; if (inTgt(sim, px, py)) { hit = t + 1; break; } }
		if (!hit) {
			if (o.debugReplay) {
				// the first move whose replay leaves the chain's own states
				const chain = []; for (let q = found.par; q >= 0; q = nodes[q].par) chain.push(q); chain.reverse();
				sim.restore(snap0); let tt = 0; const rep = [];
				if (found.prefix) { for (const mk of found.prefix) { E.applyMask(inp, mk); sim.tick(inp); tt++; } rep.push(['prefix', tt]); }
				for (const q of chain) { const nd = nodes[q]; if (nd.masks) { for (const mk of nd.masks) { E.applyMask(inp, mk); sim.tick(inp); tt++; } } rep.push([q, tt, nd.g, nd.hsh === undefined ? 'root' : nd.hsh === sim.stateHash() ? 'same' : 'DIFF', sim.is_dead ? 'dead' : '']); }
				stats.replay = rep;
			}
			return { ok: false, why: 'the replay missed (a bug)', stats };
		}
		return { ok: true, masks: masks.subarray(0, hit), T: hit, why: '', stats };
	}

	return { solve, L };
}

module.exports = { createBackward, DEF };
