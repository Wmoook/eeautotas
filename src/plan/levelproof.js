'use strict';
// THE WHOLE-LEVEL PROOF (n5-p4-perfect, 2026-09-30): an exhaustive search over EXACT engine states from the level start
// that either finds a route of at most C - 1 run ticks or PROVES that none exists: with a route of R run ticks in hand,
// C = R proves it TAS-PERFECT (no input sequence finishes the level in fewer run ticks), up to 53-bit state hash
// collisions (a better route survives unless one of its <= C states collides with a kept entry: P <= C x entries / 2^53).
//
// THE SEARCH. The run timer starts at the end of the first tick with an input, so a route = k idle ticks (free) + its
// inputs; the idle trajectory until the ball rests (its state hash repeats) gives the SOURCES s_0..s_R (every later idle
// start is s_R). Layer d of a source = the state after d more ticks, the first one an input: a finish at layer d is a
// route of d - 1 run ticks, the same for every source, so one depth bound C serves them all and states merge across them
// (a state seen at layer d' <= d was searched with at least as much budget: the later copy is pruned). Depth-first with a
// TRANSPOSITION TABLE (stateHash -> the least layer it was searched at; open addressing, a full table keeps what it has:
// less pruning, never unsound), the 18 inputs (endgame.probeMasks: an input axis the state does not read is simulated
// once; a jump that cannot jump not simulated: the same state), deaths kept as moves where the level kills. A state is
// cut when layer + h > C, h = the admissible ticks until the complete:
//   h = 1 + the endgame's kinematic envelope (endgame.lowerBound: the centre's earliest tick in a trophy cell, walls
//       ignored, portals through its portal field) where nothing kills; where something kills, the least of it and
//       DEATH_MIN + 1 + the speed-limit bound from the nearest respawn (a way through a death); a dead ball: its dead
//       ticks left + the same from the respawns.
// PARALLEL: the main thread expands every source to SPLIT layers (breadth first, merged, cut) and hands the frontier to
// worker threads as TASKS (the source index + the inputs from it: a worker replays them); each worker searches its tasks
// depth first with its own table (kept across tasks: the bound C is global). A route found anywhere lowers C to its layer
// - 1 for every worker (the tables stay valid: an entry was searched with a larger budget); at the end with nothing found
// below C the search is a proof for C.
//
// API: proveLevel(levelSpec, {C, threads, seconds, split, ttBits, route, onProgress}) -> Promise<{status 'proof' | 'time'
//   | 'stopped', C (the proven layer bound: no finish at a layer <= C; run ticks >= C), best (masks of the best route found,
//   or null), bestRun, nodes, tasks, starts, ms, collisionP}>; levelSpec = {file} (an .eelvl / level json) or {json}.
//   CLI: tools/perfect/provelevel.js.
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../eesim.js');
const EG = require('../endgame.js');
const B = require('./bounds.js');
const T = require('./types.js');

const DEATH_MIN = 54;

function loadLevel(spec) {
	if (spec.file) return T.loadLevelFile(spec.file);
	if (spec.json) return E.loadLevel(spec.json);
	throw new Error('levelproof: no level');
}

/** the per-level search context: the bound and the engine (o.field: also the order-aware route bound's lattice field,
 *  src/math/routelb.js, at the state's own abstract state: walls, gates, local speed caps, portals, deaths) */
