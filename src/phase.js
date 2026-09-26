'use strict';
// Time-door (and coin) shortcuts. On a level with time doors every state hash holds the doors' phase
// (PlayState.ticks % 1000), so a shortcut of s ticks rejoins the reference exactly only when s is a multiple of 1000:
// mutate, shortcuts, explore and the GPU families find nothing there by construction. The same goes for the coins
// after the last coin door (the coins collected differ, nothing reads them any more).
//
// This tool tries single input changes at every --step-th tick (a skip of 1-2 ticks, or an option held 1-4 ticks and
// then 0-2 reference ticks dropped), then the reference inputs from where the change ends. A state whose CLOCK-BLIND
// hash (eesim stateHashClockBlind: no door phase, no key timers; coin-blind too once past the last coin door) equals a
// later reference state is a proposal. Every proposal is replayed in the exact engine, two ways:
//   plain       best[0..i) + change + best[j..]: the doors after the rejoin may still work out;
//   compensated the saving s inserted as idle ticks before the first input (free: the run timer starts at the first
//               input), which shifts the whole clock by s so that after the shortcut the doors' phase is the same as
//               the reference's again (or s - 1000 idle ticks taken out, when the run has that many).
// Verified proposals are combined (weighted interval scheduling; the compensated ones share one shift = the sum of
// their savings, tried at +-3), and a run is written only when THE rule accepts it (C.evaluate + C.judge).
// --workers=N: worker threads, each with every N-th start tick of the grid (they search and replay their own
// proposals; the main thread combines them). --random=S: then S seconds of random multi-tick changes per worker (pert / sticky, like
// the GPU's families, which look for exact rejoins and so are blind on time-door levels).
//
// node src/phase.js --tas=<run.eetas> --level=<level id | job id> [--out=<file>] [--from=0] [--to=<end>] [--step=3]
//   [--horizon=300] [--drift=96] [--seconds=60] [--nocoins=0|1] [--workers=1] [--random=0 (seconds)] [--seed=1]
// Prints [phase] lines and `[ticks] N` every second (the page's live speed).
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const C = require('./common.js');
const E = C.E;

const COIN_DOOR_IDS = new Set([43, 165, 213, 214]);   // coin door, coin gate, blue coin door, blue coin gate

function parseArgs() {
	const a = C.parseArgs(process.argv.slice(2));
	if (!a.tas) {
		console.log('usage: node src/phase.js --tas=<run.eetas> --level=<level|job> [--out=] [--from=] [--to=] [--step=3] [--horizon=300] [--seconds=60] [--nocoins=0|1] [--workers=1]');
		process.exit(2);
	}
	return {
		tas: a.tas, out: a.out || null, level: a.level || null,
		from: +(a.from || 0), to: a.to !== undefined ? +a.to : null, step: Math.max(1, +(a.step || 3)),
		horizon: Math.max(10, +(a.horizon || 300)), drift: +(a.drift || 96), seconds: +(a.seconds || 60),
		nocoins: a.nocoins === undefined ? null : String(a.nocoins) === '1', workers: Math.max(1, +(a.workers || 1) | 0),
		random: Math.max(0, +(a.random || 0)), seed: +(a.seed || 1) | 0,
	};
}

/** the ticks at which the reference's box (with a 1-tile margin) touches a coin door or gate; the last + 1, or 0 */
function coinFreeTick(level, X, Y, n) {
	const W = level.width, H = level.height;
	let last = -1;
	for (let t = 0; t <= n; t++) {
		const x0 = Math.max(0, Math.floor((X[t] - 16) / 16)), x1 = Math.min(W - 1, Math.floor((X[t] + 31) / 16));
		const y0 = Math.max(0, Math.floor((Y[t] - 16) / 16)), y1 = Math.min(H - 1, Math.floor((Y[t] + 31) / 16));
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (COIN_DOOR_IDS.has(level.fg[y * W + x])) last = t;
	}
	return last + 1;
}

