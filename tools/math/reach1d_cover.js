'use strict';
// THE 1D TABLES AGAINST THE REAL ROUTES (n4-math, Derive / reach1d): every known route of the truthset
// (src/plan/truthset.js: 218 replaying routes, 106 levels, ~2 M ticks) replayed by the engine, and per tick and per axis
// the per-axis recurrence of src/plan/kin1d.js (axisStep + x + v + the align, the jump sets v = J) from the engine's own
// previous state and this tick's context (the axis choice, the multipliers, the drag of the current tile, slippery),
// compared bit for bit with the engine. Then the moves study's 49,846 moves (src/out/n4plan/understand/moves/
// exact_jsonl/moves_*.jsonl: r, t0, t1, label) and their FREE-AIR SEGMENTS (the longest run of ticks of the move in
// plain free air: default gravity, plain current and delayed tiles, no liquid / climbable / boost / ice / levitation,
// no collision on either axis, no teleport, not on the ground after the tick):
//   exactX / exactY  the table's evaluation of the segment's own pattern (evalIA / evalGA from the real start) = the
//                    engine's end state (x, vx) / (y, vy) exactly (and every tick of it)
//   k                the segment's input changes (horizontal runs - 1): in the tables' family when <= 3
//   solveK           the fewest changes (0..3) of ANY pattern that reaches the engine's exact end (x, vx) from the real
//                    start (kin1d.solveIA with the point target; -1 none within 3, -2 the node budget)
//   rest             the start speed vx0 is in the rest tree (every speed of a pattern from rest with <= 2 changes and
//                    <= 120 ticks, or <= 3 changes and <= 48 ticks): a tabulated class
//   vyClass          the start vy: 0 (a walk-off or a bonk), J (a jump / hop), other
//   hist             ticks and input changes of the start speed's plain-exact history since vx was last 0
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/reach1d_cover.js --moves=<exact_jsonl dir> --out=<dir> [--shard=i/n]
//          [--solveNodes=300000] [--limit=N]         then: node tools/math/reach1d_cover.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const K = require('../../src/plan/kin1d.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const DRAGID = { 119: K.DRAG.water, 369: K.DRAG.mud, 416: K.DRAG.lava, 1585: K.DRAG.toxic };
const REST_T2 = 120, REST_T3 = 48;

if (argv.agg) { aggregate(argv.agg); process.exit(0); }

const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/math/reach1d_cover';
fs.mkdirSync(OUT, { recursive: true });
const SOLVE_NODES = +(argv.solveNodes || 300000);

// the moves by route index
function loadMoves(dir) {
	const byR = new Map(), routes = new Map();
	for (const f of fs.readdirSync(dir)) {
		const full = path.join(dir, f);
		if (/^moves_\d+\.jsonl$/.test(f)) {
			for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
				if (!line) continue;
				const m = JSON.parse(line);
				if (!byR.has(m.r)) byR.set(m.r, []);
				byR.get(m.r).push({ t0: m.t0, t1: m.t1, label: m.label });
			}
		} else if (/^routes_\d+\.jsonl$/.test(f)) {
			for (const line of fs.readFileSync(full, 'utf8').split('\n')) { if (line) { const r = JSON.parse(line); if (r.idx !== undefined) routes.set(r.idx, r); } }
		}
	}
	return { byR, routes };
}

