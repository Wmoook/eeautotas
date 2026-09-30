'use strict';
// THE CHAINS-LAB JUDGE's LEG TEST: the three lab approaches and the compiler's own tiers on ONE test set with ONE clock.
// The cases (tools/lab/corridor_cases.js: the compile's stuck waypoints with a known route) from the KNOWN ROUTE'S OWN
// engine states: its previous trigger ('prev'), 300 and 120 ticks before it first enters the target ('hit-300', 'hit-120';
// only when after the previous trigger). Every arm gets the same wall clock (--ms) from the same exact state:
//   chain  msolve.chain (A* over support states, src/plan/msolve.js), Tmax 4000, legT 80 (the compiler's M2 tier's call)
//   corr   the corridor (src/plan/lab/corridor.js) with the executor tier's final config (EEAT_CORRIDOR=1)
//   bw     the backward solver (src/plan/lab/backward.js, meet in the middle + relay: the EEAT_BACKWARD tier's solve)
//   prof   the speed profiles (src/plan/lab/profile.js profileLeg: the EEAT_PROFILE tier's call)
//   exec   the executor as it stands (knobs as in the environment), reach() at rung 2 with the same clock
// Every answer is replayed here by a separate EESim from the start state: alive, and the tick its centre first enters a
// target tile is its T (one rule for every arm; the executor's own goal is a tick later for a coin). One JSON line per
// (case, start, arm). --agg=<jsonl,...>: per arm and start kind found / verified, T / route, ms; the complementarity (only
// this arm, the union of all); the pairs.
//   node tools/lab/judge_legs.js --cases=<cases.json> --levels=<lv230> --routes=<dir> [--arms=chain,corr,bw,prof,exec]
//     [--ms=30000] [--starts=prev,hit-300,hit-120] [--shard=i/n] [--out=<file.jsonl>]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MS = require(path.join(root, 'src/plan/msolve.js'));
const E = require(path.join(root, 'src/eesim.js'));
const C = require(path.join(root, 'src/common.js'));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const num = (k, d) => (argv[k] !== undefined ? +argv[k] : d);

