'use strict';
// THE MOVEMENT TRICK CENSUS (n5-tricks, trick mining 2): every tick of the truth set's known routes (src/plan/truthset.js)
// replayed by the engine and tagged with the movement tricks the TAS uses there, from the engine's own state (no level
// names, no coordinates: general tests):
//   hop        a jump fired in the tick that LANDED (the ball airborne at the tick's start, grounded by its movement)
//   gjump      a jump from the ground (standing at the tick's start)
//   airjump    a jump fired in the air (not grounded this tick: max_jumps > 1, the jump count rising)
//   latehold   a ground jump / hop with NO x input on the press tick and an x input later in the same flight (c = the
//              ticks to it: latehold_c)
//   airrev     an x input reversal in the air (L <-> R between two airborne ticks); airrel / airpress: a release / a press
//   bonk       a rise stopped by a ceiling (vy < 0 -> 0, not grounded, no jump this tick)
//   wall       an x stop by a wall (|vx| > 0.3 -> 0 with no input against it); wallslide: airborne, pushing into the wall
//   snag       a wall stop with the box's top or bottom edge within 1 px of a tile line (the corner of a block caught)
//   clip       a diagonal tick (both axes >= 1 px) with no collision whose straight-line sweep crosses a solid tile: the
//              engine's x-then-y 1 px staircase passed a corner the straight line would hit
//   half       grounded on a half block (the box's bottom edge on a half tile's top: off the 16 px grid); halfceil /
//              halfwall: a half block met as a ceiling / a wall
//   oneway     grounded on a one-way; owthru: the box inside a one-way while rising (passing up through it)
//   rotow      a rotated one-way (the quadrant blocks) in contact (the box within 1 px)
//   heldjump   the jump bit held while airborne with no jump fired (a no-op press: the held-jump repeat)
//   multi      max_jumps > 1 (the multi-jump effect carried)
// Per move of the moves study (src/out/n4plan/understand/moves/exact_jsonl) the tags of its ticks (t0, t1]; with --bench
// (msolve_bench.js legs_*.jsonl dirs) the solve rate of the moves carrying each trick.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/tricks/mine.js [--moves=<exact_jsonl>] [--out=<file.json>] [--shard=i/n]
//        node tools/tricks/mine.js --agg=<file.json,...> [--bench=<dir,...>] [--md=<file.md>]
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
const TRICKS = ['hop', 'gjump', 'airjump', 'latehold', 'airrev', 'airrel', 'airpress', 'bonk', 'wall', 'wallslide', 'snag', 'clip', 'half', 'halfceil', 'halfwall', 'oneway', 'owthru', 'rotow', 'rotow_up', 'rotow_side', 'rotow_down', 'halfnear', 'heldjump', 'multi'];

function loadMoves(dir) {
	const byR = new Map();
	if (!dir || !fs.existsSync(dir)) return byR;
	for (const f of fs.readdirSync(dir)) {
		if (!/^moves_\d+\.jsonl$/.test(f)) continue;
		for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
			if (!line) continue;
			const m = JSON.parse(line);
			if (!byR.has(m.r)) byR.set(m.r, []);
			byR.get(m.r).push(m);
		}
	}
	for (const a of byR.values()) a.sort((p, q) => p.t0 - q.t0);
	return byR;
}

