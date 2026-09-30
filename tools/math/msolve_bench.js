'use strict';
// THE MOVE SOLVER ON THE REAL MOVES (n4-math, build / solver): every move of the moves study (src/out/n4plan/
// understand/moves/exact_jsonl/moves_*.jsonl: 49,846 moves of the truthset's 218 routes; a move runs from one support
// boundary t0 to the next t1) is given to src/plan/msolve.js as a LEG: the start = the route's exact engine state after
// t0 ticks, the target = the route's next support (the centre tile at t1 and its class letter; a teleport onto that tile
// for a portal move), Tmax = the route's ticks + slack. The answer is replayed again here by a separate EESim with the
// moves study's own test (the class letter and the centre tile, a teleport when the route teleported):
//   solved   the solver returned masks and they reach the target (engine replay)
//   le       ... in no more ticks than the route (T <= t1 - t0);  lt: strictly fewer
//   exact    the answer's end state (or its landing hop's) = the route's end state (stateHash)
//   proven   T = the admissible lower bound with its certificate (no input sequence reaches the target sooner): the plain
//            bound (4.5) or the event-graph bound of src/math/lb.js (--prove=0: the plain one alone)
//   us       the solver's wall time for the leg (microseconds, one thread)
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/msolve_bench.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--limit=N routes] [--every=N moves] [--slack=10] [--K=2] [--coupled=0|1] [--labels=hop,jump]
//        node tools/math/msolve_bench.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/msolve/bench';
fs.mkdirSync(OUT, { recursive: true });
const SLACK = +(argv.slack || 10), EVERY = +(argv.every || 1);
const LABELS = argv.labels ? new Set(argv.labels.split(',')) : null;

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

/** the portal tiles whose exit lands within one tile of `tile` (the entrances of a teleport target) */
function portalVia(L, tile) {
	const W = L.width, N = W * L.height, tx = tile % W, ty = (tile / W) | 0, out = [];
	if (!L.portalSlot || !L.portalsById) return out;
	for (let i = 0; i < N; i++) {
		const s = L.portalSlot[i];
		if (s < 0) continue;
		const t = L.portalsById.get(L.pTarget[s]);
		if (!t || !(t.n > 0)) continue;
		for (let k = 0; k < t.n; k++) {
			const ex = t.xs[k] >> 4, ey = t.ys[k] >> 4;
			if (Math.abs(ex - tx) <= 1 && Math.abs(ey - ty) <= 1) { out.push(i); break; }
		}
	}
	return out;
}

function main() {
	const byR = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	const mine = all.filter((e) => e._idx % NSH === SH && byR.has(e._idx)).slice(0, +(argv.limit || 1e9));
	const outF = fs.openSync(path.join(OUT, `legs_${SH}.jsonl`), 'w');
	let nMoves = 0;
	const t00 = Date.now();
	for (const entry of mine) {
		const tr = TS.loadTruth(entry);
		if (!tr) continue;
		const { L, masks } = tr;
		const moves = byR.get(entry._idx);
		const W = L.width, H = L.height;
		// the route's states at the move boundaries (snapshots), its end hashes
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const need = new Set(); for (const m of moves) { need.add(m.t0); need.add(m.t1); }
		const snaps = new Map(), hashes = new Map();
		if (need.has(0)) { snaps.set(0, sim.snapshot()); hashes.set(0, sim.stateHash()); }
		for (let t = 0; t < masks.length; t++) {
			E.applyMask(inp, masks[t]); sim.tick(inp);
			if (need.has(t + 1)) { snaps.set(t + 1, sim.snapshot()); hashes.set(t + 1, sim.stateHash()); }
		}
		const S = MS.createSolver(L, { K: +(argv.K || 2) });
		const chk = new E.EESim(L), cinp = new E.EEInput();
		chk.reset();
		const flags = chk._flags;
		for (let mi = 0; mi < moves.length; mi++) {
			if (mi % EVERY !== 0) continue;
			const mv = moves[mi];
			if (LABELS && !LABELS.has(mv.label)) continue;
			if (mv.c0 === 'D' || mv.c1 === 'D' || mv.label === 'respawn' || mv.len > 400) continue;
			const tele = mv.endKind === 'portal';
			const target = { tiles: [mv.tile1], cls: mv.c1, tele };
			if (tele) target.via = portalVia(L, mv.tile1);
			const snap = snaps.get(mv.t0);
			const res = S.leg(snap, target, { Tmax: mv.len + SLACK, K: +(argv.K || 2), coupled: argv.coupled !== '0', plain: argv.plain !== '0', fields: argv.fields !== '0', prove: argv.prove !== '0' });
			const rec = { r: entry._idx, m: mi, label: mv.label, len: mv.len, c0: mv.c0, c1: mv.c1, ok: !!res.ok, tool: res.tool || null, T: res.T || 0,
				lb: res.lb, cert: !!res.cert, proven: !!res.proven, us: Math.round(res.us), cands: res.cands, ver: res.verifies, items: res.items, ticks: res.ticks,
				k: res.k, member: res.member, why: res.ok ? undefined : res.why,
				provenBy: res.provenBy, lbMath: res.lbMath, lbMathAbove: res.lbMathAbove ? true : undefined, proveUs: res.proveUs !== undefined ? Math.round(res.proveUs) : undefined };
			if (res.ok) {
				// the independent replay: the moves study's test at the answer's last tick
				const check = (ms) => {
					chk.restore(snap);
					let px = chk.px, py = chk.py, tel = false;
					for (let t = 0; t < ms.length; t++) {
						px = chk.px; py = chk.py;
						E.applyMask(cinp, ms[t]); chk.tick(cinp);
						tel = Math.abs(chk.px - px) > 20 || Math.abs(chk.py - py) > 20;
						if (chk.is_dead) return { ok: false };
					}
					const tile = T.tileOf(chk, W, H);
					const ok = tele ? tel && tile === mv.tile1 : (MS.clsOf(chk, flags) === mv.c1 && tile === mv.tile1);
					return { ok, hash: chk.stateHash() };
				};
				const a = check(res.masks);
				rec.verified = a.ok;
				rec.exact = a.hash === hashes.get(mv.t1) && res.T === mv.len;
				if (res.hop) { const b = check(res.hop); rec.hop = b.ok; if (b.hash === hashes.get(mv.t1) && res.T === mv.len) rec.exact = true; }
				rec.masks = T.strOf(res.masks);
			}
			fs.writeSync(outF, JSON.stringify(rec) + '\n');
			nMoves++;
		}
		process.stdout.write(`${entry._idx} ${entry.name} moves=${moves.length} done=${nMoves} ${((Date.now() - t00) / 1000).toFixed(1)}s\n`);
	}
	fs.closeSync(outF);
}

