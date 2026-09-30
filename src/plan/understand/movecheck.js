'use strict';
// n4u-moves T-MOVES: the primitives' navigation graph against the REAL moves of the truthset routes. For every sampled
// move (the route's state at a support boundary -> its next support boundary: a landing, a field entry, a portal exit),
// prims.route() from the route's own exact state to the route's next support (the same centre tile + the same support
// class: ground / liquid / climbable / dots / boost; a portal move: that tile), within a small budget. COVERED = it
// reaches it in at most the route's own ticks (the route's move is then not needed: the graph has one as fast).
// Usage: node src/plan/understand/movecheck.js --plan=<dir with prims.js (the builder's src/plan)> [--shard=i/n]
//   [--every=5] [--ms=300] [--out=<dir>] [--only=<level substring>]   (EEAT_TRUTH_ROOT = the truth checkout)
// Output: <out>/mc_<i>.jsonl, one line per move {r, t0, len, label, c1, ok, ticks (the graph's, -1 none), why, expanded}.
// Then: node src/plan/understand/movecheck.js --agg=<out>
const fs = require('fs');
const path = require('path');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));

if (argv.agg) {
	const rows = [];
	for (const f of fs.readdirSync(argv.agg)) if (/^mc_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(argv.agg, f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	console.log(`T-MOVES: ${rows.length} moves`);
	console.log('class      n     covered (<= route ticks)   found later   not found (budget / exhausted)   strictly faster   median expanded');
	for (const lb of ['ALL', 'walk', 'jump', 'hop', 'hopjump', 'fall', 'airjump', 'arrow', 'boost', 'swim', 'climb', 'dot', 'portal', 'death']) {
		const ms = rows.filter((m) => lb === 'ALL' || m.label === lb);
		if (!ms.length) continue;
		const cov = ms.filter((m) => m.ticks >= 0 && m.ticks <= m.len).length, later = ms.filter((m) => m.ticks > m.len).length;
		const nf = ms.filter((m) => m.ticks < 0);
		const faster = ms.filter((m) => m.ticks >= 0 && m.ticks < m.len).length;
		const ex = ms.map((m) => m.expanded).sort((a, b) => a - b);
		console.log(`${lb.padEnd(8)} ${String(ms.length).padStart(5)}   ${String(pct(cov, ms.length)).padStart(6)}%                  ${String(pct(later, ms.length)).padStart(5)}%        ${pct(nf.length, ms.length)}% (${nf.filter((m) => m.why === 'budget').length} / ${nf.filter((m) => m.why !== 'budget').length})                  ${pct(faster, ms.length)}%          ${ex[ex.length >> 1]}`);
	}
	process.exit(0);
}

const E = require('../../eesim.js');
const TS = require('../truthset.js');
const T = require('../types.js');
const PLAN = path.resolve(argv.plan || path.join(__dirname, '..'));
const P = require(path.join(PLAN, 'prims.js'));
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const EVERY = +(argv.every || 5), MS = +(argv.ms || 300);
const OUT = argv.out || path.join('src', 'out', 'n4plan', 'understand', 'moves', 'mc');
fs.mkdirSync(OUT, { recursive: true });

const F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128, TELEPORT_PX = 20;
const ARROWS = new Set([1, 2, 3, 1518, 411, 412, 413, 1519]), DOTS = new Set([4, 414]);
function clsOf(s, flags) {
	if (s.is_dead) return 'D';
	const id = s.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (DOTS.has(id)) return 'Z';
	if (f & F_BOOST) return 'B';
	if (s.on_ground) return 'G';
	return 'A';
}
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);

async function checkRoute(entry, fo) {
	const tr = TS.loadTruth(entry);
	if (!tr) return 0;
	const { L, masks } = tr;
	const n = masks.length, W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput(), flags = sim._flags;
	sim.reset();
	let evJump = false;
	sim.onEvent = (ev) => { if (ev === 'jump') evJump = true; };
	const snaps = new Array(n + 1), cls = new Array(n + 1), tp = new Uint8Array(n + 1), tile = new Int32Array(n + 1), jumpAt = new Uint8Array(n + 1), arrowT = new Uint8Array(n + 1);
	snaps[0] = sim.snapshot(); cls[0] = clsOf(sim, flags); tile[0] = T.tileOf(sim, W, H);
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		evJump = false;
		E.applyMask(inp, masks[t] & 31); sim.tick(inp);
		snaps[t + 1] = sim.snapshot(); cls[t + 1] = clsOf(sim, flags); tile[t + 1] = T.tileOf(sim, W, H); jumpAt[t + 1] = evJump ? 1 : 0;
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		arrowT[t + 1] = (ARROWS.has(sim.current_tile) || sim.flip_gravity !== 0) ? 1 : 0;
	}
	sim.onEvent = null;
	const bnd = [0];
	for (let t = 1; t <= n; t++) {
		const a = cls[t - 1], b = cls[t];
		if ((tp[t] || (a === 'D' && b !== 'D') || (b !== a && SUPPORT.has(b))) && t !== bnd[bnd.length - 1]) bnd.push(t);
	}
	const prims = await P.createPrims(L, {});
	let k = 0;
	const K = +(argv.chain || 1);   // --chain=K: the goal is the support K moves ahead (the moves chained: hops count)
	for (let i = 0; i + K < bnd.length; i++) {
		const t0 = bnd[i], t1 = bnd[i + K], len = t1 - t0, c0 = cls[t0], c1 = cls[t1];
		if (c0 === 'D' || c1 === 'D' || len > 400 * K) continue;
		let anyD = false; for (let q = t0; q <= t1; q++) if (cls[q] === 'D') { anyD = true; break; }
		if (anyD) continue;
		if ((k++ % EVERY) !== 0) continue;
		// the label (as moves.js)
		let hop = c0 === 'G' && jumpAt[t0] === 1, jumps = 0, arrow = 0, other = '';
		for (let q = t0 + 1; q <= t1; q++) { if (jumpAt[q] && !(q === t1 && cls[q] === 'G')) jumps++; if (arrowT[q]) arrow++; if (tp[q]) other = other || 'portal'; if (cls[q] === 'B') other = other || 'boost'; }
		const label = other || (c0 === 'W' ? 'swim' : c0 === 'C' ? 'climb' : c0 === 'Z' ? 'dot' : c0 === 'B' ? 'boost' : arrow ? 'arrow' : jumps ? 'jump' : hop ? 'hop' : c0 === 'G' ? 'fall' : 'fall');
		const target = tile[t1], portal = tp[t1] === 1;
		const mask = new Uint8Array(W * H); mask[target] = 1;
		const goal = { kind: 'tiles', tiles: Int32Array.from([target]), mask, allowDeath: false,
			test: portal ? (s) => !s.is_dead && T.tileOf(s, W, H) === target : (s) => !s.is_dead && T.tileOf(s, W, H) === target && clsOf(s, flags) === c1 };
		sim.restore(snaps[t0]);
		const arrival = T.arrivalOf(L, sim, masks.subarray(0, t0), null);
		let r = null;
		try { r = prims.route([arrival], goal, { ms: MS, k: 1 }, {}); } catch (e) { r = { ok: false, why: 'error:' + String(e.message).slice(0, 80), expanded: 0 }; }
		const ticks = r && r.ok && r.best ? r.best.ticks - t0 : -1;
		fo.write(JSON.stringify({ r: entry._idx, name: entry.name, t0, len, label, c1, ticks, why: r ? r.why : 'none', expanded: r ? r.expanded : 0, proven: r && r.proven ? 1 : 0 }) + '\n');
	}
	if (prims.close) await prims.close();
	return k;
}

async function main() {
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	// one route per level (the first), so every level counts once
	const seen = new Set();
	let mine = all.filter((e) => { if (seen.has(e.name)) return false; seen.add(e.name); return true; }).filter((e, i) => i % NSH === SH);
	if (argv.only) mine = mine.filter((e) => e.name.includes(argv.only));
	const fo = { buf: [], write(s) { fs.appendFileSync(path.join(OUT, `mc_${SH}.jsonl`), s); } };
	fs.writeFileSync(path.join(OUT, `mc_${SH}.jsonl`), '');
	for (const e of mine) {
		const t = Date.now();
		let n = 0;
		try { n = await checkRoute(e, fo); } catch (err) { process.stdout.write(`${e._idx} ${e.name} ERR ${String(err && err.stack || err).slice(0, 300)}\n`); continue; }
		process.stdout.write(`${e._idx} ${e.name} moves=${n} ${Date.now() - t}ms\n`);
	}
}
main().then(() => process.exit(0));
