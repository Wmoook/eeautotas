'use strict';
// test/planprims.js: the primitives (src/plan/prims.js, navgraph.js, tables.js, primworker.js). Prints 'name: ok|FAIL',
// ends with 'N/M', exits 1 on a failure.
//   node test/planprims.js                       units: routes on toy rooms (found, replayed, the bound below them), the
//                                                exact mode proven on a short room, learn(), T-PRIM-EXACT on the toys,
//                                                the tables, the worker pool, SPEED
//   node test/planprims.js --truth [--limit=N] [--per=5] [--ms=1000] [--only=] [--root=]
//                                                T-PRIM-EXACT on campaign levels, T-PRIM-COVER and T-PRIM-OPT on the known
//                                                routes (src/plan/truthset.js)
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const P = require('../src/plan/prims.js');
const BO = require('../src/plan/bounds.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? '1' : m[2]; }
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
let rng = 987654;
const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const levelOf = (rows, ID) => {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
};
const BASE = { '#': [9], S: [255], G: [121], P: [242, 0, 1, 2], Q: [242, 0, 2, 1], x: [361, 1], k: [6], d: [23], c: [100], D: [43, 1], B: [115], w: [119] };
const ROOMS = {
	gaps: [
		'##############################',
		'#............................#',
		'#............................#',
		'#............................#',
		'#............................#',
		'#.......................G....#',
		'#S.......#####...#####.......#',
		'#####....#...#...#...#....####',
		'#####xxxx#...#xxx#...#xxxx####',
		'##############################',
	],
	stair: [
		'##############',
		'#...........G#',
		'#.........####',
		'#.......###..#',
		'#.....###....#',
		'#...###......#',
		'#S###........#',
		'##############',
	],
	portal: [
		'##########################',
		'#........................#',
		'#S.P##################Q.G#',
		'##########################',
	],
	coin: [
		'########################',
		'#......................#',
		'#......................#',
		'#S.........c.....D....G#',
		'########################',
	],
	water: [
		'####################',
		'#..................#',
		'#S.....wwwwww.....G#',
		'#......wwwwww......#',
		'####################',
	],
};

/** T-PRIM-EXACT on one level: random walks of expand(); every edge's to.masks replayed from the level start reproduce
 *  to.hash */
async function exactWalks(L, nEdges, steps) {
	const pr = await P.createPrims(L, {});
	let ok = 0, bad = 0, n = 0, firstBad = '';
	while (n < nEdges) {
		let a = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		for (let s = 0; s < steps && n < nEdges; s++) {
			const edges = pr.expand(a);
			if (!edges.length) break;
			// verify a sample of this node's edges (all of them would be slow on big levels), walk on one
			for (let k = 0; k < 3 && n < nEdges; k++) {
				const e = edges[Math.floor(rnd() * edges.length)];
				const r = T.playTo(L, e.to.masks, { allowDeath: true });
				n++;
				if (r.sim.stateHash() === e.to.hash && e.to.masks.length === a.masks.length + e.masks.length) ok++; else { bad++; if (!firstBad) firstBad = `${e.macro} at tick ${a.masks.length}`; }
			}
			const alive = edges.filter((e) => !e.to.dead);
			if (!alive.length) break;
			a = alive[Math.floor(rnd() * alive.length)].to;
		}
	}
	pr.close();
	return { ok, bad, n, firstBad };
}

async function unit() {
	const S = {};
	// routes on the toy rooms: found, replayed (the goal test true at the end), never below the bound
	for (const [name, rows] of Object.entries(ROOMS)) {
		const L = levelOf(rows, BASE);
		const pr = await P.createPrims(L, {});
		const a0 = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		const goal = T.goalOf(L, { kind: 'trophy' });
		const t0 = Date.now();
		const r = pr.route([a0], goal, { ms: 3000, k: 3 });
		const ms = Date.now() - t0;
		let replay = r.ok;
		for (const a of r.arrivals) { const p = T.playTo(L, a.masks, { goal }); if (!(p.goalAt === a.masks.length)) replay = false; }
		check(`route ${name}: found, every arrival replayed to its goal tick, ticks >= lb`, r.ok && replay && r.best.ticks >= r.lb && ms <= 3200, `${r.best ? r.best.ticks : '-'} ticks, lb ${r.lb}, ${r.arrivals.length} arrivals, ${r.expanded} expanded, ${ms} ms, ${r.why}`);
		S[name] = { L, pr, r, ms };
	}
	// the exact mode on a short leg: proven (STEP, exact dedup, admissible bound), never slower than the macros' route
	{
		const L = levelOf([
			'############',
			'#..........#',
			'#S........G#',
			'############',
		], BASE);
		const pr = await P.createPrims(L, {});
		const a0 = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		const goal = T.goalOf(L, { kind: 'trophy' });
		const rx = pr.route([a0], goal, { ms: 20000 }, { classDedup: false, family: 'step' });
		const rm = pr.route([a0], goal, { ms: 2000 }, {});
		check('exact mode: proven, <= the macro route', rx.ok && rx.proven && rm.ok && rx.best.ticks <= rm.best.ticks, `exact ${rx.best && rx.best.ticks} (proven ${rx.proven}, ${rx.expanded} expanded), macros ${rm.best && rm.best.ticks}`);
	}
	// learn(): a derived leg is tried first from that class and re-simulated
	{
		const { L, pr, r } = S.gaps;
		const a0 = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		const leg = r.best.masks;
		const to = T.arrivalOf(L, T.playTo(L, leg).sim, leg, null);
		pr.learn(a0, leg, to);
		const before = pr.stats().learnHits;
		const edges = pr.expand(a0);
		const hit = edges.find((e) => e.macro === 'LEARNED');
		check('learn: the cached leg re-simulated from the class (the same state as its replay)', !!hit && pr.stats().learnHits > before && hit.to.hash === to.hash, hit ? `${hit.ticks} ticks, event ${hit.event}` : 'no learned edge');
	}
	// T-PRIM-EXACT on the toys
	let ok = 0, n = 0, bad = '';
	for (const [name, s] of Object.entries(S)) {
		const w = await exactWalks(s.L, 200, 12);
		ok += w.ok; n += w.n;
		if (w.bad && !bad) bad = `${name}: ${w.firstBad}`;
	}
	check('T-PRIM-EXACT (toys)', ok === n && n >= 1000, `${ok}/${n} edges replayed to the same stateHash ${bad}`);
	// the tables: built (or read from the cache), a jump's landing ahead of its start, symmetric in vx0
	{
		const TB = require('../src/plan/tables.js');
		const t0 = Date.now();
		const Tb = TB.load({ modes: ['plain', 'jump1'] });
		const names = Tb.modes.plain.macros;
		const jl = names.indexOf('JUMP(L,rel-)');
		const jR = TB.predict(Tb, 'plain', 0, names.indexOf('JUMP(R,rel-)')), jL = TB.predict(Tb, 'plain', 0, jl);
		const jB = TB.predict(Tb, 'jump1', 0, names.indexOf('JUMP(-)')), jP = TB.predict(Tb, 'plain', 0, names.indexOf('JUMP(-)'));
		check('tables: a jump right lands right, mirror of the left one; the jump effect rises higher', jR[1] > 16 && Math.abs(jR[1] + jL[1]) < 1 && jB[5] > jP[5] + 10,
			`R dx ${jR[1].toFixed(1)} in ${jR[0]} ticks, L dx ${jL[1].toFixed(1)}, rise ${jP[5].toFixed(1)} vs jump effect ${jB[5].toFixed(1)}; ${Tb.cached ? 'cached' : `built in ${Date.now() - t0} ms`} (${TB.cachePath()})`);
	}
	// the worker pool: the same route on another thread
	{
		const fs = require('fs'), os = require('os'), path = require('path');
		const file = path.join(os.tmpdir(), `eeat_prims_test_${process.pid}.eelvl`);
		const cells = [];
		ROOMS.gaps.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...BASE[ch]]); }));
		fs.writeFileSync(file, ED.eelvlOf({ name: 't', width: ROOMS.gaps[0].length, height: ROOMS.gaps.length, cells }));
		const L = T.loadLevelFile(file);
		const pr = await P.createPrims(L, { file, workers: 2 });
		const goal = T.goalOf(L, { kind: 'trophy' });
		const a0 = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		const rs = await Promise.all([pr.routeAsync([a0], goal, { kind: 'trophy' }, { ms: 1500 }, {}), pr.routeAsync([a0], goal, { kind: 'trophy' }, { ms: 1500 }, { w: 3 })]);
		const okA = rs.every((r) => r && r.ok && r.arrivals.length && T.playTo(L, r.arrivals[0].masks, { goal }).goalAt === r.arrivals[0].masks.length);
		check('primworker: two routes on worker threads, their arrivals replayed here', okA, rs.map((r) => (r && r.best ? r.best.ticks : '-')).join(' / '));
		pr.close();
		try { fs.unlinkSync(file); } catch (e) { /* gone */ }
	}
	// SPEED
	{
		const { L, pr } = S.gaps;
		const a0 = T.arrivalOf(L, T.playTo(L, new Uint8Array(0)).sim, new Uint8Array(0), null);
		const goal = T.goalOf(L, { kind: 'trophy' });
		const s0 = pr.stats();
		const t0 = Date.now();
		const r = pr.route([a0], goal, { ms: 2000 }, { w: 1 });
		const s1 = pr.stats(), sec = (Date.now() - t0) / 1000;
		console.log(`  SPEED: ${((s1.expands - s0.expands) / sec).toFixed(0)} expansions/s, ${((s1.ticks - s0.ticks) / sec / 1e6).toFixed(2)} M engine ticks/s (one thread; the kept edges' ${((s1.sims - s0.sims) / sec / 1e6).toFixed(2)} M), route latency ${Object.values(S).map((s) => s.ms).join(' / ')} ms (toys, 3 s budget, anytime)`);
		check('SPEED: printed', r.expanded > 0);
	}
}

