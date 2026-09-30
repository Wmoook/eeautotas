'use strict';
// src/plan/oneshot/edges.js - ONE SHOT, part 2: THE EDGES (n5-oneshot, 2026-09-30). brief.md ADDENDUM 09:50: "precompute
// the WHOLE LEVEL's exact move graph, then ONE optimal path computation". This file builds the graph's EDGES: every exact
// move between SUPPORTS (the state classes the ball is in at a move boundary), each an input string + its ticks, replayed
// by the engine from its source support's representative state, built once per level in parallel (worker threads) and
// cached per level md5. No search: every edge comes from the mathematics (src/plan/msolve.js, src/math/fieldsolve.js) or
// a closed family of input words (the held masks, the one-change words) played by the engine.
//
// SUPPORTS (a default set; part 1's supports can be passed in instead, o.supports): a support is (centre tile, class
// letter) with a REPRESENTATIVE engine state:
//   'start'  the level's own start state (sim.reset()): exact;
//   'rest'   every tile where a ball placed at rest (px = 16 x, py = 16 y, speeds 0, the queue empty: the engine's respawn
//            placement) stays on its tile, alive, after SETTLE ticks without input: class G (a floor in the gravity of
//            that tile: arrows, flipped gravity too), or a field class W / C / Z / B on the region's border tiles (the
//            entries: a field's inside is no move boundary);
//   'arrive' a (tile, class) no rest placement gives, reached by an edge of the previous round (a portal exit, a field
//            entry at speed, a landing on a one-way / half block): its representative is that edge's exact end state
//            (the cheapest edge's; rounds until none is new or o.rounds).
// EDGES from a support's representative (each kind a closed family, each edge replayed once here):
//   'land'   msolve landings: the earliest verified landing on every standable tile the plain extremes reach within
//            o.landT ticks (<= o.landK x changes; the plain regime: the math's (T, gravity member, row) items, the x axis
//            solved exactly), and its landing HOP (the jump on the landing tick) when the engine confirms it;
//   'event'  the 18 held masks (9 directions, with and without the press on tick 1) to their first support event within
//            o.eventT ticks: a landing, a class change (a field entered or left), a teleport (a portal), a DEATH (spikes,
//            fire, killers exact: the edge runs on through the dead ticks to the respawn: kind 'death', to 'R');
//   'one'    (non-plain supports: fields) the one-change words: mask a for c ticks then mask b (9 x 9 directions, the
//            press on tick 1 or not, c = 1 .. o.oneT - 1), prefix shared, each to its first support event: the cheapest
//            per end (tile, class);
//   'touch'  a trigger component (a coin, key, switch, effect, checkpoint, the trophy: model.js triggers) whose bound
//            (the certified plain bound of msolve, else the speed limit: 16.25 px an axis a tick) is <= o.touchT: the
//            msolve leg (plain, field, coupled tiers; no chain) to its tiles, class any.
// PRUNING (only pairs a move can connect): 'land' only to the tiles inside the plain extremes' rectangle (msolve's hold
// tables: THEOREM M); 'touch' only where the bound allows; the families end at their first event.
// EACH EDGE: {f (source support), k (kind), to (support index, -1 = the respawn 'R', or -2 - trigger id for a touch),
// tile, cls, T (ticks), m (the input string: run-length [[mask, n], ...]), hop (1: the landing hop verified), end [px,
// py, vx, vy] (the exact end state), tr (triggers touched on the way, trigger ids), g (gates whose tiles the swept box
// met: the edge depends on their state), d (1: it dies on the way)}. The graph is a PROPOSAL from representatives: an
// edge used from another state (a different speed / sub-pixel) is replayed there (applyEdge) and, on a miss, re-solved
// (resolveEdge: msolve.leg to the edge's end); a proposal's cost is exact from its representative.
//
// API
//   buildGraph(file | L, o) -> Promise<graph>: {md5, W, H, sups: [{i, tile, cls, kind, org?}], edges: [...], stats}
//     o: {threads (os.cpus - 1, <= 16), rounds (2), landT (60), landK (1), landMax (400), eventT (60), oneT (40),
//     touchT (90), settle (2), cache (a directory; null: none), supports (external support records), verbose}
//   buildLocal(L, o) -> the same, in this thread (the tests, small levels)
//   supportState(ctx, i) -> the representative EESnapshot of support i (made on first use, memoised)
//   applyEdge(sim, e) -> the first tick (1-based) the edge's end holds when its input is played from sim's state, 0 miss
//   resolveEdge(S, snap, e, o) -> msolve leg result from snap to the edge's end (the lazy verification's fallback)
//   rleOf(masks) / masksOf(rle)
// CLI: node src/plan/oneshot/edges.js <level> [--threads=N] [--rounds=2] [--cache=dir] [--json] [--out=graph.json.gz]
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const E = require('../../eesim.js');

