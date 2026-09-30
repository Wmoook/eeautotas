'use strict';
// test/kin_lemmas.js - section F of test/kin.js: facts about the recurrences of src/plan/kin.js, checked on the model
// (sections A-E of test/kin.js tie the model to eesim.js tick by tick, so they hold for the engine), and the numbers
// docs/ee_math.md 1.7 quotes (the fixed points and the ticks to reach them). Also `node test/kin_lemmas.js --numbers`.
const K = require('../src/plan/kin.js');

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const S = {};
const ctx = (cur, del, below, extra) => K.surface(Object.assign({ cur, del, below }, extra || {}), S);

/** iterate f from v0 until a fixed point or a cycle: {fix, cycle, ticks, seq} (seq: the first 200 values) */
function orbit(f, v0, max = 100000) {
	const seen = new Map();
	let v = v0;
	const seq = [];
	for (let t = 0; t < max; t++) {
		if (seq.length < 200) seq.push(v);
		const k = Object.is(v, -0) ? '-0' : String(v);
		if (seen.has(k)) return { fix: v, cycle: t - seen.get(k), ticks: seen.get(k), seq };
		seen.set(k, t);
		v = f(v);
	}
	return { fix: v, cycle: -1, ticks: max, seq };
}

function numbers() {
	const out = {};
	// run: held key in air, gravity down (current = delayed = 0), from rest
	out.runRight = orbit((v) => { ctx(0, 0, 0); return K.stepX(v, 1, S); }, 0);
	out.runRightSb1 = orbit((v) => { ctx(0, 0, 0, { sb: 1 }); return K.stepX(v, 1, S); }, 0);
	out.runRightSb2 = orbit((v) => { ctx(0, 0, 0, { sb: 2 }); return K.stepX(v, 1, S); }, 0);
	// release from the run's top speed: no key, the no-modifier drag
	out.releaseFromTop = orbit((v) => { ctx(0, 0, 0); return K.stepX(v, 0, S); }, out.runRight.fix);
	out.reverseFromTop = orbit((v) => { ctx(0, 0, 0); return K.stepX(v, -1, S); }, out.runRight.fix);
	// fall: gravity from rest and from a jump
	out.fall = orbit((v) => { ctx(0, 0, 0); return K.stepY(v, 0, S); }, 0);
	out.jumpArc = orbit((v) => { ctx(0, 0, 0); return K.stepY(v, 0, S); }, K.jumpSpeed(2, 1));
	out.fallLowGrav = orbit((v) => { ctx(0, 0, 0, { lowGravity: true }); return K.stepY(v, 0, S); }, 0);
	// liquids: sink / float, swim
	for (const [nm, id] of [['water', 119], ['mud', 369], ['lava', 416], ['toxic', 1585]]) {
		out[nm + 'Drift'] = orbit((v) => { ctx(id, id, id); return K.stepY(v, 0, S); }, 0);
		out[nm + 'SwimRight'] = orbit((v) => { ctx(id, id, id); return K.stepX(v, 1, S); }, 0);
		out[nm + 'SwimDown'] = orbit((v) => { ctx(id, id, id); return K.stepY(v, 1, S); }, 0);
	}
	// dots and climbables (no pull): held key, and the stop
	out.dotRight = orbit((v) => { ctx(4, 4, 4); return K.stepX(v, 1, S); }, 0);
	out.climbUp = orbit((v) => { ctx(120, 120, 120); return K.stepY(v, -1, S); }, 0);
	// arrows: an up arrow's pull (current = delayed = 2)
	out.upArrow = orbit((v) => { ctx(2, 2, 2); return K.stepY(v, 0, S); }, 0);
	// ice: held key on ice (slip = 2 each tick), and the slide after releasing
	out.iceRun = orbit((v) => { ctx(0, 0, 1064, { slip: 2 }); return K.stepX(v, 1, S); }, 0);
	out.iceSlide = orbit((v) => { ctx(0, 0, 1064, { slip: 2 }); return K.stepX(v, 0, S); }, out.iceRun.fix);
	return out;
}

