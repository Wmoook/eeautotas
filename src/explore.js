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
//
// usage: node src/explore.js --tas=<run.eetas> --from=5913 --join=6289 [--until=6450] [--seconds=120] [--workers=16]
//        [--cell=8] [--vcell=2] [--roll=80] [--match=8] [--exact=1] [--nocoins=0|1] [--level=<level id | job id>] [--out=...]
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
		cell: 8, vcell: 2, roll: 80, match: 3, velW: 3, pchange: 0.12, out: null, seed: 1, seed_ref: 1, perCell: 4, exact: 0, ahead: 0.5, cands: 0, minSave: 2, nocoins: 0, maxEntries: 0 };
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
	const root = { parent: null, buf: new Uint8Array(0), len: 0 };
	// returns true if the state was stored
	const offer = (cell, t, mkNode, pinned, cid) => {
		const fine = fineOf();
		const late = latenessOf(cid, t);
		let list = archive.get(cell);
		if (list === undefined) {
			if (entries.length >= MAXE && !pinned) return false;
			list = []; archive.set(cell, list); nCells++;
		}
		for (const e of list) {
			if (e.fine === fine) {
				if (t < e.tick && !e.pinned) { e.tick = t; e.snap = sim.snapshot(); e.node = mkNode(); e.picks = 0; e.late = late; return true; }
				return false;
			}
		}
		if (list.length < K) {
			if (entries.length >= MAXE && !pinned) return false;   // --maxEntries: memory cap (existing cells still improve)
			const ne = { tick: t, snap: sim.snapshot(), node: mkNode(), picks: 0, fine, pinned, late };
			list.push(ne); entries.push(ne);
			return true;
		}
		let w = null;
		for (const e of list) if (!e.pinned && (w === null || e.tick > w.tick)) w = e;
		if (w !== null && t < w.tick) { w.tick = t; w.snap = sim.snapshot(); w.node = mkNode(); w.picks = 0; w.fine = fine; w.late = late; return true; }
		return false;
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
			offer(cellOf(cr), t + 1, () => ({ parent: root, buf: rbuf, len }), true, cr);
		}
	}
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
				offer(cell, t, () => ({ parent: parentNode, buf, len }), false, cid);
				if (a.exact) {
					if (!refPos.has(Math.floor(sim.px) * 65536 + Math.floor(sim.py))) continue;
					const jx = refHash.get(sim.stateHash(false, NOCOINS));
					if (jx !== undefined && jx - t > bestExact) {
						bestExact = jx - t;
						const seq = [];
						for (let i = s; i >= 0; i--) seq.push(buf[i]);
						for (let nd = parentNode; nd && nd !== root; nd = nd.parent) for (let i = nd.len - 1; i >= 0; i--) seq.push(nd.buf[i]);
						seq.reverse();
						parentPort.postMessage({ type: 'best', saved: jx - t, t, j: jx, d: 0, seq, seed: workerData.seed, exact: true });
					}
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
			parentPort.postMessage({ type: 'stat', cells: entries.length, rolls, steps, seed: workerData.seed });
		}
	}
	E.flushTicks();
	parentPort.postMessage({ type: 'done', cells: entries.length, rolls, steps, seed: workerData.seed });
}

async function main() {
	const a = parseArgs();
	const meter = C.tickMeter();   // `[ticks] N` every second (the page's live speed)
	NOCOINS = !!a.nocoins;
	const level = E.loadLevel(a.levelData);
	const masks = C.readEetas(a.tas);
	console.log(`[explore] from ${a.from}, rejoin ref ticks ${a.join}..${a.until}, ${a.workers} workers x ${a.seconds} s, ` +
		`cells ${a.cell}px/${a.vcell}, roll ${a.roll}, match ${a.match}`);
	let best = null;
	const stats = new Map();
	const cands = [];
	const t0 = Date.now();
	await Promise.all(Array.from({ length: a.workers }, (_, i) => new Promise((res) => {
		const w = new Worker(__filename, { workerData: { args: a, seed: a.seed * 1000 + i + 1, ticksBuf: meter.buf } });
		w.on('message', (msg) => {
			if (msg.type === 'cand') { cands.push(msg); return; }
			if (msg.type === 'best') {
				if (!best || msg.saved > best.saved || (msg.saved === best.saved && msg.d < best.d)) {
					best = msg;
					console.log(`[explore]   ${((Date.now() - t0) / 1000).toFixed(0)} s: worker ${msg.seed}: rejoins ref tick ${msg.j} at tick ${msg.t} ` +
						`(d ${msg.d.toFixed(2)}): ${msg.saved >= 0 ? 'saves' : 'loses'} ${Math.abs(msg.saved)}`);
				}
			} else {
				stats.set(msg.seed, msg);
				if (msg.type === 'done') res();
			}
		});
		w.on('error', (err) => { console.log('[explore] worker error', err); res(); });
	})));
	let cells = 0, steps = 0;
	for (const s of stats.values()) { cells += s.cells; steps += s.steps; }
	console.log(`[explore] ${steps.toLocaleString()} simulated ticks, ${cells.toLocaleString()} archive cells (sum over workers)`);
	meter.stop();
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
	const out = [];
	for (let t = 0; t < a.from; t++) out.push(masks[t]);
	for (const m of best.seq) out.push(m);
	if (a.exact) for (let t = best.j; t < masks.length; t++) out.push(masks[t]);   // exact: the reference continues from S(j)
	fs.mkdirSync(path.dirname(a.out), { recursive: true });
	C.writeEetas(a.out, out);
	fs.writeFileSync(a.out + '.json', JSON.stringify({ from: a.from, t: best.t, j: best.j, saved: best.saved, d: best.d }));
	console.log(`[explore] best: rejoin ref tick ${best.j} at tick ${best.t} (saves ${best.saved}) -> ${a.out}`);
}

if (isMainThread) main();
else workerMain();
