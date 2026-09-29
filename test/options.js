'use strict';
// test/options.js - EVENT OPTIONS (src/options.js; goexplore.js --opts=1, OFF by default):
//   luby     the sequence (1 1 2 1 1 2 4 1 1 2 1 1 2 4 8 ...), the caps 4 x luby (at most 256) and the run lengths
//            40 x luby (at most 320)
//   classes  fieldClasses: plain / arrow / boost / dot / liquid / climbable / effect per tile
//   events   each end on toy levels in the engine: LAND (a fall from the spawn: the first tick on the ground), LIFT (a
//            jump: the first tick off it), WALL (a run into a wall: stopped next to it), APEX (a jump's top: the ball's
//            highest point), FIELD (a run into a dot field: the centre in a dot tile), ROOM (a coin a coin door reads:
//            the tick the coin is taken), the cap (a hold that meets no event), WALL with no direction held (cap only)
//   search   goexplore.js with --opts=1 (fine and coarse cells): a route (replayed), option runs about --optP of the runs,
//            the ends counted, the same seed and tick budget = the same search; without --opts no opts in the done
//            event; with --main=<main's goexplore.js> also the flag off = main (the same done numbers); all with
//            --classW=0 (the class workers' routes come in by the clock)
// usage: node test/options.js [--main=<path to origin/main's src/goexplore.js>]   Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-options-'));
process.env.EEAT_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const OP = require('../src/options.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const opt = {};
for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
function gox(tool, file, args, timeoutMs = 240000) {
	const r = spawnSync(process.execPath, [tool, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
/** the numbers of a search that a changed draw would change */
const sig = (ev) => { const d = doneOf(ev); const w = (d.workers || [])[0] || {}; return JSON.stringify([d.ticks, d.states, d.picks, d.finish, w.cells, w.impr, w.replays, w.rooms, routesOf(ev).map((r) => r.ticks)]); };

// ASCII levels: # wall, . air, S spawn, T trophy, o gold coin, d coin door (1), * dot, ^ up arrow, = boost up, ~ water,
// H chain (climbable), j jump effect
const ID = { '#': [9], S: [255], T: [121], o: [100], d: [43, 1], '*': [4], '^': [2], '=': [116], '~': [119], H: [120], j: [417, 2] };
function levelOf(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const file = path.join(HOME, name + '.eelvl');
	fs.writeFileSync(file, ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells }));
	return { file, L: E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file)))) };
}
// A: the spawn in the air over a floor (row 8 the floor, the ball stands in row 7), a wall at x 20
const LA = levelOf('opt_a', [
	'##############################',
	'#............................#',
	'#............................#',
	'#.S..........................#',
	'#............................#',
	'#............................#',
	'#...................#........#',
	'#...................#.......T#',
	'##############################',
	'##############################',
]);
// B: on the floor, a dot field at x 10-12 (rows 5-7); classes: an arrow, a boost, water, a chain, an effect
const LB = levelOf('opt_b', [
	'##############################',
	'#............................#',
	'#............................#',
	'#............................#',
	'#.........***.....^=~Hj......#',
	'#.........***................#',
	'#.........***................#',
	'#S........***...............T#',
	'##############################',
	'##############################',
]);
// C: a coin at x 8 and a 1-coin door at x 14 before the trophy (the door reads the coins: a room change)
const LC = levelOf('opt_c', [
	'##############################',
	'#............................#',
	'#............................#',
	'#............................#',
	'#............................#',
	'#............................#',
	'#.............d..............#',
	'#S......o.....d.............T#',
	'##############################',
	'##############################',
]);

function sectionLuby() {
	section('luby: the sequence, the caps, the run lengths');
	const want = [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, 1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, 16];
	const got = want.map((_, i) => OP.luby(i + 1));
	check('luby(1..31)', JSON.stringify(got) === JSON.stringify(want), got.join(' '));
	check('luby(63) = 32, luby(127) = 64, luby(64) = 1', OP.luby(63) === 32 && OP.luby(127) === 64 && OP.luby(64) === 1);
	let over = 0, big = 0;
	for (let j = 1; j <= 5000; j++) { const c = OP.capOf(j); if (c > 256 || c < 4 || c % 4) over++; if (c >= 64) big++; }
	check('caps 4 x luby within 4..256 (5,000 options), 64+ ticks in a few percent', over === 0 && big > 50 && big < 400, `${big} of 5000 at 64+`);
	const lens = new Set();
	for (let k = 1; k <= 2000; k++) lens.add(OP.lenOf(k));
	check('run lengths 40 x luby at most 320: 40 / 80 / 160 / 320', JSON.stringify([...lens].sort((a, b) => a - b)) === '[40,80,160,320]', [...lens].join(' '));
}

