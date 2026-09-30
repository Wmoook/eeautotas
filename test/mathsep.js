'use strict';
// node test/mathsep.js: the separability code (src/math/axis.js, src/math/regime.js) against eesim.js, fast (< 30 s).
// The long engine checks are tools/math/sepcheck.js (docs/ee_math.md section 2).
//   1. cross products in uniform environments (small T): engine(x pattern | y pattern) = (x of the x run, y of the y run)
//   2. the per-axis model = the engine on every separable tick of random walks on random rooms of every block kind
//   3. each coupling class seen where it must be: a corner, a one-way, a portal, a walk-off (triangular), a field edge
//   4. certifyFree: free-air paths certified, a path into a wall refused at its first bad tick
//   5. translation: offsets identical under a shift by 16 in the same binade, not across a binade (in general)
const E = require('../src/eesim.js');
const A = require('../src/math/axis.js');
const R = require('../src/math/regime.js');
const SC = require('../tools/math/sepcheck.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// 1. cross products
for (let e = 0; e < SC.ENVS.length; e++) {
	const r = SC.freeTask({ env: e, seed: 77 + e, T: 7, k: 2 });
	ok(r.runs > 0 && r.missX === 0 && r.missY === 0 && r.left === 0, `cross product ${r.env}: runs ${r.runs} missX ${r.missX} missY ${r.missY}`);
}

// 2. random rooms, random walks: separable ticks exact
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const KINDS = [9, 9, 9, 0, 0, 0, 0, 0, 1, 2, 3, 4, 1518, 118, 119, 369, 114, 115, 116, 117, 61, 1041, 1042, 1043, 1064, 100, 417, 419, 453, 461, 1517];
let sepT = 0, exact = 0, allT = 0;
for (let room = 0; room < 30; room++) {
	const r = rng(1000 + room);
	const W = 40, H = 30, tiles = [];
	for (let i = 0; i < 160; i++) {
		const x = 1 + Math.floor(r() * (W - 2)), y = 1 + Math.floor(r() * (H - 2));
		const id = KINDS[Math.floor(r() * KINDS.length)];
		if (id !== 0) tiles.push([x, y, id]);
	}
	const L = SC.mkLevel(W, H, 0, tiles.filter(([x, y]) => !(x >= 18 && x <= 21 && y >= 13 && y <= 16)));
	const sim = new E.EESim(L); sim.reset();
	sim.px = 320 + r() * 16; sim.py = 240 + r() * 16; sim._q0 = 0; sim._q1 = 0;
	const inp = new E.EEInput();
	let m = 0;
	for (let t = 0; t < 600; t++) {
		if (r() < 0.15) m = Math.floor(r() * 32);
		const cls = R.classifyTick(sim, m);
		const pb = R.paramsOf(sim);
		E.applyMask(inp, m); sim.tick(inp);
		const pa = R.paramsOf(sim);
		let eff = false; for (let i = 0; i < pa.length; i++) if (!Object.is(pa[i], pb[i])) eff = true;
		allT++;
		if (cls.sep && !eff && !sim.teleported) { sepT++; if (R.modelMatches(cls.model, sim)) exact++; }
	}
}
ok(sepT > 5000 && exact === sepT, `random rooms: separable ticks ${sepT} of ${allT}, model exact on ${exact}`);
console.log(`random rooms: ${sepT} separable ticks of ${allT}, the per-axis model exact on ${exact}`);

// 3. couplings
function one(tiles, set, masks, W = 30, H = 20) {
	const L = SC.mkLevel(W, H, 0, tiles);
	const sim = new E.EESim(L); sim.reset();
	Object.assign(sim, set); sim._q0 = 0; sim._q1 = 0;
	const inp = new E.EEInput();
	const codes = [];
	for (const m of masks) { const c = R.classifyTick(sim, m).code; E.applyMask(inp, m); sim.tick(inp); codes.push(c | (sim.teleported ? R.C_PORTAL : 0)); }
	return { codes, sim };
}
// a wall column that ends: the ball moving right and down past its lower end -> a CORNER tick
{
	const tiles = []; for (let y = 1; y <= 8; y++) tiles.push([12, y, 9]);
	const r = one(tiles, { px: 12 * 16 - 16, py: 8 * 16 + 2, speed_x: 3, speed_y: 6 }, [4, 4, 4, 4]);
	// the blocked x step retried after y moved below the wall's end: x depends on y (triangular), or a mutual corner
	ok(r.codes.some((c) => (c & (R.C_CORNER | R.C_TRIYX)) !== 0), 'corner at the end of a wall: ' + r.codes.map((c) => c.toString(16)).join(' '));
}
// a one-way platform under a falling ball -> ONEWAY
{
	const tiles = []; for (let x = 5; x < 15; x++) tiles.push([x, 12, 61]);
	const r = one(tiles, { px: 150, py: 12 * 16 - 20, speed_x: 0, speed_y: 3 }, [0, 0, 0, 0, 0]);
	ok(r.codes.some((c) => (c & R.C_ONEWAY) !== 0), 'one-way platform flagged');
}
// the walk-off: a floor with a gap: separable ticks, but the y contact ends where x leaves the floor (triangular)
{
	const tiles = []; for (let x = 1; x < 29; x++) if (x < 14 || x > 16) tiles.push([x, 15, 9]);
	const r = one(tiles, { px: 13 * 16 - 20, py: 14 * 16, speed_x: 2, speed_y: 0 }, new Array(20).fill(4));
	const blk = r.codes.map((c) => ((c & R.C_YHITP) !== 0 ? 1 : 0));
	// every tick a product except the walk-off tick itself (y probed after x's step: y depends on x, x independent)
	const coupled = r.codes.filter((c) => (c & R.C_COUPLED) !== 0);
	ok(coupled.length <= 1 && coupled.every((c) => (c & R.C_COUPLED) === R.C_TRIXY) && blk[0] === 1 && blk.slice(-3).every((b) => b === 0),
		'walk-off: products, one triangular tick, y contact then free ' + blk.join('') + ' ' + coupled.map((c) => c.toString(16)).join(','));
}
// a field edge: running from air into an arrow field -> ENVCHG through pathRegimes
{
	const tiles = []; for (let x = 16; x < 29; x++) for (let y = 1; y < 19; y++) tiles.push([x, y, 1]);
	const L = SC.mkLevel(30, 20, 0, tiles);
	const sim = new E.EESim(L); sim.reset(); sim.px = 200; sim.py = 150; sim.speed_x = 6; sim._q0 = 0; sim._q1 = 0;
	const res = R.pathRegimes(L, new Uint8Array(20).fill(4), { sim, check: true });
	ok(res.stats.envChanges >= 2 && res.stats.sepMiss === 0, `field edge: env changes ${res.stats.envChanges}, misses ${res.stats.sepMiss}`);
}

// 4. certifyFree
{
	// the path of an empty room, then the same path against the room with one block on it (at tick 20's centre tile)
	const L0 = SC.mkLevel(60, 60, 0, []);
	const sim = new E.EESim(L0); sim.reset(); sim.px = 400.3; sim.py = 300.7; sim.speed_x = 1; sim.speed_y = -3; sim._q0 = 0; sim._q1 = 0;
	const inp = new E.EEInput();
	const xs = [sim.px], ys = [sim.py];
	for (let t = 0; t < 40; t++) { E.applyMask(inp, 4); sim.tick(inp); xs.push(sim.px); ys.push(sim.py); }
	ok(R.certifyFree(L0, xs, ys) === -1, 'certifyFree: the free-air path certified');
	const bx = Math.trunc(xs[20] + 8) >> 4, by = Math.trunc(ys[20] + 8) >> 4;
	const L1 = SC.mkLevel(60, 60, 0, [[bx, by, 9]]);
	const c = R.certifyFree(L1, xs, ys);
	ok(c > 0 && c <= 20, `certifyFree refuses the path through a block at ${c} (the block at tick 20)`);
	const L2 = SC.mkLevel(60, 60, 0, [[bx, by, 1]]);
	const c2 = R.certifyFree(L2, xs, ys);
	ok(c2 > 0 && c2 <= 21, `certifyFree refuses the path into an arrow field at ${c2}`);
}

// 4b. envSchedule = the engine's current / delayed tiles along a run, from the positions alone
{
	const r = rng(4242);
	const tiles = [];
	for (let i = 0; i < 300; i++) tiles.push([1 + Math.floor(r() * 38), 1 + Math.floor(r() * 28), [1, 2, 3, 4, 118, 119, 1518, 114, 1041, 1042, 0][Math.floor(r() * 11)]]);
	const L = SC.mkLevel(40, 30, 0, tiles.filter(([x, y]) => !(x >= 18 && x <= 21 && y >= 13 && y <= 16)));
	const sim = new E.EESim(L); sim.reset(); sim.px = 320; sim.py = 240; sim._q0 = 0; sim._q1 = 0;
	const q0 = sim._q0, q1 = sim._q1;
	const inp = new E.EEInput();
	const xs = [sim.px], ys = [sim.py], cur = [0], del = [0];
	let m = 0, dead = false;
	for (let t = 0; t < 500 && !dead; t++) {
		if (r() < 0.15) m = Math.floor(r() * 32);
		const env = A.envOf(sim, m);
		cur.push(env.current); del.push(env.delayed);
		E.applyMask(inp, m); sim.tick(inp);
		if (sim.teleported || sim.is_dead) dead = true;
		xs.push(sim.px); ys.push(sim.py);
	}
	const s = R.envSchedule(L, xs, ys, q0, q1);
	let diff = 0;
	for (let t = 1; t < cur.length; t++) if (s.curId[t] !== cur[t] || s.delId[t] !== del[t]) diff++;
	ok(diff === 0 && cur.length > 50, `envSchedule = the engine's current / delayed tiles on ${cur.length - 1} ticks (${diff} differ)`);
}

// 5. translation
{
	const t = SC.transTask({ axis: 'x', base: 700, shifts: [16, 1], T: 12, seed: 5 });
	const same16 = t.cat['n%16=0|sameBinade|noAlign'] || t.cat['n%16=0|sameBinade|alignArmed'];
	ok(!same16 || same16.same === same16.n, 'shift 16 in the same binade: identical offsets');
	const s1 = t.cat['n%16!=0|sameBinade|noAlign'];
	ok(!s1 || s1.same === s1.n, 'shift 1, no align: identical offsets');
}

console.log(`mathsep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
