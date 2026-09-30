'use strict';
// test/kin_routes.js - section E of test/kin.js: kin.js on the REAL routes (src/plan/truthset.js: the user's jobs and the
// benchmark runs; EEAT_TRUTH_ROOT or --root = a checkout with src/jobs and src/out/god). Every tick of every route, kin
// predicts the engine's next state from its current one (one step: kin's state = the engine's, so a route with no
// mismatch is also exact when kin runs on its own state, by induction), in a world W whose world-side answers are the
// engine's own: the tiles and lookup ints at the tick's start (coin pickups undone), the doors as they stand during the
// tick's move (read when the engine enters Me.touchBlock, after the move), a random portal's exit as the engine drew it.
// Every mismatch is classified by what the tick involved.
const path = require('path');
const E = require('../src/eesim.js');
const K = require('../src/plan/kin.js');
const TS = require('../src/plan/truthset.js');
const KT = require('./kin.js');

function captureDoors(s) {
	return { keysMask: s._keysMask, timedoor: s._timedoor_state, switches: new Map(s._switches), oswitches: new Map(s._oswitches),
		crown: s._collide_crown, scrown: s._collide_silver_crown, coins: s.coins, bcoins: s.blue_coins, deaths: s.deaths,
		scg: s._show_coin_gate, sbcg: s._show_blue_coin_gate, sdg: s._show_death_gate, team: s.team, zombie: s.is_zombie };
}
function applyDoors(scr, c, lookup) {
	scr._keysMask = c.keysMask; scr._timedoor_state = c.timedoor; scr._switches = c.switches; scr._oswitches = c.oswitches;
	scr._collide_crown = c.crown; scr._collide_silver_crown = c.scrown; scr.coins = c.coins; scr.blue_coins = c.bcoins;
	scr.deaths = c.deaths; scr._show_coin_gate = c.scg; scr._show_blue_coin_gate = c.sbcg; scr._show_death_gate = c.sdg;
	scr.team = c.team; scr.is_zombie = c.zombie; scr._lookup = lookup;
}

/** one route: {ticks, bad: [{t, k, kin, eng, cls}]} */
function checkRoute(L, masks, o = {}) {
	const sim = new E.EESim(L), scr = new E.EESim(L), inp = new E.EEInput();
	const Wd = L.width, H = L.height;
	let cap = null, undo = new Map(), aborted = false, teleports = 0;
	const origTouch = sim._touchBlock, origCoin = sim._setTileCoin;
	sim._touchBlock = function (cx, cy, g) { cap = captureDoors(this); return origTouch.call(this, cx, cy, g); };
	sim._setTileCoin = function (cx, cy, id) {
		const i = cy * Wd + cx;
		if (!undo.has(i)) undo.set(i, [this.tiles[i], this._lookup[i]]);
		return origCoin.call(this, cx, cy, id);
	};
	sim.onEvent = (ev) => { if (ev === 'tick_aborted') aborted = true; };
	const base = K.makeWorld(L);
	let snap = null;
	const W = Object.assign({}, base, {
		tile(cx, cy) {
			if (cx < 0 || cy < 0 || cx >= Wd || cy >= H) return 0;
			const i = cy * Wd + cx, u = undo.get(i);
			return u !== undefined ? u[0] : sim.tiles[i];
		},
		lookup(cx, cy) {
			if (cx < 0 || cy < 0 || cx >= Wd || cy >= H) return 0;
			const i = cy * Wd + cx, u = undo.get(i);
			return u !== undefined ? u[1] : sim._lookup[i];
		},
		doorOpen(id, cx, cy) { applyDoors(scr, cap, sim._lookup); return scr._doorPassable(id, cy * Wd + cx); },
		exit(P) {
			teleports++;
			scr.restore(snap);
			let t = L.portalsById.get(P.target);
			if (t === undefined) return null;
			if (t.pc !== null && scr._portalGone !== L.portalGone0) t = scr._liveExits(t);
			if (t.n <= 0) return null;
			const k = scr._randiRange(0, t.n - 1);
			const x = t.xs[k], y = t.ys[k];
			const ns = L.portalSlot[(y >> 4) * Wd + (x >> 4)];
			return { x, y, rot: ns >= 0 ? L.pRot[ns] : 0 };
		},
	});
	const bad = [];
	let n = 0, st = K.fromSim(sim);
	for (let t = 0; t < masks.length; t++) {
		if (!o.free) st = K.fromSim(sim);
		snap = sim.snapshot();
		const pre = { team: sim._team_tx !== -1, tq: sim._tileQueue.length !== 0, keys: sim._keysMask, sq: sim._stateQueue.length + sim._keysQueue.length };
		cap = null; undo = new Map(); aborted = false;
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		if (cap === null) cap = captureDoors(sim);
		K.tick(st, masks[t] & 31, W);
		n++;
		const d = KT.diffOf(st, sim);
		if (d) {
			// classify
			const cls = [];
			if (aborted) cls.push('music-abort');
			if (pre.team) cls.push('team-retry');
			if (pre.tq) cls.push('purple-retry');
			if (pre.sq) cls.push('frame-queue');
			if (pre.keys !== sim._keysMask) cls.push('keys');
			let ow = false, door = false;
			for (const s of [snap, sim]) {
				const x0 = (s.px | 0) >> 4, y0 = (s.py | 0) >> 4;
				for (let y = y0 - 1; y <= y0 + 2; y++) for (let x = x0 - 1; x <= x0 + 2; x++) {
					if (x < 0 || y < 0 || x >= Wd || y >= H) continue;
					const f = K.flagsOf(sim.tiles[y * Wd + x]);
					if (f & K.F.JUMPTHRU) ow = true;
					if (f & K.F.DOOR) door = true;
				}
			}
			if (ow) cls.push('one-way near');
			if (door) cls.push('door near');
			bad.push(Object.assign(d, { t: t + 1, cls: cls.join('+') || 'UNCLASSIFIED' }));
			if (o.free) st = K.fromSim(sim);
			if (bad.length >= (o.maxBad || 20)) break;
		}
	}
	return { ticks: n, bad, teleports };
}

