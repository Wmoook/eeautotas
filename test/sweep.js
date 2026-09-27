'use strict';
// src/sweep.js (the grind's whole-run hunt sweep and its window memory), CPU only, on a hand-made room (no jobs, ~1 s):
//   - windows() covers the whole run, windows of at most `len` ticks, the last one ending at the finish
//   - the sampled state hashes of a window are content-defined: the same stretch shifted by idle ticks before it (an
//     improvement earlier in the run) gives the same sample, so the memory still knows the window
//   - the memory: a new window runs; after FAILS_N empty searches of the same span and route it rests 2 rounds, then
//     4 after the next empty one (exponential back-off); a search that found time resets it; a window searched in this
//     round already does not run again; a change of the run inside the window (new states) opens it at once, a boundary
//     shift does not
//   - lossEstimate / leadEstimate return numbers for every window (the sweep ranks by the memory, not by them:
//     neither put the ice level's top right first on the lab's runs; src/out/night/opt_hunt.md)
// usage: node test/sweep.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const S = require('../src/splice.js');
const SW = require('../src/sweep.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-sweep-'));
const W = 200, H = 10, cells = room(W, H);
cells.push([2, H - 2, 255], [W - 3, H - 2, 121]);
const json = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells })));
const levelFile = path.join(TMP, 'level.json');
fs.writeFileSync(levelFile, JSON.stringify(json));
const level = E.loadLevel(levelFile);
// a long run: right 70 ticks (a jump in it), left 50, 25 times (drifting right: the states differ tick by tick), then to the trophy
const seq = [];
const add = (m, n) => { for (let k = 0; k < n; k++) seq.push(m); };
add(0, 3);
for (let k = 0; k < 25; k++) { add(4, 30); add(5, 2); add(4, 38); add(2, 50); }
add(4, 3000);
const ev = C.evaluate(level, Uint8Array.from(seq));
check('the room run finishes', !!ev, ev ? `${ev.runTicks} run ticks` : 'no finish');
const ms = ev.ms;
const tr = S.trace(level, ms, 1, false);
const n = tr.n;

console.log('windows()');
{
	let ok = true, why = '';
	for (const [len, step] of [[800, 600], [300, 200], [5000, 600]]) {
		const ws = SW.windows(n, len, step);
		const cov = new Uint8Array(n + 1);
		for (const [a, b] of ws) { if (b - a > len + step / 2 || a < 0 || b > n || b <= a) { ok = false; why = `${len}/${step}: [${a}, ${b}]`; } for (let t = a; t <= b; t++) cov[t] = 1; }
		if (cov.some((x) => !x)) { ok = false; why = `${len}/${step}: a tick is not covered`; }
		if (ws[ws.length - 1][1] !== n) { ok = false; why = `${len}/${step}: the last window ends at ${ws[ws.length - 1][1]}, not ${n}`; }
	}
	check('every tick covered, windows of about len ticks, the last one ends at the finish', ok, why || `${SW.windows(n, 800, 600).length} windows of 800 over ${n} ticks`);
	check('a short run is one window', SW.windows(500, 800, 600).length === 1 && SW.windows(0).length === 0);
}

console.log('content-defined samples');
const K = 37;   // idle ticks before the run: every later state comes K ticks later (the clock is not in the hash)
const shifted = new Uint8Array(ms.length + K);
shifted.set(ms, K);
const trS = S.trace(level, shifted, 1, false);
const a0 = 1000, a1 = 1800;
const sA = SW.sigOf(tr.H, a0, a1), sB = SW.sigOf(trS.H, a0 + K, a1 + K);
check('the sample is about 1/SAMPLE of the window', sA.length > 800 / SW.SAMPLE / 3 && sA.length < 800 / SW.SAMPLE * 3, `${sA.length} of 801 states`);
check('the same stretch shifted by idle ticks gives the same sample', sA.length === sB.length && sA.every((x, i) => x === sB[i]), `${sA.length} / ${sB.length}`);

