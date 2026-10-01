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
// modes: 'lb' (the lower bound's relaxation: killers passable, coin gates shut only where the anchor's REAL count already
// shuts them, keys sticky), 'est' (the model's own counts, killers walls unless protected, the planner's CEGAR walls:
// setEstWalls) and 'walk' (the contract's regions: the gates exact, killers passable). The bound is sound between two
// consecutive relevant events of any real route: the relevant features do not change there, so every gate the model
// shuts is shut for the real ball (a change the engine defers while the ball overlaps the gate it shuts: the planner's
// deferral regions). Also: pendingOf(sim, S) (the state after the changes still in the engine's queues), respawnOf(S,
// mode) (the checkpoint the state holds, else the spawns; lb without tracked checkpoints: every respawn tile), the
// checkpoint in S wherever a death can move the ball (tracked, i.e. its touches are edges, up to 255 checkpoints).
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
// (the est walk's diagonal between two killers: moveOK; OPT-IN EEAT_KILL_SQUEEZE=1: the penalty first plans of OCTOS
// ROLLERCOASTER / TTL Spike Edition / Desolate Helix go (est 1,006,600 -> 2,324, 1,017,292 -> 17,172, 1,003,068 ->
// 2,494), but no compile gain at 60 s and I Wanna be the Guy 11 / 1 / 1 / 11 triggers -> 1 in 6 of 6 runs (its spike
// checkerboards: chains of squeezes the est walk passes and a ball does not), OCTO'S FUN CASTLE 2 -> 0 in 2 of 2)
const KILL_SQUEEZE = process.env.EEAT_KILL_SQUEEZE === '1';
// THE BOOST'S WAY (C6 push 3 lane 3 block 2; OPT-IN EEAT_EST_BOOSTDIR=1, off = the model byte for byte): the engine sets the
// speed to 16 px/tick along a boost (114 left, 115 right, 116 up, 117 down) every tick the ball's centre is in it, so a
// ball never leaves a boost tile against its push: the est walk (the planner's order, never the lb) did, and Daybreak's
// purple switch 44 (293,218) was '1 tile' from its right boost (294,218): the wrong side (the way in is from the left,
// through switch 45's door). With the knob the est / estNW walks (bfs) take no step out of a boost tile with a component
// against its push; the lb, the proofs and the regions ('walk') are untouched.
const EST_BOOSTDIR = process.env.EEAT_EST_BOOSTDIR === '1';
// A PROTECTED BALL CANNOT DIE (n5 doctor 2): the engine kills on a killer tile only `!is_invulnerable` (eesim.js
// gFlags & 4), lava and the curse / zombie / poison effects set nothing on an invulnerable ball, and turning protection on
// clears the running ones (Me.as:300-315), so under S.feats.prot === 1 no death exists until a protection-off effect or an
// effect reset (the model's 'prot' / 'reset' touches) turns it off. The death shortcut (deathVia) ignored it: Animaly's plan
// "protection on (36,42) -> ... -> team 3 -> die, back at a respawn (deaths 3)" spent every rung of the final compiles on a
// death the engine never gives (closest 0-3 tiles at the killers, 'budget' rung after rung, 25 anchors at 180 s). With it,
// a death step / a death as a teleport is offered only in a state that can die (lb: still admissible: only an impossible
// way is dropped). EEAT_PROT_NODIE=0: as before.
const PROT_NODIE = process.env.EEAT_PROT_NODIE !== '0';
// THE EST DEATH ON A TIMED-KILLER LEVEL (n5 doctor 2): dieTile marks EVERY tile of a level with a curse / zombie / poison /
// lava (a running timer kills anywhere: the lb's sound source), so the est death shortcut cost 0 walk steps from anywhere
// and a death was a 54-tick teleport to the respawn in the plans' est: Animaly's plans were full of "die, back at a
// respawn" steps (its known route has none: the team rooms' portals), every one a leg the executor could not do cheaply
// (a death needs a killer or a pickup and its timer: closest 0-12 tiles, 'budget' rung after rung). In the est and walk
// modes the shortcut now goes to a real death source (model dieSrc: a killer, a tile next to one, lava, a timed killer's
// pickup) plus that source's delay (deathVia's dt, ticks: the planner adds it to the death's est); the lb (the proofs)
// unchanged. Only levels with a timed killer change (elsewhere dieTile is the killers and their neighbours = dieSrc).
// EEAT_DIE_EST=0: as before.
const DIE_EST = process.env.EEAT_DIE_EST !== '0';
const PACE_EST = 4;   // ticks a walk step, the planner's first pace (PACE0): the source's rank = its steps x this + its delay
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
	// (THE BOOST'S WAY: per tile the push of its boost, 0 none, 1 left, 2 right, 3 up, 4 down)
	let boostOf = null;
	if (EST_BOOSTDIR) for (let i = 0; i < N; i++) { const id = fg[i]; if (id >= 114 && id <= 117) { if (!boostOf) boostOf = new Uint8Array(N); boostOf[i] = id - 113; } }
	// ---------------------------------------------------------------- features some gate reads
	const featSet = new Set();
	for (const [k, f] of A.feats) if (f.gates > 0 && k !== 'fx') featSet.add(k);
	let deathT = 0;
	for (let i = 0; i < N; i++) if (DEATH_DOORS.has(fg[i])) deathT = Math.max(deathT, lk[i]);
	if (deathT > 0) featSet.add('deaths');
	// THE CRUMBS (doctor 9, n5): coins no gate reads are the designer's breadcrumbs: every known route of a level whose
	// only relevant trigger is the trophy (or a far key) passes them (On And On And On: 5 coins, legs 383-693 ticks; EX
	// Crew Fall of Zeal: 28 coins, legs 54-924), while the whole-level leg they cut is out of the finders' reach (Fall of
	// Zeal's trophy field climbs 212 tiles along its route, 6,174 of its 8,089 ticks above the running min: the skeleton's
	// level-set descent cannot follow it; from the route's own states 4 of 5 of its coin legs and 5 of 5 of On And On's
	// are found at rung 1-2). With the knob the coins are a feature of the state (their count and the tiles taken), so each
	// is a trigger the planner's plans and near plans reach and an arrival at one is progress (gain) the strategy goes on
	// from; no gate reads them, so the lb and the proofs are unchanged. At most CRUMB_MAX coin tiles (a larger taken map
	// costs the plan search more than the relays give). OPT-IN EEAT_CRUMBS=1 (off: the model as before).
	// The crumbs are relevant (a touch changes the state) but marked X.crumb: the planner's plan search leaves them out
	// (its plans are the ones without the knob) and offers the NEAREST crumb as a plan of its own (planner.js crumbPlan).
	const crumbFeats = new Set();
	if (process.env.EEAT_CRUMBS === '1') {
		const CRUMB_MAX = +process.env.EEAT_CRUMB_MAX || 64;
		let nc = 0, nb = 0;
		for (const [, kind] of A.special) { const k = KIND_OF[kind] || kind; if (k === 'coin') nc++; else if (k === 'bcoin') nb++; }
		if (nc > 0 && nc <= CRUMB_MAX && !featSet.has('coins')) { featSet.add('coins'); crumbFeats.add('coins'); }
		if (nb > 0 && nb <= CRUMB_MAX && !featSet.has('bcoins')) { featSet.add('bcoins'); crumbFeats.add('bcoins'); }
	}
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
		triggers.push({ id, kind, tiles, feat, param, label: labelOf(kind, param, x0, y0) + (tiles.length > 1 ? ` x${tiles.length}` : ''), relevant, coins: null, crumb: !!(feat && crumbFeats.has(feat)) });
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
	// the tiles a death STARTS from (a death step's ordering field, the executor's: planner.js stepsOf): a killer, a tile
	// next to one (the half block's current-tile redirect), lava, a timed killer's effect tile (its pickup). dieTile marks
	// EVERY tile on a level with a timed killer (a death can come anywhere there, the lb's sound source), so as an ORDERING
	// field it orders nothing: the executor's die legs sat at the respawn = the leg's start, closest 0, rung after rung
	// (Helix Reborn, Evolution Revolution, Tutorial 2); the sources here are where the ball goes to die
	const dieSrc = [];
	if (canDie) {
		for (let i = 0; i < N; i++) {
			if (A.cls[i] === 0) continue;
			const id = fg[i];
			let src = A.cls[i] === 1 || id === LAVA || ((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0);
			if (!src) {
				const x = i % W, y = (i / W) | 0;
				for (let d = 0; d < 8 && !src; d++) { const nx = x + DX8[d], ny = y + DY8[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && A.cls[ny * W + nx] === 1) src = true; }
			}
			if (src) dieSrc.push(i);
		}
	}
	// (each death source's delay, ticks from its touch to the death: 0 at a killer, lava's fire (effectDuration(2) + 1),
	// a curse / zombie / poison's own timer ((v + 2 x ping) x 100 + 1): the est death shortcut's cost, deathVia)
	const dieDelay = new Int32Array(dieSrc.length);
	for (let k = 0; k < dieSrc.length; k++) {
		const i = dieSrc[k], id = fg[i];
		dieDelay[k] = A.cls[i] === 1 ? 0 : id === LAVA ? 241 : ((id === CURSE || id === ZOMBIE || id === POISON) && lk[i] > 0) ? Math.floor((lk[i] + 0.4) * 100) + 1 : 0;
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
	// (the feature values as an object of one fixed shape: a constructor made for this level's features)
	// eslint-disable-next-line no-new-func
	const FeatObj = new Function('v', feats.map((f, n) => `this[${JSON.stringify(f)}] = v[${n}];`).join('\n'));
	let initV = null;
	// (the pass key: the feature values with each count as the number of its gates' thresholds it meets: every gate's
	// state, so the geometry's memo (the pass masks, the walks, the level copies) is shared between counts of one class)
	const countTh = feats.map((fk) => {
		if (fk !== 'coins' && fk !== 'bcoins' && fk !== 'deaths') return null;
		const set = new Set();
		for (const g of gates) if (g.feat === fk) set.add(g.param);
		return [...set].sort((x, y) => x - y);
	});
	const deathIdx = process.env.EEAT_GAIN_DEATHS === '1' ? -1 : (fIdx.has('deaths') ? fIdx.get('deaths') : -1);
	function mkState(vals, taken, btaken, cp = -1) {
		const dkey = vals.join(',');
		let pkey = dkey;
		for (let n = 0; n < countTh.length; n++) if (countTh[n]) { pkey = vals.map((v, i) => { const th = countTh[i]; if (!th) return v; let c = 0; for (const t of th) if (v >= t) c++; return 'c' + c; }).join(','); break; }
		const key = dkey + (taken ? '|' + hashBytes(taken) : '') + (btaken ? '|' + hashBytes(btaken) : '') + (canDie ? '|c' + cp : '');
		let gain = 0;
		// (a death is a cost, not progress: the count opens a door, and the trigger reached past it is the gain; counted, a
		// death step's arrival outranked the anchors it came from and the strategy stayed on it: The Ten Commandments lost its
		// 666-tick trophy leg to the anchor after a death, box 3, 2 of 2 runs)
		if (initV) for (let n = 0; n < vals.length; n++) if (n !== deathIdx && vals[n] !== initV[n]) gain++;
		if (taken) for (let k = 0; k < taken.length; k++) gain += taken[k];
		if (btaken) for (let k = 0; k < btaken.length; k++) gain += btaken[k];
		return { key, dkey, pkey, feats: new FeatObj(vals), vals, taken, btaken, gain, cp };
	}
	// (the features' getters, each key parsed once: T.featValue parsed it on every read)
	const getF = feats.map((f) => T.featGetter(f));
	const deathI = feats.indexOf('deaths');
	function stateOf(sim) {
		const vals = getF.map((g) => g(sim));
		if (deathI >= 0) vals[deathI] = Math.min(vals[deathI], deathT);
		let taken = null, btaken = null;
		if (coinTiles.length) { taken = new Uint8Array(coinTiles.length); coinTiles.forEach((t, k) => { taken[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }); }
		if (bcoinTiles.length) { btaken = new Uint8Array(bcoinTiles.length); bcoinTiles.forEach((t, k) => { btaken[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; }); }
		const cp = canDie && sim.checkpoint.x >= 0 ? trigOf[sim.checkpoint.y * W + sim.checkpoint.x] : -1;
		const S = mkState(vals, taken, btaken, cp);
		// (the engine's own copies the gates read, not part of any key: the coin / blue coin / death GATES read
		// _show_*, >= 1 tick late and frozen while the ball overlaps one; the time doors' phase; zombie. The lb and the
		// 'now' mode read them; abstract states (touch) have none)
		S.show = { coins: sim._show_coin_gate | 0, bcoins: sim._show_blue_coin_gate | 0, deaths: sim._show_death_gate | 0 };
		S.td = !!sim._timedoor_state;
		S.zombie = !!sim.is_zombie;
		return S;
	}
	/** stateOf(sim).key alone (the same string: the values joined, the taken coins' hashes, the checkpoint), without
	 * the state object (the primitives' class key of every child) */
	function keyOf(sim) {
		let key = '';
		for (let n = 0; n < getF.length; n++) { let v = getF[n](sim); if (n === deathI) v = Math.min(v, deathT); key += (n > 0 ? ',' : '') + v; }
		if (coinTiles.length) { const taken = new Uint8Array(coinTiles.length); for (let k = 0; k < coinTiles.length; k++) { const t = coinTiles[k]; taken[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; } key += '|' + hashBytes(taken); }
		if (bcoinTiles.length) { const bt = new Uint8Array(bcoinTiles.length); for (let k = 0; k < bcoinTiles.length; k++) { const t = bcoinTiles[k]; bt[k] = sim.is_coin_collected(t % W, (t / W) | 0) ? 1 : 0; } key += '|' + hashBytes(bt); }
		if (canDie) key += '|c' + (sim.checkpoint.x >= 0 ? trigOf[sim.checkpoint.y * W + sim.checkpoint.x] : -1);
		return key;
	}
	const init = {};
	for (const f of feats) init[f] = f === 'deaths' ? Math.min(T.featValue(sim0, f), deathT) : T.featValue(sim0, f);
	initV = feats.map((f) => init[f]);
	const S0 = stateOf(sim0);
	// ---------------------------------------------------------------- FORCED CHAINS (a state trick, n5-tricks 3)
	// A boost (114-117) sets the speed to 16 px/tick along its direction; a straight lane of trigger tiles right after it,
	// walled so the ball cannot leave it sideways, is passed tile by tile (the centre moves < 16 px a tick: no tile
	// skipped, a touch on every cell change), so its triggers are touched ALL, IN ORDER, with no choice between them (First
	// Person Maze: 79 such lanes of purple switches, the known route falls one twice; Fizio1 21, Daybreak 5, The Glitch 2,
	// DEEPER 1, Switch Labyrinth 2: 12 of 228 levels). The planner's one-trigger edges cannot say that: a leg to one switch
	// in the lane from the ball mid-lane EXHAUSTS (the compile's 'purple switch 27 exhausted 2 tiles'). A chain is one
	// planner trigger (kind 'chain', model.chains, not in triggers / trigOf): its touch = its members' touches in order,
	// its waypoint the lane's last relevant tile with that feature's value after the whole chain. Every chain is checked
	// by the ENGINE: the ball put on the boost at 16 px/tick with no input must visit exactly the lane's tiles in order and
	// end in the abstract state the members' touches give from S0 (stateOf); else it is no chain. Lanes of coins / crowns
	// / trophies are cut there (a coin component's touch takes all its coins). OPT-IN EEAT_TRICKS chain / 1 / all.
	const chains = [];
	{
		if (require('./tricks.js').has('chain')) {
			const BD = { 114: [-1, 0], 115: [1, 0], 116: [0, -1], 117: [0, 1] };
			const PER_TILE = new Set(['psw', 'osw', 'pswR', 'oswR', 'key', 'team', 'prot', 'reset', 'fx', 'cp']);
			const inW = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
			for (let i = 0; i < N && chains.length < 4096; i++) {
				const d = BD[fg[i]];
				if (!d) continue;
				let x = (i % W) + d[0], y = ((i / W) | 0) + d[1];
				const lane = [];
				while (inW(x, y)) {
					const j = y * W + x, id = trigOf[j];
					if (id < 0 || !PER_TILE.has(triggers[id].kind)) break;
					lane.push(j); x += d[0]; y += d[1];
				}
				const rel = lane.filter((j) => triggers[trigOf[j]].relevant);
				if (lane.length < 3 || rel.length < 2) continue;
				// the engine check
				let ok = false;
				try {
					const sim = new E.EESim(L), inp = new E.EEInput();
					sim.reset(); E.applyMask(inp, 0);
					const Sb = stateOf(sim);
					sim.px = (i % W) * 16; sim.py = ((i / W) | 0) * 16; sim.prev_px = sim.px; sim.prev_py = sim.py;
					sim.speed_x = d[0] * 16; sim.speed_y = d[1] * 16;
					const seen = [];
					let last = i;
					for (let k = 0; k < lane.length * 3 + 12; k++) {
						sim.tick(inp);
						if (sim.is_dead) break;
						const t = T.tileOf(sim, W, H);
						if (t === last) continue;
						last = t;
						if (lane.includes(t)) seen.push(t); else break;
					}
					let Sx = Sb;
					for (const j of lane) { const r = touch0(Sx, triggers[trigOf[j]]); if (r.changed) Sx = r.S2; }
					const Sa = stateOf(sim);
					ok = seen.length === lane.length && seen.every((t, k) => t === lane[k]) && Sa.key === Sx.key && Sx.key !== Sb.key;
				} catch (e) { ok = false; }
				if (!ok) continue;
				const last = rel[rel.length - 1], lx = last % W, ly = (last / W) | 0;
				chains.push({ id: 1000000 + chains.length, kind: 'chain', tiles: [last], members: lane.map((j) => trigOf[j]), lastTrig: trigOf[last], feat: triggers[trigOf[last]].feat, param: 0,
					relevant: true, coins: null, boost: i, label: `forced chain of ${lane.length} (${(i % W) + d[0]},${((i / W) | 0) + d[1]})-(${lx},${ly})` });
			}
		}
	}
	// ---------------------------------------------------------------- the abstract touch
	/**
	 * touch(S, X) -> {S2, changed, expect}: the state after touching trigger X (S2 === S when nothing relevant changes).
	 * expect: the waypoint's Expect (the feature and its value right after the first effect of the touch; coins: +1).
	 */
	// (the touches that change the state, memoized by (S.key, X.id): S2 is a function of S's key (its values, its taken
	// coins, its checkpoint) and X; the planner's re-plans touch the same states' triggers again (every trigger of every
	// expansion: mkState's key strings and coin hashes were 18 of The Glitch's 60 s in the main thread, the workers
	// waiting). The same S2 object for one key (the model's states are never written after mkState). EEAT_TOUCH_MEMO=0: none)
	const TOUCH_ON = process.env.EEAT_TOUCH_MEMO !== '0', TOUCH_MAX = 200000;
	const touchMemo = new Map();
	function touch(S, X) {
		if (!TOUCH_ON || S.show) return touch0(S, X);
		const k = S.key + '#' + X.id;
		const had = touchMemo.get(k);
		if (had) return had;
		const r = touch0(S, X);
		if (!r.changed) return r;
		if (touchMemo.size >= TOUCH_MAX) touchMemo.clear();
		touchMemo.set(k, r);
		return r;
	}
	function touch0(S, X) {
		if (X.kind === 'chain') {
			// (a FORCED CHAIN, EEAT_TRICKS chain: its members touched in the lane's order; the expect: the last relevant
			// member's feature as the whole chain leaves it)
			let S2 = S;
			for (const id of X.members) { const r = touch0(S2, triggers[id]); if (r.changed) S2 = r.S2; }
			if (S2 === S) return { S2: S, changed: false, expect: null };
			const f = triggers[X.lastTrig].feat, n = fIdx.get(f);
			return { S2, changed: true, expect: n === undefined ? null : { feat: f, value: S2.vals[n] } };
		}
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
	/** the count a coin / blue coin / death GATE reads: the engine's _show_* copy where the state has it (a concrete
	 *  state), else the count; lb: the least of the anchor's base, the copy and the count (the copy lags the count and
	 *  both only grow: a gate the lb shuts is shut for the rest of the leg) */
	function gateCount(k, S, mode, base) {
		const n = fIdx.get(k);
		let c = n === undefined ? (init[k] || 0) : S.vals[n];
		if (S.show && S.show[k] !== undefined) c = Math.min(c, S.show[k]);
		if (mode === 'lb') { const bv = base && base[k] !== undefined ? base[k] : init[k]; if (bv !== undefined) c = Math.min(c, bv); }
		return c;
	}
	/**
	 * gate tile i open under S? modes (the engine's rules, eesim.js _isOpen):
	 *  'lb'  the relaxation: keys sticky (a key door open once its key was on; key GATES always open: a key expires),
	 *        coin / blue coin / death gates shut only by the least of the anchor's base, the state's _show_* copy and
	 *        its count; death doors, zombie doors / gates and time doors open.
	 *  'est' the planner's walk: key doors open iff the key is on, key GATES shut while it is on (eesim 26-28,
	 *        1008-1010); coin / death doors by the count, their gates by the _show_* copy where the state has one;
	 *        time doors and zombie doors / gates open (the phase and zombie are no feature: waiting / an effect).
	 *  'now' a CONCRETE state's exact reading (stateOf's extras): as est, and 156 open iff the time phase (S.td), 157 the
	 *        reverse, 206 open unless zombie, 207 only while zombie. 50 is a wall (steer.js analyze), never a gate.
	 */
	function gateOpen(i, S, mode, base) {
		const k = A.gateFeat[i], pol = A.gatePol[i], b = fg[i];
		if (k === 'static') return pol === 1;
		if (k === 'time') return mode === 'now' && S.td !== undefined ? (b === 156 ? S.td : !S.td) : true;
		if (k === 'open') {
			if (b === 1011 || b === 1012) {
				if (mode === 'lb' && b === 1011) return true;
				const n = fIdx.get('deaths');
				const d = b === 1012 ? gateCount('deaths', S, mode, base) : n === undefined ? 0 : S.vals[n];
				return b === 1011 ? lk[i] <= d : lk[i] > d;
			}
			if ((b === 206 || b === 207) && mode === 'now' && S.zombie !== undefined) return b === 206 ? !S.zombie : S.zombie;
			return true;
		}
		const n = fIdx.get(k);
		if (n === undefined) return true;
		const v = S.vals[n];
		if (k.startsWith('key')) return mode === 'lb' ? (v === 1 || pol === 0) : testGate(k, pol, A.gateParam[i], v);
		if ((k === 'coins' || k === 'bcoins') && pol === 0) return !(gateCount(k, S, mode, base) >= A.gateParam[i]);
		return testGate(k, pol, A.gateParam[i], v);
	}
	/** the est walk's learned walls (the planner's CEGAR: tiles past which a failed step's closest approach did not get;
	 *  est only: the lb and the proofs never read them) */
	let estWalls = null, estWallVer = 0;
	function setEstWalls(mask) { estWalls = mask; estWallVer++; }
	/** the key of the gate pattern under S (the memo key of the geometry) */
	const hasDeathGate = (() => { for (let i = 0; i < N; i++) if (fg[i] === 1012) return true; return false; })();
	const hasTime = (() => { for (let i = 0; i < N; i++) if (A.gateFeat[i] === 'time') return true; return false; })();
	const hasZombieDoor = (() => { for (let i = 0; i < N; i++) if (fg[i] === 206 || fg[i] === 207) return true; return false; })();
	/** the part of a door key the gates' _show_* copies decide (a concrete state whose copies lag its counts) */
	function showKey(S, mode, base) {
		if (!hasCoinGate.coins && !hasCoinGate.bcoins && !hasDeathGate) return '';
		if (mode === 'lb') return '|' + ['coins', 'bcoins', 'deaths'].map((k) => gateCount(k, S, mode, base)).join(',');
		return S.show ? '|' + S.show.coins + ',' + S.show.bcoins + ',' + S.show.deaths : '';
	}
	function doorKey(S, mode, base) {
		if (mode === 'walk') return (killers ? 'k:' : 'e:') + S.pkey + showKey(S, 'est', base);
		// ('estNW': the est walk without the planner's CEGAR walls (planner.js WALL_PRICE); the key of the unwalled est)
		if (mode === 'estNW') return 'e:' + S.pkey + showKey(S, 'est', base);
		if (mode === 'now') return 'n:' + S.pkey + showKey(S, 'est', base) + (hasTime ? '|t' + (S.td ? 1 : 0) : '') + (hasZombieDoor ? '|z' + (S.zombie ? 1 : 0) : '');
		if (mode !== 'lb') return (estWalls ? 'w' + estWallVer : 'e') + ':' + S.pkey + showKey(S, 'est', base);
		if (!killers && !estWalls && !hasCoinGate.coins && !hasCoinGate.bcoins && !hasDeathGate) return 'e:' + S.pkey;
		// (lb: killers passable; the gates' part is the least of the base, the copy and the count)
		return 'l:' + S.pkey + showKey(S, 'lb', base);
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
		const gm = mode === 'walk' || mode === 'estNW' ? 'est' : mode;   // ('now': est's walls with the exact reading of a concrete state)
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
		const key = S.pkey;
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
			// (KILL_SQUEEZE: a diagonal between two KILLERS is open: a killer is no solid, the 16 x 16 box passes it and
			// only the centre's cell at a tick's start kills (eesim tick: current = the centre cell), so a centre that crosses
			// the corner within one tick never reads either killer (test/planmodel.js: an engine route does it): OCTOS
			// ROLLERCOASTER's way out of its start region, spikes (46,25) and (45,26), where the est walk read a wall and every
			// plan carried the 1e6 penalty. A solid on one side stays shut: the box's sub-steps collide with it)
			const a = y * W + nx, b = ny * W + x;
			if (!m[a] && !m[b] && !(KILL_SQUEEZE && A.cls[a] === 1 && A.cls[b] === 1 && !(estWalls && (estWalls[a] || estWalls[b])))) return -1;
		}
		return j;
	}
	/**
	 * bfs(m, src) -> Int32Array(N) of walk steps from the source tiles (INF: none): 0-1 BFS, a step 1, the step into a
	 * portal tile with exits followed by its hop 0 (the hop lands on each exit), a start on a portal: its exits at 0.
	 */
	/** THE BOOST'S WAY: a step out of a boost tile with a component against its push is no step; a diagonal is the two
	 *  orthogonal legs through its side tiles (x then y, or y then x), at least one open and neither leg against a boost
	 *  it leaves (a diagonal round a solid corner through a boost's side tile was the way back into Daybreak's switch) */
	const againstB = (bc, i, dx, dy) => { const k = bc[i]; return (k === 1 && dx > 0) || (k === 2 && dx < 0) || (k === 3 && dy > 0) || (k === 4 && dy < 0); };
	function boostStepOK(m, bc, t, bt, d) {
		const dx = DX8[d], dy = DY8[d];
		if (dx === 0 || dy === 0) return !(bt && againstB(bc, t, dx, dy));
		const x = t % W, y = (t / W) | 0, nx = x + dx, ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
		const a = y * W + nx, b = ny * W + x;
		if (!bt && !bc[a] && !bc[b]) return true;
		const viaA = m[a] && !againstB(bc, t, dx, 0) && !againstB(bc, a, 0, dy);
		const viaB = m[b] && !againstB(bc, t, 0, dy) && !againstB(bc, b, dx, 0);
		return !!(viaA || viaB);
	}
	function bfs(m, src, bc = null) {
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
				const bt = bc ? bc[t] : 0;
				for (let d = 0; d < 8; d++) {
					if (bc && !boostStepOK(m, bc, t, bt, d)) continue;
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
	/**
	 * hopClosure(m, src) -> the tiles bfs(m, src) starts at 0: the sources (deduplicated) and, chained, the exits (passable
	 * under m) of the portal tiles among them, in bfs's own order
	 */
	function hopClosure(m, src) {
		const out = [], seen = new Set();
		for (const s of src) { if (s < 0 || s >= N || seen.has(s)) continue; seen.add(s); out.push(s); }
		for (let k = 0; k < out.length; k++) { const s = out[k]; if (portalIn[s]) for (const e of portalExits.get(s)) if (m[e] && !seen.has(e)) { seen.add(e); out.push(e); } }
		return out;
	}
	/**
	 * revDist(m, goals) -> Int32Array(N): per tile t the steps bfs(m, [t]) takes to the nearest goal tile, for every tile at
	 * once (INF: none). bfs is a shortest-path search over the graph of its moves (t -> j, 1 step: moveOK) and its hops
	 * (t -> e, 0 steps: a move into a portal tile j with exits, then its exit e, passable under m; a tile reached by a hop
	 * does not hop again); this is the same graph searched backwards from the goals (0-1 BFS), so
	 * min over goals of bfs(m, src)[g] = min over hopClosure(m, src) of revDist(m, goals) exactly: one search for all
	 * sources instead of one per source (the planner's open-level heuristic: a bfs per trigger position, 3,346 of them on
	 * Moving Ice Puzzle's root, 16.7 s of its lowerBound)
	 */
	function revDist(m, goals) {
		// the reverse graph (CSR): r1 = the move edges' tails per head, r0 = the hop edges' tails per exit
		const c1 = new Int32Array(N + 1), c0 = new Int32Array(N + 1);
		for (let t = 0; t < N; t++) for (let d = 0; d < 8; d++) {
			const j = moveOK(m, t, d);
			if (j < 0) continue;
			c1[j + 1]++;
			if (portalIn[j]) for (const e of portalExits.get(j)) if (m[e]) c0[e + 1]++;
		}
		for (let i = 0; i < N; i++) { c1[i + 1] += c1[i]; c0[i + 1] += c0[i]; }
		const a1 = new Int32Array(c1[N]), a0 = new Int32Array(c0[N]), f1 = c1.slice(0, N), f0 = c0.slice(0, N);
		for (let t = 0; t < N; t++) for (let d = 0; d < 8; d++) {
			const j = moveOK(m, t, d);
			if (j < 0) continue;
			a1[f1[j]++] = t;
			if (portalIn[j]) for (const e of portalExits.get(j)) if (m[e]) a0[f0[e]++] = t;
		}
		const R = new Int32Array(N).fill(INF);
		// (0-1 BFS by levels, as bfs: the current level's list grows by the 0 edges, the next level's by the 1 edges)
		let cur = [], nxt = [];
		for (const g of goals) if (g >= 0 && g < N && R[g] !== 0) { R[g] = 0; cur.push(g); }
		let level = 0;
		while (cur.length) {
			nxt = [];
			for (let k = 0; k < cur.length; k++) {
				const v = cur[k];
				if (R[v] !== level) continue;
				for (let q = c0[v]; q < c0[v + 1]; q++) { const t = a0[q]; if (R[t] > level) { R[t] = level; cur.push(t); } }
				for (let q = c1[v]; q < c1[v + 1]; q++) { const t = a1[q]; if (R[t] > level + 1) { R[t] = level + 1; nxt.push(t); } }
			}
			cur = nxt; level++;
		}
		return R;
	}
	const distMemo = new Map();
	const DIST_CAP = Math.max(96, Math.floor(64e6 / (4 * N)));   // (the walks kept: ~64 MB of fields)
	let distBuilds = 0, distMs = 0;
	/** dist(S, pos, mode, base) -> the walk steps from pos.tiles under S (memo: 96 fields, LRU) */
	function dist(S, pos, mode = 'est', base = null) {
		const bcut = boostOf && (mode === 'est' || mode === 'estNW');
		const key = doorKey(S, mode, base) + '#' + pos.id + (bcut ? '#B' : '');
		const had = distMemo.get(key);
		if (had) { distMemo.delete(key); distMemo.set(key, had); return had; }
		const t1 = Date.now();
		let msk = passMask(S, mode, base);
		// (a position's grace gates: shut by the touch that made it, still passable for the ball that overlaps them)
		if (pos.grace && pos.grace.length) { msk = Uint8Array.from(msk); for (const t of pos.grace) msk[t] = 1; }
		// (the lb's sources: a position's deferral region, where a deferred change's event can happen)
		const d = bfs(msk, mode === 'lb' && pos.lbTiles ? pos.lbTiles : pos.tiles, bcut ? boostOf : null);
		distBuilds++; distMs += Date.now() - t1;
		distMemo.set(key, d);
		if (distMemo.size > DIST_CAP) distMemo.delete(distMemo.keys().next().value);
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
		if (PROT_NODIE && S.feats && S.feats.prot === 1) return null;
		const est = DIE_EST && timed && mode !== 'lb' && dieSrc.length > 0;
		const key = (est ? 's' : '') + doorKey(S, mode, base) + '#' + pos.id + (boostOf && (mode === 'est' || mode === 'estNW') ? '#B' : '');
		let m = deathMemo.get(key);
		if (m === undefined) {
			const d = dist(S, pos, mode, base);
			let dk = INF, dt = 0;
			if (est) {
				// (the est / walk modes on a level with a timed killer: the walk to a real death source and its delay, the
				// source by walk steps x PACE_EST + delay; dieTile is every tile there, the lb's sound source)
				let best = Infinity;
				for (let k = 0; k < dieSrc.length; k++) {
					const di = d[dieSrc[k]];
					if (di >= INF) continue;
					const c = di * PACE_EST + dieDelay[k];
					if (c < best) { best = c; dk = di; dt = dieDelay[k]; }
				}
			} else for (let i = 0; i < N; i++) if (dieTile[i] && d[i] < dk) { dk = d[i]; if (dk === 0) break; }
			m = { dk, dt };
			deathMemo.set(key, m);
			if (deathMemo.size > 4096) deathMemo.delete(deathMemo.keys().next().value);
		}
		if (m.dk >= INF) return null;
		return { dk: m.dk, dt: m.dt, dr: dist(S, respawnOf(S, mode), mode, base) };
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
		const key = S.pkey;
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
	/** pendingOf(sim, S) -> the state after the changes the engine still holds in its queues (a purple press waiting
	 *  while the ball overlaps the door it shuts, an orange press / crown / key in the frame queues, a team change
	 *  retried), null when none */
	function pendingOf(sim, S) {
		const tq = sim._tileQueue || [], sq = sim._stateQueue || [], kq = sim._keysQueue || [];
		const teamP = sim._team_tx !== undefined && sim._team_tx !== -1;
		if (!tq.length && !sq.length && !kq.length && !teamP) return null;
		const vals = S.vals.slice();
		const setF = (fk, v) => { const n = fIdx.get(fk); if (n !== undefined) vals[n] = v; };
		for (let i = 0; i + 1 < tq.length; i += 2) {
			const sid = tq[i], en = tq[i + 1] ? 1 : 0;
			if (sid === 1000) { for (const fk of feats) if (fk.startsWith('psw:')) setF(fk, en); } else setF('psw:' + sid, en);
		}
		for (let i = 0; i + 2 < sq.length; i += 3) {
			const kind = sq[i], a = sq[i + 1], b = sq[i + 2];
			if (kind === 0) setF('crown', a ? 1 : 0);
			else if (kind === 2) { if (a === 1000) { for (const fk of feats) if (fk.startsWith('osw:')) setF(fk, b ? 1 : 0); } else setF('osw:' + a, b ? 1 : 0); }
		}
		for (let i = 0; i + 1 < kq.length; i += 2) setF('key' + kq[i], kq[i + 1] ? 1 : 0);
		if (teamP && typeof sim._lookupAt === 'function') setF('team', sim._lookupAt(sim._team_tx, sim._team_ty));
		return mkState(vals, S.taken, S.btaken, S.cp);
	}
	const model = {
		L, W, H, N, A, feats, init, triggers, gates, stateOf, keyOf, levelOf, regionOf, reachable,
		// (the planner's machinery)
		file: o.file || null, S0, startTile, chains, cpTracked, spawnTiles, respawnOf, idleTiles, trophyTiles, trophies, respawn, canDie, dieTile, dieSrc, deathT, timed, coinTiles, bcoinTiles,
		pendingOf, setEstWalls, trigOf, gateOf, featSet, fIdx, hasCoinGate, touch, liveTiles, gateOpen, passMask, bfs, hopClosure, revDist, dist, pairSteps, pairLb, pairInfo, lbOfSteps, deathVia,
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
