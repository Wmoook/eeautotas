'use strict';
// THE FIELD TABLES (n4-math, build / fields): per field and effect set, each axis' recurrence written down once
// (level-independent; src/math/field_tables/summary.json, docs/ee_math.md section 6):
//   kind and drags (release / along / against), the constants as exact doubles (mods, mo, moO, J), the fixed point of
//   every held input from rest and from +-16 (the double and the tick it is reached: the engine checked it, F4), the
//   release's stop from the held fixed point, the closed form's real parameters (v*_real = a d / (1 - d) for the held
//   input: a = the modifier, d = the drag product) and the largest gap between the double trajectory and the real closed
//   form over T ticks, and the rows of the envelope's two sides from rest (THEOREM F3: every word's speed / offset lies
//   between them; the held inputs where the key order holds): the 1D minimum-time function of the field, T ticks.
// Identical recurrences (THEOREM F2's classes) share one entry: `same` lists the contexts it serves, `mirror` those it
// serves with the signs flipped.
//   node tools/math/fields_tables.js [--T=120] [--out=src/math/field_tables/summary.json]
const fs = require('fs');
const path = require('path');
const F = require('../../src/math/fields.js');
const K = require('../../src/plan/kin.js');
const K1 = require('../../src/plan/kin1d.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const T = +(argv.T || 120);
const OUT = argv.out || path.join(__dirname, '..', '..', 'src', 'math', 'field_tables', 'summary.json');
const hex = K1.f64hex;
const FX = [['plain', {}], ['speed1.5', { sb: 1 }], ['speed0.6', { sb: 2 }], ['lowgrav', { lowGravity: true }]];

function rowsOf(A) {
	const e = F.envelope(0, 0, T, A);
	const r = { vhi: [], phi: [], vlo: [], plo: [] };
	for (let t = 1; t <= T; t++) { r.vhi.push(hex(e.vhi[t])); r.phi.push(hex(e.phi[t])); r.vlo.push(hex(e.vlo[t])); r.plo.push(hex(e.plo[t])); }
	return r;
}
function entryOf(A) {
	const d = F.describe(A);
	const fp = {};
	for (const i of [0, 1, 2]) for (const v0 of [0, 16, -16]) { const f = F.fixedPoint(A, i, v0); fp[`${['none', 'neg', 'pos'][i]}@${v0}`] = [hex(f.v), f.v, f.tick]; }
	// the release's stop from the held (pos) fixed point
	const top = F.fixedPoint(A, 2, 0).v, rel = F.fixedPoint(A, 0, top);
	// the closed form of the held pos input: v_t = v* + (v0 - v*) d^t with d the drag product (reals)
	const mod = A.mods[2];
	const drags = { B: K.BASE_DRAG, N: K.NO_MOD_DRAG, W: K.WATER_DRAG, U: K.MUD_DRAG, L: K.LAVA_DRAG, Ino: K.ICE_NO_MOD_DRAG, I: K.ICE_DRAG };
	let dAlong = 1; for (const n of String(d.along).split('*')) dAlong *= drags[n] || 1;
	const vReal = d.along === 'boost' ? A.boost : mod * dAlong / (1 - dAlong);
	let v = 0, gap = 0;
	for (let t = 1; t <= T; t++) { v = F.vStep(v, 2, A); const real = d.along === 'boost' ? A.boost : vReal * (1 - Math.pow(dAlong, t)); gap = Math.max(gap, Math.abs(v - real)); }
	return { kind: d.kind, release: d.release, along: d.along, against: d.against, mods: [...A.mods].map(hex), modsN: [...A.mods], mo: A.mo, moO: A.moO, J: A.J, boost: A.boost,
		fixed: fp, releaseStop: [hex(rel.v), rel.tick], closed: { mod, d: dAlong, vStarReal: vReal, maxGap: gap }, rows: rowsOf(A) };
}

function main() {
	const out = { engine: K1.engineKey(), T, note: 'hex doubles (LE); rows[t-1] = after t ticks from rest at offset 0; see tools/math/fields_tables.js', entries: [] };
	const sig = new Map();
	for (const c of F.CLASSES) for (const [fxName, fx] of FX) {
		const ctx = F.fieldCtx(Object.assign({ cur: F.REP[c], del: F.REP[c] }, fx));
		for (const ax of ['x', 'y']) {
			const A = ctx[ax];
			const name = `${c}.${ax}${fxName === 'plain' ? '' : '@' + fxName}`;
			// the signature: the envelope rows (identical recurrences give identical rows; a mirror gives negated ones)
			// (and every input's own chain from +-5 and +-0.5: the release / against drags tell INPUT from FREE)
			const e = F.envelope(0, 0, 40, A), fwd = [], neg = [];
			for (let t = 1; t <= 40; t++) { fwd.push(e.vlo[t], e.vhi[t]); neg.push(-e.vhi[t], -e.vlo[t]); }
			const MI = [0, 2, 1];
			for (const s0 of [5, -5, 0.5, -0.5]) for (const i of [0, 1, 2]) {
				let a = s0, b = -s0;
				for (let t = 0; t < 12; t++) { a = F.vStep(a, i, A); b = F.vStep(b, MI[i], A); fwd.push(a); neg.push(-b); }
			}
			const s = fwd.join(','), sn = neg.map((v) => (v === 0 ? 0 : v)).join(',');
			if (sig.has(s)) { sig.get(s).same.push(name); continue; }
			if (sig.has(sn)) { sig.get(sn).mirror.push(name); continue; }
			const en = Object.assign({ rep: name, same: [name], mirror: [] }, entryOf(A));
			sig.set(s, en);
			out.entries.push(en);
		}
	}
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, JSON.stringify(out));
	console.log(`${out.entries.length} distinct field recurrences (from ${F.CLASSES.length} fields x ${FX.length} effect sets x 2 axes) -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
	for (const e of out.entries) console.log(`  ${e.rep.padEnd(22)} ${e.kind.padEnd(10)} ${e.release}/${e.along}/${e.against}  held+ ${e.fixed['pos@0'][1]} at ${e.fixed['pos@0'][2]}  none ${e.fixed['none@0'][1]} at ${e.fixed['none@0'][2]}  stop ${e.releaseStop[1]}  real v* ${e.closed.vStarReal.toFixed(6)} gap ${e.closed.maxGap.toExponential(2)}  (+${e.same.length - 1} same, ${e.mirror.length} mirror)`);
}
main();