function contextOf(L, o = {}) {
	const egB = EG.boundContext(L);
	const SB = B.staticOf(L);
	const canDie = !!SB.deaths || (() => { try { return require('../goexplore.js').deathsOf(L) !== null; } catch (e) { return true; } })();
	// the least speed-limit bound (walls ignored: endgame.freeTicks) from any respawn tile to a trophy cell
	let hResp = 0;
	if (canDie) {
		hResp = Infinity;
		for (const r of SB.respawn) {
			const x = (r % L.width) * 16, y = Math.floor(r / L.width) * 16;
			const v = EG.freeTicks(egB, x - 16, x + 16, y - 16, y + 16);
			if (v < hResp) hResp = v;
		}
		if (!Number.isFinite(hResp)) hResp = 0;
		// o.hResp: a sound bound from every respawn tile to a trophy given by the caller (wholepar.js: the rel field's least
		// value over the respawn tiles, bounds.js at()'s own death way): the larger kept; absent = as before
		if (o.hResp !== undefined && Number.isFinite(o.hResp) && o.hResp > hResp) hResp = o.hResp;
	}
	// the field part: per abstract state key the order-aware cost-to-go field over the 8-px lattice (routelb.togo)
	const RL = o.field ? require('../math/routelb.js').createRouteLB(L, { togoCheap: o.field !== 'full' }) : null;
	const togo = RL ? RL.togoFor : null;
	// THE REACH FIELD'S PROOF (src/reach.js, RCH3, physics mode only): -1 = no input sequence takes the ball from that
	// state to a trophy (the whole level, doors relaxed: passable and floors; deaths as its edges where the level has
	// them): a state there is cut whatever its layer (the editor's and the searches' prune; o.reach === false: off)
	let rf = null;
	if (o.reach !== false) {
		try { const RF = require('../reach.js'); const f = RF.reachField(L); if (f && f.mode !== 'walk') rf = { f, costAt: RF.costAt }; } catch (e) { rf = null; }
	}
	/** h(sim, lim): the admissible ticks until has_silver_crown (> lim: only that it is above lim) */
	function h(sim, lim) {
		if (sim.has_silver_crown) return 0;
		if (sim.is_dead) {
			const left = Math.max(0, Math.floor((16.0 - sim._dead_offset) / 0.3 - 1e-9));
			return left + hResp + 1;
		}
		if (rf !== null && rf.costAt(rf.f, sim) < 0) return Infinity;
		let v = EG.lowerBound(egB, sim, lim) + 1;
		if (canDie && v > DEATH_MIN + 1 + hResp) v = DEATH_MIN + 1 + hResp;
		if (togo !== null && v <= lim) {
			const f = togo(sim);
			if (f > v) v = f;
		}
		return v;
	}
	return { egB, canDie, h, hResp, reach: !!rf };
}

/** the idle sources: [snapshot] until the ball rests (-1: it never does within maxIdle, or it dies idling) */
function sourcesOf(L, maxIdle) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset(); E.applyMask(inp, 0);
	const out = [sim.snapshot()];
	let hs = sim.stateHash();
	for (let k = 0; k < maxIdle; k++) {
		sim.tick(inp);
		if (sim.is_dead || sim.has_silver_crown) return { sources: out, rests: -1, why: sim.is_dead ? 'the idle ball dies' : 'the idle ball finishes' };
		const h2 = sim.stateHash();
		if (h2 === hs) return { sources: out, rests: k };
		hs = h2;
		out.push(sim.snapshot());
	}
	return { sources: out, rests: -1, why: `the idle ball does not rest within ${maxIdle} ticks` };
}

// ---------------------------------------------------------------- the transposition table
function makeTT(bits) {
	const size = 1 << bits, mask = size - 1;
	const K = new Float64Array(size), D = new Uint16Array(size);
	let n = 0, full = 0;
	return {
		/** true when the state was searched at a layer <= d (prune); else records d */
		seen(hs, d) {
			if (hs === 0) hs = 1;
			let i = (hs % 4294967296) & mask;
			for (let p = 0; p < 12; p++) {
				const v = K[i];
				if (v === 0) { if (n < size * 0.85) { K[i] = hs; D[i] = d; n++; } else full++; return false; }
				if (v === hs) { if (D[i] <= d) return true; D[i] = d; return false; }
				i = (i + 1) & mask;
			}
			full++;
			return false;
		},
		/** forget every entry (a task that ended early left entries of states whose subtrees it did not finish) */
		clear() { K.fill(0); n = 0; },
		stats: () => ({ entries: n, full, size }),
	};
}

