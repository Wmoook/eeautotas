'use strict';
// tools/cmp/revcheck.js: the planner's open-level heuristic by the reverse walk (model.revDist + hopClosure) against one
// model.bfs per position, on real levels: for every position the planner builds (the relevant triggers' tiles, the
// respawn, the idle tiles, the start) min over the trophy tiles of bfs = min over the hop closure of revDist, and the same
// for the killing tiles (hLb's death shortcut). node tools/cmp/revcheck.js <level.eelvl>... [--max=400]
// One JSON line a level: positions checked, mismatches (0 = exact), ms of both ways.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const M = require(path.join(root, 'src/plan/model.js'));
const max = +((process.argv.find((a) => a.startsWith('--max=')) || '--max=400').split('=')[1]);
let bad = 0;
for (const file of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
	const r = { level: path.basename(file).replace(/\.eelvl$/, ''), pos: 0, mis: 0, misDie: 0 };
	try {
		const L = T.loadLevelFile(file);
		const model = M.compileModel(L, { file });
		const N = model.N, INF = M.INF;
		const open = new Uint8Array(N);
		for (let i = 0; i < N; i++) open[i] = model.A.cls[i] !== 0 ? 1 : 0;
		const tro = model.trophyTiles;
		const die = [];
		if (model.canDie) for (let i = 0; i < N; i++) if (model.dieTile[i]) die.push(i);
		let t0 = Date.now();
		const RT = model.revDist(open, tro), RD = die.length ? model.revDist(open, die) : null;
		r.revMs = Date.now() - t0;
		const poss = [];
		for (const X of model.triggers) if (X.relevant && X.kind !== 'trophy') poss.push(X.tiles);
		if (model.respawn && model.respawn.length) poss.push(model.respawn);
		if (model.idleTiles && model.idleTiles.length) poss.push(model.idleTiles);
		poss.push([model.startTile]);
		// (a spread sample past --max: every k-th)
		const step = Math.max(1, Math.ceil(poss.length / max));
		let fwdMs = 0;
		for (let k = 0; k < poss.length; k += step) {
			const tiles = poss[k];
			t0 = Date.now();
			const d = model.bfs(open, tiles);
			fwdMs += Date.now() - t0;
			let f = INF;
			for (const t of tro) if (d[t] < f) f = d[t];
			const cl = model.hopClosure(open, tiles);
			let g = INF;
			for (const c of cl) if (RT[c] < g) g = RT[c];
			r.pos++;
			if (f !== g) { r.mis++; if (!r.ex) r.ex = { tiles: tiles.slice(0, 3), fwd: f, rev: g }; }
			if (RD) {
				let fd = INF;
				for (const i of die) if (d[i] < fd) fd = d[i];
				let gd = INF;
				for (const c of cl) if (RD[c] < gd) gd = RD[c];
				if (fd !== gd) { r.misDie++; if (!r.exDie) r.exDie = { tiles: tiles.slice(0, 3), fwd: fd, rev: gd }; }
			}
		}
		r.fwdMs = fwdMs;
		r.triggers = model.triggers.length;
		if (r.mis || r.misDie) bad++;
	} catch (e) { r.err = String(e.stack).split('\n').slice(0, 3).join(' | '); bad++; }
	process.stdout.write(JSON.stringify(r) + '\n');
}
process.exitCode = bad ? 1 : 0;
