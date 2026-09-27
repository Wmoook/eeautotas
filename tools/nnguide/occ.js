'use strict';
// The "learned guide line" data (tools/nnguide/occ.py): per level of the bundle (catalog.js) the static maps a network
// reads (the class per tile with the doors as at the start, the door-aware walk to the trophy at the start, the walk
// with every door open, the start and the trophies) and the target: the tiles the level's finishing routes pass (their
// box centre's tile), as a guide line drawn along a route would mark them; for a level with a judge route (the held-out
// evaluation) also its tiles and its tile per tick.
//   node tools/nnguide/occ.js [--out=occ.jsonl] (in NN_WORK, src/out/nnguide: third-party data, never in git)
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const E = C.E;
const RF = require('../../src/reach.js');
const NG = require('../../src/nnguide.js');
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const WORK = process.env.NN_WORK || path.join(__dirname, '..', '..', 'src', 'out', 'nnguide');
const bundle = path.join(WORK, 'bundle');
const cat = JSON.parse(fs.readFileSync(path.join(bundle, 'catalog.json'), 'utf8'));
const out = fs.openSync(path.resolve(WORK, arg('out', 'occ.jsonl')), 'w');
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const t0 = Date.now();
for (const c of cat) {
	if (!c.routes.length) continue;
	const L = E.prepareLevel(JSON.parse(fs.readFileSync(path.join(bundle, 'levels', c.lv + '.json'), 'utf8')));
	const field = RF.reachField(L);
	const ctx = NG.levelCtx(L, field, 1);
	const W = L.width, H = L.height, N = W * H;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const ds = NG.doorState(ctx, sim);
	const start = [Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4];
	const occ = new Uint8Array(N);
	let evalOcc = null, evalPath = null;
	for (const r of c.routes) {
		const ms = C.readEetas(path.join(bundle, 'routes', c.lv, r.name));
		const mine = r.eval ? new Uint8Array(N) : null, pth = r.eval ? new Uint32Array(ms.length + 1) : null;
		sim.reset();
		for (let t = 0; t <= ms.length; t++) {
			if (t > 0) { E.applyMask(inp, ms[t - 1]); sim.tick(inp); }
			const tl = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
			occ[tl] = 1;
			if (mine) { mine[tl] = 1; pth[t] = tl; }
		}
		if (mine) { evalOcc = mine; evalPath = pth; }
	}
	// the walk with every door open (the static one of reach.js, fifths of a tile -> tiles, 65535 = none)
	const sw = new Uint16Array(N);
	for (let i = 0; i < N; i++) { const v = field.walk[i]; sw[i] = v !== RF.CUT && v < 0xfffe ? Math.round(v / 5) : 65535; }
	fs.writeSync(out, JSON.stringify({ lv: c.lv, group: c.group, eval: c.routes.find((r) => r.eval) ? c.routes.find((r) => r.eval).eval : null, W, H, start,
		trophies: ctx.trophies.map((g) => [g % W, (g / W) | 0]), cls: b64(ds.cls), walk: b64(ds.walk), swalk: b64(sw), occ: b64(occ), evalOcc: evalOcc ? b64(evalOcc) : null,
		evalPath: evalPath ? b64(evalPath) : null }) + '\n');
	console.log(`${c.lv} (${c.group}) ${W}x${H}: ${occ.reduce((a, v) => a + v, 0)} route tiles, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
fs.closeSync(out);
