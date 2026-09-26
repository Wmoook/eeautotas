'use strict';
// The reach field (src/reach.js), CPU only:
//   physics  hand-made rooms where the answer is known from the engine: a real input sequence reaches the trophy and
//            every state on the way has a finite cost; or no way exists and the start's cost is -1
//   bellman  the self-check (every cost equals the best forward move) on random levels
//   goals    the goals option (explore.js --hunt's time-to-go field): the trophy as the goal gives the default field,
//            the self-check with goals at their own costs, and maxCost cuts the field without changing what it keeps
//   jobs     (when src/jobs has jobs) every state of every job's original and best run is reachable
// usage: node test/reach.js [--only=physics|bellman|goals|jobs]        Exit code 1 if any check fails.
const fs = require('fs');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const R = require('../src/reach.js');

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
const levelOf = (W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells }))));
/** play masks from the level start: every state before the finish must have a finite cost; returns {finished, cut} */
function walk(level, f, masks) {
	const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
	let cut = 0;
	for (const m of masks) {
		E.applyMask(inp, m); sim.tick(inp);
		if (sim.has_silver_crown) return { finished: true, cut };
		if (sim.is_dead) return { finished: false, cut, dead: true };
		if (R.costAt(f, sim.px, sim.py, sim.speed_y, !!sim.on_ground) < 0) cut++;
	}
	return { finished: false, cut };
}
const startCost = (level, f) => { const sim = new E.EESim(level); sim.reset(); return R.costAt(f, sim.px, sim.py, sim.speed_y, !!sim.on_ground); };
const seq = (...parts) => { const out = []; for (const [m, n] of parts) for (let k = 0; k < n; k++) out.push(m); return out; };
/** the fastest-looking of a few simple input patterns that finish (walk right, jump at tick j, hold right) */
function findJump(level, maxTicks) {
	for (let j = 0; j < 80; j++) {
		const masks = seq([4, j], [5, 1], [4, maxTicks]);
		const sim = new E.EESim(level); sim.reset(); const inp = new E.EEInput();
		for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (sim.has_silver_crown) return masks.slice(0, t + 1); if (sim.is_dead) break; }
	}
	return null;
}

