'use strict';
// The steer field (v4) of Find a route: a gate-aware progress measure, for ORDERING only (the "Find a route" research's
// design A, src/out/planner_a, judged in src/out/judge/VERDICT.md step 4). The reach field (src/reach.js, RCH3) prices a
// ball by the physics of the level with every door open; on a level of keys, switches, coins and team doors its cheapest
// way runs through doors that are shut, so a search that follows it stalls at the door. The steer field prices the same
// ball by the level as it is in the ball's own discrete state: the LAYER.
//
// Layers: the discrete state's modelled features (key colours, purple / orange switch ids, team, protection, gold / blue
// coin counts up to the highest door, the crown for crown doors, and 'fx' = the static effects plain / wild), chosen by
// counterexample (CEGAR): start with none modelled (the reach field's optimism), take the plan (the walk plan, then the
// physics plan), replay it with the full state; the first closed gate it walks through names a feature to model; rebuild
// until the plans are valid (or 4096 layers). Per reached layer (walk model, from the start): reach.js's field on a copy
// of the level with that layer's gates shut (solid) or open (air), killers per protection, and every tile that changes
// the layer turned into a goal seeded with the next layer's cost there (value iteration over the layer graph's strongly
// connected components, sinks first); a wild layer (an effect on: jump / fly / speed / low gravity / multijump / gravity)
// gets the walking distance x kappa (the level's median physics / walk cost ratio). Coins: the count relaxation lets one
// coin count twice, so where the plan passes a coin door the distinct-coin DP (at most 18 coins: h[collected set][last] =
// the least cost to finish, leg costs by per-coin physics fields) gives the coin way; the lookup is the min of it and the
// layer's own field (the ways that need no more coins). One-way platforms block their centre entry against the pass
// direction (reach.js opts.oneWayEntry: not sound, fine for ordering).
//
// Nothing prunes by it: the explore, the relay and the CPU search rule a state out only by the RCH3 field's -1; the steer
// field orders (the explore's per-cell priority and closest attempt, the beam's goal score, the CPU search's second goal
// heap) and widens the relay's cost ceiling (a heuristic bound, not a proof: explore --costslack drops a state only above
// both the reach field's ceiling and the steer field's, so the relay never drops a state it keeps without the steer
// field). -1 = no value (a layer not reached in the walk model, a wall): the searches rank such a state behind every
// valued one.
//
// buildSteer(level, opts) -> steer (plain data: typed arrays, the layer fields; `info` for the log)
// steerFifths(steer, sim) -> fifths of a tile (-1 = no value); steerAt(steer, sim) -> tiles (NaN = no value);
//   steerScore(steer, sim) (the beam's score: the layer field's bilinear blend, reach.js scoreAt, where the own value is
//   the layer field's; else own / 5; -1 = none) = native/beam.h steerFifths / steerScore (test/steer.js: eegpu steertest)
// steerFileBytes(steer, levelFp) -> the RCH4 file for eegpu --steer=; readSteerFile(bytes) -> the same lookup data
//   (goexplore.js --steer=<file>; the tests)
// RCH4 (little-endian, sections 8-aligned): 'RCH4', i32 ver 4, W, H, nFeat, S, nBodies, flags (1: coin DP), prioShift,
//   nTeam, dpN, dpT; u32 levelFp lo, hi (gpu.js blobFp; 0 0: none) at 48; then i32 feat[nFeat x 4] (kind, param, radix,
//   stride; kinds: 1 key colour bit, 2 purple switch id, 3 orange switch id, 4 team, 5 protection, 6 coins, 7 blue coins,
//   8 crown (collide_crown), 9 effects (0 plain: no levitation, gravity flip, jump / speed boost, low gravity, max_jumps
//   1)), i32 team[nTeam], i32 layerBody[S] (-1: no field), u64 bodyOff[nBodies], u64 bodySize[nBodies] (from the file's
//   start), u8 goal[nBodies x N] (the tiles that change the layer: the lookup takes the least of the 8 neighbours + a step
//   there), the bodies (RCH3 bytes, identical ones shared), with the coin DP: i32 dpBit[dpN] (the engine's coin bit),
//   i32 dpLeg[dpN] (its leg field's body), f32 h[2^dpN x dpN].
const crypto = require('crypto');
const E = require('./eesim.js');
const RF = require('./reach.js');

const VERSION = 4;
const TROPHY = 121, CROWN_ID = 5;
const KEY_IDS = [6, 7, 8, 408, 409, 410];
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
const CUT = RF.CUT;
const INF = 0xffffffff;
// the ordering fields' air penalty (reach.js opts.airPen: fifths more per sideways step of a rising or falling ball over a
// tile with no floor; 0: none). EEAT_AIRPEN for experiments
const AIR_PEN = process.env.EEAT_AIRPEN !== undefined ? +process.env.EEAT_AIRPEN : 0;
// door / gate ids -> [feature, polarity (1: open when on / satisfied)]; exact statics (gold border: off; silver crown:
// only the trophy gives it); time doors shut (a door that opens every 10 s is a wait of up to 5 s); the rest open
const GATE = new Map([
	[23, ['key0', 1]], [24, ['key1', 1]], [25, ['key2', 1]], [26, ['key0', 0]], [27, ['key1', 0]], [28, ['key2', 0]],
	[1005, ['key3', 1]], [1006, ['key4', 1]], [1007, ['key5', 1]], [1008, ['key3', 0]], [1009, ['key4', 0]], [1010, ['key5', 0]],
	[184, ['psw', 1]], [185, ['psw', 0]], [1079, ['osw', 1]], [1080, ['osw', 0]],
	[43, ['coins', 1]], [165, ['coins', 0]], [213, ['bcoins', 1]], [214, ['bcoins', 0]],
	[1027, ['team', 1]], [1028, ['team', 0]], [1094, ['crown', 1]], [1095, ['crown', 0]],
	[200, ['static', 0]], [201, ['static', 1]], [1152, ['static', 0]], [1153, ['static', 1]],
	[156, ['static', 0]], [157, ['static', 0]], [1011, ['open', 1]], [1012, ['open', 1]], [206, ['open', 1]], [207, ['open', 1]],
]);
// the static effects that change jumps, speeds or gravity (reach.js WILD); the value a tile sets is the default one?
const WILD_FX = new Set([417, 418, 419, 453, 461, 1517]);
const fxDefault = (id, v) => (id === 461 ? v === 1 : v === 0);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const EMPTY = [];
const plainFx = (sim) => !sim.has_levitation && sim.flip_gravity === 0 && sim.max_jumps === 1 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity;

