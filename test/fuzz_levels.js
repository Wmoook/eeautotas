'use strict';
// Crash / consistency sweep over real levels: every *.eelvl in a folder (default ~/Downloads or $EEAT_LEVELS; the level
// part is skipped if the folder is absent), plus a generated all-mechanics arena and a few crafted edge-case levels.
// Per level and start mode (reset, load):
//  1. load: eelvl.js readEelvl -> toSimLevel -> eesim.prepareLevel, loadEelvlLevel and the JSON round trip that jobs
//     write and every tool loads (all three must simulate identically);
//  2. playthroughs of sticky random inputs (default 3 x 30000 ticks), steered to new places: from a snapshot, 3 random
//     segments are tried and the most novel one (new cells, new block ids) is replayed and kept, so generation itself
//     restores ~3 times per segment. The last run also warps the ball next to the level's special blocks every few
//     hundred ticks (preferring ids not touched yet) to reach every mechanic;
//  3. a straight replay (fresh sim, events on, no restores) must equal generation tick for tick (every state field);
//  4. snapshots at random ticks, just before events / pending queues and in every situation met (on ice, in a liquid,
//     thrusting, dead, inside a one-way or door, team change pending, ...), restored in random order into the same sim,
//     a fresh sim and a sim busy elsewhere, then continued: every field, stateHash, stateKey and the events must equal
//     the straight replay; afterwards tiles / lookup must match the collected-coin bitset;
//  5. stateKey / stateHash: one hash per key, no hash shared by two keys; states equal up to a clock shift get equal
//     keys; states with equal keys (bucketed by which fields differ and in which context, rarest kinds first; plus
//     other runs / start modes) have identical futures (observable state + events) under the same new inputs; and per
//     field: a real state with ONE field copied from another real state either changes the key or behaves identically;
//  6. random portals (levels with multi-exit portals): every draw takes the exit the rng script names (rngNeed set
//     past its end), per portal and choice; rng.js's outcome tree agrees with the exits the sim takes;
//  7. the app's import (src/jobs.js importJob, run from a byte-identical copy of src/ in a temp folder so no job ever
//     appears in the running app) with a trivial .eetas and a random-walk .eetas in both start modes: it must fail
//     (or succeed) with a clean Error and leave no files behind; plus bad-input cases, and the app helpers (replay,
//     viewer trajectory / levelView / align, where, replayInfo, render) on a random walk.
// usage: node test/fuzz_levels.js [folder | file.eelvl ...] [--ticks=30000] [--runs=3] [--warp-runs=1] [--seed=1]
//        [--only=<name part>[|<name part>...]] [--modes=reset,load] [--quick] [--no-import] [--no-app] [--no-synth]
//        [--import-inplace] (use src/jobs.js itself; it cleans up) [--repro=<dir>] [--verbose]
//        [--engine=<copy of eesim.js>] (fuzz that engine instead, e.g. a mutant; use with --no-import --no-app)
// Exit code 1 if any check fails. The inputs of a failing run go to --repro (default src/out/fuzz_levels/).
// Node built-ins only.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const a = argv.filter((x) => x.startsWith(`--${k}=`)); return a.length ? a[a.length - 1].slice(k.length + 3) : d; };
// --engine=<eesim.js>: fuzz another copy of the engine (e.g. a deliberately broken one, to see that the checks catch it)
const ENGINE = opt('engine', null);
const E = require(ENGINE ? path.resolve(ENGINE) : '../src/eesim.js');
const V = require('../src/eelvl.js');
const RNG = require('../src/rng.js');
const B = require('../src/blocks.js');

// ---------------------------------------------------------------- options
const QUICK = has('quick');
const TICKS = Math.max(200, +opt('ticks', QUICK ? 8000 : 30000));
const RUNS = Math.max(1, +opt('runs', QUICK ? 2 : 3));
const WARP_RUNS = Math.max(0, Math.min(RUNS, +opt('warp-runs', 1)));
const SEED = (+opt('seed', 1)) >>> 0;
const MODES = opt('modes', 'reset,load').split(',').filter(Boolean);
const ONLY = opt('only', '').toLowerCase();
const VERBOSE = has('verbose');
const DO_IMPORT = !has('no-import'), DO_APP = !has('no-app'), DO_SYNTH = !has('no-synth');
const INPLACE = has('import-inplace');
const REPRO = path.resolve(opt('repro', path.join(ROOT, 'src', 'out', 'fuzz_levels')));
const DEFAULT_DIR = process.env.EEAT_LEVELS || require('path').join(require('os').homedir(), 'Downloads');
const SNAP_RANDOM = QUICK ? 6 : 12;          // random snapshot ticks per run
const SNAP_EVENTS = QUICK ? 24 : 60;         // snapshots just before events / with pending queues, per run
const HORIZON = QUICK ? 600 : 1500;          // continuation after a random snapshot (the first one runs to the end)
const EV_HORIZON = 300;                      // continuation after an event snapshot
const PAIRS = QUICK ? [24, 5, 3] : [48, 12, 6];   // equal-key pairs per level: states differ beyond a clock shift (by kind of difference) / other run / same run
const FUTURE = QUICK ? 600 : 1500;           // ticks of common future per pair
for (const m of MODES) if (!E.START_MODES.includes(m)) { console.error(`unknown start mode ${m} (reset, load)`); process.exit(2); }

// ---------------------------------------------------------------- reporting
let nPass = 0, nFail = 0;
const failures = [];
let cur = null;
function ok(cond, what, detail, ctx) {
	if (cond) { nPass++; if (VERBOSE) console.log(`    ok   ${what}`); return true; }
	nFail++;
	const f = { level: cur ? cur.name : '', what, detail: detail || '', ctx: ctx || null };
	failures.push(f);
	if (cur) cur.fails++;
	console.log(`    FAIL ${what}${detail ? ': ' + detail : ''}`);
	if (ctx && ctx.masks) writeRepro(f);
	return false;
}
const slug = (s) => String(s).toLowerCase().replace(/\.eelvl$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'level';
let reproN = 0;
function writeRepro(f) {
	try {
		fs.mkdirSync(REPRO, { recursive: true });
		const base = path.join(REPRO, `${slug(f.level)}_${f.ctx.mode}_r${f.ctx.run}_${++reproN}`);
		const m = f.ctx.masks, n = Math.min(m.length, f.ctx.upto || m.length);
		const b = Buffer.alloc(n);
		for (let i = 0; i < n; i++) b[i] = 48 + (m[i] & 31);
		fs.writeFileSync(base + '.eetas', b);
		fs.writeFileSync(base + '.json', JSON.stringify({ level: f.ctx.file || f.level, mode: f.ctx.mode, run: f.ctx.run, what: f.what,
			detail: f.detail, script: f.ctx.script, warps: f.ctx.warps ? [...f.ctx.warps] : [], at: f.ctx.at, seed: SEED }, null, 1));
		f.repro = base + '.eetas';
		console.log(`         repro: ${f.repro} (+ .json: level, start mode, rng script, warps [tick, [x, y]])`);
	} catch (e) { console.log(`         (could not write the repro: ${e.message})`); }
}
const firstLines = (e, n) => String((e && e.stack) || e).split('\n').slice(0, n || 3).map((s) => s.trim()).join(' | ');

// ---------------------------------------------------------------- randomness (seeded, reproducible)
function mulberry32(a) {
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function strSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h ^ Math.imul(SEED + 1, 0x9E3779B1)) >>> 0; }
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

/** Sticky random inputs: a direction / vertical / jump pattern held for 1..180 ticks (masks: 1 J, 2 L, 4 R, 8 U, 16 D). */
class Sticky {
	constructor(rnd) { this.rnd = rnd; this.left = 0; this.h = 0; this.v = 0; this.jm = 0; this.jp = 1; this.k = 0; }
	next() {
		const r = this.rnd;
		if (this.left <= 0) {
			const u = r();
			this.left = u < 0.3 ? 1 + Math.floor(r() * 6) : u < 0.8 ? 5 + Math.floor(r() * 40) : 30 + Math.floor(r() * 150);
			const hr = r(); this.h = hr < 0.4 ? 1 : hr < 0.75 ? -1 : hr < 0.97 ? 0 : 2;      // right, left, none, both (cancel)
			const vr = r(); this.v = vr < 0.72 ? 0 : vr < 0.86 ? -1 : vr < 0.98 ? 1 : 2;     // up / down: dots, climbables, liquids
			const jr = r(); this.jm = jr < 0.35 ? 0 : jr < 0.55 ? 1 : jr < 0.8 ? 2 : 3;     // none, every tick, once, every jp ticks
			this.jp = 2 + Math.floor(r() * 25); this.k = 0;
		}
		this.left--;
		let m = 0;
		if (this.h === 1) m |= 4; else if (this.h === -1) m |= 2; else if (this.h === 2) m |= 6;
		if (this.v === -1) m |= 8; else if (this.v === 1) m |= 16; else if (this.v === 2) m |= 24;
		if (this.jm === 1 || (this.jm === 2 && this.k === 0) || (this.jm === 3 && this.k % this.jp === 0)) m |= 1;
		this.k++;
		return m;
	}
	segment(n) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = this.next(); return a; }
}

// ---------------------------------------------------------------- state fingerprints
// Every field snapshot()/restore() carry (E.SNAP_SCALARS + gravity_dir, checkpoint, key timers, coin / secret bitsets,
// the four switch maps with every entry, the three queues), hashed to 53 bits: "full" (everything) and "rel" (the
// state up to a shift of the clock: absolute clocks dropped, timer stamps taken relative to PlayState.ticks, plus the
// only absolute phases stateKey keys: ticks % 1000 with time doors, ticks % ticksPerFrame). Equal rel => the two
// states behave identically, so their stateKeys must be equal.
const SCAL = E.SNAP_SCALARS;
const NS = SCAL.length, NSF = NS + 10;
const CLOCKS = new Set(['_ticks', '_tick0', 'run_ticks', 'frame_queue_ticks', 'prev_px', 'prev_py', 'teleported', '_last_jump',
	'_curse_time_start', '_zombie_time_start', '_poison_time_start', '_fire_time_start']);
const STAMPS = new Set(['_curse_time_start', '_zombie_time_start', '_poison_time_start', '_fire_time_start']);
const REL_MODE = new Uint8Array(NSF);   // 0 as is, 1 dropped (clock), 2 relative to _ticks (a stamp)
SCAL.forEach((f, i) => { REL_MODE[i] = STAMPS.has(f) ? 2 : CLOCKS.has(f) ? 1 : 0; });
for (let i = NS + 4; i < NS + 10; i++) REL_MODE[i] = 2;   // key timers (PlayState.ticks stamps)
const I_TICKS = SCAL.indexOf('_ticks');
const SF = new Float64Array(NSF);
// eslint-disable-next-line no-new-func
const fillScalars = new Function('s', 'F', SCAL.map((f, i) => (f === '_rngState'
	? `F[${i}] = typeof s._rngState === 'bigint' ? Number(s._rngState & 0xFFFFFFFFFFFFn) + Number(s._rngState >> 48n) * 1e-6 : +s._rngState;`
	: `F[${i}] = +s.${f};`)).join('\n') + `
	F[${NS}] = s.gravity_dir.x; F[${NS + 1}] = s.gravity_dir.y; F[${NS + 2}] = s.checkpoint.x; F[${NS + 3}] = s.checkpoint.y;
	const kt = s._kt; F[${NS + 4}] = kt[0]; F[${NS + 5}] = kt[1]; F[${NS + 6}] = kt[2]; F[${NS + 7}] = kt[3]; F[${NS + 8}] = kt[4]; F[${NS + 9}] = kt[5];`);
