'use strict';
// test/deaths.js - deaths as moves (2026-09-28; OC's Good Egg TAS dies once on purpose, and the user: "deaths as a move
// must be SMART: it must know when dying has no advantage or when it does"):
//   judge    common.judge / deathCap: a faster run with more deaths is accepted unless the job forbids it (meta.json
//            "deaths": "forbid"), the same time with fewer deaths is accepted (a death that saves nothing goes), the
//            random-portal chance rule stays
//   cpu      src/goexplore.js on a checkpoint level where a death is the shortcut (the pit: a coin at the bottom of a
//            shaft too tall to climb opens the door by the checkpoint): no route with --deaths=0, a route with its death
//            with the default (replayed; the dying states counted: kept by the earliest arrival, the others dropped);
//            a death warp between two spawns (fine cells: the death kept by the cost, the only way); a level of
//            checkpoints and spikes where no death pays (the routes die 0 times); a level without a checkpoint: deaths
//            as moves off by default, the same search as --deaths=0 (the same routes after the same ticks); the pocket pit
//            (64x48: coarse cells, the useful territory on): a death that respawns in a 'cul-de-sac' (the gravity-blind
//            walk's) is the route, kept (seeds 1, 2)
//   rules    goexplore.js deathMovesFor (levels with a checkpoint or 2+ spawns and something that kills), the editor's
//            GPU tools get --deaths=1 there
//   editor   the searches' reach file follows deaths as moves (the pit: the _dm file with the death edges with them, the
//            death-free field without), the CPU search / GPU random runs' flag (none with them, --deaths=0 without), and
//            goexplore.js's own auto agrees; in cpu: the room dead ends (roomDead) only with deaths as moves off
//   gpu      (--gpu, a native build with a GPU) eegpu explore --deaths=1 finds the pit's route through its death (none
//            without), eegpu roll through goexplore --gpu=1 likewise
// usage: node test/deaths.js [--gpu]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GPU = process.argv.includes('--gpu');
// --only=judge,rules,editor,cpu,chain: those sections alone
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-deaths-'));
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
// ASCII levels: # wall, . air, S spawn, T trophy, C checkpoint, x spike, o coin, d coin door (1 coin)
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1], o: [100], d: [43, 1] };
const box = (inner) => ['#'.repeat(inner[0].length + 2), ...inner.map((r) => `#${r}#`), '#'.repeat(inner[0].length + 2)];
function levelFile(name, rows) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { if (!ID[ch]) throw new Error(`legend ${ch}`); cells.push([x, y, ...ID[ch]]); } }));
	const buf = ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
/** goexplore.js on a level file: its JSON events */
function gox(file, args, timeoutMs = 120000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const routesOf = (ev) => ev.filter((e) => e.ev === 'result');
const doneOf = (ev) => ev.find((e) => e.ev === 'done') || {};
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);

// the pit: the spawn and the checkpoint by the coin door; the coin at the bottom of a 2-wide shaft 7 rows deep (a jump
// climbs 4); the corridor's end is a spike: the death brings the ball back to the checkpoint with the coin
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

