'use strict';
// THE MEASUREMENT's extra numbers (n5-hy-best): from compare.js --json rows and the batch's results: the stop reasons by
// outcome, who found the first route / the final, the leg hybrid's use, the compiler's own routes inside H, the stall-stopped
// levels (candidates for a longer rerun), the d4 pair.
//   node docs/hybrid/summary.js <rows.jsonl> <H_results.jsonl>
const fs = require('fs');
const [rowsF, hF] = process.argv.slice(2);
const jl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const rows = jl(rowsF), H = new Map(jl(hF).map((r) => [r.rel, r]));
const run = rows.filter((r) => r.hRun);
const cnt = (a, f) => a.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('stops x outcome', cnt(run, (r) => `${r.hStop}/${r.H != null ? 'routed' : 'none'}`));
console.log('first by', cnt(run.filter((r) => r.hFirst), (r) => r.hFirst.by), 'final by', cnt(run.filter((r) => r.H != null), (r) => r.hFinalBy));
const leg = run.filter((r) => r.hLeg && r.hLeg.requests > 0);
console.log('leg hybrid: levels with requests', leg.length, 'legs', leg.reduce((t, r) => t + (r.hLeg.legs || 0), 0), 'routes', leg.reduce((t, r) => t + (r.hLeg.routes || 0), 0), 'released', leg.reduce((t, r) => t + (r.hLeg.released || 0), 0));
const cf = run.filter((r) => r.hCompFirst);
console.log('compiler routed inside H', cf.length, '; of them levels C (AB B) did not:', cf.filter((r) => r.C == null).map((r) => r.name).join(', '));
const feeds = [...H.values()].filter((h) => h.feeds > 0).length, hints = [...H.values()].filter((h) => h.hints > 0).length;
console.log('levels with feeds', feeds, 'with hints', hints, 'prefix routes', [...H.values()].filter((h) => (h.prefix || []).some((p) => p.routed)).length,
	'joins gains', [...H.values()].filter((h) => h.joins && h.joins.saved > 0).map((h) => `${h.id.split('__').pop()} -${h.joins.saved}`).join(', '));
const both = run.filter((r) => r.H != null && r.hFirst && r.hCompFirst);
console.log('first route by the compiler inside H, median s:', (() => { const v = cf.map((r) => r.hCompFirst.t).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(), 'n', cf.length, both.length);
console.log('stall-stopped (' + run.filter((r) => r.hStop === 'stall').length + '):', run.filter((r) => r.hStop === 'stall').map((r) => `${r.name}${r.S != null ? ' [S ' + r.sFirst + ' s]' : ''}`).join('; '));
console.log('d4:', rows.filter((r) => r.set === 'd4').map((r) => `${r.name} ${r.hStop} ${r.hStopT} s, near ${r.hNear}, gain ${r.hGain}`).join(' | '));
const walls = run.map((r) => r.hWall).filter((x) => x != null);
console.log('wall sum', Math.round(walls.reduce((t, x) => t + x, 0)), 'level-s, median', walls.sort((a, b) => a - b)[Math.floor(walls.length / 2)]);
