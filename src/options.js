'use strict';
// EVENT OPTIONS (INNOLOOP round 1, 2026-09-29; goexplore.js --opts=1, OFF by default): macro-actions for the CPU random
// runs. An option holds ONE input (a mask from the runs' own draw()) until a physical event ends it or its cap runs out:
//   LAND   on_ground goes false -> true
//   LIFT   on_ground goes true -> false
//   WALL   the held direction across gravity (left / right under vertical gravity, up / down under horizontal gravity,
//          either with none) had the ball moving that way at 0.5 px/tick or more, and now it does not (a wall, a
//          ledge's lip, an arrow pushing back); a mask that holds no such direction ends by its cap only
//   APEX   the speed along gravity changes sign (the top of a jump; a fall turned upward by a boost or a bounce)
//   FIELD  the centre tile's class changes: plain / arrow / boost / dot / liquid / climbable / effect (fieldClasses)
//   ROOM   the room key (goexplore.js roomOf) changes (coarse cells; none with fine cells: the cap ends it)
// The cap is scale-free: 4 x luby(j) ticks (at most 256), j a per-worker counter of the options drawn; a run of
// options lasts 40 x luby(k) ticks (at most 320), k per worker. With the sticky rule (keep 0.85) a 60-tick hold has
// p = 0.85^60 ~ 6e-5; the Luby caps give 1/64 of the options 64+ ticks when no event ends them first.
const BK = require('./blocks.js');

const T_LAND = 0, T_LIFT = 1, T_WALL = 2, T_APEX = 3, T_FIELD = 4, T_ROOM = 5, T_CAP = 6;
const NAMES = ['land', 'lift', 'wall', 'apex', 'field', 'room', 'cap'];
const N_EVENTS = 6;
const CAP_UNIT = 4, CAP_MAX = 256, LEN_UNIT = 40, LEN_MAX = 320;
const WALL_V = 0.5;

/** the Luby sequence's i-th term (i from 1): 1 1 2 1 1 2 4 1 1 2 1 1 2 4 8 ... */
function luby(i) {
	i = Math.max(1, Math.min(0x3fffffff, Math.floor(i)));
	for (;;) {
		const k = 32 - Math.clz32(i);   // the least k with 2^k - 1 >= i
		if (i === (1 << k) - 1) return 1 << (k - 1);
		i -= (1 << (k - 1)) - 1;
	}
}
/** an option's cap (ticks) for the j-th option */
const capOf = (j) => Math.min(CAP_MAX, CAP_UNIT * luby(j));
/** an option run's length (ticks) for the k-th option run */
const lenOf = (k) => Math.min(LEN_MAX, LEN_UNIT * luby(k));

// the centre tile's class for FIELD (0 plain: air, solids, coins, doors, ...)
const CLASS = { arrow: 1, boost: 2, dot: 3, liquid: 4, climbable: 5, effect: 6 };
/** per tile of the level (its foreground block), the FIELD class (Uint8Array of width x height) */
function fieldClasses(L) {
	const N = L.width * L.height, out = new Uint8Array(N), memo = new Map();
	for (let i = 0; i < N; i++) {
		const id = L.fg[i];
		if (!id) continue;
		let c = memo.get(id);
		if (c === undefined) { c = CLASS[BK.kindOf(id).kind] || 0; memo.set(id, c); }
		out[i] = c;
	}
	return out;
}

/**
 * One option's state, reused for every option of a worker. start(m, T, cap, key): a new option from the live state;
 * after(key): after each tick, the kind that ends it (T_LAND .. T_ROOM, T_CAP for the cap) or -1. key: the live
 * state's room key (goexplore.js roomOf; any number where there are no rooms: ROOM then never fires).
 */
class Option {
	constructor(sim, FC, W, N) {
		this.sim = sim; this.FC = FC; this.W = W; this.N = N;
		this.T = -1; this.m = 0; this.left = 0; this.held = 0;
		this.g = false; this.v = 0; this.pushed = false; this.f = 0; this.r = 0;
	}
	centre() {
		const s = this.sim;
		return Math.min(this.N - 1, Math.max(0, (Math.trunc(s.py + 8) >> 4) * this.W + (Math.trunc(s.px + 8) >> 4)));
	}
	/** the speed along gravity (NaN-free: 0 without gravity) */
	along() { const s = this.sim, g = s.gravity_dir; return s.speed_x * g.x + s.speed_y * g.y; }
	/** the speed in the held direction across gravity, NaN when the mask holds none there */
	push(m) {
		const s = this.sim, g = s.gravity_dir, h = m & 6, v = m & 24;
		if (h !== 0 && h !== 6 && g.x === 0) return (h === 4) ? s.speed_x : -s.speed_x;
		if (v !== 0 && v !== 24 && g.y === 0) return (v === 16) ? s.speed_y : -s.speed_y;
		return NaN;
	}
	start(m, T, cap, key) {
		const s = this.sim;
		this.m = m; this.T = T; this.left = cap; this.held = 0;
		this.g = s.on_ground;
		if (T === T_APEX) this.v = this.along();
		else if (T === T_WALL) this.pushed = this.push(m) >= WALL_V;
		else if (T === T_FIELD) this.f = this.FC[this.centre()];
		else if (T === T_ROOM) this.r = key;
	}
	after(key) {
		const s = this.sim;
		this.held++; this.left--;
		let k = -1;
		switch (this.T) {
			case T_LAND: if (!this.g && s.on_ground) k = T_LAND; this.g = s.on_ground; break;
			case T_LIFT: if (this.g && !s.on_ground) k = T_LIFT; this.g = s.on_ground; break;
			case T_WALL: { const p = this.push(this.m); if (p >= WALL_V) this.pushed = true; else if (this.pushed && p === p) k = T_WALL; break; }
			case T_APEX: { const v = this.along(); if ((this.v < 0 && v >= 0) || (this.v > 0 && v < 0)) k = T_APEX; this.v = v; break; }
			case T_FIELD: if (this.FC[this.centre()] !== this.f) k = T_FIELD; break;
			case T_ROOM: if (key !== this.r) k = T_ROOM; break;
			default: break;
		}
		if (k < 0 && this.left <= 0) k = T_CAP;
		return k;
	}
}

module.exports = { luby, capOf, lenOf, fieldClasses, Option, NAMES, N_EVENTS, T_LAND, T_LIFT, T_WALL, T_APEX, T_FIELD, T_ROOM, T_CAP, CAP_MAX, LEN_MAX };
