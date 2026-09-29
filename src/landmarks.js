'use strict';
// src/landmarks.js: the LANDMARKS of a level from its own gate graph (classical planning's relaxed planning graph over
// the level's triggers; ported from the INNOLOOP box-4 round-2 level panel's probe, src/out/il4/r2/panel/level/
// landmarks.js). The walk relaxation of steer.js analyze (walls, portals directed with every exit, killers passable,
// one-ways passable): a monotone fixpoint over FACTS (purple / orange switch ids on, key colours, team values, the crown,
// gold / blue coin counts = the coin tiles reached); a door opens when its fact holds, gates stay passable (relaxation).
// The wave of a fact = the fixpoint round it first holds in. A LANDMARK = a fact without which the relaxed fixpoint never
// reaches a trophy: sound for the relaxation (every real route achieves it, since the relaxation over-approximates every
// real route). Coin landmarks are thresholds "coins >= T" (T a coin door's count the relaxation reaches).
// Used by src/rrank.js as a feature (the landmarks a room holds / the level's): ordering only, nothing is pruned by it.
const ST = require('./steer.js');

/** the relaxed fixpoint; forbid: one fact that may never hold ('psw:3', 'key2', 'team=1', 'crown', 'coins>=T', 'bcoins>=T')
 *  -> {trophy (the round the trophy was reached, -1 never), rounds, F (the facts at the end), wave (fact -> round)} */
function relaxed(A, forbid) {
	const { W, H, N, cls, gateFeat, gatePol, gateParam, special, portalExits, forcedP, trophies } = A;
	const F = { psw: new Set(), osw: new Set(), key: new Set(), team: new Set([0]), crown: false, coins: 0, bcoins: 0 };
	const wave = new Map();
	const coinTiles = [], bcoinTiles = [];
	for (const [t, kind] of special) { if (kind === 'coins') coinTiles.push(t); else if (kind === 'bcoins') bcoinTiles.push(t); }
	const capC = forbid && forbid.startsWith('coins>=') ? +forbid.slice(7) - 1 : Infinity;
	const capB = forbid && forbid.startsWith('bcoins>=') ? +forbid.slice(8) - 1 : Infinity;
	const ok = (i) => {
		const c = cls[i];
		if (c === 0) return false;
		if (c !== 3) return true;
		const f = gateFeat[i], pol = gatePol[i], p = gateParam[i];
		if (f === 'static') return pol === 1;
		if (f === 'open' || f === 'time' || pol === 0) return true;
		if (f && f.startsWith('psw')) return F.psw.has(p) || F.psw.has(1000);
		if (f && f.startsWith('osw')) return F.osw.has(p) || F.osw.has(1000);
		if (f && f.startsWith('key')) return F.key.has(f);
		if (f === 'coins') return F.coins >= p;
		if (f === 'bcoins') return F.bcoins >= p;
		if (f === 'team') return F.team.has(p);
		if (f === 'crown') return F.crown;
		return true;
	};
	let round = 0, trophy = -1;
	const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
	for (; round < 400; round++) {
		const seen = new Uint8Array(N);
		const q = [A.start.t]; seen[A.start.t] = 1;
		while (q.length) {
			const c = q.pop();
			const ex = portalExits.get(c);
			if (ex) { for (const j of ex) if (!seen[j] && ok(j)) { seen[j] = 1; q.push(j); } if (forcedP[c]) continue; }
			const x = c % W, y = (c / W) | 0;
			for (let d = 0; d < 4; d++) {
				const nx = x + DX[d], ny = y + DY[d];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (seen[j] || !ok(j)) continue;
				seen[j] = 1; q.push(j);
			}
		}
		if (trophies.some((t) => seen[t])) { trophy = round; break; }
		let changed = false;
		const add = (fact, set, v) => { if (forbid === fact) return; if (!set.has(v)) { set.add(v); changed = true; if (!wave.has(fact)) wave.set(fact, round + 1); } };
		for (const [t, kind, v] of special) {
			if (!seen[t]) continue;
			if (kind === 'psw') add(`psw:${v}`, F.psw, v);
			else if (kind === 'osw') add(`osw:${v}`, F.osw, v);
			else if (kind === 'key') add(`key${v}`, F.key, `key${v}`);
			else if (kind === 'team') add(`team=${v}`, F.team, v);
			else if (kind === 'crown' && !F.crown && forbid !== 'crown') { F.crown = true; changed = true; wave.set('crown', round + 1); }
		}
		let nc = 0, nb = 0;
		for (const t of coinTiles) if (seen[t]) nc++;
		for (const t of bcoinTiles) if (seen[t]) nb++;
		nc = Math.min(capC, nc); nb = Math.min(capB, nb);
		if (nc > F.coins) { F.coins = nc; changed = true; }
		if (nb > F.bcoins) { F.bcoins = nb; changed = true; }
		if (!changed) break;
	}
	return { trophy, rounds: round + 1, F, wave };
}

