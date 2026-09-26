'use strict';
// The reach field: a physics-aware distance to the trophy for the level editor's route search ("Find a route").
//
// The old goal field was the walking distance over open tiles, which counts empty air as a path: a ball under a
// ceiling of air looks "close" to a trophy it can never rise to. Here the ball's state is (tile, b), b = how many tile
// rows its box centre can still rise into. Rising costs budget; the budget comes from physics:
//   - standing on a floor (a solid block, one-way, half block or door below the centre's tile or a neighbouring
//     column: the box reaches 8 px into both) in a tile with gravity: a jump,
//     b = JB (the jump rises about 63 px = 4 rows; one row of margin);
//   - tiles without vertical gravity (dots, left/right arrows, climbables, liquids, side boosts): the ball moves
//     freely inside and leaves upward with 1 + ceil(h/2) rows (h = the height of that column of such tiles: it can
//     accelerate up through all of it; a single dot row gives 2, the real game about 1);
//   - up arrows: 1 + h rows (the height of the arrow column, energy in = energy out); an up boost: unlimited;
//   - a portal exit: unlimited (the velocity is rotated and x1.42).
// Moving sideways keeps b, moving down (falling) sets it to 0, moving up in a gravity tile costs 1 row. Deadly tiles
// (spikes, fire, toxic; the box centre is never there at the end of a tick) and solid blocks are walls. A diagonal step
// is closed only between two walls (the box cannot fit); between spikes it is open (the centre slips past the corner
// within a tick: a diagonal spike staircase like 213 is run that way).
//
// It is OPTIMISTIC by design (a route the game can do is never ruled out: margins on every budget, sideways moves
// free, doors open, any floor jumpable), so "unreachable" (-1) is a proof the model allows: the explore prunes those
// states and the editor can call a trophy impossible. Levels with effects that change jumping or gravity (jump, fly,
// low gravity, multijump, gravity), a world gravity other than 1, or protection make the model fall back to plain
// walking distance (mode 'walk').
//
// The cost is in tiles along the way (1 per step, 1.4142 per diagonal step), the same unit as the old field.
// reachField(level) -> { W, H, B, JB, g, mode, cls, own, refresh, cost (Float32Array N*(B+1), -1 = unreachable),
//   startCost }; writeReachFile(field, file) writes it for eegpu (--reach=<file>, native/beam.h ReachField);
//   costAt(field, px, py, vy, onGround) samples it like the GPU does (tests).
const fs = require('fs');

const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32;
const B = 16;                       // budget levels 0..B; B = unlimited (never used up)
const RANGES = [];
const range = (a, b) => { const k = a * 64 + b; return RANGES[k] || (RANGES[k] = Array.from({ length: b - a + 1 }, (_, i) => a + i)); };
const C_SOLID = 0, C_NORMAL = 1, C_ZEROV = 2, C_UP = 3, C_BOOSTUP = 4, C_DEADLY = 5;
const TROPHY = 121;
// effects that change how high or how often the ball jumps, or where gravity points (the model gives up on those)
const WILD_EFFECTS = new Set([417, 418, 453, 461, 1517]);
const PROTECTION = 420;
const PX_GRAVITY = 2 / 7.752;       // px/tick^2 of normal gravity (GRAVITY / physics_variable_multiplyer)
const JUMP_RISE = 63.2;             // px the box rises in a jump from standing (-6.708 px/tick under that gravity)

