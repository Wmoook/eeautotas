'use strict';
// Long-range shortcuts (src/leaps.js) without a GPU, on a hand-made room: the reference walks right, turns back left (a
// detour), walks right again into a block (the wall hit zeroes its speed: an exact state to meet), jumps over it and
// walks to the trophy. The explore's hits are made here (a stand-in for eegpu prints them), so every other step is checked:
//  A. prepare / rank: the run's pace, the time-to-go fields, a candidate at the detour
//  B. spliceHits: a hit that skips the detour rejoins the run exactly at the block (tails) and is judged faster; a hit
//     past the block that meets the run nowhere exactly is spliced loose and still verified by the replay; a leap that
//     skips a coin the reference takes (coins counted) meets it in its physical state only: spliced there, verified
//  C. leapFrom with the stand-in: the explore's arguments (--ahead=1 --visits=1, the order field as an RCH3 file, the
//     start tick, no prune), its hit lines, the verified leap
//  D. gpusearch.js's leap arm (--leapOnly=1) on a job: the leap reaches the job's best (an exact one through the library)
//   node test/leaps.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-leaps-'));
process.env.EEAT_HOME = TMP;   // (before common.js is loaded: the job of D lives in the temp folder)
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const J = require('../src/jobs.js');
const L = require('../src/leaps.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };

// the room: 60 x 8, the start at (2, 6), a block at (30, 6), the trophy at (56, 6)
const W = 60, H = 8, cells = [];
for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [30, H - 2, 9]);
const eelvl = ED.eelvlOf({ name: 'leaps test', width: W, height: H, cells });
const json = EL.toSimLevel(EL.readEelvl(eelvl));
const levelFile = path.join(TMP, 'level.json');
fs.writeFileSync(levelFile, JSON.stringify(json));
const level = E.loadLevel(levelFile);
// the reference: right x60, left x60 (the detour), right until it touches the block (+1 tick: the states there are
// exact, a wall hit zeroes the speed), right + jump x3, right to the trophy (no other stretch repeats a state: the
// combine of the known runs has nothing to cut)
const raw = [];
{
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	const push = (m) => { raw.push(m); E.applyMask(inp, m); sim.tick(inp); };
	for (let k = 0; k < 60; k++) push(4);
	for (let k = 0; k < 60; k++) push(2);
	while (sim.px < 29 * 16) push(4);
	push(4);
	for (let k = 0; k < 3; k++) push(5);
	for (let k = 0; k < 300; k++) push(4);
}
const ref = C.evaluate(level, Uint8Array.from(raw));
check('the reference finishes', !!ref, ref ? `${ref.runTicks} run ticks` : 'no finish');
if (!ref) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const masks = ref.ms;

