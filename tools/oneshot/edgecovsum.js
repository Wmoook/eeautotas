'use strict';
// tools/oneshot/edgecovsum.js <cov.jsonl>... [--md]: the summary of tools/oneshot/edgecov.js lines (a partial run too):
// the moves covered (src / pair / pairT / replay / replayT) in all and by move label, the graphs' supports, edges, build
// time and peak RSS by level size. A tool only.
const fs = require('fs');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const md = process.argv.includes('--md');
const lv = [];
for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o.level) lv.push(o); } catch (e) { /* skip */ } }
const K = ['src', 'pair', 'pairT', 'replay', 'replayT', 'lazyT'];
const tot = { levels: lv.length, routes: 0, moves: 0, respawn: 0 };
for (const k of K) tot[k] = 0;
const lab = {};
for (const o of lv) {
	tot.routes += o.routes; tot.moves += o.moves; tot.respawn += o.respawn;
	for (const k of K) tot[k] += o[k] || 0;
	for (const [n, v] of Object.entries(o.lab || {})) { const b = lab[n] || (lab[n] = { n: 0 }); b.n += v.n; for (const k of K) b[k] = (b[k] || 0) + (v[k] || 0); }
}
const pc = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
console.log(`levels ${tot.levels}, routes ${tot.routes}, moves ${tot.moves} (+${tot.respawn} respawns): ` + K.map((k) => `${k} ${pc(tot[k], tot.moves)}`).join(', '));
for (const [n, b] of Object.entries(lab).sort((a, c) => c[1].n - a[1].n)) console.log(`  ${n.padEnd(8)} ${String(b.n).padStart(6)}  ` + K.map((k) => `${k} ${pc(b[k], b.n)}`).join('  '));
// by size
const bins = [[0, 2500], [2501, 10000], [10001, 40000], [40001, 1e9]];
for (const [a, z] of bins) {
	const s = lv.filter((o) => o.tiles >= a && o.tiles <= z);
	if (!s.length) continue;
	const med = (arr) => { const q = arr.slice().sort((x, y) => x - y); return q[q.length >> 1]; };
	console.log(`tiles ${a}-${z === 1e9 ? '' : z}: ${s.length} levels, supports median ${med(s.map((o) => o.sups))}, edges median ${med(s.map((o) => o.edges))} (max ${Math.max(...s.map((o) => o.edges))}), build median ${(med(s.map((o) => o.buildMs)) / 1000).toFixed(1)} s (max ${(Math.max(...s.map((o) => o.buildMs)) / 1000).toFixed(1)}), peak RSS median ${med(s.map((o) => o.maxRssMB))} MB (max ${Math.max(...s.map((o) => o.maxRssMB))}), moves ${s.reduce((x, o) => x + o.moves, 0)} pair ${pc(s.reduce((x, o) => x + o.pair, 0), s.reduce((x, o) => x + o.moves, 0))}`);
}
if (md) {
	console.log('\n| level | W x H | supports | edges | build s | peak RSS MB | moves | src | pair | pairT | replay | replayT |');
	console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
	for (const o of lv) console.log(`| ${o.level} | ${o.W} x ${o.H} | ${o.sups} | ${o.edges} | ${(o.buildMs / 1000).toFixed(1)} | ${o.maxRssMB} | ${o.moves} | ${pc(o.src, o.moves)} | ${pc(o.pair, o.moves)} | ${pc(o.pairT, o.moves)} | ${pc(o.replay, o.moves)} | ${pc(o.replayT, o.moves)} |`);
}
