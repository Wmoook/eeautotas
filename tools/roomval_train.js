'use strict';
// THE ROOM VALUE'S TRAINER (src/roomval.js; goexplore.js --gpu=1 --gpuVal=1). Learns the weights of the count-aware
// progress value from the runs the machines made: the GPU filler's archives (src/out/fill/res/*/runs/*.tgz: every
// (level, config, seed) run, routed or not; run `sh src/out/fill/fetch.sh` first for the newest) and any folders of
// routes (--dirs: <dir>/<run>/**/route_*.eetas, e.g. the innovation panel's ok/ and r/).
//   node tools/roomval_train.js [--out=src/roomval_w.json] [--fill=src/out/fill/res] [--dirs=<dir>,...]
//        [--levels=src/out/god/levels/campaign,src/out/god/levels/hard] [--cache=tools/.cache/roomval] [--it=600]
//        [--l2=0.001] [--beta=1] [--folds=3] [--fit=rank | togo] [--dry=1]
// RETRAIN (as the filler grows): sh src/out/fill/fetch.sh && node tools/roomval_train.js   (then commit src/roomval_w.json)
//
// Samples: every trajectory is replayed in the JS engine from the level's start; every 20 ticks a sample [t, RCH3 (the
// reach cost with every door open, capped at 1700), the room features (src/roomval.js FEATS)]. A route's samples stop
// at the finish; a failed run's nearest attempt (closest.eetas) gives its END state: the PIN (its false near).
// Pairs (pairwise logistic loss on the linear value v = w . [RCH3 / 100, features]):
//   (a) along a route: a sample >= 300 ticks later must score lower (the route got nearer);
//   (b) DISCRIMINATIVE, on levels some run routed: a route sample holding at least the pin's useful counts (coins, blue,
//       keys; more of one) must score below a failed run's pin. Without these the value would learn only that counts
//       grow over time.
// Each route's (a) pairs weigh 1 in all, each pin's (b) pairs --beta. The weights are projected after every step onto
// w_rc >= 0.05 and the count weights <= 0 (more of a useful count never scores worse: src/roomval.js readWeights).
// Validation: --folds folds by level (a hash of the level's name): held-out route concordance (the share of (a) pairs
// ordered right) and pin-vs-route accuracy (of (b) pairs) for RCH3 alone and the learned value. Then trained on all.
// The output holds numbers only (weights, counts, the validation), no level content. Level and TAS files never go into git.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'common.js')), E = C.E, EL = require(path.join(ROOT, 'src', 'eelvl.js')), RC = require(path.join(ROOT, 'src', 'reach.js'));
const RV = require(path.join(ROOT, 'src', 'roomval.js'));

const opt = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }
const OUT = path.resolve(opt.out || path.join(ROOT, 'src', 'roomval_w.json'));
const FILL = path.resolve(opt.fill || path.join(ROOT, 'src', 'out', 'fill', 'res'));
const DIRS = String(opt.dirs != null ? opt.dirs : path.join(ROOT, 'src', 'out', 'il', 'r1', 'panel', 'ok') + ',' + path.join(ROOT, 'src', 'out', 'il', 'r1', 'panel', 'r')).split(',').filter(Boolean);
const LEVEL_DIRS = String(opt.levels || [path.join(ROOT, 'src', 'out', 'god', 'levels', 'campaign'), path.join(ROOT, 'src', 'out', 'god', 'levels', 'hard')].join(',')).split(',').filter(Boolean);
const CACHE = path.resolve(opt.cache || path.join(ROOT, 'tools', '.cache', 'roomval'));
const IT = +(opt.it || 600), L2 = +(opt.l2 || 1e-3), BETA = +(opt.beta != null ? opt.beta : 1), FOLDS = +(opt.folds || 3);
const EVERY = 20, RC_CAP = 1700, GAP = 15;   // (samples: every 20 ticks; along a route a pair is >= 15 samples = 300 ticks apart)
fs.mkdirSync(CACHE, { recursive: true });
const log = (s) => process.stderr.write(s + '\n');

/** a .tgz's regular files whose names `want` accepts, written under dst (a small ustar reader: no tar program needed) */
function untgz(file, dst, want) {
	const b = zlib.gunzipSync(fs.readFileSync(file));
	const str = (o, n) => { let e = o; while (e < o + n && b[e] !== 0) e++; return b.toString('utf8', o, e); };
	let longName = null;
	for (let o = 0; o + 512 <= b.length;) {
		if (b[o] === 0) break;
		let name = str(o, 100);
		const pre = str(o + 345, 155), size = parseInt(str(o + 124, 12).trim() || '0', 8), type = String.fromCharCode(b[o + 156] || 48);
		if (pre) name = pre + '/' + name;
		if (longName !== null) { name = longName; longName = null; }
		const d = o + 512;
		if (type === 'L') longName = str(d, size);
		else if (type === '0' && want(name) && !name.split('/').includes('..')) {
			const out = path.join(dst, ...name.split('/').filter(Boolean));
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, b.subarray(d, d + size));
		}
		o = d + Math.ceil(size / 512) * 512;
	}
}

