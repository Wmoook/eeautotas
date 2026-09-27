'use strict';
// A learned progress measure for Find a route's CPU search (research: goexplore.js --guide orders its head A by it;
// tools/nnguide trains it with PyTorch on a rented GPU). Everything a model reads is computed here, the same code for
// the training data (tools/nnguide/build.js) and the search, so the two never disagree:
//   levelCtx(L, field)  the level's static parts: a class per tile (CLASSES), the doors, the killing tiles, the
//                       portals, the trophies, the reach field (src/reach.js)
//   doorState(ctx, sim) the door state now (each door shut or open, protection), cached by its hash: the class grid
//                       with the doors as they are, the door-aware walking distance to the trophy per tile (8-way,
//                       portals, no corner cut between two walls; killing tiles only with protection), the walkable
//                       components
//   features(ctx, sim)  NF scalars (the reach cost, the door-aware and static walks, the ball's sub-tile position and
//                       speed, its gravity, effects, keys, switches, coins, the trophy's direction, the territory of the
//                       ball's component, the share of doors shut)
//   patch(ctx, ds, tx, ty) the 32 x 32 patch: a class per tile and the walking distance relative to the ball's tile
// Two kinds of model (JSON weights: `load`; `cost(model, ctx, sim)` = the predicted ticks to go in tiles):
//   the CNN (train.py): an embedding of the classes, three stride-2 3 x 3 convolutions and an MLP over the patch's code
//     and the scalars -> log(1 + ticks to go). The patch's code depends only on the door state and the tile, so its
//     part of the first dense layer is cached per (door state, tile).
//   the structured model (train5.py, kind "room"): softplus(a) x the reach cost + softplus(b) x the door-aware walk +
//     softplus(g) x 100 tiles, (a, b, g) an MLP of the room's features only (no position): inside a room as smooth as
//     the two measures, across rooms a learned offset.
const RF = require('./reach.js');
const B = require('./blocks.js');

const P = 32, HALF = 16;   // the patch: P x P tiles, the ball's tile at (HALF, HALF)
const CLASSES = ['out', 'empty', 'solid', 'door_shut', 'door_open', 'oneway', 'half', 'arrow_left', 'arrow_up', 'arrow_right', 'arrow_down', 'dot',
	'boost_left', 'boost_right', 'boost_up', 'boost_down', 'liquid', 'climbable', 'deadly', 'coin', 'portal', 'key', 'switch', 'effect', 'trophy', 'checkpoint'];
const K = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
const NCLS = CLASSES.length;
const FEATURES = ['rc_log', 'rc_cut', 'walk_mode', 'dw_log', 'dw_none', 'sw_log', 'fx', 'fy', 'vx', 'vy', 'ground', 'jumps', 'multijump', 'mox', 'moy', 'morx',
	'mory', 'fly', 'flipgrav', 'jumpboost', 'speedboost', 'lowgrav', 'protect', 'timed_killer', 'god', 'keys', 'switches', 'coins', 'bluecoins', 'crown', 'team',
	'tro_dx', 'tro_dy', 'tro_dist', 'size', 'terr', 'shut'];
const NF = FEATURES.length;
const FAR = 65535;
const DOOR_STATES = 256;   // the door states a search keeps (200 x 200 tiles: 70 MB)

/** the static class of a block id (doors: shut; doorState opens them) */
function classOf(id, L) {
	if (!id) return K.empty;
	const k = B.kindOf(id);
	switch (k.kind) {
	case 'empty': case 'deco': case 'coin_taken': case 'secret': case 'reset': return k.kind === 'reset' ? K.switch : K.empty;
	case 'solid': return K.solid;
	case 'door': return K.door_shut;
	case 'oneway': return K.oneway;
	case 'half': return K.half;
	case 'arrow': return K['arrow_' + k.dir];
	case 'dot': return K.dot;
	case 'boost': return K['boost_' + k.dir];
	case 'liquid': return k.sub === 'toxic waste' ? K.deadly : K.liquid;
	case 'climbable': return K.climbable;
	case 'spike': case 'fire': return K.deadly;
	case 'coin': case 'bluecoin': return K.coin;
	case 'portal': case 'worldportal': return K.portal;
	case 'key': return K.key;
	case 'switch': return K.switch;
	case 'effect': return K.effect;
	case 'complete': return K.trophy;
	case 'checkpoint': case 'spawn': case 'crown': return K.checkpoint;
	default: return L && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0 ? K.deadly : K.empty;
	}
}

