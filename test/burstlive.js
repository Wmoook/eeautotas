'use strict';
// test/burstlive.js - bursts.js liveCutOf (EEAT_BURSTLIVE=1, b9cw-cw): a burst start cut back along its run into a
// death's dead ticks goes on along the SAME run to its respawn. A corridor with a checkpoint and a spike: a run that holds
// right walks over the checkpoint into the spike, dies, respawns at the checkpoint and dies again. Checks: every cut in the
// dead ticks moves to the first live tick after it, whose replay is alive and equals the full run's state there
// (stateHash); a live cut is kept; a cut in the last death of a run that ends dead is kept (never lives again); the inputs
// returned are the run's own. usage: node test/burstlive.js   (exit 1 on a failure; CPU only, < 1 s)
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const BU = require('../src/bursts.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`); };
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1] };
const rows = [
	'##################',
	'#................#',
	'#................#',
	'#S..C.....x.....T#',
	'##################',
];
const cells = [];
rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'burstlive', width: rows[0].length, height: rows.length, cells }))));
const full = '4'.repeat(400);   // right held (mask 4)
// the full run's states and dead flags per tick
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
const dead = [], hash = [];
for (let k = 0; k < full.length; k++) { E.applyMask(inp, 4); sim.tick(inp); dead.push(!!sim.is_dead); hash.push(sim.stateHash()); }
const deadTicks = dead.map((d, k) => (d ? k : -1)).filter((k) => k >= 0);
check('the run dies (dead ticks)', deadTicks.length > 0, `${deadTicks.length} dead ticks, first ${deadTicks[0]}`);
const lastDead = dead.lastIndexOf(true);
const livesAgain = (k) => dead.indexOf(false, k) >= 0;
let moved = 0, bad = 0;
for (const k of deadTicks) {
	const cut = full.slice(0, k + 1);            // the prefix ends after tick k: dead
	const r = BU.liveCutOf(L, full, cut);
	if (!livesAgain(k)) { if (r !== cut) bad++; continue; }
	const j = dead.indexOf(false, k);
	if (r.length !== j + 1 || full.slice(0, r.length) !== r) { bad++; continue; }
	const s = new E.EESim(L), ip = new E.EEInput(); s.reset();
	for (let t = 0; t < r.length; t++) { E.applyMask(ip, (r.charCodeAt(t) - 48) & 31); s.tick(ip); }
	if (s.is_dead || s.stateHash() !== hash[j]) bad++; else moved++;
}
check('every dead cut moves to the respawn tick (alive, the run\'s own state there)', bad === 0 && moved > 0, `${moved} moved, ${bad} wrong`);
const aliveK = dead.indexOf(false);
const cutA = full.slice(0, aliveK + 1);
check('a live cut is kept', BU.liveCutOf(L, full, cutA) === cutA);
check('a cut as long as the run is kept', BU.liveCutOf(L, full, full) === full);
// a run that ends in the middle of its first death: a cut in it never lives again within that run: kept
const d0 = deadTicks[0];
const endDead = full.slice(0, d0 + 11);
const cutD = endDead.slice(0, d0 + 1);
check('a cut in a death the run never leaves is kept', dead[d0 + 10] && BU.liveCutOf(L, endDead, cutD) === cutD);
check('the same cut on the whole run moves past the death', BU.liveCutOf(L, full, cutD).length > d0 + 11, `${d0 + 1} -> ${BU.liveCutOf(L, full, cutD).length} (last dead tick ${lastDead})`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
