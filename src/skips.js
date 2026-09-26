'use strict';
// Skip search: route skips found on purpose, through "entrances".
//
// A route skip leaves the run, reaches a place the run only reaches much later, and joins the run there. The explorers
// find such skips only by luck: a skip is a chain of precise moves (a landing on the far end of a ledge the run falls
// past, a hop that builds speed on it, a jump over a gap, a landing-tick jump...), and every tool that scores states by
// how far along the run they are sees a valley where the chain starts, while a random rollout rarely strings the moves
// together. This tool aims at them in three steps:
//   1. Windows: where the run passes near a spot it touches much later (a "contact": a landing, or a wall that stops
//      it), within --R px, 40-900 ticks earlier (slack = the gap - distance / 8), and the run's loops (loops.js, 48 and
//      96 px); the --scan best by slack, each starting --lead0 ticks before its pass-by.
//   2. Entrances: every move from the run's state at the window's start (a breadth-first search by tick: each state gets
//      every input that can act, endgame.js probeMasks; a child is kept only if its cell (1 px, 1/4 px/tick, on the
//      ground, jumps, gravity queue, context) was not reached at an earlier or the same tick), for --span ticks, inside
//      a tube of --margin tiles around the run's path. A state that touches a contact spot of the run (a landing on the
//      same floor within --cr px, a stop at the same wall) at least --minLead ticks before the run does is a contact
//      entrance; one within --nearD (|dpos| + 3|dvel|) of a run state that far ahead a near entrance. Tails (below)
//      already run here. The windows are ranked by their best entrance.
//   3. Routes: for the --top windows, --K entrances each: the corners of what the search reached (per tick and landed
//      / jumped: min / max of x + vx, of vx, of x; time-optimal moves ride the edge of the reachable set, like the far
//      end of a ledge and the fastest speed either way), contacts first. From each, every move again on its own (the
//      cells merge states, and which state stands for a cell decides whether a chain of precise moves survives:
//      separate searches keep different ones; --salts=N also shifts the cell grid), until --cap2 ticks, inside a tube of
//      --margin2 tiles around the run's path after the contact and --around tiles around the entrance. The windows
//      take turns, the best entrances first.
// Every state equal to a later run state (stateHash) is a proven shortcut; from every new cell within --tailD of a run
// state at least --minLeadTail ticks later, the run's own inputs are replayed from next to it (tails: offsets -2..2,
// --tailH ticks, re-anchored up to --anchors times like mutate --anchor: at a landing or a wall stop the tail goes on
// with the inputs of the nearest run state within --athr) and checked every tick for an exact rejoin. Every exact
// rejoin is an edge b -> j (b = the window's start); the edges are combined by DP over the run's ticks and the result is
// replayed (C.evaluate) and accepted by THE rule (C.judge) before it is written, with the edges in <out>.edges.json
// (explore.js's format). --targets=<run.eetas,...> (the grind passes the job's earlier bests): a state equal to one of
// those runs' states, or a tail along one of them that meets it exactly, makes a whole run (the reference up to the
// window, the inputs found, that run's inputs from there), judged; a skip's way on after the contact need not be the
// reference's own.
//
// Forgotten Veil from best_11257, the "mini 10" room at 0:57.5 (the 88-tick skip that was found once, by the GPU's
// exhaustive explore, and that no CPU tool rediscovered): the run falls down a shaft 2 px past a 2-tile ledge and lands
// on it 136 ticks later, after a detour to the left. The window ranks 4th; its entrances: the ledge landings; routes
// from the ones at the ledge's far end, moving away (a hop on the ledge builds the speed to clear the gap, then a
// landing-tick jump on an arrow corner): -83 after 48 s on 4 threads (after 165 s and 52.6 M simulated ticks on 1),
// -84 after 95 s (without re-anchored tails -58 / -59 from the same entrances); the next mutate makes -94 of it (11163,
// better than the 11169 found once). From a run that differs a few ticks there (11245: the same skip is -80 in it) no
// route rejoins that run in 96 searches (4 grids / cell sizes: the chain is lost at the arrow corner, and the run's own
// way on is too far from the searches' states for tails); with its earlier bests as --targets: -49 after 62 s on 4
// threads (11192 = -53 after a splice with it). Not found here: Octorage's loop skip (explore on the loop window finds
// it) and Infinity Pain's long route changes (hundreds of ticks of other route before anything is ahead).
//
// usage: node src/skips.js --tas=<run.eetas> [--level=<level id | job id>] [--out=<file>] [--nocoins=0|1]
//        [--windows=auto | <tick>,<tick>,...] [--scan=24] [--top=6] [--K=24] [--span=80] [--lead0=50] [--R=96]
//        [--minLead=30] [--cap1=1000000] [--cap2=1200000] [--H=300] [--q=1] [--qv=0.25] [--margin=3] [--margin2=2]
//        [--around=5] [--cr=24] [--nearD=24] [--tailD=12] [--tailH=300] [--anchors=2] [--athr=8] [--salts=1] [--kpc=1]
//        [--targets=<run.eetas,...>] [--workers=4] [--seconds=180] [--from=] [--to=]
// (--kpc: up to that many different states per cell.)
// (--windows=<ticks>: the entrance searches start at these ticks, no pass-by ranking; --from/--to: only windows starting
// in that range.) Prints [skips] lines and [ticks] N every second.
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const EG = require('./endgame.js');
const LP = require('./loops.js');
const E = C.E;

const DEFAULTS = { windows: 'auto', scan: 24, top: 6, K: 24, span: 80, lead0: 50, minLead: 30, cap1: 1000000, cap2: 1200000, H: 300,
	q: 1, qv: 0.25, margin: 3, margin2: 2, salts: 1, kpc: 1, around: 5, cr: 24, tailD: 12, nearD: 24, tailH: 300, anchors: 2, athr: 8, minLeadTail: 10, workers: 4, seconds: 180, R: 96, from: 0, to: 1e9, maxCells: 6e6 };

