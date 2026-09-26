'use strict';
// Route explorer (Go-Explore style) for one segment of a TAS: finds NEW routes, it does not follow the reference.
//
// Keeps an archive of cells (quantized position + velocity + jump / gravity-queue state + context). Every cell
// remembers the EARLIEST tick any explored input sequence reached it, with that state and inputs. Repeatedly picks
// an archived cell (rarely-picked cells first) and plays random "sticky" inputs from it for up to --roll ticks;
// every state on the way that reaches a new cell, or a known cell earlier, updates the archive. A state rejoins the
// reference run when it has the reference's context (coins, keys, switches) at reference tick j in [--join,
// --until] and is within --match px (+3x velocity mismatch) of it: j - t ticks saved. Each worker thread runs its
// own explorer (different seed); the best rejoin of all is written as a prefix .eetas (reference inputs up to
// --from, then the found segment) for optimize.js --prefix to continue.
// With --exact=1 a rejoin is a state identical (stateHash) to a later reference state: a proven shortcut, and the
// output is the whole run (it continues with the reference inputs from there), replayed (C.evaluate) and accepted by
// THE rule (C.judge) before it is written. The output file is rewritten every time the best result improves, so a
// search that is stopped early keeps what it found.
// --tails=1 (with --exact=1): "tails". When a state stored in the archive is ahead of the reference at its tile
// (late <= -2), find the nearest reference state S(j) with the same context (|dpos| + 3|dvel| <= --tailD px), then
// replay the reference's OWN inputs from j+o (o = -2..2) for up to --tailH ticks (--tailDrift px drift cutoff),
// checking the exact state every tick: wall hits, landings and the grid auto-align absorb small differences, so these
// rejoin far more often than random inputs. Every exact rejoin (rolls and tails) is kept as an edge b -> j (b = the
// reference tick the path left the reference), all edges are combined by DP over the reference ticks, and the edges
// are also written to <out>.edges.json ({from, n, ref: sha1 of the --tas bytes, nocoins, edges: [[b, j, inputs as
// '0'+mask chars]]}), also when no combination was accepted.
//
// usage: node src/explore.js --tas=<run.eetas> --from=5913 --join=6289 [--until=6450] [--seconds=120] [--workers=16]
//        [--cell=8] [--vcell=2] [--roll=80] [--match=8] [--exact=1] [--nocoins=0|1] [--level=<level id | job id>] [--out=...]
//        [--tails=0|1 [--tailD=12] [--tailH=300] [--tailDrift=64]]
// (--level can be left out for a .eetas inside src/jobs/<id>/)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;

const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);

function parseArgs() {
	const a = { level: '', tas: null, from: 0, join: 0, until: 0, seconds: 120, workers: os.cpus().length,
		cell: 8, vcell: 2, roll: 80, match: 3, velW: 3, pchange: 0.12, out: null, seed: 1, seed_ref: 1, perCell: 4, exact: 0, ahead: 0.5, cands: 0, minSave: 2, nocoins: 0, maxEntries: 0,
		tails: 0, tailD: 12, tailH: 300, tailDrift: 64 };
	for (const s of process.argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) continue;
		a[m[1]] = (m[1] === 'tas' || m[1] === 'level' || m[1] === 'out') ? m[2] : parseFloat(m[2]);
	}
	if (!a.tas) { console.log('usage: node src/explore.js --tas=<run.eetas> --from=<tick> --join=<tick> [--until=<tick>] [--level=<id>] (see the header)'); process.exit(2); }
	a.levelData = C.levelData(a.level, a.tas);
	if (!a.out) a.out = path.join(__dirname, 'out', `explore_${a.from}.eetas`);
	if (!a.until) a.until = a.join + 200;
	return a;
}

