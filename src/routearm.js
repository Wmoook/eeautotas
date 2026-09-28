'use strict';
// The route arm of the one search (src/bursts.js, goexplore.js --bursts=1 --rArm=<share>): once Find a route has a
// route, a share of the GPU bursts goes to searches FROM THE ROUTE ITSELF for ways that reach the route's later points
// sooner (a macro-path change: the route's own states, not the archive's cells, so the exact line a precision skip
// needs is not merged away before it starts). The guidance is the route's own schedule (route-informed time-to-go):
//   the order: a time-to-go field to the route's tiles of [s + minAhead, s + maxSpan] (src/reach.js with those tiles as
//     goals, each seeded with (jEnd - j) / kappa, kappa = the route's own pace in ticks per tile of the reach model:
//     explore.js --hunt's field, the leaps branch's goalField, worktree-wf_e3f403bd-7f9-2 src/leaps.js), so a state that
//     can meet the route LATER sooner is first, whatever the trophy field says about the way there (Egg Quest II: the
//     trophy field rates the chimney top ~30 tiles worse than the east branch the route takes);
//   the target: `eegpu explore --ahead=1` from the route's exact state at s: a hit = a state at a tile the route first
//     enters minAhead+ ticks after s and minGain+ ticks after this state, close to the route's state there (position +
//     3 x speed within maxDist px); states more than `slack` ticks behind the route's first visit of their tile dropped;
//   the cells: per start two explores, a local one with 1 px, 1/32 px/tick and exact heights in a box of `box` tiles
//     around the start (the chimney's line lives in 0.05-0.65 px bands: 2 px cells or coarser merge it away, 1 px
//     finds it in a quarter to half of the merged graphs; src/out/night/eq2_chimney_user.md section 4), then 4 px and
//     1/16 px/tick over the route's stretch (the bursts' first setting, the leaps' first grain), each with its own salt;
//   the splice: each hit's state, then the route's own inputs from next to the met visit (offsets -3..12), checked every
//     tick for a state of the route (coin-blind hash, then the physical state alone), the route from there; every
//     candidate replayed from the start (common.js evaluate) and taken only when it finishes in fewer ticks than the
//     search's bound with no more deaths: then it is a route like the workers' (the finish callback: goexplore.js
//     routeFound, the bound, head L's schedule). Every hit goes into every worker's archive too (an on-route cell ahead
//     of the schedule: head L's lead), so a hit no splice finishes still steers the CPU search.
// The starts: a pass over the route every `step` ticks from the cursor (a newer route keeps the cursor's tick), a start
// skipped when the field sees no way from it to gain minPot ticks (its potential: jEnd - s - kappa x cost(state at s),
// the leaps' prior). Differences to leaps.js (the optimizer's, not merged): main's native build (the first visit per
// tile, no --visits / --samediscrete), a local fine-cell explore per start, the route of Find a route instead of the job's
// best run, and no second-stage rejoin explore.
// Module: create(o) -> {setRoute(masks), ready(), run(lane, hooks) (a promise: one start's searches), stats()}.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.js');
const E = C.E;
const RF = require('./reach.js');

const DEFAULTS = { minAhead: 60, minGain: 20, maxSpan: 3000, maxDepth: 900, maxDist: 24, slack: 100, box: 32, margin: 12, localDepth: 520, localSlack: 400, localTries: 3, rejoinK: 2, rejoinGain: 100, rejoinDepth: 600, rejoinS: 8, step: 150, minPot: 60, perS: 12, tailH: 400, tailDrift: 400, loose: 6, maxHits: 120 };
// per start: the local fine explore, then the stretch's 4 px one
const GRAINS = [{ cqx: 1, cqv: 32, qy: 0, qvy: 0, local: true, text: '1 px, 1/32, exact y (local)' }, { cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16, local: false, text: '4 px, 1/16' }];
const OFFS = [0, 1, -1, 2, -2, 3, -3, 4, 5, 6, 8, 10, 12];
const FAIL_MAX = 3, OOM_AGAIN = 2;

const physKey = (sim) => `${sim.px},${sim.py},${sim.speed_x},${sim.speed_y},${sim._q0},${sim._q1},${sim.jump_count},${sim.on_ground ? 1 : 0}`;
const masksOf = (s) => Uint8Array.from(String(s), (c) => (c.charCodeAt(0) - 48) & 31);
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

