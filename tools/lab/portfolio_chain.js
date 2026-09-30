'use strict';
// THE MOVES STUDY'S K-MOVE CHAINS for THE PORTFOLIO (src/plan/portfolio.js; n5-s99-portfolio): the set of
// tools/lab/corridor_chain.js (every EVERY-th move of the known routes, from the route's exact state at that move's start
// to the support K moves ahead: that move's end tile and class letter, a teleport onto it for a portal move), each chain
// solved by the arms given in ONE process: each lab solver ALONE ('chain', 'corr', 'prof', 'bw', through the portfolio's
// own arm runner with a fresh session and the whole budget) and THE PORTFOLIO ('port': the four in one budget, the shape's
// plan); every answer replayed again by a separate EESim (the moves study's test at its last tick). The horizon is the
// executor's (--Tmax, 3000), not the route's.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/lab/portfolio_chain.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--chain=4] [--every=48] [--ms=5000] [--arms=port,chain,corr,prof,bw] [--Tmax=3000] [--plan=corr:0.3,...]
//          [--only=<json list of r:m keys>]
//        node tools/lab/portfolio_chain.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');
const PO = require('../../src/plan/portfolio.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/s99/chain';
fs.mkdirSync(OUT, { recursive: true });
const KCH = +(argv.chain || 4), EVERY = +(argv.every || 48), MSB = +(argv.ms || 5000), TMAX = +(argv.Tmax || 3000);
const ARMS = String(argv.arms || 'port,chain,corr,prof,bw').split(',');
const ONLY = argv.only ? new Set(JSON.parse(fs.readFileSync(argv.only, 'utf8'))) : null;

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
		const moves = byR.get(entry._idx);
		if (ONLY) { let any = false; for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) if (ONLY.has(entry._idx + ':' + i)) any = true; if (!any) continue; }
		const tr = TS.loadTruth(entry);
		if (!tr) continue;
		const { L, masks } = tr;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const need = new Set();
		for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) need.add(moves[i].t0);
		const snaps = new Map();
		if (need.has(0)) snaps.set(0, sim.snapshot());
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (need.has(t + 1)) snaps.set(t + 1, sim.snapshot()); }
		const S = MS.createSolver(L, {});
		const P = PO.createPortfolio(L, { solver: S });
		const chk = new E.EESim(L), cinp = new E.EEInput();
		chk.reset();
		const flags = chk._flags;
		for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) {
			if (ONLY && !ONLY.has(entry._idx + ':' + i)) continue;
			const a = moves[i], b = moves[i + KCH - 1];
			if (moves.slice(i, i + KCH).some((m) => m.c0 === 'D' || m.c1 === 'D')) continue;
			const tele = b.endKind === 'portal';
			const target = { tiles: [b.tile1], cls: b.c1, tele };
			if (tele) target.via = portalVia(L, b.tile1);
			const routeT = b.t1 - a.t0;
			const snap = snaps.get(a.t0);
			const rec = { r: entry._idx, name: entry.name, m: i, k: KCH, routeT, labels: moves.slice(i, i + KCH).map((m) => m.label).join(','), shape: P.shapeOf(snap, target), arms: {} };
			for (const arm of ARMS) {
				const t0 = Date.now();
				let res;
				try {
					if (arm === 'port') res = P.solve(snap, target, { ms: MSB, Tmax: TMAX, resume: false, plan: argv.plan });
					else res = P.solve(snap, target, { ms: MSB, Tmax: TMAX, resume: false, plan: arm + ':1' });
				} catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
				const ar = { ok: !!res.ok, T: res.T || 0, ms: Date.now() - t0, why: res.why, error: res.error };
				if (arm === 'port') { ar.arm = res.arm; ar.order = res.order; ar.per = res.arms; }
				if (res.ok) {
					chk.restore(snap);
					let px = chk.px, py = chk.py, tel = false, dead = false;
					for (let t = 0; t < res.masks.length; t++) { px = chk.px; py = chk.py; E.applyMask(cinp, res.masks[t]); chk.tick(cinp); if (chk.is_dead) dead = true; tel = Math.abs(chk.px - px) > 20 || Math.abs(chk.py - py) > 20; }
					const tile = T.tileOf(chk, L.width, L.height);
					ar.verified = !dead && (tele ? tel && tile === b.tile1 : (MS.clsOf(chk, flags) === b.c1 && tile === b.tile1));
				}
				rec.arms[arm] = ar;
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
	const p90 = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(0.9 * (s.length - 1))]; };
	const arms = [...new Set(recs.flatMap((r) => Object.keys(r.arms)))];
	const good = (r, a) => r.arms[a] && r.arms[a].ok && r.arms[a].verified;
	const lines = [`chains ${recs.length} (K = ${recs[0] ? recs[0].k : '?'} moves)`];
	for (const a of arms) {
		const ok = recs.filter((r) => good(r, a));
		lines.push(`${a}: found ${pct(ok.length, recs.length)}% (${ok.length}), <= route ${pct(ok.filter((r) => r.arms[a].T <= r.routeT).length, recs.length)}%, rejected ${recs.filter((r) => r.arms[a] && r.arms[a].ok && !r.arms[a].verified).length}, T / route median ${med(ok.map((r) => r.arms[a].T / r.routeT)).toFixed(3)}, ms median ${med(recs.map((r) => r.arms[a] ? r.arms[a].ms : 0))} (found ${med(ok.map((r) => r.arms[a].ms))}, p90 ${p90(ok.map((r) => r.arms[a].ms))})`);
	}
	const solo = arms.filter((a) => a !== 'port');
	if (solo.length > 1) {
		const u = recs.filter((r) => solo.some((a) => good(r, a)));
		lines.push(`union of ${solo.join(' + ')} (each alone at the budget): ${pct(u.length, recs.length)}% (${u.length})`);
		if (arms.includes('port')) lines.push(`port vs the union: only port ${recs.filter((r) => good(r, 'port') && !solo.some((a) => good(r, a))).length}, only the union ${recs.filter((r) => !good(r, 'port') && solo.some((a) => good(r, a))).length}`);
		for (const a of solo) lines.push(`  only ${a}: ${recs.filter((r) => good(r, a) && !solo.some((b) => b !== a && good(r, b))).length}`);
	}
	if (arms.includes('port')) {
		const by = {};
		for (const r of recs) if (good(r, 'port')) by[r.arms.port.arm] = (by[r.arms.port.arm] || 0) + 1;
		lines.push(`port's legs by arm: ${JSON.stringify(by)}`);
	}
	const bucket = (r) => (r.routeT < 60 ? '0-60' : r.routeT < 120 ? '60-120' : r.routeT < 240 ? '120-240' : r.routeT < 480 ? '240-480' : '480+');
	for (const bk of ['0-60', '60-120', '120-240', '240-480', '480+']) {
		const rs = recs.filter((r) => bucket(r) === bk);
		lines.push(`  route ${bk} ticks (${rs.length}): ` + arms.map((a) => `${a} ${pct(rs.filter((r) => good(r, a)).length, rs.length)}%`).join(', '));
	}
	for (const [nm, fn] of [['plain', (r) => !r.shape.field], ['FIELD', (r) => r.shape.field], ['tele', (r) => r.shape.tele]]) {
		const rs = recs.filter(fn);
		lines.push(`  ${nm} (${rs.length}): ` + arms.map((a) => `${a} ${pct(rs.filter((r) => good(r, a)).length, rs.length)}%`).join(', '));
	}
	const txt = lines.join('\n');
	console.log(txt);
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
}

main();
