'use strict';
// THE BEST ROUTE PER LEVEL over several passes' outputs (n5-perfect, versus the best known): every .eetas under the
// given dirs whose file name contains a level's id (the level's file name without .eelvl) is read back as raw bytes and
// replayed by the engine from the level file alone (common.js evaluate); per level the fastest that finishes with no
// more deaths than the first (the compile's) route, its ratio to the best known TAS (best_known.json runTicks) and the
// compile's lower bound when a reports dir gives one. --copy=<dir> writes each level's best as <set>__<id>.eetas.
//   node tools/cmp/bestof.js <best_known.json> <levels dir> <first dir> [<dir> ...] [--copy=<dir>] [--json] [--md]
// The first dir names the levels (its <set>__<id>.eetas files, tools/cmp/fullc.js style) and gives the "before" route.
const fs = require('fs'), path = require('path');
const C = require('../../src/common.js');
const T = require('../../src/plan/types.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const [bkFile, lvDir, first, ...rest] = args.filter((a) => !a.startsWith('--'));
const copy = opt('copy', ''), json = args.includes('--json');
const bk = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
const walk = (d) => { const out = []; try { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) out.push(...walk(f)); else if (x.name.endsWith('.eetas')) out.push(f); } } catch (e) { /* none */ } return out; };
const all = [].concat(...rest.map(walk));
if (copy) fs.mkdirSync(copy, { recursive: true });
const f = (x) => (x === null || x === undefined ? '-' : Number(x).toLocaleString('en-US'));
const rows = [];
for (const file of fs.readdirSync(first).filter((x) => x.endsWith('.eetas')).sort()) {
	const key = file.replace(/\.eetas$/, '');
	const [set, id] = key.split('__');
	const rel = `${set}/${id}.eelvl`;
	const L = T.loadLevelFile(path.join(lvDir, rel));
	const ev0 = C.evaluate(L, C.readEetas(path.join(first, file)));
	if (!ev0) { console.error(`${rel}: the first route does not finish`); continue; }
	let best = { ticks: ev0.runTicks, file: path.join(first, file), deaths: ev0.deaths };
	for (const g of all.filter((x) => path.basename(x).includes(id))) {
		let ev = null;
		try { ev = C.evaluate(L, C.readEetas(g)); } catch (e) { ev = null; }
		if (ev && ev.chance >= ev0.chance && ev.deaths <= ev0.deaths && ev.runTicks < best.ticks) best = { ticks: ev.runTicks, file: g, deaths: ev.deaths };
	}
	const k = bk[rel] ? bk[rel].runTicks : null;
	const row = { level: rel, before: ev0.runTicks, after: best.ticks, from: path.relative(process.cwd(), best.file), known: k, ratioBefore: k ? +(ev0.runTicks / k).toFixed(3) : null, ratioAfter: k ? +(best.ticks / k).toFixed(3) : null };
	rows.push(row);
	if (copy) fs.copyFileSync(best.file, path.join(copy, file));
}
if (json) { for (const r of rows) console.log(JSON.stringify(r)); process.exit(0); }
console.log('| level | compiled | best now | from | best known | compiled / known | now / known |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.level.replace('.eelvl', '')} | ${f(r.before)} | ${f(r.after)} | ${r.from} | ${f(r.known)} | ${r.ratioBefore ?? '-'} | ${r.ratioAfter ?? '-'} |`);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const kr = rows.filter((r) => r.known);
console.log(`\nlevels ${rows.length}: ticks ${f(rows.reduce((s, r) => s + r.before, 0))} -> ${f(rows.reduce((s, r) => s + r.after, 0))}; median / best known ${med(kr.map((r) => r.ratioBefore)).toFixed(3)} -> ${med(kr.map((r) => r.ratioAfter)).toFixed(3)} (${kr.length} known); at or under the known ${kr.filter((r) => r.ratioBefore <= 1).length} -> ${kr.filter((r) => r.ratioAfter <= 1).length}`);
