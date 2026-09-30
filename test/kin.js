'use strict';
// test/kin.js - src/plan/kin.js (the exact per-tick recurrences of EE movement) against src/eesim.js, tick by tick, bit for
// bit (Object.is on every double: -0 != +0). docs/ee_math.md section 1 states what each part proves.
//
//   node test/kin.js [--only=A,B,C,D,E,F] [--quick] [--runs=N] [--ticks=200] [--seed=S] [--shard=i/n] [--root=<truth root>]
//     A  constants, the flag and gravity tables (every id 0..4095) = eesim.js / prepareLevel's
//     B  THE SPEED RECURRENCES one tick at a time: every context (current, delayed and below tile kind, flip 0..4, speed
//        and jump effects, low gravity, zombie, world gravity, ice timer, protection, dead) x every input (32 masks) x
//        every reachable speed (the 1-D closure from rest, to --depth) and edge / random doubles, in an open region
//     B2 the same in contact: on a floor, at a wall (left / right), under a ceiling, in a corner, of every contact kind
//        (brick, ice, one-ways, half blocks of each rotation, a present, time doors, the secret block 50), touching or
//        a fraction away, in air / dots / water / arrows / climbables / boosts
//     C  FREE RUNS: random levels of every block kind kin models (walls, floors, half blocks, one-ways, liquids, ice,
//        climbables, dots, arrows, boosts, killers, effects, time doors, portals, checkpoints, spawns), random starts,
//        sticky random inputs, kin running on its OWN state next to the engine for --ticks ticks: every field every tick
//     D  exhaustive input trees: from many states, every sequence of the 18 distinct inputs to --tree depth
//     E  the real routes (truthset.js: the user's jobs + the benchmark runs; EEAT_TRUTH_ROOT / --root): kin predicts
//        every tick from the engine's state (one step), with the engine's own door state and portal draws; every
//        mismatch classified
//     F  lemmas the recurrences imply (checked on the model, which A-E tie to the engine): free-air separability,
//        the binade translation lemma of the position update, the speed limits
// Exit code 1 on any difference (E: on any unclassified one).
const fs = require('fs');
const path = require('path');
const E = require('../src/eesim.js');
const K = require('../src/plan/kin.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const QUICK = argv.includes('--quick');
const ONLY = arg('only', 'A,B,B2,C,D,E,F').split(',');
const SEED = +arg('seed', 1);
const [SHARD, NSHARD] = arg('shard', '0/1').split('/').map(Number);
const RUNS = +arg('runs', QUICK ? 60 : 400);
const TICKS = +arg('ticks', 200);
const DEPTH = +arg('depth', QUICK ? 8 : 12);
const TREE = +arg('tree', QUICK ? 4 : 5);
const JSONOUT = arg('json', '');
const GOD = arg('god', '0') === '1';

let pass = 0, fail = 0;
const report = {};
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
function section(s) { console.log(`\n== ${s}`); }

// ---------------------------------------------------------------- rng
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- the engine's fields under kin's names
const MAP = {
	px: 'px', py: 'py', vx: 'speed_x', vy: 'speed_y', modX: 'modifier_x', modY: 'modifier_y', q0: '_q0', q1: '_q1',
	slip: '_slippery', cur: '_current', jc: 'jump_count', maxJ: 'max_jumps', jb: 'jump_boost', sb: 'speed_boost',
	lowg: 'low_gravity', flip: 'flip_gravity', lev: 'has_levitation', thrusting: 'is_thrusting', thr: '_current_thrust',
	inv: 'is_invulnerable', dead: 'is_dead', deadOff: '_dead_offset', deaths: 'deaths', onGround: 'on_ground',
	cursed: 'is_cursed', zombie: 'is_zombie', poison: 'is_poisoned', fire: 'is_on_fire', lastPortal: '_last_portal_set',
	ox: '_ox', oy: '_oy', oa: 'overlapa', ob: 'overlapb', oc: 'overlapc', od: 'overlapd', pastx: '_pastx', pasty: '_pasty',
	nextSpawn: '_next_spawn', ticks: '_ticks', timedoor: '_timedoor_state', grounded: '_grounded',
	curseStart: '_curse_time_start', curseDur: '_curse_duration', zombieStart: '_zombie_time_start', zombieDur: '_zombie_duration',
	poisonStart: '_poison_time_start', poisonDur: '_poison_duration', fireStart: '_fire_time_start', fireDur: '_fire_duration',
	wg: 'world_gravity_multiplier', god: 'in_god_mode',
};
const KEYS = Object.keys(MAP);
/** the first field where kin's st and the engine differ (Object.is), or null */
function diffOf(st, sim, keys) {
	for (const k of keys || KEYS) {
		const a = st[k], b = sim[MAP[k]];
		if (!Object.is(a, b)) return { k, kin: a, eng: b };
	}
	if (st.cpx !== sim.checkpoint.x || st.cpy !== sim.checkpoint.y) return { k: 'checkpoint', kin: [st.cpx, st.cpy], eng: [sim.checkpoint.x, sim.checkpoint.y] };
	return null;
}

// ---------------------------------------------------------------- levels (toSimLevel's JSON format)
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
/** W x H tiles (fg Int32Array), args Map index -> int, portals [[index, rot, id, target]], spawns [[x, y]], gravity */
function mkLevel({ W, H, fg, args = new Map(), portals = [], spawns = [[1, 1]], gravity = 1 }) {
	const extras = [...args].map(([i, a]) => [i, a, null, null]);
	const d = { format: 'eesim-level-1', level_id: 'kin', width: W, height: H, gravity_hex: f64hex(gravity), gravity,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras, lookup_int: [...args], spawn_points: [spawns],
		portals: portals.map(([i, r, id, tg]) => [i, r, id, tg, 0]) };
	return E.prepareLevel(d, { start: 'load' });
}
/** kin's world for a level: time doors by the clock, the other doors shut, portals with one exit each */
function worldFor(L) {
	return K.makeWorld(L, { doorOpen: (id, cx, cy, st) => (id === 156 ? st.timedoor : (id === 157 ? !st.timedoor : false)) });
}

// block kinds of the random levels (every kind kin models; no coin, key, switch, crown, trophy or music block)
const HALFS = [1116, 1117, 1118, 1119, 1120, 1121, 1122, 1123, 1124, 1125, 1041, 1042, 1043, 1075, 1076, 1077, 1078, 1140, 1141];
const PRESENTS = [1101, 1102, 1103, 1104, 1105];
const ONEWAY_PLAIN = [61, 62, 63, 64, 89, 90, 91, 96, 97, 122, 123, 146, 154, 158, 194, 211, 216, 1069, 1087, 1050, 1051];
const ONEWAY_ROT = [1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1155];
const CLIMBS = K.ids.CLIMBABLE_IDS;
const ARROWS = [1, 2, 3, 1518, 411, 412, 413, 1519];
const SOLIDS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 136, 1064, 50];
const KILLS = [368, 361, 1580, 1625, 1630];
const LIQUIDS = [119, 369, 416, 1585];
const DOTS = [4, 414];
const BOOSTS = [114, 115, 116, 117];
/** a random level of rectangles of every kind, border solid, spawns, single-exit portal pairs */
function randomLevel(rng, o = {}) {
	const W = o.W || (20 + Math.floor(rng() * 30)), H = o.H || (16 + Math.floor(rng() * 24));
	const fg = new Int32Array(W * H), args = new Map();
	const set = (x, y, id, a) => { if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return; fg[y * W + x] = id; if (a !== undefined) args.set(y * W + x, a); else args.delete(y * W + x); };
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	const pick = (a) => a[Math.floor(rng() * a.length)];
	const nRect = o.rects || (6 + Math.floor(rng() * 30));
	const kinds = o.kinds || ['solid', 'solid', 'solid', 'half', 'oneway', 'onewayrot', 'liquid', 'ice', 'climb', 'dot', 'arrow', 'boost', 'kill', 'effect', 'timedoor', 'air'];
	for (let r = 0; r < nRect; r++) {
		const kind = pick(kinds);
		const w = 1 + Math.floor(rng() * (kind === 'solid' || kind === 'liquid' || kind === 'air' ? 10 : 4));
		const h = 1 + Math.floor(rng() * (kind === 'solid' || kind === 'liquid' || kind === 'air' ? 6 : 3));
		const x0 = 1 + Math.floor(rng() * (W - 2)), y0 = 1 + Math.floor(rng() * (H - 2));
		let id, a;
		switch (kind) {
			case 'solid': id = pick(SOLIDS); break;
			case 'half': id = pick(rng() < 0.8 ? HALFS : PRESENTS); a = Math.floor(rng() * 5); break;   // rot 4: a full tile
			case 'oneway': id = pick(ONEWAY_PLAIN); break;
			case 'onewayrot': id = pick(ONEWAY_ROT); a = Math.floor(rng() * 5); break;
			case 'liquid': id = pick(LIQUIDS); break;
			case 'ice': id = 1064; break;
			case 'climb': id = pick(CLIMBS); break;
			case 'dot': id = pick(DOTS); break;
			case 'arrow': id = pick(ARROWS); break;
			case 'boost': id = pick(BOOSTS); break;
			case 'kill': id = pick(KILLS); break;
			case 'timedoor': id = rng() < 0.5 ? 156 : 157; break;
			case 'air': id = 0; break;
			case 'effect': {
				const e = pick(['jump', 'run', 'lowg', 'mj', 'grav', 'fly', 'prot', 'reset', 'curse', 'zombie', 'poison', 'npcz', 'cp']);
				switch (e) {
					case 'jump': id = 417; a = Math.floor(rng() * 3); break;
					case 'run': id = 419; a = Math.floor(rng() * 3); break;
					case 'lowg': id = 453; a = Math.floor(rng() * 2); break;
					case 'mj': id = 461; a = pick([0, 1, 2, 3, 5, 1000]); break;
					case 'grav': id = 1517; a = Math.floor(rng() * 6); break;
					case 'fly': id = 418; a = Math.floor(rng() * 2); break;
					case 'prot': id = 420; a = Math.floor(rng() * 2); break;
					case 'reset': id = 1618; break;
					case 'curse': id = 421; a = pick([0, 1, 2]); break;
					case 'zombie': id = 422; a = pick([0, 1, 2]); break;
					case 'poison': id = 1584; a = pick([0, 1, 2]); break;
					case 'npcz': id = 1573; break;
					case 'cp': id = 360; break;
				}
				break;
			}
		}
		for (let y = y0; y < Math.min(H - 1, y0 + h); y++) for (let x = x0; x < Math.min(W - 1, x0 + w); x++) set(x, y, id, a);
	}
	// portals: pairs (and self-targets), one exit per id
	const portals = [];
	const nP = o.portals !== undefined ? o.portals : Math.floor(rng() * 4);
	let pid = 1;
	for (let p = 0; p < nP; p++) {
		const cells = [];
		for (let k = 0; k < 2; k++) {
			const x = 1 + Math.floor(rng() * (W - 2)), y = 1 + Math.floor(rng() * (H - 2));
			if (fg[y * W + x] === 242 || fg[y * W + x] === 381) continue;
			set(x, y, rng() < 0.8 ? 242 : 381);
			cells.push(y * W + x);
		}
		if (cells.length < 2) continue;
		const a = pid++, b = pid++;
		const selfT = rng() < 0.15;
		portals.push([cells[0], Math.floor(rng() * 4), a, selfT ? a : b]);
		portals.push([cells[1], Math.floor(rng() * 4), b, a]);
	}
	// spawns on air cells (a few)
	const spawns = [];
	for (let k = 0; k < 1 + Math.floor(rng() * 3); k++) {
		for (let tries = 0; tries < 50; tries++) {
			const x = 1 + Math.floor(rng() * (W - 2)), y = 1 + Math.floor(rng() * (H - 2));
			if (fg[y * W + x] === 0) { fg[y * W + x] = 255; spawns.push([x, y]); break; }
		}
	}
	if (spawns.length === 0) { fg[W + 1] = 255; spawns.push([1, 1]); }
	const gravity = o.gravity !== undefined ? o.gravity : (rng() < 0.85 ? 1 : pick([Math.fround(0.3), Math.fround(0.5), 2, 0, Math.fround(1.7), -1]));
	return mkLevel({ W, H, fg, args, portals, spawns, gravity });
}

