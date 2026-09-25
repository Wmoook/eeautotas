'use strict';
const HOMEP = (p) => require('path').join(require('os').homedir(), p);
// test/review.js - the review suite: the checks written while reviewing src/eesim.js, src/eelvl.js and the app against
// eeo-tas (its AS3 source, eeo-tas/src, is the ground truth), in one file. Sections (--only=a,b,...):
//   music    a piano / drum / guitar block whose number has no sound (piano outside -27..60, drums 0..19, guitar
//            0..48) throws RangeError in Me.touchBlock (SoundManager.as:402-414); nothing catches it, so the rest of
//            every tick that starts in that cell is skipped: pastx / pasty, updateThrust, the auto-align, the run timer
//            (updateStuff) and that frame's PlayState.enterFrame (queue drains)
//   portals  the AS3 portalLookup (World.as:349-352, Lookup.as:135-171): a background (layer-1) portal record and a
//            stale entry under another block are exits, a layer-1 record replaces a portal's arguments (last write
//            wins), and a coin pickup deletes the entry at its cell for good (setTileComplex -> deleteLookup)
//   keys     stateKey / stateHash: the variable part (switch on-sets, queues) decodes uniquely for any int32 switch
//            number; a switch map with nothing on keys like no map
//   fuzz     snapshot / restore / stateKey / stateHash on "kitchen sink" levels with every block family (also music
//            blocks without a sound, background / stale portal entries and portal entries on coin cells):
//              A. snapshots restored in random order (also into a 2nd sim) continue with an identical full state
//              B. every field stateKey() leaves out is perturbed: equal keys must mean identical futures
//              C. states reached by different histories grouped by key: identical futures; hash equal iff key equal
//   real     the two real eeo-tas runs (local files, read in place, never copied): Forgotten Veil (run_ticks 11527) and
//            Infinity Pain (complete tick 41277, run_ticks 41276, 0 deaths), plus the A / B fuzz along their inputs
//   drag     the 8 drag constants (Config.as:47-55 pow(x, 10) * 1.00016093): which pow they are (informational)
//   app      jobs.js / server.js / grind.js / render.js / common.js in a temp copy of src/ (no job ever appears in the
//            real app): import limits and messages, the Finish report, where, probe / render / try limits, focus
//            ranges, HTTP errors (upload limit, JSON null, render margin), the viewer's data and page script, EE
//            graphics (src/eegfx.js on a tiny fake eeo-tas: the sprite map, sheet whitelist, folder checks), the inbox
//            verdict of a slower run
// usage: node test/review.js [--quick] [--seed=N] [--only=music,portals,keys,fuzz,real,drag,app] [--case=ks1]
// Exit code 1 if any check fails. Node built-ins only; writes nothing inside the repo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const Module = require('module');
const { spawn } = require('child_process');
const E = require('../src/eesim.js');
const V = require('../src/eelvl.js');

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SEED0 = +opt('seed', '1');
const ONLY = opt('only', '').split(',').filter(Boolean);
const want = (s) => ONLY.length === 0 || ONLY.includes(s);
const CASE = opt('case', '');
const SRC = path.resolve(__dirname, '..', 'src');
const REAL = [
	{ name: 'Forgotten Veil', level: process.env.EEAT_FV_LEVEL || HOMEP('3d33/levels/forgotten_veil.eelvl'), tas: process.env.EEAT_FV_TAS || HOMEP('3d33/levels/tas/forgotten_veil.eetas'),
		complete: 11539, runTicks: 11527, deaths: 0 },
	{ name: 'Infinity Pain', level: process.env.EEAT_IP_LEVEL || HOMEP('Downloads/Infinity Pain - kiraninja - PWE7zf-vf9cEI.eelvl'), tas: process.env.EEAT_IP_TAS || HOMEP('Downloads/IP_Final.eetas'),
		complete: 41277, runTicks: 41276, deaths: 0 },
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
function section(s) { console.log(`\n== ${s}`); }
function rngOf(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); }
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
const cellOf = (sim) => ({ x: Math.trunc(sim.px + 8) >> 4, y: Math.trunc(sim.py + 8) >> 4 });

// ---------------------------------------------------------------- tiny levels
/**
 * toSimLevel-format JSON: W x H, border of 9, floor row y = H - 2 (with H = 7 the ball walks on row 4, py = 64);
 * tiles [[x, y, id, int?]] (the int goes to extras and lookup_int like toSimLevel exports it); spawns [[x, y]].
 */