function sectionJudge() {
	section('judge: deaths are allowed unless the job forbids them');
	const best = { runTicks: 1000, deaths: 0, chance: 1 };
	const faster1 = { runTicks: 900, deaths: 1, chance: 1 };
	const v1 = C.judge(faster1, best, C.deathCap(null, best.deaths));
	check('a faster run with a death: accepted (no meta: allowed)', v1.accept && v1.saved === 100, JSON.stringify(v1));
	const v2 = C.judge(faster1, best, C.deathCap({ deaths: 'forbid' }, best.deaths));
	check('the same run when the job forbids more deaths: refused', !v2.accept && /dies 1/.test(v2.reason), JSON.stringify(v2));
	const v3 = C.judge(faster1, best, C.deathCap({ deaths: 'allow' }, best.deaths));
	check('"deaths": "allow": accepted', v3.accept);
	const v4 = C.judge({ runTicks: 1000, deaths: 0, chance: 1 }, { runTicks: 1000, deaths: 1, chance: 1 }, Infinity);
	check('the same time with fewer deaths: accepted (a death that saves nothing goes)', v4.accept && v4.fewerDeaths && v4.saved === 0, JSON.stringify(v4));
	const v5 = C.judge({ runTicks: 1000, deaths: 1, chance: 1 }, { runTicks: 1000, deaths: 1, chance: 1 }, Infinity);
	check('the same time, as many deaths: refused', !v5.accept);
	const v6 = C.judge({ runTicks: 1000, deaths: 2, chance: 1 }, { runTicks: 1000, deaths: 1, chance: 1 }, Infinity);
	check('the same time with more deaths: refused', !v6.accept);
	const v7 = C.judge({ runTicks: 900, deaths: 1, chance: 0.5 }, best, Infinity);
	check('faster with a death but a lower random-portal chance: refused (the chance rule stays)', !v7.accept && /EEO plays/.test(v7.reason), JSON.stringify(v7));
	const v8 = C.judge({ runTicks: 1000, deaths: 0, chance: 0.5 }, { runTicks: 1000, deaths: 1, chance: 1 }, Infinity);
	check('the same time, fewer deaths, a lower chance: refused', !v8.accept);
	check('deathCapFor: a file outside a job: allowed', C.deathCapFor(path.join(HOME, 'x.eetas'), 0) === Infinity);
}

function sectionRules() {
	section('rules: where deaths are moves');
	const pit = levelFile('pit_rules', PIT);
	check('the pit (a checkpoint, a spike): deaths are moves', GX.deathMovesFor(pit.level) === true);
	const noCp = levelFile('nocp', box(['S....x....T']));
	check('a spike and one spawn, no checkpoint: not by default', GX.deathMovesFor(noCp.level) === false && GX.deathsOf(noCp.level) !== null);
	const safe = levelFile('safe', box(['S...C....T']));
	check('a checkpoint, nothing that kills: never', GX.deathMovesFor(safe.level) === false && GX.deathsOf(safe.level) === null);
	check('DEATH_TICKS 55 (killed in tick D, alive in D + 55), DEATH_TILES = 55 ticks at the top running speed', GX.DEATH_TICKS === 55 && Math.abs(GX.DEATH_TILES - 55 * 6.78 / 16) < 1e-9);
	// the eesim respawn delay: killed during tick D, respawned at the end of D + 54
	const sim = new E.EESim(pit.level); sim.reset(); const inp = new E.EEInput();
	let dAt = -1, rAt = -1;
	sim.onEvent = (k) => { if (k === 'death') dAt = sim.ticks(); if (k === 'respawn') rAt = sim.ticks(); };
	const plan = [...Array(25).fill(2), ...Array(60).fill(0), ...Array(300).fill(4)];
	for (let t = 0; t < plan.length && rAt < 0; t++) { E.applyMask(inp, plan[t]); sim.tick(inp); }
	check('the engine: the respawn 54 ticks after the death tick, at the checkpoint', dAt > 0 && rAt - dAt === 54 && sim.px === 4 * 16 && sim.py === 16, `death ${dAt}, respawn ${rAt}, at ${sim.px / 16},${sim.py / 16}`);
	const args = (key) => { const cur = { opts: { deaths: true, prune: true, cpuDepth: 1000, workers: 1, seed: 1 } }; return ED._strategyArgs ? ED._strategyArgs(key, cur) : null; };
	void args;
}

/** the editor's side of the n2-int rule (main's deaths as moves + hx-int-1's dead ends): the searches' reach file and
 *  the CPU search's flag follow start()'s deathMoves. With deaths as moves the file keeps the death edges (reachBase dm:
 *  `_dm`) and goexplore.js gets no --deaths flag (its auto: the same deathMovesFor, so its field keeps them and no room dead
 *  end is cut); without them the death-free field where it reaches the start, and --deaths=0 (goexplore.js builds the same
 *  field and cuts the room dead ends). Both files of one level built side by side, each its own */