// ------------------------------------------------------------------ the level's static analysis
function analyze(level, opts) {
	const W = level.width, H = level.height, N = W * H;
	const fg = level.fg, flags = level.flags, nF = flags.length, gF = level.gFlags, lk = level.lookup0;
	const fl = (id) => (id >= 0 && id < nF ? flags[id] : 0);
	const isWallId = (id) => (fl(id) & F_SOLID) !== 0 && (fl(id) & (F_DOOR | F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0;
	// static class: 0 wall, 1 killer, 2 open, 3 gate (per layer)
	const cls = new Uint8Array(N);
	const gateFeat = new Array(N).fill(null), gatePol = new Int8Array(N), gateParam = new Int32Array(N);
	const special = [];   // [tile, kind, param]
	const feats = new Map();   // feature key -> {key, gates, sources, values, init, static}
	const addFeat = (k) => { if (!feats.has(k)) feats.set(k, { key: k, gates: 0, sources: 0 }); return feats.get(k); };
	let killers = 0, prot = 0, fxTiles = 0;
	const trophies = [];
	// (the level's gold coins: a coin door of more can never open, a coin gate of more never shuts: statics, not layers.
	// The walk model counts a coin at every touch, so its plan could pass Forgotten Helix's 16-coin doors with 15 coins
	// in the level: T 16, and the distinct-coin DP over 15 coins then had no value anywhere)
	let goldCoins = 0;
	for (let i = 0; i < N; i++) if (fg[i] === 100 || fg[i] === 110) goldCoins++;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const hr = (fl(id) & F_HALF) ? lk[i] : -1;
		let g = GATE.get(id);
		if (g && g[0] === 'coins' && lk[i] > goldCoins) g = ['static', g[1] === 1 ? 0 : 1];
		if (g && (id === 156 || id === 157) && opts && opts.timeDoors === 'open') g = ['open', 1];
		if (g) {
			const [f, pol] = g;
			const key = f === 'psw' || f === 'osw' ? `${f}:${lk[i]}` : f;
			gateFeat[i] = key; gatePol[i] = pol; gateParam[i] = lk[i];
			cls[i] = 3;
			if (f !== 'static' && f !== 'open') addFeat(key).gates++;
			continue;
		}
		if (isWallId(id) || hr === 2 || hr === 3) { cls[i] = 0; continue; }
		if (id < gF.length && (gF[id] & 4) !== 0) { cls[i] = 1; killers++; continue; }
		cls[i] = 2;
		if (id === TROPHY) trophies.push(i);
		const kc = KEY_IDS.indexOf(id);
		if (kc >= 0) { special.push([i, 'key', kc]); addFeat('key' + kc).sources++; }
		else if (id === 113 || id === 1619) special.push([i, id === 113 ? 'psw' : 'pswR', lk[i]]);
		else if (id === 467 || id === 1620) special.push([i, id === 467 ? 'osw' : 'oswR', lk[i]]);
		else if (id === 423) { special.push([i, 'team', lk[i]]); addFeat('team').sources++; }
		else if (id === 420) { special.push([i, 'prot', lk[i] !== 0 ? 1 : 0]); prot++; }
		else if (id === 1618) { special.push([i, 'reset', 0]); fxTiles++; }
		else if (WILD_FX.has(id)) { special.push([i, 'fx', fxDefault(id, lk[i]) ? 0 : 1]); fxTiles++; }
		else if (id === 100 || id === 110) { special.push([i, 'coins', 1]); addFeat('coins').sources++; }
		else if (id === 101 || id === 111) { special.push([i, 'bcoins', 1]); addFeat('bcoins').sources++; }
		else if (id === CROWN_ID) { special.push([i, 'crown', 1]); addFeat('crown').sources++; }
	}
	if (killers && prot) { const p = addFeat('prot'); p.gates = killers; p.sources = prot; }
	// the static effects: one feature, plain (every effect default: the physics model applies) or wild (walk metric); only
	// for the physics layering (no gate reads it)
	if (fxTiles && level.gravityMult === 1) addFeat('fx').sources = fxTiles;
	for (const [, kind] of special) if (kind === 'reset' && feats.has('prot')) feats.get('prot').sources++;
	for (const [, kind, id] of special) {
		if (kind === 'psw' || kind === 'pswR' || kind === 'osw' || kind === 'oswR') {
			const pre = kind.startsWith('p') ? 'psw' : 'osw';
			for (const [k, f] of feats) if (k.startsWith(pre + ':') && (id === 1000 || k === `${pre}:${id}`)) f.sources++;
		}
	}
	const sim = new E.EESim(level); sim.reset();
	const teamVals = new Set([0]);
	for (const [, kind, v] of special) if (kind === 'team') teamVals.add(v);
	let coinCap = 0, bcoinCap = 0;
	for (let i = 0; i < N; i++) {
		if ((fg[i] === 43 || fg[i] === 165) && lk[i] <= goldCoins) coinCap = Math.max(coinCap, lk[i]);
		if (fg[i] === 213 || fg[i] === 214) bcoinCap = Math.max(bcoinCap, lk[i]);
	}
	for (const [k, f] of feats) {
		if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'prot' || k === 'crown' || k === 'fx') f.values = [0, 1];
		else if (k === 'team') f.values = [...teamVals].sort((a, b) => a - b);
		else if (k === 'coins') f.values = range(coinCap + 1);
		else if (k === 'bcoins') f.values = range(bcoinCap + 1);
		f.init = featureOf(k, sim, f.values);
		f.static = f.sources === 0;
	}
	// portals: tile -> exits that are not walls
	const portalExits = new Map(), portalSrcOf = new Map();
	if (level.portalSlot && level.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = level.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || cls[i] === 0) continue;
			const ex = level.portalsById.get(level.pTarget[s]);
			if (!ex) continue;
			const list = [];
			for (let k = 0; k < ex.n; k++) {
				const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4);
				if (j >= 0 && j < N && cls[j] !== 0 && !list.includes(j)) list.push(j);
			}
			if (!list.length) continue;
			portalExits.set(i, list);
			for (const j of list) { if (!portalSrcOf.has(j)) portalSrcOf.set(j, []); portalSrcOf.get(j).push(i); }
		}
	}
	// forced portals (reach.js opts.portalForced): a portal tile with exits, not itself an exit, whose target is another id:
	// the ball entering it is teleported, so the walk model leaves it only through its exits
	const forcedP = new Uint8Array(N);
	for (const i of portalExits.keys()) { const s = level.portalSlot[i]; if (!portalSrcOf.has(i) && level.pTarget[s] !== level.pId[s]) forcedP[i] = 1; }
	// (the lastPortal chains walked: reach.js unforceChains)
	RF.unforceChains(W, H, forcedP, portalExits, portalSrcOf);
	// one-way platforms: the pass direction (0 left, 1 up, 2 right, 3 down); the walk model blocks the entry against it
	const oneWay = new Int8Array(N).fill(-1);
	for (let i = 0; i < N; i++) { const f = fl(fg[i]); if ((f & F_JUMPTHRU) === 0 || cls[i] !== 2) continue; oneWay[i] = (f & F_ROTHALF) ? (lk[i] & 3) : 1; }
	const specialAt = new Int32Array(N).fill(-1);
	special.forEach((s, k) => { specialAt[s[0]] = k; });
	const start = { t: ((Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)) };
	return { level, W, H, N, cls, oneWay, gateFeat, gatePol, gateParam, special, specialAt, feats, portalExits, portalSrcOf, forcedP, trophies, start, opts };
}
/** a feature's value index in the sim's state */
function featureOf(k, sim, values) {
	let v;
	if (k.startsWith('key')) v = (sim._keysMask >> +k.slice(3)) & 1;
	else if (k.startsWith('psw:')) v = sim._switches.get(+k.slice(4)) === true ? 1 : 0;
	else if (k.startsWith('osw:')) v = sim._oswitches.get(+k.slice(4)) === true ? 1 : 0;
	else if (k === 'team') v = sim.team;
	else if (k === 'prot') v = sim.is_invulnerable ? 1 : 0;
	else if (k === 'coins') v = Math.min(sim.coins, values.length - 1);
	else if (k === 'bcoins') v = Math.min(sim.blue_coins, values.length - 1);
	else if (k === 'crown') v = sim._collide_crown ? 1 : 0;
	else if (k === 'fx') v = plainFx(sim) ? 0 : 1;
	const i = values.indexOf(v);
	return i < 0 ? 0 : i;
}
function testGate(k, pol, param, v) {
	let on;
	if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'prot' || k === 'crown') on = v === 1;
	else if (k === 'team') on = v === param;
	else if (k === 'coins' || k === 'bcoins') on = v >= param;
	return pol === 1 ? on : !on;
}
/** entering one-way tile t2 by (dx, dy) against its pass direction */
const owBlocked = (ow, dx, dy) => (ow === 1 ? dy === 1 : ow === 3 ? dy === -1 : ow === 2 ? dx === -1 : ow === 0 ? dx === 1 : false);

// ------------------------------------------------------------------ the layered model for a set of modelled features
function makeModel(A, modeled) {
	const feats = [...modeled].map((k) => A.feats.get(k)).filter((f) => f && !f.static);
	const radix = [], stride = [];
	let S = 1;
	for (const f of feats) { stride.push(S); radix.push(f.values.length); S *= f.values.length; }
	const idx = new Map(feats.map((f, n) => [f.key, n]));
	const valOf = (s, n) => Math.floor(s / stride[n]) % radix[n];
	const withVal = (s, n, v) => s + (v - valOf(s, n)) * stride[n];
	let s0 = 0;
	feats.forEach((f, n) => { s0 += f.init * stride[n]; });
	const allF = A.feats;
	/** a gate's state in layer s: modelled features by the layer's value; statics exact; the others open */
	function gateOpen(i, s) {
		const k = A.gateFeat[i];
		if (k === 'open') return true;
		if (k === 'static') return A.gatePol[i] === 1;
		const f = allF.get(k);
		const n = idx.get(k);
		let v;
		if (n !== undefined) v = f.values[valOf(s, n)];
		else if (f && f.static) v = f.values[f.init];
		else return true;
		return testGate(k, A.gatePol[i], A.gateParam[i], v);
	}
	const nProt = idx.get('prot');
	const protStatic = !allF.has('prot');
	/** 0 blocked, 1 passable, 2 a killer (the ball dies) */
	function pass(i, s) {
		const c = A.cls[i];
		if (c === 2) return 1;
		if (c === 0) return 0;
		if (c === 3) return gateOpen(i, s) ? 1 : 0;
		if (nProt !== undefined) return valOf(s, nProt) === 1 ? 1 : 2;
		return protStatic ? 2 : 1;
	}
	/** the layer after entering special tile k in layer s */
	function trans(s, k) {
		const [, kind, p] = A.special[k];
		let n;
		switch (kind) {
			case 'key': n = idx.get('key' + p); return n === undefined ? s : withVal(s, n, 1);
			case 'psw': case 'pswR': case 'osw': case 'oswR': {
				const pre = kind.startsWith('p') ? 'psw' : 'osw', reset = kind.endsWith('R');
				for (const [key, m] of idx) {
					if (!key.startsWith(pre + ':')) continue;
					if (p !== 1000 && key !== `${pre}:${p}`) continue;
					s = withVal(s, m, reset ? 0 : 1 - valOf(s, m));
				}
				return s;
			}
			case 'team': n = idx.get('team'); if (n === undefined) return s; { const vi = feats[n].values.indexOf(p); return vi < 0 ? s : withVal(s, n, vi); }
			case 'prot': n = idx.get('prot'); return n === undefined ? s : withVal(s, n, p);
			case 'coins': case 'bcoins': n = idx.get(kind); return n === undefined ? s : withVal(s, n, Math.min(radix[n] - 1, valOf(s, n) + 1));
			case 'crown': n = idx.get('crown'); return n === undefined ? s : withVal(s, n, 1);
			case 'fx': n = idx.get('fx'); return n === undefined ? s : p === 1 ? withVal(s, n, 1) : s;
			case 'reset': n = idx.get('prot'); if (n !== undefined) s = withVal(s, n, 0); n = idx.get('fx'); if (n !== undefined) s = withVal(s, n, 0); return s;
		}
		return s;
	}
	const nFx = idx.get('fx');
	/** every layer entering special tile k from layer s can lead to (the first = trans(s, k); a default-value effect
	 *  tile in a wild layer may or may not make it plain) */
	function transAll(s, k) {
		const t = trans(s, k);
		const sp = A.special[k];
		if (nFx !== undefined && sp[1] === 'fx' && sp[2] === 0 && valOf(s, nFx) === 1) return [t, withVal(t, nFx, 0)];
		return [t];
	}
	const invCache = new Map();
	function inv(k, s2) {
		let tab = invCache.get(k);
		if (!tab) {
			tab = new Array(S);
			for (let s = 0; s < S; s++) for (const t of transAll(s, k)) (tab[t] || (tab[t] = [])).push(s);
			invCache.set(k, tab);
		}
		return tab[s2] || EMPTY;
	}
	function layerOf(sim) {
		let s = 0;
		feats.forEach((f, n) => { s += featureOf(f.key, sim, f.values) * stride[n]; });
		return s;
	}
	const identity = new Uint8Array(A.special.length);
	for (let k = 0; k < A.special.length; k++) { let id = 1; for (let s = 0; s < S && id; s++) { const ts = transAll(s, k); if (ts.length !== 1 || ts[0] !== s) id = 0; } identity[k] = id; }
	return { feats, S, s0, radix, stride, valOf, withVal, pass, trans, transAll, inv, layerOf, identity, gateOpen, names: feats.map((f) => f.key) };
}

