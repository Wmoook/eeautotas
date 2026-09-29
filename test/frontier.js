'use strict';
// test/frontier.js - goexplore.js --frontier=1, the frontier field (head F: directed exploration; OPT-IN, default off):
//   units    frontierGoals / frontierField on a corridor level: no goal within --fDil tiles of a visited tile, the
//            unvisited far end is goals, the field's cost at rest falls toward the visited region's edge, a shut door
//            (the room's own state) walls the frontier behind it off (no cost at the start) where the open door does not;
//            walk mode: an air tile with nothing under it is no goal
//   cpu      src/goexplore.js on a false-near level (the trophy next to the start behind a 1-coin door, the coin at the far
//            end of a stepped corridor: the door-blind reach field pins head A at the door): the flag off = no head F and
//            no frontier numbers (the search as before: see the header of goexplore.js), --frontier=1: head F builds its
//            fields and picks, both route (replayed), the same seed and budget give the same search (the builds and the
//            share count picks, not the clock), and the visited tiles at a fixed budget
// usage: node test/frontier.js [--only=units,cpu]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-frontier-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const RF = require('../src/reach.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');
const ONLY = (process.argv.find((s) => s.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);
function gox(file, args, timeoutMs = 240000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);

/** a level from a grid of block ids (9 solid) and extra cells [x, y, id, ...args] */
function levelOf(file, name, w, h, g, extra) {
	const cells = [];
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] === 9) cells.push([x, y, 9]);
	for (const c of extra) { g[c[1]][c[0]] = -1; cells.push(c); }
	fs.writeFileSync(file, ED.eelvlOf({ name, width: w, height: h, cells: cells.filter((c) => c[2] !== 9 || g[c[1]][c[0]] === 9) }));
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(file))));
}

// The corridor (60 x 12): a floor at row 9, air rows 5-8 from x 1 to 58; a 1-coin door (43) at x 40, rows 5-8.
function corridor(file) {
	const W = 60, H = 12, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 58; x++) g[y][x] = 0;
	const extra = [[3, 8, 255], [57, 8, 121], [20, 8, 100]];
	for (let y = 5; y <= 8; y++) extra.push([40, y, 43, 1]);
	return levelOf(file, 'frontier corridor', W, H, g, extra);
}