// ---------------------------------------------------------------- the reference
const onSet = (m) => {
	if (!m || m.size === 0) return '';
	const ids = [];
	for (const [id, v] of m) if (v === true) ids.push(id);
	return ids.sort((x, y) => x - y).join('.');
};
/** context ids of a sim, cached on the fields that make it (coins unless coin-blind, crown, keys, switches) */
function contexts(nc) {
	const ids = new Map();
	const idOf = (k) => { let v = ids.get(k); if (v === undefined) { v = ids.size + 1; ids.set(k, v); } return v; };
	const key = (s) => (nc ? '' : s.coins + ',' + s.blue_coins + ',') + (s.has_crown ? 1 : 0) + ',' + (s._keysMask | 0) + ',' + onSet(s._switches) + ',' + onSet(s._oswitches);
	let c0 = -1, c1 = -1, c2 = null, c3 = null, c4 = -1, cid = 0;
	return (s) => {
		const k0 = nc ? (s.has_crown ? 1 : 0) : s.coins * 64 + s.blue_coins * 2 + (s.has_crown ? 1 : 0);
		if (k0 === c0 && s._keysMask === c1 && s._switches === c2 && s._oswitches === c3 && s._switches.size === c4) return cid;
		c0 = k0; c1 = s._keysMask; c2 = s._switches; c3 = s._oswitches; c4 = s._switches.size;
		cid = idOf(key(s));
		return cid;
	};
}
/**
 * The run: per tick position, speed, on-ground, context, state hash; snapshots every 64 ticks; the contacts (ground:
 * on the ground after the tick; wall: a wall zeroed a speed of 0.3 px/tick or more) by context and exact py / px;
 * the positions (floored) for the exact-rejoin prefilter; the random-portal draws per tick.
 */
function reference(level, masks, nc, sharedCtx) {
	const n = masks.length;
	const R = { n, masks, X: new Float64Array(n + 1), Y: new Float64Array(n + 1), VX: new Float64Array(n + 1), VY: new Float64Array(n + 1),
		G: new Uint8Array(n + 1), CX: new Int32Array(n + 1), RS: new Int32Array(n + 1), HH: new Float64Array(n + 1), hash: new Map(), snaps: [], finish: -1, first: 0 };
	const ctxOf = sharedCtx || contexts(nc);   // (target runs share the reference's context ids)
	R.ctxOf = ctxOf;
	const s = new E.EESim(level);
	s.reset();
	const inp = new E.EEInput();
	const rec = (j) => { R.X[j] = s.px; R.Y[j] = s.py; R.VX[j] = s.speed_x; R.VY[j] = s.speed_y; R.G[j] = s.on_ground ? 1 : 0; R.CX[j] = ctxOf(s); R.RS[j] = s._rngSteps; };
	rec(0);
	const crown0 = s.has_silver_crown;
	for (let t = 0; t < n; t++) {
		if (t % 64 === 0) R.snaps.push(s.snapshot());
		E.applyMask(inp, masks[t]);
		s.tick(inp);
		rec(t + 1);
		const h = s.stateHash(false, nc);
		R.HH[t + 1] = h;
		if (!R.hash.has(h)) R.hash.set(h, t + 1);
		if (R.finish < 0 && !crown0 && s.has_silver_crown) R.finish = t + 1;
	}
	R.first = Math.max(0, masks.findIndex((m) => m !== 0));   // (the run timer starts at the first input: no edge before it)
	R.pos = new Set();
	for (let j = 0; j <= n; j++) R.pos.add(Math.floor(R.X[j]) * 65536 + Math.floor(R.Y[j]));
	// contacts: context -> Map(exact py -> [x, j, ...]) for the ground, context -> Map(exact px -> [y, j, ...]) for walls
	R.ground = new Map(); R.walls = new Map();
	const add = (m, cid, k, a, j) => { let c = m.get(cid); if (!c) { c = new Map(); m.set(cid, c); } let l = c.get(k); if (!l) { l = []; c.set(k, l); } l.push(a, j); };
	for (let j = 1; j <= n; j++) {
		if (R.G[j]) add(R.ground, R.CX[j], R.Y[j], R.X[j], j);
		if (Math.abs(R.VX[j - 1]) >= 0.3 && R.VX[j] === 0) add(R.walls, R.CX[j], R.X[j], R.Y[j], j);
	}
	/** S(t), the run's state after t ticks, into sim */
	R.stateAt = (sim, t) => {
		const k = Math.min(R.snaps.length - 1, t >> 6);
		sim.restore(R.snaps[k]);
		const inp2 = new E.EEInput();
		for (let u = k * 64; u < t; u++) { E.applyMask(inp2, masks[u]); sim.tick(inp2); }
	};
	return R;
}
/** the earliest run contact after t + minLead that the live state touches (a landing on the same floor within cr px, a
 *  stop at the same wall within cr px): its tick, or -1 */
function contactOf(R, sim, vx0, cid, t, minLead, cr) {
	let bj = -1;
	if (sim.on_ground) {
		const c = R.ground.get(cid), l = c && c.get(sim.py);
		if (l) for (let i = 0; i < l.length; i += 2) { const j = l[i + 1]; if (j >= t + minLead && Math.abs(l[i] - sim.px) <= cr && (bj < 0 || j < bj)) bj = j; }
	}
	if (Math.abs(vx0) >= 0.3 && sim.speed_x === 0) {
		const c = R.walls.get(cid), l = c && c.get(sim.px);
		if (l) for (let i = 0; i < l.length; i += 2) { const j = l[i + 1]; if (j >= t + minLead && Math.abs(l[i] - sim.py) <= cr && (bj < 0 || j < bj)) bj = j; }
	}
	return bj;
}

// ---------------------------------------------------------------- windows
/**
 * Pass-bys: for every contact of the run at j (a landing, or a wall stop), the earliest tick a in [j - 900, j - 40]
 * at which the ball passed within R px of that spot; slack = j - a - dist / 8 (8 px/tick: a fast ball). Plus the run's
 * loops (loops.js, 48 and 96 px) with their length as the slack. Merged per 40 ticks of a, the most slack first.
 */
