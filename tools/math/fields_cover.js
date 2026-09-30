'use strict';
// THE FIELD SOLVER ON THE REAL MOVES (n4-math, build / fields): the truthset's routes segmented into moves between
// support states exactly as the moves study does (src/out/n4plan/understand/moves/moves.js: classes G W C Z B D A, a
// boundary at every landing / field entry / teleport / death / respawn, the labels arrow, dot, climb, swim, boost, hop,
// jump, fall, ...), and for every move from the route's OWN start state the field solver (src/math/fieldsolve.js) asked
// for the route's next support (its class and centre tile) within the route's own ticks: solved by the mathematics
// ('math': a candidate from the per-axis solutions, replayed by the engine) or not; the ticks against the route's.
// Usage: EEAT_TRUTH_ROOT=<truth root> node tools/math/fields_cover.js --shard=i/n --out=<dir> [--labels=arrow,dot,...]
//        [--family=1] [--k=2] [--every=1]      then: node tools/math/fields_cover.js --agg=<dir>
// General: no level-specific code.
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const FS = require('../../src/math/fieldsolve.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { agg(argv.agg); process.exit(0); }
const TS = require('../../src/plan/truthset.js');
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || path.join('src', 'out', 'fields', 'cover');
fs.mkdirSync(OUT, { recursive: true });
const LABELS = new Set((argv.labels || 'arrow,dot,climb,swim,boost,hop,jump,fall').split(','));
const EVERY = +(argv.every || 1);
const ARROWS = new Set([1, 2, 3, 1518, 411, 412, 413, 1519]);
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);
const TELEPORT_PX = 20;

function movesOf(L, masks) {
	const n = masks.length, W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let evJump = false;
	sim.onEvent = (ev) => { if (ev === 'jump') evJump = true; };
	const snaps = new Array(n + 1), cls = new Array(n + 1), tp = new Uint8Array(n + 1), tileAt = new Int32Array(n + 1);
	const jumpAt = new Uint8Array(n + 1), arrowT = new Uint8Array(n + 1), grav = new Array(n + 1);
	snaps[0] = sim.snapshot(); cls[0] = FS.supportClass(sim); tileAt[0] = FS.tileOfSim(sim); grav[0] = `${Math.sign(sim.mox)},${Math.sign(sim.moy)}`;
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		evJump = false;
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		snaps[t + 1] = sim.snapshot();
		cls[t + 1] = FS.supportClass(sim);
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		tileAt[t + 1] = FS.tileOfSim(sim);
		jumpAt[t + 1] = evJump ? 1 : 0;
		arrowT[t + 1] = (ARROWS.has(sim.current_tile) || sim.flip_gravity !== 0) ? 1 : 0;
		grav[t + 1] = `${Math.sign(sim.mox)},${Math.sign(sim.moy)}`;
	}
	sim.onEvent = null;
	const bnd = [0];
	for (let t = 1; t <= n; t++) {
		const a = cls[t - 1], b = cls[t];
		let isB = false;
		if (tp[t]) isB = true;
		else if (a === 'D' && b !== 'D') isB = true;
		else if (b !== a && SUPPORT.has(b)) isB = true;
		if (isB && t !== bnd[bnd.length - 1]) bnd.push(t);
	}
	if (bnd[bnd.length - 1] !== n) bnd.push(n);
	const moves = [];
	for (let i = 0; i + 1 < bnd.length; i++) {
		const t0 = bnd[i], t1 = bnd[i + 1], len = t1 - t0;
		const c0 = cls[t0], c1 = cls[t1];
		let jumps = 0, jumpAir = 0, firstJump = -1, arrow = 0, boost = 0, liquid = 0, climb = 0, dot = 0, tele = 0, gravNonDown = 0, takeoff = -1;
		if (c0 === 'G') for (let k = 0; k < len; k++) if (cls[t0 + k + 1] !== 'G') { takeoff = k; break; }
		for (let k = 0; k < len; k++) {
			const t = t0 + k + 1;
			if (jumpAt[t]) { if (!(k === len - 1 && cls[t] === 'G')) { jumps++; if (firstJump < 0) firstJump = k; if (cls[t0 + k] !== 'G' && cls[t] !== 'G') jumpAir++; } }
			if (arrowT[t]) arrow++;
			const c = cls[t];
			if (c === 'B') boost++; else if (c === 'W') liquid++; else if (c === 'C') climb++; else if (c === 'Z') dot++;
			if (tp[t]) tele++;
			if (grav[t] !== '0,1' && grav[t] !== '0,0') gravNonDown++;
		}
		const hopStart = c0 === 'G' && jumpAt[t0] === 1;
		const endKind = tp[t1] ? 'portal' : c1 === 'D' && c0 !== 'D' ? 'death' : c0 === 'D' ? 'respawn' : c1 === 'G' ? 'land' : c1 === 'A' ? 'end' : 'field';
		let label;
		if (c0 === 'D') label = 'respawn';
		else if (endKind === 'death') label = 'death';
		else if (tele > 0) label = 'portal';
		else if (boost > 0 || c0 === 'B') label = 'boost';
		else if (c0 === 'W' || liquid > len / 2) label = 'swim';
		else if (c0 === 'C' || climb > len / 2) label = 'climb';
		else if (c0 === 'Z' || dot > len / 2) label = 'dot';
		else if (arrow > 0 || gravNonDown > 0) label = 'arrow';
		else if (jumps > 0) label = jumpAir > 0 ? 'airjump' : (hopStart && firstJump > 0 ? 'hopjump' : 'jump');
		else if (hopStart) label = 'hop';
		else if (takeoff >= 0 || c0 === 'A') label = 'fall';
		else label = 'walk';
		moves.push({ t0, t1, len, c0, c1, label, endKind, tile1: tileAt[t1], snap: snaps[t0] });
	}
	return { moves, sim };
}

