'use strict';
// test/rooms.js - the rooms' readers and their dominance (goexplore.js counterRelevance, switchReaders, roomOf, domIndex;
// playbook P3 / R3, 2026-09-28: Good Egg's hour from the level alone made 118,854 rooms, 118,758 of them with blue
// coins whose doors guard a pocket with a crown and no crown door, 117,164 of them switch subsets):
//   relevance  a blue-coin door that closes a pocket of nothing: the count is no room change below its threshold (the
//              doors' state is: the key counts the thresholds met); the same pocket with a checkpoint in it, or a door
//              that is a shortcut the walk can go around, keeps the count (Stupid Fox's coin door: its way around is the
//              level's other route); EEAT_ROOMREL=0 keeps every count; the legacy key (the GPU's) keeps every count
//   readers    a switch no door or gate reads is no room change; a read one is
//   dom        roomOf dom: the mono switches (doors, no gate) in the mask, a switch with a gate in the class; shrinks;
//              domIndex: a strict subset of a known mask is dominated at once, a later superset makes the smaller
//              dominated, equal = the same group (the time doors' two states), incomparable masks both maximal
//   search     goexplore.js on a switch corridor: the route with --dom=1 and --dom=0, dominated groups counted, no death
//              kept into a dominated room (the pit of test/deaths.js still routes through its death)
//   bursts     the GPU bursts' target test: a touch that only turns a mono switch off is no target (bursts.js infoOf via a
//              stand-in create); roomAim likewise
// usage: node test/rooms.js      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-rooms-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const BU = require('../src/bursts.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
// ASCII levels: # wall, . air, S spawn, T trophy, C checkpoint, x spike, o gold coin, b blue coin, D blue door (2),
// d coin door (1), 1 / 2 / 3 purple switches 1 / 2 / 3, e / f purple doors 1 / 2, g purple gate 3, 7 a purple switch no
// door reads, k crown
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1], o: [100], b: [101], D: [213, 2], G: [214, 2], d: [43, 1], 1: [113, 1], 2: [113, 2],
	3: [113, 3], e: [184, 1], f: [184, 2], g: [185, 3], 7: [113, 7], k: [5] };
