'use strict';
// report.js <agg.jsonl> [<verify.txt>]: the race table (markdown) from agg.js's lines + the earlier data (AB.jsonl: the compiler
// at 300 s; relab results.jsonl: the search at 300 s), read from the main checkout (read only)
const fs = require('fs');
const MAIN = 'C:/Users/super/eeautotas/src/out';
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = lines(process.argv[2]);
const ab = new Map(lines(`${MAIN}/n5/lasthour/ship/AB.jsonl`).map((r) => [r.rel, r]));
const rl = new Map();
for (const r of lines(`${MAIN}/d4/relab/box3/results.jsonl`)) if (r.arm === 'main') rl.set(r.file, r);
const cat = (i) => (i < 4 ? 'neither' : i < 10 ? 'search only' : 'compiler');
const f = (x) => (x == null ? '-' : typeof x === 'number' ? (Number.isInteger(x) ? x.toLocaleString('en-US') : String(Math.round(x * 10) / 10)) : String(x));
const out = [];
out.push('| # | level | set | hybrid: first route (by, s, ticks) | compiler first (s, ticks) | search first (s, ticks) | hybrid final (by) | polish first -> final | search alone 600 s: first (s, ticks) / final | earlier: compiler 300 s / search 300 s first s | best known |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|');
const sum = { routed: 0, base: 0, firstH: [], firstB: [], pairs: [] };
rows.forEach((r, i) => {
	const h = r.hy || {}, b = r.base || {}, a = ab.get(r.rel), s = rl.get(r.rel.split('/').pop());
	const first = h.first ? `${h.first.by}, ${f(h.first.t)}, ${f(h.first.runTicks)}` : 'none';
	const cf = h.cFirst ? `${f(h.cFirst.t)}, ${f(h.cFirst.runTicks)}` : '-';
	const sf = h.sFirst ? `${f(h.sFirst.t)}, ${f(h.sFirst.runTicks)}` : '-';
	const fin = h.final ? `**${f(h.final.runTicks)}** (${h.final.by}${h.final.verified ? '' : ', NOT verified'})` : '-';
	const pol = h.polish ? `${f(h.polish.before)} -> ${f(h.polish.after)} (-${f(Math.round((1 - h.polish.ratio) * 1000) / 10)}%)` : '-';
	const base = b.first != null ? `${f(b.first)}, ${f(b.firstTicks)} / ${f(b.final)}` : b.nearest != null ? `none (nearest ${f(b.nearest)} tiles)` : (r.base ? 'none' : 'not run');
	const comp300 = a ? (a.A.compiled || a.B.compiled ? f(Math.min(a.A.ticks || 1e9, a.B.ticks || 1e9)) : 'none') : '-';
	const s300 = s ? (s.routed ? f(s.firstRouteS) : 'none') : '-';
	const known = a && a.best ? f(a.best) : '-';
	out.push(`| ${i + 1} | ${r.id} | ${cat(i)} | ${first} | ${cf} | ${sf} | ${fin} | ${pol} | ${base} | ${comp300} / ${s300} | ${known} |`);
	if (h.first) { sum.routed++; sum.firstH.push(h.first.t); }
	if (b.first != null) { sum.base++; sum.firstB.push(b.first); }
	if (h.first && b.first != null) sum.pairs.push({ id: r.id, h: h.first.t, b: b.first, hf: h.final ? h.final.runTicks : null, bf: b.final });
});
console.log(out.join('\n'));
console.log('');
console.log(JSON.stringify(sum));