/** the route's trace: per tick (after t ticks) position, speeds, the reach lookups' inputs, the tile, the coin-blind
 *  state hash (its latest tick) and the physical state (its latest tick); kappa = the route's pace (ticks per tile of
 *  the trophy field along it, its total variation: detours count both ways), 2.4 .. 12 */
function trace(L, field, masks, attempt = false) {
	let ev = C.evaluate(L, masks, false);
	// (an attempt, before any route: inputs that do not finish, cut before a death (skipfind.js attemptOf); its "later
	// points" are the arm's goals as a route's are)
	if (!ev && attempt) { const at = require('./skipfind.js').attemptOf(L, masks); ev = at.finish || at; }
	if (!ev || !ev.ms || ev.ms.length < 2) return null;
	const ms = ev.ms, n = ms.length, W = L.width, H = L.height;
	const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1);
	const Q0 = new Int32Array(n + 1), Q1 = new Int32Array(n + 1), SL = new Float64Array(n + 1), T = new Int32Array(n + 1);
	const hashTick = new Map(), physTick = new Map();
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let tv = 0, prev = -1;
	for (let t = 0; t <= n; t++) {
		if (t > 0) { E.applyMask(inp, ms[t - 1]); sim.tick(inp); }
		X[t] = sim.px; Y[t] = sim.py; VX[t] = sim.speed_x; VY[t] = sim.speed_y; Q0[t] = sim._q0; Q1[t] = sim._q1; SL[t] = sim._slippery;
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		T[t] = tx >= 0 && ty >= 0 && tx < W && ty < H ? ty * W + tx : -1;
		hashTick.set(sim.stateHash(false, true), t);
		physTick.set(physKey(sim), t);
		if (field) {
			const c = RF.costAt(field, sim);
			if (c >= 0 && prev >= 0) tv += Math.abs(c - prev);
			if (c >= 0) prev = c;
		}
	}
	const kappa = Math.max(2.4, Math.min(12, tv > 1 ? n / tv : 5));
	// (an attempt's landings after a long fall (LAND_AIR+ ticks in the air: where a path is chosen, e.g. Egg Quest II's
	// opening fall, after which the user's chimney climb starts): the arm's first starts on it)
	const lands = [];
	if (ev.attempt) {
		sim.reset();
		for (let t = 0, air = 0; t < n; t++) {
			E.applyMask(inp, ms[t]); sim.tick(inp);
			if (!sim.on_ground) { air++; continue; }
			if (air >= LAND_AIR) lands.push(t + 1);
			air = 0;
		}
	}
	return { L, masks: ms, n, ev, X, Y, VX, VY, Q0, Q1, SL, T, hashTick, physTick, kappa, W, H, attempt: !!ev.attempt, lands };
}
const LAND_AIR = 90;
const stateAt = (R, t) => ({ px: R.X[t], py: R.Y[t], speed_y: R.VY[t], _q0: R.Q0[t], _q1: R.Q1[t], _slippery: R.SL[t] });

/** the time-to-go field to the route's tiles of [g0, jEnd], each seeded (jEnd - j) / kappa (the latest visit of a tile:
 *  the lowest), within the box when one is given; null: no goal */
function goalField(R, s, g0, jEnd, box) {
	const goals = new Map();
	for (let j = g0; j <= jEnd; j++) {
		const t = R.T[j];
		if (t < 0) continue;
		if (box) { const x = t % R.W, y = (t / R.W) | 0; if (x < box[0] || y < box[1] || x > box[2] || y > box[3]) continue; }
		const c = (jEnd - j) / R.kappa;
		if (!(goals.get(t) <= c)) goals.set(t, c);
	}
	if (!goals.size) return null;
	return RF.reachField(R.L, { goals: [...goals].map(([tile, cost]) => ({ tile, cost })), maxCost: (jEnd - s + 200) / R.kappa });
}

/** a candidate against R: a route (C.evaluate finishes, no more deaths than R's) -> {ms, runTicks}; on an attempt
 *  (R.attempt) also a run that does not finish and does not die: a shortened attempt -> {ms, runTicks, attempt: true};
 *  else null */
