'use strict';
// test/bwchain.js - the level as a chain of backward legs (src/plan/lab/bwchain.js, n5-s99-gated) on a hand-made GATED room:
// the trophy behind a 1-coin door, the coin the other way from the spawn (the backward solver alone: 'the start is not in the
// target's walk'); the chain: the coin, then the trophy, the route replayed from the level by the engine (C.evaluate);
// the child process (bwchain_child.js) prints the chain's anchors and the finish; a room whose trophy needs no trigger
// goes the whole-level way (mode 'one').
// Usage: node test/bwchain.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const BW = require('../src/plan/lab/backward.js');
const BC = require('../src/plan/lab/bwchain.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const roomCells = (W, H, gated) => {
	const cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); cells.push([x, H - 2, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	cells.push([16, H - 3, 255]);            // the spawn
	cells.push([3, H - 3, 100]);             // the coin, the other way
	if (gated) for (let y = 1; y < H - 2; y++) cells.push([26, y, 43, 1]);   // a 1-coin door column before the trophy
	cells.push([32, H - 3, 121]);            // the trophy
	return cells;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwchain-'));
const fileOf = (name, W, H, cells) => { const f = path.join(tmp, name + '.eelvl'); fs.writeFileSync(f, ED.eelvlOf({ name, width: W, height: H, cells })); return f; };
const levelOfFile = (f) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(f))));

(async () => {
	const W = 40, H = 10;
	const fg = fileOf('bwc-gated', W, H, roomCells(W, H, true));
	const L = levelOfFile(fg);
	// 1 gated: the backward solver alone ends at once
	{
		const s = new E.EESim(L); s.reset();
		const tr = []; for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) tr.push(i);
		const r = BW.createBackward(L).solve(s.snapshot(), { tiles: tr }, { ms: 2000 });
		ok(!r.ok && /walk/.test(r.why || ''), `the trophy is gated for the backward solver alone (${r.why})`);
	}
	// 2 the chain: the coin, then the trophy
	{
		const anchors = [];
		const r = BC.chainLevel(L, { ms: 30000, onAnchor: (m, info) => anchors.push(info) });
		ok(r.ok, `the chain finishes the gated room (${r.why}; legs ${r.stats.legsOk}/${r.stats.legs})`);
		if (r.ok) {
			const ev = C.evaluate(L, r.masks, false);
			ok(!!ev && ev.runTicks === r.runTicks, `the route replays from the level (${ev && ev.runTicks} vs ${r.runTicks})`);
			const okLegs = r.legs.filter((x) => x.ok).map((x) => x.label);
			ok(/coin/.test(okLegs[0] || '') && /trophy/.test(okLegs[okLegs.length - 1] || ''), `the legs: the coin first, the trophy last (${okLegs.join(' -> ')})`);
			ok(anchors.length >= 1 && anchors[0].gain >= 1, `an anchor for the coin state (gain ${anchors[0] && anchors[0].gain})`);
		}
	}
	// 3 the child process: anchors and the finish, mode 'chain'; a free room: mode 'one'
	const runChild = (f) => new Promise((resolve) => {
		const ch = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'plan', 'lab', 'bwchain_child.js'), f, '--ms=30000'], { stdio: ['ignore', 'pipe', 'ignore'] });
		let buf = '';
		ch.stdout.on('data', (d) => { buf += d; });
		ch.on('close', () => resolve(buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)));
	});
	{
		const evs = await runChild(fg);
		const done = evs.find((e) => e.ev === 'done'), res = evs.find((e) => e.ev === 'result');
		ok(done && done.end === 'finish' && done.mode === 'chain', `the child on the gated room: ${done && done.end} / ${done && done.mode}`);
		ok(evs.some((e) => e.ev === 'anchor' && typeof e.inputs === 'string'), 'the child prints an anchor');
		ok(res && C.evaluate(L, Uint8Array.from(res.inputs, (c) => c.charCodeAt(0) - 48), false), 'the child\'s route replays');
	}
	{
		const ff = fileOf('bwc-free', W, H, roomCells(W, H, false));
		const evs = await runChild(ff);
		const done = evs.find((e) => e.ev === 'done');
		ok(done && done.end === 'finish' && done.mode !== 'chain', `the child on a free room finishes by the whole-level solve (${done && done.end} / '${done && done.mode}')`);
	}
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left */ }
	console.log(`bwchain: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