// the 18 distinct inputs (left+right = none, up+down = none) and all 32 masks
const INPUTS18 = [];
for (const hz of [0, 2, 4]) for (const vt of [0, 8, 16]) for (const j of [0, 1]) INPUTS18.push(hz | vt | j);

/** the engine and kin side by side for masks from the current states; returns null or the first difference */
function runPair(sim, st, W, masks, inp) {
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		K.tick(st, masks[t], W);
		const d = diffOf(st, sim);
		if (d) return Object.assign(d, { t });
	}
	return null;
}
function stickyMasks(rng, n, keep) {
	const out = new Uint8Array(n);
	let m = Math.floor(rng() * 32);
	for (let t = 0; t < n; t++) { if (rng() > keep) m = Math.floor(rng() * 32); out[t] = m; }
	return out;
}

// ================================================================ A tables
function testA() {
	section('A constants and tables = eesim.js');
	const C = E.constants;
	let bad = 0;
	for (const k of Object.keys(C)) if (!Object.is(C[k], K[k])) { bad++; console.log('   const', k, C[k], K[k]); }
	check('drag constants and MULT (bits)', bad === 0);
	const L = mkLevel({ W: 3, H: 3, fg: new Int32Array(9).fill(9) });
	let fb = 0, gb = 0;
	const T = K.gravTables();
	for (let id = 0; id < 4096; id++) {
		const f = K.flagsOf(id);
		const ef = (L.flags[id]) | ((L.xflags[id] & 1) ? K.F.KILL : 0) | ((L.xflags[id] & 4) ? K.F.NONROT_HALF : 0);
		if (f !== ef) { fb++; if (fb < 5) console.log('   flags', id, f, ef); }
		if (T.morx[id] !== L.gMorx[id] || T.mory[id] !== L.gMory[id] || !Object.is(T.mox[id], L.gMox[id]) || !Object.is(T.moy[id], L.gMoy[id]) || T.flags[id] !== L.gFlags[id]) {
			gb++; if (gb < 5) console.log('   grav', id);
		}
	}
	check('flags of ids 0..4095 = buildFlags', fb === 0, `${fb} differ`);
	check('gravity tables of ids 0..4095 = prepareLevel', gb === 0, `${gb} differ`);
	check('G = 2 / 7.752, A = 1 / 7.752', K.G === 2 / 7.752 && K.A === 1 / 7.752, `${K.G} ${K.A}`);
}

