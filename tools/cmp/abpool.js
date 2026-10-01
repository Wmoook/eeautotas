'use strict';
// several compile A/Bs pooled per level (tools/cmp/fullc.js dirs, each A/B a <dir>/base and <dir>/var):
//   node tools/cmp/abpool.js <ab dir> [<ab dir> ...] [--json]
// Per level: base compiled k / n, var compiled k / n (a compile = exit 0 and the report's ok); the totals, the levels only
// one arm ever compiled, and the levels where one arm compiled in every run and the other in none.
const fs = require('fs'), path = require('path');
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const read = (d) => {
	const out = new Map();
	const ix = path.join(d, 'index.jsonl');
	if (!fs.existsSync(ix)) return out;
	for (const l of fs.readFileSync(ix, 'utf8').split('\n')) {
		if (!l.trim()) continue;
		const x = JSON.parse(l);
		let r = null;
		try { r = JSON.parse(fs.readFileSync(path.join(d, x.id + '.json'), 'utf8')); } catch (e) { r = null; }
		out.set(x.rel, { ok: !!(r && r.ok) && x.code === 0, runTicks: r && r.ok ? r.runTicks : null });
	}
	return out;
};
const lv = new Map();   // rel -> {b: [ok...], v: [ok...]}
const tot = { b: 0, v: 0, n: 0 };
for (const d of dirs) {
	const B = read(path.join(d, 'base')), V = read(path.join(d, 'var'));
	for (const [rel, b] of B) {
		const v = V.get(rel);
		if (!v) continue;
		const e = lv.get(rel) || { b: [], v: [] };
		e.b.push(b.ok); e.v.push(v.ok);
		lv.set(rel, e);
		tot.n++; if (b.ok) tot.b++; if (v.ok) tot.v++;
	}
}
const rows = [...lv.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const k = (a) => a.filter(Boolean).length;
const diff = rows.filter(([, e]) => k(e.b) !== k(e.v));
for (const [rel, e] of diff) console.log(`${rel.padEnd(52)} base ${k(e.b)} / ${e.b.length}   var ${k(e.v)} / ${e.v.length}`);
const allB = rows.filter(([, e]) => k(e.b) === e.b.length && k(e.v) === 0).map(([r]) => r);
const allV = rows.filter(([, e]) => k(e.v) === e.v.length && k(e.b) === 0).map(([r]) => r);
console.log(`\n${dirs.length} A/Bs, ${tot.n} level runs: compiled base ${tot.b}, var ${tot.v}; the levels only the var ever compiled: ${rows.filter(([, e]) => k(e.v) && !k(e.b)).length}, only the base: ${rows.filter(([, e]) => k(e.b) && !k(e.v)).length}`);
console.log(`every run var, none base: ${allV.join(', ') || '-'}`);
console.log(`every run base, none var: ${allB.join(', ') || '-'}`);
if (process.argv.includes('--json')) console.log(JSON.stringify({ tot, rows: rows.map(([rel, e]) => ({ rel, b: e.b, v: e.v })) }));