// ------------------------------------------------------------------ the walk model: a backward Dijkstra over tile x layer
function layeredField(A, M) {
	const { W, H, N } = A, S = M.S;
	const cost = new Uint32Array(S * N).fill(INF);
	const NB = 8, MASK = NB - 1;
	const bk = [], bn = new Int32Array(NB);
	for (let b = 0; b < NB; b++) bk.push(new Int32Array(4096));
	let queued = 0;
	const push = (st, c) => {
		if (c >= cost[st]) return;
		cost[st] = c;
		const b = c & MASK;
		let a = bk[b];
		if (bn[b] === a.length) { const a2 = new Int32Array(a.length * 2); a2.set(a); bk[b] = a = a2; }
		a[bn[b]++] = st;
		queued++;
	};
	for (const t of A.trophies) for (let s = 0; s < S; s++) push(s * N + t, 0);
	const specialAt = A.specialAt, identity = M.identity, pass = M.pass;
	const isTrophy = new Uint8Array(N); for (const t of A.trophies) isTrophy[t] = 1;
	let cur = 0, pops = 0;
	const srcList = A.portalSrcOf, forcedP = A.forcedP;
	while (queued > 0) {
		const b = cur & MASK;
		for (let n = 0; n < bn[b]; n++) {
			const st = bk[b][n];
			queued--;
			if (cost[st] !== cur) continue;
			pops++;
			const s2 = (st / N) | 0, t2 = st - s2 * N;
			const k = specialAt[t2];
			const pre = k >= 0 && !identity[k] ? M.inv(k, s2) : null;
			const x2 = t2 % W, y2 = (t2 - x2) / W, ow2 = A.oneWay[t2];
			const nPre = pre ? pre.length : 1;
			for (let q = 0; q < nPre; q++) {
				const s = pre ? pre[q] : s2;
				if (pass(t2, s) === 0) continue;
				const base = s * N;
				for (let di = 0; di < 8; di++) {
					const x = x2 - DX8[di], y = y2 - DY8[di];
					if (x < 0 || y < 0 || x >= W || y >= H) continue;
					const t = y * W + x;
					if (isTrophy[t] || pass(t, s) !== 1 || forcedP[t]) continue;
					if (ow2 >= 0 && owBlocked(ow2, DX8[di], DY8[di])) continue;
					if (DX8[di] !== 0 && DY8[di] !== 0 && pass(y * W + x2, s) === 0 && pass(y2 * W + x, s) === 0) continue;
					push(base + t, cur + (DX8[di] && DY8[di] ? 7 : 5));
				}
			}
			const ps = srcList.get(t2);
			if (ps) for (const p of ps) if (pass(p, s2) === 1) push(s2 * N + p, cur + 5);
		}
		bn[b] = 0;
		cur++;
		if (cur > 4e6) break;
	}
	return { cost, pops };
}
/** the walk plan: greedy descent from (t0, s0) */
function planFrom(A, M, F, t0, s0, maxSteps = 200000) {
	const { W, H, N } = A;
	const cost = F.cost;
	const path = [{ t: t0, s: s0, via: 'start' }];
	let t = t0, s = s0;
	if (cost[s * N + t] === INF) return { path, ok: false, why: 'start has no way' };
	for (let step = 0; step < maxSteps; step++) {
		const c = cost[s * N + t];
		if (c === 0) return { path, ok: true };
		let best = null;
		const x = t % W, y = (t - x) / W;
		for (let di = 0; di < 8; di++) {
			const x2 = x + DX8[di], y2 = y + DY8[di];
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const t2 = y2 * W + x2;
			if (M.pass(t2, s) === 0) continue;
			if (A.oneWay[t2] >= 0 && owBlocked(A.oneWay[t2], DX8[di], DY8[di])) continue;
			if (DX8[di] && DY8[di] && M.pass(y * W + x2, s) === 0 && M.pass(y2 * W + x, s) === 0) continue;
			const k = A.specialAt[t2];
			for (const s2 of (k >= 0 ? M.transAll(s, k) : [s])) {
				const c2 = cost[s2 * N + t2];
				if (c2 === INF) continue;
				const tot = c2 + (DX8[di] && DY8[di] ? 7 : 5);
				if (tot === c && (!best || tot < best.c)) best = { t: t2, s: s2, c: tot, via: s2 !== s ? 'touch' : 'move' };
			}
		}
		const ex = A.portalExits.get(t);
		if (ex && !best) for (const e of ex) { const c2 = cost[s * N + e]; if (c2 !== INF && c2 + 5 === c) { best = { t: e, s, c: c2 + 5, via: 'portal', from: t }; break; } }
		if (!best) return { path, ok: false, why: `stuck at ${t % W},${(t / W) | 0}` };
		path.push(best);
		t = best.t; s = best.s;
	}
	return { path, ok: false, why: 'too long' };
}
function fullState(A) {
	const st = {};
	for (const [k, f] of A.feats) st[k] = f.values[f.init];
	st._coins = new Set(); st._bcoins = new Set();
	return st;
}
function applyFull(A, st, t) {
	const k = A.specialAt[t];
	if (k < 0) return;
	const [, kind, p] = A.special[k];
	if (kind === 'key') { if (st['key' + p] !== undefined) st['key' + p] = 1; }
	else if (kind === 'psw' || kind === 'pswR' || kind === 'osw' || kind === 'oswR') {
		const pre = kind.startsWith('p') ? 'psw' : 'osw', reset = kind.endsWith('R');
		for (const key of Object.keys(st)) if (key.startsWith(pre + ':') && (p === 1000 || key === `${pre}:${p}`)) st[key] = reset ? 0 : 1 - st[key];
	} else if (kind === 'team') { if (st.team !== undefined) st.team = p; }
	else if (kind === 'prot') { if (st.prot !== undefined) st.prot = p; }
	else if (kind === 'coins') { st._coins.add(t); if (st.coins !== undefined) st.coins = Math.max(st.coins, st._coins.size); }
	else if (kind === 'bcoins') { st._bcoins.add(t); if (st.bcoins !== undefined) st.bcoins = Math.max(st.bcoins, st._bcoins.size); }
	else if (kind === 'crown') { if (st.crown !== undefined) st.crown = 1; }
	else if (kind === 'reset') { if (st.prot !== undefined) st.prot = 0; }
}
/** the first feature that makes a plan invalid under the full state (a closed gate / a killer it walks through), or null */
function counterexample(A, plan) {
	const st = fullState(A);
	for (let n = 1; n < plan.path.length; n++) {
		const p = plan.path[n];
		if (p.via === 'portal' || p.via === 'death') continue;
		const t = p.t, c = A.cls[t];
		const q = plan.path[n - 1].t, W = A.W;
		const ddx = (t % W) - (q % W), ddy = Math.floor(t / W) - Math.floor(q / W);
		if (ddx && ddy && Math.abs(ddx) === 1 && Math.abs(ddy) === 1) {
			const a = q + ddx, b = q + ddy * W;
			const closed = (i) => A.cls[i] === 0 || (A.cls[i] === 3 && A.gateFeat[i] !== 'open' && (A.gateFeat[i] === 'static' ? A.gatePol[i] !== 1 : st[A.gateFeat[i]] !== undefined && !testGate(A.gateFeat[i], A.gatePol[i], A.gateParam[i], st[A.gateFeat[i]])));
			if (closed(a) && closed(b)) { const g = A.cls[a] === 3 && A.gateFeat[a] !== 'static' ? a : b; if (A.cls[g] === 3 && A.gateFeat[g] !== 'static') return { feat: A.gateFeat[g], step: n, t: g }; }
		}
		if (c === 3) {
			const k = A.gateFeat[t];
			if (k !== 'open' && k !== 'static' && st[k] !== undefined && !testGate(k, A.gatePol[t], A.gateParam[t], st[k])) return { feat: k, step: n, t };
		} else if (c === 1 && st.prot !== undefined && st.prot !== 1) return { feat: 'prot', step: n, t };
		applyFull(A, st, t);
	}
	return null;
}
/** the walk model's CEGAR loop -> {A, M, F, plan, log} */
function walkBuild(level, A, opts) {
	const modeled = new Set(opts.features || []);
	const maxLayers = opts.maxLayers || 4096;
	const log = [];
	let M, F, plan, capped = null;
	for (let it = 0; it < 40; it++) {
		M = makeModel(A, modeled);
		F = layeredField(A, M);
		plan = planFrom(A, M, F, A.start.t, M.s0);
		const cx = plan.ok ? counterexample(A, plan) : null;
		log.push({ features: [...modeled], S: M.S, planOk: plan.ok, cx: cx && cx.feat });
		if (!cx || modeled.has(cx.feat)) break;
		const f = A.feats.get(cx.feat);
		if (!f) break;
		if (M.S * f.values.length > maxLayers) { capped = { feat: cx.feat, why: 'layers' }; break; }
		if (opts.deadline && Date.now() > opts.deadline) { capped = { feat: cx.feat, why: 'time' }; break; }
		modeled.add(cx.feat);
	}
	return { A, M, F, plan, log, capped };
}

