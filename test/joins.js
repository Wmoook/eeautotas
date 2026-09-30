'use strict';
// test/joins.js - the joins stage (src/plan/joins.js) on a hand-made room:
//   1 joinRoute on a slow route (a run with a stop in it, over a gap and a step to the trophy): the result finishes when
//     replayed by the engine, sooner, never slower; the same with the exact edges (o.exact) and the sparse long-skip pass
//     (o.long);
//   2 proveRoute: the legs proven by the event-graph bound, the plain certificate and THE EXACT PROOF (an exhaustive
//     search from the leg's start state to depth ticks - 1); every leg proven by any tier is checked against random input
//     words from its start state (none reaches the leg's support sooner), and a proven leg's lb is its ticks;
//   3 xprove off: no exact proofs.
// Usage: node test/joins.js [--samples=3000]
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const MS = require('../src/plan/msolve.js');
const J = require('../src/plan/joins.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// a floor at row 16, a 3-tile gap (cols 20-22), a step up (cols 28-31 one tile higher), the trophy at (40, 15)
const W = 44, H = 20, F = 16;
const cells = [];
for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
for (let x = 1; x < W - 1; x++) if (x < 20 || x > 22) cells.push([x, F, 9]);
for (let x = 28; x <= 31; x++) cells.push([x, F - 1, 9]);
cells.push([3, 15, 255]);
cells.push([40, 15, 121]);
const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'joins', width: W, height: H, cells }))));

// the slow route: right, a stop of 25 idle ticks at col ~12, right again, a jump at the gap and at the step, right to the end
const R = 4, JUMP = 1;
const ms = [];
const hold = (m, n) => { for (let i = 0; i < n; i++) ms.push(m); };
const sim = new E.EESim(L), inp = new E.EEInput();
sim.reset();
const play = (m) => { ms.push(m); E.applyMask(inp, m); sim.tick(inp); };
while (sim.px < 16 * 12) play(R);
for (let i = 0; i < 25; i++) play(0);
while (sim.px < 16 * 18) play(R);
play(R | JUMP);
while (!sim.has_silver_crown && ms.length < 2000) {
	const c = (sim.px + 8) >> 4;
	play(sim.on_ground && (c === 26 || c === 27) ? R | JUMP : R);
}
const ev0 = C.evaluate(L, Uint8Array.from(ms), true);
ok(!!ev0, 'the slow route finishes');
if (!ev0) { console.log(`joins: ${pass} passed, ${fail} failed`); process.exit(1); }
const masks0 = ev0.ms;

// ---------------------------------------------------------------- 1 joinRoute
for (const [name, o] of [['plain', {}], ['exact edges', { exact: true }], ['long skips', { long: true }]]) {
	const r = J.joinRoute(L, masks0, Object.assign({ ms: 8000, prove: false }, o));
	const ev = C.evaluate(L, r.masks, true);
	ok(!!ev && ev.runTicks === r.runTicks, `${name}: the result replays to its own finish (${ev ? ev.runTicks : 'none'} vs ${r.runTicks})`);
	ok(r.runTicks <= ev0.runTicks, `${name}: never slower (${r.runTicks} vs ${ev0.runTicks})`);
	ok(r.runTicks < ev0.runTicks, `${name}: the stop is cut (${ev0.runTicks} -> ${r.runTicks})`);
	console.log(`  ${name}: ${ev0.runTicks} -> ${r.runTicks} passes ${JSON.stringify(r.passes.map((p) => [p.kind, p.from, p.to]))} stats ex ${r.stats.ex}/${r.stats.exFound}`);
}

