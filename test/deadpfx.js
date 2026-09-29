'use strict';
// test/deadpfx.js - a start that ends in its dead ticks (bursts.js liveEnd, 2026-09-29 night 3, branch n3-burst-dead-prefix):
// on levels where deaths are moves a run carries its deaths (the death, then the dead ticks up to the respawn), so a
// start cut back along it (the bursts' BACK / CHAIN_BACK / TROPHY_BACK, the relay's, the wall breaker's, the stall
// escape's) can end while the ball is dead, and eegpu explore refuses it (explorehost.h --prefix: exit 3, "the prefix
// dies"): the arm's GPU turn was lost (sweep6: Frolic 14 bursts of 300 s, VVVVVV 11). The fix plays such a start on with
// idle ticks to the respawn; nothing is pruned.
//   unit     liveEnd on a corridor (spawn, checkpoint, spike): a start cut in the dead ticks is played on to the respawn
//            (idle ticks only, at most DEAD_PAD_MAX, the ball alive at the checkpoint, the same state as the run's own
//            inputs there: the dead ticks read no input); a live start, a non-string and an empty one unchanged;
//            EEAT_DEADPFX=0: unchanged
//   bursts   goexplore.js --bursts=1 on the pit (test/deaths.js: the coin at the bottom of a shaft, a death to the
//            checkpoint is the way on) with a stand-in for eegpu explore that applies explorehost.h's prefix rule and
//            records every start it gets: no start ends dead and no burst fails "the prefix dies"; with EEAT_DEADPFX=0
//            the same search sends dead starts that fail (the failure class, on the product path)
// usage: node test/deadpfx.js      Exit code 1 if any check fails. Writes only in a temp folder. CPU only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeautotas-deadpfx-'));
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
/** the state after inputs ('0'+mask chars) from the level's start */
function play(L, s) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let t = 0; t < s.length; t++) { E.applyMask(inp, (s.charCodeAt(t) - 48) & 31); sim.tick(inp); }
	return sim;
}

function sectionUnit() {
	section('unit: liveEnd plays a start that ends dead on to the respawn');
	// the corridor: the spawn, the checkpoint next to it, a spike at the far end; held right the ball touches the
	// checkpoint, dies on the spike and comes back at the checkpoint DEATH_TICKS later
	const cor = levelFile('corridor', box(['..........', 'SC......x.']));
	const L = cor.level;
	check('deaths are moves here (a checkpoint and a killer)', GX.deathMovesFor(L) === true);
	const R = String.fromCharCode(48 + 4);
	const run = R.repeat(300);
	let D = -1;
	{
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let t = 0; t < run.length; t++) { E.applyMask(inp, 4); sim.tick(inp); if (sim.is_dead) { D = t; break; } }
	}
	check('held right, the ball dies on the spike', D > 0, `death in tick ${D}`);
	for (const k of [0, 10, 30, 53]) {
		const pre = run.slice(0, D + 1 + k);
		const dead = play(L, pre).is_dead;
		const out = BU.liveEnd(L, pre);
		const pad = out.slice(pre.length);
		const s1 = play(L, out);
		const own = play(L, run.slice(0, out.length));   // the run's own inputs to the same tick (right held through the dead ticks)
		const cx = (s1.px + 8) >> 4, cy = (s1.py + 8) >> 4;
		check(`a start ${k + 1} tick(s) into the dead ticks: played on to the respawn with idle ticks, alive at the checkpoint, the run's own state there`,
			dead && out.startsWith(pre) && pad.length >= 1 && pad.length <= 80 && /^0+$/.test(pad) && !s1.is_dead && cx === 2 && cy === 2 && s1.stateHash() === own.stateHash(),
			`dead ${dead}, +${pad.length} idle ticks (death ${D}, respawn after ${out.length - 1}), tile (${cx}, ${cy}), the same state as the run's: ${s1.stateHash() === own.stateHash()}`);
	}
	const live = run.slice(0, D - 3);
	check('a start that ends alive: unchanged (the same string)', BU.liveEnd(L, live) === live);
	const after = BU.liveEnd(L, run.slice(0, D + 1 + 55 + 20));
	check('a start past the respawn: unchanged', after === run.slice(0, D + 1 + 55 + 20), `length ${after.length}`);
	check('a non-string and an empty start: unchanged', BU.liveEnd(L, null) === null && BU.liveEnd(L, '') === '');
	// the knob: EEAT_DEADPFX=0 = main (the module reads it at load)
	const pre = run.slice(0, D + 11);
	const js = `const E=require(${JSON.stringify(require.resolve('../src/eesim.js'))}),EL=require(${JSON.stringify(require.resolve('../src/eelvl.js'))}),BU=require(${JSON.stringify(require.resolve('../src/bursts.js'))}),fs=require('fs');` +
		`const L=E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(${JSON.stringify(cor.file)}))));const p=${JSON.stringify(pre)};console.log(BU.liveEnd(L,p).length-p.length);`;
	const off = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8', env: Object.assign({}, process.env, { EEAT_DEADPFX: '0' }) });
	const on = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8', env: Object.assign({}, process.env, { EEAT_DEADPFX: '' }) });
	check('EEAT_DEADPFX=0: the start as given (main); unset: played on', String(off.stdout).trim() === '0' && +String(on.stdout).trim() > 0,
		`off +${String(off.stdout).trim()}${off.stderr ? ' ' + off.stderr.trim().split('\n').pop() : ''}, on +${String(on.stdout).trim()}`);
}

