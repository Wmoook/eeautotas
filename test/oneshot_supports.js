'use strict';
// test/oneshot_supports.js - src/plan/oneshot/supports.js against the engine, on a hand-made room with every support
// kind (a floor with a 3-tile gap and a 1-wide pit, a step, half blocks, a one-way platform, a spike, a left-arrow zone
// against a wall, an up-arrow zone under a ceiling, dots, water, a portal pair, a coin, a checkpoint):
//   1 THE LATTICE: every box position on the rest-line lattice (the pull-axis coordinate a multiple of 8, the free axis a
//     multiple of 4: the points 8k and the open pieces' middles) with a free box: the enumeration holds it as a surface
//     support of the centre's pull  <=>  the engine, the ball placed there at rest (the gravity queue its current tile),
//     one tick without input, is grounded and has not moved on the pull axis (killers and one-ways overlapped left out);
//   2 COMPLETENESS: sticky random input runs from the spawn; every move boundary (a landing, a field entered, a teleport,
//     a respawn) classified to an enumerated support of its kind;
//   3 the named features: the pit's centre point excluded, the half blocks' rest line, the arrow zones' side / up supports,
//     the gap's edges (DROP ends, EDGE flags), the field regions and entries, the portal exit, the trigger, the respawns;
//   4 the speed classes: monotone in |v|, the run-up ages at their own bucket, the over-speed buckets; edgeSupports'
//     representatives held by the engine.
// Usage: node test/oneshot_supports.js [--runs=200] [--ticks=600] [--quick]
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SP = require('../src/plan/oneshot/supports.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const RUNS = +(argv.runs || (argv.quick ? 60 : 200)), TICKS = +(argv.ticks || 600);
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// ---------------------------------------------------------------- the room
const W = 48, H = 24, F = 20;
const cells = [];
const put = (x, y, id, ...args) => cells.push([x, y, id, ...args]);
for (let x = 0; x < W; x++) { put(x, 0, 9); put(x, H - 1, 9); }
for (let y = 1; y < H - 1; y++) { put(0, y, 9); put(W - 1, y, 9); }
for (let x = 1; x < W - 1; x++) {
	if ((x >= 10 && x <= 12) || x === 16) continue;                // the gap and the 1-wide pit
	if (x === 26 || x === 27) { put(x, F, 1041, 1); continue; }     // half blocks (rot 1: the lower half solid)
	put(x, F, 9);
}
for (let x = 10; x <= 12; x++) put(x, H - 2, 9);                   // the gap's floor
put(16, F + 1, 9); put(16, F + 2, 9);                               // the pit's floor
for (let x = 20; x <= 23; x++) put(x, F - 1, 9);                    // the step
for (let x = 30; x <= 33; x++) put(x, 16, 61);                      // a one-way platform
put(18, F - 1, 361, 1);                                             // a spike on the floor
for (let y = 3; y <= 10; y++) put(35, y, 9);                        // a wall with a left-arrow zone on its right
for (let y = 5; y <= 9; y++) for (let x = 36; x <= 38; x++) put(x, y, 1);
for (let x = 39; x <= 43; x++) put(x, 11, 9);                       // a ceiling with an up-arrow zone under it
for (let y = 12; y <= 14; y++) for (let x = 40; x <= 42; x++) put(x, y, 2);
for (let y = 16; y <= 18; y++) for (let x = 1; x <= 2; x++) put(x, y, 4);    // dots
for (let y = 17; y <= 19; y++) for (let x = 6; x <= 8; x++) put(x, y, 119);  // water
put(9, F - 1, 242, 0, 1, 2); put(3, 5, 242, 1, 2, 1);              // a portal pair (the exit turned: the speed rotated)
put(3, 6, 9); put(4, 6, 9); put(2, 6, 9);                           // a ledge under the upper portal
put(14, F - 1, 100);                                                // a coin
put(24, F - 2, 360);                                                // a checkpoint on the step
put(3, F - 1, 255);                                                 // the spawn
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'supports', width: W, height: H, cells }))));
const S = SP.buildSupports(L);
const st = S.stats;
console.log(`room ${W}x${H}: surface ${st.surf} (${JSON.stringify(st.surfByDir)}), spans ${st.spans} ${JSON.stringify(st.spanEnds)}, fields ${st.fields} ${JSON.stringify(st.fieldKinds)}, portals ${st.portalExits}, triggers ${st.triggers}, respawns ${st.respawns}, ${st.ms} ms`);