// ================================================================ B one tick from constructed states
/** the 1-D closure of an axis's speed from 0 under its inputs (kin.stepV; the engine equality is what B checks) */
function closure(ctxOf, inputs, depth, cap) {
	const seen = new Set([0]);
	let layer = [0];
	for (let d = 0; d < depth && layer.length; d++) {
		const next = [];
		for (const v of layer) {
			for (const i of inputs) {
				const w = ctxOf(v, i);
				if (!seen.has(w)) { seen.add(w); next.push(w); if (seen.size >= cap) return [...seen]; }
			}
		}
		layer = next;
	}
	return [...seen];
}
/** the reachable speed sets of B (Map name -> speeds) */
function speedSets(rng) {
	const S = {};
	// reachable speeds: X in air with gravity down (h in -1, 0, 1), Y in air (no input), X and Y in water / mud / dots
	const sets = new Map();
	const addSet = (name, arr) => sets.set(name, arr);
	const cxAir = (v, h) => { K.surface({ cur: 0, del: 0, below: 0 }, S); return K.stepX(v, h, S); };
	const cyAir = (v) => { K.surface({ cur: 0, del: 0, below: 0 }, S); return K.stepY(v, 0, S); };
	addSet('x air', closure(cxAir, [-1, 0, 1], DEPTH, +arg('cap', 2e6)));
	const yAir = new Set([0]);
	for (const v0 of [0, K.jumpSpeed(2, 1), K.jumpSpeed(2, 1.3), K.jumpSpeed(2, 0.75), K.jumpSpeed(2, 0.88), K.jumpSpeed(2, 1.3 * 0.88), -16, 16]) {
		let v = v0; for (let k = 0; k < 400; k++) { yAir.add(v); v = cyAir(v); }
	}
	addSet('y air (falls from rest and every jump)', [...yAir]);
	for (const [nm, id] of [['water', 119], ['mud', 369], ['dot', 4], ['climb', 120], ['lava', 416]]) {
		addSet(`x ${nm}`, closure((v, h) => { K.surface({ cur: id, del: id, below: id }, S); return K.stepX(v, h, S); }, [-1, 0, 1], Math.min(DEPTH, +arg('sdepth', 9)), +arg('scap', 3e5)));
		addSet(`y ${nm}`, closure((v, h) => { K.surface({ cur: id, del: id, below: id }, S); return K.stepY(v, h, S); }, [-1, 0, 1], Math.min(DEPTH, +arg('sdepth', 9)), +arg('scap', 3e5)));
	}
	// ice: x under a held key, released, reversed
	addSet('x ice', closure((v, h) => { K.surface({ cur: 0, del: 0, below: 1064, slip: 2 }, S); return K.stepX(v, h, S); }, [-1, 0, 1], Math.min(DEPTH, +arg('sdepth', 9) + 1), +arg('scap', 3e5)));
	// edge and random doubles
	const edges = [0, -0, 1e-4, -1e-4, 0.0001000000000000001, 16, -16, 15.999999999999998, 1, -1, 0.9999999999999999, 5e-324, 1e-300, 22.72, -22.72, 0.1, 0.2, 13.55];
	for (const e of [...edges]) { edges.push(e * (1 + 2 ** -52)); edges.push(e * (1 - 2 ** -53)); }
	const rnd = []; for (let k = 0; k < (QUICK ? 2000 : 20000); k++) rnd.push((rng() * 2 - 1) * (rng() < 0.2 ? 0.001 : 17));
	addSet('edges', edges); addSet('random', rnd);
	return sets;
}
const EFFECTS = [
	{}, { sb: 1 }, { sb: 2 }, { zombie: true }, { lowg: true }, { jb: 1 }, { jb: 2 }, { flip: 1 }, { flip: 2 }, { flip: 3 }, { flip: 4 },
	{ inv: true }, { slip: 2 }, { slip: 0.2000000000000003 }, { lev: true, thr: 0.2 }, { maxJ: 3, jc: 1 }, { dead: true },
];
function applyFx(sim, fx) {
	if (fx.sb !== undefined) sim.speed_boost = fx.sb;
	if (fx.jb !== undefined) sim.jump_boost = fx.jb;
	if (fx.zombie) sim.is_zombie = true;
	if (fx.lowg) sim.low_gravity = true;
	if (fx.flip !== undefined) sim.flip_gravity = fx.flip;
	if (fx.inv) sim.is_invulnerable = true;
	if (fx.slip !== undefined) sim._slippery = fx.slip;
	if (fx.lev) { sim.has_levitation = true; sim._current_thrust = fx.thr; }
	if (fx.maxJ !== undefined) { sim.max_jumps = fx.maxJ; sim.jump_count = fx.jc; }
	if (fx.dead) { sim.is_dead = true; sim._dead_offset = 3.0; }
}
function testB() {
	section(`B the speed recurrences: one tick, every context x 32 inputs x reachable speeds (depth ${DEPTH})`);
	const rng = mulberry(SEED * 7919 + 13);
	// an open level: a 40 x 40 region of one kind in the middle of air (the ball in its middle: no step collides)
	const kindsCur = [0, 119, 369, 416, 1585, 120, 98, 459, 4, 414, 1, 2, 3, 1518, 411, 412, 413, 1519, 114, 115, 116, 117, 368, 361];
	const sets = speedSets(rng);
	let total = 0;
	for (const [nm, a] of sets) { console.log(`   speed set ${nm}: ${a.length}`); total += a.length; }
	report.B = { sets: Object.fromEntries([...sets].map(([k, v]) => [k, v.length])) };
	// contexts: (current, delayed, below) x flip x effects; the ball at (320 + f, 320 + g) in a 41 x 41 field of `cur`
	// (delayed and below come from the gravity queue and the tile below, which the region fixes: so we build the region
	// of cur, put `del` in the queue by hand, and a column below of `below`)
	let n = 0, bad = 0, first = null;
	const maxBad = 5;
	const effectsList = [
		{}, { sb: 1 }, { sb: 2 }, { zombie: true }, { lowg: true }, { jb: 1 }, { jb: 2 }, { flip: 1 }, { flip: 2 }, { flip: 3 }, { flip: 4 },
		{ inv: true }, { slip: 2 }, { slip: 0.2000000000000003 }, { lev: true, thr: 0.2 }, { maxJ: 3, jc: 1 }, { dead: true },
	];
	const levels = new Map();
	const levelFor = (cur, wg) => {
		const key = cur + '/' + wg;
		if (levels.has(key)) return levels.get(key);
		const W = 44, H = 44, fg = new Int32Array(W * H);
		for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; }
		for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
		for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) fg[y * W + x] = cur;
		const L = mkLevel({ W, H, fg, spawns: [[20, 20]], gravity: wg });
		const o = { L, W: worldFor(L), sim: new E.EESim(L) };
		o.snap0 = o.sim.snapshot();
		levels.set(key, o);
		return o;
	};
	const inp = new E.EEInput();
	const pairs = [];
	for (const cur of kindsCur) for (const del of [cur, 0, 4, 119, 2]) pairs.push([cur, del]);
	const speeds = [];
	for (const [, a] of sets) for (const v of a) speeds.push(v);
	// every speed of every set as vx (with a vy from the sets) and as vy; contexts round robin; all 32 masks
	const nCtx = pairs.length * effectsList.length;
	const perSpeed = QUICK ? 1 : 2;
	const t0 = Date.now();
	for (let si = SHARD; si < speeds.length; si += NSHARD) {
		const v = speeds[si];
		for (let rep = 0; rep < perSpeed; rep++) {
			const ci = Math.floor(rng() * nCtx);
			const [cur, del] = pairs[ci % pairs.length];
			const fx = effectsList[Math.floor(ci / pairs.length)];
			const wg = rng() < 0.9 ? 1 : Math.fround(0.3);
			const lv = levelFor(cur, wg);
			const w = speeds[Math.floor(rng() * speeds.length)];
			const asX = rng() < 0.5;
			const fracx = rng() < 0.3 ? 0 : rng(), fracy = rng() < 0.3 ? 0 : rng();
			const px = 320 + Math.floor(rng() * 16) + fracx, py = 320 + Math.floor(rng() * 16) + fracy;
			for (let m = 0; m < 32; m++) {
				const sim = lv.sim;
				sim.restore(lv.snap0);
				sim.px = px; sim.py = py;
				sim.speed_x = asX ? v : w; sim.speed_y = asX ? w : v;
				sim._q0 = del; sim._q1 = del;
				sim._pastx = 20; sim._pasty = 20;
				sim._last_portal_set = false;
				if (fx.sb !== undefined) sim.speed_boost = fx.sb;
				if (fx.jb !== undefined) sim.jump_boost = fx.jb;
				if (fx.zombie) sim.is_zombie = true;
				if (fx.lowg) sim.low_gravity = true;
				if (fx.flip !== undefined) sim.flip_gravity = fx.flip;
				if (fx.inv) sim.is_invulnerable = true;
				if (fx.slip !== undefined) sim._slippery = fx.slip;
				if (fx.lev) { sim.has_levitation = true; sim._current_thrust = fx.thr; }
				if (fx.maxJ !== undefined) { sim.max_jumps = fx.maxJ; sim.jump_count = fx.jc; }
				if (fx.dead) { sim.is_dead = true; sim._dead_offset = 3.0; }
				const st = K.fromSim(sim);
				E.applyMask(inp, m);
				sim.tick(inp);
				K.tick(st, m, lv.W);
				n++;
				const d = diffOf(st, sim);
				if (d) { bad++; if (!first) first = { cur, del, fx, v, w, asX, px, py, m, d }; if (bad >= maxBad) break; }
			}
			if (bad >= maxBad) break;
		}
		if (bad >= maxBad) break;
	}
	report.B.ticks = n; report.B.bad = bad; report.B.ms = Date.now() - t0;
	check(`${n.toLocaleString()} one-tick checks (${speeds.length.toLocaleString()} speeds, ${nCtx} contexts, 32 masks)`, bad === 0, first ? JSON.stringify(first) : `${Date.now() - t0} ms`);
}