async function sectionEditor() {
	section('editor: the searches\' reach file and flags follow deaths as moves');
	const pit = levelFile('pit_editor', PIT);
	const buf = fs.readFileSync(pit.file);
	const hash = 'pittest0deaths01';
	const [on, off] = await Promise.all([ED.reachInfo(buf, hash, true), ED.reachInfo(buf, hash, false)]);
	const flagsOf = (dm) => { const b = fs.readFileSync(`${ED.reachBase(hash, dm)}.bin`); return b.toString('latin1', 0, 4) === 'RCH3' ? b.readInt32LE(28) : -1; };
	const fOn = flagsOf(true), fOff = flagsOf(false);
	check('the pit: with deaths as moves the searches\' file keeps the death edges (its own _dm file), without them the death-free field (it reaches the start)',
		ED.reachBase(hash, true).endsWith('_dm') && !ED.reachBase(hash, false).endsWith('_dm') && on.deathFree === false && on.deaths === true && (fOn & 1) === 1 &&
		off.deathFree === true && (fOff & 1) === 0 && on.startCost === off.startCost && on.onlyDeath === off.onlyDeath,
		`dm: deathFree ${on.deathFree}, file flags ${fOn}; plain: deathFree ${off.deathFree}, file flags ${fOff}; start ${on.startCost} / ${off.startCost}, onlyDeath ${on.onlyDeath} / ${off.onlyDeath}`);
	const f = { eelvl: pit.file, bin: 'pit.bin', reach: 'pit.reach', steer: '', steerCpu: '', steerBeam: '' };
	const q = { seconds: 10, depth: 0, tool: 'eegpu', pauseFile: 'p', work: 'w', pass: 0 };
	const o = (deaths) => ({ deaths, workers: 1, seed: 1, cpuDepth: 1000, bursts: false, noWayUp: false, tool: 'eegpu', prune: true });
	const gOn = ED.STRATEGIES.goexplore.args(f, o(true), q), gOff = ED.STRATEGIES.goexplore.args(f, o(false), q);
	const rOn = ED.STRATEGIES.gorolls.args(f, o(true), q), rOff = ED.STRATEGIES.gorolls.args(f, o(false), q);
	const has = (a, s) => a.includes(s);
	check('the CPU search and the GPU random runs: no --deaths flag with deaths as moves (auto: deathMovesFor), --deaths=0 without; never the branch\'s field flag --deaths=1',
		!gOn.some((s) => s.startsWith('--deaths')) && has(gOff, '--deaths=0') && !rOn.some((s) => s.startsWith('--deaths')) && has(rOff, '--deaths=0') && ![...gOff, ...rOff].includes('--deaths=1'),
		`on ${gOn.filter((s) => s.startsWith('--deaths')).join(' ') || '-'} / ${rOn.filter((s) => s.startsWith('--deaths')).join(' ') || '-'}; off ${gOff.filter((s) => s.startsWith('--deaths')).join(' ')} / ${rOff.filter((s) => s.startsWith('--deaths')).join(' ')}`);
	// goexplore.js's own decision for the same level (the editor's deathMoves = its auto): settle
	const aOn = GX.settle(GX.parseArgs([pit.file]), pit.level), aOff = GX.settle(GX.parseArgs([pit.file, '--deaths=0']), pit.level);
	check('goexplore.js settle: auto = deaths as moves on the pit (as the editor decides), --deaths=0 off', aOn.deathMoves === true && aOff.deathMoves === false && GX.deathMovesFor(pit.level) === true,
		`auto ${aOn.deathMoves}, --deaths=0 ${aOff.deathMoves}`);
}