function windowsOf(level, R, o) {
	const cands = [];
	const lo = Math.max(R.first, 1), n = R.finish > 0 ? R.finish : R.n;
	for (let j = lo + 40; j <= n; j++) {
		const wall = Math.abs(R.VX[j - 1]) >= 0.3 && R.VX[j] === 0, land = R.G[j] && !R.G[j - 1];
		if (!wall && !land) continue;
		for (let a = Math.max(lo, j - 900); a <= j - 40; a++) {
			if (R.CX[a] !== R.CX[j]) continue;
			const d = Math.abs(R.X[a] - R.X[j]) + Math.abs(R.Y[a] - R.Y[j]);
			if (d > o.R) continue;
			cands.push({ a, j, slack: j - a - d / 8, why: `passes ${Math.round(d)} px from where it ${land ? 'lands' : 'hits a wall'} ${j - a} ticks later (tick ${j})` });
			break;
		}
	}
	for (const radius of [48, 96]) {
		let loops = [];
		try { loops = LP.revisits(level, R.masks, { coins: !o.nocoins, radius, max: 1500, keep: 40 }); } catch (e) { /* none */ }
		for (const l of loops) cands.push({ a: l.a, j: l.b, slack: l.len, why: `comes back within ${radius} px ${l.len} ticks later (tick ${l.b})` });
	}
	cands.sort((p, q) => q.slack - p.slack);
	const out = [];
	for (const c of cands) {
		const w = Math.max(R.first, c.a - o.lead0);
		if (w < o.from || w > o.to) continue;
		if (out.some((x) => Math.abs(x.w - w) < 40)) continue;
		out.push(Object.assign({ w }, c));
	}
	return out;
}

// ---------------------------------------------------------------- every move
/**
 * Breadth-first search by tick from seeds (all at tick t0), earliest arrival per cell, inside o.tube (a tile mask: the
 * box centre's tile must be in it). Children that equal a later run state are edges; with o.entrances, kept states that
 * touch a later run contact (or come near a run state well ahead) are collected; with o.tails, new cells near a later
 * run state get tails. o: {b (the window start: edges branch there), t0, until, cap (ticks), tube, q, qv, salt, minLead,
 * cr, nearD, entrances, tails, tailD, tailH, minLeadTail, H, jmin (tails and rejoins only to run ticks >= jmin),
 * maxCells, deadline, onEdge({b, j, seq, at}), meter} -> {ticks, cells, layers, entrances, stop}
 */
