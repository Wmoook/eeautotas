'use strict';
// LEARNED MOVES: an input prior for the one search's CPU random runs (goexplore.js --prior=<model.json> --priorP=0.5;
// OFF by default). A small table model of P(next input | what the ball sees), learned from finished routes and TASes:
// counts per context with back-off smoothing, saved as JSON (no level content: only the counts per context).
//
// The context, in the GRAVITY FRAME (so a jump under up or side gravity is the same move as under down gravity) and
// MIRRORED by the facing (so "forward" is one direction whether the ball goes left or right):
//   g       the gravity from the last tick's acceleration (sim.mox / moy): down, up, left, right, or free (none: dots,
//           climbables, zero gravity; then the world's frame)
//   field   0 gravity, 1 free (no pull), 2 climbable, 3 liquid (the current tile's flags)
//   ground  sim.on_ground (the last tick hit the floor)
//   facing  the previous input's lateral direction in the frame, else the lateral speed's sign (|v| > 0.3), else +
//   ahead   the tile next to the centre tile the way it faces: 0 open with a floor under it, 1 a step (solid, the tile
//           above it free), 2 a wall (solid, the tile above it solid too), 3 a gap (free, no floor under it)
//   ceil    the tiles above the centre (against gravity): 2 the first solid, 1 the second, 0 neither
//   vd      the speed along gravity: < -4 (rising fast), < -1, <= 1, <= 6, above (falling fast)
//   vl      the lateral speed times the facing: < -1 (moving back), < 1, < 4, above
//   prev    the previous input in the frame (lateral none / forward, against / with gravity / none, jump): 12 values
//   hold    how many ticks the previous input has been held: 1, 2-3, 4-7, 8-15, 16-31, 32+
// The output: one of 18 inputs in the frame (lateral back / none / forward x against / none / with gravity x jump),
// mapped back to a world mask by the frame and the facing.
// Smoothing: p_k(y) = (n_k(y) + ALPHA x p_{k+1}(y)) / (n_k + ALPHA) along the back-off chain
//   full -> (field, ground, ahead, vd, prev, hold) -> (field, ground, prev, hold) -> (prev, hold) -> (prev) -> all
// and a floor of --priorEps / 18 per input when drawn (exploration: the model never rules an input out).
//
//   node src/prior.js build --out=<model.json> [--sources=god,w2,n3,jobs] [--exclude=<md5,...|file of md5s>]
//        [--perLevel=3] [--holdout=5] [--alpha=4]                      (learn; prints the held-out likelihood)
//   node src/prior.js eval <model.json> [--alpha=..]                   (the held-out table of a saved model)
//   node src/prior.js show <model.json>                                 (the most likely inputs in a few contexts)
const fs = require('fs');
const path = require('path');

// the context's dimensions (the index: the digits in this order, hold last)
const DIMS = [4, 2, 4, 3, 5, 4, 12, 6];   // field, ground, ahead, ceil, vd, vl, prev, hold
const NCTX = DIMS.reduce((x, y) => x * y, 1);
const NY = 18;
// the back-off chain: the dimensions each level keeps (by index into DIMS)
const CHAIN = [[0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 4, 6, 7], [0, 1, 6, 7], [6, 7], [6], []];
const VERSION = 1;
const F_CLIMB = 32, F_LIQUID = 64;
// the frame per g (0 down, 1 up, 2 left, 3 right, 4 free): gravity d = (DX, DY), lateral l = (LX, LY)
const DX = [0, 0, -1, 1, 0], DY = [1, -1, 0, 0, 1], LX = [1, 1, 0, 0, 1], LY = [0, 0, 1, 1, 0];

