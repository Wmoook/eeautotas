'use strict';
// test/plantruth.js: the ground truth's helpers (src/plan/truthset.js): a route's feature changes in order, on a
// synthetic level; with EEAT_TRUTH_ROOT (or this checkout's src/jobs / src/out) also the known routes replay.
// usage: node test/plantruth.js [--real=N (replay the first N known routes, default 3)]
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const S = require('../src/plan/truthset.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
// # wall, S spawn, c gold coin, k red key, d red key door, T trophy
const rows = [
	'######################',
	'#....................#',
	'#S...c....k....d...T.#',
	'######################',
];
const ID = { '#': [9], S: [255], c: [100], k: [6], d: [23], T: [121] };
const cells = [];
rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
const W = L.width, at = (x, y) => y * W + x;
const masks = new Uint8Array(400).fill(4);
const ev = S.routeEvents(L, masks);
const ord = S.orderOf(ev.events);
check('holding right finishes the level', ev.complete > 0 && ev.runTicks > 0, `complete ${ev.complete}, run ${ev.runTicks}`);
check('the order: the coin, the red key, the trophy', ord.map((s) => s.feat).join(',') === 'coins,key0,silver', ord.map((s) => `${s.feat}=${s.value}@${s.tick}`).join(' '));
check('each change on its tile', ord[0].tile === at(5, 2) && ord[1].tile === at(10, 2) && ord[2].tile === at(19, 2), ord.map((s) => s.tile).join(','));
check('ticks increase', ord.every((s, i) => i === 0 || s.tick >= ord[i - 1].tick));

const nReal = (() => { const a = process.argv.find((x) => x.startsWith('--real=')); return a ? +a.slice(7) : 3; })();
const known = S.knownRoutes();
if (!known.length) console.log('  (no known routes under the truth root: set EEAT_TRUTH_ROOT to the main checkout to replay them)');
for (const e of known.slice(0, nReal)) {
	const tr = S.loadTruth(e);
	if (!tr) { console.log(`  (stale: ${e.name} ${e.route})`); continue; }
	const r = S.routeEvents(tr.L, tr.masks);
	check(`known route ${e.source} ${e.name}: routeEvents finishes where C.evaluate does`, r.complete === tr.complete && r.runTicks === tr.runTicks, `${r.complete} / ${tr.complete}, events ${r.events.length}`);
}
console.log(`plantruth: ${pass}/${fail}`);
process.exitCode = fail ? 1 : 0;
