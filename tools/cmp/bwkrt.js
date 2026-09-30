'use strict';
// THE KNOWN-ROUTE TEST for the lab's backward solver (src/plan/lab/backward.js, n5-lab-backward): krt.js's legs (from the
// KNOWN ROUTE'S OWN engine states: its previous trigger, 300 and 120 ticks before it first enters the target), solved by
// backward reachability + meet in the middle instead of the executor. Every leg found is replayed from the level's start
// (the route's prefix + the leg: the centre in the target's tiles at the leg's last tick) before it counts.
//   node tools/cmp/bwkrt.js <level.eelvl> <route.eetas> "<label>" [--backs=300,120] [--prev=1] [--ms=10000] [--out=<leg.eetas>]
// <label>: the model's trigger label ("coin (93,41)"; a trailing " xN" is dropped) or "trophy". Env EEAT_BW_*: the
// solver's knobs (backward.js DEF). Prints one JSON line per start to stderr and a summary line to stdout.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const [file, rfile, label0] = pos;
	if (!file || !rfile || !label0) { console.error('usage: node tools/cmp/bwkrt.js <level.eelvl> <route.eetas> "<label>" [--backs=300,120] [--prev=1] [--ms=10000]'); process.exit(2); }
	const label = String(label0).replace(/ x\d+$/, '');
	const backs = String(opt('backs', '300,120')).split(',').filter(Boolean).map(Number).filter((b) => b > 0);
	const usePrev = opt('prev', '1') !== '0', ms = +opt('ms', 10000);
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const masks = C.readEetas(rfile);
	const ev = TS.routeEvents(L, masks);
	const out = { level: path.basename(file), label, complete: ev.complete, runTicks: ev.runTicks };
	let tiles;
	const M = MD.compileModel(L);
	if (label === 'trophy') tiles = M.trophyTiles.slice();
	else {
		const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) { out.err = 'no trigger ' + label; console.log(JSON.stringify(out)); process.exit(0); }
		tiles = X.tiles.slice();
	}
	out.tiles = tiles.length;
	const tset = new Set(tiles);
	const inTarget = (sim) => tset.has(T.tileOf(sim, W, H));
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	let hit = -1;
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); if (inTarget(sim)) { hit = t + 1; break; } }
	out.hit = hit;
	if (hit < 0) { out.err = 'the known route never enters the target'; console.log(JSON.stringify(out)); process.exit(0); }
	const prevEv = ev.events.filter((e) => e.tick < hit && e.feat !== 'deaths' && e.feat !== 'fx').pop();
	const starts = [];
	if (usePrev && prevEv) starts.push(['prevEvent ' + prevEv.feat, prevEv.tick]); else if (usePrev) starts.push(['spawn', 0]);
	for (const b of backs) if (hit - b > (usePrev && prevEv ? prevEv.tick : 0)) starts.push(['hit-' + b, hit - b]);
	const B = BW.createBackward(L);
	out.res = [];
	for (const [name, tk] of starts) {
		sim.reset();
		for (let t = 0; t < tk; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
		const snap = sim.snapshot();
		const t0 = Date.now();
		let r;
		try { r = B.solve(snap, { tiles }, { ms, probe: opt('probe', '0') === '1' ? masks.subarray(tk, hit).map((m) => m & 31) : null, probeEvery: +opt('probeEvery', 10), debugReplay: opt('debugReplay', '0') === '1' }); } catch (e) { r = { ok: false, why: 'error ' + (e && e.stack || e) }; }
		const row = { start: name, tick: tk, routeLeg: hit - tk, ok: r.ok, T: r.ok ? r.T : null, ms: Date.now() - t0, why: r.why || null, st: r.stats, rssMB: Math.round(process.memoryUsage().rss / 1048576) };
		if (r.ok) {
			// the whole run: the route's prefix + the leg, from the level's start
			sim.reset();
			for (let t = 0; t < tk; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
			let h = 0, alive = !sim.is_dead;   // (a dead start plays its dead ticks first)
			for (let t = 0; t < r.masks.length; t++) { E.applyMask(inp, r.masks[t]); sim.tick(inp); if (sim.is_dead) { if (alive) break; continue; } alive = true; if (inTarget(sim)) { h = t + 1; break; } }
			row.verified = h === r.T;
			if (opt('out', '') && row.verified) C.writeEetas(opt('out') + '.' + name.replace(/\W+/g, '_') + '.eetas', Uint8Array.from([...masks.subarray(0, tk), ...r.masks]));
		}
		console.error(JSON.stringify(row));
		out.res.push(row);
	}
	console.log(JSON.stringify(out));
})();