/** the gravity frame of the live state: 0 down, 1 up, 2 left, 3 right, 4 free */
function gravOf(sim) {
	const x = sim.mox, y = sim.moy;
	if (y !== 0 && Math.abs(y) >= Math.abs(x)) return y > 0 ? 0 : 1;
	if (x !== 0) return x > 0 ? 3 : 2;
	return 4;
}
/** a world mask's parts: h (-1 left, 1 right), v (-1 up, 1 down), j (L + R and U + D cancel, as in the engine) */
const hOf = (m) => ((m & 6) === 2 ? -1 : (m & 6) === 4 ? 1 : 0);
const vOf = (m) => ((m & 24) === 8 ? -1 : (m & 24) === 16 ? 1 : 0);
/** a world mask's lateral part in frame g (before the facing) */
const latOf = (m, g) => (g === 2 || g === 3 ? vOf(m) : hOf(m));
/** a world mask's gravity part in frame g: +1 with gravity (down under down gravity), -1 against */
const proOf = (m, g) => (g === 2 || g === 3 ? hOf(m) * DX[g] : vOf(m) * DY[g]);
/** a world mask -> the frame's output index 0..17 (facing f) */
function toFrame(m, g, f) {
	const lat = latOf(m, g) * f, pro = proOf(m, g);
	return (lat + 1) * 6 + (pro + 1) * 2 + (m & 1);
}
/** the frame's output index -> a world mask */
function fromFrame(y, g, f) {
	const lat = (((y / 6) | 0) - 1) * f, pro = ((((y % 6) / 2) | 0) - 1), j = y & 1;
	let h, v;
	if (g === 2 || g === 3) { v = lat; h = pro * DX[g]; } else { h = lat; v = pro * DY[g]; }
	return (h < 0 ? 2 : h > 0 ? 4 : 0) | (v < 0 ? 8 : v > 0 ? 16 : 0) | j;
}
/** a world mask as the engine reads it: L + R and U + D cancel (one of the 18 options) */
const canon = (m) => (hOf(m) < 0 ? 2 : hOf(m) > 0 ? 4 : 0) | (vOf(m) < 0 ? 8 : vOf(m) > 0 ? 16 : 0) | (m & 1);
const holdClass = (n) => (n <= 1 ? 0 : n <= 3 ? 1 : n <= 7 ? 2 : n <= 15 ? 3 : n <= 31 ? 4 : 5);

/**
 * the context of the live state for the next input: prev = the input of the last tick (world mask), hold = the ticks it
 * has been held (>= 1). Returns the context index; out[0] = g, out[1] = the facing (for fromFrame)
 */
function contextOf(sim, prev, hold, out) {
	const g = gravOf(sim);
	const fl = sim._flags[sim._current];
	const field = (fl & F_LIQUID) !== 0 ? 3 : (fl & F_CLIMB) !== 0 ? 2 : g === 4 ? 1 : 0;
	const dx = DX[g], dy = DY[g], lx = LX[g], ly = LY[g];
	const vx = sim.speed_x, vy = sim.speed_y;
	const vl0 = vx * lx + vy * ly;
	const pl = latOf(prev, g);
	const f = pl !== 0 ? pl : vl0 > 0.3 ? 1 : vl0 < -0.3 ? -1 : 1;
	const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4;
	const ax = cx + f * lx, ay = cy + f * ly;
	let ahead;
	if (sim.is_tile_solid_now(ax, ay)) ahead = sim.is_tile_solid_now(ax - dx, ay - dy) ? 2 : 1;
	else ahead = sim.is_tile_solid_now(ax + dx, ay + dy) ? 0 : 3;
	const ceil = sim.is_tile_solid_now(cx - dx, cy - dy) ? 2 : sim.is_tile_solid_now(cx - 2 * dx, cy - 2 * dy) ? 1 : 0;
	const vd = vx * dx + vy * dy;
	const vdc = vd < -4 ? 0 : vd < -1 ? 1 : vd <= 1 ? 2 : vd <= 6 ? 3 : 4;
	const vl = vl0 * f;
	const vlc = vl < -1 ? 0 : vl < 1 ? 1 : vl < 4 ? 2 : 3;
	const pc = (pl !== 0 ? 6 : 0) + (proOf(prev, g) + 1) * 2 + (prev & 1);
	if (out) { out[0] = g; out[1] = f; }
	return ((((((field * 2 + (sim.on_ground ? 1 : 0)) * 4 + ahead) * 3 + ceil) * 5 + vdc) * 4 + vlc) * 12 + pc) * 6 + holdClass(hold);
}
/** a context index -> its digits */
function digitsOf(ctx) {
	const d = new Array(DIMS.length);
	for (let k = DIMS.length - 1; k >= 0; k--) { d[k] = ctx % DIMS[k]; ctx = (ctx / DIMS[k]) | 0; }
	return d;
}
/** the key of a context's digits at back-off level lv */
const keyAt = (d, lv) => { let k = 0; for (const i of CHAIN[lv]) k = k * DIMS[i] + d[i]; return k; };

