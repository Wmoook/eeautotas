'use strict';
// The one search's GPU operator (src/goexplore.js --bursts=1, coarse cells; the editor's "Find a route" on levels above
// 50 x 50 tiles with an NVIDIA GPU): short exhaustive "every move" bursts (eegpu explore --prefix, a fresh table, fine
// speed cells) launched FROM THE ONE ARCHIVE's cells, aimed at the room's untried triggers, their attempts fed back into
// the archive. It replaces the editor's relay, which started from its own nearest attempt by a trophy distance that is
// meaningless on levels with effects (Infinity Pain: 1,070 of its 1,469 runs from one 7.8-tile pocket), next to a CPU
// search that never used what the relay found.
//
// Rooms (goexplore.js roomOf: the state that opens doors or changes the physics) come from the workers' first cells in
// them ('room' messages), from the bursts' own attempts (every room along a replayed attempt) and from the start. A
// room's TRIGGERS are the tiles that can change the room (src/blocks.js kinds effect, switch, key, reset; coins where a
// coin door or gate reads them; crowns where a crown door does), grouped into components of 4-connected tiles of the
// same block: a strip of team tiles is one trigger. Its targets are the triggers its door- and protection-aware walk
// reaches from where it was entered (goexplore.js roomFields' passable set), not tried from it yet (a worker's run or a
// burst changed the room there, or a burst reached it), plus the trophy where it is walkable. The segment study of
// Infinity Pain's known route: 109 of its 120 room changes were found by the CPU search from the route's state, and the
// long in-room stretches it missed were found by exhaustive GPU bursts aimed at the room's next trigger; the next trigger
// ranked 1st to 7th of 3-136 by walking distance (src/out/ipseg). So a room's bursts aim at ALL its untried triggers at
// once (a walk field with them as goals: the burst's order, layer cap and nearest attempt), the nearest first; a trigger
// reached is tried, and the next burst aims at the rest.
//
// A burst (one eegpu explore process) starts from the archive's cell of that room nearest its targets (every worker is
// asked for its own; the nearest of all, the earliest among equals), sometimes 60 / 200 ticks back along it; its cells
// come from CONFS (below). Each nearer attempt it prints (the explore's closest, by the steer
// field) is replayed in the JS engine (its rooms registered) and imported into every worker's archive: the CPU's random
// runs go on from there. The first attempt on a target (distance 0) ends the burst; a finish (the explore's hit) is
// replayed with common.js evaluate and reported like the workers' routes.
//
// The scheduler is a bandit over rooms: a burst's reward is the rooms nobody had found before it (at most 3) + 0.3 for a
// room change + 0.3 x the share of the way to its targets it closed; a room's score is its mean reward + UCB_C x
// sqrt(ln(1 + bursts) / its bursts); a room never burst from scores UNTRIED (the newest first: the frontier). The
// trophy arm (today's relay: from the nearest attempt to the trophy by the reach field, 60 / 150 / 400 ticks back)
// competes with them in physics mode, and in walk mode runs only when no room has a target left. A burst that got
// nearer goes on from its nearest attempt (CHAIN_MAX). The burst settings (CONFS) have a bandit per room.
//
// Soundness: a burst's cost ceiling (--costslack, the relay's 30 tiles + 10% of the start's distance on the steer field)
// only orders an operator's own states, as the relay's did; the archive drops a state only by the reach field's -1, and
// every route is replayed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.js');
const E = C.E;
const RF = require('./reach.js');
const G = require('./gpu.js');
const BK = require('./blocks.js');

// the burst's settings (explore --cqx --cqv --qy --qvy and --cap, the states kept per tick layer, nearest the targets first):
// 1/16 px/tick speeds with 4 px positions (the relay from Infinity Pain's own states reached its long low-gravity
// subgoals only with 1/16 px/tick cells; with the relay's 1/4 px/tick a slow ball stays in its cell and the runs ran out
// of states after 2-57 ticks); 8 px positions with a quarter of the layer; 4 px with a layer of 64 K (deep and greedy: a
// long stretch before the table fills); 16 px and 1/8 px/tick (the fly rooms, where finer cells filled the table in
// 70-140 ticks); 8 px with a layer of 16 K (a beam along the steer field with the table's dedupe: the fly rooms' long
// stretches); 2 px and 1/4 px/tick (the relay's second cells: its route on the ice level). Chosen by a bandit of their
// own (CONF_C): each is tried in turn, then by mean reward.
const CONFS = [{ cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16, cap: 1048576 }, { cqx: 0.125, cqv: 16, qy: 0.125, qvy: 16, cap: 262144 },
	{ cqx: 0.25, cqv: 16, qy: 0.25, qvy: 16, cap: 65536 }, { cqx: 0.0625, cqv: 8, qy: 0.0625, qvy: 8, cap: 262144 },
	{ cqx: 0.125, cqv: 16, qy: 0.125, qvy: 16, cap: 16384 }, { cqx: 0.5, cqv: 4, qy: 0.5, qvy: 4, cap: 262144 }];
