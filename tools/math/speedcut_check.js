'use strict';
// THEOREM V's ENGINE CHECK (docs/ee_math.md 4.12): on every truthset route's level, every tick of the route's own
// inputs and of random input words from its states (holds of 1-24 ticks over the 9 direction masks, the jump bit at
// random) whose tile box of radius LOCAL (4) tiles around the centre at the tick's start holds no hot tile of an axis
// (msolve.axisHot; flip not 1 / 3; y: the world's gravity <= 1): the engine's tick keeps  |v'| <= max(|v|, V)  and moves
// the box  |p' - p| <= max(|v|, V) + RATE_SLACK  on that axis (V = VSTAR_X / VSTAR_X_RUN / VSTAR_Y); msolve's box of
// radius RATE_BOX(R) around a state holds every later tick's local box for R ticks. Ticks with a death (the respawn
// moves the box) are left out, as the coupled piece's holds end there.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/speedcut_check.js [--shard=i/n] [--every=25] [--words=6] [--len=120]
//          [--out=<file.json>]
const fs = require('fs');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const MS = require('../../src/plan/msolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const EVERY = +(argv.every || 25), WORDS = +(argv.words || 6), LEN = +(argv.len || 120);
let seed = 12345 + SH;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const DIR9 = MS.DIR9;
const LOCAL = 4;
const st = { levels: 0, tameX: 0, tameY: 0, ticksX: 0, ticksY: 0, badVX: 0, badVY: 0, badPX: 0, badPY: 0, maxVX: -Infinity, maxVY: -Infinity, maxPX: -Infinity, maxPY: -Infinity, ex: [] };

function checkTick(T, sim, inp, mask) {
	const fl = sim.flip_gravity, rot = fl === 1 || fl === 3;
	const tx = Math.floor((sim.px + 8) / 16), ty = Math.floor((sim.py + 8) / 16);
	const coldX = MS.hotIn(T, T.sx, tx - LOCAL, ty - LOCAL, tx + LOCAL, ty + LOCAL) === 0;
	const coldY = T.yOK && MS.hotIn(T, T.sy, tx - LOCAL, ty - LOCAL, tx + LOCAL, ty + LOCAL) === 0;
	const vx = sim.speed_x, vy = sim.speed_y, px = sim.px, py = sim.py, dead0 = sim.is_dead;
	const Vx = T.run || sim.speed_boost === 1 ? MS.VSTAR_X_RUN : MS.VSTAR_X;
	E.applyMask(inp, mask);
	sim.tick(inp);
	if (dead0 || sim.is_dead) return;
	if (coldX && !rot) {
		st.ticksX++;
		const U = Math.max(Math.abs(vx), Vx);
		const ev = Math.abs(sim.speed_x) - U, ep = Math.abs(sim.px - px) - U;
		if (ev > st.maxVX) st.maxVX = ev;
		if (ep > st.maxPX) st.maxPX = ep;
		if (ev > 0) st.badVX++;
		if (ep > MS.RATE_SLACK) { st.badPX++; if (st.ex.length < 20) st.ex.push({ axis: 'x', vx, px, nx: sim.px, nvx: sim.speed_x }); }
	}
	if (coldY && !rot) {
		st.ticksY++;
		const U = Math.max(Math.abs(vy), MS.VSTAR_Y);
		const ev = Math.abs(sim.speed_y) - U, ep = Math.abs(sim.py - py) - U;
		if (ev > st.maxVY) st.maxVY = ev;
		if (ep > st.maxPY) st.maxPY = ep;
		if (ev > 0) st.badVY++;
		if (ep > MS.RATE_SLACK) { st.badPY++; if (st.ex.length < 20) st.ex.push({ axis: 'y', vy, py, ny: sim.py, nvy: sim.speed_y }); }
	}
}

const all = TS.knownRoutes({});
const t0 = Date.now();
all.forEach((entry, idx) => {
	if (idx % NSH !== SH) return;
	const tr = TS.loadTruth(entry);
	if (!tr) return;
	const { L, masks } = tr;
	const T = MS.axisHot(L);
	st.levels++;
	if (T.sx[T.sx.length - 1] === 0) st.tameX++;
	if (T.yOK && T.sy[T.sy.length - 1] === 0) st.tameY++;
	const sim = new E.EESim(L), inp = new E.EEInput();
	const w = new E.EESim(L), winp = new E.EEInput();
	sim.reset(); w.reset();
	for (let t = 0; t < masks.length; t++) {
		if (t % EVERY === 0) {
			const snap = sim.snapshot();
			for (let k = 0; k < WORDS; k++) {
				w.restore(snap);
				let n = 0;
				while (n < LEN && !w.is_dead) {
					const m = DIR9[Math.floor(rnd() * 9)], h = 1 + Math.floor(rnd() * 24), jp = rnd();
					for (let i = 0; i < h && n < LEN && !w.is_dead; i++, n++) checkTick(T, w, winp, m | (jp < 0.3 ? 1 : jp < 0.45 && i === 0 ? 1 : 0));
				}
			}
		}
		checkTick(T, sim, inp, masks[t]);
	}
});
st.sec = (Date.now() - t0) / 1000;
const out = JSON.stringify(st);
if (argv.out) fs.writeFileSync(argv.out, out + '\n');
console.log(out);