// ------------------------------------------------------------------ the layered physics fields
/** the least cost (fifths) of any abstract state at tile t (CUT: none) */
function tileMin(f, t) {
	if (f.mode === 'walk') return f.walk[t];
	let m = CUT;
	const Q3 = f.Q + 3, K1 = RF.KF + 1, NL = 128;
	for (let l = 0; l < Q3; l++) { const v = f.costR[t * Q3 + l]; if (v < m) m = v; }
	for (let l = 0; l < K1; l++) { const v = f.costF[t * K1 + l]; if (v < m) m = v; const w = f.costL[t * K1 + l]; if (w < m) m = w; }
	if (f.rowC[t] >= 0) for (let l = 0; l < NL; l++) { const v = f.costC[f.rowC[t] * NL + l]; if (v < m) m = v; }
	if (f.rowX[t] >= 0) for (let l = 0; l < NL; l++) { const v = f.costX[f.rowX[t] * NL + l]; if (v < m) m = v; }
	return m;
}
/** the cost a ball arriving at tile t gets in field f: the least of F(0) and R(0) (walk: the walking distance) */
function arriveCost(f, t) {
	if (f.mode === 'walk') return tileMin(f, t);
	const K1 = RF.KF + 1, Q3 = f.Q + 3;
	return Math.min(f.costF[t * K1], f.costR[t * Q3 + 1]);
}
/** the arrival cost next to tile t in field f: the least of its 8 neighbours' arrival costs + a step (CUT: none) */
function arriveNear(f, t, A) {
	const x = t % A.W, y = (t - x) / A.W;
	let g = CUT;
	for (let di = 0; di < 8; di++) {
		const x2 = x + DX8[di], y2 = y + DY8[di];
		if (x2 < 0 || y2 < 0 || x2 >= A.W || y2 >= A.H) continue;
		const v = arriveCost(f, y2 * A.W + x2);
		if (v < CUT - 1 && v + (DX8[di] && DY8[di] ? 7 : 5) < g) g = v + (DX8[di] && DY8[di] ? 7 : 5);
	}
	return g;
}
/** forward reachability of (tile, layer) from the start in the walk model: the layers reached and the layer edges */
function forwardLayers(A, M) {
	const { W, H, N } = A, S = M.S;
	const seen = new Uint8Array(S * N);
	const q = new Int32Array(S * N);
	let qh = 0, qt = 0;
	const edges = new Set();
	const add = (s, t) => { const k = s * N + t; if (!seen[k]) { seen[k] = 1; q[qt++] = k; } };
	add(M.s0, A.start.t);
	const isTrophy = new Uint8Array(N); for (const t of A.trophies) isTrophy[t] = 1;
	while (qh < qt) {
		const k = q[qh++], s = (k / N) | 0, t = k - s * N;
		if (isTrophy[t]) continue;
		const x = t % W, y = (t - x) / W;
		for (let di = 0; di < 8; di++) {
			const x2 = x + DX8[di], y2 = y + DY8[di];
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const t2 = y2 * W + x2;
			if (M.pass(t2, s) !== 1) continue;
			if (DX8[di] && DY8[di] && M.pass(y * W + x2, s) === 0 && M.pass(y2 * W + x, s) === 0) continue;
			const sp = A.specialAt[t2];
			if (sp >= 0) for (const s2 of M.transAll(s, sp)) { add(s2, t2); if (s2 !== s) edges.add(s * S + s2); } else add(s, t2);
		}
		const ex = A.portalExits.get(t);
		if (ex) for (const e of ex) if (M.pass(e, s) === 1) add(s, e);
	}
	const layers = new Uint8Array(S);
	for (let k = 0; k < S * N; k++) if (seen[k]) layers[(k / N) | 0] = 1;
	return { layers, edges };
}
/** layer s's copy of the level: gates shut -> 9, open -> 0; killers by protection; tiles that change the layer -> the
 *  trophy (goal tiles); opts.staticCoins: coins change no layer here (the coin way is the DP's) */