/** per-tick trick tags of a route: an array of Sets (index t = the tick t + 1's tags) */
function tagRoute(L, masks) {
	const W = L.width, H = L.height, flags = L.flags;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let jumped = false;
	sim.onEvent = (k) => { if (k === 'jump') jumped = true; };
	const fAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= H ? F_SOLID : flags[sim.tiles[cy * W + cx]] | 0);
	const solidFull = (cx, cy) => { const f = fAt(cx, cy); return (f & F_SOLID) !== 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF | F_DOOR)) === 0; };
	const boxHitsFull = (x, y) => {
		const cx0 = Math.floor(x / 16), cx1 = Math.floor((x + 15.999) / 16), cy0 = Math.floor(y / 16), cy1 = Math.floor((y + 15.999) / 16);
		for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (solidFull(cx, cy)) return true;
		return false;
	};
	const nearFlag = (x, y, bit, pad) => {
		const cx0 = Math.floor((x - pad) / 16), cx1 = Math.floor((x + 16 + pad - 0.001) / 16), cy0 = Math.floor((y - pad) / 16), cy1 = Math.floor((y + 16 + pad - 0.001) / 16);
		for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { const f = fAt(cx, cy); if ((f & F_SOLID) && (f & bit) === bit) return true; }
		return false;
	};
	// the tile rows under the box's bottom edge (a floor) / over its top edge (a ceiling), the columns beside it (a wall)
	const underFlags = (x, y) => { const cy = Math.floor((y + 16) / 16) - ((y + 16) % 16 === 0 ? 0 : 0), cx0 = Math.floor(x / 16), cx1 = Math.floor((x + 15.999) / 16); let f = 0; for (let cx = cx0; cx <= cx1; cx++) f |= fAt(cx, Math.floor((y + 15.999) / 16)) | fAt(cx, Math.floor((y + 16) / 16)); return f; };
	const tags = [];
	let prevX = 0, prevAir = false;
	const flights = [];   // open ground jumps waiting for their first x input: {t, c}
	let openJump = null;
	for (let t = 0; t < masks.length; t++) {
		const g0 = sim.on_ground && sim.speed_y === 0, air0 = !sim.on_ground, vx0 = sim.speed_x, vy0 = sim.speed_y, px0 = sim.px, py0 = sim.py;
		const m = masks[t];
		jumped = false;
		E.applyMask(inp, m);
		sim.tick(inp);
		const tg = new Set();
		if (sim.is_dead) { tags.push(tg); openJump = null; continue; }
		const grounded = sim._grounded;
		const xin = (m & 6) === 2 ? -1 : (m & 6) === 4 ? 1 : 0;
		if (sim.max_jumps > 1) tg.add('multi');
		if (jumped) {
			if (grounded && air0) tg.add('hop');
			else if (grounded || g0) tg.add('gjump');
			else tg.add('airjump');
			if (grounded || g0) openJump = xin === 0 ? { t, c: 0 } : null;
		} else if ((m & 1) && !grounded) tg.add('heldjump');
		const airNow = !grounded;
		if (openJump && airNow && !jumped && xin !== 0) { tg.add('latehold'); tg.add('latehold_' + Math.min(t - openJump.t, 30)); openJump = null; }
		if (grounded && !jumped) openJump = null;
		if (airNow && prevAir && !jumped) {
			if (prevX !== 0 && xin !== 0 && prevX !== xin) tg.add('airrev');
			else if (prevX !== 0 && xin === 0) tg.add('airrel');
			else if (prevX === 0 && xin !== 0) tg.add('airpress');
		}
		if (vy0 < 0 && sim.speed_y === 0 && !grounded && !jumped) {
			tg.add('bonk');
			if (nearFlag(sim.px, sim.py - 1, F_HALF, 0) || nearFlag(sim.px, sim.py - 1, F_ROTHALF, 0)) tg.add('halfceil');
		}
		if (Math.abs(vx0) > 0.3 && sim.speed_x === 0 && !(xin !== 0 && Math.sign(xin) !== Math.sign(vx0) && Math.abs(vx0) < 1)) {
			tg.add('wall');
			if (airNow && xin !== 0 && Math.sign(xin) === Math.sign(vx0)) tg.add('wallslide');
			const fy = sim.py - 16 * Math.floor(sim.py / 16);
			if (fy > 15 || (fy > 0 && fy < 1)) tg.add('snag');
			if (nearFlag(sim.px + Math.sign(vx0), sim.py, F_HALF, 0)) tg.add('halfwall');
		}
		// the corner clip: no collision, both axes >= 1 px, the straight line's box crosses a full solid
		const dx = sim.px - px0, dy = sim.py - py0;
		if (!sim._loopCollided && Math.abs(dx) >= 1 && Math.abs(dy) >= 1 && Math.abs(dx) < 20 && Math.abs(dy) < 20) {
			for (let k = 1; k < 32; k++) { const f = k / 32; if (boxHitsFull(px0 + dx * f, py0 + dy * f)) { tg.add('clip'); break; } }
		}
		if (grounded) {
			const fy = sim.py - 16 * Math.floor(sim.py / 16);
			const uf = underFlags(sim.px, sim.py);
			if (fy !== 0 && (uf & (F_HALF | F_ROTHALF))) tg.add('half');
			if (uf & F_JUMPTHRU) tg.add('oneway');
		}
		if (sim.speed_y < 0 || vy0 < 0) {
			const cx0 = Math.floor(sim.px / 16), cx1 = Math.floor((sim.px + 15.999) / 16), cy0 = Math.floor(sim.py / 16), cy1 = Math.floor((sim.py + 15.999) / 16);
			outer: for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { const f = fAt(cx, cy); if ((f & F_SOLID) && (f & F_JUMPTHRU) && !(f & F_ROTHALF)) { tg.add('owthru'); break outer; } }
		}
		{
			// the rotated one-ways within 1 px, by rotation (1 up = a plain one-way's floor from above; 0 / 2 side walls; 3 a
			// ceiling passable downward): msolve's solid map takes every one-way for a floor from above
			const cx0 = Math.floor((sim.px - 1) / 16), cx1 = Math.floor((sim.px + 16) / 16), cy0 = Math.floor((sim.py - 1) / 16), cy1 = Math.floor((sim.py + 16) / 16);
			for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
				const fl = fAt(cx, cy);
				if (!((fl & F_SOLID) && (fl & F_ROTHALF) && (fl & F_JUMPTHRU))) continue;
				tg.add('rotow');
				const rot = sim._lookup[cy * W + cx];
				tg.add(rot === 1 ? 'rotow_up' : rot === 3 ? 'rotow_down' : 'rotow_side');
			}
			for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
				const fl = fAt(cx, cy);
				if ((fl & F_SOLID) && (fl & F_HALF) && !(fl & F_ROTHALF)) { tg.add('halfnear'); break; }
			}
		}
		tags.push(tg);
		prevX = xin; prevAir = airNow;
	}
	return tags;
}

