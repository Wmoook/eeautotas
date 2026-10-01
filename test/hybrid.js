'use strict';
// test/hybrid.js - THE HYBRID LEG (src/plan/hybrid.js, strategy.js EEAT_HYBRID=1; goexplore.js --goalTiles):
//   1 goexplore.js --goalTiles on a room (the trophy right of the start, a coin behind it on the left), from a prefix:
//     'goal' events whose inputs begin with the prefix and whose replay touches the coin's tile (T.goalOf); without the
//     option no 'goal' event;
//   2 createHybrid on a stand-in compiler (ctx): a failed step (rung 2, 'budget') to the coin from the anchor at the prefix's end becomes a
//     request, the search's answer is verified by the ctx (the waypoint's own goal test from the level start), the leg's
//     arrival added once, the child stopped ('done' ok); a step that succeeded or a death step is no candidate.
// Usage: node test/hybrid.js   (CPU only: EEAT_HY_GPU=0)
process.env.EEAT_HY_GPU = '0';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const T = require('../src/plan/types.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

const W = 64, H = 20, F = 16;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) cells.push([x, F, 9]);
cells.push([30, 15, 255]);   // the spawn
cells.push([48, 15, 121]);   // the trophy
cells.push([12, 15, 100]);   // a coin behind the start
const buf = ED.eelvlOf({ name: 'hybrid', width: W, height: H, cells });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-test-'));
const file = path.join(dir, 'room.eelvl');
fs.writeFileSync(file, buf);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
const coin = 15 * W + 12;
const prefix = new Uint8Array(12);   // (12 idle ticks: the search starts after them)
const preFile = path.join(dir, 'pre.eetas');
fs.writeFileSync(preFile, Buffer.from(T.strOf(prefix), 'latin1'));
const gx = (extra) => new Promise((res) => {
	const out = [];
	const ch = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), file, `--prefix=${preFile}`, '--seconds=8', '--workers=1', '--seed=3', '--cells=coarse', '--rooms=1', ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
	let b = '';
	ch.stdout.on('data', (d) => { b += d; let k; while ((k = b.indexOf('\n')) >= 0) { const l = b.slice(0, k); b = b.slice(k + 1); try { out.push(JSON.parse(l)); } catch (e) { /* not an event */ } } });
	ch.on('close', () => res(out));
});