function sectionClasses() {
	section('classes: fieldClasses per tile');
	const FC = OP.fieldClasses(LB.L), W = LB.L.width;
	const at = (x, y) => FC[y * W + x];
	check('air and walls plain (0)', at(1, 1) === 0 && at(0, 0) === 0 && at(1, 7) === 0);
	check('dot 3, arrow 1, boost 2, water 4, chain 5, effect 6', at(10, 7) === 3 && at(18, 4) === 1 && at(19, 4) === 2 && at(20, 4) === 4 && at(21, 4) === 5 && at(22, 4) === 6,
		[at(10, 7), at(18, 4), at(19, 4), at(20, 4), at(21, 4), at(22, 4)].join(' '));
}

/** plays an option in the engine: `pre` inputs first, then mask m with end kind T and cap; per tick the state; returns
 *  {k (the end kind or -1), n (ticks held), tr (per tick: px, py, sx, sy, ground, coins)} */
function playOption(L, pre, m, T, cap, keyFn) {
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	for (const x of pre) { E.applyMask(inp, x); sim.tick(inp); }
	const o = new OP.Option(sim, OP.fieldClasses(L), L.width, L.width * L.height);
	const key = keyFn ? () => keyFn(sim) : () => 0;
	const tr = [{ px: sim.px, py: sim.py, sx: sim.speed_x, sy: sim.speed_y, g: sim.on_ground, coins: sim.coins }];
	o.start(m, T, cap, key());
	for (let n = 1; n <= cap + 5; n++) {
		E.applyMask(inp, m);
		sim.tick(inp);
		tr.push({ px: sim.px, py: sim.py, sx: sim.speed_x, sy: sim.speed_y, g: sim.on_ground, coins: sim.coins });
		const k = o.after(key());
		if (k >= 0) return { k, n, tr, sim, o };
	}
	return { k: -1, n: cap + 5, tr, sim, o };
}
const idle = (n) => new Array(n).fill(0);

function sectionEvents() {
	section('events: each end in the engine');
	// LAND: the fall from the spawn, idle: the first tick on the ground (the tick before in the air)
	let r = playOption(LA.L, [], 0, OP.T_LAND, 256);
	check('LAND: the fall from the spawn ends on its first tick on the ground', r.k === OP.T_LAND && r.tr[r.n].g && !r.tr[r.n - 1].g && r.tr.slice(0, r.n).every((s) => !s.g),
		`k ${OP.NAMES[r.k]} after ${r.n} ticks, py ${r.tr[r.n].py}`);
	const land = r.n + 5;   // (on the floor after this many idle ticks)
	// LIFT: from the floor, jump held: the first tick off the ground
	r = playOption(LA.L, idle(land), 1, OP.T_LIFT, 256);
	check('LIFT: a jump from the floor ends on its first tick in the air', r.k === OP.T_LIFT && !r.tr[r.n].g && r.tr[r.n - 1].g, `after ${r.n} ticks`);
	// APEX: the jump's top = the highest point of the jump
	r = playOption(LA.L, idle(land), 1, OP.T_APEX, 256);
	let top = Infinity, topAt = -1;
	{
		const sim = new E.EESim(LA.L); sim.reset(); const inp = new E.EEInput();
		for (let k = 0; k < land; k++) { E.applyMask(inp, 0); sim.tick(inp); }
		for (let k = 1; k <= 60; k++) { E.applyMask(inp, 1); sim.tick(inp); if (sim.py < top) { top = sim.py; topAt = k; } }
	}
	check('APEX: a held jump ends at its top (the speed along gravity turns)', r.k === OP.T_APEX && Math.abs(r.n - topAt) <= 1 && r.tr[r.n - 1].sy < 0 && r.tr[r.n].sy >= 0,
		`after ${r.n} ticks, the top at ${topAt} (py ${top.toFixed(2)} vs ${r.tr[r.n].py.toFixed(2)})`);
	// WALL: running right into the wall at x 20: stopped next to it, having run at 0.5+ px/tick
	r = playOption(LA.L, idle(land), 4, OP.T_WALL, 256);
	const cx = Math.trunc(r.tr[r.n].px + 8) >> 4;
	check('WALL: a run right into the wall ends stopped next to it', r.k === OP.T_WALL && cx === 19 && Math.abs(r.tr[r.n].sx) < 0.5 && r.tr.some((s) => s.sx >= 0.5),
		`after ${r.n} ticks at x ${cx}, speed ${r.tr[r.n].sx.toFixed(3)}`);
	// WALL with nothing held across gravity (jump only): the cap ends it
	r = playOption(LA.L, idle(land), 1, OP.T_WALL, 16);
	check('WALL with no direction held: the cap ends it (16 ticks)', r.k === OP.T_CAP && r.n === 16, `${OP.NAMES[r.k]} after ${r.n}`);
	// the cap: LAND held on the floor (no landing while it stands) ends after exactly its cap
	r = playOption(LA.L, idle(land), 0, OP.T_LAND, 8);
	check('the cap: a hold that meets no event ends after its cap (8)', r.k === OP.T_CAP && r.n === 8, `${OP.NAMES[r.k]} after ${r.n}`);
	// FIELD: running right into the dots at x 10: the centre in a dot tile
	const FC = OP.fieldClasses(LB.L);
	r = playOption(LB.L, idle(5), 4, OP.T_FIELD, 256);
	const ct = (s) => (Math.trunc(s.py + 8) >> 4) * LB.L.width + (Math.trunc(s.px + 8) >> 4);
	check('FIELD: a run into the dot field ends when the centre enters a dot tile', r.k === OP.T_FIELD && FC[ct(r.tr[r.n])] === 3 && FC[ct(r.tr[r.n - 1])] === 0, `after ${r.n} ticks`);
	// ROOM: running right over the coin the door reads: ends the tick the coin is taken
	const RM = GX.roomOf(LC.L);
	r = playOption(LC.L, idle(5), 4, OP.T_ROOM, 256, (sim) => RM.key(sim));
	check('ROOM: a run over the coin a door reads ends the tick the coin is taken', r.k === OP.T_ROOM && r.tr[r.n].coins === 1 && r.tr[r.n - 1].coins === 0, `after ${r.n} ticks`);
	// ROOM without rooms (a constant key): only the cap
	r = playOption(LC.L, idle(5), 4, OP.T_ROOM, 32);
	check('ROOM without rooms (fine cells): the cap ends it', r.k === OP.T_CAP && r.n === 32);
	// the live state is not changed by start / after (they only read it)
	{
		const sim = new E.EESim(LA.L); sim.reset();
		const o = new OP.Option(sim, OP.fieldClasses(LA.L), LA.L.width, LA.L.width * LA.L.height);
		const h = sim.stateHash();
		for (let T = 0; T < OP.N_EVENTS; T++) { o.start(5, T, 8, 0); o.after(0); }
		check('start / after read the live state only', sim.stateHash() === h);
	}
}

