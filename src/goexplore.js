'use strict';
// The CPU route search of the level editor's "Find a route" (src/editor.js, strategy "random runs (CPU)"): Go-Explore
// from the level start to the trophy in the exact JS engine, so it needs no GPU. On open levels it finds a first route
// after tens of thousands of simulated ticks (a fraction of a second); the GPU's "every move" passes then look for
// faster ones below its length (editor.js launch: --depth = route - 1).
//
// An archive keeps one cell per situation: the tile of the box centre, on the ground or not, the sign of vx, a class of
// vy (rising fast, rising, still, falling), the jump count, the gravity queue (the tiles of the last two ticks) and the
// discrete state (coins and which ones, keys, switches, effects, checkpoint, gates, portal draws). Each cell keeps the
// EARLIEST state that reached it (its inputs; a snapshot once it is picked, within a memory budget: --mem MB per
// worker). A heap picks the cell with the lowest
//   reach cost (src/reach.js: the physics-aware distance to the trophy) + --lambda x sqrt(times picked),
// so the optimism of a cell fades with use and a local minimum of the reach field is left by itself. From the picked
// cell, --rolls random runs of --roll ticks (each tick keeps the last input with probability --keep, else draws one of
// the 18); every state on the way that reaches a new cell, or a known one sooner, updates the archive. A state the reach
// field rules out (-1, a proof) ends its run. Where the search is stuck (the lowest reach cost has not improved for
// --stall picks, and the picked cell's pick count is a multiple of --refine) the 3 x 3 tiles around the picked cell get
// finer cells: position and speed to 4 px and 1/2 px/tick, then 1 px and 1/8, 1/4 px and 1/32, 1/16 px and 1/128
// (--maxres levels), so pixel-precise spots get precision and the rest of the level does not.
// A route (the trophy touched after T ticks) is replayed in the exact engine (common.js evaluate) before it is printed.
// From then on only routes of fewer ticks count (a cell at tick T - 1 or later is no longer picked), so the search keeps
// improving its earliest states and prints each faster route. Each worker thread runs its own archive with its own
// seed (--seed, --seed + 1, ...); the fastest route bounds them all. One worker is exactly reproducible: the same seed
// and tick budget (--maxTicks) give the same routes (with several workers, which one finds what first is a race; --gpu=1:
// see GPU below).
//
// Two kinds of cells (--cells; auto: by the level's size):
//   fine    (levels of at most 50 x 50 = FINE_MAX_TILES tiles: the pixel-exact levels) everything above: the discrete
//           state's hash, the jump count and gravity queue in every cell, refinement, the one heap.
//   coarse  (bigger levels) the "Find a route" research's design B (a local prototype, ngx.js --mode=novold; the
//           research notes are not in the repository): on a 200 x 200 level the fine cells and their refinement filled
//           the archive (Infinity Pain: 2.36 M cells after 12 M ticks) and the one heap stayed in the reach field's traps
//           (the ice level: 739 tiles out, where the prototype found routes in 4 of 6 seeds, the first after 87 M ticks
//           on one thread). A cell is (tile, ROOM, on the ground, sign of vx, class of vy), plus the time-door phase in
//           --phase-tick buckets on levels with time doors (a ball waiting for a door makes new cells); no jump count, no
//           gravity queue, no refinement. The ROOM (roomOf) is the part of the discrete state that opens or shuts
//           doors or changes the physics (keys, switches, effects, team / coin counts / crowns / deaths where a door
//           reads them, time doors open or shut), not coin identities, checkpoints or timers. Three heads pick:
//             A (--pA of the picks when no discovery is due): the heap above, on the reach field's cost;
//             B (novelty, the rest): a room by a tournament of 4 (weight (1 + ln(1 + gain)) x (2 if the trophy is
//               walkable in the room) / sqrt(1 + picks / 50); gain = the tiles its door-aware flood fill reaches that no
//               earlier room's did), then the best of --sample random cells of it by 1 / sqrt(1 + seen) + 1 / sqrt(1 +
//               picks) (seen: how often a run came through the cell);
//             C (discovery, half the picks while one is due): --burst picks of each new room's first cell, only for
//               rooms that open new territory (gain > 0: on a level of many switches most rooms open nothing).
//           The room's fields (flood fill, trophy walkable) are cached by the passable set (the doors' states and
//           protection), the least recently used dropped beyond a budget: rooms that share doors cost a hash. A room is
//           made (its fields walked) only when its first cell enters the archive: a state in a new room while the
//           archive is full (until the next sweep makes room), or too late for a faster route, makes none (it would stay
//           empty); a room whose cells were all swept goes. The room measure only orders: a state is ruled out only by
//           the reach field's -1, as with fine cells.
//           It picks like the prototype except in two ways: the discovery burst goes only to rooms with territory gain
//           (the prototype bursts every new room, and a burst draws random numbers, so a room without gain changes the
//           draws after it), and crowns are keyed by _collide_crown, what crown doors read (the prototype: has_crown).
//           Where every new room opens territory and no crown door stands both give the same routes after the same
//           simulated ticks (test/editor.js pins the prototype's first route on a key-door level); on the ice level
//           they differ (seed 1's first route after 82.8 M ticks here, 87.2 M in the prototype).
//           The ice level: one worker, seed 1, its first route (9,982 ticks) after 82.8 M simulated ticks (23-26 s on
//           the i7-11800H laptop); 4 workers as the editor starts them (seed 1, depth 100000): the same route from the
//           same worker after the same 82.8 M ticks (a worker's draws do not depend on the others'), so the time is that
//           worker's speed: 32-36 s on the laptop otherwise idle, 50-56 s while other jobs' GPU work heats its shared
//           cooler; 9,661 ticks after 180 s.
//
// THE ONE SEARCH (coarse cells; the friend's "one optimal search" instead of three searches built one after another):
// one archive of cells for every operator. (a) The random runs: every room a worker enters first goes to the main
// thread ('room' message: its first cell's inputs, the room it came from, the tile), and a room change between two known
// rooms once per (room, tile) ('edge': the trigger tried there, the room entered there); with --share=1 (off by default)
// the room also goes into every other worker's archive (every state along it, as a run's states). Measured (A100, 3
// workers, the GPU bursts on): Infinity Pain 600 s the same with and without (14 rooms each, route coverage 18,779 /
// 18,769 of 38,498: the bursts' attempts go into every archive anyway); Good Egg 300 s 971 with it, 1,407 without (the
// relay's search before: 1,390): with many switch and coin rooms every worker spread over all of them. (b) --bursts=1:
// the GPU operator (src/bursts.js): short exhaustive "every move" bursts (eegpu explore --prefix, --tool) from the
// archive's cell of a room nearest its untried triggers (the main thread asks every worker for its own: 'nearest'), the
// bursts' nearer attempts imported into every archive; a bandit over the rooms and the burst settings. The workers read
// the main thread's messages between two chunks of picks (a MessageChannel per worker, receiveMessageOnPort). One worker
// without --bursts is exactly as before (nothing is shared).
//
// It prints the JSON lines of the editor's native tools (native/beamhost.h, explorehost.h), one per line:
//   {"ev":"start","workers":n,"seeds":[..],"mode":"physics"|"walk","cells":"fine"|"coarse","startCost":c|null,"mem":MB,
//     "memWhy":"..","processMB":..,"machineMB":..,"freeMB":..,"othersMB":..,"maxCells":..,"maxSnaps":..}
//                                                (the budget per worker, what bound it, this search's process memory at
//                                                 most, the machine's, what was free, what the other searches claim)
//   {"ev":"progress","layer":L,"tick":L,"states":cells,"ticks":simulated,"ticksPerSec":..,"picks":..,"bestCost":..,
//     "found":T|0,"refined":tiles,"rooms":n,"workers":n,"memMB":..,"heapMB":..,"evicted":..}
//                                                (every 0.5 s; L = the deepest cell's tick; rooms: the most one worker
//                                                 has found; memMB: the workers' budgets' counts, heapMB: their V8 heaps
//                                                 in use (garbage too), evicted: the cells swept)
//   {"ev":"closest","dist":reach cost,"tick":T,"inputs":".."}                    (the state nearest the trophy, when it
//                                                                                  improves, at most every 0.5 s)
//   {"ev":"source","kind":"room"|"best","room":key,"desc":"..","gain":tiles,"tick":T,"dist":reach cost,"inputs":"..",
//     "seed":s}            (coarse cells: starting points for the editor's relay. "room": a new room's first cell (each
//                          room with territory gain, the others at most one per SOURCE_S per worker); "best": every
//                          SOURCE_S s the lowest-cost cell of the 4 rooms with the most gain and the fewest sources so
//                          far, when it changed. A room key only once per kind unless its tick / cost improved.)
//   {"ev":"result","kind":"finish","ticks":T,"runTicks":..,"inputs":"..","seed":s,"simTicks":..,"sec":..}   (a GPU
//     burst's: seed 0, "by":"gpu")
//   {"ev":"burst","n":..,"room":desc|null,"what":"..","from":T,"sec":..,"end":"..","reached":b,"changed":b,"newRooms":n,
//     "dist":tiles,"startDist":tiles,"states":..,"layers":..,"reward":..,"chain":k,"at":s}   (--bursts=1: each burst;
//     the progress and done events carry "gpu": the operator's numbers, "allRooms", "shared")
//   {"ev":"done","layers":L,"seconds":..,"ticks":..,"ticksPerSec":..,"states":..,"picks":..,"end":"time"|"ticks"|
//     "exhausted"|"finish"|"stopped"|"unreachable","finish":T|0,"first":{ticks,sec,simTicks,seed}|null,
//     "workers":[{seed,..},..]}      ("unreachable": the reach field rules out the start itself, "exhausted": no cell is
//                                      early enough for a faster route; a worker's memMB / heapMB / evicted / sweeps, its
//                                      heapMB after a collection when node runs with --expose-gc)
//   {"ev":"warning","text":".."}     (a route that does not replay, a worker that failed, a worker whose heap is smaller
//                                      than its budget asks)
// Inputs are .eetas characters ('0' + mask). With --stdin=1 it reads lines from stdin: "depth D" (from now on only
// routes of at most D ticks: a route of D + 1 is known elsewhere) and "stop"; the end of stdin (the editor is gone)
// stops it too. A last line "[goexplore] ..." sums up.
//
// Memory (--mem MB per worker; the default below). Every piece of a worker's archive is counted as it changes, at its
// size on the V8 heap (measured: B_CELL .. B_QUEUE): the cells, the pick heap, the path nodes with the picks' inputs
// they keep (counted by reference: an improved cell's old node lives on while nodes made from it do), the rooms and
// their walk cache, the snapshot queue; the snapshots on top. The archive may take ARCHIVE_SHARE (55%) of the budget: a
// new cell past it is refused, and the next sweep (between two chunks of picks) drops the cells no run or pick has
// touched for longest down to 90% of that share (never the start, a room's lowest-cost cell or a discovery burst's
// cell), so the archive keeps growing where the search is and the search goes on; the snapshots take what the archive
// leaves, up to 95% of the budget. The count against the heap after a collection (with the inputs' bytes outside it):
// within 7% above on Stupid Fox and Good Egg, equal on the ice level (one worker, 60 s). Stupid Fox (200 x 200: time
// doors, coins, team doors), 8 workers as the editor starts them (1500 MB each), 25 min on 6 threads of the shared H100
// box: no failure, 10.5 M cells, 0.85-0.96 GB counted and 0.77-0.85 GB of heap a worker at the end (one sweep), the
// nearest attempt 13.4 tiles from the trophy after 807 s (the lab's A100 box, faster: 305 s).
// Under the old editor's --max-old-space-size=1024 (597 MB a worker), the same 8 workers, 25 min: no failure, 46-81
// sweeps a worker (39 M cells swept in all), 350-390 MB counted and 330-350 MB of heap a worker, 42 rooms, 13.4 tiles
// after 377 s (the box less loaded then).
// Until 48c4e0b the budget counted 300 bytes a cell and 1150 a snapshot, 45% each: a cell really held about 450 (its
// path node, its heap entries and its share of the picks' inputs were not counted, nor the old nodes improved cells
// leave), so a worker's heap outgrew its budget; the editor started this with NODE_OPTIONS=--max-old-space-size=1024,
// which V8 applies to every isolate of the process, the workers too, over their own limits (resourceLimits): 1 GB
// heaps under 1500 MB budgets. The lab's Stupid Fox run (8 workers on the 708 GB A100 box): all 8 ran out of heap after
// 10-16 minutes at about 1.6 M cells each (its workers 1-6 without the flag, on the H100 box: 0.8-1.1 GB heaps after
// 25 min; under a 350 MB flag with --mem=500 both of 2 workers ran out, at 510 K and 615 K cells).
// The default budget (defaultMem): fine cells 1600 / workers (200 .. 800), coarse cells 1500, within the machine: the
// search's process memory, workers x (1.5 x budget + 208 MB) (a worker's V8 heap limit, 1.5 x its budget + 128 MB old
// and 48 MB young, and its code, level and engine), at most a quarter of the machine's memory (os.totalmem(), or a
// container's limit: process.constrainedMemory()), all the searches on the machine at most half of it (a registry: a
// file per search in the temp folder, eeautotas-goexplore/<pid>.json, with its process memory; a dead or silent
// search's file is removed), at most half of the memory free at its start (os.freemem(), process.availableMemory());
// never below 128 MB a worker. 15 workers on a 32 GB laptop: 225 MB each (8 GB in all at most), 4 workers 1226, 7 on 8
// GB 128; 8 on the 708 GB lab box 1500; five searches of 36 workers one after another on the 251 GB EPYC box: 1051,
// 1051, 128, 128, 128 (168 GB in all at most; before: 1500 each, 270 GB of budgets that each outgrew). --memTotal=<MB>:
// this search's process memory instead (the budget per worker from it). A V8 heap flag for the process
// (--max-old-space-size on the command line or in NODE_OPTIONS) caps every worker's heap whatever it asks: the budget
// fits it (1024: 597 MB a worker; a worker checks its own heap limit too and says so); the editor starts this without
// one (common.js workerHeapEnv). The default depends on the machine and its load: give --mem to reproduce a run that
// reaches its budget (a run that never reaches it does not depend on it: the same routes and cells with any budget).
//
// GPU (--gpu=1, coarse cells only; the editor's "random runs (GPU)"): the same search with its runs on the GPU (`eegpu
// roll`, native/rollhost.h). This process keeps the archive (typed arrays by the GPU's dense cell id) and the rooms, and
// picks --batch cells at a time with the three heads exactly as above, one pick after the other; eegpu roll keeps one
// state per cell (in host memory, --hmem: the GPU holds the cell table, ~70 bytes a cell, --gmem), plays --rolls runs of
// --roll ticks per pick on the GPU with the same inputs (mulberry32 seeded by (batch seed, pick, run): rollSeed /
// rollInputs rebuild them here, so a cell's path is its parent's plus a run's seed and length), keeps each cell's
// earliest arrival and reports the new and sooner cells (tick, reach cost, room). A batch is one generation of the
// frontier (the next one's picks see its cells), so its latency decides: 4096 x 8 x 40 found ice200's route after 8 s on
// the rented H100 (6 seeds; 1024 / 2048 / 16384 picks: 12.4 / 8.2 / 16.3 s; runs of 20 / 80 ticks slower too). The
// same seed makes the same search (the same routes after the same simulated ticks): the tool sends a batch's records in
// (tick, pick, run, step) order and the seen counts come every SEEN_BATCHES batches, by the count, not the clock; only
// the dense ids differ (the GPU's atomics hand them out), and so may the cells kept in the batch that fills the pool.
// Every route is replayed in the exact JS engine; the reach field's -1 is still the only prune (in the kernel). eegpu
// roll ending by a failed launch or a crash (exit 6 / 7, above 255, a signal, no done line) is an error line with
// launchError (the editor then stops its GPU strategies) and this process's exit code 6 / 7.
//   [--gpu=1] [--batch=4096] [--gmem=<MB for the GPU's cell table>] [--hmem=<MB of host memory for the cells' states;
//   default: an eighth of the machine's memory, at most half of the free memory>] [--tool=<eegpu>] [--bin=<level blob>]
//   [--reach=<RCH3 file>]
//   [--stopfile= --pausefile= --cachedir= --launch-ms= (passed to eegpu)]
//
// usage: node src/goexplore.js <level.eelvl | level.json> | --level=<level id | job id>  [--seconds=60] [--workers=1]
//        [--seed=1] [--depth=100000] [--maxTicks=0 (per worker; 0 = no limit)] [--first=0|1 (stop at the first route)]
//        [--out=<route.eetas>] [--stdin=0|1] [--lambda=2] [--roll=40] [--rolls=8] [--keep=0.85] [--stall=200]
//        [--jumpP=0 (the CPU runs: 0 = one of the 18 options, jump in half; p = jump with p, --jumpNear=0.75 on the
//        ground by a wall or a gap the way it goes)]
//        [--refine=6] [--maxres=4 (fine cells)] [--cells=auto|fine|coarse] [--pA=0.5] [--burst=8] [--sample=16]
//        [--phase=50] [--mem=<MB per worker; see above>] [--memTotal=<MB of process memory for the search>]
//        [--maxCells= (at most this many cells: sweeps)] [--maxSnaps= (at most this many snapshots)]
//        [--prune=1 (0: the reach field rules nothing out: the start is never "unreachable", a ruled-out state costs
//        1e4 + its walking distance; the editor's check of a level the field calls impossible)]
//        [--steer=<RCH4 file> | build (src/steer.js: a second heap for head A on the gate-aware steer field, picked --mix
//        of its picks; the reach field alone rules states out)] [--mix=0.5] [--steerDist=1 (the closest attempt and the
//        sources by the steer field)] [--dpFirst=0|1 (1: the steer lookup takes the coin DP's value wherever it has one,
//        not the least of it and the layer's own field)]
//        [--share=0|1 (the one search: the workers share their new rooms; coarse cells)] [--bursts=0|1 (the GPU operator,
//        src/bursts.js; coarse cells)] [--tool=<eegpu> (default: gpu.js nativeTool; a .js file: a stand-in run by Node)]
//        [--cachedir=<kernel cache>] [--pausefile=<file: the bursts wait between two launches while it exists>]
//        [--work=<folder for the bursts' files>] [--burstS=15 (seconds per burst at most)] [--burstPar=1 (bursts side by
//        side)] [--gpuCells=25 (log2 of a burst's cell table)] [--burstCap=262144 (a burst's states per layer at most; 0:
//        its settings' own, up to 1 M)] (the defaults are the relay's sizing next to every move and the beams: a 2^26
//        table and 1 M layers on 2 lanes took 3-5.7 GB, more than an 8 GB laptop GPU has beside them; the A100 runs:
//        --burstPar=2 --gpuCells=26 --burstCap=0) [--burstSteer=<RCH4 file> (the steer field for the bursts' trophy arm:
//        its order, as the editor's relay had it; the GPU tool must read RCH4)] [--burstOomS=5 (a burst that found the GPU's
//        memory full waits this long, doubled while it lasts, up to 120 s: no try of its arm, never the bursts' end)]
//        [--prefix=<run.eetas | .eetas characters> (the gate benchmark, tools/gatebench.js: the search starts after those
//        inputs; every path begins with them, only finds after the start state count; CPU cells only)]
//        [--rooms=0|1 (an event "room" for every room the one search registers: its cause, the inputs; coarse cells)]
//        [--pL=0.3 (head L, the one search once a route is known: the picks by the lead on the best route's schedule, its
//        share by its yield: LEAD_GRACE_S)] [--pW=0.3 (head W: of the picks head L leaves once a route is known, the
//        cells off the route's schedule by their key-blind lead, the route's first tick at the tile in any room: WAY_PICK;
//        0 = off)] [--lb=1 (the sound lower bound per tile prunes states: lowerBoundTiles)]
//        [--nice=0 (Linux: each worker THREAD lowers its own priority to this nice value; the main thread, the bursts'
//        eegpu it starts and the editor's GPU tools keep theirs. The editor passes 10 next to GPU strategies; before, it
//        reniced the whole process, so the one search's GPU bursts ran at nice 10 too, below every normal process of a
//        shared box: the cycle 7 test's A100, `ps`: goexplore 10, its eegpu explore --prefix 10, the other GPU tools 0)]
//        The progress and done events carry cpuS: the process's CPU seconds (every thread; process.cpuUsage), so a
//        route's time can be told per core-second as well as per wall second on a shared machine.
//        With --stdin=1 and the one search also "route <inputs>": a route found elsewhere (the bound, head L's schedule,
//        its states into every archive; a "route" event, no result).
//        With --stdin=1 and the one search also "import <inputs>": another operator's run (the editor's GPU random runs:
//        a room they entered first, a nearer attempt) into every worker's archive, like a burst's attempt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const C = require('./common.js');
const E = C.E;
const EL = require('./eelvl.js');
const RF = require('./reach.js');
const SF = require('./steer.js');
const V8 = require('v8');

