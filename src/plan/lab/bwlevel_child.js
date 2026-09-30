'use strict';
// THE WHOLE LEVEL AS ONE LEG, as a child process of the compiler (strategy.js, OPT-IN EEAT_BW_LEVEL=1): the lab's backward
// solver (backward.js) from the level's start state to the trophy's tiles, next to the compile's own moves (it never blocks
// the compiler's thread). A level whose trophy needs no trigger first is one leg: the planner's triggers are stepping stones
// the moves stage may not cross, while one solve over the whole corridor can (Stone Ruin Speedrun: 3,892 run ticks in 37 s
// where the compile's moves stage found no route in 300 s). Gated levels end at once ('the start is not in the target's
// walk'). Every route printed is C.evaluate'd here and again by the compiler (routeOf).
//   node src/plan/lab/bwlevel_child.js <level.eelvl | level.json> [--ms=120000] [--wps=<waypoints.json>]
//   stdout: {"ev":"result","kind":"finish","inputs":"0..O","runTicks":N,"deaths":D} then {"ev":"done","end":"finish"|why,"ms":N};
//   with --wps also {"ev":"leg",...} and {"ev":"arrival","inputs":"0..O","label":...} (a trigger's new model state, from the start)
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const T = require(path.join(root, 'src/plan/types.js'));
const MD = require(path.join(root, 'src/plan/model.js'));
const C = require(path.join(root, 'src/common.js'));
const E = require(path.join(root, 'src/eesim.js'));
const BW = require(path.join(root, 'src/plan/lab/backward.js'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const file = argv.find((s) => !s.startsWith('--'));
const ms = +opt('ms', 120000);
const t0 = Date.now();
const LEG_WALK = +opt('legwalk', 60), CUTS_F = +opt('cutsf', 0.6);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let end = 'none';
try {
	const L = T.loadLevelFile(file);
	const M = MD.compileModel(L);
	const sim = new E.EESim(L); sim.reset();
	const B = BW.createBackward(L);
	// (a solve that ends with time left (its relay's candidates spent: 'budget', or 'exhausted') goes again on the time left
	// with a longer relay, then finer x speeds: its clock's shares and its commitments differ; the closure memo is reused)
	const tgt = { tiles: M.trophyTiles.slice() }, snap = sim.snapshot();
	// (--sched=a,b,..: restarts on those clocks, ms each (the solve's shares are fractions of its clock: its quick meet, the
	// closure's, the relay's steps; a longer clock is not a superset of a shorter one), the last one the time left)
	// the default: 0.4 of the clock, then the rest (box 5, 150 s, Stone Ruin + the sweep's 4 finishers: 4 of 5 with the two
	// clocks, On And On And On and Gravity's Rainbow on the second; one clock of 150 s lost On And On in 1 of 2 runs and
	// Stone Ruin in 2 of 2, which a 90-s clock had solved in 37 s; --sched=0: one solve on the whole clock, then the relay /
	// speed variants on the time left)
	const sched = opt('sched', '') === '0' ? [] : opt('sched', '') ? String(opt('sched', '')).split(',').map(Number).filter((x) => x > 0) : [Math.round(ms * 0.4), ms];
	// (--cuts=1: after the first clock, the cut chain below on CUTS_F of what is left, then the whole leg again on the rest)
	const cutsOn = opt('cuts', '0') === '1';
	const tries = sched.length ? sched.map((c) => ({ clock: c })) : [{}, { relay: 16, relayMin: 10 }, { relay: 16, relayMin: 10, vxq: 4, ladder: 1 }];
	let r = null;
	const tryAll = (from) => {
		for (let i = from; i < tries.length; i++) {
			const rest = ms - (Date.now() - t0);
			if (i > 0 && (rest < 15000 || !r || r.ok || /walk|bug|target/.test(r.why || ''))) break;
			const tr = Object.assign({}, tries[i]), clock = tr.clock; delete tr.clock;
			r = B.solve(snap, tgt, Object.assign({ ms: clock && i < tries.length - 1 ? Math.min(clock, rest) : rest }, tr));
			out({ ev: 'try', n: i + 1, ok: !!r.ok, why: r.why || null, ms: Date.now() - t0 });
			if (cutsOn && i === 0 && tries.length > 1) break;
		}
	};
	tryAll(0);
	// (the trophy is touched a tick after the centre is in its tile: the last direction held, then released)
	const finishOf = (masks) => {
		const last = masks.length ? masks[masks.length - 1] & 30 : 0;
		for (const tail of [[last], [last, last], [0], [last, 0, 0]]) {
			const ev = C.evaluate(L, Uint8Array.from([...masks, ...tail]));
			if (ev) { out({ ev: 'result', kind: 'finish', inputs: T.strOf(ev.ms), runTicks: ev.runTicks, deaths: ev.deaths }); return true; }
		}
		return false;
	};
	// THE CUTS (--cuts=1; strategy.js EEAT_BW_CUTS): a long one-leg level cut where every way must cross. In the start's
	// gravity-blind walk (8-way, no corner cut between two walls, portals both ways, time doors open: the solver's own
	// corridor walk) with dS the walk distance from the start and D = dS at the trophy, every path from the start to the
	// trophy crosses C_d = {v : dS(v) = d, and v reaches the trophy through tiles of dS >= d} at its last visit to level d
	// (a step changes dS by at most 1), for every d < D: C_d is an exact cut of the walk, the pockets at the same distance
	// left out (m(v) = the best bottleneck min dS over v's paths to the trophy, one max-bottleneck sweep from the trophy:
	// v in C_d iff dS(v) = d = m(v)). The chain: legs to the NARROWEST such cut near every LEG_WALK tiles of dS, each by the
	// backward solver from the exact state the leg before left, then the trophy; a leg that fails skips to the next cut.
	// A cut of the start state's walk is not a cut of the physics (a trigger may open another way): the chain is one more
	// way to the trophy, and every route is C.evaluate'd.
	const cutChain = (clockMs) => {
		const tc = Date.now(), W = L.width, H = L.height, N = W * H;
		const fl = L.flags, st = new E.EESim(L); st.reset();
		const sol = new Uint8Array(N);
		for (let i = 0; i < N; i++) {
			const id = st.tiles[i], fz = fl[id] | 0;
			if ((fz & 1) === 0) continue;
			if (fz & 2) sol[i] = 3;
			else if (fz & (8 | 4)) sol[i] = 4;
			else if (fz & 16) sol[i] = (id === 156 || id === 157) ? 0 : st.is_tile_solid_now(i % W, (i / W) | 0) ? 1 : 0;
			else sol[i] = 1;
		}
		const wall = (u) => sol[u] === 1 || sol[u] === 4;
		const padj = new Map();
		if (L.portalSlot && L.portalsById) {
			const link = (a, b) => { let x = padj.get(a); if (!x) { x = []; padj.set(a, x); } x.push(b); };
			for (let i = 0; i < N; i++) {
				const sl = L.portalSlot[i];
				if (sl < 0 || L.pTarget[sl] === L.pId[sl]) continue;
				const ex = L.portalsById.get(L.pTarget[sl]);
				if (!ex) continue;
				for (let k = 0; k < ex.n; k++) { const e = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (e >= 0 && e < N) { link(i, e); link(e, i); } }
			}
		}
		const nb = (t, fn) => {
			const x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const u = ny * W + nx;
				if (wall(u)) continue;
				if (dx && dy && wall(y * W + nx) && wall(ny * W + x)) continue;
				fn(u);
			}
			const pa = padj.get(t);
			if (pa) for (const u of pa) fn(u);
		};
		const sT = (Math.trunc(st.py + 8) >> 4) * W + (Math.trunc(st.px + 8) >> 4);
		const dS = new Int32Array(N).fill(-1), q = new Int32Array(N);
		let qh = 0, qt = 0;
		dS[sT] = 0; q[qt++] = sT;
		while (qh < qt) { const t = q[qh++]; nb(t, (u) => { if (dS[u] < 0) { dS[u] = dS[t] + 1; q[qt++] = u; } }); }
		const tt = M.trophyTiles.filter((t) => dS[t] >= 0);
		if (!tt.length) return { ok: false, why: 'cuts: no walk to the trophy' };
		const D = Math.min(...tt.map((t) => dS[t]));
		if (D < 2 * LEG_WALK) return { ok: false, why: 'cuts: a short walk (' + D + ')' };
		// (m: the max-bottleneck sweep from the trophy, buckets by value, highest first)
		const m = new Int32Array(N).fill(-1), bk = [];
		const push = (u, v) => { if (v <= m[u]) return; m[u] = v; (bk[v] || (bk[v] = [])).push(u); };
		for (const t of tt) push(t, dS[t]);
		for (let v = bk.length - 1; v >= 0; v--) {
			const b = bk[v];
			if (!b) continue;
			for (let j = 0; j < b.length; j++) { const t = b[j]; if (m[t] !== v) continue; nb(t, (u) => { if (dS[u] >= 0) push(u, Math.min(v, dS[u])); }); }
		}
		const cut = new Map();
		for (let v = 0; v < N; v++) if (dS[v] > 0 && dS[v] < D && m[v] === dS[v]) { let c = cut.get(dS[v]); if (!c) { c = []; cut.set(dS[v], c); } c.push(v); }
		const n = Math.max(1, Math.round(D / LEG_WALK) - 1), picks = [];
		for (let k = 1; k <= n; k++) {
			const d0 = Math.round(k * D / (n + 1));
			let best = -1;
			for (let d = Math.max(1, d0 - 8); d <= Math.min(D - 1, d0 + 8); d++) { const c = cut.get(d); if (c && (best < 0 || c.length < cut.get(best).length)) best = d; }
			if (best > 0 && (!picks.length || best > picks[picks.length - 1])) picks.push(best);
		}
		out({ ev: 'cuts', D, start: [sT % W, (sT / W) | 0], cuts: picks.map((d) => [d, cut.get(d).length, ...cut.get(d).slice(0, 3).map((v) => [v % W, (v / W) | 0])]), ms: Date.now() - tc });
		const legs = [...picks.map((d) => ({ label: 'cut ' + d + ' (' + cut.get(d).length + ' tiles)', tiles: cut.get(d), w: d })), { label: 'trophy', tiles: M.trophyTiles.slice(), w: D, trophy: true }];
		let prefix = new Uint8Array(0), lsim = st, wAt = 0;
		const tEnd = Date.now() + clockMs;
		for (let k = 0; k < legs.length; k++) {
			const lg = legs[k], rest = tEnd - Date.now();
			if (rest < 2000) return { ok: false, why: 'cuts: time at ' + lg.label };
			// (the clock by the walk left: this leg's walk share of it, x 1.5)
			const clock = Math.min(rest, Math.max(4000, 1.5 * rest * (lg.w - wAt) / Math.max(1, D - wAt)));
			const lr = B.solve(lsim.snapshot(), { tiles: lg.tiles }, { ms: clock });
			out({ ev: 'leg', n: k + 1, of: legs.length, label: lg.label, ok: !!lr.ok, T: lr.ok ? lr.T : null, why: lr.why || null, ms: Date.now() - t0 });
			if (!lr.ok) { if (lg.trophy) return { ok: false, why: 'cuts: the trophy leg: ' + (lr.why || '') }; continue; }
			const masks = Uint8Array.from([...prefix, ...lr.masks]);
			if (lg.trophy) return { ok: true, masks };
			const s2 = new E.EESim(L); s2.reset();
			const inp = new E.EEInput();
			for (let t = 0; t < masks.length; t++) { E.applyMask(inp, masks[t] & 31); s2.tick(inp); }
			if (s2.is_dead) continue;
			prefix = masks; lsim = s2; wAt = lg.w;
			out({ ev: 'arrival', inputs: T.strOf(prefix), label: lg.label, ticks: prefix.length, ms: Date.now() - t0 });
		}
		return { ok: false, why: 'cuts: none' };
	};
	if (!r.ok && cutsOn && !/walk|bug|target/.test(r.why || '') && ms - (Date.now() - t0) > 15000) {
		const cr = cutChain(CUTS_F * (ms - (Date.now() - t0)));
		out({ ev: 'try', n: 'cuts', ok: !!cr.ok, why: cr.why || null, ms: Date.now() - t0 });
		if (cr.ok) r = cr;
		else tryAll(1);
	}
	if (r.ok) end = finishOf(r.masks) ? 'finish' : 'no finish';
	else end = r.why || 'none';
	// THE WHOLE LEVEL AS LEGS (--wps=<file.json>: the compile's first plan's waypoints, in order; strategy.js EEAT_BW_LEGS,
	// on with EEAT_BW_LEVEL): a trophy behind a gate ('the start is not in the target's walk': Tutorial 4's blue coin door,
	// Endless Pain's team door) is no one leg, but the plan's triggers are: each waypoint's tiles solved by the same backward
	// solver from the exact state the legs before left (the prefix replayed from the level start), each new model state printed
	// as an arrival (the compiler imports it as an anchor: its moves stage goes on from there), then the trophy from the last
	// one. A leg that fails ends the chain (its later waypoints were planned from the states it did not reach).
	const wpf = opt('wps', '');
	if (!r.ok && wpf && /walk/.test(r.why || '') && ms - (Date.now() - t0) > 10000) {
		let wps = [];
		try { wps = JSON.parse(require('fs').readFileSync(wpf, 'utf8')); } catch (e) { wps = []; }
		wps = wps.filter((w) => w && w.kind !== 'trophy' && Array.isArray(w.tiles) && w.tiles.length);
		let prefix = new Uint8Array(0), lsim = new E.EESim(L); lsim.reset();
		let key = String(M.stateOf(lsim).key), legs = 0;
		const legsOf = [...wps, { kind: 'trophy', label: 'trophy', tiles: M.trophyTiles.slice() }];
		for (let k = 0; k < legsOf.length; k++) {
			const wp = legsOf[k], rest = ms - (Date.now() - t0);
			if (rest < 3000) { end = 'legs: time'; break; }
			// (the clock: the time left over the legs left, the first ones 1.5x: the long first leg is the class's wall)
			const clock = Math.min(rest, Math.max(5000, 1.5 * rest / (legsOf.length - k)));
			const lr = B.solve(lsim.snapshot(), { tiles: wp.tiles }, { ms: clock });
			out({ ev: 'leg', n: k + 1, of: legsOf.length, label: wp.label || wp.kind, ok: !!lr.ok, T: lr.ok ? lr.T : null, why: lr.why || null, ms: Date.now() - t0 });
			if (!lr.ok) { end = 'legs: ' + (wp.label || wp.kind) + ': ' + (lr.why || 'none'); break; }
			const masks = Uint8Array.from([...prefix, ...lr.masks]);
			if (wp.kind === 'trophy') { end = finishOf(masks) ? 'finish (legs)' : 'legs: no finish'; break; }
			// (a trigger is touched a tick after the centre is in its tile: the state a model state key later, else the leg as it is)
			const last = lr.masks.length ? lr.masks[lr.masks.length - 1] & 30 : 0;
			let took = null;
			for (const tail of [[], [last], [last, last], [0]]) {
				const m2 = Uint8Array.from([...masks, ...tail]);
				const s2 = new E.EESim(L); s2.reset();
				const inp = new E.EEInput();
				for (let t = 0; t < m2.length; t++) { E.applyMask(inp, m2[t] & 31); s2.tick(inp); }
				if (s2.is_dead) continue;
				const k2 = String(M.stateOf(s2).key);
				if (k2 !== key) { took = { m2, s2, k2 }; break; }
			}
			if (!took) { end = 'legs: ' + (wp.label || wp.kind) + ': no state change'; break; }
			prefix = took.m2; lsim = took.s2; key = took.k2; legs++;
			out({ ev: 'arrival', inputs: T.strOf(prefix), label: wp.label || wp.kind, ticks: prefix.length, ms: Date.now() - t0 });
		}
	}
} catch (e) { end = 'error: ' + String(e && e.message || e).slice(0, 200); }
out({ ev: 'done', end, ms: Date.now() - t0 });
