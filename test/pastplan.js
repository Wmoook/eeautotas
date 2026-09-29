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
	try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* temp */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