function mkJson({ W = 16, H = 7, tiles = [], spawns = [[2, 4]] } = {}) {
	const fg = new Int32Array(W * H);
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; fg[(H - 2) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	const extras = [], li = [];
	for (const [x, y, id, arg] of tiles) {
		fg[y * W + x] = id;
		if (arg !== undefined) { extras.push([y * W + x, arg, null, null]); li.push([y * W + x, arg]); }
	}
	return { format: 'eesim-level-1', level_id: 'review', width: W, height: H, gravity_hex: f64hex(1), gravity: 1,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras, lookup_int: li, spawn_points: [spawns] };
}
const mkLevel = (o, opts) => E.prepareLevel(mkJson(o), opts);

/** A minimal .eelvl writer (raw deflate, header + records in World.deserializeFromMessage's format). */
function writeEelvl({ W, H, records, name = 'review', gravity = 1 }) {
	const utf = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
	const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
	const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
	const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
	const bool = (v) => Buffer.from([v ? 1 : 0]);
	const us = (arr) => { const b = Buffer.alloc(4 + 2 * arr.length); b.writeUInt32BE(2 * arr.length); arr.forEach((v, k) => b.writeUInt16BE(v, 4 + 2 * k)); return b; };
	const parts = [utf('review'), utf(name), i32(W), i32(H), f32(gravity), u32(0), utf(''), bool(false), utf(''), utf(''), i32(0), bool(true), utf('')];
	for (const r of records) {
		parts.push(i32(r.id), i32(r.layer || 0), us(r.xs), us(r.ys));
		for (const a of r.args || []) parts.push(typeof a === 'string' ? utf(a) : i32(a));
	}
	return zlib.deflateRawSync(Buffer.concat(parts));
}
/** block-9 records: the border of a W x H level, and (floorY) a floor row */
function wallRecords(W, H, floorY) {
	const xs = [], ys = [];
	for (let x = 0; x < W; x++) { xs.push(x, x); ys.push(0, H - 1); if (floorY !== undefined) { xs.push(x); ys.push(floorY); } }
	for (let y = 1; y < H - 1; y++) { xs.push(0, W - 1); ys.push(y, y); }
	return [{ id: 9, xs, ys }];
}
const loadRecords = (W, H, records, opts) => E.prepareLevel(V.toSimLevel(V.readEelvl(writeEelvl({ W, H, records }))), opts);

// ================================================================ music
function musicSection() {
	section('music: a piano / drum / guitar number without a sound aborts the tick (Me.as:131-149, SoundManager.as:402-414)');
	// 1. purple switch #0 at (4,4), the block at (5,4), a wall at (6,4): hold right until the tick-start cell is the
	// block, then left back onto the switch. eeo-tas keeps pastx = 4 through every aborted tick, so re-entering (4,4)
	// is not a new cell: the switch is not pressed again, and the run timer skips the aborted ticks.
	function run(note) {
		const L = mkLevel({ tiles: [[4, 4, 113, 0], [5, 4, 77, note], [6, 4, 9], [6, 3, 9], [6, 2, 9], [6, 1, 9]] });
		const sim = new E.EESim(L);
		const inp = new E.EEInput();
		let phase = 0, pianoTicks = 0, pressedOn = false, aborted = 0;
		const pastDuring = new Set();
		sim.onEvent = (k) => { if (k === 'tick_aborted') aborted++; };
		for (let t = 1; t <= 300; t++) {
			const cx = cellOf(sim).x;
			if (phase === 0 && cx === 5) phase = 1;
			if (phase === 1 && cx === 4) phase = 2;
			E.applyMask(inp, phase === 0 ? 4 : 2);
			sim.tick(inp);
			if (cx === 5) { pianoTicks++; pastDuring.add(sim._pastx); }
			if (sim.is_switch_on(0)) pressedOn = true;
			if (phase === 2) break;
		}
		return { switchOn: sim.is_switch_on(0), pressedOn, pianoTicks, pastDuring: [...pastDuring].join(','), runTicks: sim.run_ticks, aborted };
	}
	const bad = run(61), good = run(60);
	check(`piano #61 (61 + 27 = 88: no such sound): pastx stays 4 through the ${bad.pianoTicks} ticks in the piano cell (each one aborts), so the ` +
		'switch cell is not new when re-entered and the switch stays on', bad.pressedOn && bad.switchOn && bad.pastDuring === '4' && bad.pianoTicks > 0 &&
		bad.aborted === bad.pianoTicks, JSON.stringify(bad));
	check('piano #60 (a sound): no abort, re-entering the switch presses it again (off)', good.pressedOn && !good.switchOn && good.aborted === 0, JSON.stringify(good));
	check(`the run timer (Me.ticks) skips the aborted ticks: ${bad.runTicks} = ${good.runTicks} - ${bad.pianoTicks}`,
		good.pianoTicks === bad.pianoTicks && bad.runTicks === good.runTicks - bad.pianoTicks);

	// 2. the valid numbers per block (the Vectors have 88 / 20 / 49 sounds; piano reads [n + 27])
	const cases = [[77, -28, false], [77, -27, true], [77, 0, true], [77, 60, true], [77, 61, false], [77, 2147483647, false], [77, -2147483648, false],
		[83, -1, false], [83, 0, true], [83, 19, true], [83, 20, false], [1520, -1, false], [1520, 0, true], [1520, 48, true], [1520, 49, false]];
	const wrong = [];
	for (const [id, n, valid] of cases) {
		const sim = new E.EESim(mkLevel({ tiles: [[5, 4, id, n]] }));
		const inp = new E.EEInput();
		const ev = [];
		sim.onEvent = (k, d) => { if (k === 'tick_aborted' || k === 'piano' || k === 'drum' || k === 'guitar') ev.push(`${k}:${k === 'tick_aborted' ? d.reason + ':' : ''}${d.note}`); };
		for (let t = 0; t < 40; t++) { E.applyMask(inp, 4); sim.tick(inp); }
		const kind = id === 77 ? 'piano' : id === 83 ? 'drum' : 'guitar';
		const ok = valid ? ev.length === 1 && ev[0] === `${kind}:${n}` : ev.length >= 2 && ev.every((e) => e === `tick_aborted:${kind}:${n}`);
		if (!ok) wrong.push(`${id} #${n}: ${ev.join(' ') || 'no event'}`);
	}
	check('valid numbers: piano -27..60, drums 0..19, guitar 0..48 (one sound event on entry); any other number aborts EVERY tick that starts in ' +
		'the cell (pastx never becomes the cell)', wrong.length === 0, wrong.join('; ') || `${cases.length} cases`);

	// 3. what an aborted tick skips: the ball placed with its tick-start cell on the block (at rest, px 1 past the
	// tile edge: the auto-align would pull it), levitation with thrust 0.2, the run timer running, and an orange switch
	// press waiting in PlayState.queue (a retry of the per-frame queue)
	function probe(note) {
		const sim = new E.EESim(mkLevel({ tiles: [[5, 4, 77, note]] }));
		const inp = new E.EEInput();
		sim.px = 81; sim.py = 64; sim.speed_x = 0; sim.speed_y = 0;
		sim.has_levitation = true; sim._current_thrust = 0.2; sim.is_thrusting = false;
		sim.run_ticks = 10;
		sim._stateQueue.push(2, 9, 1);   // SQ_ORANGE: press orange switch 9 on
		const past0 = sim._pastx;
		E.applyMask(inp, 0); sim.tick(inp);
		const r = { pastSame: sim._pastx === past0, pastx: sim._pastx, px: sim.px, thrust: sim._current_thrust, sy: sim.speed_y, run: sim.run_ticks,
			queue: sim._stateQueue.length, orange9: sim.is_orange_switch_on(9), ground: sim.on_ground };
		// the next tick starts in the same cell again (the box barely moved), then one from another cell
		E.applyMask(inp, 0); sim.tick(inp);
		r.queue2 = sim._stateQueue.length;
		sim.px = 8 * 16; sim.py = 64;
		E.applyMask(inp, 0); sim.tick(inp);
		r.queue3 = sim._stateQueue.length; r.orange9after = sim.is_orange_switch_on(9);
		return r;
	}
	const A = probe(99), B = probe(12);
	check('an aborted tick leaves pastx, px (no auto-align), the thrust and speed (no updateThrust) and the run timer, and PlayState.queue is not ' +
		'drained after it (no enterFrame in that frame); on_ground still follows the movement', A.pastSame && A.px === 81 && A.thrust === 0.2 && A.sy === 0 &&
		A.run === 10 && A.queue === 3 && !A.orange9 && A.ground, JSON.stringify(A));
	check('the next tick in the cell aborts again (queue still waiting); a tick from another cell drains it', A.queue2 === 3 && A.queue3 === 0 && A.orange9after,
		JSON.stringify({ queue2: A.queue2, queue3: A.queue3, orange9: A.orange9after }));
	check('the same tick with a sound (#12) does all of it: pastx 5, auto-align, thrust 0.19, the run timer, the drain', B.pastx === 5 && B.px < 81 &&
		Math.abs(B.thrust - 0.19) < 1e-12 && B.sy < 0 && B.run === 11 && B.queue === 0 && B.orange9, JSON.stringify(B));
	// 4. god mode: the sound is played whatever the mode (`if (isme)`, before the `if (!isgodmode)` switch)
	const g = new E.EESim(mkLevel({ tiles: [[5, 4, 83, 25]] }));
	const gi = new E.EEInput();
	g.set_god_mode(true);
	let gAb = 0;
	g.onEvent = (k) => { if (k === 'tick_aborted') gAb++; };
	g.px = 81; g.py = 64;
	E.applyMask(gi, 0); g.tick(gi);
	check('in god mode too', gAb === 1 && g.run_ticks === 0, `aborts ${gAb}`);
}

// ================================================================ portals
function portalsSection() {
	section('portals: every portalLookup entry is an exit; a coin pickup deletes the entry at its cell');
	const W = 16, H = 7;
	const base = [...wallRecords(W, H, 5), { id: 255, xs: [2], ys: [4] }];
	const A = (id, target, rot = 0) => ({ id: 242, xs: [5], ys: [4], args: [rot, id, target] });
	/** hold right from the spawn; the first portal event, and the tick whose start cell was portal A (5,4) */
	function walk(L, n, script) {
		const lv = script ? Object.assign({}, L, { rngScript: Int32Array.from(script) }) : L;
		const sim = new E.EESim(lv);
		const inp = new E.EEInput();
		let ev = null, atA = -1;
		sim.onEvent = (k, d) => { if (k === 'portal' && !ev) ev = { t: sim.ticks(), from: d.from, to: d.to }; };
		for (let t = 1; t <= n && !ev; t++) {
			const c = cellOf(sim);
			E.applyMask(inp, 4); sim.tick(inp);
			if (atA < 0 && c.x === 5 && c.y === 4) atA = t;
		}
		return { ev, atA, sim };
	}
	const dest = (r) => (r.ev ? `(${r.ev.to.x},${r.ev.to.y}) at tick ${r.ev.t}` : 'no teleport');
	// 1. a background (layer-1) portal record is an exit (World.as:349-352 has no layer test)
	const L1 = loadRecords(W, H, [...base, A(1, 2), { id: 242, layer: 1, xs: [10], ys: [2], args: [0, 2, 1] }]);
	const r1 = walk(L1, 120);
	check('a layer-1 portal record (id 2 at (10,2)) is an exit: entering portal A (target 2) teleports there', r1.ev && r1.ev.t === r1.atA && r1.ev.to.x === 10 &&
		r1.ev.to.y === 2 && Math.abs(r1.sim.px - 160) < 16, dest(r1));
	// 2. position keyed, last write wins: a layer-1 record on A's cell replaces A's id / target / rotation
	const exits = [{ id: 242, xs: [10], ys: [2], args: [0, 2, 2] }, { id: 242, xs: [12], ys: [2], args: [0, 4, 4] }];
	const over = { id: 242, layer: 1, xs: [5], ys: [4], args: [0, 3, 4] };
	const r2a = walk(loadRecords(W, H, [...base, A(1, 2), ...exits, over]), 120);
	const r2b = walk(loadRecords(W, H, [...base, over, A(1, 2), ...exits]), 120);
	check('a later layer-1 record on portal A\'s cell replaces its arguments: A (now id 3, target 4) goes to (12,2)', r2a.ev && r2a.ev.to.x === 12 && r2a.ev.to.y === 2, dest(r2a));
	check('an earlier layer-1 record is replaced by A\'s own (target 2): A goes to (10,2)', r2b.ev && r2b.ev.to.x === 10 && r2b.ev.to.y === 2, dest(r2b));
	// 3. a stale entry: the portal record at (10,2) is overwritten by another block (0 here); its entry stays an exit
	const L3 = loadRecords(W, H, [...base, A(1, 2), { id: 242, xs: [10], ys: [2], args: [0, 2, 2] }, { id: 0, xs: [10], ys: [2] }]);
	const r3 = walk(L3, 120);
	check('a stale portal entry (its tile overwritten by a later record) is still an exit', r3.ev && r3.ev.to.x === 10 && r3.ev.to.y === 2 && L3.fg[2 * W + 10] === 0, dest(r3));
	// 4. coin pickups: exits of id 2 = a background record under a coin at (10,2) and a portal at (12,2)
	const coinRecs = [A(1, 2), { id: 100, xs: [10], ys: [2] }, { id: 242, layer: 1, xs: [10], ys: [2], args: [0, 2, 2] }, { id: 242, xs: [12], ys: [2], args: [0, 2, 2] }];
	const L4 = loadRecords(W, H, [...base, ...coinRecs]);
	const t2 = L4.portalsById.get(2);
	check('exits of id 2: the coin cell (10,2) and (12,2), in lookup order; the coin cell\'s entry is deletable', t2 && t2.n === 2 && t2.xs[0] === 160 && t2.xs[1] === 192 &&
		t2.pc && t2.pc[0] === 0 && t2.pc[1] === -1 && L4.nPortalCoins === 1 && L4.multiTargetPortals, t2 ? `n ${t2.n}` : 'none');
	// exit 0 (the coin cell): the ball falls through the coin and collects it -> the entry is gone; back in A there
	// is one exit left, so no random draw
	const r4 = walk(L4, 120, [0]);
	const s4 = r4.sim, in4 = new E.EEInput();
	for (let t = 0; t < 40; t++) { E.applyMask(in4, 0); s4.tick(in4); }
	const gone = (s4._portalGone[0] & 1) === 1 && s4.coins === 1;
	const kGone = s4.stateKey(), snap = s4.snapshot();
	const back = (sim) => {
		sim.px = 5 * 16; sim.py = 4 * 16; sim.speed_x = 3; sim.speed_y = 0; sim._last_portal_set = false;
		const steps = sim._rngSteps;
		let ev = null;
		sim.onEvent = (k, d) => { if (k === 'portal' && !ev) ev = d; };
		const inp = new E.EEInput();
		E.applyMask(inp, 4); sim.tick(inp);
		return { to: ev && ev.to, draws: sim._rngSteps - steps, need: sim.rngNeed };
	};
	const b4 = back(s4);
	check('taking the coin-cell exit collects the coin and deletes that entry (setTileComplex -> deleteLookup); back in A the only exit left is ' +
		'(12,2), with no random draw', r4.ev && r4.ev.to.x === 10 && gone && b4.to && b4.to.x === 12 && b4.draws === 0 && b4.need === 0,
		`first ${dest(r4)}, coins ${s4.coins}, gone ${s4._portalGone[0]}, back ${JSON.stringify(b4)}`);
	const r4b = walk(L4, 120, [1]);
	const b4b = back(r4b.sim);
	check('without the pickup both exits stay (the second entry draws again: 2 exits)', r4b.ev && r4b.ev.to.x === 12 && r4b.sim.coins === 0 && b4b.draws === 1 && b4b.need === 2,
		JSON.stringify(b4b));
	// the deleted set is state: restored by restore(), and keyed
	s4.restore(snap);
	const kSame = s4.stateKey() === kGone;
	s4._portalGone = L4.portalGone0;
	const kDiff = s4.stateKey() !== kGone;
	s4.restore(snap);
	check('the deleted entries are part of snapshot / restore and of stateKey', kSame && kDiff && (s4._portalGone[0] & 1) === 1);
	// /reset does not bring the entry back (resetCoins uses setTile): spawn 0 on the coin cell (a background 255), one
	// idle tick collects the coin, /reset moves to spawn 1 and turns 110 back into 100
	const L5 = loadRecords(W, H, [...wallRecords(W, H, 5), { id: 255, layer: 1, xs: [10], ys: [2] }, { id: 255, xs: [2], ys: [4] }, ...coinRecs]);
	const s5 = new E.EESim(L5, { start: 'reset', idleTicks: 1 });
	const c5 = L5.coinTiles[0];
	const b5 = back(s5);
	check('a coin collected before /reset: the coin is back (100, 0 coins) but its portal entry stays deleted (one exit, no draw)',
		s5.tiles[c5] === 100 && s5.coins === 0 && b5.to && b5.to.x === 12 && b5.draws === 0, `tile ${s5.tiles[c5]}, gone ${s5._portalGone[0]}, back ${JSON.stringify(b5)}`);
	const s6 = new E.EESim(L5, { start: 'load' });
	check('a plain load collects nothing: both exits', (s6._portalGone[0] | 0) === 0 && back(s6).draws === 1);
	// 5. the sample levels: the portal tables from `portals` equal the old extras-based ones (every file EEO writes)
	const dir = process.env.EEAT_LEVELS || HOMEP('Downloads');
	let n = 0, diff = [];
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => /\.eelvl$/i.test(f)).map((f) => path.join(dir, f)); } catch (e) { /* none */ }
	for (const f of files.slice(0, QUICK ? 12 : files.length)) {
		let json;
		try { json = V.toSimLevel(V.readEelvl(fs.readFileSync(f))); } catch (e) { continue; }
		const a = E.prepareLevel(json), b = E.prepareLevel(Object.assign({}, json, { portals: undefined }));
		const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
		let ok = same(a.portalSlot, b.portalSlot) && same(a.pId, b.pId) && same(a.pTarget, b.pTarget) && same(a.pRot, b.pRot) &&
			a.multiTargetPortals === b.multiTargetPortals && a.portalsById.size === b.portalsById.size && a.nPortalCoins === 0;
		for (const [k, v] of b.portalsById) { const w = a.portalsById.get(k); if (!w || !same(v.xs, w.xs) || !same(v.ys, w.ys)) ok = false; }
		n++;
		if (!ok) diff.push(path.basename(f));
	}
	if (n) check(`${n} sample levels: portals from the AS3 lookup = the extras-based tables (order included), no portal entry on a coin cell`, diff.length === 0, diff.join(', ') || undefined);
	else console.log('    (sample levels not found: skipped)');
}

