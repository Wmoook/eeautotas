'use strict';
// tools/stats-import.js: imports a results table of a whole level set (the hybrid's CSV format: section, level, hybrid
// result, time to solve (s), first route came from, best route time, which run, best known TAS, search alone, compiler
// alone, identical copies merged) as a benchmark of the app's Stats page (docs/ui/DESIGN.md 10.2, 11.6). The table is
// copied into the app's data folder, <data>/benchmarks/<id>.json (src/data/benchmarks/ in the repo, never in git;
// %LOCALAPPDATA%\EEAutoTAS\data\benchmarks\ for EEAutoTAS.exe), and shows up under Stats > Benchmarks.
//
// usage: node tools/stats-import.js <file.csv> [--name="Hybrid, 220 test levels"] [--id=<slug>] [--json]
//        node tools/stats-import.js --list
//        node tools/stats-import.js --remove=<id>
//        (EEAutoTAS.exe tools/stats-import.js <file.csv> with the exe)
// The columns are found by their titles (case-insensitive); unknown columns are kept per row. A line whose first cell
// says "TITLE: n of m ..." names that section (its counts are recomputed from the rows). An existing id is replaced.
const fs = require('fs');
const path = require('path');
const C = require('../src/common.js');
const ST = require('../src/stats.js');

function fmtS(s) {
	if (!Number.isFinite(s)) return '-';
	s = Math.round(s);
	return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')} min`;
}
function summaryText(b, file) {
	const n = ST.benchNumbers(b);
	const L = [];
	L.push(`${b.name} (${b.id}): ${n.levels} levels from ${b.source || 'the table'}`);
	L.push(`  ${n.routed} of ${n.levels} routed (${n.confirmed} confirmed${n.unconfirmed ? `, ${n.unconfirmed} not confirmed` : ''})`);
	for (const s of n.sections) L.push(`  ${s.title}: ${s.routed} of ${s.total} routed`);
	if (n.compare.hasSearch || n.compare.hasCompiler) {
		L.push(`  search alone ${n.compare.search}, compiler alone ${n.compare.compiler}, either alone ${n.compare.either}, only the hybrid ${n.compare.onlyHybrid}`);
	}
	const by = Object.entries(n.by).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
	if (by) L.push(`  first route by: ${by}`);
	if (n.solve.n) {
		L.push(`  time to solve: ${n.solve.bins.map((x) => x.n).join(', ')} (${n.solve.bins.map((x) => x.label).join(' / ')})`);
		L.push(`  median ${fmtS(n.solve.median)} (${n.solve.median} s), 90% by ${fmtS(n.solve.p90)} (${n.solve.p90} s), the longest ${fmtS(n.solve.max)} (${n.solve.max} s)`);
	}
	if (n.quality.known) L.push(`  with a best known TAS ${n.quality.known}: at or under it ${n.quality.under}, within 10% ${n.quality.within10}, median ${n.quality.median.toFixed(3)} x the best known`);
	if (file) L.push(`  saved: ${file}`);
	return L.join('\n');
}

function main(argv) {
	const a = C.parseArgs(argv);
	const dir = a.dir ? path.resolve(a.dir) : ST.BENCH_DIR;   // --dir: tests
	if (a.list) {
		const l = ST.listBenchmarks(dir);
		if (a.json) { console.log(JSON.stringify(l)); return 0; }
		if (!l.length) { console.log(`no benchmarks yet in ${dir}`); return 0; }
		for (const b of l) console.log(`${b.id}\t${b.name}\t${b.routed} of ${b.levels} routed\t${new Date(b.imported).toISOString().slice(0, 16).replace('T', ' ')}\t${b.source || ''}`);
		return 0;
	}
	if (a.remove) {
		const id = String(a.remove);
		if (!ST.removeBenchmark(id, dir)) { console.error(`no benchmark "${id}" in ${dir} (--list shows them)`); return 1; }
		console.log(`removed ${id}`);
		return 0;
	}
	const file = a._[0];
	if (!file || a.help || a.h) {
		console.log('usage: node tools/stats-import.js <file.csv> [--name="..."] [--id=<slug>] [--json] | --list | --remove=<id>');
		return file || a.help || a.h ? 0 : 1;
	}
	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 1; }
	let b;
	try { b = ST.importCsv(text, { source: file, name: a.name, id: a.id }); } catch (e) { console.error(`${file}: ${e.message}`); return 1; }
	const out = ST.writeBenchmark(b, dir);
	if (a.json) console.log(JSON.stringify({ id: b.id, file: out, numbers: ST.benchNumbers(b) }));
	else console.log(summaryText(b, out));
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, summaryText };
