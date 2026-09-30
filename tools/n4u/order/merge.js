'use strict';
// N4U STUDY 3: merge build.js's rows into the plan oracle (oracle.json) + the numbers of the report (summary.json) and
// the unrouted levels' dependency structures (unrouted.json, hardest first).
// usage: node tools/n4u/order/merge.js --rows=<dir> --out=<dir> [--compare=1] (EEAT_TRUTH_ROOT = the main checkout)
//   --compare=1: src/landmarks.js (the planner's LM guide) against the same routes (its landmarks every route misses)
const fs = require('fs');
const path = require('path');
const TS = require('../../../src/plan/truthset.js');
const O = require('./lib.js');

const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const rowsDir = argOf('rows', '.'), outDir = argOf('out', '.');
const root = path.resolve(process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..', '..'));
const rows = fs.readdirSync(rowsDir).filter((f) => /^rows_.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(rowsDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const levelRows = rows.filter((r) => r.type === 'level');
const routeRows = rows.filter((r) => r.type === 'route');
const fileOf = new Map(TS.levelFiles({ root }).map((l) => [l.set + '/' + l.name, path.relative(root, l.file).replace(/\\/g, '/')]));
const orcOf = new Map();
for (const l of levelRows) if (l.orc) orcOf.set(l.name, l.orc);

/** a route vs an oracle (loose or tight): missing landmarks, broken order pairs */
function routeCheck(orc, rf) {
	const miss = [], viol = [];
	for (const l of orc.landmarks || []) if (rf.firstTick[l.f] === undefined) miss.push(l.f);
	for (const [a, b] of orc.order || []) {
		const ta = rf.firstTick[a], tb = rf.firstTick[b];
		if (tb === undefined) continue;
		if (ta === undefined || ta > tb) viol.push([a, b, ta === undefined ? null : ta, tb]);
	}
	return { missing: miss, violations: viol };
}

// ---------------------------------------------------------------- routes
const routes = [];
const S = { routes: 0, stale: 0, looseMiss: 0, looseViol: 0, tightMiss: 0, tightViol: 0, withLm: 0, lmTotal: 0, lmUsed: 0, achievedDoor: 0, usedDoor: 0, toggleBackRoutes: 0, teamMulti: 0, revisit: [], reentries: [], usedNotLm: 0, levelsRouted: new Set(), tightMissLevels: new Set(), looseMissLevels: new Set() };
for (const r of routeRows) {
	if (r.stale) { S.stale++; routes.push({ name: r.name, source: r.source, jobId: r.jobId, route: r.route, stale: true }); continue; }
	const orc = r.orc || orcOf.get(r.name);
	if (!orc || !r.rf) continue;
	S.routes++;
	S.levelsRouted.add(r.levelKey);
	const lc = routeCheck(orc, r.rf), tc = orc.tight && orc.tight.landmarks ? routeCheck(orc.tight, r.rf) : null;
	if (lc.missing.length) { S.looseMiss++; S.looseMissLevels.add(r.name); }
	if (lc.violations.length) S.looseViol++;
	if (tc && tc.missing.length) { S.tightMiss++; S.tightMissLevels.add(r.name); }
	if (tc && tc.violations.length) S.tightViol++;
	const lms = (orc.landmarks || []).map((l) => l.f);
	if (lms.length) { S.withLm++; S.lmTotal += lms.length; }
	const usedPos = r.rf.used.filter((f) => !f.startsWith('!'));
	S.lmUsed += lms.filter((f) => r.rf.used.includes(f)).length;
	const doorF = new Set(orc.doorFacts || []);
	const achievedDoor = r.rf.factOrder.filter((f) => doorF.has(f));
	S.achievedDoor += achievedDoor.length; S.usedDoor += usedPos.length;
	S.usedNotLm += usedPos.filter((f) => !lms.includes(f)).length;
	if (r.rf.toggleBacks > 0) S.toggleBackRoutes++;
	if (r.rf.teamChanges > 1) S.teamMulti++;
	S.revisit.push(r.rf.revisit); S.reentries.push(r.rf.blockReentries);
	const lmTick = lms.map((f) => [f, r.rf.firstTick[f] === undefined ? null : r.rf.firstTick[f]]).sort((x, y) => (x[1] === null ? 1e9 : x[1]) - (y[1] === null ? 1e9 : y[1]));
	routes.push({
		name: r.name, source: r.source, jobId: r.jobId, route: r.route, levelKey: r.levelKey, runTicks: r.runTicks, complete: r.complete, deaths: r.deaths,
		check: Object.assign(lc, { routeLandmarkOrder: lmTick.filter((x) => x[1] !== null).map((x) => x[0]), landmarkTicks: Object.fromEntries(lmTick) }), tcheck: tc,
		factOrder: r.rf.factOrder, firstTick: r.rf.firstTick, used: r.rf.used, usedNotLandmark: usedPos.filter((f) => !lms.includes(f)), achievedDoorFacts: achievedDoor.length,
		toggleBacks: r.rf.toggleBacks, teamChanges: r.rf.teamChanges, pswOffs: r.rf.pswOffs, blockReentries: r.rf.blockReentries, blocks: r.rf.blocks, revisit: +r.rf.revisit.toFixed(3),
		orc: r.jobId ? orc : undefined,
	});
}

// ---------------------------------------------------------------- levels
const routedNames = new Set(routes.filter((r) => !r.stale).map((r) => r.name));
const levels = levelRows.map((l) => ({ name: l.name, set: l.set, file: fileOf.get(l.set + '/' + l.name), routed: routedNames.has(l.name), orc: l.orc, err: l.err }));
const L = { levels: levels.length, err: 0, relaxUnreach: 0, trophyFree: 0, withLm: 0, chain: [], lm: [], rounds: [], deathSeeded: 0, tightDiff: 0, tightUnreach: 0, partial: 0, unrouted: 0 };
for (const l of levels) {
	const o = l.orc;
	if (!o) { L.err++; continue; }
	if (!l.routed) L.unrouted++;
	if (o.trophyRound < 0) { L.relaxUnreach++; continue; }
	if (o.trophyRound === 0 && !(o.landmarks || []).length) L.trophyFree++;
	if ((o.landmarks || []).length) L.withLm++;
	L.chain.push(o.chain.length); L.lm.push(o.landmarks.length); L.rounds.push(o.rounds);
	if (o.deathSeeded) L.deathSeeded++;
	if (o.partial) L.partial++;
	if (o.tight) {
		if (o.tight.trophyRound < 0) L.tightUnreach++;
		else if ((o.tight.landmarks || []).length !== o.landmarks.length) L.tightDiff++;
	}
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const hist = (a) => { const h = {}; for (const v of a) h[v] = (h[v] || 0) + 1; return h; };

// ---------------------------------------------------------------- the unrouted levels' dependency structures, hardest first
function structOf(l) {
	const o = l.orc;
	const lm = o.landmarks || [];
	const kinds = {};
	for (const x of lm) { const k = x.f.startsWith('coins>=') ? 'coins' : x.f.startsWith('bcoins>=') ? 'bcoins' : x.f.replace(/[:=].*$/, '').replace(/\d$/, ''); kinds[k] = (kinds[k] || 0) + 1; }
	// toggle risk: a gate (pol 0) of a landmark's feature the relaxation reaches (turning the switch on shuts it: an order
	// the delete relaxation cannot see)
	const conflicts = [];
	for (const x of lm) {
		const g = o.gatesByFact['!' + x.f] || (x.f.startsWith('team=') ? o.gatesByFact['!team=' + x.f.slice(5)] : null);
		if (g && g.reached) conflicts.push(x.f);
	}
	const coinLm = lm.filter((x) => x.f.startsWith('coins>=')).map((x) => +x.f.slice(7));
	const score = (o.trophyRound < 0 ? 1000 : 0) + 4 * o.chain.length + lm.length + 3 * conflicts.length + (coinLm.length ? Math.max(...coinLm) / 4 : 0) + (o.tight && o.tight.trophyRound < 0 ? 20 : 0);
	return {
		name: l.name, set: l.set, file: l.file, routed: l.routed, trophyRound: o.trophyRound, rounds: o.rounds, landmarks: lm.map((x) => x.f), kinds, chain: o.chain, orderPairs: (o.order || []).length,
		doorFacts: (o.doorFacts || []).length, unreachableDoorFacts: (o.unreachableDoorFacts || []).length, doorComps: o.doorComps, gatesByFact: o.gatesByFact,
		coins: [o.coinsReached, o.coinsTotal], bcoins: [o.bcoinsReached, o.bcoinsTotal], deathSeeded: o.deathSeeded, conflicts,
		tight: o.tight ? { trophyRound: o.tight.trophyRound, landmarks: (o.tight.landmarks || []).map((x) => x.f).filter((f) => !lm.some((y) => y.f === f)) } : null,
		trophies: o.trophies, start: o.start, score: +score.toFixed(1),
	};
}
const structs = levels.filter((l) => l.orc).map(structOf);
// (MEAS5, the last full product measurement: routed or not in 5 / 10 min, by level file name)
const meas5 = new Map();
try {
	for (const line of fs.readFileSync(path.join(root, 'src', 'out', 'd4', 'meas5', 'results.jsonl'), 'utf8').trim().split('\n')) {
		const m = JSON.parse(line);
		const key = String(m.file || m.level).replace(/\.eelvl$/i, '');
		meas5.set(key, !!m.routed); meas5.set(m.level, !!m.routed);
	}
} catch (e) { /* none */ }
for (const s of structs) s.meas5 = meas5.has(s.name) ? meas5.get(s.name) : null;
const unrouted = structs.filter((s) => !s.routed || s.meas5 === false).sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------- src/landmarks.js on the same routes (the planner's guide)
let cmp = null;
if (argOf('compare', '0') === '1') {
	const LMJ = require('../../../src/landmarks.js');
	cmp = { levels: 0, routes: 0, unsoundLevels: [], unsoundRoutes: 0, lmjTotal: 0, oursTotal: 0 };
	const kr = TS.knownRoutes({ root });
	const seenLevel = new Map();
	for (const e of kr) {
		const rr = routes.find((x) => !x.stale && x.route === path.relative(root, e.route) && x.name === e.name) || routes.find((x) => !x.stale && x.name === e.name && x.jobId === e.jobId);
		if (!rr) continue;
		const key = e.jobId ? 'job:' + e.jobId : e.name;
		let lmj = seenLevel.get(key);
		if (!lmj) {
			let tr = null;
			try { tr = TS.loadTruth(e); } catch (x) { tr = null; }
			if (!tr) continue;
			try { lmj = LMJ.landmarksOf(tr.L, { maxMs: 30000 }).landmarks.map((l) => l.f); } catch (x) { lmj = []; }
			seenLevel.set(key, lmj); cmp.levels++; cmp.lmjTotal += lmj.length;
			const orc = rr.orc || orcOf.get(e.name); cmp.oursTotal += orc ? (orc.landmarks || []).length : 0;
		}
		cmp.routes++;
		// (landmarks.js names teams 'team=v', keys 'keyN', coins 'coins>=T': the same names as ours)
		const miss = lmj.filter((f) => rr.firstTick[f] === undefined);
		if (miss.length) { cmp.unsoundRoutes++; if (!cmp.unsoundLevels.some((u) => u.name === e.name)) cmp.unsoundLevels.push({ name: e.name, missing: miss.slice(0, 12), n: miss.length }); }
	}
}

// ---------------------------------------------------------------- write
const summary = {
	built: new Date().toISOString(), root,
	levels: { n: L.levels, err: L.err, relaxUnreach: L.relaxUnreach, trophyFreeNoLandmark: L.trophyFree, withLandmarks: L.withLm, deathSeeded: L.deathSeeded, partial: L.partial, tightTrophyUnreach: L.tightUnreach, tightLandmarksDiffer: L.tightDiff, unrouted: L.unrouted, chainHist: hist(L.chain), landmarkMedian: med(L.lm), landmarkMax: Math.max(0, ...L.lm), landmarkHist: hist(L.lm.map((v) => (v > 20 ? '21+' : v))), roundsMedian: med(L.rounds) },
	routes: { n: S.routes, stale: S.stale, levels: S.levelsRouted.size, looseMissRoutes: S.looseMiss, looseViolRoutes: S.looseViol, looseMissLevels: [...S.looseMissLevels], tightMissRoutes: S.tightMiss, tightViolRoutes: S.tightViol, tightMissLevels: [...S.tightMissLevels], withLandmarks: S.withLm, landmarks: S.lmTotal, landmarksUsedByADoorPass: S.lmUsed, doorFactsAchieved: S.achievedDoor, doorFactsUsed: S.usedDoor, usedNotLandmark: S.usedNotLm, toggleBackRoutes: S.toggleBackRoutes, teamChangesOver1: S.teamMulti, revisitMedian: med(S.revisit), revisitMax: Math.max(0, ...S.revisit), blockReentriesMedian: med(S.reentries), blockReentriesMax: Math.max(0, ...S.reentries) },
	landmarksJs: cmp,
	meas5: { known: meas5.size ? structs.filter((x) => x.meas5 !== null).length : 0, unrouted: structs.filter((x) => x.meas5 === false).length, unroutedWithLandmarks: structs.filter((x) => x.meas5 === false && x.landmarks.length).length, unroutedNoLandmark: structs.filter((x) => x.meas5 === false && !x.landmarks.length).length, routedWithLandmarks: structs.filter((x) => x.meas5 === true && x.landmarks.length).length },
	hardestUnrouted: unrouted.slice(0, 30).map((s) => ({ name: s.name, set: s.set, meas5: s.meas5, score: s.score, trophyRound: s.trophyRound, chain: s.chain.length, landmarks: s.landmarks.length, kinds: s.kinds, conflicts: s.conflicts.length, coins: s.coins, tightUnreach: !!(s.tight && s.tight.trophyRound < 0) })),
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'oracle.json'), JSON.stringify({ version: 1, rules: 'tools/n4u/order/lib.js header: loose = the delete relaxation over steer.js analyze\'s walk, killers passable, portals pass-through + exits, deaths re-seed at the spawns; tight = killers deadly unless protected, 8-way', summary, levels, routes }));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(outDir, 'unrouted.json'), JSON.stringify(unrouted, null, 1));
fs.writeFileSync(path.join(outDir, 'structures.json'), JSON.stringify(structs, null, 1));
console.log(JSON.stringify(summary, null, 1).slice(0, 6000));