function everyMove(R, level, nc, seeds, o) {
	const sim = new E.EESim(level), inp = new E.EEInput();
	const seen = new EG.HashSet(16), KPC = o.kpc | 0, seenK = KPC > 1 ? new Map() : null;
	const ctxOf = R.ctxOf;   // (the run's ids: contacts and nearest() compare them)
	const W = level.width;
	const tube = o.tube, TH = level.height;
	const Q = o.q, QV = o.qv;
	// tails: the nearest later run state by tile
	let byTile = null;
	if (o.tails || o.entrances) {
		byTile = new Map();
		for (let j = Math.max(o.jmin, 0); j <= Math.min(R.n, o.until + o.H); j++) {
			const k = (Math.trunc(R.Y[j] + 8) >> 4) * W + (Math.trunc(R.X[j] + 8) >> 4);
			let l = byTile.get(k);
			if (!l) { l = []; byTile.set(k, l); }
			l.push(j);
		}
	}
	// --salt: the cell grid shifted by a salt-dependent fraction of a cell on each axis (another set of states shares a cell,
	// so another state stands for it: separate searches with other salts keep other precise moves)
	const sf = (k) => (o.salt ? ((Math.imul(o.salt * 4 + k, 0x9E3779B1) >>> 0) % 997) / 997 : 0);
	const ox = sf(0) * Q, oy = sf(1) * Q, ovx = o.salt ? sf(2) * QV - QV / 2 : 0, ovy = o.salt ? sf(3) * QV - QV / 2 : 0;
	const cellKey = (cid) => {
		const a = Math.floor((sim.px + ox) / Q), b = Math.floor((sim.py + oy) / Q), c = Math.round((sim.speed_x + ovx) / QV), d = Math.round((sim.speed_y + ovy) / QV);
		let h = Math.imul(a, 0x9E3779B1) ^ Math.imul(b + 0x7F4A7C15, 0x85EBCA6B);
		h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) ^ Math.imul(c + 1013, 0xC2B2AE35) ^ Math.imul(d + 7919, 0x27D4EB2F);
		const hi = ((sim.on_ground ? 1 : 0) + 2 * Math.min(7, sim.jump_count) + 16 * (sim._q0 & 15) + 256 * (sim._q1 & 15) + 4096 * (cid & 255)) & 0x1FFFFF;
		return hi * 4294967296 + (h >>> 0) + 1;
	};
	const seqOf = (node) => {
		const parts = [];
		let x = node;
		for (; x.p !== null; x = x.p) parts.push(x.m);
		const out = new Uint8Array(x.seq.length + parts.length);
		out.set(x.seq, 0);
		for (let i = 0; i < parts.length; i++) out[x.seq.length + i] = parts[parts.length - 1 - i];
		return out;
	};
	let ticks = 0, cells = 0, layers = 0, stop = '';
	const edge = (node, extra, j) => {
		const s0 = seqOf(node);
		const seq = extra ? new Uint8Array(s0.length + extra.length) : s0;
		if (extra) { seq.set(s0, 0); seq.set(extra, s0.length); }
		if (j - o.b - seq.length <= 0) return;
		o.onEdge({ b: o.b, j, seq, at: ticks });
	};
	const tailed = new EG.HashSet(10);
	// tails: the run's own inputs from next to run tick j0 (offsets -2..2), for up to tailH ticks, an exact rejoin checked
	// every tick. Re-anchored (up to --anchors times, like mutate --anchor): when the tail lands or a wall stops it, it
	// goes on with the inputs of the run tick in [r - 8, r + 150] (same context) whose state is nearest (|dpos| + 3|dvel|
	// < --athr), so a tail that runs a little early or late still meets the run where the run's inputs are timed for.
	const played = new Uint8Array(o.tailH);
	const anchorAt = (r, cid) => {
		let bq = -1, bd = o.athr;
		for (let q = Math.max(o.jmin, r - 8); q <= Math.min(R.n - 1, r + 150); q++) {
			if (R.CX[q] !== cid) continue;
			const d = Math.abs(sim.px - R.X[q]) + Math.abs(sim.py - R.Y[q]) + 3 * (Math.abs(sim.speed_x - R.VX[q]) + Math.abs(sim.speed_y - R.VY[q]));
			if (d < bd) { bd = d; bq = q; }
		}
		return bq;
	};
	const tails = (snap, node, t, j0) => {
		for (let off = -2; off <= 2; off++) {
			const js = j0 + off;
			if (js < o.jmin || js >= R.n) continue;
			sim.restore(snap);
			let anchors = 0, ground = sim.on_ground;
			for (let k = 0, r = js; k < o.tailH && r < R.n; k++) {
				const vx0 = sim.speed_x;
				played[k] = R.masks[r];
				E.applyMask(inp, R.masks[r]);
				sim.tick(inp);
				ticks++;
				r++;
				if (sim.is_dead) break;
				if (R.pos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) {
					const jx = R.hash.get(sim.stateHash(false, nc));
					if (jx !== undefined) { if (jx > t + k + 1) edge(node, played.subarray(0, k + 1), jx); break; }
				}
				if (anchors < o.anchors && ((sim.on_ground && !ground) || (Math.abs(vx0) >= 1 && sim.speed_x === 0))) {
					const q = anchorAt(r, ctxOf(sim));
					if (q >= 0 && q !== r) { r = q; anchors++; }
				}
				ground = sim.on_ground;
				if (r >= R.n || Math.abs(sim.px - R.X[r]) + Math.abs(sim.py - R.Y[r]) > 64) break;
			}
		}
	};
	let nd = Infinity;   // (the distance of the last nearest())
	/** the nearest run state (|dpos| + 3|dvel|, same context) at least minLeadTail ticks later: its tick (-1: none; its
	 *  distance in nd) */
	const nearest = (cid, t) => {
		const px = sim.px, py = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		const tk = (Math.trunc(py + 8) >> 4) * W + (Math.trunc(px + 8) >> 4);
		let bj = -1, bd = Infinity;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const l = byTile.get(tk + dy * W + dx);
				if (!l) continue;
				for (const j of l) {
					if (j < t + o.minLeadTail || R.CX[j] !== cid) continue;
					const d = Math.abs(px - R.X[j]) + Math.abs(py - R.Y[j]) + 3 * (Math.abs(vx - R.VX[j]) + Math.abs(vy - R.VY[j]));
					if (d < bd) { bd = d; bj = j; }
				}
			}
		}
		nd = bd;
		return bj;
	};
	// --targets: other runs of the level (the job's older bests, other jobs' bests). A state equal to one of theirs, or a
	// tail along one of them that meets it exactly, makes a whole run: the reference up to b, the inputs found, the
	// target's inputs from there. Kept when it would finish at least minLeadTail ticks before the reference does (the
	// target may be slower elsewhere: the grind's splice takes the best of both). A skip's way on after the contact
	// then need not be the reference's own (Forgotten Veil: a run a few ticks different there takes the skip only
	// this way).
	const TG = o.targets || [];
	const tgTile = TG.map((T) => {
		const m = new Map();
		for (let j = 1; j <= T.finish; j++) {
			const k = (Math.trunc(T.Y[j] + 8) >> 4) * W + (Math.trunc(T.X[j] + 8) >> 4);
			let l = m.get(k);
			if (!l) { l = []; m.set(k, l); }
			l.push(j);
		}
		return m;
	});
	const targetHit = (node, extra, k, j, t) => {
		const T = TG[k];
		if (t + (T.finish - j) > R.finish - o.minLeadTail) return false;
		const s0 = seqOf(node);
		const seq = extra ? new Uint8Array(s0.length + extra.length) : s0;
		if (extra) { seq.set(s0, 0); seq.set(extra, s0.length); }
		o.onTarget({ b: o.b, k, j, seq, at: ticks });
		return true;
	};
	let tk0 = -1, tj0 = -1;
	/** the nearest target state (within --tailD) from which the target would still finish early enough: in tk0 / tj0 */
	const tgNearest = (cid, t) => {
		const px = sim.px, py = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		const tk = (Math.trunc(py + 8) >> 4) * W + (Math.trunc(px + 8) >> 4);
		let bd = o.tailD + 1e-9;
		tk0 = -1;
		for (let k = 0; k < TG.length; k++) {
			const T = TG[k];
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const l = tgTile[k].get(tk + dy * W + dx);
					if (!l) continue;
					for (const j of l) {
						if (t + (T.finish - j) > R.finish - o.minLeadTail || T.CX[j] !== cid) continue;
						const d = Math.abs(px - T.X[j]) + Math.abs(py - T.Y[j]) + 3 * (Math.abs(vx - T.VX[j]) + Math.abs(vy - T.VY[j]));
						if (d < bd) { bd = d; tk0 = k; tj0 = j; }
					}
				}
			}
		}
		return tk0 >= 0;
	};
	const tgTails = (snap, node, t, k, j0) => {
		const T = TG[k];
		for (let off = -2; off <= 2; off++) {
			const js = j0 + off;
			if (js < 0 || js >= T.finish) continue;
			sim.restore(snap);
			for (let q = 0, r = js; q < o.tailH && r < T.finish; q++, r++) {
				played[q] = T.masks[r];
				E.applyMask(inp, T.masks[r]);
				sim.tick(inp);
				ticks++;
				if (sim.is_dead) break;
				if (T.pos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) {
					const jx = T.hash.get(sim.stateHash(false, nc));
					if (jx !== undefined) { targetHit(node, played.subarray(0, q + 1), k, jx, t + q + 1); break; }
				}
				if (Math.abs(sim.px - T.X[r + 1]) + Math.abs(sim.py - T.Y[r + 1]) > 64) break;
			}
		}
	};
	const tgTailed = TG.length ? new EG.HashSet(10) : null;
	const entrances = new Map();   // (t, 2 px x, 1/4 px/tick vx, vy sign, ground) -> entrance
	let frontier = seeds.map((s) => ({ snap: s.snap, node: { p: null, m: 0, seq: s.seq }, vx: s.vx }));
	for (const f of frontier) { sim.restore(f.snap); seen.add(cellKey(ctxOf(sim))); }
	for (let t = o.t0; t < o.until && frontier.length; t++) {
		if (ticks >= o.cap) { stop = 'cap'; break; }
		if (Date.now() > o.deadline) { stop = 'time'; break; }
		if (seen.size >= o.maxCells) { stop = 'cells'; break; }
		layers++;
		const next = [];
		for (const f of frontier) {
			const ms = EG.probeMasks(sim, inp, f.snap);
			for (let mi = 0; mi < ms.length; mi++) {
				if (mi > 0) { sim.restore(f.snap); E.applyMask(inp, ms[mi]); sim.tick(inp); }
				ticks++;
				if (sim.is_dead) continue;
				{ const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4; if (tx < 0 || ty < 0 || tx >= W || ty >= TH || !tube[ty * W + tx]) continue; }
				if (R.pos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) {
					const h = sim.stateHash(false, nc), jx = R.hash.get(h);
					// (the run's own state at this tick stays: a way off the run may start later; a later run state is a shortcut
					// and the run continues from there; an earlier one is behind it)
					if (jx !== undefined && h !== R.HH[t + 1]) { if (jx > t + 1 && jx >= o.jmin) edge({ p: f.node, m: ms[mi] }, null, jx); continue; }
				}
				if (TG.length) {
					const pk = Math.floor(sim.px) * 65536 + Math.floor(sim.py);
					let h = -1, hit = false;
					for (let k = 0; k < TG.length && !hit; k++) {
						if (!TG[k].pos.has(pk)) continue;
						if (h < 0) h = sim.stateHash(false, nc);
						const jx = TG[k].hash.get(h);
						if (jx !== undefined) hit = targetHit({ p: f.node, m: ms[mi] }, null, k, jx, t + 1);
					}
					if (hit) continue;
				}
				const cid = ctxOf(sim);
				const ck = cellKey(cid);
				if (KPC <= 1) { if (!seen.add(ck)) continue; }
				else {
					// --kpc: up to that many different states per cell (the first ones to get there)
					const h = sim.stateHash(false, nc);
					let l = seenK.get(ck);
					if (l === undefined) { seenK.set(ck, [h]); seen.add(ck); }
					else { if (l.length >= KPC || l.includes(h)) continue; l.push(h); }
				}
				const jn = byTile ? nearest(cid, t + 1) : -1;
				const node = { p: f.node, m: ms[mi] };
				cells++;
				const snap = sim.snapshot();
				next.push({ snap, node, vx: sim.speed_x });
				if (o.entrances) {
					// a contact the run makes later, or (no contact) a state near a run state well ahead
					let j = contactOf(R, sim, f.vx, cid, t + 1, o.minLead, o.cr), kind = 'contact';
					if (j < 0 && jn >= t + 1 + o.minLead && nd <= o.nearD) { j = jn; kind = 'near'; }
					if (j >= 0) {
						const k = `${t + 1}|${Math.floor(sim.px / 2)}|${Math.round(sim.speed_x * 4)}|${Math.sign(sim.speed_y)}|${sim.on_ground ? 1 : 0}`;
						if (!entrances.has(k)) entrances.set(k, { t: t + 1, j, lead: j - (t + 1), kind, px: sim.px, py: sim.py, vx: sim.speed_x, vy: sim.speed_y, ground: sim.on_ground, node });
					}
				}
				if (o.tails && jn >= 0 && nd <= o.tailD && tailed.add(ck)) tails(snap, node, t + 1, jn);
				if (o.tails && TG.length && tgNearest(cid, t + 1) && tgTailed.add(ck)) tgTails(snap, node, t + 1, tk0, tj0);
			}
		}
		frontier = next;
		if (o.meter) o.meter(ticks);
	}
	const ent = [...entrances.values()];
	for (const e of ent) { e.seq = Array.from(seqOf(e.node)); delete e.node; }
	return { ticks, cells, layers, entrances: ent, stop };
}
/** the tube: the tiles within margin tiles (Chebyshev) of the box centre's tile of the run at the ticks of the ranges
 *  [[t0, t1], ...] and of the extra points (px of the box's top-left) */
