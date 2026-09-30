'use strict';
// test/planmodel.js: the planner part's LEVEL MODEL (src/plan/model.js) and its fact store (src/plan/facts.js).
// P-UNIT (synthetic levels): the triggers and gates, stateOf = featValue, levelOf opens and shuts the right tiles,
// regionOf splits and joins as the doors do, a portal joins two rooms, the walk bound is admissible along real runs.
// --truth [--limit=N] [--shard=i/n] [--rch=K]: T-MODEL-SOUND on the known routes (src/plan/truthset.js): (a) stateOf
// changes exactly at the relevant events, (b) every relevant event's tile is a tile of a trigger of its feature
// (coverage), (c) the RCH3 goal field on levelOf(the state before) is never -1 from the ball at the previous event to the
// event's trigger (a -1 there = an unsound model; K sampled events a route, default 12), (d) the event tile is in the walk
// region of the previous position (portals, deaths allowed). Prints 'name: ok|FAIL detail' and 'N/M'.
// usage: node test/planmodel.js [--truth] [--limit=5] [--shard=0/1] [--rch=12]
// Also exports LEVELS (the synthetic levels) for test/planplanner.js.
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const M = require('../src/plan/model.js');
const F = require('../src/plan/facts.js');

/** level(rows, legend) -> a prepared level; legend: char -> [id, ...args] ('.' air, '#' wall, S spawn, T trophy) */
function level(rows, legend, name = 't') {
	const ID = Object.assign({ '#': [9], S: [255], T: [121] }, legend || {});
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`no legend for ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells }))));
}
const LEVELS = {
	// a red key, its door closing the corridor (a wall above it), the trophy past it
	keyDoor: () => level([
		'########################',
		'#..........#...........#',
		'#S....k....d.........T.#',
		'########################',
	], { k: [6], d: [23] }),
	// two coins, a 2-coin door
	coinDoor: () => level([
		'########################',
		'#..........#...........#',
		'#S..c..c...d.........T.#',
		'########################',
	], { c: [100], d: [43, 2] }),
	// three purple switches, each switch's door the way to the next switch
	chain3: () => level([
		'##########################',
		'#.....#....#....#........#',
		'#S.1..a..2.b..3.c.....T..#',
		'##########################',
	], { 1: [113, 1], 2: [113, 2], 3: [113, 3], a: [184, 1], b: [184, 2], c: [184, 3] }),
	// switch 1 twice: its door opens on the first press and its gate (open at first) shuts; the second switch tile past
	// the door opens the gate again
	toggle2: () => level([
		'##########################',
		'#.....#....#.............#',
		'#S.1..a..1.g.......T.....#',
		'##########################',
	], { 1: [113, 1], a: [184, 1], g: [185, 1] }),
	// a team effect, the team's door
	teamDoor: () => level([
		'########################',
		'#..........#...........#',
		'#S....e....d.........T.#',
		'########################',
	], { e: [423, 1], d: [1027, 1] }),
	// two rooms, a portal pair between them (1 -> 2), the trophy in the second room
	portal: () => level([
		'##########################',
		'#..........##............#',
		'#S......P..##..Q.....T...#',
		'##########################',
	], { P: [242, 0, 1, 2], Q: [242, 0, 2, 1] }),
	// the key, a switch behind the key door, the switch's door, the trophy
	keySwitch: () => level([
		'############################',
		'#.........#......#.........#',
		'#S...k....d...1..a......T..#',
		'############################',
	], { k: [6], d: [23], 1: [113, 1], a: [184, 1] }),
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? ' ' + detail : ''}`); };
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
/** play masks, calling fn(sim, tick) after every tick */
function play(L, masks, fn) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	fn(sim, 0);
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); fn(sim, t + 1); }
	return sim;
}

