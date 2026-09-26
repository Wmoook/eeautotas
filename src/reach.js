'use strict';
// The reach field: a physics-aware distance to the trophy for the level editor's route search ("Find a route").
//
// The ball's state is (tile, b): b = how far its box centre can still rise, in UNITS of 8 px (half a tile), measured
// from the tile's middle. Rising costs budget and the budget comes from physics (the numbers are eeo-tas measurements
// with the exact engine; margins keep the model optimistic):
//   - standing on a floor (a solid block, one-way, half block or door under the centre's tile, or a ledge under a
//     neighbouring open column) in a tile with gravity: a jump rises 63.42 px = 8 units (rounded up, like every budget
//     here: the centre does enter the 4th row up; the model lets the box stand on 4-tile ledges, the game does not: an
//     optimistic model may allow too much, never too little); 9 units in levels with half blocks (8 px steps);
//   - the landing-tick jump (the "arrow ground jump"): a floor under a no-jump tile (dots, arrows, liquids, ladders)
//     reached by a fall of 15+ tiles still jumps, up to 83 px: 11 units;
//   - up arrows: they also bounce a falling ball back (a trampoline), so up to 44 units whatever the column;
//   - tiles without vertical gravity: the ball moves freely inside and leaves upward with a budget from the column
//     height h (dots, side arrows and side boosts: 8 px above the top edge for one dot row ... 58 px for 20; water
//     20 px; ladders 5.5 px; mud and lava 1 px), up arrows: 14 px (h = 1) ... 129 px (h = 20); plus 1 unit each;
//   - an up boost or a portal exit: unlimited.
// Moving sideways keeps b, moving down (falling) sets it to 0, moving up costs 2 units (middle to middle); touching a
// tile from below (the trophy, a portal, a tile without gravity: the centre only has to cross the edge) costs 1.
// Deadly tiles (spikes, fire, toxic; the box centre is never there at the start of a tick) and solid blocks are walls; a
// diagonal step is closed only between two walls (between spikes the centre slips past the corner within a tick).
//
// It is OPTIMISTIC by design (sideways moves are free, doors are open, any floor is jumpable, every table has a
// margin), so "unreachable" (-1) is a proof the model allows: the explore prunes those states and the editor calls such
// a trophy impossible. Levels with effects that change jumping or gravity (jump, fly, low gravity, multijump, gravity),
// a world gravity other than 1, or protection fall back to plain walking distance (mode 'walk').
//
// The cost is in tiles along the way (1 per step, 1.4142 per diagonal step).
// reachField(level, {check}) -> { W, H, B, JB, g, mode, cls, own, refresh (the jump budget per tile, 0 = none),
//   cost (Float32Array N*(B+1), -1 = unreachable), mismatches (with check: the Bellman self-test) };
// reachField(level, {goals: [{tile, cost}], maxCost}): the distance to the nearest of these tiles instead of the trophy,
//   each goal starting at its own cost (every budget); goal tiles are not the end of the way (the trophy still is), so a
//   goal's cost is min(its own, the way through it to a cheaper goal). explore.js --hunt: the reference run's positions
//   with their time to go, the time-to-go field of a window. maxCost: the search stops there and every state that would
//   cost more stays -1 (then -1 is "further than maxCost", not a proof).
// writeReachFile(field, file) writes it for eegpu (--reach=<file>, native/beam.h ReachField / reachAt);
// costAt(field, px, py, vy, onGround) samples it like the GPU does.
const fs = require('fs');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32;
const BMAX = 16;                    // budget levels 0..B (units of 8 px); B = unlimited (never used up): a budget of B or more
                                    // (120+ px of rise) counts as unlimited, which keeps the model optimistic; B is per level:
                                    // BMAX with unlimited sources (up boosts, portals, wild effects), else just above the
                                    // biggest budget the level can give (fewer states, the same costs)
