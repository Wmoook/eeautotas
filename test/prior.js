'use strict';
// test/prior.js - LEARNED MOVES (src/prior.js; goexplore.js --prior, OFF by default):
//   frame    the gravity frame and the facing: every one of the 18 inputs maps to the frame and back for every gravity
//            and facing; L + R and U + D cancel (canon)
//   context  what the ball sees on a step corridor (the engine's own state): on the ground running right with a one-tile
//            step ahead, a tall wall ahead, a gap ahead; the previous input and its hold
//   model    counts -> smoothed distributions: every context sums to 1, an unseen context takes its parent's, a context's
//            own counts dominate once there are many
//   policy   draws follow the model: from one state, 40,000 draws, each input's share within 1% of (1 - eps) p + eps / 18
//   search   goexplore.js on the step corridor: a route without the prior (seed 1), a model learned from it, then with
//            --prior (fine and coarse cells): a route, prior runs counted, the same seed and tick budget give the same
//            search twice; without --prior no prior runs; with --main=<main's goexplore.js> also the flag off = main
//            (the same done numbers for the same seed and tick budget)
// usage: node test/prior.js [--main=<path to origin/main's src/goexplore.js>]   Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-prior-'));
process.env.EEAT_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const PR = require('../src/prior.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const opt = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
function gox(tool, file, args, timeoutMs = 180000) {
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
/** the numbers of a search that a changed draw would change */
const sig = (ev) => { const d = doneOf(ev); const w = (d.workers || [])[0] || {}; return JSON.stringify([d.ticks, d.states, d.picks, d.finish, w.cells, w.impr, w.replays, w.rooms, routesOf(ev).map((r) => r.ticks)]); };

// The step corridor (48 x 12): the spawn S at the left on the floor (row 10), a one-tile step at x 14, a tall wall
// (3 tiles) at x 24 with a ledge to climb, a gap (x 32-34) in the floor over spikes, the trophy T at the right end.
const LW = 48, LH = 12;
function corridor(file) {
	const g = Array.from({ length: LH }, () => Array(LW).fill(0));
	for (let x = 0; x < LW; x++) { g[0][x] = 9; g[LH - 1][x] = 9; g[LH - 2][x] = 9; }
	for (let y = 0; y < LH; y++) { g[y][0] = 9; g[y][LW - 1] = 9; }
	g[9][14] = 9;                                            // the step
	for (let y = 7; y <= 9; y++) g[y][24] = 9;               // the tall wall
	g[9][21] = 9;                                            // a ledge before it
	for (let x = 32; x <= 34; x++) g[10][x] = 0;             // the gap (down to the bottom row)
	const cells = [];
	for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) if (g[y][x] === 9) cells.push([x, y, 9]);
	cells.push([2, 9, 255], [45, 9, 121]);
	fs.writeFileSync(file, ED.eelvlOf({ name: 'step corridor', width: LW, height: LH, cells }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}

function sectionFrame() {
	section('frame: the gravity frame and the facing');
	let bad = 0;
	const OPT = [];
	for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPT.push(h | v | j);
	for (let g = 0; g <= 4; g++) for (const f of [1, -1]) for (const m of OPT) { const y = PR.toFrame(m, g, f); if (y < 0 || y >= 18 || PR.fromFrame(y, g, f) !== m) bad++; }
	check('every input -> frame -> back, every gravity and facing', bad === 0, `${bad} of ${5 * 2 * 18} wrong`);
	const ys = new Set(OPT.map((m) => PR.toFrame(m, 2, -1)));
	check('the 18 inputs are 18 frame outputs (left gravity, facing back)', ys.size === 18);
	check('L + R and U + D cancel (canon)', PR.canon(2 | 4) === 0 && PR.canon(8 | 16 | 1) === 1 && PR.canon(4 | 8 | 16) === 4);
	// down gravity, facing right: R = forward, U = against gravity; up gravity: D is against gravity
	check('down gravity facing right: R+J = forward + jump; up gravity: D = against gravity', PR.toFrame(4 | 1, 0, 1) === 2 * 6 + 1 * 2 + 1 && PR.toFrame(16, 1, 1) === 1 * 6 + 0 * 2 + 0);
	check('facing left mirrors: L = forward', PR.toFrame(2, 0, -1) === PR.toFrame(4, 0, 1));
}

function sectionContext(L) {
	section('context: what the ball sees');
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	const out = [0, 1];
	let held = 0, got = null;
	for (let t = 0; t < 400 && got === null; t++) {
		E.applyMask(inp, 4);
		sim.tick(inp);
		held++;
		const cx = Math.trunc(sim.px + 8) >> 4;
		if (cx === 13 && sim.on_ground) got = PR.digitsOf(PR.contextOf(sim, 4, held, out));
	}
	// digits: field, ground, ahead, ceil, vd, vl, prev, hold
	check('running right on the floor next to the step: gravity field, on the ground, a step ahead, facing right',
		got !== null && got[0] === 0 && got[1] === 1 && got[2] === 1 && out[0] === 0 && out[1] === 1, JSON.stringify(got));
	check('the previous input R = forward, its hold class', got !== null && got[6] === 8 && got[7] === PR.holdClass(held), got && `${got[6]} ${got[7]}`);
	// the tall wall (x 24, 3 high) seen from x 23 on the floor; the gap (x 32) from x 31
	const at = (tx, prev) => { sim.reset(); sim.px = tx * 16; sim.py = 9 * 16; sim.speed_x = 3; sim.speed_y = 0; sim.tick(inp); return PR.digitsOf(PR.contextOf(sim, prev, 20, out)); };
	E.applyMask(inp, 4);
	const w = at(23, 4), gp = at(31, 4);
	check('a tall wall ahead (x 24)', w[2] === 2, JSON.stringify(w));
	check('a gap ahead (x 32)', gp[2] === 3, JSON.stringify(gp));
	const back = at(23, 2);
	check('the previous input L: facing left (the open floor behind is ahead then)', back[2] === 0 && out[1] === -1, JSON.stringify(back));
}

function sectionModel() {
	section('model: smoothing and back-off');
	const counts = new Map();
	const d = [0, 1, 1, 0, 2, 2, 8, 3];
	const ctxOf = (dd) => dd.reduce((c, v, k) => c * PR.DIMS[k] + v, 0);
	const c0 = ctxOf(d);
	const a = new Float64Array(18); a[PR.toFrame(4 | 1, 0, 1)] = 900; a[PR.toFrame(4, 0, 1)] = 100;
	counts.set(c0, a);
	const M = PR.makeModel(counts, 4, { probs: true });
	let worst = 0;
	for (let c = 0; c < PR.NCTX; c += 97) { let s = 0; for (let y = 0; y < 18; y++) s += M.probs[c * 18 + y]; worst = Math.max(worst, Math.abs(s - 1)); }
	check('every context sums to 1 (sampled)', worst < 1e-5, worst.toExponential(2));
	const pFJ = M.probs[c0 * 18 + PR.toFrame(5, 0, 1)];
	check('a context\'s own counts dominate (900 of 1000 forward + jump)', pFJ > 0.85 && pFJ < 0.9, pFJ.toFixed(3));
	const d2 = d.slice(); d2[3] = 2; d2[5] = 3;   // another ceiling and lateral speed: unseen, the same parent (no ceil / vl)
	const c2 = ctxOf(d2);
	check('an unseen context takes its parent\'s distribution', Math.abs(M.probs[c2 * 18 + PR.toFrame(5, 0, 1)] - 0.9 * 1000 / 1004 - 0.004 * 0) < 0.02, M.probs[c2 * 18 + PR.toFrame(5, 0, 1)].toFixed(3));
	return { counts, c0 };
}

function sectionPolicy(L, m) {
	section('policy: the draws follow the model');
	const file = path.join(HOME, 'm_policy.json');
	const counts = {};
	for (const [k, v] of m.counts) counts[k] = Array.from(v);
	fs.writeFileSync(file, JSON.stringify({ version: PR.VERSION, dims: PR.DIMS, alpha: 4, counts }));
	const P = PR.policyOf(file, { eps: 0.1 });
	const M = PR.makeModel(counts, 4, { probs: true });
	// a state whose context is the model's: on the floor at x 13 running right (as in the context section), prev R held
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	let held = 0;
	for (let t = 0; t < 400; t++) { E.applyMask(inp, 4); sim.tick(inp); held++; if ((Math.trunc(sim.px + 8) >> 4) === 13 && sim.on_ground) break; }
	const out = [0, 1];
	const c = PR.contextOf(sim, 4, held, out);
	let s = 12345;
	const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
	const n = 40000, freq = new Map();
	for (let k = 0; k < n; k++) { const x = P.draw(sim, 4, held, rnd); freq.set(x, (freq.get(x) || 0) + 1); }
	let worst = 0;
	for (let y = 0; y < 18; y++) {
		const mk = PR.fromFrame(y, out[0], out[1]);
		const want = 0.9 * M.probs[c * 18 + y] + 0.1 / 18;
		worst = Math.max(worst, Math.abs((freq.get(mk) || 0) / n - want));
	}
	check('40,000 draws: each input\'s share within 1% of (1 - eps) p + eps / 18', worst < 0.01, `worst ${worst.toFixed(4)}; R+J ${((freq.get(5) || 0) / n).toFixed(3)}`);
	check('a draw reads the live state only (the state is unchanged)', (() => { const h = sim.stateHash(); P.draw(sim, 4, held, rnd); P.drawSwitch(sim, 4, held, rnd); return sim.stateHash() === h; })());
	// --priorMode=1: a switch is never the last input, and follows the model without it
	const fs2 = new Map();
	let same = 0;
	for (let k = 0; k < n; k++) { const x = P.drawSwitch(sim, 4, held, rnd); if (x === 4) same++; fs2.set(x, (fs2.get(x) || 0) + 1); }
	const pr = M.probs[c * 18 + PR.toFrame(4, out[0], out[1])];
	let worst2 = 0;
	for (let y = 0; y < 18; y++) {
		const mk = PR.fromFrame(y, out[0], out[1]);
		if (mk === 4) continue;
		const want = 0.9 * M.probs[c * 18 + y] / (1 - pr) + 0.1 / 17;
		worst2 = Math.max(worst2, Math.abs((fs2.get(mk) || 0) / n - want));
	}
	check('a switch (mode 1): never the last input; each other input\'s share within 1% of (1 - eps) p / (1 - p(last)) + eps / 17', same === 0 && worst2 < 0.01, `same ${same}, worst ${worst2.toFixed(4)}`);
}

function sectionSearch(file, L) {
	section('search: goexplore.js with and without --prior');
	const base = ['--workers=1', '--maxTicks=3000000', '--seconds=120', '--seed=1', '--mem=200'];
	const r0 = gox(GOX, file, [...base, '--cells=fine']);
	const rt = routesOf(r0);
	check('without the prior: a route (seed 1)', rt.length > 0, rt.length ? `${rt[rt.length - 1].ticks} ticks` : 'none');
	check('without the prior: no prior runs in the done event', doneOf(r0).priorRuns === undefined);
	if (!rt.length) return;
	// the model from that route (the level's own: this checks the plumbing, not the transfer)
	const cnt = new Map();
	PR.countRun(E, L, masksOf(rt[rt.length - 1].inputs), cnt);
	const counts = {};
	for (const [k, v] of cnt) counts[k] = Array.from(v);
	const mf = path.join(HOME, 'm_route.json');
	fs.writeFileSync(mf, JSON.stringify({ version: PR.VERSION, dims: PR.DIMS, alpha: 4, counts }));
	for (const [cells, mode] of [['fine', 0], ['coarse', 0], ['coarse', 1]]) {
		const arg = [...base, `--cells=${cells}`, `--prior=${mf}`, `--priorMode=${mode}`];
		const a1 = gox(GOX, file, arg), a2 = gox(GOX, file, arg);
		const d1 = doneOf(a1), rr = routesOf(a1);
		const ev = rr.length ? C.evaluate(L, masksOf(rr[rr.length - 1].inputs)) : null;
		const what = `${cells} cells with --prior (mode ${mode})`;
		check(`${what}: a route (replayed)`, !!ev, rr.length ? `${rr[rr.length - 1].ticks} ticks, ${ev ? ev.runTicks + ' run ticks' : 'does not replay'}` : 'none');
		check(`${what}: prior runs, about --priorP (0.5) of the runs`, d1.priorRuns > 0 && Math.abs(d1.priorRuns / (d1.picks * 8) - 0.5) < 0.05, `${d1.priorRuns} of ${d1.picks * 8}`);
		check(`${what}: the same seed and tick budget give the same search`, sig(a1) === sig(a2), sig(a1));
	}
	const bad = gox(GOX, file, [...base, `--prior=${path.join(HOME, 'nope.json')}`]);
	check('a missing model fails at the start (an error line, no search)', bad.some((e) => e.error && /--prior/.test(e.error)) && !bad.some((e) => e.ev === 'done'));
	if (opt.main) {
		for (const cells of ['fine', 'coarse']) {
			const x = gox(GOX, file, [...base, `--cells=${cells}`]), y = gox(path.resolve(opt.main), file, [...base, `--cells=${cells}`]);
			check(`${cells} cells without --prior = main (the same done numbers)`, sig(x) === sig(y), `${sig(x)} vs ${sig(y)}`);
		}
	}
}

const file = path.join(HOME, 'corridor.eelvl');
const L = corridor(file);
sectionFrame();
sectionContext(L);
const m = sectionModel();
sectionPolicy(L, m);
sectionSearch(file, L);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
