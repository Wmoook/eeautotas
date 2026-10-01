'use strict';
// Two long-budget scoreboards side by side (tools/cmp/headroom.js --json of each; e.g. the 900-s scoreboard of one
// n5-plan commit vs the cycle before): per level that BOTH ran, the headroom class before -> now, the first verified
// route and the run ticks; levels routed only before / only now; the both-routed run ticks (sum, faster / slower);
// the progress (triggers at the end) of the levels neither routed.
//   node tools/cmp/headdiff.js <now.json> <before.json>[,<before2.json> ...] [--md=<file>]
// (several 'before' files merge: e.g. a campaign half and a hard half of one scoreboard)
const fs = require('fs'), path = require('path');
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const load = (fl) => new Map(fl.split(',').filter(Boolean).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).map((r) => [r.rel, r]));
const now = load(pos[0]), before = load(pos[1]);
const nm = (rel) => path.basename(rel, '.eelvl');
const both = [...now.keys()].filter((k) => before.has(k)).sort();
const onlyNow = [...now.keys()].filter((k) => !before.has(k)).sort();
const out = [], md = [];
const okN = both.filter((k) => now.get(k).ok), okB = both.filter((k) => before.get(k).ok);
const okBoth = both.filter((k) => now.get(k).ok && before.get(k).ok);
out.push(`ran in both: ${both.length}; routed now ${okN.length}, before ${okB.length}, both ${okBoth.length}` + (onlyNow.length ? `; ran only now: ${onlyNow.length} (routed ${onlyNow.filter((k) => now.get(k).ok).length})` : ''));
const gained = both.filter((k) => now.get(k).ok && !before.get(k).ok), lost = both.filter((k) => !now.get(k).ok && before.get(k).ok);
const r1 = (r) => `${r.runTicks} @${r.first}s`;
out.push(`  routed only now (${gained.length}): ${gained.map((k) => `${nm(k)} ${r1(now.get(k))} (before ${before.get(k).cls} g${before.get(k).gEnd})`).join(', ') || '-'}`);
out.push(`  routed only before (${lost.length}): ${lost.map((k) => `${nm(k)} ${r1(before.get(k))} (now ${now.get(k).cls} g${now.get(k).gEnd})`).join(', ') || '-'}`);
if (okBoth.length) {
	const sN = okBoth.reduce((s, k) => s + now.get(k).runTicks, 0), sB = okBoth.reduce((s, k) => s + before.get(k).runTicks, 0);
	const fa = okBoth.filter((k) => now.get(k).runTicks < before.get(k).runTicks).length, sl = okBoth.filter((k) => now.get(k).runTicks > before.get(k).runTicks).length;
	const geo = Math.exp(okBoth.reduce((s, k) => s + Math.log(now.get(k).runTicks / before.get(k).runTicks), 0) / okBoth.length);
	const ft = okBoth.filter((k) => now.get(k).first < before.get(k).first).length, lt = okBoth.filter((k) => now.get(k).first > before.get(k).first).length;
	out.push(`  both routed (${okBoth.length}): run ticks ${sN} vs ${sB} (${(((sN - sB) / sB) * 100).toFixed(1)}%), faster ${fa} / slower ${sl}, geo ${geo.toFixed(3)}; first route sooner ${ft} / later ${lt}`);
}
const none = both.filter((k) => !now.get(k).ok && !before.get(k).ok);
if (none.length) {
	const gN = none.reduce((s, k) => s + (now.get(k).gEnd || 0), 0), gB = none.reduce((s, k) => s + (before.get(k).gEnd || 0), 0);
	const up = none.filter((k) => (now.get(k).gEnd || 0) > (before.get(k).gEnd || 0)).length, dn = none.filter((k) => (now.get(k).gEnd || 0) < (before.get(k).gEnd || 0)).length;
	out.push(`  routed in neither (${none.length}): triggers at the end ${gN} vs ${gB}, more ${up} / fewer ${dn} / same ${none.length - up - dn}`);
	const cls = {};
	for (const k of none) { const c = `${before.get(k).cls}->${now.get(k).cls}`; cls[c] = (cls[c] || 0) + 1; }
	out.push(`  class before->now: ${Object.entries(cls).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`);
}
console.log(out.join('\n'));
if (arg('md')) {
	md.push('| level | class before -> now | first route s before / now | run ticks before / now | gain at the end before / now |', '|---|---|---|---|---|');
	for (const k of [...both, ...onlyNow]) {
		const n = now.get(k), b = before.get(k);
		md.push(`| ${k.replace(/\.eelvl$/, '')} | ${b ? b.cls : '(not run)'} -> ${n.cls} | ${b ? (b.first ?? '-') : '-'} / ${n.first ?? '-'} | ${b ? (b.runTicks ?? '-') : '-'} / ${n.runTicks ?? '-'} | ${b ? b.gEnd : '-'} / ${n.gEnd} |`);
	}
	fs.writeFileSync(arg('md'), md.join('\n') + '\n');
}
