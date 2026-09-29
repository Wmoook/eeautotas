'use strict';
// tools/excdata.js: the data behind goexplore.js --exc=1 (the excursion head X, EXC_BANDS): how far ABOVE the running
// minimum of the reach cost the winning lineages go, learned from the GPU filler's runs. Reads the filler's dataset and
// the portfolio's sweep sw1 (git-ignored, read only; the run archives' route and closest-attempt inputs are replayed in
// memory, nothing is extracted to disk) and writes NUMBERS only (never a level or TAS file):
//   node tools/excdata.js [--root=<checkout with src/out>] [--res=src/out/fill/res] [--sw=src/out/pf/sweep/sw1]
//        [--levels=src/out/god/levels] [--routes=3] [--stalled=3] [--every=5] [--jobs=1] [--only=<regex on the file>]
//        [--json=<out.json>]
// The rows: src/out/fill/res/box*/results.jsonl (their archives runs/<file>__<config>__s<seed>.tgz) and
// src/out/pf/sweep/sw1/results.jsonl (runs/<file>__<config>/). Per level (by md5; its .eelvl from src/out/god/levels
// campaign / hard / d4): up to --routes routed runs' FIRST route (route_1_*.eetas: the lineage the search found first)
// and up to --stalled stalled runs' (not routed, stopped by the stall-kill or the cap) nearest attempt (closest.eetas,
// the nearest first). Each is replayed in the exact engine; every --every ticks the state's cost is sampled with THE
// SAME FIELD AND COST the search's cells carry as rc (goexplore.js settle + fieldOpts: the reach field, with deaths as
// moves the death-free field where it has a value, as costOf's --dord; a state whose only way is a death, cost >=
// reach.js DEATH_TILES, and a ruled-out one are not sampled), and the RUNNING MINIMUM of the cost along the lineage is
// kept, RESET AT EVERY ROOM CHANGE (goexplore.js roomOf(L).key: coins, keys, switches, effects, team; layer-aware, the
// room the search's cells are in). A sample's excursion = cost - running min, in the bands
// EXC_EDGES [0,5) [5,20) [20,60) [60,150) [150,inf) tiles. Per lineage the share of its samples per band; per level the
// mean of its routes (and of its stalled attempts); the profile = the mean over the levels, each level weight 1.
// Prints / writes: n levels / routes / rows / commits; the profile of the routes (every level with a route: the
// EXC_BANDS goexplore.js bakes), of the routes on the levels that also have a stalled run (matched) and of those stalled
// runs' nearest attempts; the per-level GAP list (route >= 20 share minus stalled >= 20 share, largest first: the A/B
// target list); THE DEPARTURES (excursionsOf): the first route's sustained excursions (>= 20 tiles above the room's
// running minimum for >= 100 ticks), how many leave from > 20 tiles above the stalled runs' pin (the lowest cost their
// nearest attempts reach), how many happen in the pin's room and in a room the stalled SEARCHES registered (result.json
// find.roomsSeen), and the levels whose route leaves on a >= 150-tile detour within its first 500 ticks (the start is
// the pin). 2026-09-29: 373 excursions on 71 levels, 281 leave > 20 tiles above the pin, 35 in the pin's room, 282 in a
// room the stalled searches had: the routes' detours leave from points the stalled searches passed, in rooms they had.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** the band edges (tiles above the running minimum): [0,5) [5,20) [20,60) [60,150) [150,inf) */
const EXC_EDGES = [5, 20, 60, 150];
const NB = EXC_EDGES.length + 1;
/** the band of an excursion x (tiles) */
const bandOf = (x) => { let b = 0; while (b < EXC_EDGES.length && x >= EXC_EDGES[b]) b++; return b; };
/** a lineage's band counts from its samples [[cost, roomKey], ...] (in time order): the running minimum of the cost,
 *  reset at every room change; {h: counts per band, n} */
