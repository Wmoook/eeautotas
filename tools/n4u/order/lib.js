'use strict';
// N4U STUDY 3, THE PLAN ORACLE (n4u-order, 2026-09-29): the order facts every compiler plan must respect, from the level
// alone (a relaxation: sound) and from the known routes (the truth set: what real routes did).
//
//   relax(A, L, o) -> {trophy (round, -1 never), rounds, facts: Map(fact -> round), coins, bcoins, deathSeeded}
//        the DELETE RELAXATION of the level's trigger / gate machine over steer.js analyze's walk (walls, portals with
//        every exit, forced portals left only by their exits, killers and one-ways passable, 4-connected = 8-way with
//        the corner rule): FACTS 'psw:<id>', 'osw:<id>', 'key<c>', 'team=<v>', 'crown', 'coins>=T', 'bcoins>=T'; a door
//        (pol 1) opens when its fact holds; every gate (pol 0), time door, death / zombie door is passable. UNLIKE
//        src/landmarks.js: a DEATH re-seeds the walk at every spawn (EE respawns at the rotation's next spawn or the last
//        checkpoint; a checkpoint the walk reached is reached anyway) as soon as the walk reaches a killer or a timed
//        killer effect (curse / zombie / poison / lava). o.forbid: a Set of facts that may never hold (coins>=T: the
//        count is capped at T - 1). Monotone: the reached set only grows, so one incremental flood per fixpoint.
//   oracleOfLevel(L) -> {trophyRound, facts {fact: round}, landmarks [{f, wave, by: trigger tiles}], order [[A, B]]
//        (A must hold before B: B unreachable in the relaxation while A is forbidden; transitive reduction dropped, the
//        full relation kept), chain (the longest landmark chain), doors [{fact, pol, tiles, n, openers}], ...}
//   routeFacts(L, masks, o) -> {firstTick {fact: tick}, factOrder [fact], passes [{tick, gate, fact, pol, value}],
//        used [fact] (the facts a pass through a pol-1 door needed), toggleBacks, blockReentries, revisit}
//   planFacts(model, plan) -> {first {fact: step index}, complete}: the facts a compiler plan achieves, step by step
//        (model.touch on the abstract state: the planner's own semantics)
//   checkPlan(orc, model, plan) -> {ok, complete, missing [fact], violations [[A, B]], coverage}: T-PLAN-ORACLE
const E = require('../../../src/eesim.js');
const ST = require('../../../src/steer.js');

const CURSE = 421, ZOMBIE = 422, POISON = 1584, LAVA = 416, SPAWN = 255, CHECKPOINT = 360;
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
const DGX = [1, 1, -1, -1], DGY = [1, -1, 1, -1];

/** the fact a door (pol 1) tile opens on ('' for no fact: static / open / time / a gate) */
function doorFact(A, i) {
	const f = A.gateFeat[i], p = A.gateParam[i];
	if (!f || f === 'static' || f === 'open' || f === 'time') return '';
	if (f.startsWith('psw') || f.startsWith('osw')) return f;          // 'psw:<id>'
	if (f.startsWith('key')) return f;
	if (f === 'team') return `team=${p}`;
	if (f === 'coins') return `coins>=${p}`;
	if (f === 'bcoins') return `bcoins>=${p}`;
	if (f === 'crown') return 'crown';
	return '';
}