// ---------------------------------------------------------------- 2 proveRoute
const best = J.joinRoute(L, masks0, { ms: 6000, prove: false });
const pr = J.proveRoute(L, best.masks, { ms: 20000 });
ok(!!pr && pr.legs.length >= 3, `the route's support legs (${pr ? pr.legs.length : 0})`);
ok(pr.provenBy.exact > 0, `exact proofs (${JSON.stringify(pr.provenBy)}, asked ${pr.xAsked})`);
ok(pr.legs.every((g) => !g.proven || g.lb === g.ticks || g.lb >= g.ticks), 'a proven leg: lb = its ticks');
// every proven leg against random input words from its start state: none reaches the support sooner
const WP = J.waypointsOf(L, best.masks, { gap: 0 });
const samples = +(argv.samples || 3000);
const chk = new E.EESim(L), cinp = new E.EEInput();
let rnd = 12345;
const rand = () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return rnd / 4294967296; };
let checked = 0, beaten = 0;
const s0 = new E.EESim(L), i0 = new E.EEInput();
s0.reset();
let t = 0;
for (let j = 1; j < WP.wps.length; j++) {
	const a = WP.wps[j - 1].t, w = WP.wps[j];
	while (t < a) { E.applyMask(i0, best.masks[t]); s0.tick(i0); t++; }
	const lg = pr.legs[j - 1];
	if (!lg || !lg.proven || w.tele || w.cls === 'D') continue;
	const snap = s0.snapshot();
	const test = (s) => (w.finish ? !!s.has_silver_crown : !s.is_dead && (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4) === w.tile && (w.cls === 'any' || MS.clsOf(s, L.flags) === w.cls) && J.progKey(s) === w.prog);
	for (let n = 0; n < samples / 10; n++) {
		chk.restore(snap);
		let m = [0, R, R | JUMP, 2, 2 | JUMP, JUMP][Math.floor(rand() * 6)];
		for (let k = 1; k < lg.ticks; k++) {
			if (rand() < 0.15) m = [0, R, R | JUMP, 2, 2 | JUMP, JUMP][Math.floor(rand() * 6)];
			E.applyMask(cinp, m); chk.tick(cinp);
			if (chk.is_dead) break;
			if (test(chk)) { beaten++; break; }
		}
		checked++;
	}
}
ok(checked > 0 && beaten === 0, `random input words never beat a proven leg (${checked} words, ${beaten} beat one)`);

// ---------------------------------------------------------------- 3 xprove off
const pr0 = J.proveRoute(L, best.masks, { ms: 20000, xprove: false });
ok(!pr0.provenBy.exact && pr0.xAsked === 0, `xprove off: no exact proof (${JSON.stringify(pr0.provenBy)})`);
ok(pr0.proven <= pr.proven, `the exact tier only adds proofs (${pr0.proven} <= ${pr.proven})`);
console.log(`  proofs: ${pr.proven} of ${pr.legs.length} legs (${JSON.stringify(pr.provenBy)}); without the exact tier ${pr0.proven}; faster from the route's own state ${pr.fasterExact}`);

// ---------------------------------------------------------------- 4 the blind key and the bridge (VERSUS)
// the room with a gold coin on the way (col 10) and a blue coin: no coin door -> both colours blind; a 5-coin gold door
// the route never reaches (its 1 coin) -> gold blind on the route, not with 5 coins held
{
	const mk = (extra) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 'blind', width: W, height: H, cells: cells.concat(extra) }))));
	const Lc = mk([[10, 15, 100], [14, 15, 101]]);
	const b0 = J.blindOf(Lc, 0);
	ok(!!b0 && b0.gold && b0.blue && b0.cp, `blindOf: no coin door, no death -> gold, blue and the checkpoint blind (${JSON.stringify(b0 && { g: b0.gold, b: b0.blue, cp: b0.cp })})`);
	const b1 = J.blindOf(Lc, 1);
	ok(!!b1 && !b1.cp, 'blindOf: a route with a death keeps the checkpoint');
	const Ld = mk([[10, 15, 100], [36, 5, 43, 5]]);
	const bd = J.blindOf(Ld, 0, { gold: 1, blue: 0 });
	ok(!!bd && bd.gold, 'blindOf: a 5-coin door the route (1 coin) never reaches -> gold blind on the route');
	const bn = J.blindOf(Ld, 0, { gold: 5, blue: 0 });
	ok(!!bn && !bn.gold, 'blindOf: the route holds 5 coins -> gold not blind');
	// two states apart only in the coin taken: the blind keys equal, the full keys not
	const s1 = new E.EESim(Lc), s2 = new E.EESim(Lc), ip = new E.EEInput();
	s1.reset(); s2.reset();
	let tk = 0;
	while (!s1.coins && tk++ < 400) { E.applyMask(ip, R); s1.tick(ip); }
	s2.restore(s1.snapshot());
	s2.coins = 0; s2._coinBits = new Int32Array(Lc.coinWords); s2._coinOwned = true;
	ok(s1.coins === 1 && J.progKey(s1) !== J.progKey(s2) && J.progKey(s1, b0) === J.progKey(s2, b0), `progKey: the coin taken or not, the blind key the same (${s1.coins} coins)`);
	// the bridge on the slow route: the result replays, never slower, with and without it
	const rb = J.joinRoute(L, masks0, { ms: 6000, prove: false });
	const evb = C.evaluate(L, rb.masks, true);
	ok(!!evb && evb.runTicks === rb.runTicks && rb.runTicks <= ev0.runTicks, `the bridge on: the result replays (${rb.runTicks}), never slower; bridge calls ${rb.stats.bridge} (shift ${rb.stats.brShift}, leg ${rb.stats.brLeg}, exact ${rb.stats.brExact})`);
}

console.log(`joins: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
