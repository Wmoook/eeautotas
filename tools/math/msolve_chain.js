'use strict';
// CHAINS ON THE REAL ROUTES (n4-math, build / solver): src/plan/msolve.js chain() (A* over support states, solved
// legs as edges) from the route's exact state at a move's start to the support K moves ahead (the moves study's
// segmentation: that move's end tile and class letter, a teleport onto it for a portal move), with a time budget per
// chain; the answer replayed again here by a separate EESim (the moves study's test at its last tick). Reported: found,
// <= / < the route's ticks over the same K moves, closed (the A* proved no chain of its legs is shorter), expanded
// nodes, legs solved, ms.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/msolve_chain.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--chain=4] [--every=24] [--ms=2000] [--fan=8] [--legT=80] [--limit=N routes]
//        node tools/math/msolve_chain.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/msolve/chain';
fs.mkdirSync(OUT, { recursive: true });
const KCH = +(argv.chain || 4), EVERY = +(argv.every || 24);

function loadMoves(dir) {
	const byR = new Map();
	for (const f of fs.readdirSync(dir)) {
		if (!/^moves_\d+\.jsonl$/.test(f)) continue;
		for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
			if (!line) continue;
			const m = JSON.parse(line);
			if (!byR.has(m.r)) byR.set(m.r, []);
			byR.get(m.r).push(m);
		}
	}
	for (const a of byR.values()) a.sort((p, q) => p.t0 - q.t0);
	return byR;
}
function portalVia(L, tile) {
	const W = L.width, N = W * L.height, tx = tile % W, ty = (tile / W) | 0, out = [];
	if (!L.portalSlot || !L.portalsById) return out;
	for (let i = 0; i < N; i++) {
		const s = L.portalSlot[i];
		if (s < 0) continue;
		const t = L.portalsById.get(L.pTarget[s]);
		if (!t || !(t.n > 0)) continue;
		for (let k = 0; k < t.n; k++) if (Math.abs((t.xs[k] >> 4) - tx) <= 1 && Math.abs((t.ys[k] >> 4) - ty) <= 1) { out.push(i); break; }
	}
	return out;
}

function main() {
	const byR = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	const mine = all.filter((e) => e._idx % NSH === SH && byR.has(e._idx)).slice(0, +(argv.limit || 1e9));
	const outF = fs.openSync(path.join(OUT, `chains_${SH}.jsonl`), 'w');
	for (const entry of mine) {
		const tr = TS.loadTruth(entry);
		if (!tr) continue;
		const { L, masks } = tr;
		const moves = byR.get(entry._idx);
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const need = new Set();
		for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) need.add(moves[i].t0);
		const snaps = new Map();
		if (need.has(0)) snaps.set(0, sim.snapshot());
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (need.has(t + 1)) snaps.set(t + 1, sim.snapshot()); }
		const S = MS.createSolver(L, {});
		const chk = new E.EESim(L), cinp = new E.EEInput();
		chk.reset();
		const flags = chk._flags;
		for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) {
			const a = moves[i], b = moves[i + KCH - 1];
			if (a.c0 === 'D' || b.c1 === 'D' || moves.slice(i, i + KCH).some((m) => m.c0 === 'D' || m.c1 === 'D')) continue;
			const tele = b.endKind === 'portal';
			const target = { tiles: [b.tile1], cls: b.c1, tele };
			if (tele) target.via = portalVia(L, b.tile1);
			const routeT = b.t1 - a.t0;
			const res = S.chain(snaps.get(a.t0), target, { ms: +(argv.ms || 2000), fan: +(argv.fan || 8), legT: +(argv.legT || 80), w: +(argv.w || 1), coupledDirect: argv.coupledDirect !== '0' });
			const rec = { r: entry._idx, m: i, k: KCH, routeT, labels: moves.slice(i, i + KCH).map((m) => m.label).join(','), ok: res.ok, T: res.T, closed: res.closed, exp: res.expanded, legs: res.legs, nodes: res.nodes, ms: res.ms };
			if (res.ok) {
				chk.restore(snaps.get(a.t0));
				let px = chk.px, py = chk.py, tel = false, dead = false;
				for (let t = 0; t < res.masks.length; t++) { px = chk.px; py = chk.py; E.applyMask(cinp, res.masks[t]); chk.tick(cinp); if (chk.is_dead) dead = true; tel = Math.abs(chk.px - px) > 20 || Math.abs(chk.py - py) > 20; }
				const tile = T.tileOf(chk, L.width, L.height);
				rec.verified = !dead && (tele ? tel && tile === b.tile1 : (MS.clsOf(chk, flags) === b.c1 && tile === b.tile1));
				rec.masks = T.strOf(res.masks);
			}
			fs.writeSync(outF, JSON.stringify(rec) + '\n');
		}
		process.stdout.write(`${entry._idx} ${entry.name} moves=${moves.length}\n`);
	}
	fs.closeSync(outF);
}

function aggregate(dir) {
	const recs = [];
	for (const f of fs.readdirSync(dir)) if (/^chains_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) recs.push(JSON.parse(line));
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const ok = recs.filter((r) => r.ok && r.verified);
	const le = ok.filter((r) => r.T <= r.routeT), lt = ok.filter((r) => r.T < r.routeT), cl = ok.filter((r) => r.closed);
	const txt = [`chains ${recs.length} (K = ${recs[0] ? recs[0].k : '?'} moves): found ${pct(ok.length, recs.length)}%, <= route ${pct(le.length, recs.length)}%, < route ${pct(lt.length, recs.length)}%, closed ${pct(cl.length, recs.length)}%`,
		`answers the independent replay rejected: ${recs.filter((r) => r.ok && !r.verified).length}`,
		`ticks found / route (found ones) median ${med(ok.map((r) => r.T / r.routeT)).toFixed(3)}; ms median ${med(recs.map((r) => r.ms))}; expanded median ${med(recs.map((r) => r.exp))}; legs median ${med(recs.map((r) => r.legs))}`].join('\n');
	console.log(txt);
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
}

main();