// ---------------------------------------------------------------- the depth-first search (a worker's, or the main's)
function makeSearcher(L, ctx, ttBits) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	const tt = makeTT(ttBits);
	const MS = EG.MASK_SETS;
	const firstMasks = Array.from(MS[3]).filter((m) => m !== 0);
	const stack = [];
	const path = new Uint8Array(4096);
	let C = Infinity, nodes = 0, cut = 0, merged = 0, stopAt = Infinity, stopped = false, found = null, nodeCap = Infinity, splitMe = false;
	/** search from the current sim state at layer d (the inputs path[0..d) from its source); first = this is a source */
	function dfs(d, first) {
		if (stopped || found) return;
		nodes++;
		if ((nodes & 0x3fff) === 0) { if (Date.now() > stopAt) { stopped = true; return; } if (nodes > nodeCap) { stopped = true; splitMe = true; return; } }
		if (sim.has_silver_crown) { if (d <= C) found = { layer: d, path: Array.from(path.subarray(0, d)) }; return; }
		const lim = C - d;
		if (lim < 1) return;
		const hv = ctx.h(sim, lim);
		if (hv > lim) { cut++; return; }
		if (!first && tt.seen(sim.stateHash(), d)) { merged++; return; }
		const snap = stack[d] = sim.snapshot(stack[d]);
		const masks = first ? firstMasks : EG.probeMasks(sim, inp, snap);
		let noJump = 0;
		for (let k = 0; k < masks.length; k++) {
			const m = masks[k];
			if ((m & 1) && (noJump & (1 << (m & 30))) !== 0) continue;
			if (first || k > 0) { sim.restore(snap); E.applyMask(inp, m); sim.tick(inp); }
			if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
			if (sim.is_dead && !ctx.canDie) continue;
			path[d] = m;
			dfs(d + 1, false);
			if (stopped || found) return;
		}
	}
	return {
		tt, sim,
		setC(c) { C = c; },
		/** run one task: the state = source snapshot + the prefix inputs; returns {found, nodes, stopped} */
		run(srcSnap, prefix, deadline, maxNodes) {
			found = null; stopped = false; splitMe = false; stopAt = deadline;
			const n0 = nodes;
			nodeCap = maxNodes > 0 ? n0 + maxNodes : Infinity;
			sim.restore(srcSnap);
			for (let i = 0; i < prefix.length; i++) { E.applyMask(inp, prefix[i]); sim.tick(inp); path[i] = prefix[i]; }
			if (sim.is_dead && !ctx.canDie) return { found: null, nodes: 0, stopped: false };
			dfs(prefix.length, prefix.length === 0);
			// (a task that ended early (a find, a split, the deadline) leaves entries of unfinished subtrees: forgotten)
			if (found || stopped) tt.clear();
			return { found, nodes: nodes - n0, stopped: stopped && !splitMe, split: splitMe };
		},
		stats: () => ({ nodes, cut, merged, tt: tt.stats() }),
	};
}

// ---------------------------------------------------------------- the worker
if (!isMainThread && workerData && workerData.levelproof) {
	const L = loadLevel(workerData.spec);
	const ctx = contextOf(L, { field: workerData.field || false });
	const { sources } = sourcesOf(L, workerData.maxIdle);
	const S = makeSearcher(L, ctx, workerData.ttBits);
	S.setC(workerData.C);
	parentPort.on('message', (m) => {
		if (m.type === 'C') { S.setC(m.C); return; }
		if (m.type === 'task') {
			const r = S.run(sources[m.src], Uint8Array.from(m.prefix), m.deadline, m.maxNodes || 0);
			parentPort.postMessage({ type: 'done', id: m.id, found: r.found ? { layer: r.found.layer, path: r.found.path, src: m.src } : null, nodes: r.nodes, stopped: r.stopped, split: r.split, stats: S.stats() });
			return;
		}
		if (m.type === 'quit') process.exit(0);
	});
	parentPort.postMessage({ type: 'ready' });
}

// ---------------------------------------------------------------- the main side
/**
 * proveLevel(spec, o) (see the header). o.C: the layer bound to prove (no finish at a layer <= C; default the given
 * route's run ticks: o.route masks). o.split: the layers expanded before the tasks (default 3), o.threads (default 4),
 * o.seconds (default 600), o.ttBits (22), o.maxIdle (3000).
 */
