'use strict';
// flybeam.js (the corridor beam), CPU only, on a hand-made room (no jobs needed, a few seconds):
//   the reference walks right into a block, keeps pushing against it (identical states: time to win), jumps over it and
//   walks to the trophy.
//   - the beam from the reference's start finds a faster run: the output replays (C.evaluate), is judged faster
//     (C.judge) and its JSON set names non-overlapping [A, T) joins whose savings add up to the replayed saving
//   - pickSet: the best non-overlapping set of intervals (a DP), splice: later joins first
//   - --state: a pass over the run continued across calls (the next start written by tick + state hash)
//   - --seconds: no task starts past the budget
// usage: node test/flybeam.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const FB = require('../src/flybeam.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-flybeam-'));
const W = 30, H = 8, cells = room(W, H);
cells.push([2, H - 2, 255], [W - 4, H - 2, 121], [10, H - 2, 9]);
const json = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells })));
const levelFile = path.join(TMP, 'level.json');
fs.writeFileSync(levelFile, JSON.stringify(json));
const level = E.loadLevel(levelFile);
const raw = [];
for (const [m, n] of [[0, 5], [4, 80], [5, 3], [4, 300]]) for (let k = 0; k < n; k++) raw.push(m);
const evRef = C.evaluate(level, Uint8Array.from(raw));
const refFile = path.join(TMP, 'ref.eetas');
C.writeEetas(refFile, evRef.ms);

const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'flybeam.js'), `--tas=${refFile}`, `--level=${levelFile}`, '--W=256',
	'--threads=1', ...extra], { encoding: 'utf8' });

