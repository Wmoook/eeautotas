'use strict';
// the before / after table of the perfect pass (n5-perfect): per level the compile's route (before), each arm's result
// (rows.jsonl of tools/perf/perfect.js), the best known TAS (best_known.json: runTicks) and the compile's lower bound
// (its report .json: lb).
//   node tools/perf/table.js <best_known.json> <reports dir> <arm name>=<rows.jsonl> ... [--md]
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const [bkFile, repDir, ...arms] = args.filter((a) => !a.startsWith('--'));
const bk = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
const A = arms.map((x) => { const i = x.indexOf('='); const rows = new Map(); for (const l of fs.readFileSync(x.slice(i + 1), 'utf8').split('\n')) { try { const r = JSON.parse(l); rows.set(r.level, r); } catch (e) { /* not a row */ } } return { name: x.slice(0, i), rows }; });
const names = [...new Set([].concat(...A.map((a) => [...a.rows.keys()])))].sort();
const keyOf = (n) => { const [set, rest] = n.split('__'); return `${set}/${rest}.eelvl`; };
const lbOf = (n) => { for (const d of fs.readdirSync(repDir)) { const f = path.join(repDir, d, `${n}.json`); if (fs.existsSync(f)) { try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); if (r.ok) return r.lb; } catch (e) { /* none */ } } } return null; };
const head = ['level', 'before', ...A.map((a) => a.name), 'best known', 'before / known', 'after / known', 'lb', 'after / lb'];
console.log(`| ${head.join(' | ')} |`);
console.log(`|${head.map(() => '---').join('|')}|`);
const ratios = { before: [], after: [] };
let sumB = 0, sumA = 0, better = 0;
for (const n of names) {
	const rs = A.map((a) => a.rows.get(n));
	const before = (rs.find((r) => r && r.before) || {}).before;
	const afters = rs.map((r) => (r && Number.isFinite(r.after) ? r.after : null));
	const after = Math.min(...afters.filter((x) => x !== null), before);
	const k = bk[keyOf(n)] ? bk[keyOf(n)].runTicks : null;
	const lb = lbOf(n);
	if (k) { ratios.before.push(before / k); ratios.after.push(after / k); }
	sumB += before; sumA += after; if (after < before) better++;
	const f = (x) => (x === null || x === undefined ? '-' : Number(x).toLocaleString('en-US'));
	console.log(`| ${n.replace('__', '/')} | ${f(before)} | ${afters.map((x, i) => (x === null ? '-' : `${f(x)}${x < before ? ` (-${before - x})` : ''}`)).join(' | ')} | ${f(k)} | ${k ? (before / k).toFixed(2) : '-'} | ${k ? (after / k).toFixed(2) : '-'} | ${f(lb)} | ${lb ? (after / lb).toFixed(1) : '-'} |`);
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
console.log(`\nlevels ${names.length}, faster ${better}, ticks ${sumB} -> ${sumA} (-${sumB - sumA}); median ticks / best known ${med(ratios.before).toFixed(3)} -> ${med(ratios.after).toFixed(3)} (${ratios.before.length} with a known route); at or under the known: ${ratios.before.filter((x) => x <= 1).length} -> ${ratios.after.filter((x) => x <= 1).length}`);