// ================================================================ B2 one tick in contact: on a floor, at a wall, under a ceiling
function testB2() {
	section('B2 the recurrences in contact: every floor / wall / ceiling kind x 32 inputs x reachable speeds');
	const rng = mulberry(SEED * 6700417 + 5);
	const sets = speedSets(rng);
	const speeds = [];
	for (const [, a] of sets) for (const v of a) speeds.push(v);
	// the contact kinds: brick, ice, a plain one-way, rotated one-ways, half blocks of each rotation, a present, a time door
	const contacts = [[9], [1064], [61], [1001, 1], [1001, 3], [1116, 1], [1116, 3], [1116, 0], [1116, 2], [1101, 0], [156], [157], [50]];
	const curs = [0, 4, 119, 1, 3, 2, 120, 114];
	const levels = new Map();
	// the ball in a 3-tile gap: floor row 30 (y 480), a wall column 20 (x 320), a ceiling row 26 (y 416)
	const levelFor = (cur, c, where) => {
		const key = cur + '/' + c.join(',') + '/' + where;
		if (levels.has(key)) return levels.get(key);
		const W = 40, H = 40, fg = new Int32Array(W * H), args = new Map();
		for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; }
		for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
		for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) fg[y * W + x] = cur;
		const put = (x, y) => { fg[y * W + x] = c[0]; if (c.length > 1) args.set(y * W + x, c[1]); };
		if (where === 'floor') for (let x = 2; x < W - 2; x++) put(x, 30);
		if (where === 'wallR') for (let y = 2; y < H - 2; y++) put(21, y);
		if (where === 'wallL') for (let y = 2; y < H - 2; y++) put(18, y);
		if (where === 'ceil') for (let x = 2; x < W - 2; x++) put(x, 26);
		if (where === 'corner') { for (let x = 2; x < W - 2; x++) put(x, 30); for (let y = 2; y < H - 2; y++) put(21, y); }
		const L = mkLevel({ W, H, fg, args, spawns: [[19, 28]] });
		const o = { L, W: worldFor(L), sim: new E.EESim(L) };
		o.snap0 = o.sim.snapshot();
		levels.set(key, o);
		return o;
	};
	const wheres = ['floor', 'wallR', 'wallL', 'ceil', 'corner'];
	const inp = new E.EEInput();
	let n = 0, bad = 0, first = null, grounded = 0, collided = 0, jumps = 0;
	const t0 = Date.now();
	const small = [0, 0.2532, K.G * K.BASE_DRAG, 1, 3.5, 6.7, 13.5, -0.5, -3, -6.707946336429309];
	for (let si = SHARD; si < speeds.length; si += NSHARD) {
		const v = speeds[si];
		const cur = curs[Math.floor(rng() * curs.length)], c = contacts[Math.floor(rng() * contacts.length)];
		const where = wheres[Math.floor(rng() * wheres.length)];
		const lv = levelFor(cur, c, where);
		const fx = rng() < 0.7 ? {} : EFFECTS[Math.floor(rng() * EFFECTS.length)];
		// standing / touching exactly, or a fraction away (the landing / the hit comes this tick)
		const gap = rng() < 0.5 ? 0 : rng() * 3;
		let px = 19 * 16 + Math.floor(rng() * 8) + (rng() < 0.5 ? 0 : rng()), py = 28 * 16 - (where === 'ceil' ? -0 : 0) + (rng() < 0.5 ? 0 : rng());
		let vx = v, vy = small[Math.floor(rng() * small.length)];
		if (where === 'floor' || where === 'corner') { py = 30 * 16 - 16 - gap; vy = rng() < 0.5 ? vy : Math.abs(v); vx = rng() < 0.5 ? v : speeds[Math.floor(rng() * speeds.length)]; }
		if (where === 'wallR' || where === 'corner') px = 21 * 16 - 16 - gap;
		if (where === 'wallL') { px = 19 * 16 + gap; vx = -Math.abs(v); }
		if (where === 'ceil') { py = 27 * 16 + gap; vy = -Math.abs(v); }
		for (let m = 0; m < 32; m++) {
			const sim = lv.sim;
			sim.restore(lv.snap0);
			sim.px = px; sim.py = py; sim.speed_x = vx; sim.speed_y = vy;
			sim._q0 = cur; sim._q1 = cur; sim._pastx = 19; sim._pasty = 28; sim._last_portal_set = false;
			sim.jump_count = rng() < 0.5 ? 0 : 1;
			applyFx(sim, fx);
			const st = K.fromSim(sim);
			E.applyMask(inp, m);
			sim.tick(inp);
			K.tick(st, m, lv.W);
			n++;
			if (sim._grounded) grounded++;
			if (sim._loopCollided) collided++;
			if (sim.speed_y < -5 && vy > -5) jumps++;
			const d = diffOf(st, sim);
			if (d) { bad++; if (!first) first = { cur, c, where, fx, px, py, vx, vy, m, d }; if (bad >= 5) break; }
		}
		if (bad >= 5) break;
	}
	report.B2 = { ticks: n, bad, levels: levels.size, grounded, collided, jumps, ms: Date.now() - t0 };
	check(`${n.toLocaleString()} contact ticks (${levels.size} floor / wall / ceiling levels, 32 masks; ${collided.toLocaleString()} with a blocked step, ${grounded.toLocaleString()} grounded, ${jumps.toLocaleString()} jumps)`, bad === 0, first ? JSON.stringify(first) : `${Date.now() - t0} ms`);
}

