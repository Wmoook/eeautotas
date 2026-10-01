'use strict';
// THE HEADROOM of a long-budget full compile (tools/cmp/fullc.js --json=1, e.g. 900 s on the levels a 300-s full
// compile did not compile): per level the time to the first verified route, the best route at each budget (--at), the
// progress (triggers reached, the progress events) at each budget, the peak RSS, and ONE headroom class:
//   BY-<a1>      a verified route by the first budget (the short scoreboard's own budget: its run missed it; a flip)
//   BY-<ak>      a verified route first between the budget before and ak (speed work: the compiler CAN, just slowly)
//   RISING       no route; the triggers at the end above those at the budget before the last + max(2, 20%) (more
//                time is still buying progress)
//   FLAT         no route; progress stopped before the budget before the last (solver work: time does not help)
//   ZERO         no route and no trigger reached
// Several dirs merge (the last index line of a level wins: a level compiled again after a kill).
//   node tools/cmp/headroom.js <dir> [<dir> ...] [--at=300,600,900] [--best=<jsonl: rel, best[, cls]>] [--json=<file>] [--md=<file>]
const fs = require('fs'), path = require('path');
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const at = (arg('at') || '300,600,900').split(',').map(Number);
const ref = new Map();
if (arg('best')) for (const l of fs.readFileSync(arg('best'), 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); ref.set(r.rel, r); }
const idx = new Map();
for (const dir of dirs) for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) if (l.trim()) { const ix = JSON.parse(l); idx.set(ix.rel, Object.assign(ix, { dir })); }
const rows = [];
for (const [rel, ix] of idx) {
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(ix.dir, ix.id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const res = [], prog = [];
	const lp = path.join(ix.dir, ix.id + '.log');
	if (fs.existsSync(lp)) {
		for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
			if (!s.startsWith('{"ev":"result"') && !s.startsWith('{"ev":"progress"')) continue;
			let e;
			try { e = JSON.parse(s); } catch (err) { continue; }
			if (e.ev === 'result' && e.kind === 'finish' && e.runTicks > 0) res.push({ t: e.t, runTicks: e.runTicks });
			else if (e.ev === 'progress') prog.push({ t: e.t, triggers: e.triggers | 0 });
		}
	}
	const bestAt = (T0) => { const b = res.filter((x) => x.t <= T0); return b.length ? Math.min(...b.map((x) => x.runTicks)) : null; };
	const gainAt = (T0) => prog.filter((p) => p.t <= T0).reduce((m, p) => Math.max(m, p.triggers), 0);
	const k = ref.get(rel) || {};
	const r = { rel, code: ix.code, sec: ix.sec, peakRssMB: ix.peakRssMB || null, ok: !!(rep && rep.ok), runTicks: rep && rep.ok ? rep.runTicks : null, lb: rep ? rep.lb : null,
		first: res.length ? res[0].t : null, firstTicks: res.length ? res[0].runTicks : null, best: k.best || null, refCls: k.cls || '' };
	for (const T0 of at) { r['at' + T0] = bestAt(T0); r['g' + T0] = gainAt(T0); }
	r.gEnd = gainAt(1e9);
	r.gap = r.ok && r.best ? Math.round((r.runTicks / r.best) * 1000) / 1000 : null;
	if (r.ok && r.first !== null) { const a = at.find((T0) => r.first <= T0); r.cls = 'BY-' + (a === undefined ? 'END' : a); }
	else if (ix.code === null && !rep) r.cls = 'KILLED';
	else if (r.gEnd === 0) r.cls = 'ZERO';
	else { const gPrev = at.length > 1 ? r['g' + at[at.length - 2]] : 0; r.cls = r.gEnd >= gPrev + Math.max(2, Math.ceil(gPrev * 0.2)) ? 'RISING' : 'FLAT'; }
	r.why = rep && !rep.ok ? String(rep.why || '').slice(0, 240) : '';
	rows.push(r);
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));
const med = (a) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const nm = (r) => path.basename(r.rel, '.eelvl');
const ok = rows.filter((r) => r.ok);
const out = [`compiled ${ok.length} / ${rows.length} (budget ${at[at.length - 1]} s); by budget: ${at.map((T0) => `${T0} s ${rows.filter((r) => r['at' + T0] !== null).length}`).join(', ')}`];
const order = [...at.map((T0) => 'BY-' + T0), 'BY-END', 'RISING', 'FLAT', 'ZERO', 'KILLED'];
for (const c of order) {
	const a = rows.filter((r) => r.cls === c);
	if (!a.length) continue;
	out.push(`  ${c.padEnd(7)} ${String(a.length).padStart(3)}: ${a.map((r) => r.ok ? `${nm(r)} ${r.runTicks} @${r.first}s${r.gap ? ` (${r.gap})` : ''}` : `${nm(r)} g${at.map((T0) => r['g' + T0]).join('/')}`).join(', ')}`);
}
out.push(`first route (compiled): median ${med(ok.map((r) => r.first))} s; peak RSS a compile median ${med(rows.map((r) => r.peakRssMB))} MB, max ${Math.max(0, ...rows.map((r) => r.peakRssMB || 0))} MB`);
console.log(out.join('\n'));
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows, null, 1));
if (arg('md')) {
	const md = [`| level | headroom | first route s | ${at.map((T0) => `${T0} s`).join(' | ')} | best known | ticks / best | gain ${at.join(' / ')} | 300-s class | peak RSS MB |`, `|---|---|---|${at.map(() => '---|').join('')}---|---|---|---|---|`];
	for (const c of order) for (const r of rows.filter((x) => x.cls === c)) md.push(`| ${r.rel.replace(/\.eelvl$/, '')} | ${r.cls} | ${r.first ?? '-'} | ${at.map((T0) => r['at' + T0] ?? '-').join(' | ')} | ${r.best ?? '-'} | ${r.gap ?? '-'} | ${at.map((T0) => r['g' + T0]).join(' / ')} | ${r.refCls || '-'} | ${r.peakRssMB ?? '-'} |`);
	fs.writeFileSync(arg('md'), md.join('\n') + '\n');
}
