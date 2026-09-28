'use strict';
// test/useful.js - the useful territory of goexplore.js (2026-09-28; the user on Forgotten Helix: "it keeps going into
// the viewing rooms still ... the viewing room leads to nowhere!!!"; see goexplore.js USEFUL TERRITORY):
//   units    roomUseful / roomFields on a hub level: two viewing boxes, one entered by a portal pair from the hub (a
//            purple switch door, whose switch the level lacks, between it and the trophy: the door-blind reach field
//            puts it next to the trophy), one behind a 1-coin door at the end of a chute whose portal leads back to the
//            spawn; the targets (the coin, the trophy), the cul-de-sacs and the band at the start and after the coin, the
//            coin's room: raw territory gain > 0, gain 0 (all off the band); the live state restored exactly
//   cpu      src/goexplore.js on it, the default vs --useful=0 (1 worker, seed 1, the same tick budget): both find a
//            route (replayed); the picks in the portal box (--pickBox) a tenth or less of --useful=0's and under 1% of
//            all; no nearest attempt ends in it; the coin's room's gain zeroed; the same seed and budget give the same
//            routes; a level without viewing rooms (the pit of test/deaths.js is not needed: the plain corridor) searches
//            as before (the same routes after the same ticks)
// usage: node test/useful.js      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-useful-'));
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
function gox(file, args, timeoutMs = 180000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);

