'use strict';
// N4U STUDY 2, THE MOVE MATHS on real routes (n4u-moves; the compiler's missing Understand study, 2026-09-29).
// Segments every known route of the truthset (src/plan/truthset.js) into MOVES between SUPPORT states and measures,
// by the engine only (src/eesim.js, stateHash equality = exact):
//   1. the move classes (walk, jump, fall, airjump, arrow, boost, swim, climb, dot, portal, death, respawn) and their
//      raw input patterns (runs of the direction track, jump presses, ground / air split);
//   2. the ESSENTIAL input changes of each move: the route's inputs greedily simplified (a run merged into a neighbour,
//      up/down dropped, jump bits kept only where a jump happened, jump runs shortened to one tick) while the engine
//      still reaches the SAME state (stateHash) at the move's end tick: the smallest family "k direction changes"
//      that reproduces the move exactly is at most this k;
//   3. the timing slack of each essential change point (a 1-tick shift keeps the end state exact or not);
//   4. the primitives builder's plain macro family (origin/n4plan-primitives prims.js: JUMP(d, rel r / turn t),
//      JUMP(-), WALKOFF(d, hold / rel) on its timing grids) and the same shapes on a per-tick grid, from the route's own
//      takeoff state: does one macro reproduce the air phase exactly (same end hash, same tick)?
//   5. the support-state quantisation: the start state perturbed inside a class (px + d, vx + e) and the route's own
//      inputs replayed: the same end tick / tile / class, or not.
// Usage: node src/plan/understand/moves.js --shard=i/n --out=<dir> [--limit=N] [--only=<name substring>]
//   (EEAT_TRUTH_ROOT = the checkout with src/jobs + src/out/god). One JSON line per move into <dir>/moves_<i>.jsonl and
//   one per route into <dir>/routes_<i>.jsonl. General: no level-specific code.
const fs = require('fs');
const path = require('path');
const E = require('../../eesim.js');
const TS = require('../truthset.js');
const T = require('../types.js');

const F_SOLID = 1, F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const ARROWS = new Set([1, 2, 3, 1518, 411, 412, 413, 1519]);
const DOTS = new Set([4, 414]);
const TELEPORT_PX = 20;
const MAX_CHECKS = 400;          // engine checks per move for the simplification (the rest is reported as capped)

// the builder's grids (origin/n4plan-primitives 2e70a92 prims.js)
const REL = [Infinity, 2, 4, 8, 12, 16, 24];
const TURN = [4, 8, 16];

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || path.join('src', 'out', 'n4plan', 'understand', 'moves', 'data');
fs.mkdirSync(OUT, { recursive: true });

function clsOf(s, flags) {
	if (s.is_dead) return 'D';
	const id = s.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (DOTS.has(id)) return 'Z';
	if (f & F_BOOST) return 'B';
	if (s.on_ground) return 'G';
	return 'A';
}
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);
const canon = (m) => { m &= 31; if ((m & 6) === 6) m &= ~6; if ((m & 24) === 24) m &= ~24; return m; };
function rle(arr) { const r = []; for (let i = 0; i < arr.length; i++) { if (r.length && r[r.length - 1][0] === arr[i]) r[r.length - 1][1]++; else r.push([arr[i], 1]); } return r; }