const CONF_C = 0.3;
// (a chain link after a full table: the settings with the next smaller layer cap)
const GREEDIER = [2, 4, 4, 4, 4, 2];
// how far back along the start cell's run a burst starts, in turn per room (ticks; never 0: the cell nearest the targets
// is often a doomed state, falling toward them into spikes, and a burst from it ran out of states in 1-5 ticks)
const BACK = [30, 90, 30, 250];
const TROPHY_BACK = [60, 150, 400];
const UCB_C = 0.5, NEW_ROOMS_MAX = 3, SLACK = 30, SLACK_F = 0.1, NEAREST_WAIT_MS = 2000;
// the trophy arm with the steer field (goexplore.js --burstSteer, the editor's RCH4 file): the relay's ceiling at most
// (editor.js RELAY_SLACK_MAX), and a distance of 6000+ (the steer field has no value there: 6000 + the reach field's) as
// the reach field's
const SLACK_MAX = 200, STEER_MISS = 6000;
// a burst that found the GPU's memory full waits goexplore.js --burstOomS (5) s, doubled while that lasts, at most
// OOM_WAIT_MAX_S
const OOM_WAIT_MAX_S = 120;
// a room never burst from scores this (the newest first among them): above a room whose bursts only got nearer, below
// one whose bursts keep finding rooms (a level of many switch states has thousands of rooms: each once would take all
// the GPU)
const UNTRIED = 1.5;
// a burst that got nearer its targets without reaching one goes on from its nearest attempt with the same targets (the
// relay's chain: its attempt may end in another room, e.g. after a team toggle, where the room's own next burst would
// aim elsewhere; Infinity Pain's fly rooms: bursts from the same cell, 54 tiles out, again and again got to 28-33 and
// filled their tables), up to CHAIN_MAX times in a row, each from CHAIN_BACK ticks back
const CHAIN_MAX = 12;
// (each link starts this far back along the attempt: the nearest attempt is often doomed, like the start cell)
const CHAIN_BACK = [150, 60, 400, 60];
const CUT = 0xffff;

/** trigger components of level L: comp (Int32Array per tile, -1 = none), n (count) */
function triggersOf(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg;
	let coinDoor = false, blueDoor = false, crownDoor = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id === 43 || id === 165) coinDoor = true;
		else if (id === 213 || id === 214) blueDoor = true;
		else if (id === 1094 || id === 1095 || id === 1152 || id === 1153) crownDoor = true;
	}
	const isTrig = (id) => {
		if (!id) return false;
		const k = BK.kindOf(id).kind;
		return k === 'effect' || k === 'switch' || k === 'key' || k === 'reset' || (k === 'coin' && coinDoor) || (k === 'bluecoin' && blueDoor) || (k === 'crown' && crownDoor);
	};
	const comp = new Int32Array(N).fill(-1), q = new Int32Array(N), ids = [];
	let n = 0;
	for (let i = 0; i < N; i++) {
		if (comp[i] >= 0 || !isTrig(fg[i])) continue;
		let qh = 0, qt = 0;
		comp[i] = n; q[qt++] = i; ids.push(fg[i]);
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (comp[j] < 0 && fg[j] === fg[i]) { comp[j] = n; q[qt++] = j; }
			}
		}
		n++;
	}
	// (consumable: a coin is gone once collected, so a cell standing on its tile proves nothing about it)
	const eaten = Uint8Array.from(ids, (id) => { const k = BK.kindOf(id).kind; return k === 'coin' || k === 'bluecoin' ? 1 : 0; });
	return { comp, n, eaten };
}

/** a room's passable set and walk from the tiles it was entered at (sim: a state in it, at its first arrival; entries:
 *  more tiles it was entered at): the trigger components that change the room from there (comps: component -> its tiles
 *  the walk reached) and the trophy tiles it reaches; s0 the sim's tile; P (portalsOf): through the portals too */