// the rest tree: every speed a pattern from rest reaches (K <= 2 up to REST_T2 ticks, K <= 3 up to REST_T3 ticks)
function restSet(ctx) {
	const I = K.ia(ctx);
	let A = new Float64Array(1 << 20), n = 0;
	const add = (v) => { if (n === A.length) { const B = new Float64Array(A.length * 2); B.set(A); A = B; } A[n++] = v; };
	const walk = (T, KK) => {
		const rec = (t, v, miPrev, k) => {
			for (let mi = 0; mi < 3; mi++) {
				if (k > 0 && mi === miPrev) continue;
				let vv = v;
				for (let j = t + 1; j <= T; j++) {
					vv = K.axisStep(vv, I.ms[mi], 0, I.moO, 0, false);
					add(vv);
					if (k < KK && j < T) rec(j, vv, mi, k + 1);
				}
			}
		};
		rec(0, 0, -1, 0);
	};
	walk(REST_T2, 2); walk(REST_T3, 3);
	add(0);
	const S = A.subarray(0, n).sort();
	let m = 0; for (let i = 0; i < n; i++) if (i === 0 || S[i] !== S[m - 1]) S[m++] = S[i];
	const U = S.slice(0, m);
	return { size: m, has: (v) => { let a = 0, b = m; while (a < b) { const c = (a + b) >> 1; if (U[c] < v) a = c + 1; else b = c; } return a < m && U[a] === v; } };
}

