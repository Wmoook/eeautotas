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
// until the plans are valid (or 4096 layers); then the floor probe (probeFloors): a gate the physics plan, with the gates
// it cannot stand on made doors, jumps from while it is air in the full state names its feature too (a coin gate's count
// the coin DP's T). Per reached layer (walk model, from the start): reach.js's field on a copy
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
//   i32 dpLeg[dpN] (its leg field's body), f32 h[2^dpN x dpN]; the CPU file alone (steerFileBytes(st, fp, true), flags
//   2: the coin tour, no DP) its tour section at the u64 offset at 56: i32 [n, T, first, 0], i32 bit[n], i32 order[n],
//   f32 tail[n], f32 C[n x n], u16 legs[n x N] (the GPU tools never get flags 2: editor.js's steerCpu file); flags 4 (the
//   CPU file alone, with 1): the coin DP outside the layer product (the budget left the coins out), below dpT the larger
//   of it and the layer field's, its leg bodies after the layer bodies (the GPU file has neither); the tour's `first` 2:
//   the tour outside the layer product, the larger of both below T; flags 16 (the CPU file alone, with 1 | 4): the DP
//   counts BLUE coins (dpT against sim.blue_coins), flags 32: its legs per layer, i32 legS[dpN x S] after h (the body of
//   coin q's leg for a ball in layer s, -1: none; the blue DP, kindLegs).
const crypto = require('crypto');
const E = require('./eesim.js');
const RF = require('./reach.js');

const VERSION = 4;
const TROPHY = 121, CROWN_ID = 5;
const KEY_IDS = [6, 7, 8, 408, 409, 410];
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
const CUT = RF.CUT;
const INF = 0xffffffff;
// door / gate ids -> [feature, polarity (1: open when on / satisfied)]; exact statics (gold border: off; silver crown:
// only the trophy gives it); time doors / gates 'time' (below); death doors and zombie doors / gates open. 50 (the secret
// "appear" block, eesim.js F_DOOR) is no door: it always blocks, a wall by reach.js guideFlags (before 2026-09-28 it fell
// through to open: This is not snow's trophy fenced by six of them)
// TIME DOORS (156 open in the second half of every 1000 ticks, 157 in the first: never both shut): 'time', passable in
// the walk and physics models (no layer: the phase is the clock's, not the ball's); the walk plan pays TIME_WAIT fifths to
// enter one from a tile that is not of its own id (half the half period: the mean wait of 250 ticks, as tiles). Until
// 2026-09-29 they were static walls: a level whose only way passes one had 'start has no way', one layer, no CEGAR and no
// steer value anywhere (ML's First Samurai's start falls through a column of them; Phina, SPOT THE DIDFERNECE, MKco,
// Mr Nutty's). EEAT_TIMEDOOR=0 (or opts.timeDoors false): walls, as before (and no key expiry, below)
const TIME_WAIT = 250;
const GATE = new Map([
	[23, ['key0', 1]], [24, ['key1', 1]], [25, ['key2', 1]], [26, ['key0', 0]], [27, ['key1', 0]], [28, ['key2', 0]],
	[1005, ['key3', 1]], [1006, ['key4', 1]], [1007, ['key5', 1]], [1008, ['key3', 0]], [1009, ['key4', 0]], [1010, ['key5', 0]],
	[184, ['psw', 1]], [185, ['psw', 0]], [1079, ['osw', 1]], [1080, ['osw', 0]],
	[43, ['coins', 1]], [165, ['coins', 0]], [213, ['bcoins', 1]], [214, ['bcoins', 0]],
	[1027, ['team', 1]], [1028, ['team', 0]], [1094, ['crown', 1]], [1095, ['crown', 0]],
	[200, ['static', 0]], [201, ['static', 1]], [1152, ['static', 0]], [1153, ['static', 1]],
	[156, ['time', 1]], [157, ['time', 1]], [1011, ['open', 1]], [1012, ['open', 1]], [206, ['open', 1]], [207, ['open', 1]],
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
	// (the guidance's flags, reach.js guideFlags: 50, the secret "appear" block, is a wall, not a door of "the rest open")
	const fg = level.fg, flags = RF.guideFlags(level), nF = flags.length, gF = level.gFlags, lk = level.lookup0;
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
	const timeDoors = timeDoorsOn(opts), keyExpiry = keyExpiryOn(opts);
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const hr = (fl(id) & F_HALF) ? lk[i] : -1;
		let g = GATE.get(id);
		if (g && g[0] === 'coins' && lk[i] > goldCoins) g = ['static', g[1] === 1 ? 0 : 1];
		if (g && g[0] === 'time' && !timeDoors) g = ['static', 0];
		if (g) {
			const [f, pol] = g;
			const key = f === 'psw' || f === 'osw' ? `${f}:${lk[i]}` : f;
			gateFeat[i] = key; gatePol[i] = pol; gateParam[i] = lk[i];
			cls[i] = 3;
			if (f !== 'static' && f !== 'open' && f !== 'time') addFeat(key).gates++;
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
		const silent = RF.silentPortals(level);   // (portals EE never teleports from: no exits)
		for (let i = 0; i < N; i++) {
			const s = level.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || cls[i] === 0 || silent[i]) continue;
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
	const hasTime = gateFeat.includes('time');
	const A = { level, W, H, N, cls, oneWay, gateFeat, gatePol, gateParam, special, specialAt, feats, portalExits, portalSrcOf, forcedP, trophies, start, opts, keyExpiry, hasTime };
	halfQuadMoves(A, fg, flags, lk);
	return A;
}
/**
 * The half-block quadrants in the walk layers (reach.js quadOf / moveOK: the moves the ball's box cannot make next to
 * half blocks, exact): A.Q the static quadrants (walls, half blocks by rotation; gates free), A.qMove per (tile, 8
 * directions, DX8 / DY8 order): 0 the old rule (no half block near, or the move open in every layer), 1 closed in every
 * layer, 2 by the layer's gates (qMoveOK). Null without half blocks or with EEAT_HALFQUAD=0 (opts.halfQuad false): the
 * layers as before. NSFW Spring Relics: its capsule's portals (10, 188) etc. are reached only through a right half block
 * over a team-3 door; in the team-0 layers the walk plan went up the half block's tile and the diagonal past it (the
 * steer's capsule 140 tiles, the portal 1.4 tiles on), which the box cannot do
 */
function halfQuadMoves(A, fg, flags, lk) {
	A.Q = null; A.qMove = null;
	if (!RF.halfQuadOn(A.opts)) return;
	const { W, H, N, cls, gateFeat, gatePol } = A;
	const Qg = RF.quadOf(W, H, fg, flags, lk, null);
	if (!Qg.half) return;
	const Q = Qg.Q;
	// (a gate always open / always shut whatever the layer; the others by the layer)
	const gAlways = new Int8Array(N);   // 1 open, -1 shut, 0 by the layer (or no gate)
	for (let i = 0; i < N; i++) {
		if (cls[i] !== 3) continue;
		const k = gateFeat[i];
		gAlways[i] = k === 'open' || k === 'time' ? 1 : k === 'static' ? (gatePol[i] === 1 ? 1 : -1) : 0;
	}
	const inW = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
	const qaOf = (shutAll) => (x, y) => { if (!inW(x, y)) return 15; const i = y * W + x; return cls[i] === 3 && (gAlways[i] === -1 || (shutAll && gAlways[i] === 0)) ? 15 : Q[i]; };
	const trOf = (shutAll) => (x, y) => { if (!inW(x, y)) return false; const i = y * W + x; return cls[i] !== 0 && !(cls[i] === 3 && (gAlways[i] === -1 || (shutAll && gAlways[i] === 0))); };
	const qaO = qaOf(false), qaS = qaOf(true), trO = trOf(false), trS = trOf(true);
	const near = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const q = Q[i];
		if (q === 0 || q === 15) continue;
		const x = i % W, y = (i / W) | 0;
		for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) near[yy * W + xx] = 1;
	}
	const qMove = new Uint8Array(N * 8);
	let any = 0;
	for (let t = 0; t < N; t++) {
		if (!near[t]) continue;
		const x = t % W, y = (t / W) | 0;
		for (let di = 0; di < 8; di++) {
			const x2 = x + DX8[di], y2 = y + DY8[di];
			if (!inW(x2, y2)) continue;
			if (!RF.moveOK(qaO, trO, x, y, di)) { qMove[t * 8 + di] = 1; any++; }
			else if (!RF.moveOK(qaS, trS, x, y, di)) { qMove[t * 8 + di] = 2; any++; }
		}
	}
	if (!any) return;
	A.Q = Q; A.qMove = qMove; A.qGate = gAlways;
}
/** the move from tile t in direction di (DX8 / DY8) by the half-block quadrants, a gate i shut when shut(i) (for
 *  qMove 2), the side tiles by transit(i) */
function qMoveOK(A, t, di, shut, transit) {
	const { W, H, Q, cls } = A;
	const qa = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return 15; const i = y * W + x; return cls[i] === 3 && shut(i) ? 15 : Q[i]; };
	const tr = (x, y) => x >= 0 && y >= 0 && x < W && y < H && transit(y * W + x);
	return RF.moveOK(qa, tr, t % W, (t / W) | 0, di);
}
/** qMove in layer s of model M: false = the move is closed there */
function qMoveLayer(A, M, t, di, s) {
	const q = A.qMove[t * 8 + di];
	if (q === 0) return true;
	if (q === 1) return false;
	return qMoveOK(A, t, di, (i) => !M.gateOpen(i, s), (i) => M.pass(i, s) !== 0);
}
/** the exit from the entry in the steer's reach fields (reach.js opts.exitEntry: a same-rotation portal's teleport maps
 *  the entry state to the exit state; default on; EEAT_EXITENTRY=0: the most any teleport gives, as before) */
function exitEntryOn() { return process.env.EEAT_EXITENTRY !== '0'; }
/** the time doors' class on (default; EEAT_TIMEDOOR=0 or opts.timeDoors === false: static walls, as before 2026-09-29) */
function timeDoorsOn(opts) { return opts && opts.timeDoors !== undefined ? !!opts.timeDoors : process.env.EEAT_TIMEDOOR !== '0'; }
/** key expiry in the layer graph (default; EEAT_TIMEDOOR=0, EEAT_KEYEXPIRY=0 or opts.keyExpiry === false: off) */
function keyExpiryOn(opts) { return opts && opts.keyExpiry !== undefined ? !!opts.keyExpiry : process.env.EEAT_TIMEDOOR !== '0' && process.env.EEAT_KEYEXPIRY !== '0'; }
/** the walk plan's cost of the step from tile t into tile t2 (fifths): 5 straight, 7 diagonal, + TIME_WAIT into a time
 *  door / gate from a tile that is not of its id (a column of one id opens at once; a door next to a gate needs the phase
 *  to turn) */
function stepCost(A, t, t2, diag) {
	const c = diag ? 7 : 5;
	if (A.gateFeat[t2] !== 'time') return c;
	return A.gateFeat[t] === 'time' && A.level.fg[t] === A.level.fg[t2] ? c : c + TIME_WAIT;
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
		if (k === 'open' || k === 'time') return true;
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
	// KEY EXPIRY (A.keyExpiry): a key runs out 500 ticks after it is taken (eesim.js KEY_TICKS), so in every layer with a
	// key colour on, the ball can be at the same tile with it off: an edge (tile, key on) -> (tile, key off) at cost 0 (a
	// relaxation: the wait is free, as the key's own time is). Without it the layers past a key door with the key run out
	// were never reached (no field: Super Mario Bros. 3's steer NaN for 16k ticks past its yellow door) and a key layer's
	// own key gates never reopened (Mr Nutty's green key: no value at the start). keyN: the modelled key features
	const keyN = A.keyExpiry ? feats.map((f, n) => (f.key.startsWith('key') ? n : -1)).filter((n) => n >= 0) : [];
	/** the layers a ball in layer s reaches by keys running out, one colour at a time (EMPTY: none) */
	const expire = (s) => { let out = null; for (const n of keyN) if (valOf(s, n) === 1) (out || (out = [])).push(withVal(s, n, 0)); return out || EMPTY; };
	/** a gate of a feature the model leaves out (open in every layer: the floor probe's copies keep it a door) */
	function unmodelledGate(i) {
		const k = A.gateFeat[i];
		if (!k || k === 'open' || k === 'time' || k === 'static' || idx.has(k)) return false;
		const f = allF.get(k);
		return !!f && !f.static;
	}
	return { feats, S, s0, radix, stride, valOf, withVal, pass, trans, transAll, inv, layerOf, identity, gateOpen, unmodelledGate, keyN, expire, names: feats.map((f) => f.key) };
}

