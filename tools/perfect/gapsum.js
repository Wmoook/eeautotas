'use strict';
// THE GAP TABLE: a gap report (tools/perfect/gaprep.js jsonl) with the exhaustive proven lower bounds folded in
// (a JSON map {"<set>__<level name>": lb}: the closed C contours of wholepar.js / bfsprove.js), the proven routes (gap 0),
// the median gap, the least gaps, and the routes at or under the best known.
//   node tools/perfect/gapsum.js <gap.jsonl> [--ex=<lbs.json>] [--top=16] [--out=<table.jsonl>]
const fs = require('fs');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const EX = args.ex ? JSON.parse(fs.readFileSync(args.ex, 'utf8')) : {};
const seen = new Map();
for (const r of rows) seen.set(r.level, r);
const out = [];
for (const r of seen.values()) {
	const ex = +EX[r.level] || 0;
	const lb = Math.max(r.lb, ex);
	const gap = r.run - lb;
	out.push({ level: r.level, run: r.run, lbOld: r.oldLb, lbRoute: r.newLb, lbEx: ex || null, lb, gap, pct: Math.round(1000 * gap / r.run) / 10, known: r.known, proven: gap <= 0 });
}
out.sort((a, b) => a.pct - b.pct);
const pcts = out.map((r) => r.pct).sort((a, b) => a - b);
const med = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
const withKnown = out.filter((r) => r.known);
console.log(JSON.stringify({ n: out.length, proven: out.filter((r) => r.proven).map((r) => r.level), medianGapPct: med, routelbRaises: out.filter((r) => r.lbRoute > r.lbOld).length,
	withKnown: withKnown.length, atOrUnderKnown: withKnown.filter((r) => r.run <= r.known).map((r) => r.level.replace(/^[a-z0-9]+__/, '') + ' ' + r.run + '/' + r.known) }));
for (const r of out.slice(0, +args.top || 16)) console.log(`${r.level.padEnd(48)} run ${String(r.run).padStart(6)} lb ${String(r.lb).padStart(5)} (compile ${r.lbOld}, route ${r.lbRoute}, exh ${r.lbEx || '-'}) gap ${r.gap} = ${r.pct}%  known ${r.known || '-'}`);
if (args.out) fs.writeFileSync(args.out, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
