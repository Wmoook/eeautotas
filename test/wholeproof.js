'use strict';
// tools/perfect/wholeproof.js (the whole-level proof, box 7 lane 'proof'): on toy rooms the IDA contours' optimum = an
// exhaustive search's (no bound: nothing cut), with and without the order tier, the found route replays at that many run
// ticks, the bound never above the ticks left along it, a route given as U is PROVEN when it is the optimum and FASTER
// when it is not; bounds.js field's opt-in fo.init (the order tier's field): absent = the field as before, a goal's
// value = its start value.
//   node test/wholeproof.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const BO = require('../src/plan/bounds.js');
const X = require('../src/plan/exact.js');
const WP = require('../tools/perfect/wholeproof.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const levelOf = (rows, ID) => {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
};
const ID = { '#': [9], S: [255], G: [121], k: [6], d: [23] };
const ROOMS = {
	plain: ['############', '#..........#', '#..........#', '#S.....G...#', '############'],
	gated: ['##############', '#.....#......#', '#.....d......#', '#S.k..d..G...#', '##############'],
	ledge: ['############', '#......G...#', '#.....###..#', '#S.........#', '############'],
};
for (const [name, rows] of Object.entries(ROOMS)) {
	const L = levelOf(rows, ID);
	const starts = WP.idleStarts(L);
	// the reference: exact.js (its own layers and its own bound, endgame.js's) from every idle start at tick 0
	const B = X.boundFor(L, { kind: 'trophy', tiles: [] });
	const goal = { kind: 'trophy', tiles: Int32Array.from(B.cells), test: (s) => !!s.has_silver_crown };
	const ex = X.solveExact(L, starts.map((s) => ({ snap: s.snap, tick: 0 })), goal, { B, cap: 2000000, deadline: Date.now() + 120000 });
	check(`${name} reference found (exact.js)`, ex.status === 'found', `${ex.status} ${ex.depth}`);
	const ref = { depth: ex.depth };
	for (const gate of [true, false]) {
		const r = WP.proveLevel(L, { seconds: 60, cap: 2000000, gate });
		check(`${name} gate=${gate} optimum = the reference`, r.verdict === 'PROVEN' && r.opt === ref.depth - 1 && r.faster && r.faster.depth === ref.depth, `${r.verdict} opt ${r.opt} vs ${ref.depth - 1}`);
		if (r.faster) {
			const ev = C.evaluate(L, r.faster.masks, false);
			check(`${name} gate=${gate} the route replays`, !!ev && ev.runTicks === r.opt, ev ? ev.runTicks : 'no finish');
			const ck = WP.checkRoute(L, r.faster.masks, WP.createH(L, { gate }));
			check(`${name} gate=${gate} the bound along the optimum`, ck.ok && ck.minSlack >= 0, `violations ${ck.violations}, min slack ${ck.minSlack}`);
			// the optimum handed in as U: PROVEN; a route one tick slower (an idle tick after the timer starts): FASTER
			const r2 = WP.proveLevel(L, { routes: [{ name: 'opt', masks: r.faster.masks }], seconds: 60, cap: 2000000, gate });
			check(`${name} gate=${gate} the optimum as U is PROVEN`, r2.verdict === 'PROVEN' && r2.lb === r.opt && r2.gap === 0, `${r2.verdict} lb ${r2.lb} gap ${r2.gap}`);
			const r3 = WP.proveLevel(L, { U: r.opt + 1, seconds: 60, cap: 2000000, gate });
			check(`${name} gate=${gate} a slower U gives FASTER`, r3.verdict === 'FASTER' && r3.opt === r.opt, `${r3.verdict} opt ${r3.opt} U ${r3.U}`);
		}
	}
}
// bounds.js field fo.init
{
	const L = levelOf(ROOMS.gated, ID);
	const b1 = BO.createBounds(L, {}), b2 = BO.createBounds(L, {});
	const W = L.width, troph = [], key = [];
	for (let i = 0; i < L.fg.length; i++) { if (L.fg[i] === 121) troph.push(i); if (L.fg[i] === 6) key.push(i); }
	const fa = b1.field(troph, null, { touch: true }), fb = b2.field(troph, null, { touch: true, init: new Map() });
	check('init absent / empty = the field as before', fa.length === fb.length && fa.every((v, i) => Object.is(v, fb[i])));
	const init = new Map([[troph[0], 0], [key[0], 5]]);
	const fi = b1.field(troph.concat(key), null, { touch: true, init });
	// (a source tile's own value goes through the iso tier's 1-tile slack: its start value, or one tick less)
	check('init: a goal tile holds its start value', (fi[key[0]] === 5 || fi[key[0]] === 4) && fi[troph[0]] === 0, `${fi[key[0]]} / ${fi[troph[0]]}`);
	const fj = b1.field(troph.concat(key), null, { touch: true, init: new Map([[troph[0], 0], [key[0], 40]]) });
	check('init: a goal tile holds the least of its start value and the way on', fj[key[0]] === fa[key[0]], `${fj[key[0]]} vs ${fa[key[0]]}`);
	const fk = b1.field(key, null, { touch: true });
	let ok = true;
	for (let i = 0; i < fi.length; i++) if (fa[i] !== Infinity && !(fi[i] <= fa[i] && fi[i] <= fk[i] + 5 + 1e-9)) { ok = false; break; }
	check('init: at most the trophy field and the key field + 5', ok);
	void W;
}
console.log(`${pass}/${fail}`);
process.exit(fail ? 1 : 0);