const HB = new Float64Array(1), HW = new Int32Array(HB.buffer);
const FP_OUT = new Float64Array(2);
const VW = [];
function varWords(sim) {
	VW.length = 0;
	VW.push(0x111, sim._coinBits.length); for (let i = 0; i < sim._coinBits.length; i++) VW.push(sim._coinBits[i]);
	VW.push(0x222, sim._secretBits.length); for (let i = 0; i < sim._secretBits.length; i++) VW.push(sim._secretBits[i]);
	const maps = [sim._switches, sim._oswitches, sim._evSwitches, sim._evOSwitches];
	for (let j = 0; j < 4; j++) {
		const m = maps[j];
		let s1 = 0, s2 = 0;
		if (m.size) {
			// every entry (false ones too), order-independent: a sum and an xor of per-entry hashes
			m.forEach((v, k) => {
				let h = Math.imul((k | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ (v === true ? 0x1234567 : v === false ? 0x7654321 : 0x5555555);
				h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
				s1 = (s1 + h) | 0; s2 ^= Math.imul(h, 0x27d4eb2d);
			});
		}
		VW.push(0x333 + j, m.size, s1, s2);
	}
	const qs = [sim._stateQueue, sim._keysQueue, sim._tileQueue];
	for (let j = 0; j < 3; j++) { const q = qs[j]; VW.push(0x777 + j, q.length); for (let i = 0; i < q.length; i++) VW.push(q[i] | 0); }
	return VW;
}
/** FP_OUT[0] = hash of every field, FP_OUT[1] = the state up to a clock shift (see above). */
function fps(sim) {
	fillScalars(sim, SF);
	let a1 = 0x9747b28c | 0, a2 = 0x85ebca6b | 0, b1 = 0x2c1b3c6d | 0, b2 = 0x297a2d39 | 0;
	const now = SF[I_TICKS];
	for (let i = 0; i < NSF; i++) {
		HB[0] = SF[i];
		let w0 = HW[0], w1 = HW[1];
		a1 = Math.imul(a1 ^ w0, 0x5bd1e995); a1 ^= a1 >>> 15; a1 = Math.imul(a1 ^ w1, 0x5bd1e995); a1 ^= a1 >>> 15;
		a2 = (Math.imul(a2 ^ w0, 0x01000193) + 0x6b43a9b5) | 0; a2 = (Math.imul(a2 ^ w1, 0x01000193) + 0x6b43a9b5) | 0;
		const rm = REL_MODE[i];
		if (rm !== 1) {
			if (rm === 2) { HB[0] = SF[i] - now; w0 = HW[0]; w1 = HW[1]; }
			b1 = Math.imul(b1 ^ w0, 0x5bd1e995); b1 ^= b1 >>> 15; b1 = Math.imul(b1 ^ w1, 0x5bd1e995); b1 ^= b1 >>> 15;
			b2 = (Math.imul(b2 ^ w0, 0x01000193) + 0x6b43a9b5) | 0; b2 = (Math.imul(b2 ^ w1, 0x01000193) + 0x6b43a9b5) | 0;
		}
	}
	// the absolute phases the level can observe
	const ph0 = sim.level.hasTimeDoors ? now % 1000 : -1, ph1 = sim.ticksPerFrame > 1 ? now % sim.ticksPerFrame : -1;
	b1 = Math.imul(b1 ^ ph0, 0x5bd1e995); b1 ^= b1 >>> 15; b2 = (Math.imul(b2 ^ ph1, 0x01000193) + 0x6b43a9b5) | 0;
	const vw = varWords(sim);
	for (let i = 0; i < vw.length; i++) {
		const w = vw[i];
		a1 = Math.imul(a1 ^ w, 0x5bd1e995); a1 ^= a1 >>> 15; a2 = (Math.imul(a2 ^ w, 0x01000193) + 0x6b43a9b5) | 0;
		b1 = Math.imul(b1 ^ w, 0x5bd1e995); b1 ^= b1 >>> 15; b2 = (Math.imul(b2 ^ w, 0x01000193) + 0x6b43a9b5) | 0;
	}
	a1 ^= a1 >>> 16; a1 = Math.imul(a1, 0x85ebca6b); a1 ^= a1 >>> 13;
	b1 ^= b1 >>> 16; b1 = Math.imul(b1, 0x85ebca6b); b1 ^= b1 >>> 13;
	FP_OUT[0] = (a1 >>> 0) * 2097152 + ((a2 >>> 0) & 0x1fffff);
	FP_OUT[1] = (b1 >>> 0) * 2097152 + ((b2 >>> 0) & 0x1fffff);
}
/** Every field as text, for diagnostics. */
function dump(sim) {
	const o = {};
	for (const f of SCAL) { const v = sim[f]; o[f] = typeof v === 'bigint' ? v.toString() : Object.is(v, -0) ? '-0' : v; }
	o.gravity_dir = `${sim.gravity_dir.x},${sim.gravity_dir.y}`; o.checkpoint = `${sim.checkpoint.x},${sim.checkpoint.y}`; o._kt = [...sim._kt].join(',');
	o._coinBits = [...sim._coinBits].join(','); o._secretBits = [...sim._secretBits].join(',');
	const mp = (m) => [...m.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}:${v}`).join(',');
	o._switches = mp(sim._switches); o._oswitches = mp(sim._oswitches); o._evSwitches = mp(sim._evSwitches); o._evOSwitches = mp(sim._evOSwitches);
	o._stateQueue = sim._stateQueue.join(','); o._keysQueue = sim._keysQueue.join(','); o._tileQueue = sim._tileQueue.join(',');
	return o;
}
function diffDump(a, b, skip) {
	const out = [];
	for (const k of Object.keys(a)) if (!(skip && skip.has(k)) && String(a[k]) !== String(b[k])) out.push(`${k} ${a[k]} vs ${b[k]}`);
	return out;
}
function strHash(s) {
	let a = 0x811c9dc5 | 0, b = 0x1b873593 | 0;
	for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 13; }
	return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff) + 1;
}
/** An event as text; `complete` carries run_ticks, an absolute clock, so the pair-future test drops it. */
function evStr(k, d, noClock) {
	if (noClock && k === 'complete') return k + JSON.stringify(d.tile);
	return k + (d === undefined ? '' : JSON.stringify(d));
}

// ---------------------------------------------------------------- level helpers
function withScript(L, script) { return Object.assign({}, L, { rngScript: script === null ? null : Int32Array.from(script) }); }
function applyWarp(sim, w) { sim.px = w[0] * 16; sim.py = w[1] * 16; sim.speed_x = 0; sim.speed_y = 0; }
const cellOf = (sim) => ((Math.floor(sim.py + 8) >> 5) << 16) | (Math.floor(sim.px + 8) >> 5);
/** Block ids the ball's box (grown by 1 px, so walls and closed doors it pushes against count) overlaps. */
function touch(sim, set) {
	const W = sim.width, H = sim.height, x = sim.px, y = sim.py;
	const x0 = Math.max(0, Math.floor(x - 1) >> 4), x1 = Math.min(W - 1, Math.floor(x + 16) >> 4);
	const y0 = Math.max(0, Math.floor(y - 1) >> 4), y1 = Math.min(H - 1, Math.floor(y + 16) >> 4);
	for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) set.add(sim.tiles[ty * W + tx]);
	set.add(sim.current_tile);
}
const EXTRA_SPECIAL = new Set([1573, 1516, 466, 374, 77, 83, 1520, 1064, 4, 414, 411, 412, 413, 1519, 460, 110, 111, 1582, 1618]);
/** id -> tile indices of every block worth warping to (not plain solids / decoration). */
function specialsOf(L) {
	const m = new Map();
	for (let i = 0; i < L.fg.length; i++) {
		const id = L.fg[i];
		if (!id) continue;
		const k = B.kindOf(id).kind;
		if (!EXTRA_SPECIAL.has(id) && (k === 'solid' || k === 'deco' || k === 'empty' || k === 'spawn')) continue;
		let a = m.get(id);
		if (!a) m.set(id, a = []);
		if (a.length < 4000) a.push(i);
	}
	return m;
}
/** A warp target next to a special block (ids not touched yet preferred); into a closed door or a one-way now and then. */
function pickWarp(sim, specials, seen, rnd) {
	if (!specials.size) return null;
	const ids = [...specials.keys()];
	const unseen = ids.filter((id) => !seen.has(id));
	const pool = unseen.length && rnd() < 0.7 ? unseen : ids;
	const id = pool[Math.floor(rnd() * pool.length)], tiles = specials.get(id), i = tiles[Math.floor(rnd() * tiles.length)];
	const W = sim.width, x = i % W, y = Math.floor(i / W);
	const k = B.kindOf(id).kind, door = k === 'door' || k === 'oneway';   // (inside a closed door or a one-way: both happen in play)
	for (const [cx, cy] of [[x, y], [x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1], [x, y - 2]]) {
		if (cx < 0 || cy < 0 || cx >= W || cy >= sim.height) continue;
		if (door && cx === x && cy === y && rnd() < 0.3) return [cx, cy];
		if (!sim.is_tile_solid_now(cx, cy)) return [cx, cy];
	}
	return null;
}
/** The state after t ticks of a run (the warp at tick t not applied yet). */
function simAt(L, run, t) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	for (let k = 0; k < t; k++) { if (run.warps.has(k)) applyWarp(sim, run.warps.get(k)); E.applyMask(inp, run.masks[k]); sim.tick(inp); }
	return sim;
}
/** tiles / lookup consistent with the collected-coin bitset (the only runtime tile writes are coins). */
function tilesCheck(sim) {
	const L = sim.level, W = L.width;
	for (let i = 0; i < L.fg.length; i++) {
		const b = L.coinBit[i];
		if (b >= 0) {
			const on = (sim._coinBits[b >> 5] >>> (b & 31)) & 1, want = L.coinBaseId[b] + (on ? 10 : 0);
			if (sim.tiles[i] !== want) return `coin tile (${i % W}, ${Math.floor(i / W)}) is ${sim.tiles[i]}, the bitset says ${want}`;
		} else {
			if (sim.tiles[i] !== L.fg[i]) return `tile (${i % W}, ${Math.floor(i / W)}) is ${sim.tiles[i]}, the level has ${L.fg[i]}`;
			if (sim._lookup[i] !== L.lookup0[i]) return `lookup (${i % W}, ${Math.floor(i / W)}) is ${sim._lookup[i]}, the level has ${L.lookup0[i]}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------- 2. generation (restore-heavy, novelty-steered)
function generate(L, N, rnd, warpRun, specials, stopAt) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	const masks = new Uint8Array(N), warps = new Map();
	const fp = new Float64Array(N + 1), hash = new Float64Array(N + 1);
	fps(sim); fp[0] = FP_OUT[0]; hash[0] = sim.stateHash();
	const visited = new Set([cellOf(sim)]), seenIds = new Set([sim.current_tile]);
	const gen = new Sticky(rnd);
	const segIds = new Set(), segCells = new Set();
	let t = 0, nextWarp = warpRun ? 30 + Math.floor(rnd() * 100) : Infinity, mismatch = null, stopDump = null;
	while (t < N) {
		if (t >= nextWarp) {
			const w = pickWarp(sim, specials, seenIds, rnd);
			if (w) { warps.set(t, w); applyWarp(sim, w); }
			nextWarp = t + 150 + Math.floor(rnd() * 450);
		}
		const snap = sim.snapshot();
		let best = null;
		for (let k = 0; k < 3; k++) {
			if (k) sim.restore(snap);
			const len = Math.min(N - t, 30 + Math.floor(rnd() * 250));
			const seg = gen.segment(len), hs = new Float64Array(len);
			segIds.clear(); segCells.clear();
			let score = rnd(), died = false;
			for (let i = 0; i < len; i++) {
				E.applyMask(inp, seg[i]); sim.tick(inp);
				hs[i] = sim.stateHash();
				const c = cellOf(sim);
				if (!visited.has(c) && !segCells.has(c)) { segCells.add(c); score += 1; }
				const id = sim.current_tile;
				if (!seenIds.has(id) && !segIds.has(id)) { segIds.add(id); score += 8; }
				if (sim.is_dead) died = true;
			}
			if (died) score -= 2;
			if (best === null || score > best.score) best = { seg, hs, score };
		}
		sim.restore(snap);
		for (let i = 0; i < best.seg.length; i++, t++) {
			masks[t] = best.seg[i];
			E.applyMask(inp, masks[t]); sim.tick(inp);
			const h = sim.stateHash();
			if (h !== best.hs[i] && !mismatch) mismatch = { t: t + 1, segStart: t - i };
			fps(sim); fp[t + 1] = FP_OUT[0]; hash[t + 1] = h;
			if (stopAt === t + 1) stopDump = dump(sim);
			visited.add(cellOf(sim)); seenIds.add(sim.current_tile);
		}
	}
	return { masks, warps, fp, hash, mismatch, stopDump, seenIds };
}

// ---------------------------------------------------------------- 3. straight replay (fresh sim, events)
const INTERESTING = new Set(['death', 'respawn', 'portal', 'key', 'key_expired', 'switch', 'effect', 'team', 'checkpoint', 'crown',
	'complete', 'secret', 'coin', 'blue_coin', 'door_state', 'blink']);
const KIND_CACHE = new Map();
const kindId = (id) => { let k = KIND_CACHE.get(id); if (k === undefined) KIND_CACHE.set(id, k = B.kindOf(id).kind); return k; };
function cornerKinds(sim, want) {
	const W = sim.width, H = sim.height;
	for (const [dx, dy] of [[0, 0], [15, 0], [0, 15], [15, 15]]) {
		const x = Math.floor(sim.px + dx) >> 4, y = Math.floor(sim.py + dy) >> 4;
		if (x >= 0 && y >= 0 && x < W && y < H && kindId(sim.tiles[y * W + x]) === want) return true;
	}
	return false;
}
/** Situations in which some state field matters only there (the per-field key test takes real states from each). */
const CONTEXTS = [
	['oneway', (s) => s._boxTouchesOneWay()], ['oneway-still', (s) => s.speed_x === 0 && s.speed_y === 0 && s._boxTouchesOneWay()],
	['dead', (s) => s.is_dead], ['thrust', (s) => s.has_levitation && s._current_thrust !== 0],
	['teampending', (s) => s._team_tx !== -1], ['queue', (s) => s._stateQueue.length !== 0 || s._keysQueue.length !== 0 || s._tileQueue.length !== 0],
	['timed', (s) => s.is_cursed || s.is_zombie || s.is_poisoned || s.is_on_fire], ['keys', (s) => s._keysMask !== 0], ['ice', (s) => s._slippery > 0],
	['liquid', (s) => kindId(s.current_tile) === 'liquid'], ['climbable', (s) => kindId(s.current_tile) === 'climbable'],
	['dot', (s) => kindId(s.current_tile) === 'dot'], ['boost', (s) => kindId(s.current_tile) === 'boost'], ['portal', (s) => kindId(s.current_tile) === 'portal'],
	['half', (s) => cornerKinds(s, 'half')], ['door', (s) => cornerKinds(s, 'door')], ['switches', (s) => s._switches.size !== 0 || s._oswitches.size !== 0],
	['flipgrav', (s) => s.flip_gravity !== 0], ['multijump', (s) => s.max_jumps !== 1], ['crown', (s) => s.has_crown],
];
function straight(L, run, rnd) {
	const { masks, warps } = run, N = masks.length, W = L.width;
	const sim = new E.EESim(L), inp = new E.EEInput();
	const R = { N, fp: new Float64Array(N + 1), rel: new Float64Array(N + 1), hash: new Float64Array(N + 1), ev: new Float64Array(N + 1),
		keys: new Array(N + 1), snaps: new Map(), evSnap: new Set(), draws: [], drawBad: null, touched: new Set(), evCount: new Map(), sim,
		hashStable: null, ctxSnaps: new Map() };
	const ctxCount = new Map();
	const parts = [];
	let lastPortal = null, hitKind = null;
	sim.onEvent = (k, d) => {
		parts.push(evStr(k, d));
		if (k === 'portal') lastPortal = d;
		if (INTERESTING.has(k)) {
			const kk = k === 'effect' ? `effect ${d.effect} ${d.on ? 'on' : 'off'}` : k;
			R.evCount.set(kk, (R.evCount.get(kk) || 0) + 1);
			if (hitKind === null || k !== 'door_state') hitKind = kk;
		}
	};
	const rec = (t) => {
		fps(sim); R.fp[t] = FP_OUT[0]; R.rel[t] = FP_OUT[1];
		R.hash[t] = sim.stateHash(); R.keys[t] = sim.stateKey();
		R.ev[t] = parts.length ? strHash(parts.join('\u0001')) : 0; parts.length = 0;
		touch(sim, R.touched);
	};
	rec(0);
	const randAt = new Set();
	for (let k = 0; k < 4 * SNAP_RANDOM && randAt.size < Math.min(SNAP_RANDOM, N); k++) { const t = Math.floor(rnd() * N); if (!warps.has(t)) randAt.add(t); }
	const perKind = new Map(), capKind = Math.max(3, Math.ceil(SNAP_EVENTS / 6));
	let spare = new E.EESnapshot();
	const script = L.rngScript;
	for (let t = 0; t < N; t++) {
		if (warps.has(t)) applyWarp(sim, warps.get(t));
		const pre = sim.snapshot(spare);   // (reuse) the state before tick t + 1
		const queued = sim._stateQueue.length !== 0 || sim._keysQueue.length !== 0 || sim._tileQueue.length !== 0 || sim._team_tx !== -1;
		// per context: the first state in it and one random later one (reservoir)
		let promoted = false;
		for (const [name, pred] of CONTEXTS) {
			if (!pred(sim)) continue;
			const c = (ctxCount.get(name) || 0) + 1;
			ctxCount.set(name, c);
			if (c === 1) { R.ctxSnaps.set(name, [{ t, snap: pre }]); promoted = true; } else if (rnd() * (c - 1) < 1) { R.ctxSnaps.get(name)[1] = { t, snap: pre }; promoted = true; }
		}
		if (promoted) spare = new E.EESnapshot();
		if (randAt.has(t)) R.snaps.set(t, sim.snapshot());
		hitKind = null; lastPortal = null;
		const steps0 = sim._rngSteps;
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (sim._rngSteps !== steps0 && !R.drawBad) {
			// 6. random portals: the k-th draw takes script[k] (0 when out of range; rngNeed = exits past the script's end)
			const k = steps0, d = lastPortal;
			if (!d) R.drawBad = `tick ${t + 1}: a random draw without a portal event`;
			else {
				const slot = L.portalSlot[d.from.y * W + d.from.x];
				const tg = slot >= 0 ? L.portalsById.get(L.pTarget[slot]) : null;
				if (!tg || tg.n < 2) R.drawBad = `tick ${t + 1}: a draw at portal (${d.from.x}, ${d.from.y}) whose target has ${tg ? tg.n : 0} exits`;
				else if (script !== null) {
					const c0 = k < script.length ? script[k] : -1, c = c0 < 0 || c0 >= tg.n ? 0 : c0;
					const ex = { x: tg.xs[c] >> 4, y: tg.ys[c] >> 4 };
					if (sim._rngSteps !== steps0 + 1) R.drawBad = `tick ${t + 1}: ${sim._rngSteps - steps0} draws in one tick`;
					else if (d.to.x !== ex.x || d.to.y !== ex.y) R.drawBad = `tick ${t + 1}: draw ${k} (script ${c0}) exits at (${d.to.x}, ${d.to.y}), expected exit ${c} (${ex.x}, ${ex.y})`;
					else if (k >= script.length && sim.rngNeed !== tg.n) R.drawBad = `tick ${t + 1}: draw ${k} past the script's end (${script.length}) left rngNeed ${sim.rngNeed}, expected ${tg.n}`;
				} else {
					let found = false;
					for (let c = 0; c < tg.n; c++) if ((tg.xs[c] >> 4) === d.to.x && (tg.ys[c] >> 4) === d.to.y) found = true;
					if (!found) R.drawBad = `tick ${t + 1}: PCG draw exits at (${d.to.x}, ${d.to.y}), not one of the ${tg.n} exits`;
				}
				R.draws.push({ t: t + 1, k, from: d.from, to: d.to, n: tg ? tg.n : 0 });
			}
		}
		rec(t + 1);
		if ((t & 1023) === 7 && R.hashStable === null) {
			// stateHash is a pure function of the state: the coin-blind variant writes the key buffer in place
			const h = R.hash[t + 1];
			sim.stateHash(undefined, true);
			if (sim.stateHash() !== h || sim.stateKey() !== R.keys[t + 1]) R.hashStable = `tick ${t + 1}: stateHash/stateKey changed after stateHash(undefined, true)`;
		}
		if ((hitKind !== null || queued) && R.evSnap.size < SNAP_EVENTS && !R.snaps.has(t)) {
			const kind = hitKind || 'queue';
			const n = perKind.get(kind) || 0;
			if (n < capKind) { perKind.set(kind, n + 1); R.snaps.set(t, pre); R.evSnap.add(t); spare = new E.EESnapshot(); }
		}
	}
	// the restore test also starts from one state of every situation met (on ice, in a liquid, thrusting, dead, ...)
	for (const arr of R.ctxSnaps.values()) for (const x of arr) if (x && !R.snaps.has(x.t)) { R.snaps.set(x.t, x.snap); R.evSnap.add(x.t); }
	return R;
}

// ---------------------------------------------------------------- 4. snapshot / restore
function restoreChecks(L, run, R, rnd, ctx) {
	const { masks, warps } = run, N = R.N;
	const order = shuffle([...R.snaps.keys()], rnd);
	const busy = new E.EESim(L), bi = new E.EEInput(), bg = new Sticky(rnd);
	for (let k = 0; k < 400; k++) { E.applyMask(bi, bg.next()); busy.tick(bi); }
	const targets = [['the same sim', R.sim], ['a fresh sim', null], ['a sim busy elsewhere', busy]];
	const parts = [], inp = new E.EEInput();
	let first = null, ticks = 0;
	for (let i = 0; i < order.length && !first; i++) {
		const t0 = order[i];
		const [tname, tsim] = targets[i % 3];
		const sim = tsim || new E.EESim(L);
		sim.onEvent = (k, d) => parts.push(evStr(k, d));
		sim.restore(R.snaps.get(t0));
		parts.length = 0;
		if (!warps.has(t0)) {
			fps(sim);
			if (FP_OUT[0] !== R.fp[t0] || sim.stateHash() !== R.hash[t0] || sim.stateKey() !== R.keys[t0]) { first = { t0, at: t0, tname }; break; }
		}
		const end = Math.min(N, t0 + (R.evSnap.has(t0) ? EV_HORIZON : (i === 0 ? N : HORIZON)));
		for (let t = t0; t < end; t++) {
			if (t !== t0 && warps.has(t)) applyWarp(sim, warps.get(t));
			E.applyMask(inp, masks[t]); sim.tick(inp); ticks++;
			fps(sim);
			const evh = parts.length ? strHash(parts.join('\u0001')) : 0; parts.length = 0;
			if (FP_OUT[0] !== R.fp[t + 1] || sim.stateHash() !== R.hash[t + 1] || evh !== R.ev[t + 1] || sim.stateKey() !== R.keys[t + 1]) {
				first = { t0, at: t + 1, tname, evOnly: FP_OUT[0] === R.fp[t + 1] && evh !== R.ev[t + 1] };
				break;
			}
		}
		if (!first) { const bad = tilesCheck(sim); if (bad) first = { t0, at: end, tname, tiles: bad }; }
		sim.onEvent = null;
	}
	let detail = '';
	if (first) {
		detail = `snapshot at tick ${first.t0} restored into ${first.tname}: ${first.tiles || (first.evOnly ? 'events differ' : 'state differs')} at tick ${first.at}`;
		try { detail += '; ' + explainRestore(L, run, first.t0, first.at); } catch (e) { detail += `; (explain failed: ${e.message})`; }
	}
	ok(!first, `[${ctx.mode}] run ${ctx.run}: ${order.length} snapshots (${R.evSnap.size} before events / queues) restored in random order continue ` +
		`like the straight replay (${ticks} ticks compared)`, detail, first ? Object.assign({}, ctx, { at: first, upto: first.at }) : null);
	return ticks;
}
function explainRestore(L, run, t0, at) {
	const a = simAt(L, run, at);
	const s0 = simAt(L, run, t0);
	if (run.warps.has(t0)) applyWarp(s0, run.warps.get(t0));
	const b = new E.EESim(L);
	b.restore(s0.snapshot());
	const inp = new E.EEInput();
	for (let t = t0; t < at; t++) { if (t !== t0 && run.warps.has(t)) applyWarp(b, run.warps.get(t)); E.applyMask(inp, run.masks[t]); b.tick(inp); }
	const d = diffDump(a, b);
	return d.length ? `fields (straight vs restored in a fresh sim): ${d.slice(0, 8).join('; ')}` : 'not reproduced with a fresh sim (only with that target sim)';
}

// ---------------------------------------------------------------- 5. stateKey / stateHash
function addKeys(K, g, R, sid) {
	for (let t = 0; t <= R.N; t++) {
		const key = R.keys[t], h = R.hash[t];
		// equal states (up to a clock shift) -> equal keys
		const q = K.relmap.get(R.rel[t]);
		if (q === undefined) K.relmap.set(R.rel[t], { key, g, t });
		else if (q.key !== key && !K.relBad) K.relBad = [q.g, q.t, g, t];
		const e = K.kmap.get(key);
		if (e === undefined) {
			K.kmap.set(key, { h, g, t, rel: R.rel[t], sid });
			const o = K.hmap.get(h);
			if (o === undefined) K.hmap.set(h, key);
			else if (o !== key && !K.collision) K.collision = { g, t };
		} else {
			if (e.h !== h && !K.keyHashBad) K.keyHashBad = { g, t, first: [e.g, e.t] };
			if (e.sid === sid) {
				const cls = R.rel[t] !== e.rel ? 0 : e.g !== g ? 1 : t - e.t > 1 ? 2 : -1;
				if (cls >= 0) {
					const P = K.pairs[cls];
					if (P.length < 4000) P.push([e.g, e.t, g, t]);
					else { const j = Math.floor(K.rnd() * (P.length + K.seen[cls])); if (j < P.length) P[j] = [e.g, e.t, g, t]; }
					K.seen[cls]++;
				}
			}
		}
	}
}
/**
 * What a player (or the optimizer) can observe of a state: position, speed, the flags and counters that open doors or
 * change physics, switches, coins, secrets. Futures are compared on this plus the events: two states that behave
 * identically may still get different keys later (the key over-distinguishes on purpose, e.g. _ox/_oy while dead),
 * so comparing future keys would be wrong. (deaths is left out: it only matters with death doors, and every death is
 * an event anyway.)
 */
function obsOf(s) {
	const on = (m) => { const a = []; m.forEach((v, k) => { if (v === true) a.push(k); }); return a.sort((x, y) => x - y).join(','); };
	return [s.px, s.py, s.speed_x, s.speed_y, s.is_dead, s.coins, s.blue_coins, s.has_crown, s.has_silver_crown, s._keysMask, s.team,
		s.is_cursed, s.is_zombie, s.is_poisoned, s.is_on_fire, s.is_invulnerable, s.has_levitation, s.flip_gravity, s.max_jumps,
		s.jump_boost, s.speed_boost, s.low_gravity, s.checkpoint.x, s.checkpoint.y, s.on_ground, s.in_god_mode, on(s._switches),
		on(s._oswitches), [...s._coinBits].join(','), [...s._secretBits].join(',')].join('|');
}
/** dump() with the clocks dropped and the timer stamps taken relative to PlayState.ticks (what equal keys claim is equal). */
function relDump(sim) {
	const o = dump(sim), now = sim._ticks;
	for (const f of CLOCKS) delete o[f];
	for (const f of STAMPS) o[f] = sim[f] - now;
	o._kt = [...sim._kt].map((v) => v - now).join(',');
	return o;
}
/**
 * States with equal keys must behave identically: the same random inputs from both; the observable state (obsOf) and the events compared.
 * Class 0 (the states really differ, beyond a clock shift): up to 1500 candidates are materialized and bucketed by
 * WHICH fields differ; the rarest kinds of difference are tested first, so a field the key wrongly leaves out (a
 * rare one too) gets its own bucket. Classes 1 and 2 (clock shifts only) are sampled at random.
 */
function pairFutures(K, runs, rnd) {
	const cand0 = shuffle(K.pairs[0].slice(), rnd).slice(0, 1500);
	const rest = [];
	for (let c = 1; c < 3; c++) rest.push(...shuffle(K.pairs[c].slice(), rnd).slice(0, PAIRS[c]).map((p) => ({ p, cls: c })));
	if (!cand0.length && !rest.length) return { n: 0, bad: null, kinds: 0 };
	// materialize the states: replay each run once, snapshot at the needed ticks (before that tick's warp)
	const need = new Map();
	for (const p of [...cand0, ...rest.map((x) => x.p)]) for (const [g, t] of [[p[0], p[1]], [p[2], p[3]]]) { if (!need.has(g)) need.set(g, new Set()); need.get(g).add(t); }
	const snaps = new Map();
	for (const [g, ts] of need) {
		const run = runs[g], sim = new E.EESim(run.L), inp = new E.EEInput();
		const maxT = Math.max(...ts);
		for (let t = 0; t <= maxT; t++) {
			if (ts.has(t)) snaps.set(`${g}:${t}`, sim.snapshot());
			if (t === maxT) break;
			if (run.warps.has(t)) applyWarp(sim, run.warps.get(t));
			E.applyMask(inp, run.masks[t]); sim.tick(inp);
		}
	}
	// bucket class 0 by the set of differing fields; take the rarest kinds first, round robin
	const scratch = new Map();
	const simOf = (g, k) => { const id = `${g}/${k}`; let s = scratch.get(id); if (!s) scratch.set(id, s = new E.EESim(runs[g].L)); return s; };
	const buckets = new Map();
	for (const p of cand0) {
		const a = simOf(p[0], 0), b = simOf(p[2], 1);
		a.restore(snaps.get(`${p[0]}:${p[1]}`)); b.restore(snaps.get(`${p[2]}:${p[3]}`));
		const ra = relDump(a), rb = relDump(b);
		// + the context in which the difference sits (a field the key keys only in some situations needs those situations)
		const ctx = [a._boxTouchesOneWay() ? 'oneway' : '', a.is_dead ? 'dead' : '', a.has_levitation ? 'lev' : '', a._team_tx !== -1 ? 'teampending' : '',
			a._stateQueue.length || a._keysQueue.length || a._tileQueue.length ? 'queue' : '', a.is_cursed || a.is_zombie || a.is_poisoned || a.is_on_fire ? 'timed' : '',
			a._keysMask ? 'keys' : ''].filter(Boolean).join('+');
		const sig = (Object.keys(ra).filter((k) => String(ra[k]) !== String(rb[k])).join(',') || '(none)') + (ctx ? ' @' + ctx : '');
		if (!buckets.has(sig)) buckets.set(sig, []);
		buckets.get(sig).push(p);
	}
	const order = [...buckets.values()].sort((x, y) => x.length - y.length);
	const chosen = [];
	for (let round = 0; chosen.length < PAIRS[0] && round < 64; round++) {
		let any = false;
		for (const b of order) if (round < b.length && chosen.length < PAIRS[0]) { chosen.push({ p: b[round], cls: 0 }); any = true; }
		if (!any) break;
	}
	chosen.push(...rest);
	let bad = null, n = 0;
	for (let i = 0; i < chosen.length && !bad; i++) {
		const { p, cls } = chosen[i];
		const ra = runs[p[0]], rb = runs[p[2]];
		const a = new E.EESim(ra.L), b = new E.EESim(rb.L);
		a.restore(snaps.get(`${p[0]}:${p[1]}`)); b.restore(snaps.get(`${p[2]}:${p[3]}`));
		const d0 = diffDump(relDump(a), relDump(b));
		const desc = `${ra.mode} run ${ra.r} tick ${p[1]} vs ${rb.mode} run ${rb.r} tick ${p[3]}${ra.warpFrom <= p[1] || rb.warpFrom <= p[3] ? ' (warped states)' : ''}`;
		if (a.stateKey() !== b.stateKey()) { bad = `${desc}: keys differ after materializing (stateHash collision?)`; break; }
		const pa = [], pb = [];
		a.onEvent = (k, d) => pa.push(evStr(k, d, true));
		b.onEvent = (k, d) => pb.push(evStr(k, d, true));
		const gen = new Sticky(mulberry32(Math.floor(rnd() * 4294967296)));
		const ia = new E.EEInput(), ib = new E.EEInput();
		n++;
		for (let t = 0; t < FUTURE; t++) {
			const m = gen.next();
			E.applyMask(ia, m); a.tick(ia);
			E.applyMask(ib, m); b.tick(ib);
			const ea = pa.join('|'), eb = pb.join('|');
			pa.length = 0; pb.length = 0;
			if (ea !== eb || obsOf(a) !== obsOf(b)) {
				const dd = diffDump(dump(a), dump(b), CLOCKS);
				bad = `${desc} (class ${['states differ beyond a clock shift', 'other run or start mode', 'later in the same run'][cls]}; they differ in: ${d0.slice(0, 10).join('; ') || 'nothing but clocks'}): ` +
					`${ea !== eb ? `events differ (${ea || '-'} vs ${eb || '-'})` : 'the observable state differs'} after ${t + 1} common ticks; fields then: ${dd.slice(0, 8).join('; ')}`;
				break;
			}
		}
	}
	return { n, bad, kinds: buckets.size };
}

/**
 * Key completeness per field: take a real state, copy ONE field from another real state of the level (so values stay
 * plausible); if stateKey does not change, the two states must behave identically (same inputs, 150 ticks: the observable
 * state and the events). Fields coupled to others by construction are not copied alone: _rngState (= f(_rngSteps) in PCG mode) and
 * the _ev* event baselines (synced with the state after every tick); _current_thrust only into levitating states.
 */
const PERTURB_FUTURE = 150;
const PERTURB_SKIP = new Set(['_rngState', '_evKeysMask', '_ev_coins', '_ev_bcoins', '_ev_timedoor', '_ev_grav_x', '_ev_grav_y']);
const PERTURB_FIELDS = [...SCAL.filter((f) => !PERTURB_SKIP.has(f)), 'gravity_dir', 'checkpoint', '_kt'];
function snapVal(s, f) {
	if (f === 'gravity_dir') return `${s.gdx},${s.gdy}`;
	if (f === 'checkpoint') return `${s.cpx},${s.cpy}`;
	if (f === '_kt') return `${s.kt0},${s.kt1},${s.kt2},${s.kt3},${s.kt4},${s.kt5}`;
	const v = s[f];
	return typeof v === 'bigint' ? v.toString() : Object.is(v, -0) ? '-0' : String(v);
}
function snapSet(sim, f, s) {
	if (f === 'gravity_dir') { sim.gravity_dir.x = s.gdx; sim.gravity_dir.y = s.gdy; } else if (f === 'checkpoint') { sim.checkpoint.x = s.cpx; sim.checkpoint.y = s.cpy; } else if (f === '_kt') { const k = sim._kt; k[0] = s.kt0; k[1] = s.kt1; k[2] = s.kt2; k[3] = s.kt3; k[4] = s.kt4; k[5] = s.kt5; } else sim[f] = s[f];
}
function perturbChecks(pool, runs, rnd) {
	let tried = 0, same = 0, bad = null;
	const sims = new Map();
	const simOf = (g, k) => { const id = `${g}/${k}`; let s = sims.get(id); if (!s) sims.set(id, s = new E.EESim(runs[g].L)); return s; };
	const pa = [], pb = [], ia = new E.EEInput(), ib = new E.EEInput();
	for (let i = 0; i < pool.length && !bad; i++) {
		const { g, snap } = pool[i];
		for (const f of PERTURB_FIELDS) {
			const v0 = snapVal(snap, f);
			// _current_thrust is 0 whenever levitation is off (every path that turns it off zeroes it): copy it only into levitating states
			if (f === '_current_thrust' && !snap.has_levitation) continue;
			const donors = pool.filter((d) => snapVal(d.snap, f) !== v0);
			if (!donors.length) continue;
			const d = donors[Math.floor(rnd() * donors.length)];
			const a = simOf(g, 0), b = simOf(g, 1);
			a.restore(snap); b.restore(snap); snapSet(b, f, d.snap);
			tried++;
			if (a.stateKey() !== b.stateKey()) continue;
			same++;
			a.onEvent = (k, x) => pa.push(evStr(k, x, true)); b.onEvent = (k, x) => pb.push(evStr(k, x, true));
			pa.length = 0; pb.length = 0;
			const gen = new Sticky(mulberry32(Math.floor(rnd() * 4294967296)));
			for (let t = 0; t < PERTURB_FUTURE; t++) {
				const m = gen.next();
				E.applyMask(ia, m); a.tick(ia); E.applyMask(ib, m); b.tick(ib);
				const ea = pa.join('|'), eb = pb.join('|'); pa.length = 0; pb.length = 0;
				if (ea !== eb || ((t % 3 === 0 || t === PERTURB_FUTURE - 1) && obsOf(a) !== obsOf(b))) {
					const run = runs[g];
					bad = `${run.mode} run ${run.r} tick ${pool[i].t}: ${f} ${v0} -> ${snapVal(d.snap, f)} keeps the stateKey, but after ${t + 1} ticks ` +
						`${ea !== eb ? `the events differ (${ea || '-'} vs ${eb || '-'})` : 'the observable state differs'}; fields then: ${diffDump(dump(a), dump(b), CLOCKS).slice(0, 6).join('; ')}`;
					break;
				}
			}
			a.onEvent = null; b.onEvent = null;
			if (bad) break;
		}
	}
	return { tried, same, bad };
}

// ---------------------------------------------------------------- 6. random portals, per portal and choice
function portalChoices(L) {
	const W = L.width;
	const slotAt = new Map();
	for (let i = 0; i < L.portalSlot.length; i++) if (L.portalSlot[i] >= 0) slotAt.set(L.portalSlot[i], i);
	const seenTarget = new Set();
	let tested = 0, noTeleport = 0, bad = null;
	for (let s = 0; s < L.pId.length && !bad && tested < 30; s++) {
		const tgId = L.pTarget[s];
		if (tgId === L.pId[s] || seenTarget.has(tgId)) continue;
		const tg = L.portalsById.get(tgId);
		if (!tg || tg.n < 2) continue;
		seenTarget.add(tgId);
		const i = slotAt.get(s), x = i % W, y = Math.floor(i / W);
		const choices = [];
		for (let c = 0; c < Math.min(tg.n, 8); c++) choices.push({ script: [c], want: c, need: 0 });
		choices.push({ script: [], want: 0, need: tg.n }, { script: [tg.n + 3], want: 0, need: 0 }, { script: [-1], want: 0, need: 0 });
		let any = false;
		for (const ch of choices) {
			const sim = new E.EESim(withScript(L, ch.script)), inp = new E.EEInput();
			sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0;
			sim._last_portal_set = false;   // (a fresh load has lastPortal set: EEO never teleports from the spawn tile)
			const s0 = sim.snapshot();
			let ev = null;
			sim.onEvent = (k, d) => { if (k === 'portal' && !ev) ev = d; };
			for (const m of [0, 4, 2, 8, 16, 1, 5, 3]) {
				sim.restore(s0);
				for (let t = 0; t < 4 && !ev; t++) { E.applyMask(inp, m); sim.tick(inp); }
				if (ev) break;
			}
			if (!ev) { noTeleport++; break; }
			any = true;
			const ex = { x: tg.xs[ch.want] >> 4, y: tg.ys[ch.want] >> 4 };
			if (ev.from.x !== x || ev.from.y !== y || ev.to.x !== ex.x || ev.to.y !== ex.y || sim._rngSteps !== 1 || sim.rngNeed !== ch.need) {
				bad = `portal (${x}, ${y}) -> id ${tgId} (${tg.n} exits), script [${ch.script}]: went (${ev.from.x}, ${ev.from.y}) -> (${ev.to.x}, ${ev.to.y}), ` +
					`expected exit ${ch.want} (${ex.x}, ${ex.y}); draws ${sim._rngSteps}, rngNeed ${sim.rngNeed} (expected ${ch.need})`;
				break;
			}
		}
		if (any) tested++;
	}
	return { tested, noTeleport, bad };
}
/** rng.js's outcome tree (play / analyze) over the first random draws of a run: every leaf takes the exits its script names. */
function rngTree(L, masks, draws) {
	if (!draws.length) return null;
	const lastT = draws[Math.min(2, draws.length - 1)].t;
	if (lastT > 12000) return null;
	const prefix = masks.subarray(0, Math.min(masks.length, lastT + 30));
	const W = L.width;
	let plays = 0, leaves = 0, bad = null;
	const MAXP = 120;
	(function dfs(script) {
		if (plays >= MAXP || bad) return;
		plays++;
		const r = RNG.play(L, prefix, script);
		for (let j = 0; j < r.draws.length && !bad; j++) {
			const dr = r.draws[j];
			if (!dr.from) { bad = `script [${script}]: draw ${j} has no portal`; break; }
			const slot = L.portalSlot[dr.from.y * W + dr.from.x], tg = L.portalsById.get(L.pTarget[slot]);
			const c = j < script.length ? script[j] : 0;
			if (!tg || (tg.xs[c] >> 4) !== dr.to.x || (tg.ys[c] >> 4) !== dr.to.y) bad = `script [${script}]: draw ${j} at (${dr.from.x}, ${dr.from.y}) went to (${dr.to.x}, ${dr.to.y}), expected exit ${c}`;
			if (r.need && j === r.draws.length - 1 && tg && r.need !== tg.n) bad = `script [${script}]: need ${r.need} but the portal has ${tg.n} exits`;
		}
		if (r.need) for (let c = 0; c < r.need; c++) dfs(script.concat([c]));
		else leaves++;
	})([]);
	const an = RNG.analyze(L, prefix, { maxPlays: MAXP });
	if (!bad && !an.truncated && plays < MAXP && an.plays !== plays) bad = `rng.analyze made ${an.plays} plays, the tree has ${plays}`;
	if (!bad && !an.draws) bad = 'rng.analyze saw no random draw';
	return { plays, leaves, bad, chance: an.chance, truncated: an.truncated || plays >= MAXP };
}

// ---------------------------------------------------------------- 7. the app: import (sandboxed) and helpers
let SB = null;
function sandbox() {
	if (SB) return SB;
	if (INPLACE) {
		SB = { dir: null, J: require('../src/jobs.js'), C: require('../src/common.js'), VW: require('../src/viewer.js') };
	} else {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-fuzz-'));
		const src = path.join(dir, 'src');
		fs.mkdirSync(src);
		for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
			const p = path.join(ROOT, 'src', f);
			if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(src, f));
		}
		SB = { dir, J: require(path.join(src, 'jobs.js')), C: require(path.join(src, 'common.js')), VW: require(path.join(src, 'viewer.js')) };
		process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
	}
	SB.JOBS = SB.C.JOBS; SB.DATA = SB.C.DATA;
	return SB;
}
const listDir = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return []; } };
const BAD_MSG = /undefined|NaN|\[object|Cannot read|is not a function|is not defined|Invalid typed array|Maximum call stack|allocation failed/;
/** One importJob call: returns { finished, msg, ms, problem } (problem = why it is not clean, or null). */
function importOne(buf, name, eetas, mode) {
	const S = sandbox();
	const before = new Set([...listDir(S.JOBS).map((x) => 'j/' + x), ...listDir(S.DATA).map((x) => 'd/' + x)]);
	let meta = null, err = null;
	const t0 = Date.now();
	try { meta = S.J.importJob({ eelvl: buf, eetas, name: 'fuzz ' + name, eelvlName: name, eetasName: 'fuzz.eetas', startMode: mode }); } catch (e) { err = e; }
	const ms = Date.now() - t0;
	let problem = null;
	if (meta) {
		const d = S.J.jobDir(meta.id);
		for (const f of ['meta.json', 'status.json', 'best.eetas', 'original.eelvl', 'original.eetas']) if (!fs.existsSync(path.join(d, f))) problem = `finished but ${f} is missing`;
		if (!fs.existsSync(S.J.levelJsonOf(meta.id))) problem = 'finished but the level JSON is missing';
		try { S.J.deleteJob(meta.id); } catch (e) { problem = `deleteJob: ${e.message}`; }
	} else if (!(err instanceof Error)) problem = `threw a non-Error: ${String(err)}`;
	else if (err.constructor.name !== 'Error') problem = `${err.constructor.name}: ${err.message}`;
	else if (!err.message || err.message.length < 8 || BAD_MSG.test(err.message)) problem = `unclear message: ${err.message}`;
	const after = [...listDir(S.JOBS).map((x) => 'j/' + x), ...listDir(S.DATA).map((x) => 'd/' + x)].filter((x) => !before.has(x));
	if (after.length) problem = (problem ? problem + '; ' : '') + `left behind: ${after.join(', ')}`;
	return { finished: !!meta, msg: meta ? `imported (finishes: ${meta.tas.time})` : err && err.message, ms, problem, stack: err && err.stack };
}
function importChecks(entry, walks) {
	const res = [];
	for (const mode of ['reset', 'load']) {
		const variants = [['trivial', Buffer.from('0'.repeat(100))]];
		const w = walks.get(mode);
		if (w) { const n = Math.min(w.length, 2000); const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = 48 + w[i]; variants.push(['walk', b]); }
		for (const [label, eetas] of variants) {
			const r = importOne(entry.buf, entry.name, eetas, mode);
			res.push(Object.assign({ mode, label }, r));
			ok(!r.problem, `import [${mode}] with a ${label} .eetas (${eetas.length} ticks): ${r.finished ? 'imported' : 'refused'} cleanly in ${r.ms} ms`,
				r.problem ? `${r.problem}${r.stack && r.problem ? ' @ ' + firstLines({ stack: r.stack }, 3) : ''}` : undefined);
		}
	}
	return res;
}
function appSmoke(json, mode, script, masks) {
	const S = sandbox();
	const errs = [];
	const tryit = (what, fn) => { try { return fn(); } catch (e) { errs.push(`${what}: ${firstLines(e, 2)}`); return null; } };
	const lv = tryit('prepareLevel', () => { const l = S.C.E.prepareLevel(json, { start: mode }); if (script !== null) l.rngScript = Int32Array.from(script); return l; });
	if (!lv) return errs;
	tryit('common.replay', () => S.C.replay(lv, masks, { trace: true }));
	const tr = tryit('viewer.trajectory', () => S.VW.trajectory(lv, masks));
	if (tr) { tryit('viewer.json', () => JSON.stringify(S.VW.json(tr))); tryit('viewer.align', () => S.VW.align(tr, tr)); }
	tryit('viewer.levelView', () => JSON.stringify(S.VW.levelView(json, lv, null)));
	tryit('viewer.startMatters', () => S.VW.startMatters(lv));
	for (const t of [0, masks.length >> 1, masks.length]) tryit(`jobs.where t${t}`, () => S.J.formatWhere(S.J.where(lv, masks, 't' + t)));
	tryit('jobs.replayInfo', () => S.J.formatReplay(S.J.replayInfo(lv, masks), 'fuzz'));
	tryit('jobs.renderJob', () => { const o = S.J.renderJob(lv, json, masks, 't0', 't' + Math.min(masks.length, 800), { name: 'fuzz' }); if (!o.png || !o.png.length) throw new Error('no png'); });
	return errs;
}
/** Bad inputs to the import: every one must be refused with a clean Error and leave nothing behind. */
function importNegatives(sampleBuf) {
	console.log('\n== import: bad inputs (clean errors, nothing left behind)');
	const cases = [
		['an empty .eelvl', Buffer.alloc(0), Buffer.from('000'), 'reset'],
		['an empty .eetas', sampleBuf, Buffer.alloc(0), 'reset'],
		['start mode "bogus"', sampleBuf, Buffer.from('000'), 'bogus'],
		['random bytes as .eelvl', Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 2654435761 >>> 13) & 255)), Buffer.from('000'), 'reset'],
		['a truncated .eelvl (first 40%)', sampleBuf.subarray(0, Math.floor(sampleBuf.length * 0.4)), Buffer.from('000'), 'reset'],
		['a zip as .eelvl', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]), Buffer.from('000'), 'reset'],
		['an .eetas of CR LF bytes', sampleBuf, Buffer.from('\r\n'.repeat(60), 'latin1'), 'load'],
		['an .eetas of one byte', sampleBuf, Buffer.from('4'), 'reset'],
		['a level with a negative block id', writeEelvl({ W: 8, H: 6, records: [...roomRecords(8, 6), { id: -5, xs: [3], ys: [2] }] }), Buffer.from('000'), 'reset'],
		['a level with block id 3000000 (flag tables sized by the largest id)', writeEelvl({ W: 8, H: 6, records: [...roomRecords(8, 6), { id: 3000000, xs: [3], ys: [2] }] }), Buffer.from('000'), 'reset'],
		['a 1000 x 1000 empty level', writeEelvl({ W: 1000, H: 1000, records: [{ id: 255, xs: [5], ys: [5] }] }), Buffer.from('0'.repeat(50)), 'reset'],
	];
	for (const [label, eelvl, eetas, mode] of cases) {
		// guard: never feed the import something that would allocate gigabytes (prepareLevel sizes tables by W*H and the max id)
		let est = 0;
		try { const p = V.readEelvl(eelvl); let mx = 0; for (const r of p.records) if (r.id > mx) mx = r.id; est = p.width * p.height * 60 + mx * 25; } catch (e) { /* refused by the reader */ }
		if (est > 1.5e9) { console.log(`    skip ${label}: the import would allocate ~${(est / 1e9).toFixed(1)} GB`); continue; }
		const r = importOne(eelvl, 'bad-input', eetas, mode);
		ok(!r.problem, `import of ${label}: ${r.finished ? 'imported' : 'refused'} in ${r.ms} ms`, r.problem || undefined);
		if (!r.problem) console.log(`         -> ${r.msg}`);
	}
}

