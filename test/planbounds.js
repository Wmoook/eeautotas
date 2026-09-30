'use strict';
// test/planbounds.js: the primitives part's bounds (src/plan/bounds.js). Prints 'name: ok|FAIL', ends with 'N/M', exits 1
// on a failure.
//   node test/planbounds.js                      B-UNIT: fields on toy rooms against an exhaustive engine search
//   node test/planbounds.js --truth [--limit=N] [--pairs=200] [--root=<truth root>] [--only=<name substring>]
//                                                T-LB-ADMISSIBLE on the known routes (src/plan/truthset.js)
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const EG = require('../src/endgame.js');
const T = require('../src/plan/types.js');
const BO = require('../src/plan/bounds.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? '1' : m[2]; }
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };

// ---------------------------------------------------------------- toy rooms
const levelOf = (rows, ID) => {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells }))));
};
const BASE = { '#': [9], S: [255], G: [121], k: [6], d: [23], P: [242, 0, 1, 2], Q: [242, 0, 2, 1], x: [361, 1], C: [360], B: [115], u: [116] };

/** earliest tick (after `pre` masks) at which the centre is in each tile, by an exhaustive search over the masks
 *  (endgame.js probeMasks: the masks whose unread axis provably does nothing once; stateHash dedup; deaths dropped).
 *  A capped layer makes it an upper bound of the true minimum: a bound above it is still a real violation. */
function bfsMin(L, pre, depth, cap) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (const m of pre) { E.applyMask(inp, m); sim.tick(inp); }
	const W = L.width, H = L.height, minT = new Int32Array(W * H).fill(-1);
	const seen = new EG.HashSet(16);
	seen.add(sim.stateHash());
	minT[T.tileOf(sim, W, H)] = 0;
	let layer = [sim.snapshot()], states = 1, capped = false;
	for (let d = 1; d <= depth && layer.length; d++) {
		const next = [];
		for (const s of layer) {
			const masks = EG.probeMasks(sim, inp, s);
			for (let k = 0; k < masks.length; k++) {
				if (k > 0) { sim.restore(s); E.applyMask(inp, masks[k]); sim.tick(inp); }
				if (sim.is_dead) continue;
				if (!seen.add(sim.stateHash())) continue;
				const t = T.tileOf(sim, W, H);
				if (minT[t] < 0) minT[t] = d;
				if (next.length < cap) next.push(sim.snapshot()); else capped = true;
			}
		}
		states += next.length;
		layer = next;
	}
	sim.reset();
	for (const m of pre) { E.applyMask(inp, m); sim.tick(inp); }
	return { minT, states, capped, sim };
}
/** every reached tile as a goal: the bound from the search's start never above the search's minimum */
function roomCheck(name, L, pre, depth, cap, B) {
	const r = bfsMin(L, pre, depth, cap);
	let n = 0, bad = 0, tight = 0, worst = '';
	for (let g = 0; g < r.minT.length; g++) {
		if (r.minT[g] < 0) continue;
		const f = B.field([g]);
		const b = B.at(f, r.sim), bt = f[T.tileOf(r.sim, L.width, L.height)];
		n++;
		if (b > r.minT[g] || bt > b) { bad++; if (!worst) worst = `goal ${g % L.width},${(g / L.width) | 0}: at ${b} tile ${bt} > min ${r.minT[g]}`; }
		if (r.minT[g] > 0) tight += b / r.minT[g];
	}
	check(`B-UNIT ${name}`, bad === 0 && n > 3, `${n} goals, ${bad} above the search's minimum ${worst}; mean lb/min ${(tight / Math.max(1, n)).toFixed(2)}; ${r.states} states${r.capped ? ' (capped)' : ''}`);
}