// The hub level (60 x 22): the spawn S and the coin o in the hub (rows 11-12); the trophy T at the top left, reached the
// long way: the hub to the right, up the shaft's ledges (x 53-58), the top corridor to the left. V2 (x 1-4, rows 4-5)
// under the trophy's floor behind a purple switch door D2 (2, 3) that never opens (no switch in the level; a coin door
// above the level's coins would be a wall to the reach field: reach.js neverOpenDoors): entered only by the portal Q1 in
// the hub's ceiling (10, 10), left by its portal Q2 (3, 5) back to Q1 (Forgotten Helix's door-16 box: a portal pair from
// the hub, a door the room cannot open, next to the trophy by the door-blind reach field). V1 (x 27-31, rows 18-20) at the end of a
// chute (29, 13-16) under the hub behind a 1-coin door D1 (29, 17), its portal P (28, 20) sending the ball back to P'
// by the spawn (3, 10), P' leading nowhere (the viewing room a coin opens, whose portal leads back to the hub).
const LW = 60, LH = 22;
const V2 = [1, 4, 4, 5], V1 = [27, 18, 31, 20];
function hubLevel(file) {
	const g = Array.from({ length: LH }, () => Array(LW).fill(9));
	const air = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = 0; };
	air(1, 1, 58, 2); air(V2[0], V2[1], V2[2], V2[3]); air(1, 11, 58, 12); air(53, 3, 58, 10); air(29, 13, 29, 16); air(V1[0], V1[1], V1[2], V1[3]);
	for (const [x0, x1, y] of [[56, 58, 10], [53, 55, 7], [56, 58, 4]]) for (let x = x0; x <= x1; x++) g[y][x] = 9;
	const extra = new Map();
	const put = (x, y, ...args) => { g[y][x] = -1; extra.set(`${x},${y}`, [x, y, ...args]); };
	put(1, 2, 121); put(2, 3, 184, 0); put(3, 5, 242, 0, 2, 1); put(10, 10, 242, 0, 1, 2);
	put(29, 17, 43, 1); put(28, 20, 242, 0, 3, 4); put(3, 10, 242, 0, 4, 5); put(20, 12, 100); put(6, 12, 255);
	const cells = [];
	for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) if (g[y][x] === 9) cells.push([x, y, 9]);
	cells.push(...extra.values());
	fs.writeFileSync(file, ED.eelvlOf({ name: 'viewing rooms', width: LW, height: LH, cells }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}
const inBox = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const boxTiles = (b) => { const out = []; for (let y = b[1]; y <= b[3]; y++) for (let x = b[0]; x <= b[2]; x++) out.push(y * LW + x); return out; };

function sectionUnits(L) {
	section('units: the targets, the cul-de-sacs, the band, the gain');
	const U = GX.roomUseful(L), F = GX.roomFields(L, 16 << 20), F0 = GX.roomFields(L, 16 << 20, { useful: false });
	const sim = new E.EESim(L);
	sim.reset();
	const key0 = sim.stateHash();
	const r0 = U.of(sim, true);
	check('the live state is restored exactly after the targets\' tests', sim.stateHash() === key0 && sim.coins === 0);
	check('at the start: 2 targets (the coin, the trophy)', r0.targets === 2, `${r0.targets}`);
	const all = (b, bits) => boxTiles(b).every((t) => GX.bitAt(bits, t));
	check('the portal box by the trophy (V2): a cul-de-sac (a detour of a few steps from the hub: within the band\'s slack); the chute box (V1, D1 shut): not walked',
		all(V2, r0.cul) && !boxTiles(V1).some((t) => GX.bitAt(r0.cul, t) || GX.bitAt(r0.off, t)),
		`V2 cul ${boxTiles(V2).filter((t) => GX.bitAt(r0.cul, t)).length} / 8, off ${boxTiles(V2).filter((t) => GX.bitAt(r0.off, t)).length}; V1 bits ${boxTiles(V1).filter((t) => GX.bitAt(r0.cul, t) || GX.bitAt(r0.off, t)).length}`);
	const rx = U.of(sim, false, [5 * LW + 1]);
	check('a room entered again inside the portal box (an extra terminal): the box is no cul-de-sac then', !boxTiles(V2).some((t) => GX.bitAt(rx.cul, t)) && sim.stateHash() === key0);
	const way = [[6, 12], [20, 12], [40, 12], [55, 11], [57, 9], [54, 6], [57, 3], [30, 2], [3, 2]];
	check('the way (the hub, the shaft, the top corridor): no cul-de-sac, on the band', way.every(([x, y]) => !GX.bitAt(r0.cul, y * LW + x) && !GX.bitAt(r0.off, y * LW + x)),
		way.filter(([x, y]) => GX.bitAt(r0.cul, y * LW + x) || GX.bitAt(r0.off, y * LW + x)).map((p) => p.join(',')).join(' ') || 'all');
	// the start's room, then the coin's room (the ball on the coin's tile with the coin taken)
	const f0 = F.enter(sim), g0 = F0.enter(sim);
	check('the start\'s room: its gain as before (it opens the level)', f0.gain > 0 && f0.gain === g0.gain && f0.graw === g0.gain, `${f0.gain} / ${g0.gain}`);
	sim._setTileCoin(20, 12, 110); sim.coins = 1; sim.px = 20 * 16; sim.py = 12 * 16; sim.speed_x = 0; sim.speed_y = 0;
	const r1 = U.of(sim, true);
	check('after the coin: 1 target (the trophy); V1 (a loop now: D1 and its portal back) off the band, no cul-de-sac', r1.targets === 1 && all(V1, r1.off) && !boxTiles(V1).some((t) => GX.bitAt(r1.cul, t)),
		`targets ${r1.targets}`);
	const f1 = F.enter(sim), g1 = F0.enter(sim);
	check('the coin\'s room: raw gain (V1 and its door) > 0, gain 0 (all off the band); without the useful territory the raw gain', f1.graw >= 16 && f1.gain === 0 && g1.gain === f1.graw,
		`graw ${f1.graw}, gain ${f1.gain}, off ${g1.gain}`);
	const f2 = F.enter(sim), n2 = F.stats().culSets;
	check('a room keeps its cul-de-sacs (one bitset per content: the same room again shares it) and gives them back', !!f1.cul && f2.cul === f1.cul && (() => { F.release(f1.cul); const one = F.stats().culSets === n2; F.release(f2.cul); return one && F.stats().culSets === n2 - 1; })(), `sets ${n2} -> ${F.stats().culSets}`);
}

function sectionCpu(file, L) {
	section('cpu: goexplore.js with the useful territory vs --useful=0');
	const box = `--pickBox=${V2.join(',')}`, base = ['--workers=1', '--cells=coarse', '--maxTicks=12000000', '--seconds=120', box];
	const on = gox(file, base), off = gox(file, [...base, '--useful=0']);
	const rOn = routesOf(on), rOff = routesOf(off), dOn = doneOf(on), dOff = doneOf(off);
	const evOn = rOn.length ? C.evaluate(L, masksOf(rOn[rOn.length - 1].inputs)) : null;
	check('the default finds a route (replayed in the engine)', !!evOn && evOn.ms.length === rOn[rOn.length - 1].ticks,
		rOn.length ? `${rOn.length} routes, best ${rOn[rOn.length - 1].ticks} ticks, first after ${dOn.first ? dOn.first.simTicks : '-'} ticks` : 'none');
	check('--useful=0 finds one too', rOff.length > 0, rOff.length ? `best ${rOff[rOff.length - 1].ticks} ticks, first after ${dOff.first ? dOff.first.simTicks : '-'} ticks` : 'none');
	const pOn = dOn.pickBox ? dOn.pickBox.picks : -1, pOff = dOff.pickBox ? dOff.pickBox.picks : -1;
	check('--useful=0 keeps going into the portal box (the check means something)', pOff >= 500, `${pOff} of ${dOff.picks} picks`);
	check('the default: a tenth of those picks or less, under 1% of all', pOn >= 0 && pOn * 10 <= pOff && pOn < 0.01 * dOn.picks, `${pOn} of ${dOn.picks} picks (--useful=0: ${pOff} of ${dOff.picks})`);
	const near = on.filter((e) => e.ev === 'closest');
	const inV = near.filter((e) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (const m of masksOf(e.inputs)) { E.applyMask(inp, m); sim.tick(inp); }
		return inBox(V2, Math.trunc(sim.px + 8) >> 4, Math.trunc(sim.py + 8) >> 4);
	}).length;
	check('the default: no nearest attempt ends in the portal box', near.length > 0 && inV === 0, `${inV} of ${near.length}`);
	check('the default: the coin\'s room\'s gain zeroed, the counts in the done event', !!dOn.useful && dOn.useful.zeroed >= 1 && dOn.useful.culCells >= 1, JSON.stringify(dOn.useful));
	const on2 = gox(file, base);
	check('the same seed and tick budget: the same routes', JSON.stringify(routesOf(on2).map((e) => [e.ticks, e.inputs])) === JSON.stringify(rOn.map((e) => [e.ticks, e.inputs])));
}