function profileOf(samples) {
	const h = new Array(NB).fill(0);
	let rk, mn = Infinity, n = 0;
	for (let i = 0; i < samples.length; i++) {
		const c = samples[i][0], k = samples[i][1];
		if (i === 0 || k !== rk) { rk = k; mn = Infinity; }
		if (c < mn) mn = c;
		h[bandOf(c - mn)]++; n++;
	}
	return { h, n };
}
/** the shares of a profile (null when it has no sample) */
const sharesOf = (p) => (p.n > 0 ? p.h.map((x) => x / p.n) : null);
/** the mean of share vectors (each weight 1; null ones skipped); null when none */
function meanOf(list) {
	const v = list.filter((s) => s !== null);
	if (!v.length) return null;
	const m = new Array(NB).fill(0);
	for (const s of v) for (let b = 0; b < NB; b++) m[b] += s[b] / v.length;
	return m;
}
/** the share at or above band 2 (>= 20 tiles uphill) */
const upOf = (s) => (s === null ? null : s[2] + s[3] + s[4]);
/** the gap list: [{file, route, stalled, gap}] by gap (route >= 20 share minus stalled >= 20 share), largest first */
function gapList(levels) {
	return levels.filter((l) => l.route !== null && l.stalled !== null).map((l) => ({ file: l.file, route: upOf(l.route), stalled: upOf(l.stalled), gap: upOf(l.route) - upOf(l.stalled) }))
		.sort((x, y) => y.gap - x.gap || (x.file < y.file ? -1 : 1));
}

// ---- the run archives (.tgz): a gzip'd tar read in memory (ustar / GNU names; regular files only)
function tarEntries(buf, want) {
	const tar = zlib.gunzipSync(buf), out = new Map();
	let o = 0, longName = null;
	while (o + 512 <= tar.length) {
		const hd = tar.subarray(o, o + 512);
		if (hd[0] === 0) break;
		const str = (a, b) => { const s = hd.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('latin1'); };
		let name = str(0, 100);
		const prefix = str(345, 500), size = parseInt(str(124, 136).trim() || '0', 8), type = String.fromCharCode(hd[156] || 48);
		if (prefix && hd[257] === 0x75) name = prefix + '/' + name;
		const body = tar.subarray(o + 512, o + 512 + size);
		o += 512 + Math.ceil(size / 512) * 512;
		if (type === 'L') { longName = body.toString('latin1').replace(/\0.*$/s, ''); continue; }
		if (longName !== null) { name = longName; longName = null; }
		if (type !== '0' && type !== '\0') continue;
		const base = name.split('/').pop();
		if (want(base)) out.set(base, Buffer.from(body));
	}
	return out;
}
const isRoute1 = (b) => /^route_1_\d+\.eetas$/.test(b);
/** a run's inputs: its first route or its nearest attempt ({route, closest}: Buffers or null) */
function runFiles(r, P) {
	const base = r.file.replace(/\.eelvl$/i, '');
	if (r._src === 'sw1') {
		const d = path.join(P.sw, 'runs', `${base}__${r.config}`);
		let names = [];
		try { names = fs.readdirSync(d); } catch (e) { return null; }
		const rf = names.find(isRoute1);
		return { route: rf ? fs.readFileSync(path.join(d, rf)) : null, closest: names.includes('closest.eetas') ? fs.readFileSync(path.join(d, 'closest.eetas')) : null,
			rooms: names.includes('result.json') ? roomsSeenOf(fs.readFileSync(path.join(d, 'result.json'))) : null };
	}
	const t = path.join(P.res, r._src, 'runs', `${base}__${r.config}__s${r.seed || 1}.tgz`);
	if (!fs.existsSync(t)) return null;
	let m;
	try { m = tarEntries(fs.readFileSync(t), (b) => isRoute1(b) || b === 'closest.eetas' || b === 'result.json'); } catch (e) { return null; }
	let route = null;
	for (const [k, v] of m) if (isRoute1(k)) route = v;
	return { route, closest: m.get('closest.eetas') || null, rooms: m.has('result.json') ? roomsSeenOf(m.get('result.json')) : null };
}
/** the room keys (goexplore.js roomOf) a run's whole search registered: result.json find.roomsSeen [key, desc, s, n] */
function roomsSeenOf(buf) {
	try { const R = JSON.parse(buf.toString('utf8')); return (R && R.find && R.find.roomsSeen || []).map((q) => q[0] | 0); } catch (e) { return null; }
}
/** a lineage's SUSTAINED excursions (the departures analysis): the stretches of at least minLen ticks whose samples stay
 *  >= minEx tiles above the running minimum since the room was entered; each {at (tick), dep (the running minimum when it
 *  starts: where the detour leaves from), peak, len (ticks), room} */
