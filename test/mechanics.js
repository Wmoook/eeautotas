'use strict';
// Synthetic tests for the block mechanics of src/eesim.js, each asserting the eeo-tas (AS3) behavior derived from
// eeo-tas/src (Player.as, Me.as, World.as, PlayState.as; docs/eeo_spec): timed effects (curse 421, zombie 422 and
// NPC zombie 1573, poison 1584, fire), protection 420, effect reset 1618, levitation 418, teams 423 / 1027 / 1028,
// zombie gate 206 / door 207, the keyboard-only blocks (god block 1516, world portal 374, reset point 466), the
// solidity of every id against docs/eeo_spec/blocks.json, the AS3 lookup table (lookup_int), and snapshot / restore /
// stateKey / stateHash soundness with the new state.
// usage: node test/mechanics.js [--quick]
// Exit code 1 if any check fails. Node built-ins only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../src/eesim.js');
const V = require('../src/eelvl.js');

const QUICK = process.argv.includes('--quick');
const SAMPLES = process.env.EEAT_LEVELS || require('path').join(require('os').homedir(), 'Downloads');
const MULT = 7.752;

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++;
	else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
function section(s) { console.log(`\n== ${s}`); }

// ---------------------------------------------------------------- tiny levels (toSimLevel's JSON format)
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
/**
 * W x H with a border of block 9 and a floor row at y = H - 2 (so with H = 7 the player walks on row 4, py = 64);
 * tiles [[x, y, id, int?]] (int = the record's number, exported like toSimLevel: extras AND lookup_int, unless
 * noLookupInt); spawns [[x, y]] = spawnPoints[0] in file order.
 */