// ---------------------------------------------------------------- synthetic levels (.eelvl writer)
/** A minimal .eelvl writer (raw deflate, header + records in World.deserializeFromMessage's format). args: numbers -> int32, strings -> UTF. */
function writeEelvl({ W, H, gravity = 1, name = 'fuzz', records }) {
	const utf = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
	const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
	const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
	const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
	const bool = (v) => Buffer.from([v ? 1 : 0]);
	const us = (arr) => { const b = Buffer.alloc(4 + 2 * arr.length); b.writeUInt32BE(2 * arr.length); arr.forEach((v, k) => b.writeUInt16BE(v, 4 + 2 * k)); return b; };
	const parts = [utf('fuzz'), utf(name), i32(W), i32(H), f32(gravity), u32(0), utf(''), bool(false), utf(''), utf(''), i32(0), bool(true), utf('')];
	for (const r of records) {
		parts.push(i32(r.id), i32(r.layer || 0), us(r.xs), us(r.ys));
		for (const a of r.args || []) parts.push(typeof a === 'string' ? utf(a) : i32(a));
	}
	return zlib.deflateRawSync(Buffer.concat(parts));
}
function roomRecords(W, H) {
	const xs = [], ys = [];
	for (let x = 0; x < W; x++) { xs.push(x, x); ys.push(0, H - 1); }
	for (let y = 1; y < H - 1; y++) { xs.push(0, W - 1); ys.push(y, y); }
	return [{ id: 9, xs, ys }, { id: 255, xs: [1], ys: [H - 2] }];
}
/**
 * The all-mechanics arena (90 x 50): 7 corridors joined by holes (a serpentine), with every block family the sample
 * levels lack or barely use: all keys + doors + gates, coin / blue coin / death / time / crown / silver crown / gold /
 * zombie / team doors and gates, purple + orange switches with resets, every timed and static effect (curse, zombie,
 * NPC zombie, poison, protection, effect reset, levitation, teams, jump, speed, low gravity, multijump, gravity),
 * liquids, ice, climbables, boosts, dots, (invisible) arrows, blink blocks, half blocks and one-ways in every
 * rotation, secrets, spikes, fire, music, keyboard-only blocks, random multi-exit portals (visible + invisible),
 * self / dangling / single-exit portals, 3 spawn points (2 x 255 + 1582 #0), collected coins stored in the file, and
 * deferral traps (a key expiring, a switch / crown / team change while inside the door it closes).
 */