function sectionSearch() {
	section('search: goexplore.js with and without --opts');
	// (--classW=0: the class workers start once a route is known and feed their routes in by the clock, so with them
	// even main's coarse search differs run to run on this level: main twice gave 21 / 25 routes)
	const base = ['--workers=1', '--maxTicks=3000000', '--seconds=120', '--seed=1', '--mem=200', '--classW=0'];
	for (const cells of ['fine', 'coarse']) {
		const off = gox(GOX, LC.file, [...base, `--cells=${cells}`]);
		check(`${cells} cells without --opts: no opts in the done event`, doneOf(off).opts === undefined && doneOf(off).ticks > 0);
		const arg = [...base, `--cells=${cells}`, '--opts=1'];
		const a1 = gox(GOX, LC.file, arg), a2 = gox(GOX, LC.file, arg);
		const d1 = doneOf(a1), rr = routesOf(a1);
		const ev = rr.length ? C.evaluate(LC.L, masksOf(rr[rr.length - 1].inputs)) : null;
		check(`${cells} cells with --opts: a route (replayed)`, !!ev, rr.length ? `${rr[rr.length - 1].ticks} ticks, ${ev ? ev.runTicks + ' run ticks' : 'does not replay'}` : 'none');
		const o = d1.opts || {};
		check(`${cells} cells with --opts: option runs about --optP (0.5) of the runs`, o.runs > 0 && Math.abs(o.runs / (d1.picks * 8) - 0.5) < 0.05, `${o.runs} of ${d1.picks * 8}`);
		const ends = o.ends || {};
		check(`${cells} cells with --opts: ends counted (land, lift, apex, cap), cells made by option runs`, ends.land > 0 && ends.lift > 0 && ends.apex > 0 && ends.cap > 0 && o.cells > 0, JSON.stringify(o));
		if (cells === 'coarse') check('coarse cells: a ROOM end (the coin)', ends.room > 0, `room ${ends.room}`);
		check(`${cells} cells with --opts: the same seed and tick budget give the same search`, sig(a1) === sig(a2), sig(a1));
		check(`${cells} cells: --opts changes the search`, sig(a1) !== sig(off));
	}
	// the longer level: option runs up to 320 ticks, their paths replayed from the blocks (a tick budget that makes many)
	{
		const arg = [...base, '--cells=coarse', '--opts=1', '--optP=1', '--maxTicks=1500000'];
		const a1 = gox(GOX, LA.file, arg);
		const rr = routesOf(a1), ev = rr.length ? C.evaluate(LA.L, masksOf(rr[rr.length - 1].inputs)) : null;
		check('--optP=1 (every run an option run): a route whose inputs replay', !!ev && ev.runTicks > 0, rr.length ? `${rr.length} routes` : 'none');
	}
	if (opt.main) {
		for (const [lv, cells] of [[LC, 'fine'], [LC, 'coarse'], [LA, 'coarse']]) {
			const x = gox(GOX, lv.file, [...base, `--cells=${cells}`]), y = gox(path.resolve(opt.main), lv.file, [...base, `--cells=${cells}`]);
			check(`${path.basename(lv.file)} ${cells} cells without --opts = main (the same done numbers)`, sig(x) === sig(y), `${sig(x)} vs ${sig(y)}`);
		}
	}
}

sectionLuby();
sectionClasses();
sectionEvents();
sectionSearch();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
