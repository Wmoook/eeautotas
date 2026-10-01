'use strict';
// tools/oneshot/edgecov.js - ONE SHOT part 2: how many of the known routes' moves are EDGES of the level's move graph
// (src/plan/oneshot/edges.js). A tool only: no compiler file depends on it.
//
// The routes: src/plan/truthset.js knownRoutes (EEAT_TRUTH_ROOT / --root: a checkout with src/jobs and src/out/god; READ
// ONLY), each replayed and segmented into MOVES exactly as the moves study (src/out/n4plan/understand/moves/moves.js):
// a boundary at a teleport, a respawn, and every tick whose support class (G W C Z B D) differs from the tick before.
// Per move (t0 -> t1, tile0 / class c0 -> tile1 / class c1, len ticks), against the graph built from the level alone:
//   src     a support of the graph at tile0 (with class c0 where c0 is a support class)
//   pair    an edge from such a support ends at (tile1, c1) (a death move: a death edge; a teleport: tile1)
//   pairT   ... in <= len ticks (the edge's own ticks, from its representative)
//   replay  ... and its input string replayed from the ROUTE'S OWN state at t0 reaches (tile1, c1): the lazy verification
//   replayT ... within len ticks
// Respawn moves (from D) are counted apart (the death edge carries the dead ticks).
// Usage: node tools/oneshot/edgecov.js [--root=<truth root>] [--only=<name substr>] [--limit=N] [--threads=16]
//   [--cache=<dir>] [--out=<file.jsonl>] [--maxTiles=N] [--skip=N] [edges.js options: --rounds= --landT= ...]
// One JSON line per level to --out and stdout; a summary at the end.
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const ED = require('../../src/plan/oneshot/edges.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const root = path.resolve(argv.root || process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..'));
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);
const TELEPORT_PX = 20;

function levelPathOf(entry) {
	if (entry.jobId) {
		const jd = path.dirname(entry.route);
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(jd, 'meta.json'), 'utf8'));
			const lj = path.join(jd, '..', '..', 'data', `${meta.levelId}.json`);
			if (meta.levelId && fs.existsSync(lj)) return lj;
		} catch (e) { /* the level file */ }
	}
	return entry.levelFile;
}

/** the route's moves (the moves study's segmentation) with the snapshot at each move's start */
function segment(L, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const W = L.width, H = L.height, flags = sim._flags;
	const n = masks.length;
	const cls = new Array(n + 1), tile = new Int32Array(n + 1), tp = new Uint8Array(n + 1), jmp = new Uint8Array(n + 1);
	const snaps = new Map();
	let jumped = false;
	sim.onEvent = (ev) => { if (ev === 'jump') jumped = true; };
	const snapAt = [];
	cls[0] = ED.clsOf(sim, flags); tile[0] = T.tileOf(sim, W, H);
	snapAt[0] = sim.snapshot();
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		jumped = false;
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		cls[t + 1] = ED.clsOf(sim, flags);
		tile[t + 1] = T.tileOf(sim, W, H);
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		jmp[t + 1] = jumped ? 1 : 0;
		const a = cls[t], b = cls[t + 1];
		if (tp[t + 1] || (a === 'D' && b !== 'D') || (b !== a && SUPPORT.has(b))) snapAt[t + 1] = sim.snapshot();
	}
	sim.onEvent = null;
	const bnd = [0];
	for (let t = 1; t <= n; t++) {
		const a = cls[t - 1], b = cls[t];
		let isB = false;
		if (tp[t]) isB = true;
		else if (a === 'D' && b !== 'D') isB = true;
		else if (b !== a && SUPPORT.has(b)) isB = true;
		if (isB && t !== bnd[bnd.length - 1]) bnd.push(t);
	}
	if (bnd[bnd.length - 1] !== n) bnd.push(n);
	const moves = [];
	for (let i = 0; i + 1 < bnd.length; i++) {
		const t0 = bnd[i], t1 = bnd[i + 1];
		let jumps = 0, field = 0;
		for (let t = t0 + 1; t <= t1; t++) { if (jmp[t] && !(t === t1 && cls[t] === 'G')) jumps++; if ('WCZB'.includes(cls[t])) field++; }
		const c0 = cls[t0], c1 = cls[t1];
		const hopStart = c0 === 'G' && jmp[t0] === 1;
		const label = c0 === 'D' ? 'respawn' : c1 === 'D' ? 'death' : tp[t1] ? 'portal' : ('WCZB'.includes(c0) || field > 0) ? 'field' : jumps > 0 ? 'jump' : hopStart ? 'hop' : c0 === 'A' ? 'fall' : 'walk';
		moves.push({ t0, t1, len: t1 - t0, c0, c1, tile0: tile[t0], tile1: tile[t1], tele: tp[t1], label, snap: snapAt[t0] });
	}
	return { moves, sim };
}