function tubeOf(level, R, ranges, pts, margin) {
	const W = level.width, H = level.height, tube = new Uint8Array(W * H);
	const mark = (px, py) => {
		const cx = Math.trunc(px + 8) >> 4, cy = Math.trunc(py + 8) >> 4;
		for (let y = Math.max(0, cy - margin); y <= Math.min(H - 1, cy + margin); y++) for (let x = Math.max(0, cx - margin); x <= Math.min(W - 1, cx + margin); x++) tube[y * W + x] = 1;
	};
	for (const [t0, t1] of ranges) for (let t = Math.max(0, t0); t <= Math.min(R.n, t1); t++) mark(R.X[t], R.Y[t]);
	for (const [x, y] of pts) mark(x, y);
	return tube;
}
/** K entrances to search routes from */
function pickEntrances(list, K) {
	// The corners of what the search reached: time-optimal moves ride the edge of the reachable set (the far end of a
	// ledge, the fastest speed either way), and a state in the middle of it is rarely the one a chain of precise moves
	// needs. Groups: the tick, landed or jumped (vy sign) and the kind; each group's corners in (x in tiles, vx):
	// min x + vx, max x + vx, min vx, max vx, min x, max x. Rounds over the groups (the earliest group first), one corner
	// of each group per round. Contacts first (the run itself stands there later; a state merely near a later run state
	// may be on its way down a pit, like Forgotten Veil's jumps off the ledge): half the slots, the rest to the other kind.
	const corners = [(e) => e.px / 16 + e.vx, (e) => -(e.px / 16 + e.vx), (e) => e.vx, (e) => -e.vx, (e) => e.px, (e) => -e.px];
	const pick = (kind, k, taken) => {
		const groups = new Map();
		for (const e of list) {
			if (e.kind !== kind) continue;
			const g = `${e.t}|${Math.sign(e.vy)}`;
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g).push(e);
		}
		const gl = [...groups.values()].sort((p, q) => q[0].lead - p[0].lead || p[0].t - q[0].t);
		const got = [];
		const same = (x, e) => x.t === e.t && Math.abs(x.px - e.px) < 1 && Math.abs(x.vx - e.vx) < 0.05 && Math.sign(x.vy) === Math.sign(e.vy);
		for (let r = 0; r < corners.length && got.length < k; r++) {
			for (const g of gl) {
				if (got.length >= k) break;
				let bestE = null;
				for (const e of g) if (bestE === null || corners[r](e) < corners[r](bestE)) bestE = e;
				if (bestE && !taken.concat(got).some((x) => same(x, bestE))) got.push(bestE);
			}
		}
		return got;
	};
	const c = pick('contact', Math.ceil(K / 2), []);
	const nr = pick('near', K - c.length, c);
	const c2 = c.length + nr.length < K ? pick('contact', K - c.length - nr.length, c.concat(nr)) : [];
	return c.concat(c2, nr);
}

