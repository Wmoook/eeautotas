'use strict';
// fieldmine.js's winners characterised: for the setup variants that exit sooner AND reach the route's tile D ticks after
// the exit sooner (gain2 > 0), how their entry differs from the route's along the face axis (dp = the entry position
// moved toward the face, dv = the entry speed toward the face) and across it; what the setup changed (the held mask vs the
// route's mask at that tick: the along-face key, the cross key, the jump bit) and how far before the entry.
// Usage: node tools/tricks/fmstats.js <dir>
const fs = require('fs');
const dir = process.argv[2];
const rows = [];
for (const f of fs.readdirSync(dir)) if (/^mine_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(dir + '/' + f, 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
const ax = (r, st) => (r.axis === 'x' ? [st[0], st[2], st[1], st[3]] : [st[1], st[3], st[0], st[2]]);
const win = rows.filter((r) => r.gain > 0 && r.gain2 !== null && r.gain2 > 0);
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const groups = new Map();
for (const r of win) {
	const shift = r.entryShift < 0 ? 'earlier' : r.entryShift === 0 ? 'same' : 'later';
	const kind = r.fc.startsWith('arrow') ? 'arrow' : r.fc.startsWith('boost') ? 'boost' : r.fc;
	const key = `${kind}/${shift}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}
console.log('group            n  g2sum  dp(med,p10,p90)            dv(med,p10,p90)            |dq|med  dw med   back med  pullAxis%  faceAlongPull%');
const pullOf = (fc) => ({ arrowU: ['y', -1], arrowD: ['y', 1], arrowL: ['x', -1], arrowR: ['x', 1], boostU: ['y', -1], boostD: ['y', 1], boostL: ['x', -1], boostR: ['x', 1] })[fc] || null;
for (const [k, a] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
	const dp = [], dv = [], dq = [], dw = [], back = [];
	let pullAx = 0, along = 0;
	for (const r of a) {
		const [p0, v0, q0, w0] = ax(r, r.entry), [p1, v1, q1, w1] = ax(r, r.bestEntryState);
		dp.push((p1 - p0) * r.sgn); dv.push((v1 - v0) * r.sgn); dq.push(Math.abs(q1 - q0)); dw.push(Math.abs(w1) - Math.abs(w0)); back.push(r.bestS);
		const pl = pullOf(r.fc);
		if (pl && pl[0] === r.axis) { pullAx++; if (pl[1] === r.sgn) along++; }
	}
	const g2 = a.reduce((s, r) => s + r.gain2, 0);
	console.log(`${k.padEnd(14)} ${String(a.length).padStart(5)} ${String(g2).padStart(6)}  ${fmt(q(dp, 0.5))},${fmt(q(dp, 0.1))},${fmt(q(dp, 0.9))}`.padEnd(62)
		+ ` ${fmt(q(dv, 0.5))},${fmt(q(dv, 0.1))},${fmt(q(dv, 0.9))}`.padEnd(28)
		+ ` ${fmt(q(dq, 0.5)).padStart(7)} ${fmt(q(dw, 0.5)).padStart(7)} ${String(q(back, 0.5)).padStart(9)} ${(100 * pullAx / a.length).toFixed(0).padStart(9)}% ${(100 * along / a.length).toFixed(0).padStart(12)}%`);
}
// the whole population's face axis vs the pull (arrows / boosts)
let pa = 0, al = 0, tot = 0;
for (const r of rows) { const pl = pullOf(r.fc); if (!pl) continue; tot++; if (pl[0] === r.axis) { pa++; if (pl[1] === r.sgn) al++; } }
console.log(`all arrow/boost passages ${tot}: exit face on the pull axis ${(100 * pa / tot).toFixed(1)}%, along the pull ${(100 * al / tot).toFixed(1)}%`);