function levelOf(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
/** a sim put at tile (x, y) and ticked once without input (it touches what is there) */
function touch(L, sim, x, y) {
	sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0;
	sim.tick(new E.EEInput());
}
function gox(file, args, timeoutMs = 120000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}

// a blue door (2 blue coins) under the corridor closing a pocket: nothing in it
const POCKET = [
	'############',
	'#S.b..b...T#',
	'#.##D#######',
	'#.##..######',
	'############',
];
const POCKET_CP = POCKET.map((r, y) => (y === 3 ? '#.##.C######' : r));
// the same pocket behind a blue GATE (2) and a third blue coin: the gate shuts at 2 (a solid block: a floor the walk
// cannot see), so the count is keyed up to it
const POCKET_GATE = POCKET.map((r, y) => (y === 1 ? '#S.b..b.b.T#' : y === 2 ? '#.##G#######' : r));
const POCKET_CROWN = POCKET.map((r, y) => (y === 3 ? '#.##.k######' : r));
// the blue door in the corridor, the trophy also reachable the long way round: a shortcut
const SHORT = [
	'##############################',
	'#S.b..b......D..............T#',
	'#.##########################.#',
	'#............................#',
	'##############################',
];

function sectionRelevance() {
	section('relevance: a counter whose doors close a pocket of nothing keys its thresholds, not its count');
	const A = levelOf('pocket', POCKET).level;
	const r = GX.counterRelevance(A);
	check('the pocket: blue irrelevant (a pocket of nothing), gold has no reader', r.blue === false && r.gold === true, JSON.stringify(r));
	const RM = GX.roomOf(A), LG = GX.roomOf(A, { legacy: true });
	const sim = new E.EESim(A); sim.reset();
	const k0 = RM.key(sim), l0 = LG.key(sim);
	touch(A, sim, 3, 1);
	const k1 = RM.key(sim), l1 = LG.key(sim), d1 = RM.desc(sim);
	check('one blue coin (below the door\'s 2): the same room; the legacy key changes', sim.blue_coins === 1 && k1 === k0 && l1 !== l0, `blue ${sim.blue_coins}, desc '${d1}'`);
	touch(A, sim, 6, 1);
	const k2 = RM.key(sim), d2 = RM.desc(sim);
	check('two (the door opens): another room, its description says so', sim.blue_coins === 2 && k2 !== k1 && /bluecoins>=2/.test(d2), `'${d2}'`);
	check('the door pocket: no gate, nothing keyed up to one (upTo 0)', r.upTo.blue === 0 && r.upTo.gold === 0, JSON.stringify(r.upTo));
	const G = levelOf('pocket_gate', POCKET_GATE).level, rg = GX.counterRelevance(G);
	check('the gate pocket: blue irrelevant, keyed up to its gate at 2', rg.blue === false && rg.upTo.blue === 2 && /gates at 2/.test(rg.why.blue), JSON.stringify(rg));
	const RG = GX.roomOf(G), sg = new E.EESim(G); sg.reset();
	// (a second tick: the gates' shown count follows the count a tick later, eesim.js _show_blue_coin_gate)
	const touchG = (x, y) => { touch(G, sg, x, y); sg.tick(new E.EEInput()); };
	const g0 = RG.key(sg);
	touchG(3, 1);
	const g1 = RG.key(sg), gd1 = RG.desc(sg);
	check('there one blue coin (toward the gate) is another room', sg.blue_coins === 1 && g1 !== g0 && /bluecoins=1/.test(gd1), `'${gd1}'`);
	touchG(6, 1);
	const g2 = RG.key(sg), gd2 = RG.desc(sg);
	check('two (the gate shuts): another room', sg.blue_coins === 2 && g2 !== g1 && g2 !== g0 && /bluecoins>=2/.test(gd2), `'${gd2}'`);
	touchG(8, 1);
	check('three (past the gate, no threshold above): the same room as two', sg.blue_coins === 3 && RG.key(sg) === g2, RG.desc(sg));
	// the wall breaker's progress order (editor.js breakStarts: coinsOf for its attempts, coinsOfDesc for the rooms'
	// starts) reads the count the key reads: the room past the gate ranks at the gate's count, at or above the rooms below
	// it (the n3 soundness review: coinsOfDesc read 'bluecoins>=2' as 0, behind 'bluecoins=1' and the start room)
	const ord = ['', gd1, gd2, RG.desc(sg)].map((d) => ED.coinsOfDesc(d, G));
	check('the breaker\'s order by the rooms\' descriptions (coinsOfDesc with the level): the start 0, one coin 1, past the gate 2 (the gate\'s count), three coins 2', ord.join(',') === '0,1,2,2', `${ord.join(',')} for '${gd1}' '${gd2}'`);
	check('... a door pocket (no gate: its thresholds are no progress) 0 as before, and without the level only coins=N counts',
		ED.coinsOfDesc(d2, A) === 0 && ED.coinsOfDesc('bluecoins=1') === 1 && ED.coinsOfDesc('coins=2 bluecoins>=2') === 2, `${ED.coinsOfDesc(d2, A)} ${ED.coinsOfDesc('bluecoins=1')} ${ED.coinsOfDesc('coins=2 bluecoins>=2')}`);
	const B = levelOf('pocket_cp', POCKET_CP).level;
	check('a checkpoint in the pocket: blue relevant', GX.counterRelevance(B).blue === true, JSON.stringify(GX.counterRelevance(B)));
	const Cr = levelOf('pocket_crown', POCKET_CROWN).level;
	check('a crown in the pocket and no crown door: blue irrelevant', GX.counterRelevance(Cr).blue === false, JSON.stringify(GX.counterRelevance(Cr)));
	const S = levelOf('short', SHORT).level, rs = GX.counterRelevance(S);
	check('the door in the corridor with a long way round: a shortcut, blue relevant', rs.blue === true && /shortcut/.test(rs.why.blue), JSON.stringify(rs));
	const RS = GX.roomOf(S), ss = new E.EESim(S); ss.reset();
	const s0 = RS.key(ss);
	touch(S, ss, 3, 1);
	check('there one blue coin is another room (as before)', RS.key(ss) !== s0);
	// EEAT_ROOMREL=0: a fresh level object (the cache is per level)
	const A2 = levelOf('pocket2', POCKET).level;
	process.env.EEAT_ROOMREL = '0';
	const r0 = GX.counterRelevance(A2);
	delete process.env.EEAT_ROOMREL;
	check('EEAT_ROOMREL=0: every counter relevant', r0.blue === true && r0.gold === true, JSON.stringify(r0));
}

// switches: 1 opens door e (the way to the trophy), 7 is read by no door; 2 opens f; 3 has a gate g
const SW = [
	'##############',
	'#S.1.7..2..e.T',
	'#.#########f##',
	'#.#########g##',
	'#.3.......####',
	'##############',
];
function sectionReaders() {
	section('readers: a switch no door or gate reads is no room change');
	const L = levelOf('sw', SW.map((r) => r.padEnd(14, '#'))).level;
	const SR = GX.switchReaders(L);
	check('switchReaders: 1 and 2 doors, 3 a gate, 7 none', SR.purple.has(1) && SR.purple.has(2) && SR.purple.get(3).gates === 1 && !SR.purple.has(7), JSON.stringify([...SR.purple]));
	const RM = GX.roomOf(L), LG = GX.roomOf(L, { legacy: true });
	const sim = new E.EESim(L); sim.reset();
	const k0 = RM.key(sim), l0 = LG.key(sim);
	touch(L, sim, 5, 1);
	check('switch 7 on: the same room (the legacy key changes)', sim.is_switch_on(7) && RM.key(sim) === k0 && LG.key(sim) !== l0, RM.desc(sim));
	touch(L, sim, 3, 1);
	check('switch 1 on: another room', sim.is_switch_on(1) && RM.key(sim) !== k0, RM.desc(sim));
	check('the mono switches: 1 and 2 (3 has a gate, 7 no reader)', RM.mono[0].join(',') === '1,2', RM.mono[0].join(','));
	// a door in the floor (air above it): shut, the ball stands on it, so turning its switch on takes a floor away
	const FL = levelOf('monofloor', ['##########', '#S.1....T#', '#####e####', '#........#', '##########']).level;
	const sf = GX.switchReaders(FL).purple.get(1);
	check('switchReaders: the door in the floor counts as a floor, the ones under a wall or a door do not', sf.floors === 1 && SR.purple.get(1).floors === 0 && SR.purple.get(2).floors === 0, JSON.stringify([sf, [...SR.purple]]));
	check('by default mono by doors and gates alone (as before): the floor door\'s switch is mono', GX.roomOf(FL).mono[0].join(',') === '1', GX.roomOf(FL).mono[0].join(','));
	process.env.EEAT_MONOFLOOR = '1';
	const monoOpt = GX.roomOf(FL).mono[0].length, monoOptSW = GX.roomOf(levelOf('sw2', SW).level).mono[0].join(',');
	delete process.env.EEAT_MONOFLOOR;
	check('EEAT_MONOFLOOR=1 (opt-in): a switch whose door can be a floor is no mono switch; the corridor\'s doors under a wall stay mono', monoOpt === 0 && monoOptSW === '1,2', `${monoOpt} / ${monoOptSW}`);
	section('dom: the class and the mask; shrinks; domIndex');
	const s2 = new E.EESim(L); s2.reset();
	const dA = RM.dom(s2);
	touch(L, s2, 3, 1);
	const dB = RM.dom(s2);
	touch(L, s2, 8, 1);
	const dC = RM.dom(s2);
	check('switch 1 then 2 on: the same class, the masks grow', dA.cls === dB.cls && dB.cls === dC.cls && dA.mask[0] === 0 && dB.mask[0] === 1 && dC.mask[0] === 3, `${dA.mask[0]} ${dB.mask[0]} ${dC.mask[0]}`);
	check('shrinks: {1,2} -> {1} yes, {1} -> {1,2} no, the same no', RM.shrinks(dC, dB) && !RM.shrinks(dB, dC) && !RM.shrinks(dB, dB));
	touch(L, s2, 2, 4);
	const dD = RM.dom(s2);
	check('switch 3 (a gate) on: another class, the same mask', dD.cls !== dC.cls && dD.mask[0] === 3);
	touch(L, s2, 3, 1);
	const dE = RM.dom(s2);
	check('switch 1 off again with 3 on: no shrink from the class of 3 off', !RM.shrinks(dC, dE) && RM.shrinks(dD, dE));
	const D = GX.domIndex();
	const m = (bits) => ({ cls: 5, mask: Int32Array.of(bits) });
	const g1 = D.groupOf(m(1)), g0 = D.groupOf(m(0));
	check('a strict subset of a known mask: dominated at once', !g1.dom && g0.dom && D.list.length === 1);
	const g2 = D.groupOf(m(2));
	check('an incomparable mask: both maximal', !g1.dom && !g2.dom && D.list.length === 2);
	const g3 = D.groupOf(m(3));
	check('a later superset: the smaller ones dominated, the list its one group', g1.dom && g2.dom && !g3.dom && D.list.length === 1 && D.list[0] === g3);
	check('the same class and mask: the same group', D.groupOf(m(3)) === g3 && D.groupOf({ cls: 6, mask: Int32Array.of(0) }).dom === false, JSON.stringify(D.stats()));
	check('a mask of no mono switch (length 0): one group per class, never dominated', (() => { const D2 = GX.domIndex(); const a = D2.groupOf({ cls: 1, mask: new Int32Array(0) }); const b = D2.groupOf({ cls: 1, mask: new Int32Array(0) }); return a === b && !a.dom; })());
	// dominance-share (night 3): the dominated groups (dlist) keep --domShare of head B's tournaments; order only
	check('dlist: every dominated group, in the order they fell', D.dlist.length === 3 && D.dlist.includes(g0) && D.dlist.includes(g1) && D.dlist.includes(g2) && !D.dlist.includes(g3));
	{
		const rng = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
		const w1 = () => 1;
		let fromD = 0, fromL = 0;
		const r1 = rng(7);
		for (let k = 0; k < 4000; k++) { const p = GX.domPick(D, 0.125, r1, w1); if (p.shared) { fromD++; if (!p.g.dom) fromD = -1e9; } else { fromL++; if (p.g.dom) fromL = -1e9; } }
		check('--domShare 0.125: ~1 in 8 tournaments over the dominated groups, the rest over the maximal ones', fromD > 380 && fromD < 620 && fromL > 3300, `${fromD} / ${fromL}`);
		const r0 = rng(7);
		let none = true;
		for (let k = 0; k < 500; k++) if (GX.domPick(D, 0, r0, w1).shared) none = false;
		check('--domShare 0: never a dominated group (the search before)', none);
		// no dominated group: no extra random draw, so a level without one searches exactly as before
		const D3 = GX.domIndex();
		const only = D3.groupOf({ cls: 1, mask: Int32Array.of(1) });
		let calls = 0;
		const rc = () => { calls++; return 0.01; };
		const p3 = GX.domPick(D3, 0.125, rc, w1);
		check('no dominated group: the base tournament, the same number of draws (4)', p3.g === only && !p3.shared && calls === 4, `draws ${calls}`);
		// a dominated group with no cell to pick (weight -1): the maximal ones instead
		const r2 = rng(3);
		const p4 = GX.domPick(D, 1, r2, (g) => (g.dom ? -1 : 1));
		check('dominated groups with nothing to pick: head B draws from the maximal ones', p4.g !== null && !p4.g.dom && !p4.shared);
	}
}

// the switch corridor: switch 1 in the corridor (passed there and back), door e before the trophy's shaft
const CORR = [
	'################',
	'#S....1.......e#',
	'#############.e#',
	'#############..#',
	'#############T.#',
	'################',
];
function sectionSearch() {
	section('search: goexplore.js with the novelty groups (--dom=1) and without');
	const { file } = levelOf('corr', CORR);
	for (const dom of [1, 0]) {
		const ev = gox(file, ['--cells=coarse', '--workers=1', '--seconds=30', '--first=1', `--dom=${dom}`, '--seed=3']);
		const res = ev.filter((e) => e.ev === 'result'), done = ev.find((e) => e.ev === 'done') || {};
		const w = (done.workers || [])[0] || {};
		check(`--dom=${dom}: a route, replayed`, res.length > 0, `${res.length ? res[0].ticks : '-'} ticks; groups ${w.groups}, dominated ${w.dominated}, picks in dominated rooms ${w.picksDom}`);
		if (dom === 1) check('--dom=1: groups counted', (w.groups || 0) >= 2, JSON.stringify({ groups: w.groups, dominated: w.dominated, maximal: w.maximal }));
	}
	// dominance-share: with every head-B tournament over the dominated groups (--domShare=1) the route is still found (an
	// order, no prune) and the tournaments are counted; --domShare=0 counts none
	for (const sh of [1, 0]) {
		const ev = gox(file, ['--cells=coarse', '--workers=1', '--seconds=4', '--dom=1', `--domShare=${sh}`, '--seed=3']);
		const res = ev.filter((e) => e.ev === 'result'), done = ev.find((e) => e.ev === 'done') || {};
		const w = (done.workers || [])[0] || {};
		check(`--domShare=${sh}: a route, replayed; head B's tournaments over dominated groups ${sh ? '> 0' : '0'}`, res.length > 0 && (sh ? (w.domShared || 0) > 0 : (w.domShared || 0) === 0),
			`${res.length ? res[0].ticks : '-'} ticks; dominated ${w.dominated}, domShared ${w.domShared}, picksDom ${w.picksDom}`);
	}
	// the pit of test/deaths.js: the death that pays is kept (its room is no dominated one)
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
	const { file: pit } = levelOf('pit', PIT);
	const ev = gox(pit, ['--cells=coarse', '--workers=1', '--seconds=20', '--first=1']);
	const res = ev.filter((e) => e.ev === 'result');
	check('the pit: a route through its death with --dom=1 (the default)', res.length > 0 && res[0].deaths >= 1, res.length ? `${res[0].ticks} ticks, ${res[0].deaths} death(s)` : 'none');
}

function sectionBursts() {
	section('bursts: a touch that only turns a mono switch off is no target');
	const L = levelOf('sw2', SW.map((r) => r.padEnd(14, '#'))).level;
	const RM = GX.roomOf(L);
	// the room with switch 1 on (pressed at (3, 1)); its walk reaches switch 1 again: turning it off shrinks the mask
	const sim = new E.EESim(L); sim.reset();
	touch(L, sim, 3, 1);
	sim.px = 16; sim.py = 16; sim.speed_x = 0; sim.speed_y = 0;
	const known = () => false;
	const aim = BU.roomAim(L, RM, sim, known, null);
	const goals = aim ? aim.goals.map((t) => `${t % L.width},${(t / L.width) | 0}`) : [];
	check('roomAim from the room with switch 1 on: switch 1 is no goal (it only shuts its door), switch 2 is', !goals.includes('3,1') && goals.includes('8,1'), goals.join(' '));
}

// the A/B knob EEAT_GX (editor.js gxExtra): extra goexplore.js options after the editor's own, for the CPU search, the
// escape and the GPU random runs; only --name=value words
function sectionKnob() {
	section('knob: EEAT_GX appends goexplore.js options (the CPU search, the escape, the GPU random runs)');
	const f = { eelvl: 'l.eelvl', bin: 'l.bin', reach: 'l.reach', steer: '', steerCpu: '', steerBeam: '' };
	const q = { seconds: 10, depth: 0, tool: 'eegpu', pauseFile: 'p', work: 'w', pass: 0, prefixFile: 'x.eetas', workers: 1, seed: 2 };
	const o = { deaths: true, workers: 1, seed: 1, cpuDepth: 1000, bursts: false, noWayUp: false, tool: 'eegpu', prune: true };
	const S = ED.STRATEGIES;
	const plain = [S.goexplore.args(f, o, q), S.escape.args(f, o, q), S.gorolls.args(f, o, q)];
	process.env.EEAT_GX = '--dom=0  --dord=0 bogus --x --useful=0';
	const knob = [S.goexplore.args(f, o, q), S.escape.args(f, o, q), S.gorolls.args(f, o, q)];
	delete process.env.EEAT_GX;
	const extra = (a, b) => b.filter((s) => !a.includes(s));
	check('unset: no extra option', plain.every((a) => !a.some((s) => /^--(dom|dord)=/.test(s))));
	check('set: the --name=value words, in order, in all three (bogus words dropped)', knob.every((k, i) => extra(plain[i], k).join(' ') === '--dom=0 --dord=0 --useful=0'),
		knob.map((k, i) => extra(plain[i], k).join(' ')).join(' | '));
	check('after the editor\'s own options (a later option wins in goexplore.js parseArgs)', knob[0].indexOf('--dom=0') > knob[0].indexOf('--stdin=1') && GX.parseArgs(['l.eelvl', '--dom=1', '--dom=0']).dom === 0);
}

sectionRelevance();
sectionReaders();
sectionSearch();
sectionBursts();
sectionKnob();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