/** the relaxed fixpoint (see the header) */
function relax(A, L, o = {}) {
	const { W, H, N, cls, gatePol, special, portalExits, trophies } = A;
	const forbid = o.forbid || new Set();
	let capC = Infinity, capB = Infinity;
	for (const f of forbid) {
		if (f.startsWith('coins>=')) capC = Math.min(capC, +f.slice(7) - 1);
		if (f.startsWith('bcoins>=')) capB = Math.min(capB, +f.slice(8) - 1);
	}
	const facts = new Map();
	const has = { psw: new Set(), osw: new Set(), key: new Set(), team: new Set([0]), crown: false, coins: 0, bcoins: 0, prot: false };
	const tight = !!o.tight;
	const ok = (i) => {
		const c = cls[i];
		if (c === 0) return false;
		if (c === 1) return !tight || has.prot;
		if (c !== 3) return true;
		const f = A.gateFeat[i], pol = gatePol[i], p = A.gateParam[i];
		if (f === 'static') return pol === 1;
		if (f === 'open' || f === 'time' || pol === 0) return true;
		if (f.startsWith('psw')) return has.psw.has(p) || has.psw.has(1000);
		if (f.startsWith('osw')) return has.osw.has(p) || has.osw.has(1000);
		if (f.startsWith('key')) return has.key.has(f);
		if (f === 'coins') return has.coins >= p;
		if (f === 'bcoins') return has.bcoins >= p;
		if (f === 'team') return has.team.has(p);
		if (f === 'crown') return has.crown;
		return true;
	};
	// the tiles a death can start from (a killer, a timed killer's effect tile), the respawn seeds (spawns)
	const fg = L.fg, lk = L.lookup0;
	const spawns = [];
	for (let k = 0; k < (L.spawnsX || []).length; k++) { const x = L.spawnsX[k], y = L.spawnsY[k]; if (x >= 0 && y >= 0 && x < W && y < H && cls[y * W + x] !== 0) spawns.push(y * W + x); }
	if (!spawns.length) for (let i = 0; i < N; i++) if (fg[i] === SPAWN && cls[i] !== 0) spawns.push(i);
	const seen = new Uint8Array(N), blocked = new Uint8Array(N);
	const q = [];
	let blockedList = [];
	let deathSeeded = false, canDie = false;
	// (tight: a killer's tile is the ball's CURRENT tile when its centre is in it (eesim tick: gFlags[current] & 4 kills
	// unless invulnerable): entering it without protection is a death, so the walk stops there and a death re-seeds)
	const push = (j) => { if (seen[j]) return; if (!ok(j)) { if (cls[j] === 1) canDie = true; if (!blocked[j] && (cls[j] === 3 || cls[j] === 1)) { blocked[j] = 1; blockedList.push(j); } return; } seen[j] = 1; q.push(j); };
	const flood = () => {
		while (q.length) {
			const c = q.pop();
			if (!canDie && (cls[c] === 1 || ((fg[c] === CURSE || fg[c] === ZOMBIE || fg[c] === POISON) && lk[c] > 0) || fg[c] === LAVA)) canDie = true;
			const ex = portalExits.get(c);
			// (a portal tile: its exits AND the walk on. steer.js's forcedP (left only by its exits) is an ordering rule,
			// not a proof: a ball with lastPortal set, at rest at a tick's start or faster than a tile a tick passes a
			// portal without a teleport; Good Egg's routes climb column 3 through the portal (3, 186) at 15 px/tick)
			if (ex) for (const j of ex) push(j);
			const x = c % W, y = (c / W) | 0;
			for (let d = 0; d < 4; d++) {
				const nx = x + DX[d], ny = y + DY[d];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				push(ny * W + nx);
			}
			// (tight: the diagonals too, unless both orthogonal tiles are walls or shut gates: the kill test reads the
			// centre's tile at the tick's start, so a ball can pass diagonally between two spikes without a tick there)
			if (tight) for (let d = 0; d < 4; d++) {
				const nx = x + DGX[d], ny = y + DGY[d];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const a = y * W + nx, b = ny * W + x;
				if (!(cls[a] === 1 || ok(a)) && !(cls[b] === 1 || ok(b))) continue;
				push(ny * W + nx);
			}
		}
	};
	push(A.start.t);
	let round = 0, trophy = -1;
	const coinT = [], bcoinT = [];
	for (const [t, kind] of special) { if (kind === 'coins') coinT.push(t); else if (kind === 'bcoins') bcoinT.push(t); }
	for (; round < 2000; round++) {
		flood();
		if (canDie && !deathSeeded) { deathSeeded = true; for (const s of spawns) push(s); flood(); }
		// (checkpoints reached are respawns: reached already)
		// (o.full: the fixpoint to its end, past the trophy: every achievable fact)
		if (trophy < 0 && trophies.some((t) => seen[t])) { trophy = round; if (!o.full) break; }
		let changed = false;
		const add = (fact, set, v) => { if (forbid.has(fact)) return; if (!set.has(v)) { set.add(v); changed = true; if (!facts.has(fact)) facts.set(fact, round + 1); } };
		for (const [t, kind, v] of special) {
			if (!seen[t]) continue;
			if (kind === 'psw') add(`psw:${v}`, has.psw, v);
			else if (kind === 'osw') add(`osw:${v}`, has.osw, v);
			else if (kind === 'key') add(`key${v}`, has.key, `key${v}`);
			else if (kind === 'team') add(`team=${v}`, has.team, v);
			else if (kind === 'crown' && !has.crown && !forbid.has('crown')) { has.crown = true; changed = true; facts.set('crown', round + 1); }
			else if (kind === 'prot' && v === 1 && tight && !has.prot && !forbid.has('prot')) { has.prot = true; changed = true; facts.set('prot', round + 1); }
		}
		let nc = 0, nb = 0;
		for (const t of coinT) if (seen[t]) nc++;
		for (const t of bcoinT) if (seen[t]) nb++;
		nc = Math.min(capC, nc); nb = Math.min(capB, nb);
		if (nc > has.coins) { for (let k = has.coins + 1; k <= nc; k++) if (!facts.has(`coins>=${k}`)) facts.set(`coins>=${k}`, round + 1); has.coins = nc; changed = true; }
		if (nb > has.bcoins) { for (let k = has.bcoins + 1; k <= nb; k++) if (!facts.has(`bcoins>=${k}`)) facts.set(`bcoins>=${k}`, round + 1); has.bcoins = nb; changed = true; }
		if (!changed) break;
		// the gates the new facts open: back into the flood
		const still = [];
		for (const j of blockedList) { if (ok(j)) { blocked[j] = 0; if (!seen[j]) { seen[j] = 1; q.push(j); } } else still.push(j); }
		blockedList = still;
	}
	return { trophy, rounds: round + 1, facts, coins: has.coins, bcoins: has.bcoins, deathSeeded, canDie, seen };
}

