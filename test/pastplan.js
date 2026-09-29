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
// (before src/ is required: the editor's data (the steer cache, the search's state) in a temp folder; no proof)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pastplan-home-'));
process.env.EEAT_HOME = HOME;
process.env.EEAT_PROOF = '0';
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

// The coin plan of a steer field that models no coins (the zero count; night 3's coin stall: MKco Mushroom Cup, The 7
// Depths of Hell, Mr Nutty's Wild World, ...): the same level without the coin doors at x 8 and 14, so the walk plan
// passes no shut coin door (the shaft's gates are open at 0 coins, and a gate the model leaves out is open): no coins
// modelled, no DP, while the closet's door reads 3 coins (the full count 3)
const c0 = c.filter(([x, y, id]) => !(id === 43 && (x === 8 || x === 14)));
const buf0 = levelOfCells(W, H, c0).eelvl;
const L0 = prep(buf0);
console.log('\n== the zero count: a field that models no coins, and its coin plan');
const st0 = SF.buildSteer(L0);
check('the field models no coins (no DP), while a coin door reads 3 (the full count 3)', !st0.dp && st0.info.features.indexOf('coins') < 0 && st0.info.fullT === 3,
	JSON.stringify({ features: st0.info.features, dp: st0.info.dp, fullT: st0.info.fullT }));
const sp0 = SF.buildSteer(L0, { coinT: 3, features: ['coins'] });
const sim00 = new E.EESim(L0);
sim00.reset();
check('the coin plan (the coins modelled from the start, buildSteer opts.features): the DP over the 3 coins, a value at the start with the DP first',
	sp0.dp && sp0.dp.T === 3 && sp0.dp.n === 3 && sp0.info.features.indexOf('coins') >= 0 && Number.isFinite(SF.steerAt(Object.assign({}, sp0, { dpFirst: true }), sim00)),
	JSON.stringify({ features: sp0.info.features, dp: sp0.info.dp, start: sp0.info.start }));
const spCap = SF.buildSteer(L0, { coinT: 3, features: ['coins'], maxLayers: 1 });
check('... a feature asked for is modelled only within the layer cap (maxLayers 1: no coins, no DP, said in info.over)', !spCap.dp && spCap.info.features.indexOf('coins') < 0 && /coins/.test(spCap.info.over || ''),
	JSON.stringify({ features: spCap.info.features, over: spCap.info.over }));

// Walk legs (Snow Is Falling: two coins the physics layer fields reach from neither the start nor any other coin, so the
// DP over all 10 had no tour and ordered nothing): a coin on a ledge 11 rows above the floor (no physics way: a jump
// rises ~4 tiles), a 2-coin door before the trophy. The DP over both coins: no tour with walkLegs off; with them (the
// default) the cut coin's leg is its layer's walking distance: a tour, a value at the start. A DP with a tour is unchanged.
console.log('\n== walk legs: a DP with no tour from the start');
{
	const WW = 40, WH = 24, cw = [];
	for (let x = 0; x < WW; x++) cw.push([x, 0, 9], [x, 22, 9], [x, 23, 9]);
	for (let y = 1; y < 22; y++) cw.push([0, y, 9], [WW - 1, y, 9]);
	for (let y = 1; y < 22; y++) cw.push([30, y, 43, 2]);
	cw.push([10, 11, 9], [2, 21, 255], [5, 21, 100], [10, 10, 100], [35, 21, 121]);
	const LW = prep(levelOfCells(WW, WH, cw).eelvl);
	const sw0 = new E.EESim(LW);
	sw0.reset();
	const off = SF.buildSteer(LW, { walkLegs: false }), on = SF.buildSteer(LW);
	const vOff = SF.steerAt(Object.assign({}, off, { dpFirst: true }), sw0), vOn = SF.steerAt(Object.assign({}, on, { dpFirst: true }), sw0);
	check('without walk legs the DP over both coins has no value at the start (the ledge coin is cut by the physics legs)', off.dp && off.dp.T === 2 && !Number.isFinite(vOff) && !SF.nextGate(off, sw0),
		JSON.stringify({ dp: off.info.dp, start: vOff }));
	check('... with them (the default): the ledge coin\'s leg is the walking distance, the DP has a tour and a value at the start, and a next gate', on.info.dp && on.info.dp.walkLegs === 1 && Number.isFinite(vOn) && !!SF.nextGate(on, sw0),
		JSON.stringify({ dp: on.info.dp, start: vOn, gate: SF.nextGate(on, sw0) }));
	check('... a DP the walk does not help is unchanged (the shaft level\'s own DP: its coin C behind the door shut at its count, walk or not; the plan past its count has a tour): no walk legs',
		!st.info.dp.walkLegs && !sp.info.dp.walkLegs,
		JSON.stringify({ st: st.info.dp, sp: sp.info.dp }));
}

