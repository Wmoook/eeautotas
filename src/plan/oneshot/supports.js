'use strict';
// THE ONE-SHOT COMPILER, part 1: SUPPORTS (n5-oneshot, 2026-09-30; src/out/n4plan/brief.md ADDENDUM 09:50 "ONE SHOT").
//
// Every STATE CLASS the ball can be in at a MOVE BOUNDARY, enumerated over the WHOLE level once, before any move is
// solved: the nodes of the one-shot move graph (part 2: every exact move between them; part 3: one Dijkstra over the
// graph x the trigger state). A move boundary is the moves study's (src/out/n4plan/understand/moves/moves.js): the tick
// the ball lands (G: this tick's move hit the floor of its pull), enters a field (W liquid, C climbable, Z dot, B boost),
// teleports, respawns, or touches a trigger.
//
//   buildSupports(L, o) -> S                     the enumeration (o.model: the level model of model.js, else built here)
//     S.surf     SURFACE supports, one record per (flip, pull direction, rest line, centre cell, condition), the exact set
//                of rest positions: the pull-axis coordinate is exact (the rest line: every landing ends on the last free
//                integer sub-step, and every blocker edge is a multiple of 8 px, so rest lines are multiples of 8), the
//                free-axis coordinate an interval [lo, hi] (px; each end open or closed: validity is constant on the points
//                8k and the open pieces (8k, 8k + 8) of the free axis, since tile, half-tile, centre-cell and world edges all
//                sit on multiples of 8). Pull directions: the CURRENT tile's int pull (morx, mory: Player.as, rotated by the
//                gravity effect's flip), which decides 'grounded' (eesim.js: a blocked step toward it): down = floors, up =
//                ceilings under up arrows / flip 2, left / right = walls under side arrows / flips 1 / 3 ("clinging").
//     S.spans    SURFACE SPANS: maximal runs of supported free-axis positions on one rest line (the walkable surfaces),
//                each end classified: WALL (the box is blocked there), DROP (a walk-off edge), PULL (the centre enters a
//                cell of another pull: a field boundary), COND (a door / one-way changes the condition), BORDER (the world)
//     S.fields   FIELD regions: 4-connected components of one physics class (dots, climbables, water, mud, lava, toxic,
//                boosts, arrows), their ENTRY cells (a field cell next to a passable cell of another class: the centre
//                moves at most one cell per axis a tick, so an entry is 8-adjacent) with the entry directions (8-bit mask),
//                and whether the ball can REST inside (dots, climbables: no pull; liquids / boosts / arrows: no rest)
//     S.portals  PORTAL EXITS: (exit cell, rotation difference d, the speed map d gives: 1.42 x rotated) with the entry
//                portal cells that lead there (random exits: several per entry); the ball stands at the exit's corner
//                (an exact integer position, eesim.js _portalTeleport) with its remaining sub-steps
//     S.triggers TRIGGER supports: every tile of every trigger of the model (coins, keys, switches, effects, checkpoints,
//                the trophy, ...) with its entry directions (the touch reads the centre cell at the tick's start)
//     S.respawns RESPAWN supports: every spawn / checkpoint (and the (1, 1) fallback): an exact state (x = 16 cx, y = 16 cy,
//                speeds 0, the effects the respawn clears)
//     S.flags    per surface support: EDGE (within a tile of a DROP end: the walk-off tick depends on the sub-pixel),
//                NEAR (a field / effect / portal / killer / trigger cell within NEAR_R cells: the entry offset decides the
//                ticks in it, docs/ee_math.md 2.8 / brief 09:45), BINADE (its free-axis interval crosses a power of two:
//                the offsets of the same inputs differ in the low bits, ee_math.md 2.5 THEOREM 4), HALF (a half-tile rest
//                line), ICE (ice under the box), KILL (the centre cell kills: a support only while protected), ONEWAY /
//                OWSPEED (a one-way holds it; for some velocity signs only), DOOR (a door holds it or its box needs one
//                open: the condition table), EXACT = EDGE | NEAR | BINADE (the sub-pixel classes are exact there)
//   classify(S, sim, o) -> {kind, id, ...}      the support class of an ENGINE STATE at a move boundary (null: in the air)
//   vclass(v) / VCLASS                           the speed classes: the run-up age (the least n ticks of a held key from
//                                                rest whose speed reaches |v|), geometric buckets, and over-speed buckets
//                                                past the running limit v* (boosts, portals, arrows)
//   keyOf(S, c, sim, level)                      the merge key of a classified state: level 0 (support, speed class),
//                                                1 (+ the aligned / unaligned sub-pixel class), 2 (the exact position and
//                                                speed where the support is EXACT), 3 (always exact)
//   stats(S) / bytesOf(S)                        the counts and the memory of the enumeration
//
// GENERAL: nothing here names a level; every rule is the engine's (eesim.js _ovAt / _ovSlow, _playerTick's pull tables,
// _portalTeleport, respawn). An OVER-approximation where the engine's one-way memory, the doors' state or the speed decide
// (the flags say where): the enumeration must hold every state a real route has (test: tools/oneshot/supcover.js replays
// the known routes and classifies every move boundary), and part 2's edges are verified by the engine anyway.
const E = require('../../eesim.js');

// the engine's flag tables (eesim.js buildFlags)
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const X_NONROT_HALF = 4;
const OV_AIR = 0, OV_SOLID = 1, OV_SECRET = 3;
const ICE = 1064, WATER = 119, MUD = 369, LAVA = 416, TOXIC = 1585, PORTAL = 242, PORTAL_INV = 381;
const EFFECT_GRAVITY = 1517;
const EFFECT_IDS = new Set([417, 418, 419, 420, 421, 422, 423, 453, 461, 1517, 1573, 1584, 1618]);
const ARROW_ID = new Map([[1, 'arrowL'], [411, 'arrowL'], [2, 'arrowU'], [412, 'arrowU'], [3, 'arrowR'], [413, 'arrowR'], [1518, 'arrowD'], [1519, 'arrowD']]);

// pull directions: the unit step of a blocked move toward the pull
const D_DOWN = 0, D_UP = 1, D_LEFT = 2, D_RIGHT = 3;
const DIR_NAMES = ['down', 'up', 'left', 'right'];
const DDX = [0, 0, -1, 1], DDY = [1, -1, 0, 0];

// surface support flags
const SF_EDGE = 1, SF_NEAR = 2, SF_BINADE = 4, SF_HALF = 8, SF_ICE = 16, SF_KILL = 32, SF_ONEWAY = 64, SF_OWSPEED = 128,
	SF_DOOR = 256, SF_OWIN = 512, SF_BORDER = 1024, SF_XPULL = 2048, SF_FXFLIP = 4096;
const SF_EXACT = SF_EDGE | SF_NEAR | SF_BINADE;
// span end kinds
const END_WALL = 0, END_DROP = 1, END_PULL = 2, END_COND = 3, END_BORDER = 4;
const END_NAMES = ['wall', 'drop', 'pull', 'cond', 'border'];
// near-field kinds (bits of the NEAR mask)
const NK_ARROW = 1, NK_DOT = 2, NK_CLIMB = 4, NK_LIQUID = 8, NK_BOOST = 16, NK_PORTAL = 32, NK_KILL = 64, NK_EFFECT = 128, NK_TRIGGER = 256, NK_ICE = 512;
const NEAR_R = 2;                  // cells: the centre crosses at most one cell per axis a tick (16 px cap), so a field
                                   // 2 cells out is at most 2 ticks away from a support's cell
