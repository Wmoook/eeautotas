'use strict';
// The steer field v4 (src/steer.js; ordering only, never a prune). Sections:
//   A model    hand-made rooms of a key door, a coin door (the distinct-coin DP) and a purple switch: the features and
//              layers, the steer cost at the start counts the detour to the key / coins / switch (the reach field's
//              does not), with the key (switch, coins) taken it is the reach field's again; the RCH4 file round trip
//              (readSteerFile gives the same numbers); another level's file is refused by the native tool; the build's
//              byte budget: one body's bytes leave the key out (info.over); the forced portals' lastPortal chains (a
//              portal next to an exit walked: reach.js unforceChains), with --jobs Good Egg along OC's run; the layer
//              memo (default on; EEAT_STEER_MEMO=0 off): the same file on 7 toys, identical layers one field, the spares, the knob,
//              the budget clock ('same' cuts what the build without it cuts; 'spend' does not) on a fake clock
//   B agree    the JS lookup and the native tool's (eegpu steertest: the host, and with --gpu the GPU) along random input
//              runs in the rooms and, with --jobs=<dir> (default src/jobs), along the big jobs' best runs: the same fifths
//              and the beam's score to the bit (skipped without a native tool that reads RCH4)
//   C prune    the native explore with a garbage steer field (random costs) still finds the key room's route: the steer
//              field only orders (only the reach field's -1 rules states out); the CPU search (goexplore.js --steer)
//              finds it too, and one worker with a tick budget is reproducible
// usage: node test/steer.js [--only=A,B,C] [--gpu] [--tool=<eegpu>] [--jobs=<dir>] [--exploreSec=60]
// Exit code 1 if any check fails. Run the --gpu part through the machine's GPU lock (src/out/gpulock.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const R = require('../src/reach.js');
const SF = require('../src/steer.js');
const G = require('../src/gpu.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const GPU = argv.includes('--gpu');
// (C: the explore's time limit; more on a GPU other work keeps busy: at 60 s the plain explore too ran out of time there)
const EXPLORE_S = +arg('exploreSec', '60');
const want = (s) => !ONLY.length || ONLY.includes(s);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-steer-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

// ASCII rooms: # wall, . air, S spawn, T trophy, k red key, d red door, $ coin, c coin door (2 coins), s purple switch 1,
// g purple switch door 1
const ID = { '#': [9], S: [255], T: [121], k: [6], d: [23], $: [100], c: [43, 2], s: [113, 1], g: [184, 1] };
function ascii(rows) {
	const H = rows.length, W = rows[0].length, cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; const v = ID[ch]; if (!v) throw new Error(`legend ${ch}`); cells.push([x, y, ...v]); }));
	return { buf: ED.eelvlOf({ name: 't', width: W, height: H, cells }), W, H };
}
const levelOf = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
const wall = (w) => '#'.repeat(w);
const row = (inner) => `#${inner}#`;
// the trophy behind a door on the right, the key (coins, switch) on the far left: the start is between
function room(k) {
	const w = 40;
	const mid = '.'.repeat(w - 2);
	const floor = [...mid];
	floor[1] = k === 'key' ? 'k' : k === 'switch' ? 's' : '$';
	if (k === 'coins') floor[3] = '$';
	floor[18] = 'S';
	floor[w - 6] = k === 'key' ? 'd' : k === 'switch' ? 'g' : 'c';
	floor[w - 4] = 'T';
	// (the door is the whole column: no jump over it)
	const top = [...mid]; top[w - 6] = floor[w - 6];
	const t = top.join('');
	return ascii([wall(w), row(t), row(t), row(t), row(t), row(floor.join('')), wall(w)]);
}
const ROOMS = { key: room('key'), coins: room('coins'), switch: room('switch') };
const toolPath = arg('tool', G.nativeTool());
let toolOk = false;
if (toolPath) { try { execFileSync(toolPath, ['steertest'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { toolOk = /steertest/.test(String(e.stderr || '')); } }

function sectionA() {
	section('A the model: layers, detours, the file');
	for (const [name, r] of Object.entries(ROOMS)) {
		const L = levelOf(r.buf);
		const st = SF.buildSteer(L);
		const f = R.reachField(L);
		const sim = new E.EESim(L); sim.reset();
		const s0 = SF.steerAt(st, sim), r0 = R.costAt(f, sim);
		check(`${name}: modelled (${st.info.features.join(', ')}; ${st.info.layers} layers${st.dp ? `, coin DP ${st.dp.n}` : ''})`, st.S > 1 || !!st.dp);
		// (the key / coins / switch are 17-15 tiles left of the start, the door right: the detour there and back)
		check(`${name}: the steer cost at the start counts the detour (steer ${s0}, reach ${r0})`, s0 > r0 + 25, `${s0} vs ${r0}`);
		// taken: the reach field's cost again (the door open in the ball's layer)
		if (name === 'key') sim._keysMask |= 1;
		else if (name === 'switch') { sim._switches = new Map([[1, true]]); }
		else { sim.coins = 2; }
		const s1 = SF.steerAt(st, sim);
		check(`${name}: taken, the steer cost is the reach field's (${s1} vs ${r0})`, Math.abs(s1 - r0) <= 1, `${s1}`);
		const rd = SF.readSteerFile(SF.steerFileBytes(st, G.blobFp(G.levelBlob(L))));
		let same = true;
		const sim2 = new E.EESim(L); sim2.reset();
		const inp = new E.EEInput();
		for (let t = 0; t < 400 && same; t++) { E.applyMask(inp, [4, 4, 5, 2, 0, 3][(t / 37 | 0) % 6]); sim2.tick(inp); if (SF.steerFifths(st, sim2) !== SF.steerFifths(rd, sim2) || SF.steerScore(st, sim2) !== SF.steerScore(rd, sim2)) same = false; }
		check(`${name}: the RCH4 file round trip gives the same numbers`, same);
		if (name === 'coins') {
			// the coin plan's next gate (the wall breaker's stall target): a coin of the room from the start, none once the
			// door's coins are taken
			const s3 = new E.EESim(L); s3.reset();
			const g = SF.nextGate(rd, s3);
			const tile = g ? [...L.coinBit].indexOf(g.bit) : -1;
			check(`coins: the coin plan's next gate from the start is a coin of the room (tile ${tile % L.width},${Math.floor(tile / L.width)})`, tile >= 0 && L.fg[tile] !== 0);
			s3.coins = 2;
			check('coins: no next gate with the door\'s coins taken', SF.nextGate(rd, s3) === null);
			// the coin legs on worker threads (steer.js legPool) = the legs one after another: the same file, bit for bit;
			// also the plan past its count's layered legs (coinLegsLayered: arrival costs from the workers)
			const bytesOf = (o) => SF.steerFileBytes(SF.buildSteer(L, Object.assign({ maxMs: 600000 }, o)), null);
			const same0 = Buffer.compare(bytesOf({ legThreads: 0 }), bytesOf({ legThreads: 2 })) === 0;
			check('coins: the coin legs on 2 worker threads give the same steer file as one after another', same0);
			const T = st.dp ? st.dp.T : 2;
			const p0 = bytesOf({ legThreads: 0, coinT: T }), p2 = bytesOf({ legThreads: 2, coinT: T });
			check(`coins: the layered legs (coinT ${T}) on 2 worker threads give the same steer file`, Buffer.compare(p0, p2) === 0);
		}
	}
	// the build's budget: a byte budget of one body leaves the key out (one layer), said in info.over
	{
		const L = levelOf(ROOMS.key.buf);
		const b1 = SF.buildSteer(L, { maxBytes: L.width * L.height * 120 });
		check('the build\'s budget: one body\'s bytes leave the key out (one layer, info.over)', b1.S === 1 && /key0: over 1 layers/.test(b1.info.over || ''), `${b1.S} ${b1.info.over}`);
	}
	if (toolOk) {
		const a = levelOf(ROOMS.key.buf), b = levelOf(ROOMS.switch.buf);
		fs.writeFileSync(path.join(tmp, 'a.bin'), G.levelBlob(a));
		fs.writeFileSync(path.join(tmp, 'b.steer'), SF.steerFileBytes(SF.buildSteer(b), G.blobFp(G.levelBlob(b))));
		C.writeEetas(path.join(tmp, 'r.eetas'), [4, 4, 4]);
		let out = '';
		try { out = execFileSync(toolPath, ['steertest', path.join(tmp, 'a.bin'), path.join(tmp, 'b.steer'), path.join(tmp, 'r.eetas')], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
		check('another level\'s steer file is refused by the native tool', /another level/.test(out), out.trim().slice(0, 120));
	}
	forcedChains();
	secretWall();
	timeDoors();
	keyExpiry();
	layerMemo();
}

/** a 40 x 7 corridor of the given cells ([x, y, id, ...args]) inside walls */
function box(name, extra) {
	const W = 40, H = 7, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
	return levelOf(ED.eelvlOf({ name, width: W, height: H, cells: cells.concat(extra) }));
}
/** the layer memo (steer.js buildPhysics, default on; layerMemo false / EEAT_STEER_MEMO=0 off): a layer's field built once per (level
 *  copy, goals), the file the same byte for byte. The coin corridor: 6 coins left of the spawn, a 6-coin door column
 *  before the trophy: the layers coins 0..5 are one copy (the door shut; a coin tile is no goal with staticCoins), so 2
 *  physics fields instead of 7. The effect corridor: 3 coins, a jump effect (wild) and its reset (plain) between the
 *  spawn and a 3-coin door: each count's plain / wild pair is a strongly connected pair that iterates, and the next
 *  count's pair with the same copies takes the first one's fields (the spares); the wild fields' key carries the model */
function layerMemo() {
	const H = 7;
	const coinCorr = box('memo coins', [[16, H - 2, 255], [34, H - 2, 121], ...[2, 4, 6, 8, 10, 12].map((x) => [x, H - 2, 100]), ...[1, 2, 3, 4, 5].map((y) => [28, y, 43, 6])]);
	const fxCorr = box('memo fx', [[16, H - 2, 255], [34, H - 2, 121], [2, H - 2, 100], [4, H - 2, 100], [6, H - 2, 100], [10, H - 2, 417, 1], [20, H - 2, 417, 0], ...[1, 2, 3, 4, 5].map((y) => [28, y, 43, 3])]);
	const keyCorr = box('memo key', [[2, H - 2, 6], [12, H - 2, 255], [30, H - 2, 121], ...[1, 2, 3, 4, 5].flatMap((y) => [[20, y, 23], [24, y, 26]])]);
	const levels = [['key room', levelOf(ROOMS.key.buf)], ['coin room', levelOf(ROOMS.coins.buf)], ['switch room', levelOf(ROOMS.switch.buf)], ['coin corridor', coinCorr], ['effect corridor', fxCorr], ['key expiry corridor', keyCorr], ['time door corridor', corridor([156, 0, 157])]];
	// (the reach fields a build makes: steer.js calls reach.js's reachField through the module, as this test holds it)
	const orig = R.reachField;
	let calls = 0;
	R.reachField = function (lv, o) { calls++; return orig.call(this, lv, o); };
	const build = (L, o) => { calls = 0; const st = SF.buildSteer(L, Object.assign({ maxMs: 600000, legThreads: 0 }, o)); const sim = new E.EESim(L); sim.reset(); return { st, calls, bytes: SF.steerFileBytes(st, null), cpu: st.tour ? SF.steerFileBytes(st, null, true) : null, v: SF.steerAt(st, sim), hits: st.info.cegar.reduce((a, c) => a + (c.memo || 0), 0) }; };
	try {
		const bad = [];
		const rows = [];
		for (const [name, L] of levels) {
			const off = build(L, { layerMemo: false }), on = build(L, { layerMemo: true });
			const same = Buffer.compare(off.bytes, on.bytes) === 0 && (off.cpu === null) === (on.cpu === null) && (!off.cpu || Buffer.compare(off.cpu, on.cpu) === 0) && Object.is(off.v, on.v);
			if (!same || off.hits || on.calls > off.calls) bad.push(name);
			rows.push(`${name} ${off.calls} -> ${on.calls} fields (${on.hits} hits), start ${on.v}`);
		}
		check(`the layer memo: the same steer file (GPU and CPU) and start value with and without it on ${levels.length} levels, never more reach fields, no hits with it off`, !bad.length, bad.length ? `differ: ${bad.join(', ')}` : rows.join('; '));
		const c0 = build(coinCorr, { layerMemo: false }), c1 = build(coinCorr, { layerMemo: true });
		check('the layer memo: the coin corridor\'s six identical coin layers (the 6-coin door shut) make one field', c1.st.info.features.includes('coins') && c1.hits >= 5 && c0.calls - c1.calls >= 5, `${c0.calls} -> ${c1.calls} reach fields, ${c1.hits} hits, layers ${c1.st.info.layers}`);
		const f1 = build(fxCorr, { layerMemo: true });
		const A = SF.analyze(fxCorr, {}), B = SF.walkBuild(fxCorr, A, { features: ['coins'] });
		const memo = new Map(), PH = SF.buildPhysics(B, { staticCoins: true, debug: true, memo });
		const held = new Set(PH.fields.filter(Boolean)).size;
		check('the layer memo: the effect corridor\'s plain / wild pairs of equal copies share their fields (the spares), and after the call the memo holds only the fields its layers hold',
			f1.hits > 0 && PH.memoHits > 0 && memo.size === held && [...memo.values()].every((e) => PH.fields.includes(e.f)), `hits ${f1.hits} (buildSteer) / ${PH.memoHits} (one call); memo ${memo.size} fields, the layers hold ${held}`);
		// (the knob, read at the build: unset = on ('same', the default since d4-steer-memo-ab), EEAT_STEER_MEMO=1 on,
		// EEAT_STEER_MEMO=0 off)
		const prev = process.env.EEAT_STEER_MEMO;
		delete process.env.EEAT_STEER_MEMO;
		const kd = build(coinCorr, {});
		process.env.EEAT_STEER_MEMO = '1';
		const k1 = build(coinCorr, {});
		process.env.EEAT_STEER_MEMO = '0';
		const k0 = build(coinCorr, {});
		if (prev !== undefined) process.env.EEAT_STEER_MEMO = prev; else delete process.env.EEAT_STEER_MEMO;
		check('the memo\'s knob: unset on (the default: the hits and fields of layerMemo true), EEAT_STEER_MEMO=1 on, EEAT_STEER_MEMO=0 off (no hits, the fields as before); the same file all three',
			kd.hits > 0 && kd.hits === c1.hits && kd.calls === c1.calls && k1.hits > 0 && k0.hits === 0 && k0.calls === c0.calls && Buffer.compare(k0.bytes, k1.bytes) === 0 && Buffer.compare(kd.bytes, k1.bytes) === 0,
			`hits ${kd.hits} / ${k1.hits} / ${k0.hits}, fields ${kd.calls} / ${k1.calls} / ${k0.calls}`);
	} finally { R.reachField = orig; }
	// the budget's clock, on a fake clock (every reach field 100 ms, nothing else takes time): the coin corridor's 7 layer
	// fields take 700 ms without the memo, 200 with it; a 600-ms budget drops the coin DP without the memo ("the coin DP:
	// the build's time") and with it in 'same' mode (the clock counts the 5 repeats: 700), the same file; 'spend' (the
	// real clock: 200) builds the DP
	const realNow = Date.now;
	let fake = 1e12;
	Date.now = () => fake;
	R.reachField = function (lv, o) { const f = orig.call(this, lv, o); fake += 100; return f; };
	try {
		const arm = (m) => { const st = SF.buildSteer(coinCorr, { maxMs: 600, legThreads: 0, layerMemo: m }); return { st, bytes: SF.steerFileBytes(st, null), cpu: st.tour ? SF.steerFileBytes(st, null, true) : null }; };
		const off = arm(false), same = arm(true), spend = arm('spend');
		const eq = (a, b) => Buffer.compare(a.bytes, b.bytes) === 0 && (a.cpu === null) === (b.cpu === null) && (!a.cpu || Buffer.compare(a.cpu, b.cpu) === 0);
		check('the memo\'s budget clock (fake: 100 ms a reach field, a 600-ms budget): without the memo the coin DP is dropped by the time, with it (\'same\') the same file, \'spend\' builds the DP',
			/coin DP: the build's time/.test(off.st.info.over || '') && !off.st.dp && eq(off, same) && !!spend.st.dp && !eq(off, spend),
			`off: ${off.st.info.over}, dp ${!!off.st.dp}; same: ${same.st.info.over}, the same file ${eq(off, same)}; spend: ${spend.st.info.over}, dp ${spend.st.dp ? `${spend.st.dp.n}/${spend.st.dp.T}` : 'none'}`);
	} finally { Date.now = realNow; R.reachField = orig; }
}

/** a 40 x 7 corridor, the spawn at x 5, the trophy at x 30, full-height columns of the given ids from x 20 on */
function corridor(cols) {
	const W = 40, H = 7, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
	cells.push([5, H - 2, 255], [30, H - 2, 121]);
	cols.forEach((id, k) => { if (id) for (let y = 1; y < H - 1; y++) cells.push([20 + k, y, id]); });
	return levelOf(ED.eelvlOf({ name: 'td', width: W, height: H, cells }));
}
/** time doors (156 open in the second half of every 1000 ticks, 157 in the first: never both shut) are passable in the
 *  steer's walk and physics models with a wait in the walk plan (steer.js 'time', TIME_WAIT); before 2026-09-29 they
 *  were static walls: a level whose only way passes one had 'start has no way' and no steer value (ML's First Samurai,
 *  SPOT THE DIDFERNECE, MKco, Phina, Mr Nutty's). Held right, the engine waits at the column and finishes */
function timeDoors() {
	const air = corridor([]);
	const walkCost = (L, o) => { const A = SF.analyze(L, o); const B = SF.walkBuild(L, A, { features: [] }); return { B, c: B.plan.ok ? B.F.cost[B.M.s0 * A.N + A.start.t] : Infinity }; };
	const c0 = walkCost(air, {}).c;
	// (a door and a gate a tile apart: the phase must turn between them, two waits; side by side the engine traps the
	// ball in the door that shuts on it, which the model, a relaxation, does not know)
	for (const [cols, waits] of [[[156], 1], [[157], 1], [[156, 0, 157], 2]]) {
		const L = corridor(cols);
		const at = (o) => { const st = SF.buildSteer(L, o); const sim = new E.EESim(L); sim.reset(); return SF.steerAt(st, sim); };
		const sOff = at({ timeDoors: false }), sOn = at({ timeDoors: true });
		const off = walkCost(L, { timeDoors: false }), on = walkCost(L, { timeDoors: true });
		const ev = C.evaluate(L, Uint8Array.from(new Array(1700).fill(4)));
		check(`a column of ${cols.filter(Boolean).join(' and a column of ')} between the start and the trophy: walls as before with timeDoors false (no walk plan, no steer value), passable with them (a plan; the walk cost the air's + ${waits} x TIME_WAIT; a steer value); held right finishes in the engine`,
			!off.B.plan.ok && !Number.isFinite(sOff) && on.B.plan.ok && on.c - c0 === waits * SF.TIME_WAIT && Number.isFinite(sOn) && !!ev,
			`off: plan ${off.B.plan.ok ? 'ok' : off.B.plan.why}, steer ${sOff}; on: plan ${on.B.plan.ok ? 'ok' : on.B.plan.why}, walk ${on.c} vs air ${c0}, steer ${sOn}; engine ${ev ? `${ev.runTicks} run ticks` : 'no finish'}`);
	}
	// (EEAT_TIMEDOOR=0: main's walls, read at the build)
	const L = corridor([156]);
	const prev = process.env.EEAT_TIMEDOOR;
	process.env.EEAT_TIMEDOOR = '0';
	const A0 = SF.analyze(L, {});
	if (prev === undefined) delete process.env.EEAT_TIMEDOOR; else process.env.EEAT_TIMEDOOR = prev;
	const A1 = SF.analyze(L, {});
	check('EEAT_TIMEDOOR=0: time doors static walls again (the knob); unset: the time class', A0.gateFeat[3 * 40 + 20] === 'static' && A1.gateFeat[3 * 40 + 20] === 'time');
}
/** key expiry: a key runs out 500 ticks after it is taken, so the layer graph has (tile, key on) -> (tile, key off). A
 *  corridor: the red key left of the spawn, a red key DOOR (23: open while the key is on) and then a red key GATE (26:
 *  shut while it is on) to the right, the trophy past both: the way takes the key, passes the door and waits at the gate
 *  for the key to run out. Without expiry the key layer's gate never reopens: no value at the start */
function keyExpiry() {
	const W = 40, H = 7, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9], [20, y, 23], [24, y, 26]);
	cells.push([2, H - 2, 6], [12, H - 2, 255], [30, H - 2, 121]);
	const L = levelOf(ED.eelvlOf({ name: 'ke', width: W, height: H, cells }));
	const at = (o) => { const st = SF.buildSteer(L, o); const sim = new E.EESim(L); sim.reset(); return { st, v: SF.steerAt(st, sim) }; };
	const off = at({ keyExpiry: false }), on = at({ keyExpiry: true });
	const r0 = R.costAt(R.reachField(L), (() => { const s = new E.EESim(L); s.reset(); return s; })());
	const A = SF.analyze(L, { keyExpiry: true });
	const B = SF.walkBuild(L, A, { features: [] });
	const exp = B.plan.path.filter((p) => p.via === 'expire').length;
	const ev = C.evaluate(L, Uint8Array.from([...new Array(90).fill(2), ...new Array(1500).fill(4)]));
	check('key expiry: the key layer\'s own gate reopens (no steer value at the start without it; with it a value that counts the key\'s detour; the walk plan lets the key run out); left to the key, then right finishes in the engine',
		!Number.isFinite(off.v) && Number.isFinite(on.v) && on.v > r0 + 15 && on.st.info.features.includes('key0') && B.plan.ok && exp >= 1 && !!ev,
		`without ${off.v}, with ${on.v} (reach ${r0}; features ${on.st.info.features.join(', ')}); walk plan ${B.plan.ok ? 'ok' : B.plan.why}, ${exp} expiry step(s); engine ${ev ? `${ev.runTicks} run ticks` : 'no finish'}`);
	// in the key layer past the door, before the gate: a value (the key-off layer's), where it was none
	const sim = new E.EESim(L); sim.reset(); sim.px = 22 * 16; sim.py = (H - 2) * 16; sim._keysMask = 1;
	const inOff = SF.steerAt(off.st, sim), inOn = SF.steerAt(on.st, sim);
	check('key expiry: between the door and the gate with the key on, a value (the key-off layer\'s way through the gate)', !Number.isFinite(inOff) && Number.isFinite(inOn), `${inOff} -> ${inOn}`);
}

/** 50, the secret "appear" block (eesim.js F_DOOR, but it always blocks: reach.js guideFlags) is a wall to the steer
 *  field, not a door of GATE's "the rest open": a full-height column of it between the start and the trophy, the way a
 *  portal behind the start to an exit past the trophy. Before 2026-09-28 the steer walked through it (This is not snow's
 *  trophy fenced by six: 16.8 tiles at the stall, 272.4 with them as walls) */
function secretWall() {
	const W = 40, H = 7, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
	cells.push([15, H - 2, 255], [2, H - 2, 242, 1, 1, 2], [38, H - 2, 242, 1, 2, 9], [23, H - 2, 121]);
	const withCol = (id) => {
		const c = cells.slice();
		if (id) for (let y = 1; y < H - 1; y++) c.push([20, y, id]);
		return levelOf(ED.eelvlOf({ name: 'secret', width: W, height: H, cells: c }));
	};
	const La = withCol(50), Lw = withCol(9), L0 = withCol(0);
	const at = (L) => { const st = SF.buildSteer(L); const sim = new E.EESim(L); sim.reset(); return SF.steerAt(st, sim); };
	const sa = at(La), sw = at(Lw), s0 = at(L0);
	const A = SF.analyze(La, {});
	let cls0 = 0;
	for (let y = 1; y < H - 1; y++) if (A.cls[y * W + 20] === 0) cls0++;
	const ev = C.evaluate(La, Uint8Array.from([...new Array(160).fill(2), ...new Array(400).fill(0)]));
	check('a column of 50 (secret "appear") between the start and the trophy: a wall to the steer (analyze class 0; the cost of a column of 9, the portal detour; more than through air)',
		cls0 === H - 2 && Number.isFinite(sa) && sa === sw && sa > s0 + 10, `50 ${sa}, 9 ${sw}, air ${s0}; ${cls0} of ${H - 2} tiles walls; left to the portal ${ev ? `finishes (${ev.runTicks} run ticks)` : 'does not finish'}`);
}

/** the ordering fields' forced portals and a ball that a teleport put on a portal exit (the n2-int gate study's defect,
 *  reach.js unforceChains): it keeps lastPortal over every portal tile it moves on to (eesim.js processPortals), so a
 *  portal next to an exit is walked, not a teleport. A corridor: the start, portal 1 across it (to 2), its exit 2 with a
 *  column of portal 4 (to 5, back by the start) right of it and the trophy; holding right finishes in the engine. Forced,
 *  portal 4 sent the model back to the start: the trophy out of reach, the ordering field cut and the steer without a
 *  value there. With --jobs (default src/jobs), Good Egg along its OC run (the pocket columns x = 1 / 3:
 *  the steer had no value and no next gate in 2,258 of its 4,204 states, coins 0-8) */
function forcedChains() {
	const W = 40, H = 8, y = H - 2, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let yy = 1; yy < H - 1; yy++) cells.push([0, yy, 9], [W - 1, yy, 9]);
	// portal 1 (to 2) and portal 4 (to 5) across the corridor; the exit 2 left of portal 4's column; 5 by the start
	for (let yy = 1; yy < H - 1; yy++) cells.push([6, yy, 242, 1, 1, 2], [21, yy, 242, 1, 4, 5]);
	cells.push([2, y, 255], [20, y, 242, 1, 2, 9], [3, 1, 242, 1, 5, 9], [34, y, 121]);
	const buf = ED.eelvlOf({ name: 'chain', width: W, height: H, cells });
	const L = levelOf(buf);
	const ev = C.evaluate(L, new Uint8Array(600).fill(4));
	const sim = new E.EESim(L); sim.reset();
	const st = SF.buildSteer(L), f = R.reachField(L, { oneWayEntry: true, portalForced: true });
	const s0 = SF.steerAt(st, sim), f0 = R.costAt(f, sim);
	check('a portal next to the exit a teleport put the ball on is walked (lastPortal), not forced: holding right finishes; the ordering field (portalForced) and the steer have a value at the start',
		!!ev && ev.deaths === 0 && f0 >= 0 && Number.isFinite(s0),
		`${ev ? `${ev.runTicks} run ticks, ${ev.deaths} deaths` : 'no finish'}; field ${f0}, steer ${s0}`);
	const jobs = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	let ids = [];
	try { ids = fs.readdirSync(jobs).filter((d) => /good-egg-galaxy-oc/.test(d) && fs.existsSync(path.join(jobs, d, 'original.eelvl')) && fs.existsSync(path.join(jobs, d, 'original.eetas'))); } catch (e) { /* no jobs */ }
	if (!ids.length) { console.log(`  (skipped: no Good Egg job with OC's run in ${jobs})`); return; }
	const G2 = levelOf(fs.readFileSync(path.join(jobs, ids[0], 'original.eelvl')));
	const ms = C.readEetas(path.join(jobs, ids[0], 'original.eetas'));
	const sg = SF.buildSteer(G2), s2 = new E.EESim(G2), in2 = new E.EEInput();
	s2.reset();
	let n = 0, nan = 0, noGate = 0, dpn = 0;
	for (let t = 0; t <= ms.length; t++) {
		if (t > 0) { E.applyMask(in2, ms[t - 1]); s2.tick(in2); }
		if (s2.has_silver_crown) break;
		if (s2.is_dead) continue;
		n++;
		if (Number.isNaN(SF.steerAt(sg, s2))) nan++;
		if (sg.dp && s2.coins < sg.dp.T) { dpn++; if (!SF.nextGate(sg, s2)) noGate++; }
	}
	check(`Good Egg along OC's run (${ids[0]}): the steer has a value and the coin plan a next gate almost everywhere (at most 1% without)`,
		!!sg.dp && n > 1000 && nan <= n / 100 && noGate <= dpn / 100, `${n} states, ${nan} without a value, ${noGate} of ${dpn} without a next gate; coin DP ${sg.dp ? sg.dp.n : 0}`);
}
function agree(name, L, st, runs) {
	const blob = G.levelBlob(L);
	fs.writeFileSync(path.join(tmp, 'l.bin'), blob);
	fs.writeFileSync(path.join(tmp, 's.steer'), SF.steerFileBytes(st, G.blobFp(blob)));
	let n = 0, dF = 0, dS = 0, gF = 0, gS = 0, err = '';
	for (const m of runs) {
		C.writeEetas(path.join(tmp, 'r.eetas'), m);
		let raw = '';
		try { raw = execFileSync(toolPath, ['steertest', path.join(tmp, 'l.bin'), path.join(tmp, 's.steer'), path.join(tmp, 'r.eetas'), ...(GPU ? ['--gpu=1', ...G.cacheArgs()] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 }); } catch (e) { raw = String(e.stdout || '') || JSON.stringify({ error: e.message }); }
		let out;
		try { out = JSON.parse(raw.trim().split('\n').pop()); } catch (e) { out = { error: raw.slice(0, 200) }; }
		if (out.error) { err = out.error; break; }
		const sim = new E.EESim(L); sim.reset();
		const inp = new E.EEInput();
		const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
		for (let t = 0; t < m.length; t++) {
			E.applyMask(inp, m[t]); sim.tick(inp);
			const f = SF.steerFifths(st, sim);
			fb[0] = f >= 0 ? SF.steerScore(st, sim) : -1;
			n++;
			if (out.host[t] !== f) dF++;
			if (out.hostScore[t] !== ub[0]) dS++;
			if (out.gpu) { if (out.gpu[t] !== f) gF++; if (out.gpuScore[t] !== ub[0]) gS++; }
		}
	}
	check(`${name}: JS = native steertest (host${GPU ? ' and GPU' : ''}) on ${n} states`, !err && dF + dS + gF + gS === 0, err || `fifths ${dF} / scores ${dS}${GPU ? `, GPU ${gF} / ${gS}` : ''} differ`);
}
function randomRuns(k, n, len) {
	let seed = 12345 + k;
	const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
	const out = [];
	for (let r = 0; r < n; r++) { const m = new Uint8Array(len); let cur = 0; for (let t = 0; t < len; t++) { if (rnd() > 0.85) cur = [0, 1, 2, 4, 5, 3, 6, 4, 4, 5, 2][Math.floor(rnd() * 11)]; m[t] = cur; } out.push(m); }
	return out;
}
function sectionB() {
	section('B agree: the JS lookup = eegpu steertest');
	if (!toolOk) { console.log(`  (skipped: ${toolPath ? `${toolPath} has no steertest (older than the app: rebuild it, node tools/build-native.js)` : 'no native tool'})`); return; }
	Object.entries(ROOMS).forEach(([name, r], k) => { const L = levelOf(r.buf); agree(name, L, SF.buildSteer(L), randomRuns(k, 6, 600)); });
	const jobs = arg('jobs', path.join(__dirname, '..', 'src', 'jobs'));
	let ids = [];
	try { ids = fs.readdirSync(jobs).filter((d) => fs.existsSync(path.join(jobs, d, 'original.eelvl')) && fs.existsSync(path.join(jobs, d, 'best.eetas'))); } catch (e) { /* no jobs */ }
	const seen = new Set();
	for (const id of ids) {
		const buf = fs.readFileSync(path.join(jobs, id, 'original.eelvl'));
		const L = levelOf(buf);
		if (L.width * L.height < 20000) continue;
		const key = `${L.width}x${L.height}:${buf.length}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const st = SF.buildSteer(L);
		if (!(st.S > 1 || st.dp)) continue;
		agree(id, L, st, [C.readEetas(path.join(jobs, id, 'best.eetas')), ...randomRuns(ids.indexOf(id), 2, 2000)]);
	}
}

function sectionC() {
	section('C prune: the steer field only orders');
	const r = ROOMS.key;
	const L = levelOf(r.buf);
	const st = SF.buildSteer(L);
	const lf = path.join(tmp, 'key.eelvl');
	fs.writeFileSync(lf, r.buf);
	if (toolOk) {
		// a garbage steer field: every body's costs random
		let seed = 99;
		const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
		for (const b of st.bodies) for (const k of ['costR', 'costF', 'costL', 'costC', 'costX', 'walk']) if (b[k]) { const a = b[k] = Uint16Array.from(b[k]); for (let i = 0; i < a.length; i++) a[i] = rnd() < 0.3 ? R.CUT : (rnd() * 4000) | 0; }
		const blob = G.levelBlob(L);
		fs.writeFileSync(path.join(tmp, 'k.bin'), blob);
		fs.writeFileSync(path.join(tmp, 'k.steer'), SF.steerFileBytes(st, G.blobFp(blob)));
		R.writeReachFile(R.reachField(L), path.join(tmp, 'k.reach'), G.blobFp(blob));
		const run = (extra) => {
			let out = '';
			try { out = execFileSync(toolPath, ['explore', path.join(tmp, 'k.bin'), '-', '--finish=1', '--discrete=1', '--depth=1500', `--seconds=${EXPLORE_S}`, '--coarse=0', '--cqx=0.5', '--cqv=16', '--qy=1', '--qvy=16', `--reach=${path.join(tmp, 'k.reach')}`, '--prune=1', ...extra, ...G.cacheArgs()], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { out = String(e.stdout || ''); }
			let fin = null, steer = false;
			for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j.ev === 'hit') fin = fin || j; if (j.ev === 'done' && j.finish) fin = fin || j; if (j.ev === 'steer') steer = true; } catch (e) { /* not JSON */ } }
			return { fin, steer, tail: out.trim().split('\n').pop() };
		};
		if (GPU) {
			const a = run([]), b = run([`--steer=${path.join(tmp, 'k.steer')}`]);
			check('explore finds the key room\'s route without the steer field', !!a.fin, a.tail.slice(0, 160));
			check('... and with a garbage steer field (loaded; nothing pruned by it)', !!b.fin && b.steer, b.tail.slice(0, 160));
		} else console.log('  (the native explore: with --gpu)');
	}
	const goex = (extra) => {
		const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=3', '--maxTicks=3000000', '--mem=200', '--seconds=120', '--first=1', ...extra], { encoding: 'utf8' });
		const res = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((j) => j && j.ev === 'result');
		const start = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((j) => j && j.ev === 'start');
		return { route: res.length ? res[0] : null, start };
	};
	const g1 = goex(['--steer=build']), g2 = goex(['--steer=build']);
	check('goexplore --steer: a route in the key room (replayed)', !!g1.route && !!(g1.start && g1.start.steer), g1.route ? `${g1.route.ticks} ticks after ${g1.route.simTicks} simulated` : 'none');
	check('... one worker with a tick budget is reproducible', !!g1.route && !!g2.route && g1.route.inputs === g2.route.inputs && g1.route.simTicks === g2.route.simTicks);
}

/** D the switch chain (steer.js chainPlan / buildChain / chainFifths / nextSwitch, the CPU file's section, flags 8; switchAim, the wall breaker's gate): a
 *  corridor, the spawn in the middle, purple switch 1 at the far left, door 1 (184, a whole column) right of the spawn,
 *  switch 2 behind it, door 2, the trophy: the walk reaches switch 1 with nothing on, switch 2 with 1 on, the trophy with
 *  both: waves [1] [2]. With one layer (maxLayers 1: no switch modelled) the layer field walks through both doors (the
 *  false near); the chain counts the detour to switch 1, falls when it is pressed, rises when it is pressed again (off);
 *  the plain (GPU) file is the build without the chain byte for byte; goexplore.js on the CPU file routes the level */
function sectionD() {
	section('D the switch chain (a monotone counter over purple switch waves; the CPU file only)');
	const W = 60, H = 8, y = H - 2, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let yy = 1; yy < H - 1; yy++) cells.push([0, yy, 9], [W - 1, yy, 9], [25, yy, 184, 1], [40, yy, 184, 2]);
	cells.push([15, y, 255], [1, y, 113, 1], [33, y, 113, 2], [52, y, 121]);
	const buf = ED.eelvlOf({ name: 'chain', width: W, height: H, cells });
	const L = levelOf(buf);
	const A = SF.analyze(L, {});
	const CP = SF.chainPlan(A);
	check('the waves: switch 1 with nothing on, switch 2 with 1 on, the trophy with both (K 2)', !CP.none && CP.K === 2 && JSON.stringify(CP.need) === '[[1],[2]]', JSON.stringify(CP.none || CP.need));
	// (with the budget the layers model switch 1, whose detour their plan meets; switch 2 lies on the way: its door open in
	// every layer, as the chain's wave 2 has it: the chain raises no value at the start)
	const full = SF.buildSteer(L), fs0 = new E.EESim(L); fs0.reset();
	const fc = SF.readSteerFile(SF.steerFileBytes(full, null, true)), fp = SF.readSteerFile(SF.steerFileBytes(full, null));
	check('with the budget the layers model switch 1 (its detour): the chain changes no value at the start', full.info.features.includes('psw:1') && SF.steerFifths(fc, fs0) === SF.steerFifths(fp, fs0), `${full.info.features} ${SF.steerFifths(fc, fs0)} vs ${SF.steerFifths(fp, fs0)}`);
	const st = SF.buildSteer(L, { maxLayers: 1 }), st0 = SF.buildSteer(L, { maxLayers: 1, noChain: true });
	check('one layer (no switch modelled): the chain over 2 ids in 2 waves', !!st.chain && st.chain.n === 2 && st.info.chain.waves === 2 && st.info.chain.unmodelled === 2, JSON.stringify(st.info.chain));
	const plain = SF.steerFileBytes(st, null), plain0 = SF.steerFileBytes(st0, null), cpu = SF.steerFileBytes(st, null, true);
	check('the plain (GPU) file = the build without the chain, byte for byte (no flags 8)', Buffer.compare(plain, plain0) === 0 && (plain.readInt32LE(28) & 8) === 0);
	const rc = SF.readSteerFile(cpu), rp = SF.readSteerFile(plain);
	check('the CPU file: flags 8 (not 4: the free coin DP dp.max), the chain section read back', (cpu.readInt32LE(28) & 8) !== 0 && (cpu.readInt32LE(28) & 4) === 0 && !!rc.chain && rc.chain.n === 2 && !rp.chain && !(rc.dp && rc.dp.max));
	const prev = process.env.EEAT_CHAIN;
	process.env.EEAT_CHAIN = '0';
	const off = SF.buildSteer(L, { maxLayers: 1 });
	if (prev === undefined) delete process.env.EEAT_CHAIN; else process.env.EEAT_CHAIN = prev;
	check('EEAT_CHAIN=0: no chain', !off.chain && off.info.chain === null);
	// the route: left onto switch 1, right through both doors (switch 2 on the way) to the trophy
	const ms = [...new Array(80).fill(2), ...new Array(700).fill(4)];
	const ev = C.evaluate(L, Uint8Array.from(ms));
	check('left to switch 1, then right finishes in the engine (0 deaths)', !!ev && ev.deaths === 0, ev ? `${ev.runTicks} run ticks` : 'no finish');
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const c0 = SF.steerFifths(rc, sim), p0 = SF.steerFifths(rp, sim), n0 = SF.nextSwitch(rc, sim);
	check('at the start the chain counts the detour to switch 1 (CPU file above the layer field\'s false near by 20+ tiles); its next switch is 1', c0 > p0 + 100 && n0 && n0.id === 1, `${c0 / 5} vs ${p0 / 5} tiles; next ${n0 && n0.id}`);
	let lower = 0, states = 0, on1 = -1, v1b = -1, v1a = -1, n1 = null, prevV = c0, rises = 0;
	for (let t = 0; t < ms.length && !sim.has_silver_crown; t++) {
		const was = sim._switches.get(1) === true;
		const vb = SF.steerFifths(rc, sim);
		E.applyMask(inp, ms[t]); sim.tick(inp);
		if (sim.has_silver_crown || sim.is_dead) break;
		const vc = SF.steerFifths(rc, sim), vp = SF.steerFifths(rp, sim);
		states++;
		if (vp >= 0 && vc >= 0 && vc < vp) lower++;
		if (!was && sim._switches.get(1) === true && on1 < 0) { on1 = t; v1b = vb; v1a = vc; n1 = SF.nextSwitch(rc, sim); }
		if (on1 >= 0 && t > on1 + 20 && vc > prevV + 10) rises++;
		prevV = vc;
	}
	check('along the route the chain never lowers the value (the larger of the two relaxations)', states > 100 && lower === 0, `${lower} of ${states}`);
	check('switch 1 pressed: the value does not jump up (the tour goes on from it) and the next switch is 2', on1 >= 0 && v1a <= v1b + 10 && n1 && n1.id === 2, `tick ${on1}: ${v1b / 5} -> ${v1a / 5} tiles; next ${n1 && n1.id}`);
	check('after switch 1 the value falls on the way right (no rise of 2+ tiles)', on1 >= 0 && rises === 0, `${rises} rises`);
	// pressed again (off): the value rises back to the tour through switch 1
	const s2 = new E.EESim(L); s2.reset();
	for (let t = 0; t <= 80 + 100; t++) { E.applyMask(inp, ms[t]); s2.tick(inp); }
	const von = SF.steerFifths(rc, s2);
	s2._switches.set(1, false);
	const voff = SF.steerFifths(rc, s2);
	check('switch 1 off again (a toggle, or its 1619 reset) behind its shut door: no value (ranked behind every valued state; the layer field would say near)', voff === -1 && von >= 0, `${von / 5} tiles -> ${voff}`);
	const s3 = new E.EESim(L); s3.reset();
	for (let t = 0; t <= 80 + 30; t++) { E.applyMask(inp, ms[t]); s3.tick(inp); }
	const w1 = SF.steerFifths(rc, s3);
	s3._switches.set(1, false);
	const w0 = SF.steerFifths(rc, s3);
	check('switch 1 off again before its door: the value rises by the way back to it', w0 > w1 + 20, `${w1 / 5} -> ${w0 / 5} tiles`);
	// the wall breaker's gate (editor.js switchGate): the next OFF switch's walk with the ball's own switches (switchAim)
	const s0 = new E.EESim(L); s0.reset();
	const t0 = (Math.trunc(s0.py + 8) >> 4) * W + (Math.trunc(s0.px + 8) >> 4);
	const a1 = SF.switchAim(A, new Set(), 1, t0), a2off = SF.switchAim(A, new Set(), 2, t0), a2on = SF.switchAim(A, new Set([1]), 2, t0);
	const sw = (id) => { const r = []; for (let t = 0; t < W * H; t++) if (L.fg[t] === 113 && L.lookup0[t] === id) r.push(t); return r; };
	check('switchAim: switch 1 from the start, its tile the goal (0), the start 14+ tiles out (5 fifths a step)', !!a1 && sw(1).every((t) => a1.walk[t] === 0) && a1.start >= 70 && a1.start < 0xffff, a1 && `${a1.start} fifths, ${a1.tiles.length} tile`);
	check('switchAim: switch 2 behind door 1 with nothing on: no walk from the start (CUT); with 1 on: a walk (the ball\'s own switches, not the leg\'s waves)', !!a2off && a2off.start === 0xffff && !!a2on && a2on.start < 0xffff && sw(2).every((t) => a2on.walk[t] === 0), `${a2off && a2off.start} / ${a2on && a2on.start}`);
	check('switchAim: an id with no switch tile: null', SF.switchAim(A, new Set(), 77, t0) === null);
	// the escape's and the breaker's starts by the chain's progress (editor.js chainWavesParse / purpleOnOf / chainProgW)
	const WV = ED.chainWavesParse('1,2,3,4,5,101 | 6,7,8,9,10,41,202 | 36,37');
	const pr = (d) => ED.chainProgW(WV, ED.purpleOnOf(d));
	check('chain progress: the waves parsed from the build\'s ids', JSON.stringify(WV) === '[[1,2,3,4,5,101],[6,7,8,9,10,41,202],[36,37]]');
	check('chain progress: waves complete x 1000 + the ids ON of the first unfinished wave (a later wave\'s id before it counts nothing)',
		pr('(start)') === 0 && pr('coins=1 purple=[1,2,3,41,101]') === 4 && pr('purple=[1,2,3,4,5,101]') === 1000 && pr('purple=[1,2,3,4,5,101,6,8,202] key:red') === 1003 && pr('purple=[2,3,4,5,101,6,7,8,9,10,41,202]') === 5,
		[pr('(start)'), pr('coins=1 purple=[1,2,3,41,101]'), pr('purple=[1,2,3,4,5,101]'), pr('purple=[1,2,3,4,5,101,6,8,202] key:red'), pr('purple=[2,3,4,5,101,6,7,8,9,10,41,202]')].join(' '));
	// the CPU search on the CPU file routes the level (1 worker, a tick budget)
	const lf = path.join(tmp, 'chain.eelvl'), sf = path.join(tmp, 'chain_cpu.bin');
	fs.writeFileSync(lf, buf); fs.writeFileSync(sf, cpu);
	const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--workers=1', '--seed=3', '--maxTicks=3000000', '--mem=200', '--seconds=60', '--first=1', `--steer=${sf}`], { encoding: 'utf8' });
	const res = out.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((j) => j && j.ev === 'result');
	check('goexplore --steer=<the CPU file with the chain>: a route (replayed)', !!res, res ? `${res.ticks} ticks after ${res.simTicks} simulated` : 'none');
}

if (want('A')) sectionA();
if (want('B')) sectionB();
if (want('C')) sectionC();
if (want('D')) sectionD();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