function sectionCpu() {
	section('cpu: goexplore.js with deaths as moves');
	const pit = levelFile('pit', PIT);
	const off = gox(pit.file, ['--workers=1', '--cells=coarse', '--deaths=0', '--maxTicks=4000000', '--seconds=60']);
	check('the pit without deaths as moves: no route (the shaft cannot be climbed)', routesOf(off).length === 0, `end ${doneOf(off).end}`);
	const on = gox(pit.file, ['--workers=1', '--cells=coarse', '--maxTicks=4000000', '--seconds=60']);
	const st = on.find((e) => e.ev === 'start') || {};
	const rs = routesOf(on), best = rs[rs.length - 1], d = doneOf(on).deaths || {};
	const ev = best ? C.evaluate(pit.level, masksOf(best.inputs)) : null;
	check('the pit with deaths as moves (the default here): a route through its death, replayed', st.deathMoves === true && !!ev && ev.deaths === 1 && ev.ms.length === best.ticks,
		best ? `${rs.length} routes, the best ${best.ticks} ticks, ${ev ? ev.deaths : '?'} death(s); first after ${doneOf(on).first ? doneOf(on).first.simTicks : '-'} ticks` : 'none');
	check('the dying states counted: most dropped, the paying ones kept (the earliest arrival at the checkpoint with the coin)',
		d.seen > 0 && d.byNew + d.byCost >= 1 && d.dropped > 10 * (d.byNew + d.byCost) && d.cells >= 1, JSON.stringify(d));
	// the dead ends (hx-int-1's roomDead and the death-free field) only where deaths are not moves: with them the reach field
	// keeps its death edges and no room dead end is cut (the pocket at the pit's bottom is a dead end but for its death);
	// with --deaths=0 both are on (the runs end at a death, so the pocket is a dead end for them)
	const wOn = (doneOf(on).workers || [])[0] || {}, wOff = (doneOf(off).workers || [])[0] || {};
	check('the room dead ends only where deaths are not moves: off with them (roomDead off, nothing cut, a finite start), on with --deaths=0 (roomDead on, deaths as moves off)',
		wOn.roomDead === false && wOn.deadCut === 0 && st.startCost !== null && wOff.roomDead === true && (off.find((e) => e.ev === 'start') || {}).deathMoves === false,
		`on: roomDead ${wOn.roomDead}, cut ${wOn.deadCut}, start cost ${st.startCost}; off: roomDead ${wOff.roomDead}, cut ${wOff.deadCut}, start cost ${(off.find((e) => e.ev === 'start') || {}).startCost}, end ${doneOf(off).end}`);
	// a bound given from the start (--depth, a route of that length known): the sound lower bound with the death term
	// (lbOf: DEATH_TICKS + the bound at the respawn target) keeps the routes through the death
	const bnd = best ? best.ticks + 15 : 240;
	const onb = gox(pit.file, ['--workers=1', '--cells=coarse', `--depth=${bnd}`, '--maxTicks=4000000', '--seconds=60']);
	const rb = routesOf(onb);
	check('a depth bound from the start just above the route: routes through the death still found (the lower bound with a death)', rb.length > 0 && rb.every((e) => e.ticks <= bnd && e.deaths === 1),
		`bound ${bnd}: ${rb.map((e) => `${e.ticks}/${e.deaths}`).join(' ')}`);
	const on2 = gox(pit.file, ['--workers=1', '--cells=coarse', '--maxTicks=4000000', '--seconds=60']);
	check('the same seed and tick budget: the same routes (deaths change no draw)', JSON.stringify(routesOf(on2).map((e) => [e.ticks, e.inputs])) === JSON.stringify(rs.map((e) => [e.ticks, e.inputs])));
	// the pocket pit on a level past 2,500 tiles (the default cells coarse, the useful territory on): the spawn and the
	// checkpoint in a 3-deep pocket above the corridor, the coin at the bottom of the shaft, a spike at its end, a 1-coin
	// door before the trophy. The gravity-blind cul-de-sac walk counts the pocket as a cul-de-sac of the room after the
	// coin, yet the death back into it is the route: such a death is demoted, never dropped (the god-int soundness
	// review's pocketpit64: dropped, 0 routes on 3 of 3 seeds, 4.7-9.8 K deaths 'useless'; --useful=0 3 of 3)
	const PP = ['#####S##########', '#####C##########', '#####.##########', '#.......d..T...#', '#..#############', '#..#############',
		'#..#############', '#..#############', '#..#############', '#..#############', '#..........o..x#'];
	const pocket = levelFile('pocketpit64', Array.from({ length: 48 }, (_, y) => (y >= 1 && y <= PP.length ? PP[y - 1] + '#'.repeat(48) : '#'.repeat(64))));
	for (const s of [1, 2]) {
		const pp = gox(pocket.file, ['--workers=1', `--seed=${s}`, '--maxTicks=16000000', '--seconds=90']);
		const pr = routesOf(pp), pd = doneOf(pp).deaths || {};
		const pev = pr.length ? C.evaluate(pocket.level, masksOf(pr[pr.length - 1].inputs)) : null;
		check(`the pocket pit (64x48, coarse cells, the useful territory on), seed ${s}: a route through its death, replayed (a death respawning in a 'cul-de-sac' is kept and enters the room there)`,
			!!pev && pev.deaths >= 1 && pev.ms.length === pr[pr.length - 1].ticks,
			`${pr.length} routes${pr.length ? `, the best ${pr[pr.length - 1].ticks} ticks, ${pev ? pev.deaths : '?'} death(s)` : ''}; ${JSON.stringify(pd)}`);
	}
	// fine cells: a death warp between two spawns (the start is the second spawn after /reset; the death brings the ball to
	// the first, by the trophy): the only way
	const warp = levelFile('warp', box(['S...T#......', '######S....x']));
	const w0 = gox(warp.file, ['--workers=1', '--deaths=0', '--maxTicks=3000000', '--seconds=60']);
	const w1 = gox(warp.file, ['--workers=1', '--maxTicks=3000000', '--seconds=60']);
	const wr = routesOf(w1), wd = doneOf(w1).deaths || {};
	const wev = wr.length ? C.evaluate(warp.level, masksOf(wr[wr.length - 1].inputs)) : null;
	check('a death warp (fine cells, 2 spawns): no route without, a route through the death with it', routesOf(w0).length === 0 && !!wev && wev.deaths === 1 && wd.byCost + wd.byNew >= 1,
		`${wr.length} routes, ${wev ? `${wev.ms.length} ticks, ${wev.deaths} death(s)` : '-'}; ${JSON.stringify(wd)}`);
	// no death pays: a corridor with spikes in the floor and checkpoints behind the start (a respawn only sends the ball
	// back): every route dies 0 times
	const back = levelFile('back', box(['....................', '....................', '....................', 'C.C.S..............T', '#####...###...###..#', '#####xxx###xxx###xx#']));
	const b1 = gox(back.file, ['--workers=1', '--cells=coarse', '--maxTicks=3000000', '--seconds=60']);
	const br = routesOf(b1), bd = doneOf(b1).deaths || {};
	check('a level of checkpoints and spikes where no death pays: routes, none of them dies, no death kept', br.length > 0 && br.every((e) => e.deaths === 0) && bd.seen > 0 && bd.byNew + bd.byCost === 0,
		`${br.length} routes (${br.map((e) => `${e.ticks}/${e.deaths}`).join(' ')}), ${JSON.stringify(bd)}`);
	// no checkpoint: deaths as moves are off by default, the search is the one before (the same routes after the same ticks)
	const plain = levelFile('plain', box(['...........', '...........', '...........', 'S.....x...T']));
	const p0 = gox(plain.file, ['--workers=1', '--deaths=0', '--maxTicks=2000000', '--seconds=60']);
	const p1 = gox(plain.file, ['--workers=1', '--maxTicks=2000000', '--seconds=60']);
	const same = JSON.stringify(routesOf(p0).map((e) => [e.ticks, e.simTicks, e.inputs])) === JSON.stringify(routesOf(p1).map((e) => [e.ticks, e.simTicks, e.inputs]));
	check('a level without a checkpoint: the default search = --deaths=0 (the same routes after the same ticks)', same && routesOf(p1).length > 0 && (p1.find((e) => e.ev === 'start') || {}).deathMoves === false,
		`${routesOf(p1).length} routes`);
}

