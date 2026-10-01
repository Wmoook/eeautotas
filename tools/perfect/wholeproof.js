'use strict';
// THE WHOLE-LEVEL PROOF (box 7 lane 'proof', 2026-09-30): is a route TICK-PERFECT? An exact best-first over ENGINE STATES
// from the start to the trophy (no abstraction: every input of every tick, the engine's own tick), states merged by
// sim.stateHash() (identical state = identical future; the clocks' phase, the coins, keys, switches, the queues are in
// the hash, so the TRIGGER ORDER is part of the state), cut by an ADMISSIBLE bound h (the ticks to the silver crown can
// never be fewer), in IDA* contours over the run ticks:
//   - the starts: the run timer starts at the first input, so waiting is free: S_k = the start after k idle ticks, k = 0..R
//     (R: the first k whose idle tick leaves the state as it was: the start rests), ALL at run tick 0 (layer 0). A route
//     whose first input is at tick k is a path from S_k (a route that waits longer is one from S_R: the same state);
//   - layer d = every state d run ticks after its start (each tick costs 1; an idle tick from S_k is S_(k+1), already
//     at layer 0, merged); the first layer with a crowned state is THE OPTIMUM (breadth-first, unit costs, the cut
//     admissible: no state on a path of cost <= D is ever cut);
//   - a pass with threshold D cuts a state at depth d when d + h > D and keeps the least such d + h (the next contour); a
//     pass that ends with no open state and no crown PROVES lb >= the next contour (IDA*'s rule); the passes go up the
//     contours until a crown (the optimum: it is our route's ticks = PROVEN, or fewer = a FASTER route, replayed) or the
//     threshold reaches U - 1 with no crown (U, the best route in hand, is PROVEN OPTIMAL) or the cap / clock (open: the
//     last proven lb and the gap);
//   - deaths are moves (a respawn is a teleport): kept unless --deaths=0 (then the verdict says "without deaths").
// THE BOUND h (every tier admissible; their max):
//   'rel'   bounds.js at(field(trophy, every door open)) + 1: the iso / axis / plain geometry, endgame.js's kinematic
//           envelope near the goal, portals, and a way through a death (DEATH_MIN + the field at a respawn); dead states:
//           the least respawn value;
//   'gate'  THE TRIGGER ORDER (--gate=1, default): the doors as THIS state holds them (types.js levelNow: every door a
//           touch can change as it stands now; time doors, death doors and an active key's doors open) stay so until the
//           ball's centre is in a door-changing trigger tile (model.js triggers with `relevant`: a feature some gate reads),
//           so a route either reaches the trophy under these doors (field(trophy, now)), or first reaches such a trigger
//           (field(triggers, now)) and then needs at least the least 'rel' value over the trigger tiles:
//           h_gate = min(at(f_now_trophy), at(f_now_trig) + min_t f_rel[t]) + 1. Memoized per door-reading state
//           (exact.js discKey: every value levelNow reads). Checked on the route: --check (every tick of the given
//           routes: h <= the ticks left; a violation is printed and the run stops: no proof is claimed).
//
//   node tools/perfect/wholeproof.js <level.eelvl> [--route=<ours.eetas>[,<more.eetas>]] [--U=<ticks>] [--seconds=600]
//        [--cap=4000000] [--out=<faster.eetas>] [--deaths=1] [--gate=1] [--check=1] [--json]
// Prints one JSON object: {verdict 'PROVEN' | 'FASTER' | 'OPEN' | 'UNREACHABLE' | 'unsupported' | 'violation', U (the best
// route's run ticks), opt (the optimum when found), lb (the proven lower bound on the run ticks), gap, passes, ...}.
const path = require('path');
const C = require('../../src/common.js');
const E = C.E;
const T = require('../../src/plan/types.js');
const X = require('../../src/plan/exact.js');
const EG = require('../../src/endgame.js');
const BO = require('../../src/plan/bounds.js');