// ================================================================ keys
function keysSection() {
	section('keys: stateKey / stateHash decode uniquely (switch numbers are any int32, World.as:296-297)');
	const L = mkLevel({ tiles: [[6, 4, 184, 2], [12, 2, 113, 2], [13, 2, 113, 7], [12, 1, 467, 5], [13, 1, 467, 131072], [14, 2, 1079, 131072]] });
	// 1. the reviewer's pair: purple {2 on} + orange {5 off}  vs  purple {7 off} + orange {131072 on}
	const A = new E.EESim(L), B = new E.EESim(L);
	A._pressPurpleSwitch(2, true); A._pressOrangeSwitch(5, true); A._pressOrangeSwitch(5, false);
	B._pressPurpleSwitch(7, true); B._pressPurpleSwitch(7, false); B._pressOrangeSwitch(131072, true);
	const inp = new E.EEInput();
	const kA = A.stateKey(), kB = B.stateKey(), hA = A.stateHash(), hB = B.stateHash();
	let firstDiff = -1;
	for (let t = 1; t <= 120; t++) { E.applyMask(inp, 4); A.tick(inp); E.applyMask(inp, 4); B.tick(inp); if (firstDiff < 0 && A.px !== B.px) firstDiff = t; }
	check('purple {2 on}, orange {5 off} and purple {7 off}, orange {131072 on} (purple door #2: open vs shut) get different keys and hashes',
		kA !== kB && hA !== hB && firstDiff > 0, `futures differ from tick ${firstDiff}`);
	// 2. a map with nothing on keys like no map
	const C0 = new E.EESim(L), C1 = new E.EESim(L);
	C1._pressPurpleSwitch(7, true); C1._pressPurpleSwitch(7, false); C1._pressOrangeSwitch(99999, true); C1._pressOrangeSwitch(99999, false);
	check('switch maps whose switches are all off key like no maps (doors and switches only test === true)', C0.stateKey() === C1.stateKey() && C0.stateHash() === C1.stateHash());
	// 3. random switch maps and queues: equal keys iff equal on-sets and queues; equal hashes iff equal keys
	const r = rngOf(SEED0 * 977 + 3);
	const pool = [0, 1, 2, 3, 5, 7, 1000, 65535, 65536, 65537, 131072, 196608, 0x10002, -1, -2, -65536, -65535, 2147483647, -2147483648];
	const pick = () => pool[Math.floor(r() * pool.length)];
	const sim = new E.EESim(L);
	const byKey = new Map(), byDesc = new Map(), hashOf = new Map();
	let bad = '', nStates = QUICK ? 20000 : 60000;
	const onSet = (m) => [...m].filter((e) => e[1] === true).map((e) => e[0]).sort((a, b) => a - b).join(' ');
	for (let s = 0; s < nStates && !bad; s++) {
		sim._switches = new Map(); sim._swOwned = true; sim._oswitches = new Map(); sim._oswOwned = true;
		for (let k = Math.floor(r() * 4); k > 0; k--) sim._swSet(pick(), r() < 0.6);
		for (let k = Math.floor(r() * 4); k > 0; k--) sim._oswSet(pick(), r() < 0.6);
		sim._stateQueue.length = 0; sim._keysQueue.length = 0; sim._tileQueue.length = 0;
		for (let k = r() < 0.7 ? 0 : Math.floor(r() * 3); k > 0; k--) sim._stateQueue.push(Math.floor(r() * 3), pick(), r() < 0.5 ? 1 : 0);
		for (let k = r() < 0.7 ? 0 : Math.floor(r() * 3); k > 0; k--) sim._keysQueue.push(Math.floor(r() * 6), r() < 0.5 ? 1 : 0);
		for (let k = r() < 0.7 ? 0 : Math.floor(r() * 3); k > 0; k--) sim._tileQueue.push(pick(), r() < 0.5 ? 1 : 0);
		const desc = `${onSet(sim._switches)}|${onSet(sim._oswitches)}|${sim._stateQueue.join(' ')}|${sim._keysQueue.join(' ')}|${sim._tileQueue.join(' ')}`;
		const key = sim.stateKey(), h = sim.stateHash();
		if (byKey.has(key) && byKey.get(key) !== desc) bad = `same key for "${byKey.get(key)}" and "${desc}"`;
		if (byDesc.has(desc) && byDesc.get(desc) !== key) bad = `two keys for "${desc}"`;
		if (hashOf.has(h) && hashOf.get(h) !== key) bad = `hash collision for "${desc}"`;
		byKey.set(key, desc); byDesc.set(desc, key); hashOf.set(h, key);
	}
	check(`${nStates} random switch maps (ids incl. 65536+, negatives, int32 extremes) and queues: equal keys iff equal on-sets and queues, ` +
		`hashes iff keys (${byKey.size} distinct)`, !bad, bad || undefined);
}

// ================================================================ fuzz (snapshot / restore / stateKey soundness)
/** "kitchen sink" level JSON with every block family the tick loop touches (see the header) */
function kitchenSink(seed, { timeDoors = true, W = 36, H = 25, rngScript = null, nSpawns = 10, nZoo = 230, nRandom = 2, nCoinExits = 3, nCoins = 0 } = {}) {
	const r = rngOf(seed * 7919 + 17);
	const ri = (n) => Math.floor(r() * n);
	const pick = (a) => a[ri(a.length)];
	const fg = new Int32Array(W * H);
	const num = new Map();       // index -> lookup int
	const extras = [];
	const plk = new Map();       // the AS3 portalLookup: index -> [index, rotation, id, target, type] (last write wins)
	const spawns = [];
	const set = (x, y, id, v) => { if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return; const i = y * W + x; fg[i] = id; num.delete(i); if (v !== undefined) num.set(i, v); };
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	// platforms every 6 rows with gaps, of plain solid, ice, one-way, half blocks
	const rows = [];
	for (let y = 6; y < H - 1; y += 6) rows.push(y);
	rows.push(H - 2);
	for (const y of rows) {
		for (let x = 1; x < W - 1; x++) {
			const q = r();
			if (q < 0.10) continue;
			if (q < 0.20) set(x, y, 1064);
			else if (q < 0.25) set(x, y, 61);
			else if (q < 0.29) set(x, y, 1001, ri(4));
			else if (q < 0.33) set(x, y, 1041, ri(4));
			else set(x, y, 9);
		}
	}
	for (let k = 0; k < 5; k++) { const x = 2 + ri(W - 4); const c = pick([118, 120, 98, 99]); for (let y = 2; y < H - 2; y++) if (r() < 0.8) set(x, y, c); }
	const zoo = [
		[6], [7], [8], [408], [409], [410], [23], [24], [25], [26], [27], [28], [1005], [1006], [1007], [1008], [1009], [1010],
		...(timeDoors ? [[156], [157], [156], [157]] : []),
		[113, () => pick([1, 2, 3, 1000])], [184, () => pick([1, 2, 3])], [185, () => pick([1, 2, 3])], [1619, () => pick([1, 2, 1000])],
		[467, () => pick([1, 2, 3, 1000])], [1079, () => pick([1, 2, 3])], [1080, () => pick([1, 2, 3])], [1620, () => pick([1, 2, 1000])],
		[100], [100], [100], [101], [101], [110], [111], [43, () => 1 + ri(4)], [165, () => 1 + ri(4)], [213, () => 1 + ri(3)], [214, () => 1 + ri(3)],
		[1011, () => 1 + ri(3)], [1012, () => 1 + ri(3)], [5], [1094], [1095], [121], [1152], [1153], [206], [207],
		[421, () => pick([0, 1, 2, 3])], [422, () => pick([0, 1, 2])], [1573], [1584, () => pick([0, 1, 2])], [420, () => ri(2)],
		[418, () => ri(2)], [417, () => ri(3)], [419, () => ri(3)], [453, () => ri(2)], [461, () => pick([1, 2, 3, 1000])], [1517, () => ri(5)],
		[1618], [423, () => ri(4)], [1027, () => ri(4)], [1028, () => ri(4)], [361, () => ri(4)], [1580], [368], [416], [119], [369], [1585],
		[114], [115], [116], [117], [1], [2], [3], [1518], [411], [412], [413], [1519], [4], [414], [50], [243], [360], [360], [1064],
		// music: with a sound, and with numbers eeo-tas has no sound for (the tick aborts in touchBlock)
		[77, () => pick([0, 30, 61, -28])], [83, () => pick([3, 20])], [1520, () => pick([10, 49])],
	];
	for (let k = 0; k < nZoo; k++) {
		const [id, v] = pick(zoo);
		const y = r() < 0.85 ? pick(rows) - 1 - (r() < 0.3 ? 1 : 0) : 1 + ri(H - 2);
		set(1 + ri(W - 2), y, id, v ? v() : undefined);
	}
	for (let k = 0; k < 4; k++) { const id = pick([119, 369, 1585, 416, 4, 1, 2, 3, 1518]); const x0 = 1 + ri(W - 6), y0 = 1 + ri(H - 4); for (let x = x0; x < x0 + 3; x++) for (let y = y0; y < y0 + 2; y++) set(x, y, id); }
	// portals: pairs, one 3-exit random portal (id 7), invisible ones
	const portal = (x, y, id, target, rot, inv) => { set(x, y, inv ? 381 : 242); const i = y * W + x; extras.push([i, rot, id, target]); plk.set(i, [i, rot, id, target, inv ? 381 : 242]); };
	const spot = () => [1 + ri(W - 2), pick(rows) - 1 - ri(2)];
	for (let p = 1; p <= 3; p++) { const [ax, ay] = spot(), [bx, by] = spot(); portal(ax, ay, p, 10 + p, ri(4), r() < 0.3); portal(bx, by, 10 + p, p, ri(4), r() < 0.3); }
	for (let k = 0; k < 3; k++) { const [x, y] = spot(); portal(x, y, 7, 20 + k, ri(4), r() < 0.3); }
	for (let k = 0; k < nRandom; k++) { const [x, y] = spot(); portal(x, y, 30 + k, 7, ri(4), r() < 0.3); }
	for (let k = 0; k < nCoins; k++) set(1 + ri(W - 2), 1 + ri(H - 2), pick([100, 101, 110]));   // extra coins (in the air too)
	// spawns (file order); a spawn on a portal cell leaves a stale portal entry (an exit in eeo-tas)
	for (let k = 0; k < nSpawns; k++) { const x = 2 + ri(W - 4), y = rows[ri(rows.length)] - 1 - ri(3); set(x, y, 255); spawns.push([x, y]); }
	// background (layer-1) portal records: exits only; and portal entries on coin cells (deleted by the pickup)
	for (let k = 0; k < 2; k++) { const i = (1 + ri(H - 2)) * W + 1 + ri(W - 2); if (fg[i] === 0) plk.set(i, [i, ri(4), 11 + ri(3), 1, 242]); }
	const coinCells = [];
	for (let i = 0; i < W * H; i++) if (fg[i] === 100 || fg[i] === 101 || fg[i] === 110 || fg[i] === 111) coinCells.push(i);
	for (let k = 0; k < nCoinExits && coinCells.length; k++) { const i = coinCells.splice(ri(coinCells.length), 1)[0]; plk.set(i, [i, ri(4), 7, 30, 242]); }
	const ex = extras.filter((e) => fg[e[0]] === 242 || fg[e[0]] === 381);
	const d = { format: 'eesim-level-1', level_id: 'ks' + seed, width: W, height: H, gravity_hex: f64hex(1), gravity: 1,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras: ex.concat([...num].map(([i, v]) => [i, v, null, null])),
		lookup_int: [...num], spawn_points: [spawns], portals: [...plk.values()] };
	if (rngScript) d.rng_script = rngScript;
	return d;
}

