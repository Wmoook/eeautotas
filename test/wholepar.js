'use strict';
// tools/perfect/wholepar.js (the whole-level proof in parallel, box 7 lane 'proof'): on toy rooms the C contours' first
// finish = an exhaustive search's optimum (exact.js from the same idle starts), with the per-worker tables and with the
// shared one (--shared=1), the found route replays at that many run ticks, the optimum given as a route is PROVEN, a slower
// U gives FASTER; the shared table's slots (a key entered at a layer prunes the same or a later layer only).
//   node test/wholepar.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const X = require('../src/plan/exact.js');
const WP = require('../tools/perfect/wholeproof.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const ID = { '#': [9], S: [255], G: [121], k: [6], d: [23] };
const ROOMS = {
	plain: ['############', '#..........#', '#..........#', '#S.....G...#', '############'],
	gated: ['##############', '#.....#......#', '#.....d......#', '#S.k..d..G...#', '##############'],
	ledge: ['############', '#......G...#', '#.....###..#', '#S.........#', '############'],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wholepar-'));
const TOOL = path.join(__dirname, '..', 'tools', 'perfect', 'wholepar.js');
const run = (args) => {
	const out = cp.execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
	const lines = out.trim().split('\n').map((l) => JSON.parse(l));
	return lines.find((l) => l.ev === 'result');
};
for (const [name, rows] of Object.entries(ROOMS)) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	const buf = ED.eelvlOf({ name: 't', width: rows[0].length, height: rows.length, cells });
	const file = path.join(dir, name + '.eelvl');
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	const starts = WP.idleStarts(L);
	const B = X.boundFor(L, { kind: 'trophy', tiles: [] });
	const goal = { kind: 'trophy', tiles: Int32Array.from(B.cells), test: (s) => !!s.has_silver_crown };
	const ex = X.solveExact(L, starts.map((s) => ({ snap: s.snap, tick: 0 })), goal, { B, cap: 2000000, deadline: Date.now() + 120000 });
	const ref = ex.depth - 1;
	for (const shared of ['0', '1']) {
		const tag = `${name} shared=${shared}`;
		const outEetas = path.join(dir, `${name}_${shared}.eetas`);
		const r = run([file, '--threads=2', '--seconds=60', '--split=2', `--shared=${shared}`, '--ttBits=18', `--out=${outEetas}`]);
		check(`${tag} the optimum = the exhaustive search's`, r.verdict === 'PROVEN' && r.opt === ref && r.optReplay === ref, `${r.verdict} ${r.opt} vs ${ref}`);
		// (the route written only when it is faster than a route given: none given here; write it ourselves from a U run)
		const r3 = run([file, '--threads=2', '--seconds=60', '--split=2', `--shared=${shared}`, '--ttBits=18', `--U=${ref + 1}`, `--out=${outEetas}`]);
		check(`${tag} a slower U gives FASTER, replayed`, r3.verdict === 'FASTER' && r3.opt === ref && fs.existsSync(outEetas), `${r3.verdict} ${r3.opt}`);
		if (fs.existsSync(outEetas)) {
			const ev = C.evaluate(L, C.readEetas(outEetas), false);
			check(`${tag} the written route replays`, !!ev && ev.runTicks === ref, ev ? ev.runTicks : 'no finish');
			const r2 = run([file, '--threads=2', '--seconds=60', '--split=2', `--shared=${shared}`, '--ttBits=18', `--route=${outEetas}`]);
			check(`${tag} the optimum as a route is PROVEN`, r2.verdict === 'PROVEN' && r2.lb === ref && r2.gap === 0, `${r2.verdict} lb ${r2.lb} gap ${r2.gap}`);
		}
	}
}
// the shared table's rule, single thread: a key entered at d prunes d and later, not earlier; another key is another slot
{
	const PW = require('../tools/perfect/wholepar.js');
	const sab = new SharedArrayBuffer(16 * 256);
	PW.clearShared(sab);
	const tt = PW.sharedTT(sab, 8);
	const k1 = 123456789012345, k2 = 123456789012345 + 4294967296 * 7;
	check('shared table: a new key is not seen', tt.seen(k1, 5) === false);
	check('shared table: the same key at a later layer is seen', tt.seen(k1, 6) === true);
	check('shared table: the same layer is seen', tt.seen(k1, 5) === true);
	check('shared table: an earlier layer is not seen (and takes it)', tt.seen(k1, 3) === false && tt.seen(k1, 4) === true);
	check('shared table: another key with the same low word is another entry', tt.seen(k2, 9) === false && tt.seen(k2, 9) === true);
	check('shared table: a key whose low word is 0', tt.seen(4294967296 * 3, 2) === false && tt.seen(4294967296 * 3, 2) === true);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${pass}/${fail}`);
process.exit(fail ? 1 : 0);