// ---------------------------------------------------------------- the ground truth
async function truth() {
	const TS = require('../src/plan/truthset.js');
	const root = args.root || process.env.EEAT_TRUTH_ROOT;
	const per = +args.per > 0 ? +args.per : 5, ms = +args.ms > 0 ? +args.ms : 1000;
	const [shI, shN] = (args.shard || '0/1').split('/').map(Number);
	// T-PRIM-EXACT: 1000 expansions over campaign levels + the toys (the first shard)
	if (shI === 0 && !args.noexact) {
		const lv = TS.levelFiles({ root, sets: ['campaign'] });
		let ok = 0, n = 0, bad = '';
		const pick = [];
		for (let k = 0; k < Math.min(8, lv.length); k++) pick.push(lv[Math.floor(rnd() * lv.length)]);
		for (const l of pick) {
			const L = T.loadLevelFile(l.file);
			const w = await exactWalks(L, 110, 15);
			ok += w.ok; n += w.n;
			if (w.bad && !bad) bad = `${l.name}: ${w.firstBad}`;
		}
		for (const rows of [ROOMS.gaps, ROOMS.portal]) { const w = await exactWalks(levelOf(rows, BASE), 60, 10); ok += w.ok; n += w.n; if (w.bad && !bad) bad = `toy: ${w.firstBad}`; }
		check('T-PRIM-EXACT (campaign + toys)', ok === n && n >= 1000, `${ok}/${n} ${bad}`);
	}
	// T-PRIM-COVER and T-PRIM-OPT
	const routes = TS.knownRoutes({ root });
	const lim = +args.limit > 0 ? +args.limit : routes.length;
	const cover = { n: 0, found: 0, ratio: [], atOrBelow: 0, macro: {} };
	const opt = { n: 0, both: 0, gaps: [], proven: 0 };
	let nr = 0;
	const order = routes.map((e, i) => i).sort(() => rnd() - 0.5).slice(0, lim);
	for (const [oi, idx] of order.entries()) {
		if (oi % shN !== shI) continue;
		const e = routes[idx];
		if (args.only && !String(e.name).toLowerCase().includes(String(args.only).toLowerCase())) continue;
		let tr = null;
		try { tr = TS.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) continue;
		nr++;
		const L = tr.L, W = L.width, H = L.height, n = tr.masks.length;
		const pr = await P.createPrims(L, {});
		// the route's support events: landings, trigger changes, teleports
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const sup = [0];
		let onG = !!sim.on_ground, px = sim.px, py = sim.py, sig = P.featSig(sim);
		for (let t = 0; t < n; t++) {
			E.applyMask(inp, tr.masks[t]); sim.tick(inp);
			const g = P.featSig(sim);
			if (!sim.is_dead && ((!onG && sim.on_ground) || g !== sig || Math.abs(sim.px - px) > 20 || Math.abs(sim.py - py) > 20)) sup.push(t + 1);
			onG = !!sim.on_ground; px = sim.px; py = sim.py; sig = g;
		}
		// consecutive pairs 200 ticks apart or less (merged to at least 20 ticks), a sample
		const pairs = [];
		for (let k = 0; k + 1 < sup.length; k++) {
			let j = k + 1;
			while (j + 1 < sup.length && sup[j] - sup[k] < 20) j++;
			if (sup[j] - sup[k] <= 200 && sup[j] > sup[k]) pairs.push([sup[k], sup[j]]);
		}
		const sample = pairs.sort(() => rnd() - 0.5).slice(0, per);
		for (const [a, b] of sample) {
			const pa = T.playTo(L, tr.masks.subarray(0, a), { allowDeath: true });
			const pb = T.playTo(L, tr.masks.subarray(0, b), { allowDeath: true });
			if (pa.sim.is_dead || pb.sim.is_dead) continue;
			const tileB = T.tileOf(pb.sim, W, H);
			// the feature the route changed on the way, if any (the model's feats: the Expect)
			let expect = null;
			for (const f of TS.BASE_FEATS) { if (f === 'deaths' || f === 'cp' || f === 'fx') continue; const va = T.featValue(pa.sim, f), vb = T.featValue(pb.sim, f); if (va !== vb) { expect = { feat: f, value: vb }; break; } }
			const wp = { kind: 'region', tiles: [tileB], expect, label: 'cover' };
			const goal = T.goalOf(L, wp);
			const aA = T.arrivalOf(L, pa.sim, tr.masks.slice(0, a), null);
			// the route's own ticks to that goal (it may meet it before b)
			const own = T.playTo(L, tr.masks.subarray(0, b), { goal, from: { snap: pa.sim.snapshot(), tick: a } });
			const routeT = (own.goalAt > 0 ? own.goalAt : b) - a;
			const r = pr.route([aA], goal, { ms }, {});
			cover.n++;
			cover.why = cover.why || {};
			cover.why[r.why] = (cover.why[r.why] || 0) + 1;
			if (args.verbose && !r.ok) console.log(`    miss ${e.name} ${a}->${b} (${routeT} ticks) ${expect ? expect.feat : '-'}: ${r.why}, lb ${r.lb}, closest ${r.closest ? r.closest.dist : '-'}, ${r.expanded} expanded, fx ${T.featValue(pa.sim, 'fx')}`);
			if (r.ok) {
				cover.found++;
				const ft = r.best.ticks - a;
				cover.ratio.push(ft / Math.max(1, routeT));
				if (ft <= routeT) cover.atOrBelow++;
			}
			// T-PRIM-OPT: short legs (<= 40 ticks): the exact search (STEP only, exact dedup) vs the macros
			if (routeT <= 40 && opt.n < 50) {
				opt.n++;
				const rx = pr.route([aA], goal, { ms: Math.max(ms * 3, 3000) }, { classDedup: false, family: 'step' });
				if (rx.ok && r.ok) { opt.both++; opt.gaps.push(r.best.ticks - rx.best.ticks); if (rx.proven) opt.proven++; }
			}
		}
		const mu = pr.stats().macroUse;
		for (const [k, v] of Object.entries(mu)) cover.macro[k] = (cover.macro[k] || 0) + v;
		if (nr % 5 === 0) console.log(`  ${nr} routes: cover ${cover.found}/${cover.n}, opt ${opt.both}/${opt.n}`);
	}
	const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const p90 = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
	const cov = cover.found / Math.max(1, cover.n);
	console.log(`  T-PRIM-COVER: ${nr} routes, ${cover.n} legs, found ${cover.found} (${(100 * cov).toFixed(1)}%), ratio found / route median ${med(cover.ratio).toFixed(3)} p90 ${p90(cover.ratio).toFixed(3)}, at or below the route's ticks ${(100 * cover.atOrBelow / Math.max(1, cover.found)).toFixed(1)}%`);
	console.log(`  macro usage: ${JSON.stringify(cover.macro)}; why: ${JSON.stringify(cover.why)}`);
	check('T-PRIM-COVER (coverage >= 80%, median ratio <= 1.05)', cov >= 0.8 && med(cover.ratio) <= 1.05, `${(100 * cov).toFixed(1)}%, median ${med(cover.ratio).toFixed(3)}`);
	const gz = opt.gaps.filter((g) => g === 0).length;
	console.log(`  T-PRIM-OPT: ${opt.n} short legs, both found ${opt.both}, the exact proven ${opt.proven}, gap macros - exact: median ${med(opt.gaps)}, p90 ${p90(opt.gaps)}, max ${opt.gaps.length ? Math.max(...opt.gaps) : NaN}, zero gap ${gz}/${opt.gaps.length}; below 0: ${opt.gaps.filter((g) => g < 0).length} (the exact search cut by its budget)`);
	check('T-PRIM-OPT (reported)', opt.n > 0, `${opt.both}/${opt.n}`);
}

(async () => {
	if (args.truth) await truth(); else await unit();
	console.log(`${pass}/${pass + fail}`);
	process.exit(fail ? 1 : 0);
})();
