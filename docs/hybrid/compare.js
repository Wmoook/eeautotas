'use strict';
// THE MEASUREMENT's comparison (n5-hy-best): H (tools/hybrid_batch.js results.jsonl: the hybrid with the early stops) vs
//   C    = this morning's paired 300-s compile of main (AB.jsonl, the B arm),
//   C900 = C plus the 15 levels the 900-s scoreboard (n5-plan 04ecf95) routed (score900_04ecf95.md: its best route),
//   S    = the baseline's search alone at 600 s (v1.7.1, K12 W5; results.jsonl of sweep_n3.js; 213 of the 230 run),
//   C u S, C900 u S (the faster of the two per level).
// Quality: the final route's run ticks / the best known (AB.jsonl best). Prints Markdown; --json=<f> writes the per-level rows.
//   node docs/hybrid/compare.js <H results.jsonl> <AB.jsonl> <S600 results.jsonl> <manifest_ab.json> [--verify=<verify.js output>] [--json=<rows.jsonl>]
const fs = require('fs');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
const [hF, abF, sF, manF] = args;
const jl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const AB = jl(abF);
const man = JSON.parse(fs.readFileSync(manF, 'utf8'));
const nameOf = new Map(man.map((m) => [m.rel, m.name]));
const relOfMd5 = new Map(man.map((m) => [m.md5, m.rel]));
const S = new Map();
for (const r of jl(sF)) { const rel = relOfMd5.get(r.md5); if (rel) S.set(rel, r); }
const H = new Map();
for (const r of jl(hF)) H.set(r.rel, r);   // (the last line of a level wins)
// (the 900-s scoreboard's 15: their best route, run ticks)
const C900X = { 'campaign/13_2_One_Minute_Descent.eelvl': 5123, 'campaign/35_5_Relics_Of_Athena.eelvl': 5674, 'campaign/08_1_Aperture_Science_Lab.eelvl': 5180,
	'campaign/27_2_Presto_Penguins.eelvl': 2911, 'campaign/14_2_The_Burj.eelvl': 3888, 'campaign/29_1_EXCrew_Trolled_Minis.eelvl': 8264, 'campaign/36_1_Inferno.eelvl': 7222,
	'campaign/29_3_Two.eelvl': 1598, 'campaign/16_1_The_Tunnels.eelvl': 23379, 'campaign/11_4_Lab_of_Insanity.eelvl': 8016, 'campaign/29_2_YMCK_Puzzle_Parade.eelvl': 14283,
	'campaign/12_1_Pretty_How_Town.eelvl': 14391, 'campaign/19_2_Chain_Link_Clamber.eelvl': 12878, 'campaign/36_5_Escape_the_Lava.eelvl': 16242, 'campaign/22_1_Ring_Of_Chaos.eelvl': 16566 };
const verified = new Map();
if (opt.verify) for (const l of fs.readFileSync(opt.verify, 'utf8').split('\n')) { const m = /^(ok  |FAIL) (\S+\.eelvl): .*?(finishes, (\d+) run ticks|does NOT finish)/.exec(l); if (m) verified.set(m[2], m[1] === 'ok  ' ? +m[4] : null); }

