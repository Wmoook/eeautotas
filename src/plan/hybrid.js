'use strict';
// THE HYBRID LEG (n5-hy-leg, 2026-10-01; OPT-IN EEAT_HYBRID=1, off = the compiler byte for byte: strategy.js does not even
// load this file). The compiler hit a wall where the search product does not (main 7cab8c6: 151 of its 183 failures end
// 'legs fail after progress (budget)'; the search product v1.7.1 routes 117 of the 203 campaign levels), so a LEG the
// compiler fails is handed to the search's own machinery as a SOLVER:
//   when  a compiler step (anchor A, plan step s) failed at a rung >= HY_RUNG ('budget'), or the same leg (edge + the
//         anchor's class) failed HY_REPEAT times from any anchor of that class (the stall);
//   start the anchor's exact state: its earliest arrival's inputs as goexplore.js --prefix (replayed by the engine there);
//   goal  the leg's target: --goalTiles = its waypoint's tiles (the reach field to them orders head A and the bursts' arm;
//         a 'goal' event at a touch), the trophy: the search's own target; the plan's later gates as SOFT guidance: every
//         new room the search enters (--rooms=1) is offered back as an imported state (a new model state = an anchor);
//   how   src/goexplore.js as Find a route starts its one search: the CPU random runs with Find a route's defaults (event
//         options, the frontier field: editor.js GX_DEFAULTS), its GPU bursts (src/bursts.js, eegpu explore) when a GPU
//         tool is there (EEAT_HY_GPU=0: none), HY_W workers, one time slice a call (HY_S s, doubled with each retry);
//   then  every answer is replayed HERE from the level start (strategy.js verified: the waypoint's own goal test, alive;
//         routeOf for a route): its inputs become the leg (tool 'search'), the arrival an anchor, the child is stopped, and
//         the compiler goes on with its own math (planner, executor) for the next legs.
// One child at a time, started only before the first route (a route stops it), never past the moves. A TROPHY leg's search
// gets the moves' whole time left: stopped at its slice's end when it has no route, else it goes on (its after-route heads
// L / W) and every faster route it prints is a route here too, until the moves end (EEAT_HY_TROPHY_ON=0: its slice). The knobs:
// EEAT_HY_RUNG (2), EEAT_HY_MORE_F (0.5) / _MIN (2) / _MAX (15) (after a leg's first arrival its search goes on that share of
// the time it took, in s, and every SOONER arrival at the target is added too: the earliest one leads the anchor), EEAT_HY_REPEAT (2), EEAT_HY_S (60), EEAT_HY_MIN_S (10), EEAT_HY_TRIES (3), EEAT_HY_W (2),
// EEAT_HY_MEM (MB a worker, 1000), EEAT_HY_GPU (1), EEAT_HY_TOOL (the eegpu path), EEAT_HY_ROOMS (the rooms imported a
// call, 24; 0 none), EEAT_HY_GX (more goexplore.js options), EEAT_HY_NICE (0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(+process.env[k]) ? +process.env[k] : d);
const HY_RUNG = num('EEAT_HY_RUNG', 2), HY_REPEAT = num('EEAT_HY_REPEAT', 2), HY_S = num('EEAT_HY_S', 60), HY_MIN_S = num('EEAT_HY_MIN_S', 10);
const HY_TRIES = num('EEAT_HY_TRIES', 3), HY_W = Math.max(1, num('EEAT_HY_W', 2)), HY_MEM = num('EEAT_HY_MEM', 1000), HY_ROOMS = num('EEAT_HY_ROOMS', 24);
const HY_MORE_F = num('EEAT_HY_MORE_F', 0.5), HY_MORE_MIN = num('EEAT_HY_MORE_MIN', 2) * 1000, HY_MORE_MAX = num('EEAT_HY_MORE_MAX', 15) * 1000;
// THE GATE (EEAT_HY_GATE=0: off, every answer at once): the search's leg arrivals (and the rooms it entered) are HELD, so
// the compiler's own path stays the compiler's while it goes on: a leg's arrival is given to it when the executor fails that
// leg (the same anchor and step) once more, after HY_HOLD_S s, when the compiler has made no new anchor for HY_STALE_S s,
// or when the executor has nothing left; dropped when the executor solves that leg itself. (The one shot's and the gated
// chain's lesson: arrivals given at once take the executor's picks: a first route sooner, a slower final; v1 of this lane:
// 1.08x the run ticks where both arms compiled, EZ Spooky Shack 1.98x.) The rooms: on the stale clock or the end alone.
const HY_GATE = process.env.EEAT_HY_GATE !== '0', HY_HOLD_S = num('EEAT_HY_HOLD_S', 30), HY_STALE_S = num('EEAT_HY_STALE_S', 45);
const HY_GPU = process.env.EEAT_HY_GPU !== '0', HY_NICE = num('EEAT_HY_NICE', 0), HY_TROPHY_ON = process.env.EEAT_HY_TROPHY_ON !== '0';
// (Find a route's goexplore.js defaults: editor.js GX_DEFAULTS, kept in step by hand: this file must not load the editor)
const GX_DEFAULTS = ['--opts=1', '--frontier=1', '--fBrake=1', '--fPhys=1'];
const EXTEND = 3;   // (a goal touch: the last input held up to this many ticks more for the waypoint's test, bursts.js extend)

