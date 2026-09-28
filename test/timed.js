'use strict';
// test/timed.js - timed killers in Find a route (src/timed.js; goexplore.js --timed, bursts.js ways; 2026-09-28):
//   left     timed.js timedLeft = the engine's kill: the ball idles after the pickup and dies in exactly that many ticks
//            (every tick one less); the bucket; nothing without a timer
//   doomed   the bound is sound: along runs that clear the curse no state before the clearing is doomed, and the found
//            route's states never are
//   search   the curse corridor (below): the remover is 45 tiles past the curse; from rest (the short way in, A) it is
//            ~154 ticks away and the curse kills after 140, with a 45-tile run-up (the long way, B) ~109. B picks the curse
//            up ~300 ticks after A, so with the cell key of before (--timed=0: the earliest arrival per cell) B's states are
//            dropped at every cell A's lineage reached first, with far more time left: no route in 20 M ticks (one worker,
//            seed 1); with the timer's bucket in the key a route (replayed: it clears the curse) and the counts
//   bursts   bursts.js: in the curse room the remover is a WAY (the walk goes through it) and the trigger beyond it a
//            target; with nothing beyond, the remover is the target (as before); a level without a timed killer has no ways
// usage: node test/timed.js [--only=left,doomed,search,bursts]      Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-timed-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const C = require('../src/common.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const BU = require('../src/bursts.js');
const RF = require('../src/reach.js');
const TMD = require('../src/timed.js');
const GOX = path.join(__dirname, '..', 'src', 'goexplore.js');

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const want = (s) => !ONLY || ONLY.has(s);
let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s}`);

/**
 * The curse corridor (100 x 13): the spawn (50, 2) in the upper corridor; A: the shaft x 47 (the curse (47, 5) in it)
 * drops the ball at rest into the lower corridor at (47, 11); B: the shaft x 1 (no curse) to the lower corridor's left
 * end, a 45-tile run-up and a one-row tunnel (45-46, 11) with the curse (46, 11) in it (no jumping over it); the remover
 * (91, 11) 45 tiles on; then the up-arrow shaft x 98 to the upper-right room and the trophy (58, 2), far from the remover
 * (the curse must be cleared). `extra`: more cells ([x, y, id, ...args]).
 */
function corridor(name, extra = []) {
	const W = 100, H = 13;
	const g = Array.from({ length: H }, () => Array(W).fill(1));
	const air = (x, y) => { g[y][x] = 0; };
	for (let x = 1; x <= 54; x++) { air(x, 1); air(x, 2); }
	for (let x = 56; x <= 97; x++) { air(x, 1); air(x, 2); }
	for (let x = 1; x <= 97; x++) for (let y = 9; y <= 11; y++) air(x, y);
	for (let y = 3; y <= 8; y++) { air(1, y); air(47, y); }
	for (const x of [45, 46]) { g[9][x] = 1; g[10][x] = 1; }
	const cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y][x]) cells.push([x, y, 9]);
	for (let y = 1; y <= 11; y++) cells.push([98, y, 2]);
	cells.push([50, 2, 255], [47, 5, 421, 1], [46, 11, 421, 1], [91, 11, 421, 0], [58, 2, 121], ...extra);
	const buf = ED.eelvlOf({ name, width: W, height: H, cells });
	const file = path.join(HOME, `${name}.eelvl`);
	fs.writeFileSync(file, buf);
	return { file, level: E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf))) };
}
const CORR = corridor('corridor');
/** goexplore.js on a level file: its JSON events */
function gox(file, args, timeoutMs = 180000) {
	const r = spawnSync(process.execPath, [GOX, file, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
	return String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
}
const masksOf = (s) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) - 48) & 31);
/** plays masks from the start; per tick after the pickup: {t, left, doomed, cleared, dead, finished} (fn gets each) */
function walkRun(level, masks, TM, fn) {
	const sim = new E.EESim(level), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		const was = sim.is_cursed;
		sim.tick(inp);
		const tile = (Math.trunc(sim.py + 8) >> 4) * level.width + (Math.trunc(sim.px + 8) >> 4);
		const left = TMD.timedLeft(sim);
		if (fn({ t, left, doomed: left > 0 && TMD.doomed(TM, tile, left), cleared: was && !sim.is_cursed && !sim.is_dead, dead: sim.is_dead, finished: sim.has_silver_crown, cursed: sim.is_cursed }) === false) break;
	}
}

let route = null;

function sectionLeft() {
	section('left: timedLeft is the engine\'s kill');
	const sim = new E.EESim(CORR.level), inp = new E.EEInput();
	sim.reset();
	check('no timer before the pickup', TMD.timedLeft(sim) === 0 && TMD.bucketOf(0) === 0);
	let t = 0;
	while (!sim.is_cursed && t < 400) { E.applyMask(inp, 2); sim.tick(inp); t++; }
	const l0 = TMD.timedLeft(sim);
	check('the pickup: 141 ticks left, duration 140, the top bucket', sim.is_cursed && l0 === 141 && TMD.TL.dur === 140 && TMD.TL.kind === TMD.KIND_CURSE &&
		TMD.bucketOf(l0) === TMD.bucketMax(), `left ${l0}, bucket ${TMD.bucketOf(l0)} of ${TMD.bucketMax()}`);
	let k = 0, steady = true;
	while (!sim.is_dead && k < 400) { E.applyMask(inp, 0); sim.tick(inp); k++; if (!sim.is_dead && TMD.timedLeft(sim) !== l0 - k) steady = false; }
	check('one less every tick, the death in exactly that many ticks', steady && k === l0, `dead after ${k}`);
	check('no timer while dead', TMD.timedLeft(sim) === 0);
	const TM = TMD.timedOf(CORR.level);
	check('timedOf: the curse, its remover (and the trophy)', TM !== null && TM.kinds === TMD.KIND_CURSE && TM.removers[0].length === 1 && TM.removers[0][0] === 11 * 100 + 91);
	const plain = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'plain', width: 10, height: 5, cells: [[0, 4, 9], [1, 4, 9], [2, 3, 255], [5, 3, 121]] }))));
	check('timedOf: null without a timed killer', TMD.timedOf(plain) === null);
}

function sectionSearch() {
	section('search: the curse corridor, the cell key with and without the timer');
	const T = 20000000;
	const off = gox(CORR.file, ['--workers=1', '--seed=1', `--maxTicks=${T}`, '--seconds=150', '--mem=400', '--cells=coarse', '--timed=0']);
	const dOff = off.find((e) => e.ev === 'done') || {};
	check('--timed=0: no route in 20 M ticks', !off.some((e) => e.ev === 'result') && dOff.end === 'ticks', `end ${dOff.end}, ${dOff.ticks} ticks`);
	check('--timed=0: states with more time left dropped (counted)', dOff.timed && dOff.timed.on === false && dOff.timed.droppedMore > 0, JSON.stringify(dOff.timed));
	const on = gox(CORR.file, ['--workers=1', '--seed=1', `--maxTicks=${T}`, '--seconds=150', '--mem=400', '--cells=coarse']);
	const r = on.find((e) => e.ev === 'result'), dOn = on.find((e) => e.ev === 'done') || {};
	check('default: a route', !!r, r ? `${r.runTicks} run ticks after ${r.simTicks} simulated ticks` : `end ${dOn.end}`);
	check('default: the timed counts', dOn.timed && dOn.timed.on === true && dOn.timed.cells > 0 && dOn.timed.dominated > 0 && dOn.timed.droppedMore === 0, JSON.stringify(dOn.timed));
	if (r) {
		const ms = masksOf(r.inputs), ev = C.evaluate(CORR.level, ms);
		check('the route replays (C.evaluate)', !!ev && ev.runTicks === r.runTicks && ev.deaths === 0);
		let cleared = -1, picked = -1;
		walkRun(CORR.level, ms, TMD.timedOf(CORR.level), (s) => { if (s.cursed && picked < 0) picked = s.t; if (s.cleared && cleared < 0) cleared = s.t; });
		check('it picks the curse up and clears it in time', picked >= 0 && cleared > picked && cleared - picked < 141, `pickup t${picked}, cleared t${cleared}`);
		route = ms;
		const again = gox(CORR.file, ['--workers=1', '--seed=1', `--maxTicks=${r.simTicks + 1000}`, '--seconds=150', '--mem=400', '--cells=coarse']);
		const r2 = again.find((e) => e.ev === 'result');
		check('the same seed: the same first route after the same ticks', !!r2 && r2.inputs === r.inputs && r2.simTicks === r.simTicks);
	}
}

function sectionDoomed() {
	section('doomed: the bound is sound');
	const TM = TMD.timedOf(CORR.level);
	let rnd = 12345;
	const next = () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return rnd / 4294967296; };
	if (route) {
		let d = 0, c = false;
		walkRun(CORR.level, route, TM, (s) => { if (s.cleared) c = true; if (!c && s.doomed) d++; });
		check('the found route: no state doomed before the clearing', d === 0 && c);
	}
	// the route's own variants: a few inputs changed around its curse leg; those that still clear the curse were never
	// doomed before (and every doomed state of them died or stayed cursed)
	if (route) {
		let pick = -1, clear = -1;
		walkRun(CORR.level, route, TM, (s) => { if (s.cursed && pick < 0) pick = s.t; if (s.cleared && clear < 0) clear = s.t; });
		let vs = 0, vClears = 0, vBad = 0, vDoomed = 0;
		for (let k = 0; k < 600; k++) {
			const ms = Uint8Array.from(route);
			const n = 1 + ((next() * 6) | 0);
			for (let j = 0; j < n; j++) ms[pick - 60 + ((next() * (clear - pick + 70)) | 0)] = [0, 2, 4, 5, 3, 1][(next() * 6) | 0];
			const st = [];
			walkRun(CORR.level, ms.subarray(0, clear + 40), TM, (s) => { st.push(s); return !s.dead; });
			vs++;
			const c = st.findIndex((s) => s.cleared);
			vDoomed += st.filter((s) => s.doomed).length;
			if (c >= 0) { vClears++; if (st.slice(0, c).some((s) => s.doomed)) vBad++; }
		}
		check('the route variants that clear the curse were never doomed before it', vBad === 0 && vClears > 0 && vDoomed > 0, `${vs} variants, ${vClears} cleared it, ${vDoomed} doomed states`);
	}
	// an idle ball after the pickup: doomed before it dies
	let doomedIdle = 0, died = false;
	const idle = new Uint8Array(400);
	for (let t = 0; t < 60; t++) idle[t] = 2;
	walkRun(CORR.level, idle, TM, (s) => { if (s.doomed) doomedIdle++; if (s.dead) { died = true; return false; } return true; });
	check('an idle ball after the pickup is doomed before its death', died && doomedIdle > 0, `${doomedIdle} doomed ticks`);
}

function sectionBursts() {
	section('bursts: the remover is a way, the trigger beyond it a target');
	const info = (lv, until) => {
		const RM = GX.roomOf(lv.level), field = RF.reachField(lv.level);
		const B = BU.create({ L: lv.level, a: { work: fs.mkdtempSync(path.join(HOME, 'b-')), tool: 'none', rArm: 0 }, field, RM, ports: [], say: () => {}, bound: () => 1e9,
			register: () => true, broadcast: () => {}, finish: () => {}, nearest: () => null, sec: () => 0 });
		// the room the ball is in once `until` says so (walking left into A's shaft: the curse room)
		const sim = new E.EESim(lv.level), inp = new E.EEInput(), ms = [];
		sim.reset();
		while (!until(sim) && ms.length < 400) { ms.push(2); E.applyMask(inp, 2); sim.tick(inp); }
		const W = lv.level.width, tile = (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4), key = RM.key(sim);
		B.room({ room: key, desc: RM.desc(sim), tile, t: ms.length, inputs: C.eetasBytes(Uint8Array.from(ms)).toString('latin1'), trig: true });
		const I = B.info(key);
		const tiles = (m) => [...m.values()].flat().map((t) => `${t % W},${(t / W) | 0}`);
		return { comps: tiles(I.comps), ways: tiles(I.ways) };
	};
	const cursed = (s) => s.is_cursed;
	const a = info(CORR, cursed);
	check('nothing beyond: the remover is the target (as before)', a.comps.includes('91,11') && a.ways.includes('91,11'), `targets ${a.comps.join(' ')}; ways ${a.ways.join(' ')}`);
	const K = corridor('corridor_key', [[94, 11, 6]]);   // a red key past the remover
	const b = info(K, cursed);
	check('a key beyond: the key the target, the remover a way', b.comps.includes('94,11') && !b.comps.includes('91,11') && b.ways.includes('91,11'), `targets ${b.comps.join(' ')}; ways ${b.ways.join(' ')}`);
	const c = info(K, () => true);   // (the start room: no timed killer running)
	check('no timed killer running: no ways, the curse a target', c.ways.length === 0 && c.comps.includes('47,5'), `targets ${c.comps.join(' ')}`);
}

if (want('left')) sectionLeft();
if (want('search')) sectionSearch();
if (want('doomed')) sectionDoomed();
if (want('bursts')) sectionBursts();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