const F_SOLID = 1, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const DIR9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const TELEPORT_PX = 20;
const DEAD_MAX = 80;                      // the dead ticks played on to the respawn (the engine: 54)
const DEF = { p1: 1, rounds: 1, landT: 60, landK: 1, landMax: 400, landNodes: 60000, land2Max: 24, land2Nodes: 60000, reach: 0, reachMax: 200, reachK: 2, reachNodes: 400000, eventT: 60, oneT: 40, touchT: 90, touchNodes: 20000, settle: 2, arriveMax: 4, maxNew: 20000 };
const VERSION = 1;

// ------------------------------------------------------------------ small helpers
function clsOf(sim, flags) {
	if (sim.is_dead) return 'D';
	const id = sim.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (DOTS.has(id)) return 'Z';
	if (f & F_BOOST) return 'B';
	if (sim.on_ground) return 'G';
	return 'A';
}
function tileOf(sim, W, H) {
	let x = Math.trunc(sim.px + 8) >> 4, y = Math.trunc(sim.py + 8) >> 4;
	if (x < 0) x = 0; else if (x >= W) x = W - 1;
	if (y < 0) y = 0; else if (y >= H) y = H - 1;
	return y * W + x;
}
/** run-length form of an input string: [[mask, n], ...] */
function rleOf(masks) {
	const r = [];
	for (let i = 0; i < masks.length; i++) { const m = masks[i]; if (r.length && r[r.length - 1][0] === m) r[r.length - 1][1]++; else r.push([m, 1]); }
	return r;
}
function masksOf(rle) {
	let n = 0;
	for (const q of rle) n += q[1];
	const out = new Uint8Array(n);
	let k = 0;
	for (const [m, c] of rle) { out.fill(m, k, k + c); k += c; }
	return out;
}
const SUP_CLS = new Set(['G', 'W', 'C', 'Z', 'B']);

// ------------------------------------------------------------------ the level context (per thread)
function levelOf(src) {
	if (src && typeof src === 'object' && src.fg) return src;
	return require('../types.js').loadLevelFile(String(src));
}
function md5OfLevel(src, L) {
	const h = crypto.createHash('md5');
	if (typeof src === 'string' && fs.existsSync(src)) h.update(fs.readFileSync(src));
	else { h.update(`${L.width}x${L.height}`); h.update(Buffer.from(L.fg.buffer, L.fg.byteOffset, L.fg.byteLength)); }
	return h.digest('hex');
}

/**
 * ctxOf(L, o): the per-thread machinery: the engine, the move solver, the model's triggers (tile -> trigger id) and gates
 * (tile -> gate id), the start snapshot
 */
function ctxOf(L, o = {}) {
	const MS = require('../msolve.js');
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const start = sim.snapshot();
	const W = L.width, H = L.height, N = W * H;
	const flags = sim._flags;
	const S = MS.createSolver(L, { K: 2 });
	let model = null;
	try { model = require('../model.js').compileModel(L, {}); } catch (e) { model = null; }
	const trigAt = new Int32Array(N).fill(-1), gateAt = new Int32Array(N).fill(-1);
	const triggers = model ? model.triggers.map((X) => ({ id: X.id, kind: X.kind, tiles: X.tiles, label: X.label })) : [];
	for (const X of triggers) for (const t of X.tiles) trigAt[t] = X.id;
	if (model) for (const G of model.gates) for (const t of G.tiles) gateAt[t] = G.id;
	const oo = Object.assign({}, DEF, o);
	// part 1's support classes (src/plan/oneshot/supports.js): every end state and representative classified by them, so
	// the one-shot search links these edges to part 1's nodes (o.p1 0: none)
	let P1 = null, P1M = null;
	if (oo.p1) {
		try { P1M = require('./supports.js'); P1 = P1M.buildSupports(L, { model }); } catch (e) { P1 = null; }
	}
	return { L, W, H, N, sim, inp, start, flags, S, MS, triggers, trigAt, gateAt, o: oo, sups: null, snaps: new Map(), P1, P1M };
}
/** part 1's class of the sim's state: 'kind:id' (s surface, f field, p portal exit, t trigger), '' none */
function p1Of(ctx, sim, teleported, touched) {
	if (!ctx.P1) return undefined;
	let c = null;
	try { c = ctx.P1M.classify(ctx.P1, sim, { teleported, touched }); } catch (e) { c = null; }
	if (!c || c.id === undefined || c.id < 0) return '';
	return c.kind[0] + c.id;
}

// ------------------------------------------------------------------ the placement (the respawn's rule)
/** a ball placed at rest at (px, py) from the start state, SETTLE ticks without input; the sim holds the result. q: the
 *  gravity queue's tile (a ball resting there: its current tile, so a side / up arrow pulls from the first tick; part 1's
 *  records, supports.js edgeSupports), flip: the gravity effect's flip (part 1's supports of flips 1-4); absent: as before */
function place(ctx, px, py, q, flip) {
	const sim = ctx.sim, inp = ctx.inp;
	sim.restore(ctx.start);
	sim.modifier_x = 0; sim.modifier_y = 0;
	sim.speed_x = 0; sim.speed_y = 0;
	sim._tileQueue.length = 0;
	if (q !== undefined) { sim._q0 = q; sim._q1 = q; }
	if (flip !== undefined) sim.flip_gravity = flip;
	sim.px = px; sim.py = py;
	sim.teleported = true;
	E.applyMask(inp, 0);
	for (let t = 0; t < ctx.o.settle; t++) { sim.tick(inp); if (sim.is_dead) return false; }
	return true;
}

