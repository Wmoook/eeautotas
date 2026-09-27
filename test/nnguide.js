'use strict';
// test/nnguide.js - the learned progress measure's features and inference (src/nnguide.js) and goexplore --guide:
//   features  a hand-made room split by a red key door: the door state (shut, then open with the red key), cached by its
//             hash; the door-aware walking distance to the trophy (none behind the shut door, the 8-way BFS distance
//             when open); the patch (the ball's tile at the centre, 'out' beyond the level, the walk relative to the
//             ball's tile); the territory and the share of doors shut
//   infer     a random CNN (JSON weights, as train.py writes them) through NG.predict against a plain reference
//             forward pass (the embedding, each convolution and the dense layers written out, nothing folded or
//             cached): the same outputs to float precision, also from the cache; a random structured model (train5.py)
//             through NG.cost against its formula
//   search    goexplore --guide with that model: a route replayed in the engine, the same route twice (deterministic);
//             goexplore --oracle / --track with that route: a route, the furthest tick of it reached; --oracleMode=room, line
// usage: node test/nnguide.js   (no GPU, a few seconds; exit code 1 if a check fails)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const NG = require('../src/nnguide.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const levelOfCells = (W, H, cells) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells }))));

// a 24 x 10 room: walls around, a floor, the spawn on the left, a red key door column at x = 12, the trophy at x = 20
const W = 24, H = 10;
const cells = [];
for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
for (let y = 1; y < H - 1; y++) cells.push([12, y, 23]);
cells.push([3, H - 2, 255], [20, H - 2, 121], [6, H - 2, 6]);
const L = levelOfCells(W, H, cells);

section('features');
{
	const ctx = NG.levelCtx(L);
	const sim = new E.EESim(L);
	sim.reset();
	const f = new Float32Array(NG.NF);
	const fi = (n) => f[NG.FEATURES.indexOf(n)];
	const ds = NG.features(ctx, sim, f);
	const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
	check('the red key door shut: no door-aware walk to the trophy from the start', fi('dw_none') === 1 && ds.walk[ty * W + tx] === NG.FAR, `tile (${tx}, ${ty})`);
	check('the door column in the class grid: door_shut', ds.cls[4 * W + 12] === NG.CLASSES.indexOf('door_shut'));
	check('the same door state again: the cached one', NG.doorState(ctx, sim) === ds && ctx.list.length === 1);
	check('all doors shut; the territory: the left part only', fi('shut') === 1 && fi('terr') > 0.3 && fi('terr') < 0.7, `terr ${fi('terr').toFixed(3)}`);
	sim._keysMask |= 1;   // (the red key)
	const ds2 = NG.features(ctx, sim, f);
	// the 8-way distance from the start tile to the trophy tile (no walls in between once the door is open)
	const cheb = Math.max(Math.abs(20 - tx), Math.abs(H - 2 - ty));
	check('the red key: another door state, the door open, the walk = the 8-way distance', ds2 !== ds && ctx.list.length === 2 && ds2.cls[4 * W + 12] === NG.CLASSES.indexOf('door_open') &&
		ds2.walk[ty * W + tx] === cheb && Math.abs(fi('dw_log') - Math.log1p(cheb)) < 1e-6, `${ds2.walk[ty * W + tx]} vs ${cheb}`);
	check('no doors shut; the territory: all of it', fi('shut') === 0 && Math.abs(fi('terr') - 1) < 1e-6);
	const small = NG.levelCtx(L, ctx.field, 1);
	const a1 = NG.doorState(small, sim);
	sim._keysMask &= ~1;
	const a2 = NG.doorState(small, sim);
	check('a search\'s cache (maxStates 1): a new door state starts it over', small.list.length === 1 && small.list[0] === a2 && a1 !== a2 && a2.walk[ty * W + tx] === NG.FAR);
	sim._keysMask |= 1;
	const cls = new Uint8Array(NG.P * NG.P), rel = new Float32Array(NG.P * NG.P);
	NG.patch(ctx, ds2, tx, ty, cls, rel);
	const at = (dx, dy) => (NG.HALF + dy) * NG.P + NG.HALF + dx;
	check('the patch: the ball\'s tile at the centre, the walk relative to it, "out" beyond the level',
		cls[at(0, 0)] === ds2.cls[ty * W + tx] && rel[at(0, 0)] === 0 && Math.abs(rel[at(1, 0)] + 1 / 8) < 1e-6 && cls[at(-tx - 1, 0)] === NG.CLASSES.indexOf('out') &&
		rel[at(-tx, 0)] === 3, `${cls[at(0, 0)]} ${rel[at(1, 0)]} ${cls[at(-tx - 1, 0)]} ${rel[at(-tx, 0)]}`);
}