// ------------------------------------------------------------------ the walk model: a backward Dijkstra over tile x layer
function layeredField(A, M) {
	const { W, H, N } = A, S = M.S;
	const cost = new Uint32Array(S * N).fill(INF);
	// (a ring of cost buckets longer than the longest edge: 7, or 7 + TIME_WAIT into a time door)
	const NB = A.hasTime ? 512 : 8, MASK = NB - 1;
	const bk = [], bn = new Int32Array(NB);
	for (let b = 0; b < NB; b++) bk.push(new Int32Array(A.hasTime ? 256 : 4096));
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
	const srcList = A.portalSrcOf, forcedP = A.forcedP, qMove = A.qMove || null;
	while (queued > 0) {
		const b = cur & MASK;
		for (let n = 0; n < bn[b]; n++) {
			const st = bk[b][n];
			queued--;
			if (cost[st] !== cur) continue;
			pops++;
			const s2 = (st / N) | 0, t2 = st - s2 * N;
			// (key expiry: (t2, the key on) -> (t2, s2) at cost 0, where the ball can stand with the key on)
			for (const n of M.keyN) if (M.valOf(s2, n) === 0) { const s1 = M.withVal(s2, n, 1); if (pass(t2, s1) === 1) push(s1 * N + t2, cur); }
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
					if (qMove !== null && qMove[t * 8 + di] !== 0 && !qMoveLayer(A, M, t, di, s)) continue;
					push(base + t, cur + stepCost(A, t, t2, DX8[di] !== 0 && DY8[di] !== 0));
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
			if (A.qMove && A.qMove[t * 8 + di] !== 0 && !qMoveLayer(A, M, t, di, s)) continue;
			const k = A.specialAt[t2];
			for (const s2 of (k >= 0 ? M.transAll(s, k) : [s])) {
				const c2 = cost[s2 * N + t2];
				if (c2 === INF) continue;
				const tot = c2 + stepCost(A, t, t2, DX8[di] !== 0 && DY8[di] !== 0);
				if (tot === c && (!best || tot < best.c)) best = { t: t2, s: s2, c: tot, via: s2 !== s ? 'touch' : 'move' };
			}
		}
		const ex = A.portalExits.get(t);
		if (ex && !best) for (const e of ex) { const c2 = cost[s * N + e]; if (c2 !== INF && c2 + 5 === c) { best = { t: e, s, c: c2 + 5, via: 'portal', from: t }; break; } }
		// (a key running out where the ball stands: the same tile, the key's colour off)
		if (!best) for (const n of M.keyN) { if (M.valOf(s, n) !== 1) continue; const s2 = M.withVal(s, n, 0); if (cost[s2 * N + t] === c) { best = { t, s: s2, c, via: 'expire', feat: M.feats[n].key }; break; } }
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
		if (p.via === 'expire') { if (st[p.feat] !== undefined) st[p.feat] = 0; continue; }
		if (p.via === 'portal' || p.via === 'death') continue;
		const t = p.t, c = A.cls[t];
		const q = plan.path[n - 1].t, W = A.W;
		const ddx = (t % W) - (q % W), ddy = Math.floor(t / W) - Math.floor(q / W);
		const closed = (i) => A.cls[i] === 0 || (A.cls[i] === 3 && A.gateFeat[i] !== 'open' && A.gateFeat[i] !== 'time' && (A.gateFeat[i] === 'static' ? A.gatePol[i] !== 1 : st[A.gateFeat[i]] !== undefined && !testGate(A.gateFeat[i], A.gatePol[i], A.gateParam[i], st[A.gateFeat[i]])));
		if (ddx && ddy && Math.abs(ddx) === 1 && Math.abs(ddy) === 1) {
			const a = q + ddx, b = q + ddy * W;
			if (closed(a) && closed(b)) { const g = A.cls[a] === 3 && A.gateFeat[a] !== 'static' ? a : b; if (A.cls[g] === 3 && A.gateFeat[g] !== 'static') return { feat: A.gateFeat[g], step: n, t: g }; }
		}
		// (the half-block quadrants: a move the full state's gates close next to a half block names the first closed gate
		// of the 3 x 3 tiles around its start and end)
		if (A.qMove && Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1 && (ddx || ddy)) {
			let di = 0; while (DX8[di] !== ddx || DY8[di] !== ddy) di++;
			if (A.qMove[q * 8 + di] === 2 && !qMoveOK(A, q, di, closed, (i) => !closed(i))) {
				const qx = q % W, qy = (q / W) | 0;
				for (let yy = qy - 2; yy <= qy + 2; yy++) for (let xx = qx - 2; xx <= qx + 2; xx++) {
					if (xx < 0 || yy < 0 || xx >= W || yy >= A.H) continue;
					const g = yy * W + xx;
					if (A.cls[g] === 3 && A.gateFeat[g] !== 'static' && A.gateFeat[g] !== 'open' && A.gateFeat[g] !== 'time' && closed(g)) return { feat: A.gateFeat[g], step: n, t: g };
				}
			}
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
		// (a key running out here: the key-off layer at the same tile)
		for (const s2 of M.expire(s)) if (M.pass(t, s2) === 1) { add(s2, t); edges.add(s * S + s2); }
		const x = t % W, y = (t - x) / W;
		for (let di = 0; di < 8; di++) {
			const x2 = x + DX8[di], y2 = y + DY8[di];
			if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
			const t2 = y2 * W + x2;
			if (M.pass(t2, s) !== 1) continue;
			if (DX8[di] && DY8[di] && M.pass(y * W + x2, s) === 0 && M.pass(y2 * W + x, s) === 0) continue;
			if (A.qMove && A.qMove[t * 8 + di] !== 0 && !qMoveLayer(A, M, t, di, s)) continue;
			const sp = A.specialAt[t2];
			if (sp >= 0) for (const s2 of M.transAll(s, sp)) { add(s2, t2); if (s2 !== s) edges.add(s * S + s2); } else add(s, t2);
		}
		const ex = A.portalExits.get(t);
		if (ex) for (const e of ex) if (M.pass(e, s) === 1) add(s, e);
	}
	const layers = new Uint8Array(S);
	for (let k = 0; k < S * N; k++) if (seen[k]) layers[(k / N) | 0] = 1;
	// (seen[s * N + t]: (tile, layer) reached: the blue legs' arrival layers at a coin, kindLegs)
	return { layers, edges, seen };
}
/** layer s's copy of the level: gates shut -> 9, open -> 0; killers by protection; tiles that change the layer -> the
 *  trophy (goal tiles); opts.staticCoins: coins change no layer here (the coin way is the DP's); opts.probeDoors (the
 *  floor probe, probeFloors): a count gate or door (gold / blue coins) the model leaves out, and a count gate (solid from
 *  its count on) open in this layer, keep their door block: passable AND a floor, as the RCH3 field has every door;
 *  probeDoors 'all': every gate of a feature the model leaves out too (keys, switches, team, crown) (`doors`: how many;
 *  0 = the plain copy) */
function layerLevel(A, M, s, opts) {
	const L = A.level, N = A.N;
	const fg = Int32Array.from(L.fg);
	const nProt = M.names.indexOf('prot'), nFx = M.names.indexOf('fx');
	const protOn = nProt >= 0 ? M.valOf(s, nProt) === 1 : null;
	const goalTiles = [];
	const goal = new Uint8Array(N);
	let doors = 0;
	for (let i = 0; i < N; i++) {
		const c = A.cls[i], id = fg[i];
		if (c === 3) {
			const open = M.gateOpen(i, s);
			const cnt = A.gateFeat[i] === 'coins' || A.gateFeat[i] === 'bcoins';
			if (opts.probeDoors && ((M.unmodelledGate(i) && (cnt || opts.probeDoors === 'all')) || (open && A.gatePol[i] === 0 && cnt))) doors++;
			else fg[i] = open ? 0 : 9;
		} else if (c === 1 && protOn === true) fg[i] = 0;
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
	return { lv, goalTiles, goal, doors };
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
			if (A.qMove && A.qMove[t * 8 + di] !== 0 && !qMoveLayer(A, M, t, di, s)) continue;
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
/** a layer's goal list as a short key (the value iteration's "no change"): the count and two 32-bit hashes of (tile,
 *  fifths) (the list was joined as a string; with key expiry it holds every tile) */
function goalsKey(goals) {
	let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
	for (const g of goals) {
		const a = g.tile | 0, b = Math.round(g.cost * 5) | 0;
		h1 = Math.imul(h1 ^ a, 0x01000193); h1 = Math.imul(h1 ^ b, 0x01000193);
		h2 = Math.imul(h2 ^ b, 0x85ebca6b) + a | 0; h2 ^= h2 >>> 13;
	}
	return `${goals.length}:${h1 >>> 0}:${h2 >>> 0}`;
}
/** THE LAYER MEMO (n3-steer-no-start-census, 2026-09-29; DEFAULT ON ('same') since d4-steer-memo-ab: off with
 *  `buildSteer(level, {layerMemo: false})` or `EEAT_STEER_MEMO=0`: the build as before). A layer's field is a function
 *  of its level copy alone (layerLevel's fg: the gates shut / open in that layer, the killers by its protection, its goal tiles; the wild flag, which sets the
 *  gravity multiplier and the wild walk) and of its goals (tile, cost): every other input (the level, the reach options,
 *  kappa) is the same for every layer of one buildPhysics call. So two layers with the same copy and the same goals get
 *  the same field (reachField and wildField are deterministic) and the memo builds it once: the coin layers between two
 *  coin door counts are identical copies (with staticCoins a coin tile changes no layer, so no goal either). The
 *  campaign's late steer fields (the product's STEER_WAIT_MS 15 s: the search ordered by RCH3 until they came) spent
 *  most of their build on such repeats (the laptop, one thread): Kerred Megaman 51 layer fields, 9 distinct (42 repeats,
 *  9.3 of 15.0 s), The 5 Realms Of Afar 172 fields, 26 distinct (146 repeats, 34.3 of 44.2 s). The file is the same byte
 *  for byte (the bodies are deduplicated by their bytes anyway); the build's time budget (buildSteer: no feature past half
 *  of maxMs, no DP past maxMs, the tour's deadline) decides on a clock that counts each repeat as built again ('same', the
 *  default of the knob), so a budget-cut build cuts the same things, sooner; 'spend' lets the saved time buy more
 *  (layerMemoOn). Ordering only; the reach field and its -1 are not touched.
 *  Where the fields live: an entry goes when no layer holds it, except (1) the last `MEMO_SPARE_BYTES` of fields this
 *  call built and let go (a strongly connected pair of layers, a key layer and its expiry, iterates 3-8 sweeps, and the
 *  next pair with the same copies goes through the same sweeps: with only the held fields kept The 5 Realms built 98 of
 *  its 173 fields, with the spares 26 + its 1 kappa field), and (2) the fields of the CEGAR's previous build (buildSteer
 *  passes one memo to every buildPhysics of a build: those fields are alive during the next call anyway, its PH holds
 *  them until the call returns); at a call's end the memo keeps exactly the fields its layers hold. A wild layer's field
 *  (wildField: the walk x kappa) also reads the model's killers (makeModel pass: protection modelled or not), so its key
 *  carries the modelled features (`tag`); a physics layer's reachField reads its level copy alone. */
const MEMO_SPARE_BYTES = 128 << 20;
/** the memo's mode: false (off), 'same' (the default; opts.layerMemo true / EEAT_STEER_MEMO unset or 1: the build's budget decides on a clock
 *  that counts every repeat as built again, so the same features, coin DP and tour as without the memo, sooner) or
 *  'spend' (opts.layerMemo 'spend' / EEAT_STEER_MEMO=2: the real clock, so the time saved can buy a feature, the DP or
 *  the tour the budget cut before: The 5 Realms Of Afar under load key0 and 62 layers in 16.5 s where the base dropped
 *  key0 at 19.5 s, but YMCK Puzzle Parade 100 s where the base stopped at 33 s: a feature let in at 14 s is not bounded) */
function layerMemoOn(opts) {
	const env = process.env.EEAT_STEER_MEMO;
	// (DEFAULT ON since d4-steer-memo-ab, 2026-09-29: 'same' unless EEAT_STEER_MEMO=0 / layerMemo false; the box A/B in
	// CLAUDE.md's steer row)
	const v = opts && opts.layerMemo !== undefined ? opts.layerMemo : env === '0' || env === 'off' ? false : env === '2' || env === 'spend' ? 'spend' : true;
	return v === 'spend' ? 'spend' : v ? 'same' : false;
}
/** the memo's key of layer copy c with goals: sha1 of its fg, the wild flag, the tag and the goals' (tile, cost) in
 *  order (the fg's hash once per copy) */
function layerMemoKey(c, goals, tag) {
	if (!c.fgHash) c.fgHash = crypto.createHash('sha1').update(Buffer.from(c.lv.fg.buffer, c.lv.fg.byteOffset, c.lv.fg.byteLength)).digest('hex');
	const g = new Float64Array(goals.length * 2);
	goals.forEach((x, i) => { g[2 * i] = x.tile; g[2 * i + 1] = x.cost; });
	return `${c.fgHash}:${c.lv._wild ? 1 : 0}:${tag}:${crypto.createHash('sha1').update(Buffer.from(g.buffer)).digest('hex')}`;
}
/** layer s's goals ({tile, cost} tiles): the trophies at 0, each tile that changes the layer at the next layer's arrival
 *  cost there (fields: the layers' fields so far; isGoal(s2, t): tile t changes layer s2 too), and with key expiry every
 *  tile at the key-off layer's arrival cost */
function layerGoals(A, M, s, goalTiles, fields, isGoal) {
	const goals = A.trophies.map((t) => ({ tile: t, cost: 0 }));
	for (const [t, k] of goalTiles) {
		let g = CUT;
		for (const s2 of M.transAll(s, k)) {
			const f2 = fields[s2];
			if (!f2) continue;
			// (a toggle: the tile changes layer s2 back too, so in s2's field it is a goal of its own (its cost is only
			// its seed): the ball that pressed it stands there and walks off, the least of its 8 neighbours + a step,
			// as the lookup prices it)
			const v = isGoal(s2, t) ? arriveNear(f2, t, A) : arriveCost(f2, t);
			if (v < g) g = v;
		}
		if (g < CUT) goals.push({ tile: t, cost: g / 5 });
	}
	// (key expiry, makeModel expire: every tile a goal at the key-off layer's arrival cost there; the tile-change bitmap
	// (the lookup's neighbour rule) stays the layer's own)
	const ex = M.expire(s);
	if (ex.length) {
		const fs2 = ex.map((s2) => fields[s2]).filter(Boolean);
		if (fs2.length) {
			for (let t = 0; t < A.N; t++) {
				let g = CUT;
				for (const f2 of fs2) { const v = arriveCost(f2, t); if (v < g) g = v; }
				if (g < CUT) goals.push({ tile: t, cost: g / 5 });
			}
		}
	}
	return goals;
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
	const rfOpts = { oneWayEntry: true, portalForced: true, exitEntry: exitEntryOn() };
	const kappa = A.feats.has('fx') ? kappaOf(A, rfOpts) : 0;
	let builds = 0, sweeps = 0;
	// (the layer memo: key -> {f, n: this call's layers holding it, gen: the call that built it}; opts.memo: buildSteer's,
	// shared by its CEGAR builds; the previous call's entries start at n 0 and stay until this call ends)
	const memo = opts.memo || (layerMemoOn(A.opts) ? new Map() : null), memoOf = memo ? new Array(S).fill(null) : null;
	const gen = {}, spare = [], spareMax = memo ? Math.min(32, Math.floor(MEMO_SPARE_BYTES / (A.N * BODY_BYTES_TILE))) : 0;
	const wildTag = memo ? `w${M.names.join(',')}` : '';
	if (memo) for (const e of memo.values()) e.n = 0;
	let memoHits = 0, memoSavedMs = 0;
	const solve = (s) => {
		if (!copies[s]) copies[s] = layerLevel(A, M, s, opts);
		const { lv, goalTiles } = copies[s];
		const goals = layerGoals(A, M, s, goalTiles, fields, (s2, t) => !!(copies[s2] && copies[s2].goal[t]));
		const key = goalsKey(goals);
		if (goalsOf[s] === key && fields[s]) return false;
		goalsOf[s] = key;
		const build = () => (lv._wild && kappa ? wildField(A, M, s, goals, kappa) : RF.reachField(lv, Object.assign({ goals, debug: !!opts.debug }, rfOpts)));
		if (memo) {
			const mk = layerMemoKey(copies[s], goals, lv._wild && kappa ? wildTag : '');
			const old = memoOf[s];
			if (old !== null && old !== mk) {
				// (a field this call built that no layer holds now: a spare, the oldest spare past spareMax goes)
				const e = memo.get(old);
				if (e && --e.n <= 0 && e.gen === gen) {
					spare.push(old);
					if (spare.length > spareMax) { const k = spare.shift(); const x = memo.get(k); if (x && x.n <= 0) memo.delete(k); }
				}
			}
			let e = memo.get(mk);
			// (a hit saves its field's first build: ms, which buildSteer's budget clock counts in 'same' mode)
			if (e) { if (old !== mk) e.n++; memoHits++; memoSavedMs += e.ms; } else { const tb = Date.now(); e = { f: build(), n: 1, gen, ms: 0 }; e.ms = Date.now() - tb; memo.set(mk, e); }
			memoOf[s] = mk;
			fields[s] = e.f;
		} else fields[s] = build();
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
	// (the memo keeps the fields this call's layers hold, nothing else)
	if (memo) for (const [k, e] of memo) if (e.n <= 0) memo.delete(k);
	return { kappa, A, M, fields, goals: copies.map((c) => (c ? c.goal : null)), sweeps, builds, memoHits, memoSavedMs, layers: comps.flat().length, ms: Date.now() - t0 };
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
	const tiles = [], legs = [], expAt = new Map();
	if (!f || !f._m) return { tiles, legs, expAt, end: 'no field' };
	const st = RF.stateOf(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
	let cur = null, why = 'no state';
	if (st) for (const [ty, l] of [...(st.base ? [st.base] : []), ...(st.rise || [])]) { const c = f._m.costOf(st.t, ty, l); if (c !== CUT && (!cur || c < cur.c)) cur = { t: st.t, ty, l, c }; }
	for (let leg = 0; leg < maxLegs && cur; leg++) {
		const path = descend(f, cur);
		for (const p of path) tiles.push(p.t);
		const end = path[path.length - 1];
		if (A.trophies.includes(end.t)) { why = 'trophy'; break; }
		const k = A.specialAt[end.t];
		// (key expiry: a key-on layer's field has every tile a goal, the key-off layer's cost there)
		const exp = M.keyN.filter((n) => M.valOf(s, n) === 1).map((n) => [M.withVal(s, n, 0), M.feats[n].key]);
		if (k < 0 && !exp.length) { why = 'stuck'; break; }
		let best = null;
		const cand = (k >= 0 ? M.transAll(s, k).map((s2) => [s2, null]) : []).concat(exp);
		for (const [s2, feat] of cand) {
			const f2 = PH.fields[s2]; if (!f2) continue;
			const c0 = f2.mode === 'walk' ? f2.walk[end.t] : f2.costF[end.t * (RF.KF + 1)];
			if (c0 < CUT && (!best || c0 < best.c)) best = { s2, c: c0, feat };
		}
		if (!best) { why = k < 0 ? 'stuck' : 'no next layer'; break; }
		if (best.feat) expAt.set(tiles.length, best.feat);
		// (a leg: the tile that changes the layer, the layers before and after, the cost left there)
		legs.push({ t: end.t, s, s2: best.s2, c: best.c });
		s = best.s2; f = PH.fields[s];
		if (f.mode === 'walk' || !f._m) { why = 'walk layer'; break; }
		cur = { t: end.t, ty: RF.F_, l: 0, c: best.c };
	}
	return { tiles, legs, expAt, end: why };
}

// ------------------------------------------------------------------ gates as floors (d4-count-gate-floor, 2026-09-29)
// The layer copies make a gate of a feature the model leaves out AIR (makeModel gateOpen: open), and a count gate (coin
// gate 165 / blue coin gate 214: solid from its count on) is air in every layer below its count. So no plan ever stood on
// one, and the CEGAR, which checks the plans for closed gates they pass, never saw a gate the way NEEDS as its floor:
// Aedan Garden's trophy is reached only from its two 10-coin gates (the steer: 1 layer, no features), Rotcil Illusions'
// from its 4-coin gate (the coin DP's T 1, from the walk plan's door), Nightmare Relics' from its 4-coin gate (fx only);
// the plans found other ways the relaxed physics allows (a dot column pumped, a ladder's exit carried along a row, an up
// boost's rise carried sideways) and the searches pinned there (6.8 / 9.4 / 10.2 tiles out in every sweep).
// THE FLOOR PROBE (probeFloors): once the plans are valid (no closed gate), the physics plan again on copies where those
// gates keep their door block (layerLevel probeDoors: passable AND a floor, the RCH3 field's own relaxation of a door), in
// the layers it walks (at most PROBE_LAYERS new fields; a wild layer (walk mode, no floors) ends it), replayed with the
// full state; a jump whose supports (the tile under the ball, a ledge beside it: reach.js J) are all no floor in the full
// state while one is such a gate, AIR there, names that gate's feature (a closed gate the probe's plan passes, or a killer,
// ends the probe: those are the plans' own check). The CEGAR models the feature as for a closed gate; a coin gate's count
// is the coin plan's count at least (floorT: the DP / tour over at least that count, the larger of it and the layer
// field's below it, the CPU file's alone: floorDP). Ordering only; RCH3 and its -1 untouched. Levels where no probe finds
// such a jump: the same file as before, byte for byte (the probe's time is off the build's budget clock).
// The COUNT gates only by default (gold / blue coin gates and doors): with every gate of a feature the model leaves out
// ('all': keys, switches, team, crown) the box A/B's two changed levels that route on main came slower in 2 of 2 seeds
// each (Don't Stop Jumping psw:0 46.5 / 47.1 vs 34.8 / 28.2 s, Egg Quest II key1 32.7 / 31.6 vs 30.3 / 25.6 s: the probe's
// relaxed plan took a switch's / key's gate as its floor where the level's own way needs none, and the modelled feature
// sent the searches for it), the coin floors' levels gained (Aedan Garden, Springopolis).
// EEAT_GATEFLOOR=0 / buildSteer(level, {gateFloor: false}): off (the build before); EEAT_GATEFLOOR=all / gateFloor 'all':
// every unmodelled gate a floor candidate.
const PROBE_LAYERS = 4;
/** the probe's mode: false (off), 'count' (the default: gold / blue coin gates) or 'all' */
function gateFloorOn(opts) {
	const v = opts && opts.gateFloor !== undefined ? opts.gateFloor : process.env.EEAT_GATEFLOOR === '0' ? false : process.env.EEAT_GATEFLOOR === 'all' ? 'all' : true;
	return v === 'all' ? 'all' : v ? 'count' : false;
}
/** the floor probe of a build whose plans are valid (PH: its physics layers; mode 'count' or 'all': gateFloorOn) ->
 *  {feat, t, param, pol, count} (the gate the probe's plan jumped from, air in the full state; count: a coin / blue coin
 *  gate that is solid from its count on) or null. deadline: no new probe field past it */
function probeFloors(level, A, PH, deadline, mode) {
	const M = PH.M, N = A.N, W = A.W;
	const flags = RF.guideFlags(level), nF = flags.length, fg0 = level.fg, lk = level.lookup0;
	const fl = (id) => (id >= 0 && id < nF ? flags[id] : 0);
	const full = fullState(A);
	// (a floor in the full state: a gate by its state there (a door of no feature, a time door: a floor, as some state has
	// it shut), else reach.js isFloor's blocks)
	const floorAt = (j) => {
		if (j >= N) return true;
		if (A.cls[j] === 3) {
			const k = A.gateFeat[j];
			if (k === 'open' || k === 'time') return true;
			if (k === 'static') return A.gatePol[j] !== 1;
			return full[k] === undefined || !testGate(k, A.gatePol[j], A.gateParam[j], full[k]);
		}
		const f = fl(fg0[j]);
		if ((f & (F_SOLID | F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) === 0) return false;
		return !((f & F_JUMPTHRU) && (f & F_ROTHALF) && lk[j] === 3);
	};
	const airGate = (j) => j < N && A.cls[j] === 3 && !['open', 'time', 'static'].includes(A.gateFeat[j]) && (mode === 'all' || A.gateFeat[j] === 'coins' || A.gateFeat[j] === 'bcoins') && !floorAt(j);
	const half = (i) => i >= 0 && i < N && (fl(fg0[i]) & (F_HALF | F_ROTHALF)) !== 0 && (fl(fg0[i]) & F_JUMPTHRU) === 0;
	const probe = new Map();
	let built = 0;
	const fieldOf = (s) => {
		if (probe.has(s)) return probe.get(s);
		let f = null;
		const base = PH.fields[s];
		if (base && base.mode !== 'walk' && base._m) {
			const c = layerLevel(A, M, s, { staticCoins: true, probeDoors: mode === 'all' ? 'all' : 'count' });
			if (!c.doors) f = base;
			else if (built < PROBE_LAYERS && Date.now() < deadline) {
				built++;
				const goals = layerGoals(A, M, s, c.goalTiles, PH.fields, (s2, t) => !!(PH.goals[s2] && PH.goals[s2][t]));
				f = RF.reachField(c.lv, { goals, debug: true, oneWayEntry: true, portalForced: true, exitEntry: exitEntryOn() });
				if (f.mode === 'walk' || !f._m) f = null;
			}
		}
		probe.set(s, f);
		return f;
	};
	const sim = new E.EESim(level); sim.reset();
	let s = M.layerOf(sim);
	let f = fieldOf(s);
	if (!f) return null;
	const st = RF.stateOf(f, sim.px, sim.py, sim.speed_y, sim._q0, sim._q1, sim._slippery);
	let cur = null;
	if (st) for (const [ty, l] of [...(st.base ? [st.base] : []), ...(st.rise || [])]) { const c = f._m.costOf(st.t, ty, l); if (c !== CUT && (!cur || c < cur.c)) cur = { t: st.t, ty, l, c }; }
	let prev = -1;
	for (let leg = 0; leg < 200 && cur; leg++) {
		const path = descend(f, cur);
		const J = f._m.J, cls = f.cls;
		for (let n = 0; n < path.length; n++) {
			const p = path[n], t = p.t;
			if (t !== prev) {
				// (the replay: a gate shut in the full state or a killer on the way ends the probe: not a floor's matter)
				const c = A.cls[t];
				if (c === 3) { const k = A.gateFeat[t]; if (k !== 'open' && k !== 'static' && k !== 'time' && full[k] !== undefined && !testGate(k, A.gatePol[t], A.gateParam[t], full[k])) return null; }
				else if (c === 1 && full.prot !== undefined && full.prot !== 1) return null;
				applyFull(A, full, t);
				prev = t;
			}
			// (a jump: the same tile into R at its jump level (reach.js sameTile's J edge); its supports: the tile under it and
			// the ledges beside it (reach.js J), a lower half block there (real, never a gate))
			const q = n > 0 ? path[n - 1] : null;
			if (!q || q.t !== t || p.ty !== RF.R_ || J[t] === -128 || p.l !== J[t] || (q.ty === RF.R_ && q.l === p.l)) continue;
			const x = t % W;
			if (half(t) || (x > 0 && half(t - 1)) || (x < W - 1 && half(t + 1))) continue;
			const sup = [t + W];
			if (x > 0 && cls[t - 1] !== RF.WALL) sup.push(t - 1 + W);
			if (x < W - 1 && cls[t + 1] !== RF.WALL) sup.push(t + 1 + W);
			if (sup.some(floorAt)) continue;
			const j = sup.find(airGate);
			if (j === undefined) continue;
			const k = A.gateFeat[j];
			return { feat: k, t: j, from: t, param: A.gateParam[j], pol: A.gatePol[j], count: (k === 'coins' || k === 'bcoins') && A.gatePol[j] === 0 };
		}
		const end = path[path.length - 1];
		if (A.trophies.includes(end.t)) break;
		// (the next layer as layeredPlan picks it, by the layers' own fields; key expiry: the key off from here on)
		const k = A.specialAt[end.t];
		const exp = M.keyN.filter((n) => M.valOf(s, n) === 1).map((n) => [M.withVal(s, n, 0), M.feats[n].key]);
		if (k < 0 && !exp.length) break;
		let best = null;
		for (const [s2, feat] of (k >= 0 ? M.transAll(s, k).map((s2) => [s2, null]) : []).concat(exp)) {
			const f2 = PH.fields[s2]; if (!f2) continue;
			const c0 = f2.mode === 'walk' ? f2.walk[end.t] : f2.costF[end.t * (RF.KF + 1)];
			if (c0 < CUT && (!best || c0 < best.c)) best = { s2, c: c0, feat };
		}
		if (!best) break;
		if (best.feat && full[best.feat] !== undefined) full[best.feat] = 0;
		s = best.s2; f = fieldOf(s);
		if (!f) break;
		// (the probe's own cost there: a leg start the probe field prices)
		const c1 = f._m.costOf(end.t, RF.F_, 0);
		if (c1 === CUT) break;
		cur = { t: end.t, ty: RF.F_, l: 0, c: c1 };
	}
	return null;
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
/** a coin leg's field (the level lv with the tiles fg: the coin q the goal): with the forced portals, unless they leave the
 *  coin out of reach from the start and from every other coin (a portal chain the model misreads: the plan would have
 *  no value at all); then without them, as main's legs were */
function legFieldOf(lv, fg, q, coins, start) {
	const f = RF.reachField(Object.assign({}, lv, { fg }), { goals: [{ tile: q, cost: 0 }], oneWayEntry: true, portalForced: true, exitEntry: exitEntryOn() });
	if (arriveCost(f, start) < CUT) return f;
	for (const c of coins) if (c !== q && arriveCost(f, c) < CUT) return f;
	const g = RF.reachField(Object.assign({}, lv, { fg }), { goals: [{ tile: q, cost: 0 }], oneWayEntry: true, exitEntry: exitEntryOn() });
	g.unforced = true;
	return g;
}
// The coin legs on worker threads (the steer build's 9-14 s of legs on NC / Good Egg; each leg a pure reach field of its
// own: legFieldOf): LEG_THREADS workers (opts.legThreads; EEAT_STEER_THREADS; 0 or 1: none, the legs one after another),
// only for LEG_MIN_WORK tiles x legs or more unless opts.legThreads asks. The build stays synchronous: the workers take
// jobs from a shared counter, answer on their own ports, and the build waits on the counter (Atomics.wait) and reads the
// answers (receiveMessageOnPort) into the jobs' own places: the same fields in the same order, the same steer field
// (test/steer.js A: its file's bytes with and without the workers).
const LEG_THREADS = 6, LEG_MIN_WORK = 200000, LEG_STALL_MS = 180000;
const legThreadsOf = (A, legs, opts) => {
	const env = process.env.EEAT_STEER_THREADS;
	const want = opts && Number.isInteger(opts.legThreads) ? opts.legThreads : env !== undefined && env !== '' && +env >= 0 ? Math.floor(+env) : -1;
	if (want === 0 || want === 1 || legs < 2) return 0;
	if (want < 0 && A.N * legs < LEG_MIN_WORK) return 0;
	const n = want > 0 ? want : Math.min(LEG_THREADS, Math.max(1, (require('os').cpus().length || 1) - 2));
	return n >= 2 ? Math.min(n, legs) : 0;
};
const LEG_WORKER = `const { workerData: d, parentPort } = require('worker_threads');
const SF = require(d.steer);
parentPort.on('message', (m) => {
	const idx = new Int32Array(m.sab);
	for (;;) {
		const i = Atomics.add(idx, 0, 1);
		if (i >= m.jobs.length) break;
		const j = m.jobs[i];
		let r;
		try {
			if (m.deadline && Date.now() > m.deadline) r = { i, late: true };
			else {
				const fg = Int32Array.from(m.fg0[j.k]); fg[j.q] = m.trophy;
				const f = SF._legFieldOf(Object.assign({}, d.level, m.deltas[j.k]), fg, j.q, m.coins, m.start);
				r = j.at ? { i, costs: Float64Array.from(j.at, (t) => SF.arriveCost(f, t)) } : { i, f };
			}
		} catch (e) { r = { i, err: String(e && e.stack || e) }; }
		const bufs = new Set();
		if (r.f) for (const v of Object.values(r.f)) if (ArrayBuffer.isView(v) && !(v.buffer instanceof SharedArrayBuffer)) bufs.add(v.buffer);
		if (r.costs) bufs.add(r.costs.buffer);
		try { d.port.postMessage(r, [...bufs]); } catch (e) { d.port.postMessage({ i, err: String(e && e.message || e) }); }   // (an answer that cannot be sent: the caller builds it)
		Atomics.add(idx, 1, 1); Atomics.notify(idx, 1);
	}
});`;
/** the leg workers for level L (A.level) -> {run(jobs, extra) -> answers in the jobs' order, close()} or null (none) */
function legPool(L, n) {
	if (!n) return null;
	const WT = require('worker_threads');
	const ws = [];
	try {
		for (let k = 0; k < n; k++) {
			const ch = new WT.MessageChannel();
			const w = new WT.Worker(LEG_WORKER, { eval: true, workerData: { level: L, steer: __filename, port: ch.port2 }, transferList: [ch.port2] });
			w.unref();
			ws.push({ w, port: ch.port1 });
		}
	} catch (e) { for (const x of ws) x.w.terminate(); return null; }
	return {
		n,
		/** jobs [{k (the layer: its delta and its fg0), q (the coin: the goal), at?}] with extra {deltas, fg0, trophy, coins, start, deadline}: the answers ({f} | {costs} |
		 *  {late}) in the jobs' order; a job a worker could not do (an error, a stalled pool) is done here */
		run(jobs, extra) {
			const sab = new SharedArrayBuffer(8), idx = new Int32Array(sab);
			for (const x of ws) x.w.postMessage(Object.assign({ sab, jobs }, extra));
			const out = new Array(jobs.length).fill(null);
			let got = 0, at = Date.now();
			const drain = () => { for (const x of ws) for (let m = WT.receiveMessageOnPort(x.port); m; m = WT.receiveMessageOnPort(x.port)) { const r = m.message; if (!out[r.i]) { out[r.i] = r; got++; at = Date.now(); } } };
			while (got < jobs.length) {
				const done = Atomics.load(idx, 1);
				if (done > got) { drain(); continue; }
				if (Date.now() - at > LEG_STALL_MS) break;
				Atomics.wait(idx, 1, done, 1000);
			}
			drain();
			// (claimed by nobody from here on: the jobs left are done in this thread)
			Atomics.store(idx, 0, jobs.length);
			return out.map((r, i) => {
				if (r && !r.err) return r;
				const j = jobs[i];
				const fg = Int32Array.from(extra.fg0[j.k]); fg[j.q] = extra.trophy;
				const f = legFieldOf(Object.assign({}, L, extra.deltas[j.k]), fg, j.q, extra.coins, extra.start);
				return j.at ? { i, costs: Float64Array.from(j.at, (t) => arriveCost(f, t)) } : { i, f };
			});
		},
		close() { for (const x of ws) { try { x.port.close(); x.w.terminate(); } catch (e) { /* gone */ } } },
	};
}
/** layerLevel's copy lv of L as the leg workers take it: the keys it changes other than fg */
function lvDelta(L, lv) {
	const d = {};
	for (const k of Object.keys(lv)) if (k !== 'fg' && lv[k] !== L[k]) d[k] = lv[k];
	return d;
}
/** per coin, the physics field of the collection layer (the plan's layer before its first coin, T - 1 coins) with that
 *  coin as the only goal; the tail at T coins per coin (the layered field's arrival cost) */
function coinLegsPhys(B, PH, base, opts) {
	const { A } = B;
	const M = PH.M;
	let sPlan = B.M.s0;
	for (const p of B.plan.path) if (p.via === 'touch' && A.special[A.specialAt[p.t]][1] === 'coins') break; else sPlan = p.s;
	let s = 0;
	M.feats.forEach((f, n) => { const wn = B.M.names.indexOf(f.key); const v = wn >= 0 ? B.M.valOf(sPlan, wn) : f.init; s += v * M.stride[n]; });
	const nC = M.names.indexOf('coins');
	s = M.withVal(s, nC, base.T - 1);
	const L = legsOf(A, M, s, nC, base.coins, opts);
	const fields = new Map(), countOf = new Map();
	try {
		const f0 = L.fields(base.coins.map((q) => [q, base.T - 1]));
		base.coins.forEach((q, i) => { fields.set(q, f0[i]); countOf.set(q, base.T - 1); });
		return coinLegsPhysTour(A, PH, base, opts, M, s, nC, L, fields, countOf);
	} finally { L.close(); }
}
/** the coin legs of one build: layerLevel's copies per count k (made once) and the leg fields, on the leg workers when
 *  there are enough legs (legThreadsOf): fields([[q, k]]) -> the fields in that order; costs([[q, k, tiles]], deadline)
 *  -> the arrival costs at those tiles (null: past the deadline); close() */
function legsOf(A, M, s, nC, coins, opts, legs) {
	const lvOf = new Map();
	const layer = (k) => {
		if (!lvOf.has(k)) {
			// (nC < 0: the coins are no feature of M (the budget left them out, coinLegsFree): layer s's copy with its coin
			// doors and gates as they stand at k coins, wall or open, the kept features' gates open)
			const { lv } = nC >= 0 ? layerLevel(A, M, M.withVal(s, nC, k), {}) : coinDoorsAt(A, M, layerLevel(A, M, s, {}), k);
			const fg0 = Int32Array.from(lv.fg);
			for (const c of coins) if (fg0[c] === TROPHY) fg0[c] = 0;
			lvOf.set(k, { lv, fg0, delta: lvDelta(A.level, lv) });
		}
		return lvOf.get(k);
	};
	const fgOf = (q, k) => { const fg = Int32Array.from(layer(k).fg0); fg[q] = TROPHY; return fg; };
	const pool = legPool(A.level, legThreadsOf(A, legs || coins.length, opts));
	const run = (list, withAt, deadline) => {
		const deltas = {};
		const fg0 = {};
		const jobs = list.map(([q, k, at]) => { deltas[k] = layer(k).delta; fg0[k] = layer(k).fg0; return withAt ? { k, q, at } : { k, q }; });
		return pool.run(jobs, { deltas, fg0, trophy: TROPHY, coins, start: A.start.t, deadline: deadline || 0 });
	};
	return {
		fields(list) {
			if (!pool || list.length < 2) return list.map(([q, k]) => legFieldOf(layer(k).lv, fgOf(q, k), q, coins, A.start.t));
			return run(list, false).map((r) => r.f);
		},
		costs(list, deadline) {
			if (!pool) {
				let late = false;
				return list.map(([q, k, at]) => {
					if (late || (deadline && Date.now() > deadline)) { late = true; return null; }
					const f = legFieldOf(layer(k).lv, fgOf(q, k), q, coins, A.start.t);
					return Float64Array.from(at, (t) => arriveCost(f, t));
				});
			}
			return run(list, true, deadline).map((r) => (r.late ? null : r.costs));
		},
		close() { if (pool) pool.close(); },
	};
}
function coinLegsPhysTour(A, PH, base, opts, M, s, nC, L, fields, countOf) {
	const sT = M.withVal(s, nC, Math.min(base.T, M.radix[nC] - 1));
	const tail = new Map();
	for (const q of base.coins) tail.set(q, PH.fields[sT] ? arriveCost(PH.fields[sT], q) : CUT);
	const CL = { T: base.T, coins: base.coins, fields, tail, s, countOf, rounds: 0 };
	legTourRounds(A, CL, L, opts);
	return CL;
}
/** a layerLevel copy ({lv}) of a model that has no coin feature (makeModel's gateOpen: open) with its coin doors and
 *  gates as they stand at k gold coins (0 open, 9 a wall) and every other gate of a modelled feature OPEN, its tiles
 *  that change the layer back to the level's own blocks (no goals): the kept layers' union, a relaxation (ordering only;
 *  CTM_2's coins sit in pockets behind purple doors, one of them the modelled switch's, shut in the plan's layer: that
 *  coin's leg reached neither the start nor another coin, and every 16-coin tour had no value) */
function coinDoorsAt(A, M, c, k) {
	const fg = Int32Array.from(c.lv.fg), L = A.level;
	const kept = new Set(M.names);
	for (let i = 0; i < A.N; i++) {
		if (A.cls[i] === 3) {
			const g = A.gateFeat[i];
			if (g === 'coins') fg[i] = testGate('coins', A.gatePol[i], A.gateParam[i], k) ? 0 : 9;
			else if (kept.has(g)) fg[i] = 0;
		} else if (c.goal[i]) fg[i] = L.fg[i] === 360 ? 0 : L.fg[i];
	}
	return { lv: Object.assign({}, c.lv, { fg }), goalTiles: [], goal: new Uint8Array(A.N) };
}
/** THE COIN DP OUTSIDE THE LAYER PRODUCT (the budget left the coins out: "coins: over 31 layers", CTM_2's 16-coin door):
 *  the legs of coinLegsPhys in the kept model's layer s of the walk plan at its first coin door (its effects; the kept
 *  features' gates open, the coin doors by count: coinDoorsAt), at T - 1 coins first, then per the count the ball holds
 *  on the DP's own tour (legTourRounds); the tail at T: the least over the kept layers of the same effects of the layer
 *  field's arrival cost at the coin (its coin doors all open: a lower bound, ordering only). -> the coinLegsPhys shape
 *  {T, coins, fields, tail, s, countOf, rounds} */
function coinLegsFree(B, PH, T, coins, opts) {
	const { A } = B;
	const M = PH.M;
	let sPlan = B.M.s0;
	for (const p of B.plan.path) if (A.cls[p.t] === 3 && A.gateFeat[p.t] === 'coins' && A.gatePol[p.t] === 1) break; else sPlan = p.s;
	let s = 0;
	M.feats.forEach((f, n) => { const wn = B.M.names.indexOf(f.key); const v = wn >= 0 ? B.M.valOf(sPlan, wn) : f.init; s += v * M.stride[n]; });
	const nFx = M.names.indexOf('fx');
	const same = [];
	for (let s2 = 0; s2 < M.S; s2++) if ((nFx < 0 || M.valOf(s2, nFx) === M.valOf(s, nFx)) && PH.fields[s2]) same.push(s2);
	const L = legsOf(A, M, s, -1, coins, opts);
	try {
		const fields = new Map(), countOf = new Map(), tail = new Map();
		const f0 = L.fields(coins.map((q) => [q, T - 1]));
		coins.forEach((q, i) => {
			let tl = CUT;
			for (const s2 of same) { const v = arriveCost(PH.fields[s2], q); if (v < tl) tl = v; }
			fields.set(q, f0[i]); countOf.set(q, T - 1); tail.set(q, tl);
		});
		const CL = { T, coins, fields, tail, s, countOf, rounds: 0 };
		legTourRounds(A, CL, L, opts);
		return CL;
	} finally { L.close(); }
}
/** (opts.legTour, default on: a coin's leg in the layer of the count the ball holds on its way to it along the DP's own
 *  tour (the k-th coin of the tour: coins = k - 1), rebuilt until the tour stays (at most 3 rounds). The T - 1 layer
 *  opens every coin door below T: on Forgotten Veil (doors for every count 1..16) coin 4's leg from coin 3 ran through
 *  doors shut at 3 coins, not the known route's 1195-tick loop) */
function legTourRounds(A, CL, L, opts) {
	const { fields, countOf } = CL;
	if (!opts || opts.legTour !== false) {
		for (let round = 0; round < 3; round++) {
			const D = coinDP(CL);
			if (!D) break;
			const tour = coinTour(CL, D, A.start.t);
			// (the legs whose count changed, one batch: each leg is its own field)
			const ch = tour.map((q, k) => [q, k]).filter(([q, k]) => countOf.get(q) !== k);
			const f2 = ch.length ? L.fields(ch) : [];
			ch.forEach(([q, k], i) => { fields.set(q, f2[i]); countOf.set(q, k); });
			const changed = ch.length;
			CL.rounds = round + 1;
			if (!changed) break;
		}
	}
}
/** the plan past its count (opts.coinT, editor.js pastPlan): every leg in the layer of the count the ball holds when it
 *  walks it. legTour starts from the T - 1 layer and re-rounds along the DP's own tour; with coin GATES that is no start:
 *  on Wine Quest I the 9-coin layer shuts the 4-, 5-, 6- and 9-coin gates, which cut the level into parts, every
 *  10-coin tour had a cut leg and the DP no value at all. Here the DP is over (collected set, last) with the leg from
 *  coin i to coin j at count k = popcount(set) taken from j's field in layer k (n x T fields, one at a time: only the
 *  arrival costs from the coins and the start are kept), and each coin's lookup body is its field in the layer of its
 *  place on the DP's best tour from the start (a coin off that tour: layer T - 1). -> the coinLegsPhys shape {T, coins,
 *  fields, tail, s, countOf, rounds: 0, layered: {D, tour, start}} or null (over 18 coins, or past the deadline: ms) */
function coinLegsLayered(B, PH, base, deadline, opts) {
	const { A } = B;
	const M = PH.M;
	let sPlan = B.M.s0;
	for (const p of B.plan.path) if (p.via === 'touch' && A.special[A.specialAt[p.t]][1] === 'coins') break; else sPlan = p.s;
	let s = 0;
	M.feats.forEach((f, n) => { const wn = B.M.names.indexOf(f.key); const v = wn >= 0 ? B.M.valOf(sPlan, wn) : f.init; s += v * M.stride[n]; });
	const nC = M.names.indexOf('coins');
	const coins = base.coins, n = coins.length, T = Math.min(base.T, n, M.radix[nC] - 1);
	if (n > 18 || T < 1) return null;
	// L[(k * (n + 1) + i) * n + j]: from coin i (i = n: the start) to coin j holding k coins
	const L = new Float64Array(T * (n + 1) * n).fill(Infinity);
	const Lat = (k, i, j) => L[(k * (n + 1) + i) * n + j];
	// (n x T fields, on the leg workers when there are enough (legsOf): each answers the arrival costs at the start and the
	// other coins; past the build's time, no plan past its count)
	const LG = legsOf(A, M, s, nC, coins, opts, n * T);
	try {
		const list = [];
		for (let k = 0; k < T; k++) {
			for (let j = 0; j < n; j++) {
				const from = [], at = [];
				for (let i = 0; i <= n; i++) { if (i === j || (i === n && k > 0)) continue; from.push(i); at.push(i === n ? A.start.t : coins[i]); }
				list.push([coins[j], k, at, j, from]);
			}
		}
		const cs = LG.costs(list, deadline);
		if (cs.some((c) => !c)) return null;
		list.forEach(([, k, , j, from], x) => from.forEach((i, y) => { const v = cs[x][y]; if (v < CUT) L[(k * (n + 1) + i) * n + j] = v; }));
		return coinLegsLayeredDP(A, PH, M, s, nC, coins, n, T, L, Lat, LG);
	} finally { LG.close(); }
}
function coinLegsLayeredDP(A, PH, M, s, nC, coins, n, T, L, Lat, LG) {
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
	const fl = coins.map((q, x) => [q, place[x] >= 0 ? place[x] : T - 1]);
	const f2 = LG.fields(fl);
	fl.forEach(([q, k], x) => { fields.set(q, f2[x]); countOf.set(q, k); });
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
	return { n, T, h: dpH(n, T, leg, tail) };
}
/** the DP's table over leg costs leg[i * n + j] (from coin i to coin j, Infinity: none) and the tails (fifths): h[mask *
 *  n + last] = the least cost to finish from coin `last` with the coins of mask collected (T of them: the tail) */
function dpH(n, T, leg, tail) {
	const NM = 1 << n;
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
	return h;
}

// ------------------------------------------------------------------ the coin tour (no DP: more than 18 coins, or the DP
// or the coin feature left out by the budget)
// Without a DP the lookup below T coins is the layer field's alone, the ways that need no more coins: on Level 1 Overworld
// (one 80-coin door) it has no value anywhere below 80 coins (81 layers), so the CPU search had no gradient toward the
// coins at all (79/80 by 69 s, then nothing for 230 s). The tour: per coin a WALK leg (the walking distance to it x kappa,
// wildField's measure: gravity-blind, ordering only), a tour over the coins (nearest neighbour from the start, then 2-opt),
// the tail (the walking distance x kappa from the T-th coin to the trophy with T coins). The lookup (CPU only: the
// CPU file's tour section, steerFileBytes(st, fp, true)): the least over the ball's untaken coins c of leg_c(ball) + the
// tour from c on over the next (T - held - 1) untaken coins (wrapping to the tour's start) + the tail of the last. A
// cost-to-go in fifths: taking the coin it heads for keeps it level, walking away raises it. Nothing prunes by it.
// (TOUR_MAX_TILES: a tour worth more at the start is scaled down to it: the searches' distances stop at 5999 tiles
// (goexplore.js STEER_REAL_MAX, the editor's STEER_MISS), and LoZ Skyward Sword's 80-coin tour starts at 6188)
const TOUR_MAX_BYTES = 192 << 20, TOUR_MIN_COINS = 19, TOUR_MAX_TILES = 4000;
/** the highest coin door count the walk plan passes (0: none; modelled or not) */
function planCoinT(B) {
	const { A } = B;
	let T = 0;
	for (const p of B.plan.path) if (A.cls[p.t] === 3 && A.gateFeat[p.t] === 'coins' && A.gatePol[p.t] === 1) T = Math.max(T, A.gateParam[p.t]);
	return T;
}
/** the walk's passability with k gold coins held: coin doors by k, statics exact, every other gate open (coin gates
 *  too: open below their count, and a ball passes them before it holds it; LoZ Skyward Sword's 50-odd gates of counts
 *  8-80 all shut at 79 coins cut every coin off the start), killers out (1 passable, 0 not) */
function tourPass(A, k) {
	const P = new Uint8Array(A.N);
	for (let i = 0; i < A.N; i++) {
		const c = A.cls[i];
		if (c === 2) P[i] = 1;
		else if (c === 3) {
			const g = A.gateFeat[i];
			P[i] = g === 'static' ? (A.gatePol[i] === 1 ? 1 : 0) : g === 'coins' && A.gatePol[i] === 1 ? (testGate('coins', 1, A.gateParam[i], k) ? 1 : 0) : 1;
		}
	}
	return P;
}
/** a backward walk field (fifths: 5 / 7 a step x kappa, a portal 5) from the goals [{tile, cost fifths}] over P ->
 *  Float64Array(N) (Infinity: none); H: scratch {key Float64Array, id Int32Array} */
function walkDist(A, P, goals, kappa, H) {
	const { W, H: HH, N } = A;
	const d = new Float64Array(N).fill(Infinity);
	const goalT = new Uint8Array(N);
	let n = 0;
	const push = (i, v) => {
		if (n >= H.key.length) { const k2 = new Float64Array(H.key.length * 2), i2 = new Int32Array(H.key.length * 2); k2.set(H.key); i2.set(H.id); H.key = k2; H.id = i2; }
		const key = H.key, id = H.id;
		let m = n++;
		while (m > 0) { const p = (m - 1) >> 1; if (key[p] <= v) break; key[m] = key[p]; id[m] = id[p]; m = p; }
		key[m] = v; id[m] = i;
	};
	const pop = () => {
		const key = H.key, id = H.id;
		const top = id[0], lastK = key[--n], lastI = id[n];
		let m = 0;
		for (;;) { const l = 2 * m + 1, r = l + 1; let c = m, cv = lastK; if (l < n && key[l] < cv) { c = l; cv = key[l]; } if (r < n && key[r] < cv) { c = r; cv = key[r]; } if (c === m) break; key[m] = key[c]; id[m] = id[c]; m = c; }
		key[m] = lastK; id[m] = lastI;
		return top;
	};
	for (const g of goals) { goalT[g.tile] = 1; if (g.cost < d[g.tile]) { d[g.tile] = g.cost; push(g.tile, g.cost); } }
	const isTrophy = new Uint8Array(N);
	for (const t of A.trophies) isTrophy[t] = 1;
	const s5 = 5 * kappa, s7 = 7 * kappa;
	while (n > 0) {
		const v = H.key[0], t2 = pop();
		if (v > d[t2]) continue;
		const x2 = t2 % W, y2 = (t2 - x2) / W;
		if (!P[t2] && !goalT[t2]) continue;
		for (let di = 0; di < 8; di++) {
			const x = x2 - DX8[di], y = y2 - DY8[di];
			if (x < 0 || y < 0 || x >= W || y >= HH) continue;
			const t = y * W + x;
			if (goalT[t] || isTrophy[t] || !P[t] || A.forcedP[t]) continue;
			const diag = DX8[di] && DY8[di];
			if (diag && !P[y * W + x2] && !P[y2 * W + x]) continue;
			if (A.qMove && A.qMove[t * 8 + di] !== 0 && (A.qMove[t * 8 + di] === 1 || !qMoveOK(A, t, di, (i) => !P[i], (i) => !!P[i]))) continue;
			const c = v + (diag ? s7 : s5);
			if (c < d[t]) { d[t] = c; push(t, c); }
		}
		const ps = A.portalSrcOf.get(t2);
		if (ps) for (const p of ps) if (P[p] && !goalT[p]) { const c = v + 5; if (c < d[p]) { d[p] = c; push(p, c); } }
	}
	return d;
}
/** the tour of a level with no DP: T coins needed (T >= 1), first (the coins are not modelled: the layer field is
 *  blind to the coin doors, so the tour's value comes first below T) -> {n, T, first, bit, order, tail, C, legs,
 *  ms, bytes} or null (no coin reachable, over the budget or the deadline) */
function buildTour(A, level, T, first, kappa, deadline, maxBytes) {
	const t0 = Date.now();
	const { N } = A;
	const all = A.special.filter((x) => x[1] === 'coins').map((x) => x[0]).filter((q) => level.coinBit[q] >= 0);
	if (!all.length || T < 1) return null;
	const P = tourPass(A, T - 1);
	const Hs = { key: new Float64Array(1 << 16), id: new Int32Array(1 << 16) };
	const coins = [], legs = [];
	for (const q of all) {
		if (deadline && Date.now() > deadline) return null;
		if ((coins.length + 1) * N * 2 > maxBytes) return null;
		const d = walkDist(A, P, [{ tile: q, cost: 0 }], kappa, Hs);
		if (!(d[A.start.t] < Infinity)) continue;   // (a coin the walk does not reach from the start: not on the tour)
		const u = new Uint16Array(N);
		for (let t = 0; t < N; t++) u[t] = d[t] < Infinity ? Math.min(CUT - 1, Math.round(d[t])) : CUT;
		coins.push(q); legs.push(u);
	}
	const n = coins.length;
	if (!n) return null;
	T = Math.min(T, n);
	// the tail: the walk with T coins from each coin to a trophy
	const dT = walkDist(A, tourPass(A, T), A.trophies.map((t) => ({ tile: t, cost: 0 })), kappa, Hs);
	const tail = new Float32Array(n);
	let tMin = Infinity;
	for (let i = 0; i < n; i++) { tail[i] = dT[coins[i]]; if (tail[i] < tMin) tMin = tail[i]; }
	if (!(tMin < Infinity)) return null;
	// (a coin whose tail the walk does not reach: the least tail, optimistic, ordering only)
	for (let i = 0; i < n; i++) if (!(tail[i] < Infinity)) tail[i] = tMin;
	// the legs between coins (a pair the walk does not join: 2x the largest leg, a detour, ordering only)
	const C = new Float32Array(n * n);
	let cMax = 0;
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = i === j ? 0 : legs[j][coins[i]]; C[i * n + j] = v >= CUT ? Infinity : v; if (v < CUT && v > cMax) cMax = v; }
	for (let k = 0; k < n * n; k++) if (!(C[k] < Infinity)) C[k] = 2 * cMax + 5;
	// the order: nearest neighbour from the start, then 2-opt (symmetric legs)
	const order = new Int32Array(n), used = new Uint8Array(n);
	let at = -1;
	for (let k = 0; k < n; k++) {
		let b = -1, bv = Infinity;
		for (let j = 0; j < n; j++) { if (used[j]) continue; const v = at < 0 ? legs[j][A.start.t] : C[at * n + j]; if (v < bv) { bv = v; b = j; } }
		order[k] = b; used[b] = 1; at = b;
	}
	// (the path's end is the trophy: the last coin's tail counts, else a unit level of coins left and right of the spawn
	// went right first by 3 tiles and left the 58-tile way back to the trophy out: its value then rose along its own order)
	const ds = (i, j) => (i < 0 ? legs[j][A.start.t] : j < 0 ? tail[i] : (C[i * n + j] + C[j * n + i]) / 2);
	for (let round = 0; round < 8; round++) {
		let better = false;
		for (let i = 0; i < n - 1; i++) {
			if (deadline && Date.now() > deadline) break;
			for (let j = i + 1; j < n; j++) {
				const a = i > 0 ? order[i - 1] : -1, b = order[i], c = order[j], e = j + 1 < n ? order[j + 1] : -1;
				const delta = ds(a, c) + ds(b, e) - ds(a, b) - ds(c, e);
				if (delta < -1e-6) { for (let x = i, y = j; x < y; x++, y--) { const t = order[x]; order[x] = order[y]; order[y] = t; } better = true; }
			}
		}
		if (!better) break;
	}
	const flat = new Uint16Array(n * N);
	legs.forEach((u, i) => flat.set(u, i * N));
	return { n, T, first: first === 2 ? 2 : first ? 1 : 0, bit: Int32Array.from(coins, (q) => level.coinBit[q]), coin: Int32Array.from(coins), order, tail, C, legs: flat, ms: Date.now() - t0, bytes: flat.byteLength + C.byteLength };
}
/** the tour's value of a sim's state (fifths, -1: none: no tour, T coins held, off every leg) */
function tourFifths(st, sim) {
	const R = st.tour;
	if (!R || !(sim.coins < R.T)) return -1;
	const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
	if (tx < 0 || ty < 0 || tx >= st.W || ty >= st.H) return -1;
	const tile = ty * st.W + tx, n = R.n, N = st.N;
	if (!R.U) { R.U = new Int32Array(n); R.cum = new Float64Array(n); }
	const U = R.U, cum = R.cum, cb = sim._coinBits;
	let u = 0;
	for (let k = 0; k < n; k++) { const q = R.order[k], b = R.bit[q]; if (b >= 0 && ((cb[b >> 5] >>> (b & 31)) & 1) === 1) continue; U[u++] = q; }
	if (!u) return -1;
	cum[0] = 0;
	for (let i = 1; i < u; i++) cum[i] = cum[i - 1] + R.C[U[i - 1] * n + U[i]];
	const wrap = R.C[U[u - 1] * n + U[0]];
	const r = Math.min(u - 1, Math.max(0, R.T - sim.coins - 1));
	let best = Infinity;
	for (let i = 0; i < u; i++) {
		const l = R.legs[U[i] * N + tile];
		if (l >= CUT) continue;
		let j = i + r, rest;
		if (j < u) rest = cum[j] - cum[i] + R.tail[U[j]];
		else { j -= u; rest = cum[u - 1] - cum[i] + wrap + cum[j] + R.tail[U[j]]; }
		if (l + rest < best) best = l + rest;
	}
	return best < Infinity ? Math.min(499999, Math.floor(best + 0.5)) : -1;
}

// ------------------------------------------------------------------ the blue coin DP (d4-blue-coin-dp, 2026-09-29)
// The layer fields count a coin at every touch (the walk model's relaxation: one coin counts T times), and the distinct-coin
// DP above is the gold coins' alone (coinPlan: 'coins' modelled), so a level whose way is a blue door had no distinct-coin
// value at all: Animaly's trophy over its 4-blue door, its 4 blue coins each behind a team door of another team (3, 6, 2,
// 1): the walk plan touches (16,27) 4 times and the search stalled there with 2 blue coins; Beat the Spikes 2's 4 blue
// coins in the corners (the plan touches (4,154) 4 times; the search held at most 1). THE BLUE DP: where the walk plan
// passes a blue door (a door tile, or the corner a diagonal step needs open: Animaly's trophy is entered from the
// diagonal past its door) before any gold door (the DP of the kind whose door comes first), the gold coins gave no DP,
// free DP or tour (a level with both keeps main's gold DP: Beaches in Space), the level holds 18 blue coins or fewer and
// the blue count is modelled: the distinct-coin DP over the blue coins, T = the plan's highest blue door,
// with LAYERED legs (kindLegs): per coin q and per layer l of the physics model WITHOUT the blue count (team, keys,
// switches, protection, effects), the field to q in layer l's copy (its blue doors and gates by the count the ball holds
// on its way to q: T - 1, then its place on the DP's own tour), the tiles that change the layer goals at the next layer's
// cost there (buildPhysics's value iteration with q in the trophy's place), so a ball with team 3 heading to the coin
// behind the team-6 door goes to the team-6 effect first (a leg in one fixed layer sends it to the shut door: a false near
// there). The DP's legs between coins: coin i -> coin j = the least of j's leg fields at coin i over the layers the walk
// reaches coin i in (forwardLayers: the team its door let in); the tail at coin q: the layer field at T blue coins there.
// The lookup (the CPU file's, flags 1 | 4 | 16 | 32: the blue count, the leg bodies per layer) below T blue coins: the
// LARGER of the DP's value and the layer field's (dp.max, as the free DP: two relaxations, the larger the better
// informed); past T the layer field's. The plain (GPU) file stays as it was (no DP there: the native lookup counts gold).
// Ordering only: nothing prunes by it (the RCH3 field's -1 stays the only prune). opts.blueDP === false or
// EEAT_BLUEDP=0: none (main's build)
const BLUE_MAX_COINS = 18;
/** the blue DP on (default; opts.blueDP false / EEAT_BLUEDP=0: off) */
function blueDPOn(opts) { return opts && opts.blueDP !== undefined ? !!opts.blueDP : process.env.EEAT_BLUEDP !== '0'; }
/** the walk plan's doors of a coin kind: {T: the highest count a door it passes reads, at: the plan step of the first
 *  (-1: none)}; corners: a diagonal step whose corners are shut in the plan's layer but for doors of the kind needs the
 *  least of those doors open (planFrom steps diagonally past a corner that is open in its layer) */
function kindPlan(B, kind, corners) {
	const { A, M } = B, W = A.W, path = B.plan.path;
	let T = 0, at = -1;
	const door = (i) => A.cls[i] === 3 && A.gateFeat[i] === kind && A.gatePol[i] === 1;
	const need = (n, p) => { if (p > T) T = p; if (at < 0) at = n; };
	for (let n = 0; n < path.length; n++) {
		const t = path[n].t;
		if (door(t)) { need(n, A.gateParam[t]); continue; }
		if (!corners || n === 0 || path[n].via === 'portal' || path[n].via === 'expire') continue;
		const q = path[n - 1].t, dx = (t % W) - (q % W), dy = Math.floor(t / W) - Math.floor(q / W);
		if (Math.abs(dx) !== 1 || Math.abs(dy) !== 1) continue;
		const s = path[n - 1].s;
		let p = Infinity, free = false;
		for (const c of [q + dx, q + dy * W]) {
			if (M.pass(c, s) === 0) continue;
			if (door(c)) p = Math.min(p, A.gateParam[c]); else free = true;
		}
		if (!free && p < Infinity) need(n, p);
	}
	return { T, at };
}
/** the layered legs of a coin kind (the DP above): ML = the physics model PH.M without `kind`; per coin j (tile coins[j])
 *  and layer l of ML reached from the start, F[j][l] = the field to the coin in l's copy with the kind's doors / gates by
 *  the count the ball holds on its way to it (T - 1, then its place on the DP's tour, legTour), the value iteration of
 *  buildPhysics with the coin as the only base goal; the DP over the legs between coins (the least over the layers the
 *  walk reaches coin i in) and the tails (the layer field at T coins there) -> {T, coins, F, ML, toL, D, tour, rounds,
 *  builds} or null (past the deadline) */
function kindLegs(A, PH, kind, T, coins, deadline, opts, lim) {
	const MP = PH.M, N = A.N, n = coins.length;
	const nK = MP.names.indexOf(kind);
	const ML = makeModel(A, new Set(MP.names.filter((k) => k !== kind)));
	const SL = ML.S;
	const fr = forwardLayers(A, ML);
	const succ = new Array(SL).fill(null).map(() => new Set());
	for (const e of fr.edges) succ[Math.floor(e / SL)].add(e % SL);
	const comps = sccs(SL, fr.layers, succ);
	// (the budget, before any field: n x the reached layers of leg bodies within the bytes left; the fields' builds (a
	// layer alone once, a strongly connected group's layers ~4 sweeps each: E.T. Ecosystems' plain / wild pair took 8)
	// at this build's own ms per field within the time left)
	const nL = comps.flat().length, per = comps.reduce((a, c) => a + (c.length > 1 ? 4 * c.length : 1), 0);
	if (lim && n * nL > lim.maxFields) return { over: `the blue coin DP: ${n} x ${nL} leg fields over the bytes` };
	if (lim && deadline && Date.now() + n * per * lim.msPer > deadline) return { over: `the blue coin DP: ${n} x ${nL} leg fields past the build's time` };
	// (the layers of the two models: ML's features are MP's without the kind, in MP's order)
	const mIdx = ML.names.map((k) => MP.names.indexOf(k));
	const toL = new Int32Array(MP.S);
	for (let s = 0; s < MP.S; s++) { let l = 0; mIdx.forEach((nP, m) => { l += MP.valOf(s, nP) * ML.stride[m]; }); toL[s] = l; }
	const toP = (l, c) => { let s = 0; mIdx.forEach((nP, m) => { s += ML.valOf(l, m) * MP.stride[nP]; }); return s + Math.min(c, MP.radix[nK] - 1) * MP.stride[nK]; };
	// (the kind's doors and gates as they stand at k coins: a copy per distinct configuration, i.e. per count of door
	// numbers at or below k)
	const params = [];
	for (let i = 0; i < N; i++) if (A.cls[i] === 3 && A.gateFeat[i] === kind && !params.includes(A.gateParam[i])) params.push(A.gateParam[i]);
	params.sort((a, b) => a - b);
	const cfgOf = (k) => params.filter((p) => p <= k).length;
	const base = new Map(), copies = new Map();
	const copyOf = (l, k) => {
		const key = `${l}:${cfgOf(k)}`;
		let c = copies.get(key);
		if (!c) {
			let b = base.get(l);
			if (!b) base.set(l, b = layerLevel(A, ML, l, { staticCoins: true }));
			const fg = Int32Array.from(b.lv.fg);
			for (let i = 0; i < N; i++) if (A.cls[i] === 3 && A.gateFeat[i] === kind) fg[i] = testGate(kind, A.gatePol[i], A.gateParam[i], k) ? 0 : 9;
			c = { lv: Object.assign({}, b.lv, { fg }), goalTiles: b.goalTiles, goal: b.goal };
			copies.set(key, c);
		}
		return c;
	};
	const kappa = PH.kappa;
	// (buildPhysics's own reach options: the exit from the entry too)
	const rfOpts = { oneWayEntry: true, portalForced: true, exitEntry: exitEntryOn() };
	let builds = 0;
	/** coin tile q's fields in every reached layer at k coins (buildPhysics's solve, q the base goal), null: past the deadline */
	const legOf = (q, k) => {
		const F = new Array(SL).fill(null), gk = new Array(SL).fill(null);
		const solve = (l) => {
			const c = copyOf(l, k);
			const goals = [{ tile: q, cost: 0 }];
			for (const [t, sp] of c.goalTiles) {
				if (t === q) continue;
				let g = CUT;
				for (const l2 of ML.transAll(l, sp)) {
					const f2 = F[l2];
					if (!f2) continue;
					const v = copyOf(l2, k).goal[t] ? arriveNear(f2, t, A) : arriveCost(f2, t);
					if (v < g) g = v;
				}
				if (g < CUT) goals.push({ tile: t, cost: g / 5 });
			}
			const ex = ML.expire(l);
			if (ex.length) {
				const fs2 = ex.map((l2) => F[l2]).filter(Boolean);
				if (fs2.length) for (let t = 0; t < N; t++) { let g = CUT; for (const f2 of fs2) { const v = arriveCost(f2, t); if (v < g) g = v; } if (g < CUT) goals.push({ tile: t, cost: g / 5 }); }
			}
			const key = goalsKey(goals);
			if (gk[l] === key && F[l]) return false;
			gk[l] = key;
			const fg = Int32Array.from(c.lv.fg); fg[q] = TROPHY;
			const lv = Object.assign({}, c.lv, { fg });
			F[l] = lv._wild && kappa ? wildField(A, ML, l, goals, kappa) : RF.reachField(lv, Object.assign({ goals }, rfOpts));
			builds++;
			return true;
		};
		for (const comp of comps) {
			for (let it = 0; it < (comp.length > 1 ? 8 : 1); it++) {
				let changed = false;
				for (const l of comp) { if (deadline && Date.now() > deadline) return null; if (solve(l)) changed = true; }
				if (!changed) break;
			}
		}
		return F;
	};
	// the layers the walk reaches each coin in; the tails
	const arr = coins.map((q) => { const a = []; for (let l = 0; l < SL; l++) if (fr.seen[l * N + q]) a.push(l); return a; });
	const tail = coins.map((q, j) => {
		let v = Infinity;
		for (const l of arr[j]) { const f = PH.fields[toP(l, T)]; if (!f) continue; const c = arriveCost(f, q); if (c < CUT && c < v) v = c; }
		return v;
	});
	const count = new Int32Array(n).fill(T - 1);
	const F = [];
	for (let j = 0; j < n; j++) { const f = legOf(coins[j], T - 1); if (!f) return null; F.push(f); }
	const legsOfF = () => {
		const leg = new Float64Array(n * n).fill(Infinity);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
			if (i === j) continue;
			for (const l of arr[i]) { const f = F[j][l]; if (!f) continue; const c = arriveCost(f, coins[i]); if (c < CUT && c < leg[i * n + j]) leg[i * n + j] = c; }
		}
		return leg;
	};
	const startLeg = (j) => { const f = F[j][ML.s0]; const c = f ? arriveCost(f, A.start.t) : CUT; return c < CUT ? c : Infinity; };
	const tourOf = (leg, h) => {
		const tour = [];
		let m = 0, last = -1;
		for (let k = 0; k < Math.min(T, n); k++) {
			let best = -1, bv = Infinity;
			for (let j = 0; j < n; j++) {
				if (m & (1 << j)) continue;
				const v = (last < 0 ? startLeg(j) : leg[last * n + j]) + h[(m | (1 << j)) * n + j];
				if (v < bv) { bv = v; best = j; }
			}
			if (best < 0) break;
			tour.push(best); m |= 1 << best; last = best;
		}
		return tour;
	};
	let leg = legsOfF(), h = dpH(n, T, leg, tail), tour = tourOf(leg, h), rounds = 0;
	// (legTour: a coin's leg in the doors of the count the ball holds on its way to it along the DP's own tour; a coin
	// whose count changes the kind's door configuration is built again; at most 3 rounds)
	if (!opts || opts.legTour !== false) {
		for (let round = 0; round < 3 && tour.length; round++) {
			let ch = 0;
			for (let j = 0; j < n; j++) {
				const k = tour.indexOf(j) >= 0 ? tour.indexOf(j) : T - 1;
				if (k === count[j]) continue;
				const same = cfgOf(k) === cfgOf(count[j]);
				count[j] = k;
				if (same) continue;
				const f = legOf(coins[j], k);
				if (!f) return null;
				F[j] = f; ch++;
			}
			rounds = round + 1;
			if (!ch) break;
			leg = legsOfF(); h = dpH(n, T, leg, tail); tour = tourOf(leg, h);
		}
	}
	return { T, coins, F, ML, toL, D: { n, T, h }, tour: tour.map((j) => coins[j]), rounds, builds, layers: nL };
}
/** the blue DP of a build (null: the plan passes no blue door) -> {info, K?: kindLegs'} (no K: none, info.why) */
function blueDP(B, PH, level, lim, deadline, opts) {
	const { A } = B, kind = 'bcoins';
	const bp = kindPlan(B, kind, true);
	if (!bp.T) return null;
	const gold = kindPlan(B, 'coins', false);
	const info = { T: bp.T, at: bp.at };
	const no = (why) => ({ info: Object.assign(info, { why }) });
	if (gold.at >= 0 && gold.at < bp.at) return no('a gold door first');
	if (PH.M.names.indexOf(kind) < 0) return no('the blue count not modelled');
	const coins = A.special.filter((x) => x[1] === kind).map((x) => x[0]).filter((q) => level.coinBit[q] >= 0);
	info.n = coins.length;
	if (coins.length > BLUE_MAX_COINS) return no(`${coins.length} blue coins`);
	if (bp.T > coins.length) return no(`a door of ${bp.T} blue coins`);
	const t0 = Date.now();
	const K = kindLegs(A, PH, kind, bp.T, coins, deadline, opts, lim);
	info.ms = Date.now() - t0;
	if (!K) return no('past the build\'s time');
	if (K.over) return no(K.over);
	Object.assign(info, { layers: K.layers, builds: K.builds, rounds: K.rounds });
	// (a DP with no complete tour from the start has no value there: its legs miss a coin (This is not snow's 16: a CPU
	// file twice the size for nothing); none)
	if (K.tour.length < Math.min(bp.T, coins.length)) return { info: Object.assign(info, { why: `no tour from the start (${K.tour.length} of ${bp.T})` }) };
	return { info, K };
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
/** (EEAT_STEER_WALLS="x,y;x,y", an EXPERIMENT knob, b9cw-cw: unset = the level itself, main byte for byte) the level with
 *  the 4-way component of each given tile's block kind (at most 400 tiles) a wall in the steer's model only (ordering:
 *  the steer never prunes): the oracle for a stall-driven refinement that walls a pinned attempt's place and rebuilds the
 *  plan. Cold World: "227,151;195,144" (the pool's 33333 exit and the air around the exit-apex pin) makes the CEGAR model
 *  the blue coins, the start 429.6 at no blue coin vs 145.8 with one (the chapter-2 blue coin that opens 6 chapters) */
function steerWallsOf(level) {
	const spec = process.env.EEAT_STEER_WALLS;
	if (!spec) return level;
	const B = require('./blocks.js');
	const W = level.width, H = level.height, fg = level.fg.slice();
	const kind = (id) => B.kindOf(id).kind;
	for (const part of spec.split(';')) {
		const [sx, sy] = part.split(',').map(Number);
		if (!(sx >= 0 && sx < W && sy >= 0 && sy < H)) continue;
		const s0 = sy * W + sx, k0 = kind(level.fg[s0]);
		const seen = new Set([s0]), q = [s0];
		while (q.length && seen.size < 400) {
			const i = q.shift(), x = i % W, y = (i / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy, j = ny * W + nx;
				if (nx < 0 || nx >= W || ny < 0 || ny >= H || seen.has(j) || kind(level.fg[j]) !== k0) continue;
				seen.add(j); q.push(j);
			}
		}
		for (const i of seen) fg[i] = 9;
	}
	return Object.assign({}, level, { fg });
}
function buildSteer(level, opts) {
	level = steerWallsOf(level);
	const st = buildSteerOnce(level, opts);
	// (the field transit tables (reach.js exitApexOn: the ordering fields only, EEAT_EXITAPEX) are no proof: a ball that
	// only grazes a field between two tick starts has none of its drag. A level is beatable, so a start they leave without
	// a value is their error on this level (Happy Spookaween: the tables' plan went through a coin door and the coin
	// layers found no way; the steer blind at the start): the plain model's steer there, whose start has one; the tables'
	// steer where it has a value too (a reorder only, both ways))
	if (st.info.start >= 0 || !RF.exitApexOn({ oneWayEntry: true })) return st;
	const env = process.env.EEAT_EXITAPEX;
	process.env.EEAT_EXITAPEX = '0';   // (the build is synchronous; its leg workers copy the environment when made)
	let plain;
	try { plain = buildSteerOnce(level, opts); } finally { if (env === undefined) delete process.env.EEAT_EXITAPEX; else process.env.EEAT_EXITAPEX = env; }
	if (!(plain.info.start >= 0)) return st;
	plain.info.exitApex = { off: 'no value at the start with the tables', start: null, cegar: st.info.cegar, ms: st.info.ms };
	plain.info.ms += st.info.ms;
	return plain;
}
function buildSteerOnce(level, opts) {
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
	// (the layer memo, default on: one for the whole build, so a CEGAR build reuses the previous one's fields: buildPhysics)
	const memoMode = layerMemoOn(opts), memo = memoMode ? new Map() : null;
	// (the budget's clock: T0() = t0 less the time the memo saved in 'same' mode (each repeat's first build's ms), so the
	// budget decides as if every repeat were built again; off or 'spend': t0)
	let saved = 0;
	// (the floor probe's time is off the budget clock too: a level where it finds nothing gets the same file as without it)
	let probeMs = 0;
	const T0 = () => t0 - saved - probeMs;
	const floorOn = gateFloorOn(opts), floors = [];
	let floorT = 0;
	for (let it = 0; it < (opts.maxIters || 12); it++) {
		B = walkBuild(level, A, { features: [...modeled], maxLayers, deadline: T0() + maxMs / 2 });
		if (B.capped && !over) over = `${B.capped.feat}: ${B.capped.why === 'time' ? secs : `over ${maxLayers} layers (${mb})`}`;
		for (const f of B.M.names) modeled.add(f);
		PH = buildPhysics(B, { staticCoins: true, debug: true, memo });
		if (memoMode === 'same') saved += PH.memoSavedMs;
		const sim = new E.EESim(level); sim.reset();
		const pl = layeredPlan(PH, sim);
		const path = [];
		for (let i = 0; i < pl.tiles.length; i++) {
			const t = pl.tiles[i];
			// (a key run out at the leg's end: the replay turns it off there)
			if (pl.expAt.has(i) && path.length) path.push({ t: path[path.length - 1].t, via: 'expire', feat: pl.expAt.get(i) });
			if (path.length && path[path.length - 1].t === t) continue;
			const q = path.length ? path[path.length - 1].t : -1, W = A.W;
			const tele = q >= 0 && (Math.abs(t % W - q % W) > 1 || Math.abs(Math.floor(t / W) - Math.floor(q / W)) > 1);
			path.push({ t, via: tele ? 'portal' : 'move' });
		}
		let cx = path.length > 1 ? counterexample(A, { path }) : null;
		// (the plans are valid: the floor probe, a gate the way stands on that is air in the full state)
		let gx = null;
		if (!cx && floorOn) {
			const tp = Date.now();
			gx = probeFloors(level, A, PH, Date.now() + maxMs / 2, floorOn);
			probeMs += Date.now() - tp;
			if (gx) {
				floors.push({ feat: gx.feat, at: [gx.t % A.W, Math.floor(gx.t / A.W)], from: [gx.from % A.W, Math.floor(gx.from / A.W)], param: gx.param, modelled: modeled.has(gx.feat) });
				if (gx.count && gx.feat === 'coins') floorT = Math.max(floorT, gx.param);
				if (!modeled.has(gx.feat) && A.feats.has(gx.feat)) cx = gx;
			}
		}
		cegar.push({ features: [...modeled], layers: PH.layers, builds: PH.builds, ...(PH.memoHits ? { memo: PH.memoHits } : {}), cx: cx && cx.feat, ...(gx ? { floor: gx.feat } : {}) });
		if (!cx || modeled.has(cx.feat) || !A.feats.has(cx.feat)) break;
		// (a floor the budget cannot model: left out quietly, the plans' own refusals name what `over` says)
		if (B.M.S * A.feats.get(cx.feat).values.length > maxLayers) { if (cx !== gx) over = over || `${cx.feat}: over ${maxLayers} layers (${mb})`; else floors[floors.length - 1].over = 'layers'; break; }
		// (the next build takes longer than this one)
		if (Date.now() - T0() > maxMs / 2) { if (cx !== gx) over = over || `${cx.feat}: ${secs}`; else floors[floors.length - 1].over = 'time'; break; }
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
	// (opts.coinT: the plan's count at least that: the plan past its count, editor.js pastPlan; floorT: the count of a coin
	// gate the floor probe's plan stood on)
	let cp = opts.noDP ? null : coinPlan(B, Math.max(opts.coinT || 0, floorT));
	// (THE FLOOR'S COUNT (the floor probe): a coin gate the way stands on raised the plan's count: below it the LARGER of
	// the DP's value and the layer field's (dp.max: the layer field's ways at fewer coins are ways the relaxed physics
	// allows without that floor, which the probe's plan did not take), the CPU file's alone (dp.free: flags 1 | 4, its leg
	// bodies after the layer bodies), as the DP outside the layer product; the plain (GPU) file: the layer bodies, no DP)
	const floorDP = !!cp && !opts.coinT && floorT > planCoinT(B);
	const nPlain0 = bodies.length;
	if (cp && ((bodies.length + cp.coins.length) * bodyBytes > maxBytes || Date.now() - T0() > maxMs)) {
		over = over || `the coin DP: ${(bodies.length + cp.coins.length) * bodyBytes > maxBytes ? `over ${mb}` : secs}`;
		cp = null;
	}
	// (more than 18 coins: no DP (coinDP, coinLegsLayered), so no legs either: the same steer, without n physics fields)
	if (cp && cp.coins.length > 18) cp = null;
	if (cp) {
		let CL = opts.coinT ? coinLegsLayered(B, PH, cp, T0() + maxMs, opts) : coinLegsPhys(B, PH, cp, opts);
		let D = CL && CL.layered ? CL.layered.D : CL ? coinDP(CL) : null;
		// (the floor's count: coin gates at T - 1 can cut every tour (Wine Quest I's): the legs by the count held)
		if (!D && floorDP) { CL = coinLegsLayered(B, PH, cp, T0() + maxMs, opts); D = CL && CL.layered ? CL.layered.D : null; }
		if (D) {
			const none = new Uint8Array(N);
			const bit = Int32Array.from(CL.coins, (q) => level.coinBit[q]);
			const leg = Int32Array.from(CL.coins, (q) => addBody(CL.fields.get(q), none));
			dp = { n: D.n, T: D.T, bit, leg, h: D.h, rounds: CL.rounds, tour: CL.layered ? CL.layered.tour : null, ...(floorDP ? { free: true, max: true, floor: true } : {}) };
		}
	}
	// THE COIN DP OUTSIDE THE LAYER PRODUCT (the budget left the coins out and the walk plan passes a coin door: CTM_2's
	// 16-coin door, "coins: over 31 layers"): the DP over the level's gold coins (18 or fewer) with coinLegsFree's legs
	// (n more bodies: within the budget's bytes and time, else none), below T the LARGER of it and the layer field's
	// (dp.max: the layer field walks through the coin doors it does not model, so the least of both was its way; the
	// DP's legs are blind to the kept features' gates, which the layer field models: each is a relaxation of the way to
	// go, the larger the better informed; past T coins, or where no leg has a value, the layer field's). The CPU file's alone (steerFileBytes(st, fp, true): flags 1 | 4, its leg bodies after
	// the layer bodies); the plain (GPU) file stays as it was (its bodies [0, nPlain), no DP, prioShift without them).
	// Order only: nothing prunes by it (opts.freeDP === false: none, as before)
	const nPlain = dp && dp.floor ? nPlain0 : bodies.length;
	// (only where the budget's cut WAS the coins ("coins: over ..."): the plan's counterexample named them next. Where it
	// cut another feature first (Fizio1 "team: over 31 layers", its keys kept) the coins are no known next obstacle and
	// the walk tour, blind to the keys, lost coins there in the product: 48 vs 87 and 32 vs 34 in 2 A/B pairs)
	const freeOn = !dp && !opts.noDP && !opts.coinT && opts.freeDP !== false && /^coins:/.test(String(over || '')) && M.names.indexOf('coins') < 0 && M.S > 1;
	if (freeOn) {
		const T = planCoinT(B);
		const coinsF = A.special.filter((x) => x[1] === 'coins').map((x) => x[0]).filter((q) => level.coinBit[q] >= 0);
		const n = coinsF.length;
		if (T >= 1 && T <= n && n <= 18) {
			if ((bodies.length + n) * bodyBytes > maxBytes || Date.now() - T0() > maxMs) over = `${over}; the coin DP:${(bodies.length + n) * bodyBytes > maxBytes ? `over ${mb}` : secs}`;
			else {
				const CL = coinLegsFree(B, PH, T, coinsF, opts);
				const D = coinDP(CL);
				if (D) {
					const none = new Uint8Array(N);
					const bit = Int32Array.from(CL.coins, (q) => level.coinBit[q]);
					const leg = Int32Array.from(CL.coins, (q) => addBody(CL.fields.get(q), none));
					dp = { n: D.n, T: D.T, bit, leg, h: D.h, rounds: CL.rounds, tour: coinTour(CL, D, A.start.t), free: true, max: true };
				}
			}
		}
	}
	const feats = M.feats.map((f, n) => {
		const k = f.key;
		const kind = k.startsWith('key') ? 1 : k.startsWith('psw:') ? 2 : k.startsWith('osw:') ? 3 : k === 'team' ? 4 : k === 'prot' ? 5 : k === 'coins' ? 6 : k === 'bcoins' ? 7 : k === 'crown' ? 8 : 9;
		const param = kind === 1 ? +k.slice(3) : kind === 2 || kind === 3 ? +k.slice(4) : 0;
		return { key: k, kind, param, radix: M.radix[n], stride: M.stride[n] };
	});
	const teamF = M.feats.find((f) => f.key === 'team');
	const steer = { version: VERSION, W: A.W, H: A.H, N, feats, team: teamF ? teamF.values.slice() : [], S: M.S, layerBody, bodies, goals, dp, prioShift: 0, nPlain };
	// (the DP outside the layer product is the CPU file's alone: the plain file's shift as without it)
	steer.prioShift = dp && dp.free ? prioShiftOf({ bodies: bodies.slice(0, nPlain), dp: null }) : prioShiftOf(steer);
	const sim0 = new E.EESim(level); sim0.reset();
	// the coin tour (no DP; the plan's coin door, or the full count where the coins are modelled: the min with the layer
	// field keeps the ways that need no more coins; the CPU file's alone: steerFileBytes(st, fp, true); after prioShift,
	// so the GPU's file stays as it was)
	// ONLY where the coins are modelled (first = false: the min with the layer field, whose coin layers still hold the
	// ways that need no more coins). Where they are not (the budget left the coin feature out, or the walk plan's own
	// coin door with the coins unmodelled) the tour would come FIRST below T, i.e. replace the layer field there, and its
	// T (the plan's door, or the level's full count) can over-demand coins: Weird Perfection T 99 where the known routes
	// take 70 (the tour's value 3998.6 tiles AT the trophy, main's field 1), Evolution Revolution T 45 where the route
	// takes 36 (1117 tiles 12 ticks before the finish, main's 5.8); that path was never measured in the product, so the
	// layer field stays main's there (`opts.tourFirst === true`: the unmodelled tour as it was, for measurement only)
	let tourInfo = null;
	if (!dp && !opts.noDP && !opts.noTour && !opts.coinT) {
		const modelled = M.names.indexOf('coins') >= 0;
		const nCoins = A.special.filter((x) => x[1] === 'coins').length;
		// (coins not modelled, opt-in only: the plan's own coin door, or the full count where the budget left the coins out
		// (LoZ Skyward Sword: "coins: over 31 layers"); a walk plan that passes no coin door and no refusal: no tour)
		const coinsOver = !!over && /^coins|coin DP/.test(over);
		// (THE TOUR OUTSIDE THE LAYER PRODUCT, day 4, default on: the budget left the coins out (more than 18 coins, or no
		// DP) and the walk plan passes a coin door: below the PLAN'S door count, not the level's full count (Weird
		// Perfection's 99 where the routes take 70, Evolution Revolution's 45 where they take 36: the full count
		// over-demands), the larger of the tour's value and the layer field's (tour.first 2: the tour is blind to the kept
		// features' gates and gravity, the layer field to the coin doors: two relaxations, the larger the better informed;
		// replacing the layer field (first 1) dropped its key and switch guidance: Fizio1's keys); opts.freeDP === false:
		// none, as before)
		const freeTour = freeOn && opts.tourFirst !== true && planCoinT(B) >= 1;
		// (the floor's count past the DP (more than 18 coins, or no DP): the tour over at least it, the larger of both)
		const floorTour = !freeTour && modelled && opts.tourFirst !== true && floorT > planCoinT(B);
		const T = freeTour ? Math.min(nCoins, planCoinT(B)) : Math.min(nCoins, Math.max(planCoinT(B), modelled || coinsOver ? fullCoinT(A) : 0, floorTour ? floorT : 0));
		if (T >= 1 && (modelled || opts.tourFirst === true || freeTour) && (nCoins >= TOUR_MIN_COINS || coinsOver || freeTour || floorTour)) {
			const kappa = PH.kappa || kappaOf(A, { oneWayEntry: true, portalForced: true, exitEntry: exitEntryOn() });
			const R = buildTour(A, level, T, freeTour || floorTour ? 2 : !modelled, kappa, T0() + 2 * maxMs, opts.tourMaxBytes || TOUR_MAX_BYTES);
			if (R) {
				steer.tour = R;
				let s1 = tourFifths(steer, sim0);
				if (s1 > TOUR_MAX_TILES * 5) {
					const f = TOUR_MAX_TILES * 5 / s1;
					for (let k = 0; k < R.legs.length; k++) if (R.legs[k] < CUT) R.legs[k] = Math.round(R.legs[k] * f);
					for (let k = 0; k < R.C.length; k++) R.C[k] *= f;
					for (let k = 0; k < R.tail.length; k++) R.tail[k] *= f;
					R.scale = f;
					s1 = tourFifths(steer, sim0);
				}
				tourInfo = { n: R.n, T: R.T, first: !!R.first, ...(R.first === 2 ? { max: true } : {}), kappa: Math.round(kappa * 1000) / 1000, scale: R.scale ? Math.round(R.scale * 1000) / 1000 : 1, ms: R.ms, mb: Math.round(R.bytes / 104857.6) / 10, start: s1 >= 0 ? s1 / 5 : null };
			} else tourInfo = { none: true, T };
		}
	}
	// THE BLUE COIN DP (d4-blue-coin-dp, kindPlan / kindLegs / blueDP above): only where the gold coins gave no DP, no
	// free DP and no tour (a level with both keeps main's gold DP: Beaches in Space's plan passes its 3-blue door before its
	// 16-coin door, and its gold DP guides the rest of the way), where the plan's first blue door comes before its first
	// gold door and the build has it (kindLegs within the bytes and the time left): the CPU file's alone, its bodies after
	// nPlain (after the tour's place: none there), the plain (GPU) file and its prioShift as without it. Not with the plan
	// past its count (coinT: gold)
	const blue = dp || steer.tour || opts.noDP || opts.coinT || !blueDPOn(opts) ? null
		: blueDP(B, PH, level, { maxFields: Math.max(0, Math.floor(maxBytes / bodyBytes) - bodies.length), msPer: PH.ms / Math.max(1, PH.builds) }, T0() + maxMs, opts);
	if (blue && blue.K) {
		// (the blue DP's leg bodies: per coin j and layer s of the steer, the body of its leg field in s's layer of the model
		// without the blue count (legS, -1: none); leg[j] the start layer's (the wall breaker's gate file when nextGate gives
		// no body))
		const K = blue.K, n = K.coins.length, S = M.S, none = new Uint8Array(N);
		const bodyOf = new Map();
		const bOf = (f) => { if (!f) return -1; let b = bodyOf.get(f); if (b === undefined) bodyOf.set(f, b = addBody(f, none)); return b; };
		const legS = new Int32Array(n * S).fill(-1);
		for (let j = 0; j < n; j++) for (let s = 0; s < S; s++) legS[j * S + s] = bOf(K.F[j][K.toL[s]]);
		const leg = Int32Array.from(K.coins, (q, j) => { let b = legS[j * S + M.s0]; for (let s = 0; b < 0 && s < S; s++) b = legS[j * S + s]; return b; });
		dp = { n, T: K.T, bit: Int32Array.from(K.coins, (q) => level.coinBit[q]), leg, legS, h: K.D.h, rounds: K.rounds, tour: K.tour, free: true, max: true, kind: 'bcoins' };
		steer.dp = dp;
	}
	steer.info = { features: M.names, layers: PH.layers, bodies: bodies.length, builds: PH.builds, kappa: Math.round(PH.kappa * 1000) / 1000, cegar,
		dp: dp ? { n: dp.n, T: dp.T, rounds: dp.rounds, tour: dp.tour ? dp.tour.map((t) => [t % A.W, Math.floor(t / A.W)]) : undefined, ...(dp.free ? { free: true } : {}), ...(dp.floor ? { floor: true } : {}), ...(dp.kind ? { kind: dp.kind } : {}) } : null,
		fullT: Math.max(fullCoinT(A), floorT), start: steerAt(steer, sim0), ms: Date.now() - t0, over,
		tour: tourInfo, ...(floors.length || probeMs >= 1 ? { floors, floorT, probeMs } : {}), ...(blue ? { blue: blue.info } : {}) };
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
/** the DP's count of a sim (the blue DP, kind 'bcoins': the blue coins; else the gold ones) */
const dpCount = (D, sim) => (D.kind === 'bcoins' ? sim.blue_coins : sim.coins);
/** the DP's leg body of coin q for a ball in layer s (the blue DP's legs per layer: legS; -1: none) */
const dpLeg = (st, D, q, s) => (D.legS ? (s >= 0 && s < st.S ? D.legS[q * st.S + s] : -1) : D.leg[q]);
function dpFifths(st, sim, bound, s) {
	const D = st.dp;
	if (!D || !(dpCount(D, sim) < D.T)) return -1;
	if (D.legS && s === undefined) s = layerIndex(st, sim);
	let m = 0;
	for (let i = 0; i < D.n; i++) { const b = D.bit[i]; if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) m |= 1 << i; }
	let best = Infinity;
	for (let q = 0; q < D.n; q++) {
		if (m & (1 << q)) continue;
		const rest = D.h[(m | (1 << q)) * D.n + q];
		if (!(rest < Infinity) || rest >= best || rest >= bound) continue;
		const lb = dpLeg(st, D, q, s);
		if (lb < 0) continue;
		const c = bodyAt(st.bodies[lb], sim, 0, 0);
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
	if (!D || !(dpCount(D, sim) < D.T)) return null;
	const s = D.legS ? layerIndex(st, sim) : -1;
	let m = 0;
	for (let i = 0; i < D.n; i++) { const b = D.bit[i]; if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) m |= 1 << i; }
	let best = null;
	for (let q = 0; q < D.n; q++) {
		if (m & (1 << q)) continue;
		const rest = D.h[(m | (1 << q)) * D.n + q];
		if (!(rest < Infinity)) continue;
		const lb = dpLeg(st, D, q, s);
		if (lb < 0) continue;
		const c = bodyAt(st.bodies[lb], sim, 0, 0);
		if (c < 0 || c >= CUT - 1) continue;
		// (body: the leg field it was valued by, the wall breaker's gate file: the blue DP's in the ball's own layer)
		if (!best || c + rest < best.v) best = { i: q, bit: D.bit[q], v: c + rest, body: lb };
	}
	return best;
}
/** past the coin plan's count (nextGate null): the untaken coin with the least leg from the state ({i, bit, v}, null:
 *  none with a value; `skip`: a Set of coin indices left out). The plan's count comes from the walk plan, which is blind to gravity: Wine Quest I's walk plan
 *  passes its 5-coin door and a 16-row shaft whose steps are 10-coin gates; the level needs all 10 coins */
function nextCoin(st, sim, skip) {
	const D = st.dp;
	if (!D) return null;
	const s = D.legS ? layerIndex(st, sim) : -1;
	let best = null;
	for (let q = 0; q < D.n; q++) {
		const b = D.bit[q];
		if (b >= 0 && ((sim._coinBits[b >> 5] >>> (b & 31)) & 1) === 1) continue;
		if (skip && skip.has(q)) continue;
		const lb = dpLeg(st, D, q, s);
		if (lb < 0) continue;
		const c = bodyAt(st.bodies[lb], sim, 0, 0);
		if (c < 0 || c >= CUT - 1) continue;
		if (!best || c < best.v) best = { i: q, bit: b, v: c, body: lb };
	}
	return best;
}
/** the steer cost of a sim's state in fifths of a tile (-1 = no value) */
function steerFifths(st, sim) {
	const s = layerIndex(st, sim);
	const v = layerFifths(st, sim, s);
	// (the coin tour, the CPU file's (no DP): the min with the layer field's, like the DP's; first below T where the coins
	// are not modelled: the layer field walks through their doors)
	// (tour.first 2, the tour outside the layer product: the larger of both, as the free DP's)
	if (st.tour) { const t = tourFifths(st, sim); return t < 0 ? v : v < 0 ? t : st.tour.first === 2 ? Math.max(v, t) : st.tour.first ? t : Math.min(v, t); }
	// (st.dpFirst: the coin DP's value wherever it has one, the layer field's only past the coins (goexplore.js --dpFirst):
	// the layer's own way needs no more coins, and on Forgotten Veil it is a false one (the portal at (77,109)))
	if (st.dpFirst) { const d = dpFifths(st, sim, Infinity); return d < 0 ? v : d; }
	// (the coin DP outside the layer product, dp.max: the larger of both)
	if (st.dp && st.dp.max) { const d = dpFifths(st, sim, Infinity, s); return d < 0 ? v : v < 0 ? d : Math.max(v, d); }
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
function steerFileBytes(st, levelFp, withTour) {
	const N = st.N;
	// (the coin tour: the CPU file's alone, flags 2, its section's offset a u64 at 56; the plain file stays as it was)
	const R = withTour && st.tour ? st.tour : null;
	// (the coin DP outside the layer product (dp.free): the CPU file's alone, flags 1 | 4 (the larger of both below T), its leg bodies
	// after the layer bodies; the plain file: the bodies [0, nPlain), no DP, as without it)
	const plainOnly = !!(st.dp && st.dp.free && !withTour);
	const dp = plainOnly ? null : st.dp;
	const bodiesOut = plainOnly ? st.bodies.slice(0, st.nPlain) : st.bodies, goalsOut = plainOnly ? st.goals.slice(0, st.nPlain) : st.goals;
	const bodyBytes = bodiesOut.map((f) => RF.reachFileBytes(f, levelFp));
	const parts = [];
	const i32 = (a) => Buffer.from(Int32Array.from(a).buffer);
	parts.push(i32(st.feats.flatMap((f) => [f.kind, f.param, f.radix, f.stride])));
	parts.push(i32(st.team));
	parts.push(i32(st.layerBody));
	const offIdx = parts.length;
	parts.push(Buffer.alloc(8 * bodiesOut.length), Buffer.alloc(8 * bodiesOut.length));
	parts.push(Buffer.concat(goalsOut.map((g) => Buffer.from(g.buffer, g.byteOffset, N))));
	const bodyIdx = parts.length;
	for (const b of bodyBytes) parts.push(b);
	// (the blue DP's legs per layer (flags 32): i32 legS[n x S] after h)
	if (dp) { parts.push(i32(dp.bit)); parts.push(i32(dp.leg)); parts.push(Buffer.from(Float32Array.from(dp.h).buffer)); if (dp.legS) parts.push(i32(dp.legS)); }
	const tourIdx = parts.length;
	if (R) {
		parts.push(i32([R.n, R.T, R.first, 0]), i32(R.bit), i32(R.order));
		parts.push(Buffer.from(Float32Array.from(R.tail).buffer), Buffer.from(Float32Array.from(R.C).buffer));
		parts.push(Buffer.from(R.legs.buffer, R.legs.byteOffset, R.legs.byteLength));
	}
	let size = 64;
	const offs = [];
	for (const p of parts) { size = al8(size); offs.push(size); size += p.length; }
	const offB = Buffer.alloc(8 * bodiesOut.length), sizB = Buffer.alloc(8 * bodiesOut.length);
	bodyBytes.forEach((b, k) => { offB.writeBigUInt64LE(BigInt(offs[bodyIdx + k]), 8 * k); sizB.writeBigUInt64LE(BigInt(b.length), 8 * k); });
	parts[offIdx] = offB; parts[offIdx + 1] = sizB;
	const buf = Buffer.alloc(al8(size));
	buf.write('RCH4', 0, 'latin1');
	[VERSION, st.W, st.H, st.feats.length, st.S, bodiesOut.length, (dp ? 1 : 0) | (R ? 2 : 0) | (dp && dp.max ? 4 : 0) | (dp && dp.kind === 'bcoins' ? 16 : 0) | (dp && dp.legS ? 32 : 0), st.prioShift, st.team.length, dp ? dp.n : 0, dp ? dp.T : 0].forEach((v, k) => buf.writeInt32LE(v, 4 + 4 * k));
	if (levelFp) { buf.writeUInt32LE(levelFp[0] >>> 0, 48); buf.writeUInt32LE(levelFp[1] >>> 0, 52); }
	if (R) buf.writeBigUInt64LE(BigInt(offs[tourIdx]), 56);
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
		o += 4 * nh;
		// (flags 16: the DP counts blue coins; 32: its legs per layer, i32 legS[n x S] after h: the blue DP, CPU file only)
		dp = { n: dpN, T: dpT, bit, leg, h, ...(flags & 4 ? { max: true, free: true } : {}), ...(flags & 16 ? { kind: 'bcoins' } : {}), ...(flags & 32 ? { legS: ints(dpN * S) } : {}) };
	}
	// (the coin tour: views on the file's bytes where aligned)
	let tour = null;
	if (flags & 2) {
		o = Number(buf.readBigUInt64LE(56));
		const hd = ints(4), n = hd[0];
		const bit = ints(n), order = ints(n);
		const view = (Ctor, len) => { o = al8(o); let a; if ((buf.byteOffset + o) % Ctor.BYTES_PER_ELEMENT === 0) a = new Ctor(buf.buffer, buf.byteOffset + o, len); else a = new Ctor(Uint8Array.from(buf.subarray(o, o + len * Ctor.BYTES_PER_ELEMENT)).buffer); o += len * Ctor.BYTES_PER_ELEMENT; return a; };
		const tail = view(Float32Array, n), C = view(Float32Array, n * n), legs = view(Uint16Array, n * N);
		tour = { n, T: hd[1], first: hd[2], bit, order, tail, C, legs };
	}
	return { version: ver, tour, W, H, N, feats, team, S, layerBody, bodies, goals, dp, prioShift, levelFp: [buf.readUInt32LE(48), buf.readUInt32LE(52)], bodyOff: bOff, bodySize: bSize };
}

module.exports = { VERSION, STEER_MAX_BYTES, STEER_MAX_MS, TIME_WAIT, buildSteer, steerFifths, steerAt, steerScore, layerIndex, nextGate, nextCoin, steerFileBytes, writeSteerFile, readSteerFile, readReachBytes,
	// (tests, tools)
	analyze, makeModel, walkBuild, buildPhysics, counterexample, layeredPlan, coinPlan, fullCoinT, coinLegsPhys, coinLegsLayered, coinDP, arriveCost,
	layeredField, planFrom, qMoveLayer, qMoveOK, layerLevel,
	// (the leg workers)
	_legFieldOf: legFieldOf };