function aggregate(dir) {
	const recs = [];
	for (const f of fs.readdirSync(dir)) if (/^legs_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) recs.push(JSON.parse(line));
	const groups = new Map();
	const add = (k, r) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); };
	for (const r of recs) { add('ALL', r); add(r.label, r); }
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const p90 = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
	const lines = ['| class | legs | solved | <= route | < route | exact end | proven optimal | plain / field / coupled / chain | us median / p90 / mean |', '|---|---:|---:|---:|---:|---:|---:|---|---|'];
	const order = ['ALL', 'hop', 'jump', 'fall', 'walk', 'hopjump', 'airjump', 'arrow', 'dot', 'boost', 'portal', 'climb', 'swim'];
	for (const k of order.concat(Array.from(groups.keys()).filter((x) => !order.includes(x)))) {
		const g = groups.get(k);
		if (!g) continue;
		const ok = g.filter((r) => r.ok && r.verified);
		const le = ok.filter((r) => r.T <= r.len), lt = ok.filter((r) => r.T < r.len), ex = ok.filter((r) => r.exact), pr = ok.filter((r) => r.proven);
		const pl = ok.filter((r) => r.tool === 'plain').length, fd = ok.filter((r) => r.tool === 'field').length, cp = ok.filter((r) => r.tool === 'coupled').length, chn = ok.filter((r) => r.tool === 'chain').length;
		const us = g.map((r) => r.us), mean = us.reduce((a, b) => a + b, 0) / Math.max(1, us.length);
		lines.push(`| ${k} | ${g.length} | ${pct(ok.length, g.length)}% | ${pct(le.length, g.length)}% | ${pct(lt.length, g.length)}% | ${pct(ex.length, g.length)}% | ${pct(pr.length, g.length)}% | ${pct(pl, g.length)} / ${pct(fd, g.length)} / ${pct(cp, g.length)} / ${pct(chn, g.length)} | ${med(us)} / ${p90(us)} / ${mean.toFixed(0)} |`);
	}
	const bad = recs.filter((r) => r.ok && !r.verified).length;
	lines.push('', `legs ${recs.length}; answers the independent replay rejected: ${bad}`);
	// the bound: lb / route ticks on the plain legs with a bound
	const wb = recs.filter((r) => r.lb > 0);
	const ratio = wb.map((r) => r.lb / r.len);
	lines.push(`legs with a plain bound: ${wb.length} (${pct(wb.length, recs.length)}%), certified ${recs.filter((r) => r.cert).length}; lb / route ticks median ${med(ratio).toFixed(3)} p10 ${(() => { const s = ratio.slice().sort((a, b) => a - b); return (s[Math.floor(s.length * 0.1)] || 0).toFixed(3); })()}; route ticks = lb (the route itself optimal) ${wb.filter((r) => r.lb === r.len && r.cert).length}; lb > route ticks (UNSOUND) ${wb.filter((r) => r.lb > r.len && r.cert).length} (uncertified ${wb.filter((r) => r.lb > r.len && !r.cert).length})`);
	const okv = recs.filter((r) => r.ok && r.verified), pu = recs.filter((r) => r.proveUs !== undefined).map((r) => r.proveUs);
	lines.push(`proven optimal: by the plain certificate ${okv.filter((r) => r.proven && r.provenBy !== 'events').length}, by the event-graph bound (src/math/lb.js) ${okv.filter((r) => r.provenBy === 'events').length}; the event-graph bound above a replayed leg's ticks (a counterexample) ${okv.filter((r) => r.lbMathAbove).length}; its time median ${med(pu)} us, p90 ${p90(pu)} us over ${pu.length} legs`);
	const whys = new Map(); for (const r of recs) if (!r.ok) whys.set(r.why, (whys.get(r.why) || 0) + 1);
	lines.push('failures: ' + Array.from(whys.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('; '));
	const txt = lines.join('\n');
	console.log(txt);
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
}

main();