// ---------------------------------------------------------------- the jobs of one search (main thread or a worker)
function runTask(ctx, task) {
	const { R, level, nc, o } = ctx;
	const sim = new E.EESim(level);
	const edges = [];
	const onEdge = (e) => edges.push({ b: e.b, j: e.j, seq: Array.from(e.seq), at: e.at });
	const hits = [];   // (--targets) whole runs through another run: {b, k, j, seq}
	const onTarget = (e) => { if (hits.length < 2000) hits.push({ b: e.b, k: e.k, j: e.j, seq: Array.from(e.seq), at: e.at }); };
	const targets = ctx.targets || [];
	if (task.type === 'entrances') {
		// from S(w): every move for --span ticks, entrances only
		R.stateAt(sim, task.w);
		const tube = tubeOf(level, R, [[task.w, task.w + o.span + 40], [task.j - 10, task.j + 10]], [], o.margin);
		const res = everyMove(R, level, nc, [{ snap: sim.snapshot(), seq: new Uint8Array(0), vx: sim.speed_x }],
			Object.assign({}, o, { salt: task.salt | 0, b: task.w, t0: task.w, until: task.w + o.span, H: Math.max(o.H, task.j + 100 - task.w - o.span), cap: o.cap1, tube, entrances: true, tails: true, jmin: task.w, deadline: task.deadline, onEdge, targets, onTarget, meter: ctx.meter }));
		return { edges, hits, entrances: res.entrances, ticks: res.ticks, cells: res.cells, stop: res.stop };
	}
	// routes: every move from one entrance (its inputs from the window start w), with tails
	const e = task.e;
	R.stateAt(sim, task.w);
	const inp = new E.EEInput();
	for (const m of e.seq) { E.applyMask(inp, m); sim.tick(inp); }
	// the tube: around the run's path from the contact on, and around the entrance (a hop to build speed may first go
	// where the run never is: Forgotten Veil's hop rises 4 tiles above the ledge)
	const tube = tubeOf(level, R, [[e.j - 10, e.j + o.H]], [], o.margin2 || o.margin);
	const around = tubeOf(level, R, [], [[e.px, e.py]], o.around);
	for (let i = 0; i < tube.length; i++) tube[i] |= around[i];
	const res = everyMove(R, level, nc, [{ snap: sim.snapshot(), seq: Uint8Array.from(e.seq), vx: sim.speed_x }],
		Object.assign({}, o, { salt: task.salt | 0, b: task.w, t0: e.t, until: e.t + o.H, cap: task.cap || o.cap2, tube, entrances: false, tails: true, jmin: task.w + 1, deadline: task.deadline, onEdge, targets, onTarget, meter: ctx.meter }));
	return { edges, hits, ticks: res.ticks, cells: res.cells, stop: res.stop };
}

/** --targets: the runs of these files that finish, traced with the reference's context ids */
function loadTargets(level, files, nc, R) {
	const out = [];
	for (const f of files) {
		try {
			const T = reference(level, C.readEetas(f), nc, R.ctxOf);
			if (T.finish > 0) { T.file = f; out.push(T); }
		} catch (e) { /* unreadable: left out */ }
	}
	return out;
}
function workerMain() {
	const d = workerData;
	E.setTickCounter(d.ticksBuf);
	const level = E.loadLevel(d.levelData);
	const masks = C.readEetas(d.tas);
	const R = reference(level, masks, d.nc);
	const targets = loadTargets(level, d.targets || [], d.nc, R);
	let last = 0;
	const ctx = { R, level, nc: d.nc, o: d.o, targets, meter: (t) => { if (t - last > 200000) { last = t; E.flushTicks(); } } };
	parentPort.on('message', (task) => {
		if (task.type === 'quit') { E.flushTicks(); process.exit(0); }
		let res;
		try { res = runTask(ctx, task); } catch (e) { res = { error: String(e && e.stack || e) }; }
		E.flushTicks();
		parentPort.postMessage(Object.assign({ id: task.id }, res));
	});
	parentPort.postMessage({ ready: true });
}

// ---------------------------------------------------------------- combine
/** edges b -> j (inputs seq from S(b)) combined by DP over the run's ticks (explore.js's combine) */
function combine(R, edges, avoidRng) {
	const n = R.masks.length, f = R.first;
	const byStart = new Map();
	for (const e of edges) {
		if (e.j > n || e.b < f || e.j - e.b - e.seq.length <= 0) continue;
		if (avoidRng && R.RS[e.j] !== R.RS[e.b]) continue;
		if (!byStart.has(e.b)) byStart.set(e.b, []);
		byStart.get(e.b).push(e);
	}
	const cost = new Float64Array(n + 1).fill(Infinity), via = new Array(n + 1).fill(null);
	cost[f] = 0;
	for (let i = f; i < n; i++) {
		if (cost[i] + 1 < cost[i + 1]) { cost[i + 1] = cost[i] + 1; via[i + 1] = null; }
		const list = byStart.get(i);
		if (list) for (const e of list) if (cost[i] + e.seq.length < cost[e.j]) { cost[e.j] = cost[i] + e.seq.length; via[e.j] = e; }
	}
	if (!(cost[n] < n - f)) return null;
	const used = [];
	for (let j = n; j > f;) { const e = via[j]; if (e) { used.push(e); j = e.b; } else j--; }
	used.reverse();
	const out = new Uint8Array(f + cost[n]);
	out.set(R.masks.subarray(0, f), 0);
	let o2 = f, r = f;
	for (const e of used) { out.set(R.masks.subarray(r, e.b), o2); o2 += e.b - r; out.set(e.seq, o2); o2 += e.seq.length; r = e.j; }
	out.set(R.masks.subarray(r, n), o2);
	return { ms: out, used, saved: n - f - cost[n] };
}

