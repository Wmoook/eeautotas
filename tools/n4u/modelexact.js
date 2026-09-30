'use strict';
// T-MODEL-EXACT (N4U semantics, 2026-09-29): the level MODEL (src/plan/model.js compileModel, origin/n4plan-planner's API)
// against the ENGINE along every known route of the truthset (src/plan/truthset.js). Read only; exact (every state is the
// engine's replay of the route). Per route, every tick:
//  (1) STATE: the model's prediction P (its touch() at the trigger the ball's centre tile enters, at the tick the engine
//      touches: the tile at the tick's START) vs the engine's abstract state R = stateOf(sim); every difference classified
//      (key expiry, deferred overlap retries, half-block redirects, coin components, deaths, ...), then P := R.
//  (2) DOORS: every gate tile within 2 tiles of the ball every tick, and every gate tile of the level at every change of R
//      and every 250 ticks: the model's gateOpen(i, R, 'est') and gateOpen(i, R, 'lb', R's counts) vs the engine's
//      !is_tile_solid_now. 'lb shut / engine open' = the bound's relaxation is NOT a relaxation there (unsound);
//      'est open / engine shut' = the plan walks through a shut door; 'est shut / engine open' = a way the plan misses.
//  (3) GEOMETRY: the ball's centre tile in a tile the model's lb pass mask walls; a centre step between 8-neighbours the
//      model's moveOK forbids (diagonal squeeze, half-block quadrants, a shut gate); centre jumps that are no portal hop /
//      respawn.
//  (4) BOUND: between two consecutive changes of R, the model's pairLb(Rprev, from, to, 'lb', Rprev counts) <= the ticks
//      the route took (T-LB-ADMISSIBLE for the model's tier 0).
//  (5) USAGE: the ticks the route spends with each effect / medium (what the MOVES stage must model).
// node tools/n4u/modelexact.js [--root=<checkout>] [--shard=i/n] [--only=<name substring>] [--out=<dir>] [--max=<routes>]
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const E = require(path.join(REPO, 'src', 'eesim.js'));
const TS = require(path.join(REPO, 'src', 'plan', 'truthset.js'));
const T = require(path.join(REPO, 'src', 'plan', 'types.js'));
const PM = require(path.join(REPO, 'src', 'plan', 'model.js'));
const ST = require(path.join(REPO, 'src', 'steer.js'));
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const root = arg('root', process.env.EEAT_TRUTH_ROOT || 'C:\\Users\\super\\eeautotas');
const outDir = arg('out', path.join(REPO, 'src', 'out', 'n4plan', 'understand', 'semantics'));
const shard = arg('shard', '0/1').split('/').map(Number);
const only = arg('only', '');
const maxRoutes = +arg('max', 0) || Infinity;
fs.mkdirSync(outDir, { recursive: true });

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1], DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const F_HALF = 8;
const KEY_IDS = [6, 7, 8, 408, 409, 410];

