'use strict';
// THE COMPARISON with the best known TAS (n5-perfect): per level, our compiled route vs the fastest known route, both
// replayed by the engine from the level file; the trigger orders side by side (truthset.routeEvents / orderOf) and, for
// the triggers both routes take, the tick each reaches it: where the known route gains its ticks (a different order /
// a different trigger set, or the same order with faster legs: the per-leg difference).
//   node tools/perf/cmpknown.js <best_known.json> <root> <level key>=<route.eetas> ... [--json]
// root: the checkout with src/out/god/levels and the known routes (READ ONLY).
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');
const TS = require('../../src/plan/truthset.js');

const args = process.argv.slice(2);
const json = args.includes('--json');
const [bkFile, root, ...pairs] = args.filter((a) => !a.startsWith('--'));
const bk = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
let LW = 1;
const tileStr = (t) => (typeof t === "number" ? `${t % LW},${Math.floor(t / LW)}` : "?");
const keyOf = (e) => `${e.feat}@${tileStr(e.tile)}`;
const showOf = (e) => `${keyOf(e)}=${e.value}:${e.tick}`;
const lvFile = (key) => {
	const [set, f] = key.split('/');
	const dir = set === 'd4' ? path.join(root, 'src', 'out', 'd4', 'levels') : path.join(root, 'src', 'out', 'god', 'levels', set);
	return path.join(dir, f);
};
const rows = [];
for (const p of pairs) {
	const i = p.lastIndexOf('=');
	const key = p.slice(0, i), ours = p.slice(i + 1);
	const L = T.loadLevelFile(lvFile(key)); LW = L.width;
	const om = C.readEetas(ours);
	const oe = TS.routeEvents(L, om);
	const row = { level: key, ours: oe.runTicks, oursComplete: oe.complete };
	const k = bk[key];
	if (k) {
		let KL = L;
		if (k.source === 'job') { const tr = TS.loadTruth({ jobId: 'x', route: path.join(root, k.route), levelFile: lvFile(key) }); if (tr) KL = tr.L; }
		const km = C.readEetas(path.join(root, k.route));
		const ke = TS.routeEvents(KL, km);
		row.known = ke.runTicks; row.ratio = +(oe.runTicks / ke.runTicks).toFixed(3);
		const oo = TS.orderOf(oe.events), ko = TS.orderOf(ke.events);
		row.oursOrder = oo.map(showOf);
		row.knownOrder = ko.map(showOf);
		const oset = new Set(oo.map(keyOf)), kset = new Set(ko.map(keyOf));
		row.onlyOurs = [...oset].filter((x) => !kset.has(x)); row.onlyKnown = [...kset].filter((x) => !oset.has(x));
		const a = oo.map(keyOf).filter((x) => kset.has(x)), b = ko.map(keyOf).filter((x) => oset.has(x));
		const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
		for (let x = 1; x <= a.length; x++) for (let y = 1; y <= b.length; y++) dp[x][y] = a[x - 1] === b[y - 1] ? dp[x - 1][y - 1] + 1 : Math.max(dp[x - 1][y], dp[x][y - 1]);
		row.common = a.length; row.sameOrder = dp[a.length][b.length];
		const kt = new Map(); for (const e of ko) if (!kt.has(keyOf(e))) kt.set(keyOf(e), e.tick);
		let prevD = 0; row.legs = [];
		for (const e of oo) { const kk = keyOf(e); if (!kt.has(kk)) continue; const d = e.tick - kt.get(kk); row.legs.push({ t: kk, ours: e.tick, known: kt.get(kk), d, dd: d - prevD }); prevD = d; }
		row.endD = oe.runTicks - ke.runTicks;
	}
	rows.push(row);
	if (!json) {
		console.log(`\n== ${key}: ours ${row.ours} known ${row.known} ratio ${row.ratio} | triggers ours ${row.oursOrder ? row.oursOrder.length : '?'} known ${row.knownOrder ? row.knownOrder.length : '?'} common ${row.common} in same order ${row.sameOrder}`);
		if (row.onlyOurs && row.onlyOurs.length) console.log(`  only ours: ${row.onlyOurs.join(' ')}`);
		if (row.onlyKnown && row.onlyKnown.length) console.log(`  only known: ${row.onlyKnown.join(' ')}`);
		if (row.oursOrder) console.log(`  ours : ${row.oursOrder.join(' ')}`);
		if (row.knownOrder) console.log(`  known: ${row.knownOrder.join(' ')}`);
	}
}
if (json) console.log(JSON.stringify(rows));
// --sum: one line a level: the triggers only ours / only the known route takes, the common ones in the same order, and
// the three legs where the known route gains the most (per common trigger in our order: the growth of the difference)
if (args.includes('--sum')) {
	for (const r of rows) {
		if (!r.known) { console.log(`${r.level.padEnd(48)} ${r.ours} (no known route)`); continue; }
		const top = (r.legs || []).slice().sort((a, b) => b.dd - a.dd).slice(0, 3).map((l) => `${l.t} +${l.dd}`).join(', ');
		console.log(`${r.level.padEnd(48)} ${r.ours} vs ${r.known} (${r.ratio}) only ours ${(r.onlyOurs || []).length}, only known ${(r.onlyKnown || []).length}, common ${r.common} (${r.sameOrder} in order) | the known gains most: ${top} | after the last common trigger ${r.legs && r.legs.length ? r.endD - r.legs[r.legs.length - 1].d : r.endD}`);
	}
}