/** sticky random inputs: runs of 5..120 ticks, jumps as presses or holds, sometimes up/down for dots / liquids / ladders */
function randMasks(seed, n) {
	const r = rngOf(seed);
	const out = new Uint8Array(n);
	let i = 0;
	while (i < n) {
		const len = 5 + Math.floor(r() * 115), kind = Math.floor(r() * 8), jp = 2 + Math.floor(r() * 30);
		const dir = [4, 2, 0, 4, 2, 8, 16, 4 | 8][Math.floor(r() * 8)];
		for (let k = 0; k < len && i < n; k++, i++) {
			let m = dir;
			if (kind < 3) m |= (k % jp === 0 ? 1 : 0);
			else if (kind === 3) m |= 1;
			else if (kind === 4 && r() < 0.15) m = Math.floor(r() * 32);
			else if (kind === 5) m = 0;
			out[i] = m;
		}
	}
	return out;
}
/** teleport schedule for n ticks: tp[t] = a cell index to put the box on before tick t + 1, or -1 */
function teleports(level, seed, n, every = 250) {
	const r = rngOf(seed ^ 0x2545f491);
	const air = [];
	for (let i = 0; i < level.fg.length; i++) if (level.fg[i] === 0) air.push(i);
	const tp = new Int32Array(n).fill(-1);
	for (let t = Math.floor(every / 2); t < n; t += Math.floor(every / 2 + r() * every)) tp[t] = air[Math.floor(r() * air.length)];
	return tp;
}
function applyTp(sim, tp, t) {
	if (tp[t] < 0) return;
	const W = sim.level.width;
	sim.px = (tp[t] % W) * 16; sim.py = Math.floor(tp[t] / W) * 16; sim.speed_x = 0; sim.speed_y = 0;
}

// deep state dump (loop temporaries written in every tick before they are read are not state)
const SCRATCH = new Set(['_switch_dirty', '_rem_x', '_rem_y', '_cur_sx', '_cur_sy', '_grounded', '_land_speed']);
const SKIP = new Set(['onEvent', 'level', '_keyBuf', '_keyF', '_keyI', '_keyBytes', '_keyW', '_keyDoubleOff', '_keyColors', '_coinOff',
	'_loopCollided', '_coinOwned', '_secretOwned', '_swOwned', '_oswOwned', '_evSwOwned', '_evOSwOwned']);
function hashArr(a) { let h = 0x811c9dc5 | 0; for (let i = 0; i < a.length; i++) { h ^= a[i] | 0; h = Math.imul(h, 16777619); } return `${a.length}:${h >>> 0}`; }
function ser(v) {
	if (v instanceof Map) return '{' + [...v.entries()].sort((a, b) => a[0] - b[0]).map((e) => `${e[0]}:${e[1]}`).join(',') + '}';
	if (ArrayBuffer.isView(v)) return v.length > 64 ? hashArr(v) : Array.from(v).join(',');
	if (Array.isArray(v)) return '[' + v.join(',') + ']';
	if (typeof v === 'object' && v !== null) return JSON.stringify(v);
	if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
	return String(v);
}
function dump(sim, skipExtra) {
	const parts = [];
	for (const k of Object.keys(sim).sort()) {
		if (SKIP.has(k) || (skipExtra && skipExtra.has(k))) continue;
		parts.push(k + '=' + ser(sim[k]));
	}
	return parts.join(';');
}
const evStr = (k, d) => k + (d === undefined ? '' : JSON.stringify(d));
function strHash(str) { let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 15; } return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36); }
function diffDump(a, b) {
	const A = a.split(';'), B = b.split(';');
	for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `${(A[i] || '').slice(0, 120)} vs ${(B[i] || '').slice(0, 120)}`;
	return '?';
}

/** A. snapshots restored in random order continue with an identical full state and events (masksIn: a real run, no teleports) */
function partA(name, level, simOpts, n, nSnaps, horizon, seed, masksIn) {
	const masks = masksIn || randMasks(seed, n), tp = masksIn ? new Int32Array(n).fill(-1) : teleports(level, seed, n);
	const refDumpAt = (t1) => { const s2 = new E.EESim(level, simOpts); const i2 = new E.EEInput(); for (let t = 0; t < t1; t++) { applyTp(s2, tp, t); E.applyMask(i2, masks[t]); s2.tick(i2); } return dump(s2); };
	const sim = new E.EESim(level, simOpts); const inp = new E.EEInput();
	let evs = [];
	const cov = {};
	sim.onEvent = (k, d) => { evs.push(evStr(k, d)); const c = k === 'effect' ? 'effect:' + d.effect : (k === 'switch' || k === 'door_state') ? k + ':' + d.kind : k; cov[c] = (cov[c] || 0) + 1; };
	const D = [], EV = [], snaps = new Map(), snapDump = new Map();
	const r = rngOf(seed ^ 0x5bd1e995);
	const at = new Set(); while (at.size < Math.min(nSnaps, n)) at.add(Math.floor(r() * n));
	let reuse = null;
	let deadTicks = 0;
	for (let t = 0; t < n; t++) {
		applyTp(sim, tp, t);
		if (at.has(t)) {
			const s = (snaps.size % 3 === 2 && reuse) ? sim.snapshot(reuse) : sim.snapshot();   // some refill an old snapshot object
			reuse = null;
			snaps.set(t, s); snapDump.set(t, dump(sim, SCRATCH));
			if (snaps.size % 3 === 1) { reuse = sim.snapshot(); }
		}
		E.applyMask(inp, masks[t]); evs = []; sim.tick(inp);
		D.push(strHash(dump(sim))); EV.push(evs.join('|'));
		if (sim.is_dead) deadTicks++;
	}
	console.log('    events in the reference run: ' + Object.entries(cov).sort().map(([k, v]) => k + ' ' + v).join(', '));
	const sim2 = new E.EESim(level, simOpts);
	const order = [...snaps.keys()].sort(() => r() - 0.5);
	let bad = 0, badImm = 0, first = '';
	for (let j = 0; j < order.length; j++) {
		const t0 = order[j];
		const S = j % 4 === 3 ? sim2 : sim;   // every 4th restore goes into a different sim instance
		let e2 = [];
		S.onEvent = (k, d) => e2.push(evStr(k, d));
		S.restore(snaps.get(t0));
		if (dump(S, SCRATCH) !== snapDump.get(t0)) { badImm++; if (!first) first = `immediately after restore of ${t0}: ${diffDump(dump(S, SCRATCH), snapDump.get(t0))}`; }
		const h = j % 5 === 0 ? 7 : horizon;   // some restores run only a short stretch before the next one
		for (let t = t0; t < Math.min(n, t0 + h); t++) {
			if (t > t0) applyTp(S, tp, t);
			E.applyMask(inp, masks[t]); e2 = []; S.tick(inp);
			const dd = dump(S);
			if (strHash(dd) !== D[t] || e2.join('|') !== EV[t]) { bad++; if (!first) first = `from ${t0} at tick ${t + 1}: ${strHash(dd) !== D[t] ? diffDump(dd, refDumpAt(t + 1)) : 'events ' + e2.join('|') + ' vs ' + EV[t]}`; break; }
		}
	}
	check(`A ${name}: ${snaps.size} snapshots (some via snapshot(reuse)) restored in random order, also into a 2nd sim, continue with an identical ` +
		`full state and events (${horizon} ticks; ${deadTicks} dead ticks in the run)`, bad === 0 && badImm === 0, first || 'all equal');
}

// observables of a continuation (futures)
function onSetOf(m) { const o = []; for (const [k, v] of m) if (v === true) o.push(k); return o.sort((a, b) => a - b).join(','); }
const z = (v) => (v === 0 ? 0 : v);   // -0 -> +0
function obs(s, base) {
	return [z(s.px), z(s.py), z(s.speed_x), z(s.speed_y), s.is_dead, s.deaths - base.deaths, s.coins, s.blue_coins, s._keysMask, onSetOf(s._switches),
		onSetOf(s._oswitches), s.has_crown, s.has_silver_crown, s._collide_crown, s._collide_silver_crown, s.is_cursed, s.is_zombie, s.is_poisoned,
		s.is_on_fire, s.is_invulnerable, s.has_levitation, z(s._current_thrust), s.team, s.checkpoint.x, s.checkpoint.y, s.jump_count, s.on_ground,
		s.max_jumps, s.jump_boost, s.speed_boost, s.flip_gravity, s.low_gravity, s.level.hasTimeDoors ? s._timedoor_state : '-', s._next_spawn, s._q0, s._q1].join(',');
}
const OBS_NAMES = ['px', 'py', 'speed_x', 'speed_y', 'is_dead', 'deaths+', 'coins', 'blue_coins', 'keysMask', 'switches', 'oswitches', 'has_crown',
	'has_silver_crown', 'collide_crown', 'collide_silver', 'cursed', 'zombie', 'poisoned', 'on_fire', 'invulnerable', 'levitation', 'thrust', 'team',
	'checkpoint.x', 'checkpoint.y', 'jump_count', 'on_ground', 'max_jumps', 'jump_boost', 'speed_boost', 'flip_gravity', 'low_gravity', 'timedoor',
	'next_spawn', 'q0', 'q1'];
