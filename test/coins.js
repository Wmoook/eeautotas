'use strict';
// Coins and exact rejoins, CPU only, on hand-made rooms (no jobs, ~1 s):
//   - the coin-blind hash (stateHash(false, true)) leaves out the coin gates' shown counts too: two states that differ
//     only in collected coins are equal on a level with a coin gate (and a blue coin gate) that neither touches; before,
//     _fillKey keyed the gates' counts, which PlayState.tick sets to the coin counts every tick (Octorage's coin gate
//     kept every coin the base route took: 158 ticks)
//   - common.coinFreeTick = the last tick the box (1-tile margin) touches a coin door or gate, + 1
//   - splice.js 'free' mode (the grind on levels where coins count): exact up to each run's coin-free tick, coin-blind
//     twins from there on. A room with a coin door early and an optional coin later: run A takes the coin and is slow
//     before the wall, run B skips it and is slow after the wall. Exact: A alone; 'free': B's start + A's end (faster
//     than both, it replays exactly, 1 coin), the same as coin-blind everywhere. The CLI (--coinfree) the same.
//   - soundness: the same room with a 43:2 coin door after the wall that only A (2 coins) can walk through: the
//     coin-blind-everywhere splice proposes B's start + A's end, which runs into the shut door (no finish); 'free'
//     joins nowhere before a door (the twins start past it) and its run replays exactly
// usage: node test/coins.js        Exit code 1 if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const S = require('../src/splice.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-coins-'));
function makeLevel(name, extra) {
	const cells = room(60, 10);
	cells.push([2, 8, 255], [4, 8, 100], [6, 8, 43, 1], [15, 5, 100], [30, 8, 9], ...extra);
	const json = EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name, width: 60, height: 10, cells })));
	const file = path.join(TMP, `${name}.json`);
	fs.writeFileSync(file, JSON.stringify(json));
	return { file, level: E.loadLevel(file) };
}
const seq = (parts) => { const o = []; for (const [m, n] of parts) for (let k = 0; k < n; k++) o.push(m); return Uint8Array.from(o); };
const R = 4, J = 1;
const slow = []; for (let k = 0; k < 80; k++) slow.push([R, 3], [0, 2]);
// A: after the coin door 20 idle ticks, a jump for the coin at (15, 5), to the wall, at once over it and on
// B: no idle, no second coin, to the wall, over it, then slowly (right 3, nothing 2) on
const A0 = seq([[R, 40], [0, 20], [R, 30], [R | J, 1], [R, 120], [R | J, 1], [R, 300]]);
const B0 = seq([[R, 40], [R, 31], [R, 120], [R | J, 1], ...slow]);
function stateAt(level, ms, t) { const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput(); for (let k = 0; k < t; k++) { E.applyMask(inp, ms[k]); sim.tick(inp); } return sim; }

// ---- room 1: a coin gate and a blue coin gate nobody touches, the trophy past the wall
const L1 = makeLevel('coins1', [[50, 8, 121], [58, 1, 165, 5], [57, 1, 214, 5]]);
const level = L1.level;
const eA = C.evaluate(level, A0), eB = C.evaluate(level, B0);
check('room 1: both runs finish', !!eA && !!eB, `${eA && eA.runTicks} / ${eB && eB.runTicks} run ticks`);
const rA = C.replay(level, eA.ms, { trace: true }), rB = C.replay(level, eB.ms, { trace: true });
check('A takes 2 coins, B 1', rA.coins === 2 && rB.coins === 1, `${rA.coins} / ${rB.coins}`);

