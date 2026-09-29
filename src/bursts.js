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
// The route arm (goexplore.js --rArm, src/routearm.js): once a route is known (route(masks): the search's best), that
// share of the lane's turns goes to searches from the ROUTE's own states for ways that meet its later points sooner
// (eegpu explore --ahead=1 ordered by the route's own schedule; a fine local search and a 4 px one per start), each hit
// spliced into a verified route (the route's own inputs from the met visit, or every move to an exact state of the
// route) and handed on like a burst's finish; its hits go into every archive too. A 'burst' event with arm: true each.
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
const TMD = require('./timed.js');

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
// the wall ladder: a room's burst that ran out of situations (explore "exhausted") within FINE_NEAR tiles of a target
// without reaching it goes again from further back along its start's run (the wall breaker's BREAK_BACK 150 / 400), then
// also with finer cells (the breaker's grains, editor.js BREAK_GRAINS: 2 px and 1/16 px/tick, 1 px and 1/32); Forgotten
// Veil's coins=3 room: with the portal walk its portal arm's bursts started from the archive's cell 3 tiles from coin 4
// (at the portal (2, 164), after the climb from the portal (3, 196): the known route enters that one at 15 px/tick) and
// ran out of situations there at 4 px / 1/16, 2 px / 1/16 and 1 px / 1/32 alike: the speed the climb needs comes from
// before the portal
const FINE = [{ cqx: 0.5, cqv: 16, qy: 0.5, qvy: 16, cap: 1048576 }, { cqx: 1, cqv: 32, qy: 1, qvy: 32, cap: 1048576 }];
const FINE_TEXT = ['2 px and 1/16', '1 px and 1/32'];
const WALL = [{ back: 150, fine: 0 }, { back: 400, fine: 0 }, { back: 150, fine: 1 }, { back: 400, fine: 2 }];
const FINE_NEAR = 8;
// the fine-y cells (FINE_Y): 4 px across, 1 px up and down, 1/16 px/tick. A climb (chains, vines, ladders, slow dots) or
// a swim rises 1-2 px a tick, so in 4 px (or coarser) cells a tick's move stays in its cell and the explore drops the child
// (a cell seen before): Wine Quest I's chain (75, 77..81) out of its stalled 5-coin room: every explore from there ran out
// of situations at its foot (4 px: 99.5 M states in 5.8 s) or filled its table (2 px and 1 px: 2^29 cells), while these
// cells climbed it and reached (45, 71) in 9.5 s (then the 6th coin (36, 49) in 11.3 s more). Only on levels with
// climbables or liquids (`slowY`); the others keep their settings and bandit exactly
const FINE_Y = { cqx: 0.25, cqv: 16, qy: 1, qvy: 16, cap: 262144 };
// a target the room's burst chains ended short of REST_AFTER times (a chain = its links; the target it failed at = the
// untried one nearest the chain's last start by the room's walk) rests: the room's aim field leaves it out until every
// other untried target rests too (then all come back). The walk is blind to gravity and to up-drafts, so a trigger it
// reaches may be no target at all from here: Wine Quest I's 5-coin room aimed every burst at the coin (119, 65), 38 walk
// tiles away through a one-way lid the ball cannot pass from that side (exhaustive at 0.5 px), and never at the 6th
// coin (36, 49), 100 walk tiles away, that the ball can reach (the explore found it in 21 s with the target given)
const REST_AFTER = 3;
// target-fair rooms (--burstFair=1, the default; 0: the rooms' bandit as before): a room's score (its mean reward + the
// UCB term) is divided by 1 + its failed chains / (REST_AFTER x its untried targets), so the bursts go to the rooms with
// the most targets not yet failed, not evenly over the rooms: the bandit's arms were the rooms, and every stalled room
// got ~1/k of the bursts whatever its targets. Wine Quest I's run from the level alone (wq-watch 858e0fd, 37 min):
// 5 rooms whose 1-3 leftover targets were phantoms (behind a door or a lid by the walk, 86-312 walk tiles) took most of
// the bursts after the stall; the frontier room (13 untried targets + the trophy, the 6th coin among them) got 41. The
// order of the rooms only (an untried room first as before; nothing is ruled out); the trophy arm competes with the
// chosen room's own score as before
const fairScore = (raw, fails, targets) => (fails > 0 ? raw / (1 + fails / (REST_AFTER * Math.max(1, targets))) : raw);
const FINE_Y_TEXT = '4 px x 1 px and 1/16';
/** a level with tiles where the ball rises slowly (climbables, liquids): the fine-y cells are worth a try there */
function slowYOf(L) {
	const B = require('./blocks.js');
	const seen = new Map();
	for (let i = 0; i < L.fg.length; i++) {
		const id = L.fg[i];
		if (!id) continue;
		let v = seen.get(id);
		if (v === undefined) { const k = B.kindOf(id).kind; v = k === 'climbable' || k === 'liquid'; seen.set(id, v); }
		if (v) return true;
	}
	return false;
}
// the stall ladder (--stallLadder=1, OPT-IN: off by default since hx-int-1, no gain in its A/B): an arm (a room, or its portal arm) whose last STALL_N bursts got no nearer
// than they started (none reached a target or found a room), whatever the distance and whether their tables filled or
// ran out of situations, goes up the same ladder from its latest start, then further back (STALL_FAR: the speed a leg
// needs can come from long before the cell nearest its targets: Forgotten Helix's coin 4 needs a fall of 9.5+ px/tick into
// the shaft's portal (249, 123), built on the arrows 200+ ticks before; its 703 bursts from the shaft's cells, 41 tiles
// out, never tried from before them); each start once per arm (by its length), the counter back to 0 after a ladder
const STALL_N = 3;
const STALL_FAR = [{ back: 1000, fine: 1 }, { back: 2000, fine: 0 }];
const STALL_WALL = WALL.concat(STALL_FAR);
// the leg search (src/legsearch.js, --legs=1, OPT-IN: not measured yet): a stalled arm also gets one CPU search in a worker thread that
// keeps the FASTEST state of each fine cell (the GPU bursts keep the first), from the room's first arrival and from the
// stalled burst's start LEG_BACK ticks further back (each once per arm), inside the tiles the arm's walk reaches; one
// at a time, LEG_MS each; its find (a new room by a trigger) is replayed and goes into every archive like a burst's
const LEG_BACK = 400, LEG_MS = 900000, LEG_DEPTH = 900, LEG_CAP = 80000;
// (a chain link after a full table: the settings with the next smaller layer cap)
const GREEDIER = [2, 4, 4, 4, 4, 2];
// how far back along the start cell's run a burst starts, in turn per room (ticks; never 0: the cell nearest the targets
// is often a doomed state, falling toward them into spikes, and a burst from it ran out of states in 1-5 ticks)
const BACK = [30, 90, 30, 250];
const TROPHY_BACK = [60, 150, 400];
const UCB_C = 0.5, NEW_ROOMS_MAX = 3, SLACK = 30, SLACK_F = 0.1, NEAREST_WAIT_MS = 2000;
// dead starts: a burst that ran out of situations (explore "exhausted") with no room change, no new room and no nearer
// attempt marks its start's zone (DEAD_ZONE x DEAD_ZONE tiles) dead for its arm, and the arm's next bursts start from the
// archive's nearest cell outside its dead zones (the room's entry when none is left): on Forgotten Helix 116 of 125 bursts
// started from one cell, (81, 127), 41 tiles (through portals) from room coins=3's one target, each one out of situations
// within 0.4-3 s, reward 0, for 15 min. An arm whose last SAT_BURSTS bursts all got reward 0 is saturated: in walk mode the
// trophy arm (only when no room has a target, before) runs next to it
const DEAD_ZONE = 8, SAT_BURSTS = 12;
// the trophy arm with the steer field (goexplore.js --burstSteer, the editor's RCH4 file): the relay's ceiling at most
// (editor.js RELAY_SLACK_MAX), and a distance of 6000+ (the steer field has no value there: 6000 + the reach field's) as
// the reach field's
const SLACK_MAX = 200, STEER_MISS = 6000;
// a burst that found the GPU's memory full waits goexplore.js --burstOomS (5) s, doubled while that lasts, at most
// OOM_WAIT_MAX_S
const OOM_WAIT_MAX_S = 120;
// the big sizing's fallback (the editor's burstBig from 20 GB: goexplore.js --burstPar=2 --gpuCells=26 --burstCap=0, 3-5.7 GB
// of tables): a burst that found the GPU's memory full takes the small sizing (goexplore's defaults: lane 0 alone, 2^25
// cells, at most 262,144 states a layer) at once, for --burstSmallS (300) s, then the big sizing again; it waits
// (--burstOomS) only when the small one finds no memory either. The EPYC's 24 GB RTX 4090 is often nearly full, and two
// searches on one 40 GB A100 had 11 such waits against 0 (src/out/night/n2_2_time_to_route.md)
const SMALL = { cells: 25, cap: 262144 };
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