/**
 * THE DEFAULT SUPPORTS (round 0): the start, then every tile whose rest placement stays there alive in a support class
 * (G anywhere; W / C / Z / B on the region's border). Records {i, tile, cls, kind, px, py} (no state: supportState makes it)
 */
function staticSupports(ctx) {
	const { W, H, N, sim, flags, L } = ctx;
	const out = [];
	sim.restore(ctx.start);
	out.push({ i: 0, tile: tileOf(sim, W, H), cls: clsOf(sim, flags), vc: vcOf(sim.speed_x, sim.speed_y), kind: 'start' });
	const fg = L.fg;
	const fcls = (id) => { const f = id >= 0 && id < flags.length ? flags[id] : 0; return f & F_LIQUID ? 'W' : f & F_CLIMB ? 'C' : DOTS.has(id) ? 'Z' : f & F_BOOST ? 'B' : ''; };
	const seen = new Set([`${out[0].tile},${out[0].cls},${out[0].vc}`]);
	for (let t = 0; t < N; t++) {
		const id = fg[t];
		if ((flags[id] | 0) & F_SOLID) continue;
		const x = t % W, y = (t / W) | 0;
		const fc = fcls(id);
		if (fc) {
			// a field tile: a support only on the region's border (a 4-neighbour of another class)
			let border = false;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const u = x + dx, v = y + dy;
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				if (fcls(fg[v * W + u]) !== fc) { border = true; break; }
			}
			if (!border) continue;
		}
		// the centred placement, then the overhangs: the centre stays in the tile for px + 8 in [16 x, 16 x + 15], so a
		// box can stand on a neighbour's floor with its centre over a gap (a spike, a ledge's edge): px = 16 x - 8 / + 7
		// (and py for a floor beside the ball: side gravity)
		for (const [ox, oy] of PLACE_OFFS) {
			if (!place(ctx, 16 * x + ox, 16 * y + oy)) continue;
			if (tileOf(sim, W, H) !== t) continue;
			const c = clsOf(sim, flags);
			if (!SUP_CLS.has(c)) continue;
			const key = `${t},${c},${vcOf(sim.speed_x, sim.speed_y)}`;
			if (seen.has(key)) break;
			seen.add(key);
			out.push({ i: out.length, tile: t, cls: c, vc: vcOf(sim.speed_x, sim.speed_y), kind: 'rest', px: 16 * x + ox, py: 16 * y + oy, p1: p1Of(ctx, sim, false, -1) });
			break;
		}
	}
	return out;
}
const PLACE_OFFS = [[0, 0], [-8, 0], [7, 0], [0, -8], [0, 7]];

/** the representative state of support i (memoised snapshots; an 'arrive' support replays its origin edge) */
function supportState(ctx, i) {
	let s = ctx.snaps.get(i);
	if (s) return s;
	const u = ctx.sups[i], sim = ctx.sim;
	if (u.kind === 'start') { s = ctx.start; }
	else if (u.kind === 'rest') { if (!place(ctx, u.px, u.py, u.q, u.flip)) return null; s = sim.snapshot(); }
	else if (u.kind === 'arrive') {
		const from = supportState(ctx, u.org.f);
		if (!from) return null;
		sim.restore(from);
		const ms = masksOf(u.org.m);
		for (let t = 0; t < ms.length; t++) { E.applyMask(ctx.inp, ms[t]); sim.tick(ctx.inp); }
		s = sim.snapshot();
	} else if (u.snap) s = u.snap;
	else return null;
	ctx.snaps.set(i, s);
	return s;
}

// ------------------------------------------------------------------ one edge's replay facts
/**
 * replay masks from snap: the end (tile, cls, the exact state), the triggers touched, the gates the box met, a death.
 * The box's gates: the 4 tiles under the 16 x 16 box and the ring around it (a door the ball rested against counts)
 */
function factsOf(ctx, snap, masks) {
	const { sim, inp, W, H, trigAt, gateAt } = ctx;
	sim.restore(snap);
	const tr = [], g = [];
	let died = 0, tele = false;
	for (let t = 0; t < masks.length; t++) {
		const px = sim.px, py = sim.py;
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		if (sim.is_dead) died = 1;
		tele = !sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX);
		const x = sim._pastx, y = sim._pasty;
		if (x >= 0 && y >= 0 && x < W && y < H) { const k = trigAt[y * W + x]; if (k >= 0 && !tr.includes(k)) tr.push(k); }
		if (gateAt.length) {
			const x0 = Math.floor(sim.px / 16) - 1, y0 = Math.floor(sim.py / 16) - 1;
			for (let v = y0; v <= y0 + 3; v++) for (let u = x0; u <= x0 + 3; u++) {
				if (u < 0 || v < 0 || u >= W || v >= H) continue;
				const k = gateAt[v * W + u];
				if (k >= 0 && !g.includes(k)) g.push(k);
			}
		}
	}
	const pt = sim._pastx >= 0 && sim._pasty >= 0 && sim._pastx < W && sim._pasty < H ? sim._pasty * W + sim._pastx : -1;
	return { tile: tileOf(sim, W, H), cls: clsOf(sim, ctx.flags), end: [sim.px, sim.py, sim.speed_x, sim.speed_y], tr, g, d: died, hash: sim.stateHash(), p1: p1Of(ctx, sim, tele, pt) };
}