const rows = AB.map((a) => {
	const h = H.get(a.rel), s = S.get(a.rel);
	const c = a.B && a.B.compiled ? a.B.ticks : null;
	const c900 = c != null ? Math.min(c, C900X[a.rel] || Infinity) : (C900X[a.rel] || null);
	const sT = s && s.routed ? s.finalTicks : null;
	let hT = h && h.routed && h.final ? h.final.runTicks : null;
	if (hT != null && opt.verify && verified.get(a.rel) !== hT) hT = null;   // (only a route the verify replayed to its ticks counts)
	const min = (...v) => { const x = v.filter((q) => q != null); return x.length ? Math.min(...x) : null; };
	return { rel: a.rel, name: nameOf.get(a.rel) || a.rel, set: a.rel.split('/')[0], best: a.best || null, H: hT, C: c, C900: c900, S: sT, CS: min(c, sT), C900S: min(c900, sT), sRan: !!s,
		hFirst: h && h.first && hT != null ? h.first : null, sFirst: s && s.routed ? s.firstRouteS : null, hStop: h && h.stop ? h.stop.why : (h ? 'none' : 'not run'), hStopT: h && h.stop ? h.stop.t : null,
		hWall: h ? h.wallS : null, hFinalBy: h && h.final ? h.final.by : null, hLeg: h && h.compiler && h.compiler.hybrid ? h.compiler.hybrid : null, hLastProg: h ? h.lastProgress : null, hRun: !!h };
});
const pct = (v, p) => { if (!v.length) return null; const s = [...v].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const med = (v) => { if (!v.length) return null; const s = [...v].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const geo = (v) => (v.length ? Math.exp(v.reduce((t, x) => t + Math.log(x), 0) / v.length) : null);
const f3 = (x) => (x == null ? '-' : x.toFixed(3));
const f1 = (x) => (x == null ? '-' : x.toFixed(1));
const n = (k, f = () => true) => rows.filter((r) => f(r) && r[k] != null).length;
const ARMS = ['H', 'C', 'C900', 'S', 'CS', 'C900S'];
const LABEL = { H: 'H (the hybrid, early stops)', C: 'C (compile 300 s, AB B)', C900: 'C900 (C + the 900-s scoreboard)', S: 'S (search alone 600 s)', CS: 'C u S', C900S: 'C900 u S' };
const out = [];
const P = (s) => out.push(s);
P('| arm | all 230 | campaign 203 | hard 25 | d4 2 | on the 213 S ran |');
P('|---|---|---|---|---|---|');
for (const k of ARMS) P(`| ${LABEL[k]} | ${n(k)} | ${n(k, (r) => r.set === 'campaign')} | ${n(k, (r) => r.set === 'hard')} | ${n(k, (r) => r.set === 'd4')} | ${n(k, (r) => r.sRan)} |`);
P('');
const list = (f) => rows.filter(f).map((r) => r.name);
const gl = (ref) => ({ gained: list((r) => r.H != null && r[ref] == null), lost: list((r) => r.H == null && r[ref] != null) });
P('| H vs | gained (H routes, it does not) | lost (it routes, H does not) | net |');
P('|---|---|---|---|');
const GL = {};
for (const k of ['C', 'C900', 'S', 'CS', 'C900S']) { const g = gl(k); GL[k] = g; P(`| ${LABEL[k]} | ${g.gained.length} | ${g.lost.length} | ${g.gained.length - g.lost.length >= 0 ? '+' : ''}${g.gained.length - g.lost.length} |`); }
P('');
P('| arm | routed with a best known | median ratio | geo mean | at / under the best known | within 5% |');
P('|---|---|---|---|---|---|');
for (const k of ARMS) {
	const r = rows.filter((q) => q[k] != null && q.best).map((q) => q[k] / q.best);
	P(`| ${LABEL[k]} | ${r.length} | ${f3(med(r))} | ${f3(geo(r))} | ${r.filter((x) => x <= 1).length} | ${r.filter((x) => x <= 1.05).length} |`);
}
P('');
P('| head to head (both routed) | levels | geo H / ref | H faster | ref faster | tie |');
P('|---|---|---|---|---|---|');
for (const k of ['C', 'C900', 'S', 'CS', 'C900S']) {
	const b = rows.filter((q) => q.H != null && q[k] != null);
	const r = b.map((q) => q.H / q[k]);
	P(`| ${LABEL[k]} | ${b.length} | ${f3(geo(r))} | ${b.filter((q) => q.H < q[k]).length} | ${b.filter((q) => q.H > q[k]).length} | ${b.filter((q) => q.H === q[k]).length} |`);
}
P('');
const hf = rows.filter((q) => q.hFirst).map((q) => q.hFirst.t), sf = rows.filter((q) => q.sFirst != null).map((q) => q.sFirst);
const both = rows.filter((q) => q.hFirst && q.sFirst != null);
P(`| first route | levels | median s | p90 s |`);
P('|---|---|---|---|');
P(`| H | ${hf.length} | ${f1(med(hf))} | ${f1(pct(hf, 0.9))} |`);
P(`| S | ${sf.length} | ${f1(med(sf))} | ${f1(pct(sf, 0.9))} |`);
P(`| H on the ${both.length} both routed | ${both.length} | ${f1(med(both.map((q) => q.hFirst.t)))} | ${f1(pct(both.map((q) => q.hFirst.t), 0.9))} |`);
P(`| S on the ${both.length} both routed | ${both.length} | ${f1(med(both.map((q) => q.sFirst)))} | ${f1(pct(both.map((q) => q.sFirst), 0.9))} |`);
P('');
const by = {};
for (const q of rows.filter((x) => x.hFirst)) by[q.hFirst.by] = (by[q.hFirst.by] || 0) + 1;
const fb = {};
for (const q of rows.filter((x) => x.H != null)) fb[q.hFinalBy] = (fb[q.hFinalBy] || 0) + 1;
const stops = {};
for (const q of rows.filter((x) => x.hRun)) stops[q.hStop] = (stops[q.hStop] || 0) + 1;
const legUsed = rows.filter((q) => q.hLeg && q.hLeg.requests > 0);
const walls = rows.filter((q) => q.hWall != null).map((q) => q.hWall);
const J = { counts: Object.fromEntries(ARMS.map((k) => [k, n(k)])), gl: GL, firstBy: by, finalBy: fb, stops, legLevels: legUsed.length,
	legOk: legUsed.reduce((t, q) => t + (q.hLeg.ok || 0), 0), legRoutes: legUsed.reduce((t, q) => t + (q.hLeg.routes || 0), 0), wallSum: walls.reduce((t, x) => t + x, 0), wallMed: med(walls),
	stalled: rows.filter((q) => q.hStop === 'stall').map((q) => q.name), capped: rows.filter((q) => q.hStop === 'cap' && q.H == null).map((q) => q.name), hRun: rows.filter((q) => q.hRun).length };
P('```json');
P(JSON.stringify(J, null, 1));
P('```');
console.log(out.join('\n'));
if (opt.json) fs.writeFileSync(opt.json, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
