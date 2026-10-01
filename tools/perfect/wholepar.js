'use strict';
// THE WHOLE-LEVEL PROOF IN PARALLEL (box 7 lane 'proof', cycle 2, 2026-09-30): wholeproof.js's exact search (every input
// of every tick over ENGINE states from every idle start, stateHash merge: the trigger order is in the state) run as
// src/plan/levelproof.js's depth-first search with a transposition table per worker thread (n5-p4-perfect: memory stays
// bounded by the tables, the breadth-first layers of wholeproof.js do not), under THE MAX OF EVERY ADMISSIBLE TIER:
//   'kin'   levelproof.js contextOf: 1 + endgame.lowerBound (the kinematic envelope, walls ignored, portals), a way
//           through a death (DEATH_MIN + 1 + the respawn's speed-limit bound), a dead ball's ticks left + the respawn's;
//   'togo'  + routelb.js togoFor (the order-aware cost-to-go field per abstract state over the 8-px lattice, local speed
//           caps; n5-p4-perfect): ceil(v - 1e-7) (the ticks are whole);
//   'rel'   wholeproof.js createH without the order tier: bounds.js at(the trophy field, every door open) + 1;
//   'gate'  + wholeproof.js's ORDER TIER (the doors as the state holds them until a door-changing trigger / killer tile).
// A max of admissible bounds is admissible. Every tier set is CHECKED first on every given route (h <= the ticks left at
// every tick from the first input; a violation stops the run: no claim).
// THE CONTOURS. C = the layer bound (no finish at a layer <= C <=> every route takes >= C run ticks: a finish at layer d
// is a route of d - 1 run ticks). C goes up from the start's bound (or --from) one at a time; each C is one complete
// search (a new table per worker: an entry holds the layer it was searched at for THAT C); a C that closes with nothing
// found PROVES lb = C run ticks; the first C with a finish is THE OPTIMUM (every smaller C closed): a FASTER route than
// ours when below it (replayed, written to --out); C = U (our route's run ticks) closing = OUR ROUTE IS PROVEN OPTIMAL.
//   node tools/perfect/wholepar.js <level.eelvl> [--route=<a.eetas>[,<b.eetas>]] [--U=<run ticks>] [--threads=8]
//        [--seconds=1800] [--split=3] [--ttBits=23] [--tiers=kin,togo,rel,gate] [--from=<C>] [--out=<faster.eetas>]
//        [--check=1]
// Prints JSON lines ({ev 'check' | 'C' | 'found' | 'result'}).
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../../src/eesim.js');
const EG = require('../../src/endgame.js');
const T = require('../../src/plan/types.js');
const LP = require('../../src/plan/levelproof.js');
const WP = require('./wholeproof.js');

/** the max of the chosen admissible tiers: {h(sim, lim) (> lim: only that it is above lim), canDie} */
function makeCtx(L, tiers) {
	const useTogo = tiers.has('togo');
	const useKin = useTogo || tiers.has('kin');
	const lp = LP.contextOf(L, { field: useTogo });
	const mine = (tiers.has('rel') || tiers.has('gate')) ? WP.createH(L, { gate: tiers.has('gate') }) : null;
	function h(sim, lim) {
		if (sim.has_silver_crown) return 0;
		let v = 0;
		if (useKin) {
			v = lp.h(sim, lim);
			if (v !== Math.floor(v)) v = Math.ceil(v - 1e-7);
			if (v > lim) return v;
		}
		if (mine !== null) { const a = mine.h(sim); if (a > v) v = a; }
		return v;
	}
	return { h, canDie: lp.canDie };
}

// ---------------------------------------------------------------- the worker
if (!isMainThread && workerData && workerData.wholepar) {
	const L = T.loadLevelFile(workerData.file);
	const ctx = makeCtx(L, new Set(workerData.tiers));
	const { sources } = LP.sourcesOf(L, workerData.maxIdle);
	let S = null;
	parentPort.on('message', (m) => {
		if (m.type === 'C') { S = LP.makeSearcher(L, ctx, workerData.ttBits); S.setC(m.C); parentPort.postMessage({ type: 'ready' }); return; }
		if (m.type === 'task') {
			const r = S.run(sources[m.src], Uint8Array.from(m.prefix), m.deadline);
			parentPort.postMessage({ type: 'done', id: m.id, found: r.found ? { layer: r.found.layer, path: r.found.path, src: m.src } : null, nodes: r.nodes, stopped: r.stopped });
			return;
		}
		if (m.type === 'quit') process.exit(0);
	});
	parentPort.postMessage({ type: 'up' });
}