/** the level's tiles -> classes, own budgets, floors, and the cost-to-trophy table */
function reachField(level, opts) {
	const W = level.width, H = level.height, N = W * H;
	const fg = level.fg, flags = level.flags, gF = level.gFlags, gMox = level.gMox, gMoy = level.gMoy, nFlags = flags.length;
	const fl = (id) => (id >= 0 && id < nFlags ? flags[id] : 0);
	let wild = !(level.gravityMult === 1);
	let protect = false;
	for (let i = 0; i < N; i++) { if (WILD_EFFECTS.has(fg[i])) wild = true; if (fg[i] === PROTECTION) protect = true; }
	const mode = wild ? 'walk' : 'physics';
	const JB = Math.min(B - 1, Math.ceil((JUMP_RISE + 8) / 16));   // 5
	const cls = new Uint8Array(N), own = new Uint8Array(N), refresh = new Uint8Array(N);
	const wall = (id) => { const f = fl(id); return (f & F_SOLID) !== 0 && (f & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0; };
	const floor = (id) => (fl(id) & (F_SOLID | F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) !== 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (wall(id)) { cls[i] = C_SOLID; continue; }
		if (!protect && id >= 0 && id < nFlags && (gF[id] & 4) !== 0) { cls[i] = C_DEADLY; continue; }
		if (wild) { cls[i] = C_ZEROV; own[i] = B; continue; }
		const mox = id >= 0 && id < nFlags ? gMox[id] : 0, moy = id >= 0 && id < nFlags ? gMoy[id] : 2;
		if (id === 116) { cls[i] = C_BOOSTUP; own[i] = B; }
		// no or weak vertical gravity: dots, side arrows, climbables, side boosts, liquids (water pushes up a little)
		else if (mox !== 0 || (fl(id) & F_CLIMB) !== 0 || (moy > -1 && moy <= 0.5)) cls[i] = C_ZEROV;
		else if (moy < 0) cls[i] = C_UP;
		else cls[i] = C_NORMAL;
	}
	// own budgets from the column heights; floors
	for (let x = 0; x < W; x++) {
		for (let y = 0; y < H;) {
			const i = y * W + x, c = cls[i];
			if (c !== C_ZEROV && c !== C_UP) { y++; continue; }
			let y2 = y;
			while (y2 + 1 < H && cls[(y2 + 1) * W + x] === c) y2++;
			const h = y2 - y + 1;
			const liquid = (k) => { const id = fg[k]; return id === 119 || id === 369 || id === 416; };
			for (let k = y; k <= y2; k++) {
				const j = k * W + x;
				if (wild) own[j] = B;
				else if (c === C_UP) own[j] = Math.min(B - 1, 1 + h);
				else own[j] = Math.min(B - 1, 1 + Math.ceil(h / 2) + (liquid(j) ? 1 : 0));
			}
			y = y2 + 1;
		}
	}
	for (let i = 0; i < N; i++) {
		if (cls[i] !== C_NORMAL && cls[i] !== C_UP) continue;   // (jumps need gravity; up arrows: the arrow ground jump)
		// a floor under the centre or under either neighbouring column: the box reaches 8 px into both, so a ball can stand
		// on a ledge's edge with its centre over the air (and TAS routes jump from exactly there)
		const y = Math.floor(i / W), x = i % W;
		// (a neighbouring column counts only as a ledge: open beside the centre's tile, a floor under that; a wall beside the
		// ball is not something to stand on)
		const ledge = (x2) => x2 >= 0 && x2 < W && !wall(fg[i - x + x2]) && floor(fg[i + W - x + x2]);
		if (y === H - 1 || floor(fg[i + W]) || ledge(x - 1) || ledge(x + 1)) refresh[i] = 1;
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
				for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && cls[j] !== C_SOLID && cls[j] !== C_DEADLY) list.push(j); }
				if (list.length) portalExits.set(i, list);
			}
		}
	}
	const portalSources = new Map();   // exit tile -> portal tiles that lead there
	for (const [p, exits] of portalExits) for (const e of exits) { if (!portalSources.has(e)) portalSources.set(e, []); portalSources.get(e).push(p); }

	const S = B + 1;
	const passable = (i) => cls[i] !== C_SOLID && cls[i] !== C_DEADLY;
	const effIn = (i, b) => (cls[i] === C_NORMAL ? b : Math.max(b, own[i]));
	/** the forward move from tile t with budget b by (dx, dy) into t2: the new budget, or -1 when not possible */
	const step = (t, b, dy, t2) => {
		const bin = effIn(t, b), c2 = cls[t2];
		let nb;
		if (dy < 0) {
			if (bin < 1) return -1;
			nb = bin === B ? B : bin - 1;
		} else if (dy === 0) nb = bin;
		else nb = 0;
		if (c2 !== C_NORMAL) nb = Math.max(nb, own[t2]);
		return nb;
	};
	/** step() inverted: every b with step(t, b, dy, t2) === b2 (the Dijkstra runs backwards) */
	const preds = (t, dy, t2, b2, emit) => {
		const ownOf = (i) => (cls[i] === C_NORMAL ? -1 : own[i]);
		const o2 = ownOf(t2), o1 = ownOf(t);
		// nb: the budget after the move, before entering t2 (b2 = max(nb, own[t2]) for non-normal t2)
		const nbs = o2 < 0 ? [b2] : b2 < o2 ? [] : b2 === o2 ? range(0, b2) : [b2];
		for (const nb of nbs) {
			let bins;
			if (dy < 0) bins = nb === B ? [B] : nb + 1 < B ? [nb + 1] : [];
			else if (dy === 0) bins = [nb];
			else bins = nb === 0 ? range(0, B) : [];
			for (const bin of bins) {
				if (o1 < 0) emit(bin);
				else if (bin === o1) for (let b = 0; b <= bin; b++) emit(b);
				else if (bin > o1) emit(bin);
			}
		}
	};
	const cost = new Float32Array(N * S).fill(-1);
	// Dijkstra backwards from the trophy tiles (any budget)
	// an indexed binary heap (decrease-key): every state is in it at most once
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
	for (let i = 0; i < N; i++) if (fg[i] === TROPHY && passable(i)) { goals++; for (let b = 0; b < S; b++) { cost[i * S + b] = 0; push(i * S + b, 0); } }
	const relax = (k, v) => { if (hpos[k] !== -2 && (cost[k] < 0 || v < cost[k] - 1e-6)) { cost[k] = v; push(k, v); } };
	while (hn > 0) {
		const k = pop(), v = popV;
		const t2 = (k / S) | 0, b2 = k - t2 * S, x2 = t2 % W, y2 = (t2 / W) | 0;
		// the jump: (t, b < JB) -> (t, JB) for free on a floor
		if (refresh[t2] && b2 === JB) for (let b = 0; b < JB; b++) relax(t2 * S + b, v);
		// portals: (portal, any b) -> (exit, B)
		if (b2 === B && portalSources.has(t2)) for (const p of portalSources.get(t2)) for (let b = 0; b < S; b++) relax(p * S + b, v + 1);
		// moves into t2 from its 8 neighbours
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const x = x2 - dx, y = y2 - dy;   // the tile the move starts from
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const t = y * W + x;
				if (!passable(t)) continue;
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
				let best = fg[t] === TROPHY ? 0 : Infinity;
				const via = (k, c) => { if (cost[k] >= 0 && cost[k] + c < best) best = cost[k] + c; };
				if (refresh[t] && b < JB) via(t * S + JB, 0);
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
				const have = cost[t * S + b];
				if ((best === Infinity) !== (have < 0) || (have >= 0 && Math.abs(have - best) > 1e-3)) mismatches++;
			}
		}
	}
	const field = { W, H, B, JB, g: PX_GRAVITY * (level.gravityMult || 1), mode, goals, cls, own, refresh, cost, mismatches };
	return field;
}

