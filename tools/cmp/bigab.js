'use strict';
// tools/cmp/bigab.js: a big-level A/B of two fullc.js --json=1 runs (EEAT_EXEC_PROF=1 for the exact tier's time): per
// level both arms: compiled, triggers (and the first one's second), ok steps, the skeleton's sub-legs (ok / failed / failed
// with 0 sims: the share spent before any simulation), the exact tier's seconds on sub-legs, the deepest fraction of a
// skeleton's way reached (its least c over c0), peak RSS; the totals over the levels both arms finished.
//   node tools/cmp/bigab.js <off dir> <on dir>
const fs = require('fs'), path = require('path');
function read(dir) {
	const idx = new Map();
	try { for (const s of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(s); idx.set(r.id, r); } } catch (e) { /* none yet */ }
	const out = new Map();
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()) {
		const id = f.replace(/\.log$/, '');
		const ev = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
		const done = ev.some((e) => e.ev === 'done' || e.ev === 'report');
		const rep = ev.find((e) => e.ev === 'report') || {};
		const prog = ev.filter((e) => e.ev === 'progress');
		const lastP = prog[prog.length - 1] || {};
		const steps = ev.filter((e) => e.ev === 'step');
		const re = ev.filter((e) => e.ev === 'exec.reach' && /skeleton/.test(e.label || ''));
		const pr = ev.filter((e) => e.ev === 'exec.prof' && /skeleton/.test(e.label || ''));
		let exMs = 0, exN = 0;
		for (const p of pr) for (const t of p.tiers || []) if (t.tier === 'exact') { exMs += t.ms || 0; exN++; }
		const sk = ev.filter((e) => e.ev === 'exec.skel');
		let frac = 1;
		for (const e of sk) { let m = e.c0; for (const l of e.levels || []) if (l.ok && l.c < m) m = l.c; if (e.c0 > 0) frac = Math.min(frac, m / e.c0); }
		const ix = idx.get(id) || {};
		let pre = 0;   // (the stages before the moves: parse, model, bounds, plan)
		for (const e of ev) if (e.ev === 'stage' && e.name !== 'moves' && e.name !== 'polish') pre += e.ms || 0;
		out.set(id, { pre: Math.round(pre / 100) / 10, done, ok: !!rep.ok, runTicks: rep.runTicks || null, trig: lastP.triggers || 0, t: (ev[ev.length - 1] || {}).t,
			steps: steps.length, okSteps: steps.filter((e) => e.ok).length, sub: re.length, subOk: re.filter((e) => e.ok).length,
			subF0: re.filter((e) => !e.ok && !e.sims).length, subF: re.filter((e) => !e.ok).length, exMs: Math.round(exMs / 1000), exN,
			frac: Math.round(frac * 100) / 100, rss: ix.peakRssMB || null, firstTrig: (prog.find((e) => e.triggers > 0) || {}).t || null });
	}
	return out;
}
const A = read(process.argv[2]), B = read(process.argv[3]);
const ids = Array.from(new Set([...A.keys(), ...B.keys()])).sort();
const tot = { a: {}, b: {} };
const add = (o, r) => {
	for (const k of ['ok', 'trig', 'steps', 'okSteps', 'sub', 'subOk', 'subF', 'subF0', 'exMs']) o[k] = (o[k] || 0) + (+r[k] || 0);
	o.n = (o.n || 0) + 1; o.withTrig = (o.withTrig || 0) + (r.trig > 0 ? 1 : 0); o.fracSum = Math.round(((o.fracSum || 0) + r.frac) * 100) / 100;
	if (r.rss) (o.rss = o.rss || []).push(r.rss);
	(o.pre = o.pre || []).push(r.pre);
};
const f = (r) => r ? `${r.ok ? 'OK ' + r.runTicks : '-'} trig ${r.trig}${r.firstTrig ? '@' + Math.round(r.firstTrig) : ''} steps ${r.okSteps}/${r.steps} sub ${r.subOk}/${r.sub} f0 ${r.subF0}/${r.subF} exact ${r.exMs}s/${r.exN} deep ${r.frac} pre ${r.pre}s rss ${r.rss || '?'}${r.done ? '' : ' (running t ' + r.t + ')'}` : 'none';
for (const id of ids) {
	const a = A.get(id), b = B.get(id);
	console.log(id.replace('campaign__', '').slice(0, 28).padEnd(29), '| off', f(a), '| on', f(b));
	if (a && b && a.done && b.done) { add(tot.a, a); add(tot.b, b); }
}
const med = (l) => { if (!l || !l.length) return null; const s = l.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
for (const [k, o] of Object.entries(tot)) console.log(k === 'a' ? 'OFF' : 'ON ', JSON.stringify(Object.assign({}, o, { rss: undefined, pre: undefined, preMed: med(o.pre), preMax: o.pre ? Math.max(...o.pre) : null, rssMed: med(o.rss), rssMax: o.rss ? Math.max(...o.rss) : null })));
