'use strict';
// THE ENGINE CHECKS of the 1D movement mathematics (src/plan/kin1d.js, docs/ee_math.md "Reach1d"). Every theorem the
// tables and the solver use is checked here against src/eesim.js itself, bit for bit (===, no tolerance), in an empty
// room (free air: no tile within reach, default gravity):
//   S1  the input axis (x): every word over ALL 32 masks of length <= 3, and every word over {-, L, R} of length <= 9,
//       from each start state: the engine's px, speed_x after every tick == kin1d's recurrence (axisStep + P + align)
//   S2  the families: every pattern with <= 2 changes of length <= T2 (default 48) and random patterns with <= 3 and
//       with any number of changes up to 120 ticks, from each start state, every tick
//   SEP separability: in all of the above the y axis (py, speed_y) is the gravity-axis recurrence, whatever the
//       horizontal input and the jump bits (max_jumps 1), and x does not depend on the y state (two different y starts)
//   P   the sub-stepped move = one rounded addition: 1e5..1e6 single ticks from random doubles x0, v0 and a random input
//   G   the gravity axis: every jump class J(jm) and 0, 120 ticks, several y0; multi-jump (max_jumps 2, 3, 1000) with
//       the air jumps at every tick 1..40 (the jump sets vy = J exactly, the rest is the recurrence)
//   CTX speed x1.5 / x0.6 / zombie (x0.6, the key aligns), low gravity (the y axis aligns near the apex), a level
//       gravity 0.5 (float32), flip gravity 1 / 2 / 3 (the generic axisStep on the rotated axes)
//   M   THEOREM M: over every S2 family pattern, hold R / hold L bound x_t and v_t (exactly with no armed tick; the
//       largest overshoot with the align is reported and must stay <= ALIGN_SLACK = 2)
//   TAB the tables: buildTable rows (K 2, T 40) from x0 = 0 vs the engine from real x0: v exact, dx within t ulp, and
//       evalIA from the real x0 exact
// Usage: node test/kin1d_theorems.js [--quick] [--T2=48] [--shard=i/n] [--seed=1]   exit 1 on any mismatch
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const K = require('../src/plan/kin1d.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const QUICK = !!argv.quick;
const T2 = +(argv.T2 || (QUICK ? 24 : 48)), T3 = +(argv.T3 || (QUICK ? 12 : 24)), DEPTH = +(argv.depth || (QUICK ? 7 : 9));
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
let seed = +(argv.seed || 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

let fails = 0, checks = 0;
const failLog = [];
function fail(msg) { fails++; if (failLog.length < 30) failLog.push(msg); }

// the room: 420 x 420 tiles, a border only (solid 9), no spawn (the player starts at 16, 16 and is moved)
function room(gravity) {
	const W = 420, H = 420, cells = [];
	for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
	for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
	const lv = { name: 'room', width: W, height: H, cells };
	if (gravity !== undefined) lv.gravity = gravity;
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf(lv))));
}
const L1 = room();
const sim = new E.EESim(L1), inp = new E.EEInput();
const bases = new Map();
function place(s, x0, v0, y0, vy0, o = {}) {
	let b = bases.get(s);
	if (!b) { s.reset(); b = s.snapshot(); bases.set(s, b); }
	s.restore(b);
	s.px = x0; s.py = y0; s.speed_x = v0; s.speed_y = vy0;
	s._q0 = 0; s._q1 = 0; s._slippery = 0; s.jump_count = 1; s.max_jumps = o.maxJumps || 1; s.on_ground = false;
	s._loopCollided = false; s.flip_gravity = o.flip || 0;
	if (o.speedBoost) s.speed_boost = o.speedBoost;
	if (o.zombie) s.is_zombie = true;
	if (o.low) s.low_gravity = true;
}
const tick = (s, m) => { E.applyMask(inp, m); s.tick(inp); };
const hOf = (m) => ((m & 2) ? -1 : 0) + ((m & 4) ? 1 : 0);
const miOf = (h) => (h < 0 ? 1 : h > 0 ? 2 : 0);

