'use strict';
// VERSUS THE BEST KNOWN (n5-perfect, part 5): replays a compiled route and a known route of the same level in the engine
// and lines them up trigger by trigger: where the known route gains its ticks (which segment, the inputs it uses there,
// jumps / wall contacts / deaths / idle ticks), so a recurring trick becomes a move shape in the compiler. A tool only.
//
//   node tools/cmp/versus.js <level.eelvl | .json> <ours.eetas> <known.eetas> [--trace=a-b] [--json]
//
// Per trigger (the route events of truthset.js, deaths / checkpoints / effects included): the tick in each route, the
// segment's ticks, and per segment the input census (idle, left, right, jump presses, jump holds) and the ball's motion
// (grounded ticks, wall-stopped ticks, the peak |vx|, the fall). --trace=a-b prints both routes' states tick by tick.
const path = require('path');
const C = require('../../src/common.js');
const E = C.E;
const T = require('../../src/plan/types.js');
const TS = require('../../src/plan/truthset.js');

function loadL(f) { return /\.json$/i.test(f) ? E.loadLevel(f) : T.loadLevelFile(f); }

/** per-tick states of a route: x, y, vx, vy, the mask, grounded (the ball stood: vy 0 and blocked below) */
function states(L, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const out = [{ t: 0, x: sim.px, y: sim.py, vx: sim.speed_x, vy: sim.speed_y, m: 0 }];
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		out.push({ t: t + 1, x: sim.px, y: sim.py, vx: sim.speed_x, vy: sim.speed_y, m: masks[t] & 31, run: sim.run_ticks });
		if (sim.has_silver_crown) break;
	}
	return out;
}

function census(st, a, b) {
	const c = { ticks: b - a, idle: 0, left: 0, right: 0, jumpPress: 0, jump: 0, up: 0, down: 0, still: 0, peakVx: 0, dy: 0 };
	let prevJ = false;
	for (let t = a + 1; t <= b && t < st.length; t++) {
		const s = st[t], m = s.m;
		if (!m) c.idle++;
		if (m & 2) c.left++;
		if (m & 4) c.right++;
		if (m & 8) c.up++;
		if (m & 16) c.down++;
		if (m & 1) { c.jump++; if (!prevJ) c.jumpPress++; }
		prevJ = !!(m & 1);
		if (s.vx === 0 && s.vy === 0) c.still++;
		c.peakVx = Math.max(c.peakVx, Math.abs(s.vx));
	}
	if (st[a] && st[Math.min(b, st.length - 1)]) c.dy = +(st[Math.min(b, st.length - 1)].y - st[a].y).toFixed(1);
	c.peakVx = +c.peakVx.toFixed(2);
	return c;
}

function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
	const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
	const [lf, fa, fb] = args;
	const L = loadL(lf);
	const A = C.readEetas(fa), B = C.readEetas(fb);
	const ra = TS.routeEvents(L, A, {}), rb = TS.routeEvents(L, B, {});
	const sa = states(L, A), sb = states(L, B);
	const oa = TS.orderOf(ra.events, { all: true }), ob = TS.orderOf(rb.events, { all: true });
	const out = { level: path.basename(lf), ours: { file: fa, complete: ra.complete, runTicks: ra.runTicks, deaths: ra.deaths, n: oa.length },
		known: { file: fb, complete: rb.complete, runTicks: rb.runTicks, deaths: rb.deaths, n: ob.length }, rows: [] };
	const W = L.width;
	const fmtE = (e) => `${e.feat}:${e.value}${typeof e.tile === 'number' ? ` (${e.tile % W},${Math.floor(e.tile / W)})` : ''}`;
	if (!opt.json) {
		console.log(`${out.level}: ours complete ${ra.complete} run ${ra.runTicks} deaths ${ra.deaths}; known complete ${rb.complete} run ${rb.runTicks} deaths ${rb.deaths}`);
		console.log('ours  order: ' + oa.map((e) => `${e.tick} ${fmtE(e)}`).join(' | '));
		console.log('known order: ' + ob.map((e) => `${e.tick} ${fmtE(e)}`).join(' | '));
		const seg = (st, o, lbl) => {
			let prev = 0;
			const marks = [...o.map((e) => ({ t: e.tick, e })), { t: st.length - 1, e: { feat: 'FINISH', value: '', tile: '' } }];
			for (const mk of marks) {
				const c = census(st, prev, mk.t);
				console.log(`  ${lbl} ${String(prev).padStart(5)}-${String(mk.t).padEnd(5)} ${String(c.ticks).padStart(4)}t -> ${fmtE(mk.e).padEnd(28)} idle ${c.idle} L ${c.left} R ${c.right} U ${c.up} D ${c.down} jumps ${c.jumpPress}/${c.jump} still ${c.still} peak|vx| ${c.peakVx} dy ${c.dy}`);
				prev = mk.t;
			}
		};
		seg(sa, oa, 'ours ');
		seg(sb, ob, 'known');
		if (opt.lead !== undefined) {
			// THE LEAD CURVE: every `lead` ticks of the known route (default 50) the first tick of ours (after the previous
			// match: monotone) whose ball is within R px (--r, 24) of the known ball there; the lost ticks per stretch
			const step = +opt.lead > 0 ? +opt.lead : 50, R = +opt.r > 0 ? +opt.r : 24;
			let j = 0, prevK = 0, prevJ = 0;
			const rows = [];
			for (let k = step; k < sb.length; k += step) {
				const b = sb[k];
				let m = -1;
				for (let q = j; q < sa.length; q++) { const a = sa[q]; if (Math.abs(a.x - b.x) <= R && Math.abs(a.y - b.y) <= R) { m = q; break; } }
				if (m < 0) { rows.push(`  known ${String(k).padStart(5)} (${((b.x + 8) >> 4)},${((b.y + 8) >> 4)}) ours: never after ${j}`); continue; }
				const lost = (m - prevJ) - (k - prevK);
				rows.push(`  known ${String(k).padStart(5)} (${String((b.x + 8) >> 4).padStart(3)},${String((b.y + 8) >> 4).padStart(3)}) ours ${String(m).padStart(5)} behind ${String(m - k).padStart(5)} this stretch ${lost >= 0 ? '+' : ''}${lost}  ours ${census(sa, prevJ, m).idle}i/${census(sa, prevJ, m).jumpPress}j known ${census(sb, prevK, k).idle}i/${census(sb, prevK, k).jumpPress}j`);
				prevK = k; prevJ = m; j = m;
			}
			console.log(`lead curve (every ${step} known ticks, within ${R} px):`);
			console.log(rows.join('\n'));
		}
		if (opt.trace) {
			const [a, b] = String(opt.trace).split('-').map(Number);
			for (let t = a; t <= b; t++) {
				const x = sa[t], y = sb[t];
				const f = (s) => s ? `${s.m.toString().padStart(2)} ${s.x.toFixed(2).padStart(8)} ${s.y.toFixed(2).padStart(8)} ${s.vx.toFixed(3).padStart(7)} ${s.vy.toFixed(3).padStart(7)} (${(s.x + 8) >> 4},${(s.y + 8) >> 4})` : '-';
				console.log(`${String(t).padStart(5)} | ${f(x).padEnd(52)} | ${f(y)}`);
			}
		}
	} else {
		out.ours.order = oa; out.known.order = ob;
		console.log(JSON.stringify(out));
	}
}
if (require.main === module) main();
module.exports = { states, census };
