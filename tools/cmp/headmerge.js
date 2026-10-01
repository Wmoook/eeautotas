'use strict';
// THE WHOLE LONG-BUDGET SCOREBOARD from several runs (tools/cmp/headroom.js --json of each, e.g. the 900-s cycles of one
// n5-plan compiler, each on a part of the short scoreboard's misses): per level every run that had it (in the order
// given; the LAST run that had a level is its current row), then
//   the count: levels routed in their last run, and levels routed in ANY run (the compiler can, at this budget), each
//   also added to --base (the short budget's own count) out of --total;
//   per level the route rate (k of n runs) and the first-route times over the runs (speed work: CAN, just slowly);
//   the levels no run routed by their last run's class (RISING: time still buys triggers; FLAT; ZERO) = solver work;
//   the levels of the short scoreboard's misses that no run had (--want=<list file>: the misses, '#' comments).
//   node tools/cmp/headmerge.js <label>=<hr.json>[,<hr2.json>] ... [--base=50] [--total=230] [--want=<list>]
//                               [--md=<file>] [--json=<file>]
const fs = require('fs'), path = require('path');
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const base = +(arg('base') || 0), total = +(arg('total') || 0);
const runs = pos.map((s) => { const i = s.indexOf('='); return { label: s.slice(0, i), rows: s.slice(i + 1).split(',').filter(Boolean).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))) }; });
const lv = new Map();   // rel -> [{label, r}]
for (const run of runs) for (const r of run.rows) { if (!lv.has(r.rel)) lv.set(r.rel, []); lv.get(r.rel).push({ label: run.label, r }); }
const nm = (rel) => path.basename(rel, '.eelvl');
const med = (a) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const rows = [...lv.entries()].map(([rel, h]) => {
	const last = h[h.length - 1].r, ok = h.filter((x) => x.r.ok);
	return { rel, n: h.length, k: ok.length, last, lastLabel: h[h.length - 1].label, runs: h,
		firsts: ok.map((x) => x.r.first), bestTicks: ok.length ? Math.min(...ok.map((x) => x.r.runTicks)) : null,
		best: h.map((x) => x.r.best).find((b) => b) || null };
}).sort((a, b) => a.rel.localeCompare(b.rel));
const out = [];
const okLast = rows.filter((r) => r.last.ok), okAny = rows.filter((r) => r.k > 0);
out.push(`levels run: ${rows.length} (runs: ${runs.map((x) => `${x.label} ${x.rows.length}`).join(', ')})`);
out.push(`routed in the last run: ${okLast.length}` + (arg('base') ? ` -> ${base + okLast.length}${total ? ' / ' + total : ''}` : ''));
out.push(`routed in any run: ${okAny.length}` + (arg('base') ? ` -> ${base + okAny.length}${total ? ' / ' + total : ''}` : ''));
const kn = new Map();
for (const r of rows) { const key = `${r.k} of ${r.n}`; kn.set(key, (kn.get(key) || 0) + 1); }
out.push(`route rate (k of n runs): ${[...kn.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(', ')}`);
out.push(`SPEED WORK (${okAny.length}: routed in a run; the first route in each routed run, s):`);
for (const r of okAny.sort((a, b) => med(a.firsts) - med(b.firsts))) out.push(`  ${nm(r.rel)} ${r.k}/${r.n}: first ${[...r.firsts].sort((x, y) => x - y).map((t) => Math.round(t)).join(' / ')} s, best ${r.bestTicks}${r.best ? ` (${Math.round(r.bestTicks / r.best * 1000) / 1000} of ${r.best})` : ''}`);
const never = rows.filter((r) => r.k === 0);
out.push(`SOLVER WORK (${never.length}: no run routed), by the last run's class:`);
for (const c of ['RISING', 'FLAT', 'ZERO', 'KILLED']) {
	const a = never.filter((r) => r.last.cls === c);
	if (a.length) out.push(`  ${c.padEnd(6)} ${String(a.length).padStart(3)}: ${a.map((r) => `${nm(r.rel)} g${r.last.gEnd}`).join(', ')}`);
}
out.push(`first route (routed, each level's median over its runs): median ${med(okAny.map((r) => med(r.firsts)))} s; at 600 s or sooner in some run: ${okAny.filter((r) => Math.min(...r.firsts) <= 600).length}`);
if (arg('want')) {
	const want = fs.readFileSync(arg('want'), 'utf8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter(Boolean);
	const miss = want.filter((w) => !lv.has(w));
	out.push(`the list's levels no run had: ${miss.length} of ${want.length}${miss.length ? ': ' + miss.map(nm).join(', ') : ''}`);
}
console.log(out.join('\n'));
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows.map((r) => ({ rel: r.rel, n: r.n, k: r.k, lastLabel: r.lastLabel, cls: r.last.cls, ok: r.last.ok, firsts: r.firsts, bestTicks: r.bestTicks, best: r.best, gEnd: r.last.gEnd })), null, 1));
if (arg('md')) {
	const labels = runs.map((x) => x.label);
	const cell = (x) => !x ? '' : x.r.ok ? `**${x.r.runTicks.toLocaleString('en-US')}** @${Math.round(x.r.first)} s` : `g${x.r.gEnd} ${x.r.cls}`;
	const md = [`| level | k / n | ${labels.join(' | ')} | best known |`, `|---|---|${labels.map(() => '---|').join('')}---|`];
	const ord = (r) => (r.k > 0 ? 0 : r.last.cls === 'RISING' ? 1 : r.last.cls === 'FLAT' ? 2 : 3);
	for (const r of [...rows].sort((a, b) => ord(a) - ord(b) || b.k / b.n - a.k / a.n || (med(a.firsts) ?? 0) - (med(b.firsts) ?? 0) || b.last.gEnd - a.last.gEnd || a.rel.localeCompare(b.rel)))
		md.push(`| ${nm(r.rel)} | ${r.k} / ${r.n} | ${labels.map((l) => cell(r.runs.find((x) => x.label === l))).join(' | ')} | ${r.best ? r.best.toLocaleString('en-US') : '-'} |`);
	fs.writeFileSync(arg('md'), md.join('\n') + '\n');
}
