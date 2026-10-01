'use strict';
// node tools/cmp/chaintime.js <compile events.jsonl>...: a switch-chain level's leader timeline (the purple chain ids held by
// one anchor: the first time each new id was held), then since the leader's last gain (or SINCE=<s>) the steps by label
// (count, found, worker-s, rungs, the failures' closest tiles) and the plans' first steps (a lone step marked). A diagnosis aid.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
	let L;
	try { L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { console.log(f, 'missing'); continue; }
	let best = [], tEnd = 0, lastUp = 0;
	const tl = [];
	for (const e of L) {
		if (e.t) tEnd = e.t;
		if (e.ev !== 'source') continue;
		const m = /purple=\[([^\]]*)\]/.exec(e.desc || '');
		const ids = m && m[1] ? m[1].split(',').map(Number) : [];
		if (ids.length > best.length) { const nw = ids.filter((x) => !best.includes(x)); best = ids; tl.push(nw.join('+') + '@' + Math.round(e.t)); lastUp = e.t; }
	}
	const since = +(process.env.SINCE || 0) || lastUp;
	console.log(f, 'ids', best.length, 'end', Math.round(tEnd), 'TIMELINE', tl.join(' '));
	const by = new Map();
	for (const e of L) {
		if (e.ev !== 'step' || !(e.t >= since)) continue;
		const o = by.get(e.label) || { n: 0, ok: 0, ms: 0, rungs: {}, cl: {} };
		o.n++; if (e.ok) o.ok++; o.ms += e.ms || 0; o.rungs[e.rung] = (o.rungs[e.rung] || 0) + 1;
		if (!e.ok && e.closest) { const c = e.closest.tile, k = (c % 300) + ',' + Math.floor(c / 300) + ' ' + e.closest.dist; o.cl[k] = (o.cl[k] || 0) + 1; }
		by.set(e.label, o);
	}
	for (const [k, o] of [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)) {
		const cl = Object.entries(o.cl).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, b]) => a + ' x' + b).join('; ');
		console.log('   since ' + Math.round(since), String(k).padEnd(32), 'steps', o.n, 'ok', o.ok, 'ws', Math.round(o.ms / 1000), 'rungs', JSON.stringify(o.rungs), 'closest', cl);
	}
	const pf = {};
	let np = 0;
	for (const e of L) {
		if (e.ev !== 'plan' || !(e.t >= since)) continue;
		np++;
		const s = (e.steps || [])[0] || '-', k = s + ((e.steps || []).length === 1 ? ' (lone)' : '');
		pf[k] = (pf[k] || 0) + 1;
	}
	console.log('   plans since', np, Object.entries(pf).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, b]) => a + ' x' + b).join('; '));
}
