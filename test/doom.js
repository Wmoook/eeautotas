'use strict';
// test/doom.js - DOOMED COUNTS (goexplore.js doomOf, n3 doomed-count-demote 2026-09-29): coins and blue coins only go
// up in a run, so a coin gate at or below the count held is shut for good and a coin door opens only if the coins held +
// the coins still reachable reach it; a state whose coin closure (a relaxation of the engine) reaches no trophy is
// DOOMED, and the CPU search demotes it (never drops it):
//   gate     a corridor with a gate of 1 before the trophy and a coin in a pocket above the spawn: the start and a ball
//            past the gate with the coin are not doomed, the spawn side with the coin is; a checkpoint past the gate
//            (with a spike: deaths move the ball) makes the spawn side's respawn a way: not doomed
//   door     a 5-coin door, 4 coins in the open and the 5th behind a gate of 4: the 4 open coins first = doomed (4 held +
//            0 reachable), the pocket coin first and 3 open = not; the same with blue coins, blue doors and gates
//   cache    a tile inside a doomed flood is answered from the cache; allow false: a miss is "not doomed"; no analyzer
//            for a level without a coin door or gate, nor with EEAT_DOOM=0
//   routes   along each toy level's own finishing route no state is doomed
//   search   goexplore.js (1 worker, seed 1, coarse cells, a tick budget) on the gate level: a route with doom on
//            (replayed; doomed rooms, cells and head B redraws counted) and with --doom=0 (no "doom" in the done event);
//            the same seed twice = the same search with doom on
// usage: node test/doom.js      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-doom-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
// # wall, S spawn, T trophy, C checkpoint, x spike, o gold coin, b blue coin, 1 gold gate 1, 4 gold gate 4, 5 gold door 5,
// 6 blue gate 4, 7 blue door 5
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1], o: [100], b: [101], 1: [165, 1], 4: [165, 4], 5: [43, 5], 6: [214, 4], 7: [213, 5] };
function levelOf(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
/** the ball put at tile (x, y) and ticked once without input (it touches what is there) */
function touch(sim, x, y) {
	sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0;
	sim.tick(new E.EEInput());
}
const at = (sim, x, y) => { sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0; return y * sim.level.width + x; };
function gox(file, args, env, timeoutMs = 120000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, env: Object.assign({}, process.env, env || {}) });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}

// the gate level: the coin in the pocket above the spawn, the gate of 1 between the spawn and the trophy (the floor row 3)
const GATE = [
	'################################################################',
	'#o.............................................................#',
	'#.##############################################################',
	'#S...1........................................................T#',
	'################################################################',
];
// the same with a checkpoint past the gate and a spike: a death takes the ball past the gate
const GATEC = GATE.map((r, y) => (y === 3 ? r.slice(0, 20) + 'C' + r.slice(21) : y === 1 ? r.slice(0, 40) + 'x' + r.slice(41) : r));
// the door level: 4 open coins, the 5th behind a gate of 4, a 5-coin door before the trophy
const DOOR = [
	'################################################################',
	'#S.o.o.o.o.................................................5..T#',
	'#.##############################################################',
	'#4..o###########################################################',
	'################################################################',
];
const BLUE = DOOR.map((r) => r.replace(/o/g, 'b').replace('5', '7').replace('4', '6'));

section('gate');
{
	const { level: L } = levelOf('doomgate', GATE);
	const D = GX.doomOf(L);
	check('an analyzer for a level with a coin gate', D !== null);
	const sim = new E.EESim(L); sim.reset();
	const s0 = sim.snapshot();
	check('the start is not doomed', D.test(sim, at(sim, 1, 3)) === false);
	touch(sim, 1, 1);
	check('the pocket coin taken', sim.coins === 1, `coins ${sim.coins}`);
	check('the coin held on the spawn side of the gate of 1: doomed', D.test(sim, at(sim, 1, 3)) === true);
	check('the same in the pocket: doomed', D.test(sim, at(sim, 10, 1)) === true);
	check('the coin held past the gate: not doomed', D.test(sim, at(sim, 8, 3)) === false);
	sim.restore(s0);
	check('0 coins in the pocket: not doomed', D.test(sim, at(sim, 10, 1)) === false);
	const LC = levelOf('doomgatec', GATEC).level, DC = GX.doomOf(LC);
	check('a spike: deaths are moves for the analyzer', DC.kills === true);
	const sc = new E.EESim(LC); sc.reset();
	touch(sc, 1, 1);
	check('with the coin and no checkpoint: doomed (the spawn is on its side)', DC.test(sc, at(sc, 1, 3)) === true);
	sc.checkpoint.x = 20; sc.checkpoint.y = 3;
	check('with the checkpoint past the gate touched: not doomed (a death respawns there)', DC.test(sc, at(sc, 1, 3)) === false);
}