console.log('the coin-blind hash (a level with a coin gate and a blue coin gate)');
{
	check('the level has both gates', !!level.hasCoinGate && !!level.hasBlueCoinGate);
	// both pressed against the wall, settled: the same state apart from the coins (A's at tick 190, B's at 180)
	const a = stateAt(level, eA.ms, 190), b = stateAt(level, eB.ms, 180);
	check('at the wall: the same position and speed', a.px === b.px && a.py === b.py && a.speed_x === b.speed_x && a.speed_y === b.speed_y, `(${a.px}, ${a.py}) (${b.px}, ${b.py})`);
	check('the coin gates show the coin counts (2 vs 1)', a._show_coin_gate === 2 && b._show_coin_gate === 1, `${a._show_coin_gate} / ${b._show_coin_gate}`);
	check('the exact hashes differ', a.stateHash() !== b.stateHash());
	check('the coin-blind hashes are equal (the gates\' counts left out)', a.stateHash(false, true) === b.stateHash(false, true));
	check('the clock-blind coin-blind hashes are equal', a.stateHashClockBlind(true) === b.stateHashClockBlind(true));
	// a state change the gate count stands for is still keyed exactly: the exact hash reads it
	const c = stateAt(level, eA.ms, 190);
	c._show_coin_gate = 5;
	check('the exact hash still keys a gate\'s count', c.stateHash() !== a.stateHash() && c.stateHash(false, true) === a.stateHash(false, true));
}

console.log('coinFreeTick');
{
	// brute force: every tick whose box +- 16 px covers a coin door or gate tile
	const brute = (tr, n) => {
		let last = -1;
		for (let t = 0; t <= n; t++) {
			for (let y = Math.floor((tr.Y[t] - 16) / 16); y <= Math.floor((tr.Y[t] + 31) / 16); y++) {
				for (let x = Math.floor((tr.X[t] - 16) / 16); x <= Math.floor((tr.X[t] + 31) / 16); x++) {
					if (x >= 0 && y >= 0 && x < level.width && y < level.height && C.COIN_DOOR_IDS.has(level.fg[y * level.width + x])) last = t;
				}
			}
		}
		return last + 1;
	};
	const cfA = C.coinFreeTick(level, rA.X, rA.Y, rA.complete), cfB = C.coinFreeTick(level, rB.X, rB.Y, rB.complete);
	check('= the last tick near a coin door + 1 (brute force)', cfA === brute(rA, rA.complete) && cfB === brute(rB, rB.complete), `${cfA} / ${cfB}`);
	const doorT = rA.X.findIndex((x) => x > 6 * 16);   // (the box's left edge past the door's tile)
	check('past the coin door at (6, 8), not before it', cfA > doorT && cfA < doorT + 20, `door passed at ${doorT}, coin-free from ${cfA}`);
	check('coinFreeOk: no portal on a coin cell', C.coinFreeOk(level));
	const tA = S.trace(level, eA.ms, 'free', false);
	check('trace \'free\': cf and the twins from it', tA.cf === cfA && tA.HB && tA.HB.length === tA.n + 1, `cf ${tA.cf}`);
	const tX = S.trace(level, eA.ms, false, false), tN = S.trace(level, eA.ms, true, false);
	check('trace exact / blind: no twins; H the same as before', !tX.HB && !tN.HB && tX.H.every((h, t) => h === tA.H[t]) && tX.cf === tX.n + 1 && tN.cf === 0);
}

