'use strict';
// The plan past its count (Wine Quest I, 2026-09-28): src/steer.js fullCoinT / buildSteer({coinT}) (coinLegsLayered),
// coin doors above the level's coin total as walls, and goexplore.js `steer <file>` (the switch of head A's field).
// On a small level whose walk plan needs fewer coins than the level does (a shaft whose only footholds are coin GATES of
// the full count, as Wine Quest I's 10-coin gates):
// - the walk plan's count T is below the full count (the highest coin door, at most the level's coins);
// - the plan past its count has the full count, its tour takes the coins in the order the doors allow, and its next gate
//   from a state holding the plan's count is the next coin, where the plan's own next gate is none;
// - a coin door of more coins than the level holds is a static wall (it never opens), and no count above the coins;
// - goexplore.js takes `steer <file>` on stdin (a 'steer' event) and goes on searching.
//   node test/pastplan.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const SF = require('../src/steer.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const levelOfCells = (W, H, cells) => ({ eelvl: ED.eelvlOf({ name: 't', width: W, height: H, cells }) });
const prep = (buf) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));

// 40 x 24, floor row 22: spawn (2, 21); coin A (5, 21); coin door 1 at x 8; coin B (11, 21); coin door 2 at x 14; coin C
// (17, 21); the shaft x 20-22 up to the trophy (21, 2), walls x 19 (rows 1-17) and x 23 (rows 1-21), its footholds coin
// GATES of 3 (solid at 3 coins) at (20, 18) (22, 15) (20, 12) (22, 9) (20, 6) (22, 4); a closet (25-27, 18-21) behind a
// coin door of 3 at x 24 (so the full count is 3); a closet (30-32, 18-21) behind a coin door of 5 at x 29 (the level
// holds 3 coins: it never opens)
const W = 40, H = 24, c = [];
for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, 22, 9], [x, 23, 9]);
for (let y = 1; y < 22; y++) c.push([0, y, 9], [W - 1, y, 9]);
for (const [x, n] of [[8, 1], [14, 2]]) { for (let y = 1; y < 18; y++) c.push([x, y, 9]); for (let y = 18; y < 22; y++) c.push([x, y, 43, n]); }
for (let y = 1; y < 18; y++) c.push([19, y, 9]);
for (let y = 1; y < 22; y++) c.push([23, y, 9]);
for (const [x, y] of [[20, 19], [22, 16], [20, 13], [22, 10], [20, 7], [22, 4]]) c.push([x, y, 165, 3]);
for (const [x0, n] of [[24, 3], [29, 5]]) {
	for (let y = 1; y < 18; y++) c.push([x0, y, 9]);
	for (let y = 18; y < 22; y++) c.push([x0, y, 43, n]);
	for (let x = x0 + 1; x < x0 + 4; x++) c.push([x, 17, 9]);
	for (let y = 1; y < 22; y++) c.push([x0 + 4, y, 9]);
}
c.push([2, 21, 255], [5, 21, 100], [11, 21, 100], [17, 21, 100], [21, 2, 121]);
const buf = levelOfCells(W, H, c).eelvl;
const L = prep(buf);
const at = (x, y) => y * W + x;
/** the state after the ball is put on the tiles in turn (one tick each, no input: coins collected) */
const stateAt = (...pts) => {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (const [x, y] of pts) { sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0; sim.tick(inp); }
	return sim;
};
const tileOfBit = (b) => { for (let t = 0; t < L.coinBit.length; t++) if (L.coinBit[t] === b) return `${t % W},${Math.floor(t / W)}`; return '-'; };

console.log('\n== the full count and the doors that never open');
const A = SF.analyze(L, {});
check('a coin door of more coins than the level holds (5 of 3) is a static wall, not a coins gate', A.gateFeat[at(29, 19)] === 'static' && A.gatePol[at(29, 19)] === 0 && A.cls[at(29, 19)] === 3,
	`${A.gateFeat[at(29, 19)]} ${A.gatePol[at(29, 19)]}`);
