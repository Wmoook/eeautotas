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
	const tries = sched.length ? sched.map((c) => ({ clock: c })) : [{}, { relay: 16, relayMin: 10 }, { relay: 16, relayMin: 10, vxq: 4, ladder: 1 }];
	let r = null;
	for (let i = 0; i < tries.length; i++) {
		const rest = ms - (Date.now() - t0);
		if (i > 0 && (rest < 15000 || !r || r.ok || /walk|bug|target/.test(r.why || ''))) break;
		const tr = Object.assign({}, tries[i]), clock = tr.clock; delete tr.clock;
		r = B.solve(snap, tgt, Object.assign({ ms: clock && i < tries.length - 1 ? Math.min(clock, rest) : rest }, tr));
		out({ ev: 'try', n: i + 1, ok: !!r.ok, why: r.why || null, ms: Date.now() - t0 });
	}
	// (the trophy is touched a tick after the centre is in its tile: the last direction held, then released)
	const finishOf = (masks) => {
		const last = masks.length ? masks[masks.length - 1] & 30 : 0;
		for (const tail of [[last], [last, last], [0], [last, 0, 0]]) {
			const ev = C.evaluate(L, Uint8Array.from([...masks, ...tail]));
			if (ev) { out({ ev: 'result', kind: 'finish', inputs: T.strOf(ev.ms), runTicks: ev.runTicks, deaths: ev.deaths }); return true; }
		}
		return false;
	};
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
