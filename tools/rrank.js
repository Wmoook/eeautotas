'use strict';
// tools/rrank.js: ROUTE-RANK's data, model and offline evidence (src/rrank.js; editor.js EEAT_RRANK). Reads the GPU filler's
// dataset (src/out/fill/res/box*/results.jsonl + runs/*.tgz) and the portfolio's sweep sw1 (src/out/pf/sweep/sw1), both
// git-ignored and read only; the levels from src/out/god/levels (campaign / hard / d4). Writes NUMBERS and room
// descriptions only (never a level or a TAS): the dataset src/out/rrank/data.json, the model src/rrank.json.
//   node tools/rrank.js --build [--root=<checkout with src/out>] [--only=<regex>] [--routes=3] [--stalled=8]
//        the dataset: per level with a routed run, its routes' rooms in route order (each route replayed in the engine,
//        goexplore.js roomOf per tick), the rooms its stalled runs registered (result.json find.roomsSeen: [key, desc, s,
//        gain]) and the room each stalled run's nearest attempt ends in (closest.eetas replayed): the ROUTE rooms, the SIDE
//        rooms (a stalled run found them, no route passes them) and the FALSE-NEAR rooms (a stalled run's nearest attempt
//        ends there, no route passes them)
//   node tools/rrank.js --train [--l2=0.01] [--step=]    the pairwise logistic model on every level -> src/rrank.json
//   node tools/rrank.js --cv                              leave-level-out CV vs the baselines + the offline counterfactual
//   node tools/rrank.js --build --train --cv              all three (as the filler grows: retrain)
// PAIRS (per level, each level weight 1, a third to each kind present): (a) a later room of a route over an earlier one
// of the same route; (b) a route room past the start over a SIDE room; (c) a route room past the start over a FALSE-NEAR
// room. BASELINES: cw-progress-starts' hand rule (coins first, then the read switches on + crowns), the paretoOf sum
// (useful gold + blue + keys held), and (the counterfactual only) the distance: the stalled run's own nearest attempt.
// THE COUNTERFACTUAL: per stalled run of a level another run routed, the room S.closest picks by the rank (the best rank
// class among the rooms the run registered; within it the nearest attempt's room when it is there, else the best score)
// vs by the distance (the nearest attempt's room): is it a ROUTE room of the level, and how far along the route (the
// route's first entry into it / the route's ticks).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SRC = path.join(__dirname, '..', 'src');
const RR = require(path.join(SRC, 'rrank.js'));

const opt = {};
for (const s of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(s); if (m) opt[m[1]] = m[2] === undefined ? '1' : m[2]; }
const ROOT = path.resolve(opt.root || path.join(__dirname, '..'));
const P = {
	res: path.resolve(ROOT, opt.res || 'src/out/fill/res'), sw: path.resolve(ROOT, opt.sw || 'src/out/pf/sweep/sw1'),
	levels: path.resolve(ROOT, opt.levels || 'src/out/god/levels'), data: path.resolve(opt.data || path.join(__dirname, '..', 'src/out/rrank/data.json')),
	model: path.resolve(opt.model || path.join(SRC, 'rrank.json')), routes: +(opt.routes || 3), stalled: +(opt.stalled || 8),
};

