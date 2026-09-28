'use strict';
// test/legsearch.js: the leg search (src/legsearch.js): it finds a room change by a trigger from a prefix, its run
// replays into that room; a room in `known` is no goal; the region keeps the centre inside; a worker thread gives the same.
// usage: node test/legsearch.js
const path = require('path');
const { Worker } = require('worker_threads');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const LS = require('../src/legsearch.js');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
// a room: # wall, S spawn, k red key (a trigger: the room changes), x spike; the key behind a spike pit it must jump
const rows = [
	'##################',
	'#................#',
	'#................#',
	'#................#',
	'#S.......xxx...k.#',
	'##################',
];
const ID = { '#': [9], S: [255], k: [6], x: [361, 1] };
const cells = [];
rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
const eelvl = ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells });
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(eelvl)));
const RM = GX.roomOf(L);
const replayKey = (masks) => { const s = new E.EESim(L), I = new E.EEInput(); s.reset(); for (const m of masks) { E.applyMask(I, m); s.tick(I); if (s.is_dead) return null; } return RM.key(s); };
const start = new E.EESim(L); start.reset();
const key0 = RM.key(start);
const prefix = new Uint8Array(5);   // five idle ticks
const r = LS.legSearch(L, prefix, { depth: 300, cap: 4000, ms: 60000 });
const k1 = r.found ? replayKey(r.found) : null;
check('from a prefix, the leg search finds the key behind the spike pit; its run (prefix + leg) replays alive into the key\'s room',
	!!r.found && r.found.length > prefix.length && Array.from(r.found.subarray(0, 5)).every((m) => m === 0) && k1 !== null && k1 !== key0 && /key:red/.test(r.desc),
	`${r.why}, ${r.legTicks} ticks, ${r.layers} layers, ${r.sims} sims, ${r.desc}`);
const r2 = LS.legSearch(L, prefix, { depth: 200, cap: 4000, ms: 60000, known: new Set([k1]) });
check('a room already known is no goal (the search runs out without a find)', !r2.found, r2.why);
const region = new Uint8Array(L.width * L.height);
for (let x = 0; x < 8; x++) for (let y = 0; y < L.height; y++) region[y * L.width + x] = 1;
const r3 = LS.legSearch(L, prefix, { depth: 200, cap: 4000, ms: 60000, region });
check('a region without the key keeps the centre out of it: no find, exhausted', !r3.found && r3.why === 'exhausted', r3.why);
// the worker thread (bursts.js's way): the same find
const file = path.join(os.tmpdir(), `legsearch_test_${process.pid}.eelvl`);
fs.writeFileSync(file, eelvl);
(async () => {
	const res = await new Promise((ok) => {
		const w = new Worker(path.join(__dirname, '..', 'src', 'legsearch.js'), { workerData: { legsearch: true, file, prefix: '00000', o: { depth: 300, cap: 4000, ms: 60000 } } });
		w.on('message', ok); w.on('error', (e) => ok({ why: e.message }));
	});
	const wm = res.found ? Uint8Array.from(res.found, (c) => (c.charCodeAt(0) - 48) & 31) : null;
	check('in a worker thread (the level from its file): the same find', !!wm && wm.length === r.found.length && replayKey(wm) === k1, res.why);
	try { fs.unlinkSync(file); } catch (e) { /* gone */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
