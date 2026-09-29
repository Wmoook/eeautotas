'use strict';
// The gate as floor (night 3, n3-gate-as-floor): src/steer.js gateFloors and buildSteer's coin count from it.
// A 40 x 20 level: the floor row 18, the spawn (2, 17), two gold coins on the floor, a 2-coin GATE (165: solid from 2
// coins on) at (30, 15) as a one-tile platform, the trophy (30, 10) in the air above it: a jump from the floor peaks at
// row 13, a jump from the gate reaches row 10, so the trophy is reached only from the gate with both coins held.
// - gateFloors finds the gate (count 2) by the engine; a level whose trophy a jump from the floor reaches finds none;
// - buildSteer models the coins, its coin plan's T is 2 (the walk plan passes no coin door: T 0 before), the lookup
//   takes the DP first (floorFirst, the file's flags 4, read back); EEAT_GATEFLOOR=0 / gateFloor false: main's file;
// - where no gate is a floor the file is byte for byte the same as with the change off;
// - goexplore.js --steer=build routes it (replayed), the same route for the same seed.
//   node test/gatefloor.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gatefloor-home-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SF = require('../src/steer.js');
const C = require('../src/common.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const prep = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
const W = 40, H = 20;
function build(trophyY, gate) {
	const c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, 18, 9], [x, 19, 9]);
	for (let y = 1; y < 18; y++) c.push([0, y, 9], [W - 1, y, 9]);
	if (gate) c.push([30, 15, 165, 2]);
	c.push([2, 17, 255], [8, 17, 100], [14, 17, 100], [30, trophyY, 121]);
	return ED.eelvlOf({ name: 'gatefloor', width: W, height: H, cells: c });
}
const buf = build(10, true);
const L = prep(buf);

console.log('\n== the engine test');
const A = SF.analyze(L, {});
const fl = SF.gateFloors(A, L);
check('the gate is a floor of count 2', fl.length === 1 && fl[0].c === 2 && fl[0].t === 15 * W + 30, JSON.stringify(fl));
const Lc = prep(build(13, true));   // (the trophy a jump from the floor reaches: the gate is no need)
check('a trophy the floor reaches: no floor', SF.gateFloors(SF.analyze(Lc, {}), Lc).length === 0);
const Ln = prep(build(10, false));   // (no gate)
check('no gate: no floor', SF.gateFloors(SF.analyze(Ln, {}), Ln).length === 0);

console.log('\n== the steer field');
const st = SF.buildSteer(L, { legThreads: 0 });
const i = st.info;
check('the coins modelled', i.features.includes('coins'), JSON.stringify(i.features));
check('the coin plan over 2 coins (T 2)', i.dp && i.dp.T === 2 && i.dp.n === 2, JSON.stringify(i.dp));
check('the floor in the info, DP first', i.floor && i.floor.T === 2 && i.floor.first === true && st.floorFirst === true, JSON.stringify(i.floor));
const off = SF.buildSteer(L, { legThreads: 0, gateFloor: false });
check('gateFloor false: no DP, no floor (main)', !off.info.dp && !off.info.floor && !off.floorFirst, JSON.stringify(off.info.dp));
process.env.EEAT_GATEFLOOR = '0';
const offEnv = SF.buildSteer(L, { legThreads: 0 });
delete process.env.EEAT_GATEFLOOR;
check('EEAT_GATEFLOOR=0: the same file as gateFloor false', SF.steerFileBytes(offEnv, null).equals(SF.steerFileBytes(off, null)));
const bytes = SF.steerFileBytes(st, null);
check('the file carries flags 4 (and 1: the DP)', (bytes.readInt32LE(4 + 4 * 6) & 5) === 5, bytes.readInt32LE(4 + 4 * 6));
const rd = SF.readSteerFile(bytes);
check('read back: floorFirst', rd.floorFirst === true && rd.dp && rd.dp.T === 2);
const sim = new E.EESim(L); sim.reset();
check('the start value: the file = the build', SF.steerFifths(rd, sim) === SF.steerFifths(st, sim), `${SF.steerFifths(rd, sim)} vs ${SF.steerFifths(st, sim)}`);
// (the ball under the trophy on the floor with no coin: the layer field's way is the jump from the floor it cannot make
// in the engine; the DP first prices the coins and the gate: more than the start's walk to the first coin alone)
const at = (x, y) => { const s = new E.EESim(L); s.reset(); s.px = x * 16; s.py = y * 16; s.speed_x = 0; s.speed_y = 0; return s; };
const under = SF.steerFifths(st, at(30, 17)), underOff = SF.steerFifths(off, at(30, 17));
check('under the trophy with no coin: the DP\'s value (main: none, the gate air)', under > 0 && under !== underOff, `${under} vs main ${underOff}`);

console.log('\n== no floor: byte for byte main');
for (const [name, lv] of [['the trophy the floor reaches', Lc], ['no gate', Ln]]) {
	const a = SF.buildSteer(lv, { legThreads: 0 }), b = SF.buildSteer(lv, { legThreads: 0, gateFloor: false });
	check(`${name}: the same file`, SF.steerFileBytes(a, null).equals(SF.steerFileBytes(b, null)) && !a.info.floor);
}

console.log('\n== the CPU search');
const lvFile = path.join(HOME, 'gatefloor.eelvl');
fs.writeFileSync(lvFile, buf);
const gx = (extra, env) => {
	const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lvFile, '--workers=1', '--seed=1', '--maxTicks=30000000', '--mem=300', '--steer=build', '--first=1', ...extra],
		{ encoding: 'utf8', env: Object.assign({}, process.env, env || {}), timeout: 180000 });
	const ev = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
	const res = ev.find((e) => e.ev === 'result'), done = ev.find((e) => e.ev === 'done');
	return { res, done };
};
const r1 = gx([]), r2 = gx([]);
const ms = (r) => (r.res && r.res.inputs ? Array.from(r.res.inputs, (ch) => ch.charCodeAt(0) - 48) : null);
const m1 = ms(r1);
const ev1 = m1 ? C.evaluate(L, m1) : null;
check('goexplore --steer=build routes it (replayed: the trophy with 2 coins)', !!ev1 && ev1.coins === 2, ev1 ? `${ev1.runTicks} ticks, ${ev1.coins} coins` : 'no route');
check('the same route for the same seed', !!m1 && JSON.stringify(m1) === JSON.stringify(ms(r2)));
const rOff = gx([], { EEAT_GATEFLOOR: '0' });
console.log(`  (simulated ticks to the first route: ${r1.res ? r1.res.simTicks : '?'} with the gate as floor, ${rOff.res ? rOff.res.simTicks : '?'} without${rOff.res ? '' : ' (no route)'})`);

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