const C_SOLID = 0, C_NORMAL = 1, C_ZEROV = 2, C_UP = 3, C_BOOSTUP = 4, C_DEADLY = 5;
const TROPHY = 121;
// effects that change how high or how often the ball jumps, or where gravity points (the model gives up on those)
const WILD_EFFECTS = new Set([417, 418, 453, 461, 1517]);
const PROTECTION = 420;
const PX_GRAVITY = 2 / 7.752;       // px/tick^2 of normal gravity (GRAVITY / physics_variable_multiplyer)
const JUMP_UNITS = 8;               // a standing jump: the box rises 63.42 px (rounded up: the centre enters the 4th row up)
const LAND_UNITS = 11;              // the landing-tick jump through a no-jump tile: up to 83 px
const LAND_FALL_TILES = 15;         // ... after a fall of 243+ px
// the centre's apex above the column's top edge (px) by the column height, from rest holding up (measured)
const DOT_APEX = [[1, 8.0], [2, 15.4], [3, 19.2], [4, 25.7], [5, 30.2], [6, 31.7], [8, 37.0], [10, 45.0], [15, 51.2], [20, 57.7], [1e9, 86.2]];
const UP_APEX = [[1, 13.6], [2, 26.5], [3, 41.3], [4, 46.2], [5, 60.5], [6, 68.8], [8, 80.0], [10, 94.1], [15, 113.5], [20, 129.4], [1e9, 249]];
// an up-arrow column also bounces a falling ball back (a trampoline): a fall at up to 13.55 px/tick comes back up to about
// 241 px, plus up to 56 px of pumping and 24 px per dot or arrow row stacked on top (measured); the fall height is not in
// the state, so every up arrow gets that much
const UP_BOUNCE = 44;
const WATER_APEX = [[1, 7.7], [2, 14.8], [3, 16.5], [5, 18.8], [1e9, 19.9]];
const apexOf = (table, h) => { for (const [hh, a] of table) if (h <= hh) return a; return table[table.length - 1][1]; };
/** units above the tile's middle for a centre apex a px above the column's top edge (+1 unit of margin) */
const unitsOf = (a) => 1 + Math.floor(a / 8) + 1;