function mkLevel({ W = 16, H = 7, tiles = [], spawns = [[2, 4]], floor = true, opts = {}, noLookupInt = false, lookupInt = null } = {}) {
	const fg = new Int32Array(W * H);
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; if (floor) fg[(H - 2) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	const extras = [], li = new Map();
	for (const [x, y, id, arg] of tiles) {
		fg[y * W + x] = id;
		if (arg !== undefined) { extras.push([y * W + x, arg, null, null]); li.set(y * W + x, arg); }
	}
	const d = { format: 'eesim-level-1', level_id: 'test', width: W, height: H, gravity_hex: f64hex(1), gravity: 1,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras, spawn_points: [spawns] };
	if (!noLookupInt) d.lookup_int = lookupInt || [...li];
	return E.prepareLevel(d, opts);
}

/** The state after a tick, for records and trajectory comparisons. */
function fields(s) {
	return { px: s.px, py: s.py, sx: s.speed_x, sy: s.speed_y, mx: s.modifier_x, my: s.modifier_y, dead: s.is_dead, deaths: s.deaths,
		cursed: s.is_cursed, zombie: s.is_zombie, poison: s.is_poisoned, fire: s.is_on_fire, inv: s.is_invulnerable,
		lev: s.has_levitation, thr: s._current_thrust, thrusting: s.is_thrusting, team: s.team, tx: s._team_tx, ty: s._team_ty,
		jb: s.jump_boost, sb: s.speed_boost, lg: s.low_gravity, mj: s.max_jumps, fgv: s.flip_gravity, coins: s.coins };
}
const physKey = (s) => [s.px, s.py, s.speed_x, s.speed_y, s.modifier_x, s.modifier_y, s.is_dead, s.deaths, s.is_cursed, s.is_zombie,
	s.is_poisoned, s.is_on_fire, s.is_invulnerable, s.has_levitation, s._current_thrust, s.is_thrusting, s.team, s.jump_count,
	s.on_ground, s.coins, s.run_ticks].join('|');

/** Runs a sim; maskFn(sim, t, events) gives the mask for tick t (1-based) or null to stop. rec[t] = state after tick t. */
function drive(level, simOpts, maxTicks, maskFn) {
	const sim = new E.EESim(level, simOpts);
	const inp = new E.EEInput();
	const ev = [];
	sim.onEvent = (k, d) => ev.push({ t: sim.ticks(), k, d });
	const rec = [fields(sim)];
	for (let t = 1; t <= maxTicks; t++) {
		const m = maskFn(sim, t, ev);
		if (m === null) break;
		E.applyMask(inp, m);
		sim.tick(inp);
		rec.push(fields(sim));
	}
	return { sim, rec, ev };
}
const RIGHT = 4, LEFT = 2, JUMP = 1, UP = 8;
const firstEv = (ev, k, pred) => { const e = ev.find((x) => x.k === k && (!pred || pred(x.d))); return e ? e.t : -1; };
const untilDeath = (m) => (sim, t, ev) => (ev.some((e) => e.k === 'death') ? null : (typeof m === 'function' ? m(sim, t, ev) : m));
/** Player.setEffect's duration, written literally: duration += 2 * Global.ping (0.2); duration *= 100. */
function effD(v) { let d = v; d += 2 * 0.2; d *= 100; return d; }

// ---------------------------------------------------------------- 1. curse
section('Curse 421: start = PlayState.ticks, D = (v + 0.4) * 100 in doubles, killed in the first tick with ticks - start > D');
{
	// elapsed ticks from the touch to the kill: floor(D) + 1; v = 16..20 and 256..327 kill one tick before 100v + 41
	const EXP = { 1: 141, 2: 241, 4: 441, 5: 541, 15: 1541, 16: 1640, 20: 2040, 21: 2141, 255: 25541, 256: 25640, 327: 32740, 328: 32841 };
	const got = [];
	let ok = true;
	for (const [vs, el] of Object.entries(EXP)) {
		const v = +vs;
		if (QUICK && v > 100) continue;
		const L = mkLevel({ tiles: [[4, 4, 421, v]] });
		const { ev, rec } = drive(L, {}, el + 400, untilDeath(RIGHT));
		const p = firstEv(ev, 'effect', (d) => d.effect === 'curse' && d.on), D = firstEv(ev, 'death');
		got.push(`${v}:${D - p}`);
		if (!(p > 0 && D - p === el && el === Math.floor(effD(v)) + 1 && rec.slice(p, D).every((r) => r.cursed))) ok = false;
	}
	check('kill after exactly floor((v + 0.4) * 100) + 1 ticks (1:141 2:241 16:1640 20:2040 21:2141 256:25640 327:32740 328:32841)', ok, got.join(' '));
	check('the doubles: D(16) = 1639.9999999999998, D(4) = 440.00000000000006, D(2) = 240', effD(16) === 1639.9999999999998 && effD(4) === 440.00000000000006 && effD(2) === 240);

	// re-touching while cursed does not refresh the timer (two curse blocks, the second one 10 s)
	const T2 = mkLevel({ tiles: [[4, 4, 421, 3], [8, 4, 421, 10]] });
	const r2 = drive(T2, {}, 2000, untilDeath(RIGHT));
	const p2 = firstEv(r2.ev, 'effect', (d) => d.effect === 'curse'), D2 = firstEv(r2.ev, 'death');
	check('a second curse block while cursed changes nothing (no refresh): killed at first touch + 341', D2 - p2 === 341 && r2.rec[D2 - 1].px > 7 * 16, `${D2 - p2}`);
	// number 0 lifts the curse
	const T3 = mkLevel({ tiles: [[4, 4, 421, 3], [7, 4, 421, 0]] });
	const r3 = drive(T3, {}, 1200, () => RIGHT);
	check('a curse block with number 0 lifts it (no death)', firstEv(r3.ev, 'death') < 0 && firstEv(r3.ev, 'effect', (d) => d.effect === 'curse' && !d.on) > 0 && !r3.sim.is_cursed);
	// respawn clears it; effect reset 1618 does not
	const T4 = mkLevel({ tiles: [[4, 4, 421, 1], [6, 4, 1618]] });
	const r4 = drive(T4, {}, 400, (sim, t, ev) => (ev.some((e) => e.k === 'death') ? 0 : RIGHT));
	const p4 = firstEv(r4.ev, 'effect', (d) => d.effect === 'curse'), D4 = firstEv(r4.ev, 'death');
	check('effect reset 1618 keeps the curse (resetEffects(false)): still killed at touch + 141', D4 - p4 === 141 && r4.rec[D4 - 1].px > 5 * 16, `${D4 - p4}`);
	check('death: cursed until the respawn at the end of tick D + 54, cleared by respawn()', r4.rec[D4 + 53].cursed && !r4.rec[D4 + 54].cursed && r4.rec[D4 + 54].px === 32);
	// L = 0 in the file (no number) never curses
	const T5 = mkLevel({ tiles: [[4, 4, 421]] });
	const r5 = drive(T5, {}, 400, () => RIGHT);
	check('a curse block without a number (getInt 0) does nothing', !r5.rec.some((r) => r.cursed));
}

// ---------------------------------------------------------------- 2. zombie
section('Zombie 422 / NPC zombie 1573: timer, speed x0.6, jump x0.75, zombie gate 206 / door 207');
{
	const L = mkLevel({ tiles: [[4, 4, 422, 3]] });
	const r = drive(L, {}, 800, untilDeath(RIGHT));
	const p = firstEv(r.ev, 'effect', (d) => d.effect === 'zombie' && d.on), D = firstEv(r.ev, 'death');
	check('zombie 3 s: killed at touch + 341', D - p === 341, `${D - p}`);
	check('while zombie, holding right gives modifierX = (0 + 1 * 0.6) / 7.752 (before: 1 / 7.752)',
		r.rec[p].mx === 1 / MULT && r.rec[p + 1].mx === (0 + 1 * (1 * 0.6)) / MULT, `${r.rec[p].mx} -> ${r.rec[p + 1].mx}`);
	// run effect 1 then zombie: sm = 1 * 1.5 * 0.6 (in that order)
	const LR = mkLevel({ tiles: [[3, 4, 419, 1], [5, 4, 422, 50]] });
	const rr = drive(LR, {}, 200, () => RIGHT);
	const pr = firstEv(rr.ev, 'effect', (d) => d.effect === 'zombie');
	let sm = 1; sm *= 1.5; sm *= 0.6;
	check('speed effect 1 and zombie: sm = (1 * 1.5) * 0.6 = 0.8999999999999999', rr.rec[pr + 1].mx === (0 + 1 * sm) / MULT && sm === 0.8999999999999999);
	// jumps: touch the block, stop, then one jump tick
	const jumpSpeed = (tiles) => {
		const Lj = mkLevel({ tiles });
		let stop = -1;
		const rj = drive(Lj, {}, 400, (sim, t, ev) => {
			if (stop < 0 && sim.px >= 5 * 16) stop = t;
			if (stop < 0) return RIGHT;
			return t === stop + 80 ? JUMP : 0;
		});
		return rj.rec[stop + 80].sy;
	};
	const jz = jumpSpeed([[3, 4, 422, 50]]), jn = jumpSpeed([]), jzb = jumpSpeed([[3, 4, 417, 1], [4, 4, 422, 50]]);
	let jm = 1; jm *= 1.3; jm *= 0.75;
	check('jump speed while zombie: ((-2 * 26) * 0.75) / 7.752 (normal: -52 / 7.752)', jz === ((0 - 2) * 26 * 0.75) / MULT && jn === ((0 - 2) * 26 * 1) / MULT, `${jz} / ${jn}`);
	check('jump effect 1 and zombie: jm = (1 * 1.3) * 0.75 (then slippery x0.88 if on ice)', jzb === ((0 - 2) * 26 * jm) / MULT, `${jzb}`);
	// doors
	const maxX = (tiles) => Math.max(...drive(mkLevel({ W: 16, tiles }), {}, 250, () => RIGHT).rec.map((q) => q.px));
	check('zombie GATE 206 (World.as:734): open for a normal player', maxX([[7, 4, 206]]) > 100);
	check('... solid for a zombie', maxX([[4, 4, 422, 50], [7, 4, 206]]) <= 96);
	check('zombie DOOR 207 (World.as:735): solid for a normal player', maxX([[7, 4, 207]]) <= 96);
	check('... open for a zombie', maxX([[4, 4, 422, 50], [7, 4, 207]]) > 100);
	// becoming a zombie inside the gate: no overlap revert, the gate closes on the player (stuck until the timer)
	const LS = mkLevel({ tiles: [[5, 4, 206], [6, 4, 422, 5]] });
	const rs = drive(LS, {}, 1000, untilDeath(RIGHT));
	const ps = firstEv(rs.ev, 'effect', (d) => d.effect === 'zombie'), Ds = firstEv(rs.ev, 'death');
	check('zombie touched with the box still in gate 206: stuck (no revert) until killed at touch + 541',
		rs.rec[ps].px < 96 && rs.rec.slice(ps + 1, Ds + 1).every((q) => q.px === rs.rec[ps + 1].px && q.py === rs.rec[ps + 1].py) && Ds - ps === 541,
		`px ${rs.rec[ps].px}, died after ${Ds - ps}`);
	// NPC zombie: permanent (duration 0), cleared by protection, lifted by a 422 with number 0
	const LN = mkLevel({ W: 20, tiles: [[4, 4, 1573], [12, 4, 420, 1]] });
	const rn = drive(LN, {}, 3000, (sim) => (sim.px < 6 * 16 ? RIGHT : 0));   // stops (slides) well before the protection
	const pn = firstEv(rn.ev, 'effect', (d) => d.effect === 'zombie');
	check('NPC zombie 1573: zombie with no death timer (3000 ticks, duration 0)', pn > 0 && firstEv(rn.ev, 'death') < 0 && rn.rec[2999].zombie && rn.sim._zombie_duration === 0);
	const rn2 = drive(LN, {}, 3000, () => RIGHT);
	check('... protection clears it', firstEv(rn2.ev, 'effect', (d) => d.effect === 'protection') > 0 && !rn2.sim.is_zombie && !rn2.rec[rn2.rec.length - 1].zombie);
	const rn3 = drive(mkLevel({ tiles: [[4, 4, 1573], [7, 4, 422, 0]] }), {}, 300, () => RIGHT);
	check('... a zombie block with number 0 lifts it', !rn3.sim.is_zombie && rn3.rec.some((q) => q.zombie));
	const rn4 = drive(mkLevel({ tiles: [[4, 4, 422, 3], [6, 4, 1573]] }), {}, 900, untilDeath(RIGHT));
	check('... an NPC zombie does not replace a running zombie timer (still killed at touch + 341)',
		firstEv(rn4.ev, 'death') - firstEv(rn4.ev, 'effect', (d) => d.effect === 'zombie') === 341);
	// the zombie getter reads false while flying (god mode test hook): no speed penalty
	const sg = new E.EESim(mkLevel({ tiles: [[3, 4, 422, 50]] })); const ig = new E.EEInput();
	for (let i = 0; i < 40; i++) { E.applyMask(ig, RIGHT); sg.tick(ig); }
	const mzA = sg.modifier_x; sg.set_god_mode(true); E.applyMask(ig, RIGHT); sg.tick(ig);
	check('zombie reads false while flying: god mode walks at 1 / 7.752', sg.is_zombie && mzA === 0.6 / MULT && sg.modifier_x === 1 / MULT);
}

// ---------------------------------------------------------------- 3. poison, protection, fire interplay
section('Poison 1584, protection 420 (blocks pickup, clears curse / zombie / poison / fire), fire');
{
	for (const [v, el] of [[3, 341], [16, 1640]]) {
		const r = drive(mkLevel({ tiles: [[4, 4, 1584, v]] }), {}, 2000, untilDeath(RIGHT));
		const got = firstEv(r.ev, 'death') - firstEv(r.ev, 'effect', (d) => d.effect === 'poison');
		check(`poison ${v} s: killed at touch + ${el}`, got === el, String(got));
	}
	const LP = mkLevel({ W: 20, tiles: [[3, 4, 421, 9], [4, 4, 422, 9], [5, 4, 1584, 9], [7, 4, 416], [10, 4, 420, 1]] });
	const rp = drive(LP, {}, 1400, () => RIGHT);
	const pp = firstEv(rp.ev, 'effect', (d) => d.effect === 'protection');
	check('curse, zombie, poison and fire all active, then protection turns them all off (no death)',
		rp.rec[pp - 1].cursed && rp.rec[pp - 1].zombie && rp.rec[pp - 1].poison && rp.rec[pp - 1].fire &&
		!rp.rec[pp].cursed && !rp.rec[pp].zombie && !rp.rec[pp].poison && !rp.rec[pp].fire && firstEv(rp.ev, 'death') < 0);
	const LB = mkLevel({ W: 20, tiles: [[3, 4, 420, 1], [5, 4, 421, 1], [6, 4, 422, 1], [7, 4, 1584, 1], [8, 4, 1573], [10, 4, 416], [13, 4, 361]] });
	const rb = drive(LB, {}, 600, () => RIGHT);
	check('while protected: no curse / zombie / poison / NPC zombie / fire pickup, and spikes do not kill',
		rb.rec.every((q) => !q.cursed && !q.zombie && !q.poison && !q.fire) && firstEv(rb.ev, 'death') < 0 && rb.sim.px > 13 * 16);
	const rb0 = drive(mkLevel({ W: 20, tiles: [[3, 4, 420, 1], [5, 4, 420, 0], [7, 4, 421, 1]] }), {}, 400, untilDeath(RIGHT));
	check('protection 0 turns it off again (then the curse works: killed at touch + 141)',
		firstEv(rb0.ev, 'death') - firstEv(rb0.ev, 'effect', (d) => d.effect === 'curse') === 141);
	// timed kills are checked at the top of Player.tick, before movement, in the order curse, zombie, fire, poison
	const LO = mkLevel({ tiles: [[3, 4, 416], [5, 4, 421, 2]] });
	const ro = drive(LO, {}, 700, untilDeath(RIGHT));
	check('fire (lava, D = 240) and curse 2 (D = 240) started 2 ticks apart: the earlier one kills, after 241 ticks',
		firstEv(ro.ev, 'death') === ro.rec.findIndex((q) => q.fire) + 241, `${firstEv(ro.ev, 'death')}`);
}

// ---------------------------------------------------------------- 4. effect reset
section('Effect reset 1618: resetEffects(false)');
{
	const L = mkLevel({ W: 24, tiles: [[3, 4, 417, 1], [4, 4, 419, 1], [5, 4, 453, 1], [6, 4, 461, 3], [7, 4, 421, 30], [8, 4, 423, 2],
		[9, 4, 418, 1], [10, 4, 420, 1], [12, 4, 1618]] });
	const r = drive(L, {}, 400, (sim) => (sim.px < 13 * 16 ? RIGHT : 0));
	// touchBlock uses the tick-START cell: the center enters cell 12 in tick pr, the block acts in tick pr + 1
	const pr = r.rec.findIndex((q) => q.px >= 12 * 16 - 8);
	const b = r.rec[pr], a = r.rec[pr + 1];
	check('before: jump 1, run 1, low gravity, multijump 3, cursed (then protected), team 2, levitating, protected',
		b.jb === 1 && b.sb === 1 && b.lg && b.mj === 3 && b.team === 2 && b.lev && b.inv && !b.cursed);
	check('after: jump 0, run 0, low gravity off, multijump 1, gravity 0, levitation off with thrust 0, protection off; team kept',
		a.jb === 0 && a.sb === 0 && !a.lg && a.mj === 1 && a.fgv === 0 && !a.lev && a.thr === 0 && !a.inv && a.team === 2);
}

// ---------------------------------------------------------------- 5. levitation
section('Levitation 418: thrust instead of jumps, updateThrust after touchBlock (also while dead), burn-off');
{
	// 418 on the spawn cell: touched in tick 1 (pastx/pasty start at 0,0)
	const L = mkLevel({ tiles: [[2, 4, 418, 1], [2, 3, 0]] });
	const R = 32;   // hold jump for ticks 2..R, then release
	const r = drive(L, {}, R + 40, (sim, t) => (t >= 2 && t <= R ? JUMP : 0));
	const expSy = (0 * MULT - (0.2 * 13) * (2 * 0.5)) / MULT;
	check('tick 1 touches 418: hasLevitation, thrust 0, not thrusting', r.rec[1].lev && r.rec[1].thr === 0 && !r.rec[1].thrusting);
	check('tick 2 (jump bit, on the floor): no jump; thrust 0.2, isThrusting; speedY = (0 * 7.752 - (0.2 * 13) * (2 * 0.5)) / 7.752',
		r.rec[2].thrusting && r.rec[2].thr === 0.2 && r.rec[2].sy === expSy && r.rec[2].sy !== -52 / MULT, `${r.rec[2].sy}`);
	check('holding jump flies up (py 64 -> ' + r.rec[R].py.toFixed(2) + ')', r.rec[R].py < 40 && r.ev.every((e) => e.k !== 'jump'));
	// burn-off after the release: the tick of the release applies 0.2 then decays (isThrusting = false in its jump block)
	const ref = []; let tt = 0.2;
	for (let k = 0; k < 30; k++) { if (tt > 0) tt -= 0.01; else tt = 0; ref.push(tt); }
	const got = []; for (let k = 0; k < 30; k++) got.push(r.rec[R + 1 + k].thr);
	check('release: thrust 0.19, 0.18, ..., 0.00999...97, -3.1e-17, then 0 (tick by tick, exact doubles)',
		got.every((x, k) => x === ref[k]) && got.includes(-3.122502256758253e-17) && got[25] === 0 && !r.rec[R + 1].thrusting,
		got.slice(17, 23).join(', '));
	// stale isThrusting while dead: cursed while flying, keep the jump bit (ignored while dead)
	const LD = mkLevel({ tiles: [[2, 4, 418, 1], [2, 3, 421, 1]] });
	const rd = drive(LD, {}, 400, (sim, t) => (t >= 2 ? JUMP : 0));
	const Dd = firstEv(rd.ev, 'death');
	check('killed while thrusting: isThrusting stays true while dead, so the thrust stays 0.2 (no burn-off)',
		Dd > 0 && rd.rec.slice(Dd, Dd + 54).every((q) => q.dead && q.thrusting && q.thr === 0.2));
	const rd2 = drive(LD, {}, 400, (sim, t, ev) => {
		const c = ev.find((e) => e.k === 'effect' && e.d.effect === 'curse');
		return t >= 2 && (!c || t < c.t + 141 - 5) ? JUMP : 0;
	});
	const Dd2 = firstEv(rd2.ev, 'death');
	// released in tick D - 5: after tick D - 5 + k the thrust is ref[k]
	check('released 5 ticks before the kill: the burn-off continues while dead',
		rd2.rec[Dd2 - 1].thr === ref[4] && rd2.rec[Dd2 + 10].thr === ref[15] && rd2.rec[Dd2 + 30].thr === 0 && rd2.rec[Dd2 + 10].dead && !rd2.rec[Dd2 + 10].thrusting,
		`${rd2.rec[Dd2 - 1].thr} ${rd2.rec[Dd2 + 10].thr}`);
	check('levitation survives death and respawn (respawn() does not reset it)', rd.rec[Dd + 54].lev && !rd.rec[Dd + 54].dead);
	// in a liquid (int mory = 0) there is no thrust: same trajectory as without levitation
	const tiles = [[2, 4, 418, 1]];
	for (let x = 3; x < 15; x++) for (let y = 1; y <= 4; y++) tiles.push([x, y, 119]);
	const LW = mkLevel({ tiles });
	const sw = new E.EESim(LW); const iw = new E.EEInput();
	for (let t = 0; t < 40; t++) { E.applyMask(iw, RIGHT); sw.tick(iw); }
	const snap = sw.snapshot();
	const branch = (lev) => {
		sw.restore(snap);
		if (!lev) { sw.has_levitation = false; sw._current_thrust = 0; }
		const out = [];
		for (let t = 0; t < 120; t++) { E.applyMask(iw, t % 50 < 30 ? JUMP | RIGHT : JUMP); sw.tick(iw); out.push([sw.px, sw.py, sw.speed_x, sw.speed_y].join(',')); }
		return { out, thr: sw._current_thrust, cur: sw.current_tile };
	};
	const bl = branch(true), bn = branch(false);
	check('in water (mory = 0): thrust 0.2 but no force, and no jump: identical to not levitating',
		bl.cur === 119 && bl.thr === 0.2 && bl.out.join(';') === bn.out.join(';'));
	// 418 with number 0 and effect reset: off, thrust zeroed at once; then normal jumps again
	const LR = mkLevel({ W: 20, tiles: [[2, 4, 418, 1], [6, 1, 1618], [6, 2, 1618], [6, 3, 1618], [6, 4, 1618]] });
	const rr = drive(LR, {}, 200, (sim, t) => (t >= 2 ? JUMP | RIGHT : 0));
	const px6 = rr.rec.findIndex((q) => q.px >= 6 * 16 - 8);   // center in column 6 after tick px6: touched in px6 + 1
	check('effect reset while thrusting: levitation off and thrust 0 in that tick (isThrusting untouched), then real jumps',
		rr.rec[px6].lev && rr.rec[px6].thr === 0.2 && !rr.rec[px6 + 1].lev && rr.rec[px6 + 1].thr === 0 && rr.rec[px6 + 1].thrusting &&
		rr.ev.some((e) => e.k === 'jump' && e.t > px6), `after ${px6}: lev ${rr.rec[px6 + 1].lev}, thr ${rr.rec[px6 + 1].thr}`);
	const L0 = mkLevel({ tiles: [[2, 4, 418, 1], [2, 3, 418, 0]] });
	const r0 = drive(L0, {}, 60, (sim, t) => (t >= 2 ? JUMP : 0));
	const off = r0.rec.findIndex((q, i) => i > 1 && !q.lev);
	check('418 with number 0 turns it off (thrust 0 at once)', off > 2 && r0.rec[off].thr === 0 && r0.rec[off - 1].thr === 0.2);
}

// ---------------------------------------------------------------- 6. teams
section('Teams: 423 (UpdateTeamDoors with overlap revert and per-tick retry of the member tx, ty), doors 1027, gates 1028');
{
	const maxX = (tiles) => Math.max(...drive(mkLevel({ tiles }), {}, 250, () => RIGHT).rec.map((q) => q.px));
	check('team 0 (no effect touched): door 1027 #0 open, #2 solid; gate 1028 #0 solid, #2 open',
		maxX([[7, 4, 1027, 0]]) > 100 && maxX([[7, 4, 1027, 2]]) <= 96 && maxX([[7, 4, 1028, 0]]) <= 96 && maxX([[7, 4, 1028, 2]]) > 100);
	check('after 423 #2: door 1027 #2 open, #3 solid; gate 1028 #2 solid, #3 open',
		maxX([[3, 4, 423, 2], [7, 4, 1027, 2]]) > 100 && maxX([[3, 4, 423, 2], [7, 4, 1027, 3]]) <= 96 &&
		maxX([[3, 4, 423, 2], [7, 4, 1028, 2]]) <= 96 && maxX([[3, 4, 423, 2], [7, 4, 1028, 3]]) > 100);
	// blocked change: 423 #1 touched while the box still overlaps door 1027 #0 (open only for team 0)
	const L = mkLevel({ tiles: [[5, 4, 1027, 0], [6, 4, 423, 1]] });
	const r = drive(L, {}, 200, () => RIGHT);
	const p = r.rec.findIndex((q) => q.tx === 6 || q.team === 1);
	const first1 = r.rec.findIndex((q) => q.team === 1);
	const expect = r.rec.findIndex((q, i) => i > p && r.rec[i - 1].px >= 96);
	check('touch with the box in door #0: team change reverted, tx,ty = (6,4) kept pending', r.rec[p].team === 0 && r.rec[p].tx === 6 && r.rec[p].ty === 4 &&
		r.rec[p].px < 96, `px ${r.rec[p].px}`);
	check('retried every tick at the tick start: team 1 in the first tick whose start box is clear of the door (px >= 96)',
		first1 === expect && r.rec[first1].tx === -1, `team 1 in tick ${first1}, expected ${expect}`);
	check('... and then door #0 is solid behind the player', Math.min(...drive(L, {}, 300, (s, t) => (t < 120 ? RIGHT : LEFT)).rec.slice(150).map((q) => q.px)) >= 96);
	// a team block equal to the team leaves tx, ty set (no-op retries); stateKey treats it as not pending
	const LE = mkLevel({ tiles: [[4, 4, 423, 0], [9, 4, 423, 3]] });
	const s = new E.EESim(LE); const inp = new E.EEInput();
	while (s._team_tx === -1) { E.applyMask(inp, RIGHT); s.tick(inp); }
	for (let i = 0; i < 5; i++) { E.applyMask(inp, 0); s.tick(inp); }
	const k0 = s.stateKey(), h0 = s.stateHash(), tx0 = s._team_tx;
	s._team_tx = -1; s._team_ty = -1;
	const k1 = s.stateKey(), h1 = s.stateHash();
	s._team_tx = 9; s._team_ty = 4;
	const k2 = s.stateKey(), h2 = s.stateHash();
	check('423 #0 with team 0: tx stays set (Player.as:1592 returns first); stateKey/hash equal to tx = -1, but not to a pending #3',
		tx0 === 4 && s.team === 0 && k0 === k1 && h0 === h1 && k2 !== k1 && h2 !== h1);
	// team survives death; /reset (start 'reset' after idle ticks) sets it to 0; a plain load keeps it
	const LT = mkLevel({ tiles: [[2, 4, 423, 3], [6, 4, 361]] });
	const rt = drive(LT, {}, 200, (sim, t, ev) => (ev.some((e) => e.k === 'death') ? 0 : RIGHT));
	const Dt = firstEv(rt.ev, 'death');
	check('team kept through death and respawn', rt.rec[1].team === 3 && rt.rec[Dt + 54].team === 3 && !rt.rec[Dt + 54].dead);
	check('/reset after live idle ticks on a team block: team 0; /playtas without /reset: team 3',
		new E.EESim(LT, { idleTicks: 5 }).team === 0 && new E.EESim(LT, { idleTicks: 5, start: 'load' }).team === 3);
	// a pending retry survives death and respawn (respawn() does not touch tx, ty): a box inside open door #0 with a
	// pending #1 (from the state), killed there; the corpse keeps overlapping, the respawn moves it clear
	const LP = mkLevel({ tiles: [[5, 4, 1027, 0], [6, 4, 423, 1]], spawns: [[2, 4]] });
	const sp = new E.EESim(LP); const ip = new E.EEInput();
	sp.px = 84; sp.py = 64; sp._team_tx = 6; sp._team_ty = 4;
	const tp = [];
	E.applyMask(ip, 0); sp.tick(ip); tp.push([sp.team, sp._team_tx, sp.is_dead, sp.deaths]);
	sp.kill_player();
	for (let t = 0; t < 56; t++) { sp.tick(ip); tp.push([sp.team, sp._team_tx, sp.is_dead, sp.deaths]); }
	const R = tp.findIndex((q) => q[3] === 1);
	check('a blocked team change retries every tick (still blocked while the corpse overlaps the door), survives the respawn and applies in the next tick',
		tp.slice(0, R + 1).every((q) => q[0] === 0 && q[1] === 6) && R > 50 && tp[R + 1][0] === 1 && tp[R + 1][1] === -1, JSON.stringify(tp.slice(R - 1, R + 2)));
}

// ---------------------------------------------------------------- 7. keyboard-only and other inert blocks
section('Keyboard-only blocks (god block 1516, world portal 374, reset point 466) and other blocks without physics');
{
	const J = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/eeo_spec/blocks.json'), 'utf8'));
	const inertPrefix = ['No effect', 'Background (layer 1)', 'Animated decoration', 'Liquid surface', 'Sign', 'Label', 'NPC.', 'God block',
		'Map block', 'World portal.', 'World portal spawn', 'Reset point', 'Diamond', 'Cake', 'Hologram', 'Piano', 'Drums', 'Guitar', 'Spawn point'];
	const inert = J.blocks.filter((b) => !b.solid && inertPrefix.some((p) => b.behavior.startsWith(p))).map((b) => b.id);
	const pattern = (t) => ((t % 90) < 50 ? RIGHT : LEFT) | ((t % 23) === 0 ? JUMP : 0) | ((t % 90) > 70 ? UP : 0);
	const traj = (level) => { const s = new E.EESim(level); const i = new E.EEInput(); const out = []; for (let t = 1; t <= 400; t++) { E.applyMask(i, pattern(t)); s.tick(i); out.push(physKey(s)); } return out.join(';'); };
	const place = (id) => [[5, 4, id, 7], [6, 4, id, 7], [6, 3, id, 7], [7, 2, id, 7], [8, 4, id, 7], [9, 3, id, 7]];
	const air = traj(mkLevel({ tiles: [] }));
	const bad = inert.filter((id) => traj(mkLevel({ tiles: place(id) })) !== air);
	check(`${inert.length} blocks without physics (incl. 1516, 374, 466, 1583, signs, labels, NPCs, music, decorations, background ids in layer 0) move the player exactly like air`,
		bad.length === 0 && [1516, 374, 466, 1583, 385, 1000, 1550, 77, 83, 1520].every((id) => inert.includes(id)), bad.length ? `differ: ${bad.slice(0, 20).join(' ')}` : `${inert.length} ids`);
	const stand = (id) => { const L = mkLevel({ tiles: [[2, 4, id]] }); const s = new E.EESim(L); const i = new E.EEInput(); for (let t = 0; t < 300; t++) s.tick(i); return s; };
	check('standing on 466 / 374 / 1516 for 300 ticks (no Y key, no G key in a .eetas): no reset, no teleport, no god mode',
		[466, 374, 1516].every((id) => { const s = stand(id); return s.px === 32 && s.py === 64 && !s.in_god_mode && s.run_ticks === 0; }));
}

// ---------------------------------------------------------------- 8. solidity of every id (blocks.json, generated from ItemId/ItemManager)
section('Solidity of every id against docs/eeo_spec/blocks.json');
{
	const J = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/eeo_spec/blocks.json'), 'utf8'));
	const doors = new Set([23, 24, 25, 26, 27, 28, 1005, 1006, 1007, 1008, 1009, 1010, 156, 157, 184, 185, 1079, 1080, 200, 201, 1094, 1095,
		1152, 1153, 43, 213, 1011, 165, 214, 1012, 1027, 1028, 206, 207, 50]);
	const plain = J.blocks.filter((b) => b.solid && !b.oneWay && !b.half && !b.rotOneWay && !doors.has(b.id)).map((b) => b.id).concat(J.undefinedSolidIds);
	const lv = mkLevel({ tiles: [] });
	const blocked = (id) => {
		const L = mkLevel({ tiles: [[6, 4, id], [6, 3, id], [6, 2, id], [6, 1, id]] });
		const s = new E.EESim(L); const i = new E.EEInput();
		let mx = 0;
		for (let t = 0; t < 160; t++) { E.applyMask(i, RIGHT | (t % 30 === 5 ? JUMP : 0)); s.tick(i); if (s.px > mx) mx = s.px; }
		return mx <= 5 * 16 && s.is_tile_solid_now(6, 4);
	};
	const notBlocked = plain.filter((id) => !blocked(id));
	check(`${plain.length} plain solid ids (incl. ${J.undefinedSolidIds.length} ids without a brick) stop the player`, notBlocked.length === 0, notBlocked.slice(0, 20).join(' '));
	const nonSolid = J.blocks.filter((b) => !b.solid).map((b) => b.id);
	const solidNow = nonSolid.filter((id) => { const L = mkLevel({ tiles: [[6, 4, id]] }); return new E.EESim(L).is_tile_solid_now(6, 4); });
	check(`${nonSolid.length} non-solid ids are never solid (is_tile_solid_now)`, solidNow.length === 0 && lv.flags[0] === 0, solidNow.join(' '));
	const bj = new Map(J.blocks.map((b) => [b.id, b]));
	let mism = 0;
	for (let id = 0; id < 2000; id++) {
		const b = bj.get(id), solid = b ? b.solid : J.undefinedSolidIds.includes(id);
		if (((lv.flags[id] & 1) !== 0) !== solid) mism++;
		if (b && (((lv.flags[id] & 2) !== 0) !== b.oneWay || ((lv.flags[id] & 4) !== 0) !== b.rotOneWay || ((lv.flags[id] & 8) !== 0) !== b.half ||
			((lv.flags[id] & 32) !== 0) !== b.climbable || ((lv.flags[id] & 64) !== 0) !== b.liquid || ((lv.flags[id] & 128) !== 0) !== b.boost)) mism++;
	}
	check('the id tables (solid, one-way, rotatable one-way, half, climbable, liquid, boost) equal blocks.json for ids 0..1999', mism === 0, `${mism} mismatches`);
}

// ---------------------------------------------------------------- 9. the AS3 lookup table
section('Lookup.getInt: position keyed, both layers, last write wins (lookup_int)');
{
	// team door 1027 #0 in layer 0, then a layer-1 record at the same cell with number 5 (a crafted file): EEO's
	// World.deserializeFromMessage stores the 5 for the position (World.as:296-298), so the door is #5
	const buf = writeEelvl({ W: 16, H: 7, records: [
		{ id: 9, xs: [...Array(16).keys(), ...Array(16).keys(), ...Array(16).keys()], ys: [...Array(16).fill(0), ...Array(16).fill(5), ...Array(16).fill(6)] },
		{ id: 9, xs: [0, 0, 0, 0, 0, 15, 15, 15, 15, 15], ys: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5] },
		{ id: 255, xs: [2], ys: [4] }, { id: 1027, xs: [7], ys: [4], args: [0] }, { id: 1027, layer: 1, xs: [7], ys: [4], args: [5] }] });
	const lvl = V.toSimLevel(V.readEelvl(buf));
	const Lx = E.prepareLevel(lvl);
	const noLI = { ...lvl }; delete noLI.lookup_int;
	const Lo = E.prepareLevel(noLI);
	const reach = (L) => Math.max(...drive(L, {}, 200, () => RIGHT).rec.map((q) => q.px));
	check('the door reads the layer-1 number 5 (solid for team 0); the old extras-only table would read 0 (open)',
		Lx.lookup0[4 * 16 + 7] === 5 && reach(Lx) <= 96 && Lo.lookup0[4 * 16 + 7] === 0 && reach(Lo) > 100);
	let same = true, n = 0;
	if (fs.existsSync(SAMPLES)) {
		for (const f of fs.readdirSync(SAMPLES).filter((x) => x.endsWith('.eelvl'))) {
			let s; try { s = V.toSimLevel(V.readEelvl(fs.readFileSync(path.join(SAMPLES, f)))); } catch (e) { continue; }
			const a = E.prepareLevel(s).lookup0; const c = { ...s }; delete c.lookup_int; const b = E.prepareLevel(c).lookup0;
			n++;
			if (Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) !== 0) { same = false; console.log(`    differs: ${f}`); }
		}
	}
	check(`sample levels: lookup_int and the old extras give the same table (${n} files, one record per position)`, same);
}