// ================================================================ C free runs on random levels
function testC() {
	section(`C free runs: ${RUNS} random levels x starts, ${TICKS} ticks each, kin on its own state`);
	const rng = mulberry(SEED * 104729 + 7 + SHARD * 31337);
	let ticks = 0, bad = 0, first = null, deaths = 0, portals = 0, levelsN = 0;
	const t0 = Date.now();
	const inp = new E.EEInput();
	const perLevel = 4;
	for (let r = 0; r < RUNS; r++) {
		const L = randomLevel(rng);
		levelsN++;
		const W = worldFor(L);
		for (let s = 0; s < perLevel; s++) {
			const sim = new E.EESim(L, { startSpawn: Math.floor(rng() * 8) });
			sim.onEvent = (ev) => { if (ev === 'death') deaths++; else if (ev === 'portal') portals++; };
			// a random prefix on the engine alone: kin starts from any mid-run state
			const pre = stickyMasks(rng, Math.floor(rng() * 120), 0.85);
			for (const m of pre) { E.applyMask(inp, m); sim.tick(inp); }
			if (GOD) sim.in_god_mode = true;   // god mode (the G key; never in a replay): its paths in kin too
			const st = K.fromSim(sim);
			const masks = stickyMasks(rng, TICKS, [0.5, 0.85, 0.95][s % 3]);
			const d = runPair(sim, st, W, masks, inp);
			ticks += d ? d.t + 1 : TICKS;
			if (d) { bad++; if (!first) first = { r, s, seed: SEED, d, pre: pre.length }; if (bad >= 5) break; }
		}
		if (bad >= 5) break;
	}
	report.C = { levels: levelsN, ticks, bad, deaths, portals, ms: Date.now() - t0 };
	check(`${ticks.toLocaleString()} ticks on ${levelsN} random levels (${deaths} deaths, ${portals} teleports)`, bad === 0, first ? JSON.stringify(first) : `${Date.now() - t0} ms`);
}

