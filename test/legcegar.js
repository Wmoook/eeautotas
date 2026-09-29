'use strict';
// THE LEG CEGAR (src/steer.js buildSteer, legCounterexample; d4-cegar-dp-legs): the coin DP's legs are built in one
// layer of the modelled features with every gate of an UNmodelled feature open, and the physics plan's CEGAR never
// looks at them. A unit level (48 x 18): a corridor (rows 12-14), the spawn at x 20, coin A at (18, 14), a pocket above
// the corridor at x 9-11 (rows 9-10) with coin B at (10, 10) whose only way in is a purple door (184, id 1: shut until
// switch 1 is pressed) at (10, 11), coin C at the corridor's far right (40, 14), a purple switch 1 at (30, 14), a
// 2-coin door column at x 5 and the trophy at (2, 13). The walk plan touches coin A twice (the walk counts a coin at
// every touch) and walks left through the coin door: it never passes the switch door; the physics plan at 0 coins has
// no way (the coin door): no counterexample names switch 1, so main models coins only and its DP's best 2-coin tour is
// A then B, through the switch door (open in the legs: unmodelled).
//   1 main (legCegar false): switch 1 not modelled; the DP's tour A, B (the leg to B through the shut door)
//   2 the leg CEGAR: the replay of the DP's tour names psw:1 at the door (10, 11) on leg 2, models it and builds again:
//     the DP's tour C, A (B's leg, in the layer of switch 1 off, has no way from the start or A), its value at the start
//     finite and higher than main's (the real detour); EEAT_LEGCEGAR=0 = main byte for byte
//   3 the pocket's entrance a purple GATE (185: open while switch 1 is off): the leg passes an open gate, no
//     counterexample, the files = main's byte for byte (the GPU and the CPU file)
//   4 no coin C: modelling switch 1 would leave the DP no 2-coin tour (B cut off): the check before a build again
//     (legLost) says so, no build again, main's files byte for byte; legCegar 'keep' builds again (for measurement)
// usage: node test/legcegar.js [--only=1,2,3,4]
const crypto = require('crypto');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SF = require('../src/steer.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const W = 48, H = 18;
const A = [18, 14], B = [10, 10], C = [40, 14];
function levelOf({ gate = false, noC = false } = {}) {
	const open = new Set();
	const key = (x, y) => `${x},${y}`;
	for (let y = 12; y <= 14; y++) for (let x = 1; x <= W - 2; x++) open.add(key(x, y));
	for (let y = 9; y <= 10; y++) for (let x = 9; x <= 11; x++) open.add(key(x, y));
	open.add(key(10, 11));
	const cells = [];
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!open.has(key(x, y))) cells.push([x, y, 9]);
	cells.push([20, 14, 255]);
	cells.push([A[0], A[1], 100]); cells.push([B[0], B[1], 100]);
	if (!noC) cells.push([C[0], C[1], 100]);
	cells.push([10, 11, gate ? 185 : 184, 1]);
	cells.push([30, 14, 113, 1]);
	for (let y = 12; y <= 14; y++) cells.push([5, y, 43, 2]);
	cells.push([2, 13, 121]);
	const buf = ED.eelvlOf({ name: 'legcegar', width: W, height: H, cells });
	return E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf), { id: 'editor', file: 'editor.eelvl' }));
}
const tileXY = (t) => [t % W, Math.floor(t / W)];
/** the DP's tour from the start (the coins as [x, y]) by its own legs: the least leg + rest, coin by coin */
function tourOf(st, L) {
	const D = st.dp;
	if (!D) return [];
	const sim = new E.EESim(L); sim.reset();
	const out = [];
	let m = 0;
	// (the DP's rest from the start: nextGate's rule, then the coin's own tile as the next start)
	const g = SF.nextGate(st, sim);
	if (!g) return out;
	out.push(g.i);
	m |= 1 << g.i;
	for (let k = 1; k < D.T; k++) {
		let best = -1, bv = Infinity;
		for (let q = 0; q < D.n; q++) {
			if (m & (1 << q)) continue;
			const rest = D.h[(m | (1 << q)) * D.n + q];
			if (rest < bv) { bv = rest; best = q; }
		}
		if (best < 0 || !(bv < Infinity)) break;
		out.push(best); m |= 1 << best;
	}
	return out;
}
const coinsOf = (L) => { const r = []; for (let i = 0; i < L.fg.length; i++) if (L.fg[i] === 100) r.push(i); return r; };
const files = (st) => [md5(SF.steerFileBytes(st, null)), md5(SF.steerFileBytes(st, null, true))];

const L = levelOf();
const cs = coinsOf(L);
const idxOf = (xy) => cs.findIndex((t) => tileXY(t)[0] === xy[0] && tileXY(t)[1] === xy[1]);
const bitToXY = (st, i) => { const b = st.dp.bit[i]; const t = cs.find((q) => L.coinBit[q] === b); return t === undefined ? null : tileXY(t); };