/** the level's tiles -> classes, own budgets, jump budgets, and the cost-to-trophy table */
function reachField(level, opts) {
	let B = BMAX;
	const W = level.width, H = level.height, N = W * H;
	const fg = level.fg, flags = level.flags, gF = level.gFlags, gMox = level.gMox, gMoy = level.gMoy, nFlags = flags.length;
	const fl = (id) => (id >= 0 && id < nFlags ? flags[id] : 0);
	let wild = !(level.gravityMult === 1);
	let protect = false, halves = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (WILD_EFFECTS.has(id)) wild = true;
		if (id === PROTECTION) protect = true;
		if (fl(id) & (F_HALF | F_ROTHALF)) halves = true;
	}
	const mode = wild ? 'walk' : 'physics';
	const JB = JUMP_UNITS + (halves ? 1 : 0);
	const cls = new Uint8Array(N), sub = new Uint8Array(N), own = new Uint8Array(N), refresh = new Uint8Array(N);
	const wall = (id) => { const f = fl(id); return (f & F_SOLID) !== 0 && (f & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0; };
	const floor = (id) => (fl(id) & (F_SOLID | F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) !== 0;
	// sub-classes of the tiles without vertical gravity: 1 dots / side arrows / side boosts, 2 climbables, 3 water,
	// 4 mud or lava
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (wall(id)) { cls[i] = C_SOLID; continue; }
		if (!protect && id >= 0 && id < nFlags && (gF[id] & 4) !== 0) { cls[i] = C_DEADLY; continue; }
		if (wild) { cls[i] = C_ZEROV; own[i] = B; continue; }
		const mox = id >= 0 && id < nFlags ? gMox[id] : 0, moy = id >= 0 && id < nFlags ? gMoy[id] : 2;
		if (id === 116) { cls[i] = C_BOOSTUP; own[i] = B; }
		else if ((fl(id) & F_CLIMB) !== 0) { cls[i] = C_ZEROV; sub[i] = 2; }
		else if (id === 119) { cls[i] = C_ZEROV; sub[i] = 3; }
		else if (id === 369 || id === 416) { cls[i] = C_ZEROV; sub[i] = 4; }
		else if (mox !== 0 || (moy > -1 && moy <= 0.5)) { cls[i] = C_ZEROV; sub[i] = 1; }
		else if (moy < 0) cls[i] = C_UP;
		else cls[i] = C_NORMAL;
	}
	// own budgets from the column heights (a run of the same kind of tile)
	for (let x = 0; x < W; x++) {
		for (let y = 0; y < H;) {
			const i = y * W + x, c = cls[i];
			if ((c !== C_ZEROV && c !== C_UP) || wild) { y++; continue; }
			let y2 = y;
			while (y2 + 1 < H && cls[(y2 + 1) * W + x] === c && sub[(y2 + 1) * W + x] === sub[i]) y2++;
			const h = y2 - y + 1;
			let u;
			if (c === C_UP) u = Math.max(unitsOf(apexOf(UP_APEX, h)), UP_BOUNCE);
			else if (sub[i] === 2) u = unitsOf(5.5);
			else if (sub[i] === 3) u = unitsOf(apexOf(WATER_APEX, h));
			else if (sub[i] === 4) u = unitsOf(1);
			else u = unitsOf(apexOf(DOT_APEX, h));
			for (let k = y; k <= y2; k++) own[k * W + x] = u >= B ? B : u;
			y = y2 + 1;
		}
	}
	// jump budgets: a floor under the centre's tile, or a ledge under a neighbouring open column (the box reaches 8 px into
	// both, and TAS routes jump from exactly there); the landing-tick jump through a no-jump tile after a long fall
	const passable = (i) => cls[i] !== C_SOLID && cls[i] !== C_DEADLY;
	for (let i = 0; i < N; i++) {
		const y = Math.floor(i / W), x = i % W;
		const ledge = (x2) => x2 >= 0 && x2 < W && !wall(fg[i - x + x2]) && floor(fg[i + W - x + x2]);
		const onFloor = y === H - 1 || floor(fg[i + W]) || ledge(x - 1) || ledge(x + 1);
		if (!onFloor || !passable(i)) continue;
		if (cls[i] === C_NORMAL || cls[i] === C_UP) refresh[i] = JB;
		if (wild) refresh[i] = B;
		else if (cls[i] !== C_NORMAL) {
			let air = 0;
			for (let k = y - 1; k >= 0 && passable(k * W + x) && air < LAND_FALL_TILES; k--) air++;
			if (air >= LAND_FALL_TILES) refresh[i] = Math.max(refresh[i], LAND_UNITS);
		}
	}
	// portals: exit tiles per entered portal tile
	const portalExits = new Map();
	if (level.portalSlot && level.portalsById) {
		for (let i = 0; i < N; i++) {
			const t = fg[i], s = level.portalSlot[i];
			if ((t === 242 || t === 381) && s >= 0) {
				const ex = level.portalsById.get(level.pTarget[s]);
				if (!ex) continue;
				const list = [];
				for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && passable(j)) list.push(j); }
				if (list.length) portalExits.set(i, list);
			}
		}
	}
	const portalSources = new Map();   // exit tile -> portal tiles that lead there
	for (const [p, exits] of portalExits) for (const e of exits) { if (!portalSources.has(e)) portalSources.set(e, []); portalSources.get(e).push(p); }
	// a tile the centre only has to touch from below: the trophy, a portal, a tile without gravity
	const touch = (i) => fg[i] === TROPHY || portalExits.has(i) || cls[i] !== C_NORMAL;

	// the budget levels this level needs
	let maxOwn = 0, unlimited = wild || portalExits.size > 0;
	for (let i = 0; i < N; i++) { if (cls[i] === C_BOOSTUP || own[i] >= BMAX) unlimited = true; else if (own[i] > maxOwn) maxOwn = own[i]; }
	if (!unlimited) {
		B = Math.min(BMAX, Math.max(JB, LAND_UNITS, 11, maxOwn) + 2);
		for (let i = 0; i < N; i++) { if (refresh[i] >= B) refresh[i] = B - 1; }
	}
	const S = B + 1;
	const effIn = (i, b) => (cls[i] === C_NORMAL ? b : Math.max(b, own[i]));
	// in dots, side arrows and side boosts holding up adds speed: +8 px of rise per tile climbed (v^2 grows by 2 x 0.129 x 16
	// = 4.13), up to the 6.78 px/tick cap there (a rise of about 86 px: 11 units)
	const dotty = (i) => cls[i] === C_ZEROV && sub[i] === 1;
	const DOT_CAP = 11;
	/** the forward move from tile t with budget b by (dx, dy) into t2: the new budget, or -1 when not possible. Going up
	 *  costs half a tile (1 unit) in each tile with gravity on the way (from the middle of t to the middle of t2), nothing in
	 *  tiles without it; a tile the centre only has to touch (the trophy, a portal) needs only the first half. */
	const step = (t, b, dy, t2) => {
		const bin = effIn(t, b);
		let nb;
		if (bin === B) nb = dy > 0 && cls[t2] === C_NORMAL ? 0 : B;
		else if (dy < 0) {
			const c1 = cls[t] === C_NORMAL ? 1 : 0, c2 = cls[t2] === C_NORMAL ? 1 : 0;
			if (bin < c1 + (touch(t2) ? 0 : c2)) return -1;
			nb = Math.max(0, bin - c1 - c2);
		} else if (dy === 0) nb = bin;
		else nb = 0;
		// (only going up: holding up adds half of the height climbed inside dots, so +1 unit per tile; sideways adds nothing)
		if (dy < 0 && nb < B && dotty(t2) && nb < DOT_CAP) nb = Math.min(DOT_CAP, nb + 1);
		if (cls[t2] !== C_NORMAL) nb = Math.max(nb, own[t2]);
		return nb;
	};
	/** step() inverted: every b with step(t, b, dy, t2) === b2 (the Dijkstra runs backwards). The forward map changes the
	 *  budget by -2..+1 unless it floors it (falling: 0; a tile's own budget; unlimited), so the candidates are few; each is
	 *  checked with step() itself. */
	const preds = (t, dy, t2, b2, emit) => {
		const o1 = cls[t] === C_NORMAL ? -1 : own[t], o2 = cls[t2] === C_NORMAL ? -1 : own[t2];
		const lo = dy > 0 || (o2 >= 0 && b2 === o2) || (dotty(t2) && b2 <= DOT_CAP) ? 0 : Math.max(0, b2 - 2);
		const hi = dy > 0 ? B : Math.min(B, b2 + 3);
		const tryBin = (bin) => {
			// the b values whose effective budget in t is bin
			if (o1 < 0) { if (step(t, bin, dy, t2) === b2) emit(bin); return; }
			if (bin < o1) return;
			if (step(t, bin, dy, t2) !== b2) return;
			if (bin === o1) for (let x = 0; x <= bin; x++) emit(x); else emit(bin);
		};
		if (dy > 0) {
			// falling: the result does not depend on the budget (except unlimited), so no need to try every value
			const r0 = step(t, 0, dy, t2), rB = step(t, B, dy, t2);
			if (r0 === b2) { if (o1 < 0) { for (let x = 0; x < B; x++) emit(x); } else for (let x = 0; x < B; x++) emit(x); }
			if (rB === b2) emit(B);
			return;
		}
		for (let bin = lo; bin <= hi; bin++) tryBin(bin);
		if (hi < B) tryBin(B);
	};
	const cost = new Float32Array(N * S).fill(-1);
	// Dijkstra backwards from the trophy tiles (any budget), an indexed binary heap (decrease-key)
	const hk = new Int32Array(N * S), hv = new Float32Array(N * S), hpos = new Int32Array(N * S).fill(-1);
	let hn = 0;
	const up = (n) => {
		const k = hk[n], v = hv[n];
		while (n > 0) { const p = (n - 1) >> 1; if (hv[p] <= v) break; hk[n] = hk[p]; hv[n] = hv[p]; hpos[hk[n]] = n; n = p; }
		hk[n] = k; hv[n] = v; hpos[k] = n;
	};
	const push = (k, v) => { if (hpos[k] >= 0) { hv[hpos[k]] = v; up(hpos[k]); return; } hk[hn] = k; hv[hn] = v; hpos[k] = hn; up(hn++); };
	let popV = 0;
	const pop = () => {
		const k = hk[0]; popV = hv[0];
		hpos[k] = -2;   // done
		const lk = hk[--hn], lv = hv[hn];
		if (hn > 0) {
			let n = 0;
			for (;;) {
				const l = 2 * n + 1, r = l + 1;
				let m = n, mv = lv;
				if (l < hn && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < hn && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === n) break;
				hk[n] = hk[m]; hv[n] = hv[m]; hpos[hk[n]] = n; n = m;
			}
			hk[n] = lk; hv[n] = lv; hpos[lk] = n;
		}
		return k;
	};
	let goals = 0;
	// opts.goals: the goal tiles and their own costs (the lowest per tile), else the trophy tiles at 0
	const goalCost = opts && opts.goals ? new Float64Array(N).fill(Infinity) : null;
	if (goalCost) {
		for (const g of opts.goals) {
			const i = g.tile;
			if (!(i >= 0 && i < N) || !passable(i) || !(g.cost >= 0)) continue;
			if (goalCost[i] === Infinity) goals++;
			if (g.cost < goalCost[i]) goalCost[i] = g.cost;
		}
		for (let i = 0; i < N; i++) if (goalCost[i] !== Infinity) for (let b = 0; b < S; b++) { cost[i * S + b] = goalCost[i]; push(i * S + b, goalCost[i]); }
	} else for (let i = 0; i < N; i++) if (fg[i] === TROPHY && passable(i)) { goals++; for (let b = 0; b < S; b++) { cost[i * S + b] = 0; push(i * S + b, 0); } }
	const maxCost = opts && opts.maxCost >= 0 ? opts.maxCost : Infinity;
	const relax = (k, v) => { if (hpos[k] !== -2 && (cost[k] < 0 || v < cost[k] - 1e-6)) { cost[k] = v; push(k, v); } };
	while (hn > 0) {
		if (hv[0] > maxCost) {   // opts.maxCost: everything still open costs more
			for (let n = 0; n < hn; n++) cost[hk[n]] = -1;
			break;
		}
		const k = pop(), v = popV;
		const t2 = (k / S) | 0, b2 = k - t2 * S, x2 = t2 % W, y2 = (t2 / W) | 0;
		// the jump: (t, b < refresh) -> (t, refresh) for free on a floor
		if (refresh[t2] && b2 === refresh[t2]) for (let b = 0; b < b2; b++) relax(t2 * S + b, v);
		// portals: (portal, any b) -> (exit, B)
		if (b2 === B && portalSources.has(t2)) for (const p of portalSources.get(t2)) for (let b = 0; b < S; b++) relax(p * S + b, v + 1);
		// moves into t2 from its 8 neighbours
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x = x2 - dx, y = y2 - dy;   // the tile the move starts from
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const t = y * W + x;
				if (!passable(t) || fg[t] === TROPHY) continue;
				if (dx && dy && cls[y * W + x2] === C_SOLID && cls[y2 * W + x] === C_SOLID) continue;
				const c = dx && dy ? 1.4142 : 1;
				preds(t, dy, t2, b2, (b) => relax(t * S + b, v + c));
			}
		}
	}
	// opts.check: every cost must equal the best forward move (Bellman), the forward model being step() + the jump +
	// portals; returns the number of states that do not (tests)
	let mismatches = 0;
	if (opts && opts.check) {
		for (let t = 0; t < N; t++) {
			if (!passable(t)) continue;
			const x = t % W, y = (t / W) | 0;
			for (let b = 0; b < S; b++) {
				let best = goalCost ? goalCost[t] : fg[t] === TROPHY ? 0 : Infinity;
				const via = (k, c) => { if (cost[k] >= 0 && cost[k] + c < best) best = cost[k] + c; };
				if (fg[t] !== TROPHY) {
					if (refresh[t] && b < refresh[t]) via(t * S + refresh[t], 0);
					if (portalExits.has(t)) for (const e of portalExits.get(t)) via(e * S + B, 1);
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const x2 = x + dx, y2 = y + dy;
						if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
						const t2 = y2 * W + x2;
						if (!passable(t2) || (dx && dy && cls[y * W + x2] === C_SOLID && cls[y2 * W + x] === C_SOLID)) continue;
						const nb = step(t, b, dy, t2);
						if (nb >= 0) via(t2 * S + nb, dx && dy ? 1.4142 : 1);
					}
				}
				const have = cost[t * S + b];
				if (have < 0 && best > maxCost - 1e-3) continue;   // (beyond opts.maxCost: -1)
				if ((best === Infinity) !== (have < 0) || (have >= 0 && Math.abs(have - best) > 1e-3)) mismatches++;
			}
		}
	}
	return { W, H, B, JB, g: PX_GRAVITY * (level.gravityMult || 1), mode, goals, cls, own, refresh, cost, mismatches };
}

