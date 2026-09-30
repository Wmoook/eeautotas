'use strict';
// two full-compile dirs (tools/cmp/fullc.js) side by side: node tools/cmp/abcmp.js <base dir> <var dir> [--json]
// Per level: compiled (code 0 and the report's ok), run ticks, the most progress (the report's 'gain': triggers of the
// furthest anchor) and its tick; the totals: compiled base / var, only one arm, the compiled levels' ticks (var / base),
// the failing levels' progress better / worse / same.
const fs = require('fs'), path = require('path');
const [bd, vd] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const read = (d) => {
	const out = new Map();
	const ix = path.join(d, 'index.jsonl');
	if (!fs.existsSync(ix)) return out;
	for (const l of fs.readFileSync(ix, 'utf8').split('\n')) {
		if (!l.trim()) continue;
		const x = JSON.parse(l);
		let r = null;
		try { r = JSON.parse(fs.readFileSync(path.join(d, x.id + '.json'), 'utf8')); } catch (e) { r = null; }
		const why = r && r.why ? String(r.why) : '';
		const gm = why.match(/the most progress: anchor \d+ \(gain (\d+), tick (\d+)/);
		out.set(x.rel, { ok: !!(r && r.ok) && x.code === 0, runTicks: r && r.ok ? r.runTicks : null, gain: r && r.ok ? Infinity : gm ? +gm[1] : 0, tick: gm ? +gm[2] : 0, sec: x.sec, rss: x.peakRssMB, why: why.slice(0, 90) });
	}
	return out;
};
const B = read(bd), V = read(vd);
const rels = Array.from(B.keys()).filter((k) => V.has(k)).sort();
let cb = 0, cv = 0, onlyB = [], onlyV = [], better = 0, worse = 0, same = 0;
const ratios = [];
for (const k of rels) {
	const b = B.get(k), v = V.get(k);
	if (b.ok) cb++;
	if (v.ok) cv++;
	if (b.ok && !v.ok) onlyB.push(k);
	if (v.ok && !b.ok) onlyV.push(k);
	if (b.ok && v.ok) ratios.push(v.runTicks / b.runTicks);
	if (!b.ok && !v.ok) { if (v.gain > b.gain) better++; else if (v.gain < b.gain) worse++; else same++; }
	console.log(`${k.padEnd(52)} base ${b.ok ? 'OK ' + String(b.runTicks).padStart(6) : 'no g' + String(b.gain).padStart(3) + '   '}  var ${v.ok ? 'OK ' + String(v.runTicks).padStart(6) : 'no g' + String(v.gain).padStart(3) + '   '}  rss ${b.rss}/${v.rss}`);
}
ratios.sort((a, b) => a - b);
const geo = ratios.length ? Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length) : null;
console.log(`\nlevels ${rels.length}: compiled base ${cb}, var ${cv}; only var: ${onlyV.join(', ') || '-'}; only base: ${onlyB.join(', ') || '-'}`);
console.log(`both compiled ${ratios.length}: run ticks var / base geo-mean ${geo ? geo.toFixed(3) : '-'} (median ${ratios.length ? ratios[ratios.length >> 1].toFixed(3) : '-'}); failing in both: progress better ${better}, worse ${worse}, same ${same}`);