function judgeOf(R, ms) {
	const ev = C.evaluate(R.L, ms, false);
	if (ev) return ev.deaths > R.ev.deaths ? null : { ms: ev.ms, runTicks: ev.runTicks };
	if (!R.attempt) return null;
	const sim = new E.EESim(R.L), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < ms.length; t++) { E.applyMask(inp, ms[t]); sim.tick(inp); if (sim.is_dead) return null; }
	return { ms: Uint8Array.from(ms), runTicks: ms.length, attempt: true };
}
/** the verified route through the hits of a search from s (tails with an exact rejoin, then the physical state, then a
 *  few loose splices), faster than `boundTicks` (fewer ticks) with no more deaths; null when none. On an attempt: a
 *  shortened attempt (the attempt's later state reached sooner, no death) or a route */
function spliceHits(R, s, hits, boundTicks, p) {
	const { L, masks, n, X, Y, hashTick, physTick } = R;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < s; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	const s0 = sim.snapshot();
	const prefix = masks.subarray(0, s);
	const sorted = hits.slice().sort((a, b) => b.gain - a.gain || a.inputs.length - b.inputs.length);
	const perRef = new Map(), list = [];
	for (const h of sorted) {
		const key = Math.round(h.refTick / 4), c = perRef.get(key) || 0;
		if (c >= 3) continue;
		perRef.set(key, c + 1);
		list.push(h);
		if (list.length >= p.maxHits) break;
	}
	let best = null, tried = 0, exact = 0, phys = 0, loose = 0;
	const consider = (ms, how) => {
		tried++;
		if (ms.length >= (best ? best.ticks : boundTicks)) return false;
		const v = judgeOf(R, ms);
		if (!v || v.ms.length >= (best ? best.ticks : boundTicks)) return false;
		best = { masks: v.ms, ticks: v.ms.length, runTicks: v.runTicks, how, attempt: !!v.attempt };
		return true;
	};
	for (const h of list) {
		const hin = masksOf(h.inputs);
		sim.restore(s0);
		let dead = false;
		for (let k = 0; k < hin.length; k++) { E.applyMask(inp, hin[k]); sim.tick(inp); if (sim.is_dead) { dead = true; break; } }
		if (dead) continue;
		const sh = sim.snapshot(), t = s + hin.length;
		let found = false;
		for (const off of OFFS) {
			const r0 = h.refTick + off;
			if (r0 <= t || r0 >= n) continue;
			sim.restore(sh);
			for (let k = 0; k < p.tailH && r0 + k < n; k++) {
				E.applyMask(inp, masks[r0 + k]); sim.tick(inp);
				if (sim.is_dead) break;
				const j = hashTick.get(sim.stateHash(false, true));
				if (j !== undefined) {
					if (j - (t + k + 1) >= p.minGain) { exact++; if (consider(concat([prefix, hin, masks.subarray(r0, r0 + k + 1), masks.subarray(j, n)]), `rejoin (tail from ${r0}, ${k + 1} ticks)`)) found = true; }
					break;
				}
				const jp = physTick.get(physKey(sim));
				if (jp !== undefined) {
					if (jp - (t + k + 1) >= p.minGain) { phys++; if (consider(concat([prefix, hin, masks.subarray(r0, r0 + k + 1), masks.subarray(jp, n)]), `physical rejoin (tail from ${r0})`)) found = true; }
					break;
				}
				const q = Math.min(n, r0 + k + 1);
				if (Math.abs(sim.px - X[q]) + Math.abs(sim.py - Y[q]) > p.tailDrift) break;
			}
			if (found) break;
		}
		// (loose splices: routes only; an attempt's candidate must meet the attempt's own state, so that it reaches its later
		// points sooner)
		if (!found && loose < p.loose && !R.attempt) {
			loose++;
			for (const off of [0, 1, -1, 2, -2]) {
				const r0 = h.refTick + off;
				if (r0 <= t || r0 >= n) continue;
				if (consider(concat([prefix, hin, masks.subarray(r0, n)]), `loose splice (the route from ${r0})`)) break;
			}
		}
	}
	return { best, tried, exact, phys, used: list.length };
}

