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
			// THE TASK LOG (--log / --resume): C = ref from lb ref - 1 logged; resumed from half of its tasks, and from all
			const log = path.join(dir, `${name}_${shared}.tasks.jsonl`);
			const base = [file, '--threads=2', '--seconds=60', '--split=2', `--shared=${shared}`, '--ttBits=18', `--route=${outEetas}`, `--from=${ref - 1}`];
			const r4 = run([...base, `--log=${log}`]);
			const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.C === ref);
			const nTasks = r4.Cs && r4.Cs[0] ? r4.Cs[0].tasks : -1;
			check(`${tag} the log holds every task of the closed C`, r4.verdict === 'PROVEN' && lines.length === nTasks && nTasks > 1, `${r4.verdict} ${lines.length} of ${nTasks}`);
			const half = path.join(dir, `${name}_${shared}.half.jsonl`);
			const keep = lines.slice(0, Math.floor(lines.length / 2));
			fs.writeFileSync(half, keep.map((o) => JSON.stringify(o)).join('\n') + '\n');
			const out5 = cp.execFileSync(process.execPath, [TOOL, ...base, `--resume=${half}`], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').map((l) => JSON.parse(l));
			const rs = out5.find((l) => l.ev === 'resume'), r5 = out5.find((l) => l.ev === 'result');
			check(`${tag} resumed from half the tasks: the same verdict`, !!rs && rs.skipped === keep.length && r5.verdict === 'PROVEN' && r5.lb === ref && r5.Cs[0].resumed === keep.length, `${rs ? rs.skipped : '-'} skipped, ${r5.verdict} lb ${r5.lb}`);
			const r6 = run([...base, `--resume=${log}`]);
			check(`${tag} resumed from every task: closed with no search`, r6.verdict === 'PROVEN' && r6.Cs[0].resumed === nTasks, `${r6.verdict} resumed ${r6.Cs[0].resumed}`);
			// (a log line cut by a kill is skipped)
			fs.appendFileSync(half, '{"ev":"task","C":');
			const r7 = run([...base, `--resume=${half}`]);
			check(`${tag} a cut last line is ignored`, r7.verdict === 'PROVEN' && r7.Cs[0].resumed === keep.length, `${r7.verdict} ${r7.Cs[0].resumed}`);
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