/** the stall ladder's count for arm `arm` after a burst of `job` with result `res` ({reached, fresh, near}): a burst that
 *  gained nothing (no target, no room, not a tile nearer than it started) counts, a gain starts the count over; at
 *  STALL_N the start (job.from0 or its inputs) goes up the ladder once per arm (by its length): true */
function stallStep(arm, job, res) {
	if (job.stallLadder) return false;
	const gain = !!res.reached || res.fresh > 0 || (Number.isFinite(res.near) && res.near < job.startDist - 1);
	arm.stall = gain ? 0 : (arm.stall || 0) + 1;
	if (arm.stall < STALL_N || !(job.chain < CHAIN_MAX)) return false;
	const from = job.from0 || job.inputs;
	const seen = arm.ladders || (arm.ladders = new Set());
	if (seen.has(from.length)) return false;
	seen.add(from.length);
	arm.stall = 0;
	return true;
}

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

/** level L's portals as walk edges (goexplore.js roomFields' map): exits (portal tile -> its exits' tiles) and srcOf
 *  (exit tile -> the portal tiles that lead there: the aim field's walk runs backwards from the goals) */
function portalsOf(L) {
	const W = L.width, N = W * L.height, fg = L.fg;
	const exits = new Map(), srcOf = new Map();
	if (!L.portalSlot || !L.portalsById) return { exits, srcOf };
	const silent = RF.silentPortals(L);   // (portals EE never teleports from: no exits)
	for (let i = 0; i < N; i++) {
		const s = L.portalSlot[i];
		if ((fg[i] !== 242 && fg[i] !== 381) || s < 0 || silent[i]) continue;
		const ex = L.portalsById.get(L.pTarget[s]);
		if (!ex) continue;
		const list = [];
		for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && !list.includes(j)) list.push(j); }
		if (!list.length) continue;
		exits.set(i, list);
		for (const j of list) { if (!srcOf.has(j)) srcOf.set(j, []); srcOf.get(j).push(i); }
	}
	return { exits, srcOf };
}

/**
 * create(o) -> {room(info), edge(from, tile), start(), stop() (a promise), stats()}. o: {L, a (goexplore's options),
 * field (the reach field), RM (roomOf(L)), ports (the workers' MessagePorts), say (an event line), bound() (the longest
 * route that still counts, ticks), minLen (goexplore.js --prefix: no burst starts before that tick), register(info) (a room the bursts found: into the main thread's registry, true when
 * new), broadcast(inputs) (an attempt into every worker's archive), finish(masks, how) (a route: replayed already),
 * nearest() ({inputs, rc} the attempt nearest the trophy by the reach field, or null), sec() (seconds since the start)}
 */