/** the counts of one sample (level, masks) into cnt (Map ctx -> Float64Array(18)); weight w; returns the ticks counted */
function countRun(E, level, masks, cnt, w = 1, cb = null) {
	const sim = new E.EESim(level);
	sim.reset();
	const inp = new E.EEInput();
	const fo = [0, 1];
	let first = 0;
	while (first < masks.length && (masks[first] & 31) === 0) first++;
	let prev = 0, hold = 1, n = 0;
	for (let t = 0; t < masks.length; t++) {
		const m = masks[t] & 31;
		if (t >= first && !sim.is_dead) {
			const c = contextOf(sim, prev, hold, fo);
			const y = toFrame(m, fo[0], fo[1]);
			if (cb) cb(c, y);
			if (cnt) {
				let a = cnt.get(c);
				if (a === undefined) cnt.set(c, a = new Float64Array(NY));
				a[y] += w;
			}
			n++;
		}
		const cm = canon(m);
		if (t >= first) { if (cm === prev) hold++; else hold = 1; prev = cm; }
		E.applyMask(inp, m);
		sim.tick(inp);
		if (sim.has_silver_crown) break;
	}
	return n;
}

/**
 * the model from counts (Map ctx -> counts, or the JSON's {ctx: [counts]}): the smoothed distributions of every
 * context, as cumulative Float32Array(NCTX x 18) (probs: the same, not cumulative, when want.probs)
 */
function makeModel(counts, alpha = 4, want = {}) {
	const L = CHAIN.length;
	const lvMaps = CHAIN.map(() => new Map());
	const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts).map(([k, v]) => [+k, v]);
	for (const [ctx, a] of entries) {
		const d = digitsOf(ctx);
		for (let lv = 1; lv < L; lv++) {
			const k = keyAt(d, lv);
			let s = lvMaps[lv].get(k);
			if (s === undefined) lvMaps[lv].set(k, s = new Float64Array(NY));
			for (let y = 0; y < NY; y++) s[y] += a[y];
		}
		lvMaps[0].set(ctx, a);
	}
	// the smoothed distributions per level, from the coarsest (memoised per key)
	const memo = CHAIN.map(() => new Map());
	const uni = new Float64Array(NY).fill(1 / NY);
	const distAt = (d, lv) => {
		if (lv >= L) return uni;
		const k = lv === 0 ? null : keyAt(d, lv);
		if (lv > 0) { const m = memo[lv].get(k); if (m !== undefined) return m; }
		const parent = distAt(d, lv + 1);
		const a = lv === 0 ? lvMaps[0].get(keyAt(d, 0)) : lvMaps[lv].get(k);
		let p;
		if (a === undefined) p = parent;
		else {
			let n = 0;
			for (let y = 0; y < NY; y++) n += a[y];
			p = new Float64Array(NY);
			for (let y = 0; y < NY; y++) p[y] = (a[y] + alpha * parent[y]) / (n + alpha);
		}
		if (lv > 0) memo[lv].set(k, p);
		return p;
	};
	const cdf = new Float32Array(NCTX * NY);
	const probs = want.probs ? new Float32Array(NCTX * NY) : null;
	for (let c = 0; c < NCTX; c++) {
		const p = distAt(digitsOf(c), 0);
		let s = 0;
		for (let y = 0; y < NY; y++) { s += p[y]; cdf[c * NY + y] = s; if (probs) probs[c * NY + y] = p[y]; }
		cdf[c * NY + NY - 1] = 1;
	}
	return { cdf, probs, alpha, seen: lvMaps[0].size };
}

/** a model file -> {counts, meta} */
function readModel(file) {
	const j = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (j.version !== VERSION || !j.counts || String(j.dims) !== String(DIMS)) throw new Error(`${file}: not a prior model of version ${VERSION} with dims ${DIMS}`);
	return j;
}

/**
 * the policy of a model file for the random runs: draw(sim, prev, hold, rnd) -> a world mask. eps: that share of each
 * draw uniform over the 18 inputs (the model rules nothing out). One rnd() per draw.
 */