// ---------------------------------------------------------------- the run archives (a gzip'd tar read in memory)
function tarEntries(buf, want) {
	const tar = zlib.gunzipSync(buf), out = new Map();
	let o = 0, longName = null;
	while (o + 512 <= tar.length) {
		const hd = tar.subarray(o, o + 512);
		if (hd[0] === 0) break;
		const str = (a, b) => { const s = hd.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('latin1'); };
		let name = str(0, 100);
		const prefix = str(345, 500), size = parseInt(str(124, 136).trim() || '0', 8), type = String.fromCharCode(hd[156] || 48);
		if (prefix && hd[257] === 0x75) name = prefix + '/' + name;
		const body = tar.subarray(o + 512, o + 512 + size);
		o += 512 + Math.ceil(size / 512) * 512;
		if (type === 'L') { longName = body.toString('latin1').replace(/\0.*$/s, ''); continue; }
		if (longName !== null) { name = longName; longName = null; }
		if (type !== '0' && type !== '\0') continue;
		const base = name.split('/').pop();
		if (want(base)) out.set(base, Buffer.from(body));
	}
	return out;
}
const isRoute1 = (b) => /^route_1_\d+\.eetas$/.test(b);
/** a run's first route, nearest attempt and result.json roomsSeen ({route, closest, rooms: [[key, desc, s, gain]]}) */
function runFiles(r) {
	const base = r.file.replace(/\.eelvl$/i, '');
	const rooms = (buf) => { try { const R = JSON.parse(buf.toString('utf8')); return (R && R.find && R.find.roomsSeen) || null; } catch (e) { return null; } };
	if (r._src === 'sw1') {
		const d = path.join(P.sw, 'runs', `${base}__${r.config}`);
		let names = [];
		try { names = fs.readdirSync(d); } catch (e) { return null; }
		const rf = names.find(isRoute1);
		return { route: rf ? fs.readFileSync(path.join(d, rf)) : null, closest: names.includes('closest.eetas') ? fs.readFileSync(path.join(d, 'closest.eetas')) : null,
			rooms: names.includes('result.json') ? rooms(fs.readFileSync(path.join(d, 'result.json'))) : null };
	}
	const t = path.join(P.res, r._src, 'runs', `${base}__${r.config}__s${r.seed || 1}.tgz`);
	if (!fs.existsSync(t)) return null;
	let m;
	try { m = tarEntries(fs.readFileSync(t), (b) => isRoute1(b) || b === 'closest.eetas' || b === 'result.json'); } catch (e) { return null; }
	let route = null;
	for (const [k, v] of m) if (isRoute1(k)) route = v;
	return { route, closest: m.get('closest.eetas') || null, rooms: m.has('result.json') ? rooms(m.get('result.json')) : null };
}
function readRows() {
	const rd = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
	const rows = [];
	let boxes = [];
	try { boxes = fs.readdirSync(P.res).filter((b) => /^box\d+$/.test(b)).sort(); } catch (e) { /* none */ }
	for (const b of boxes) for (const r of rd(path.join(P.res, b, 'results.jsonl'))) { r._src = b; rows.push(r); }
	for (const r of rd(path.join(P.sw, 'results.jsonl'))) { r._src = 'sw1'; rows.push(r); }
	return rows;
}
/** the levels by md5: {md5, file, R (routed rows, fastest first), S (stalled rows: not preempted, stopped by the stall
 *  rule or the cap, nearest first)}; only levels with a routed row */
function tasksOf(rows, only) {
	const by = new Map();
	for (const r of rows) {
		if (!r.md5 || !r.file || (only && !only.test(r.file))) continue;
		let t = by.get(r.md5);
		if (!t) by.set(r.md5, t = { md5: r.md5, file: r.file, R: [], S: [] });
		if (r.routed) t.R.push(r);
		else if (!r.preempted && !r.light && (r.stop === 'stall' || r.stop === 'cap' || r._src === 'sw1')) t.S.push(r);
	}
	for (const t of by.values()) {
		t.S.sort((x, y) => (x.nearest == null ? 1e9 : x.nearest) - (y.nearest == null ? 1e9 : y.nearest));
		t.R.sort((x, y) => (x.firstRouteS == null ? 1e9 : x.firstRouteS) - (y.firstRouteS == null ? 1e9 : y.firstRouteS));
	}
	return [...by.values()].filter((t) => t.R.length > 0).sort((x, y) => (x.file < y.file ? -1 : 1));
}

// ---------------------------------------------------------------- the replays
function levelOf(file) {
	const E = require(path.join(SRC, 'eesim.js')), EL = require(path.join(SRC, 'eelvl.js'));
	for (const s of ['campaign', 'hard', 'd4']) {
		const g = path.join(P.levels, s, file);
		if (fs.existsSync(g)) return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(g)), { id: 'rrank', file }));
	}
	return null;
}
/** masks replayed: the rooms in order of first entry [[desc, tick]], the ticks played, finished, the last room's desc */
function roomsAlong(L, RM, masks) {
	const E = require(path.join(SRC, 'eesim.js'));
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let done = false;
	sim.onEvent = (k) => { if (k === 'complete') done = true; };
	const out = [], seen = new Set();
	let key = RM.key(sim), last = RR.normDesc(RM.desc(sim));
	seen.add(last); out.push([last, 0]);
	let t = 0;
	for (; t < masks.length && !done; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		const k = RM.key(sim);
		if (k !== key) { key = k; last = RR.normDesc(RM.desc(sim)); if (!seen.has(last)) { seen.add(last); out.push([last, t + 1]); } }
	}
	return { rooms: out, ticks: t, done, last };
}
const parseMasks = (buf) => { const a = new Uint8Array(buf.length); let n = 0; for (const b of buf) if (b >= 48 && b <= 79) a[n++] = (b - 48) & 31; return a.subarray(0, n); };
const infoJson = (I) => ({ gMax: I.gMax, bMax: I.bMax, gN: I.gN, bN: I.bN, keys: I.keys, keyN: I.keyN, swN: I.swN, teams: [...I.teams], crown: I.crown, lm: I.lm, lmN: I.lmN });
const infoOf = (j) => Object.assign({}, j, { teams: new Set(j.teams) });

