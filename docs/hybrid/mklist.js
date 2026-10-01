'use strict';
// THE MEASUREMENT's level list (n5-hy-best): the 230 of the paired compile (AB.jsonl), the longest expected first (the two d4
// levels: 1,800 s, the stall rule at 300 s; then the levels neither the compiler nor the search routed: 600 s; then by the
// search alone's first route + 120 s of polish); the rest at 600 s, the stall rule at 180 s.
//   node docs/hybrid/mklist.js <AB.jsonl> <S600 results.jsonl> <manifest_ab.json> <out list.jsonl>
const fs = require('fs');
const [abF, sF, manF, outF] = process.argv.slice(2);
const AB = fs.readFileSync(abF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const relOfMd5 = new Map(JSON.parse(fs.readFileSync(manF, 'utf8')).map((m) => [m.md5, m.rel]));
const S = new Map();
for (const l of fs.readFileSync(sF, 'utf8').trim().split('\n')) { const r = JSON.parse(l); const rel = relOfMd5.get(r.md5); if (rel) S.set(rel, r); }
const out = [];
for (const a of AB) {
	const d4 = a.rel.startsWith('d4/');
	const s = S.get(a.rel), c = a.B && a.B.compiled;
	const E = d4 ? 1800 : s && s.routed ? Math.min(600, s.firstRouteS + 120) : c ? 300 : 600;
	out.push({ rel: a.rel, seconds: d4 ? 1800 : 600, stallStopS: d4 ? 300 : 180, E: Math.round(E) });
}
out.sort((x, y) => y.E - x.E);
const sum = out.reduce((t, o) => t + o.E, 0);
console.log(`${out.length} levels (S mapped ${S.size}), expected ${sum} level-s: ${(sum / 20 / 60).toFixed(1)} min at 20 at once, ${(sum / 24 / 60).toFixed(1)} at 24`);
fs.writeFileSync(outF, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
