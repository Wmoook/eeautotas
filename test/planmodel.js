'use strict';
// test/planmodel.js: the planner's LEVEL MODEL (src/plan/model.js) and its plans on toys (src/plan/planner.js): the
// exact trigger order of a key door, a chain of three purple switches, three coins before a 3-coin door, a team door, a
// trigger reached only through a portal, a blue coin door, a death gate / checkpoint; the region of each state; and the
// model's predicted states equal stateOf along a replayed solution (hold right). usage: node test/planmodel.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');
const MD = require('../src/plan/model.js');
const FC = require('../src/plan/facts.js');
const PL = require('../src/plan/planner.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
/** a toy level from rows of characters (ID: char -> [block id, ...args]) */
function toy(rows, ID) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error('no id for ' + ch); cells.push([x, y, ...ID[ch]]); } }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'toy', width: rows[0].length, height: rows.length, cells }))));
}
const BASE = { '#': [9], S: [255], T: [121] };
const startAnchor = (L) => { const s = new E.EESim(L); s.reset(); return { arrival: T.arrivalOf(L, s, new Uint8Array(0)) }; };
/** the kinds (and params) of a plan's steps, e.g. 'key0 trophy' */
const sig = (M, p) => p.steps.map((s) => {
	if (s.kind === 'trophy') return 'trophy';
	if (s.kind === 'die') return 'die';
	if (s.kind === 'expire') return 'expire';
	const tr = M.triggers[s.waypoint.trig];
	return tr.kind === 'key' ? 'key' + tr.param : tr.kind === 'psw' ? 'psw:' + tr.param : tr.kind === 'team' ? 'team' + tr.param : tr.kind;
}).join(' ');
/** replay masks; the distinct model states along the way (stateOf after each tick where it changed) */
function statesAlong(L, M, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let last = M.stateOf(sim).key;
	const out = [];
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (sim.is_dead) break;
		const k = M.stateOf(sim).key;
		if (k !== last) { out.push(k); last = k; }
		if (sim.has_silver_crown) return { keys: out, finished: t + 1 };
	}
	return { keys: out, finished: -1 };
}
function caseOf(name, rows, ID, want, o = {}) {
	const L = toy(rows, Object.assign({}, BASE, ID));
	const M = MD.compileModel(L);
	const facts = FC.createFacts({ rungs: 4 });
	const P = PL.createPlanner(M, facts, {});
	const plans = P.plan(startAnchor(L), { k: 3, ms: 2000 });
	const p = plans[0];
	const got = p ? sig(M, p) : '(none)';
	check(`${name}: the plan is [${want}]`, !!p && !p.partial && got === want, `${got}${p ? ' | ' + P.explain(p) : ''}`);
	if (o.replay !== false && p) {
		const masks = o.masks || new Uint8Array(o.ticks || 600).fill(4);
		const r = statesAlong(L, M, masks);
		const pred = p.steps.filter((s) => s.kind !== 'trophy' && s.kind !== 'expire').map((s) => s.S2.key);
		check(`${name}: stateOf along the replayed solution = the model's predicted states`, r.finished > 0 && r.keys.join(' / ') === pred.join(' / '), `finished ${r.finished}; real ${r.keys.join(' / ')} | model ${pred.join(' / ')}`);
	}
	return { L, M, P, facts, plans };
}

console.log('toys: exact plans');
// 1. a key door
{
	const { M, L } = caseOf('key door', [
		'##########',
		'#S.k..d.T#',
		'##########',
	], { k: [6], d: [23] }, 'key0 trophy');
	const S0 = M.startState(), W = L.width;
	const R0 = M.region(S0, 1 * W + 1);
	const key = M.triggers.find((t) => t.kind === 'key');
	check('key door: the start region stops at the key, no trophy', R0.trigs.length === 1 && R0.trigs[0] === key.id && !R0.trophy, `trigs ${R0.trigs}, trophy ${!!R0.trophy}, tiles ${R0.tiles.length}`);
	const S1 = M.apply(S0, key.id);
	const R1 = M.region(S1, key.tiles[0]);
	check('key door: with the key the region holds the trophy; the door key differs', !!R1.trophy && M.doorKey(S1) !== M.doorKey(S0), `${M.doorKey(S0)} -> ${M.doorKey(S1)}`);
	check('key door: apply twice is no change (null)', M.apply(S1, key.id) === null);
	check('key door: the key expires back to the start state', M.expire(S1).length === 1 && M.expire(S1)[0][1].key === S0.key);
}
// 2. a chain of three purple switches, each opening the next door
caseOf('switch chain', [
	'################',
	'#S.a.1.b.2.c.3T#',
	'################',
], { a: [113, 1], b: [113, 2], c: [113, 3], 1: [184, 1], 2: [184, 2], 3: [184, 3] }, 'psw:1 psw:2 psw:3 trophy');
// 3. three coins, then a 3-coin door
caseOf('coin door', [
	'#############',
	'#S.c.c.c.D.T#',
	'#############',
], { c: [100], D: [43, 3] }, 'coins coins coins trophy');
// 4. a team door
caseOf('team door', [
	'##########',
	'#S.t.D.T.#',
	'##########',
], { t: [423, 1], D: [1027, 1] }, 'team1 trophy');
// 5. a key reached only through a portal
caseOf('portal', [
	'###############',
	'#S.P#Q.k.d.T..#',
	'###############',
], { P: [242, 1, 1, 2], Q: [242, 1, 2, 1], k: [6], d: [23] }, 'key0 trophy');
// 6. a blue coin door
caseOf('blue coin door', [
	'##########',
	'#S.b.D.T.#',
	'##########',
], { b: [101], D: [213, 1] }, 'bcoins trophy');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
