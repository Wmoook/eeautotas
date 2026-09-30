'use strict';
// THE KNOWN-ROUTE LEG PROFILE (COMPILER DOCTOR 6, n5): every leg of a known route tested with the compiler's own executor
// from the ROUTE'S OWN engine state at the previous trigger (krt.js does one label; this does the whole route): per leg
// the route's own ticks, whether the executor finds a leg to the same trigger (rung 1, then rung 2), its ticks, its tool,
// the failure's closest. The leg-length profile at which the executor stops finding legs is the level's MOVES wall.
//   node tools/cmp/krtall.js <level.eelvl> <route.eetas> [--rungs=1,2] [--max=80] [--from=0] [--scale=1] [--only=long]
// --only=long: only the legs whose route ticks are >= --minleg (default 200). Prints one JSON line per leg to stdout and a
// summary line last. Env as the compiler's (EEAT_*): an A/B of a knob on the known route's legs.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const RUNG_MS = [1500, 5000, 15000, 45000];
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
const FEAT_KIND = (feat) => feat === 'coins' ? 'coin' : feat === 'bcoins' ? 'bcoin' : null;
(async () => {
	const [file, rfile] = pos;
	if (!file || !rfile) { console.error('usage: node tools/cmp/krtall.js <level.eelvl> <route.eetas> [--rungs=1,2] [--max=80]'); process.exit(2); }
	const rungs = String(opt('rungs', '1,2')).split(',').filter(Boolean).map(Number);
	const max = +opt('max', 80), from = +opt('from', 0), scale = +opt('scale', 1) || 1, minleg = +opt('minleg', 200);
	const onlyLong = opt('only', '') === 'long';
	const L = T.loadLevelFile(file), W = L.width;
	const masks = C.readEetas(rfile);
	const ev = TS.routeEvents(L, masks);
	const M = MD.compileModel(L);
	// (the route's steps: every trigger change it made, mapped to the model trigger whose tiles hold the ball's centre
	// then, else the nearest trigger tile within 2 tiles; the trophy last)
	const trigOfTile = new Map();
	for (const X of M.triggers) for (const t of X.tiles) if (!trigOfTile.has(t)) trigOfTile.set(t, X);
	const near = (tile) => {
		if (trigOfTile.has(tile)) return trigOfTile.get(tile);
		const x0 = tile % W, y0 = (tile / W) | 0;
		let best = null, bd = 9;
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
			const X = trigOfTile.get((y0 + dy) * W + x0 + dx);
			if (X && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = X; }
		}
		return best;
	};
	const steps = [];
	for (const e of ev.events) {
		if (e.feat === 'deaths' || e.feat === 'fx' || e.feat === 'cp') continue;
		if (e.feat === 'silver' || e.feat === 'crown') { steps.push({ tick: e.tick, label: 'trophy', wp: { kind: 'trophy', label: 'trophy' } }); break; }
		const X = near(e.tile);
		if (!X) { steps.push({ tick: e.tick, label: `${e.feat}@(${e.tile % W},${(e.tile / W) | 0}) no trigger`, wp: null }); continue; }
		steps.push({ tick: e.tick, label: X.label, wp: { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label: X.label } });
	}
	const bounds = BM.createBounds(L, {});
	const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
	const ex = await EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
	let prevTick = 0, n = 0;
	const sum = { level: path.basename(file), runTicks: ev.runTicks, legs: 0, found: 0, byLen: {} };
	for (let i = 0; i < steps.length && n < max; i++) {
		const s = steps[i], tk = prevTick, routeLeg = s.tick - tk;
		prevTick = s.tick;
		if (i < from || !s.wp) continue;
		if (routeLeg <= 1) continue;   // (a switch row touched tick after tick: no leg)
		if (onlyLong && routeLeg < minleg) continue;
		n++;
		let row = null;
		for (const r of rungs) {
			const t0 = Date.now();
			const res = await ex.reach([T.strOf(masks.subarray(0, tk))], s.wp, { ms: RUNG_MS[Math.max(0, Math.min(3, r))] * scale, level: r, k: 4 });
			const cl = res.fail && res.fail.closest;
			row = { i, label: s.label, start: tk, routeLeg, rung: r, ok: res.ok, ms: Date.now() - t0, tool: res.tool,
				ticks: res.ok ? res.arrivals[0].tick - tk : null, why: res.fail ? res.fail.why : null,
				closest: cl && cl.dist >= 0 ? +(+cl.dist).toFixed(1) : null, ctile: cl && cl.tile >= 0 ? [cl.tile % W, (cl.tile / W) | 0] : null };
			if (res.ok) break;
		}
		console.log(JSON.stringify(row));
		const b = routeLeg < 50 ? '<50' : routeLeg < 150 ? '50-149' : routeLeg < 400 ? '150-399' : routeLeg < 1000 ? '400-999' : '1000+';
		const bb = sum.byLen[b] || (sum.byLen[b] = [0, 0]);
		bb[1]++; sum.legs++;
		if (row.ok) { bb[0]++; sum.found++; }
	}
	console.log(JSON.stringify({ summary: sum }));
	await ex.close();
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 600) })); process.exit(0); });
