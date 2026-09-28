'use strict';
// skipfind.js (the skip finder), CPU only, on hand-made rooms (no jobs needed, ~20 s):
//   room 1: the run walks right, turns back left for a while (a misguided loop), then walks right into a block, pushes
//   against it, jumps over it and walks to the trophy.
//   - one start's search (searchStart) from the run's first ticks finds a faster run through the same block, replayed
//     (C.evaluate) and accepted (C.judge)
//   - the command line (2 workers) writes an accepted run at least 50 ticks faster, and its --done memory makes a second
//     call on the same run search nothing again
//   room 2: a climb the run misses: the run walks right past a 3-tile step, climbs stairs far to the right and walks back
//   left on the upper floor to a wall it hits (an exact state), then on to the trophy; the skip = the jump up the step
//   right at the start, joined back to the run exactly at that wall (a lead + a tail, or a rejoin in the search)
//   - found from the run's early states, at least 100 ticks faster, judged
// usage: node test/skipfind.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const SF = require('../src/skipfind.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-skipfind-'));
const mkLevel = (tag, W, H, cells) => {
	const json = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: tag, width: W, height: H, cells })));
	const f = path.join(TMP, `${tag}.json`);
	fs.writeFileSync(f, JSON.stringify(json));
	return { file: f, level: E.loadLevel(f) };
};
const runOf = (spec) => { const raw = []; for (const [m, n] of spec) for (let k = 0; k < n; k++) raw.push(m); return Uint8Array.from(raw); };
const small = { depth: 200, horizon: 600, cap: 20000, perS: 30, log2: 22 };

// ---------------------------------------------------------------- room 1: a loop, then a block
console.log('\n== room 1: a misguided loop before a block');
{
	const W = 40, H = 8, cells = room(W, H);
	cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [22, H - 2, 9]);
	const { file, level } = mkLevel('loop', W, H, cells);
	// right x40, left x60 (the loop), right x120 (into the block at x 22: pushing), right + jump x3, right to the trophy
	const ev = C.evaluate(level, runOf([[4, 40], [2, 60], [4, 120], [5, 3], [4, 300]]));
	check('the run finishes', !!ev, ev && `${ev.runTicks} run ticks`);
	const runFile = path.join(TMP, 'loop.eetas');
	C.writeEetas(runFile, ev.ms);
	const info = SF.prepare(level, ev.ms, { nocoins: 1 });
	const r = SF.searchStart(info, 10, 'fast', small);
	const v = r.best ? C.judge(C.evaluate(level, r.best.ms), ev, ev.deaths) : { accept: false, reason: 'no find' };
	check('one start (tick 10): a faster run through the block, replayed and accepted', v.accept && v.saved >= 50, v.accept ? `-${v.saved} (${r.best.how})` : v.reason);
	const out = path.join(TMP, 'loop_out.eetas'), done = path.join(TMP, 'loop_done.txt');
	const cli = (extra) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'skipfind.js'), `--tas=${runFile}`, `--level=${file}`, `--out=${out}`, '--workers=2',
		'--seconds=60', '--every=20', '--depth=200', '--horizon=600', '--cap=20000', '--perS=30', '--log2=22', `--done=${done}`, ...extra], { encoding: 'utf8' });
	const c1 = cli([]);
	const skips = (c1.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.ev === 'skip');
	const v1 = fs.existsSync(out) ? C.judge(C.evaluate(level, C.readEetas(out)), ev, ev.deaths) : { accept: false, reason: 'no output' };
	check('the command line: an accepted run at least 50 ticks faster', v1.accept && v1.saved >= 50, v1.accept ? `-${v1.saved} after ${skips.length} find(s)` : `${v1.reason}; ${(c1.stdout || '').slice(-400)} ${(c1.stderr || '').slice(-400)}`);
	const c2 = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'skipfind.js'), `--tas=${runFile}`, `--level=${file}`, `--out=${path.join(TMP, 'loop_out2.eetas')}`,
		'--workers=2', '--seconds=60', '--every=20', '--depth=200', '--horizon=600', '--cap=20000', '--perS=30', '--log2=22', `--done=${done}`], { encoding: 'utf8' });
	const st2 = (c2.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((e) => e.ev === 'start');
	const ran = (c2.stdout || '').split('\n').filter((l) => l.includes('"ev":"search"')).length;
	// (the first call's finds changed the run: its searched starts on the ORIGINAL run are the ones remembered, so a second
	// call on the original run has nothing left but the starts past the first call's deadline, if any)
	check('--done: a second call on the same run searches none of the starts the first one finished', st2 && st2.searched > 0 && ran <= Math.max(0, st2.tasks),
		st2 ? `${st2.searched} remembered, ${st2.tasks} left, ${ran} searched` : 'no start event');
}

