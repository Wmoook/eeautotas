'use strict';
// test/planexec.js: the executor (src/plan/executor.js, exact.js, legs.js, polish.js, execworker.js), the compiler's
// MOVES stage. Prints 'name: ok|FAIL', ends 'N/M' (passed / checks), exit 1 on a failure.
// usage: node test/planexec.js [--only=unit,exact,fail,legs,polish,chain] [--truth] [--limit=N] [--par=K] [--budget=3000] [--json]
//   unit   E-UNIT on a key-door level: the key, the sealed coin (a proof), a region with beforeTick met / missed, the key
//          door named in blockedBy, the trophy, workers 0 = workers 2, a death step (allowDeath) and the same without
//   exact  T-EXEC-EXACT on 6 tiny rooms: exactLeg's depth = an unbounded BFS's minimum, the bound only removes states, the
//          jump skip changes no state; with --truth also 20 known routes: exactLeg from F - 16 to the trophy = endgame.js
//          search()
//   fail   T-EXEC-FAIL: 20 unreachable waypoints: within budget + 200 ms, a FailReport with a closest, blockedBy the key door
//   --truth (EEAT_TRUTH_ROOT: the main checkout or a copy on a box) adds:
//   legs   T-EXEC-LEGS: the known routes cut at their trigger events, reach() from the route's exact state at event k to
//          event k + 1's trigger (budget --budget ms): success % of the legs of <= 300 route ticks, the ticks ratio to the
//          route's own leg, proven %, the tiers, the worst cases (--limit routes; --par processes)
//   polish T-POLISH: 10 AutoTAS routes (god runs' best.eetas): never slower, every output finishes, the ticks saved
//   chain  T-EXEC-CHAIN (informational, only with --only=chain): the executor alone compiling known routes from their
//          waypoints, each leg from the leg before's arrivals, then the polish (--chainN routes, --polishMs, --out rows)
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const EG = require('../src/endgame.js');
const T = require('../src/plan/types.js');
const X = require('../src/plan/exact.js');
const EX = require('../src/plan/executor.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const truth = !!args.truth;
const only = args.only ? new Set(String(args.only).split(',')) : new Set(['unit', 'exact', 'fail', ...(truth ? ['legs', 'polish'] : [])]);
const quiet = !!args.json;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; if (!quiet) console.log(`${name}: ${ok ? 'ok' : 'FAIL'}${detail !== undefined ? `  (${detail})` : ''}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planexec-'));

/** a level from rows of characters (ID: char -> [id, ...args]); also written to a temp .eelvl (the workers' file) */
function levelOf(rows, ID, name) {
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.' && ID[ch]) cells.push([x, y, ...ID[ch]]); }));
	const buf = ED.eelvlOf({ name: name || 't', width: rows[0].length, height: rows.length, cells });
	const file = path.join(tmpDir, `${name || 't'}.eelvl`);
	fs.writeFileSync(file, buf);
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(buf)));
	return { L, file, at: (x, y) => y * L.width + x };
}

async function unit() {
	// # wall, S spawn, k red key, d red key door (a column: nothing passes it without the key), c a sealed coin, T trophy
	const rows = [
		'####################',
		'#...............d..#',
		'#..........###..d..#',
		'#..........#c#..d..#',
		'#S....k....###..d.T#',
		'####################',
	];
	const { L, file, at } = levelOf(rows, { '#': [9], S: [255], k: [6], d: [23], c: [100], T: [121] }, 'unitkey');
	const ex = await EX.createExecutor(L, { file, workers: 0 });
	const start = { masks: new Uint8Array(0) };
	const wpKey = { kind: 'trigger', tiles: [at(6, 4)], trig: 0, expect: { feat: 'key0', value: 1 }, label: 'red key' };
	const r1 = await ex.reach([start], wpKey, { ms: 10000, level: 0 });
	const gk = T.goalOf(L, wpKey);
	const a1 = r1.arrivals[0];
	check('E-UNIT reach(the red key) ok, the arrival replays (playTo goalAt = its end)', r1.ok && a1 && T.playTo(L, a1.masks, { goal: gk }).goalAt === a1.masks.length,
		r1.ok ? `${r1.tool}, ${a1.masks.length} ticks, proven ${r1.legs.map((l) => l.proven).join('/')}, ${r1.ms} ms` : JSON.stringify(r1.fail && r1.fail.why));
	check('E-UNIT the key leg is proven the minimum (the exact search, alone or bounded by the leg found)', r1.ok && r1.legs.length && r1.legs[0].proven && r1.legs[0].lb === r1.legs[0].ticks, r1.legs.map((l) => `${l.ticks}/${l.lb}`).join(' '));
	// (brute force: the least ticks by hand = holding right until the key)
	let hand = -1;
	for (let n = 1; n < 200 && hand < 0; n++) { const p = T.playTo(L, new Uint8Array(n).fill(4), { goal: gk }); if (p.goalAt > 0) hand = p.goalAt; }
	check('E-UNIT the key leg is no slower than holding right', r1.ok && a1.masks.length <= hand, `${a1 && a1.masks.length} vs ${hand}`);
	// the sealed coin
	const wpCoin = { kind: 'trigger', tiles: [at(12, 3)], trig: 1, expect: { feat: 'coins', value: 1 }, label: 'sealed coin' };
	const tc = Date.now();
	const r2 = await ex.reach([start], wpCoin, { ms: 2000, level: 0 });
	const dt2 = Date.now() - tc;
	check('E-UNIT reach(the sealed coin) fails with a proof within budget + 200 ms', !r2.ok && r2.fail && (r2.fail.why === 'proof' || r2.fail.why === 'exhausted') && dt2 <= 2200, `${r2.fail && r2.fail.why} in ${dt2} ms`);
	// the region beyond the door, from the key: beforeTick met, then too soon
	const wpBeyond = (bt) => ({ kind: 'region', tiles: [at(17, 1), at(17, 2), at(17, 3), at(17, 4), at(18, 1), at(18, 2), at(18, 3)], expect: null, label: 'beyond the door', beforeTick: bt });
	const r3 = await ex.reach([a1], wpBeyond(a1.masks.length + 400), { ms: 3000, level: 0 });
	const g3 = T.goalOf(L, wpBeyond(-1));
	check('E-UNIT reach(beyond the key door) with beforeTick met: ok, before it', r3.ok && r3.arrivals.every((a) => a.masks.length <= a1.masks.length + 400 && g3.test(T.playTo(L, a.masks).sim)),
		r3.ok ? `${r3.tool} ${r3.arrivals.map((a) => a.masks.length - a1.masks.length).join(',')} ticks` : r3.fail.why);
	const tb = Date.now();
	const r4 = await ex.reach([a1], wpBeyond(a1.masks.length + 5), { ms: 2000, level: 0 });
	check('E-UNIT reach(beyond the key door) with beforeTick missed: fails (exhausted)', !r4.ok && r4.fail && ['exhausted', 'proof'].includes(r4.fail.why) && Date.now() - tb <= 2200, r4.fail && r4.fail.why);
	// no key: the door blocks, a proof naming it
	const r5 = await ex.reach([start], wpBeyond(-1), { ms: 2000, level: 0 });
	const doorNamed = r5.fail && r5.fail.blockedBy.some((b) => b.feat === 'key0' && L.fg[b.tile] === 23);
	check('E-UNIT without the key: a proof, blockedBy names the red key door', !r5.ok && r5.fail.why === 'proof' && doorNamed, r5.fail && `${r5.fail.why} ${JSON.stringify(r5.fail.blockedBy)}`);
	// the trophy from the key
	const r6 = await ex.reach([a1], { kind: 'trophy', label: 'trophy' }, { ms: 3000, level: 0 });
	check('E-UNIT reach(the trophy) from the key: ok, finishes', r6.ok && r6.arrivals.every((a) => T.playTo(L, a.masks).finished === a.masks.length), r6.ok ? `${r6.tool} ${r6.arrivals[0].masks.length}` : r6.fail.why);
	// workers 0 = workers 2
	const ex2 = await EX.createExecutor(L, { file, workers: 2 });
	const q = await Promise.all([ex2.reach([start], wpKey, { ms: 10000 }), ex2.reach([start], wpCoin, { ms: 2000 })]);
	const s0 = r1.arrivals.map((a) => T.strOf(a.masks)).join('|'), s2 = q[0].ok ? q[0].arrivals.map((a) => T.strOf(a.masks)).join('|') : '';
	check('E-UNIT workers 2 = workers 0 (the same arrivals, the same proof)', ex2.workers() === 2 && s0 === s2 && !q[1].ok && q[1].fail.why === r2.fail.why, `workers ${ex2.workers()}, ${ex2.stats().notes.join('; ')}`);
	await ex2.close();
	await ex.close();
	// a death step (types.js: a region at the respawn tile, expect deaths d + 1, allowDeath): touch the checkpoint, die on
	// the spike, come back at the checkpoint
	{
		const rowsD = [
			'##############',
			'#............#',
			'#S..C....^...#',
			'##############',
		];
		const D = levelOf(rowsD, { '#': [9], S: [255], C: [360], '^': [361, 1] }, 'unitdeath');
		const exD = await EX.createExecutor(D.L, { file: D.file, workers: 0 });
		const wpD = { kind: 'region', tiles: [D.at(4, 2)], expect: { feat: 'deaths', value: 1 }, allowDeath: true, label: 'respawn at the checkpoint' };
		const rD = await exD.reach([start], wpD, { ms: 5000, level: 0 });
		const gD = T.goalOf(D.L, wpD);
		const aD = rD.ok ? rD.arrivals[0] : null;
		const pD = aD ? T.playTo(D.L, aD.masks, { goal: gD, allowDeath: true }) : null;
		check('E-UNIT a death step: the respawn at the checkpoint with 1 death, the arrival replays', rD.ok && pD && pD.goalAt === aD.masks.length && pD.sim.deaths === 1,
			rD.ok ? `${rD.tool}, ${aD.masks.length} ticks` : JSON.stringify(rD.fail && rD.fail.why));
		// the same region without the death rule: the ball is there alive with 0 deaths, never with 1 (a proof or no leg)
		const rN = await exD.reach([start], Object.assign({}, wpD, { allowDeath: false }), { ms: 1500, level: 0 });
		check('E-UNIT the death step without allowDeath: no leg (deaths only rise; a dying run dropped)', !rN.ok, rN.ok ? 'found' : rN.fail.why);
		await exD.close();
	}
}

// ---------------------------------------------------------------- T-EXEC-EXACT
const ROOMS = [
	{ name: 'flat', rows: ['######', '#SG..#', '######'] },
	{ name: 'ledge', rows: ['#####', '#.G.#', '#S#.#', '#####'] },
	{ name: 'down', rows: ['####', '#S.#', '#..#', '#.G#', '####'] },
	{ name: 'dots', rows: ['#####', '#.G.#', '#ooo#', '#S..#', '#####'] },
	{ name: 'wall', rows: ['####', '#.G#', '#S##', '####'] },
	{ name: 'up', rows: ['#####', '#.G.#', '#...#', '#S..#', '#####'] },
];
async function exactRooms() {
	for (const room of ROOMS) {
		const { L, at } = levelOf(room.rows, { '#': [9], S: [255], G: null, '^': [361, 1], o: [4] }, room.name);
		const tiles = [];
		room.rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === 'G') tiles.push(at(x, y)); }));
		const goal = T.goalOf(L, { kind: 'region', tiles, expect: null });
		const sim = new E.EESim(L); sim.reset();
		const starts = [{ snap: sim.snapshot(), tick: 0 }];
		const t0 = Date.now();
		const b = X.solveExact(L, starts, goal, { sim, deadline: Date.now() + 20000, cap: 1000000 });
		const brute = X.exactLeg(L, starts, goal, { sim, noBound: true, maxDepth: 120, deadline: Date.now() + 40000, cap: 1500000 });
		let states = '';
		let fewer = true;
		if (b.status === 'found') {
			const withB = X.exactLeg(L, starts, goal, { sim, maxDepth: b.depth, deadline: Date.now() + 20000, cap: 1500000 });
			const noB = X.exactLeg(L, starts, goal, { sim, noBound: true, maxDepth: b.depth, deadline: Date.now() + 60000, cap: 1500000 });
			// (an unbounded run cut by its clock on a loaded machine has at least the states it saw: still a comparison)
			fewer = withB.stats.states <= noB.stats.states && withB.depth === b.depth && (noB.status !== 'found' || withB.depth === noB.depth);
			states = `states ${withB.stats.states} vs ${noB.stats.states}`;
		}
		check(`T-EXEC-EXACT room ${room.name}: exact depth = unbounded BFS minimum, the bound only removes states`,
			b.status === 'found' && brute.status === 'found' && b.depth === brute.depth && fewer && b.proven,
			`exact ${b.status} ${b.depth}, brute ${brute.status} ${brute.depth}, ${states}, ${Date.now() - t0} ms`);
		// the found tail replays to the goal at its end (first time)
		if (b.status === 'found') {
			const p = T.playTo(L, b.tail, { goal });
			check(`T-EXEC-EXACT room ${room.name}: the tail replays (goal first at its end)`, p.goalAt === b.tail.length, `${p.goalAt} / ${b.tail.length}`);
			// the jump that cannot jump, not simulated: the same distinct states, the same depth as with every mask
			const all = X.exactLeg(L, starts, goal, { sim, maxDepth: b.depth, deadline: Date.now() + 20000, cap: 1500000, noJskip: true });
			const sk = X.exactLeg(L, starts, goal, { sim, maxDepth: b.depth, deadline: Date.now() + 20000, cap: 1500000 });
			check(`T-EXEC-EXACT room ${room.name}: the jump skip changes no state (states, depth)`, all.status === sk.status && all.depth === sk.depth && all.stats.states === sk.stats.states,
				`states ${sk.stats.states} vs ${all.stats.states}, ticks ${sk.stats.ticks} vs ${all.stats.ticks}, skipped ${sk.stats.skipJ}`);
		}
	}
}
async function exactTruth() {
	const S = require('../src/plan/truthset.js');
	const god = S.knownRoutes({ jobs: false });
	const seenLevel = new Set();
	let n = 0, same = 0, tried = 0, foundBoth = 0;
	for (const e of god) {
		if (n >= 20) break;
		if (seenLevel.has(e.name)) continue;
		seenLevel.add(e.name);
		let tr = null;
		try { tr = S.loadTruth(e); } catch (err) { tr = null; }
		if (!tr || tr.masks.length < 40) continue;
		tried++;
		const L = tr.L, F = tr.masks.length;
		const sim = new E.EESim(L); sim.reset();
		const inp = new E.EEInput();
		for (let t = 0; t < F - 16; t++) { E.applyMask(inp, tr.masks[t]); sim.tick(inp); }
		const snap = sim.snapshot();
		const goal = T.goalOf(L, { kind: 'trophy' });
		const r = X.exactLeg(L, [{ snap, tick: F - 16 }], goal, { sim, maxDepth: 16, cap: 300000, deadline: Date.now() + 20000 });
		const B = EG.boundContext(L);
		const g = EG.search(sim, snap, 16, { B, cap: 300000, deadline: Date.now() + 20000 });
		n++;
		// (the same outcome: both find the same depth (<= 16: the route's own finish), or both run out of their cap)
		const ok = r.status === g.status && (r.status !== 'found' || (r.depth === g.depth && r.depth <= 16));
		if (ok) same++;
		if (ok && r.status === 'found') foundBoth++;
		if (!quiet) console.log(`  ${e.name}: exact ${r.status} ${r.depth} (${r.stats.states} states, ${r.stats.seconds} s), endgame ${g.status} ${g.depth} (${g.stats.states} states, ${g.stats.seconds} s)`);
	}
	check(`T-EXEC-EXACT known routes: exactLeg from F - 16 to the trophy = endgame.js search() (${same}/${n}, ${foundBoth} found by both)`, n >= Math.min(20, tried) && same === n && n > 0 && foundBoth > 0, `${same} of ${n}`);
}

// ---------------------------------------------------------------- T-EXEC-FAIL
async function failCases() {
	const cases = [];
	// sealed pockets at several places in rooms of several sizes
	for (let k = 0; k < 16; k++) {
		const w = 14 + (k % 4) * 6, h = 7 + (k % 3) * 2;
		const rows = [];
		for (let y = 0; y < h; y++) rows.push([...'#'.repeat(w)].map((c, x) => (y === 0 || y === h - 1 || x === 0 || x === w - 1 ? '#' : '.')));
		rows[h - 2][1] = 'S';
		const px = 4 + ((k * 5) % (w - 8)), py = 2 + (k % (h - 4));
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) rows[py + dy][px + dx] = '#';
		rows[py][px] = 'c';
		cases.push({ name: `pocket${k}`, rows: rows.map((r) => r.join('')), wp: (at) => ({ kind: 'trigger', tiles: [at(px, py)], expect: { feat: 'coins', value: 1 }, label: 'pocket coin' }), door: false });
	}
	// key doors without the key: the region beyond a door column
	for (let k = 0; k < 4; k++) {
		const w = 16 + k * 3;
		const rows = [];
		for (let y = 0; y < 6; y++) rows.push([...'#'.repeat(w)].map((c, x) => (y === 0 || y === 5 || x === 0 || x === w - 1 ? '#' : '.')));
		rows[4][1] = 'S';
		const dx = w - 5;
		for (let y = 1; y <= 4; y++) rows[y][dx] = ['d', 'e', 'f', 'd'][k] ;
		rows[4][4] = 'k';
		const beyond = [];
		cases.push({ name: `door${k}`, rows: rows.map((r) => r.join('')), door: ['key0', 'key1', 'key2', 'key0'][k],
			wp: (at) => { for (let y = 1; y <= 4; y++) for (let x = dx + 1; x < w - 1; x++) beyond.push(at(x, y)); return { kind: 'region', tiles: beyond, expect: null, label: 'beyond the door' }; } });
	}
	const budget = 1500;
	let within = 0, withClosest = 0, doorOk = 0, doors = 0, worst = 0;
	for (const c of cases) {
		const { L, at } = levelOf(c.rows, { '#': [9], S: [255], c: [100], d: [23], e: [24], f: [25], k: [7] }, c.name);
		const ex = await EX.createExecutor(L, { workers: 0 });
		const t0 = Date.now();
		const r = await ex.reach([{ masks: new Uint8Array(0) }], c.wp(at), { ms: budget, level: 1 });
		const dt = Date.now() - t0;
		worst = Math.max(worst, dt);
		if (!r.ok && dt <= budget + 200) within++;
		if (!r.ok && r.fail && r.fail.closest && r.fail.closest.masks instanceof Uint8Array) withClosest++;
		if (c.door) { doors++; if (r.fail && r.fail.blockedBy.some((b) => b.feat === c.door)) doorOk++; }
		await ex.close();
	}
	check(`T-EXEC-FAIL ${cases.length} unreachable waypoints fail within budget + 200 ms`, within === cases.length, `${within}/${cases.length}, worst ${worst} ms (budget ${budget})`);
	check('T-EXEC-FAIL every one has a FailReport with a closest', withClosest === cases.length, `${withClosest}/${cases.length}`);
	check('T-EXEC-FAIL blockedBy names the key door (no key taken)', doorOk === doors, `${doorOk}/${doors}`);
}

// ---------------------------------------------------------------- T-EXEC-LEGS (the ground truth)
/** the trigger component around a tile (the block there or in its 3 x 3 whose kind the feature is), plus the tile */
function triggerTiles(L, tile, feat) {
	const W = L.width, H = L.height, N = W * H;
	const x0 = tile % W, y0 = (tile / W) | 0;
	const want = featBlocks(feat);
	const seeds = [];
	for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
		const x = x0 + dx, y = y0 + dy;
		if (x < 0 || y < 0 || x >= W || y >= H) continue;
		const i = y * W + x;
		if (want(L.fg[i])) seeds.push(i);
	}
	const out = new Set([tile]);
	for (const s of seeds) {
		const id = L.fg[s];
		const q = [s]; out.add(s);
		while (q.length && out.size < 400) {
			const i = q.pop(), x = i % W, y = (i / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (L.fg[j] === id && !out.has(j)) { out.add(j); q.push(j); }
			}
		}
	}
	void N;
	return [...out];
}
function featBlocks(feat) {
	if (feat === 'coins') return (id) => id === 100 || id === 110;
	if (feat === 'bcoins') return (id) => id === 101 || id === 111;
	if (/^key\d$/.test(feat)) { const k = +feat.slice(3); const ids = [[6], [7], [8], [1002], [1003], [1004]][k] || []; return (id) => ids.includes(id); }
	if (feat.startsWith('psw:')) return (id) => id === 113;
	if (feat.startsWith('osw:')) return (id) => id === 1078 || id === 1080 || id === 1079 ? id === 1078 : false;
	if (feat === 'silver') return (id) => id === 121;
	if (feat === 'crown') return (id) => id === 5;
	return () => false;
}
/** one route's legs: [{name, k, tick, legTicks, ok, ticks, proven, tool, why, ms}] */
async function legsOfRoute(e, budget, maxLegs) {
	const S = require('../src/plan/truthset.js');
	let tr = null;
	try { tr = S.loadTruth(e); } catch (err) { return { error: String(err && err.message || err) }; }
	if (!tr) return { error: 'stale' };
	const L = tr.L;
	const ev = S.routeEvents(L, tr.masks);
	const ord = S.orderOf(ev.events).filter((o) => o.feat !== 'prot');
	// (--parts=<dir>: the other parts' bounds.js / prims.js from that folder, for an integrated measurement; --noPrims)
	let bounds = null, prims = null;
	if (args.parts) {
		try { bounds = require(path.resolve(String(args.parts), 'bounds.js')).createBounds(L, {}); } catch (err) { bounds = null; }
		if (!args.noPrims) { try { prims = await require(path.resolve(String(args.parts), 'prims.js')).createPrims(L, { bounds, workers: 0 }); } catch (err) { prims = null; } }
	}
	const ex = await EX.createExecutor(L, { workers: 0, bounds, prims });
	const out = [];
	let prevTick = 0;
	for (let k = 0; k < ord.length && out.length < maxLegs; k++) {
		const o = ord[k];
		const legTicks = o.tick - prevTick;
		const startMasks = tr.masks.subarray(0, prevTick);
		prevTick = o.tick;
		if (legTicks > 300 || legTicks < 1) { out.push({ name: e.name, k, tick: o.tick, legTicks, skipped: true }); continue; }
		// (a key running out is the clock's, no trigger: no waypoint a plan would give; the next leg starts there)
		if (/^key\d$/.test(o.feat) && !o.value) { out.push({ name: e.name, k, tick: o.tick, legTicks, skipped: true, why: 'clock (a key ran out)' }); continue; }
		const wp = o.feat === 'silver' ? { kind: 'trophy', label: 'trophy' } : { kind: 'trigger', tiles: triggerTiles(L, o.tile, o.feat), expect: { feat: o.feat, value: o.value }, label: `${o.feat}=${o.value}` };
		// (the route's own leg must meet the waypoint at its tick: else the waypoint is not this leg's)
		const g = T.goalOf(L, wp);
		const own = T.playTo(L, tr.masks.subarray(0, o.tick), { goal: g, allowDeath: true });
		if (own.goalAt !== o.tick) { out.push({ name: e.name, k, tick: o.tick, legTicks, skipped: true, why: `own goalAt ${own.goalAt}` }); continue; }
		const t0 = Date.now();
		const r = await ex.reach([{ masks: startMasks }], wp, { ms: budget, level: 1 });
		const ms = Date.now() - t0;
		out.push({ name: e.name, k, tick: o.tick, legTicks, ok: r.ok, ticks: r.ok ? Math.min(...r.arrivals.map((a) => a.masks.length - startMasks.length)) : -1,
			proven: r.ok && r.legs.some((l) => l.proven), tool: r.tool, why: r.ok ? null : r.fail.why, ms, feat: o.feat, lb: r.lb,
			exact: (() => { const x = (r.tiers || []).find((t) => t.tier === 'exact'); return x ? { status: x.status, lb: x.lb, ms: x.ms, maxDepth: x.runs && x.runs.length ? x.runs[x.runs.length - 1].maxDepth : -1 } : null; })(),
			dist: r.ok ? 0 : r.fail && r.fail.closest ? r.fail.closest.dist : -1 });
	}
	await ex.close();
	return { legs: out };
}
async function legsTruth() {
	const S = require('../src/plan/truthset.js');
	const budget = +args.budget || 3000;
	const limit = +args.limit || 40;
	const all = S.knownRoutes();
	// (one route per level name and source, spread over the list)
	const seen = new Set(), list = [];
	for (const e of all) { const key = `${e.source}|${e.name}`; if (seen.has(key)) continue; seen.add(key); list.push(e); }
	const shard = args.shard ? String(args.shard).split('/').map(Number) : null;
	const mine = list.slice(0, limit).filter((e, i) => !shard || i % shard[1] === shard[0]);
	const par = +args.par || 1;
	let rows = [];
	if (par > 1 && !shard) {
		const { spawn } = require('child_process');
		const runs = [];
		for (let i = 0; i < par; i++) {
			runs.push(new Promise((resolve) => {
				const p = spawn(process.execPath, [__filename, '--only=legs', '--truth', `--limit=${limit}`, `--budget=${budget}`, `--shard=${i}/${par}`, '--json', `--maxLegs=${args.maxLegs || 40}`,
					...(args.parts ? [`--parts=${args.parts}`] : []), ...(args.noPrims ? ['--noPrims'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
				let s = '';
				p.stdout.on('data', (d) => { s += d; });
				p.on('close', () => { try { resolve(JSON.parse(s.trim().split('\n').pop()).rows || []); } catch (e) { resolve([]); } });
			}));
		}
		for (const r of await Promise.all(runs)) rows = rows.concat(r);
	} else {
		for (const e of mine) {
			const r = await legsOfRoute(e, budget, +args.maxLegs || 40);
			if (r.legs) rows = rows.concat(r.legs.map((x) => Object.assign(x, { source: e.source })));
		}
	}
	if (shard) { console.log(JSON.stringify({ rows })); return; }
	const legs = rows.filter((x) => !x.skipped);
	const okL = legs.filter((x) => x.ok);
	const ratios = okL.map((x) => x.ticks / x.legTicks).sort((a, b) => a - b);
	const med = ratios.length ? ratios[ratios.length >> 1] : NaN;
	const le1 = ratios.filter((r) => r <= 1 + 1e-9).length;
	const byTool = {};
	for (const x of okL) byTool[x.tool] = (byTool[x.tool] || 0) + 1;
	const proven = okL.filter((x) => x.proven).length;
	const routes = new Set(rows.map((x) => x.name)).size;
	const succ = legs.length ? okL.length / legs.length : 0;
	console.log(`T-EXEC-LEGS ${routes} routes, ${legs.length} legs <= 300 ticks (${rows.length - legs.length} skipped): success ${(succ * 100).toFixed(1)}%, ` +
		`ticks / the route's median ${med.toFixed(3)}, <= 1.0 ${(le1 / Math.max(1, okL.length) * 100).toFixed(1)}%, proven ${(proven / Math.max(1, okL.length) * 100).toFixed(1)}%, tiers ${JSON.stringify(byTool)}`);
	const worst = legs.filter((x) => !x.ok).sort((a, b) => a.legTicks - b.legTicks).slice(0, 12);
	for (const w of worst) console.log(`  fail ${w.name} leg ${w.k} (${w.feat}, ${w.legTicks} route ticks at ${w.tick}): ${w.why} ${w.ms} ms`);
	const slow = okL.filter((x) => x.ticks > x.legTicks).sort((a, b) => b.ticks / b.legTicks - a.ticks / a.legTicks).slice(0, 6);
	for (const w of slow) console.log(`  slower ${w.name} leg ${w.k} (${w.feat}): ${w.ticks} vs ${w.legTicks} (${w.tool})`);
	const over = legs.filter((x) => x.ms > budget + 200).length;
	check(`T-EXEC-LEGS success >= 70% of legs of <= 300 route ticks`, succ >= 0.7, `${(succ * 100).toFixed(1)}% of ${legs.length}`);
	check(`T-EXEC-LEGS every call within budget + 200 ms`, over === 0, `${over} over`);
	if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(rows));
}