function build() {
	const GX = require(path.join(SRC, 'goexplore.js'));
	const rows = readRows();
	const tasks = tasksOf(rows, opt.only ? new RegExp(opt.only) : null);
	const out = { tool: 'tools/rrank.js', date: new Date().toISOString(), rows: rows.length, levels: [] };
	const t0 = Date.now();
	for (const tk of tasks) {
		let L;
		try { L = levelOf(tk.file); } catch (e) { L = null; }
		if (!L) continue;
		const RM = GX.roomOf(L);
		const I = RR.levelInfo(L, { lmMs: 5000 });
		const lv = { file: tk.file, md5: tk.md5, info: infoJson(I), routes: [], stalled: [], gain: {} };
		const addGain = (rooms) => { if (rooms) for (const q of rooms) { const d = RR.normDesc(q[1]); if ((+q[3] || 0) > (lv.gain[d] || 0)) lv.gain[d] = +q[3]; } };
		for (const r of tk.R) {
			if (lv.routes.length >= P.routes) break;
			const f = runFiles(r);
			if (!f || !f.route) continue;
			addGain(f.rooms);
			const a = roomsAlong(L, RM, parseMasks(f.route));
			if (!a.done) continue;   // (a route that does not finish in this engine: not a route of this level file)
			lv.routes.push({ src: r._src, config: r.config, seed: r.seed || 1, ticks: a.ticks, rooms: a.rooms.map(([d, t]) => [d, Math.round(t / Math.max(1, a.ticks) * 1000) / 1000]) });
		}
		if (!lv.routes.length) continue;
		for (const r of tk.S) {
			if (lv.stalled.length >= P.stalled) break;
			const f = runFiles(r);
			if (!f || !f.rooms) continue;
			addGain(f.rooms);
			let fn = null;
			if (f.closest) { try { fn = roomsAlong(L, RM, parseMasks(f.closest)).last; } catch (e) { fn = null; } }
			lv.stalled.push({ src: r._src, config: r.config, seed: r.seed || 1, nearest: r.nearest, rooms: f.rooms.map((q) => [RR.normDesc(q[1]), +q[2] || 0, +q[3] || 0]), fn });
		}
		out.levels.push(lv);
		process.stderr.write(`\r${out.levels.length} levels (${((Date.now() - t0) / 1000).toFixed(0)} s) ${tk.file.slice(0, 40).padEnd(40)}`);
	}
	process.stderr.write('\n');
	out.ms = Date.now() - t0;
	fs.mkdirSync(path.dirname(P.data), { recursive: true });
	fs.writeFileSync(P.data, JSON.stringify(out));
	console.log(`build: ${out.rows} rows, ${out.levels.length} levels with a route (${out.levels.reduce((x, l) => x + l.routes.length, 0)} routes, ${out.levels.reduce((x, l) => x + l.stalled.length, 0)} stalled runs), ${(out.ms / 1000).toFixed(1)} s -> ${P.data}`);
	return out;
}