function analyseRoute(entry) {
	const tr = TS.loadTruth(entry);
	if (!tr) return null;
	const { L, masks } = tr;
	const n = masks.length;
	const W = L.width, H = L.height;
	const sim = new E.EESim(L), inp = new E.EEInput();
	const flags = sim._flags;
	sim.reset();
	let evJump = false, evDeath = false, evResp = false;
	sim.onEvent = (ev) => { if (ev === 'jump') evJump = true; else if (ev === 'death') evDeath = true; else if (ev === 'respawn') evResp = true; };
	const snaps = new Array(n + 1), cls = new Array(n + 1), jumpAt = new Uint8Array(n + 1), tp = new Uint8Array(n + 1);
	const grav = new Array(n + 1), tileAt = new Int32Array(n + 1), onG = new Uint8Array(n + 1), arrowT = new Uint8Array(n + 1);
	snaps[0] = sim.snapshot(); cls[0] = clsOf(sim, flags); tileAt[0] = T.tileOf(sim, W, H); onG[0] = sim.on_ground ? 1 : 0;
	grav[0] = `${Math.sign(sim.mox)},${Math.sign(sim.moy)}`;
	for (let t = 0; t < n; t++) {
		const px = sim.px, py = sim.py;
		evJump = false;
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		snaps[t + 1] = sim.snapshot();
		cls[t + 1] = clsOf(sim, flags);
		jumpAt[t + 1] = evJump ? 1 : 0;
		tp[t + 1] = (!sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX)) ? 1 : 0;
		tileAt[t + 1] = T.tileOf(sim, W, H);
		onG[t + 1] = sim.on_ground ? 1 : 0;
		grav[t + 1] = `${Math.sign(sim.mox)},${Math.sign(sim.moy)}`;
		arrowT[t + 1] = (ARROWS.has(sim.current_tile) || sim.flip_gravity !== 0) ? 1 : 0;
	}
	sim.onEvent = null;
	// the support boundaries
	const bnd = [0];
	for (let t = 1; t <= n; t++) {
		const a = cls[t - 1], b = cls[t];
		let isB = false;
		if (tp[t]) isB = true;
		else if (a === 'D' && b !== 'D') isB = true;                       // respawn
		else if (b !== a && SUPPORT.has(b)) isB = true;                    // landing / entering a field / dying
		if (isB && t !== bnd[bnd.length - 1]) bnd.push(t);
	}
	if (bnd[bnd.length - 1] !== n) bnd.push(n);
	const hashAt = (t) => { sim.restore(snaps[t]); return sim.stateHash(); };
	const moves = [];
	const play = (t0, seq, target) => {
		sim.restore(snaps[t0]);
		for (let k = 0; k < seq.length; k++) { E.applyMask(inp, seq[k]); sim.tick(inp); }
		return sim.stateHash() === target;
	};
	for (let i = 0; i + 1 < bnd.length; i++) {
		const t0 = bnd[i], t1 = bnd[i + 1], len = t1 - t0;
		const c0 = cls[t0], c1 = cls[t1];
		let takeoff = -1;   // the first input index k (relative) after which the ball is not on the ground
		if (c0 === 'G') for (let k = 0; k < len; k++) if (cls[t0 + k + 1] !== 'G') { takeoff = k; break; }
		let hopEnd = 0, jumps = 0, jumpAir = 0, firstJump = -1, arrow = 0, boost = 0, liquid = 0, climb = 0, dot = 0, tele = 0, gravNonDown = 0;
		for (let k = 0; k < len; k++) {
			const t = t0 + k + 1;
			// a jump on the move's last tick that landed (grounded in that tick's movement) = a HOP at the landing: the
			// terminal option of this move, the launch of the next one (not counted as this move's jump)
			if (jumpAt[t]) { if (k === len - 1 && cls[t] === 'G') hopEnd = 1; else { jumps++; if (firstJump < 0) firstJump = k; if (cls[t0 + k] !== 'G' && cls[t] !== 'G') jumpAir++; } }
			if (arrowT[t]) arrow++;
			const c = cls[t];
			if (c === 'B') boost++; else if (c === 'W') liquid++; else if (c === 'C') climb++; else if (c === 'Z') dot++;
			if (tp[t]) tele++;
			if (grav[t] !== '0,1' && grav[t] !== '0,0') gravNonDown++;
		}
		const hopStart = c0 === 'G' && jumpAt[t0] === 1;   // this move starts in the air of a hop at its landing tick
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
		const raw = []; for (let k = 0; k < len; k++) raw.push(canon(masks[t0 + k]));
		const dirRaw = raw.map((m) => m & 30);
		const rawDirRuns = rle(dirRaw).length, rawJumpRuns = rle(raw.map((m) => m & 1)).filter((r) => r[0] === 1).length;
		const mv = { r: entry._idx, t0, t1, len, c0, c1, endKind, label, takeoff, jumps, jumpAir, firstJump, liquid, climb, dot, boost, arrow,
			rawDirRuns, rawJumpRuns, hopEnd, hopStart: hopStart ? 1 : 0, tile0: tileAt[t0], tile1: tileAt[t1] };
		const target = hashAt(t1);
		if (argv.cls) {
			// ---- 6 (--cls): SUPPORT-CLASS coverage: does a family member reach the route's next support (the same class
			// letter, the same centre tile, a teleport when the route teleported) at the same tick or EARLIER? From the
			// route's own press tick (a ground jump: the press is k = 0 of the shape) or the move's start.
			if (c0 === 'D' || len > 400) { moves.push(mv); continue; }
			const kj = (label === 'jump' || label === 'hopjump') && firstJump >= 0 ? firstJump : 0;
			const tA = t0 + kj, N = len - kj, pr = kj > 0 || (label === 'jump' && firstJump === 0) ? 1 : 0;
			sim.restore(snaps[tA]);
			const plainAir = sim.flip_gravity === 0 && !sim.has_levitation && (c0 === 'G' || c0 === 'A') && label !== 'arrow';
			const EG = require('../../endgame.js');
			// --cls=9: every non-cancelling direction mask on the non-plain moves (the gravity may turn inside the move)
			const Ms = plainAir ? [0, 2, 4] : argv.cls === '9' ? [0, 2, 4, 8, 16, 10, 12, 18, 20] : Array.from(EG.probeMasks(sim, inp, snaps[tA])).filter((m) => (m & 1) === 0);
			const refVx = (() => { sim.restore(snaps[t1]); return sim.speed_x; })();
			const hitOf = (fn) => {   // the first tick k (1-based) at the route's next support class, or 0
				sim.restore(snaps[tA]);
				let px = sim.px, py = sim.py;
				for (let k = 0; k < N; k++) {
					E.applyMask(inp, fn(k)); sim.tick(inp);
					const tel = Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX;
					px = sim.px; py = sim.py;
					if (sim.is_dead && c1 !== 'D') return 0;
					if (endKind === 'portal' ? tel && T.tileOf(sim, W, H) === tileAt[t1] : (clsOf(sim, flags) === c1 && T.tileOf(sim, W, H) === tileAt[t1])) return k + 1;
				}
				return 0;
			};
			let f0 = 0, f1 = 0, f0x = 0, f1x = 0;
			for (const d0 of Ms) {
				const h = hitOf((k) => (k === 0 ? pr | d0 : d0));
				if (h && (!f0 || h < f0)) { f0 = h; f0x = Math.sign(refVx) * (sim.speed_x - refVx); }
			}
			f1 = f0; f1x = f0x;
			if (Ms.length <= 9 && N <= 200) {
				for (const d0 of Ms) for (const d1 of Ms) {
					if (d1 === d0) continue;
					for (let c = 1; c < N; c++) {
						const h = hitOf((k) => (k === 0 ? pr | d0 : k < c ? d0 : d1));
						if (h && (!f1 || h < f1 || (h === f1 && Math.sign(refVx) * (sim.speed_x - refVx) > f1x))) { f1 = h; f1x = Math.sign(refVx) * (sim.speed_x - refVx); }
					}
				}
			} else f1 = -1;
			// F2 (two changes, per tick) on the plain moves F1 missed
			let f2 = f1 > 0 ? f1 : 0;
			if (plainAir && f1 === 0 && N <= 120) {
				f2 = 0;
				for (const d0 of Ms) for (const d1 of Ms) for (const d2 of Ms) {
					if (d1 === d0 || d2 === d1) continue;
					for (let c = 1; c < N; c++) for (let c2 = c + 1; c2 < N; c2++) {
						const h = hitOf((k) => (k === 0 ? pr | d0 : k < c ? d0 : k < c2 ? d1 : d2));
						if (h && (!f2 || h < f2)) f2 = h;
					}
				}
			} else if (plainAir && f1 === 0) f2 = -1;
			mv.cF2 = f2;
			let fb = 0;
			if (plainAir && (label === 'jump' || label === 'hop' || label === 'fall')) {
				const bl = [(k) => (k === 0 ? pr : 0)];
				for (const d of [2, 4]) {
					const o = d === 2 ? 4 : 2;
					for (const r of REL) bl.push((k) => (k === 0 ? pr | d : k < r ? d : 0));
					for (const t of TURN) bl.push((k) => (k === 0 ? pr | d : k < t ? d : o));
				}
				for (const fn of bl) { const h = hitOf(label === 'hop' ? (k) => fn(k + 1) & 30 : fn); if (h && (!fb || h < fb)) fb = h; }
			}
			Object.assign(mv, { N, nM: Ms.length, plainAir: plainAir ? 1 : 0, cF0: f0, cF1: f1, cF0dv: f0 ? +f0x.toFixed(4) : null, cF1dv: f1 > 0 ? +f1x.toFixed(4) : null, cB: fb });
			moves.push(mv);
			continue;
		}
		// ---- 2. the essential simplification
		let checks = 0, capped = false;
		const ok = (seq) => { if (checks >= MAX_CHECKS) { capped = true; return false; } checks++; return play(t0, seq, target); };
		let seq = Uint8Array.from(raw);
		if (!play(t0, seq, target)) { mv.bad = 1; moves.push(mv); continue; }   // (canon changed something: never expected)
		// up / down off everywhere (outside fields they are unread)
		{ const s2 = seq.map((m) => m & ~24); if (!s2.every((m, k) => m === seq[k]) && ok(s2)) seq = s2; }
		// jump bits only on the ticks where a jump happened
		{ const s2 = seq.map((m, k) => (jumpAt[t0 + k + 1] ? m | 1 : m & ~1)); if (!s2.every((m, k) => m === seq[k]) && ok(s2)) seq = s2; }
		// the direction track: merge runs into a neighbour while exact
		const dirOf = (s) => Array.from(s, (m) => m & 30);
		let changed = true;
		while (changed && !capped) {
			changed = false;
			const runs = rle(dirOf(seq));
			if (runs.length <= 1) break;
			let at = 0;
			// shortest runs first (the noise), then the rest
			const order = runs.map((r, j) => [r[1], j]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
			const starts = []; for (const r of runs) { starts.push(at); at += r[1]; }
			for (const j of order) {
				const cands = [];
				if (j > 0) cands.push(runs[j - 1][0]);
				if (j + 1 < runs.length && (j === 0 || runs[j + 1][0] !== runs[j - 1][0])) cands.push(runs[j + 1][0]);
				for (const d of cands) {
					const s2 = Uint8Array.from(seq);
					for (let k = starts[j]; k < starts[j] + runs[j][1]; k++) s2[k] = (s2[k] & 1) | d;
					if (ok(s2)) { seq = s2; changed = true; break; }
				}
				if (changed || capped) break;
			}
		}
		// the jump track: drop a jump run, else shorten it to its first tick
		{
			const jr = rle(Array.from(seq, (m) => m & 1));
			let at = 0;
			for (const [b, l] of jr) {
				if (b === 1 && !capped) {
					const s2 = Uint8Array.from(seq); for (let k = at; k < at + l; k++) s2[k] &= ~1;
					if (ok(s2)) seq = s2;
					else if (l > 1) { const s3 = Uint8Array.from(seq); for (let k = at + 1; k < at + l; k++) s3[k] &= ~1; if (ok(s3)) seq = s3; }
				}
				at += l;
			}
		}
		const druns = rle(dirOf(seq));
		const jruns = rle(Array.from(seq, (m) => m & 1));
		mv.essDirRuns = druns.length;
		mv.essJumpRuns = jruns.filter((r) => r[0] === 1).length;
		mv.essJumpLens = jruns.filter((r) => r[0] === 1).map((r) => r[1]);
		mv.essRuns = druns.map((r) => [r[0], r[1]]);
		// change points split by phase (ground before the takeoff, air after)
		let at = 0, gCh = 0, aCh = 0;
		const cps = [];
		for (let j = 0; j + 1 < druns.length; j++) { at += druns[j][1]; cps.push(at); if (takeoff >= 0 && at <= takeoff) gCh++; else aCh++; }
		mv.gChanges = gCh; mv.aChanges = aCh;
		mv.checks = checks; mv.capped = capped ? 1 : 0;
		// ---- 3. timing slack of each essential change point (+-1 tick keeps the end hash?)
		let slack0 = 0, slackAny = 0;
		if (cps.length && cps.length <= 12) {
			for (const cp of cps) {
				let any = false;
				for (const dlt of [-1, 1]) {
					const s2 = Uint8Array.from(seq);
					if (dlt === -1) { if (cp - 1 < 0) continue; s2[cp - 1] = (s2[cp - 1] & 1) | (s2[cp] & 30); } else { if (cp >= len) continue; s2[cp] = (s2[cp] & 1) | (s2[cp - 1] & 30); }
					if (play(t0, s2, target)) { any = true; break; }
				}
				if (any) slackAny++; else slack0++;
			}
		}
		mv.slack0 = slack0; mv.slackAny = slackAny;
		// ---- 4. the builder's plain macros vs per-tick shapes, from the jump press (jump moves) / walk-off (falls)
		const plainStart = c0 === 'G' && (label === 'jump' || label === 'fall' || label === 'hop') && (takeoff >= 0 || hopStart);
		if (plainStart) {
			sim.restore(snaps[t0]);
			const plainFx = !sim.has_levitation && sim.flip_gravity === 0 && sim.jump_boost === 0 && sim.speed_boost === 0 && !sim.low_gravity && !sim.is_zombie && sim.max_jumps === 1;
			mv.plainFx = plainFx ? 1 : 0;
			// a shape fn(k) over the arc; hop = 1: the arc's last tick also presses jump (the terminal hop option)
			const arcTest = (tA, airN, fn, hop) => { sim.restore(snaps[tA]); for (let k = 0; k < airN; k++) { let m = fn(k); if (hop && k === airN - 1) m |= 1; E.applyMask(inp, m); sim.tick(inp); } return sim.stateHash() === target; };
			if ((label === 'jump' && jumps === 1) || label === 'hop') {
				// jump: the arc starts at the press (k = 0 presses); hop: the press was the previous move's landing tick, the
				// arc starts after it (the macro's tail k >= 1, jump bit off)
				const sh = label === 'hop' ? 1 : 0;
				const kj = sh ? 0 : firstJump;
				const airN = len - kj, tA = t0 + kj;
				const bl = [];
				bl.push(['JUMP(-)', (k) => (k === 0 ? 1 : 0)]);
				for (const d of [2, 4]) {
					const o = d === 2 ? 4 : 2;
					for (const r of REL) bl.push([`JUMP(${d},rel${r})`, (k) => (k === 0 ? 1 | d : k < r ? d : 0)]);
					for (const t of TURN) bl.push([`JUMP(${d},turn${t})`, (k) => (k === 0 ? 1 | d : k < t ? d : o)]);
				}
				let bHit = null, bHopHit = null;
				for (const [nm, fn0] of bl) {
					const fn = sh ? (k) => fn0(k + 1) & 30 : fn0;
					if (!sh && !hopEnd && !bHit && arcTest(tA, airN, fn, 0)) bHit = nm;
					if (!bHopHit && arcTest(tA, airN, fn, hopEnd)) bHopHit = nm;
					if (bHopHit) break;
				}
				mv.builderHit = bHit; mv.builderHopHit = bHopHit;
				// per-tick shapes with <= 1 air change (+ the hop option): d0 from the press, d1 from tick c (d in {-, L, R})
				let pHit = null;
				const D = [0, 2, 4];
				const pr = sh ? 0 : 1;
				outer: for (const d0 of D) for (const d1 of D) {
					if (d1 === d0) { if (arcTest(tA, airN, (k) => (k === 0 ? pr | d0 : d0), hopEnd)) { pHit = `c0:${d0}`; break outer; } continue; }
					for (let c = 1; c < airN; c++) if (arcTest(tA, airN, (k) => (k === 0 ? pr | d0 : k < c ? d0 : d1), hopEnd)) { pHit = `c1:${d0}>${d1}@${c}`; break outer; }
				}
				mv.tick1Hit = pHit;
				mv.airN = airN;
			} else if (label === 'fall') {
				// WALKOFF(d, hold | rel) from each of the last <= 48 ground ticks (+ the hop option at the landing)
				let wHit = null, wHopHit = null;
				for (let back = 1; back <= Math.min(48, takeoff + 1) && !wHopHit; back++) {
					const tS = t0 + takeoff + 1 - back;
					for (const d of [2, 4]) {
						for (const hold of [true, false]) {
							for (const hop of [0, 1]) {
								if (hop && !hopEnd) continue;
								sim.restore(snaps[tS]);
								let air = false, okM = true;
								const N = t1 - tS;
								for (let k = 0; k < N; k++) {
									if (!air && !sim.on_ground && k > 0) air = true;
									let m = !air ? (k < 48 ? d : -1) : hold ? d : 0;
									if (m < 0) { okM = false; break; }
									if (hop && k === N - 1) m |= 1;
									E.applyMask(inp, m); sim.tick(inp);
								}
								if (okM && sim.stateHash() === target) { const nm = `WALKOFF(${d},${hold ? 'hold' : 'rel'})@-${back}`; if (!hop && !wHit) wHit = nm; if (!wHopHit) wHopHit = nm; }
							}
							if (wHopHit) break;
						}
						if (wHopHit) break;
					}
				}
				mv.builderHit = wHit; mv.builderHopHit = wHopHit;
			}
		}
		// ---- 5. support quantisation: perturb the start inside a class, replay the route's own inputs
		if (SUPPORT.has(c0) && c0 !== 'D' && len <= 600) {
			const q = {};
			const outcome = () => { const tl = T.tileOf(sim, W, H); return { tl, px: sim.px, vx: sim.speed_x, g: sim.on_ground ? 1 : 0, h: sim.stateHash() }; };
			for (const [qn, dpx, dvx] of [['px1e-9', 1e-9, 0], ['px1/64', 1 / 64, 0], ['px1/4', 0.25, 0], ['vx1/256', 0, 1 / 256], ['vx1/32', 0, 1 / 32]]) {
				sim.restore(snaps[t0]);
				sim.px += dpx; sim.prev_px += dpx; sim.speed_x += dvx;
				for (let k = 0; k < len; k++) { E.applyMask(inp, seq[k]); sim.tick(inp); }
				const o = outcome();
				// same end tile + ground flag and the same state = exact; same tile + |dpx| < 1 + |dvx| < 1/16 = class
				sim.restore(snaps[t1]);
				const ref = outcome();
				q[qn] = o.h === ref.h ? 'X' : (o.tl === ref.tl && o.g === ref.g && Math.abs(o.px - ref.px) < 1 && Math.abs(o.vx - ref.vx) < 1 / 16) ? 'c' : (o.tl === ref.tl && o.g === ref.g) ? 't' : '-';
			}
			mv.q = q;
		}
		// the start state's class numbers (for the table sizes)
		sim.restore(snaps[t0]);
		mv.px0 = sim.px; mv.py0 = sim.py; mv.vx0 = sim.speed_x; mv.vy0 = sim.speed_y;
		moves.push(mv);
	}
	// standable cells of the level (free centre tile with a solid tile below: the plain ground supports)
	let stand = 0, free = 0;
	for (let y = 0; y + 1 < H; y++) for (let x = 0; x < W; x++) {
		const a = sim._getTile(x, y), b = sim._getTile(x, y + 1);
		const fa = flags[a] || 0, fb = flags[b] || 0;
		if (!(fa & F_SOLID)) { free++; if (fb & F_SOLID) stand++; }
	}
	return { route: { idx: entry._idx, name: entry.name, source: entry.source, ticks: n, runTicks: tr.runTicks, deaths: tr.deaths, moves: moves.length, W, H, stand, free }, moves };
}