/** the coin thresholds some coin door (pol 1) reads (the only count facts that matter) */
function thresholds(A) {
	const c = new Set(), b = new Set();
	for (let i = 0; i < A.N; i++) {
		if (A.cls[i] !== 3 || A.gatePol[i] !== 1) continue;
		if (A.gateFeat[i] === 'coins') c.add(A.gateParam[i]);
		if (A.gateFeat[i] === 'bcoins') b.add(A.gateParam[i]);
	}
	return { c: [...c].sort((x, y) => x - y), b: [...b].sort((x, y) => x - y) };
}

/** landmarks, the order among them, every fact's needs and the longest chain, in one relaxation */
function lmAnalysis(A, L, doorFacts, openers, tight, base, t0, maxMs) {
	const res = { landmarks: [], order: [], needs: {}, chain: [], validOrder: [], partial: false };
	const achieved = [...base.facts.keys()].filter((f) => doorFacts.has(f));
	const lmSet = new Set();
	const needsOf = new Map();
	for (const f of achieved) {
		if (Date.now() - t0 > maxMs) { res.partial = true; break; }
		const r = relax(A, L, { forbid: new Set([f]), tight });
		needsOf.set(f, achieved.filter((g) => g !== f && !r.facts.has(g)));
		if (r.trophy < 0) lmSet.add(f);
	}
	for (const f of achieved) {
		if (!lmSet.has(f)) continue;
		const op = openers.get(f.startsWith('coins>=') ? 'coins' : f.startsWith('bcoins>=') ? 'bcoins' : f);
		res.landmarks.push({ f, wave: base.facts.get(f), openers: op ? op.n : 0 });
	}
	res.landmarks.sort((a, b) => a.wave - b.wave || a.f.localeCompare(b.f));
	for (const a of res.landmarks) for (const g of needsOf.get(a.f) || []) if (lmSet.has(g)) res.order.push([a.f, g]);
	for (const [f, lost] of needsOf) if (lost.length) res.needs[f] = lost;
	const succ = new Map(res.landmarks.map((l) => [l.f, []]));
	for (const [a, b] of res.order) succ.get(a).push(b);
	const memo = new Map();
	const longest = (f) => { if (memo.has(f)) return memo.get(f); memo.set(f, [f]); let best = [f]; for (const g of succ.get(f)) { const c = longest(g); if (c.length + 1 > best.length) best = [f, ...c]; } memo.set(f, best); return best; };
	for (const l of res.landmarks) { const c = longest(l.f); if (c.length > res.chain.length) res.chain = c; }
	// (a valid order: by wave, a topological order of the relation: B lost without A => wave(B) > wave(A))
	res.validOrder = res.landmarks.map((l) => l.f);
	return res;
}

