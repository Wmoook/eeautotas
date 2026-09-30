'use strict';
// The switch maps keep no `false` entry for a switch that has none (eesim.js _swSet / _oswSet, n4audit-engine): a
// reset switch numbered 1000 (Me.as:173-184: pressPurpleSwitch(1000, false) / state.pressOrangeSwitch(1000, false),
// which set 0..999 off, Player.as:1570-1581, PlayState.as:227-237) left 1001 `false` entries in every later state's map.
// The AS3 stores false too, but every reader tests truthiness (World.as:709-713, Me.as:164-181), where false and a
// missing key are the same; eesim's readers test `=== true`. This checks that nothing observable changed:
//  1. a hand-built walk (spawn, purple switch 3, its door, a reset 1000, its gate; an orange switch 4 and a reset 1000)
//     gives the hand-computed switch events (on at the switch, off at the reset, the door / gate states), the ball walks
//     through both doors, and the maps hold only the switches that were on (not 1001 entries);
//  2. the same inputs with the old _swSet / _oswSet (explicit false entries): the same state (every field the physics
//     reads, stateHash with and without coins, the on-sets, the queues, the events) after every tick;
//  3. the overlap revert: pressing a reset 1000 while the box already overlaps a wall turns 0..999 on and queues 1000
//     retries, in both versions alike (Player.as:1577-1580);
//  4. random sticky inputs on the walk level and (with --levels=<dir>, default src/out/god/levels/campaign when present)
//     the campaign's two levels with a reset 1000: CTM 2 and Evolution Revolution, both versions tick by tick.
// usage: node test/switchmap.js [--levels=<dir>] [--ticks=N]
const fs = require('fs');
const path = require('path');
const E = require('../src/eesim.js');
const V = require('../src/eelvl.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
/** W x H, a border of 9, a floor row at y = H - 2 (the ball walks on row H - 3); tiles [[x, y, id, int?]] */
function mkLevel(W, H, tiles, spawn) {
	const fg = new Int32Array(W * H);
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; fg[(H - 2) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	const extras = [], li = [];
	for (const [x, y, id, a] of tiles) { fg[y * W + x] = id; if (a !== undefined) { extras.push([y * W + x, a, null, null]); li.push([y * W + x, a]); } }
	return E.prepareLevel({ format: 'eesim-level-1', level_id: 'switchmap', width: W, height: H, gravity_hex: f64hex(1), gravity: 1,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras, lookup_int: li, spawn_points: [[spawn]] });
}
/** the sim with the switch maps as before this change (an explicit false entry for every switch set off) */
function oldSim(level) {
	const s = new E.EESim(level);
	s._swSet = function (id, v) {
		if (!this._swOwned) { this._switches = new Map(this._switches); this._swOwned = true; }
		this._switches.set(id, v); this._switches._key = undefined;
	};
	s._oswSet = function (id, v) {
		if (!this._oswOwned) { this._oswitches = new Map(this._oswitches); this._oswOwned = true; }
		this._oswitches.set(id, v); this._oswitches._key = undefined;
	};
	s.reset();
	return s;
}
const onSet = (m) => [...m].filter(([, v]) => v === true).map(([k]) => k).sort((a, b) => a - b).join(',');
function stateOf(s) {
	return [s.px, s.py, s.speed_x, s.speed_y, s.modifier_x, s.modifier_y, s.on_ground, s.is_dead, s.deaths, s.coins, s.jump_count,
		s._keysMask, s._timedoor_state, s.overlapa, s.overlapb, s.overlapc, s.overlapd, s._pastx, s._pasty, s._q0, s._q1, s.run_ticks,
		onSet(s._switches), onSet(s._oswitches), s._stateQueue.join(' '), s._keysQueue.join(' '), s._tileQueue.join(' '),
		s.stateHash(false, false), s.stateHash(false, true), s.stateKey()].join('|');
}
/** plays masks in the new and the old version; returns the first tick where anything differs (-1 none) and both sims */
function twin(level, masks) {
	const a = new E.EESim(level), b = oldSim(level);
	const ea = [], eb = [];
	a.onEvent = (k, d) => ea.push(k + JSON.stringify(d)); b.onEvent = (k, d) => eb.push(k + JSON.stringify(d));
	const ia = new E.EEInput(), ib = new E.EEInput();
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(ia, masks[t]); a.tick(ia);
		E.applyMask(ib, masks[t]); b.tick(ib);
		if (stateOf(a) !== stateOf(b) || ea.length !== eb.length || ea[ea.length - 1] !== eb[eb.length - 1]) return { bad: t + 1, a, b, ea, eb };
	}
	return { bad: -1, a, b, ea, eb };
}
function rnd(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function sticky(n, seed) {
	const r = rnd(seed), out = new Uint8Array(n);
	for (let i = 0; i < n;) { let m = (r() * 32) | 0; if (r() < 0.5) m &= ~2; const len = 1 + ((r() * 40) | 0); for (let k = 0; k < len && i < n; k++) out[i++] = m; }
	return out;
}

// ---------------------------------------------------------------- 1. the walk, by hand
// row 4: spawn (2, 4), purple switch 3 (5, 4), purple door 3 (9, 4), reset purple 1000 (12, 4), purple gate 3 (15, 4),
// orange switch 4 (18, 4), orange door 4 (21, 4), reset orange 1000 (24, 4), orange gate 4 (27, 4), open to x 30.
console.log('\n== 1. the walk: switch on, door open, reset 1000, gate open (purple, then orange)');
const walk = mkLevel(32, 7, [[5, 4, 113, 3], [9, 4, 184, 3], [12, 4, 1619, 1000], [15, 4, 185, 3],
	[18, 4, 467, 4], [21, 4, 1079, 4], [24, 4, 1620, 1000], [27, 4, 1080, 4]], [2, 4]);
{
	const sim = new E.EESim(walk);
	const ev = [];
	sim.onEvent = (k, d) => { if (k === 'switch') ev.push({ t: sim.ticks(), kind: d.kind, id: d.id, on: d.on, x: (sim.px + 8) >> 4 }); };
	const inp = new E.EEInput();
	let maxP = 0, maxO = 0, t = 0;
	const cellAt = {};
	for (; t < 600 && sim.px < 29 * 16; t++) {
		E.applyMask(inp, 4); sim.tick(inp);
		const cx = Math.trunc(sim.px + 8) >> 4;
		if (cellAt[cx] === undefined) cellAt[cx] = sim.ticks();
		maxP = Math.max(maxP, sim._switches.size); maxO = Math.max(maxO, sim._oswitches.size);
	}
	// hand-computed: switch 3 turns on the tick the centre enters (5, 4); the reset 1000 turns it off the tick the centre
	// enters (12, 4) (touchBlock after movement: the tick-start cell of the NEXT tick sees it, so compare to cellAt);
	// the same for orange 4 at (18, 4) and (24, 4); nothing else switches
	const p = ev.filter((e) => e.kind === 'purple'), o = ev.filter((e) => e.kind === 'orange');
	check('purple: on at the switch, off at the reset (1000 off: only switch 3 had been on)', p.length === 2 && p[0].id === 3 && p[0].on && p[1].id === 3 && !p[1].on,
		JSON.stringify(p));
	check('orange: on at the switch, off at the reset', o.length === 2 && o[0].id === 4 && o[0].on && o[1].id === 4 && !o[1].on, JSON.stringify(o));
	check('the switch events follow the cells in order (5 < 12 < 18 < 24)', p.length === 2 && o.length === 2 && p[0].t < p[1].t && p[1].t < o[0].t && o[0].t < o[1].t &&
		p[0].t >= cellAt[5] && p[1].t >= cellAt[12] && o[0].t >= cellAt[18] && o[1].t >= cellAt[24], JSON.stringify(cellAt));
	check('the ball walked through the purple door, the purple gate, the orange door and the orange gate', sim.px >= 29 * 16, `px ${sim.px} after ${t} ticks`);
	check('the maps hold only the switches that were on (not 1001 entries)', maxP === 1 && maxO === 1 && sim._switches.size === 1 && sim._oswitches.size === 1,
		`largest ${maxP} / ${maxO}, now ${sim._switches.size} / ${sim._oswitches.size}`);
	const old = oldSim(walk);
	for (let k = 0; k < t; k++) { E.applyMask(inp, 4); old.tick(inp); }
	check('the old version: 1001 entries after the reset, the same on-set and position', old._switches.size === 1001 && old._oswitches.size === 1001 &&
		onSet(old._switches) === onSet(sim._switches) && old.px === sim.px && old.stateHash() === sim.stateHash(), `${old._switches.size} / ${old._oswitches.size}`);
	const tw = twin(walk, new Uint8Array(t).fill(4));
	check('2. the walk: new and old the same state and events after every tick', tw.bad < 0, tw.bad < 0 ? `${t} ticks` : `differs at tick ${tw.bad}`);
}

// ---------------------------------------------------------------- 3. the overlap revert
console.log('\n== 3. a reset 1000 pressed while the box overlaps a wall: 0..999 back on, 1000 retries queued (both versions)');
{
	const res = [];
	for (const mk of [(l) => { const s = new E.EESim(l); return s; }, oldSim]) {
		const s = mk(walk);
		s.px = 16 * 1 - 4; s.py = 16 * 4;   // the box overlaps the left border wall (x 0)
		s._pressPurpleSwitch(1000, false);
		s._pressOrangeSwitch(1000, false);
		res.push({ on: onSet(s._switches).split(',').length, oon: onSet(s._oswitches).split(',').length, tq: s._tileQueue.length / 2, sq: s._stateQueue.length / 3, h: s.stateHash() });
	}
	check('new: switches 0..1000 on (reverted), 1001 retries each', res[0].on === 1001 && res[0].oon === 1001 && res[0].tq === 1001 && res[0].sq === 1001, JSON.stringify(res[0]));
	check('old: the same', JSON.stringify({ ...res[0], h: 0 }) === JSON.stringify({ ...res[1], h: 0 }) && res[0].h === res[1].h, JSON.stringify(res[1]));
}

// ---------------------------------------------------------------- 4. random runs
console.log('\n== 4. random sticky inputs: new and old tick by tick');
const TICKS = +arg('ticks', 20000);
{
	// the walk level with every switch kind twice more and a jump room
	const lv = mkLevel(40, 12, [[5, 9, 113, 3], [9, 9, 184, 3], [12, 9, 1619, 1000], [15, 9, 185, 3], [18, 9, 467, 4], [21, 9, 1079, 4],
		[24, 9, 1620, 1000], [27, 9, 1080, 4], [30, 9, 113, 1000], [33, 9, 1619, 3], [8, 6, 113, 7], [8, 7, 185, 7], [14, 6, 467, 1000],
		[20, 6, 1620, 4], [26, 7, 184, 1000], [26, 6, 1080, 1000], [12, 5, 9], [13, 5, 9], [22, 5, 9], [23, 5, 9]], [2, 9]);
	let bad = 0;
	for (let seed = 1; seed <= 6; seed++) {
		const tw = twin(lv, sticky(TICKS, seed));
		if (tw.bad >= 0) { bad++; console.log(`     seed ${seed}: differs at tick ${tw.bad}`); }
	}
	check(`the switch room, 6 x ${TICKS} ticks`, bad === 0);
}
const LV = arg('levels', path.join(__dirname, '..', 'src', 'out', 'god', 'levels', 'campaign'));
for (const f of ['33_6_CTM_2.eelvl', '03_2_Evolution_Revolution.eelvl']) {
	const p = path.join(LV, f);
	if (!fs.existsSync(p)) { console.log(`  (skip ${f}: not in ${LV})`); continue; }
	const level = V.loadEelvlLevel(p);
	let bad = 0, big = 0;
	for (let seed = 1; seed <= 4; seed++) {
		const tw = twin(level, sticky(TICKS, 100 + seed));
		if (tw.bad >= 0) { bad++; console.log(`     ${f} seed ${seed}: differs at tick ${tw.bad}`); }
		if (tw.b._switches.size > 900) big++;
	}
	check(`${f}: 4 x ${TICKS} ticks the same`, bad === 0, big ? `${big} of 4 old runs ended with 1000+ false entries` : undefined);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
