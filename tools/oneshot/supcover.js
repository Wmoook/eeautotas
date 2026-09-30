'use strict';
// THE SUPPORTS' COMPLETENESS TEST (n5-oneshot part 1): every MOVE BOUNDARY of every known route (the truthset's user jobs
// + benchmark runs, src/plan/truthset.js) classified by src/plan/oneshot/supports.js. A boundary is the moves study's
// (src/out/n4plan/understand/moves/moves.js): the class letter changes INTO a support letter (G landed, W liquid,
// C climbable, Z dot, B boost, D died), a teleport (the ball moved > 20 px in one tick, alive), a respawn (D -> alive).
// A HIT = the state lies in an enumerated support of the right kind (a landing in a surface support whose rest line and
// free-axis interval hold it; a field entry in a region of that class; a teleport at a portal exit; a respawn at a respawn
// support); a MISS = the enumeration lacks it (the reason is kept). Also per route: the trigger touches (the touch tile a
// trigger support), the support flags at the landings (EXACT: edge / near a field / binade), the speed classes, and the
// merge keys (supports.keyOf levels 0 / 1 / 2) against the exact states (stateHash) at the boundaries.
// Usage: EEAT_TRUTH_ROOT=<root> node tools/oneshot/supcover.js [--shard=i/n] [--out=<dir>] [--limit=N] [--only=<name part>]
//        node tools/oneshot/supcover.js --agg=<dir>
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const TS = require('../../src/plan/truthset.js');
const SP = require('../../src/plan/oneshot/supports.js');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1']; }));
if (argv.agg) { aggregate(argv.agg); process.exit(0); }
const [SH, NSH] = (argv.shard || '0/1').split('/').map(Number);
const OUT = argv.out || 'src/out/oneshot/supcover';
fs.mkdirSync(OUT, { recursive: true });

const F_CLIMB = 32, F_LIQUID = 64, F_BOOST = 128;
const TELEPORT_PX = 20;
function clsOf(s, flags) {
	if (s.is_dead) return 'D';
	const id = s.current_tile, f = id >= 0 && id < flags.length ? flags[id] : 0;
	if (f & F_LIQUID) return 'W';
	if (f & F_CLIMB) return 'C';
	if (id === 4 || id === 414) return 'Z';
	if (f & F_BOOST) return 'B';
	if (s.on_ground) return 'G';
	return 'A';
}
const SUPPORT = new Set(['G', 'W', 'C', 'Z', 'B', 'D']);