function layerLevel(A, M, s, opts) {
	const L = A.level, N = A.N;
	const fg = Int32Array.from(L.fg);
	const nProt = M.names.indexOf('prot'), nFx = M.names.indexOf('fx');
	const protOn = nProt >= 0 ? M.valOf(s, nProt) === 1 : null;
	const goalTiles = [];
	const goal = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const c = A.cls[i], id = fg[i];
		if (c === 3) fg[i] = M.gateOpen(i, s) ? 0 : 9;
		else if (c === 1 && protOn === true) fg[i] = 0;
		const k = A.specialAt[i];
		if (k >= 0) {
			const ts = M.transAll(s, k);
			if ((ts.length !== 1 || ts[0] !== s) && !(opts.staticCoins && A.special[k][1] === 'coins')) { fg[i] = TROPHY; goalTiles.push([i, k]); goal[i] = 1; continue; }
			const kind = A.special[k][1];
			if (nProt >= 0 && (kind === 'prot' || kind === 'reset')) fg[i] = 0;
			if (nFx >= 0 && (kind === 'fx' || kind === 'reset') && M.valOf(s, nFx) === 0) fg[i] = 0;
		}
		if (id === 360) fg[i] = 0;   // checkpoints: no death edges (the searches drop dead balls)
	}
	const wild = nFx >= 0 && M.valOf(s, nFx) === 1;
	const lv = Object.assign({}, L, { fg, gravityMult: wild ? 0.999 : L.gravityMult });
	lv._wild = wild;
	if (L.spawnsX.length > 1) { lv.spawnsX = L.spawnsX.slice(0, 1); lv.spawnsY = L.spawnsY.slice(0, 1); }
	return { lv, goalTiles, goal };
}
/** Tarjan's strongly connected components of the reached layers, sinks first */
function sccs(S, on, succ) {
	let index = 0;
	const idx = new Int32Array(S).fill(-1), low = new Int32Array(S), onSt = new Uint8Array(S), st = [], out = [];
	const visit = (v) => {
		const stack = [[v, [...succ[v]], 0]];
		idx[v] = low[v] = index++; st.push(v); onSt[v] = 1;
		while (stack.length) {
			const top = stack[stack.length - 1];
			const [u, nb] = top;
			if (top[2] < nb.length) {
				const w = nb[top[2]++];
				if (idx[w] < 0) { idx[w] = low[w] = index++; st.push(w); onSt[w] = 1; stack.push([w, [...succ[w]], 0]); }
				else if (onSt[w]) low[u] = Math.min(low[u], idx[w]);
			} else {
				stack.pop();
				if (stack.length) { const p = stack[stack.length - 1][0]; low[p] = Math.min(low[p], low[u]); }
				if (low[u] === idx[u]) { const c = []; let w; do { w = st.pop(); onSt[w] = 0; c.push(w); } while (w !== u); out.push(c); }
			}
		}
	};
	for (let v = 0; v < S; v++) if (on[v] && idx[v] < 0) visit(v);
	return out;
}
/** the median ratio of the physics cost to the walking cost over the tiles both reach (effect tiles removed) */
function kappaOf(A, rfOpts) {
	const L = A.level, fg = Int32Array.from(L.fg);
	for (let i = 0; i < A.N; i++) if ([417, 418, 419, 453, 461, 1517, 1618].includes(fg[i])) fg[i] = 0;
	const f = RF.reachField(Object.assign({}, L, { fg }), rfOpts);
	if (f.mode !== 'physics') return 1;
	const r = [];
	for (let t = 0; t < A.N; t++) {
		const w = f.walk[t];
		if (w === CUT || w < 100) continue;
		const p = tileMin(f, t);
		if (p < CUT - 1) r.push(p / w);
	}
	if (!r.length) return 1;
	r.sort((a, b) => a - b);
	return Math.max(1, r[r.length >> 1]);
}
/** a wild layer's field: walking distance in layer s x kappa from the goals, as a walk-mode field */
function wildField(A, M, s, goals, kappa) {
	const { W, H, N } = A;
	const d = new Float64Array(N).fill(Infinity);
	const heap = [];
	const hpush = (i, v) => { heap.push([v, i]); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= v) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
	const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
	for (const g of goals) { const c = Math.round(g.cost * 5); if (c < d[g.tile]) { d[g.tile] = c; hpush(g.tile, c); } }
	const goalT = new Set(goals.map((g) => g.tile));
	const isTrophy = new Set(A.trophies);
	while (heap.length) {
		const [v, t2] = hpop();
		if (v > d[t2]) continue;
		const x2 = t2 % W, y2 = (t2 - x2) / W;
		for (let di = 0; di < 8; di++) {
			const x = x2 - DX8[di], y = y2 - DY8[di];
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const t = y * W + x;
			if (goalT.has(t) || isTrophy.has(t) || M.pass(t, s) !== 1 || M.pass(t2, s) === 0 || A.forcedP[t]) continue;
			if (DX8[di] && DY8[di] && M.pass(y * W + x2, s) === 0 && M.pass(y2 * W + x, s) === 0) continue;
			const c = v + (DX8[di] && DY8[di] ? 7 : 5) * kappa;
			if (c < d[t]) { d[t] = c; hpush(t, c); }
		}
		const ps = A.portalSrcOf.get(t2);
		if (ps) for (const p of ps) if (M.pass(p, s) === 1 && !goalT.has(p)) { const c = v + 5; if (c < d[p]) { d[p] = c; hpush(p, c); } }
	}
	const walk = new Uint16Array(N).fill(CUT);
	for (let t = 0; t < N; t++) if (d[t] < Infinity) walk[t] = Math.min(CUT - 1, Math.round(d[t]));
	return { mode: 'walk', W, H, walk, cls: Uint8Array.from(A.cls), deaths: false, ice: false, prioShift: 0 };
}
/** B: walkBuild() -> {M (with fx), fields: [layer] -> field | null, goals: [layer] -> goal tile bitmap, ...} */
function buildPhysics(B, opts) {
	const t0 = Date.now();
	const { A } = B;
	const names = new Set(B.M.names);
	if (A.feats.has('fx')) names.add('fx');
	const M = makeModel(A, names);
	const fr = forwardLayers(A, M);
	const S = M.S;
	const succ = new Array(S).fill(null).map(() => new Set());
	for (const e of fr.edges) succ[Math.floor(e / S)].add(e % S);
	const comps = sccs(S, fr.layers, succ);
	const fields = new Array(S).fill(null), goalsOf = new Array(S).fill(null), copies = new Array(S).fill(null);
	const rfOpts = { oneWayEntry: true, portalForced: true, airPen: AIR_PEN };
	const kappa = A.feats.has('fx') ? kappaOf(A, rfOpts) : 0;
	let builds = 0, sweeps = 0;
	const solve = (s) => {
		if (!copies[s]) copies[s] = layerLevel(A, M, s, opts);
		const { lv, goalTiles } = copies[s];
		const goals = A.trophies.map((t) => ({ tile: t, cost: 0 }));
		for (const [t, k] of goalTiles) {
			let g = CUT;
			for (const s2 of M.transAll(s, k)) {
				const f2 = fields[s2];
				if (!f2) continue;
				// (a toggle: the tile changes layer s2 back too, so in s2's field it is a goal of its own (its cost is only
				// its seed): the ball that pressed it stands there and walks off, the least of its 8 neighbours + a step,
				// as the lookup prices it)
				const v = copies[s2] && copies[s2].goal[t] ? arriveNear(f2, t, A) : arriveCost(f2, t);
				if (v < g) g = v;
			}
			if (g < CUT) goals.push({ tile: t, cost: g / 5 });
		}
		const key = goals.map((g) => `${g.tile}:${g.cost}`).join(',');
		if (goalsOf[s] === key && fields[s]) return false;
		goalsOf[s] = key;
		fields[s] = lv._wild && kappa ? wildField(A, M, s, goals, kappa) : RF.reachField(lv, Object.assign({ goals, debug: !!opts.debug }, rfOpts));
		builds++;
		return true;
	};
	for (const comp of comps) {
		for (let it = 0; it < (comp.length > 1 ? 8 : 1); it++) {
			let changed = false;
			for (const s of comp) if (solve(s)) changed = true;
			sweeps = Math.max(sweeps, it + 1);
			if (!changed) break;
		}
	}
	return { kappa, A, M, fields, goals: copies.map((c) => (c ? c.goal : null)), sweeps, builds, layers: comps.flat().length, ms: Date.now() - t0 };
}
/** the reach field's own plan: greedy descent over its abstract states (reach.js debug edges) */
function descend(f, st0, maxSteps = 50000) {
	const m = f._m;
	let cur = st0;
	const path = [cur], seen = new Set([`${cur.t},${cur.ty},${cur.l}`]);
	for (let n = 0; n < maxSteps; n++) {
		const c = m.costOf(cur.t, cur.ty, cur.l);
		if (c === 0) break;
		let mv = null, same = null;
		m.edgesOf(cur.t, cur.ty, cur.l, (t2, ty2, l2, add) => {
			const c2 = m.costOf(t2, ty2, l2);
			if (c2 === CUT || c2 + add !== c) return;
			if (seen.has(`${t2},${ty2},${l2}`)) return;
			if (add > 0) { if (!mv) mv = { t: t2, ty: ty2, l: l2, add }; } else if (!same) same = { t: t2, ty: ty2, l: l2, add };
		});
		const nx = mv || same;
		if (!nx) break;
		cur = nx; path.push(cur); seen.add(`${cur.t},${cur.ty},${cur.l}`);
	}
	return path;
}
/** the layered physics field's own plan from a sim state: the tiles it passes */
function layeredPlan(PH, sim, maxLegs = 200) {
	const A = PH.A, M = PH.M;
	let s = M.layerOf(sim);
	let f = PH.fields[s];
	const tiles = [], legs = [];
	if (!f || !f._m) return { tiles, legs, end: 'no field' };
	const st = RF.stateOf(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
	let cur = null, why = 'no state';
	if (st) for (const [ty, l] of [...(st.base ? [st.base] : []), ...(st.rise || [])]) { const c = f._m.costOf(st.t, ty, l); if (c !== CUT && (!cur || c < cur.c)) cur = { t: st.t, ty, l, c }; }
	for (let leg = 0; leg < maxLegs && cur; leg++) {
		const path = descend(f, cur);
		for (const p of path) tiles.push(p.t);
		const end = path[path.length - 1];
		if (A.trophies.includes(end.t)) { why = 'trophy'; break; }
		const k = A.specialAt[end.t];
		if (k < 0) { why = 'stuck'; break; }
		let best = null;
		for (const s2 of M.transAll(s, k)) {
			const f2 = PH.fields[s2]; if (!f2) continue;
			const c0 = f2.mode === 'walk' ? f2.walk[end.t] : f2.costF[end.t * (RF.KF + 1)];
			if (c0 < CUT && (!best || c0 < best.c)) best = { s2, c: c0 };
		}
		if (!best) { why = 'no next layer'; break; }
		// (a leg: the tile that changes the layer, the layers before and after, the cost left there)
		legs.push({ t: end.t, s, s2: best.s2, c: best.c });
		s = best.s2; f = PH.fields[s];
		if (f.mode === 'walk' || !f._m) { why = 'walk layer'; break; }
		cur = { t: end.t, ty: RF.F_, l: 0, c: best.c };
	}
	return { tiles, legs, end: why };
}

// ------------------------------------------------------------------ distinct coins: legs, the DP
/** T (the highest coin door threshold the walk plan passes, at least minT; null: none) and the coin tiles */
function coinPlan(B, minT) {
	const { A, M } = B;
	if (M.names.indexOf('coins') < 0) return null;
	let T = 0;
	for (const p of B.plan.path) if (A.cls[p.t] === 3 && A.gateFeat[p.t] === 'coins' && A.gatePol[p.t] === 1) T = Math.max(T, A.gateParam[p.t]);
	if (minT > T) T = minT;
	if (!T) return null;
	return { T, coins: A.special.filter((x) => x[1] === 'coins').map((x) => x[0]) };
}
/** the full count: the highest count a coin DOOR of the level reads, at most the level's gold coins (0: none; a coin
 *  gate's count alone is no need: collecting it shuts something, as on Octorage).
 *  The coin plan's T comes from the walk plan, which is blind to gravity, one-way directions and speed: on Wine Quest I it
 *  passes the 5-coin door and climbs a 16-row shaft whose only footholds are 10-coin GATES (solid at 10), and the level
 *  needs all 10 coins. The plan past its count (buildSteer opts.coinT = this) is what the search turns to once the plan's
 *  own count is held and the search stalls there (editor.js pastPlan) */
function fullCoinT(A) {
	let cap = 0;
	for (let i = 0; i < A.N; i++) if (A.cls[i] === 3 && A.gateFeat[i] === 'coins' && A.gatePol[i] === 1) cap = Math.max(cap, A.gateParam[i]);
	return Math.min(cap, A.special.filter((x) => x[1] === 'coins').length);
}
/** per coin, the physics field of the collection layer (the plan's layer before its first coin, T - 1 coins) with that
 *  coin as the only goal; the tail at T coins per coin (the layered field's arrival cost) */
/** a coin leg's field (the level lv with the tiles fg: the coin q the goal): with the forced portals, unless they leave the
 *  coin out of reach from the start and from every other coin (a portal chain the model misreads: the plan would have
 *  no value at all); then without them, as main's legs were */
function legFieldOf(lv, fg, q, coins, start) {
	const f = RF.reachField(Object.assign({}, lv, { fg }), { goals: [{ tile: q, cost: 0 }], oneWayEntry: true, portalForced: true, airPen: AIR_PEN });
	if (arriveCost(f, start) < CUT) return f;
	for (const c of coins) if (c !== q && arriveCost(f, c) < CUT) return f;
	const g = RF.reachField(Object.assign({}, lv, { fg }), { goals: [{ tile: q, cost: 0 }], oneWayEntry: true, airPen: AIR_PEN });
	g.unforced = true;
	return g;
}
function coinLegsPhys(B, PH, base, opts) {
	const { A } = B;
	const M = PH.M;
	let sPlan = B.M.s0;
	for (const p of B.plan.path) if (p.via === 'touch' && A.special[A.specialAt[p.t]][1] === 'coins') break; else sPlan = p.s;
	let s = 0;
	M.feats.forEach((f, n) => { const wn = B.M.names.indexOf(f.key); const v = wn >= 0 ? B.M.valOf(sPlan, wn) : f.init; s += v * M.stride[n]; });
	const nC = M.names.indexOf('coins');
	s = M.withVal(s, nC, base.T - 1);
	const lvOf = new Map();
	const legField = (q, k) => {
		if (!lvOf.has(k)) {
			const { lv } = layerLevel(A, M, M.withVal(s, nC, k), {});
			const fg0 = Int32Array.from(lv.fg);
			for (const c of base.coins) if (fg0[c] === TROPHY) fg0[c] = 0;
			lvOf.set(k, { lv, fg0 });
		}
		const { lv, fg0 } = lvOf.get(k);
		const fg = Int32Array.from(fg0); fg[q] = TROPHY;
		return legFieldOf(lv, fg, q, base.coins, A.start.t);
	};
	const fields = new Map(), countOf = new Map();
	for (const q of base.coins) { fields.set(q, legField(q, base.T - 1)); countOf.set(q, base.T - 1); }
	const sT = M.withVal(s, nC, Math.min(base.T, M.radix[nC] - 1));
	const tail = new Map();
	for (const q of base.coins) tail.set(q, PH.fields[sT] ? arriveCost(PH.fields[sT], q) : CUT);
	const CL = { T: base.T, coins: base.coins, fields, tail, s, countOf, rounds: 0 };
	// (opts.legTour, default on: a coin's leg in the layer of the count the ball holds on its way to it along the DP's own
	// tour (the k-th coin of the tour: coins = k - 1), rebuilt until the tour stays (at most 3 rounds). The T - 1 layer
	// opens every coin door below T: on Forgotten Veil (doors for every count 1..16) coin 4's leg from coin 3 ran through
	// doors shut at 3 coins, not the known route's 1195-tick loop)
	if (!opts || opts.legTour !== false) {
		for (let round = 0; round < 3; round++) {
			const D = coinDP(CL);
			if (!D) break;
			const tour = coinTour(CL, D, A.start.t);
			let changed = 0;
			tour.forEach((q, k) => { if (countOf.get(q) !== k) { fields.set(q, legField(q, k)); countOf.set(q, k); changed++; } });
			CL.rounds = round + 1;
			if (!changed) break;
		}
	}
	return CL;
}
/** the plan past its count (opts.coinT, editor.js pastPlan): every leg in the layer of the count the ball holds when it
 *  walks it. legTour starts from the T - 1 layer and re-rounds along the DP's own tour; with coin GATES that is no start:
 *  on Wine Quest I the 9-coin layer shuts the 4-, 5-, 6- and 9-coin gates, which cut the level into parts, every
 *  10-coin tour had a cut leg and the DP no value at all. Here the DP is over (collected set, last) with the leg from
 *  coin i to coin j at count k = popcount(set) taken from j's field in layer k (n x T fields, one at a time: only the
 *  arrival costs from the coins and the start are kept), and each coin's lookup body is its field in the layer of its
 *  place on the DP's best tour from the start (a coin off that tour: layer T - 1). -> the coinLegsPhys shape {T, coins,
 *  fields, tail, s, countOf, rounds: 0, layered: {D, tour, start}} or null (over 18 coins, or past the deadline: ms) */
function coinLegsLayered(B, PH, base, deadline) {
	const { A } = B;
	const M = PH.M;
	let sPlan = B.M.s0;
	for (const p of B.plan.path) if (p.via === 'touch' && A.special[A.specialAt[p.t]][1] === 'coins') break; else sPlan = p.s;
	let s = 0;
	M.feats.forEach((f, n) => { const wn = B.M.names.indexOf(f.key); const v = wn >= 0 ? B.M.valOf(sPlan, wn) : f.init; s += v * M.stride[n]; });
	const nC = M.names.indexOf('coins');
	const coins = base.coins, n = coins.length, T = Math.min(base.T, n, M.radix[nC] - 1);
	if (n > 18 || T < 1) return null;
	const lvOf = new Map();
	const legField = (q, k) => {
		if (!lvOf.has(k)) {
			const { lv } = layerLevel(A, M, M.withVal(s, nC, k), {});
			const fg0 = Int32Array.from(lv.fg);
			for (const c of coins) if (fg0[c] === TROPHY) fg0[c] = 0;
			lvOf.set(k, { lv, fg0 });
		}
		const { lv, fg0 } = lvOf.get(k);
		const fg = Int32Array.from(fg0); fg[q] = TROPHY;
		return legFieldOf(lv, fg, q, coins, A.start.t);
	};
	// L[(k * (n + 1) + i) * n + j]: from coin i (i = n: the start) to coin j holding k coins
	const L = new Float64Array(T * (n + 1) * n).fill(Infinity);
	const Lat = (k, i, j) => L[(k * (n + 1) + i) * n + j];
	for (let k = 0; k < T; k++) {
		for (let j = 0; j < n; j++) {
			// (n x T fields: past the build's time, no plan past its count)
			if (deadline && Date.now() > deadline) return null;
			const f = legField(coins[j], k);
			for (let i = 0; i <= n; i++) {
				if (i === j || (i === n && k > 0)) continue;
				const v = arriveCost(f, i === n ? A.start.t : coins[i]);
				if (v < CUT) L[(k * (n + 1) + i) * n + j] = v;
			}
		}
	}
	const sT = M.withVal(s, nC, Math.min(T, M.radix[nC] - 1));
	const tail = new Map();
	for (const q of coins) tail.set(q, PH.fields[sT] ? arriveCost(PH.fields[sT], q) : CUT);
	const NM = 1 << n, h = new Float32Array(NM * n).fill(Infinity);
	const pc = new Uint8Array(NM);
	for (let m = 1; m < NM; m++) pc[m] = pc[m >> 1] + (m & 1);
	const byPc = [];
	for (let k = 0; k <= T; k++) byPc.push([]);
	for (let m = 1; m < NM; m++) if (pc[m] <= T) byPc[pc[m]].push(m);
	const tl = coins.map((q) => { const v = tail.get(q); return v >= CUT ? Infinity : v; });
	for (let k = T; k >= 1; k--) {
		for (const m of byPc[k]) {
			for (let last = 0; last < n; last++) {
				if (!(m & (1 << last))) continue;
				let v;
				if (k >= T) v = tl[last];
				else { v = Infinity; for (let q = 0; q < n; q++) { if (m & (1 << q)) continue; const c = Lat(k, last, q) + h[(m | (1 << q)) * n + q]; if (c < v) v = c; } }
				h[m * n + last] = v;
			}
		}
	}
	// the best tour from the start: each coin's place on it
	const place = new Int32Array(n).fill(-1), tour = [];
	let m = 0, last = n, start = Infinity;
	for (let k = 0; k < T; k++) {
		let best = -1, bv = Infinity;
		for (let q = 0; q < n; q++) {
			if (m & (1 << q)) continue;
			const v = Lat(k, last, q) + h[(m | (1 << q)) * n + q];
			if (v < bv) { bv = v; best = q; }
		}
		if (best < 0) break;
		if (k === 0) start = bv;
		place[best] = k; tour.push(coins[best]); m |= 1 << best; last = best;
	}
	const fields = new Map(), countOf = new Map();
	for (let q = 0; q < n; q++) { const k = place[q] >= 0 ? place[q] : T - 1; fields.set(coins[q], legField(coins[q], k)); countOf.set(coins[q], k); }
	return { T, coins, fields, tail, s, countOf, rounds: 0, layered: { D: { n, T, h }, tour, start } };
}
/** the DP's tour from tile t0 (the coins in order; T of them, or fewer where no leg has a value) */
function coinTour(CL, D, t0) {
	const n = D.n, tour = [];
	let m = 0, last = -1;
	for (let k = 0; k < Math.min(D.T, n); k++) {
		let best = -1, bv = Infinity;
		for (let q = 0; q < n; q++) {
			if (m & (1 << q)) continue;
			const leg = arriveCost(CL.fields.get(CL.coins[q]), last < 0 ? t0 : CL.coins[last]);
			if (leg >= CUT) continue;
			const v = leg + D.h[(m | (1 << q)) * n + q];
			if (v < bv) { bv = v; best = q; }
		}
		if (best < 0) break;
		tour.push(CL.coins[best]); m |= 1 << best; last = best;
	}
	return tour;
}
/** the exact tour over the leg-cost model (n <= 18 coins): h[mask * n + last] = the least cost (fifths) to finish from
 *  coin `last` with the coins of mask collected */
function coinDP(CL, maxN = 18) {
	const n = CL.coins.length;
	if (n > maxN) return null;
	const T = CL.T, NM = 1 << n;
	const leg = new Float64Array(n * n);
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = i === j ? Infinity : arriveCost(CL.fields.get(CL.coins[j]), CL.coins[i]); leg[i * n + j] = v >= CUT ? Infinity : v; }
	const tail = CL.coins.map((q) => { const v = CL.tail.get(q); return v >= CUT ? Infinity : v; });
	const h = new Float32Array(NM * n).fill(Infinity);
	const pc = new Uint8Array(NM);
	for (let m = 1; m < NM; m++) pc[m] = pc[m >> 1] + (m & 1);
	const byPc = [];
	for (let k = 0; k <= Math.min(T, n); k++) byPc.push([]);
	for (let m = 0; m < NM; m++) if (pc[m] <= T) byPc[pc[m]].push(m);
	for (let k = Math.min(T, n); k >= 1; k--) {
		for (const m of byPc[k]) {
			for (let last = 0; last < n; last++) {
				if (!(m & (1 << last))) continue;
				let v;
				if (k >= T) v = tail[last];
				else { v = Infinity; for (let q = 0; q < n; q++) { if (m & (1 << q)) continue; const c = leg[last * n + q] + h[(m | (1 << q)) * n + q]; if (c < v) v = c; } }
				h[m * n + last] = v;
			}
		}
	}
	return { n, T, h };
}

