'use strict';
// THE KNOWN-ROUTE LEGS for THE PORTFOLIO (src/plan/portfolio.js; n5-s99-portfolio): every case of the chains lab's set
// (tools/lab/corridor_cases.js: the compile's stuck waypoints, from the KNOWN ROUTE'S OWN engine state at its previous
// trigger; kinds LONG / FINDER / ARRIVAL) solved by each lab solver ALONE ('chain', 'corr', 'prof', 'bw', 'leg': the
// portfolio's own arm runner with the whole budget) and by THE PORTFOLIO ('port', one budget), the same clock each; every
// answer replayed again here by a separate EESim (the centre in a target tile at its last tick, alive). --startBack=N: the
// start N route ticks before the route's first entry of the target instead of the previous trigger (hit-N).
// One JSON line per (case, arm). --agg=<jsonl,...> prints the table (the union of the solo arms too).
//   node tools/lab/portfolio_krt.js --cases=<cases.json> --levels=<lv230> --routes=<dir> [--arms=port,chain,corr,prof,bw,leg]
//     [--ms=30000] [--kind=LONG,FINDER] [--only=<regex>] [--shard=i/n] [--out=<file.jsonl>] [--plan=corr:0.3,...]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MS = require(path.join(root, 'src/plan/msolve.js'));
const PO = require(path.join(root, 'src/plan/portfolio.js'));
const E = require(path.join(root, 'src/eesim.js'));
const C = require(path.join(root, 'src/common.js'));

// (--vars='{"portB":{...solve options}}': more portfolio arms, paired in one process)
const argv0 = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const VARS = argv0.vars ? JSON.parse(argv0.vars) : {};
const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { agg(argv.agg.split(',')); process.exit(0); }

function main() {
	const cases = JSON.parse(fs.readFileSync(argv.cases, 'utf8'));
	const arms = String(argv.arms || 'port,chain,corr,prof,bw,leg').split(',');
	const [SH, NSH] = String(argv.shard || '0/1').split('/').map(Number);
	const only = argv.only ? new RegExp(argv.only) : null;
	const kinds = argv.kind ? String(argv.kind).split(',') : null;
	const outF = argv.out ? fs.openSync(argv.out, 'a') : null;
	const MSB = +(argv.ms || 30000);
	cases.forEach((c, i) => { c._i = i; });
	for (const c of cases) {
		if (c._i % NSH !== SH) continue;
		if (only && !only.test(c.level + ' ' + c.label)) continue;
		if (kinds && !kinds.includes(c.kind)) continue;
		const L = T.loadLevelFile(path.join(argv.levels, c.level));
		const W = L.width, H = L.height;
		const masks = C.readEetas(path.join(argv.routes, c.route));
		const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
		const back = +(argv.startBack || 0);
		const t0s = back > 0 ? Math.max(0, c.hit - back) : c.prevTick;
		if (back > 0 && t0s <= c.prevTick) continue;   // (hit-N only where it starts after the previous trigger)
		for (let t = 0; t < t0s; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
		const snap = sim.snapshot();
		const routeLeg = c.hit - t0s;
		const S = MS.createSolver(L, {});
		const P = PO.createPortfolio(L, { solver: S });
		const target = { tiles: c.tiles, cls: 'any' };
		const tset = new Set(c.tiles);
		const chk = new E.EESim(L), cinp = new E.EEInput();
		const shape = P.shapeOf(snap, target);
		for (const arm of arms) {
			const t0 = Date.now();
			let r;
			try {
				r = arm === 'port' ? P.solve(snap, target, { ms: MSB, Tmax: 6000, resume: false, plan: argv.plan })
					: VARS[arm] ? P.solve(snap, target, Object.assign({ ms: MSB, Tmax: 6000, resume: false }, VARS[arm]))
						: P.solve(snap, target, { ms: MSB, Tmax: 6000, resume: false, plan: arm + ':1' });
			} catch (e) { r = { ok: false, why: 'error ' + (e && e.message || e) }; }
			const ms = Date.now() - t0;
			let verified = false;
			if (r.ok) {
				chk.restore(snap);
				// (a start in its dead ticks plays them first: a death after the ball was alive fails the answer)
				let dead = false, alive = !chk.is_dead;
				for (let t = 0; t < r.masks.length; t++) { E.applyMask(cinp, r.masks[t]); chk.tick(cinp); if (chk.is_dead) { if (alive && !(+(process.env.EEAT_BW_DEATHS || 0) > 0)) dead = true; } else alive = true; }
				verified = !dead && tset.has(T.tileOf(chk, W, H));
			}
			const rec = { level: c.level, label: c.label, kind: c.kind, start: back > 0 ? 'hit-' + back : 'prev', routeLeg, arm, ok: !!r.ok, verified, T: r.T || 0,
				ratio: r.ok ? +(r.T / routeLeg).toFixed(3) : null, ms, why: r.why || '', shape, by: r.arm || null, per: arm === 'port' || VARS[arm] ? r.arms : undefined };
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
	const good = (r) => r && r.ok && r.verified;
	for (const arm of arms) {
		const rs = recs.filter((r) => r.arm === arm);
		const ok = rs.filter(good);
		const byK = {};
		for (const r of rs) { const k = r.kind; byK[k] = byK[k] || [0, 0]; byK[k][1]++; if (good(r)) byK[k][0]++; }
		console.log(`${arm}: found ${ok.length} / ${rs.length} (${Object.entries(byK).map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(', ')}); rejected ${rs.filter((r) => r.ok && !r.verified).length}; T/route median ${med(ok.map((r) => r.ratio))}; ms median ${med(rs.map((r) => r.ms))} (found ${med(ok.map((r) => r.ms))})`);
	}
	const byCase = new Map();
	for (const r of recs) { const k = r.level + '|' + r.label + '|' + r.start; if (!byCase.has(k)) byCase.set(k, {}); byCase.get(k)[r.arm] = r; }
	const solo = arms.filter((a) => !/^port/.test(a));
	let u = 0, n = 0, onlyP = 0, onlyU = 0;
	for (const v of byCase.values()) {
		n++;
		const us = solo.some((a) => good(v[a]));
		if (us) u++;
		if (v.port) { if (good(v.port) && !us) onlyP++; if (!good(v.port) && us) onlyU++; }
	}
	console.log(`union of ${solo.join(' + ')}: ${u} / ${n}; port only ${onlyP}, the union only ${onlyU}`);
	for (const [k, v] of byCase) console.log(`${k.padEnd(70).slice(0, 70)} ${arms.map((a) => (v[a] ? (good(v[a]) ? `${a} ${v[a].T}t(${v[a].ratio})@${v[a].ms}ms${a === 'port' ? '<' + v[a].by + '>' : ''}` : `${a} -`) : '')).join('  ')}  route ${Object.values(v)[0].routeLeg}`);
}
main();