const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
const start = sim.snapshot();

// ---------------------------------------------------------------- 1 the lattice
/** the lattice check on a level: [agree, checked] (every flip the level holds; free boxes without one-ways / doors;
 *  killers left out) */
function lattice(L, S, quiet) {
	let A = 0, C = 0;
	for (const f of S.flips) { const [a, c] = lattice1(L, S, f, quiet); A += a; C += c; }
	return [A, C];
}
function lattice1(L, S, flip, quiet) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const start = sim.snapshot();
	const P = SP.makeProbe(L);
	const lines = SP.lineIndex(S);
	const inSupport = (d, rest, free) => {
		const ids = lines.get(flip * 4 + d + ':' + rest) || [];
		for (const r of ids) {
			if (S.surf.flags[r] & SP.SF_XPULL) continue;            // (FXFLIP supports ground the ball on that tick: counted)
			const lo = S.surf.lo[r], hi = S.surf.hi[r], cl = S.surf.closed[r];
			if ((free > lo || (free === lo && (cl & 1))) && (free < hi || (free === hi && (cl & 2)))) return r;
		}
		return -1;
	};
	let checked = 0, agree = 0, bad = 0;
	for (let y = 0; y <= P.maxY; y += 4) {
		for (let x = 0; x <= P.maxX; x += 4) {
			if (P.probe(x, y) !== 0 || P.out.no > 0 || P.out.nd > 0) continue;       // a free box, no one-way / door in it
			const c = SP.centreOf(L, x, y);
			if ((L.gFlags[c.cur] & 4) !== 0) continue;                             // a killer: dead, not grounded
			const d = SP.pullDir(L, c.cur, flip);
			if (d < 0) continue;
			const vert = d === SP.D_DOWN || d === SP.D_UP;
			const rest = vert ? y : x, free = vert ? x : y;
			if (rest % 8 !== 0) continue;
			// the step toward the pull: a door there (its state is the run's: the enumeration's condition) left out
			const DX = [0, 0, -1, 1][d], DY = [1, -1, 0, 0][d];
			if (P.probe(x + DX, y + DY) === 0 && P.out.nd > 0) continue;
			const en = inSupport(d, rest, free) >= 0;
			sim.restore(start);
			sim.speed_x = 0; sim.speed_y = 0; sim.modifier_x = 0; sim.modifier_y = 0;
			sim._q0 = c.cur; sim._q1 = c.cur; sim.flip_gravity = flip;
			sim.px = x; sim.py = y; sim.teleported = true;
			E.applyMask(inp, 0); sim.tick(inp);
			const eng = !sim.is_dead && sim.on_ground && (vert ? sim.py : sim.px) === rest;
			checked++;
			if (en === eng) agree++;
			else if (!quiet && bad++ < 5) console.log(`  lattice: (${x}, ${y}) flip ${flip} pull ${SP.DIR_NAMES[d]}: enumeration ${en}, engine ${eng} (after: ${sim.px}, ${sim.py}, ground ${sim.on_ground})`);
		}
	}
	return [agree, checked];
}
if (argv.levels) {
	// the lattice on real levels (files, comma separated): node test/oneshot_supports.js --levels=a.eelvl,b.eelvl
	const T = require('../src/plan/types.js');
	for (const f of String(argv.levels).split(',').filter(Boolean)) {
		const LL = T.loadLevelFile(f), SS = SP.buildSupports(LL);
		const t0 = Date.now();
		const [a, c] = lattice(LL, SS);
		console.log(`${f.split(/[\\/]/).pop()} ${LL.width}x${LL.height}: lattice ${a} / ${c} agree (${Date.now() - t0} ms)`);
		ok(a === c, `lattice ${f}`);
	}
	console.log(`${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}
{
	const [agree, checked] = lattice(L, S);
	console.log(`lattice: ${agree} / ${checked} positions agree`);
	ok(checked > 1000 && agree === checked, `the lattice: enumeration = engine at every position (${agree}/${checked})`);
}

// ---------------------------------------------------------------- 2 completeness on random runs
{
	let seed = 12345;
	const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
	const MASKS = [0, 1, 2, 3, 4, 5, 8, 16, 2 | 8, 4 | 8, 2 | 16, 4 | 16, 1 | 8, 1 | 16];
	const flags = sim._flags;
	const clsOf = (s) => { if (s.is_dead) return 'D'; const id = s.current_tile, f = flags[id] | 0; if (f & 64) return 'W'; if (f & 32) return 'C'; if (id === 4 || id === 414) return 'Z'; if (f & 128) return 'B'; if (s.on_ground) return 'G'; return 'A'; };
	const tally = {};
	let misses = 0;
	for (let r = 0; r < RUNS; r++) {
		sim.restore(start);
		let m = 0, prev = clsOf(sim);
		for (let t = 0; t < TICKS; t++) {
			if (t === 0 || rnd() < 0.08) m = MASKS[(rnd() * MASKS.length) | 0];
			const px = sim.px, py = sim.py;
			E.applyMask(inp, m); sim.tick(inp);
			const c = clsOf(sim);
			const tp = !sim.is_dead && (Math.abs(sim.px - px) > 20 || Math.abs(sim.py - py) > 20);
			let what = null;
			if (prev === 'D' && c !== 'D') what = 'respawn';
			else if (tp) what = 'portal';
			else if (c !== prev && c !== 'A' && c !== 'D') what = c;
			prev = c;
			if (!what) continue;
			let hit;
			if (what === 'respawn') hit = sim.px % 16 === 0 && sim.py % 16 === 0 && S.respAt.has((sim.py / 16) * W + sim.px / 16);
			else {
				const res = SP.classify(S, sim, { teleported: what === 'portal' });
				hit = res.id >= 0 && (what === 'portal' ? res.kind === 'portal' : what === 'G' ? res.kind === 'surf' : res.kind === 'field' && res.letter === what);
				if (!hit && misses++ < 5) console.log(`  run ${r} t ${t + 1}: ${what} at (${sim.px}, ${sim.py}) v (${sim.speed_x}, ${sim.speed_y}): ${JSON.stringify(res)}`);
			}
			const o = tally[what] || (tally[what] = { n: 0, hit: 0 });
			o.n++; if (hit) o.hit++;
		}
	}
	console.log('random runs:', JSON.stringify(tally));
	for (const [k, v] of Object.entries(tally)) ok(v.hit === v.n, `random runs: every ${k} boundary classified (${v.hit}/${v.n})`);
	ok((tally.G || { n: 0 }).n > 100, 'random runs: landings seen');
}

// ---------------------------------------------------------------- 3 the named features
{
	const lines = SP.lineIndex(S);
	const recsOn = (d, rest) => (lines.get(d + ':' + rest) || []).map((r) => ({ r, lo: S.surf.lo[r], hi: S.surf.hi[r], cl: S.surf.closed[r], fl: S.surf.flags[r], span: S.surf.span[r] }));
	const floor = recsOn(SP.D_DOWN, 16 * F - 16);
	const holds = (list, v) => list.some((q) => (v > q.lo || (v === q.lo && (q.cl & 1))) && (v < q.hi || (v === q.hi && (q.cl & 2))));
	ok(!holds(floor, 16 * 16), 'the 1-wide pit: the ball exactly over it (x = 256) has no floor');
	ok(holds(floor, 16 * 16 - 4) && holds(floor, 16 * 16 + 4), 'the 1-wide pit: either side of its centre point holds');
	ok(!holds(floor, 16 * 11), 'the gap: no floor over its middle');
	const edgeRecs = floor.filter((q) => q.fl & SP.SF_EDGE);
	ok(edgeRecs.length >= 4, `the gap's and pit's edges are EDGE supports (${edgeRecs.length})`);
	const dropEnds = [];
	for (let s = 0; s < S.spans.n; s++) if (S.spans.dir[s] === SP.D_DOWN && S.spans.rest[s] === 16 * F - 16) { if (S.spans.endHi[s] === 1) dropEnds.push(S.spans.hi[s]); }
	ok(dropEnds.includes(160 - 8) || dropEnds.some((v) => v >= 144 && v <= 160), `a DROP end at the gap's left edge (${dropEnds.join(',')})`);
	const half = recsOn(SP.D_DOWN, 16 * F - 8);
	ok(half.length > 0 && half.every((q) => q.fl & SP.SF_HALF), 'the half blocks: a rest line 8 px lower, HALF');
	ok(holds(half, 16 * 26 + 8), 'the half blocks: the box over them rests at y = 16 F - 8');
	const step = recsOn(SP.D_DOWN, 16 * (F - 1) - 16);
	ok(holds(step, 16 * 21), 'the step: its top holds');
	const oneway = recsOn(SP.D_DOWN, 16 * 16 - 16);
	ok(holds(oneway, 16 * 31) && oneway.some((q) => q.fl & SP.SF_ONEWAY), 'the one-way platform holds from above, ONEWAY');
	const left = recsOn(SP.D_LEFT, 16 * 36);
	ok(holds(left, 16 * 7), `the left-arrow zone: side supports against the wall (${left.length})`);
	const up = recsOn(SP.D_UP, 16 * 12);
	ok(holds(up, 16 * 41), `the up-arrow zone: ceiling supports (${up.length})`);
	const spike = floor.filter((q) => q.fl & SP.SF_KILL);
	ok(spike.length > 0, 'the spike: KILL supports');
	const names = S.fields.map((f) => f.name).sort();
	ok(names.includes('dot') && names.includes('water') && names.includes('arrowL') && names.includes('arrowU'), `the field regions (${names.join(',')})`);
	const dot = S.fields.find((f) => f.name === 'dot');
	// (the middle cell against the wall has no passable neighbour of another class: 5 entries)
	ok(dot && dot.cells.length === 6 && dot.rest && dot.entries.length === 5, `the dot region: 6 cells, rest, 5 entries (${dot && dot.entries.length})`);
	ok(S.portals.length === 2 && S.portals.every((p) => p.entries.length === 1 && !p.random) && S.portals.some((p) => p.d !== 0), `the portal pair: 2 exits, a turned one (${JSON.stringify(S.portals.map((p) => [p.exit, p.d]))})`);
	ok(S.triggers.some((t) => t.kind === 'coin') && S.triggers.some((t) => t.kind === 'cp'), 'the triggers: the coin, the checkpoint');
	ok(S.respawns.length === 2, `the respawns: the spawn and the checkpoint (${S.respawns.length})`);
	// classify: a ball standing on the floor
	sim.restore(start);
	for (let t = 0; t < 30; t++) { E.applyMask(inp, 0); sim.tick(inp); }
	const c = SP.classify(S, sim);
	ok(c.kind === 'surf' && c.id >= 0 && S.surf.rest[c.id] === sim.py, 'classify: the ball at rest at the spawn is on its floor support');
	ok(SP.keyOf(S, c, sim, 0).startsWith('surf:'), 'keyOf level 0');
}

// ---------------------------------------------------------------- 4 speed classes, edgeSupports
{
	let mono = true, prev = 0;
	for (let v = 0; v <= 16; v += 0.001) { const c = SP.vclass(v); if (c < prev) mono = false; prev = c; }
	ok(mono, 'vclass: non-decreasing in v');
	ok(SP.vclass(0) === 0 && SP.vclass(-1e-9) < 0 && SP.vclass(1e-9) > 0, 'vclass: 0 and the signs');
	ok(SP.vclass(-3) === -SP.vclass(3), 'vclass: odd');
	ok(SP.vclassName(SP.vclass(SP.RUN[22])) === '+run22' && SP.vclassName(SP.vclass(SP.RUN[21])) === '+run16', 'vclass: a run-up age is its own bucket, one tick less the one below');
	ok(SP.vclassName(SP.vclass(16)) === '+v16' && SP.vclassName(SP.vclass(SP.VSTAR)) === '+v*', 'vclass: the over-speed buckets');
	const recs = SP.edgeSupports(S);
	const fails = recs.surfWhy;
	ok(recs[0].kind === 'start' && recs.surfKept > 0 && Object.keys(fails).every((k) => k === 'kill' || k === 'door' || k === 'oneway'), `edgeSupports: every representative held by the engine, but killers / doors / one-ways (${recs.surfKept}/${recs.surfTried} ${JSON.stringify(fails)})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