function create(o) {
	const L = o.L, a = o.a, W = L.width, H = L.height, N = W * H;
	const TR = triggersOf(L), PT = portalsOf(L);
	// (the settings: CONFS, and FINE_Y last on a level with slow climbs: a.fineY 0 leaves it out, 1 forces it)
	const slowY = a.fineY === undefined || a.fineY === null ? slowYOf(L) : !!+a.fineY;
	const CF = slowY ? CONFS.concat([FINE_Y]) : CONFS, GR = slowY ? GREEDIER.concat([CONFS.length]) : GREEDIER, FY = slowY ? CONFS.length : -1;
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
	// (small: the bursts' longest launch by the host / GPU clock, eegpu's done lines, for the 50 ms rule on big tables)
	const st = { bursts: 0, domBursts: 0, sec: 0, reached: 0, newRooms: 0, imports: 0, finishes: 0, trophy: 0, failed: 0, oom: 0, skipped: 0, chained: 0, fine: 0, deadStarts: 0, small: 0, maxLaunchMs: 0, maxKernelMs: 0,
		servers: 0, served: 0 };
	// (the big sizing's fallback to SMALL until smallUntil (ms) after an out-of-memory failure; big: the sizing asked is over SMALL)
	const big = a.burstPar > 1 || a.gpuCells > SMALL.cells || !(a.burstCap > 0 && a.burstCap <= SMALL.cap);
	let smallUntil = 0;
	const small = () => big && Date.now() < smallUntil;
	const trophyArm = { n: 0, y: 0, back: 0 };
	const confs = CF.map(() => ({ n: 0, y: 0 }));
	// the route arm (src/routearm.js; goexplore.js --rArm, a share of the bursts once a route is known): searches from the
	// route's own states for ways that meet its later points sooner, spliced into verified routes
	// (before any route, --rArmPre of the bursts: the arm on the nearest attempt (goexplore.js: attempt(inputs)), its
	// shortened attempts into every archive and to the editor ("shortcut" events: its route splice))
	const RA = a.rArm > 0 ? require('./routearm.js').create({ L, field: o.field, tool, bin, fp, work, cacheArgs, a, bound: o.bound, say: o.say,
		finish: (masks, how) => { st.armRoutes++; o.finish(masks, how); }, broadcast: (inputs) => { st.imports++; o.broadcast(inputs); },
		shortcut: (masks, saved, how) => {
			st.armShortcuts = (st.armShortcuts || 0) + 1;
			const inputs = C.eetasBytes(masks).toString('latin1');
			o.broadcast(inputs);
			o.say({ ev: 'shortcut', kind: 'arm', inputs, ticks: masks.length, saved, how });
		} }) : null;
	let armAcc = 0, armOom = 0;
	let legBusy = false;
	st.legs = 0; st.legFound = 0; st.legSec = 0;
	/** the leg search for arm r from `from` (inputs), in a worker thread; its find replayed into every archive */
	const legRun = (r, from, why, walk) => {
		if (legBusy || stopped || a.legs === 0 || !from || !(a.file || a.level)) return false;
		const seenStarts = r.legStarts || (r.legStarts = new Set());
		if (seenStarts.has(from.length)) return false;
		seenStarts.add(from.length);
		legBusy = true;
		let region = null;
		if (walk) {
			// (the tiles the arm's walk reaches, and those next to them: the ball's centre stays on the walk's tiles)
			region = new Uint8Array(N);
			for (let i = 0; i < N; i++) {
				if (walk[i] === CUT) continue;
				const x = i % W, y = (i / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) region[yy * W + xx] = 1; }
			}
		}
		const t0 = Date.now();
		let w;
		try {
			const { Worker } = require('worker_threads');
			w = new Worker(path.join(__dirname, 'legsearch.js'), { workerData: { legsearch: true, file: a.file || null, level: a.level || null, prefix: from,
				o: { depth: LEG_DEPTH, cap: LEG_CAP, ms: LEG_MS, region }, known: [...rooms.keys()] } });
		} catch (e) { legBusy = false; o.say({ ev: 'warning', text: `leg search: ${e.message}` }); return false; }
		const done = (res) => {
			if (!legBusy) return;
			legBusy = false;
			st.legs++; st.legSec += (Date.now() - t0) / 1000;
			let fresh = 0;
			if (res && res.found && !stopped) {
				const rp = replay(res.found, r.key);
				if (rp) { fresh = rp.fresh; o.broadcast(res.found); st.imports++; st.legFound++; r.stall = 0; }
			}
			o.say({ ev: 'burst', leg: true, n: st.bursts, room: r.desc, what: `the leg search (${why}) from tick ${from.length}${r.portal ? ' through portals' : ''}`, from: from.length,
				sec: Math.round((Date.now() - t0) / 100) / 10, end: res ? res.why : 'error', reached: !!(res && res.found), newRooms: fresh, legTicks: res && res.legTicks, desc: res && res.desc,
				layers: res && res.layers, sims: res && res.sims, at: o.sec() });
		};
		w.on('message', done);
		w.on('error', (e) => { o.say({ ev: 'warning', text: `leg search: ${e.message}` }); done(null); });
		w.on('exit', () => done(null));
		legWorkers.add(w);
		w.on('exit', () => legWorkers.delete(w));
		return true;
	};
	const legWorkers = new Set();
	const ARM_OOM_MAX_S = 30, ARM_PRE_CAP = 0.15;
	st.arm = 0; st.armSec = 0; st.armRoutes = 0;
	/** the next burst's settings for room r (null: the trophy arm): a bandit per room (a low-gravity room and a fly room
	 *  want different cells): each once, then its mean reward in the room (the level's mean as a prior worth 2 tries) +
	 *  CONF_C x sqrt(ln(1 + the room's bursts) / tries) */
	const pickConf = (r) => {
		const own = r ? (r.confs || (r.confs = CF.map(() => ({ n: 0, y: 0 })))) : confs;
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
		if (r.info && !r.info.seen[tile]) { r.info = null; r.fc = null; r.done = false; r.pa.fc = null; r.pa.done = false; }
	};
	/** a room (from a worker, a burst or the start): {room (key), desc, tile, t, inputs} */
	const room = (m) => {
		let r = rooms.get(m.room);
		if (!r) {
			r = { key: m.room, desc: m.desc, seq: ++seq, tile: m.tile, t: m.t, inputs: m.inputs, n: 0, y: 0, sec: 0, tried: new Set(), info: null, best: Infinity, k: 0, entries: new Set(), dead: new Set(), zero: 0, stall: 0, ladders: null, legStarts: null,
				trig: m.t > 0 && m.trig !== false, fl: 0, nt: 1, ntI: null, ntK: -1, grp: m.grp || null };
			// (its portal arm: the room's targets its walk reaches only through a portal, an arm of their own (fieldOf0);
			// the room's own fields (key, tried, info, entries, inputs) through the prototype, its bandit numbers its own)
			r.pa = Object.assign(Object.create(r), { base: r, portal: true, n: 0, y: 0, sec: 0, best: Infinity, k: 0, busy: false, done: false, fc: null, confs: null, dead: new Set(), zero: 0, stall: 0, ladders: null, legStarts: null, fl: 0, nt: 1, ntI: null, ntK: -1 });
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
		const sim = simAt(r.inputs);
		const fg = L.fg, fl = RF.guideFlags(L);
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
		for (const e of [s0, ...r.entries]) if (!seen[e]) { seen[e] = 1; q[qt++] = e; pass[e] = 1; }
		const nSrc = qt;
		// what touching a trigger component does in this room (the engine's own answer: the room's first arrival with its
		// centre put on the tile, one tick without input): a change by a trigger (goexplore.js roomOf byTrigger) makes it a
		// target and the end of the walk there (beyond it the ball is in another room, so a trigger only behind it is no
		// target of this room); no change (an effect this room has already, e.g. a gravity effect of the room's own
		// direction) makes it neither (it never changes the room, so no run or burst could ever try it). Infinity Pain's
		// room "fly grav=2 team=1": 112 targets before, 76 of them only behind another trigger and 35 no-ops, the nearest
		// of them nearer than the wall's (199, 151) from the archive's cells by the tunnel (7 ticks short of it for 70 min);
		// with this rule 2: (189, 159) and the wall's
		const cz0 = o.RM.cause(sim), snap0 = sim.snapshot(), inp0 = new E.EEInput(), acts = new Map();
		// (a room entered with a timed killer running (src/timed.js: a curse, zombie, fire or poison with a time): a trigger
		// that only clears it (the room it makes is this room without the killer: the curse-off tiles) is a WAY, not a goal:
		// the walk goes on through it and the targets beyond it count, so a burst aims past the remover and every nearer
		// attempt on the way is one that cleared the killer and still goes on. As a goal, the first attempt that touched it
		// ended the burst and marked it tried: on Forgotten Helix's curse leg the first touch falls through the remover
		// (262-264, 165) into the arrows below, where the route dips into it by a pixel and climbs back up)
		const K0 = [sim.is_cursed, sim.is_zombie, sim.is_on_fire, sim.is_poisoned];
		let czClear = null;
		if (TMD.timedLeft(sim) > 0) {
			sim.is_cursed = false; sim.is_zombie = false; sim.is_on_fire = false; sim.is_poisoned = false;
			czClear = o.RM.cause(sim);
			sim.restore(snap0);
		}
		// (--dom=1: a touch that only turns mono switches off (goexplore.js roomOf shrinks: into a room the room itself
		// dominates) is no target: Good Egg's switch staircase, pressed again on the way back)
		const d0 = a.dom !== 0 && o.RM.dom ? o.RM.dom(sim) : null;
		/** touching trigger component c at tile t from the room's first arrival: 0 nothing changes, 1 a change (a target),
		 *  2 it only clears the timed killer the room carries (a way) */
		const changes = (c, t) => {
			let v = acts.get(c);
			if (v === undefined) {
				sim.restore(snap0);
				sim.px = (t % W) * 16; sim.py = ((t / W) | 0) * 16; sim.speed_x = 0; sim.speed_y = 0;
				// (a death or an error says nothing: a target, as before the test)
				try {
					sim.tick(inp0);
					const cz = o.RM.cause(sim);
					v = sim.is_dead || (o.RM.byTrigger(cz0, cz) && !(d0 !== null && o.RM.shrinks(d0, o.RM.dom(sim)))) ? 1 : 0;
					if (v === 1 && czClear !== null && !sim.is_dead && cz.sub === czClear.sub && cz.keys === czClear.keys &&
						(K0[0] && !sim.is_cursed || K0[1] && !sim.is_zombie || K0[2] && !sim.is_on_fire || K0[3] && !sim.is_poisoned)) v = 2;
				} catch (e) { v = 1; }
				sim.restore(snap0);
				acts.set(c, v);
			}
			return v;
		};
		const comps = new Map(), trophies = [], ways = new Map();
		// (through portals: Forgotten Veil's coin 4 and Good Egg's portal pockets are behind one; 8-connected only, they
		// were no target and a room entered in such a pocket had none. The walk goes 8-connected first and through the
		// portals it met after that, so `via` marks the tiles reached only through a portal: the portal arm's (fieldOf0))
		const via = new Uint8Array(N), portals = [];
		let phase2 = false;
		for (;;) {
			if (qh >= qt) {
				if (phase2 || !portals.length) break;
				phase2 = true;
				for (const t of portals) for (const e of PT.exits.get(t)) if (!seen[e] && pass[e]) { seen[e] = 1; q[qt++] = e; }
				continue;
			}
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			if (phase2) via[t] = 1;
			const c = TR.comp[t];
			// (a coin already collected at the room's first arrival is no trigger of it)
			const act = c >= 0 && !(TR.eaten[c] && sim.is_coin_collected(x, y)) ? changes(c, t) : 0, live = act === 1;
			if (live) { let l = comps.get(c); if (!l) comps.set(c, l = []); l.push(t); }
			else if (act === 2) { let l = ways.get(c); if (!l) ways.set(c, l = []); l.push(t); }
			if (fg[t] === 121) trophies.push(t);
			// (a trigger that changes the room: a goal, no way through; the places the room was entered at are ways out)
			if (live && qh > nSrc) { term[t] = 1; continue; }
			const ex = PT.exits.get(t);
			if (ex) { if (phase2) { for (const e of ex) if (!seen[e] && pass[e]) { seen[e] = 1; q[qt++] = e; } } else portals.push(t); }
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
		}
		// (the trigger the room was first entered by is not a target: it made this room; not when the clock made it)
		const c0 = r.trig ? compNear(s0) : -1;
		const R = r.base || r;
		if (c0 >= 0 && !R.info0) { R.tried.add(c0); R.info0 = true; }
		// (the killer's removers are the targets only when nothing beyond them is one: the room must still aim somewhere)
		let other = false;
		for (const c of comps.keys()) if (c !== c0) { other = true; break; }
		if (!other) for (const [c, tiles] of ways) comps.set(c, tiles);
		// (a component the walk reached only through a portal: the portal arm's target)
		const pOnly = new Set();
		for (const [c, tiles] of comps) if (tiles.every((t) => via[t])) pOnly.add(c);
		R.info = { pass, wall, comps, trophies, seen, term, via, pOnly, ways };
		return R.info;
	};
	/** the steer field of room r: walking distance (fifths, 5 per step) to its untried targets; null: none left */
	const fieldOf = (r) => {
		// (cached while no trigger of the room was tried since)
		const nk = r.tried.size * 4096 + (r.rest ? r.rest.size : 0);
		if (r.fc && r.fc.n === nk) return r.fc.f;
		const f = fieldOf0(r);
		r.fc = { n: nk, f };
		return f;
	};
	/** walking distance (fifths, 5 per step) to `goals` in the room's passable set (walk: Uint16Array, CUT = none), its
	 *  largest value mx: backwards from the goals, through portals, never through another room-changing trigger */
	const walkTo = (I, goals) => {
		const walk = new Uint16Array(N).fill(CUT), q = new Int32Array(N);
		let qh = 0, qt = 0, mx = 0;
		for (const g of goals) if (walk[g] === CUT) { walk[g] = 0; q[qt++] = g; }
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0, d = Math.min(0xfffd, walk[t] + 5);
			// (backwards through portals: the portal tiles that lead here, 5 per portal as src/reach.js)
			const src = PT.srcOf.get(t);
			if (src) for (const p of src) if (walk[p] === CUT && I.pass[p] && !I.term[p]) { walk[p] = d; if (d > mx) mx = d; q[qt++] = p; }
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
		}
		return { walk, mx };
	};
	/** a room with a timed killer's removers (ways): the walk to them (a burst start's time slack: goexplore.js nearestOf);
	 *  null without */
	const wayField = (r) => {
		const I = infoOf(r);
		if (!I.ways || !I.ways.size) return null;
		if (!I.wayF) { const g = []; for (const tiles of I.ways.values()) for (const t of tiles) g.push(t); I.wayF = walkTo(I, g).walk; }
		return I.wayF;
	};
	const fieldOf0 = (r) => {
		const I = infoOf(r);
		const goals = [];
		// (a room's two arms: the targets its walk reaches without a portal (the room itself) and those only through one
		// (its portal arm r.pa); together, Forgotten Veil's coin 4 ranked 14th of the coins=3 room's 17 targets from the
		// route's entry: every nearer one first, a burst each)
		const arm = !!r.portal;
		const rest = r.rest && r.rest.size ? r.rest : null;
		// (every untried target resting: they all come back)
		if (rest) { let live = 0; for (const [c] of I.comps) if (!r.tried.has(c) && I.pOnly.has(c) === arm && !rest.has(c)) live++; if (!live) { rest.clear(); r.fails = new Map(); } }
		for (const [c, tiles] of I.comps) if (!r.tried.has(c) && I.pOnly.has(c) === arm && !(r.rest && r.rest.has(c))) for (const t of tiles) goals.push(t);
		const n = goals.length;
		if (o.field.mode === 'walk') for (const t of I.trophies) if (!!I.via[t] === arm) goals.push(t);
		if (!goals.length) return null;
		const { walk, mx } = walkTo(I, goals);
		return { walk, mx, triggers: n, trophies: o.field.mode === 'walk' ? I.trophies.length : 0 };
	};
	/** every worker's cell of room r nearest the field's goals, outside the arm's dead zones (the nearest of all; null when
	 *  none has one) */
	const nearestCell = (r, walk) => new Promise((res) => {
		const id = ++reqId;
		const q = { replies: [], want: o.ports.length, done: null };
		let timer = null;
		q.done = () => {
			if (timer) clearTimeout(timer);
			pending.delete(id);
			// (the most time slack first: 0 for a cell with enough time or no timed killer, see goexplore.js nearestOf)
			let b = null;
			for (const m of q.replies) {
				if (!(m.v >= 0)) continue;
				const sl = m.sl || 0, bl = b ? b.sl || 0 : 0;
				if (!b || sl > bl || (sl === bl && (m.v < b.v || (m.v === b.v && m.t < b.t)))) b = m;
			}
			res(b);
		};
		pending.set(id, q);
		timer = setTimeout(q.done, NEAREST_WAIT_MS);
		const way = wayField(r.base || r);
		const avoid = r.dead && r.dead.size ? [...r.dead] : null;
		for (const p of o.ports) p.postMessage({ type: 'nearest', id, room: r.key, field: walk, way, ...(avoid ? { avoid, zone: DEAD_ZONE } : {}) });
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
			// (deaths as moves: an attempt goes on through a death the GPU kept, --deaths=1; its dead ticks change no room)
			if (sim.is_dead) { if (a.deathMoves && k + 1 < inputs.length) continue; return null; }
			const k2 = o.RM.key(sim);
			if (k2 !== key && !quiet) {
				const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
				const cz2 = o.RM.cause(sim), trig = o.RM.byTrigger(cz, cz2);
				edge(key, tile, k2, trig);
				const d2 = o.RM.dom ? o.RM.dom(sim) : null;
				if (o.register({ room: k2, desc: o.RM.desc(sim), tile, t: k + 1, inputs: inputs.slice(0, k + 1), parent: key, trig, sub: cz2.sub, keys: cz2.keys,
					...(d2 ? { dcls: d2.cls, dmask: Array.from(d2.mask) } : {}) })) fresh++;
				cz = cz2;
			}
			key = k2;
		}
		const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		return { key, tile, fresh, parentKey };
	};
	/** (EEAT_BURSTLIVE=1, OPT-IN, deaths as moves only; off = the cut as before) a start cut back along its run (BACK /
	 *  TROPHY_BACK / CHAIN_BACK) that lands in a death's dead ticks: the tool refuses it ("the prefix dies": 35-45% of the
	 *  one search's bursts on Cold World, whose cells are respawn lineages); the start goes on along the SAME run to its
	 *  first live tick (the respawn), so it is that run's own state (exact: the run's inputs, nothing guessed); a run that
	 *  never lives again keeps the cut (the tool's failure as before) */
	const burstLive = process.env.EEAT_BURSTLIVE === '1';
	if (burstLive) st.liveCuts = 0;
	const liveCut = (full, cut) => {
		if (!burstLive || !a.deathMoves || !full || cut.length >= full.length) return cut;
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let k = 0; k < cut.length; k++) { E.applyMask(inp, (cut.charCodeAt(k) - 48) & 31); sim.tick(inp); }
		if (!sim.is_dead) return cut;
		for (let k = cut.length; k < full.length; k++) {
			E.applyMask(inp, (full.charCodeAt(k) - 48) & 31);
			sim.tick(inp);
			if (!sim.is_dead) { st.liveCuts++; return full.slice(0, k + 1); }
		}
		return cut;
	};
	/** an attempt that reached a target tile: the room changes when the trigger acts (a tick or two later for some): up to
	 *  3 more ticks of its last input, else each of the 18 inputs for one tick; the attempt with them when the room
	 *  changed alive, else null */
	const OPTS = [];
	for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTS.push(h | v | j);
	const extend = (inputs) => {
		const sim = new E.EESim(L), inp = new E.EEInput();
		sim.reset();
		for (let k = 0; k < inputs.length; k++) { E.applyMask(inp, (inputs.charCodeAt(k) - 48) & 31); sim.tick(inp); }
		const key = o.RM.key(sim), snap = sim.snapshot();
		const last = inputs.length ? (inputs.charCodeAt(inputs.length - 1) - 48) & 31 : 0;
		const tryMasks = (ms) => {
			sim.restore(snap);
			for (let k = 0; k < ms.length; k++) {
				E.applyMask(inp, ms[k]);
				sim.tick(inp);
				if (sim.is_dead) return null;
				if (o.RM.key(sim) !== key) return inputs + String.fromCharCode(...ms.slice(0, k + 1).map((m) => 48 + m));
			}
			return null;
		};
		let r = tryMasks([last, last, last]);
		for (let i = 0; !r && i < OPTS.length; i++) r = tryMasks([OPTS[i]]);
		return r;
	};
	// (--burstFair, off with --burstFair=0)
	const fair = a.burstFair === undefined || a.burstFair === null ? true : !!+a.burstFair;
	/** room r's untried targets (its arm's trigger components + the trophy where the walk aims at it), rested ones too:
	 *  from its info while it has one, else the last count */
	const targetsOf = (r) => {
		const R = r.base || r, I = R.info;
		if (!I) return r.nt;
		// (cached while the room's info and its tried set stay: a pick scores every room burst from)
		if (r.ntI === I && r.ntK === R.tried.size) return r.nt;
		r.ntI = I; r.ntK = R.tried.size;
		const arm = !!r.portal;
		let n = 0;
		for (const [c] of I.comps) if (!R.tried.has(c) && I.pOnly.has(c) === arm) n++;
		if (o.field.mode === 'walk' && I.trophies.some((t) => !!I.via[t] === arm)) n++;
		r.nt = Math.max(1, n);
		return r.nt;
	};
	// (--domBurst=K, dominance-share: every K-th pick goes to the rooms of dominated novelty groups first; 0: never)
	const domBurst = a.domBurst === undefined || a.domBurst === null ? 8 : Math.max(0, Math.round(+a.domBurst) || 0);
	let domTick = 0;
	/** the next burst: {r (room, or null: the trophy arm), f (its field)} */
	const pick = () => {
		let best = null, bs = -Infinity;
		const total = st.bursts;
		// (the rooms by score; a room's field (a replay and two walks) only for the best ones until one has a target: a
		// level of many switches has thousands of rooms)
		const cand = [], dcand = [];
		// (a dominated room's turn: --domBurst)
		const domTurn = domBurst > 0 && ++domTick % domBurst === 0;
		for (const r0 of rooms.values()) {
			// (--dom=1: a room whose novelty group is dominated (goexplore.js domIndex: a room of its class with more mono
			// switches on holds everything it can reach) is no burst's room: Good Egg's hour from the level alone gave 277
			// of its 361 bursts to switch-subset rooms at coins = 8, src/out/ge_anat; but "dominated" is the walk's view (an
			// open door is no floor: a floor-door switch turned off again, a backtracking room), so such rooms keep every
			// --domBurst-th turn: dominance only orders)
			const dm = !!(r0.grp && r0.grp.dom);
			if (dm && !domTurn) continue;
			for (const r of [r0, r0.pa]) {
				if (r.done || r.busy) continue;
				const raw = r.n === 0 ? UNTRIED + r.seq * 1e-6 : r.y / r.n + UCB_C * Math.sqrt(Math.log(1 + total) / r.n);
				// (--burstFair: the order by the score per untried target not yet failed)
				(dm ? dcand : cand).push([fair && r.n > 0 ? fairScore(raw, r.fl, targetsOf(r)) : raw, r, raw]);
			}
		}
		cand.sort((x, y) => y[0] - x[0]);
		dcand.sort((x, y) => y[0] - x[0]);
		let domChosen = false;
		for (const [, r, raw] of dcand.length ? dcand.concat(cand) : cand) {
			let f;
			try { f = fieldOf(r); } catch (e) { r.done = true; continue; }
			if (!f) { r.done = true; continue; }
			bs = raw; best = { r, f };
			// (r.pa inherits its room's grp)
			if (r.grp && r.grp.dom) { domChosen = true; st.domBursts++; }
			break;
		}
		// the trophy arm (the relay: the reach field's nearest attempt), an arm like the rooms (untried: after the untried
		// rooms); with a walk-mode field (effects: its trophy distance ignores doors and physics, and Infinity Pain's nearest
		// attempt by it sat in a pocket 7.8 tiles out for the whole hour) only when no room has a target left: the rooms'
		// own walks aim at the trophy there
		const nr = domChosen || trophyArm.busy || (o.field.mode === 'walk' && best && !(best.r && best.r.zero >= SAT_BURSTS)) ? null : o.nearest();
		if (nr && nr.inputs.length >= 100) {
			const s = trophyArm.n === 0 ? UNTRIED - 0.5 : trophyArm.y / trophyArm.n + UCB_C * Math.sqrt(Math.log(1 + total) / trophyArm.n);
			if (s > bs) { bs = s; best = { trophy: true, nr }; }
		}
		return best;
	};
	const sleep = (ms) => new Promise((res) => { const t = setTimeout(res, ms); if (t.unref) t.unref(); });
	// the burst servers (eegpu explore --serve, one per lane): a burst is a job line to its lane's server, which keeps its
	// CUDA context and kernels between bursts (a process per burst spent 1.9-4.3 s from its spawn to its ready line, 15-26%
	// of the bursts' wall time; box 1's A100s under load: 6.5 s for the context alone). The job's output lines are a
	// process's, ending with {"ev":"idle","code"}; its stop file, the pause file and the launches are the process's. An
	// eegpu without --serve (an older build: it reads --serve=1 as its run file and exits 2 before loading the driver),
	// a .js stand-in (tests) or --burstServe=0: a process per burst, as before. A server that ends (a launch error: its
	// context is gone) ends its job like a process's exit; the next burst starts a new one.
	const servers = new Map();   // lane -> {ch, served, dead, job, ready}
	let serveOff = /\.js$/i.test(tool) || String(a.burstServe) === '0' || process.env.EEAT_BURST_SERVE === '0';
	/** a server keeps this Node alive while it starts or runs a job (as a burst's process does), not while it is idle
	 *  (its --parent ends it once Node has gone) */
	const hold = (s, on) => { try { for (const p of [s.ch, s.ch.stdin, s.ch.stdout, s.ch.stderr]) if (p) { if (on) p.ref(); else p.unref(); } } catch (e) { /* gone */ } };
	const serverOf = (lane) => {
		const s0 = servers.get(lane);
		if (s0 && !s0.dead) return s0.ready;
		const s = { ch: null, served: false, dead: false, job: null, buf: '', err: '' };
		servers.set(lane, s);
		s.ready = new Promise((resolve) => {
			const sargs = ['explore', bin, '--serve=1', `--parent=${process.pid}`, ...(a.pausefile ? [`--pausefile=${a.pausefile}`] : []), ...cacheArgs];
			let ch;
			try { ch = spawn(tool, sargs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true }); } catch (e) { s.dead = true; resolve(null); return; }
			s.ch = ch;
			children.add(ch);
			st.servers++;
			ch.stdin.on('error', () => { /* the server has gone: its close ends the job */ });
			ch.stdout.on('data', (d) => {
				s.buf += d;
				let k;
				while ((k = s.buf.indexOf('\n')) >= 0) {
					const line = s.buf.slice(0, k);
					s.buf = s.buf.slice(k + 1);
					if (!s.served) {
						if (line.startsWith('{"ev":"serving"')) { s.served = true; resolve(s); } else if (line.startsWith('{"error"')) s.err = line;
						continue;
					}
					if (!s.job) continue;
					if (line.startsWith('{"ev":"idle"')) {
						let e = {};
						try { e = JSON.parse(line); } catch (x) { /* a cut line */ }
						const j = s.job;
						s.job = null;
						if (!stopped) hold(s, false);
						j.resolve({ ok: true, code: e.code | 0 });
						continue;
					}
					s.job.onLine(line);
				}
			});
			ch.stderr.on('data', (d) => { s.err = (s.err + d).slice(-400); if (s.job) s.job.onErr(String(d)); });
			ch.on('error', (e) => { s.err = e.message; });
			ch.on('close', (code) => {
				children.delete(ch);
				s.dead = true;
				if (!s.served) {
					resolve(null);
					// (an older eegpu: its run file "--serve=1" cannot be opened; any other failure to start (the GPU's memory
					// full, ...) only this burst runs as a process, which meets it the way it always did)
					if (code === 2 || /cannot open --serve/.test(s.err)) {
						if (!serveOff) o.say({ ev: 'warning', text: 'burst: this eegpu has no --serve (an older build): a process per burst' });
						serveOff = true;
					}
				}
				if (s.job) { const j = s.job; s.job = null; j.resolve({ ok: true, code }); }
			});
		});
		return s.ready;
	};
	/** one burst's explore through its lane's server: {ok: false} when there is none (the caller starts a process),
	 *  else {ok, code} once the job has ended (its lines went to onLine) */
	const serveJob = async (lane, jobArgs, onLine, onErr) => {
		const s = await serverOf(lane);
		if (!s || s.dead || stopped) return { ok: false };
		return new Promise((resolve) => {
			s.job = { onLine, onErr, resolve };
			hold(s, true);
			try { s.ch.stdin.write(`${jobArgs.join('\t')}\n`); st.served++; } catch (e) { s.job = null; resolve({ ok: false }); }
		});
	};
	/** one burst: from `inputs` (a prefix), the steer file `reach`, the cells; resolves {end, sec, reached, fresh, nearest} */
	const burst = (job) => new Promise((res) => {
		const pre = path.join(work, `prefix_${job.lane}.eetas`), stop = path.join(work, `stop_${job.lane}`);
		try { fs.unlinkSync(stop); } catch (e) { /* none */ }
		fs.writeFileSync(pre, Buffer.from(job.inputs, 'latin1'));
		const T = o.bound();
		const depth = T < a.depth ? Math.max(1, T - 1 - job.inputs.length) : 100000;
		const c = job.cells, sm = small();
		const cells = sm ? Math.min(a.gpuCells, SMALL.cells) : a.gpuCells, cap = Math.min(c.cap, a.burstCap > 0 ? a.burstCap : Infinity, sm ? SMALL.cap : Infinity);
		const args = ['explore', bin, '-', `--prefix=${pre}`, '--finish=1', '--discrete=1', `--depth=${depth}`, `--seconds=${job.seconds}`, '--coarse=0', ...(a.deathMoves ? ['--deaths=1'] : []),
			`--cqx=${c.cqx}`, `--cqv=${c.cqv}`, `--qy=${c.qy}`, `--qvy=${c.qvy}`, `--reach=${job.reach}`, `--cells=${cells}`, `--cap=${cap}`,
			...(job.slack > 0 ? [`--costslack=${job.slack}`] : []), ...(job.steer ? [`--steer=${job.steer}`] : []), `--stopfile=${stop}`, ...(a.pausefile ? [`--pausefile=${a.pausefile}`] : []), `--parent=${process.pid}`, ...cacheArgs];
		const t0 = Date.now();
		let buf = '', done = null, reached = false, changed = false, fresh = 0, near = Infinity, readyAt = 0, err = '', ended = false, best = null;
		const halt = () => { if (!ended) { ended = true; try { fs.writeFileSync(stop, '1'); } catch (e) { /* gone */ } } };
		job.halt = halt;
		const onLine = (line) => {
			if (!line.startsWith('{')) return;
			let e;
			try { e = JSON.parse(line); } catch (x) { return; }
			if (e.ev === 'ready') { readyAt = Date.now(); return; }
			if (e.ev === 'done') {
				done = e;
				if (e.maxLaunchMs > st.maxLaunchMs) st.maxLaunchMs = e.maxLaunchMs;
				if (e.maxKernelMs > st.maxKernelMs) st.maxKernelMs = e.maxKernelMs;
				return;
			}
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
		// the burst's end (its process's exit code, or its job's in a server)
		const end = (code) => {
			const sec = (Date.now() - (readyAt || t0)) / 1000;
			res({ end: done ? done.end : `exit ${code}${err ? `: ${err.trim().split('\n').pop()}` : ''}`, sec, wall: (Date.now() - t0) / 1000, reached, changed, fresh, near, best, fail: !done && !ended && !stopped,
				states: done ? done.states : 0, layers: done ? done.layers : 0 });
		};
		const perProcess = () => {
			let ch;
			// (a .js tool: a stand-in for eegpu run by this Node, test/editor.js)
			const cmd = /\.js$/i.test(tool) ? [process.execPath, tool, ...args] : [tool, ...args];
			try { ch = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true }); } catch (e) { res({ end: `spawn: ${e.message}`, sec: 0, fail: true }); return; }
			children.add(ch);
			ch.stdout.on('data', (d) => {
				buf += d;
				let k;
				while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
			});
			ch.stderr.on('data', (d) => { err = (err + d).slice(-400); });
			ch.on('error', (e) => { err = e.message; });
			ch.on('close', (code) => { children.delete(ch); end(code); });
		};
		if (serveOff) { perProcess(); return; }
		// (the server's own arguments: the level, --serve, --parent, --pausefile and the cache folder; the job's: the rest)
		serveJob(job.lane, args.slice(3).filter((x) => !/^--(parent|pausefile|cachedir)=/.test(x)), onLine, (d) => { err = (err + d).slice(-400); })
			.then((r) => { if (r.ok) end(r.code); else perProcess(); }, () => perProcess());
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
			// (the small sizing after an out-of-memory failure: lane 0 alone; a chain's next link waits for the big sizing)
			if (lane > 0 && small()) { await sleep(1000); continue; }
			let job = null;
			// the route arm's turn (its share of the bursts, a route known): one start's searches in this lane
			// (before any route the arm's GPU seconds stay under ARM_PRE_CAP of the search's time: its local explores run up to
			// 4 x 12 s a start where a burst runs 15 s, and before the first route the bursts find the rooms it needs (Stupid
			// Fox: no route in 3 of 3 runs with the arm on the attempts, one at 197.6 s without it))
			const armPreOk = !RA || !RA.onAttempt() || st.armSec <= ARM_PRE_CAP * o.sec();
			if (!next && RA && RA.ready() && armPreOk && (armAcc += RA.onAttempt() ? (a.rArmPre >= 0 ? +a.rArmPre : 0) : a.rArm) >= 1) {
				armAcc -= 1;
				const t0 = Date.now();
				const r = await RA.run(lane, { child: (ch, on) => { if (on) children.add(ch); else children.delete(ch); }, stopped: () => stopped });
				if (stopped) break;
				// (no start (an attempt whose landings were all searched): this turn is a burst's)
				if (!r && RA.onAttempt()) { /* a burst below */ } else if (!r) { await sleep(500); continue; } else {
					st.arm++; st.armSec += (Date.now() - t0) / 1000;
					o.say({ ev: 'burst', n: st.bursts + st.arm, arm: true, room: null, what: `the route arm from tick ${r.s} (potential ${r.pot})`, from: r.s, sec: Math.round(r.sec * 10) / 10, end: r.ends.join(' / '),
						hits: r.hits, saved: r.saved, how: r.how, at: o.sec() });
					// (the GPU's memory full: the start goes again after a short wait, longer while it lasts, at most ARM_OOM_MAX_S; the
					// room bursts' back-off is their own)
					if (r.oom) { const w = Math.min(ARM_OOM_MAX_S, (a.burstOomS > 0 ? a.burstOomS : 5) * (1 + armOom)); armOom++; for (let k = 0; k < 10 * w && !stopped; k++) await sleep(100); } else armOom = 0;
					continue;
				}
			}
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
				if (inputs.length > back + 50) inputs = liveCut(inputs, inputs.slice(0, Math.max(o.minLen || 0, inputs.length - back)));
				if (!(v >= 0 && v < CUT)) v = p.f.mx;
				const ci = pickConf(r);
				job = { lane, r, inputs, tile: cell && cell.tile >= 0 ? cell.tile : r.tile, conf: ci, cells: CF[ci], reach: steerFile(p.f.walk, p.f.mx, lane), slack: Math.round(SLACK + SLACK_F * v / 5), seconds: Math.max(2, Math.min(a.burstS, Math.floor(left - 1))),
					startDist: v / 5, chain: 0, what: `room "${r.desc}" (${p.f.triggers} trigger tile${p.f.triggers === 1 ? '' : 's'}${p.f.trophies ? ' + the trophy' : ''} left${r.portal ? ' through portals' : ''}), settings ${ci}, ${back} back` };
			} else if (p) {
				// the trophy arm: the relay (the reach field's nearest attempt, 60 / 150 / 400 ticks back)
				const nr = p.nr;
				const back = TROPHY_BACK[trophyArm.back++ % TROPHY_BACK.length];
				const inputs = liveCut(nr.inputs, nr.inputs.slice(0, Math.max(50, o.minLen || 0, nr.inputs.length - back)));
				trophyArm.busy = true;
				if (!trophyRf) { trophyRf = path.join(work, 'trophy.reach'); RF.writeReachFile(o.field, trophyRf, fp); }
				const rf = trophyRf;
				const ci = pickConf(null);
				// (the steer field, when the editor passes it: the trophy arm's order, the relay's; its ceiling then counts both fields)
				const d0 = nr.rc >= STEER_MISS ? nr.rc - STEER_MISS : nr.rc;
				job = { lane, r: null, inputs, conf: ci, cells: CF[ci], reach: rf, steer: a.burstSteer || '', slack: Math.min(SLACK_MAX, Math.round(SLACK + SLACK_F * d0)),
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
					// (the big sizing: the small one at once, SMALL for --burstSmallS s)
					if (big && !small() && !stopped) {
						smallUntil = Date.now() + (a.burstSmallS > 0 ? a.burstSmallS : 300) * 1000;
						st.small++;
						o.say({ ev: 'warning', text: `burst: ${r.end}: the small sizing (one lane, 2^${SMALL.cells} cells, ${SMALL.cap.toLocaleString('en-US')} states a layer) for ${a.burstSmallS > 0 ? a.burstSmallS : 300} s` });
						continue;
					}
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
			// (a dead start: out of situations and nothing gained: its zone dead for this arm; the arm's run of empty bursts)
			if (job.r) {
				job.r.zero = reward > 0 ? 0 : job.r.zero + 1;
				if (!job.chain && job.tile >= 0 && r.end === 'exhausted' && !r.reached && !r.changed && !r.fresh && !(r.near < job.startDist - 1)) {
					const z = (((job.tile % W) / DEAD_ZONE) | 0) + (((job.tile / W) / DEAD_ZONE) | 0) * Math.ceil(W / DEAD_ZONE);
					if (!job.r.dead.has(z)) { job.r.dead.add(z); st.deadStarts++; }
				}
			}
			// the stall ladder: an arm's bursts that gained nothing (no target, no room, no nearer), STALL_N in a row, send
			// this one's start up the ladder (each start once per arm); a gain starts the count over
			const stallNow = job.r && a.stallLadder !== 0 && stallStep(job.r, job, r);
			if (stallNow) {
				st.stalls = (st.stalls || 0) + 1;
				job.stallLadder = true; job.wall = 0; job.from0 = job.from0 || job.inputs; job.what = `${job.what.replace(/ · (chain|finer|wall) .*$/, '')} · stalled`;
				// (and the CPU leg search, from the room's first arrival, else from the stalled start LEG_BACK further back)
				const arm = job.r, f0 = job.from0;
				const walk = arm.lastField && arm.lastField.walk;
				if (!legRun(arm, arm.inputs, 'the first arrival in the room', walk) && f0.length > LEG_BACK + 50) legRun(arm, f0.slice(0, Math.max(o.minLen || 0, f0.length - LEG_BACK)), `${LEG_BACK} back`, walk);
			}
			confs[job.conf].n++; confs[job.conf].y += reward;
			if (job.r && job.r.confs) { job.r.confs[job.conf].n++; job.r.confs[job.conf].y += reward; }
			o.say({ ev: 'burst', n: st.bursts, room: job.r ? job.r.desc : null, what: job.what, from: job.inputs.length, sec: Math.round(r.sec * 10) / 10, wall: Math.round((r.wall || 0) * 10) / 10, end: r.end,
				reached: r.reached, changed: r.changed, newRooms: r.fresh, dist: Number.isFinite(r.near) ? Math.round(r.near * 10) / 10 : null, startDist: Math.round(job.startDist * 10) / 10,
				states: r.states, layers: r.layers, reward: Math.round(reward * 100) / 100, chain: job.chain || 0, at: o.sec(), ...(job.tile >= 0 && !job.chain ? { tile: [job.tile % W, (job.tile / W) | 0] } : {}) });
			// the chain: nearer without reaching a target: on from its nearest attempt, the same targets (the same steer file)
			if (!r.reached && r.best && Number.isFinite(r.near) && r.near < job.startDist - 1 && job.chain < CHAIN_MAX) {
				const c = job.chain + 1, back = CHAIN_BACK[c % CHAIN_BACK.length];
				const inputs = back && r.best.length > back + 50 ? liveCut(r.best, r.best.slice(0, Math.max(o.minLen || 0, r.best.length - back))) : r.best;
				// (a table that filled before a target: the next link greedier, a smaller layer (CONFS' caps 1 M -> 64 K -> 16 K);
				// Infinity Pain's wall: 4 px / 1/16 px/tick with 1 M states a layer filled its table 33 tiles short three times
				// in a row, where 64 K and 16 K passed from the route's own states 150 and 400 ticks back)
				const ci2 = r.end === 'full' ? GR[job.conf] : job.conf;
				// (a link after finer cells keeps them unless its table filled)
				const keep = job.fine && r.end !== 'full';
				next = Object.assign({}, job, { inputs, startDist: r.near, slack: Math.min(job.r ? Infinity : SLACK_MAX, Math.round(SLACK + SLACK_F * r.near)), chain: c, conf: ci2,
					cells: keep ? job.cells : CF[ci2], fine: keep ? job.fine : 0,
					what: `${job.what.replace(/ · (chain|finer|wall) .*$/, '').replace(/settings \d+/, `settings ${ci2}`)}${keep ? ` · finer ${FINE_TEXT[job.fine - 1]}` : ''} · chain ${c}${back ? ` (${back} back)` : ''}` });
				st.chained++;
			} else if (job.r && !r.reached && ((r.end === 'exhausted' && Number.isFinite(r.near) && r.near <= FINE_NEAR && (job.wall || 0) < WALL.length) ||
				(job.stallLadder && (job.wall || 0) < STALL_WALL.length)) && job.chain < CHAIN_MAX) {
				// every situation tried a few tiles from a target (or the arm stalled: the stall ladder, below): the wall ladder
				// from the same start (further back, then finer)
				const ladder = job.stallLadder ? STALL_WALL : WALL;
				const k = job.wall || 0, w = ladder[k], from = job.from0 || job.inputs;
				const inputs = from.length > w.back + 50 ? from.slice(0, Math.max(o.minLen || 0, from.length - w.back)) : from;
				next = Object.assign({}, job, { inputs, from0: from, chain: job.chain + 1, wall: k + 1, fine: w.fine, cells: w.fine ? FINE[w.fine - 1] : job.cells,
					what: `${job.what.replace(/ · (chain|finer|wall) .*$/, '')} · wall ${w.back} back${w.fine ? `, ${FINE_TEXT[w.fine - 1]}` : ''}` });
				st.fine++;
			} else if (FY >= 0 && job.r && !r.reached && r.end === 'exhausted' && job.conf !== FY && !job.fineY && job.chain < CHAIN_MAX) {
				// every situation tried far from the targets (the wall ladder's case is near them): coarse cells may have cut a
				// slow climb (FINE_Y): the same start again in fine-y cells, once a chain
				next = Object.assign({}, job, { chain: job.chain + 1, conf: FY, cells: FINE_Y, fineY: 1, fine: 0,
					what: `${job.what.replace(/ · (chain|finer|wall|fine-y) .*$/, '').replace(/settings \d+/, `settings ${FY}`)} · fine-y (${FINE_Y_TEXT})` });
				st.fine++;
			}
			// (a chain that ended short of its targets: a failure of the target nearest its last start; REST_AFTER of them rest it)
			if (!next && job.r && !r.reached) failAt(job);
		}
	};
	/** the untried target (component) nearest the end of job's inputs by the room's walk: one more failure of it */
	const failAt = (job) => {
		// (every chain that ended short of its targets: the room's failures, --burstFair)
		job.r.fl = (job.r.fl || 0) + 1;
		st.failedChains = (st.failedChains || 0) + 1;
		try {
			const rr = job.r.base || job.r, arm = !!job.r.portal;
			const I = rr.info;
			if (!I) return;
			const sim = new E.EESim(L), inp = new E.EEInput();
			sim.reset();
			for (let k = 0; k < job.inputs.length; k++) { E.applyMask(inp, (job.inputs.charCodeAt(k) - 48) & 31); sim.tick(inp); }
			const s0 = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
			const goal = new Map();
			for (const [c, tiles] of I.comps) if (!job.r.tried.has(c) && I.pOnly.has(c) === arm && !(job.r.rest && job.r.rest.has(c))) for (const t of tiles) goal.set(t, c);
			if (!goal.size) return;
			const seen = new Uint8Array(N), q = new Int32Array(N);
			let qh = 0, qt = 0, hit = -1;
			seen[s0] = 1; q[qt++] = s0;
			while (qh < qt && hit < 0) {
				const t = q[qh++];
				if (goal.has(t)) { hit = goal.get(t); break; }
				const x = t % W, y = (t / W) | 0;
				const ex = PT.exits.get(t);
				if (ex) for (const e of ex) if (!seen[e] && I.pass[e]) { seen[e] = 1; q[qt++] = e; }
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const j = yy * W + xx;
					if (seen[j] || !I.pass[j]) continue;
					if (dx && dy && I.wall[y * W + xx] && I.wall[yy * W + x]) continue;
					seen[j] = 1; q[qt++] = j;
				}
			}
			if (hit < 0) return;
			const R = job.r;
			if (!R.fails) R.fails = new Map();
			const n = (R.fails.get(hit) || 0) + 1;
			R.fails.set(hit, n);
			if (n >= REST_AFTER) { if (!R.rest) R.rest = new Set(); R.rest.add(hit); R.fails.set(hit, 0); st.rested = (st.rested || 0) + 1; }
		} catch (e) { /* a record only */ }
	};
	return {
		room, edge, triggers: TR.n,
		/** (tests) room `key`'s walk: its targets (comps: component -> tiles), the ways through (the timed killer's
		 *  removers), the trophies; null for a room not known */
		info: (key) => { const r = rooms.get(key); return r ? infoOf(r) : null; },
		/** the best route (masks): the route arm's (a newer, faster one replaces it; its cursor keeps its tick) */
		route: (masks) => { if (RA) { try { RA.setRoute(masks); } catch (e) { o.say({ ev: 'warning', text: `route arm: ${e.message}` }); } } },
		/** before any route: the search's nearest attempt (inputs), the route arm's target at its --rArmPre share */
		attempt: (inputs) => { if (RA && a.rArmPre > 0) { try { RA.setAttempt(Uint8Array.from(String(inputs), (c) => (c.charCodeAt(0) - 48) & 31)); } catch (e) { o.say({ ev: 'warning', text: `route arm: ${e.message}` }); } } },
		start: () => { loopP = Promise.all(Array.from({ length: Math.max(1, a.burstPar) }, (_, k) => loop(k))).catch((e) => o.say({ ev: 'warning', text: `bursts: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}` })); return loopP; },
		/** ends the running burst between two launches and the loop; resolves once its process is gone */
		stop: async () => {
			stopped = true;
			for (let k = 0; k < Math.max(1, a.burstPar); k++) { try { fs.writeFileSync(path.join(work, `stop_${k}`), '1'); } catch (e) { /* none */ } }
			// (the burst servers: the end of their input ends them after their job, which the stop file ends)
			for (const s of servers.values()) { if (s.ch && !s.dead) { hold(s, true); try { s.ch.stdin.end(); } catch (e) { /* gone */ } } }
			for (let k = 0; k < 150 && children.size; k++) await sleep(100);
			for (const ch of children) { try { ch.kill(); } catch (e) { /* gone */ } }
			for (const w of legWorkers) { try { await w.terminate(); } catch (e) { /* gone */ } }
			if (loopP) await loopP;
		},
		stats: () => Object.assign({ rooms: rooms.size, triggers: TR.n, confs: confs.map((c) => `${c.n}:${c.n ? (c.y / c.n).toFixed(2) : '-'}`).join(' ') }, st, RA ? { armInfo: RA.stats() } : {}),
	};
}