/** observables + events per tick of the continuation (the events of one tick as a set: the order of the diff-based switch
 *  events follows the switch Map's insertion order, an artefact of the JS event layer that AS3 does not have) */
function future(sim, snap, cont) {
	sim.restore(snap);
	const base = { deaths: sim.deaths };
	const inp = new E.EEInput();
	let ev = [];
	sim.onEvent = (k, d) => { if (k === 'complete') d = Object.assign({}, d, { ticks: 0 }); ev.push(evStr(k, d)); };
	const out = [];
	for (let t = 0; t < cont.length; t++) {
		E.applyMask(inp, cont[t]); ev = []; sim.tick(inp);
		out.push(obs(sim, base) + '#' + ev.sort().join('|'));
	}
	sim.onEvent = null;
	return out;
}
function firstDiff(a, b) {
	for (let i = 0; i < a.length; i++) {
		if (a[i] === b[i]) continue;
		const [oa, ea] = a[i].split('#'), [ob, eb] = b[i].split('#');
		const A = oa.split(','), B = ob.split(',');
		const f = [];
		for (let j = 0; j < Math.max(A.length, B.length); j++) if (A[j] !== B[j]) f.push(`${OBS_NAMES[j] || j} ${A[j]} vs ${B[j]}`);
		if (ea !== eb) f.push(`events ${ea.slice(0, 200)} vs ${eb.slice(0, 200)}`);
		return `tick +${i + 1}: ${f.join('; ')} (pos ${A[0]},${A[1]} dead ${A[4]})`;
	}
	return null;
}

/** B. perturbations of state that stateKey() leaves out (in the current situation), each one some other history could produce */
function perturbations(L, r) {
	const tdoor = L.hasTimeDoors;
	return [
		['clock shift (PlayState.ticks and every timer stamp by the same delta; time-door levels: a multiple of 1000)', (s) => {
			const d = tdoor ? 1000 * (1 + Math.floor(r() * 3)) : 1 + Math.floor(r() * 5000);
			if (s.ticksPerFrame > 1 && d % s.ticksPerFrame !== 0) return false;
			s._ticks += d; s._tick0 += d;
			for (let c = 0; c < 6; c++) s._kt[c] += d;
			s._curse_time_start += d; s._poison_time_start += d; s._fire_time_start += d;
			if (s._zombie_duration !== 0) s._zombie_time_start += d;
			s._last_jump -= d * 10;
			return true;
		}],
		['deaths (no death door / gate in the level)', (s) => { if (L.hasDeathDoor) return false; s.deaths += 1 + Math.floor(r() * 5); return true; }],
		['run_ticks', (s) => { if (s.run_ticks === 0) return false; s.run_ticks += 1 + Math.floor(r() * 99); return true; }],
		['lastPortal position (only lastPortal != null is read)', (s) => { if (!s._last_portal_set) return false; s._last_portal_x = 16 * Math.floor(r() * 40); s._last_portal_y = 16 * Math.floor(r() * 20); return true; }],
		['ox / oy (alive, no one-way under the box)', (s) => { if (s.is_dead || s._boxTouchesOneWay()) return false; s._ox = s.px + (r() * 32 - 16); s._oy = s.py + (r() * 32 - 16); return true; }],
		['deadoffset while alive (0 or the 16.2 a respawn leaves)', (s) => { if (s.is_dead) return false; s._dead_offset = s._dead_offset === 0 ? 16.200000000000017 : 0; return true; }],
		['key timer of a colour that is neither active nor queued', (s) => {
			const cs = [];
			for (let c = 0; c < 6; c++) {
				let q = false; for (let i = 0; i < s._keysQueue.length; i += 2) if (s._keysQueue[i] === c) q = true;
				if ((s._keysMask & (1 << c)) === 0 && !q) cs.push(c);
			}
			if (!cs.length) return false;
			s._kt[cs[Math.floor(r() * cs.length)]] = s._ticks - Math.floor(r() * 1200); return true;
		}],
		['isThrusting while the thrust is 0', (s) => { if (s._current_thrust !== 0) return false; s.is_thrusting = !s.is_thrusting; return true; }],
		['start / duration of timed effects that are off', (s) => {
			let any = false;
			if (!s.is_cursed) { s._curse_time_start = s._ticks - Math.floor(r() * 300); s._curse_duration = 140 + Math.floor(r() * 3) * 100; any = true; }
			if (!s.is_poisoned) { s._poison_time_start = s._ticks - Math.floor(r() * 300); s._poison_duration = 240; any = true; }
			if (!s.is_on_fire) { s._fire_time_start = s._ticks - Math.floor(r() * 300); s._fire_duration = 240; any = true; }
			if (!s.is_zombie) { s._zombie_time_start = s._ticks - Math.floor(r() * 300); s._zombie_duration = 140; any = true; }
			return any;
		}],
		['slippery <= 0 values', (s) => { if (s._slippery > 0) return false; s._slippery = -r() * 0.2; return true; }],
		['-0 / +0 speeds', (s) => { let any = false; if (s.speed_x === 0) { s.speed_x = Object.is(s.speed_x, -0) ? 0 : -0; any = true; } if (s.speed_y === 0) { s.speed_y = Object.is(s.speed_y, -0) ? 0 : -0; any = true; } return any; }],
		['gate snapshots of gates the level does not have', (s) => {
			let any = false;
			if (!L.hasCoinGate) { s._show_coin_gate += 3; any = true; }
			if (!L.hasBlueCoinGate) { s._show_blue_coin_gate += 2; any = true; }
			if (!L.hasDeathGate) { s._show_death_gate += 4; any = true; }
			return any;
		}],
		['time-door state on a level without time doors', (s) => { if (L.hasTimeDoors) return false; s._timedoor_state = !s._timedoor_state; return true; }],
		['switch maps: explicit false entries vs no entry', (s) => { s._swSet(900 + Math.floor(r() * 50), false); s._oswSet(900 + Math.floor(r() * 50), false); return true; }],
		['per-tick scratch (modifiers, mor/mo, mx/my, input, current)', (s) => {
			s.modifier_x = r(); s.modifier_y = -r(); s.morx = 2; s.mory = -2; s.mox = 1; s.moy = -1; s._mx = 1; s._my = 1;
			s._horizontal = 1; s._vertical = -1; s._spacedown = true; s._spacejustdown = true; s._current = 5; s.current_tile = 5; return true;
		}],
		['lookup of collected coin cells', (s) => {
			let any = false;
			for (let k = 0; k < L.coinTiles.length; k++) { const i = L.coinTiles[k]; if (s.tiles[i] === 110 || s.tiles[i] === 111) { s._lookup[i] = 1 + Math.floor(r() * 9); any = true; } }
			return any;
		}],
		['the pending team cell when its number equals the team', (s) => {
			if (!L.hasTeamEffect || s._team_tx !== -1) return false;
			for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === 423 && s._lookup[i] === s.team) { s._team_tx = i % L.width; s._team_ty = Math.floor(i / L.width); return true; }
			return false;
		}],
	];
}
function partB(name, level, simOpts, n, seed, masksIn, every0) {
	const L = level;
	const r = rngOf(seed * 31 + 7);
	const masks = masksIn || randMasks(seed, n), tp = masksIn ? new Int32Array(n).fill(-1) : teleports(L, seed, n);
	const sim = new E.EESim(L, simOpts); const inp = new E.EEInput();
	const probe = new E.EESim(L, simOpts);
	const P = perturbations(L, r);
	const stats = P.map(() => ({ applied: 0, sameKey: 0, bad: 0, first: '' }));
	const every = every0 || (QUICK ? 23 : 11);
	for (let t = 0; t < n; t++) {
		applyTp(sim, tp, t);
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (t % every !== 0) continue;
		const snap = sim.snapshot();
		const cont = masksIn ? masksIn.subarray(t + 1, Math.min(masksIn.length, t + 1 + (QUICK ? 400 : 800))) : randMasks(seed * 1000 + t, QUICK ? 250 : 500);
		if (cont.length === 0) continue;
		const k0 = sim.stateKey(), h0 = sim.stateHash();
		// (coin tiles and their lookup follow the coin bitset, not snapshots: every probe starts from the reference arrays)
		const canon = () => { probe.restore(snap); probe.tiles.set(sim.tiles); probe._lookup.set(sim._lookup); probe._coinBits = snap.coinBits; probe._coinOwned = false; };
		canon();
		const f0 = future(probe, snap, cont);
		for (let p = 0; p < P.length; p++) {
			canon();
			if (!P[p][1](probe)) continue;
			stats[p].applied++;
			if (probe.stateKey() !== k0) continue;   // keyed after all: over-keying is allowed
			if (probe.stateHash() !== h0) { stats[p].bad++; if (!stats[p].first) stats[p].first = `t ${t}: equal keys, different hashes`; continue; }
			stats[p].sameKey++;
			const d = firstDiff(future(probe, probe.snapshot(), cont), f0);
			if (d) { stats[p].bad++; if (!stats[p].first) stats[p].first = `t ${t}: ${d}`; }
		}
	}
	for (let p = 0; p < P.length; p++) {
		const s = stats[p];
		if (s.applied === 0) continue;
		check(`B ${name}: ${P[p][0]}: ${s.sameKey} of ${s.applied} perturbed states keyed equal, all with identical futures`, s.bad === 0, s.first || undefined);
	}
}
/** C. states reached by different histories (idle-shifted starts, other spawns, other inputs) grouped by key */
function partC(name, level, simOpts, runs, len, seed) {
	const pool = new Map();
	let states = 0;
	for (let rr = 0; rr < runs; rr++) {
		const idle = [0, 1, 37, 500, 1000, 2000][rr % 6];
		const g6 = Math.floor(rr / 6);
		const ms = randMasks(seed * 100 + g6, len), tp = teleports(level, seed * 100 + g6, len, 400);
		const s = new E.EESim(level, Object.assign({}, simOpts, { startSpawn: g6 })); const i = new E.EEInput();
		for (let k = 0; k < idle; k++) { E.applyMask(i, 0); s.tick(i); }
		for (let t = 0; t < len; t++) {
			applyTp(s, tp, t);
			E.applyMask(i, ms[t]); s.tick(i);
			if (t % 2 !== 0) continue;
			const key = s.stateKey();
			let g = pool.get(key);
			if (!g) { g = []; pool.set(key, g); }
			if (g.length < 4 && !g.some((m) => m.ticks === s._ticks)) { g.push({ snap: s.snapshot(), tag: `run ${rr} (idle ${idle}) t ${t}`, hash: s.stateHash(), ticks: s._ticks }); states++; }
		}
	}
	const cont = randMasks(seed + 99, QUICK ? 300 : 600);
	const sim = new E.EESim(level, simOpts);
	let groups = 0, badFut = 0, badHash = 0, first = '';
	const hashSeen = new Map();
	for (const [key, g] of pool) {
		for (const m of g) if (m.hash !== g[0].hash) badHash++;
		const hk = g[0].hash;
		if (hashSeen.has(hk) && hashSeen.get(hk) !== key) badHash++; else hashSeen.set(hk, key);
		if (g.length < 2) continue;
		groups++;
		const f0 = future(sim, g[0].snap, cont);
		for (let j = 1; j < g.length; j++) {
			const d = firstDiff(future(sim, g[j].snap, cont), f0);
			if (d) { badFut++; if (!first) first = `${g[0].tag} vs ${g[j].tag}: ${d}`; }
		}
	}
	check(`C ${name}: ${groups} groups of equal keys at different ticks (${states} states, ${runs} runs) have identical futures`, badFut === 0 && groups > 20, first || `${groups} groups`);
	check(`C ${name}: stateHash equal for equal keys, no collisions`, badHash === 0, `${badHash}`);
}
function fuzzSection() {
	section('fuzz: snapshot / restore / stateKey soundness on kitchen-sink levels (every block family, music without a sound, background / stale / coin-cell portal entries)');
	const N = QUICK ? 5000 : 15000;
	const cases = [
		['ks1 (time doors, start reset)', kitchenSink(SEED0), {}],
		['ks2 (no time doors, start load)', kitchenSink(SEED0 + 1, { timeDoors: false }), { start: 'load' }],
		['ks3 (time doors, 40 idle ticks + reset, ticksPerFrame 2)', kitchenSink(SEED0 + 2), { idleTicks: 40, ticksPerFrame: 2 }],
		['ks4 (no time doors, rng_script)', kitchenSink(SEED0 + 3, { timeDoors: false, rngScript: [2, 1, 0, 1, 2, 0, 0, 1] }), {}],
		['ks5 (time doors, gold border)', kitchenSink(SEED0 + 4), { goldBorder: true }],
		['ks6 (portal maze: random exits on coin cells, reset)', kitchenSink(SEED0 + 5, { timeDoors: false, nZoo: 120, nRandom: 10, nCoinExits: 10, nCoins: 24 }), {}],
		['ks7 (portal maze, start load, rng_script)', kitchenSink(SEED0 + 6, { timeDoors: false, nZoo: 120, nRandom: 10, nCoinExits: 10, nCoins: 24, rngScript: [3, 0, 5, 1, 2, 4, 0, 6, 1, 3] }), { start: 'load' }],
	];
	for (const [name, json, opts] of cases) {
		if (CASE && !name.startsWith(CASE)) continue;
		const L = E.prepareLevel(json);
		console.log(`  -- ${name}: ${L.nPortalCoins} portal entries on coin cells, ${L.portalsById.size} portal ids`);
		partA(name, L, opts, N, QUICK ? 25 : 60, QUICK ? 300 : 600, SEED0 * 13 + name.length);
		partB(name, L, opts, QUICK ? 2500 : 6000, SEED0 * 17 + name.length);
		partC(name, L, opts, QUICK ? 18 : 36, QUICK ? 1500 : 3000, SEED0 * 19 + name.length);
	}
}