function unit() {
	// a corridor with a floor
	const corr = levelOf([
		'######################',
		'#....................#',
		'#....................#',
		'#S..................G#',
		'######################',
	], BASE);
	const B1 = BO.createBounds(corr);
	const W1 = corr.width;
	const fT = B1.field([3 * W1 + 20]);
	check('B-UNIT corridor: 0 at the goal, rising with distance', fT[3 * W1 + 20] === 0 && fT[3 * W1 + 19] >= 1 && fT[3 * W1 + 1] > fT[3 * W1 + 10] && fT[3 * W1 + 10] > fT[3 * W1 + 19], `${fT[3 * W1 + 1]} ${fT[3 * W1 + 10]} ${fT[3 * W1 + 19]}`);
	check('B-UNIT corridor: walls Infinity-free (their value is never read), the vmax rule is the plain run', B1.vmax.xp < 7 && B1.vmax.yp < 14 && B1.vmax.yn < 7, JSON.stringify(B1.vmax));
	roomCheck('corridor exhaustive', corr, [], 40, 60000, B1);
	// a staircase
	const stair = levelOf([
		'##############',
		'#...........G#',
		'#.........####',
		'#.......###..#',
		'#.....###....#',
		'#...###......#',
		'#S###........#',
		'##############',
	], BASE);
	const B2 = BO.createBounds(stair);
	roomCheck('staircase exhaustive', stair, [], 45, 60000, B2);
	// a portal pair: the far side is near through the portal
	const port = levelOf([
		'##########################',
		'#........................#',
		'#S.P##################Q.G#',
		'##########################',
	], BASE);
	const B3 = BO.createBounds(port);
	const W3 = port.width;
	const fP = B3.field([2 * W3 + 24]);
	check('B-UNIT portal: the start is near through the portal (walled off from the goal otherwise)', fP[2 * W3 + 1] < 8 && fP[2 * W3 + 1] >= 1, `start ${fP[2 * W3 + 1]}`);
	roomCheck('portal exhaustive', port, [], 30, 60000, B3);
	// a walled pocket: Infinity
	const pocket = levelOf([
		'############',
		'#..........#',
		'#S.....###.#',
		'#......#G#.#',
		'#......###.#',
		'############',
	], BASE);
	const B4 = BO.createBounds(pocket);
	const fK = B4.field([3 * pocket.width + 8]);
	check('B-UNIT walled pocket: Infinity from outside, 0 inside', fK[2 * pocket.width + 1] === Infinity && fK[3 * pocket.width + 8] === 0);
	// a key door: shut in the level as it stands (Lc), open relaxed
	const door = levelOf([
		'################',
		'#.........d....#',
		'#S.k......d...G#',
		'################',
	], BASE);
	const B5 = BO.createBounds(door);
	const Wd = door.width;
	const s0 = T.playTo(door, new Uint8Array(0)).sim;
	const Lc = T.levelNow(door, s0);
	const fr = B5.field([2 * Wd + 14]), fs = B5.field([2 * Wd + 14], Lc);
	check('B-UNIT door: open (relaxed) finite, shut (Lc) no way', fr[2 * Wd + 1] > 0 && fr[2 * Wd + 1] < 40 && fs[2 * Wd + 1] === Infinity, `relaxed ${fr[2 * Wd + 1]}, shut ${fs[2 * Wd + 1]}`);
	roomCheck('door exhaustive (relaxed)', door, [], 40, 60000, B5);
	// deaths: a spike in the way, a checkpoint: the death edge
	const death = levelOf([
		'####################',
		'#..................#',
		'#S.C....x..........#',
		'##########.#########',
		'#.........G........#',
		'####################',
	], BASE);
	const B6 = BO.createBounds(death);
	check('B-UNIT deaths: death sources and respawns found', B6.static.deaths && B6.static.dsrc.length > 0 && B6.static.respawn.length >= 2, `${B6.static.dsrc.length} sources, ${B6.static.respawn.length} respawns`);
	roomCheck('deaths exhaustive (deaths dropped)', death, [], 45, 60000, B6);
	// a boost: the vmax rule gives way
	const boost = levelOf([
		'####################',
		'#..................#',
		'#S.B..............G#',
		'####################',
	], BASE);
	const B7 = BO.createBounds(boost);
	check('B-UNIT boost: xp at the cap', B7.vmax.xp >= 16 && B7.vmax.xn < 7, JSON.stringify(B7.vmax));
	roomCheck('boost exhaustive', boost, [], 25, 60000, B7);
	// a mid state (not a node-aligned start): after 7 ticks holding right
	roomCheck('corridor from a moving state', corr, [4, 4, 4, 4, 4, 4, 5], 30, 60000, B1);
	// speed: a 400 x 200 open level with walls
	const big = [];
	for (let y = 0; y < 200; y++) {
		let r = '';
		for (let x = 0; x < 400; x++) r += (x === 0 || y === 0 || x === 399 || y === 199 || (x % 20 === 10 && y % 30 < 25) || (y % 40 === 20 && x % 50 < 40)) ? '#' : '.';
		big.push(r);
	}
	big[198] = '#S' + big[198].slice(2, 397) + '.G#';
	const LB = levelOf(big, BASE);
	const B8 = BO.createBounds(LB);
	const t0 = Date.now();
	const fB = B8.field([198 * 400 + 398]);
	const ms = Date.now() - t0;
	console.log(`  speed: a 400 x 200 field in ${ms} ms (${B8.stats().rounds} rounds), start ${fB[198 * 400 + 1]}`);
	check('B-UNIT speed: 400 x 200 field within 150 ms', ms <= 150, `${ms} ms`);
}

