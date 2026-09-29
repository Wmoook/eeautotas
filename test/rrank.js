'use strict';
// test/rrank.js - ROUTE-RANK (src/rrank.js, src/landmarks.js, src/rrank.json, editor.js EEAT_RRANK; tools/rrank.js):
//   unit    the model loads (src/rrank.json: the features in src/rrank.js's order) and scores; a room description's features
//           (useful coins by the highest coin door, keys a door reads, the read switches, effects, the team a door reads, the
//           landmarks held); the rank class rises with the door's coins; the landmarks of a toy (the coin door's count);
//           tools/rrank.js's pairwise trainer on synthetic pairs (the weights order the rooms)
//   editor  the toy: a false near 5 tiles from the trophy with 0 coins (the CPU search's nearest attempt: holding right to
//           the shut 1-coin door) and a room of 1 coin 30 tiles out (the CPU search's source: holding left to the coin);
//           rank off: the nearest attempt (the page's ring) and the wall breaker's first start are the false near (main);
//           rank on (EEAT_RRANK=1 / body rrank 1): the coin attempt, the distance record (S.nearestDist) still the false
//           near; the breaker's progress order off here (breakProg: main's own coins-first order of its starts)
// node test/rrank.js [--only=unit,editor]
const fs = require('fs');
const path = require('path');
const os = require('os');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-rrank-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
delete process.env.EEAT_RRANK;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const RK = require('../src/rrank.js');
const LM = require('../src/landmarks.js');
const ED = require('../src/editor.js');
const argv = process.argv.slice(2);
const ONLY = ((argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`); }
const section = (s) => console.log(`\n== ${s}`);
function room(W, H) {
	const c = [];
	for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]);
	return c;
}
// the toy: a corridor 60 x 12, the spawn in the middle, a coin at the left end, a 1-coin door wall at x 55 and the trophy
// behind it; a floor of solid blocks at row 10
const W = 60, H = 12;
const cells = [...room(W, H)];
for (let x = 1; x < W - 1; x++) cells.push([x, 10, 9]);
for (let y = 1; y < 10; y++) cells.push([55, y, 43, 1]);
cells.push([30, 9, 255], [5, 9, 100], [58, 9, 121]);
const toy = { name: 'rrank toy', width: W, height: H, cells };
const buf = ED.eelvlOf(toy);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'rrank', file: 'toy.eelvl' }));

function unit() {
	section('unit: the model, the features, the landmarks, the trainer');
	const M = RK.loadModel();
	check('the model loads (src/rrank.json): its features are src/rrank.js\'s, finite weights, a class step', !!M && M.feats.join() === RK.FEATS.join() && M.step > 0, M ? `${M.feats.length} features, step ${M.step}` : 'none');
	const I = RK.levelInfo(L);
	check('the level\'s readers: the highest coin door 1, one coin tile, no key / switch / team reader', I.gMax === 1 && I.gN === 1 && I.keyN === 0 && I.swN === 0 && I.teams.size === 0, JSON.stringify({ gMax: I.gMax, gN: I.gN, keyN: I.keyN, swN: I.swN }));
	const lm = LM.landmarksOf(L);
	check('the landmarks: the relaxation reaches the trophy, "coins>=1" (the door) a landmark', lm.trophy >= 0 && lm.landmarks.some((l) => l.f === 'coins>=1'), JSON.stringify(lm.landmarks));
	const f0 = RK.featuresOf(I, '', 0), f1 = RK.featuresOf(I, 'coins=1', 0);
	const k = (n) => RK.FEATS.indexOf(n);
	check('features: 0 coins all 0; the door\'s count held: gold 1, goldAll 1, the landmark held; every feature in [0, 1]',
		f0.every((x) => x === 0) && f1[k('gold')] === 1 && f1[k('goldAll')] === 1 && f1[k('lm')] === 1 && f1.every((x) => x >= 0 && x <= 1), `${f1.map((x) => x.toFixed(2)).join(' ')}`);
	// (useful only: a coin past the highest door adds nothing to gold; a key no door reads adds nothing; switches as read)
	const I2 = { gMax: 3, bMax: 0, gN: 10, bN: 0, keys: 1 << 2, keyN: 1, swN: 4, teams: new Set([2]), crown: false, lm: [], lmN: 0 };
	const g = RK.featuresOf(I2, 'coins=7 key:red key:blue purple=[1,3] team=2 lowgrav curse', 0);
	check('features on a richer level: gold capped at the door (1), goldAll 0.7, only the read key (blue), 2 of 4 switches, the team a door reads, an effect and a killer',
		g[k('gold')] === 1 && Math.abs(g[k('goldAll')] - 0.7) < 1e-9 && g[k('keys')] === 1 && Math.abs(g[k('swFrac')] - 0.5) < 1e-9 && g[k('team')] === 1 && g[k('effGood')] > 0 && g[k('effKill')] === 1,
		g.map((x) => x.toFixed(2)).join(' '));
	const R = RK.ranker(L);
	check('the ranker: the coin room above the start room by class (and "timedoors:" words ignored)', !!R && R.cls('coins=1') > R.cls('') && R.score('timedoors:open coins=1') === R.score('coins=1'),
		R ? `start ${R.score('').toFixed(2)} / class ${R.cls('')}, coins=1 ${R.score('coins=1').toFixed(2)} / class ${R.cls('coins=1')}` : 'no ranker');
	check('no model: no ranker (the editor then runs main\'s search)', RK.ranker(L, { model: null, info: I }) === null || RK.loadModel(path.join(HOME, 'none.json')) === null);
	// the trainer: synthetic levels whose later route rooms hold more coins, the side rooms more switches
	const TR = require('../tools/rrank.js');
	const lv = { info: { gMax: 4, bMax: 0, gN: 4, bN: 0, keys: 0, keyN: 0, swN: 4, teams: [], crown: false, lm: [], lmN: 0 }, gain: {},
		routes: [{ rooms: [['', 0], ['coins=1', 0.3], ['coins=2', 0.6], ['coins=4', 0.9]] }],
		stalled: [{ rooms: [['', 0, 0], ['coins=1', 1, 0], ['purple=[1,2,3]', 2, 0], ['coins=2', 3, 0]], fn: 'purple=[1,2,3]' }] };
	const lp = TR.pairsOf(lv);
	const w = TR.train([lp], 0.01);
	const s = (d) => { const f = lp.feat.get(d); return f.reduce((a, x, j) => a + x * w[j], 0); };
	check('the pairwise trainer: the route\'s frontier (2 coins) above the off-route switch room, the coins weighted up', s('coins=2') > s('purple=[1,2,3]') && w[k('gold')] > 0,
		`w gold ${w[k('gold')].toFixed(2)} swCnt ${w[k('swCnt')].toFixed(2)}; s(coins=2) ${s('coins=2').toFixed(2)} s(switches) ${s('purple=[1,2,3]').toFixed(2)}`);
	const pick = TR.pickOf(lv.stalled[0], s, 0.5);
	check('the counterfactual pick: the run\'s best class (the 2-coin room) over its nearest attempt\'s room (the switches)', pick === 'coins=2', String(pick));
}

// the stand-ins: eegpu (info; every move holds until its stop file; the breaker's runs, --cap=2097152, logged with their
// --prefix's length and first input) and the CPU search (the false near as its nearest attempt, the coin room as a source)
const FAKE = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), args = process.argv.slice(3);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a === undefined ? undefined : a.slice(k.length + 3); };
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'info') return void say({ gpu: { name: 'fake' }, reach: 3, steer: 0 });
const pfx = opt('prefix'), pfs = pfx && fs.existsSync(pfx) ? fs.readFileSync(pfx, 'latin1') : null;
fs.appendFileSync(SC.log, JSON.stringify(pfs === null ? args : args.concat(['#pf=' + pfs.length + ':' + pfs.slice(0, 1)])) + '\\n');
if (args[0] !== 'explore' || args.includes('--cap=2097152')) return void setTimeout(() => say({ ev: 'done', layers: 3, end: 'time' }), 200);
const sf = opt('stopfile');
const iv = setInterval(() => {
	if (sf && fs.existsSync(sf)) { clearInterval(iv); say({ ev: 'done', layers: 3, end: 'stopped' }); process.exit(0); }
	say({ ev: 'layer', layer: 3, tick: 3, new: 5, kept: 5, states: 1000, hits: 0, sec: 0.1, ticks: 18000, ticksPerSec: 1e6, full: 0.01 });
}, 200);
`;
const FAKE_CPU = `'use strict';
const fs = require('fs');
const SC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'fine', startCost: 40 });
setTimeout(() => say({ ev: 'closest', dist: 5, tick: SC.near.length, inputs: SC.near }), 150);
setTimeout(() => say({ ev: 'source', seed: 1, kind: 'room', room: 777, desc: 'coins=1', gain: 10, tick: SC.coin.length, dist: 30, inputs: SC.coin }), 400);
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 5, found: 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
process.stdin.on('data', (d) => { if (/stop/.test(String(d))) end(); });
process.stdin.on('end', end);
`;

async function editorToy() {
	section('editor: the nearest attempt by rank (the toy: a 0-coin false near 5 tiles out vs the door\'s coin 30 tiles out)');
	// (the attempts replay in the engine: holding right ends at the door, holding left takes the coin)
	const near = '4'.repeat(300), coin = '2'.repeat(300);
	const play = (s) => { const sim = new E.EESim(L); sim.reset(); const inp = new E.EEInput(); for (const ch of s) { E.applyMask(inp, (ch.charCodeAt(0) - 48) & 31); sim.tick(inp); } return sim; };
	const sN = play(near), sC = play(coin);
	check('the toy: holding right ends by the shut door with 0 coins, holding left takes the coin', sN.coins === 0 && ((sN.px + 8) >> 4) >= 50 && sC.coins === 1, `right: x ${(sN.px + 8) >> 4} coins ${sN.coins}; left: coins ${sC.coins}`);
	const fake = path.join(HOME, 'fake-eegpu.js'), fakeCpu = path.join(HOME, 'fake-cpu.js');
	fs.writeFileSync(fake, FAKE); fs.writeFileSync(fakeCpu, FAKE_CPU);
	const out = {};
	for (const mode of [0, 1]) {
		const sc = path.join(HOME, `sc${mode}.json`), log = path.join(HOME, `eegpu${mode}.log`), scC = path.join(HOME, `cpu${mode}.json`);
		fs.writeFileSync(sc, JSON.stringify({ log }));
		fs.writeFileSync(scC, JSON.stringify({ near, coin }));
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 40, width: 1024, workers: 1, steer: false, useful: false, rrank: mode }, { available: true },
			{ tool: [process.execPath, fake, sc], cpu: [process.execPath, fakeCpu, scC], salts: false, relay: true, breaker: true, breakWait: [1, 2, 4], breakCells: 26, breakProg: false });
		const brkRuns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'explore' && a.includes('--cap=2097152')) : []);
		const t0 = Date.now();
		while (ED.state().running && !brkRuns().length && Date.now() - t0 < 20000) await new Promise((z) => setTimeout(z, 100));
		const st = ED.state();
		ED.stop();
		while (ED.state().running) await new Promise((z) => setTimeout(z, 50));
		const b0 = brkRuns()[0];
		out[mode] = { closest: st.closest ? String(st.closest.inputs).slice(0, 1) : null, desc: st.closest ? st.closest.desc : undefined, tiles: st.closest ? st.closest.tiles : null,
			brk: b0 ? (b0.find((x) => x.startsWith('#pf=')) || '#pf=?').slice(4) : null, nearestDist: st.nearestDist || null, rank: st.rank || null };
	}
	const o0 = out[0], o1 = out[1];
	check('rank off (main): the nearest attempt (the page\'s ring) is the false near (holding right) and the wall breaker\'s first start the false near 150 ticks back; no rank state',
		o0.closest === '4' && o0.brk === '150:4' && !o0.rank && !o0.nearestDist, JSON.stringify(o0));
	check('rank on: the nearest attempt is the coin attempt (room "coins=1", a higher class) and the wall breaker\'s first start the coin attempt 150 ticks back; the distance record (S.nearestDist) still the false near',
		o1.closest === '2' && o1.desc === 'coins=1' && o1.brk === '150:2' && !!o1.nearestDist && o1.nearestDist.dist === 5 && !!o1.rank && o1.rank.promotions >= 1 && o1.rank.best && o1.rank.best.desc === 'coins=1',
		JSON.stringify(Object.assign({}, o1, { rank: o1.rank })));
}

(async () => {
	if (want('unit')) unit();
	if (want('editor')) await editorToy();
	console.log(`\n${pass} passed, ${fail} failed`);
	ED.shutdown && ED.shutdown();
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