function main() {
	const routes = TS.knownRoutes();
	const outFile = path.join(OUT, `cover_${SH}.jsonl`);
	const fd = fs.openSync(outFile, 'w');
	let nm = 0, ok = 0;
	const t0 = Date.now();
	for (let r = 0; r < routes.length; r++) {
		if ((r % NSH) !== SH) continue;
		const entry = routes[r];
		let tr;
		try { tr = TS.loadTruth(entry); } catch (e) { continue; }
		if (!tr) continue;
		const { L, masks } = tr;
		const { moves, sim } = movesOf(L, masks);
		let mi = 0;
		for (const mv of moves) {
			if (!LABELS.has(mv.label)) continue;
			if (mv.endKind === 'portal' || mv.endKind === 'death' || mv.c1 === 'D' || mv.c1 === 'A') continue;
			if ((mi++ % EVERY) !== 0) continue;
			if (mv.len > 127) continue;
			sim.restore(mv.snap);
			const res = FS.solveLeg(L, sim, { tiles: [mv.tile1], cls: mv.c1, maxT: mv.len }, { k: +(argv.k || 2), family: argv.family === '1', limit: +(argv.limit || 6) });
			nm++; if (res.ok) ok++;
			fs.writeSync(fd, JSON.stringify({ r, name: entry.name || entry.level || '', label: mv.label, len: mv.len, c0: mv.c0, c1: mv.c1,
				ok: res.ok, tool: res.tool, ticks: res.ticks, lb: res.lb === Infinity ? null : res.lb, tried: res.tried, ms: res.ms }) + '\n');
		}
	}
	fs.closeSync(fd);
	console.log(`shard ${SH}/${NSH}: ${nm} moves, ${ok} solved (${Date.now() - t0} ms) -> ${outFile}`);
}

function agg(dir) {
	const rows = [];
	for (const f of fs.readdirSync(dir)) if (/^cover_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
	const by = new Map();
	for (const r of rows) { if (!by.has(r.label)) by.set(r.label, []); by.get(r.label).push(r); }
	const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	console.log('label   moves  solved  math  family  faster  equal  later  median-ms  p90-ms  lb<=route  at-lb');
	const tot = { n: 0, ok: 0, math: 0, fam: 0, faster: 0, equal: 0, atLb: 0, ms: [] };
	for (const [lab, a] of [...by].sort((x, y) => y[1].length - x[1].length)) {
		const ok = a.filter((r) => r.ok), math = ok.filter((r) => r.tool === 'math'), fam = ok.filter((r) => r.tool === 'family');
		const faster = ok.filter((r) => r.ticks < r.len).length, equal = ok.filter((r) => r.ticks === r.len).length;
		const ms = a.map((r) => r.ms), s = [...ms].sort((x, y) => x - y);
		const lbOk = a.filter((r) => r.lb !== null && r.lb <= r.len).length;
		const atLb = ok.filter((r) => r.lb !== null && r.ticks === r.lb).length;
		console.log(`${lab.padEnd(7)} ${String(a.length).padStart(6)} ${pct(ok.length, a.length).padStart(6)}% ${pct(math.length, a.length).padStart(5)}% ${pct(fam.length, a.length).padStart(6)}% ${String(faster).padStart(6)} ${String(equal).padStart(6)} ${String(ok.length - faster - equal).padStart(6)} ${String(med(ms)).padStart(9)} ${String(s[Math.floor(s.length * 0.9)] || 0).padStart(7)} ${pct(lbOk, a.length).padStart(8)}% ${pct(atLb, ok.length).padStart(6)}%`);
		tot.n += a.length; tot.ok += ok.length; tot.math += math.length; tot.fam += fam.length; tot.faster += faster; tot.equal += equal; tot.atLb += atLb;
		for (const r of a) tot.ms.push(r.ms);
	}
	const sm = tot.ms.sort((x, y) => x - y);
	console.log(`ALL     ${String(tot.n).padStart(6)} ${pct(tot.ok, tot.n).padStart(6)}% ${pct(tot.math, tot.n).padStart(5)}% ${pct(tot.fam, tot.n).padStart(6)}% ${String(tot.faster).padStart(6)} ${String(tot.equal).padStart(6)} ${String(tot.ok - tot.faster - tot.equal).padStart(6)} ${String(med(sm)).padStart(9)} ${String(sm[Math.floor(sm.length * 0.9)] || 0).padStart(7)} ${''.padStart(9)} ${pct(tot.atLb, tot.ok).padStart(6)}%`);
	console.log(`(solved: the route's next support (class + centre tile) reached within the route's own ticks from its own start state; faster / equal / later: vs the route's ticks; at-lb: the found leg's ticks = the field bound (optimal in the field model, the modelled contacts)); ${sm.reduce((x, y) => x + y, 0)} ms in all`);
}

main();