// ------------------------------------------------------------------ the families
/** the event after a tick: 'land' | 'cls' | 'tele' | 'dead' | null */
function eventOf(sim, flags, c0, px, py, air) {
	if (sim.is_dead) return 'dead';
	if (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX) return 'tele';
	const c = clsOf(sim, flags);
	if (c !== c0 && c !== 'A') return 'cls';
	if (sim.on_ground && air) return 'land';
	return null;
}
/** play on through the dead ticks to the respawn (no input); the masks grow; false: no respawn within DEAD_MAX */
function toRespawn(ctx, ms) {
	const { sim, inp } = ctx;
	E.applyMask(inp, 0);
	for (let t = 0; t < DEAD_MAX; t++) { sim.tick(inp); ms.push(0); if (!sim.is_dead) return true; }
	return false;
}
/** 'event': the 18 held masks to their first support event (deaths to the respawn) */
function eventFamily(ctx, snap, out) {
	const { sim, inp, flags } = ctx, maxT = ctx.o.eventT;
	for (const p0 of [0, 1]) for (const m0 of DIR9) {
		sim.restore(snap);
		const c0 = clsOf(sim, flags);
		let air = !sim.on_ground || sim.speed_y !== 0 || p0 === 1;
		const ms = [];
		for (let t = 0; t < maxT; t++) {
			const px = sim.px, py = sim.py;
			const mk = t === 0 ? (m0 | p0) : m0;
			E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
			const ev = eventOf(sim, flags, c0, px, py, air && t > 0);
			if (ev === 'dead') { if (toRespawn(ctx, ms)) out.push({ k: 'death', masks: Uint8Array.from(ms), T: ms.length, dies: 1 }); break; }
			if (ev) { out.push({ k: 'event', masks: Uint8Array.from(ms), T: ms.length }); break; }
			if (!sim.on_ground) air = true;
		}
	}
}
/**
 * 'one': the one-change words a^c b (a, b in the 9 directions, the press on tick 1 or not), prefix shared, each to its
 * first support event within oneT ticks; the cheapest per end (tile, class) kept
 */
function oneFamily(ctx, snap, out) {
	const { sim, inp, flags, W, H } = ctx, maxT = ctx.o.oneT;
	const best = new Map();
	const keep = (ms, dies) => {
		const k = dies ? 'R' : `${tileOf(sim, W, H)},${clsOf(sim, flags)}`;
		const b = best.get(k);
		if (!b || ms.length < b.T) best.set(k, { k: dies ? 'death' : 'one', masks: Uint8Array.from(ms), T: ms.length, dies });
	};
	const pre = [];
	for (const p0 of [0, 1]) for (const a of DIR9) {
		sim.restore(snap);
		const c0 = clsOf(sim, flags);
		let air = !sim.on_ground || sim.speed_y !== 0 || p0 === 1;
		const ms = [];
		// the prefix a^c: its snapshots, stopped at its own first event (the held word: 'event' has it)
		pre.length = 0;
		for (let c = 1; c < maxT; c++) {
			const px = sim.px, py = sim.py;
			const mk = c === 1 ? (a | p0) : a;
			E.applyMask(inp, mk); sim.tick(inp); ms.push(mk);
			const ev = eventOf(sim, flags, c0, px, py, air && c > 1);
			if (ev) break;
			if (!sim.on_ground) air = true;
			pre.push({ snap: sim.snapshot(), air, n: ms.length });
		}
		for (const q of pre) {
			for (const b of DIR9) {
				if (b === a) continue;
				sim.restore(q.snap);
				let air2 = q.air;
				const ms2 = ms.slice(0, q.n);
				for (let t = q.n; t < maxT; t++) {
					const px = sim.px, py = sim.py;
					E.applyMask(inp, b); sim.tick(inp); ms2.push(b);
					const ev = eventOf(sim, flags, c0, px, py, air2);
					if (ev === 'dead') { if (toRespawn(ctx, ms2)) keep(ms2, 1); break; }
					if (ev) { keep(ms2, 0); break; }
					if (!sim.on_ground) air2 = true;
				}
			}
		}
	}
	for (const v of best.values()) out.push(v);
}
/** 'land': msolve's forward fan-out (plain starts) */
function landFamily(ctx, snap, out) {
	const o = ctx.o;
	let r = [];
	try { r = ctx.S.landings(snap, { Tmax: o.landT, K: o.landK, max: o.landMax, nodes: o.landNodes, overhang: true }); } catch (e) { r = []; }
	for (const e of r) out.push({ k: 'land', masks: e.masks, T: e.masks.length, hop: e.hop ? 1 : 0 });
	// the precise near landings: two x changes (run, brake, stop: a landing window a few px wide, a spike staircase's
	// overhangs) to the land2Max standable tiles nearest the ball, a budget of their own
	if (o.land2Max > 0) {
		const sim = ctx.S.sim;
		sim.restore(snap);
		const here = (Math.trunc(sim.py + 8) >> 4) * ctx.W + (Math.trunc(sim.px + 8) >> 4);
		let r2 = [];
		try { r2 = ctx.S.landings(snap, { Tmax: o.landT, K: 2, max: o.land2Max, nodes: o.land2Nodes, overhang: true, toward: { tiles: [here] } }); } catch (e) { r2 = []; }
		for (const e of r2) out.push({ k: 'land2', masks: e.masks, T: e.masks.length, hop: e.hop ? 1 : 0 });
	}
}
/**
 * 'reach': the directed plain legs to the G support tiles no family edge of this support landed on (msolve's fan-out
 * takes only tiles with a floor right under the centre: a ball standing on a neighbour's floor with its centre over a gap,
 * a spike or a ledge's edge, is a support it never targets), within the plain extremes' box and msolve's certified plain
 * bound (<= landT): the pairs a move can connect
 */