// ------------------------------------------------------------------ build
// the build's budget: the bodies' bytes (layers x tiles; a body ~BODY_BYTES_TILE bytes per tile: 107 on the review's
// 200 x 40 level of 10 switch ids, 1024 layers in an 873 MB file and 2.86 GB of the process) and its time. Past either,
// no more features (the layers they would add) and no coin DP (its legs are bodies too; more than 18 coins: none anyway).
// The five big jobs' levels fit (Forgotten Veil: 17 layers + the DP over 16 coins, 539 MB).
const STEER_MAX_BYTES = 640 << 20, STEER_MAX_MS = 30000, BODY_BYTES_TILE = 120;
/**
 * The steer field of a prepared level. opts: {maxLayers (4096), maxBytes (STEER_MAX_BYTES), maxMs (STEER_MAX_MS),
 * maxIters (12), noDP} -> steer: {version, W, H, feats [{key, kind, param, radix, stride}], team [values], S, layerBody
 * Int32Array(S), bodies [field], goals [Uint8Array(N)], dp {n, T, bit, leg, h} | null, prioShift, info {features, layers,
 * builds, kappa, ms, cegar, dp, over (what the budget left out, or null)}}
 */
function buildSteer(level, opts) {
	opts = opts || {};
	const t0 = Date.now();
	const A = analyze(level, opts);
	const modeled = new Set();
	const cegar = [];
	// (the budget as a layer cap: the effects double the physics layers)
	const maxBytes = opts.maxBytes || STEER_MAX_BYTES, maxMs = opts.maxMs || STEER_MAX_MS;
	const bodyBytes = A.N * BODY_BYTES_TILE;
	const maxLayers = Math.max(1, Math.min(opts.maxLayers || 4096, Math.floor(maxBytes / bodyBytes / (A.feats.has('fx') ? 2 : 1))));
	let over = null;
	const mb = `${(maxBytes / 1048576).toFixed(maxBytes < 10 << 20 ? 1 : 0)} MB of fields`, secs = `the build's time (${maxMs / 1000} s)`;
	let B, PH;
	for (let it = 0; it < (opts.maxIters || 12); it++) {
		B = walkBuild(level, A, { features: [...modeled], maxLayers, deadline: t0 + maxMs / 2 });
		if (B.capped && !over) over = `${B.capped.feat}: ${B.capped.why === 'time' ? secs : `over ${maxLayers} layers (${mb})`}`;
		for (const f of B.M.names) modeled.add(f);
		PH = buildPhysics(B, { staticCoins: true, debug: true });
		const sim = new E.EESim(level); sim.reset();
		const pl = layeredPlan(PH, sim);
		const path = [];
		for (const t of pl.tiles) {
			if (path.length && path[path.length - 1].t === t) continue;
			const q = path.length ? path[path.length - 1].t : -1, W = A.W;
			const tele = q >= 0 && (Math.abs(t % W - q % W) > 1 || Math.abs(Math.floor(t / W) - Math.floor(q / W)) > 1);
			path.push({ t, via: tele ? 'portal' : 'move' });
		}
		const cx = path.length > 1 ? counterexample(A, { path }) : null;
		cegar.push({ features: [...modeled], layers: PH.layers, builds: PH.builds, cx: cx && cx.feat });
		if (!cx || modeled.has(cx.feat) || !A.feats.has(cx.feat)) break;
		if (B.M.S * A.feats.get(cx.feat).values.length > maxLayers) { over = over || `${cx.feat}: over ${maxLayers} layers (${mb})`; break; }
		// (the next build takes longer than this one)
		if (Date.now() - t0 > maxMs / 2) { over = over || `${cx.feat}: ${secs}`; break; }
		modeled.add(cx.feat);
	}
	const M = PH.M, N = A.N;
	// the bodies: identical fields (and goal tiles) shared
	const bodies = [], goals = [], bodyKey = new Map();
	const addBody = (f, goal) => {
		const bytes = RF.reachFileBytes(f);
		const key = crypto.createHash('sha1').update(bytes).update(goal).digest('hex');
		if (bodyKey.has(key)) return bodyKey.get(key);
		bodyKey.set(key, bodies.length);
		bodies.push(stripField(f)); goals.push(goal);
		return bodies.length - 1;
	};
	const layerBody = new Int32Array(M.S).fill(-1);
	for (let s = 0; s < M.S; s++) if (PH.fields[s]) layerBody[s] = addBody(PH.fields[s], PH.goals[s]);
	// the coin DP
	let dp = null;
	// (opts.coinT: the plan's count at least that: the plan past its count, editor.js pastPlan)
	let cp = opts.noDP ? null : coinPlan(B, opts.coinT || 0);
	if (cp && ((bodies.length + cp.coins.length) * bodyBytes > maxBytes || Date.now() - t0 > maxMs)) {
		over = over || `the coin DP: ${(bodies.length + cp.coins.length) * bodyBytes > maxBytes ? `over ${mb}` : secs}`;
		cp = null;
	}
	if (cp) {
		const CL = opts.coinT ? coinLegsLayered(B, PH, cp, t0 + maxMs) : coinLegsPhys(B, PH, cp, opts);
		const D = CL && CL.layered ? CL.layered.D : CL ? coinDP(CL) : null;
		if (D) {
			const none = new Uint8Array(N);
			const bit = Int32Array.from(CL.coins, (q) => level.coinBit[q]);
			const leg = Int32Array.from(CL.coins, (q) => addBody(CL.fields.get(q), none));
			dp = { n: D.n, T: D.T, bit, leg, h: D.h, rounds: CL.rounds, tour: CL.layered ? CL.layered.tour : null };
		}
	}
	const feats = M.feats.map((f, n) => {
		const k = f.key;
		const kind = k.startsWith('key') ? 1 : k.startsWith('psw:') ? 2 : k.startsWith('osw:') ? 3 : k === 'team' ? 4 : k === 'prot' ? 5 : k === 'coins' ? 6 : k === 'bcoins' ? 7 : k === 'crown' ? 8 : 9;
		const param = kind === 1 ? +k.slice(3) : kind === 2 || kind === 3 ? +k.slice(4) : 0;
		return { key: k, kind, param, radix: M.radix[n], stride: M.stride[n] };
	});
	const teamF = M.feats.find((f) => f.key === 'team');
	const steer = { version: VERSION, W: A.W, H: A.H, N, feats, team: teamF ? teamF.values.slice() : [], S: M.S, layerBody, bodies, goals, dp, prioShift: 0 };
	steer.prioShift = prioShiftOf(steer);
	const sim0 = new E.EESim(level); sim0.reset();
	steer.info = { features: M.names, layers: PH.layers, bodies: bodies.length, builds: PH.builds, kappa: Math.round(PH.kappa * 1000) / 1000, cegar,
		dp: dp ? { n: dp.n, T: dp.T, rounds: dp.rounds, tour: dp.tour ? dp.tour.map((t) => [t % A.W, Math.floor(t / A.W)]) : undefined } : null, fullT: fullCoinT(A), start: steerAt(steer, sim0), ms: Date.now() - t0, over };
	return steer;
}
/** the lookup's fields of a reach field (the debug closures and the build's extras dropped) */
function stripField(f) {
	const out = {};
	for (const k of ['version', 'W', 'H', 'N', 'mode', 'Q', 'ice', 'deaths', 'cls', 'walk', 'prioShift', 'seg', 'segPush', 'segCap', 'rowC', 'rowX', 'costR', 'costF', 'costL', 'costC', 'costX', 'nC', 'nX', 'modMin']) if (f[k] !== undefined) out[k] = f[k];
	return out;
}
const bitLen = (v) => { let n = 0; while (v > 0) { n++; v = Math.floor(v / 2); } return n; };
/** the priority shift: the largest finite cost in 12 bits (every finite value below FAR: the bodies have no death edges,
 *  so a cost of DEATH_COST or more is a real one; Infinity Pain's bodies reach 17,981 fifths: shift 3, not 1, else 76% of
 *  its best run's states shared the top priority bucket 4095 with the states of no value) */