/**
 * o: {L, field (the trophy reach field), tool, bin (the level blob's file), fp (its blobFp), work, cacheArgs, a (goexplore's
 * options: gpuCells, burstCap, pausefile), bound() (the longest route that still counts, ticks), finish(masks, how),
 * broadcast(inputs), say(event)}, opts: DEFAULTS overrides
 */
function create(o, opts = {}) {
	const p = Object.assign({}, DEFAULTS, opts);
	let R = null, cursor = -1, salt = 0, gen = 0, failStreak = 0, dead = false, again = null;
	// (the route each lane searched, a file per lane: a newer route taken by another lane meanwhile must not change the
	// tick numbers of the hits this lane splices)
	const routeFile = (lane) => path.join(o.work, `route_arm_${lane}.eetas`);
	const st = { starts: 0, skipped: 0, searches: 0, rejoins: 0, sec: 0, hits: 0, spliced: 0, routes: 0, saved: 0, fieldMs: 0, failed: 0, pass: 0, best: 0 };
	/** a (newer) route: its trace at the next start (a burst of faster routes costs one replay); the cursor keeps its tick */
	let pending = null, pendingAtt = null, lands = [];
	const setRoute = (masks) => {
		if ((R && !R.attempt && masks.length >= R.n) || (pending && masks.length >= pending.length)) return;
		pending = masks;
		pendingAtt = null;
		gen++;
	};
	/** before any route: the search's nearest attempt (a newer one replaces it; its cursor keeps its tick) */
	const setAttempt = (masks) => {
		if ((R && !R.attempt) || pending) return;
		pendingAtt = masks;
	};
	const take = () => {
		if (!pending && !pendingAtt) return;
		const att = !pending;
		const R2 = trace(o.L, o.field, pending || pendingAtt, att);
		pending = null; pendingAtt = null;
		if (!R2) return;
		const was = R;
		R = R2;
		if (cursor < 0) cursor = p.minAhead;
		// (an attempt: its landings after a long fall first, each landing state once (a newer attempt of the same lineage
		// lands in the same state: nextStart); a route after attempts: its own pass from the start)
		// (the landing and 30 ticks after it: on Egg Quest II's base route the arm found the chimney from t575, 31 ticks
		// after the landing, in 1 of 3-4 salts)
		if (R.attempt) lands = R.lands.flatMap((t) => [t, t + 30]).filter((t) => t >= p.minAhead && t + p.minAhead + p.minGain < R.n);
		else { lands = []; if (was && was.attempt) cursor = p.minAhead; }
	};
	const landSeen = new Set();
	/** the next landing start of the attempt not searched yet (by its state), or -1 */
	const landStart = () => {
		while (lands.length) {
			const t = lands.shift();
			const sim = new E.EESim(o.L), inp = new E.EEInput();
			sim.reset();
			for (let k = 0; k < t; k++) { E.applyMask(inp, R.masks[k]); sim.tick(inp); }
			const key = sim.stateHash(false, true);
			if (landSeen.has(key)) continue;
			landSeen.add(key);
			return t;
		}
		return -1;
	};
	/** the next start: its tick, field, potential (null: none worth a search in a whole pass) */
	const nextStart = () => {
		for (let k = 0; R && k < Math.ceil(R.n / p.step) + 1 + lands.length; k++) {
			if (cursor + p.minAhead + p.minGain >= R.n) { cursor = p.minAhead + ((st.pass + 1) * 37) % p.step; st.pass++; }
			let s = cursor;
			const ls = R.attempt && !p.starts ? landStart() : -1;
			// (opts.starts: only these start ticks, in that order: tests, the path benchmark)
			if (p.starts) { if (!p.starts.length) return null; s = p.starts.shift(); }
			else if (ls >= 0) s = ls;
			// (an attempt: only its landings (where a path is chosen), each landing state once: before any route the arm's
			// GPU time is the bursts', which find the rooms the first route needs (Stupid Fox: 15-26 bursts in 600 s with
			// the arm's pass on the attempts, 42 without, and no route))
			else if (R.attempt && !p.attemptPass) return null;
			else cursor += p.step;
			const jEnd = Math.min(R.n, s + p.maxSpan);
			const t0 = Date.now();
			let f = null;
			try { f = goalField(R, s, Math.min(jEnd, s + p.minAhead), jEnd, null); } catch (e) { f = null; }
			st.fieldMs += Date.now() - t0;
			const c = f ? RF.costAt(f, stateAt(R, s)) : -1;
			const pot = c >= 0 ? Math.round(jEnd - s - R.kappa * c) : -1;
			if (pot < p.minPot) { st.skipped++; continue; }
			return { s, jEnd, f, pot };
		}
		return null;
	};
	const runExplore = (args, lane, hooks) => new Promise((res) => {
		const stop = path.join(o.work, `stop_${lane}`);
		try { fs.unlinkSync(stop); } catch (e) { /* none */ }
		const full = [...args, ...(o.cacheArgs || []), `--stopfile=${stop}`, ...(o.a.pausefile ? [`--pausefile=${o.a.pausefile}`] : []), `--parent=${process.pid}`];
		const [cmd, argv] = /\.js$/i.test(o.tool) ? [process.execPath, [o.tool, ...full]] : [o.tool, full];
		let ch;
		try { ch = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true }); } catch (e) { res({ hits: [], done: null, err: e.message }); return; }
		if (hooks && hooks.child) hooks.child(ch, true);
		const hits = [], rejoins = [];
		let buf = '', done = null, err = '', readyAt = 0;
		const t0 = Date.now();
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				if (!line.startsWith('{')) continue;
				let ev;
				try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'hit' && ev.inputs !== undefined) hits.push({ tick: ev.tick, gain: ev.gain, refTick: ev.refTick, inputs: ev.inputs });
				else if (ev.ev === 'rejoin' && ev.inputs !== undefined) rejoins.push({ j: ev.j, ticks: ev.ticks, saving: ev.saving, inputs: ev.inputs });
				else if (ev.ev === 'ready') readyAt = Date.now();
				else if (ev.ev === 'done') done = ev;
				else if (ev.error) err = String(ev.error);
			}
		});
		ch.stderr.on('data', (d) => { err = (err + d).slice(-400); });
		ch.on('error', (e) => { err = e.message; });
		ch.on('close', (code) => {
			if (hooks && hooks.child) hooks.child(ch, false);
			res({ hits, rejoins, done, err: err.trim(), code, sec: (Date.now() - (readyAt || t0)) / 1000 });
		});
	});
	/** the second stage: from the best hits (by gain, one per 8 ticks of the met visit, at most rejoinK), every move to an
	 *  exact state of the route (coin-blind), the route from there; the fastest verified route under boundTicks, or null */
	const rejoinStage = async (R0, s, hits, reach, lane, hooks, boundTicks) => {
		const seen = new Set(), top = [];
		for (const h of hits.slice().sort((a, b) => b.gain - a.gain)) {
			if (h.gain < p.rejoinGain || seen.has(h.refTick >> 3)) continue;
			seen.add(h.refTick >> 3); top.push(h);
			if (top.length >= p.rejoinK) break;
		}
		let best = null;
		for (const h of top) {
			if (hooks && hooks.stopped && hooks.stopped()) break;
			const pf = path.join(o.work, `arm_prefix_${lane}.eetas`);
			fs.writeFileSync(pf, Buffer.from(h.inputs, 'latin1'));
			const cells = o.a.gpuCells || 25;
			const args = ['explore', o.bin, routeFile(lane), `--from=${s}`, `--prefix=${pf}`, '--rejoin=1', '--nocoins=1', `--gain=${p.minGain}`, `--depth=${p.rejoinDepth}`, `--seconds=${p.rejoinS}`,
				'--coarse=0', '--cqx=0.5', '--cqv=4', '--qy=0.5', '--qvy=4', '--discrete=1', `--cap=${Math.max(4096, Math.min(o.a.burstCap > 0 ? o.a.burstCap : 1048576, Math.floor(1.5 * 2 ** (cells - 1) / p.rejoinDepth)))}`,
				`--cells=${cells}`, `--reach=${reach}`, '--prune=0'];
			const rr = await runExplore(args, lane, hooks);
			st.rejoins++; st.sec += rr.sec || 0;
			if (!rr.done) { if (/out of memory/i.test(rr.err || '')) break; continue; }
			for (const e of rr.rejoins.sort((x, y) => y.saving - x.saving)) {
				const ms = concat([R0.masks.subarray(0, s), masksOf(e.inputs), R0.masks.subarray(e.j, R0.n)]);
				if (ms.length >= (best ? best.ticks : boundTicks)) continue;
				const v = judgeOf(R0, ms);
				if (!v || v.ms.length >= (best ? best.ticks : boundTicks)) continue;
				best = { masks: v.ms, ticks: v.ms.length, runTicks: v.runTicks, attempt: !!v.attempt, how: `hit (gain ${h.gain}) + every move to the ${R0.attempt ? 'attempt' : 'route'}'s tick ${e.j} (exact, coin-blind)` };
			}
			if (best) break;
		}
		return best;
	};
	/** one start: the searches (both grains), the splices; resolves {s, pot, hits, route (ticks saved) | 0, sec, ends} */
	const run = async (lane, hooks) => {
		take();
		const g0 = gen;
		// (a start whose searches found the GPU's memory full goes again, at most OOM_AGAIN times: a shared GPU is full for
		// a while now and then, and the pass would skip that stretch of the route)
		const c = again && again.R === R ? again.c : nextStart();
		again = null;
		if (!c) return null;
		st.starts++;
		const R0 = R;
		C.writeEetas(routeFile(lane), R0.masks);
		const rfile = routeFile(lane);
		const sx = Math.max(0, Math.min(R0.W - 1, Math.trunc(R0.X[c.s] + 8) >> 4)), sy = Math.max(0, Math.min(R0.H - 1, Math.trunc(R0.Y[c.s] + 8) >> 4));
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let t = c.s; t <= c.jEnd; t++) {
			const tt = R0.T[t];
			if (tt < 0) continue;
			const x = tt % R0.W, y = (tt / R0.W) | 0;
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		}
		const stretch = [Math.max(0, x0 - p.margin), Math.max(0, y0 - p.margin), Math.min(R0.W - 1, x1 + p.margin), Math.min(R0.H - 1, y1 + p.margin)];
		const local = [Math.max(0, sx - p.box), Math.max(0, sy - p.box), Math.min(R0.W - 1, sx + p.box), Math.min(R0.H - 1, sy + p.box)];
		const file = path.join(o.work, `arm_${lane}.reach`);
		const out = { s: c.s, pot: c.pot, hits: 0, saved: 0, sec: 0, ends: [], how: '' };
		// (the route in ticks that a find must beat; an attempt: its own length, a shortened attempt reaches its end sooner)
		const boundOf = () => (R0.attempt ? R0.n : o.bound() + 1);
		const bound0 = boundOf();
		// (the local fine search localTries times, each with its own salt: which state stands for a 1 px cell decides whether
		// the chimney's line lives; one merged graph in 3-5 has it; then the stretch's 4 px search)
		const plan = [];
		for (let k = 0; k < p.localTries; k++) plan.push(0);
		for (let gi = 1; gi < GRAINS.length; gi++) plan.push(gi);
		for (const gi of plan) {
			if (hooks && hooks.stopped && hooks.stopped()) break;
			const g = GRAINS[gi];
			let f = c.f;
			if (g.local) { try { f = goalField(R0, c.s, Math.min(c.jEnd, c.s + p.minAhead), c.jEnd, local) || c.f; } catch (e) { f = c.f; } }
			try { fs.writeFileSync(file, RF.reachFileBytes(Object.assign({}, f, { toGoals: false }), o.fp)); } catch (e) { st.failed++; continue; }
			// (the local search: a shorter depth (the box is crossed sooner), a table twice the bursts' (its cells are 16x
			// finer in x and exact in y: the chimney's line at 1 px needs ~250 layers of ~25-50 K states), and the route's
			// schedule looser (its U-turns pass tiles the route crossed 30-100 ticks before))
			const depth = Math.max(10, Math.min(g.local ? p.localDepth : p.maxDepth, c.jEnd - c.s - p.minGain));
			const cells = (o.a.gpuCells || 25) + (g.local ? 1 : 0);
			const cap = Math.max(4096, Math.min(o.a.burstCap > 0 ? o.a.burstCap : 1048576, Math.floor(1.5 * 2 ** (cells - 1) / depth)));
			const args = ['explore', o.bin, rfile, `--from=${c.s}`, '--ahead=1', `--gain=${p.minGain}`, `--minahead=${p.minAhead}`, `--maxdist=${p.maxDist}`, `--slack=${g.local ? p.localSlack : p.slack}`,
				`--depth=${depth}`, `--region=${(g.local ? local : stretch).join(',')}`, '--coarse=0', `--cqx=${g.cqx}`, `--cqv=${g.cqv}`, `--qy=${g.qy}`, `--qvy=${g.qvy}`, '--discrete=1',
				`--cap=${cap}`, `--cells=${cells}`, `--seconds=${p.perS}`, `--salt=${salt++}`, `--reach=${file}`, '--prune=0'];
			// (the route file may be rewritten by a newer route meanwhile: the explore read it at its start, and the splice
			// below uses the trace R0 of the route it searched)
			const r = await runExplore(args, lane, hooks);
			st.searches++; st.sec += r.sec || 0;
			if (!r.done) {
				st.failed++;
				out.ends.push(r.err ? r.err.split('\n').pop().slice(0, 120) : `exit ${r.code}`);
				if (/out of memory/i.test(r.err || '')) { out.oom = true; if ((c.oomN = (c.oomN || 0) + 1) <= OOM_AGAIN) again = { c, R: R0 }; break; }
				if (hooks && hooks.stopped && hooks.stopped()) break;
				// (a tool that cannot run these searches: after FAIL_MAX failures in a row the arm stops for the search)
				if (++failStreak >= FAIL_MAX) { dead = true; o.say({ ev: 'warning', text: `route arm: ${FAIL_MAX} failed searches in a row (${out.ends[out.ends.length - 1]}): off for this search` }); break; }
				continue;
			}
			failStreak = 0;
			out.ends.push(r.done.end);
			out.sec += r.sec || 0;
			out.hits += r.hits.length;
			st.hits += r.hits.length;
			if (o.onHits) o.onHits(c.s, gi, r.hits, r.done);
			// every hit (an on-route state ahead of the route's schedule) into every archive: head L's lead
			for (const h of r.hits.slice().sort((a, b) => b.gain - a.gain).slice(0, 8)) {
				try { o.broadcast(C.eetasBytes(concat([R0.masks.subarray(0, c.s), masksOf(h.inputs)])).toString('latin1')); } catch (e) { /* skip */ }
			}
			if (r.hits.length) {
				const bestGain = r.hits.reduce((m, h) => Math.max(m, h.gain), 0);
				if (bestGain > st.best) st.best = bestGain;
				let sp = spliceHits(R0, c.s, r.hits, Math.min(bound0, boundOf()), p);
				// no tail met the route: the rest re-joined exactly by every move from the best hits (explore --rejoin=1 from
				// the route's state at s + the hit: a state the route reaches later; the leaps' second stage)
				if (!sp.best) sp = { best: await rejoinStage(R0, c.s, r.hits, file, lane, hooks, Math.min(bound0, boundOf())) };
				if (sp.best) {
					st.spliced++;
					const saved = R0.n - sp.best.ticks;
					out.saved = Math.max(out.saved, saved);
					out.how = sp.best.how;
					// (a shortened attempt, before any route: into every archive and to the editor (its route splice), as the
					// path skips' shortcuts)
					if (sp.best.attempt) { st.shortcuts = (st.shortcuts || 0) + 1; if (o.shortcut) o.shortcut(sp.best.masks, saved, `route arm on the nearest attempt from ${c.s} (${g.text}): ${sp.best.how}`); break; }
					st.routes++; st.saved += saved;
					o.finish(sp.best.masks, `route arm from ${c.s} (${g.text}): ${sp.best.how}`);
					break;
				}
			}
			if (gen !== g0) break;   // (a newer route: its own starts)
		}
		return out;
	};
	return {
		setRoute, setAttempt, run, ready: () => !dead && (R !== null || pending !== null || pendingAtt !== null),
		/** the arm's target is an attempt (no route yet) */
		onAttempt: () => (pending === null && (R ? R.attempt : pendingAtt !== null)),
		stats: () => Object.assign({ kappa: R ? Math.round(R.kappa * 100) / 100 : null, cursor, route: R ? R.n : 0 }, st),
	};
}

module.exports = { create, trace, goalField, spliceHits, DEFAULTS, GRAINS };