function physicsSection() {
	section('physics: rooms with a known answer');
	// a ledge 3 tiles above the floor: a standing jump (63.42 px) gets on it
	let cells = room(20, 10);
	for (let x = 10; x <= 18; x++) for (let y = 6; y <= 8; y++) cells.push([x, y, 9]);
	cells.push([14, 5, 121], [3, 8, 255]);
	let L = levelOf(20, 10, cells), f = R.reachField(L, { check: true });
	let route = findJump(L, 200);
	let w = route ? walk(L, f, route) : null;
	check('a 3-tile ledge: a real jump finishes and every state on the way is reachable', route && w.finished && w.cut === 0 && f.mismatches === 0, route ? `${route.length} ticks, ${w.cut} cut, ${f.mismatches} mismatches` : 'no route by simple jumps');
	// the same ledge 5 tiles high: far out of reach of a jump (63.42 px); the only way to the trophy
	cells = room(20, 12);
	for (let x = 10; x <= 18; x++) for (let y = 5; y <= 10; y++) cells.push([x, y, 9]);
	cells.push([14, 4, 121], [3, 10, 255]);
	L = levelOf(20, 12, cells); f = R.reachField(L, { check: true });
	check('a 5-tile ledge: the model proves no way (start cost -1), and no simple jump finishes', startCost(L, f) < 0 && !findJump(L, 200) && f.mismatches === 0, startCost(L, f));
	// a trophy right beside the top of a 3-tile wall, 4 rows up: the centre of a jump just gets into its row (63.42 px of
	// rise against 55.42 needed), so the model must allow it (an optimistic model never rules out a real route)
	cells = room(20, 10);
	for (let y = 5; y <= 8; y++) cells.push([12, y, 9]);
	cells.push([11, 4, 121], [3, 8, 255]);
	L = levelOf(20, 10, cells); f = R.reachField(L, { check: true });
	route = findJump(L, 200);
	w = route ? walk(L, f, route) : null;
	check('a trophy 4 rows up beside a wall: a real jump takes it, and the model allows every state on the way', route && w.finished && w.cut === 0 && startCost(L, f) >= 0, route ? `${route.length} ticks, ${w.cut} cut` : 'no route by simple jumps');
	// a row of dots on the floor with the trophy 3 rows above it: no jumps in dots, and a dot row lifts the centre about
	// one row (a real search of every input for 400 ticks never finishes either)
	cells = room(12, 10);
	for (let x = 1; x <= 10; x++) cells.push([x, 8, 4]);   // dots on the floor
	cells.push([5, 5, 121], [4, 7, 255]);
	L = levelOf(12, 10, cells); f = R.reachField(L, { check: true });
	check('a dot row 3 rows under the trophy: no way up (start cost -1)', startCost(L, f) < 0 && f.mismatches === 0, startCost(L, f));
	// an up-arrow pad under a long fall: it bounces the ball back up (a trampoline) to a trophy high above
	cells = room(12, 24);
	for (let y = 20; y <= 21; y++) cells.push([6, y, 2]);
	for (let x = 1; x <= 10; x++) if (x !== 6) cells.push([x, 21, 9]);
	for (let x = 1; x <= 4; x++) cells.push([x, 4, 9]);
	cells.push([6, 3, 121], [2, 3, 255]);
	L = levelOf(12, 24, cells); f = R.reachField(L, { check: true });
	check('an up-arrow trampoline: the high trophy counts as reachable', startCost(L, f) >= 0 && f.mismatches === 0, startCost(L, f));
	// the trophy walled off, only through a portal pair
	cells = room(20, 8);
	for (let y = 1; y <= 6; y++) cells.push([13, y, 9]);
	cells.push([8, 6, 242, 0, 1, 2], [15, 6, 242, 0, 2, 1], [17, 6, 121], [2, 6, 255]);
	L = levelOf(20, 8, cells); f = R.reachField(L, { check: true });
	route = seq([4, 200]);
	w = walk(L, f, route);
	check('a portal pair: walking right finishes through it and every state is reachable', w.finished && w.cut === 0 && startCost(L, f) >= 0, JSON.stringify(w));
	// a diagonal staircase of spikes (213): the centre slips past the spike corners
	cells = room(16, 16);
	for (let k = 0; k < 10; k++) { cells.push([3 + k, 3 + k, 361]); cells.push([5 + k, 3 + k, 361]); }
	cells.push([4, 2, 255], [13, 13, 121]);
	L = levelOf(16, 16, cells); f = R.reachField(L, { check: true });
	check('a diagonal spike corridor: reachable', startCost(L, f) >= 0 && f.mismatches === 0, startCost(L, f));
}

/** the random levels of the self-checks: {W, H, level} */
function randomLevels() {
	let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
	const ids = [9, 9, 9, 9, 4, 4, 2, 1, 3, 361, 1052, 119, 369, 116, 114, 1518, 23, 43];
	const out = [];
	for (let k = 0; k < 16; k++) {
		const W = 14 + (k % 4) * 6, H = 10 + (k % 3) * 5, cells = room(W, H);
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rnd() < 0.2) { const id = ids[Math.floor(rnd() * ids.length)]; cells.push(id === 1052 ? [x, y, id, Math.floor(rnd() * 4)] : id === 43 || id === 23 ? [x, y, id, 1] : [x, y, id]); }
		if (k % 4 === 0) cells.push([2, 2, 242, 0, 1, 2], [W - 3, 2, 242, 0, 2, 1]);
		cells.push([Math.floor(W / 2), 2, 121], [2, H - 2, 255]);
		out.push({ W, H, level: levelOf(W, H, cells) });
	}
	return out;
}

function bellmanSection() {
	section('bellman: the self-check on random levels');
	let bad = 0, levels = 0;
	for (const { level } of randomLevels()) {
		const f = R.reachField(level, { check: true });
		levels++; if (f.mismatches) bad++;
	}
	check(`${levels} random levels: every cost equals the best forward move`, bad === 0, `${bad} with mismatches`);
}