function policyOf(file, opts = {}) {
	const j = typeof file === 'string' ? readModel(file) : file;
	const M = makeModel(j.counts, opts.alpha || j.alpha || 4);
	const eps = opts.eps === undefined ? 0.1 : opts.eps;
	const cdf = M.cdf, fo = [0, 1];
	const OPT = [];
	for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const jj of [0, 1]) OPT.push(h | v | jj);
	return {
		seen: M.seen,
		draw(sim, prev, hold, rnd) {
			const r = rnd();
			if (r < eps) return OPT[((r / eps) * 18) | 0];
			const u = (r - eps) / (1 - eps);
			const c = contextOf(sim, prev, hold, fo) * NY;
			let y = 0;
			while (y < NY - 1 && cdf[c + y] <= u) y++;
			return fromFrame(y, fo[0], fo[1]);
		},
		/** a switch (--priorMode=1: the sticky timing, the model's choice): an input other than prev, by the model's
		 *  distribution without prev (eps of the draws: one of the other 17). One rnd() per draw */
		drawSwitch(sim, prev, hold, rnd) {
			const r = rnd();
			const c = contextOf(sim, prev, hold, fo) * NY;
			const py = toFrame(canon(prev), fo[0], fo[1]);
			if (r < eps) { const k = ((r / eps) * (NY - 1)) | 0; return fromFrame(k < py ? k : k + 1, fo[0], fo[1]); }
			const pp = cdf[c + py] - (py > 0 ? cdf[c + py - 1] : 0);
			const u = ((r - eps) / (1 - eps)) * Math.max(1e-12, 1 - pp);
			let acc = 0, y = 0, last = py === 0 ? 1 : 0;
			for (; y < NY; y++) {
				if (y === py) continue;
				last = y;
				acc += cdf[c + y] - (y > 0 ? cdf[c + y - 1] : 0);
				if (acc > u) break;
			}
			return fromFrame(y < NY ? y : last, fo[0], fo[1]);
		},
	};
}

// ------------------------------------------------------------------------------------------------ the builder (CLI)
/** the training samples: [{level (prepared), masks, name, md5, src}] */
function samplesOf(opts) {
	const C = require('./common.js');
	const E = C.E;
	const EL = require('./eelvl.js');
	const home = opts.home || path.join(__dirname);
	const out = [];
	const excl = new Set(opts.exclude || []);
	const srcs = opts.sources || ['god', 'w2', 'n3', 'jobs'];
	// the manifests: md5 -> level file
	const lvByMd5 = new Map();
	for (const mf of [path.join(home, 'out/god/levels/campaign/manifest.json'), path.join(home, 'out/god/levels/hard/manifest.json')]) {
		let arr = [];
		try { arr = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { continue; }
		for (const e of arr) if (e.md5) lvByMd5.set(e.md5, path.join(path.dirname(mf), e.file));
	}
	const levelCache = new Map();
	const levelOfFile = (file) => {
		if (levelCache.has(file)) return levelCache.get(file);
		let L = null;
		try { L = E.prepareLevel(Object.assign(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))), { start_mode: 'reset' })); } catch (e) { L = null; }
		levelCache.set(file, L);
		return L;
	};
	const perLevel = new Map();
	const walk = (dir, fn) => {
		let ents = [];
		try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
		for (const e of ents) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) { if (e.name === 'runs') { for (const r of fs.readdirSync(p, { withFileTypes: true })) if (r.isDirectory()) fn(path.join(p, r.name)); } else walk(p, fn); }
		}
	};
	for (const s of srcs.filter((x) => x !== 'jobs')) {
		walk(path.join(home, 'out', s), (rd) => {
			const f = ['final.eetas', 'best.eetas'].map((x) => path.join(rd, x)).find((x) => fs.existsSync(x));
			if (!f) return;
			let md5 = null;
			try { md5 = JSON.parse(fs.readFileSync(path.join(rd, 'job_meta.json'), 'utf8')).level.md5; } catch (e) { return; }
			if (!md5 || excl.has(md5) || !lvByMd5.has(md5)) return;
			const k = perLevel.get(md5) || 0;
			if (k >= (opts.perLevel || 3)) return;
			const L = levelOfFile(lvByMd5.get(md5));
			if (!L) return;
			perLevel.set(md5, k + 1);
			out.push({ level: L, masks: C.readEetas(f), name: path.basename(rd), md5, src: s, file: f });
		});
	}
	if (srcs.includes('jobs')) {
		const jobsDir = path.join(home, 'jobs');
		let ids = [];
		try { ids = fs.readdirSync(jobsDir).filter((x) => fs.existsSync(path.join(jobsDir, x, 'meta.json'))); } catch (e) { ids = []; }
		for (const id of ids) {
			let meta = null;
			try { meta = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'meta.json'), 'utf8')); } catch (e) { continue; }
			const md5 = meta.level && meta.level.md5;
			if (md5 && excl.has(md5)) continue;
			const lj = path.join(home, 'data', `job_${id.replace(/-/g, '_')}.json`);
			let L = null;
			try { L = E.loadLevel(lj); } catch (e) { continue; }
			for (const fn of ['best.eetas', 'original.eetas']) {
				const f = path.join(jobsDir, id, fn);
				if (!fs.existsSync(f)) continue;
				out.push({ level: L, masks: C.readEetas(f), name: `${id}/${fn}`, md5: md5 || id, src: 'jobs', file: f });
			}
		}
	}
	return out;
}
/** a stable hash of a string (the held-out split by level) */
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** the held-out table: mean log2-likelihood per tick of the test samples under the model, the uniform and the sticky policy */
function evalSamples(E, test, probs, keep = 0.85) {
	let n = 0, lm = 0, lu = 0, ls = 0, top1 = 0;
	// (the switches: the ticks whose input differs from the last one; the model's choice among the other 17 vs one of 17)
	let nc = 0, lc = 0, top1c = 0;
	for (const s of test) {
		countRun(E, s.level, s.masks, null, 1, (c, y) => {
			n++;
			const p = Math.max(1e-9, probs[c * NY + y]);
			lm += Math.log2(p);
			lu += Math.log2(1 / NY);
			let best = 0;
			for (let k = 1; k < NY; k++) if (probs[c * NY + k] > probs[c * NY + best]) best = k;
			if (best === y) top1++;
			const prevY = (((c / 6) | 0) % 12) + 6;
			if (y !== prevY) {
				nc++;
				lc += Math.log2(p / Math.max(1e-9, 1 - probs[c * NY + prevY]));
				let b2 = -1;
				for (let k = 0; k < NY; k++) if (k !== prevY && (b2 < 0 || probs[c * NY + k] > probs[c * NY + b2])) b2 = k;
				if (b2 === y) top1c++;
			}
		});
	}
	// the sticky policy (goexplore's: the last input kept with p keep, else one of 18) scored on world masks
	for (const s of test) {
		let prev = -1, first = 0;
		const ms = s.masks;
		while (first < ms.length && (ms[first] & 31) === 0) first++;
		const sim = new E.EESim(s.level);
		sim.reset();
		const inp = new E.EEInput();
		for (let t = 0; t < ms.length; t++) {
			const m = ms[t] & 31;
			const cm = (hOf(m) < 0 ? 2 : hOf(m) > 0 ? 4 : 0) | (vOf(m) < 0 ? 8 : vOf(m) > 0 ? 16 : 0) | (m & 1);
			if (t >= first && !sim.is_dead) ls += Math.log2(prev === cm ? keep + (1 - keep) / NY : (1 - keep) / NY);
			if (t >= first) prev = cm;
			E.applyMask(inp, m);
			sim.tick(inp);
			if (sim.has_silver_crown) break;
		}
	}
	return { ticks: n, bitsModel: lm / Math.max(1, n), bitsUniform: lu / Math.max(1, n), bitsSticky: ls / Math.max(1, n), top1: top1 / Math.max(1, n),
		switches: nc, bitsSwitch: lc / Math.max(1, nc), bitsSwitchUniform: Math.log2(1 / (NY - 1)), top1Switch: top1c / Math.max(1, nc) };
}

