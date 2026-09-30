'use strict';
// N4U STUDY 3, PHYSICS LANDMARKS: the walk relaxation's landmarks are sound but weak where the walk goes where the
// physics cannot (Forgotten Veil, Octorage, Cold World: the trophy walkable at round 0). Here a door fact f is a PHYSICS
// LANDMARK when, with f forbidden, the walk fixpoint's achievable facts F' (an over-approximation of what any real route
// can achieve without f) leave a level copy whose RCH3 reach field (src/reach.js, physics mode: its -1 is a proof) cuts
// the start off from every trophy. The copy: a pol-1 door whose fact is not in F' is a wall (it never opens without f);
// every other door / gate keeps its block (RCH3 relaxes a door block: passable AND a floor). Walk-mode fields (effects,
// world gravity) prove nothing: skipped.
//   physLandmarks(L, o) -> {mode, baseCut, cands, landmarks [f], ms, builds, partial}
// usage (rows + validation against the oracle's routes):
//   node tools/n4u/order/phys.js --oracle=<oracle.json> --out=<rows.jsonl> [--shard=i/n] [--maxms=20000]
const fs = require('fs');
const path = require('path');
const E = require('../../../src/eesim.js');
const ST = require('../../../src/steer.js');
const RF = require('../../../src/reach.js');
const O = require('./lib.js');

const achievedIn = (facts, f) => {
	if (f === 'team=0') return true;
	const m = /^(b?coins)>=(-?\d+)$/.exec(f);
	if (m && +m[2] <= 0) return true;
	return facts.has(f);
};

function physLandmarks(L, o = {}) {
	const t0 = Date.now();
	const A = ST.analyze(L, {});
	const N = A.N;
	const sim = new E.EESim(L); sim.reset();
	const doorAt = [];
	for (let i = 0; i < N; i++) if (A.cls[i] === 3 && A.gatePol[i] === 1) { const f = O.doorFact(A, i); if (f) doorAt.push([i, f]); }
	const copyWith = (facts) => {
		const fg = Int32Array.from(L.fg);
		for (const [i, f] of doorAt) if (!achievedIn(facts, f)) fg[i] = 9;
		return Object.assign({}, L, { fg });
	};
	let builds = 0;
	const cut = (facts) => {
		builds++;
		const f = RF.reachField(copyWith(facts), {});
		if (f.mode === 'walk') return { walk: true, cut: false };
		return { walk: false, cut: RF.costAt(f, sim) === -1 };
	};
	const full = O.relax(A, L, { full: true });
	const doorFacts = new Set(doorAt.map((x) => x[1]));
	const cands = [...full.facts.keys()].filter((f) => doorFacts.has(f));
	const out = { mode: 'physics', baseCut: false, cands: cands.length, landmarks: [], ms: 0, builds: 0, partial: false };
	const b = cut(full.facts);
	if (b.walk) { out.mode = 'walk'; out.ms = Date.now() - t0; out.builds = builds; return out; }
	if (b.cut) { out.baseCut = true; out.ms = Date.now() - t0; out.builds = builds; return out; }
	for (const f of cands) {
		if (Date.now() - t0 > (o.maxMs || 20000)) { out.partial = true; break; }
		const r = O.relax(A, L, { forbid: new Set([f]), full: true });
		if (r.trophy < 0) { out.landmarks.push({ f, walk: true }); continue; }   // (a walk landmark is a physics one)
		const c = cut(r.facts);
		if (c.cut) out.landmarks.push({ f, walk: false });
	}
	out.ms = Date.now() - t0; out.builds = builds;
	return out;
}

module.exports = { physLandmarks };

if (require.main === module) {
	const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
	const TS = require('../../../src/plan/truthset.js');
	const T = require('../../../src/plan/types.js');
	const root = path.resolve(process.env.EEAT_TRUTH_ROOT || path.join(__dirname, '..', '..', '..'));
	const ORC = JSON.parse(fs.readFileSync(argOf('oracle', path.join(root, 'src/out/n4plan/understand/order/oracle.json')), 'utf8'));
	const [si, sn] = String(argOf('shard', '0/1')).split('/').map(Number);
	const maxMs = +argOf('maxms', 20000);
	const w = fs.createWriteStream(argOf('out', 'phys.jsonl'));
	// the items: every benchmark level + every job level with a route (its own level JSON)
	const items = ORC.levels.map((l) => ({ key: l.name, file: path.join(root, l.file) }));
	const seenJob = new Set();
	for (const e of TS.knownRoutes({ root })) if (e.jobId && !seenJob.has(e.jobId)) { seenJob.add(e.jobId); items.push({ key: 'job:' + e.jobId, entry: e }); }
	const routesOf = new Map();
	for (const r of ORC.routes) if (!r.stale) { const k = r.jobId ? 'job:' + r.jobId : r.name; if (!routesOf.has(k)) routesOf.set(k, []); routesOf.get(k).push(r); }
	items.forEach((it, idx) => {
		if (idx % sn !== si) return;
		let L = null;
		try { L = it.file ? T.loadLevelFile(it.file) : (TS.loadTruth(it.entry) || {}).L; } catch (e) { L = null; }
		if (!L) { w.write(JSON.stringify({ key: it.key, err: 'no level' }) + '\n'); return; }
		let res = null, err = null;
		try { res = physLandmarks(L, { maxMs }); } catch (e) { err = String(e && e.stack || e).slice(0, 300); }
		// the routes' check
		const rs = routesOf.get(it.key) || [];
		const viol = [];
		if (res) for (const r of rs) { const miss = res.landmarks.filter((l) => r.firstTick[l.f] === undefined).map((l) => l.f); if (miss.length) viol.push({ route: r.route, runTicks: r.runTicks, miss }); }
		w.write(JSON.stringify({ key: it.key, res, err, routes: rs.length, viol }) + '\n');
		console.log(`${it.key}: ${res ? `${res.mode}${res.baseCut ? ' BASECUT' : ''} cands ${res.cands} lm ${res.landmarks.length} (phys-only ${res.landmarks.filter((l) => !l.walk).length}) builds ${res.builds} ${res.ms} ms${res.partial ? ' PARTIAL' : ''}` : 'ERR ' + err} routes ${rs.length} viol ${viol.length}`);
	});
	w.end();
}
