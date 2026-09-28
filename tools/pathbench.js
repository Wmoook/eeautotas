'use strict';
// The PATH benchmark: can a search find a better PATH (another way through the level, not a faster execution of the
// same way) in minutes? Every case comes from a place where a better path is KNOWN: the user's own segment (Egg Quest
// II's chimney), a known TAS that goes another way than our AutoTAS run (pathsplit: the token alignment of the two runs;
// geometric: where the two runs' tracks part by more than a few tiles), or a later route of our own of another class
// (Stupid Fox's door-free way, EX Crew's short climb). A case is:
//   - a start: our run's inputs up to tick `fixed` (prefix/<id>.eetas); a finder may leave our run anywhere from there
//     (the whole run is given as the reference, ref/<id>.eetas: our run as it goes on the worse way);
//   - a goal: the ball's centre tile in a box, the room (goexplore.js roomOf desc without the time doors and keys; the
//     keys at least the known's), optionally on the ground, an event seen since the start (a coin, a switch, the
//     trophy), and events that must NOT happen (Forgotten Veil / Infinity Pain: purple switch 0);
//   - par: the ticks the better way takes (the known's), ours: the ticks our run takes to the same goal (or the same
//     token), deadline = fixed + par + slack: a candidate reaching the goal by then FOUND the better path;
//   - a verifier (verify()): the candidate (a whole run from tick 0) must keep our first `fixed` inputs, not die after
//     them, not make a forbidden event, and reach the goal at tick T: ticks = T - fixed; ratio = ticks / par; closed =
//     (ours - ticks) / (ours - par) (0: no better than ours, 1: the known's way, above 1: better than known).
// Nothing here is a proof of anything: a finder that does not find a case says "not found by X in S seconds".
//
// node tools/pathbench.js build [--data=<dir>] [--home=<the jobs' src folder>] [--minDelta=50] [--only=<ids>]
//        the cases (named + mined) from the jobs and the runs listed in NAMED / PAIRS below (read only)
// node tools/pathbench.js list [--data=]                              the cases table
// node tools/pathbench.js verify <case id> <candidate.eetas> [--data=]   one candidate's verdict (JSON)
// node tools/pathbench.js run --finder=<builtin | "cmd with {case} {out} {seconds} {threads}"> [--cases=a,b | --set=named|mined|all]
//        [--seconds=120] [--threads=2] [--par=2] [--json=<file>] [--label=] [--baseline=<json>] [--code=<checkout>]
//        [--stopAt=par|found|never] [--keep=0]
//        scores a finder. A finder is a command: it reads the case JSON ({case}: absolute paths, the goal, par, ...),
//        writes candidate runs (.eetas, whole runs from tick 0) into {out} (a folder; any names; later files may be
//        better) and / or prints {"candidate":"<file>"} lines; the bench verifies each as it lands, stops the finder at
//        --stopAt (par: a candidate at or under par) or after --seconds (+10 s grace), and scores: found (by the
//        deadline), ticks / par, gap closed, seconds to found / to the best.
//        Built-in finders (node tools/pathbench.js finder <name> <case.json> <out> ...): none, ref, known (the controls),
//        optwin (the optimizer's windows: explore.js --hunt=1 exact rejoins, 800-tick windows every 600 over the case),
//        gox (Find a route's CPU search from the start state, TOLD the goal: goexplore.js --prefix on the goal level,
//        whose goal tiles are the trophy), goxb (the same + the GPU bursts), goxr (NOT told: goexplore.js --prefix on
//        the real level, bounded by our run's finish; its faster routes are checked for the goal), goxleap (NOT told:
//        goexplore.js --prefix aimed at our own run's slow places: lag = ticks - --kappa (4) x a tile walk from the
//        start, the --targets (4) largest; the route + our run's inputs from there), leaps (src/leaps.js of
//        --leapsCode, a checkout of the leaps branch, with its eegpu --tool).
// node tools/pathbench.js table <results.json>...: every finder's best per case, side by side.
// node tools/pathbench.js check: the controls (our run never FOUND on its own case; every known candidate verifies).
// --remote="root@host -p N -i key" [--dir=/root/pb_<label>]: the same run on a rented machine (the checkout's src/,
//        this tool and the cases go up; the JSON comes back to --json, default <data>/results/<label>.json).
// --data (default src/out/pathbench under this checkout, git-ignored: the levels and runs are the user's own files, never
// in git): cases.json, levels/<level>.json, levels/<id>_goal.json, prefix/<id>.eetas, ref/<id>.eetas, known/<id>.eetas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'list';
const pos = argv.filter((s) => !s.startsWith('--'));
const opt = {};
for (const s of argv) { const m = /^--([^=]+)=(.*)$/.exec(s); if (m) opt[m[1]] = m[2]; else if (s.startsWith('--')) opt[s.slice(2)] = '1'; }
const DATA = path.resolve(opt.data || path.join(ROOT, 'src', 'out', 'pathbench'));

let C, E, GX;
function engine(code) {
	if (C) return;
	const src = path.join(code || ROOT, 'src');
	C = require(path.join(src, 'common.js'));
	E = C.E;
	GX = require(path.join(src, 'goexplore.js'));
}

// ------------------------------------------------------------------ traces
const TOKEN_KINDS = /^(coin|blue_coin|key|switch|team|checkpoint|effect|death|secret|crown|complete)$/;
/** the room as a goal reads it: roomOf's desc without the time doors' state and the keys (keys: listed apart) */
const roomSans = (d) => d.replace(/timedoors:\w+ ?/g, '').replace(/key:\w+ ?/g, '').trim() || '(start)';
const keysOf = (d) => (d.match(/key:\w+/g) || []).map((k) => k.slice(4)).sort();
const tileOf = (px) => Math.trunc(px + 8) >> 4;

/** the token id of an engine event (pathsplit.js's: switches without a tile, the rest with the event's or the ball's tile) */
function tokenId(k, d, tile) {
	const at = d.tile ? `${d.tile.x},${d.tile.y}` : tile;
	if (k === 'switch') return `switch:${d.kind}:${d.id}:${d.on ? 1 : 0}`;
	if (k === 'effect') return `effect:${d.effect}:${d.on ? 1 : 0}@${at}`;
	if (k === 'key') return `key:${d.color}@${at}`;
	if (k === 'team') return `team:${d.team}@${at}`;
	if (k === 'death') return 'death';
	if (k === 'complete') return 'finish';
	return `${k}@${at}`;
}

/** replays masks (all of them, or up to the finish): per tick after t inputs X, Y (px, top-left), VX, VY, GR (on the
 *  ground), RI (the room: index into rooms[], roomOf desc with keys, without the time doors), the tokens [{t, id, tile,
 *  room}] (every event of TOKEN_KINDS; a room change with no event in its tick: "room:<desc>"), fin (the finish tick or
 *  -1), deaths per tick (DE) */
function traceRun(L, masks, o = {}) {
	engine();
	const RM = o.RM || GX.roomOf(L);
	const s = new E.EESim(L), inp = new E.EEInput();
	s.reset();
	const n = masks.length;
	const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), VX = new Float64Array(n + 1), VY = new Float64Array(n + 1);
	const GR = new Uint8Array(n + 1), RI = new Int32Array(n + 1), DE = new Int32Array(n + 1);
	const rooms = [], roomIx = new Map();
	const rid = (d) => { let k = roomIx.get(d); if (k === undefined) { k = rooms.length; rooms.push(d); roomIx.set(d, k); } return k; };
	const toks = [];
	let pending = [];
	s.onEvent = (k, d) => { if (TOKEN_KINDS.test(k)) pending.push([k, d || {}]); };
	const rec = (t) => {
		X[t] = s.px; Y[t] = s.py; VX[t] = s.speed_x; VY[t] = s.speed_y; GR[t] = s.on_ground ? 1 : 0; DE[t] = s.deaths;
		RI[t] = rid(RM.desc(s).replace(/timedoors:\w+ ?/g, '').trim() || '(start)');
	};
	rec(0);
	let fin = -1, t = 0;
	for (; t < n; t++) {
		E.applyMask(inp, masks[t]);
		s.tick(inp);
		rec(t + 1);
		const tile = `${tileOf(s.px)},${tileOf(s.py)}`;
		for (const [k, d] of pending) toks.push({ t: t + 1, id: tokenId(k, d, tile), tile, room: RI[t + 1] });
		if (!pending.length && RI[t + 1] !== RI[t] && roomSans(rooms[RI[t + 1]]) !== roomSans(rooms[RI[t]])) toks.push({ t: t + 1, id: `room:${roomSans(rooms[RI[t + 1]])}`, tile, room: RI[t + 1] });
		pending = [];
		if (s.has_silver_crown) { fin = t + 1; break; }
	}
	const m = t < n ? t + 1 : n;
	return { n: m, X: X.subarray(0, m + 1), Y: Y.subarray(0, m + 1), VX: VX.subarray(0, m + 1), VY: VY.subarray(0, m + 1), GR: GR.subarray(0, m + 1), RI: RI.subarray(0, m + 1),
		DE: DE.subarray(0, m + 1), rooms, toks, fin };
}

// ------------------------------------------------------------------ the goal and the verifier
/** does the state after t ticks of trace T meet the goal? (the event part is checked by the caller) */
function atGoal(goal, T, t) {
	const tx = tileOf(T.X[t]), ty = tileOf(T.Y[t]);
	if (goal.box && (tx < goal.box[0] || ty < goal.box[1] || tx > goal.box[2] || ty > goal.box[3])) return false;
	if (goal.ground && !T.GR[t]) return false;
	const d = T.rooms[T.RI[t]];
	if (goal.room !== undefined && goal.room !== null) {
		let r = roomSans(d);
		if (goal.roomIgnore) for (const k of goal.roomIgnore) r = r.replace(new RegExp(`\\s*\\b${k}=\\d+`, 'g'), '').trim() || '(start)';
		if (r !== goal.room) return false;
	}
	if (goal.keys && goal.keys.length) { const k = keysOf(d); if (!goal.keys.every((x) => k.includes(x))) return false; }
	return true;
}

/** the first tick >= from at which trace T meets the goal (its event seen in (from, t]), or -1; also the forbidden events
 *  and the deaths after from */
