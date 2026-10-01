'use strict';
// test/oneshotsolve.js - THE ONE SHOT (src/plan/oneshot/solve.js) and its thread (src/plan/oneshot/osworker.js, the
// compiler's MOVES stage's first tier with EEAT_ONESHOT=1) on a hand-made room:
//   1 the A* alone: a route from the level start, replayed by the engine (common.js evaluate) to the trophy; the ladder
//     past a route (EEAT_OS_REFINE_BEST, the default): the open list that ran out with the route goes on to the finer
//     steps, each closed with the route as its bound (closedLevel = the last step); firsts() = the arrivals' keys;
//   2 inject: a whole route handed in is the bound (best().kind 'inj', its ticks), not a route of its own;
//   3 the compile (src/compile.js as a child process): EEAT_ONESHOT=1 runs the one shot in its thread (report.oneshot
//     .thread, its ready time, no error) and routes; EEAT_OS_THREAD=0 the main-thread mode; unset: no oneshot in the
//     report (the knob off = the compiler without it).
// Usage: node test/oneshotsolve.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// a room: a floor at row 14, a 3-wide pit (cols 12-14, spikes at its bottom), a step up (cols 20-23) with a coin on it,
// the spawn at (2, 13), the trophy at (30, 13)
const W = 34, H = 18, F = 14;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if (x < 12 || x > 14) cells.push([x, F, 9]);
for (let x = 12; x <= 14; x++) cells.push([x, F + 2, 361]);
for (let x = 20; x <= 23; x++) cells.push([x, F - 1, 9]);
cells.push([21, F - 2, 100]);
cells.push([2, F - 1, 255]);
cells.push([30, F - 1, 121]);
const bytes = ED.eelvlOf({ name: 'oneshotsolve', width: W, height: H, cells });
const file = path.join(os.tmpdir(), `oneshotsolve_${process.pid}.eelvl`);
fs.writeFileSync(file, bytes);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(bytes)));

(async () => {
	// ---- 1 + 2: the A* alone
	const model = await require('../src/plan/model.js').compileModel(L, { file });
	const bounds = await require('../src/plan/bounds.js').createBounds(L, { model });
	const facts = require('../src/plan/facts.js').createFacts({ rungs: 4, model });
	const planner = require('../src/plan/planner.js').createPlanner(model, facts, { bounds, file, floorAsync: false });
	const OS = require('../src/plan/oneshot/solve.js');
	const s1 = OS.createOneShot(L, { model, planner, bounds });
	let r = null;
	const end = Date.now() + 20000;
	while (Date.now() < end) { r = s1.run(500); if (r.done) break; }
	ok(r && r.best, 'the one shot routes the room');
	if (r && r.best) {
		const ev = C.evaluate(L, r.best.masks);
		ok(!!ev, 'its route finishes on the engine\'s replay');
		ok(ev && ev.complete <= r.best.ticks, `its route's ticks (${ev && ev.complete}) = the A*'s g (${r.best.ticks})`);
		ok(r.done, 'the A* ran out (the ladder to its end)');
		ok(r.stats.closedLevel === OS.LADDER.length - 1, `the ladder past the route: closed at the last step (${r.stats.closedLevel} of ${OS.LADDER.length - 1})`);
		ok(r.closed, 'closed: optimal within the graph');
		ok(Array.isArray(s1.firsts()) && s1.firsts().every((x) => typeof x.key === 'string' && Number.isFinite(x.g)), 'firsts(): keys and ticks');
		// (2) a whole route handed in: the bound
		const s2 = OS.createOneShot(L, { model, planner, bounds });
		ok(s2.inject(r.best.masks, 'route'), 'inject a route');
		const b2 = s2.best();
		ok(b2 && b2.kind === 'inj' && b2.ticks === r.best.masks.length, 'a route handed in is the bound (kind inj)');
		const r2 = s2.run(5000);
		ok(!r2.best || r2.best.ticks <= r.best.masks.length, 'a bounded run finds nothing slower than its bound');
	}

	// ---- 3: the compile with the knob
	const compile = (env, extra) => {
		const out = path.join(os.tmpdir(), `oneshotsolve_${process.pid}_${extra}.json`);
		const e = Object.assign({}, process.env);
		delete e.EEAT_ONESHOT; delete e.EEAT_OS_THREAD;
		Object.assign(e, env);
		const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'compile.js'), file, '--seconds=8', '--workers=1', '--known=0', '--quiet', `--out=${out}.eetas`, `--report=${out}`], { env: e, encoding: 'utf8', timeout: 120000 });
		let rep = null;
		try { rep = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (x) { rep = null; }
		return { code: res.status, rep };
	};
	const a = compile({ EEAT_ONESHOT: '1' }, 'thread');
	ok(a.code === 0 && a.rep && a.rep.ok, `EEAT_ONESHOT=1: the compile routes (exit ${a.code})`);
	ok(a.rep && a.rep.oneshot && a.rep.oneshot.thread === true && Number.isFinite(a.rep.oneshot.readyMs) && !a.rep.oneshot.error, `EEAT_ONESHOT=1: the one shot in its thread (${JSON.stringify(a.rep && a.rep.oneshot && { thread: a.rep.oneshot.thread, readyMs: a.rep.oneshot.readyMs, error: a.rep.oneshot.error })})`);
	const b = compile({ EEAT_ONESHOT: '1', EEAT_OS_THREAD: '0' }, 'main');
	ok(b.code === 0 && b.rep && b.rep.oneshot && b.rep.oneshot.thread === false, 'EEAT_OS_THREAD=0: the main-thread mode');
	const c = compile({}, 'off');
	ok(c.code === 0 && c.rep && c.rep.ok && !('oneshot' in c.rep), 'the knob off: no one shot in the report');
	for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`oneshotsolve_${process.pid}`)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (x) { /* busy */ } }
	console.log(`oneshotsolve: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack || e.message); process.exit(1); });