// ---------------------------------------------------------------- the labels
/** a level's rooms and pairs: {feat: Map(desc -> features), route: Map(desc -> mean position), pairs: [[a, b, kind, w]]} */
function pairsOf(lv) {
	const I = infoOf(lv.info);
	const feat = new Map();
	const fx = (d) => { let v = feat.get(d); if (!v) { v = RR.featuresOf(I, d, opt.gain === '1' ? lv.gain[d] || 0 : 0); feat.set(d, v); } return v; };
	const pos = new Map();
	for (const r of lv.routes) for (const [d, f] of r.rooms) { const p = pos.get(d) || []; p.push(f); pos.set(d, p); }
	const route = new Map([...pos].map(([d, a]) => [d, a.reduce((x, y) => x + y, 0) / a.length]));
	const side = new Set(), fn = new Set();
	for (const s of lv.stalled) { for (const [d] of s.rooms) if (!route.has(d)) side.add(d); if (s.fn !== null && !route.has(s.fn)) fn.add(s.fn); }
	const A = [], B = [], Cc = [];
	for (const r of lv.routes) { const rs = r.rooms.map((x) => x[0]); for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) A.push([rs[j], rs[i]]); }
	const past = new Set();
	for (const r of lv.routes) r.rooms.slice(1).forEach(([d]) => past.add(d));
	for (const r of past) { for (const s of side) B.push([r, s]); for (const f of fn) Cc.push([r, f]); }
	// (d) the pick itself, per stalled run: the rooms it registered that lie on a route, the furthest along first (its
	// frontier: every one at 3/4 of its furthest position or more) over every room it registered off the routes, and its
	// route rooms by their position
	const Dd = [];
	for (const s of lv.stalled) {
		const on = [], off = new Set();
		for (const [d] of s.rooms) { if (route.has(d)) on.push(d); else off.add(d); }
		if (s.fn !== null && !route.has(s.fn)) off.add(s.fn);
		const uniq = [...new Set(on)];
		if (!uniq.length) continue;
		const mx = Math.max(...uniq.map((d) => route.get(d)));
		for (const r of uniq) if (route.get(r) >= 0.75 * mx && route.get(r) > 0) for (const n of off) Dd.push([r, n]);
		for (const x of uniq) for (const y of uniq) if (route.get(x) > route.get(y) + 1e-9) Dd.push([x, y]);
	}
	const want = new Set((opt.kinds || 'd').split(','));
	const kinds = [['a', A], ['b', B], ['c', Cc], ['d', Dd]].filter(([k, X]) => X.length && want.has(k));
	const pairs = [];
	for (const [k, X] of kinds) for (const [a, b] of X) pairs.push([a, b, k, 1 / (kinds.length * X.length)]);
	for (const [a, b] of pairs) { fx(a); fx(b); }
	for (const s of lv.stalled) { for (const [d] of s.rooms) fx(d); if (s.fn !== null) fx(s.fn); }
	return { feat, route, pairs, side, fn, I };
}

// ---------------------------------------------------------------- the model
const NF = RR.FEATS.length;
/** a level's pairs as feature differences, the same difference summed ({D: Float64Array (n x NF), W: weights}; pairs of
 *  the same features left out: no gradient, and a tie for every ranker) */
function diffsOf(lp) {
	if (lp.diffs) return lp.diffs;
	const m = new Map();
	for (const [a, b, , w] of lp.pairs) {
		const fa = lp.feat.get(a), fb = lp.feat.get(b), d = new Array(NF);
		let z = true;
		for (let k = 0; k < NF; k++) { d[k] = Math.round((fa[k] - fb[k]) * 1e6) / 1e6; if (d[k] !== 0) z = false; }
		if (z) continue;
		const key = d.join(',');
		const e = m.get(key);
		if (e) e.w += w; else m.set(key, { d, w });
	}
	const D = new Float64Array(m.size * NF), W = new Float64Array(m.size);
	let i = 0;
	for (const e of m.values()) { for (let k = 0; k < NF; k++) D[i * NF + k] = e.d[k]; W[i++] = e.w; }
	return (lp.diffs = { D, W, n: m.size });
}
/** pairwise logistic regression with an L2 penalty (Newton's method: 12 features) over the pairs of the given levels
 *  (each level weight 1); w0: a warm start */
