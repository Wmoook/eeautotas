'use strict';
// tools/cmp/fieldcost.js: what one goal field (types.js goalField -> reach.js reachField, the RCH3 field the executor's
// finders, the skeleton and the planner order by) costs on a level, as the compiler builds it: the level as the doors stand
// at the start (types.js levelNow), the start's effect state (types.js plainOf: with EEAT_FX_STATE=1 an effect-state field
// whose exits are seeded by the next state's fields, each a whole-level build of its own), for up to K triggers of the
// model; per goal the wall time, the reachField calls it took (the nested ones counted) and the bytes, and the memo's
// capacity there (types.js FIELDS_MB / the field's bytes).
//   node tools/cmp/fieldcost.js <level.eelvl>... [--k=4] [--defaults=1]   (one JSON line a level)
// --defaults=1: the compiler's default knobs first (src/plan/defaults.js), as src/compile.js runs.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
if (args.includes('--defaults=1')) { try { require(path.join(root, 'src/plan/defaults.js')).apply(); } catch (e) { /* none */ } }
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const RF = require(path.join(root, 'src/reach.js'));
const K = +((args.find((s) => s.startsWith('--k=')) || '--k=4').split('=')[1]);
let calls = 0, callMs = 0;
const rf0 = RF.reachField;
RF.reachField = function () { const t = Date.now(); calls++; try { return rf0.apply(this, arguments); } finally { callMs += Date.now() - t; } };
for (const file of args.filter((s) => !s.startsWith('--'))) {
	const r = { level: path.basename(file).replace(/\.eelvl$/, '') };
	try {
		const L = T.loadLevelFile(file);
		r.WH = `${L.width}x${L.height}`;
		const model = M.compileModel(L, { file });
		const r0 = T.playTo(L, new Uint8Array(0));
		const sim = r0.sim;
		const Lc = T.levelNow(L, sim);
		const pfx = T.plainOf(sim);
		r.plainFx = pfx && typeof pfx === 'object' ? `f${pfx.mj}.${pfx.jb}` : !!pfx;
		const trig = (model.triggers || []).slice(0, K);
		r.builds = [];
		for (const tr of trig) {
			const tiles = tr.tiles || [];
			if (!tiles.length) continue;
			calls = 0; callMs = 0;
			const t0 = Date.now();
			const f = T.goalField(Lc, tiles, { deaths: false, plainFx: pfx });
			const ms = Date.now() - t0;
			let b = 0;
			for (const k in f) { const a = f[k]; if (ArrayBuffer.isView(a)) b += a.byteLength; }
			r.builds.push({ label: tr.label, ms, calls, MB: Math.round(b / 1048576 * 10) / 10, mode: f.mode, fx: !!f.fx });
		}
		const mb = r.builds.length ? r.builds[0].MB : 0;
		r.memoFields = mb ? Math.max(8, Math.min(64, Math.floor(256 / mb))) : null;
		r.msMedian = r.builds.length ? r.builds.map((b) => b.ms).sort((a, b) => a - b)[r.builds.length >> 1] : null;
		r.callsMedian = r.builds.length ? r.builds.map((b) => b.calls).sort((a, b) => a - b)[r.builds.length >> 1] : null;
	} catch (e) { r.error = String(e && e.stack || e).slice(0, 300); }
	console.log(JSON.stringify(r));
}