async function proveLevel(spec, o = {}) {
	const t0 = Date.now();
	const L = loadLevel(spec);
	const ctx = contextOf(L, { field: o.field || false });
	const maxIdle = o.maxIdle || 3000;
	const src = sourcesOf(L, maxIdle);
	if (src.rests < 0) return { status: 'unsupported', why: src.why, ms: Date.now() - t0 };
	const sources = src.sources;
	let C = o.C;
	let best = null, bestRun = Infinity;
	if (o.route) {
		const Cm = require('../common.js');
		const ev = Cm.evaluate(L, o.route, false);
		if (ev) { best = o.route.subarray(0, ev.complete); bestRun = ev.runTicks; if (C === undefined) C = ev.runTicks; }
	}
	if (C === undefined) throw new Error('levelproof: no C and no route');
	const deadline = t0 + (o.seconds || 600) * 1000;
	const say = o.onProgress || (() => {});
	// the tasks: every source expanded breadth first to `split` layers (merged by state hash, cut by h), the frontier
	const split = o.split !== undefined ? o.split : 3;
	const sim = new E.EESim(L), inp = new E.EEInput();
	const seen = new Map();   // hash -> layer
	let tasks = [];
	let expandedMain = 0;
	const MS = EG.MASK_SETS;
	const firstMasks = Array.from(MS[3]).filter((m) => m !== 0);
	const check = (layer, prefix, k) => {
		// a finish found while splitting
		if (sim.has_silver_crown && layer <= C) {
			const masks = new Uint8Array(k + prefix.length);
			masks.set(prefix, k);
			return masks;
		}
		return null;
	};
	/** expand a task's state `layers` layers breadth first (merged by state hash within this expansion, cut by h): the
	 *  subtasks (the frontier) and the finishes seen on the way */
	const expand = (k, prefix0, layers, seen) => {
		let layer = [{ prefix: prefix0 }];
		for (let d = 0; d < layers && layer.length; d++) {
			const next = [];
			for (const node of layer) {
				sim.restore(sources[k]);
				for (const m of node.prefix) { E.applyMask(inp, m); sim.tick(inp); }
				const depth = node.prefix.length;
				const snap = sim.snapshot();
				const masks = depth === 0 ? firstMasks : EG.probeMasks(sim, inp, snap);
				for (let q = 0; q < masks.length; q++) {
					const m = masks[q];
					if (depth === 0 || q > 0) { sim.restore(snap); E.applyMask(inp, m); sim.tick(inp); }
					expandedMain++;
					const prefix = node.prefix.concat([m]);
					const fin = check(depth + 1, prefix, k);
					if (fin) { const ev = require('../common.js').evaluate(L, fin, false); if (ev && ev.runTicks < bestRun) { best = ev.ms; bestRun = ev.runTicks; C = Math.min(C, depth + 1 - 1); say({ ev: 'found', runTicks: ev.runTicks, layer: depth + 1, C, ms: Date.now() - t0, where: 'split' }); } continue; }
					if (sim.is_dead && !ctx.canDie) continue;
					const lim = C - (depth + 1);
					if (lim < 1) continue;
					const hv = ctx.h(sim, lim);
					if (hv > lim) continue;
					const hs = sim.stateHash();
					const had = seen.get(hs);
					if (had !== undefined && had <= depth + 1) continue;
					seen.set(hs, depth + 1);
					next.push({ prefix, slack: lim - hv });
				}
			}
			layer = next;
		}
		return layer.map((node) => ({ src: k, prefix: node.prefix, slack: node.slack || 0 }));
	};
	const seen0 = new Map();
	for (let k = 0; k < sources.length; k++) for (const t of expand(k, [], split, seen0)) tasks.push(t);
	// the largest slack first (the largest subtrees: the workers' load balance)
	tasks.sort((a, b) => b.slack - a.slack);
	say({ ev: 'tasks', tasks: tasks.length, starts: sources.length, rests: src.rests, C, ms: Date.now() - t0 });
	const threads = Math.max(1, o.threads || 4);
	const ttBits = o.ttBits || 22;
	// a task past taskNodes nodes is handed back and split taskSplit layers further (the subtasks first in the queue)
	const taskNodes = o.taskNodes > 0 ? o.taskNodes : 20e6, taskSplit = o.taskSplit > 0 ? o.taskSplit : 2;
	let nodes = 0, done = 0, stoppedTasks = 0, splits = 0, lastSay = 0;
	const wk = [];
	const byId = new Map();
	let idSeq = 0;
	await new Promise((resolve) => {
		let next = 0, live = 0, finished = false;
		const finish = () => { if (finished) return; finished = true; for (const w of wk) { try { w.postMessage({ type: 'quit' }); } catch (e) { /* gone */ } } resolve(); };
		const give = (w) => {
			if (Date.now() > deadline) { if (live === 0) finish(); return; }
			if (next >= tasks.length) { if (live === 0) finish(); return; }
			const t = tasks[next++];
			const id = idSeq++;
			byId.set(id, t);
			live++;
			w.postMessage({ type: 'task', id, src: t.src, prefix: t.prefix, deadline, maxNodes: taskNodes });
		};
		for (let i = 0; i < threads; i++) {
			const w = new Worker(__filename, { workerData: { levelproof: true, spec, C, ttBits, maxIdle, field: o.field || false } });
			wk.push(w);
			w.on('message', (m) => {
				if (m.type === 'ready') { give(w); give(w); return; }
				if (m.type === 'done') {
					live--; nodes += m.nodes;
					const t = byId.get(m.id);
					byId.delete(m.id);
					// (a given task sits before `next`: taking it out of the list moves `next` back by one)
					const drop = (x) => { const i = tasks.indexOf(x); if (i >= 0) { tasks.splice(i, 1); if (i < next) next--; } };
					if (m.split && t) {
						// (the heavy task, split further: its subtasks next in the queue; it does not count as done)
						splits++;
						drop(t);
						const subs = expand(t.src, t.prefix, taskSplit, new Map());
						subs.sort((a, b) => b.slack - a.slack);
						tasks.splice(next, 0, ...subs);
						say({ ev: 'split', depth: t.prefix.length, subtasks: subs.length, tasks: tasks.length, done, nodes, ms: Date.now() - t0 });
					} else if (m.found && t) {
						// (the task that found a route stopped at its find: searched again with the new bound, at the end)
						drop(t);
						tasks.push({ src: t.src, prefix: t.prefix, slack: 0 });
					} else {
						done++;
						if (m.stopped) stoppedTasks++;
					}
					if (m.found) {
						const masks = new Uint8Array(m.found.src + m.found.path.length);
						masks.set(m.found.path, m.found.src);
						const ev = require('../common.js').evaluate(L, masks, false);
						if (ev && ev.runTicks < bestRun) {
							best = ev.ms; bestRun = ev.runTicks;
							// (a finish at layer d is a route of d - 1 run ticks; the next proof: no finish at a layer <= d - 1)
							C = Math.min(C, m.found.layer - 1);
							for (const x of wk) x.postMessage({ type: 'C', C });
							say({ ev: 'found', runTicks: ev.runTicks, layer: m.found.layer, C, ms: Date.now() - t0 });
						}
					}
					if (Date.now() - lastSay > 30000) { lastSay = Date.now(); say({ ev: 'progress', done, tasks: tasks.length, next, live, splits, nodes, ms: Date.now() - t0 }); }
					give(w);
				}
			});
			w.on('error', (e) => { say({ ev: 'error', error: e.message }); live = Math.max(0, live - 1); give(w); });
		}
	});
	const proven = done >= tasks.length && stoppedTasks === 0 && Date.now() <= deadline + 60000;
	const entries = (1 << ttBits) * threads;
	return {
		status: proven ? 'proof' : 'time', C, best, bestRun, nodes: nodes + expandedMain, tasks: tasks.length, done, stoppedTasks,
		starts: sources.length, rests: src.rests, ms: Date.now() - t0,
		// a better route escapes only if one of its <= C states collides with one of the kept entries (53-bit hashes)
		collisionP: (C * entries) / Math.pow(2, 53),
		statement: proven ? `no input sequence finishes the level at a tick layer <= ${C} after its first input, from any idle start (0..${src.rests}): every route takes >= ${C} run ticks` : null,
	};
}

module.exports = { proveLevel, contextOf, sourcesOf, makeSearcher, makeTT };