function prioShiftOf(st) {
	let m = 0;
	const scan = (a) => { if (!a) return; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < RF.FAR && v > m) m = v; } };
	for (const f of st.bodies) {
		if (f.mode === 'walk') scan(f.walk);
		else for (const k of ['costR', 'costF', 'costL', 'costC', 'costX']) scan(f[k]);
	}
	// (the coin way: a leg's cost + the rest of the tour)
	let mh = 0;
	if (st.dp) for (let i = 0; i < st.dp.h.length; i++) { const v = st.dp.h[i]; if (v < Infinity && v > mh) mh = v; }
	return Math.max(0, bitLen(Math.min(m + mh, 0xfffe)) - 12);
}

// ------------------------------------------------------------------ the lookup (= native/beam.h steerFifths)
/** the ball's layer (-1: none) */
function layerIndex(st, sim) {
	let s = 0;
	for (const f of st.feats) {
		let v = 0;
		switch (f.kind) {
			case 1: v = (sim._keysMask >> f.param) & 1; break;
			case 2: v = sim._switches.get(f.param) === true ? 1 : 0; break;
			case 3: v = sim._oswitches.get(f.param) === true ? 1 : 0; break;
			case 4: v = st.team.indexOf(sim.team); if (v < 0) v = 0; break;
			case 5: v = sim.is_invulnerable ? 1 : 0; break;
			case 6: v = Math.min(sim.coins, f.radix - 1); break;
			case 7: v = Math.min(sim.blue_coins, f.radix - 1); break;
			case 8: v = sim._collide_crown ? 1 : 0; break;
			case 9: v = plainFx(sim) ? 0 : 1; break;
		}
		s += v * f.stride;
	}
	return s;
}
const bodyAt = (f, sim, dx, dy) => RF.fifthsAt(f, sim.px + 16 * dx, sim.py + 16 * dy, sim.speed_y, sim._q0, sim._q1, sim._slippery);
/** the layer field's part: -1 none; `blend` true when it is the plain lookup (the beam's score blends it) */
function layerFifths(st, sim, s) {
	const b = s >= 0 && s < st.S ? st.layerBody[s] : -1;
	if (b < 0) return -1;
	const f = st.bodies[b], g = st.goals[b];
	const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
	if (tx >= 0 && ty >= 0 && tx < st.W && ty < st.H && g[ty * st.W + tx]) {
		// (on a tile that changes the layer: the ball just pressed it; the least of its 8 neighbours + a step)
		let v = -1;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const c = bodyAt(f, sim, dx, dy);
			if (c < 0 || c >= CUT - 1) continue;
			const w = c + (dx && dy ? 7 : 5);
			if (v < 0 || w < v) v = w;
		}
		return v;
	}
	const c = bodyAt(f, sim, 0, 0);
	return c >= CUT - 1 ? -1 : c;
}
/** the coin DP's part (-1: none or not below T coins); bound (fifths, or Infinity): the layer's own value, which a leg
 *  whose rest of the tour alone is not below it cannot beat (no lookup; = native/beam.h, the same minimum where it wins) */
function dpFifths(st, sim, bound) {
	const D = st.dp;
	if (!D || !(sim.coins < D.T)) return -1;
	let m = 0;
	for (let i = 0; i < D.n; i++) { const b = D.bit[i]; if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) m |= 1 << i; }
	let best = Infinity;
	for (let q = 0; q < D.n; q++) {
		if (m & (1 << q)) continue;
		const rest = D.h[(m | (1 << q)) * D.n + q];
		if (!(rest < Infinity) || rest >= best || rest >= bound) continue;
		const c = bodyAt(st.bodies[D.leg[q]], sim, 0, 0);
		if (c < 0 || c >= CUT - 1) continue;
		if (c + rest < best) best = c + rest;
	}
	return best === Infinity ? -1 : Math.floor(best + 0.5);
}
/** the coin plan's next gate from a sim's state: the untaken coin of the distinct-coin DP with the least leg + rest of the
 *  tour ({i: the DP's index, bit: the engine's coin bit, v: fifths}), or null (no DP, the coins done, no leg with a value).
 *  The wall breaker's stall target (editor.js breakGate): along the known routes the DP's first choice was the route's
 *  next coin on Forgotten Veil in 11 of 15 coins, Good Egg 12 of 17, where the lookup, the least of the DP and the layer's
 *  own field, took the layer field (the way that needs no more coins) on Forgotten Veil before its coins 1-4 */
function nextGate(st, sim) {
	const D = st.dp;
	if (!D || !(sim.coins < D.T)) return null;
	let m = 0;
	for (let i = 0; i < D.n; i++) { const b = D.bit[i]; if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) m |= 1 << i; }
	let best = null;
	for (let q = 0; q < D.n; q++) {
		if (m & (1 << q)) continue;
		const rest = D.h[(m | (1 << q)) * D.n + q];
		if (!(rest < Infinity)) continue;
		const c = bodyAt(st.bodies[D.leg[q]], sim, 0, 0);
		if (c < 0 || c >= CUT - 1) continue;
		if (!best || c + rest < best.v) best = { i: q, bit: D.bit[q], v: c + rest };
	}
	return best;
}
/** past the coin plan's count (nextGate null): the untaken coin with the least leg from the state ({i, bit, v}, null:
 *  none with a value; `skip`: a Set of coin indices left out). The plan's count comes from the walk plan, which is blind to gravity: Wine Quest I's walk plan
 *  passes its 5-coin door and a 16-row shaft whose steps are 10-coin gates; the level needs all 10 coins */