/** the reference: per tick the snapshot, position, and the three hash maps (the latest tick wins: the biggest saving) */
function reference(a) {
	const level = C.loadLevel(a.level, a.tas);   // (--level may be left out for a run inside a job folder)
	const best = C.readEetas(a.tas);
	const base = C.evaluate(level, best);
	if (!base) return { level, best, base: null };
	const n = base.complete;
	const NOC = a.nocoins !== null ? a.nocoins : false;
	const sim = new E.EESim(level); sim.reset();
	const inp = new E.EEInput();
	const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), snaps = new Array(n + 1);
	const full = new Map(), blind = new Map(), blindNC = new Map();
	const rec = (j) => { X[j] = sim.px; Y[j] = sim.py; snaps[j] = sim.snapshot(); full.set(sim.stateHash(false, NOC), j); blind.set(sim.stateHashClockBlind(NOC), j); };
	rec(0);
	for (let t = 0; t < n; t++) { E.applyMask(inp, best[t]); sim.tick(inp); rec(t + 1); }
	const coinFree = NOC ? n + 1 : coinFreeTick(level, X, Y, n);
	if (!NOC && coinFree <= n) {
		// past the last coin door the coins collected are never read again: coin-blind there too
		for (let j = coinFree; j <= n; j++) { sim.restore(snaps[j]); blindNC.set(sim.stateHashClockBlind(true), j); }
	}
	let idle = 0;
	while (idle < n && best[idle] === 0) idle++;
	return { level, best, base, n, NOC, sim, inp, X, Y, snaps, full, blind, blindNC, coinFree, idle, to: Math.min(a.to === null ? n : a.to, n) };
}

/** best[0..i) + the edges' inputs + the rest, with `shift` idle ticks added (> 0) or taken out (< 0) at the start */
function spliceRun(R, edges, shift) {
	const { best, idle } = R;
	const body = [];
	let at = 0;
	for (const e of edges) { for (let q = at; q < e.i; q++) body.push(best[q]); for (const x of e.seq) body.push(x); at = e.j; }
	for (let q = at; q < best.length; q++) body.push(best[q]);
	if (shift > 0) return Uint8Array.from([...new Array(shift).fill(0), ...body]);
	if (shift < 0) return -shift <= idle ? Uint8Array.from(body.slice(-shift)) : null;
	return Uint8Array.from(body);
}

/**
 * The start ticks from + step * (wi + nw * m) (worker wi of nw): proposals, each replayed (plain, else with the clock
 * compensated in the idle start); returns { good: [{i, j, k, seq, exact, save, shift}], tried, tLast, proposals, exact }.
 */