// field classes
const FC_NAMES = ['dot', 'climb', 'water', 'mud', 'lava', 'toxic', 'boostL', 'boostR', 'boostU', 'boostD', 'arrowL', 'arrowU', 'arrowR', 'arrowD'];
const FC = {}; FC_NAMES.forEach((n, i) => { FC[n] = i; });
const FC_REST = new Set([FC.dot, FC.climb]);      // no pull there: the drag stops the ball (dots: only B while released)
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

// ------------------------------------------------------------------ speed classes
// The run-up table: R[n] = the speed after n ticks of one held key from rest in plain air (sm 1): R[n+1] = (R[n] + A) x B
// in doubles, the engine's own order (eesim.js _playerTick: sx = speed_x + modifier_x; sx *= BASE_DRAG). It converges to
// v* = 6.776552880470027 (ee_math.md 1.4). A speed's class is its RUN-UP AGE bucket: the geometric ages below, then
// over-speed buckets past v* (speeds a key cannot give: boosts 16, portals x 1.42, arrows, falls).
const MULT = E.constants.MULT, BASE_DRAG = E.constants.BASE_DRAG;
const RUN = (() => { const r = [0]; let v = 0; const A = 1 / MULT; for (let n = 1; n <= 2048; n++) { v = (v + A) * BASE_DRAG; r.push(v); } return r; })();
const VSTAR = RUN[RUN.length - 1];
const AGES = [1, 2, 3, 4, 6, 8, 11, 16, 22, 32, 45, 64, 90, 128, 181, 256, 362];
const VCLASS = (() => {
	const th = AGES.map((n) => RUN[n]);
	th.push(VSTAR - 1e-9, 8, 10, 12, 14, 16);
	const names = ['0+'];
	for (let i = 0; i < AGES.length; i++) names.push(`run${AGES[i]}`);
	names.push('v*', 'v8', 'v10', 'v12', 'v14', 'v16');
	return { th, names, n: th.length + 1 };
})();
/** the signed speed class of v: 0 = exactly 0, else sign x (1 + the bucket of |v|) */
function vclass(v) {
	if (v === 0) return 0;
	const a = Math.abs(v), th = VCLASS.th;
	let b = 0;
	while (b < th.length && th[b] <= a) b++;
	return v > 0 ? b + 1 : -(b + 1);
}
/** a speed class's name */
function vclassName(c) { return c === 0 ? '0' : (c > 0 ? '+' : '-') + VCLASS.names[Math.abs(c) - 1]; }

// ------------------------------------------------------------------ the level's static tables
function physOf(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, flags = L.flags;
	// the field class of every cell (-1 none)
	const fcls = new Int8Array(N).fill(-1);
	for (let i = 0; i < N; i++) {
		const id = fg[i], f = flags[id] | 0;
		let c = -1;
		if (id === 4 || id === 414) c = FC.dot;
		else if (f & F_CLIMB) c = FC.climb;
		else if (id === WATER) c = FC.water;
		else if (id === MUD) c = FC.mud;
		else if (id === LAVA) c = FC.lava;
		else if (id === TOXIC) c = FC.toxic;
		else if (id === 114) c = FC.boostL;
		else if (id === 115) c = FC.boostR;
		else if (id === 116) c = FC.boostU;
		else if (id === 117) c = FC.boostD;
		else if (ARROW_ID.has(id)) c = FC[ARROW_ID.get(id)];
		fcls[i] = c;
	}
	return { W, H, N, fcls };
}

/** the flip states the ball can hold: 0, and the gravity effects' numbers (EFFECT_GRAVITY sets flip_gravity to its number) */
function flipsOf(L) {
	const s = new Set([0]);
	const N = L.width * L.height;
	for (let i = 0; i < N; i++) if (L.fg[i] === EFFECT_GRAVITY) { const v = L.lookup0[i] | 0; if (v >= 0 && v <= 4) s.add(v); }
	return [...s].sort((a, b) => a - b);
}

/** the centre cell of a box at (x, y) and its current tile, the half-block rule applied (eesim.js _playerTick: rot 1 and
 *  presents up one, rot 0 left one) -> {cx, cy, cur} */
function centreOf(L, x, y) {
	const W = L.width, H = L.height, fg = L.fg;
	let cx = Math.trunc(x + 8) >> 4, cy = Math.trunc(y + 8) >> 4;
	let cur = cx >= 0 && cy >= 0 && cx < W && cy < H ? fg[cy * W + cx] : 0;
	if ((L.flags[cur] & F_HALF) !== 0) {
		let rot = cx >= 0 && cy >= 0 && cx < W && cy < H ? L.lookup0[cy * W + cx] : 0;
		if ((L.xflags[cur] & X_NONROT_HALF) !== 0) rot = 1;
		if (rot === 1) cy -= 1;
		if (rot === 0) cx -= 1;
		cur = cx >= 0 && cy >= 0 && cx < W && cy < H ? fg[cy * W + cx] : 0;
	}
	return { cx, cy, cur };
}

/** the int pull (morx, mory) of tile id under flip f (eesim.js _playerTick's tables and switch) -> direction or -1 */
function pullDir(L, id, f) {
	let morx = L.gMorx[id], mory = L.gMory[id];
	if ((L.gFlags[id] & 1) !== 0) {
		if (f === 1) { const t = morx; morx = -mory; mory = t; }
		else if (f === 2) { morx = -morx; mory = -mory; }
		else if (f === 3) { const t = morx; morx = mory; mory = -t; }
		else if (f === 4) { morx = 0; mory = 0; }
	}
	if (mory > 0 && morx === 0) return D_DOWN;
	if (mory < 0 && morx === 0) return D_UP;
	if (morx < 0 && mory === 0) return D_LEFT;
	if (morx > 0 && mory === 0) return D_RIGHT;
	return -1;
}

// ------------------------------------------------------------------ the box probe (World.overlaps without state)
/**
 * The box at (x, y) as the engine's overlaps() sees it, without the one-way memory, the speeds or the doors' state:
 * returns 1 when a STATIC blocker overlaps it (a solid, a half block's solid half, the secret block 50, the world's
 * border), else 0 and fills `out`: out.doors (door cells overlapped), out.ow (one-way cells overlapped, with their pass
 * direction: plain one-ways and rot 1 pass up, rot 2 right, rot 3 down, rot 0 left: eesim.js _ovSlow).
 */