// a hit as eegpu explore --ahead prints it: from the reference's state at tick i, these inputs; the met visit = the
// reference tick nearest the end state (|dpos| + 3 |dvel|) at least minGain later
const OPTS = { minAhead: 100, minGain: 20, maxSpan: 1200, step: 20, block: 40, minPot: 1, leapStep: 100, maxDist: 24 };
function hitFor(i, inputs) {
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	for (let t = 0; t < i; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	for (const m of inputs) { E.applyMask(inp, m); sim.tick(inp); }
	const t = i + inputs.length;
	const r = C.replay(level, masks, { trace: true });
	let best = -1, bd = Infinity;
	for (let j = t + OPTS.minGain; j <= r.n; j++) {
		const d = Math.abs(sim.px - r.X[j]) + Math.abs(sim.py - r.Y[j]) + 3 * (Math.abs(sim.speed_x - r.VX[j]) + Math.abs(sim.speed_y - r.VY[j]));
		if (d < bd) { bd = d; best = j; }
	}
	return { tick: t, gain: best - t, refTick: best, inputs: String.fromCharCode(...inputs.map((m) => 48 + m)), dist: bd };
}

/** from the reference's state at tick i: right held until the ball touches the block (+1 tick): the leap past the detour */
function toBlock(i) {
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	for (let t = 0; t < i; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	const out = [];
	while (sim.px < 29 * 16 && out.length < 400) { E.applyMask(inp, 4); sim.tick(inp); out.push(4); }
	E.applyMask(inp, 4); sim.tick(inp); out.push(4);
	return out;
}

console.log('\n== A. prepare, rank');
const info = L.prepare(level, masks, { nocoins: 1 });
check('prepare: the trace, the tiles, the hashes, the pace', info && info.n === masks.length && info.T.length === info.n + 1 && info.hashTick.size > 0 && info.pace > 0,
	info ? `n ${info.n}, pace ${info.pace.toFixed(2)} ticks per tile` : 'null');
const cands = L.rank(info, OPTS);
check('rank: candidates, best first, the detour among them (a start before tick 240)', cands.length > 0 && cands.every((c, k) => k === 0 || c.pot <= cands[k - 1].pot) && cands.some((c) => c.i < 240),
	cands.slice(0, 4).map((c) => `${c.i}:${c.pot}`).join(' '));
const starts = L.startsOf(info, OPTS);
check('startsOf (run order): every leapStep ticks, none past n - minAhead', starts.length >= 2 && starts[1] - starts[0] === OPTS.leapStep && starts[starts.length - 1] + OPTS.minAhead <= info.n);

console.log('\n== B. spliceHits');
// skip the detour: from tick 60 right held for 200 ticks: at the block well before the reference
const hitA = hitFor(60, toBlock(60));
const sA = L.spliceHits(info, { i: 60, j: info.n }, [hitA], OPTS);
check('an exact leap: the tails rejoin at the block, the run is replayed and judged faster', sA.best && /exact/.test(sA.best.how) && sA.best.saved >= 50 && sA.best.edgeLen > 0,
	sA.best ? `${sA.best.how}, -${sA.best.saved} (hit ${hitA.gain} ahead)` : `nothing (${sA.tried} tried)`);
if (sA.best) {
	const ev = C.evaluate(level, sA.best.masks);
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	for (let t = 0; t < 60 + sA.best.edgeLen; t++) { E.applyMask(inp, sA.best.masks[t]); sim.tick(inp); }
	check('its edge ends in the reference state it names (the library edge of gpusearch)', sim.stateHash(false, true) === info.H[sA.best.j] && ev && ev.runTicks === sA.best.ev.runTicks);
}
// past the block: from tick 60 right until the block, over it, and on toward the trophy: no wall to meet exactly
const inB = [];
{
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	for (let t = 0; t < 60; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	for (let k = 0; k < 400; k++) {
		const m = sim.px > 29 * 16 - 60 && sim.px < 29 * 16 && sim.on_ground ? 5 : 4;
		E.applyMask(inp, m); sim.tick(inp); inB.push(m);
		if (sim.px > 36 * 16) break;
	}
}
const hitB = hitFor(60, inB);
const sB = L.spliceHits(info, { i: 60, j: info.n }, [hitB], OPTS);
check('a loose leap (no exact rejoin before the trophy): spliced as it is and verified by the replay', sB.best && sB.best.saved >= 50 && sB.best.ev.deaths === 0,
	sB.best ? `${sB.best.how}, -${sB.best.saved}` : `nothing (${sB.tried} tried, ${sB.exact} exact)`);
{
	const h = hitFor(60, new Array(30).fill(0));
	h.refTick = h.tick - 20; h.gain = -20;   // (a visit before the hit: no leap; with rejoinK 0 no every move either)
	check('a hit before its own tick gives nothing', !L.spliceHits(info, { i: 60, j: info.n }, [h], OPTS).best);
}
{
	// a coin at (1, 6) that only the detour takes (the reference turns back to the left wall), coins counted (nocoins 0):
	// the leap skips it, so no state after it equals the reference's; the physical rejoin at the block does
	const cells2 = cells.concat([[1, H - 2, 100]]);
	const lf2 = path.join(TMP, 'level_coin.json');
	fs.writeFileSync(lf2, JSON.stringify(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'leaps test coin', width: W, height: H, cells: cells2 })))));
	const level2 = E.loadLevel(lf2);
	const raw2 = [];
	const sim = new E.EESim(level2); sim.reset(); const inp = new E.EEInput();
	const push = (m) => { raw2.push(m); E.applyMask(inp, m); sim.tick(inp); };
	for (let k = 0; k < 60; k++) push(4);
	while (sim.px > 16 + 1e-9) push(2);   // (to the left wall: through the coin's tile)
	while (sim.px < 29 * 16) push(4);
	push(4);
	for (let k = 0; k < 3; k++) push(5);
	for (let k = 0; k < 300; k++) push(4);
	const ref2 = C.evaluate(level2, Uint8Array.from(raw2));
	const info2 = ref2 && L.prepare(level2, ref2.ms, { nocoins: 0 });
	let hit2 = null;
	if (info2) {
		const s = new E.EESim(level2); s.reset(); const q = new E.EEInput();
		for (let t = 0; t < 60; t++) { E.applyMask(q, info2.masks[t]); s.tick(q); }
		const hin = [];
		while (s.px < 29 * 16 && hin.length < 400) { E.applyMask(q, 4); s.tick(q); hin.push(4); }
		E.applyMask(q, 4); s.tick(q); hin.push(4);
		let best = -1, bd = Infinity;
		for (let j = 60 + hin.length + 20; j <= info2.n; j++) {
			const d = Math.abs(s.px - info2.X[j]) + Math.abs(s.py - info2.Y[j]) + 3 * (Math.abs(s.speed_x - info2.VX[j]) + Math.abs(s.speed_y - info2.VY[j]));
			if (d < bd) { bd = d; best = j; }
		}
		hit2 = { tick: 60 + hin.length, gain: best - 60 - hin.length, refTick: best, inputs: String.fromCharCode(...hin.map((m) => 48 + m)) };
	}
	const sC = info2 && L.spliceHits(info2, { i: 60, j: info2.n }, [hit2], Object.assign({}, OPTS, { nocoins: 0 }));
	check('a leap that skips a coin (coins counted): no exact rejoin, the physical one at the block, verified', ref2 && ref2.coins === 1 && sC && sC.best && /physical/.test(sC.best.how) && sC.best.ev.coins === 0 && sC.best.saved >= 50,
		sC && sC.best ? `${sC.best.how}, -${sC.best.saved}, coins ${sC.best.ev.coins}` : `nothing (${sC ? sC.tried : 0} tried; reference coins ${ref2 && ref2.coins})`);
}

