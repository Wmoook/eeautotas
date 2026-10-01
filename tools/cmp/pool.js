'use strict';
// THE RUNS POOLED: several runs of the same compiler (full compiles, second runs, A/B arms) per level, so a flip is told
// from the spread: per level and arm the runs that compiled (k / n) and the run ticks, the arm's expected count (the sum
// of its levels' compile rates over the levels it ran) and the levels whose rate differs between two arms.
//   node tools/cmp/pool.js --run=<arm>:<file | full-compile dir>... [--levels=<list of rel paths>] [--md=<out>] [--json=<out>]
//        [--cmp=<armA>,<armB>] (the levels where the two arms' rates differ, both ran them)
// A file is a JSON array or jsonl of {rel, ok, runTicks} (summ.js / score.js rows); a dir is a fullc.js output dir
// (index.jsonl + <id>.json: ok and runTicks > 0; a level run twice (a RAM-guard requeue) counts its last row).
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const arg = (k) => (args.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const argsAll = (k) => args.filter((a) => a.startsWith('--' + k + '=')).map((a) => a.slice(k.length + 3));
const readRows = (f) => {
	const s = fs.readFileSync(f, 'utf8').trim();
	return s.startsWith('[') ? JSON.parse(s) : s.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};
function runOf(src) {
	const out = new Map();
	if (fs.statSync(src).isDirectory()) {
		const seen = new Map();
		for (const ix of readRows(path.join(src, 'index.jsonl'))) seen.set(ix.rel, ix);
		for (const ix of seen.values()) {
			let r = null;
			try { r = JSON.parse(fs.readFileSync(path.join(src, ix.id + '.json'), 'utf8')); } catch (e) { r = null; }
			out.set(ix.rel, r && r.ok && r.runTicks > 0 ? r.runTicks : null);
		}
	} else for (const r of readRows(src)) out.set(r.rel, r.ok && r.runTicks > 0 ? r.runTicks : null);
	return out;
}
const arms = new Map();   // arm -> [{name, rows}]
for (const s of argsAll('run')) {
	const i = s.indexOf(':'), arm = s.slice(0, i), f = s.slice(i + 1);
	if (!arms.has(arm)) arms.set(arm, []);
	arms.get(arm).push({ name: path.basename(f), rows: runOf(f) });
}
const want = arg('levels') ? new Set(fs.readFileSync(arg('levels'), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) : null;
const rels = new Set();
for (const runs of arms.values()) for (const r of runs) for (const rel of r.rows.keys()) if (!want || want.has(rel)) rels.add(rel);
const nm = (rel) => path.basename(rel, '.eelvl');
const rows = [];
for (const rel of [...rels].sort()) {
	const row = { rel };
	for (const [arm, runs] of arms) {
		const ran = runs.filter((r) => r.rows.has(rel)), ok = ran.filter((r) => r.rows.get(rel) !== null);
		row[arm] = { k: ok.length, n: ran.length, ticks: ok.map((r) => r.rows.get(rel)) };
	}
	rows.push(row);
}
const L = [];
L.push('| arm | runs | levels run | compiled (sum of runs) | expected count (sum of rates) | in every run | in any run |', '|---|---|---|---|---|---|---|');
for (const [arm, runs] of arms) {
	const ran = rows.filter((r) => r[arm].n > 0);
	L.push(`| ${arm} | ${runs.length} | ${ran.length} | ${ran.reduce((s, r) => s + r[arm].k, 0)} | ${ran.reduce((s, r) => s + r[arm].k / r[arm].n, 0).toFixed(1)} | ${ran.filter((r) => r[arm].k === r[arm].n).length} | ${ran.filter((r) => r[arm].k > 0).length} |`);
}
L.push('');
const cmp = arg('cmp') ? arg('cmp').split(',') : null;
if (cmp) {
	const [a, b] = cmp;
	const both = rows.filter((r) => r[a] && r[b] && r[a].n > 0 && r[b].n > 0);
	const diff = both.filter((r) => r[a].k / r[a].n !== r[b].k / r[b].n).sort((x, y) => (y[a].k / y[a].n - y[b].k / y[b].n) - (x[a].k / x[a].n - x[b].k / x[b].n));
	L.push(`## ${a} vs ${b}: ${both.length} levels both ran, ${diff.length} with another rate`, '');
	L.push(`| level | ${a} | ${b} | ${a} ticks | ${b} ticks |`, '|---|---|---|---|---|');
	for (const r of diff) L.push(`| ${nm(r.rel)} | ${r[a].k} / ${r[a].n} | ${r[b].k} / ${r[b].n} | ${r[a].ticks.join(', ') || '-'} | ${r[b].ticks.join(', ') || '-'} |`);
	L.push('');
}
const md = L.join('\n') + '\n';
if (arg('md')) fs.writeFileSync(arg('md'), md);
if (arg('json')) fs.writeFileSync(arg('json'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(md);
