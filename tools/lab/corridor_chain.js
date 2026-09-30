'use strict';
// THE MOVES STUDY'S K-MOVE CHAINS for the corridor (n5 chains lab, approach C): tools/math/msolve_chain.js's set (every
// EVERY-th move of the known routes, from the route's exact state at that move's start to the support K moves ahead:
// that move's end tile and class letter, a teleport onto it for a portal move), each chain searched by the arms given in
// ONE process, paired: 'chain' = msolve.chain (the base: A* over support states, its default settings), 'corr' = the
// corridor (src/plan/lab/corridor.js solve, o.first); every answer replayed again by a separate EESim (the moves study's
// test at its last tick).
// Usage: EEAT_TRUTH_ROOT=<root> node tools/lab/corridor_chain.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--chain=4] [--every=48] [--ms=5000] [--arms=chain,corr] [--limit=N routes] [corridor options: --M= --Mu= --legT=
//          --RX= --RD= --subStop= --legMode= --legs=0 --w= --w1= --beta= --K= --Ka= --fanT=]
//        node tools/lab/corridor_chain.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const T = require('../../src/plan/types.js');
const MS = require('../../src/plan/msolve.js');
const CR = require('../../src/plan/lab/corridor.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/lab_corridor/chain';
fs.mkdirSync(OUT, { recursive: true });
const KCH = +(argv.chain || 4), EVERY = +(argv.every || 48), MSB = +(argv.ms || 5000);
const ARMS = String(argv.arms || 'chain,corr').split(',');
const copt = { M: 3, Mu: 1, legT: 90, RX: 18, RD: 30, subStop: 2 };
for (const k of ['K', 'Ka', 'delta', 'legT', 'alts', 'D', 'w', 'w1', 'beta', 'M', 'Mu', 'Ma', 'RX', 'RU', 'RD', 'legNodes', 'itemNodes', 'plainMs', 'coupledTicks', 'fieldMs', 'subStop', 'fanT', 'lazyStall', 'landMax', 'landT', 'landNodes', 'dCT', 'dFMs']) if (argv[k] !== undefined) copt[k] = +argv[k];
if (argv.legs === '0') copt.legs = false;
if (argv.legMode) copt.legMode = argv.legMode;
if (argv.plainStops) copt.plainStops = argv.plainStops;
if (argv.dom) copt.dom = argv.dom;
if (argv.airKey) copt.airKey = argv.airKey;
if (argv.legNew) copt.legNew = true;
if (argv.directOnce) copt.directOnce = true;
if (argv.lazyWide) copt.lazyWide = true;
if (argv.lazyLegs === '0') copt.lazyLegs = false;
if (argv.wideStops) copt.wideStops = argv.wideStops;
for (const k of ['lazyM', 'lazyRX', 'lazyRU']) if (argv[k] !== undefined) copt[k] = +argv[k];
if (argv.fan === '0') copt.fan = false;
// (--exec=1: the executor tier MC's own options, executor.js; the fields pass (n5-s99-fields): --goalFan=1
// --directShare= --fieldKey=sub --fieldPx= --fieldV= --Kf=; --fields=1: only the chains with a field move (arrow, dot,
// boost, climb, swim: metric (c)))
if (argv.exec === '1') Object.assign(copt, { plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false });
if (argv.goalFan === '1') copt.goalFan = true;
if (argv.restKey === '1') copt.restKey = true;
if (argv.refine === '1') copt.refine = true;
if (argv.bfs === '1') copt.bfs = true;
for (const k of ['directShare', 'fieldPx', 'fieldV', 'Kf', 'more']) if (argv[k] !== undefined) copt[k] = +argv[k];
if (argv.fieldKey) copt.fieldKey = argv.fieldKey;
const FIELD_LABELS = new Set(['arrow', 'dot', 'boost', 'climb', 'swim']);

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
		const X = ARMS.includes('corr') ? CR.createCorridor(L, { solver: S }) : null;
		const chk = new E.EESim(L), cinp = new E.EEInput();
		chk.reset();
		const flags = chk._flags;
		for (let i = 0; i + KCH - 1 < moves.length; i += EVERY) {
			const a = moves[i], b = moves[i + KCH - 1];
			if (a.c0 === 'D' || b.c1 === 'D' || moves.slice(i, i + KCH).some((m) => m.c0 === 'D' || m.c1 === 'D')) continue;
			if (argv.fields === '1' && !moves.slice(i, i + KCH).some((m) => FIELD_LABELS.has(m.label))) continue;
			const tele = b.endKind === 'portal';
			const target = { tiles: [b.tile1], cls: b.c1, tele };
			if (tele) target.via = portalVia(L, b.tile1);
			const routeT = b.t1 - a.t0;
			const rec = { r: entry._idx, m: i, k: KCH, routeT, labels: moves.slice(i, i + KCH).map((m) => m.label).join(','), arms: {} };
			for (const arm of ARMS) {
				const t0 = Date.now();
				let res;
				try {
					if (arm === 'chain') res = S.chain(snaps.get(a.t0), target, { ms: MSB });
					else if (arm === 'corr') res = X.solve(snaps.get(a.t0), target, Object.assign({}, copt, { ms: MSB, first: true, Tmax: Math.max(400, 4 * routeT) }));
					else throw new Error('arm ' + arm);
				} catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
				const ar = { ok: !!res.ok, T: res.T || 0, exp: res.expanded || 0, ms: Date.now() - t0, firstMs: res.firstMs || 0, error: res.error };
				if (arm === 'corr') { ar.c0 = res.c0; ar.bestC = res.bestC; ar.why = res.why; }
				if (res.ok) {
					chk.restore(snaps.get(a.t0));
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
	const arms = [...new Set(recs.flatMap((r) => Object.keys(r.arms)))];
	const good = (r, a) => r.arms[a] && r.arms[a].ok && r.arms[a].verified;
	const lines = [`chains ${recs.length} (K = ${recs[0] ? recs[0].k : '?'} moves)`];
	for (const a of arms) {
		const ok = recs.filter((r) => good(r, a));
		lines.push(`${a}: found ${pct(ok.length, recs.length)}% (${ok.length}), <= route ${pct(ok.filter((r) => r.arms[a].T <= r.routeT).length, recs.length)}%, rejected ${recs.filter((r) => r.arms[a] && r.arms[a].ok && !r.arms[a].verified).length}, T / route median ${med(ok.map((r) => r.arms[a].T / r.routeT)).toFixed(3)}, ms median ${med(recs.map((r) => r.arms[a] ? r.arms[a].ms : 0))}, expanded median ${med(recs.map((r) => r.arms[a] ? r.arms[a].exp : 0))}`);
	}
	if (arms.length === 2) {
		const [p, q] = arms;
		const both = recs.filter((r) => good(r, p) && good(r, q));
		lines.push(`only ${p} ${recs.filter((r) => good(r, p) && !good(r, q)).length}, only ${q} ${recs.filter((r) => !good(r, p) && good(r, q)).length}, either ${pct(recs.filter((r) => good(r, p) || good(r, q)).length, recs.length)}%; both ${both.length}: ${q} shorter ${both.filter((r) => r.arms[q].T < r.arms[p].T).length} / longer ${both.filter((r) => r.arms[q].T > r.arms[p].T).length}`);
		// by the route's ticks
		for (const [lo, hi] of [[0, 60], [60, 120], [120, 240], [240, 1e9]]) {
			const rs = recs.filter((r) => r.routeT >= lo && r.routeT < hi);
			lines.push(`  route ${lo}-${hi === 1e9 ? '' : hi} ticks (${rs.length}): ${p} ${pct(rs.filter((r) => good(r, p)).length, rs.length)}%, ${q} ${pct(rs.filter((r) => good(r, q)).length, rs.length)}%`);
		}
	}
	const txt = lines.join('\n');
	console.log(txt);
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
}

main();
