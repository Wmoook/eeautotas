'use strict';
// TRICK MINING 1 (n5-tricks): HOW THE KNOWN ROUTES PASS FIELDS, and what the entry's sub-pixel offset and speed are worth.
//
// Every route of the truth set (src/plan/truthset.js) is replayed; a FIELD PASSAGE is a maximal run of ticks whose
// current tile (the centre cell at the tick's start, the engine's `current_tile`) has one field class (fields.js
// classOfId: the 4 arrows, dots, climbables, the 4 liquids, the 4 boosts). Per passage [a, b] (1-based ticks: tick a is
// the first whose current tile is in the field, b the last):
//   entry = the state after tick a - 1 (its centre is in the field: tick a acts on it), exit tile = the centre tile after
//   tick b (tick b + 1's start cell) and its FACE (the side the centre left by: dx / dy against the last in-field tile);
//   n = b - a + 1 ticks in the field; the route's inputs there (changes, the keys used);
//   THE FACE BOUND lbFace: the fewest ticks ANY input word needs from the entry to move the centre across the exit face
//   along the face axis (fields.js minTAxis, THEOREM F3, on the field's schedule from the entry's own gravity queue):
//   n - lbFace is the in-field slack of the route;
//   THE SUB-PIXEL MARGIN dFwd: along the face axis, with the route's own in-field inputs on that axis and the ENGINE's
//   per-tick contexts of the passage (the real schedule), the least forward shift of the entry position (px, bisection
//   to 1/1024) that crosses the face one tick sooner (the axis recurrence; Infinity above 16 px); dBack the least
//   backward shift that costs a tick: how close to a tick boundary the route arrived;
//   THE SETUP FAMILY (the engine, exact): from the route's state at tick s (s = a - 1 - K .. a - 1), every mask m of the
//   18 (9 directions x the jump bit) held from s until the centre is in the passage's field class (at most a - 1 + 8),
//   then the route's own in-field and later inputs from that entry on, until the centre reaches the exit face's tile
//   line (the exit tile's column / row, the cross coordinate within 1 tile): its tick vs the route's b. gain = b - that
//   tick; the best variant's entry tick / offset / speed against the route's. This separates a gain from ARRIVING
//   EARLIER from one of arriving BETTER (a later entry that exits sooner: the sub-pixel / speed setup).
// Output: one JSON line per passage (--out dir, shards). --agg=<dir> prints the tables. General: no level code.
// Usage: EEAT_TRUTH_ROOT=<truth> node tools/tricks/fieldmine.js --shard=i/n --out=<dir> [--K=12] [--maxn=400]
//        node tools/tricks/fieldmine.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const F = require('../../src/math/fields.js');
const KN = require('../../src/plan/kin.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const DIR9 = [0, 2, 4, 8, 16, 10, 12, 18, 20];
const MASKS18 = [...DIR9, ...DIR9.map((m) => m | 1)];

function fieldClass(id) {
	const c = F.classOfId(id);
	return (c === 'air' || c === 'other') ? null : c;
}
const cellOf = (p) => Math.trunc(p + 8) >> 4;

/** the per-axis input index of a mask: x (0 none, 1 L, 2 R), y (0, 1 U, 2 D); both keys = the engine's h = R - L */
function axisInput(m, axis) {
	if (axis === 'x') { const h = ((m & 4) ? 1 : 0) - ((m & 2) ? 1 : 0); return h < 0 ? 1 : (h > 0 ? 2 : 0); }
	const v = ((m & 16) ? 1 : 0) - ((m & 8) ? 1 : 0); return v < 0 ? 1 : (v > 0 ? 2 : 0);
}

function minePassages(L, masks, o) {
	const n = masks.length, W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const snaps = new Array(n + 1);
	const px = new Float64Array(n + 1), py = new Float64Array(n + 1), vx = new Float64Array(n + 1), vy = new Float64Array(n + 1);
	const cur = new Int32Array(n + 1), dead = new Uint8Array(n + 1), del = new Int32Array(n + 1);
	const ctxs = new Array(n + 1);
	const ctxCache = new Map();
	snaps[0] = sim.snapshot(); px[0] = sim.px; py[0] = sim.py; vx[0] = sim.speed_x; vy[0] = sim.speed_y; cur[0] = sim.current_tile;
	for (let t = 0; t < n; t++) {
		const q0 = sim._q0, q1 = sim._q1;
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		snaps[t + 1] = sim.snapshot();
		px[t + 1] = sim.px; py[t + 1] = sim.py; vx[t + 1] = sim.speed_x; vy[t + 1] = sim.speed_y;
		cur[t + 1] = sim.current_tile; dead[t + 1] = sim.is_dead ? 1 : 0;
		const c = sim.current_tile, d = KN.isImmediate(c) ? q1 : q0;
		del[t + 1] = d;
		const key = `${c},${d},${sim.flip_gravity},${sim.speed_boost},${sim.is_zombie ? 1 : 0},${sim.low_gravity ? 1 : 0},${sim.jump_boost},${sim._slippery},${sim.world_gravity_multiplier}`;
		let cx = ctxCache.get(key);
		if (!cx) {
			cx = F.fieldCtx({ cur: c, del: d, flip: sim.flip_gravity, sb: sim.speed_boost, zombie: sim.is_zombie, lowGravity: sim.low_gravity,
				worldGravity: sim.world_gravity_multiplier, jb: sim.jump_boost, slip: sim._slippery });
			ctxCache.set(key, cx);
		}
		ctxs[t + 1] = cx;
	}
	// the passages
	const out = [];
	let t = 1;
	while (t <= n) {
		const fc = fieldClass(cur[t]);
		if (!fc || dead[t]) { t++; continue; }
		let b = t;
		while (b + 1 <= n && fieldClass(cur[b + 1]) === fc && !dead[b + 1]) b++;
		const a = t;
		t = b + 1;
		if (b >= n) continue;                       // the route ends inside
		if (dead[b + 1]) continue;
		const nIn = b - a + 1;
		if (nIn > (o.maxn || 400)) continue;
		// the tiles
		const eX = cellOf(px[b]), eY = cellOf(py[b]);          // the exit tile (tick b + 1's start cell, before a half-block shift)
		const lX = cellOf(px[b - 1]), lY = cellOf(py[b - 1]);  // the last in-field start cell
		const dxF = Math.sign(eX - lX), dyF = Math.sign(eY - lY);
		if (dxF === 0 && dyF === 0) continue;                  // (a teleport or a half-block shift: not a face exit)
		const axis = dxF !== 0 ? 'x' : 'y', sgn = axis === 'x' ? dxF : dyF;
		const P = axis === 'x' ? px : py, V = axis === 'x' ? vx : vy;
		// the face: the centre crosses 16 * line (sgn > 0: p + 8 >= 16 * eLine; sgn < 0: p + 8 < 16 * (eLine + 1))
		const eLine = axis === 'x' ? eX : eY;
		const faceP = sgn > 0 ? 16 * eLine - 8 : 16 * (eLine + 1) - 8 - 1e-9;
		const crossed = (p) => (sgn > 0 ? p >= faceP : p <= faceP);
		// inputs in the field
		let changes = 0;
		const keys = new Set();
		for (let k = a - 1; k <= b - 1; k++) { if (k > a - 1 && masks[k] !== masks[k - 1]) changes++; keys.add(masks[k]); }
		// the face bound on the field's schedule from the entry's queue (the field's own tiles all the way: F3)
		sim.restore(snaps[a - 1]);
		const S = F.schedule({ cur: cur[a], q0: sim._q0, q1: sim._q1, flip: sim.flip_gravity, sb: sim.speed_boost, zombie: sim.is_zombie,
			lowGravity: sim.low_gravity, worldGravity: sim.world_gravity_multiplier, jb: sim.jump_boost, slip: 0 }, nIn + 64);
		const As = axis === 'x' ? S.x : S.y;
		const lbFace = F.minTAxis(P[a - 1], V[a - 1], sgn > 0 ? faceP : faceP, As, nIn + 60);
		// the sub-pixel margin: the axis recurrence on the ENGINE's contexts with the route's inputs on that axis
		const engA = [null];
		for (let k = a; k <= b + 40 && k <= n; k++) engA.push(axis === 'x' ? ctxs[k].x : ctxs[k].y);
		const ins = [];
		for (let k = a - 1; k <= b + 39 && k < n; k++) ins.push(axisInput(masks[k], axis));
		const exitTickModel = (d) => {
			let p = P[a - 1] + d, v = V[a - 1];
			for (let j = 1; j < engA.length; j++) {
				const A = engA[j], i = ins[j - 1] || 0;
				v = F.vStep(v, i, A); p = F.pStep(p, v, i, A);
				if (crossed(p)) return j;
			}
			return Infinity;
		};
		const base = exitTickModel(0);
		const modelOK = base === nIn;
		let dFwd = Infinity, dBack = Infinity;
		if (modelOK) {
			// forward (toward the face): the least shift that crosses a tick sooner
			const dir = sgn;
			if (exitTickModel(dir * 16) < base) {
				let lo = 0, hi = 16;
				for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (exitTickModel(dir * mid) < base) hi = mid; else lo = mid; }
				dFwd = hi;
			}
			if (exitTickModel(-dir * 16) > base) {
				let lo = 0, hi = 16;
				for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (exitTickModel(-dir * mid) > base) hi = mid; else lo = mid; }
				dBack = hi;
			}
		}
		// the setup family (the engine): one held mask from tick s until the centre enters the passage's field (a tile of its
		// class, the tick starting at or next to one of the passage's own cells), then the route's own inputs re-timed to that
		// entry; the goal (only after the entry): the centre on the exit face's tile line (the exit tile's column / row, the
		// cross coordinate within 1 tile); gain2 = the route's tile D ticks after the exit reached sooner (the downstream check)
		const K = o.K || 12, D = o.D || 10;
		const cells = new Set();
		for (let k = a - 1; k <= b - 1; k++) {
			const cx = cellOf(px[k]), cy = cellOf(py[k]);
			for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add((cy + dy) * W + cx + dx);
		}
		const goalHit = (s2) => {
			const cX = cellOf(s2.px), cY = cellOf(s2.py);
			return axis === 'x' ? (cX === eX && Math.abs(cY - eY) <= 1) : (cY === eY && Math.abs(cX - eX) <= 1);
		};
		const bD = Math.min(n, b + D);
		const dX = cellOf(px[bD]), dY = cellOf(py[bD]);
		let routeG2 = -1;
		for (let k = b; k <= bD; k++) if (cellOf(px[k]) === dX && cellOf(py[k]) === dY) { routeG2 = k; break; }
		let best = { gain: 0, s: -1, m: -1, entry: a, exitT: b, gain2: null };
		let tried = 0;
		const horizon = Math.max(b + 1 + 16, routeG2 > 0 ? routeG2 + 16 : 0);
		for (let s = Math.max(0, a - 1 - K); s <= a - 1; s++) {
			for (const m of MASKS18) {
				if (m === masks[s]) continue;
				sim.restore(snaps[s]);
				let tick = s, entered = -1, hit = -1, hit2 = -1, dead = false;
				while (tick < Math.min(n, a - 1 + 8)) {
					const pcx = cellOf(sim.px), pcy = cellOf(sim.py);
					E.applyMask(inp, m); sim.tick(inp); tick++; tried++;
					if (sim.is_dead) { dead = true; break; }
					if (fieldClass(sim.current_tile) === fc && cells.has(pcy * W + pcx)) { entered = tick; break; }
				}
				if (dead || entered < 0) continue;
				const off = a - entered;                             // the route's mask index for this variant's tick k + 1: k + off
				while (tick < horizon) {
					const ri = tick + off;
					const mm = ri < n ? masks[ri] : masks[n - 1];
					E.applyMask(inp, mm & 31); sim.tick(inp); tick++; tried++;
					if (sim.is_dead) break;
					if (hit < 0 && goalHit(sim)) hit = tick;
					if (routeG2 > 0 && hit2 < 0 && cellOf(sim.px) === dX && cellOf(sim.py) === dY) hit2 = tick;
					if (hit > 0 && (routeG2 < 0 || hit2 > 0)) break;
				}
				if (hit > 0 && b - hit > best.gain) {
					best = { gain: b - hit, s, m, entry: entered, exitT: hit, gain2: (routeG2 > 0 && hit2 > 0) ? routeG2 - hit2 : null };
					sim.restore(snaps[s]);
					let tt = s;
					while (tt < entered) { E.applyMask(inp, m); sim.tick(inp); tt++; }
					best.entryState = [sim.px, sim.py, sim.speed_x, sim.speed_y];
				}
			}
		}
		const off16 = (p) => { const c = p + 8; return c - 16 * Math.floor(c / 16); };
		// how the centre came in: the entry face (the cell step from the state before), the tile class it came from, grounded
		const ia = Math.max(0, a - 2);
		const inFace = [Math.sign(cellOf(px[a - 1]) - cellOf(px[ia])), Math.sign(cellOf(py[a - 1]) - cellOf(py[ia]))];
		const preFc = fieldClass(cur[a - 1]) || 'air';
		sim.restore(snaps[ia]);
		const preGround = sim.on_ground ? 1 : 0;
		out.push({ fc, a, b, n: nIn, axis, sgn, face: [dxF, dyF], exit: [eX, eY], inFace, preFc, preGround,
			entry: [px[a - 1], py[a - 1], vx[a - 1], vy[a - 1]], entryOff: [off16(px[a - 1]), off16(py[a - 1])],
			exitSt: [px[b], py[b], vx[b], vy[b]], changes, keys: [...keys], lbFace: lbFace === Infinity ? null : lbFace,
			modelOK, dFwd: dFwd === Infinity ? null : dFwd, dBack: dBack === Infinity ? null : dBack,
			gain: best.gain, bestS: best.s >= 0 ? a - 1 - best.s : null, bestM: best.m, bestEntry: best.entry, bestEntryState: best.entryState || null,
			entryShift: best.s >= 0 ? best.entry - a : null, gain2: best.gain2, tried });
	}
	return out;
}