// ---------------------------------------------------------------- T-EXEC-CHAIN (informational)
/** the executor alone compiling a known route from its waypoints: every leg from the ARRIVALS of the leg before (as the
 *  planner will call it), the route's trigger events in order as the waypoints (a key running out skipped, a waypoint
 *  the route's own leg does not meet skipped), budget x (the route's leg ticks / 150) a leg (3 s .. 15 s); then the
 *  fastest finished arrival polished (--polishMs). Rows: legs done, the compiled run ticks vs the route's, polished. */
async function chainOfRoute(e, budget, polishMs) {
	const S = require('../src/plan/truthset.js');
	const C = require('../src/common.js');
	let tr = null;
	try { tr = S.loadTruth(e); } catch (err) { return { name: e.name, error: String(err && err.message || err) }; }
	if (!tr) return { name: e.name, error: 'stale' };
	const L = tr.L;
	const ord0 = S.orderOf(S.routeEvents(L, tr.masks).events).filter((o) => o.feat !== 'prot' && !(/^key\d$/.test(o.feat) && !o.value));
	// (--chainStep=N: a region waypoint every N route ticks between two events (the route's centre tile there and its 8
	// neighbours, no Expect): the path skeleton a planner gives for a long leg)
	const step = +args.chainStep || 0;
	const ord = [];
	{
		let prev = 0;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let t = 0;
		for (const o of ord0) {
			if (step > 0) for (let u = prev + step; u < o.tick - step / 2; u += step) {
				for (; t < u; t++) { E.applyMask(inp, tr.masks[t]); sim.tick(inp); }
				const tl = T.tileOf(sim, L.width, L.height), x = tl % L.width, y = (tl / L.width) | 0, tiles = [];
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < L.width && y + dy < L.height) tiles.push((y + dy) * L.width + x + dx);
				ord.push({ tick: u, feat: 'region', tiles });
			}
			ord.push(o);
			prev = o.tick;
		}
	}
	const ex = await EX.createExecutor(L, { workers: 0 });
	let starts = [{ masks: new Uint8Array(0) }];
	let prevTick = 0, done = 0, failAt = -1, why = null, ms = 0;
	const delays = [];
	const t0 = Date.now();
	for (let k = 0; k < ord.length; k++) {
		const o = ord[k];
		const legTicks = o.tick - prevTick;
		const wp = o.feat === 'silver' ? { kind: 'trophy', label: 'trophy' } : o.feat === 'region' ? { kind: 'region', tiles: o.tiles, expect: null, label: `region @${o.tick}` }
			: { kind: 'trigger', tiles: triggerTiles(L, o.tile, o.feat), expect: { feat: o.feat, value: o.value }, label: `${o.feat}=${o.value}` };
		const g = T.goalOf(L, wp);
		if (o.feat !== 'region') {
			const own = T.playTo(L, tr.masks.subarray(0, o.tick), { goal: g, allowDeath: true });
			if (own.goalAt !== o.tick) continue;
		}
		prevTick = o.tick;
		const b = Math.max(budget, Math.min(15000, Math.round(budget * legTicks / 150)));
		const r = await ex.reach(starts, wp, { ms: b, level: 1 });
		if (!r.ok) { failAt = k; why = r.fail ? r.fail.why : '?'; break; }
		starts = r.arrivals;
		delays.push(Math.min(...starts.map((a) => a.masks.length)) - o.tick);
		if (args.delays) console.error(`  leg ${k} ${wp.label}: route ${legTicks} ticks, from ${Math.min(...r.legs.map((l) => l.ticks))} (${r.tool}, lb ${r.lb}), delay ${delays[delays.length - 1]}, ${r.ms} ms`);
		done++;
		if (wp.kind === 'trophy') break;
	}
	ms = Date.now() - t0;
	let compiled = -1, polished = -1, pms = 0;
	if (failAt < 0) {
		const fin = starts.filter((a) => a.finished).sort((a, b) => a.masks.length - b.masks.length);
		const ev = fin.length ? C.evaluate(L, fin[0].masks, false) : null;
		if (ev) {
			compiled = ev.runTicks;
			// (--saveDir: the compiled route, for the polish's own measurements)
			if (args.saveDir) { try { C.writeEetas(path.join(String(args.saveDir), `${e.name}.compiled.eetas`), ev.ms); } catch (err) { /* optional */ } }
			const t1 = Date.now();
			const p = await ex.polish(ev.ms, { ms: polishMs });
			pms = Date.now() - t1;
			const ev2 = C.evaluate(L, p.masks, false);
			polished = ev2 ? ev2.runTicks : -1;
		}
	}
	await ex.close();
	return { name: e.name, legs: ord.length, done, failAt, why, known: tr.runTicks, compiled, polished, ms, pms, delays };
}
async function chainTruth() {
	const S = require('../src/plan/truthset.js');
	const budget = +args.budget || 3000, polishMs = +args.polishMs || 30000, limit = +args.chainN || 12;
	const god = S.knownRoutes({ jobs: false });
	const seen = new Set(), list = [];
	for (const e of god) { if (seen.has(e.name)) continue; seen.add(e.name); list.push(e); }
	const shard = args.shard ? String(args.shard).split('/').map(Number) : null;
	const mine = list.slice(0, limit).filter((e, i) => !shard || i % shard[1] === shard[0]);
	const par = +args.par || 1;
	let rows = [];
	if (par > 1 && !shard) {
		const { spawn } = require('child_process');
		const runs = [];
		for (let i = 0; i < par; i++) {
			runs.push(new Promise((resolve) => {
				const p = spawn(process.execPath, [__filename, '--only=chain', '--truth', `--chainN=${limit}`, `--budget=${budget}`, `--polishMs=${polishMs}`, `--chainStep=${+args.chainStep || 0}`, `--shard=${i}/${par}`, '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
				let s = '';
				p.stdout.on('data', (d) => { s += d; });
				p.on('close', () => { try { resolve(JSON.parse(s.trim().split('\n').pop()).rows || []); } catch (e) { resolve([]); } });
			}));
		}
		for (const r of await Promise.all(runs)) rows = rows.concat(r);
	} else for (const e of mine) rows.push(await chainOfRoute(e, budget, polishMs));
	if (shard) { console.log(JSON.stringify({ rows })); return; }
	if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(rows));
	for (const r of rows) console.log(`  ${r.name}: ${r.error ? 'error ' + r.error : `${r.done}/${r.legs} legs${r.failAt >= 0 ? ` (failed at ${r.failAt}: ${r.why})` : ''}, known ${r.known}, compiled ${r.compiled}, polished ${r.polished} (${(r.ms / 1000).toFixed(1)} s + ${(r.pms / 1000).toFixed(1)} s)${args.delays ? ' delays ' + (r.delays || []).join(',') : ''}`}`);
	const full = rows.filter((r) => r.compiled > 0);
	const ratio = (a) => a.map((r) => r.x).sort((p, q) => p - q);
	const rc = ratio(full.map((r) => ({ x: r.compiled / r.known }))), rp = ratio(full.filter((r) => r.polished > 0).map((r) => ({ x: r.polished / r.known })));
	console.log(`T-EXEC-CHAIN ${rows.length} routes, compiled end to end ${full.length}; run ticks / the known route's median compiled ${rc.length ? rc[rc.length >> 1].toFixed(3) : '-'}, polished ${rp.length ? rp[rp.length >> 1].toFixed(3) : '-'}`);
}

// ---------------------------------------------------------------- T-POLISH
async function polishTruth() {
	const S = require('../src/plan/truthset.js');
	const C = require('../src/common.js');
	const god = S.knownRoutes({ jobs: false });
	const seenLevel = new Set();
	let n = 0, never = 0, fin = 0, saved = 0;
	const ms = +args.polishMs || 8000;
	for (const e of god) {
		if (n >= (+args.polishN || 10)) break;
		if (seenLevel.has(e.name)) continue;
		seenLevel.add(e.name);
		let tr = null;
		try { tr = S.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) continue;
		const ex = await EX.createExecutor(tr.L, { workers: 0 });
		const r = await ex.polish(tr.masks, { ms });
		await ex.close();
		const ev = C.evaluate(tr.L, r.masks, false);
		n++;
		if (ev) fin++;
		if (ev && ev.runTicks <= tr.runTicks) never++;
		saved += ev ? tr.runTicks - ev.runTicks : 0;
		if (!quiet) console.log(`  ${e.name}: ${tr.runTicks} -> ${ev ? ev.runTicks : 'none'} (${r.steps ? r.steps.map((s) => s.how).join(',') : ''})`);
	}
	check(`T-POLISH never slower (${n} routes)`, never === n && n > 0, `${never}/${n}, saved ${saved} ticks in all`);
	check('T-POLISH every output finishes', fin === n && n > 0, `${fin}/${n}`);
}

if (require.main === module) (async () => {
	const t0 = Date.now();
	try {
		if (only.has('unit')) await unit();
		if (only.has('exact')) { await exactRooms(); if (truth) await exactTruth(); }
		if (only.has('fail')) await failCases();
		if (only.has('legs') && truth) await legsTruth();
		if (only.has('polish') && truth) await polishTruth();
		if (only.has('chain') && truth) await chainTruth();
	} catch (e) { fail++; console.log(`error: FAIL (${e && e.stack || e})`); }
	if (!args.shard) console.log(`planexec: ${pass}/${pass + fail} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
	process.exit(fail ? 1 : 0);
})();
module.exports = { triggerTiles, featBlocks, legsOfRoute, levelOf };
