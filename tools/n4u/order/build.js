'use strict';
// N4U STUDY 3: build the plan oracle's rows. usage (EEAT_TRUTH_ROOT = the main checkout or a copy with src/jobs,
// src/data, src/out/god, src/out/d4/levels):
//   node tools/n4u/order/build.js --out=<dir> [--shard=i/n] [--only=levels|routes] [--limit=N] [--maxms=60000]
// writes <dir>/rows_<i>_<n>.jsonl: {type: 'level', name, set, file, orc} per benchmark level and {type: 'route', name,
// source, jobId, route, levelKey, orc (job levels: its own), rf (routeFacts), check (the route vs the oracle)} per route.
const fs = require('fs');
const path = require('path');
const TS = require('../../../src/plan/truthset.js');
const T = require('../../../src/plan/types.js');
const ST = require('../../../src/steer.js');
const O = require('./lib.js');

const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const outDir = argOf('out', path.join(__dirname, 'out'));
const [si, sn] = String(argOf('shard', '0/1')).split('/').map(Number);
const only = argOf('only', '');
const limit = +argOf('limit', 0) || Infinity;
const maxMs = +argOf('maxms', 60000);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `rows_${si}_${sn}.jsonl`);
const w = fs.createWriteStream(outFile, { flags: 'w' });
const put = (o) => w.write(JSON.stringify(o) + '\n');

/** a route vs a level oracle: every landmark achieved (else the relaxation is UNSOUND there), every order pair kept */
function routeCheck(orc, rf) {
	const miss = [], viol = [];
	for (const l of orc.landmarks || []) if (rf.firstTick[l.f] === undefined) miss.push(l.f);
	for (const [a, b] of orc.order || []) {
		const ta = rf.firstTick[a], tb = rf.firstTick[b];
		if (tb === undefined) continue;
		if (ta === undefined || ta > tb) viol.push([a, b, ta === undefined ? null : ta, tb]);
	}
	const lmTick = (orc.landmarks || []).map((l) => [l.f, rf.firstTick[l.f] === undefined ? null : rf.firstTick[l.f]]).sort((x, y) => (x[1] === null ? 1e9 : x[1]) - (y[1] === null ? 1e9 : y[1]));
	const doorF = new Set(orc.doorFacts || []);
	const achievedDoor = rf.factOrder.filter((f) => doorF.has(f));
	const lmSet = new Set((orc.landmarks || []).map((l) => l.f));
	const usedPos = rf.used.filter((f) => !f.startsWith('!'));
	return {
		landmarks: lmSet.size, missing: miss, violations: viol, routeLandmarkOrder: lmTick.map((x) => x[0]), landmarkTicks: Object.fromEntries(lmTick),
		doorFactsAchieved: achievedDoor.length, doorFactsUsed: usedPos.length, usedNotLandmark: usedPos.filter((f) => !lmSet.has(f)),
		landmarkNotUsed: [...lmSet].filter((f) => !rf.used.includes(f)), achievedNotUsed: achievedDoor.filter((f) => !rf.used.includes(f)).length,
	};
}

let n = 0;
if (only !== 'routes') {
	const lv = TS.levelFiles({});
	for (let i = 0; i < lv.length && n < limit; i++) {
		if (i % sn !== si) continue;
		const e = lv[i], t0 = Date.now();
		let orc = null, err = null;
		try { orc = O.oracleOfLevel(T.loadLevelFile(e.file), { maxMs }); } catch (x) { err = String(x && x.stack || x).slice(0, 400); }
		put({ type: 'level', name: e.name, set: e.set, orc, err, ms: Date.now() - t0 });
		n++;
		console.log(`level ${e.set}/${e.name}: ${orc ? `lm ${orc.landmarks.length} facts ${Object.keys(orc.facts).length} trophyRound ${orc.trophyRound} chain ${orc.chain.length}` : 'ERR ' + err} ${Date.now() - t0} ms`);
	}
}
if (only !== 'levels') {
	const kr = TS.knownRoutes({});
	const orcMemo = new Map();
	for (let i = 0; i < kr.length && n < limit * 2; i++) {
		if (i % sn !== si) continue;
		const e = kr[i], t0 = Date.now();
		let tr = null, err = null;
		try { tr = TS.loadTruth(e); } catch (x) { err = String(x && x.stack || x).slice(0, 400); }
		if (!tr) { put({ type: 'route', name: e.name, source: e.source, jobId: e.jobId, route: path.relative(process.env.EEAT_TRUTH_ROOT || '.', e.route), stale: true, err }); console.log(`route ${e.name}: stale`); continue; }
		const levelKey = e.jobId ? `job:${e.jobId}` : e.name;
		let orc = orcMemo.get(levelKey);
		if (!orc) { try { orc = O.oracleOfLevel(tr.L, { maxMs }); } catch (x) { orc = null; err = String(x && x.stack || x).slice(0, 400); } orcMemo.set(levelKey, orc); }
		let rf = null, chk = null;
		try {
			const A = ST.analyze(tr.L, {});
			rf = O.routeFacts(tr.L, tr.masks, { A, complete: tr.complete });
			if (orc) chk = routeCheck(orc, rf);
		} catch (x) { err = String(x && x.stack || x).slice(0, 400); }
		const rfOut = rf ? Object.assign({}, rf, { passes: rf.passes.slice(0, 300), factOrder: rf.factOrder.slice(0, 400) }) : null;
		put({ type: 'route', name: e.name, source: e.source, jobId: e.jobId, route: path.relative(process.env.EEAT_TRUTH_ROOT || '.', e.route), levelKey, runTicks: tr.runTicks, complete: tr.complete, deaths: tr.deaths, orc: e.jobId ? orc : undefined, rf: rfOut, check: chk, err, ms: Date.now() - t0 });
		n++;
		console.log(`route ${e.source} ${e.name}: run ${tr.runTicks} lm ${orc ? orc.landmarks.length : '?'} miss ${chk ? chk.missing.length : '?'} viol ${chk ? chk.violations.length : '?'} ${Date.now() - t0} ms`);
	}
}
w.end();