function reachFamily(ctx, snap, out, done) {
	const { sim, W, S } = ctx, o = ctx.o;
	if (!ctx.gTiles) {
		const s = new Set();
		for (const u of ctx.sups) if (u.cls === 'G' && u.kind !== 'arrive') s.add(u.tile);
		ctx.gTiles = Array.from(s).sort((a, b) => a - b);
	}
	sim.restore(snap);
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	const RX = Math.ceil((o.landT * 7.3) / 16) + 1, UP = 6, DN = Math.ceil((o.landT * 13.6) / 16) + 1;
	let n = 0;
	for (const t of ctx.gTiles) {
		if (done.has(t)) continue;
		const x = t % W, y = (t / W) | 0;
		if (Math.abs(x - cx) > RX || y < cy - UP || y > cy + DN || (x === cx && y === cy)) continue;
		const tg = { tiles: [t], cls: 'G' };
		let lb = 0;
		try { lb = S.lowerBound(snap, tg); } catch (e) { lb = 0; }
		if (lb > o.landT) continue;
		if (++n > o.reachMax) break;
		let r = null;
		try { r = S.leg(snap, tg, { Tmax: o.landT, K: o.reachK, chain: false, fields: false, coupled: false, nodes: o.reachNodes }); } catch (e) { r = null; }
		if (r && r.ok) out.push({ k: 'reach', masks: r.masks, T: r.T, hop: r.hop ? 1 : 0 });
	}
}

/**
 * 'touch': the trigger components within the bound that no family edge of this support touched already, by the msolve
 * leg's plain tier (plain supports only: a field support's touches are its family edges' `tr`)
 */
function touchFamily(ctx, snap, sup, out, done) {
	const { sim, W, H, triggers, S } = ctx, o = ctx.o;
	if (!triggers.length) return;
	sim.restore(snap);
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	const here = tileOf(sim, W, H);
	for (const X of triggers) {
		if (done && done.has(X.id)) continue;
		// the speed-limit bound: the centre moves at most 16.25 px an axis a tick (model.js lbOfSteps on the Chebyshev steps)
		let d = Infinity;
		for (const t of X.tiles) { if (t === here) { d = 0; break; } const e = Math.max(Math.abs((t % W) - cx), Math.abs(((t / W) | 0) - cy)); if (e < d) d = e; }
		if (d === 0) continue;
		const lbv = Math.max(0, Math.ceil((16 * (d - 1)) / 16.25 - 1e-9));
		if (lbv > o.touchT) continue;
		const tg = { tiles: X.tiles, cls: 'any' };
		// the certified plain bound (THEOREM M / the fall table): a pair no move connects within touchT is cut here
		let pb = 0;
		try { pb = S.lowerBound(snap, tg); } catch (e) { pb = 0; }
		if (pb > o.touchT) continue;
		let r = null;
		try { r = S.leg(snap, tg, { Tmax: o.touchT, chain: false, fields: false, coupled: false, nodes: o.touchNodes }); } catch (e) { r = null; }
		if (r && r.ok) out.push({ k: 'touch', masks: r.masks, T: r.T, trig: X.id, tool: r.tool, proven: r.proven ? 1 : 0 });
	}
}