function main() {
	const all = TS.knownRoutes({});
	all.forEach((e, i) => { e._idx = i; });
	let mine = all.filter((e, i) => i % NSH === SH);
	if (argv.only) mine = mine.filter((e) => e.name.includes(argv.only));
	if (argv.limit) mine = mine.slice(0, +argv.limit);
	const fm = path.join(OUT, `moves_${SH}.jsonl`), fr = path.join(OUT, `routes_${SH}.jsonl`);
	fs.writeFileSync(fm, ''); fs.writeFileSync(fr, '');
	for (const e of mine) {
		const t0 = Date.now();
		let res = null;
		try { res = analyseRoute(e); } catch (err) { fs.appendFileSync(fr, JSON.stringify({ idx: e._idx, name: e.name, err: String(err && err.stack || err).slice(0, 300) }) + '\n'); continue; }
		if (!res) { fs.appendFileSync(fr, JSON.stringify({ idx: e._idx, name: e.name, stale: 1 }) + '\n'); continue; }
		res.route.ms = Date.now() - t0;
		fs.appendFileSync(fr, JSON.stringify(res.route) + '\n');
		fs.appendFileSync(fm, res.moves.map((m) => JSON.stringify(m)).join('\n') + (res.moves.length ? '\n' : ''));
		process.stdout.write(`${e._idx} ${e.name} moves=${res.moves.length} ${res.route.ms}ms\n`);
	}
}
main();