function goalTick(goal, T, from, upTo = T.n) {
	let evSeen = !goal.event;
	const toks = T.toks.filter((x) => x.t > from);
	let ti = 0;
	const bad = [];
	for (let t = from; t <= Math.min(upTo, T.n); t++) {
		while (ti < toks.length && toks[ti].t <= t) {
			const id = toks[ti].id;
			if (goal.event && (id === goal.event || (goal.event.endsWith('@') && id.startsWith(goal.event)))) evSeen = true;
			if (goal.not && goal.not.some((x) => id === x || id.startsWith(x))) bad.push({ t: toks[ti].t, id });
			ti++;
		}
		if (goal.notSwitch && t > from) {
			// (a forbidden switch turned on after the start)
			const on = (u) => { const m = /purple=\[([\d,]+)\]/.exec(T.rooms[T.RI[u]]); return m ? m[1].split(',').map(Number).filter((x) => goal.notSwitch.includes(x)) : []; };
			const now = on(t);
			if (now.length) { const was = on(from); const nw = now.filter((x) => !was.includes(x)); if (nw.length) bad.push({ t, id: `purple switch ${nw.join(',')} on` }); }
		}
		if (bad.length) return { t: -1, bad };
		if (T.DE[t] > T.DE[from] && !goal.deathsOk) return { t: -1, died: t };
		if (t > from && evSeen && atGoal(goal, T, t)) return { t, bad };
	}
	return { t: -1, bad };
}

const levelCache = new Map();
function caseLevel(cs) {
	engine();
	const f = path.join(DATA, cs.level);
	if (!levelCache.has(f)) levelCache.set(f, E.loadLevel(f));
	return levelCache.get(f);
}
function loadCases() {
	const f = path.join(DATA, 'cases.json');
	if (!fs.existsSync(f)) throw new Error(`no cases at ${f}: node tools/pathbench.js build first`);
	return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** a candidate (masks, a whole run from tick 0) against a case: {ok, why, T, ticks, found, ratio, closed} */
function verify(cs, masks) {
	engine();
	const L = caseLevel(cs);
	const pre = C.readEetas(path.join(DATA, cs.prefix));
	if (masks.length <= cs.fixed) return { ok: false, why: `shorter than the fixed start (${masks.length} <= ${cs.fixed})` };
	for (let t = 0; t < cs.fixed; t++) if ((masks[t] & 31) !== (pre[t] & 31)) return { ok: false, why: `input ${t} differs from our run's (the first ${cs.fixed} are fixed)` };
	const upTo = Math.min(masks.length, cs.fixed + Math.max(cs.ours, cs.par) * 3 + 600);
	const T = traceRun(L, masks.subarray(0, upTo));
	const g = goalTick(cs.goal, T, cs.fixed);
	if (g.bad && g.bad.length) return { ok: false, why: `forbidden event ${g.bad[0].id} at tick ${g.bad[0].t}` };
	if (g.died !== undefined) return { ok: false, why: `died at tick ${g.died}` };
	if (g.t < 0) return { ok: false, why: `the goal is not reached within ${upTo} ticks` };
	const ticks = g.t - cs.fixed;
	return { ok: true, T: g.t, ticks, found: g.t <= cs.deadline, ratio: Math.round(ticks / cs.par * 1000) / 1000,
		closed: cs.ours > cs.par ? Math.round((cs.ours - ticks) / (cs.ours - cs.par) * 1000) / 1000 : null };
}

module.exports = { traceRun, atGoal, goalTick, verify, roomSans, keysOf, tokenId };

// ------------------------------------------------------------------ list / verify commands
function list() {
	const K = loadCases();
	console.log(`${K.cases.length} cases in ${DATA} (built ${K.built})`);
	console.log('| case | kind | level | start (fixed) | par | ours | deadline | goal | source |');
	console.log('|---|---|---|---|---|---|---|---|---|');
	for (const c of K.cases) console.log(`| ${c.id} | ${c.kind} | ${c.levelName} | ${c.fixed}${c.startMax > c.fixed ? `..${c.startMax}` : ''} | ${c.par} | ${c.ours} | +${c.deadline - c.fixed} | ${goalText(c.goal)} | ${c.source} |`);
}
function goalText(g) {
	const p = [];
	if (g.box) p.push(`tiles (${g.box[0]}..${g.box[2]}, ${g.box[1]}..${g.box[3]})`);
	if (g.ground) p.push('on the ground');
	if (g.event) p.push(`after ${g.event}`);
	if (g.room !== undefined && g.room !== null) p.push(`room "${g.room}"`);
	if (g.keys && g.keys.length) p.push(`keys ${g.keys.join('+')}`);
	if (g.not && g.not.length) p.push(`never ${g.not.join(', ')}`);
	return p.join(', ');
}
/** check: every case's own controls: our run (ref) must not be FOUND (else the case is no path case), the known
 *  candidate (when there is one) must be found at its ticks. Exit 1 on a failure. */
function check() {
	const K = loadCases();
	engine();
	let bad = 0;
	for (const c of K.cases) {
		const vr = verify(c, C.readEetas(path.join(DATA, c.ref)));
		const vk = c.known ? verify(c, C.readEetas(path.join(DATA, c.known))) : null;
		// (a known line slower than par, e.g. the known run's inputs from our slightly different state, is kept as a
		// reachable bound: it must verify at its ticks, found or not)
		const ok = !(vr.ok && vr.found) && (!vk || (vk.ok && vk.ticks === c.knownTicks && vk.found === (c.knownTicks <= c.deadline - c.fixed)));
		if (!ok) bad++;
		console.log(`${ok ? 'ok ' : 'BAD'} ${c.id}: ours ${vr.ok ? `${vr.ticks} ticks, found ${vr.found}` : `refused (${vr.why})`}${vk ? `; known ${vk.ok ? `${vk.ticks} ticks, found ${vk.found}` : `refused (${vk.why})`}` : ''}`);
	}
	console.log(`${K.cases.length - bad}/${K.cases.length} cases check`);
	if (bad) process.exitCode = 1;
}
/** table <results.json>...: the cases (par, ours, the known from our state) with every result's best per case (a
 *  label's several files, e.g. a rerun of some cases, are merged: the later file's rows win) */
function table() {
	const K = loadCases();
	const res = new Map();
	for (const f of pos) {
		const r = JSON.parse(fs.readFileSync(f, 'utf8'));
		const lb = opt.byFinder ? r.finder : r.label.replace(/_(tok|c13|re)$/, '');
		if (!res.has(lb)) res.set(lb, new Map());
		for (const x of r.cases) res.get(lb).set(x.case, x);
	}
	const labels = [...res.keys()];
	console.log(`| case | level | start | par | ours | known from our state | ${labels.join(' | ')} |`);
	console.log(`|---|---|---|---|---|---|${labels.map(() => '---|').join('')}`);
	const tot = labels.map(() => ({ n: 0, found: 0, closed: 0 }));
	for (const c of K.cases) {
		const cells = labels.map((lb, i) => {
			const x = res.get(lb).get(c.id);
			if (!x) return '-';
			tot[i].n++;
			if (x.found) tot[i].found++;
			const cl = x.best && x.best.closed !== null ? Math.max(0, Math.min(1.5, x.best.closed)) : 0;
			tot[i].closed += cl;
			return x.best ? `${x.found ? '**FOUND** ' : ''}${x.best.ticks} (closed ${x.best.closed})${x.found ? `, ${x.secFound} s` : ''}` : `no${x.rejected ? ` (${x.rejected} refused)` : ''}`;
		});
		console.log(`| ${c.id} | ${c.levelName} | ${c.fixed}${c.startMax > c.fixed ? `..${c.startMax}` : ''} | ${c.par} | ${c.ours} | ${c.known ? c.knownTicks : '-'} | ${cells.join(' | ')} |`);
	}
	console.log(`| **all** | | | | | ${K.cases.filter((c) => c.known).length} | ${tot.map((t) => `found ${t.found}/${t.n}, mean closed ${t.n ? (t.closed / t.n).toFixed(3) : '-'}`).join(' | ')} |`);
}
function verifyCmd() {
	const K = loadCases();
	const cs = K.cases.find((c) => c.id === pos[0]);
	if (!cs) throw new Error(`no case ${pos[0]} (node tools/pathbench.js list)`);
	engine();
	console.log(JSON.stringify(Object.assign({ case: cs.id, par: cs.par, ours: cs.ours, deadline: cs.deadline }, verify(cs, C.readEetas(pos[1])))));
}

// ------------------------------------------------------------------ mining: where our run and a known run part
/** the tick the run timer starts at (the first tick with any input): the 'start' anchor */
function timerStartOf(masks) { for (let t = 0; t < masks.length; t++) if (masks[t] & 31) return t; return 0; }

/** token stretches (pathsplit.js): the LCS of the two token lists; a stretch between two aligned tokens is OTHER when
 *  either run has an unaligned token in it. Returns every stretch {same, from, to, o0, o1, k0, k1, dO, dK, delta,
 *  onlyOurs, onlyKnown} (o / k: raw ticks in our / the known run) */
function tokenStretches(O, K, oMasks, kMasks) {
	const drop = (T) => T.toks.filter((x) => !x.id.startsWith('checkpoint@') || T.DE[T.n] > 0);
	const a = drop(K), b = drop(O);
	const n = a.length, m = b.length;
	const D = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) D[i][j] = a[i].id === b[j].id ? D[i + 1][j + 1] + 1 : Math.max(D[i + 1][j], D[i][j + 1]);
	const pairs = [];
	for (let i = 0, j = 0; i < n && j < m;) {
		if (a[i].id === b[j].id) { pairs.push([i, j]); i++; j++; } else if (D[i + 1][j] >= D[i][j + 1]) i++; else j++;
	}
	const out = [];
	let pi = -1, pj = -1, pk = timerStartOf(kMasks), po = timerStartOf(oMasks);
	for (const [i, j] of pairs) {
		const uK = a.slice(pi + 1, i), uO = b.slice(pj + 1, j);
		out.push({ same: !uK.length && !uO.length, from: pi < 0 ? 'start' : a[pi].id, to: a[i].id, o0: po, o1: b[j].t, k0: pk, k1: a[i].t,
			dO: b[j].t - po, dK: a[i].t - pk, delta: (b[j].t - po) - (a[i].t - pk), onlyOurs: uO.map((x) => x.id), onlyKnown: uK.map((x) => x.id), kTok: a[i], oTok: b[j] });
		pi = i; pj = j; pk = a[i].t; po = b[j].t;
	}
	return out;
}

/** geometric stretches: a DTW of the two tracks (every `step` ticks; cost = the centres' distance in tiles + 8 when the
 *  rooms differ), then the stretches where the matched distance passes `far` tiles, widened both ways to the last /
 *  first match within `near` tiles: {o0, o1, k0, k1, dO, dK, delta, maxDist} */