function sectionUnits() {
	section('units: the frontier goals and field');
	const L = corridor(path.join(HOME, 'corridor.eelvl'));
	const W = L.width, H = L.height, N = W * H;
	const doors = GX.doorTiles(L);
	check('the door tiles', doors.length === 4 && doors.every((i) => i % W === 40), JSON.stringify(doors.map((i) => [i % W, (i / W) | 0])));
	// visited: the corridor's air from x 1 to 15
	const VIS = new Uint8Array(N);
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 15; x++) VIS[y * W + x] = 1;
	const shut = { is_tile_solid_now: () => true }, open = { is_tile_solid_now: () => false };
	const gs = GX.frontierGoals(L, open, doors, VIS, { dil: 1 });
	const gset = new Set(gs.goals.map((g) => g.tile));
	let near = 0;
	for (const t of gset) { const x = t % W, y = (t / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = (y + dy) * W + x + dx; if (y + dy >= 0 && y + dy < H && x + dx >= 0 && x + dx < W && VIS[j]) near++; } }
	check('no goal within 1 tile of a visited tile', near === 0, near);
	check('the unvisited corridor is goals (x 17 .. 58)', gset.has(8 * W + 17) && gset.has(6 * W + 50) && !gset.has(8 * W + 16), `${gs.goals.length} goals`);
	check('the open door is air in the field\'s level, the shut one a wall', gs.fg[8 * W + 40] === 0 && GX.frontierGoals(L, shut, doors, VIS, { dil: 1 }).fg[8 * W + 40] === 9);
	const f = GX.frontierField(L, gs.fg, gs.goals);
	const at = (x, y) => RF.costAt(f, x * 16, y * 16, 0);
	const c15 = at(15, 8), c8 = at(8, 8), c2 = at(2, 8);
	check('the cost at rest falls toward the visited region\'s edge', c15 >= 0 && c15 < c8 && c8 < c2, `x 15: ${c15}, x 8: ${c8}, x 2: ${c2} (${f.mode})`);
	// everything left of the door visited: the frontier is behind the door
	const V2 = new Uint8Array(N);
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 39; x++) V2[y * W + x] = 1;
	const fOpen = GX.frontierField(L, ...Object.values((({ fg, goals }) => ({ fg, goals }))(GX.frontierGoals(L, open, doors, V2, { dil: 1 }))));
	const gShut = GX.frontierGoals(L, shut, doors, V2, { dil: 1 });
	const fShut = GX.frontierField(L, gShut.fg, gShut.goals);
	const oS = RF.costAt(fOpen, 3 * 16, 8 * 16, 0), sS = fShut === null ? -1 : RF.costAt(fShut, 3 * 16, 8 * 16, 0);
	check('a shut door walls the frontier behind it off (the room\'s doors), the open one does not', oS > 0 && sS < 0, `open ${oS}, shut ${sS}`);
	// walk mode: air with nothing under it is no goal, a floor tile's air is
	const gw = GX.frontierGoals(L, open, doors, VIS, { dil: 1, walk: true });
	const wset = new Set(gw.goals.map((g) => g.tile));
	check('walk mode: only tiles the ball can be held in', wset.has(8 * W + 30) && !wset.has(6 * W + 30) && gw.goals.length < gs.goals.length, `${gw.goals.length} of ${gs.goals.length}`);
	// the dilation 0: the tiles next to the visited ones are goals too
	const g0 = GX.frontierGoals(L, open, doors, VIS, { dil: 0 });
	check('--fDil=0: the visited region\'s neighbours are goals', new Set(g0.goals.map((g) => g.tile)).has(8 * W + 16) && g0.goals.length > gs.goals.length);
}

// The false near (400 x 12 = 4,800 tiles: coarse cells): the spawn at (12, 8), the trophy at (2, 8) behind a 1-coin door
// (6, 5-8); the coin at (396, 8), at the end of a corridor (rows 5-8) with a step every 10 tiles (1-tile blocks on the
// floor), so the way to it is a long walk away from the trophy (past head F's first field, FR_MIN_PICKS picks in); the
// door-blind reach field puts the start 10 tiles from the trophy and every tile to the right farther.
function falseNear(file) {
	const W = 400, H = 12, g = Array.from({ length: H }, () => Array(W).fill(9));
	for (let y = 5; y <= 8; y++) for (let x = 1; x <= 398; x++) g[y][x] = 0;
	for (let x = 20; x < 395; x += 10) g[8][x] = 9;
	const extra = [[12, 8, 255], [2, 8, 121], [396, 8, 100]];
	for (let y = 5; y <= 8; y++) extra.push([6, y, 43, 1]);
	return levelOf(file, 'frontier false near', W, H, g, extra);
}