const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return h ^ (h >>> 16); };

/** the level's static parts (field: its reach field, else built here; maxStates: the door states kept, about 7 bytes per
 *  tile each: beyond it the cache starts over (the search: DOOR_STATES); the training data keeps them all) */
function levelCtx(L, field, maxStates) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
	const cls = new Uint8Array(N), wall = new Uint8Array(N), deadly = new Uint8Array(N), doors = [], trophies = [];
	let coins = 0, blue = 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) !== 0) doors.push(i);
		else if ((f & F_SOLID) !== 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0) wall[i] = 1;
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
		if (id === 121) trophies.push(i);
		if (id === 100) coins++;
		if (id === 101) blue++;
		cls[i] = classOf(id, L);
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) !== 0) cls[i] = K.door_shut;
	}
	// portals, backwards: exit tile -> the portal tiles that lead there (and forwards: portal tile -> its exits)
	const srcOf = new Map(), exitsOf = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			for (let k = 0; k < ex.n; k++) {
				const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4);
				if (j < 0 || j >= N) continue;
				if (!srcOf.has(j)) srcOf.set(j, []);
				if (!srcOf.get(j).includes(i)) srcOf.get(j).push(i);
				if (!exitsOf.has(i)) exitsOf.set(i, []);
				if (!exitsOf.get(i).includes(j)) exitsOf.get(i).push(j);
			}
		}
	}
	field = field || RF.reachField(L);
	return { L, W, H, N, cls, wall, deadly, doors, trophies, srcOf, exitsOf, field, coins, blue, words: new Int32Array(((doors.length + 31) >> 5) + 1), states: new Map(), list: [],
		maxStates: maxStates || Infinity, q: new Int32Array(N), shut: new Uint8Array(N) };
}

/** the door state now: {id, key, cls (the class grid with the doors as they are), walk (Uint16: door-aware walking
 *  distance to a trophy in tiles, FAR = none), comp / sizes / nPass (the walkable components), shutFrac}, cached by its
 *  hash */
function doorState(ctx, sim) {
	const { W, H, N, doors, words } = ctx;
	words.fill(0);
	words[words.length - 1] = sim.is_invulnerable ? 1 : 0;
	for (let k = 0; k < doors.length; k++) if (sim.is_tile_solid_now(doors[k] % W, (doors[k] / W) | 0)) words[k >> 5] |= 1 << (k & 31);
	let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
	for (let k = 0; k < words.length; k++) {
		let x = Math.imul(words[k], 0xcc9e2d51);
		x = (x << 15) | (x >>> 17);
		h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
		h2 = Math.imul(h2 ^ words[k], 0x5bd1e995); h2 ^= h2 >>> 13;
	}
	const key = (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
	let ds = ctx.states.get(key);
	if (ds) return ds;
	if (ctx.states.size >= ctx.maxStates) { ctx.states.clear(); ctx.list.length = 0; }
	const prot = !!sim.is_invulnerable;
	const cls = ctx.cls.slice(), shut = ctx.shut;
	for (let k = 0; k < doors.length; k++) {
		const s = (words[k >> 5] >>> (k & 31)) & 1;
		shut[doors[k]] = s;
		cls[doors[k]] = s ? K.door_shut : K.door_open;
	}
	const wall = ctx.wall, deadly = ctx.deadly, q = ctx.q, srcOf = ctx.srcOf;
	const pass = (i) => !wall[i] && !shut[i] && (prot || !deadly[i]);
	const walk = new Uint16Array(N).fill(FAR);
	let qh = 0, qt = 0;
	for (const g of ctx.trophies) if (walk[g] === FAR) { walk[g] = 0; q[qt++] = g; }
	while (qh < qt) {
		const t = q[qh++], x = t % W, y = (t / W) | 0, d = walk[t] + 1;
		const sr = srcOf.get(t);
		if (sr) for (const p of sr) if (walk[p] === FAR && pass(p)) { walk[p] = d; q[qt++] = p; }
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x - dx, yy = y - dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (walk[j] !== FAR || !pass(j)) continue;
				if (dx && dy && wall[yy * W + x] && wall[y * W + xx]) continue;
				walk[j] = Math.min(FAR - 1, d); q[qt++] = j;
			}
		}
	}
	for (const d of doors) shut[d] = 0;
	// the walkable components (8-way, no corner cut between two walls, portals both ways): the territory of this door
	// state around the ball, and the share of doors shut
	const comp = new Int32Array(N).fill(-1), sizes = [];
	let nPass = 0, nShut = 0;
	for (let k = 0; k < doors.length; k++) if ((words[k >> 5] >>> (k & 31)) & 1) { shut[doors[k]] = 1; nShut++; }
	for (let i0 = 0; i0 < N; i0++) {
		if (comp[i0] >= 0 || !pass(i0)) continue;
		const id = sizes.length;
		let qh2 = 0, qt2 = 0, sz = 0;
		comp[i0] = id; q[qt2++] = i0;
		while (qh2 < qt2) {
			const t = q[qh2++], x = t % W, y = (t / W) | 0;
			sz++;
			const sr = srcOf.get(t);
			if (sr) for (const p2 of sr) if (comp[p2] < 0 && pass(p2)) { comp[p2] = id; q[qt2++] = p2; }
			const ex = ctx.exitsOf.get(t);
			if (ex) for (const e of ex) if (comp[e] < 0 && pass(e)) { comp[e] = id; q[qt2++] = e; }
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const j = yy * W + xx;
					if (comp[j] >= 0 || !pass(j)) continue;
					if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
					comp[j] = id; q[qt2++] = j;
				}
			}
		}
		sizes.push(sz);
		nPass += sz;
	}
	for (const d of doors) shut[d] = 0;
	ds = { id: ctx.list.length, key, cls, walk, comp, sizes, nPass, shutFrac: doors.length ? nShut / doors.length : 0, codes: new Map() };
	ctx.states.set(key, ds);
	ctx.list.push(ds);
	return ds;
}