// the 18 inputs: nothing / left / right x nothing / up / down x jump or not (explore.js's order)
const OPTIONS = [];
for (const h of [0, 2, 4]) for (const v of [0, 8, 16]) for (const j of [0, 1]) OPTIONS.push(h | v | j);
// the cell grain per refinement level: position x QP and speed x QV to whole numbers (level 0: the sign of vx and a
// class of vy only)
const QP = [0, 0.25, 1, 4, 16], QV = [0, 2, 8, 32, 128];
const MAXRES = QP.length - 1;
// a seed's states that become cells: every SEED_EVERY ticks back from its end (and the end)
const SEED_EVERY = 30;
// head L (a route known): a cell's pick priority = its lead (ticks; below 0 ahead of the best route) + LEAD_PICK x
// sqrt(its picks): 25 picks cost 100 ticks of lead. Its share follows its yield: --pL of the picks for LEAD_GRACE_S after
// the first route and after each faster route a head-L pick found (any worker's), then halved every LEAD_HALF_S down to
// LEAD_FLOOR x --pL (Infinity Pain: head L's routes came 19 s after the first route and every few minutes after; Stupid
// Fox: none in 15 min, while heads A / B found main's 7,680 -> 6,789 at 630-834 s: src/out/night/macro_fix.md)
const LEAD_PICK = 20, LEAD_GRACE_S = 120, LEAD_HALF_S = 120, LEAD_FLOOR = 0.1;
// head W (a route known, the path gap: another WAY; the macro branch's, cycles 6-8): a cell at a (room, tile) the best
// route's schedule does not hold (head L has no lead for it) gets the KEY-BLIND lead = its tick - the route's first tick
// at that tile in any room (on time-door levels at that tile in the same phase bucket, as head L's schedule); priority
// lead + WAY_PICK x sqrt(its picks): 25 picks cost 200 ticks of lead (a region ahead but walled in by a door the route
// opened runs out sooner than head L's); --pW of the picks head L leaves
const WAY_PICK = 40;
const DEFAULTS = { seconds: 60, workers: 1, seed: 1, depth: 100000, maxTicks: 0, first: 0, stdin: 0, lambda: 2, roll: 40, rolls: 8, keep: 0.85,
	stall: 200, refine: 6, maxres: MAXRES, mem: 0, memTotal: 0, maxCells: 0, maxSnaps: 0, prune: 1, pA: 0.5, burst: 8, sample: 16, phase: 50,
	steerDist: 1, dpFirst: 0, mix: 0.5, gpu: 0, batch: 4096, gmem: 0, hmem: 0, share: 0, bursts: 0, rooms: 0, burstS: 15, burstPar: 1, gpuCells: 25, burstCap: 262144, burstOomS: 5, lb: 1, pL: 0.3, pW: 0.3, nice: 0,
	jumpP: 0, jumpNear: 0.75 };
// --gpu=1: the options passed on to `eegpu roll` (paths, and the editor's stop / pause files; --parent is the editor's pid:
// its end closes this process's stdin, which stops the search); --bursts=1 (the one search's GPU operator, src/bursts.js)
// reads tool, cachedir and pausefile too
const GPU_STRINGS = ['tool', 'bin', 'reach', 'stopfile', 'pausefile', 'cachedir', 'launch-ms', 'parent'];
// the text options
const TEXT_OPTS = new Set(['level', 'out', 'steer', 'work', 'burstSteer', 'prefix', ...GPU_STRINGS]);
const CHUNK = 16;   // picks between two looks at the clock, the shared bound and the stop flag
/** the process's CPU seconds so far (user + system, every thread) */
const cpuSec = () => { const u = process.cpuUsage(); return Math.round((u.user + u.system) / 1e5) / 10; };
// memory: what each piece of a worker's archive costs on the V8 heap (bytes; measured with node --expose-gc on Node 20
// and 24, x64: the objects as goexplore makes them, 200 K at a time): a cell (its object with the boxed double of its
// cost 160, its Map entry 45, its slot in its room's list 10), an entry of the pick heap (3 arrays; up to 3 per cell
// between two compactions), a path node, a pick's inputs that a live node still uses (the object and its typed array;
// the rolls x roll bytes themselves lie outside the V8 heap, counted too), a snapshot (1150) with its share of the coin
// bitsets it holds (a copy per coin taken: 232 bytes each), a room (its object, text and list), a slot of the snapshot
// queue. The walk cache of the rooms' fields keeps its own count (roomFields).
const B_CELL = 216, B_HEAPE = 32, B_NODE = 72, B_BLOCK = 250, B_SNAP = 1200, B_ROOM = 600, B_QUEUE = 10;
// --steer: a cell's steer cost (its property and boxed double: 160 -> 184 bytes, measured the same way); the steer heap's
// entries count as B_HEAPE each (one worker of the editor's Good Egg search ran out of its heap before they were counted)
const B_SC = 24;
// a worker's budget (--mem MB): the archive (cells, their paths, the heap, the rooms, the walk cache) up to
// ARCHIVE_SHARE of it; past that a sweep drops the cells no run or pick has touched for longest down to EVICT_TO of that
// share; the snapshots (at least MIN_SNAPS) in what the archive leaves, up to SNAP_TOP of the budget (the rest: the
// transient arrays of replays and events)
const ARCHIVE_SHARE = 0.55, EVICT_TO = 0.9, SNAP_TOP = 0.95, MIN_SNAPS = 64, SWEEP_GAP = 256;
// the biggest level (tiles) that gets fine cells by default (--cells=auto): 50 x 50, the size of the pixel-exact levels
// the editor's suite checks (sfox50, user30s, user50, the dot ring; shaft, staircase, dotstairs 40 x 25, ...)
const FINE_MAX_TILES = 2500;
// a worker's V8 heap: its old generation up to HEAP_F x its budget + HEAP_ADD MB (room for the garbage between two
// collections and the transient arrays), its young generation HEAP_YOUNG MB (Node 20's default; Node 24's 192 would
// take 4x as much per worker). A --max-old-space-size flag (the command line or NODE_OPTIONS) is V8's for every isolate
// of the process and wins over a worker's own limit (resourceLimits): the budget then shrinks to fit it (heapFit)
const HEAP_F = 1.5, HEAP_ADD = 128, HEAP_YOUNG = 48;
// the default budget (MB per worker): fine cells 1600 / workers within 200 .. 800, coarse cells MEM_MAX, both within the
// machine: this search's process memory (workers x (RSS_F x budget + RSS_BASE MB): a worker's heap at its limit, its
// young generation, code, level and engine) at most MEM_SHARE of the machine's memory, all the searches the registry
// lists (REG_DIR: the goexplore processes on this machine) at most MEM_POOL of it, and at most MEM_FREE of the memory
// free at the start; never below MEM_MIN
const MEM_SHARE = 0.25, MEM_POOL = 0.5, MEM_FREE = 0.5, MEM_MIN = 128, MEM_MAX = 1500, RSS_F = HEAP_F, RSS_BASE = HEAP_ADD + HEAP_YOUNG + 32;
const REG_DIR = path.join(os.tmpdir(), 'eeautotas-goexplore');
const REG_STALE_MS = 10 * 60 * 1000;   // a registry file not refreshed for this long is a dead search's (every 60 s)
// coarse cells: every SOURCE_S s the "best" source events; SOURCE_MIN_TICKS: shorter attempts are no source (the
// editor's relay starts from 100 ticks)
const SOURCE_S = 5, SOURCE_MIN_TICKS = 100;
// --gpu=1: head B's seen counts every SEEN_BATCHES batches, or one batch per SEEN_CELLS cells when that is more (the
// download of millions of cells); the cells' states in host memory: ROLL_HOST_SHARE of the machine's memory, at most
// half of the free memory, ROLL_HOST_MIN MB at least
const SEEN_BATCHES = 8, SEEN_CELLS = 131072, ROLL_HOST_SHARE = 1 / 8, ROLL_HOST_MIN = 256;

function parseArgs(argv) {
	const a = Object.assign({}, DEFAULTS, { file: '', level: '', out: '', cells: 'auto', steer: '', tool: '', cachedir: '', pausefile: '', work: '' });
	for (const s of argv) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (!m) {
			if (s.startsWith('--')) throw new Error(`bad option ${s} (use --name=value)`);
			a.file = s;
			continue;
		}
		if (TEXT_OPTS.has(m[1])) a[m[1]] = m[2];
		else if (m[1] === 'cells') {
			if (!['auto', 'fine', 'coarse'].includes(m[2])) throw new Error(`bad --cells=${m[2]} (auto, fine or coarse)`);
			a.cells = m[2];
		} else if (m[1] in DEFAULTS) {
			a[m[1]] = +m[2];
			if (!Number.isFinite(a[m[1]])) throw new Error(`bad --${m[1]}=${m[2]} (a number)`);
		} else throw new Error(`unknown option --${m[1]} (see the header of src/goexplore.js)`);
	}
	if (!a.file && !a.level) throw new Error('usage: node src/goexplore.js <level.eelvl | level.json> [--seconds=60] [--workers=1] [--seed=1] (see the header)');
	a.workers = Math.max(1, Math.min(64, Math.round(a.workers)));
	a.roll = Math.max(1, Math.round(a.roll));
	a.rolls = Math.max(1, Math.round(a.rolls));
	a.depth = Math.max(1, Math.round(a.depth));
	a.maxres = Math.max(0, Math.min(MAXRES, Math.round(a.maxres)));
	a.refine = Math.max(1, Math.round(a.refine));
	a.burst = Math.max(0, Math.round(a.burst));
	a.sample = Math.max(1, Math.round(a.sample));
	a.phase = Math.max(1, Math.round(a.phase));
	a.batch = Math.max(1, Math.min(1 << 20, Math.round(a.batch)));
	if (a.gpu && a.cells === 'fine') throw new Error('--gpu=1 runs coarse cells only');
	return a;
}
/** the cells for level L: 'fine' up to FINE_MAX_TILES tiles, else 'coarse' */
const cellsFor = (L) => (L.width * L.height > FINE_MAX_TILES ? 'coarse' : 'fine');
/** the process memory (MB) of a search of `workers` workers with `mem` MB each (see RSS_F) */
const processMB = (workers, mem) => Math.round(workers * (mem * RSS_F + RSS_BASE));
/** the budget per worker (MB) whose search takes `totalMB` of process memory in all */
const memOfTotal = (workers, totalMB) => Math.floor((totalMB / Math.max(1, workers) - RSS_BASE) / RSS_F);
/**
 * the default budget per worker (MB; see the header): `cells` 'fine' | 'coarse', `m` = {total, free, others} (bytes: the
 * machine's memory, what is free now, what the other searches on it claim). {mem, why}: why names what bound it
 */
function defaultMem(cells, workers, m) {
	const want = cells === 'fine' ? Math.max(200, Math.min(800, Math.round(1600 / workers))) : MEM_MAX;
	// (fine cells, the small pixel-exact levels, keep their measured 200-800 MB: their archives are small, and the machine
	// caps below would give 15 workers on a laptop with ~9 GB free only 128 MB, an unmeasured change)
	if (cells === 'fine') return { mem: want, why: 'fine cells' };
	const MB = 1048576;
	const caps = [['a quarter of the machine', MEM_SHARE * m.total / MB], ['the searches on the machine', MEM_POOL * m.total / MB - (m.others || 0) / MB],
		['the memory free', MEM_FREE * m.free / MB]];
	let mem = want, why = cells === 'fine' ? 'fine cells' : 'the most a worker takes';
	for (const [k, mb] of caps) { const x = memOfTotal(workers, mb); if (x < mem) { mem = x; why = k; } }
	if (mem < MEM_MIN) { mem = MEM_MIN; why += ` (at least ${MEM_MIN} MB)`; }
	return { mem, why };
}
/** the budget (MB) whose worker fits an old-generation limit of `oldMB` */
const heapFit = (oldMB) => Math.floor((oldMB - HEAP_ADD) / HEAP_F);
/** the old-generation limit (MB) a V8 flag sets for every isolate of this process (--max-old-space-size on the command
 *  line or in NODE_OPTIONS; the editor used to pass 1024 that way), else 0 */
function heapFlagMB() {
	const m = /--max[-_]old[-_]space[-_]size[= ](\d+)/.exec(`${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS || ''}`);
	return m ? +m[1] : 0;
}
/** the machine's memory (bytes): os.totalmem() and os.freemem(), or less under a memory limit (a container's cgroup) */
function machineMemory() {
	let total = os.totalmem(), free = os.freemem();
	try { const c = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0; if (c > 0 && c < total) total = c; } catch (e) { /* unknown */ }
	try { const v = typeof process.availableMemory === 'function' ? process.availableMemory() : 0; if (v > 0 && v < free) free = v; } catch (e) { /* unknown */ }
	return { total, free: Math.min(free, total), others: 0 };
}
/** the registry of the searches on this machine: a file per process (<pid>.json: {pid, bytes (its process memory),
 *  at}), refreshed every 60 s; the other live ones' bytes. Files of processes gone (or not refreshed for REG_STALE_MS)
 *  are removed. */