function makeProbe(L) {
	const W = L.width, H = L.height, maxX = W * 16 - 16, maxY = H * 16 - 16;
	const ovl = L.ovl, fg = L.fg, flags = L.flags, lk = L.lookup0;
	const out = { nd: 0, doors: new Int32Array(8), no: 0, ow: new Int32Array(8), owPass: new Int8Array(8) };
	function probe(x, y) {
		out.nd = 0; out.no = 0;
		if (x < 0 || y < 0 || x > maxX || y > maxY) return 1;
		const ox = (x | 0) >> 4, oy = (y | 0) >> 4;
		const cxEnd = ox + 1 + ((x + 16.0) > (ox * 16 + 16) ? 1 : 0);
		const cyEnd = oy + 1 + ((y + 16.0) > (oy * 16 + 16) ? 1 : 0);
		for (let cy = oy; cy < cyEnd; cy++) {
			const row = cy * W;
			for (let cx = ox; cx < cxEnd; cx++) {
				const i = row + cx, k = ovl[i];
				if (k === OV_AIR || k === OV_SECRET) continue;
				if (k === OV_SOLID) return 1;
				const val = fg[i], fl = flags[val];
				if ((fl & (F_ROTHALF | F_HALF | F_JUMPTHRU)) !== 0) {
					if ((fl & F_ROTHALF) !== 0) {
						if ((fl & F_JUMPTHRU) !== 0) {
							const rot = lk[i];
							const pass = rot === 1 ? D_UP : rot === 2 ? D_RIGHT : rot === 3 ? D_DOWN : rot === 0 ? D_LEFT : -1;
							if (pass < 0) return 1;             // a rotation none of the four: never passes (eesim.js)
							if (out.no < 8) { out.ow[out.no] = i; out.owPass[out.no] = pass; out.no++; }
							continue;
						}
					} else if ((fl & F_HALF) !== 0) {
						const tlx = cx * 16, tly = cy * 16, rot = lk[i];
						let hit;
						if (rot === 1) hit = x < tlx + 16 && tlx < x + 16 && y < tly + 16 && tly + 8 < y + 16;
						else if (rot === 2) hit = x < tlx + 8 && tlx < x + 16 && y < tly + 16 && tly < y + 16;
						else if (rot === 3) hit = x < tlx + 16 && tlx < x + 16 && y < tly + 8 && tly < y + 16;
						else if (rot === 0) hit = x < tlx + 16 && tlx + 8 < x + 16 && y < tly + 16 && tly < y + 16;
						else hit = true;
						if (!hit) continue;
						return 1;
					} else {
						if (out.no < 8) { out.ow[out.no] = i; out.owPass[out.no] = D_UP; out.no++; }
						continue;
					}
				}
				if ((fl & F_DOOR) !== 0) {
					if (val === 50) return 1;              // the secret block: revealed and blocking in every state
					if (out.nd < 8) out.doors[out.nd++] = i;
					continue;
				}
				return 1;
			}
		}
		return 0;
	}
	return { probe, out, maxX, maxY };
}

// ------------------------------------------------------------------ conditions (doors, one-ways)
function condTable() {
	const byKey = new Map([['', 0]]);
	const list = [{ open: [], shut: [] }];
	return {
		list,
		id(open, shut) {
			if (!open.length && !shut.length) return 0;
			open.sort((a, b) => a - b); shut.sort((a, b) => a - b);
			const k = open.join(',') + '|' + shut.join(',');
			let id = byKey.get(k);
			if (id === undefined) { id = list.length; list.push({ open: open.slice(), shut: shut.slice() }); byKey.set(k, id); }
			return id;
		},
	};
}

// ------------------------------------------------------------------ growable typed columns
function cols(spec, cap = 1024) {
	const C = { n: 0, cap };
	for (const [k, T] of spec) C[k] = new T(cap);
	C.push = function (vals) {
		if (C.n === C.cap) {
			C.cap *= 2;
			for (const [k, T] of spec) { const a = new T(C.cap); a.set(C[k]); C[k] = a; }
		}
		const j = C.n++;
		for (const [k] of spec) C[k][j] = vals[k];
		return j;
	};
	C.trim = function () { for (const [k, T] of spec) C[k] = C[k].slice(0, C.n); C.cap = C.n; delete C.push; delete C.trim; return C; };
	return C;
}
const SURF_SPEC = [['flip', Uint8Array], ['dir', Uint8Array], ['rest', Int32Array], ['lo', Int32Array], ['hi', Int32Array],
	['closed', Uint8Array], ['cell', Int32Array], ['span', Int32Array], ['cond', Int32Array], ['flags', Uint16Array], ['near', Uint16Array]];
const SPAN_SPEC = [['flip', Uint8Array], ['dir', Uint8Array], ['rest', Int32Array], ['lo', Int32Array], ['hi', Int32Array],
	['closed', Uint8Array], ['endLo', Uint8Array], ['endHi', Uint8Array], ['first', Int32Array], ['count', Int32Array], ['cond', Int32Array]];

// ------------------------------------------------------------------ the enumeration
/**
 * buildSupports(L, o) -> S (see the header). o.model: model.js compileModel(L) (its triggers, gates, respawns), else it
 * is built here; o.flips: the flip states to enumerate (default: 0 and the level's gravity effects).
 */
