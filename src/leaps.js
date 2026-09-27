'use strict';
// Long-range shortcuts ("leaps"): path changes that skip hundreds to thousands of ticks of a finished run, found from
// the run alone (no hints). The optimizer's exact-rejoin windows (320-800 ticks) cannot see them: a leap leaves the
// run early and meets it again much later, somewhere the run reaches only after a detour (a loop, a spur to a switch,
// a snake through a level). Per start tick i of the run (a pass: every leapStep ticks, or ranked: rank()):
//   1. the order: a time-to-go field to the run's tiles of [i + minAhead, i + maxSpan] (src/reach.js with those
//      positions as goals, each seeded with its schedule (jEnd - j) / kappa, like explore.js --hunt: the physics-aware
//      lead; kappa = the run's own pace, ticks per tile of the reach model along it (its total variation: detours count
//      both ways); no trophy ceiling, nothing pruned), written as an RCH3 file for the GPU;
//   2. every move from the run's exact state at i on the GPU (`eegpu explore --ahead=1 --visits=1`, one state per cell
//      (4 px, 1/16 px/tick, --discrete), the layer cap sized so the table lasts the depth: the field's lead keeps the
//      cut). A hit = a state in a tile the run enters at least minAhead ticks after i and at least minGain ticks later
//      than this state, close to the run's state there (|dpos| + 3 |dvel| <= maxDist px; EVERY visit of the tile, not
//      only the first: loops and spurs come back to the same tiles);
//   3. the splice (spliceHits, CPU): from each hit "tails" (explore.js --tails): the run's own inputs from next to the
//      visit it met (offsets -3..12), checked every tick for an exact state of the run (stateHash, coin-blind with
//      nocoins): run[0..i) + hit + tail + run[j..] replays exactly; else run[0..i) + hit + run[r+o..] as it is (a
//      leap that skips a switch the rest never needed: every later state differs in it); and when neither finishes
//      faster, the rest re-joined exactly by every move from the best rejoinK hits (`eegpu explore --prefix=<run[0..i)
//      + hit> --rejoin=1`, rejoinS seconds). Every candidate is replayed from the start (C.evaluate: finish, deaths,
//      random-portal chance) and judged with THE rule (C.judge) against the run before it counts.
// A faster run replaces the run at once; the pass goes on over the new run (the remaining starts found again by their
// state hashes). rank() (order 'rank'): per block of start ticks one such field; the potential of a start = the most
// the model says a way from there could gain at the run's pace (a prior only: the reach model is optimistic, on Egg
// Quest II every start has one).
// Module: prepare(level, masks, o), rank(info, o), leapField(info, i, jEnd, o), exploreArgs(...), runExplore(tool,
// args, o), spliceHits(info, cand, hits, o), context(o), leapFrom(ctx, info, i, o) (one start: gpusearch.js's leap
// rounds), startsOf(info, o), search(o) (the loop of the command line).
// usage: node src/leaps.js --tas=<run.eetas> [--level=<level id | job id | level .json>] [--out=<best.eetas>]
//        [--seconds=600] [--perS=30] [--leapStep=250] [--order=run|rank] [--from=] [--to=] [--minAhead=300]
//        [--minGain=20] [--maxSpan=3000] [--maxDepth=1500] [--maxDist=24] [--kappa=0 (the run's pace)] [--grain=0]
//        [--cap=0] [--cells=27] [--nocoins=1] [--rejoinK=3] [--rank=N (print the ranked starts)] [--tool=<eegpu>]
// JSON lines on stdout: {ev: start | pass | search | leap | done}; --out is rewritten at every leap.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.js');
const E = C.E;
const G = require('./gpu.js');
const RF = require('./reach.js');
const S = require('./splice.js');