/**
 * roomAim(L, RM, sim, known, T) -> {walk (Uint16Array, fifths: 5 a step), mx, goals (tiles), x, y (the nearest goal's
 * tile from the ball), n (goal components)} or null: the room's NEXT TARGETS from the ball's state (the wall breaker's
 * stall target where no coin plan gives one; the guidance study of Forgotten Helix, 2026-09-28: its breaker aimed at
 * the trophy by a walk through every door and so at a viewing pocket behind two 16-coin doors that never open, while
 * the search's frontier (3 coins) needed coin 4). The walk: 8-way from the ball's tile, through portals forward, doors
 * as the ball's room holds them (sim.is_tile_solid_now), killing tiles closed unless the ball is protected (the bursts'
 * infoOf passable set). Its goals: the trigger components (triggersOf) it reaches whose touch (the ball's state, its
 * centre on the tile, one tick without input: the bursts' test) changes the room into one the search has not seen yet
 * (known(key) false; coins already taken are none), and the trophy where the walk reaches it. A trigger that changes
 * the room into a KNOWN room is a way through (the walk goes on: past a low-gravity reset the next coin may lie). The
 * field is the walk backwards from the goals (portals backwards, 5 a portal: src/reach.js's units). Only an order: the
 * breaker's explore keeps every state its table holds; nothing is pruned by it. T: {TR, PT} (triggersOf, portalsOf; made
 * when not given).
 */