function nextCoin(st, sim, skip) {
	const D = st.dp;
	if (!D) return null;
	let best = null;
	for (let q = 0; q < D.n; q++) {
		const b = D.bit[q];
		if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) continue;
		if (skip && skip.has(q)) continue;
		const c = bodyAt(st.bodies[D.leg[q]], sim, 0, 0);
		if (c < 0 || c >= CUT - 1) continue;
		if (!best || c < best.v) best = { i: q, bit: b, v: c };
	}
	return best;
}
/** the steer cost of a sim's state in fifths of a tile (-1 = no value) */
function steerFifths(st, sim) {
	const v = layerFifths(st, sim, layerIndex(st, sim));
	// (st.dpFirst: the coin DP's value wherever it has one, the layer field's only past the coins (goexplore.js --dpFirst):
	// the layer's own way needs no more coins, and on Forgotten Veil it is a false one (the portal at (77,109)))
	if (st.dpFirst) { const d = dpFifths(st, sim, Infinity); return d < 0 ? v : d; }
	const d = dpFifths(st, sim, v >= 0 ? v : Infinity);
	return d < 0 ? v : v < 0 ? d : Math.min(v, d);
}
/** tiles (NaN = no value) */
function steerAt(st, sim) { const v = steerFifths(st, sim); return v < 0 ? NaN : v / 5; }
/** the beam's score (tiles, a float; -1 = no value): the layer field's blend (reach.js scoreAt) where the own value is
 *  the plain layer lookup, else own / 5 */
function steerScore(st, sim) {
	const s = layerIndex(st, sim);
	const own = steerFifths(st, sim);
	if (own < 0) return -1;
	const b = st.layerBody[s];
	if (b >= 0) {
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		const onGoal = tx >= 0 && ty >= 0 && tx < st.W && ty < st.H && st.goals[b][ty * st.W + tx];
		const c = onGoal ? -1 : bodyAt(st.bodies[b], sim, 0, 0);
		if (c === own) return RF.scoreAt(st.bodies[b], sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
	}
	return Math.fround(own / 5);
}

// ------------------------------------------------------------------ the file
const al8 = (n) => (n + 7) & ~7;
function steerFileBytes(st, levelFp) {
	const N = st.N;
	const bodyBytes = st.bodies.map((f) => RF.reachFileBytes(f, levelFp));
	const dp = st.dp;
	const parts = [];
	const i32 = (a) => Buffer.from(Int32Array.from(a).buffer);
	parts.push(i32(st.feats.flatMap((f) => [f.kind, f.param, f.radix, f.stride])));
	parts.push(i32(st.team));
	parts.push(i32(st.layerBody));
	const offIdx = parts.length;
	parts.push(Buffer.alloc(8 * st.bodies.length), Buffer.alloc(8 * st.bodies.length));
	parts.push(Buffer.concat(st.goals.map((g) => Buffer.from(g.buffer, g.byteOffset, N))));
	const bodyIdx = parts.length;
	for (const b of bodyBytes) parts.push(b);
	if (dp) { parts.push(i32(dp.bit)); parts.push(i32(dp.leg)); parts.push(Buffer.from(Float32Array.from(dp.h).buffer)); }
	let size = 64;
	const offs = [];
	for (const p of parts) { size = al8(size); offs.push(size); size += p.length; }
	const offB = Buffer.alloc(8 * st.bodies.length), sizB = Buffer.alloc(8 * st.bodies.length);
	bodyBytes.forEach((b, k) => { offB.writeBigUInt64LE(BigInt(offs[bodyIdx + k]), 8 * k); sizB.writeBigUInt64LE(BigInt(b.length), 8 * k); });
	parts[offIdx] = offB; parts[offIdx + 1] = sizB;
	const buf = Buffer.alloc(al8(size));
	buf.write('RCH4', 0, 'latin1');
	[VERSION, st.W, st.H, st.feats.length, st.S, st.bodies.length, dp ? 1 : 0, st.prioShift, st.team.length, dp ? dp.n : 0, dp ? dp.T : 0].forEach((v, k) => buf.writeInt32LE(v, 4 + 4 * k));
	if (levelFp) { buf.writeUInt32LE(levelFp[0] >>> 0, 48); buf.writeUInt32LE(levelFp[1] >>> 0, 52); }
	parts.forEach((p, k) => p.copy(buf, offs[k]));
	return buf;
}
function writeSteerFile(st, file, levelFp) { require('fs').writeFileSync(file, steerFileBytes(st, levelFp)); }
/** an RCH3 file's bytes -> a reach field for the lookups (fifthsAt / scoreAt) */
function readReachBytes(buf) {
	if (buf.toString('latin1', 0, 4) !== 'RCH3') throw new Error('not an RCH3 field');
	const I = (k) => buf.readInt32LE(4 + 4 * k);
	const W = I(1), H = I(2), walk = I(3) === 1, Q = I(4), prioShift = I(5), fl = I(6), nC = I(7), nX = I(8), nSeg = I(9), nFl = I(10), NFV = I(11), NTH = I(12);
	const N = W * H;
	let o = 192;
	const ab = buf.buffer, bo = buf.byteOffset;
	const take = (Ctor, n) => { o = al8(o); const a = (bo + o) % Ctor.BYTES_PER_ELEMENT === 0 ? new Ctor(ab, bo + o, n) : new Ctor(Uint8Array.from(buf.subarray(o, o + n * Ctor.BYTES_PER_ELEMENT)).buffer); o += n * Ctor.BYTES_PER_ELEMENT; return a; };
	const f = { version: 3, W, H, N, mode: walk ? 'walk' : 'physics', Q, prioShift, deaths: (fl & 1) !== 0, ice: (fl & 2) !== 0 };
	f.cls = take(Uint8Array, N); f.seg = take(Uint8Array, N); f.rowC = take(Int32Array, N); f.rowX = take(Int32Array, N); f.walk = take(Uint16Array, N);
	if (!walk) { f.costR = take(Uint16Array, N * (Q + 3)); f.costF = take(Uint16Array, N * 17); f.costL = take(Uint16Array, N * 17); f.costC = take(Uint16Array, nC * 128); f.costX = take(Uint16Array, nX * 128); }
	f.segPush = take(Float64Array, nSeg); f.segCap = take(Float64Array, nSeg); f.modMin = take(Float64Array, nFl);
	f.nC = nC; f.nX = nX;
	void NFV; void NTH;
	return f;
}
/** an RCH4 file's bytes -> the steer lookup data (steerFifths / steerAt / steerScore); levelFp [lo, hi] */
function readSteerFile(buf) {
	if (buf.toString('latin1', 0, 4) !== 'RCH4') throw new Error('not an RCH4 steer field');
	const I = (k) => buf.readInt32LE(4 + 4 * k);
	const ver = I(0), W = I(1), H = I(2), nFeat = I(3), S = I(4), nBodies = I(5), flags = I(6), prioShift = I(7), nTeam = I(8), dpN = I(9), dpT = I(10);
	if (ver !== VERSION) throw new Error(`steer field version ${ver}, not ${VERSION}`);
	const N = W * H;
	let o = 64;
	const ints = (n) => { o = al8(o); const a = new Int32Array(n); for (let k = 0; k < n; k++) a[k] = buf.readInt32LE(o + 4 * k); o += 4 * n; return a; };
	const fa = ints(4 * nFeat);
	const feats = [];
	for (let k = 0; k < nFeat; k++) feats.push({ kind: fa[4 * k], param: fa[4 * k + 1], radix: fa[4 * k + 2], stride: fa[4 * k + 3] });
	const team = Array.from(ints(nTeam));
	const layerBody = ints(S);
	o = al8(o);
	const bOff = [], bSize = [];
	for (let k = 0; k < nBodies; k++) bOff.push(Number(buf.readBigUInt64LE(o + 8 * k)));
	o += 8 * nBodies; o = al8(o);
	for (let k = 0; k < nBodies; k++) bSize.push(Number(buf.readBigUInt64LE(o + 8 * k)));
	o += 8 * nBodies; o = al8(o);
	// (views on the file's bytes: the CPU search's workers share one copy)
	const goals = [];
	for (let k = 0; k < nBodies; k++) goals.push(new Uint8Array(buf.buffer, buf.byteOffset + o + k * N, N));
	const bodies = bOff.map((b, k) => readReachBytes(buf.subarray(b, b + bSize[k])));
	let dp = null;
	if (flags & 1) {
		o = bOff.length ? bOff[nBodies - 1] + bSize[nBodies - 1] : o + nBodies * N;
		const bit = ints(dpN), leg = ints(dpN);
		o = al8(o);
		const nh = (1 << dpN) * dpN;
		let h;
		if ((buf.byteOffset + o) % 4 === 0) h = new Float32Array(buf.buffer, buf.byteOffset + o, nh);
		else { h = new Float32Array(nh); for (let k = 0; k < nh; k++) h[k] = buf.readFloatLE(o + 4 * k); }
		dp = { n: dpN, T: dpT, bit, leg, h };
	}
	return { version: ver, W, H, N, feats, team, S, layerBody, bodies, goals, dp, prioShift, levelFp: [buf.readUInt32LE(48), buf.readUInt32LE(52)], bodyOff: bOff, bodySize: bSize };
}

module.exports = { VERSION, STEER_MAX_BYTES, STEER_MAX_MS, buildSteer, steerFifths, steerAt, steerScore, layerIndex, nextGate, nextCoin, steerFileBytes, writeSteerFile, readSteerFile, readReachBytes,
	// (tests, tools)
	analyze, makeModel, walkBuild, buildPhysics, counterexample, layeredPlan, coinPlan, fullCoinT, coinLegsPhys, coinLegsLayered, coinDP, arriveCost };
