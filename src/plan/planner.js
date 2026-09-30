'use strict';
// THE ABSTRACT PLANNER (n4plan, part 'planner': the compiler's PLAN stage and the CEGAR loop's planning side).
// createPlanner(model, facts, {bounds, seed}) -> {plan, learn, lowerBound, costOf, explain, stats}.
//
// The abstract graph: a node = (S, position): S the model's abstract state (the features some gate reads, the coin tiles
// taken, the checkpoint where a death moves the ball), the position the tiles of the last trigger touched (or the
// anchor's tile; the respawn after a death step). Edges: "touch trigger X next" for every relevant trigger whose touch
// changes S and that the lb walk relaxation under S reaches from the position (the walk BFS: killers and one-ways
// passable, keys sticky, portal hops, the death shortcut: its INF is a proof for the relaxation, so no edge is dropped
// without one); the trophy edge; a death step where only a death reaches a target (est).
//   - est (the plans' ranking): facts.okTicks when learned, else max(lb, est walk steps x the pace (the median of the
//     learned ticks / steps, 4 at first)); the est walk walls killers unless protected and the CEGAR cuts; an edge only
//     the relaxation reaches, or that RCH3 calls impossible from the position at rest or rising (verifyPath), a heavy
//     penalty (never a drop; RCH3's -1 from the anchor's REAL state: a proof, dropped). The plans: weighted A* on est
//     (k-best, diverse by the first step), greedy on the level's LANDMARKS in a puzzle (3+ left: LAMA's greedy best
//     first), a one-step partial plan at least whatever the budget.
//   - lb: ADMISSIBLE ticks (model.pairLb: ceil(16 (D - 1) / 16.25) of the lb walk steps D, a portal hop's entry step
//     free, the death shortcut to the respawn the state holds; o.bounds.pair where no death can shortcut and no coin
//     gate, the larger of both). A touch that shuts a gate the ball overlaps is DEFERRED by the engine: the next leg
//     starts from its deferral region (posOf). lowerBound(anchor): A* on lb, h = the same bound on the level with every
//     gate open (admissible; nodes re-opened on a better g), the optimum when it completes, else the least f on the open
//     list; an anchor with a change still queued is bounded from the state it will be (model.pendingOf).
//   - B&B: plan(anchor, {depth}) drops every node whose lb to the trophy puts it at depth or past.
// Waypoints (types.js): a trigger -> {kind 'trigger', tiles (a coin trigger's untaken tiles), trig, expect, label}; the
// trophy -> {kind 'trophy'}; a key followed by its door -> a region step past the door (beforeTickFrom 'prev+500', or
// beforeTick when the key is the anchor's own); a death step -> {kind 'region', tiles: the respawn tiles, expect deaths +
// 1, allowDeath}.
// learn(step, result, anchor) -> Fact[] (>= 1, the version bumped, whenever !result.ok): fail -> the next rung; the
// facts' rungs -> block; why 'proof' -> proof (never from that S again); blockedBy -> needs (the gate's feature first);
// a failure at its second rung or exhausted with a closest approach -> a CUT of the est walk just past it (the next plans
// go another way: Cold World's pool); ok -> ok (the edge's ticks, the pace).
const E = require('../eesim.js');
const T = require('./types.js');
const { lbOfSteps, INF, DEAD_TICKS } = require('./model.js');

const PACE0 = 4;              // est ticks per walk step before any learned leg
const EST_W = 1.5;            // the plan search's heuristic weight (est only; the lb search is plain A*)
const PENALTY = 1e6;          // est of an edge only the relaxation reaches (no est walk) or RCH3 calls impossible
const LM_W = 60;              // ticks of the plan search's f per landmark not yet achieved (src/landmarks.js, LAMA's count)
const GAIN_BONUS = 3;         // walk steps of the plan search's f per unit of gain (the relevant triggers achieved)
const KEY_TICKS = 500;
// the diversification rule (nearPlans): one-step plans to the nearest untried triggers once every plan's first leg
// failed its rung; DEFAULT 1 since COMPILE-ALL block 3 lane 4 (with the executor's true skeleton closest,
// EEAT_SKEL_CLOSEST): EEAT_PLAN_NEAR=K (K near plans; 0: off, the planner as before)
const NEAR_K = process.env.EEAT_PLAN_NEAR !== undefined ? Math.max(0, +process.env.EEAT_PLAN_NEAR | 0) : 1;
const NEAR_RUNG = process.env.EEAT_NEAR_RUNG !== '0';   // (the rung balance of the near plans: nearPlans; EEAT_NEAR_RUNG=0 off)
// the floor probe's time (steer.js buildSteer on a level with count gates: the plan the steer's physics layers walk, run
// again with the gates the model leaves open as floors; env EEAT_PLAN_FLOOR=0: off)
const FLOOR_MS = +process.env.EEAT_PLAN_FLOOR_MS || 8000;
// (and its layers: the steer build grows its layer product a feature at a time and checks its clock only between
// features, so a switch maze (23_4 Switcher Puzzle: 14 switches, 224 layers) took 61.6 s against the 8 s asked, in the
// bounds stage, 51 s of a 60-s compile; the floors found so far need 6-20 layers: Aedan Garden 11, MoonBase 7, Rotcil
// Illusions 6, Springopolis 20; at 32 layers Switcher Puzzle stops at its cap)
const FLOOR_LAYERS = +process.env.EEAT_PLAN_FLOOR_LAYERS || 32;
// (off the critical path, o.floorAsync (the strategy's): the probe in a worker thread (src/plan/floorworker.js), the plans
// made before its answer without floors, the floors added when it answers (floorVersion() bumps: the strategy's plan memo
// re-plans); a probe still running at FLOOR_HARD_MS of wall time is terminated (no floors). The profile (lane 6, box 3):
// the probe was 8-45 s of the bounds stage on 13 of the 14 STAGE-TIME levels (MKco Mushroom Cup 45 s: 5 purple switches'
// 40 layers, 255 physics fields, no floor found; Dreamland 40 s, VVVVVV 37 s), where the floors it finds took 1.9-6.3 s
// (Tropical Trials' coins >= 20: 25-30 s on the loaded box, so the cap is 30 s)
const FLOOR_HARD_MS = +process.env.EEAT_PLAN_FLOOR_HARD_MS || 30000;
const COUNT_GATES = new Set([165, 214]);
const COLOURS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];

/** a heap on f (then g) */
class Heap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
	pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && Heap.lt(a[l], a[m])) m = l; if (r < a.length && Heap.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
	peek() { return this.a[0]; }
	static lt(x, y) { return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.seq < y.seq))); }
}