/** the level's order oracle (see the header) */
function oracleOfLevel(L, o = {}) {
	const t0 = Date.now();
	const A = ST.analyze(L, {});
	const W = A.W, N = A.N;
	const base = relax(A, L, {});
	const th = thresholds(A);
	// the facts that matter: every fact a door reads (coin facts: the door thresholds only)
	const doorFacts = new Set();
	for (let i = 0; i < N; i++) if (A.cls[i] === 3 && A.gatePol[i] === 1) { const f = doorFact(A, i); if (f) doorFacts.add(f); }
	const achieved = [...base.facts.keys()].filter((f) => doorFacts.has(f));
	const unreachDoorFacts = [...doorFacts].filter((f) => !base.facts.has(f));
	// the doors: components of pol-1 door tiles by fact; the gates (pol 0) by fact
	const comp = new Int32Array(N).fill(-1);
	const doors = [];
	for (let i = 0; i < N; i++) {
		if (A.cls[i] !== 3 || comp[i] >= 0) continue;
		const fct = doorFact(A, i), pol = A.gatePol[i], feat = A.gateFeat[i], p = A.gateParam[i];
		if (!feat || feat === 'static' || feat === 'open' || feat === 'time') continue;
		const id = doors.length, tiles = [i];
		comp[i] = id;
		for (let k = 0; k < tiles.length; k++) {
			const c = tiles[k], x = c % W, y = (c / W) | 0;
			for (let d = 0; d < 4; d++) {
				const nx = x + DX[d], ny = y + DY[d];
				if (nx < 0 || ny < 0 || nx >= W || ny >= A.H) continue;
				const j = ny * W + nx;
				if (comp[j] >= 0 || A.cls[j] !== 3 || A.gateFeat[j] !== feat || A.gatePol[j] !== pol || A.gateParam[j] !== p) continue;
				comp[j] = id; tiles.push(j);
			}
		}
		const reached = tiles.some((t) => base.seen[t]);
		doors.push({ id, feat, pol, param: p, fact: pol === 1 ? fct : `!${feat}${feat === 'team' || feat === 'coins' || feat === 'bcoins' ? '=' + p : ''}`, n: tiles.length, tile: tiles[0], x: tiles[0] % W, y: (tiles[0] / W) | 0, reached });
	}
	// the openers: trigger tiles per fact (first 12) and their count
	const openers = new Map();
	const addOp = (f, t) => { if (!openers.has(f)) openers.set(f, { n: 0, tiles: [] }); const r = openers.get(f); r.n++; if (r.tiles.length < 12) r.tiles.push([t % W, (t / W) | 0]); };
	for (const [t, kind, v] of A.special) {
		if (kind === 'psw') addOp(`psw:${v}`, t);
		else if (kind === 'osw') addOp(`osw:${v}`, t);
		else if (kind === 'key') addOp(`key${v}`, t);
		else if (kind === 'team') addOp(`team=${v}`, t);
		else if (kind === 'crown') addOp('crown', t);
		else if (kind === 'coins') addOp('coins', t);
		else if (kind === 'bcoins') addOp('bcoins', t);
		else if (kind === 'pswR') addOp(`pswR:${v}`, t);
		else if (kind === 'oswR') addOp(`oswR:${v}`, t);
	}
	const out = {
		W, H: A.H, trophyRound: base.trophy, rounds: base.rounds, deathSeeded: base.deathSeeded, canDie: base.canDie,
		coinsReached: base.coins, bcoinsReached: base.bcoins, coinsTotal: (openers.get('coins') || { n: 0 }).n, bcoinsTotal: (openers.get('bcoins') || { n: 0 }).n,
		thresholds: th, doorFacts: [...doorFacts].sort(), facts: {}, unreachableDoorFacts: unreachDoorFacts.sort(),
		landmarks: [], order: [], needs: {}, chain: [], doors: [], trophies: A.trophies.map((t) => [t % W, (t / W) | 0]), start: [A.start.t % W, (A.start.t / W) | 0],
		gatesByFact: {}, partial: false, ms: 0,
	};
	for (const f of achieved) out.facts[f] = base.facts.get(f);
	for (const d of doors) { const k = d.fact; if (!out.gatesByFact[k]) out.gatesByFact[k] = { pol: d.pol, comps: 0, tiles: 0, reached: 0 }; out.gatesByFact[k].comps++; out.gatesByFact[k].tiles += d.n; if (d.reached) out.gatesByFact[k].reached++; }
	out.doors = doors.slice(0, 400).map((d) => ({ fact: d.fact, pol: d.pol, x: d.x, y: d.y, n: d.n, reached: d.reached }));
	out.doorComps = doors.length;
	out.openers = {};
	for (const [f, r] of openers) out.openers[f] = r;
	if (base.trophy < 0) { out.ms = Date.now() - t0; return out; }
	// landmarks and the order, in both relaxations (loose: killers passable = src/landmarks.js / the model's lb; tight:
	// a killer's tile is a death unless protected, the engine's centre-tile kill)
	const maxMs = o.maxMs || 60000;
	const lo = lmAnalysis(A, L, doorFacts, openers, false, base, t0, maxMs);
	Object.assign(out, { landmarks: lo.landmarks, order: lo.order, needs: lo.needs, chain: lo.chain, validOrder: lo.validOrder, partial: lo.partial });
	let killers = 0;
	for (let i = 0; i < N; i++) if (A.cls[i] === 1) killers++;
	if (o.tight !== false && killers > 0) {
		const df2 = new Set(doorFacts); df2.add('prot');
		const tb = relax(A, L, { tight: true });
		const ti = { trophyRound: tb.trophy, rounds: tb.rounds, deathSeeded: tb.deathSeeded };
		if (tb.trophy >= 0) Object.assign(ti, lmAnalysis(A, L, df2, openers, true, tb, t0, maxMs));
		out.tight = ti;
	}
	out.ms = Date.now() - t0;
	return out;
}