function geoStretches(O, K, o = {}) {
	const far = o.far || 3, near = o.near || 1;
	const step = Math.max(1, Math.ceil(Math.max(O.n, K.n) / (o.samples || 3000)));
	const oi = [], ki = [];
	for (let t = 0; t <= O.n; t += step) oi.push(t);
	for (let t = 0; t <= K.n; t += step) ki.push(t);
	if (oi[oi.length - 1] !== O.n) oi.push(O.n);
	if (ki[ki.length - 1] !== K.n) ki.push(K.n);
	const n = oi.length, m = ki.length;
	const oRoom = oi.map((t) => roomSans(O.rooms[O.RI[t]])), kRoom = ki.map((t) => roomSans(K.rooms[K.RI[t]]));
	const geo = (i, j) => {
		const dx = (O.X[oi[i]] - K.X[ki[j]]) / 16, dy = (O.Y[oi[i]] - K.Y[ki[j]]) / 16;
		return Math.sqrt(dx * dx + dy * dy);
	};
	// (the alignment prefers the same room; the stretches are told by the distance alone: a room that differs for the
	// rest of the run, e.g. a switch left on, must not make the rest one stretch)
	const dist = (i, j) => geo(i, j) + (oRoom[i] !== kRoom[j] ? 8 : 0);
	// (dir: 0 diagonal, 1 from i - 1 (ours moved), 2 from j - 1 (known moved))
	const dir = new Uint8Array(n * m);
	let prev = new Float64Array(m).fill(Infinity), cur = new Float64Array(m);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < m; j++) {
			const c = dist(i, j);
			if (i === 0 && j === 0) { cur[j] = c; continue; }
			let best = Infinity, d = 0;
			if (i > 0 && j > 0 && prev[j - 1] < best) { best = prev[j - 1]; d = 0; }
			if (i > 0 && prev[j] < best) { best = prev[j]; d = 1; }
			if (j > 0 && cur[j - 1] < best) { best = cur[j - 1]; d = 2; }
			cur[j] = best + c;
			dir[i * m + j] = d;
		}
		const x = prev; prev = cur; cur = x;
	}
	const path = [];
	for (let i = n - 1, j = m - 1; ;) {
		path.push([i, j]);
		if (i === 0 && j === 0) break;
		const d = dir[i * m + j];
		if (d === 0) { i--; j--; } else if (d === 1) i--; else j--;
	}
	path.reverse();
	const pd = path.map(([i, j]) => geo(i, j));
	const out = [];
	for (let p = 0; p < path.length;) {
		if (pd[p] <= far) { p++; continue; }
		let s = p, e = p;
		while (s > 0 && pd[s] > near) s--;
		while (e < path.length - 1 && pd[e] > near) e++;
		let mx = 0;
		for (let q = s; q <= e; q++) mx = Math.max(mx, pd[q]);
		const [i0, j0] = path[s], [i1, j1] = path[e];
		const r = { o0: oi[i0], o1: oi[i1], k0: ki[j0], k1: ki[j1], maxDist: Math.round(mx * 10) / 10 };
		r.dO = r.o1 - r.o0; r.dK = r.k1 - r.k0; r.delta = r.dO - r.dK;
		// (merge with the previous stretch when they touch)
		const last = out[out.length - 1];
		if (last && r.o0 <= last.o1) { last.o1 = Math.max(last.o1, r.o1); last.k1 = Math.max(last.k1, r.k1); last.dO = last.o1 - last.o0; last.dK = last.k1 - last.k0; last.delta = last.dO - last.dK; last.maxDist = Math.max(last.maxDist, r.maxDist); }
		else out.push(r);
		p = e + 1;
	}
	return out;
}

// ------------------------------------------------------------------ build
// The sources (paths relative to the jobs' home, --home / EEAT_HOME, default this checkout's src/): our runs (the
// AutoTAS finals and base routes) and the better ones (the known TASes, the user's segment, our own later classes).
// A 'job' source is the job's best.eetas; a 'file' is a path. The level of a pair is the first run's job level
// (its rng_script); every run is replayed on it and a pair whose run does not finish there is skipped.
const LEVELS = {
	fv: 'autotas-forgotten-veil-from-the--2c8c6f', oct: 'autotas-octorage-from-the-level--7aa419', ip: 'autotas-infinity-pain-from-the-l-bd0f03',
	ice: 'autotas-ice-level-from-the-level-222abd', sf: 'stupid-fox-lictor-da5517', ex: 'autotas-ex-crew-odyssey-from-the-1bb066',
	eq2: 'autotas-egg-quest-ii-from-the-le-bb766a',
};
const RUNS = {
	fv_final: ['job', 'autotas-forgotten-veil-from-the--2c8c6f', 'our FV AutoTAS final 1:52.00'],
	fv_route: ['job', 'autotas-base-route-forgotten-vei-891875', 'our FV base route (Find a route) 2:31.48'],
	fv_known: ['job', 'forgotten-veil-d30867', 'the FV known best 1:50.53'],
	oct_final: ['job', 'autotas-octorage-from-the-level--7aa419', 'our Octorage AutoTAS final 0:59.93'],
	oct_route: ['job', 'autotas-base-route-octorage-find-ece97e', 'our Octorage base route 1:37.66'],
	oct_known: ['file', 'out/biglv/octorage_known.eetas', 'the Octorage known TAS 0:59.54'],
	ip_final: ['job', 'autotas-infinity-pain-from-the-l-bd0f03', 'our IP AutoTAS final 6:34.10'],
	ip_known: ['job', 'infinity-pain-kiraninja-pwe7zf-v-b42e94', 'the IP known best 6:22.77'],
	ice_ours: ['file', 'out/gap2/ice/ours_4724_a100.eetas', 'our ice AutoTAS run 0:47.24 (autotas_gap2)'],
	ice_known: ['file', 'out/gap2/ice/known_4625.eetas', 'the ice known TAS 0:46.25'],
	sf_door: ['file', 'jobs/stupid-fox-lictor-da5517/best_5310.eetas', 'our Stupid Fox run of the 10-coin door class 0:53.10'],
	sf_free: ['file', 'jobs/stupid-fox-oc-a93a88/best_3626.eetas', 'our Stupid Fox door-free run 0:36.26'],
	ex_ours: ['file', 'out/newlv/excrew/EPYC/best.eetas', 'our EX Crew EPYC final 0:39.18 (the slow climb)'],
	ex_known: ['job', 'autotas-ex-crew-odyssey-from-the-1bb066', 'our EX Crew H100 final 0:37.86 (the short climb)'],
	eq2_ours: ['file', 'out/lab/results/eggquest2_h100_f3000_g20000_20260927_1809/best.eetas', 'our Egg Quest II best 2:56.42'],
	eq2_user: ['file', 'out/levels/chimney_user.eetas', "the user's chimney segment (270 ticks from t544)"],
};
// the pairs mined (ours, the better run, the level, how many of the largest stretches of each kind)
const PAIRS = [
	['fv', 'fv_final', 'fv_known', 4], ['fv', 'fv_route', 'fv_known', 4], ['oct', 'oct_final', 'oct_known', 4], ['oct', 'oct_route', 'oct_known', 4],
	['ip', 'ip_final', 'ip_known', 4], ['ice', 'ice_ours', 'ice_known', 2], ['sf', 'sf_door', 'sf_free', 2], ['ex', 'ex_ours', 'ex_known', 2],
];

/** slack of a case: at least 10 ticks and a tenth of par, at most half the gap (found = at least half the gap closed) */
const slackOf = (par, ours) => Math.max(1, Math.min(Math.floor((ours - par) / 2), Math.max(10, Math.round(par / 10))));

