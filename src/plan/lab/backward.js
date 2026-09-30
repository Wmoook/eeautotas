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
//      engine from its parent's exact state), h = D(the child's cell) (a cell the closure did not make: the nearest speed
//      class of its place, else the walk distance at the top running speed): the forward exact states meet the backward
//      values. The first child that touches the target ends it; its masks are replayed from the start once more.
//
// The model is a relaxation of nothing and a restriction of everything (a cell merges states, the macro set is finite):
// D is an ORDER, not a bound; every leg returned is the engine's own replay. Opt-in lab code: nothing requires it.
//
// API
//   const B = createBackward(L, opts)
//   B.solve(start, target, o) -> {ok, masks, T, why, stats: {cells, seeds, edges, closeMs, dijMs, meetMs, dStart,
//                                  expanded, ...}}
//     start: an EESnapshot of L (or an EESim: its state is read); target: {tiles: number[] (centre tiles)}
//     o: {ms (the whole call's clock), closeMs (the closure's share), maxCells, w (the A*'s weight on D), seeds (true),
//         corrF, corrAdd, vxq, vyq, airStep, maxT, meetNodes}
const E = require('../../eesim.js');
const KN = require('../kin.js');
const RF = require('../../reach.js');
const TY = require('../types.js');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const PORTALS = new Set([242, 381]);
const TELEPORT_PX = 20;
const KAPPA = 16 / 6.776552880470027;          // ticks a tile at the top running speed
const DIRS_V = [0, 2, 4], DIRS_H = [0, 8, 16], DIRS_ALL = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const ENV = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const DEF = {
	vxq: ENV('EEAT_BW_VXQ', 2), vyq: ENV('EEAT_BW_VYQ', 1), airStep: ENV('EEAT_BW_AIRSTEP', 6), maxT: ENV('EEAT_BW_MAXT', 48),
	corrF: ENV('EEAT_BW_CORRF', 1.5), corrAdd: ENV('EEAT_BW_CORRADD', 40), maxCells: ENV('EEAT_BW_MAXCELLS', 400000),
	w: ENV('EEAT_BW_W', 1.0), closeF: ENV('EEAT_BW_CLOSEF', 0.6), meetNodes: ENV('EEAT_BW_MEET', 200000), keep: ENV('EEAT_BW_KEEP', 2), quick: ENV('EEAT_BW_QUICK', 3000), quickF: ENV('EEAT_BW_QUICKF', 0.05), reach: ENV('EEAT_BW_REACH', 1), fw: ENV('EEAT_BW_FW', 3), fadd: ENV('EEAT_BW_FADD', 200),
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
	function solidOf(s) {
		const sol = new Uint8Array(N);
		for (let i = 0; i < N; i++) {
			const id = s.tiles[i], f = flags[id] | 0;
			if ((f & F_SOLID) === 0) continue;
			if (f & F_JUMPTHRU) sol[i] = 3;
			else if (f & (F_HALF | F_ROTHALF)) sol[i] = 4;
			else if (f & F_DOOR) sol[i] = s.is_tile_solid_now(i % W, (i / W) | 0) ? 1 : 0;
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
	function discOf(s) {
		const sw = swKey(s._switches, s._swOwned), osw = swKey(s._oswitches, s._oswOwned);
		const k = `${s.coins},${s.blue_coins},${s._keysMask},${sw},${osw},${s.team},${s.max_jumps > 1 ? s.jump_count : 0},${s.max_jumps},${s.jump_boost},${s.speed_boost},${s.low_gravity ? 1 : 0},${s.is_invulnerable ? 1 : 0},${s.has_levitation ? 1 : 0},${s.flip_gravity},${s.is_cursed ? 1 : 0},${s.is_zombie ? 1 : 0},${s.is_poisoned ? 1 : 0},${s.is_on_fire ? 1 : 0},${s.has_crown ? 1 : 0}`;
		let d = discIds.get(k);
		if (d === undefined) { d = discIds.size; discIds.set(k, d); }
		return d;
	}

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
		const stats = { cells: 0, seeds: 0, edges: 0, targetEdges: 0, expanded: 0, closeMs: 0, dijMs: 0, meetMs: 0, dStart: null, meetExpanded: 0, capped: false };
		const snap0 = start instanceof E.EESnapshot ? start : start.snapshot();
		sim.restore(snap0);
		const tgt = new Uint8Array(N);
		for (const t of target.tiles) if (t >= 0 && t < N) tgt[t] = 1;
		const inTgt = (s) => {
			let tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4;
			if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
			return tgt[ty * W + tx] === 1 && !s.is_dead;
		};
		if (inTgt(sim)) return { ok: true, masks: new Uint8Array(0), T: 0, why: 'at the target', stats };
		const sol = solidOf(sim);

		// ------------------------------------------------------------ THE CORRIDOR: the gravity-blind walk from the target
		const wd = new Int32Array(N).fill(-1);
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
					const qq = sol[u];
					if (qq === 1 || qq === 4) continue;
					// no corner cut between two walls
					if (dx && dy) { const a = sol[y * W + nx], b = sol[ny * W + x]; if ((a === 1 || a === 4) && (b === 1 || b === 4)) continue; }
					wd[u] = wd[t] + 1; q[qt++] = u;
				}
				const pa = padj.get(t);
				if (pa) for (const u of pa) if (wd[u] < 0) { wd[u] = wd[t] + 1; q[qt++] = u; }
			}
		}
		const sTile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
		const dS = sTile >= 0 && sTile < N ? wd[sTile] : -1;
		if (dS < 0) return { ok: false, why: 'the start is not in the target\'s walk', stats };
		const lim = Math.ceil(dS * P.corrF + P.corrAdd);
		const inCorr = new Uint8Array(N);
		let corrTiles = 0;
		for (let t = 0; t < N; t++) if (wd[t] >= 0 && wd[t] <= lim) { inCorr[t] = 1; corrTiles++; }
		stats.corrTiles = corrTiles; stats.dStartTiles = dS;
		const tileOfS = (s) => {
			const tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4;
			return tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : ty * W + tx;
		};
		const hWalk = (t) => (t >= 0 && wd[t] >= 0 ? wd[t] * KAPPA : Infinity);
		// THE FALLBACK ORDER of a state no value covers: the reach field to the target (src/reach.js, deaths off: physics-aware,
		// a relaxation, in tiles) at the top running speed (P.reach; else the gravity-blind walk), x P.fw + P.fadd (a cell
		// with a value is preferred: the meet heads for the backward region)
		let rfield = null;
		if (P.reach) { try { rfield = rfOf(target.tiles, sim); } catch (e) { rfield = null; } }
		stats.reach = rfield ? rfield.mode : null;
		const hFall = (s, t) => {
			if (rfield) { const c = RF.costAt(rfield, s); if (c >= 0) return c * KAPPA * P.fw + P.fadd; if (rfield.mode === 'physics') return hWalk(t) * P.fw + P.fadd + 1000; }   // (-1: behind the doors as they stood at the start: an order, no prune)
			return hWalk(t) * P.fw + P.fadd;
		};

		// ------------------------------------------------------------ cells
		const VXQ = P.vxq, VYQ = P.vyq, AIR = P.airStep, MAXT = P.maxT;
		const keyOf = (s) => {
			const d = discOf(s);
			const x8 = Math.floor((s.px + 8) / 8), y8 = Math.floor((s.py + 8) / 8);
			// (the gravity queue's classes too: a field entered acts 2 ticks later, and a cell without them merged a ball that
			// just entered an arrow with its own parent, which the dedup then dropped: a 1-wide arrow shaft ended every search)
			return `${d}|${s.on_ground ? 1 : 0}|${x8}|${y8}|${Math.round(s.speed_x * VXQ)}|${Math.round(s.speed_y * VYQ)}|${clsId[idOf(s._q0)]}.${clsId[idOf(s._q1)]}`;
		};
		// the place key (no speeds): the fallback's index
		const placeOf = (key) => { const p = key.split('|'); return `${p[0]}|${p[1]}|${p[2]}|${p[3]}`; };
		const cellId = new Map();                // key -> id
		const cellKey = [], cellSnap = [], cellTile = [];
		const revFrom = [], revTicks = [];       // reversed edges per child id: parents and ticks (flat arrays per cell)
		const toTarget = new Map();              // parent id -> least ticks to the target
		const byPlace = new Map();               // place -> [ids]
		// THE CLOSURE'S ORDER: nearest the target first (the walk distance of the cell's tile: a bucket queue), so the values
		// grow backward from the target and a closure cut by its clock has the target's side, not a start-side generation
		const buckets = [];
		let bCur = 0, bLeft = 0;
		const qPush = (id, tile) => { const w = tile >= 0 && wd[tile] >= 0 ? wd[tile] : lim; let b = buckets[w]; if (!b) b = buckets[w] = []; b.push(id); bLeft++; if (w < bCur) bCur = w; };
		const bHead = [];
		const qPop = () => { while (bCur < buckets.length && (!buckets[bCur] || (bHead[bCur] | 0) >= buckets[bCur].length)) bCur++; if (bCur >= buckets.length) return -1; bLeft--; const h = bHead[bCur] | 0; bHead[bCur] = h + 1; return buckets[bCur][h]; };
		const addCell = (key, s, tile) => {
			let id = cellId.get(key);
			if (id !== undefined) return id;
			if (cellKey.length >= P.maxCells) { stats.capped = true; return -1; }
			id = cellKey.length;
			cellId.set(key, id); cellKey.push(key); cellSnap.push(s.snapshot()); cellTile.push(tile);
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
		const dirsOf = (s) => {
			const k = dirKind[idOf(s.current_tile)] | dirKind[idOf(s._q0)] | dirKind[idOf(s._q1)];
			return k === 1 ? DIRS_V : k === 2 ? DIRS_H : DIRS_ALL;
		};
		const canJump = (s) => s.on_ground || (s.max_jumps > 1 && s.jump_count < s.max_jumps) || s.has_levitation;
		/**
		 * play the macro (mask m, the jump press on the first tick when p) from the snapshot; calls out(kind, ticks, masks)
		 * with sim at the event's state: kind 0 a child, 1 the target; the landing's hop too (kind 0, its own masks).
		 * masks: a shared buffer (valid until the next call); ticks = its length.
		 */
		const buf = new Uint8Array(MAXT + 2);
		function play(snap, m, p, out) {
			sim.restore(snap);
			const c0 = clsId[idOf(sim.current_tile)];
			let g0 = sim.on_ground && sim.speed_y === 0 ? 1 : (sim.on_ground ? 1 : 0);
			const x80 = Math.floor((sim.px + 8) / 8), y80 = Math.floor((sim.py + 8) / 8);
			let air = 0;
			for (let t = 0; t < MAXT; t++) {
				const px = sim.px, py = sim.py;
				const mk = t === 0 && p ? (m | 1) : m;
				buf[t] = mk;
				E.applyMask(inp, mk); sim.tick(inp);
				if (sim.is_dead) return;
				if (inTgt(sim)) { out(1, t + 1, buf); return; }
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
						for (let q = 0; q <= t; q++) { const mm = q === t ? (buf[q] | 1) : buf[q]; E.applyMask(inp, mm); sim.tick(inp); if (sim.is_dead) break; }
						if (!sim.is_dead) {
							buf[t] |= 1;
							if (inTgt(sim)) out(1, t + 1, buf); else out(0, t + 1, buf);
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
			return out;
		};

		// ------------------------------------------------------------ THE CLOSURE (backward: seeded around the target)
		const tC0 = Date.now();
		const startKey = keyOf(sim);
		const startCell = addCell(startKey, sim, tileOfS(sim));
		const seedAll = () => {
			if (P.seeds === false) return;
			// the start's discrete state at rest on every standable half tile of the corridor, nearest the target first
			const order = [];
			for (let t = 0; t < N; t++) if (inCorr[t]) order.push(t);
			order.sort((a, b) => wd[a] - wd[b]);
			for (const t of order) {
				const cx = t % W, cy = (t / W) | 0;
				if (cy + 1 >= H) continue;
				const f = sol[t + W];
				const inField = clsId[idOf(sim.tiles[t])] !== 0;
				if (!(f !== 0 || inField)) continue;                 // standable (a floor under), or a field tile (dots, liquids ...)
				for (const px of [16 * cx - 4, 16 * cx + 4]) {
					const py = 16 * cy;
					if (!boxFree(sol, px, py)) continue;
					sim.restore(snap0);
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
		const expand = (id) => {
			const snap = cellSnap[id];
			cellSnap[id] = null;                   // (expanded once: its state is no longer needed)
			sim.restore(snap);
			const ms = macrosOf();
			for (const [m, p] of ms) {
				play(snap, m, p, (kind, ticks) => {
					if (kind === 1) {
						const q = toTarget.get(id);
						if (q === undefined || ticks < q) toTarget.set(id, ticks);
						stats.targetEdges++;
						return;
					}
					const tl = tileOfS(sim);
					if (tl < 0 || !inCorr[tl]) return;
					const k = keyOf(sim);
					const cid = addCell(k, sim, tl);
					if (cid >= 0) addEdge(id, cid, ticks);
				});
			}
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
			stats.dStart = D[startCell] < Infinity ? D[startCell] : null;
			stats.dijMs += Date.now() - tD0;
		};

		// the value of a state's cell: its own, else the nearest speed class of its place, else the walk
		const hOf = (key, tile, hf) => {
			const id = cellId.get(key);
			if (id !== undefined && D[id] < Infinity) return D[id];
			const a = byPlace.get(placeOf(key));
			if (a) {
				const p = key.split('|'), vx = +p[4], vy = +p[5];
				let best = Infinity, bd = Infinity;
				for (const c of a) {
					if (!(D[c] < Infinity)) continue;
					const q = cellKey[c].split('|'), dd = Math.abs(+q[4] - vx) / VXQ + Math.abs(+q[5] - vy) / VYQ;
					if (dd < bd || (dd === bd && D[c] < best)) { bd = dd; best = D[c]; }
				}
				if (best < Infinity) return best + bd * 4;
			}
			return hf;
		};

		// ------------------------------------------------------------ MEET: A* over exact states from the real start
		const tM0 = Date.now();
		let nodes = [];
		const meet = (cap, until) => {
			const heap = makeHeap();
			nodes = [];                              // {snap, par, masks (Uint8Array of the move), g}
			const seenG = new Map();                   // cell key -> [g, ...] (the P.keep least)
			const seenH = new Set();                  // the exact states pushed (a state twice is one node)
			const push = (snap, par, masks, g, key, tile, hsh, hf) => {
				const a = seenG.get(key);
				if (a && a.length >= P.keep && a[a.length - 1] <= g) return;
				if (hsh !== undefined) { if (seenH.has(hsh)) return; seenH.add(hsh); }
				if (!a) seenG.set(key, [g]);
				else { let i = a.length; while (i > 0 && a[i - 1] > g) i--; a.splice(i, 0, g); if (a.length > P.keep) a.pop(); }
				const hv = hOf(key, tile, hf);
				if (!(hv < Infinity)) return;
				const id = nodes.length;
				nodes.push({ snap, par, masks, g });
				heap.push(g + P.w * hv, id);
			};
			sim.restore(snap0);
			push(snap0, -1, null, 0, startKey, tileOfS(sim), undefined, hFall(sim, tileOfS(sim)));
			let found = null, ex = 0;
			while (heap.size && !found && Date.now() < until && ex < cap) {
				const id = heap.pop();
				const nd = nodes[id];
				ex++; stats.meetExpanded++;
				if (o.trace) { sim.restore(nd.snap); o.trace('pop', nd.g, keyOf(sim), sim); }
				const snapE = nd.snap;
				nd.snap = null;
				sim.restore(snapE);
				const ms = macrosOf();
				for (const [m, p] of ms) {
					play(snapE, m, p, (kind, ticks, masks) => {
						if (found && kind === 0) return;
						const mm = Uint8Array.from(masks.subarray(0, ticks));
						if (kind === 1) {
							const g = nd.g + ticks;
							if (!found || g < found.g) found = { par: id, masks: mm, g };
							return;
						}
						const tl = tileOfS(sim);
						if (o.trace) o.trace('child', nd.g + ticks, keyOf(sim), sim, m, p, ticks);
						push(sim.snapshot(), id, mm, nd.g + ticks, keyOf(sim), tl, sim.stateHash(), hFall(sim, tl));
					});
				}
			}
			stats.exhausted = !found && heap.size === 0;
			return found;
		};
		// 1. THE QUICK MEET: the walk's order alone (a short leg needs no closure)
		let found = meet(P.quick, t0 + clock * P.quickF);
		stats.quick = !!found;
		if (!found && P.closeF > 0) {
			// 2. the closure, target first (the seeds made now); 3. the values; 4. the meet with them
			seedAll();
			closure(closeEnd);
			dijkstra();
			found = meet(P.meetNodes, tEnd);
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
		if (!found) return { ok: false, why: stats.exhausted ? 'exhausted' : 'budget', stats };
		// the masks: the chain of moves, replayed from the start (the engine's own goal)
		const parts = [found.masks];
		for (let q = found.par; q >= 0 && nodes[q].masks; q = nodes[q].par) parts.push(nodes[q].masks);
		parts.reverse();
		let T = 0; for (const a of parts) T += a.length;
		const masks = new Uint8Array(T);
		let off = 0; for (const a of parts) { masks.set(a, off); off += a.length; }
		sim.restore(snap0);
		let hit = 0;
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (sim.is_dead) break; if (inTgt(sim)) { hit = t + 1; break; } }
		if (!hit) return { ok: false, why: 'the replay missed (a bug)', stats };
		return { ok: true, masks: masks.subarray(0, hit), T: hit, why: '', stats };
	}

	return { solve, L };
}

module.exports = { createBackward, DEF };