/** a stand-in for the CPU search (src/goexplore.js) that never gets nearer: it logs every stdin line with its time (ms
 *  since it started) and, after a switch ("steer <file>"), sends a closest attempt of the new measure (sg) */
const stubOf = (dir, log) => {
	const f = path.join(dir, `stub_${path.basename(log, '.log')}.js`);
	fs.writeFileSync(f, `'use strict';
const fs = require('fs'), t0 = Date.now();
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ ev: 'start', workers: 1, seeds: [1], mode: 'physics', cells: 'coarse', startCost: 40 });
const iv = setInterval(() => say({ ev: 'progress', layer: 5, tick: 5, states: 10, ticks: 1000, ticksPerSec: 1000, picks: 1, bestCost: 50, found: 0, refined: 0, workers: 1 }), 300);
const end = () => { clearInterval(iv); say({ ev: 'done', layers: 5, end: 'stopped', finish: 0 }); process.exit(0); };
let sb = '', sg = 0;
process.stdin.on('data', (d) => {
	sb += d;
	for (let k; (k = sb.indexOf('\\n')) >= 0;) {
		const line = sb.slice(0, k); sb = sb.slice(k + 1);
		fs.appendFileSync(${JSON.stringify(log)}, (Date.now() - t0) + ' ' + line + '\\n');
		if (line.startsWith('steerd ') || line.startsWith('steer ')) { sg++; say({ ev: 'steer', sec: 1 }); say({ ev: 'closest', dist: 30, tick: 14, inputs: '4'.repeat(14), sg }); }
		if (line === 'stop') end();
	}
});
process.stdin.on('end', end);
`);
	return f;
};
const linesOf = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { const k = l.indexOf(' '); return { t: +l.slice(0, k), line: l.slice(k + 1) }; }) : []);