/** the tasks for layer bound C: every source expanded breadth first `split` layers (merged, cut), or a finish found */
function tasksFor(L, ctx, sources, C, split) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	const firstMasks = Array.from(EG.MASK_SETS[3]).filter((m) => m !== 0);
	const seen = new Map();
	const tasks = [];
	let nodes = 0;
	for (let k = 0; k < sources.length; k++) {
		let layer = [{ prefix: [] }];
		for (let d = 0; d < split && layer.length; d++) {
			const next = [];
			for (const node of layer) {
				sim.restore(sources[k]);
				for (const m of node.prefix) { E.applyMask(inp, m); sim.tick(inp); }
				const snap = sim.snapshot();
				const masks = d === 0 ? firstMasks : EG.probeMasks(sim, inp, snap);
				let noJump = 0;
				for (let q = 0; q < masks.length; q++) {
					const m = masks[q];
					if ((m & 1) && (noJump & (1 << (m & 30))) !== 0) continue;
					if (d === 0 || q > 0) { sim.restore(snap); E.applyMask(inp, m); sim.tick(inp); }
					if (!(m & 1) && sim.run_ticks !== 0 && !sim.has_levitation && sim.jump_count >= sim.max_jumps) noJump |= 1 << (m & 30);
					nodes++;
					const prefix = node.prefix.concat([m]);
					if (sim.has_silver_crown) { if (d + 1 <= C) return { found: { layer: d + 1, path: prefix, src: k }, tasks, nodes }; continue; }
					if (sim.is_dead && !ctx.canDie) continue;
					const lim = C - (d + 1);
					if (lim < 1) continue;
					const hv = ctx.h(sim, lim);
					if (hv > lim) continue;
					const hs = sim.stateHash();
					const had = seen.get(hs);
					if (had !== undefined && had <= d + 1) continue;
					seen.set(hs, d + 1);
					next.push({ prefix, slack: lim - hv });
				}
			}
			layer = next;
		}
		for (const node of layer) tasks.push({ src: k, prefix: node.prefix, slack: node.slack || 0 });
	}
	tasks.sort((a, b) => b.slack - a.slack);
	return { found: null, tasks, nodes };
}