// ---------------------------------------------------------------- 10. snapshot / restore / stateKey / stateHash
section('snapshot / restore / stateKey / stateHash with the new state');
function arena() {
	// a 30x12 arena (walking row 9, floor row 10) with every new mechanic, one-way platforms on row 6 and things in
	// the air for levitation
	const t = [];
	const W = 30, H = 12;
	const put = (x, y, id, v) => t.push([x, y, id, v]);
	put(3, 9, 421, 2); put(5, 9, 422, 3); put(7, 9, 1584, 2); put(9, 9, 420, 1); put(11, 9, 420, 0); put(13, 9, 1573); put(15, 9, 418, 1);
	put(16, 9, 421, 2); put(17, 9, 1618); put(19, 9, 423, 1); put(21, 9, 1027, 1); put(22, 9, 1028, 2); put(23, 9, 423, 2); put(24, 9, 206); put(26, 9, 418, 0);
	put(27, 9, 361);
	for (let x = 2; x < 28; x += 3) put(x, 6, 61);
	put(4, 5, 421, 0); put(6, 5, 6); put(8, 5, 422, 0); put(12, 5, 1584, 0); put(16, 5, 416); put(18, 5, 119); put(20, 5, 423, 0);
	put(22, 5, 23); put(24, 5, 1573); put(26, 5, 207);
	put(10, 2, 1618); put(15, 2, 421, 1); put(20, 3, 423, 3); put(25, 2, 1027, 3); put(5, 2, 418, 0);
	return mkLevel({ W, H, tiles: t, spawns: [[2, 9], [14, 9]] });
}
/** Inputs in blocks of 40..240 ticks: walk right / left (with jumps), hold jump (levitation), random sticky, idle. */
function randMasks(seed, n) {
	let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
	const out = new Uint8Array(n);
	let i = 0, m = 0;
	while (i < n) {
		const len = 40 + Math.floor(rnd() * 200), kind = Math.floor(rnd() * 6), jp = 3 + Math.floor(rnd() * 25);
		for (let k = 0; k < len && i < n; k++, i++) {
			if (kind === 0) m = RIGHT | (k % jp === 0 ? JUMP : 0);
			else if (kind === 1) m = LEFT | (k % jp === 0 ? JUMP : 0);
			else if (kind === 2) m = JUMP | (k % 60 < 20 ? RIGHT : (k % 60 < 40 ? LEFT : 0));
			else if (kind === 3) { if (rnd() < 0.1) m = Math.floor(rnd() * 32) & 7; }
			else if (kind === 4) m = RIGHT | JUMP;
			else m = 0;
			out[i] = m;
		}
	}
	return out;
}
function snapCheck(name, level, masks, nSnaps, horizon) {
	const sim = new E.EESim(level); const inp = new E.EEInput();
	const keys = [], hashes = [], fl = [], snaps = new Map();
	let seed = 777; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const at = new Set(); while (at.size < nSnaps) at.add(Math.floor(rnd() * masks.length));
	const f = (s) => physKey(s) + '|' + [s._ticks, s._team_tx, s._team_ty, s._curse_time_start, s._curse_duration, s._zombie_time_start, s._zombie_duration,
		s._poison_time_start, s._poison_duration, s._fire_time_start, s._q0, s._q1, s.overlapa, s.overlapb].join('|');
	for (let t = 0; t < masks.length; t++) {
		if (at.has(t)) snaps.set(t, sim.snapshot());
		E.applyMask(inp, masks[t]); sim.tick(inp);
		keys.push(sim.stateKey()); hashes.push(sim.stateHash()); fl.push(f(sim));
	}
	const order = [...snaps.keys()].sort(() => rnd() - 0.5);
	let bad = 0, first = '';
	for (const t0 of order) {
		sim.restore(snaps.get(t0));
		for (let t = t0; t < Math.min(masks.length, t0 + horizon); t++) {
			E.applyMask(inp, masks[t]); sim.tick(inp);
			if (sim.stateKey() !== keys[t] || sim.stateHash() !== hashes[t] || f(sim) !== fl[t]) { bad++; if (!first) first = `from ${t0} at ${t + 1}`; break; }
		}
	}
	check(`${name}: ${nSnaps} snapshots restored in random order continue identically (${horizon} ticks each)`, bad === 0, first || 'all equal');
	return fl;
}
{
	const A = arena();
	const n = QUICK ? 6000 : 20000;
	const masks = randMasks(12345, n);
	const fl = snapCheck('arena with every new mechanic', A, masks, 40, 400);
	const seen = { cursed: 0, zombie: 0, poison: 0, lev: 0, thr: 0, team: 0, pend: 0, dead: 0 };
	const sim = new E.EESim(A); const inp = new E.EEInput();
	for (let t = 0; t < n; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if (sim.is_cursed) seen.cursed++; if (sim.is_zombie) seen.zombie++; if (sim.is_poisoned) seen.poison++; if (sim.has_levitation) seen.lev++;
		if (sim._current_thrust > 0) seen.thr++; if (sim.team !== 0) seen.team++; if (sim._team_tx !== -1) seen.pend++; if (sim.is_dead) seen.dead++;
	}
	console.log(`    ticks with: ${JSON.stringify(seen)} (of ${n}; ${fl.length} recorded)`);
	check('the random walk exercised curse, zombie, poison, levitation with thrust, teams and deaths', Object.values(seen).every((v) => v > 0), JSON.stringify(seen));

	// stateKey soundness: states with equal keys (different histories and ticks, incl. runs shifted by idle ticks)
	// must have identical futures under the same inputs
	const pool = new Map();   // key -> [{snap, tag}]
	const runs = QUICK ? 24 : 60, len = QUICK ? 1500 : 3000;
	let states = 0;
	for (let r = 0; r < runs; r++) {
		const idle = (r % 4) * 37;
		const ms = randMasks(1000 + (r >> 2), len);   // groups of 4 runs share inputs, shifted by 0/37/74/111 idle ticks
		const s = new E.EESim(A); const i = new E.EEInput();
		for (let k = 0; k < idle; k++) { E.applyMask(i, 0); s.tick(i); }
		for (let t = 0; t < len; t++) {
			E.applyMask(i, ms[t]); s.tick(i);
			if (t % 3 !== 0) continue;
			const key = s.stateKey();
			let g = pool.get(key);
			if (!g) { g = []; pool.set(key, g); }
			if (g.length < 4) { g.push({ snap: s.snapshot(), tag: `${r}@${t}`, hash: s.stateHash() }); states++; }
		}
	}
	const cont = randMasks(99, 400);
	let groups = 0, badFut = 0, badHash = 0, first = '';
	const sim2 = new E.EESim(A); const i2 = new E.EEInput();
	const future = (snap) => {
		sim2.restore(snap);
		const ev = []; sim2.onEvent = (k) => ev.push(k);
		const out = [];
		for (let t = 0; t < cont.length; t++) { E.applyMask(i2, cont[t]); sim2.tick(i2); out.push(sim2.stateKey()); out.push(ev.join(',')); ev.length = 0; }
		sim2.onEvent = null;
		return out.join('\u0000');
	};
	const hashSeen = new Map();
	for (const [key, g] of pool) {
		for (const m of g) if (m.hash !== g[0].hash) badHash++;
		const hk = g[0].hash; if (hashSeen.has(hk) && hashSeen.get(hk) !== key) badHash++; else hashSeen.set(hk, key);
		if (g.length < 2) continue;
		groups++;
		const f0 = future(g[0].snap);
		for (let j = 1; j < g.length; j++) if (future(g[j].snap) !== f0) { badFut++; if (!first) first = `${g[0].tag} vs ${g[j].tag}`; }
	}
	check(`stateKey soundness: ${groups} groups of equal keys (from ${states} states of ${runs} runs) all have identical futures (400 ticks)`,
		badFut === 0 && groups > 50, first || `${groups} groups`);
	check('stateHash: equal for equal keys, no collisions between different keys', badHash === 0, `${badHash}`);

	// timers keyed relative to the tick: the same run shifted by idle ticks keys equal (no time doors here)
	const LC = mkLevel({ W: 20, tiles: [[4, 4, 421, 9], [6, 4, 1584, 7], [8, 4, 422, 8], [10, 4, 418, 1], [12, 4, 423, 2], [14, 4, 1027, 2]] });
	const refK = []; { const s = new E.EESim(LC); const i = new E.EEInput(); for (let t = 0; t < 900; t++) { E.applyMask(i, t % 40 < 25 ? RIGHT | (t % 7 === 0 ? JUMP : 0) : JUMP); s.tick(i); refK.push(s.stateKey()); } }
	let mism = 0;
	for (const idle of [1, 13, 250, 777]) {
		const s = new E.EESim(LC); const i = new E.EEInput();
		for (let k = 0; k < idle; k++) { E.applyMask(i, 0); s.tick(i); }
		for (let t = 0; t < 900; t++) { E.applyMask(i, t % 40 < 25 ? RIGHT | (t % 7 === 0 ? JUMP : 0) : JUMP); s.tick(i); if (t > 0 && s.stateKey() !== refK[t]) mism++; }
	}
	check('curse / poison / zombie timers, thrust and team keyed relative to the clock: runs shifted by idle ticks key equal', mism === 0, `${mism} mismatches`);
	// and the remaining time is keyed: same place, different remaining curse time -> different keys
	const s1 = new E.EESim(LC); const i1 = new E.EEInput();
	for (let t = 0; t < 30; t++) { E.applyMask(i1, RIGHT); s1.tick(i1); }
	const snapC = s1.snapshot(); const kA = s1.stateKey(); s1._curse_time_start -= 1; const kB = s1.stateKey(); s1.restore(snapC);
	check('the remaining curse time is part of the key', s1.is_cursed && kA !== kB && s1.stateKey() === kA);
}