const popcount = (v) => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };
const clip = (v, a, b) => (v < a ? a : v > b ? b : v);

/** the scalar features of the live state into out (Float32Array(NF)); returns its door state. rc: the reach cost when
 *  the caller has it (tiles, -1 = cut off) */
function features(ctx, sim, out, rc) {
	const { W, H, N, field } = ctx;
	const ds = doorState(ctx, sim);
	if (rc === undefined) rc = RF.costAt(field, sim);
	const cx = Math.trunc(sim.px + 8), cy = Math.trunc(sim.py + 8);
	const tx = cx >> 4, ty = cy >> 4;
	const tile = tx >= 0 && ty >= 0 && tx < W && ty < H ? ty * W + tx : -1;
	const dw = tile >= 0 ? ds.walk[tile] : FAR;
	const sw = tile >= 0 ? field.walk[tile] : RF.CUT;
	out[0] = rc >= 0 ? Math.log1p(rc) : 0;
	out[1] = rc < 0 ? 1 : 0;
	out[2] = field.mode === 'walk' ? 1 : 0;
	out[3] = dw !== FAR ? Math.log1p(dw) : 0;
	out[4] = dw === FAR ? 1 : 0;
	out[5] = sw !== RF.CUT && sw < 0xfffe ? Math.log1p(sw / 5) : 0;
	out[6] = ((sim.px + 8) - (tx << 4)) / 16 - 0.5;
	out[7] = ((sim.py + 8) - (ty << 4)) / 16 - 0.5;
	out[8] = clip(sim.speed_x / 8, -2, 2);
	out[9] = clip(sim.speed_y / 8, -2, 2);
	out[10] = sim.on_ground ? 1 : 0;
	out[11] = clip(sim.jump_count, 0, 3) / 3;
	out[12] = sim.max_jumps !== 1 ? 1 : 0;
	out[13] = Math.sign(sim.mox); out[14] = Math.sign(sim.moy); out[15] = Math.sign(sim.morx); out[16] = Math.sign(sim.mory);
	out[17] = sim.has_levitation ? 1 : 0;
	out[18] = sim.flip_gravity ? 1 : 0;
	out[19] = sim.jump_boost ? 1 : 0;
	out[20] = sim.speed_boost ? 1 : 0;
	out[21] = sim.low_gravity ? 1 : 0;
	out[22] = sim.is_invulnerable ? 1 : 0;
	out[23] = sim.is_cursed || sim.is_zombie || sim.is_poisoned || sim.is_on_fire ? 1 : 0;
	out[24] = sim.in_god_mode ? 1 : 0;
	out[25] = popcount(sim._keysMask & 63) / 3;
	let sw1 = 0;
	for (const v of sim._switches.values()) if (v === true) sw1++;
	for (const v of sim._oswitches.values()) if (v === true) sw1++;
	out[26] = Math.min(sw1, 8) / 4;
	out[27] = ctx.coins ? Math.min(1, sim.coins / ctx.coins) : 0;
	out[28] = ctx.blue ? Math.min(1, sim.blue_coins / ctx.blue) : 0;
	out[29] = sim._collide_crown || sim.has_crown ? 1 : 0;
	out[30] = sim.team ? 1 : 0;
	// the nearest trophy (straight line)
	let bd = Infinity, bx = 0, by = 0;
	for (const g of ctx.trophies) {
		const gx = ((g % W) << 4) + 8 - cx, gy = (((g / W) | 0) << 4) + 8 - cy;
		const d = gx * gx + gy * gy;
		if (d < bd) { bd = d; bx = gx; by = gy; }
	}
	out[31] = bd < Infinity ? clip(bx / 1024, -2, 2) : 0;
	out[32] = bd < Infinity ? clip(by / 1024, -2, 2) : 0;
	out[33] = bd < Infinity ? Math.log1p(Math.sqrt(bd) / 16) : 0;
	out[34] = Math.log(N) / 10;
	const cid = tile >= 0 ? ds.comp[tile] : -1;
	out[35] = cid >= 0 && ds.nPass > 0 ? ds.sizes[cid] / ds.nPass : 0;
	out[36] = ds.shutFrac;
	return ds;
}