function arenaRecords(noTimeDoors) {
	const W = 90, H = 50, recs = [];
	const put = (id, pts, args) => { const xs = [], ys = []; for (const [x, y] of pts) { xs.push(x); ys.push(y); } recs.push({ id, xs, ys, args: args || [] }); };
	const col = (x, y0, y1) => { const a = []; for (let y = y0; y <= y1; y++) a.push([x, y]); return a; };
	const rect = (x0, x1, y0, y1) => { const a = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) a.push([x, y]); return a; };
	const FLOORS = [7, 14, 21, 28, 35, 42];
	const solid = [];
	for (let x = 0; x < W; x++) solid.push([x, 0], [x, H - 1]);
	for (let y = 1; y < H - 1; y++) solid.push([0, y], [W - 1, y]);
	FLOORS.forEach((fy, k) => {
		const hole = k % 2 === 0 ? [86, 87] : [2, 3];
		for (let x = 1; x < W - 1; x++) if (!hole.includes(x) && !(fy === 21 && x >= 51 && x <= 58)) solid.push([x, fy]);
	});
	put(9, solid);
	// corridor 1 (y 1..6): spawns, coins, coin doors, all keys with doors and gates, deaths, time / crown / gold / silver doors
	put(255, [[2, 6]]); put(255, [[45, 6]]);
	put(100, [[4, 6], [5, 6], [6, 6], [5, 4]]); put(101, [[7, 6], [8, 4]]); put(110, [[9, 6]]); put(111, [[10, 6]]);
	put(43, col(12, 1, 6), [3]); put(165, col(14, 5, 6), [2]); put(213, col(16, 1, 6), [1]); put(214, col(18, 5, 6), [1]);
	[[6, 23, 26, 20], [7, 24, 27, 25], [8, 25, 28, 30], [408, 1005, 1008, 35], [409, 1006, 1009, 40], [410, 1007, 1010, 47]].forEach(([key, door, gate, x]) => {
		put(key, [[x, 6]]); put(door, col(x + 2, 1, 6)); put(gate, col(x + 3, 5, 6));
	});
	put(360, [[52, 6]]); put(361, [[54, 6]], [1]); put(368, [[56, 6]]); put(1011, col(58, 1, 6), [1]); put(1012, col(60, 5, 6), [2]);
	put(360, [[62, 6]]); put(1580, [[64, 6]]); put(1625, [[66, 6]], [0]); if (!noTimeDoors) { put(156, col(68, 1, 6)); put(157, col(70, 5, 6)); }
	put(5, [[72, 6]]); put(1094, col(74, 1, 6)); put(1095, col(76, 5, 6)); put(200, col(78, 5, 6)); put(201, col(80, 5, 6));
	put(1152, col(82, 5, 6)); put(1153, col(84, 5, 6));
	// corridor 2 (y 8..13): switches, resets, zombie doors, timed effects, protection, effect reset, lava/water/fire, levitation, teams
	put(113, [[84, 13]], [1]); put(184, col(82, 8, 13), [1]); put(185, col(80, 12, 13), [1]); put(1619, [[78, 13]], [1]); put(1619, [[76, 13]], [1000]);
	put(467, [[74, 13]], [2]); put(1079, col(72, 8, 13), [2]); put(1080, col(70, 12, 13), [2]); put(1620, [[68, 13]], [2]);
	put(422, [[66, 13]], [3]); put(206, col(64, 12, 13)); put(207, col(62, 8, 13)); put(1573, [[60, 13]], ['zed', 'a', 'b', 'c']);
	put(421, [[58, 13]], [2]); put(1584, [[56, 13]], [3]); put(420, [[54, 13]], [1]); put(421, [[52, 13]], [5]); put(422, [[50, 13]], [2]);
	put(1584, [[48, 13]], [1]); put(420, [[46, 13]], [0]); put(1618, [[44, 13]]); put(421, [[42, 13]], [0]); put(422, [[40, 13]], [0]); put(1584, [[38, 13]], [0]);
	put(416, rect(34, 35, 12, 13)); put(119, rect(31, 32, 12, 13)); put(368, [[29, 13]]);
	put(418, [[27, 13]], [1]); put(361, [[18, 8], [19, 8], [20, 8], [21, 8]], [3]); put(418, [[14, 13]], [0]);
	put(423, [[12, 13]], [1]); put(1027, col(10, 8, 13), [1]); put(1028, col(8, 12, 13), [1]); put(423, [[6, 13]], [2]); put(423, [[4, 13]], [0]);
	// corridor 3 (y 15..20): static effects, liquids, ice, climbables, boosts
	[[417, 1], [417, 2], [419, 1], [419, 2], [453, 1], [453, 0], [461, 3], [461, 1000], [461, 1], [1517, 1], [1517, 2], [1517, 3], [1517, 4], [1517, 0], [417, 0], [419, 0]]
		.forEach(([id, v], k) => put(id, [[5 + 2 * k, 20]], [v]));
	put(119, rect(37, 41, 17, 20)); put(369, rect(43, 46, 18, 20)); put(1585, rect(48, 49, 19, 20)); put(1064, rect(51, 58, 21, 21));
	put(98, col(60, 16, 20)); put(118, col(62, 16, 20)); put(120, col(64, 16, 20)); put(99, rect(66, 70, 17, 17)); put(424, col(72, 16, 20));
	put(114, [[74, 20]]); put(115, [[76, 19]]); put(116, [[78, 20]]); put(117, [[80, 17]]);
	// corridor 4 (y 22..27): dots, arrows (visible, invisible = blink), half blocks and one-ways in every rotation, secrets, spikes, music
	put(4, rect(80, 84, 23, 27)); put(414, rect(76, 78, 24, 27));
	[[1, 74], [2, 72], [3, 70], [1518, 68], [411, 66], [412, 64], [413, 62], [1519, 60]].forEach(([id, x]) => put(id, col(x, 25, 27)));
	put(460, col(58, 23, 27));
	for (let r = 0; r < 4; r++) { put(1041, [[52 + r, 27]], [r]); put(1042, [[47 + r, 27]], [r]); put(1043, [[42 + r, 26]], [r]); }
	put(1101, [[40, 27]], [0]); put(1116, [[38, 27]], [1]); put(1116, [[37, 25]], [3]);
	put(61, [[34, 25]]); put(62, [[33, 24]]); put(63, [[32, 25]]); put(64, [[31, 26]]); put(89, [[30, 25]]); put(154, [[29, 24]]);
	for (let r = 0; r < 4; r++) { put(1001, [[24 + r, 25]], [r]); put(1052, [[19 + r, 24]], [r]); }
	put(1092, [[17, 25]], [1]); put(1155, [[16, 25]], [2]);
	put(77, [[14, 27]], [5]); put(83, [[13, 27]], [3]); put(1520, [[14, 24]], [2]);
	put(50, col(11, 25, 27)); put(243, [[9, 26]]);
	for (let r = 0; r < 4; r++) put(361, [[4 + r, 27]], [r]);
	put(1625, [[5, 23]], [2]); put(1626, [[8, 27]]);
	// corridor 5 (y 29..34): portals: random multi-exit (visible + invisible exits), self-target, dangling, single-exit, keyboard-only blocks
	put(242, [[6, 34]], [0, 1, 2]); put(242, [[20, 33]], [1, 2, 9]); put(381, [[35, 34]], [2, 2, 9]); put(242, [[50, 32]], [3, 2, 9]); put(242, [[80, 34]], [0, 9, 1]);
	put(242, [[9, 34]], [0, 3, 3]); put(381, [[11, 34]], [1, 4, 77]); put(242, [[13, 34]], [2, 5, 6]); put(242, [[60, 34]], [0, 6, 5]); put(381, [[65, 33]], [3, 6, 5]);
	put(242, [[15, 34]], [3, 7, 8]); put(381, [[70, 34]], [0, 8, 7]);
	put(1516, [[24, 34]]); put(466, [[26, 34]]); put(385, [[28, 34]], ['hello', 0]); put(1000, [[30, 34]], ['label', '#ffffff', 200]);
	put(1582, [[40, 34]], [0]); put(1582, [[42, 34]], [1]); put(1550, [[44, 34]], ['npc', 'a', 'b', 'c']); put(374, [[46, 34]], ['elsewhere', 0]);
	// corridor 6 (y 36..41): deferral traps (key expiry, purple / orange switch, crown, team change while inside the door)
	put(6, [[84, 41]]); put(23, rect(55, 82, 39, 41));
	put(113, [[52, 41]], [7]); put(184, rect(40, 50, 39, 41).filter(([x, y]) => !(x === 45 && y === 41)), [7]); put(113, [[45, 41]], [7]);
	put(467, [[38, 41]], [8]); put(1079, rect(26, 36, 39, 41).filter(([x, y]) => !(x === 31 && y === 41)), [8]); put(467, [[31, 41]], [8]);
	put(1095, rect(16, 24, 39, 41).filter(([x, y]) => !(x === 20 && y === 41))); put(5, [[20, 41]]);
	put(423, [[14, 41]], [3]); put(1027, rect(6, 12, 39, 41).filter(([x, y]) => !(x === 9 && y === 41)), [3]); put(423, [[9, 41]], [4]);
	put(1584, [[5, 40]], [1]);
	// corridor 7 (y 43..48): time doors, checkpoints, coin / death doors, lava, a key door to wait in, the trophy
	if (!noTimeDoors) { put(156, col(8, 43, 48)); put(156, col(14, 43, 48)); put(157, col(20, 47, 48)); put(157, col(26, 47, 48)); }
	put(360, [[5, 48]]); put(360, [[30, 48]]); put(101, [[32, 48], [33, 48], [34, 48], [35, 48], [36, 48]]);
	put(165, col(40, 47, 48), [5]); put(43, col(44, 43, 48), [1]); put(1011, col(48, 43, 48), [3]); put(416, rect(52, 54, 47, 48));
	put(361, [[58, 48]], [1]); put(408, [[60, 48]]); put(1005, rect(62, 75, 46, 48)); put(1153, col(80, 47, 48)); put(121, [[85, 48]]);
	return { W, H, records: recs };
}
function craftedLevels() {
	const out = [];
	const room = (W, H, extra) => [...roomRecords(W, H), ...extra];
	out.push({ name: '(crafted) 1x1 world', buf: writeEelvl({ W: 1, H: 1, records: [] }), ticks: 3000 });
	out.push({ name: '(crafted) 2x2 world', buf: writeEelvl({ W: 2, H: 2, records: [{ id: 255, xs: [0], ys: [0] }, { id: 9, xs: [0, 1], ys: [1, 1] }] }), ticks: 3000 });
	out.push({ name: '(crafted) 3x1 spike world', buf: writeEelvl({ W: 3, H: 1, records: [{ id: 255, xs: [0], ys: [0] }, { id: 361, xs: [1], ys: [0], args: [1] }, { id: 100, xs: [2], ys: [0] }] }), ticks: 3000 });
	const mix = [{ id: 1, xs: [4, 4], ys: [3, 4] }, { id: 4, xs: [8, 9], ys: [2, 2] }, { id: 119, xs: [11, 12], ys: [5, 5] }, { id: 242, xs: [6], ys: [5], args: [0, 1, 2] },
		{ id: 242, xs: [13], ys: [2], args: [1, 2, 1] }, { id: 242, xs: [3], ys: [2], args: [2, 2, 1] }, { id: 418, xs: [7], ys: [5], args: [1] }, { id: 1064, xs: [9, 10], ys: [6, 6] }];
	out.push({ name: '(crafted) world gravity 0', buf: writeEelvl({ W: 16, H: 8, gravity: 0, records: room(16, 8, mix) }), ticks: 6000 });
	out.push({ name: '(crafted) world gravity -0.5', buf: writeEelvl({ W: 16, H: 8, gravity: -0.5, records: room(16, 8, mix) }), ticks: 6000 });
	out.push({ name: '(crafted) world gravity 2.7', buf: writeEelvl({ W: 16, H: 8, gravity: 2.7, records: room(16, 8, mix) }), ticks: 6000 });
	out.push({ name: '(crafted) ids 70000 + bg 5000', buf: writeEelvl({ W: 12, H: 8, records: room(12, 8, [{ id: 70000, xs: [5], ys: [5] }, { id: 5000, layer: 1, xs: [6], ys: [6] }, { id: 4000, xs: [7], ys: [6] }]) }), ticks: 4000 });
	out.push({ name: '(crafted) spawn in spikes, no exit', buf: writeEelvl({ W: 6, H: 5, records: [{ id: 9, xs: [0, 1, 2, 3, 4, 5, 0, 5, 0, 5, 0, 1, 2, 3, 4, 5], ys: [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 4, 4, 4, 4, 4, 4] },
		{ id: 0, xs: [], ys: [] }, { id: 255, xs: [2], ys: [3] }, { id: 361, xs: [1, 2, 3, 4], ys: [3, 3, 3, 3], args: [1] }, { id: 23, xs: [1, 2, 3, 4], ys: [2, 2, 2, 2] }] }), ticks: 4000 });
	out.push({ name: '(crafted) no spawn, portal ring', buf: writeEelvl({ W: 10, H: 6, records: [...roomRecords(10, 6).slice(0, 1),
		{ id: 242, xs: [1], ys: [1], args: [0, 1, 2] }, { id: 242, xs: [4], ys: [4], args: [1, 2, 3] }, { id: 381, xs: [7], ys: [4], args: [2, 2, 3] }, { id: 242, xs: [8], ys: [1], args: [3, 3, 1] }] }), ticks: 4000 });
	return out;
}