function buildSupports(L, o = {}) {
	const t0 = process.hrtime.bigint();
	const W = L.width, H = L.height, N = W * H, fg = L.fg, flags = L.flags;
	const P = physOf(L);
	const { probe, out, maxX, maxY } = makeProbe(L);
	const flips = o.flips || flipsOf(L);
	const conds = condTable();
	const surf = cols(SURF_SPEC, 4096), spans = cols(SPAN_SPEC, 1024);

	// near-field mask per cell (the kinds within NEAR_R cells) and the static kinds
	let model = o.model || null;
	if (!model) { const MD = require('../model.js'); model = MD.compileModel(L, {}); }
	const kindAt = new Uint16Array(N);
	for (let i = 0; i < N; i++) {
		const id = fg[i], c = P.fcls[i];
		let k = 0;
		if (c >= FC.arrowL) k |= NK_ARROW;
		else if (c === FC.dot) k |= NK_DOT;
		else if (c === FC.climb) k |= NK_CLIMB;
		else if (c >= FC.water && c <= FC.toxic) k |= NK_LIQUID;
		else if (c >= FC.boostL && c <= FC.boostD) k |= NK_BOOST;
		if (id === PORTAL || id === PORTAL_INV) k |= NK_PORTAL;
		if ((L.gFlags[id] & 4) !== 0) k |= NK_KILL;
		if (EFFECT_IDS.has(id)) k |= NK_EFFECT;
		if (id === ICE) k |= NK_ICE;
		kindAt[i] = k;
	}
	for (const X of model.triggers) for (const t of X.tiles) kindAt[t] |= NK_TRIGGER;
	const nearAt = new Uint16Array(N);
	{
		// separable max-filter (OR) over a (2 NEAR_R + 1)^2 window
		const tmp = new Uint16Array(N);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let m = 0;
			for (let dx = -NEAR_R; dx <= NEAR_R; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) m |= kindAt[y * W + xx]; }
			tmp[y * W + x] = m;
		}
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let m = 0;
			for (let dy = -NEAR_R; dy <= NEAR_R; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) m |= tmp[yy * W + x]; }
			nearAt[y * W + x] = m;
		}
	}

	const centre = (x, y) => centreOf(L, x, y);
	// per flip: the pull directions present in each cell's 3 x 3 (a tick-start centre that can bring the ball here)
	const pullNear = [];
	for (let f = 0; f <= 4; f++) {
		if (!flips.includes(f)) { pullNear.push(null); continue; }
		const own = new Uint8Array(N), near = new Uint8Array(N);
		for (let i = 0; i < N; i++) { const pd = pullDir(L, fg[i], f); if (pd >= 0) own[i] = 1 << pd; }
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let m = 0;
			for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) m |= own[yy * W + xx]; } }
			near[y * W + x] = m;
		}
		pullNear.push(near);
	}

	// one piece of a rest line: validity and its condition
	const pc = { valid: false, cell: -1, cond: 0, fl: 0, end: END_WALL };
	const doorsIn = [], doorsOut = [], owOut = [], owIn = [];
	function piece(f, d, px, py) {
		pc.valid = false; pc.cell = -1; pc.cond = 0; pc.fl = 0;
		// the rest box itself
		if (probe(px, py) === 1) { pc.end = (px < 0 || py < 0 || px > maxX || py > maxY) ? END_BORDER : END_WALL; return pc; }
		doorsIn.length = 0; owIn.length = 0;
		for (let k = 0; k < out.nd; k++) doorsIn.push(out.doors[k]);
		for (let k = 0; k < out.no; k++) owIn.push(out.ow[k]);
		let fl = 0;
		if (out.no > 0) fl |= SF_OWIN;
		// the pull at the centre
		const c = centre(px, py);
		const pd = pullDir(L, c.cur, f);
		// the step toward the pull
		const qx = px + DDX[d], qy = py + DDY[d];
		const b = probe(qx, qy);
		doorsOut.length = 0; owOut.length = 0;
		let blocked = b === 1;
		if (!blocked) {
			for (let k = 0; k < out.nd; k++) doorsOut.push(out.doors[k]);
			let ow = false, owSpeed = false;
			for (let k = 0; k < out.no; k++) {
				const pass = out.owPass[k];
				if (pass === d) continue;                                 // moving along its pass direction: passes
				if (owIn.includes(out.ow[k])) continue;                   // already overlapped: the one-way memory lets it through
				ow = true;
				if ((pass ^ 1) !== d) owSpeed = true;                     // across it: holds only for some speed signs
			}
			if (ow) { fl |= SF_ONEWAY; if (owSpeed) fl |= SF_OWSPEED; }
			blocked = ow || doorsOut.length > 0;
		}
		if (!blocked) { pc.end = END_DROP; return pc; }
		if (pd !== d) {
			// the centre's own pull is another: grounded only on the tick that brings the centre here from a cell of pull d
			// (the tick-start current tile decides 'grounded'; the centre moves at most one cell per axis a tick)
			const cc = (c.cx >= 0 && c.cy >= 0 && c.cx < W && c.cy < H) ? c.cy * W + c.cx : -1;
			if (cc < 0 || !((pullNear[f][cc] >> d) & 1)) { pc.end = END_PULL; return pc; }
			fl |= SF_XPULL;
		}
		// valid: the condition (doors the box needs open; doors the support needs shut when nothing else holds it)
		const shut = (b === 1 || (fl & SF_ONEWAY)) ? [] : doorsOut.slice();
		const open = doorsIn.slice();
		pc.cond = conds.id(open, shut);
		if (pc.cond !== 0) fl |= SF_DOOR;
		if ((L.gFlags[c.cur] & 4) !== 0) fl |= SF_KILL;
		// a gravity effect of another flip at the centre: its touch turns gravity at the end of the tick (transitional)
		if (c.cur === EFFECT_GRAVITY && (L.lookup0[c.cy * W + c.cx] | 0) !== f) fl |= SF_FXFLIP;
		pc.valid = true; pc.cell = (c.cx >= 0 && c.cy >= 0 && c.cx < W && c.cy < H) ? c.cy * W + c.cx : -1;
		pc.fl = fl;
		return pc;
	}

	// the lines: for d down / up a rest y (multiple of 8) and the x pieces; for left / right a rest x and the y pieces
	const binadeCross = (lo, hi) => { for (let p = 16; p <= 65536; p *= 2) if (lo < p && p < hi) return true; return false; };
	const isIce = (px, py, d) => {
		// the tile below (the pull's side) under the box's centre column / row: eesim _getCurrentBelow reads the centre's
		// neighbour in the pull direction
		const c = centre(px, py), bx = c.cx + DDX[d], by = c.cy + DDY[d];
		return bx >= 0 && by >= 0 && bx < W && by < H && fg[by * W + bx] === ICE;
	};
	let pieces = 0;
	for (const f of flips) {
		for (let d = 0; d < 4; d++) {
			const vert = d === D_DOWN || d === D_UP;
			const nLines = vert ? (maxY / 8) + 1 : (maxX / 8) + 1;
			const nFree = vert ? (maxX / 8) : (maxY / 8);           // points 0..nFree (x 8k), pieces between
			for (let li = 0; li < nLines; li++) {
				const rest = li * 8;
				// quick reject: the step toward the pull must leave the box free or meet something; nothing in the row /
				// column the step enters -> no support on this line
				{
					const nb = vert ? (d === D_DOWN ? ((rest + 16) >> 4) : ((rest - 1) >> 4)) : (d === D_RIGHT ? ((rest + 16) >> 4) : ((rest - 1) >> 4));
					if (vert ? (nb >= 0 && nb < H && !rowHasBlocker(L, nb)) : (nb >= 0 && nb < W && !colHasBlocker(L, nb))) continue;
				}
				// walk the free axis: 2 nFree + 1 pieces (points at 8k, open pieces (8k, 8k + 8))
				let cur = null;                  // the open cell support {lo, loC, cell, cond, fl, first}
				let span = null;                 // the open span
				const nP = 2 * nFree + 1;
				const closeCell = (hi, hiC) => {
					if (!cur) return;
					const s = cur;
					const rec = { flip: f, dir: d, rest, lo: s.lo, hi, closed: (s.loC ? 1 : 0) | (hiC ? 2 : 0), cell: s.cell, span: spans.n, cond: s.cond, flags: s.fl, near: s.cell >= 0 ? nearAt[s.cell] : 0 };
					if (rec.near & ~NK_TRIGGER) rec.flags |= SF_NEAR;      // (triggers: their own supports; NEAR is about physics)
					if (binadeCross(s.lo, hi)) rec.flags |= SF_BINADE;
					if (rest % 16 !== 0) rec.flags |= SF_HALF;
					surf.push(rec);
					span.count++;
					cur = null;
				};
				const closeSpan = (hi, hiC, endHi) => {
					if (!span) return;
					const S1 = span;
					const j = spans.push({ flip: f, dir: d, rest, lo: S1.lo, hi, closed: (S1.loC ? 1 : 0) | (hiC ? 2 : 0), endLo: S1.endLo, endHi, first: S1.first, count: S1.count, cond: S1.cond });
					// EDGE: the cell supports within 16 px of a DROP end
					for (let r = S1.first; r < S1.first + S1.count; r++) {
						if ((S1.endLo === END_DROP && surf.lo[r] < S1.lo + 16) || (endHi === END_DROP && surf.hi[r] > hi - 16)) surf.flags[r] |= SF_EDGE;
						if (S1.endLo === END_BORDER || endHi === END_BORDER) surf.flags[r] |= SF_BORDER;
						surf.span[r] = j;
					}
					span = null;
				};
				let lastEnd = END_BORDER;
				for (let k = 0; k < nP; k++) {
					const pos = k * 4;                               // the point 8(k/2) or the open piece's middle 8 floor(k/2) + 4
					const isPoint = (k & 1) === 0;
					const px = vert ? pos : rest, py = vert ? rest : pos;
					pieces++;
					const q = piece(f, d, px, py);
					if (q.valid) {
						let fl = q.fl;
						if (isIce(px, py, d)) fl |= SF_ICE;
						const lo = isPoint ? pos : pos - 4;
						const xp = (fl & SF_XPULL) !== 0;
						if (cur && (cur.cell !== q.cell || cur.cond !== q.cond || cur.fl !== fl)) closeCell(lo, !isPoint ? true : false);
						if (span && span.cond !== q.cond) { closeSpan(lo, !isPoint, END_COND); lastEnd = END_COND; }
						if (span && span.xp !== xp) { closeSpan(lo, !isPoint, END_PULL); lastEnd = END_PULL; }
						if (!span) span = { lo, loC: isPoint, endLo: lastEnd, first: surf.n, count: 0, cond: q.cond, xp };
						if (!cur) cur = { lo, loC: isPoint, cell: q.cell, cond: q.cond, fl };
					} else {
						const hi = isPoint ? pos : pos - 4;
						// an invalid point closes the run open at it; an invalid open piece closes it at its left end, closed
						closeCell(hi, !isPoint);
						closeSpan(hi, !isPoint, q.end);
						lastEnd = q.end;
					}
				}
				const endPos = 2 * nFree * 4;
				closeCell(endPos, true);
				closeSpan(endPos, true, END_BORDER);
			}
		}
	}
	surf.trim(); spans.trim();

	// per centre cell: its surface supports (for classify)
	const cellHead = new Int32Array(N + 1);
	for (let r = 0; r < surf.n; r++) if (surf.cell[r] >= 0) cellHead[surf.cell[r] + 1]++;
	for (let i = 0; i < N; i++) cellHead[i + 1] += cellHead[i];
	const cellList = new Int32Array(cellHead[N]);
	{ const fill = cellHead.slice(0, N); for (let r = 0; r < surf.n; r++) if (surf.cell[r] >= 0) cellList[fill[surf.cell[r]]++] = r; }

	// ---------------------------------------------------------------- FIELD regions
	const regOf = new Int32Array(N).fill(-1);
	const fields = [];
	const passable = (i) => L.ovl[i] !== OV_SOLID;     // static solids never hold the centre; complex tiles may (doors open, one-ways, halves)
	for (let i = 0; i < N; i++) {
		const c = P.fcls[i];
		if (c < 0 || regOf[i] >= 0) continue;
		const id = fields.length, cells = [i];
		regOf[i] = id;
		for (let q = 0; q < cells.length; q++) {
			const t = cells[q], x = t % W, y = (t / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (regOf[j] >= 0 || P.fcls[j] !== c) continue;
				regOf[j] = id; cells.push(j);
			}
		}
		cells.sort((a, b) => a - b);
		const entries = [], entryDirs = [];
		for (const t of cells) {
			const x = t % W, y = (t / W) | 0;
			let m = 0;
			for (let k = 0; k < 8; k++) {
				const nx = x + DX8[k], ny = y + DY8[k];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (P.fcls[j] === c || !passable(j)) continue;
				m |= 1 << k;                              // entered from neighbour k
			}
			if (m) { entries.push(t); entryDirs.push(m); }
		}
		fields.push({ id, cls: c, name: FC_NAMES[c], cells: Int32Array.from(cells), entries: Int32Array.from(entries), entryDirs: Uint8Array.from(entryDirs), rest: FC_REST.has(c) });
	}

	// ---------------------------------------------------------------- PORTAL exits
	const portals = [];
	{
		const byKey = new Map();
		for (let i = 0; i < N; i++) {
			if (fg[i] !== PORTAL && fg[i] !== PORTAL_INV) continue;
			const s = L.portalSlot[i];
			if (s < 0 || L.pTarget[s] === L.pId[s]) continue;          // no entry, or a self-target: never teleports
			const T = L.portalsById.get(L.pTarget[s]);
			if (!T || !(T.n > 0)) continue;
			let oldRot = L.pRot[s];
			for (let k = 0; k < T.n; k++) {
				const ex = T.xs[k] >> 4, ey = T.ys[k] >> 4, e = ey * W + ex;
				const ns = L.portalSlot[e];
				const newRot = ns >= 0 ? L.pRot[ns] : 0;
				let or = oldRot; if (or < newRot) or += 4;
				const dr = or - newRot;
				const key = e * 8 + dr;
				let rec = byKey.get(key);
				if (!rec) { rec = { exit: e, x: T.xs[k], y: T.ys[k], d: dr, entries: [], random: false }; byKey.set(key, rec); portals.push(rec); }
				rec.entries.push(i);
				if (T.n > 1) rec.random = true;
			}
		}
		portals.sort((a, b) => a.exit - b.exit || a.d - b.d);
		portals.forEach((p, j) => { p.id = j; p.entries = Int32Array.from(p.entries); });
	}
	const portalAt = new Map();
	for (const p of portals) { if (!portalAt.has(p.exit)) portalAt.set(p.exit, []); portalAt.get(p.exit).push(p.id); }

	// ---------------------------------------------------------------- TRIGGERS
	const triggers = [];
	const trigAt = new Int32Array(N).fill(-1);
	for (const X of model.triggers) {
		const dirs = [];
		for (const t of X.tiles) {
			const x = t % W, y = (t / W) | 0;
			let m = 0;
			for (let k = 0; k < 8; k++) {
				const nx = x + DX8[k], ny = y + DY8[k];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (!passable(j)) continue;
				m |= 1 << k;
			}
			dirs.push(m);
			trigAt[t] = triggers.length;
		}
		triggers.push({ id: triggers.length, model: X.id, kind: X.kind, label: X.label, relevant: !!X.relevant, tiles: Int32Array.from(X.tiles), entryDirs: Uint8Array.from(dirs) });
	}

	// ---------------------------------------------------------------- RESPAWNS
	const respawns = [];
	const respAt = new Map();
	{
		const add = (i, kind) => {
			if (respAt.has(i)) return;
			respAt.set(i, respawns.length);
			respawns.push({ id: respawns.length, cell: i, kind, x: (i % W) * 16, y: ((i / W) | 0) * 16 });
		};
		for (const t of model.spawnTiles || []) add(t, 'spawn');
		for (const t of model.respawn || []) add(t, fg[t] === 360 ? 'checkpoint' : 'spawn');
	}

	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const S = {
		L, W, H, N, flips, surf, spans, conds: conds.list, cellHead, cellList, fields, regOf, portals, portalAt, triggers, trigAt,
		respawns, respAt, nearAt, kindAt, fcls: P.fcls, pieces, ms,
	};
	S.stats = stats(S);
	return S;
}

