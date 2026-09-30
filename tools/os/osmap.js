'use strict';
// THE ONE SHOT's reach on a level (a diagnostic): src/plan/oneshot/solve.js for --seconds, then an ASCII map of the
// level with the tiles its nodes reached ('o'; '*' the nearest node to its first waypoint), the waypoints ('W'), the
// start ('S'), walls '#', and a known route's tiles ('+', --route=<file.eetas>) where no node went. stdout.
//   node tools/os/osmap.js <level> [--seconds=20] [--route=<file.eetas>] [--x0= --y0= --x1= --y1=]
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const file = pos[0];
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const model = await require(path.join(root, 'src/plan/model.js')).compileModel(L, { file });
	const bounds = await require(path.join(root, 'src/plan/bounds.js')).createBounds(L, { model });
	const facts = require(path.join(root, 'src/plan/facts.js')).createFacts({ rungs: 4, model });
	const planner = require(path.join(root, 'src/plan/planner.js')).createPlanner(model, facts, { bounds, file, floorAsync: false });
	const OS = require(path.join(root, 'src/plan/oneshot/solve.js'));
	const os = OS.createOneShot(L, { model, planner, bounds });
	const r = os.run((+opt('seconds', 20)) * 1000);
	const nodes = os._nodes;
	const mark = new Uint8Array(W * H);
	const sim = new E.EESim(L);
	let bestNear = Infinity, bestId = -1;
	for (const n of nodes) {
		if (!n.S) continue;
		const m = os.masksOf(n.id);
		const pr = T.playTo(L, m, { allowDeath: true });
		mark[T.tileOf(pr.sim, W, H)] = 1;
		if (n.near < bestNear) { bestNear = n.near; bestId = n.id; }
	}
	const rt = new Uint8Array(W * H);
	if (opt('route', '')) {
		const rm = C.readEetas(opt('route', ''));
		const s2 = new E.EESim(L), inp = new E.EEInput(); s2.reset();
		for (let t = 0; t < rm.length; t++) { E.applyMask(inp, rm[t]); s2.tick(inp); if (!s2.is_dead) rt[T.tileOf(s2, W, H)] = 1; if (s2.has_silver_crown) break; }
	}
	let bt = -1;
	if (bestId >= 0) { const pr = T.playTo(L, os.masksOf(bestId), { allowDeath: true }); bt = T.tileOf(pr.sim, W, H); }
	sim.reset();
	const st = T.tileOf(sim, W, H);
	const wp = new Uint8Array(W * H);
	const plans = planner.plan({ arrival: T.arrivalOf(L, sim, new Uint8Array(0), null), S: model.stateOf(sim) }, { k: 2, ms: 500 });
	const pl = Array.isArray(plans) ? plans : plans.plans || [];
	for (const p of pl) { const w = p.steps[0].waypoint; for (const t of (w.kind === 'trophy' ? model.trophyTiles : w.tiles)) wp[t] = 1; console.log('plan:', p.steps.map((s) => s.waypoint.label).join(' -> '), 'cost', p.cost); }
	const x0 = +opt('x0', 0), y0 = +opt('y0', 0), x1 = +opt('x1', W - 1), y1 = +opt('y1', H - 1);
	for (let y = y0; y <= y1; y++) {
		let s = '';
		for (let x = x0; x <= x1; x++) {
			const t = y * W + x, id = L.fg[t], f = L.flags[id] | 0;
			s += t === st ? 'S' : t === bt ? '*' : wp[t] ? 'W' : mark[t] ? 'o' : rt[t] ? '+' : (f & 1) ? '#' : id ? ':' : '.';
		}
		console.log(s);
	}
	console.log(JSON.stringify({ ok: r.ok, bestNear, stats: r.stats }));
	process.exit(0);
})();