/** the level's landmarks: {trophy (round, -1: the relaxation never reaches it: no landmark), rounds, facts, landmarks:
 *  [{f, wave}]}; opts.maxMs: stop testing candidates past it (the landmarks found so far; out.partial) */
function landmarksOf(L, opts = {}) {
	const t0 = Date.now();
	const A = ST.analyze(L, {});
	const base = relaxed(A, null);
	const out = { trophy: base.trophy, rounds: base.rounds, coins: base.F.coins, bcoins: base.F.bcoins, facts: base.wave.size, landmarks: [], partial: false };
	if (base.trophy < 0) return out;
	const cands = [...base.wave.keys()];
	// (coin thresholds: the distinct coin door counts (pol 1) up to the coins reached)
	const th = new Set(), bth = new Set();
	for (let i = 0; i < A.N; i++) {
		if (A.cls[i] !== 3 || A.gatePol[i] !== 1) continue;
		if (A.gateFeat[i] === 'coins' && A.gateParam[i] <= base.F.coins) th.add(A.gateParam[i]);
		if (A.gateFeat[i] === 'bcoins' && A.gateParam[i] <= base.F.bcoins) bth.add(A.gateParam[i]);
	}
	for (const t of [...th].sort((a, b) => a - b)) cands.push(`coins>=${t}`);
	for (const t of [...bth].sort((a, b) => a - b)) cands.push(`bcoins>=${t}`);
	for (const f of cands) {
		if (opts.maxMs && Date.now() - t0 > opts.maxMs) { out.partial = true; break; }
		const r = relaxed(A, f);
		if (r.trophy < 0) out.landmarks.push({ f, wave: base.wave.get(f) || null });
	}
	return out;
}

const KEY_COL = { red: 0, green: 1, blue: 2, cyan: 3, magenta: 4, yellow: 5 };
/** a room description (goexplore.js roomOf desc: "lowgrav coins=3 purple=[1,3,101] key:blue") -> the facts it holds
 *  {s (Set of 'psw:3', 'osw:1', 'key2', 'team=1', 'crown'), coins, bcoins} */
function factsOfDesc(d) {
	d = String(d || '');
	const s = new Set();
	const m = /purple=\[([^\]]*)\]/.exec(d); if (m) for (const x of m[1].split(',').filter(Boolean)) s.add(`psw:${+x}`);
	const o = /orange=\[([^\]]*)\]/.exec(d); if (o) for (const x of o[1].split(',').filter(Boolean)) s.add(`osw:${+x}`);
	for (const k of d.matchAll(/key:(\w+)/g)) if (KEY_COL[k[1]] !== undefined) s.add(`key${KEY_COL[k[1]]}`);
	const t = /(?:^|\s)team=(\d+)/.exec(d); if (t) s.add(`team=${+t[1]}`);
	const c = /(?:^|\s)coins(?:>=|=)(\d+)/.exec(d);
	const b = /(?:^|\s)bluecoins(?:>=|=)(\d+)/.exec(d);
	if (/(?:^|\s)crown(?:\s|$)/.test(d)) s.add('crown');
	return { s, coins: c ? +c[1] : 0, bcoins: b ? +b[1] : 0 };
}
/** the landmarks (landmarksOf's list) a room description holds */
function progressOf(lm, desc) {
	const { s, coins, bcoins } = factsOfDesc(desc);
	let n = 0;
	for (const l of lm) {
		if (l.f.startsWith('coins>=')) { if (coins >= +l.f.slice(7)) n++; }
		else if (l.f.startsWith('bcoins>=')) { if (bcoins >= +l.f.slice(8)) n++; }
		else if (s.has(l.f)) n++;
	}
	return n;
}

module.exports = { relaxed, landmarksOf, factsOfDesc, progressOf };