function build() {
	engine();
	const HOME = path.resolve(opt.home || process.env.EEAT_HOME || path.join(ROOT, 'src'));
	const J = require(path.join(ROOT, 'src', 'jobs.js'));
	for (const d of ['levels', 'prefix', 'ref', 'known']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
	const md = +(opt.minDelta || 50);
	const only = opt.only ? new Set(opt.only.split(',')) : null;
	const runFile = (k) => { const [kind, x] = RUNS[k]; return kind === 'job' ? path.join(HOME, 'jobs', x, 'best.eetas') : path.join(HOME, x); };
	const levelFile = (lv) => {
		const out = path.join(DATA, 'levels', `${lv}.json`);
		const src = path.join(HOME, 'data', `job_${LEVELS[lv].replace(/-/g, '_')}.json`);
		if (!fs.existsSync(out) || opt.fresh) fs.copyFileSync(src, out);
		return out;
	};
	const Ls = {}, runs = {}, traces = {};
	const lvl = (lv) => (Ls[lv] || (Ls[lv] = E.loadLevel(levelFile(lv))));
	const run = (lv, k) => {
		const key = `${lv}:${k}`;
		if (!runs[key]) {
			const f = runFile(k);
			if (!fs.existsSync(f)) { console.log(`  (no ${k}: ${f})`); runs[key] = null; return null; }
			const ms = C.readEetas(f);
			runs[key] = { k, ms, ev: k === 'eq2_user' ? null : C.evaluate(lvl(lv), ms) };
			if (k !== 'eq2_user' && !runs[key].ev) { console.log(`  (${k} does not finish on ${lv}'s level: skipped)`); runs[key] = null; }
		}
		return runs[key];
	};
	const trace = (lv, k, ms) => { const key = `${lv}:${k}`; return traces[key] || (traces[key] = traceRun(lvl(lv), ms || run(lv, k).ms)); };
	const cases = [];

	/** a case from its parts: writes prefix / ref, checks it (ours reaches the goal no sooner than the deadline, the
	 *  known candidate when given), tries the donor (the better run's own inputs from our start state) */
	const addCase = (c) => {
		if (only && !only.has(c.id)) return;
		const oursRun = run(c.lv, c.ours_run);
		if (c.notSwitch) { c.goal.notSwitch = c.notSwitch; delete c.notSwitch; }
		c.level = `levels/${c.lv}.json`;
		c.levelName = c.lv;
		c.prefix = `prefix/${c.id}.eetas`;
		c.ref = `ref/${c.id}.eetas`;
		C.writeEetas(path.join(DATA, c.prefix), oursRun.ms.subarray(0, c.fixed));
		C.writeEetas(path.join(DATA, c.ref), oursRun.ms);
		c.startMax = c.startMax || c.fixed;
		// ours on this goal (the ticks our run takes; our run may not meet the room condition: then ours = the token's)
		const O = trace(c.lv, c.ours_run);
		const og = goalTick(c.goal, O, c.fixed);
		if (og.t >= 0) c.ours = og.t - c.fixed;
		else c.oursNote = `our run does not meet the goal (${og.bad && og.bad.length ? `it makes ${og.bad[0].id}` : 'room / box'}): ours = its ticks to ${c.oursTo || 'the same place'}`;
		if (!(c.ours > c.par)) { console.log(`  ${c.id}: ours ${c.ours} <= par ${c.par}: not a case`); return; }
		c.slack = c.slack !== undefined ? c.slack : slackOf(c.par, c.ours);
		c.deadline = c.fixed + c.par + c.slack;
		c.parTick = c.fixed + c.par;
		c.oursTick = c.fixed + c.ours;
		// the known candidate: given (the chimney), or the donor: the better run's inputs from its matched tick k0 + o
		let known = c.knownMs ? { ms: c.knownMs, how: c.knownHow } : null;
		if (!known && c.donor) {
			const D = run(c.lv, c.donor.run);
			let best = null;
			for (let o = -6; o <= 6; o++) {
				const k0 = c.donor.k0 + o;
				if (k0 < 0) continue;
				const len = c.par + c.slack + 80;
				const ms = new Uint8Array(c.fixed + len);
				ms.set(oursRun.ms.subarray(0, c.fixed));
				ms.set(D.ms.subarray(k0, k0 + len), c.fixed);
				const v = verify(c, ms);
				if (v.ok && (!best || v.ticks < best.v.ticks)) best = { ms: ms.subarray(0, v.T), v, o };
			}
			if (best) known = { ms: best.ms, how: `the ${c.donor.run} inputs from its tick ${c.donor.k0 + best.o} played from our state at ${c.fixed}` };
		}
		delete c.knownMs;
		if (known) {
			const v = verify(c, known.ms);
			if (v.ok) {
				c.known = `known/${c.id}.eetas`;
				C.writeEetas(path.join(DATA, c.known), known.ms);
				c.knownTicks = v.ticks;
				c.knownHow = known.how;
				// (a known line from our own state that is faster than the known run's stretch sets par: proven reachable)
				if (v.ticks < c.par) {
					c.parFrom = `the known run's stretch took ${c.par}`;
					c.par = v.ticks; c.slack = slackOf(c.par, c.ours); c.deadline = c.fixed + c.par + c.slack; c.parTick = c.fixed + c.par;
				}
			} else c.knownNote = `the known candidate fails: ${v.why}`;
		}
		c.parVerified = !!c.known;
		// the goal level: the goal box's free tiles are the trophy (an event's own tile too: the coin, the team switch),
		// the level's own trophies air (kept when the goal is the finish), the forbidden switches air
		c.goalLevel = goalLevel(c);
		delete c.trophyAt;
		delete c.lv; delete c.donor;
		cases.push(c);
		console.log(`  ${c.id}: fixed ${c.fixed}, par ${c.par}, ours ${c.ours}, deadline +${c.deadline - c.fixed}${c.known ? `, known from our state ${c.knownTicks}` : ''}${c.oursNote ? ` (${c.oursNote})` : ''}`);
	};
	const goalOf = (T, t, extra = {}) => {
		const d = T.rooms[T.RI[t]];
		return Object.assign({ room: roomSans(d), keys: keysOf(d) }, extra);
	};
	const boxAt = (T, t, r = 1) => { const x = tileOf(T.X[t]), y = tileOf(T.Y[t]); return [x - r, y - r, x + r, y + r]; };

	// ---- the named cases
	console.log('named cases:');
	// 1. Egg Quest II: the user's chimney (their 270-tick segment from our best's t544: the pyramid top by t814)
	if (run('eq2', 'eq2_ours') && run('eq2', 'eq2_user')) {
		const ours = run('eq2', 'eq2_ours').ms, user = run('eq2', 'eq2_user').ms;
		const km = new Uint8Array(544 + user.length);
		km.set(ours.subarray(0, 544)); km.set(user, 544);
		const K = traceRun(lvl('eq2'), km);
		// the goal: the pyramid top region (the ball's centre above its top row 266, x 24..30; the user's line enters it at
		// t764 and lands on the top at t801; our best enters it only at ~t978)
		const goal = { box: [24, 250, 30, 265], room: roomSans(K.rooms[K.RI[801]]), keys: [] };
		const g = goalTick(goal, K, 500);
		addCase({ id: 'eq2_chimney', kind: 'named', lv: 'eq2', ours_run: 'eq2_ours', fixed: 500, startMax: 620, goal, par: g.t - 500, slack: 814 - g.t, knownMs: km.subarray(0, g.t),
			knownHow: "our best's first 544 inputs + the user's chimney segment", source: "the user's chimney segment (src/out/night/eq2_chimney_user.md): up the grey zig-zag above the first house to the pyramid top" });
	}
	// token stretches of a pair, by the stretch's from / to tokens
	const tokenCase = (id, lv, ok, kk, from, to, extra = {}) => {
		if (!run(lv, ok) || !run(lv, kk)) return;
		const O = trace(lv, ok), K = trace(lv, kk);
		// (one stretch, or several in a row: from the stretch that starts at `from` (after extra.after ours ticks) to the
		// first that ends at `to`)
		const all = tokenStretches(O, K, run(lv, ok).ms, run(lv, kk).ms);
		const s1 = all.find((x) => x.from === from && x.o0 >= (extra.after || 0));
		const s2 = s1 && all.find((x) => x.to === to && x.o1 > s1.o0);
		if (!s1 || !s2) { console.log(`  ${id}: no stretch ${from} -> ${to}`); return; }
		const s = s1 === s2 ? s1 : Object.assign({}, s1, { to, o1: s2.o1, k1: s2.k1, dO: s2.o1 - s1.o0, dK: s2.k1 - s1.k0,
			onlyOurs: all.filter((x) => x.o0 >= s1.o0 && x.o1 <= s2.o1).flatMap((x) => x.onlyOurs), onlyKnown: all.filter((x) => x.o0 >= s1.o0 && x.o1 <= s2.o1).flatMap((x) => x.onlyKnown) });
		s.delta = s.dO - s.dK;
		const goal = goalOf(K, s.k1, { event: to.startsWith('room:') ? undefined : to, box: to.startsWith('room:') ? boxAt(K, s.k1, 2) : undefined });
		if (extra.not) goal.not = extra.not;
		addCase(Object.assign({ id, kind: extra.kind || 'named', lv, ours_run: ok, fixed: s.o0, goal, par: s.dK, ours: s.dO, oursTo: to, donor: { run: kk, k0: s.k0 }, trophyAt: [tileOf(K.X[s.k1]), tileOf(K.Y[s.k1])],
			source: `${RUNS[ok][2]} vs ${RUNS[kk][2]}: ${from} -> ${to} (ours also ${s.onlyOurs.join(' ') || '-'}; the known also ${s.onlyKnown.join(' ') || '-'})` }, extra.more || {}));
	};
	// 2. Forgotten Veil: coin 11 -> coin 12 without purple switch 0 (every route of ours presses it; the known never)
	tokenCase('fv_sw0', 'fv', 'fv_final', 'fv_known', 'coin@332,143', 'coin@324,119', { not: ['switch:purple:0:1'] });
	tokenCase('fv_sw0_route', 'fv', 'fv_route', 'fv_known', 'coin@332,143', 'coin@324,119', { not: ['switch:purple:0:1'] });
	// (coins 11-13: ours keeps purple 0 on through the switch-1 rooms and the magenta key to coin 13)
	tokenCase('fv_sw0_c13', 'fv', 'fv_final', 'fv_known', 'coin@332,143', 'coin@213,88', { not: ['switch:purple:0:1'] });
	// 3. Octorage: the arrow room after the first portal (the known climbs round it; ours drops through the team-switch column)
	tokenCase('oct_arrow', 'oct', 'oct_final', 'oct_known', 'coin@12,174', 'team:0@92,172');
	// 4. EX Crew: the climb (64, 92) -> (48, 77) (our EPYC final 320 ticks, the H100 final 141)
	if (run('ex', 'ex_ours') && run('ex', 'ex_known')) {
		const O = trace('ex', 'ex_ours'), K = trace('ex', 'ex_known');
		const near = (T, x, y, from) => { for (let t = from; t <= T.n; t++) if (Math.abs(T.X[t] + 8 - (x * 16 + 8)) <= 16 && Math.abs(T.Y[t] + 8 - (y * 16 + 8)) <= 16) return t; return -1; };
		const o0 = near(O, 64, 92, 3000), k0 = near(K, 64, 92, 3000);
		const k1 = near(K, 48, 77, k0), o1 = near(O, 48, 77, o0);
		const goal = goalOf(K, k1, { box: [47, 76, 49, 78] });
		addCase({ id: 'ex_climb', kind: 'named', lv: 'ex', ours_run: 'ex_ours', fixed: o0, goal, par: k1 - k0, ours: o1 - o0, donor: { run: 'ex_known', k0 },
			source: `${RUNS.ex_ours[2]} vs ${RUNS.ex_known[2]}: the climb (64, 92) -> (48, 77)` });
	}
	// 5. Stupid Fox: the door-free class (ours collects 6 more coins for the 10-coin door; the door-free way skips them)
	if (run('sf', 'sf_door') && run('sf', 'sf_free')) {
		const O = trace('sf', 'sf_door'), K = trace('sf', 'sf_free');
		const g = geoStretches(O, K).sort((a, b) => b.delta - a.delta)[0];
		// (the room without the coin count: the door-free way holds fewer coins)
		const goal = goalOf(K, g.k1, { box: boxAt(K, g.k1, 1), roomIgnore: ['coins', 'bluecoins'] });
		goal.room = goal.room.replace(/\s*(blue)?coins=\d+/g, '').trim() || '(start)';
		addCase({ id: 'sf_doorfree', kind: 'named', lv: 'sf', ours_run: 'sf_door', fixed: g.o0, goal, par: g.dK, ours: g.dO, donor: { run: 'sf_free', k0: g.k0 },
			source: `${RUNS.sf_door[2]} vs ${RUNS.sf_free[2]}: where the tracks part (up to ${g.maxDist} tiles)` });
	}
	// 6. Infinity Pain: the fly section without purple switch 0 (ours has it on from here to the end; the known never)
	// (ours presses it at 25211, (23, 115), on the way from the team-1 room's entry to the fly effect; the known never)
	tokenCase('ip_sw0', 'ip', 'ip_final', 'ip_known', 'room:team=1', 'effect:levitation:0@98,172', { after: 25000, not: ['switch:purple:0:1'], more: { notSwitch: [0] } });
	// 7. ice: the top right as one line (the known's inputs from our state merge with our run only after ~1,400 ticks)
	if (run('ice', 'ice_ours') && run('ice', 'ice_known')) {
		const O = trace('ice', 'ice_ours');
		// the goal: our run's state at its merge point 3780, as a box around it (the known line reaches it ~55 ticks sooner)
		const goal = goalOf(O, 3780, { box: boxAt(O, 3780, 1) });
		const K = trace('ice', 'ice_known');
		// (the known's tick matched to our 2365: the nearest by position within 150 ticks)
		let k0 = 2365, bd = Infinity;
		for (let t = 2200; t <= 2550 && t <= K.n; t++) { const d = Math.hypot(K.X[t] - O.X[2365], K.Y[t] - O.Y[2365]); if (d < bd) { bd = d; k0 = t; } }
		let k1 = -1;
		{ const g = goalTick(goal, K, k0); k1 = g.t; }
		addCase({ id: 'ice_arc', kind: 'named', lv: 'ice', ours_run: 'ice_ours', fixed: 2365, goal, par: k1 > 0 ? k1 - k0 : 1360, donor: { run: 'ice_known', k0 },
			source: `${RUNS.ice_ours[2]} vs ${RUNS.ice_known[2]}: the top right + the slope as one line (autotas_gap2: the known line merges at our 3780)` });
	}

	// ---- mined: every PATH stretch of >= minDelta ticks (token and geometric) of each pair, the largest first
	console.log('mined cases:');
	// (a stretch is left out when it overlaps a case already made by more than half of the shorter of the two; the
	// candidates of a pair, token and geometric, go by the gap they hold, the largest first; par at most --maxPar)
	const maxPar = +(opt.maxPar || 2500);
	const overlaps = (lv, a, b) => cases.some((c) => c.levelName === lv && Math.min(b, c.fixed + c.ours) - Math.max(a, c.fixed) > 0.5 * Math.min(b - a, c.ours));
	for (const [lv, ok, kk, top] of PAIRS) {
		if (!run(lv, ok) || !run(lv, kk)) continue;
		const O = trace(lv, ok), K = trace(lv, kk);
		const cand = [];
		for (const s of tokenStretches(O, K, run(lv, ok).ms, run(lv, kk).ms)) {
			if (s.same || s.delta < md || s.dK > maxPar) continue;
			const to = s.to;
			const goal = goalOf(K, s.k1, { event: to.startsWith('room:') ? undefined : to, box: to.startsWith('room:') ? boxAt(K, s.k1, 2) : undefined });
			if (to === 'finish') goal.room = null;
			cand.push({ kind: 't', o0: s.o0, o1: s.o1, delta: s.delta, c: { fixed: s.o0, goal, par: s.dK, ours: s.dO, oursTo: to, donor: { run: kk, k0: s.k0 }, trophyAt: [tileOf(K.X[s.k1]), tileOf(K.Y[s.k1])],
				source: `token stretch ${s.from} -> ${to} of ${RUNS[ok][2]} vs ${RUNS[kk][2]} (ours also ${s.onlyOurs.slice(0, 6).join(' ') || '-'}${s.onlyOurs.length > 6 ? ' ...' : ''}; the known also ${s.onlyKnown.slice(0, 6).join(' ') || '-'})` } });
		}
		for (const s of geoStretches(O, K)) {
			if (s.delta < md || s.dK > maxPar) continue;
			// the goal: the known's place at the end of the stretch; moved on along the known run while our run gets
			// there as soon as it (a loop of ours comes back to where it left)
			// (the room: the known's there when both runs are in the same room where they part; else, a difference both
			// runs brought along, e.g. a switch left on long before, only the box and the keys)
			const sameStart = roomSans(O.rooms[O.RI[s.o0]]) === roomSans(K.rooms[K.RI[s.k0]]);
			let k1 = s.k1, goal = null, ours = -1;
			for (; k1 <= Math.min(K.n, s.k1 + 400); k1 += 5) {
				goal = goalOf(K, k1, { box: boxAt(K, k1, 1) });
				if (!sameStart) goal.room = null;
				const g = goalTick(goal, O, s.o0);
				if (g.t >= 0 && g.t - s.o0 - (k1 - s.k0) >= md) { ours = g.t - s.o0; break; }
			}
			if (ours < 0) { if (opt.verbose) console.log(`  (geometric ${ok} ${s.o0}-${s.o1}: no goal along the known's way that our run reaches ${md}+ ticks later)`); continue; }
			// (a pure detour: each run stays in its room over the stretch; a room change inside is a token stretch's)
			const rs = (T, t) => roomSans(T.rooms[T.RI[t]]);
			if (rs(O, s.o0) !== rs(O, s.o0 + ours) || rs(K, s.k0) !== rs(K, k1)) { if (opt.verbose) console.log(`  (geometric ${ok} ${s.o0}-${s.o1}: a room change inside)`); continue; }
			cand.push({ kind: 'g', o0: s.o0, o1: s.o0 + ours, delta: ours - (k1 - s.k0), c: { fixed: s.o0, goal, par: k1 - s.k0, ours, donor: { run: kk, k0: s.k0 },
				source: `geometric stretch of ${RUNS[ok][2]} vs ${RUNS[kk][2]}: the tracks part up to ${s.maxDist} tiles at (${tileOf(O.X[s.o0])}, ${tileOf(O.Y[s.o0])})` } });
		}
		cand.sort((a, b) => b.delta - a.delta);
		let n = 0;
		const kn = { t: 0, g: 0 };
		for (const x of cand) {
			if (n >= top) break;
			if (overlaps(lv, x.o0, x.o1)) { if (opt.verbose) console.log(`  (${ok} ${x.kind} ${x.o0}-${x.o1} +${x.delta}: overlaps a case)`); continue; }
			const before = cases.length;
			addCase(Object.assign({ id: `${ok}_${x.kind}${kn[x.kind]++}`, kind: 'mined', lv, ours_run: ok }, x.c));
			if (cases.length > before) n++;
		}
	}
	const out = { built: new Date().toISOString(), home: HOME, minDelta: md, cases };
	fs.writeFileSync(path.join(DATA, 'cases.json'), JSON.stringify(out, null, 1));
	console.log(`${cases.length} cases -> ${path.join(DATA, 'cases.json')}`);
}

/** the goal level of a case (for finders that aim at the trophy, e.g. goexplore --prefix): the case's level with the
 *  goal box's air tiles made the trophy (121), the level's own trophies air, and the forbidden purple switches (goal.not
 *  switch:purple:<id>:1, notSwitch) air. The verifier still judges on the real level. */
function goalLevel(c) {
	const d = JSON.parse(fs.readFileSync(path.join(DATA, c.level), 'utf8'));
	const L = caseLevel(c);
	const W = d.width, H = d.height;
	const fg = Buffer.from(d.fg_b64, 'base64');
	const get = (i) => fg.readInt32LE(i * 4), set = (i, v) => fg.writeInt32LE(v, i * 4);
	const fin = c.goal.event === 'finish';
	let n = 0;
	if (!fin) for (let i = 0; i < W * H; i++) if (get(i) === 121) set(i, 0);
	// (an event at a tile: that tile is the trophy whatever it is; else the box, or the known's place at the goal)
	const em = c.goal.event && /@(\d+),(\d+)$/.exec(c.goal.event);
	if (em) { set(+em[2] * W + +em[1], 121); n++; }
	const box = c.goal.box || (c.trophyAt ? [c.trophyAt[0] - 1, c.trophyAt[1] - 1, c.trophyAt[0] + 1, c.trophyAt[1] + 1] : null);
	const [x0, y0, x1, y1] = fin || em ? [1, 1, 0, 0] : box || [1, 1, 0, 0];
	// (tiles the ball can be in and that trigger nothing: air, arrows, dots, liquids, climbables, decoration)
	const BK = require(path.join(ROOT, 'src', 'blocks.js'));
	const free = new Set(['empty', 'arrow', 'dot', 'liquid', 'climbable', 'deco', 'coin_taken', 'spawn', 'checkpoint']);
	for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
		const id = get(y * W + x);
		if (free.has(BK.kindOf(id).kind) && !(id === 416 || id === 1585)) { set(y * W + x, 121); n++; }
	}
	const offs = new Set(c.goal.notSwitch || []);
	for (const e of c.goal.not || []) { const m = /^switch:purple:(\d+):1$/.exec(e); if (m) offs.add(+m[1]); }
	let sw = 0;
	if (offs.size) for (let i = 0; i < W * H; i++) if (get(i) === 113 && offs.has(L.lookup0[i])) { set(i, 0); sw++; }
	d.fg_b64 = fg.toString('base64');
	d.level_id = `${d.level_id}_goal_${c.id}`;
	const f = `levels/${c.id}_goal.json`;
	fs.writeFileSync(path.join(DATA, f), JSON.stringify(d));
	if (!n && !fin) console.log(`  ${c.id}: no free tile in the goal box: the goal level has no trophy`);
	c.goalLevelInfo = { trophies: n, switchesRemoved: sw };
	return f;
}