const blockerCache = new WeakMap();
/** rows / columns holding anything a box can meet (a non-air overlap class): the lines' quick reject */
function blockers(L) {
	let b = blockerCache.get(L);
	if (b) return b;
	const W = L.width, H = L.height, row = new Uint8Array(H), col = new Uint8Array(W);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = L.ovl[y * W + x]; if (k !== OV_AIR && k !== OV_SECRET) { row[y] = 1; col[x] = 1; } }
	b = { row, col };
	blockerCache.set(L, b);
	return b;
}
function rowHasBlocker(L, y) { return blockers(L).row[y] === 1; }
function colHasBlocker(L, x) { return blockers(L).col[x] === 1; }

// ------------------------------------------------------------------ classify an engine state
/** the surface supports by line: key `${flip * 4 + dir}:${rest}` -> record ids (made on first use) */
function lineIndex(S) {
	if (S._lines) return S._lines;
	const m = new Map(), sf = S.surf;
	for (let r = 0; r < sf.n; r++) {
		const k = sf.flip[r] * 4 + sf.dir[r] + ':' + sf.rest[r];
		let a = m.get(k);
		if (!a) { a = []; m.set(k, a); }
		a.push(r);
	}
	S._lines = m;
	return m;
}

const FIELD_LETTER = (fc) => (fc === FC.dot ? 'Z' : fc === FC.climb ? 'C' : (fc >= FC.water && fc <= FC.toxic) ? 'W' : (fc >= FC.boostL && fc <= FC.boostD) ? 'B' : 'A');