/** the first tick (1-based) the masks played from snap reach (tile, cls) (a death move: dead; a teleport: the tile), 0 never */
function replayHit(sim, inp, snap, masks, mv, W, H) {
	sim.restore(snap);
	const flags = sim._flags;
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (mv.c1 === 'D') { if (sim.is_dead) return t + 1; continue; }
		if (sim.is_dead) return 0;
		if (T.tileOf(sim, W, H) === mv.tile1 && (mv.tele || mv.c1 === 'A' || ED.clsOf(sim, flags) === mv.c1)) return t + 1;
	}
	return 0;
}

async function main() {
	const all = TS.knownRoutes({ root });
	const groups = new Map();
	for (const e of all) {
		if (argv.only && !e.name.toLowerCase().includes(String(argv.only).toLowerCase())) continue;
		const lp = levelPathOf(e);
		if (!groups.has(lp)) groups.set(lp, []);
		groups.get(lp).push(e);
	}
	let list = Array.from(groups.entries());
	// small levels first (a partial run covers the most levels)
	const sizeOf = (lp) => { try { const L = T.loadLevelFile(lp); return L.width * L.height; } catch (e) { return 1e9; } };
	const sized = list.map(([lp, es]) => [lp, es, sizeOf(lp)]).filter((q) => !argv.maxTiles || q[2] <= +argv.maxTiles);
	sized.sort((a, b) => a[2] - b[2]);
	list = sized.slice(+argv.skip || 0, argv.limit ? (+argv.skip || 0) + +argv.limit : undefined);
	if (argv.shard) { const [si, sn] = String(argv.shard).split('/').map(Number); list = list.filter((q, k) => k % sn === si); }
	const o = { threads: +(argv.threads || 8) };
	for (const k of Object.keys(ED.DEF)) if (argv[k] !== undefined) o[k] = +argv[k];
	if (argv.touch === '0') o.touch = false;
	if (argv.cache) o.cache = argv.cache;
	const outF = argv.out ? path.resolve(argv.out) : null;
	const tot = { levels: 0, routes: 0, moves: 0, src: 0, pair: 0, pairT: 0, replay: 0, replayT: 0, lazyT: 0, respawn: 0, buildMs: 0, edges: 0, sups: 0 };
	const byLab = {};
	for (const [lp, entries, tiles] of list) {
		const t0 = Date.now();
		let g = null, lazy = null;
		// --lazy=1: the edges of the supports the moves start at only (edges.js edgeSource, this thread): the pair
		// coverage without the whole-level build
		try { if (argv.lazy === '1') lazy = ED.edgeSource(lp, o); else g = await ED.buildGraph(lp, o); } catch (e) { console.error('build failed', lp, e && e.message); continue; }
		const buildMs = Date.now() - t0;
		const L = T.loadLevelFile(lp);
		const W = L.width, H = L.height;
		// the index: supports by tile, edges by source support
		const supsAll = lazy ? lazy.sups : g.sups;
		const supAt = new Map();
		for (const u of supsAll) { if (!supAt.has(u.tile)) supAt.set(u.tile, []); supAt.get(u.tile).push(u); }
		const out = new Map();
		if (g) for (let n = 0; n < g.edges.length; n++) { const e = g.edges[n]; if (!out.has(e.f)) out.set(e.f, []); out.get(e.f).push(e); }
		const edgesOfSup = (u) => (lazy ? lazy.edgesOf(u.i) : out.get(u.i) || []);
		const masksOfEdge = (e) => e._ms || (e._ms = ED.masksOf(e.m));
		const lv = g
			? { level: path.basename(lp), W, H, tiles, sups: g.sups.length, edges: g.edges.length, buildMs: g.stats.ms, wallMs: buildMs, threads: g.stats.threads, maxRssMB: g.stats.maxRssMB, cached: !!g.stats.cached, byKind: g.stats.byKind, routes: 0, moves: 0, src: 0, pair: 0, pairT: 0, replay: 0, replayT: 0, respawn: 0, lab: {} }
			: { level: path.basename(lp), W, H, tiles, sups: lazy.sups.length, lazy: 1, routes: 0, moves: 0, src: 0, pair: 0, pairT: 0, replay: 0, replayT: 0, respawn: 0, lab: {} };
		for (const entry of entries) {
			let tr = null;
			try { tr = TS.loadTruth(entry); } catch (e) { tr = null; }
			if (!tr) continue;
			lv.routes++;
			const { moves, sim } = segment(tr.L, tr.masks);
			let S1_ = null;
			const S1 = () => S1_ || (S1_ = require('../../src/plan/msolve.js').createSolver(tr.L, { K: 2 }));
			const inp = new E.EEInput();
			for (const mv of moves) {
				const lab = lv.lab[mv.label] || (lv.lab[mv.label] = { n: 0, src: 0, pair: 0, pairT: 0, replay: 0, replayT: 0 });
				if (mv.c0 === 'D') { lv.respawn++; continue; }
				lv.moves++; lab.n++;
				const srcs = (supAt.get(mv.tile0) || []).filter((u) => !SUPPORT.has(mv.c0) || mv.c0 === 'D' || u.cls === mv.c0 || u.kind === 'start');
				const miss = (why) => { if (argv.misses && (lv.missN = (lv.missN || 0) + 1) <= +argv.misses) console.log(`  MISS ${why} ${mv.label} t${mv.t0}+${mv.len} ${mv.c0}(${mv.tile0 % W},${(mv.tile0 / W) | 0}) -> ${mv.c1}(${mv.tile1 % W},${(mv.tile1 / W) | 0})${mv.tele ? ' tele' : ''} srcs ${srcs.map((u) => u.kind[0] + u.cls + u.vc).join(' ')}`); };
				if (!srcs.length) { miss('nosrc'); continue; }
				lv.src++; lab.src++;
				const cands = [];
				for (const u of srcs) for (const e of edgesOfSup(u)) {
					if (mv.c1 === 'D' ? e.cls === 'R' : (e.tile === mv.tile1 && (mv.tele || mv.c1 === 'A' || e.cls === mv.c1))) cands.push(e);
				}
				if (!cands.length) { miss('nopair'); continue; }
				lv.pair++; lab.pair++;
				cands.sort((a, b) => a.T - b.T);
				if (cands[0].T <= mv.len) { lv.pairT++; lab.pairT++; }
				let best = 0;
				for (const e of cands.slice(0, 64)) {
					const h = replayHit(sim, inp, mv.snap, masksOfEdge(e), mv, W, H);
					if (h && (!best || h < best)) best = h;
				}
				if (best) { lv.replay++; lab.replay++; if (best <= mv.len) { lv.replayT++; lab.replayT++; } }
				// --resolve=1: the lazy verification's fallback (edges.js resolveEdge: the move solver from the route's own
				// state to the edge's end, plain and field tiers) where the replay did not arrive in time
				if (argv.resolve === '1') {
					let ok = best && best <= mv.len;
					if (!ok) {
						let r = null;
						try { r = S1().leg(mv.snap, { tiles: [mv.tile1], cls: mv.tele || mv.c1 === 'A' ? 'any' : mv.c1 === 'D' ? 'D' : mv.c1 }, { Tmax: mv.len, chain: false, coupled: false, fieldMs: 100 }); } catch (e) { r = null; }
						ok = !!(r && r.ok && r.T <= mv.len);
					}
					if (ok) { lv.lazyT = (lv.lazyT || 0) + 1; lab.lazyT = (lab.lazyT || 0) + 1; }
				}
			}
		}
		if (lazy) { const s = lazy.stats(); lv.built = s.built; lv.edges = s.edges; lv.buildMs = s.ms; lv.msPerSup = s.built ? +(s.ms / s.built).toFixed(1) : 0; lv.maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024); }
		const line = JSON.stringify(lv);
		console.log(line);
		if (outF) fs.appendFileSync(outF, line + '\n');
		tot.levels++; tot.routes += lv.routes; tot.moves += lv.moves; tot.src += lv.src; tot.pair += lv.pair; tot.pairT += lv.pairT; tot.replay += lv.replay; tot.replayT += lv.replayT; tot.lazyT += lv.lazyT || 0; tot.respawn += lv.respawn;
		tot.buildMs += lv.buildMs; tot.edges += lv.edges; tot.sups += lv.sups;
		for (const [k, v] of Object.entries(lv.lab)) { const b = byLab[k] || (byLab[k] = { n: 0, src: 0, pair: 0, pairT: 0, replay: 0, replayT: 0, lazyT: 0 }); for (const q of Object.keys(b)) b[q] += v[q] || 0; }
	}
	const pc = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
	console.log(`SUMMARY levels ${tot.levels} routes ${tot.routes} moves ${tot.moves} (+${tot.respawn} respawns): src ${pc(tot.src, tot.moves)} pair ${pc(tot.pair, tot.moves)} pairT ${pc(tot.pairT, tot.moves)} replay ${pc(tot.replay, tot.moves)} replayT ${pc(tot.replayT, tot.moves)} lazyT ${pc(tot.lazyT, tot.moves)}; sups ${tot.sups} edges ${tot.edges} build ${(tot.buildMs / 1000).toFixed(1)} s`);
	for (const [k, b] of Object.entries(byLab).sort((a, c) => c[1].n - a[1].n)) console.log(`  ${k.padEnd(8)} ${String(b.n).padStart(6)}  src ${pc(b.src, b.n)} pair ${pc(b.pair, b.n)} pairT ${pc(b.pairT, b.n)} replay ${pc(b.replay, b.n)} replayT ${pc(b.replayT, b.n)} lazyT ${pc(b.lazyT, b.n)}`);
	if (outF) fs.appendFileSync(outF, JSON.stringify({ summary: tot, byLab }) + '\n');
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
