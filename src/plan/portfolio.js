'use strict';
// src/plan/portfolio.js - THE PORTFOLIO CHAIN SOLVER (n5-s99-portfolio, 2026-09-30): ONE call per stretch (a real engine
// state -> a target's tiles, the moves study's support target: the tile, its class letter, a teleport) that runs the four
// chain solvers of the n5 chains lab in one budget and returns the first leg any of them finds (their UNION):
//   'chain' msolve.chain (src/plan/msolve.js: A* over support states, solved legs as edges; RESUMABLE, o.resume),
//   'corr'  the corridor (src/plan/lab/corridor.js: footholds, the event fan, the lazy widened fan; RESUMABLE),
//   'prof'  the speed profile (src/plan/lab/profile.js: the bang-bang family's reachable sets; one piece),
//   'bw'    the backward meet (src/plan/lab/backward.js: the macro closure's values, A* over exact states; one piece; its
//           closed values are memoised by target and discrete state),
//   'leg'   the executor's best-first leg finder (src/plan/legs.js legBest: cells of position and speed, the goal field's
//           time as the order; one piece).
// THE ALLOCATOR: the stretch's SHAPE from the start (the goal field's cost c0 in tiles, the estimated ticks KAPPA x c0, the
// field tiles on the way, a teleport target) picks the arms' ORDER and SHARES (cheap first: the arms that fit the shape);
// each arm's slice is its share of what is left (an arm that ends early, 'exhausted' / 'cut', gives its time to the next
// ones); what is left after the last arm goes back to the resumable arms. ONE CONTINUOUS BUDGET: a later call for the same
// stretch (o.resume, default: the start's state hash + the target) continues its SESSION: the resumable arms go on where
// they stopped, a one-piece arm runs once a session, and only when the call can give it its whole share (no restarts).
// Every answer is the arm's masks replayed here by the engine from the start (msolve's goal test): exact by construction.
//
//   const P = createPortfolio(L, {solver})           (solver: a msolve createSolver(L) to share)
//   P.solve(start, target, o) -> {ok, masks, T, arm, why, ms, shape, arms: {arm: {ms, ok, T, why, runs}}, order, resumed}
//     start: an EESnapshot of L (or an EESim); target: {tiles, cls ('any'), tele, via}
//     o: {ms (5000), deadline, Tmax (3000), resume (a key; true / undefined: the automatic key; false: no session),
//         arms ('chain,corr,prof,bw,leg'), plan (an order and shares 'corr:0.3,prof:0.3,...' in place of the shape's),
//         minProf (800 ms), minBw (1500 ms): a one-piece arm's least slice}
//   P.shapeOf(start, target) -> {c0, est, field, ffrac, tele, dist}
const E = require('../eesim.js');
const T = require('./types.js');
const RF = require('../reach.js');
const MS = require('./msolve.js');