/**
 * classify(S, sim, o) -> the support class of an engine state at a move boundary, or {kind: 'air'} when the state is on
 * no support. o.teleported (the tick teleported), o.touched (the tile the tick's touch read, types.js touchedTile),
 * o.prevCls (the class letter before this tick: a field ENTRY vs a stay). Kinds:
 *   'dead'     dead (the respawn is 54 ticks away): {respawn: the respawn support the checkpoint picks, if known}
 *   'portal'   teleported this tick: {id: the portal exit support}
 *   'field'    the centre in a field of class W / C / Z / B: {id: region, cell, entry: a boundary cell}
 *   'surf'     grounded: {id: the surface support whose rest line and interval hold the ball}
 *   'trigger'  on a trigger's tile (the touch tile) in the air
 *   'air'      none of these
 * `miss` is set when the state claims a support the enumeration lacks (grounded with no surface support, a teleport to no
 * exit): the enumeration's completeness test.
 */
function classify(S, sim, o = {}) {
	const L = S.L, W = S.W, H = S.H;
	if (sim.is_dead) return { kind: 'dead' };
	const x = sim.px, y = sim.py;
	const cx = Math.trunc(x + 8) >> 4, cy = Math.trunc(y + 8) >> 4;
	if (o.teleported) {
		// the exit the ball was put on: its corner is the teleport position (eesim.js _portalTeleport), the rest of the
		// tick's sub-steps (rotated, x 1.42: up to 22.72 px an axis) moved it from there: the nearest exit corner within
		// 24 px an axis
		const ids = [];
		let best = -1, bestD = Infinity;
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const ex = cx + dx, ey = cy + dy;
			if (ex < 0 || ey < 0 || ex >= W || ey >= H) continue;
			const l = S.portalAt.get(ey * W + ex);
			if (!l) continue;
			const ddx = Math.abs(x - ex * 16), ddy = Math.abs(y - ey * 16);
			if (ddx > 24 || ddy > 24) continue;
			for (const id of l) { ids.push(id); if (ddx + ddy < bestD) { bestD = ddx + ddy; best = id; } }
		}
		if (best >= 0) return { kind: 'portal', id: best, ids, dist: bestD };
		return { kind: 'portal', id: -1, miss: 'no portal exit near the teleported ball' };
	}
	// the current tile (after the half-block rule): the engine's own
	const cur = sim.current_tile;
	const curCell = (sim._pastx !== undefined && sim._pastx >= 0 && sim._pasty >= 0 && sim._pastx < W && sim._pasty < H) ? sim._pasty * W + sim._pastx : ((cx >= 0 && cy >= 0 && cx < W && cy < H) ? cy * W + cx : -1);
	const fl = L.flags[cur] | 0;
	const fcCur = (cur === 4 || cur === 414) ? FC.dot : (fl & F_CLIMB) ? FC.climb : cur === WATER ? FC.water : cur === MUD ? FC.mud : cur === LAVA ? FC.lava : cur === TOXIC ? FC.toxic : (cur >= 114 && cur <= 117) ? FC.boostL + (cur - 114) : -1;
	if (fcCur >= 0) {
		// the region of the centre cell (the half-block rule can move the current tile off the plain centre cell)
		let cell = -1, reg = -1;
		// (the tick-start cell first: the class letter is the tick-start current tile's, the entry is made there)
		for (const c of [curCell, cy * W + cx]) {
			if (c >= 0 && c < S.N && S.regOf[c] >= 0 && S.fields[S.regOf[c]].cls === fcCur) { cell = c; reg = S.regOf[c]; break; }
		}
		if (reg < 0) return { kind: 'field', id: -1, letter: FIELD_LETTER(fcCur), miss: 'field tile outside every region' };
		const R = S.fields[reg];
		let entry = false;
		{ let lo = 0, hi = R.entries.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (R.entries[m] === cell) { entry = true; break; } if (R.entries[m] < cell) lo = m + 1; else hi = m - 1; } }
		return { kind: 'field', id: reg, cell, entry, letter: FIELD_LETTER(fcCur) };
	}
	if (sim.on_ground) {
		const f = sim.flip_gravity | 0;
		// the pull that made it grounded: the tick-start current tile's int pull (the engine's morx / mory of this tick);
		// the support's own pull is its rest cell's (the next tick's): they differ only on a landing across a pull border
		const cE = centreOf(L, x, y);
		const endCell = (cE.cx >= 0 && cE.cy >= 0 && cE.cx < W && cE.cy < H) ? cE.cy * W + cE.cx : -1;
		// (flip, dir) pairs: the state's flip first; a gravity effect touched this tick changed the flip at the tick's end,
		// after the move that grounded the ball under the tick-start flip: the level's other flips after
		const pairs = [];
		const d0 = pullDir(L, cur, f), d1 = pullDir(L, cE.cur, f);
		for (const ff of [f, ...S.flips.filter((v) => v !== f)]) {
			const a = pullDir(L, cur, ff), b = pullDir(L, cE.cur, ff);
			if (a >= 0) pairs.push([ff, a]);
			if (b >= 0 && b !== a) pairs.push([ff, b]);
			if (ff === f && pairs.length) pairs.push(null);             // the state's own flip is a pass of its own
		}
		const dirs = pairs.filter(Boolean).map((p) => p[1]);
		if (!dirs.length) return { kind: 'surf', id: -1, miss: `grounded with no pull (tile ${cur}, flip ${f})`, why: 'nopull' };
		const sf = S.surf;
		const lines = lineIndex(S);
		// the grounded tick's block happened at a REST position; the state after the tick can be (1) that position, (2) it
		// moved by the auto-align (< 0.2 px on the free axis, |v| < 1), or (3) a GRAZE: the pull-axis step was blocked at a
		// corner, the free axis moved on and the retried pull-axis steps moved past the corner (eesim.js: a blocked axis's
		// step is retried every later iteration while the other axis moves): the pull-axis coordinate up to 16 px past the
		// rest line, the free axis up to the tick's free-axis move past the support's interval (a walk-off / ledge edge)
		const own = pairs.slice(0, pairs.indexOf(null) < 0 ? pairs.length : pairs.indexOf(null)), other = pairs.slice(own.length + 1).filter(Boolean);
		for (const [how, group] of [['exact', own], ['align', own], ['graze', own], ['exact', other], ['align', other], ['graze', other]]) {
			let best = -1, bestD = Infinity, bestDir = -1, bestFlip = f;
			for (const [ff, d] of group) {
				const vert = d === D_DOWN || d === D_UP;
				const p = vert ? y : x, q = vert ? x : y, vq = vert ? sim.speed_x : sim.speed_y;
				const sgn = (d === D_DOWN || d === D_RIGHT) ? 1 : -1;
				let rests, slack;
				if (how === 'exact') { if (p % 8 !== 0) continue; rests = [p]; slack = 0; }
				else if (how === 'align') { if (p % 8 !== 0 || Math.abs(vq) >= 1) continue; rests = [p]; slack = 0.2; }
				else {
					const g = sgn > 0 ? Math.floor(p / 8) * 8 : Math.ceil(p / 8) * 8;
					rests = [g, g - 8 * sgn, g - 16 * sgn].filter((r) => Math.abs(p - r) <= 16.5);
					slack = Math.abs(vq) + 1.25;
				}
				for (const r0 of rests) {
					const ids = lines.get(ff * 4 + d + ':' + r0);
					if (!ids) continue;
					for (const r of ids) {
						const lo = sf.lo[r], hi = sf.hi[r], cl = sf.closed[r];
						let dist;
						if ((q > lo || (q === lo && (cl & 1))) && (q < hi || (q === hi && (cl & 2)))) dist = 0;
						else dist = Math.max(1e-9, q <= lo ? lo - q : q - hi);
						if (dist > slack) continue;
						const tot = dist + Math.abs(p - r0);
						if (tot < bestD) { bestD = tot; best = r; bestDir = d; bestFlip = ff; }
					}
				}
			}
			if (best >= 0) return { kind: 'surf', id: best, dir: bestDir, how: how + (bestFlip !== f ? '.flip' : ''), dist: bestD, pullEdge: bestFlip === f && bestDir !== d0 };
		}
		const d = dirs[0], vert = d === D_DOWN || d === D_UP;
		const why = (vert ? y : x) % 8 !== 0 ? 'offline' : d1 !== d0 ? 'pullborder' : 'nosupport';
		return { kind: 'surf', id: -1, dir: d, why, miss: `grounded ${DIR_NAMES[d]} at (${x}, ${y}) flip ${f} cell ${endCell}: no surface support (${why})` };
	}
	if (o.touched !== undefined && o.touched >= 0 && S.trigAt[o.touched] >= 0) return { kind: 'trigger', id: S.trigAt[o.touched], cell: o.touched };
	return { kind: 'air' };
}