function main() {
	const TS = require('../../src/plan/truthset.js');
	const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
	const OUT = argv.out || 'fieldmine_out';
	fs.mkdirSync(OUT, { recursive: true });
	const routes = TS.knownRoutes();
	const fd = fs.openSync(path.join(OUT, `mine_${SH}.jsonl`), 'w');
	const t0 = Date.now();
	let np = 0;
	for (let r = 0; r < routes.length; r++) {
		if ((r % NSH) !== SH) continue;
		if (argv.only && !routes[r].name.includes(argv.only)) continue;
		let tr;
		try { tr = TS.loadTruth(routes[r]); } catch (e) { continue; }
		if (!tr) continue;
		const ps = minePassages(tr.L, tr.masks, { K: +(argv.K || 12), maxn: +(argv.maxn || 400) });
		for (const p of ps) { p.r = r; p.name = routes[r].name; p.route = path.basename(path.dirname(routes[r].route)); fs.writeSync(fd, JSON.stringify(p) + '\n'); }
		np += ps.length;
		console.log(`${r} ${routes[r].name}: ${ps.length} passages (${Date.now() - t0} ms)`);
	}
	fs.closeSync(fd);
	console.log(`shard ${SH}/${NSH}: ${np} passages, ${Date.now() - t0} ms`);
}