function onSet(m) {
	if (!m || m.size === 0) return '';
	const ids = [];
	for (const [id, v] of m) if (v === true) ids.push(id);
	return ids.sort((x, y) => x - y).join('.');
}
let NOCOINS = false;   // --nocoins=1: coins are ignored (contexts and exact rejoins); finds routes that skip coins
function contextKey(sim) {
	return (NOCOINS ? '' : sim.coins + ',' + sim.blue_coins + ',') + (sim.has_crown ? 1 : 0) + ',' + (sim._keysMask | 0) + ',' +
		onSet(sim._switches) + ',' + onSet(sim._oswitches);
}

function reference(a, level, masks) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const n = masks.length;
	const R = { X: new Float64Array(n + 1), Y: new Float64Array(n + 1), VX: new Float64Array(n + 1), VY: new Float64Array(n + 1),
		C: new Array(n + 1), start: null, n };
	const rec = (j) => { R.X[j] = sim.px; R.Y[j] = sim.py; R.VX[j] = sim.speed_x; R.VY[j] = sim.speed_y; R.C[j] = contextKey(sim); };
	rec(0);
	for (let t = 0; t < n; t++) {
		if (t === a.from) R.start = sim.snapshot();
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		rec(t + 1);
	}
	return R;
}

// xorshift128+ -> [0, 1)
function makeRng(seed) {
	let s0 = (seed * 2654435761) >>> 0 || 1, s1 = (seed * 40503 + 12345) >>> 0 || 2;
	return () => {
		let x = s0; const y = s1;
		s0 = y; x ^= x << 23; x ^= x >>> 17; x ^= y ^ (y >>> 26); s1 = x >>> 0;
		return ((s0 + s1) >>> 0) / 4294967296;
	};
}