/**
 * keyOf(S, c, sim, level) -> the merge key of a classified state (a string). level 0: the support and the speed classes;
 * 1: + the sub-pixel class (aligned to the tile grid on the free axis, or its 1/16 px bucket); 2: exact (the free-axis
 * position and both speeds as doubles) where the support is EXACT (edges, near fields, binade edges), else level 1;
 * 3: exact everywhere.
 */
function keyOf(S, c, sim, level = 2) {
	if (!c || c.kind === 'air' || c.kind === 'dead') return c ? c.kind : 'none';
	const vx = sim.speed_x, vy = sim.speed_y;
	const base = `${c.kind}:${c.id}${c.cell !== undefined ? ':' + c.cell : ''}:${vclass(vx)},${vclass(vy)}`;
	if (level === 0) return base;
	let exact = level >= 3;
	if (level === 2 && c.kind === 'surf' && c.id >= 0 && (S.surf.flags[c.id] & SF_EXACT)) exact = true;
	if (level === 2 && c.kind === 'portal') exact = true;
	if (level === 2 && c.kind === 'field' && c.entry) exact = true;
	if (exact) return `${base}|${sim.px},${sim.py},${vx},${vy}`;
	const vert = c.kind === 'surf' ? (c.dir === D_DOWN || c.dir === D_UP) : true;
	const free = vert ? sim.px : sim.py;
	const f16 = free - 16 * Math.floor(free / 16);
	return `${base}|${f16 === 0 ? 'A' : Math.floor(f16 * 16)}`;
}

// ------------------------------------------------------------------ the supports as part 2's records (edges.js o.supports)
/**
 * edgeSupports(S, o) -> [{i, tile, cls, vc, kind: 'start' | 'rest', px, py, sup: {kind, id}}]: the records
 * src/plan/oneshot/edges.js takes as o.supports (its index 0 the level's start). One REST representative per surface
 * support (flip 0: edges.js places from the start state; XPULL supports are grounded only on an arriving tick: none), per
 * field entry cell, per respawn: the ball placed at rest there (speeds 0) and o.settle (2) ticks without input, the
 * placement edges.js makes (supportState 'rest'), kept only when the engine agrees (alive, the tile and class it names:
 * G on its rest line for a surface). The surface point: the aligned one (a multiple of 16, where a resting ball's
 * auto-align takes it) when the interval holds it, else the interval's middle. o.fields / o.respawns false: surfaces only.
 */
function edgeSupports(S, o = {}) {
	const L = S.L, W = S.W, H = S.H;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const start = sim.snapshot();
	const flags = sim._flags, settle = o.settle || 2;
	const vcOf = (vx, vy) => (vx > 0.25 ? '+' + Math.min(7, Math.round(vx)) : vx < -0.25 ? '-' + Math.min(7, Math.round(-vx)) : '0') + (vy < -0.25 ? 'u' : vy > 0.25 ? 'd' : 'n');
	const clsOf = () => { if (sim.is_dead) return 'D'; const id = sim.current_tile, f = flags[id] | 0; return f & F_LIQUID ? 'W' : f & F_CLIMB ? 'C' : (id === 4 || id === 414) ? 'Z' : f & F_BOOST ? 'B' : sim.on_ground ? 'G' : 'A'; };
	const tileOf = () => { let x = Math.trunc(sim.px + 8) >> 4, y = Math.trunc(sim.py + 8) >> 4; x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); return y * W + x; };
	// (edges.js place(ctx, px, py, q, flip): the gravity queue set to the tile resting there, the flip set: the same rule)
	const place = (px, py, q, flip) => {
		sim.restore(start);
		sim.modifier_x = 0; sim.modifier_y = 0; sim.speed_x = 0; sim.speed_y = 0;
		sim._tileQueue.length = 0;
		if (q !== undefined) { sim._q0 = q; sim._q1 = q; }
		if (flip !== undefined) sim.flip_gravity = flip;
		sim.px = px; sim.py = py; sim.teleported = true;
		E.applyMask(inp, 0);
		for (let t = 0; t < settle; t++) { sim.tick(inp); if (sim.is_dead) return false; }
		return true;
	};
	sim.restore(start);
	const out = [{ i: 0, tile: tileOf(), cls: clsOf(), vc: vcOf(sim.speed_x, sim.speed_y), kind: 'start' }];
	const sf = S.surf;
	let tried = 0, kept = 0;
	const why = {};
	for (let r = 0; r < sf.n; r++) {
		if (sf.flags[r] & (SF_XPULL | SF_FXFLIP)) continue;
		const lo = sf.lo[r], hi = sf.hi[r], cl = sf.closed[r];
		let q = Math.ceil(lo / 16) * 16;
		if (q === lo && !(cl & 1)) q += 16;
		if (!(q < hi || (q === hi && (cl & 2)))) q = lo === hi ? lo : (lo + hi) / 2;
		const vert = sf.dir[r] === D_DOWN || sf.dir[r] === D_UP;
		const px = vert ? q : sf.rest[r], py = vert ? sf.rest[r] : q;
		const qt = centreOf(L, px, py).cur, flip = sf.flip[r];
		tried++;
		if (!place(px, py, qt, flip) || clsOf() !== 'G' || (vert ? sim.py : sim.px) !== sf.rest[r]) {
			const f = sf.flags[r];
			const k = f & SF_KILL ? 'kill' : f & SF_DOOR ? 'door' : f & (SF_ONEWAY | SF_OWIN) ? 'oneway' : 'other';
			why[k] = (why[k] || 0) + 1;
			if (k === 'other' && o.debug && why[k] <= 8) console.log('edgeSupports other:', r, DIR_NAMES[sf.dir[r]], 'flip', flip, 'rest', sf.rest[r], 'lo', lo, 'hi', hi, 'at', px, py, 'q', qt, '->', sim.px, sim.py, clsOf(), 'cur', sim.current_tile, 'flipNow', sim.flip_gravity);
			continue;
		}
		kept++;
		const rec = { i: out.length, tile: tileOf(), cls: 'G', vc: vcOf(sim.speed_x, sim.speed_y), kind: 'rest', px, py, q: qt, sup: { kind: 'surf', id: r } };
		if (flip !== 0) rec.flip = flip;
		out.push(rec);
	}
	if (o.fields !== false) {
		for (const F of S.fields) {
			for (const t of F.entries) {
				const px = (t % W) * 16, py = ((t / W) | 0) * 16;
				if (!place(px, py) || tileOf() !== t) continue;
				const c = clsOf();
				if (c === 'A' || c === 'D') continue;
				out.push({ i: out.length, tile: t, cls: c, vc: vcOf(sim.speed_x, sim.speed_y), kind: 'rest', px, py, sup: { kind: 'field', id: F.id, cell: t } });
			}
		}
	}
	if (o.respawns !== false) {
		for (const R of S.respawns) {
			if (!place(R.x, R.y)) continue;
			const c = clsOf();
			if (c === 'A' || c === 'D') continue;
			out.push({ i: out.length, tile: tileOf(), cls: c, vc: vcOf(sim.speed_x, sim.speed_y), kind: 'rest', px: R.x, py: R.y, sup: { kind: 'respawn', id: R.id } });
		}
	}
	out.surfWhy = why;
	out.surfTried = tried; out.surfKept = kept;
	return out;
}