function main() {
	const all = TS.knownRoutes({});
	const mine = all.map((e, i) => Object.assign(e, { _idx: i })).filter((e) => e._idx % NSH === SH && (!argv.only || e.name.includes(argv.only))).slice(0, +(argv.limit || 1e9));
	const outF = fs.openSync(path.join(OUT, `cover_${SH}.jsonl`), 'w');
	const cache = new Map();
	for (const entry of mine) {
		const t0 = Date.now();
		const tr = TS.loadTruth(entry);
		if (!tr) { fs.writeSync(outF, JSON.stringify({ r: entry._idx, name: entry.name, stale: true }) + '\n'); continue; }
		const { L, masks } = tr;
		const key = entry.jobId ? 'job:' + entry.jobId : entry.levelFile;
		let S = cache.get(key);
		const hb = process.memoryUsage().heapUsed;
		if (!S) { S = SP.buildSupports(L); cache.clear(); cache.set(key, S); }
		const heapMB = (process.memoryUsage().heapUsed - hb) / 1e6;
		const W = L.width, H = L.height;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		const flags = sim._flags;
		const tally = {};
		const bump = (k, f) => { const o = tally[k] || (tally[k] = { n: 0, hit: 0, miss: 0, why: {} }); o.n++; if (f === true) o.hit++; else { o.miss++; o.why[f] = (o.why[f] || 0) + 1; } };
		const misses = [];
		const surfFlags = { exact: 0, edge: 0, near: 0, binade: 0, half: 0, oneway: 0, door: 0, n: 0 };
		const vcl = {};
		const keys = [new Set(), new Set(), new Set()], hashes = new Set();
		let touches = 0, touchHit = 0, touchMiss = 0;
		let prevCls = clsOf(sim, flags), prevTouch = -1;
		for (let t = 0; t < masks.length; t++) {
			const px = sim.px, py = sim.py;
			E.applyMask(inp, masks[t] & 31);
			sim.tick(inp);
			const c = clsOf(sim, flags);
			const tp = !sim.is_dead && (Math.abs(sim.px - px) > TELEPORT_PX || Math.abs(sim.py - py) > TELEPORT_PX);
			// the trigger touches (the tick-start centre cell read by the touch)
			if (!sim.is_dead) {
				const tt = sim._pastx >= 0 && sim._pasty >= 0 && sim._pastx < W && sim._pasty < H ? sim._pasty * W + sim._pastx : -1;
				if (tt !== prevTouch && tt >= 0) {
					const fgid = L.fg[tt];
					const isTrig = S.trigAt[tt] >= 0;
					// a tile the model calls a trigger: count it (the model's triggers are the supports' triggers)
					if (isTrig) { touches++; touchHit++; }
					else if (fgid === 100 || fgid === 101 || fgid === 121 || fgid === 360 || fgid === 5) { touches++; touchMiss++; if (misses.length < 40) misses.push({ t: t + 1, kind: 'trigger', tile: [tt % W, (tt / W) | 0], id: fgid }); }
				}
				prevTouch = tt;
			}
			let isB = false, what = null;
			if (prevCls === 'D' && c !== 'D') { isB = true; what = 'respawn'; }        // (a respawn moves the ball far: before the teleport test)
			else if (tp) { isB = true; what = 'portal'; }
			else if (c !== prevCls && SUPPORT.has(c)) { isB = true; what = c; }
			prevCls = c;
			if (!isB) continue;
			let res;
			if (what === 'respawn') {
				const cell = ((sim.py / 16) | 0) * W + ((sim.px / 16) | 0);
				const ok = sim.px % 16 === 0 && sim.py % 16 === 0 && S.respAt.has(cell);
				bump('respawn', ok ? true : 'notrespawn');
				if (!ok && misses.length < 40) misses.push({ t: t + 1, kind: 'respawn', x: sim.px, y: sim.py });
				continue;
			}
			if (what === 'D') { bump('death', true); continue; }
			res = SP.classify(S, sim, { teleported: what === 'portal' });
			if (what === 'portal') {
				bump('portal', res.kind === 'portal' && res.id >= 0 ? true : (res.miss || res.kind));
				if (!(res.kind === 'portal' && res.id >= 0) && misses.length < 40) misses.push({ t: t + 1, kind: 'portal', x: sim.px, y: sim.py, px, py, vx: sim.speed_x, vy: sim.speed_y });
			} else if (what === 'G') {
				if (res.kind === 'surf' && res.id >= 0) {
					bump('G', true);
					bump('G.' + res.how + (res.pullEdge ? '.xpull' : ''), true);
					const f = S.surf.flags[res.id];
					surfFlags.n++;
					if (f & SP.SF_EXACT) surfFlags.exact++;
					if (f & SP.SF_EDGE) surfFlags.edge++;
					if (f & SP.SF_NEAR) surfFlags.near++;
					if (f & SP.SF_BINADE) surfFlags.binade++;
					if (f & SP.SF_HALF) surfFlags.half++;
					if (f & SP.SF_ONEWAY) surfFlags.oneway++;
					if (f & SP.SF_DOOR) surfFlags.door++;
					const vc = SP.vclassName(SP.vclass(res.dir === SP.D_DOWN || res.dir === SP.D_UP ? sim.speed_x : sim.speed_y));
					vcl[vc] = (vcl[vc] || 0) + 1;
				} else {
					bump('G', res.why || res.kind);
					if (misses.length < 40) misses.push({ t: t + 1, kind: 'G', got: res.kind, why: res.why, msg: res.miss, x: sim.px, y: sim.py, vx: sim.speed_x, vy: sim.speed_y, cur: sim.current_tile, flip: sim.flip_gravity });
				}
			} else {
				// a field entry
				const ok = res.kind === 'field' && res.id >= 0 && res.letter === what;
				bump(what, ok ? true : (res.miss ? 'noregion' : 'kind:' + res.kind));
				if (ok) bump(what + '.entry', res.entry ? true : 'notentry');
				if (ok && !res.entry && misses.length < 40) misses.push({ t: t + 1, kind: what + '.entry', cell: [res.cell % W, (res.cell / W) | 0], x: sim.px, y: sim.py, px, py, cur: sim.current_tile, past: [sim._pastx, sim._pasty] });
				if (!ok && misses.length < 40) misses.push({ t: t + 1, kind: what, got: res.kind, msg: res.miss, x: sim.px, y: sim.py, cur: sim.current_tile });
			}
			for (let lv = 0; lv < 3; lv++) keys[lv].add(SP.keyOf(S, res, sim, lv));
			hashes.add(sim.stateHash());
		}
		const row = {
			r: entry._idx, name: entry.name, source: entry.source, W, H, ticks: masks.length, ms: Date.now() - t0,
			supports: S.stats, heapMB: +heapMB.toFixed(1), tally, surfFlags, vcl, touches, touchHit, touchMiss,
			keys: { l0: keys[0].size, l1: keys[1].size, l2: keys[2].size, hash: hashes.size }, misses,
		};
		fs.writeSync(outF, JSON.stringify(row) + '\n');
		const g = tally.G || { n: 0, hit: 0 };
		console.log(`${entry._idx} ${entry.name.slice(0, 32).padEnd(32)} ${W}x${H} G ${g.hit}/${g.n}` + Object.entries(tally).filter(([k]) => k !== 'G').map(([k, v]) => ` ${k} ${v.hit}/${v.n}`).join('') + ` surf ${S.stats.surf} ${S.stats.ms}ms ${row.ms}ms`);
	}
	fs.closeSync(outF);
}