// the cells (explore --cqx --cqv --qy --qvy): 4 px and 1/16 px/tick first (the bursts' first setting), then 2 px, then
// 8 px with 1/8 (a wider reach per table); a start searched again (another round) takes the next
const GRAINS = [{ cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16 }, { cqx: 0.5, cqv: 16, qy: 0.5, qvy: 16 }, { cqx: 0.125, cqv: 8, qy: 0.125, qvy: 8 }];
const DEFAULTS = {
	minAhead: 300,    // the met visit is at least this many ticks after the start (the every-move windows cover less)
	minGain: 20,      // ticks sooner than the run
	minPot: 60,       // a start is searched when its geometric potential is at least this
	kappa: 0,         // ticks per tile of the reach model; 0 = the run's own pace (kappaOf)
	step: 50,         // start ticks ranked every step
	block: 200,       // start ticks per time-to-go field of the rank
	maxSpan: 3000,    // the met visit at most this many ticks after the start
	leapStep: 250,    // a pass over the run: a start every leapStep ticks (order 'run'), or order 'rank' (rank())
	order: 'run', passes: 0,
	maxDepth: 1500,   // explore layers at most
	maxDist: 24,      // closeness to the run's state at the visit (px, speeds x 3)
	margin: 12,       // tiles around the run's stretch: the explore's region
	perS: 30,         // GPU seconds per search
	tailH: 400, tailDrift: 96, maxHits: 160, loose: 12,
	rejoinK: 3, rejoinMin: 20, rejoinDepth: 600, rejoinS: 8,   // no splice: every move from the best rejoinK hits (gain >= minGain + rejoinMin) to an exact state of the run
	nocoins: 1,
	sameDiscrete: 1,   // hits only where the discrete state (switches, keys, team, effects; coins with nocoins 0) is the run's there
};

/** The run's trace for the leap search: positions, tiles, state hashes per tick (after t ticks), the latest tick of each
 *  hash, the wall map. masks are cut at the finish. null when the run does not finish. */
function prepare(level, masks, o = {}) {
	const nc = o.nocoins === undefined ? !!DEFAULTS.nocoins : !!+o.nocoins;
	const ev = C.evaluate(level, masks);
	if (!ev) return null;
	const ms = ev.ms;
	const r = C.replay(level, ms, { trace: true });
	const tr = S.trace(level, ms, nc);
	const n = tr.n;
	const W = level.width, Hh = level.height;
	const T = new Int32Array(n + 1);
	for (let t = 0; t <= n; t++) {
		const tx = Math.trunc(r.X[t] + 8) >> 4, ty = Math.trunc(r.Y[t] + 8) >> 4;
		T[t] = tx >= 0 && ty >= 0 && tx < W && ty < Hh ? ty * W + tx : -1;
	}
	const hashTick = new Map();
	for (let t = 0; t <= n; t++) hashTick.set(tr.H[t], t);   // (the latest tick wins: the biggest saving)
	// the reach field's inputs per tick (the gravity queue, ice), for costAt; the physical state's key per tick (physKey:
	// the latest tick of each)
	const physTick = new Map();
	const Q0 = new Int32Array(n + 1), Q1 = new Int32Array(n + 1), SL = new Float64Array(n + 1);
	{
		const sim = new E.EESim(level);
		sim.reset();
		const inp = new E.EEInput();
		Q0[0] = sim._q0; Q1[0] = sim._q1; SL[0] = sim._slippery;
		physTick.set(physKey(sim), 0);
		for (let t = 0; t < n; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); Q0[t + 1] = sim._q0; Q1[t + 1] = sim._q1; SL[t + 1] = sim._slippery; physTick.set(physKey(sim), t + 1); }
	}
	const info = { level, masks: ms, n, ev, X: r.X, Y: r.Y, VX: r.VX, VY: r.VY, Q0, Q1, SL, T, H: tr.H, hashTick, physTick, nc, W, Hh };
	// the trophy field: the level's walls and the run's pace (kappa: ticks per tile of the reach model along the run, its
	// total variation: detours count both ways), so a run that is as tight as its own pace has no potential anywhere
	const f0 = o.field0 || (() => { try { return RF.reachField(level, {}); } catch (e) { return null; } })();
	info.field0 = f0;
	info.cls = f0 ? f0.cls : null;
	let tv = 0;
	if (f0) {
		let prev = -1;
		for (let t = 0; t <= n; t++) {
			const c = RF.costAt(f0, stateAtTick(info, t));
			if (c >= 0 && prev >= 0) tv += Math.abs(c - prev);
			if (c >= 0) prev = c;
		}
	}
	info.pace = tv > 1 ? n / tv : 0;
	return info;
}
/** the ball's physical state only (position, speeds, the gravity queue, jumps, ground): equal for two states that move
 *  alike whatever their switches, keys, coins or team; a tail that meets the run so is spliced there and replayed (a leap
 *  that skipped a switch, a coin or a team toggle the rest of the run never needs: the replay decides) */
