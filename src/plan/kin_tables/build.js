'use strict';
// THE 1D REACHABILITY TABLES, built once (n4-math, Derive / reach1d; src/plan/kin1d.js, docs/ee_math.md "Reach1d").
// Level-independent: every input pattern of the plain free-air input axis (x under default gravity, speed x1, gravity x1)
// with <= K changes and <= T ticks from the start speed classes below, per tick sorted by the nominal offset (kin1d
// buildTable), written in the kin1d binary format to the cache (large: ~20 bytes a row); the small summaries go into this
// folder (git): summary.json (per class, K and tick: the offset range, the largest gap between reachable offsets, the rows)
// and ga.json (the gravity axis: per gravity and jump multiplier and start speed class the exact (dy, vy) of every tick,
// doubles as hex, and the input axis' extreme rows hold R / hold L from each class: the 1D minimum-time function).
//   node src/plan/kin_tables/build.js [--out=<cache dir>] [--classes=rest,top,topL] [--K2T=120] [--K3T=48] [--summary=0]
//   kin1d.loadTable(name, {K, T}) reads a table back (cacheDir() + `${name}_k${K}_t${T}.bin`, built here when missing)
// The start speed classes (the finite set the engine produces from rest, THEOREM F in docs/ee_math.md):
//   rest  v0 = 0: every speed of the axis is a pattern from rest (the rest tree): the universal table
//   top   v0 = the fixed point of hold R from rest, 6.776552880470027 (reached exactly at tick 1760; hold R stays there)
//   topL  v0 = -top (the mirror: the arithmetic is sign-symmetric, round to nearest even)
const fs = require('fs');
const path = require('path');
const K = require('../kin1d.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));

function main() {
	const out = argv.out || K.cacheDir();
	fs.mkdirSync(out, { recursive: true });
	const classes = (argv.classes || 'rest,top,topL').split(',');
	const K2T = +(argv.K2T || 120), K3T = +(argv.K3T || 48);
	const summary = { engine: K.engineKey(), ctx: { sm: 1, gm: 1 }, classes: {} };
	for (const name of classes) {
		const v0 = K.CLASSES[name];
		const cs = { v0: K.f64hex(v0), v0n: v0, tables: {} };
		for (const [KK, TT] of [[2, K2T], [3, K3T]]) {
			const t0 = Date.now();
			const tab = K.buildTable(v0, { T: TT, K: KK });
			const file = path.join(out, `${name}_k${KK}_t${TT}.bin`);
			K.writeTable(file, tab);
			let rows = 0; for (let t = 1; t <= TT; t++) rows += tab.ticks[t].dx.length;
			const sum = K.summary(tab);
			cs.tables[`k${KK}`] = { T: TT, rows, bytes: fs.statSync(file).size, ms: Date.now() - t0, perTick: sum.map((r) => [r[0], +r[1].toFixed(6), +r[2].toFixed(6), +r[3].toFixed(6), r[4], isNaN(r[5]) ? null : +r[5].toExponential(3), isNaN(r[6]) ? null : +r[6].toExponential(3)]) };
			process.stdout.write(`${name} K${KK} T${TT}: ${rows} rows, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms -> ${file}\n`);
		}
		// the extreme rows (THEOREM M): hold R / hold L offsets from 0 and speeds, t = 1..240
		const I = K.ia();
		for (const [key, mi] of [['holdR', 2], ['holdL', 1], ['release', 0]]) {
			let x = 0, v = v0; const dx = [], vv = [];
			for (let t = 1; t <= 240; t++) { v = K.axisStep(v, I.ms[mi], 0, I.moO, 0, false); x += v; dx.push(K.f64hex(x)); vv.push(K.f64hex(v)); }
			cs[key] = { dx, v: vv };
		}
		summary.classes[name] = cs;
	}
	// the gravity axis: per (gm, jm) the start classes 0 and J, 240 ticks, exact doubles
	const ga = { engine: K.engineKey(), note: 'y offset from 0 and vy after each tick t = 1..240 (hex doubles); a jump tick sets vy = J after the move', axes: [] };
	for (const gm of [1, 0.15]) {
		for (const jm of [1, 1.3, 0.75, 0.75 * 0.75, 1.3 * 0.75, 0.88, 1.3 * 0.88, 0.75 * 0.88]) {
			const G = K.ga({ gm, jm });
			for (const [cls, vy0] of [['0', 0], ['J', G.J]]) {
				if (cls === '0' && jm !== 1) continue;
				const tr = { y: [], v: [] };
				K.evalGA(0, vy0, 240, G, null, tr);
				ga.axes.push({ gm, jm, cls, vy0: K.f64hex(vy0), a: K.f64hex(G.a), J: K.f64hex(G.J), dy: tr.y.map(K.f64hex), vy: tr.v.map(K.f64hex) });
			}
		}
	}
	if (argv.summary !== '0') {
		fs.writeFileSync(path.join(__dirname, 'summary.json'), JSON.stringify(summary));
		fs.writeFileSync(path.join(__dirname, 'ga.json'), JSON.stringify(ga));
		process.stdout.write(`summary.json ${fs.statSync(path.join(__dirname, 'summary.json')).size} bytes, ga.json ${fs.statSync(path.join(__dirname, 'ga.json')).size} bytes\n`);
	}
}

if (require.main === module) main();
module.exports = { main };