/** a waypoint the search can take: the trophy, or tiles (a trigger, a region); no death step, no deadline */
function okWp(step, wp) {
	if (!step || !wp || step.synthetic || wp.allowDeath || wp.dieField) return false;
	if (Number.isFinite(+wp.beforeTick) || wp.beforeRel !== undefined || step.beforeTickFrom !== undefined || wp.beforeTickFrom !== undefined) return false;
	if (wp.kind === 'trophy') return true;
	return (Array.isArray(wp.tiles) || ArrayBuffer.isView(wp.tiles)) && wp.tiles.length > 0;
}

/**
 * createHybrid(ctx): ctx = {L, file, T, E, say, left (ms), hasRoute (), stopped (), verified (step, wp, res, starts),
 * routeOf (masks, how, legId), addArrival (a, S, parent, why, step) -> {anchor, isNew}, stateOf (sim), simOf (a),
 * importRun (masks, parent, fromTick, why) -> a new anchor | null, labelOf, edgeKey, depth (), RM, anchorsN ()}
 * -> {note (A, step, wp, plan, ok, why), schedule (), harvest (), hold () async, stop (), stats}
 */
function createHybrid(ctx) {
	const { L, T, E } = ctx;
	const GATE = ctx.gate !== undefined ? !!ctx.gate : HY_GATE;
	const cands = new Map();        // `${A.id}|${edgeKey}` -> {A, step, wp, cost, rung, n, why, tries, solved, inflight, seq}
	const classFails = new Map();   // edgeKey (the edge + the anchor class) -> failures from any anchor of that class
	const stats = { requests: 0, ok: 0, legs: 0, routes: 0, rooms: 0, anchors: 0, ms: 0, killed: 0, goals: 0, rejected: 0, errors: 0, gpu: false, byWhy: { rung: 0, stall: 0 } };
	let child = null, busy = null, seq = 0, q = [];
	// (THE GATE: the held answers {kind 'leg' | 'room', c, t, ...}; the compiler's anchors' count and when it last grew)
	const held = [];
	let anchorsN = -1, anchorAt = Date.now();
	Object.assign(stats, { held: 0, released: 0, dropped: 0 });
	/** an answer to the compiler: a leg's verified arrival (an anchor), or a room (importRun) */
	const give = (e) => {
		if (e.kind === 'room') { const B = ctx.importRun(e.masks, e.parent, e.from, 'search room'); if (B) stats.rooms++; return; }
		const { anchor: B, isNew } = ctx.addArrival(e.a, e.S2, e.c.A, e.label, e.c.step);
		if (isNew) {
			stats.anchors++;
			ctx.say({ ev: 'source', kind: 'room', room: e.a.room, desc: e.a.desc, key: B.key, gain: 1, tick: e.a.tick, inputs: T.strOf(e.a.masks), anchor: B.id, label: e.label });
		}
	};
	/** the held answers that pred picks, given (drop: dropped) */
	const release = (pred, why, drop) => {
		let n = 0;
		for (let i = 0; i < held.length;) {
			if (!pred(held[i])) { i++; continue; }
			const e = held.splice(i, 1)[0];
			n++;
			if (drop) stats.dropped++; else { stats.released++; give(e); }
		}
		if (n) ctx.say({ ev: 'hybrid', what: drop ? 'drop' : 'release', why, n, held: held.length });
		return n;
	};
	/** the gate's clocks, every loop turn: a leg held past HY_HOLD_S, everything when no new anchor came for HY_STALE_S */
	const gateTurn = () => {
		if (!held.length) return;
		const n = ctx.anchorsN ? ctx.anchorsN() : 0, now = Date.now();
		if (n !== anchorsN) { anchorsN = n; anchorAt = now; }
		if (now - anchorAt > HY_STALE_S * 1000) { release(() => true, 'no new anchor'); anchorAt = now; return; }
		release((e) => e.kind === 'leg' && now - e.t > HY_HOLD_S * 1000, 'held long enough');
	};
	const tool = (() => {
		if (!HY_GPU) return null;
		try {
			const G = require('../gpu.js');
			const t = process.env.EEAT_HY_TOOL || G.nativeTool();
			if (!t || !fs.existsSync(t) || G.unsupported(L)) return null;
			return { tool: t, cache: G.cacheArgs() };
		} catch (e) { return null; }
	})();
	stats.gpu = !!tool;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `eeat_hy_${process.pid}_`));
	const cleanTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } };
	process.once('exit', () => { if (child) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } cleanTmp(); });

	/** a step's result: a failure makes (A, step) a candidate, a success solves it */
	const note = (A, step, wp, plan, ok, why) => {
		if (!okWp(step, wp)) return;
		const ek = ctx.edgeKey(step), rk = `${A.id}|${ek}`;
		let c = cands.get(rk);
		if (!c) { c = { A, step, wp, cost: plan && Number.isFinite(+plan.cost) ? +plan.cost : Infinity, rung: -1, n: 0, why: '', tries: 0, solved: false, inflight: false, seq: seq++ }; cands.set(rk, c); }
		if (ok) { c.solved = true; if (held.length) release((e) => e.kind === 'leg' && e.c === c, 'the executor did it', true); return; }
		c.rung = Math.max(c.rung, step.rung | 0); c.n++; c.why = String(why || '');
		if (held.length) release((e) => e.kind === 'leg' && e.c === c, 'the executor failed it again');
		classFails.set(ek, (classFails.get(ek) || 0) + 1);
	};
	const whyOf = (c) => (c.rung >= HY_RUNG && /budget/.test(c.why) ? 'rung' : (classFails.get(ctx.edgeKey(c.step)) || 0) >= HY_REPEAT ? 'stall' : '');
	/** the candidate of the most progress (gain), then the fewest tries, the least plan cost, the oldest */
	const pick = () => {
		let b = null;
		for (const c of cands.values()) {
			if (c.solved || c.inflight || c.tries >= HY_TRIES || c.A.exhausted || !c.A.arrivals.length || !whyOf(c)) continue;
			if (!b || c.A.gain > b.A.gain || (c.A.gain === b.A.gain && (c.tries < b.tries || (c.tries === b.tries && (c.cost < b.cost || (c.cost === b.cost && c.seq < b.seq)))))) b = c;
		}
		return b;
	};
	/** a call: the search from c's anchor (its earliest arrival) to c's waypoint on a clock of ms */
	const launch = (c, ms) => {
		const a = c.A.arrivals.reduce((m, x) => (x.tick < m.tick ? x : m), c.A.arrivals[0]);
		const id = ++stats.requests;
		const masks = a.masks instanceof Uint8Array ? a.masks : T.masksOf(a.masks);
		const pre = path.join(tmp, `pre_${id}.eetas`);
		fs.writeFileSync(pre, Buffer.from(T.strOf(masks), 'latin1'));
		const trophy = c.wp.kind === 'trophy';
		let goalFile = null;
		if (!trophy) { goalFile = path.join(tmp, `goal_${id}.json`); fs.writeFileSync(goalFile, JSON.stringify(Array.from(c.wp.tiles))); }
		const work = path.join(tmp, `work_${id}`);
		const depth = Number.isFinite(ctx.depth()) ? Math.max(masks.length + 1, ctx.depth()) : 100000;
		// (a trophy leg: the clock of the moves' time left, its slice kept by halt below while it has no route)
		const secs = Math.max(1, Math.round((trophy && HY_TROPHY_ON ? Math.max(ms, ctx.left() - 3000) : ms) / 1000));
		const args = [path.join(__dirname, '..', 'goexplore.js'), String(ctx.file), `--prefix=${pre}`, `--seconds=${secs}`, `--workers=${HY_W}`, `--seed=${1 + 1000 * id}`,
			`--depth=${depth}`, '--stdin=1', '--rooms=1', `--mem=${HY_MEM}`, ...(goalFile ? [`--goalTiles=${goalFile}`] : []),
			...(tool ? ['--bursts=1', `--tool=${tool.tool}`, ...tool.cache, `--work=${work}`] : []), ...(HY_NICE > 0 ? [`--nice=${HY_NICE}`] : []),
			...GX_DEFAULTS, ...String(process.env.EEAT_HY_GX || '').split(/\s+/).filter((s) => /^--[A-Za-z]+=\S+$/.test(s))];
		let ch;
		// (goexplore.js without a V8 heap flag: one in NODE_OPTIONS would cap every worker's heap: common.js workerHeapEnv)
		const env = Object.assign({}, process.env);
		if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--max[-_]old[-_]space[-_]size[= ]\d+/g, '').trim();
		try { ch = cp.spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], env }); } catch (e) { stats.errors++; ctx.say({ ev: 'warning', text: `the hybrid's search: ${e.message}` }); return false; }
		child = ch;
		busy = { id, c, a, t: Date.now(), ms, trophy, rooms: 0, solved: false, why: whyOf(c), done: false, slice: Date.now() + ms, more: Infinity, bestT: Infinity };
		c.inflight = true; c.tries++;
		stats.byWhy[busy.why] = (stats.byWhy[busy.why] || 0) + 1;
		ctx.say({ ev: 'hybrid', what: 'request', id, anchor: c.A.id, gain: c.A.gain, label: ctx.labelOf(c.step), rung: c.rung, fails: c.n, why: busy.why, from: a.tick, seconds: secs, gpu: !!tool, goal: trophy ? 'trophy' : `${c.wp.tiles.length} tiles` });
		let buf = '';
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k); buf = buf.slice(k + 1);
				if (line.charCodeAt(0) !== 123) continue;
				try { q.push(Object.assign(JSON.parse(line), { _id: id })); } catch (e) { /* not an event */ }
			}
		});
		ch.stdin.on('error', () => { /* the child ended */ });
		const kill = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }, secs * 1000 + 20000);
		if (kill.unref) kill.unref();
		const gone = () => { clearTimeout(kill); if (child === ch) child = null; q.push({ ev: '_exit', _id: id }); };
		ch.on('error', gone);
		ch.on('close', gone);
		return true;
	};
	/** stop the running child: "stop" on its stdin (its bursts' eegpu end at a launch's end: --parent), then the kill */
	const halt = (why) => {
		const ch = child;
		if (!ch) return;
		try { ch.stdin.write('stop\n'); } catch (e) { /* gone */ }
		const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
		if (t.unref) t.unref();
		if (busy && !busy.halted) { busy.halted = why; stats.killed++; ctx.say({ ev: 'hybrid', what: 'stop', id: busy.id, why }); }
	};
	/** inputs (masks from the level start) that touch the leg's target: cut at the waypoint's own goal test (the last input
	 *  held up to EXTEND ticks more), verified like an executor arrival -> the arrivals added (true when one was) */
	const tryLeg = (b, masks, kind) => {
		const c = b.c;
		if (masks.length <= b.a.tick) return false;
		let ms = masks;
		if (!b.trophy) {
			// (the cut: from the anchor's own state (its snapshot, checked by its hash; else a replay of its inputs), the
			// leg's ticks until the waypoint's test holds; a death on the way: none (the verify below replays it all again))
			const goal = T.goalOf(L, c.wp);
			const ext = new Uint8Array(masks.length + EXTEND);
			ext.set(masks, 0);
			for (let k = 0; k < EXTEND; k++) ext[masks.length + k] = masks[masks.length - 1] & 31;
			let sim = null;
			if (b.a.snap) { try { sim = new E.EESim(L); sim.reset(); sim.restore(b.a.snap); if (b.a.hash && sim.stateHash() !== b.a.hash) sim = null; } catch (e) { sim = null; } }
			if (sim === null) sim = T.playTo(L, ext.subarray(0, b.a.tick), { allowDeath: true }).sim;
			const inp = new E.EEInput();
			let gAt = -1;
			for (let t = b.a.tick; t < ext.length; t++) {
				E.applyMask(inp, ext[t] & 31);
				sim.tick(inp);
				if (sim.is_dead) break;
				if (goal.test(sim)) { gAt = t + 1; break; }
			}
			if (gAt < 0) return false;
			ms = ext.subarray(0, gAt);
		}
		const res = { ok: true, arrivals: [{ masks: ms }], legs: [{ start: 0, ticks: ms.length - b.a.tick, lb: null, proven: false, tool: 'search' }], tool: 'search' };
		const { arr, routes } = ctx.verified(c.step, c.wp, res, [b.a]);
		let any = false;
		for (const r of routes) { const x = ctx.routeOf(r.masks, `the search (hybrid: ${ctx.labelOf(c.step)})`, r.leg); stats.routes++; any = true; if (x && x.better) ctx.say({ ev: 'hybrid', what: 'route', id: b.id, runTicks: x.ev.runTicks }); }
		for (const a of arr) {
			let S2;
			try { S2 = ctx.stateOf(ctx.simOf(a)); } catch (e) { continue; }
			const e = { kind: 'leg', c, a, S2, label: `${ctx.labelOf(c.step)} (search)`, t: Date.now() };
			any = true;
			if (GATE && !c.solved) { held.push(e); stats.held++; } else give(e);
		}
		if (any) { stats.legs++; ctx.say({ ev: 'hybrid', what: 'leg', id: b.id, kind, label: ctx.labelOf(c.step), from: b.a.tick, tick: ms.length, ticks: ms.length - b.a.tick, ms: Date.now() - b.t }); }
		else stats.rejected++;
		return any;
	};
	/** the children's events, in the loop's turns */
	const harvest = () => {
		while (q.length) {
			const m = q.shift();
			const b = busy && busy.id === m._id ? busy : null;
			if (!b) continue;
			if (m.ev === '_exit') {
				stats.ms += Date.now() - b.t;
				if (b.solved) stats.ok++;
				b.c.inflight = false;
				if (b.solved) b.c.solved = true;
				ctx.say({ ev: 'hybrid', what: 'done', id: b.id, ok: b.solved, rooms: b.rooms, ms: Date.now() - b.t, why: b.halted || b.end || 'ended' });
				busy = null;
				continue;
			}
			if (m.ev === 'done') { b.end = m.end; continue; }
			if (typeof m.inputs !== 'string' || !m.inputs) continue;
			// (the leg solved: only a trophy leg's search goes on, its faster routes)
			if (b.solved && !(b.trophy && m.ev === 'result' && m.kind === 'finish') && !(!b.trophy && m.ev === 'goal')) continue;
			const masks = T.masksOf(m.inputs.replace(/[^0-O]/g, ''));
			if (m.ev === 'result' && m.kind === 'finish') {
				// (a route of the search: a route (routeOf replays it), and the leg when it passes the leg's target)
				if (b.trophy) { if (tryLeg(b, masks, 'route')) b.solved = true; continue; }
				const x = ctx.routeOf(masks, `the search (hybrid, from ${ctx.labelOf(b.c.step)})`, null);
				if (x) { stats.routes++; if (x.better) ctx.say({ ev: 'hybrid', what: 'route', id: b.id, runTicks: x.ev.runTicks }); }
				if (tryLeg(b, masks, 'route')) b.solved = true;
				halt('a route');
			} else if (m.ev === 'goal') {
				stats.goals++;
				// (after the first: only a sooner touch, until the extra time is over)
				if (b.solved && !(m.t < b.bestT)) continue;
				if (tryLeg(b, masks, 'goal')) {
					if (!b.solved) { b.solved = true; b.more = Date.now() + Math.min(HY_MORE_MAX, Math.max(HY_MORE_MIN, (Date.now() - b.t) * HY_MORE_F)); }
					b.bestT = Math.min(b.bestT, +m.t || Infinity);
					if (!(HY_MORE_F > 0) || Date.now() >= b.more) halt('the leg');
				}
			} else if (m.ev === 'room') {
				// (a room the search entered: a new model state = an anchor, the plan's later gates as soft guidance; the leg's
				// own target, when its touch changes the room, comes as a 'goal' event too)
				if (HY_ROOMS > 0 && b.rooms < HY_ROOMS) { b.rooms++; const e = { kind: 'room', c: b.c, masks, parent: b.c.A, from: b.a.tick, t: Date.now() }; if (GATE) { held.push(e); stats.held++; } else give(e); }
			}
		}
	};
	/** an idle slot: the next candidate, before the first route, on a slice of the time left */
	const schedule = () => {
		gateTurn();
		if (child && busy && !busy.solved && !busy.halted && Date.now() > busy.slice) halt('the slice');
		if (child && busy && busy.solved && !busy.trophy && !busy.halted && Date.now() >= busy.more) halt('the leg');
		// (a trophy leg's search that has its route gives the slot to another failed leg)
		if (child && busy && busy.trophy && busy.solved && !busy.halted && !ctx.hasRoute() && pick()) halt('another leg');
		if (child || busy || ctx.stopped() || ctx.hasRoute()) { if (child && busy && ctx.hasRoute() && !(busy.trophy && busy.solved)) halt('a route'); return; }
		const c = pick();
		if (!c) return;
		const ms = Math.min(HY_S * 1000 * (1 << Math.max(0, c.tries)), ctx.left() - 3000);
		if (ms < HY_MIN_S * 1000) return;
		launch(c, ms);
	};
	/** the executor has nothing left and would end: while a search works (no route, time left) the loop waits a turn */
	const hold = async () => {
		if (ctx.hasRoute() || ctx.stopped() || ctx.left() <= 1000) return false;
		harvest();
		if (held.length && release(() => true, 'the executor has nothing left')) return true;
		schedule();
		if (!busy) return false;
		await new Promise((res) => { const tt = setTimeout(res, 250); if (tt.unref) tt.unref(); });
		harvest();
		return true;
	};
	const stop = () => { harvest(); if (child) { halt('the end'); try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } cleanTmp(); };
	return { note, schedule, harvest, hold, stop, stats, busy: () => !!busy, held: () => held.length };
}

module.exports = { createHybrid, okWp };