function testF(h) {
	const { check, section, report, QUICK, SEED } = h;
	section('F lemmas of the recurrences (on the model)');
	const rng = mulberry((SEED || 1) * 2654435761);
	const N = numbers();
	report.F = { numbers: Object.fromEntries(Object.entries(N).map(([k, o]) => [k, { fix: o.fix, cycle: o.cycle, ticks: o.ticks }])) };
	check('the held run converges to a fixed point (no cycle)', N.runRight.cycle === 1, `v* = ${N.runRight.fix} after ${N.runRight.ticks} ticks`);
	check('the free fall converges to a fixed point', N.fall.cycle === 1, `v* = ${N.fall.fix} after ${N.fall.ticks} ticks`);
	check('a released run stops at exactly +0 (the snap)', Object.is(N.releaseFromTop.fix, 0) && N.releaseFromTop.cycle === 1, `after ${N.releaseFromTop.ticks} ticks`);
	// F1 free-air separability of kin.tick: in a world of air (a big empty level), the x outputs depend on (x, vx, h) only
	// and the y outputs on (y, vy, jump) only (the jump never fires in the air with maxJumps 1, and v never acts under a
	// vertical pull)
	const Wd = 400, H = 400;
	const air = { width: Wd, height: H, maxX: Wd * 16 - 16, maxY: H * 16 - 16, tile: () => 0, lookup: () => 0, doorOpen: () => false,
		portal: () => null, exit: () => null, spawn: () => [1, 1] };
	let sepBad = 0, sepN = 0;
	const reach = [];
	{ let v = 0; for (let k = 0; k < 60; k++) { reach.push(v); ctx(0, 0, 0); v = K.stepX(v, 1, S); } }
	const nSep = QUICK ? 20000 : 200000;
	for (let k = 0; k < nSep; k++) {
		const x = 800 + rng() * 4000, vx = (rng() < 0.5 ? reach[Math.floor(rng() * reach.length)] : (rng() * 2 - 1) * 16);
		const hm = [0, 2, 4, 6][Math.floor(rng() * 4)];
		const base = K.newState({ px: x, py: 800 + rng() * 4000, vx, vy: (rng() * 2 - 1) * 16, jc: 1, q0: 0, q1: 0, pastx: -5, pasty: -5, lastPortal: false });
		const a = K.tick(Object.assign({}, base, { mor: {} }), hm | (Math.floor(rng() * 4) << 3) | (rng() < 0.5 ? 1 : 0), air);
		const b = K.tick(Object.assign({}, base, { mor: {}, py: 800 + rng() * 4000, vy: (rng() * 2 - 1) * 16 }), hm | (Math.floor(rng() * 4) << 3) | (rng() < 0.5 ? 1 : 0), air);
		sepN++;
		if (!Object.is(a.px, b.px) || !Object.is(a.vx, b.vx)) { sepBad++; if (sepBad < 3) console.log('   sep', x, vx, hm, a.px, b.px); }
	}
	check(`F1 free air: x' and vx' depend on (x, vx, left/right) only (${sepN.toLocaleString()} pairs)`, sepBad === 0);
	// F2 the binade lemma of the position update: for an integer n and n' = n + 2^e j within the binade [2^e, 2^(e+1))
	// whose whole move stays in it, moveFree(n' + f, v) - n' = moveFree(n + f, v) - n (the offsets are equal doubles);
	// and across binades they can differ (counted)
	let binBad = 0, binN = 0, crossDiff = 0, crossN = 0;
	const speeds = [];
	for (let k = 0; k < 400; k++) speeds.push((rng() * 2 - 1) * 16);
	for (const v of reach) { speeds.push(v); speeds.push(-v); }
	const fracs = [0, 0.5, 0.25, 0.125];
	for (let k = 0; k < (QUICK ? 200 : 2000); k++) fracs.push(rng());
	for (let e = 5; e <= 13; e++) {
		const lo = 2 ** e, hi = 2 ** (e + 1);
		for (const f0 of fracs) {
			// f representable with ulp(2^e) = 2^(e - 52): round it to that grid
			const q = 2 ** (e - 52), f = Math.floor(f0 / q) * q;
			for (let r = 0; r < (QUICK ? 2 : 6); r++) {
				const v = speeds[Math.floor(rng() * speeds.length)];
				const n = lo + 18 + Math.floor(rng() * (hi - lo - 40)), n2 = lo + 18 + Math.floor(rng() * (hi - lo - 40));
				const a = K.moveFree(n + f, v, false) - n, b = K.moveFree(n2 + f, v, false) - n2;
				binN++;
				if (!Object.is(a, b)) { binBad++; if (binBad < 3) console.log('   bin', e, n, n2, f, v, a, b); }
				// the next binade
				const n3 = hi + 18 + Math.floor(rng() * (hi - 40));
				const c = K.moveFree(n3 + f, v, false) - n3;
				if (Number.isFinite(c) && (n3 + f) - n3 === f) { crossN++; if (!Object.is(a, c)) crossDiff++; }
			}
		}
	}
	check(`F2 binade translation of the position update (${binN.toLocaleString()} pairs in 9 binades 32..16384)`, binBad === 0, `across binades: ${crossDiff} of ${crossN} offsets differ`);
	report.F.binade = { n: binN, bad: binBad, crossN, crossDiff };
	// F3 the auto-align commutes with shifts by 16 (within a binade): align(p + 16k) = align(p) + 16k
	let alBad = 0;
	for (let k = 0; k < (QUICK ? 20000 : 200000); k++) {
		const e = 6 + Math.floor(rng() * 7), lo = 2 ** e;
		const q = 2 ** (e - 52);
		const p = lo + 32 + Math.floor(rng() * (lo - 64) / 16) * 16 + Math.floor(rng() * 16 / q) * q;
		const s = 16 * Math.floor(rng() * ((lo - 64) / 16 - 1));
		const p2 = p + s < 2 * lo - 32 ? p + s : p - s;
		if (p2 < lo + 16) continue;
		const a = K.align(p, 0.3, 0, false) - p, b = K.align(p2, 0.3, 0, false) - p2;
		if (!Object.is(a, b)) alBad++;
	}
	check('F3 the auto-align commutes with 16 px shifts inside a binade', alBad === 0, `${alBad} differ`);
	// F4 every speed set by a tick is in [-16, 16] or a portal's x 1.42 (at most 22.72); |v| < 1e-4 only as exact 0
	let limBad = 0;
	for (let k = 0; k < (QUICK ? 50000 : 500000); k++) {
		const v = (rng() * 2 - 1) * 23, mod = (rng() * 2 - 1) * 0.6, m = [0, -1, 1, 1.5, -0.6][Math.floor(rng() * 5)];
		const w = K.stepV(v, mod, m, rng() < 0.5 ? K.G : 0, rng() < 0.2 ? 2 : 0, [0, 119, 369, 416, 1585, 120][Math.floor(rng() * 6)], false);
		if (v === 0 && mod === 0) continue;
		if (w > 16 || w < -16 || (w !== 0 && Math.abs(w) < 1e-4)) limBad++;
	}
	check('F4 stepV lands in [-16, 16] and never in (0, 1e-4)', limBad === 0);
}

if (require.main === module) {
	if (process.argv.includes('--numbers')) {
		const N = numbers();
		for (const [k, o] of Object.entries(N)) console.log(k.padEnd(18), 'fix', o.fix, 'cycle', o.cycle, 'after', o.ticks, 'first', o.seq.slice(0, 6).map((x) => +x.toFixed(6)).join(' '));
	}
}
module.exports = { testF, numbers, orbit };