const TROPHY = 121;
// (a pass stops at this share of the V8 heap limit: --max-old-space-size)
const HEAP_STOP = 0.8 * require('v8').getHeapStatistics().heap_size_limit;

/** the bound object for a level: h(sim) -> admissible ticks until has_silver_crown (Infinity: never) */
function createH(L, o = {}) {
	const W = L.width, H = L.height, N = W * H;
	const bounds = BO.createBounds(L, {});
	const trophyTiles = [];
	for (let i = 0; i < N; i++) if (L.fg[i] === TROPHY) trophyTiles.push(i);
	const fRel = bounds.field(trophyTiles, null, { touch: true });
	const st = { calls: 0, gateFields: 0, gateHits: 0, gateWins: 0 };
	let trigTiles = null, minTrig = Infinity;
	const useGate = o.gate !== false;
	if (useGate) {
		const M = require('../../src/plan/model.js').compileModel(L, {});
		const tt = [];
		for (const X0 of M.triggers) if (X0.relevant && X0.kind !== 'trophy' && X0.kind !== 'cp') for (const t of X0.tiles) tt.push(t);
		// (a killer leaves the doors' world too: a death may reset what the doors read, and a respawn is a teleport: its
		// tiles are 'triggers' here, their rel value includes the way through the death)
		for (const t of bounds.static.dsrc) tt.push(t);
		trigTiles = Array.from(new Set(tt)).sort((a, b) => a - b);
		for (const t of trigTiles) if (fRel[t] < minTrig) minTrig = fRel[t];
		st.triggers = trigTiles.length;
	}
	// the order tier's one field per door state: the trophy tiles at 0 and every door-changing trigger / killer tile t at
	// fRel[t] (bounds.js field fo.init): a route either reaches the trophy under these doors or first reaches some such t,
	// and from t needs fRel[t] more; the multi-source field is the least of both over every t (o.gateMin: the old tier,
	// the least fRel over every t for all of them)
	const gateInit = new Map();
	const gateGoals = [];
	if (useGate) {
		for (const t of trophyTiles) { gateInit.set(t, 0); gateGoals.push(t); }
		for (const t of trigTiles) if (!gateInit.has(t) && fRel[t] !== Infinity) { gateInit.set(t, fRel[t]); gateGoals.push(t); }
	}
	const gateMin = !!o.gateMin;
	const gmemo = new Map();   // discKey -> {fT, fG}
	const gateOf = (sim) => {
		const k = X.discKey(sim);
		let g = gmemo.get(k);
		if (g) { st.gateHits++; return g; }
		const Lc = T.levelNow(L, sim);
		if (!gateMin) {
			g = { fI: bounds.field(gateGoals, Lc, { touch: true, init: gateInit }), Lc };
		} else {
			const fT = bounds.field(trophyTiles, Lc, { touch: true });
			const fG = trigTiles.length ? bounds.field(trigTiles, Lc, { touch: true }) : null;
			g = { fT, fG, Lc };
		}
		st.gateFields++;
		if (gmemo.size > 4096) gmemo.delete(gmemo.keys().next().value);
		gmemo.set(k, g);
		return g;
	};
	const Wt = W, Ht = H;
	/** whether the box overlaps a tile that levelNow shuts (a door closing over the ball: its own tile is no wall to it) */
	const inShut = (sim, Lc) => {
		const x0 = Math.floor(sim.px / 16), x1 = Math.floor((sim.px + 15.999) / 16), y0 = Math.floor(sim.py / 16), y1 = Math.floor((sim.py + 15.999) / 16);
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			if (x < 0 || y < 0 || x >= Wt || y >= Ht) continue;
			const i = y * Wt + x;
			if (Lc.fg[i] === 9 && L.fg[i] !== 9) return true;
		}
		return false;
	};
	function h(sim) {
		st.calls++;
		let v = bounds.at(fRel, sim);
		if (useGate && v !== Infinity && !sim.is_dead && !inShut(sim, gateOf(sim).Lc)) {
			const g = gateOf(sim);
			let a;
			if (g.fI) a = bounds.at(g.fI, sim);
			else {
				a = bounds.at(g.fT, sim);
				if (g.fG !== null && minTrig !== Infinity) { const b = bounds.at(g.fG, sim) + minTrig; if (b < a) a = b; }
			}
			if (a > v) { v = a; st.gateWins++; }
		}
		return v === Infinity ? Infinity : v + 1;
	}
	return { h, stats: () => Object.assign({}, st, { bounds: bounds.stats() }), fRel, trophyTiles };
}

