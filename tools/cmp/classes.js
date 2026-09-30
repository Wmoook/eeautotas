'use strict';
// THE COMPILER's failure classes and time curve from one --json full compile (tools/cmp/fullc.js --json=1 --rss=1):
// per level the time to the first verified route, the best route at 60 / 180 s and at the end, the progress (triggers
// reached) over time from the progress events, the peak RSS, and ONE class a failing level:
//   CLAIM-DEATH  its last failure is a claim ('exhausted' / 'proof') or a death step
//   NEAR         its last failure's closest approach within 3 tiles
//   ONE-LEG      no trigger reached, the plan one step (the whole route one leg to its target)
//   RATE         still progressing at the budget's end (the triggers at the end >= those at 180 s + max(2, 20%))
//   STUCK-FIELD  otherwise, a field block (arrow, dot, boost, climbable, liquid, portal) within 4 tiles of the failing
//   STUCK-PLAIN  target or of its closest approach; else plain
// Compiled levels: the gap to the best known route (--best=<FINAL.jsonl of an earlier chief: rel, best, bestSource>).
//   node tools/cmp/classes.js <dir> <levels dir> [--best=<jsonl>] [--json=<file>] [--md=<file>]
const fs = require('fs'), path = require('path');
const T = require('../../src/plan/types.js');
const B = require('../../src/blocks.js');
const [, , dir, lvDir] = process.argv;
const arg = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const bestOf = new Map();
if (arg('best')) for (const l of fs.readFileSync(arg('best'), 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); bestOf.set(r.rel, r); }
const FIELD = new Set(['arrow', 'dot', 'boost', 'climbable', 'liquid', 'portal']);
const rows = [];
for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) {
	if (!l.trim()) continue;
	const ix = JSON.parse(l);
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, ix.id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const ev = { res: [], prog: [], plan: null, steps: [], stages: {} };
	const lp = path.join(dir, ix.id + '.log');
	if (fs.existsSync(lp)) {
		for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
			if (!s.startsWith('{')) continue;
			let e;
			try { e = JSON.parse(s); } catch (err) { continue; }
			if (e.ev === 'result' && e.kind === 'finish' && e.runTicks > 0) ev.res.push({ t: e.t, runTicks: e.runTicks });
			else if (e.ev === 'progress') ev.prog.push({ t: e.t, triggers: e.triggers | 0, anchors: e.anchors | 0 });
			else if (e.ev === 'plan' && !ev.plan) ev.plan = e;
			else if (e.ev === 'step' && e.ok === false) ev.steps.push(e);
			else if (e.ev === 'stage') ev.stages[e.name] = e;
		}
	}
	const gainAt = (T0) => ev.prog.filter((p) => p.t <= T0).reduce((m, p) => Math.max(m, p.triggers), 0);
	const bestAt = (T0) => { const b = ev.res.filter((x) => x.t <= T0); return b.length ? Math.min(...b.map((x) => x.runTicks)) : null; };
	const L = T.loadLevelFile(path.join(lvDir, ix.rel));
	const W = L.width, H = L.height;
	const r = { rel: ix.rel, W, H, ok: !!(rep && rep.ok), runTicks: rep && rep.ok ? rep.runTicks : null, lb: rep ? rep.lb : null, sec: ix.sec, peakRssMB: ix.peakRssMB || null,
		first: ev.res.length ? ev.res[0].t : null, firstTicks: ev.res.length ? ev.res[0].runTicks : null, at60: bestAt(60), at180: bestAt(180),
		g60: gainAt(60), g180: gainAt(180), gEnd: gainAt(1e9), anchors: ev.prog.reduce((m, p) => Math.max(m, p.anchors), 0),
		planSteps: ev.plan ? (ev.plan.steps || []).length : 0, planText: ev.plan ? (ev.plan.steps || []).join(' -> ').slice(0, 200) : '', est: ev.plan ? ev.plan.cost : null,
		model: ev.stages.model ? ev.stages.model.text : '', frontS: ev.stages.plan ? ev.stages.plan.t : null };
	const kb = bestOf.get(ix.rel);
	r.best = kb && kb.best ? kb.best : null; r.bestSource = kb ? kb.bestSource || '' : '';
	r.n4 = kb ? { A60: kb.okA ? kb.ticksA : null, C180: kb.okC ? kb.ticksC : null, cls5: kb.b4 ? kb.b4.cls5 : '' } : null;
	if (r.ok) { r.cls = 'COMPILED'; r.gap = r.best ? Math.round((r.runTicks / r.best) * 1000) / 1000 : null; r.overLb = r.lb ? Math.round((r.runTicks / r.lb) * 100) / 100 : null; }
	else {
		const why = String(rep ? rep.why : '');
		const lf = why.match(/last failures: '([^']*)' rung (\d): ([\w-]+)(?: \(closest ([\d.]+) tiles)?/);
		r.failLabel = lf ? lf[1] : ''; r.failWhy = lf ? lf[3] : (rep ? '' : 'no report'); r.closest = lf && lf[4] ? +lf[4] : null;
		r.why = why.slice(0, 240);
		// the failing target's tile and its closest approach's tile (the last failing step of that label)
		const m = r.failLabel.match(/\((\d+),(\d+)\)/);
		const tiles = [];
		if (m) tiles.push([+m[1], +m[2]]);
		const st = ev.steps.filter((s) => s.label === r.failLabel && s.closest && s.closest.tile >= 0).pop();
		if (st) tiles.push([st.closest.tile % W, Math.floor(st.closest.tile / W)]);
		let field = false;
		for (const [x0, y0] of tiles) for (let dy = -4; dy <= 4 && !field; dy++) for (let dx = -4; dx <= 4; dx++) {
			const x = x0 + dx, y = y0 + dy;
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const id = L.fg[y * W + x];
			if (id && FIELD.has(B.kindOf(id).kind)) { field = true; break; }
		}
		r.field = field;
		const claim = /exhausted|proof/.test(r.failWhy) || /^die/.test(r.failLabel);
		if (!rep) r.cls = 'CRASH';
		else if (claim) r.cls = 'CLAIM-DEATH';
		else if (r.closest !== null && r.closest <= 3) r.cls = 'NEAR';
		else if (r.gEnd === 0 && r.planSteps <= 1) r.cls = 'ONE-LEG';
		else if (r.gEnd >= r.g180 + Math.max(2, Math.ceil(0.2 * r.g180))) r.cls = 'RATE';
		else r.cls = field ? 'STUCK-FIELD' : 'STUCK-PLAIN';
	}
	rows.push(r);
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));
const n = rows.length, ok = rows.filter((r) => r.ok);
const byCls = new Map();
for (const r of rows) { const c = byCls.get(r.cls) || []; c.push(r); byCls.set(r.cls, c); }
const med = (a) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const q = (a, p) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null; };
const set = (r) => r.rel.split('/')[0];
const out = [];
out.push(`compiled ${ok.length} / ${n} at the end; a verified route by 60 s ${rows.filter((r) => r.at60 !== null).length}, by 180 s ${rows.filter((r) => r.at180 !== null).length}`);
for (const s of ['campaign', 'hard', 'd4']) { const a = rows.filter((r) => set(r) === s); out.push(`  ${s}: ${a.filter((r) => r.ok).length} / ${a.length} (60 s ${a.filter((r) => r.at60 !== null).length}, 180 s ${a.filter((r) => r.at180 !== null).length})`); }
out.push(`time to the first route (compiled): median ${med(ok.map((r) => r.first))} s, p90 ${q(ok.map((r) => r.first), 0.9)} s`);
const gaps = ok.map((r) => r.gap).filter((x) => x !== null);
out.push(`ticks / best known (${gaps.length} with one): median ${med(gaps)}, <= 1.00 ${gaps.filter((g) => g <= 1).length}, <= 1.10 ${gaps.filter((g) => g <= 1.1).length}`);
out.push(`peak RSS a compile: median ${med(rows.map((r) => r.peakRssMB))} MB, p90 ${q(rows.map((r) => r.peakRssMB), 0.9)}, max ${Math.max(...rows.map((r) => r.peakRssMB || 0))} MB`);
out.push('classes:');
for (const [c, a] of [...byCls].sort((x, y) => y[1].length - x[1].length)) out.push(`  ${c.padEnd(12)} ${String(a.length).padStart(3)}  big ${a.filter((r) => r.W * r.H >= 40000).length}  e.g. ${a.slice(0, 4).map((r) => path.basename(r.rel, '.eelvl') + (r.ok ? ` ${r.runTicks}` : ` g${r.gEnd}${r.closest !== null ? ` ${r.closest}t` : ''}`)).join(', ')}`);
console.log(out.join('\n'));
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows, null, 1));
if (arg('md')) {
	const md = ['| level | W x H | class | 60 s | 180 s | end | first route s | lb | best known | ticks / best | gain 60 / 180 / end | last failure | peak RSS MB |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
	for (const r of rows) md.push(`| ${r.rel.replace(/\.eelvl$/, '')} | ${r.W} x ${r.H} | ${r.cls}${r.cls.startsWith('STUCK') || r.cls === 'RATE' ? '' : ''} | ${r.at60 ?? '-'} | ${r.at180 ?? '-'} | ${r.ok ? `**${r.runTicks}**` : '-'} | ${r.first ?? '-'} | ${r.lb ?? '-'} | ${r.best ?? '-'} | ${r.gap ?? '-'} | ${r.g60} / ${r.g180} / ${r.gEnd} | ${r.ok ? '' : `${r.failLabel} (${r.failWhy}${r.closest !== null ? `, ${r.closest} tiles` : ''})`} | ${r.peakRssMB ?? '-'} |`);
	fs.writeFileSync(arg('md'), md.join('\n') + '\n');
}
