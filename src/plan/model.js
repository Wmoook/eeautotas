'use strict';
// THE LEVEL MODEL (n4plan, part 'planner'): the .eelvl compiled into what a plan needs: the TRIGGERS (every tile that
// changes a door's state: keys, purple / orange switches and their resets, team and protection blocks, coins and blue
// coins (each tile its own trigger: they count distinctly), crowns, checkpoints, the static effects), the doors / gates
// each feature opens, the sparse abstract STATE S (the values of the features a gate reads, the coins taken, the last
// checkpoint, the death count) and the REGION of a state: a gravity-blind Dijkstra walk from an entry tile under S's doors
// that stops at every trigger whose touch would change S (those are the plan's edges). The walk is OPTIMISTIC (a ball
// cannot fly); the physics comes from the RCH3 goal fields (types.goalField) on the level copy of S's doors
// (levelOfState), evaluated lazily by the planner for the edges it is about to return.
//
// compileModel(L, opts) -> Model {L, A, W, H, N, triggers, feats, relevantFeats, gatesByFeat, trophies, startTile,
//   respawns, stateOf, apply, expire, doorKey, region, levelOfState, edgeCost, anchorCost, describe, trigLabel, ...}
// Built on steer.js analyze() (the static classes, the gates' features, the special tiles, portals, one-ways); death doors
// (1011: open when lookup <= deaths) and death gates (1012: open while lookup > deaths) and the checkpoints (360) are read
// here from L.fg / L.lookup0. Nothing here prunes a search: the executor verifies every step with the engine.
const E = require('../eesim.js');
const RF = require('../reach.js');
const SF = require('../steer.js');
const T = require('./types.js');

const TROPHY = 121, CHECKPOINT = 360, DEATH_DOOR = 1011, DEATH_GATE = 1012;
const TIME_WAIT = SF.TIME_WAIT || 250;
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const CUT = RF.CUT;
const COLORS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];
const owBlocked = (ow, dx, dy) => (ow === 1 ? dy === 1 : ow === 3 ? dy === -1 : ow === 2 ? dx === -1 : ow === 0 ? dx === 1 : false);
/** steer.js testGate (not exported): a gate of feature k, polarity pol (1: open when on / satisfied), lookup param, under value v */
function testGate(k, pol, param, v) {
	let on;
	if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'prot' || k === 'crown') on = v === 1;
	else if (k === 'team') on = v === param;
	else if (k === 'coins' || k === 'bcoins') on = v >= param;
	else on = false;
	return pol === 1 ? on : !on;
}

/** an abstract state: values of the tracked features (a, in model.featList order), the coins taken (bitset cb), the
 *  last checkpoint, the death count (real; capped in the key), the next spawn, the effects bit. key: canonical string. */
class PState {
	constructor(M, a, cb, cp, deaths, sp, fx) {
		this.a = a; this.cb = cb; this.cp = cp; this.deaths = deaths; this.sp = sp; this.fx = fx;
		const dc = Math.min(deaths, M.deathCap);
		let c = '';
		for (let i = 0; i < cb.length; i++) c += (cb[i] >>> 0).toString(36) + '.';
		// (the counts capped at the highest threshold: more coins open nothing more)
		let av = '';
		for (let i = 0; i < a.length; i++) av += (i ? ',' : '') + (M.capOf[i] >= 0 ? Math.min(a[i], M.capOf[i]) : a[i]);
		this.wkey = `${av}|${c}|${dc}`;
		this.keyNoCoin = `${av}|${dc}|${cp}|${sp}|${fx}`;
		this.key = `${av}|${c}|${dc}|${cp}|${sp}|${fx}`;
		// (the model and the memos: not enumerable, so a step's JSON stays small)
		Object.defineProperty(this, '_M', { value: M, enumerable: false });
		Object.defineProperty(this, '_door', { value: null, enumerable: false, writable: true });
		Object.defineProperty(this, '_open', { value: null, enumerable: false, writable: true });
	}
	/** the values of the tracked features as a Map (the contract's S.v) */
	get v() { const m = new Map(); this._M.featList.forEach((k, i) => m.set(k, this.a[i])); return m; }
	/** the taken coins as a Set of trigger ids (the contract's S.coinsSet) */
	get coinsSet() { const s = new Set(); const M = this._M; for (let b = 0; b < M.coinTrig.length; b++) if ((this.cb[b >> 5] >>> (b & 31)) & 1) s.add(M.coinTrig[b]); return s; }
}