function train(levels, l2, w0, iters = 25) {
	const w = Float64Array.from(w0 || new Array(NF).fill(0));
	const L = levels.map(diffsOf);
	const tot = L.reduce((x, d) => x + d.W.reduce((a, b) => a + b, 0), 0) || 1;
	for (let it = 0; it < iters; it++) {
		const g = new Float64Array(NF), H = new Float64Array(NF * NF);
		for (const { D, W, n } of L) for (let i = 0; i < n; i++) {
			let s = 0;
			for (let k = 0; k < NF; k++) s += w[k] * D[i * NF + k];
			const p = 1 / (1 + Math.exp(-s));   // (the chance the pair is ranked right)
			const c = W[i] * (1 - p), h = W[i] * p * (1 - p);
			for (let k = 0; k < NF; k++) {
				const dk = D[i * NF + k];
				if (dk === 0) continue;
				g[k] -= c * dk;
				for (let j = 0; j < NF; j++) H[k * NF + j] += h * dk * D[i * NF + j];
			}
		}
		for (let k = 0; k < NF; k++) { g[k] = g[k] / tot + l2 * w[k]; for (let j = 0; j < NF; j++) H[k * NF + j] /= tot; H[k * NF + k] += l2; }
		const step = solve(H, g);
		let mx = 0;
		for (let k = 0; k < NF; k++) { w[k] -= step[k]; mx = Math.max(mx, Math.abs(step[k])); }
		if (mx < 1e-7) break;
	}
	return Array.from(w);
}
/** H x = g (Gaussian elimination with partial pivoting; H symmetric positive definite with the L2 term) */
function solve(H, g) {
	const n = NF, A = Array.from({ length: n }, (_, i) => [...Array.from(H.subarray(i * n, i * n + n)), g[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
		[A[c], A[p]] = [A[p], A[c]];
		const v = A[c][c] || 1e-12;
		for (let r = c + 1; r < n; r++) { const f = A[r][c] / v; if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
	}
	const x = new Array(n).fill(0);
	for (let r = n - 1; r >= 0; r--) { let s = A[r][n]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / (A[r][r] || 1e-12); }
	return x;
}
/** cw-progress-starts' hand rule: the coins first, then the read switches on + the crowns (lexicographic) */
const handKey = (d) => { const c = /(?:^|\s)coins(?:>=|=)(\d+)/.exec(d); let sw = 0; for (const m of d.matchAll(/(?:purple|orange)=\[([^\]]*)\]/g)) sw += m[1].split(',').filter(Boolean).length; return (c ? +c[1] : 0) * 1e4 + sw + (/(?:^|\s)(crown|silvercrown)(?:\s|$)/.test(d) ? 1 : 0); };
const paretoSum = (I, d) => { const f = RR.featuresOf(I, d, 0); return f[0] * I.gMax + f[1] * I.bMax + f[2] * I.keyN; };
/** the rankers of one level: name -> (desc) -> score */
function rankersOf(lp, w) {
	return {
		model: (d) => { const f = lp.feat.get(d) || RR.featuresOf(lp.I, d, 0); let s = 0; for (let k = 0; k < NF; k++) s += w[k] * f[k]; return s; },
		hand: handKey,
		pareto: (d) => paretoSum(lp.I, d),
		// (the hybrid: the hand rule's coins first, then the model's score without the coin features)
		hybrid: (d) => { const f = lp.feat.get(d) || RR.featuresOf(lp.I, d, 0); let s = 0; for (let k = 4; k < NF; k++) s += w[k] * f[k]; const c = /(?:^|\s)coins(?:>=|=)(\d+)/.exec(d); return (c ? +c[1] : 0) * 1e3 + Math.max(-99, Math.min(99, s)); },
	};
}
/** a ranker's pairwise accuracy on a level's pairs: {a, b, c, all} (ties count half; null: no pair of that kind) */
function accOf(lp, f) {
	const acc = { a: [0, 0], b: [0, 0], c: [0, 0], d: [0, 0] };
	for (const [a, b, k, w] of lp.pairs) { const x = f(a), y = f(b); acc[k][0] += w * (x > y ? 1 : x === y ? 0.5 : 0); acc[k][1] += w; }
	const r = {};
	let n = 0, s = 0;
	for (const k of ['a', 'b', 'c', 'd']) { r[k] = acc[k][1] > 0 ? acc[k][0] / acc[k][1] : null; if (r[k] !== null) { s += r[k]; n++; } }
	r.all = n ? s / n : null;
	return r;
}
/** the counterfactual pick of one stalled run by ranker f with class step (null: the continuous score): the rooms it
 *  registered, the best class; within it its nearest attempt's room when there, else the best score */
function pickOf(run, f, step) {
	let best = null, bs = -Infinity;
	const cls = (s) => (step ? Math.floor(s / step + 1e-9) : s);
	const cands = run.rooms.map((x) => x[0]);
	if (run.fn !== null) cands.push(run.fn);
	let top = -Infinity;
	for (const d of cands) top = Math.max(top, cls(f(d)));
	if (run.fn !== null && cls(f(run.fn)) === top) return run.fn;
	for (const d of cands) { const s = f(d); if (cls(s) === top && s > bs) { bs = s; best = d; } }
	return best;
}

function loadData() {
	const j = JSON.parse(fs.readFileSync(P.data, 'utf8'));
	return j.levels.map((lv) => Object.assign(pairsOf(lv), { lv }));
}
const r3 = (x) => (x === null || x === undefined ? '-' : x.toFixed(3));

function trainAll(lps) {
	const l2 = +(opt.l2 || 0.01);
	const w = train(lps, l2);
	return w;
}
function writeModel(w, step, extra) {
	const M = Object.assign({ tool: 'tools/rrank.js', date: new Date().toISOString(), feats: RR.FEATS, w: w.map((x) => Math.round(x * 1e4) / 1e4), step }, extra);
	fs.writeFileSync(P.model, JSON.stringify(M, null, 1) + '\n');
	console.log(`model -> ${P.model}: ${RR.FEATS.map((f, k) => `${f} ${M.w[k]}`).join(', ')}; class step ${step}`);
}

function cv(lps) {
	const l2 = +(opt.l2 || 0.01);
	const wAll = train(lps, l2);
	const steps = (opt.steps || '0.25,0.5,1,2').split(',').map(Number);
	const res = [];
	for (let i = 0; i < lps.length; i++) {
		const lp = lps[i];
		if (!lp.pairs.length && !lp.lv.stalled.length) continue;
		const w = train(lps.filter((_, j) => j !== i), l2, wAll, 12);
		const R = rankersOf(lp, w);
		const acc = { model: accOf(lp, R.model), hand: accOf(lp, R.hand), pareto: accOf(lp, R.pareto), hybrid: accOf(lp, R.hybrid) };
		// (the counterfactual: every stalled run of the level)
		const cf = [];
		for (const run of lp.lv.stalled) {
			const row = { run: `${run.config}/s${run.seed}`, dist: run.fn, distRoute: run.fn !== null && lp.route.has(run.fn), distPos: run.fn !== null && lp.route.has(run.fn) ? lp.route.get(run.fn) : null, picks: {} };
			for (const st of steps) { const p = pickOf(run, R.model, st); row.picks[`model@${st}`] = { d: p, route: p !== null && lp.route.has(p), pos: p !== null && lp.route.has(p) ? lp.route.get(p) : null }; }
			for (const nm of ['hand', 'pareto', 'hybrid']) { const p = pickOf(run, R[nm], null); row.picks[nm] = { d: p, route: p !== null && lp.route.has(p), pos: p !== null && lp.route.has(p) ? lp.route.get(p) : null }; }
			cf.push(row);
		}
		res.push({ file: lp.lv.file, pairs: lp.pairs.length, acc, cf, w });
	}
	// the pairwise accuracy, level-weighted
	const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
	console.log(`weights (all levels): ${RR.FEATS.map((f, k) => `${f} ${wAll[k].toFixed(2)}`).join(', ')}`);
	console.log(`CV (leave one level out, ${res.length} levels, l2 ${l2}, kinds ${opt.kinds || 'd'}): pairwise accuracy, level-weighted (ties 0.5)`);
	for (const k of ['a', 'b', 'c', 'd', 'all']) console.log(`  ${k === 'a' ? 'later route room > earlier' : k === 'b' ? 'route room > side room    ' : k === 'c' ? 'route room > false near   ' : k === 'd' ? 'run: frontier > off-route' : 'all kinds                 '}: model ${r3(mean(res.map((r) => r.acc.model[k])))}  hand ${r3(mean(res.map((r) => r.acc.hand[k])))}  pareto ${r3(mean(res.map((r) => r.acc.pareto[k])))}  hybrid ${r3(mean(res.map((r) => r.acc.hybrid[k])))}  (${res.filter((r) => r.acc.model[k] !== null).length} levels)`);
	const better = res.filter((r) => r.acc.model.all !== null && r.acc.model.all > r.acc.hand.all + 1e-9).length, worse = res.filter((r) => r.acc.model.all !== null && r.acc.model.all < r.acc.hand.all - 1e-9).length;
	console.log(`  per level (all kinds): model > hand on ${better}, < on ${worse}`);
	// the counterfactual
	const runs = res.flatMap((r) => r.cf.map((c) => Object.assign({ file: r.file }, c)));
	const tally = (key) => { const x = runs.filter((c) => c.picks[key]); return { n: x.length, route: x.filter((c) => c.picks[key].route).length, pos: mean(x.filter((c) => c.picks[key].route).map((c) => c.picks[key].pos)) }; };
	const dT = { n: runs.length, route: runs.filter((c) => c.distRoute).length, pos: mean(runs.filter((c) => c.distRoute).map((c) => c.distPos)) };
	console.log(`COUNTERFACTUAL (${runs.length} stalled runs of ${res.filter((r) => r.cf.length).length} levels another run routed; held-out model): the room S.closest picks is a ROUTE room of the level / its mean position along the route`);
	console.log(`  distance (the run's own nearest attempt): ${dT.route} of ${dT.n} (${r3(dT.pos)})`);
	for (const k of [...steps.map((s) => `model@${s}`), 'hand', 'pareto', 'hybrid']) { const t = tally(k); console.log(`  ${k.padEnd(12)}: ${t.route} of ${t.n} (${r3(t.pos)})`); }
	// (the pick farther along the route than the distance's: route room vs not, or a later position)
	const stepK = `model@${opt.step || 0.5}`;
	const cmp = (c, k) => { const a = c.picks[k], dr = c.distRoute; if (a.route && !dr) return 1; if (!a.route && dr) return -1; if (a.route && dr) return a.pos > c.distPos + 1e-9 ? 1 : a.pos < c.distPos - 1e-9 ? -1 : 0; return 0; };
	for (const k of [stepK, 'hand', 'hybrid']) { let g = 0, l = 0; for (const c of runs) { const v = cmp(c, k); if (v > 0) g++; else if (v < 0) l++; } console.log(`  ${k} vs distance: further along a route ${g}, behind ${l}, same ${runs.length - g - l}`); }
	// per level
	console.log(`per level (${stepK} vs distance: runs whose pick is a route room, mean position):`);
	const per = res.filter((r) => r.cf.length).map((r) => {
		const cs = r.cf;
		const m = cs.filter((c) => c.picks[stepK].route), d = cs.filter((c) => c.distRoute);
		let g = 0, l = 0;
		for (const c of cs) { const v = cmp(c, stepK); if (v > 0) g++; else if (v < 0) l++; }
		return { file: r.file, n: cs.length, mR: m.length, mP: mean(m.map((c) => c.picks[stepK].pos)), dR: d.length, dP: mean(d.map((c) => c.distPos)), g, l, acc: r.acc };
	}).sort((x, y) => (y.g - y.l) - (x.g - x.l) || (x.file < y.file ? -1 : 1));
	for (const p of per) console.log(`  ${p.file.replace(/\.eelvl$/, '').slice(0, 42).padEnd(42)} runs ${String(p.n).padStart(2)}  rank: route ${p.mR} pos ${r3(p.mP)} | dist: route ${p.dR} pos ${r3(p.dP)} | further ${p.g} behind ${p.l} | acc model ${r3(p.acc.model.all)} hand ${r3(p.acc.hand.all)}`);
	if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ res, per }, null, 1));
	return { res, per, wAll };
}

async function main() {
	if (opt.build) build();
	let lps = null;
	if (opt.train || opt.cv) lps = loadData();
	let C = null;
	if (opt.cv) C = cv(lps);
	if (opt.train) {
		const w = trainAll(lps);
		const step = +(opt.step || 0.5);
		writeModel(w, step, { levels: lps.length, pairs: lps.reduce((x, l) => x + l.pairs.length, 0), l2: +(opt.l2 || 0.01), kinds: opt.kinds || 'd', gain: opt.gain === '1' });
	}
	if (!opt.build && !opt.train && !opt.cv) console.log('node tools/rrank.js --build | --train | --cv [--root=] [--only=] (see the header)');
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { pairsOf, train, accOf, pickOf, roomsAlong, tarEntries };
