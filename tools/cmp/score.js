'use strict';
// THE SCOREBOARD: one full compile (tools/cmp/fullc.js --json=1 --rss=1) as a table a level and the totals against earlier
// full compiles. Per level: compiled (a report with ok and, when --verify is given, the independent replay of the .eetas
// by tools/cmp/verify.js at the report's ticks), run ticks, the best known TAS (--best: a FINAL.jsonl with rel, best,
// bestSource), ticks / best known, the lower bound the compile proved (report lb) and PROVEN = the route's ticks equal
// that bound (report lbProof, or runTicks <= lb), the legs proven, the first route / 60 s / 180 s (the 'result' events).
//   node tools/cmp/score.js <dir> [--best=<FINAL.jsonl>] [--verify=<verify.js output>] [--cls=<classes.js json>]
//        [--base=<name>:<file>]... (a JSON array or jsonl of {rel, ok, runTicks}: the first one is the main line)
//        [--json=<out jsonl>] [--md=<out md>] [--title=<text>]
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const args = process.argv.slice(3);
const arg = (k) => (args.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);
const argsAll = (k) => args.filter((a) => a.startsWith('--' + k + '=')).map((a) => a.slice(k.length + 3));
const readRows = (f) => {
	const s = fs.readFileSync(f, 'utf8').trim();
	return s.startsWith('[') ? JSON.parse(s) : s.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};