// ---------------------------------------------------------------- coverage groups (for the summary)
const GROUPS = [
	['curse 421', [421]], ['zombie 422', [422]], ['NPC zombie 1573', [1573]], ['poison 1584', [1584]], ['protection 420', [420]],
	['effect reset 1618', [1618]], ['levitation 418', [418]], ['team 423', [423]], ['team doors 1027/1028', [1027, 1028]],
	['jump/speed/lowgrav/multijump/gravity effects', [417, 419, 453, 461, 1517]], ['time doors 156/157', [156, 157]],
	['keys', [6, 7, 8, 408, 409, 410]], ['key doors/gates', [23, 24, 25, 26, 27, 28, 1005, 1006, 1007, 1008, 1009, 1010]],
	['purple switch 113', [113]], ['purple door/gate 184/185', [184, 185]], ['purple reset 1619', [1619]], ['orange switch 467', [467]],
	['orange door/gate 1079/1080', [1079, 1080]], ['orange reset 1620', [1620]], ['coin door/gate 43/165', [43, 165]],
	['blue coin door/gate 213/214', [213, 214]], ['death door/gate 1011/1012', [1011, 1012]], ['crown 5', [5]], ['crown door/gate 1094/1095', [1094, 1095]],
	['silver crown door/gate 1152/1153', [1152, 1153]], ['trophy 121', [121]], ['zombie gate/door 206/207', [206, 207]], ['gold door/gate 200/201', [200, 201]],
	['water 119', [119]], ['mud 369', [369]], ['lava 416', [416]], ['toxic 1585', [1585]], ['ice 1064', [1064]],
	['climbables', [120, 118, 98, 99, 424, 459, 460, 472, 1534, 1146, 1563, 1602]], ['boosts 114-117', [114, 115, 116, 117]],
	['half blocks', [1041, 1042, 1043, 1075, 1076, 1077, 1078, 1101, 1102, 1103, 1104, 1105, 1116, 1117, 1118, 1119, 1120, 1121, 1122, 1123, 1124, 1125, 1140, 1141]],
	['one-ways', [61, 62, 63, 64, 89, 90, 91, 96, 97, 122, 123, 124, 125, 126, 127, 146, 154, 158, 194, 211, 216, 1069, 1087, 1001, 1002, 1003, 1004, 1052, 1053, 1054, 1055, 1056, 1092, 1050, 1051, 1164, 1165, 1147, 1148, 1149, 1155, 1160]],
	['blink blocks', [411, 412, 413, 414, 460, 1519]], ['secrets 50/243', [50, 243]], ['fire 368', [368]],
	['spikes', [361, 1580, 1625, 1626, 1627, 1628, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636]], ['checkpoint 360', [360]],
	['coins 100/101', [100, 101]], ['coins stored collected 110/111', [110, 111]], ['portals 242', [242]], ['invisible portals 381', [381]],
	['dots 4/414', [4, 414]], ['arrows', [1, 2, 3, 1518]], ['music 77/83/1520', [77, 83, 1520]], ['keyboard-only 1516/374/466', [1516, 374, 466]],
];
const coverage = GROUPS.map(() => ({ present: 0, walk: 0, warp: 0, synthPresent: 0, synthWalk: 0, synthWarp: 0 }));
const eventTotals = new Map();
let randomDrawLevels = 0, randomLevels = 0;