// ------------------------------------------------------------------ counts and memory
function bytesOf(S) {
	let b = 0;
	const ta = (a) => (a && a.byteLength) ? a.byteLength : 0;
	for (const k of SURF_SPEC) b += ta(S.surf[k[0]]);
	for (const k of SPAN_SPEC) b += ta(S.spans[k[0]]);
	b += ta(S.cellHead) + ta(S.cellList) + ta(S.regOf) + ta(S.trigAt) + ta(S.nearAt) + ta(S.kindAt) + ta(S.fcls);
	for (const F of S.fields) b += ta(F.cells) + ta(F.entries) + ta(F.entryDirs) + 64;
	for (const p of S.portals) b += ta(p.entries) + 64;
	for (const t of S.triggers) b += ta(t.tiles) + ta(t.entryDirs) + 96;
	b += S.respawns.length * 64;
	for (const c of S.conds) b += 32 + 8 * (c.open.length + c.shut.length);
	return b;
}
function stats(S) {
	const sf = S.surf;
	const byDir = [0, 0, 0, 0], exactByDir = [0, 0, 0, 0];
	const fc = {};
	const fl = { edge: 0, near: 0, binade: 0, half: 0, ice: 0, kill: 0, oneway: 0, owspeed: 0, door: 0, xpull: 0, fxflip: 0, exact: 0 };
	const cellsWith = new Set();
	for (let r = 0; r < sf.n; r++) {
		byDir[sf.dir[r]]++;
		const f = sf.flags[r];
		if (f & SF_EDGE) fl.edge++;
		if (f & SF_NEAR) fl.near++;
		if (f & SF_BINADE) fl.binade++;
		if (f & SF_HALF) fl.half++;
		if (f & SF_ICE) fl.ice++;
		if (f & SF_KILL) fl.kill++;
		if (f & SF_ONEWAY) fl.oneway++;
		if (f & SF_OWSPEED) fl.owspeed++;
		if (f & SF_DOOR) fl.door++;
		if (f & SF_XPULL) fl.xpull++;
		if (f & SF_FXFLIP) fl.fxflip++;
		if (f & SF_EXACT) { fl.exact++; exactByDir[sf.dir[r]]++; }
		cellsWith.add(sf.cell[r]);
	}
	const endKinds = [0, 0, 0, 0, 0];
	for (let s = 0; s < S.spans.n; s++) { endKinds[S.spans.endLo[s]]++; endKinds[S.spans.endHi[s]]++; }
	let entries = 0, restCells = 0, fieldCells = 0;
	for (const F of S.fields) {
		fc[F.name] = (fc[F.name] || 0) + 1;
		entries += F.entries.length; fieldCells += F.cells.length;
		if (F.rest) restCells += F.cells.length;
	}
	const trigTiles = S.triggers.reduce((a, t) => a + t.tiles.length, 0);
	const surfClasses = sf.n * VCLASS.n;          // the speed classes a surface support can hold (x the free-axis sign)
	return {
		flips: S.flips, surf: sf.n, surfByDir: { down: byDir[0], up: byDir[1], left: byDir[2], right: byDir[3] }, surfCells: cellsWith.size,
		spans: S.spans.n, spanEnds: Object.fromEntries(END_NAMES.map((n, i) => [n, endKinds[i]])),
		flags: fl, exactByDir: { down: exactByDir[0], up: exactByDir[1], left: exactByDir[2], right: exactByDir[3] },
		fields: S.fields.length, fieldKinds: fc, fieldCells, fieldEntries: entries, fieldRestCells: restCells,
		portalExits: S.portals.length, portalEntries: S.portals.reduce((a, p) => a + p.entries.length, 0),
		triggers: S.triggers.length, triggerTiles: trigTiles, respawns: S.respawns.length, conds: S.conds.length - 1,
		// the class space: every support x its speed classes (surface: the free-axis speed, signed; fields / portals /
		// triggers: both axes' classes are open, counted here as one axis each)
		classes: surfClasses * 2 + (entries + S.portals.length + trigTiles) * VCLASS.n * 2 + restCells + S.respawns.length,
		pieces: S.pieces, ms: +S.ms.toFixed(1), bytes: bytesOf(S),
	};
}

module.exports = {
	buildSupports, classify, keyOf, edgeSupports, vclass, vclassName, VCLASS, RUN, VSTAR, stats, bytesOf, pullDir, flipsOf, makeProbe, centreOf,
	D_DOWN, D_UP, D_LEFT, D_RIGHT, DIR_NAMES, END_NAMES, FC_NAMES,
	SF_EDGE, SF_NEAR, SF_BINADE, SF_HALF, SF_ICE, SF_KILL, SF_ONEWAY, SF_OWSPEED, SF_DOOR, SF_OWIN, SF_BORDER, SF_XPULL, SF_FXFLIP, SF_EXACT, lineIndex,
	NK_ARROW, NK_DOT, NK_CLIMB, NK_LIQUID, NK_BOOST, NK_PORTAL, NK_KILL, NK_EFFECT, NK_TRIGGER, NK_ICE,
};