function cli() {
	const argv = process.argv.slice(2);
	const cmd = argv.shift();
	const o = {};
	const pos = [];
	for (const s of argv) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) o[m[1]] = m[2]; else pos.push(s); }
	const C = require('./common.js');
	const E = C.E;
	if (cmd === 'build') {
		const exclude = o.exclude ? (fs.existsSync(o.exclude) ? fs.readFileSync(o.exclude, 'utf8').split(/[\s,]+/).filter(Boolean) : o.exclude.split(',')) : [];
		const t0 = Date.now();
		const S = samplesOf({ home: o.home || __dirname, sources: o.sources ? o.sources.split(',') : undefined, exclude, perLevel: o.perLevel ? +o.perLevel : 3 });
		const hold = o.holdout ? +o.holdout : 5;
		const isTest = (s) => hold > 0 && hashStr(s.md5) % hold === 0;
		const train = S.filter((s) => !isTest(s)), test = S.filter(isTest);
		const cnt = new Map();
		let ticks = 0;
		for (const s of train) ticks += countRun(E, s.level, s.masks, cnt);
		console.log(`[prior] ${S.length} samples (${new Set(S.map((s) => s.md5)).size} levels; ${train.length} train, ${test.length} held out), ${ticks} train ticks, ${cnt.size} contexts seen, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
		const alphas = o.alpha ? o.alpha.split(',').map(Number) : [4, 32, 128, 512];
		let bestA = alphas[0], bestB = -Infinity;
		for (const al of alphas) {
			const M = makeModel(cnt, al, { probs: true });
			const r = evalSamples(E, test, M.probs);
			console.log(`[prior] alpha ${al}: held-out ${r.ticks} ticks, bits/tick model ${r.bitsModel.toFixed(3)} vs sticky(0.85) ${r.bitsSticky.toFixed(3)} vs uniform ${r.bitsUniform.toFixed(3)}; top-1 ${(100 * r.top1).toFixed(1)}%; the ${r.switches} switches: bits model ${r.bitsSwitch.toFixed(3)} vs one of 17 ${r.bitsSwitchUniform.toFixed(3)}, top-1 ${(100 * r.top1Switch).toFixed(1)}% (1 of 17: 5.9%)`);
			if (r.bitsModel > bestB) { bestB = r.bitsModel; bestA = al; }
		}
		// the saved model: every sample (held-out ones too) at the best alpha
		const all = new Map();
		for (const s of test) countRun(E, s.level, s.masks, cnt);
		for (const [k, v] of cnt) all.set(k, v);
		const counts = {};
		for (const [k, v] of all) counts[k] = Array.from(v, (x) => Math.round(x * 100) / 100);
		const meta = { built: new Date().toISOString(), samples: S.length, levels: new Set(S.map((s) => s.md5)).size, sources: [...new Set(S.map((s) => s.src))], excluded: exclude.length, heldOutBits: bestB };
		if (o.out) {
			fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
			fs.writeFileSync(o.out, JSON.stringify({ version: VERSION, dims: DIMS, alpha: bestA, meta, counts }));
			console.log(`[prior] wrote ${o.out} (alpha ${bestA}, ${all.size} contexts, ${(fs.statSync(o.out).size / 1024).toFixed(0)} KB)`);
		}
		return;
	}
	if (cmd === 'show') {
		const j = readModel(pos[0]);
		const M = makeModel(j.counts, j.alpha, { probs: true });
		const NAMES = [];
		for (const lat of ['B', '', 'F']) for (const pro of ['A', '', 'W']) for (const jj of ['', 'J']) NAMES.push([lat, pro, jj].filter(Boolean).join('+') || '-');
		const show = (label, d) => {
			let c = 0;
			for (let k = 0; k < DIMS.length; k++) c = c * DIMS[k] + d[k];
			const p = [...M.probs.slice(c * NY, c * NY + NY)].map((x, y) => [NAMES[y], x]).sort((x, y) => y[1] - x[1]).slice(0, 5);
			console.log(`${label.padEnd(44)} ${p.map(([n, x]) => `${n} ${(100 * x).toFixed(1)}%`).join(', ')}`);
		};
		// field, ground, ahead, ceil, vd, vl, prev (F = 6 + 2 ...), hold
		show('ground, open, running fwd fast, held F 32+', [0, 1, 0, 0, 2, 3, 6 + 2, 5]);
		show('ground, wall step ahead, fwd, held F 8-15', [0, 1, 1, 0, 2, 2, 6 + 2, 3]);
		show('ground, tall wall ahead, fwd, held F 8-15', [0, 1, 2, 0, 2, 2, 6 + 2, 3]);
		show('ground, gap ahead, fwd fast, held F 16-31', [0, 1, 3, 0, 2, 3, 6 + 2, 4]);
		show('air rising, fwd, held F+J 4-7', [0, 0, 0, 0, 1, 2, 6 + 2 + 1, 2]);
		show('air falling, gap, fwd, held F 8-15', [0, 0, 3, 0, 3, 2, 6 + 2, 3]);
		show('ground, still, prev none, held 32+', [0, 1, 0, 0, 2, 1, 2, 5]);
		show('liquid, prev none, held 1', [3, 0, 0, 0, 2, 1, 2, 0]);
		show('free (dots), prev fwd, held 4-7', [1, 0, 0, 0, 2, 2, 6 + 2, 2]);
		return;
	}
	console.log('usage: node src/prior.js build --out=<model.json> [--sources=god,w2,n3,jobs] [--exclude=<md5s>] [--perLevel=3] [--holdout=5] [--alpha=]\n       node src/prior.js show <model.json>');
}

module.exports = { DIMS, NCTX, NY, CHAIN, VERSION, gravOf, toFrame, fromFrame, contextOf, digitsOf, countRun, makeModel, readModel, policyOf, samplesOf, evalSamples, holdClass, canon };
if (require.main === module) cli();