function excursionsOf(samples, every, minEx = 20, minLen = 100) {
	const out = [];
	let rk, mn = Infinity, ep = null;
	const close = () => { if (ep && ep.len >= minLen) out.push(ep); ep = null; };
	samples.forEach(([c, k], i) => {
		if (i === 0 || k !== rk) { close(); rk = k; mn = Infinity; }
		if (c < mn) mn = c;
		const x = c - mn;
		if (x >= minEx) { if (!ep) ep = { at: (i + 1) * every, dep: mn, peak: x, len: 0, room: k }; ep.len += every; if (x > ep.peak) ep.peak = x; } else close();
	});
	close();
	return out;
}

// ---- the replay (the engine and the search's own field / cost / rooms)
function levelCtx(file, P) {
	const E = require(path.join(P.src, 'eesim.js')), EL = require(path.join(P.src, 'eelvl.js'));
	const RF = require(path.join(P.src, 'reach.js')), GX = require(path.join(P.src, 'goexplore.js'));
	let f = null;
	for (const s of ['campaign', 'hard', 'd4']) { const g = path.join(P.levels, s, file); if (fs.existsSync(g)) { f = g; break; } }
	if (f === null) return null;
	const L = E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(f)), { id: 'excdata', file }));
	// (the search's options for this level: coarse or fine cells, deaths as moves; the field and cost as costOf's)
	const a = GX.settle(GX.parseArgs([f]), L, { total: 64 * 2 ** 30, free: 32 * 2 ** 30, others: 0 });
	const F = RF.reachField(L, GX.fieldOpts(a));
	const OF = a.deathMoves && a.dord !== 0 ? RF.reachField(L, { deaths: false }) : null;
	return { L, F, OF, RM: GX.roomOf(L), E, RF, C: require(path.join(P.src, 'common.js')) };
}
/** the samples [[cost, roomKey], ...] of a replay of masks, every `every` ticks (the reach cost the search's cells carry) */
function samplesOf(X, masks, every) {
	const { L, F, OF, RM, E, RF } = X;
	const sim = new E.EESim(L); sim.reset();
	const inp = new E.EEInput();
	let done = false;
	sim.onEvent = (k) => { if (k === 'complete') done = true; };
	const out = [];
	for (let t = 0; t < masks.length && !done; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		if ((t + 1) % every !== 0 || sim.is_dead) continue;
		let c = RF.costAt(F, sim);
		if (!(c >= 0)) continue;
		if (OF !== null) { const nf = RF.costAt(OF, sim); if (!(nf >= 0)) continue; c = nf; }
		if (c >= RF.DEATH_TILES) continue;
		out.push([c, RM.key(sim)]);
	}
	return out;
}
/** one level's numbers: {file, md5, routes, stalledRuns, route (shares), stalled (shares), rows} */
function levelNumbers(task, P) {
	const X = levelCtx(task.file, P);
	if (X === null) return { file: task.file, md5: task.md5, skip: 'no level file' };
	const R = [], S = [];
	let first = null;   // (the first route's samples: the departures analysis)
	for (const r of task.R) {
		if (R.length >= P.routes) break;
		const f = runFiles(r, P);
		if (!f || !f.route) continue;
		const sm = samplesOf(X, X.C.parseEetasBuffer(f.route), P.every);
		const p = profileOf(sm);
		if (p.n) { R.push(p); if (first === null) first = sm; }
	}
	// (the stalled runs: their nearest attempts' profile; their pin = the lowest cost those attempts reach, its room; the rooms
	// their whole searches registered)
	let pin = Infinity, pinRoom = null;
	const sRooms = new Set();
	for (const r of task.S) {
		if (S.length >= P.stalled) break;
		const f = runFiles(r, P);
		if (!f || !f.closest) continue;
		const sm = samplesOf(X, X.C.parseEetasBuffer(f.closest), P.every);
		for (const [c, k] of sm) if (c < pin) { pin = c; pinRoom = k; }
		if (f.rooms) for (const k of f.rooms) sRooms.add(k);
		const p = profileOf(sm);
		if (p.n) S.push(p);
	}
	// THE DEPARTURES: the first route's sustained excursions against the stalled runs' pin
	let dep = null;
	if (first !== null && S.length && Number.isFinite(pin)) {
		const eps = excursionsOf(first, P.every);
		dep = { n: eps.length, abovePin: eps.filter((e) => e.dep > pin + 20).length, inPinRoom: eps.filter((e) => e.room === pinRoom).length,
			inSearchRooms: sRooms.size ? eps.filter((e) => sRooms.has(e.room | 0)).length : null, pin: Math.round(pin * 10) / 10,
			first: eps.length ? { at: eps[0].at, dep: Math.round(eps[0].dep), peak: Math.round(eps[0].peak), len: eps[0].len } : null };
	}
	return { file: task.file, md5: task.md5, routes: R.length, stalledRuns: S.length, route: meanOf(R.map(sharesOf)), stalled: meanOf(S.map(sharesOf)),
		samples: R.reduce((x, p) => x + p.n, 0) + S.reduce((x, p) => x + p.n, 0), dep };
}