// ---------------------------------------------------------------- main
async function main() {
	const a = Object.assign({}, DEFAULTS);
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (m) a[m[1]] = ['tas', 'level', 'out', 'windows', 'targets'].includes(m[1]) ? m[2] : parseFloat(m[2]);
	}
	if (!a.tas) { console.log('usage: node src/skips.js --tas=<run.eetas> [--level=<id>] [--out=<file>] (see the header)'); process.exit(2); }
	const levelData = C.levelData(a.level, a.tas);
	const level = E.loadLevel(levelData);
	const masks = C.readEetas(a.tas);
	if (a.nocoins === undefined) {
		const job = C.jobOfFile ? C.jobOfFile(a.tas) : null;
		a.nocoins = job ? (C.readJSON(path.join(C.JOBS || '', job, 'status.json'), {}).coinsOptional ? 1 : 0) : 0;
	}
	const nc = !!a.nocoins;
	if (!a.out) a.out = path.join(__dirname, 'out', 'skips.eetas');
	fs.mkdirSync(path.dirname(a.out), { recursive: true });
	try { fs.unlinkSync(a.out + '.edges.json'); } catch (e) { /* none */ }
	const t0 = Date.now(), deadline = t0 + a.seconds * 1000;
	const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
	const meter = C.tickMeter();
	const R = reference(level, masks, nc);
	const targetFiles = a.targets ? String(a.targets).split(',').filter((f) => f && fs.existsSync(f)) : [];
	const targets = loadTargets(level, targetFiles, nc, R);
	if (targets.length) console.log(`[skips] targets: ${targets.map((T) => `${path.basename(T.file)} (finish ${T.finish})`).join(', ')}`);
	if (level.hasTimeDoors) console.log('[skips] note: this level has time doors: every state holds their phase, so exact rejoins need savings that are multiples of 1000 ticks (phase.js is the tool there)');
	const evRef = C.evaluate(level, masks);
	if (!evRef) { console.log('[skips] the run does not finish the level'); process.exit(1); }
	const o = { span: a.span, cap1: a.cap1, cap2: a.cap2, H: a.H, q: a.q, qv: a.qv, margin: a.margin, margin2: a.margin2, cr: a.cr, minLead: a.minLead, tailD: a.tailD, nearD: a.nearD,
		tailH: a.tailH, minLeadTail: a.minLeadTail, maxCells: a.maxCells, kpc: a.kpc, anchors: a.anchors, athr: a.athr, around: a.around };
	// windows
	let wins;
	if (a.windows !== 'auto') wins = String(a.windows).split(',').map(Number).filter((x) => x >= 0).map((w) => ({ w, j: Math.min(R.n, w + a.span), slack: 0, why: 'given' }));
	else wins = windowsOf(level, R, { R: a.R, lead0: a.lead0, nocoins: nc, from: a.from, to: a.to }).slice(0, a.scan);
	console.log(`[skips] ${R.n} ticks, run_ticks ${evRef.runTicks}${nc ? ', coin-blind' : ''}; ${wins.length} window${wins.length === 1 ? '' : 's'}, ${a.workers} worker${a.workers === 1 ? '' : 's'}, ${a.seconds} s`);
	// the workers
	const W = Math.max(1, Math.min(a.workers, 16));
	const pool = [];
	let nextId = 1;
	const waiting = new Map();
	await Promise.all(Array.from({ length: W }, () => new Promise((res) => {
		const w = new Worker(__filename, { workerData: { skipsWorker: true, levelData, tas: a.tas, targets: targets.map((T) => T.file), nc, o, ticksBuf: meter.buf } });
		w.on('message', (m) => {
			if (m.ready) { pool.push(w); res(); return; }
			const cb = waiting.get(m.id);
			waiting.delete(m.id);
			if (cb) cb(m);
		});
		w.on('error', (e) => { console.log('[skips] worker error', e && e.message); res(); });
	})));
	const idle = pool.slice();
	const queue = [];
	const run = (task) => new Promise((res) => { queue.push({ task, res }); pump(); });
	function pump() {
		while (idle.length && queue.length) {
			const w = idle.pop(), { task, res } = queue.shift();
			task.id = nextId++;
			task.deadline = deadline;
			waiting.set(task.id, (m) => { idle.push(w); res(m); pump(); });
			w.postMessage(task);
		}
	}
	const edges = new Map();   // b * 4194304 + j -> the shortest
	let dpBest = null, written = null;
	const addEdges = (list) => {
		let fresh = false;
		for (const e of list) {
			const k = e.b * 4194304 + e.j, old = edges.get(k);
			if (old && old.seq.length <= e.seq.length) continue;
			edges.set(k, { b: e.b, j: e.j, seq: Uint8Array.from(e.seq) });
			fresh = true;
		}
		if (fresh) combineAndWrite();
	};
	const writeEdges = () => {
		const sha = require('crypto').createHash('sha1').update(C.eetasBytes(masks)).digest('hex');
		const list = [...edges.values()].map((e) => [e.b, e.j, Buffer.from(Array.from(e.seq, (m) => 48 + m)).toString('latin1')]);
		C.writeAtomic(a.out + '.edges.json', JSON.stringify({ from: 0, n: masks.length, ref: sha, nocoins: nc ? 1 : 0, edges: list }));
	};
	function combineAndWrite() {
		for (const avoidRng of C.isRandom(level) ? [false, true] : [false]) {
			const c = combine(R, [...edges.values()], avoidRng);
			if (!c) return;
			if (dpBest && c.saved <= dpBest.saved && !avoidRng) return;
			const ev = C.evaluate(level, c.ms);
			const v = C.judge(ev, evRef, evRef.deaths);
			if (!v.accept) { if (!avoidRng && C.isRandom(level)) continue; console.log(`[skips]   DP of ${c.used.length} rejoins not written: ${v.reason}`); return; }
			if (written && !(ev.runTicks < written.runTicks || (ev.runTicks === written.runTicks && ev.chance > written.chance + 1e-9))) return;
			C.writeEetas(a.out, ev.ms);
			written = { runTicks: ev.runTicks, chance: ev.chance };
			dpBest = { saved: c.saved, runTicks: ev.runTicks };
			console.log(`[skips]   ${secs()} s: DP of ${c.used.length} exact rejoin${c.used.length === 1 ? '' : 's'} saves ${c.saved} (${edges.size} edges) -> run_ticks ${ev.runTicks}: ` +
				c.used.map((e) => `${e.b}->${e.j} (-${e.j - e.b - e.seq.length})`).join(', '));
			writeEdges();
			return;
		}
	}
	// --targets: whole runs through another run, judged; the fastest few first (a run the same length as the one written
	// is not tried again)
	const tried = new Set();
	const addHits = (list) => {
		if (!list || !list.length) return;
		const runs = list.map((h) => ({ h, len: h.b + h.seq.length + targets[h.k].finish - h.j })).sort((p, q) => p.len - q.len);
		let n = 0;
		for (const { h, len } of runs) {
			if (n >= 5 || (written && len > written.runTicks + (R.finish - evRef.runTicks) + 2)) break;
			const key = `${h.k}|${h.j}|${h.b}|${h.seq.length}`;
			if (tried.has(key)) continue;
			tried.add(key);
			n++;
			const T = targets[h.k];
			const ms = new Uint8Array(h.b + h.seq.length + T.finish - h.j);
			ms.set(masks.subarray(0, h.b), 0); ms.set(h.seq, h.b); ms.set(T.masks.subarray(h.j, T.finish), h.b + h.seq.length);
			const ev = C.evaluate(level, ms);
			const v = C.judge(ev, evRef, evRef.deaths);
			if (!v.accept) continue;
			if (written && !(ev.runTicks < written.runTicks || (ev.runTicks === written.runTicks && ev.chance > written.chance + 1e-9))) continue;
			C.writeEetas(a.out, ev.ms);
			written = { runTicks: ev.runTicks, chance: ev.chance };
			console.log(`[skips]   ${secs()} s: a way from tick ${h.b} into ${path.basename(T.file)} at its tick ${h.j} -> run_ticks ${ev.runTicks} (-${evRef.runTicks - ev.runTicks})`);
		}
	};
	// 1) entrances in every window (the windows in parallel)
	const found = await Promise.all(wins.map((win) => run({ type: 'entrances', w: win.w, j: win.j }).then((m) => {
		if (m.error) { console.log(`[skips] window ${win.w}: ${m.error}`); return null; }
		const best = m.entrances.reduce((x, e) => (x && x.lead >= e.lead ? x : e), null);
		console.log(`[skips] ${secs()} s: window ${win.w} (${win.why}): ${m.entrances.length} entrance${m.entrances.length === 1 ? '' : 's'}` +
			(best ? `, the best ${best.lead} ticks ahead at tick ${best.t} (${(best.px / 16).toFixed(1)}, ${(best.py / 16).toFixed(1)})` : '') + ` [${(m.ticks / 1e6).toFixed(2)} M ticks${m.stop ? ', ' + m.stop : ''}]`);
		addEdges(m.edges);
		addHits(m.hits);
		return m.entrances.length ? { win, entrances: m.entrances, best: best.lead } : null;
	})));
	// 2) routes from the entrances of the best windows
	const chosen = found.filter(Boolean).sort((p, q) => q.best - p.best).slice(0, a.top);
	const tasks = [];
	for (const [ci, c] of chosen.entries()) {
		const picks = pickEntrances(c.entrances, a.K);
		console.log(`[skips] window ${c.win.w}: routes from ${picks.length} of ${c.entrances.length} entrances (leads ${picks.map((e) => e.lead).join(', ')})`);
		picks.forEach((e, rank) => { for (let salt = 0; salt < Math.max(1, a.salts); salt++) tasks.push({ c, e, rank, ci, salt }); });
	}
	// round-robin over the windows (the best window first), so every chosen window gets its best entrances first (and
	// with --salts, every entrance its first grid first)
	tasks.sort((p, q) => p.salt - q.salt || p.rank - q.rank || p.ci - q.ci);
	await Promise.all(tasks.map(({ c, e, salt }) => run({ type: 'routes', w: c.win.w, e, salt }).then((m) => {
		if (m.error) { console.log(`[skips] entrance ${e.t}: ${m.error}`); return; }
		const best = m.edges.reduce((x, g) => Math.max(x, g.j - g.b - g.seq.length), 0);
		console.log(`[skips] ${secs()} s: window ${c.win.w}, entrance at ${e.t} (${(e.px / 16).toFixed(2)}, ${(e.py / 16).toFixed(2)}) v(${e.vx.toFixed(2)}, ${e.vy.toFixed(2)}), ` +
			`${e.lead} ahead${salt ? `, salt ${salt}` : ''}: ${m.edges.length ? `${m.edges.length} rejoin${m.edges.length === 1 ? '' : 's'}, the best -${best}` : 'no rejoin'}${m.hits && m.hits.length ? `, ${m.hits.length} into other runs` : ''} [${(m.ticks / 1e6).toFixed(2)} M ticks${m.stop ? ', ' + m.stop : ''}]`);
		addEdges(m.edges);
		addHits(m.hits);
	})));
	for (const w of pool) w.postMessage({ type: 'quit' });
	meter.stop();
	if (edges.size) writeEdges();
	console.log(dpBest ? `[skips] best: DP of the exact rejoins saves ${dpBest.saved} (run_ticks ${dpBest.runTicks}) -> ${a.out}` :
		edges.size ? `[skips] ${edges.size} exact rejoins, no accepted combination: only the edges written` : '[skips] nothing rejoined the run');
	console.log(`[skips] done in ${secs()} s`);
}

module.exports = { reference, windowsOf, everyMove, contactOf, pickEntrances, combine, tubeOf, _runTask: runTask };

if (isMainThread && require.main === module) main();
else if (!isMainThread && workerData && workerData.skipsWorker) workerMain();   // (not when another tool's worker requires this file)