section('infer');
// a random model in train.py's format
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 - 0.5; };
const arr = (...dims) => (dims.length === 1 ? Array.from({ length: dims[0] }, () => rnd()) : Array.from({ length: dims[0] }, () => arr(...dims.slice(1))));
const Em = 3, ch = [4, 5, 6], hid = [7, 5];
const side = NG.P >> ch.length;
const dims = [ch[ch.length - 1] * side * side + NG.NF, ...hid, 1];
const model = { classes: NG.CLASSES, features: NG.FEATURES, emb: arr(NG.NCLS, Em), convs: [], fc: [], featMean: arr(NG.NF), featStd: Array(NG.NF).fill(0).map(() => 1 + Math.abs(rnd())),
	zero: [], outMean: 3, outStd: 2, scale: 8 };
{
	let cin = Em + 1;
	for (const c of ch) { model.convs.push({ w: arr(c, cin, 3, 3), b: arr(c) }); cin = c; }
	for (let k = 0; k + 1 < dims.length; k++) model.fc.push({ w: arr(dims[k + 1], dims[k]), b: arr(dims[k + 1]) });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nnguide-'));
const mf = path.join(tmp, 'model.json');
fs.writeFileSync(mf, JSON.stringify(model));
/** the plain forward pass: the embedding as channels, each 3 x 3 stride-2 convolution, the dense layers */
function reference(ctx, sim) {
	const f = new Float32Array(NG.NF);
	const ds = NG.features(ctx, sim, f);
	const tx = Math.min(W - 1, Math.max(0, Math.trunc(sim.px + 8) >> 4)), ty = Math.min(H - 1, Math.max(0, Math.trunc(sim.py + 8) >> 4));
	const cls = new Uint8Array(NG.P * NG.P), rel = new Float32Array(NG.P * NG.P);
	NG.patch(ctx, ds, tx, ty, cls, rel);
	let s = NG.P;
	let x = [];
	for (let e = 0; e < Em; e++) x.push(Array.from({ length: s * s }, (_, o) => model.emb[cls[o]][e]));
	x.push(Array.from(rel));
	for (const c of model.convs) {
		const so = s / 2, y = [];
		for (let o = 0; o < c.w.length; o++) {
			const m = new Array(so * so).fill(0);
			for (let yy = 0; yy < so; yy++) for (let xx = 0; xx < so; xx++) {
				let acc = c.b[o];
				for (let i = 0; i < x.length; i++) for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
					const py = 2 * yy + ky - 1, px = 2 * xx + kx - 1;
					if (py >= 0 && py < s && px >= 0 && px < s) acc += c.w[o][i][ky][kx] * x[i][py * s + px];
				}
				m[yy * so + xx] = Math.max(0, acc);
			}
			y.push(m);
		}
		x = y; s = so;
	}
	let h = [].concat(...x, Array.from(f, (v, i) => (v - model.featMean[i]) / model.featStd[i]));
	model.fc.forEach((l, k) => {
		h = l.w.map((row, o) => { let acc = l.b[o]; for (let i = 0; i < row.length; i++) acc += row[i] * h[i]; return k < model.fc.length - 1 ? Math.max(0, acc) : acc; });
	});
	return h[0] * model.outStd + model.outMean;
}
{
	const m = NG.load(mf);
	const ctx = NG.levelCtx(L), ctx2 = NG.levelCtx(L);
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	let worst = 0, n = 0, cached = 0;
	for (let t = 0; t < 400; t++) {
		E.applyMask(inp, [4, 5, 4, 0, 2, 3][(t / 37 | 0) % 6]);
		sim.tick(inp);
		if (t === 150) sim._keysMask |= 1;
		if (t % 7) continue;
		const a = NG.predict(m, ctx, sim), b = reference(ctx2, sim), a2 = NG.predict(m, ctx, sim);
		worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
		if (a2 === a) cached++;
		n++;
	}
	check('NG.predict = the plain forward pass (float32 vs double)', worst < 1e-4, `${n} states, max relative difference ${worst.toExponential(2)}`);
	check('the same state again (the cached patch code): the same output', cached === n);
	const c = NG.cost(m, ctx, sim);
	check('cost = expm1(predict) / scale (ticks to tiles)', Math.abs(c - Math.expm1(Math.max(0, NG.predict(m, ctx, sim))) / 8) < 1e-9);
	// the structured model (train5.py): softplus(a) x reach + softplus(b) x door-aware walk + softplus(g) x 100, (a, b, g)
	// an MLP of the room's features
	const roomf = ['walk_mode', 'dw_none', 'keys', 'switches', 'terr', 'shut', 'size'];
	const room = { kind: 'room', features: NG.FEATURES, roomf, rmean: arr(roomf.length), rstd: roomf.map(() => 1 + Math.abs(rnd())),
		layers: [[arr(6, roomf.length), arr(6)], [arr(4, 6), arr(4)], [arr(3, 4), arr(3)]], scale: 9 };
	fs.writeFileSync(path.join(tmp, 'room.json'), JSON.stringify(room));
	const rm = NG.load(path.join(tmp, 'room.json'));
	const f = new Float32Array(NG.NF);
	let rworst = 0, rn = 0;
	const sim2 = new E.EESim(L);
	sim2.reset();
	for (let t = 0; t < 300; t++) {
		E.applyMask(inp, [4, 5, 0, 1][(t / 29 | 0) % 4]);
		sim2.tick(inp);
		if (t === 100) sim2._keysMask |= 1;
		if (t % 11) continue;
		const got = NG.cost(rm, ctx, sim2);
		NG.features(ctx, sim2, f);
		let h = roomf.map((n, i) => (f[NG.FEATURES.indexOf(n)] - room.rmean[i]) / room.rstd[i]);
		room.layers.forEach(([w, b], k) => { h = w.map((row, o) => { let acc = b[o]; for (let i = 0; i < row.length; i++) acc += row[i] * h[i]; return k < room.layers.length - 1 ? Math.max(0, acc) : acc; }); });
		const sp = (x) => Math.log(1 + Math.exp(x));
		const rc = require('../src/reach.js').costAt(ctx.field, sim2);
		const dw = f[NG.FEATURES.indexOf('dw_none')] > 0 ? 0 : Math.expm1(f[NG.FEATURES.indexOf('dw_log')]);
		const want = sp(h[0]) * (rc >= 0 ? rc : 0) + sp(h[1]) * dw + sp(h[2]) * 100;
		rworst = Math.max(rworst, Math.abs(got - want) / Math.max(1, want));
		rn++;
	}
	check('the structured model: NG.cost = its formula (the reach cost, the door-aware walk, the room MLP)', rworst < 1e-5, `${rn} states, max relative difference ${rworst.toExponential(2)}`);
	let bad = null;
	try { NG.load(path.join(tmp, 'bad.json')); } catch (e) { bad = e; }
	const other = Object.assign({}, model, { features: NG.FEATURES.slice(1) });
	fs.writeFileSync(path.join(tmp, 'other.json'), JSON.stringify(other));
	let refused = null;
	try { NG.load(path.join(tmp, 'other.json')); } catch (e) { refused = e.message; }
	check('a model trained on other features is refused', bad && /other features/.test(refused || ''), refused);
}