/** the speed class of an end state: the x speed's sign and rounded size (0 .. 7 px/tick), rising / level / falling */
function vcOf(vx, vy) {
	const s = vx > 0.25 ? '+' + Math.min(7, Math.round(vx)) : vx < -0.25 ? '-' + Math.min(7, Math.round(-vx)) : '0';
	return s + (vy < -0.25 ? 'u' : vy > 0.25 ? 'd' : 'n');
}
/** every edge from support i (its families; each replayed for its facts) */
function edgesFrom(ctx, i) {
	const snap = supportState(ctx, i);
	if (!snap) return [];
	const sup = ctx.sups[i];
	const raw = [];
	ctx.sim.restore(snap);
	const plain = !!ctx.S.plainStart(ctx.sim);
	if (plain) landFamily(ctx, snap, raw);
	eventFamily(ctx, snap, raw);
	if (!plain) oneFamily(ctx, snap, raw);
	const out = [];
	const seen = new Set(), touched = new Set();
	const push = (r) => {
		const f = factsOf(ctx, snap, r.masks);
		const dup = `${r.k === 'touch' ? 'T' + r.trig : ''}|${f.hash}|${r.T}`;
		if (seen.has(dup)) return;
		seen.add(dup);
		for (const k of f.tr) touched.add(k);
		const e = { f: i, k: r.k, tile: f.tile, cls: r.dies ? 'R' : f.cls, vc: vcOf(f.end[2], f.end[3]), T: r.T, m: rleOf(r.masks), end: f.end, tr: f.tr, g: f.g, d: f.d };
		if (f.p1 !== undefined) e.p1 = f.p1;
		if (r.k === 'touch') { e.trig = r.trig; e.tool = r.tool; if (r.proven) e.proven = 1; }
		out.push(e);
	};
	const pushHop = (r) => {
		push(r);
		// the landing hop (the jump on the landing tick): another end state on the same support, its own edge
		if (r.hop) { const hm = Uint8Array.from(r.masks); hm[hm.length - 1] |= 1; push({ k: 'hop', masks: hm, T: hm.length }); }
	};
	for (const r of raw) pushHop(r);
	if (plain && ctx.o.reach) {
		const landed = new Set();
		for (const e of out) if (e.cls === 'G') landed.add(e.tile);
		const rr = [];
		reachFamily(ctx, snap, rr, landed);
		for (const r of rr) pushHop(r);
	}
	if (plain && ctx.o.touch !== false) {
		const tr = [];
		touchFamily(ctx, snap, sup, tr, touched);
		for (const r of tr) push(r);
	}
	return out;
}

// ------------------------------------------------------------------ the graph (rounds; the index of supports)
/**
 * link edges to supports by (tile, class, speed class); an end no support holds becomes an 'arrive' support (the cheapest
 * edge per key, at most o.arriveMax supports per (tile, class), o.maxNew a round; deterministic), else it links to the
 * (tile, class)'s first support with e.x = 1 (the representative differs: its next move is re-verified from the real state)
 */
function linkRound(sups, byKey, edges, from, grow, o) {
	const byTC = new Map();
	for (const u of sups) { const k = `${u.tile},${u.cls}`; if (!byTC.has(k)) byTC.set(k, []); byTC.get(k).push(u.i); }
	const fresh = new Map();
	for (let n = from; n < edges.length; n++) {
		const e = edges[n];
		if (e.cls === 'R') { e.to = -1; continue; }
		if (e.k === 'touch') { e.to = -2 - e.trig; continue; }
		const key = `${e.tile},${e.cls},${e.vc}`;
		if (byKey.has(key)) { e.to = byKey.get(key); continue; }
		if (!SUP_CLS.has(e.cls) || !grow) continue;
		const b = fresh.get(key);
		if (!b || e.T < b.T || (e.T === b.T && (e.f < b.f || (e.f === b.f && n < b.n)))) fresh.set(key, { T: e.T, f: e.f, n });
	}
	// the new classes, the cheapest first, at most arriveMax supports a (tile, class) and maxNew a round
	const keys = Array.from(fresh.keys()).sort((a, b) => fresh.get(a).T - fresh.get(b).T || (a < b ? -1 : a > b ? 1 : 0));
	const added = [];
	for (const key of keys) {
		if (added.length >= o.maxNew) break;
		const b = fresh.get(key), e = edges[b.n];
		const tc = `${e.tile},${e.cls}`;
		if (!byTC.has(tc)) byTC.set(tc, []);
		if (byTC.get(tc).length >= o.arriveMax) continue;
		const i = sups.length;
		sups.push({ i, tile: e.tile, cls: e.cls, vc: e.vc, kind: 'arrive', org: { f: e.f, m: e.m }, p1: e.p1 });
		byKey.set(key, i);
		byTC.get(tc).push(i);
		added.push(i);
	}
	for (let n = from; n < edges.length; n++) {
		const e = edges[n];
		if (e.to !== undefined) continue;
		const k = byKey.get(`${e.tile},${e.cls},${e.vc}`);
		if (k !== undefined) { e.to = k; continue; }
		const l = byTC.get(`${e.tile},${e.cls}`);
		if (l && l.length) { e.to = l[0]; e.x = 1; } else e.to = -3;
	}
	return added;
}