// ---------------------------------------------------------------- per level
function fuzzLevel(entry) {
	const T0 = Date.now();
	cur = { name: entry.name, fails: 0 };
	console.log(`\n== ${entry.name}${entry.note ? `  (${entry.note})` : ''}`);
	let p, json;
	try { p = V.readEelvl(entry.buf); json = V.toSimLevel(p, { id: slug(entry.name), file: entry.name }); } catch (e) { ok(false, 'readEelvl / toSimLevel', firstLines(e)); return; }
	const ticks = entry.ticks || TICKS;
	const variants = entry.variants || MODES.map((m) => ({ name: m, opts: { start: m } }));
	const bases = [];
	for (const v of variants) {
		try { bases.push({ v, L: E.prepareLevel(json, v.opts) }); } catch (e) { ok(false, `prepareLevel [${v.name}]`, firstLines(e)); }
	}
	if (!bases.length) return;
	const L0 = bases[0].L, W = L0.width;
	const specials = specialsOf(L0);
	const present = new Set(L0.fg);
	let nPortals = 0; for (let i = 0; i < L0.portalSlot.length; i++) if (L0.portalSlot[i] >= 0) nPortals++;
	console.log(`   ${L0.width}x${L0.height}, gravity ${L0.gravityMult}, ${L0.spawnsX.length} spawn(s), ${nPortals} portals${L0.multiTargetPortals ? ' (random exits)' : ''}, ` +
		`${L0.coinTiles.length} coins, time doors ${L0.hasTimeDoors ? 'yes' : 'no'}, ${specials.size} special block ids`);
	if (L0.multiTargetPortals) randomLevels++;
	// rng scripts per run (shared by the start modes): walk run 0 = [] (the app's default when a TAS uses no random
	// portal: every draw past the end -> rngNeed, exit 0), other walks = null (Godot PCG), warp runs = a random script
	const lrnd = mulberry32(strSeed(entry.name + '|script'));
	let maxN = 1; for (const v of L0.portalsById.values()) if (v.n > maxN) maxN = v.n;
	const isWarp = (r) => r >= RUNS - WARP_RUNS;
	const scripts = [];
	for (let r = 0; r < RUNS; r++) {
		if (!L0.multiTargetPortals) scripts.push(null);
		else if (isWarp(r)) { const s = []; const n = Math.floor(lrnd() * 400); for (let i = 0; i < n; i++) s.push(lrnd() < 0.05 ? maxN + 2 : Math.floor(lrnd() * maxN)); scripts.push(s); }
		else scripts.push(r === 0 ? [] : null);
	}
	const K = { kmap: new Map(), hmap: new Map(), relmap: new Map(), relBad: null, pairs: [[], [], []], seen: [0, 0, 0], keyHashBad: null, collision: null,
		rnd: mulberry32(strSeed(entry.name + '|pairs')) };
	const runs = [], walks = new Map(), touchedWalk = new Set(), touchedWarp = new Set(), pool = [], poolCtx = new Set();
	let draws = 0, restoredTicks = 0, snapCount = 0, rngTreeDone = null;
	for (const { v, L } of bases) {
		for (let r = 0; r < RUNS; r++) {
			const warp = isWarp(r);
			const Ls = withScript(L, scripts[r]);
			const rnd = mulberry32(strSeed(`${entry.name}|${v.name}|${r}`));
			const ctxBase = { file: entry.file || entry.name, mode: v.name, run: r, script: scripts[r] };
			let gen;
			try { gen = generate(Ls, ticks, rnd, warp, specials); } catch (e) { ok(false, `[${v.name}] run ${r}: exception during the playthrough`, firstLines(e, 4)); continue; }
			const ctx = Object.assign({}, ctxBase, { masks: gen.masks, warps: gen.warps });
			const run = { g: runs.length, mode: v.name, r, L: Ls, masks: gen.masks, warps: gen.warps, warpFrom: gen.warps.size ? Math.min(...gen.warps.keys()) : Infinity };
			ok(!gen.mismatch, `[${v.name}] run ${r}: a segment replayed after restore() equals its trial`, gen.mismatch &&
				`tick ${gen.mismatch.t} (segment from tick ${gen.mismatch.segStart})`, gen.mismatch ? Object.assign({}, ctx, { upto: gen.mismatch.t }) : null);
			let R;
			try { R = straight(Ls, run, rnd); } catch (e) { ok(false, `[${v.name}] run ${r}: exception in the straight replay`, firstLines(e, 4), ctx); continue; }
			let d = -1;
			for (let t = 0; t <= ticks; t++) if (gen.fp[t] !== R.fp[t] || gen.hash[t] !== R.hash[t]) { d = t; break; }
			let why = '';
			if (d >= 0) {
				try {
					const g2 = generate(Ls, ticks, mulberry32(strSeed(`${entry.name}|${v.name}|${r}`)), warp, specials, d);
					const s2 = simAt(Ls, run, d);
					why = `first difference at tick ${d}: ${diffDump(g2.stopDump || {}, dump(s2)).slice(0, 8).join('; ')}`;
				} catch (e) { why = `first difference at tick ${d}`; }
			}
			ok(d < 0, `[${v.name}] run ${r}: ${ticks} ticks${warp ? ` with ${gen.warps.size} warps` : ''}: generation (with ~3 restores per segment, events off) = ` +
				'straight replay (fresh sim, events on), every field', why, d >= 0 ? Object.assign({}, ctx, { upto: d, at: d }) : null);
			ok(!R.drawBad, `[${v.name}] run ${r}: ${R.draws.length} random draws take the exits the rng script names`, R.drawBad, R.drawBad ? ctx : null);
			ok(!R.hashStable, `[${v.name}] run ${r}: stateHash / stateKey are pure (the coin-blind hash leaves no trace)`, R.hashStable);
			draws += R.draws.length;
			snapCount += R.snaps.size;
			try { restoredTicks += restoreChecks(Ls, run, R, rnd, ctx); } catch (e) { ok(false, `[${v.name}] run ${r}: exception in the restore checks`, firstLines(e, 4), ctx); }
			if (r === 0) {
				// the level JSON round trip (what importJob writes and every tool loads) and loadEelvlLevel simulate identically
				const alts = [['JSON round trip', () => E.prepareLevel(JSON.parse(JSON.stringify(json)), v.opts)]];
				if (entry.file) alts.push(['loadEelvlLevel', () => V.loadEelvlLevel(entry.file, v.opts)]);
				for (const [label, mk] of alts) {
					let bad = null;
					try {
						const La = withScript(mk(), scripts[r]);
						const s = new E.EESim(La), inp = new E.EEInput();
						if (s.stateHash() !== R.hash[0]) bad = 'start state differs';
						for (let t = 0; t < ticks && !bad; t++) { if (run.warps.has(t)) applyWarp(s, run.warps.get(t)); E.applyMask(inp, run.masks[t]); s.tick(inp); if (s.stateHash() !== R.hash[t + 1]) bad = `differs at tick ${t + 1}`; }
					} catch (e) { bad = firstLines(e); }
					ok(!bad, `[${v.name}] ${label} simulates run 0 identically`, bad, bad ? ctx : null);
				}
				walks.set(v.name, gen.masks);
				if (L0.multiTargetPortals && !rngTreeDone && R.draws.length && !ENGINE) {   // (rng.js plays with src/eesim.js)
					try { rngTreeDone = rngTree(Ls, gen.masks, R.draws); } catch (e) { rngTreeDone = { bad: firstLines(e) }; }
					if (rngTreeDone) ok(!rngTreeDone.bad, `rng.js outcome tree over the first draws of [${v.name}] run 0: ${rngTreeDone.plays} plays, ${rngTreeDone.leaves} leaves` +
						`${rngTreeDone.truncated ? ' (capped)' : ''}; every leaf takes the exits its script names`, rngTreeDone.bad);
				}
			}
			for (const id of R.touched) (warp ? touchedWarp : touchedWalk).add(id);
			for (const [k, n] of R.evCount) eventTotals.set(k, (eventTotals.get(k) || 0) + n);
			const sid = L0.multiTargetPortals ? JSON.stringify(scripts[r]) : 'x';
			addKeys(K, run.g, R, sid);
			runs.push(run);
			// a few real states (mostly just before events / with pending queues) for the per-field key test
			const evT = shuffle([...R.evSnap], rnd).slice(0, 3), rdT = shuffle([...R.snaps.keys()].filter((t) => !R.evSnap.has(t)), rnd).slice(0, 1);
			for (const t of [...evT, ...rdT]) pool.push({ g: run.g, t, snap: R.snaps.get(t), ctx: 'event' });
			// ... and one state from every situation the run met (one-way under the box, dead, thrusting, team change pending, ...)
			for (const [name, arr] of R.ctxSnaps) { const x = arr[arr.length > 1 && rnd() < 0.5 ? 1 : 0]; pool.push({ g: run.g, t: x.t, snap: x.snap, ctx: name }); }
			for (const name of R.ctxSnaps.keys()) poolCtx.add(name);
			R.keys = null; R.snaps = null; R.sim = null;
		}
	}
	if (draws) randomDrawLevels++;
	ok(!K.keyHashBad, `stateKey -> stateHash is a function (${K.kmap.size} distinct keys)`, K.keyHashBad && `run ${K.keyHashBad.g} tick ${K.keyHashBad.t} vs run ${K.keyHashBad.first[0]} tick ${K.keyHashBad.first[1]}`);
	ok(!K.collision, `no stateHash shared by two different keys (${K.hmap.size} hashes)`, K.collision && `run ${K.collision.g} tick ${K.collision.t}`);
	let relWhy = null;
	if (K.relBad) {
		const [ga, ta, gb, tb] = K.relBad;
		try {
			const a = simAt(runs[ga].L, runs[ga], ta), b = simAt(runs[gb].L, runs[gb], tb);
			relWhy = `${runs[ga].mode} run ${runs[ga].r} tick ${ta} vs ${runs[gb].mode} run ${runs[gb].r} tick ${tb}: fields differ in ` +
				`${diffDump(dump(a), dump(b)).slice(0, 10).join('; ')}`;
		} catch (e) { relWhy = `run ${ga} tick ${ta} vs run ${gb} tick ${tb}`; }
	}
	ok(!K.relBad, `states equal up to a clock shift (${K.relmap.size} distinct) have equal stateKeys`, relWhy);
	K.relmap.clear();
	let pf = { n: 0, bad: null, kinds: 0 };
	try { pf = pairFutures(K, runs, mulberry32(strSeed(entry.name + '|future'))); } catch (e) { pf = { n: 0, bad: 'exception: ' + firstLines(e, 4), kinds: 0 }; }
	ok(!pf.bad, `${pf.n} pairs of states with equal keys (of ${K.seen[0]} that differ beyond a clock shift, in ${pf.kinds} kinds of difference; ` +
		`${K.seen[1]} across runs / modes; ${K.seen[2]} later in the same run) have identical futures (${FUTURE} ticks: observable state and events)`, pf.bad);
	K.kmap.clear(); K.hmap.clear();
	let pk;
	try { pk = perturbChecks(pool, runs, mulberry32(strSeed(entry.name + '|perturb'))); } catch (e) { pk = { tried: 0, same: 0, bad: 'exception: ' + firstLines(e, 4) }; }
	ok(!pk.bad, `key completeness per field: ${pool.length} real states (situations: ${[...poolCtx].join(' ') || '-'}) x one field copied from another state: ` +
		`${pk.tried} changes, ${pk.same} left the key unchanged and kept identical futures (${PERTURB_FUTURE} ticks)`, pk.bad);
	if (L0.multiTargetPortals) {
		let pc;
		try { pc = portalChoices(L0); } catch (e) { pc = { tested: 0, noTeleport: 0, bad: firstLines(e, 4) }; }
		ok(!pc.bad, `random portals: ${pc.tested} multi-exit portals x every choice, [] (rngNeed) and out-of-range scripts take the scripted exit` +
			`${pc.noTeleport ? ` (${pc.noTeleport} could not be entered)` : ''}`, pc.bad);
	}
	// 7. the app
	let imp = [];
	if (DO_IMPORT) { try { imp = importChecks(entry, walks); } catch (e) { ok(false, 'import checks', firstLines(e, 4)); } }
	if (DO_APP && walks.size) {
		const m0 = [...walks.keys()][0];
		const w = walks.get(m0).subarray(0, Math.min(ticks, 4000));
		let errs;
		try { errs = appSmoke(json, m0, scripts[0], w); } catch (e) { errs = [firstLines(e, 4)]; }
		ok(errs.length === 0, `app helpers (replay, trajectory, json, align, levelView, where, replayInfo, render) on a ${w.length}-tick walk`, errs.join(' || '));
	}
	// coverage
	GROUPS.forEach(([, ids], gi) => {
		const c = coverage[gi];
		if (!ids.some((id) => present.has(id))) return;
		const hitW = ids.some((id) => touchedWalk.has(id)), hitX = ids.some((id) => touchedWarp.has(id));
		if (entry.synthetic) { c.synthPresent++; if (hitW) c.synthWalk++; if (hitW || hitX) c.synthWarp++; } else { c.present++; if (hitW) c.walk++; if (hitW || hitX) c.warp++; }
	});
	const specialIds = [...specials.keys()];
	const tw = specialIds.filter((id) => touchedWalk.has(id)).length, tx = specialIds.filter((id) => touchedWalk.has(id) || touchedWarp.has(id)).length;
	const impMsg = imp.length ? `; import: ${imp.filter((x) => !x.problem).length}/${imp.length} clean (${imp.filter((x) => x.finished).length} finished)` : '';
	console.log(`   ${runs.length} runs, ${snapCount} snapshots, ${restoredTicks} restored ticks compared, ${pf.n} equal-key pairs, ${draws} random draws; ` +
		`special ids touched: ${tw}/${specialIds.length} walking, ${tx}/${specialIds.length} with warps${impMsg}; ${cur.fails ? cur.fails + ' FAILED' : 'all ok'} ` +
		`(${((Date.now() - T0) / 1000).toFixed(1)} s)`);
	if (VERBOSE && imp.length) for (const x of imp) console.log(`     import [${x.mode}] ${x.label}: ${x.msg}`);
}

