'use strict';
// n4u-moves: the support-class coverage tables (moves.js --cls output): node src/plan/understand/moves_cls_agg.js <dir> [--json=out]
// cF0 / cF1: the first tick a constant / one-change (per-tick) shape reaches the route's next support class (class letter
// + centre tile, a teleport for portal moves), 0 = never within the route's own move length, -1 = not tried (too many
// masks / too long); cB: the builder's plain JUMP / WALKOFF macros (plain jump / hop / fall moves only).
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const jsonOut = (process.argv.find((a) => a.startsWith('--json=')) || '').slice(7);
const moves = [];
for (const f of fs.readdirSync(dir)) if (/^moves_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) moves.push(JSON.parse(l));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
const out = {};
console.log(`moves ${moves.length}, tried ${moves.filter((m) => m.cF0 !== undefined).length}`);
console.log('class       n     F0 same-or-earlier  F1 same-or-earlier (F1 tried)  F1 strictly earlier  F1 same tick & not slower (dvx >= 0)  builder same-or-earlier');
for (const lb of ['ALL', 'walk', 'jump', 'hop', 'hopjump', 'fall', 'airjump', 'arrow', 'boost', 'swim', 'climb', 'dot', 'portal', 'death']) {
	const ms = moves.filter((m) => m.cF0 !== undefined && (lb === 'ALL' || m.label === lb));
	if (!ms.length) continue;
	const tried = ms.filter((m) => m.cF1 >= 0);
	const f0 = ms.filter((m) => m.cF0 > 0).length;
	const f1 = tried.filter((m) => m.cF1 > 0).length;
	const early = tried.filter((m) => m.cF1 > 0 && m.cF1 < m.N).length;
	const dom = tried.filter((m) => m.cF1 > 0 && (m.cF1 < m.N || m.cF1dv >= -1e-9)).length;
	const bs = ms.filter((m) => m.plainAir && ['jump', 'hop', 'fall'].includes(m.label));
	const b = bs.filter((m) => m.cB > 0).length;
	const t2 = ms.filter((m) => m.cF2 !== undefined && m.cF2 >= 0);
	if (t2.length) console.log(`   ${lb}: F2 (<= 2 changes, per tick, plain masks) same-or-earlier ${pct(t2.filter((m) => m.cF2 > 0).length, t2.length)}% of ${t2.length} tried (F2 not tried: ${ms.filter((m) => m.cF2 === -1).length})`);
	out[lb] = { F2: t2.length ? +pct(t2.filter((m) => m.cF2 > 0).length, t2.length) : null, n: ms.length, F0: +pct(f0, ms.length), F1: +pct(f1, tried.length), F1tried: tried.length, F1early: +pct(early, tried.length), F1dom: +pct(dom, tried.length), builder: bs.length ? +pct(b, bs.length) : null };
	console.log(`${lb.padEnd(8)} ${String(ms.length).padStart(6)}  ${String(pct(f0, ms.length)).padStart(8)}%          ${String(pct(f1, tried.length)).padStart(6)}% (${tried.length})             ${String(pct(early, tried.length)).padStart(6)}%             ${String(pct(dom, tried.length)).padStart(6)}%                          ${bs.length ? pct(b, bs.length) + '% of ' + bs.length : '-'}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