function roomWalk(L, RM, TR, sim, entries, P) {
	const W = L.width, H = L.height, N = W * H;
	const fg = L.fg, fl = L.flags;
	const pass = new Uint8Array(N), wall = new Uint8Array(N);
	for (let k = 0; k < N; k++) {
		const id = fg[k], f = id >= 0 && id < fl.length ? fl[id] : 0;
		const door = (f & 1) !== 0 && (f & 16) !== 0;
		const solid = (f & 1) !== 0 && (f & (2 | 4 | 8)) === 0 && !door;
		const deadly = id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0;
		wall[k] = solid ? 1 : 0;
		pass[k] = solid ? 0 : door ? (sim.is_tile_solid_now(k % W, (k / W) | 0) ? 0 : 1) : deadly && !sim.is_invulnerable ? 0 : 1;
	}
	const s0 = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
	const seen = new Uint8Array(N), q = new Int32Array(N), term = new Uint8Array(N);
	let qh = 0, qt = 0;
	// (from every place the room was entered: the first arrival and each later entry elsewhere)
	for (const e of [s0, ...entries]) if (!seen[e]) { seen[e] = 1; q[qt++] = e; pass[e] = 1; }
	const nSrc = qt;
	// what touching a trigger component does in this room (the engine's own answer: the room's first arrival with its
	// centre put on the tile, one tick without input): a change by a trigger (goexplore.js roomOf byTrigger) makes it a
	// target and the end of the walk there (beyond it the ball is in another room, so a trigger only behind it is no
	// target of this room); no change (an effect this room has already, e.g. a gravity effect of the room's own
	// direction) makes it neither (it never changes the room, so no run or burst could ever try it). Infinity Pain's
	// room "fly grav=2 team=1": 112 targets before, 76 of them only behind another trigger and 35 no-ops, the nearest
	// of them nearer than the wall's (199, 151) from the archive's cells by the tunnel (7 ticks short of it for 70 min);
	// with this rule 2: (189, 159) and the wall's
	const cz0 = RM.cause(sim), snap0 = sim.snapshot(), inp0 = new E.EEInput(), acts = new Map();
	const changes = (c, t) => {
		let v = acts.get(c);
		if (v === undefined) {
			sim.restore(snap0);
			sim.px = (t % W) * 16; sim.py = ((t / W) | 0) * 16; sim.speed_x = 0; sim.speed_y = 0;
			// (a death or an error says nothing: a target, as before the test)
			try { sim.tick(inp0); v = sim.is_dead || RM.byTrigger(cz0, RM.cause(sim)); } catch (e) { v = true; }
			sim.restore(snap0);
			acts.set(c, v);
		}
		return v;
	};
	const comps = new Map(), trophies = [];
	while (qh < qt) {
		const t = q[qh++], x = t % W, y = (t / W) | 0;
		const c = TR.comp[t];
		// (a coin already collected at the room's first arrival is no trigger of it)
		const live = c >= 0 && !(TR.eaten[c] && sim.is_coin_collected(x, y)) && changes(c, t);
		if (live) { let l = comps.get(c); if (!l) comps.set(c, l = []); l.push(t); }
		if (fg[t] === 121) trophies.push(t);
		// (a trigger that changes the room: a goal, no way through; the places the room was entered at are ways out)
		if (live && qh > nSrc) { term[t] = 1; continue; }
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (seen[j] || !pass[j]) continue;
				if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
				seen[j] = 1; q[qt++] = j;
			}
		}
		// (P: through the portals too)
		const ex = P ? P.fwd.get(t) : null;
		if (ex) for (const j of ex) if (!seen[j] && pass[j]) { seen[j] = 1; q[qt++] = j; }
	}
	return { pass, wall, comps, trophies, seen, term, s0 };
}

/** the level's portals (null: none): fwd (a portal tile -> its exits' tiles), back (an exit tile -> the portal tiles) */
function portalsOf(L) {
	const W = L.width, N = W * L.height, fg = L.fg, fwd = new Map(), back = new Map();
	if (!L.portalSlot || !L.portalsById) return null;
	for (let i = 0; i < N; i++) {
		const s = L.portalSlot[i];
		if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
		const ex = L.portalsById.get(L.pTarget[s]);
		if (!ex) continue;
		const list = [];
		for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && !list.includes(j)) list.push(j); }
		if (!list.length) continue;
		fwd.set(i, list);
		for (const j of list) { let b = back.get(j); if (!b) back.set(j, b = []); b.push(i); }
	}
	return fwd.size ? { fwd, back } : null;
}

/** the walking distance (fifths, 5 per step; CUT = none) to the goal tiles over a room's walk I (roomWalk): another
 *  room-changing trigger is no way through; mx its largest value; P (portalsOf): through the portals too */
function walkField(L, I, goals, P) {
	const W = L.width, H = L.height, N = W * H;
	const walk = new Uint16Array(N).fill(CUT), q = new Int32Array(N);
	let qh = 0, qt = 0, mx = 0;
	for (const g of goals) if (walk[g] === CUT) { walk[g] = 0; q[qt++] = g; }
	while (qh < qt) {
		const t = q[qh++], x = t % W, y = (t / W) | 0, d = Math.min(0xfffd, walk[t] + 5);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				// (another room-changing trigger is no way through either: past it the ball is in another room)
				if (walk[j] !== CUT || !I.pass[j] || I.term[j]) continue;
				if (dx && dy && I.wall[y * W + xx] && I.wall[yy * W + x]) continue;
				walk[j] = d; if (d > mx) mx = d; q[qt++] = j;
			}
		}
		const src = P ? P.back.get(t) : null;
		if (src) for (const j of src) if (walk[j] === CUT && I.pass[j] && !I.term[j]) { walk[j] = d; if (d > mx) mx = d; q[qt++] = j; }
	}
	return { walk, mx };
}

/** an attempt that reached a target tile: the room changes when the trigger acts (a tick or two later for some): up to
 *  3 more ticks of its last input, else each of the 18 inputs for one tick; the attempt with them when the room changed
 *  alive, else null */
