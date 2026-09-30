'use strict';
// TRICK MINING 3 (the state tricks), n5-tricks: every known route (src/plan/truthset.js: the user's jobs and the AutoTAS
// benchmark runs; READ ONLY) replayed tick by tick in the engine, and every use of the level's STATE as a move written
// down, per route and summed:
//   deaths      each death: the tile it died on, the respawn (the checkpoint, else a spawn), the next trigger the route
//               takes after it, and the walk steps (model.js dist, mode 'walk': gates exact, killers passable) to that
//               trigger from the death tile vs from the respawn: a RESPAWN SKIP when the respawn is nearer by more than
//               the dead ticks' worth of running (DEAD_TICKS x 6.78 px/tick = 23 tiles)
//   checkpoints every checkpoint touch, and whether a later death respawned there (used) or none did (passed only)
//   keys        every key turn-on, REFRESH (a touch while the key is on: the timer restamped), expiry; every key DOOR
//               passage with the ticks the key had left; every key GATE passage while its key had been on before (the
//               expiry used as a move: the gate shut while the key is on)
//   time doors  every entry into a time door / gate tile (156 / 157), the phase (the tick in the 1000-tick cycle), and the
//               route's rest ticks next to a time door (a wait); the idle ticks before the first input (free: the timer
//               starts at the first input) = the phase the route chose for nothing
//   switches    every purple / orange switch change, per id the number of changes (2+: a toggle back), the resets
//   portals     every teleport (a jump of the box by more than 24 px in one tick while alive and not respawning), the
//               speed before / after (a rotated exit x 1.42), chains (a teleport within 6 ticks of the last)
//   coins       the order the route takes its gold / blue coins vs the nearest-neighbour order from the same start
//               (Chebyshev tiles): the tour's excess
// node tools/cmp/tricks3.js [--root=<truth root>] [--out=<dir>] [--only=<name substring>] [--max=N] [--shard=i/n]
//   -> <out>/routes.jsonl (one line a route) and <out>/summary.json + summary.md (the sums, per trick the levels)
// A tool only: no compiler file changed.
const fs = require('fs');
const path = require('path');
const E = require('../../src/eesim.js');
const T = require('../../src/plan/types.js');
const TS = require('../../src/plan/truthset.js');
const MD = require('../../src/plan/model.js');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) args[m[1]] = m[2]; else if (a.startsWith('--')) args[a.slice(2)] = '1'; }
const OUT = path.resolve(args.out || path.join(__dirname, '..', '..', 'src', 'out', 'n5', 'tricks3'));
fs.mkdirSync(OUT, { recursive: true });

const KEY_DOOR = new Map([[23, 0], [24, 1], [25, 2], [1005, 3], [1006, 4], [1007, 5]]);
const KEY_GATE = new Map([[26, 0], [27, 1], [28, 2], [1008, 3], [1009, 4], [1010, 5]]);
const KEY_TICKS = 500, DEAD_TICKS = 54, RUN_PX = 6.78;
const SKIP_TILES = Math.ceil(DEAD_TICKS * RUN_PX / 16);

/** the tiles the 16 x 16 box overlaps (1-4) */
function boxTiles(sim, W, H) {
	const out = [];
	const x0 = Math.floor(sim.px / 16), x1 = Math.floor((sim.px + 15.999) / 16), y0 = Math.floor(sim.py / 16), y1 = Math.floor((sim.py + 15.999) / 16);
	for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) out.push(y * W + x);
	return out;
}