function aggregate(dir) {
	const rows = [];
	for (const f of fs.readdirSync(dir)) if (/^cover_\d+\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l));
	const tot = {};
	let stale = 0, routes = 0, ticks = 0;
	const sf = { exact: 0, edge: 0, near: 0, binade: 0, half: 0, oneway: 0, door: 0, n: 0 };
	const vcl = {};
	const whyAll = {};
	let touches = 0, touchHit = 0;
	const keys = { l0: 0, l1: 0, l2: 0, hash: 0 };
	const missRows = [];
	const levels = new Map();
	for (const r of rows) {
		if (r.stale) { stale++; continue; }
		routes++; ticks += r.ticks;
		for (const [k, v] of Object.entries(r.tally)) {
			const o = tot[k] || (tot[k] = { n: 0, hit: 0, miss: 0 });
			o.n += v.n; o.hit += v.hit; o.miss += v.miss;
			for (const [w, c] of Object.entries(v.why)) whyAll[k + ':' + w] = (whyAll[k + ':' + w] || 0) + c;
		}
		for (const k of Object.keys(sf)) sf[k] += r.surfFlags[k] || 0;
		for (const [k, v] of Object.entries(r.vcl)) vcl[k] = (vcl[k] || 0) + v;
		touches += r.touches; touchHit += r.touchHit;
		for (const k of Object.keys(keys)) keys[k] += r.keys[k];
		if (r.misses.length) missRows.push({ r: r.r, name: r.name, n: r.misses.length, first: r.misses.slice(0, 3) });
		levels.set(r.name, r.supports);
	}
	console.log(`routes ${routes} (stale ${stale}), ticks ${ticks}`);
	for (const [k, v] of Object.entries(tot).sort()) console.log(`  ${k.padEnd(10)} ${v.hit}/${v.n} = ${(100 * v.hit / Math.max(1, v.n)).toFixed(2)}%  (miss ${v.miss})`);
	console.log('  misses by reason:', JSON.stringify(whyAll));
	console.log(`  trigger touches ${touchHit}/${touches}`);
	console.log(`  landings on EXACT supports ${sf.exact}/${sf.n} (edge ${sf.edge}, near ${sf.near}, binade ${sf.binade}; half ${sf.half}, oneway ${sf.oneway}, door ${sf.door})`);
	console.log('  landing speed classes:', JSON.stringify(Object.entries(vcl).sort((a, b) => b[1] - a[1]).slice(0, 20)));
	console.log(`  merge keys at the boundaries: level0 ${keys.l0}, level1 ${keys.l1}, level2 ${keys.l2}, exact states ${keys.hash}`);
	console.log(`  routes with misses: ${missRows.length}`);
	for (const m of missRows.slice(0, 30)) console.log('   ', m.r, m.name, m.n, JSON.stringify(m.first));
}

main();