function registryOthers(dir = REG_DIR) {
	let names = [], sum = 0;
	try { names = fs.readdirSync(dir); } catch (e) { return 0; }
	const now = Date.now();
	for (const f of names) {
		const m = /^(\d+)\.json$/.exec(f);
		if (!m || +m[1] === process.pid) continue;
		const file = path.join(dir, f);
		let j = null;
		try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
		let alive = true;
		try { process.kill(+m[1], 0); } catch (e) { alive = e.code === 'EPERM'; }
		if (!alive || !j || !(now - j.at < REG_STALE_MS)) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } continue; }
		if (Number.isFinite(j.bytes)) sum += j.bytes;
	}
	return sum;
}
/** this process's entry in the registry (bytes: its process memory; 0 removes it) */
function registryClaim(bytes, dir = REG_DIR) {
	const file = path.join(dir, `${process.pid}.json`);
	try {
		if (!bytes) { fs.unlinkSync(file); return; }
		fs.mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, `${process.pid}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, bytes: Math.round(bytes), at: Date.now() }));
		fs.renameSync(tmp, file);
	} catch (e) { /* no registry: the other rules still hold */ }
}
/** --gpu=1: the MB of host memory for eegpu roll's pool of cell states: ROLL_HOST_SHARE of the machine's memory (or of a
 *  container's limit), at most half of the free memory and what the machine-wide rule leaves (MEM_POOL of the memory for
 *  all the searches the registry lists), ROLL_HOST_MIN at least; m: machineMemory() with others */
const rollHostMB = (m) => Math.max(ROLL_HOST_MIN, Math.round(Math.min(m.total * ROLL_HOST_SHARE, m.free / 2, MEM_POOL * m.total - (m.others || 0)) / 1048576));
/** the options that depend on the level: the cells (--cells=auto), and then the memory budget (see the header);
 *  m: the machine (defaultMem; default machineMemory(), no other searches) */
function settle(a, L, m) {
	if (a.cells === 'auto') a.cells = cellsFor(L);
	const coarse = a.cells === 'coarse';
	if (coarse) a.maxres = 0;   // (no refinement with coarse cells)
	if (a.mem) a.memWhy = '--mem';
	else if (a.memTotal) { a.mem = Math.max(32, memOfTotal(a.workers, a.memTotal)); a.memWhy = '--memTotal'; }
	else { const d = defaultMem(a.cells, a.workers, m || machineMemory()); a.mem = d.mem; a.memWhy = d.why; }
	// (a V8 heap flag for every isolate: the budget its workers can hold, whatever asked for more)
	const flag = heapFlagMB();
	if (flag && heapFit(flag) < a.mem) { a.mem = Math.max(16, heapFit(flag)); a.memWhy = `the V8 flag --max-old-space-size=${flag} (NODE_OPTIONS or the command line)`; }
	a.maxCells = Math.max(0, Math.round(a.maxCells));   // (0: the budget alone)
	a.maxSnaps = a.maxSnaps ? Math.max(MIN_SNAPS, Math.round(a.maxSnaps)) : 0;
	return a;
}

/** --prefix (the gate benchmark, tools/gatebench.js): the inputs (masks) the search starts after (an .eetas file, or
 *  .eetas characters), or null. Every cell's path begins with them, so routes, rooms and bursts carry whole runs */
function prefixOf(a) {
	if (!a.prefix) return null;
	const ms = /\.eetas$/i.test(a.prefix) ? C.readEetas(a.prefix) : Uint8Array.from(a.prefix, (ch) => (ch.charCodeAt(0) - 48) & 31);
	return ms.length ? ms : null;
}
/** the prepared level: an .eelvl (read like the editor does), a level JSON, or --level=<level id | job id> */
function levelOf(a) {
	if (a.file && /\.eelvl$/i.test(a.file)) return E.prepareLevel(EL.toSimLevel(EL.readEelvl(fs.readFileSync(a.file)), { id: 'goexplore', file: path.basename(a.file) }));
	if (a.file) return E.loadLevel(a.file);
	return C.loadLevel(a.level);
}

/** mulberry32 -> [0, 1) */
function rngOf(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return h ^ (h >>> 16); };

/** the discrete state's hash (what a cell tells apart besides the ball's motion): coins (and which ones), keys,
 *  switches, crowns, effects, checkpoint, team, the time-door phase, gates, death count (death doors), portal draws */
function discreteOf(L) {
	const coinW = L.coinTiles.length ? L.coinWords : 0, secretW = L.secretTiles.length ? L.secretWords : 0;
	const onSum = (m, salt) => { let s = 0; for (const [id, v] of m) if (v === true) s = (s + fmix((id ^ salt) | 0)) | 0; return s; };
	return (sim) => {
		let h = 0x3c6ef372;
		const w = (v) => { h = Math.imul(h ^ v, 0x5bd1e995); h ^= h >>> 13; };
		w(sim.coins); w(sim.blue_coins); w(sim._keysMask);
		w((sim.has_crown ? 1 : 0) | (sim.low_gravity ? 2 : 0) | (sim.is_invulnerable ? 4 : 0) | (sim.in_god_mode ? 8 : 0) | (sim.is_cursed ? 16 : 0) |
			(sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | (sim.has_levitation ? 256 : 0) |
			(L.hasTimeDoors && sim._timedoor_state ? 512 : 0));
		w(sim.max_jumps); w(sim.jump_boost); w(sim.speed_boost); w(sim.flip_gravity); w(sim.team);
		w((sim.checkpoint.x + 1) | ((sim.checkpoint.y + 1) << 16));
		if (L.hasDeathDoor) w(sim.deaths);
		if (L.hasCoinGate) w(sim._show_coin_gate);
		if (L.hasBlueCoinGate) w(sim._show_blue_coin_gate);
		if (L.hasDeathGate) w(sim._show_death_gate);
		if (L.multiTargetPortals) w(sim._rngSteps);
		for (let k = 0; k < coinW; k++) w(sim._coinBits[k]);
		for (let k = 0; k < secretW; k++) w(sim._secretBits[k]);
		if (sim._switches.size !== 0) w(onSum(sim._switches, 0x1234567));
		if (sim._oswitches.size !== 0) w(onSum(sim._oswitches, 0x7654321));
		return h | 0;
	};
}

// ---------------------------------------------------------------- rooms (coarse cells)
/**
 * roomOf(L) -> {key(sim) (int32), desc(sim) (text)}: the room, the part of the discrete state that opens or shuts doors
 * or changes the physics: the keys active, the effects (protection, curse, zombie, fire, poison, levitation, low
 * gravity; the multijump, jump, speed and gravity values), the purple and orange switches on, whether the time doors are
 * open, and only where a door reads them: the team (team doors 1027 / 1028), the coin and blue-coin counts (coin doors
 * and gates 43 / 165, 213 / 214; a gate's shown count too), the crowns (crown doors 1094 / 1095, 1152 / 1153: what the
 * doors read, _collide_crown and _collide_silver_crown), the deaths (death doors and gates). Coin identities, secrets,
 * the checkpoint, key timers and portal draws are left out (they would split every room into thousands; merged cells
 * cost completeness only: every route is replayed).
 */
function roomOf(L) {
	let team = false, coins = false, blue = false, crown = false, silver = false;
	for (let i = 0; i < L.width * L.height; i++) {
		const id = L.fg[i];
		if (id === 1027 || id === 1028) team = true;
		else if (id === 43 || id === 165) coins = true;
		else if (id === 213 || id === 214) blue = true;
		else if (id === 1094 || id === 1095) crown = true;
		else if (id === 1152 || id === 1153) silver = true;
	}
	const onSum = (m, salt) => { let s = 0; for (const [id, v] of m) if (v === true) s = (s + fmix((id ^ salt) | 0)) | 0; return s; };
	const onList = (m) => { const a = []; for (const [id, v] of m) if (v === true) a.push(id); return a.sort((x, y) => x - y); };
	// (full: the room key; else the part of it only the ball's own touches change: without the keys, which expire, and the
	// time doors, which flip on the clock)
	const hash = (sim, full) => {
		let h = 0x3c6ef372;
		const w = (v) => { h = Math.imul(h ^ v, 0x5bd1e995); h ^= h >>> 13; };
		if (full) w(sim._keysMask);
		w((crown && sim._collide_crown ? 1 : 0) | (sim.low_gravity ? 2 : 0) | (sim.is_invulnerable ? 4 : 0) | (silver && sim._collide_silver_crown ? 8 : 0) |
			(sim.is_cursed ? 16 : 0) | (sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | (sim.has_levitation ? 256 : 0) |
			(full && L.hasTimeDoors && sim._timedoor_state ? 512 : 0));
		w(sim.max_jumps); w(sim.jump_boost); w(sim.speed_boost); w(sim.flip_gravity);
		if (team) w(sim.team);
		if (coins) w(sim.coins);
		if (L.hasCoinGate) w(sim._show_coin_gate);
		if (blue) w(sim.blue_coins);
		if (L.hasBlueCoinGate) w(sim._show_blue_coin_gate);
		if (L.hasDeathDoor) w(sim.deaths);
		if (L.hasDeathGate) w(sim._show_death_gate);
		if (sim._switches.size !== 0) w(onSum(sim._switches, 0x1234567));
		if (sim._oswitches.size !== 0) w(onSum(sim._oswitches, 0x7654321));
		return h | 0;
	};
	const key = (sim) => hash(sim, true);
	/** what a room change's cause is judged by: {sub (the key without keys and time doors), keys} */
	const cause = (sim) => ({ sub: hash(sim, false), keys: sim._keysMask });
	/** a change from a room of cause a to one of cause b came from a trigger the ball touched (a key picked up, an
	 *  effect, switch, coin, ...), not from the clock (a time door flipping, a key expiring) */
	const byTrigger = (a, b) => !a || !b || a.sub !== b.sub || (b.keys & ~a.keys) !== 0;
	const COL = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];
	const desc = (sim) => {
		const p = [];
		for (let c = 0; c < 6; c++) if (sim._keysMask & (1 << c)) p.push(`key:${COL[c]}`);
		if (sim.is_invulnerable) p.push('protection');
		if (sim.is_cursed) p.push('curse');
		if (sim.is_zombie) p.push('zombie');
		if (sim.is_on_fire) p.push('fire');
		if (sim.is_poisoned) p.push('poison');
		if (sim.has_levitation) p.push('fly');
		if (sim.low_gravity) p.push('lowgrav');
		if (sim.max_jumps !== 1) p.push(`jumps=${sim.max_jumps}`);
		if (sim.jump_boost) p.push(`jump=${sim.jump_boost}`);
		if (sim.speed_boost) p.push(`speed=${sim.speed_boost}`);
		if (sim.flip_gravity) p.push(`grav=${sim.flip_gravity}`);
		if (L.hasTimeDoors) p.push(sim._timedoor_state ? 'timedoors:open' : 'timedoors:shut');
		if (team && sim.team) p.push(`team=${sim.team}`);
		if (coins) p.push(`coins=${sim.coins}`);
		if (blue) p.push(`bluecoins=${sim.blue_coins}`);
		if (L.hasDeathDoor) p.push(`deaths=${sim.deaths}`);
		const s = onList(sim._switches), o = onList(sim._oswitches);
		if (s.length) p.push(`purple=[${s.join(',')}]`);
		if (o.length) p.push(`orange=[${o.join(',')}]`);
		if (crown && sim._collide_crown) p.push('crown');
		if (silver && sim._collide_silver_crown) p.push('silvercrown');
		return p.join(' ') || '(start)';
	};
	return { key, desc, cause, byTrigger };
}

/**
 * roomFields(L, budget) -> {enter(sim) -> {gain, troOk, cached}, stats()}: a room's fields, from the state that entered
 * it (its tile): the tiles the ball can walk to (8-way, portals, doors as they are now, spikes and other killing tiles
 * only with protection; one-ways and half blocks open, as src/reach.js), `troOk` whether a trophy is among them, and
 * `gain` how many no earlier room's walk reached (the territory the room opens). A walk depends only on the passable set
 * (the doors' states and protection) and the tile it starts from, so walks are cached by a hash of the passable set: a
 * room whose passable set and start component are known costs that hash and has no gain. Cached walks (a bitset each)
 * beyond `budget` bytes go, the least recently used first. One per worker (its own union).
 */
function roomFields(L, budget) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
	const wall = new Uint8Array(N), deadly = new Uint8Array(N), doors = [], trophies = [];
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) !== 0) doors.push(i);
		else if ((f & F_SOLID) !== 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0) wall[i] = 1;
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
		if (id === 121) trophies.push(i);
	}
	// portals: tile -> its exits' tiles
	const exits = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			const list = [];
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && !list.includes(j)) list.push(j); }
			if (list.length) exits.set(i, list);
		}
	}
	const union = new Uint8Array(N), shut = new Uint8Array(N), seen = new Int32Array(N), q = new Int32Array(N);
	const words = new Int32Array(((doors.length + 31) >> 5) + 1);
	const cache = new Map();   // passable-set hash -> [{bits, troOk, used}]
	let gen = 0, clock = 0, bytes = 0, walks = 0, hits = 0, ms = 0;
	// (a cached walk's bytes: its bitset, outside the V8 heap, and WALK_BYTES of objects, the typed array's and the
	// cache's)
	const WALK_BYTES = 300;
	const evict = () => {
		// (the least recently used walk; rare: a walk is added only for a new passable set or component)
		let bk = 0, bi = -1, bu = Infinity;
		for (const [k, list] of cache) for (let i = 0; i < list.length; i++) if (list[i].used < bu) { bu = list[i].used; bk = k; bi = i; }
		if (bi < 0) return false;
		const list = cache.get(bk);
		bytes -= list[bi].bits.length + WALK_BYTES;
		list.splice(bi, 1);
		if (!list.length) cache.delete(bk);
		return true;
	};
	const enter = (sim) => {
		const t0 = Date.now();
		const tile = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		const prot = !!sim.is_invulnerable;
		// the passable set's hash: protection and each door shut or open
		words.fill(0);
		words[words.length - 1] = prot ? 1 : 0;
		for (let k = 0; k < doors.length; k++) if (sim.is_tile_solid_now(doors[k] % W, (doors[k] / W) | 0)) words[k >> 5] |= 1 << (k & 31);
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < words.length; k++) {
			let x = Math.imul(words[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ words[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		const hk = (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
		const list = cache.get(hk);
		if (list) {
			for (const c of list) {
				if ((c.bits[tile >> 3] & (1 << (tile & 7))) === 0) continue;
				c.used = ++clock; hits++;
				ms += Date.now() - t0;
				return { gain: 0, troOk: c.troOk, cached: true };
			}
		}
		// the walk (8-way, no corner cut between two walls, through portals) from the room's tile
		for (let k = 0; k < doors.length; k++) if (words[k >> 5] & (1 << (k & 31))) shut[doors[k]] = 1;
		const pass = (i) => !wall[i] && !shut[i] && (prot || !deadly[i]);
		const g = ++gen;
		const bits = new Uint8Array((N + 7) >> 3);
		let qh = 0, qt = 0, gain = 0, troOk = false;
		seen[tile] = g; q[qt++] = tile;
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			bits[t >> 3] |= 1 << (t & 7);
			if (!union[t]) { union[t] = 1; gain++; }
			if (fg[t] === 121) troOk = true;
			const ex = exits.get(t);
			if (ex) for (const e of ex) if (seen[e] !== g && pass(e)) { seen[e] = g; q[qt++] = e; }
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const j = yy * W + xx;
					if (seen[j] === g || !pass(j)) continue;
					if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
					seen[j] = g; q[qt++] = j;
				}
			}
		}
		for (let k = 0; k < doors.length; k++) shut[doors[k]] = 0;
		walks++;
		const c = { bits, troOk, used: ++clock };
		if (list) list.push(c); else cache.set(hk, [c]);
		bytes += bits.length + WALK_BYTES;
		while (bytes > budget && evict()) { /* the least recently used first */ }
		ms += Date.now() - t0;
		return { gain, troOk, cached: false };
	};
	return { enter, trophies: trophies.length, bytes: () => bytes, stats: () => ({ walks, hits, walkMs: ms, walkBytes: bytes }) };
}

/**
 * lowerBoundTiles(L) -> Uint16Array (per tile, over a SharedArrayBuffer): a lower bound on the ticks from a ball whose
 * centre is in that tile to the trophy, whatever the effects and doors (the minimum over the physics): the box moves at
 * most 16.25 px along an axis in a tick (|speed| <= 16 after the clamp, the auto-align, rounding: endgame.js D_TICK), so
 * its centre's tile changes by at most 2 along each axis, and its 1 px steps pass a 4-connected chain of tiles that are
 * no permanent wall (a solid block that is no door, one-way or half block: the centre is never inside one); a portal
 * moves it for nothing. So ticks >= ceil(d / 4), d = the 4-connected steps to a tile next to a trophy (a half block's
 * touch) over every tile but the walls, every door open, portals as free moves (a 0-1 BFS from the trophies). 0xffff:
 * no trophy that way (a proof too, as the reach field's -1). A search state at tick t with t + max(1, bound) past the
 * longest route that still counts cannot give a faster route (a death's respawn is no move: the runs end at a death).
 */
function lowerBoundTiles(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	if (!fg.includes(121)) return null;   // (no trophy: no bound)
	const out = new Uint16Array(new SharedArrayBuffer(2 * N)).fill(0xffff);
	const wall = new Uint8Array(N);
	for (let i = 0; i < N; i++) { const id = fg[i], f = id >= 0 && id < fl.length ? fl[id] : 0; wall[i] = (f & 1) !== 0 && (f & 16) === 0 && (f & (2 | 4 | 8)) === 0 ? 1 : 0; }
	// the portals reversed: exit tile -> the portal tiles that lead there
	const into = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N) { let l = into.get(j); if (!l) into.set(j, l = []); l.push(i); } }
		}
	}
	// (a deque in one array: 0-cost moves to the front; a tile is put at most once per neighbour or portal that improves it)
	let nInto = 0;
	for (const l of into.values()) nInto += l.length;
	const d = new Int32Array(N).fill(-1), dq = new Int32Array(nInto + 6 * N + 16);
	let h = nInto + N + 8, t = h;
	const put = (j, v, front) => { if (d[j] >= 0 && d[j] <= v) return; d[j] = v; if (front) dq[--h] = j; else dq[t++] = j; };
	for (let i = 0; i < N; i++) {
		if (fg[i] !== 121) continue;
		const x = i % W, y = (i / W) | 0;
		put(i, 0, false);
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) put(yy * W + xx, 0, false); }
	}
	const done = new Uint8Array(N);
	while (h < t) {
		const i = dq[h++];
		if (done[i]) continue;
		done[i] = 1;
		const v = d[i];
		for (const p of into.get(i) || []) if (!done[p]) put(p, v, true);
		const x = i % W, y = (i / W) | 0;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
			const j = yy * W + xx;
			if (!wall[j] && !done[j]) put(j, v + 1, false);
		}
	}
	for (let i = 0; i < N; i++) if (d[i] >= 0) out[i] = Math.min(0xfffe, Math.ceil(d[i] / 4));
	return out;
}

/** the inputs of a path node {up, blk, o, n, refs} (those of `up`, then blk.b[o .. o + n); immutable: a cell that
 *  improves gets a new node) as masks */
function inputsOf(node) {
	const parts = [];
	let len = 0;
	for (let q = node; q !== null; q = q.up) { parts.push(q); len += q.n; }
	const out = new Uint8Array(len);
	let o = 0;
	for (let k = parts.length - 1; k >= 0; k--) { const q = parts[k]; out.set(q.blk.b.subarray(q.o, q.o + q.n), o); o += q.n; }
	return out;
}

/** a min-heap of (priority, cell, version) entries; prio(cell) at push. pop() returns the cell and sets popVer (the
 *  entry's version: stale when the cell's own has moved on); compact() drops the stale entries */
function heapOf(prio) {
	const hv = [], hc = [], hver = [];
	const H = { popVer: 0, size: () => hv.length };
	H.push = (c) => {
		let i = hv.length;
		const v = prio(c);
		hv.push(v); hc.push(c); hver.push(c.ver);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (hv[p] <= v) break;
			hv[i] = hv[p]; hc[i] = hc[p]; hver[i] = hver[p];
			i = p;
		}
		hv[i] = v; hc[i] = c; hver[i] = c.ver;
	};
	H.pop = () => {
		const c = hc[0];
		H.popVer = hver[0];
		const v = hv.pop(), lc = hc.pop(), lver = hver.pop();
		const n = hv.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === i) break;
				hv[i] = hv[m]; hc[i] = hc[m]; hver[i] = hver[m];
				i = m;
			}
			hv[i] = v; hc[i] = lc; hver[i] = lver;
		}
		return c;
	};
	H.compact = () => {
		let n = 0;
		for (let i = 0; i < hv.length; i++) if (hver[i] === hc[i].ver) { hv[n] = hv[i]; hc[n] = hc[i]; hver[n] = hver[i]; n++; }
		hv.length = n; hc.length = n; hver.length = n;
		for (let i = (n >> 1) - 1; i >= 0; i--) {
			const v = hv[i], c = hc[i], ver = hver[i];
			let j = i;
			for (;;) {
				const l = 2 * j + 1, r = l + 1;
				let m = j, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === j) break;
				hv[j] = hv[m]; hc[j] = hc[m]; hver[j] = hver[m];
				j = m;
			}
			hv[j] = v; hc[j] = c; hver[j] = ver;
		}
	};
	return H;
}
// a cell's steer cost when the steer field has no value for its state (behind every valued one; the research's 1e5)
const STEER_NONE = 1e5;
// a steer value's distance at most (tiles): below every "no value" distance (6000+) and the editor's "cut off" mark (1e4);
// real values reach 13,107 tiles (native/beam.h STEER_REAL_MAX)
const STEER_REAL_MAX = 5999;

/**
 * One explorer (a worker thread; a = the options, settled for the level, seed its seed). ctrl (Int32Array on a
 * SharedArrayBuffer): [0] the longest route that still counts (ticks), [1] stop. post(msg): to the main thread
 * ('finish', 'closest', 'source', 'stat', 'done').
 */
function explore(L, field, a, seed, ctrl, post, port, seedPort = null) {
	const W = L.width, H = L.height, N = W * H;
	const rnd = rngOf(seed);
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	// the runs' inputs: one of the 18 options (jump in half of them), or with --jumpP=p (the clean-routes policy) the
	// direction and up / down drawn as before and the jump bit with p, jumpNear where it can help: under down gravity on
	// the ground with a wall or no floor in the next column the way the new input goes (the wall's own row), else p
	const draw = !(a.jumpP > 0) ? () => OPTIONS[(rnd() * 18) | 0] : () => {
		const h = [0, 2, 4][(rnd() * 3) | 0], v = [0, 8, 16][(rnd() * 3) | 0];
		let p = a.jumpP;
		if (h !== 0 && sim.on_ground && sim.gravity_dir.x === 0 && sim.gravity_dir.y === 1) {
			const cx = Math.trunc(sim.px + 8) >> 4, cy = Math.trunc(sim.py + 8) >> 4, d = h === 4 ? 1 : -1;
			if (sim.is_tile_solid_now(cx + d, cy) || !sim.is_tile_solid_now(cx + d, cy + 1)) p = a.jumpNear;
		}
		return h | v | (rnd() < p ? 1 : 0);
	};
	const coarse = a.cells === 'coarse';
	const disc = coarse ? null : discreteOf(L);
	const res = new Uint8Array(N);   // the cell grain per tile (0 .. maxres)
	const t0 = Date.now(), tEnd = t0 + a.seconds * 1000;
	let maxT = Math.min(a.depth, Atomics.load(ctrl, 0));
	// the budget this worker's heap can hold: --mem, unless its heap limit is smaller than asked (a V8 flag set one for
	// the whole process; the main thread fits --mem to the flags it sees, this is the last word; 192: the largest young
	// generation, Node 24's)
	const limMB = V8.getHeapStatistics().heap_size_limit / 1048576;
	const mem = limMB < HEAP_F * a.mem + HEAP_ADD ? Math.max(16, Math.min(a.mem, heapFit(limMB - 192))) : a.mem;
	// coarse cells: the rooms (roomOf), each with its fields (roomFields: territory gain, trophy walkable), its cells
	// (head B samples them), its picks, its lowest-cost cell and how often it was a source; roomKey = the live state's
	const RM = coarse ? roomOf(L) : null;
	const fields = coarse ? roomFields(L, Math.max(1 << 20, Math.min(64 << 20, mem * 1048576 * 0.03))) : null;   // (its walk cache: 3%)
	const rooms = new Map(), roomList = [];
	let roomKey = 0, bursts = 0;
	// (the one search, coarse cells: every new room's first cell goes to the main thread with the room it came from and the
	// tile where it changed: the other workers' archives and the GPU operator's rooms; a room change between two known
	// rooms once per (room, tile): the trigger tried there)
	const report = coarse && !!port;
	const edges = report ? new Set() : null, clockEdges = report ? new Set() : null;
	// (--lb=1: the sound lower bound on the ticks to the trophy per tile, lowerBoundTiles; the states it cuts: lbCut)
	const LBT = a.lb && a.lbTiles ? a.lbTiles : null;
	let lbCut = 0;
	const centreTile = () => Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
	const newRoom = (key, t, parent) => {
		const f = fields.enter(sim);
		const cz = RM.cause(sim), pr = parent === undefined ? undefined : rooms.get(parent);
		const r = { key, desc: RM.desc(sim), t, gain: f.gain, troOk: f.troOk, picks: 0, arr: [], best: null, isNew: true, sent: 0, sentAt: null,
			parent: parent === undefined ? null : parent, tile: centreTile(), cause: cz, trig: pr ? RM.byTrigger(pr.cause, cz) : true };
		rooms.set(key, r);
		roomList.push(r);
		return r;
	};
	const TD = coarse && !!L.hasTimeDoors;
	// the cell key: two 32-bit hash lanes over the cell's numbers (53 bits; two cells collide with probability ~2^-53 per
	// pair, and a collision only merges two cells of this archive: every route is replayed exactly anyway)
	const KV = new Int32Array(10);
	let tile = 0;
	const cellKey = () => {
		const px = sim.px, py = sim.py;
		const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
		tile = Math.min(N - 1, Math.max(0, ty * W + tx));
		const r = res[tile];
		if (coarse) {
			// (tile, room, ground, the time-door phase in buckets of --phase ticks; no jump count or gravity queue)
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (TD ? (((sim.level_ticks() % E.TIMEDOOR_PERIOD) / a.phase) | 0) << 8 : 0); KV[2] = 0; KV[3] = 0; KV[4] = 0; KV[5] = roomKey;
		} else {
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (r << 1); KV[2] = sim.jump_count; KV[3] = sim._q0; KV[4] = sim._q1; KV[5] = disc(sim);
		}
		let n;
		if (r === 0) {
			const vy = sim.speed_y;
			KV[6] = Math.sign(sim.speed_x); KV[7] = vy < -3 ? 0 : vy < 0 ? 1 : vy === 0 ? 2 : 3;
			n = 8;
		} else {
			const qp = QP[r], qv = QV[r];
			KV[6] = Math.floor(px * qp); KV[7] = Math.floor(py * qp); KV[8] = Math.floor(sim.speed_x * qv); KV[9] = Math.floor(sim.speed_y * qv);
			n = 10;
		}
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < n; k++) {
			let x = Math.imul(KV[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ KV[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		return (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
	};
	// the archive and the heap of (priority, cell, version): a cell has one live entry (its version); others are stale
	const cells = new Map();
	const HA = heapOf((c) => c.rc + a.lambda * Math.sqrt(c.picks));
	// --steer: head A's second heap, on the steer field's cost (src/steer.js: gate-aware; computed for new and improved
	// cells only), picked --mix of head A's picks (the research's ngxAB.js); the reach field alone rules states out
	const ST = a.steerData || null;
	const HS = ST ? heapOf((c) => c.sc + a.lambda * Math.sqrt(c.picks)) : null;
	// head L (the one search once a route is known: the main thread's 'route' message): the lead. The best route's
	// schedule (sched: per (room, tile) the tick it first gets there); a cell at (room, tile) that the route passes gets
	// lead = its tick - the route's there (below 0: ahead of the best route, which finishes that much sooner from there if
	// the rest goes as well); head L picks the most ahead, less LEAD_PICK x sqrt(its picks), --pL of the picks: an
	// earlier arrival (a GPU burst's attempt, a lucky run) spreads down the route like A* with the best route's time to
	// go. Main's search after a route picked by the reach cost (the cells by the trophy) and novelty.
	// On time-door levels the schedule is per (room, tile, the doors' phase bucket: the cell key's, --phase ticks): a lead
	// then keeps the doors' phase (whole periods sooner, within a bucket), where by (room, tile) alone a cell "ahead" by a
	// part of a period meets the doors the route passed open shut (Stupid Fox: leads of 625 and 1,351 ticks, doomed).
	let sched = null;
	const TDL = coarse && !!L.hasTimeDoors, clock0 = sim.level_ticks(), NPH = Math.ceil(E.TIMEDOOR_PERIOD / a.phase);
	const phaseOf = (lt) => ((lt % E.TIMEDOOR_PERIOD) / a.phase) | 0;
	const leadHeap = () => heapOf((c) => c.lead + LEAD_PICK * Math.sqrt(c.picks));
	let HL = coarse && port ? leadHeap() : null;
	// head W (--pW; WAY_PICK): tsched = per tile (on time-door levels per tile and phase bucket: tile x NPH + bucket) the
	// route's first tick there in any room (ticks count from 1: 0 = never), as sched's; a cell head L has no lead for goes
	// to HW by it
	let tsched = null;
	const wayHeap = () => heapOf((c) => c.wlead + WAY_PICK * Math.sqrt(c.picks));
	let HW = coarse && port && a.pW > 0 ? wayHeap() : null;
	const lpush = (c) => {
		const v = sched.get(c.room.key * 2097152 + c.tile);
		const ph = TDL ? phaseOf(clock0 + c.t) : 0;
		if (v !== undefined) {
			const s = TDL ? v[ph] : v;
			if (s >= 0) { c.lead = c.t - s; HL.push(c); return; }
		}
		if (HW === null) return;
		const w = tsched[TDL ? c.tile * NPH + ph : c.tile];
		if (w === 0) return;
		c.wlead = c.t - w;
		HW.push(c);
	};
	// (head L's share now: see LEAD_GRACE_S; lastL: the first route's or head L's last faster route's time)
	let lastL = 0, lShare = 0, pickL = false;
	const leadShare = (now) => (sched === null || a.pL <= 0 ? 0 : a.pL * Math.max(LEAD_FLOOR, Math.pow(0.5, Math.max(0, (now - lastL) / 1000 - LEAD_GRACE_S) / LEAD_HALF_S)));
	const hpush = HS ? (c) => { HA.push(c); HS.push(c); if (sched !== null) lpush(c); } : (c) => { HA.push(c); if (sched !== null) lpush(c); };
	const compact = () => { HA.compact(); if (HS) HS.compact(); if (HL) HL.compact(); if (HW) HW.compact(); };
	/** the steer cost of the live state (tiles; STEER_NONE when it has no value) */
	const steerOf = () => { const v = SF.steerFifths(ST, sim); return v < 0 ? STEER_NONE : v / 5; };
	// (--steerDist: the closest attempt's and the sources' distances by the steer field, at most STEER_REAL_MAX; 6000 + the
	// reach field's cost where it has no value: native/beam.h steerTiles, steerMiss)
	const distBySteer = !!ST && a.steerDist !== 0;
	const distOf = (c) => (!distBySteer ? c.rc : c.sc < STEER_NONE ? Math.min(STEER_REAL_MAX, c.sc) : Math.min(9990, 6000 + c.rc));
	// Snapshots (about 1150 bytes each) only for picked cells, within the budget. A cell that was not picked yet (most
	// never are) is its parent cell (the one whose runs reached it; `gen` counts the parent's state changes) plus the
	// inputs of its run so far (its path node: blk.b[o ..+ n)): its first pick replays those from the parent's snapshot, or,
	// when that is gone (the budget, or the parent swept) or the parent's state changed, its whole path from the start. The
	// budget drops the snapshot picked least recently (a second chance for one picked since it last came up). Exact either
	// way: the same inputs from the same state give the same state.
	const startSnap = sim.snapshot();
	let nSnaps = 0, replays = 0, dropped = 0, qh = 0;
	let queue = [];
	// the memory budget (see the header): the archive's bytes as its structures change, the snapshots in what it leaves
	const budget = mem * 1048576, capA = ARCHIVE_SHARE * budget, BLK = B_BLOCK + a.rolls * a.roll;
	let nNodes = 0, nBlocks = 0, xBytes = 0;   // (xBytes: the imported runs' inputs past a pick's block of rolls x roll)
	const archiveBytes = () => cells.size * (ST ? B_CELL + B_SC : B_CELL) + (HA.size() + (HS ? HS.size() : 0) + (HL ? HL.size() : 0) + (HW ? HW.size() : 0)) * B_HEAPE + nNodes * B_NODE + nBlocks * BLK + xBytes +
		roomList.length * B_ROOM + (queue.length - qh) * B_QUEUE + (fields !== null ? fields.bytes() : 0);
	const memBytes = () => archiveBytes() + nSnaps * B_SNAP;
	/** room for a new cell: --maxCells and the archive's share (else the next sweep makes some) */
	const roomFor = () => (!a.maxCells || cells.size < a.maxCells) && archiveBytes() < capA;
	// path nodes {up, blk, o, n, refs} (a cell's path: up's, then blk.b[o .. o + n); blk: a pick's inputs {b, refs}). refs
	// counts what holds a node (its cell, the nodes made from it, the closest state): at 0 it is garbage, and so are the
	// pick's inputs with their last node, so nNodes and nBlocks are exactly the live ones (an improved cell's old node lives
	// on while nodes made from it do)
	const mkNode = (up, blk, o, n) => {
		if (up !== null) up.refs++;
		if (blk.refs++ === 0) { nBlocks++; if (blk.x) xBytes += blk.x; }
		nNodes++;
		return { up, blk, o, n, refs: 1 };
	};
	const release = (q) => {
		while (q !== null && --q.refs === 0) {
			nNodes--;
			if (--q.blk.refs === 0) { nBlocks--; if (q.blk.x) xBytes -= q.blk.x; }
			q = q.up;
		}
	};
	/** the snapshot queue without the entries of cells that hold none (and without repeats) */
	const compactQueue = () => {
		const inQ = new Set(), q2 = [];
		for (let i = qh; i < queue.length; i++) { const d = queue[i]; if (d.snap !== null && !inQ.has(d)) { inQ.add(d); q2.push(d); } }
		queue = q2; qh = 0;
	};
	/** cell c keeps snapshot s (c has none now). Room is made first, so the new one is never the one dropped: c's runs
	 *  start from it right after (c's older entries in the queue see no snapshot while the budget is enforced). */
	const keepSnap = (c, s) => {
		let lim = Math.floor((SNAP_TOP * budget - archiveBytes()) / B_SNAP);
		if (a.maxSnaps && a.maxSnaps < lim) lim = a.maxSnaps;
		if (lim < MIN_SNAPS) lim = MIN_SNAPS;
		while (nSnaps >= lim && qh < queue.length) {
			const d = queue[qh++];
			if (d.snap === null) continue;
			if (d.used) { d.used = false; queue.push(d); continue; }
			d.snap = null; nSnaps--; dropped++;
		}
		c.snap = s; c.used = true; nSnaps++;
		queue.push(c);
		if (qh > 65536 && qh * 2 > queue.length) { queue = queue.slice(qh); qh = 0; }
		else if (queue.length - qh > 2 * nSnaps + 4096) compactQueue();
	};
	let deepest = 0, full = false, impr = 0, needSweep = false, sweeps = 0, evicted = 0, picks = 0, sweptAt = -1e9;
	/** the live state (tick t, reach cost rc; reached from cell pc's state by the inputs blk.b[o ..+ n) after path node up;
	 *  coarse cells: in room) into the archive; returns the cell when it is new */
	const add = (t, rc, pc, up, blk, o, n, room) => {
		if (t >= maxT) return null;   // (a route from there would not be faster)
		// (nor from a state whose sound lower bound to the trophy ends past it: lowerBoundTiles)
		if (LBT !== null && t + Math.max(1, LBT[centreTile()]) > maxT) { lbCut++; return null; }
		const k = cellKey();
		const c = cells.get(k);
		if (c !== undefined) {
			c.seen++; c.touch = picks;
			if (c.t <= t) return null;
			if (c.snap !== null) { c.snap = null; nSnaps--; }
			const old = c.node;
			c.t = t; c.pc = pc; c.pgen = pc !== null ? pc.gen : 0; c.node = mkNode(up, blk, o, n); c.rc = rc; c.gen++; c.ver++; c.viaL = pickL || (pc !== null && pc.viaL);
			release(old);
			impr++;
			if (ST) { c.sc = steerOf(); nearSteer(c); }
			hpush(c);
			if (room !== null && (room.best === null || distOf(c) < distOf(room.best))) room.best = c;
			return null;
		}
		if (!roomFor()) { full = true; needSweep = true; return null; }
		// (--steer: the cell's steer cost too, B_SC more; without --steer the cell has no such property)
		// (viaL: the cell descends from a head-L pick's runs, its share's yield: a route head L's earlier arrivals led to is
		// often finished by head A's pick of a cell by the trophy)
		const vl = pickL || (pc !== null && pc.viaL);
		const nc = ST ? { t, snap: null, pc, pgen: pc !== null ? pc.gen : 0, node: mkNode(up, blk, o, n), rc, sc: steerOf(), picks: 0, seen: 1, tile, room, ver: 0, gen: 0, used: false, touch: picks, viaL: vl }
			: { t, snap: null, pc, pgen: pc !== null ? pc.gen : 0, node: mkNode(up, blk, o, n), rc, picks: 0, seen: 1, tile, room, ver: 0, gen: 0, used: false, touch: picks, viaL: vl };
		if (ST) nearSteer(nc);
		cells.set(k, nc);
		hpush(nc);
		if (t > deepest) deepest = t;
		if (room !== null) {
			room.arr.push(nc);
			if (room.best === null || distOf(nc) < distOf(room.best)) room.best = nc;
		}
		return nc;
	};
	/** --steerDist: the closest state by the steer field, among new and improved cells (the steer cost is computed only
	 *  for those) */
	const nearSteer = (c) => {
		if (!distBySteer) return;
		const d = distOf(c);
		if (!near || d < near.rc - 1e-3 || (d <= near.rc + 1e-3 && c.t < near.t)) {
			c.node.refs++;   // (the closest state holds its node too: see mkNode)
			if (near !== null) release(near.node);
			near = { rc: d, t: c.t, node: c.node };
		}
	};
	let end = '';
	/** the reach cost of the live state (tiles); -1 = ruled out. With --prune=0 (the editor's check of a level the reach
	 *  field rules out) nothing is ruled out: a ruled-out state costs 1e4 + its walking distance (behind the others) */
	const costOf = () => {
		const rc = RF.costAt(field, sim);
		if (rc >= 0 || a.prune) return rc;
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		const w = tx >= 0 && ty >= 0 && tx < field.W && ty < field.H ? field.walk[ty * field.W + tx] : RF.CUT;
		return 1e4 + (w === RF.CUT ? 9999 : w / 5);
	};
	let room0 = null, cell0 = null, preMs = null;
	{
		// the start (the reach field rules it out: no route, a proof; the search ends at once, unless --prune=0); with
		// --prefix the state after those inputs, a cell whose path is them (replays go on from the level's start)
		const pre = prefixOf(a), t0c = pre ? pre.length : 0;
		preMs = pre;
		if (pre) for (let s = 0; s < pre.length; s++) { E.applyMask(inp, pre[s]); sim.tick(inp); }
		const rc = costOf();
		if (coarse) { roomKey = RM.key(sim); room0 = newRoom(roomKey, t0c); room0.isNew = false; }
		const k = cellKey();
		const node0 = pre ? mkNode(null, { b: pre, refs: 0, x: Math.max(0, pre.length - a.rolls * a.roll) }, 0, pre.length) : null;
		const c = ST ? { t: t0c, snap: null, pc: null, pgen: 0, node: node0, rc, sc: steerOf(), picks: 0, seen: 1, tile, room: room0, ver: 0, gen: 0, used: false, touch: 0 }
			: { t: t0c, snap: null, pc: null, pgen: 0, node: node0, rc, picks: 0, seen: 1, tile, room: room0, ver: 0, gen: 0, used: false, touch: 0 };
		cells.set(k, c);
		cell0 = c;
		hpush(c);
		if (room0 !== null) { room0.arr.push(c); room0.best = c; }
		keepSnap(c, pre ? sim.snapshot() : startSnap);
		if (rc < 0) end = 'unreachable';
	}
	let ticks = 0, lastProgress = 0, refined = 0, minRc = Infinity, imports = 0, importAdded = 0, seeded = 0, seedCells = 0;
	let first = null, best = null;   // routes: {t, sec, simTicks}
	let near = null, nearSent = null, lastSent = 0, lastStat = 0;   // the closest state: {rc, t, node}
	// (memMB: the budget's count; heapMB: the V8 heap in use, garbage included)
	const stat = () => Object.assign({ type: 'stat', seed, ticks, cells: cells.size, picks, deepest, seeded, seedCells, lbCut, leadPicks, wayPicks, leadRoutes, leadShare: Math.round(lShare * 1000) / 1000, minRc: Number.isFinite(minRc) ? minRc : null, refined, full,
		snaps: nSnaps, dropped, replays, impr, evicted, sweeps, nodes: nNodes, budgetMB: mem, memMB: Math.round(memBytes() / 1048576),
		heapMB: Math.round(V8.getHeapStatistics().used_heap_size / 1048576) },
	coarse ? Object.assign({ rooms: roomList.length, bursts, imports, importAdded }, fields.stats()) : {});
	const sendNear = () => {
		if (!near || near === nearSent) return;
		nearSent = near;
		post({ type: 'closest', seed, rc: near.rc, t: near.t, inputs: C.eetasBytes(inputsOf(near.node)).toString('latin1') });
	};
	// sources (coarse cells): starting points for the editor's relay (see the header). A room without territory gain is a
	// "room" source at most once per SOURCE_S (on a level of many switches most rooms open nothing)
	let lastBlandSource = -1e9, lastSources = t0;
	const source = (kind, r, c) => {
		r.sent++; r.sentAt = c;
		post({ type: 'source', seed, kind, room: r.key, desc: r.desc, gain: r.gain, t: c.t, rc: distOf(c), inputs: C.eetasBytes(inputsOf(c.node)).toString('latin1') });
	};
	/** every SOURCE_S s: the lowest-cost cell of the 4 rooms with the most territory gain and the fewest sources so far
	 *  (by (1 + ln(1 + gain)) / (1 + sources)), when it is not the one already sent */
	const bestSources = () => {
		const cand = [];
		for (const r of roomList) if (r.best !== null && r.best.node !== null && r.best.t >= SOURCE_MIN_TICKS && r.best !== r.sentAt) cand.push(r);
		cand.sort((x, y) => (1 + Math.log(1 + y.gain)) / (1 + y.sent) - (1 + Math.log(1 + x.gain)) / (1 + x.sent) || x.t - y.t);
		for (let k = 0; k < 4 && k < cand.length; k++) source('best', cand[k], cand[k].best);
	};
	// the picks: head A, the lowest priority whose entry is live and whose state is early enough (with --steer from the
	// steer field's heap --mix of the time)
	const popA = () => {
		const H = HS !== null && rnd() < a.mix ? HS : HA;
		while (H.size() > 0) {
			const c = H.pop();
			if (H.popVer !== c.ver || c.t >= maxT) continue;
			return c;
		}
		return null;
	};
	// head B (novelty; coarse cells): a room by a tournament of 4 (territory gain, the trophy walkable, few picks), then
	// the best of --sample random cells of it by Go-Explore's count weights (cells runs rarely come through first)
	const popB = () => {
		let br = null, bw = -1;
		for (let k = 0; k < 4; k++) {
			const r = roomList[(rnd() * roomList.length) | 0];
			if (!r.arr.length) continue;
			const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50);
			if (w > bw) { bw = w; br = r; }
		}
		if (br === null) return popA();
		const arr = br.arr;
		let bc = null, bs = -1;
		for (let k = 0; k < a.sample; k++) {
			const c = arr[(rnd() * arr.length) | 0];
			if (c.t >= maxT) continue;
			const sc = 1 / Math.sqrt(1 + c.seen) + 1 / Math.sqrt(1 + c.picks);
			if (sc > bs) { bs = sc; bc = c; }
		}
		return bc || popA();
	};
	const discovery = [];   // head C (coarse cells): [cell, picks left], the newest room's last
	/**
	 * The sweep (between two chunks, when the archive is past its share of the budget or --maxCells): the cells no run or
	 * pick has touched for longest go (a cell's `touch`: the pick count when a run last came through it or it was picked),
	 * down to EVICT_TO of the share, so the archive keeps growing where the search is; never the start, a room's
	 * lowest-cost cell or a discovery burst's cell. A cell swept takes its snapshot and its hold on its path node along
	 * (the node lives on while other paths use it); a room left without cells goes too (made again, with no territory
	 * gain, when a run enters it again); a cell whose parent was swept replays its whole path at its first pick. A cell a
	 * run reaches again is a new one.
	 */
	const sweep = () => {
		needSweep = false;
		sweeps++;
		sweptAt = picks;
		const HB = 1024, hist = new Int32Array(HB), span = picks + 1;
		const guard = new Set(discovery.map((d) => d[0]));
		const keep = (c) => c === cell0 || c.t === 0 || guard.has(c) || (c.room !== null && c.room.best === c);
		for (let pass = 0; pass < 3; pass++) {
			const A = archiveBytes();
			const overN = a.maxCells ? cells.size - Math.floor(EVICT_TO * a.maxCells) : 0;
			const want = Math.max(overN, Math.ceil(cells.size * (A - EVICT_TO * capA) / A));
			if (want <= 0) break;
			// the cut: the oldest touches first (a histogram of them), in the archive's order within the last bucket
			hist.fill(0);
			for (const c of cells.values()) if (!keep(c)) hist[Math.floor(c.touch * HB / span)]++;
			let cut = 0, below = 0;
			while (cut < HB && below + hist[cut] <= want) below += hist[cut++];
			let extra = want - below, gone = 0;
			for (const [k, c] of cells) {
				if (keep(c)) continue;
				const b = Math.floor(c.touch * HB / span);
				if (b > cut || (b === cut && extra-- <= 0)) continue;
				cells.delete(k);
				if (c.snap !== null) { c.snap = null; nSnaps--; }
				release(c.node);
				c.node = null; c.pc = null; c.ver = -1;   // (ver -1: gone; its heap entries are stale)
				gone++;
			}
			if (!gone) break;
			evicted += gone;
			// what referred to the swept cells: the rooms' lists (and rooms left empty), parents, the heap, the queue
			if (coarse) {
				let n = 0;
				for (const r of roomList) {
					r.arr = r.arr.filter((c) => c.ver >= 0);
					if (r.sentAt !== null && r.sentAt.ver < 0) r.sentAt = null;
					if (r.arr.length || r === room0) roomList[n++] = r;
					else rooms.delete(r.key);
				}
				roomList.length = n;
			}
			for (const c of cells.values()) if (c.pc !== null && c.pc.ver < 0) c.pc = null;
			compact();
			compactQueue();
		}
	};
	/** a new room's first cell nc (tick t): head C's burst and a source, if it opens new territory; the one search: the
	 *  room to the main thread */
	const firstCell = (room, nc, t) => {
		room.isNew = false;
		if (room.gain > 0) { if (a.burst > 0) { discovery.push([nc, a.burst]); bursts++; } }
		if ((room.gain > 0 || Date.now() - lastBlandSource >= SOURCE_S * 1000) && t >= SOURCE_MIN_TICKS) {
			if (room.gain <= 0) lastBlandSource = Date.now();
			source('room', room, nc);
		}
		if (report) {
			post({ type: 'room', seed, room: room.key, desc: room.desc, gain: room.gain, troOk: room.troOk, parent: room.parent, tile: room.tile, t, trig: room.trig,
				sub: room.cause.sub, keys: room.cause.keys, wt: ticks, inputs: C.eetasBytes(inputsOf(nc.node)).toString('latin1') });
		}
	};
	/** a room change from one known room to another at the live state's tile: once per (room, tile), the trigger tried */
	const edge = (from, to) => {
		// (the ones the clock made, a time door or a key's end, apart: they only tell where the room was entered, and must
		// not hide a trigger's change at the same tile)
		const trig = RM.byTrigger(from.cause, to.cause), set = trig ? edges : clockEdges;
		const tl = centreTile(), k = from.key * 4194304 + tl;   // (a number: tiles < 2^22)
		if (set.has(k) || set.size >= 200000) return;
		set.add(k);
		post({ type: 'edge', seed, from: from.key, to: to.key, tile: tl, trig });
	};
	/** the one search: another operator's run (another worker's new room, the GPU's attempt) into this archive, every state
	 *  along it (a cell is kept as always: the earliest state per cell; rooms made as in the runs) */
	const importRun = (str) => {
		const buf = new Uint8Array(str.length);
		for (let k = 0; k < str.length; k++) buf[k] = (str.charCodeAt(k) - 48) & 31;
		// (--prefix: only a run through the start state counts, and only its part after it: the route's own states before
		// it are no find of this search)
		const P = preMs !== null ? preMs.length : 0;
		if (P) { if (buf.length <= P) return; for (let k = 0; k < P; k++) if (buf[k] !== preMs[k]) return; }
		// (one block of inputs for the whole run: its bytes past a pick's block counted as `x`, see mkNode)
		const blk = { b: buf, refs: 0, x: Math.max(0, buf.length - a.rolls * a.roll) };
		sim.restore(startSnap);
		let room = room0, added = 0;
		for (let s = 0; s < buf.length; s++) {
			const t = s + 1;
			if (t >= maxT) break;
			E.applyMask(inp, buf[s]);
			sim.tick(inp);
			ticks++;
			if (sim.has_silver_crown || sim.is_dead) break;   // (a route is the main thread's: it replays every one)
			if (t <= P) { if (t === P) room = room0; continue; }
			const rc = costOf();
			if (rc < 0) break;
			roomKey = RM.key(sim);
			if (roomKey !== room.key) {
				const r = rooms.get(roomKey);
				if (r !== undefined) room = r;
				else if (roomFor()) room = newRoom(roomKey, t, room.key);
				else { full = true; needSweep = true; break; }
			}
			if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
			if (!distBySteer && (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t))) {
				const node = mkNode(null, blk, 0, t);
				if (near !== null) release(near.node);
				near = { rc, t, node };
			}
			const nc = add(t, rc, null, null, blk, 0, t, room);
			if (nc !== null) { added++; if (room.isNew) firstCell(room, nc, t); }
		}
		imports++; importAdded += added;
	};
	/** the one search: this archive's cell of a room nearest a set of targets (m.field: fifths per tile, 0xffff = none),
	 *  the earliest among equals, to the main thread (a GPU burst starts there) */
	const nearestOf = (m) => {
		const r = rooms.get(m.room), f = m.field;
		let best = null, bv = 0xffff;
		if (r !== undefined) {
			for (const c of r.arr) {
				if (c.t >= maxT) continue;
				const v = f[c.tile];
				if (v === 0xffff) continue;
				if (best === null || v < bv || (v === bv && c.t < best.t)) { best = c; bv = v; }
			}
		}
		port.postMessage({ type: 'nearest', id: m.id, seed, v: best !== null ? bv : -1, t: best !== null ? best.t : 0, tile: best !== null ? best.tile : -1, cells: r !== undefined ? r.arr.length : 0,
			inputs: best !== null ? C.eetasBytes(inputsOf(best.node)).toString('latin1') : '' });
	};
	/** the best route (the main thread's 'route': any operator's, or the editor's): head L's schedule, and every cell on it
	 *  into head L (a separate engine: the live state belongs to the picks) */
	let leadPicks = 0, leadRoutes = 0, wayPicks = 0;
	const setRoute = (str, byL) => {
		const ms = Uint8Array.from(str, (ch) => (ch.charCodeAt(0) - 48) & 31);
		const s2 = new E.EESim(L), in2 = new E.EEInput(), m = new Map();
		// (head W's key-blind schedule: tm)
		const tm = HW !== null ? new Int32Array(TDL ? N * NPH : N) : null;
		s2.reset();
		for (let k = 0; k < ms.length; k++) {
			E.applyMask(in2, ms[k]);
			s2.tick(in2);
			const tl = Math.min(N - 1, Math.max(0, (Math.trunc(s2.py + 8) >> 4) * W + (Math.trunc(s2.px + 8) >> 4)));
			const key = RM.key(s2) * 2097152 + tl;
			if (TDL) {
				let v = m.get(key);
				if (v === undefined) m.set(key, v = new Int32Array(NPH).fill(-1));
				const ph = phaseOf(s2.level_ticks());
				if (v[ph] < 0) v[ph] = k + 1;
				if (tm !== null && tm[tl * NPH + ph] === 0) tm[tl * NPH + ph] = k + 1;
			} else {
				if (!m.has(key)) m.set(key, k + 1);
				if (tm !== null && tm[tl] === 0) tm[tl] = k + 1;
			}
		}
		if (sched === null || byL) lastL = Date.now();
		if (byL) leadRoutes++;
		sched = m;
		tsched = tm;
		HL = leadHeap();
		if (HW !== null) HW = wayHeap();
		for (const c of cells.values()) lpush(c);
	};
	/** the main thread's messages (between two chunks of picks) */
	const inbox = () => {
		let m;
		while ((m = receiveMessageOnPort(port)) !== undefined) {
			const x = m.message;
			if (x.type === 'import' && coarse) importRun(x.inputs);
			else if (x.type === 'nearest') nearestOf(x);
			else if (x.type === 'route' && HL !== null) setRoute(x.inputs, !!x.byL);
		}
	};
	/** a seed (stdin "seed <inputs>": the editor's wall breaker's attempts): its states every SEED_EVERY ticks back from
	 *  its end, and the end, become cells whose path is the seed's inputs (children of the start: their first pick replays
	 *  them), in the rooms it passes (made like a run's; a new room's first cell gets head C's burst and is a source);
	 *  a state the reach field rules out, a death or a state too late for a faster route ends it */
	const addSeed = (str) => {
		const ms = Uint8Array.from(str, (ch) => (ch.charCodeAt(0) - 48) & 31);
		if (!ms.length || cell0 === null) return;
		seeded++;
		// (its inputs past a pick's block counted in the budget: xBytes, as an imported run's)
		const blk = { b: ms, refs: 0, x: Math.max(0, ms.length - a.rolls * a.roll) };
		sim.restore(startSnap);
		let room = room0;
		for (let s = 0; s < ms.length; s++) {
			E.applyMask(inp, ms[s]);
			sim.tick(inp);
			ticks++;
			const t = s + 1;
			if (t >= maxT || sim.is_dead || sim.has_silver_crown) break;
			let into = true;
			if (coarse) {
				roomKey = RM.key(sim);
				if (roomKey !== room.key) {
					const r = rooms.get(roomKey);
					if (r !== undefined) room = r;
					else if (roomFor()) room = newRoom(roomKey, t, room.key);
					else { into = false; full = true; needSweep = true; }
				}
			}
			if ((ms.length - t) % SEED_EVERY !== 0 || !into) continue;
			const rc = costOf();
			if (rc < 0) break;
			const nc = add(t, rc, cell0, null, blk, 0, t, coarse ? room : null);
			if (nc === null) continue;
			seedCells++;
			if (room !== null && room.isNew) firstCell(room, nc, t);
		}
	};
	while (!end) {
		// between chunks: the clock, the stop flag, the shared bound (a faster route from another worker or the editor)
		const now = Date.now();
		if (Atomics.load(ctrl, 1) !== 0) { end = 'stopped'; break; }
		if (now >= tEnd) { end = 'time'; break; }
		maxT = Math.min(maxT, Atomics.load(ctrl, 0));
		// (at most every SWEEP_GAP picks: a sweep that could not get under the share, all protected, is not redone at once)
		if ((needSweep || archiveBytes() > capA) && picks - sweptAt >= SWEEP_GAP) sweep();
		if (now - lastStat >= 250) { lastStat = now; post(stat()); }
		if (now - lastSent >= 250) { lastSent = now; sendNear(); }
		if (coarse && now - lastSources >= SOURCE_S * 1000) { lastSources = now; bestSources(); }
		if (port) inbox();
		if (seedPort) for (let m = receiveMessageOnPort(seedPort); m !== undefined && !end; m = receiveMessageOnPort(seedPort)) addSeed(String(m.message));
		lShare = leadShare(now);
		for (let k = 0; k < CHUNK && !end; k++) {
			let e = null;
			pickL = false;
			if (!coarse) e = popA();
			else if (discovery.length && rnd() < 0.5) {
				// head C: a new room's first cell, --burst times
				const d = discovery[discovery.length - 1];
				e = d[0];
				if (--d[1] <= 0) discovery.pop();
				if (e.t >= maxT) continue;
			} else if (lShare > 0 && rnd() < lShare) {
				// head L (a route known): the cell most ahead of the best route (none: heads A / B as without it)
				while (HL.size() > 0) { const c = HL.pop(); if (HL.popVer !== c.ver || c.t >= maxT) continue; e = c; break; }
				if (e === null) e = rnd() < a.pA ? popA() : popB();
				else { leadPicks++; pickL = true; }
			} else if (HW !== null && sched !== null && rnd() < a.pW) {
				// head W (a route known): the off-schedule cell most ahead of the route by its tile alone (none: heads A / B);
				// its routes count as head L's yield (viaL: head L's grace starts over on the new route's schedule)
				while (HW.size() > 0) { const c = HW.pop(); if (HW.popVer !== c.ver || c.t >= maxT) continue; e = c; break; }
				if (e === null) e = rnd() < a.pA ? popA() : popB();
				else { wayPicks++; pickL = true; }
			} else if (rnd() < a.pA) e = popA();
			else e = popB();
			if (e === null) { end = 'exhausted'; break; }
			e.picks++; e.ver++; picks++; e.touch = picks;
			if (coarse) e.room.picks++;
			hpush(e);
			if (e.snap === null) {
				// its state: its run's inputs from its parent's snapshot, else its whole path from the start
				const q = e.node, p = e.pc;
				if (p !== null && p.snap !== null && p.gen === e.pgen) {
					sim.restore(p.snap);
					for (let s = 0; s < q.n; s++) { E.applyMask(inp, q.blk.b[q.o + s]); sim.tick(inp); }
					ticks += q.n;
				} else {
					const ms = inputsOf(q);
					sim.restore(startSnap);
					for (let s = 0; s < ms.length; s++) { E.applyMask(inp, ms[s]); sim.tick(inp); }
					ticks += ms.length;
					replays++;
				}
				keepSnap(e, sim.snapshot());
				e.pc = null;
			}
			e.used = true;
			if (HA.size() > 3 * cells.size + 4096 || (HL !== null && HL.size() > 3 * cells.size + 4096) || (HW !== null && HW.size() > 3 * cells.size + 4096)) compact();
			// stuck: finer cells around here
			if (picks - lastProgress > a.stall && e.picks % a.refine === 0) {
				lastProgress = picks;
				const tx = e.tile % W, ty = (e.tile / W) | 0, r0 = res[e.tile];
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const x = tx + dx, y = ty + dy;
						if (x < 0 || y < 0 || x >= W || y >= H) continue;
						const j = y * W + x;
						if (res[j] < a.maxres && res[j] <= r0) { res[j]++; refined++; }
					}
				}
			}
			// the pick's runs: one input buffer for all of them (run r at r x roll)
			const blk = { b: new Uint8Array(a.rolls * a.roll), refs: 0 }, buf = blk.b, base = e.snap, up = e.node;
			for (let r = 0; r < a.rolls; r++) {
				sim.restore(base);
				const o = r * a.roll;
				let m = draw();
				let room = e.room;
				for (let s = 0; s < a.roll; s++) {
					const t = e.t + s + 1;
					if (t > maxT) break;
					if (rnd() >= a.keep) m = draw();
					buf[o + s] = m;
					E.applyMask(inp, m);
					sim.tick(inp);
					ticks++;
					if (sim.has_silver_crown) {
						// a route of t ticks: from now on only faster ones
						maxT = t - 1;
						const sec = (Date.now() - t0) / 1000;
						const f = { t, sec, simTicks: ticks };
						if (!first) first = f;
						best = f;
						post({ type: 'finish', seed, t, sec, simTicks: ticks, byL: pickL || e.viaL, inputs: C.eetasBytes(inputsOf({ up, blk, o, n: s + 1 })).toString('latin1') });
						if (a.first) end = 'finish';
						break;
					}
					if (sim.is_dead) break;
					const rc = costOf();
					if (rc < 0) break;   // the reach field rules it out: no route from here
					// (coarse cells: the live state's room; a new one is made (its fields walked from this state) only when its
					// first cell can enter the archive: a full archive or a state too late for a faster route would leave an
					// empty room, and walks for nothing, outside the memory budget)
					let into = true;
					if (coarse) {
						roomKey = RM.key(sim);
						if (roomKey !== room.key) {
							const r = rooms.get(roomKey);
							if (r !== undefined) { if (report) edge(room, r); room = r; }
							else if (t < maxT && roomFor()) room = newRoom(roomKey, t, room.key);
							else { into = false; if (t < maxT) { full = true; needSweep = true; } }
						}
					}
					if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
					if (!distBySteer && (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t))) {
						const node = mkNode(up, blk, o, s + 1);
						if (near !== null) release(near.node);
						near = { rc, t, node };
					}
					const nc = into ? add(t, rc, e, up, blk, o, s + 1, room) : null;
					if (nc !== null && room !== null && room.isNew) firstCell(room, nc, t);
				}
				if (end) break;
			}
			if (a.maxTicks && ticks >= a.maxTicks && !end) end = 'ticks';
		}
		pickL = false;
	}
	sendNear();
	E.flushTicks();
	if (typeof global.gc === 'function') global.gc();   // (node --expose-gc: the done event's heapMB is what the heap holds)
	post(Object.assign(stat(), { type: 'done', end, first, best, sec: (Date.now() - t0) / 1000 }));
}

// ---------------------------------------------------------------- random runs on the GPU (--gpu=1)
/** goexplore.js fmix as an unsigned number */
const fmixU = (h) => fmix(h) >>> 0;
/** a GPU run's seed (native/explore.h rollSeed): (batch seed, pick index, run) */
const rollSeed = (bs, pick, run) => fmixU((bs ^ fmixU(Math.imul(pick, 0x9e3779b1) ^ fmixU(run + 0x7f4a7c15))) >>> 0);
/** a GPU run's first n inputs (native/explore.h rollDraw: the first input drawn, then each tick kept with p keep),
 *  written into out at o */
function rollInputs(seed, n, keep, out, o) {
	const rnd = rngOf(seed);
	let m = OPTIONS[(rnd() * 18) | 0];
	for (let k = 0; k < n; k++) {
		if (rnd() >= keep) m = OPTIONS[(rnd() * 18) | 0];
		out[o + k] = m;
	}
}

/**
 * The Go-Explore of explore() with coarse cells, its runs on the GPU (`eegpu roll`, native/rollhost.h): this process
 * keeps the archive (per cell: its tick, reach cost, picks, room, path node; the rooms with their fields; heads A, B, C
 * exactly as explore() picks, --batch picks at a time), the GPU keeps a state per cell and plays the picks' runs (R x
 * roll ticks each, explore()'s inputs from seeds the host can replay), dedupes every state into the cell table and
 * reports the cells reached first or sooner. A path node is (its parent's node, the run's seed, its length): the inputs
 * of a cell are rebuilt from the seeds. Every route is replayed in the exact JS engine (C.evaluate) before it counts.
 */
async function gpuMain(a, L, m) {
	const { spawn } = require('child_process');
	const G = require('./gpu.js');
	const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
	const t0 = Date.now();
	a.cells = 'coarse';
	const field = RF.reachField(L);
	const sim = new E.EESim(L);
	sim.reset();
	const inp = new E.EEInput();
	const startSnap = sim.snapshot();
	const startCost = RF.costAt(field, sim);
	// the tool, the level blob and the reach file (the editor passes its own; else written next to --out or in the
	// system's temp folder)
	const tool = a.tool || G.nativeTool();
	if (!tool) { say({ error: 'no native tool (node tools/build-native.js)' }); process.exitCode = 3; return; }
	const unsup = G.unsupported(L);
	if (unsup) { say({ error: `the GPU engine cannot run this level: ${unsup}` }); process.exitCode = 3; return; }
	let tmp = '';
	const tmpFile = (name) => { if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goexplore-gpu-')); return path.join(tmp, name); };
	let bin = a.bin;
	if (!bin) { bin = tmpFile('level.bin'); fs.writeFileSync(bin, G.levelBlob(L)); }
	let reachFile = a.reach;
	if (!reachFile) { reachFile = tmpFile('reach.bin'); fs.writeFileSync(reachFile, RF.reachFileBytes(field, G.blobFp(fs.readFileSync(bin)))); }
	const cleanup = () => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* in use */ } } };
	// (the cells' states are kept in host memory: an eighth of the machine's (a container's limit where it has one), at
	// most half of the free memory and what the other searches leave (the registry: this one's claim refreshed every 60 s,
	// removed at the end); the GPU keeps the cell table, ~70 bytes a cell)
	const hmem = a.hmem > 0 ? a.hmem : rollHostMB(m);
	registryClaim(hmem * 1048576);
	process.on('exit', () => registryClaim(0));
	const claimTimer = setInterval(() => registryClaim(hmem * 1048576), 60000);
	if (claimTimer.unref) claimTimer.unref();
	const args = ['roll', bin, `--rolls=${a.rolls}`, `--roll=${Math.min(255, a.roll)}`, `--keep=${a.keep}`, `--phase=${a.phase}`, `--prune=${a.prune ? 1 : 0}`,
		...(reachFile ? [`--reach=${reachFile}`] : []), ...(a.gmem ? [`--mem=${a.gmem}`] : []), `--hostmem=${hmem}`, `--maxPicks=${Math.max(a.batch, 1)}`,
		...['stopfile', 'pausefile', 'cachedir', 'launch-ms'].filter((k) => a[k]).map((k) => `--${k}=${a[k]}`), `--parent=${process.pid}`];
	const ch = spawn(tool, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
	// (this process picks every batch while the GPU waits: above normal priority like eegpu's own, next to the CPU search's
	// busy workers; EEGPU_PRIORITY=normal: off; where it is not allowed (Linux without CAP_SYS_NICE) it stays as it is)
	if (process.env.EEGPU_PRIORITY !== 'normal') { try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { /* not allowed */ } }
	let err = '';
	ch.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
	ch.stdin.on('error', () => { /* it ended */ });
	// the tool's output: JSON lines, a line with "bytes" followed by that many bytes
	// (a payload's chunks are joined once it is all there: joining each 64 KB chunk to what came before took 300 ms for the
	// 12 MB seen counts of Stupid Fox's 3 M cells, a third of the search's time)
	let buf = Buffer.alloc(0), want = null, waiter = null, toolDone = null, toolErr = null, exited = false, parts = [], have = 0;
	const queue = [];
	const deliver = (m) => { if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m); };
	const next = () => (queue.length ? Promise.resolve(queue.shift()) : exited ? Promise.resolve(null) : new Promise((res) => { waiter = res; }));
	ch.stdout.on('data', (c) => {
		if (want && !buf.length) {
			parts.push(c);
			have += c.length;
			if (have < want.ev.bytes) return;
			buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
			parts = []; have = 0;
		} else buf = buf.length ? Buffer.concat([buf, c]) : c;
		for (;;) {
			if (want) {
				if (buf.length < want.ev.bytes) { parts = [buf]; have = buf.length; buf = Buffer.alloc(0); return; }
				want.data = buf.subarray(0, want.ev.bytes);
				buf = buf.subarray(want.ev.bytes);
				const m = want;
				want = null;
				deliver(m);
				continue;
			}
			const k = buf.indexOf(10);
			if (k < 0) return;
			const line = buf.subarray(0, k).toString('utf8').trim();
			buf = buf.subarray(k + 1);
			if (!line.startsWith('{')) continue;
			let ev;
			try { ev = JSON.parse(line); } catch (e) { continue; }
			if (ev.ev === 'done') toolDone = ev;
			if (ev.bytes > 0) want = { ev, data: null };
			else deliver({ ev, data: null });
		}
	});
	ch.on('close', (code, sig) => {
		exited = true; ch.code = code; ch.sig = sig;
		if (!toolDone && err.trim()) say({ ev: 'warning', text: `eegpu roll: ${err.trim().split('\n').pop().slice(0, 300)}` });
		deliver(null);
	});
	/** eegpu roll ended by a failed launch (exit 6, 7: the driver's watchdog) or a crash (an exit code above 255, a signal,
	 *  or an end without its done or error line): the editor's GPU failure rule needs {"error", "launchError": true} (it
	 *  stops the other GPU strategies too) and this process's exit code 6 / 7 */
	const crashCheck = () => {
		if (!exited) return false;
		const code = ch.code, sig = ch.sig;
		const crashed = code === 6 || code === 7 || (Number.isFinite(code) && (code < 0 || code > 255)) || (code === null && !!sig) || (!toolDone && !toolErr);
		if (!crashed) return false;
		if (!(toolErr && toolErr.launchError)) {
			say({ error: `eegpu roll ${code === 7 ? 'was stopped by the display driver\'s watchdog' : code === 6 ? 'had a GPU launch failure' : `crashed (${code === null ? `signal ${sig}` : `exit code ${code}`})`}` +
				`${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}`, launchError: true });
		}
		process.exitCode = code === 7 ? 7 : 6;
		return true;
	};
	ch.on('error', (e) => { err += e.message; });
	/** the next message that is not a warning (a warning is passed on) */
	const reply = async () => {
		for (;;) {
			const m = await next();
			if (m === null) return null;
			if (m.ev.warn) { say({ ev: 'warning', text: `eegpu roll: ${m.ev.warn}` }); continue; }
			if (m.ev.error) { toolErr = m.ev; say({ error: m.ev.error, launchError: m.ev.launchError || undefined }); return null; }
			return m;
		}
	};
	// the load: ready, then start
	let ready = null, info = null;
	while (!info) {
		const m = await reply();
		if (m === null) {
			if (!crashCheck() && !toolErr) say({ error: `eegpu roll ended before it started${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 300)}` : ''}` });
			if (!process.exitCode) process.exitCode = 4;
			cleanup();
			return;
		}
		if (m.ev.ev === 'ready') { ready = m.ev; say(m.ev); }
		else if (m.ev.ev === 'start') info = m.ev;
	}
	const tReady = Date.now(), tEnd = tReady + a.seconds * 1000;
	if (a.steer) say({ ev: 'warning', text: '--gpu=1 orders by the reach field alone: the steer field is not used' });
	say({ ev: 'start', workers: 1, seeds: [a.seed], mode: field.mode, cells: 'coarse', gpu: info.gpu ? info.gpu.name : null, startCost: startCost < 0 ? null : Math.round(startCost * 100) / 100,
		cap: info.cap, memMB: info.memMB, hostMB: info.hostMB, batch: a.batch, rolls: a.rolls, roll: a.roll });
	// ---- the archive (by dense id: the GPU's pool index; cell 0 = the start)
	let capN = 1 << 16;
	let cT = new Int32Array(capN), cRc = new Float32Array(capN), cPicks = new Int32Array(capN), cRoom = new Int32Array(capN), cNode = new Int32Array(capN),
		cVer = new Int32Array(capN), cSeen = new Uint32Array(capN);
	let nCells = 0;
	const grow = (need) => {
		if (need <= capN) return;
		let n = capN;
		while (n < need) n *= 2;
		const g = (A, T) => { const B = new T(n); B.set(A); return B; };
		cT = g(cT, Int32Array); cRc = g(cRc, Float32Array); cPicks = g(cPicks, Int32Array); cRoom = g(cRoom, Int32Array); cNode = g(cNode, Int32Array);
		cVer = g(cVer, Int32Array); cSeen = g(cSeen, Uint32Array);
		capN = n;
	};
	// path nodes: (up, seed, length); -1 = the start
	let nodeCap = 1 << 16, nUp = new Int32Array(nodeCap), nSeed = new Uint32Array(nodeCap), nLen = new Uint16Array(nodeCap), nNodes = 0;
	const newNode = (up, seed, len) => {
		if (nNodes >= nodeCap) {
			nodeCap *= 2;
			const u = new Int32Array(nodeCap), s = new Uint32Array(nodeCap), l = new Uint16Array(nodeCap);
			u.set(nUp); s.set(nSeed); l.set(nLen);
			nUp = u; nSeed = s; nLen = l;
		}
		nUp[nNodes] = up; nSeed[nNodes] = seed; nLen[nNodes] = len;
		return nNodes++;
	};
	const pathOf = (node, extraSeed, extraLen) => {
		const segs = [];
		let len = extraLen || 0;
		for (let q = node; q >= 0; q = nUp[q]) { segs.push(q); len += nLen[q]; }
		const out = new Uint8Array(len);
		let o = 0;
		for (let k = segs.length - 1; k >= 0; k--) { const q = segs[k]; rollInputs(nSeed[q], nLen[q], a.keep, out, o); o += nLen[q]; }
		if (extraLen) rollInputs(extraSeed, extraLen, a.keep, out, o);
		return out;
	};
	const costOf = (fifths, node) => {
		if (fifths >= 0) return fifths / 5;
		if (a.prune) return 1e4;   // (not reported by the tool: it ends such runs)
		// (--prune=0: 1e4 + the walking distance, as explore()'s costOf)
		const ms = pathOf(node);
		sim.restore(startSnap);
		for (let s = 0; s < ms.length; s++) { E.applyMask(inp, ms[s]); sim.tick(inp); }
		const tx = Math.trunc(sim.px + 8) >> 4, ty = Math.trunc(sim.py + 8) >> 4;
		const w = tx >= 0 && ty >= 0 && tx < field.W && ty < field.H ? field.walk[ty * field.W + tx] : RF.CUT;
		return 1e4 + (w === RF.CUT ? 9999 : w / 5);
	};
	// ---- rooms (explore()'s: fields from the state that entered the room, replayed here in the JS engine)
	const RM = roomOf(L);
	const fields = roomFields(L, 64 << 20);
	const rooms = new Map(), roomList = [];
	let keyMismatch = 0;
	const newRoom = (key, c) => {
		const ms = c === 0 ? new Uint8Array(0) : pathOf(cNode[c]);
		sim.restore(startSnap);
		for (let s = 0; s < ms.length; s++) { E.applyMask(inp, ms[s]); sim.tick(inp); }
		if (RM.key(sim) !== key) keyMismatch++;
		const f = fields.enter(sim);
		const r = { idx: roomList.length, key, desc: RM.desc(sim), t: cT[c], gain: f.gain, troOk: f.troOk, picks: 0, arr: [], best: -1, isNew: true, sent: 0, sentAt: -1 };
		rooms.set(key, r);
		roomList.push(r);
		return r;
	};
	// ---- head A's heap (explore()'s): (priority, cell, version)
	const hv = [], hc = [], hver = [];
	const prio = (c) => cRc[c] + a.lambda * Math.sqrt(cPicks[c]);
	const hpush = (c) => {
		let i = hv.length;
		const v = prio(c);
		hv.push(v); hc.push(c); hver.push(cVer[c]);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (hv[p] <= v) break;
			hv[i] = hv[p]; hc[i] = hc[p]; hver[i] = hver[p];
			i = p;
		}
		hv[i] = v; hc[i] = c; hver[i] = cVer[c];
	};
	let popVer = 0;
	const hpop = () => {
		const c = hc[0];
		popVer = hver[0];
		const v = hv.pop(), lc = hc.pop(), lver = hver.pop();
		const n = hv.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === i) break;
				hv[i] = hv[m]; hc[i] = hc[m]; hver[i] = hver[m];
				i = m;
			}
			hv[i] = v; hc[i] = lc; hver[i] = lver;
		}
		return c;
	};
	const compact = () => {
		let n = 0;
		for (let i = 0; i < hv.length; i++) if (hver[i] === cVer[hc[i]]) { hv[n] = hv[i]; hc[n] = hc[i]; hver[n] = hver[i]; n++; }
		hv.length = n; hc.length = n; hver.length = n;
		for (let i = (n >> 1) - 1; i >= 0; i--) {
			const v = hv[i], c = hc[i], ver = hver[i];
			let j = i;
			for (;;) {
				const l = 2 * j + 1, r = l + 1;
				let m = j, mv = v;
				if (l < n && hv[l] < mv) { m = l; mv = hv[l]; }
				if (r < n && hv[r] < mv) { m = r; mv = hv[r]; }
				if (m === j) break;
				hv[j] = hv[m]; hc[j] = hc[m]; hver[j] = hver[m];
				j = m;
			}
			hv[j] = v; hc[j] = c; hver[j] = ver;
		}
	};
	let maxT = a.depth;
	const rnd = rngOf(a.seed);
	const popA = () => {
		while (hv.length) {
			const c = hpop();
			if (popVer !== cVer[c] || cT[c] >= maxT) continue;
			return c;
		}
		return -1;
	};
	const popB = () => {
		let br = null, bw = -1;
		for (let k = 0; k < 4; k++) {
			const r = roomList[(rnd() * roomList.length) | 0];
			if (!r.arr.length) continue;
			const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50);
			if (w > bw) { bw = w; br = r; }
		}
		if (br === null) return popA();
		const arr = br.arr;
		let bc = -1, bs = -1;
		for (let k = 0; k < a.sample; k++) {
			const c = arr[(rnd() * arr.length) | 0];
			if (cT[c] >= maxT) continue;
			const sc = 1 / Math.sqrt(1 + cSeen[c]) + 1 / Math.sqrt(1 + cPicks[c]);
			if (sc > bs) { bs = sc; bc = c; }
		}
		return bc >= 0 ? bc : popA();
	};
	const discovery = [];
	// ---- the start cell
	grow(1);
	nCells = 1;
	cT[0] = 0; cNode[0] = -1; cRc[0] = startCost >= 0 ? startCost : costOf(-1, -1);
	const room0 = newRoom(info.room | 0, 0);
	room0.isNew = false;
	cRoom[0] = room0.idx; room0.arr.push(0); room0.best = 0;
	hpush(0);
	let end = startCost < 0 && a.prune ? 'unreachable' : '';
	// ---- the events (explore()'s and main()'s)
	let ticks = 0, picks = 0, batches = 0, deepest = 0, minRc = cRc[0], full = false, gpuMs = 0, hostMs = 0, rollMs = 0, kernelMs = 0, records = 0, touched = 0, colMs = 0, rollWallMs = 0,
		pickMs = 0, seenMs = 0, waitMs = 0, reordered = 0;
	let near = { rc: cRc[0], t: 0, c: 0 }, nearSent = null;
	let route = null, first = null;
	const samples = [[Date.now(), 0]];
	const progress = () => {
		const now = Date.now();
		samples.push([now, ticks]);
		while (samples.length > 2 && now - samples[1][0] >= 2000) samples.shift();
		const [ta, ka] = samples[0];
		say({ ev: 'progress', layer: deepest, tick: deepest, states: nCells, ticks, ticksPerSec: now > ta ? Math.round((ticks - ka) / ((now - ta) / 1000)) : 0, picks,
			bestCost: minRc >= 1e4 ? null : Math.round(minRc * 100) / 100, found: route ? route.ticks : 0, refined: 0, rooms: roomList.length, workers: 1, gpu: true, batches, full });
	};
	const sendNear = () => {
		if (near === nearSent || near.c === 0) return;
		nearSent = near;
		say({ ev: 'closest', dist: Math.round(near.rc * 1000) / 1000, tick: near.t, inputs: C.eetasBytes(pathOf(cNode[near.c])).toString('latin1') });
	};
	const sourcesSent = new Map();
	const source = (kind, r, c) => {
		r.sent++; r.sentAt = c;
		let s = sourcesSent.get(r.key);
		if (!s) sourcesSent.set(r.key, s = { tick: Infinity, dist: Infinity });
		if (kind === 'room') { if (cT[c] >= s.tick) return; s.tick = cT[c]; } else { if (cRc[c] >= s.dist - 0.5) return; s.dist = cRc[c]; }
		say({ ev: 'source', kind, room: r.key, desc: r.desc, gain: r.gain, tick: cT[c], dist: Math.round(cRc[c] * 1000) / 1000,
			inputs: C.eetasBytes(pathOf(cNode[c])).toString('latin1'), seed: a.seed });
	};
	let lastBlandSource = -1e9, lastSources = Date.now();
	const bestSources = () => {
		const cand = [];
		for (const r of roomList) if (r.best >= 0 && cNode[r.best] >= 0 && cT[r.best] >= SOURCE_MIN_TICKS && r.best !== r.sentAt) cand.push(r);
		cand.sort((x, y) => (1 + Math.log(1 + y.gain)) / (1 + y.sent) - (1 + Math.log(1 + x.gain)) / (1 + x.sent) || cT[x.best] - cT[y.best]);
		for (let k = 0; k < 4 && k < cand.length; k++) source('best', cand[k], cand[k].best);
	};
	// ---- stdin (the editor): "depth D", "stop"; its end stops the search too
	let stopReq = false;
	if (a.stdin) {
		let sb = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (s) => {
			sb += s;
			let k;
			while ((k = sb.indexOf('\n')) >= 0) {
				const line = sb.slice(0, k).trim();
				sb = sb.slice(k + 1);
				const m = /^depth (\d+)$/.exec(line);
				if (m) maxT = Math.min(maxT, Math.max(0, +m[1]));
				else if (line === 'stop') stopReq = true;
			}
		});
		process.stdin.on('end', () => { stopReq = true; });
		process.stdin.on('error', () => { stopReq = true; });
	}
	const stopFile = () => !!a.stopfile && fs.existsSync(a.stopfile);
	const timer = setInterval(() => { progress(); sendNear(); }, 500);
	// ---- the batches
	const pickBuf = new Uint32Array(a.batch);
	const pickBytes = Buffer.from(pickBuf.buffer);
	// (each pick's path node when it was picked: the GPU plays its runs from the state the cell had then, and a record
	// of the same batch may give the cell a sooner state and path before its runs' records are read)
	const pickNode = new Int32Array(a.batch);
	const bFirst = []; // (per batch: each room's first new cell, by room index)
	// (head B's seen counts: every SEEN_BATCHES batches, more batches apart as the cells grow (a download of millions of
	// cells takes a while): by the batch count, not the clock, so a seed's search is the same every time)
	let lastSeen = 0, tickBudget = a.maxTicks;
	while (!end) {
		const now = Date.now();
		if (stopReq || stopFile()) { end = 'stopped'; break; }
		if (now >= tEnd) { end = 'time'; break; }
		if (tickBudget && ticks >= tickBudget) { end = 'ticks'; break; }
		if (a.first && route) { end = 'finish'; break; }
		if (batches - lastSeen >= Math.max(SEEN_BATCHES, Math.ceil(nCells / SEEN_CELLS)) && roomList.length > 0) {
			lastSeen = batches;
			ch.stdin.write('seen\n');
			const m = await reply();
			if (m === null) { end = 'error'; break; }
			if (m.ev.ev === 'seen' && m.data) {
				const s = new Uint32Array(m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.length));
				cSeen.set(s.subarray(0, Math.min(s.length, capN)));
			}
			seenMs += Date.now() - now;
		}
		const h0 = Date.now();
		// the picks (explore()'s heads, one pick after the other)
		if (hv.length > 3 * nCells + 4096) compact();
		let K = 0;
		for (let k = 0; k < a.batch; k++) {
			let e = -1;
			if (discovery.length && rnd() < 0.5) {
				const d = discovery[discovery.length - 1];
				e = d[0];
				if (--d[1] <= 0) discovery.pop();
				if (cT[e] >= maxT) continue;
			} else if (rnd() < a.pA) e = popA();
			else e = popB();
			if (e < 0) break;
			cPicks[e]++; cVer[e]++; picks++;
			roomList[cRoom[e]].picks++;
			hpush(e);
			pickNode[K] = cNode[e];
			pickBuf[K++] = e;
		}
		if (!K) { end = 'exhausted'; break; }
		const bs = fmixU((Math.imul(a.seed, 0x9e3779b1) + batches + 1) | 0);
		ch.stdin.write(`batch ${K} ${maxT} ${bs}\n`);
		ch.stdin.write(Buffer.from(pickBytes.subarray(0, 4 * K)));
		const hw = Date.now();
		pickMs += hw - h0;
		hostMs += hw - h0;
		const m = await reply();
		const h1 = Date.now();
		waitMs += h1 - hw;
		if (m === null) { end = toolDone && toolDone.end === 'stopped' ? 'stopped' : 'error'; break; }
		if (m.ev.ev !== 'batch') continue;
		batches++;
		ticks += m.ev.ticks;
		gpuMs += m.ev.ms;
		rollMs += m.ev.rollMs || 0;
		kernelMs += m.ev.kernelMs || 0;
		records += m.ev.n;
		touched += m.ev.touched || 0; colMs += m.ev.colMs || 0; rollWallMs += m.ev.rollWallMs || 0;
		full = !!m.ev.full;
		const n = m.ev.n, nf = m.ev.fin;
		const rec = new Int32Array(m.data ? m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + 24 * n) : new ArrayBuffer(0));
		bFirst.length = 0;
		// (new cells: the dense ids from this batch's on; they come in any order, a record's index and its new id are two
		// separate atomics: judged by the count before the batch, else a new id below one read before was taken for a known
		// cell and dropped)
		const n0 = nCells;
		for (let j = 0; j < n; j++) {
			const d = rec[6 * j], t = rec[6 * j + 1], fifths = rec[6 * j + 2], roomKey = rec[6 * j + 3], pk = rec[6 * j + 4], rs = rec[6 * j + 5];
			if (d < 0) continue;   // (the pool is full: not kept)
			const run = rs & 0xffff, step = rs >>> 16;
			const node = newNode(pickNode[pk], rollSeed(bs, pk, run), step + 1);
			const isNew = d >= n0;
			if (isNew) { grow(d + 1); if (d < nCells) reordered++; else nCells = d + 1; cPicks[d] = 0; cVer[d] = 0; cSeen[d] = 0; }
			else if (t >= cT[d]) continue;
			cT[d] = t; cNode[d] = node;
			const rc = costOf(fifths, node);
			cRc[d] = rc;
			if (!isNew) cVer[d]++;
			hpush(d);
			if (t > deepest) deepest = t;
			if (rc < minRc - 0.05) minRc = rc;
			if (rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) near = { rc, t, c: d };
			let r = rooms.get(roomKey);
			if (isNew) {
				if (r === undefined) { r = { pending: true, key: roomKey, cells: [] }; rooms.set(roomKey, r); }
				if (r.pending) { r.cells.push(d); if (!bFirst.includes(r)) bFirst.push(r); continue; }
				cRoom[d] = r.idx;
				r.arr.push(d);
			}
			const rr = roomList[cRoom[d]];
			if (rr.best < 0 || rc < cRc[rr.best]) rr.best = d;
		}
		// the batch's new rooms: fields from the earliest of their new cells (explore(): a room's first cell)
		for (const p of bFirst) {
			let c0 = p.cells[0];
			for (const c of p.cells) if (cT[c] < cT[c0]) c0 = c;
			rooms.delete(p.key);
			const r = newRoom(p.key, c0);
			for (const c of p.cells) { cRoom[c] = r.idx; r.arr.push(c); if (r.best < 0 || cRc[c] < cRc[r.best]) r.best = c; }
			r.isNew = false;
			if (r.gain > 0 && a.burst > 0) discovery.push([c0, a.burst]);
			if ((r.gain > 0 || Date.now() - lastBlandSource >= SOURCE_S * 1000) && cT[c0] >= SOURCE_MIN_TICKS) {
				if (r.gain <= 0) lastBlandSource = Date.now();
				source('room', r, c0);
			}
		}
		// finishes: the fastest one of the batch, replayed in the exact engine
		if (nf) {
			const fin = new Uint32Array(m.data.buffer.slice(m.data.byteOffset + 24 * n, m.data.byteOffset + 24 * n + 16 * nf));
			let bf = -1;
			for (let j = 0; j < nf; j++) if (bf < 0 || fin[4 * j + 3] < fin[4 * bf + 3]) bf = j;
			const pk = fin[4 * bf], run = fin[4 * bf + 1], step = fin[4 * bf + 2], t = fin[4 * bf + 3];
			if (!route || t < route.ticks) {
				const masks = pathOf(pickNode[pk], rollSeed(bs, pk, run), step + 1);
				const ev = C.evaluate(L, masks);
				if (!ev || ev.ms.length !== t) say({ ev: 'warning', text: `a GPU route of ${t} ticks does not replay (${ev ? `finishes after ${ev.ms.length}` : 'does not finish'})` });
				else {
					maxT = Math.min(maxT, t - 1);
					const sec = Math.round((Date.now() - tReady) / 100) / 10;
					route = { ticks: t, runTicks: ev.runTicks, sec, simTicks: ticks };
					if (!first) first = { ticks: t, sec, simTicks: ticks, seed: a.seed };
					say({ ev: 'result', kind: 'finish', ticks: t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), inputs: C.eetasBytes(ev.ms).toString('latin1'), seed: a.seed, simTicks: ticks, sec });
					if (a.out) { try { C.writeEetas(a.out, ev.ms); } catch (e) { say({ ev: 'warning', text: `cannot write ${a.out}: ${e.message}` }); } }
				}
			}
		}
		if (Date.now() - lastSources >= SOURCE_S * 1000) { lastSources = Date.now(); bestSources(); }
		hostMs += Date.now() - h1;
	}
	clearInterval(timer);
	if (a.stdin) { try { process.stdin.pause(); process.stdin.destroy(); } catch (e) { /* gone */ } }
	// the tool: stop (its done line), then its end
	if (!exited) { try { ch.stdin.write('stop\n'); ch.stdin.end(); } catch (e) { /* gone */ } }
	for (let k = 0; k < 100 && !exited; k++) { const m = await Promise.race([next(), new Promise((res) => setTimeout(() => res(undefined), 100))]); if (m === null) break; }
	if (!exited) { try { ch.stdout.destroy(); ch.stderr.destroy(); ch.unref(); } catch (e) { /* gone */ } }
	else if (end === 'error' && crashCheck()) end = 'crashed';
	cleanup();
	progress();
	sendNear();
	const secs = (Date.now() - tReady) / 1000;
	say({ ev: 'done', layers: deepest, seconds: Math.round(secs * 100) / 100, ticks, ticksPerSec: Math.round(ticks / Math.max(1e-3, secs)), states: nCells, picks, end,
		finish: route ? route.ticks : 0, first, cells: 'coarse', gpu: true, batches, rooms: roomList.length, full, gpuMs: Math.round(gpuMs), hostMs: Math.round(hostMs), rollMs: Math.round(rollMs), kernelMs: Math.round(kernelMs), records, touched, colMs: Math.round(colMs), rollWallMs: Math.round(rollWallMs), pickMs: Math.round(pickMs), seenMs: Math.round(seenMs), waitMs: Math.round(waitMs), reordered,
		roomKeyMismatch: keyMismatch, loadSec: Math.round((tReady - t0) / 100) / 10,
		// (eegpu roll's launch figures, as the other GPU tools' done events have them)
		...Object.fromEntries(['maxLaunchMs', 'maxKernelMs', 'kernelLaunches', 'launchTotalMs', 'kernelTotalMs', 'gapMs', 'hostCpuMs', 'launchTarget'].filter((k) => toolDone && toolDone[k] !== undefined)
			.map((k) => [k, toolDone[k]])), tool: toolDone || null });
	console.log(`[goexplore] GPU (${info.gpu ? info.gpu.name : '?'}), batch ${a.batch} x ${a.rolls} x ${a.roll}, ${secs.toFixed(1)} s, ${(ticks / 1e6).toFixed(2)} M ticks, ` +
		`${nCells.toLocaleString('en-US')} cells in ${roomList.length} rooms, ${batches} batches (GPU ${(gpuMs / 1000).toFixed(1)} s, host ${(hostMs / 1000).toFixed(1)} s), end ${end}: ` +
		(route ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks); best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s`
			: `no route (closest: reach cost ${near.rc.toFixed(2)} at tick ${near.t})`));
}

function workerMain() {
	const d = workerData;
	// (--nice: this worker thread alone. On Linux the nice value is a thread's: setpriority(PRIO_PROCESS, 0) = the calling
	// thread, which a lower priority needs no privilege for; child processes inherit the main thread's)
	if (d.a.nice > 0 && process.platform === 'linux') { try { os.setPriority(0, Math.min(19, Math.round(d.a.nice))); } catch (e) { /* as it is */ } }
	const L = levelOf(d.a);
	// (the steer field: views on the main thread's shared bytes, no copy per worker)
	const a = Object.assign({}, d.a, d.steerBuf ? { steerData: Object.assign(SF.readSteerFile(Buffer.from(d.steerBuf)), { dpFirst: d.a.dpFirst === 1 }) } : {}, d.lb ? { lbTiles: d.lb } : {});
	explore(L, d.field, a, d.seed, d.ctrl, (m) => parentPort.postMessage(m), d.port || null, d.seedPort || null);
}

async function main() {
	let a;
	try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2; return; }
	let L;
	try { L = levelOf(a); } catch (e) { console.log(JSON.stringify({ error: `cannot read the level: ${e.message}` })); process.exitCode = 2; return; }
	// the memory budget (for the workers too): the machine's memory, what is free, what the other searches on it claim (the
	// registry: a first claim of this search's most goes in before the others' are read, so two searches that start
	// together each see the other's; then the real one, refreshed every 60 s, removed at the end)
	const m = machineMemory();
	if (a.gpu) {
		// (--gpu=1: eegpu roll's pool of cell states in host memory, in the registry like a CPU search's process memory)
		if (!a.hmem) registryClaim(ROLL_HOST_SHARE * m.total);
		m.others = registryOthers();
		settle(a, L, m);
		return gpuMain(a, L, m);
	}
	if (!a.mem && !a.memTotal) registryClaim(MEM_SHARE * m.total);
	m.others = registryOthers();
	settle(a, L, m);
	const claimed = processMB(a.workers, a.mem) * 1048576;
	registryClaim(claimed);
	process.on('exit', () => registryClaim(0));
	const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
	const t0 = Date.now();
	const sec = () => Math.round((Date.now() - t0) / 100) / 10;
	// the field's tables in shared memory: the workers read them, and a copy per worker (the cost tables are about 120 MB
	// on a 1000 x 1000 level) would cost memory and start-up time on every thread
	const field = RF.shareField(RF.reachField(L));
	const sim0 = new E.EESim(L);
	sim0.reset();
	const pre0 = prefixOf(a);
	const preStr = pre0 ? C.eetasBytes(pre0).toString('latin1') : '';
	if (pre0) { const inp0 = new E.EEInput(); for (let s = 0; s < pre0.length; s++) { E.applyMask(inp0, pre0[s]); sim0.tick(inp0); } }
	const startCost = RF.costAt(field, sim0);
	// (the sound lower bound per tile: every worker's prune once a route is known, in shared memory)
	const lb = a.lb ? lowerBoundTiles(L) : null;
	const ctrl = new Int32Array(new SharedArrayBuffer(8));
	ctrl[0] = a.depth;
	const seeds = Array.from({ length: a.workers }, (_, i) => (a.seed + i) >>> 0);
	// the seeds' channels (stdin "seed <inputs>"): each worker polls its end between chunks of picks (receiveMessageOnPort:
	// its loop never yields to the event loop)
	const seedChannels = seeds.map(() => new MessageChannel());
	const seedPorts = seedChannels.map((c) => c.port1), seedIn = seedChannels.map((c) => c.port2);
	// --steer=<RCH4 file> (the editor's, src/steer.js) or --steer=build: the steer field in shared memory for the workers'
	// second goal heap; a file of another level (or one that cannot be read) is ignored with a warning
	let steerBuf = null, steerNote = null;
	if (a.steer) {
		try {
			const bytes = a.steer === 'build' ? SF.steerFileBytes(SF.buildSteer(L)) : fs.readFileSync(a.steer);
			const sab = new SharedArrayBuffer(bytes.length);
			new Uint8Array(sab).set(bytes);
			const sd = SF.readSteerFile(Buffer.from(sab));
			if (sd.W !== L.width || sd.H !== L.height) throw new Error('it was made for another level');
			if (sd.levelFp[0] || sd.levelFp[1]) {
				let fp = null;
				try { const G = require('./gpu.js'); fp = G.blobFp(G.levelBlob(L)); } catch (e) { /* a level the native tool cannot take: the size check only */ }
				if (fp && (fp[0] >>> 0 !== sd.levelFp[0] || fp[1] >>> 0 !== sd.levelFp[1])) throw new Error('it was made for another level');
			}
			steerBuf = sab;
			const s0 = SF.steerAt(sd, sim0);
			steerNote = { layers: sd.S, bodies: sd.bodies.length, coinDP: sd.dp ? sd.dp.n : 0, start: Number.isFinite(s0) ? Math.round(s0 * 100) / 100 : null, mix: a.mix, dist: a.steerDist !== 0 };
		} catch (e) { say({ ev: 'warning', text: `the steer field is not used: ${e.message}` }); }
	}
	say({ ev: 'start', workers: a.workers, seeds, mode: field.mode, cells: a.cells, startCost: startCost < 0 ? null : Math.round(startCost * 100) / 100, steer: steerNote, mem: a.mem, memWhy: a.memWhy,
		processMB: Math.round(claimed / 1048576), machineMB: Math.round(m.total / 1048576), freeMB: Math.round(m.free / 1048576), othersMB: Math.round(m.others / 1048576),
		maxCells: a.maxCells, maxSnaps: a.maxSnaps });
	// the fastest verified route; the closest state
	let route = null, first = null, near = null, nearPending = false, heapWarned = false;
	const stats = new Map(), dones = new Map();
	const total = (k) => { let s = 0; for (const v of stats.values()) s += v[k] || 0; return s; };
	let nLead = 0;   // (the routes head-L picks found)
	const samples = [[Date.now(), 0]];
	const bound = (d) => { if (d < Atomics.load(ctrl, 0)) Atomics.store(ctrl, 0, Math.max(0, d)); };
	const progress = () => {
		const now = Date.now(), tk = total('ticks');
		samples.push([now, tk]);
		while (samples.length > 2 && now - samples[1][0] >= 2000) samples.shift();
		const [ta, ka] = samples[0];
		let deepest = 0, minRc = null, nRooms = 0;
		for (const v of stats.values()) {
			deepest = Math.max(deepest, v.deepest || 0);
			nRooms = Math.max(nRooms, v.rooms || 0);
			if (v.minRc !== null && (minRc === null || v.minRc < minRc)) minRc = v.minRc;
		}
		say(Object.assign({ ev: 'progress', layer: deepest, tick: deepest, states: total('cells'), ticks: tk, ticksPerSec: now > ta ? Math.round((tk - ka) / ((now - ta) / 1000)) : 0,
			picks: total('picks'), bestCost: minRc === null || minRc >= 1e4 ? null : Math.round(minRc * 100) / 100, found: route ? route.ticks : 0, refined: total('refined') },
		a.cells === 'coarse' ? { rooms: nRooms } : {}, one ? { allRooms: one.rooms.size, shared: one.shared, fed: one.fed } : {}, bursts ? { gpu: bursts.stats() } : {},
		{ workers: a.workers, memMB: total('memMB'), heapMB: total('heapMB'), evicted: total('evicted'), cpuS: cpuSec() }, route ? { lbCut: total('lbCut'), leadPicks: total('leadPicks'), wayPicks: total('wayPicks'), leadRoutes: nLead, leadShare: stats.size ? Math.round(1000 * total('leadShare') / stats.size) / 1000 : 0 } : {}, total('seeded') ? { seeded: total('seeded'), seedCells: total('seedCells') } : {}));
	};
	// the workers' sources, each room key once per kind unless it improved (an earlier arrival, a lower cost): every
	// worker finds the same rooms
	const sourcesSent = new Map();   // room key -> {tick: the earliest "room" arrival sent, dist: the lowest "best" cost sent}
	const onSource = (msg) => {
		let s = sourcesSent.get(msg.room);
		if (!s) sourcesSent.set(msg.room, s = { tick: Infinity, dist: Infinity });
		if (msg.kind === 'room') { if (msg.t >= s.tick) return; s.tick = msg.t; } else { if (msg.rc >= s.dist - 0.5) return; s.dist = msg.rc; }
		say({ ev: 'source', kind: msg.kind, room: msg.room, desc: msg.desc, gain: msg.gain, tick: msg.t, dist: Math.round(msg.rc * 1000) / 1000, inputs: msg.inputs, seed: msg.seed });
	};
	const flushNear = () => {
		if (!nearPending) return;
		nearPending = false;
		say({ ev: 'closest', dist: Math.round(near.rc * 1000) / 1000, tick: near.t, inputs: near.inputs });
	};
	let lastClaim = Date.now();
	const timer = setInterval(() => {
		progress();
		flushNear();
		if (Date.now() - lastClaim >= 60000) { lastClaim = Date.now(); registryClaim(claimed); }
	}, 500);
	if (a.stdin) {
		// the editor: "depth D" (a route of D + 1 ticks is known), "seed <inputs>" (its wall breaker's attempts: to every
		// worker, which makes cells along them: addSeed) and "stop"
		let buf = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (s) => {
			buf += s;
			let k;
			while ((k = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, k).trim();
				buf = buf.slice(k + 1);
				const m = /^depth (\d+)$/.exec(line);
				if (m) bound(+m[1]);
				else if (line.startsWith('seed ') && /^[0-O]+$/.test(line.slice(5))) { for (const p of seedPorts) p.postMessage(line.slice(5)); }
				else if (line === 'stop') Atomics.store(ctrl, 1, 1);
				else if (line.startsWith('import ') && one) {
					// (the one search: another operator's run, the editor's GPU random runs, into every archive)
					const inputs = line.slice(7);
					if (/^[0-O]+$/.test(inputs)) { one.broadcast(inputs, -1); one.fed++; }
				} else if (line.startsWith('route ') && /^[0-O]+$/.test(line.slice(6))) adopt(line.slice(6));
			}
		});
		// the end of stdin: the editor went away (a crash, or a kill that missed its children): stop, rather than run on
		// every thread for the rest of --seconds
		process.stdin.on('end', () => Atomics.store(ctrl, 1, 1));
		process.stdin.on('error', () => Atomics.store(ctrl, 1, 1));
	}
	/** a route (masks) from worker `seed` (0: a GPU burst) after simTicks simulated ticks: replayed in the exact engine
	 *  before it counts (the same engine found it, from snapshots and replays: a mismatch would be a bug) */
	const routeFound = (masks, seed, simTicks, who, byL = false) => {
		const t = masks.length;
		if (route && t >= route.ticks) return;
		const ev = C.evaluate(L, masks);
		if (!ev || ev.ms.length !== t) { say({ ev: 'warning', text: `${who}: a route of ${t} ticks does not replay (${ev ? `finishes after ${ev.ms.length}` : 'does not finish'})` }); return; }
		bound(t - 1);
		const inputs = C.eetasBytes(ev.ms).toString('latin1');
		route = { ticks: t, runTicks: ev.runTicks, inputs, seed, simTicks, sec: sec() };
		if (byL) nLead++;
		// (head L of every worker: the new best route's schedule; byL: a head-L pick found it, its share's yield)
		if (one && (a.pL > 0 || a.pW > 0)) for (const p of one.ports) p.postMessage({ type: 'route', inputs, byL });
		if (!first) first = { ticks: t, sec: route.sec, simTicks, seed };
		say({ ev: 'result', kind: 'finish', ticks: t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), inputs, seed, simTicks, sec: route.sec, ...(seed ? {} : { by: 'gpu' }) });
		if (a.out) { try { C.writeEetas(a.out, ev.ms); } catch (e) { say({ ev: 'warning', text: `cannot write ${a.out}: ${e.message}` }); } }
		if (a.first) Atomics.store(ctrl, 1, 1);
	};
	/** stdin "route <inputs>": a route known elsewhere (the editor's other strategies): the bound, head L's schedule, and
	 *  its states into every archive (no result event: it is not this search's find) */
	const adopt = (inputs) => {
		const masks = Uint8Array.from(inputs, (ch) => (ch.charCodeAt(0) - 48) & 31);
		if (route && masks.length >= route.ticks) return;
		const ev = C.evaluate(L, masks, false);
		if (!ev || ev.ms.length !== masks.length) { say({ ev: 'warning', text: `route: ${masks.length} ticks that do not finish there` }); return; }
		bound(masks.length - 1);
		route = { ticks: masks.length, runTicks: ev.runTicks, inputs, seed: -1, simTicks: 0, sec: sec(), adopted: true };
		if (one) { one.broadcast(inputs, -1); if (a.pL > 0 || a.pW > 0) for (const p of one.ports) p.postMessage({ type: 'route', inputs }); }
		say({ ev: 'route', ticks: masks.length, runTicks: ev.runTicks });
	};
	// The one search (coarse cells: the GPU bursts, or several workers with --share=1): one channel per worker. Every room
	// a worker enters first (its 'room' message) goes to the GPU operator (src/bursts.js), whose attempts go into every
	// archive, and with --share=1 into the other workers' archives (see the header: off by default)
	const one = a.cells === 'coarse' && ((a.share && a.workers > 1) || a.bursts || a.rooms) ? { rooms: new Map(), ports: [], shared: 0, fed: 0 } : null;
	let bursts = null;
	if (one) {
		const RM = roomOf(L);
		/** a room found (a worker's first cell in it, a burst's attempt, the start): true when nobody had found it */
		one.register = (m) => {
			// (--prefix: a room change before the start, or on a run that left the route before it, is the route's history)
			if (pre0 && (m.t < pre0.length || (m.inputs && !m.inputs.startsWith(preStr)))) return false;
			const r = one.rooms.get(m.room);
			if (r) { if (m.t < r.t) { r.t = m.t; if (bursts) bursts.room(m); } return false; }
			one.rooms.set(m.room, { t: m.t, desc: m.desc, tile: m.tile });
			if (bursts) bursts.room(m);
			// (--rooms=1: every room found, with the inputs that reach it: the gate benchmark watches for its target room)
			if (a.rooms && m.inputs && m.t > (pre0 ? pre0.length : 0)) say({ ev: 'room', room: m.room, desc: m.desc, t: m.t, sec: sec(), by: m.seed === undefined ? 'gpu' : 'cpu', sub: m.sub, keys: m.keys, ...(m.wt !== undefined ? { wt: m.wt } : {}), inputs: m.inputs });
			return true;
		};
		one.register({ room: RM.key(sim0), desc: RM.desc(sim0), tile: Math.min(L.width * L.height - 1, Math.max(0, (Math.trunc(sim0.py + 8) >> 4) * L.width + (Math.trunc(sim0.px + 8) >> 4))), t: pre0 ? pre0.length : 0, inputs: preStr });
		one.broadcast = (inputs, except) => { one.ports.forEach((p, i) => { if (seeds[i] !== except) p.postMessage({ type: 'import', inputs }); }); };
		one.RM = RM;
	}
	const onMessage = (msg) => {
		if (msg.type === 'stat' || msg.type === 'done') {
			stats.set(msg.seed, msg);
			if (msg.budgetMB < a.mem && !heapWarned) {
				heapWarned = true;
				say({ ev: 'warning', text: `worker ${msg.seed}: its V8 heap limit holds ${msg.budgetMB} MB of archive, not the ${a.mem} MB asked (a V8 flag set a smaller heap for the whole process)` });
			}
		}
		if (msg.type === 'closest') {
			if (!near || msg.rc < near.rc - 1e-3 || (msg.rc <= near.rc + 1e-3 && msg.t < near.t)) { near = msg; nearPending = true; }
		} else if (msg.type === 'source') {
			onSource(msg);
		} else if (msg.type === 'room') {
			if (one && one.register(msg) && a.share && a.workers > 1) { one.broadcast(msg.inputs, msg.seed); one.shared++; }
		} else if (msg.type === 'edge') {
			if (bursts) bursts.edge(msg.from, msg.tile, msg.to, msg.trig);
		} else if (msg.type === 'finish') {
			routeFound(Uint8Array.from(msg.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31), msg.seed, msg.simTicks, `worker ${msg.seed}`, !!msg.byL);
		} else if (msg.type === 'done') dones.set(msg.seed, msg);
	};
	const workers = seeds.map((seed, i) => new Promise((res) => {
		// (the heap limit: room for the garbage between two collections above the budget, which counts what the heap holds;
		// the one search: a channel per worker, see above; the wall breaker's seeds: another)
		let port = null;
		const list = [seedIn[i]];
		if (one) { const ch = new MessageChannel(); port = ch.port2; list.push(port); one.ports.push(ch.port1); }
		const w = new Worker(__filename, { workerData: { goexplore: true, a, seed, ctrl, field, steerBuf, lb, port, seedPort: seedIn[i] }, transferList: list,
			resourceLimits: { maxOldGenerationSizeMb: Math.round(HEAP_F * a.mem + HEAP_ADD), maxYoungGenerationSizeMb: HEAP_YOUNG } });
		w.on('message', onMessage);
		w.on('error', (e) => { say({ ev: 'warning', text: `worker ${seed}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}` }); res(); });
		w.on('exit', () => res());
	}));
	if (one && a.bursts) {
		const BU = require('./bursts.js');
		try {
			bursts = BU.create({ L, a, field, RM: one.RM, ports: one.ports, say, minLen: pre0 ? pre0.length : 0, bound: () => Atomics.load(ctrl, 0), register: one.register, sec: () => (Date.now() - t0) / 1000,
				broadcast: (inputs) => one.broadcast(inputs, -1), finish: (masks) => routeFound(masks, 0, 0, 'a GPU burst'),
				nearest: () => (near && near.inputs ? { inputs: near.inputs, rc: near.rc } : null) });
			for (const [k, r] of one.rooms) bursts.room({ room: k, desc: r.desc, tile: r.tile, t: r.t, inputs: preStr });
			bursts.start();
		} catch (e) { say({ ev: 'warning', text: `no GPU bursts: ${e.message}` }); bursts = null; }
	}
	await Promise.all(workers);
	if (bursts) await bursts.stop();
	for (const p of one ? one.ports : []) p.close();
	clearInterval(timer);
	for (const p of seedPorts) p.close();
	if (a.stdin) { try { process.stdin.pause(); process.stdin.destroy(); } catch (e) { /* gone */ } }
	progress();
	flushNear();
	const ends = [...dones.values()].map((d) => d.end);
	const end = ends.includes('unreachable') ? 'unreachable' : ends.includes('stopped') && !(a.first && route) ? 'stopped' : a.first && route ? 'finish'
		: ends.includes('time') ? 'time' : ends.includes('ticks') ? 'ticks' : ends.length && ends.every((x) => x === 'exhausted') ? 'exhausted' : ends[0] || 'error';
	const tk = total('ticks'), secs = (Date.now() - t0) / 1000;
	let deepest = 0;
	for (const v of stats.values()) deepest = Math.max(deepest, v.deepest || 0);
	say({ ev: 'done', layers: deepest, seconds: Math.round(secs * 100) / 100, ticks: tk, ticksPerSec: Math.round(tk / Math.max(1e-3, secs)), states: total('cells'),
		picks: total('picks'), end, finish: route ? route.ticks : 0, first, leadRoutes: nLead, cpuS: cpuSec(),
		cells: a.cells, ...(one ? { allRooms: one.rooms.size, shared: one.shared, fed: one.fed } : {}), ...(bursts ? { gpu: bursts.stats() } : {}), workers: seeds.map((s) => {
			const d = dones.get(s) || stats.get(s) || {};
			return Object.assign({ seed: s, end: d.end || null, ticks: d.ticks || 0, cells: d.cells || 0, first: d.first || null, best: d.best || null, full: !!d.full,
				snaps: d.snaps || 0, dropped: d.dropped || 0, replays: d.replays || 0, impr: d.impr || 0, evicted: d.evicted || 0, sweeps: d.sweeps || 0, nodes: d.nodes || 0,
				memMB: d.memMB || 0, heapMB: d.heapMB || 0, seeded: d.seeded || 0, seedCells: d.seedCells || 0, picks: d.picks || 0, lbCut: d.lbCut || 0, leadPicks: d.leadPicks || 0, wayPicks: d.wayPicks || 0,
				leadRoutes: d.leadRoutes || 0, leadShare: d.leadShare || 0 },
			a.cells === 'coarse' ? { rooms: d.rooms || 0, bursts: d.bursts || 0, walks: d.walks || 0, walkHits: d.hits || 0, walkMs: d.walkMs || 0, imports: d.imports || 0, importAdded: d.importAdded || 0 } : {});
		}) });
	console.log(`[goexplore] ${a.workers} worker${a.workers > 1 ? 's' : ''} (seed ${a.seed}${a.workers > 1 ? `..${a.seed + a.workers - 1}` : ''}), ${a.cells} cells, ${secs.toFixed(1)} s, ` +
		`${(tk / 1e6).toFixed(2)} M ticks, ${total('cells').toLocaleString('en-US')} cells${a.cells === 'coarse' ? ` in ${Math.max(0, ...[...stats.values()].map((v) => v.rooms || 0))} rooms` : ''}, end ${end}: ` +
		// (a route given on stdin, "route <inputs>", is no find of this search: first stays null)
		(route ? `${first ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks of worker ${first.seed})` : 'no route of its own'}; best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s${route.adopted ? ' (given)' : ''}` +
			(a.out ? ` -> ${a.out}` : '') : `no route (closest: reach cost ${near ? near.rc.toFixed(2) : '-'} at tick ${near ? near.t : '-'})`));
}

if (!isMainThread && workerData && workerData.goexplore) workerMain();
else if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; });

module.exports = { OPTIONS, QP, QV, FINE_MAX_TILES, parseArgs, settle, cellsFor, defaultMem, machineMemory, processMB, memOfTotal, registryOthers, registryClaim, discreteOf,
	roomOf, roomFields, inputsOf, rngOf, rollSeed, rollInputs, rollHostMB, lowerBoundTiles };