function mineRoute(entry) {
	const tr = TS.loadTruth(entry);
	if (!tr) return { name: entry.name, source: entry.source, route: entry.route, stale: true };
	const { L, masks } = tr;
	const W = L.width, H = L.height, fg = L.fg;
	let M = null;
	try { M = MD.compileModel(L, { file: entry.levelFile }); } catch (e) { M = null; }
	const rev = TS.routeEvents(L, masks, {});
	const trig = rev.events.filter((e) => e.feat !== 'deaths' && e.feat !== 'cp' && e.feat !== 'fx');
	const nextTrigAfter = (t) => trig.find((e) => e.tick > t) || null;
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	let first = -1;
	for (let t = 0; t < masks.length; t++) if ((masks[t] & 31) !== 0) { first = t; break; }
	const R = {
		name: entry.name, source: entry.source, route: entry.route, level: path.basename(entry.levelFile), W, H,
		ticks: masks.length, runTicks: tr.runTicks, deaths: [], cps: [], keys: { on: 0, refresh: 0, expire: 0, doorPass: [], gatePassAfter: 0, gatePassNever: 0, refreshSlack: [] },
		time: { entries: 0, restNear: 0, idle: first, phase0: 0, entryPhases: [] }, sw: { psw: {}, osw: {}, resets: 0 },
		portals: { n: 0, rotated: 0, boosted: 0, chains: 0, maxOut: 0 }, coins: null,
	};
	let hasTime = false, hasKeyDoor = false, hasKeyGate = false;
	for (let i = 0; i < fg.length; i++) { const b = fg[i]; if (b === 156 || b === 157) hasTime = true; if (KEY_DOOR.has(b)) hasKeyDoor = true; if (KEY_GATE.has(b)) hasKeyGate = true; }
	R.has = { time: hasTime, keyDoor: hasKeyDoor, keyGate: hasKeyGate };
	const everOn = new Uint8Array(6);
	let prevKm = sim._keysMask, prevKt = Int32Array.from(sim._kt);
	let prevDead = !!sim.is_dead, deathAt = -1, deathTile = -1, deathCp = null;
	let prevPx = sim.px, prevPy = sim.py, prevVx = sim.speed_x, prevVy = sim.speed_y;
	let lastTele = -1e9, inTime = false, prevCp = TS.BASE_FEATS ? T.featValue(sim, 'cp') : -1;
	const cpTouches = [];
	const coinOrder = [], bcoinOrder = [];
	let pc = sim.coins, pb = sim.blue_coins;
	const startTile = T.tileOf(sim, W, H);
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const dead = !!sim.is_dead;
		const tile = T.tileOf(sim, W, H);
		// ---- deaths
		if (dead && !prevDead) { deathAt = t + 1; deathTile = T.tileOf({ px: prevPx, py: prevPy }, W, H); deathCp = T.featValue(sim, 'cp'); }
		if (!dead && prevDead && deathAt > 0) {
			const nx = nextTrigAfter(t + 1);
			const d = { tick: deathAt, respawnTick: t + 1, dead: t + 1 - deathAt, from: deathTile, to: tile, cp: deathCp, next: nx ? nx.feat + '@' + nx.tile : null, stepsFrom: -1, stepsTo: -1, gain: null, skip: false };
			if (M && nx) {
				try {
					const S = M.stateOf(sim);
					const a = M.pairSteps(S, { id: 'tr3d' + deathTile, tiles: [deathTile] }, [nx.tile], 'walk');
					const b = M.pairSteps(S, { id: 'tr3r' + tile, tiles: [tile] }, [nx.tile], 'walk');
					d.stepsFrom = a >= MD.INF ? -1 : a; d.stepsTo = b >= MD.INF ? -1 : b;
					if (b < MD.INF) { d.gain = (a >= MD.INF ? 99999 : a) - b; d.skip = d.gain > SKIP_TILES; }
				} catch (e) { d.err = String(e.message || e); }
			}
			R.deaths.push(d);
			deathAt = -1;
		}
		// ---- checkpoints
		const cpNow = T.featValue(sim, 'cp');
		if (cpNow !== prevCp && cpNow >= 0) cpTouches.push({ tick: t + 1, tile: cpNow });
		prevCp = cpNow;
		// ---- keys
		const km = sim._keysMask;
		for (let c = 0; c < 6; c++) {
			const was = (prevKm >> c) & 1, now = (km >> c) & 1;
			if (!was && now) { R.keys.on++; everOn[c] = 1; }
			else if (was && now && sim._kt[c] !== prevKt[c]) { R.keys.refresh++; R.keys.refreshSlack.push(KEY_TICKS - (sim._kt[c] - prevKt[c])); }
			else if (was && !now) R.keys.expire++;
		}
		prevKm = km; prevKt = Int32Array.from(sim._kt);
		// ---- the box's tiles: key doors / gates, time doors
		if (!dead) {
			let inT = false;
			for (const bt of boxTiles(sim, W, H)) {
				const b = fg[bt];
				if (KEY_DOOR.has(b)) { const c = KEY_DOOR.get(b); if ((km >> c) & 1) R.keys.doorPass.push(KEY_TICKS - (sim._ticks - sim._kt[c])); }
				else if (KEY_GATE.has(b)) { const c = KEY_GATE.get(b); if (!((km >> c) & 1)) { if (everOn[c]) R.keys.gatePassAfter++; else R.keys.gatePassNever++; } }
				else if (b === 156 || b === 157) inT = true;
			}
			if (inT && !inTime) { R.time.entries++; R.time.entryPhases.push(sim._ticks % 1000); }
			inTime = inT;
			if (hasTime && Math.abs(sim.speed_x) < 0.05 && Math.abs(sim.speed_y) < 0.05) {
				const cx = tile % W, cy = (tile / W) | 0;
				let near = false;
				for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < W && y < H && (fg[y * W + x] === 156 || fg[y * W + x] === 157)) near = true; }
				if (near) R.time.restNear++;
			}
		}
		// ---- portals
		if (!dead && !prevDead && (Math.abs(sim.px - prevPx) > 24 || Math.abs(sim.py - prevPy) > 24)) {
			R.portals.n++;
			const v0 = Math.hypot(prevVx, prevVy), v1 = Math.hypot(sim.speed_x, sim.speed_y);
			const rot = Math.sign(prevVx) !== Math.sign(sim.speed_x) || Math.sign(prevVy) !== Math.sign(sim.speed_y);
			if (rot && (Math.abs(prevVx) > 0.5 || Math.abs(prevVy) > 0.5)) R.portals.rotated++;
			if (v1 > v0 * 1.2 && v1 > 1) R.portals.boosted++;
			if (t + 1 - lastTele <= 6) R.portals.chains++;
			R.portals.maxOut = Math.max(R.portals.maxOut, +v1.toFixed(2));
			lastTele = t + 1;
		}
		// ---- coins
		if (sim.coins > pc) coinOrder.push(tile);
		if (sim.blue_coins > pb) bcoinOrder.push(tile);
		pc = sim.coins; pb = sim.blue_coins;
		prevDead = dead; prevPx = sim.px; prevPy = sim.py; prevVx = sim.speed_x; prevVy = sim.speed_y;
		if (sim.has_silver_crown) break;
	}
	// the phase the route starts its first input in (the idle ticks before it are free)
	R.time.phase0 = first >= 0 ? (sim._tick0 + first) % 1000 : 0;
	// checkpoints used by a later death
	R.cps = cpTouches.map((c) => ({ tick: c.tick, tile: c.tile, used: R.deaths.some((d) => d.tick > c.tick && d.cp === c.tile) }));
	// switches (the events), resets
	for (const e of rev.events) {
		if (e.feat.startsWith('psw:')) R.sw.psw[e.feat.slice(4)] = (R.sw.psw[e.feat.slice(4)] || 0) + 1;
		if (e.feat.startsWith('osw:')) R.sw.osw[e.feat.slice(4)] = (R.sw.osw[e.feat.slice(4)] || 0) + 1;
	}
	// coins: the route's order vs the greedy nearest-neighbour order (Chebyshev tiles)
	const tour = (order) => {
		if (order.length < 3) return null;
		const ch = (a, b) => Math.max(Math.abs((a % W) - (b % W)), Math.abs(((a / W) | 0) - ((b / W) | 0)));
		let routeLen = 0, cur = startTile;
		for (const c of order) { routeLen += ch(cur, c); cur = c; }
		const left = order.slice();
		let nnLen = 0; cur = startTile;
		while (left.length) { let bi = 0; for (let i = 1; i < left.length; i++) if (ch(cur, left[i]) < ch(cur, left[bi])) bi = i; nnLen += ch(cur, left[bi]); cur = left[bi]; left.splice(bi, 1); }
		// how many of the route's coins are its nearest untaken one (in that order)
		let nearest = 0; cur = startTile;
		const rest = new Set(order);
		for (const c of order) { let best = Infinity; for (const o of rest) best = Math.min(best, ch(cur, o)); if (ch(cur, c) === best) nearest++; rest.delete(c); cur = c; }
		return { n: order.length, routeLen, nnLen, ratio: +(routeLen / Math.max(1, nnLen)).toFixed(3), nearestShare: +(nearest / order.length).toFixed(3) };
	};
	R.coins = { gold: tour(coinOrder), blue: tour(bcoinOrder) };
	R.complete = rev.complete;
	return R;
}