/** the whole build in this thread (tests, small levels; the workers run edgesFrom per support the same way) */
function buildLocal(src, o = {}) {
	const L = levelOf(src);
	const t0 = Date.now();
	const ctx = ctxOf(L, o);
	const sups = o.supports || staticSupports(ctx);
	ctx.sups = sups;
	const byKey = new Map(sups.map((u) => [`${u.tile},${u.cls},${u.vc}`, u.i]));
	const edges = [];
	let todo = sups.map((u) => u.i);
	const rounds = [];
	for (let r = 0; r <= ctx.o.rounds && todo.length; r++) {
		const r0 = Date.now(), e0 = edges.length;
		for (const i of todo) for (const e of edgesFrom(ctx, i)) edges.push(e);
		todo = linkRound(sups, byKey, edges, e0, r < ctx.o.rounds, ctx.o);
		rounds.push({ r, sups: todo.length, edges: edges.length - e0, ms: Date.now() - r0 });
	}
	return finish(src, L, sups, edges, { ms: Date.now() - t0, threads: 1, rounds, supMs: 0 }, ctx.o);
}

function finish(src, L, sups, edges, st, o) {
	const byKind = {}, supKind = {};
	const p1 = { edges: 0, sups: 0, classes: 0 };
	const p1s = new Set();
	for (const e of edges) { byKind[e.k] = (byKind[e.k] || 0) + 1; if (e.p1) { p1.edges++; p1s.add(e.p1); } }
	for (const u of sups) if (u.p1) { p1.sups++; p1s.add(u.p1); }
	p1.classes = p1s.size;
	st.p1 = p1;
	for (const u of sups) supKind[u.kind + ':' + u.cls] = (supKind[u.kind + ':' + u.cls] || 0) + 1;
	const mem = process.memoryUsage();
	let maxRss = 0;
	try { maxRss = process.resourceUsage().maxRSS * 1024; } catch (e) { maxRss = mem.rss; }
	const stats = Object.assign({ sups: sups.length, edges: edges.length, byKind, supKind, rssMB: Math.round(mem.rss / 1048576), maxRssMB: Math.round(maxRss / 1048576) }, st);
	return { v: VERSION, md5: md5OfLevel(src, L), W: L.width, H: L.height, opts: optsKey(o), sups, edges, stats };
}
function optsKey(o) {
	const q = Object.assign({}, DEF, o);
	const k = { touch: q.touch !== false, ext: !!o.supports };
	for (const n of Object.keys(DEF)) k[n] = q[n];
	return k;
}
function cacheFile(dir, md5, o) {
	const h = crypto.createHash('md5').update(JSON.stringify(optsKey(o)) + VERSION).digest('hex').slice(0, 10);
	return path.join(dir, `${md5}.${h}.edges.json.gz`);
}
function saveGraph(file, g) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(g))));
}
function loadGraph(file) {
	try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()); } catch (e) { return null; }
}

// ------------------------------------------------------------------ the parallel build (worker threads)
/**
 * buildGraph(src, o): the static supports in this thread, then each round's supports in chunks over o.threads workers
 * (each its own engine and solver, the same deterministic supports: an 'arrive' support's origin edge replayed there);
 * the result cached per level md5 and the options (o.cache).
 */
async function buildGraph(src, o = {}) {
	const L = levelOf(src);
	const md5 = md5OfLevel(src, L);
	if (o.cache && !o.supports) {
		const f = cacheFile(o.cache, md5, o);
		const g = loadGraph(f);
		if (g && g.v === VERSION) { g.stats.cached = true; return g; }
	}
	const threads = Math.max(1, o.threads || Math.min(16, os.cpus().length - 1));
	if (threads <= 1 || typeof src !== 'string') {
		const g = buildLocal(src, o);
		if (o.cache && !o.supports) saveGraph(cacheFile(o.cache, md5, o), g);
		return g;
	}
	const { Worker } = require('worker_threads');
	const t0 = Date.now();
	const ctx = ctxOf(L, o);
	const sups = o.supports || staticSupports(ctx);
	const supMs = Date.now() - t0;
	const byKey = new Map(sups.map((u) => [`${u.tile},${u.cls},${u.vc}`, u.i]));
	const edges = [];
	const wo = Object.assign({}, o);
	delete wo.supports; delete wo.cache;
	const workers = [];
	for (let w = 0; w < threads; w++) workers.push(new Worker(__filename, { workerData: { oneshotEdges: { file: src, o: wo } } }));
	const rounds = [];
	const chunk = Math.max(1, o.chunk || 8);
	const perW = new Array(threads).fill(0);
	try {
		let todo = sups.map((u) => u.i);
		for (let r = 0; r <= ctx.o.rounds && todo.length; r++) {
			const r0 = Date.now(), e0 = edges.length;
			// the supports known so far go to every worker (the 'arrive' ones' origins), then chunks on demand
			const res = new Map();
			await new Promise((resolve, reject) => {
				let next = 0, busy = 0;
				const give = (w) => {
					if (next >= todo.length) { if (busy === 0) resolve(); return; }
					const part = todo.slice(next, next + chunk);
					next += part.length; busy++;
					workers[w].postMessage({ cmd: 'edges', ids: part });
				};
				workers.forEach((wk, w) => {
					wk.removeAllListeners('message'); wk.removeAllListeners('error');
					wk.on('message', (m) => {
						if (m.cmd === 'edges') { busy--; perW[w] += m.ms; for (const [i, es] of m.out) res.set(i, es); give(w); }
					});
					wk.on('error', reject);
					wk.postMessage({ cmd: 'sups', sups });
				});
				workers.forEach((wk, w) => give(w));
				if (todo.length === 0) resolve();
			});
			for (const i of todo) for (const e of res.get(i) || []) edges.push(e);
			todo = linkRound(sups, byKey, edges, e0, r < ctx.o.rounds, ctx.o);
			rounds.push({ r, newSups: todo.length, edges: edges.length - e0, ms: Date.now() - r0 });
		}
	} finally {
		for (const wk of workers) wk.terminate();
	}
	const g = finish(src, L, sups, edges, { ms: Date.now() - t0, supMs, threads, rounds, workerMs: perW }, ctx.o);
	if (o.cache && !o.supports) saveGraph(cacheFile(o.cache, md5, o), g);
	return g;
}

