'use strict';
// The dataset writer over src/nnguide.js (the features the search uses): samples (feat.f32: NF features + the raw reach
// cost; meta.i32: grid, tx, ty, ttg, kind, group, route, t) and the door states' grids (grids.u8 classes, walks.u16
// door-aware walking distance to the trophy; padded by PAD tiles of class 'out' / FAR), grids.json.
const fs = require('fs');
const path = require('path');
const C = require('../../src/common.js');
const E = C.E;
const RF = require('../../src/reach.js');
const NG = require('../../src/nnguide.js');
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
const PAD = 16, NM = 8;
function writer(dir) {
	const NFW = NG.NF + 1;
	let fch = [], mch = [], cur = null, curM = null, k = 0;
	const CH = 65536;
	const grids = [], gOut = fs.openSync(path.join(dir, 'grids.u8'), 'w'), wOut = fs.openSync(path.join(dir, 'walks.u16'), 'w');
	let gOff = 0;
	const tmp = new Float32Array(NG.NF);
	const self = {
		n: 0, nGrids: 0,
		levelCtx(L, W_, lv) {
			const ctx = NG.levelCtx(L);
			ctx.lv = lv; ctx.gBase = [];
			return ctx;
		},
		flushGrids(ctx) {
			while (ctx.gBase.length < ctx.list.length) {
				const ds = ctx.list[ctx.gBase.length];
				const Wp = ctx.W + 2 * PAD, Hp = ctx.H + 2 * PAD;
				const g = new Uint8Array(Wp * Hp), w = new Uint16Array(Wp * Hp).fill(NG.FAR);
				for (let y = 0; y < ctx.H; y++) for (let x = 0; x < ctx.W; x++) { g[(y + PAD) * Wp + x + PAD] = ds.cls[y * ctx.W + x]; w[(y + PAD) * Wp + x + PAD] = ds.walk[y * ctx.W + x]; }
				fs.writeSync(gOut, g); fs.writeSync(wOut, Buffer.from(w.buffer));
				grids.push({ lv: ctx.lv, off: gOff, W: ctx.W, H: ctx.H, Wp, Hp });
				ctx.gBase.push(grids.length - 1);
				gOff += Wp * Hp;
				self.nGrids++;
			}
		},
		add(ctx, sim, m) {
			if (!cur || k === CH) { cur = new Float32Array(CH * NFW); curM = new Int32Array(CH * NM); fch.push(cur); mch.push(curM); k = 0; }
			const rc = RF.costAt(ctx.field, sim);
			const ds = NG.features(ctx, sim, tmp, rc);
			self.flushGrids(ctx);
			cur.set(tmp, k * NFW); cur[k * NFW + NG.NF] = rc;
			const tx = Math.min(ctx.W - 1, Math.max(0, Math.trunc(sim.px + 8) >> 4)), ty = Math.min(ctx.H - 1, Math.max(0, Math.trunc(sim.py + 8) >> 4));
			curM.set([ctx.gBase[ds.id], tx, ty, m.ttg, m.kind, m.group, m.route, m.t], k * NM);
			k++; self.n++;
		},
		finish(extra) {
			const fo = fs.openSync(path.join(dir, 'feat.f32'), 'w'), mo = fs.openSync(path.join(dir, 'meta.i32'), 'w');
			for (let i = 0; i < fch.length; i++) {
				const n = i === fch.length - 1 ? k : CH;
				fs.writeSync(fo, Buffer.from(fch[i].buffer, 0, n * NFW * 4));
				fs.writeSync(mo, Buffer.from(mch[i].buffer, 0, n * NM * 4));
			}
			fs.closeSync(fo); fs.closeSync(mo); fs.closeSync(gOut); fs.closeSync(wOut);
			fs.writeFileSync(path.join(dir, 'grids.json'), JSON.stringify(Object.assign({ n: self.n, NF: NG.NF, NFW, NM, PAD, P: NG.P, features: NG.FEATURES, classes: NG.CLASSES,
				meta: ['grid', 'tx', 'ty', 'ttg', 'kind', 'group', 'route', 't'], grids }, extra)));
		},
	};
	return self;
}
module.exports = { C, E, RF, NG, OPTIONS, writer, PAD };