(async () => {
	// 1 the goal events
	const ev = await gx([`--goalTiles=${coin}`]);
	const goals = ev.filter((e) => e.ev === 'goal');
	ok(goals.length > 0, `goexplore --goalTiles: no 'goal' event (${ev.map((e) => e.ev).join(',').slice(0, 200)})`);
	const goal = T.goalOf(L, { kind: 'trigger', tiles: [coin], expect: null, label: 'coin' });
	let good = 0;
	for (const g of goals) {
		const ms = T.masksOf(g.inputs);
		if (!g.inputs.startsWith(T.strOf(prefix))) continue;
		const ext = new Uint8Array(ms.length + 3); ext.set(ms); ext.fill(ms[ms.length - 1], ms.length);
		const r = T.playTo(L, ext, { goal });
		if (r.goalAt > prefix.length && r.goalAt <= ext.length) good++;
	}
	ok(goals.length > 0 && good === goals.length, `the goal events' inputs: ${good} of ${goals.length} begin with the prefix and touch the coin`);
	const ev0 = await gx([]);
	ok(!ev0.some((e) => e.ev === 'goal'), 'no --goalTiles: no goal event');
	ok(ev0.some((e) => e.ev === 'done'), 'no --goalTiles: the search ends');

	// 2 the bridge on a stand-in compiler
	const HYB = require('../src/plan/hybrid.js');
	const r0 = T.playTo(L, prefix);
	const a0 = Object.assign(T.arrivalOf(L, r0.sim, prefix, null), { run: 0, leg: null });
	const A = { id: 1, key: 'k0', gain: 0, arrivals: [a0], exhausted: false };
	const wp = { kind: 'trigger', tiles: [coin], expect: { feat: 'coins', value: 1 }, label: 'coin (12,15)' };
	const step = { edge: 'trig:coin', nodeClass: 'c0', rung: 2, waypoint: wp, estTicks: 100 };
	const added = [], says = [];
	let verifiedCalls = 0;
	const ctx = {
		L, T, E, file, say: (e) => says.push(e), left: () => 30000, hasRoute: () => false, stopped: () => false, depth: () => Infinity,
		verified: (st, w, res, starts) => {
			verifiedCalls++;
			const g = T.goalOf(L, w), arr = [];
			for (const x of res.arrivals) { const r = T.playTo(L, x.masks, { goal: g }); if (r.goalAt === x.masks.length && !r.sim.is_dead) arr.push(Object.assign(T.arrivalOf(L, r.sim, x.masks, null), { run: r.sim.run_ticks })); }
			return { arr, routes: [] };
		},
		routeOf: () => null, addArrival: (a) => { added.push(a); return { anchor: { id: 2, key: 'k1' }, isNew: true }; }, stateOf: () => ({ key: 'k1' }), simOf: (a) => T.playTo(L, a.masks).sim,
		importRun: () => null, labelOf: (s) => s.waypoint.label, edgeKey: (s) => `${s.edge}|${s.nodeClass}`, RM: null, gate: false, anchorsN: () => 1,
	};
	const hy = HYB.createHybrid(ctx);
	hy.note(A, Object.assign({}, step, { edge: 'trig:other' }), wp, { cost: 50 }, true, '');
	hy.note(A, Object.assign({}, step, { edge: 'die' }), Object.assign({}, wp, { allowDeath: true }), { cost: 50 }, false, 'budget');
	hy.schedule();
	ok(!hy.busy(), 'a solved step and a death step: no request');
	hy.note(A, step, wp, { cost: 100 }, false, 'budget');
	hy.schedule();
	ok(hy.busy(), 'a failed step at rung 2: a request');
	const t0 = Date.now();
	while (hy.busy() && Date.now() - t0 < 40000) { await new Promise((r) => setTimeout(r, 200)); hy.harvest(); }
	ok(!hy.busy(), 'the request ended');
	ok(added.length === 1, `the leg's arrival added once (${added.length})`);
	if (added.length) {
		const a = added[0];
		const r = T.playTo(L, a.masks, { goal: T.goalOf(L, wp) });
		ok(r.goalAt === a.masks.length && T.strOf(a.masks).startsWith(T.strOf(prefix)), 'the arrival: the anchor\'s inputs + the leg, the coin taken at its last tick');
	}
	ok(says.some((e) => e.ev === 'hybrid' && e.what === 'leg') && says.some((e) => e.ev === 'hybrid' && e.what === 'done' && e.ok), 'the events: leg, done ok');
	ok(hy.stats.requests === 1 && hy.stats.legs === 1 && verifiedCalls >= 1, `the stats ${JSON.stringify(hy.stats)}`);
	hy.schedule();
	ok(!hy.busy(), 'the solved leg: no second request');
	hy.stop();

	// 3 THE GATE: the leg's arrival held until the executor fails that leg again (then given), dropped when it solves it
	for (const solveIt of [false, true]) {
		added.length = 0;
		const hg = HYB.createHybrid(Object.assign({}, ctx, { gate: true }));
		hg.note(A, step, wp, { cost: 100 }, false, 'budget');
		hg.schedule();
		const t1 = Date.now();
		while (hg.busy() && Date.now() - t1 < 40000) { await new Promise((r) => setTimeout(r, 200)); hg.harvest(); }
		ok(added.length === 0 && hg.held() >= 1, `the gate: the leg held (${hg.held()} held, ${added.length} added)`);
		const nh = hg.held();
		hg.note(A, step, wp, { cost: 100 }, solveIt, solveIt ? '' : 'budget');
		ok(hg.held() === 0 && added.length === (solveIt ? 0 : nh), `the executor ${solveIt ? 'solved' : 'failed'} it: ${solveIt ? 'dropped' : 'given'} (${added.length} added)`);
		hg.stop();
	}
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
	console.log(`hybrid: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
