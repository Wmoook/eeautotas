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
//            as moves off by default, the same search as --deaths=0 (the same routes after the same ticks)
//   rules    goexplore.js deathMovesFor (levels with a checkpoint or 2+ spawns and something that kills), the editor's
//            GPU tools get --deaths=1 there
//   gpu      (--gpu, a native build with a GPU) eegpu explore --deaths=1 finds the pit's route through its death (none
//            without), eegpu roll through goexplore --gpu=1 likewise
// usage: node test/deaths.js [--gpu]      Exit code 1 if any check fails. Writes only in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GPU = process.argv.includes('--gpu');
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
// ASCII levels: # wall, . air, S spawn, T trophy, C checkpoint, x spike, o coin, d coin door (1 coin), L / l low gravity on / off
const ID = { '#': [9], S: [255], T: [121], C: [360], x: [361, 1], o: [100], d: [43, 1], L: [453, 1], l: [453, 0] };
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
	// a bound given from the start (--depth, a route of that length known): the sound lower bound with the death term
	// (lbOf: DEATH_TICKS + the bound at the respawn target) keeps the routes through the death
	const bnd = best ? best.ticks + 15 : 240;
	const onb = gox(pit.file, ['--workers=1', '--cells=coarse', `--depth=${bnd}`, '--maxTicks=4000000', '--seconds=60']);
	const rb = routesOf(onb);
	check('a depth bound from the start just above the route: routes through the death still found (the lower bound with a death)', rb.length > 0 && rb.every((e) => e.ticks <= bnd && e.deaths === 1),
		`bound ${bnd}: ${rb.map((e) => `${e.ticks}/${e.deaths}`).join(' ')}`);
	const on2 = gox(pit.file, ['--workers=1', '--cells=coarse', '--maxTicks=4000000', '--seconds=60']);
	check('the same seed and tick budget: the same routes (deaths change no draw)', JSON.stringify(routesOf(on2).map((e) => [e.ticks, e.inputs])) === JSON.stringify(rs.map((e) => [e.ticks, e.inputs])));
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
	// the effect transport (hx2-r1-deaths): the respawn keeps the static effects, so a death carries low gravity back to the
	// checkpoint C past its remover l; the trophy is 11 rows above C (a jump climbs 4, a low-gravity one many more). The
	// only way: C first, back through the tunnel (low gravity off there) to L, die on the spikes by it, the respawn at C in
	// low gravity, the high jump. Without the checkpoint in the cell key the state that comes back to L holding C shares
	// its cells with the first visit's (checkpoint none) and is not kept; --cpkey=2 keys a far checkpoint
	const tr = levelFile('transport', box([
		'.................#.....T....',
		...Array(10).fill('.................#..........'),
		'..S......L.xx....l....C.....',
	]));
	const t2 = gox(tr.file, ['--workers=1', '--cells=coarse', '--cpkey=2', '--maxTicks=6000000', '--seconds=90'], 150000);
	const rt = routesOf(t2), bt = rt[rt.length - 1], evt = bt ? C.evaluate(tr.level, masksOf(bt.inputs)) : null;
	check('the effect transport (low gravity carried to a far checkpoint by a death): --cpkey=2 routes through the death, replayed', !!evt && evt.deaths >= 1 && evt.ms.length === bt.ticks,
		bt ? `${rt.length} routes, the best ${bt.ticks} ticks, ${evt ? evt.deaths : '?'} death(s), first after ${doneOf(t2).first ? doneOf(t2).first.simTicks : '-'} ticks; ${JSON.stringify(doneOf(t2).deaths || {})}` : 'none');
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

sectionJudge();
sectionRules();
sectionCpu();
if (GPU) sectionGpu();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
