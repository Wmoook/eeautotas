'use strict';
// THE ORDERS SIDE BY SIDE (P4 gated): two routes of one level (ours: a compile's / the chain's; theirs: the best known), each
// replayed from the level file, their trigger orders (orderoracle.js routeTriggers: the model's triggers by the touched tile,
// the trophy last) and how they agree: the longest common subsequence of the two orders, the triggers only one takes, the
// first place they part, and each route's run ticks. "Do our orders match or beat theirs?"
//   node tools/cmp/ordercmp.js <level.eelvl> <ours.eetas> <theirs.eetas> [--json]   (one JSON line with --json)
const path = require('path');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'src/plan/defaults.js')).apply();
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const { routeTriggers } = require('./orderoracle.js');

function lcs(a, b) {
	const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
	return d[n][m];
}
function compare(file, oursF, theirsF) {
	const L = T.loadLevelFile(file);
	const M = MD.compileModel(L);
	const one = (f) => {
		const m = C.readEetas(f);
		const ev = C.evaluate(L, m, false);
		if (!ev) return null;
		const evs = routeTriggers(L, M, m.subarray(0, ev.complete), ev.complete);
		return { runTicks: ev.runTicks, deaths: ev.deaths, order: evs.map((e) => (e.trig < 0 ? 'trophy' : e.label)), ids: evs.map((e) => (e.trig < 0 ? 'T' : String(e.trig))) };
	};
	const a = one(oursF), b = one(theirsF);
	if (!a || !b) return { level: path.basename(file, '.eelvl'), error: !a ? 'ours does not finish' : 'theirs does not finish' };
	const common = lcs(a.ids, b.ids);
	let part = 0; while (part < a.ids.length && part < b.ids.length && a.ids[part] === b.ids[part]) part++;
	const sa = new Set(a.ids), sb = new Set(b.ids);
	return {
		level: path.basename(file, '.eelvl'), ours: a.runTicks, theirs: b.runTicks, ratio: Math.round(1000 * a.runTicks / b.runTicks) / 1000,
		oursN: a.ids.length, theirsN: b.ids.length, lcs: common, sameFirst: part, onlyOurs: a.order.filter((x, i) => !sb.has(a.ids[i])), onlyTheirs: b.order.filter((x, i) => !sa.has(b.ids[i])),
		oursOrder: a.order, theirsOrder: b.order,
	};
}
module.exports = { compare, lcs };
if (require.main === module) {
	const pos = process.argv.slice(2).filter((s) => !s.startsWith('--'));
	const r = compare(pos[0], pos[1], pos[2]);
	if (process.argv.includes('--json')) console.log(JSON.stringify(r));
	else {
		console.log(`${r.level}: ours ${r.ours} vs theirs ${r.theirs} run ticks (${r.ratio}); orders ${r.oursN} / ${r.theirsN} triggers, common ${r.lcs} in order, the same first ${r.sameFirst}`);
		console.log(`  only ours:   ${(r.onlyOurs || []).join(', ')}`);
		console.log(`  only theirs: ${(r.onlyTheirs || []).join(', ')}`);
		console.log(`  ours:   ${(r.oursOrder || []).join(' > ')}`);
		console.log(`  theirs: ${(r.theirsOrder || []).join(' > ')}`);
	}
}