/** mine: node tools/pathbench.js mine <level.json> <ours.eetas> <known.eetas> [--minDelta=50]: the stretches */
function mineCmd() {
	engine();
	const [lf, of, kf] = pos;
	const L = E.loadLevel(lf);
	const om = C.readEetas(of), km = C.readEetas(kf);
	const O = traceRun(L, om), K = traceRun(L, km);
	console.log(`ours ${O.n} ticks (fin ${O.fin}), known ${K.n} (fin ${K.fin}); tokens ${O.toks.length} / ${K.toks.length}`);
	const md = +(opt.minDelta || 50);
	const ts = tokenStretches(O, K, om, km);
	const oth = ts.filter((s) => !s.same);
	console.log(`token stretches ${ts.length}, other path ${oth.length}: PATH ${oth.reduce((a, s) => a + s.delta, 0)}, EXEC ${ts.filter((s) => s.same).reduce((a, s) => a + s.delta, 0)}`);
	for (const s of oth.filter((x) => x.delta >= md)) console.log(`  TOKEN ${s.from} -> ${s.to}: ours ${s.o0}-${s.o1} (${s.dO}) known ${s.k0}-${s.k1} (${s.dK}) +${s.delta}\n     only ours: ${s.onlyOurs.slice(0, 8).join(' ')}${s.onlyOurs.length > 8 ? ` (+${s.onlyOurs.length - 8})` : ''}\n     only known: ${s.onlyKnown.slice(0, 8).join(' ')}${s.onlyKnown.length > 8 ? ` (+${s.onlyKnown.length - 8})` : ''}`);
	if (opt.list) for (const s of ts) console.log(`    ${s.same ? 'same ' : 'OTHER'} ${s.from} -> ${s.to}: ours ${s.o0}-${s.o1} known ${s.k0}-${s.k1} ${s.delta >= 0 ? '+' : ''}${s.delta}  [${O.rooms[s.oTok.room]}] [${K.rooms[s.kTok.room]}]${s.same ? '' : ` ours+ ${s.onlyOurs.join(' ')} known+ ${s.onlyKnown.join(' ')}`}`);
	const gs = geoStretches(O, K);
	console.log(`geometric stretches ${gs.length}: sum delta ${gs.reduce((a, s) => a + s.delta, 0)}`);
	for (const s of gs.filter((x) => x.delta >= md)) console.log(`  GEO ours ${s.o0}-${s.o1} (${s.dO}) at (${tileOf(O.X[s.o0])},${tileOf(O.Y[s.o0])})->(${tileOf(O.X[s.o1])},${tileOf(O.Y[s.o1])}) known ${s.k0}-${s.k1} (${s.dK}) +${s.delta}, parted up to ${s.maxDist} tiles`);
}