/** the budget of a ball in tile i (centre y cy, vertical speed vy px/tick, on the ground or not), like the GPU */
function budgetAt(f, i, cy, vy, onGround) {
	const c = f.cls[i];
	let b = 0;
	if (vy < 0) {
		const r = Math.floor(cy / 16), top = cy - (vy * vy) / (2 * f.g);
		b = Math.min(f.B - 1, Math.max(0, r - Math.floor(top / 16)));
	}
	if (onGround && f.refresh[i]) b = Math.max(b, f.JB);
	if (c !== C_NORMAL) b = Math.max(b, f.own[i]);
	return b;
}
/** the cost to the trophy of a ball (top-left px, py; vertical speed; on the ground); -1 = unreachable */
function costAt(f, px, py, vy, onGround) {
	const cx = Math.trunc(px + 8) >> 4, cy = Math.trunc(py + 8) >> 4;
	if (cx < 0 || cy < 0 || cx >= f.W || cy >= f.H) return -1;
	const i = cy * f.W + cx;
	return f.cost[i * (f.B + 1) + budgetAt(f, i, py + 8, vy, onGround)];
}

/** eegpu's reach file: 'RCH1', W, H, B, JB (int32), g (float32), mode (int32: 0 physics, 1 walk), then cls, own,
 *  refresh (uint8 x N each, padded to 4), cost (float32 x N*(B+1)) */
function writeReachFile(f, file) {
	const N = f.W * f.H, pad = (n) => (n + 3) & ~3;
	const buf = Buffer.alloc(28 + 3 * pad(N) + 4 * N * (f.B + 1));
	buf.write('RCH1', 0, 'latin1');
	buf.writeInt32LE(f.W, 4); buf.writeInt32LE(f.H, 8); buf.writeInt32LE(f.B, 12); buf.writeInt32LE(f.JB, 16);
	buf.writeFloatLE(f.g, 20); buf.writeInt32LE(f.mode === 'walk' ? 1 : 0, 24);
	let o = 28;
	for (const a of [f.cls, f.own, f.refresh]) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, o); o += pad(N); }
	Buffer.from(f.cost.buffer, f.cost.byteOffset, f.cost.byteLength).copy(buf, o);
	fs.writeFileSync(file, buf);
}

module.exports = { reachField, costAt, budgetAt, writeReachFile, B, C_SOLID, C_NORMAL, C_ZEROV, C_UP, C_BOOSTUP, C_DEADLY };