// ---- the dataset
function readRows(P) {
	const rd = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
	const rows = [];
	let boxes = [];
	try { boxes = fs.readdirSync(P.res).filter((b) => /^box\d+$/.test(b)).sort(); } catch (e) { /* none */ }
	for (const b of boxes) for (const r of rd(path.join(P.res, b, 'results.jsonl'))) { r._src = b; rows.push(r); }
	for (const r of rd(path.join(P.sw, 'results.jsonl'))) { r._src = 'sw1'; rows.push(r); }
	return rows;
}
function tasksOf(rows, only) {
	const by = new Map();
	for (const r of rows) {
		if (!r.md5 || !r.file || (only && !only.test(r.file))) continue;
		let t = by.get(r.md5);
		if (!t) by.set(r.md5, t = { md5: r.md5, file: r.file, R: [], S: [] });
		if (r.routed) t.R.push(r);
		else if (!r.preempted && (r.stop === 'stall' || r.stop === 'cap')) t.S.push(r);
	}
	// (the stalled runs nearest first; the routed ones fastest first)
	for (const t of by.values()) {
		t.S.sort((x, y) => (x.nearest == null ? 1e9 : x.nearest) - (y.nearest == null ? 1e9 : y.nearest));
		t.R.sort((x, y) => (x.firstRouteS == null ? 1e9 : x.firstRouteS) - (y.firstRouteS == null ? 1e9 : y.firstRouteS));
	}
	return [...by.values()].filter((t) => t.R.length > 0).sort((x, y) => (x.file < y.file ? -1 : 1));
}