if (want('1') || want('2')) {
	section('1 main (legCegar false)');
	const st0 = SF.buildSteer(L, { legCegar: false });
	check('switch 1 not modelled', !st0.info.features.includes('psw:1'), st0.info.features.join('+'));
	check('the coins modelled, the DP over 3 coins, T 2', !!st0.dp && st0.dp.n === 3 && st0.dp.T === 2, st0.dp && `${st0.dp.n}/${st0.dp.T}`);
	const t0 = tourOf(st0, L).map((i) => bitToXY(st0, i));
	check('the DP tour A then B (through the switch door)', JSON.stringify(t0) === JSON.stringify([A, B]), JSON.stringify(t0));
	check('no leg CEGAR log', st0.info.legCegar === undefined);
	const sim = new E.EESim(L); sim.reset();
	const v0 = SF.steerAt(st0, sim);
	if (want('2')) {
		section('2 the leg CEGAR');
		const st1 = SF.buildSteer(L, {});
		const lg = st1.info.legCegar || [];
		check('the replay names psw:1 at the door (10, 11) on leg 2', lg.length >= 1 && lg[0].feat === 'psw:1' && lg[0].at[0] === 10 && lg[0].at[1] === 11 && lg[0].leg === 2, JSON.stringify(lg));
		check('psw:1 modelled (added, not reverted)', st1.info.features.includes('psw:1') && lg[0] && lg[0].added && !lg[0].reverted, st1.info.features.join('+'));
		const t1 = st1.dp ? tourOf(st1, L).map((i) => bitToXY(st1, i)) : [];
		check('the DP tour over A and C, not B (C first: the trophy is left)', JSON.stringify(t1) === JSON.stringify([C, A]), JSON.stringify(t1));
		const v1 = SF.steerAt(st1, sim);
		check('the start value finite and above main\'s (the real detour to C)', Number.isFinite(v1) && v1 > v0, `${v1} vs ${v0}`);
		check('the files differ from main\'s', files(st1)[0] !== files(st0)[0]);
		const envWas = process.env.EEAT_LEGCEGAR;
		process.env.EEAT_LEGCEGAR = '0';
		const st2 = SF.buildSteer(L, {});
		if (envWas === undefined) delete process.env.EEAT_LEGCEGAR; else process.env.EEAT_LEGCEGAR = envWas;
		check('EEAT_LEGCEGAR=0: main byte for byte', JSON.stringify(files(st2)) === JSON.stringify(files(st0)) && st2.info.legCegar === undefined);
		// the lookup: the DP's value at a ball in the corridor under the pocket; main points it up into the pocket
		const g0 = SF.nextGate(st0, sim), g1 = SF.nextGate(st1, sim);
		check('the next gate from the start: A on main (then B), C with the leg CEGAR', g0 && g1 && JSON.stringify(bitToXY(st0, g0.i)) === JSON.stringify(A) && JSON.stringify(bitToXY(st1, g1.i)) === JSON.stringify(C));
	}
}
if (want('3')) {
	section('3 the pocket behind a purple gate (open at the start): no counterexample');
	const Lg = levelOf({ gate: true });
	const a = SF.buildSteer(Lg, { legCegar: false }), b = SF.buildSteer(Lg, {});
	check('no leg counterexample', b.info.legCegar === undefined, JSON.stringify(b.info.legCegar));
	check('the GPU and CPU files = main\'s byte for byte', JSON.stringify(files(a)) === JSON.stringify(files(b)));
}
if (want('4')) {
	section('4 no coin C: the DP would lose its tour: no build again, main\'s file');
	const Ln = levelOf({ noC: true });
	const a = SF.buildSteer(Ln, { legCegar: false }), b = SF.buildSteer(Ln, {});
	const lg = b.info.legCegar || [];
	check('psw:1 named on the leg', lg.length === 1 && lg[0].feat === 'psw:1', JSON.stringify(lg));
	check('not built again: the DP would lose the coin B (10, 10)', lg[0] && !lg[0].added && /would lose the coin \(10, 10\)/.test(lg[0].why || ''), JSON.stringify(lg[0]));
	const c = SF.buildSteer(Ln, { legCegar: 'keep' });
	const lk = c.info.legCegar || [];
	check("'keep' builds again (no check) and keeps it: psw:1 modelled", lk[0] && lk[0].added && !lk[0].reverted && c.info.features.includes('psw:1'), JSON.stringify(lk));
	check('the files = main\'s byte for byte', JSON.stringify(files(a)) === JSON.stringify(files(b)));
	check('psw:1 not in the features', !b.info.features.includes('psw:1'), b.info.features.join('+'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
