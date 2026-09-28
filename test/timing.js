'use strict';
// test/timing.js - the Good Egg lane "timing and launchers" (2026-09-28, branch ge-r1-timing):
//   wait     goexplore.js's wait move (--wait, TAS playbook P13: arrive at the opening edge): waitNear / waitShut / waitLen,
//            and a level whose only way is a jump through a time door (156) over a ledge 1 tile wide between spikes: the
//            random runs almost never stand still for the ~500 ticks the door stays shut; with the wait move the route
//            comes at the opening edge in a few thousand simulated ticks, without it not within the same budget; a level
//            without time doors searches exactly as with --wait=0
//   deaths   the lineage's bar (--dline): an upper ledge with the checkpoint, a lower corridor the ball cannot climb back
//            from, a coin there, then a pit with spikes (no way out but a death): a death in the pit takes the ball back
//            to the checkpoint in the room of the coin (a place no live state of that room reached: the first-arrival test
//            keeps it) while its lineage was far nearer the trophy since the coin: with --dline=0 such deaths are kept,
//            with the bar they are dropped (dLine); the pit of test/deaths.js (the death is the way) still routes through
//            its death with the steer field and the bar; --cpkey=2 (the useful checkpoint in the cell key) routes it too
// usage: node test/timing.js      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-timing-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
// ASCII levels: # wall, . air, S spawn, T trophy, C checkpoint, x spike, o coin, d coin door (1 coin), D time door (156)
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1], o: [100], d: [43, 1], D: [156] };
function levelFile(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
function gox(file, args, timeoutMs = 180000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);

// the door ledge: the spawn on a pillar 1 tile wide between spikes, a time door (open in the doors' phase [500, 1000)) in
// the ceiling right above, the trophy behind it: the clock starts at 0, so the door is shut for the first 500 ticks
const DOOR = [
	'#######',
	'#..T..#',
	'###D###',
	'#.....#',
	'#..S..#',
	'#xx#xx#',
	'#######',
];
// the pit of test/deaths.js: the death is the way (the coin at the bottom of a shaft too tall to climb)
const PIT = [
	'################',
	'#...CS..d..T...#',
	'#..#############',
	'#..#############',
	'#..#############',
	'#..#############',
	'#..#############',
	'#..#############',
	'#..........o..x#',
	'################',
];
/** the lineage level: an upper ledge (spawn, checkpoint) over a lower corridor 5 rows down (no way back up), a coin
 *  there, a pit 6 deep with spikes, the 1-coin door, the trophy */
function lineageRows() {
	const W = 60, put = (r, x, s) => r.slice(0, x) + s + r.slice(x + s.length);
	const rows = ['#'.repeat(W)];
	for (let y = 1; y <= 3; y++) rows.push('#' + '.'.repeat(W - 2) + '#');
	rows[3] = put(rows[3], 1, 'SC');
	for (let y = 4; y <= 8; y++) rows.push(put('#' + '.'.repeat(W - 2) + '#', 1, '#'.repeat(10)));
	for (let y = 5; y <= 8; y++) rows[y] = put(rows[y], 50, 'd');
	rows[8] = put(put(rows[8], 54, 'T'), 20, 'o');
	for (let y = 9; y <= 14; y++) rows.push(put('#'.repeat(W), 40, '..'));
	rows[14] = put(rows[14], 40, 'xx');
	rows.push('#'.repeat(W));
	return rows;
}

function sectionWait() {
	section('wait: the wait move (--wait) arrives at the opening edge');
	// the helpers
	const lv = levelFile('door', DOOR);
	const near = GX.waitNear(lv.level, 4);
	const W = lv.level.width;
	check('waitNear: the tiles within 4 of the time door (156) get bit 1, none bit 2 (no time gate 157)', near[4 * W + 3] === 1 && near[1 * W + 3] === 1 && [...near].every((b) => (b & 2) === 0));
	check('waitShut: a door 156 is shut in the doors\' phase [0, 500), a gate 157 in [500, 1000)', GX.waitShut(1, 0) && GX.waitShut(1, 499) && !GX.waitShut(1, 500) && !GX.waitShut(2, 100) && GX.waitShut(2, 700) && GX.waitShut(3, 700));
	check('waitLen: to between --waitLead and 8 ticks after the next flip (phase 0 / 500)', GX.waitLen(100, 40, 0) === 408 && GX.waitLen(100, 40, 0.9999) === 360 && GX.waitLen(990, 40, 0) === 18 && GX.waitLen(499, 40, 0.9999) === 1);
	check('the door level: the clock starts at 0 and the level has time doors', !!lv.level.hasTimeDoors && (() => { const s = new E.EESim(lv.level); s.reset(); return s.level_ticks() === 0; })());
	const B = 60000, B0 = 1000000;
	const on = [], off = [];
	for (const seed of [1, 2, 3]) {
		on.push(gox(lv.file, ['--workers=1', '--cells=coarse', `--seed=${seed}`, `--maxTicks=${B}`, '--seconds=60', '--first=1']));
		off.push(gox(lv.file, ['--workers=1', '--cells=coarse', `--seed=${seed}`, `--maxTicks=${B0}`, '--seconds=120', '--first=1', '--wait=0']));
	}
	const firsts = on.map((ev) => doneOf(ev).first);
	const reps = on.map((ev) => { const r = routesOf(ev)[0]; return r ? C.evaluate(lv.level, masksOf(r.inputs)) : null; });
	check(`with the wait move: a route in 3 of 3 seeds within ${B} simulated ticks, through the door as it opens (at most 520 ticks), replayed`,
		firsts.every((f) => f && f.ticks <= 520) && reps.every((v) => v && v.ms.length <= 520 && v.deaths === 0),
		firsts.map((f) => (f ? `${f.ticks} ticks after ${f.simTicks}` : 'none')).join(', '));
	check('its wait runs are counted (the workers\' waitRuns)', on.every((ev) => ((doneOf(ev).workers || [])[0] || {}).waitRuns > 0));
	// (without it the runs keep an input with p 0.85: 500 ticks still on the ledge almost never; the first route's simulated
	// ticks, a budget of B0 counted as B0 when there is none)
	const offT = off.map((ev) => (doneOf(ev).first ? doneOf(ev).first.simTicks : B0)).sort((x, y) => x - y);
	const onT = firsts.map((f) => (f ? f.simTicks : B)).sort((x, y) => x - y);
	check('without it (--wait=0): the first route takes at least 5 times the simulated ticks (the medians of the 3 seeds)', offT[1] >= 5 * onT[1],
		`${offT.join(', ')} vs ${onT.join(', ')}`);
	// a level without time doors: the search is exactly the one without the move (the same routes after the same ticks)
	const pit = levelFile('pit_wait', PIT);
	const p0 = gox(pit.file, ['--workers=1', '--cells=coarse', '--maxTicks=3000000', '--seconds=60', '--wait=0']);
	const p1 = gox(pit.file, ['--workers=1', '--cells=coarse', '--maxTicks=3000000', '--seconds=60']);
	const key = (ev) => JSON.stringify(routesOf(ev).map((e) => [e.ticks, e.simTicks, e.inputs]));
	check('no time doors: --wait=0 and the default search alike (the same routes after the same ticks)', routesOf(p1).length > 0 && key(p0) === key(p1), `${routesOf(p1).length} routes`);
}

function sectionDeaths() {
	section('deaths: the lineage\'s bar (--dline) and the useful checkpoint (--cpkey=2)');
	const lin = levelFile('lineage', lineageRows());
	const sum = (runs, f) => runs.reduce((s, ev) => s + f(doneOf(ev).deaths || {}), 0);
	const on = [], off = [];
	for (const seed of [1, 2]) {
		on.push(gox(lin.file, ['--workers=1', '--cells=coarse', '--steer=build', `--seed=${seed}`, '--maxTicks=2000000', '--seconds=120', '--classW=0']));
		off.push(gox(lin.file, ['--workers=1', '--cells=coarse', '--steer=build', `--seed=${seed}`, '--maxTicks=2000000', '--seconds=120', '--classW=0', '--dline=0']));
	}
	const keptOn = sum(on, (d) => d.byNew + d.byCost), keptOff = sum(off, (d) => d.byNew + d.byCost), lineOn = sum(on, (d) => d.line || 0), lineOff = sum(off, (d) => d.line || 0);
	check('the lineage level: without the bar (--dline=0) deaths back to the checkpoint in the coin\'s room are kept; with it (the default) they are dropped by the bar (dLine) and none is kept',
		keptOff > 0 && keptOn === 0 && lineOn > 0 && lineOff === 0, `kept ${keptOn} vs ${keptOff} (--dline=0), dropped by the bar ${lineOn} vs ${lineOff}`);
	const okRoutes = [...on, ...off].every((ev) => { const r = routesOf(ev); if (!r.length) return false; const v = C.evaluate(lin.level, masksOf(r[r.length - 1].inputs)); return v && v.deaths === 0; });
	check('both find routes there, the best without a death, replayed', okRoutes);
	// the pit: the death is the way: kept with the steer field and the bar, and with the useful checkpoint in the key
	const pit = levelFile('pit_line', PIT);
	for (const extra of [[], ['--cpkey=2']]) {
		const ev = gox(pit.file, ['--workers=1', '--cells=coarse', '--steer=build', '--maxTicks=4000000', '--seconds=60', ...extra]);
		const rs = routesOf(ev), best = rs[rs.length - 1];
		const v = best ? C.evaluate(pit.level, masksOf(best.inputs)) : null;
		check(`the pit with the steer field${extra.length ? ` and ${extra.join(' ')}` : ''}: a route through its death (the bar keeps a death that is the way)`, !!v && v.deaths === 1,
			best ? `${rs.length} routes, the best ${best.ticks} ticks, ${v ? v.deaths : '?'} death(s), ${JSON.stringify(doneOf(ev).deaths)}` : 'none');
		if (extra.length) {
			const ev2 = gox(pit.file, ['--workers=1', '--cells=coarse', '--steer=build', '--maxTicks=4000000', '--seconds=60', ...extra]);
			check('--cpkey=2: the same seed and budget give the same routes', JSON.stringify(routesOf(ev2).map((e) => [e.ticks, e.inputs])) === JSON.stringify(rs.map((e) => [e.ticks, e.inputs])));
		}
	}
}

sectionWait();
sectionDeaths();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