// ---------------------------------------------------------------- main
function main() {
	const T0 = Date.now();
	const pos = argv.filter((x) => !x.startsWith('--'));
	const files = [];
	const srcs = pos.length ? pos : [DEFAULT_DIR];
	for (const s of srcs) {
		if (!fs.existsSync(s)) { console.log(`(${s} not found: skipping it)`); continue; }
		if (fs.statSync(s).isDirectory()) for (const f of fs.readdirSync(s).filter((x) => /\.eelvl$/i.test(x)).sort()) files.push(path.join(s, f));
		else files.push(path.resolve(s));
	}
	console.log(`fuzz_levels: ${ENGINE ? `ENGINE ${ENGINE}; ` : ''}${files.length} level file(s)${DO_SYNTH ? ' + synthetic levels' : ''}; ${RUNS} runs x ${TICKS} ticks (${WARP_RUNS} with warps) per start mode ` +
		`[${MODES.join(', ')}]; seed ${SEED}${QUICK ? '; quick' : ''}; import ${DO_IMPORT ? (INPLACE ? 'in place (src/jobs.js)' : 'from a copy of src/ in the temp folder') : 'off'}`);
	const entries = [];
	for (const f of files) entries.push({ name: path.basename(f), file: f, buf: fs.readFileSync(f) });
	if (DO_SYNTH) {
		const a = arenaRecords();
		entries.push({ name: '(synthetic) all-mechanics arena', buf: writeEelvl({ W: a.W, H: a.H, name: 'arena', records: a.records }), synthetic: true,
			note: 'generated; also run with 3 ticks per frame',
			variants: [...MODES.map((m) => ({ name: m, opts: { start: m } })), { name: 'reset-tpf3', opts: { start: 'reset', ticksPerFrame: 3 } }] });
		const a2 = arenaRecords(true);
		entries.push({ name: '(synthetic) arena without time doors', buf: writeEelvl({ W: a2.W, H: a2.H, name: 'arena2', records: a2.records }), synthetic: true,
			note: 'generated; no time doors, so states at any tick can key equal' });
		for (const c of craftedLevels()) entries.push(Object.assign({ synthetic: true }, c));
	}
	const sel = entries.filter((e) => !ONLY || ONLY.split('|').some((s) => e.name.toLowerCase().includes(s)));
	const seenHash = new Map();
	for (const e of sel) {
		const h = require('crypto').createHash('sha1').update(e.buf).digest('hex');
		if (seenHash.has(h)) e.note = (e.note ? e.note + '; ' : '') + `same bytes as ${seenHash.get(h)} (different random runs)`;
		else seenHash.set(h, e.name);
		try { fuzzLevel(e); } catch (err) { ok(false, `${e.name}: unexpected exception in the fuzz itself`, firstLines(err, 5)); }
	}
	if (DO_IMPORT && sel.length) {
		cur = { name: 'import: bad inputs', fails: 0 };
		try { importNegatives(sel.find((e) => e.file) ? sel.find((e) => e.file).buf : sel[0].buf); } catch (e) { ok(false, 'import bad-input cases', firstLines(e, 4)); }
	}
	// summary
	console.log('\n== coverage: block families present / touched walking / touched with warps (sample levels; synthetic levels)');
	GROUPS.forEach(([name], gi) => {
		const c = coverage[gi];
		console.log(`   ${name.padEnd(44)} ${String(c.present).padStart(2)} / ${String(c.walk).padStart(2)} / ${String(c.warp).padStart(2)}    ; ${c.synthPresent} / ${c.synthWalk} / ${c.synthWarp}`);
	});
	console.log(`   levels with random multi-exit portals: ${randomLevels}, of them with random draws in the runs: ${randomDrawLevels}`);
	console.log('   events: ' + [...eventTotals].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
	console.log(`\n${nPass} passed, ${nFail} failed (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
	if (failures.length) {
		console.log('failures:');
		for (const f of failures) console.log(`  - ${f.level}: ${f.what}${f.detail ? '\n      ' + f.detail : ''}${f.repro ? '\n      repro: ' + f.repro : ''}`);
	}
	process.exitCode = nFail ? 1 : 0;
}
main();
