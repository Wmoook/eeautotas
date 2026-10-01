'use strict';
// THE ROUTE'S STORY of a long-budget full compile (tools/cmp/fullc.js --json=1; B8 score900 cycle 5): per level the first
// verified route (its second, run ticks, how), the best route at the budget's end (before the post-budget stages), the
// final route, each post-budget stage's line (perfect / polish / loops / joins / endgame: its second and gain), the
// report's joins / endgame records (before -> after, the endgame's proofs: no faster finish within the last K ticks), the
// triggers reached, peak RSS. One JSON line a level; --sum: one summary of the post-budget stages over the routed levels
// (how many ticks each stage took off, the endgame's proofs).
//   node tools/cmp/routestory.js <fullc out dir> [--budget=900] [--sum]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const B = +arg('budget', 900), sum = process.argv.includes('--sum');
const idx = new Map();
for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) if (l.trim()) { const ix = JSON.parse(l); idx.set(ix.rel, ix); }
const rows = [];
for (const [rel, ix] of idx) {
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, ix.id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const res = [], stages = [];
	let g = 0;
	const lp = path.join(dir, ix.id + '.log');
	if (fs.existsSync(lp)) for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
		if (!s.startsWith('{')) continue;
		let e;
		try { e = JSON.parse(s); } catch (err) { continue; }
		if (e.ev === 'result' && e.kind === 'finish' && e.runTicks > 0) res.push({ t: e.t, runTicks: e.runTicks, how: e.how || '' });
		else if (e.ev === 'progress') g = Math.max(g, e.triggers | 0);
		else if (e.ev === 'stage' && /joins|loops|endgame|perfect|polish/.test(e.name)) stages.push({ name: e.name, ms: e.ms, t: e.t, text: String(e.text || '').slice(0, 160) });
	}
	const atB = res.filter((x) => x.t <= B);
	rows.push({ rel, code: ix.code, sec: ix.sec, peakRssMB: ix.peakRssMB || null, ok: !!(rep && rep.ok), runTicks: rep && rep.ok ? rep.runTicks : null,
		first: res.length ? res[0].t : null, firstTicks: res.length ? res[0].runTicks : null, firstHow: res.length ? res[0].how.slice(0, 120) : null,
		atB: atB.length ? Math.min(...atB.map((x) => x.runTicks)) : null, nResults: res.length, gEnd: g,
		endgame: rep ? rep.endgame || null : null, joins: rep && rep.joins ? { before: rep.joins.before, after: rep.joins.after } : null,
		stages, why: rep && !rep.ok ? String(rep.why || '').slice(0, 200) : '' });
}
if (!sum) { for (const r of rows) console.log(JSON.stringify(r)); process.exit(0); }
const ok = rows.filter((r) => r.ok);
const out = [`routed ${ok.length} / ${rows.length} (budget ${B} s)`];
const j = ok.filter((r) => r.joins && r.joins.after < r.joins.before);
out.push(`joins: faster on ${j.length} of ${ok.filter((r) => r.joins).length}, ${j.reduce((s, r) => s + r.joins.before - r.joins.after, 0)} ticks`);
const eg = ok.filter((r) => r.endgame), egF = eg.filter((r) => r.endgame.after && r.endgame.after < r.endgame.before);
out.push(`endgame: ran on ${eg.length}, faster on ${egF.length} (${egF.reduce((s, r) => s + r.endgame.before - r.endgame.after, 0)} ticks); proofs ${eg.reduce((s, r) => s + (r.endgame.proofs | 0), 0)}; the last K ticks proven: ${eg.map((r) => `${path.basename(r.rel, '.eelvl')} ${r.endgame.provedK || 0}`).join(', ')}`);
out.push(`at the budget -> final: ${ok.map((r) => `${path.basename(r.rel, '.eelvl')} ${r.atB} -> ${r.runTicks}`).join(', ')}`);
console.log(out.join('\n'));