/** the facts a (feature, value) change achieves */
function factsOfChange(feat, to) {
	if (feat.startsWith('psw:') || feat.startsWith('osw:')) return to === 1 ? [feat] : [];
	if (/^key\d$/.test(feat)) return to === 1 ? [feat] : [];
	if (feat === 'team') return [`team=${to}`];
	if (feat === 'crown') return to === 1 ? ['crown'] : [];
	return [];
}

/**
 * routeFacts(L, masks, o) -> the route's facts in order, its door passes, its backtracking (see the header). o.A: the
 * level's analyze (else built); o.complete: stop there.
 */
function routeFacts(L, masks, o = {}) {
	const A = o.A || ST.analyze(L, {});
	const W = A.W, H = A.H, N = A.N;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const firstTick = {};
	const factOrder = [];
	const note = (f, t) => { if (firstTick[f] === undefined) { firstTick[f] = t; factOrder.push(f); } };
	let coins = sim.coins, bcoins = sim.blue_coins, team = sim.team, keys = sim._keysMask, crown = sim._collide_crown ? 1 : 0;
	let pOn = new Set(), oOn = new Set();
	for (const [k, v] of sim._switches) if (v === true) pOn.add(k);
	for (const [k, v] of sim._oswitches) if (v === true) oOn.add(k);
	const passes = [];
	const used = new Set(), usedOrder = [];
	let toggleBacks = 0, teamChanges = 0, pswOffs = 0;
	const inDoor = new Map();   // door tile -> last tick overlapped (a pass = a new entry)
	// backtracking: 8 x 8 tile blocks, re-entries of a block left before
	const BW = Math.ceil(W / 8);
	const blockSeen = new Set();
	let lastBlock = -1, reentries = 0, tileChanges = 0;
	const tilesSeen = new Uint8Array(N);
	let lastTile = -1, distinct = 0;
	const end = Math.min(masks.length, o.complete > 0 ? o.complete : masks.length);
	for (let t = 0; t < end; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const tk = t + 1;
		// feature changes -> facts
		if (sim.coins !== coins) { for (let k = coins + 1; k <= sim.coins; k++) note(`coins>=${k}`, tk); coins = sim.coins; }
		if (sim.blue_coins !== bcoins) { for (let k = bcoins + 1; k <= sim.blue_coins; k++) note(`bcoins>=${k}`, tk); bcoins = sim.blue_coins; }
		if (sim.team !== team) { team = sim.team; teamChanges++; note(`team=${team}`, tk); }
		if (sim._keysMask !== keys) { for (let c = 0; c < 6; c++) if ((sim._keysMask >> c) & 1 && !((keys >> c) & 1)) note(`key${c}`, tk); keys = sim._keysMask; }
		const cr = sim._collide_crown ? 1 : 0;
		if (cr !== crown) { crown = cr; if (cr) note('crown', tk); }
		const p2 = new Set(); for (const [k, v] of sim._switches) if (v === true) p2.add(k);
		for (const k of p2) if (!pOn.has(k)) note(`psw:${k}`, tk);
		for (const k of pOn) if (!p2.has(k)) pswOffs++;
		pOn = p2;
		const o2 = new Set(); for (const [k, v] of sim._oswitches) if (v === true) o2.add(k);
		for (const k of o2) if (!oOn.has(k)) note(`osw:${k}`, tk);
		oOn = o2;
		// door passes: the tiles the ball's box overlaps
		if (!sim.is_dead) {
			const x0 = Math.max(0, Math.floor(sim.px) >> 4), x1 = Math.min(W - 1, (Math.ceil(sim.px) + 15) >> 4);
			const y0 = Math.max(0, Math.floor(sim.py) >> 4), y1 = Math.min(H - 1, (Math.ceil(sim.py) + 15) >> 4);
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
				const i = y * W + x;
				if (A.cls[i] !== 3) continue;
				const feat = A.gateFeat[i];
				if (!feat || feat === 'static' || feat === 'open' || feat === 'time') continue;
				const prev = inDoor.get(i);
				inDoor.set(i, tk);
				if (prev !== undefined && prev >= tk - 1) continue;
				const pol = A.gatePol[i];
				if (pol === 1) {
					const f = doorFact(A, i);
					if (f && !used.has(f)) { used.add(f); usedOrder.push(f); }
					if (passes.length < 2000) passes.push({ tick: tk, x, y, fact: f, pol });
				} else {
					// a gate (open while the feature is off): off again after it was on = a toggle back
					const v = feat.startsWith('psw') ? (pOn.has(A.gateParam[i]) ? 1 : 0) : feat === 'team' ? team : feat.startsWith('key') ? ((keys >> +feat.slice(3)) & 1) : feat === 'coins' ? coins : feat === 'bcoins' ? bcoins : crown;
					const wasOn = feat.startsWith('psw') ? firstTick[feat] !== undefined : feat === 'team' ? firstTick[`team=${A.gateParam[i]}`] !== undefined : feat.startsWith('key') ? firstTick[feat] !== undefined : false;
					if (wasOn) { toggleBacks++; const f = `!${feat}${feat === 'team' ? '=' + A.gateParam[i] : ''}`; if (!used.has(f)) { used.add(f); usedOrder.push(f); } }
					if (passes.length < 2000) passes.push({ tick: tk, x, y, fact: `!${feat}`, pol, value: v });
				}
			}
			const ct = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4);
			if (ct >= 0 && ct < N && ct !== lastTile) {
				tileChanges++; lastTile = ct;
				if (!tilesSeen[ct]) { tilesSeen[ct] = 1; distinct++; }
				const b = (((ct / W) | 0) >> 3) * BW + ((ct % W) >> 3);
				if (b !== lastBlock) { if (blockSeen.has(b)) reentries++; blockSeen.add(b); lastBlock = b; }
			}
		}
		if (sim.has_silver_crown) break;
	}
	return { firstTick, factOrder, passes, used: usedOrder, toggleBacks, teamChanges, pswOffs, blockReentries: reentries, blocks: blockSeen.size, tileChanges, distinctTiles: distinct, revisit: distinct ? tileChanges / distinct : 0, ticks: sim.ticks(), finished: !!sim.has_silver_crown };
}

