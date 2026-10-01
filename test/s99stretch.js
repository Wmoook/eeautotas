'use strict';
// test/s99stretch.js - the stretch solver in its own process (src/plan/lab/stretch_child.js, strategy.js EEAT_STRETCH=1):
//   1 the run-up room (test/labbackward.js 1) with the trophy past the gap: a request for the trophy from the level start
//     gives an 'arrival' that finishes on its replay (C.evaluate) and a 'done' ok;
//   2 a request on a clock too short for it: 'done' not ok, with the solve's partial progress ('closest') when it has one:
//     inputs from the level start that replay alive;
//   3 two requests on one child: the second answered too (the child keeps its solver across requests);
//   4 a trigger leg (a coin by the start): the arrival's replay meets the waypoint's goal test (T.goalOf).
// Usage: node test/s99stretch.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const T = require('../src/plan/types.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

const W = 64, H = 20, F = 16;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if (x <= 30 || x >= 44) cells.push([x, F, 9]); else cells.push([x, H - 2, 361]);
cells.push([30, 15, 255]);
cells.push([48, 15, 121]);   // the trophy past the gap
cells.push([27, 15, 100]);   // a coin behind the start
const buf = ED.eelvlOf({ name: 's99-stretch', width: W, height: H, cells });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's99stretch-'));
const file = path.join(dir, 'room.eelvl');
fs.writeFileSync(file, buf);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));

const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'plan', 'lab', 'stretch_child.js'), file], { stdio: ['pipe', 'pipe', 'inherit'] });
const msgs = [];
let bufOut = '';
const waiters = [];
child.stdout.on('data', (d) => {
	bufOut += d;
	let k;
	while ((k = bufOut.indexOf('\n')) >= 0) {
		const line = bufOut.slice(0, k); bufOut = bufOut.slice(k + 1);
		let m = null;
		try { m = JSON.parse(line); } catch (e) { continue; }
		msgs.push(m);
		for (const w of waiters.slice()) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
	}
});
const waitFor = (test, ms = 60000) => new Promise((res, rej) => {
	const hit = msgs.find(test);
	if (hit) return res(hit);
	const t = setTimeout(() => rej(new Error('timeout')), ms);
	waiters.push({ test, res: (m) => { clearTimeout(t); res(m); } });
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

(async () => {
	try {
		await waitFor((m) => m.ev === 'ready');
		ok(true, 'ready');
		// 1 the trophy from the start
		send({ id: 1, from: '', legs: [{ wp: { kind: 'trophy' }, w: 1 }], ms: 20000, closest: true });
		const d1 = await waitFor((m) => m.ev === 'done' && m.id === 1);
		const a1 = msgs.find((m) => m.ev === 'arrival' && m.id === 1);
		ok(d1.ok === true && d1.k === 1, `1: done ok (${JSON.stringify(d1)})`);
		const ev = a1 ? C.evaluate(L, T.masksOf(a1.inputs)) : null;
		ok(!!ev && ev.deaths === 0, `1: the arrival finishes on its replay (${ev ? ev.runTicks : 'none'})`);
		// 2 a clock too short: not ok; a closest, when given, replays alive
		send({ id: 2, from: '', legs: [{ wp: { kind: 'trophy' }, w: 1 }], ms: 30, closest: true });
		const d2 = await waitFor((m) => m.ev === 'done' && m.id === 2);
		ok(d2.ok === false, `2: a 30-ms clock is not enough (${JSON.stringify(d2).slice(0, 120)})`);
		if (d2.closest) {
			const r = T.playTo(L, T.masksOf(d2.closest.inputs), { allowDeath: true });
			ok(!r.sim.is_dead, '2: the closest replays alive');
		} else ok(true, '2: no closest (the clock ran out before a meet)');
		// 3 and 4: a second request on the same child, a trigger leg: the coin behind the start
		const coinT = 15 * W + 27;
		const wp = { kind: 'trigger', tiles: [coinT], expect: { feat: 'coins', value: 1 } };
		send({ id: 3, from: '', legs: [{ wp, w: 1 }], ms: 20000, closest: true });
		const d3 = await waitFor((m) => m.ev === 'done' && m.id === 3);
		const a3 = msgs.find((m) => m.ev === 'arrival' && m.id === 3);
		ok(d3.ok === true && !!a3, `3: the second request answered (${JSON.stringify(d3).slice(0, 120)})`);
		if (a3) {
			const goal = T.goalOf(L, wp);
			const r = T.playTo(L, T.masksOf(a3.inputs), { allowDeath: false });
			ok(!r.sim.is_dead && goal.test(r.sim), '4: the arrival meets the coin\'s goal test at its end');
		}
	} catch (e) { fail++; console.log('FAIL', e.message); }
	child.kill('SIGKILL');
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
	console.log(`s99stretch: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
