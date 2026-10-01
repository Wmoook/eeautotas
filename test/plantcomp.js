'use strict';
// test/plantcomp.js: THE TROPHY AS RANKED COMPONENTS (src/plan/planner.js EEAT_TROPHY_COMP=1, facts.js 'tdrop', types.js
// goalOf with a trophy waypoint's tiles). A level with two trophy components, the decoy by the spawn: the first plan's
// trophy step is the union (edge 'trophy', no tiles); after its failures at rungs 0-1, a rung-2 failure whose closest
// tile is 1 tile from the decoy drops the decoy for that abstract state: the next plan's trophy step is the edge
// 'trophy~t<decoy>' with the far component's tiles, its own rungs from 0, goalOf's field tiles those, the test the crown;
// a near miss 5 tiles off drops nothing; a level with one trophy never drops; the facts' reset with keepProofs keeps the
// drop. With the knob off (EEAT_TROPHY_COMP unset) the same calls give the same plans as before and no 'tdrop' fact.
// usage: node test/plantcomp.js
const cp = require('child_process');

if (process.argv.includes('--child')) {
	const T = require('../src/plan/types.js');
	const M = require('../src/plan/model.js');
	const F = require('../src/plan/facts.js');
	const P = require('../src/plan/planner.js');
	const { level } = require('./planmodel.js');
	const out = {};
	const L = level([
		'########################',
		'#......................#',
		'#S.T.................T.#',
		'########################',
	]);
	const W = L.width, at = (x, y) => y * W + x;
	const m = M.compileModel(L), facts = F.createFacts(), pl = P.createPlanner(m, facts, {});
	const trophyStep = (p) => (p ? p.steps.find((s) => s.waypoint && s.waypoint.kind === 'trophy') || null : null);
	const st0 = trophyStep(pl.plan({}, { k: 1 })[0]);
	out.comps = m.trophies.length;
	out.e0 = st0.edge; out.tiles0 = st0.waypoint.tiles ? Array.from(st0.waypoint.tiles) : null;
	const failRes = (tile) => ({ ok: false, fail: { why: 'budget', closest: { tile, dist: 1 }, blockedBy: [] } });
	// (a near miss 5 tiles from the decoy at rung 2: no drop)
	const f2 = F.createFacts();
	const pl2 = P.createPlanner(M.compileModel(L), f2, {});   // (its own model: a CEGAR cut changes the model's est walls)
	const s2 = trophyStep(pl2.plan({}, { k: 1 })[0]);
	for (let r = 0; r < 2; r++) f2.add({ kind: 'fail', edge: s2.edge, nodeClass: s2.nodeClass, rung: r, why: 'budget' });
	out.far = pl2.learn(s2, failRes(at(8, 2)), {}).map((f) => f.kind);
	// (rungs 0 and 1 failed, then the rung-2 failure 1 tile from the decoy (3,2))
	out.r0 = pl.learn(st0, failRes(at(4, 2)), {}).map((f) => f.kind);
	const st1 = trophyStep(pl.plan({}, { k: 1 })[0]);
	out.r1 = pl.learn(st1, failRes(at(4, 2)), {}).map((f) => f.kind);
	const st2 = trophyStep(pl.plan({}, { k: 1 })[0]);
	out.r2 = pl.learn(st2, failRes(at(4, 2)), {}).map((f) => f.kind);
	const st3 = trophyStep(pl.plan({}, { k: 1 })[0]);
	out.e3 = st3 ? st3.edge : null; out.rung3 = st3 ? st3.rung : null; out.tiles3 = st3 && st3.waypoint.tiles ? Array.from(st3.waypoint.tiles) : null; out.label3 = st3 ? st3.waypoint.label : null;
	const g = T.goalOf(L, st3 ? st3.waypoint : { kind: 'trophy' });
	out.goalTiles = Array.from(g.tiles);
	out.goalAll = Array.from(T.goalOf(L, { kind: 'trophy' }).tiles);
	out.crown = g.test({ has_silver_crown: true }) && !g.test({ has_silver_crown: false });
	facts.reset({ keepProofs: true });
	const sr = trophyStep(pl.plan({}, { k: 1 })[0]);
	out.afterReset = sr ? sr.edge : null;
	// (one trophy: no drop)
	const L1 = level(['############', '#S.T.......#', '############']);
	const m1 = M.compileModel(L1), f1 = F.createFacts(), p1 = P.createPlanner(m1, f1, {});
	const t1 = trophyStep(p1.plan({}, { k: 1 })[0]);
	for (let r = 0; r < 2; r++) f1.add({ kind: 'fail', edge: t1.edge, nodeClass: t1.nodeClass, rung: r, why: 'budget' });
	out.one = p1.learn(t1, { ok: false, fail: { why: 'budget', closest: { tile: 1 * L1.width + 4, dist: 1 }, blockedBy: [] } }, {}).map((f) => f.kind);
	out.at = { decoy: at(3, 2), far: at(21, 2) };
	// (the facts' global drop: per state, the count of states, '*' for every state)
	const fg = F.createFacts();
	fg.add({ kind: 'tdrop', sKey: 'A', comp: 0 }); fg.add({ kind: 'tdrop', sKey: 'B', comp: 0 }); fg.add({ kind: 'tdrop', sKey: 'B', comp: 1 });
	out.keys0 = fg.tdropKeys(0); out.keys1 = fg.tdropKeys(1); out.c0 = fg.tdropOf('C').length;
	fg.add({ kind: 'tdrop', sKey: '*', comp: 0 });
	out.c1 = fg.tdropOf('C'); out.b1 = fg.tdropOf('B').sort(); out.keysG = fg.tdropKeys(0);
	console.log(JSON.stringify(out));
	process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const run = (env) => {
	const e = Object.assign({}, process.env);
	delete e.EEAT_TROPHY_COMP;
	return JSON.parse(cp.execFileSync(process.execPath, [__filename, '--child'], { env: Object.assign(e, env), encoding: 'utf8' }).trim().split('\n').pop());
};
const on = run({ EEAT_TROPHY_COMP: '1' }), off = run({});
check('P-TCOMP the level has two trophy components', on.comps === 2, `${on.comps}`);
check('P-TCOMP the first plan: the union (edge trophy, no tiles)', on.e0 === 'trophy' && on.tiles0 === null, `${on.e0} ${on.tiles0}`);
check('P-TCOMP rungs 0 and 1 fail without a drop', !on.r0.includes('tdrop') && !on.r1.includes('tdrop'), `${on.r0} / ${on.r1}`);
check('P-TCOMP the rung-2 near miss by the decoy drops it', on.r2.includes('tdrop'), `${on.r2}`);
check('P-TCOMP the next trophy step: edge trophy~t<decoy>, rung 0, the far component\'s tiles only',
	/^trophy~t\d+$/.test(on.e3) && on.rung3 === 0 && on.tiles3 && on.tiles3.length === 1 && on.tiles3[0] === on.at.far, `${on.e3} rung ${on.rung3} ${on.tiles3} (${on.label3})`);
check('P-TCOMP goalOf: the field to the kept tiles, the test the crown', on.goalTiles.length === 1 && on.goalTiles[0] === on.at.far && on.goalAll.length === 2 && on.crown, `${on.goalTiles} of ${on.goalAll}`);
check('P-TCOMP the facts\' reset with keepProofs keeps the drop', on.afterReset === on.e3, on.afterReset);
check('P-TCOMP a near miss 5 tiles off drops nothing', !on.far.includes('tdrop'), `${on.far}`);
check('P-TCOMP one trophy component: no drop', !on.one.includes('tdrop'), `${on.one}`);
check('P-TCOMP knob off: no drop; the union, blocked after its 3 failures as before',
	!off.r2.includes('tdrop') && off.r2.includes('block') && off.e0 === 'trophy' && off.e3 === null && off.goalTiles.length === 2 && off.afterReset === 'trophy', `${off.r2} ${off.e3} ${off.afterReset}`);
check('P-TCOMP facts: the states a component was dropped from, the global drop for every state',
	on.keys0 === 2 && on.keys1 === 1 && on.c0 === 0 && on.c1.length === 1 && on.c1[0] === 0 && on.b1.join(',') === '0,1' && on.keysG === 2, JSON.stringify([on.keys0, on.keys1, on.c0, on.c1, on.b1, on.keysG]));
console.log(`plantcomp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
