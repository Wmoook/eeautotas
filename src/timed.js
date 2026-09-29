'use strict';
// Timed killers for Find a route's searches: curse (421), zombie (422), fire (lava 416) and poison (1584) kill the ball
// a fixed number of ticks after it picked them up (eesim.js _playerTick: `flag && duration && ticks - start >
// duration`, Player.as:399-404; the duration (v + 0.4) x 100, fire's 240), unless something clears them first: a tile of
// the same effect with a number <= 0 (the "curse off" tiles), protection turned on (it clears all four), and for fire
// water, mud or toxic waste (eesim.js the effect switch). Forgotten Helix's curse leg: the arrows (234-239, 164) carry
// the ball through the curse (238, 164) (140 ticks), and the only remover on the way, (262-264, 165), is under a 2-tile
// gap in the spikes; the base route gets there in 89 ticks. A search that keeps the EARLIEST state per cell keeps, at
// every cell past the pickup, the state that picked the curse up first, whatever it has left: a later pickup that
// gets there faster from its own pickup (more time left) is dropped (src/out/night/helix_timed.md).
//
// timedOf(L) -> null (no timed killer in the level: every search is exactly as before) or
//   {kinds (bits KIND_*), lb [bit index] -> Uint16Array per tile (over a SharedArrayBuffer): a lower bound on the ticks
//    from a ball whose centre is in that tile until its centre can be in a tile that clears that killer or finishes
//    (the killer's removers, protection, the trophy; 0xffff: none that way), removers [bit index] -> the remover tiles}
//   The bound is lowerBoundTiles' (goexplore.js): the box moves at most 16.25 px along an axis in a tick, so its
//   centre's tile changes by at most 2 along each axis and its 1 px steps pass a 4-connected chain of tiles that are no
//   permanent wall; a portal moves it for nothing: ticks >= ceil(d / 4), d = the 4-connected steps to a goal tile or a
//   tile next to one (effects act on the tile under the centre, or the tile above / left of a half block: a neighbour
//   covers both). Sound: a state whose timer fires before that bound can only die (doomed()).
// timedLeft(sim) -> the ticks until the soonest running timed killer fires (eesim.js _effectTimerKey: start +
//   floor(duration) + 1 - ticks, at least 1; 0 = none: no timer, a duration of 0 (the NPC zombie), dead, or god mode,
//   where killPlayer does nothing); TL.dur / TL.kind: that timer's duration and kind bit (set by the call).
// bucketOf(left) -> the timer bucket of the last timedLeft() (1 + floor(left / w), w = max(W_MIN, ceil(duration / N_B));
//   0 without a timer): the searches' cells tell apart states whose soonest killer has more time left.
// doomed(TM, sim or tile, left) -> true when the ball cannot clear its soonest timed killer (nor finish) before it fires
//   (the lower bound above is more than the ticks left): its only future is that death.

const KIND_CURSE = 1, KIND_ZOMBIE = 2, KIND_FIRE = 4, KIND_POISON = 8;
const KINDS = [KIND_CURSE, KIND_ZOMBIE, KIND_FIRE, KIND_POISON];
// the timer buckets: N_B per duration, at least W_MIN ticks wide (Helix's 140-tick curse: 18 ticks, 8 buckets)
const N_B = 8, W_MIN = 8;
const TL = { dur: 0, kind: 0 };

const kindIndex = (k) => (k === KIND_CURSE ? 0 : k === KIND_ZOMBIE ? 1 : k === KIND_FIRE ? 2 : 3);

/** the ticks until the soonest running timed killer fires (0: none); TL.dur / TL.kind that killer's */
function timedLeft(sim) {
	TL.dur = 0; TL.kind = 0;
	if (sim.is_dead || sim.in_god_mode || !(sim.is_cursed || sim.is_zombie || sim.is_on_fire || sim.is_poisoned)) return 0;
	const now = sim._ticks;
	let best = 0;
	const one = (on, start, dur, kind) => {
		if (!on || !(dur !== 0.0 && dur === dur)) return;
		let r = start + Math.floor(dur) + 1 - now;
		if (r < 1) r = 1;
		if (best === 0 || r < best) { best = r; TL.dur = dur; TL.kind = kind; }
	};
	one(sim.is_cursed, sim._curse_time_start, sim._curse_duration, KIND_CURSE);
	one(sim.is_zombie, sim._zombie_time_start, sim._zombie_duration, KIND_ZOMBIE);
	one(sim.is_on_fire, sim._fire_time_start, sim._fire_duration, KIND_FIRE);
	one(sim.is_poisoned, sim._poison_time_start, sim._poison_duration, KIND_POISON);
	return best;
}