async function main() {
	const opt = {};
	for (const s of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(s); if (m) opt[m[1]] = m[2]; }
	const ROOT = path.resolve(opt.root || path.join(__dirname, '..'));
	const P = { src: path.join(__dirname, '..', 'src'), res: path.resolve(ROOT, opt.res || 'src/out/fill/res'), sw: path.resolve(ROOT, opt.sw || 'src/out/pf/sweep/sw1'),
		levels: path.resolve(ROOT, opt.levels || 'src/out/god/levels'), routes: +(opt.routes || 3), stalled: +(opt.stalled || 3), every: Math.max(1, +(opt.every || 5)) };
	const rows = readRows(P);
	const tasks = tasksOf(rows, opt.only ? new RegExp(opt.only) : null);
	const jobs = Math.max(1, Math.min(64, +(opt.jobs || 1)));
	const t0 = Date.now();
	let res;
	if (jobs === 1) res = tasks.map((t) => levelNumbers(t, P));
	else {
		const { Worker } = require('worker_threads');
		res = new Array(tasks.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, () => new Promise((ok, bad) => {
			const w = new Worker(__filename, { workerData: { excdata: P } });
			const feed = () => { if (next >= tasks.length) { w.terminate().then(ok, ok); return; } const i = next++; w.postMessage({ i, task: tasks[i] }); };
			w.on('message', (m) => { res[m.i] = m.r; feed(); });
			w.on('error', bad);
			feed();
		})));
	}
	const lv = res.filter((r) => r && !r.skip && r.route !== null);
	const matched = lv.filter((l) => l.stalled !== null);
	const used = new Set(tasks.filter((t) => lv.some((l) => l.md5 === t.md5)).flatMap((t) => [...t.R, ...t.S]));
	const commits = [...new Set([...used].map((r) => r.commit).filter(Boolean))].sort();
	const rnd = (v) => (v === null ? null : v.map((x) => Math.round(x * 10000) / 10000));
	const out = {
		tool: 'tools/excdata.js', date: new Date().toISOString(), edges: EXC_EDGES, every: P.every, ms: Date.now() - t0,
		rows: rows.length, rowsUsed: used.size, levels: lv.length, routes: lv.reduce((x, l) => x + l.routes, 0), matched: matched.length,
		stalledRuns: matched.reduce((x, l) => x + l.stalledRuns, 0), samples: lv.reduce((x, l) => x + l.samples, 0), commits,
		routesAll: rnd(meanOf(lv.map((l) => l.route))), routesMatched: rnd(meanOf(matched.map((l) => l.route))), stalledMatched: rnd(meanOf(matched.map((l) => l.stalled))),
		gap: gapList(matched).map((g) => ({ file: g.file, route: Math.round(g.route * 1000) / 1000, stalled: Math.round(g.stalled * 1000) / 1000, gap: Math.round(g.gap * 1000) / 1000 })),
		perLevel: lv.map((l) => ({ file: l.file, routes: l.routes, stalledRuns: l.stalledRuns, route: rnd(l.route), stalled: rnd(l.stalled) })),
		skipped: res.filter((r) => r && r.skip).map((r) => [r.file, r.skip]),
	};
	const bandTxt = ['[0,5)', '[5,20)', '[20,60)', '[60,150)', '[150,inf)'].join(' ');
	const f = (v) => (v === null ? '-' : v.map((x) => x.toFixed(3)).join(' '));
	console.log(`excdata: ${out.rows} rows (${out.rowsUsed} used), ${out.levels} levels with a route (${out.routes} routes), ${out.matched} with a stalled run too (${out.stalledRuns} stalled attempts), ${out.samples} samples every ${P.every} ticks, commits ${commits.join(',')}, ${(out.ms / 1000).toFixed(1)} s`);
	console.log(`bands ${bandTxt} (tiles above the running min of the reach cost, reset at every room change)`);
	console.log(`  routes, every level with a route : ${f(out.routesAll)}`);
	console.log(`  routes, matched levels           : ${f(out.routesMatched)}`);
	console.log(`  stalled nearest attempts, matched: ${f(out.stalledMatched)}`);
	// THE DEPARTURES (where the routes' sustained excursions leave from, against the stalled runs' pin and rooms)
	const D = matched.filter((l) => l.dep);
	const sum = (k) => D.reduce((x, l) => x + (l.dep[k] || 0), 0);
	const withRooms = D.filter((l) => l.dep.inSearchRooms !== null);
	out.departures = { levels: D.length, excursions: sum('n'), abovePin: sum('abovePin'), inPinRoom: sum('inPinRoom'),
		inSearchRooms: withRooms.reduce((x, l) => x + l.dep.inSearchRooms, 0), ofExcursionsWithRooms: withRooms.reduce((x, l) => x + l.dep.n, 0),
		startFalseNear: D.filter((l) => l.dep.first && l.dep.first.at <= 500 && l.dep.first.peak >= 150).map((l) => ({ file: l.file, ...l.dep.first })) };
	out.perLevel.forEach((p) => { const l = lv.find((x) => x.file === p.file); if (l && l.dep) p.dep = l.dep; });
	const dd = out.departures;
	console.log(`departures: the first routes' sustained excursions (>= 20 tiles above the room's running min for >= 100 ticks) on ${dd.levels} matched levels: ${dd.excursions}; leaving > 20 tiles above the stalled runs' pin ${dd.abovePin}; in the pin's room ${dd.inPinRoom}; in a room the stalled searches registered ${dd.inSearchRooms} of ${dd.ofExcursionsWithRooms}`);
	console.log(`  the start is the pin (the first excursion within 500 ticks, >= 150 tiles up): ${dd.startFalseNear.map((s) => `${s.file.replace(/\.eelvl$/, '')} (t${s.at}, +${s.peak}, ${s.len} ticks)`).join('; ') || '-'}`);
	console.log('gap (route >= 20 share - stalled >= 20 share), largest first:');
	for (const g of out.gap) console.log(`  ${g.gap.toFixed(3)}  route ${g.route.toFixed(3)} stalled ${g.stalled.toFixed(3)}  ${g.file}`);
	if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(out, null, 1));
}

const WT = require('worker_threads');
if (!WT.isMainThread && WT.workerData && WT.workerData.excdata) {
	// (a worker of --jobs: one level at a time)
	const P = WT.workerData.excdata;
	WT.parentPort.on('message', (m) => { let r; try { r = levelNumbers(m.task, P); } catch (e) { r = { file: m.task.file, md5: m.task.md5, skip: String(e && e.message || e) }; } WT.parentPort.postMessage({ i: m.i, r }); });
} else if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { EXC_EDGES, bandOf, profileOf, sharesOf, meanOf, upOf, gapList, excursionsOf, tarEntries, roomsSeenOf, readRows, tasksOf, runFiles, levelCtx, samplesOf };
