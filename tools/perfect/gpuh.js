'use strict';
// THE GPU PROVER'S BOUND TABLES (box 8 lane 'gpuproof', 2026-10-01): the admissible h of `eegpu exact` (native/exact.h)
// as tables the GPU reads per tile x the door state that matters, built from the CPU prover's own tiers
// (tools/perfect/wholepar.js makeCtx(L, {kin, rel, gate}), the default of the CPU prover; exact.h xhOf = makeCtx's h
// line for line):
//   'kin'   levelproof.js contextOf: endgame.lowerBound + 1 (the kinematic envelope, walls ignored, portals through its
//           portal field) capped at DEATH_MIN + 1 + hResp where the ball can die, a dead ball's ticks left + hResp + 1
//           (hResp with wholepar.js's death way: the rel field's least respawn value), Infinity where contextOf's RCH3
//           reach field calls a live ball cut off (the field's bytes in the file, beam.h reachFifths on the GPU):
//           endgame.js boundContext exported (its targets, tame tables, 2D prefix sums, portal field, riseTable per jump
//           effect) and lowerBound ported to the GPU (exact.h xkLowerBound, the same double operations);
//   'rel'   bounds.js at(the trophy field, every door open) without its endgame part (wholepar.js's noEndgame): the tile
//           value refined by the ball's offset from its node (iso, axis, plain): the field's float32 tables (f, iso, ax,
//           ay, axp, ayp), vmax / vplain, the mechanism tables; h = at + 1;
//   'gate'  THE ORDER TIER (wholeproof.js createH): the doors as the state holds them (types.js levelNow) until a door-
//           changing trigger / killer tile: one multi-source field per DOOR STATE (bounds.field(gateGoals, Lc, {touch,
//           init})); a door state = the bits of the DOOR CLASSES (a door tile's passability reads its id and lookup0 only:
//           eecore.h doorPassable), computed by the GPU per state and looked up (a door state the tables lack: the rel
//           tier alone, still admissible; tools/gpuproof/exact.js adds them as the search meets them); inShut likewise.
// hOf(sim, {lim, known}) is that h in JS (lp.h and bounds.at themselves): = makeCtx's h with every door state known, and
// eegpu exacth must equal it state for state.
//   createTables(L, {tiers}) -> {hOf, sigOf, sigKey, sigParse, write(file, sigs), writeAdd(file, sigs), gateField, info}
//   node tools/perfect/gpuh.js <level> --out=<h.bin> [--route=<a.eetas>,..] [--tiers=kin,rel,gate] [--check=1]
//     (the door states of the start and of every given route's states; --check: h <= the ticks left along the routes)
// The file ('EEH1' v2, little endian): magic, version, int32[24], f64[24], then 8-aligned sections (exacthost.h XhTables
// load: the mechanism tables, the door classes, the rel field, the kin tables, the gate fields); an add file 'EEHA' v1:
// magic, version, N, sigWords, n, then per door state its signature and field tables.
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const T = require('../../src/plan/types.js');
const BO = require('../../src/plan/bounds.js');

const TROPHY = 121, F_SOLID = 1, F_DOOR = 16;
const KEY_DOOR_BIT = new Map([[23, 1], [24, 2], [25, 4], [26, 1], [27, 2], [28, 4], [1005, 8], [1006, 16], [1007, 32], [1008, 8], [1009, 16], [1010, 32]]);
const SIGW_MAX = 8;   // = native/exact.h XH_SIGW
const RISE_N = 256;   // = endgame.js riseTable's N, exact.h XK_RISE_N
const JUMP_HEIGHT = 26.0;
const TOGO_EPS = +(process.env.EEAT_TOGO_EPS || 0.01);