const KAPPA = 16 / 6.776552880470027;
const F_SOLID = 1, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DOTS = new Set([4, 414]);
const ARROWS = new Set([1, 2, 3, 1518, 411, 412, 413, 1519]);
// the corridor's executor config (n5-lab-corridor a149379: the event fan + plain stops + the x-direction store + the lazy widened fan)
const CORR_OPTS = { M: 3, Mu: 1, legT: 90, RX: 18, RD: 30, subStop: 2, plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false };
const RESUMABLE = { chain: true, corr: true, prof: false, bw: false, leg: false };
const SESS_KEEP = 8;
const ENV = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createPortfolio(L, opts = {}) {
	const S = opts.solver || MS.createSolver(L, {});
	const W = L.width, H = L.height, N = W * H;
	const flags = L.flags;
	const sim = new E.EESim(L);
	sim.reset();
	let CR = null, BW = null, PF = null, LG = null;
	const legs = () => LG || (LG = require('./legs.js'));
	const corridor = () => CR || (CR = require('./lab/corridor.js').createCorridor(L, { solver: S }));
	const backward = () => BW || (BW = require('./lab/backward.js').createBackward(L, { solver: S }));
	const profile = () => PF || (PF = require('./lab/profile.js'));
	const fieldId = new Uint8Array(flags.length);
	for (let id = 0; id < flags.length; id++) {
		const f = flags[id] | 0;
		fieldId[id] = (f & F_SOLID) === 0 && ((f & (F_LIQUID | F_CLIMB | F_BOOST)) || DOTS.has(id) || ARROWS.has(id)) ? 1 : 0;
	}
	const geoMemo = new Map();
	const sessions = new Map();
	let onceSeq = 0;
	const stats = { solves: 0, ok: 0, byArm: {} };

	const snapOf = (start) => (start instanceof E.EESim ? start.snapshot() : start);
	const tileAt = (s) => { const tx = Math.trunc(s.px + 8) >> 4, ty = Math.trunc(s.py + 8) >> 4; return tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : ty * W + tx; };

	/** the goal field of the level as it stands in sim (doors, the ball's effect state) to the tiles, memoised */
	function fieldOf(s, tiles) {
		const Lc = T.levelNow(L, s);
		const pl = T.plainOf(s);
		const key = T.fgHash(Lc.fg) + '|' + JSON.stringify(pl) + '|' + Array.from(tiles).sort((a, b) => a - b).join(',');
		let f = geoMemo.get(key);
		if (!f) { f = T.goalField(Lc, Array.from(tiles), { deaths: false, plainFx: pl }); geoMemo.set(key, f); if (geoMemo.size > 16) geoMemo.delete(geoMemo.keys().next().value); }
		return f;
	}
	/** the executor's region rule: M tiles around the start and the target, the tiles the field's walk reaches and their neighbours */
	function regionOf(f, s, tiles, M) {
		let x0 = W, y0 = H, x1 = -1, y1 = -1;
		const add = (t) => { const x = t % W, y = (t / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
		add(tileAt(s));
		for (const t of tiles) add(t);
		x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(W - 1, x1 + M); y1 = Math.min(H - 1, y1 + M);
		const reg = new Uint8Array(N);
		const walk = f && f.walk ? f.walk : null;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const t = y * W + x;
			if (walk === null || walk[t] !== RF.CUT) { reg[t] = 1; continue; }
			for (let dy = -1; dy <= 1 && !reg[t]; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				if (walk[yy * W + xx] !== RF.CUT) { reg[t] = 1; break; }
			}
		}
		return reg;
	}

	/** THE SHAPE of a stretch from its start: c0 the goal field's cost (tiles; -1 cut), est = KAPPA x c0 (ticks at the
	 *  held run's top speed), ffrac the field tiles' share of the box around the start and the target (2 tiles out), field
	 *  (the start or the target in a field, or ffrac >= 0.15), tele, dist (the Chebyshev tile distance) */
	function shapeOf(start, target) {
		const snap = snapOf(start);
		sim.restore(snap);
		const tiles = Array.from(target.tiles);
		let c0 = -1;
		try { c0 = RF.costAt(fieldOf(sim, tiles), sim); } catch (e) { c0 = -1; }
		const t0 = tileAt(sim);
		const sx = t0 % W, sy = (t0 / W) | 0;
		let x0 = sx, x1 = sx, y0 = sy, y1 = sy, dist = 0;
		for (const t of tiles) { const x = t % W, y = (t / W) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); dist = Math.max(dist, Math.abs(x - sx), Math.abs(y - sy)); }
		x0 = Math.max(0, x0 - 2); x1 = Math.min(W - 1, x1 + 2); y0 = Math.max(0, y0 - 2); y1 = Math.min(H - 1, y1 + 2);
		let nf = 0, nt = 0;
		const fg = sim.tiles;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const id = fg[y * W + x]; if (id >= 0 && id < fieldId.length && (flags[id] & F_SOLID) === 0) { nt++; if (fieldId[id]) nf++; } }
		const ffrac = nt ? nf / nt : 0;
		const inField = (t) => t >= 0 && t < N && fg[t] >= 0 && fg[t] < fieldId.length && fieldId[fg[t]] === 1;
		const tf = tiles.some(inField) || (target.cls && 'WCZB'.includes(target.cls));
		const field = inField(t0) || !!tf || ffrac >= 0.15;
		return { c0, est: c0 >= 0 ? Math.round(KAPPA * c0) : -1, field, ffrac: Math.round(100 * ffrac) / 100, tele: !!target.tele, dist };
	}

	/** THE PLAN: [[arm, share]] in order: the backward meet first (the chains' strongest and fastest arm: 5 s alone 85.9% of
	 *  the 4-move chains, found in 418 ms median, p90 913 ms), then the profile (79.9%, p90 1.4 s), the corridor (74.4%, p90
	 *  3 s; resumable), msolve.chain last (resumable, it takes the rest); a teleport target: no profile / leg arm */
	function planOf(shape, arms) {
		const has = (a) => arms.includes(a) && !((a === 'prof' || a === 'leg') && shape.tele);
		const plan = [['bw', 0.3], ['prof', 0.25], ['leg', 0.15], ['corr', 0.3], ['chain', 0.1]];
		return plan.filter(([a]) => has(a));
	}
	function parsePlan(s) { return String(s).split(',').filter(Boolean).map((x) => { const [a, f] = x.split(':'); return [a, +f || 0.25]; }); }

	/** one arm's slice: {ok, masks (replayed, cut at the goal), T, why, ms, done (a one-piece arm ran / an arm closed)} */
	function runArm(arm, snap, target, ms, deadline, o, sess) {
		const t0 = Date.now();
		const r = { ok: false, masks: null, T: 0, why: '', ms: 0, done: false };
		const Tmax = o.Tmax || 3000;
		let res = null;
		try {
			if (arm === 'chain') {
				res = S.chain(snap, target, { ms, resume: sess.key + '|chain' });
				if (!res.ok && res.closed) r.done = true;
			} else if (arm === 'corr') {
				res = corridor().solve(snap, target, Object.assign({}, CORR_OPTS, o.corrOpts || {}, { ms, deadline, Tmax, first: true, resume: sess.key + '|corr' }));
				if (!res.ok && (res.why === 'exhausted' || res.why === 'cut')) r.done = true;
			} else if (arm === 'prof') {
				const gtest = S.goal(target);
				const goal = { tiles: Int32Array.from(target.tiles), cls: target.cls || 'any', fieldTiles: null, allowDeath: false, test: (s) => gtest(s, s.px, s.py) };
				res = profile().profileLeg(L, [{ snap, tick: 0 }], goal, { ms, deadline, depth: Tmax });
				if (res && res.ok) res.T = res.tick;
				r.done = true;
			} else if (arm === 'bw') {
				res = backward().solve(snap, target, { ms });
				r.done = true;
			} else if (arm === 'leg') {
				// (the executor's tier 3 finder on the stretch: the goal field of the level as it stands at the start, a region
				// of LEG_M tiles around the start and the target on the field's walk; the goal = msolve's exact test)
				sim.restore(snap);
				const gtest = S.goal(target);
				const tiles = Int32Array.from(target.tiles);
				const mask = new Uint8Array(N);
				for (const t of tiles) if (t >= 0 && t < N) mask[t] = 1;
				const goal = { kind: 'trigger', tiles, mask, test: (s) => gtest(s, s.px, s.py), allowDeath: false, fieldTiles: null };
				const f = fieldOf(sim, target.tiles);
				const reg = regionOf(f, sim, target.tiles, o.legM || 24);
				const rl = legs().legBest(L, [{ snap, tick: 0 }], goal, { deadline, field: f, region: reg, depthMax: Tmax });
				res = { ok: rl.status === 'found' && !!rl.tail, masks: rl.tail, T: rl.depth, why: rl.status };
				r.done = true;
			} else throw new Error('arm ' + arm);
		} catch (e) { res = { ok: false, why: 'error: ' + (e && e.message || e) }; }
		r.ms = Date.now() - t0;
		r.why = res ? res.why || '' : '';
		if (res && res.ok && res.masks && res.masks.length) {
			const hit = S.replay(snap, Uint8Array.from(res.masks), target);
			if (hit > 0) { r.ok = true; r.masks = Uint8Array.from(res.masks).subarray(0, hit); r.T = hit; }
			else r.why = 'the replay missed';
		}
		return r;
	}

	function solve(start, target, o = {}) {
		const t0 = Date.now();
		stats.solves++;
		const B = o.ms || 5000;
		const deadline = o.deadline ? Math.min(o.deadline, t0 + B) : t0 + B;
		const snap = snapOf(start);
		const arms = String(o.arms || ENV('EEAT_PORT_ARMS', 'chain,corr,prof,bw,leg')).split(',');
		const shape = shapeOf(snap, target);
		// the session (one continuous budget per stretch; o.resume false: a session of this call alone)
		let key = typeof o.resume === 'string' ? o.resume : null;
		if (!key) {
			sim.restore(snap);
			let th = 0x811c9dc5;
			for (const t of target.tiles) { th = (th ^ t) >>> 0; th = Math.imul(th, 0x01000193); }
			key = `${sim.stateHash()}|${target.cls || 'any'}|${target.tele ? 1 : 0}|${th >>> 0}|${o.Tmax || 3000}`;
		}
		if (o.resume === false) key += '|once' + (++onceSeq);
		let sess = o.resume === false ? null : sessions.get(key);
		if (sess) { sessions.delete(key); sessions.set(key, sess); }
		else {
			sess = { key, spent: {}, done: {}, calls: 0 };
			if (o.resume !== false) { sessions.set(key, sess); while (sessions.size > SESS_KEEP) sessions.delete(sessions.keys().next().value); }
		}
		sess.calls++;
		const resumed = sess.calls > 1;
		const plan = o.plan ? parsePlan(o.plan).filter(([a]) => RESUMABLE[a] !== undefined && !((a === 'prof' || a === 'leg') && shape.tele)) : planOf(shape, arms);
		const out = { ok: false, masks: null, T: 0, arm: null, why: '', ms: 0, shape, arms: {}, order: plan.map(([a]) => a), resumed, deferred: [] };
		const note = (arm, r) => {
			const a = out.arms[arm] || (out.arms[arm] = { ms: 0, ok: false, T: 0, why: '', runs: 0 });
			a.ms += r.ms; a.runs++; a.why = r.why; if (r.ok) { a.ok = true; a.T = r.T; }
			sess.spent[arm] = (sess.spent[arm] || 0) + r.ms; if (r.done) sess.done[arm] = true;
			const s = stats.byArm[arm] || (stats.byArm[arm] = { runs: 0, ok: 0, ms: 0 });
			s.runs++; s.ms += r.ms; if (r.ok) s.ok++;
		};
		// THE SESSION'S BUDGET: what it spent + this call's window, or the caller's projection of the stretch's whole budget
		// (o.total: the executor's rungs to come) when larger; a one-piece arm's piece = its share of that, run only when this
		// call holds it whole (else deferred to a later call of the session: never cut, never restarted); a resumable arm
		// takes its share of this call and goes on in the next
		const spent0 = Object.values(sess.spent).reduce((x, y) => x + y, 0);
		const win = deadline - t0;
		const proj = Math.max(spent0 + win, o.total > 0 ? o.total : 0);
		const later = proj > spent0 + win + 1;   // (the session expects more calls)
		let shareLeft = plan.reduce((x, [a, f]) => x + (sess.done[a] ? 0 : f), 0);
		for (let i = 0; i < plan.length && !out.ok; i++) {
			const [arm, f] = plan[i];
			const left = deadline - Date.now();
			if (left < 20) break;
			if (sess.done[arm]) continue;
			const fair = left * f / Math.max(1e-9, shareLeft);   // (its share of what is left: the earlier arms' unused time flows forward)
			shareLeft -= f;
			let slice;
			if (RESUMABLE[arm]) slice = i === plan.length - 1 ? left : fair;
			else {
				const piece = Math.max(f * proj, fair);
				if (piece > left + 1 && later) { out.deferred.push(arm); continue; }
				slice = i === plan.length - 1 ? left : Math.min(piece, left);
			}
			if (slice < 20) continue;
			const r = runArm(arm, snap, target, Math.round(slice), Date.now() + slice, o, sess);
			note(arm, r);
			if (r.ok) { Object.assign(out, { ok: true, masks: r.masks, T: r.T, arm }); break; }
		}
		// what is left: back to the resumable arms of the plan (their searches go on where they stopped)
		for (let pass = 0; pass < 3 && !out.ok; pass++) {
			const rs = plan.map(([a]) => a).filter((a) => RESUMABLE[a] && !sess.done[a]);
			if (!rs.length) break;
			let any = false;
			for (let j = 0; j < rs.length && !out.ok; j++) {
				const left = deadline - Date.now();
				if (left < 30) break;
				const slice = left / (rs.length - j);
				const r = runArm(rs[j], snap, target, Math.round(slice), Date.now() + slice, o, sess);
				note(rs[j], r);
				any = true;
				if (r.ok) Object.assign(out, { ok: true, masks: r.masks, T: r.T, arm: rs[j] });
			}
			if (!any) break;
		}
		out.ms = Date.now() - t0;
		if (!out.ok) out.why = Object.entries(out.arms).map(([a, x]) => `${a}:${x.why || '-'}`).join(' ');
		if (out.ok) { stats.ok++; sessions.delete(sess.key); }
		return out;
	}

	return { solve, shapeOf, planOf, stats, solver: S };
}

module.exports = { createPortfolio, CORR_OPTS, KAPPA };