/**
 * the idle starts S_0..S_R: the idle trajectory until a state repeats (it rests: S_(R+1) = S_R, or it cycles: a moving
 * platform, a time door's phase; every later idle start is then one of these exactly), or null past `max` (4096) ticks
 */
function idleStarts(L, max = 4096) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const out = [{ k: 0, snap: sim.snapshot() }];
	const seen = new Set([sim.stateHash()]);
	for (let k = 1; k <= max; k++) {
		E.applyMask(inp, 0); sim.tick(inp);
		const h2 = sim.stateHash();
		if (seen.has(h2)) return out;
		seen.add(h2);
		out.push({ k, snap: sim.snapshot() });
	}
	return null;
}

/** the crown tick and the leading idle ticks of a route: depth = crown tick - idle (the search's measure) */
function depthOf(L, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let k = 0;
	while (k < masks.length && masks[k] === 0) k++;
	for (let n = 0; n < masks.length; n++) {
		E.applyMask(inp, masks[n]); sim.tick(inp);
		if (!sim.is_dead && sim.has_silver_crown) return { crown: n + 1, idle: k, depth: n + 1 - k };
	}
	return null;
}

/** check h along a route: h(state after t inputs) <= depth - (t - idle) for t >= idle; returns the violations */
function checkRoute(L, masks, H) {
	const d = depthOf(L, masks);
	if (!d) return { ok: false, why: 'the route gives no crown' };
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const bad = [];
	let worst = Infinity, n = 0;
	for (let t = 0; t < d.crown; t++) {
		if (t >= d.idle) {
			const left = d.crown - t;
			const hv = H.h(sim);
			n++;
			if (hv > left) bad.push({ t, h: hv, left });
			if (left - hv < worst) worst = left - hv;
		}
		E.applyMask(inp, masks[t]); sim.tick(inp);
	}
	return { ok: bad.length === 0, checked: n, bad: bad.slice(0, 10), violations: bad.length, minSlack: worst, depth: d.depth };
}

/**
 * one pass: breadth-first over run ticks with threshold D. Returns {status 'found' | 'closed' | 'cap' | 'time', depth,
 * path ({k, tail}), next (the least cut f: the next contour), stats}
 */