function sectionCpu() {
	section('cpu: goexplore.js on a false-near level, --frontier=0 / 1');
	const file = path.join(HOME, 'falsenear.eelvl');
	const L = falseNear(file);
	check('coarse cells', GX.cellsFor(L) === 'coarse');
	const T = 20000000;
	const base = ['--workers=1', '--seconds=120', `--maxTicks=${T}`, '--mem=400', '--first=1'];
	const rows = [];
	for (const seed of [1, 2]) {
		const off = gox(file, [...base, `--seed=${seed}`]);
		const on = gox(file, [...base, `--seed=${seed}`, '--frontier=1']);
		const d0 = doneOf(off), d1 = doneOf(on);
		const r0 = routesOf(off), r1 = routesOf(on);
		rows.push({ seed, off: d0, on: d1, r0, r1 });
		check(`seed ${seed}: --frontier=0 has no head F (no frontier numbers), its visited tiles counted`, d0.frontier === undefined && d0.visTiles > 0, `vis ${d0.visTiles}`);
		check(`seed ${seed}: --frontier=1 builds fields and picks by them`, d1.frontier && d1.frontier.builds > 0 && d1.frontier.picks > 0, JSON.stringify(d1.frontier));
		for (const [k, r] of [['off', r0], ['on', r1]]) {
			if (!r.length) { check(`seed ${seed} ${k}: a route in ${T / 1e6} M ticks`, false, `closest ${JSON.stringify((d1 && k === 'on' ? on : off).filter((e) => e.ev === 'closest').slice(-1).map((e) => e.dist))}`); continue; }
			const ev = C.evaluate(L, masksOf(r[0].inputs));
			check(`seed ${seed} ${k}: a route (replayed)`, !!ev && ev.ms.length === r[0].ticks, `${r[0].ticks} ticks after ${(r[0].simTicks / 1e6).toFixed(2)} M simulated`);
		}
	}
	// the same seed and budget: the same search (the builds and the share by picks)
	const again = doneOf(gox(file, [...base, '--seed=1', '--frontier=1']));
	const a1 = rows[0].on;
	check('--frontier=1: the same seed and budget give the same search', again.ticks === a1.ticks && again.states === a1.states && again.picks === a1.picks && JSON.stringify(again.frontier && again.frontier.picks) === JSON.stringify(a1.frontier.picks) && JSON.stringify(again.first && [again.first.ticks, again.first.simTicks]) === JSON.stringify(a1.first && [a1.first.ticks, a1.first.simTicks]),
		`${again.ticks} / ${a1.ticks} ticks, ${again.picks} / ${a1.picks} picks`);
	// the revision's options (the share by head F's yield, its own dead-end brake, the physics field without effects): a
	// route, replayed, and the same search again
	const opts2 = [...base, '--seed=1', '--frontier=1', '--fYield=1', '--fBrake=1', '--fPhys=1'];
	const x1 = gox(file, opts2), x2 = gox(file, opts2);
	const rx = routesOf(x1), dx1 = doneOf(x1), dx2 = doneOf(x2);
	check('--fYield=1 --fBrake=1 --fPhys=1: a route (replayed)', rx.length > 0 && !!C.evaluate(L, masksOf(rx[0].inputs)), rx.length ? `${rx[0].ticks} ticks, ${JSON.stringify(dx1.frontier)}` : 'none');
	check('--fYield=1 --fBrake=1 --fPhys=1: the same seed and budget give the same search', dx1.ticks === dx2.ticks && dx1.picks === dx2.picks && dx1.states === dx2.states, `${dx1.picks} / ${dx2.picks} picks`);
	const simOf = (r) => (r.length ? r[0].simTicks : Infinity);
	// what it is for: the corridor is walked in the first picks; the coin's room opens the door (territory no room walked),
	// its field's frontier is behind the door, and head F pulls that room's cells back to it (the backtracking a coin door
	// asks for), where heads A / B wander the explored corridor (seeds 1 and 2: 2.44 / 2.53 M simulated ticks vs 5.19 / 5.15 M)
	check('--frontier=1 routes the false near in fewer simulated ticks, both seeds (the coin room\'s frontier behind the door)', rows.every((r) => simOf(r.r1) < simOf(r.r0)),
		rows.map((r) => `${simOf(r.r1)} vs ${simOf(r.r0)}`).join(', '));
	console.log(`  (the simulated ticks to the first route, off / on: ${rows.map((r) => `seed ${r.seed} ${simOf(r.r0)} / ${simOf(r.r1)}`).join(', ')}; visited tiles ${rows.map((r) => `${r.off.visTiles} / ${r.on.visTiles}`).join(', ')})`);
}

if (want('units')) sectionUnits();
if (want('cpu')) sectionCpu();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