// ------------------------------------------------------------------ run: score a finder
const BUILTIN = ['none', 'ref', 'known', 'optwin', 'gox', 'goxb', 'goxr', 'goxleap', 'leaps', 'skipfind', 'routearm'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ends a finder: its stop file first (finders that watch it end their children between two GPU launches), then the tree */
async function endProcess(p, stopFile, graceMs) {
	try { fs.writeFileSync(stopFile, 'stop'); } catch (e) { /* gone */ }
	const t0 = Date.now();
	while (p.exitCode === null && p.signalCode === null && Date.now() - t0 < graceMs) await sleep(250);
	if (p.exitCode !== null || p.signalCode !== null) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F']);
	else { try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { /* gone */ } await sleep(2000); try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
}

/** one case: the finder runs with the case JSON; every candidate it writes is verified as it lands */
async function runCase(cs, finder, o) {
	engine();
	const out = path.join(o.work, cs.id);
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
	const abs = (f) => (f ? path.join(DATA, f) : null);
	const cj = Object.assign({}, cs, { level: abs(cs.level), goalLevel: abs(cs.goalLevel), prefix: abs(cs.prefix), ref: abs(cs.ref), known: abs(cs.known),
		seconds: o.seconds, threads: o.threads, out, stopFile: path.join(out, 'stop') });
	const caseFile = path.join(o.work, `${cs.id}.case.json`);
	fs.writeFileSync(caseFile, JSON.stringify(cj, null, 1));
	const sub = (s) => s.replace(/\{case\}/g, caseFile).replace(/\{out\}/g, out).replace(/\{seconds\}/g, String(o.seconds)).replace(/\{threads\}/g, String(o.threads));
	let p;
	const env = Object.assign({}, process.env, { PB_CASE: caseFile, PB_OUT: out, PB_SECONDS: String(o.seconds), PB_THREADS: String(o.threads) });
	if (BUILTIN.includes(finder)) {
		const pass = argv.filter((x) => /^--(code|leapsCode|tool|cachedir|mem|gx|leapArgs|seed|targets|kappa|sfEvery|sfArgs|raStep|raArgs)=/.test(x));
		p = spawn(process.execPath, [__filename, 'finder', finder, caseFile, ...pass], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32', windowsHide: true });
	} else p = spawn(sub(finder), { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32', windowsHide: true });
	const t0 = Date.now();
	const sec = () => Math.round((Date.now() - t0) / 100) / 10;
	const seen = new Map(), log = [];
	const r = { case: cs.id, found: false, best: null, secFound: null, secBest: null, candidates: 0, rejected: 0, why: null };
	const consider = (f) => {
		let st;
		try { st = fs.statSync(f); } catch (e) { return; }
		const sig = `${st.size}:${st.mtimeMs}`;
		if (seen.get(f) === sig) return;
		seen.set(f, sig);
		let ms;
		try { ms = C.readEetas(f); } catch (e) { return; }
		if (!ms.length) return;
		const v = verify(cs, ms);
		r.candidates++;
		if (!v.ok) { r.rejected++; if (!r.why) r.why = v.why; return; }
		if (v.found && !r.found) { r.found = true; r.secFound = sec(); }
		if (!r.best || v.ticks < r.best.ticks) {
			r.best = { ticks: v.ticks, ratio: v.ratio, closed: v.closed, T: v.T, file: path.basename(f) };
			r.secBest = sec();
			try { fs.copyFileSync(f, path.join(out, 'best_candidate.eetas.keep')); } catch (e) { /* gone */ }
		}
	};
	const poll = () => { let names = []; try { names = fs.readdirSync(out); } catch (e) { /* gone */ } for (const nm of names) if (/\.eetas$/.test(nm)) consider(path.join(out, nm)); };
	let buf = '';
	p.stdout.on('data', (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			log.push(line);
			if (log.length > 400) log.shift();
			if (line[0] === '{') { try { const e = JSON.parse(line); if (e.candidate) consider(path.resolve(out, e.candidate)); } catch (x) { /* text */ } }
		}
	});
	p.stderr.on('data', (d) => { log.push(String(d).trim()); if (log.length > 400) log.shift(); });
	const stopAt = o.stopAt || 'par';
	const graceMs = (o.grace || 60) * 1000;
	for (;;) {
		await sleep(1000);
		poll();
		const exited = p.exitCode !== null || p.signalCode !== null;
		if (exited) break;
		if (stopAt === 'par' && r.best && r.best.ratio <= 1) { r.stopped = 'par'; break; }
		if (stopAt === 'found' && r.found) { r.stopped = 'found'; break; }
		if (Date.now() - t0 > (o.seconds + 10) * 1000) { r.stopped = 'time'; break; }
	}
	await endProcess(p, path.join(out, 'stop'), graceMs);
	poll();
	r.sec = sec();
	r.exit = p.exitCode;
	fs.writeFileSync(path.join(out, 'finder.log'), log.join('\n'));
	if (!o.keep) for (const nm of fs.readdirSync(out)) if (/\.eetas$/.test(nm)) { try { fs.unlinkSync(path.join(out, nm)); } catch (e) { /* busy */ } }
	return r;
}

async function runBench() {
	engine(opt.code);
	const K = loadCases();
	const set = opt.set || 'all';
	let cases = K.cases.filter((c) => set === 'all' || c.kind === set);
	if (opt.cases) { const w = new Set(opt.cases.split(',')); cases = K.cases.filter((c) => w.has(c.id)); }
	const finder = opt.finder || 'none';
	const label = opt.label || finder.replace(/[^\w.-]+/g, '_').slice(0, 40);
	const o = { seconds: +(opt.seconds || 120), threads: +(opt.threads || 2), stopAt: opt.stopAt, grace: +(opt.grace || 60), keep: opt.keep === '1',
		work: path.resolve(opt.work || path.join(os.tmpdir(), `pathbench_${label}_${process.pid}`)) };
	fs.mkdirSync(o.work, { recursive: true });
	const par = Math.max(1, +(opt.par || 1));
	console.log(`pathbench: finder ${finder}, ${cases.length} cases, ${o.seconds} s and ${o.threads} threads each, ${par} at once (work ${o.work})`);
	const t0 = Date.now();
	const results = [];
	let next = 0;
	// (the longest pars first: the pool ends together)
	const order = cases.slice().sort((a, b) => b.par - a.par);
	await Promise.all(Array.from({ length: par }, async () => {
		while (next < order.length) {
			const cs = order[next++];
			const r = await runCase(cs, finder, o);
			results.push(r);
			const b = r.best;
			console.log(`  ${cs.id}: ${r.found ? 'FOUND' : 'not found'}${b ? `, best ${b.ticks} ticks (par ${cs.par}, ours ${cs.ours}: ratio ${b.ratio}, gap closed ${b.closed})` : ''}, ${r.candidates} candidates (${r.rejected} rejected${r.why ? `: ${r.why}` : ''}), ${r.sec} s${r.stopped ? ` (${r.stopped})` : ''}`);
		}
	}));
	const byId = new Map(results.map((r) => [r.case, r]));
	const rows = cases.map((c) => Object.assign({ par: c.par, ours: c.ours, kind: c.kind, level: c.levelName }, byId.get(c.id)));
	const cap = o.seconds;
	const sum = (rs) => {
		const f = rs.filter((x) => x.found);
		const cl = rs.map((x) => (x.best && x.best.closed !== null ? Math.max(0, Math.min(1.5, x.best.closed)) : 0));
		return { cases: rs.length, found: f.length, meanClosed: rs.length ? Math.round(cl.reduce((a, b) => a + b, 0) / rs.length * 1000) / 1000 : null,
			par2: rs.length ? Math.round(rs.reduce((a, x) => a + (x.found ? x.secFound : 2 * cap), 0) / rs.length * 10) / 10 : null };
	};
	const out = { label, finder, code: opt.code || ROOT, seconds: o.seconds, threads: o.threads, par, when: new Date().toISOString(), wallSec: Math.round((Date.now() - t0) / 1000),
		all: sum(rows), named: sum(rows.filter((x) => x.kind === 'named')), mined: sum(rows.filter((x) => x.kind === 'mined')), cases: rows };
	const base = opt.baseline ? JSON.parse(fs.readFileSync(opt.baseline, 'utf8')) : null;
	const bm = base ? new Map(base.cases.map((x) => [x.case, x])) : null;
	console.log(`\n| case | level | par | ours | found | best ticks | ratio (best / par) | gap closed | s to found | s to best |${base ? ` ${base.label} found | ${base.label} closed |` : ''}`);
	console.log(`|---|---|---|---|---|---|---|---|---|---|${base ? '---|---|' : ''}`);
	const f = (v) => (v === null || v === undefined ? '-' : v);
	for (const x of rows) {
		const b = bm && bm.get(x.case);
		console.log(`| ${x.case} | ${x.level} | ${x.par} | ${x.ours} | ${x.found ? 'yes' : 'no'} | ${x.best ? x.best.ticks : '-'} | ${x.best ? x.best.ratio : '-'} | ${x.best ? f(x.best.closed) : '-'} | ${f(x.secFound)} | ${f(x.secBest)} |${b ? ` ${b.found ? 'yes' : 'no'} | ${b.best ? f(b.best.closed) : '-'} |` : base ? ' - | - |' : ''}`);
	}
	console.log(`ALL: found ${out.all.found}/${out.all.cases}, mean gap closed ${out.all.meanClosed} (0..1.5), par2 ${out.all.par2} s (a miss = 2 x ${cap} s); named ${out.named.found}/${out.named.cases}, mined ${out.mined.found}/${out.mined.cases}; wall ${out.wallSec} s`);
	const jf = path.resolve(opt.json || path.join(DATA, 'results', `${label}.json`));
	fs.mkdirSync(path.dirname(jf), { recursive: true });
	fs.writeFileSync(jf, JSON.stringify(out, null, 1));
	console.log(`-> ${jf}`);
	if (!o.keep) { try { fs.rmSync(o.work, { recursive: true, force: true }); } catch (e) { /* busy */ } }
}

// ------------------------------------------------------------------ the built-in finders
/** node tools/pathbench.js finder <name> <case.json>: a finder as the bench runs it (candidates into case.out) */
async function finderCmd() {
	const [name, caseFile] = pos;
	const cs = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
	const code = path.resolve(opt.code || ROOT);
	engine(code);
	const out = cs.out;
	const stopped = () => fs.existsSync(cs.stopFile);
	const t0 = Date.now();
	const left = () => cs.seconds - (Date.now() - t0) / 1000;
	const say = (e) => console.log(JSON.stringify(e));
	/** a child tool, ended when the stop file appears (stdin "stop" for goexplore, else a kill: CPU tools only; GPU tools
	 *  run detached with --parent and end between two launches) */
	const child = (args, o = {}) => new Promise((res) => {
		const ch = spawn(process.execPath, args, { stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, C.workerHeapEnv ? C.workerHeapEnv() : {}) });
		let buf = '', last = [];
		ch.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); last.push(line); if (last.length > 30) last.shift(); if (o.onLine) o.onLine(line); }
		});
		ch.stderr.on('data', (d) => { last.push(String(d).trim()); if (last.length > 30) last.shift(); });
		const iv = setInterval(() => {
			if (!stopped() && left() > -5) return;
			if (o.stdin) { try { ch.stdin.write('stop\n'); } catch (e) { /* gone */ } } else ch.kill();
		}, 500);
		ch.on('exit', (c) => { clearInterval(iv); res({ code: c, last }); });
	});
	if (name === 'none') return;
	if (name === 'ref') { fs.copyFileSync(cs.ref, path.join(out, 'ref.eetas')); return; }
	if (name === 'known') { if (cs.known) fs.copyFileSync(cs.known, path.join(out, 'known.eetas')); return; }
	if (name === 'optwin') {
		// the optimizer's windows: explore --hunt exact rejoins with our run, 800-tick windows every 600 from the start to
		// past our run's arrival, each from the best so far (the sweep's operator, one lane)
		const L = E.loadLevel(cs.level);
		let best = C.readEetas(cs.ref);
		let bestEv = C.evaluate(L, best);
		const nc = C.coinsIrrelevant(cs.level, best, bestEv) ? 1 : 0;
		const wins = [];
		for (let w0 = cs.fixed; w0 < cs.oursTick + 100; w0 += 600) wins.push(w0);
		const per = Math.max(20, Math.floor(cs.seconds / wins.length));
		let k = 0;
		for (const w0 of wins) {
			if (stopped() || left() < 10) break;
			const ref = path.join(out, `ref_${k}.tmp`), o2 = path.join(out, `win_${k}.eetas`);
			C.writeEetas(ref, best);
			const secs = Math.max(10, Math.min(per, Math.floor(left() - 5)));
			const r = await child([path.join(code, 'src', 'explore.js'), `--tas=${ref}`, `--level=${cs.level}`, `--out=${o2}`, `--from=${w0}`, `--join=${w0}`, `--until=${w0 + 800}`,
				`--seconds=${secs}`, `--workers=${cs.threads}`, '--exact=1', '--hunt=1', `--seed=${301 + k}`, `--nocoins=${nc}`, '--maxEntries=1500000']);
			say({ window: [w0, w0 + 800], seconds: secs, exit: r.code, last: r.last.filter((l) => !/^\[ticks\]/.test(l)).slice(-2) });
			if (fs.existsSync(o2)) {
				const m = C.readEetas(o2), ev = C.evaluate(L, m);
				if (ev && ev.runTicks < bestEv.runTicks) { best = ev.ms; bestEv = ev; say({ candidate: path.basename(o2), window: w0, runTicks: ev.runTicks }); }
			}
			k++;
		}
		return;
	}
	if (name === 'gox' || name === 'goxb' || name === 'goxr') {
		// Find a route's CPU search (goexplore.js, the gate benchmark's operator) from the start state: gox / goxb on the
		// goal level (TOLD the goal: the goal box is its trophy), bounded by our run's arrival; goxb: the one search's GPU
		// bursts too; goxr on the real level (NOT told: the level's trophy, bounded by our run's finish), its faster
		// routes checked for the goal on the way
		const real = name === 'goxr';
		if (!real && !cs.goalLevel) { say({ error: 'no goal level' }); return; }
		const refN = C.evaluate(E.loadLevel(cs.level), C.readEetas(cs.ref)).ms.length;
		const args = [path.join(code, 'src', 'goexplore.js'), real ? cs.level : cs.goalLevel, `--prefix=${cs.prefix}`, `--workers=${cs.threads}`, '--cells=coarse', '--steer=build', '--stdin=1',
			`--seconds=${Math.max(10, Math.floor(left()))}`, `--depth=${real ? refN - 1 : cs.oursTick}`, `--out=${path.join(out, 'gox.eetas')}`, `--seed=${+(opt.seed || 1)}`, `--mem=${+(opt.mem || 700)}`];
		if (name === 'goxb') {
			const tool = opt.tool || require(path.join(code, 'src', 'gpu.js')).nativeTool();
			args.push('--bursts=1', `--tool=${tool}`, `--work=${path.join(out, 'bursts')}`, ...(opt.cachedir ? [`--cachedir=${opt.cachedir}`] : []));
		}
		if (opt.gx) args.push(...opt.gx.split(' ').filter(Boolean));
		let near = null;
		const r = await child(args, { stdin: true, onLine: (l) => {
			if (/"ev":"(start|result|done|error|warning)"/.test(l)) console.log(l.replace(/"inputs":"[^"]*"/g, '"inputs":"..."').slice(0, 400));
			else if (/"ev":"closest"/.test(l)) { try { const e = JSON.parse(l); near = { dist: e.dist, tick: e.tick, sec: Math.round((Date.now() - t0) / 1000) }; } catch (x) { /* partial */ } }
		} });
		say({ closest: near });
		if (r.code) say({ error: `goexplore exit ${r.code}`, last: r.last.slice(-5) });
		return;
	}
	if (name === 'goxleap') {
		// NOT told the goal: targets from our own run. From the start state, the later places of our run that the run
		// reaches slowly for how near they are (lag = ticks - kappa x walking tiles from the start: loops, detours, a
		// door's coin tour), the largest lags first (at least 100 ticks apart); per target a goexplore --prefix on a goal
		// level whose trophy is a 3 x 3 box around our run's place there, bounded by our arrival; a route that gets there
		// sooner + our run's own inputs from there (offsets -2..2) are the candidates
		const L = E.loadLevel(cs.level);
		const ref = C.readEetas(cs.ref);
		const T = traceRun(L, ref);
		const W = L.width, H = L.height;
		const BK = require(path.join(code, 'src', 'blocks.js'));
		const t0x = tileOf(T.X[cs.fixed]), t0y = tileOf(T.Y[cs.fixed]);
		const dist = new Int32Array(W * H).fill(-1);
		{
			const q = [t0y * W + t0x];
			dist[q[0]] = 0;
			for (let h = 0; h < q.length; h++) {
				const i = q[h], x = i % W, y = (i / W) | 0;
				for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const k = ny * W + nx;
					if (dist[k] >= 0 || BK.isSolidId(L.fg[k])) continue;
					dist[k] = dist[i] + 1;
					q.push(k);
				}
			}
		}
		const kappa = +(opt.kappa || 4);
		const span = Math.min(T.n, cs.fixed + Math.max(600, Math.round(cs.ours * 1.5)));
		const cand = [];
		for (let j = cs.fixed + 40; j <= span; j += 5) {
			const d = dist[tileOf(T.Y[j]) * W + tileOf(T.X[j])];
			if (d < 3) continue;   // (unreachable by the walk, or where the start already is)
			cand.push({ j, lag: (j - cs.fixed) - kappa * d });
		}
		cand.sort((a, b) => b.lag - a.lag);
		const K = +(opt.targets || 4), picks = [];
		for (const c of cand) { if (c.lag < 30) break; if (picks.every((p) => Math.abs(p.j - c.j) >= 100)) picks.push(c); if (picks.length >= K) break; }
		say({ targets: picks });
		const d0 = JSON.parse(fs.readFileSync(cs.level, 'utf8'));
		for (let k = 0; k < picks.length; k++) {
			if (stopped() || left() < 8) break;
			const j = picks[k].j;
			// the goal level for this target (the level's trophies air, the box's free tiles the trophy)
			const d = Object.assign({}, d0);
			const fg = Buffer.from(d0.fg_b64, 'base64');
			for (let i = 0; i < W * H; i++) if (fg.readInt32LE(i * 4) === 121) fg.writeInt32LE(0, i * 4);
			const free = new Set(['empty', 'arrow', 'dot', 'liquid', 'climbable', 'deco', 'coin_taken', 'spawn', 'checkpoint']);
			const bx = tileOf(T.X[j]), by = tileOf(T.Y[j]);
			for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) {
				if (x < 0 || y < 0 || x >= W || y >= H) continue;
				const id = fg.readInt32LE((y * W + x) * 4);
				if (free.has(BK.kindOf(id).kind) && id !== 416 && id !== 1585) fg.writeInt32LE(121, (y * W + x) * 4);
			}
			d.fg_b64 = fg.toString('base64');
			const gl = path.join(out, `target_${k}.json`);
			fs.writeFileSync(gl, JSON.stringify(d));
			const ro = path.join(out, `route_${k}.tmp`);
			const secs = Math.max(8, Math.floor(left() / (picks.length - k)) - 2);
			await child([path.join(code, 'src', 'goexplore.js'), gl, `--prefix=${cs.prefix}`, `--workers=${cs.threads}`, '--cells=coarse', '--steer=build', '--stdin=1',
				`--seconds=${secs}`, `--depth=${j}`, `--out=${ro}`, `--seed=${+(opt.seed || 1)}`, `--mem=${+(opt.mem || 700)}`], { stdin: true });
			if (!fs.existsSync(ro)) { say({ target: j, route: null }); continue; }
			const r = C.readEetas(ro);
			// the route + our run's inputs from our tick at the box (offsets -2..2): whole runs for the verifier
			let jj = j;
			for (let t = cs.fixed; t <= j; t++) if (Math.abs(tileOf(T.X[t]) - bx) <= 1 && Math.abs(tileOf(T.Y[t]) - by) <= 1) { jj = t; break; }
			for (let o = -2; o <= 2; o++) {
				const s = Math.max(0, jj + o);
				const m = new Uint8Array(r.length + ref.length - s);
				m.set(r); m.set(ref.subarray(s), r.length);
				C.writeEetas(path.join(out, `leap_${k}_${o + 2}.eetas`), m);
			}
			say({ target: j, route: r.length, gain: jj - r.length });
		}
		return;
	}
	if (name === 'leaps') {
		// the long-range shortcut search (the leaps branch: --leapsCode, its eegpu with --ahead as --tool): starts from
		// the case's start ticks, our run as the reference; every faster run it writes is a candidate
		const lc = path.resolve(opt.leapsCode || code);
		const args = [path.join(lc, 'src', 'leaps.js'), `--tas=${cs.ref}`, `--level=${cs.level}`, `--out=${path.join(out, 'leaps.eetas')}`, `--seconds=${Math.max(10, Math.floor(left()))}`,
			// (the starts: from the case's start over the first half of our run's way to the goal)
			`--from=${cs.fixed}`, `--to=${Math.max(cs.startMax, cs.fixed + Math.floor(cs.ours / 2))}`, `--leapStep=${Math.max(25, Math.min(250, Math.floor(cs.ours / 8)))}`,
			// (the met visit: at least half of our run's way to the goal ahead, at most past it; leaps' defaults 300 / 3000)
			`--minAhead=${Math.max(30, Math.min(300, Math.floor(cs.ours / 2)))}`, `--maxSpan=${Math.max(600, cs.ours + 300)}`, `--minGain=${Math.max(5, Math.min(20, Math.floor((cs.ours - cs.par) / 4)))}`,
			...(opt.tool ? [`--tool=${opt.tool}`] : []), ...(opt.leapArgs ? opt.leapArgs.split(' ').filter(Boolean) : [])];
		const r = await child(args, { onLine: (l) => { if (/"ev":"leap"/.test(l)) say({ candidate: 'leaps.eetas' }); } });
		if (r.code) say({ error: `leaps exit ${r.code}`, last: r.last.slice(-5) });
		return;
	}
	if (name === 'skipfind') {
		// the skip finder (src/skipfind.js, NOT told the goal): its searches from our run's states from the case's start
		// over the first 3/4 of our way to the goal (every --sfEvery ticks, default ours / 12 within 10..50, in run order),
		// our run as the reference; every faster run it writes is a candidate (copied: it rewrites its --out at each find)
		const every = +(opt.sfEvery || Math.max(10, Math.min(50, Math.round(cs.ours / 12))));
		const to = Math.max(cs.startMax || cs.fixed, cs.fixed + Math.floor(cs.ours * 0.75));
		const sfOut = path.join(out, 'skipfind_live.eetas.keep');
		const args = [path.join(code, 'src', 'skipfind.js'), `--tas=${cs.ref}`, `--level=${cs.level}`, `--out=${sfOut}`, `--seconds=${Math.max(10, Math.floor(left()))}`,
			`--from=${cs.fixed}`, `--to=${to}`, '--order=run', `--every=${every}`, `--workers=${Math.max(1, cs.threads | 0)}`,
			...(opt.sfArgs ? opt.sfArgs.split(' ').filter(Boolean) : [])];
		let k = 0;
		const r = await child(args, { onLine: (l) => {
			if (!/"ev":"skip"/.test(l)) return;
			const f = `skipfind_${k++}.eetas`;
			try { fs.copyFileSync(sfOut, path.join(out, f)); say({ candidate: f }); } catch (e) { /* the next find */ }
		} });
		if (r.code > 1) say({ error: `skipfind exit ${r.code}`, last: r.last.slice(-5) });
		return;
	}
	if (name === 'routearm') {
		// Find a route's route arm (src/routearm.js, NOT told the goal) with our run as the route: its GPU searches from our
		// run's own states, starts from the case's start every --raStep ticks (default the arm's own step) over 3/4 of our
		// way to the goal, then the same starts shifted by half a step; every route it splices (a whole run faster than
		// ours, replayed) is a candidate. --tool / --cachedir: the eegpu to use; --raArgs="k=v ...": the arm's options.
		const RA = require(path.join(code, 'src', 'routearm.js'));
		const G = require(path.join(code, 'src', 'gpu.js'));
		const RF = require(path.join(code, 'src', 'reach.js'));
		const L = E.loadLevel(cs.level);
		const ref = C.evaluate(L, C.readEetas(cs.ref));
		const work = path.join(out, 'arm');
		fs.mkdirSync(work, { recursive: true });
		const blob = G.levelBlob(L), bin = path.join(work, 'level.bin');
		fs.writeFileSync(bin, blob);
		const field = RF.reachField(L, {});
		const extra = {};
		for (const kv of (opt.raArgs || '').split(' ').filter(Boolean)) { const [k, v] = kv.split('='); extra[k] = +v; }
		const step = +(opt.raStep || RA.DEFAULTS.step);
		const to = Math.max(cs.startMax || cs.fixed, cs.fixed + Math.floor(cs.ours * 0.75));
		const starts = [];
		for (let s = cs.fixed; s <= to; s += step) starts.push(s);
		for (let s = cs.fixed + Math.floor(step / 2); s <= to; s += step) starts.push(s);
		say({ starts });
		let bound = ref.ms.length - 1, k = 0;
		const ra = RA.create({ L, field, tool: opt.tool || G.nativeTool(), bin, fp: G.blobFp(blob), work, cacheArgs: opt.cachedir ? [`--cachedir=${opt.cachedir}`] : [],
			a: { gpuCells: 25, burstCap: 262144 }, bound: () => bound, say,
			finish: (ms, how) => {
				const f = `routearm_${k++}.eetas`;
				C.writeEetas(path.join(out, f), ms);
				bound = Math.min(bound, ms.length - 1);
				say({ candidate: f, ticks: ms.length, how, sec: Math.round((Date.now() - t0) / 1000) });
			},
			broadcast: () => {} }, Object.assign({ starts }, extra));
		ra.setRoute(ref.ms);
		let oomN = 0, oomS = 0;
		while (!stopped() && left() > 5) {
			const r = await ra.run(0, { stopped: () => stopped() || left() < 0 });
			if (!r) break;
			say({ start: r.s, pot: r.pot, hits: r.hits, saved: r.saved, ends: r.ends, sec: Math.round((Date.now() - t0) / 1000) });
			// (the GPU's memory full: the start goes again after a wait, as in the one search's lanes, bursts.js)
			if (r.oom) { const w = Math.min(30, 5 * (1 + oomN++)); oomS += w; for (let q = 0; q < 10 * w && !stopped() && left() > 5; q++) await sleep(100); } else oomN = 0;
		}
		if (oomS) say({ oomWaitS: oomS });
		say({ stats: ra.stats() });
		return;
	}
	throw new Error(`unknown finder ${name} (${BUILTIN.join(', ')})`);
}

