'use strict';
// THE CORRIDOR LAB's KNOWN-ROUTE HARNESS: every case of tools/lab/corridor_cases.js (the compile's stuck waypoints, from
// the KNOWN ROUTE'S OWN engine state at its previous trigger) solved by one or more arms with the same clock, each answer
// replayed again here by a separate EESim (the centre in a target tile at the answer's last tick, alive):
//   base   msolve.chain (A* over support states, src/plan/msolve.js) with Tmax 4000, legT 80
//   corr   src/plan/lab/corridor.js (the corridor sub-level sets of footholds + the DP over arrival states)
// One JSON line per (case, arm): {level, label, kind, routeLeg, arm, ok, verified, T, ratio (T / routeLeg), ms, firstMs,
// expanded, legs, ...}. --agg=<jsonl ...> prints the table.
//   node tools/lab/corridor_krt.js --cases=<cases.json> --levels=<lv230> --routes=<dir> [--arms=base,corr] [--ms=5000]
//     [--kind=LONG,FINDER] [--only=<regex>] [--shard=i/n] [--out=<file.jsonl>] [--K=4 --delta=10 --legT=90 ...]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MS = require(path.join(root, 'src/plan/msolve.js'));
const CR = require(path.join(root, 'src/plan/lab/corridor.js'));
const E = require(path.join(root, 'src/eesim.js'));
const C = require(path.join(root, 'src/common.js'));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { agg(argv.agg.split(',')); process.exit(0); }
const num = (k, d) => (argv[k] !== undefined ? +argv[k] : d);

function main() {
	const cases = JSON.parse(fs.readFileSync(argv.cases, 'utf8'));
	const arms = String(argv.arms || 'base,corr').split(',');
	const [SH, NSH] = String(argv.shard || '0/1').split('/').map(Number);
	const only = argv.only ? new RegExp(argv.only) : null;
	const kinds = argv.kind ? String(argv.kind).split(',') : null;
	const outF = argv.out ? fs.openSync(argv.out, 'a') : null;
	cases.forEach((c, i) => { c._i = i; });
	for (const c of cases) {
		if (c._i % NSH !== SH) continue;
		if (only && !only.test(c.level + ' ' + c.label)) continue;
		if (kinds && !kinds.includes(c.kind)) continue;
		const L = T.loadLevelFile(path.join(argv.levels, c.level));
		const W = L.width, H = L.height;
		const masks = C.readEetas(path.join(argv.routes, c.route));
		const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
		for (let t = 0; t < c.prevTick; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
		const snap = sim.snapshot();
		const S = MS.createSolver(L, {});
		const target = { tiles: c.tiles, cls: 'any' };
		const tset = new Set(c.tiles);
		const chk = new E.EESim(L), cinp = new E.EEInput();
		for (const arm of arms) {
			const t0 = Date.now();
			let r;
			if (arm === 'base') {
				const q = S.chain(snap, target, { ms: num('ms', 5000), Tmax: 4000, legT: 80 });
				r = { ok: q.ok, masks: q.masks, T: q.T, expanded: q.expanded, legs: q.legs, nodes: q.nodes, firstMs: q.firstMs };
			} else if (arm === 'corr') {
				const X = CR.createCorridor(L, { solver: S });
				const co = { ms: num('ms', 5000), fan: argv.fan !== '0', legs: argv.legs !== '0', legMode: argv.legMode || undefined, plainStops: argv.plainStops, fieldStops: argv.fieldStops, dom: argv.dom, airKey: argv.airKey, legNew: !!argv.legNew, lazyWide: !!argv.lazyWide, lazyLegs: argv.lazyLegs !== '0', wideStops: argv.wideStops, directOnce: !!argv.directOnce };
				for (const k of ['K', 'Ka', 'delta', 'legT', 'alts', 'D', 'w', 'w1', 'beta', 'M', 'RX', 'RU', 'RD', 'legNodes', 'itemNodes', 'coupledTicks', 'fieldMs', 'Mu', 'Ma', 'plainMs', 'subStop', 'fanT', 'lazyStall', 'lazyM', 'lazyRX', 'lazyRU', 'landMax', 'landT', 'landNodes', 'Tmax']) if (argv[k] !== undefined) co[k] = +argv[k];
				const q = X.solve(snap, target, co);
				r = Object.assign({}, q);
			} else throw new Error('arm ' + arm);
			const ms = Date.now() - t0;
			let verified = false;
			if (r.ok) {
				chk.restore(snap);
				let dead = false;
				for (let t = 0; t < r.masks.length; t++) { E.applyMask(cinp, r.masks[t]); chk.tick(cinp); if (chk.is_dead) dead = true; }
				verified = !dead && tset.has(T.tileOf(chk, W, H));
			}
			const rec = { level: c.level, label: c.label, kind: c.kind, routeLeg: c.routeLeg, arm, ok: !!r.ok, verified, T: r.T || 0, ratio: r.ok ? +(r.T / c.routeLeg).toFixed(3) : null, ms, firstMs: r.firstMs || 0,
				expanded: r.expanded, legs: r.legs, nodes: r.nodes, subOk: r.subOk, repairs: r.repairs, why: r.why || "", c0: r.c0, bestC: r.bestC, bestCg: r.bestCg, prof: r.prof };
			if (r.ok && argv.masks) rec.masks = T.strOf(r.masks);
			const line = JSON.stringify(rec);
			console.log(line);
			if (outF !== null) fs.writeSync(outF, line + '\n');
		}
	}
	if (outF !== null) fs.closeSync(outF);
}

function agg(files) {
	const recs = [];
	for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) recs.push(JSON.parse(l));
	const arms = [...new Set(recs.map((r) => r.arm))];
	const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	for (const arm of arms) {
		const rs = recs.filter((r) => r.arm === arm);
		const ok = rs.filter((r) => r.ok && r.verified);
		const byK = {};
		for (const r of rs) { const k = r.kind; byK[k] = byK[k] || [0, 0]; byK[k][1]++; if (r.ok && r.verified) byK[k][0]++; }
		console.log(`${arm}: found ${ok.length} / ${rs.length} (${Object.entries(byK).map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(', ')}); rejected ${rs.filter((r) => r.ok && !r.verified).length}; T/route median ${med(ok.map((r) => r.ratio))}; ms median ${med(rs.map((r) => r.ms))}, first-find ms median ${med(ok.map((r) => r.firstMs))}`);
	}
	const byCase = new Map();
	for (const r of recs) { const k = r.level + '|' + r.label; if (!byCase.has(k)) byCase.set(k, {}); byCase.get(k)[r.arm] = r; }
	for (const [k, v] of byCase) console.log(`${k.padEnd(70).slice(0, 70)} ${arms.map((a) => (v[a] ? (v[a].ok && v[a].verified ? `${a} ${v[a].T}t(${v[a].ratio})@${v[a].firstMs}ms` : `${a} -`) : '')).join('  ')}  route ${Object.values(v)[0].routeLeg}`);
}
main();
