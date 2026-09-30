'use strict';
// n4u-moves: the tables of the move study from moves.js's JSONL (node src/plan/understand/moves_agg.js <dir> [--json=out]).
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const jsonOut = (process.argv.find((a) => a.startsWith('--json=')) || '').slice(7);
const moves = [], routes = [];
for (const f of fs.readdirSync(dir)) {
	if (/^moves_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) moves.push(JSON.parse(l));
	if (/^routes_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) routes.push(JSON.parse(l));
}
const okR = routes.filter((r) => !r.stale && !r.err);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
const q = (arr, p) => { if (!arr.length) return '-'; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const out = {};
const P = (...a) => console.log(...a);
P(`routes ${routes.length} (ok ${okR.length}, stale ${routes.filter((r) => r.stale).length}, err ${routes.filter((r) => r.err).length}), levels ${new Set(okR.map((r) => r.name)).size}, moves ${moves.length}, ticks ${okR.reduce((s, r) => s + r.ticks, 0)}`);
const LABELS = ['walk', 'jump', 'hop', 'hopjump', 'fall', 'airjump', 'arrow', 'boost', 'swim', 'climb', 'dot', 'portal', 'death', 'respawn'];
const totT = moves.reduce((s, m) => s + m.len, 0);
P('\n== 1. classes: moves, ticks, length (median / p90), raw direction runs (median / p90), essential direction runs (median / p90), capped');
P('class      moves   %mov   %ticks  len50 len90  raw50 raw90  ess50 ess90  capped');
out.classes = {};
for (const lb of LABELS) {
	const ms = moves.filter((m) => m.label === lb && !m.bad);
	if (!ms.length) continue;
	const t = ms.reduce((s, m) => s + m.len, 0);
	const row = { n: ms.length, pm: +pct(ms.length, moves.length), pt: +pct(t, totT), len50: q(ms.map((m) => m.len), 0.5), len90: q(ms.map((m) => m.len), 0.9),
		raw50: q(ms.map((m) => m.rawDirRuns), 0.5), raw90: q(ms.map((m) => m.rawDirRuns), 0.9), ess50: q(ms.map((m) => m.essDirRuns), 0.5), ess90: q(ms.map((m) => m.essDirRuns), 0.9), capped: +pct(ms.filter((m) => m.capped).length, ms.length) };
	out.classes[lb] = row;
	P(`${lb.padEnd(9)} ${String(row.n).padStart(6)} ${String(row.pm).padStart(6)} ${String(row.pt).padStart(7)}  ${String(row.len50).padStart(5)} ${String(row.len90).padStart(5)}  ${String(row.raw50).padStart(5)} ${String(row.raw90).padStart(5)}  ${String(row.ess50).padStart(5)} ${String(row.ess90).padStart(5)}  ${row.capped}%`);
}
P(`bad (canonical masks changed the end state): ${moves.filter((m) => m.bad).length}`);

P('\n== 2. coverage of F_k = "at most k direction changes (any tick), jump presses free" (essential k from the greedy simplification: an upper bound of the minimum, so these are LOWER bounds of the coverage)');
P('class      k<=0   k<=1   k<=2   k<=3   k<=4   k<=6   k<=8   | air k<=0  <=1  <=2  <=3 | ground k<=0 <=1 <=2');
out.cover = {};
const ks = [0, 1, 2, 3, 4, 6, 8];
for (const lb of [...LABELS, 'ALL', 'ALL-no-respawn']) {
	const ms = moves.filter((m) => !m.bad && (lb === 'ALL' || (lb === 'ALL-no-respawn' ? m.label !== 'respawn' : m.label === lb)));
	if (!ms.length) continue;
	const c = ks.map((k) => +pct(ms.filter((m) => m.essDirRuns - 1 <= k).length, ms.length));
	const ca = [0, 1, 2, 3].map((k) => +pct(ms.filter((m) => m.aChanges <= k).length, ms.length));
	const cg = [0, 1, 2].map((k) => +pct(ms.filter((m) => m.gChanges <= k).length, ms.length));
	out.cover[lb] = { all: c, air: ca, ground: cg };
	P(`${lb.padEnd(9)} ${c.map((x) => String(x).padStart(6)).join(' ')}   | ${ca.map((x) => String(x).padStart(5)).join(' ')} | ${cg.map((x) => String(x).padStart(5)).join(' ')}`);
}
// tick-weighted coverage
{
	const ms = moves.filter((m) => !m.bad && m.label !== 'respawn');
	const tt = ms.reduce((s, m) => s + m.len, 0);
	const c = ks.map((k) => +pct(ms.filter((m) => m.essDirRuns - 1 <= k).reduce((s, m) => s + m.len, 0), tt));
	out.coverTicks = c;
	P(`ticks-weighted (no respawn): ${c.join(' / ')}`);
}
P('\n== 2b. jump presses per move (essential) and their lengths');
{
	const ms = moves.filter((m) => !m.bad);
	const h = {}; for (const m of ms) h[m.essJumpRuns] = (h[m.essJumpRuns] || 0) + 1;
	P('essential jump runs per move:', JSON.stringify(h));
	const lens = {}; for (const m of ms) for (const l of m.essJumpLens) { const b = l >= 20 ? '20+' : l >= 5 ? '5-19' : String(l); lens[b] = (lens[b] || 0) + 1; }
	P('essential jump run lengths:', JSON.stringify(lens));
	out.jumpRuns = h; out.jumpLens = lens;
}
P('\n== 3. timing: essential change points with NO +-1 tick slack (a 1-tick shift breaks the exact end state)');
{
	for (const lb of ['walk', 'jump', 'fall', 'airjump', 'arrow', 'dot', 'swim', 'climb', 'boost', 'portal', 'death']) {
		const ms = moves.filter((m) => m.label === lb);
		const s0 = ms.reduce((s, m) => s + m.slack0, 0), sa = ms.reduce((s, m) => s + m.slackAny, 0);
		if (s0 + sa) P(`${lb.padEnd(8)} change points ${s0 + sa}: no slack ${pct(s0, s0 + sa)}%`);
	}
	const s0 = moves.reduce((s, m) => s + m.slack0, 0), sa = moves.reduce((s, m) => s + m.slackAny, 0);
	out.noSlack = +pct(s0, s0 + sa);
	P(`ALL      change points ${s0 + sa}: no slack ${out.noSlack}%`);
}
P('\n== 4. the primitives builder family (origin/n4plan-primitives 2e70a92) vs per-tick shapes, from the route\'s own takeoff');
{
	const lands = moves.filter((m) => m.endKind === 'land');
	P(`landings ${lands.length}: with a HOP (jump pressed on the landing tick itself) ${lands.filter((m) => m.hopEnd).length} (${pct(lands.filter((m) => m.hopEnd).length, lands.length)}%); ground-start moves launched by a hop ${moves.filter((m) => m.hopStart).length} of ${moves.filter((m) => m.c0 === 'G').length}`);
	out.hops = { lands: lands.length, hopEnd: +pct(lands.filter((m) => m.hopEnd).length, lands.length) };
	for (const lb of ['jump', 'hop', 'fall']) {
		const ms = moves.filter((m) => m.label === lb && m.plainFx === 1 && (lb !== 'jump' || m.jumps === 1));
		const asIs = ms.filter((m) => m.builderHit).length, withHop = ms.filter((m) => m.builderHopHit).length, t1 = ms.filter((m) => m.tick1Hit).length;
		const hopE = ms.filter((m) => m.hopEnd).length;
		P(`${lb.padEnd(5)} plain moves ${ms.length} (end in a hop ${pct(hopE, ms.length)}%): builder macro as is ${pct(asIs, ms.length)}% | builder macro + hop start/end option ${pct(withHop, ms.length)}%` + (lb !== 'fall' ? ` | per-tick <= 1 air change + hop ${pct(t1, ms.length)}% | essential air changes <= 1 ${pct(ms.filter((m) => m.aChanges <= 1).length, ms.length)}%, <= 2 ${pct(ms.filter((m) => m.aChanges <= 2).length, ms.length)}%, <= 3 ${pct(ms.filter((m) => m.aChanges <= 3).length, ms.length)}%` : ` | essential air changes <= 0 ${pct(ms.filter((m) => m.aChanges <= 0).length, ms.length)}%, <= 1 ${pct(ms.filter((m) => m.aChanges <= 1).length, ms.length)}%, <= 2 ${pct(ms.filter((m) => m.aChanges <= 2).length, ms.length)}%`));
		out['fam_' + lb] = { n: ms.length, asIs: +pct(asIs, ms.length), withHop: +pct(withHop, ms.length), tick1: +pct(t1, ms.length) };
		const cs = ms.filter((m) => m.tick1Hit && m.tick1Hit.startsWith('c1')).map((m) => +m.tick1Hit.split('@')[1]);
		if (cs.length) {
			const kinds = {}; for (const m of ms) if (m.tick1Hit && m.tick1Hit.startsWith('c1')) { const [d0, d1] = m.tick1Hit.slice(3).split('@')[0].split('>').map(Number); const k = d1 === 0 ? 'release' : d0 === 0 ? 'late-hold' : 'turn'; kinds[k] = (kinds[k] || 0) + 1; }
			P(`      one-change hits by kind ${JSON.stringify(kinds)}; change tick median ${q(cs, 0.5)} p90 ${q(cs, 0.9)}; on the builder's grid {2,4,8,12,16,24}: ${pct(cs.filter((c) => [2, 4, 8, 12, 16, 24].includes(c)).length, cs.length)}%`);
		}
	}
	const J = moves.filter((m) => m.label === 'jump' && m.jumps === 1 && m.plainFx === 1);
	const jb = J.filter((m) => m.builderHit).length, j1 = J.filter((m) => m.tick1Hit).length;
	const jEss = J.filter((m) => m.aChanges <= 1).length;
	P(`single-jump moves on plain support: ${J.length}; one builder JUMP macro exact: ${jb} (${pct(jb, J.length)}%); per-tick <=1 air change (exhaustive: d0 at the press, d1 from tick c, d in {-,L,R}): ${j1} (${pct(j1, J.length)}%); essential air changes <= 1: ${pct(jEss, J.length)}%`);
	const hitNames = {}; for (const m of J) if (m.builderHit) hitNames[m.builderHit] = (hitNames[m.builderHit] || 0) + 1;
	P('builder hits by macro:', JSON.stringify(hitNames));
	const t1n = { c0: 0, c1: 0 }; for (const m of J) if (m.tick1Hit) t1n[m.tick1Hit.slice(0, 2)]++;
	P('per-tick hits: constant', t1n.c0, 'one change', t1n.c1);
	// the change tick c of the per-tick hits: on the builder's grid?
	const cs = J.filter((m) => m.tick1Hit && m.tick1Hit.startsWith('c1')).map((m) => +m.tick1Hit.split('@')[1]);
	const onGrid = cs.filter((c) => [2, 4, 8, 12, 16, 24].includes(c)).length;
	P(`per-tick one-change hits: change tick median ${q(cs, 0.5)} p90 ${q(cs, 0.9)} max ${q(cs, 1)}; on the builder's grid {2,4,8,12,16,24}: ${pct(onGrid, cs.length)}%`);
	const airN = J.map((m) => m.airN);
	P(`air ticks (press -> next support): median ${q(airN, 0.5)} p90 ${q(airN, 0.9)}`);
	const Fm = moves.filter((m) => m.label === 'fall' && m.c0 === 'G' && m.plainFx === 1);
	const fb = Fm.filter((m) => m.builderHit).length;
	P(`walk-off falls on plain support: ${Fm.length}; one builder WALKOFF macro (from any of the last 48 ground ticks) exact: ${fb} (${pct(fb, Fm.length)}%); essential air changes <= 0: ${pct(Fm.filter((m) => m.aChanges === 0).length, Fm.length)}%, <= 1: ${pct(Fm.filter((m) => m.aChanges <= 1).length, Fm.length)}%`);
	out.builder = { jumpMoves: J.length, jumpBuilder: +pct(jb, J.length), jumpTick1: +pct(j1, J.length), jumpEss1: +pct(jEss, J.length), falls: Fm.length, fallBuilder: +pct(fb, Fm.length) };
	// multi-jump moves
	const J2 = moves.filter((m) => m.label === 'jump' && m.jumps > 1);
	P(`jump moves with > 1 jump (rejump on landing inside one move / multijump): ${J2.length}`);
}
P('\n== 5. support quantisation: start perturbed inside a class, the route\'s inputs replayed: X = the same exact state, c = same tile + ground + |dpx| < 1 + |dvx| < 1/16, t = same tile + ground only, - = other');
{
	const keys = ['px1e-9', 'px1/64', 'px1/4', 'vx1/256', 'vx1/32'];
	out.quant = {};
	for (const lb of ['ALL', 'walk', 'jump', 'fall', 'arrow', 'dot', 'swim', 'climb', 'portal', 'boost']) {
		const ms = moves.filter((m) => m.q && (lb === 'ALL' || m.label === lb));
		if (!ms.length) continue;
		const row = {};
		for (const k of keys) { const h = { X: 0, c: 0, t: 0, '-': 0 }; for (const m of ms) h[m.q[k]]++; row[k] = h; }
		out.quant[lb] = row;
		P(`${lb.padEnd(7)} n=${ms.length}  ` + keys.map((k) => `${k}: X${pct(row[k].X, ms.length)} c${pct(row[k].c, ms.length)} t${pct(row[k].t, ms.length)}`).join(' | '));
	}
}
P('\n== 6. support states: how canonical are the move starts (landings etc.)');
{
	const ms = moves.filter((m) => m.c0 === 'G');
	const vx0 = ms.filter((m) => m.vx0 === 0).length, pxInt = ms.filter((m) => m.px0 === Math.floor(m.px0)).length, pyInt = ms.filter((m) => m.py0 === Math.floor(m.py0)).length;
	P(`ground starts ${ms.length}: vx = 0 ${pct(vx0, ms.length)}%, px integer ${pct(pxInt, ms.length)}%, py integer ${pct(pyInt, ms.length)}%, vy = 0 ${pct(ms.filter((m) => m.vy0 === 0).length, ms.length)}%`);
	const vxs = ms.map((m) => Math.abs(m.vx0));
	P(`|vx| at ground starts: median ${(+q(vxs, 0.5)).toFixed(3)} p90 ${(+q(vxs, 0.9)).toFixed(3)}; distinct exact (px, vx) pairs ${new Set(ms.map((m) => m.px0 + ',' + m.vx0)).size}; distinct (tile, round(vx*16)) ${new Set(ms.map((m) => m.tile0 + ',' + Math.round(m.vx0 * 16))).size}; distinct (tile, round(vx*2)) ${new Set(ms.map((m) => m.tile0 + ',' + Math.round(m.vx0 * 2))).size}`);
	out.ground = { n: ms.length, vx0: +pct(vx0, ms.length), pxInt: +pct(pxInt, ms.length), pyInt: +pct(pyInt, ms.length) };
}
P('\n== 7. table sizes per level (states x inputs): standable cells (free tile over a solid), speed classes, family members');
{
	const byLevel = new Map();
	for (const r of okR) if (!byLevel.has(r.name)) byLevel.set(r.name, r);
	const st = [...byLevel.values()].map((r) => r.stand);
	P(`levels ${byLevel.size}: standable cells median ${q(st, 0.5)} p90 ${q(st, 0.9)} max ${q(st, 1)}`);
	// family members: per-tick F_k over an air window A: 3 directions at the press x (2 new directions x A ticks)^k / k!
	const J = moves.filter((m) => m.label === 'jump' && m.airN);
	const A = +q(J.map((m) => m.airN), 0.9);
	const fam = (k) => { let n = 3; let c = 1; for (let i = 1; i <= k; i++) { c *= 2 * A / i; } return Math.round(n * c); };
	P(`air window A (p90 of the single-jump air ticks) = ${A}; per-tick F_k members from one takeoff: F0 ${fam(0)}, F1 ${fam(1)}, F2 ${fam(2)}, F3 ${fam(3)}`);
	P(`the builder's plain family: ${1 + 2 * 7 + 2 * 3} JUMP + 4 WALKOFF + 22 RUN + 5 IDLE = ${1 + 14 + 6 + 4 + 22 + 5} macros per node`);
	const vxClasses = 109;   // tables.js VX0: -6.75..6.75 in 1/8
	P(`states x inputs per level (median standable ${q(st, 0.5)} x ${vxClasses} vx classes): F1 ${(+q(st, 0.5) * vxClasses * fam(1)).toExponential(2)}, F2 ${(+q(st, 0.5) * vxClasses * fam(2)).toExponential(2)} (each an up-to-A-tick simulation)`);
	out.table = { standMedian: +q(st, 0.5), standP90: +q(st, 0.9), A, F: [fam(0), fam(1), fam(2), fam(3)] };
}
P('\n== 8. per-source split (jobs = the user\'s TASes, god = the AutoTAS benchmark runs): essential k <= 1 / <= 2 / <= 3, no respawn');
for (const src of ['job', 'god']) {
	const ids = new Set(okR.filter((r) => r.source === src).map((r) => r.idx));
	const ms = moves.filter((m) => ids.has(m.r) && !m.bad && m.label !== 'respawn');
	P(`${src}: moves ${ms.length}: ${[1, 2, 3].map((k) => pct(ms.filter((m) => m.essDirRuns - 1 <= k).length, ms.length)).join(' / ')}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