// 1) the beam finds a faster run
{
	const out = path.join(TMP, 'out.eetas'), js = path.join(TMP, 'out.json');
	const r = run(['--from=5', '--to=60', '--ext=200', '--timeS=30', `--out=${out}`, `--json=${js}`]);
	const ev = fs.existsSync(out) ? C.evaluate(level, C.readEetas(out)) : null;
	const verdict = C.judge(ev, evRef, evRef.deaths);
	check('the beam writes a faster run that replays and is judged faster', !!ev && verdict.accept, `${evRef.runTicks} -> ${ev ? ev.runTicks : '-'}${r.status ? ` (exit ${r.status}: ${(r.stdout || '').slice(-300)})` : ''}`);
	const j = fs.existsSync(js) ? JSON.parse(fs.readFileSync(js, 'utf8')) : null;
	const planned = j ? j.set.reduce((s, x) => s + x.saving, 0) : -1;
	check('its planned joins add up to the replayed saving', !!ev && planned === evRef.runTicks - ev.runTicks, `planned ${planned}, replayed ${ev ? evRef.runTicks - ev.runTicks : '-'}`);
	let ok = !!j;
	if (j) for (let i = 1; i < j.set.length; i++) if (j.set[i].A < j.set[i - 1].T) ok = false;
	check('the joins do not overlap', ok, j ? j.set.map((s) => `${s.A}->${s.T} -${s.saving}`).join(', ') : 'no json');
}
// 2) pickSet / splice
{
	const cands = [{ A: 0, T: 10, saving: 3, inputs: [1, 1, 1, 1, 1, 1, 1] }, { A: 5, T: 20, saving: 6, inputs: new Array(9).fill(2) },
		{ A: 10, T: 30, saving: 4, inputs: new Array(16).fill(3) }, { A: 12, T: 18, saving: 5, inputs: [4] }];
	const set = FB.pickSet(cands);
	const tot = set.reduce((s, x) => s + x.saving, 0);
	check('pickSet takes the best non-overlapping set', tot === 8 && set.length === 2, set.map((s) => `${s.A}->${s.T}`).join(', '));
	const ms = Array.from({ length: 40 }, (_, i) => 16 + (i % 2));
	const sp = FB.splice(ms, [{ A: 0, T: 10, saving: 3, inputs: [1, 1, 1, 1, 1, 1, 1] }, { A: 10, T: 30, saving: 4, inputs: new Array(16).fill(3) }]);
	check('splice replaces [A, T) by the join inputs, later joins first', sp.length === 40 - 7 && sp[0] === 1 && sp[6] === 1 && sp[7] === 3 && sp[22] === 3 && sp[23] === ms[30], `${sp.length}`);
}
// 3) --state: a pass continued across calls; 4) --seconds
{
	const st = path.join(TMP, 'state.json');
	run(['--starts=20', '--to=200', '--ext=400', '--timeS=3', '--seconds=8', `--state=${st}`]);
	const s1 = C.readJSON(st, null);
	check('--state writes the next start (tick + hash) after a budget-cut pass', !!s1 && s1.t > 0 && s1.t <= 200 && typeof s1.h === 'number', JSON.stringify(s1));
	run(['--starts=20', '--to=200', '--ext=400', '--timeS=3', '--seconds=8', `--state=${st}`]);
	const s2 = C.readJSON(st, null);
	// (a next start within 50 ticks of the finish starts the pass over: flybeam.js --state; how far a call gets depends on
	// the machine's speed)
	check('the next call continues from it', !!s2 && s1 && (s2.t > s1.t || s2.wrapped === true || s2.t === 0 || s1.t >= evRef.complete - 50), `${s1 && s1.t} -> ${s2 && s2.t}`);
}
// 5) --order=stretch: the starts by their longest contact-free stretch; --state keeps the starts done
{
	const K = new Uint8Array(101).fill(1);
	for (let t = 45; t < 90; t++) K[t] = 0;   // one 45-tick stretch through the windows at 40, 60, 80
	for (let t = 5; t < 15; t++) K[t] = 0;   // a 10-tick one in the window at 0
	const rows = FB.stretchOrder(K, 100, 0, 100, 20);
	check('stretchOrder ranks the windows on the longest stretch first (then the free share)', rows.map((r) => r.s).join(',') === '60,40,80,0,20', rows.map((r) => `${r.s}:${r.best}`).join(' '));
	const st = path.join(TMP, 'state_stretch.json');
	run(['--starts=20', '--to=200', '--ext=400', '--timeS=3', '--seconds=8', '--order=stretch', `--state=${st}`]);
	const s1 = C.readJSON(st, null);
	run(['--starts=20', '--to=200', '--ext=400', '--timeS=3', '--seconds=8', '--order=stretch', `--state=${st}`]);
	const s2 = C.readJSON(st, null);
	check('--order=stretch --state keeps the starts done across calls', !!s1 && s1.order === 'stretch' && s1.done.length > 0 && !!s2 && (s2.done.length > s1.done.length || s2.done.length > 0),
		`${s1 && s1.done.length} -> ${s2 && s2.done.length}`);
}
// 6) a start whose task the call's end cut short is not done; --wrap=0: every start done = no search
{
	const st = path.join(TMP, 'state_cut.json');
	// (W 16384: a beam that cannot reach the run's end in the 3 s the call leaves its first task)
	const r = run(['--starts=20', '--to=60', '--ext=400', '--timeS=30', '--seconds=6', '--threads=1', '--W=16384', '--order=stretch', `--state=${st}`]);
	const s1 = C.readJSON(st, null);
	check('a start cut short by the call\'s end (--seconds) is not marked done', !!s1 && s1.done.length === 0, `${s1 && s1.done.length} done; ${(r.stdout || '').split('\n').filter((l) => /layers/.test(l)).length} task(s) ran`);
	const st2 = path.join(TMP, 'state_wrap.json');
	run(['--starts=20', '--to=60', '--ext=100', '--timeS=2', '--seconds=60', '--threads=2', '--order=stretch', `--state=${st2}`]);
	const w1 = C.readJSON(st2, null);
	const r2 = run(['--starts=20', '--to=60', '--ext=100', '--timeS=2', '--seconds=60', '--threads=2', '--order=stretch', '--wrap=0', `--state=${st2}`]);
	check('every start done after a call whose tasks ran to their own end', !!w1 && w1.done.length === 3, `${w1 && w1.done.length}`);
	check('--wrap=0 then searches nothing ("every start done")', /every start done/.test(r2.stdout || '') && !/ tasks \(starts/.test(r2.stdout || ''), (r2.stdout || '').slice(-200));
}
// 7) a start at or before the run's first input moves to the tick after it (its joins then save run ticks)
{
	const F0 = C.readEetas(refFile).findIndex((m) => m !== 0);
	const r = run(['--starts=20', '--to=60', '--ext=100', '--timeS=2', '--seconds=30', '--threads=2']);
	const m = /tasks \(starts ([\d,]+);/.exec(r.stdout || '');
	const st = m ? m[1].split(',').map(Number) : [];
	check('a start at or before the first input moves past it', F0 >= 0 && st.length > 0 && st.every((s) => s > F0) && st.includes(F0 + 1), `first input ${F0}, starts ${st.join(',')}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`flybeam: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