// ---------------------------------------------------------------- 11. sample levels that use the new blocks
if (fs.existsSync(SAMPLES)) {
	section('Sample levels with 418 / 420 / 421 / 422 / 423 / 1027 / 1028: random walks, snapshots');
	for (const name of ['Panicore.eelvl', 'Gloomy Castle.eelvl', 'Forgotten Helix.eelvl', 'Desolate Relics.eelvl', 'A Music Extravaganza.eelvl', 'CTM 2.eelvl', 'Be gone.(1).eelvl']) {
		const f = path.join(SAMPLES, name);
		if (!fs.existsSync(f)) continue;
		const L = V.loadEelvlLevel(f);
		snapCheck(name, L, randMasks(name.length * 7919, QUICK ? 4000 : 12000), 15, 300);
	}
}

// ---------------------------------------------------------------- helpers
/** A minimal .eelvl writer (raw deflate, header + records as World.deserializeFromMessage reads them). */
function writeEelvl({ W, H, gravity = 1, records }) {
	const utf = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
	const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
	const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
	const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
	const bool = (v) => Buffer.from([v ? 1 : 0]);
	const us = (arr) => { const b = Buffer.alloc(4 + 2 * arr.length); b.writeUInt32BE(2 * arr.length); arr.forEach((v, k) => b.writeUInt16BE(v, 4 + 2 * k)); return b; };
	const parts = [utf('test'), utf('test level'), i32(W), i32(H), f32(gravity), u32(0), utf(''), bool(false), utf(''), utf(''), i32(0), bool(true), utf('')];
	for (const r of records) {
		parts.push(i32(r.id), i32(r.layer || 0), us(r.xs), us(r.ys));
		for (const a of r.args || []) parts.push(typeof a === 'string' ? utf(a) : i32(a));
	}
	return zlib.deflateRawSync(Buffer.concat(parts));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