const OPTS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTS.push(h | v | j);
function extendToChange(L, RM, inputs) {
	const sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	for (let k = 0; k < inputs.length; k++) { E.applyMask(inp, (inputs.charCodeAt(k) - 48) & 31); sim.tick(inp); }
	const key = RM.key(sim), snap = sim.snapshot();
	const last = inputs.length ? (inputs.charCodeAt(inputs.length - 1) - 48) & 31 : 0;
	const tryMasks = (ms) => {
		sim.restore(snap);
		for (let k = 0; k < ms.length; k++) {
			E.applyMask(inp, ms[k]);
			sim.tick(inp);
			if (sim.is_dead) return null;
			if (RM.key(sim) !== key) return inputs + String.fromCharCode(...ms.slice(0, k + 1).map((m) => 48 + m));
		}
		return null;
	};
	let r = tryMasks([last, last, last]);
	for (let i = 0; !r && i < OPTS.length; i++) r = tryMasks([OPTS[i]]);
	return r;
}

/**
 * create(o) -> {room(info), edge(from, tile), start(), stop() (a promise), stats()}. o: {L, a (goexplore's options),
 * field (the reach field), RM (roomOf(L)), ports (the workers' MessagePorts), say (an event line), bound() (the longest
 * route that still counts, ticks), register(info) (a room the bursts found: into the main thread's registry, true when
 * new), broadcast(inputs) (an attempt into every worker's archive), finish(masks, how) (a route: replayed already),
 * nearest() ({inputs, rc} the attempt nearest the trophy by the reach field, or null), sec() (seconds since the start)}
 */
