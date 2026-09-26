'use strict';
// summary.js <res.jsonl>...: per (level, config without the salt): tries, routes found (and their ticks), mean states and
// ticks per try, states per found route
const fs = require('fs');
const rows = [];
for (const f of process.argv.slice(2)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch (e) { /* skip */ } }
const groups = new Map();
for (const r of rows) {
	if (!r.level) continue;
	const cfg = (r.args || '').split(' ').filter((a) => !/^--(salt|threads|quiet|watch)=/.test(a)).join(' ');
	const k = `${r.level} | ${cfg || '(base)'}`;
	if (!groups.has(k)) groups.set(k, []);
	groups.get(k).push(r);
}
const out = [];
for (const [k, rs] of groups) {
	const hits = rs.filter((r) => r.finish > 0);
	const st = rs.reduce((a, r) => a + (r.states || 0), 0), tk = rs.reduce((a, r) => a + (r.ticks || 0), 0);
	const salts = rs.map((r) => `${r.salt}${r.finish > 0 ? '*' : ''}`).join(',');
	out.push({ k, n: rs.length, hits: hits.length, fin: [...new Set(hits.map((r) => r.finish))].join('/'), mStates: st / rs.length / 1e6, mTicks: tk / rs.length / 1e6,
		perHit: hits.length ? st / hits.length / 1e6 : null, salts });
}
out.sort((a, b) => a.k.localeCompare(b.k));
for (const o of out) console.log(`${o.k.padEnd(70)} tries ${String(o.n).padStart(3)} hits ${o.hits} ${o.fin ? `(${o.fin})` : ''} | ${o.mStates.toFixed(1)}M states ${o.mTicks.toFixed(0)}M ticks per try | ${o.perHit ? `${o.perHit.toFixed(1)}M states per route` : '-'} | salts ${o.salts}`);