function createPlanner(model, facts, o = {}) {
	const L = model.L, W = model.W, H = model.H;
	const bounds = o.bounds && typeof o.bounds.pair === 'function' ? o.bounds : null;
	const ST = { rchChecks: 0, plans: 0, planMs: 0, expands: 0, lbCalls: 0, lbMs: 0, lbExpands: 0, learned: 0, costOf: 0 };
	const paceSamples = [];
	let lastPlans = [], lastWhy = '';
	const relevant = model.triggers.filter((X) => X.relevant && X.kind !== 'trophy' && !X.crumb);
	// (the crumbs: coins no gate reads, relevant only with EEAT_CRUMBS=1 (model.js); left out of the plan search, offered
	// one at a time by crumbPlan)
	const crumbs = model.triggers.filter((X) => X.relevant && X.crumb);
	const trophyTiles = model.trophyTiles;
	const openS = { key: '__open__', dkey: '__open__', vals: [], feats: {} };
	// ---------------------------------------------------------------- floors (a count gate the way STANDS on)
	// The est walk is 8-way and gravity-blind: a coin gate (165 / blue 214, solid from its count on) is a wall in it, never
	// the floor a jump needs, and below its count it is air, so no plan collected the coins that make it solid first
	// (Springopolis, Aedan Garden, MoonBase, Rotcil Illusions: the trophy only from a count gate; the plan went straight to
	// the trophy, est 68 / 556 / 492 / 384 ticks, and every leg ran out of its budget). steer.js's floor probe (buildSteer:
	// its layered physics plan replayed with those gates as floors, a jump whose only support is such a gate names it)
	// gives the count; the trophy edge from a state below it gets the PENALTY (a price, never a drop: the probe is no proof)
	const floorNeeds = [];
	let floorVer = 0;
	// THE FLOOR'S ZONE (lane 4 b4): the probe names the floor the TROPHY's jump needs, and a trigger beside the trophy above
	// the same floor needs it as much: Nightmare Relics' trophy (98,132) is reached only from its 4-coin gate (98,136) (the
	// room's floor 6 rows down, a 3-row jump from the gate), and its protection effect (100,132) stands in the same room at
	// the same height: every PARTIAL plan went there first ("protection on (100,132)" 21 of 25 steps, closest 2 tiles,
	// 'budget' at every rung), the 4 coins never planned. A floor's zone: the tiles a jump from the probe's jump tile
	// (x.from) can reach above its support (x.at below it: gravity down; above it: up; beside it: no zone), within
	// FLOOR_ZX tiles across and FLOOR_ZY tiles up, kept only when the trophy is in it; a trigger edge whose live tiles all
	// lie in a zone gets the floor's need (the PENALTY, a price, never a drop, as the trophy's). EEAT_FLOOR_ZONE=0 off.
	const FLOOR_ZONE = process.env.EEAT_FLOOR_ZONE !== '0';
	const FLOOR_ZX = +process.env.EEAT_FLOOR_ZX || 4, FLOOR_ZY = +process.env.EEAT_FLOOR_ZY || 4;
	const zoneOf = (x) => {
		if (!FLOOR_ZONE || !x || !Array.isArray(x.at) || !Array.isArray(x.from) || !L || !L.fg) return null;
		const [ax, ay] = x.at, [fx, fy] = x.from;
		const up = ay > fy ? 1 : ay < fy ? -1 : 0;
		if (up === 0) return null;
		const z = new Uint8Array(W * H);
		for (let dy = 0; dy <= FLOOR_ZY; dy++) {
			const y = fy - up * dy;
			if (y < 0 || y >= H) continue;
			for (let xx = Math.max(0, fx - FLOOR_ZX); xx <= Math.min(W - 1, fx + FLOOR_ZX); xx++) z[y * W + xx] = 1;
		}
		for (const t of trophyTiles) if (z[t]) return z;
		return null;
	};
	/** the probe's floors (steer.js info.floors) -> floorNeeds: the most each count feature needs (and its zones) */
	const setFloors = (fl) => {
		const most = new Map(), zones = new Map();
		for (const x of fl || []) {
			if (!((x.feat === 'coins' || x.feat === 'bcoins') && x.param > 0 && model.feats.includes(x.feat))) continue;
			most.set(x.feat, Math.max(most.get(x.feat) || 0, x.param));
			const z = zoneOf(x);
			if (z) { if (!zones.has(x.feat)) zones.set(x.feat, []); zones.get(x.feat).push({ z, min: x.param }); }
		}
		floorNeeds.length = 0;
		for (const [feat, min] of most) floorNeeds.push({ feat, min, zones: zones.get(feat) || [] });
		ST.floors = floorNeeds.map((n) => `${n.feat}>=${n.min}${n.zones.length ? `(zones ${n.zones.length})` : ''}`).join(' ') || '';
		if (floorNeeds.length) floorVer++;
	};
	/** a trigger edge's floor need: its live tiles all in a zone of a floor whose count S has not reached */
	const zoneNeed = (S, tiles) => {
		for (const n of floorNeeds) {
			if (!n.zones.length) continue;
			const have = S.feats[n.feat] || 0;
			for (const q of n.zones) {
				if (have >= q.min) continue;
				let all = tiles.length > 0;
				for (const t of tiles) if (!q.z[t]) { all = false; break; }
				if (all) return true;
			}
		}
		return false;
	};
	if (process.env.EEAT_PLAN_FLOOR !== '0' && L && L.fg) {
		let has = false;
		for (let i = 0; i < L.fg.length && !has; i++) if (COUNT_GATES.has(L.fg[i])) has = true;
		if (has && model.feats && (model.feats.includes('coins') || model.feats.includes('bcoins'))) {
			const tf = Date.now();
			let started = false;
			if (o.floorAsync) {
				try {
					const { Worker } = require('worker_threads');
					const wd = { maxMs: FLOOR_MS, maxLayers: FLOOR_LAYERS };
					if (o.file) wd.file = require('path').resolve(String(o.file)); else wd.L = L;
					const w = new Worker(require('path').join(__dirname, 'floorworker.js'), { workerData: wd });
					ST.floorProbe = 'running';
					const hard = setTimeout(() => { if (ST.floorProbe === 'running') { ST.floorProbe = 'cut'; ST.floorMs = Date.now() - tf; } w.terminate().catch(() => {}); }, FLOOR_HARD_MS);
					if (hard.unref) hard.unref();
					w.on('message', (m) => {
						if (ST.floorProbe !== 'running') return;
						ST.floorProbe = m && m.error ? 'error' : 'done'; ST.floorMs = Date.now() - tf;
						if (m && !m.error) setFloors(m.floors);
						clearTimeout(hard); w.terminate().catch(() => {});
					});
					w.on('error', () => { if (ST.floorProbe === 'running') { ST.floorProbe = 'error'; ST.floorMs = Date.now() - tf; } clearTimeout(hard); });
					w.unref();
					started = true;
				} catch (e) { started = false; }
			}
			if (!started) {
				try {
					const st = require('../steer.js').buildSteer(L, { maxMs: FLOOR_MS, noDP: true, maxLayers: FLOOR_LAYERS });
					setFloors((st && st.info && st.info.floors) || []);
				} catch (e) { /* the probe is optional */ }
				ST.floorMs = Date.now() - tf;
			}
		}
	}
	ST.floors = floorNeeds.map((n) => `${n.feat}>=${n.min}${n.zones && n.zones.length ? `(zones ${n.zones.length})` : ''}`).join(' ') || '';
	// ---------------------------------------------------------------- positions
	const posOfTrig = new Map();
	/**
	 * the position after touching X in state S1 (the state before) giving S2. The engine DEFERS a change that would shut a
	 * door on the ball (a purple press in _tileQueue, a key / crown / orange switch in its queue, a team change retried)
	 * while the ball's box overlaps it, so the change's event can come later and elsewhere (The Flighty Slighty's switch
	 * column: each press shuts the door the ball falls through; First Person Maze: a press deferred through a portal hop).
	 * tiles: X's (the plan's waypoint, the est walk); grace: the shut gate components next to X, passable for the next leg;
	 * lbTiles (the lb's sources): X's tiles, and where the touch shuts a gate, the DEFERRAL REGION: the tiles within a tile
	 * of a gate it shuts reachable from X under S1 (portal hops included) and the tiles next to them (where the ball stops
	 * overlapping): every place the event can happen, so the next leg's bound stays sound
	 */
	const graceMemo = new Map();
	/** deferral(tiles, S1, S2) -> {grace, lbTiles, nShut} | null: the grace gates next to the tiles and the deferral region
	 *  of the change S1 -> S2 made there (null: it shuts no gate) */
	const shutMemo = new Map();
	/** the gate components the change S1 -> S2 shuts and the tiles within one of them (by the pass keys; null: none) */
	function shutOf(S1, S2) {
		const k = S1.pkey + '>' + S2.pkey;
		let r = shutMemo.get(k);
		if (r !== undefined) return r;
		r = null;
		for (const g of model.gates) {
			const j = g.tiles[0];
			if (!(model.gateOpen(j, S1, 'est', null) && !model.gateOpen(j, S2, 'est', null))) continue;
			if (!r) r = { near: new Uint8Array(model.N), gates: new Set(), nShut: 0 };
			r.gates.add(g.id);
			for (const t of g.tiles) {
				r.nShut++;
				const x = t % W, y = (t / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) r.near[ny * W + nx] = 1; }
			}
		}
		if (shutMemo.size > 4096) shutMemo.clear();
		shutMemo.set(k, r);
		return r;
	}
	function deferral(tiles, S1, S2) {
		const sh = shutOf(S1, S2);
		if (!sh) return null;
		const near = sh.near;
		let grace = null;
		const gs = new Set();
		for (const t of tiles) {
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const g = model.gateOf[ny * W + nx];
				if (g < 0 || gs.has(g)) continue;
				gs.add(g);
				if (sh.gates.has(g)) { if (!grace) grace = []; for (const tt of model.gates[g].tiles) grace.push(tt); }
			}
		}
		// the deferral region: a flood over the passable tiles (S1, lb) within one of a shut gate, seeded by the tiles and
		// the tiles next to them (the ball's box over them overlaps those, and it moves on while the change waits; First
		// Person Maze's press takes effect one portal hop later); out: the region and the tiles next to it (sparse sets)
		const m1 = model.passMask(S1, 'lb', null);
		const inR = new Set(), out = new Set(tiles), q = [];
		const ok = (j) => m1[j] === 1;   // (a shut gate of another feature is no way: only the tiles passable under S1)
		for (const t of tiles) {
			if (near[t] && !inR.has(t)) { inR.add(t); q.push(t); }
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (!ok(j)) continue;
				out.add(j);
				if (near[j] && !inR.has(j)) { inR.add(j); q.push(j); }
			}
		}
		while (q.length) {
			const c = q.pop(), x = c % W, y = (c / W) | 0;
			const visit = (j) => { if (!ok(j)) return; out.add(j); if (near[j] && !inR.has(j)) { inR.add(j); q.push(j); } };
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) visit(ny * W + nx); }
			const ex = model.A.portalExits.get(c);
			if (ex) for (const e of ex) visit(e);
		}
		const lbTiles = [...out].sort((p, q2) => p - q2);
		return { grace, lbTiles: lbTiles.length > tiles.length ? lbTiles : null, nShut: sh.nShut };
	}
	const posOf = (X, S1, S2) => {
		let rec = null;
		if (S1 && S2 && S1.pkey !== S2.pkey) {
			const gk = X.id + '|' + S1.pkey + '|' + S2.pkey;
			rec = graceMemo.get(gk);
			if (rec === undefined) {
				rec = deferral(X.tiles, S1, S2);
				if (graceMemo.size > 100000) graceMemo.clear();
				graceMemo.set(gk, rec);
			}
		}
		const grace = rec ? rec.grace : null, lbTiles = rec ? rec.lbTiles : null;
		const id = 't' + X.id + (grace ? '~' + grace[0] + ':' + grace.length : '') + (lbTiles ? '^' + lbTiles[0] + ':' + lbTiles.length + ':' + lbTiles[lbTiles.length - 1] : '');
		let p = posOfTrig.get(id);
		if (!p) { p = { id, tiles: X.tiles, trig: X.id, extra: 0, grace, lbTiles }; posOfTrig.set(id, p); }
		return p;
	};
	const respawnPos = { id: 'respawn', tiles: model.respawn, extra: DEAD_TICKS };
	const idlePos = { id: 'idle', tiles: model.idleTiles, extra: 0 };
	// the fully open level (every tile but the static walls): the heuristics
	let openMask = null;
	const openDist = new Map();
	const openOf = () => { if (!openMask) { openMask = new Uint8Array(model.N); for (let i = 0; i < model.N; i++) openMask[i] = model.A.cls[i] !== 0 ? 1 : 0; } return openMask; };
	// (the open level's walks backwards from the trophy and from the killing tiles (model.revDist): the same numbers as one
	// bfs per position (min over the goals), one search for every position; EEAT_PLAN_REVH=0: a bfs per position, as before:
	// Moving Ice Puzzle's root has 3,346 trigger positions, 16.7 s of bfs in its first lowerBound expansion, Cold World's 568
	// most of its first plan's 3.9 s)
	const REVH = process.env.EEAT_PLAN_REVH !== '0' && typeof model.revDist === 'function';
	let revTro = null, revDie = null;
	const hsMemo = new Map();
	const revMin = (R, tiles) => { let b = INF; for (const c of model.hopClosure(openOf(), tiles)) if (R[c] < b) b = R[c]; return b; };
	function hSteps(pos) {
		if (REVH) {
			let h = hsMemo.get(pos.id);
			if (h === undefined) { if (!revTro) revTro = model.revDist(openOf(), trophyTiles); h = revMin(revTro, pos.tiles); hsMemo.set(pos.id, h); }
			return h;
		}
		let d = openDist.get(pos.id);
		if (!d) {
			d = model.bfs(openOf(), pos.tiles);
			openDist.set(pos.id, d);
		}
		let b = INF;
		for (const t of trophyTiles) if (d[t] < b) b = d[t];
		return b;
	}
	/** the open level's walk steps from pos to the nearest tile the ball can die in */
	function dieSteps(pos) {
		if (REVH) {
			if (!revDie) { const g = []; for (let i = 0; i < model.N; i++) if (model.dieTile[i]) g.push(i); revDie = model.revDist(openOf(), g); }
			return revMin(revDie, pos.tiles);
		}
		hSteps(pos);
		const d = openDist.get(pos.id);
		let dk = INF;
		for (let i = 0; i < model.N; i++) if (model.dieTile[i] && d[i] < dk) dk = d[i];
		return dk;
	}
	let openResp = null;
	const hMemo = new Map(), hdMemo = new Map();
	/** the est walk steps from pos to the trophy on the open level, the death shortcut included (a death and a respawn
	 *  where no walk reaches the trophy: hSteps alone is INF there, and INF x pace became a partial plan's est of ~4.3e9:
	 *  The Square). The partial plans' cost only: the plan search's f keeps hSteps (with this in f The Square's first plan
	 *  reached the trophy, 9 steps, but Stupid Fox's first plan changed and lost its progress in the shared gate) */
	function hStepsD(pos) {
		const had = hdMemo.get(pos.id);
		if (had !== undefined) return had;
		let best = hSteps(pos);
		if (model.canDie) {
			const dk = dieSteps(pos);
			if (dk < INF) {
				if (openResp === null) openResp = hSteps(respawnPos);
				if (openResp < INF) best = Math.min(best, dk + openResp + Math.ceil(DEAD_TICKS / PACE0));
			}
		}
		hdMemo.set(pos.id, best);
		return best;
	}
	/** the admissible ticks from pos to the trophy on the open level (the death shortcut included) */
	function hLb(pos) {
		const had = hMemo.get(pos.id);
		if (had !== undefined) return had;
		let best = lbOfSteps(hSteps(pos));
		if (model.canDie) {
			const dk = dieSteps(pos);
			if (dk < INF) {
				if (openResp === null) openResp = hSteps(respawnPos);
				if (openResp < INF) best = Math.min(best, lbOfSteps(dk) + DEAD_TICKS + lbOfSteps(openResp));
			}
		}
		best += pos.extra || 0;
		hMemo.set(pos.id, best);
		return best;
	}
	// ---------------------------------------------------------------- landmarks (the plan search's guide)
	// the level's landmarks (src/landmarks.js: the relaxed planning graph over its triggers from the start; a fact every
	// relaxed plan needs): the plan search's f counts the ones the state does not hold (ordering only, est; the lb and the
	// proofs never read them)
	let LMS = null;
	function landmarks() {
		if (LMS) return LMS;
		LMS = [];
		try {
			const lm = require('../landmarks.js').landmarksOf(L, { maxMs: o.lmMs || 1500 });
			for (const l of lm.landmarks) {
				const fct = l.f;
				if (fct.startsWith('coins>=')) LMS.push((S) => (S.feats.coins !== undefined ? S.feats.coins >= +fct.slice(7) : true));
				else if (fct.startsWith('bcoins>=')) LMS.push((S) => (S.feats.bcoins !== undefined ? S.feats.bcoins >= +fct.slice(8) : true));
				else if (fct.startsWith('team=')) LMS.push((S) => S.feats.team === undefined || S.feats.team === +fct.slice(5));
				else if (fct === 'crown') LMS.push((S) => S.feats.crown === undefined || S.feats.crown === 1);
				else LMS.push((S) => S.feats[fct] === undefined || S.feats[fct] === 1);
			}
			ST.landmarks = LMS.length;
		} catch (e) { LMS = []; }
		return LMS;
	}
	const lmMemo = new Map();
	function hLM(S) {
		let h = lmMemo.get(S.key);
		if (h !== undefined) return h;
		h = 0;
		for (const t of landmarks()) if (!t(S)) h++;
		if (lmMemo.size > 200000) lmMemo.clear();
		lmMemo.set(S.key, h);
		return h;
	}
	const pace = () => {
		if (!paceSamples.length) return PACE0;
		const s = paceSamples.slice().sort((a, b) => a - b);
		return Math.max(1, s[s.length >> 1]);
	};
	// ---------------------------------------------------------------- the anchor
	function anchorOf(anchor) {
		anchor = anchor || {};
		const arr = anchor.arrival || null;
		// (the anchor's real state: its snapshot when it restores to the arrival's own state hash (the same level object),
		// else a replay of its masks)
		let sim = null;
		if (arr && arr.masks && arr.masks.length) {
			if (arr.snap) { try { const s1 = new E.EESim(L); s1.reset(); s1.restore(arr.snap); if (arr.hash === undefined || s1.stateHash() === arr.hash) sim = s1; } catch (e) { sim = null; } }
			if (!sim) sim = T.playTo(L, arr.masks, { allowDeath: true }).sim;
		} else { sim = new E.EESim(L); sim.reset(); }
		let S = anchor.S || model.stateOf(sim);
		const masks = arr && arr.masks ? arr.masks : new Uint8Array(0);
		let idle = true;
		for (let i = 0; i < masks.length; i++) if (masks[i] & 31) { idle = false; break; }
		const tile = arr && arr.tile !== undefined ? arr.tile : model.startTile;
		let pos = idle ? idlePos : { id: 'a' + tile, tiles: [tile], extra: 0 };
		// (a change the engine still holds in a queue: the state it will be, the gates it shuts passable until then and
		// the deferral region as the lb's sources: the anchor's lb stays sound right after a deferred press)
		const Sp = sim ? model.pendingOf(sim, S) : null;
		if (Sp && Sp.key !== S.key) {
			const rec = deferral(pos.tiles, S, Sp);
			pos = { id: pos.id + 'p' + Sp.dkey.length + ':' + (rec && rec.lbTiles ? rec.lbTiles.length : 0), tiles: pos.tiles, extra: 0, grace: rec ? rec.grace : null, lbTiles: rec ? rec.lbTiles : null };
			S = Sp;
		}
		// (an anchor the strategy keeps apart by the trigger edge it was re-entered by (strategy addArrival): its facts too)
		const cls = (arr ? `${Math.round(arr.vx || 0)},${arr.onGround ? 1 : 0}` : '0,1') + (anchor.qual ? `@${anchor.qual}` : '');
		// (the lb's base: the counts the coin / blue coin / death GATES read: the engine's _show_* copies, which lag the
		// live counts by >= 1 tick and freeze while the ball overlaps a gate; the least of the copy and the count)
		const live = (k) => (S.feats[k] !== undefined ? S.feats[k] : 0);
		const base = { coins: live('coins'), bcoins: live('bcoins'), deaths: live('deaths') };
		if (sim) { base.coins = Math.min(base.coins, sim._show_coin_gate | 0); base.bcoins = Math.min(base.bcoins, sim._show_blue_coin_gate | 0); base.deaths = Math.min(base.deaths, sim._show_death_gate | 0); }
		return { S, pos, tick: arr ? arr.tick || 0 : 0, idle, cls, base, sim, arr };
	}
	// ---------------------------------------------------------------- edges
	const hasCG = model.hasCoinGate.coins || model.hasCoinGate.bcoins;
	const useBounds = !!bounds && !model.canDie && !hasCG;
	// (the primitives' bound per edge is a Dijkstra field per (target, door state): ~0.35 s each on a 400 x 200 level, and
	// a node's edges are every relevant trigger (26_2 Terror In The North: 172 coins, 60 s for the root's edges alone, past
	// the compile's watchdog). A new field only while the calling search is inside its own budget (pairUntil), a memoized
	// one always; else the tier-0 bound alone: both admissible, their max only tighter)
	let pairUntil = Infinity;
	const pairOK = (tiles, lvl) => Date.now() < pairUntil || (typeof bounds.hasField === 'function' && bounds.hasField(tiles, lvl));
	/** the physics check's memo: (door key, position, edge) -> true when RCH3 is -1 from every tile of the position at
	 *  rest and rising at the most (a heavy est penalty in the plan search, never a drop: an abstract position is no real
	 *  state); 'proof' from the anchor's real state (then the edge is dropped at the root: an exact proof) */
	const rchBad = new Map();
	// (a PROOF is keyed by the abstract state AND the position it was proven from: the executor's proof is "the goal field
	// of the level as the doors stand is -1 at every START", a fact about where the ball is (a one-way drop, a portal, a
	// pocket), so it blocks the edge from that (state, position) only, not from every node of the state: the re-entry
	// anchors (a class re-entered by another trigger) and the child nodes at other positions keep the edge.
	// EEAT_PROOF_POS=0: keyed by the state alone, as before)
	const PROOF_POS = process.env.EEAT_PROOF_POS !== '0';
	const proofKey = (S, pos) => (PROOF_POS && pos && pos.id !== undefined ? S.key + '@' + pos.id : S.key);
	const rchKey = (S, pos, edge) => S.pkey + '|' + pos.id + '|' + edge;
	/**
	 * the edges of node (S, pos): [{X (null: the trophy), S2, pos2, expect, lb, est, steps, viaDeath, edge, live}]. The
	 * lb reachability (the walk relaxation: killers passable, keys sticky, the death shortcut) keeps an edge; mode 'plan'
	 * prices it by the est walk (killers walls unless protected; a death step where only a death reaches it; a heavy
	 * penalty where only the relaxation reaches it) and applies the facts (blocks, proofs, needs, learned ticks)
	 */
	function edgesOf(S, pos, base, mode, root, rootCls, only) {
		const out = [];
		const P = pace();
		const extra = pos.extra || 0;
		const dL = model.dist(S, pos, 'lb', base), dvL = model.deathVia(S, pos, 'lb', base);
		const wantEst = mode === 'plan';
		const dE = wantEst ? model.dist(S, pos, 'est', base) : null, dvE = wantEst ? model.deathVia(S, pos, 'est', base) : null;
		const cls = root ? rootCls : S.key + '|*';
		const leg = (tiles) => {
			let sL = INF, rL = INF, sE = INF, rE = INF;
			const drL = dvL ? dvL.dr : null, drE = dvE ? dvE.dr : null;
			for (const t of tiles) {
				if (dL[t] < sL) sL = dL[t];
				if (drL && drL[t] < rL) rL = drL[t];
				if (dE) { if (dE[t] < sE) sE = dE[t]; if (drE && drE[t] < rE) rE = drE[t]; }
			}
			let lb = lbOfSteps(sL);
			if (drL && rL < INF) lb = Math.min(lb, lbOfSteps(dvL.dk) + DEAD_TICKS + lbOfSteps(rL));
			if (!Number.isFinite(lb)) return null;
			lb += extra;
			if (useBounds) { try { const lvl = model.levelOf(S); if (pairOK(tiles, lvl)) { const bb = bounds.pair(pos.tiles, tiles, lvl); if (Number.isFinite(bb)) lb = Math.max(lb, bb + extra); } } catch (e) { /* the tier-0 bound */ } }
			let est = lb, steps = sL, viaDeath = false, relaxOnly = false;
			if (wantEst) {
				if (sE < INF) { est = sE * P + extra; steps = sE; }
				else if (drE && rE < INF) { est = (dvE.dk + rE) * P + DEAD_TICKS + extra; steps = dvE.dk + rE; viaDeath = true; }
				else {
					// (only the relaxation reaches it: its walk, else its death shortcut; sL is INF when only the lb's
					// death way reaches it, and INF x pace overflowed the plan's est to ~4.3e9: The Square)
					const sR = sL < INF ? sL : drL && rL < INF ? dvL.dk + rL : INF;
					est = (sR < INF ? sR * P * 3 + (sL < INF ? 0 : DEAD_TICKS) : 0) + PENALTY + extra; relaxOnly = true;
				}
				est = Math.max(lb, est);
			}
			// (pen: which penalty priced the edge, a diagnostic for the plan's steps: 'relax' (only the relaxation reaches
			// it), 'rch' (RCH3 -1 at rest / rising), 'floor' / 'zone' (a count floor not reached))
			return { lb, est, steps, viaDeath, relaxOnly, pen: relaxOnly ? 'relax' : '' };
		};
		const finish = (X, tiles, edge, tr) => {
			const g = leg(tiles);
			if (!g) return;
			if (wantEst) {
				if (facts) {
					if (facts.blocked(edge, cls, proofKey(S, pos))) return;
					if (facts.needsOf(edge, cls).some((n) => S.feats[n.feat] !== n.value)) return;
					const ok = facts.okTicks(edge, cls);
					if (ok !== undefined) { g.est = Math.max(g.lb, ok); g.pen = ''; }
				}
				if (X === null) { for (const n of floorNeeds) if (!((S.feats[n.feat] || 0) >= n.min)) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'floor'; break; } }
				else if (floorNeeds.length && zoneNeed(S, tiles)) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'zone'; }
				const bad = rchBad.get(rchKey(S, pos, edge));
				if (bad === 'proof' && root) return;
				if (bad) { g.est += PENALTY; g.pen = (g.pen ? g.pen + '+' : '') + 'rch'; }
			}
			out.push({ X, S2: tr ? tr.S2 : S, pos2: X ? posOf(X, S, tr ? tr.S2 : S) : null, expect: tr ? tr.expect : null, lb: g.lb, est: g.est, steps: g.steps, viaDeath: g.viaDeath, relaxOnly: g.relaxOnly, pen: g.pen || '', edge, live: tiles });
		};
		for (const X of (only || relevant)) {
			if (pos.trig === X.id && !(X.kind === 'psw' || X.kind === 'osw')) continue;
			const live = model.liveTiles(S, X);
			if (!live.length) continue;
			// (reachable first: the touch builds a state)
			let sL = INF;
			for (const t of live) if (dL[t] < sL) sL = dL[t];
			if (sL >= INF && !dvL) continue;
			const tr = model.touch(S, X);
			if (!tr.changed) continue;
			finish(X, live, 'trig:' + X.id, tr);
		}
		if (only) return out;
		finish(null, trophyTiles, 'trophy', null);
		// DEATHS AS MOVES (lane 2's die edge, lane 5): where a death door (1011) or gate (1012) reads the death count, a death
		// is an edge of its own (plan mode: the est walk to the nearest killer, the dead ticks, back at the respawn with one
		// death more), so the door that needs N deaths opens in the plan: Tutorial 2's est walk passed its death door only in
		// the relaxation, every plan carried the 1e6 penalty and no death step. The lb needs none (it keeps 1011 open).
		// EEAT_PLAN_DIE=0: none
		if (wantEst && DIE_EDGE && dieIdx !== undefined && dvE && S.vals[dieIdx] < model.deathT && dieNear(S.vals[dieIdx]) && (DIE_ALWAYS || out.some((e) => e.relaxOnly))) {
			const vals = S.vals.slice();
			vals[dieIdx] = S.vals[dieIdx] + 1;
			const S2 = model.mkState(vals, S.taken, S.btaken, S.cp);
			const rp = model.respawnOf(S2, 'est');
			const edge = 'die:' + vals[dieIdx];
			if (rp && !(facts && facts.blocked(edge, cls, proofKey(S, pos)))) {
				const ok = facts ? facts.okTicks(edge, cls) : undefined;
				const lbD = (dvL ? lbOfSteps(dvL.dk) : 0) + DEAD_TICKS + extra;
				const est = Math.max(lbD, ok !== undefined ? ok : dvE.dk * P + DEAD_TICKS + extra);
				const X = { id: -1 - vals[dieIdx], kind: 'die', tiles: rp.tiles, label: `die, back at a respawn (deaths ${vals[dieIdx]})` };
				out.push({ X, S2, pos2: diePos(rp), expect: { feat: 'deaths', value: vals[dieIdx] }, lb: lbD, est, steps: dvE.dk, viaDeath: false, relaxOnly: false, edge, live: rp.tiles });
			}
		}
		return out;
	}
	const DIE_EDGE = process.env.EEAT_PLAN_DIE !== '0';
	// (a death toward a door's count holds back at ANY respawn (a checkpoint touched on the way is where the engine puts
	// the ball): the count opens the door wherever the ball comes back, and the strategy re-anchors on the real state.
	// The Ten Commandments: its start room's only way out is a portal onto the checkpoint (2,21), so a death "back at the
	// spawn" never held (every leg 'budget', closest 0 at a killer, rungs 2-3 spent). A viaDeath step (a death as a
	// teleport to its respawn) keeps its respawn. EEAT_PLAN_DIE_ANY=0: the state's own respawn)
	const DIE_ANY = process.env.EEAT_PLAN_DIE_ANY !== '0';
	// (a viaDeath step (a death as a teleport) holds back at ANY respawn too: the way to a killer may pass a checkpoint the
	// model state's respawn does not know (the est walk is checkpoint-blind), and the engine puts the ball back THERE: The
	// Square's one spike (21, 73) is reached only past checkpoints, so "back at the state's own respawn (2, 168)" never held
	// (every rung 'budget', closest 0: the dead ball), and from the level's start the executor finds the death back at
	// any respawn in 294 ticks (0.8 s). The arrival is a real state: the strategy re-anchors and plans from it.
	// EEAT_PLAN_VIADEATH_ANY=0: the state's own respawn, as before)
	const VIA_ANY = DIE_ANY && process.env.EEAT_PLAN_VIADEATH_ANY !== '0';
	// (a death is offered only where an edge of the node is reachable in the relaxation alone (a shut death door is what
	// the relaxation opens): The Ten Commandments' trophy is reachable without a death (666 run ticks), and offered at every
	// node the death became its plan after one failed trophy rung (2,212 run ticks, 2 of 2; before the gain fix: its
	// compile lost, 3 of 3); Tutorial 2's trophy is behind its death door (relaxation only): offered. EEAT_PLAN_DIE_WHEN=always)
	const DIE_ALWAYS = process.env.EEAT_PLAN_DIE_WHEN === 'always';
	// (a death is a move only toward a death door / gate threshold at most DIE_GAP deaths on: First Person Maze's 999-death
	// door made "die" its first plan step (est 138), a way no route takes; each death costs 54 dead ticks at least)
	const DIE_GAP = +process.env.EEAT_PLAN_DIE_GAP || 3;
	const deathThs = (() => {
		const set = new Set(), fg = model.L && model.L.fg, lk = model.L && model.L.lookup0;
		// (the DOORS' thresholds (1011: open from N deaths on); a death gate (1012) SHUTS at its count, which the est walk
		// (a shut gate a wall, never a floor) can only lose by: a die edge there is branching for nothing (Polar Eclipse's
		// 16 gates at 1..16); EEAT_PLAN_DIE_GATES=1: gates too)
		const gatesToo = process.env.EEAT_PLAN_DIE_GATES === '1';
		if (fg && lk) for (let i = 0; i < fg.length; i++) if ((fg[i] === 1011 || (gatesToo && fg[i] === 1012)) && lk[i] > 0) set.add(lk[i]);
		return [...set].sort((x, y) => x - y);
	})();
	const dieNear = (cur) => deathThs.some((t) => t > cur && t <= cur + DIE_GAP);
	const dieIdx = model.featSet && model.featSet.has('deaths') && model.canDie && model.deathT > 0 ? model.fIdx.get('deaths') : undefined;
	const diePosOf = new Map();
	/** the position after a death: the respawn's tiles, no extra ticks (the die edge priced them) */
	const diePos = (rp) => { let p = diePosOf.get(rp.id); if (!p) { p = { id: 'die@' + rp.id, tiles: rp.tiles, extra: 0 }; diePosOf.set(rp.id, p); } return p; };
	/** the lb of a leg (costOf): the tier-0 bound under the lb relaxation, the primitives' where sound too, the larger */
	function legLb(S, pos, tiles, base) {
		let lb = model.pairLb(S, pos, tiles, 'lb', base);
		if (useBounds && Number.isFinite(lb)) { try { const bb = bounds.pair(pos.tiles, tiles, model.levelOf(S)); if (Number.isFinite(bb)) lb = Math.max(lb, bb + (pos.extra || 0)); } catch (e) { /* tier-0 */ } }
		return lb;
	}
	/** the RCH3 check of the edges on a plan's path; returns the number of edges newly found bad */
	function verifyPath(a, node, deadline) {
		let newBad = 0;
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push(n);
		path.reverse();
		for (const n of path) {
			if (Date.now() > deadline) break;
			const from = n.parent, e = n.e;
			if (e.X && e.X.kind === 'die') continue;   // (a death's goal is the respawn: no walk leg to check)
			const k = rchKey(from.S, from.pos, e.edge);
			if (rchBad.has(k)) continue;
			ST.rchChecks++;
			let r;
			const isRoot = !from.parent;
			if (isRoot && a.sim) r = model.reachable(from.S, a.sim, e.live);
			else r = model.reachable(from.S, from.pos.tiles, e.live, { rising: true });
			const bad = r.proof ? (isRoot && a.sim ? 'proof' : true) : false;
			rchBad.set(k, bad);
			if (bad) newBad++;
		}
		return newBad;
	}
	// ---------------------------------------------------------------- the lower bound
	/**
	 * lowerBound(anchor, o) -> {ticks, complete, expanded, ms}: the admissible ticks from the anchor's state to the trophy
	 * (the run timer's: an anchor before any input gets its idle trajectory free and 2 ticks off for the first input's
	 * tick). o.ms (1500), o.maxExpand (200000).
	 */
	function lowerBound(anchor, lo = {}) {
		const t0 = Date.now();
		ST.lbCalls++;
		const a = anchorOf(anchor);
		const ms = lo.ms !== undefined ? lo.ms : 1500, maxExpand = lo.maxExpand || 200000;
		pairUntil = t0 + ms;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, goal = Infinity, complete = false;
		// (nodes merged over the coins' identities: one node per (feature values, checkpoint, position) with the least g
		// and the INTERSECTION of the coin tiles taken: an over-approximation of every state merged into it (more coins
		// left, the counts the same), so the bound stays admissible and the coin orders collapse)
		const mkey = (S, pos) => S.dkey + '|c' + S.cp + '#' + pos.id;
		const andBits = (x, y) => { if (!x) return x; const o2 = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) o2[i] = x[i] & y[i]; return o2; };
		const sameBits = (x, y) => { if (!x) return true; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
		best.set(mkey(a.S, a.pos), { g: 0, S: a.S });
		open.push({ S: a.S, pos: a.pos, g: 0, f: hLb(a.pos), seq: seq++, goal: false });
		while (open.size) {
			const n = open.pop();
			if (n.goal) { goal = n.g; complete = true; break; }
			const rec = best.get(mkey(n.S, n.pos));
			if (rec && (rec.g < n.g || rec.S !== n.S)) continue;
			if (expanded >= maxExpand || Date.now() - t0 > ms) { open.push(n); break; }
			expanded++;
			for (const e of edgesOf(n.S, n.pos, a.base, 'lb', false, null)) {
				const g2 = n.g + e.lb;
				if (!e.X) { open.push({ S: n.S, pos: null, g: g2, f: g2, seq: seq++, goal: true }); continue; }
				const k2 = mkey(e.S2, e.pos2);
				const had = best.get(k2);
				let S2 = e.S2, gm = g2;
				if (had) {
					const tk = andBits(had.S.taken, S2.taken), btk = andBits(had.S.btaken, S2.btaken);
					const wider = !sameBits(tk, had.S.taken) || !sameBits(btk, had.S.btaken);
					if (!wider && had.g <= g2) continue;
					gm = Math.min(had.g, g2);
					S2 = wider ? model.mkState(S2.vals, tk, btk, S2.cp) : S2;
					if (!wider && had.g > g2) S2 = model.mkState(S2.vals, tk, btk, S2.cp);
				}
				best.set(k2, { g: gm, S: S2 });
				open.push({ S: S2, pos: e.pos2, g: gm, f: gm + hLb(e.pos2), seq: seq++, goal: false });
			}
		}
		let ticks;
		if (complete) ticks = goal;
		else if (!open.size) { ticks = Infinity; complete = true; }
		else { ticks = Infinity; for (const n of open.a) if (n.f < ticks) ticks = n.f; }
		if (a.idle && Number.isFinite(ticks)) ticks = Math.max(0, ticks - 2);
		ST.lbExpands += expanded; ST.lbMs += Date.now() - t0;
		return { ticks, complete, expanded, ms: Date.now() - t0 };
	}
	// ---------------------------------------------------------------- the plan search
	function search(a, po, exclude) {
		const t0 = Date.now();
		const ms = po.ms, maxExpand = po.maxExpand;
		pairUntil = t0 + ms;
		const budget = po.depth > 0 ? po.depth - a.tick : Infinity;
		const open = new Heap(), best = new Map();
		let seq = 0, expanded = 0, found = null, pruned = 0;
		const P = pace();
		const root = { S: a.S, pos: a.pos, g: 0, gl: 0, parent: null, e: null, depth: 0, seq: seq++ };
		// (a puzzle, 3+ landmarks left: greedy on the heuristic, g a tie-break (LAMA's greedy best-first); else weighted A*)
		const gw = hLM(a.S) >= 3 ? 0.1 : 1;
		const fOf = (g, S, pos) => gw * g + EST_W * hSteps(pos) * P + LM_W * hLM(S) - GAIN_BONUS * P * S.gain;
		root.f = fOf(0, a.S, a.pos);
		open.push(root);
		best.set(a.S.key + '#' + a.pos.id, 0);
		let bestPartial = root;
		// (the partial plan's end: the fewest landmarks left, then the most gain, then the least f)
		const better = (x, y) => { const hx = hLM(x.S), hy = hLM(y.S); return hx < hy || (hx === hy && (x.S.gain > y.S.gain || (x.S.gain === y.S.gain && x.f < y.f))); };
		let rootEdges = -1, bestRootChild = null;   // (-1: the budget ended before the root was expanded: no proof of anything)
		while (open.size) {
			const n = open.pop();
			if (n.goal) { found = n; break; }
			const k = n.S.key + '#' + n.pos.id;
			if (best.get(k) < n.g) continue;
			// (the root is always expanded: a plan of one step at least, whatever the budget)
			if (expanded > 0 && (expanded >= maxExpand || Date.now() - t0 > ms)) break;
			expanded++;
			if (better(n, bestPartial)) bestPartial = n;
			const isRoot = n === root;
			const es = edgesOf(n.S, n.pos, a.base, 'plan', isRoot, a.S.key + '|' + a.cls);
			if (isRoot) rootEdges = es.length;
			// (the landmarks this node reaches only through killers (the est walk walls them unprotected): protection on
			// counts as one more landmark here, so the search takes it first; Bad EE Level 9's switch 7 past the spikes)
			let protBoost = false;
			if (model.featSet.has('prot') && n.S.feats.prot === 0) {
				const h0 = hLM(n.S);
				let est = false, relax = false;
				for (const e of es) if (e.X && hLM(e.S2) < h0) { if (e.relaxOnly) relax = true; else est = true; }
				protBoost = relax && !est;
			}
			for (const e of es) {
				if (isRoot && exclude.has(e.edge)) continue;
				const g2 = n.g + e.est, gl2 = n.gl + e.lb;
				if (!e.X) {
					if (gl2 >= budget) { pruned++; continue; }
					open.push({ S: n.S, pos: null, g: g2, gl: gl2, f: gw < 1 ? -1e12 + g2 : g2, parent: n, e, depth: n.depth + 1, seq: seq++, goal: true });
					continue;
				}
				const hl = hLb(e.pos2);
				if (gl2 + hl >= budget) { pruned++; continue; }
				const k2 = e.S2.key + '#' + e.pos2.id;
				const had = best.get(k2);
				if (had !== undefined && had <= g2) continue;
				best.set(k2, g2);
				const child = { S: e.S2, pos: e.pos2, g: g2, gl: gl2, f: fOf(g2, e.S2, e.pos2) - (protBoost && e.X.kind === 'prot' && e.X.param === 1 ? LM_W : 0), parent: n, e, depth: n.depth + 1, seq: seq++, goal: false };
				open.push(child);
				if (isRoot && (!bestRootChild || child.f < bestRootChild.f)) bestRootChild = child;
			}
		}
		ST.expands += expanded;
		// (the budget out before any child was expanded: the root's best child, a one-step partial plan)
		if (bestPartial === root && bestRootChild) bestPartial = bestRootChild;
		return { found, bestPartial: bestPartial === root ? null : bestPartial, expanded, ms: Date.now() - t0, pruned, rootEdges, exhausted: !open.size && !found };
	}
	/** a death step's ORDERING field: the tiles a death starts from (model.dieSrc), not its goal tiles (the respawn, where
	 *  the leg's start usually stands: every finder's field read 0 there and no search went to a killer; the executor's
	 *  closest read 0, rung after rung). The goal test is the waypoint's own (alive back at the respawn, deaths + 1);
	 *  EEAT_DIE_FIELD=0: the respawn's field as before */
	const DIE_FIELD = process.env.EEAT_DIE_FIELD !== '0';
	const dieSrcArr = model.dieSrc && model.dieSrc.length ? model.dieSrc : null;
	function dieField(wp) {
		if (DIE_FIELD && dieSrcArr) { wp.fieldTiles = dieSrcArr; wp.fieldTouch = false; wp.dieField = true; }
		return wp;
	}
	/** the path of a search node -> the plan's steps (with the key-door passages and death steps inserted) */
	function stepsOf(a, node) {
		const path = [];
		for (let n = node; n && n.e; n = n.parent) path.push({ e: n.e, from: n.parent });
		path.reverse();
		const steps = [];
		let deathsNow = null;
		const push = (st) => { st.n = steps.length; steps.push(st); };
		for (let i = 0; i < path.length; i++) {
			const { e, from } = path[i];
			const isRoot = i === 0;
			const cls = isRoot ? a.S.key + '|' + a.cls : from.S.key + '|*';
			// a death first where only a death reaches the target
			if (e.viaDeath) {
				if (deathsNow === null) deathsNow = a.sim ? a.sim.deaths : 0;
				const edge = `death:${deathsNow}`;
				const wpD = { kind: 'region', tiles: VIA_ANY && model.respawn && model.respawn.length ? model.respawn.slice() : model.respawnOf(from.S).tiles.slice(), expect: { feat: 'deaths', value: deathsNow + 1 }, allowDeath: true, label: `die, back at a respawn (deaths ${deathsNow + 1})` };
				dieField(wpD);
				push({ edge, nodeClass: cls, rung: facts ? facts.rungOf(edge, cls) : 0, estTicks: DEAD_TICKS, lb: DEAD_TICKS, waypoint: wpD });
				deathsNow++;
			}
			// the anchor's own active key: its door first, before the key runs out
			if (isRoot && a.sim && (!e.X || e.X.kind !== 'key')) {
				const pass = keyPassage(a.S, a.pos, e, a.base);
				// (once done from this anchor's class its arrivals past the door are the anchor's own (the same model state):
				// the passage is not proposed again, the plan goes on from them)
				if (pass && !(facts && facts.okTicks(`region:key${pass.colour}-door`, cls) !== undefined)) {
					const c = pass.colour, left = KEY_TICKS - (a.sim._ticks - a.sim._kt[c]);
					if (left > 0) push({ edge: `region:key${c}-door`, nodeClass: cls, rung: facts ? facts.rungOf(`region:key${c}-door`, cls) : 0, estTicks: 0, lb: 0,
						waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTick: a.tick + left - 1, label: `past the ${COLOURS[c] || c} key door` } });
				}
			}
			const X = e.X;
			if (X && X.kind === 'die') {
				// (a death as a move: the respawn with one death more; a death shortcut after it counts from there)
				deathsNow = e.expect.value;
				push({ edge: e.edge, nodeClass: cls, rung: facts ? facts.rungOf(e.edge, cls) : 0, estTicks: Math.round(e.est), lb: e.lb,
					waypoint: dieField({ kind: 'region', tiles: DIE_ANY && model.respawn && model.respawn.length ? model.respawn.slice() : e.live.slice(), expect: e.expect, allowDeath: true, label: X.label }) });
				continue;
			}
			const wp = X ? { kind: 'trigger', tiles: e.live.slice(), trig: X.id, expect: e.expect, label: X.label } : { kind: 'trophy', label: 'trophy' };
			push({ edge: e.edge, nodeClass: cls, rung: facts ? facts.rungOf(e.edge, cls) : 0, waypoint: wp, estTicks: Math.round(e.est), lb: e.lb, pen: e.pen || '' });
			// a key followed by its door: the passage while the key is on
			if (X && X.kind === 'key' && i + 1 < path.length) {
				const next = path[i + 1].e;
				const pass = keyPassage(e.S2, e.pos2, next, a.base, X.param);
				if (pass) push({ edge: `region:key${X.param}-door`, nodeClass: e.S2.key + '|*', rung: facts ? facts.rungOf(`region:key${X.param}-door`, e.S2.key + '|*') : 0, estTicks: 0, lb: 0,
					waypoint: { kind: 'region', tiles: pass.tiles, expect: null, beforeTickFrom: 'prev+500', label: `past the ${COLOURS[X.param] || X.param} key door` } });
			}
		}
		return steps;
	}
	/** the tiles just past a key door that the next edge needs (null: it needs none): the tiles next to a door of that
	 *  colour that the key-off state cannot reach from the position but the key-on state can */
	function keyPassage(S, pos, next, base, colour) {
		const cols = colour !== undefined ? [colour] : [0, 1, 2, 3, 4, 5].filter((c) => S.feats['key' + c] === 1);
		for (const c of cols) {
			const f = 'key' + c;
			if (S.feats[f] !== 1) continue;
			const vals = S.vals.slice(); vals[model.fIdx.get(f)] = 0;
			const Soff = model.mkState(vals, S.taken, S.btaken);
			const dOff = model.dist(Soff, pos, 'est', base), dOn = model.dist(S, pos, 'est', base);
			const tgt = next.live || trophyTiles;
			let off = INF, on = INF;
			for (const t of tgt) { if (dOff[t] < off) off = dOff[t]; if (dOn[t] < on) on = dOn[t]; }
			if (off < INF && off <= on + 2) continue;
			// the tiles next to a door of colour c, reachable with the key on, not with it off
			const tiles = [];
			for (let i = 0; i < model.N; i++) {
				if (dOff[i] < INF || dOn[i] >= INF || model.A.cls[i] === 0 || model.A.cls[i] === 3) continue;
				const x = i % W, y = (i / W) | 0;
				let near = false;
				for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1) && !near; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
					const j = yy * W + xx;
					if (model.A.cls[j] === 3 && model.A.gateFeat[j] === f && model.A.gatePol[j] === 1) { near = true; break; }
				}
				if (near) tiles.push(i);
			}
			if (tiles.length) return { colour: c, tiles };
		}
		return null;
	}
	/** the est walls from the failures: a failed step's closest approach (at its second rung, or exhausted there) walls
	 *  its 3 x 3 in the est walk (ordering only: the lb and the proofs never read them), so the next plans go another
	 *  way where there is one; rebuilt when the facts' version moves */
	let wallsVer = -1;
	function syncWalls() {
		if (!facts || facts.version() === wallsVer) return;
		wallsVer = facts.version();
		let mask = null, n = 0;
		for (const fct of facts.list()) {
			if (fct.kind === 'fail' && fct.cut) for (const j of fct.cut) { if (!mask) mask = new Uint8Array(model.N); if (!mask[j]) { mask[j] = 1; n++; } }
			if (fct.kind !== 'fail' || !fct.closest || fct.closest.tile === undefined || fct.closest.tile === null) continue;
			if (!((fct.rung | 0) >= 1 || fct.why === 'exhausted')) continue;
			const t = fct.closest.tile, x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const j = ny * W + nx;
				if (model.trigOf[j] >= 0) continue;
				if (!mask) mask = new Uint8Array(model.N);
				if (!mask[j]) { mask[j] = 1; n++; }
			}
		}
		model.setEstWalls(mask);
		ST.estWalls = n;
	}
	/**
	 * plan(anchor, {k, depth, epoch, ms, maxExpand}) -> Plan[] (with .why when empty: 'exhausted' | 'proof')
	 */
	function plan(anchor, po = {}) {
		landmarks();   // (once, outside the budget)
		const t0 = Date.now();
		ST.plans++;
		syncWalls();
		const a = anchorOf(anchor);
		const k = po.k || 3;
		const first = ST.plans === 1;
		const so = { ms: po.ms || (first ? 2000 : 300), maxExpand: po.maxExpand || 200000, depth: po.depth || 0 };
		const plans = [], exclude = new Set();
		let why = '', rootEdges = -1, anyExhausted = false;
		const deadline = t0 + so.ms;
		for (let r = 0; r < k; r++) {
			let res = search(a, Object.assign({}, so, { ms: Math.max(50, (deadline - Date.now()) / Math.max(1, k - r)) }), exclude);
			for (let v = 0; v < 6 && res.found && Date.now() < deadline + so.ms / 2; v++) {
				if (!verifyPath(a, res.found, deadline + so.ms / 2)) break;
				res = search(a, Object.assign({}, so, { ms: Math.max(50, (deadline - Date.now()) / Math.max(1, k - r)) }), exclude);
			}
			if (rootEdges < 0) rootEdges = res.rootEdges;
			const node = res.found || res.bestPartial;
			if (!node) { anyExhausted = anyExhausted || res.exhausted; break; }
			const steps = stepsOf(a, node);
			if (!steps.length) break;
			const lbTail = res.found ? 0 : hLb(node.pos);
			plans.push({ id: `p${ST.plans}.${r}`, steps, cost: Math.round(node.g + (res.found ? 0 : pace() * hStepsD(node.pos))), lb: node.gl + lbTail, partial: !res.found, why: res.found ? 'trophy' : 'budget: the most gain', expanded: res.expanded });
			exclude.add(steps[0].edge);
			// (the first step's own edge: a death or passage step was inserted before the real first edge)
			let n = node; while (n.parent && n.parent.parent) n = n.parent;
			if (n.e) exclude.add(n.e.edge);
		}
		if (plans.length && NEAR_K > 0 && facts) {
			try { const near = nearPlans(a, plans); if (near.length) plans.unshift(...near); } catch (e) { /* the rule is ordering only */ }
		}
		if (plans.length && crumbs.length) {
			try { const cp = crumbPlan(a, plans); if (cp.length) plans.unshift(...cp); } catch (e) { if (process.env.EEAT_CRUMB_DBG === '1') console.error('crumbPlan', e.stack); }
		}
		if (!plans.length) {
			why = rootEdges < 0 ? 'budget' : rootEdges === 0 && !(facts && facts.list().length) ? 'proof' : 'exhausted';
			// (no edge at the root because the facts took them all: exhausted; none at all without facts: a walk proof)
			if (rootEdges === 0 && facts && facts.list().length) {
				const raw = edgesOf(a.S, a.pos, a.base, 'lb', false, null);
				why = raw.length ? 'exhausted' : 'proof';
			}
		}
		lastPlans = plans; lastWhy = why;
		ST.planMs += Date.now() - t0;
		const out = plans;
		out.why = why;
		out.plans = plans;
		return out;
	}
	/**
	 * THE DIVERSIFICATION RULE (lane 3, COMPILE-ALL block 2; OPT-IN EEAT_PLAN_NEAR=1): the plan search keeps the cheapest whole plan, so a first leg
	 * the executor cannot do in its rung comes back at the next rung, again and again, while nearer triggers that change
	 * the state are never tried (the FIRST-LEG class of the full compile b1: 45 levels, a first target 100-600 tiles away;
	 * the closest-0 false report had diversified by accident: its walls near the goal pushed the est walk to other
	 * triggers). Here: when EVERY plan's first leg has FAILED from this node class (its rung >= 1: the plan search's own
	 * diversity spent), the root's triggers that are nearer by the admissible bound (the edge's lb), not tried from this class yet (rung 0), not only a
	 * relaxation's or a death's way, go first as one-step plans, the nearest first, at most NEAR_K (EEAT_PLAN_NEAR): a leg the executor does in its first rung is a new anchor with more gain (the strategy's most-progress order
	 * goes on from it), one it fails moves to rung 1 and the next nearer trigger is offered at the next plan. Ordering
	 * only: every plan the search found is still there (after them), no edge is dropped, the lb and the proofs untouched.
	 * Measured (box 3, 60 s, --workers=3): a first version (fire when the BEST plan's first leg failed, 2 near plans
	 * first) The Glitch 0 -> 8, MIHB's Dream 6 -> 10, but I Wanna be the Guy 15 -> 3 (its 2nd / 3rd plans, a checkpoint
	 * and a switch, lead to its 15 triggers; the nearest-by-lb 40-coin group and checkpoints took their slots); this one
	 * (all failed, 1 near plan) on lane 3's 45 FIRST-LEG levels 4 triggers vs 2 (noise level), gate20 7 compiled vs 9 of
	 * the same code without it (Tutorial 1 / Bygone Tutorial: they compile in about half the runs), IWBTG 15 / 11 in two
	 * runs: no gain shown, so OPT-IN; with EEAT_SKEL_CLOSEST=1 IWBTG 11 (15 -> 1 without the rule), MIHB 5, The Glitch 0.
	 * DEFAULT ON (K 1) with the true skeleton closest since COMPILE-ALL block 3 lane 4: the pair measured together (box 3,
	 * 60 s, --workers=3, n4-plan a137f8e, env EEAT_SKEL_CLOSEST=1 EEAT_PLAN_NEAR=1): the shared gate compiled 11 vs the
	 * baseline's 9 (Tutorial 1 2,233 and Tree Decorating 1,320 run ticks, both compile in half the base runs), worse 0,
	 * better 10 (Booty Return 25 vs 11, I Wanna be the Guy 16 vs 11, MIHB's Dream 22 vs 16, Starlight 22 vs 18, NC Naos
	 * 319 vs 358 run ticks), The Glitch 8 vs the baseline's 4; the lane's 23 levels side by side with the base: progress
	 * 78 vs 72 (Booty Return 16 vs 11, SPOT THE DIDFERNECE 4 vs 1, Beaches in Space 4 vs 2). EEAT_PLAN_NEAR=0: off.
	 */
	function nearPlans(a, plans) {
		const p0 = plans[0];
		if (!p0 || !p0.steps || !p0.steps.length) return [];
		const cls = a.S.key + '|' + a.cls;
		// (the first real edge of the best plan: a death or a key passage may be inserted before it)
		const s0 = p0.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p0.steps[0];
		if (facts.rungOf(s0.edge, cls) < 1) return [];
		// (only once the plan search's own diversity is spent: every plan's first leg has failed from this class; a plan
		// whose first leg is untried still gets its rung-0 try (I Wanna be the Guy: its 2nd / 3rd plans' first legs, a
		// checkpoint and a switch, lead to 15 triggers; the nearest-by-lb coins / checkpoints ahead of them took their slots:
		// 15 -> 3)
		let rMin = Infinity;
		for (const p of plans) { const f = p.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p.steps[0]; const r = facts.rungOf(f.edge, cls); if (r < 1) return []; if (r < rMin) rMin = r; }
		const lb0 = Number.isFinite(+s0.lb) ? +s0.lb : Infinity;
		const es = edgesOf(a.S, a.pos, a.base, 'plan', true, cls);
		const used = new Set(plans.map((p) => p.steps[0] && p.steps[0].edge));
		// (THE RUNG BALANCE, lane 6 block 4, NEAR_RUNG: a near trigger is offered while its rung is below every plan's first
		// leg's, not only while untried: the plans' first legs climbed rung after rung (5 -> 15 -> 45 s windows, three
		// workers on the same failing edges for the second half of a 60-s compile) while a near trigger that failed its
		// rung 0 never got its rung 1 (Bygone Tutorial: the red key (169, 33) found at rung 1 in 1.9 s once the planner
		// offered it, after the coin and the two keys had spent their rungs 2 and 3); the lowest rung first, then the lb.
		// Measured (box 3, 60 s, --workers=3, with the executor's rate rule): Bygone Tutorial COMPILED in 2 of 2 runs (2,123 /
		// 2,129 run ticks at 48 s; 0 of 6 runs at 60 s without it), the lane's other 10 levels 183 vs 186 triggers (noise);
		// T-PLAN-ORACLE unchanged by construction (it fires only after a failed rung): 619 plans, 0 / 0.
		// EEAT_NEAR_RUNG=0: only untried triggers, as before)
		const rCap = NEAR_RUNG ? rMin : 1;
		const cands = es.filter((e) => e.X && !e.relaxOnly && !e.viaDeath && e.edge !== s0.edge && !used.has(e.edge) && e.lb < lb0 && facts.rungOf(e.edge, cls) < rCap)
			.sort((x, y) => (NEAR_RUNG ? facts.rungOf(x.edge, cls) - facts.rungOf(y.edge, cls) : 0) || x.lb - y.lb || x.est - y.est);
		const out = [];
		const root = { S: a.S, pos: a.pos, e: null, parent: null };
		for (const e of cands.slice(0, NEAR_K)) {
			const steps = stepsOf(a, { S: e.S2, pos: e.pos2, e, parent: root });
			if (!steps.length) continue;
			out.push({ id: `p${ST.plans}.n${out.length}`, steps, cost: p0.cost, lb: e.lb + hLb(e.pos2), partial: true, why: `near: '${s0.waypoint && s0.waypoint.label}' failed its rung ${facts.rungOf(s0.edge, cls) - 1}; the nearest untried trigger first`, near: true });
		}
		ST.nearPlans = (ST.nearPlans || 0) + out.length;
		return out;
	}
	/**
	 * THE CRUMB PLANS (doctor 9, n5; EEAT_CRUMBS=1, model.js): the CRUMB_K nearest crumbs (coins no gate reads) by the
	 * admissible bound, as one-step plans in front of the plans, when the best plan's first leg is long (its lb >= CRUMB_MIN ticks)
	 * and the crumb is nearer than that leg's target (lb below CRUMB_F x its lb); the least lb x (1 + its rung) first (a
	 * crumb that failed its rung gives way to the next nearest, a far one waits). An arrival at a crumb is a new anchor with one gain more: the
	 * strategy goes on from it, so the compile follows the level's breadcrumb trail one leg at a time, and every plan from
	 * each crumb is the plan search's own (the trophy's direct leg first). Ordering only: no edge dropped, the lb untouched.
	 */
	// (CRUMB_K crumb plans, the nearest first: a compile's workers run the first plans' legs side by side, so with one the
	// other worker spent every rung on the long leg itself; box 5, On And On, 60 s, 2 workers: the nearest crumb (a blue
	// coin off the route, closest 1 tile) took rungs 0-3 while the route's coin waited at rung 2)
	const CRUMB_MIN = +process.env.EEAT_CRUMB_MIN || 50, CRUMB_F = +process.env.EEAT_CRUMB_F || 0.9;
	const CRUMB_K = process.env.EEAT_CRUMB_K !== undefined ? Math.max(1, +process.env.EEAT_CRUMB_K | 0) : 2;
	const CRUMB_AFTER = process.env.EEAT_CRUMB_AFTER !== undefined ? Math.max(0, +process.env.EEAT_CRUMB_AFTER | 0) : 1;
	function crumbPlan(a, plans) {
		const p0 = plans.find((p) => !p.near) || plans[0];
		if (!p0 || !p0.steps || !p0.steps.length) return [];
		const s0 = p0.steps.find((s) => !String(s.edge).startsWith('death:') && !String(s.edge).startsWith('region:key')) || p0.steps[0];
		const lb0 = Number.isFinite(+s0.lb) ? +s0.lb : Infinity;
		if (!(lb0 >= CRUMB_MIN)) return [];
		const cls = a.S.key + '|' + a.cls;
		// (only once that leg has failed CRUMB_AFTER rungs from this anchor's class: a first leg the executor finds at its
		// first rung (the compiled levels' direct legs) keeps both workers; EEAT_CRUMB_AFTER=0: at once)
		if (CRUMB_AFTER > 0 && facts && facts.rungOf(s0.edge, cls) < CRUMB_AFTER) return [];
		const es = edgesOf(a.S, a.pos, a.base, 'plan', true, cls, crumbs);
		// (a crumb past the est walk's CEGAR cuts is kept: the cuts come from the long leg's failures, and a way around its
		// deceptive field is what a crumb is for; its lb is the relaxation's, still admissible)
		const cands = es.filter((e) => e.X && e.X.crumb && !e.viaDeath && e.lb < CRUMB_F * lb0)
			.sort((x, y) => (facts ? x.lb * (1 + facts.rungOf(x.edge, cls)) - y.lb * (1 + facts.rungOf(y.edge, cls)) : 0) || x.lb - y.lb || x.est - y.est);
		if (process.env.EEAT_CRUMB_DBG === '1') console.error(`crumbPlan: lb0 ${lb0} crumb edges ${es.length} cands ${cands.length}: ${es.slice(0, 6).map((e) => `${e.X && e.X.label} lb ${e.lb} pen '${e.pen}' relax ${e.relaxOnly} r ${facts ? facts.rungOf(e.edge, cls) : '-'}`).join('; ')}`);
		const out = [];
		const root = { S: a.S, pos: a.pos, e: null, parent: null };
		for (const e of cands) {
			if (out.length >= CRUMB_K) break;
			const steps = stepsOf(a, { S: e.S2, pos: e.pos2, e, parent: root });
			if (!steps.length) continue;
			out.push({ id: `p${ST.plans}.c${out.length}`, steps, cost: p0.cost, lb: e.lb + hLb(e.pos2), partial: true, why: `crumb: a nearest breadcrumb before '${s0.waypoint && s0.waypoint.label}' (lb ${lb0})`, near: true, crumb: true });
		}
		ST.crumbPlans = (ST.crumbPlans || 0) + out.length;
		return out;
	}
	// ---------------------------------------------------------------- CEGAR
	/** the value of the feature gate tile i reads that opens it */
	function openValue(i, S) {
		const A = model.A, k = A.gateFeat[i], pol = A.gatePol[i], p = A.gateParam[i];
		if (!k || k === 'open' || k === 'time' || k === 'static') return null;
		if (k.startsWith('key') || k.startsWith('psw') || k.startsWith('osw') || k === 'crown') return pol === 1 ? 1 : 0;
		if (k === 'team') return pol === 1 ? p : null;
		if (k === 'coins' || k === 'bcoins') return pol === 1 ? p : null;
		return null;
	}
	/** the est walk's path from pos to the tiles under S (tiles, the start first; null: none) */
	function estPath(S, pos, tiles, base) {
		const d = model.dist(S, pos, 'est', base);
		const m = model.passMask(S, 'est', base);
		let v = -1, best = INF;
		for (const t of tiles) if (d[t] < best) { best = d[t]; v = t; }
		if (v < 0) return null;
		const srcOf = new Map();
		for (const [p, ex] of model.A.portalExits) for (const e of ex) { if (!srcOf.has(e)) srcOf.set(e, []); srcOf.get(e).push(p); }
		const path = [v];
		for (let k = 0; k < 100000 && d[v] > 0; k++) {
			let u = -1;
			for (const p of srcOf.get(v) || []) {
				const x = p % W, y = (p / W) | 0;
				for (let dy = -1; dy <= 1 && u < 0; dy++) for (let dx = -1; dx <= 1 && u < 0; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && d[ny * W + nx] === d[v]) u = ny * W + nx;
				}
				if (u >= 0) { path.push(p); break; }
			}
			if (u < 0) {
				const x = v % W, y = (v / W) | 0;
				for (let dy = -1; dy <= 1 && u < 0; dy++) for (let dx = -1; dx <= 1 && u < 0; dx++) {
					const nx = x + dx, ny = y + dy;
					if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && m[ny * W + nx] && d[ny * W + nx] === d[v] - 1) u = ny * W + nx;
				}
			}
			if (u < 0) break;
			path.push(u); v = u;
		}
		return path.reverse();
	}
	/** the est path's tiles just past the point nearest the closest approach c (4 tiles, no trigger): the cut */
	function cutPast(S, pos, tiles, base, c) {
		const path = estPath(S, pos, tiles, base);
		if (!path || path.length < 3) return null;
		const cx = c % W, cy = (c / W) | 0;
		let bi = 0, bd = Infinity;
		path.forEach((t, i) => { const dd = Math.max(Math.abs(t % W - cx), Math.abs(((t / W) | 0) - cy)); if (dd < bd) { bd = dd; bi = i; } });
		const cut = [];
		for (let i = bi + 1; i < path.length - 1 && cut.length < 4; i++) if (model.trigOf[path[i]] < 0) cut.push(path[i]);
		return cut.length ? cut : null;
	}
	/**
	 * learn(step, result, anchor) -> Fact[]: at least one whenever !result.ok (the facts' version bumps with each).
	 */
	function learn(step, result, anchor) {
		ST.learned++;
		const out = [];
		if (!facts) return out;
		const edge = step.edge, cls = step.nodeClass;
		const a = anchor ? anchorOf(anchor) : null;
		if (result && result.ok) {
			const arr = result.arrivals && result.arrivals[0];
			const ticks = arr && a ? Math.max(0, arr.tick - a.tick) : (result.ticks || 0);
			out.push(facts.add({ kind: 'ok', edge, nodeClass: cls, ticks, lb: step.lb || 0 }));
			if (a && step.waypoint && step.waypoint.tiles) {
				const d = model.pairSteps(a.S, a.pos, step.waypoint.tiles, 'est', a.base);
				if (d > 0 && d < INF && ticks > 0) paceSamples.push(ticks / d);
			}
			return out;
		}
		const fail = (result && result.fail) || { why: 'budget' };
		const sKey = a ? proofKey(a.S, a.pos) : (cls || '').split('|')[0];
		if (fail.why === 'proof') out.push(facts.add({ kind: 'proof', edge, sKey }));
		for (const b of fail.blockedBy || []) {
			if (!a || b.tile === undefined) continue;
			const f = b.feat || model.A.gateFeat[b.tile];
			const v = openValue(b.tile, a.S);
			if (!f || v === null || v === undefined || a.S.feats[f] === v) continue;
			out.push(facts.add({ kind: 'needs', edge, nodeClass: cls, feat: f, value: v }));
		}
		const rung = facts.rungOf(edge, cls);
		// (the est walk's path to the waypoint, cut just past the point nearest the closest approach: the next plans'
		// est walk goes another way there, CEGAR's generalization over every edge through that corridor)
		let cut = null;
		if (a && fail.closest && fail.closest.tile !== undefined && fail.closest.tile !== null && (rung + 1 >= 2 || fail.why === 'exhausted')) {
			const tiles = step.waypoint && step.waypoint.kind !== 'trophy' && step.waypoint.tiles ? step.waypoint.tiles : trophyTiles;
			cut = cutPast(a.S, a.pos, tiles, a.base, fail.closest.tile);
		}
		out.push(facts.add({ kind: 'fail', edge, nodeClass: cls, rung, why: fail.why || 'budget', closest: fail.closest ? { tile: fail.closest.tile, dist: fail.closest.dist } : null, blockedBy: fail.blockedBy || [], cut }));
		if (rung + 1 >= facts.RUNG_MAX) out.push(facts.add({ kind: 'block', edge, nodeClass: cls }));
		return out;
	}
	// ---------------------------------------------------------------- the truth checker's price of an order
	/**
	 * costOf(order, anchor) -> {lb, est, feasible, why, legs}: the order's legs priced like the plans' (lb: sound for
	 * any real route that touches the triggers in this order, the trophy last). order: trigger ids (or 'trig:<id>').
	 */
	function costOf(order, anchor) {
		ST.costOf++;
		const a = anchorOf(anchor);
		let S = a.S, pos = a.pos, lb = 0, est = 0, feasible = true, why = 'ok';
		const legs = [];
		const P = pace();
		const ids = order.map((x) => (typeof x === 'string' ? +String(x).replace(/^trig:/, '') : +x));
		for (let i = 0; i <= ids.length; i++) {
			const X = i < ids.length ? model.triggers[ids[i]] : null;
			if (i < ids.length && !X) { feasible = false; why = `no trigger ${ids[i]}`; break; }
			const tiles = X ? X.tiles : trophyTiles;
			const l = legLb(S, pos, tiles, a.base);
			const steps = model.pairInfo(S, pos, tiles, 'est', a.base).steps;
			if (!Number.isFinite(l)) { feasible = false; why = `leg ${i} to ${X ? X.label : 'the trophy'} unreachable in the model`; legs.push({ to: X ? X.id : 'trophy', lb: Infinity }); break; }
			lb += l; est += Math.max(l, steps < INF ? steps * P : l);
			legs.push({ to: X ? X.id : 'trophy', lb: l });
			if (X) { const tr = model.touch(S, X); pos = posOf(X, S, tr.S2); S = tr.S2; }
		}
		if (a.idle && feasible) lb = Math.max(0, lb - 2);
		return { lb, est: Math.round(est), feasible, why, legs };
	}
	function explain() {
		if (!lastPlans.length) return `no plan (${lastWhy || 'none yet'})`;
		const p = lastPlans[0];
		return `${p.partial ? 'PARTIAL ' : ''}plan ${p.id}: est ${p.cost} ticks, lb ${p.lb}: ` + p.steps.map((s) => s.waypoint.label + (s.rung ? `[r${s.rung}]` : '')).join(' -> ');
	}
	const stats = () => Object.assign({}, ST, { pace: pace(), model: model.stats() });
	/** the floors' version: bumps when an async floor probe adds floors (plans made before it priced the trophy edge without) */
	const floorVersion = () => floorVer;
	return { plan, learn, lowerBound, costOf, explain, stats, floorVersion, _edgesOf: edgesOf, _hLb: hLb, _anchorOf: anchorOf, _zoneNeed: zoneNeed };
}

module.exports = { createPlanner, PACE0 };