/** the patch around tile (tx, ty): classes (Uint8Array(P * P)) and the walking distance relative to the ball's tile
 *  (Float32Array(P * P): (walk - centre) / 8 tiles clipped to [-2, 2], 3 where no walk; 0 everywhere when the centre
 *  has none) */
function patch(ctx, ds, tx, ty, cls, rel) {
	const { W, H } = ctx;
	const c = tx >= 0 && ty >= 0 && tx < W && ty < H ? ds.walk[ty * W + tx] : FAR;
	for (let dy = 0; dy < P; dy++) {
		const y = ty + dy - HALF;
		for (let dx = 0; dx < P; dx++) {
			const x = tx + dx - HALF, o = dy * P + dx;
			if (x < 0 || y < 0 || x >= W || y >= H) { cls[o] = K.out; rel[o] = c === FAR ? 0 : 3; continue; }
			const j = y * W + x;
			cls[o] = ds.cls[j];
			const w = ds.walk[j];
			rel[o] = c === FAR ? 0 : w === FAR ? 3 : clip((w - c) / 8, -2, 2);
		}
	}
}

// ---------------------------------------------------------------- the network (inference)
/** a model file: {classes, features, emb [NCLS][E], convs [{w [out][in][3][3], b [out]}], fc [{w [out][in], b}], scale,
 *  outMean, outStd, featMean, featStd} */