const physKey = (sim) => `${sim.px},${sim.py},${sim.speed_x},${sim.speed_y},${sim._q0},${sim._q1},${sim.jump_count},${sim.on_ground ? 1 : 0}`;

/** the run's state after t ticks as reach.js costAt reads it */
const stateAtTick = (info, t) => ({ px: info.X[t], py: info.Y[t], speed_y: info.VY[t], _q0: info.Q0[t], _q1: info.Q1[t], _slippery: info.SL[t] });
/** kappa for the rank and the explore's order: o.kappa when given, else the run's own pace (2.4 .. 12 ticks per tile) */
const kappaOf = (info, o) => (o.kappa > 0 ? o.kappa : Math.max(2.4, Math.min(12, info.pace || 5)));

/** the time-to-go field to the run's tiles of ticks [g0, T0], each seeded with its schedule (T0 - j) / kappa (reach.js
 *  goals: explore.js --hunt's field): cost(x) = min over those j of the model's way from x to the run at j + (T0 - j) /
 *  kappa, so T0 - kappa x cost(state at i) - i = the most ticks a way from i to the run could gain at the pace kappa */
function goalField(info, i0, g0, T0, kappa) {
	const goals = new Map();
	for (let j = g0; j <= T0; j++) {
		const t = info.T[j];
		if (t < 0) continue;
		const c = (T0 - j) / kappa;
		if (!(goals.get(t) <= c)) goals.set(t, c);   // (the latest visit of a tile: the lowest cost)
	}
	if (!goals.size) return null;
	return RF.reachField(info.level, { goals: [...goals].map(([tile, cost]) => ({ tile, cost })), maxCost: (T0 - i0 + 200) / kappa });
}

/**
 * The start ticks worth a leap search, best first: [{i, j, pot}]. Per block of o.block start ticks one time-to-go field
 * (goalField) to the run's tiles from the block's end + minAhead to j = i + maxSpan; the potential of a start i = j - i
 * - kappa x cost(the run's state at i): what a way from there could gain at the run's own pace (kappaOf: a run as tight
 * as its pace everywhere has none). Starts with pot >= minPot, the local maxima (no start within 2 steps with more),
 * at most o.top (0 = all); o.skip(i, j) true: left out (searched before). o.onField(ms) per field (tests, timing).
 */
function rank(info, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const { n } = info;
	const kappa = kappaOf(info, p);
	const B = Math.max(p.step, p.block | 0);
	const all = [];
	for (let i0 = Math.max(0, p.from | 0); i0 + p.minAhead + p.minGain <= n && i0 <= (p.to > 0 ? p.to : n); i0 += B) {
		const T0 = Math.min(n, i0 + p.maxSpan);
		const g0 = Math.min(i0 + B + p.minAhead, T0);
		const t0 = Date.now();
		let f = null;
		try { f = goalField(info, i0, g0, T0, kappa); } catch (e) { f = null; }
		if (p.onField) p.onField(Date.now() - t0);
		if (!f) continue;
		for (let i = i0; i < i0 + B && i + p.minAhead + p.minGain <= n; i += p.step) {
			const c = RF.costAt(f, stateAtTick(info, i));
			if (c < 0) continue;
			const pot = Math.round(T0 - i - kappa * c);
			if (pot >= p.minPot) all.push({ i, j: T0, pot });
		}
	}
	// local maxima: a start is dropped when a start within 2 steps has more potential
	const keep = all.filter((c) => !all.some((d) => d !== c && Math.abs(d.i - c.i) <= 2 * p.step && (d.pot > c.pot || (d.pot === c.pot && d.i < c.i))));
	let out = keep.filter((c) => !(p.skip && p.skip(c.i, c.j)));
	out.sort((a, b) => b.pot - a.pot || a.i - b.i);
	if (p.top > 0) out = out.slice(0, p.top);
	return out;
}

/** The explore's order for a leap from i: a time-to-go field to the run's tiles of [i + minAhead, jEnd] (reach.js goals,
 *  each seeded with its schedule (jEnd - j) / kappa: a lower cost = more lead), as RCH3 bytes. Physics mode where the
 *  level allows (else walk mode); never a proof (the explore gets --prune=0). */