const bestOf = new Map();
if (arg('best')) for (const r of readRows(arg('best'))) bestOf.set(r.rel, r);
const clsOf = new Map();
if (arg('cls')) for (const r of readRows(arg('cls'))) clsOf.set(r.rel, r);
const verified = new Map();   // rel -> true (replayed at the report's ticks) / false
if (arg('verify')) for (const l of fs.readFileSync(arg('verify'), 'utf8').split('\n')) { const m = l.match(/^(ok  |FAIL) (\S+\.eelvl):/); if (m) verified.set(m[2], m[1] === 'ok  '); }
const bases = argsAll('base').map((s) => { const i = s.indexOf(':'); const name = s.slice(0, i), f = s.slice(i + 1); return { name, rows: new Map(readRows(f).map((r) => [r.rel, r])) }; });
const okT = (r) => (r && r.ok && r.runTicks > 0 ? r.runTicks : null);
const med = (a) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const nm = (rel) => path.basename(rel, '.eelvl');
const idx = [];
for (const l of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) if (l.trim()) idx.push(JSON.parse(l));
const seen = new Map();
for (const ix of idx) seen.set(ix.rel, ix);   // a level run twice (a RAM-guard requeue) keeps its last row
const rows = [];
for (const ix of [...seen.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(path.join(dir, ix.id + '.json'), 'utf8')); } catch (e) { rep = null; }
	const res = [];
	const lp = path.join(dir, ix.id + '.log');
	if (fs.existsSync(lp)) for (const s of fs.readFileSync(lp, 'utf8').split('\n')) {
		if (!s.startsWith('{"ev":"result"') && !s.includes('"ev":"result"')) continue;
		try { const e = JSON.parse(s); if (e.ev === 'result' && e.kind === 'finish' && e.runTicks > 0) res.push({ t: e.t, runTicks: e.runTicks }); } catch (err) { /* a cut line */ }
	}
	const bestAt = (T0) => { const b = res.filter((x) => x.t <= T0); return b.length ? Math.min(...b.map((x) => x.runTicks)) : null; };
	const repOk = !!(rep && rep.ok && rep.runTicks > 0);
	const ver = verified.has(ix.rel) ? verified.get(ix.rel) : null;
	const ok = repOk && ver !== false;
	const kb = bestOf.get(ix.rel), C = clsOf.get(ix.rel);
	const legs = rep && Array.isArray(rep.legs) ? rep.legs : [];
	const lb = rep && rep.lb > 0 ? rep.lb : null;
	const row = {
		rel: ix.rel, set: ix.rel.split('/')[0], W: C ? C.W : null, H: C ? C.H : null, ok, verified: ver, runTicks: ok ? rep.runTicks : null,
		best: kb && kb.best ? kb.best : null, bestSource: kb ? kb.bestSource || '' : '', ratio: null, lb, lbComplete: !!(rep && rep.lbComplete),
		proven: !!(ok && ((rep.lbProof && rep.lbProof !== '') || (lb && rep.runTicks <= lb))), lbProof: rep && rep.lbProof ? rep.lbProof : '',
		overLb: null, legs: legs.length, provenLegs: legs.filter((g) => g.proven).length,
		first: res.length ? res[0].t : null, firstTicks: res.length ? res[0].runTicks : null, at60: bestAt(60), at180: bestAt(180),
		cls: ok ? 'COMPILED' : C ? C.cls : (rep ? 'FAILED' : 'CRASH'), gEnd: C ? C.gEnd : null, failLabel: C && !ok ? C.failLabel || '' : '',
		peakRssMB: ix.peakRssMB || null, sec: ix.sec, exit: ix.code,
	};
	if (ok && row.best) row.ratio = r3(row.runTicks / row.best);
	if (ok && lb) row.overLb = r3(row.runTicks / lb);
	for (const b of bases) { const o = b.rows.get(ix.rel); row[b.name] = okT(o); }
	rows.push(row);
}
const n = rows.length, ok = rows.filter((r) => r.ok);
const L = [];
const title = arg('title') || `THE SCOREBOARD: ${dir}`;
L.push(`# ${title}`, '');
L.push(`**Compiled ${ok.length} / ${n}** (every .eetas ${arg('verify') ? `replayed from the level file by tools/cmp/verify.js: ${rows.filter((r) => r.verified === true).length} ok, ${rows.filter((r) => r.verified === false).length} failed` : 'not replayed here'}).`, '');
L.push('| set | compiled | by 60 s | by 180 s |' + bases.map((b) => ` ${b.name} |`).join(''), '|---|---|---|---|' + bases.map(() => '---|').join(''));
for (const s of ['campaign', 'hard', 'd4', 'all']) {
	const a = s === 'all' ? rows : rows.filter((r) => r.set === s);
	if (!a.length) continue;
	L.push(`| ${s} | ${a.filter((r) => r.ok).length} / ${a.length} | ${a.filter((r) => r.ok && r.at60 !== null).length} | ${a.filter((r) => r.ok && r.at180 !== null).length} |` + bases.map((b) => ` ${a.filter((r) => r[b.name] !== null).length} |`).join(''));
}
L.push('');
L.push(`First route: median ${med(ok.map((r) => r.first))} s. Peak RSS a compile: median ${med(rows.map((r) => r.peakRssMB))} MB, max ${Math.max(0, ...rows.map((r) => r.peakRssMB || 0))} MB.`, '');
// TAS quality
const rat = ok.filter((r) => r.ratio !== null);
L.push('## TAS quality', '');
L.push(`- ticks / best known (${rat.length} compiled levels with a best known): **median ${r3(med(rat.map((r) => r.ratio)))}**; at or under the best known **${rat.filter((r) => r.ratio <= 1).length}**; within 10% ${rat.filter((r) => r.ratio <= 1.1).length}.`);
L.push(`- at or under: ${rat.filter((r) => r.ratio <= 1).sort((a, b) => a.ratio - b.ratio).map((r) => `${nm(r.rel)} ${r.runTicks} / ${r.best} = ${r.ratio}`).join('; ') || 'none'}.`);
L.push(`- PROVEN (the route's ticks equal a proven lower bound): **${ok.filter((r) => r.proven).length}**${ok.filter((r) => r.proven).length ? ': ' + ok.filter((r) => r.proven).map((r) => nm(r.rel)).join(', ') : ''}; legs proven ${ok.reduce((s, r) => s + r.provenLegs, 0)} / ${ok.reduce((s, r) => s + r.legs, 0)}; ticks / lower bound median ${r3(med(ok.map((r) => r.overLb)))}.`);
L.push(`- compiled with no best known: ${ok.filter((r) => r.best === null).length}${ok.filter((r) => r.best === null).length ? ' (' + ok.filter((r) => r.best === null).map((r) => `${nm(r.rel)} ${r.runTicks}`).join(', ') + ')' : ''}.`, '');
for (const b of bases) {
	const nw = rows.filter((r) => r.ok && r[b.name] === null), lost = rows.filter((r) => !r.ok && r[b.name] !== null), both = rows.filter((r) => r.ok && r[b.name] !== null);
	const f = both.filter((r) => r.runTicks < r[b.name]), s = both.filter((r) => r.runTicks > r[b.name]);
	const tn = both.reduce((a, r) => a + r.runTicks, 0), to = both.reduce((a, r) => a + r[b.name], 0);
	L.push(`## vs ${b.name}: ${ok.length} vs ${rows.filter((r) => r[b.name] !== null).length}`, '');
	L.push(`- NEW (${nw.length}): ${nw.map((r) => `${nm(r.rel)} ${r.runTicks}`).join('; ') || 'none'}`);
	L.push(`- LOST (${lost.length}): ${lost.map((r) => `${nm(r.rel)} (was ${r[b.name]}; now ${r.cls}${r.gEnd !== null ? ' g' + r.gEnd : ''})`).join('; ') || 'none'}`);
	if (both.length) L.push(`- both compiled ${both.length}: run ticks ${tn} vs ${to} (${((tn / to - 1) * 100).toFixed(1)}%), faster ${f.length} / slower ${s.length} / same ${both.length - f.length - s.length}; median ratio ${r3(med(both.map((r) => r.runTicks / r[b.name])))}`);
	const big = both.filter((r) => Math.abs(r.runTicks / r[b.name] - 1) >= 0.1).sort((x, y) => x.runTicks / x[b.name] - y.runTicks / y[b.name]);
	if (big.length) L.push(`- 10%+ apart: ${big.map((r) => `${nm(r.rel)} ${r.runTicks} vs ${r[b.name]}`).join('; ')}`);
	L.push('');
}
L.push('## Per level', '');
L.push('| level | compiled | run ticks | best known | ticks / best | lower bound | proven | legs proven | 60 s | 180 s | first s |' + bases.map((b) => ` ${b.name} |`).join('') + ' class / failure | peak MB |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|' + bases.map(() => '---|').join('') + '---|---|');
for (const r of rows) {
	L.push(`| ${r.rel.replace(/\.eelvl$/, '')} | ${r.ok ? 'yes' : 'no'} | ${r.ok ? `**${r.runTicks}**` : '-'} | ${r.best ?? '-'} | ${r.ratio ?? '-'} | ${r.lb ?? '-'} | ${r.proven ? '**PROVEN**' : r.ok ? 'no' : '-'} | ${r.ok ? `${r.provenLegs} / ${r.legs}` : '-'} | ${r.at60 ?? '-'} | ${r.at180 ?? '-'} | ${r.first ?? '-'} |` +
		bases.map((b) => ` ${r[b.name] ?? '-'} |`).join('') + ` ${r.ok ? '' : `${r.cls}${r.gEnd !== null ? ' g' + r.gEnd : ''}${r.failLabel ? ': ' + r.failLabel : ''}`} | ${r.peakRssMB ?? '-'} |`);
}
const md = L.join('\n') + '\n';
if (arg('md')) fs.writeFileSync(arg('md'), md);
if (arg('json')) fs.writeFileSync(arg('json'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(L.slice(0, L.indexOf('## Per level')).join('\n'));