function units() {
	// ---- the key door
	{
		const L = LEVELS.keyDoor(), W = L.width, at = (x, y) => y * W + x;
		const m = M.compileModel(L);
		const key = m.triggers.find((X) => X.kind === 'key'), tro = m.triggers.find((X) => X.kind === 'trophy');
		check('P-UNIT keyDoor: triggers and feats', m.feats.join(',') === 'key0' && key && key.tiles[0] === at(6, 2) && key.relevant && tro && tro.tiles[0] === at(21, 2) && m.gates.length === 1 && m.gates[0].feat === 'key0',
			`feats ${m.feats} triggers ${m.triggers.map((X) => X.label).join('; ')}`);
		const S0 = m.S0;
		const L0 = m.levelOf(S0);
		check('P-UNIT keyDoor: levelOf shuts the door without the key', L0.fg[at(11, 2)] === 9 && S0.feats.key0 === 0);
		const r0a = m.regionOf(S0, at(2, 2)), r0b = m.regionOf(S0, at(20, 2));
		check('P-UNIT keyDoor: regionOf splits at the shut door', r0a >= 0 && r0b >= 0 && r0a !== r0b, `${r0a} ${r0b}`);
		const S1 = m.touch(S0, key).S2;
		const L1 = m.levelOf(S1);
		check('P-UNIT keyDoor: the key keeps its door a door block (open in RCH3)', L1.fg[at(11, 2)] === 23 && S1.feats.key0 === 1);
		check('P-UNIT keyDoor: regionOf joins with the key', m.regionOf(S1, at(2, 2)) === m.regionOf(S1, at(20, 2)));
		// stateOf = featValue along a run that takes the key and finishes
		const masks = new Uint8Array(300).fill(4);
		let bad = 0, n = 0, keyOn = -1;
		play(L, masks, (sim, t) => { const S = m.stateOf(sim); n++; if (S.feats.key0 !== T.featValue(sim, 'key0')) bad++; if (keyOn < 0 && S.feats.key0 === 1) keyOn = t; });
		check('P-UNIT keyDoor: stateOf = featValue at every tick', bad === 0 && keyOn > 0, `${n} ticks, key at ${keyOn}`);
		const r = m.reachable(S0, at(2, 2), [at(21, 2)]), r1 = m.reachable(S1, at(7, 2), [at(21, 2)]);
		check('P-UNIT keyDoor: reachable: -1 behind the shut door, finite with the key', r.proof === true && r1.proof === false && r1.cost > 0, `${r.cost} ${r1.cost}`);
		// the walk bound is admissible along the run: every leg's lb <= its ticks
		const pos = { id: 'start', tiles: [m.startTile] };
		const lbKey = m.pairLb(S0, pos, key.tiles, 'lb', null);
		check('P-UNIT keyDoor: pairLb start -> key <= the key tick', lbKey <= keyOn && lbKey > 0, `lb ${lbKey} vs ${keyOn}`);
	}
	// ---- the coin door
	{
		const L = LEVELS.coinDoor(), W = L.width, at = (x, y) => y * W + x;
		const m = M.compileModel(L);
		const coins = m.triggers.filter((X) => X.kind === 'coin');
		check('P-UNIT coinDoor: coins relevant (the door reads them), 2 coin tiles', m.feats.join(',') === 'coins' && coins.length === 2 && coins.every((X) => X.relevant) && m.coinTiles.length === 2);
		let bad = 0, ch = 0, prevKey = null, coinT = [];
		play(L, new Uint8Array(300).fill(4), (sim, t) => {
			const S = m.stateOf(sim);
			if (S.feats.coins !== sim.coins) bad++;
			let takenN = 0; for (const b of S.taken) takenN += b;
			if (takenN !== sim.coins) bad++;
			if (prevKey !== null && S.key !== prevKey) { ch++; coinT.push(t); }
			prevKey = S.key;
		});
		check('P-UNIT coinDoor: stateOf counts the coins and marks their tiles, changes exactly twice', bad === 0 && ch === 2, `changes at ${coinT}`);
		const S0 = m.S0, S1 = m.touch(S0, coins[0]).S2, S2 = m.touch(S1, coins[1]).S2;
		check('P-UNIT coinDoor: levelOf: shut at 0 and 1 coins, open at 2', m.levelOf(S0).fg[at(11, 2)] === 9 && m.levelOf(S1).fg[at(11, 2)] === 9 && m.levelOf(S2).fg[at(11, 2)] === 0 && S2.feats.coins === 2);
		check('P-UNIT coinDoor: touch: a taken coin changes nothing', m.touch(S1, coins[0]).changed === false && m.touch(S1, coins[1]).expect.value === 2);
	}
	// ---- the team door
	{
		const L = LEVELS.teamDoor(), W = L.width, at = (x, y) => y * W + x;
		const m = M.compileModel(L);
		const e = m.triggers.find((X) => X.kind === 'team');
		const S1 = m.touch(m.S0, e).S2;
		check('P-UNIT teamDoor: the team effect opens its door', m.feats.includes('team') && m.levelOf(m.S0).fg[at(11, 2)] === 9 && m.levelOf(S1).fg[at(11, 2)] === 0 && S1.feats.team === 1,
			`feats ${m.feats} team ${m.S0.feats.team} -> ${S1.feats.team}`);
		check('P-UNIT teamDoor: regionOf split then joined', m.regionOf(m.S0, at(2, 2)) !== m.regionOf(m.S0, at(20, 2)) && m.regionOf(S1, at(2, 2)) === m.regionOf(S1, at(20, 2)));
	}
	// ---- the toggle and the switch chain
	{
		const L = LEVELS.toggle2(), W = L.width, at = (x, y) => y * W + x;
		const m = M.compileModel(L);
		const sws = m.triggers.filter((X) => X.kind === 'psw');
		const S1 = m.touch(m.S0, sws[0]).S2, S2 = m.touch(S1, sws[1]).S2;
		check('P-UNIT toggle2: two switch components of id 1; press twice returns the state', sws.length === 2 && S1.feats['psw:1'] === 1 && S2.key === m.S0.key);
		check('P-UNIT toggle2: door shut / gate open at first, then the other way round', m.levelOf(m.S0).fg[at(6, 2)] === 9 && m.levelOf(m.S0).fg[at(11, 2)] === 0 && m.levelOf(S1).fg[at(6, 2)] === 0 && m.levelOf(S1).fg[at(11, 2)] === 9);
		const L3 = LEVELS.chain3(), m3 = M.compileModel(L3);
		check('P-UNIT chain3: 3 switch features, 3 gates', m3.feats.join(',') === 'psw:1,psw:2,psw:3' && m3.gates.length === 3);
	}
	// ---- the portal pair
	{
		const L = LEVELS.portal(), W = L.width, at = (x, y) => y * W + x;
		const m = M.compileModel(L);
		check('P-UNIT portal: regionOf joins the rooms through the portal', m.regionOf(m.S0, at(2, 2)) === m.regionOf(m.S0, at(21, 2)));
		const d = m.pairSteps(m.S0, { id: 's', tiles: [at(2, 2)] }, [at(21, 2)]);
		check('P-UNIT portal: the walk steps take the hop (shorter than no way)', d < M.INF && d < 20, `${d} steps`);
	}
	// ---- the est walk's diagonal between two killers (model moveOK): spike B (10,2) and spike C (9,3) around the corner
	// the trophy's way passes; the engine's route crosses it ((9,2) -> (10,3) in one tick, 64 ticks to the trophy by a
	// 1-px BFS); with a wall for C the box's sub-steps collide: shut. OPT-IN (EEAT_KILL_SQUEEZE=1): off, both shut
	{
		const on = process.env.EEAT_KILL_SQUEEZE === '1';
		const rows = (c) => ['##############', '#S...........#', '#.........x###', `#########${c}.###`, '##########.###', '##########T###', '##############'];
		for (const [c, open] of [['x', on], ['#', false]]) {
			const L = level(rows(c), { x: [361, 1] }), W = L.width, at = (x, y) => y * W + x;
			const m = M.compileModel(L);
			const d = m.pairSteps(m.S0, { id: 's', tiles: [at(1, 1)] }, [at(10, 5)], 'est');
			check(`P-UNIT killer squeeze (C ${c === 'x' ? 'a spike' : 'a wall'}): the est walk ${open ? 'reaches' : 'does not reach'} the trophy`, open ? d < M.INF : d >= M.INF, `${d >= M.INF ? 'INF' : d} steps`);
		}
	}
	// ---- facts
	{
		const f = F.createFacts();
		const v0 = f.version();
		f.add({ kind: 'fail', edge: 'trig:1', nodeClass: 'a|0,1', rung: 0, why: 'budget' });
		check('P-UNIT facts: a fail raises the rung and the version', f.rungOf('trig:1', 'a|0,1') === 1 && f.version() === v0 + 1 && !f.blocked('trig:1', 'a|0,1'));
		f.add({ kind: 'fail', edge: 'trig:1', nodeClass: 'a|0,1', rung: 1, why: 'budget' });
		f.add({ kind: 'fail', edge: 'trig:1', nodeClass: 'a|0,1', rung: 2, why: 'budget' });
		check('P-UNIT facts: RUNG_MAX failures block', f.blocked('trig:1', 'a|0,1') === 'block' && !f.blocked('trig:1', 'b|0,1'));
		f.add({ kind: 'proof', edge: 'trig:2', sKey: 'x' });
		f.add({ kind: 'ok', edge: 'trig:3', nodeClass: 'a|0,1', ticks: 50, lb: 10 });
		const j = JSON.parse(JSON.stringify(f.toJSON()));
		f.reset({ keepProofs: true });
		check('P-UNIT facts: proofs kept by reset, the rest gone, JSON round trip', f.blocked('trig:2', 'q', 'x') === 'proof' && f.rungOf('trig:1', 'a|0,1') === 0 && f.okTicks('trig:3', 'a|0,1') === undefined && j.facts.length === 5,
			`${j.facts.length} facts`);
		const g = F.createFacts({ facts: j.facts });
		check('P-UNIT facts: rebuilt from JSON', g.blocked('trig:1', 'a|0,1') === 'block' && g.okTicks('trig:3', 'a|0,1') === 50);
	}
}

