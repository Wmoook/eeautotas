'use strict';
// The exact endgame solver (src/endgame.js), CPU only, one thread:
//   bound    the lower bound never overestimates: rooms with every kind of block (arrows, dots, liquids, ice, boosts,
//            portals, half blocks, one-ways, ladders, doors, spikes, effects); from states along sticky random walks, the
//            cell the centre is in after j ticks of another walk, taken as the goal, must get a bound <= j; also long
//            climbing walks (jump pressed every tick, stairs / stacked one-ways / corridors, up to 150 ticks)
//   exhaust  small rooms with a trophy: the branch and bound finds the same fastest finish (or none) as the same search
//            without cuts, from states along random walks
//   masks    the masks the search does not play give the same state as one it plays (all 18, on many states)
//   ladder   a corridor with a slow reference: a faster exact run found and judged, finds become starts, a copy of a
//            start shares its outcome, a give-up at the open-state cap tries the K in between
//   jobs     (when the jobs folder has jobs: EEAT_HOME or src/jobs) the bound along every job's best and original run
//            (every tick of the last 300, every 13th before) is at most the ticks the run really takes; 213 (the remake
//            job): from OC's run (original.eetas)
//            the K = 29 search finds 2.35, checked with C.evaluate and C.judge
// usage: node test/endgame.js [--only=bound|exhaust|masks|ladder|jobs] [--seed=1]        Exit code 1 if any check fails.
const fs = require('fs');
const path = require('path');
const E = require('../src/eesim.js');
const EL = require('../src/eelvl.js');
const ED = require('../src/editor.js');
const C = require('../src/common.js');
const EG = require('../src/endgame.js');

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
let seed = +((argv.find((a) => a.startsWith('--seed=')) || '').slice(7) || 1);
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const ri = (n) => Math.floor(rnd() * n);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };
const section = (s) => console.log(`\n== ${s}`);
const room = (W, H) => { const c = []; for (let x = 0; x < W; x++) c.push([x, 0, 9], [x, H - 1, 9]); for (let y = 1; y < H - 1; y++) c.push([0, y, 9], [W - 1, y, 9]); return c; };
const levelOf = (W, H, cells, gravity) => E.prepareLevel(EL.toSimLevel(EL.readEelvl(ED.eelvlOf({ name: 't', width: W, height: H, cells, gravity }))));

// block palettes: every kind the bound treats differently (int args: effect strength, half-block / one-way rotation)
const PLAIN = [9, 9, 9, 9, 9, 361, 1052, 1041, 23, 6, 100];
const SPECIAL = [4, 4, 1, 2, 3, 1518, 119, 369, 416, 1064, 114, 115, 116, 117, 120, 417, 418, 419, 453, 461, 1517, 420];
function cellOf(x, y, id) {
	const k = EL.argKind(id);
	if (k !== 'int') return [x, y, id];
	if (id === 461) return [x, y, id, 2 + ri(2)];            // multijump: 2-3 jumps
	if (id === 1517) return [x, y, id, 1 + ri(3)];           // gravity effect: rotated
	if (id === 1052 || id === 1041) return [x, y, id, ri(4)];   // rotations
	if (id === 419) return [x, y, id, 1 + ri(2)];            // speed effect: fast / slow
	return [x, y, id, 1];
}
/** a random room: plain blocks, (special ? special blocks : none), maybe a portal pair, a spawn; the cells */
function randomRoom(W, H, special, portals) {
	const cells = room(W, H);
	const used = new Set();
	for (let y = 1; y < H - 1; y++) {
		for (let x = 1; x < W - 1; x++) {
			if (x <= 2 && y >= H - 3) continue;   // room around the spawn
			const r = rnd();
			if (r < 0.14) { cells.push(cellOf(x, y, PLAIN[ri(PLAIN.length)])); used.add(y * W + x); } else if (special && r < 0.22) { cells.push(cellOf(x, y, SPECIAL[ri(SPECIAL.length)])); used.add(y * W + x); }
		}
	}
	if (portals) {
		const free = () => { for (;;) { const x = 3 + ri(W - 6), y = 1 + ri(H - 3); if (!used.has(y * W + x)) { used.add(y * W + x); return [x, y]; } } };
		const a = free(), b = free();
		cells.push([a[0], a[1], 242, ri(4), 1, 2], [b[0], b[1], 242, ri(4), 2, 1]);
	}
	cells.push([1, H - 2, 255]);
	return cells;
}
/** a sticky random walk: the mask changes with probability p per tick */
function walker(p) { let m = 0; return () => { if (rnd() < p) m = [0, 1, 2, 3, 4, 5, 8, 16, 9, 17, 4, 5, 2, 3][ri(14)] | (rnd() < 0.08 ? 8 : 0); return m; }; }
/** the extremes the bound is tight on: one mask held, or a jump every n-th tick while holding a direction */
function extremeWalker() {
	const k = ri(3);
	if (k === 0) { const m = [4, 2, 5, 3, 1, 0, 8, 16, 12, 20, 10, 18, 13, 21, 9, 17][ri(16)]; return () => m; }
	const h = [0, 2, 4][ri(3)] | [0, 8, 16][ri(3)], n = 1 + ri(4);
	let t = 0;
	return () => ((t++ % n) === 0 ? h | 1 : h);
}