console.log('\n== C. leapFrom with a stand-in for eegpu');
const TOOL = path.join(TMP, 'tool.js');
fs.writeFileSync(TOOL, `'use strict';
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.writeFileSync(path.join(${JSON.stringify(TMP)}, 'args.json'), JSON.stringify(a));
const opt = (k) => { const x = a.find((s) => s.startsWith('--' + k + '=')); return x ? x.slice(k.length + 3) : ''; };
console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));
const hits = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(TMP)}, 'hits.json'), 'utf8'));
for (const h of hits) if (+opt('from') === h.from) console.log(JSON.stringify({ ev: 'hit', layer: h.inputs.length - 1, tick: h.tick, px: 0, vx: 0, gain: h.gain, refTick: h.refTick, salt: 0, inputs: h.inputs }));
console.log(JSON.stringify({ ev: 'done', gpu: { name: 'stand-in', memMB: 8192 }, layers: 200, states: 1, ticks: 1000, seconds: 0.1, end: 'depth', overflow: 0 }));
`);
fs.writeFileSync(path.join(TMP, 'hits.json'), JSON.stringify([Object.assign({ from: 60 }, hitA)]));
(async () => {
	const ctx = L.context({ level, work: path.join(TMP, 'work') });
	const r = await L.leapFrom(ctx, info, 60, Object.assign({ tool: TOOL, perS: 5 }, OPTS));
	const args = JSON.parse(fs.readFileSync(path.join(TMP, 'args.json'), 'utf8'));
	const has = (s) => args.includes(s);
	const reach = (args.find((s) => s.startsWith('--reach=')) || '').slice(8);
	check('the explore: --ahead=1 --visits=1 from the start tick, the gain and lead, no prune', has('explore') && has('--ahead=1') && has('--visits=1') && has('--from=60') &&
		has(`--gain=${OPTS.minGain}`) && has(`--minahead=${OPTS.minAhead}`) && has('--prune=0'), args.filter((s) => /ahead|visits|from|gain|prune/.test(s)).join(' '));
	check('the order field: an RCH3 file of this level', reach && fs.existsSync(reach) && fs.readFileSync(reach).slice(0, 4).toString() === 'RCH3', r.field);
	check('the leap: the stand-in\'s hit spliced and verified', r.done && r.hits === 1 && r.best && r.best.saved === sA.best.saved, r.best ? `-${r.best.saved}` : r.err);

	console.log('\n== D. gpusearch.js: the leap arm on a job');
	const meta = J.importJob({ eelvl, eetas: C.eetasBytes(masks), name: 'leaps test', eelvlName: 'room.eelvl', eetasName: 'room.eetas' });
	const dir = J.jobDir(meta.id);
	const statusFile = path.join(dir, 'status.json');
	C.writeJSON(statusFile, Object.assign(C.readJSON(statusFile, {}), { coinsOptional: true, state: 'stopped' }));
	// the stand-in answers any start tick with the hit made for it (the job's run is the reference)
	const hits = [];
	for (let i = 0; i <= 100; i += 100) hits.push(Object.assign({ from: i }, hitFor(i, toBlock(i))));
	fs.writeFileSync(path.join(TMP, 'hits.json'), JSON.stringify(hits));
	const before = C.evaluate(level, C.readEetas(path.join(dir, 'best.eetas'))).runTicks;
	const gs = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'gpusearch.js'), `--job=${dir}`, `--tool=${TOOL}`, '--every=1', '--leapOnly=1', '--leapS=3', '--leapRound=5', '--leapStep=100', '--leapAhead=100', '--leapGain=20', '--leapSpan=1200', '--once=1', '--idle=0'],
		{ stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
	let out = '';
	gs.stdout.on('data', (d) => { out += d; });
	gs.stderr.on('data', (d) => { out += d; });
	const code = await new Promise((res) => { const t = setTimeout(() => { gs.kill(); res('timeout'); }, 120000); gs.on('close', (c) => { clearTimeout(t); res(c); }); });
	const after = C.evaluate(level, C.readEetas(path.join(dir, 'best.eetas'))).runTicks;
	const st = C.readJSON(path.join(dir, 'gpu', 'state.json'), {});
	check('the searcher ran a leap round and exited', code === 0 && /long-range shortcuts/.test(out), code !== 0 ? `exit ${code}: ${out.slice(-800)}` : undefined);
	if (process.argv.includes('--verbose')) console.log(out);
	check('the job\'s best is the leap (through the library edge and the combine)', after < before && after <= before - 50, `${before} -> ${after}`);
	check('the family leap: its edge and its credit', st.fam && st.fam.leap && st.fam.leap.edges >= 1 && st.fam.leap.saved >= 50, st.fam && JSON.stringify(st.fam.leap));

	console.log(`\n${pass} passed, ${fail} failed`);
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* busy */ }
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack || e); process.exit(1); });