/** the facts a model state holds (the landmark names) */
function factsOfState(S, model) {
	const out = [];
	for (const f of model.feats) {
		const v = S.feats[f];
		if (v === undefined) continue;
		if (f.startsWith('psw:') || f.startsWith('osw:') || /^key\d$/.test(f)) { if (v === 1) out.push(f); }
		else if (f === 'team') out.push(`team=${v}`);
		else if (f === 'crown') { if (v === 1) out.push('crown'); }
		else if (f === 'coins' || f === 'bcoins') for (let k = 1; k <= v; k++) out.push(`${f}>=${k}`);
	}
	return out;
}

/** planFacts(model, plan) -> {first: {fact: step index}, order: [fact], complete} (model.touch along the plan's steps) */
function planFacts(model, plan) {
	let S = model.S0;
	const first = {}, order = [];
	for (const f of factsOfState(S, model)) first[f] = -1;
	let complete = false;
	(plan.steps || []).forEach((st, n) => {
		const wp = st.waypoint || {};
		if (wp.kind === 'trophy') { complete = true; return; }
		// (region steps: key passages and death steps change no door fact; the model's touch is the planner's semantics)
		if (wp.kind === 'trigger' && wp.trig !== undefined && model.triggers[wp.trig]) {
			const tr = model.touch(S, model.triggers[wp.trig]);
			S = tr.S2;
		}
		for (const f of factsOfState(S, model)) if (first[f] === undefined) { first[f] = n; order.push(f); }
	});
	return { first, order, complete };
}

/**
 * checkPlan(orc, model, plan) -> T-PLAN-ORACLE for one plan: a COMPLETE plan (ends at the trophy) must achieve every
 * landmark, and every order pair [A, B] must have A achieved no later than B (B at a step before A's: a violation; a
 * partial plan: only the pairs where B is achieved). coverage: landmarks achieved / landmarks.
 */
function checkPlan(orc, model, plan) {
	const pf = planFacts(model, plan);
	const complete = !plan.partial && pf.complete;
	const lms = (orc.landmarks || []).map((l) => l.f);
	const missing = lms.filter((f) => pf.first[f] === undefined);
	const violations = [];
	for (const [a, b] of orc.order || []) {
		const tb = pf.first[b];
		if (tb === undefined) continue;
		const ta = pf.first[a];
		if (ta === undefined || ta > tb) violations.push([a, b]);
	}
	const got = lms.length - missing.length;
	return { ok: violations.length === 0 && (!complete || missing.length === 0), complete, missing: complete ? missing : [], missingPartial: complete ? [] : missing, violations, coverage: lms.length ? got / lms.length : 1, planOrder: pf.order };
}

module.exports = { relax, oracleOfLevel, routeFacts, planFacts, checkPlan, factsOfState, doorFact, thresholds };
