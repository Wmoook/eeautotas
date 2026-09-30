'use strict';
// Sums tools/n4u/modelexact.js's jsonl shards -> modelexact.md (the mismatch classes over all routes, their routes and
// events, examples; the usage table; the bound's tightness). node tools/n4u/modelexact_sum.js [--dir=<out dir>]
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const dir = arg('dir', path.join(REPO, 'src', 'out', 'n4plan', 'understand', 'semantics'));
const rows = [];
for (const f of fs.readdirSync(dir).filter((f) => /^modelexact_.*\.jsonl$/.test(f))) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
const ok = rows.filter((r) => !r.stale && !r.error), stale = rows.filter((r) => r.stale), err = rows.filter((r) => r.error);
const norm = (k) => k.replace(/ \[(near|all)\]$/, '').replace(/: \d+ \((coins|bcoins|key\d|psw:\d+|osw:\d+|team|crown|open|static|time|prot)( gate)?\)/, (m) => m).replace(/\(deaths \d+ vs \d+\)/, '(deaths < param)').replace(/\(\d+ tiles\)/, '(n tiles)');
const C = new Map();
for (const r of ok) for (const [k0, v] of Object.entries(r.cls)) {
	const k = norm(k0);
	let c = C.get(k);
	if (!c) { c = { k, routes: new Set(), levels: new Set(), n: 0, ex: [] }; C.set(k, c); }
	c.routes.add(r.route); c.levels.add(r.name); c.n += v;
	if (c.ex.length < 3) c.ex.push(`${r.name} ${JSON.stringify(r.ex[k0][0])}`);
}
const U = new Map();
let ticks = 0;
for (const r of ok) { ticks += r.ticks; for (const [k, v] of Object.entries(r.use)) { const u = U.get(k) || { n: 0, routes: 0 }; u.n += v; u.routes++; U.set(k, u); } }
const lbC = ok.reduce((s, r) => s + r.lbChecks, 0), lbV = ok.reduce((s, r) => s + r.lbViol, 0);
const ratios = ok.filter((r) => r.lbRatioMean !== null).map((r) => r.lbRatioMean).sort((a, b) => a - b);
const L = [`# T-MODEL-EXACT: model.js (origin/n4plan-planner) vs the engine on ${ok.length} known routes (${new Set(ok.map((r) => r.name)).size} levels, ${ticks} ticks)`, '',
	`stale routes (do not finish): ${stale.length}; errors: ${err.length}${err.length ? ' (' + err.map((r) => r.name + ': ' + r.error.split('\n')[0]).join('; ') + ')' : ''}`,
	`routes with no mismatch at all: ${ok.filter((r) => !Object.keys(r.cls).length).length}; with an UNSOUND class: ${ok.filter((r) => Object.keys(r.cls).some((k) => k.startsWith('UNSOUND'))).length}`,
	`pairLb between consecutive state changes: ${lbC} legs checked, ${lbV} above the route's ticks; mean lb / ticks per route: median ${ratios[ratios.length >> 1]}, p10 ${ratios[Math.floor(ratios.length * 0.1)]}, p90 ${ratios[Math.floor(ratios.length * 0.9)]}`, '',
	'| class | routes | levels | events | examples (level {tick, tile, ...}) |', '|---|---|---|---|---|'];
for (const c of [...C.values()].sort((a, b) => (b.k.startsWith('UNSOUND') - a.k.startsWith('UNSOUND')) || b.routes.size - a.routes.size || b.n - a.n)) L.push(`| ${c.k} | ${c.routes.size} | ${c.levels.size} | ${c.n} | ${c.ex.join('<br>')} |`);
L.push('', `## Usage: ticks of the ${ok.length} routes (${ticks} ticks) with each effect / medium`, '', '| what | ticks | % of all | routes |', '|---|---|---|---|');
for (const [k, u] of [...U.entries()].sort((a, b) => b[1].routes - a[1].routes)) L.push(`| ${k} | ${u.n} | ${(100 * u.n / ticks).toFixed(2)} | ${u.routes} |`);
fs.writeFileSync(path.join(dir, 'modelexact.md'), L.join('\n') + '\n');
console.log(L.slice(0, 6).join('\n'));
console.log(`classes ${C.size}`);