// the death-chain order (goexplore.js --dord=2, the default; reach.js deathChainField): the checkpoints' standing values
// to a fixpoint, the walk to the nearest killer, and a state ordered by the lesser of its own way and a death now; an
// order only (the RCH3 field and its -1 untouched)
function sectionChain() {
	section('the death-chain order (--dord=2)');
	const RF = require('../src/reach.js');
	const pit = levelFile('pit_chain', PIT), L = pit.level, W = L.width;
	const f0 = RF.reachField(L, { deaths: false }), ch = RF.deathChainField(L);
	const at = (f, x, y) => RF.costAt(f, x * 16, y * 16, 0);
	check('the pit: the chain field stable, the checkpoint\'s standing value the death-free one, the shaft\'s bottom still cut off (no death edges in it)',
		ch.chain.stable && ch.chain.cps === 1 && ch.chain.finite === 1 && at(ch, 4, 1) === at(f0, 4, 1) && at(ch, 11, 8) === -1 && at(f0, 11, 8) === -1,
		`${JSON.stringify(ch.chain)}; C ${at(ch, 4, 1)} / ${at(f0, 4, 1)}, coin ${at(ch, 11, 8)}`);
	check('the walk to the nearest killer: 0 on the spike, 3 tiles from the coin, none walkable from inside a wall',
		ch.toDeath[8 * W + 14] === 0 && ch.toDeath[8 * W + 11] === 15 && ch.toDeath[5 * W + 8] === RF.CUT, `spike ${ch.toDeath[8 * W + 14]}, coin ${ch.toDeath[8 * W + 11]}`);
	let refused = false;
	try { RF.writeReachFile(ch, path.join(HOME, 'chain.rch3'), 'x'); } catch (e) { refused = true; }
	check('the chain field is never an RCH3 file (an order, no proof: toGoals)', refused && ch.toGoals === true);
	// the long way back: the pit's bottom has a death-free way (a dot column 50 tiles on, the upper corridor, another
	// dot column: ~127 tiles) where a death back to the start costs ~40: the order takes the lesser, every route replays
	const G = Array.from({ length: 16 }, () => Array(64).fill('#'));
	const air = (x, y) => { G[y][x] = '.'; };
	for (let x = 1; x <= 12; x++) air(x, 6);
	for (let y = 7; y <= 13; y++) { air(1, y); air(2, y); }
	for (let x = 1; x <= 62; x++) air(x, 13);
	for (let x = 6; x <= 61; x++) air(x, 1);
	for (let y = 1; y <= 5; y++) G[y][6] = 'D';
	for (let y = 1; y <= 12; y++) G[y][61] = 'D';
	G[6][1] = 'S'; G[6][3] = 'C'; G[6][10] = 'd'; G[6][12] = 'T'; G[13][10] = 'o'; G[14][5] = 'x';
	ID.D = [4];
	const lp = levelFile('longpit', G.map((r) => r.join('')));
	const lf0 = RF.reachField(lp.level, { deaths: false });
	const runs = [1, 2].map((dord) => gox(lp.file, ['--workers=1', '--cells=coarse', `--dord=${dord}`, '--maxTicks=4000000', '--seconds=60']));
	const ok = runs.every((ev) => routesOf(ev).length > 0 && routesOf(ev).every((e) => { const v = C.evaluate(lp.level, masksOf(e.inputs)); return !!v && v.ms.length === e.ticks; }));
	check('the long way back (a finite death-free way of ~127 tiles from the coin): routes with --dord=2 and --dord=1, every one replayed',
		ok && at(lf0, 10, 13) > 100, `coin ${at(lf0, 10, 13)}; dord 1: ${routesOf(runs[0]).map((e) => `${e.ticks}/${e.deaths}`).join(' ')}; dord 2: ${routesOf(runs[1]).map((e) => `${e.ticks}/${e.deaths}`).join(' ')}; kept ${JSON.stringify(doneOf(runs[1]).deaths || {})}`);
	// no deaths as moves (no checkpoint): --dord changes nothing (the same routes after the same ticks)
	const plain = levelFile('plain_dord', box(['...........', '...........', '...........', 'S.....x...T']));
	const q = [1, 2].map((dord) => gox(plain.file, ['--workers=1', `--dord=${dord}`, '--maxTicks=2000000', '--seconds=60']));
	check('a level without deaths as moves: --dord=2 = --dord=1 (the same routes after the same ticks)',
		routesOf(q[1]).length > 0 && JSON.stringify(routesOf(q[0]).map((e) => [e.ticks, e.simTicks, e.inputs])) === JSON.stringify(routesOf(q[1]).map((e) => [e.ticks, e.simTicks, e.inputs])));
}
function sectionGpu() {
	section('gpu: eegpu explore / roll --deaths=1');
	const G = require('../src/gpu.js');
	const R = require('../src/reach.js');
	const tool = G.nativeTool();
	if (!tool) { check('a native tool (node tools/build-native.js)', false); return; }
	const info = spawnSync(tool, ['info'], { encoding: 'utf8' });
	check('eegpu info: "deaths":1', /"deaths":1/.test(info.stdout), info.stdout.slice(0, 120));
	const pit = levelFile('pit_gpu', PIT);
	const bin = path.join(HOME, 'pit.bin'), rf = path.join(HOME, 'pit.reach');
	fs.writeFileSync(bin, G.levelBlob(pit.level));
	fs.writeFileSync(rf, R.reachFileBytes(R.reachField(pit.level), G.blobFp(fs.readFileSync(bin))));
	const run = (d) => {
		const r = spawnSync(tool, ['explore', bin, '-', '--finish=1', '--discrete=1', '--depth=2000', '--seconds=30', '--coarse=0', '--cqx=0.25', '--cqv=16', `--reach=${rf}`, '--prune=1', ...G.cacheArgs(), `--deaths=${d}`],
			{ encoding: 'utf8', maxBuffer: 1 << 28 });
		const ev = String(r.stdout).split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
		return { hit: ev.find((e) => e.ev === 'hit'), done: ev.find((e) => e.ev === 'done') || {} };
	};
	const e0 = run(0), e1 = run(1);
	const rep = e1.hit ? C.evaluate(pit.level, masksOf(e1.hit.inputs)) : null;
	check('explore without --deaths: no route (exhausted)', !e0.hit && e0.done.end === 'exhausted', e0.done.end);
	check('explore --deaths=1: a route through its death, replayed in the JS engine', !!rep && rep.deaths === 1 && e1.done.deathsKept >= 1,
		rep ? `${rep.ms.length} ticks, ${rep.deaths} death(s), deathsKept ${e1.done.deathsKept}, maxLaunchMs ${e1.done.maxLaunchMs}` : JSON.stringify(e1.done));
	const g0 = gox(pit.file, ['--gpu=1', `--tool=${tool}`, '--deaths=0', '--seconds=15', '--first=1']);
	const g1 = gox(pit.file, ['--gpu=1', `--tool=${tool}`, '--seconds=30', '--first=1']);
	const gr = routesOf(g1);
	const gev = gr.length ? C.evaluate(pit.level, masksOf(gr[0].inputs)) : null;
	check('the GPU random runs (eegpu roll): no route without deaths, one through the death with them', routesOf(g0).length === 0 && !!gev && gev.deaths === 1, gev ? `${gev.ms.length} ticks` : '-');
}

(async () => {
	if (want('judge')) sectionJudge();
	if (want('rules')) sectionRules();
	if (want('editor')) await sectionEditor();
	if (want('cpu')) sectionCpu();
	if (want('chain')) sectionChain();
	if (GPU) sectionGpu();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('TEST ERROR', e); process.exitCode = 1; });