// the start states: x0 (integers, fractions, near grid lines for the align, large), v0 (rest, slow, the align edge,
// run speeds, the cap, random)
const X0 = [1000, 1000.5, 1007.25, 1600 + 1e-9, 1615.9, 1614.3, 1601.7, 1602.1, 2345.678901234567, 4999.999999, 3200.19, 3215.81];
const VJ = K.ga().J;
const V0 = [0, 1e-5, -1e-5, 0.05, -0.05, 0.5, -0.5, 0.99, -0.99, 1, -1, 1.0000000001, 3.3, -3.3, 6.7, -6.7, 6.776, 13.9, -13.9, 16, -16];
for (let i = 0; i < (QUICK ? 4 : 12); i++) V0.push((rnd() * 2 - 1) * 8);
const Y0 = [3000, 3000.37];
const starts = [];
for (const x0 of X0) for (const v0 of V0) starts.push([x0, v0]);
const myStarts = starts.filter((_, i) => i % NSH === SH);

// the model's per-tick expectation of both axes (plain free air, default gravity)
const I1 = K.ia(), G1 = K.ga();
function checkTick(s, xm, vm, ym, vym, where) {
	checks++;
	if (s.px !== xm || s.speed_x !== vm) fail(`${where}: x engine (${s.px}, ${s.speed_x}) model (${xm}, ${vm})`);
	if (s.py !== ym || s.speed_y !== vym) fail(`${where}: y engine (${s.py}, ${s.speed_y}) model (${ym}, ${vym})`);
}