// ---- the trajectories: {run, lvl, kind: 'route' | 'pin', file}
const walk = (d, out) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return out; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
const trajs = [], seen = new Set();
const addRun = (run, files) => {
	if (seen.has(run)) return;
	seen.add(run);
	const lvl = run.replace(/__.*$/, '');
	const routes = files.filter((f) => /^route_.*\.eetas$/.test(path.basename(f)));
	// (a run's first route: its later ones are the optimizer's refinements of the same way)
	if (routes.length) { routes.sort(); trajs.push({ run, lvl, kind: 'route', file: routes[0] }); return; }
	const cl = files.find((f) => path.basename(f) === 'closest.eetas');
	if (cl) trajs.push({ run, lvl, kind: 'pin', file: cl });
};
// the filler's archives, unpacked once into the cache
for (const box of (() => { try { return fs.readdirSync(FILL); } catch (e) { return []; } })()) {
	const rd = path.join(FILL, box, 'runs');
	let tgz; try { tgz = fs.readdirSync(rd).filter((f) => f.endsWith('.tgz')); } catch (e) { continue; }
	for (const t of tgz) {
		const run = t.replace(/\.tgz$/, '');
		const dst = path.join(CACHE, 'runs', run);
		if (!fs.existsSync(path.join(dst, '.ok'))) {
			fs.mkdirSync(dst, { recursive: true });
			try { untgz(path.join(rd, t), dst, (n) => /(^|\/)(route_[^/]*\.eetas|closest\.eetas)$/.test(n)); } catch (e) { log(`cannot unpack ${t}: ${e.message}`); continue; }
			fs.writeFileSync(path.join(dst, '.ok'), '');
		}
		addRun(run, walk(dst, []));
	}
}
for (const d of DIRS) { let es; try { es = fs.readdirSync(d); } catch (e) { continue; } for (const run of es) addRun(run, walk(path.join(d, run), [])); }
const levelFile = (lvl) => { for (const d of LEVEL_DIRS) { const f = path.join(d, lvl + '.eelvl'); if (fs.existsSync(f)) return f; } return null; };