// ================================================================ real runs
function loadReal(R) {
	let L = V.loadEelvlLevel(R.level);
	const masks = E.parseEetasBytes(fs.readFileSync(R.tas));
	if (L.multiTargetPortals) {
		const ro = require('../src/rng.js').analyze(L, masks);
		if (ro.bestScript) L = Object.assign({}, L, { rngScript: Int32Array.from(ro.bestScript) });
	}
	return { L, masks };
}
function realSection() {
	section('real: the two real eeo-tas runs (local files, read in place)');
	for (const R of REAL) {
		if (!fs.existsSync(R.level) || !fs.existsSync(R.tas)) { console.log(`    (skipped ${R.name}: files not found)`); continue; }
		const { L, masks } = loadReal(R);
		const r = require('../src/common.js').replay(L, masks);
		check(`${R.name}: complete tick ${r.complete}, run_ticks ${r.runTicks}, deaths ${r.deaths}`, r.complete === R.complete && r.runTicks === R.runTicks && r.deaths === R.deaths,
			`expected ${R.complete} / ${R.runTicks} / ${R.deaths}`);
		const n = r.complete;
		partA(R.name, L, {}, n, QUICK ? 20 : 60, QUICK ? 500 : 2000, 4242, masks.subarray(0, n));
		partB(R.name, L, {}, n, 4343, masks.subarray(0, n), QUICK ? 997 : 157);
	}
}

// ================================================================ drag constants (informational)
function dragSection() {
	section('drag: the 8 drag constants (Config.as:47-55: pow(x, 10) * 1.00016093, computed once by AVM2 Math.pow)');
	const hex = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); };
	const BASES = { BASE_DRAG: 0.9981, ICE_NO_MOD_DRAG: 0.9993, ICE_DRAG: 0.9998, NO_MOD_DRAG: 0.99, WATER_DRAG: 0.995, MUD_DRAG: 0.975, LAVA_DRAG: 0.98, TOXIC_DRAG: 0.99 };
	// pow(x, 10.0) * 1.00016093 from ucrtbase.dll / msvcrt.dll pow (32- and 64-bit, Windows 11 22631), measured by the reviewer
	const CRT = { BASE_DRAG: '6accf435f866ef3f', ICE_NO_MOD_DRAG: 'f7c64b3b25c8ef3f', ICE_DRAG: 'bfbf054af2f0ef3f', NO_MOD_DRAG: '1eb5c8e6e3f1ec3f',
		WATER_DRAG: '8cffc581bf70ee3f', MUD_DRAG: '1ccd6139b7d8e83f', LAVA_DRAG: 'b7e3faa08926ea3f', TOXIC_DRAG: '1eb5c8e6e3f1ec3f' };
	const toRat = (d) => {
		const b = Buffer.alloc(8); b.writeDoubleLE(d);
		const bits = b.readBigUInt64LE(0), e = Number((bits >> 52n) & 0x7ffn);
		let m = bits & ((1n << 52n) - 1n); if (e) m |= 1n << 52n;
		const ex = (e ? e : 1) - 1075;
		return ex >= 0 ? { n: m << BigInt(ex), d: 1n } : { n: m, d: 1n << BigInt(-ex) };
	};
	const roundRat = (n, d) => {
		let e = 0;
		while (n >= d * 2n) { d *= 2n; e++; }
		while (n < d) { n *= 2n; e--; }
		const sc = n * (1n << 52n); let q = sc / d; const rr = sc % d;
		if (2n * rr > d || (2n * rr === d && (q & 1n))) q++;
		if (q === (1n << 53n)) { q >>= 1n; e++; }
		return Number(q) * Math.pow(2, e - 52);
	};
	let sqAll = true, crDiff = 0;
	console.log('    name              eesim.js          correctly rounded  Windows CRT pow');
	for (const [k, x] of Object.entries(BASES)) {
		const x2 = x * x, x4 = x2 * x2, x8 = x4 * x4, sq = (x2 * x8) * 1.00016093;
		const r = toRat(x); let n = 1n, d = 1n;
		for (let i = 0; i < 10; i++) { n *= r.n; d *= r.d; }
		const cr = roundRat(n, d) * 1.00016093;
		if (E.DRAG_HEX[k] !== hex(sq)) sqAll = false;
		if (E.DRAG_HEX[k] !== hex(cr)) crDiff++;
		console.log(`    ${k.padEnd(17)} ${E.DRAG_HEX[k]}  ${hex(cr)}   ${CRT[k]}`);
	}
	check('eesim.js\'s constants are square-and-multiply pow ((x^2 * x^8) * 1.00016093, what Godot 4.6.1 gave); ' +
		`${crDiff} of 8 differ from the correctly rounded / Windows CRT pow in the last bits (which pow AVM2 uses is not established)`, sqAll);
	if (QUICK) return;
	// the real runs cannot tell the two constant sets apart (an engine copy with the CRT bits, compiled in memory)
	let src = fs.readFileSync(require.resolve('../src/eesim.js'), 'utf8');
	for (const [k, h] of Object.entries(CRT)) src = src.split(`const ${k} = hexToDouble('${E.DRAG_HEX[k]}');`).join(`const ${k} = hexToDouble('${h}');`);
	const f = require.resolve('../src/eesim.js').replace(/eesim\.js$/, 'eesim_crt_in_memory.js');
	const m = new Module(f, module); m.filename = f; m.paths = module.paths; m._compile(src, f);
	const ECRT = m.exports;
	for (const R of REAL) {
		if (!fs.existsSync(R.level) || !fs.existsSync(R.tas)) continue;
		const json = V.toSimLevel(V.readEelvl(fs.readFileSync(R.level)));
		const masks = E.parseEetasBytes(fs.readFileSync(R.tas));
		const play = (Eng) => {
			const sim = new Eng.EESim(Eng.prepareLevel(json, {})); const inp = new Eng.EEInput();
			let complete = -1, deaths = 0;
			sim.onEvent = (k) => { if (k === 'complete' && complete < 0) complete = sim.ticks(); else if (k === 'death') deaths++; };
			for (let t = 0; t < masks.length && complete < 0; t++) { Eng.applyMask(inp, masks[t]); sim.tick(inp); }
			return `${complete}/${sim.run_ticks}/${deaths}`;
		};
		const a = play(E), b = play(ECRT);
		check(`${R.name} (random exits: script 0) finishes the same with either constant set (${a}): the run does not pin these bits`, a === b, `${a} vs ${b}`);
		// how to settle it in eeo-tas: /fps (DebugStats.as:70-71) shows Position (x / 16).toFixed(15) and Velocity
		// (speedX / 7.752).toFixed(15); /playsegment freezes after the last byte, so /reset, /loadtas <prefix>, /playsegment
		const fmtS = (s) => `Position (${(s.px / 16).toFixed(15)}, ${(s.py / 16).toFixed(15)}) Velocity (${((s.speed_x * 7.752) / 7.752).toFixed(15)}, ${((s.speed_y * 7.752) / 7.752).toFixed(15)})`;
		const sa = new E.EESim(E.prepareLevel(json, {})), sb = new ECRT.EESim(ECRT.prepareLevel(json, {}));
		const ia = new E.EEInput(), ib = new ECRT.EEInput();
		for (let t = 0; t < masks.length; t++) {
			E.applyMask(ia, masks[t]); ECRT.applyMask(ib, masks[t]); sa.tick(ia); sb.tick(ib);
			if (fmtS(sa) !== fmtS(sb)) { console.log(`    ${R.name}: the /fps readout after the first ${t + 1} bytes tells them apart:\n      eesim.js bits -> ${fmtS(sa)}\n      CRT pow bits  -> ${fmtS(sb)}`); break; }
		}
	}
}