function sectionPlain() {
	section('a level without viewing rooms: the same search (the useful territory only reorders)');
	// a corridor with a ledge (no door, no portal, no dead end): every tile on the way, no cul-de-sac, the gain as before
	const rows = ['##############################', '#............................#', '#............................#', '#..............####..........#',
		`#S${'.'.repeat(26)}T#`, '##############################'];
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') cells.push([x, y, 9]); else if (ch === 'S') cells.push([x, y, 255]); else if (ch === 'T') cells.push([x, y, 121]); }));
	const file = path.join(HOME, 'plain.eelvl');
	fs.writeFileSync(file, ED.eelvlOf({ name: 'plain', width: rows[0].length, height: rows.length, cells }));
	const a = gox(file, ['--workers=1', '--cells=coarse', '--maxTicks=2000000', '--seconds=60']), b = gox(file, ['--workers=1', '--cells=coarse', '--maxTicks=2000000', '--seconds=60', '--useful=0']);
	const same = JSON.stringify(routesOf(a).map((e) => [e.ticks, e.simTicks, e.inputs])) === JSON.stringify(routesOf(b).map((e) => [e.ticks, e.simTicks, e.inputs]));
	check('the same routes after the same simulated ticks as --useful=0', same && routesOf(a).length > 0, `${routesOf(a).length} routes; cul-de-sac cells ${doneOf(a).useful ? doneOf(a).useful.culCells : '-'}`);
}

const file = path.join(HOME, 'hub.eelvl');
const L = hubLevel(file);
sectionUnits(L);
sectionCpu(file, L);
sectionPlain();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