// ---------------------------------------------------------------- S1: exhaustive short words
function s1() {
	const t0 = Date.now(); let n0 = checks;
	for (const [x0, v0] of myStarts) {
		for (const y0 of Y0) {
			place(sim, x0, v0, y0, 0);
			const root = sim.snapshot();
			// all 32 masks, depth 3
			const dfs = (snap, depth, x, v, y, vy, word) => {
				if (depth === 0) return;
				for (let m = 0; m < 32; m++) {
					sim.restore(snap);
					tick(sim, m);
					const [xm, vm] = K.stepIA(x, v, miOf(hOf(m)), I1);
					const [ym, vym] = K.stepGA(y, vy, G1);
					checkTick(sim, xm, vm, ym, vym, `S1 x0=${x0} v0=${v0} y0=${y0} word=${word}${m.toString(32)}`);
					if (depth > 1) dfs(sim.snapshot(), depth - 1, xm, vm, ym, vym, word + m.toString(32));
				}
			};
			dfs(root, 3, x0, v0, y0, 0, '');
		}
		// {-, L, R} depth 9 (y0 fixed)
		place(sim, x0, v0, Y0[0], 0);
		const MASK = [0, 2, 4];
		const snaps = [];
		const dfs3 = (depth, x, v, y, vy) => {
			if (depth === DEPTH) return;
			snaps[depth] = sim.snapshot(snaps[depth]);
			for (let mi = 0; mi < 3; mi++) {
				sim.restore(snaps[depth]);
				tick(sim, MASK[mi]);
				const [xm, vm] = K.stepIA(x, v, mi, I1);
				const [ym, vym] = K.stepGA(y, vy, G1);
				checkTick(sim, xm, vm, ym, vym, `S1b x0=${x0} v0=${v0} d=${depth}`);
				dfs3(depth + 1, xm, vm, ym, vym);
			}
		};
		dfs3(0, x0, v0, Y0[0], 0);
	}
	console.log(`S1  exhaustive words (32 masks^3, {-,L,R}^${DEPTH}): ${checks - n0} tick checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- S2 + M: the families
const mStats = { maxOverAlign: 0, maxUnderAlign: 0, violNoArm: 0, vViol: 0, rows: 0 };
function s2(TT = T2, KK = 2) {
	const t0 = Date.now(); const n0 = checks;
	const MASK = [0, 2, 4];
	for (const [x0, v0] of myStarts) {
		place(sim, x0, v0, Y0[1], 0);
		// the extremes (hold L / hold R) per tick, for THEOREM M
		const hx = [[], [], []], hv = [[], [], []];
		for (const mi of [1, 2]) { let x = x0, v = v0; for (let t = 1; t <= TT; t++) { [x, v] = K.stepIA(x, v, mi, I1); hx[mi][t] = x; hv[mi][t] = v; } }
		const snaps = [];
		// DFS over patterns with <= 2 changes; the engine and the model side by side, the y axis too
		const rec = (t, x, v, y, vy, miPrev, k, arm) => {
			snaps[t] = sim.snapshot(snaps[t]);
			for (let mi = 0; mi < 3; mi++) {
				if (k > 0 && mi === miPrev) continue;
				sim.restore(snaps[t]);
				let xx = x, vv = v, yy = y, vvy = vy, a = arm;
				for (let j = t + 1; j <= TT; j++) {
					tick(sim, MASK[mi]);
					[xx, vv] = K.stepIA(xx, vv, mi, I1);
					if (mi === 0 && !(vv >= 1 || vv <= -1)) a = true;
					[yy, vvy] = K.stepGA(yy, vvy, G1);
					checkTick(sim, xx, vv, yy, vvy, `S2 x0=${x0} v0=${v0} t=${j} k=${k}`);
					mStats.rows++;
					// THEOREM M
					const over = xx - hx[2][j], under = hx[1][j] - xx;
					if (!a && (over > 0 || under > 0)) mStats.violNoArm++;
					if (over > mStats.maxOverAlign) mStats.maxOverAlign = over;
					if (under > mStats.maxUnderAlign) mStats.maxUnderAlign = under;
					if (vv > hv[2][j] || vv < hv[1][j]) mStats.vViol++;
					if (k < KK && j < TT) {
						const snapJ = sim.snapshot();
						rec(j, xx, vv, yy, vvy, mi, k + 1, a);
						sim.restore(snapJ);
					}
				}
			}
		};
		rec(0, x0, v0, Y0[1], 0, -1, 0, false);
	}
	console.log(`S2  every pattern with <= ${KK} changes up to ${TT} ticks: ${checks - n0} tick checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	console.log(`M   ${mStats.rows} pattern ticks: x beyond hold L / hold R without an armed tick: ${mStats.violNoArm}; v beyond: ${mStats.vViol}; ` +
		`largest overshoot with the align: +${mStats.maxOverAlign.toFixed(6)} / -${mStats.maxUnderAlign.toFixed(6)} px (slack ${K.ALIGN_SLACK})`);
	if (mStats.violNoArm || mStats.vViol || mStats.maxOverAlign > K.ALIGN_SLACK || mStats.maxUnderAlign > K.ALIGN_SLACK) fail('THEOREM M violated');
}

// random patterns: <= 3 changes and unrestricted, 120 ticks; jump bits and up/down bits sprinkled in (they must not matter)
function s2r() {
	const t0 = Date.now(); const n0 = checks;
	const reps = QUICK ? 3 : 20;
	for (const [x0, v0] of myStarts) {
		for (let r = 0; r < reps; r++) {
			const anyK = r % 2 === 1;
			const masks = [];
			let mi = Math.floor(rnd() * 3), k = 0;
			for (let t = 0; t < 120; t++) {
				if ((anyK ? rnd() < 0.2 : (k < 3 && rnd() < 0.03))) { const n = (mi + 1 + Math.floor(rnd() * 2)) % 3; mi = n; k++; }
				let m = [0, 2, 4][mi];
				if (rnd() < 0.3) m |= 1;                 // jump bit: no effect in the air with max_jumps 1
				if (rnd() < 0.2) m |= rnd() < 0.5 ? 8 : 16;   // up / down: no effect under gravity down
				if (rnd() < 0.05) m |= 6;                // L + R = no horizontal input
				masks.push(m);
			}
			place(sim, x0, v0, Y0[r % 2], 0);
			let x = x0, v = v0, y = Y0[r % 2], vy = 0;
			for (let t = 0; t < 120; t++) {
				tick(sim, masks[t]);
				[x, v] = K.stepIA(x, v, miOf(hOf(masks[t])), I1);
				[y, vy] = K.stepGA(y, vy, G1);
				checkTick(sim, x, v, y, vy, `S2r x0=${x0} v0=${v0} r=${r} t=${t + 1}`);
			}
			// the same pattern through evalIA (coded) when it has <= 3 changes
			const hs = masks.map((m) => miOf(hOf(m)));
			const runs = []; for (const h of hs) { if (runs.length && runs[runs.length - 1][0] === h) runs[runs.length - 1][1]++; else runs.push([h, 1]); }
			if (runs.length <= 4) {
				const e = K.evalIA(x0, v0, K.encode(runs), 120, I1);
				checks++;
				if (e.x !== sim.px || e.v !== sim.speed_x) fail(`S2r evalIA x0=${x0} v0=${v0} ${K.str(K.encode(runs), 120)}`);
			}
		}
	}
	console.log(`S2r random patterns (<= 3 changes / any), jump and up/down bits mixed in, 120 ticks: ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// separability: x does not depend on the y state (the same x pattern from two y starts, one falling fast)
function sep() {
	const t0 = Date.now(); const n0 = checks;
	const s2_ = new E.EESim(L1);
	for (const [x0, v0] of myStarts.slice(0, QUICK ? 20 : 1000)) {
		for (const vy0 of [0, VJ, 9.5]) {
			place(sim, x0, v0, 1000, 0); place(s2_, x0, v0, 2500.5, vy0);
			for (let t = 0; t < 100; t++) {
				const m = [0, 2, 4][Math.floor(rnd() * 3)] | (rnd() < 0.5 ? 1 : 0);
				tick(sim, m); tick(s2_, m & 6);
				checks++;
				if (sim.px !== s2_.px || sim.speed_x !== s2_.speed_x) fail(`SEP x differs with the y start: x0=${x0} v0=${v0} vy0=${vy0} t=${t + 1}`);
			}
		}
	}
	console.log(`SEP x independent of the y state and of the jump bit: ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- P: single ticks from random doubles
function pRandom() {
	const t0 = Date.now(); const n0 = checks;
	const n = QUICK ? 100000 : 1000000;
	for (let i = 0; i < n; i++) {
		if (i % NSH !== SH) continue;
		// x0: a random double in [16, 6700) with a random mantissa; v0 in [-16, 16]; y0 likewise
		const x0 = 48 + rnd() * 6550 + rnd() * 1e-6;
		const v0 = (rnd() * 2 - 1) * 16 * (rnd() < 0.2 ? rnd() * 1e-3 : 1);
		const y0 = 100 + rnd() * 6400, vy0 = (rnd() * 2 - 1) * 16;
		const m = [0, 2, 4][Math.floor(rnd() * 3)];
		place(sim, x0, v0, y0, vy0);
		tick(sim, m);
		const [xm, vm] = K.stepIA(x0, v0, miOf(hOf(m)), I1);
		const [ym, vym] = K.stepGA(y0, vy0, G1);
		checkTick(sim, xm, vm, ym, vym, `P x0=${x0} v0=${v0} y0=${y0} vy0=${vy0} m=${m}`);
	}
	console.log(`P   single ticks from random doubles (x0, v0, y0, vy0): ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- G: the gravity axis, jumps, multi-jump
function gAxis() {
	const t0 = Date.now(); const n0 = checks;
	const JMS = [1, 1.3, 0.75, 0.75 * 0.75, 1.3 * 0.88, 0.88];
	const classes = [0];
	for (const jm of JMS) classes.push(K.ga({ jm }).J);
	for (const vy0 of classes) {
		for (const y0 of [3000, 3000.5, 1600, 5000.123456789]) {
			if ((classes.indexOf(vy0) * 7 + y0 | 0) % NSH !== SH) continue;
			place(sim, 2000, 0, y0, vy0);
			const tr = { y: [], v: [] };
			K.evalGA(y0, vy0, 120, G1, null, tr);
			for (let t = 0; t < 120; t++) {
				tick(sim, 0);
				checks++;
				if (sim.py !== tr.y[t] || sim.speed_y !== tr.v[t]) fail(`G vy0=${vy0} y0=${y0} t=${t + 1}: engine (${sim.py}, ${sim.speed_y}) model (${tr.y[t]}, ${tr.v[t]})`);
			}
		}
	}
	// multi-jump: max_jumps 2 / 3 / 1000, air jumps at chosen ticks (jump_count starts at 1: in the air)
	for (const mj of [2, 3, 1000]) {
		for (let a = 1; a <= 40; a++) {
			for (const b of [0, a + 1, a + 7, a + 20]) {
				if ((mj * 131 + a * 7 + b) % NSH !== SH) continue;
				place(sim, 2000, 0, 3000, 0, { maxJumps: mj });
				const jumps = [a]; if (b) jumps.push(b);
				// which presses fire: jump_count < max_jumps (jump_count 1 in the air, +1 per jump below 1000)
				const fired = []; let jc = 1;
				for (const j of jumps) if (jc < mj) { fired.push(j); if (mj < 1000) jc++; }
				const tr = { y: [], v: [] };
				K.evalGA(3000, 0, 80, G1, fired, tr);
				for (let t = 1; t <= 80; t++) {
					tick(sim, jumps.includes(t) ? 1 : 0);
					checks++;
					if (sim.py !== tr.y[t - 1] || sim.speed_y !== tr.v[t - 1]) { fail(`G multi-jump mj=${mj} jumps=${jumps} t=${t}: engine (${sim.py}, ${sim.speed_y}) model (${tr.y[t - 1]}, ${tr.v[t - 1]})`); break; }
				}
			}
		}
	}
	console.log(`G   gravity axis: ${classes.length} start-speed classes x 4 y0 x 120 ticks + multi-jump timings: ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- CTX: other contexts through the generic axisStep
function ctxChecks() {
	const t0 = Date.now(); const n0 = checks;
	const Lg = room(0.5);
	const simG = new E.EESim(Lg);
	const cases = [
		{ name: 'speed x1.5', o: { speedBoost: 1 }, s: sim },
		{ name: 'speed x0.6', o: { speedBoost: 2 }, s: sim },
		{ name: 'zombie x0.6', o: { zombie: true }, s: sim },
		{ name: 'low gravity', o: { low: true }, s: sim },
		{ name: 'level gravity 0.5', o: {}, s: simG },
		{ name: 'flip 1 (left)', o: { flip: 1 }, s: sim },
		{ name: 'flip 2 (up)', o: { flip: 2 }, s: sim },
		{ name: 'flip 3 (right)', o: { flip: 3 }, s: sim },
	];
	for (const c of cases) {
		let n = 0;
		for (const [x0, v0] of myStarts.slice(0, QUICK ? 30 : 400)) {
			for (let r = 0; r < 3; r++) {
				const s = c.s;
				const vy0 = r === 0 ? 0 : (rnd() * 2 - 1) * 8;
				// flipped gravity: put the start well inside the room on both axes
				place(s, x0, v0, 3000 + r * 0.25, vy0, c.o);
				let x = x0, v = v0, y = s.py, vy = vy0;
				for (let t = 0; t < 60; t++) {
					const m = [0, 2, 4, 8, 16, 10, 20][Math.floor(rnd() * 7)];
					tick(s, m);
					// the context the engine computed this tick (the axis choice of 4.12 and the multipliers of 4.13)
					const mx = s._mx, my = s._my, mox = s.mox, moy = s.moy;
					v = K.axisStep(v, mx, mox, moy, 0, false); x += v;
					vy = K.axisStep(vy, my, moy, mox, 0, false); y += vy;
					if (K.armed(v, (mox + mx) / K.MULT, false)) x = K.align(x);
					if (K.armed(vy, (moy + my) / K.MULT, false)) y = K.align(y);
					checks++; n++;
					if (s.px !== x || s.speed_x !== v || s.py !== y || s.speed_y !== vy) {
						fail(`CTX ${c.name} x0=${x0} v0=${v0} t=${t + 1}: engine (${s.px}, ${s.speed_x}, ${s.py}, ${s.speed_y}) model (${x}, ${v}, ${y}, ${vy})`);
						break;
					}
				}
			}
		}
		console.log(`CTX ${c.name}: ${n} ticks`);
	}
	console.log(`CTX ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- TAB: the tables against the engine
function tabChecks() {
	const t0 = Date.now(); const n0 = checks;
	const T = QUICK ? 24 : 40;
	let maxDev = 0, armedRows = 0, rows = 0;
	for (const v0 of [0, 3.3, -6.7, K.holdX(0, 0, 2, 30) - K.holdX(0, 0, 2, 29)]) {
		const tab = K.buildTable(v0, { T, K: 2 });
		for (const x0 of [1000, 2345.678901234567, 1615.9]) {
			for (let t = 1; t <= T; t += (QUICK ? 5 : 1)) {
				const r = tab.ticks[t];
				for (let i = 0; i < r.dx.length; i += (QUICK ? 97 : 7)) {
					if ((t * 131 + i) % NSH !== SH) continue;
					const code = r.code[i] & 0x7fffffff, arm = (r.code[i] & 0x80000000) !== 0;
					place(sim, x0, v0, 3000, 0);
					for (let j = 1; j <= t; j++) tick(sim, [0, 2, 4][K.inputAt(code, j)]);
					checks++; rows++;
					const e = K.evalIA(x0, v0, code, t, I1);
					if (e.x !== sim.px || e.v !== sim.speed_x) fail(`TAB evalIA v0=${v0} x0=${x0} t=${t} ${K.str(code, t)}`);
					if (r.v[i] !== sim.speed_x) fail(`TAB v v0=${v0} t=${t} ${K.str(code, t)}: table ${r.v[i]} engine ${sim.speed_x}`);
					if (arm) armedRows++;
					else { const dev = Math.abs((sim.px - x0) - r.dx[i]); if (dev > maxDev) maxDev = dev; if (dev > 1e-9) fail(`TAB dx v0=${v0} x0=${x0} t=${t} ${K.str(code, t)} dev ${dev}`); }
				}
			}
		}
	}
	console.log(`TAB ${rows} table rows replayed by the engine: v exact, evalIA exact, nominal dx within ${maxDev.toExponential(2)} px (unarmed; ${armedRows} armed rows exact by evalIA), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- KIN: kin1d = src/plan/kin.js (the shared recurrences)
// axisStep is kin.stepV with the drag given by its kind; the position update x + v is kin.moveFree whenever the
// exponent of x is at least v's (THEOREM P: the sub-steps are exact, the last addition rounds once); align = kin.align
function kinChecks() {
	let KN = null;
	try { KN = require('../src/plan/kin.js'); } catch (e) { console.log('KIN (src/plan/kin.js not on this branch: skipped)'); return; }
	const t0 = Date.now(); const n0 = checks;
	const CUR = [0, 120, 119, 369, 416, 1585];   // drag kinds plain, climb, water, mud, lava, toxic -> a current tile id
	const n = QUICK ? 200000 : 3000000;
	let pBad = 0, pSmall = 0, pSmallN = 0;
	for (let i = 0; i < n; i++) {
		if (i % NSH !== SH) continue;
		const v = (rnd() * 2 - 1) * (rnd() < 0.3 ? rnd() * 2 : 17), m = [0, 1, -1, 1.5, -1.5, 0.6, -0.6, 0.36][Math.floor(rnd() * 8)];
		const mo = [0, 2, -2, 0.3, 0.4, -0.5, 0.2, -0.4, 2 * Math.fround(0.5)][Math.floor(rnd() * 9)], moO = [0, 2, -2, 0.3][Math.floor(rnd() * 4)];
		const drag = rnd() < 0.7 ? 0 : Math.floor(rnd() * 6), slip = rnd() < 0.15;
		const a = K.axisStep(v, m, mo, moO, drag, slip), b = KN.stepV(v, (mo + m) / K.MULT, m, moO, slip ? 2 : 0, CUR[drag], false);
		checks++;
		if (!Object.is(a, b)) fail(`KIN axisStep != kin.stepV: v=${v} m=${m} mo=${mo} moO=${moO} drag=${drag} slip=${slip}: ${a} vs ${b}`);
		// THEOREM P: x >= 16 and |v| <= 16 (then the exponent of x is at least v's)
		const x = 16 + rnd() * 6600 + (rnd() < 0.5 ? rnd() * 1e-7 : 0), w = (rnd() * 2 - 1) * 16;
		checks++;
		if (!Object.is(KN.moveFree(x, w, false), x + w)) { pBad++; fail(`P moveFree(${x}, ${w}) = ${KN.moveFree(x, w, false)} != x + v = ${x + w}`); }
		// below 16 px the claim is not made: count how often it would fail (a level's border column is solid)
		const xs = rnd() * 16, ws = (rnd() * 2 - 1) * 16;
		pSmallN++; if (!Object.is(KN.moveFree(xs, ws, false), xs + ws) && xs + ws >= 0) pSmall++;
		const xa = 16 + rnd() * 6600;
		checks++;
		if (!Object.is(K.align(xa), KN.align(xa, 0.5, 0, false))) fail(`KIN align(${xa})`);
	}
	console.log(`KIN axisStep = kin.stepV, x + v = kin.moveFree (x >= 16), align = kin.align: ${checks - n0} checks; below 16 px x + v != moveFree in ${pSmall} of ${pSmallN} random pairs; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- SOLVE: the solver is sound and complete on its family
// random patterns with <= 3 changes (<= 100 ticks) from random starts: the engine's exact end (x, v) as a point target
// must be found (complete: the interval bounds of THEOREM M never cut a hit) and every answer, and every answer of a
// 10 px window query, replayed by the engine lands where the solver says (sound)
function solveChecks() {
	const t0 = Date.now(); const n0 = checks;
	const reps = QUICK ? 60 : 600;
	let found = 0, missed = 0, window = 0, nodes = 0;
	for (let r = 0; r < reps; r++) {
		if (r % NSH !== SH) continue;
		const x0 = 900 + rnd() * 4300, v0 = rnd() < 0.3 ? 0 : (rnd() * 2 - 1) * 6.7;
		const T = 5 + Math.floor(rnd() * 95), kk = Math.floor(rnd() * 4);
		const cuts = new Set(); while (cuts.size < Math.min(kk, T - 1)) cuts.add(1 + Math.floor(rnd() * (T - 1)));
		const cs = [...cuts].sort((a, b) => a - b);
		const runs = []; let prev = 0, mi = Math.floor(rnd() * 3);
		for (const c of [...cs, T]) { runs.push([mi, c - prev]); prev = c; mi = (mi + 1 + Math.floor(rnd() * 2)) % 3; }
		const code = K.encode(runs);
		place(sim, x0, v0, 3000, 0);
		for (let j = 1; j <= T; j++) tick(sim, [0, 2, 4][K.inputAt(code, j)]);
		const X = sim.px, V = sim.speed_x;
		const res = K.solveIA(x0, v0, T, X, X, { k: 3, vlo: V, vhi: V, limit: 4 });
		nodes += res.stats.nodes;
		checks++;
		if (!res.length) { missed++; fail(`SOLVE missed ${K.str(code, T)} from x0=${x0} v0=${v0}`); continue; }
		found++;
		for (const a of res) {
			place(sim, x0, v0, 3000, 0);
			for (let j = 1; j <= T; j++) tick(sim, [0, 2, 4][K.inputAt(a.code, j)]);
			checks++;
			if (sim.px !== a.x || sim.speed_x !== a.v || a.x !== X || a.v !== V) fail(`SOLVE unsound ${a.str}`);
		}
		const w = K.solveIA(x0, v0, T, X - 5, X + 5, { k: 2, limit: 16 });
		for (const a of w) {
			place(sim, x0, v0, 3000, 0);
			for (let j = 1; j <= T; j++) tick(sim, [0, 2, 4][K.inputAt(a.code, j)]);
			checks++; window++;
			if (sim.px !== a.x || sim.px < X - 5 || sim.px > X + 5) fail(`SOLVE window unsound ${a.str}`);
		}
	}
	console.log(`SOLVE point targets found ${found}, missed ${missed} (mean ${(nodes / Math.max(1, found + missed)).toFixed(0)} nodes); ${window} window answers replayed; ${checks - n0} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- M2: the align's overshoot over EVERY input word
// (model only: S1 / S2 tie the model to the engine) from starts on a fine grid within 3 px of a grid line, every word over
// {-, L, R} of length <= D2: the largest x_t - holdR_t and holdL_t - x_t (THEOREM M's slack, measured over all words)
function m2() {
	const t0 = Date.now();
	const D2 = +(argv.D2 || (QUICK ? 10 : 13));
	let over = 0, under = 0, words = 0, at = null;
	const starts = [];
	for (let k = 0; k < (QUICK ? 24 : 96); k++) starts.push(1600 - 3 + 6 * k / (QUICK ? 24 : 96) + 1e-7 * k);
	const vs = [0, 0.05, -0.05, 0.3, -0.3, 0.7, -0.7, 0.99, -0.99, 1.2, -1.2, 2.5, -2.5];
	let idx = 0;
	for (const x0 of starts) for (const v0 of vs) {
		if ((idx++) % NSH !== SH) continue;
		const hR = [], hL = [];
		{ let x = x0, v = v0; for (let t = 1; t <= D2; t++) { [x, v] = K.stepIA(x, v, 2, I1); hR[t] = x; } }
		{ let x = x0, v = v0; for (let t = 1; t <= D2; t++) { [x, v] = K.stepIA(x, v, 1, I1); hL[t] = x; } }
		const rec = (t, x, v) => {
			for (let mi = 0; mi < 3; mi++) {
				const [xx, vv] = K.stepIA(x, v, mi, I1);
				words++;
				const o = xx - hR[t + 1], u = hL[t + 1] - xx;
				if (o > over) { over = o; at = { x0, v0, t: t + 1 }; }
				if (u > under) under = u;
				if (t + 1 < D2) rec(t + 1, xx, vv);
			}
		};
		rec(0, x0, v0);
	}
	console.log(`M2  every word over {-,L,R} up to ${D2} ticks from ${starts.length} x ${vs.length} starts by grid lines (model): ${words} word ticks, overshoot +${over.toFixed(6)} / -${under.toFixed(6)} px ${at ? JSON.stringify(at) : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	if (over > K.ALIGN_SLACK || under > K.ALIGN_SLACK) fail('THEOREM M slack exceeded over all words');
}

const T0 = Date.now();
m2(); s1(); s2(); s2(T3, 3); s2r(); sep(); pRandom(); gAxis(); ctxChecks(); tabChecks(); kinChecks(); solveChecks();
console.log(`\nkin1d theorems: ${checks} engine checks, ${fails} mismatches (${((Date.now() - T0) / 1000).toFixed(1)} s, shard ${SH}/${NSH})`);
for (const f of failLog) console.log('  FAIL ' + f);
process.exit(fails ? 1 : 0);