// ================================================================ D exhaustive input trees
function testD() {
	section(`D exhaustive input trees: every sequence of the 18 inputs to depth ${TREE}`);
	const rng = mulberry(SEED * 15485863 + 3 + SHARD * 7);
	let nodes = 0, bad = 0, first = null;
	const t0 = Date.now();
	const inp = new E.EEInput();
	const nStarts = +arg('starts', QUICK ? 4 : 24);
	for (let s = 0; s < nStarts; s++) {
		const L = randomLevel(rng, { W: 24, H: 18, rects: 14 });
		const W = worldFor(L);
		const sim = new E.EESim(L, { startSpawn: Math.floor(rng() * 4) });
		for (const m of stickyMasks(rng, Math.floor(rng() * 80), 0.85)) { E.applyMask(inp, m); sim.tick(inp); }
		const root = sim.snapshot();
		// DFS: the engine by snapshots, kin by copies of its state
		const stack = [[root, K.fromSim(sim), 0]];
		while (stack.length) {
			const [snap, st0, d] = stack.pop();
			if (d >= TREE) continue;
			for (const m of INPUTS18) {
				sim.restore(snap);
				const st = Object.assign({}, st0, { mor: {} });
				E.applyMask(inp, m); sim.tick(inp);
				K.tick(st, m, W);
				nodes++;
				const df = diffOf(st, sim);
				if (df) { bad++; if (!first) first = { s, d, m, df }; continue; }
				if (d + 1 < TREE) stack.push([sim.snapshot(), st, d + 1]);
			}
			if (bad >= 5) break;
		}
		if (bad >= 5) break;
	}
	report.D = { nodes, bad, ms: Date.now() - t0 };
	check(`${nodes.toLocaleString()} tree nodes from ${nStarts} starts`, bad === 0, first ? JSON.stringify(first) : `${Date.now() - t0} ms`);
}

module.exports = { mkLevel, randomLevel, worldFor, diffOf, MAP, KEYS, stickyMasks, mulberry, INPUTS18, runPair };

if (require.main === module) {
	if (ONLY.includes('A')) testA();
	if (ONLY.includes('B')) testB();
	if (ONLY.includes('B2')) testB2();
	if (ONLY.includes('C')) testC();
	if (ONLY.includes('D')) testD();
	if (ONLY.includes('E')) require('./kin_routes.js').testE({ check, section, report, arg, QUICK, SHARD, NSHARD });
	if (ONLY.includes('F')) require('./kin_lemmas.js').testF({ check, section, report, arg, QUICK, SEED });
	console.log(`\n${pass} passed, ${fail} failed`);
	if (JSONOUT) fs.writeFileSync(JSONOUT, JSON.stringify({ pass, fail, report }, null, 1));
	process.exit(fail ? 1 : 0);
}