/** --remote: the same run on a rented machine (the checkout's src/, this tool and the cases go up to --dir; the run's
 *  JSON comes back). --leapsCode / --tool / --cachedir are the remote's paths there. */
function remote() {
	const code = path.resolve(opt.code || ROOT);
	const label = opt.label || (opt.finder || 'none').replace(/[^\w.-]+/g, '_').slice(0, 40);
	const ssh = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
	const sshArgs = opt.remote.replace(/^ssh\s+/, '').split(/\s+/).filter(Boolean);
	const known = path.join(ROOT, 'src', 'out', 'remote', 'known_hosts');
	if (fs.existsSync(known) && !sshArgs.some((x) => /UserKnownHostsFile/.test(x))) sshArgs.unshift('-o', `UserKnownHostsFile=${known}`);
	const dir = opt.dir || `/root/pb_${label}`;
	const jsonOut = path.resolve(opt.json || path.join(DATA, 'results', `${label}.json`));
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	const tar = (cwd, list, excl) => {
		const r = spawnSync('tar', ['czf', '-', ...excl.map((x) => `--exclude=${x}`), ...list], { cwd, maxBuffer: 1 << 30 });
		if (r.status !== 0) throw new Error(`tar failed in ${cwd}: ${r.stderr}`);
		return r.stdout;
	};
	const up = (buf, sub) => {
		const r = spawnSync(ssh, [...sshArgs, `mkdir -p ${dir}/${sub} && tar xzf - -C ${dir}/${sub}`], { input: buf, maxBuffer: 1 << 26 });
		if (r.status !== 0) throw new Error(`upload failed: ${r.error ? r.error.message : r.stderr}`);
	};
	if (opt.upload !== '0') {
		up(tar(code, ['src', 'package.json'], ['src/out', 'src/jobs', 'src/data', 'src/bin']), 'code');
		up(tar(__dirname, [path.basename(__filename)], []), 'code/tools');
		up(tar(DATA, ['cases.json', 'levels', 'prefix', 'ref', 'known'], []), 'data');
	}
	const keep = argv.filter((x) => !/^--(remote|dir|json|code|data|upload)=/.test(x));
	if (!opt.label) keep.push(`--label=${label}`);
	const node = '$( [ -x ~/.local/node/bin/node ] && echo ~/.local/node/bin/node || echo node )';
	const cmdline = `mkdir -p ${dir}/tmp && cd ${dir} && TMPDIR=${dir}/tmp ${node} code/tools/${path.basename(__filename)} run --code=${dir}/code --data=${dir}/data --work=${dir}/work_${label} --json=${dir}/out_${label}.json ${keep.map((x) => `'${x.replace(/'/g, '')}'`).join(' ')}`;
	const p = spawn(ssh, [...sshArgs, cmdline], { stdio: ['ignore', 'inherit', 'inherit'] });
	p.on('exit', (c) => {
		const r = spawnSync(ssh, [...sshArgs, `cat ${dir}/out_${label}.json`], { maxBuffer: 1 << 28 });
		if (r.status === 0 && r.stdout.length) { fs.writeFileSync(jsonOut, r.stdout); console.log(`-> ${jsonOut}`); }
		process.exitCode = c;
	});
}

if (require.main === module) {
	const cmds = { list, verify: verifyCmd, mine: mineCmd, build, check, table };
	if (cmd === 'run' && opt.remote) { remote(); return; }
	if (cmd === 'run') { runBench().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; }); return; }
	if (cmd === 'finder') { finderCmd().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; }); return; }
	try {
		if (cmds[cmd]) cmds[cmd]();
		else { console.log('usage: node tools/pathbench.js build | list | verify <case> <run.eetas> | run --finder=... (see the header)'); process.exitCode = 2; }
	} catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
}