// ------------------------------------------------------------------ the graph's use (the one-shot search, part 3)
/** play an edge's input from sim's current state: the first tick (1-based) its end (tile, class) holds, 0 a miss */
function applyEdge(sim, e, W, H) {
	const inp = new E.EEInput(), ms = masksOf(e.m), flags = sim._flags;
	for (let t = 0; t < ms.length; t++) {
		E.applyMask(inp, ms[t]); sim.tick(inp);
		if (e.cls === 'R') { if (t > 0 && !sim.is_dead && sim.deaths > 0 && t + 1 === ms.length) return t + 1; continue; }
		if (sim.is_dead) return 0;
		if (tileOf(sim, W, H) === e.tile && (e.cls === 'any' || e.k === 'touch' || clsOf(sim, flags) === e.cls)) return t + 1;
	}
	return 0;
}
/** the lazy verification's fallback: the move solver from snap to the edge's end (touch: the trigger's tiles) */
function resolveEdge(S, snap, e, o = {}, triggers = null) {
	const tiles = e.k === 'touch' && triggers ? triggers[e.trig].tiles : [e.tile];
	const cls = e.k === 'touch' ? 'any' : e.cls;
	return S.leg(snap, { tiles, cls }, Object.assign({ Tmax: Math.max(e.T + 20, 60), chain: false }, o));
}

// ------------------------------------------------------------------ the worker
const WT = (() => { try { return require('worker_threads'); } catch (e) { return null; } })();
if (WT && !WT.isMainThread && WT.workerData && WT.workerData.oneshotEdges && WT.parentPort) {
	const wd = WT.workerData.oneshotEdges;
	const L = levelOf(wd.file);
	const ctx = ctxOf(L, wd.o || {});
	WT.parentPort.on('message', (m) => {
		if (m.cmd === 'sups') { ctx.sups = m.sups; return; }
		if (m.cmd === 'edges') {
			const t0 = Date.now(), out = [];
			for (const i of m.ids) { let es = []; try { es = edgesFrom(ctx, i); } catch (e) { es = []; } out.push([i, es]); }
			WT.parentPort.postMessage({ cmd: 'edges', out, ms: Date.now() - t0 });
		}
	});
}

module.exports = { buildGraph, buildLocal, ctxOf, staticSupports, supportState, edgesFrom, reachFamily, landFamily, eventFamily, oneFamily, touchFamily, factsOf, applyEdge, resolveEdge, rleOf, masksOf, clsOf, tileOf, loadGraph, saveGraph, cacheFile, md5OfLevel, DEF };

// ------------------------------------------------------------------ CLI
if (require.main === module && (!WT || WT.isMainThread)) {
	const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : ['_' + a, a]; }));
	const file = Object.keys(argv).filter((k) => k.startsWith('_')).map((k) => argv[k])[0];
	if (!file) { console.error('usage: node src/plan/oneshot/edges.js <level> [--threads=N] [--rounds=2] [--cache=dir] [--json] [--out=graph.json.gz]'); process.exit(1); }
	const o = {};
	for (const k of ['threads', 'chunk', ...Object.keys(DEF)]) if (argv[k] !== undefined) o[k] = +argv[k];
	if (argv.touch === '0') o.touch = false;
	if (argv.cache) o.cache = argv.cache;
	buildGraph(file, o).then((g) => {
		if (argv.out) saveGraph(argv.out, g);
		const s = g.stats;
		if (argv.json) console.log(JSON.stringify(Object.assign({ level: path.basename(file), md5: g.md5, W: g.W, H: g.H }, s)));
		else {
			console.log(`${path.basename(file)} ${g.W}x${g.H} md5 ${g.md5}`);
			console.log(`supports ${s.sups} ${JSON.stringify(s.supKind)}`);
			console.log(`edges ${s.edges} ${JSON.stringify(s.byKind)}`);
			console.log(`build ${s.ms} ms on ${s.threads} threads (supports ${s.supMs || 0} ms) rounds ${JSON.stringify(s.rounds)}; rss ${s.rssMB} MB, peak ${s.maxRssMB} MB${s.cached ? ' (cached)' : ''}`);
		}
	}).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