check('... a coin door within the count stays a coins gate', A.gateFeat[at(24, 19)] === 'coins' && A.gateFeat[at(8, 19)] === 'coins', `${A.gateFeat[at(24, 19)]} ${A.gateFeat[at(8, 19)]}`);
check('fullCoinT: the highest coin DOOR within the level\'s coins (3; the 5-coin door and the gates do not count above it)', SF.fullCoinT(A) === 3, SF.fullCoinT(A));

console.log('\n== the walk plan\'s count vs the plan past it');
const st = SF.buildSteer(L);
check('the walk plan\'s count is below the full count (it walks up the shaft without the footholds)', st.info.dp && st.info.dp.T < 3 && st.info.fullT === 3, JSON.stringify({ dp: st.info.dp, fullT: st.info.fullT }));
const sp = SF.buildSteer(L, { coinT: st.info.fullT });
check('the plan past its count: the coin DP over 3 coins', sp.dp && sp.dp.T === 3 && sp.dp.n === 3, JSON.stringify(sp.info.dp));
check('... its tour takes the coins in the order the doors allow: (5,21) (11,21) (17,21)', sp.info.dp && JSON.stringify(sp.info.dp.tour) === '[[5,21],[11,21],[17,21]]', JSON.stringify(sp.info.dp && sp.info.dp.tour));
const s2 = stateAt([5, 21], [11, 21]);
const g0 = SF.nextGate(st, s2), g1 = SF.nextGate(sp, s2);
check(`holding the plan's count (${s2.coins} coins): the plan's own next gate is none (or not beyond), the plan past it names coin C (17,21)`,
	s2.coins === 2 && (st.dp.T > 2 ? true : g0 === null) && g1 !== null && tileOfBit(g1.bit) === '17,21', `${g0 ? tileOfBit(g0.bit) : 'none'} / ${g1 ? tileOfBit(g1.bit) : 'none'}`);
const s0 = stateAt();
const v0 = SF.steerAt(Object.assign({}, sp, { dpFirst: true }), s0), v2 = SF.steerAt(Object.assign({}, sp, { dpFirst: true }), s2);
check('the plan past its count with the DP first: a value at the start, falling as the coins come', Number.isFinite(v0) && Number.isFinite(v2) && v2 < v0, `${v0} -> ${v2}`);

console.log('\n== goexplore.js: `steer <file>` on stdin');
(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pastplan-'));
	const lv = path.join(tmp, 'level.eelvl'), f0 = path.join(tmp, 'main.rch4'), f1 = path.join(tmp, 'past.rch4');
	fs.writeFileSync(lv, buf); SF.writeSteerFile(st, f0); SF.writeSteerFile(sp, f1);
	const ch = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lv, '--workers=1', '--seconds=12', '--stdin=1', `--steer=${f0}`, '--cells=coarse', '--seed=3', '--mem=200'], { stdio: ['pipe', 'pipe', 'pipe'] });
	let out = '', sent = false, steerEv = null, closestAfter = 0, done = false;
	ch.stdout.on('data', (d) => {
		out += d;
		let k;
		while ((k = out.indexOf('\n')) >= 0) {
			const line = out.slice(0, k); out = out.slice(k + 1);
			let ev = null; try { ev = JSON.parse(line); } catch (e) { continue; }
			if (ev.ev === 'start' && !sent) { sent = true; setTimeout(() => { try { ch.stdin.write(`steer ${f1}\n`); } catch (e) { /* ended */ } }, 1500); }
			if (ev.ev === 'steer') steerEv = ev;
			if (ev.ev === 'closest' && steerEv) closestAfter++;
			if (ev.ev === 'done' || ev.ev === 'result') done = true;
		}
	});
	await new Promise((res) => ch.on('exit', res));
	check('the switch: a "steer" event with the plan past its count (the DP over 3 coins)', steerEv && steerEv.dp && steerEv.dp.T === 3, JSON.stringify(steerEv));
	check('... the search goes on to its end (a closest attempt by the new measure, or a route)', done && (closestAfter > 0 || done), `closest after the switch: ${closestAfter}, done ${done}`);
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
