'use strict';
// THE LEG TRACE (a doctor's tool, n5): the executor's reach() from a known route's own state at a given tick to a target,
// with its events (exec.skel: the skeleton's sub-level sets reached, their times; exec.reach: every call and sub-leg with
// its tool, time, why) on stderr, so a stuck leg's time can be read: which sub-leg fails, how long each one takes, how far
// the skeleton gets. Like tools/cmp/krt.js (the same executor, prims, bounds), the start chosen by tick.
//   node tools/cmp/legtrace.js <level.eelvl> <route.eetas> "<label>|trophy" --at=<tick>[,<tick>...] [--rungs=3] [--ms=]
//     [--workers=0] [--quiet=1 (exec.skel lines only)]
// Prints one JSON summary line per call on stdout. Env as the compiler's (EEAT_*): an A/B of a knob on one leg.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const RF = require(path.join(root, 'src/reach.js'));
const RUNG_MS = [1500, 5000, 15000, 45000];
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
/** executor.js tileMin: per tile the least cost (fifths) of any ball state centred on it by the field f */
function tileMin(f) {
	const N = f.W * f.H, CUT = RF.CUT, m = new Uint32Array(N).fill(CUT);
	if (f.mode === 'walk' || !f.costR) { for (let t = 0; t < N; t++) m[t] = f.walk ? f.walk[t] : CUT; return m; }
	const QR = f.Q + 3, KF1 = RF.KF + 1, NL = RF.NL;
	for (let t = 0; t < N; t++) {
		let v = CUT;
		for (let i = t * QR, e = i + QR; i < e; i++) if (f.costR[i] < v) v = f.costR[i];
		for (let i = t * KF1, e = i + KF1; i < e; i++) { if (f.costF[i] < v) v = f.costF[i]; if (f.costL[i] < v) v = f.costL[i]; }
		const rc = f.rowC[t], rx = f.rowX[t];
		if (rc >= 0) for (let i = rc * NL, e = i + NL; i < e; i++) if (f.costC[i] < v) v = f.costC[i];
		if (rx >= 0) for (let i = rx * NL, e = i + NL; i < e; i++) if (f.costX[i] < v) v = f.costX[i];
		m[t] = v;
	}
	return m;
}
(async () => {
	const [file, rfile, label0] = pos;
	const label = String(label0).replace(/ x\d+$/, '');
	const ats = String(opt('at', '0')).split(',').map(Number);
	const rungs = String(opt('rungs', '3')).split(',').filter(Boolean).map(Number);
	const msOpt = +opt('ms', 0) || 0, workers = +opt('workers', 0) | 0, quiet = opt('quiet', '0') === '1';
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const masks = C.readEetas(rfile);
	const model = MD.compileModel(L);
	let wp, tiles;
	if (label === 'trophy') { wp = { kind: 'trophy', label: 'trophy' }; tiles = []; for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) tiles.push(i); }
	else {
		const X = model.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) { console.log(JSON.stringify({ err: 'no trigger ' + label })); process.exit(0); }
		wp = { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
		tiles = X.tiles.slice();
	}
	const t0 = Date.now();
	const emit = (ev) => {
		if (quiet && ev.ev !== 'exec.skel') return;
		if (ev.ev === 'exec.skel' || ev.ev === 'exec.reach' || ev.ev === 'exec.walls' || ev.ev === 'exec.death') console.error(`${((Date.now() - t0) / 1000).toFixed(1)} ${JSON.stringify(ev)}`);
	};
	const bounds = BM.createBounds(L, {});
	const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
	const ex = await EX.createExecutor(L, { file, prims, bounds, workers, emit, model });
	const sim = new E.EESim(L), inp = new E.EEInput();
	for (const at of ats) {
		sim.reset();
		for (let t = 0; t < at; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
		const f = T.goalField(T.levelNow(L, sim), tiles, {});
		const c0 = RF.costAt(f, sim);
		// (--sub=c: the skeleton sub-level set {t : the least cost of a state centred on t <= c} of the target's field at
		// this start, as the executor builds it (executor.js tileMin), the target's field tiles its ordering)
		let wpc = wp;
		const sub = +opt('sub', 0);
		if (sub > 0) {
			const m = tileMin(f), lim = Math.round(sub * 5), st = [];
			for (let t = 0; t < m.length; t++) if (m[t] <= lim) st.push(t);
			wpc = { kind: 'region', tiles: st, expect: null, allowDeath: false, fieldTiles: tiles.slice(), fieldTouch: wp.kind === 'trophy', label: `${wp.label} (skeleton ${sub} tiles)` };
		}
		for (const r of rungs) {
			const tb = Date.now();
			const res = await ex.reach([T.strOf(masks.subarray(0, at))], wpc, { ms: msOpt || RUNG_MS[Math.max(0, Math.min(3, r))], level: r, k: 4 });
			const cl = res.fail && res.fail.closest;
			console.log(JSON.stringify({ at, c0: +(+c0).toFixed(1), rung: r, ok: res.ok, ms: Date.now() - tb, tool: res.tool, ticks: res.ok ? res.arrivals[0].tick - at : null,
				why: res.fail ? res.fail.why : null, closest: cl && cl.dist >= 0 ? +(+cl.dist).toFixed(1) : null, ctile: cl && cl.tile >= 0 ? [cl.tile % W, (cl.tile / W) | 0] : null,
				ctick: cl && cl.masks ? cl.masks.length : null }));
			if (res.ok) break;
		}
	}
	await ex.close();
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 600) })); process.exit(0); });
