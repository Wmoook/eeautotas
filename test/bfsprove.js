'use strict';
// tools/perfect/bfsprove.js (the breadth-first prover on worker threads, box 7 lane 'proof' cycle 6): on toy rooms the first
// finish = an exhaustive search's optimum (exact.js from the same idle starts) with the work on the main thread and on the
// workers (--initPer=1), the route replays at that many run ticks, a slower U gives FASTER (written), the optimum as a route
// is PROVEN (C = U closes), C = the optimum with no route is CLOSED at lb = the optimum, C above (2 ticks) still finds it; the
// shared table's rule (a new key is new once, then seen).
//   node test/bfsprove.js
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
const BP = require('../tools/perfect/bfsprove.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const ID = { '#': [9], S: [255], G: [121], k: [6], d: [23] };
const ROOMS = {
	plain: ['############', '#..........#', '#..........#', '#S.....G...#', '############'],
	gated: ['##############', '#.....#......#', '#.....d......#', '#S.k..d..G...#', '##############'],
	ledge: ['############', '#......G...#', '#.....###..#', '#S.........#', '############'],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfsprove-'));
const TOOL = path.join(__dirname, '..', 'tools', 'perfect', 'bfsprove.js');
const run = (args) => {
	const out = cp.execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
	return out.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.ev === 'result');
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
	for (const initPer of ['1', '100000']) {
		const tag = `${name} initPer=${initPer}`;
		const base = [file, '--threads=2', '--seconds=60', '--ttBits=18', `--initPer=${initPer}`];
		const r1 = run([...base, `--C=${ref + 1}`]);
		check(`${tag} the optimum = the exhaustive search's`, r1.verdict === 'PROVEN' && r1.opt === ref && r1.optReplay === ref, `${r1.verdict} ${r1.opt} vs ${ref}`);
		const r1b = run([...base, `--C=${ref + 2}`, "--ttBits=22"]);
		check(`${tag} C far above: the same optimum`, r1b.opt === ref && r1b.optReplay === ref, `${r1b.verdict} ${r1b.opt}`);
		const outEetas = path.join(dir, `${name}_${initPer}.eetas`);
		const r3 = run([...base, `--U=${ref + 1}`, `--C=${ref + 1}`, `--out=${outEetas}`]);
		check(`${tag} a slower U gives FASTER, written`, r3.verdict === 'FASTER' && r3.opt === ref && fs.existsSync(outEetas), `${r3.verdict} ${r3.opt}`);
		if (fs.existsSync(outEetas)) {
			const ev = C.evaluate(L, C.readEetas(outEetas), false);
			check(`${tag} the written route replays`, !!ev && ev.runTicks === ref, ev ? ev.runTicks : 'no finish');
			const r2 = run([...base, `--route=${outEetas}`]);
			check(`${tag} the optimum as a route is PROVEN (C = U closes)`, r2.verdict === 'PROVEN' && r2.lb === ref && r2.gap === 0 && r2.opt === undefined, `${r2.verdict} lb ${r2.lb} gap ${r2.gap}`);
		}
		const r4 = run([...base, `--C=${ref}`]);
		check(`${tag} C = the optimum, no route: CLOSED at lb = the optimum`, r4.verdict === 'CLOSED' && r4.lb === ref, `${r4.verdict} lb ${r4.lb}`);
	}
	// THE RE-ROOTING forced after every layer (the fronts dealt out again as paths, rebuilt and checked by their hashes):
	// the same optimum, its route replayed, the same closed C
	{
		const forced = [file, '--threads=3', '--seconds=60', '--ttBits=22', '--initPer=1', '--rebalance=0.5', '--rebalanceMin=1'];
		const r5 = run([...forced, `--C=${ref + 1}`]);
		check(`${name} re-rooted every layer: the optimum = the exhaustive search's`, r5.verdict === 'PROVEN' && r5.opt === ref && r5.optReplay === ref && r5.rebalances > 0, `${r5.verdict} ${r5.opt} vs ${ref}, ${r5.rebalances} re-rootings`);
		const r6 = run([...forced, `--C=${ref}`]);
		check(`${name} re-rooted every layer: C = the optimum CLOSED`, r6.verdict === 'CLOSED' && r6.lb === ref && r6.rebalances > 0, `${r6.verdict} lb ${r6.lb}, ${r6.rebalances} re-rootings`);
	}
}
{
	const sab = new SharedArrayBuffer(8 * 256);
	const ins = BP.seenTable(sab);
	const k1 = 123456789012345, k2 = 123456789012345 + 4294967296 * 7, k3 = 4294967296 * 5;
	check('seen table: a new key is new', ins(k1) === true);
	check('seen table: the same key is seen', ins(k1) === false);
	check('seen table: the same low word, another high word: new', ins(k2) === true && ins(k2) === false);
	check('seen table: a low word 0 is stored', ins(k3) === true && ins(k3) === false);
	// THE SHARDS: 4 tables, 20,000 keys inserted twice: each new once, then seen; two inserters on the same shards agree
	const sh = [0, 1, 2, 3].map(() => new SharedArrayBuffer(8 * 16384));
	const insA = BP.seenTable(sh), insB = BP.seenTable(sh);
	let okNew = 0, okSeen = 0;
	const keys = Array.from({ length: 20000 }, (_, i) => (i * 2654435761 + 977) * 4099 % 9007199254740881);
	for (const k of keys) if (insA(k) === true) okNew++;
	for (const k of keys) if (insB(k) === false) okSeen++;
	const used = sh.map((b) => { const K = new Int32Array(b); let n = 0; for (let i = 0; i < K.length; i += 2) if (K[i] !== 0) n++; return n; });
	check('seen table, 4 shards: 20,000 keys new once, then seen through another inserter', okNew === 20000 && okSeen === 20000, `${okNew} / ${okSeen}`);
	check('seen table, 4 shards: every shard used', used.every((n) => n > 3000) && used.reduce((a, b) => a + b, 0) === 20000, used.join(','));
}
// the packed front: every field read back exactly (-0, NaN, booleans, null, undefined, references), whatever the base
{
	const base = new E.EESnapshot(), a = new E.EESnapshot(), b = new E.EESnapshot(), out = new E.EESnapshot();
	const F = BP.FIELDS;
	F.forEach((k, i) => { base[k] = i; a[k] = i; b[k] = i; });
	const map = new Map([[3, true]]);
	a[F[0]] = -0; a[F[1]] = NaN; a[F[2]] = true; a[F[3]] = false; a[F[4]] = null; a[F[5]] = undefined; a[F[6]] = map; a[F[7]] = 1.5e-300;
	b[F[0]] = 0.1 + 0.2;
	const st = BP.makeStore();
	for (let r = 0; r < 3000; r++) { st.push(a, base, 11); st.push(b, base, 22); }
	let ok = true;
	for (const i of [0, 1, 4000, 5999]) {
		const src = i % 2 ? b : a, h = st.get(i, base, out);
		if (h !== (i % 2 ? 22 : 11)) ok = false;
		for (const k of F) if (!Object.is(out[k], src[k])) ok = false;
	}
	check('packed front: 6,000 states read back field for field (Object.is)', ok && st.n === 6000, `n ${st.n}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