// ---------------------------------------------------------------- bound
function boundSection() {
	section('bound: never more than the ticks a real walk takes to a goal cell');
	let checks = 0, bad = 0, rooms = 0, firstBad = '', tight = 0;
	const t0 = Date.now();
	for (let k = 0; k < 60 && Date.now() - t0 < 40000; k++) {
		const W = 14 + ri(14), H = 10 + ri(10);
		const L = levelOf(W, H, randomRoom(W, H, k % 4 !== 0, k % 3 === 0), k % 5 === 4 ? [0.5, 2, 0.2][ri(3)] : undefined);
		rooms++;
		const Bs = new Map();
		const Bof = (cell) => { let b = Bs.get(cell); if (!b) { b = EG.boundContext(L, { goals: [cell] }); Bs.set(cell, b); } return b; };
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let s = 0; s < 6; s++) {
			sim.reset();
			const w0 = walker(0.2), n0 = ri(250);
			let ok = true;
			for (let t = 0; t < n0; t++) { E.applyMask(inp, w0()); sim.tick(inp); if (sim.is_dead) { ok = false; break; } }
			if (!ok) continue;
			const S = sim.snapshot();
			for (let r = 0; r < 16; r++) {
				sim.restore(S);
				const w = r % 2 ? extremeWalker() : walker(0.1 + 0.3 * rnd());
				const goals = [];
				for (let j = 1; j <= 40; j++) {
					E.applyMask(inp, w()); sim.tick(inp);
					if (sim.is_dead) break;
					goals.push([j, Math.floor((sim.px + 8) / 16), Math.floor((sim.py + 8) / 16)]);
				}
				for (const [j, cx, cy] of goals) {
					if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
					if (rnd() > 0.35) continue;
					sim.restore(S);
					const lb = EG.lowerBound(Bof(cy * W + cx), sim, j + 2);
					checks++;
					if (lb >= j - 1 && j >= 4) tight++;
					if (lb > j) { bad++; if (!firstBad) firstBad = `room ${k} (${W}x${H}) start ${s}: bound ${lb} > ${j} ticks to cell (${cx}, ${cy}) from (${(sim.px / 16).toFixed(2)}, ${(sim.py / 16).toFixed(2)}) v (${sim.speed_x.toFixed(2)}, ${sim.speed_y.toFixed(2)})`; }
				}
			}
		}
	}
	check(`${checks} checks in ${rooms} rooms: the bound is at most the real ticks`, bad === 0 && checks > 1000,
		bad ? `${bad} too high; first: ${firstBad}` : `${tight} within 1 tick of the real walk (j >= 4), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	deepBound();
}
/** long walks (up to 150 ticks) that climb as fast as the jump rules let them (jump pressed every tick, a direction
 *  held) through stairs, stacked one-ways and corridors, some rooms with another world gravity: the rise model */
function deepBound() {
	let checks = 0, bad = 0, rooms = 0, firstBad = '', tight = 0;
	const t0 = Date.now();
	for (let k = 0; k < 300 && Date.now() - t0 < 20000; k++) {
		const W = 12 + ri(24), H = 12 + ri(24);
		const cells = room(W, H), used = new Set();
		const put = (x, y, id) => { if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || used.has(y * W + x)) return; used.add(y * W + x); cells.push(cellOf(x, y, id)); };
		const style = k % 9;
		if (style === 8) {        // portal networks: pairs, chains, several portals with one id (random exits), invisible
			for (let p = 0; p < 2 + ri(9); p++) {
				const x = 1 + ri(W - 2), y = 1 + ri(H - 2);
				if (used.has(y * W + x) || (x === 1 && y === H - 2)) continue;
				used.add(y * W + x);
				const id = 1 + ri(5);
				cells.push([x, y, rnd() < 0.8 ? 242 : 381, ri(4), id, ri(3) ? (id % 5) + 1 : 1 + ri(5)]);
			}
			for (let x = 2; x < 6; x++) if (rnd() < 0.5 && !used.has((H - 2) * W + x)) { used.add((H - 2) * W + x); cells.push([x, H - 2, 242, ri(4), 1 + ri(5), 1 + ri(5)]); }
			for (let i = 0; i < W * H / 25; i++) put(1 + ri(W - 2), 1 + ri(H - 2), 9);
		} else if (style === 4) { // boost lanes and columns: 16 px/tick, the speed limit's worst case
			const y = 2 + ri(H - 4), x = 2 + ri(W - 4), d = ri(4);
			for (let i = 1; i < W - 1; i++) put(i, y, d === 1 ? 114 : 115);
			for (let i = 1; i < H - 1; i++) put(x, i, d === 2 ? 116 : 117);
		} else if (style === 5) { // portals on the floor the walks cross (entries close to the start), exits anywhere
			for (let p = 0; p < 3; p++) {
				const a = [2 + ri(6), H - 2 - ri(2)], b = [1 + ri(W - 2), 1 + ri(H - 2)];
				if (used.has(a[1] * W + a[0]) || used.has(b[1] * W + b[0]) || (a[0] === b[0] && a[1] === b[1])) continue;
				used.add(a[1] * W + a[0]); used.add(b[1] * W + b[0]);
				cells.push([a[0], a[1], 242, ri(4), 20 + 2 * p, 21 + 2 * p], [b[0], b[1], 242, ri(4), 21 + 2 * p, 20 + 2 * p]);
			}
			for (let i = 0; i < W * H / 30; i++) put(1 + ri(W - 2), 1 + ri(H - 4), 9);
		} else if (style === 6) { // effects and special tiles on the floor, platforms above (touched, then climbed from)
			for (let x = 3; x < W - 1; x++) if (rnd() < 0.5) put(x, H - 2, [417, 417, 461, 453, 1517, 418, 419, 1064, 4, 1, 3, 119, 420][ri(13)]);
			for (let y = H - 5; y > 1; y -= 2 + ri(3)) for (let x = 1; x < W - 1; x++) if (rnd() < 0.5) put(x, y, [9, 61, 1041][ri(3)]);
		} else if (style === 7) { // half-block stairs and floors
			for (let x = 3; x < W - 1; x++) { const hh = Math.min(H - 3, 1 + ((x - 3) >> 1)); for (let y = H - 1 - hh; y < H - 1; y++) put(x, y, y === H - 1 - hh ? 1041 : 9); }
		} else if (style === 0) { // stairs with ceilings
			let h = 1;
			for (let x = 3; x < W - 1; x++) { if (rnd() < 0.5) h = Math.min(H - 4, h + 1 + ri(3)); for (let y = H - 1 - h; y < H - 1; y++) put(x, y, 9); if (rnd() < 0.3) put(x, H - 3 - h - ri(3), 9); }
		} else if (style === 1) { // stacked one-ways and platforms
			for (let y = H - 3; y > 1; y -= 1 + ri(4)) for (let x = 1; x < W - 1; x++) if (rnd() < 0.7) put(x, y, [61, 61, 1052, 9, 1041][ri(5)]);
		} else if (style === 2) { // corridors
			for (let y = H - 3; y > 2; y -= 2 + ri(2)) for (let x = 1; x < W - 1; x++) if (rnd() < 0.85) put(x, y, 9);
		} else {                  // sparse blocks: long falls and runs
			for (let i = 0; i < W * H / 25; i++) put(1 + ri(W - 2), 1 + ri(H - 2), 9);
		}
		cells.push([1, H - 2, 255]);
		const L = levelOf(W, H, cells, k % 3 === 2 ? [0.2, 0.5, 1.5, 3][ri(4)] : undefined);
		rooms++;
		const Bs = new Map();
		const Bof = (c) => { let b = Bs.get(c); if (!b) { b = EG.boundContext(L, { goals: [c] }); Bs.set(c, b); } return b; };
		const sim = new E.EESim(L), inp = new E.EEInput();
		// the starts: after a random walk, or (5, 6, 7) every other tick of a run to the right from the spawn (through the
		// portal entries: some starts are in a trigger cell)
		const roots = [];
		sim.reset();
		if (style >= 5) {
			for (let t = 0; t < 30 && !sim.is_dead; t++) { if (t % 2 === 0) roots.push(sim.snapshot()); E.applyMask(inp, 4); sim.tick(inp); }
		} else {
			const w0 = walker(0.15), n0 = ri(300);
			let ok = true;
			for (let t = 0; t < n0; t++) { E.applyMask(inp, w0()); sim.tick(inp); if (sim.is_dead) { ok = false; break; } }
			if (ok) roots.push(sim.snapshot());
		}
		for (let r = 0; r < 6 * roots.length; r++) {
			const S = roots[r % roots.length];
			if (roots.length > 1 && r >= 2 * roots.length) break;   // (many starts: 2 walks each)
			sim.restore(S);
			const dir = [4, 2, 0, 12, 10, 20][ri(6)];
			let mm = dir;
			const w = r % 2 ? () => dir | 1 : () => { if (rnd() < 0.08) mm = [4, 2, 0, 8, 16, 12, 10][ri(7)]; return mm | 1; };
			const first = new Map();
			for (let j = 1; j <= 150; j++) {
				E.applyMask(inp, w()); sim.tick(inp);
				if (sim.is_dead) break;
				const cx = Math.floor((sim.px + 8) / 16), cy = Math.floor((sim.py + 8) / 16);
				if (cx >= 0 && cy >= 0 && cx < W && cy < H && !first.has(cy * W + cx)) first.set(cy * W + cx, j);
			}
			for (const [c, j] of first) {
				sim.restore(S);
				const lb = EG.lowerBound(Bof(c), sim, j + 2);
				checks++;
				if (lb >= j - 1) tight++;
				if (lb > j) { bad++; if (!firstBad) firstBad = `room ${k} (${W}x${H}, style ${style}): bound ${lb} > ${j} ticks to cell (${c % W}, ${Math.floor(c / W)})`; }
			}
		}
	}
	check(`${checks} checks in ${rooms} rooms, climbing walks of up to 150 ticks: the bound is at most the real ticks`, bad === 0 && checks > 1000,
		bad ? `${bad} too high; first: ${firstBad}` : `${tight} within 1 tick, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- exhaust
function exhaustSection() {
	section('exhaust: the same fastest finish with and without the cuts');
	let same = 0, diff = 0, skipped = 0, found = 0, firstDiff = '';
	let cutTicks = 0, fullTicks = 0;
	const t0 = Date.now();
	for (let k = 0; k < 400 && same + diff < 60 && Date.now() - t0 < 45000; k++) {
		const W = 12 + ri(8), H = 8 + ri(6);
		const cells = randomRoom(W, H, k % 3 !== 0, k % 4 === 1);
		// a walk from the spawn; the trophy goes into an empty cell the walk reaches a few ticks after a chosen tick
		const L0 = levelOf(W, H, cells);
		const sim0 = new E.EESim(L0), inp = new E.EEInput();
		sim0.reset();
		const w = walker(0.2), masks = [], cellsAt = [];
		for (let t = 0; t < 200; t++) {
			const m = w(); masks.push(m); E.applyMask(inp, m); sim0.tick(inp);
			if (sim0.is_dead) break;
			cellsAt.push([Math.floor((sim0.px + 8) / 16), Math.floor((sim0.py + 8) / 16)]);
		}
		if (cellsAt.length < 30) { skipped++; continue; }
		const T = 10 + ri(cellsAt.length - 20), d = 3 + ri(7);
		if (T + d >= cellsAt.length) { skipped++; continue; }
		const [gx, gy] = cellsAt[T + d - 1];
		if (L0.fg[gy * W + gx] !== 0 || cellsAt.slice(0, T + 1).some(([x, y]) => x === gx && y === gy)) { skipped++; continue; }
		const L = levelOf(W, H, cells.concat([[gx, gy, 121]]));
		const sim = new E.EESim(L);
		sim.reset();
		let ok = true;
		for (let t = 0; t < T; t++) { E.applyMask(inp, masks[t]); sim.tick(inp); if (sim.is_dead || sim.has_silver_crown) { ok = false; break; } }
		if (!ok) { skipped++; continue; }
		const S = sim.snapshot();
		const B = EG.boundContext(L);
		const maxDepth = Math.min(k % 2 ? d : d + 1, 9);   // (the walk finishes at d + 1: d = only a faster finish counts)
		const a = EG.search(sim, S, maxDepth, { B, cap: 400000, noBound: true });
		if (a.status !== 'found' && a.status !== 'proof') { skipped++; continue; }
		const b = EG.search(sim, S, maxDepth, { B, cap: 400000 });
		fullTicks += a.stats.ticks; cutTicks += b.stats.ticks;
		const ra = a.status === 'found' ? a.depth : 'none', rb = b.status === 'found' ? b.depth : 'none';
		if (ra === rb) { same++; if (ra !== 'none') found++; } else { diff++; if (!firstDiff) firstDiff = `room ${k}: without cuts ${ra}, with cuts ${rb} (${b.status})`; }
		// the tail found is a real finish at that depth
		if (b.status === 'found') {
			sim.restore(S);
			let fin = -1;
			for (let t = 0; t < b.tail.length; t++) { E.applyMask(inp, b.tail[t]); sim.tick(inp); if (sim.has_silver_crown) { fin = t + 1; break; } }
			if (fin !== b.depth) { diff++; if (!firstDiff) firstDiff = `room ${k}: the tail finishes at ${fin}, not ${b.depth}`; }
		}
	}
	check(`${same + diff} searches (${found} with a finish, ${same - found} proofs): the same answer with and without the cuts`, diff === 0 && same >= 20,
		diff ? firstDiff : `${skipped} rooms skipped; ${fullTicks} ticks without cuts, ${cutTicks} with (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------------------------------------------------------------- masks
function masksSection() {
	section('masks: the masks not played give the state of one that is');
	let states = 0, bad = 0, firstBad = '', reduced = 0;
	const t0 = Date.now();
	for (let k = 0; k < 30; k++) {
		const W = 14 + ri(10), H = 10 + ri(8);
		const L = levelOf(W, H, randomRoom(W, H, true, k % 2 === 0));
		const sim = new E.EESim(L), inp = new E.EEInput();
		for (let s = 0; s < 4; s++) {
			sim.reset();
			const w = walker(0.2), n = s === 0 ? 0 : ri(300);   // (s = 0: before the run timer starts)
			let ok = true;
			for (let t = 0; t < n; t++) { E.applyMask(inp, w()); sim.tick(inp); if (sim.is_dead) { ok = false; break; } }
			if (!ok) continue;
			for (let q = 0; q < 25; q++) {
				E.applyMask(inp, w()); sim.tick(inp);
				if (sim.is_dead) break;
				const S = sim.snapshot();
				const list = EG.probeMasks(sim, inp, S);
				const probeHash = sim.stateHash();
				const hash = new Map();
				for (let m = 0; m < 32; m++) {
					if ((m & 6) === 6 || (m & 24) === 24) continue;   // (left + right and up + down cancel: not one of the 18)
					sim.restore(S); E.applyMask(inp, m); sim.tick(inp); hash.set(m, sim.stateHash());
				}
				const hs = list.length > 2 && list.includes(2), vs = list.includes(8);
				const canon = (m) => (hs ? m & 7 : m & 1) | (vs ? m & 24 : 0);
				states++;
				if (list.length < 18) reduced++;
				if (hash.get(list[0]) !== probeHash) { bad++; if (!firstBad) firstBad = 'the probe state is not its mask\'s'; }
				for (const [m, h] of hash) if (!list.includes(canon(m)) || hash.get(canon(m)) !== h) { bad++; if (!firstBad) firstBad = `mask ${m} vs ${canon(m)} (list ${[...list]})`; }
				sim.restore(S);
			}
		}
	}
	check(`${states} states (${reduced} with fewer than 18 masks): every mask's state is one the search plays`, bad === 0 && states > 500 && reduced > 0,
		bad ? firstBad : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
	const hs = new EG.HashSet(4);
	let okSet = true;
	const vals = [];
	for (let i = 0; i < 5000; i++) vals.push(Math.floor(rnd() * 9007199254740991));
	for (const v of vals) if (!hs.add(v)) okSet = false;
	for (const v of vals) if (hs.add(v)) okSet = false;
	check('the hash set: adds each value once, grows', okSet && hs.size === 5000, hs.size);
}

// ---------------------------------------------------------------- ladder
function ladderSection() {
	section('ladder: K ladder over starts, finds become starts, shared outcomes, midpoints after a give-up');
	const W = 40, H = 9;
	const L = levelOf(W, H, room(W, H).concat([[1, H - 2, 255], [24, H - 2, 121]]));
	// the reference: right with an idle tick in every 4 (a slow run along a corridor)
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const ref = [];
	for (let t = 0; t < 1000 && !sim.has_silver_crown; t++) { const m = t % 4 === 3 ? 0 : 4; ref.push(m); E.applyMask(inp, m); sim.tick(inp); }
	const refEv = C.evaluate(L, Uint8Array.from(ref));
	const ev1 = [];
	const r = EG.ladder(L, [{ name: 'ref', masks: Uint8Array.from(ref) }, { name: 'copy', masks: Uint8Array.from(ref) }], { K: 24, seconds: 30, log: (o) => ev1.push(o) });
	const ev = C.evaluate(L, r.masks), v = ev ? C.judge(ev, refEv, refEv.deaths) : null;
	check('finds a faster run, exact and accepted by the rule', refEv && r.found.length > 0 && ev && ev.runTicks === r.best && r.best < refEv.runTicks && v.accept,
		`${refEv && refEv.runTicks} -> ${r.best} ticks, ${r.searches} searches`);
	check('a find becomes a start', ev1.some((o) => o.event === 'search' && /^found/.test(o.start)));
	check('a start at the same state and K as one searched before shares its outcome', !ev1.some((o) => o.event === 'search' && o.start === 'copy'));
	const Ks = [];
	const r2 = EG.ladder(L, [{ name: 'ref', masks: Uint8Array.from(ref) }], { K: 24, seconds: 30, cap: 20, log: (o) => { if (o.event === 'search') Ks.push(o.K); } });
	check('a give-up at the open-state cap: the K between the last proof and it are tried', r2.gaveUp.length > 0 && r2.gaveUp.every((g) => g.reason === 'cap') &&
		Ks[0] === 8 && Ks[1] === 16 && Ks.includes(12) && !Ks.includes(24), `K tried: ${Ks.join(', ')}`);
	// a search whose finishes are all refused runs out of states with finishes counted (the ladder then reports
	// `rejected`, not a proof that nothing is faster)
	const f = r.found[0];
	sim.reset();
	for (let t = 0; t < f.T; t++) { E.applyMask(inp, ref[t]); sim.tick(inp); }
	const q = EG.search(sim, sim.snapshot(), f.maxDepth, { B: EG.boundContext(L), deadline: Date.now() + 30000, accept: () => false });
	check('refused finishes are counted, not a plain proof', q.status === 'proof' && q.stats.finishes > 0, `${q.status}, ${q.stats.finishes} finishes refused`);
}

// ---------------------------------------------------------------- jobs
function jobsSection() {
	section(`jobs (${C.JOBS})`);
	const ids = C.jobIds();
	if (!ids.length) { console.log('  (no jobs)'); return; }
	let checks = 0, bad = 0, firstBad = '';
	const t0 = Date.now();
	for (const id of ids) {
		const L = E.loadLevel(path.join(C.DATA, C.jobLevelId(id) + '.json'));
		const B = EG.boundContext(L);
		for (const run of ['best.eetas', 'original.eetas']) {
			const f = path.join(C.JOBS, id, run);
			if (!fs.existsSync(f)) continue;
			const masks = C.readEetas(f);
			const F = C.replay(L, masks).complete;
			if (F < 0) continue;
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			for (let t = 0; t < F; t++) {
				// every tick of the last 300, every 13th before (the portal field and the tiers along the whole level)
				if ((t >= F - 300 || t % 13 === 0) && !sim.is_dead) {
					const left = F - 1 - t;   // the centre is in the trophy cell after tick F - 1
					const lb = EG.lowerBound(B, sim, Math.min(left + 1, 250));
					checks++;
					if (lb > left) { bad++; if (!firstBad) firstBad = `${id} ${run} tick ${t}: bound ${lb} > ${left}`; }
				}
				E.applyMask(inp, masks[t]); sim.tick(inp);
			}
		}
	}
	check(`${checks} states along ${ids.length} jobs' runs: the bound is at most the ticks left`, bad === 0, bad ? firstBad : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
	const oc = ids.find((i) => i.startsWith('213-remake'));
	if (!oc) { console.log('  (no 213-remake job)'); return; }
	const L = E.loadLevel(path.join(C.DATA, C.jobLevelId(oc) + '.json'));
	const orig = C.readEetas(path.join(C.JOBS, oc, 'original.eetas'));
	const ref = C.evaluate(L, orig);
	const r = EG.ladder(L, [{ name: 'original.eetas', masks: orig }], { K: [29], seconds: 55 });
	const ev = r.found.length ? C.evaluate(L, r.masks) : null;
	const v = ev ? C.judge(ev, ref, ref.deaths) : null;
	check('213: from OC\'s run (2.36) the K = 29 search finds 2.35, accepted by the rule', ref.runTicks === 236 && ev && ev.runTicks === 235 && v.accept && v.saved === 1 && ev.deaths === 0,
		ev ? `${ev.runTicks} ticks, ${r.found[0].ticks} simulated in ${r.found[0].seconds} s` : JSON.stringify(r.gaveUp));
	const p = r.found.length ? EG.ladder(L, [{ name: 'found', masks: r.masks }], { K: [24], seconds: 30 }) : null;
	check('213: from the 2.35 run nothing faster starts at its tick F - 24 (proof)', p && p.proofs.length === 1 && p.found.length === 0, p ? `${p.proofs.length} proofs, ${p.ticks} ticks` : '-');
}

const t0 = Date.now();
if (!ONLY || ONLY === 'masks') masksSection();
if (!ONLY || ONLY === 'bound') boundSection();
if (!ONLY || ONLY === 'exhaust') exhaustSection();
if (!ONLY || ONLY === 'ladder') ladderSection();
if (!ONLY || ONLY === 'jobs') jobsSection();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