function main() {
	let list = TS.knownRoutes({ root: args.root });
	if (args.only) list = list.filter((e) => e.name.toLowerCase().includes(args.only.toLowerCase()));
	if (args.shard) { const [i, n] = args.shard.split('/').map(Number); list = list.filter((e, k) => k % n === i); }
	if (args.max) list = list.slice(0, +args.max);
	const outF = path.join(OUT, args.shard ? `routes_${args.shard.replace('/', 'of')}.jsonl` : 'routes.jsonl');
	fs.writeFileSync(outF, '');
	const t0 = Date.now();
	let k = 0;
	for (const e of list) {
		k++;
		let R;
		try { R = mineRoute(e); } catch (err) { R = { name: e.name, route: e.route, error: String(err && err.stack || err).slice(0, 400) }; }
		fs.appendFileSync(outF, JSON.stringify(R) + '\n');
		if (!args.quiet) process.stderr.write(`[${k}/${list.length} ${((Date.now() - t0) / 1000).toFixed(0)}s] ${e.name} ${R.stale ? 'stale' : R.error ? 'ERR' : `deaths ${R.deaths.length} keys ${R.keys.on}/${R.keys.refresh} tp ${R.portals.n}`}\n`);
	}
	if (!args.shard) summarize([outF]);
}

