'use strict';
// THE LEVEL MODEL (n4plan, part 'planner': the compiler's UNDERSTAND stage). compileModel(L, {file}) -> the level as an
// abstract machine: its TRIGGERS (the 4-connected components of one trigger block and param: coins, blue coins, keys,
// purple / orange switches and their resets, team effects, protection, effect resets, effects, the crown, checkpoints,
// the trophy), its GATES (the components of door / gate tiles and the feature each reads, steer.js analyze's GATE table),
// the abstract STATE of a real engine state (stateOf: the values of the features some gate reads, plus which coin tiles
// are taken where a coin door or gate exists), the level AS A STATE HOLDS IT (levelOf: gates open -> air, shut -> a wall;
// types.js levelNow's rules from an abstract state), the WALK REGIONS under a state (regionOf) and the RCH3 goal field on
// that level (reachable: its -1 is a proof, types.js goalField).
//
// Beyond the contract (the planner's own machinery, exported on the model object):
//   touch(S, trig, mode) -> {S2, changed, expect}: the abstract effect of touching a trigger (coins: every untaken coin of
//     the component; keys sticky: a key once touched keeps its doors AND gates passable, the expiry relaxation);
//   dist(S, pos, mode) -> Int32Array of walk STEPS from a position (0-1 BFS: 8-way over the tiles the ball's centre can be
//     in under S, a diagonal closed between two walls, the half-block quadrant rule where steer.js analyze has it,
//     killers and one-ways passable, a portal hop free with its entry step): the tier-0 geometry;
//   lbOfSteps(D) -> ADMISSIBLE ticks: ceil(16 (D - 1) / 16.25) (the centre moves at most 16.25 px an axis a tick, so a path
//     piece of Chebyshev length <= 16 changes the 8-way tile distance by at most 1; a portal hop's entry step is free);
//   pairLb(S, pos, tiles, mode) / pairSteps(...): the admissible ticks and the walk steps from a position to a tile set,
//     with the death shortcut (a killer, 54 dead ticks, any respawn tile) where the level can kill.
// modes: 'lb' (the lower bound's relaxation: coin gates shut only where the anchor's REAL count already shuts them, keys
// sticky) and 'est' (the model's own counts). The bound is sound between two consecutive relevant events of any real
// route: the relevant features do not change there, so every gate the model shuts is shut for the real ball.
const E = require('../eesim.js');
const RF = require('../reach.js');
const ST = require('../steer.js');
const T = require('./types.js');

const TROPHY = 121, CHECKPOINT = 360, SPAWN = 255;
const CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416;
const DEAD_TICKS = 54;          // the dead ticks before the respawn (a death costs at least that)
const V_TICK = 16.25;           // px an axis a tick, the centre's most (endgame.js D_TICK)
const INF = 0x3fffffff;
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const KEY_BITS = new Map([[23, 0], [24, 1], [25, 2], [26, 0], [27, 1], [28, 2], [1005, 3], [1006, 4], [1007, 5], [1008, 3], [1009, 4], [1010, 5]]);
const DEATH_DOORS = new Set([1011, 1012]);
const KIND_OF = { key: 'key', psw: 'psw', pswR: 'pswR', osw: 'osw', oswR: 'oswR', team: 'team', prot: 'prot', reset: 'reset', fx: 'fx', coins: 'coin', bcoins: 'bcoin', crown: 'crown' };
const KEY_NAMES = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];

/** admissible ticks for D walk steps (8-way, a portal hop's entry step free) */
function lbOfSteps(D) { return D >= INF ? Infinity : Math.max(0, Math.ceil(16 * (D - 1) / V_TICK - 1e-9)); }

/** a small string hash (FNV-1a over a byte view) */
function hashBytes(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }

/**
 * compileModel(L, o) -> the model (see the header). o.file: the level file (labels only). Synchronous (the caller may
 * await it).
 */