function createTables(L, o = {}) {
	const tiers = new Set(o.tiers || ['kin', 'rel', 'gate']);
	const W = L.width, H = L.height, N = W * H;
	const bounds = BO.createBounds(L, {});
	const S = bounds.static;
	const AO = { endgame: false };
	const trophyTiles = [];
	for (let i = 0; i < N; i++) if (L.fg[i] === TROPHY) trophyTiles.push(i);
	const fRel = bounds.field(trophyTiles, null, { touch: true });
	const mRel = bounds.meta(fRel);
	const useIso = !!(mRel && mRel.iso), useAxis = !!(mRel && mRel.ax), usePlain = !!(mRel && mRel.axp);
	const vmax = bounds.vmax, vp = bounds.vplain || { xp: 0, xn: 0, yp: 0, yn: 0 };
	// the dead balls' rel value (bounds.at on a dead ball): the least respawn value, at least 1
	let deadRel = Infinity;
	for (const r of S.respawn) if (fRel[r] < deadRel) deadRel = fRel[r];
	deadRel = Math.max(1, deadRel);
	// THE KIN TIER: levelproof.js contextOf (the same object wholepar.js makeCtx makes: with a rel / gate tier THE DEATH WAY'S
	// RESPAWN BOUND, o.hResp = the rel field's least value over the respawn tiles (EEAT_WP_RESPFIELD=0: off, as there), and
	// contextOf's own REACH FIELD'S PROOF: a live ball the RCH3 field calls cut off has h Infinity (the GPU: the same RCH3
	// bytes and beam.h reachFifths, which equals reach.js fifthsAt; the field's file goes into the tables' file)
	const kin = tiers.has('kin');
	const lpOpts = { field: false };
	if (kin && (tiers.has('rel') || tiers.has('gate')) && process.env.EEAT_WP_RESPFIELD !== '0') {
		let r = Infinity;
		for (const t of S.respawn) if (fRel[t] < r) r = fRel[t];
		if (Number.isFinite(r)) lpOpts.hResp = r;
	}
	const lp = kin ? require('../../src/plan/levelproof.js').contextOf(L, lpOpts) : null;
	const B = lp ? lp.egB : null;
	const hResp = lp ? lp.hResp : 0;
	// the RCH3 field contextOf cuts by (lp.reach: a physics-mode field); a field the file cannot hold (an effect-state or
	// plain-ball field: knobs of the compiler's process) leaves the GPU without the cut: weaker, still admissible
	let reachBytes = null, reachWhy = null;
	if (lp && lp.reach) {
		const RF = require('../../src/reach.js');
		const f = RF.reachField(L);
		if (!f || f.mode === 'walk') reachWhy = 'no physics field';
		else if (f.fx || f.plainFx) reachWhy = 'an effect-state / plain-ball field (not in RCH3)';
		else reachBytes = RF.reachFileBytes(f, null);
	}
	// riseTable(B, jv) for the three jump multipliers of the tame physics (endgame.js, the same operations)
	const BD = E.constants.BASE_DRAG, MULT = E.constants.MULT;
	const stepY = (v) => { let sy = v + B.modY; sy *= BD; if (sy > 16) sy = 16; else if (sy < -16) sy = -16; else if (sy < 0.0001 && sy > -0.0001) sy = 0; return sy; };
	const riseTableOf = (jv) => {
		const n0 = RISE_N, S1 = new Float64Array(n0 + 1);
		for (let i = 1, v = jv; i <= n0; i++) { v = stepY(v); S1[i] = S1[i - 1] + (v < 0 ? -v : 0); }
		const r = new Float64Array(n0 + 1);
		for (let n = 1; n <= n0; n++) {
			let best = Math.max(r[n - 1], S1[n - 1]);
			for (let m = 1; m <= n - 2; m++) { const v = S1[m] + r[n - 1 - m]; if (v > best) best = v; }
			r[n] = best;
		}
		return r;
	};
	const jms = [1.0, 1.0 * 1.3, 1.0 * 0.75];   // eesim.js _jumpMultiplier for jump_boost 0 / 1 / 2 (no zombie, no ice)
	const riseJv = B ? jms.map((jm) => ((0 - B.mory0) * JUMP_HEIGHT * jm) / MULT) : [0, 0, 0];
	const rise = B ? riseJv.map(riseTableOf) : null;
	// THE ORDER TIER's goals (wholeproof.js createH, the same lists)
	const gateGoals = [], gateInit = new Map();
	const useGateTier = tiers.has('gate');
	if (useGateTier) {
		const M = require('../../src/plan/model.js').compileModel(L, {});
		const tt = [];
		for (const X0 of M.triggers) if (X0.relevant && X0.kind !== 'trophy' && X0.kind !== 'cp') for (const t of X0.tiles) tt.push(t);
		for (const t of S.dsrc) tt.push(t);
		const trigTiles = Array.from(new Set(tt)).sort((a, b) => a - b);
		for (const t of trophyTiles) { gateInit.set(t, 0); gateGoals.push(t); }
		for (const t of trigTiles) if (!gateInit.has(t) && fRel[t] !== Infinity) { gateInit.set(t, fRel[t]); gateGoals.push(t); }
	}
	// the door classes: the tiles types.js levelNow turns into a wall or air (its door rule), by (id, lookup0)
	const fl = L.flags;
	const cls = [];
	const clsOfTile = new Int32Array(N).fill(-1);
	const byKey = new Map();
	const doorTiles = [];
	for (let i = 0; i < N; i++) {
		const id = L.fg[i];
		if (id <= 0 || id >= fl.length || (fl[id] & F_DOOR) === 0 || (fl[id] & F_SOLID) === 0) continue;
		if (T.CLOCK_DOORS.has(id) || id === 50) continue;
		const k = id + ':' + (L.lookup0 ? L.lookup0[i] : 0);
		let c = byKey.get(k);
		if (c === undefined) { c = cls.length; byKey.set(k, c); cls.push({ val: id, tile: i, key: KEY_DOOR_BIT.get(id) || 0, n: 0 }); }
		cls[c].n++;
		clsOfTile[i] = c;
		doorTiles.push(i);
	}
	const gate = useGateTier && cls.length <= 32 * SIGW_MAX;
	const sigWords = Math.max(1, Math.ceil(cls.length / 32));
	/** the door state: bit c = class c is a wall in levelNow's copy (its key on: kept open) */
	function sigOf(sim) {
		const s = new Uint32Array(sigWords);
		for (let c = 0; c < cls.length; c++) {
			if ((sim._keysMask & cls[c].key) !== 0) continue;
			const t = cls[c].tile;
			if (sim.is_tile_solid_now(t % W, (t / W) | 0)) s[c >> 5] = (s[c >> 5] | (1 << (c & 31))) >>> 0;
		}
		return s;
	}
	const sigKey = (s) => Array.from(s, (w) => (w >>> 0).toString(16).padStart(8, '0')).join('.');
	const sigParse = (k) => Uint32Array.from(k.split('.'), (h) => parseInt(h, 16) >>> 0);
	const levelOfSig = (s) => {
		const fg = Int32Array.from(L.fg);
		for (const i of doorTiles) { const c = clsOfTile[i]; fg[i] = (s[c >> 5] >>> (c & 31)) & 1 ? 9 : 0; }
		return Object.assign({}, L, { fg });
	};
	const gmemo = new Map();
	function gateField(s) {
		const k = sigKey(s);
		let f = gmemo.get(k);
		if (!f) { f = bounds.field(gateGoals, levelOfSig(s), { touch: true, init: gateInit }); gmemo.set(k, f); }
		return f;
	}
	const inShut = (sim, s) => {
		const x0 = Math.floor(sim.px / 16), x1 = Math.floor((sim.px + 15.999) / 16), y0 = Math.floor(sim.py / 16), y1 = Math.floor((sim.py + 15.999) / 16);
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue;
			const c = clsOfTile[y * W + x];
			if (c >= 0 && ((s[c >> 5] >>> (c & 31)) & 1)) return true;
		}
		return false;
	};
	/** createH's h (rel, gate): ho.known (a Set of sigKeys) = the door states with a gate field (else the rel tier alone,
	 *  as on the GPU); none = every door state */
	function mineOf(sim, ho) {
		let v = bounds.at(fRel, sim, AO);
		if (gate && v !== Infinity && !sim.is_dead) {
			const s = sigOf(sim);
			if (!inShut(sim, s) && (!ho.known || ho.known.has(sigKey(s)))) {
				const a = bounds.at(gateField(s), sim, AO);
				if (a > v) v = a;
			}
		}
		return v === Infinity ? Infinity : v + 1;
	}
	/** the GPU's h (exact.h xhOf) = wholepar.js makeCtx(L, {kin, rel, gate}).h(sim, lim) */
	function hOf(sim, ho = {}) {
		const lim = ho.lim !== undefined ? ho.lim : 1e9;
		if (sim.has_silver_crown) return 0;
		let v = 0;
		if (lp) {
			v = lp.h(sim, lim);
			if (v !== Math.floor(v)) v = Math.ceil(v - TOGO_EPS);
			if (v > lim) return v;
		}
		if (tiers.has('rel') || gate) { const a = mineOf(sim, ho); if (a > v) v = a; }
		return v;
	}
	// ---- the files
	const fieldParts = (f) => {
		const m = bounds.meta(f);
		const parts = [f];
		if (useIso) parts.push(m.iso);
		if (useAxis) parts.push(m.ax, m.ay);
		if (usePlain) parts.push(m.axp, m.ayp);
		for (const p of parts) if (!(p instanceof Float32Array) || p.length !== N) throw new Error('gpuh: a field table is missing');
		return parts;
	};
	function writer() {
		const chunks = [];
		let o = 0;
		const pad = () => { const q = (o + 7) & ~7; if (q > o) { chunks.push(Buffer.alloc(q - o)); o = q; } };
		return {
			raw(b) { chunks.push(b); o += b.length; },
			typed(a) { pad(); const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength); chunks.push(Buffer.from(b)); o += b.length; },
			done: () => Buffer.concat(chunks),
		};
	}
	const header = (nGate) => {
		const b = Buffer.alloc(296);
		b.write('EEH1', 0, 'latin1');
		b.writeInt32LE(2, 4);
		const ints = [W, H, N, S.nF, useIso ? 1 : 0, useAxis ? 1 : 0, usePlain ? 1 : 0, gate ? 1 : 0, B ? 1 : 0, gate ? cls.length : 0, sigWords, nGate,
			B ? B.cells.length : 0, B && B.tameLevel ? 1 : 0, B ? B.halves : 0, lp && lp.canDie ? 1 : 0, B && B.hasRun ? 1 : 0, B && B.hasFly ? 1 : 0,
			B && B.hasJump ? 1 : 0, B && B.hasFlip ? 1 : 0, B && B.portal ? 1 : 0, B ? B.nF : 0, reachBytes ? 1 : 0, 0];
		ints.forEach((v, k) => b.writeInt32LE(v, 8 + 4 * k));
		const dbl = [vmax.xp, vmax.xn, vmax.yp, vmax.yn, vp.xp, vp.xn, vp.yp, vp.yn, deadRel, hResp,
			B ? B.wgm : 0, B ? B.modY : 0, B ? B.alignY : 0, B ? B.mory0 : 0, B ? B.gmaxG : 0, riseJv[0], riseJv[1], riseJv[2], 0, 0, 0, 0, 0, 0];
		dbl.forEach((v, k) => b.writeDoubleLE(v, 104 + 8 * k));
		return b;
	};
	/** the main file: the tables and the gate fields of the given door states (sigKeys) */
	function write(file, sigs = []) {
		const keys = gate ? Array.from(new Set(sigs)) : [];
		const w = writer();
		w.raw(header(keys.length));
		const mechId = new Uint8Array(S.nF + 1);
		mechId.set(S.mechId.subarray(0, S.nF + 1));
		w.typed(mechId);
		w.typed(Uint8Array.from(S.mechT));
		const nC = gate ? cls.length : 0;
		w.typed(Int32Array.from(cls.slice(0, nC), (c) => c.val));
		w.typed(Int32Array.from(cls.slice(0, nC), (c) => c.tile));
		w.typed(Int32Array.from(cls.slice(0, nC), (c) => c.key));
		w.typed(gate ? clsOfTile : new Int32Array(N).fill(-1));
		for (const p of fieldParts(fRel)) w.typed(p);
		if (B) {
			w.typed(Float64Array.from(B.targets));
			w.typed(Uint8Array.from(B.tameId));
			for (const ps of [B.wildPS, B.icePS, B.boostPS, B.gxPS, B.gyPS, B.jxPS, B.jyPS]) w.typed(Int32Array.from(ps));
			if (B.portal) { w.typed(Uint8Array.from(B.portal)); w.typed(Uint8Array.from(B.trigQ)); w.typed(Int32Array.from(B.trigPS)); }
			const r = new Float64Array(3 * (RISE_N + 1));
			rise.forEach((t, k) => r.set(t, k * (RISE_N + 1)));
			w.typed(r);
		}
		for (const k of keys) { w.typed(sigParse(k)); for (const p of fieldParts(gateField(sigParse(k)))) w.typed(p); }
		// (the RCH3 field last, after the gate fields: its byte count (int64), its bytes; header int 22 = 1)
		if (reachBytes) { w.typed(BigInt64Array.from([BigInt(reachBytes.length)])); w.typed(new Uint8Array(reachBytes.buffer, reachBytes.byteOffset, reachBytes.length)); }
		fs.writeFileSync(file, w.done());
		return keys.length;
	}
	/** an add file ('EEHA'): more door states' gate fields */
	function writeAdd(file, sigs) {
		const keys = Array.from(new Set(sigs));
		const w = writer();
		const h = Buffer.alloc(32);
		h.write('EEHA', 0, 'latin1');
		[1, N, sigWords, keys.length].forEach((v, k) => h.writeInt32LE(v, 4 + 4 * k));
		w.raw(h);
		for (const k of keys) { w.typed(sigParse(k)); for (const p of fieldParts(gateField(sigParse(k)))) w.typed(p); }
		fs.writeFileSync(file, w.done());
		return keys.length;
	}
	const info = { tiers: Array.from(tiers), useIso, useAxis, usePlain, gate, doorClasses: cls.length, doorTiles: doorTiles.length, sigWords, kin: !!B,
		canDie: lp ? lp.canDie : null, hResp, deadRel, gateGoals: gateGoals.length, kinTargets: B ? B.cells.length : 0, tame: B ? !!B.tameLevel : null, portals: B ? !!B.portal : null,
		reach: !!reachBytes, reachWhy, reachMB: reachBytes ? +(reachBytes.length / 1e6).toFixed(1) : 0 };
	return { hOf, sigOf, sigKey, sigParse, write, writeAdd, gateField, info, bounds, fRel, canDie: lp ? lp.canDie : true };
}