function workerMain() {
	const a = workerData.args;
	E.setTickCounter(workerData.ticksBuf);
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = C.readEetas(a.tas);
	const R = reference(a, level, masks);
	const sim = new E.EESim(level);
	const inp = new E.EEInput();
	const rnd = makeRng(workerData.seed);
	const ctxIds = new Map();
	const ctxId = (k) => { let v = ctxIds.get(k); if (v === undefined) { v = ctxIds.size + 1; ctxIds.set(k, v); } return v; };
	// context id of the live sim, cached on (coins, blue coins, crown, keys, switch map identities)
	let cc0 = -1, cc1 = -1, cc2 = null, cc3 = null, cc4 = -1, ccId = 0;
	const simCtx = () => {
		const k0 = NOCOINS ? (sim.has_crown ? 1 : 0) : sim.coins * 64 + sim.blue_coins * 2 + (sim.has_crown ? 1 : 0);
		if (k0 === cc0 && sim._keysMask === cc1 && sim._switches === cc2 && sim._oswitches === cc3 && sim._switches.size === cc4) return ccId;
		cc0 = k0; cc1 = sim._keysMask; cc2 = sim._switches; cc3 = sim._oswitches; cc4 = sim._switches.size;
		ccId = ctxId(contextKey(sim));
		return ccId;
	};
	const refCtx = new Int32Array(R.n + 1);
	for (let j = 0; j <= R.n; j++) refCtx[j] = ctxId(R.C[j]);
	const joinCtx = refCtx[a.join];
	// exact rejoin: a state identical (stateHash) to a later reference state is a VERIFIED shortcut
	const refHash = new Map();
	{
		const rs = new E.EESim(level);
		rs.restore(R.start);
		for (let t = a.from; t < R.n; t++) { E.applyMask(inp, masks[t]); rs.tick(inp); refHash.set(rs.stateHash(false, NOCOINS), t + 1); }
	}
	// "ahead of the reference" bias: the first reference tick at each (context, tile)
	const tileFirst = new Map();
	for (let t = a.from; t <= Math.min(R.n, a.until + 200); t++) {
		const k = refCtx[t] * 1048576 + (Math.trunc(R.X[t] + 8) >> 4) * 1024 + (Math.trunc(R.Y[t] + 8) >> 4);
		if (!tileFirst.has(k)) tileFirst.set(k, t);
	}
	const latenessOf = (cid, t) => {
		const f = tileFirst.get(cid * 1048576 + (Math.trunc(sim.px + 8) >> 4) * 1024 + (Math.trunc(sim.py + 8) >> 4));
		return f === undefined ? 0 : Math.max(-60, t - f);
	};
	// cheap prefilter for the exact check: the reference's positions (floored to whole pixels)
	const refPos = new Set();
	for (let t = a.from; t <= R.n; t++) refPos.add(Math.floor(R.X[t]) * 65536 + Math.floor(R.Y[t]));
	let bestExact = 0;
	const cellOf = (cid) => {
		const qx = Math.floor(sim.px / a.cell), qy = Math.floor(sim.py / a.cell);
		const qvx = Math.round(sim.speed_x / a.vcell), qvy = Math.round(sim.speed_y / a.vcell);
		return ((((qx * 1024 + qy) * 64 + (qvx + 32)) * 64 + (qvy + 32)) * 4 + (sim.jump_count > 0 ? 1 : 0) * 2 + (sim.on_ground ? 1 : 0)) * 64 +
			((cid * 7 + sim._q0 * 3 + sim._q1) & 63);
	};
	// archive: cell -> up to --perCell entries with distinct fine keys {tick, snap, node, picks, fine, pinned}.
	// Reference states are pinned (a faster arrival in the same coarse cell never evicts the route that works).
	const fineOf = () => {
		let h = Math.imul(Math.round(sim.px * 4) + 1000003 * Math.round(sim.py * 4), 0x9E3779B1);
		h ^= Math.imul(Math.round(sim.speed_x * 20) * 7919 + Math.round(sim.speed_y * 20), 0x85EBCA6B);
		h ^= Math.imul(sim._q0 * 65599 + sim._q1 + 31 * sim.jump_count, 0xC2B2AE35);
		return h | 0;
	};
	const K = a.perCell || 4;
	const MAXE = a.maxEntries || Infinity;
	const archive = new Map();
	const entries = [];
	let nCells = 0;
	// input tree: node = {parent, buf, len} (the first len inputs of buf follow the parent's); the root and the reference
	// seeds carry b = the reference tick they stand for (a path's branch point off the reference, see fromBranch)
	const root = { parent: null, buf: new Uint8Array(0), len: 0, b: a.from };
	// returns the entry that now holds the live state, or null if it was not stored
	const offer = (cell, t, mkNode, pinned, cid) => {
		const fine = fineOf();
		const late = latenessOf(cid, t);
		let list = archive.get(cell);
		if (list === undefined) {
			if (entries.length >= MAXE && !pinned) return null;
			list = []; archive.set(cell, list); nCells++;
		}
		for (const e of list) {
			if (e.fine === fine) {
				if (t < e.tick && !e.pinned) { e.tick = t; e.snap = sim.snapshot(); e.node = mkNode(); e.picks = 0; e.late = late; return e; }
				return null;
			}
		}
		if (list.length < K) {
			if (entries.length >= MAXE && !pinned) return null;   // --maxEntries: memory cap (existing cells still improve)
			const ne = { tick: t, snap: sim.snapshot(), node: mkNode(), picks: 0, fine, pinned, late };
			list.push(ne); entries.push(ne);
			return ne;
		}
		let w = null;
		for (const e of list) if (!e.pinned && (w === null || e.tick > w.tick)) w = e;
		if (w !== null && t < w.tick) { w.tick = t; w.snap = sim.snapshot(); w.node = mkNode(); w.picks = 0; w.fine = fine; w.late = late; return w; }
		return null;
	};
	sim.restore(R.start);
	{ const c0 = ctxId(contextKey(sim)); offer(cellOf(c0), a.from, () => root, true, c0); }
	// seed the archive with the reference route itself: exploration branches off it at every tick
	if (a.seed_ref !== 0) {
		const rbuf = new Uint8Array(a.until - a.from);
		sim.restore(R.start);
		for (let t = a.from; t < a.until && t < masks.length; t++) {
			rbuf[t - a.from] = masks[t];
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			const len = t - a.from + 1;
			const cr = ctxId(contextKey(sim));
			offer(cellOf(cr), t + 1, () => ({ parent: root, buf: rbuf, len, b: t + 1 }), true, cr);
		}
	}
	// --tails: every exact rejoin is an edge b -> j (inputs from the reference state S(b)); only improvements are posted
	const TAILS = !!(a.exact && a.tails);
	const edgeCost = new Map();
	let rollHits = 0, tailHits = 0, tailRuns = 0, tailTicks = 0;
	/** The branch point b of the path (node, then buf[0..len)) and its inputs from S(b), followed by `extra`. */
	const fromBranch = (node, buf, len, extra) => {
		const parts = [];
		let nd = node, L = len + (extra ? extra.length : 0);
		while (nd.b === undefined) { parts.push(nd); L += nd.len; nd = nd.parent; }   // explored nodes up to a seed / the root
		const seq = new Uint8Array(L);
		let o = 0;
		for (let p = parts.length - 1; p >= 0; p--) { seq.set(parts[p].buf.subarray(0, parts[p].len), o); o += parts[p].len; }
		seq.set(buf.subarray(0, len), o); o += len;
		if (extra) seq.set(extra, o);
		return { b: nd.b, seq };
	};
	const edge = (node, buf, len, extra, j, viaTail) => {
		const e = fromBranch(node, buf, len, extra);
		if (j - e.b - e.seq.length <= 0) return;
		const key = e.b * 4194304 + j, old = edgeCost.get(key);
		if (old !== undefined && old <= e.seq.length) return;
		edgeCost.set(key, e.seq.length);
		if (viaTail) tailHits++; else rollHits++;
		parentPort.postMessage({ type: 'edge', b: e.b, j, seq: e.seq, tail: viaTail, seed: workerData.seed });
	};
	/**
	 * --tails: from the live state at tick t (stored as entry snapshot s0, path node + buf[0..len)), replay the reference
	 * inputs from next to the nearest same-context reference state; every exact rejoin with a later reference tick is an
	 * edge. The live state is restored afterwards.
	 */
	const tail = (t, cid, node, buf, len, s0) => {
		const f = tileFirst.get(cid * 1048576 + (Math.trunc(sim.px + 8) >> 4) * 1024 + (Math.trunc(sim.py + 8) >> 4));
		if (f === undefined) return;
		let bj = -1, bd = Infinity;
		for (let j = Math.max(a.from + 1, f - 5); j <= Math.min(R.n - 1, f + 40); j++) {
			if (refCtx[j] !== cid) continue;
			const d = Math.abs(sim.px - R.X[j]) + Math.abs(sim.py - R.Y[j]) + 3 * (Math.abs(sim.speed_x - R.VX[j]) + Math.abs(sim.speed_y - R.VY[j]));
			if (d < bd) { bd = d; bj = j; }
		}
		if (bj < 0 || bd > a.tailD || bj - t < 1) return;
		for (let o = -2; o <= 2; o++) {
			const j0 = bj + o;
			if (j0 < 0 || j0 >= R.n) continue;
			sim.restore(s0);
			tailRuns++;
			for (let k = 0, r = j0; k < a.tailH && r < R.n; k++, r++) {
				E.applyMask(inp, masks[r]);
				sim.tick(inp);
				tailTicks++;
				if (sim.is_dead) break;
				if (refPos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) {
					const jx = refHash.get(sim.stateHash(false, NOCOINS));
					if (jx !== undefined) {   // back on the reference: ahead (a shortcut), level or behind
						if (jx > t + k + 1) edge(node, buf, len, masks.subarray(j0, r + 1), jx, true);
						break;
					}
				}
				if (Math.abs(sim.px - R.X[r + 1]) + Math.abs(sim.py - R.Y[r + 1]) > a.tailDrift) break;
			}
		}
		sim.restore(s0);
	};
	let best = null;
	const candBest = new Map();
	const tEnd = Date.now() + a.seconds * 1000;
	let rolls = 0, steps = 0, lastReport = Date.now();
	while (Date.now() < tEnd) {
		for (let batch = 0; batch < 200; batch++) {
			// tournament selection: half the time the fewest picks (coverage), half the time the state furthest
			// ahead of the reference at its tile (time saves come from there), fewest picks breaking ties
			let e = entries[(rnd() * entries.length) | 0];
			const ahead = rnd() < a.ahead;
			for (let k = 0; k < 4; k++) {
				const c = entries[(rnd() * entries.length) | 0];
				if (ahead ? (c.late * 4 + Math.min(c.picks, 40) < e.late * 4 + Math.min(e.picks, 40)) : c.picks < e.picks) e = c;
			}
			e.picks++;
			rolls++;
			sim.restore(e.snap);
			const buf = new Uint8Array(a.roll);
			const parentNode = e.node;
			let m = OPTIONS[(rnd() * 18) | 0];
			let t = e.tick;
			for (let s = 0; s < a.roll; s++) {
				if (rnd() < a.pchange) m = OPTIONS[(rnd() * 18) | 0];
				buf[s] = m;
				E.applyMask(inp, m);
				sim.tick(inp);
				t++;
				steps++;
				if (sim.is_dead || t > a.until) break;
				const cid = simCtx();
				const cell = cellOf(cid);
				const len = s + 1;
				const ne = offer(cell, t, () => ({ parent: parentNode, buf, len }), false, cid);
				if (a.exact) {
					let jx;
					if (refPos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) {
						jx = refHash.get(sim.stateHash(false, NOCOINS));
						if (TAILS) { if (jx !== undefined && jx > t) edge(parentNode, buf, len, null, jx, false); }
						else if (jx !== undefined && jx - t > bestExact) {
							bestExact = jx - t;
							const seq = [];
							for (let i = s; i >= 0; i--) seq.push(buf[i]);
							for (let nd = parentNode; nd && nd !== root; nd = nd.parent) for (let i = nd.len - 1; i >= 0; i--) seq.push(nd.buf[i]);
							seq.reverse();
							parentPort.postMessage({ type: 'best', saved: jx - t, t, j: jx, d: 0, seq, seed: workerData.seed, exact: true });
						}
					}
					// a stored state ahead of the reference: try the reference's own inputs from near it
					if (TAILS && ne !== null && ne.late <= -2) tail(t, cid, parentNode, buf, len, ne.snap);
					continue;
				}
				if (cid === joinCtx) {
					const lo = Math.max(a.join, t - 60);
					for (let j = lo; j <= a.until; j++) {
						if (refCtx[j] !== cid) continue;
						const d = Math.abs(sim.px - R.X[j]) + Math.abs(sim.py - R.Y[j]) + a.velW * (Math.abs(sim.speed_x - R.VX[j]) + Math.abs(sim.speed_y - R.VY[j]));
						if (a.cands && d <= a.match && j - t >= (a.minSave || 2)) {
							// candidate list (approximate rejoins, verified later by routecheck.js): best saving per target tick
							const prev = candBest.get(j);
							if (prev === undefined || j - t > prev) {
								candBest.set(j, j - t);
								const cs = [];
								for (let i = s; i >= 0; i--) cs.push(buf[i]);
								for (let nd = parentNode; nd && nd !== root; nd = nd.parent) for (let i = nd.len - 1; i >= 0; i--) cs.push(nd.buf[i]);
								cs.reverse();
								parentPort.postMessage({ type: 'cand', saved: j - t, t, j, d, seq: cs });
							}
						}
						if (d <= a.match && (!best || j - t > best.saved || (j - t === best.saved && d < best.d))) {
							// materialize the input path
							const seq = [];
							for (let i = s; i >= 0; i--) seq.push(buf[i]);
							for (let nd = parentNode; nd && nd !== root; nd = nd.parent) for (let i = nd.len - 1; i >= 0; i--) seq.push(nd.buf[i]);
							seq.reverse();
							best = { saved: j - t, t, j, d, seq };
							parentPort.postMessage({ type: 'best', saved: best.saved, t, j, d, seq, seed: workerData.seed });
						}
					}
				}
			}
		}
		if (Date.now() - lastReport > 10000) {
			lastReport = Date.now();
			parentPort.postMessage({ type: 'stat', cells: entries.length, rolls, steps, rollHits, tailHits, tailRuns, tailTicks, seed: workerData.seed });
		}
	}
	E.flushTicks();
	parentPort.postMessage({ type: 'done', cells: entries.length, rolls, steps, rollHits, tailHits, tailRuns, tailTicks, seed: workerData.seed });
}