function main() {
	const { byR, routes } = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	const mine = all.filter((e) => e._idx % NSH === SH && byR.has(e._idx)).slice(0, +(argv.limit || 1e9));
	const t0 = Date.now();
	const REST = restSet({});
	process.stdout.write(`rest set ${REST.size} speeds in ${Date.now() - t0} ms\n`);
	const segOut = fs.openSync(path.join(OUT, `seg_${SH}.jsonl`), 'w');
	const tot = { routes: 0, ticks: 0, mismatchRoute: 0, axis: {} };
	const bump = (k, n = 1) => { tot.axis[k] = (tot.axis[k] || 0) + n; };
	const samples = [];
	for (const entry of mine) {
		const rinfo = routes.get(entry._idx);
		const tr = TS.loadTruth(entry);
		if (!tr) continue;
		if (rinfo && rinfo.name !== entry.name) { tot.mismatchRoute++; continue; }
		const { L, masks } = tr;
		const n = masks.length;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let jumped = false;
		sim.onEvent = (ev) => { if (ev === 'jump') jumped = true; };
		const flags = sim._flags;
		// per tick (1..n): the state after it, the exactness per axis, plain, air
		const PX = new Float64Array(n + 1), PY = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1);
		const exX = new Uint8Array(n + 1), exY = new Uint8Array(n + 1), plain = new Uint8Array(n + 1), air = new Uint8Array(n + 1);
		const H = new Int8Array(n + 1), SMs = new Float64Array(n + 1), GMs = new Float64Array(n + 1), JMP = new Uint8Array(n + 1);
		const JV = new Float64Array(n + 1), SMP = new Float64Array(n + 1), GMP = new Float64Array(n + 1);
		PX[0] = sim.px; PY[0] = sim.py; VX[0] = sim.speed_x; VY[0] = sim.speed_y;
		for (let t = 1; t <= n; t++) {
			const m = masks[t - 1] & 31;
			const h = ((m & 2) ? -1 : 0) + ((m & 4) ? 1 : 0);
			jumped = false;
			const x0 = sim.px, y0 = sim.py, vx0 = sim.speed_x, vy0 = sim.speed_y, dead0 = sim.is_dead;
			// the multipliers this tick uses: the effects as they are before it (touchBlock changes them at its end)
			const pre = K.ctxOf(sim), jb = sim.jump_boost, zb = sim.is_zombie && !sim.in_god_mode;
			E.applyMask(inp, m);
			sim.tick(inp);
			PX[t] = sim.px; PY[t] = sim.py; VX[t] = sim.speed_x; VY[t] = sim.speed_y;
			H[t] = h;
			JMP[t] = jumped ? 1 : 0;
			const cur = sim._current;
			const f = flags[cur] || 0;
			const liquid = (f & F_LIQUID) !== 0, climb = (f & F_CLIMB) !== 0, boost = (f & F_BOOST) !== 0;
			const slip = sim._slippery > 0;
			const mx = sim._mx, my = sim._my, mox = sim.mox, moy = sim.moy;
			const drag = climb ? K.DRAG.climb : (DRAGID[cur] || 0);
			const skip = dead0 || sim.is_dead || sim.teleported || boost || sim.has_levitation || sim.in_god_mode;
			const collided = sim._loopCollided;
			// the model per axis
			let jm = 1.0; if (jb === 1) jm *= 1.3; if (jb === 2) jm *= 0.75; if (zb) jm *= 0.75; if (sim._slippery > 0) jm *= 0.88;
			let cls;
			if (skip) cls = sim.teleported ? 'tele' : (dead0 || sim.is_dead) ? 'dead' : boost ? 'boost' : 'lev';
			const ctxName = sim.flip_gravity !== 0 || mox !== 0 || moy <= 0 ? 'grav' : liquid ? 'liquid' : climb ? 'climb' : (cur === 4 || cur === 414) ? 'dot' : slip ? 'ice' : 'plain';
			for (const ax of [0, 1]) {
				const key = (s) => { bump(`${ax ? 'y' : 'x'}:${s}`); bump(`${ax ? 'y' : 'x'}:${ctxName}:${s}`); };
				if (skip) { key(cls); continue; }
				const x = ax ? y0 : x0, v = ax ? vy0 : vx0, mm = ax ? my : mx, mo = ax ? moy : mox, moO = ax ? mox : moy;
				let vv = K.axisStep(v, mm, mo, moO, drag, slip);
				let xx = x + vv;
				const mor = ax ? sim.mory : sim.morx;
				if (jumped && mor !== 0 && mo !== 0) vv = ((0 - mor) * 26 * jm) / K.MULT;
				if (K.armed(vv, (mo + mm) / K.MULT, liquid)) xx = K.align(xx);
				const ex = ax ? (sim.py === xx && sim.speed_y === vv) : (sim.px === xx && sim.speed_x === vv);
				if (ex) { key('exact'); if (ax) exY[t] = 1; else exX[t] = 1; }
				else if (collided) key('coll');
				else {
					key('UNEXPLAINED');
					if (samples.length < 20) samples.push({ route: entry.name, t, ax, engine: ax ? [sim.py, sim.speed_y] : [sim.px, sim.speed_x], model: [xx, vv], ctx: { mm, mo, moO, drag, slip, liquid, cur } });
				}
			}
			// the plain free-air context of the tables: default gravity (mox 0, moy > 0), plain current, no slip
			// (the delayed tile's gravity is the default one: moy = 2 x the gravity multiplier, no vertical input; the current
			// tile's too: morx 0, mory 2, the jump's direction and what counts as floor: an arrow there jumps the other way)
			plain[t] = !skip && ctxName === 'plain' && sim.flip_gravity === 0 && my === 0 && moy === 2 * K.ctxOf(sim).gm && sim.morx === 0 && sim.mory === 2 ? 1 : 0;
			air[t] = sim.on_ground ? 0 : 1;
			SMs[t] = h !== 0 ? mx / h : NaN;
			GMs[t] = moy / 2;
			JV[t] = jm; SMP[t] = pre.sm; GMP[t] = pre.gm;
		}
		tot.routes++; tot.ticks += n;
		// the rest history: per tick the ticks since vx was last 0 with every tick X-plain-exact, and its input changes
		const histLen = new Int32Array(n + 1), histK = new Int32Array(n + 1);
		histLen[0] = VX[0] === 0 ? 0 : -1;
		for (let t = 1; t <= n; t++) {
			if (VX[t] === 0) { histLen[t] = 0; histK[t] = 0; continue; }
			if (histLen[t - 1] < 0 || !plain[t] || !exX[t]) { histLen[t] = -1; continue; }
			histLen[t] = histLen[t - 1] + 1;
			histK[t] = histK[t - 1] + (histLen[t - 1] > 0 && H[t] !== H[t - 1] ? 1 : 0);
		}
		// the moves' free-air segments
		const moves = byR.get(entry._idx) || [];
		for (let mi = 0; mi < moves.length; mi++) {
			const mv = moves[mi];
			const a = mv.t0 + 1, b = Math.min(mv.t1, n);
			// the longest run of free-air ticks (plain, both axes exact, in the air after the tick)
			let best = null, s = -1;
			for (let t = a; t <= b + 1; t++) {
				const ok = t <= b && plain[t] && exX[t] && exY[t] && air[t];
				// one context along the segment: the speed and gravity multipliers do not change inside it
				if (s >= 0 && ok && !(SMP[t] === SMP[s] && GMP[t] === GMP[s])) { if (!best || t - s > best[1] - best[0] + 1) best = [s, t - 1]; s = t; continue; }
				if (ok && s < 0) s = t;
				if (!ok && s >= 0) { if (!best || t - s > best[1] - best[0] + 1) best = [s, t - 1]; s = -1; }
			}
			const rec = { r: entry._idx, m: mi, label: mv.label, len: mv.t1 - mv.t0 };
			if (!best) { rec.seg = 0; fs.writeSync(segOut, JSON.stringify(rec) + '\n'); continue; }
			const [s0, e0] = best, Lseg = e0 - s0 + 1;
			const x0 = PX[s0 - 1], vx0 = VX[s0 - 1], y0 = PY[s0 - 1], vy0 = VY[s0 - 1];
			// the segment's horizontal runs
			const runs = [];
			for (let t = s0; t <= e0; t++) { const mi2 = H[t] < 0 ? 1 : H[t] > 0 ? 2 : 0; if (runs.length && runs[runs.length - 1][0] === mi2) runs[runs.length - 1][1]++; else runs.push([mi2, 1]); }
			const k = runs.length - 1;
			const sm = SMP[s0], gm = GMP[s0];
			const ctx = { sm, gm, jm: JV[s0] };
			rec.seg = Lseg; rec.k = k; rec.sm = sm; rec.gm = gm;
			// X: the pattern through the table's evaluation (runs past 3 changes: the generic replay of the same recurrence)
			let ex;
			if (k <= 3 && Lseg <= 127) {
				const tr2 = { x: [], v: [] };
				const e = K.evalIA(x0, vx0, K.encode(runs), Lseg, ctx, tr2);
				let all = true;
				for (let i = 0; i < Lseg; i++) if (tr2.x[i] !== PX[s0 + i] || tr2.v[i] !== VX[s0 + i]) { all = false; break; }
				ex = all && e.x === PX[e0] && e.v === VX[e0];
				rec.exactX = ex ? 1 : 0;
			}
			// Y: the gravity axis from (y0, vy0), air jumps where the engine jumped
			{
				const jumps = []; for (let t = s0; t <= e0; t++) if (JMP[t]) jumps.push([t - s0 + 1, K.ga({ gm, jm: JV[t] }).J]);
				const tr2 = { y: [], v: [] };
				K.evalGA(y0, vy0, Lseg, ctx, jumps, tr2);
				let all = true;
				for (let i = 0; i < Lseg; i++) if (tr2.y[i] !== PY[s0 + i] || tr2.v[i] !== VY[s0 + i]) { all = false; break; }
				rec.exactY = all ? 1 : 0;
				rec.airJumps = jumps.length;
			}
			const J = K.ga({ gm, jm: JV[s0 - 1] || 1 }).J;
			rec.vyClass = vy0 === 0 ? '0' : vy0 === J ? 'J' : 'other';
			rec.rest = REST.has(vx0) && sm === 1 ? 1 : 0;
			rec.v0zero = vx0 === 0 ? 1 : 0;
			rec.histLen = histLen[s0 - 1]; rec.histK = histK[s0 - 1];
			// the fewest changes of any pattern reaching the exact end state
			if (Lseg <= 127) {
				const res = K.solveIA(x0, vx0, Lseg, PX[e0], PX[e0], { k: 3, vlo: VX[e0], vhi: VX[e0], limit: 1, maxNodes: SOLVE_NODES, ctx });
				rec.solveK = res.length ? res[0].k : (res.stats.budget ? -2 : -1);
				rec.solveNodes = res.stats.nodes;
				// the class-level question: the fewest changes that end within half a pixel of the route's x (any speed)
				const w = K.solveIA(x0, vx0, Lseg, PX[e0] - 0.5, PX[e0] + 0.5, { k: 3, limit: 1, maxNodes: SOLVE_NODES, ctx });
				rec.winK = w.length ? w[0].k : (w.stats.budget ? -2 : -1);
				if (res.length) {
					const e = K.evalIA(x0, vx0, res[0].code, Lseg, ctx);
					if (e.x !== PX[e0] || e.v !== VX[e0]) rec.solveBad = 1;
				}
			}
			fs.writeSync(segOut, JSON.stringify(rec) + '\n');
		}
		process.stdout.write(`${entry._idx} ${entry.name} ticks=${n} moves=${moves.length}\n`);
	}
	fs.closeSync(segOut);
	fs.writeFileSync(path.join(OUT, `tot_${SH}.json`), JSON.stringify({ tot, samples }, null, 1));
	process.stdout.write(`done ${tot.routes} routes ${tot.ticks} ticks ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
}

function aggregate(dir) {
	const tot = { routes: 0, ticks: 0, axis: {} }, samples = [];
	const segs = [];
	for (const f of fs.readdirSync(dir)) {
		if (/^tot_\d+\.json$/.test(f)) {
			const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
			tot.routes += j.tot.routes; tot.ticks += j.tot.ticks;
			for (const [k, v] of Object.entries(j.tot.axis)) tot.axis[k] = (tot.axis[k] || 0) + v;
			samples.push(...j.samples);
		} else if (/^seg_\d+\.jsonl$/.test(f)) {
			for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) segs.push(JSON.parse(line));
		}
	}
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
	const out = [];
	out.push(`# reach1d coverage: ${tot.routes} routes, ${tot.ticks} ticks, ${segs.length} moves`);
	out.push('');
	out.push('## Per tick and axis: the per-axis recurrence against the engine');
	for (const ax of ['x', 'y']) {
		const keys = Object.keys(tot.axis).filter((k) => k.startsWith(ax + ':') && k.split(':').length === 2);
		out.push(`${ax}: ` + keys.map((k) => `${k.slice(2)} ${tot.axis[k]} (${pct(tot.axis[k], tot.ticks)})`).join(', '));
		const ctxs = new Set(Object.keys(tot.axis).filter((k) => k.startsWith(ax + ':') && k.split(':').length === 3).map((k) => k.split(':')[1]));
		for (const c of ctxs) {
			const tk = ['exact', 'coll', 'UNEXPLAINED'].map((s) => tot.axis[`${ax}:${c}:${s}`] || 0);
			const all = tk[0] + tk[1] + tk[2];
			out.push(`  ${ax} ${c}: ${all} ticks, exact ${pct(tk[0], all)}, collision ${pct(tk[1], all)}, unexplained ${tk[2]}`);
		}
	}
	out.push('');
	const withSeg = segs.filter((s) => s.seg > 0);
	const segTicks = withSeg.reduce((a, s) => a + s.seg, 0), moveTicks = segs.reduce((a, s) => a + s.len, 0);
	out.push(`## Free-air segments: ${withSeg.length} of ${segs.length} moves have one (${pct(withSeg.length, segs.length)}), ${segTicks} ticks of the moves' ${moveTicks} (${pct(segTicks, moveTicks)})`);
	const canon = withSeg.filter((s) => s.sm === 1 && s.gm === 1);
	out.push(`the canonical context (speed x1, gravity x1): ${canon.length} segments (${pct(canon.length, withSeg.length)})`);
	const inFam = withSeg.filter((s) => s.k <= 3 && s.seg <= 127);
	out.push(`the route's own pattern in the family (<= 3 changes, <= 127 ticks): ${inFam.length} (${pct(inFam.length, withSeg.length)}); ticks ${pct(inFam.reduce((a, s) => a + s.seg, 0), segTicks)}`);
	out.push(`  reproduced exactly by the table's evaluation (x, vx every tick): ${inFam.filter((s) => s.exactX).length} of ${inFam.length}`);
	out.push(`  y reproduced exactly (every segment): ${withSeg.filter((s) => s.exactY).length} of ${withSeg.length}; with air jumps ${withSeg.filter((s) => s.airJumps).length}`);
	const kd = {}; for (const s of withSeg) { const kk = s.k > 8 ? '9+' : s.k; kd[kk] = (kd[kk] || 0) + 1; }
	out.push(`the segments' own changes: ` + Object.entries(kd).map(([k, v]) => `k=${k} ${v} (${pct(v, withSeg.length)})`).join(', '));
	const sk = {}; for (const s of withSeg) { if (s.solveK === undefined) continue; sk[s.solveK] = (sk[s.solveK] || 0) + 1; }
	out.push(`the exact end state (x, vx) reached with the fewest changes (any pattern): ` + Object.entries(sk).map(([k, v]) => `${k === '-1' ? 'none<=3' : k === '-2' ? 'budget' : 'k=' + k} ${v} (${pct(v, withSeg.length)})`).join(', '));
	let cum = 0; const cumk = [];
	for (const k of [0, 1, 2, 3]) { cum += sk[k] || 0; cumk.push(`<=${k}: ${pct(cum, withSeg.length)}`); }
	out.push(`  cumulative: ${cumk.join(', ')}; solver results that do not replay: ${withSeg.filter((s) => s.solveBad).length}`);
	const wk = {}; for (const s of withSeg) { if (s.winK === undefined) continue; wk[s.winK] = (wk[s.winK] || 0) + 1; }
	let cw = 0; const cumw = [];
	for (const k of [0, 1, 2, 3]) { cw += wk[k] || 0; cumw.push(`<=${k}: ${pct(cw, withSeg.length)}`); }
	out.push(`the end x within +-0.5 px (any speed), fewest changes: ${cumw.join(', ')}; none ${wk[-1] || 0}, budget ${wk[-2] || 0}`);
	out.push(`start speed vx0 in the rest tree (a tabulated class): ${withSeg.filter((s) => s.rest).length} (${pct(withSeg.filter((s) => s.rest).length, withSeg.length)}), vx0 = 0: ${withSeg.filter((s) => s.v0zero).length}`);
	const vy = {}; for (const s of withSeg) vy[s.vyClass] = (vy[s.vyClass] || 0) + 1;
	out.push(`start vy: ` + Object.entries(vy).map(([k, v]) => `${k} ${v} (${pct(v, withSeg.length)})`).join(', '));
	const hl = withSeg.filter((s) => s.histLen >= 0);
	out.push(`start speed with a plain-exact history since rest: ${hl.length} (${pct(hl.length, withSeg.length)}); of them history changes <= 2: ${pct(hl.filter((s) => s.histK <= 2).length, hl.length)}, <= 3: ${pct(hl.filter((s) => s.histK <= 3).length, hl.length)}`);
	out.push('');
	out.push('## By move class (segments / moves, own k <= 3, exact end reachable with <= 1 / <= 3 changes)');
	const labels = [...new Set(segs.map((s) => s.label))].sort();
	for (const lb of labels) {
		const all = segs.filter((s) => s.label === lb), ws = all.filter((s) => s.seg > 0);
		const r1 = ws.filter((s) => s.solveK >= 0 && s.solveK <= 1).length, r3 = ws.filter((s) => s.solveK >= 0).length;
		out.push(`${lb}: ${ws.length} / ${all.length}, own k<=3 ${pct(ws.filter((s) => s.k <= 3).length, ws.length)}, reach k<=1 ${pct(r1, ws.length)}, k<=3 ${pct(r3, ws.length)}`);
	}
	if (samples.length) { out.push(''); out.push('## Unexplained samples'); for (const s of samples.slice(0, 10)) out.push(JSON.stringify(s)); }
	const txt = out.join('\n');
	fs.writeFileSync(path.join(dir, 'summary.md'), txt + '\n');
	process.stdout.write(txt + '\n');
}

main();