function searchPart(R, a, wi, nw) {
	const { level, best, base, n, NOC, sim, inp, X, Y, snaps, full, blind, blindNC, to } = R;
	// the changes at a tick: skips, and an option held 1-4 ticks with 0-2 reference ticks dropped
	const OPT = [];
	for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPT.push(h | v | j);
	const changes = (t) => {
		const out = [];
		if (t + 1 < n) out.push({ skip: 1, rep: [] });
		if (t + 2 < n) out.push({ skip: 2, rep: [] });
		for (let L = 1; L <= 4; L++) for (let D = 0; D <= 2; D++) {
			if (t + L + D >= n) continue;
			for (const o of OPT) {
				if (D === 0) { let same = true; for (let k = 0; k < L; k++) if (best[t + k] !== o) { same = false; break; } if (same) continue; }
				out.push({ skip: L + D, rep: new Array(L).fill(o) });
			}
		}
		return out;
	};
	const t0 = Date.now();
	const proposals = new Map();   // "i:j:k" -> {i, j, k, seq, exact}
	let tried = 0, tLast = a.from, dead = false;
	sim.onEvent = (k) => { if (k === 'death') dead = true; };
	for (let m = 0; ; m++) {
		const t = a.from + a.step * (wi + nw * m);
		if (t >= to || (Date.now() - t0) / 1000 >= a.seconds) break;
		tLast = t;
		for (const ch of changes(t)) {
			tried++;
			sim.restore(snaps[t]); dead = false;
			let k = 0;
			for (const o of ch.rep) { E.applyMask(inp, o); sim.tick(inp); k++; }
			let r = t + ch.skip;
			while (k < a.horizon && r < n && !dead && !sim.is_dead) {
				const jf = full.get(sim.stateHash(false, NOC));
				if (jf !== undefined) {   // an exact rejoin (the other tools find those too; kept as a proof edge)
					if (jf > t + k) { const seq = ch.rep.slice(); for (let q = t + ch.skip; seq.length < k; q++) seq.push(best[q]); proposals.set(`${t}:${jf}:${k}`, { i: t, j: jf, k, seq, exact: true }); }
					break;
				}
				let jb = blind.get(sim.stateHashClockBlind(NOC));
				if ((jb === undefined || jb <= t + k) && blindNC.size) { const j2 = blindNC.get(sim.stateHashClockBlind(true)); if (j2 !== undefined) jb = j2; }
				if (jb !== undefined && jb > t + k) {
					const seq = ch.rep.slice(); for (let q = t + ch.skip; seq.length < k; q++) seq.push(best[q]);
					const key = `${t}:${jb}:${k}`;
					if (!proposals.has(key)) proposals.set(key, { i: t, j: jb, k, seq, exact: false });
					break;
				}
				if (Math.abs(sim.px - X[r]) + Math.abs(sim.py - Y[r]) > a.drift) break;
				E.applyMask(inp, best[r]); sim.tick(inp); k++; r++;
			}
		}
	}
	// --random: random multi-tick changes for that many seconds (the GPU's pert and sticky families, which are blind on
	// time-door levels there: they look for exact rejoins): at a random start tick, a prefix of P = 5..40 ticks
	// (pert: the reference shifted by the drop D, each input replaced by a random option with 5-20%; sticky: a random
	// option held and redrawn with 15% per tick), then the reference from t + D + P; clock-blind rejoins as above
	let rs = (0x9e3779b9 ^ ((a.seed | 0) * 0x85ebca6b) ^ ((wi + 1) * 0xc2b2ae35)) >>> 0 || 1;
	const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
	const t1 = Date.now();
	let randomTried = 0;
	while (a.random > 0 && (Date.now() - t1) / 1000 < a.random && to - a.from > 50) {
		const t = a.from + Math.floor(rnd() * (to - a.from - 45));
		const P = 5 + Math.floor(rnd() * 36), ds = Math.floor(rnd() * 16), D = ds < 7 ? 1 : ds < 13 ? 2 : 3 + (ds - 13);
		if (t + D + P >= n) continue;
		const sticky = rnd() < 0.5, rate = sticky ? 0.15 : [0.05, 0.1, 0.2][Math.floor(rnd() * 3)];
		const rep = new Array(P);
		let held = OPT[Math.floor(rnd() * 18)];
		for (let q = 0; q < P; q++) {
			if (sticky) { if (q > 0 && rnd() < rate) held = OPT[Math.floor(rnd() * 18)]; rep[q] = held; }
			else rep[q] = rnd() < rate ? OPT[Math.floor(rnd() * 18)] : best[t + D + q];
		}
		randomTried++;
		sim.restore(snaps[t]); dead = false;
		let k = 0;
		for (const o of rep) { E.applyMask(inp, o); sim.tick(inp); k++; if (dead || sim.is_dead) break; }
		let r = t + D + P;
		while (k < a.horizon && r < n && !dead && !sim.is_dead) {
			const jf = full.get(sim.stateHash(false, NOC));
			let j = jf, exact = true;
			if (j === undefined) {
				exact = false;
				j = blind.get(sim.stateHashClockBlind(NOC));
				if ((j === undefined || j <= t + k) && blindNC.size) { const j2 = blindNC.get(sim.stateHashClockBlind(true)); if (j2 !== undefined) j = j2; }
			}
			if (j !== undefined) {
				if (j > t + k) {
					const seq = rep.slice(); for (let q = t + D + P; seq.length < k; q++) seq.push(best[q]);
					const key = `${t}:${j}:${k}`;
					if (!proposals.has(key)) proposals.set(key, { i: t, j, k, seq, exact });
				}
				break;
			}
			if (Math.abs(sim.px - X[r]) + Math.abs(sim.py - Y[r]) > a.drift) break;
			E.applyMask(inp, best[r]); sim.tick(inp); k++; r++;
		}
	}
	tried += randomTried;
	// every proposal replayed: plain, else compensated in the idle start
	const good = [];
	for (const p of proposals.values()) {
		const s = p.j - p.i - p.k;
		if (s <= 0) continue;
		for (const shift of p.exact ? [0] : level.hasTimeDoors ? [0, s, s - 1000] : [0]) {
			const cand = spliceRun(R, [p], shift);
			if (!cand) continue;
			const ev = C.evaluate(level, cand, false);
			if (ev && ev.runTicks < base.runTicks && ev.deaths <= base.deaths) { good.push({ ...p, save: base.runTicks - ev.runTicks, shift }); break; }
		}
	}
	let exact = 0;
	for (const p of proposals.values()) if (p.exact) exact++;
	return { good, tried, tLast, proposals: proposals.size, exact };
}