function compileModel(L, opts = {}) {
	const t0 = Date.now();
	const A = SF.analyze(L, {});
	const { W, H, N, cls } = A;
	const fg = L.fg, lk = L.lookup0;
	const hasTime = !!A.hasTime;
	// ---------------------------------------------------------------- the gates: one type per (feature, polarity, lookup)
	// kinds: 0 a feature's gate, 1 static open, 2 static shut, 3 always passable (time doors: + a wait; zombie), 4 a death
	// door (open when lookup <= deaths), 5 a death gate (open while lookup > deaths)
	const gtype = new Int32Array(N).fill(-1);
	const gtypes = [];   // {kind, feat, pol, param, n}
	const gIndex = new Map();
	let deathCap = 0, deathDoors = 0;
	for (let i = 0; i < N; i++) {
		if (cls[i] !== 3) continue;
		let kind, feat = null, pol = A.gatePol[i], param = A.gateParam[i];
		const gf = A.gateFeat[i];
		if (fg[i] === DEATH_DOOR) { kind = 4; param = lk[i]; }
		else if (fg[i] === DEATH_GATE) { kind = 5; param = lk[i]; }
		else if (gf === 'open' || gf === 'time') kind = 3;
		else if (gf === 'static') kind = pol === 1 ? 1 : 2;
		else {
			const f = A.feats.get(gf);
			if (!f || f.static) {
				// (a feature nobody changes: its gates stand as at the start)
				const v = f ? f.values[f.init] : 0;
				kind = testGate(gf, pol, param, v) ? 1 : 2;
			} else { kind = 0; feat = gf; }
		}
		if (kind === 4 || kind === 5) { deathDoors++; deathCap = Math.max(deathCap, param); }
		const key = `${kind}|${feat}|${pol}|${kind === 0 || kind >= 4 ? param : 0}`;
		let g = gIndex.get(key);
		if (g === undefined) { g = gtypes.length; gIndex.set(key, g); gtypes.push({ kind, feat, pol, param, n: 0 }); }
		gtypes[g].n++;
		gtype[i] = g;
	}
	// ---------------------------------------------------------------- the tracked features
	const relevantFeats = [];
	for (const [k, f] of A.feats) if (f.gates > 0 && !f.static && k !== 'fx') relevantFeats.push(k);
	relevantFeats.sort();
	let killers = 0;
	for (let i = 0; i < N; i++) if (cls[i] === 1) killers++;
	let nCp = 0;
	for (let i = 0; i < N; i++) if (fg[i] === CHECKPOINT && cls[i] === 2) nCp++;
	const spawns = [];
	for (let k = 0; k < L.spawnsX.length; k++) spawns.push(L.spawnsY[k] * W + L.spawnsX[k]);
	let fxTiles = 0;
	for (const [, kind] of A.special) if (kind === 'fx') fxTiles++;
	const dieOK = killers > 0 && (nCp > 0 || spawns.length >= 2 || deathDoors > 0);
	const cpTracked = dieOK && nCp > 0;
	const spTracked = dieOK && spawns.length >= 2;
	const fxTracked = fxTiles > 0;
	const featList = relevantFeats.slice();
	const featIdx = new Map(featList.map((k, i) => [k, i]));
	const pswIdx = [], oswIdx = [];
	featList.forEach((k, i) => { if (k.startsWith('psw:')) pswIdx.push(i); else if (k.startsWith('osw:')) oswIdx.push(i); });
	// the thresholds: coins / blue coins count up to the highest door (more opens nothing more)
	const capOf = new Int32Array(featList.length).fill(-1);
	for (const g of gtypes) if (g.kind === 0 && (g.feat === 'coins' || g.feat === 'bcoins')) { const i = featIdx.get(g.feat); capOf[i] = Math.max(capOf[i], g.param); }
	const gatesByFeat = new Map();
	for (let i = 0; i < N; i++) {
		const g = gtype[i];
		if (g < 0) continue;
		const ty = gtypes[g];
		const k = ty.kind === 0 ? ty.feat : ty.kind === 4 || ty.kind === 5 ? 'deaths' : null;
		if (!k) continue;
		if (!gatesByFeat.has(k)) gatesByFeat.set(k, []);
		gatesByFeat.get(k).push(i);
	}
	if (featIdx.has('prot')) { const ks = []; for (let i = 0; i < N; i++) if (cls[i] === 1) ks.push(i); gatesByFeat.set('prot', ks); }

	// ---------------------------------------------------------------- the triggers
	// (components of 4-connected tiles of one kind and param; coins, blue coins and checkpoints one tile each)
	const trigAt = new Int32Array(N).fill(-1);
	const spKind = new Map();   // tile -> [kind, param]
	for (const [t, kind, p] of A.special) spKind.set(t, [kind, p]);
	for (let i = 0; i < N; i++) if (fg[i] === CHECKPOINT && cls[i] === 2) spKind.set(i, ['cp', i]);
	const triggers = [];
	const featsOfKind = (kind, p) => {
		switch (kind) {
			case 'key': return ['key' + p];
			case 'psw': return ['psw:' + p];
			case 'osw': return ['osw:' + p];
			case 'pswR': return p === 1000 ? featList.filter((k) => k.startsWith('psw:')) : ['psw:' + p];
			case 'oswR': return p === 1000 ? featList.filter((k) => k.startsWith('osw:')) : ['osw:' + p];
			case 'reset': return ['prot', 'fx'];
			case 'cp': return ['cp'];
			default: return [kind];
		}
	};
	const single = (kind) => kind === 'coins' || kind === 'bcoins' || kind === 'cp';
	const tilesSorted = [...spKind.keys()].sort((a, b) => a - b);
	for (const t of tilesSorted) {
		if (trigAt[t] >= 0) continue;
		const [kind, p] = spKind.get(t);
		const id = triggers.length;
		const tiles = [t];
		trigAt[t] = id;
		if (!single(kind)) {
			for (let q = 0; q < tiles.length; q++) {
				const u = tiles[q], x = u % W, y = (u / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const x2 = x + dx, y2 = y + dy;
					if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
					const u2 = y2 * W + x2;
					if (trigAt[u2] >= 0) continue;
					const s2 = spKind.get(u2);
					if (s2 && s2[0] === kind && s2[1] === p) { trigAt[u2] = id; tiles.push(u2); }
				}
			}
		}
		tiles.sort((a, b) => a - b);
		const feats = featsOfKind(kind, p);
		let relevant;
		if (kind === 'cp') relevant = deathDoors > 0;
		else if (kind === 'fx') relevant = false;
		else if (kind === 'reset') relevant = featIdx.has('prot');
		else relevant = feats.some((k) => featIdx.has(k));
		triggers.push({ id, kind, tiles, param: p, feats, relevant, stop: relevant && kind !== 'cp', coinBit: -1, fi: kind === 'key' || kind === 'psw' || kind === 'osw' || kind === 'team' || kind === 'prot' || kind === 'crown' || kind === 'coins' || kind === 'bcoins' ? (featIdx.has(feats[0]) ? featIdx.get(feats[0]) : -1) : -1 });
	}
	// coin bits: the gold / blue coins of a tracked count
	const coinTrig = [];
	for (const tr of triggers) if ((tr.kind === 'coins' || tr.kind === 'bcoins') && tr.fi >= 0) { tr.coinBit = coinTrig.length; coinTrig.push(tr.id); }
	const CBW = Math.max(1, (coinTrig.length + 31) >> 5);
	const trophies = A.trophies.slice();
	const isTrophy = new Uint8Array(N);
	for (const t of trophies) isTrophy[t] = 1;

	const M = {
		L, A, W, H, N, opts, triggers, trigAt, feats: A.feats, relevantFeats, featList, featIdx, capOf, gatesByFeat, gtype, gtypes,
		trophies, startTile: A.start.t, respawns: spawns, checkpoints: nCp, killers, deathCap, deathDoors, dieOK, cpTracked, spTracked, fxTracked,
		coinTrig, hasTime, isTrophy,
	};

	// ---------------------------------------------------------------- states
	const mk = (a, cb, cp, deaths, sp, fx) => new PState(M, a, cb, cp, deaths, sp, fx);
	/** S of a real state (types featValue; the coins by the engine's collected flags) */
	function stateOf(sim) {
		const a = new Int32Array(featList.length);
		featList.forEach((k, i) => { a[i] = T.featValue(sim, k); });
		const cb = new Uint32Array(CBW);
		for (let b = 0; b < coinTrig.length; b++) { const t = triggers[coinTrig[b]].tiles[0]; if (sim.is_coin_collected(t % W, (t / W) | 0)) cb[b >> 5] |= 1 << (b & 31); }
		// (the counts as the engine has them: the distinct coins taken)
		return mk(a, cb, cpTracked ? T.featValue(sim, 'cp') : -1, sim.deaths, spTracked ? (sim._next_spawn >= spawns.length ? 0 : sim._next_spawn) : 0, fxTracked ? T.featValue(sim, 'fx') : 0);
	}
	/** the start state (a fresh sim) */
	function startState() { const s = new E.EESim(L); s.reset(); return stateOf(s); }
	/** would touching trigger tr change S (a stop of the walk)? */
	function changes(S, tr) {
		const a = S.a;
		switch (tr.kind) {
			case 'key': case 'crown': return tr.fi >= 0 && a[tr.fi] !== 1;
			case 'psw': case 'osw': return tr.fi >= 0;
			case 'pswR': case 'oswR': {
				const list = tr.kind === 'pswR' ? pswIdx : oswIdx;
				if (tr.param === 1000) { for (const i of list) if (a[i] === 1) return true; return false; }
				const i = featIdx.get(tr.feats[0]);
				return i !== undefined && a[i] === 1;
			}
			case 'team': case 'prot': return tr.fi >= 0 && a[tr.fi] !== tr.param;
			case 'reset': { const i = featIdx.get('prot'); return (i !== undefined && a[i] === 1) || (fxTracked && S.fx === 1); }
			case 'coins': case 'bcoins': return tr.coinBit >= 0 && ((S.cb[tr.coinBit >> 5] >>> (tr.coinBit & 31)) & 1) === 0;
			case 'cp': return cpTracked && S.cp !== tr.tiles[0];
			case 'fx': return fxTracked && S.fx !== tr.param;
		}
		return false;
	}
	/** S after touching trigger id (null: nothing tracked changes) */
	function apply(S, id) {
		const tr = triggers[id];
		if (!tr || !changes(S, tr)) return null;
		let a = S.a, cb = S.cb, cp = S.cp, fx = S.fx;
		const set = (i, v) => { if (a === S.a) a = Int32Array.from(a); a[i] = v; };
		switch (tr.kind) {
			case 'key': case 'crown': set(tr.fi, 1); break;
			case 'psw': case 'osw': set(tr.fi, 1 - a[tr.fi]); break;
			case 'pswR': case 'oswR': {
				const list = tr.kind === 'pswR' ? pswIdx : oswIdx;
				if (tr.param === 1000) { for (const i of list) if (a[i] === 1) set(i, 0); } else set(featIdx.get(tr.feats[0]), 0);
				break;
			}
			case 'team': case 'prot': set(tr.fi, tr.param); break;
			case 'reset': { const i = featIdx.get('prot'); if (i !== undefined && a[i] === 1) set(i, 0); if (fxTracked) fx = 0; break; }
			case 'coins': case 'bcoins':
				cb = Uint32Array.from(cb); cb[tr.coinBit >> 5] |= 1 << (tr.coinBit & 31);
				set(tr.fi, a[tr.fi] + 1);
				break;
			case 'cp': cp = tr.tiles[0]; break;
			case 'fx': fx = tr.param; break;
		}
		return mk(a, cb, cp, S.deaths, S.sp, fx);
	}
	/** the key-expiry successors of S: [[feat, S']] (a key runs out 500 ticks after it is taken) */
	function expire(S) {
		const out = [];
		featList.forEach((k, i) => { if (k.startsWith('key') && S.a[i] === 1) { const a = Int32Array.from(S.a); a[i] = 0; out.push([k, mk(a, S.cb, S.cp, S.deaths, S.sp, S.fx)]); } });
		return out;
	}
	/** S after a death: deaths + 1, the respawn tile (the checkpoint, else the next spawn) */
	function die(S) {
		let tile, sp = S.sp;
		if (S.cp >= 0) tile = S.cp;
		else if (spawns.length) { let k = sp >= spawns.length ? 0 : sp; tile = spawns[k]; sp = spTracked ? (k + 1) % spawns.length : 0; }
		else tile = A.start.t;
		return { S: mk(S.a, S.cb, S.cp, S.deaths + 1, sp, S.fx), tile };
	}
	// ---------------------------------------------------------------- doors under a state
	const featV = (S, k) => { const i = featIdx.get(k); return i === undefined ? 0 : S.a[i]; };
	/** the open bit of every gate type under S (Uint8Array(gtypes)) */
	function openTypes(S) {
		if (S._open) return S._open;
		const o = new Uint8Array(gtypes.length);
		for (let g = 0; g < gtypes.length; g++) {
			const ty = gtypes[g];
			switch (ty.kind) {
				case 0: o[g] = testGate(ty.feat, ty.pol, ty.param, featV(S, ty.feat)) ? 1 : 0; break;
				case 1: case 3: o[g] = 1; break;
				case 2: o[g] = 0; break;
				case 4: o[g] = ty.param <= S.deaths ? 1 : 0; break;
				case 5: o[g] = ty.param > S.deaths ? 1 : 0; break;
			}
		}
		S._open = o;
		return o;
	}
	const protI = featIdx.has('prot') ? featIdx.get('prot') : -1;
	/** doorKey(S): the open / shut bit of every gate a state can change (+ protection over the killers) */
	function doorKey(S) {
		if (S._door !== null) return S._door;
		const o = openTypes(S);
		let s = '';
		for (let g = 0; g < gtypes.length; g++) { const k = gtypes[g].kind; if (k === 0 || k === 4 || k === 5) s += o[g]; }
		s += protI >= 0 ? S.a[protI] : 0;
		S._door = s;
		return s;
	}
	/** tile i under S: 0 blocked, 1 passable, 2 a killer (the ball dies) */
	function passOf(S, o, i) {
		const c = cls[i];
		if (c === 2) return 1;
		if (c === 0) return 0;
		if (c === 3) return o[gtype[i]];
		return protI >= 0 && S.a[protI] === 1 ? 1 : 2;
	}
	const stepCost = (t, t2, diag) => {
		const c = diag ? 7 : 5;
		if (A.gateFeat[t2] !== 'time') return c;
		return A.gateFeat[t] === 'time' && fg[t] === fg[t2] ? c : c + TIME_WAIT;
	};

	// ---------------------------------------------------------------- the region walk
	const NB = hasTime ? 512 : 16, BM = NB - 1;
	const bk = [], bn = new Int32Array(NB);
	for (let b = 0; b < NB; b++) bk.push(new Int32Array(64));
	const dist = new Int32Array(N), stamp = new Uint32Array(N);
	let curStamp = 0;
	const trigBest = new Int32Array(triggers.length), trigTile = new Int32Array(triggers.length), trigStamp = new Uint32Array(triggers.length);
	const stopMemo = new Int8Array(triggers.length);
	const memo = new Map();
	let memoBytes = 0;
	const MEMO_BYTES = opts.memoBytes || 256e6;
	const stats = { walks: 0, hits: 0, walkMs: 0, phys: 0, physMs: 0, physHits: 0 };
	/**
	 * region(S, entry) -> {entry, regionId (the least tile index), tiles, d (fifths, parallel), edges [{id, tile, dist}]
	 * (the stops: relevant triggers whose touch changes S, by distance), trigs (their ids), trophy {tile, dist} | null,
	 * killer {tile, dist} | null (the nearest killer next to the region), cps / fxs [{id, tile, dist}] (the soft triggers
	 * the walk passes: checkpoints, effects), mask (getter: Uint8Array(N)), dist (getter: Int32Array(N), -1 outside)}
	 */
	function region(S, entry) {
		const mkey = S.wkey + '@' + entry;
		const had = memo.get(mkey);
		if (had) { memo.delete(mkey); memo.set(mkey, had); stats.hits++; return had; }
		const tw = Date.now();
		stats.walks++;
		const o = openTypes(S);
		curStamp++;
		if (curStamp === 0xffffffff) { stamp.fill(0); trigStamp.fill(0); curStamp = 1; }
		stopMemo.fill(-1);
		const isStop = (t) => {
			const id = trigAt[t];
			if (id < 0) return false;
			const tr = triggers[id];
			if (!tr.stop) return false;
			let m = stopMemo[id];
			if (m < 0) { m = changes(S, tr) ? 1 : 0; stopMemo[id] = m; }
			return m === 1;
		};
		const tiles = [], dd = [], edges = [], cps = [], fxs = [];
		let trophy = null, killer = null, regionId = entry, queued = 0, cur = 0;
		const push = (t, c) => {
			if (stamp[t] === curStamp && dist[t] <= c) return;
			stamp[t] = curStamp; dist[t] = c;
			const b = c & BM;
			let arr = bk[b];
			if (bn[b] === arr.length) { const a2 = new Int32Array(arr.length * 2); a2.set(arr); bk[b] = arr = a2; }
			arr[bn[b]++] = t;
			queued++;
		};
		push(entry, 0);
		const qMove = A.qMove || null;
		const shutF = (i) => cls[i] === 3 && o[gtype[i]] === 0, transF = (i) => passOf(S, o, i) !== 0;
		while (queued > 0) {
			const b = cur & BM;
			if (bn[b] === 0) { cur++; continue; }
			const arr = bk[b];
			const n0 = bn[b];
			bn[b] = 0;
			for (let n = 0; n < n0; n++) {
				const t = arr[n];
				queued--;
				if (dist[t] !== cur || stamp[t] !== curStamp) continue;
				if (t !== entry) {
					if (isTrophy[t]) { if (!trophy) trophy = { tile: t, dist: cur }; continue; }
					if (isStop(t)) {
						const id = trigAt[t];
						if (trigStamp[id] !== curStamp) { trigStamp[id] = curStamp; trigBest[id] = cur; trigTile[id] = t; edges.push(id); }
						continue;
					}
				}
				tiles.push(t); dd.push(cur);
				if (t < regionId) regionId = t;
				const id0 = trigAt[t];
				if (id0 >= 0 && t !== entry) {
					const tr = triggers[id0];
					if (tr.kind === 'cp' && cpTracked && S.cp !== t) cps.push({ id: id0, tile: t, dist: cur });
					else if (tr.kind === 'fx' && fxTracked && tr.param !== S.fx) fxs.push({ id: id0, tile: t, dist: cur });
				}
				const ex = A.portalExits.get(t);
				if (ex) for (const e of ex) if (passOf(S, o, e) === 1) push(e, cur + 5);
				if (A.forcedP[t]) continue;
				const x = t % W, y = (t - x) / W;
				for (let di = 0; di < 8; di++) {
					const x2 = x + DX8[di], y2 = y + DY8[di];
					if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
					const t2 = y2 * W + x2;
					const p = passOf(S, o, t2);
					if (p === 0) continue;
					const diag = DX8[di] !== 0 && DY8[di] !== 0;
					if (diag && passOf(S, o, y * W + x2) === 0 && passOf(S, o, y2 * W + x) === 0) continue;
					if (A.oneWay[t2] >= 0 && owBlocked(A.oneWay[t2], DX8[di], DY8[di])) continue;
					if (qMove !== null && qMove[t * 8 + di] !== 0 && (qMove[t * 8 + di] === 1 || !SF.qMoveOK(A, t, di, shutF, transF))) continue;
					const c2 = cur + stepCost(t, t2, diag);
					if (p === 2) { if (!killer || c2 < killer.dist) killer = { tile: t2, dist: c2 }; continue; }
					push(t2, c2);
				}
			}
			cur++;
		}
		const ed = edges.map((id) => ({ id, tile: trigTile[id], dist: trigBest[id] })).sort((a, b) => a.dist - b.dist || a.id - b.id);
		const R = {
			entry, regionId, key: S.wkey, tiles: Int32Array.from(tiles), d: Int32Array.from(dd), edges: ed, trigs: ed.map((e) => e.id), trophy, killer,
			cps: cps.sort((a, b) => a.dist - b.dist), fxs: fxs.sort((a, b) => a.dist - b.dist),
			get mask() { const m = new Uint8Array(N); for (const t of this.tiles) m[t] = 1; return m; },
			get dist() { const m = new Int32Array(N).fill(-1); for (let i = 0; i < this.tiles.length; i++) m[this.tiles[i]] = this.d[i]; return m; },
		};
		const bytes = 8 * tiles.length + 64 * (ed.length + cps.length + fxs.length) + 200;
		memo.set(mkey, R); memoBytes += bytes; R._bytes = bytes;
		while (memoBytes > MEMO_BYTES && memo.size > 1) { const k = memo.keys().next().value; memoBytes -= memo.get(k)._bytes; memo.delete(k); }
		stats.walkMs += Date.now() - tw;
		return R;
	}

	// ---------------------------------------------------------------- the heuristic: the walk to a trophy with every door open
	/** fifths from each tile to the nearest trophy with every door / gate open, killers passable, triggers air (-1: none) */
	const hAll = (() => {
		const h = new Int32Array(N).fill(-1);
		if (!trophies.length) return h;
		const heap = [];
		const hp = (c, t) => { heap.push([c, t]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
		const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
		const ok = (i) => cls[i] !== 0 && !(cls[i] === 3 && gtypes[gtype[i]].kind === 2);
		for (const t of trophies) { h[t] = 0; hp(0, t); }
		while (heap.length) {
			const [c, t2] = pop();
			if (c !== h[t2]) continue;
			const x2 = t2 % W, y2 = (t2 - x2) / W;
			for (let di = 0; di < 8; di++) {
				const x = x2 - DX8[di], y = y2 - DY8[di];
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const t = y * W + x;
				if (isTrophy[t] || !ok(t) || A.forcedP[t]) continue;
				if (A.oneWay[t2] >= 0 && owBlocked(A.oneWay[t2], DX8[di], DY8[di])) continue;
				if (DX8[di] && DY8[di] && !ok(y * W + x2) && !ok(y2 * W + x)) continue;
				const c2 = c + stepCost(t, t2, DX8[di] !== 0 && DY8[di] !== 0);
				if (h[t] < 0 || c2 < h[t]) { h[t] = c2; hp(c2, t); }
			}
			const ps = A.portalSrcOf.get(t2);
			if (ps) for (const p of ps) if (ok(p) && (h[p] < 0 || c + 5 < h[p])) { h[p] = c + 5; hp(c + 5, p); }
		}
		return h;
	})();
	let hMax = 0;
	for (let i = 0; i < N; i++) if (hAll[i] > hMax) hMax = hAll[i];

	// ---------------------------------------------------------------- physics: the level copy of a state, the goal fields
	const lvMemo = new Map();
	/** levelOfState(S): a copy of L whose gates stand as under S: open -> 0, shut -> 9 (time doors, death doors / gates,
	 *  zombie gates keep their ids: the reach field's optimism); killers air while S has protection */
	function levelOfState(S) {
		const k = doorKey(S);
		const had = lvMemo.get(k);
		if (had) { lvMemo.delete(k); lvMemo.set(k, had); return had; }
		const o = openTypes(S);
		const f2 = Int32Array.from(fg);
		const prot = protI >= 0 && S.a[protI] === 1;
		for (let i = 0; i < N; i++) {
			const c = cls[i];
			if (c === 3) { const ty = gtypes[gtype[i]]; if (ty.kind === 0 || ty.kind === 1 || ty.kind === 2) f2[i] = o[gtype[i]] ? 0 : 9; }
			else if (c === 1 && prot) f2[i] = 0;
		}
		const lv = Object.assign({}, L, { fg: f2 });
		lvMemo.set(k, lv);
		if (lvMemo.size > 24) lvMemo.delete(lvMemo.keys().next().value);
		return lv;
	}
	const costMemo = new Map();
	/** edgeCost(S, trigId | 'trophy', from) -> fifths at rest from tile `from` to the trigger by the RCH3 field of S's doors
	 *  (Infinity: none). Cached per (doorKey, trigger, tile). */
	function edgeCost(S, trig, from) {
		const key = `${doorKey(S)}|${trig}|${from}`;
		const had = costMemo.get(key);
		if (had !== undefined) { stats.physHits++; return had; }
		const tp = Date.now();
		const tiles = trig === 'trophy' ? trophies : triggers[trig].tiles;
		const f = T.goalField(levelOfState(S), tiles);
		const v = SF.arriveCost(f, from);
		const out = v >= 0xfffe || v >= CUT ? Infinity : v;
		costMemo.set(key, out);
		stats.phys++; stats.physMs += Date.now() - tp;
		return out;
	}
	/** anchorCost(sim, tiles) -> tiles to the goal from a REAL state with the doors as they stand now (-1: a proof that the
	 *  goal is not reachable while the doors stay as now) */
	function anchorCost(sim, tiles) {
		const tp = Date.now();
		const f = T.goalField(T.levelNow(L, sim), tiles);
		const v = RF.costAt(f, sim);
		stats.phys++; stats.physMs += Date.now() - tp;
		return v;
	}
	/** a sim at a real arrival (its snapshot when it has one, else the masks replayed) */
	let simA = null;
	function simAt(arrival) {
		if (arrival && arrival.snap) { if (!simA) { simA = new E.EESim(L); simA.reset(); } simA.restore(arrival.snap); return simA; }
		const r = T.playTo(L, arrival && arrival.masks ? arrival.masks : new Uint8Array(0), { allowDeath: true });
		return r.sim;
	}
	// ---------------------------------------------------------------- labels
	const xy = (t) => `${t % W},${(t / W) | 0}`;
	function trigLabel(id) {
		if (id === 'trophy') return 'trophy';
		const tr = triggers[id];
		if (!tr) return String(id);
		const at = xy(tr.tiles[0]);
		switch (tr.kind) {
			case 'key': return `${COLORS[tr.param] || 'key' + tr.param} key @${at}`;
			case 'psw': return `purple switch ${tr.param} @${at}`;
			case 'pswR': return `purple reset ${tr.param === 1000 ? 'all' : tr.param} @${at}`;
			case 'osw': return `orange switch ${tr.param} @${at}`;
			case 'oswR': return `orange reset ${tr.param === 1000 ? 'all' : tr.param} @${at}`;
			case 'team': return `team ${tr.param} @${at}`;
			case 'prot': return `protection ${tr.param ? 'on' : 'off'} @${at}`;
			case 'reset': return `effects reset @${at}`;
			case 'fx': return `effect ${fg[tr.tiles[0]]}${tr.param ? '' : ' (default)'} @${at}`;
			case 'coins': return `coin @${at}`;
			case 'bcoins': return `blue coin @${at}`;
			case 'crown': return `crown @${at}`;
			case 'cp': return `checkpoint @${at}`;
		}
		return `${tr.kind} @${at}`;
	}
	/** describe(S): the tracked features that are on, the counts, the checkpoint, the deaths */
	function describe(S) {
		const parts = [];
		featList.forEach((k, i) => {
			const v = S.a[i];
			if (k === 'coins' || k === 'bcoins') parts.push(`${k}=${v}`);
			else if (k === 'team') parts.push(`team=${v}`);
			else if (v) parts.push(k);
		});
		if (cpTracked && S.cp >= 0) parts.push(`cp@${xy(S.cp)}`);
		if (S.deaths) parts.push(`deaths=${S.deaths}`);
		if (fxTracked && S.fx) parts.push('fx');
		return parts.join(' ') || '(start)';
	}
	/** the feature a trigger sets and its value after the touch from S (the waypoint's Expect; null: none single) */
	function expectOf(S, id, S2) {
		const tr = triggers[id];
		switch (tr.kind) {
			case 'coins': case 'bcoins': return { feat: 'coin@' + tr.tiles[0], value: 1 };
			case 'key': return { feat: 'key' + tr.param, value: 1 };
			case 'crown': return { feat: 'crown', value: 1 };
			case 'psw': case 'osw': return { feat: tr.feats[0], value: S2.a[tr.fi] };
			case 'pswR': case 'oswR': {
				if (tr.param !== 1000) return { feat: tr.feats[0], value: 0 };
				for (const k of tr.feats) { const i = featIdx.get(k); if (i !== undefined && S.a[i] === 1) return { feat: k, value: 0 }; }
				return null;
			}
			case 'team': return { feat: 'team', value: tr.param };
			case 'prot': return { feat: 'prot', value: tr.param };
			case 'reset': return protI >= 0 && S.a[protI] === 1 ? { feat: 'prot', value: 0 } : { feat: 'fx', value: 0 };
			case 'fx': return { feat: 'fx', value: tr.param };
			case 'cp': return { feat: 'cp', value: tr.tiles[0] };
		}
		return null;
	}
	const info = { ms: Date.now() - t0, triggers: triggers.length, relevant: triggers.filter((t) => t.relevant).length, feats: featList.length, gateTypes: gtypes.length, coins: coinTrig.length, checkpoints: nCp, killers, deathDoors, spawns: spawns.length, portals: A.portalExits.size, hMax };
	Object.assign(M, { stateOf, startState, apply, changes, expire, die, doorKey, openTypes, passOf, region, hAll, hMax, levelOfState, edgeCost, anchorCost, simAt, trigLabel, describe, expectOf, xy, stats, info, featV });
	return M;
}

module.exports = { compileModel, testGate, PState };