section('search');
{
	const lf = path.join(tmp, 'level.eelvl');
	fs.writeFileSync(lf, ED.eelvlOf({ name: 't', width: W, height: H, cells }));
	const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--maxTicks=400000', '--seconds=60', '--first=1', `--guide=${mf}`], { encoding: 'utf8' });
	const res = (out) => out.split('\n').filter((s) => s.startsWith('{')).map((s) => JSON.parse(s)).find((e) => e.ev === 'result');
	const r1 = res(run()), r2 = res(run());
	const ev = r1 ? C.evaluate(L, Uint8Array.from(r1.inputs, (ch) => ch.charCodeAt(0) - 48)) : null;
	check('goexplore --guide: a route (through the key door), replayed in the engine', !!(r1 && ev && ev.ms.length === r1.ticks), r1 ? `${r1.ticks} ticks after ${r1.simTicks} simulated` : 'none');
	check('the same route again (deterministic)', !!(r1 && r2 && r1.inputs === r2.inputs && r1.simTicks === r2.simTicks));
	// --oracle (the headroom test): head A ordered by that route's ticks to go; --track reports how far along it a cell got
	if (r1) {
		const rf = path.join(tmp, 'route.eetas');
		C.writeEetas(rf, Uint8Array.from(r1.inputs, (ch) => ch.charCodeAt(0) - 48));
		const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--maxTicks=400000', '--seconds=60', '--first=1', `--oracle=${rf}`, `--track=${rf}`], { encoding: 'utf8' });
		const evs = out.split('\n').filter((s) => s.startsWith('{')).map((s) => JSON.parse(s));
		const r3 = evs.find((e) => e.ev === 'result'), done = evs.find((e) => e.ev === 'done');
		const ev3 = r3 ? C.evaluate(L, Uint8Array.from(r3.inputs, (ch) => ch.charCodeAt(0) - 48)) : null;
		const w = done && done.workers[0] || {};
		check('goexplore --oracle=<that route>: a route, replayed in the engine', !!(r3 && ev3 && ev3.ms.length === r3.ticks), r3 ? `${r3.ticks} ticks after ${r3.simTicks} simulated` : 'none');
		check('--track: the furthest tick of the route reached is reported', w.trackMax > 0 && w.trackMax <= r1.ticks, `${w.trackMax} of ${r1.ticks}`);
		const out2 = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--maxTicks=400000', '--seconds=60', '--first=1', '--cells=coarse', `--oracle=${rf}`, '--oracleMode=room'], { encoding: 'utf8' });
		const r4 = out2.split('\n').filter((s) => s.startsWith('{')).map((s) => JSON.parse(s)).find((e) => e.ev === 'result');
		check('--oracleMode=room (coarse cells: the key opens a room): a route', !!r4, r4 ? `${r4.ticks} ticks after ${r4.simTicks} simulated` : 'none');
		const out3 = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'goexplore.js'), lf, '--maxTicks=400000', '--seconds=60', '--first=1', `--oracle=${rf}`, '--oracleMode=line'], { encoding: 'utf8' });
		const r5 = out3.split('\n').filter((s) => s.startsWith('{')).map((s) => JSON.parse(s)).find((e) => e.ev === 'result');
		check('--oracleMode=line (the route as a guide line): a route', !!r5, r5 ? `${r5.ticks} ticks after ${r5.simTicks} simulated` : 'none');
	}
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