/** the bucket of `left` ticks for the last timedLeft()'s timer (0: none) */
function bucketOf(left) {
	if (left <= 0) return 0;
	const w = Math.max(W_MIN, Math.ceil(TL.dur / N_B));
	return 1 + Math.floor(left / w);
}
/** the highest bucket the last timedLeft()'s timer can have */
function bucketMax() {
	const w = Math.max(W_MIN, Math.ceil(TL.dur / N_B));
	return 1 + Math.floor((Math.floor(TL.dur) + 1) / w);
}

/** the goal tiles that clear killer `kind` (bit) in level L, the trophy's included */
function goalsOf(L, kind) {
	const N = L.width * L.height, fg = L.fg, lk = L.lookup0, out = [];
	for (let i = 0; i < N; i++) {
		const id = fg[i], v = lk ? lk[i] : 0;
		let g = id === 121 || (id === 420 && v !== 0);
		if (kind === KIND_CURSE) g = g || (id === 421 && v <= 0);
		else if (kind === KIND_ZOMBIE) g = g || (id === 422 && v <= 0);
		else if (kind === KIND_POISON) g = g || (id === 1584 && v <= 0);
		else if (kind === KIND_FIRE) g = g || id === 119 || id === 369 || id === 1585;
		if (g) out.push(i);
	}
	return out;
}

/** the lower bound (ticks) per tile to the goal tiles or a tile next to one (see the header); 0xffff: none */
function lowerBoundTo(L, goals) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const out = new Uint16Array(new SharedArrayBuffer(2 * N)).fill(0xffff);
	if (!goals.length) return out;
	const wall = new Uint8Array(N);
	for (let i = 0; i < N; i++) { const id = fg[i], f = id >= 0 && id < fl.length ? fl[id] : 0; wall[i] = (f & 1) !== 0 && (f & 16) === 0 && (f & (2 | 4 | 8)) === 0 ? 1 : 0; }
	const into = new Map();
	if (L.portalSlot && L.portalsById) {
		const silent = require('./reach.js').silentPortals(L);   // (portals EE never teleports from: no exits)
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || silent[i]) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N) { let l = into.get(j); if (!l) into.set(j, l = []); l.push(i); } }
		}
	}
	let nInto = 0;
	for (const l of into.values()) nInto += l.length;
	const d = new Int32Array(N).fill(-1), dq = new Int32Array(nInto + 6 * N + 16);
	let h = nInto + N + 8, t = h;
	const put = (j, v, front) => { if (d[j] >= 0 && d[j] <= v) return; d[j] = v; if (front) dq[--h] = j; else dq[t++] = j; };
	for (const i of goals) {
		const x = i % W, y = (i / W) | 0;
		put(i, 0, false);
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) put(yy * W + xx, 0, false); }
	}
	const done = new Uint8Array(N);
	while (h < t) {
		const i = dq[h++];
		if (done[i]) continue;
		done[i] = 1;
		const v = d[i];
		for (const p of into.get(i) || []) if (!done[p]) put(p, v, true);
		const x = i % W, y = (i / W) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const j = yy * W + xx;
			if (!wall[j] && !done[j]) put(j, v + 1, false);
		}
	}
	for (let i = 0; i < N; i++) if (d[i] >= 0) out[i] = Math.min(0xfffe, Math.ceil(d[i] / 4));
	return out;
}

/** the level's timed killers (see the header), or null */
function timedOf(L) {
	const N = L.width * L.height, fg = L.fg, lk = L.lookup0;
	let kinds = 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i], v = lk ? lk[i] : 0;
		if (id === 421 && v > 0) kinds |= KIND_CURSE;
		else if (id === 422 && v > 0) kinds |= KIND_ZOMBIE;
		else if (id === 416) kinds |= KIND_FIRE;
		else if (id === 1584 && v > 0) kinds |= KIND_POISON;
	}
	if (!kinds) return null;
	const lb = [null, null, null, null], removers = [null, null, null, null];
	for (const k of KINDS) {
		if (!(kinds & k)) continue;
		const g = goalsOf(L, k);
		removers[kindIndex(k)] = g.filter((i) => fg[i] !== 121);
		lb[kindIndex(k)] = lowerBoundTo(L, g);
	}
	return { kinds, lb, removers };
}
/** a timedOf() result sent to a worker thread (its arrays over SharedArrayBuffers) is usable as it arrives */
const shareTimed = (TM) => TM;

/** the ball at tile `tile` (its centre's) with `left` ticks on its soonest killer (TL.kind: the last timedLeft()'s)
 *  cannot clear it nor finish before it fires */
function doomed(TM, tile, left, kind) {
	if (TM === null || left <= 0) return false;
	const lb = TM.lb[kindIndex(kind === undefined ? TL.kind : kind)];
	if (lb === null) return false;
	return lb[tile] > left;
}

module.exports = { timedOf, timedLeft, bucketOf, bucketMax, doomed, lowerBoundTo, goalsOf, shareTimed, TL, KIND_CURSE, KIND_ZOMBIE, KIND_FIRE, KIND_POISON, N_B, W_MIN, kindIndex };