function testE(h) {
	const { check, section, report, arg, QUICK, SHARD, NSHARD } = h;
	const root = arg('root', process.env.EEAT_TRUTH_ROOT || '');
	const FREE = arg('free', '0') === '1';
	section(`E the real routes, ${FREE ? 'kin FREE-RUNNING on its own state along each whole route' : 'one step every tick'} (truth root ${root || '(none)'})`);
	if (!root) { check('a truth root (--root= or EEAT_TRUTH_ROOT)', false, 'none given: nothing checked'); return; }
	const entries = TS.knownRoutes({ root });
	let routes = 0, ticks = 0, stale = 0, badRoutes = 0, teleports = 0;
	const classes = new Map(), fields = new Map(), examples = [];
	const t0 = Date.now();
	const lim = QUICK ? 12 : Infinity;
	for (let i = SHARD; i < entries.length && routes < lim; i += NSHARD) {
		const e = entries[i];
		let tr = null;
		try { tr = TS.loadTruth(e); } catch (err) { tr = null; }
		if (!tr) { stale++; continue; }
		const r = checkRoute(tr.L, tr.masks, { free: FREE });
		routes++; ticks += r.ticks; teleports += r.teleports;
		if (r.bad.length) {
			badRoutes++;
			for (const b of r.bad) {
				classes.set(b.cls, (classes.get(b.cls) || 0) + 1);
				fields.set(b.k, (fields.get(b.k) || 0) + 1);
				if (examples.length < 30) examples.push({ route: path.basename(path.dirname(e.route)) + '/' + e.name, t: b.t, k: b.k, kin: b.kin, eng: b.eng, cls: b.cls });
			}
		}
	}
	report.E = { routes, ticks, stale, badRoutes, teleports, classes: Object.fromEntries(classes), fields: Object.fromEntries(fields), examples, ms: Date.now() - t0 };
	console.log(`   ${routes} routes (${stale} stale), ${ticks.toLocaleString()} ticks, ${teleports} teleports, ${Date.now() - t0} ms`);
	for (const [c, k] of classes) console.log(`   mismatch class ${c}: ${k}`);
	for (const x of examples.slice(0, 8)) console.log('   e.g.', JSON.stringify(x));
	const unclassified = classes.get('UNCLASSIFIED') || 0;
	check(`${ticks.toLocaleString()} real ticks: every tick kin = the engine${FREE ? ' (kin on its own state)' : ''}`, badRoutes === 0, `${badRoutes} routes with a mismatch, ${unclassified} unclassified`);
}

module.exports = { testE, checkRoute };