async function main() {
	const cases = JSON.parse(fs.readFileSync(argv.cases, 'utf8'));
	const arms = String(argv.arms || 'chain,corr,bw,prof,exec').split(',');
	const kinds = String(argv.starts || 'prev,hit-300,hit-120').split(',');
	const [SH, NSH] = String(argv.shard || '0/1').split('/').map(Number);
	const MSC = num('ms', 30000);
	const outF = argv.out ? fs.openSync(argv.out, 'a') : null;
	const emit = (rec) => { const line = JSON.stringify(rec); console.log(line); if (outF !== null) fs.writeSync(outF, line + '\n'); };
	for (let ci = 0; ci < cases.length; ci++) {
		if (ci % NSH !== SH) continue;
		const c = cases[ci];
		const L = T.loadLevelFile(path.join(argv.levels, c.level));
		const W = L.width, H = L.height;
		const masks = C.readEetas(path.join(argv.routes, c.route));
		const trophy = c.label === 'trophy';
		const tset = new Set(c.tiles);
		const wp = trophy ? { kind: 'trophy', label: 'trophy' } : { kind: 'trigger', tiles: c.tiles.slice(), expect: null, label: c.label };
		const goal = T.goalOf(L, wp);
		const tiles = trophy ? Array.from(goal.tiles) : c.tiles.slice();
		const hit = c.hit;
		const starts = [];
		if (kinds.includes('prev')) starts.push(['prev', c.prevTick]);
		for (const b of [300, 120]) if (kinds.includes('hit-' + b) && hit - b > c.prevTick) starts.push(['hit-' + b, hit - b]);
		const sim = new E.EESim(L), inp = new E.EEInput();
		const chk = new E.EESim(L), cinp = new E.EEInput();
		let S = null, X = null, B = null, EXr = null;
		for (const [sname, tk] of starts) {
			sim.reset();
			for (let t = 0; t < tk; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
			const snap = sim.snapshot();
			const routeLeg = hit - tk;
			for (const arm of arms) {
				const t0 = Date.now();
				let r = null, err = null;
				try {
					if (arm === 'chain') {
						S = S || MS.createSolver(L, {});
						const q = S.chain(snap, { tiles, cls: 'any' }, { ms: MSC, Tmax: 4000, legT: 80 });
						r = { ok: q.ok, masks: q.masks, why: q.why };
					} else if (arm === 'corr') {
						S = S || MS.createSolver(L, {});
						X = X || require(path.join(root, 'src/plan/lab/corridor.js')).createCorridor(L, { solver: S });
						const q = X.solve(snap, { tiles, cls: 'any' }, { M: 3, Mu: 1, legT: 90, RX: 18, RD: 30, subStop: 2, plainStops: [8, 20], dom: 'dir', landMax: 0, legMode: 'lazy', lazyWide: true, lazyLegs: false,
							ms: MSC, deadline: Date.now() + MSC, Tmax: Math.min(4000, Math.max(2, routeLeg * 4)), first: true });
						r = { ok: q.ok, masks: q.masks, why: q.why };
					} else if (arm === 'bw') {
						B = B || require(path.join(root, 'src/plan/lab/backward.js')).createBackward(L);
						const q = B.solve(snap, { tiles }, { ms: MSC });
						r = { ok: q.ok, masks: q.masks, why: q.why };
					} else if (arm === 'prof') {
						const PF = require(path.join(root, 'src/plan/lab/profile.js'));
						const q = PF.profileLeg(L, [{ snap, tick: tk }], goal, { ms: MSC, deadline: Date.now() + MSC, collect: 4, extra: 2 });
						const a = q.ok && q.arrivals && q.arrivals.length ? q.arrivals.slice().sort((x, y) => x.masks.length - y.masks.length)[0] : null;
						r = { ok: !!a, masks: a ? Uint8Array.from(a.masks) : null, why: q.why };
					} else if (arm === 'exec') {
						if (!EXr) {
							const BM = require(path.join(root, 'src/plan/bounds.js')), PM = require(path.join(root, 'src/plan/prims.js')), EX = require(path.join(root, 'src/plan/executor.js'));
							const file = path.join(argv.levels, c.level);
							const bounds = BM.createBounds(L, {});
							const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
							EXr = await EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
						}
						const res = await EXr.reach([T.strOf(masks.subarray(0, tk))], wp, { ms: MSC, level: 2, k: 4 });
						const a = res.ok && res.arrivals && res.arrivals.length ? res.arrivals[0] : null;
						r = { ok: !!a, masks: a && a.masks ? T.masksOf(typeof a.masks === 'string' ? a.masks : T.strOf(a.masks)).subarray(tk) : null, tool: res.tool, why: res.fail ? res.fail.why : null };
					} else throw new Error('arm ' + arm);
				} catch (e) { err = String(e && e.message || e).slice(0, 200); r = { ok: false }; }
				const ms = Date.now() - t0;
				let verified = false, Tv = null;
				if (r && r.ok && r.masks && r.masks.length) {
					chk.restore(snap);
					for (let t = 0; t < r.masks.length; t++) {
						E.applyMask(cinp, r.masks[t] & 31); chk.tick(cinp);
						if (chk.is_dead) break;
						if (trophy ? chk.has_silver_crown || tset.has(T.tileOf(chk, W, H)) : tset.has(T.tileOf(chk, W, H))) { verified = true; Tv = t + 1; break; }
					}
				}
				emit({ level: c.level, label: c.label, kind: c.kind, start: sname, tick: tk, routeLeg, arm, ok: !!(r && r.ok), verified, T: Tv, ratio: verified ? +(Tv / routeLeg).toFixed(3) : null, ms, tool: r && r.tool, why: r && r.why ? String(r.why).slice(0, 80) : null, err });
			}
		}
		if (EXr && EXr.close) { try { await EXr.close(); } catch (e) { /* closed */ } }
	}
	if (outF !== null) fs.closeSync(outF);
}

function agg(files) {
	const recs = [];
	for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) { try { recs.push(JSON.parse(l)); } catch (e) { /* partial line */ } }
	const arms = [...new Set(recs.map((r) => r.arm))];
	const starts = [...new Set(recs.map((r) => r.start))];
	const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
	const key = (r) => `${r.level}|${r.label}|${r.start}`;
	const by = new Map();
	for (const r of recs) { if (!by.has(key(r))) by.set(key(r), {}); by.get(key(r))[r.arm] = r; }
	const full = [...by.values()].filter((v) => arms.every((a) => v[a]));
	console.log(`legs (case x start) with every arm: ${full.length}; arms ${arms.join(', ')}`);
	for (const s of ['all', ...starts]) {
		const rows = full.filter((v) => s === 'all' || v[arms[0]].start === s);
		const ok = (v, a) => v[a].verified;
		const line = arms.map((a) => {
			const f = rows.filter((v) => ok(v, a));
			const only = rows.filter((v) => ok(v, a) && arms.every((b) => b === a || !ok(v, b))).length;
			return `${a} ${f.length}/${rows.length} (only ${only}; T/route med ${med(f.map((v) => v[a].ratio))}; ms med ${med(rows.map((v) => v[a].ms))})`;
		}).join(' | ');
		const any = rows.filter((v) => arms.some((a) => ok(v, a))).length;
		const lab = rows.filter((v) => ['corr', 'bw', 'prof'].some((a) => v[a] && ok(v, a))).length;
		console.log(`[${s}] ${line} | ANY ${any}/${rows.length} | ANY-LAB ${lab}`);
	}
	// the pairs: where both find, which is faster (T), and a rejected (ok but not verified) count
	for (const a of arms) console.log(`${a}: rejected (ok, not verified) ${recs.filter((r) => r.arm === a && r.ok && !r.verified).length}, errors ${recs.filter((r) => r.arm === a && r.err).length}`);
	for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
		const a = arms[i], b = arms[j];
		const both = full.filter((v) => v[a].verified && v[b].verified);
		console.log(`${a} vs ${b}: both ${both.length}, ${a} faster ${both.filter((v) => v[a].T < v[b].T).length}, ${b} faster ${both.filter((v) => v[b].T < v[a].T).length}, same ${both.filter((v) => v[a].T === v[b].T).length}`);
	}
	// per kind of case
	for (const k of [...new Set(full.map((v) => v[arms[0]].kind))]) {
		const rows = full.filter((v) => v[arms[0]].kind === k);
		console.log(`kind ${k}: ${arms.map((a) => `${a} ${rows.filter((v) => v[a].verified).length}`).join(', ')} of ${rows.length}; any ${rows.filter((v) => arms.some((a) => v[a].verified)).length}`);
	}
}

if (argv.agg) agg(argv.agg.split(','));
else main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
