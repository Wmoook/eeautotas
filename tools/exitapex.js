'use strict';
// tools/exitapex.js: the engine-measured field transit tables of the reach model's ORDERING fields (src/reach.js
// opts.exitApex, the n3 rise-exit-apex fix; src/exitapex.json, checked in: generic physics, no level data).
//
// The reach model's C state (a rising ball in a field tile: dots / side arrows / side boosts, climbables, water, mud /
// lava, up arrows) keeps the speed it came in with: every row up a field keeps it (vfieldP never lowers it), and a ball
// that leaves a field keeps it too, so the ordering fields "pumped" a ball up a field column and the air beside it
// (Happy Spookaween: a 6-tile chain lifts a jump 24 rows; Barrel Cannon Canyon: a dot rail to 16 px/tick; Cold World: a
// jump through 4 rows of water and a one-way row). In the engine a climbable's tick multiplies the speed by BASE_DRAG x
// NO_MOD_DRAG (0.888), water's by x 0.934 and mud's by x 0.886, whatever the speed. These tables are that physics,
// measured with the engine itself (src/eesim.js, one tick at a time), per field class (reach.js classOfId) as the max
// over every block id of the class:
//   up[c]   a ball whose centre crosses a field row's BOTTOM edge going up with speed <= c / 8 px/tick: the speed of the
//           tick whose move takes it over that row's TOP edge (the model's C level: the speed at the row's top edge);
//   in[c]   a ball whose centre is ANYWHERE in a field row with speed <= c / 8 when its first tick there starts (it came
//           from the air beside or below; any gravity queue): the same, its speed at the row's top edge;
//   exit[c] a ball whose centre crosses a field row's TOP edge into the air above with speed <= c / 8 (the queue the
//           field's own): the highest its centre then gets above that edge, px (the model's Pexit = v + the rise table).
// Exhaustive over the grid: every speed class c (0..127, 127 = 16 px/tick, the engine's cap) at SUB speeds in
// ((c - 1) / 8, c / 8], PH sub-pixel phases of the centre (in the row, or past the crossed edge by up to one tick's
// move), every input mask (up / down / none x left / right / none x jump or not: 18), and for in[] the gravity queues
// air / field / mixed; then a running max over c (the tables are upper bounds for every speed up to c / 8).
// Measured (2026-09-29): exit[] = the model's Pexit within 0.1 px (water 1-3 px lower): the exit apex was never the
// loose part; up[] and in[] are (a climbable from 7.6 px/tick at a row's bottom edge: 6.25 at its top, water 7.0, mud
// 5.75; dots and up arrows = the model's energy bound within 0.25 px/tick).
// usage: node tools/exitapex.js [--out=src/exitapex.json] [--check] (--check: regenerate and compare with the file:
// exit 1 when they differ, e.g. after an engine change)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const R = require('../src/reach.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const OUT = arg('out', path.join(__dirname, '..', 'src', 'exitapex.json'));
const CHECK = argv.includes('--check');
const SUB = 4, PH = 16, MAXT = 600;
const NL = R.NL;
const MASKS = [];
for (const v of [0, 8, 16]) for (const h of [0, 2, 4]) for (const j of [0, 1]) MASKS.push(v | h | j);
const CLASSES = { [R.DOTS]: 'dots', [R.CLIMB]: 'climb', [R.WATER]: 'water', [R.MUD]: 'mud', [R.UP]: 'up' };

const W = 44, H = 76, TOP = 50;   // the exit level: field rows TOP..H-2, air above
/** a level of walls around, the field block id K in rows y0..H-2 (y0 1: all field), a spawn in the corner */
function levelOf(K, y0) {
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 1; y < H - 1; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	for (let y = y0; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (!(x === 1 && y === 1)) cells.push([x, y, K]);
	cells.push([1, 1, 255]);
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'exitapex', width: W, height: H, cells }))));
}
const XC = (W >> 1) * 16;   // the box's left edge: its centre in the middle column
function start(sim, cy, s, q0, q1) {
	sim.reset();
	sim.px = XC; sim.py = cy - 8; sim.speed_x = 0; sim.speed_y = -s; sim._q0 = q0; sim._q1 = q1; sim._slippery = 0;
}
/** the upward move speed of the tick that takes the centre out of row r through its top edge (0: it leaves the row
 *  another way, or not at all) */
function rowCross(sim, inp, mask, r) {
	for (let n = 0; n < MAXT; n++) {
		if ((Math.trunc(sim.py + 8) >> 4) !== r || sim.is_dead) return 0;
		E.applyMask(inp, mask);
		sim.tick(inp);
		if (sim.is_dead) return 0;
		const r2 = Math.trunc(sim.py + 8) >> 4;
		if (r2 < r) return -sim.speed_y;
		if (r2 > r) return 0;
	}
	return 0;
}
/** the highest the centre gets above y = edge (px) until its speed turns down */
function apexOver(sim, inp, mask, edge) {
	let top = sim.py + 8;
	for (let n = 0; n < MAXT && !sim.is_dead; n++) {
		E.applyMask(inp, mask);
		sim.tick(inp);
		if (sim.is_dead) break;
		if (sim.py + 8 < top) top = sim.py + 8;
		if (sim.speed_y >= 0) break;
	}
	return edge - top;
}
const speedsOf = (c) => { if (c === 0) return [0]; const hi = c >= NL - 1 ? 16 : c / 8, lo = (c - 1) / 8; const a = []; for (let k = 0; k < SUB; k++) a.push(hi - (hi - lo) * k / SUB); return a; };
const runMax = (a) => { for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) a[i] = a[i - 1]; return a; };

