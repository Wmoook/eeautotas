'use strict';
// THE OPEN-AIR ARC TABLES (n4plan part 'primitives'): level-independent summaries of the plain macros (src/plan/prims.js
// MACROS.plain) simulated by the engine in an empty synthetic level (a long floor under the start, walls far away), per
// physics mode and start speed class vx0 (-6.75 .. 6.75 in 1/8 px/tick): for each macro its first landing (or its end):
// [ticks, dx, dy, vx, vy, rise (the most the box rose above its start)]. Candidate generators only: absolute positions
// change the double rounding and the auto-align, so every edge is simulated again from the real state (prims.js); the
// tables order candidates and answer "how far can this jump go" without a simulation.
//   tables.load({modes, build}) -> {key, modes: {mode: {vx0s, macros: [names], rows: Float32Array(nV x nM x 6)}}}
//   tables.predict(T, mode, vx0, macroIndex) -> [ticks, dx, dy, vx, vy, rise]
//   modes: 'plain', 'jump1' (jump effect 1: x 1.3), 'speed1' (speed effect 1: x 1.5), 'lowgrav'
// Cached on disk at os.tmpdir()/eeat_prims/<sha1 of src/eesim.js>.json (never in src/): a changed engine builds anew.
// Built in the calling thread (~1-3 s a mode) or in src/plan/primworker.js threads (buildAsync).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const E = require('../eesim.js');
const EL = require('../eelvl.js');

const VX0 = []; for (let v = -54; v <= 54; v++) VX0.push(v / 8);   // -6.75 .. 6.75
const MODES = ['plain', 'jump1', 'speed1', 'lowgrav'];
const NF = 6;
let engineKey = null;
function keyOf() {
	if (engineKey) return engineKey;
	engineKey = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', 'eesim.js'))).digest('hex').slice(0, 16);
	return engineKey;
}
const cachePath = () => path.join(os.tmpdir(), 'eeat_prims', `${keyOf()}.json`);

/** the empty arena: a 400 x 60 room, the floor at row 50, the start in its middle */
let ARENA = null;
function arena() {
	if (ARENA) return ARENA;
	const W = 400, H = 60, cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, 50, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	cells.push([200, 49, 255]);
	const ED = require('../editor.js');
	ARENA = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'arena', width: W, height: H, cells }))));
	return ARENA;
}

/** one mode's rows: every plain macro from a resting ball with speed vx0 on the floor */
function buildMode(mode, macros) {
	const L = arena();
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let k = 0; k < 30; k++) { E.applyMask(inp, 0); sim.tick(inp); }   // settle on the floor
	if (mode === 'jump1') sim.jump_boost = 1;
	if (mode === 'speed1') sim.speed_boost = 1;
	if (mode === 'lowgrav') sim.low_gravity = true;
	const base = sim.snapshot();
	const rows = new Float32Array(VX0.length * macros.length * NF);
	for (let vi = 0; vi < VX0.length; vi++) {
		sim.restore(base);
		sim.speed_x = VX0[vi];
		const start = sim.snapshot();
		for (let mi = 0; mi < macros.length; mi++) {
			const m = macros[mi];
			sim.restore(start);
			const x0 = sim.px, y0 = sim.py, stt = {};
			let onG = !!sim.on_ground, n = 0, rise = 0;
			for (let k = 0; k < m.max; k++) {
				const mk = m.mask(k, sim, stt);
				if (mk < 0) break;
				E.applyMask(inp, mk); sim.tick(inp); n++;
				if (y0 - sim.py > rise) rise = y0 - sim.py;
				if (!onG && sim.on_ground) break;
				onG = !!sim.on_ground;
			}
			rows.set([n, sim.px - x0, sim.py - y0, sim.speed_x, sim.speed_y, rise], (vi * macros.length + mi) * NF);
		}
	}
	return rows;
}

let LOADED = null;
/** the tables: from the disk cache, else built (o.build !== false) and written there */
function load(o = {}) {
	if (LOADED && !o.fresh) return LOADED;
	const P = require('./prims.js');
	const macros = P.MACROS.plain;
	const names = macros.map((m) => m.name);
	const file = cachePath();
	if (!o.fresh) {
		try {
			const j = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (j.key === keyOf() && JSON.stringify(j.macros) === JSON.stringify(names)) {
				const modes = {};
				for (const [k, v] of Object.entries(j.modes)) modes[k] = { vx0s: VX0, macros: names, rows: Float32Array.from(v) };
				LOADED = { key: j.key, modes, file, cached: true };
				return LOADED;
			}
		} catch (e) { /* none yet */ }
	}
	if (o.build === false) return null;
	const modes = {}, t0 = Date.now();
	for (const mode of o.modes || MODES) modes[mode] = { vx0s: VX0, macros: names, rows: buildMode(mode, macros) };
	LOADED = { key: keyOf(), modes, file, cached: false, ms: Date.now() - t0 };
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const out = { key: keyOf(), macros: names, modes: {} };
		for (const [k, v] of Object.entries(modes)) out.modes[k] = Array.from(v.rows, (x) => Math.round(x * 1e4) / 1e4);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(out));
		fs.renameSync(tmp, file);
	} catch (e) { /* a read-only temp: the tables stay in memory */ }
	return LOADED;
}
/** the row of (mode, vx0 (nearest class), macro index): [ticks, dx, dy, vx, vy, rise] */
function predict(Tb, mode, vx0, mi) {
	const M = Tb.modes[mode] || Tb.modes.plain;
	let vi = Math.round(vx0 * 8) + 54;
	if (vi < 0) vi = 0; else if (vi >= VX0.length) vi = VX0.length - 1;
	const o = (vi * M.macros.length + mi) * NF;
	return Array.from(M.rows.subarray(o, o + NF));
}
/** the mode of a state (the plain family's physics) */
const modeOf = (sim) => (sim.jump_boost === 1 ? 'jump1' : sim.speed_boost === 1 ? 'speed1' : sim.low_gravity ? 'lowgrav' : 'plain');

module.exports = { load, predict, modeOf, buildMode, VX0, MODES, cachePath, keyOf };