function compileModel(L, o = {}) {
	const t0 = Date.now();
	const A = ST.analyze(L, {});
	const W = A.W, H = A.H, N = A.N, fg = L.fg, lk = L.lookup0;
	// ---------------------------------------------------------------- features some gate reads
	const featSet = new Set();
	for (const [k, f] of A.feats) if (f.gates > 0 && k !== 'fx') featSet.add(k);
	let deathT = 0;
	for (let i = 0; i < N; i++) if (DEATH_DOORS.has(fg[i])) deathT = Math.max(deathT, lk[i]);
	if (deathT > 0) featSet.add('deaths');
	const feats = [...featSet].sort();
	const fIdx = new Map(feats.map((f, n) => [f, n]));
	const hasCoinGate = { coins: false, bcoins: false };
	for (let i = 0; i < N; i++) {
		if (A.cls[i] !== 3) continue;
		if (A.gateFeat[i] === 'coins' && A.gatePol[i] === 0) hasCoinGate.coins = true;
		if (A.gateFeat[i] === 'bcoins' && A.gatePol[i] === 0) hasCoinGate.bcoins = true;
	}
	// ---------------------------------------------------------------- triggers (components)
	const specAt = new Map();   // tile -> [kind, param]
	for (const [t, kind, param] of A.special) specAt.set(t, [KIND_OF[kind] || kind, param]);
	for (let i = 0; i < N; i++) {
		if (fg[i] === CHECKPOINT && !specAt.has(i)) specAt.set(i, ['cp', 0]);
		else if (fg[i] === TROPHY && !specAt.has(i)) specAt.set(i, ['trophy', 0]);
	}
	const trigOf = new Int32Array(N).fill(-1);
	const triggers = [];
	const featOfTrig = (kind, param) => {
		switch (kind) {
			case 'key': return 'key' + param;
			case 'psw': return 'psw:' + param;
			case 'pswR': return param === 1000 ? 'psw:*' : 'psw:' + param;
			case 'osw': return 'osw:' + param;
			case 'oswR': return param === 1000 ? 'osw:*' : 'osw:' + param;
			case 'team': return 'team';
			case 'prot': return 'prot';
			case 'reset': return featSet.has('prot') ? 'prot' : 'fx';
			case 'fx': return 'fx';
			case 'coin': return 'coins';
			case 'bcoin': return 'bcoins';
			case 'crown': return 'crown';
			case 'cp': return 'cp';
			case 'trophy': return 'silver';
			default: return null;
		}
	};
	const labelOf = (kind, param, x, y) => {
		const at = `(${x},${y})`;
		switch (kind) {
			case 'key': return `${KEY_NAMES[param] || 'key' + param} key ${at}`;
			case 'psw': return `purple switch ${param} ${at}`;
			case 'pswR': return `purple reset ${param === 1000 ? 'all' : param} ${at}`;
			case 'osw': return `orange switch ${param} ${at}`;
			case 'oswR': return `orange reset ${param === 1000 ? 'all' : param} ${at}`;
			case 'team': return `team ${param} ${at}`;
			case 'prot': return `protection ${param ? 'on' : 'off'} ${at}`;
			case 'reset': return `effect reset ${at}`;
			case 'fx': return `effect ${fg[y * W + x]}=${param} ${at}`;
			case 'coin': return `coin ${at}`;
			case 'bcoin': return `blue coin ${at}`;
			case 'crown': return `crown ${at}`;
			case 'cp': return `checkpoint ${at}`;
			case 'trophy': return `trophy ${at}`;
			default: return `${kind} ${at}`;
		}
	};
	for (const [t, [kind, param]] of specAt) {
		if (trigOf[t] >= 0) continue;
		const id = triggers.length, tiles = [t];
		trigOf[t] = id;
		for (let q = 0; q < tiles.length; q++) {
			const c = tiles[q], x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (trigOf[j] >= 0) continue;
				const s = specAt.get(j);
				if (!s || s[0] !== kind || s[1] !== param) continue;
				trigOf[j] = id; tiles.push(j);
			}
		}
		tiles.sort((a, b) => a - b);
		const feat = featOfTrig(kind, param);
		const x0 = tiles[0] % W, y0 = (tiles[0] / W) | 0;
		let relevant = false;
		if (kind === 'trophy') relevant = true;
		else if (feat === 'psw:*') relevant = feats.some((f) => f.startsWith('psw:'));
		else if (feat === 'osw:*') relevant = feats.some((f) => f.startsWith('osw:'));
		else if (feat) relevant = featSet.has(feat);
		triggers.push({ id, kind, tiles, feat, param, label: labelOf(kind, param, x0, y0) + (tiles.length > 1 ? ` x${tiles.length}` : ''), relevant, coins: null });
	}
	// coin tiles (only where the count is read): index per tile, per component its indices
	const coinIdx = new Int32Array(N).fill(-1), bcoinIdx = new Int32Array(N).fill(-1);
	const coinTiles = [], bcoinTiles = [];
	for (const X of triggers) {
		if (X.kind === 'coin' && featSet.has('coins')) { X.coins = X.tiles.map((t) => { coinIdx[t] = coinTiles.length; coinTiles.push(t); return coinIdx[t]; }); }
		if (X.kind === 'bcoin' && featSet.has('bcoins')) { X.coins = X.tiles.map((t) => { bcoinIdx[t] = bcoinTiles.length; bcoinTiles.push(t); return bcoinIdx[t]; }); }
	}
	const trophies = triggers.filter((X) => X.kind === 'trophy');
	const trophyTiles = [];
	for (const X of trophies) for (const t of X.tiles) trophyTiles.push(t);
	// ---------------------------------------------------------------- gates (components)
	const gateOf = new Int32Array(N).fill(-1);
	const gates = [];
	for (let i = 0; i < N; i++) {
		if (A.cls[i] !== 3 || gateOf[i] >= 0) continue;
		const k = A.gateFeat[i], pol = A.gatePol[i], param = A.gateParam[i], id = gates.length, tiles = [i];
		gateOf[i] = id;
		for (let q = 0; q < tiles.length; q++) {
			const c = tiles[q], x = c % W, y = (c / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (gateOf[j] >= 0 || A.cls[j] !== 3 || A.gateFeat[j] !== k || A.gatePol[j] !== pol || A.gateParam[j] !== param || fg[j] !== fg[i]) continue;
				gateOf[j] = id; tiles.push(j);
			}
		}
		gates.push({ id, tiles, feat: k === 'open' ? (DEATH_DOORS.has(fg[i]) ? 'deaths' : 'open') : k, pol, param, block: fg[i] });
	}
	// ---------------------------------------------------------------- respawns, killers, the idle start
	const respawn = [];
	{
		const seen = new Uint8Array(N);
		const add = (i) => { if (i >= 0 && i < N && !seen[i] && A.cls[i] !== 0) { seen[i] = 1; respawn.push(i); } };
		const sx = L.spawnsX || [], sy = L.spawnsY || [];
		for (let k = 0; k < sx.length; k++) if (sx[k] >= 0 && sy[k] >= 0 && sx[k] < W && sy[k] < H) add(sy[k] * W + sx[k]);
		if (!sx.length && W > 1 && H > 1) add(W + 1);
		for (let i = 0; i < N; i++) if (fg[i] === CHECKPOINT || fg[i] === SPAWN) add(i);
	}
	let timed = false, killers = 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0) || id === LAVA) timed = true;
		if (A.cls[i] === 1) killers++;
	}
	const canDie = (killers > 0 || timed) && respawn.length > 0;
	// the checkpoints in the state where a death can move the ball: the respawn is the checkpoint touched last, else a
	// spawn (the death shortcut then goes only there: a checkpoint not touched yet is no respawn)
	const cpTrigs = triggers.filter((X) => X.kind === 'cp');
	const cpTracked = canDie && cpTrigs.length > 0 && cpTrigs.length <= 255;
	if (cpTracked) for (const X of cpTrigs) X.relevant = true;
	const spawnTiles = [];
	{
		const sx = L.spawnsX || [], sy = L.spawnsY || [];
		for (let k = 0; k < sx.length; k++) if (sx[k] >= 0 && sy[k] >= 0 && sx[k] < W && sy[k] < H && A.cls[sy[k] * W + sx[k]] !== 0) spawnTiles.push(sy[k] * W + sx[k]);
		if (!spawnTiles.length) for (let i = 0; i < N; i++) if (fg[i] === SPAWN) spawnTiles.push(i);
		if (!spawnTiles.length && W > 1 && H > 1) spawnTiles.push(W + 1);
	}
	// the tiles the ball can die in (a killer, the tiles next to one: a half block's current tile redirect; anywhere with a
	// timed killer): the death shortcut's sources
	const dieTile = new Uint8Array(N);
	if (canDie) {
		for (let i = 0; i < N; i++) {
			if (A.cls[i] === 0) continue;
			if (timed) { dieTile[i] = 1; continue; }
			if (A.cls[i] === 1) { dieTile[i] = 1; continue; }
			const x = i % W, y = (i / W) | 0;
			for (let d = 0; d < 8 && !dieTile[i]; d++) { const nx = x + DX8[d], ny = y + DY8[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && A.cls[ny * W + nx] === 1) dieTile[i] = 1; }
		}
	}
	const sim0 = new E.EESim(L); sim0.reset();
	const startTile = T.tileOf(sim0, W, H);
	// the idle trajectory (no input): free before the run timer starts; its tiles are the start's free sources
	const idleTiles = [startTile];
	{
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		E.applyMask(inp, 0);
		const seen = new Set([startTile]);
		for (let k = 0; k < 3000; k++) {
			const px = sim.px, py = sim.py;
			sim.tick(inp);
			if (sim.is_dead || sim.has_silver_crown) break;
			const t = T.tileOf(sim, W, H);
			if (!seen.has(t)) { seen.add(t); idleTiles.push(t); }
			if (sim.px === px && sim.py === py && sim.speed_x === 0 && sim.speed_y === 0) break;
		}
	}
	// ---------------------------------------------------------------- states
	const featIsCount = (f) => f === 'coins' || f === 'bcoins' || f === 'deaths';
	function mkState(vals, taken, btaken, cp = -1) {
		const dkey = vals.join(',');
		const key = dkey + (taken ? '|' + hashBytes(taken) : '') + (btaken ? '|' + hashBytes(btaken) : '') + (canDie ? '|c' + cp : '');
		let gain = 0;
		for (let n = 0; n < feats.length; n++) if (vals[n] !== init[feats[n]]) gain++;
		if (taken) for (let k = 0; k < taken.length; k++) gain += taken[k];
		if (btaken) for (let k = 0; k < btaken.length; k++) gain += btaken[k];
		const fv = {};
		feats.forEach((f, n) => { fv[f] = vals[n]; });
		return { key, dkey, feats: fv, vals, taken, btaken, gain, cp };
	}
	function stateOf(sim) {
		const vals = feats.map((f) => {
			let v = T.featValue(sim, f);
			if (f === 'deaths') v = Math.min(v, deathT);
			return v;
		});
		let taken = null, btaken = null;
		if (coinTiles.length) { taken = new Uint8Array(coinTiles.length); coinTiles.forEach((t, k) => { taken[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }); }
		if (bcoinTiles.length) { btaken = new Uint8Array(bcoinTiles.length); bcoinTiles.forEach((t, k) => { btaken[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }); }
		const cp = canDie && sim.checkpoint.x >= 0 ? trigOf[sim.checkpoint.y * W + sim.checkpoint.x] : -1;
		return mkState(vals, taken, btaken, cp);
	}
	const init = {};
	for (const f of feats) init[f] = f === 'deaths' ? Math.min(T.featValue(sim0, f), deathT) : T.featValue(sim0, f);
	const S0 = stateOf(sim0);
	// ---------------------------------------------------------------- the abstract touch
	/**
	 * touch(S, X) -> {S2, changed, expect}: the state after touching trigger X (S2 === S when nothing relevant changes).
	 * expect: the waypoint's Expect (the feature and its value right after the first effect of the touch; coins: +1).
	 */
	function touch(S, X) {
		if (X.kind === 'cp') return cpTracked && S.cp !== X.id ? { S2: mkState(S.vals, S.taken, S.btaken, X.id), changed: true, expect: null } : { S2: S, changed: false, expect: null };
		if (!X.relevant || X.kind === 'trophy' || X.kind === 'fx') return { S2: S, changed: false, expect: null };
		const vals = S.vals.slice();
		let taken = S.taken, btaken = S.btaken, expect = null;
		const setF = (f, v) => { const n = fIdx.get(f); if (n === undefined) return; vals[n] = v; };
		const getF = (f) => { const n = fIdx.get(f); return n === undefined ? undefined : vals[n]; };
		switch (X.kind) {
			case 'key': { const f = X.feat; if (getF(f) !== 1) { setF(f, 1); expect = { feat: f, value: 1 }; } break; }
			case 'psw': case 'osw': { const f = X.feat; const v = getF(f); if (v !== undefined) { setF(f, 1 - v); expect = { feat: f, value: 1 - v }; } break; }
			case 'pswR': case 'oswR': {
				if (X.feat.endsWith(':*')) { const pre = X.feat.slice(0, 4); for (const f of feats) if (f.startsWith(pre) && getF(f) === 1) { setF(f, 0); if (!expect) expect = { feat: f, value: 0 }; } }
				else if (getF(X.feat) === 1) { setF(X.feat, 0); expect = { feat: X.feat, value: 0 }; }
				break;
			}
			case 'team': if (getF('team') !== X.param) { setF('team', X.param); expect = { feat: 'team', value: X.param }; } break;
			case 'prot': if (getF('prot') !== X.param) { setF('prot', X.param); expect = { feat: 'prot', value: X.param }; } break;
			case 'reset': if (getF('prot') === 1) { setF('prot', 0); expect = { feat: 'prot', value: 0 }; } break;
			case 'crown': if (getF('crown') !== 1) { setF('crown', 1); expect = { feat: 'crown', value: 1 }; } break;
			case 'coin': case 'bcoin': {
				const isB = X.kind === 'bcoin', f = isB ? 'bcoins' : 'coins';
				const tk = isB ? btaken : taken;
				if (!tk || !X.coins) break;
				let add = 0;
				for (const k of X.coins) if (!tk[k]) add++;
				if (!add) break;
				const nt = tk.slice();
				for (const k of X.coins) nt[k] = 1;
				if (isB) btaken = nt; else taken = nt;
				expect = { feat: f, value: getF(f) + 1 };
				setF(f, getF(f) + add);
				break;
			}
			default: break;
		}
		if (!expect) return { S2: S, changed: false, expect: null };
		return { S2: mkState(vals, taken, btaken, S.cp), changed: true, expect };
	}
	/** the untaken tiles of a coin trigger in S (all tiles for another kind) */
	function liveTiles(S, X) {
		if ((X.kind !== 'coin' && X.kind !== 'bcoin') || !X.coins) return X.tiles;
		const tk = X.kind === 'bcoin' ? S.btaken : S.taken;
		if (!tk) return X.tiles;
		const out = [];
		X.tiles.forEach((t, n) => { if (!tk[X.coins[n]]) out.push(t); });
		return out;
	}
	// ---------------------------------------------------------------- gates under a state
	/** gate tile i open under S? mode 'lb': keys sticky, coin gates shut only by the anchor's real count (base) */
	function gateOpen(i, S, mode, base) {
		const k = A.gateFeat[i];
		if (k === 'open' || k === 'time') return true;
		if (k === 'static') return A.gatePol[i] === 1;
		const n = fIdx.get(k);
		if (n === undefined) return true;
		const v = S.vals[n];
		if (k.startsWith('key')) return v === 1 ? true : A.gatePol[i] === 0;
		if ((k === 'coins' || k === 'bcoins') && A.gatePol[i] === 0 && mode === 'lb') {
			const bv = base && base[k] !== undefined ? base[k] : init[k];
			return !(bv >= A.gateParam[i]);
		}
		return testGate(k, A.gatePol[i], A.gateParam[i], v);
	}
	/** the est walk's learned walls (the planner's CEGAR: tiles past which a failed step's closest approach did not get;
	 *  est only: the lb and the proofs never read them) */
	let estWalls = null, estWallVer = 0;
	function setEstWalls(mask) { estWalls = mask; estWallVer++; }
	/** the key of the gate pattern under S (the memo key of the geometry) */
	function doorKey(S, mode, base) {
		if (mode === 'walk') return (killers ? 'k:' : 'e:') + S.dkey;
		if (mode !== 'lb') return (estWalls ? 'w' + estWallVer : 'e') + ':' + S.dkey;
		if (!killers && !estWalls && !hasCoinGate.coins && !hasCoinGate.bcoins) return 'e:' + S.dkey;
		// (lb: killers passable; the coin gates' part is the base's: the model count opens doors only)
		return 'l:' + S.dkey + '|' + (base ? `${base.coins},${base.bcoins}` : '');
	}
	/** a Uint8Array(N) passable mask under S */
	const passMemo = new Map();
	function passMask(S, mode, base) {
		const key = doorKey(S, mode, base);
		const had = passMemo.get(key);
		if (had) { passMemo.delete(key); passMemo.set(key, had); return had; }
		const m = new Uint8Array(N);
		// (est: a killer is a wall unless the ball is protected; lb: passable, the relaxation)
		const kill = mode === 'lb' || mode === 'walk' || (S.feats && S.feats.prot === 1) ? 1 : 0;
		const gm = mode === 'walk' ? 'est' : mode;
		for (let i = 0; i < N; i++) {
			const c = A.cls[i];
			m[i] = c === 0 ? 0 : c === 3 ? (gateOpen(i, S, gm, base) ? 1 : 0) : c === 1 ? kill : 1;
		}
		if (mode === 'est' && estWalls) for (let i = 0; i < N; i++) if (estWalls[i]) m[i] = 0;
		passMemo.set(key, m);
		if (passMemo.size > 64) passMemo.delete(passMemo.keys().next().value);
		return m;
	}
	/** levelOf(S): a copy of L with every gate tile a touch changes as S holds it (open -> 0, shut -> 9); time doors,
	 *  death / zombie doors and the doors / gates of an active (sticky) key keep their blocks (open in RCH3) */
	const levelMemo = new Map();
	function levelOf(S) {
		const key = S.dkey;
		const had = levelMemo.get(key);
		if (had) return had;
		const nfg = Int32Array.from(fg);
		for (let i = 0; i < N; i++) {
			if (A.cls[i] !== 3) continue;
			const k = A.gateFeat[i];
			if (k === 'open' || k === 'time') continue;
			if (k === 'static') { nfg[i] = A.gatePol[i] === 1 ? 0 : 9; continue; }
			if (k.startsWith('key')) { const n = fIdx.get(k); if (n !== undefined && S.vals[n] === 1) continue; }
			nfg[i] = gateOpen(i, S, 'est', null) ? 0 : 9;
		}
		const Lc = Object.assign({}, L, { fg: nfg });
		levelMemo.set(key, Lc);
		if (levelMemo.size > 16) levelMemo.delete(levelMemo.keys().next().value);
		return Lc;
	}
	// ---------------------------------------------------------------- the walk geometry
	const portalExits = A.portalExits;
	const portalIn = new Uint8Array(N);
	for (const p of portalExits.keys()) portalIn[p] = 1;
	/** can the centre move from tile t in direction d under the pass mask m? */
	function moveOK(m, t, d) {
		const x = t % W, y = (t / W) | 0, nx = x + DX8[d], ny = y + DY8[d];
		if (nx < 0 || ny < 0 || nx >= W || ny >= H) return -1;
		const j = ny * W + nx;
		if (!m[j]) return -1;
		if (A.qMove) {
			const q = A.qMove[t * 8 + d];
			if (q === 1) return -1;
			if (q === 2 && !ST.qMoveOK(A, t, d, (i) => !m[i], (i) => m[i] === 1)) return -1;
		}
		if (DX8[d] !== 0 && DY8[d] !== 0) {
			if (!m[y * W + nx] && !m[ny * W + x]) return -1;
		}
		return j;
	}
	/**
	 * bfs(m, src) -> Int32Array(N) of walk steps from the source tiles (INF: none): 0-1 BFS, a step 1, the step into a
	 * portal tile with exits followed by its hop 0 (the hop lands on each exit), a start on a portal: its exits at 0.
	 */
	function bfs(m, src) {
		const dist = new Int32Array(N).fill(INF);
		let cur = new Int32Array(N), nxt = new Int32Array(N), nc = 0, nn = 0;
		for (const s of src) {
			if (s < 0 || s >= N || dist[s] === 0) continue;
			dist[s] = 0; cur[nc++] = s;
		}
		for (let k = 0; k < nc; k++) { const s = cur[k]; if (portalIn[s]) for (const e of portalExits.get(s)) if (m[e] && dist[e] > 0) { dist[e] = 0; cur[nc++] = e; } }
		let level = 0;
		while (nc > 0) {
			nn = 0;
			for (let k = 0; k < nc; k++) {
				const t = cur[k];
				if (dist[t] !== level) continue;
				for (let d = 0; d < 8; d++) {
					const j = moveOK(m, t, d);
					if (j < 0) continue;
					if (dist[j] > level + 1) { dist[j] = level + 1; nxt[nn++] = j; }
					if (portalIn[j]) for (const e of portalExits.get(j)) if (m[e] && dist[e] > level) { dist[e] = level; cur[nc++] = e; }
				}
			}
			const tmp = cur; cur = nxt; nxt = tmp; nc = nn; level++;
		}
		return dist;
	}
	const distMemo = new Map();
	let distBuilds = 0, distMs = 0;
	/** dist(S, pos, mode, base) -> the walk steps from pos.tiles under S (memo: 96 fields, LRU) */
	function dist(S, pos, mode = 'est', base = null) {
		const key = doorKey(S, mode, base) + '#' + pos.id;
		const had = distMemo.get(key);
		if (had) { distMemo.delete(key); distMemo.set(key, had); return had; }
		const t1 = Date.now();
		const d = bfs(passMask(S, mode, base), pos.tiles);
		distBuilds++; distMs += Date.now() - t1;
		distMemo.set(key, d);
		if (distMemo.size > 96) distMemo.delete(distMemo.keys().next().value);
		return d;
	}
	const respawnPos = { id: 'respawn', tiles: respawn, extra: DEAD_TICKS };
	const spawnPos = { id: 'spawns', tiles: spawnTiles, extra: DEAD_TICKS };
	const cpPos = new Map();
	/** the respawn position under S (the checkpoint touched last, else the spawns; lb without tracked checkpoints: every
	 *  respawn tile, since a real route may have touched any) */
	function respawnOf(S, mode) {
		if (!cpTracked && mode === 'lb') return respawnPos;
		if (S.cp === undefined || S.cp < 0) return spawnPos;
		let p = cpPos.get(S.cp);
		if (!p) { p = { id: 'cp' + S.cp, tiles: triggers[S.cp].tiles, extra: DEAD_TICKS }; cpPos.set(S.cp, p); }
		return p;
	}
	/** min over tiles of a dist field */
	const minOver = (d, tiles) => { let b = INF; for (const t of tiles) if (d[t] < b) b = d[t]; return b; };
	/** the death shortcut from pos under S: {dieSteps, fromRespawn(dist)} or null */
	const deathMemo = new Map();
	function deathVia(S, pos, mode, base) {
		if (!canDie) return null;
		const key = doorKey(S, mode, base) + '#' + pos.id;
		let dk = deathMemo.get(key);
		if (dk === undefined) {
			const d = dist(S, pos, mode, base);
			dk = INF;
			for (let i = 0; i < N; i++) if (dieTile[i] && d[i] < dk) { dk = d[i]; if (dk === 0) break; }
			deathMemo.set(key, dk);
			if (deathMemo.size > 4096) deathMemo.delete(deathMemo.keys().next().value);
		}
		if (dk >= INF) return null;
		return { dk, dr: dist(S, respawnOf(S, mode), mode, base) };
	}
	/** pairSteps(S, pos, tiles) -> the walk steps (INF: none; the death shortcut not counted) */
	function pairSteps(S, pos, tiles, mode = 'est', base = null) { return minOver(dist(S, pos, mode, base), tiles); }
	/** pairLb(S, pos, tiles, mode, base) -> ADMISSIBLE ticks from pos to the tiles under S (Infinity: none, a proof for the
	 *  walk relaxation: no way while S holds, deaths included) */
	function pairLb(S, pos, tiles, mode = 'lb', base = null) {
		const extra = pos.extra || 0;
		const d = minOver(dist(S, pos, mode, base), tiles);
		let best = lbOfSteps(d);
		const dv = deathVia(S, pos, mode, base);
		if (dv) {
			const r = minOver(dv.dr, tiles);
			if (r < INF) best = Math.min(best, lbOfSteps(dv.dk) + DEAD_TICKS + lbOfSteps(r));
		}
		return best + extra;
	}
	/** the same as pairLb and whether the best way is a death (for the planner's death steps) */
	function pairInfo(S, pos, tiles, mode = 'est', base = null) {
		const extra = pos.extra || 0;
		const d = minOver(dist(S, pos, mode, base), tiles);
		let lb = lbOfSteps(d), steps = d, viaDeath = false;
		const dv = deathVia(S, pos, mode, base);
		if (dv) {
			const r = minOver(dv.dr, tiles);
			if (r < INF) {
				const l2 = lbOfSteps(dv.dk) + DEAD_TICKS + lbOfSteps(r);
				if (d >= INF) { lb = l2; steps = dv.dk + r; viaDeath = true; }
				else lb = Math.min(lb, l2);
			}
		}
		return { lb: lb + extra, steps, viaDeath, extra };
	}
	// ---------------------------------------------------------------- regions (the contract's regionOf)
	const regionMemo = new Map();
	function regionLabels(S) {
		const key = S.dkey;
		const had = regionMemo.get(key);
		if (had) return had;
		const m = passMask(S, 'walk', null);
		const par = new Int32Array(N);
		for (let i = 0; i < N; i++) par[i] = i;
		const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
		const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a < b ? b : a] = a < b ? a : b; };
		for (let t = 0; t < N; t++) {
			if (!m[t]) continue;
			for (let d = 0; d < 8; d++) { const j = moveOK(m, t, d); if (j >= 0) uni(t, j); }
			if (portalIn[t]) for (const e of portalExits.get(t)) if (m[e]) uni(t, e);
		}
		const lab = new Int32Array(N).fill(-1);
		for (let i = 0; i < N; i++) if (m[i]) lab[i] = find(i);
		regionMemo.set(key, lab);
		if (regionMemo.size > 32) regionMemo.delete(regionMemo.keys().next().value);
		return lab;
	}
	/** regionOf(S, tile) -> the walk component id under S (-1: a wall / shut gate) */
	function regionOf(S, tile) { return regionLabels(S)[tile]; }
	// ---------------------------------------------------------------- RCH3 (the contract's reachable)
	let hasCp = false;
	for (let i = 0; i < N && !hasCp; i++) if (fg[i] === CHECKPOINT) hasCp = true;
	const deathsField = canDie && (respawn.length > 1 || hasCp);
	/** reachable(S, fromTile | sim | tiles[], tiles) -> {cost (tiles, -1: a proof), proof} */
	function reachable(S, from, tiles, ro = {}) {
		const f = T.goalField(levelOf(S), tiles, { deaths: deathsField });
		let cost;
		if (from && typeof from === 'object' && !Array.isArray(from) && from.px !== undefined) cost = RF.costAt(f, from);
		else {
			const list = Array.isArray(from) ? from : [from];
			cost = -1;
			// (at rest; ro.rising: rising at the most too, the most any state in the tile reaches upward)
			for (const t of list) {
				for (const vy of ro.rising ? [0, -16] : [0]) {
					const c = RF.costAt(f, (t % W) * 16, ((t / W) | 0) * 16, vy);
					if (c >= 0 && (cost < 0 || c < cost)) cost = c;
				}
			}
		}
		return { cost, proof: cost === -1 };
	}
	const model = {
		L, W, H, N, A, feats, init, triggers, gates, stateOf, levelOf, regionOf, reachable,
		// (the planner's machinery)
		file: o.file || null, S0, startTile, cpTracked, spawnTiles, respawnOf, idleTiles, trophyTiles, trophies, respawn, canDie, dieTile, deathT, timed, coinTiles, bcoinTiles,
		setEstWalls, trigOf, gateOf, featSet, fIdx, hasCoinGate, touch, liveTiles, gateOpen, passMask, bfs, dist, pairSteps, pairLb, pairInfo, lbOfSteps, deathVia,
		mkState, INF, DEAD_TICKS,
		stats: () => ({ ms: compileMs, distBuilds, distMs, triggers: triggers.length, relevant: triggers.filter((X) => X.relevant).length, gates: gates.length, feats: feats.length, coins: coinTiles.length, bcoins: bcoinTiles.length }),
	};
	const compileMs = Date.now() - t0;
	return model;
}
function testGate(k, pol, param, v) {
	let on;
	if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'prot' || k === 'crown') on = v === 1;
	else if (k === 'team') on = v === param;
	else if (k === 'coins' || k === 'bcoins') on = v >= param;
	else if (k === 'deaths') on = v >= param;
	else on = true;
	return pol === 1 ? on : !on;
}

module.exports = { compileModel, lbOfSteps, testGate, DEAD_TICKS, V_TICK, INF, KEY_BITS };
