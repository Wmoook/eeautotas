'use strict';
// n4u-moves: paired comparison of two movecheck.js runs over the same moves / chains (same shards, --every, --chain):
// node src/plan/understand/movecheck_pair.js <dirA> <dirB>. Pairs by (route index, t0).
const fs = require('fs');
const path = require('path');
const load = (d) => { const m = new Map(); for (const f of fs.readdirSync(d)) if (/^mc_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) if (l) { const r = JSON.parse(l); m.set(`${r.r}:${r.t0}`, r); } return m; };
const A = load(process.argv[2]), B = load(process.argv[3]);
let n = 0, both = 0, onlyA = 0, onlyB = 0, none = 0, fA = 0, fB = 0, dSum = 0, dN = 0, bFaster = 0, aFaster = 0;
const cov = (r) => r.ticks >= 0 && r.ticks <= r.len;
for (const [k, a] of A) {
	const b = B.get(k);
	if (!b) continue;
	n++;
	const ca = cov(a), cb = cov(b);
	if (ca && cb) both++; else if (ca) onlyA++; else if (cb) onlyB++; else none++;
	if (a.ticks >= 0) fA++;
	if (b.ticks >= 0) fB++;
	if (a.ticks >= 0 && b.ticks >= 0) { dSum += b.ticks - a.ticks; dN++; if (b.ticks < a.ticks) bFaster++; else if (a.ticks < b.ticks) aFaster++; }
}
const pct = (x) => (n ? (100 * x / n).toFixed(1) : '-');
console.log(`paired ${n}: covered A ${pct(both + onlyA)}% B ${pct(both + onlyB)}% (both ${both}, only A ${onlyA}, only B ${onlyB}, neither ${none}); found A ${pct(fA)}% B ${pct(fB)}%; both found ${dN}: B faster ${bFaster}, A faster ${aFaster}, mean B - A ${(dSum / Math.max(1, dN)).toFixed(2)} ticks`);