function load(file) {
	const m = JSON.parse(require('fs').readFileSync(file, 'utf8'));
	if (m.features.join() !== FEATURES.join()) throw new Error('nnguide: the model was trained on other features');
	if (m.kind === 'room') {
		// the structured model (train5.py): a softplus(a) x reach + softplus(b) x door-aware walk + softplus(g) x 100
		// tiles, (a, b, g) = an MLP of the room's features only (no position: as smooth as the two measures in a room)
		m.ri = m.roomf.map((n) => FEATURES.indexOf(n));
		if (m.ri.some((i) => i < 0)) throw new Error('nnguide: the model was trained on other features');
		m.layersF = m.layers.map(([w, b]) => ({ w: Float32Array.from(w.flat()), b: Float32Array.from(b), out: w.length, inp: w[0].length }));
		m.hid = m.layersF.map((l) => new Float32Array(l.out));
		m.rin = new Float32Array(m.ri.length);
		m.feat = new Float32Array(NF);
		return m;
	}
	m.zero_ = m.zero;
	if (m.classes.join() !== CLASSES.join()) throw new Error('nnguide: the model was trained on other features');
	const f32 = (a) => Float32Array.from(a.flat(Infinity));
	m.embF = f32(m.emb);
	m.E = m.emb[0].length;
	m.convF = m.convs.map((c) => ({ w: f32(c.w), b: f32(c.b), out: c.w.length, inp: c.w[0].length }));
	m.fcF = m.fc.map((l) => ({ w: f32(l.w), b: f32(l.b), out: l.w.length, inp: l.w[0].length }));
	m.fMean = Float32Array.from(m.featMean); m.fStd = Float32Array.from(m.featStd);
	m.pcls = new Uint8Array(P * P); m.prel = new Float32Array(P * P); m.feat = new Float32Array(NF);
	const inC = m.E + 1;
	m.bufA = new Float32Array(Math.max(inC * P * P, 64 * 16 * 16)); m.bufB = new Float32Array(Math.max(inC * P * P, 64 * 16 * 16));
	m.hid = m.fcF.map((l) => new Float32Array(l.out));
	m.nCode = m.fcF[0].inp - NF;
	// the first convolution with the class embedding folded in: per output, class and kernel tap one weight (the walk
	// channel keeps its own)
	{
		const c = m.convF[0], E = m.E, out = c.out, inp = c.inp;
		m.fold = new Float32Array(out * NCLS * 9); m.wwalk = new Float32Array(out * 9);
		for (let o = 0; o < out; o++) {
			for (let k = 0; k < 9; k++) {
				for (let cl = 0; cl < NCLS; cl++) {
					let v = 0;
					for (let e = 0; e < E; e++) v += c.w[(o * inp + e) * 9 + k] * m.embF[cl * E + e];
					m.fold[(o * NCLS + cl) * 9 + k] = v;
				}
				m.wwalk[o * 9 + k] = c.w[(o * inp + E) * 9 + k];
			}
		}
	}
	m.fn = new Float32Array(NF);
	m.zero = new Uint8Array(NF);
	for (const i of m.zero_ || []) m.zero[i] = 1;
	return m;
}
/** 3 x 3 convolution, stride 2, padding 1, ReLU: src [inp][s][s] -> dst [out][s/2][s/2] */
function conv(c, src, s, dst) {
	const so = s >> 1, { w, b, out, inp } = c;
	for (let o = 0; o < out; o++) {
		for (let y = 0; y < so; y++) {
			for (let x = 0; x < so; x++) {
				let acc = b[o];
				for (let i = 0; i < inp; i++) {
					const wb = ((o * inp + i) * 9), sb = i * s * s;
					for (let ky = 0; ky < 3; ky++) {
						const yy = 2 * y + ky - 1;
						if (yy < 0 || yy >= s) continue;
						for (let kx = 0; kx < 3; kx++) {
							const xx = 2 * x + kx - 1;
							if (xx < 0 || xx >= s) continue;
							acc += w[wb + ky * 3 + kx] * src[sb + yy * s + xx];
						}
					}
				}
				dst[(o * so + y) * so + x] = acc > 0 ? acc : 0;
			}
		}
	}
	return so;
}
/** the patch's part of the first dense layer (its bias + its weights times the flattened last convolution) for (door
 *  state, tile); cached in the door state (the rest of the layer reads the scalars: about 15 us per state after that,
 *  a miss about 1 ms) */