// ---------------------------------------------------------------- T-LB-ADMISSIBLE
function truth() {
	const TS = require('../src/plan/truthset.js');
	const root = args.root || process.env.EEAT_TRUTH_ROOT;
	const routes = TS.knownRoutes({ root });
	const lim = +args.limit > 0 ? +args.limit : routes.length;
	const npairs = +args.pairs > 0 ? +args.pairs : 200;
	let nR = 0, nP = 0, viol = 0, startViol = 0, skipped = 0;
	const tight = { field: [], iso: [], axis: [], endgame: [] }, tv = { iso: 0, axis: 0, endgame: 0 };
	const vlist = [];
	let rng = 12345;
	const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
	const t0 = Date.now();
	const [shI, shN] = (args.shard || '0/1').split('/').map(Number);
	for (const [ri, e] of routes.slice(0, lim).entries()) {
		if (ri % shN !== shI) continue;
		if (args.only && !String(e.name).toLowerCase().includes(String(args.only).toLowerCase())) continue;
		let tr = null;
		try { tr = TS.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) { skipped++; continue; }
		nR++;
		const L = tr.L, W = L.width, H = L.height, n = tr.masks.length;
		const B = BO.createBounds(L, { endgame: false });
		// the route's states: tiles per tick, snapshots every 64 ticks
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const tiles = new Int32Array(n + 1), dead = new Uint8Array(n + 1);
		tiles[0] = T.tileOf(sim, W, H);
		const snaps = [sim.snapshot()];
		for (let t = 0; t < n; t++) {
			E.applyMask(inp, tr.masks[t]); sim.tick(inp);
			tiles[t + 1] = T.tileOf(sim, W, H); dead[t + 1] = sim.is_dead ? 1 : 0;
			if ((t + 1) % 64 === 0) snaps.push(sim.snapshot());
		}
		const stateAt = (i) => { sim.restore(snaps[i >> 6]); for (let t = (i >> 6) << 6; t < i; t++) { E.applyMask(inp, tr.masks[t]); sim.tick(inp); } return sim; };
		// the pairs: 200 random (i < j, j - i <= 3000, j alive) + every trigger event
		const pairs = [];
		for (let k = 0; k < npairs; k++) {
			const j = 1 + Math.floor(rnd() * n);
			if (dead[j]) continue;
			const i = Math.max(0, j - 1 - Math.floor(rnd() * Math.min(3000, j)));
			pairs.push([i, j]);
		}
		let ev = [];
		try { ev = TS.routeEvents(L, tr.masks, { until: n }).events; } catch (err) { ev = []; }
		for (const x of ev) { const j = x.tick; if (j <= n && !dead[j] && j >= 1) pairs.push([Math.max(0, j - 1 - Math.floor(rnd() * Math.min(3000, j))), j]); }
		for (const [i, j] of pairs) {
			const f = B.field([tiles[j]]);
			const s = stateAt(i);
			const b = B.at(f, s);
			nP++;
			if (b > j - i) { viol++; if (vlist.length < 30) vlist.push(`${e.name} (${e.source}) ${i}->${j}: bound ${b} > ${j - i} tile ${tiles[i] % W},${(tiles[i] / W) | 0} -> ${tiles[j] % W},${(tiles[j] / W) | 0}`); }
			if (j - i > 0) {
				const tr2 = B.tiers(f, s);
				tight.field.push(b / (j - i));
				for (const k of ['iso', 'axis', 'endgame']) if (tr2[k] !== null && tr2[k] !== undefined) { tight[k].push(Math.min(tr2[k], 1e9) / (j - i)); if (tr2[k] > j - i && !(k === 'endgame' && B.static.deaths)) tv[k]++; }
			}
		}
		// the start: the trophies' field from the start state vs the run's ticks
		const trophies = [];
		for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) trophies.push(i);
		if (trophies.length) {
			const f = B.field(trophies);
			sim.reset();
			const b = B.at(f, sim);
			if (b > tr.complete) { startViol++; if (vlist.length < 30) vlist.push(`${e.name} start: bound ${b} > complete ${tr.complete}`); }
			if (b > tr.runTicks) console.log(`  note: ${e.name} start bound ${b} > runTicks ${tr.runTicks} (complete ${tr.complete}: the idle start)`);
		}
		if (nR % 10 === 0) console.log(`  ${nR} routes, ${nP} pairs, ${viol} violations, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
	}
	const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	for (const v of vlist) console.log(`  VIOLATION ${v}`);
	console.log(`  routes ${nR} (skipped ${skipped}), pairs ${nP}, violations ${viol}, start violations ${startViol}`);
	console.log(`  tightness (median bound / true): kept ${med(tight.field).toFixed(3)}, iso ${med(tight.iso).toFixed(3)}, axis ${med(tight.axis).toFixed(3)} (violations per tier: iso ${tv.iso}, axis ${tv.axis}), endgame ${med(tight.endgame).toFixed(3)} (violations on death-free levels ${tv.endgame})`);
	check('T-LB-ADMISSIBLE', nR > 0 && viol === 0 && startViol === 0, `${nR} routes, ${nP} pairs, ${viol} + ${startViol} violations`);
}

if (args.truth) truth(); else unit();
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
