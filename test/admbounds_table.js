'use strict';
// test/admbounds_table.js: the table of test/admbounds_truth.js's results (the jsonl files it wrote with --out).
// usage: node test/admbounds_table.js <r0.jsonl> [r1.jsonl ...] [--json=<summary.json>]
const fs = require('fs');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jsonOut = (process.argv.find((a) => a.startsWith('--json=')) || '').slice(7) || null;
const rows = [];
for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch (e) { /* partial */ } }
const ok = rows.filter((r) => !r.error && !r.stale);
const q = (a, p) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const out = { routes: rows.length, ok: ok.length, errors: rows.filter((r) => r.error).map((r) => ({ name: r.name, error: String(r.error).split('\n')[0] })), stale: rows.filter((r) => r.stale).length };
// violations
const NAMES = ['adm', 'fb', 'prim', 'eg', 'max'];
const viol = {}, checks = {}, worst = {};
for (const b of NAMES) { viol[b] = 0; checks[b] = 0; worst[b] = []; }
for (const r of ok) for (const kind of ['tick', 'pair', 'leg']) for (const b of NAMES) {
	const g = r[kind] && r[kind][b];
	if (!g) continue;
	if (kind !== 'leg') { viol[b] += g.viol; checks[b] += g.n; }
	for (const w of g.worst) if (kind !== 'leg' && worst[b].length < 40) worst[b].push(Object.assign({ name: r.name, route: r.route, kind }, w));
}
out.violations = viol; out.checks = checks; out.worst = worst;
// leg tightness (the segment start's bound over the leg's ticks), legs of 10+ ticks
const legR = { adm: [], prim: [], eg: [], maxAP: [], maxAll: [] };
for (const r of ok) for (const l of r.legs) {
	const [a, bA, bP, bE] = l;
	if (a < 10) continue;
	legR.adm.push(bA / a);
	if (bP !== null) legR.prim.push(bP / a);
	if (bE !== null) legR.eg.push(bE / a);
	legR.maxAP.push(Math.max(bA, bP || 0) / a);
	legR.maxAll.push(Math.max(bA, bP || 0, bE || 0) / a);
}
out.legs = {};
for (const k of Object.keys(legR)) out.legs[k] = { n: legR[k].length, p10: q(legR[k], 0.1), median: q(legR[k], 0.5), p90: q(legR[k], 0.9), mean: legR[k].reduce((s, x) => s + x, 0) / Math.max(1, legR[k].length) };
// legs by length band
const bands = [[10, 50], [50, 200], [200, 1000], [1000, 1e9]];
out.legBands = bands.map(([lo, hi]) => {
	const sel = [];
	for (const r of ok) for (const l of r.legs) if (l[0] >= lo && l[0] < hi) sel.push(l);
	const m = (f) => q(sel.map(f), 0.5);
	return { lo, hi, n: sel.length, adm: m((l) => l[1] / l[0]), prim: m((l) => (l[2] || 0) / l[0]), maxAP: m((l) => Math.max(l[1], l[2] || 0) / l[0]) };
});
// tick-level tightness from the histograms (bucket midpoints)
out.tick = {};
for (const b of NAMES) {
	const h = new Array(21).fill(0);
	let n = 0, s = 0;
	for (const r of ok) { const g = r.tick && r.tick[b]; if (!g) continue; g.hist.forEach((c, i) => { h[i] += c; }); s += g.sumR; n += g.hist.reduce((x, y) => x + y, 0); }
	const qh = (p) => { let acc = 0; const tgt = p * n; for (let i = 0; i < 21; i++) { acc += h[i]; if (acc >= tgt) return i / 20 + 0.025; } return 1; };
	out.tick[b] = { n, mean: n ? s / n : NaN, p10: qh(0.1), median: qh(0.5), p90: qh(0.9) };
}
// global (relaxed start -> finish) and the sum of the leg bounds (the order known)
const gA = ok.map((r) => r.globalB.adm / r.complete), gP = ok.filter((r) => r.globalB.prim !== null).map((r) => r.globalB.prim / r.complete);
const sA = ok.map((r) => r.sumLegs.adm / r.complete), sP = ok.filter((r) => r.sumLegs.prim !== null).map((r) => r.sumLegs.prim / r.complete);
const sM = ok.map((r) => r.legs.reduce((s, l) => s + Math.max(l[1], l[2] || 0, l[3] || 0), 0) / r.complete);
out.global = { adm: { p10: q(gA, 0.1), median: q(gA, 0.5), p90: q(gA, 0.9) }, prim: { p10: q(gP, 0.1), median: q(gP, 0.5), p90: q(gP, 0.9) } };
out.sumLegs = { adm: { p10: q(sA, 0.1), median: q(sA, 0.5), p90: q(sA, 0.9) }, prim: { p10: q(sP, 0.1), median: q(sP, 0.5), p90: q(sP, 0.9) }, maxAll: { p10: q(sM, 0.1), median: q(sM, 0.5), p90: q(sM, 0.9) } };
// levels: tame share
out.tame = { routes: ok.length, tameLevel: ok.filter((r) => r.tame).length, upOk: ok.filter((r) => r.upOk).length, srcFracMedian: q(ok.map((r) => r.srcFrac), 0.5) };
out.ms = { adm: ok.reduce((s, r) => s + r.admMs, 0), prim: ok.reduce((s, r) => s + r.primMs, 0), total: ok.reduce((s, r) => s + r.ms, 0) };
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
console.log(`routes ${out.routes} ok ${out.ok} errors ${out.errors.length} stale ${out.stale}`);
console.log(`violations (tick + pair checks): ${NAMES.map((b) => `${b} ${viol[b]} / ${checks[b]}`).join(', ')}`);
console.log('leg bound / actual (legs >= 10 ticks, at the segment start):');
for (const k of Object.keys(out.legs)) { const o = out.legs[k]; console.log(`  ${k.padEnd(7)} n ${String(o.n).padStart(6)}  p10 ${f2(o.p10)}  median ${f2(o.median)}  p90 ${f2(o.p90)}  mean ${f2(o.mean)}`); }
console.log('  by leg length (median adm / prim / max):');
for (const b of out.legBands) console.log(`    [${b.lo}, ${b.hi === 1e9 ? 'inf' : b.hi}) n ${b.n}: ${f2(b.adm)} / ${f2(b.prim)} / ${f2(b.maxAP)}`);
console.log('every tick of every segment (bound / ticks left, left >= 10; bucket medians):');
for (const b of NAMES) { const o = out.tick[b]; console.log(`  ${b.padEnd(5)} n ${String(o.n).padStart(9)}  p10 ${f2(o.p10)}  median ${f2(o.median)}  p90 ${f2(o.p90)}  mean ${f2(o.mean)}`); }
console.log(`global relaxed start -> finish: adm median ${f2(out.global.adm.median)} (p10 ${f2(out.global.adm.p10)}), prim median ${f2(out.global.prim.median)} (p10 ${f2(out.global.prim.p10)})`);
console.log(`sum of the leg bounds / finish: adm median ${f2(out.sumLegs.adm.median)} (p10 ${f2(out.sumLegs.adm.p10)}), prim ${f2(out.sumLegs.prim.median)} (p10 ${f2(out.sumLegs.prim.p10)}), max(adm, prim, eg) ${f2(out.sumLegs.maxAll.median)} (p10 ${f2(out.sumLegs.maxAll.p10)})`);
console.log(`tame levels ${out.tame.tameLevel} / ${out.tame.routes}, up tier ${out.tame.upOk}, source share median ${f2(out.tame.srcFracMedian)}; field ms adm ${out.ms.adm} prim ${out.ms.prim}`);
for (const b of NAMES) if (viol[b]) { console.log(`worst ${b}:`); for (const w of worst[b].slice(0, 12)) console.log(`  ${JSON.stringify(w)}`); }
if (out.errors.length) { console.log('errors:'); for (const e of out.errors.slice(0, 10)) console.log(`  ${e.name}: ${e.error}`); }