function pass(L, starts, H, D, o) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	const allowDeath = o.deaths !== false;
	const cap = o.cap || 4000000, deadline = o.deadline || Infinity;
	const seen = new EG.HashSet(20);
	const layers = [];
	const st = { states: 0, ticks: 0, merged: 0, cut: 0, dead: 0, maxOpen: 0, seen: 0, depth: 0 };
	let next = Infinity;
	let cur = [], curN = 0, nxt = [];
	let par = [], msk = [];
	for (let s = 0; s < starts.length; s++) {
		sim.restore(starts[s].snap);
		if (!seen.add(sim.stateHash())) { st.merged++; continue; }
		const f = H.h(sim);
		if (f > D) { st.cut++; if (f < next) next = f; continue; }
		cur[curN++] = sim.snapshot();
		par.push(-1 - s); msk.push(0);
	}
	layers[0] = { par: Int32Array.from(par), msk: Uint8Array.from(msk) };
	const t0 = Date.now();
	for (let d = 0; ; d++) {
		st.depth = d;
		if (curN === 0) { st.seen = seen.size; st.seconds = (Date.now() - t0) / 1000; return { status: 'closed', next, stats: st, layers }; }
		if (curN > st.maxOpen) st.maxOpen = curN;
		st.states += curN;
		const c = d + 1;
		par = []; msk = [];
		let n = 0, found = null;
		for (let i = 0; i < curN && found === null; i++) {
			if ((i & 255) === 0 && Date.now() > deadline) { st.seen = seen.size; st.seconds = (Date.now() - t0) / 1000; return { status: 'time', next, stats: st }; }
			// (the heap: a pass that would run out of it stops as 'mem', a claim of nothing, instead of the process dying)
			if ((i & 4095) === 0 && process.memoryUsage().heapUsed > HEAP_STOP) { st.seen = seen.size; st.seconds = (Date.now() - t0) / 1000; return { status: 'mem', next, stats: st }; }
			const masks = EG.probeMasks(sim, inp, cur[i]);
			st.ticks++;
			let noJump = 0;
			for (let k = 0; k < masks.length; k++) {
				const m = masks[k];
				if ((m & 1) && (noJump & (1 << (m & 30))) !== 0) continue;
				if (k > 0) { sim.restore(cur[i]); E.applyMask(inp, m); sim.tick(inp); st.ticks++; }
				if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
				if (sim.is_dead) { st.dead++; if (!allowDeath) continue; }
				if (!sim.is_dead && sim.has_silver_crown) { found = { layer: c, par: i, msk: m }; break; }
				if (!seen.add(sim.stateHash())) { st.merged++; continue; }
				const f = c + H.h(sim);
				if (f > D) { st.cut++; if (f < next) next = f; continue; }
				nxt[n] = sim.snapshot(nxt[n]);
				par.push(i); msk.push(m);
				n++;
				if (n > cap) { st.seen = seen.size; st.seconds = (Date.now() - t0) / 1000; return { status: 'cap', next, stats: st, open: n }; }
			}
		}
		layers[c] = { par: Int32Array.from(par), msk: Uint8Array.from(msk) };
		if (found !== null) {
			st.seen = seen.size; st.seconds = (Date.now() - t0) / 1000;
			const p = X.pathOf(layers, found.layer, found.par, found.msk, starts.map((s) => ({ tick: 0 })), 0);
			return { status: 'found', depth: c, path: { k: starts[p.start].k, tail: p.tail }, next, stats: st };
		}
		const sw = cur; cur = nxt; curN = n; nxt = sw;
	}
}

