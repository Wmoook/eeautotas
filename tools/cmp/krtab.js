'use strict';
// two tools/cmp/krt.js result dirs (one <level>.json a level: krt's stdout) side by side: node tools/cmp/krtab.js <base dir> <var dir>
// Per start kind (the previous trigger / hit-300 / hit-120): the legs found at any rung by each arm, only one arm, the tools
// of the var arm's finds, the ticks over the route's own leg.
const fs = require('fs'), path = require('path');
const [bd, vd] = process.argv.slice(2);
const read = (d) => {
	const m = new Map();
	for (const f of fs.readdirSync(d)) {
		if (!f.endsWith('.json')) continue;
		let r; try { r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { continue; }
		for (const x of r.res || []) {
			const kind = x.start.startsWith('prevEvent') || x.start === 'spawn' ? 'prev' : x.start;
			const k = f.replace('.json', '') + '|' + kind;
			const a = m.get(k) || { ok: false, tool: null, ticks: null, leg: x.routeLeg, ms: 0 };
			a.ms += x.ms;
			if (x.ok && !a.ok) { a.ok = true; a.tool = x.tool; a.ticks = x.ticks; }
			m.set(k, a);
		}
	}
	return m;
};
const B = read(bd), V = read(vd);
const tot = {};
for (const [k, v] of V) {
	const b = B.get(k);
	if (!b) continue;
	const kind = k.split('|')[1];
	const t = tot[kind] || (tot[kind] = { n: 0, b: 0, v: 0, onlyV: [], onlyB: [], tools: {}, ratio: [] });
	t.n++;
	if (b.ok) t.b++;
	if (v.ok) { t.v++; t.tools[v.tool] = (t.tools[v.tool] || 0) + 1; t.ratio.push(v.ticks / v.leg); }
	if (v.ok && !b.ok) t.onlyV.push(k.split('|')[0]);
	if (b.ok && !v.ok) t.onlyB.push(k.split('|')[0]);
}
const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
for (const [k, t] of Object.entries(tot)) {
	console.log(`${k.padEnd(8)} legs ${t.n}: base ${t.b}, var ${t.v}; only var ${t.onlyV.length} (${t.onlyV.join(', ')}); only base ${t.onlyB.length} (${t.onlyB.join(', ')}); var tools ${JSON.stringify(t.tools)}; var ticks / route median ${med(t.ratio) ? med(t.ratio).toFixed(3) : '-'}`);
}