console.log('\n== goexplore.js: `steer <file>` on stdin');
(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pastplan-'));
	const lv = path.join(tmp, 'level.eelvl'), f0 = path.join(tmp, 'main.rch4'), f1 = path.join(tmp, 'past.rch4');
	fs.writeFileSync(lv, buf); SF.writeSteerFile(st, f0); SF.writeSteerFile(sp, f1);
	const ch = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lv, '--workers=1', '--seconds=12', '--stdin=1', `--steer=${f0}`, '--cells=coarse', '--seed=3', '--mem=200'], { stdio: ['pipe', 'pipe', 'pipe'] });
	let out = '', sent = false, steerEv = null, closestAfter = 0, doneEv = null;
	const warn = [];
	ch.stdout.on('data', (d) => {
		out += d;
		let k;
		while ((k = out.indexOf('\n')) >= 0) {
			const line = out.slice(0, k); out = out.slice(k + 1);
			let ev = null; try { ev = JSON.parse(line); } catch (e) { continue; }
			// (the switch early, before the first route: the start cell (no path node) is among the cells rescored)
			if (ev.ev === 'start' && !sent) { sent = true; setTimeout(() => { try { ch.stdin.write(`steer ${f1}\n`); } catch (e) { /* ended */ } }, 300); }
			if (ev.ev === 'steer') steerEv = ev;
			if (ev.ev === 'closest' && steerEv && ev.sg >= 1) closestAfter++;
			if (ev.ev === 'done') doneEv = ev;
			if (ev.ev === 'warning') warn.push(ev.text);
			if (process.env.PP_DEBUG) console.log('   ev', line.slice(0, 160));
		}
	});
	await new Promise((res) => ch.on('exit', res));
	check('the switch: a "steer" event with the plan past its count (the DP over 3 coins)', steerEv && steerEv.dp && steerEv.dp.T === 3, JSON.stringify(steerEv));
	check('... the worker takes it and the search goes on to its end (no error, no warning; its closest attempts after it carry the switch: sg)', doneEv && doneEv.end !== 'error' && !warn.length && closestAfter > 0,
		`end ${doneEv && doneEv.end}, closest attempts by the new field: ${closestAfter}${warn.length ? `, warnings: ${warn.join(' | ').slice(0, 200)}` : ''}`);

	console.log('\n== goexplore.js: `steerd <file>` on stdin (a late steer field that measures the attempts from then on)');
	// (the editor's late field, lateSteer: before, the distances stayed the reach field's for the whole search; on Forgotten
	// Helix the reach field's walk through every coin door put the nearest attempt in a pocket behind a door the level's
	// coins never open). Every closest attempt after the switch carries it (sg 1) and its distance is the steer field's
	// value of the attempt's end state; before it, none carries sg.
	{
		const ch2 = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lv, '--workers=1', '--seconds=6', '--stdin=1', '--cells=coarse', '--seed=3', '--mem=200'], { stdio: ['pipe', 'pipe', 'pipe'] });
		let out2 = '', sent2 = false, steer2 = null, before = 0, beforeSg = 0, after = 0, afterBad = [], done2 = null;
		let srcBefore = 0, srcBeforeSg = 0, srcAfter = 0, srcBehind = 0;
		const srcBad = [];
		const warn2 = [];
		ch2.stdout.on('data', (d) => {
			out2 += d;
			let k;
			while ((k = out2.indexOf('\n')) >= 0) {
				const line = out2.slice(0, k); out2 = out2.slice(k + 1);
				let ev = null; try { ev = JSON.parse(line); } catch (e) { continue; }
				if (ev.ev === 'start' && !sent2) { sent2 = true; setTimeout(() => { try { ch2.stdin.write(`steerd ${f0}\n`); } catch (e) { /* ended */ } }, 500); }
				if (ev.ev === 'steer') steer2 = ev;
				if (ev.ev === 'closest' && !steer2) { before++; if (ev.sg) beforeSg++; }
				if (ev.ev === 'closest' && steer2) {
					after++;
					const ms = Uint8Array.from(ev.inputs, (q) => (q.charCodeAt(0) - 48) & 31);
					const sim = new E.EESim(L), inp = new E.EEInput();
					sim.reset();
					for (const m of ms) { E.applyMask(inp, m); sim.tick(inp); }
					const v = SF.steerAt(st, sim);
					if (!(ev.sg >= 1) || !(Math.abs(v - ev.dist) < 0.01)) afterBad.push(`${ev.dist} (steer ${v}, sg ${ev.sg})`);
				}
				// (the sources: after the switch each carries it and is its end state's steer value, or ranks behind at 6000+:
				// a cell not scored yet, or one a worker sent before it took the switch (onSource))
				if (ev.ev === 'source' && !steer2) { srcBefore++; if (ev.sg) srcBeforeSg++; }
				if (ev.ev === 'source' && steer2) {
					srcAfter++;
					const ms = Uint8Array.from(ev.inputs, (q) => (q.charCodeAt(0) - 48) & 31);
					const sim = new E.EESim(L), inp = new E.EEInput();
					sim.reset();
					for (const m of ms) { E.applyMask(inp, m); sim.tick(inp); }
					const v = SF.steerAt(st, sim);
					if (ev.dist >= 6000) srcBehind++;
					if (!(ev.sg >= 1) || !(ev.dist >= 6000 || Math.abs(v - ev.dist) < 0.01)) srcBad.push(`${ev.kind} ${ev.dist} (steer ${v}, sg ${ev.sg})`);
				}
				if (ev.ev === 'done') done2 = ev;
				if (ev.ev === 'warning') warn2.push(ev.text);
			}
		});
		await new Promise((res) => ch2.on('exit', res));
		check('the late field with its distances: a "steer" event (dist), the search goes on to its end without a warning', steer2 && steer2.dist === true && done2 && done2.end !== 'error' && !warn2.length,
			`${JSON.stringify(steer2)}; end ${done2 && done2.end}${warn2.length ? `; warnings ${warn2.join(' | ').slice(0, 200)}` : ''}`);
		check('... every closest attempt after it carries the switch (sg 1) and is the steer field\'s value of its end state; none before it carries sg',
			after > 0 && !afterBad.length && beforeSg === 0, `before ${before} (sg ${beforeSg}), after ${after}${afterBad.length ? `, off: ${afterBad.slice(0, 4).join(', ')}` : ''}`);
		check('... every source after it carries the switch (sg 1) and is the steer field\'s value of its end state or ranks behind (6000+: not scored yet, or sent before the switch); none before it carries sg',
			srcAfter > 0 && !srcBad.length && srcBeforeSg === 0, `before ${srcBefore} (sg ${srcBeforeSg}), after ${srcAfter} (${srcBehind} behind)${srcBad.length ? `, off: ${srcBad.slice(0, 4).join(', ')}` : ''}`);
	}
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }

	console.log('\n== the editor: the steer worker builds the plan past its count, the running search gets it');
	ED.start({ eelvlB64: buf.toString('base64'), seconds: 8, workers: 1 }, { available: false, why: 'test: no GPU' });
	let es = ED.state();
	for (const t0 = Date.now(); es.running && Date.now() - t0 < 30000 && !(es.steer && es.steer.past); es = ED.state()) await new Promise((r) => setTimeout(r, 100));
	const ready = (es.log || []).find((x) => /the plan past its count is ready/.test(x));
	check('the running search has the plan past its count (T 3, the plan\'s own 2) and says so', !!(es.steer && es.steer.past && es.steer.past.T === 3 && es.steer.past.planT === 2 && ready),
		`${JSON.stringify(es.steer && es.steer.past)}; ${ready || 'no note'}`);
	if (ED.state().running) { ED.stop(); for (const t0 = Date.now(); ED.state().running && Date.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 50)); }
	const stopEd = async () => { if (ED.state().running) { ED.stop(); for (const t0 = Date.now(); ED.state().running && Date.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 50)); } };
	const WAIT = 2;   // (the breaker's first wait, s: test.breakWait)

	console.log('\n== the editor: the coin stall (a CPU search that never gets nearer; the rooms hold fewer coins than the plan\'s count)');
	// (the plan's own count 2 < the full 3: the plan past its count waits for 2 coins held; the rooms hold 0, so at the first
	// stall the search turns to its own field's DP first: "steer <its own file>", once, not before the stall)
	{
		const log = path.join(HOME, 'stall.log'), stub = stubOf(HOME, log);
		const t0 = Date.now();
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 20, workers: 1 }, { available: false, why: 'test: no GPU' }, { cpu: [process.execPath, stub], breakWait: [WAIT] });
		let es2 = ED.state();
		for (; es2.running && Date.now() - t0 < 20000 && !(es2.steer && es2.steer.dpFirst && linesOf(log).length); es2 = ED.state()) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => setTimeout(r, 1500));
		es2 = ED.state();
		const L2 = linesOf(log), sw = L2.filter((x) => x.line.startsWith('steer '));
		const note2 = (es2.log || []).find((x) => /the coin stall: no progress for 2 s and the rooms hold 0 of the plan's 2 coins/.test(x));
		check('at the first stall the CPU search turns to its OWN field with the DP first ("steer <its file>", once, not the plan past its count; after the wait)',
			sw.length === 1 && !/_past\.bin$/.test(sw[0].line) && /\.bin$/.test(sw[0].line) && sw[0].t >= WAIT * 1000 - 500 && !L2.some((x) => x.line.startsWith('steerd ')),
			L2.map((x) => `${x.t} ${x.line.slice(0, 12)}...${x.line.slice(-12)}`).join(' | '));
		check('... says so (the note, S.steer.dpFirst {held 0, T 2}) and the nearest attempt is the new measure\'s (the stand-in\'s sg 1 closest)',
			!!note2 && es2.steer.dpFirst && es2.steer.dpFirst.held === 0 && es2.steer.dpFirst.T === 2 && es2.closest && es2.closest.dist === 30,
			`${note2 || 'no note'}; ${JSON.stringify(es2.steer && es2.steer.dpFirst)}; closest ${es2.closest && es2.closest.dist}`);
		await stopEd();
	}

	console.log('\n== the editor: the coin door (the nearest attempt pinned by a door it cannot open while new rooms keep coming)');
	// (Palmia Ville: the nearest attempt sat by its coin door from 6.5 s while coin rooms kept resetting the stall clock, which
	// ran its 90 s only at ~200 s; here the stand-in's nearest attempt holds 1 coin 4 tiles before the 2-coin door (14, y) and
	// a new room with territory gain comes every 0.4 s: no stall, but no nearer attempt either: the switch after the wait)
	{
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let ms = '';
		for (let t = 0; t < 400; t++) {
			E.applyMask(inp, 4); sim.tick(inp);
			if (sim.coins > 1 || ((sim.px + 8) >> 4) > 10) break;
			ms += '4';
		}
		const endX = (sim.px + 8) >> 4;
		const log = path.join(HOME, 'door.log'), stub = stubOf(HOME, log);
		const stub2 = stub.replace(/\.js$/, '_rooms.js');
		fs.writeFileSync(stub2, fs.readFileSync(stub, 'utf8').replace(`say({ ev: 'start'`, `setTimeout(() => say({ ev: 'closest', dist: 20, tick: ${ms.length}, inputs: '${ms}' }), 300);
let rk = 100; const rv = setInterval(() => { rk++; say({ ev: 'source', kind: 'room', room: rk, desc: 'coins=1', gain: 5, tick: 3, dist: 25, inputs: '444', seed: 1 }); }, 400);
say({ ev: 'start'`));
		const t0 = Date.now();
		ED.start({ eelvlB64: buf.toString('base64'), seconds: 20, workers: 1 }, { available: false, why: 'test: no GPU' }, { cpu: [process.execPath, stub2], breakWait: [WAIT] });
		let es4 = ED.state();
		for (; es4.running && Date.now() - t0 < 20000 && !(linesOf(log).length && es4.steer && es4.steer.dpFirst); es4 = ED.state()) await new Promise((r) => setTimeout(r, 100));
		es4 = ED.state();
		const L4 = linesOf(log), sw4 = L4.filter((x) => x.line.startsWith('steer '));
		const note4 = (es4.log || []).find((x) => /the coin stall: no nearer attempt for 2 s and the nearest attempt \(1 coins\) ends by the 2-coin door at \(14, \d+\)/.test(x));
		check(`the nearest attempt (${ms.length} ticks, 1 coin, ending at x ${endX}) pinned by the 2-coin door while new rooms keep coming: the switch to the own field's DP first after the wait (rooms seen ${(es4.sources || []).length})`,
			sw4.length === 1 && !/_past\.bin$/.test(sw4[0].line) && sw4[0].t >= WAIT * 1000 - 500 && !!note4 && (es4.sources || []).length >= 5,
			`${L4.map((x) => `${x.t} ${x.line.slice(0, 6)}`).join(' | ')}; ${note4 || (es4.log || []).filter((x) => /coin/.test(x)).slice(-2).join(' | ')}`);
		await stopEd();
	}

	console.log('\n== the editor: the coin plan of a field that models no coins (the zero count)');
	// (no coin DP and a field of one layer: the steer worker builds the coin plan (kind 'coins', planT 0); at the first stall
	// the plan's file becomes the search's field (a late one: "steerd") and the switch follows ("steer": the DP first))
	{
		const log = path.join(HOME, 'coins.log'), stub = stubOf(HOME, log);
		const t0 = Date.now();
		ED.start({ eelvlB64: buf0.toString('base64'), seconds: 25, workers: 1 }, { available: false, why: 'test: no GPU' }, { cpu: [process.execPath, stub], breakWait: [WAIT] });
		let es3 = ED.state();
		for (; es3.running && Date.now() - t0 < 25000 && !(linesOf(log).filter((x) => x.line.startsWith('steer ')).length); es3 = ED.state()) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => setTimeout(r, 1000));
		es3 = ED.state();
		const L3 = linesOf(log), ld = L3.findIndex((x) => x.line.startsWith('steerd ')), ls = L3.findIndex((x) => x.line.startsWith('steer '));
		const ready3 = (es3.log || []).find((x) => /the coin plan is ready \(the steer field models no coins; the coin DP over 3 of 3 coins/.test(x));
		const note3 = (es3.log || []).find((x) => /the coin plan: no progress for 2 s with 0 coins held and a steer field that models no coins: the search turns to the coin plan over 3 coins/.test(x));
		check('the steer worker builds the coin plan (T 3 of 3, the plan\'s count 0) and the search says so', !!ready3 && es3.steer && es3.steer.past && es3.steer.past.T === 3 && es3.steer.past.planT === 0,
			`${ready3 || 'no note'}; ${JSON.stringify(es3.steer && es3.steer.past)}`);
		check('... at the first stall its file becomes the search\'s field ("steerd <plan>"), then the switch ("steer <plan>": the DP first), after the wait', ld >= 0 && ls > ld &&
			/_past\.bin$/.test(L3[ld].line) && L3[ls].line.slice(6) === L3[ld].line.slice(7) && L3[ld].t >= WAIT * 1000 - 500 && !!note3 && es3.steer.past.on === true,
			`${L3.map((x) => `${x.t} ${x.line.slice(0, 8)}...${x.line.slice(-12)}`).join(' | ')}; ${note3 || 'no note'}`);
		await stopEd();
	}
	try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* temp */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