function checkRoute(entry) {
	const t0 = Date.now();
	const tr = TS.loadTruth(entry);
	if (!tr) return { name: entry.name, source: entry.source, route: entry.route, stale: true };
	const L = tr.L, W = L.width, H = L.height, N = W * H, fg = L.fg;
	const M = PM.compileModel(L, { file: entry.levelFile });
	const A = M.A;
	const cls = {}, ex = {};                     // mismatch class -> count, -> first examples
	const hit = (c, info, n = 1) => { cls[c] = (cls[c] || 0) + n; if (!ex[c]) ex[c] = []; if (ex[c].length < 3) ex[c].push(info); };
	const use = {};
	const u = (k) => { use[k] = (use[k] || 0) + 1; };
	const moveOK = (m, t, d) => {
		const x = t % W, y = (t / W) | 0, nx = x + DX8[d], ny = y + DY8[d];
		if (nx < 0 || ny < 0 || nx >= W || ny >= H) return 'edge';
		const j = ny * W + nx;
		if (!m[j]) return 'into wall';
		if (A.qMove) {
			const q = A.qMove[t * 8 + d];
			if (q === 1) return 'quadrant (static)';
			if (q === 2 && !ST.qMoveOK(A, t, d, (i) => !m[i], (i) => m[i] === 1)) return 'quadrant (gate)';
		}
		if (DX8[d] !== 0 && DY8[d] !== 0 && !m[y * W + nx] && !m[ny * W + x]) return 'diagonal squeeze';
		return null;
	};
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const swSig = (m) => { let s = ''; for (const [k, v] of m) if (v === true) s += k + ','; return s; };
	const sig = () => `${sim._keysMask}|${sim.coins}|${sim.blue_coins}|${sim.team}|${sim.is_invulnerable ? 1 : 0}|${sim._collide_crown ? 1 : 0}|${sim.deaths}|${sim.checkpoint.x},${sim.checkpoint.y}|${swSig(sim._switches)}|${swSig(sim._oswitches)}|${sim._show_coin_gate},${sim._show_blue_coin_gate},${sim._show_death_gate},${sim._timedoor_state ? 1 : 0},${sim.is_zombie ? 1 : 0}`;   // (+ the copies the gates read: stateOf keeps them)
	let R = M.stateOf(sim), P = R, sg = sig(), pend = null;
	let lastStart = -1;
	let evTick = 0, evTile = T.tileOf(sim, W, H), evR = R;   // the last change of R (bound check)
	const gateTiles = [];
	for (let i = 0; i < N; i++) if (A.cls[i] === 3) gateTiles.push(i);
	const lastKeyOn = new Int32Array(6).fill(-1);
	const kt = Int32Array.from(sim._kt);
	let prevTile = T.tileOf(sim, W, H), prevDead = false;
	let lbChecks = 0, lbViol = 0, lbSlackMin = Infinity, lbRatioSum = 0;
	const masks = tr.masks;
	const checkGates = (list, tick, tag) => {
		for (const i of list) {
			const actual = !sim.is_tile_solid_now(i % W, (i / W) | 0);
			const est = M.gateOpen(i, R, 'est', null);
			const lb = M.gateOpen(i, R, 'lb', R.feats);
			const b = fg[i];
			let lag = '';
			if (A.gateFeat[i] === 'coins' && A.gatePol[i] === 0 && sim._show_coin_gate !== sim.coins) lag = ' (gate snapshot != count)';
			if (A.gateFeat[i] === 'bcoins' && A.gatePol[i] === 0 && sim._show_blue_coin_gate !== sim.blue_coins) lag = ' (gate snapshot != count)';
			if (b === 1011 || b === 1012) lag = ` (deaths ${sim.deaths} vs ${L.lookup0[i]})`;
			if (b === 206 || b === 207) lag = ` (zombie ${sim.is_zombie ? 1 : 0})`;
			// ('now': the model's exact reading of a concrete state (stateOf's _show_* copies, time phase, zombie): must match)
			const now = M.gateOpen(i, R, 'now', null);
			if (now !== actual) hit(`EXACT door now ${now ? 'open' : 'shut'} / engine ${actual ? 'open' : 'shut'}: ${b} (${A.gateFeat[i]}${A.gatePol[i] ? '' : ' gate'})${lag}${tag}`, { tick, tile: [i % W, (i / W) | 0] });
			if (est !== actual) hit(`door est ${est ? 'open' : 'shut'} / engine ${actual ? 'open' : 'shut'}: ${b} (${A.gateFeat[i]}${A.gatePol[i] ? '' : ' gate'})${lag}${tag}`, { tick, tile: [i % W, (i / W) | 0] });
			if (!lb && actual) hit(`UNSOUND lb shut / engine open: ${b} (${A.gateFeat[i]})${lag}${tag}`, { tick, tile: [i % W, (i / W) | 0], coins: sim.coins, show: sim._show_coin_gate, bc: sim.blue_coins, bshow: sim._show_blue_coin_gate, Rc: R.feats.coins, Rb: R.feats.bcoins });
		}
	};
	for (let t = 0; t < masks.length; t++) {
		// the engine touches the cell of the tick's START (Player.tick: cx, cy before the movement; a half block redirects)
		const start = T.tileOf(sim, W, H);
		const sx = Math.trunc(sim.px + 8) >> 4, sy = Math.trunc(sim.py + 8) >> 4;
		let redirect = false, ec = start;
		if (sx >= 0 && sy >= 0 && sx < W && sy < H && (L.flags[fg[sy * W + sx]] & F_HALF) !== 0) {
			let rot = L.lookup0[sy * W + sx]; if (L.xflags[fg[sy * W + sx]] & 4) rot = 1;
			const ex2 = rot === 0 ? sx - 1 : sx, ey2 = rot === 1 ? sy - 1 : sy;
			if (ex2 >= 0 && ey2 >= 0) ec = ey2 * W + ex2;
			redirect = ec !== start && (M.trigOf[ec] !== M.trigOf[start]);
			if (redirect) u('half-block redirect onto another trigger cell');
		}
		let touched = null;
		if (start !== lastStart && !sim.is_dead) {
			const X = M.trigOf[start] >= 0 ? M.triggers[M.trigOf[start]] : null;
			if (X) { const r = M.touch(P, X); if (r.changed) { P = r.S2; touched = X; } }
		}
		lastStart = sim.is_dead ? -1 : start;
		const q0 = sim._tileQueue.length + sim._stateQueue.length + sim._keysQueue.length + (sim._team_tx !== -1 ? 1 : 0);
		E.applyMask(inp, masks[t] & 31);
		sim.tick(inp);
		const tick = t + 1;
		const tile = T.tileOf(sim, W, H);
		// usage
		if (sim.has_levitation) u('fly'); if (sim.flip_gravity) u('gravity ' + sim.flip_gravity); if (sim.max_jumps !== 1) u('multijump ' + (sim.max_jumps >= 1000 ? 'inf' : sim.max_jumps));
		if (sim.jump_boost) u('jump boost ' + sim.jump_boost); if (sim.speed_boost) u('speed boost ' + sim.speed_boost); if (sim.low_gravity) u('low gravity');
		if (sim.is_cursed) u('curse'); if (sim.is_zombie) u('zombie'); if (sim.is_poisoned) u('poison'); if (sim.is_on_fire) u('fire (lava)'); if (sim.is_invulnerable) u('protection');
		if (sim._slippery > 0) u('ice (slippery)'); if (sim.is_dead) u('dead');
		const cur = sim.current_tile;
		if (cur === 119) u('in water'); else if (cur === 369) u('in mud'); else if (cur === 416) u('in lava'); else if (cur === 1585) u('in toxic');
		else if (cur >= 114 && cur <= 117) u('on boost'); else if (cur === 1 || cur === 2 || cur === 3 || cur === 1518 || cur === 411 || cur === 412 || cur === 413 || cur === 1519) u('on arrow'); else if (cur === 4 || cur === 414) u('on dot');
		else if (L.flags[cur] & 32) u('climbable');
		if (sim._timedoor_state !== undefined && L.hasTimeDoors) u('timedoor level tick');
		if (sim._keysMask) u('key active');
		if (sim._tileQueue.length) u('retry pending: purple switch'); if (sim._stateQueue.length) u('retry pending: orange switch / crown'); if (sim._keysQueue.length) u('retry pending: key');
		if (sim._team_tx !== -1 && sim._lookup[sim._team_ty * W + sim._team_tx] !== sim.team) u('retry pending: team');
		for (let c = 0; c < 6; c++) if (sim._kt[c] !== kt[c]) { if (lastKeyOn[c] >= 0 && (sim._keysMask >> c) & 1) hit(`key ${c} timer refreshed by a re-touch (model: no timers)`, { tick, tile: [tile % W, (tile / W) | 0], sinceOn: tick - lastKeyOn[c] }); lastKeyOn[c] = tick; kt[c] = sim._kt[c]; }
		// (1) state
		const s2 = sig();
		const Rbefore = R;
		if (s2 !== sg) { R = M.stateOf(sim); sg = s2; }
		else if (touched && (touched.kind === 'coin' || touched.kind === 'bcoin')) R = M.stateOf(sim);
		// (1b) the model's pendingOf (newer model.js): the state a deferred change will make, checked when the retry lands
		if (typeof M.pendingOf === 'function') {
			if (pend && R !== Rbefore && R.dkey !== Rbefore.dkey) {
				const lands = sim._tileQueue.length + sim._stateQueue.length + sim._keysQueue.length === 0;
				if (lands) hit(R.dkey === pend.dkey ? 'pendingOf: predicted the deferred change exactly' : 'pendingOf: the deferred change landed differently', { tick, P: pend.dkey.slice(0, 80), R: R.dkey.slice(0, 80) });
			}
			pend = M.pendingOf(sim, R);
			if (pend && pend.dkey === R.dkey) pend = null;
		}
		if (P.key !== R.key) {
			const q1 = sim._tileQueue.length + sim._stateQueue.length + sim._keysQueue.length + (sim._team_tx !== -1 ? 1 : 0);
			const why = [];
			for (const f of M.feats) {
				const pv = P.feats[f], rv = R.feats[f];
				if (pv === rv) continue;
				let c;
				if (f === 'deaths') c = 'deaths: a death (the model has no touch for it; the planner\'s death steps)';
				else if (f.startsWith('key') && pv === 1 && rv === 0) c = `${f}: expired (500 ticks after its last touch; model keys are sticky)`;
				else if (touched && redirect) c = `${f}: half-block redirect (the engine touched the cell beside the centre)`;
				else if (f === 'team' && sim._team_tx !== -1 && sim._lookup[sim._team_ty * W + sim._team_tx] !== sim.team) c = 'team: deferred (the team change would shut a team door on the ball: retried every tick)';
				else if (f === 'team' && !touched) c = 'team: a deferred team retry applied';
				else if (touched && q1 > q0) c = `${f}: deferred (the change would shut a door on the ball: reverted, retried later)`;
				else if (!touched && q1 < q0) c = `${f}: a deferred retry applied (no touch this tick)`;
				else if (!touched && redirect) c = `${f}: touched through a half-block redirect (model: not the centre tile)`;
				else if ((f === 'coins' || f === 'bcoins') && touched) c = `${f}: the model takes the whole coin component at once (${touched.tiles.length} tiles)`;
				else if (!touched) c = `${f}: changed with no model touch (${start === lastStart ? 'same cell' : 'entered ' + fg[start]})`;
				else c = `${f}: other (touch ${touched.kind} ${touched.param})`;
				why.push(c);
				hit(c, { tick, tile: [tile % W, (tile / W) | 0], P: pv, R: rv });
			}
			// taken coin tiles (only where a coin door / gate exists)
			for (const [tk, rk, nm] of [[P.taken, R.taken, 'coin'], [P.btaken, R.btaken, 'blue coin']]) {
				if (!tk || !rk) continue;
				let d = 0;
				for (let k = 0; k < tk.length; k++) if (tk[k] !== rk[k]) d++;
				if (d && !why.some((w) => w.startsWith(nm === 'coin' ? 'coins' : 'bcoins'))) hit(`${nm} tiles taken differ (count equal): ${touched ? 'component rule' : 'no touch'}`, { tick, n: d });
			}
			if (P.cp !== R.cp) hit(`cp: ${touched && touched.kind === 'cp' ? 'other' : sim.is_dead || prevDead ? 'respawn' : 'checkpoint touched off the centre tile'}`, { tick, P: P.cp, R: R.cp });
			P = R;
		}
		// (2) doors: near the ball every tick; all at every change of R and every 250 ticks
		{
			const cx = tile % W, cy = (tile / W) | 0, near = [];
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < W && y < H && A.cls[y * W + x] === 3) near.push(y * W + x); }
			if (near.length) checkGates(near, tick, ' [near]');
			if (R !== evR || tick % 250 === 0) checkGates(gateTiles, tick, ' [all]');
		}
		// (3) geometry
		if (!sim.is_dead) {
			const m = M.passMask(R, 'lb', R.feats);
			if (!m[tile]) hit(`UNSOUND centre tile walled in the lb mask: ${fg[tile]} rot ${L.lookup0[tile]}`, { tick, tile: [tile % W, (tile / W) | 0] });
			if (tile !== prevTile && !prevDead) {
				const ax = prevTile % W, ay = (prevTile / W) | 0, bx = tile % W, by = (tile / W) | 0;
				const dx = bx - ax, dy = by - ay;
				if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
					let d = -1;
					for (let k = 0; k < 8; k++) if (DX8[k] === dx && DY8[k] === dy) d = k;
					const bad = m[prevTile] ? moveOK(m, prevTile, d) : null;
					if (bad && !sim.teleported) hit(`UNSOUND lb move forbidden (${bad}): ${fg[prevTile]}->${fg[tile]}`, { tick, from: [ax, ay], to: [bx, by] });
				} else if (!sim.teleported) hit('centre jumped > 1 tile without a teleport', { tick, from: [ax, ay], to: [bx, by] });
				else u('teleports');
			}
		}
		// (4) bound between consecutive changes of R
		if (R !== evR) {
			if (!sim.is_dead && !prevDead) {
				const lb = M.pairLb(evR, { id: 'n4u' + evTile, tiles: [evTile] }, [tile], 'lb', evR.feats);
				const gap = tick - evTick;
				lbChecks++;
				if (lb > gap) { lbViol++; hit('UNSOUND pairLb > the route\'s ticks between two events', { tick, from: [evTile % W, (evTile / W) | 0], to: [tile % W, (tile / W) | 0], lb, gap }); }
				else if (isFinite(lb)) { lbSlackMin = Math.min(lbSlackMin, gap - lb); lbRatioSum += gap > 0 ? lb / gap : 1; }
			}
			evR = R; evTick = tick; evTile = tile;
		}
		prevTile = tile; prevDead = sim.is_dead;
	}
	return { name: entry.name, source: entry.source, route: path.relative(root, entry.route), W, H, ticks: masks.length, runTicks: tr.runTicks, deaths: tr.deaths,
		feats: M.feats, triggers: M.triggers.length, relevant: M.triggers.filter((X) => X.relevant).length, gates: M.gates.length, gateTiles: gateTiles.length,
		cls, ex, use, lbChecks, lbViol, lbSlackMin: isFinite(lbSlackMin) ? lbSlackMin : null, lbRatioMean: lbChecks ? +(lbRatioSum / lbChecks).toFixed(3) : null, ms: Date.now() - t0 };
}

const all = TS.knownRoutes({ root });
const mine = all.filter((e, k) => k % shard[1] === shard[0] && (!only || e.name.includes(only))).slice(0, maxRoutes);
const outFile = path.join(outDir, `modelexact_${shard[0]}of${shard[1]}${only ? '_' + only.replace(/\W+/g, '_') : ''}.jsonl`);
fs.writeFileSync(outFile, '');
let n = 0;
for (const e of mine) {
	let r;
	try { r = checkRoute(e); } catch (err) { r = { name: e.name, source: e.source, route: e.route, error: String(err && err.stack || err).slice(0, 600) }; }
	fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
	n++;
	const bad = r.cls ? Object.entries(r.cls).filter(([k]) => k.startsWith('UNSOUND')).reduce((s, [, v]) => s + v, 0) : 0;
	console.log(`${n}/${mine.length} ${r.name} ${r.stale ? 'STALE' : r.error ? 'ERROR ' + r.error.split('\n')[0] : `ticks ${r.ticks} classes ${Object.keys(r.cls).length} unsound ${bad} lb ${r.lbViol}/${r.lbChecks} ${r.ms} ms`}`);
}