function create(o) {
	const L = o.L, a = o.a, W = L.width, H = L.height, N = W * H;
	const TR = triggersOf(L);
	const work = a.work || fs.mkdtempSync(path.join(os.tmpdir(), 'gx-bursts-'));
	fs.mkdirSync(work, { recursive: true });
	const bin = path.join(work, 'level.bin');
	const blob = G.levelBlob(L);
	fs.writeFileSync(bin, blob);
	const fp = G.blobFp(blob);
	const tool = a.tool || G.nativeTool();
	const cacheArgs = a.cachedir ? [`--cachedir=${a.cachedir}`] : [];
	const rooms = new Map();   // room key -> {key, desc, seq, tile, inputs, n, y, sec, tried: Set(component), info (lazy), best}
	let seq = 0, stopped = false, reqId = 0, loopP = null;
	const children = new Set();   // the running bursts' processes (--burstPar lanes: one each)
	// (the trophy arm's steer file: written by this search, once: the work folder may hold another level's)
	let trophyRf = null;
	const pending = new Map();   // request id -> {replies, want, done}
	const st = { bursts: 0, sec: 0, reached: 0, newRooms: 0, imports: 0, finishes: 0, trophy: 0, failed: 0, oom: 0, skipped: 0, chained: 0 };
	const trophyArm = { n: 0, y: 0, back: 0 };
	const confs = CONFS.map(() => ({ n: 0, y: 0 }));
	/** the next burst's settings for room r (null: the trophy arm): a bandit per room (a low-gravity room and a fly room
	 *  want different cells): each once, then its mean reward in the room (the level's mean as a prior worth 2 tries) +
	 *  CONF_C x sqrt(ln(1 + the room's bursts) / tries) */
	const pickConf = (r) => {
		const own = r ? (r.confs || (r.confs = CONFS.map(() => ({ n: 0, y: 0 })))) : confs;
		let b = 0, bs = -Infinity;
		const total = own.reduce((x, c) => x + c.n, 0);
		own.forEach((c, i) => {
			const g = confs[i].n ? confs[i].y / confs[i].n : 0;
			const sc = c.n === 0 ? 100 - i : (c.y + 2 * g) / (c.n + 2) + CONF_C * Math.sqrt(Math.log(1 + total) / c.n);
			if (sc > bs) { bs = sc; b = i; }
		});
		return b;
	};
	for (const p of o.ports) {
		p.on('message', (m) => {
			if (!m || m.type !== 'nearest') return;
			const q = pending.get(m.id);
			if (!q) return;
			q.replies.push(m);
			if (q.replies.length >= q.want) q.done();
		});
	}
	/** a new place the room r was entered at: its walk (targets) from there too, when that is outside it */
	const entry = (r, tile) => {
		if (!(tile >= 0 && tile < N) || r.entries.has(tile)) return;
		r.entries.add(tile);
		if (r.info && !r.info.seen[tile]) { r.info = null; r.fc = null; r.done = false; }
	};
	/** a room (from a worker, a burst or the start): {room (key), desc, tile, t, inputs} */
	const room = (m) => {
		let r = rooms.get(m.room);
		if (!r) {
			r = { key: m.room, desc: m.desc, seq: ++seq, tile: m.tile, t: m.t, inputs: m.inputs, n: 0, y: 0, sec: 0, tried: new Set(), info: null, best: Infinity, k: 0, entries: new Set(),
				trig: m.t > 0 && m.trig !== false };
			rooms.set(m.room, r);
			for (const tl of pendingEntries.get(m.room) || []) entry(r, tl);
			pendingEntries.delete(m.room);
		} else if (m.t < r.t) { r.t = m.t; r.inputs = m.inputs; r.tile = m.tile; r.trig = m.t > 0 && m.trig !== false; }
		entry(r, m.tile);
		return r;
	};
	const pendingEntries = new Map();   // (entries of rooms not known yet)
	/** the trigger component at a tile, else one next to it (a trigger acts on the ball's box, not only its centre) */
	const compNear = (tile) => {
		if (!(tile >= 0 && tile < N)) return -1;
		if (TR.comp[tile] >= 0) return TR.comp[tile];
		const x = tile % W, y = (tile / W) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < W && yy < H && TR.comp[yy * W + xx] >= 0) return TR.comp[yy * W + xx];
			}
		}
		return -1;
	};
	/** a room change from room `from` to room `to` at tile: `to` was entered there, and when a trigger made the change
	 *  (trig: not a time door flipping or a key expiring, goexplore.js roomOf byTrigger) that trigger was tried from there */
	const edge = (from, tile, to, trig) => {
		const r = rooms.get(from), c = trig === false ? -1 : compNear(tile);
		if (r && c >= 0) r.tried.add(c);
		if (to === undefined || to === null) return;
		const r2 = rooms.get(to);
		if (r2) entry(r2, tile);
		else { let l = pendingEntries.get(to); if (!l) pendingEntries.set(to, l = []); if (l.length < 64) l.push(tile); }
	};
	/** a sim in room r (its first arrival) */
	const simAt = (inputs) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let k = 0; k < inputs.length; k++) { E.applyMask(inp, (inputs.charCodeAt(k) - 48) & 31); sim.tick(inp); }
		return sim;
	};
	/** room r's passable set and walk from its entry: the triggers (components) and trophy tiles it reaches */
	const infoOf = (r) => {
		if (r.info) return r.info;
		const I = roomWalk(L, o.RM, TR, simAt(r.inputs), r.entries);
		// (the trigger the room was first entered by is not a target: it made this room; not when the clock made it)
		const c0 = r.trig ? compNear(I.s0) : -1;
		if (c0 >= 0 && !r.info0) { r.tried.add(c0); r.info0 = true; }
		r.info = I;
		return r.info;
	};
	/** the steer field of room r: walking distance (fifths, 5 per step) to its untried targets; null: none left */
	const fieldOf = (r) => {
		// (cached while no trigger of the room was tried since)
		if (r.fc && r.fc.n === r.tried.size) return r.fc.f;
		const f = fieldOf0(r);
		r.fc = { n: r.tried.size, f };
		return f;
	};
	const fieldOf0 = (r) => {
		const I = infoOf(r);
		const goals = [];
		for (const [c, tiles] of I.comps) if (!r.tried.has(c)) for (const t of tiles) goals.push(t);
		const n = goals.length;
		if (o.field.mode === 'walk') for (const t of I.trophies) goals.push(t);
		if (!goals.length) return null;
		const { walk, mx } = walkField(L, I, goals);
		return { walk, mx, triggers: n, trophies: o.field.mode === 'walk' ? I.trophies.length : 0 };
	};
	/** every worker's cell of room r nearest the field's goals (the nearest of all; null when none has one) */
	const nearestCell = (r, walk) => new Promise((res) => {
		const id = ++reqId;
		const q = { replies: [], want: o.ports.length, done: null };
		let timer = null;
		q.done = () => {
			if (timer) clearTimeout(timer);
			pending.delete(id);
			let b = null;
			for (const m of q.replies) if (m.v >= 0 && (!b || m.v < b.v || (m.v === b.v && m.t < b.t))) b = m;
			res(b);
		};
		pending.set(id, q);
		timer = setTimeout(q.done, NEAREST_WAIT_MS);
		for (const p of o.ports) p.postMessage({ type: 'nearest', id, room: r.key, field: walk });
	});
	/** an attempt (inputs, from the level start) replayed: its rooms registered (the new ones counted), the room and tile
	 *  it ends in; null when it dies */
	const replay = (inputs, parentKey, quiet) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		let key = o.RM.key(sim), fresh = 0, cz = o.RM.cause(sim);
		for (let k = 0; k < inputs.length; k++) {
			E.applyMask(inp, (inputs.charCodeAt(k) - 48) & 31);
			sim.tick(inp);
			if (sim.is_dead) return null;
			const k2 = o.RM.key(sim);
			if (k2 !== key && !quiet) {
				const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
				const cz2 = o.RM.cause(sim), trig = o.RM.byTrigger(cz, cz2);
				edge(key, tile, k2, trig);
				if (o.register({ room: k2, desc: o.RM.desc(sim), tile, t: k + 1, inputs: inputs.slice(0, k + 1), parent: key, trig })) fresh++;
				cz = cz2;
			}
			key = k2;
		}
		const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		return { key, tile, fresh, parentKey };
	};
	/** an attempt that reached a target tile, on until its room changed (extendToChange) */
	const extend = (inputs) => extendToChange(L, o.RM, inputs);
	/** the next burst: {r (room, or null: the trophy arm), f (its field)} */
	const pick = () => {
		let best = null, bs = -Infinity;
		const total = st.bursts;
		// (the rooms by score; a room's field (a replay and two walks) only for the best ones until one has a target: a
		// level of many switches has thousands of rooms)
		const cand = [];
		for (const r of rooms.values()) {
			if (r.done || r.busy) continue;
			cand.push([r.n === 0 ? UNTRIED + r.seq * 1e-6 : r.y / r.n + UCB_C * Math.sqrt(Math.log(1 + total) / r.n), r]);
		}
		cand.sort((x, y) => y[0] - x[0]);
		for (const [sc, r] of cand) {
			let f;
			try { f = fieldOf(r); } catch (e) { r.done = true; continue; }
			if (!f) { r.done = true; continue; }
			bs = sc; best = { r, f };
			break;
		}
		// the trophy arm (the relay: the reach field's nearest attempt), an arm like the rooms (untried: after the untried
		// rooms); with a walk-mode field (effects: its trophy distance ignores doors and physics, and Infinity Pain's nearest
		// attempt by it sat in a pocket 7.8 tiles out for the whole hour) only when no room has a target left: the rooms'
		// own walks aim at the trophy there
		const nr = trophyArm.busy || (o.field.mode === 'walk' && best) ? null : o.nearest();
		if (nr && nr.inputs.length >= 100) {
			const s = trophyArm.n === 0 ? UNTRIED - 0.5 : trophyArm.y / trophyArm.n + UCB_C * Math.sqrt(Math.log(1 + total) / trophyArm.n);
			if (s > bs) { bs = s; best = { trophy: true, nr }; }
		}
		return best;
	};
	const sleep = (ms) => new Promise((res) => { const t = setTimeout(res, ms); if (t.unref) t.unref(); });
	/** one burst: from `inputs` (a prefix), the steer file `reach`, the cells; resolves {end, sec, reached, fresh, nearest} */
	const burst = (job) => new Promise((res) => {
		const pre = path.join(work, `prefix_${job.lane}.eetas`), stop = path.join(work, `stop_${job.lane}`);
		try { fs.unlinkSync(stop); } catch (e) { /* none */ }
		fs.writeFileSync(pre, Buffer.from(job.inputs, 'latin1'));
		const T = o.bound();
		const depth = T < a.depth ? Math.max(1, T - 1 - job.inputs.length) : 100000;
		const c = job.cells;
		const args = ['explore', bin, '-', `--prefix=${pre}`, '--finish=1', '--discrete=1', `--depth=${depth}`, `--seconds=${job.seconds}`, '--coarse=0',
			`--cqx=${c.cqx}`, `--cqv=${c.cqv}`, `--qy=${c.qy}`, `--qvy=${c.qvy}`, `--reach=${job.reach}`, `--cells=${a.gpuCells}`, `--cap=${a.burstCap > 0 ? Math.min(c.cap, a.burstCap) : c.cap}`,
			...(job.slack > 0 ? [`--costslack=${job.slack}`] : []), ...(job.steer ? [`--steer=${job.steer}`] : []), `--stopfile=${stop}`, ...(a.pausefile ? [`--pausefile=${a.pausefile}`] : []), `--parent=${process.pid}`, ...cacheArgs];
		const t0 = Date.now();
		let ch;
		// (a .js tool: a stand-in for eegpu run by this Node, test/editor.js)
		const cmd = /\.js$/i.test(tool) ? [process.execPath, tool, ...args] : [tool, ...args];
		try { ch = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true }); } catch (e) { res({ end: `spawn: ${e.message}`, sec: 0, fail: true }); return; }
		children.add(ch);
		let buf = '', done = null, reached = false, changed = false, fresh = 0, near = Infinity, readyAt = 0, err = '', ended = false, best = null;
		const halt = () => { if (!ended) { ended = true; try { fs.writeFileSync(stop, '1'); } catch (e) { /* gone */ } } };
		job.halt = halt;
		const onLine = (line) => {
			if (!line.startsWith('{')) return;
			let e;
			try { e = JSON.parse(line); } catch (x) { return; }
			if (e.ev === 'ready') { readyAt = Date.now(); return; }
			if (e.ev === 'done') { done = e; return; }
			if (e.error) { err = String(e.error); return; }
			if (e.ev === 'hit' && e.inputs) {
				const masks = Uint8Array.from(e.inputs, (ch2) => (ch2.charCodeAt(0) - 48) & 31);
				o.finish(masks, 'burst');
				st.finishes++;
				return;
			}
			if (e.ev === 'closest' && e.inputs && !e.cut) {
				const d = +e.dist;
				if (!(d < near - 1e-3)) return;
				near = d;
				let inputs = String(e.inputs);
				let tile = -1;
				if (job.r && d <= 1e-3) {
					// a target reached: its trigger is tried from this room (the next burst aims at the rest); the attempt goes on
					// into the room the trigger makes, when it makes one
					const rp0 = replay(inputs, null, true);
					if (rp0) tile = rp0.tile;
					const x = extend(inputs);
					if (x) { inputs = x; changed = true; }
				}
				const rp = replay(inputs, job.r ? job.r.key : null);
				if (rp) {
					best = inputs;
					fresh += rp.fresh;
					o.broadcast(inputs);
					st.imports++;
				}
				if (job.r && d <= 1e-3) {
					reached = true;
					const cc = compNear(tile >= 0 ? tile : rp ? rp.tile : -1);
					if (cc >= 0) job.r.tried.add(cc);
					halt();
				}
			}
		};
		ch.stdout.on('data', (d) => {
			buf += d;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
		});
		ch.stderr.on('data', (d) => { err = (err + d).slice(-400); });
		ch.on('error', (e) => { err = e.message; });
		ch.on('close', (code) => {
			children.delete(ch);
			const sec = (Date.now() - (readyAt || t0)) / 1000;
			res({ end: done ? done.end : `exit ${code}${err ? `: ${err.trim().split('\n').pop()}` : ''}`, sec, wall: (Date.now() - t0) / 1000, reached, changed, fresh, near, best, fail: !done && !ended && !stopped,
				states: done ? done.states : 0, layers: done ? done.layers : 0 });
		});
	});
	/** the steer file for a field (walk mode: the explore's order, layer cap, nearest attempt and cost ceiling) */
	const steerFile = (walk, mx, lane) => {
		const file = path.join(work, `steer_${lane}.reach`);
		const f = Object.assign({}, o.field, { mode: 'walk', walk, prioShift: Math.max(0, (32 - Math.clz32(mx)) - 12) });
		RF.writeReachFile(f, file, fp);
		return file;
	};
	const loop = async (lane) => {
		let fails = 0, oom = 0, next = null;
		while (!stopped) {
			const now = o.sec();
			const left = a.seconds - now;
			if (left < 3) break;
			let job = null;
			const p = next ? null : pick();
			if (next) {
				job = Object.assign(next, { seconds: Math.max(2, Math.min(a.burstS, Math.floor(left - 1))) });
				next = null;
				if (job.r) job.r.busy = true; else trophyArm.busy = true;
			} else if (p && !p.trophy) {
				const r = p.r;
				r.busy = true;
				const cell = await nearestCell(r, p.f.walk);
				if (stopped) break;
				// (a cell of this room standing on a target: that trigger does not change the room from here: tried, and no burst)
				if (cell && cell.v === 0 && cell.tile >= 0 && TR.comp[cell.tile] >= 0 && !TR.eaten[TR.comp[cell.tile]] && !r.tried.has(TR.comp[cell.tile])) { r.tried.add(TR.comp[cell.tile]); st.skipped++; r.busy = false; continue; }
				r.lastField = p.f;
				const k = r.k++;
				let inputs = cell ? cell.inputs : r.inputs, v = cell ? cell.v : p.f.walk[r.tile];
				const back = BACK[k % BACK.length];
				if (inputs.length > back + 50) inputs = inputs.slice(0, inputs.length - back);
				if (!(v >= 0 && v < CUT)) v = p.f.mx;
				const ci = pickConf(r);
				job = { lane, r, inputs, conf: ci, cells: CONFS[ci], reach: steerFile(p.f.walk, p.f.mx, lane), slack: Math.round(SLACK + SLACK_F * v / 5), seconds: Math.max(2, Math.min(a.burstS, Math.floor(left - 1))),
					startDist: v / 5, chain: 0, what: `room "${r.desc}" (${p.f.triggers} trigger tile${p.f.triggers === 1 ? '' : 's'}${p.f.trophies ? ' + the trophy' : ''} left), settings ${ci}, ${back} back` };
			} else if (p) {
				// the trophy arm: the relay (the reach field's nearest attempt, 60 / 150 / 400 ticks back)
				const nr = p.nr;
				const back = TROPHY_BACK[trophyArm.back++ % TROPHY_BACK.length];
				const inputs = nr.inputs.slice(0, Math.max(50, nr.inputs.length - back));
				trophyArm.busy = true;
				if (!trophyRf) { trophyRf = path.join(work, 'trophy.reach'); RF.writeReachFile(o.field, trophyRf, fp); }
				const rf = trophyRf;
				const ci = pickConf(null);
				// (the steer field, when the editor passes it: the trophy arm's order, the relay's; its ceiling then counts both fields)
				const d0 = nr.rc >= STEER_MISS ? nr.rc - STEER_MISS : nr.rc;
				job = { lane, r: null, inputs, conf: ci, cells: CONFS[ci], reach: rf, steer: a.burstSteer || '', slack: Math.min(SLACK_MAX, Math.round(SLACK + SLACK_F * d0)),
					seconds: Math.max(2, Math.min(a.burstS, Math.floor(left - 1))),
					startDist: nr.rc, chain: 0, what: `the trophy (the nearest attempt, ${back} back)` };
			} else { await sleep(1000); continue; }
			const r = await burst(job);
			if (job.r) job.r.busy = false; else trophyArm.busy = false;
			if (r.fail) {
				st.failed++;
				// (the GPU's memory taken by the other tools (every move's table, the beams, the random runs' pool, other
				// searches on a shared GPU): a wait, doubled while it lasts (--burstOomS, up to OOM_WAIT_MAX_S), never the end
				// of the bursts, and no try of the arm; the shared H100 lost every burst of two 300 s searches to three such
				// failures in their first 20 s)
				if (/out of memory/i.test(r.end)) {
					st.oom++;
					const w = Math.min(OOM_WAIT_MAX_S, (a.burstOomS > 0 ? a.burstOomS : 5) * (1 << oom));
					o.say({ ev: 'warning', text: `burst: ${r.end}: again in ${w} s` });
					for (let k = 0; k < 10 * w && !stopped; k++) await sleep(100);
					oom = Math.min(8, oom + 1);
					continue;
				}
				// (a failure counts as a try of its arm with no reward: one broken arm must not win every pick)
				if (job.r) job.r.n++; else trophyArm.n++;
				o.say({ ev: 'warning', text: `burst: ${r.end}` });
				// (a start that dies (its inputs, e.g. cut back along a doomed attempt) is the arm's failure, not the tool's)
				if (/the prefix dies/.test(r.end)) continue;
				if (++fails >= 3) { o.say({ ev: 'warning', text: 'bursts: 3 failures in a row: no more GPU bursts' }); break; }
				await sleep(2000);
				continue;
			}
			oom = 0;
			fails = 0;
			st.bursts++; st.sec += r.sec; if (r.reached) st.reached++; st.newRooms += r.fresh;
			const prog = Number.isFinite(r.near) && job.startDist > 0 ? Math.max(0, Math.min(1, (job.startDist - r.near) / job.startDist)) : 0;
			const reward = Math.min(NEW_ROOMS_MAX, r.fresh) + (r.changed ? 0.3 : 0) + 0.3 * prog;
			if (job.r) { job.r.n++; job.r.y += reward; job.r.sec += r.sec; if (r.near < job.r.best) job.r.best = r.near; } else { trophyArm.n++; trophyArm.y += reward; st.trophy++; }
			confs[job.conf].n++; confs[job.conf].y += reward;
			if (job.r && job.r.confs) { job.r.confs[job.conf].n++; job.r.confs[job.conf].y += reward; }
			o.say({ ev: 'burst', n: st.bursts, room: job.r ? job.r.desc : null, what: job.what, from: job.inputs.length, sec: Math.round(r.sec * 10) / 10, end: r.end,
				reached: r.reached, changed: r.changed, newRooms: r.fresh, dist: Number.isFinite(r.near) ? Math.round(r.near * 10) / 10 : null, startDist: Math.round(job.startDist * 10) / 10,
				states: r.states, layers: r.layers, reward: Math.round(reward * 100) / 100, chain: job.chain || 0, at: o.sec() });
			// the chain: nearer without reaching a target: on from its nearest attempt, the same targets (the same steer file)
			if (!r.reached && r.best && Number.isFinite(r.near) && r.near < job.startDist - 1 && job.chain < CHAIN_MAX) {
				const c = job.chain + 1, back = CHAIN_BACK[c % CHAIN_BACK.length];
				const inputs = back && r.best.length > back + 50 ? r.best.slice(0, r.best.length - back) : r.best;
				// (a table that filled before a target: the next link greedier, a smaller layer (CONFS' caps 1 M -> 64 K -> 16 K);
				// Infinity Pain's wall: 4 px / 1/16 px/tick with 1 M states a layer filled its table 33 tiles short three times
				// in a row, where 64 K and 16 K passed from the route's own states 150 and 400 ticks back)
				const ci2 = r.end === 'full' ? GREEDIER[job.conf] : job.conf;
				next = Object.assign({}, job, { inputs, startDist: r.near, slack: Math.min(job.r ? Infinity : SLACK_MAX, Math.round(SLACK + SLACK_F * r.near)), chain: c, conf: ci2, cells: CONFS[ci2],
					what: `${job.what.replace(/ · chain .*$/, '').replace(/settings \d+/, `settings ${ci2}`)} · chain ${c}${back ? ` (${back} back)` : ''}` });
				st.chained++;
			}
		}
	};
	return {
		room, edge, triggers: TR.n,
		start: () => { loopP = Promise.all(Array.from({ length: Math.max(1, a.burstPar) }, (_, k) => loop(k))).catch((e) => o.say({ ev: 'warning', text: `bursts: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}` })); return loopP; },
		/** ends the running burst between two launches and the loop; resolves once its process is gone */
		stop: async () => {
			stopped = true;
			for (let k = 0; k < Math.max(1, a.burstPar); k++) { try { fs.writeFileSync(path.join(work, `stop_${k}`), '1'); } catch (e) { /* none */ } }
			for (let k = 0; k < 150 && children.size; k++) await sleep(100);
			for (const ch of children) { try { ch.kill(); } catch (e) { /* gone */ } }
			if (loopP) await loopP;
		},
		stats: () => Object.assign({ rooms: rooms.size, triggers: TR.n, confs: confs.map((c) => `${c.n}:${c.n ? (c.y / c.n).toFixed(2) : '-'}`).join(' ') }, st),
	};
}

module.exports = { create, triggersOf, roomWalk, walkField, portalsOf, extendToChange, CONFS, CUT };
