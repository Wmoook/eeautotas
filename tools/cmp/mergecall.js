'use strict';
// THE MERGE CALL (C6 lane 5): a candidate compiler vs origin/main side by side on main's levels, k runs an arm.
//   node tools/cmp/mergecall.js --main=<fullc dir>[,<dir>...] --cand=<fullc dir>[,<dir>...] [--list=<rel paths file>]
// Per level: each arm's runs (the .json reports fullc.js writes, run ticks of a verified route or none), the arm's
// best and mean; then over the levels both arms routed in every run: the pooled sum of the means, the ratio, and the
// sign test (levels where the candidate's mean is lower vs higher, ties dropped: the two-sided binomial p); and the
// levels only one arm routed (in any run).
const fs = require('fs'), path = require('path');
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const dirsOf = (s) => (s ? s.split(',').filter(Boolean) : []);
const M = dirsOf(arg('main')), N = dirsOf(arg('cand'));
if (!M.length || !N.length) { console.log('usage: node tools/cmp/mergecall.js --main=<dir>[,..] --cand=<dir>[,..] [--list=<file>]'); process.exit(2); }
const idOf = (rel) => rel.replace(/\.eelvl$/, '').replace(/\//g, '__');
let ids;
const list = arg('list', '');
if (list) ids = fs.readFileSync(list, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map(idOf);
else { const set = new Set(); for (const d of M.concat(N)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json') && f.includes('__')) set.add(f.replace(/\.json$/, '')); ids = [...set].sort(); }
const runOf = (d, id) => {
	try { const r = JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8')); return r.ok && Number.isFinite(+r.runTicks) ? +r.runTicks : null; } catch (e) { return undefined; }
};
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// two-sided binomial sign test p
const binom = (k, n) => { let c = 1, p = 0; const t = Math.min(k, n - k); for (let i = 0; i <= n; i++) { if (i > 0) c = c * (n - i + 1) / i; if (i <= t || i >= n - t) p += c; } return Math.min(1, p / 2 ** n); };
let sumM = 0, sumN = 0, better = 0, worse = 0, same = 0;
const onlyM = [], onlyN = [], rows = [];
for (const id of ids) {
	const rm = M.map((d) => runOf(d, id)).filter((x) => x !== undefined), rn = N.map((d) => runOf(d, id)).filter((x) => x !== undefined);
	if (!rm.length || !rn.length) { rows.push(`${id.padEnd(48)} (not run in both arms)`); continue; }
	const okM = rm.filter((x) => x !== null), okN = rn.filter((x) => x !== null);
	if (okM.length && !okN.length) onlyM.push(id);
	if (okN.length && !okM.length) onlyN.push(id);
	let tag = '';
	if (okM.length === rm.length && okN.length === rn.length) {
		const a = mean(okM), b = mean(okN);
		sumM += a; sumN += b;
		if (b < a - 0.5) { better++; tag = 'cand faster'; } else if (b > a + 0.5) { worse++; tag = 'cand slower'; } else { same++; tag = 'same'; }
		tag += ` ${(b / a).toFixed(3)}`;
	}
	rows.push(`${id.padEnd(48)} main ${rm.map((x) => (x === null ? '-' : x)).join(' / ').padEnd(20)} cand ${rn.map((x) => (x === null ? '-' : x)).join(' / ').padEnd(20)} ${tag}`);
}
console.log(rows.join('\n'));
console.log(`\nboth routed in every run: ${better + worse + same} levels; pooled run ticks main ${Math.round(sumM)} vs cand ${Math.round(sumN)} (${sumM ? ((sumN / sumM - 1) * 100).toFixed(1) : '?'}%)`);
console.log(`sign test: cand faster ${better}, slower ${worse}, same ${same}; two-sided p = ${binom(better, better + worse).toFixed(3)}`);
console.log(`routed only by main (any run): ${onlyM.length ? onlyM.join(', ') : 'none'}`);
console.log(`routed only by the candidate (any run): ${onlyN.length ? onlyN.join(', ') : 'none'}`);