// ---- the samples (cached per trajectory file: its size and mtime)
const cacheF = path.join(CACHE, 'samples.json');
let SC = {}; try { SC = JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch (e) { /* first run */ }
const levels = new Map();
const levelOf = (lvl) => {
	if (levels.has(lvl)) return levels.get(lvl);
	const f = levelFile(lvl);
	let v = null;
	if (f) {
		const L = E.prepareLevel(Object.assign(EL.toSimLevel(EL.readEelvl(fs.readFileSync(f))), { start_mode: 'reset' }));
		v = { L, I: RV.levelInfo(L), F: null };
	}
	levels.set(lvl, v);
	return v;
};
let replayed = 0;
const t0 = Date.now();
for (const T of trajs) {
	const st = fs.statSync(T.file), sig = `${st.size}:${Math.round(st.mtimeMs)}:${T.kind}`;
	const ck = T.run + '|' + T.kind;
	if (SC[ck] && SC[ck].sig === sig) { T.S = SC[ck].S; T.pin = SC[ck].pin; continue; }
	const V = levelOf(T.lvl);
	if (!V) { T.S = null; continue; }
	if (!V.F) V.F = RC.reachField(V.L, {});
	const masks = C.readEetas(T.file);
	const sim = new E.EESim(V.L); sim.reset();
	const inp = new E.EEInput();
	let done = -1; sim.onEvent = (k) => { if (k === 'complete' && done < 0) done = sim.ticks(); };
	const S = [];
	const sample = (t) => { const c = RC.costAt(V.F, sim); if (c < 0) return null; return [t, Math.min(c, RC_CAP), ...RV.featsOfSim(V.I, sim)]; };
	for (let t = 0; t < masks.length && done < 0; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (t % EVERY === 0 && T.kind === 'route') { const s = sample(t); if (s) S.push(s); }
	}
	T.S = T.kind === 'route' ? S : [];
	T.pin = T.kind === 'pin' ? sample(masks.length) : null;
	SC[ck] = { sig, S: T.S, pin: T.pin };
	replayed++;
	if (replayed % 20 === 0) log(`replayed ${replayed} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
fs.writeFileSync(cacheF, JSON.stringify(SC));
const R = trajs.filter((T) => T.kind === 'route' && T.S && T.S.length > GAP), P = trajs.filter((T) => T.kind === 'pin' && T.pin);
log(`trajectories: ${R.length} routes, ${P.length} pins (${replayed} replayed now), ${new Set(R.map((T) => T.lvl)).size} routed levels`);

// ---- pairs: d = x_better - x_worse (v(better) < v(worse) wanted: z = w . d < 0)
const NF = RV.FEATS.length;
const xOf = (s) => [s[1] / 100, ...s.slice(2)];
// (the useful counts of a sample: coins as the fraction of the highest threshold, blue likewise, the keys)
const cnt = (s) => [s[2], s[5], s[8]];
function pairsOf(routes, pins) {
	const A = [], B = [];
	for (const T of routes) {
		const S = T.S, X = S.map(xOf), pp = [];
		for (let i = 0; i < S.length; i += 3) for (let j = i + GAP; j < S.length; j += 7) pp.push([j, i]);
		for (const [b, w] of pp) A.push({ d: X[b].map((x, k) => x - X[w][k]), wt: 1 / pp.length, lvl: T.lvl });
	}
	const byLvl = new Map();
	for (const T of routes) { if (!byLvl.has(T.lvl)) byLvl.set(T.lvl, []); byLvl.get(T.lvl).push(T); }
	for (const Pn of pins) {
		const rs = byLvl.get(Pn.lvl);
		if (!rs) continue;
		const pc = cnt(Pn.pin), xp = xOf(Pn.pin), pp = [];
		for (const T of rs) for (let i = 0; i < T.S.length; i += 2) {
			const c = cnt(T.S[i]);
			let ge = true, gt = false;
			for (let k = 0; k < c.length; k++) { if (c[k] < pc[k] - 1e-9) ge = false; if (c[k] > pc[k] + 1e-9) gt = true; }
			if (ge && gt) pp.push(xOf(T.S[i]));
		}
		for (const x of pp) B.push({ d: x.map((v, k) => v - xp[k]), wt: BETA / pp.length, lvl: Pn.lvl });
	}
	return { A, B };
}
const project = (w) => { if (w[0] < 0.05) w[0] = 0.05; for (let k = 1; k < NF; k++) if (w[k] > 0) w[k] = 0; };
function train(pairs) {
	const all = pairs.A.concat(pairs.B);
	const w = new Float64Array(NF); w[0] = 1;
	// Adam on the mean loss
	const m = new Float64Array(NF), v = new Float64Array(NF), b1 = 0.9, b2 = 0.999, lr = 0.05;
	let W = 0; for (const p of all) W += p.wt;
	if (!W) return w;
	for (let it = 1; it <= IT; it++) {
		const g = new Float64Array(NF);
		for (const p of all) {
			let z = 0; for (let f = 0; f < NF; f++) z += w[f] * p.d[f];
			const q = 1 / (1 + Math.exp(-z));
			for (let f = 0; f < NF; f++) g[f] += p.wt * q * p.d[f];
		}
		for (let f = 0; f < NF; f++) {
			const gf = g[f] / W + L2 * w[f];
			m[f] = b1 * m[f] + (1 - b1) * gf; v[f] = b2 * v[f] + (1 - b2) * gf * gf;
			w[f] -= lr * (m[f] / (1 - b1 ** it)) / (Math.sqrt(v[f] / (1 - b2 ** it)) + 1e-8);
		}
		project(w);
	}
	return w;
}
// --fit=togo: the CALIBRATED value instead of the ranking: least squares of the time to go along each route, in tiles
// of that route's own pace (y = (T - t) / kappa, kappa = T / RCH3 at its start), on the same features (each route
// weighs 1, the same projection). The ranking's scale says only "counts first"; this one says how many tiles of the
// reach cost a count is worth on the way to the trophy (a search priority's scale).
function trainTogo(routes) {
	const X = [], Y = [], WT = [];
	for (const T of routes) {
		const S = T.S, Tend = S[S.length - 1][0] + EVERY, kappa = Tend / Math.max(1, S[0][1]);
		for (const s of S) { X.push(xOf(s)); Y.push((Tend - s[0]) / kappa / 100); WT.push(1 / S.length); }
	}
	const w = new Float64Array(NF); w[0] = 1;
	if (!X.length) return w;
	const m = new Float64Array(NF), v = new Float64Array(NF), b1 = 0.9, b2 = 0.999, lr = 0.02;
	let W = 0; for (const x of WT) W += x;
	for (let it = 1; it <= IT * 2; it++) {
		const g = new Float64Array(NF);
		for (let i = 0; i < X.length; i++) {
			let z = -Y[i]; for (let f = 0; f < NF; f++) z += w[f] * X[i][f];
			for (let f = 0; f < NF; f++) g[f] += WT[i] * z * X[i][f];
		}
		for (let f = 0; f < NF; f++) {
			const gf = g[f] / W + L2 * w[f];
			m[f] = b1 * m[f] + (1 - b1) * gf; v[f] = b2 * v[f] + (1 - b2) * gf * gf;
			w[f] -= lr * (m[f] / (1 - b1 ** it)) / (Math.sqrt(v[f] / (1 - b2 ** it)) + 1e-8);
		}
		project(w);
	}
	return w;
}
const FIT = opt.fit || 'rank';
const fitOf = (routes, pairs) => (FIT === 'togo' ? trainTogo(routes) : train(pairs));
// the share of pairs ordered right (ties: half), per level averaged
function acc(list, w) {
	const by = new Map();
	for (const p of list) {
		let z = 0; for (let f = 0; f < NF; f++) z += w[f] * p.d[f];
		const o = by.get(p.lvl) || { ok: 0, n: 0 };
		o.n += p.wt; o.ok += p.wt * (z < -1e-12 ? 1 : z > 1e-12 ? 0 : 0.5);
		by.set(p.lvl, o);
	}
	const a = [...by.values()].map((o) => o.ok / o.n);
	return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}
const W_RC = (() => { const w = new Float64Array(NF); w[0] = 1; return w; })();
const W_NAIVE = (() => { const w = new Float64Array(NF); w[0] = 1; w[3] = -4; w[6] = -4; w[7] = -4; return w; })();
const lvls = [...new Set(R.map((T) => T.lvl))].sort();
const fold = (l) => { let h = 0; for (const ch of l) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % FOLDS; };
const cv = [];
for (let k = 0; k < FOLDS; k++) {
	const tr = pairsOf(R.filter((T) => fold(T.lvl) !== k), P.filter((T) => fold(T.lvl) !== k));
	const te = pairsOf(R.filter((T) => fold(T.lvl) === k), P.filter((T) => fold(T.lvl) === k));
	const w = fitOf(R.filter((T) => fold(T.lvl) !== k), tr);
	const row = { fold: k, levels: lvls.filter((l) => fold(l) === k).length, pairsA: te.A.length, pairsB: te.B.length,
		routeRch: acc(te.A, W_RC), routeNaive: acc(te.A, W_NAIVE), routeLearned: acc(te.A, w),
		pinRch: acc(te.B, W_RC), pinNaive: acc(te.B, W_NAIVE), pinLearned: acc(te.B, w), w: Array.from(w) };
	cv.push(row);
	log(`fold ${k}: ${row.levels} levels, ${row.pairsA} route pairs, ${row.pairsB} pin pairs | route concordance RCH3 ${row.routeRch.toFixed(3)} naive ${row.routeNaive.toFixed(3)} learned ${row.routeLearned.toFixed(3)} | pin-vs-route RCH3 ${row.pinRch.toFixed(3)} naive ${row.pinNaive.toFixed(3)} learned ${row.pinLearned.toFixed(3)} | w ${Array.from(w).map((x) => x.toFixed(3)).join(' ')}`);
}
const mean = (k) => { const a = cv.map((r) => r[k]).filter(Number.isFinite); return a.length ? Math.round(1000 * a.reduce((x, y) => x + y, 0) / a.length) / 1000 : null; };
const all = pairsOf(R, P);
const w = fitOf(R, all);
const res = { version: RV.VERSION, feats: RV.FEATS, w: Array.from(w).map((x) => Math.round(x * 1e4) / 1e4),
	offsetPer: RV.FEATS.slice(1).map((f, k) => Math.round(100 * w[k + 1] / w[0] * 10) / 10),
	n: { routes: R.length, pins: P.length, routedLevels: lvls.length, pairsA: all.A.length, pairsB: all.B.length },
	cv: { folds: FOLDS, routeRch: mean('routeRch'), routeNaive: mean('routeNaive'), routeLearned: mean('routeLearned'), pinRch: mean('pinRch'), pinNaive: mean('pinNaive'), pinLearned: mean('pinLearned') },
	train: { fit: FIT, it: IT, l2: L2, beta: BETA, every: EVERY, gap: GAP, rcCap: RC_CAP }, trained: new Date().toISOString().slice(0, 10) };
log(`all: w ${res.w.join(' ')}; tiles per unit of each feature: ${RV.FEATS.slice(1).map((f, k) => `${f} ${res.offsetPer[k]}`).join(', ')}`);
log(`cv means: route RCH3 ${res.cv.routeRch} naive ${res.cv.routeNaive} learned ${res.cv.routeLearned} | pin RCH3 ${res.cv.pinRch} naive ${res.cv.pinNaive} learned ${res.cv.pinLearned}`);
if (opt.dry !== '1') { fs.writeFileSync(OUT, JSON.stringify(res, null, 1) + '\n'); log(`wrote ${OUT}`); }