// ================================================================ the app (a temp copy of src/)
function makeSandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-review-'));
	const src = path.join(dir, 'src');
	fs.mkdirSync(path.join(src, 'app'), { recursive: true });
	for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(src, f)); }
	fs.copyFileSync(path.join(SRC, 'app', 'index.html'), path.join(src, 'app', 'index.html'));
	process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
	return { dir, src, J: require(path.join(src, 'jobs.js')), C: require(path.join(src, 'common.js')), R: require(path.join(src, 'render.js')) };
}
function request(port, method, p, body, headers) {
	return new Promise((resolve) => {
		const h = Object.assign(body ? { 'Content-Length': body.length } : {}, headers || {});
		const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const b = Buffer.concat(chunks);
				let json = null;
				try { json = JSON.parse(b.toString('utf8')); } catch (e) { /* not JSON */ }
				resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: b, json });
			});
		});
		rq.on('error', (e) => resolve({ status: -1, error: e.message }));
		rq.end(body || undefined);
	});
}
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
async function errOfAsync(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function appSection() {
	section('app: jobs / server / grind / render / common (in a temp copy of src/)');
	const S = makeSandbox();
	const { J, C } = S;
	const listing = () => [...(fs.existsSync(C.JOBS) ? fs.readdirSync(C.JOBS) : []), ...(fs.existsSync(C.DATA) ? fs.readdirSync(C.DATA) : [])].sort().join(',');
	// a level the TAS finishes: walk right over levitation 418 #1, multijump 461 #2 and jump effect 417 #1 to the finish
	const W = 32, H = 8;
	const appLevel = writeEelvl({ W, H, records: [...wallRecords(W, H, 6), { id: 255, xs: [2], ys: [5] }, { id: 418, xs: [6], ys: [5], args: [1] },
		{ id: 461, xs: [9], ys: [5], args: [2] }, { id: 417, xs: [12], ys: [5], args: [1] }, { id: 121, xs: [28], ys: [5] }] });
	const meta = J.importJob({ eelvl: appLevel, eetas: Buffer.from('4'.repeat(300)), name: 'review app', eelvlName: 'app.eelvl', eetasName: 'app.eetas' });
	const id = meta.id, dir = J.jobDir(id);
	check(`a finishing job imports (${meta.tas.time}, run_ticks ${meta.tas.runTicks})`, meta.tas.completeTick > 0);

	// ---- import limits (checked before anything is sized by the file) and messages
	const before = listing();
	let t0 = Date.now();
	let e = errOf(() => J.importJob({ eelvl: writeEelvl({ W: 8, H: 6, records: [...wallRecords(8, 6), { id: 3000000, xs: [3], ys: [2] }] }), eetas: Buffer.from('000') }));
	check('a level with block id 3000000 is refused at once with a clear message, nothing left behind', e && /not an EEO level: block id 3000000/.test(e.message) &&
		Date.now() - t0 < 1500 && listing() === before, e ? `${Date.now() - t0} ms: ${e.message}` : 'imported');
	t0 = Date.now();
	e = errOf(() => J.importJob({ eelvl: writeEelvl({ W: 2100, H: 2000, records: [{ id: 255, xs: [5], ys: [5] }] }), eetas: Buffer.from('000') }));
	check('a 2100 x 2000 level (4.2 million tiles) is refused before the engine tables are built', e && /million tiles/.test(e.message) && Date.now() - t0 < 3000 && listing() === before,
		e ? `${Date.now() - t0} ms: ${e.message}` : 'imported');
	t0 = Date.now();
	e = errOf(() => J.importJob({ eelvl: appLevel, eetas: Buffer.alloc(J.MAX_TICKS + 1, 0x34) }));
	check(`an .eetas of ${J.MAX_TICKS + 1} ticks is refused before it is replayed`, e && /limit is 5000000 ticks/.test(e.message) && Date.now() - t0 < 2000 && listing() === before,
		e ? `${Date.now() - t0} ms: ${e.message}` : 'imported');
	// random portals where no exit lets the TAS finish (both exits in closed boxes), with CR LF bytes at the end
	const rp = writeEelvl({ W: 20, H: 8, records: [...wallRecords(20, 8), { id: 9, xs: [1, 2, 3, 4, 5, 6, 7, 8], ys: [5, 5, 5, 5, 5, 5, 5, 5] }, { id: 255, xs: [2], ys: [4] },
		{ id: 242, xs: [4], ys: [4], args: [0, 1, 2] }, { id: 242, xs: [12, 16], ys: [2, 2], args: [0, 2, 2] },
		{ id: 9, xs: [11, 13, 12, 15, 17, 16], ys: [2, 2, 3, 2, 2, 3] }] });
	e = errOf(() => J.importJob({ eelvl: rp, eetas: Buffer.concat([Buffer.from('4'.repeat(60)), Buffer.from('\r\n'.repeat(5), 'latin1')]) }));
	check('random portals, no finishing exit: the message says how many random exit choices, and to check the .eetas (10 line-break bytes)',
		e && /random portals \(1 random exit choice\)/.test(e.message) && /Check that the \.eetas belongs to this level \(it contains 10 bytes/.test(e.message) && listing() === before,
		e ? e.message : 'imported');

	// ---- Finish report: shown only while it describes the current best (time and odds)
	const rep = J.finishReport(id);
	const shown = () => !!J.summary(id).report;
	const s1 = shown();
	J.updateStatus(id, { bestRunTicks: rep.runTicks - 1 });
	const s2 = shown();
	J.updateStatus(id, { bestRunTicks: rep.runTicks, chance: 0.5 });
	const s3 = shown();
	J.updateStatus(id, { chance: rep.chance });
	const s4 = shown();
	check('the Finish report is shown for its own best only (hidden after a faster run, or one of the same time with other odds)', s1 && !s2 && !s3 && s4, `${s1} ${s2} ${s3} ${s4}`);

	// ---- where: effects, and "ahead" when not moving sideways
	const level = J.loadJobLevel(id);
	const best = C.readEetas(path.join(dir, 'best.eetas'));
	const tr = C.replay(level, best, { trace: true });
	let tPast = 0;
	while (tPast < tr.n && tr.X[tPast] < 14 * 16) tPast++;
	const w = J.where(level, best, `t${tPast}`);
	const wt = J.formatWhere(w);
	check('where lists the active effects (levitation, multijump 2, jump effect 1)', /levitation \(thrust 0\.00; J thrusts, no jumps\)/.test(wt) && /multijump 2/.test(wt) &&
		/jump effect 1 \(jump x1\.3\)/.test(wt), (wt.split('\n').find((l) => l.startsWith('effects')) || 'no effects line').trim());
	const w0 = J.formatWhere(J.where(level, best, 't0'));
	check('where at rest: "ahead -" instead of the centre tile', /ahead {2}- {2}\(not moving sideways\)/.test(w0) && J.where(level, best, 't0').tiles.ahead === null);

	// ---- cosmetic: status right after start, m:ss with seconds >= 60
	const sm = Object.assign(J.summary(id), { running: true, pid: 1, optimizingSince: null });
	check('status right after `start` says "since -"', /since -, round/.test(J.formatStatus(sm)));
	const pe = errOf(() => C.parseTime('9:99.99'));
	check('parseTime refuses m:ss with seconds >= 60 (9:99.99, 1:60) and keeps 1:59.99', pe && /below 60/.test(pe.message) && errOf(() => C.parseTime('1:60')) &&
		C.parseTime('1:59.99').run === 11999, pe ? pe.message : 'accepted');

	// ---- probe / render / try limits
	t0 = Date.now();
	e = errOf(() => J.parseInputs('R x999999999'));
	check(`probe inputs are capped at ${J.MAX_PROBE_INPUTS} ticks (refused at once, no gigabyte array)`, e && /too many inputs/.test(e.message) && Date.now() - t0 < 200 &&
		J.parseInputs(`R x${J.MAX_PROBE_INPUTS}`).length === J.MAX_PROBE_INPUTS, e ? `${Date.now() - t0} ms` : 'accepted');
	const lj = C.readJSON(J.levelJsonOf(id), null);
	const png = errOf(() => { const o = J.renderJob(level, lj, best, 't0', 't60', { margin: NaN, scale: NaN }); if (!o.png || o.png.length < 100) throw new Error('no png'); });
	check('render with margin / scale NaN (?margin=abc) uses the defaults', png === null, png ? png.message : undefined);
	const big = S.R.renderPath({ levelJson: lj, trace: tr, from: 0, to: tr.n, scale: 48, margin: 1000, maxPixels: 200000 });
	check('render lowers the scale to stay within maxPixels (default 60 Mpx)', big.width * big.height <= 200000 && big.scale < 48, `${big.width}x${big.height} at ${big.scale} px per tile`);
	e = errOf(() => S.R.renderPath({ levelJson: lj, trace: tr, from: 0, to: tr.n, margin: 1000, maxPixels: 1000 }));
	check('a region too large even at 2 px per tile is refused with a clear error', e && /too large to draw/.test(e.message), e ? e.message : 'rendered');
	e = await errOfAsync(() => J.tryCandidate(id, Buffer.alloc(J.MAX_TICKS + 1, 0x34), {}));
	check('try refuses a candidate longer than the tick limit before replaying it', e && /limit is 5000000 ticks/.test(e.message), e ? e.message : 'accepted');
	// focus: an empty window is refused before its folder is made
	const fBefore = fs.existsSync(path.join(dir, 'focus')) ? fs.readdirSync(path.join(dir, 'focus')).length : 0;
	e = await errOfAsync(() => J.focus(id, '9:00', '9:10', 10, { log: () => {} }));
	const fAfter = fs.existsSync(path.join(dir, 'focus')) ? fs.readdirSync(path.join(dir, 'focus')).length : 0;
	check('focus refuses an empty window without leaving a focus/<stamp>/ folder', e && /empty window/.test(e.message) && fAfter === fBefore, e ? e.message : 'started');

	// ---- the HTTP server (required as a module: it only listens here, no benchmark, no resume)
	const SV = require(path.join(S.src, 'server.js'));
	await new Promise((res) => SV.server.listen(0, '127.0.0.1', res));
	const port = SV.server.address().port;
	try {
		let r = await request(port, 'POST', '/api/jobs', Buffer.from('null'), { 'Content-Type': 'application/json' });
		check('POST /api/jobs with the JSON null: 400 "expected a JSON object"', r.status === 400 && r.json && /expected a JSON object/.test(r.json.error), `${r.status} ${r.json && r.json.error}`);
		t0 = Date.now();
		r = await request(port, 'POST', '/api/jobs', Buffer.alloc((96 << 20) + (1 << 20), 0x41), { 'Content-Type': 'application/json' });
		const r2 = await request(port, 'GET', '/api/state');
		check('POST /api/jobs over the 96 MB limit: a 400 "upload too large" reply (not a connection reset), and the server still answers', r.status === 400 && r.json &&
			/upload too large \(limit 96 MB\)/.test(r.json.error) && r2.status === 200, `${r.status} ${r.error || (r.json && r.json.error)} in ${Date.now() - t0} ms; state ${r2.status}`);
		r = await request(port, 'POST', `/api/jobs/${id}/try`, Buffer.from('null'), { 'Content-Type': 'application/json' });
		check('POST try with the JSON null: 400 "missing eetasB64"', r.status === 400 && r.json && /missing eetasB64/.test(r.json.error), `${r.status} ${r.json && r.json.error}`);
		r = await request(port, 'GET', `/api/jobs/${id}/render.png?from=0:00&to=0:30&margin=abc`);
		check('GET render.png?margin=abc: a PNG', r.status === 200 && /image\/png/.test(r.type) && r.body.length > 100, `${r.status} ${r.type}`);
		const focusJson = path.join(dir, 'focus.json');
		const fj0 = fs.existsSync(focusJson) ? fs.readFileSync(focusJson, 'utf8') : null;
		r = await request(port, 'POST', `/api/jobs/${id}/focus`, Buffer.from(JSON.stringify({ from: '0:50', to: '0:40', seconds: 10 })), { 'Content-Type': 'application/json' });
		const fj1 = fs.existsSync(focusJson) ? fs.readFileSync(focusJson, 'utf8') : null;
		check('POST focus with "To" before "From": 400 "empty range", focus.json unchanged', r.status === 400 && r.json && /empty range/.test(r.json.error) && fj0 === fj1,
			`${r.status} ${r.json && r.json.error}`);
		t0 = Date.now();
		r = await request(port, 'POST', `/api/jobs/${id}/probe`, Buffer.from(JSON.stringify({ at: '0', inputs: 'R x999999999' })), { 'Content-Type': 'application/json' });
		check('POST probe with 999999999 inputs: 400 "too many inputs" at once', r.status === 400 && r.json && /too many inputs/.test(r.json.error) && Date.now() - t0 < 2000,
			`${r.status} in ${Date.now() - t0} ms`);
		r = await request(port, 'GET', `/api/jobs/${id}/where?t=0&format=text`);
		check('GET where?t=0&format=text: "ahead -"', r.status === 200 && /ahead {2}- /.test(r.body.toString('utf8')));
		// ---- the viewer: level lookup numbers and the level clock; EE graphics from an eeo-tas folder (a tiny fake one here)
		r = await request(port, 'GET', `/api/jobs/${id}/level`);
		const r3 = await request(port, 'GET', `/api/jobs/${id}/trajectory?which=best`);
		check('GET level has the lookup numbers ([index, int]: the levitation / multijump / jump effect values), trajectory the level clock at tick 0',
			r.status === 200 && Array.isArray(r.json.lookup) && r.json.lookup.length === 3 && r.json.lookup.some((e) => e[1] === 2) && r3.json && r3.json.clock0 === 0,
			`${r.status} ${JSON.stringify(r.json && r.json.lookup)} clock0 ${r3.json && r3.json.clock0}`);
		const page = fs.readFileSync(path.join(S.src, 'app', 'index.html'), 'utf8');
		const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
		check('the page\'s script parses', scripts.length > 0 && scripts.every((s) => !errOf(() => new Function(s))), scripts.map((s) => { const x = errOf(() => new Function(s)); return x ? x.message : 'ok'; }).join('; '));
		const fake = path.join(S.dir, 'fake-eeo-tas');
		fs.mkdirSync(path.join(fake, 'media'), { recursive: true });
		fs.mkdirSync(path.join(fake, 'src', 'items'), { recursive: true });
		const sheet = S.R.encodePng(64, 16, new S.R.Canvas(64, 16, [10, 20, 30]).p);
		fs.writeFileSync(path.join(fake, 'media', 'blocks.png'), sheet);
		fs.writeFileSync(path.join(fake, 'media', 'blocks_special.png'), sheet);
		fs.writeFileSync(path.join(fake, 'src', 'items', 'ItemId.as'), 'package items { public class ItemId {\n public static const ONEWAY_CYAN:int = 1001;\n' +
			' public static const COINDOOR:int = 43;\n public static function isBlockRotateable(itemId:int):Boolean { switch (itemId) { case ONEWAY_CYAN: return true; } return false; }\n} }');
		fs.writeFileSync(path.join(fake, 'src', 'items', 'ItemManager.as'), [
			'package items { public class ItemManager {',
			'  [Embed(source="/../media/blocks.png")] private static var blocksBM:Class;',
			'  private static var blocksBMD:BitmapData = new blocksBM().bitmapData;',
			'  [Embed(source="/../media/blocks_special.png") ] protected static var specialBlocksBM:Class;',
			'  private static var specialBlocksBMD:BitmapData = new specialBlocksBM().bitmapData;',
			'  public static var sprOnewayCyan:BlockSprite = new BlockSprite(specialBlocksBMD, 1,0,16,16,specialBlocksBMD.width/16 - 2, true);',
			'  public static function init():void {',
			'    b.addBrick(createBrick(9, ItemLayer.FORGROUND, blocksBMD, "", "", ItemTab.BLOCK, false, true, 2, 0xFF6E6E6E, ["Grey"]));',
			'    b.addBrick(createBrick(ItemId.COINDOOR, ItemLayer.DECORATION, blocksBMD, "", "", ItemTab.ACTION, false, true, 3, -1)); // createBrick(1, junk',
			'    /* createBrick(2, ItemLayer.FORGROUND, blocksBMD, "", "", 0, false, true, 1, 0) */',
			'    b.addBrick(createBrick(ItemId.ONEWAY_CYAN, ItemLayer.DECORATION, specialBlocksBMD, "", "", ItemTab.BLOCK, false, false, 240-238, -1));',
			'  }',
			'  public static function getRotateableSprite(type:int):BlockSprite { switch (type) { case ItemId.ONEWAY_CYAN: return sprOnewayCyan; default: return null; } }',
			'} }'].join('\n'));
		const post = (b) => request(port, 'POST', '/api/eegfx', Buffer.from(JSON.stringify(b)), { 'Content-Type': 'application/json' });
		r = await post({ dir: fake });
		const g = r.json || {};
		check('POST /api/eegfx {dir: an eeo-tas folder}: the sprite map from its ItemManager.as (id -> sheet, frame, y, layer, shadow; sprites; morphables)',
			r.status === 200 && g.available === true && g.source === 'settings' && JSON.stringify(g.sheets) === '["blocks","blocks_special"]' &&
			JSON.stringify(g.blocks) === '{"9":[0,2,0,0,1],"43":[0,3,0,2,1],"1001":[1,2,0,2,0]}' && JSON.stringify(g.sprites) === '{"sprOnewayCyan":[1,1,2,1]}' &&
			g.rot[1001] === 'sprOnewayCyan' && g.ids.COINDOOR === 43 && fs.existsSync(path.join(S.C.DATA, 'eegfx.json')) &&
			C.readJSON(path.join(S.C.DATA, 'settings.json'), {}).eegfxDir === fake, `${r.status} ${JSON.stringify(g).slice(0, 400)}`);
		r = await request(port, 'GET', '/api/eegfx/sheet/blocks.png');
		const bad = [];
		for (const p of ['..%2F..%2Fsrc%2Fitems%2FItemManager.as', '..%5Cmedia%5Cblocks.png', 'ItemManager.png', 'blocks_bg.png', '%2e%2e.png']) {
			const x = await request(port, 'GET', `/api/eegfx/sheet/${p}`);
			if (x.status !== 404) bad.push(`${p}: ${x.status}`);
		}
		check('GET /api/eegfx/sheet/<name>.png serves the map\'s sheets from the eeo-tas media folder and nothing else', r.status === 200 && /image\/png/.test(r.type) &&
			Buffer.compare(r.body, sheet) === 0 && !bad.length, `${r.status} ${r.type}; ${bad.join(', ')}`);
		const e1 = await post({ dir: path.join(S.dir, 'no-such-folder') }), e2 = await post({ dir: S.dir });
		check('POST /api/eegfx refuses a folder that is not eeo-tas (400 with the reason), the setting stays', e1.status === 400 && /does not exist/.test(e1.json.error) &&
			e2.status === 400 && /no media\/blocks\.png/.test(e2.json.error) && C.readJSON(path.join(S.C.DATA, 'settings.json'), {}).eegfxDir === fake,
			`${e1.status} ${e1.json && e1.json.error} | ${e2.status} ${e2.json && e2.json.error}`);
		r = await post({ dir: '' });
		check('POST /api/eegfx {dir: ""}: back to finding eeo-tas by itself (available, or not with the reason why)', r.status === 200 && !('eegfxDir' in C.readJSON(path.join(S.C.DATA, 'settings.json'), {})) &&
			(r.json.available === true ? r.json.source !== 'settings' : typeof r.json.why === 'string' && /eeo-tas/.test(r.json.why)), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
	} finally {
		await new Promise((res) => SV.server.close(res));
	}

	// ---- the grind's inbox verdict for a slower run: chance null (not computed), not 0
	const slower = Uint8Array.from([...best.slice(0, 20), 0, ...best.slice(20), ...new Array(40).fill(4)]);   // (a no-input tick, then right to the end)
	const ev = C.evaluate(level, slower);
	if (!ev || ev.runTicks <= meta.tas.runTicks) { check('a slower candidate for the grind test', false, ev ? `${ev.runTicks}` : 'does not finish'); return; }
	const inbox = path.join(dir, 'inbox');
	fs.mkdirSync(inbox, { recursive: true });
	C.writeJSON(path.join(inbox, 'slower.eetas.json'), { source: 'review', submitted: Date.now() });
	C.writeEetas(path.join(inbox, 'slower.eetas'), slower);
	const dl = new Date(Date.now() + 120e3);   // a deadline 1-2 min ahead: the grind checks the inbox, runs no stage and exits
	const until = `${dl.getHours()}:${String(dl.getMinutes()).padStart(2, '0')}`;
	const ch = spawn(process.execPath, [path.join(S.src, 'grind.js'), `--job=${dir}`, `--level=${C.jobLevelId(id)}`, `--until=${until}`, '--workers=1'],
		{ cwd: S.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	let out = '';
	ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
	const code = await new Promise((res) => {
		const kill = setTimeout(() => { try { ch.kill(); } catch (e2) { /* gone */ } res('timeout'); }, 90e3);
		ch.on('exit', (c) => { clearTimeout(kill); res(c); });
	});
	let rec = null;
	try { rec = JSON.parse(fs.readFileSync(path.join(inbox, 'results.jsonl'), 'utf8').trim().split('\n').pop()); } catch (e2) { /* none */ }
	check(`the grind rejects a slower inbox run (${C.fmt(ev.runTicks)}) with chance null (not computed), not 0`, code === 0 && rec && rec.accepted === false && rec.chance === null &&
		/slower/.test(rec.reason), rec ? JSON.stringify(rec) : `exit ${code}: ${out.slice(-300)}`);
}

// ================================================================ run
module.exports = { kitchenSink, randMasks, teleports, applyTp, partA, partB, partC, mkLevel, writeEelvl, wallRecords, loadRecords };
if (require.main === module) (async () => {
	if (want('music')) musicSection();
	if (want('portals')) portalsSection();
	if (want('keys')) keysSection();
	if (want('fuzz')) fuzzSection();
	if (want('real')) realSection();
	if (want('drag')) dragSection();
	if (want('app')) { try { await appSection(); } catch (e) { check('app section', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); } }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
