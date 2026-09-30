'use strict';
// THE CORRIDOR LAB's TEST SET (n5 chains lab, approach C): the known-route legs of the compile's stuck waypoints
// (src/out/n4plan/krt_b4.jsonl: the known-route test of block 4), each as {level (relative to the lv230 set), route (a
// copy named after the level, in --routes), label, tiles (the waypoint's tiles; the trophy: the trophy tiles), prevTick
// (the route's previous trigger, the leg's start), hit (the route's first tick in the target), routeLeg, kind}.
// The route of a case is a known route (src/plan/truthset.js) of the same level file (md5) that enters the target at the
// row's hit tick. Level and route files never go into git: --routes is a scratch folder (src/out/...).
//   EEAT_TRUTH_ROOT=<main checkout> node tools/lab/corridor_cases.js --krt=<krt_b4.jsonl> --levels=<lv230 dir>
//     --routes=<out dir for the route copies> --out=<cases.json>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const TS = require(path.join(root, 'src/plan/truthset.js'));
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const E = require(path.join(root, 'src/eesim.js'));
const C = require(path.join(root, 'src/common.js'));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

function main() {
	const rows = fs.readFileSync(argv.krt, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hit > 0);
	const lvDir = argv.levels, rDir = argv.routes;
	fs.mkdirSync(rDir, { recursive: true });
	const known = TS.knownRoutes({});
	const byMd5 = new Map();
	for (const e of known) {
		let m;
		try { m = md5(e.levelFile); } catch (x) { continue; }
		if (!byMd5.has(m)) byMd5.set(m, []);
		byMd5.get(m).push(e);
	}
	const out = [];
	for (const r of rows) {
		const lf = path.join(lvDir, r.rel);
		if (!fs.existsSync(lf)) { console.error('no level', r.rel); continue; }
		const cands = byMd5.get(md5(lf)) || [];
		const L = T.loadLevelFile(lf), W = L.width, H = L.height;
		const label = String(r.label).replace(/ x\d+$/, '');
		let tiles = null, inTarget;
		if (label === 'trophy') {
			tiles = [];
			for (let i = 0; i < W * H; i++) if (L.fg[i] === 121) tiles.push(i);
			inTarget = (sim) => !!sim.has_silver_crown;
		} else {
			const M = MD.compileModel(L);
			const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
			if (!X) { console.error('no trigger', r.rel, label); continue; }
			tiles = X.tiles.slice();
			const ts = new Set(tiles);
			inTarget = (sim) => ts.has(T.tileOf(sim, W, H));
		}
		let got = null;
		for (const e of cands) {
			let tr;
			try { tr = TS.loadTruth(e); } catch (x) { continue; }
			if (!tr) continue;
			// (the route's first tick in the target, on THIS level object: the lv230 file's start mode)
			const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
			let hit = -1;
			for (let t = 0; t < tr.masks.length; t++) { E.applyMask(inp, tr.masks[t] & 31); sim.tick(inp); if (inTarget(sim)) { hit = t + 1; break; } if (sim.has_silver_crown) break; }
			if (hit === r.hit) { got = { e, masks: tr.masks, hit }; break; }
		}
		if (!got) { console.error('no route with hit', r.hit, r.rel, label); continue; }
		const ev = TS.routeEvents(L, got.masks);
		const prevEv = ev.events.filter((e) => e.tick < got.hit && e.feat !== 'deaths' && e.feat !== 'fx').pop();
		const prevTick = prevEv ? prevEv.tick : 0;
		const rname = path.basename(r.rel).replace(/\.eelvl$/i, '') + '.eetas';
		C.writeEetas(path.join(rDir, rname), got.masks);
		out.push({ level: r.rel, route: rname, label, tiles, kind: r.kind, prevTick, prevFeat: prevEv ? prevEv.feat : 'spawn', hit: got.hit, routeLeg: got.hit - prevTick, source: got.e.source });
		console.error(r.kind, r.rel, label, 'leg', got.hit - prevTick);
	}
	fs.writeFileSync(argv.out, JSON.stringify(out, null, 1));
	console.log(`${out.length} cases -> ${argv.out}`);
}
main();
