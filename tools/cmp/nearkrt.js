'use strict';
// THE LAST MILE TEST of a NEAR level (C6 lane 3 block 3): the executor (in-process, workers 0) from a compile's OWN ANCHOR
// (its exact engine state: the arrivals' input strings from strategy.js EEAT_ANCHOR_DUMP) to the waypoint the compile failed
// 1-3 tiles short of. Tells a finder / budget wall (found at a higher rung or with the exact end search, EEAT_NEAR=1, from
// the same state) from a false near of the relaxations (none found: then --scan reports where the ball can be in the
// target's window by an exhaustive engine search of the anchor's state, every input mask a tick, the states merged).
//   node tools/cmp/nearkrt.js <level.eelvl> <anchors.jsonl> "<label>" [--anchor=<id>|max] [--arr=0] [--rungs=1,2,3]
//     [--scan=<ticks>] [--scanCap=<states>] [--win=<tiles>]
// Prints one JSON line per call to stderr and a summary JSON line to stdout. Env as the compiler's (EEAT_*).
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
	const [file, afile, label0] = pos;
	if (!file || !afile || !label0) { console.error('usage: node tools/cmp/nearkrt.js <level.eelvl> <anchors.jsonl> "<label>" [--anchor=id|max] [--rungs=1,2,3] [--scan=ticks]'); process.exit(2); }
	const label = String(label0).replace(/ x\d+$/, '');
	const rungs = String(opt('rungs', '1,2,3')).split(',').filter(Boolean).map(Number);
	const L = T.loadLevelFile(file), W = L.width, H = L.height;
	const anchors = fs.readFileSync(afile, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
	const aSel = opt('anchor', 'max');
	const A = aSel === 'max' ? anchors.reduce((m, a) => (!m || a.gain > m.gain || (a.gain === m.gain && a.tick > m.tick) ? a : m), null) : anchors.find((a) => String(a.id) === String(aSel));
	if (!A) { console.log(JSON.stringify({ err: 'no anchor ' + aSel })); process.exit(0); }
	const mstr = A.masks[Math.min(A.masks.length - 1, +opt('arr', 0) | 0)];
	const masks = T.masksOf(mstr);
	const out = { level: path.basename(file), label, anchor: A.id, gain: A.gain, tick: masks.length };
	let wp, inTarget, tiles = null;
	if (label === 'trophy') {
		wp = { kind: 'trophy', label: 'trophy' };
		inTarget = (sim) => !!sim.has_silver_crown;
	} else {
		const M = MD.compileModel(L);
		const X = M.triggers.find((x) => String(x.label).replace(/ x\d+$/, '') === label);
		if (!X) { out.err = 'no trigger ' + label; console.log(JSON.stringify(out)); process.exit(0); }
		tiles = new Set(X.tiles);
		wp = { kind: 'trigger', tiles: X.tiles.slice(), trig: X.id, expect: null, label };
		inTarget = (sim) => tiles.has(T.tileOf(sim, W, H));
		out.tiles = X.tiles.map((t) => [t % W, (t / W) | 0]);
	}
	// (the anchor's end state)
	const sim = new E.EESim(L), inp = new E.EEInput(); sim.reset();
	for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); sim.tick(inp); }
	const tl = T.tileOf(sim, W, H);
	out.at = { tile: [tl % W, (tl / W) | 0], x: +sim.px.toFixed(3), y: +sim.py.toFixed(3), vx: +(sim.speed_x || 0).toFixed(3), vy: +(sim.speed_y || 0).toFixed(3) };
	let closestMasks = null;
	if (+opt('exec', 1)) {
		const bounds = BM.createBounds(L, {});
		const prims = await PM.createPrims(L, { file, bounds, model: null, workers: 0 });
		const ex = await EX.createExecutor(L, { file, prims, bounds, workers: 0, emit: null });
		out.res = [];
		for (const r of rungs) {
			const t0 = Date.now();
			const res = await ex.reach([mstr], wp, { ms: RUNG_MS[Math.max(0, Math.min(3, r))], level: r, k: 4 });
			const cl = res.fail && res.fail.closest;
			const row = { rung: r, ok: res.ok, ms: Date.now() - t0, tool: res.tool, ticks: res.ok ? res.arrivals[0].tick - masks.length : null,
				why: res.fail ? res.fail.why : null, closest: cl && cl.dist >= 0 ? +(+cl.dist).toFixed(1) : null, ctile: cl && cl.tile >= 0 ? [cl.tile % W, (cl.tile / W) | 0] : null };
			out.res.push(row);
			console.error(JSON.stringify(row));
			if (cl && cl.masks) closestMasks = String(cl.masks);
			if (res.ok) break;
		}
		await ex.close();
	}
	// (the scan starts from the last call's CLOSEST state when it has one: the last mile itself; else the anchor's)
	// (the scan's reference tiles: the target's, else (the trophy) the last call's closest tile)
	const lastRow = out.res && out.res.length ? out.res[out.res.length - 1] : null;
	const refTiles = tiles ? [...tiles] : (lastRow && lastRow.ctile ? [lastRow.ctile[1] * W + lastRow.ctile[0]] : null);
	if (closestMasks && refTiles && opt('from', 'closest') === 'closest') {
		const cm = T.masksOf(closestMasks);
		// (the closest masks run past the nearest point: the scan starts at the tick the trajectory is nearest the target)
		const rt = refTiles.map((t) => [t % W, (t / W) | 0]);
		const dd = (t) => Math.min(...rt.map(([x, y]) => Math.hypot(x - (t % W), y - ((t / W) | 0))));
		sim.reset();
		let bestT = 0, bestD = Infinity;
		for (let t = 0; t < cm.length; t++) {
			E.applyMask(inp, cm[t] & 31); sim.tick(inp);
			if (t + 1 >= masks.length) { const d = dd(T.tileOf(sim, W, H)); if (d < bestD) { bestD = d; bestT = t + 1; } }
		}
		const back = Math.max(0, +opt('back', 20) | 0);
		const t0 = Math.max(masks.length, bestT - back);
		sim.reset();
		for (let t = 0; t < t0; t++) { E.applyMask(inp, cm[t] & 31); sim.tick(inp); }
		out.closestNear = { tick: bestT, d: +bestD.toFixed(2), scanFrom: t0 };
		const ct = T.tileOf(sim, W, H);
		out.closestAt = { tick: cm.length, tile: [ct % W, (ct / W) | 0], x: +sim.px.toFixed(3), y: +sim.py.toFixed(3), vx: +(sim.speed_x || 0).toFixed(3), vy: +(sim.speed_y || 0).toFixed(3), ground: !!sim.on_ground };
	}
	// THE SCAN: every input mask (the 8 the compiler plays: none / left / right x jump, + up / down) a tick from the anchor's
	// state, the engine states merged by their exact hash, for --scan ticks or --scanCap states: the target hit (a claim
	// that the leg exists and its tick count) or not (no claim beyond the horizon), and the nearest tile to the target seen
	const scanT = +opt('scan', 0) | 0;
	const scanTiles = tiles || (refTiles ? new Set(refTiles) : null);
	if (scanT > 0 && scanTiles) {
		const cap = +opt('scanCap', 4e5) | 0, exactKey = opt('exactKey', '0') === '1', Q = +opt('q', 4) || 4;
		const MASKS = [0, 1, 2, 3, 4, 5, 8, 16];   // none, jump, left, jump+left, right, jump+right, up, down (eesim applyMask bits)
		const tgt = [...scanTiles].map((t) => [t % W, (t / W) | 0]);
		const dOf = (t) => Math.min(...tgt.map(([x, y]) => Math.hypot(x - (t % W), y - ((t / W) | 0))));
		const seen = new Set();
		let front = [sim.snapshot()];
		let hitT = -1, best = { d: Infinity, tile: -1, t: 0 }, states = 0;
		const s2 = sim, in2 = new E.EEInput();
		for (let t = 1; t <= scanT && front.length && hitT < 0 && states < cap; t++) {
			const next = [];
			for (const st of front) {
				for (const m of MASKS) {
					s2.restore(st); E.applyMask(in2, m); s2.tick(in2);
					// (the merge key: --exactKey=1 the engine's stateHash (sub-pixel states almost never merge: the frontier
					// explodes), else the physics quantised to 1 px / 0.25 px a tick + the gravity: a hit is still a real
					// replayed leg; a miss is no claim)
					const h = exactKey ? s2.stateHash(true) : `${Math.round(s2.px * Q)},${Math.round(s2.py * Q)},${Math.round(s2.speed_x * 8 * Q)},${Math.round(s2.speed_y * 8 * Q)},${s2.gravity_dir.x},${s2.gravity_dir.y},${s2.on_ground ? 1 : 0}`;
					if (seen.has(h)) continue;
					seen.add(h); states++;
					const tt = T.tileOf(s2, W, H);
					if (tiles ? (tiles.has(tt) || tiles.has(T.touchedTile(s2, W, H))) : !!s2.has_silver_crown) { hitT = t; break; }
					const d = dOf(tt);
					if (d < best.d) best = { d, tile: tt, t };
					if (s2.is_dead) continue;
					next.push(s2.snapshot());
				}
				if (hitT >= 0) break;
			}
			front = next;
			if (t === scanT || !front.length) out.scanEnd = { t, front: front.length };
		}
		out.scan = { hit: hitT, states, nearest: { d: +best.d.toFixed(2), tile: best.tile >= 0 ? [best.tile % W, (best.tile / W) | 0] : null, t: best.t }, capped: states >= cap };
	}
	console.log(JSON.stringify(out));
	process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e).slice(0, 400) })); process.exit(0); });