function proveLevel(L, o = {}) {
	const t0 = Date.now();
	const deadline = t0 + (o.seconds || 600) * 1000;
	const starts = idleStarts(L);
	if (!starts) return { verdict: 'unsupported', why: 'the idle start neither rests nor repeats within 4096 ticks' };
	const H = createH(L, { gate: o.gate !== false, gateMin: o.gateMin });
	// the routes in hand: U = the least depth (the run ticks: depth + delta, delta from the route's replay)
	let U = Infinity, delta = null, best = null;
	const checks = [];
	for (const r of o.routes || []) {
		const ev = C.evaluate(L, r.masks, false);
		const d = ev ? depthOf(L, ev.ms) : null;
		if (!d) { checks.push({ route: r.name, ok: false, why: 'does not finish' }); continue; }
		delta = ev.runTicks - d.depth;
		if (d.depth < U) { U = d.depth; best = { name: r.name, runTicks: ev.runTicks, deaths: ev.deaths }; }
		if (o.check !== false) {
			const ck = checkRoute(L, ev.ms, H);
			checks.push(Object.assign({ route: r.name }, ck));
			if (!ck.ok) return { verdict: 'violation', why: 'the bound is above the ticks left on a real route: no proof is claimed', checks };
		}
	}
	// (the run ticks are the depth - 1: the timer starts at the end of the first tick with an input; a U given without a
	// route takes that)
	if (delta === null) delta = -1;
	if (o.U > 0 && (o.U - delta < U || !Number.isFinite(U))) U = o.U - delta;
	let h0 = Infinity;
	{ const sim = new E.EESim(L); for (const s of starts) { sim.restore(s.snap); const v = H.h(sim); if (v < h0) h0 = v; } }
	if (h0 === Infinity) return { verdict: 'UNREACHABLE', why: 'the bound is infinite at every start', checks };
	const passes = [];
	let lb = h0, D = h0, verdict = 'OPEN', opt = null, faster = null;
	const top = Number.isFinite(U) ? U - 1 : (o.maxD || 4000);
	for (;;) {
		if (D > top) { if (Number.isFinite(U)) { verdict = 'PROVEN'; opt = U; lb = U; } break; }
		const r = pass(L, starts, H, D, { cap: o.cap, deadline, deaths: o.deaths !== false });
		passes.push({ D, status: r.status, states: r.stats.states, seen: r.stats.seen, maxOpen: r.stats.maxOpen, cut: r.stats.cut, merged: r.stats.merged, dead: r.stats.dead, s: r.stats.seconds, next: r.next });
		if (o.onPass) o.onPass({ D: D + (delta === null ? -1 : delta), status: r.status, lb: (r.status === 'closed' ? r.next : lb) + (delta === null ? -1 : delta), states: r.stats.states, s: r.stats.seconds, t: (Date.now() - t0) / 1000 });
		if (r.status === 'found') {
			const cand = T.concat(new Uint8Array(r.path.k), r.path.tail);
			const ev = C.evaluate(L, cand, false);
			opt = r.depth; lb = r.depth;
			if (ev) faster = { masks: ev.ms, runTicks: ev.runTicks, deaths: ev.deaths, depth: r.depth };
			verdict = Number.isFinite(U) && r.depth < U ? 'FASTER' : 'PROVEN';
			if (!Number.isFinite(U)) U = r.depth;
			break;
		}
		if (r.status !== 'closed') { verdict = 'OPEN'; break; }
		if (r.next === Infinity) { verdict = Number.isFinite(U) ? 'PROVEN' : 'UNREACHABLE'; lb = Number.isFinite(U) ? U : Infinity; opt = Number.isFinite(U) ? U : null; break; }
		lb = r.next;
		D = r.next;
	}
	const dl = delta;
	const out = { verdict, deaths: o.deaths !== false, gate: o.gate !== false, U: Number.isFinite(U) ? U + dl : null, best, opt: opt !== null ? opt + dl : null,
		lb: Number.isFinite(lb) ? lb + dl : lb, h0: h0 + dl, gap: Number.isFinite(U) && Number.isFinite(lb) ? U - lb : null, delta: dl, restIdle: starts.length - 1,
		passes, checks, hstats: H.stats(), seconds: (Date.now() - t0) / 1000 };
	if (faster) out.faster = faster;
	return out;
}

if (require.main === module) {
	const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? '1' : m[2]]; }));
	const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
	const L = T.loadLevelFile(pos[0]);
	const routes = argv.route ? argv.route.split(',').filter(Boolean).map((f) => ({ name: path.basename(f), masks: C.readEetas(f) })) : [];
	const onPass = (p) => console.log('PASS ' + JSON.stringify(p));
	const r = proveLevel(L, { routes, U: +argv.U || 0, seconds: +argv.seconds || 600, cap: +argv.cap || 4000000, deaths: argv.deaths !== '0', gate: argv.gate !== '0', gateMin: argv.gateMin === '1', check: argv.check !== '0', onPass });
	if (r.faster && argv.out) C.writeEetas(path.resolve(argv.out), r.faster.masks);
	const o2 = Object.assign({ level: path.basename(pos[0]) }, r);
	if (o2.faster) o2.faster = { runTicks: r.faster.runTicks, deaths: r.faster.deaths, depth: r.faster.depth, written: !!argv.out };
	console.log(JSON.stringify(o2));
}
module.exports = { proveLevel, createH, idleStarts, depthOf, checkRoute, pass };