async function main() {
	const a = parseArgs();
	const meter = C.tickMeter();
	const R = reference(a);
	const { level, base, n, NOC, coinFree, idle, to } = R;
	if (!base) { console.log(`[phase] ${a.tas} does not finish the level`); meter.stop(); return; }
	console.log(`[phase] ${path.basename(a.tas)}: completes at ${n}, run ${C.fmt(base.runTicks)} (${base.runTicks}); ticks ${a.from}..${to} step ${a.step}, horizon ${a.horizon}; ` +
		`time doors ${level.hasTimeDoors ? 'yes' : 'no'}, ${idle} idle ticks before the first input, coins ${NOC ? 'optional' : coinFree <= n ? `blind from tick ${coinFree}` : 'counted'}` +
		(a.workers > 1 ? `; ${a.workers} workers` : ''));
	const t0 = Date.now();
	let parts;
	if (a.workers > 1) {
		parts = await Promise.all(Array.from({ length: a.workers }, (_, wi) => new Promise((resolve) => {
			const w = new Worker(__filename, { workerData: { a, wi, nw: a.workers, ticksBuf: meter.buf } });
			w.once('message', resolve);
			w.once('error', (e) => { console.log(`[phase] worker ${wi}: ${e && e.message || e}`); resolve({ good: [], tried: 0, tLast: a.from, proposals: 0, exact: 0 }); });
		})));
	} else parts = [searchPart(R, a, 0, 1)];
	const good = [].concat(...parts.map((p) => p.good));
	const tried = parts.reduce((s, p) => s + p.tried, 0), nProp = parts.reduce((s, p) => s + p.proposals, 0), nExact = parts.reduce((s, p) => s + p.exact, 0);
	const tLast = Math.max(...parts.map((p) => p.tLast));
	console.log(`[phase] searched ticks ${a.from}..${tLast} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${tried} changes, ${nProp} proposals (${nExact} exact)`);
	console.log(`[phase] ${good.length} verified (${good.filter((g) => g.shift !== 0).length} with the clock shifted in the idle start)` +
		(good.length ? `; best single -${Math.max(...good.map((g) => g.save))}` : ''));
	// combinations: weighted interval scheduling over the plain ones, over the compensated ones, and over all
	const schedule = (list) => {
		const E2 = list.slice().sort((x, y) => x.j - y.j || x.i - y.i), m = E2.length;
		const dp = new Array(m + 1).fill(0), ch = new Array(m + 1).fill(-1);
		const prev = E2.map((e, x) => { for (let y = x - 1; y >= 0; y--) if (E2[y].j <= e.i) return y; return -1; });
		for (let x = 0; x < m; x++) { const take = E2[x].save + (prev[x] >= 0 ? dp[prev[x] + 1] : 0); if (take > dp[x]) { dp[x + 1] = take; ch[x + 1] = x; } else dp[x + 1] = dp[x]; }
		const pick = [];
		for (let x = m; x > 0;) { if (ch[x] >= 0) { pick.push(E2[ch[x]]); x = prev[ch[x]] + 1; } else x--; }
		return pick.reverse();
	};
	let bestRun = null;
	const consider = (edges, shifts, tag) => {
		if (!edges.length) return;
		for (const shift of shifts) {
			const cand = spliceRun(R, edges, shift);
			if (!cand) continue;
			const ev = C.evaluate(level, cand);
			const v = C.judge(ev, base, base.deaths);
			if (v.accept && (!bestRun || ev.runTicks < bestRun.ev.runTicks)) { bestRun = { ev, edges, shift, tag }; }
		}
	};
	const plain = good.filter((g) => g.shift === 0), comp = good.filter((g) => g.shift !== 0);
	consider(schedule(plain), [0], 'plain');
	const around = (s) => [s, s - 1, s + 1, s - 2, s + 2, s - 3, s + 3];
	if (comp.length) {
		const pc = schedule(comp);
		consider(pc, around(pc.reduce((x, e) => x + e.shift, 0)), 'compensated');
		const all = schedule(good);
		consider(all, around(all.filter((e) => e.shift !== 0).reduce((x, e) => x + e.shift, 0)), 'all');
	}
	for (const g of good.slice().sort((x, y) => y.save - x.save || x.i - y.i).slice(0, 5)) consider([g], [g.shift], 'single');
	if (!bestRun) { console.log(`[phase] nothing accepted`); meter.stop(); return; }
	const r = bestRun;
	console.log(`[phase] ${r.tag}: ${r.edges.length} shortcut${r.edges.length > 1 ? 's' : ''}${r.shift ? `, clock shifted ${r.shift > 0 ? '+' : ''}${r.shift} in the idle start` : ''}: ` +
		`${C.fmt(base.runTicks)} -> ${C.fmt(r.ev.runTicks)} (-${base.runTicks - r.ev.runTicks})`);
	console.log(`[phase] used: ${r.edges.map((e) => `${e.i}->${e.j} (-${e.save})`).join(', ')}`);
	if (a.out) { C.writeEetas(a.out, r.ev.ms); console.log(`[phase] written ${a.out}`); }
	meter.stop();
}

if (isMainThread) main().catch((e) => { console.log('[phase] error', e && e.stack || e); process.exit(1); });
else {
	const { a, wi, nw, ticksBuf } = workerData;
	E.setTickCounter(new BigInt64Array(ticksBuf));
	const R = reference(a);
	const res = R.base ? searchPart(R, a, wi, nw) : { good: [], tried: 0, tLast: a.from, proposals: 0, exact: 0 };
	E.flushTicks();
	parentPort.postMessage(res);
}
