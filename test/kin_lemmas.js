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
	// the doubling lemma: gravity is exactly 2 keys (G = 2 A: 2 / 7.752 = 2 x (1 / 7.752) in doubles) and both use the base
	// drag only, so the fall from rest is exactly twice the held run from rest, tick by tick (scaling by 2 commutes with
	// rounding); the up arrow's pull is its negation, and a jump's fall is the same map from J
	let dbl = 0;
	{
		let x = 0, y = 0;
		for (let t = 0; t < 3000; t++) {
			if (!Object.is(y, 2 * x)) dbl++;
			ctx(0, 0, 0); x = K.stepX(x, 1, S);
			ctx(0, 0, 0); y = K.stepY(y, 0, S);
		}
	}
	check('the fall from rest = 2 x the held run from rest, every tick (3000 ticks)', dbl === 0 && K.G === 2 * K.A, `${dbl} differ`);
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
	// F0 THE ONE-ADD THEOREM: for p >= 16 and |v| <= 16 the sub-stepped free move is ONE rounded add: moveFree(p, v, boost)
	// = fl(p + v) (every sub-step is exact: 1 - rem, v - (1 - rem), v + rem, the integer steps; only the last add rounds);
	// p in [0, 16) (the leftmost / top tile) can differ (counted)
	let addBad = 0, addN = 0, lowDiff = 0, lowN = 0;
	const addSpeeds = [0, 16, -16, 1, -1, 0.5, -0.5, 1e-4, -1e-4, 5e-324, -5e-324, 15.999999999999998, -15.999999999999998];
	for (const v of reach) { addSpeeds.push(v); addSpeeds.push(-v); addSpeeds.push(2 * v); addSpeeds.push(-2 * v); }
	for (let k = 0; k < 2000; k++) addSpeeds.push((rng() * 2 - 1) * 16);
	for (let k = 0; k < 500; k++) addSpeeds.push((rng() * 2 - 1) * 2 ** -Math.floor(rng() * 60));
	const nAdd = QUICK ? 300000 : 3000000;
	for (let k = 0; k < nAdd; k++) {
		const e = 4 + Math.floor(rng() * 13);   // p in [16, 131072)
		const q = 2 ** (e - 52);
		const r = rng();
		let p = 2 ** e + (r < 0.25 ? Math.floor(rng() * 2 ** e) : (r < 0.35 ? Math.floor(rng() * 2 ** e) + 0.5 : Math.floor(rng() * 2 ** e / q) * q));
		if (p >= 2 ** (e + 1)) p = 2 ** e;
		const v = addSpeeds[Math.floor(rng() * addSpeeds.length)];
		const boost = rng() < 0.1;
		addN++;
		if (!Object.is(K.moveFree(p, v, boost), p + v)) { addBad++; if (addBad < 3) console.log('   add', p, v, boost, K.moveFree(p, v, boost), p + v); }
		const pl = rng() * 16;
		lowN++;
		if (!Object.is(K.moveFree(pl, v, boost), pl + v)) lowDiff++;
	}
	check(`F0 the free move is one rounded add: moveFree(p, v) = fl(p + v) for p >= 16, |v| <= 16 (${addN.toLocaleString()} cases, 13 binades)`, addBad === 0, `p in [0, 16): ${lowDiff} of ${lowN} differ`);
	report.F.oneAdd = { n: addN, bad: addBad, lowN, lowDiff };
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
	// F5 MONOTONICITY: in every context the speed update of an axis is nondecreasing in the speed (for each input) and
	// ordered in the axis's key (-1 <= 0 <= +1 where the key acts): so the speeds reachable in t ticks under ANY inputs lie
	// between the all-negative and the all-positive orbits (an interval method for sound bounds)
	const ctxs = [];
	for (const cur of [0, 119, 369, 416, 1585, 120, 4, 1, 2, 3, 1518, 114, 115, 116, 117]) {
		for (const fx of [{}, { sb: 1 }, { sb: 2 }, { zombie: true }, { lowGravity: true }, { flip: 1 }, { flip: 2 }, { flip: 3 }, { flip: 4 }, { slip: 2, below: 1064 }, { slip: 0.2000000000000003 }]) {
			ctxs.push(Object.assign({ cur, del: cur, below: 0 }, fx));
		}
	}
	const vs = [];
	for (let k = 0; k < (QUICK ? 3000 : 30000); k++) vs.push((rng() * 2 - 1) * (rng() < 0.3 ? 0.01 : (rng() < 0.5 ? 2 : 17)));
	for (const v of reach) { vs.push(v); vs.push(-v); }
	vs.push(0, -0, 1e-4, -1e-4, 16, -16, 5e-324, -5e-324);
	vs.sort((a, b) => a - b);
	let monoBad = 0, ordBad = 0, monoN = 0, ordExc = 0, iceLow = 0;
	const iceT = (sm) => (sm / K.MULT) * K.BASE_DRAG / (K.ICE_NO_MOD_DRAG - K.BASE_DRAG);
	for (const c of ctxs) {
		for (const axis of ['x', 'y']) {
			const f = (v, u) => { const S2 = K.surface(c, {}); return axis === 'x' ? K.stepX(v, u, S2) : K.stepY(v, u, S2); };
			for (const u of [-1, 0, 1]) {
				let prev = -Infinity;
				for (const v of vs) { const w = f(v, u); monoN++; if (w < prev) { monoBad++; if (monoBad < 3) console.log('   mono', JSON.stringify(c), axis, u, v, w, prev); } prev = w; }
			}
			for (const v of vs) {
				const a = f(v, -1), b = f(v, 0), d = f(v, 1);
				if (!(a <= b && b <= d)) {
					// the exceptions: mud and lava (holding a key along drags x 0.762 / 0.802, releasing x 0.888), and the ice
					// timer (holding along drags x 0.981, releasing x 0.993) above |v| = A sm B / (Ino - B)
					const sm = K.speedMult(c.sb | 0, !!c.zombie, false);
					if (c.cur === 369 || c.cur === 416) { ordExc++; continue; }
					if ((c.slip || 0) > 0 && !K.isClimb(c.cur) && !K.isLiquid(c.cur)) { ordExc++; if (Math.abs(v) < iceT(sm) * (1 - 1e-9)) iceLow++; continue; }
					ordBad++; if (ordBad < 3) console.log('   ord', JSON.stringify(c), axis, v, a, b, d);
				}
			}
		}
	}
	check(`F5 the speed updates are monotone in v (${monoN.toLocaleString()} steps, ${ctxs.length} contexts x 2 axes x 3 keys)`, monoBad === 0, `${monoBad} decreasing steps`);
	check('F5 ... and ordered in the key, V(v, -1) <= V(v, 0) <= V(v, +1), except in mud / lava and on ice above |v| = A sm B / (Ino - B) (10.67 at sm 1)', ordBad === 0 && iceLow === 0, `${ordBad} out of order elsewhere, ${ordExc} in the exceptions, ${iceLow} on ice below the threshold`);
	report.F.mono = { n: monoN, bad: monoBad, ordBad, ordExc, iceLow, iceT1: iceT(1), contexts: ctxs.length };
	// F6 the auto-align moves a position by less than 0.2 px, and is monotone in p
	let alMax = 0, alMono = 0;
	let prevIn = -1, prevOut = -Infinity;
	for (let k = 0; k < (QUICK ? 200000 : 2000000); k++) {
		const p = 64 + (k / (QUICK ? 200000 : 2000000)) * 64 + rng() * 1e-6;
		const a = K.align(p, 0.5, 0, false);
		alMax = Math.max(alMax, Math.abs(a - p));
		if (p >= prevIn && a < prevOut) alMono++;
		prevIn = p; prevOut = a;
	}
	check('F6 |align(p) - p| < 0.2 and align is monotone in p', alMax < 0.2 && alMono === 0, `max move ${alMax}, ${alMono} decreasing`);
}

if (require.main === module) {
	if (process.argv.includes('--numbers')) {
		const N = numbers();
		for (const [k, o] of Object.entries(N)) console.log(k.padEnd(18), 'fix', o.fix, 'cycle', o.cycle, 'after', o.ticks, 'first', o.seq.slice(0, 6).map((x) => +x.toFixed(6)).join(' '));
	}
}
module.exports = { testF, numbers, orbit };
