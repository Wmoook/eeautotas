'use strict';
// test/swsig.js - SWITCH SETS (goexplore.js --swsig=1, the default; EEAT_SWSIG=0 / --swsig=0: off): a room whose walk
// from its entry repeats an earlier live room's of its base (roomOf base: the key without the switches) is a REPEAT,
// demoted (its novelty group draws with the dominated ones, no source; the GPU bursts give it the dominated rooms' turn),
// never pruned. Night 3 cycle 6: purple switch sets made 169-334 rooms on the switch-puzzle levels (Soul Quest 273 of 275).
//   base       roomOf base: a switch on changes the key, not the base; a coin does
//   walk       roomFields enter's signature: switch 1 opens a door in a sealed pocket (the walk from the corridor the
//              same: the same signature), switch 2 the door before the trophy (another signature)
//   groups     domIndex repeat: a repeat group leaves the list for dlist and comes back; a dominated one stays dominated
//   search     goexplore.js on the two-switch corridor: routes with --swsig=1 and 0 (replayed), repeats counted only with
//              it; a level without switches: the same search either way (1 worker, a tick budget)
// usage: node test/swsig.js      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-swsig-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
// # wall, . air, S spawn, T trophy, 1 / 2 purple switches, e / f purple doors 1 / 2, g a purple gate 1, o gold coin, d coin door (1)
const ID = { '#': [9], S: [255], T: [121], o: [100], d: [43, 1], 1: [113, 1], 2: [113, 2], e: [184, 1], f: [184, 2], g: [185, 1] };
function levelOf(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
function gox(file, args, timeoutMs = 120000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
/** a sim put at tile (x, y) and ticked once without input (it touches what is there) */
function touch(sim, x, y) {
	sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0;
	sim.tick(new E.EEInput());
}
// the two-switch corridor: switch 1 opens door e (and shuts gate g: no mono switch, so its rooms dominate none) in a sealed
// pocket below (nothing the corridor's walk reaches), switch 2
// opens door f before the trophy
const TWO = [
	'####################',
	'#S..1....2......f.T#',
	'####################',
	'#.......e....g.....#',
	'####################',
];

function sectionBase() {
	section('base: roomOf base = the key without the switches');
	const L = levelOf('two', TWO).level;
	const RM = GX.roomOf(L);
	const sim = new E.EESim(L); sim.reset();
	const k0 = RM.key(sim), b0 = RM.base(sim);
	touch(sim, 4, 1);
	const k1 = RM.key(sim), b1 = RM.base(sim);
	check('switch 1 on: another key, the same base', k1 !== k0 && b1 === b0, `${k0} ${k1} / ${b0} ${b1}`);
	touch(sim, 9, 1);
	check('switches 1 and 2 on: the same base', RM.base(sim) === b0 && RM.key(sim) !== k1);
	const C = levelOf('coin', ['########', '#S.o.dT#', '########']).level, RC = GX.roomOf(C);
	const sc = new E.EESim(C); sc.reset();
	const bc0 = RC.base(sc);
	touch(sc, 3, 1);
	check('a coin a door reads: another base', RC.base(sc) !== bc0);
}

function sectionWalk() {
	section('walk: roomFields enter\'s territory signature');
	const L = levelOf('two', TWO).level;
	const F = GX.roomFields(L, 1 << 20, { useful: true });
	const sim = new E.EESim(L); sim.reset();
	sim.px = 2 * 16; sim.py = 16;
	const f0 = F.enter(sim);
	touch(sim, 4, 1); sim.px = 5 * 16; sim.py = 16; sim.speed_x = 0;
	const f1 = F.enter(sim);
	check('switch 1 on (its door in a sealed pocket): the same walk signature, no gain', f1.sig === f0.sig && f1.graw === 0 && !f1.cached, `${f0.sig} / ${f1.sig}, graw ${f1.graw}`);
	touch(sim, 9, 1); sim.px = 10 * 16; sim.py = 16; sim.speed_x = 0;
	const f2 = F.enter(sim);
	check('switch 2 on too (the trophy\'s door): another signature, gain', f2.sig !== f0.sig && f2.graw > 0, `${f2.sig}, graw ${f2.graw}`);
	const f3 = F.enter(sim);
	check('the same passable set again (a cached walk): its signature', f3.cached && f3.sig === f2.sig);
}

function sectionGroups() {
	section('groups: domIndex repeat');
	const D = GX.domIndex();
	const g1 = D.groupOf({ cls: 1, mask: Int32Array.of(0) }), g2 = D.groupOf({ cls: 2, mask: Int32Array.of(0) });
	check('two classes: both in the list', D.list.includes(g1) && D.list.includes(g2) && D.dlist.length === 0);
	D.repeat(g2, true);
	check('a repeat group: out of the list, in dlist, not dominated', !D.list.includes(g2) && D.dlist.includes(g2) && !g2.dom && D.stats().repeats === 1);
	D.repeat(g2, false);
	check('no longer a repeat: back in the list', D.list.includes(g2) && !D.dlist.includes(g2) && D.stats().repeats === 0);
	// (a repeat group a later superset dominates: dominated, in dlist once)
	const h = D.groupOf({ cls: 3, mask: Int32Array.of(1) });
	D.repeat(h, true);
	D.groupOf({ cls: 3, mask: Int32Array.of(3) });
	check('a repeat group dominated later: dominated, once in dlist, no longer a repeat', h.dom && !h.rep && D.dlist.filter((x) => x === h).length === 1 && D.stats().repeats === 0);
	D.repeat(h, false);
	check('a dominated group is no repeat to lift: it stays dominated', h.dom && !D.list.includes(h));
	// the dlist indices stay right after swap-removes
	const gs = [];
	for (let k = 0; k < 6; k++) { const g = D.groupOf({ cls: 10 + k, mask: Int32Array.of(0) }); D.repeat(g, true); gs.push(g); }
	D.repeat(gs[1], false); D.repeat(gs[4], false);
	check('dlist\'s indices after removals', D.dlist.every((g, i) => g.di === i) && D.list.every((g, i) => g.li === i));
}

function sectionSearch() {
	section('search: goexplore.js with --swsig=1 and 0');
	const { file } = levelOf('two', TWO);
	const out = {};
	for (const sw of [1, 0]) {
		const ev = gox(file, ['--cells=coarse', '--workers=1', '--seconds=20', '--first=1', `--swsig=${sw}`, '--seed=3']);
		const res = ev.filter((e) => e.ev === 'result'), done = ev.find((e) => e.ev === 'done') || {};
		const w = (done.workers || [])[0] || {};
		out[sw] = w;
		check(`--swsig=${sw}: a route, replayed`, res.length > 0, `${res.length ? res[0].ticks : '-'} ticks; rooms ${w.rooms}, repeats made ${w.repRooms}, repeat groups ${w.repeats}`);
	}
	check('--swsig=1: switch 1\'s rooms are repeats (made and counted)', (out[1].repRooms || 0) >= 1, `repRooms ${out[1].repRooms}`);
	check('--swsig=0: no repeat', (out[0].repRooms || 0) === 0);
	// a level without switches: no repeat can be, and no draw changes: the same search (one worker, a tick budget)
	const mid = '#S..........o...........o.........o..........d............T#';
	const { file: coin } = levelOf('coinlong', ['#'.repeat(mid.length), mid, '#'.repeat(mid.length)]);
	const sig = (ev) => { const d = ev.find((e) => e.ev === 'done') || {}; const w = (d.workers || [])[0] || {}; return JSON.stringify({ ticks: w.ticks, picks: w.picks, cells: w.cells, rooms: w.rooms, res: ev.filter((e) => e.ev === 'result').map((e) => e.ticks) }); };
	const a1 = gox(coin, ['--cells=coarse', '--workers=1', '--maxTicks=3000000', '--seed=5', '--swsig=1']);
	const a0 = gox(coin, ['--cells=coarse', '--workers=1', '--maxTicks=3000000', '--seed=5', '--swsig=0']);
	check('no switches: the same search with --swsig=1 and 0', sig(a1) === sig(a0), `${sig(a1)} / ${sig(a0)}`);
}

sectionBase();
sectionWalk();
sectionGroups();
sectionSearch();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
