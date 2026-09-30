'use strict';
// THE COMPILER's full-compile summary (tools/cmp/fullc.js's out dir): compiled / n, the failure classes with counts, the
// compiled levels, a per-level JSON for the reports and the lanes.
//   node tools/cmp/summ.js <dir> [--json=<file>] [--list] (--list: one line per level: set/file class gain tick why)
// Classes (from each compile's report JSON + log): COMPILED (a verified .eetas, the compile's own engine replay);
// crash (watchdog: a part blocked past the hard limit; error); no plan (the planner gave the start no plan);
// FIRST LEG (no trigger reached from the start: by the first failing waypoint's kind: trophy = a one-step plan, the
// whole route one leg); PARTIAL (triggers reached, then every leg failed); each with the legs' last fail reason.
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const jsonArg = (process.argv.find((a) => a.startsWith('--json=')) || '').slice(7);
const listArg = process.argv.includes('--list');
const idx = new Map();
if (fs.existsSync(path.join(dir, 'index.jsonl'))) for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); idx.set(r.id, r); }
const kindOf = (label) => {
	const s = String(label || '');
	if (/^trophy/.test(s)) return 'trophy';
	if (/key/.test(s) && !/past/.test(s)) return 'key';
	if (/^past/.test(s)) return 'past a door';
	if (/switch|reset/.test(s)) return 'switch';
	if (/coin/.test(s)) return 'coin';
	if (/checkpoint/.test(s)) return 'checkpoint';
	if (/^die/.test(s)) return 'death';
	if (/team|protection|effect|crown/.test(s)) return 'effect/team/crown';
	if (/explore/.test(s)) return 'explore';
	return 'other';
};
// a --json log (fullc.js --json=1: one event a line) read as the text log's stage rows ('<stage> <text>'); other lines kept
const logText = (s) => {
	if (!/^\s*\{/.test(s)) return s;
	return s.split('\n').map((l) => {
		if (!l.startsWith('{')) return l;
		try { const e = JSON.parse(l); return e.ev === 'stage' ? `${e.name} ${e.text || ''}` : e.ev === 'warning' ? `note ${e.text || ''}` : ''; } catch (err) { return l; }
	}).filter(Boolean).join('\n');
};
const rows = [];
for (const [id, ix] of idx) {
	let r = null;
	try { r = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch (e) { r = null; }
	const log = logText(fs.existsSync(path.join(dir, id + '.log')) ? fs.readFileSync(path.join(dir, id + '.log'), 'utf8') : '');
	const planLine = (log.match(/^plan\s+.*$/m) || [''])[0];
	const nSteps = +((planLine.match(/(\d+) steps?:/) || [])[1] || 0);
	const est = +(((planLine.match(/est ([\d,]+) ticks/) || [])[1] || '0').replace(/,/g, ''));
	const size = (log.match(/(\d+)x(\d+), md5/) || []).slice(1, 3).join('x');
	let cls, why = '', gain = 0, tick = 0, failKind = '', failWhy = '', closest = null;
	if (r && r.ok) cls = 'COMPILED';
	else if (!r) {
		if (/watchdog/.test(log)) cls = 'crash: the watchdog (a part blocked past the hard limit)';
		else if (/rror/.test(log)) { cls = 'crash: an error'; why = (log.match(/.*rror.*/) || [''])[0].slice(0, 200); }
		else cls = `crash: no report (exit ${ix.code}, ${ix.sec} s: killed?)`;
	} else {
		why = String(r.why || '');
		const gm = why.match(/the most progress: anchor \d+ \(gain (\d+), tick (\d+)/);
		gain = gm ? +gm[1] : 0; tick = gm ? +gm[2] : 0;
		const lf = why.match(/last failures: '([^']*)' rung (\d): ([\w-]+)(?: \(closest ([\d.]+) tiles)?/);
		failKind = lf ? kindOf(lf[1]) : ''; failWhy = lf ? lf[3] : ''; closest = lf && lf[4] ? +lf[4] : null;
		if (!lf && /no plan|exhausted/.test(why) && gain === 0) cls = 'no plan from the start';
		else if (gain === 0) cls = `FIRST LEG fails: ${failKind || '?'} (${failWhy || '?'})`;
		else cls = `PARTIAL: legs fail after progress (${failWhy || '?'})`;
	}
	rows.push({ rel: ix.rel, cls, sec: ix.sec, ok: !!(r && r.ok), runTicks: r && r.ok ? r.runTicks : null, lb: r ? r.lb : null, gain, tick, anchors: r ? r.anchors : null,
		steps: r ? r.steps : null, planSteps: nSteps, est, size, failKind, failWhy, closest, why: why.slice(0, 300), plan: planLine.replace(/^plan\s+/, '').slice(0, 220) });
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));
const C = new Map();
for (const x of rows) { const c = C.get(x.cls) || []; c.push(x); C.set(x.cls, c); }
const ok = rows.filter((x) => x.ok);
const L = [`compiled ${ok.length} / ${rows.length}`];
for (const [c, xs] of [...C.entries()].sort((a, b) => b[1].length - a[1].length)) L.push(`  ${String(xs.length).padStart(4)}  ${c}`);
const fw = {};
for (const x of rows) if (!x.ok && x.failWhy) fw[x.failWhy] = (fw[x.failWhy] || 0) + 1;
L.push(`  last fail reason over the failing levels: ${JSON.stringify(fw)}`);
L.push('COMPILED:');
for (const x of ok) L.push(`  ${x.rel}  ${x.runTicks} run ticks, lb ${x.lb}, ${x.sec} s`);
if (listArg) { L.push('ALL:'); for (const x of rows) L.push(`  ${x.rel.padEnd(62)} ${x.cls.padEnd(46)} gain ${x.gain} tick ${x.tick} plan ${x.planSteps} est ${x.est}`); }
console.log(L.join('\n'));
if (jsonArg) fs.writeFileSync(jsonArg, JSON.stringify(rows, null, 1));
