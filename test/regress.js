'use strict';
// Regression and targeted tests for the eeo-tas tick loop, clocks and start sequence in src/eesim.js.
// usage: node test/regress.js [--level=<file.eelvl>] [--tas=<file.eetas>]... [--old=<old eesim.js for a speed comparison>]
//                             [--quick] (skips the exhaustive clock identities and the benchmark)
// Exit code 1 if any check fails. Node built-ins only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../src/eesim.js');
const V = require('../src/eelvl.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.filter((x) => x.startsWith(`--${k}=`)).map((x) => x.slice(k.length + 3)); return a.length ? a : d; };
const QUICK = args.includes('--quick');
const FV_LEVEL = opt('level', ['C:/Users/super/3d33/levels/forgotten_veil.eelvl'])[0];
const FV_TAS = opt('tas', ['C:/Users/super/3d33/levels/tas/forgotten_veil.eetas', 'C:/Users/super/3d33/tools/tas/out/best.eetas']);
const OLD = opt('old', [null])[0];
const SAMPLES = 'C:/Users/super/Downloads';

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++;
	else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
function section(s) { console.log(`\n== ${s}`); }

// ---------------------------------------------------------------- tiny levels in toSimLevel's JSON format
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
/**
 * W x H with a border of block 9 and a floor row at y = H - 2; tiles [[x, y, id, int?]] (int = the record's
 * number / rotation); spawns [[x, y]] = spawnPoints[0] in file order (or spawnPoints: the whole list).
 */
function mkLevel({ W = 16, H = 7, tiles = [], spawns = [], spawnPoints, gravity = 1, floor = true, opts = {} } = {}) {
	const fg = new Int32Array(W * H);
	for (let x = 0; x < W; x++) { fg[x] = 9; fg[(H - 1) * W + x] = 9; if (floor) fg[(H - 2) * W + x] = 9; }
	for (let y = 0; y < H; y++) { fg[y * W] = 9; fg[y * W + W - 1] = 9; }
	const extras = [];
	for (const [x, y, id, arg] of tiles) { fg[y * W + x] = id; if (arg !== undefined) extras.push([y * W + x, arg, null, null]); }
	const g = Math.fround(gravity);   // the header is a float32
	return E.prepareLevel({ format: 'eesim-level-1', level_id: 'test', width: W, height: H, gravity_hex: f64hex(g), gravity: g,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras, spawn_points: spawnPoints || [spawns] }, opts);
}

/** Runs a sim; maskFn(sim, t) gives the mask for tick t (1-based) or null to stop; returns per-tick records. */
function drive(level, simOpts, maxTicks, maskFn) {
	const sim = new E.EESim(level, simOpts);
	const inp = new E.EEInput();
	const ev = [];
	sim.onEvent = (k, d) => ev.push({ t: sim.ticks(), k, d });
	const rec = [{ t: 0, px: sim.px, py: sim.py, keys: sim._keysMask, dead: sim.is_dead, deaths: sim.deaths, td: sim._timedoor_state }];
	for (let t = 1; t <= maxTicks; t++) {
		const m = maskFn(sim, t, ev);
		if (m === null) break;
		E.applyMask(inp, m);
		sim.tick(inp);
		rec.push({ t: sim.ticks(), px: sim.px, py: sim.py, keys: sim._keysMask, dead: sim.is_dead, deaths: sim.deaths, td: sim._timedoor_state,
			coins: sim.coins, bcoins: sim.blue_coins, fire: sim.is_on_fire });
	}
	return { sim, rec, ev };
}
const RIGHT = 4, LEFT = 2, JUMP = 1;

// old EE Offline clock (World.offset += 0.3, key/time door when (offset - stamp) / 30 >= 5), for comparisons only
const OFF = [0]; for (let i = 1; i < 30000; i++) OFF.push(OFF[i - 1] + 0.3);
function oldKeyTicks(p) { let n = p + 1; while (((OFF[n] - OFF[p]) / 30.0) < 5.0) n++; return n - p; }

// ---------------------------------------------------------------- 1. Forgotten Veil regression
section('Forgotten Veil (level via eelvl.js, TAS via parseEetasBytes on the raw bytes)');
function replayFile(level, tasFile, simOpts) {
	const bytes = fs.readFileSync(tasFile);
	const masks = E.parseEetasBytes(bytes);
	const sim = new E.EESim(level, simOpts);
	const inp = new E.EEInput();
	let complete = -1, deaths = 0, levelTicks = -1;
	const keys = [];
	sim.onEvent = (k, d) => {
		if (k === 'complete' && complete < 0) { complete = sim.ticks(); levelTicks = sim.level_ticks(); }
		else if (k === 'death') deaths++;
		else if (k === 'key' || k === 'key_expired') keys.push(`${k} ${d.color}@${sim.ticks()}`);
	};
	for (let t = 0; t < masks.length && complete < 0; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
	return { bytes: bytes.length, odd: E.eetasOddBytes(bytes).length, complete, levelTicks, run: sim.run_ticks, coins: sim.coins, blue: sim.blue_coins,
		deaths, simDeaths: sim.deaths, fq: sim.frame_queue_ticks, keys, rng: sim._rngSteps };
}
const fmtT = (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`;
let fvLevel = null;
if (fs.existsSync(FV_LEVEL)) {
	fvLevel = V.loadEelvlLevel(FV_LEVEL);
	console.log(`  level ${path.basename(FV_LEVEL)}: ${fvLevel.width}x${fvLevel.height}, gravity ${fvLevel.gravityMult}, spawnPoints[0] = ` +
		`${JSON.stringify([...fvLevel.spawnsX].map((x, i) => [x, fvLevel.spawnsY[i]]))} (${fvLevel.spawnOrder} order), ` +
		`${fvLevel.coinTiles.length} coin tiles, time doors ${fvLevel.hasTimeDoors}`);
	for (const f of FV_TAS) {
		if (!fs.existsSync(f)) { console.log(`  (missing ${f})`); continue; }
		const r = replayFile(fvLevel, f);
		console.log(`  ${path.basename(f)}: ${r.bytes} bytes (${r.odd} outside '0'..'O'), complete at tick ${r.complete}, run_ticks ${r.run} ` +
			`(${fmtT(r.run)}), coins ${r.coins}, blue ${r.blue}, deaths ${r.deaths}, frame_queue_ticks ${r.fq}, random draws ${r.rng}; ${r.keys.join(', ')}`);
		if (path.basename(f) === 'forgotten_veil.eetas') {
			check('FV TAS completes at tick 11539 with run_ticks 11527 (in-game 1:55.27), 15 coins, 0 deaths',
				r.complete === 11539 && r.run === 11527 && r.coins === 15 && r.deaths === 0, `${r.complete} / ${r.run} / ${r.coins} / ${r.deaths}`);
		} else check(`${path.basename(f)} completes`, r.complete > 0 && r.deaths === 0);
		const rl = replayFile(fvLevel, f, { start: 'load' });
		check(`${path.basename(f)}: start 'load' gives the same run (one spawn, no 110/111)`, rl.complete === r.complete && rl.run === r.run);
		const ri = replayFile(fvLevel, f, { idleTicks: 300 });
		check(`${path.basename(f)}: 300 idle ticks before /reset leave no residue that matters`, ri.complete === r.complete && ri.run === r.run,
			`${ri.complete} / ${ri.run}`);
		const rli = replayFile(fvLevel, f, { start: 'load', idleTicks: 300 });
		check(`${path.basename(f)}: /playtas after 300 live idle ticks without /reset: same run; ticks() counts bytes, level_ticks() = +300`,
			rli.complete === r.complete && rli.run === r.run && rli.levelTicks === r.levelTicks + 300, `${rli.complete} / ${rli.run} / ${rli.levelTicks}`);
	}
} else console.log(`  (missing ${FV_LEVEL})`);

// ---------------------------------------------------------------- 2. .eetas bytes
section('.eetas decoding (TASInput.readInputs)');
{
	let bad = 0;
	const all = Buffer.alloc(256);
	for (let b = 0; b < 256; b++) {
		all[b] = b;
		// AS3: var inputsOnTick:int = readByte() (signed); inputsOnTick -= 48; bits via int32 >> and &
		let v = b < 128 ? b : b - 256; v = (v - 48) | 0;
		const m = (v & 1) | (((v >> 1) & 1) << 1) | (((v >> 2) & 1) << 2) | (((v >> 3) & 1) << 3) | (((v >> 4) & 1) << 4);
		if (E.parseEetasBytes(Buffer.from([b]))[0] !== m) bad++;
	}
	check('all 256 byte values decode like AS3 (signed byte - 48, bits 0..4)', bad === 0, `${bad} mismatches`);
	const s = all.toString('latin1');
	check('parseEetas(text) == parseEetasBytes(Buffer.from(text, "latin1"))', Buffer.compare(Buffer.from(E.parseEetas(s)), Buffer.from(E.parseEetasBytes(all))) === 0);
	check('parseEetas(Buffer) == parseEetasBytes(Buffer)', Buffer.compare(Buffer.from(E.parseEetas(all)), Buffer.from(E.parseEetasBytes(all))) === 0);
	const special = E.parseEetasBytes(Buffer.from([10, 13, 32, 80, 0xEF, 0xBB, 0xBF, 48, 79]));
	check('LF=26, CR=29, space=16, P=0, BOM=31,11,15, 0=0, O=31, nothing trimmed', special.join(',') === '26,29,16,0,31,11,15,0,31', special.join(','));
	const withCrlf = Buffer.from('0444\r\n', 'latin1');
	const odd = E.eetasOddBytes(withCrlf);
	check('eetasOddBytes flags a trailing CRLF as 2 extra ticks', E.parseEetasBytes(withCrlf).length === 6 && odd.length === 2 && odd[0].mask === 29 && odd[1].mask === 26,
		JSON.stringify(odd));
	let threw = false; try { E.parseEetasBytes('0000'); } catch (e) { threw = true; }
	check('parseEetasBytes rejects a string (bytes only)', threw);
}

// ---------------------------------------------------------------- 3. clock identities
section('eeo-tas clock identities (doubles, as AS3 evaluates them)');
{
	const N = QUICK ? 200000 : 2000000;
	let bad = 0;
	for (let t = 0; t < N; t++) if ((((t / 100) % 10) >= 5) !== ((t % 1000) >= 500)) bad++;
	check(`time door: ((t/100) % 10 >= 5) === (t % 1000 >= 500) for t in [0, ${N})`, bad === 0, `${bad} mismatches`);
	bad = 0;
	for (let d = -3000; d < N; d++) if (((d / 100) >= 5) !== (d >= 500)) bad++;
	check(`key: ((d/100) >= 5) === (d >= 500) for d in [-3000, ${N})`, bad === 0, `${bad} mismatches`);
	let dur = 2; dur += 2 * 0.2; dur *= 100;
	check('lava duration (2 + 2*0.2) * 100 === 240 in doubles', dur === 240, String(dur));
	let n = 0, s = 0; while (s <= 16) { s += 0.3; n++; }
	check('deadoffset: 0.3 added 54 times first exceeds 16', n === 54, `${n} (${s})`);
}

// ---------------------------------------------------------------- 4. key timers
section('Key timers: PlayState.ticks, exactly 500 ticks');
{
	// floor at y = 5, spawn (2,4), red key at (6,4); idle k ticks, then walk right to the wall
	const L = mkLevel({ W: 14, tiles: [[6, 4, 6], [2, 4, 255]], spawns: [[2, 4]] });
	const durations = new Map(), oldDur = new Map();
	let ok = true, detail = '';
	const K = 200, STEP = 37;   // idle 0, 37, ..., 7363 ticks before walking: pickup ticks spread over ~7400 ticks
	for (let j = 0; j < K; j++) {
		const k = j * STEP;
		const { rec, ev } = drive(L, {}, k + 900, (sim, t) => (t <= k ? 0 : RIGHT));
		const pick = ev.find((e) => e.k === 'key');
		if (!pick) { ok = false; detail = `k=${k}: no pickup`; break; }
		const p = pick.t;
		const offAt = rec.findIndex((r, i) => i > p && (r.keys & 1) === 0);
		const d = offAt - p;
		durations.set(d, (durations.get(d) || 0) + 1);
		const od = oldKeyTicks(p);
		oldDur.set(od, (oldDur.get(od) || 0) + 1);
		if (!(rec[p].keys & 1) || !(rec[p + 499].keys & 1) || (rec[p + 500].keys & 1)) { ok = false; detail = `k=${k} p=${p}: on ${!!(rec[p].keys & 1)}/${!!(rec[p + 499].keys & 1)}, off at +500 ${!(rec[p + 500].keys & 1)}`; }
	}
	check(`a key picked up at tick p is on after ticks p..p+499 and off after p+500 (${K} pickup ticks)`, ok && durations.size === 1 && durations.has(500),
		detail || `durations ${JSON.stringify([...durations])}`);
	console.log(`    (the old EE Offline offset clock would give ${JSON.stringify([...oldDur].sort())} [duration, count] for the same pickup ticks)`);
	// cross-tick exactness: the same run shifted by k idle ticks has the same stateKey at the same time after the walk start
	const ref = [];
	{
		const sim = new E.EESim(L); const inp = new E.EEInput();
		for (let j = 0; j < 800; j++) { E.applyMask(inp, RIGHT); sim.tick(inp); ref.push(sim.stateKey()); }
	}
	let mism = 0, first = '';
	for (let k = 1; k < 6000; k += 293) {
		const sim = new E.EESim(L); const inp = new E.EEInput();
		for (let j = 0; j < k; j++) { E.applyMask(inp, 0); sim.tick(inp); }
		for (let j = 0; j < 800; j++) {
			E.applyMask(inp, RIGHT); sim.tick(inp);
			if (sim.stateKey() !== ref[j] && !(j === 0)) { mism++; if (!first) first = `k=${k} j=${j}`; }
		}
	}
	check('stateKey is exact across ticks for key timers (runs shifted by k idle ticks key equal, through pickup and expiry)', mism === 0, first || '0 mismatches');
}

// ---------------------------------------------------------------- 5. deferred key pickup, per-frame queue, ticksPerFrame
section('Deferred key pickup (keysquene), frame drains and ticksPerFrame');
{
	// spawn inside an open red gate (26) at (3,4), red key at (4,4): the pickup turns the gate solid around the player
	const L = mkLevel({ W: 12, tiles: [[3, 4, 26], [4, 4, 6]], spawns: [[3, 4]] });
	const res = {};
	for (const tpf of [1, 2, 3]) {
		const { sim, rec, ev } = drive(L, { ticksPerFrame: tpf }, 700, () => RIGHT);
		const p = (ev.find((e) => e.k === 'key') || {}).t;
		const on = rec.findIndex((r) => (r.keys & 1) !== 0);
		const leftGate = rec.findIndex((r, i) => i >= p && r.px >= 64);   // box no longer overlaps the gate cell (3)
		const off = rec.findIndex((r, i) => i > on && (r.keys & 1) === 0);
		res[tpf] = { p, on, leftGate, off, fq: sim.frame_queue_ticks, kt: sim._kt[0] };
	}
	const r1 = res[1];
	console.log(`    pickup at tick ${r1.p}, box leaves the gate after tick ${r1.leftGate}; key on after tick: ` +
		Object.entries(res).map(([k, r]) => `${k} tick/frame -> ${r.on} (frame_queue_ticks ${r.fq})`).join(', '));
	check('the pickup is deferred while the box overlaps the gate and applied at the first drain after it leaves', r1.p > 0 && r1.on === r1.leftGate && r1.on > r1.p,
		`p ${r1.p}, on ${r1.on}, left ${r1.leftGate}`);
	check('the timer counts from the touch (keysTimer = p, not re-stamped by the queued retry): off at p + 500', r1.kt === r1.p && r1.off === r1.p + 500, `kt ${r1.kt}, off ${r1.off}`);
	check('frame_queue_ticks counts the ticks that ended with the retry pending (p..on)', r1.fq === r1.on - r1.p + 1, `${r1.fq}`);
	check('ticksPerFrame k drains only after ticks with PlayState.ticks % k == 0', [2, 3].every((k) => res[k].on === Math.ceil(r1.leftGate / k) * k),
		Object.entries(res).map(([k, r]) => `${k}:${r.on}`).join(' '));
	// stateKey keys the frame phase when ticksPerFrame > 1 (the player is at rest: only the clock differs)
	const keyAfter = (tpf, n) => { const s = new E.EESim(L, { ticksPerFrame: tpf }); const i = new E.EEInput(); for (let k = 0; k < n; k++) s.tick(i); return [s.stateKey(), s.stateHash()]; };
	check('stateKey/stateHash key PlayState.ticks % ticksPerFrame (and nothing absolute with 1 tick per frame)',
		keyAfter(1, 10)[0] === keyAfter(1, 11)[0] && keyAfter(2, 10)[0] !== keyAfter(2, 11)[0] && keyAfter(2, 10)[0] === keyAfter(2, 12)[0] &&
		keyAfter(2, 10)[1] !== keyAfter(2, 11)[1] && keyAfter(2, 10)[1] === keyAfter(2, 12)[1]);
}

// ---------------------------------------------------------------- 6. time doors
section('Time doors 156/157: absolute phase of PlayState.ticks');
{
	const L = mkLevel({ W: 12, tiles: [[5, 4, 156], [3, 4, 255]], spawns: [[3, 4]] });
	const { rec } = drive(L, {}, 1600, () => RIGHT);
	const st = (t) => rec[t].td;
	check('timedoorState false in ticks 1-499, true in 500-999, false in 1000-1499, true from 1500',
		!st(1) && !st(499) && st(500) && st(999) && !st(1000) && !st(1499) && st(1500));
	const firstIn = rec.findIndex((r) => r.px > 64);
	check('door 156 blocks until World.update of tick 500 opens it (the player enters in tick 500)', firstIn === 500, `first tick past x=64: ${firstIn}`);
	console.log(`    (the old offset clock toggled at 501, 1001, 1501, 2002, ...; eeo-tas at 500, 1000, 1500, 2000, ...)`);
	const { rec: rl } = drive(L, { start: 'load', idleTicks: 123 }, 600, () => RIGHT);
	const firstInL = rl.findIndex((r) => r.px > 64);
	check('start "load" after 123 idle ticks: PlayState.ticks keeps counting, the door opens at TAS tick 377', firstInL === 377, String(firstInL));
	const G = mkLevel({ W: 12, tiles: [[5, 4, 157], [3, 4, 255]], spawns: [[3, 4]] });
	const { rec: rg } = drive(G, {}, 600, (sim, t) => (t < 520 ? 0 : RIGHT));
	const { rec: rg0 } = drive(G, {}, 100, () => RIGHT);
	check('gate 157 is open before tick 500 (walked through) and shut from tick 500 (blocked when starting at 520)',
		rg0.some((r) => r.px > 80) && rg.every((r) => r.px <= 64));
	// stateKey keys the phase: same physical state at PlayState.ticks t and t + 1000 -> equal, t + 500 -> different
	const R = mkLevel({ W: 12, tiles: [[9, 4, 156], [2, 4, 255]], spawns: [[2, 4]] });
	const keyAt = (idle, extra) => {
		const sim = new E.EESim(R, { start: 'load', idleTicks: idle });
		const inp = new E.EEInput();
		for (let i = 0; i < extra; i++) sim.tick(inp);
		return sim.stateKey();
	};
	check('stateKey: equal at the same phase mod 1000 (at rest), different half a period apart',
		keyAt(40, 10) === keyAt(1040, 10) && keyAt(40, 10) === keyAt(20, 1030) && keyAt(40, 10) !== keyAt(540, 10));
}

// ---------------------------------------------------------------- 7. death and respawn order
section('Death timing and respawn at the end of Player.tick (before the per-frame queues)');
{
	// spawn (1,4); red key (3,4); red door 23 at (7,4); spike 361 at (8,4). Take the key, wait, then walk right
	// and die with the box still inside the (open) door; the key expires while dead -> deferred (the door would
	// close on the corpse); the retry after the respawn tick must see the spawn position.
	const L = mkLevel({ W: 14, tiles: [[1, 4, 255], [3, 4, 6], [7, 4, 23], [8, 4, 361]], spawns: [[1, 4]] });
	let p = -1;
	const { rec, ev } = drive(L, {}, 700, (sim, t, evs) => {
		if (p < 0) { const e = evs.find((x) => x.k === 'key'); if (e) p = e.t; }
		if (p < 0) return RIGHT;
		if (sim.is_dead || sim.deaths > 0) return 0;
		return t < p + 440 ? 0 : RIGHT;
	});
	const D = (ev.find((e) => e.k === 'death') || {}).t;
	const R = (ev.find((e) => e.k === 'respawn') || {}).t;
	console.log(`    key at ${p}, killed in tick ${D} (box x ${rec[D] && rec[D].px}), key due to expire at ${p + 500}, respawn in tick ${R}`);
	check('death timing: killed in tick D, respawned at the end of tick D + 54 (alive from D + 55), deaths++ then',
		R === D + 54 && rec[D + 53].dead && !rec[D + 54].dead && rec[D + 53].deaths === 0 && rec[D + 54].deaths === 1, `D ${D}, R ${R}`);
	check('setup: died with the box overlapping the door, and the key expiry fell inside the death', D < p + 500 && p + 500 < D + 54 &&
		rec[D].px < 128 && rec[D].px + 16 > 112);
	check('while dead in the door the expiry stays deferred (key on until the respawn tick)', rec.slice(p + 500, D + 54).every((r) => (r.keys & 1) !== 0));
	check('the queued key-off retry of the respawn tick runs at the spawn: key off after tick D + 54 (EE Offline order: D + 55)',
		(rec[D + 54].keys & 1) === 0 && rec[D + 54].px === 16 && rec[D + 54].py === 64, `keys ${rec[D + 54].keys}, pos ${rec[D + 54].px},${rec[D + 54].py}`);
	if (OLD && fs.existsSync(OLD)) {
		// the same inputs on the previous engine (EE Offline order: queues first, respawn in "Player.draw")
		const O = require(path.resolve(OLD));
		const LO = O.prepareLevel({ format: 'eesim-level-1', width: L.width, height: L.height, gravity_hex: f64hex(1), fg_b64: b64(L.fg), bg_b64: b64(L.bg),
			extras: [] });
		const so = new O.EESim(LO); so.reset(); const io = new O.EEInput();
		const offs = [];
		for (let t = 1; t < rec.length; t++) {
			const m = t <= p ? RIGHT : (t <= D ? (t < p + 440 ? 0 : RIGHT) : 0);
			O.applyMask(io, m); so.tick(io); offs.push([t, so._keysMask & 1, so.deaths]);
		}
		const offAfter = offs.find(([t, k]) => t > p + 400 && k === 0);
		const resp = offs.find(([, , d]) => d === 1);
		console.log(`    old engine, same inputs: respawn in tick ${resp && resp[0]}, key off after tick ${offAfter && offAfter[0]}`);
	}
}

// ---------------------------------------------------------------- 8. spawn points and the start
section('Spawn points (file order, 1582 #0), start after load + /reset, no spawn');
{
	const L = mkLevel({ W: 12, spawns: [[7, 4], [2, 4], [4, 4]] });   // file order, not row-major
	const pos = (s) => `${s.px / 16},${s.py / 16}`;
	check('start "load" = spawnPoints[0][0]', pos(new E.EESim(L, { start: 'load' })) === '7,4');
	check('start "reset" (default) = spawnPoints[0][1 % n]: the load used index 0, /reset respawns at the next', pos(new E.EESim(L)) === '2,4');
	check('startSpawn overrides', pos(new E.EESim(L, { startSpawn: 2 })) === '4,4');
	// deaths without a checkpoint continue the rotation: 1 -> 2 -> 0
	const K = mkLevel({ W: 12, tiles: [[5, 3, 361], [7, 3, 361], [9, 3, 361]], spawns: [[5, 3], [7, 3], [9, 3]], floor: true });
	const sim = new E.EESim(K);   // starts at (7,3) on a spike: dies at once
	const inp = new E.EEInput(); const seen = [pos(sim)];
	for (let i = 0; i < 200; i++) { const d = sim.deaths; sim.tick(inp); if (sim.deaths !== d) seen.push(pos(sim)); }
	check('respawns without a checkpoint follow the rotation (start index 1, then 2, 0, 1)', seen.slice(0, 4).join(' ') === '7,3 9,3 5,3 7,3', seen.join(' '));
	const N0 = mkLevel({ W: 12, spawnPoints: [] });
	const N3 = mkLevel({ W: 12, spawnPoints: [[], [], [[4, 4]]] });
	check('no spawn point: (16,16) after load and after /reset', pos(new E.EESim(N0)) === '1,1' && pos(new E.EESim(N0, { start: 'load' })) === '1,1');
	check('only a 1582 spawn with another number: (16,16)', pos(new E.EESim(N3)) === '1,1');
	// through eelvl.js: records 255@(7,3), 1582#0@(2,3), 1582#3@(9,3), 255@(4,3) -> spawnPoints[0] = (7,3) (2,3) (4,3)
	const buf = writeEelvl({ W: 12, H: 7, records: [
		{ id: 9, xs: [...Array(12).keys(), ...Array(12).keys()], ys: [...Array(12).fill(0), ...Array(12).fill(6)] },
		{ id: 255, xs: [7], ys: [3] }, { id: 1582, xs: [2], ys: [3], args: [0] }, { id: 1582, xs: [9], ys: [3], args: [3] },
		{ id: 255, xs: [4], ys: [3] }] });
	const p = V.readEelvl(buf);
	const EL = E.prepareLevel(V.toSimLevel(p));
	const list = [...EL.spawnsX].map((x, i) => `${x},${EL.spawnsY[i]}`).join(' ');
	check('eelvl.js -> toSimLevel -> prepareLevel keeps file order and 1582 #0', list === '7,3 2,3 4,3' && EL.spawnOrder === 'file', list);
	check('... and starts at (2,3) after /reset, (7,3) after a plain load', pos(new E.EESim(EL)) === '2,3' && pos(new E.EESim(EL, { start: 'load' })) === '7,3');
	const t0 = Date.now();
	const big = V.toSimLevel(V.readEelvl(writeEelvl({ W: 12, H: 7, records: [{ id: 1582, xs: [5], ys: [3], args: [1e9] }, { id: 255, xs: [3], ys: [3] }] })));
	check('a 1582 with a huge number does not blow up toSimLevel (only id 0 matters)', Date.now() - t0 < 1000 && big.spawn_points[0].length === 1 &&
		pos(new E.EESim(E.prepareLevel(big))) === '3,3');
	for (const name of ['A Music Extravaganza.eelvl', '4x4 Labyrinth.eelvl', 'Egg Quest II.eelvl']) {
		const f = path.join(SAMPLES, name);
		if (!fs.existsSync(f)) continue;
		const S = V.loadEelvlLevel(f);
		const l = [...S.spawnsX].map((x, i) => `(${x},${S.spawnsY[i]})`).join(' ') || 'none';
		console.log(`    ${name}: spawnPoints[0] ${l}; start after /reset ${pos(new E.EESim(S))}, after a plain load ${pos(new E.EESim(S, { start: 'load' }))}`);
	}
}

// ---------------------------------------------------------------- 9. load/reset residue: 110/111, gravity, gold border
section('Load and /reset: 110/111 in the file, world gravity as stored, gold border');
{
	const L = mkLevel({ W: 12, tiles: [[2, 4, 255], [5, 4, 110], [7, 4, 111]], spawns: [[2, 4]] });
	const walk = (o) => drive(L, o, 120, () => RIGHT);
	const a = walk({}), b = walk({ start: 'load' });
	const last = (r) => r.rec[r.rec.length - 1];
	check('/reset turns file 110/111 into coins (World.resetCoins): collected on the way', last(a).coins === 1 && last(a).bcoins === 1);
	check('a plain load keeps them collected (not collectible)', last(b).coins === 0 && last(b).bcoins === 0);
	check('is_coin_collected at the start: load true, reset false', new E.EESim(L, { start: 'load' }).is_coin_collected(5, 4) && !new E.EESim(L).is_coin_collected(5, 4));
	// snapshot/restore over those coins
	const s = new E.EESim(L); const inp = new E.EEInput(); const snap0 = s.snapshot();
	for (let i = 0; i < 120; i++) { E.applyMask(inp, RIGHT); s.tick(inp); }
	const k1 = s.stateKey(); s.restore(snap0);
	check('restore brings the 100/101 tiles back (coinBaseId)', s.get_tile(5, 4) === 100 && s.get_tile(7, 4) === 101 && s.coins === 0);
	for (let i = 0; i < 120; i++) { E.applyMask(inp, RIGHT); s.tick(inp); }
	check('... and the replay after restore is identical', s.stateKey() === k1 && s.get_tile(5, 4) === 110);
	// gravity: used as stored (0 = none, negative = upwards); no fallback to 1
	const fall = (g) => { const G = mkLevel({ W: 8, H: 12, floor: false, spawns: [[3, 5]], gravity: g }); const r = drive(G, {}, 100, () => 0); return { L: G, y: last(r).py }; };
	const g0 = fall(0), g1 = fall(1), gm = fall(-1), g8 = fall(0.8);
	check('gravity 0: world_gravity_multiplier 0, the player floats', g0.L.gravityMult === 0 && g0.y === 80, `y ${g0.y}`);
	check('gravity -1: the player falls up', gm.L.gravityMult === -1 && gm.y < 80, `y ${gm.y}`);
	check('gravity 1: falls down', g1.y > 80);
	check('gravity 0.8 is the float32 value widened (0.800000011920929)', g8.L.gravityMult === Math.fround(0.8));
	// gold border
	const D = mkLevel({ W: 12, tiles: [[2, 4, 255], [6, 4, 200]], spawns: [[2, 4]] });
	const Gt = mkLevel({ W: 12, tiles: [[2, 4, 255], [6, 4, 201]], spawns: [[2, 4]] });
	const maxX = (lv, o) => Math.max(...drive(lv, o, 150, () => RIGHT).rec.map((r) => r.px));
	check('gold door 200: blocks without the gold border, open with it', maxX(D, {}) <= 80 && maxX(D, { goldBorder: true }) > 80);
	check('gold gate 201: open without, blocks with', maxX(Gt, {}) > 80 && maxX(Gt, { goldBorder: true }) <= 80);
	check('goldBorder as a level option (prepareLevel opts / gold_border)', maxX(mkLevel({ W: 12, tiles: [[2, 4, 255], [6, 4, 200]], spawns: [[2, 4]], opts: { goldBorder: true } }), {}) > 80);
}

// ---------------------------------------------------------------- 10. fire (lava) on the tick clock
section('Fire: setEffect(fire, true, 0, 2) on PlayState.ticks');
{
	const L = mkLevel({ W: 16, tiles: [[2, 4, 255], [4, 4, 416]], spawns: [[2, 4]] });
	const { rec, ev } = drive(L, {}, 400, () => RIGHT);
	const ign = rec.findIndex((r) => r.fire);
	const D = (ev.find((e) => e.k === 'death') || {}).t;
	check('lava ignites in tick p and kills in tick p + 241', ign > 0 && D === ign + 241, `p ${ign}, death ${D}`);
}

// ---------------------------------------------------------------- 11. snapshot / restore / stateKey
section('snapshot / restore (random order) and stateKey / stateHash consistency');
function snapCheck(name, level, simOpts, masks, nSnaps, horizon) {
	const sim = new E.EESim(level, simOpts); const inp = new E.EEInput();
	const keys = [], hashes = [], fields = [], snaps = new Map();
	let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
	const at = new Set(); while (at.size < nSnaps) at.add(Math.floor(rnd() * masks.length));
	const f = (s) => [s.px, s.py, s.speed_x, s.speed_y, s._ticks, s.run_ticks, s._keysMask, s._timedoor_state, s.deaths, s.coins, s._kt.join(','),
		s.frame_queue_ticks, s._stateQueue.join(','), s._keysQueue.join(','), s._next_spawn, s.is_dead, s._dead_offset].join('|');
	for (let t = 0; t < masks.length; t++) {
		if (at.has(t)) snaps.set(t, sim.snapshot());
		E.applyMask(inp, masks[t]); sim.tick(inp);
		keys.push(sim.stateKey()); hashes.push(sim.stateHash()); fields.push(f(sim));
	}
	const order = [...snaps.keys()].sort(() => rnd() - 0.5);
	let bad = 0, first = '';
	for (const t0 of order) {
		sim.restore(snaps.get(t0));
		for (let t = t0; t < Math.min(masks.length, t0 + horizon); t++) {
			E.applyMask(inp, masks[t]); sim.tick(inp);
			if (sim.stateKey() !== keys[t] || sim.stateHash() !== hashes[t] || f(sim) !== fields[t]) { bad++; if (!first) first = `from ${t0} at ${t + 1}`; break; }
		}
	}
	check(`${name}: ${nSnaps} snapshots restored in random order continue identically (${horizon} ticks each)`, bad === 0, first || 'all equal');
}
{
	if (fvLevel && fs.existsSync(FV_TAS[0])) snapCheck('FV', fvLevel, {}, E.parseEetasBytes(fs.readFileSync(FV_TAS[0])), 40, 600);
	const KQ = mkLevel({ W: 12, tiles: [[3, 4, 26], [4, 4, 6]], spawns: [[3, 4]] });
	snapCheck('deferred key + ticksPerFrame 2', KQ, { ticksPerFrame: 2 }, new Uint8Array(700).fill(RIGHT), 30, 300);
	const TD = mkLevel({ W: 14, tiles: [[5, 4, 156], [9, 4, 157], [3, 4, 255]], spawns: [[3, 4]] });
	const tdm = new Uint8Array(2600); for (let i = 0; i < tdm.length; i++) tdm[i] = (i % 300) < 150 ? RIGHT : LEFT | (i % 7 === 0 ? JUMP : 0);
	snapCheck('time doors', TD, {}, tdm, 30, 500);
	const DR = mkLevel({ W: 14, tiles: [[1, 4, 255], [3, 4, 6], [7, 4, 23], [8, 4, 361], [10, 4, 416]], spawns: [[1, 4], [2, 4]] });
	const drm = new Uint8Array(1500); for (let i = 0; i < drm.length; i++) drm[i] = (i % 97) < 60 ? RIGHT : 0;
	snapCheck('deaths, respawns, keys, fire', DR, {}, drm, 30, 400);
}

// ---------------------------------------------------------------- 12. speed (each engine in a fresh process: one
// level, one sim, like the optimizer's workers; this process has JIT feedback from dozens of test levels)
if (!QUICK && fvLevel && fs.existsSync(FV_TAS[0])) {
	section('Throughput (FV TAS, onEvent null, fresh process per engine)');
	const { execFileSync } = require('child_process');
	const benchSrc = `
		const fs = require('fs'); const E = require(process.argv[1]); const V = require(process.argv[2]);
		const L = E.prepareLevel(V.toSimLevel(V.readEelvl(fs.readFileSync(process.argv[3]))));
		const b = fs.readFileSync(process.argv[4]); const masks = new Uint8Array(b.length);
		for (let i = 0; i < b.length; i++) masks[i] = (b[i] - 48) & 31;
		const sim = new E.EESim(L); const inp = new E.EEInput(); let best = Infinity;
		for (let rep = 0; rep < 25; rep++) {
			sim.reset(); const t0 = process.hrtime.bigint();
			for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
			best = Math.min(best, Number(process.hrtime.bigint() - t0));
		}
		sim.reset(); for (let t = 0; t < 5000; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); }
		let s = null; const n = 200000; const ns = (f) => { const t0 = process.hrtime.bigint(); f(); return (Number(process.hrtime.bigint() - t0) / n).toFixed(0); };
		const a = ns(() => { for (let i = 0; i < n; i++) s = sim.snapshot(s); });
		const r = ns(() => { for (let i = 0; i < n; i++) sim.restore(s); });
		let h = 0; const hh = ns(() => { for (let i = 0; i < n; i++) h += sim.stateHash(); });
		let k = 0; const kk = ns(() => { for (let i = 0; i < n; i++) k += sim.stateKey().length; });
		console.log((masks.length / (best / 1e9) / 1e6).toFixed(2) + ' M ticks/s (best of 25); snapshot(reuse) ' + a + ' ns, restore ' + r +
			' ns, stateHash ' + hh + ' ns, stateKey ' + kk + ' ns');`;
	const run = (mod) => execFileSync(process.execPath, ['-e', benchSrc, path.resolve(mod), path.resolve(__dirname, '../src/eelvl.js'), FV_LEVEL, FV_TAS[0]],
		{ encoding: 'utf8' }).trim();
	const engines = [['new', path.resolve(__dirname, '../src/eesim.js')]];
	if (OLD && fs.existsSync(OLD)) engines.push(['old', OLD]);
	for (let rep = 0; rep < 2; rep++) for (const [name, mod] of engines) console.log(`  ${name}: ${run(mod)}`);
}

// ---------------------------------------------------------------- helpers used above
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
