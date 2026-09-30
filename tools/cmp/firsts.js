'use strict';
// The time to the FIRST verified route and the best route at earlier budgets, from a --json full compile
// (tools/cmp/fullc.js --json=1): every 'result' event (a route the engine evaluated) carries t = its second in the
// compile. A level counts at T s when a result came at t <= T (inside the longer budget: an estimate of a T-s compile,
// which spends its budget differently).
//   node tools/cmp/firsts.js <dir> [--at=60,180,300] [--json=<file>]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const at = ((process.argv.find((a) => a.startsWith('--at=')) || '--at=60,180,300').slice(5)).split(',').map(Number);
const jsonArg = (process.argv.find((a) => a.startsWith('--json=')) || '').slice(7);
const rows = [];
for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) {
	if (!l.trim()) continue;
	const ix = JSON.parse(l);
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, ix.id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const res = [];
	const lp = path.join(dir, ix.id + '.log');
	if (fs.existsSync(lp)) {
		for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
			if (!s.startsWith('{"ev":"result"')) continue;
			try { const e = JSON.parse(s); if (e.kind === 'finish' && e.runTicks > 0) res.push({ t: e.t, runTicks: e.runTicks }); } catch (e) { /* cut */ }
		}
	}
	const r = { rel: ix.rel, ok: !!(rep && rep.ok), runTicks: rep && rep.ok ? rep.runTicks : null, sec: ix.sec, peakRssMB: ix.peakRssMB || null, first: res.length ? res[0].t : null, firstTicks: res.length ? res[0].runTicks : null };
	for (const T of at) { const b = res.filter((x) => x.t <= T); r['at' + T] = b.length ? Math.min(...b.map((x) => x.runTicks)) : null; }
	rows.push(r);
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));
const ok = rows.filter((r) => r.ok);
console.log(`compiled ${ok.length} / ${rows.length} (the report)`);
for (const T of at) console.log(`a verified route by ${T} s: ${rows.filter((r) => r['at' + T] !== null).length}`);
const ft = ok.map((r) => r.first).filter((x) => x !== null).sort((a, b) => a - b);
if (ft.length) console.log(`time to the first route: median ${ft[Math.floor(ft.length / 2)]} s, min ${ft[0]}, max ${ft[ft.length - 1]}`);
for (const r of ok) console.log(`${r.rel.padEnd(60)} first ${String(r.first).padStart(6)} s (${r.firstTicks})  ${at.map((T) => `${T}s ${r['at' + T] === null ? '-' : r['at' + T]}`).join('  ')}  final ${r.runTicks}`);
if (jsonArg) fs.writeFileSync(jsonArg, JSON.stringify(rows, null, 1));
