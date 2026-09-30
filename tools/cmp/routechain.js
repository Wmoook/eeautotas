'use strict';
// THE KNOWN ROUTE'S TRIGGER CHAIN, leg by leg, by the backward solver (src/plan/lab/backward.js) with one continuous clock
// a leg: where a gated level's chain breaks. The route's RELEVANT trigger events (the model's triggers: a coin, a key, a
// switch, a team, an effect, a checkpoint) in the route's own order, the trophy last. Per leg two starts:
//   route  the ROUTE'S OWN engine state at the previous event (its speed and sub-pixel): the leg solver alone
//   chain  the CHAIN'S OWN state (the spawn, then the end state of this tool's previous leg, whatever speed it arrived
//          with); a failed chain leg continues from the route's state at that event (rescue) and is counted as a break
// A leg is found when the replay from its start reaches the event's goal (the trigger's tile touched and the feature at
// the route's value; a coin: that coin taken). Every leg is the engine's replay from its exact start.
//   node tools/cmp/routechain.js <level.eelvl> <route.eetas> [--ms=40000] [--sched=6000,40000] [--modes=route,chain]
//     [--max=40] [--minleg=0]  -> one JSON line a leg (stderr) and a summary line (stdout)
const path = require('path');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'src/plan/defaults.js')).apply();
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const BC = require(path.join(root, 'src/plan/lab/bwchain.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
const [file, rfile] = pos;
const sched = String(opt('sched', '6000,40000')).split(',').map(Number).filter((x) => x > 0);
const modes = String(opt('modes', 'route,chain')).split(',');
const max = +opt('max', 40), minleg = +opt('minleg', 0);
const L = T.loadLevelFile(file), W = L.width, H = L.height;
const M = MD.compileModel(L);
const masks0 = C.readEetas(rfile);
const ev0 = C.evaluate(L, masks0, false);
if (!ev0) { console.log(JSON.stringify({ level: path.basename(file), error: 'the route does not finish' })); process.exit(0); }
const route = masks0.subarray(0, ev0.complete);
const evs = TS.routeEvents(L, route);
// the relevant events and their goals
const legs = [];
let prev = 0;
for (const e of evs.events) {
	if (e.feat === 'deaths' || e.feat === 'fx') continue;
	const tr = M.trigOf ? M.trigOf[e.tile] : -1;
	if (tr === undefined || tr < 0) continue;
	const X = M.triggers[tr];
	if (!X || !X.tiles || !X.tiles.length) continue;
	const coinTile = (e.feat === 'coins' || e.feat === 'bcoins') ? e.tile : -1;
	const feat = e.feat, val = e.to;
	const tiles = Array.from(X.tiles);
	const mask = new Uint8Array(W * H); for (const t of tiles) mask[t] = 1;
	const test = coinTile >= 0 ? (s) => !s.is_dead && s.is_coin_collected(coinTile % W, (coinTile / W) | 0)
		: (s) => !s.is_dead && T.featValue(s, feat) === val && (mask[T.tileOf(s, W, H)] === 1 || mask[T.touchedTile(s, W, H)] === 1);
	legs.push({ i: legs.length, from: prev, to: e.tick, label: X.label, feat, goal: { test, allowDeath: false }, tiles });
	prev = e.tick;
}
{
	const g = T.goalOf(L, { kind: 'trophy' });
	legs.push({ i: legs.length, from: prev, to: ev0.complete, label: 'trophy', feat: 'silver', goal: g, tiles: Array.from(g.tiles) });
}
const B = BW.createBackward(L);
const sim = new E.EESim(L), inp = new E.EEInput();
const stateAt = (t) => { sim.reset(); for (let k = 0; k < t; k++) { E.applyMask(inp, route[k] & 31); sim.tick(inp); } return sim.snapshot(); };
const solveLeg = (snap, lg) => {
	const t0 = Date.now();
	let r = null;
	for (let i = 0; i < sched.length; i++) {
		try { r = B.solve(snap, { tiles: lg.tiles }, { ms: sched[i] }); } catch (e) { r = { ok: false, why: 'error: ' + e.message }; }
		if (r.ok || /walk|target|bug|error/.test(r.why || '')) break;
	}
	let hit = null;
	if (r && r.ok) hit = BC.hitOf(L, snap, r.masks, lg.goal);
	return { ok: !!hit, T: hit ? hit.masks.length : null, why: hit ? '' : r && r.ok ? 'goal missed' : r ? r.why : 'none', ms: Date.now() - t0, hit };
};
const S = { level: path.basename(file), runTicks: ev0.runTicks, legs: legs.length, tested: 0, route: { ok: 0, n: 0 }, chain: { ok: 0, n: 0, breaks: 0, okAfterRouteOk: 0, failAfterRouteOk: 0 }, long: { n: 0, routeOk: 0, chainOk: 0 } };
let chainSnap = stateAt(0);
for (const lg of legs.slice(0, max)) {
	const rl = lg.to - lg.from;
	const row = { i: lg.i, label: lg.label, from: lg.from, routeLeg: rl };
	const routeSnap = stateAt(lg.from);
	if (rl >= minleg) {
		S.tested++;
		if (rl >= 240) S.long.n++;
		if (modes.includes('route')) {
			const a = solveLeg(routeSnap, lg);
			row.route = [a.ok, a.T, Math.round(a.ms / 100) / 10, a.why];
			S.route.n++; if (a.ok) { S.route.ok++; if (rl >= 240) S.long.routeOk++; }
		}
		if (modes.includes('chain')) {
			const b = solveLeg(chainSnap, lg);
			row.chain = [b.ok, b.T, Math.round(b.ms / 100) / 10, b.why];
			S.chain.n++;
			if (b.ok) { S.chain.ok++; if (rl >= 240) S.long.chainOk++; if (row.route && row.route[0]) S.chain.okAfterRouteOk++; }
			else { S.chain.breaks++; if (row.route && row.route[0]) S.chain.failAfterRouteOk++; }
			if (b.ok) { sim.reset(); sim.restore(chainSnap); for (const m of b.hit.masks) { E.applyMask(inp, m & 31); sim.tick(inp); } chainSnap = sim.snapshot(); row.chainTick = null; }
			else chainSnap = stateAt(lg.to);   // (the rescue: the route's state after the event)
		}
	} else chainSnap = stateAt(lg.to);
	process.stderr.write(JSON.stringify(row) + '\n');
}
console.log(JSON.stringify(S));