function agg(dir) {
	const rows = [];
	for (const f of fs.readdirSync(dir)) if (/^mine_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
	const by = new Map();
	for (const r of rows) { const k = r.fc; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
	const med = (a) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
	console.log('class     passages   ticks routes lbFace=n slack>0 modelOK dFwd<1 dFwd<4 | gain>0 ticks  earlier(t)  same(t)   later(t) | down>0 downTicks  laterDown(t)');
	const all = { p: 0, t: 0, g: 0, gt: 0, same: 0, sameT: 0, later: 0, laterT: 0, d: 0, dt: 0, ld: 0, ldt: 0 };
	for (const [k, a] of [...by].sort((x, y) => y[1].length - x[1].length)) {
		const ticks = a.reduce((s, r) => s + r.n, 0);
		const routes = new Set(a.map((r) => r.r)).size;
		const tight = a.filter((r) => r.lbFace !== null && r.lbFace === r.n).length;
		const slack = a.filter((r) => r.lbFace !== null && r.lbFace < r.n).length;
		const mok = a.filter((r) => r.modelOK).length;
		const d1 = a.filter((r) => r.dFwd !== null && r.dFwd < 1).length, d4 = a.filter((r) => r.dFwd !== null && r.dFwd < 4).length;
		const g = a.filter((r) => r.gain > 0);
		const gt = g.reduce((s, r) => s + r.gain, 0);
		const part = (f) => { const x = g.filter(f); return [x.length, x.reduce((s, r) => s + r.gain, 0)]; };
		const [ne, te] = part((r) => r.entryShift < 0), [ns, ts] = part((r) => r.entryShift === 0), [nl, tl] = part((r) => r.entryShift > 0);
		const dg = g.filter((r) => r.gain2 !== null && r.gain2 > 0), dgt = dg.reduce((s, r) => s + r.gain2, 0);
		const ldg = dg.filter((r) => r.entryShift >= 0), ldgt = ldg.reduce((s, r) => s + r.gain2, 0);
		console.log(`${k.padEnd(9)} ${String(a.length).padStart(8)} ${String(ticks).padStart(7)} ${String(routes).padStart(6)} ${String(tight).padStart(8)} ${String(slack).padStart(7)} ${String(mok).padStart(7)} ${String(d1).padStart(6)} ${String(d4).padStart(6)} | ${String(g.length).padStart(6)} ${String(gt).padStart(5)} ${`${ne}(${te})`.padStart(11)} ${`${ns}(${ts})`.padStart(8)} ${`${nl}(${tl})`.padStart(10)} | ${String(dg.length).padStart(6)} ${String(dgt).padStart(9)} ${`${ldg.length}(${ldgt})`.padStart(13)}`);
		all.p += a.length; all.t += ticks; all.g += g.length; all.gt += gt; all.same += ns; all.sameT += ts; all.later += nl; all.laterT += tl;
		all.d += dg.length; all.dt += dgt; all.ld += ldg.length; all.ldt += ldgt;
	}
	console.log(`ALL ${all.p} passages, ${all.t} ticks in fields; exit sooner ${all.g} (${all.gt} ticks): same entry tick ${all.same} (${all.sameT}), later entry ${all.later} (${all.laterT}); downstream sooner ${all.d} (${all.dt} ticks), of them with a same/later entry ${all.ld} (${all.ldt})`);
}

if (argv.agg) agg(argv.agg); else main();