function leapField(info, i, jEnd, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const f = goalField(info, i, Math.min(jEnd, i + p.minAhead), jEnd, kappaOf(info, p));
	if (!f) return null;
	const g = Object.assign({}, f, { toGoals: false });   // (written for ordering only: --prune=0)
	return { bytes: RF.reachFileBytes(g, o.levelFp || null), mode: f.mode };
}

/** eegpu explore's arguments for one leap search */
function exploreArgs(info, cand, files, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const jEnd = Math.min(info.n, cand.jEnd || cand.j);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let t = cand.i; t <= jEnd; t++) {
		const tt = info.T[t];
		if (tt < 0) continue;
		const x = tt % info.W, y = (tt / info.W) | 0;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	const m = p.margin;
	const region = [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(info.W - 1, x1 + m), Math.min(info.Hh - 1, y1 + m)];
	const g = GRAINS[(p.grain | 0) % GRAINS.length];
	const depth = Math.max(10, Math.min(p.maxDepth, jEnd - cand.i - p.minGain));
	// the layer cap: at most what lets the table (half of 2^cells states) last the whole depth (x 1.5: layers seldom fill)
	const cells = p.cells || 27;
	const cap = Math.max(4096, Math.min(p.cap || 1048576, Math.floor(1.5 * 2 ** (cells - 1) / depth)));
	return ['explore', files.blob, files.run, `--from=${cand.i}`, '--ahead=1', '--visits=1', `--samediscrete=${p.sameDiscrete ? 1 : 0}`, `--nocoins=${info.nc ? 1 : 0}`, `--gain=${p.minGain}`, `--minahead=${p.minAhead}`,
		`--maxdist=${p.maxDist}`, '--slack=1000000000', `--depth=${depth}`, `--region=${region.join(',')}`, '--coarse=0', `--cqx=${g.cqx}`, `--cqv=${g.cqv}`,
		`--qy=${g.qy}`, `--qvy=${g.qvy}`, '--discrete=1', `--cap=${cap}`, `--cells=${cells}`, `--seconds=${p.perS}`,
		...(files.reach ? [`--reach=${files.reach}`, '--prune=0'] : []), ...(p.reserve ? [`--reserve=${p.reserve}`] : []), ...(p.extra || [])];
}

/** Runs one eegpu explore; resolves {hits, done, err, code}. o.onLayer(ev), o.stopFile, o.parent, o.cacheArgs */
function runExplore(tool, args, o = {}) {
	return new Promise((resolve) => {
		const a = [...args, ...(o.cacheArgs || []), ...(o.stopFile ? [`--stopfile=${o.stopFile}`] : []), ...(o.parent ? [`--parent=${o.parent}`] : []), `--launch-ms=${o.launchMs || 50}`];
		const [cmd, argv] = /\.js$/i.test(tool) ? [process.execPath, [tool, ...a]] : [tool, a];
		let ch;
		try { ch = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !!o.parent }); } catch (e) { resolve({ hits: [], done: null, err: e.message }); return; }
		if (o.onChild) o.onChild(ch);
		const hits = [];
		let buf = '', done = null, err = '', launchError = false;
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let ev;
				try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'hit') hits.push({ tick: ev.tick, gain: ev.gain, refTick: ev.refTick, inputs: ev.inputs });
				else if (ev.ev === 'rejoin') hits.push({ rejoin: true, j: ev.j, ticks: ev.ticks, saving: ev.saving, inputs: ev.inputs });
				else if (ev.ev === 'layer') { if (o.onLayer) o.onLayer(ev); }
				else if (ev.ev === 'ready') { if (o.onReady) o.onReady(ev); }
				else if (ev.ev === 'done') done = ev;
				else if (ev.error) { err = ev.error; if (ev.launchError) launchError = true; }
			}
		});
		ch.stderr.on('data', (d) => { err = (err + d).slice(-600); });
		ch.on('error', (e) => { err = e.message; });
		ch.on('close', (code) => resolve({ hits, done, err: err.trim(), code, launchError }));
	});
}

const masksOf = (s) => Uint8Array.from(String(s), (c) => (c.charCodeAt(0) - 48) & 31);
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