async function main() {
	const a = parseArgs();
	const meter = C.tickMeter();   // `[ticks] N` every second (the page's live speed)
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = C.readEetas(a.tas);
	console.log(`[explore] from ${a.from}, rejoin ref ticks ${a.join}..${a.until}, ${a.workers} workers x ${a.seconds} s, ` +
		`cells ${a.cell}px/${a.vcell}, roll ${a.roll}, match ${a.match}`);
	const TAILS = !!(a.exact && a.tails);
	if (TAILS) console.log(`[explore] tails: from archived states ahead of the reference, its own inputs (within ${a.tailD} px, ${a.tailH} ticks, drift ${a.tailDrift}); every exact rejoin combined by DP`);
	let best = null;
	const stats = new Map();
	const cands = [];
	const t0 = Date.now();
	const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
	fs.mkdirSync(path.dirname(a.out), { recursive: true });
	// --exact: the output is a whole run, replayed and judged (THE rule against the reference) before it is written
	const evRef = a.exact ? C.evaluate(level, masks) : null;
	const baseDeaths = evRef ? evRef.deaths : 0;
	let RS = null;   // random-portal draws per reference tick (the avoidRng fallback of the DP)
	if (a.exact && C.isRandom(level)) {
		const s = new E.EESim(level);
		s.reset();
		const inp = new E.EEInput();
		RS = new Int32Array(masks.length + 1);
		RS[0] = s._rngSteps;
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); s.tick(inp); RS[t + 1] = s._rngSteps; }
	}
	let written = null;   // {runTicks, chance} of the run in a.out
	const writeRun = (ms, info) => {
		const ev = C.evaluate(level, ms);
		const v = C.judge(ev, evRef, baseDeaths);
		if (!v.accept) return { ok: false, ev, why: v.reason };
		if (written && !(ev.runTicks < written.runTicks || (ev.runTicks === written.runTicks && ev.chance > written.chance + 1e-9))) return { ok: true, ev, old: true };
		C.writeEetas(a.out, ev.ms);
		fs.writeFileSync(a.out + '.json', JSON.stringify(Object.assign({ from: a.from, runTicks: ev.runTicks, refRunTicks: evRef ? evRef.runTicks : null }, info)));
		written = { runTicks: ev.runTicks, chance: ev.chance };
		return { ok: true, ev };
	};
	// the single best rejoin (and the approximate mode's prefix): written as soon as it improves
	const writeBest = () => {
		if (!a.exact) {
			const out = [];
			for (let t = 0; t < a.from; t++) out.push(masks[t]);
			for (const m of best.seq) out.push(m);
			C.writeEetas(a.out, out);
			fs.writeFileSync(a.out + '.json', JSON.stringify({ from: a.from, t: best.t, j: best.j, saved: best.saved, d: best.d }));
			return;
		}
		const out = new Uint8Array(a.from + best.seq.length + masks.length - best.j);
		out.set(masks.subarray(0, a.from), 0);
		out.set(best.seq, a.from);
		out.set(masks.subarray(best.j), a.from + best.seq.length);   // exact: the reference continues from S(j)
		const w = writeRun(out, { t: best.t, j: best.j, saved: best.saved, d: best.d });
		if (!w.ok) console.log(`[explore]   (rejoin at tick ${best.t} not written: ${w.why})`);
	};
	// --tails: all exact rejoins as edges b -> j, combined by DP over the reference ticks from --from
	const edges = new Map();   // b * 4194304 + j -> {b, j, seq}
	let edgesNew = false, bestEdge = null, dpBest = null, nTail = 0;
	const combine = (avoidRng) => {
		const n = masks.length, f = a.from;
		const byStart = new Map();
		for (const e of edges.values()) {
			if (e.j > n || e.b < f || e.j - e.b - e.seq.length <= 0) continue;
			if (avoidRng && RS !== null && RS[e.j] !== RS[e.b]) continue;
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
		out.set(masks.subarray(0, f), 0);
		let o = f, r = f;
		for (const e of used) { out.set(masks.subarray(r, e.b), o); o += e.b - r; out.set(e.seq, o); o += e.seq.length; r = e.j; }
		out.set(masks.subarray(r, n), o);
		return { ms: out, used, saved: n - f - cost[n] };
	};
	const combineAndWrite = () => {
		if (!edgesNew) return;
		edgesNew = false;
		for (const avoidRng of RS !== null ? [false, true] : [false]) {
			const c = combine(avoidRng);
			if (!c) return;
			if (dpBest && c.saved <= dpBest.saved && !avoidRng) return;
			const w = writeRun(c.ms, { t: bestEdge.b + bestEdge.seq.length, j: bestEdge.j, saved: c.saved, d: 0, edges: edges.size,
				used: c.used.map((e) => [e.b, e.j, e.seq.length]) });
			if (!w.ok) {
				if (!avoidRng && RS !== null) continue;   // it lowers the random-portal chance: again without edges over a draw
				console.log(`[explore]   DP of ${c.used.length} rejoins not written: ${w.why}`);
				return;
			}
			if (w.old) return;
			dpBest = { saved: c.saved, runTicks: w.ev.runTicks };
			console.log(`[explore]   ${secs()} s: DP of ${c.used.length} exact rejoins${avoidRng ? ' (none over a random draw)' : ''} saves ${c.saved} ` +
				`(${edges.size} edges, ${nTail} via tails) -> run_ticks ${w.ev.runTicks}: ` + c.used.map((e) => `${e.b}->${e.j} (-${e.j - e.b - e.seq.length})`).join(', '));
			writeEdges();
			return;
		}
	};
	// (ref: sha1 of the reference's .eetas bytes, the run whose ticks b and j refer to)
	const refSha1 = TAILS ? require('crypto').createHash('sha1').update(C.eetasBytes(masks)).digest('hex') : '';
	const writeEdges = () => {
		const list = [...edges.values()].map((e) => [e.b, e.j, Buffer.from(e.seq.map((m) => 48 + m)).toString('latin1')]);
		C.writeAtomic(a.out + '.edges.json', JSON.stringify({ from: a.from, n: masks.length, ref: refSha1, nocoins: NOCOINS ? 1 : 0, edges: list }));
	};
	if (TAILS) { try { fs.unlinkSync(a.out + '.edges.json'); } catch (e) { /* none */ } }   // never leave another reference's edges behind
	const dpTimer = TAILS ? setInterval(combineAndWrite, 1000) : null;
	await Promise.all(Array.from({ length: a.workers }, (_, i) => new Promise((res) => {
		const w = new Worker(__filename, { workerData: { args: a, seed: a.seed * 1000 + i + 1, ticksBuf: meter.buf } });
		w.on('message', (msg) => {
			if (msg.type === 'cand') { cands.push(msg); return; }
			if (msg.type === 'edge') {
				const key = msg.b * 4194304 + msg.j, old = edges.get(key);
				if (old && old.seq.length <= msg.seq.length) return;
				edges.set(key, msg);
				edgesNew = true;
				nTail += (msg.tail ? 1 : 0) - (old && old.tail ? 1 : 0);   // edges (kept) found by a tail
				const saved = msg.j - msg.b - msg.seq.length;
				if (!bestEdge || saved > bestEdge.j - bestEdge.b - bestEdge.seq.length) {
					bestEdge = msg;
					console.log(`[explore]   ${secs()} s: worker ${msg.seed}: rejoins ref tick ${msg.j} at tick ${msg.b + msg.seq.length}` +
						`${msg.tail ? ' (tail)' : ''}: saves ${saved}`);
				}
				return;
			}
			if (msg.type === 'best') {
				if (!best || msg.saved > best.saved || (msg.saved === best.saved && msg.d < best.d)) {
					best = msg;
					console.log(`[explore]   ${secs()} s: worker ${msg.seed}: rejoins ref tick ${msg.j} at tick ${msg.t} ` +
						`(d ${msg.d.toFixed(2)}): ${msg.saved >= 0 ? 'saves' : 'loses'} ${Math.abs(msg.saved)}`);
					writeBest();
				}
			} else {
				stats.set(msg.seed, msg);
				if (msg.type === 'done') res();
			}
		});
		w.on('error', (err) => { console.log('[explore] worker error', err); res(); });
	})));
	if (dpTimer) clearInterval(dpTimer);
	let cells = 0, steps = 0, tailTicks = 0, tailRuns = 0;
	for (const s of stats.values()) { cells += s.cells; steps += s.steps; tailTicks += s.tailTicks || 0; tailRuns += s.tailRuns || 0; }
	console.log(`[explore] ${(steps + tailTicks).toLocaleString()} simulated ticks, ${cells.toLocaleString()} archive cells (sum over workers)` +
		(TAILS ? `; tails: ${tailRuns.toLocaleString()} runs, ${tailTicks.toLocaleString()} ticks, ${nTail} of ${edges.size} edges` : ''));
	meter.stop();
	if (TAILS) {
		edgesNew = true;
		combineAndWrite();
		if (edges.size) writeEdges();   // every exact edge, also when no combination of them was accepted
		if (!dpBest) { console.log(edges.size ? `[explore] ${edges.size} exact rejoins, no accepted combination: only the edges written` : '[explore] nothing rejoined the reference'); return; }
		console.log(`[explore] best: DP of the exact rejoins saves ${dpBest.saved} (run_ticks ${dpBest.runTicks}) -> ${a.out}`);
		return;
	}
	if (a.cands) {
		// top candidates: best per target tick, then by saving (desc) and distance (asc)
		const per = new Map();
		for (const c of cands) { const p = per.get(c.j); if (!p || c.saved > p.saved || (c.saved === p.saved && c.d < p.d)) per.set(c.j, c); }
		const top = [...per.values()].sort((x, y) => (y.saved - x.saved) || (x.d - y.d)).slice(0, a.cands);
		fs.mkdirSync(path.dirname(a.out), { recursive: true });
		fs.writeFileSync(a.out + '.cands.json', JSON.stringify({ from: a.from, cands: top.map((c) => ({ t: c.t, j: c.j, saved: c.saved, d: c.d, seq: c.seq })) }));
		console.log(`[explore] ${top.length} candidates (of ${cands.length}) -> ${a.out}.cands.json: ` +
			top.map((c) => `${c.t}->${c.j} (+${c.saved}, d ${c.d.toFixed(1)})`).join(', '));
	}
	if (!best) { console.log('[explore] nothing rejoined the reference'); return; }
	// (the file was written when this rejoin was found)
	if (a.exact && !written) { console.log(`[explore] best: rejoin ref tick ${best.j} at tick ${best.t} (saves ${best.saved}), not accepted: nothing written`); return; }
	console.log(`[explore] best: rejoin ref tick ${best.j} at tick ${best.t} (saves ${best.saved}) -> ${a.out}`);
}

if (isMainThread) main();
else workerMain();