/** the budget (units above tile i's middle) of a ball whose centre is at cy (px), vertical speed vy px/tick, on the
 *  ground or not; like the GPU (native/beam.h reachBudget) */
function budgetAt(f, i, cy, vy, onGround) {
	const row = Math.floor(i / f.W), top = vy < 0 ? cy - (vy * vy) / (2 * f.g) : cy;
	let b = Math.min(f.B - 1, Math.max(0, Math.ceil((row * 16 + 8 - top) / 8 - 1e-9)));   // (rounded up: optimistic)
	if (onGround && f.refresh[i] > b) b = f.refresh[i];
	if (f.cls[i] !== C_NORMAL && f.own[i] > b) b = f.own[i];
	return b;
}
/** the cost to the trophy of a ball (top-left px, py; vertical speed; on the ground); -1 = unreachable */
function costAt(f, px, py, vy, onGround) {
	const cx = Math.trunc(px + 8) >> 4, cy = Math.trunc(py + 8) >> 4;
	if (cx < 0 || cy < 0 || cx >= f.W || cy >= f.H) return -1;
	const i = cy * f.W + cx;
	return f.cost[i * (f.B + 1) + budgetAt(f, i, py + 8, vy, onGround)];
}

/** eegpu's reach file: 'RCH2', W, H, B, JB (int32), g (float32), mode (int32: 0 physics, 1 walk), then cls, own,
 *  refresh (the jump budget; uint8 x N each, padded to 4), cost (float32 x N*(B+1)). Budgets are in units of 8 px. */
function writeReachFile(f, file) {
	const N = f.W * f.H, pad = (n) => (n + 3) & ~3;
	const buf = Buffer.alloc(28 + 3 * pad(N) + 4 * N * (f.B + 1));
	buf.write('RCH2', 0, 'latin1');
	buf.writeInt32LE(f.W, 4); buf.writeInt32LE(f.H, 8); buf.writeInt32LE(f.B, 12); buf.writeInt32LE(f.JB, 16);
	buf.writeFloatLE(f.g, 20); buf.writeInt32LE(f.mode === 'walk' ? 1 : 0, 24);
	let o = 28;
	for (const a of [f.cls, f.own, f.refresh]) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, o); o += pad(N); }
	Buffer.from(f.cost.buffer, f.cost.byteOffset, f.cost.byteLength).copy(buf, o);
	fs.writeFileSync(file, buf);
}

module.exports = { reachField, costAt, budgetAt, writeReachFile, BMAX, C_SOLID, C_NORMAL, C_ZEROV, C_UP, C_BOOSTUP, C_DEADLY };
