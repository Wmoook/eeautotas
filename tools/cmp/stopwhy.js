'use strict';
// THE STOP VS THE KNOWN ROUTE (B8 hard, cycle 5): a compile log's last progress, its last distinct failing step labels
// (time, anchor, rung, why, closest) and for each whether the KNOWN ROUTE ever stands on that trigger's tiles (and the tick
// it first does): a compile stuck on targets the known route never takes (Stupid Fox's coins (61,58) / (102,72), Egg Quest
// II base's blue coin (182,197), Are You A God's red key (174,104)) is a planner / order question, one stuck on the route's
// own targets a leg question (tools/cmp/krt.js from the route's states). With ORDER=1 also the route's trigger order and
// the compile's found steps. Reads only: the level, the route, the log.
//   node tools/cmp/stopwhy.js <level.eelvl> <route.eetas | -> <compile.log> [--n=8]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const TS = require(path.join(root, 'src/plan/truthset.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const [lv, rf, logf] = argv.filter((s) => !s.startsWith('--'));
if (!lv || !rf || !logf) { console.error('usage: node tools/cmp/stopwhy.js <level.eelvl> <route.eetas | -> <compile.log> [--n=8]'); process.exit(2); }
const nShow = +opt('n', 8) || 8;
const L = T.loadLevelFile(lv), W = L.width, H = L.height;
const M = MD.compileModel(L);
const ev = fs.readFileSync(logf, 'utf8').split('\n').filter((s) => s.startsWith('{')).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
let prog = null;
for (const e of ev) if (e.ev === 'progress') prog = e;
const steps = ev.filter((e) => e.ev === 'step');
const fails = steps.filter((e) => !e.ok);
const lastBy = new Map();
for (const e of fails) lastBy.set(e.label, e);
const lastLabels = [...lastBy.values()].sort((a, b) => b.t - a.t).slice(0, nShow);
const norm = (s) => String(s).replace(/ x\d+$/, '').replace(/ \(any of \d+\)$/, '');
// (the route's first tick on every tile it stands on)
let first = null, nTrig = null, runTicks = null;
if (rf !== '-') {
	const masks = C.readEetas(rf);
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	first = new Map();
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31); sim.tick(inp);
		const tl = T.tileOf(sim, W, H);
		if (!first.has(tl)) first.set(tl, t + 1);
		if (sim.has_silver_crown) break;
	}
	const R = TS.routeEvents(L, masks);
	const O = TS.orderOf(R.events);
	nTrig = O.length; runTicks = R.runTicks;
	if (process.env.ORDER) console.log('   route order: ' + O.map((s) => `${s.feat}=${s.value}@${s.tick}(${s.tile % W},${(s.tile / W) | 0})`).join(' '));
}
if (process.env.ORDER) console.log('   compile finds: ' + steps.filter((e) => e.ok).map((e) => `${e.label}@${Math.round(e.t)}s/a${e.anchor}`).join(', '));
console.log(`== ${path.basename(lv)} compile: triggers ${prog ? prog.triggers : '?'} tick ${prog ? prog.tick : '?'} steps ${steps.length} (fails ${fails.length}); known route ${runTicks} ticks, ${nTrig} triggers`);
for (const e of lastLabels) {
	const X = M.triggers.find((x) => norm(x.label) === norm(e.label));
	let on = '';
	if (first && X) {
		let tk = Infinity;
		for (const t of X.tiles) if (first.has(t) && first.get(t) < tk) tk = first.get(t);
		on = Number.isFinite(tk) ? `route takes it at tick ${tk}` : 'ROUTE NEVER TAKES IT';
	} else if (first) on = e.label === 'trophy' ? 'trophy' : '(no model trigger)';
	const cl = e.closest && e.closest.dist >= 0 ? `closest ${e.closest.dist} at (${e.closest.tile % W},${(e.closest.tile / W) | 0})` : '';
	console.log(`   t ${e.t} a${e.anchor} '${e.label}' r${e.rung} ${e.why || ''} ${cl} | ${on}`);
}