// ---------------------------------------------------------------- T-MODEL-SOUND
function truth() {
	const S = require('../src/plan/truthset.js');
	const limit = +argOf('limit', 0) || Infinity;
	const [si, sn] = String(argOf('shard', '0/1')).split('/').map(Number);
	const rchK = +argOf('rch', 12);
	const known = S.knownRoutes().filter((e, i) => i % sn === si).slice(0, limit);
	if (!known.length) { console.log('(no known routes: set EEAT_TRUTH_ROOT to the main checkout)'); return; }
	const tot = { routes: 0, stale: 0, events: 0, relEvents: 0, a: 0, bCov: 0, bNear: 0, bMiss: 0, c: 0, cChecked: 0, d: 0, dChecked: 0, ms: 0 };
	const viol = [];
	for (const e of known) {
		const t0 = Date.now();
		let tr = null;
		try { tr = S.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) { tot.stale++; continue; }
		const L = tr.L, W = L.width, H = L.height;
		const m = M.compileModel(L, { file: e.levelFile });
		const ev = S.routeEvents(L, tr.masks);
		const relF = (f) => m.featSet.has(f) || (f === 'cp' && m.canDie);
		const rel = ev.events.filter((x) => relF(x.feat));
		const byTick = new Map();
		for (const x of rel) { if (!byTick.has(x.tick)) byTick.set(x.tick, []); byTick.get(x.tick).push(x); }
		tot.routes++; tot.events += ev.events.length; tot.relEvents += rel.length;
		// replay: states per tick, snapshots at the relevant events and their ticks - 1
		const want = new Set();
		for (const x of rel) { want.add(x.tick - 1); want.add(x.tick); }
		const states = new Map(), snaps = new Map(), dead = new Uint8Array(tr.masks.length + 2), tileAt = new Int32Array(tr.masks.length + 2);
		let prevKey = null, aBad = 0;
		const sim = play(L, tr.masks, (sm, t) => {
			const St = m.stateOf(sm);
			if (sm.is_dead) dead[t] = 1;
			tileAt[t] = T.tileOf(sm, W, H);
			if (want.has(t)) { states.set(t, St); snaps.set(t, { px: sm.px, py: sm.py, speed_y: sm.speed_y, _q0: sm._q0, _q1: sm._q1, _slippery: sm._slippery, tile: T.tileOf(sm, W, H) }); }
			if (prevKey !== null) {
				const changed = St.key !== prevKey;
				const evs = byTick.get(t) || [];
				// (a death past the model's cap and a key running out keep their event but a capped count need not change)
				// (a checkpoint of the same component as the one before: the same model state)
				const cpId = (v) => (v < 0 ? -1 : m.trigOf[v]);
				const need = evs.some((x) => !(x.feat === 'deaths' && x.from >= m.deathT) && !(x.feat === 'cp' && cpId(x.from) === cpId(x.to)));
				if (changed !== need && aBad < 3) viol.push(`(a) ${e.name} tick ${t}: state ${changed ? 'changed' : 'same'}, events ${evs.map((x) => x.feat).join(',') || 'none'}`);
				if (changed !== need) { aBad++; tot.a++; }
			}
			prevKey = St.key;
		});
		void sim;
		// (b), (c), (d) per relevant event
		const exempt = (x) => x.feat === 'deaths' || (x.feat.startsWith('key') && x.to === 0);
		const sample = new Set();
		const cand = rel.filter((x) => !exempt(x));
		const step = Math.max(1, Math.ceil(cand.length / Math.max(1, rchK)));
		cand.forEach((x, i) => { if (i % step === 0) sample.add(x); });
		let prev = null;
		for (const x of rel) {
			if (exempt(x)) { prev = x; continue; }
			// (b)
			const tt = x.tile;
			const matchT = (t) => { const id = m.trigOf[t]; if (id < 0) return null; const X = m.triggers[id]; if (X.feat === x.feat || (X.feat && X.feat.endsWith(':*') && x.feat.startsWith(X.feat.slice(0, 4))) || (X.kind === 'reset' && x.feat === 'prot')) return X; return null; };
			let X = matchT(tt), near = false;
			if (!X) {
				// (next to it, or where the ball was in the 8 ticks before: a press queued while the ball overlapped a
				// door it closes, a team change retried, a key queued: the engine applies them a tick or more later)
				for (let back = 0; back <= 8 && !X; back++) {
					const tb = back === 0 ? tt : tileAt[Math.max(0, x.tick - back)];
					const x0 = tb % W, y0 = (tb / W) | 0;
					for (let dy = -1; dy <= 1 && !X; dy++) for (let dx = -1; dx <= 1 && !X; dx++) { const nx = x0 + dx, ny = y0 + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) X = matchT(ny * W + nx); }
				}
				near = !!X;
			}
			if (X && !near) tot.bCov++; else if (X) tot.bNear++; else { tot.bMiss++; if (tot.bMiss <= 20) viol.push(`(b) ${e.name} tick ${x.tick}: ${x.feat} ${x.from}->${x.to} at (${tt % W},${(tt / W) | 0}) is no trigger of it`); }
			// (c) and (d): from the previous event (or the start) under the state before this event
			const pt = prev ? prev.tick : 0;
			let died = false;
			for (let t = pt; t <= x.tick; t++) if (dead[t]) { died = true; break; }
			const Sb = states.get(x.tick - 1);
			const from = prev ? snaps.get(prev.tick) : null;
			if (X && Sb && sample.has(x) && !died) {
				tot.cChecked++;
				let r;
				if (from) r = m.reachable(Sb, from, X.tiles);
				else r = m.reachable(Sb, m.startTile, X.tiles);
				if (r.proof) { tot.c++; viol.push(`(c) ${e.name} tick ${x.tick}: RCH3 -1 from the event at ${pt} to ${X.label} (UNSOUND)`); }
			}
			if (X && Sb && !died) {
				tot.dChecked++;
				const pTile = from ? from.tile : m.startTile;
				const rp = m.regionOf(Sb, pTile), re = m.regionOf(Sb, tt);
				const reX = X.tiles.some((t) => m.regionOf(Sb, t) === rp);
				if (rp < 0 || (rp !== re && !reX)) { tot.d++; if (tot.d <= 20) viol.push(`(d) ${e.name} tick ${x.tick}: ${X.label} not in the walk region of (${pTile % W},${(pTile / W) | 0}) [${rp} vs ${re}]`); }
			}
			prev = x;
		}
		tot.ms += Date.now() - t0;
		console.log(`  route ${e.source} ${e.name}: ${ev.events.length} events, ${rel.length} relevant, model ${m.stats().ms} ms, ${Date.now() - t0} ms`);
	}
	for (const v of viol.slice(0, 60)) console.log('  ' + v);
	const cov = tot.bCov + tot.bNear + tot.bMiss ? (tot.bCov + tot.bNear) / (tot.bCov + tot.bNear + tot.bMiss) : 1;
	console.log(`  totals ${JSON.stringify(tot)}`);
	check('T-MODEL-SOUND (a) stateOf changes exactly at the relevant events', tot.a === 0, `${tot.a} violations over ${tot.routes} routes (${tot.stale} stale)`);
	check('T-MODEL-SOUND (b) the events on trigger tiles (coverage >= 99%)', cov >= 0.99, `${(100 * cov).toFixed(2)}% (${tot.bCov} exact, ${tot.bNear} next to one, ${tot.bMiss} missed)`);
	check('T-MODEL-SOUND (c) no RCH3 -1 on a leg a route took', tot.c === 0, `${tot.c} of ${tot.cChecked} checked`);
	check('T-MODEL-SOUND (d) the event in the walk region of the previous position', tot.d === 0, `${tot.d} of ${tot.dChecked}`);
}

if (require.main === module) {
	units();
	if (process.argv.includes('--truth')) truth();
	console.log(`${pass}/${pass + fail}`);
	process.exitCode = fail ? 1 : 0;
}

module.exports = { level, LEVELS };