/** the door states along a run (the start's first) */
function sigsAlong(L, tables, masks) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const out = new Set([tables.sigKey(tables.sigOf(sim))]);
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]); sim.tick(inp);
		out.add(tables.sigKey(tables.sigOf(sim)));
		if (sim.has_silver_crown) break;
	}
	return out;
}

if (require.main === module) {
	const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)]; }));
	const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
	const C = require('../../src/common.js');
	const L = T.loadLevelFile(file);
	const t0 = Date.now();
	const tb = createTables(L, { tiers: (args.tiers || 'kin,rel,gate').split(',').filter(Boolean) });
	const sigs = new Set(sigsAlong(L, tb, new Uint8Array(0)));
	const out = { level: path.basename(file), info: tb.info, checks: [] };
	for (const f of (args.route || '').split(',').filter(Boolean)) {
		const ms = C.readEetas(f);
		for (const k of sigsAlong(L, tb, ms)) sigs.add(k);
		if (args.check !== '0') {
			const ck = require('./wholeproof.js').checkRoute(L, ms, { h: (s) => tb.hOf(s) });
			out.checks.push(Object.assign({ route: path.basename(f) }, ck));
		}
	}
	if (args.out) out.doorStates = tb.write(path.resolve(args.out), Array.from(sigs));
	out.ms = Date.now() - t0;
	console.log(JSON.stringify(out));
}

module.exports = { createTables, sigsAlong };