section('door');
for (const [name, rows, blue] of [['doomdoor', DOOR, false], ['doomblue', BLUE, true]]) {
	const { level: L } = levelOf(name, rows);
	const D = GX.doomOf(L);
	const cnt = (s) => (blue ? s.blue_coins : s.coins);
	const sim = new E.EESim(L); sim.reset();
	const s0 = sim.snapshot();
	check(`${name}: the start is not doomed`, D.test(sim, at(sim, 1, 1)) === false);
	for (const x of [3, 5, 7, 9]) touch(sim, x, 1);
	check(`${name}: the 4 open coins taken`, cnt(sim) === 4, `count ${cnt(sim)}`);
	check(`${name}: 4 held + 0 reachable < 5 (the gate of 4 shut): doomed`, D.test(sim, at(sim, 11, 1)) === true);
	sim.restore(s0);
	touch(sim, 4, 3);
	for (const x of [3, 5, 7]) touch(sim, x, 1);
	check(`${name}: the pocket coin first, then 3 open`, cnt(sim) === 4, `count ${cnt(sim)}`);
	check(`${name}: 4 held + 1 reachable = 5: not doomed`, D.test(sim, at(sim, 11, 1)) === false);
	sim.restore(s0);
	for (const x of [3, 5, 7]) touch(sim, x, 1);
	check(`${name}: 3 held, the gate of 4 open: not doomed`, D.test(sim, at(sim, 11, 1)) === false);
}

section('cache');
{
	const { level: L } = levelOf('doomgate', GATE);
	const D = GX.doomOf(L);
	const sim = new E.EESim(L); sim.reset();
	touch(sim, 1, 1);
	D.test(sim, at(sim, 1, 3));
	const h0 = D.stats().hits, f0 = D.stats().floods;
	check('a tile inside a doomed flood: from the cache', D.test(sim, at(sim, 3, 3)) === true && D.stats().hits === h0 + 1 && D.stats().floods === f0);
	const f1 = D.stats().floods;
	check('allow false: a miss is not doomed, no flood', D.test(sim, at(sim, 8, 3), false) === false && D.stats().floods === f1 && D.stats().skipped >= 1);
	const plain = levelOf('doomplain', GATE.map((r) => r.replace('1', '.'))).level;
	check('no analyzer without a coin door or gate', GX.doomOf(plain) === null);
	const r = spawnSync(process.execPath, ['-e', `const E=require(${JSON.stringify(require.resolve('../src/eesim.js'))}),EL=require(${JSON.stringify(require.resolve('../src/eelvl.js'))}),GX=require(${JSON.stringify(require.resolve('../src/goexplore.js'))});const fs=require('fs');const L=E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(${JSON.stringify(path.join(HOME, 'doomgate.eelvl'))}))));console.log(GX.doomOf(L)===null?'null':'on')`], { encoding: 'utf8', env: Object.assign({}, process.env, { EEAT_DOOM: '0' }) });
	check('EEAT_DOOM=0: no analyzer', String(r.stdout).trim() === 'null', String(r.stdout).trim() || r.stderr);
}

section('search');
{
	const { file, level: L } = levelOf('doomgate', GATE);
	const args = ['--cells=coarse', '--workers=1', '--seed=1', '--seconds=60', '--maxTicks=4000000', '--first=1'];
	const on = gox(file, args), off = gox(file, [...args, '--doom=0']), on2 = gox(file, args);
	const rOn = on.filter((e) => e.ev === 'result'), rOff = off.filter((e) => e.ev === 'result');
	const dOn = on.find((e) => e.ev === 'done') || {}, dOff = off.find((e) => e.ev === 'done') || {}, dOn2 = on2.find((e) => e.ev === 'done') || {};
	check('doom on: a route', rOn.length > 0, `${rOn.length} routes, ${dOn.ticks} ticks`);
	const ev = rOn.length ? C.evaluate(L, Uint8Array.from(rOn[0].inputs, (ch) => (ch.charCodeAt(0) - 48) & 31)) : null;
	check('its route replays', ev !== null, ev ? `${ev.runTicks} run ticks` : 'none');
	check('doomed rooms and cells counted', dOn.doom && dOn.doom.on === 1 && dOn.doom.rooms >= 1 && dOn.doom.cells >= 1, JSON.stringify(dOn.doom));
	check('--doom=0: a route, no doom counts', rOff.length > 0 && dOff.doom === undefined, `${rOff.length} routes, ${dOff.ticks} ticks`);
	check('doom on: the same seed twice = the same search', dOn.ticks === dOn2.ticks && dOn.states === dOn2.states && JSON.stringify(dOn.doom) === JSON.stringify(dOn2.doom), `${dOn.ticks} / ${dOn2.ticks}`);
	console.log(`  (simulated ticks to the first route: doom ${dOn.ticks}, --doom=0 ${dOff.ticks})`);
}

section('routes');
{
	// the toy levels' own routes (found above or by a search here): no state along a finishing route is doomed
	for (const [name, rows] of [['doomgate', GATE], ['doomdoor', DOOR]]) {
		const { file, level: L } = levelOf(name, rows);
		const ev = gox(file, ['--cells=coarse', '--workers=1', '--seed=2', '--seconds=60', '--maxTicks=20000000', '--first=1']);
		const res = ev.filter((e) => e.ev === 'result');
		if (!res.length) { check(`${name}: a route to check`, false, 'no route'); continue; }
		const ms = Uint8Array.from(res[0].inputs, (ch) => (ch.charCodeAt(0) - 48) & 31);
		const D = GX.doomOf(L), sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let bad = 0, n = 0;
		for (let t = 0; t < ms.length; t++) {
			E.applyMask(inp, ms[t]); sim.tick(inp);
			if (sim.has_silver_crown || sim.is_dead) break;
			const tile = (Math.trunc(sim.py + 8) >> 4) * L.width + (Math.trunc(sim.px + 8) >> 4);
			n++;
			if (D.test(sim, tile)) bad++;
		}
		check(`${name}: no state of its route doomed`, bad === 0, `${n} states, ${bad} doomed`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
