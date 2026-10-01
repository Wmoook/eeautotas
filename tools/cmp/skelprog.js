'use strict';
// tools/cmp/skelprog.js: where a big level's steps go, per waypoint (fullc.js --json=1 logs): the steps (ok, anchors,
// seconds, the highest rung), the skeleton's c0 and the least c it reached, its sub-legs ok / failed, the most walls; the
// reaches to the waypoint itself (the direct leg, the last leg: exec.reach with its plain label) and the skeleton's
// sub-legs (exec.reach '(skeleton N tiles)'): their seconds and ok; the totals by c0 class (a far waypoint: c0 >= --far).
//   node tools/cmp/skelprog.js <fullc out dir> [top waypoints a level, default 6]
const fs = require('fs'), path = require('path');
const dir = process.argv[2], top = +(process.argv[3] || 6);
const far = +((process.argv.find((a) => a.startsWith('--far=')) || '--far=1000').slice(6));
const TOT = { far: { n: 0, dMs: 0, dOk: 0, dN: 0, sMs: 0, sOk: 0, sN: 0, stepMs: 0 }, near: { n: 0, dMs: 0, dOk: 0, dN: 0, sMs: 0, sOk: 0, sN: 0, stepMs: 0 } };
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()) {
	const ev = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
	const W = new Map();
	const g = (l) => { let w = W.get(l); if (!w) { w = { n: 0, ms: 0, rung: 0, c0: 0, c: Infinity, ok: 0, subOk: 0, subF: 0, walls: 0, anchors: new Set(), dMs: 0, dOk: 0, dN: 0, sMs: 0, sOk: 0, sN: 0 }; W.set(l, w); } return w; };
	for (const e of ev) {
		if (e.ev === 'step') { const w = g(e.label); w.n++; w.ms += e.ms || 0; w.rung = Math.max(w.rung, e.rung || 0); if (e.ok) w.ok++; w.anchors.add(e.anchor); }
		if (e.ev === 'exec.reach') {
			const m = /^(.*) \(skeleton \d+ tiles\)$/.exec(e.label || '');
			if (m) { const w = g(m[1]); w.sN++; w.sMs += e.ms || 0; if (e.ok) w.sOk++; } else { const w = g(e.label || ''); w.dN++; w.dMs += e.ms || 0; if (e.ok) w.dOk++; }
		}
		if (e.ev === 'exec.skel') {
			const w = g(e.label); w.c0 = Math.max(w.c0, e.c0); w.c = Math.min(w.c, e.c); w.walls = Math.max(w.walls, e.walls || 0);
			for (const l of e.levels || []) { if (l.back !== undefined) continue; if (l.ok) w.subOk++; else w.subF++; }
		}
	}
	const arr = [...W.entries()].filter(([, w]) => w.n > 0).sort((a, b) => b[1].ms - a[1].ms);
	for (const [, w] of arr) { const T0 = TOT[w.c0 >= far ? 'far' : 'near']; T0.n++; T0.stepMs += w.ms; for (const k of ['dMs', 'dOk', 'dN', 'sMs', 'sOk', 'sN']) T0[k] += w[k]; }
	const tot = arr.reduce((s, [, w]) => s + w.ms, 0);
	console.log(`${f.replace(/\.log$/, '').replace('campaign__', '')}: waypoints ${arr.length}, step s ${Math.round(tot / 1000)}`);
	for (const [l, w] of arr.slice(0, top)) console.log(`   ${l.padEnd(34)} steps ${w.n} ok ${w.ok} anch ${w.anchors.size} s ${(w.ms / 1000).toFixed(1)} rung<=${w.rung} c0 ${w.c0} least ${w.c === Infinity ? '-' : w.c} sub ${w.subOk}/${w.subF} walls ${w.walls} | direct ${w.dOk}/${w.dN} ${(w.dMs / 1000).toFixed(1)} s, sub-legs ${w.sOk}/${w.sN} ${(w.sMs / 1000).toFixed(1)} s`);
}
for (const k of ['far', 'near']) { const t = TOT[k]; console.log(`${k} (c0 ${k === 'far' ? '>=' : '<'} ${far}): waypoints ${t.n}, step s ${Math.round(t.stepMs / 1000)}, direct / last legs ${t.dOk} ok of ${t.dN} in ${Math.round(t.dMs / 1000)} s, sub-legs ${t.sOk} ok of ${t.sN} in ${Math.round(t.sMs / 1000)} s`); }