function codeOf(m, ctx, ds, tx, ty) {
	const key = ty * ctx.W + tx;
	let h0 = ds.codes.get(key);
	if (h0) return h0;
	patch(ctx, ds, tx, ty, m.pcls, m.prel);
	// the first convolution from the classes and the walk channel (folded weights), then the others
	const c0 = m.convF[0], so = P >> 1, cls = m.pcls, rel = m.prel, fold = m.fold, ww = m.wwalk;
	let a = m.bufA, b = m.bufB;
	for (let o = 0; o < c0.out; o++) {
		const fb = o * NCLS * 9, wb = o * 9;
		for (let y = 0; y < so; y++) {
			for (let x = 0; x < so; x++) {
				let acc = c0.b[o];
				for (let ky = 0; ky < 3; ky++) {
					const yy = 2 * y + ky - 1;
					if (yy < 0 || yy >= P) continue;
					for (let kx = 0; kx < 3; kx++) {
						const xx = 2 * x + kx - 1;
						if (xx < 0 || xx >= P) continue;
						const q = yy * P + xx, k = ky * 3 + kx;
						acc += fold[fb + cls[q] * 9 + k] + ww[wb + k] * rel[q];
					}
				}
				a[(o * so + y) * so + x] = acc > 0 ? acc : 0;
			}
		}
	}
	let s = so;
	for (let k = 1; k < m.convF.length; k++) { s = conv(m.convF[k], a, s, b); const t = a; a = b; b = t; }
	const l = m.fcF[0], nc = m.nCode;
	h0 = new Float32Array(l.out);
	for (let o = 0; o < l.out; o++) {
		let acc = l.b[o];
		const wb = o * l.inp;
		for (let i = 0; i < nc; i++) acc += l.w[wb + i] * a[i];
		h0[o] = acc;
	}
	if (ds.codes.size > 200000) ds.codes.clear();
	ds.codes.set(key, h0);
	return h0;
}
/** the model's output for the live state: predicted log(1 + ticks to go) */
function predict(m, ctx, sim, rc) {
	const ds = features(ctx, sim, m.feat, rc);
	const tx = Math.min(ctx.W - 1, Math.max(0, Math.trunc(sim.px + 8) >> 4)), ty = Math.min(ctx.H - 1, Math.max(0, Math.trunc(sim.py + 8) >> 4));
	const h0 = codeOf(m, ctx, ds, tx, ty);
	const nf = NF, nc = m.nCode, fn = m.fn;
	for (let i = 0; i < nf; i++) fn[i] = m.zero[i] ? 0 : (m.feat[i] - m.fMean[i]) / m.fStd[i];
	let x = m.hid[0];
	{
		const l = m.fcF[0];
		for (let o = 0; o < l.out; o++) {
			let acc = h0[o];
			const wb = o * l.inp + nc;
			for (let i = 0; i < nf; i++) acc += l.w[wb + i] * fn[i];
			x[o] = acc > 0 ? acc : 0;
		}
	}
	for (let k = 1; k < m.fcF.length; k++) {
		const l = m.fcF[k], y = m.hid[k], last = k === m.fcF.length - 1;
		for (let o = 0; o < l.out; o++) {
			let acc = l.b[o];
			const wb = o * l.inp;
			for (let i = 0; i < l.inp; i++) acc += l.w[wb + i] * x[i];
			y[o] = last || acc > 0 ? acc : 0;
		}
		x = y;
	}
	return x[0] * m.outStd + m.outMean;
}
const softplus = (x) => (x > 20 ? x : Math.log1p(Math.exp(x)));
/** the structured model's cost (tiles) */
function roomCost(m, ctx, sim, rc) {
	features(ctx, sim, m.feat, rc);
	const f = m.feat;
	if (rc === undefined) rc = RF.costAt(ctx.field, sim);
	for (let i = 0; i < m.ri.length; i++) m.rin[i] = (f[m.ri[i]] - m.rmean[i]) / m.rstd[i];
	let x = m.rin;
	for (let k = 0; k < m.layersF.length; k++) {
		const l = m.layersF[k], y = m.hid[k], last = k === m.layersF.length - 1;
		for (let o = 0; o < l.out; o++) {
			let acc = l.b[o];
			const wb = o * l.inp;
			for (let i = 0; i < l.inp; i++) acc += l.w[wb + i] * x[i];
			y[o] = last || acc > 0 ? acc : 0;
		}
		x = y;
	}
	const dw = f[4] > 0 ? 0 : Math.expm1(f[3]);
	return softplus(x[0]) * (rc >= 0 ? rc : 0) + softplus(x[1]) * dw + softplus(x[2]) * 100;
}
/** predicted ticks to go, in tiles (/ model.scale: ticks per tile, for a search that mixes it with tile costs) */
function cost(m, ctx, sim, rc) { return m.kind === 'room' ? roomCost(m, ctx, sim, rc) : Math.expm1(Math.max(0, predict(m, ctx, sim, rc))) / (m.scale || 1); }

module.exports = { P, HALF, CLASSES, NCLS, FEATURES, NF, FAR, DOOR_STATES, classOf, levelCtx, doorState, features, patch, load, predict, cost, conv };
