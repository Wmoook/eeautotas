// tools/cmp/planat.js: the planner's plan call from a dumped anchor's exact state (a diagnosis aid; fresh facts: no CEGAR
// cuts, no est walls), with the root's edges listed (label, est, relaxation-only, gain, landmarks left, the open walk to
// the trophy) so the partial plan's pick can be read against them.
// node tools/cmp/planat.js <level.eelvl> <anchors.jsonl (EEAT_ANCHOR_DUMP)> <anchor id> [ms=300] [reps=1]
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const B = require(path.join(root, 'src/plan/bounds.js'));
const F = require(path.join(root, 'src/plan/facts.js'));
const P = require(path.join(root, 'src/plan/planner.js'));
const GX = require(path.join(root, 'src/goexplore.js'));
const [file, dump, idArg, msArg, repsArg] = process.argv.slice(2);
const ms = +(msArg || 300), reps = +(repsArg || 1);
const L = T.loadLevelFile(file);
const model = M.compileModel(L, { file });
B.staticOf(L);
const bounds = B.createBounds(L, { model });
const facts = F.createFacts({ rungs: 4, model });
// (FACTS_FROM=<run.jsonl> [FACTS_UNTIL=<s>]: the run's failed steps as 'fail' facts (edge, class, rung, why, closest: the
// est walls; the CEGAR cuts are not in the events, so fewer walls than the compile had)
if (process.env.FACTS_FROM) {
	const until = +(process.env.FACTS_UNTIL || Infinity);
	let n = 0;
	for (const l of fs.readFileSync(process.env.FACTS_FROM, 'utf8').split('\n')) {
		let e; try { e = JSON.parse(l); } catch (err) { continue; }
		if (e.ev !== 'step' || e.ok || !(e.t <= until) || !e.edge) continue;
		facts.add({ kind: 'fail', edge: e.edge, nodeClass: e.nodeClass || '', rung: e.rung | 0, why: e.why || 'budget', closest: e.closest ? { tile: e.closest.tile, dist: e.closest.dist } : null, blockedBy: [] });
		n++;
	}
	console.log(`facts from ${process.env.FACTS_FROM}: ${n} failed steps`);
}
const planner = P.createPlanner(model, facts, { bounds, file, floorAsync: false });
const RM = GX.roomOf(L);
const rows = fs.readFileSync(dump, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const row = rows.find((r) => String(r.id) === String(idArg));
if (!row) { console.log('no anchor ' + idArg); process.exit(1); }
const masks = T.masksOf(row.masks[0]);
const r0 = T.playTo(L, masks, { allowDeath: true });
const arr = Object.assign(T.arrivalOf(L, r0.sim, masks, RM), { run: masks.length, leg: null });
const S = model.stateOf(r0.sim);
const A = { arrival: arr, arrivals: [arr], S, key: String(S.key), tick: masks.length, run: masks.length };
console.log(`anchor ${row.id} gain ${row.gain} tick ${row.tick} via '${row.via}' S.gain ${S.gain} key ${String(S.key).slice(0, 140)}`);
const a = planner._anchorOf(A);
const t0 = Date.now();
const es = planner._edgesOf(a.S, a.pos, a.base, 'plan', true, a.S.key + '|' + a.cls, a);
console.log(`root edges ${es.length} in ${Date.now() - t0} ms`);
const lm = planner._hLM ? planner._hLM : null;
const out = es.map((e) => ({ label: e.X ? e.X.label : 'TROPHY', est: Math.round(e.est), relax: !!e.relaxOnly, gain: e.S2 ? e.S2.gain : null, lm: lm && e.S2 ? lm(e.S2) : null, hs: e.pos2 && planner._hSteps ? planner._hSteps(e.pos2) : null }));
out.sort((x, y) => (x.lm ?? 0) - (y.lm ?? 0) || (y.gain ?? 0) - (x.gain ?? 0) || x.est - y.est);
for (const o of out.slice(0, +(process.env.TOPE || 40))) console.log(`  ${o.label.padEnd(40)} est ${String(o.est).padStart(8)}${o.relax ? ' RELAX' : '      '} gain ${o.gain} lm ${o.lm} hSteps ${o.hs}`);
if (lm) console.log(`root lm ${lm(a.S)} gain ${a.S.gain} hSteps ${planner._hSteps ? planner._hSteps(a.pos) : '-'}`);
// (LEARN=<edge>@<closest tile>@<rungs>[;...]: that edge's budget failures from this anchor fed to planner.learn first,
// rungs 0 .. rungs-1, the closest tile on every rung but the first: the learn rules (needs, walls) as the compile has them)
if (process.env.LEARN) {
	for (const spec of process.env.LEARN.split(';').filter(Boolean)) {
		const [edge, tileS, rungsS] = spec.split('@');
		const X = model.triggers[+String(edge).replace(/^trig:/, '')];
		for (let r = 0; r < +(rungsS || 2); r++) {
			const facts2 = planner.learn({ edge, nodeClass: a.S.key + '|' + a.cls, rung: r, waypoint: X ? { trig: X.id, tiles: X.tiles, label: X.label } : null }, { ok: false, fail: { why: 'budget', closest: r ? { tile: +tileS, dist: 20 } : null, touched: [], blockedBy: [] } }, A);
			console.log(`learn ${edge} rung ${r}: ${facts2.map((f) => f.kind + (f.kind === 'needs' ? ` ${f.feat}=${f.value}` : '')).join(', ')}`);
		}
	}
}
for (let r = 0; r < reps; r++) {
	const t1 = Date.now();
	const pr = planner.plan(A, { k: 3, depth: Infinity, runBound: Infinity, tickBound: Infinity, epoch: 0, ms });
	const pl = Array.isArray(pr) ? pr : (pr && pr.plans) || [];
	console.log(`plan call ${r}: ${Date.now() - t1} ms, ${pl.length} plans, expands so far ${planner.stats().expands}`);
	for (const p of pl) console.log(`  ${p.partial ? 'PARTIAL' : 'WHOLE  '} est ${p.cost} lb ${p.lb} x${p.expanded} ${p.why}: ${p.steps.map((s) => s.waypoint.label).slice(0, 8).join(' > ')}`);
}