function roomAim(L, RM, sim, known, T) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = RF.guideFlags(L);
	const TR = (T && T.TR) || triggersOf(L), PT = (T && T.PT) || portalsOf(L);
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
	const key0 = RM.key(sim), cz0 = RM.cause(sim), snap0 = sim.snapshot(), inp0 = new E.EEInput(), acts = new Map();
	// (a touch that only turns mono switches off, into a room this one dominates: no goal; goexplore.js roomOf shrinks)
	const d0 = RM.dom && RM.shrinks ? RM.dom(sim) : null;
	/** touching component c at tile t: 2 = into a room not seen yet, 1 = into a known room, 0 = no change */
	const act = (c, t) => {
		let v = acts.get(c);
		if (v === undefined) {
			sim.restore(snap0);
			sim.px = (t % W) * 16; sim.py = ((t / W) | 0) * 16; sim.speed_x = 0; sim.speed_y = 0;
			try {
				sim.tick(inp0);
				if (sim.is_dead) v = 0;
				else if (!RM.byTrigger(cz0, RM.cause(sim))) v = 0;
				else if (d0 !== null && RM.shrinks(d0, RM.dom(sim))) v = 0;
				else { const k2 = RM.key(sim); v = k2 === key0 ? 0 : known(k2) ? 1 : 2; }
			} catch (e) { v = 0; }
			sim.restore(snap0);
			acts.set(c, v);
		}
		return v;
	};
	const seen = new Uint8Array(N), term = new Uint8Array(N), q = new Int32Array(N);
	let qh = 0, qt = 0;
	seen[s0] = 1; q[qt++] = s0; pass[s0] = 1;
	const goals = [], comps = new Set();
	let first = -1;
	while (qh < qt) {
		const t = q[qh++], x = t % W, y = (t / W) | 0;
		const c = TR.comp[t];
		if (t !== s0 && fg[t] === 121) { goals.push(t); term[t] = 1; if (first < 0) first = t; continue; }
		if (c >= 0 && t !== s0 && !(TR.eaten[c] && sim.is_coin_collected(x, y))) {
			const v = act(c, t);
			if (v === 2) { goals.push(t); comps.add(c); term[t] = 1; if (first < 0) first = t; continue; }
		}
		const ex = PT.exits.get(t);
		if (ex) for (const e of ex) if (!seen[e] && pass[e]) { seen[e] = 1; q[qt++] = e; }
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
	}
	if (!goals.length) return null;
	const walk = new Uint16Array(N).fill(CUT);
	let mx = 0;
	qh = 0; qt = 0;
	for (const g of goals) if (walk[g] === CUT) { walk[g] = 0; q[qt++] = g; }
	while (qh < qt) {
		const t = q[qh++], x = t % W, y = (t / W) | 0, d = Math.min(0xfffd, walk[t] + 5);
		const src = PT.srcOf.get(t);
		if (src) for (const p of src) if (walk[p] === CUT && pass[p] && !term[p]) { walk[p] = d; if (d > mx) mx = d; q[qt++] = p; }
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (walk[j] !== CUT || !pass[j] || term[j]) continue;
				if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
				walk[j] = d; if (d > mx) mx = d; q[qt++] = j;
			}
		}
	}
	return { walk, mx, goals, x: first % W, y: (first / W) | 0, n: comps.size, start: walk[s0] };
}

module.exports = { create, triggersOf, portalsOf, roomAim, CONFS, FINE_Y, slowYOf, fairScore, REST_AFTER, stallStep, STALL_N, STALL_WALL };
