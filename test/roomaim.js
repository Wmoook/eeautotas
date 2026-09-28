'use strict';
// bursts.js roomAim (the wall breaker's room target where the coin plan gives none, hx-r1-guidance 2026-09-28) and the
// breaker's progress order (editor.js coinsOfDesc): on a small coin-sequence level (coin doors 1 and 2, a door of more
// coins than the level holds in front of a pocket, a spike-boxed coin):
// - the goals are the triggers the state's own walk reaches with the doors as its room holds them (a shut coin door is
//   a wall, a coin behind it no goal), killing tiles closed (a coin boxed in by spikes no goal), taken coins none;
// - a trigger whose room the search has seen already is no goal (known), and no goal at all is null (the trophy then);
// - the trophy is a goal once the walk reaches it; the field is 0 on the goals and grows by 5 a step (the reach file's
//   fifths), the start's value finite.
//   node test/roomaim.js
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const GX = require('../src/goexplore.js');
const BU = require('../src/bursts.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const levelOfCells = (W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells }))));

// 44 x 12: floor row 10; spawn (2, 9); coin A (6, 9); coin door 1 at x 10; coin B (14, 9); coin door 2 at x 18; the
// trophy (22, 9); a door of 5 coins at x 26 (the level holds 3) in front of a pocket with coin P (30, 9); coin S (38, 8)
// on a ledge boxed in by spikes, reachable only through them
const W = 44, H = 12, c = [];
for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, 10, 9], [x, 11, 9]);
for (let y = 1; y < 10; y++) c.push([0, y, 9], [W - 1, y, 9]);
for (const [x, n] of [[10, 1], [18, 2], [26, 5]]) { for (let y = 1; y < 8; y++) c.push([x, y, 9]); c.push([x, 8, 43, n], [x, 9, 43, n]); }
c.push([2, 9, 255], [6, 9, 100], [14, 9, 100], [22, 9, 121], [30, 9, 100]);
// the spike box: coin S at (38, 8) on a wall ledge (38, 9), spikes all around it
c.push([38, 9, 9], [38, 8, 100]);
for (const [x, y] of [[37, 7], [38, 7], [39, 7], [37, 8], [39, 8], [37, 9], [39, 9]]) c.push([x, y, 361, 1]);
const L = levelOfCells(W, H, c);
const RM = GX.roomOf(L);
const T = { TR: BU.triggersOf(L), PT: BU.portalsOf(L) };
const tiles = (aim) => (aim ? aim.goals.map((g) => `${g % W},${(g / W) | 0}`).sort() : []);
/** the state after the ball is put on the tiles in turn (one tick each, no input: coins collected) */
const stateAt = (...pts) => {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (const [x, y] of pts) { sim.px = x * 16; sim.py = y * 16; sim.speed_x = 0; sim.speed_y = 0; sim.tick(inp); }
	return sim;
};
const none = () => false;

console.log('\n== roomAim');
{
	const s0 = stateAt();
	const a0 = BU.roomAim(L, RM, s0, none, T);
	check('0 coins: the goal is coin A alone (coin B behind the shut 1-coin door, the pocket behind the 5-coin door, the spike-boxed coin, the trophy behind the 2-coin door: none)',
		a0 && tiles(a0).join(' ') === '6,9', JSON.stringify(tiles(a0)));
	check('... the nearest goal is coin A, the field 0 on it, 5 a step, the start 4 steps out', a0 && a0.x === 6 && a0.y === 9 && a0.walk[9 * W + 6] === 0 && a0.start === 20, a0 ? `(${a0.x}, ${a0.y}) start ${a0.start}` : 'null');
	check('... a tile behind the shut door has no value (cut)', a0 && a0.walk[9 * W + 14] === 0xffff, a0 ? a0.walk[9 * W + 14] : 'null');
	const k1 = RM.key(stateAt([6, 9]));
	const a0k = BU.roomAim(L, RM, s0, (k) => k === k1, T);
	check('0 coins, the 1-coin room known already: no goal (null: the breaker aims at the trophy as before)', a0k === null, JSON.stringify(tiles(a0k)));
	const s1 = stateAt([6, 9]);
	const a1 = BU.roomAim(L, RM, s1, none, T);
	check('1 coin (A taken): the goal is coin B through the open 1-coin door (A is taken: no goal)', a1 && tiles(a1).join(' ') === '14,9', JSON.stringify(tiles(a1)));
	const s2 = stateAt([6, 9], [14, 9]);
	const a2 = BU.roomAim(L, RM, s2, none, T);
	check('2 coins: the trophy through the open 2-coin door; the pocket (behind 5) and the spike-boxed coin still none', a2 && tiles(a2).join(' ') === '22,9', JSON.stringify(tiles(a2)));
	check('the ball\'s state is left as it was (roomAim restores its snapshot)', s2.coins === 2 && s2.px === 14 * 16, `coins ${s2.coins}, px ${s2.px}`);
}
console.log('\n== the breaker\'s progress order');
{
	const f = ED.coinsOfDesc;
	check('coinsOfDesc: "coins=3" 3, "lowgrav coins=3" 3, "coins=2 bluecoins=4" 6, "key:red" 0, "(start)" 0',
		f('coins=3') === 3 && f('lowgrav coins=3') === 3 && f('coins=2 bluecoins=4') === 6 && f('key:red') === 0 && f('(start)') === 0,
		[f('coins=3'), f('lowgrav coins=3'), f('coins=2 bluecoins=4'), f('key:red'), f('(start)')].join(' '));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