// the pit (test/deaths.js): the spawn and the checkpoint by the coin door; the coin at the bottom of a 2-wide shaft 7 rows
// deep (a jump climbs 4); the corridor's end is a spike: the death brings the ball back to the checkpoint with the coin
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

function sectionBursts() {
	section('bursts: goexplore.js --bursts=1 on the pit, a stand-in for eegpu explore with its prefix rule');
	const pit = levelFile('pit', PIT);
	const standin = path.join(HOME, 'explore_standin.js');
	// explorehost.h --prefix: the prefix's chars 48..79 played from the start; the ball dead at its end: exit 3
	fs.writeFileSync(standin, [
		"'use strict';",
		`const E = require(${JSON.stringify(require.resolve('../src/eesim.js'))}), EL = require(${JSON.stringify(require.resolve('../src/eelvl.js'))}), fs = require('fs');`,
		"const a = process.argv.slice(2);",
		"const pf = (a.find((x) => x.startsWith('--prefix=')) || '').slice(9);",
		"if (a[0] !== 'explore' || !pf) { console.log(JSON.stringify({ error: 'bad args ' + a.join(' ') })); process.exit(2); }",
		"const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(process.env.EEAT_TEST_LEVEL))));",
		"const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();",
		"const raw = fs.readFileSync(pf); let n = 0;",
		"for (const c of raw) { if (c < 48 || c >= 80) continue; n++; E.applyMask(inp, (c - 48) & 31); sim.tick(inp); }",
		"fs.appendFileSync(process.env.EEAT_TEST_LOG, JSON.stringify({ n, dead: sim.is_dead }) + '\\n');",
		"if (sim.is_dead) { console.log(JSON.stringify({ error: 'the prefix dies' })); process.exit(3); }",
		"console.log(JSON.stringify({ ev: 'ready', loadMs: 1 }));",
		"setTimeout(() => console.log(JSON.stringify({ ev: 'done', end: 'exhausted', layers: 1, states: 1 })), 20);",
	].join('\n'));
	const run = (knob, seed) => {
		const log = path.join(HOME, `starts_${knob}_${seed}.jsonl`);
		const env = Object.assign({}, process.env, { EEAT_TEST_LEVEL: pit.file, EEAT_TEST_LOG: log, EEAT_DEADPFX: knob });
		const r = spawnSync(process.execPath, [GOX, pit.file, '--workers=1', `--seed=${seed}`, '--cells=coarse', '--seconds=10', '--mem=300', '--bursts=1', `--tool=${standin}`,
			`--work=${path.join(HOME, `bursts_${knob}_${seed}`)}`], { encoding: 'utf8', env, maxBuffer: 1 << 28, timeout: 120000 });
		const ev = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
		const starts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
		const done = ev.find((e) => e.ev === 'done') || {};
		const g = done.gpu || {};
		const dies = ev.filter((e) => e.ev === 'warning' && /the prefix dies/.test(e.text || '')).length;
		return { starts, dead: starts.filter((s) => s.dead).length, dies, g, routes: ev.filter((e) => e.ev === 'result').length };
	};
	let deadOff = 0, pads = 0;
	for (const seed of [1, 2]) {
		const on = run('', seed), off = run('0', seed);
		deadOff += off.dead;
		pads += on.g.livePad || 0;
		check(`seed ${seed}: every burst start the stand-in gets ends alive, no burst fails "the prefix dies" (the fix)`, on.starts.length > 0 && on.dead === 0 && on.dies === 0 && on.g.failed === 0,
			`${on.starts.length} starts, ${on.dead} dead, ${on.dies} failures, ${on.g.bursts} bursts, livePad ${on.g.livePad}, ${on.routes} routes; EEAT_DEADPFX=0: ${off.starts.length} starts, ${off.dead} dead, ${off.dies} failures, ${off.g.bursts} bursts`);
	}
	check('the failure class on the product path: with EEAT_DEADPFX=0 some starts end dead (the cut in the dead ticks), and the fix played such starts on', deadOff > 0 && pads > 0,
		`dead starts without the fix ${deadOff}, starts played on with it ${pads}`);
}

sectionUnit();
sectionBursts();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
