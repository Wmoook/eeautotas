'use strict';
// THE ENGINE CHECKS of FIELD KINEMATICS (src/math/fields.js, docs/ee_math.md section 4). Every statement the field
// tables and the field solver use is checked here against src/eesim.js itself, bit for bit (===, no tolerance):
//   F1  every field (air, the 4 arrows, dots, climbables, the 4 liquids, the 4 boosts) x effect sets (plain, speed x1.5 /
//       x0.6, zombie, low gravity, flip 1-4 where the field's pull rotates) x start states: EVERY input pattern with <= 2
//       changes of length T on one axis's own channel (h for x, v for y), the other channel random (jump bits too):
//       the engine's px, py, speed_x, speed_y after every tick == the field model (fieldCtx + vStep + pStep) on both axes
//   F2  THE CLASSIFICATION: over the reachable speed sets, which axis contexts are the same recurrence, or the mirror of
//       one (THEOREM F2): the arrows are the plain axes rotated / reflected, dots / flip 4 / boosts' cross axis FREE, ...
//   F3  THE ENVELOPE (THEOREM F3): every word over the 3 inputs of length <= D from each start lies inside the envelope
//       (speeds exactly, positions within ALIGN_SLACK where armable; the largest align overshoot is reported)
//   F4  the fixed points of every held input, and the release's stop, played by the engine (speed after every tick)
//   F5  FIELD BOUNDARIES: rooms of two fields side by side (left / right and top / bottom halves), sticky random inputs
//       across the boundary: the engine == pathEval (the per-tick context from the position, the gravity queue's 2-tick
//       delay (1 in dots / climbables), the ice timer) on every tick pathEval evaluates
//   F6  the axis solver: random patterns' exact end positions are found (complete), every answer's claimed state is its
//       evaluation (sound), and answers replayed by the engine end where the solver says
// Usage: node test/fields_theorems.js [--quick] [--only=F1,F2,...] [--T=32] [--shard=i/n] [--seed=1]  (exit 1 on a mismatch)
const E = require('../src/eesim.js');
const K = require('../src/plan/kin.js');
const K1 = require('../src/plan/kin1d.js');
const F = require('../src/math/fields.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const QUICK = !!argv.quick;
const ONLY = (argv.only || 'F1,F2,F3,F4,F5,F6').split(',');
const T1 = +(argv.T || (QUICK ? 16 : 32));
const D3 = +(argv.D || (QUICK ? 7 : 9));
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
let seed = +(argv.seed || 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

let fails = 0, checks = 0;
const failLog = [];
function fail(msg) { fails++; if (failLog.length < 40) failLog.push(msg); }
const report = {};

// ---------------------------------------------------------------- rooms
function b64(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'); }
function f64hex(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b.toString('hex'); }
function mkLevel({ W, H, fg, gravity = 1 }) {
	const d = { format: 'eesim-level-1', level_id: 'fields', width: W, height: H, gravity_hex: f64hex(gravity), gravity,
		fg_b64: b64(fg), bg_b64: b64(new Int32Array(W * H)), extras: [], lookup_int: [], spawn_points: [[[2, 2]]], portals: [] };
	return E.prepareLevel(d, { start: 'load' });
}
const RW = 260;   // the field room: RW x RW tiles of one tile id inside a border (the ball starts near its middle, 2000 px)
const rooms = new Map();
function roomOf(id) {
	if (rooms.has(id)) return rooms.get(id);
	const W = RW, H = RW, fg = new Int32Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fg[y * W + x] = (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? 9 : id;
	const L = mkLevel({ W, H, fg });
	const sim = new E.EESim(L); sim.reset();
	const r = { L, sim, base: sim.snapshot() };
	rooms.set(id, r);
	return r;
}
const inp = new E.EEInput();
function place(r, id, x0, vx0, y0, vy0, fx) {
	const s = r.sim;
	s.restore(r.base);
	s.px = x0; s.py = y0; s.speed_x = vx0; s.speed_y = vy0;
	s._q0 = id; s._q1 = id; s._slippery = 0; s.jump_count = 1; s.max_jumps = 1; s.on_ground = false;
	s._loopCollided = false; s._last_portal_set = false;
	s._pastx = Math.trunc(x0 + 8) >> 4; s._pasty = Math.trunc(y0 + 8) >> 4;
	s.flip_gravity = fx.flip || 0; s.speed_boost = fx.sb || 0; s.is_zombie = !!fx.zombie; s.low_gravity = !!fx.lowg;
	s.jump_boost = fx.jb || 0; s.is_invulnerable = true;   // lava / toxic: no kill, no fire (physics unchanged)
	return s;
}
const tickM = (s, m) => { E.applyMask(inp, m); s.tick(inp); };

// the contexts: every field x the effect sets that change its maps
const FX = [{}, { sb: 1 }, { sb: 2 }, { zombie: true }, { lowg: true }];
const FLIPS = [{ flip: 1 }, { flip: 2 }, { flip: 3 }, { flip: 4 }];
function contexts() {
	const out = [];
	for (const c of F.CLASSES) {
		const id = F.REP[c];
		for (const fx of FX) out.push({ c, id, fx });
		if (c === 'air' || c === 'water' || c === 'mud' || c === 'lava' || c === 'toxic') for (const fx of FLIPS) out.push({ c, id, fx });
		if (c === 'air') for (const fx of FLIPS) out.push({ c, id, fx: Object.assign({ sb: 1, lowg: true }, fx) });
	}
	return out;
}
const CTXS = contexts();
function schedOf(ctx, T) {
	return F.schedule({ cur: ctx.id, q0: ctx.id, q1: ctx.id, flip: ctx.fx.flip | 0, sb: ctx.fx.sb | 0, zombie: !!ctx.fx.zombie,
		lowGravity: !!ctx.fx.lowg, jb: ctx.fx.jb | 0 }, T);
}
// patterns with <= 2 changes of length T (kin1d codes)
function patterns(T, kmax = 2) {
	const out = [];
	for (let m0 = 0; m0 < 3; m0++) {
		out.push(K1.encode([[m0, T]]));
		if (kmax < 1) continue;
		for (let m1 = 0; m1 < 3; m1++) {
			if (m1 === m0) continue;
			for (let c1 = 1; c1 < T; c1++) {
				out.push(K1.encode([[m0, c1], [m1, T - c1]]));
				if (kmax < 2) continue;
				for (let m2 = 0; m2 < 3; m2++) {
					if (m2 === m1) continue;
					for (let c2 = c1 + 1; c2 < T; c2++) out.push(K1.encode([[m0, c1], [m1, c2 - c1], [m2, T - c2]]));
				}
			}
		}
	}
	return out;
}
const idx = (h) => (h < 0 ? 1 : h > 0 ? 2 : 0);

// ---------------------------------------------------------------- F1 every field, every <= 2-change pattern, the engine
function testF1() {
	const T = T1, pats = patterns(T);
	let runs = 0, ticks = 0;
	const starts = [[2000.0, 0, 2000.0, 0], [2003.37, 2.5, 2011.83, -3.1], [1995.123456789, -6.7, 2001.9, 9.3], [2008.5, 0.4, 2007.25, -0.6]];
	const t0 = Date.now();
	let job = 0;
	for (const ctx of CTXS) {
		const S = schedOf(ctx, T);
		const r = roomOf(ctx.id);
		for (const st of (QUICK ? starts.slice(0, 2) : starts)) {
			for (let axis = 0; axis < 2; axis++) {
				if ((job++ % NSH) !== SH) continue;
				const Ax = S.x, Ay = S.y;
				for (let pi = 0; pi < pats.length; pi++) {
					const code = pats[pi];
					// the masks: this axis' channel from the pattern, the other channel sticky random, jump bits random
					const masks = new Uint8Array(T);
					let other = Math.floor(rnd() * 3);
					for (let t = 0; t < T; t++) {
						if (rnd() < 0.2) other = Math.floor(rnd() * 3);
						const mi = K1.inputAt(code, t + 1);
						const hi = axis === 0 ? mi : other, vi = axis === 0 ? other : mi;
						masks[t] = (hi === 1 ? 2 : hi === 2 ? 4 : 0) | (vi === 1 ? 8 : vi === 2 ? 16 : 0) | (rnd() < 0.3 ? 1 : 0);
					}
					const s = place(r, ctx.id, st[0], st[1], st[2], st[3], ctx.fx);
					let px = st[0], vx = st[1], py = st[2], vy = st[3];
					for (let t = 1; t <= T; t++) {
						const m = masks[t - 1];
						tickM(s, m);
						const ix = idx(((m & 2) ? -1 : 0) + ((m & 4) ? 1 : 0)), iy = idx(((m & 8) ? -1 : 0) + ((m & 16) ? 1 : 0));
						vx = F.vStep(vx, ix, Ax[t]); px = F.pStep(px, vx, ix, Ax[t]);
						vy = F.vStep(vy, iy, Ay[t]); py = F.pStep(py, vy, iy, Ay[t]);
						checks++; ticks++;
						if (s.px !== px || s.speed_x !== vx || s.py !== py || s.speed_y !== vy) {
							fail(`F1 ${ctx.c} ${JSON.stringify(ctx.fx)} start ${st} axis ${axis} pattern ${K1.str(code, T)} tick ${t}: engine (${s.px}, ${s.speed_x}, ${s.py}, ${s.speed_y}) model (${px}, ${vx}, ${py}, ${vy})`);
							break;
						}
					}
					runs++;
					if (fails > 20) return;
				}
			}
		}
	}
	report.F1 = { contexts: CTXS.length, patterns: pats.length, T, runs, ticks, ms: Date.now() - t0 };
	console.log(`F1 ${CTXS.length} field contexts x starts x 2 axes x ${pats.length} patterns (<= 2 changes, T ${T}): ${runs.toLocaleString()} runs, ${ticks.toLocaleString()} engine ticks, both axes compared every tick: ${fails} mismatches (${Date.now() - t0} ms)`);
}

// ---------------------------------------------------------------- F2 the classification of the axis recurrences
function speedSet(ctxs, depth, cap) {
	// the closure from rest and from +-16 / J under every axis context's 3 inputs, to `depth`, plus edge doubles
	const set = new Set([0, 16, -16, 6.707946336429309, -6.707946336429309, 1e-4, -1e-4, 0.00010000000000000002, 22.72, -22.72]);
	let frontier = [...set];
	for (let d = 0; d < depth && set.size < cap; d++) {
		const next = [];
		for (const v of frontier) for (const A of ctxs) for (let i = 0; i < 3; i++) {
			const w = F.vStep(v, i, A);
			if (!set.has(w)) { set.add(w); next.push(w); if (set.size >= cap) break; }
		}
		frontier = next;
	}
	for (let i = 0; i < 20000; i++) set.add((rnd() * 2 - 1) * 16);
	return [...set];
}
function testF2() {
	const axes = [];
	for (const ctx of CTXS) {
		const c = F.fieldCtx({ cur: ctx.id, del: ctx.id, flip: ctx.fx.flip | 0, sb: ctx.fx.sb | 0, zombie: !!ctx.fx.zombie, lowGravity: !!ctx.fx.lowg });
		axes.push({ name: `${ctx.c}${Object.keys(ctx.fx).length ? JSON.stringify(ctx.fx) : ''}.x`, A: c.x });
		axes.push({ name: `${ctx.c}${Object.keys(ctx.fx).length ? JSON.stringify(ctx.fx) : ''}.y`, A: c.y });
	}
	const V = speedSet(axes.map((a) => a.A), QUICK ? 3 : 6, QUICK ? 20000 : 80000);
	// the canonical signature of a recurrence: its values on V under the 3 inputs (a mirror maps input 1 <-> 2, negates)
	const same = (A, Bc) => { for (const v of V) for (let i = 0; i < 3; i++) if (F.vStep(v, i, A) !== F.vStep(v, i, Bc)) return false; return true; };
	const mir = (A, Bc) => { const M = [0, 2, 1]; for (const v of V) for (let i = 0; i < 3; i++) { const a = F.vStep(-v, M[i], Bc), b = -F.vStep(v, i, A); if (a !== b) return false; } return true; };
	// THEOREM F2 on every context: the mirror field (negated pulls) is the negated recurrence
	let mbad = 0;
	for (const a of axes) { checks++; if (!mir(a.A, F.mirror(a.A))) { mbad++; fail(`F2 mirror ${a.name}`); } }
	// the classes: group every axis context with an earlier one it equals or mirrors
	const groups = [];
	for (const a of axes) {
		let g = groups.find((gr) => same(gr.rep.A, a.A));
		if (g) { g.same.push(a.name); continue; }
		g = groups.find((gr) => mir(gr.rep.A, a.A));
		if (g) { g.mirror.push(a.name); continue; }
		groups.push({ rep: a, kind: F.kindOf(a.A), d: F.describe(a.A), same: [a.name], mirror: [] });
	}
	report.F2 = { speeds: V.length, axes: axes.length, mirrorBad: mbad, classes: groups.map((g) => ({ rep: g.rep.name, kind: g.kind, release: g.d.release, along: g.d.along, against: g.d.against, same: g.same, mirror: g.mirror })) };
	console.log(`F2 ${axes.length} axis contexts over ${V.length.toLocaleString()} speeds: THEOREM F2 (mirror) ${mbad} failures; ${groups.length} distinct recurrences up to the mirror:`);
	for (const g of groups) console.log(`   ${g.kind.padEnd(10)} ${g.d.release}/${g.d.along}/${g.d.against}  = ${g.same.slice(0, 6).join(', ')}${g.same.length > 6 ? ` (+${g.same.length - 6})` : ''}${g.mirror.length ? `; mirror: ${g.mirror.slice(0, 6).join(', ')}${g.mirror.length > 6 ? ` (+${g.mirror.length - 6})` : ''}` : ''}`);
	// the arrows are the plain axes: arrowL.y = arrowR.y = arrowU.x = air.x; arrowL.x = mirror(air.y) = mirror(arrowR.x) ...
	const byName = new Map(axes.map((a) => [a.name, a.A]));
	const expect = [['arrowL.y', 'air.x', 'same'], ['arrowR.y', 'air.x', 'same'], ['arrowU.x', 'air.x', 'same'], ['arrowD.x', 'air.x', 'same'],
		['arrowR.x', 'air.y', 'same'], ['arrowD.y', 'air.y', 'same'], ['arrowL.x', 'air.y', 'mirror'], ['arrowU.y', 'air.y', 'mirror'],
		['dot.y', 'dot.x', 'same'], ['boostU.x', 'dot.x', 'same'], ['boostL.y', 'dot.x', 'same'], ['air{"flip":4}.x', 'dot.x', 'same'],
		['air{"flip":2}.y', 'air.y', 'mirror'], ['air{"flip":1}.x', 'air.y', 'mirror'], ['air{"flip":3}.x', 'air.y', 'same'], ['climb.y', 'climb.x', 'same']];
	for (const [a, b, how] of expect) {
		checks++;
		const ok = how === 'same' ? same(byName.get(a), byName.get(b)) : mir(byName.get(b), byName.get(a));
		if (!ok) fail(`F2 expected ${a} ${how} ${b}`);
		console.log(`   ${a} is the ${how} of ${b}: ${ok ? 'yes' : 'NO'}`);
	}
}

// ---------------------------------------------------------------- F3 the envelope
function testF3() {
	let words = 0, over = 0, worst = 0, tight = 0, tightN = 0;
	const t0 = Date.now();
	const starts = [[2000, 0], [2003.37, 2.5], [2007.9, -0.7], [1998.25, 9.3], [2001.5, -13]];
	let job = 0;
	for (const ctx of CTXS) {
		const S = schedOf(ctx, D3);
		for (const Ax of [S.x, S.y]) {
			for (const [p0, v0] of starts) {
				if ((job++ % NSH) !== SH) continue;
				const e = F.envelope(p0, v0, D3, Ax);
				// every word by DFS
				const rec = (t, p, v) => {
					if (t > 0) {
						checks++;
						if (v < e.vlo[t] || v > e.vhi[t]) { over++; fail(`F3 speed outside the envelope ${ctx.c} ${JSON.stringify(ctx.fx)} t ${t} v ${v} [${e.vlo[t]}, ${e.vhi[t]}]`); }
						const out = Math.max(e.plo[t] - p, p - e.phi[t], 0);
						if (out > 0) { if (!e.armable[t]) { over++; fail(`F3 position outside (not armable) ${ctx.c} t ${t}`); } if (out > worst) worst = out; }
						if (out > F.ALIGN_SLACK) { over++; fail(`F3 overshoot ${out} > slack`); }
					}
					if (t === D3) { words++; return; }
					const A = Ax[t + 1];
					for (let i = 0; i < 3; i++) { const w = F.vStep(v, i, A); rec(t + 1, F.pStep(p, w, i, A), w); }
				};
				rec(0, p0, v0);
				// tightness: is hi attained by some held input (the key order)?
				const hp = Math.max(F.holdAxis(p0, v0, 2, D3, Ax)[0], F.holdAxis(p0, v0, 1, D3, Ax)[0], F.holdAxis(p0, v0, 0, D3, Ax)[0]);
				tightN++; if (hp === e.phi[D3]) tight++;
			}
		}
	}
	report.F3 = { words, over, worstAlign: worst, tightHold: tight, of: tightN, ms: Date.now() - t0 };
	console.log(`F3 THEOREM F3 over every word of length ${D3} (3 inputs) from 5 starts in every context: ${words.toLocaleString()} words, ${over} outside the envelope; largest align overshoot ${worst} px (<= ${F.ALIGN_SLACK}); the envelope's top attained by a held input in ${tight} of ${tightN} (context, start) cases (${Date.now() - t0} ms)`);
}

// ---------------------------------------------------------------- F4 fixed points in the engine
function testF4() {
	const t0 = Date.now();
	let n = 0, ticks = 0;
	const rows = [];
	let job = 0;
	for (const ctx of CTXS) {
		if ((job++ % NSH) !== SH) continue;
		const c = F.fieldCtx({ cur: ctx.id, del: ctx.id, flip: ctx.fx.flip | 0, sb: ctx.fx.sb | 0, zombie: !!ctx.fx.zombie, lowGravity: !!ctx.fx.lowg });
		const r = roomOf(ctx.id);
		for (const [axis, A] of [['x', c.x], ['y', c.y]]) {
			for (const i of [0, 1, 2]) {
				for (const v0 of [0, 16, -16]) {
					const fp = F.fixedPoint(A, i, v0);
					if (fp.tick < 0) { fail(`F4 no fixed point ${ctx.c} ${axis} ${i} from ${v0}`); continue; }
					// the engine from v0 on this axis holding input i (the other axis released), px / py pulled back to the room's middle
					const s = place(r, ctx.id, 2000, axis === 'x' ? v0 : 0, 2000, axis === 'y' ? v0 : 0, ctx.fx);
					const m = axis === 'x' ? (i === 1 ? 2 : i === 2 ? 4 : 0) : (i === 1 ? 8 : i === 2 ? 16 : 0);
					let v = v0, ok = true;
					for (let t = 1; t <= fp.tick + 3; t++) {
						tickM(s, m);
						v = F.vStep(v, i, A);
						ticks++;
						const ev = axis === 'x' ? s.speed_x : s.speed_y;
						if (ev !== v) { ok = false; fail(`F4 ${ctx.c} ${JSON.stringify(ctx.fx)} ${axis} input ${i} from ${v0} tick ${t}: engine ${ev} model ${v}`); break; }
						if ((t & 31) === 0) { s.px = 2000 + (s.px % 16); s.py = 2000 + (s.py % 16); }
					}
					checks++; n++;
					if (ok && ctx.fx && Object.keys(ctx.fx).length === 0 && v0 === 0) rows.push(`${ctx.c}.${axis} ${['-', 'neg', 'pos'][i]}: ${fp.v} at tick ${fp.tick}`);
				}
			}
		}
	}
	report.F4 = { fixedPoints: n, ticks, ms: Date.now() - t0 };
	console.log(`F4 ${n} fixed points (every context x axis x input x start 0 / +-16) replayed by the engine: ${ticks.toLocaleString()} ticks (${Date.now() - t0} ms)`);
	if (argv.verbose) for (const r of rows) console.log('   ' + r);
}

// ---------------------------------------------------------------- F5 field boundaries
function testF5() {
	const pairsCls = ['air', 'arrowL', 'arrowU', 'arrowR', 'arrowD', 'dot', 'climb', 'water', 'mud', 'boostL', 'boostU', 'boostR', 'boostD'];
	const t0 = Date.now();
	let runs = 0, ticks = 0, crossings = 0, stopped = 0;
	const RUNS = QUICK ? 6 : 40, TT = 90;
	let job = 0;
	const W = 120, H = 120;
	const cache = new Map();
	for (const a of pairsCls) for (const b of pairsCls) for (const split of ['v', 'h']) {
		if (a === b) continue;
		if ((job++ % NSH) !== SH) continue;
		const fg = new Int32Array(W * H);
		const ia = F.REP[a], ib = F.REP[b];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
			fg[y * W + x] = border ? 9 : ((split === 'v' ? x < 60 : y < 60) ? ia : ib);
		}
		const L = mkLevel({ W, H, fg });
		const sim = new E.EESim(L); sim.reset();
		const base = sim.snapshot();
		for (let k = 0; k < RUNS; k++) {
			sim.restore(base);
			const along = 40 + Math.floor(rnd() * 40), off = 2 + Math.floor(rnd() * 6);
			const bx = split === 'v' ? (60 - off) * 16 + rnd() * 16 : along * 16 + rnd() * 16;
			const by = split === 'v' ? along * 16 + rnd() * 16 : (60 - off) * 16 + rnd() * 16;
			const fx = FX[Math.floor(rnd() * FX.length)];
			sim.px = bx; sim.py = by; sim.speed_x = (rnd() * 2 - 1) * 6; sim.speed_y = (rnd() * 2 - 1) * 6;
			sim._q0 = ia; sim._q1 = ia; sim._slippery = 0; sim.jump_count = 1; sim.max_jumps = 1; sim.on_ground = false;
			sim._loopCollided = false; sim._last_portal_set = false; sim._pastx = Math.trunc(bx + 8) >> 4; sim._pasty = Math.trunc(by + 8) >> 4;
			sim.speed_boost = fx.sb || 0; sim.is_zombie = !!fx.zombie; sim.low_gravity = !!fx.lowg; sim.is_invulnerable = true;
			const st = K.fromSim(sim);
			// sticky random inputs biased toward the boundary
			const masks = new Uint8Array(TT);
			let m = 0;
			for (let t = 0; t < TT; t++) {
				if (t === 0 || rnd() < 0.15) {
					const h = rnd() < 0.5 ? (split === 'v' ? 2 : 0) : [0, 1, 2][Math.floor(rnd() * 3)];
					const v = rnd() < 0.5 ? (split === 'h' ? 2 : 0) : [0, 1, 2][Math.floor(rnd() * 3)];
					m = (h === 1 ? 2 : h === 2 ? 4 : 0) | (v === 1 ? 8 : v === 2 ? 16 : 0) | (rnd() < 0.2 ? 1 : 0);
				}
				masks[t] = m;
			}
			const pe = F.pathEval(L, st, masks, { cache });
			let crossed = false;
			for (let t = 1; t <= pe.n; t++) {
				tickM(sim, masks[t - 1]);
				ticks++; checks++;
				if (sim.px !== pe.xs[t] || sim.py !== pe.ys[t] || sim.speed_x !== pe.vxs[t] || sim.speed_y !== pe.vys[t]) {
					fail(`F5 ${a}|${b} ${split} run ${k} tick ${t}: engine (${sim.px}, ${sim.py}, ${sim.speed_x}, ${sim.speed_y}) pathEval (${pe.xs[t]}, ${pe.ys[t]}, ${pe.vxs[t]}, ${pe.vys[t]})`);
					break;
				}
				if (F.classOfId(pe.cur[t]) === b) crossed = true;
			}
			if (pe.why !== 'end') stopped++;
			if (crossed) crossings++;
			runs++;
			if (fails > 20) return;
		}
	}
	report.F5 = { runs, ticks, crossings, stopped, ms: Date.now() - t0 };
	console.log(`F5 two-field rooms (13 x 12 field pairs x 2 splits): ${runs} runs, ${ticks.toLocaleString()} ticks compared, ${crossings} runs crossed the boundary (${stopped} stopped by pathEval at a wall / the edge): ${fails} mismatches (${Date.now() - t0} ms)`);
}

// ---------------------------------------------------------------- F6 the axis solver
function testF6() {
	const t0 = Date.now();
	let n = 0, found = 0, answers = 0, replayed = 0;
	const N = QUICK ? 60 : 400;
	for (let k = 0; k < N; k++) {
		if ((k % NSH) !== SH) continue;
		const ctx = CTXS[Math.floor(rnd() * CTXS.length)];
		const T = 8 + Math.floor(rnd() * (QUICK ? 30 : 56));
		const S = schedOf(ctx, T);
		const axis = rnd() < 0.5 ? 'x' : 'y';
		const As = S[axis];
		const p0 = 2000 + rnd() * 16, v0 = (rnd() * 2 - 1) * 8;
		// a random pattern with <= 2 changes
		const runs = [];
		let left = T, mi = Math.floor(rnd() * 3);
		const kk = Math.floor(rnd() * 3);
		for (let j = 0; j <= kk && left > 0; j++) {
			const len = j === kk ? left : 1 + Math.floor(rnd() * Math.max(1, left - (kk - j)));
			runs.push([mi, Math.min(len, left)]); left -= Math.min(len, left);
			mi = (mi + 1 + Math.floor(rnd() * 2)) % 3;
		}
		if (left > 0) runs[runs.length - 1][1] += left;
		const code = K1.encode(runs);
		const e = F.evalAxis(p0, v0, code, T, As);
		const sol = F.solveAxis(p0, v0, T, e.p, e.p, As, { k: 2, limit: 32, vlo: e.v, vhi: e.v });
		n++; checks++;
		if (sol.find((s) => s.p === e.p && s.v === e.v)) found++; else fail(`F6 not found: ${ctx.c} ${axis} T ${T} ${K1.str(code, T)} -> ${e.p}`);
		for (const s of sol) {
			answers++;
			const f = F.evalAxis(p0, v0, s.code, T, As);
			if (f.p !== s.p || f.v !== s.v) fail(`F6 unsound answer ${s.str}`);
		}
		// the engine replays the first answer in the field room
		if (sol.length) {
			const s0 = sol[0];
			const r = roomOf(ctx.id);
			const s = place(r, ctx.id, axis === 'x' ? p0 : 2000, axis === 'x' ? v0 : 0, axis === 'y' ? p0 : 2000, axis === 'y' ? v0 : 0, ctx.fx);
			for (let t = 1; t <= T; t++) {
				const mi2 = K1.inputAt(s0.code, t);
				tickM(s, axis === 'x' ? (mi2 === 1 ? 2 : mi2 === 2 ? 4 : 0) : (mi2 === 1 ? 8 : mi2 === 2 ? 16 : 0));
			}
			replayed++; checks++;
			const ep = axis === 'x' ? s.px : s.py, ev = axis === 'x' ? s.speed_x : s.speed_y;
			if (ep !== s0.p || ev !== s0.v) fail(`F6 engine replay ${ctx.c} ${axis}: engine (${ep}, ${ev}) solver (${s0.p}, ${s0.v})`);
		}
	}
	report.F6 = { targets: n, found, answers, replayed, ms: Date.now() - t0 };
	console.log(`F6 the axis solver: ${found} of ${n} random pattern targets found (exact point targets, <= 2 changes), ${answers} answers all = their evaluation, ${replayed} replayed by the engine (${Date.now() - t0} ms)`);
}

const t0 = Date.now();
if (ONLY.includes('F1')) testF1();
if (ONLY.includes('F2') && SH === 0) testF2();
if (ONLY.includes('F3')) testF3();
if (ONLY.includes('F4')) testF4();
if (ONLY.includes('F5')) testF5();
if (ONLY.includes('F6')) testF6();
report.checks = checks; report.fails = fails; report.ms = Date.now() - t0; report.failLog = failLog;
if (argv.json) require('fs').writeFileSync(argv.json, JSON.stringify(report, null, 1));
console.log(`\n${checks.toLocaleString()} checks, ${fails} mismatches (${Date.now() - t0} ms)`);
for (const f of failLog) console.log('  FAIL ' + f);
process.exit(fails ? 1 : 0);