console.log('splice: coin-blind past the last coin door (\'free\')');
{
	const uX = S.splice(level, [eA.ms, eB.ms], false), uF = S.splice(level, [eA.ms, eB.ms], 'free'), uN = S.splice(level, [eA.ms, eB.ms], true);
	const vX = C.evaluate(level, uX.ms), vF = C.evaluate(level, uF.ms), vN = C.evaluate(level, uN.ms);
	check('exact: no join between the coin counts (A with its own wait at the wall cut)', vX && vX.runTicks === uX.run && uX.run < eA.runTicks && uX.run > uF.run, `${uX.run}`);
	check('\'free\': B\'s start + A\'s end, faster than both runs and the exact splice', vF && uF.run < Math.min(eA.runTicks, eB.runTicks, uX.run) && uF.twins >= 1,
		`${uF.run} (A ${eA.runTicks}, B ${eB.runTicks}, exact ${uX.run}), ${uF.twins} step${uF.twins === 1 ? '' : 's'} to a twin`);
	check('\'free\': the run replays exactly (C.evaluate), 1 coin, 0 deaths', vF && vF.runTicks === uF.run && vF.deaths === 0 && C.replay(level, uF.ms).coins === 1, vF ? `${vF.runTicks}` : 'no finish');
	check('\'free\' = coin-blind everywhere here (no coin door after the join)', vN && uN.run === uF.run, `${uN.run}`);
	check('the judge accepts it against A', C.judge(Object.assign(vF, { chance: 1 }), Object.assign(eA, { chance: 1 }), 0).accept);
	// the CLI (the grind's round splice): --coinfree
	const fa = path.join(TMP, 'a.eetas'), fb = path.join(TMP, 'b.eetas'), fo = path.join(TMP, 'o.eetas'), fx = path.join(TMP, 'x.eetas');
	C.writeEetas(fa, eA.ms); C.writeEetas(fb, eB.ms);
	const run = (args) => execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'splice.js'), ...args, `--level=${L1.file}`], { encoding: 'utf8' });
	const outF = run([fo, fa, fb, '--coinfree']), outX = run([fx, fa, fb]);
	const cF = C.evaluate(level, C.readEetas(fo)), cX = C.evaluate(level, C.readEetas(fx));
	check('splice.js --coinfree writes the faster run; without it the exact one', cF && cX && cF.runTicks === uF.run && cX.runTicks === uX.run && /past the last coin door/.test(outF) && !/past the last/.test(outX),
		`${cF && cF.runTicks} / ${cX && cX.runTicks}`);
	// the GPU searcher's library edges start and end at exact states in 'free' mode too: firstBadCheck checks exact hashes
	const tr = S.trace(level, eA.ms, false, false), tb = S.trace(level, eA.ms, true, false);
	check('firstBadCheck \'free\' checks the exact state', S.firstBadCheck(level, eA.ms, [[190, tr.H[190]]], 'free') === null &&
		S.firstBadCheck(level, eA.ms, [[190, tb.H[190]]], 'free') === 0 && S.firstBadCheck(level, eA.ms, [[190, tb.H[190]]], true) === null);
	// a library edge (exact states) into A's wall state that lands with B's 1 coin: the union takes it (it is
	// sooner than A there), and the check finds it is not exact
	const g = S.unionGraph([S.trace(level, eA.ms, 'free', false)]);
	const lib = new Map([[tr.H[40], new Map([[tr.H[190], { seq: eB.ms.slice(40, 130), fam: 'm1' }]])]]);
	const u = g.path({ lib });
	check('\'free\' + a library edge: used, and its check (exact) fails', !!u && u.libUsed.length === 1 && S.firstBadCheck(level, u.ms, u.checks, 'free') === 0,
		u ? `${u.libUsed.length} edge(s), run ${u.run}` : 'no path');
}

console.log('soundness: a coin door after the join');
{
	// the same room with a 43:2 door at (42, 8): A (2 coins) walks through it; B (1 coin) jumps over it
	const L2 = makeLevel('coins2', [[42, 8, 43, 2], [52, 8, 121]]);
	const lv = L2.level;
	const A = C.evaluate(lv, A0);
	let B = null;
	for (let k = 0; k < 80 && !B; k++) B = C.evaluate(lv, seq([[R, 40], [R, 31], [R, 120], [R | J, 1], [R, k], [R | J, 1], ...slow]));
	check('both finish (B over the 43:2 door)', !!A && !!B, `${A && A.runTicks} / ${B && B.runTicks}`);
	const uN = S.splice(lv, [A.ms, B.ms], true), uF = S.splice(lv, [A.ms, B.ms], 'free'), uX = S.splice(lv, [A.ms, B.ms], false);
	const vN = C.evaluate(lv, uN.ms), vF = C.evaluate(lv, uF.ms);
	check('coin-blind everywhere joins at the wall: B\'s 1 coin meets the 43:2 door (no finish or not as claimed)', !vN || vN.runTicks !== uN.run, `claimed ${uN.run}, replayed ${vN ? vN.runTicks : 'no finish'}`);
	check('\'free\': no join before the door; the run replays exactly', vF && vF.runTicks === uF.run && uF.run === uX.run, `${uF.run} (exact ${uX.run})`);
	const tA = S.trace(lv, A.ms, 'free', false);
	const doorT = C.replay(lv, A.ms, { trace: true }).X.findIndex((x) => x > 43 * 16);
	check('A\'s twins start past the 43:2 door', tA.cf > doorT, `door passed at ${doorT}, cf ${tA.cf}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