/** the sums over routes.jsonl files -> summary.json / summary.md */
function summarize(files) {
	const rows = [];
	for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
	const ok = rows.filter((r) => !r.stale && !r.error);
	const S = { routes: rows.length, replayed: ok.length, stale: rows.filter((r) => r.stale).length, errors: rows.filter((r) => r.error).length };
	const lv = (f) => [...new Set(ok.filter(f).map((r) => r.name))];
	const deaths = ok.flatMap((r) => r.deaths.map((d) => Object.assign({ name: r.name }, d)));
	S.deaths = { routes: ok.filter((r) => r.deaths.length).length, n: deaths.length, skips: deaths.filter((d) => d.skip).length, skipLevels: lv((r) => r.deaths.some((d) => d.skip)), levels: lv((r) => r.deaths.length > 0) };
	S.cps = { routes: ok.filter((r) => r.cps.length).length, touches: ok.reduce((s, r) => s + r.cps.length, 0), used: ok.reduce((s, r) => s + r.cps.filter((c) => c.used).length, 0) };
	S.keys = {
		routes: ok.filter((r) => r.keys.on).length, on: ok.reduce((s, r) => s + r.keys.on, 0), refresh: ok.reduce((s, r) => s + r.keys.refresh, 0), expire: ok.reduce((s, r) => s + r.keys.expire, 0),
		refreshLevels: lv((r) => r.keys.refresh > 0), gatePassAfter: ok.reduce((s, r) => s + r.keys.gatePassAfter, 0), gateAfterLevels: lv((r) => r.keys.gatePassAfter > 0),
		doorPassMinLeft: (() => { const a = ok.flatMap((r) => r.keys.doorPass); a.sort((x, y) => x - y); return a.length ? { n: a.length, min: a[0], p10: a[Math.floor(a.length * 0.1)], median: a[a.length >> 1] } : null; })(),
	};
	S.time = { routes: ok.filter((r) => r.has && r.has.time).length, entries: ok.reduce((s, r) => s + r.time.entries, 0), restNear: ok.reduce((s, r) => s + r.time.restNear, 0), idle: ok.filter((r) => r.has && r.has.time).map((r) => ({ name: r.name, idle: r.time.idle, rest: r.time.restNear, entries: r.time.entries })) };
	S.sw = { routes: ok.filter((r) => Object.keys(r.sw.psw).length || Object.keys(r.sw.osw).length).length, toggleBack: ok.reduce((s, r) => s + Object.values(r.sw.psw).filter((n) => n >= 2).length + Object.values(r.sw.osw).filter((n) => n >= 2).length, 0), toggleBackLevels: lv((r) => Object.values(r.sw.psw).some((n) => n >= 2) || Object.values(r.sw.osw).some((n) => n >= 2)) };
	S.portals = { routes: ok.filter((r) => r.portals.n).length, n: ok.reduce((s, r) => s + r.portals.n, 0), rotated: ok.reduce((s, r) => s + r.portals.rotated, 0), boosted: ok.reduce((s, r) => s + r.portals.boosted, 0), chains: ok.reduce((s, r) => s + r.portals.chains, 0), boostLevels: lv((r) => r.portals.boosted > 0) };
	const cg = ok.map((r) => r.coins && r.coins.gold).filter(Boolean);
	S.coins = { routes: cg.length, ratioMedian: cg.length ? cg.map((c) => c.ratio).sort((a, b) => a - b)[cg.length >> 1] : null, nearestShareMedian: cg.length ? cg.map((c) => c.nearestShare).sort((a, b) => a - b)[cg.length >> 1] : null, notNearest: ok.filter((r) => r.coins && r.coins.gold && r.coins.gold.nearestShare < 0.8).map((r) => ({ name: r.name, n: r.coins.gold.n, ratio: r.coins.gold.ratio, nearest: r.coins.gold.nearestShare })) };
	S.deathList = deaths.map((d) => ({ name: d.name, tick: d.tick, from: d.from, to: d.to, gain: d.gain, skip: d.skip, next: d.next }));
	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(S, null, 1));
	const md = [];
	md.push(`# TRICK MINING 3 (state tricks) on the known routes`, '', `routes ${S.routes}, replayed ${S.replayed}, stale ${S.stale}, errors ${S.errors}`, '');
	md.push(`- deaths: ${S.deaths.n} in ${S.deaths.routes} routes; respawn skips (the respawn nearer the next trigger by > ${SKIP_TILES} walk tiles) ${S.deaths.skips}: ${S.deaths.skipLevels.join(', ')}`);
	md.push(`- checkpoints: ${S.cps.touches} touches in ${S.cps.routes} routes, ${S.cps.used} used by a later death`);
	md.push(`- keys: ${S.keys.on} turn-ons in ${S.keys.routes} routes, ${S.keys.refresh} refreshes (${S.keys.refreshLevels.join(', ')}), ${S.keys.expire} expiries, key-gate passages after the key's expiry ${S.keys.gatePassAfter} (${S.keys.gateAfterLevels.join(', ')}); key-door passage ticks left ${JSON.stringify(S.keys.doorPassMinLeft)}`);
	md.push(`- time doors: ${S.time.routes} routes on time-door levels, ${S.time.entries} entries, ${S.time.restNear} rest ticks next to a time door`);
	md.push(`- switches: ${S.sw.routes} routes, ${S.sw.toggleBack} ids toggled 2+ times (${S.sw.toggleBackLevels.join(', ')})`);
	md.push(`- portals: ${S.portals.n} teleports in ${S.portals.routes} routes, rotated ${S.portals.rotated}, speed-boosted ${S.portals.boosted} (${S.portals.boostLevels.join(', ')}), chained ${S.portals.chains}`);
	md.push(`- coins: ${S.coins.routes} routes with 3+ gold coins, route / nearest-neighbour tour median ${S.coins.ratioMedian}, nearest-coin share median ${S.coins.nearestShareMedian}`);
	fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n');
	process.stdout.write(md.join('\n') + '\n');
}

if (require.main === module) {
	if (args.summarize) summarize(args.summarize.split(','));
	else main();
}
module.exports = { mineRoute, summarize };
