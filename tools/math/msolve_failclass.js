'use strict';
// WHAT THE PLAIN TIER MISSES (n4-math, the coverage iteration 2): the bench records (msolve_air.js air_*.jsonl or
// msolve_bench.js legs_*.jsonl) replayed along the ROUTE's own inputs, each leg tagged by the events the route's
// ball meets inside it: landings, air jumps, ceiling bonks, wall stops, half blocks, one-ways, a standing start off
// the 16 px grid, field tiles; the tag counts over the solved and the unsolved legs side by side (the classes left).
// Usage: EEAT_TRUTH_ROOT=<root> node tools/math/msolve_failclass.js --moves=<exact_jsonl> --res=<dir> --kind=air|bench
//          [--arm=on] [--out=<file.jsonl>] [--shard=i/n] [--plainOnly=1]
//        node tools/math/msolve_failclass.js --agg=<file.jsonl ...,>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8;
const PLAIN = new Set(['hop', 'jump', 'fall', 'walk']);

if (argv.agg) { agg(argv.agg.split(',')); process.exit(0); }

function loadMoves(dir) {
	const byR = new Map();
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
function loadRes(dir) {
	const out = [];
	for (const f of fs.readdirSync(dir)) if (/^(air|legs)_\d+\.jsonl$/.test(f)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
	return out;
}

function main() {
	const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
	const byR = loadMoves(argv.moves);
	const res = loadRes(argv.res);
	const kind = argv.kind || 'air', arm = argv.arm || 'on';
	const all = TS.knownRoutes({});
	const byRes = new Map();
	for (const q of res) { if (q.r % NSH !== SH) continue; if (!byRes.has(q.r)) byRes.set(q.r, []); byRes.get(q.r).push(q); }
	const outF = fs.openSync(argv.out || `failclass_${SH}.jsonl`, 'w');
	for (const [r, qs] of byRes) {
		const entry = all[r];
		const tr = entry && TS.loadTruth(entry);
		if (!tr) continue;
		const { L, masks } = tr;
		const moves = byR.get(r);
		if (!moves) continue;
		const W = L.width, Hh = L.height, flags = L.flags;
		const legs = [];
		for (const q of qs) {
			const a = moves[q.m];
			if (!a) continue;
			const span = kind === 'air' ? [a, moves[q.m + 1]] : [a];
			if (span.some((m) => !m)) continue;
			const plain = span.every((m) => PLAIN.has(m.label) && !(m.liquid || m.climb || m.dot || m.boost || m.arrow));
			if (argv.plainOnly === '1' && !plain) continue;
			const t0 = kind === 'air' ? a.t0 + (a.len >> 1) : a.t0, t1 = span[span.length - 1].t1;
			const ok = kind === 'air' ? !!(q[arm] && q[arm].ok && q[arm].verified) : !!(q.ok && q.verified);
			const why = kind === 'air' ? (q[arm] && q[arm].why) : q.why;
			legs.push({ q, t0, t1, ok, why, plain, labels: span.map((m) => m.label).join('>') });
		}
		if (!legs.length) continue;
		const byT0 = new Map();
		for (const l of legs) { if (!byT0.has(l.t0)) byT0.set(l.t0, []); byT0.get(l.t0).push(l); }
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		// one pass over the route: the per-tick event record, then each leg reads its window
		const ev = [];
		const tileF = (cx, cy) => { if (cx < 0 || cy < 0 || cx >= W || cy >= Hh) return 0; return flags[L.fg[cy * W + cx]] | 0; };
		const near = (x, y, bit) => {
			const cx0 = Math.floor((x - 1) / 16), cx1 = Math.floor((x + 16) / 16), cy0 = Math.floor((y - 1) / 16), cy1 = Math.floor((y + 16) / 16);
			for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (tileF(cx, cy) & bit) return true;
			return false;
		};
		// a blocking tile (solid, not a one-way) over the box's top edge
		const ceil = (x, y) => {
			const cy = Math.floor((y - 1) / 16), cx0 = Math.floor(x / 16), cx1 = Math.floor((x + 15.999) / 16);
			for (let cx = cx0; cx <= cx1; cx++) { const f = tileF(cx, cy); if ((f & F_SOLID) && !(f & F_JUMPTHRU)) return true; }
			return cy < 0;
		};
		for (let t = 0; t < masks.length; t++) {
			const g0 = sim.on_ground, vx0 = sim.speed_x, vy0 = sim.speed_y, jc0 = sim.jump_count;
			E.applyMask(inp, masks[t]);
			sim.tick(inp);
			const e = {
				land: !g0 && sim.on_ground ? 1 : 0,
				jump: vy0 - sim.speed_y > 1 ? 1 : 0,
				air: sim.jump_count > jc0 && jc0 >= 1 ? 1 : 0,
				bonk: vy0 < 0 && sim.speed_y === 0 && !sim.on_ground && ceil(sim.px, sim.py) ? 1 : 0,
				wall: Math.abs(vx0) > 0.3 && sim.speed_x === 0 ? 1 : 0,
				half: near(sim.px, sim.py, F_HALF | F_ROTHALF) ? 1 : 0,
				oneway: near(sim.px, sim.py, F_JUMPTHRU) ? 1 : 0,
				offgrid: sim.on_ground && sim.speed_y === 0 && sim.py !== Math.round(sim.py / 16) * 16 ? 1 : 0,
				dead: sim.is_dead ? 1 : 0,
				m: masks[t],
			};
			ev.push(e);
		}
		for (const l of legs) {
			const tags = {};
			let xch = 0, prevX = -1;
			for (let t = l.t0; t < l.t1 && t < ev.length; t++) {
				const e = ev[t];
				for (const k of ['land', 'jump', 'air', 'bonk', 'wall', 'half', 'oneway', 'offgrid', 'dead']) if (e[k]) tags[k] = (tags[k] || 0) + 1;
				const xm = e.m & 6;
				if (prevX >= 0 && xm !== prevX) xch++;
				prevX = xm;
			}
			// the start standing off the grid (a half block / one-way top)
			if (l.t0 > 0 && ev[l.t0 - 1] && ev[l.t0 - 1].offgrid) tags.start_offgrid = 1;
			const rec = { r, m: l.q.m, labels: l.labels, len: l.t1 - l.t0, ok: l.ok, why: l.why, plain: l.plain, xch, tags };
			fs.writeSync(outF, JSON.stringify(rec) + '\n');
		}
	}
	fs.closeSync(outF);
}

function agg(files) {
	const recs = [];
	for (const f of files) {
		const st = fs.statSync(f);
		const list = st.isDirectory() ? fs.readdirSync(f).filter((n) => /^failclass_\d+\.jsonl$/.test(n)).map((n) => path.join(f, n)) : [f];
		for (const g of list) for (const line of fs.readFileSync(g, 'utf8').split('\n')) if (line) recs.push(JSON.parse(line));
	}
	const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
	for (const sel of [['plain', (r) => r.plain], ['all', () => true]]) {
		const g = recs.filter(sel[1]);
		const ok = g.filter((r) => r.ok), bad = g.filter((r) => !r.ok);
		console.log(`== ${sel[0]}: ${g.length} legs, solved ${ok.length} (${pct(ok.length, g.length)}%), unsolved ${bad.length}`);
		const cnt = (a, f) => a.filter(f).length;
		const rows = [
			['lands>=2', (r) => (r.tags.land || 0) >= 2], ['lands>=3', (r) => (r.tags.land || 0) >= 3], ['airjump', (r) => (r.tags.air || 0) > 0],
			['bonk', (r) => r.tags.bonk > 0], ['wall', (r) => r.tags.wall > 0], ['half', (r) => r.tags.half > 0], ['oneway', (r) => r.tags.oneway > 0],
			['start_offgrid', (r) => r.tags.start_offgrid], ['offgrid ground', (r) => r.tags.offgrid > 0], ['dead', (r) => r.tags.dead > 0],
			['xch>=3', (r) => r.xch >= 3], ['xch>=5', (r) => r.xch >= 5], ['len>60', (r) => r.len > 60], ['len>100', (r) => r.len > 100],
		];
		for (const [k, f] of rows) console.log(`  ${k.padEnd(16)} unsolved ${String(cnt(bad, f)).padStart(6)} (${pct(cnt(bad, f), bad.length)}%)   solved ${String(cnt(ok, f)).padStart(6)} (${pct(cnt(ok, f), ok.length)}%)   solve rate ${pct(cnt(ok, f), cnt(ok, f) + cnt(bad, f))}%`);
		// the exclusive classes of the unsolved: the first matching tag in this order
		const order = [['dead', (r) => r.tags.dead > 0], ['start_offgrid', (r) => r.tags.start_offgrid], ['half', (r) => r.tags.half > 0], ['oneway', (r) => r.tags.oneway > 0], ['airjump', (r) => (r.tags.air || 0) > 0], ['lands>=2', (r) => (r.tags.land || 0) >= 2], ['bonk', (r) => r.tags.bonk > 0], ['wall', (r) => r.tags.wall > 0], ['xch>=3', (r) => r.xch >= 3], ['len>60', (r) => r.len > 60]];
		const ex = new Map();
		for (const r of bad) { let k = 'other'; for (const [n, f] of order) if (f(r)) { k = n; break; } ex.set(k, (ex.get(k) || 0) + 1); }
		console.log('  unsolved, exclusive (first tag): ' + Array.from(ex.entries()).map(([k, v]) => `${k} ${v}`).join(', '));
		const whys = new Map(); for (const r of bad) whys.set(r.why, (whys.get(r.why) || 0) + 1);
		console.log('  why: ' + Array.from(whys.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('; '));
	}
}

main();