console.log('the memory');
{
	const M = new SW.Memo([]);
	const inner = SW.innerOf(tr.H, a0, a1);
	let st = M.state(sA, inner, 1);
	check('a new window runs', st.run && st.why === 'new');
	M.record(sA, 0, 1);
	st = M.state(sA, inner, 1);
	check('searched empty this round: not again this round', !st.run && /this round/.test(st.why), st.why);
	st = M.state(sA, inner, 2);
	check('one empty search: it runs again the next round', st.run, st.why);
	M.record(sA, 0, 2);
	const r2 = M.match(sA);
	check(`${SW.FAILS_N} empty searches: it rests 2 rounds`, r2.fails === 2 && r2.next === 4 && !M.state(sA, inner, 3).run && M.state(sA, inner, 4).run, `fails ${r2.fails}, next ${r2.next}, round 3: ${M.state(sA, inner, 3).why}`);
	M.record(sA, 0, 4);
	check('one more empty search: 4 rounds', M.match(sA).next === 8 && !M.state(sA, inner, 7).run && M.state(sA, inner, 8).run, `next ${M.match(sA).next}`);
	// the same window shifted by 50 ticks (an improvement before it): still the same span, still resting
	const sS = SW.sigOf(tr.H, a0 + 50, a1 + 50), iS = SW.innerOf(tr.H, a0 + 50, a1 + 50);
	st = M.state(sS, iS, 5);
	check('a boundary shift of 50 ticks is the same window (still resting)', !st.run && M.match(sS) === M.match(sA), st.why);
	// the run inside changed: the middle 200 ticks replaced by other states (another line)
	const mid = SW.sigOf(tr.H, a0 + 300, a0 + 500);
	const other = mid.map((x) => x + SW.SAMPLE);   // (as many states the window never had: the new line's)
	const chg = sA.filter((x) => !mid.includes(x)).concat(other).sort((x, y) => x - y);
	const innerChg = SW.innerOf(tr.H, a0, a1).filter((x) => !mid.includes(x)).concat(other).sort((x, y) => x - y);
	st = M.state(chg, innerChg, 5);
	check('a change of the run inside the window opens it at once', st.run && st.why === 'changed', st.why);
	M.record(sA, 7, 8);
	const r3 = M.match(sA);
	check('a search that found time resets the back-off', r3.fails === 0 && r3.next === 0 && r3.found === 7 && M.state(sA, inner, 9).run);
	// another span is another record
	const sC = SW.sigOf(tr.H, 3000, 3800);
	check('another span of the run is a new window', M.state(sC, SW.innerOf(tr.H, 3000, 3800), 9).why === 'new');
	// the records survive JSON (grind_windows.json)
	const M2 = new SW.Memo(JSON.parse(JSON.stringify({ records: M.records })).records);
	check('the records survive a save and a load', M2.match(sA) && M2.match(sA).found === 7);
}

console.log('stale finds');
{
	// the run with 30 idle ticks before it (an improvement earlier in the run moves a window this way): the window maps
	// 30 ticks later, the same length
	const ms2 = new Uint8Array(ms.length + 30);
	ms2.set(ms, 30);
	const tr2 = S.trace(level, ms2, 1, false);
	const [m0, m1] = SW.mapWindow(tr.H, n, tr2.H, tr2.n, 1200, 2000);
	check('a window maps onto a run shifted by idle ticks', m0 === 1230 && m1 === 2030, `[${m0}, ${m1}]`);
	// the middle replaced (ticks 1000-1099 idle): a window past it starts from the last shared state before it
	const ms3 = new Uint8Array(ms.length + 400).fill(4);   // (the slower run needs more ticks to the trophy)
	ms3.set(ms, 0);
	ms3.fill(0, 1000, 1100);
	const tr3 = S.trace(level, ms3, 1, false);
	let shared = -1;
	for (let t = 1800; t >= 0 && shared < 0; t--) if (tr3.H.indexOf(tr.H[t]) >= 0) shared = t;
	const [q0, q1] = SW.mapWindow(tr.H, n, tr3.H, tr3.n, 1800, 2600);
	check('past a changed stretch a window keeps its distance from the last shared state', shared >= 0 && q0 === tr3.H.indexOf(tr.H[shared]) + 1800 - shared && q1 - q0 === 800,
		`[${q0}, ${q1}], the last shared state A ${shared}`);
	const [z0, z1] = SW.mapWindow(tr.H, n, tr3.H, tr3.n, 50000, 50800);
	check('a window past the other run\'s end is clamped into it', z0 >= 0 && z0 < tr3.n && z1 <= tr3.n, `[${z0}, ${z1}] of ${tr3.n}`);
	// a find's own states: those the start run lacks; in the best (the find itself) = 1, in the start run = 0
	const inRun = (T) => { const s = new Set(T.H.slice(0, T.n + 1)); return (h) => s.has(h); };
	check('a find that reached the best: all its own states are there', SW.keptShare(tr3.H, tr3.n, tr.H, n, inRun(tr3)) === 1);
	check('a stale find: none of its own states in the best', SW.keptShare(tr3.H, tr3.n, tr.H, n, inRun(tr)) === 0);
	check('a run with no states of its own counts as kept', SW.keptShare(tr.H, n, tr.H, n, () => false) === 1);
}

console.log('estimates');
{
	const rp = C.replay(level, ms, { trace: true });
	const wins = SW.windows(n, 800, 600);
	const loss = wins.map(([x, y]) => SW.lossEstimate(rp, x, y, []));
	const lead = wins.map(([x, y]) => SW.leadEstimate(level, ms, rp, x, y).lead);
	check('lossEstimate and leadEstimate give a number for every window', loss.every(Number.isFinite) && lead.every(Number.isFinite), `loss ${loss.join(' ')} | lead ${lead.join(' ')}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* kept */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