/** the engine's values of block id K at the speed classes cs (default all; raw: no running max, speeds not rounded) */
function measure(K, cs) {
	const Lf = levelOf(K, 1), Lx = levelOf(K, TOP);
	const sf = new E.EESim(Lf), sx = new E.EESim(Lx), inp = new E.EEInput();
	const r = H - 12;   // the measured row of the all-field level (rows below and above it field too)
	const up = [], inn = [], exit = [];
	for (const c of cs || [...Array(NL).keys()]) {
		let mu = 0, mi = 0, me = 0;
		for (const s of speedsOf(c)) {
			for (let j = 1; j <= PH; j++) {
				const phi = s > 0 ? Math.min(15.99, s * j / PH) : 1e-6 * j;   // past the crossed edge by up to one move
				for (const m of MASKS) {
					// up: just over the bottom edge of row r, the queue the field's own
					start(sf, 16 * (r + 1) - phi, s, K, K);
					const a = rowCross(sf, inp, m, r);
					if (a > mu) mu = a;
					// exit: just over the top edge of the field (row TOP) into the air
					start(sx, 16 * TOP - phi, s, K, K);
					const e = apexOver(sx, inp, m, 16 * TOP);
					if (e > me) me = e;
				}
			}
			for (let j = 0; j < PH; j++) {
				const cy = 16 * r + (j + 0.5) * 16 / PH;   // anywhere in the row
				for (const [q0, q1] of [[0, 0], [K, K], [0, K], [K, 0]]) {
					for (const m of MASKS) {
						start(sf, cy, s, q0, q1);
						const a = rowCross(sf, inp, m, r);
						if (a > mi) mi = a;
					}
				}
			}
		}
		up.push(mu); inn.push(mi); exit.push(me);
	}
	return { up, in: inn, exit };
}

function build() {
	const t0 = Date.now();
	const probe = levelOf(0, TOP);
	const flags = R.guideFlags(probe), gMox = probe.gMox, gMoy = probe.gMoy;
	// the ids of each field class, grouped by what the engine does with them as the current (and delayed) tile
	const groups = new Map();
	for (let id = 0; id < flags.length; id++) {
		const cl = R.classOfId(flags, gMox, gMoy, id);
		if (!(cl in CLASSES)) continue;
		if (probe.gFlags[id] & 4) continue;   // (a killer: DEADLY in the field, not a field tile)
		const special = [4, 414, 114, 115, 116, 117, 119, 369, 416, 1585].includes(id) ? id : -1;
		const key = [cl, special, flags[id] & 96, gMox[id], gMoy[id], probe.gMorx[id], probe.gMory[id], probe.gFlags[id]].join('|');
		if (!groups.has(key)) groups.set(key, { cl, ids: [] });
		groups.get(key).ids.push(id);
	}
	const kinds = {};
	for (const g of groups.values()) {
		const m0 = measure(g.ids[0]), m = { up: runMax(m0.up), in: runMax(m0.in), exit: runMax(m0.exit) };
		const k = kinds[g.cl] || (kinds[g.cl] = { name: CLASSES[g.cl], ids: [], up: new Array(NL).fill(0), in: new Array(NL).fill(0), exit: new Array(NL).fill(0) });
		k.ids.push(...g.ids);
		for (let c = 0; c < NL; c++) { k.up[c] = Math.max(k.up[c], m.up[c]); k.in[c] = Math.max(k.in[c], m.in[c]); k.exit[c] = Math.max(k.exit[c], m.exit[c]); }
		process.stderr.write(`[exitapex] class ${CLASSES[g.cl]} ids ${g.ids.slice(0, 8).join(',')}${g.ids.length > 8 ? ',..' : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
	}
	const out = { version: 1, generator: 'tools/exitapex.js', engine: crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'eesim.js'))).digest('hex').slice(0, 12), NL, sub: SUB, phases: PH, masks: MASKS.length, kinds: {} };
	for (const cl of Object.keys(kinds).sort((a, b) => a - b)) {
		const k = kinds[cl];
		out.kinds[cl] = { name: k.name, ids: k.ids.sort((a, b) => a - b), up: k.up.map((v) => R.cOfV(v)), in: k.in.map((v) => R.cOfV(v)), exit: k.exit.map((v) => Math.ceil(v * 16) / 16) };
	}
	return out;
}

module.exports = { measure, build, MASKS };
if (require.main !== module) return;
const tab = build();
const text = JSON.stringify(tab).replace(/"kinds":\{/, '"kinds":{\n').replace(/\},"(\d)":/g, '},\n"$1":');
if (CHECK) {
	let old = null;
	try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* none */ }
	const same = old !== null && JSON.stringify(old.kinds) === JSON.stringify(tab.kinds);
	console.log(same ? `exitapex: ${OUT} = the engine's tables` : `exitapex: ${OUT} DIFFERS from the engine's tables (run node tools/exitapex.js)`);
	process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, text + '\n');
console.log(`exitapex: ${OUT} (${Object.values(tab.kinds).map((k) => `${k.name} ${k.ids.length} ids`).join(', ')})`);
