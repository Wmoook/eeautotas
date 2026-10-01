'use strict';
// THE BOX LOAD BESIDE EACH COMPILE: a full compile's levels (tools/cmp/fullc.js / fliprep.js output dirs) joined with a
// load log (one line every ~30 s: 'HH:MM:SS <load1> <load5> <load15> avail=<G>G mine=<n> all=<n>', the box's clock), so a
// level that flips between runs of the same compiler can be put beside the load it ran under.
//   node tools/cmp/loadjoin.js <load.log> --run=<label>:<full-compile dir>... [--levels=<list of rel paths>]
//        [--bands=100,140,170] [--md=<out>] [--json=<out>]
// A compile's window is [end - sec, end], its end the mtime of its .log (the compile writes it until it exits); its load
// is the mean load1 of the log lines inside the window (the nearest line when none is). Per run: the levels compiled by
// load band; with --levels (e.g. the levels that compiled in some runs and not in others), only those.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const argsAll = (k) => args.filter((a) => a.startsWith('--' + k + '=')).map((a) => a.slice(k.length + 3));
const logFile = args.find((a) => !a.startsWith('--'));
if (!logFile) { console.error('usage: node tools/cmp/loadjoin.js <load.log> --run=<label>:<dir>...'); process.exit(2); }
const daySec = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s; };
// the log's lines as absolute seconds (a midnight wrap adds a day)
const pts = [];
{
	let day = 0, last = -1;
	for (const ln of fs.readFileSync(logFile, 'utf8').split('\n')) {
		const m = /^(\d\d:\d\d:\d\d) ([\d.]+) ([\d.]+) ([\d.]+)(?: avail=(\d+)G)?(?: mine=(\d+))?(?: all=(\d+))?/.exec(ln.trim());
		if (!m) continue;
		let t = daySec(m[1]);
		if (last >= 0 && t + day < last - 43200) day += 86400;
		t += day; last = t;
		pts.push({ t, l1: +m[2], avail: m[5] === undefined ? null : +m[5], all: m[7] === undefined ? null : +m[7] });
	}
}
if (!pts.length) { console.error('no load lines in ' + logFile); process.exit(2); }
const t0 = pts[0].t, dayOf = (ms) => { const d = new Date(ms); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + d.getUTCMilliseconds() / 1000; };
// an mtime (ms) on the log's axis: its seconds of day, moved by whole days to the nearest of the log's span
const onAxis = (ms) => { let t = dayOf(ms); while (t < t0 - 43200) t += 86400; return t; };
function loadIn(a, b) {
	const ins = pts.filter((p) => p.t >= a && p.t <= b);
	if (ins.length) return { l1: ins.reduce((s, p) => s + p.l1, 0) / ins.length, avail: Math.min(...ins.map((p) => (p.avail === null ? Infinity : p.avail))), n: ins.length };
	let best = pts[0];
	for (const p of pts) if (Math.abs(p.t - (a + b) / 2) < Math.abs(best.t - (a + b) / 2)) best = p;
	return { l1: best.l1, avail: best.avail, n: 0 };
}
const readRows = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const want = arg('levels') ? new Set(fs.readFileSync(arg('levels'), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) : null;
const bands = arg('bands', '100,140,170').split(',').map(Number);
const bandOf = (l) => { let i = 0; while (i < bands.length && l >= bands[i]) i++; return i; };
const bandName = (i) => (i === 0 ? `< ${bands[0]}` : i === bands.length ? `>= ${bands[i - 1]}` : `${bands[i - 1]}-${bands[i]}`);
const out = [];
for (const s of argsAll('run')) {
	const i = s.indexOf(':'), label = s.slice(0, i), dir = s.slice(i + 1);
	const seen = new Map();
	for (const ix of readRows(path.join(dir, 'index.jsonl'))) seen.set(ix.rel, ix);
	for (const ix of seen.values()) {
		if (want && !want.has(ix.rel)) continue;
		let r = null, end = null;
		try { r = JSON.parse(fs.readFileSync(path.join(dir, ix.id + '.json'), 'utf8')); } catch (e) { r = null; }
		try { end = onAxis(fs.statSync(path.join(dir, ix.id + '.log')).mtimeMs); } catch (e) { end = null; }
		const ok = !!(r && r.ok && r.runTicks > 0);
		const L = end === null ? null : loadIn(end - (ix.sec || 0), end);
		out.push({ run: label, rel: ix.rel, ok, runTicks: ok ? r.runTicks : null, sec: ix.sec, load: L ? +L.l1.toFixed(1) : null, availMin: L ? L.avail : null });
	}
}
const nm = (rel) => path.basename(rel, '.eelvl');
const lines = [];
lines.push(`# The box load beside each compile (${path.basename(logFile)}: ${pts.length} lines, load1 ${Math.min(...pts.map((p) => p.l1)).toFixed(0)}-${Math.max(...pts.map((p) => p.l1)).toFixed(0)})`, '');
for (const label of [...new Set(out.map((r) => r.run))]) {
	const rs = out.filter((r) => r.run === label && r.load !== null);
	lines.push(`## ${label}: ${rs.filter((r) => r.ok).length} / ${rs.length} compiled`, '', '| load1 band | levels | compiled | rate |', '|---|---|---|---|');
	for (let b = 0; b <= bands.length; b++) {
		const x = rs.filter((r) => bandOf(r.load) === b);
		if (x.length) lines.push(`| ${bandName(b)} | ${x.length} | ${x.filter((r) => r.ok).length} | ${(x.filter((r) => r.ok).length / x.length).toFixed(2)} |`);
	}
	lines.push('');
}
if (want) {
	lines.push('## The levels asked for, run by run', '', '| level | ' + [...new Set(out.map((r) => r.run))].join(' | ') + ' |', '|---|' + [...new Set(out.map((r) => r.run))].map(() => '---|').join(''));
	for (const rel of [...new Set(out.map((r) => r.rel))].sort()) {
		lines.push(`| ${nm(rel)} | ` + [...new Set(out.map((r) => r.run))].map((lab) => { const r = out.find((q) => q.run === lab && q.rel === rel); return r ? `${r.ok ? r.runTicks : '-'} @ ${r.load === null ? '?' : r.load.toFixed(0)}` : ''; }).join(' | ') + ' |');
	}
	lines.push('');
}
const md = lines.join('\n');
if (arg('md')) fs.writeFileSync(arg('md'), md + '\n');
if (arg('json')) fs.writeFileSync(arg('json'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(md);