/**
 * From the explore's hits of a leap from cand.i: the fastest verified run (tails with an exact rejoin first, then a few
 * loose splices), or null. {masks, ev, saved, i, j, tick, how}. o.best: the run to beat ({runTicks, chance}; default
 * the route's own), o.baseDeaths.
 */
function spliceHits(info, cand, hits, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const { level, masks, n, X, Y, hashTick, nc } = info;
	const best0 = o.best || info.ev;
	const baseDeaths = o.baseDeaths !== undefined ? o.baseDeaths : info.ev.deaths;
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	for (let t = 0; t < cand.i; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	const s0 = sim.snapshot();
	const prefix = masks.subarray(0, cand.i);
	// the hits by gain, at most a few per met visit (the same place, the same speed)
	const sorted = hits.slice().sort((a, b) => b.gain - a.gain || a.inputs.length - b.inputs.length);
	const perRef = new Map();
	const list = [];
	for (const h of sorted) {
		const key = Math.round(h.refTick / 4);
		const c = perRef.get(key) || 0;
		if (c >= 3) continue;
		perRef.set(key, c + 1);
		list.push(h);
		if (list.length >= p.maxHits) break;
	}
	let best = null, tried = 0, exact = 0, phys = 0;
	const consider = (ms, how, h, j, edgeLen) => {
		tried++;
		const ev = C.evaluate(level, ms);
		const cmp = best ? best.ev : best0;
		const v = C.judge(ev, cmp, baseDeaths);
		if (!v.accept || !(ev.runTicks < best0.runTicks)) return false;
		best = { masks: ev.ms, ev, saved: best0.runTicks - ev.runTicks, i: cand.i, j, tick: h.tick, refTick: h.refTick, how, edgeLen: edgeLen || 0 };
		return true;
	};
	let loose = 0;
	for (const h of list) {
		const hin = masksOf(h.inputs);
		// the hit's state
		sim.restore(s0);
		let dead = false;
		for (let k = 0; k < hin.length; k++) { E.applyMask(inp, hin[k]); sim.tick(inp); if (sim.is_dead) { dead = true; break; } }
		if (dead) continue;
		const sh = sim.snapshot();
		const t = cand.i + hin.length;   // (the hit's run tick)
		let found = false;
		for (const off of [0, 1, -1, 2, -2, 3, -3, 4, 5, 6, 8, 10, 12]) {
			const r0 = h.refTick + off;
			if (r0 <= t || r0 >= n) continue;
			sim.restore(sh);
			for (let k = 0; k < p.tailH && r0 + k < n; k++) {
				E.applyMask(inp, masks[r0 + k]); sim.tick(inp);
				if (sim.is_dead) break;
				const j = hashTick.get(sim.stateHash(false, nc));
				if (j !== undefined) {
					if (j - (t + k + 1) >= p.minGain) {
						const ms = concat([prefix, hin, masks.subarray(r0, r0 + k + 1), masks.subarray(j, n)]);
						exact++;
						if (consider(ms, `exact rejoin (tail from ${r0}, ${k + 1} ticks)`, h, j, hin.length + k + 1)) found = true;
					}
					break;
				}
				// the same physical state as the run's at jp, another discrete state (a switch, a key, the team, coins): the
				// run from jp as it is; only the replay can say whether it still finishes
				const jp = info.physTick.get(physKey(sim));
				if (jp !== undefined) {
					if (jp - (t + k + 1) >= p.minGain) {
						phys++;
						if (consider(concat([prefix, hin, masks.subarray(r0, r0 + k + 1), masks.subarray(jp, n)]), `physical rejoin (tail from ${r0}, ${k + 1} ticks; switches, keys or coins differ)`, h, jp)) found = true;
					}
					break;
				}
				// drifting away from the run's own path at the same offset: no rejoin to come
				const q = Math.min(n, r0 + k + 1);
				if (Math.abs(sim.px - X[q]) + Math.abs(sim.py - Y[q]) > p.tailDrift) break;
			}
			if (found) break;
		}
		if (!found && loose < p.loose) {
			// no exact rejoin: the run's inputs from next to the met visit, as they are (the replay decides)
			loose++;
			for (const off of [0, 1, -1, 2, -2]) {
				const r0 = h.refTick + off;
				if (r0 <= t || r0 >= n) continue;
				if (consider(concat([prefix, hin, masks.subarray(r0, n)]), `loose splice (the run from ${r0})`, h, r0)) break;
			}
		}
	}
	return { best, tried, exact, phys, hits: hits.length, used: list.length };
}

/**
 * The files one leap search needs (the level's GPU blob, the run, the order field), in o.work.
 * ctx = {files, levelFp}.
 */
function context(o) {
	fs.mkdirSync(o.work, { recursive: true });
	const files = { blob: path.join(o.work, 'level.bin'), run: path.join(o.work, 'run.eetas'), reach: path.join(o.work, 'leap.reach') };
	const blob = o.blob || G.levelBlob(o.level);
	if (!o.blobFile) fs.writeFileSync(files.blob, blob);
	else files.blob = o.blobFile;
	return { files, levelFp: o.levelFp || G.blobFp(blob) };
}

/**
 * One leap search from the run's state at tick i (the met visits up to i + maxSpan): the order field, the GPU explore,
 * the splices. Resolves {best (spliceHits' or null), hits, done (explore's done event, null on a failure), err,
 * launchError, fieldMs, field, tried, exact}. o: the search options plus tool, cacheArgs, stopFile, parent, launchMs,
 * onChild, perS.
 */
async function leapFrom(ctx, info, i, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	const c = { i, j: Math.min(info.n, i + p.maxSpan) };
	c.jEnd = c.j;
	const tf = Date.now();
	let field = null;
	try { field = leapField(info, c.i, c.jEnd, Object.assign({}, p, { levelFp: ctx.levelFp })); if (field) fs.writeFileSync(ctx.files.reach, field.bytes); } catch (e) { field = null; }
	const fieldMs = Date.now() - tf;
	C.writeEetas(ctx.files.run, info.masks);
	const args = exploreArgs(info, c, { blob: ctx.files.blob, run: ctx.files.run, reach: field ? ctx.files.reach : '' }, p);
	const r = await runExplore(o.tool, args, { cacheArgs: o.cacheArgs, stopFile: o.stopFile, parent: o.parent, launchMs: o.launchMs, onChild: o.onChild, onLayer: o.onLayer, onReady: o.onReady });
	if (o.dumpHits) { try { fs.mkdirSync(o.dumpHits, { recursive: true }); fs.writeFileSync(path.join(o.dumpHits, `hits_${i}.json`), JSON.stringify(r.hits)); } catch (e) { /* diagnostics only */ } }
	const out = { best: null, hits: r.hits.length, done: r.done, err: r.err, code: r.code, launchError: r.launchError, fieldMs, field: field ? field.mode : 'none', tried: 0, exact: 0,
		bestGain: r.hits.reduce((m, h) => Math.max(m, h.gain), 0) };
	if (!r.done) return out;
	const sp = spliceHits(info, c, r.hits, p);
	Object.assign(out, { best: sp.best, tried: sp.tried, exact: sp.exact, rejoins: 0 });
	if (sp.best || !(p.rejoinK > 0) || !r.hits.length) return out;
	// no tail met the run exactly and no loose splice finished faster: the rest re-joined exactly by every move from the
	// best hits (eegpu explore --rejoin=1 from the hit's state: a state equal to one the run reaches later), the
	// hits by gain, one per met visit (refTick / 8)
	const seen = new Set(), top = [];
	for (const h of r.hits.slice().sort((a, b) => b.gain - a.gain)) {
		if (h.gain < p.minGain + p.rejoinMin || seen.has(h.refTick >> 3)) continue;
		seen.add(h.refTick >> 3); top.push(h);
		if (top.length >= p.rejoinK) break;
	}
	for (const h of top) {
		const hin = masksOf(h.inputs);
		const pre = concat([info.masks.subarray(0, i), hin]);
		const pf = path.join(path.dirname(ctx.files.run), 'leap_prefix.eetas');
		C.writeEetas(pf, pre);
		const a = ['explore', ctx.files.blob, ctx.files.run, `--prefix=${pf}`, `--from=${pre.length}`, '--rejoin=1', `--nocoins=${info.nc ? 1 : 0}`, `--gain=${p.minGain}`,
			`--depth=${p.rejoinDepth}`, `--seconds=${p.rejoinS}`, '--coarse=0', '--cqx=0.5', '--cqv=4', '--qy=0.5', '--qvy=4', '--discrete=1', `--cap=${p.cap || 1048576}`, `--cells=${p.cells || 27}`,
			...(field ? [`--reach=${ctx.files.reach}`, '--prune=0'] : []), ...(p.reserve ? [`--reserve=${p.reserve}`] : [])];
		const rr = await runExplore(o.tool, a, { cacheArgs: o.cacheArgs, stopFile: o.stopFile, parent: o.parent, launchMs: o.launchMs, onChild: o.onChild, onLayer: o.onLayer });
		out.rejoins++;
		if (!rr.done) { if (rr.launchError) { Object.assign(out, { done: null, err: rr.err, code: rr.code, launchError: true }); return out; } continue; }
		for (const e of rr.hits.filter((x) => x.rejoin).sort((x, y) => y.saving - x.saving)) {
			const ms = concat([masksOf(e.inputs), info.masks.subarray(e.j, info.n)]);
			const ev = C.evaluate(info.level, ms);
			out.tried++;
			const v = C.judge(ev, out.best ? out.best.ev : info.ev, info.ev.deaths);
			if (v.accept && ev.runTicks < info.ev.runTicks) {
				out.best = { masks: ev.ms, ev, saved: info.ev.runTicks - ev.runTicks, i, j: e.j, tick: h.tick, refTick: h.refTick, how: `exact rejoin (every move from the hit, ${e.ticks - pre.length} more ticks)`, edgeLen: e.ticks - i };
				out.exact++;
			}
		}
		if (out.best) break;
	}
	return out;
}

/** the start ticks of a pass over the run: every o.leapStep ticks from o.from (order 'run'), or ranked (order 'rank') */
function startsOf(info, o = {}) {
	const p = Object.assign({}, DEFAULTS, o);
	if (p.order === 'rank') return rank(info, p).map((c) => c.i);
	const out = [];
	for (let i = Math.max(0, p.from | 0); i + p.minAhead + p.minGain <= info.n && (!(p.to > 0) || i <= p.to); i += p.leapStep) out.push(i);
	return out;
}

/**
 * The loop (the command line; gpusearch.js runs leapFrom itself): one pass over the start ticks (startsOf), each start
 * searched once (by its state hash: after a leap the pass goes on over the new run, the starts found again by hash, the
 * new ones in their place); every faster run replaces the run at once. o: {level, masks, tool, seconds, work,
 * onEvent(ev), onLeap(best), stop(), the options}. Resolves {masks, ev, saved, searches, leaps}.
 */
async function search(o) {
	const p = Object.assign({}, DEFAULTS, o);
	const t0 = Date.now();
	const secLeft = () => (p.seconds || 600) - (Date.now() - t0) / 1000;
	const emit = (ev) => { if (o.onEvent) o.onEvent(Object.assign({ t: Math.round((Date.now() - t0) / 100) / 10 }, ev)); };
	const ctx = context(o);
	let info = prepare(o.level, o.masks, p);
	if (!info) throw new Error('the run does not finish the level');
	const start = info.ev;
	const field0 = info.field0;
	const done = new Set();   // the start states searched (state hashes)
	let searches = 0, leaps = 0;
	emit({ ev: 'start', n: info.n, runTicks: info.ev.runTicks, pace: Math.round(info.pace * 100) / 100, kappa: Math.round(kappaOf(info, p) * 100) / 100 });
	for (let pass = 0; pass < 1 + (p.passes | 0) && secLeft() > 5; pass++) {
		let starts = startsOf(info, p);
		emit({ ev: 'pass', pass, starts: starts.length });
		let k = 0;
		while (k < starts.length && secLeft() > 5 && !(o.stop && o.stop())) {
			const i = starts[k++];
			if (done.has(info.H[i])) continue;
			done.add(info.H[i]);
			const r = await leapFrom(ctx, info, i, Object.assign({}, p, { perS: Math.max(3, Math.min(p.perS, Math.floor(secLeft() - 2))) }));
			searches++;
			if (!r.done) {
				emit({ ev: 'search', i, error: r.err || `exit ${r.code}`, launchError: r.launchError });
				if (o.onError && o.onError(r)) break;
				continue;
			}
			emit({ ev: 'search', i, hits: r.hits, bestGain: r.bestGain, layers: r.done.layers, end: r.done.end, sec: r.done.seconds, fieldMs: r.fieldMs, field: r.field,
				tried: r.tried, exact: r.exact, saved: r.best ? r.best.saved : 0 });
			if (r.best) {
				leaps++;
				emit({ ev: 'leap', i, j: r.best.j, tick: r.best.tick, saved: r.best.saved, runTicks: r.best.ev.runTicks, how: r.best.how, deaths: r.best.ev.deaths, chance: r.best.ev.chance });
				if (o.onLeap) await o.onLeap(r.best);
				const old = info;
				info = prepare(o.level, r.best.masks, Object.assign({}, p, { field0 }));
				// the rest of the pass on the new run: the old starts' ticks found by state hash (new ones where it changed)
				const at = new Map();
				for (let t = 0; t <= info.n; t++) if (!at.has(info.H[t])) at.set(info.H[t], t);
				const rest = starts.slice(k).map((s) => { const t = at.get(old.H[s]); return t !== undefined ? t : s - (old.n - info.n); }).filter((t) => t >= 0 && t + p.minAhead <= info.n);
				starts = rest; k = 0;
			}
		}
	}
	emit({ ev: 'done', searches, leaps, runTicks: info.ev.runTicks, saved: start.runTicks - info.ev.runTicks, sec: Math.round((Date.now() - t0) / 1000) });
	return { masks: info.masks, ev: info.ev, saved: start.runTicks - info.ev.runTicks, searches, leaps };
}

module.exports = { DEFAULTS, GRAINS, prepare, kappaOf, goalField, rank, leapField, exploreArgs, runExplore, spliceHits, context, leapFrom, startsOf, search };

// ---------------------------------------------------------------- the command line
if (require.main === module) {
	const a = C.parseArgs(process.argv.slice(2));
	if (!a.tas) { console.log('usage: node src/leaps.js --tas=<run.eetas> [--level=<level id | job id | .json>] [--out=<file>] [--seconds=600] (see the header)'); process.exit(2); }
	const level = C.loadLevel(a.level, a.tas);
	const masks = C.readEetas(a.tas);
	const num = (k) => (a[k] !== undefined ? +a[k] : undefined);
	const o = {};
	for (const k of Object.keys(DEFAULTS)) if (a[k] !== undefined) o[k] = typeof DEFAULTS[k] === 'string' ? a[k] : +a[k];
	for (const k of ['grain', 'cap', 'cells', 'top', 'from', 'to', 'reserve']) if (a[k] !== undefined) o[k] = num(k);
	if (a.dumpHits) o.dumpHits = path.resolve(a.dumpHits);
	if (a.rank) {
		const info = prepare(level, masks, o);
		if (!info) { console.log(JSON.stringify({ error: 'the run does not finish' })); process.exit(1); }
		const cands = rank(info, o);
		console.log(JSON.stringify({ ev: 'rank', n: info.n, runTicks: info.ev.runTicks, cands: cands.length }));
		for (const c of cands.slice(0, +a.rank > 1 ? +a.rank : 40)) {
			const at = (t) => { const tt = info.T[t]; return `(${tt % info.W}, ${(tt / info.W) | 0})`; };
			console.log(JSON.stringify(Object.assign({}, c, { from: at(c.i), to: at(c.j) })));
		}
		process.exit(0);
	}
	const tool = a.tool ? path.resolve(a.tool) : G.nativeTool();
	if (!tool) { console.log(JSON.stringify({ error: 'the native engine is not built (node tools/build-native.js)' })); process.exit(3); }
	const out = a.out ? path.resolve(a.out) : path.join(C.SRC, 'out', 'leaps_best.eetas');
	const work = a.work ? path.resolve(a.work) : fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-leaps-'));
	search(Object.assign(o, { level, masks, tool, seconds: +(a.seconds || 600), work, cacheArgs: G.cacheArgs(),
		onEvent: (ev) => console.log(JSON.stringify(ev)),
		onLeap: (b) => { C.writeEetas(out, b.masks); } }))
		.then((r) => { if (!a.work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* busy */ } } process.exit(r.leaps ? 0 : 1); })
		.catch((e) => { console.log(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
}
