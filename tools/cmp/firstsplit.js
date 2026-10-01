'use strict';
// THE FIRST ROUTE'S SPLIT (B8 speed cycle 4), from a tools/cmp/firstab.js run: per level and arm the first route (s), its
// source ('how'), the stages before the moves (s), the stretch children's requests / verified arrivals (slot 1's) / their
// anchors, the executor's steps before the first route (all / ok) and their worker-s; then each arm's median / p90 / by 60 s
// / by 30 s (unrouted = cap + 1) and the geo-mean ratio of each arm against the first (unrouted = the cap).
//   node tools/cmp/firstsplit.js <firstab out dir> [cap s = 150]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const cap = +(process.argv[3] || 150);
const recs = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = {};
for (const r of recs) {
	const lp = path.join(dir, r.arm, r.id + '.log');
	const o = { first: r.first, how: r.how, pre: null, stReq: 0, stArr: 0, stArrS1: 0, steps: 0, ok: 0, wsec: 0, wfail: 0, srcSt: 0 };
	const reqSlot = {};
	try {
		for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
			if (!s.startsWith('{')) continue;
			let e; try { e = JSON.parse(s); } catch (x) { continue; }
			if (e.ev === 'stage' && e.name === 'plan') o.pre = e.t;
			if (e.ev === 'stretch' && e.what === 'request') { o.stReq++; reqSlot[e.id] = e.slot; }
			if (e.ev === 'stretch' && e.what === 'arrival' && e.ok) { o.stArr++; if (reqSlot[e.id] === 1) o.stArrS1++; }
			if (e.ev === 'source' && /\(stretch\)/.test(e.label || '')) o.srcSt++;
			if (e.ev === 'step') { o.steps++; o.wsec += (e.ms || 0) / 1000; if (e.ok) o.ok++; else o.wfail += (e.ms || 0) / 1000; }
			if (e.ev === 'result' && e.kind === 'finish') break;
		}
	} catch (x) { o.err = x.message; }
	(rows[r.rel] = rows[r.rel] || {})[r.arm] = o;
}
const arms = [...new Set(recs.map((r) => r.arm))].sort((x, y) => (x === 'base' ? -1 : y === 'base' ? 1 : 0));
const f = (x) => (x === null || x === undefined ? '     -' : x.toFixed(1).padStart(6));
console.log('level'.padEnd(26) + arms.map((a) => `| ${a}: first how pre stReq stArr(s1) srcSt steps ok wsec`).join(' '));
for (const [rel, by] of Object.entries(rows)) {
	console.log(rel.replace(/^.*\//, '').replace(/\.eelvl$/, '').slice(0, 25).padEnd(26) + arms.map((a) => { const o = by[a]; if (!o) return '| (none)'; return `| ${f(o.first)} ${(o.how || '').slice(0, 12).padEnd(12)} ${f(o.pre)} ${o.stReq} ${o.stArr}(${o.stArrS1}) ${o.srcSt} ${o.steps} ${o.ok} ${o.wsec.toFixed(0)}`; }).join(' '));
}
const q = (xs, p) => { const s = xs.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
for (const a of arms) {
	const xs = Object.values(rows).filter((b) => b[a]).map((b) => (b[a].first === null ? cap + 1 : b[a].first));
	console.log(`${a}: n ${xs.length} routed ${xs.filter((x) => x <= cap).length} median ${q(xs, 0.5)} p90 ${q(xs, 0.9)} by60 ${xs.filter((x) => x <= 60).length} by30 ${xs.filter((x) => x <= 30).length}`);
}
if (arms.length >= 2) {
	const A = arms[0];
	for (const B of arms.slice(1)) {
		const both = Object.values(rows).filter((b) => b[A] && b[B]);
		const r = both.map((b) => Math.log((b[B].first === null ? cap : b[B].first) / (b[A].first === null ? cap : b[A].first)));
		console.log(`${B} vs ${A} pairs ${both.length}: geo ${Math.exp(r.reduce((s, x) => s + x, 0) / Math.max(1, r.length)).toFixed(3)} faster ${r.filter((x) => x < -0.05).length} slower ${r.filter((x) => x > 0.05).length}`);
	}
}