function main() {
	const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
	const byR = loadMoves(argv.moves || path.join(process.env.EEAT_TRUTH_ROOT || '.', 'src/out/n4plan/understand/moves/exact_jsonl'));
	const all = TS.knownRoutes({});
	const routes = [], moves = [];
	const t00 = Date.now();
	for (let r = 0; r < all.length; r++) {
		if (r % NSH !== SH) continue;
		const entry = all[r];
		const tr = TS.loadTruth(entry);
		if (!tr) { routes.push({ r, name: entry.name, stale: true }); continue; }
		const tags = tagRoute(tr.L, tr.masks);
		const cnt = {};
		for (const s of tags) for (const k of s) cnt[k] = (cnt[k] || 0) + 1;
		routes.push({ r, name: entry.name, level: entry.name.replace(/_[0-9a-f]{8}$/, ''), ticks: tr.masks.length, cnt });
		const mv = byR.get(r) || [];
		for (let mi = 0; mi < mv.length; mi++) {
			const a = mv[mi], tt = {};
			for (let t = a.t0; t < a.t1 && t < tags.length; t++) for (const k of tags[t]) if (!k.startsWith('latehold_')) tt[k] = (tt[k] || 0) + 1;
			// the move's END: a hop on its last tick is the next move's launch (counted there too)
			moves.push({ r, m: mi, label: a.label, len: a.len, tags: tt });
		}
		if (argv.verbose) process.stdout.write(`${r} ${entry.name} ${tr.masks.length} ticks ${((Date.now() - t00) / 1000).toFixed(1)}s\n`);
	}
	const out = argv.out || 'src/out/tricks/mine.json';
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, JSON.stringify({ routes, moves }));
	console.log(`routes ${routes.length}, moves ${moves.length}, ${((Date.now() - t00) / 1000).toFixed(1)} s -> ${out}`);
}