function goalsSection() {
	section('goals: a field to given tiles at given costs (explore.js --hunt)');
	const levels = randomLevels();
	// the trophy tiles as goals at cost 0: the default field, cost for cost
	let same = 0;
	for (const { level } of levels) {
		const trophies = [];
		for (let i = 0; i < level.fg.length; i++) if (level.fg[i] === 121) trophies.push({ tile: i, cost: 0 });
		const a = R.reachField(level), b = R.reachField(level, { goals: trophies });
		if (a.cost.length === b.cost.length && a.cost.every((v, i) => v === b.cost[i]) && a.goals === b.goals) same++;
	}
	check(`${levels.length} random levels: the trophy tiles as goals give the default field`, same === levels.length, `${same} the same`);
	// goals along a random path at decreasing costs (like a reference run's time to go): the self-check, with the goal
	// tiles not ends of the way; maxCost keeps every cost up to it and cuts the rest to -1
	let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
	let bad = 0, badCut = 0, cut = 0, kept = 0;
	for (const { W, H, level } of levels) {
		const goals = [];
		for (let k = 0; k < 12; k++) goals.push({ tile: (1 + Math.floor(rnd() * (H - 2))) * W + 1 + Math.floor(rnd() * (W - 2)), cost: Math.floor(rnd() * 40) / 2 });
		const f = R.reachField(level, { goals, check: true });
		if (f.mismatches) bad++;
		let top = 0;
		for (const v of f.cost) if (v > top) top = v;
		const maxCost = top / 2;
		const g = R.reachField(level, { goals, maxCost, check: true });
		let wrong = g.mismatches;
		for (let i = 0; i < f.cost.length; i++) {
			if (f.cost[i] >= 0 && f.cost[i] <= maxCost) { kept++; if (g.cost[i] !== f.cost[i]) wrong++; }
			else { cut++; if (g.cost[i] !== -1) wrong++; }
		}
		if (wrong) badCut++;
	}
	check(`${levels.length} random levels, 12 goals each: every cost equals the best forward move or its goal's own cost`, bad === 0, `${bad} with mismatches`);
	check(`maxCost = half the highest cost: the same costs up to it (${kept} states), -1 beyond (${cut})`, badCut === 0 && kept > 0 && cut > 0, `${badCut} levels wrong`);
	// a goals field is no cost to the trophy (its -1 is no proof): never written for eegpu
	let refused = false;
	try { R.writeReachFile(R.reachField(levels[0].level, { goals: [{ tile: 0, cost: 0 }] }), path.join(require('os').tmpdir(), `reach_goals_${process.pid}.bin`)); } catch (e) { refused = true; }
	check('writeReachFile refuses a goals field', refused);
}

function jobsSection() {
	section('jobs: every state of every known run is reachable');
	const JOBS = path.join(__dirname, '..', 'src', 'jobs');
	if (!fs.existsSync(JOBS)) { console.log('  (no jobs)'); return; }
	for (const id of fs.readdirSync(JOBS).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(JOBS, d, 'original.eelvl')))) {
		let level;
		try { level = E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(path.join(JOBS, id, 'original.eelvl'))))); } catch (e) { continue; }
		if (level.width * level.height > 20000) continue;   // (big levels take seconds each; the reach model's own test covers them)
		const f = R.reachField(level);
		for (const run of ['original.eetas', 'best.eetas']) {
			const file = path.join(JOBS, id, run);
			if (!fs.existsSync(file)) continue;
			const w = walk(level, f, C.readEetas(file));
			check(`${id} ${run}`, w.cut === 0, `${w.cut} states cut`);
		}
	}
}

if (!ONLY || ONLY === 'physics') physicsSection();
if (!ONLY || ONLY === 'bellman') bellmanSection();
if (!ONLY || ONLY === 'goals') goalsSection();
if (!ONLY || ONLY === 'jobs') jobsSection();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