async function main() {
	const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
	const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
	const Cm = require('../../src/common.js');
	const say = (o) => console.log(JSON.stringify(o));
	const t0 = Date.now();
	const L = T.loadLevelFile(file);
	const tiers = (args.tiers || 'kin,togo,rel,gate').split(',').filter(Boolean);
	const ctx = makeCtx(L, new Set(tiers));
	const maxIdle = 3000;
	const src = LP.sourcesOf(L, maxIdle);
	const out = { ev: 'result', level: path.basename(file), tiers, verdict: 'OPEN' };
	if (src.rests < 0) { Object.assign(out, { verdict: 'unsupported', why: src.why }); say(out); return; }
	const sources = src.sources;
	// the routes in hand (U = the least run ticks) and the bound's check along each
	let U = Infinity, best = null;
	for (const f of (args.route || '').split(',').filter(Boolean)) {
		const ev = Cm.evaluate(L, Cm.readEetas(f), false);
		if (!ev) { say({ ev: 'check', route: path.basename(f), ok: false, why: 'does not finish' }); continue; }
		if (ev.runTicks < U) { U = ev.runTicks; best = path.basename(f); }
		if (args.check !== '0') {
			const ck = WP.checkRoute(L, ev.ms, { h: (s) => ctx.h(s, 1e9) });
			say(Object.assign({ ev: 'check', route: path.basename(f), runTicks: ev.runTicks }, ck));
			if (!ck.ok) { Object.assign(out, { verdict: 'violation', why: 'the bound is above the ticks left on a real route: no claim' }); say(out); return; }
		}
	}
	if (+args.U > 0 && +args.U < U) { U = +args.U; best = 'given U'; }
	let h0 = Infinity;
	{ const sim = new E.EESim(L); for (const s of sources) { sim.restore(s); const v = ctx.h(sim, 1e9); if (v < h0) h0 = v; } }
	// (every finish is at a layer >= h0: no finish at a layer <= h0 - 1)
	let lb = Math.max(0, h0 - 1);
	if (+args.from > lb) lb = +args.from;   // (a lower bound proven before: the contours above it)
	Object.assign(out, { U: Number.isFinite(U) ? U : null, best, h0, rests: src.rests, starts: sources.length });
	if (args.probe === '1') { Object.assign(out, { verdict: 'probe', lb, gap: Number.isFinite(U) ? U - lb : null, seconds: (Date.now() - t0) / 1000 }); say(out); return; }
	const threads = Math.max(1, +args.threads || 8), ttBits = +args.ttBits || 23, split = args.split !== undefined ? +args.split : 3;
	const deadline = t0 + (+args.seconds || 1800) * 1000;
	const wk = [];
	await Promise.all(Array.from({ length: threads }, () => new Promise((res) => {
		const w = new Worker(__filename, { workerData: { wholepar: true, file, tiers, ttBits, maxIdle } });
		wk.push(w);
		w.once('message', () => res());
	})));
	say({ ev: 'up', threads, h0, lb, U: out.U, ms: Date.now() - t0 });
	const Cs = [];
	let found = null;
	const top = Number.isFinite(U) ? U : Infinity;
	for (let C = lb + 1; C <= top && Date.now() < deadline; C++) {
		const tc = Date.now();
		const tk = tasksFor(L, ctx, sources, C, split);
		if (tk.found) { found = tk.found; Cs.push({ C, status: 'found', nodes: tk.nodes }); break; }
		const tasks = tk.tasks;
		let nodes = tk.nodes, done = 0, stopped = 0, hit = null;
		await new Promise((resolve) => {
			let next = 0, live = 0, fin = false;
			const finish = () => { if (fin) return; fin = true; for (const w of wk) w.removeAllListeners('message'); resolve(); };
			const give = (w) => {
				if (hit !== null || Date.now() > deadline || next >= tasks.length) { if (live === 0) finish(); return; }
				const t = tasks[next++];
				live++;
				w.postMessage({ type: 'task', id: next - 1, src: t.src, prefix: t.prefix, deadline });
			};
			for (const w of wk) {
				w.on('message', (m) => {
					if (m.type === 'ready') { give(w); give(w); return; }
					if (m.type === 'done') {
						live--; done++; nodes += m.nodes;
						if (m.stopped) stopped++;
						if (m.found && (hit === null || m.found.layer < hit.layer)) hit = m.found;
						give(w);
					}
				});
				w.postMessage({ type: 'C', C });
			}
			if (tasks.length === 0) finish();
		});
		const rec = { C, tasks: tasks.length, done, stopped, nodes, s: (Date.now() - tc) / 1000 };
		if (hit !== null) { found = hit; rec.status = 'found'; Cs.push(rec); say(Object.assign({ ev: 'C' }, rec)); break; }
		if (done < tasks.length || stopped > 0) { rec.status = 'time'; Cs.push(rec); say(Object.assign({ ev: 'C' }, rec)); break; }
		rec.status = 'closed'; lb = C;
		Cs.push(rec); say(Object.assign({ ev: 'C', lb }, rec));
	}
	for (const w of wk) { try { w.postMessage({ type: 'quit' }); } catch (e) { /* gone */ } }
	if (found !== null) {
		const masks = new Uint8Array(found.src + found.path.length);
		masks.set(found.path, found.src);
		const ev = Cm.evaluate(L, masks, false);
		const opt = found.layer - 1;
		out.opt = opt;
		if (ev) {
			out.optReplay = ev.runTicks;
			if (ev.runTicks < U) {
				out.verdict = 'FASTER';
				if (args.out) { Cm.writeEetas(path.resolve(args.out), ev.ms); out.written = args.out; }
			} else out.verdict = 'PROVEN';
		} else out.verdict = 'replay-failed';
		lb = opt;
	} else if (Number.isFinite(U) && lb >= U) out.verdict = 'PROVEN';
	out.lb = lb;
	out.gap = Number.isFinite(U) ? U - lb : null;
	out.Cs = Cs;
	out.seconds = (Date.now() - t0) / 1000;
	say(out);
}

if (isMainThread && require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { makeCtx, tasksFor };