function agg() {
	const routes = [], moves = [];
	for (const f of argv.agg.split(',')) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); routes.push(...j.routes); moves.push(...j.moves); }
	const bench = new Map();
	if (argv.bench) for (const d of argv.bench.split(',')) for (const f of fs.readdirSync(d)) if (/^legs_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) if (line) { const q = JSON.parse(line); bench.set(q.r + ':' + q.m, q); }
	const live = routes.filter((r) => !r.stale);
	const levels = new Set(live.map((r) => r.level));
	const ticks = live.reduce((a, r) => a + r.ticks, 0);
	const L = [];
	L.push(`# The movement trick census: ${live.length} replayed routes (${routes.length - live.length} stale), ${levels.size} levels, ${ticks} ticks, ${moves.length} moves`);
	L.push('', '| trick | ticks | routes using | levels using | moves with it | bench legs | msolve solved | <= route | exact end | solved w/o it (same labels) |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
	for (const k of TRICKS) {
		let tk = 0, ru = 0; const lv = new Set();
		for (const r of live) { const c = r.cnt[k] || 0; tk += c; if (c) { ru++; lv.add(r.level); } }
		const mv = moves.filter((m) => m.tags[k]);
		const labs = new Set(mv.map((m) => m.label));
		const bl = mv.map((m) => bench.get(m.r + ':' + m.m)).filter(Boolean);
		const ok = bl.filter((q) => q.ok && q.verified), le = ok.filter((q) => q.T <= q.len), ex = ok.filter((q) => q.exact);
		const other = moves.filter((m) => !m.tags[k] && labs.has(m.label)).map((m) => bench.get(m.r + ':' + m.m)).filter(Boolean);
		const ook = other.filter((q) => q.ok && q.verified);
		L.push(`| ${k} | ${tk} | ${ru} | ${lv.size} | ${mv.length} | ${bl.length} | ${pct(ok.length, bl.length)} | ${pct(le.length, bl.length)} | ${pct(ex.length, bl.length)} | ${pct(ook.length, other.length)} |`);
	}
	// the late hold's delay
	const lh = {};
	for (const r of live) for (const [k, v] of Object.entries(r.cnt)) if (k.startsWith('latehold_')) lh[+k.slice(9)] = (lh[+k.slice(9)] || 0) + v;
	L.push('', 'late hold: ticks from the press to the first x input: ' + Object.entries(lh).sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}:${n}`).join(' '));
	// the unsolved bench legs by their trick tags (exclusive, first match in a fixed order)
	if (bench.size) {
		const order = ['airjump', 'half', 'halfceil', 'halfwall', 'halfnear', 'rotow_side', 'rotow_down', 'oneway', 'owthru', 'rotow', 'clip', 'snag', 'wallslide', 'wall', 'bonk', 'airrev', 'latehold', 'hop'];
		const ex = new Map(); let n = 0;
		for (const m of moves) {
			const q = bench.get(m.r + ':' + m.m);
			if (!q || (q.ok && q.verified)) continue;
			n++;
			let k = 'none'; for (const o of order) if (m.tags[o]) { k = o; break; }
			const key = `${k} (${['hop', 'jump', 'fall', 'walk'].includes(m.label) ? 'plain' : m.label})`;
			ex.set(key, (ex.get(key) || 0) + 1);
		}
		L.push('', `unsolved bench legs ${n}, by their first trick tag (${order.join(' > ')}) and move class:`, Array.from(ex.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
	}
	// the levels by trick (the routes' counts)
	L.push('', '| level | ticks | ' + TRICKS.join(' | ') + ' |', '|---|---:|' + TRICKS.map(() => '---:').join('|') + '|');
	const byLv = new Map();
	for (const r of live) { const o = byLv.get(r.level) || { ticks: 0, cnt: {} }; o.ticks = Math.max(o.ticks, r.ticks); for (const [k, v] of Object.entries(r.cnt)) o.cnt[k] = Math.max(o.cnt[k] || 0, v); byLv.set(r.level, o); }
	for (const [lv, o] of Array.from(byLv.entries()).sort((a, b) => a[0].localeCompare(b[0]))) L.push(`| ${lv.replace(/\.eelvl$/, '')} | ${o.ticks} | ` + TRICKS.map((k) => o.cnt[k] || 0).join(' | ') + ' |');
	const txt = L.join('\n');
	if (argv.md) fs.writeFileSync(argv.md, txt + '\n');
	console.log(txt.split('\n').slice(0, 40).join('\n'));
}

if (argv.agg) agg(); else main();