// ---------------------------------------------------------------- room 2: the loop, the trophy far beyond the search
console.log('\n== room 2: the loop again, the trophy far beyond the search (the find must join the run)');
{
	const W = 160, H = 8, cells = room(W, H);
	cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [22, H - 2, 9]);
	const { level } = mkLevel('far', W, H, cells);
	const ev = C.evaluate(level, runOf([[4, 40], [2, 60], [4, 120], [5, 3], [4, 600]]));
	check('the run finishes', !!ev, ev && `${ev.runTicks} run ticks`);
	const info = SF.prepare(level, ev.ms, { nocoins: 1 });
	const r = SF.searchStart(info, 10, 'fast', Object.assign({}, small, { depth: 150 }));
	const v = r.best ? C.judge(C.evaluate(level, r.best.ms), ev, ev.deaths) : { accept: false, reason: 'no find' };
	check('the loop skipped and joined back to the run (a rejoin, a tail or a splice the replay accepts: not a finish), 50+ ticks', v.accept && v.saved >= 50 && !/^finish/.test(r.best.how),
		v.accept ? `-${v.saved} (${r.best.how})` : v.reason);
	// the join by the run's own inputs alone (tails from the leads): the search's own rejoins switched off by a minGain the
	// search cannot reach within its depth but the leads' tails can
	const lead = SF.searchStart(info, 10, 'fast', Object.assign({}, small, { depth: 60 }));
	const v2 = lead.best ? C.judge(C.evaluate(level, lead.best.ms), ev, ev.deaths) : { accept: false, reason: 'no find' };
	check('with a 60-tick search (the block beyond it): a lead joined by a tail, accepted', v2.accept && v2.saved >= 50 && /inputs from/.test(lead.best.how),
		v2.accept ? `-${v2.saved} (${lead.best.how})` : `${v2.reason} (hits ${lead.hits}, top ${JSON.stringify(lead.top)})`);
}

// ---------------------------------------------------------------- the jump skip is exact
// bfs skips a jump input where the same input without it leaves no jumps (jump_count >= max_jumps after the tick, no
// levitation, the timer on): the two states must be equal. Checked on every state of a jumpy random walk in both rooms'
// levels and on the jobs' runs when there (up to 20000 states each).
console.log('\n== the jump skip is exact');
{
	const levels = [];
	for (const f of fs.readdirSync(TMP).filter((x) => x.endsWith('.json'))) levels.push({ name: f, level: E.loadLevel(path.join(TMP, f)), ms: null });
	const JOBS = path.join(__dirname, '..', 'src', 'jobs');
	for (const id of ['autotas-egg-quest-ii-from-the-le-bb766a', 'expro-forgotten-veil-mustang-pwr-e6f51a', 'autotas-ex-crew-odyssey-from-the-1bb066']) {
		try { levels.push({ name: id, level: E.loadLevel(C.levelData(id)), ms: C.readEetas(path.join(JOBS, id, 'best.eetas')) }); } catch (e) { /* not on this machine */ }
	}
	let applied = 0, differ = 0;
	for (const L of levels) {
		const sim = new E.EESim(L.level), s2 = new E.EESim(L.level);
		sim.reset();
		const inp = new E.EEInput();
		let rnd = 12345;
		const next = () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return rnd; };
		const n = L.ms ? Math.min(L.ms.length, 20000) : 3000;
		for (let t = 0; t < n; t++) {
			const snap = sim.snapshot();
			for (const m of [0, 2, 4]) {
				s2.restore(snap); E.applyMask(inp, m); s2.tick(inp);
				if (!(s2.run_ticks !== 0 && !s2.has_levitation && s2.jump_count >= s2.max_jumps)) continue;
				const h = s2.stateHash();
				s2.restore(snap); E.applyMask(inp, m | 1); s2.tick(inp);
				applied++;
				if (s2.stateHash() !== h) differ++;
			}
			const m = L.ms ? L.ms[t] : [0, 1, 4, 5, 2, 3][next() % 6];
			E.applyMask(inp, m); sim.tick(inp);
			if (sim.is_dead || sim.has_silver_crown) sim.reset();
		}
	}
	check('where it applies, input + jump = input alone (stateHash)', applied > 1000 && differ === 0, `${applied} checked on ${levels.length} levels, ${differ} different`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* busy */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
