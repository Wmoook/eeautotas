'use strict';
// debug: does a failed reach's fail.closest.masks (replayed from the level start) pass the reported closest tile?
//   node tools/cmp/clmask.js <level> <anchors.jsonl> "<label>" --anchor=<id> --rung=2
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const EX = require(path.join(root, 'src/plan/executor.js'));
const BM = require(path.join(root, 'src/plan/bounds.js'));
const PM = require(path.join(root, 'src/plan/prims.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const E = require(path.join(root, 'src/eesim.js'));
const RUNG_MS = [1500, 5000, 15000, 45000];
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const pos = argv.filter((s) => !s.startsWith('--'));
(async () => {
	const [file, afile, label] = pos;
	const L = T.loadLevelFile(file), W = L.width;
	const anchors = fs.readFileSync(afile, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
	const A = anchors.find((a) => String(a.id) === String(opt('anchor', '0')));
	const mstr = A.masks[0];
	let wp;
	if (label === 'trophy') wp = { kind: 'trophy', label: 'trophy' };
	else {
		const M = MD.compileModel(L);
		const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		wp = { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
	}
	const bounds = BM.createBounds(L, {});
	const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
	const ex = await EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
	const r = +opt('rung', 2);
	const res = await ex.reach([mstr], wp, { ms: RUNG_MS[r], level: r, k: 4 });
	await ex.close();
	const cl = res.fail && res.fail.closest;
	const out = { ok: res.ok, why: res.fail && res.fail.why, startTick: mstr.length };
	if (cl) {
		const m = cl.masks instanceof Uint8Array ? cl.masks : T.masksOf(String(cl.masks));
		out.rep = { tile: [cl.tile % W, (cl.tile / W) | 0], dist: cl.dist, px: cl.px, py: cl.py, len: m.length, type: cl.masks instanceof Uint8Array ? 'u8' : typeof cl.masks };
		const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
		let passT = -1;
		for (let t = 0; t < m.length; t++) { E.applyMask(inp, m[t]); sim.tick(inp); if (T.tileOf(sim, W, L.height) === cl.tile && passT < 0) passT = t + 1; }
		const te = T.tileOf(sim, W, L.height);
		out.replay = { endTile: [te % W, (te / W) | 0], px: sim.px, py: sim.py, dead: !!sim.is_dead, passTick: passT };
		out.prefixIsStart = T.strOf(m).startsWith(mstr);
	}
	console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
