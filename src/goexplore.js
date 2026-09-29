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
// routes of at most D ticks: a route of D + 1 is known elsewhere), "stop" and "workers K" (only the first K workers search,
// the others park, keeping their archives and answering their ports: the editor's stall escape has their CPU; 0 = all
// again; an event {"ev":"workers","active":K,"of":N}); the end of stdin (the editor is gone) stops it too. A last line
// "[goexplore] ..." sums up.
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
//        [--burstSmallS=300 (a burst of a sizing over the defaults that found the GPU's memory full: the defaults (lane 0
//        alone, 2^25 cells, 262,144 states a layer) at once for this long, then its own sizing again)]
//        [--burstFair=1 (0: the bursts' rooms by the bandit alone; 1: its score per untried target not yet failed,
//        src/bursts.js fairScore)]
//        [--burstServe=1 (the bursts through a long-lived eegpu explore --serve per lane, which keeps its CUDA context and
//        kernels between bursts; 0 (or EEAT_BURST_SERVE=0): a process per burst, as before; an eegpu without --serve: the same)]
//        [--stallLadder=0 (1: OPT-IN, no gain in its A/B (hx-r1-power: Forgotten Helix / NC Naos, the same coins and rooms): an arm whose last 3 bursts gained nothing sends its start up the wall ladder at any
//        distance, then 1000 and 2000 ticks further back: bursts.js STALL_N / STALL_FAR)] [--legs=0 (1: OPT-IN, not
//        measured: such an arm also gets one CPU leg search in a worker thread, src/legsearch.js: fine cells keeping the
//        fastest state, from the room's first arrival or 400 ticks before the stalled start; one at a time, 900 s each, 80 K states a layer)]
//        [--prefix=<run.eetas | .eetas characters> (the gate benchmark, tools/gatebench.js: the search starts after those
//        inputs; every path begins with them, only finds after the start state count; CPU cells only)]
//        [--rooms=0|1 (an event "room" for every room the one search registers: its cause, the inputs; coarse cells)]
//        [--pL=0.3 (head L, the one search once a route is known: the picks by the lead on the best route's schedule, its
//        share by its yield: LEAD_GRACE_S)] [--pW=0.3 (head W, of the picks head L leaves once a route is known: a
//        cell off the route's (room, tile) schedule by its key-blind lead, the route's first tick at its tile in any room:
//        a skipped room, another coin / switch subset or another path that gets somewhere sooner; 0: off)] [--wPhase=0
//        (time-door levels: 1 keys head W's schedule per (tile, the doors' phase bucket); 0: per tile at any phase)] [--wYield=1
//        (head W's share follows its yield like head L's; 0: --pW all the time)] [--wLead=0 (1: a faster route from a head-W
//        pick restarts head L's grace too; 0: only head L's own routes, as before)]
//        [--lb=1 (the sound lower bound per tile prunes states: lowerBoundTiles)]
//        [--sat=1 (coarse cells: the dead-end brake, SAT_ZONE: a region whose picks stop making new cells sinks behind the
//        rest in heads A and B; 0: the picks as before)] [--satN=20000 (the excess past which a region is braked)]
//        [--satGpu=0 (1: the brake in the GPU random runs too, --gpu=1; off by default: Egg Quest II's first route)]
//        [--deaths=-1 (deaths as moves: -1 auto = where something kills and a checkpoint or 2+ spawns exist
//        (deathMovesFor), 1 wherever something kills (a lone spawn too), 0 off: every death ends its run, as before; a
//        death is kept only where it pays: deathPays in explore(); the progress and done events carry "deaths": {seen,
//        byCost, byNew, dropped, cells}; the GPU random runs get eegpu roll --deaths=1. The reach field keeps its death
//        edges only with deaths as moves (fieldOpts): off, the runs end at a death, so a way through one is none of
//        theirs and the field is built without them)]
//        [--timed=1 (timed killers, src/timed.js: a curse, zombie, fire or poison kills a fixed time after its pickup
//        unless a remover clears it. 1 (or EEAT_TIMED unset): a coarse cell's key has the bucket of the soonest killer's
//        ticks left while one runs (TMD.bucketOf: 8 per duration, at least 8 ticks wide), a new state is dropped only when
//        a cell of the same place in a bucket at least as high got there no later (dominated), a state that can no longer
//        clear its killer (TMD.doomed: a sound bound) is ordered as the death it is (never ruled out), and the one search's
//        bursts start from the cells with the most time slack to the removers (nearestOf); 0: as before (the counts still
//        say how many states with more time left the earliest-arrival rule dropped). On a level without a timed killer
//        every key and cost is the same either way. The progress and done events carry "timed": {on, cells, dominated,
//        droppedMore, doomed})]
//        [--roomDead=1 (coarse cells, deaths as moves off: per room the tiles from which neither the trophy nor a trigger
//        is walkable, roomDead, end a run, except while a trigger's effect is pending (pendingTrigger); never with deaths as
//        moves: a death can take the ball out of a dead end; 0: off)]
//        (EEAT_PICKLOG=1: a 'picklog' event every 30 s, the picks per head, room and zone)
//        [--useful=1 (coarse cells: the useful territory, see USEFUL TERRITORY: cells in a cul-de-sac of their room
//        demoted (head A: CUL_A tiles more; head B: only when its sample holds no other cell), a room whose territory gain
//        is all off the band gets gain 0, a death kept only as the earliest arrival into a cul-de-sac gets no discovery
//        burst and enters the room there (reentry); the progress and done events carry "useful": {culPicks, culCells,
//        zeroed (rooms), culSets, culDropped, reculs}, "deaths" "useless" (such deaths, kept); 0: as before)] [--pickBox=x0,y0,x1,y1 (observation only,
//        test/useful.js: the picks and new cells whose tile is in that box, "pickBox" in the done event)]
//        [--nice=0 (Linux: each worker THREAD lowers its own priority to this nice value; the main thread, the bursts'
//        eegpu it starts and the editor's GPU tools keep theirs. The editor passes 10 next to GPU strategies; before, it
//        reniced the whole process, so the one search's GPU bursts ran at nice 10 too, below every normal process of a
//        shared box: the cycle 7 test's A100, `ps`: goexplore 10, its eegpu explore --prefix 10, the other GPU tools 0)]
//        The progress and done events carry cpuS: the process's CPU seconds (every thread; process.cpuUsage), so a
//        route's time can be told per core-second as well as per wall second on a shared machine.
//        With --stdin=1 and the one search also "route <inputs>": a route found elsewhere (the bound, head L's schedule,
//        its states into every archive; a "route" event, no result).
//        [--rArm=0.5 (with --bursts=1: the route arm's share of the bursts once a route is known, src/routearm.js: from
//        the route's own states, searches aimed by the route's schedule (a time-to-go field to its later tiles) for ways
//        that meet its later points sooner, spliced into verified routes; 0: off)] [--rArmPre=0 (opt-in, e.g. 0.2; before any route: the
//        arm's share on the search's nearest attempt (its landings after a long fall only, each landing state once), a later point
//        of the attempt reached sooner = a shortened attempt: into every archive and a "shortcut" event (the editor splices
//        every route with them); 0 (or EEAT_RARMPRE=0): off)]
//        [--classW=1 (coarse cells: class workers, extra worker threads once a route is known: each avoids one gate of
//        the best route (a coin door first, then a switch / key / effect trigger, then another door: routeGates) for
//        --classS=180 s, bounded by its own routes and --classSlack=2 x the best route; a route whose gates (rank 0-2)
//        differ from the best's is reported even when slower: {"ev":"result","kind":"class",ticks,runTicks,inputs,avoid,
//        gates,desc,best}; 0: none)]. The result and route events carry "gates" (the route's class signature); events
//        "classes" (the best's class and the gates to avoid) and "class" (a class worker's start); done: "classes".
//        With --stdin=1 and the one search also "import <inputs>": another operator's run (the editor's GPU random runs:
//        a room they entered first, a nearer attempt) into every worker's archive, like a burst's attempt.
//        With --stdin=1 and no steer field yet, "steer <RCH4 file>": the steer field, late (the editor's build finished
//        after the search started): head A's second heap from each worker's next chunk of picks; the cells made before
//        get their steer cost when a run improves them or at their next pick; the distances stay the reach field's (as
//        --steerDist=0); an event {"ev":"steer","sec":..,"layers":..,"bodies":..,"coinDP":..,"start":..} (or a warning).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const C = require('./common.js');
const E = C.E;
const EL = require('./eelvl.js');
const RF = require('./reach.js');
const SF = require('./steer.js');
const TMD = require('./timed.js');
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
// the other route classes (--classW, after the first route): each class worker avoids one gate of the best route for
// CLASS_S seconds (--classS), bounded by its own routes and at most CLASS_SLACK x the best route (--classSlack): a route
// of another class (other doors / triggers) is reported even when it is slower (a "result" of kind "class")
// (a class worker starts from the best route's own way up to CLASS_BACK ticks before the gate it avoids: addSeed)
const CLASS_BACK = 60;
// head W (a route known, the path gap: another WAY): a cell off head L's schedule gets the key-blind lead = its tick - the
// best route's first tick at its tile in any room (at any phase of the time doors: --wPhase=1 keys it by the phase
// bucket like head L's, which on Stupid Fox left head W almost nothing: 10,727 vs 5,717 per tile, main 10,529,
// src/out/night/n2_2_head_W.md); WAY_PICK x sqrt(its picks): 25 picks cost 200 ticks of lead (a region ahead but
// walled in by a door the route opened runs out sooner than head L's)
const WAY_PICK = 40;
// (--wYield=1: head W's share follows its yield like head L's: --pW for LEAD_GRACE_S after the first route and after
// every faster route that descends from a head-W pick, then halved every LEAD_HALF_S down to LEAD_FLOOR x --pW;
// --wYield=0: --pW all the time); --wLead=1 (off by default: no clear difference in 6 pairs, n2_2_head_W.md round 4): a
// faster route from a head-W pick (another way) restarts head L's grace too, so
// head L refines the new way at its full share (0: only head L's own routes, as before)
const DEFAULTS = { seconds: 60, workers: 1, seed: 1, depth: 100000, maxTicks: 0, first: 0, stdin: 0, lambda: 2, roll: 40, rolls: 8, keep: 0.85, rArm: 0.5, rArmPre: process.env.EEAT_RARMPRE !== undefined ? +process.env.EEAT_RARMPRE : 0, classW: 1, classS: 180, classSlack: 2,
	stall: 200, refine: 6, maxres: MAXRES, mem: 0, memTotal: 0, maxCells: 0, maxSnaps: 0, prune: 1, pA: 0.5, burst: 8, sample: 16, phase: 50,
	steerDist: 1, dpFirst: 0, mix: 0.5, gpu: 0, batch: 4096, gmem: 0, hmem: 0, share: 0, bursts: 0, rooms: 0, burstS: 15, burstPar: 1, gpuCells: 25, burstCap: 262144, burstOomS: 5, burstSmallS: 300, burstFair: 1, burstServe: 1, stallLadder: 0, legs: 0, lb: 1, pL: 0.3, pW: 0.3, wPhase: 0, wYield: 1, wLead: 0, nice: 0,
	jumpP: 0, jumpNear: 0.75, sat: 1, satN: 20000, satGpu: 0, deaths: -1, dprice: 1, dord: 1, cpkey: process.env.EEAT_CPKEY !== undefined ? +process.env.EEAT_CPKEY : 0, dback: process.env.EEAT_DBACK !== undefined ? +process.env.EEAT_DBACK : 1, dburst: 1, dom: 1, dsub: 0, roomDead: 1, spd: 60, spdMax: 3, spdKids: 1, spdMode: 1, spdSlack: 300, spdG: 1, spdR: 0, useful: 1,
	timed: process.env.EEAT_TIMED !== undefined ? +process.env.EEAT_TIMED : 1 };
// --spd=S (coarse cells; 0 = off): speed in the cell key only where the search is stuck. When this worker's nearest
// distance (the steer field's, else the reach field's) has not dropped by SPD_PROGRESS tiles for S seconds, the frontier
// room (the one whose best cell is nearest, not yet flagged) keys its new cells also by the ball's speed in 1 px/tick
// buckets (round(vx), round(vy)) instead of the vx sign / vy class, so a faster arrival at a tile is a new cell and
// survives (energy pumping, run-ups: Are You A God's U held main's search 17.7 min; 1 px/tick buckets got out in 7.7 s,
// but everywhere they blow the cells up 2.6 K -> 269 K a worker). Every further S seconds of stall flags the next
// frontier room, at most --spdMax; a room made from a flagged room is flagged too (--spdKids=1; the way out of the trap); the flags all
// go when the nearest distance drops by SPD_PROGRESS (the cells made meanwhile stay: they are valid states).
// --spdMode=1 (the default): a flagged room keeps its coarse cells as they are (the earliest state) and next to each one
// a second cell with the FASTEST arrival (the most vx^2 + vy^2; the pick runs' states only): at most 2x the cells (the U
// from its coins=13 state: out in 77 s, as with the buckets; the buckets (--spdMode=0) grew the cells 17-28x and
// their A/B pair from scratch lost: a slower first route). --spdSlack=T (mode 1; 0 = off, default 300): a fast cell takes only arrivals
// at most T ticks after its coarse cell's earliest (default 300; the fastest arrival of ANY lineage made the first routes 1,000-1,700
// ticks slower in both A/B pairs: the lineage that escaped had come the slow way).
const SPD_PROGRESS = 1;
// --gpu=1: the options passed on to `eegpu roll` (paths, and the editor's stop / pause files; --parent is the editor's pid:
// its end closes this process's stdin, which stops the search); --bursts=1 (the one search's GPU operator, src/bursts.js)
// reads tool, cachedir and pausefile too
const GPU_STRINGS = ['tool', 'bin', 'reach', 'stopfile', 'pausefile', 'cachedir', 'launch-ms', 'parent'];
// the text options
const TEXT_OPTS = new Set(['level', 'out', 'steer', 'work', 'burstSteer', 'prefix', 'pickBox', ...GPU_STRINGS]);
const CHUNK = 16;   // picks between two looks at the clock, the shared bound and the stop flag
// a parked worker (stdin "workers K": only the first K search) looks at its port, its seeds, the clock and the stop flag
// every PARK_MS
const PARK_MS = 50;
/** the process's CPU seconds so far (user + system, every thread) */
const cpuSec = () => { const u = process.cpuUsage(); return Math.round((u.user + u.system) / 1e5) / 10; };
// memory: what each piece of a worker's archive costs on the V8 heap (bytes; measured with node --expose-gc on Node 20
// and 24, x64: the objects as goexplore makes them, 200 K at a time): a cell (its object with the boxed double of its
// cost 160 (+ 8: its cul-de-sac flag `u`, 2026-09-28), its Map entry 45, its slot in its room's list 10), an entry of the pick heap (3 arrays; up to 3 per cell
// between two compactions), a path node, a pick's inputs that a live node still uses (the object and its typed array;
// the rolls x roll bytes themselves lie outside the V8 heap, counted too), a snapshot (1150) with its share of the coin
// bitsets it holds (a copy per coin taken: 232 bytes each), a room (its object, text and list), a slot of the snapshot
// queue. The walk cache of the rooms' fields keeps its own count (roomFields).
const B_CELL = 224, B_HEAPE = 32, B_NODE = 72, B_BLOCK = 250, B_SNAP = 1200, B_ROOM = 600, B_QUEUE = 10;
// --steer: a cell's steer cost (its property and boxed double: 160 -> 184 bytes, measured the same way); the steer heap's
// entries count as B_HEAPE each (one worker of the editor's Good Egg search ran out of its heap before they were counted)
const B_SC = 24;
// a level with timed killers (src/timed.js): a cell's ticks left and kind (`tm`, a property added to every cell there: its
// slot in the object's out-of-object properties)
const B_TM = 32;
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
// (EEAT_PICKLOG=1: the picks' log every PICKLOG_S s: an event 'picklog', observation only)
const PICKLOG_S = 30;
// The dead-end brake (--sat=1, coarse cells; --sat=0: the picks as before). A REGION is a room and a zone of SAT_ZONE x
// SAT_ZONE tiles (the GPU runs' cells carry no tile: a room and a band of SAT_BAND tiles of the reach cost). Every pick of a
// cell adds 1 to its region's EXCESS and to its room's, every new cell its runs make takes SAT_CELL off (never below 0: a
// region whose picks make a new cell per SAT_CELL picks or better stays at 0), and a new room or a nearer attempt from the
// pick sets both to 0 (the region recovers). Past SAT_N of excess (satOver) head A's priority gets + SAT_MU x
// sqrt(excess - SAT_N) tiles, head B's cell weight / (1 + sqrt(excess - SAT_N) / SAT_B) and its room weight the same by the
// room's excess: a region whose exploration saturates (Forgotten Helix, main 592fde4, 20 min on the EPYC, 12 workers: head
// A's picks in the hub and in the spectator box by the trophy that its portal (274, 188) leads to, 41% of all 67 M picks,
// made a new cell per 1,500-2,700 picks, head B's in the start area one per 194) sinks behind the rest, however low its
// reach cost, and comes back when something new appears there. The reach field's -1 is still the only prune: this only
// orders. SAT_SLACK: head A puts a cell whose priority rose by more since it was queued back into the queue (lazily, at
// its pop).
const SAT_ZONE = 8, SAT_BAND = 8, SAT_CELL = 20, SAT_MU = 1, SAT_B = 10, SAT_SLACK = 1;
/** the brake of a region (or room) of excess ex: 0 up to n = --satN (SAT_N above; a region is saturated after n picks beyond its
 *  yield), then sqrt(ex - n): head A adds SAT_MU x that (tiles), head B divides by 1 + that / SAT_B. --satN 20000 (the
 *  dead-end-traps study's gate benchmark, deterministic CPU: 208 / 230 gates at 20000 vs 205 / 230 at 200 (oct#4 lost) and
 *  205 / 230 on main) */
const satOver = (ex, n) => (ex > n ? Math.sqrt(ex - n) : 0);
// (the memory of a region's excess: an entry of its room's Map, bytes)
const B_SATZ = 48;
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
/** the reach field's options for this search (after settle: a.deathMoves): with deaths as moves the field keeps its death
 *  edges (a death is a move of this search, so a way through one is a way); without them (--deaths=0, or auto where a
 *  death cannot move the ball) the runs end at a death, so a way through one is no way of theirs: the field is built
 *  without death edges (src/reach.js opts.deaths: a state only a death leads to the trophy from is cut off, its runs end
 *  there) */
const fieldOpts = (a) => {
	if (a.deathMoves === undefined) throw new Error('fieldOpts before settle: deaths as moves not decided');
	return a.deathMoves ? {} : { deaths: false };
};
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
	// deaths as moves: auto (-1) where something kills and a death can take the ball somewhere else than its start (a
	// checkpoint, or 2+ spawns: deathMovesFor), 1 wherever something kills (also back to a lone spawn), 0 never
	a.deathMoves = a.deaths === 1 ? deathsOf(L) !== null : a.deaths === 0 ? false : deathMovesFor(L);
	return a;
}

/** --prefix (the gate benchmark, tools/gatebench.js): the inputs (masks) the search starts after (an .eetas file, or
 *  .eetas characters), or null. Every cell's path begins with them, so routes, rooms and bursts carry whole runs */
function prefixOf(a) {
	if (!a.prefix) return null;
	const ms = /\.eetas$/i.test(a.prefix) ? C.readEetas(a.prefix) : Uint8Array.from(a.prefix, (ch) => (ch.charCodeAt(0) - 48) & 31);
	return ms.length ? ms : null;
}
/** the level file a verdict is about (end "unreachable": the reach field rules the start out, a proof about a FILE): its
 *  name and md5, so a wrong file shows (src/levelcheck.js; null when it cannot be read) */
function levelFileOf(a) {
	try {
		const f = a.file || C.levelData(a.level);
		return `${path.basename(f)}, md5 ${require('./levelcheck.js').md5(fs.readFileSync(f))}`;
	} catch (e) { return null; }
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
/** one word into a room / discrete hash (roomOf, discreteOf): h = (h ^ v) x 0x5bd1e995, then h ^= h >>> 13 */
const mixW = (h, v) => { h = Math.imul(h ^ v, 0x5bd1e995); return h ^ (h >>> 13); };

/**
 * The archive's cell index: a Map of cell key (a 53-bit number, hashKV's) -> cell with Map's semantics where explore
 * uses them (get, set, delete, size, values(), entries in insertion order; an entry deleted while its iteration runs is
 * skipped, a key deleted and set again goes to the end), without Map's costs: its double keys were a heap number each
 * and a hash of their bits per lookup, at every simulated tick of the one search. Open addressing (linear probing,
 * backward-shift deletion: no tombstones) over typed arrays: slot -> entry index; the entries in insertion order (keys in
 * a Float64Array, values in an array; a deleted entry's value undefined, compacted in order when they pile up, never
 * while an iteration runs: only set compacts and grows, and explore sets no cell while it iterates). The same order as
 * a Map, so the sweeps and head L's pushes go in the same order and the search is the same (test/fastpath.js).
 */
class CellMap {
	constructor() {
		this.size = 0;
		this.n = 0;   // entries appended (the deleted too)
		this.ek = new Float64Array(1 << 12);
		this.ev = new Array(1 << 12);
		this.mask = (1 << 13) - 1;
		this.tab = new Int32Array(1 << 13).fill(-1);
	}
	/** the home slot of key k: its high lane (hashKV: fmix of the first 32-bit lane x 2^21 + 21 bits of the second) */
	home(k) { return ((k / 2097152) >>> 0) & this.mask; }
	get(k) {
		const tab = this.tab, ek = this.ek, m = this.mask;
		for (let i = this.home(k); ; i = (i + 1) & m) {
			const e = tab[i];
			if (e < 0) return undefined;
			if (ek[e] === k) return this.ev[e];
		}
	}
	has(k) { return this.get(k) !== undefined; }
	set(k, v) {
		const tab = this.tab, ek = this.ek, m = this.mask;
		let i = this.home(k);
		for (; ; i = (i + 1) & m) {
			const e = tab[i];
			if (e < 0) break;
			if (ek[e] === k) { this.ev[e] = v; return this; }
		}
		if (this.n === this.ek.length) { this.makeRoom(); return this.set(k, v); }
		const e = this.n++;
		this.ek[e] = k; this.ev[e] = v;
		tab[i] = e;
		if (++this.size * 2 > m + 1) this.rehash((m + 1) * 2);
		return this;
	}
	delete(k) {
		const tab = this.tab, ek = this.ek, m = this.mask;
		let i = this.home(k), e;
		for (; ; i = (i + 1) & m) {
			e = tab[i];
			if (e < 0) return false;
			if (ek[e] === k) break;
		}
		this.ev[e] = undefined;
		this.size--;
		// backward-shift deletion: the entries after i in its probe run that may move into the hole do
		for (let j = (i + 1) & m; ; j = (j + 1) & m) {
			const f = tab[j];
			if (f < 0) break;
			const h = this.home(ek[f]);
			if (i <= j ? (h <= i || h > j) : (h <= i && h > j)) { tab[i] = f; i = j; }
		}
		tab[i] = -1;
		return true;
	}
	/** the entry arrays are full: drop the deleted entries (in order) when they are at least a quarter, else grow */
	makeRoom() {
		if (this.n - this.size >= this.n / 4) {
			let w = 0;
			for (let r = 0; r < this.n; r++) if (this.ev[r] !== undefined) { this.ek[w] = this.ek[r]; this.ev[w] = this.ev[r]; w++; }
			for (let r = w; r < this.n; r++) this.ev[r] = undefined;
			this.n = w;
		} else {
			const k2 = new Float64Array(this.ek.length * 2);
			k2.set(this.ek);
			this.ek = k2;
			this.ev.length = k2.length;
		}
		this.rehash(this.mask + 1);
	}
	rehash(cap) {
		this.mask = cap - 1;
		const tab = this.tab = new Int32Array(cap).fill(-1), m = this.mask, ek = this.ek, ev = this.ev;
		for (let e = 0; e < this.n; e++) {
			if (ev[e] === undefined) continue;
			let i = this.home(ek[e]);
			while (tab[i] >= 0) i = (i + 1) & m;
			tab[i] = e;
		}
	}
	* values() { for (let e = 0; e < this.n; e++) { const v = this.ev[e]; if (v !== undefined) yield v; } }
	* keys() { for (let e = 0; e < this.n; e++) if (this.ev[e] !== undefined) yield this.ek[e]; }
	* entries() { for (let e = 0; e < this.n; e++) { const v = this.ev[e]; if (v !== undefined) yield [this.ek[e], v]; } }
	[Symbol.iterator]() { return this.entries(); }
}

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
 * counterRelevance(L) -> {gold, blue, cut: {gold, blue}, why: {gold, blue}} (cached per level): whether a coin count can
 * matter on the way to the trophy (the room keys' readers, playbook P3 / R3). A counter's readers are its doors and gates
 * (gold 43 / 165, blue 213 / 214); the walk (8-way, no corner cut between two walls, through portals the way they send the
 * ball, every other door and gate open, killing tiles closed unless the level has a protection effect) from the start and
 * every spawn point reaches a set of tiles with every door open; with the counter's readers walled it reaches fewer: the
 * CUT. The counter is irrelevant only when (1) the cut holds nothing of interest (no trophy, no checkpoint, no trigger
 * the room key reads: an effect, a key, a switch or reset some door reads, coins of the other colour where their doors
 * stand, a crown where crown doors stand, a team effect where team doors stand) and (2) its readers are no shortcut:
 * every region of readers and cut tiles is a pocket, the places next to it that the walled walk reaches lie within
 * a few steps of each other around it (Stupid Fox's coin door at 10 cuts only its own 3 tiles, but the way around it is
 * the level's other route: a door the route passes, whose count the search must work toward; cycle 6 merged its coins
 * 0-9 and the search lost it). Its count then only decides which of its own doors are open, and they lead nowhere the
 * route needs: an irrelevant counter keys a room by the number of its thresholds met (doors and gates flip at the same
 * counts: the doors' exact state), not by the count (Good Egg: its blue doors at 31 / 32 close a pocket with a crown and
 * no crown door; every blue coin made a new room, 118,758 of the 118,854 rooms of an hour's search from the level alone,
 * src/out/ge_anat). A walk is no physics (a door that is a floor when shut is not seen), so this only merges rooms whose
 * doors are shut alike; a relevant counter keys its count, as before. EEAT_ROOMREL=0: every counter relevant.
 */
const RELV = new WeakMap();
const KEY_TRIG = new Set([6, 7, 8, 408, 409, 410]);
const KEY_DOOR = new Set([23, 24, 25, 26, 27, 28, 1005, 1006, 1007, 1008, 1009, 1010]);
function counterRelevance(L) {
	const had = RELV.get(L);
	if (had) return had;
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags, lk = L.lookup0;
	const out = { gold: true, blue: true, cut: { gold: 0, blue: 0 }, why: { gold: 'no reader', blue: 'no reader' } };
	let goldR = false, blueR = false, prot = false, crownD = false, teamD = false, keyD = false;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id === 43 || id === 165) goldR = true;
		else if (id === 213 || id === 214) blueR = true;
		else if (id === 420) prot = true;
		else if (id === 1094 || id === 1095) crownD = true;
		else if (id === 1027 || id === 1028) teamD = true;
		else if (KEY_DOOR.has(id)) keyD = true;
	}
	if (process.env.EEAT_ROOMREL === '0' || (!goldR && !blueR)) { RELV.set(L, out); return out; }
	const SR = switchReaders(L);
	const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
	const wall = new Uint8Array(N), deadly = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const id = fg[i], f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) === 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0) wall[i] = 1;
		if (!prot && id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
	}
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
	const seeds = [];
	{ const s = new E.EESim(L); s.reset(); seeds.push(Math.min(N - 1, Math.max(0, (Math.trunc(s.py + 8) >> 4) * W + (Math.trunc(s.px + 8) >> 4)))); }
	for (let k = 0; k < L.spawnsX.length; k++) { const t = L.spawnsY[k] * W + L.spawnsX[k]; if (t >= 0 && t < N) seeds.push(t); }
	const q = new Int32Array(N), dist = new Int32Array(N);
	const step = (t, pass, visit) => {
		const x = t % W, y = (t / W) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (!pass(j)) continue;
				if (dx && dy && wall[y * W + xx] && wall[yy * W + x]) continue;
				visit(j);
			}
		}
	};
	const walk = (blocked) => {
		const seen = new Uint8Array(N);
		let qt = 0;
		for (const t of seeds) if (!seen[t]) { seen[t] = 1; q[qt++] = t; }
		const pass = (j) => !seen[j] && !wall[j] && !deadly[j] && !blocked(fg[j]);
		const visit = (j) => { seen[j] = 1; q[qt++] = j; };
		for (let qh = 0; qh < qt; qh++) {
			const t = q[qh];
			const ex = exits.get(t);
			if (ex) for (const e of ex) if (pass(e)) visit(e);
			step(t, pass, visit);
		}
		return seen;
	};
	/** a tile the room key reads when touched (the counter's own coins aside) */
	const interest = (i, own) => {
		const id = fg[i];
		if (id === 121 || id === 360) return true;
		if (!TRIGGER_IDS.has(id) || own.has(id)) return false;
		if (id === 100 || id === 110) return goldR;
		if (id === 101 || id === 111) return blueR;
		if (id === 5) return crownD;
		if (id === 423) return teamD;
		if (KEY_TRIG.has(id)) return keyD;
		if (id === 113 || id === 1619) return lk[i] === 1000 ? SR.purple.size > 0 : SR.purple.has(lk[i]);
		if (id === 467 || id === 1620) return lk[i] === 1000 ? SR.orange.size > 0 : SR.orange.has(lk[i]);
		return true;
	};
	const all = walk(() => false);
	const test = (readers, own) => {
		const w = walk((id) => readers.has(id));
		let cut = 0;
		for (let i = 0; i < N; i++) {
			if (!all[i] || w[i]) continue;
			cut++;
			if (interest(i, own)) return { cut, why: `the cut holds ${fg[i]} at ${i % W},${(i / W) | 0}` };
		}
		// (2) no shortcut: per region of readers and cut tiles (8-connected), the places next to it the walled walk
		// reaches, all within the region's size + SHORTCUT steps of the first one around it
		const reg = new Int32Array(N).fill(-1), rq = new Int32Array(N);
		const inR = (i) => all[i] && !w[i] || readers.has(fg[i]);
		let nr = 0;
		for (let i0 = 0; i0 < N; i0++) {
			if (reg[i0] >= 0 || !inR(i0) || wall[i0]) continue;
			let rt = 0;
			reg[i0] = nr; rq[rt++] = i0;
			const edge = new Set();
			for (let rh = 0; rh < rt; rh++) {
				step(rq[rh], (j) => !wall[j], (j) => {
					if (reg[j] < 0 && inR(j)) { reg[j] = nr; rq[rt++] = j; }
					else if (reg[j] < 0 && w[j]) edge.add(j);
				});
			}
			nr++;
			if (edge.size < 2) continue;
			const lim = rt + SHORTCUT;
			const ed = [...edge];
			dist.fill(-1);
			let qt = 0;
			dist[ed[0]] = 0; q[qt++] = ed[0];
			const pass = (j) => dist[j] < 0 && w[j] && !wall[j] && !deadly[j] && !readers.has(fg[j]);
			for (let qh = 0; qh < qt; qh++) {
				const t = q[qh], d = dist[t] + 1;
				if (d > lim) break;
				const visit = (j) => { dist[j] = d; q[qt++] = j; };
				const ex = exits.get(t);
				if (ex) for (const e of ex) if (pass(e)) visit(e);
				step(t, pass, visit);
			}
			for (const j of ed) if (dist[j] < 0) return { cut, why: `its readers by ${j % W},${(j / W) | 0} are a shortcut` };
		}
		return { cut, why: null };
	};
	if (goldR) { const r = test(new Set([43, 165]), new Set([100, 110])); out.gold = r.why !== null; out.cut.gold = r.cut; out.why.gold = r.why || 'a pocket of nothing'; }
	if (blueR) { const r = test(new Set([213, 214]), new Set([101, 111])); out.blue = r.why !== null; out.cut.blue = r.cut; out.why.blue = r.why || 'a pocket of nothing'; }
	RELV.set(L, out);
	return out;
}
/** counterRelevance: a region of a counter's readers is a pocket when the places next to it are this many steps (+ its
 *  own size) apart at most around it */
const SHORTCUT = 12;

/**
 * switchReaders(L) -> {purple: Map(id -> {doors, gates}), orange: ...}: the switch ids that open or shut something (a door
 * or a gate of that id; a reset block's id 1000 resets all). A switch no door or gate reads changes nothing but its own
 * state: the room keys leave it out (Infinity Pain: 36 duplicate purple=[0] rooms). A MONO id has doors and no gate:
 * turning it on only opens (dominance, roomOf dom).
 */
function switchReaders(L) {
	const W = L.width, N = W * L.height, fg = L.fg, lk = L.lookup0;
	const purple = new Map(), orange = new Map();
	const add = (m, id, gate) => { let r = m.get(id); if (!r) m.set(id, r = { doors: 0, gates: 0 }); if (gate) r.gates++; else r.doors++; };
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id === 184 || id === 185) add(purple, lk[i], id === 185);
		else if (id === 1079 || id === 1080) add(orange, lk[i], id === 1080);
	}
	return { purple, orange };
}

/**
 * roomOf(L, opts) -> {key(sim) (int32), desc(sim) (text), cause(sim) {sub, keys}, byTrigger(a, b), dom(sim) {cls, mask},
 * mono (the mono switches: [purple ids], [orange ids]), rel (counterRelevance)}: the room, the part of the discrete
 * state that opens or shuts doors or changes the physics: the keys active, the effects (protection, curse, zombie, fire,
 * poison, levitation, low gravity; the multijump, jump, speed and gravity values), the purple and orange switches on
 * that some door or gate reads (switchReaders), whether the time doors are open, and only where a door reads them: the
 * team (team doors 1027 / 1028), the coin and blue-coin counts (coin doors and gates 43 / 165, 213 / 214; a gate's shown
 * count too; a counter no reader on the way to the trophy needs by the number of its thresholds met: counterRelevance),
 * the crowns (crown doors 1094 / 1095, 1152 / 1153: what the doors read, _collide_crown and _collide_silver_crown), the
 * deaths (death doors and gates). Coin identities, secrets, the checkpoint, key timers and portal draws are left out
 * (they would split every room into thousands; merged cells cost completeness only: every route is replayed).
 * opts.legacy: the key as the GPU's rollRoom computes it (every switch that is on, every counter's count: goexplore.js
 * --gpu=1 keeps its archive by the GPU's keys; test/gpulaunch.js).
 * dom(sim): the room's dominance class (cls: the key without the time doors and without the MONO switches: ids with
 * doors and no gate, so turning one on only opens) and its mask (the mono switches on, a bit each). Rooms of one class
 * and mask are one novelty group (the time doors' two states: every room twice); a group whose mask is a strict subset
 * of a known group's of its class is DOMINATED (domIndex): everything it can reach, the other reaches with more doors
 * open (turning a mono switch off only shuts). A walk's view (an open door is no floor), so dominance only orders.
 */
function roomOf(L, opts = {}) {
	let team = false, coins = false, blue = false, crown = false, silver = false;
	for (let i = 0; i < L.width * L.height; i++) {
		const id = L.fg[i];
		if (id === 1027 || id === 1028) team = true;
		else if (id === 43 || id === 165) coins = true;
		else if (id === 213 || id === 214) blue = true;
		else if (id === 1094 || id === 1095) crown = true;
		else if (id === 1152 || id === 1153) silver = true;
	}
	const legacy = !!opts.legacy;
	const rel = legacy ? { gold: true, blue: true, cut: { gold: 0, blue: 0 } } : counterRelevance(L);
	const SR = switchReaders(L);
	// (the switch ids the keys read: every one in the legacy key, else those some door or gate reads)
	const readP = legacy ? null : SR.purple, readO = legacy ? null : SR.orange;
	const monoP = [], monoO = [];
	for (const [id, r] of SR.purple) if (r.doors > 0 && r.gates === 0) monoP.push(id);
	for (const [id, r] of SR.orange) if (r.doors > 0 && r.gates === 0) monoO.push(id);
	monoP.sort((x, y) => x - y); monoO.sort((x, y) => x - y);
	const bitP = new Map(monoP.map((id, k) => [id, k])), bitO = new Map(monoO.map((id, k) => [id, monoP.length + k]));
	const nMono = monoP.length + monoO.length, words = (nMono + 31) >> 5;
	const cTh = L.coinDoorThresholds || new Int32Array(0), bTh = L.blueCoinDoorThresholds || new Int32Array(0);
	/** the thresholds (doors and gates) a count has met */
	const met = (th, v) => { let n = 0; while (n < th.length && th[n] <= v) n++; return n; };
	// (the sum of the switches on that the key reads, without the mono ones (bits) in the dominance class: a sum mod
	// 2^32, so the Map's order does not matter; forEach makes no entry arrays)
	const onSum = (m, salt, read, bits) => {
		let s = 0;
		m.forEach((v, id) => { if (v === true && (read === null || read.has(id)) && (bits === null || !bits.has(id))) s = (s + fmix((id ^ salt) | 0)) | 0; });
		return s;
	};
	const onList = (m, read) => { const a = []; for (const [id, v] of m) if (v === true && (read === null || read.has(id))) a.push(id); return a.sort((x, y) => x - y); };
	// (mode 0: the room key; 1: the part only the ball's own touches change: without the keys, which expire, and the time
	// doors, which flip on the clock; 2: the dominance class: the key without the time doors and the mono switches. The
	// live state's room at every simulated tick of the one search: mixW, a function of the module, instead of a closure
	// over h per call; the same words in the same order)
	const hash = (sim, mode) => {
		let h = 0x3c6ef372;
		if (mode !== 1) h = mixW(h, sim._keysMask);
		h = mixW(h, (crown && sim._collide_crown ? 1 : 0) | (sim.low_gravity ? 2 : 0) | (sim.is_invulnerable ? 4 : 0) | (silver && sim._collide_silver_crown ? 8 : 0) |
			(sim.is_cursed ? 16 : 0) | (sim.is_zombie ? 32 : 0) | (sim.is_on_fire ? 64 : 0) | (sim.is_poisoned ? 128 : 0) | (sim.has_levitation ? 256 : 0) |
			(mode === 0 && L.hasTimeDoors && sim._timedoor_state ? 512 : 0));
		h = mixW(h, sim.max_jumps); h = mixW(h, sim.jump_boost); h = mixW(h, sim.speed_boost); h = mixW(h, sim.flip_gravity);
		if (team) h = mixW(h, sim.team);
		if (coins) h = mixW(h, rel.gold ? sim.coins : met(cTh, sim.coins));
		if (L.hasCoinGate) h = mixW(h, rel.gold ? sim._show_coin_gate : met(cTh, sim._show_coin_gate));
		if (blue) h = mixW(h, rel.blue ? sim.blue_coins : met(bTh, sim.blue_coins));
		if (L.hasBlueCoinGate) h = mixW(h, rel.blue ? sim._show_blue_coin_gate : met(bTh, sim._show_blue_coin_gate));
		if (L.hasDeathDoor) h = mixW(h, sim.deaths);
		if (L.hasDeathGate) h = mixW(h, sim._show_death_gate);
		const bp = mode === 2 ? bitP : null, bo = mode === 2 ? bitO : null;
		if (sim._switches.size !== 0) { const s = onSum(sim._switches, 0x1234567, readP, bp); if (legacy || s !== 0) h = mixW(h, s); }
		if (sim._oswitches.size !== 0) { const s = onSum(sim._oswitches, 0x7654321, readO, bo); if (legacy || s !== 0) h = mixW(h, s); }
		return h | 0;
	};
	const key = (sim) => hash(sim, 0);
	/** what a room change's cause is judged by: {sub (the key without keys and time doors), keys} */
	const cause = (sim) => ({ sub: hash(sim, 1), keys: sim._keysMask });
	/** a change from a room of cause a to one of cause b came from a trigger the ball touched (a key picked up, an
	 *  effect, switch, coin, ...), not from the clock (a time door flipping, a key expiring) */
	const byTrigger = (a, b) => !a || !b || a.sub !== b.sub || (b.keys & ~a.keys) !== 0;
	/** the dominance class and mask (see above) */
	const dom = (sim) => {
		const mask = new Int32Array(words);
		if (nMono) {
			for (const [id, v] of sim._switches) if (v === true) { const b = bitP.get(id); if (b !== undefined) mask[b >> 5] |= 1 << (b & 31); }
			for (const [id, v] of sim._oswitches) if (v === true) { const b = bitO.get(id); if (b !== undefined) mask[b >> 5] |= 1 << (b & 31); }
		}
		return { cls: hash(sim, 2), mask };
	};
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
		if (coins) { if (rel.gold) p.push(`coins=${sim.coins}`); else { const n = met(cTh, sim.coins); if (n) p.push(`coins>=${cTh[n - 1]}`); } }
		if (blue) { if (rel.blue) p.push(`bluecoins=${sim.blue_coins}`); else { const n = met(bTh, sim.blue_coins); if (n) p.push(`bluecoins>=${bTh[n - 1]}`); } }
		if (L.hasDeathDoor) p.push(`deaths=${sim.deaths}`);
		const s = onList(sim._switches, readP), o = onList(sim._oswitches, readO);
		if (s.length) p.push(`purple=[${s.join(',')}]`);
		if (o.length) p.push(`orange=[${o.join(',')}]`);
		if (crown && sim._collide_crown) p.push('crown');
		if (silver && sim._collide_silver_crown) p.push('silvercrown');
		return p.join(' ') || '(start)';
	};
	/** a change from dominance info d0 to d1 only turned mono switches off (the same class, a strict subset: into a room
	 *  the one before dominates; roomOf dom) */
	const shrinks = (d0, d1) => d0.cls === d1.cls && maskIn(d1.mask, d0.mask) && !maskEq(d1.mask, d0.mask);
	return { key, desc, cause, byTrigger, dom, shrinks, mono: [monoP, monoO], rel, words };
}

/** a (Int32Array mask) within b: every bit of a is in b */
const maskIn = (a, b) => { for (let k = 0; k < a.length; k++) if ((a[k] & ~b[k]) !== 0) return false; return true; };
const maskEq = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false; return true; };
/**
 * domIndex() -> {groupOf({cls, mask}) -> group, list (the groups not dominated), stats()}: the novelty groups and their
 * dominance (roomOf dom). A group = the rooms of one class and mask {cls, mask, dom, rooms, picks, gain, troOk}; per
 * class the maximal masks (an antichain): a new group whose mask is a strict subset of one of them is dominated at once,
 * and one that is a strict superset of some makes those dominated (for good: a mask once exceeded stays exceeded). The
 * novelty picks (head B), the discovery bursts (head C), the sources and the GPU bursts' rooms leave dominated groups
 * out; head A (the cost heaps) does not look at groups.
 */
function domIndex() {
	const groups = new Map(), maxi = new Map(), list = [];
	let dominated = 0;
	const drop = (g) => {
		if (g.dom) return;
		g.dom = true; dominated++;
		const i = g.li;
		if (i >= 0) { const last = list.pop(); if (last !== g) { list[i] = last; last.li = i; } g.li = -1; }
	};
	const groupOf = (d) => {
		let ks = String(d.cls);
		for (let k = 0; k < d.mask.length; k++) ks += ':' + d.mask[k];
		let g = groups.get(ks);
		if (g) return g;
		g = { key: ks, cls: d.cls, mask: d.mask, dom: false, rooms: [], picks: 0, gain: 0, troOk: false, li: -1 };
		groups.set(ks, g);
		let M = maxi.get(d.cls);
		if (!M) maxi.set(d.cls, M = []);
		for (const h of M) if (maskIn(d.mask, h.mask) && !maskEq(d.mask, h.mask)) { g.dom = true; dominated++; return g; }
		for (let k = M.length - 1; k >= 0; k--) if (maskIn(M[k].mask, d.mask)) { drop(M[k]); M.splice(k, 1); }
		M.push(g);
		g.li = list.length; list.push(g);
		return g;
	};
	return { groupOf, list, stats: () => ({ groups: groups.size, dominated, maximal: list.length }) };
}

// USEFUL TERRITORY (roomUseful; the playbook's P1 (c) / (d), 2026-09-28; the user on Forgotten Helix: "it keeps going
// into the viewing rooms still ... the viewing room leads to nowhere!!!"). A room's walk reaches territory the room
// cannot use: a hub of portals into "viewing rooms" behind coin doors whose own portals lead back (not a physical dead
// end: the dead-end prune does not cut them), a pocket behind a door the room cannot open, the minis behind the ball
// whose coins are taken. On Forgotten Helix (main 230e6e3, 8 workers, 100 s) 35% of head A's picks were in the viewing
// boxes (the door-16 box by the trophy: 5 of 10 tiles, where the door-blind reach field puts the trophy near) and 49% on
// the hub's bottom around them; the wall breaker's first two starting points were there too.
//   The room's TARGETS: the trigger components its walk reaches whose touch changes the room by a trigger (bursts.js
// infoOf's engine test: the room's entry state, the ball on the tile, one tick without input; a coin taken, an effect
// the ball has already, the room's own switch state: no target), and the trophies.
//   CUL-DE-SACS (`cul`): the tiles on no SIMPLE way between the room's entry and a target: the walk as an undirected graph
// (8-way, no corner cut between two walls, portals both ways), its block-cut tree rooted at the entry, the blocks whose
// subtree holds no target. The ball's centre moves between neighbouring tiles of this walk, so a way that enters a
// cul-de-sac leaves it by the tile it came in through: the visit reaches nothing (a death inside one aside).
//   The BAND (`off` = off it): the tiles within max(SL_MIN, SL_F x their walk distance from the entry) steps of a
// shortest walk from the entry to a target (a multi-source search from the targets, each started at minus its own
// distance from the entry). Off it: a detour that leads nowhere nearer a target, e.g. a viewing room behind a coin door
// whose portal leads back to the hub (a loop, no cul-de-sac); the walk is gravity-blind, so a physical way (a ramp for a
// shaft) may be off it too.
//   Cells in a cul-de-sac of their room (c.u = 2) are DEMOTED, never pruned (the reach field's -1 stays the only prune):
// CUL_A more tiles in head A's priority, no head B pick (its sample's cells), no nearest attempt, no source, no room's
// lowest-cost cell and no burst start while another cell is (head B: its weight divided by 10 left the Helix viewing
// boxes 10.9-14.0% of its picks: a fresh box cell outweighed the much-picked cells outside). (The known TASes spend
// 0-0.6% of their ticks in a cul-de-sac of their room, 0.7-22% off its band: FV 17%, NC Naos 22%: the band is no
// ground to demote a cell on.) A room's
// USEFUL GAIN is its territory gain on the band: a room whose useful gain is 0 (the territory it opens is all off the
// band: a viewing room behind a coin door, a sealed pocket) keeps its raw gain in `graw` and gets gain 0: no novelty
// weight (head B), no discovery burst (head C), no "room" source at once and no gain for the editor's relay, wall
// breaker and its stall clock. A death kept only as the earliest arrival (deathPays) that respawns in a cul-de-sac is kept (no discovery burst)
// and enters the room there (reentry below), never dropped: the walk is gravity-blind, and a checkpoint pocket left only
// by a fall is one. A room
// entered again at one of its cul-de-sac tiles (a run, an import, a seed: the clock's rooms, time doors and keys running
// out, are entered wherever the ball is) gets its cul-de-sacs again with its entries as terminals (reentry, REENTRY_MAX).
const CUL_A = 2000, SL_MIN = 6, SL_F = 0.25, REENTRY_MAX = 16;
/**
 * roomUseful(L) -> {of(sim, band, extra) -> {cul, off, targets, walked}}: the useful territory of the room the live state
 * is in, from its tile (see USEFUL TERRITORY above): cul / off bitsets (a bit per tile; null when no tile is in one), off
 * only with band; extra: more tiles the cul-de-sacs must connect like targets (the room's other entries). The live state is
 * restored exactly after the targets' tests.
 */
function roomUseful(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const RM = roomOf(L), TR = require('./bursts.js').triggersOf(L);
	const wall = new Uint8Array(N), deadly = new Uint8Array(N), tro = new Uint8Array(N), dIdx = new Int32Array(N).fill(-1), doors = [];
	for (let i = 0; i < N; i++) {
		const id = fg[i], f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & 1) !== 0 && (f & 16) !== 0) { dIdx[i] = doors.length; doors.push(i); }
		else if ((f & 1) !== 0 && (f & (2 | 4 | 8)) === 0) wall[i] = 1;
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
		if (id === 121) tro[i] = 1;
	}
	// portals: tile -> its exits (forward) and exit -> the portals that send the ball there (reverse)
	const exits = new Map(), srcs = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const s = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || s < 0) continue;
			const ex = L.portalsById.get(L.pTarget[s]);
			if (!ex) continue;
			const list = [];
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N && j !== i && !list.includes(j)) list.push(j); }
			if (!list.length) continue;
			exits.set(i, Int32Array.from(list));
			for (const j of list) { let l = srcs.get(j); if (!l) srcs.set(j, l = []); l.push(i); }
		}
	}
	for (const [k, v] of srcs) srcs.set(k, Int32Array.from(v));
	const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
	const shut = new Uint8Array(doors.length);
	const dE = new Int32Array(N), q = new Int32Array(N), g = new Int32Array(N), disc = new Int32Array(N), low = new Int32Array(N), par = new Int32Array(N),
		sub = new Int32Array(N), term = new Uint8Array(N), fk = new Int32Array(N), vst = new Int32Array(N), frame = new Int32Array(N);
	let stamp = new Int32Array(N), gen = 0, prot = false, entry = 0;
	const inp0 = new E.EEInput(), tested = new Map();
	const pass = (i) => i === entry || (!wall[i] && (dIdx[i] < 0 || !shut[dIdx[i]]) && (prot || !deadly[i]));
	/** the walk's 8-way step from tile t in direction k: the tile, or -1 (off the level, not passable, a corner cut, and with
	 *  walked: outside this walk) */
	const step8 = (t, k, walked) => {
		const x = t % W, y = (t / W) | 0, xx = x + DX[k], yy = y + DY[k];
		if (xx < 0 || yy < 0 || xx >= W || yy >= H) return -1;
		const j = yy * W + xx;
		if (walked ? stamp[j] !== gen : !pass(j)) return -1;
		if (DX[k] && DY[k] && wall[y * W + xx] && wall[yy * W + x]) return -1;
		return j;
	};
	/** the undirected walk's neighbour k of u (0-7 the steps, then the portal exits, then the portals into u): a tile of
	 *  this walk, -1 (none there), -2 (no more) */
	const nbr = (u, k) => {
		if (k < 8) return step8(u, k, true);
		const ex = exits.get(u), ne = ex ? ex.length : 0;
		if (k < 8 + ne) { const j = ex[k - 8]; return stamp[j] === gen ? j : -1; }
		const sp = srcs.get(u), ns = sp ? sp.length : 0;
		if (k < 8 + ne + ns) { const j = sp[k - 8 - ne]; return stamp[j] === gen ? j : -1; }
		return -2;
	};
	const of = (sim, band, extra) => {
		if (++gen > 2e9) { stamp = new Int32Array(N); gen = 1; }
		prot = !!sim.is_invulnerable;
		for (let k = 0; k < doors.length; k++) shut[k] = sim.is_tile_solid_now(doors[k] % W, (doors[k] / W) | 0) ? 1 : 0;
		const e = Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		entry = e;
		// the walk from the entry (roomFields' rules), its distances
		let qh = 0, qt = 0;
		stamp[e] = gen; dE[e] = 0; q[qt++] = e;
		while (qh < qt) {
			const t = q[qh++], d = dE[t] + 1;
			const ex = exits.get(t);
			if (ex) for (let k = 0; k < ex.length; k++) { const j = ex[k]; if (stamp[j] !== gen && pass(j)) { stamp[j] = gen; dE[j] = d; q[qt++] = j; } }
			for (let k = 0; k < 8; k++) { const j = step8(t, k, false); if (j >= 0 && stamp[j] !== gen) { stamp[j] = gen; dE[j] = d; q[qt++] = j; } }
		}
		const walked = qt;
		// the targets: the trigger components the walk reaches whose touch changes the room by a trigger (a coin taken in the
		// room's state is none; the test's own touch takes it: the room's state first), and the trophies
		const snap = sim.snapshot(), cz0 = RM.cause(sim);
		tested.clear();
		let targets = 0, restored = true;
		for (let k = 0; k < walked; k++) {
			const t = q[k];
			term[t] = 0;
			if (tro[t]) { term[t] = 1; targets++; continue; }
			const c = TR.comp[t];
			if (c < 0) continue;
			if (TR.eaten[c]) { if (!restored) { sim.restore(snap); restored = true; } if (sim.is_coin_collected(t % W, (t / W) | 0)) continue; }
			let v = tested.get(c);
			if (v === undefined) {
				if (!restored) sim.restore(snap);
				restored = false;
				sim.px = (t % W) * 16; sim.py = ((t / W) | 0) * 16; sim.speed_x = 0; sim.speed_y = 0;
				try { sim.tick(inp0); v = sim.is_dead || RM.byTrigger(cz0, RM.cause(sim)); } catch (err) { v = true; }
				tested.set(c, v);
			}
			if (v) { term[t] = 1; targets++; }
		}
		if (!restored) sim.restore(snap);
		// (the room's other entries: terminals of the cul-de-sac test, not targets of the band)
		const ext = [];
		if (extra) for (const x of extra) if (x >= 0 && x < N && stamp[x] === gen && !term[x]) { term[x] = 1; ext.push(x); }
		// the cul-de-sacs: the block-cut tree of the walk (undirected), rooted at the entry (an iterative Tarjan: a block
		// closes when low[u] >= disc[p]; its terminals, its vertices' own and those of the blocks hanging at them, go up to p)
		let cul = null, nCul = 0, time = 0, fs = 0, vs = 0;
		for (let k = 0; k < walked; k++) { const t = q[k]; disc[t] = 0; sub[t] = 0; }
		disc[e] = low[e] = ++time; par[e] = -1; fk[e] = 0; frame[fs++] = e; vst[vs++] = e;
		while (fs > 0) {
			const u = frame[fs - 1];
			let pushed = false;
			for (;;) {
				const v = nbr(u, fk[u]++);
				if (v === -2) break;
				if (v < 0) continue;
				if (disc[v] === 0) { disc[v] = low[v] = ++time; par[v] = u; fk[v] = 0; frame[fs++] = v; vst[vs++] = v; pushed = true; break; }
				if (v !== par[u] && disc[v] < low[u]) low[u] = disc[v];
			}
			if (pushed) continue;
			fs--;
			const p = par[u];
			if (p < 0) continue;
			if (low[u] < low[p]) low[p] = low[u];
			if (low[u] >= disc[p]) {
				let tb = 0, from = vs;
				for (;;) { const w = vst[--from]; tb += term[w] + sub[w]; if (w === u) break; }
				if (tb === 0) {
					if (cul === null) cul = new Uint8Array((N + 7) >> 3);
					for (let i = from; i < vs; i++) { const w = vst[i]; cul[w >> 3] |= 1 << (w & 7); nCul++; }
				}
				vs = from;
				sub[p] += tb;
			}
		}
		for (const x of ext) term[x] = 0;
		if (!band) return { cul, off: null, targets, walked, nCul, nOff: 0 };
		// the band: g(t) = min over the targets T of d(t, T) - dE(T) (+ OFF: every key >= 0), buckets over the reverse walk
		let maxD = 0;
		for (let k = 0; k < walked; k++) if (dE[q[k]] > maxD) maxD = dE[q[k]];
		const OFF = maxD, INF = 0x3fffffff, buckets = [];
		for (let k = 0; k < walked; k++) g[q[k]] = INF;
		const push = (t, key) => { let b = buckets[key]; if (!b) buckets[key] = b = []; b.push(t); };
		for (let k = 0; k < walked; k++) { const t = q[k]; if (term[t]) { const key = OFF - dE[t]; if (key < g[t]) { g[t] = key; push(t, key); } } }
		for (let key = 0; key < buckets.length; key++) {
			const b = buckets[key];
			if (!b) continue;
			const nk = key + 1;
			for (let i = 0; i < b.length; i++) {
				const u = b[i];
				if (g[u] !== key) continue;
				// (u's predecessors: its 8-way neighbours (the steps are symmetric) and the portals that send the ball to u)
				for (let k = 0; k < 8; k++) { const v = step8(u, k, true); if (v >= 0 && nk < g[v]) { g[v] = nk; push(v, nk); } }
				const sp = srcs.get(u);
				if (sp) for (let k = 0; k < sp.length; k++) { const v = sp[k]; if (stamp[v] === gen && nk < g[v]) { g[v] = nk; push(v, nk); } }
			}
			buckets[key] = null;
		}
		let off = null, nOff = 0;
		for (let k = 0; k < walked; k++) {
			const t = q[k];
			if (g[t] < INF && dE[t] + g[t] - OFF <= Math.max(SL_MIN, Math.floor(SL_F * dE[t]))) continue;
			if (off === null) off = new Uint8Array((N + 7) >> 3);
			off[t >> 3] |= 1 << (t & 7); nOff++;
		}
		return { cul, off, targets, walked, nCul, nOff };
	};
	return { of };
}
/** tile t's bit in bitset b (null: no tile) */
const bitAt = (b, t) => b !== null && (b[t >> 3] & (1 << (t & 7))) !== 0;

/**
 * roomFields(L, budget, opts) -> {enter(sim) -> {gain, graw, troOk, cached, cul, targets}, release(bits), stats()}: a room's
 * fields, from the state that entered it (its tile): the tiles the ball can walk to (8-way, portals, doors as they are
 * now, spikes and other killing tiles only with protection; one-ways and half blocks open, as src/reach.js), `troOk`
 * whether a trophy is among them, and `graw` how many no earlier room's walk reached (the territory the room opens). A
 * walk depends only on the passable set (the doors' states and protection) and the tile it starts from, so walks are
 * cached by a hash of the passable set: a room whose passable set and start component are known costs that hash and has
 * no gain. Cached walks (a bitset each) beyond `budget` bytes go, the least recently used first. One per worker (its own
 * union). With the useful territory (opts.useful, the default; see USEFUL TERRITORY): `gain` = graw when the room's
 * useful gain (its new tiles on the band) is above 0, else 0; `cul` its cul-de-sacs (a bitset shared by the rooms with the
 * same one, within `budget` bytes too: past it null, no demotion; release() when the room goes; the band only for a new
 * walk's gain). Without it (useful false: --useful=0) gain = graw and cul null, as before.
 */
function roomFields(L, budget, opts = {}) {
	const US = opts.useful === false ? null : roomUseful(L);
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
				// (the useful territory is the room's own, from its entry: a known walk has no gain, its cells are still ordered)
				const U = US !== null ? US.of(sim, false) : null;
				ms += Date.now() - t0;
				return { gain: 0, graw: 0, troOk: c.troOk, cached: true, cul: U !== null ? share(U.cul) : null, targets: U !== null ? U.targets : -1 };
			}
		}
		const U = US !== null ? US.of(sim, true) : null;
		// the walk (8-way, no corner cut between two walls, through portals) from the room's tile
		for (let k = 0; k < doors.length; k++) if (words[k >> 5] & (1 << (k & 31))) shut[doors[k]] = 1;
		const pass = (i) => !wall[i] && !shut[i] && (prot || !deadly[i]);
		const g = ++gen;
		const bits = new Uint8Array((N + 7) >> 3);
		let qh = 0, qt = 0, gain = 0, ugain = 0, troOk = false;
		const off = U !== null ? U.off : null;
		seen[tile] = g; q[qt++] = tile;
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			bits[t >> 3] |= 1 << (t & 7);
			if (!union[t]) { union[t] = 1; gain++; if (!bitAt(off, t)) ugain++; }
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
		// (a room whose new territory is all off the band: no gain)
		if (U !== null && gain > 0 && ugain === 0) zeroed++;
		return { gain: U === null || ugain > 0 ? gain : 0, graw: gain, troOk, cached: false, cul: U !== null ? share(U.cul) : null, targets: U !== null ? U.targets : -1 };
	};
	// the rooms' cul-de-sac and off-band bitsets, one copy per content (FNV-1a over the bytes): rooms that share doors and
	// targets often share them; counted in bytes() with the walks, at most `budget` bytes of them (past that a new room gets
	// none: no demotion); release() when a room goes
	const culs = new Map();   // hash -> {bits, n}
	let culBytes = 0, culRooms = 0, culDropped = 0, zeroed = 0;
	const hashOf = (b) => { let h = 0x811c9dc5 | 0; for (let i = 0; i < b.length; i++) if (b[i] !== 0) { h = Math.imul(h ^ i, 0x01000193); h = Math.imul(h ^ b[i], 0x01000193); } return h >>> 0; };
	const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
	const share = (b) => {
		if (b === null) return null;
		const h = hashOf(b);
		let e = culs.get(h);
		if (e && !same(e.bits, b)) return null;   // (a hash collision: this room without demotion)
		if (!e) {
			if (culBytes + b.length + WALK_BYTES > budget) { culDropped++; return null; }
			culs.set(h, e = { bits: b, n: 0, h });
			culBytes += b.length + WALK_BYTES;
		}
		e.n++; culRooms++;
		return e.bits;
	};
	const release = (b) => {
		if (b === null || b === undefined) return;
		const e = culs.get(hashOf(b));
		if (!e || e.bits !== b) return;
		culRooms--;
		if (--e.n <= 0) { culs.delete(e.h); culBytes -= b.length + WALK_BYTES; }
	};
	// (a room entered again at one of its cul-de-sac tiles: its cul-de-sacs again from there, its entries as terminals)
	const recul = (sim, extra) => { if (US === null) return null; const t0 = Date.now(), c = share(US.of(sim, false, extra).cul); ms += Date.now() - t0; reculs++; return c; };
	let reculs = 0;
	return { enter, recul, release, trophies: trophies.length, bytes: () => bytes + culBytes,
		stats: () => ({ walks, hits, walkMs: ms, walkBytes: bytes, culBytes, culSets: culs.size, culDropped, zeroed, reculs }) };
}

/**
 * roomDead(L, budget) -> {liveFor(sim) -> Uint8Array (a bit per tile: 1 = not a dead end in the ball's room), bytes(),
 * stats()}: the room-aware dead ends (--roomDead=1, coarse cells). In the ball's room (the discrete state the room key
 * holds) a tile is LIVE when the trophy or a TRIGGER (a tile whose touch can change the room: effects, keys, switches and
 * their resets, coins, crowns, liquids and lava (they put a fire out or set one), fire, zombie NPCs; over-inclusive: a
 * trigger that changes nothing is still one) is walkable from it: 8-way (a diagonal step closed between two walls), through
 * portals the way they send the ball, killing tiles closed unless the ball is protected (protection comes only from a
 * trigger), a door or gate closed only when it is closed now and nothing but a trigger can open it (coin, blue coin,
 * purple / orange switch, team, crown doors and gates, key doors: KEEP_DOORS); every other one open (time doors and key gates
 * open on the clock; death, zombie, gold doors: open). Then dilated by a tile (the ball's centre is within a tile of where
 * the walk puts it). The walk over-approximates the ball's moves in the room until its room changes, and the room changes
 * only at a trigger or by the clock (whose doors are open here), so from a tile that is not live the ball can neither
 * finish nor leave the room alive: its run ends there (a proof like the reach field's -1, for this room; a search that
 * takes deaths as moves must not use it: a death respawns the ball elsewhere). Walks are cached by the passable set's hash
 * (the doors' states and protection), the least recently used dropped beyond `budget` bytes.
 */
const KEEP_DOORS = new Set([43, 165, 213, 214, 184, 185, 1079, 1080, 1094, 1095, 1152, 1153, 1027, 1028, 23, 24, 25, 1005, 1006, 1007]);
// (the coins as the FILE stores them: 100 / 101, and 110 / 111 = collected coins saved in the level, which the default
// start ('reset': eeo-tas /reset, World.resetCoins, eesim.js _resetCoinTiles) turns back into 100 / 101 coins that count
// for coin doors; without 110 / 111 here a 60 x 50 level with one 110 coin before a 1-coin door and the trophy cut its
// start as a dead end and lost its 161-tick route (the wq-int-1 review, 2026-09-28; test/reach.js H). In the 'load'
// start they stay collected: then a trigger that changes nothing, which is only over-inclusive, as sound as before)
const TRIGGER_IDS = new Set([5, 121, 113, 1619, 467, 1620, 6, 7, 8, 408, 409, 410, 100, 101, 110, 111, 119, 369, 416, 1585, 368, 417, 418, 419, 420, 421, 422, 423, 453, 461, 1517,
	1584, 1618, ...EL.NPC_IDS]);
function roomDead(L, budget) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, fl = L.flags;
	const F_SOLID = 1, F_JUMPTHRU = 2, F_ROTHALF = 4, F_HALF = 8, F_DOOR = 16;
	const wall = new Uint8Array(N), deadly = new Uint8Array(N), keep = [], goals = [];
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		const f = id >= 0 && id < fl.length ? fl[id] : 0;
		if ((f & F_SOLID) !== 0 && (f & F_DOOR) !== 0) { if (KEEP_DOORS.has(id)) keep.push(i); }
		else if ((f & F_SOLID) !== 0 && (f & (F_JUMPTHRU | F_HALF | F_ROTHALF)) === 0) wall[i] = 1;
		if (id >= 0 && id < L.gFlags.length && (L.gFlags[id] & 4) !== 0) deadly[i] = 1;
		if (TRIGGER_IDS.has(id)) goals.push(i);
	}
	// portals reversed: exit tile -> the portal tiles that send the ball there
	const into = new Map();
	if (L.portalSlot && L.portalsById) {
		for (let i = 0; i < N; i++) {
			const sl = L.portalSlot[i];
			if ((fg[i] !== 242 && fg[i] !== 381) || sl < 0) continue;
			const ex = L.portalsById.get(L.pTarget[sl]);
			if (!ex) continue;
			for (let k = 0; k < ex.n; k++) { const j = (ex.ys[k] >> 4) * W + (ex.xs[k] >> 4); if (j >= 0 && j < N) { let l = into.get(j); if (!l) into.set(j, l = []); if (!l.includes(i)) l.push(i); } }
		}
	}
	const shut = new Uint8Array(N), seen = new Int32Array(N), q = new Int32Array(N), words = new Int32Array(((keep.length + 31) >> 5) + 1);
	const cache = new Map();   // passable-set hash -> {live, used}
	let gen = 0, clock = 0, bytes = 0, walks = 0, hits = 0, ms = 0;
	const liveFor = (sim) => {
		const t0 = Date.now();
		const prot = !!sim.is_invulnerable;
		words.fill(0);
		words[words.length - 1] = prot ? 1 : 0;
		for (let k = 0; k < keep.length; k++) if (sim.is_tile_solid_now(keep[k] % W, (keep[k] / W) | 0)) words[k >> 5] |= 1 << (k & 31);
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < words.length; k++) {
			let x = Math.imul(words[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ words[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		const hk = (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
		const c = cache.get(hk);
		if (c) { c.used = ++clock; hits++; ms += Date.now() - t0; return c.live; }
		for (let k = 0; k < keep.length; k++) if (words[k >> 5] & (1 << (k & 31))) shut[keep[k]] = 1;
		const pass = (i) => !wall[i] && !shut[i] && (prot || !deadly[i]);
		const g = ++gen;
		let qh = 0, qt = 0;
		for (const i of goals) if (seen[i] !== g) { seen[i] = g; q[qt++] = i; }
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			const src = into.get(t);
			if (src) for (const p of src) if (seen[p] !== g && pass(p)) { seen[p] = g; q[qt++] = p; }
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
		for (let k = 0; k < keep.length; k++) shut[keep[k]] = 0;
		// (dilated by a tile)
		const live = new Uint8Array((N + 7) >> 3);
		for (let k = 0; k < qt; k++) {
			const t = q[k], x = t % W, y = (t / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				live[j >> 3] |= 1 << (j & 7);
			}
		}
		walks++;
		cache.set(hk, { live, used: ++clock });
		bytes += live.length + 300;
		while (bytes > budget && cache.size > 1) {
			let bk = 0, bu = Infinity;
			for (const [k, v] of cache) if (v.used < bu && k !== hk) { bu = v.used; bk = k; }
			bytes -= cache.get(bk).live.length + 300;
			cache.delete(bk);
		}
		ms += Date.now() - t0;
		return live;
	};
	return { liveFor, bytes: () => bytes, stats: () => ({ deadWalks: walks, deadHits: hits, deadMs: ms }) };
}
/** tile t is live in the room's bitset (see roomDead) */
const liveAt = (live, t) => (live[t >> 3] & (1 << (t & 7))) !== 0;
/**
 * a trigger's effect the engine has not applied yet: roomDead's claim (the room changes only at a trigger or by the clock)
 * holds only once it has landed. A purple switch pressed while the ball's box overlaps a door or gate it would close waits in
 * _tileQueue and a team change in _team_tx (both retried at the next tick's start, possibly after a portal moved the ball
 * away from the trigger); orange switches and crowns (_stateQueue) and keys (_keysQueue) are drained at the tick's end
 * (pending only with ticksPerFrame above 1). While one is pending the room can change one tick after the trigger, off its
 * tile, so no dead-end cut: the soundness review's repro (a 60 x 50 level: a purple switch touched while overlapping its
 * gate, a fall through the still-open gate onto a one-way portal into a room sealed by that switch's doors) lost its route
 * (no route in 42 M ticks, --roomDead=0 one in 0.2 s; test/reach.js H). A team retry onto the team the ball already has
 * keeps _team_tx set and changes nothing: not pending
 */
const pendingTrigger = (sim) => sim._tileQueue.length !== 0 || sim._stateQueue.length !== 0 || sim._keysQueue.length !== 0 ||
	(sim._team_tx !== -1 && sim.team !== sim._lookupAt(sim._team_tx, sim._team_ty));

/**
 * lowerBoundTiles(L) -> Uint16Array (per tile, over a SharedArrayBuffer): a lower bound on the ticks from a ball whose
 * centre is in that tile to the trophy, whatever the effects and doors (the minimum over the physics): the box moves at
 * most 16.25 px along an axis in a tick (|speed| <= 16 after the clamp, the auto-align, rounding: endgame.js D_TICK), so
 * its centre's tile changes by at most 2 along each axis, and its 1 px steps pass a 4-connected chain of tiles that are
 * no permanent wall (a solid block that is no door, one-way or half block: the centre is never inside one); a portal
 * moves it for nothing. So ticks >= ceil(d / 4), d = the 4-connected steps to a tile next to a trophy (a half block's
 * touch) over every tile but the walls, every door open, portals as free moves (a 0-1 BFS from the trophies). 0xffff:
 * no trophy that way (a proof too, as the reach field's -1). A search state at tick t with t + max(1, bound) past the
 * longest route that still counts cannot give a faster route. With deaths as moves (deathsOf) a state's bound is also
 * at most DEATH_TICKS + the bound at its own respawn target (lbOf in explore()): dying where it is and coming back there;
 * touching another checkpoint first and dying then is never less (the bound is a metric: d(x) <= d(x, c) + d(c)).
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

// ---------------------------------------------------------------- deaths as moves
// A death is a move where the level has a respawn target (the checkpoint touched last, else the next spawn of EE's
// rotation: eesim.js _placeAtSpawn) and something that kills: killed during tick D, the ball is alive again at the
// respawn target in tick D + DEATH_TICKS (the dead ticks read no input), with its coins, keys, switches and static
// effects (Player.respawn). OC's Good Egg TAS dies once, on the spikes at (53, 117) after the portal-pocket coins, and
// comes back at the checkpoint (107, 52) 55 ticks later: the way up without it is 600+ ticks longer (the pit's own way
// out, src/out/night/deaths.md). A death is kept only where it pays (deathPays below); every other dying state ends its
// run as before.
const DEATH_TICKS = 55;
// what a death must save by the cost field (tiles): the way the ball runs in its DEATH_TICKS at the top running speed
// (6.78 px/tick): a respawn that is not that much nearer the trophy is no shortcut by the field
const DEATH_TILES = DEATH_TICKS * 6.78 / 16;
// the checkpoint is part of a coarse cell's key on levels of at most this many checkpoints (explore(): CPK)
const CPK_MAX = 32;
/**
 * deathsOf(L) -> null (a death is never a move here: nothing kills) or {respawnT (Uint8Array: 1 on a checkpoint or
 * spawn tile), cps (checkpoints), spawnT (the spawns' tiles in rotation order; none: tile (1, 1)), timed}: what kills is
 * reach.js's rule (a tile whose block kills, or a timed killer anywhere: curse / zombie / poison with a time, lava)
 */
function deathsOf(L) {
	const W = L.width, H = L.height, N = W * H, fg = L.fg, gF = L.gFlags, lk = L.lookup0;
	let kill = false, timed = false, cps = 0;
	for (let i = 0; i < N; i++) {
		const id = fg[i];
		if (id === 360) cps++;
		if (id >= 0 && id < gF.length && (gF[id] & 4) !== 0) kill = true;
		if (((id === 421 || id === 422 || id === 1584) && lk && lk[i] > 0) || id === 416) timed = true;
	}
	if (!kill && !timed) return null;
	const respawnT = new Uint8Array(N);
	for (let i = 0; i < N; i++) if (fg[i] === 360) respawnT[i] = 1;
	const sx = L.spawnsX || [], sy = L.spawnsY || [];
	const spawnT = [];
	for (let k = 0; k < sx.length; k++) spawnT.push(Math.min(N - 1, Math.max(0, sy[k] * W + sx[k])));
	if (!spawnT.length) spawnT.push(Math.min(N - 1, W + 1));
	for (const t of spawnT) respawnT[t] = 1;
	return { respawnT, cps, spawnT, timed };
}
/** deaths as moves by default (goexplore --deaths=-1, the editor's GPU tools' --deaths=1): something kills and a death can
 *  take the ball somewhere else than where it started (a checkpoint, or 2+ spawns: reach.js models deaths on the same
 *  levels); a level without (Octorage, the ice level, Forgotten Veil, Egg Quest II) searches exactly as before */
function deathMovesFor(L) {
	const D = deathsOf(L);
	return D !== null && (D.cps > 0 || D.spawnT.length >= 2);
}
/** the tile a dying (or dead) ball comes back at: its checkpoint, else the next spawn of the rotation */
function respawnTileOf(D, sim, W) {
	if (sim.checkpoint.x !== -1) return sim.checkpoint.y * W + sim.checkpoint.x;
	const n = D.spawnT.length;
	return D.spawnT[sim._next_spawn >= n || sim._next_spawn < 0 ? 0 : sim._next_spawn];
}

// ---------------------------------------------------------------- route classes (--classW)
/**
 * gateContext(L) -> the level's gates: its doors' components (4-connected tiles of one door or gate block, src/blocks.js
 * kind 'door': a coin door, a key gate, a switch door, a team door, a time door, ...), its triggers' components
 * (bursts.js triggersOf: switches, keys, effects, team, coins where a door reads them), the portals (bursts.js
 * portalsOf), the rooms (roomOf).
 */
function gateContext(L) {
	const BU = require('./bursts.js'), BK = require('./blocks.js');
	const W = L.width, H = L.height, N = W * H, fg = L.fg;
	const door = new Int32Array(N).fill(-1), dIds = [], q = new Int32Array(N);
	const isDoor = (id) => id > 0 && BK.kindOf(id).kind === 'door';
	for (let i = 0; i < N; i++) {
		if (door[i] >= 0 || !isDoor(fg[i])) continue;
		const c = dIds.length;
		dIds.push(fg[i]);
		let qh = 0, qt = 0;
		door[i] = c; q[qt++] = i;
		while (qh < qt) {
			const t = q[qh++], x = t % W, y = (t / W) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const j = yy * W + xx;
				if (door[j] < 0 && fg[j] === fg[i]) { door[j] = c; q[qt++] = j; }
			}
		}
	}
	return { W, H, N, door, dIds, TR: BU.triggersOf(L), PT: BU.portalsOf(L), RM: roomOf(L), BK };
}
/** a gate's rank: what a class is told by (0 a switch, key, effect or team trigger, 1 a key / switch / team / crown / other
 *  door, 2 a coin door or gate; 3 a coin taken for a door, 4 a time door: not part of a class's signature, never avoided) */
function gateRank(G, g) {
	const id = g.kind === 'door' ? G.dIds[g.comp] : g.id;
	const k = G.BK.kindOf(id);
	if (g.kind === 'door') return /time/.test(k.sub || '') ? 4 : /coin/.test(k.sub || '') ? 2 : 1;
	return k.kind === 'coin' || k.kind === 'bluecoin' ? 3 : 0;
}
/**
 * routeGates(L, G, masks) -> the gates of a route in the order of their first pass: the doors its centre passes through
 * and the trigger components that changed its room by a trigger (roomOf byTrigger; the trigger at the centre's tile or
 * next to it): [{key ('d<comp>' | 't<comp>'), kind ('door' | 'trigger'), comp, id, rank, t, x, y, desc}]; and the route's
 * class signature (its gates of rank 0-2, sorted: coins and time doors left out).
 */
function routeGates(L, G, masks) {
	const W = G.W, sim = new E.EESim(L), inp = new E.EEInput();
	sim.reset();
	const out = [], seen = new Set();
	let cz = G.RM.cause(sim);
	const compNear = (tile) => {
		if (G.TR.comp[tile] >= 0) return G.TR.comp[tile];
		const x = tile % W, y = (tile / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const xx = x + dx, yy = y + dy;
			if (xx >= 0 && yy >= 0 && xx < W && yy < G.H && G.TR.comp[yy * W + xx] >= 0) return G.TR.comp[yy * W + xx];
		}
		return -1;
	};
	const addGate = (kind, comp, t, tile) => {
		const key = `${kind === 'door' ? 'd' : 't'}${comp}`;
		if (seen.has(key)) return;
		seen.add(key);
		const g = { key, kind, comp, id: kind === 'door' ? G.dIds[comp] : L.fg[tile], t, x: tile % W, y: (tile / W) | 0 };
		g.rank = gateRank(G, g);
		g.desc = `${G.BK.blockName ? G.BK.blockName(g.id) : g.id} at (${g.x}, ${g.y})`;
		out.push(g);
	};
	for (let t = 0; t < masks.length; t++) {
		E.applyMask(inp, masks[t]);
		sim.tick(inp);
		const tile = Math.min(G.N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
		if (G.door[tile] >= 0) addGate('door', G.door[tile], t + 1, tile);
		const cz2 = G.RM.cause(sim);
		if (G.RM.byTrigger(cz, cz2) && (cz2.sub !== cz.sub || cz2.keys !== cz.keys)) {
			const c = compNear(tile);
			if (c >= 0) { let tl = tile; if (G.TR.comp[tl] !== c) { const x = tile % W, y = (tile / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = (y + dy) * W + x + dx; if (j >= 0 && j < G.N && G.TR.comp[j] === c) tl = j; } } addGate('trigger', c, t + 1, tl); }
		}
		cz = cz2;
		if (sim.has_silver_crown) break;
	}
	const sig = out.filter((g) => g.rank <= 2).map((g) => g.key).sort().join(',');
	return { gates: out, sig };
}
/** the tiles a class worker avoids for gate g: 1 = the door's tiles, 2 = the trigger's tiles and their 8 neighbours (a room
 *  change by a trigger there ends the run); a SharedArrayBuffer view */
function avoidTilesOf(G, g) {
	const av = new Uint8Array(new SharedArrayBuffer(G.N));
	for (let i = 0; i < G.N; i++) {
		if (g.kind === 'door' ? G.door[i] !== g.comp : G.TR.comp[i] !== g.comp) continue;
		if (g.kind === 'door') { av[i] = 1; continue; }
		const x = i % G.W, y = (i / G.W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < G.W && yy < G.H && av[yy * G.W + xx] !== 1) av[yy * G.W + xx] = 2; }
	}
	return av;
}
/** whether the trophy stays walkable (8-connected over every tile but the permanent walls, every door open, portals) from
 *  the start tile with gate g's tiles blocked: a gate every way needs is not avoided */
function gateAvoidable(L, G, g, startTile) {
	const av = avoidTilesOf(G, g), fg = L.fg, fl = L.flags, W = G.W, N = G.N;
	const wall = (i) => { const id = fg[i], f = id >= 0 && id < fl.length ? fl[id] : 0; return (f & 1) !== 0 && (f & 16) === 0 && (f & (2 | 4 | 8)) === 0; };
	const blocked = (i) => wall(i) || av[i] === 1 || (g.kind !== 'door' && G.TR.comp[i] === g.comp);
	const seen = new Uint8Array(N), q = new Int32Array(N);
	let qh = 0, qt = 0;
	seen[startTile] = 1; q[qt++] = startTile;
	while (qh < qt) {
		const t = q[qh++];
		if (fg[t] === 121) return true;
		const ex = G.PT.exits.get(t);
		if (ex) for (const e of ex) if (!seen[e] && !blocked(e)) { seen[e] = 1; q[qt++] = e; }
		const x = t % W, y = (t / W) | 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= W || yy >= G.H) continue;
			const j = yy * W + xx;
			if (seen[j] || blocked(j)) continue;
			if (dx && dy && wall(y * W + xx) && wall(yy * W + x)) continue;
			seen[j] = 1; q[qt++] = j;
		}
	}
	return false;
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
	const H = { popVer: 0, popVal: 0, size: () => hv.length };
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
		H.popVal = hv[0];
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
// --timed without deaths as moves: a doomed state's cost (tiles) above its own (behind every state that can still clear
// its killer; far below the ruled-out marks, 1e4 and STEER_NONE)
const DOOM_TILES = 1000;
// --timed: the ticks a walk tile takes at least in a burst start's slack (nearestOf; ordering only): the top running
// speed's 2.4 with a detour's share (Forgotten Helix's base route: the curse to its remover, 24 walk tiles in 89 ticks)
const TIMED_KT = 3;

/**
 * One explorer (a worker thread; a = the options, settled for the level, seed its seed). ctrl (Int32Array on a
 * SharedArrayBuffer): [0] the longest route that still counts (ticks), [1] stop. post(msg): to the main thread
 * ('finish', 'closest', 'source', 'stat', 'done').
 */
function explore(L, field, a, seed, ctrl, post, port, seedPort = null, idx = -1, ofield = null) {
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
	// (the dead-end brake: see SAT_ZONE; a room's zones' excess in room.sat (zone -> excess), the room's own in room.ex)
	const SAT = coarse && a.sat !== 0, ZW = Math.ceil(W / SAT_ZONE);
	let nSatZ = 0;
	const zoneOf = (tile) => (((tile % W) / SAT_ZONE) | 0) + (((tile / W) / SAT_ZONE) | 0) * ZW;
	/** the excess of cell c's region (0 without the brake) */
	const exOf = (c) => { if (!SAT || c.room === null) return 0; const v = c.room.sat.get(zoneOf(c.tile)); return v === undefined ? 0 : v; };
	/** head A's brake for cell c (tiles) */
	const satPen = (c) => (SAT ? SAT_MU * satOver(exOf(c), a.satN) : 0);
	const fields = coarse ? roomFields(L, Math.max(1 << 20, Math.min(64 << 20, mem * 1048576 * 0.03)), { useful: a.useful !== 0 }) : null;   // (its walk cache: 3%)
	// (the useful territory: a cell's `u`, 2 in a cul-de-sac of its room, 0 else, demotes it: see USEFUL TERRITORY; culPicks,
	// culCells: counted)
	let culPicks = 0, culCells = 0, dCul = 0;
	const useOf = (room, t) => (room !== null && bitAt(room.cul, t) ? 2 : 0);
	// (a run, an import or a seed entering a known room at one of its cul-de-sac tiles: the clock's rooms (time doors, keys
	// running out) are entered wherever the ball is, and a cul-de-sac is one only as seen from the room's first entry: the
	// room's cul-de-sacs again with its entries as terminals (at most REENTRY_MAX times a room), its cells' `u` with them)
	const reentry = (r) => {
		if (r.cul === null || fields === null) return;
		const t = centreTile();
		if (!bitAt(r.cul, t)) return;
		if (r.ents === undefined) r.ents = [r.tile];
		if (r.ents.length > REENTRY_MAX) return;
		r.ents.push(t);
		const nb = fields.recul(sim, r.ents);
		fields.release(r.cul);
		r.cul = nb;
		for (const c of r.arr) { const u = useOf(r, c.tile); if (u !== c.u) { c.u = u; c.ver++; hpush(c); } }
	};
	// (--pickBox=x0,y0,x1,y1, observation only (test/useful.js): the picks and new cells with their tile in that box)
	const PB = a.pickBox ? String(a.pickBox).split(',').map(Number) : null;
	const inBox = PB === null ? () => false : (t) => { const x = t % W, y = (t / W) | 0; return x >= PB[0] && x <= PB[2] && y >= PB[1] && y <= PB[3]; };
	let boxPicks = 0, boxCells = 0;
	// (--roomDead=1, coarse cells, only where deaths are not moves (a.deathMoves false: every death ends its run, so a tile
	// from which no trigger and not the trophy is walkable without dying is a dead end; with deaths as moves a death can
	// take the ball out of it, so no room dead ends there): each room's live tiles, roomDead; a run ends on a tile that is
	// not live in its room; deadCut counts those states)
	const RDEAD = coarse && a.roomDead !== 0 && a.deathMoves === false ? roomDead(L, Math.max(1 << 20, Math.min(32 << 20, mem * 1048576 * 0.02))) : null;
	let deadCut = 0;
	const rooms = new Map(), roomList = [];
	let roomKey = 0, bursts = 0;
	// (--spd: the flagged rooms; the flags the stall clock set since the last progress; the nearest distance at the clock's
	// last reset and when; for the stats: flagged now, flags set in all, the most flagged at once)
	const spdRooms = [];
	let spdTrig = 0, spdAt = Date.now(), spdBest = Infinity, spdOn = 0, spdFlags = 0, spdPeak = 0;
	// (--spdG=1: the one search's nearest distance over all workers, from the main thread ('gnear'): the stall clock runs
	// only while the WHOLE search makes no progress; the bound at the start: a route since (a lower bound) stops the clock)
	let gNear = Infinity;
	const spdMaxT0 = maxT, spdLog = process.env.EEAT_SPDLOG || '';
	const spdSay = (o) => { if (spdLog) try { fs.appendFileSync(spdLog, JSON.stringify(Object.assign({ s: Math.round((Date.now() - t0) / 100) / 10, seed }, o)) + '\n'); } catch (e) { /* */ } };
	// (the one search, coarse cells: every new room's first cell goes to the main thread with the room it came from and the
	// tile where it changed: the other workers' archives and the GPU operator's rooms; a room change between two known
	// rooms once per (room, tile): the trigger tried there)
	const report = coarse && !!port;
	const edges = report ? new Set() : null, clockEdges = report ? new Set() : null;
	// (--lb=1: the sound lower bound on the ticks to the trophy per tile, lowerBoundTiles; the states it cuts: lbCut)
	const LBT = a.lb && a.lbTiles ? a.lbTiles : null;
	let lbCut = 0;
	// (a class worker, --classW: the gate it avoids, avoidTilesOf: 1 = a door's tiles, the centre in one ends the run; 2 =
	// around a trigger, a room change by a trigger there ends it)
	const AV = coarse && a.avoidTiles ? a.avoidTiles : null;
	let avoided = 0;
	const centreTile = () => Math.min(N - 1, Math.max(0, (Math.trunc(sim.py + 8) >> 4) * W + (Math.trunc(sim.px + 8) >> 4)));
	// deaths as moves (deathsOf; a.deathMoves): the respawn tiles, and per (room or discrete state, respawn tile) the
	// earliest tick a cell of this archive was there (rspAt: deathPays' "reached otherwise"); the counts (dSeen: dying
	// states, dCost / dNew: kept by the cost or as the earliest arrival, dDrop: ended as before, dCells: the respawns'
	// new cells)
	const DI = a.deathMoves ? deathsOf(L) : null;
	const rspAt = DI ? new Map() : null;
	// (rspAt's room: coarse cells the room key, or with --dsub=1 its part the ball's own touches change (RM.cause().sub:
	// without the keys and the time doors, which flip on the clock); fine cells the discrete state)
	const rspRoom = () => (!coarse ? disc(sim) : a.dsub ? RM.cause(sim).sub : RM.key(sim));
	const DEATHBLK_N = DEATH_TICKS + 25;
	const DEADBLK = { b: new Uint8Array(DEATHBLK_N), refs: 0 };   // (the dead ticks' inputs: the engine reads none)
	let dSeen = 0, dCost = 0, dNew = 0, dDrop = 0, dCells = 0, dBack = 0, dTicks = 0;   // (dTicks: the dead ticks played)
	// (dBack: the deaths that throw the ball back; dBackKept: those kept as demoted respawn cells, dBackR / dBackS: caught
	// by the order's field / by the steer field)
	let dBackKept = 0, dBackR = 0, dBackS = 0, dPromote = 0;
	// (addBack: the death add() is making a cell for is a throw-back (true), one that pays (false), none (null: a run))
	let addBack = null;
	// (per (room, respawn tile) the kept throw-back's cell while it is the earliest arrival there: a later death that
	// pays reaches it too, and promotes it (a demoted cell must not hold the place from the death main keeps: the
	// throw-back pit of test/deaths.js routed after 3.3x / 2.8x the ticks while it did))
	const rspBk = DI ? new Map() : null;
	const bkLive = (k) => { const c = rspBk.get(k); return c !== undefined && c.bk === true && c.ver >= 0 ? c : null; };
	let picksDom = 0;   // (--dom=1: the picks of cells in dominated rooms, every head)
	// (the sound lower bound of the live state: with deaths also DEATH_TICKS + its respawn target's, see lowerBoundTiles)
	// (without a checkpoint every death moves the spawn rotation on: any spawn, after enough deaths)
	const lbSpawn = DI !== null && LBT !== null ? Math.min(...DI.spawnT.map((t) => LBT[t])) : 0xffff;
	/** fn() with the live state where a respawn would leave it (its target tile, standing: Player.respawn), for a lookup */
	const atRespawn = (fn) => {
		const rt = respawnTileOf(DI, sim, W), px = sim.px, py = sim.py, vx = sim.speed_x, vy = sim.speed_y;
		sim.px = (rt % W) * 16; sim.py = ((rt / W) | 0) * 16; sim.speed_x = 0; sim.speed_y = 0;
		try { return fn(); } finally { sim.px = px; sim.py = py; sim.speed_x = vx; sim.speed_y = vy; }
	};
	// --dord=1 (deaths as moves; the default): the ORDER by the death-free field (OF: reachField {deaths: false}, the
	// main thread's shared copy, else built here). The field with its death edges prices every death at DEATH_COST to the
	// best respawn tile of all, so every state whose death-free walk is longer than that cost the same (a flat plateau:
	// Infinity Pain's order was 1661.8 tiles for t0-t27000 of its known route); it stays the file for the -1 prune. A
	// state the death-free field has no value for (its only way is a death) costs DEATH_TILES + its own respawn
	// target's order (costOf); --dord=0: the order by the field with its death edges, as before
	const OF = DI !== null && a.dord !== 0 ? (ofield || RF.reachField(L, { deaths: false })) : null;
	/** the order's reach cost (tiles) of a state (the live sim) or at a place (x, y, vy): the death-free field's where it
	 *  has a value, else the field's (-1: cut off) */
	const ordAt = (x, y, vy) => {
		if (OF !== null) { const v = RF.costAt(OF, x, y, vy); if (v >= 0) return v; }
		return RF.costAt(field, x, y, vy);
	};
	/** the reach cost (tiles) at the live state's respawn target, standing (-1: cut off; the order's field with --dord) */
	const respawnCost = () => { const rt = respawnTileOf(DI, sim, W); return ordAt((rt % W) * 16, ((rt / W) | 0) * 16, 0); };
	const lbOf = () => {
		const b = LBT[centreTile()];
		if (DI === null) return b;
		const r = sim.checkpoint.x !== -1 ? LBT[sim.checkpoint.y * W + sim.checkpoint.x] : lbSpawn;
		return r === 0xffff ? b : Math.min(b, DEATH_TICKS + r);
	};
	// (--dom=1, coarse cells: the novelty groups and their dominance, domIndex: head B picks a group not dominated, then a
	// room of it; a dominated group's rooms get no discovery burst, no source, and no death is kept into them; 0: every
	// room its own, as before)
	const DOM = coarse && a.dom !== 0 ? domIndex() : null;
	let dDom = 0;
	/** the live state's novelty group (made when new; DOM on) */
	const groupNow = () => DOM.groupOf(RM.dom(sim));
	/** a new room of the live state; bk: made by a death that throws the ball back (deathPays): a BACK room, kept but
	 *  demoted until a run or an import enters it another way (unback): no first cell (no discovery burst, no source, not
	 *  reported to the one search), no head-B draw, no gain for its novelty group */
	const newRoom = (key, t, parent, bk) => {
		const f = fields.enter(sim);
		const cz = RM.cause(sim), pr = parent === undefined ? undefined : rooms.get(parent);
		const r = { key, desc: RM.desc(sim), t, gain: f.gain, graw: f.graw, cul: f.cul, troOk: f.troOk, picks: 0, ex: 0, sat: new Map(), live: RDEAD !== null ? RDEAD.liveFor(sim) : null, arr: [], best: null, isNew: bk !== true, sent: 0, sentAt: null,
			parent: parent === undefined ? null : parent, tile: centreTile(), cause: cz, trig: pr ? RM.byTrigger(pr.cause, cz) : true, grp: null, dm: null, bk: bk === true };
		if (DOM !== null) {
			r.dm = RM.dom(sim);
			const g = DOM.groupOf(r.dm);
			r.grp = g; g.rooms.push(r);
			if (!r.bk) {
				if (f.gain > g.gain) g.gain = f.gain;
				if (f.troOk) g.troOk = true;
			}
		}
		if (a.spdKids && pr !== undefined && pr.spd) { r.spd = true; spdRooms.push(r); }
		rooms.set(key, r);
		roomList.push(r);
		return r;
	};
	/** a back room (newRoom bk) entered by a run, an import or a seed another way: a room like any other from now on, its
	 *  first cell's credit (firstCell) at the next cell it gets */
	const unback = (r) => {
		r.bk = false; r.isNew = true;
		if (r.grp !== null && r.grp !== undefined) {
			if (r.gain > r.grp.gain) r.grp.gain = r.gain;
			if (r.troOk) r.grp.troOk = true;
		}
	};
	/** room r's novelty group is dominated (DOM on) */
	const domOf = (r) => r !== null && r !== undefined && r.grp !== null && r.grp !== undefined && r.grp.dom;
	const TD = coarse && !!L.hasTimeDoors;
	// (the checkpoint in the coarse cell key: on levels of at most CPK_MAX checkpoints; Infinity Pain's 107, one every few
	// tiles of its route, made 2.5x the cells of the CPU runs (47 K -> 119 K in 300 s, 4 workers) for 22 deaths kept of
	// 20.9 M: there the last one touched is nearly always the one just behind the ball)
	const CPK = DI !== null && DI.cps > 0 && DI.cps <= CPK_MAX && a.cpkey !== 0;
	// (--cpkey=2 / EEAT_CPKEY=2, the useful checkpoint (ported from ge-r1-timing 1918135, opt-in): the checkpoint is in the
	// key only while a death there would not throw the ball back: its order cost standing on it at most the state's own
	// (keyRc: add()'s rc) + DEATH_TILES, deathPays' first test; every other checkpoint keys as none. Good Egg: a lineage
	// that last touched (183, 183) reaches every cell of the pocket first, and the earliest state per cell then drops the
	// one whose deaths go somewhere (ge-int-1 seed 2's 17-coin stall: the respawn-blind cells)
	const cpR = new Map();
	let keyRc = 0;
	const cpUseful = () => {
		const cx = sim.checkpoint.x, cy = sim.checkpoint.y;
		if (cx < 0) return false;
		const ct = cy * W + cx;
		let r = cpR.get(ct);
		if (r === undefined) { r = ordAt(cx * 16, cy * 16, 0); cpR.set(ct, r); }
		return r >= 0 && r <= keyRc + DEATH_TILES;
	};
	// the cell key: two 32-bit hash lanes over the cell's numbers (53 bits; two cells collide with probability ~2^-53 per
	// pair, and a collision only merges two cells of this archive: every route is replayed exactly anyway)
	const KV = new Int32Array(11);
	let tile = 0, spdCur = false, spdFast = false, spdT0 = 0;
	// timed killers (src/timed.js; TM null: the level has none, and every key and cost is exactly as before): the live
	// state's ticks left on its soonest killer (tLeft, 0: none), that killer's kind bit (tKind) and bucket (tBucket), set by
	// cellKey. With --timed=1 (the default) the bucket is one more word of the cell key while a killer runs, so a later
	// arrival with more time left is its own cell (Forgotten Helix's curse leg: at every cell past the pickup the earliest
	// state is the first pickup's, whatever it has left), and a new state is dropped only when a cell of the same place
	// in a bucket at least as high got there no later (tDom: dominated in both); a state that can no longer clear its
	// killer (TMD.doomed, a sound bound) is ordered as the death it is (costOf). --timed=0: the key as before (the
	// counts still say how often a state with more time left was dropped: tMore)
	const TM = TMD.timedOf(L), TKEY = TM !== null && a.timed !== 0;
	// (the bucket in the key only with coarse cells: fine cells already tell apart the jump count, the gravity queue and,
	// where refined, the position and speed, and with a bucket more their search on the unit level ran 2.4x slower with no
	// route either way; there the doomed states' ordering alone)
	const TBK = TKEY && coarse;
	let tLeft = 0, tKind = 0, tBucket = 0, kn = 0, tDom = 0, tMore = 0, tDoomed = 0, tCells = 0;
	/** the cell key of KV[0 .. n): two 32-bit hash lanes (see cellKey) */
	const hashKV = (n) => {
		let h1 = 0x9747b28c | 0, h2 = 0x85ebca6b | 0;
		for (let k = 0; k < n; k++) {
			let x = Math.imul(KV[k], 0xcc9e2d51);
			x = (x << 15) | (x >>> 17);
			h1 ^= Math.imul(x, 0x1b873593); h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
			h2 = Math.imul(h2 ^ KV[k], 0x5bd1e995); h2 ^= h2 >>> 13;
		}
		return (fmix(h1) >>> 0) * 2097152 + ((fmix(h2) >>> 0) & 0x1fffff);
	};
	const cellKey = () => {
		const px = sim.px, py = sim.py;
		const tx = Math.trunc(px + 8) >> 4, ty = Math.trunc(py + 8) >> 4;
		tile = Math.min(N - 1, Math.max(0, ty * W + tx));
		const r = res[tile];
		if (coarse) {
			// (tile, room, ground, the time-door phase in buckets of --phase ticks; no jump count or gravity queue; with
			// deaths as moves on a level of checkpoints the checkpoint too: where a death takes the ball, which the
			// earliest state of a cell must not decide for the others)
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (TD ? (((sim.level_ticks() % E.TIMEDOOR_PERIOD) / a.phase) | 0) << 8 : 0);
			KV[2] = CPK && (a.cpkey !== 2 || cpUseful()) ? (sim.checkpoint.x + 1) | ((sim.checkpoint.y + 1) << 16) : 0; KV[3] = 0; KV[4] = 0; KV[5] = roomKey;
		} else {
			KV[0] = tile; KV[1] = (sim.on_ground ? 1 : 0) | (r << 1); KV[2] = sim.jump_count; KV[3] = sim._q0; KV[4] = sim._q1; KV[5] = disc(sim);
		}
		let n;
		if (r === 0 && spdFast) {
			// (--spdMode=1: the fastest arrival's cell next to the coarse one: the class keys and a 9th number)
			const vy = sim.speed_y;
			KV[6] = Math.sign(sim.speed_x); KV[7] = vy < -3 ? 0 : vy < 0 ? 1 : vy === 0 ? 2 : 3; KV[8] = 0x5f;
			n = 9;
		} else if (r === 0 && spdCur) {
			// (--spd: a stuck room's cells by speed, 1 px/tick buckets; the 9th number keeps them apart from the class keys)
			KV[6] = Math.round(sim.speed_x); KV[7] = Math.round(sim.speed_y); KV[8] = 0x5d;
			n = 9;
		} else if (r === 0) {
			const vy = sim.speed_y;
			KV[6] = Math.sign(sim.speed_x); KV[7] = vy < -3 ? 0 : vy < 0 ? 1 : vy === 0 ? 2 : 3;
			n = 8;
		} else {
			const qp = QP[r], qv = QV[r];
			KV[6] = Math.floor(px * qp); KV[7] = Math.floor(py * qp); KV[8] = Math.floor(sim.speed_x * qv); KV[9] = Math.floor(sim.speed_y * qv);
			n = 10;
		}
		// (a timed killer running: its bucket as one more word; without one the key is exactly as before)
		tLeft = 0; tBucket = 0;
		if (TM !== null) {
			tLeft = TMD.timedLeft(sim);
			if (tLeft > 0) { tKind = TMD.TL.kind; tBucket = TMD.bucketOf(tLeft); if (TBK) KV[n++] = tBucket; }
		}
		kn = n;
		return hashKV(n);
	};
	// the archive and the heap of (priority, cell, version): a cell has one live entry (its version); others are stale
	const cells = process.env.EEAT_CELLMAP === '0' ? new Map() : new CellMap();   // (EEAT_CELLMAP=0: a Map, the equality test)
	// (a cell in a cul-de-sac of its room: CUL_A tiles behind, see USEFUL TERRITORY; a respawn kept though its death
	// throws the ball back (c.bk, deathPays): DEATH_TILES behind, the death's own price: demoted, never dropped)
	const demo = (c) => (c.u === 2 ? CUL_A : 0) + (c.bk === true ? DEATH_TILES : 0);
	const HA = heapOf((c) => c.rc + a.lambda * Math.sqrt(c.picks) + satPen(c) + demo(c));
	// --steer: head A's second heap, on the steer field's cost (src/steer.js: gate-aware; computed for new and improved
	// cells only), picked --mix of head A's picks (the research's ngxAB.js); the reach field alone rules states out.
	// A late field (stdin "steer <file>": the editor's build finished after the search started): from then on (steerOn);
	// the cells made before have no steer cost (sc) until a run improves them or they are picked. ST and HS change again
	// once the editor sends the plan past its count (stdin "steer <file>" when a field is in use: switchSteer)
	let ST = a.steerData || null;
	const hsPrio = (c) => c.sc + a.lambda * Math.sqrt(c.picks) + satPen(c) + demo(c);
	const steerHeap = () => heapOf(hsPrio);
	let HS = ST ? steerHeap() : null;
	// (after a switch: the cells scored by the new field; the others are scored when next picked. null: no switch yet;
	// steerGen: the switches made, on every closest message: the main thread drops one of an older field)
	let scFresh = null, steerGen = 0;
	// head L (the one search once a route is known: the main thread's 'route' message): the lead. The best route's
	// schedule (sched: per (room, tile) the tick it first gets there); a cell at (room, tile) that the route passes gets
	// lead = its tick - the route's there (below 0: ahead of the best route, which finishes that much sooner from there if
	// the rest goes as well); head L picks the most ahead, less LEAD_PICK x sqrt(its picks), --pL of the picks: an
	// earlier arrival (a GPU burst's attempt, a lucky run) spreads down the route like A* with the best route's time to
	// go. Main's search after a route picked by the reach cost (the cells by the trophy) and novelty.
	// On time-door levels the schedule is per (room, tile, the doors' phase bucket: the cell key's, --phase ticks): a lead
	// then keeps the doors' phase (whole periods sooner, within a bucket), where by (room, tile) alone a cell "ahead" by a
	// part of a period meets the doors the route passed open shut (Stupid Fox: leads of 625 and 1,351 ticks, doomed).
	// head W (its yield-following share of the picks head L leaves, --pW at most): a cell off that schedule, by its
	// key-blind lead (tsched: per tile the route's first tick there in any room, at any phase; --wPhase=1: per phase
	// bucket too): a skipped room, another coin / switch subset or another path in a room that gets somewhere sooner than
	// the best route did is pushed on, where head L sees nothing (after the first route, 15 min, 1 worker, 2 pairs each:
	// Stupid Fox 5,184 / 5,883 vs main 10,171 / 10,148 (the door-free way), Octorage 7,861 / 7,872 vs 7,951 / 7,897,
	// Egg Quest II 19,316 / 19,285 vs 19,288 / 19,297: src/out/night/n2_2_head_W.md)
	let sched = null, tsched = null;
	const TDL = coarse && !!L.hasTimeDoors, clock0 = sim.level_ticks(), NPH = Math.ceil(E.TIMEDOOR_PERIOD / a.phase);
	const phaseOf = (lt) => ((lt % E.TIMEDOOR_PERIOD) / a.phase) | 0;
	// (head W's schedule per (tile, phase bucket) on time-door levels with --wPhase=1; the default 0: per tile)
	const WTD = TDL && a.wPhase !== 0;
	const leadHeap = () => heapOf((c) => c.lead + LEAD_PICK * Math.sqrt(c.picks));
	const wayHeap = () => heapOf((c) => c.wlead + WAY_PICK * Math.sqrt(c.picks));
	let HL = coarse && port ? leadHeap() : null;
	let HW = coarse && port && a.pW > 0 ? wayHeap() : null;
	/** head W: a cell head L has no lead for, by its tile's (and phase's) first tick on the route */
	const wpush = (c, ph) => {
		const w = WTD ? tsched[c.tile * NPH + ph] : tsched[c.tile];
		if (w <= 0) return;
		c.wlead = c.t - w;
		HW.push(c);
	};
	const lpush = (c) => {
		const v = sched.get(c.room.key * 2097152 + c.tile);
		const ph = TDL ? phaseOf(clock0 + c.t) : 0;
		if (v === undefined) { if (HW !== null) wpush(c, ph); return; }
		const s = TDL ? v[ph] : v;
		if (s < 0) { if (HW !== null) wpush(c, ph); return; }
		c.lead = c.t - s;
		HL.push(c);
	};
	// (head L's share now: see LEAD_GRACE_S; lastL: the first route's or head L's last faster route's time)
	let lastL = 0, lShare = 0, pickL = false, pickW = false;   // (pickW / viaW: the same bookkeeping for head W, counted only)
	const leadShare = (now) => (sched === null || a.pL <= 0 ? 0 : a.pL * Math.max(LEAD_FLOOR, Math.pow(0.5, Math.max(0, (now - lastL) / 1000 - LEAD_GRACE_S) / LEAD_HALF_S)));
	let lastW = 0, wShare = 0;
	const wayShare = (now) => (sched === null || HW === null ? 0 : !a.wYield ? a.pW : a.pW * Math.max(LEAD_FLOOR, Math.pow(0.5, Math.max(0, (now - lastW) / 1000 - LEAD_GRACE_S) / LEAD_HALF_S)));
	// (a cell made before a late steer field has no sc: not in the steer heap until it gets one)
	const hpush = (c) => { HA.push(c); if (HS !== null && c.sc !== undefined) HS.push(c); if (sched !== null) lpush(c); };
	const compact = () => { HA.compact(); if (HS) HS.compact(); if (HL) HL.compact(); if (HW) HW.compact(); };
	/** the steer cost of the live state (tiles; STEER_NONE when it has no value; deaths as moves: a state it has no value
	 *  for, DEATH_TILES + its respawn target's value where that has one: the layer bodies have no death edges) */
	const steerOf = () => {
		// (--timed: a doomed state as the death it is, as in costOf)
		if (TM !== null && doomedNow()) {
			if (DI !== null) { const r = atRespawn(() => SF.steerFifths(ST, sim)); if (r >= 0) return DEATH_TILES + r / 5; }
			const v0 = SF.steerFifths(ST, sim);
			return v0 >= 0 ? v0 / 5 + DOOM_TILES : STEER_NONE;
		}
		const v = SF.steerFifths(ST, sim);
		if (v >= 0) return v / 5;
		if (DI !== null && a.dprice !== 0 && RF.costAt(field, sim) >= RF.DEATH_TILES) { const r = atRespawn(() => SF.steerFifths(ST, sim)); if (r >= 0) return DEATH_TILES + r / 5; }
		return STEER_NONE;
	};
	// (--steerDist: the closest attempt's and the sources' distances by the steer field, at most STEER_REAL_MAX; 6000 + the
	// reach field's cost where it has no value: native/beam.h steerTiles, steerMiss)
	// (a late field with its distances (stdin "steerd <file>": steerOn with dist) turns it on in the middle of the search)
	let distBySteer = !!ST && a.steerDist !== 0;
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
	const archiveBytes = () => cells.size * ((ST ? B_CELL + B_SC : B_CELL) + (TM !== null ? B_TM : 0)) + (HA.size() + (HS ? HS.size() : 0) + (HL ? HL.size() : 0) + (HW ? HW.size() : 0)) * B_HEAPE + nNodes * B_NODE + nBlocks * BLK + xBytes +
		roomList.length * B_ROOM + nSatZ * B_SATZ + (queue.length - qh) * B_QUEUE + (fields !== null ? fields.bytes() : 0) + (RDEAD !== null ? RDEAD.bytes() : 0);
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
	const add = (t, rc, pc, up, blk, o, n, room, fast) => {
		if (t >= maxT) return null;   // (a route from there would not be faster)
		// (nor from a state whose sound lower bound to the trophy ends past it: lowerBoundTiles)
		if (LBT !== null && t + Math.max(1, lbOf()) > maxT) { lbCut++; return null; }
		spdFast = fast === true;
		spdCur = !spdFast && a.spdMode === 0 && room !== null && room !== undefined && room.spd === true;
		keyRc = rc;
		const k = cellKey();
		// (deaths as moves: the earliest arrival at a respawn tile per room, deathPays' "reached otherwise")
		if (rspAt !== null && DI.respawnT[tile] === 1) {
			const rk = rspRoom() * 2097152 + tile, v = rspAt.get(rk);
			if (v === undefined || t < v) rspAt.set(rk, t);
		}
		const c = cells.get(k);
		const v2 = spdFast ? sim.speed_x * sim.speed_x + sim.speed_y * sim.speed_y : 0;
		if (!spdFast) spdT0 = c !== undefined && c.t < t ? c.t : t;   // (the coarse cell's earliest after this add: --spdSlack)
		else if (a.spdSlack > 0 && t > spdT0 + a.spdSlack) return null;
		if (c !== undefined) {
			c.seen++; c.touch = picks;
			if (spdFast ? c.v2 >= v2 : c.t <= t) {
				// (--timed=0: a state dropped here though it has more time left on its killer than the kept one, by a bucket)
				if (!spdFast && tBucket > 0 && !TBK && tBucket > TMD.bucketOf(c.tm >> 4)) tMore++;
				return null;
			}
			if (spdFast) c.v2 = v2;
			if (c.snap !== null) { c.snap = null; nSnaps--; }
			const old = c.node;
			c.t = t; c.pc = pc; c.pgen = pc !== null ? pc.gen : 0; c.node = mkNode(up, blk, o, n); c.rc = rc; c.gen++; c.ver++; c.viaL = pickL || (pc !== null && pc.viaL); c.viaW = pickW || (pc !== null && pc.viaW);
			if (TM !== null) c.tm = tLeft * 16 + (tLeft > 0 ? tKind : 0);
			release(old);
			impr++;
			// (an earlier arrival: its lineage is no throw-back death, unless it is one itself: a throw-back death that
			// comes sooner keeps the cell demoted, so bkLive still finds it and the next paying death there promotes it
			// (clearing it here had the rspAt checks drop every later paying death at that place: the n3 soundness review))
			if (c.bk === true && addBack !== true) c.bk = false;
			if (ST) { c.sc = steerOf(); if (scFresh !== null) scFresh.add(c); nearSteer(c); }
			hpush(c);
			if (room !== null && betterBest(c, room.best)) room.best = c;
			return null;
		}
		// (--timed: a cell of the same place in a bucket with more time left that got there no later: this state is dominated;
		// not for --spdMode=1's fast cells, which keep the fastest arrival, not the earliest)
		if (TBK && tBucket > 0 && !spdFast) {
			const bmax = TMD.bucketMax(), b0 = tBucket;
			for (let b = b0 + 1; b <= bmax; b++) {
				KV[kn - 1] = b;
				const c2 = cells.get(hashKV(kn));
				if (c2 !== undefined && c2.t <= t) { c2.seen++; c2.touch = picks; tDom++; KV[kn - 1] = b0; return null; }
			}
			KV[kn - 1] = b0;
		}
		if (!roomFor()) { full = true; needSweep = true; return null; }
		// (--steer: the cell's steer cost too, B_SC more; without --steer the cell has no such property)
		// (viaL: the cell descends from a head-L pick's runs, its share's yield: a route head L's earlier arrivals led to is
		// often finished by head A's pick of a cell by the trophy)
		// (u: the cell's tile is in a cul-de-sac of its room (2) or off its band (1): demoted, see USEFUL TERRITORY)
		const vl = pickL || (pc !== null && pc.viaL), vw = pickW || (pc !== null && pc.viaW), cu = useOf(room, tile);
		const nc = ST ? { t, snap: null, pc, pgen: pc !== null ? pc.gen : 0, node: mkNode(up, blk, o, n), rc, sc: steerOf(), picks: 0, seen: 1, tile, room, ver: 0, gen: 0, used: false, touch: picks, viaL: vl, viaW: vw, u: cu }
			: { t, snap: null, pc, pgen: pc !== null ? pc.gen : 0, node: mkNode(up, blk, o, n), rc, picks: 0, seen: 1, tile, room, ver: 0, gen: 0, used: false, touch: picks, viaL: vl, viaW: vw, u: cu };
		if (cu === 2) culCells++;
		if (PB !== null && inBox(tile)) boxCells++;
		// (a level with timed killers: the ticks left at arrival and the killer's kind bit, tLeft x 16 + kind; B_TM more)
		if (TM !== null) { nc.tm = tLeft * 16 + (tLeft > 0 ? tKind : 0); if (tLeft > 0) tCells++; }
		if (ST) { if (scFresh !== null) scFresh.add(nc); nearSteer(nc); }
		if (spdFast) nc.v2 = v2;
		cells.set(k, nc);
		hpush(nc);
		if (t > deepest) deepest = t;
		if (room !== null) {
			room.arr.push(nc);
			if (betterBest(nc, room.best)) room.best = nc;
		}
		return nc;
	};
	/** a room's lowest-cost cell (its sources, the sweep keeps it): a cell outside its cul-de-sacs before any in one */
	const betterBest = (c, b) => b === null || ((c.u === 2) !== (b.u === 2) ? c.u !== 2 : distOf(c) < distOf(b));
	/** --steerDist: the closest state by the steer field, among new and improved cells (the steer cost is computed only
	 *  for those; no cell in a cul-de-sac of its room) */
	const nearSteer = (c) => {
		if (!distBySteer || c.u === 2) return;
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
	let viaDeath = false;   // (the last costOf: the field's only way from there is a death)
	/** --timed: the live state cannot clear its soonest timed killer (nor finish) before it fires (src/timed.js doomed: a
	 *  sound bound), so its only future is that death */
	const doomedNow = () => {
		if (!TKEY) return false;
		const l = TMD.timedLeft(sim);
		return l > 0 && TMD.doomed(TM, centreTile(), l);
	};
	const costOf = () => {
		const rc = RF.costAt(field, sim);
		// (deaths as moves: the field prices a death edge at DEATH_COST, behind every real way, to the best respawn tile of
		// all; a state whose only way is a death costs its real price: DEATH_TILES + its own respawn target's cost)
		viaDeath = DI !== null && rc >= RF.DEATH_TILES;
		// (--dord: the order by the death-free field where it has a value; the -1 prune stays the field's)
		let nf = -1;
		if (OF !== null && rc >= 0) { nf = RF.costAt(OF, sim); viaDeath = nf < 0; }
		// (--timed: a doomed state is ordered as the death it is: DEATH_TILES + its respawn target's cost with deaths as moves,
		// else behind every state that can still clear its killer; never ruled out: only the reach field's -1 prunes)
		if (rc >= 0 && TM !== null && doomedNow()) {
			tDoomed++; viaDeath = true;
			if (DI !== null) { const r = respawnCost(); if (r >= 0) return DEATH_TILES + r; }
			return rc + DOOM_TILES;
		}
		if (OF !== null && rc >= 0) {
			if (nf >= 0) return nf;
			if (a.dprice !== 0) { const r = respawnCost(); if (r >= 0) return DEATH_TILES + r; }
			return rc;
		}
		if (viaDeath && a.dprice !== 0) { const r = respawnCost(); if (r >= 0 && DEATH_TILES + r < rc) return DEATH_TILES + r; }
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
		keyRc = rc;
		const k = cellKey();
		const node0 = pre ? mkNode(null, { b: pre, refs: 0, x: Math.max(0, pre.length - a.rolls * a.roll) }, 0, pre.length) : null;
		const c = ST ? { t: t0c, snap: null, pc: null, pgen: 0, node: node0, rc, sc: steerOf(), picks: 0, seen: 1, tile, room: room0, ver: 0, gen: 0, used: false, touch: 0, viaL: false, viaW: false, u: 0 }
			: { t: t0c, snap: null, pc: null, pgen: 0, node: node0, rc, picks: 0, seen: 1, tile, room: room0, ver: 0, gen: 0, used: false, touch: 0, viaL: false, viaW: false, u: 0 };
		if (TM !== null) c.tm = tLeft * 16 + (tLeft > 0 ? tKind : 0);
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
	let parked = 0;   // (the chunks this worker sat out: stdin "workers K" parked it)
	// (memMB: the budget's count; heapMB: the V8 heap in use, garbage included)
	const stat = () => Object.assign({ type: 'stat', seed, ticks, cells: cells.size, picks, deepest, seeded, seedCells, lbCut, avoided, dSeen, dCost, dNew, dDrop, dCells, dBack, dBackKept, dBackR, dBackS, dPromote, dTicks, tDom, tMore, tDoomed, tCells, dCul, culPicks, culCells, boxPicks, boxCells, leadPicks, leadRoutes, leadShare: Math.round(lShare * 1000) / 1000, wayPicks, wayShare: Math.round(wShare * 1000) / 1000, minRc: Number.isFinite(minRc) ? minRc : null, refined, full,
		snaps: nSnaps, dropped, replays, impr, evicted, sweeps, nodes: nNodes, budgetMB: mem, memMB: Math.round(memBytes() / 1048576),
		heapMB: Math.round(V8.getHeapStatistics().used_heap_size / 1048576), parked },
	coarse ? Object.assign({ rooms: roomList.length, bursts, imports, importAdded, roomDead: RDEAD !== null, deadCut, spdOn, spdFlags, spdPeak, dDom, picksDom }, fields.stats(), RDEAD !== null ? RDEAD.stats() : {}, DOM !== null ? DOM.stats() : {}) : {});
	const sendNear = () => {
		if (!near || near === nearSent) return;
		nearSent = near;
		post({ type: 'closest', seed, rc: near.rc, t: near.t, gen: steerGen, inputs: C.eetasBytes(inputsOf(near.node)).toString('latin1') });
	};
	// sources (coarse cells): starting points for the editor's relay (see the header). A room without territory gain is a
	// "room" source at most once per SOURCE_S (on a level of many switches most rooms open nothing)
	let lastBlandSource = -1e9, lastSources = t0;
	const source = (kind, r, c) => {
		r.sent++; r.sentAt = c;
		// (gen: the steer switches made: the main thread ranks one of an older measure behind, onSource)
		post({ type: 'source', seed, kind, room: r.key, desc: r.desc, gain: r.gain, t: c.t, rc: distOf(c), gen: steerGen, inputs: C.eetasBytes(inputsOf(c.node)).toString('latin1') });
	};
	/** every SOURCE_S s: the lowest-cost cell of the 4 rooms with the most territory gain and the fewest sources so far
	 *  (by (1 + ln(1 + gain)) / (1 + sources)), when it is not the one already sent */
	const bestSources = () => {
		const cand = [];
		for (const r of roomList) if (r.best !== null && r.best.node !== null && r.best.t >= SOURCE_MIN_TICKS && r.best !== r.sentAt && !domOf(r) && !r.bk) cand.push(r);
		cand.sort((x, y) => (1 + Math.log(1 + y.gain)) / (1 + y.sent) - (1 + Math.log(1 + x.gain)) / (1 + x.sent) || x.t - y.t);
		for (let k = 0; k < 4 && k < cand.length; k++) source('best', cand[k], cand[k].best);
	};
	// the picks: head A, the lowest priority whose entry is live and whose state is early enough (with --steer from the
	// steer field's heap --mix of the time)
	const popFrom = (H) => {
		while (H.size() > 0) {
			const c = H.pop();
			if (H.popVer !== c.ver || c.t >= maxT) continue;
			// (the brake: its region's excess grew since the cell was queued: back into the queue at its priority now)
			if (SAT && satPen(c) > 0) { const v = (H === HS ? c.sc : c.rc) + a.lambda * Math.sqrt(c.picks) + satPen(c) + demo(c); if (v > H.popVal + SAT_SLACK) { H.push(c); continue; } }
			return c;
		}
		return null;
	};
	// (the steer heap empty or run dry, as right after a late field: head A's own; with the field from the start both
	// heaps hold the same live cells)
	const popA = () => {
		if (HS !== null && HS.size() > 0 && rnd() < a.mix) { const c = popFrom(HS); if (c !== null) return c; }
		return popFrom(HA);
	};
	// head B (novelty; coarse cells): a room by a tournament of 4 (territory gain, the trophy walkable, few picks), then
	// the best of --sample random cells of it by Go-Explore's count weights (cells runs rarely come through first)
	// (--dom=1: the tournament over the novelty groups not dominated (DOM.list: a group's gain the most of its rooms', its
	// picks all of theirs, its brake the most of theirs), then a room of the group by its share of the group's cells; a
	// group of one room draws as that room did)
	const popB = () => {
		let br = null, bw = -1;
		if (DOM !== null) {
			const GL = DOM.list;
			let bg = null;
			for (let k = 0; k < 4 && GL.length; k++) {
				const g = GL[(rnd() * GL.length) | 0];
				let n = 0, ex = 0;
				for (const r of g.rooms) { if (r.bk) continue; n += r.arr.length; if (r.ex > ex) ex = r.ex; }
				if (!n) continue;
				const w = (1 + Math.log(1 + g.gain)) * (g.troOk ? 2 : 1) / Math.sqrt(1 + g.picks / 50) / (SAT ? 1 + satOver(ex, a.satN) / SAT_B : 1);
				if (w > bw) { bw = w; bg = g; }
			}
			if (bg !== null) {
				if (bg.rooms.length === 1) br = bg.rooms[0].bk ? null : bg.rooms[0];
				else {
					// (its rooms (the time doors' two states) by main's room weight: the one picked least, as a tournament of them)
					let rw = -1;
					for (const r of bg.rooms) {
						if (!r.arr.length || r.bk) continue;
						const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50) / (SAT ? 1 + satOver(r.ex, a.satN) / SAT_B : 1);
						if (w > rw) { rw = w; br = r; }
					}
				}
			}
		} else {
			for (let k = 0; k < 4; k++) {
				const r = roomList[(rnd() * roomList.length) | 0];
				if (!r.arr.length || r.bk) continue;
				const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50) / (SAT ? 1 + satOver(r.ex, a.satN) / SAT_B : 1);
				if (w > bw) { bw = w; br = r; }
			}
		}
		if (br === null) return popA();
		const arr = br.arr;
		let bc = null, bs = -Infinity, bu = false;
		for (let k = 0; k < a.sample; k++) {
			const c = arr[(rnd() * arr.length) | 0];
			if (c.t >= maxT) continue;
			// (a cell in a cul-de-sac of its room loses to any cell outside one: see USEFUL TERRITORY)
			let sc = (1 / Math.sqrt(1 + c.seen) + 1 / Math.sqrt(1 + c.picks)) / (SAT ? 1 + satOver(exOf(c), a.satN) / SAT_B : 1);
			// (--timed: a doomed cell only when the sample has nothing else; the draws are the same either way)
			if (TKEY && c.tm >= 16 && TMD.doomed(TM, c.tile, c.tm >> 4, c.tm & 15)) sc -= 4;
			const cu = c.u === 2 || c.bk === true;   // (a kept throw-back death's cell: last too)
			if (bc === null || (bu && !cu) || (bu === cu && sc > bs)) { bs = sc; bc = c; bu = cu; }
		}
		return bc || popA();
	};
	const discovery = [];   // head C (coarse cells): [cell, picks left], the newest room's last
	// (EEAT_PICKLOG=1, observation only: per head, room and zone of 10 x 10 tiles the picks and the new and improved cells
	// their runs made, posted every PICKLOG_S s: where the search's picks go, src/out/night/deadends.md)
	const plog = process.env.EEAT_PICKLOG === '1' ? new Map() : null;
	const plogRow = (head, c) => {
		const z = `${head}|${c.room ? c.room.key : 0}|${((c.tile % W) / 10) | 0},${((c.tile / W) / 10) | 0}`;
		let r = plog.get(z);
		if (!r) plog.set(z, r = [0, 0, 0, c.room ? c.room.desc : '']);
		r[0]++;
		return r;
	};
	let lastPlog = Date.now();
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
					else {
						rooms.delete(r.key); nSatZ -= r.sat.size; fields.release(r.cul);
						if (r.grp !== null) { const i = r.grp.rooms.indexOf(r); if (i >= 0) r.grp.rooms.splice(i, 1); }
					}
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
		// (a dominated room: no discovery burst and no source; the main thread hears of it, with its class and mask)
		const dm = domOf(room);
		if (room.gain > 0 && !dm) { if (a.burst > 0) { discovery.push([nc, a.burst]); bursts++; } }
		if (!dm && (room.gain > 0 || Date.now() - lastBlandSource >= SOURCE_S * 1000) && t >= SOURCE_MIN_TICKS) {
			if (room.gain <= 0) lastBlandSource = Date.now();
			source('room', room, nc);
		}
		if (report) {
			post({ type: 'room', seed, room: room.key, desc: room.desc, gain: room.gain, troOk: room.troOk, parent: room.parent, tile: room.tile, t, trig: room.trig,
				sub: room.cause.sub, keys: room.cause.keys, wt: ticks, inputs: C.eetasBytes(inputsOf(nc.node)).toString('latin1'),
				...(room.dm !== null ? { dcls: room.dm.cls, dmask: Array.from(room.dm.mask) } : {}) });
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
			if (sim.has_silver_crown) break;   // (a route is the main thread's: it replays every one)
			// (a death: the end of the run, or with deaths as moves the dead ticks pass: the operator chose it)
			if (sim.is_dead) { if (DI !== null) continue; break; }
			if (t <= P) { if (t === P) room = room0; continue; }
			const rc = costOf();
			if (rc < 0) break;
			roomKey = RM.key(sim);
			if (roomKey !== room.key) {
				const r = rooms.get(roomKey);
				if (r !== undefined) { room = r; if (r.bk) unback(r); reentry(r); }
				else if (roomFor()) room = newRoom(roomKey, t, room.key);
				else { full = true; needSweep = true; break; }
			}
			if (room.live !== null && !liveAt(room.live, centreTile()) && !pendingTrigger(sim)) { deadCut++; break; }
			if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
			if (!distBySteer && (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) && useOf(room, centreTile()) !== 2) {
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
		// (the burst arm's dead zones: its starts that ran out of situations with nothing gained, bursts.js DEAD_ZONE)
		const avoid = m.avoid ? new Set(m.avoid) : null, zw = m.zone ? Math.ceil(W / m.zone) : 0;
		let best = null, bv = 0xffff, bs = 0;
		if (r !== undefined) {
			// (--timed, a cell whose state carries a timed killer: its slack = the ticks left - TIMED_KT x the walk to the
			// killer's removers (m.way: bursts.js wayField; else to the targets); the cells with slack >= 0 first, the nearest of
			// them as before (then the most time left); else the most slack: the nearest cell of a curse room is mostly the
			// first pickup's, a few ticks from its end, and a burst from it runs out of situations when the killer fires
			// (Forgotten Helix, main: exhausted 4 tiles from the remover)
			const wf = m.way || null;
			for (const c of r.arr) {
				if (c.t >= maxT) continue;
				if (avoid !== null && avoid.has((((c.tile % W) / m.zone) | 0) + (((c.tile / W) / m.zone) | 0) * zw)) continue;
				const v = f[c.tile];
				if (v === 0xffff) continue;
				// (a cell outside the room's cul-de-sacs before any in one: see USEFUL TERRITORY; with a timed killer the time
				// slack before that)
				const tl = TKEY ? c.tm >> 4 : 0, dw = wf !== null && wf[c.tile] !== 0xffff ? wf[c.tile] : v, sl = tl > 0 ? Math.min(0, tl - TIMED_KT * dw / 5) : 0;
				if (best === null || sl > bs || (sl === bs && ((c.u === 2) !== (best.u === 2) ? c.u !== 2 : (v < bv || (v === bv && (tl > (best.tm >> 4) || (tl === (best.tm >> 4) && c.t < best.t))))))) { best = c; bv = v; bs = sl; }
			}
		}
		port.postMessage({ type: 'nearest', id: m.id, seed, v: best !== null ? bv : -1, t: best !== null ? best.t : 0, sl: best !== null ? bs : 0, tile: best !== null ? best.tile : -1, cells: r !== undefined ? r.arr.length : 0,
			inputs: best !== null ? C.eetasBytes(inputsOf(best.node)).toString('latin1') : '' });
	};
	/** the best route (the main thread's 'route': any operator's, or the editor's): head L's schedule, and every cell on it
	 *  into head L (a separate engine: the live state belongs to the picks) */
	let leadPicks = 0, leadRoutes = 0, wayPicks = 0;
	const setRoute = (str, byL, byW) => {
		const ms = Uint8Array.from(str, (ch) => (ch.charCodeAt(0) - 48) & 31);
		const s2 = new E.EESim(L), in2 = new E.EEInput(), m = new Map();
		const tm = HW !== null ? new Int32Array(WTD ? N * NPH : N) : null;
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
				if (tm !== null) { const i = WTD ? tl * NPH + ph : tl; if (tm[i] === 0) tm[i] = k + 1; }
			} else {
				if (!m.has(key)) m.set(key, k + 1);
				if (tm !== null && tm[tl] === 0) tm[tl] = k + 1;
			}
		}
		if (sched === null || byL || (byW && a.wLead)) lastL = Date.now();
		if (sched === null || byW) lastW = Date.now();
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
			else if (x.type === 'gnear') { if ((x.gen || 0) >= steerGen && x.rc < gNear) gNear = x.rc; }
			else if (x.type === 'route' && HL !== null) setRoute(x.inputs, !!x.byL, !!x.byW);
		}
	};
	/** a late steer field (stdin "steer <file>": the main thread's shared bytes): head A's second heap from now on. The
	 *  distances the search reports stay the reach field's (--steerDist as with 0), unless dist (stdin "steerd <file>": the
	 *  editor ranks every strategy's attempts by the steer field from now on): then the closest state, the rooms' best
	 *  cells and the sources are the steer field's from now on (another measure: the closest state starts over from the
	 *  cells holding a snapshot, scored at once; the others are scored when a run improves them or they are picked, and
	 *  until then rank at 6000 + their reach cost, behind every scored one: distOf) */
	const steerOn = (sab, dist) => {
		if (ST !== null) return;
		ST = Object.assign(SF.readSteerFile(Buffer.from(sab)), { dpFirst: a.dpFirst === 1 });
		HS = steerHeap();
		if (!dist) return;
		distBySteer = true;
		steerGen++;
		spdBest = Infinity; gNear = Infinity; spdAt = Date.now();
		if (spdRooms.length) { for (const r of spdRooms) r.spd = false; spdRooms.length = 0; }
		spdTrig = 0; spdOn = 0;
		if (near !== null) { release(near.node); near = null; }
		nearSent = null;
		for (const c of cells.values()) {
			if (c.snap === null) continue;
			sim.restore(c.snap);
			c.sc = steerOf(); c.ver++;
			hpush(c);
			// (a room's best: an unscored cell ranks behind every scored one)
			if (c.room && (c.room.best === null || distOf(c) < distOf(c.room.best))) c.room.best = c;
			if (c.node !== null) nearSteer(c);
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
			if (t >= maxT || sim.has_silver_crown) break;
			if (sim.is_dead) { if (DI !== null) continue; break; }
			let into = true;
			if (coarse) {
				roomKey = RM.key(sim);
				if (roomKey !== room.key) {
					const r = rooms.get(roomKey);
					if (r !== undefined) { room = r; if (r.bk) unback(r); reentry(r); }
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
	/**
	 * deathPays: a run's ball died in tick t (the live state; its path: node up, then blk.b[o ..+ n); room: its room;
	 * rcPrev: the reach cost of the run's last state that had a way of its own, else its pick's cell's cost). The
	 * death is kept only where it pays: its respawn does not throw the ball back (its target is not farther from the
	 * trophy by the reach field than the state's own way by more than DEATH_TILES, the way a death costs: dBack) and it
	 * is the EARLIEST arrival of this archive at the respawn tile in
	 * the room the ball comes back in (rspAt: that place in that room never reached, or reached only later: a new room of
	 * the level there, or the best route's schedule beaten; after a route exists its states are in the archive too). A
	 * death whose respawn place was reached sooner gives the search nothing (a checkpoint touched and died on at once, a
	 * death back to where it has been in this room, one past the longest route that still counts), and one that throws
	 * the ball back is the pathology the rule alone keeps: with the coin count in the room key, every coin makes the
	 * spawn "new" in its room (Good Egg's gate ge#14: a death on the way down back to the spawn with 7 coins, 3 of 3 seeds
	 * failed with it, 3 of 3 passed without): it ends its run as before (dDrop). OC's pit death keeps the ball as near
	 * (the reach field: 274.2 tiles at the pit, 280.4 at the checkpoint). A kept death is counted by why it pays: dCost (i) its respawn target is nearer the
	 * trophy by the reach field than the state's own way by more than the way the ball could run in the death's ticks
	 * (DEATH_TILES; the only way when the field has no other), else dNew (ii) only as the earliest arrival (a new room
	 * there: the field, door-blind, sees no gain). Then the dead ticks are played (the engine respawns the ball), the
	 * respawn becomes a cell (its path: the run up to the death, then the dead ticks: DEADBLK) and gets head C's --burst
	 * picks when it is new. Respawn states are alike per (checkpoint, room): one cell each (the cell key has the
	 * checkpoint on levels of checkpoints: CPK).
	 */
	const dying = (up, blk, o, n, t, rcPrev, room, e) => {
		dSeen++;
		const rt = respawnTileOf(DI, sim, W);
		if (t + DEATH_TICKS - 1 >= maxT) { dDrop++; return; }
		// the quick look before the dead ticks are played (the room as it is now; the respawn's own after them): a death
		// that throws the ball back (its target farther from the trophy by the reach field than the state's own way, by
		// more than the way a death costs), then the earliest arrival there. A throw-back is a HEURISTIC verdict (the order's
		// fields are door-blind or a layer's view; Good Egg's ge-int-1 seed 2 held 17 coins from 871 s to 2,700 s because
		// its needed pit death at (53, 116) back to the checkpoint (183, 183) was one by the steer field: 390.4 at the
		// respawn, 345.8 at the pit), so with --dback=1 (the default) it is kept DEMOTED (back): no discovery burst, no
		// first-cell credit for a room it makes (a back room: newRoom bk), no head-B draw, its cell DEATH_TILES behind in
		// head A's heaps (demo); --dback=0: dropped as before. The respawn target cut off by the reach field (-1: a proof)
		// is dropped either way.
		let back = false;
		{
			const r0 = respawnCost();
			if (r0 < 0) { dDrop++; return; }
			if (r0 > rcPrev + DEATH_TILES) { dBack++; dBackR++; if (!a.dback) { dDrop++; return; } back = true; }
		}
		const k0 = rspRoom() * 2097152 + rt, v0 = rspAt.get(k0);
		if (v0 !== undefined && v0 <= t + DEATH_TICKS - 1 && (back || bkLive(k0) === null)) { dDrop++; return; }
		// (with the steer field, gate-aware, the same bound by it against the run's pick: the reach field is door-blind, and
		// on Good Egg it puts the spawn as near as the level's upper right, so deaths from there back to the spawn with 7
		// coins passed it: gate ge#14 failed in 3 of 3 seeds while they were kept with their bursts; OC's pit death: 318.8
		// at the pit, 326.4 at the checkpoint)
		if (!back && ST && e.sc < STEER_NONE) {
			const sr = atRespawn(() => SF.steerFifths(ST, sim));
			if (sr >= 0 && sr / 5 > e.sc + DEATH_TILES) { dBack++; dBackS++; if (!a.dback) { dDrop++; return; } back = true; }
		}
		let nd = 0;
		while (sim.is_dead && nd < DEATHBLK_N) { E.applyMask(inp, 0); sim.tick(inp); nd++; ticks++; }
		dTicks += nd;
		const tR = t + nd;
		if (sim.is_dead || tR >= maxT || sim.has_silver_crown) { dDrop++; return; }
		const rc = costOf();
		if (rc < 0) { dDrop++; return; }
		const raw = ordAt(sim);
		if (!back && raw > rcPrev + DEATH_TILES) { dBack++; dBackR++; if (!a.dback) { dDrop++; return; } back = true; }
		const byCost = !back && raw + DEATH_TILES < rcPrev;
		// (the earliest arrival first: a room is made only for a death that is kept, never for one dropped after it)
		if (coarse) roomKey = RM.key(sim);
		const kR = rspRoom() * 2097152 + centreTile(), v = rspAt.get(kR);
		if (v !== undefined && v <= tR) {
			// (reached sooner: dropped; but a death that pays and finds a kept throw-back's cell there promotes that cell: its
			// demotion off, and the credit this death would have had: the back room's first cell, else the discovery burst)
			const pc = back ? null : bkLive(kR);
			if (pc !== null) {
				pc.bk = false; pc.ver++; hpush(pc); rspBk.delete(kR); dPromote++;
				const pr = pc.room;
				if (pr !== null && pr.bk) unback(pr);
				if (pr !== null && pr.isNew) firstCell(pr, pc, pc.t);
				else if (coarse && a.burst > 0 && a.dburst !== 0 && !domOf(pr) && pc.u !== 2) discovery.push([pc, a.burst]);
			}
			dDrop++; return;
		}
		let rm = room;
		// (--dom=1: a death kept into a dominated room gets no discovery burst: before it, Good Egg's hour from the
		// level alone kept deaths back to the checkpoint (139, 143) in each of ~100 K switch-subset rooms, every one with
		// a discovery burst; the death itself is kept as main keeps it: dominance only orders (an open door is no floor:
		// the ge-int-1 soundness review's level needs a death into a room with FEWER mono switches on, and dropping it
		// lost the only route))
		let domDeath = false;
		if (DOM !== null && coarse) {
			const r = roomKey === room.key ? room : rooms.get(roomKey);
			if (r !== undefined ? domOf(r) : groupNow().dom) { dDom++; domDeath = true; }
		}
		if (coarse && roomKey !== room.key) {
			const r = rooms.get(roomKey);
			if (r !== undefined) rm = r;
			else if (roomFor()) rm = newRoom(roomKey, tR, room.key, back);
			else { full = true; needSweep = true; dDrop++; return; }
		}
		// (a death that pays only as the earliest arrival and respawns in a cul-de-sac of its room (Forgotten Helix: back
		// to the mini's start by the viewing room's portal) is kept, never dropped, only without a discovery burst; dCul.
		// The respawn ENTERS the room there: its cul-de-sacs again with it as a terminal (reentry, at most REENTRY_MAX
		// entries a room; past them its cell keeps u = 2: demoted). The cul-de-sac walk is gravity-blind and two-way, so a
		// checkpoint pocket above a pit that the ball leaves only by falling out of it is a 'cul-de-sac' as seen from the
		// room's first entry, and there the death is the route (the god-int soundness review's pocketpit64: dropping the
		// death left 0 routes on 3 of 3 seeds, and so did keeping its cell demoted (u = 2: never picked); test/deaths.js))
		const culDeath = !byCost && useOf(rm, centreTile()) === 2;
		if (culDeath) { if (!back) dCul++; reentry(rm); }
		if (back) { /* counted as dBackKept below */ } else if (byCost) dCost++; else dNew++;
		const upD = mkNode(up, blk, o, n);
		addBack = back;
		const nc = add(tR, rc, null, upD, DEADBLK, 0, nd, rm);
		addBack = null;
		release(upD);
		if (nc === null) return;
		dCells++;
		// (a throw-back kept: its cell DEATH_TILES behind in head A's heaps and last in head B's sample (bk), no burst, no
		// first-cell credit: a back room's credit waits for a run that enters it another way, unback)
		if (back) { dBackKept++; nc.bk = true; nc.ver++; hpush(nc); rspBk.set(kR, nc); return; }
		if (rm !== null && rm.isNew) firstCell(rm, nc, tR);
		else if (coarse && a.burst > 0 && a.dburst !== 0 && !domDeath && !culDeath) discovery.push([nc, a.burst]);
	};
	/** the plan past its count (the editor's `steer <file>`, src/editor.js pastPlan): head A's steer heap from now on by
	 *  that field with the coin DP's value first (dpFirst: its layer fields count a coin at every touch, so they reach the
	 *  trophy from any coin tile; the DP counts distinct coins); the cells holding a snapshot are scored at once, the
	 *  others when next picked; the closest state starts over (another measure) */
	const switchSteer = (sab) => {
		if (ST === null) return;   // (a field in use: from the start, or late (steerOn), which the main thread sent first)
		let sd = null;
		try { sd = SF.readSteerFile(Buffer.from(sab)); } catch (e) { return; }
		if (!sd || sd.W !== W || sd.H !== H) return;
		ST = Object.assign(sd, { dpFirst: true });
		scFresh = new WeakSet();
		steerGen++;
		// (--spd: another measure, so the stall clock starts over: its best and the whole search's nearest were the old
		// field's; the flags go as at progress)
		spdBest = Infinity; gNear = Infinity; spdAt = Date.now();
		if (spdRooms.length) { for (const r of spdRooms) r.spd = false; spdRooms.length = 0; }
		spdTrig = 0; spdOn = 0;
		HS = heapOf(hsPrio);
		if (near !== null) { release(near.node); near = null; }
		nearSent = null;
		for (const c of cells.values()) {
			if (c.snap === null) continue;
			sim.restore(c.snap);
			c.sc = steerOf(); scFresh.add(c); c.ver++;
			hpush(c);
			if (c.node !== null) nearSteer(c);   // (the start cell has no path node: never the closest)
		}
	};
	// (a class worker: the best route up to its avoided gate, its cells every SEED_EVERY ticks: the class differs only from
	// the gate on, so the search starts from the route's own way there, not from the level's start)
	if (a.seedInputs && !end) addSeed(a.seedInputs);
	/** --spd: the stall clock (between chunks). Progress (the nearest distance down by SPD_PROGRESS) clears the flags;
	 *  --spd seconds without it flag the frontier room (the unflagged room whose best cell is nearest), at most --spdMax */
	const spdClock = (now) => {
		const d0 = near !== null ? near.rc : Infinity;
		const d = a.spdG ? Math.min(d0, gNear) : d0;
		// (--spdR=0: a route found (the shared bound dropped) ends the clock: the flags were there to reach the trophy)
		const routed = !a.spdR && maxT < spdMaxT0;
		if (d < spdBest - SPD_PROGRESS || spdBest === Infinity || routed) {
			if (d < Infinity) spdBest = d;
			spdAt = now;
			if (spdRooms.length) { spdSay({ ev: 'clear', d, d0, n: spdRooms.length, routed }); for (const r of spdRooms) r.spd = false; spdRooms.length = 0; }
			spdTrig = 0; spdOn = 0;
			return;
		}
		spdOn = spdRooms.length;
		if (now - spdAt < a.spd * 1000 || spdTrig >= a.spdMax) return;
		let br = null, bd = Infinity;
		for (const r of roomList) {
			if (r.spd || r.best === null || r.best.t >= maxT || domOf(r)) continue;
			const v = distOf(r.best);
			if (v < bd) { bd = v; br = r; }
		}
		spdAt = now;
		if (br === null) return;
		br.spd = true; spdRooms.push(br); spdTrig++; spdFlags++;
		spdSay({ ev: 'flag', d, d0, room: br.key, desc: br.desc, bd, cells: cells.size, n: spdRooms.length });
		spdOn = spdRooms.length; if (spdOn > spdPeak) spdPeak = spdOn;
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
		if (plog !== null && now - lastPlog >= PICKLOG_S * 1000) { lastPlog = now; post({ type: 'picklog', seed, rows: [...plog].map(([k, r]) => [k, r[0], r[1], r[2], r[3]]) }); }
		if (port) inbox();
		if (seedPort) for (let m = receiveMessageOnPort(seedPort); m !== undefined && !end; m = receiveMessageOnPort(seedPort)) { const x = m.message; if (x && typeof x === 'object' && x.steer) { if (x.past) switchSteer(x.steer); else steerOn(x.steer, !!x.dist); } else addSeed(String(x)); }
		// (parked: stdin "workers K" keeps only the first K workers searching, e.g. while the editor's stall escape has the
		// rest of the CPU; a parked worker keeps its archive and still answers its port (the bursts' "nearest" questions, the
		// imports) and its seeds, and searches again once K allows it)
		if (idx >= 0 && ctrl.length > 2) { const act = Atomics.load(ctrl, 2); if (act > 0 && idx >= act) { parked++; Atomics.wait(ctrl, 3, 0, PARK_MS); continue; } }
		lShare = leadShare(now); wShare = wayShare(now);
		if (coarse && a.spd > 0) spdClock(now);
		for (let k = 0; k < CHUNK && !end; k++) {
			let e = null;
			pickL = false; pickW = false;
			let head = 'A';
			if (!coarse) e = popA();
			else if (discovery.length && rnd() < 0.5) {
				// head C: a new room's first cell, --burst times
				const d = discovery[discovery.length - 1];
				e = d[0];
				head = 'C';
				if (--d[1] <= 0) discovery.pop();
				if (e.t >= maxT) continue;
			} else if (lShare > 0 && rnd() < lShare) {
				// head L (a route known): the cell most ahead of the best route (none: heads A / B as without it)
				while (HL.size() > 0) { const c = HL.pop(); if (HL.popVer !== c.ver || c.t >= maxT) continue; e = c; break; }
				if (e === null) { if (rnd() < a.pA) e = popA(); else { e = popB(); head = 'B'; } }
				else { leadPicks++; pickL = true; head = 'L'; }
			} else if (wShare > 0 && rnd() < wShare) {
				// head W (a route known): the off-schedule cell most ahead of the route by its tile alone
				while (HW.size() > 0) { const c = HW.pop(); if (HW.popVer !== c.ver || c.t >= maxT) continue; e = c; break; }
				if (e === null) { if (rnd() < a.pA) e = popA(); else { e = popB(); head = 'B'; } }
				else { wayPicks++; pickW = true; head = 'W'; }
			} else if (rnd() < a.pA) e = popA();
			else { e = popB(); head = 'B'; }
			if (e === null) { end = 'exhausted'; break; }
			// (EEAT_PICKLOG=1: the picks per head, room and 10 x 10-tile zone, with the cells they made; observation only)
			const plRow = plog !== null ? plogRow(head, e) : null;
			const cells0 = cells.size, impr0 = impr, rooms0 = roomList.length, minRc0 = minRc, room1 = e.room, zone1 = SAT ? zoneOf(e.tile) : 0;
			e.picks++; e.ver++; picks++; e.touch = picks;
			if (e.u === 2) culPicks++;
			if (PB !== null && inBox(e.tile)) boxPicks++;
			if (coarse) { e.room.picks++; if (e.room.grp !== null) { e.room.grp.picks++; if (e.room.grp.dom) picksDom++; } }
			const stale = scFresh !== null && !scFresh.has(e);
			if (!stale) hpush(e);
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
			if (stale) { sim.restore(e.snap); e.sc = steerOf(); scFresh.add(e); if (e.node !== null) nearSteer(e); hpush(e); }
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
			// (a cell made before a late steer field: its steer cost at its first pick since, into the steer heap)
			if (ST !== null && e.sc === undefined) { sim.restore(e.snap); e.sc = steerOf(); HS.push(e); }
			// the pick's runs: one input buffer for all of them (run r at r x roll)
			const blk = { b: new Uint8Array(a.rolls * a.roll), refs: 0 }, buf = blk.b, base = e.snap, up = e.node;
			for (let r = 0; r < a.rolls; r++) {
				sim.restore(base);
				const o = r * a.roll;
				let m = draw();
				let room = e.room, rcPrev = e.rc;
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
						post({ type: 'finish', seed, t, sec, simTicks: ticks, byL: pickL || e.viaL, byW: pickW || !!e.viaW, inputs: C.eetasBytes(inputsOf({ up, blk, o, n: s + 1 })).toString('latin1') });
						if (a.first) end = 'finish';
						break;
					}
					// (a death: the run ends here, unless deaths are moves and this one pays: its respawn then a cell, deathPays)
					if (sim.is_dead) { if (DI !== null) dying(up, blk, o, s + 1, t, rcPrev, room, e); break; }
					if (AV !== null && AV[centreTile()] === 1) { avoided++; break; }
					const rc = costOf();
					if (rc < 0) break;   // the reach field rules it out: no route from here
					// (deathPays: the reach cost of the last state that had a way of its own; a state whose only way is a death
					// keeps the one before it, so a fall into a pit does not make a death back to the spawn look free)
					if (!viaDeath) rcPrev = rc;
					// (coarse cells: the live state's room; a new one is made (its fields walked from this state) only when its
					// first cell can enter the archive: a full archive or a state too late for a faster route would leave an
					// empty room, and walks for nothing, outside the memory budget)
					let into = true;
					if (coarse) {
						roomKey = RM.key(sim);
						if (roomKey !== room.key) {
							if (AV !== null && AV[centreTile()] === 2 && RM.byTrigger(room.cause, RM.cause(sim))) { avoided++; break; }
							const r = rooms.get(roomKey);
							if (r !== undefined) { if (report) edge(room, r); room = r; if (r.bk) unback(r); reentry(r); }
							else if (t < maxT && roomFor()) room = newRoom(roomKey, t, room.key);
							else { into = false; if (t < maxT) { full = true; needSweep = true; } }
						}
					}
					// (a dead end of its room: no trophy and no trigger walkable from here: the run ends)
					// (not while a trigger's effect is pending: pendingTrigger)
					if (into && room !== null && room.live !== null && !liveAt(room.live, centreTile()) && !pendingTrigger(sim)) { deadCut++; break; }
					if (rc < minRc - 0.05) { minRc = rc; lastProgress = picks; }
					// (no nearest attempt in a cul-de-sac of its room: see USEFUL TERRITORY)
					if (!distBySteer && (!near || rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) && useOf(room, centreTile()) !== 2) {
						const node = mkNode(up, blk, o, s + 1);
						if (near !== null) release(near.node);
						near = { rc, t, node };
					}
					const nc = into ? add(t, rc, e, up, blk, o, s + 1, room) : null;
					// (--spdMode=1: a flagged room's fastest arrivals next to the earliest)
					if (into && a.spdMode === 1 && room !== null && room.spd === true) {
						const nf = add(t, rc, e, up, blk, o, s + 1, room, true);
						if (nf !== null && room.isNew) firstCell(room, nf, t);
					}
					if (nc !== null && room !== null && room.isNew) firstCell(room, nc, t);
				}
				if (end) break;
			}
			if (plRow !== null) { plRow[1] += cells.size - cells0; plRow[2] += impr - impr0; }
			// (the brake: the pick's region and room, by what its runs made)
			if (SAT && room1 !== null) {
				const fresh = roomList.length > rooms0 || minRc < minRc0 - 0.05;
				// (the yield: the new cells AND the earlier arrivals at known ones (impr): a region whose picks still make
				// its cells earlier is being made faster, not saturated. Egg Quest II, n2-int 10-min runs, seeds 2 / 3: counting
				// new cells alone braked the fast arrivals' regions, head A went on from slower ones: first routes 25,966 /
				// 25,849 vs 19,164 with --sat=0)
				const d = 1 - SAT_CELL * ((cells.size - cells0) + (impr - impr0));
				const v0 = room1.sat.get(zone1);
				if (v0 === undefined) nSatZ++;
				room1.sat.set(zone1, fresh ? 0 : Math.max(0, (v0 || 0) + d));
				room1.ex = fresh ? 0 : Math.max(0, room1.ex + d);
			}
			if (a.maxTicks && ticks >= a.maxTicks && !end) end = 'ticks';
		}
		pickL = false; pickW = false;
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
	const field = RF.reachField(L, fieldOpts(a));
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
		...(reachFile ? [`--reach=${reachFile}`] : []), ...(a.gmem ? [`--mem=${a.gmem}`] : []), `--hostmem=${hmem}`, `--maxPicks=${Math.max(a.batch, 1)}`, ...(a.deathMoves ? ['--deaths=1'] : []),
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
	// (the GPU keys its rooms as the legacy key does, rollRoom; --dom=1: the novelty groups and their dominance from the
	// JS key's class and mask (roomOf dom: blue coins no door on the way needs and the time doors' two states in one
	// group), head B and C as explore()'s)
	const RM = roomOf(L, { legacy: true }), RMn = a.dom !== 0 ? roomOf(L) : null, DOMg = RMn !== null ? domIndex() : null;
	const fields = roomFields(L, 64 << 20, { useful: a.useful !== 0 });
	const rooms = new Map(), roomList = [];
	let keyMismatch = 0;
	const newRoom = (key, c) => {
		const ms = c === 0 ? new Uint8Array(0) : pathOf(cNode[c]);
		sim.restore(startSnap);
		for (let s = 0; s < ms.length; s++) { E.applyMask(inp, ms[s]); sim.tick(inp); }
		if (RM.key(sim) !== key) keyMismatch++;
		const f = fields.enter(sim);
		const r = { idx: roomList.length, key, desc: RM.desc(sim), t: cT[c], gain: f.gain, troOk: f.troOk, picks: 0, ex: 0, arr: [], best: -1, isNew: true, sent: 0, sentAt: -1, grp: null };
		if (DOMg !== null) {
			const g = DOMg.groupOf(RMn.dom(sim));
			r.grp = g; g.rooms.push(r);
			if (f.gain > g.gain) g.gain = f.gain;
			if (f.troOk) g.troOk = true;
		}
		rooms.set(key, r);
		roomList.push(r);
		return r;
	};
	// ---- the dead-end brake (explore()'s, see SAT_ZONE): a region = (room, band of SAT_BAND tiles of the reach cost: the GPU's
	// cells carry no tile), its excess in satG, the room's in room.ex
	// (--satGpu=0, the default: not in the GPU random runs. Egg Quest II, seed 3: their route (main's first route there,
	// 19,553) came only with it off: n2-int + the yield fix 21,665 first, with this 19,424; seed 2 19,225 -> 19,700 (the
	// one search's route either way). The gate benchmark that set --satN has no GPU random runs: never measured there)
	const SAT = a.sat !== 0 && a.satGpu !== 0, satG = new Map();
	const regionOf = (c) => cRoom[c] * 4096 + Math.min(4095, (cRc[c] / SAT_BAND) | 0);
	const exG = (c) => { const v = satG.get(regionOf(c)); return v === undefined ? 0 : v; };
	// ---- head A's heap (explore()'s): (priority, cell, version)
	const hv = [], hc = [], hver = [];
	const prio = (c) => cRc[c] + a.lambda * Math.sqrt(cPicks[c]) + (SAT ? SAT_MU * satOver(exG(c), a.satN) : 0);
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
	let popVer = 0, popVal = 0;
	const hpop = () => {
		const c = hc[0];
		popVer = hver[0];
		popVal = hv[0];
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
			// (the brake grew since the cell was queued: back into the queue at its priority now)
			if (SAT && prio(c) > popVal + SAT_SLACK) { hpush(c); continue; }
			return c;
		}
		return -1;
	};
	const popB = () => {
		let br = null, bw = -1;
		if (DOMg !== null) {
			const GL = DOMg.list;
			let bg = null;
			for (let k = 0; k < 4 && GL.length; k++) {
				const g = GL[(rnd() * GL.length) | 0];
				let n = 0, ex = 0;
				for (const r of g.rooms) { if (r.bk) continue; n += r.arr.length; if (r.ex > ex) ex = r.ex; }
				if (!n) continue;
				const w = (1 + Math.log(1 + g.gain)) * (g.troOk ? 2 : 1) / Math.sqrt(1 + g.picks / 50) / (SAT ? 1 + satOver(ex, a.satN) / SAT_B : 1);
				if (w > bw) { bw = w; bg = g; }
			}
			if (bg !== null) {
				if (bg.rooms.length === 1) br = bg.rooms[0].bk ? null : bg.rooms[0];
				else {
					// (its rooms (the time doors' two states) by main's room weight: the one picked least, as a tournament of them)
					let rw = -1;
					for (const r of bg.rooms) {
						if (!r.arr.length || r.bk) continue;
						const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50) / (SAT ? 1 + satOver(r.ex, a.satN) / SAT_B : 1);
						if (w > rw) { rw = w; br = r; }
					}
				}
			}
		} else {
			for (let k = 0; k < 4; k++) {
				const r = roomList[(rnd() * roomList.length) | 0];
				if (!r.arr.length || r.bk) continue;
				const w = (1 + Math.log(1 + r.gain)) * (r.troOk ? 2 : 1) / Math.sqrt(1 + r.picks / 50) / (SAT ? 1 + satOver(r.ex, a.satN) / SAT_B : 1);
				if (w > bw) { bw = w; br = r; }
			}
		}
		if (br === null) return popA();
		const arr = br.arr;
		let bc = -1, bs = -1;
		for (let k = 0; k < a.sample; k++) {
			const c = arr[(rnd() * arr.length) | 0];
			if (cT[c] >= maxT) continue;
			const sc = (1 / Math.sqrt(1 + cSeen[c]) + 1 / Math.sqrt(1 + cPicks[c])) / (SAT ? 1 + satOver(exG(c), a.satN) / SAT_B : 1);
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
	// (the brake: each pick's region at its pick, the new cells its runs made, whether they found a room or a nearer attempt)
	const pickReg = new Float64Array(a.batch), pickNew = new Int32Array(a.batch), pickFresh = new Uint8Array(a.batch), newPk = new Map();
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
			{ const pr = roomList[cRoom[e]]; pr.picks++; if (pr.grp !== null) pr.grp.picks++; }
			hpush(e);
			pickNode[K] = cNode[e];
			if (SAT) { pickReg[K] = regionOf(e); pickNew[K] = 0; pickFresh[K] = 0; }
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
			if (isNew) { grow(d + 1); if (d < nCells) reordered++; else nCells = d + 1; cPicks[d] = 0; cVer[d] = 0; cSeen[d] = 0; if (SAT && pk < K) { pickNew[pk]++; newPk.set(d, pk); } }
			else if (t >= cT[d]) continue;
			cT[d] = t; cNode[d] = node;
			const rc = costOf(fifths, node);
			cRc[d] = rc;
			if (!isNew) { cVer[d]++; if (SAT && pk < K) pickNew[pk]++; }   // (an earlier arrival is yield too: the brake, above)
			hpush(d);
			if (t > deepest) deepest = t;
			if (rc < minRc - 0.05) minRc = rc;
			if (rc < near.rc - 1e-3 || (rc <= near.rc + 1e-3 && t < near.t)) { if (SAT && rc < near.rc - 0.05 && pk < K) pickFresh[pk] = 1; near = { rc, t, c: d }; }
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
			if (SAT && newPk.has(c0)) pickFresh[newPk.get(c0)] = 1;
			for (const c of p.cells) { cRoom[c] = r.idx; r.arr.push(c); if (r.best < 0 || cRc[c] < cRc[r.best]) r.best = c; }
			r.isNew = false;
			// (a dominated room: no discovery burst, no source)
			const dm = r.grp !== null && r.grp.dom;
			if (r.gain > 0 && a.burst > 0 && !dm) discovery.push([c0, a.burst]);
			if (!dm && (r.gain > 0 || Date.now() - lastBlandSource >= SOURCE_S * 1000) && cT[c0] >= SOURCE_MIN_TICKS) {
				if (r.gain <= 0) lastBlandSource = Date.now();
				source('room', r, c0);
			}
		}
		// the brake: every pick's region and room by what its runs made
		if (SAT) {
			for (let k = 0; k < K; k++) {
				const rr = roomList[cRoom[pickBuf[k]]], d = 1 - SAT_CELL * pickNew[k], v0 = satG.get(pickReg[k]) || 0;
				satG.set(pickReg[k], pickFresh[k] ? 0 : Math.max(0, v0 + d));
				if (rr) rr.ex = pickFresh[k] ? 0 : Math.max(0, rr.ex + d);
			}
			newPk.clear();
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
					say({ ev: 'result', kind: 'finish', ticks: t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), deaths: ev.deaths, inputs: C.eetasBytes(ev.ms).toString('latin1'), seed: a.seed, simTicks: ticks, sec });
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
		...(end === 'unreachable' ? { levelFile: levelFileOf(a) } : {}), finish: route ? route.ticks : 0, first, cells: 'coarse', gpu: true, batches, rooms: roomList.length, full, gpuMs: Math.round(gpuMs), hostMs: Math.round(hostMs), rollMs: Math.round(rollMs), kernelMs: Math.round(kernelMs), records, touched, colMs: Math.round(colMs), rollWallMs: Math.round(rollWallMs), pickMs: Math.round(pickMs), seenMs: Math.round(seenMs), waitMs: Math.round(waitMs), reordered,
		roomKeyMismatch: keyMismatch, loadSec: Math.round((tReady - t0) / 100) / 10,
		// (eegpu roll's launch figures, as the other GPU tools' done events have them)
		...Object.fromEntries(['maxLaunchMs', 'maxKernelMs', 'kernelLaunches', 'launchTotalMs', 'kernelTotalMs', 'gapMs', 'hostCpuMs', 'launchTarget'].filter((k) => toolDone && toolDone[k] !== undefined)
			.map((k) => [k, toolDone[k]])), tool: toolDone || null });
	console.log(`[goexplore] GPU (${info.gpu ? info.gpu.name : '?'}), batch ${a.batch} x ${a.rolls} x ${a.roll}, ${secs.toFixed(1)} s, ${(ticks / 1e6).toFixed(2)} M ticks, ` +
		`${nCells.toLocaleString('en-US')} cells in ${roomList.length} rooms, ${batches} batches (GPU ${(gpuMs / 1000).toFixed(1)} s, host ${(hostMs / 1000).toFixed(1)} s), end ${end}: ` +
		(route ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks); best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s`
			: `no route (closest: reach cost ${near.rc.toFixed(2)} at tick ${near.t})`) + (end === 'unreachable' ? ` (the reach field rules the start out: ${levelFileOf(a) || 'this level'})` : ''));
}

function workerMain() {
	const d = workerData;
	// (--nice: this worker thread alone. On Linux the nice value is a thread's: setpriority(PRIO_PROCESS, 0) = the calling
	// thread, which a lower priority needs no privilege for; child processes inherit the main thread's)
	if (d.a.nice > 0 && process.platform === 'linux') { try { os.setPriority(0, Math.min(19, Math.round(d.a.nice))); } catch (e) { /* as it is */ } }
	const L = levelOf(d.a);
	// (the steer field: views on the main thread's shared bytes, no copy per worker)
	const a = Object.assign({}, d.a, d.steerBuf ? { steerData: Object.assign(SF.readSteerFile(Buffer.from(d.steerBuf)), { dpFirst: d.a.dpFirst === 1 }) } : {}, d.lb ? { lbTiles: d.lb } : {},
		d.avoid ? { avoidTiles: d.avoid } : {});
	explore(L, d.field, a, d.seed, d.ctrl, (m) => parentPort.postMessage(m), d.port || null, d.seedPort || null, Number.isInteger(d.idx) ? d.idx : -1, d.ofield || null);
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
	const field = RF.shareField(RF.reachField(L, fieldOpts(a)));
	// (--dord: the death-free field for the workers' order, shared like the field; only with deaths as moves)
	const ofield = a.deathMoves && a.dord !== 0 ? RF.shareField(RF.reachField(L, { deaths: false })) : null;
	// (timed killers in the level: src/timed.js; the workers build their own bounds)
	const TMD_L = TMD.timedOf(L) !== null;
	const sim0 = new E.EESim(L);
	sim0.reset();
	const pre0 = prefixOf(a);
	const preStr = pre0 ? C.eetasBytes(pre0).toString('latin1') : '';
	if (pre0) { const inp0 = new E.EEInput(); for (let s = 0; s < pre0.length; s++) { E.applyMask(inp0, pre0[s]); sim0.tick(inp0); } }
	const startCost = RF.costAt(field, sim0);
	// (the sound lower bound per tile: every worker's prune once a route is known, in shared memory)
	const lb = a.lb ? lowerBoundTiles(L) : null;
	// (ctrl: [0] the depth bound, [1] the stop flag, [2] the workers searching (0: all; stdin "workers K": the others park),
	// [3] unused: the parked workers wait on it)
	const ctrl = new Int32Array(new SharedArrayBuffer(16));
	ctrl[0] = a.depth;
	const seeds = Array.from({ length: a.workers }, (_, i) => (a.seed + i) >>> 0);
	// the seeds' channels (stdin "seed <inputs>"): each worker polls its end between chunks of picks (receiveMessageOnPort:
	// its loop never yields to the event loop)
	const seedChannels = seeds.map(() => new MessageChannel());
	const seedPorts = seedChannels.map((c) => c.port1), seedIn = seedChannels.map((c) => c.port2);
	// --steer=<RCH4 file> (the editor's, src/steer.js) or --steer=build: the steer field in shared memory for the workers'
	// second goal heap; a file of another level (or one that cannot be read) is ignored with a warning
	// (stdin "steer <file>" with --stdin=1: the same, late, for a search that started without it: steerLate below)
	const loadSteer = (file, dist) => {
		const bytes = file === 'build' ? SF.steerFileBytes(SF.buildSteer(L)) : fs.readFileSync(file);
		const sab = new SharedArrayBuffer(bytes.length);
		new Uint8Array(sab).set(bytes);
		const sd = SF.readSteerFile(Buffer.from(sab));
		if (sd.W !== L.width || sd.H !== L.height) throw new Error('it was made for another level');
		if (sd.levelFp[0] || sd.levelFp[1]) {
			let fp = null;
			try { const G = require('./gpu.js'); fp = G.blobFp(G.levelBlob(L)); } catch (e) { /* a level the native tool cannot take: the size check only */ }
			if (fp && (fp[0] >>> 0 !== sd.levelFp[0] || fp[1] >>> 0 !== sd.levelFp[1])) throw new Error('it was made for another level');
		}
		const s0 = SF.steerAt(sd, sim0);
		return { sab, note: { layers: sd.S, bodies: sd.bodies.length, coinDP: sd.dp ? sd.dp.n : 0, start: Number.isFinite(s0) ? Math.round(s0 * 100) / 100 : null, mix: a.mix, dist } };
	};
	let steerBuf = null, steerNote = null;
	if (a.steer) {
		try { const r = loadSteer(a.steer, a.steerDist !== 0); steerBuf = r.sab; steerNote = r.note; } catch (e) { say({ ev: 'warning', text: `the steer field is not used: ${e.message}` }); }
	}
	/** stdin "steer <file>": a steer field that was not ready when the search started (the editor's build on a loaded
	 *  machine): to every worker (head A's second heap from its next chunk of picks: steerOn); the distances stay the reach
	 *  field's; a "steer" event says so (or a warning why not). Once per search. */
	const steerLate = (file, dist = false) => {
		if (steerBuf) return;
		try {
			const r = loadSteer(file, dist);
			steerBuf = r.sab; steerNote = r.note; a.steerDist = dist ? 1 : 0;
			// (dist, stdin "steerd <file>": the distances by it from now on: another measure, so the closest attempt and
			// the sources' lowest distances start over; the workers' closest of the reach field's (an older gen) are dropped)
			if (dist) { near = null; nearPending = false; steerGen++; for (const q of sourcesSent.values()) q.dist = Infinity; }
			for (const p of seedPorts) p.postMessage(dist ? { steer: r.sab, dist: true } : { steer: r.sab });
			say(Object.assign({ ev: 'steer', sec: sec() }, r.note, dist ? { dist: true } : {}));
		} catch (e) { say({ ev: 'warning', text: `the late steer field is not used: ${e.message}` }); }
	};
	say({ ev: 'start', workers: a.workers, seeds, mode: field.mode, cells: a.cells, startCost: startCost < 0 ? null : Math.round(startCost * 100) / 100, steer: steerNote, deathMoves: !!a.deathMoves, mem: a.mem, memWhy: a.memWhy,
		processMB: Math.round(claimed / 1048576), machineMB: Math.round(m.total / 1048576), freeMB: Math.round(m.free / 1048576), othersMB: Math.round(m.others / 1048576),
		maxCells: a.maxCells, maxSnaps: a.maxSnaps });
	// the fastest verified route; the closest state
	let route = null, first = null, near = null, nearPending = false, heapWarned = false, steerGen = 0;
	const stats = new Map(), dones = new Map(), plogs = new Map();
	const total = (k) => { let s = 0; for (const v of stats.values()) s += v[k] || 0; return s; };
	let nLead = 0, nWay = 0;   // (the routes head-L picks found; the routes that descend from a head-W pick)
	const samples = [[Date.now(), 0]];
	const bound = (d) => { if (d < Atomics.load(ctrl, 0)) Atomics.store(ctrl, 0, Math.max(0, d)); };
	// (deaths as moves: the workers' dying states, kept by the cost (i) or as the earliest arrival (ii), dropped, and the
	// respawns' new cells)
	// (--timed, a level with timed killers: the cells made while a killer ran, the states dropped as dominated (a cell of the
	// same place with more time left got there no later), with --timed=0 the states dropped though they had more time left
	// than the kept one, the doomed states priced as their death)
	const timedNow = () => (TMD_L ? { timed: { on: a.timed !== 0, cells: total('tCells'), dominated: total('tDom'), droppedMore: total('tMore'), doomed: total('tDoomed') } } : {});
	const deathsNow = () => (a.deathMoves ? { deaths: { seen: total('dSeen'), byCost: total('dCost'), byNew: total('dNew'), dropped: total('dDrop'), back: total('dBack'), backKept: total('dBackKept'), backByOrder: total('dBackR'), backBySteer: total('dBackS'), backPromoted: total('dPromote'), useless: total('dCul'), cells: total('dCells'), deadTicks: total('dTicks'), dominated: total('dDom') } } : {});
	// (the useful territory, coarse cells: the picks and cells in cul-de-sacs of their rooms, the rooms whose territory gain
	// was all off the band (gain 0), the cul-de-sac bitsets kept)
	const usefulNow = () => (a.cells === 'coarse' && a.useful !== 0 ? { useful: { culPicks: total('culPicks'), culCells: total('culCells'), zeroed: total('zeroed'), culSets: total('culSets'), culDropped: total('culDropped'), reculs: total('reculs') } } : {});
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
		a.cells === 'coarse' ? { rooms: nRooms, groups: total('groups'), groupsDom: total('dominated'), picksDom: total('picksDom') } : {}, one ? { allRooms: one.rooms.size, shared: one.shared, fed: one.fed } : {}, bursts ? { gpu: bursts.stats() } : {},
		{ workers: a.workers, memMB: total('memMB'), heapMB: total('heapMB'), evicted: total('evicted'), cpuS: cpuSec() }, deathsNow(), timedNow(), usefulNow(), total('spdFlags') ? { spdOn: total('spdOn'), spdFlags: total('spdFlags') } : {}, route ? { lbCut: total('lbCut'), leadPicks: total('leadPicks'), wayPicks: total('wayPicks'), leadRoutes: nLead, wayRoutes: nWay, leadShare: stats.size ? Math.round(1000 * total('leadShare') / stats.size) / 1000 : 0 } : {}, total('seeded') ? { seeded: total('seeded'), seedCells: total('seedCells') } : {}));
	};
	// the workers' sources, each room key once per kind unless it improved (an earlier arrival, a lower cost): every
	// worker finds the same rooms
	const sourcesSent = new Map();   // room key -> {tick: the earliest "room" arrival sent, dist: the lowest "best" cost sent}
	const onSource = (msg) => {
		// (a worker's source by an older measure than the last switch's (a late field with its distances, the plan past its
		// count; sent before the worker took the switch): ranked behind every one of the new measure, as a cell not scored
		// yet (6000 + its distance: distOf); a room's first arrival is still one. Before, a reach cost sent just before
		// "steerd" (Forgotten Helix: ~925 tiles against the steer field's 1000-2100) stayed its room's best for the search)
		const rc = (msg.gen || 0) < steerGen && msg.rc < 6000 ? Math.min(9990, 6000 + msg.rc) : msg.rc;
		let s = sourcesSent.get(msg.room);
		if (!s) sourcesSent.set(msg.room, s = { tick: Infinity, dist: Infinity });
		if (msg.kind === 'room') { if (msg.t >= s.tick) return; s.tick = msg.t; } else { if (rc >= s.dist - 0.5) return; s.dist = rc; }
		// (sg: the steer switches made, as on the closest attempts: the editor ranks a source of an older measure behind)
		say(Object.assign({ ev: 'source', kind: msg.kind, room: msg.room, desc: msg.desc, gain: msg.gain, tick: msg.t, dist: Math.round(rc * 1000) / 1000, inputs: msg.inputs, seed: msg.seed }, steerGen ? { sg: steerGen } : {}));
	};
	const flushNear = () => {
		if (!nearPending) return;
		nearPending = false;
		// (sg: the steer switches made: the editor takes a closest attempt of the plan past its count only with sg)
		say(Object.assign({ ev: 'closest', dist: Math.round(near.rc * 1000) / 1000, tick: near.t, inputs: near.inputs }, steerGen ? { sg: steerGen } : {}));
		// (before any route: the nearest attempt is the route arm's target, --rArmPre)
		try { if (bursts && !armRouted && armGate && bursts.attempt) bursts.attempt(near.inputs); } catch (e) { /* the bursts not made yet */ }
	};
	// (armGate: with --stdin=1 the arm starts before any route only after the editor's first "arm" line (it sends them once
	// the GPU random runs run and no GPU strategy waits on memory); without stdin at once)
	let armRouted = false, armGate = !a.stdin;
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
				else if (line.startsWith('steer ') && line.length > 6 && !steerBuf) steerLate(line.slice(6));
				else if (line.startsWith('steerd ') && line.length > 7 && !steerBuf) steerLate(line.slice(7), true);
				// (the editor's stall escape: only the first K workers search, the others park; 0 or K >= the workers: all)
				else if (/^workers \d+$/.test(line)) {
					const k = +line.slice(8), act = k > 0 && k < a.workers ? k : 0;
					Atomics.store(ctrl, 2, act);
					say({ ev: 'workers', active: act || a.workers, of: a.workers });
				}
				else if (line.startsWith('import ') && one) {
					// (the one search: another operator's run, the editor's GPU random runs, into every archive)
					const inputs = line.slice(7);
					if (/^[0-O]+$/.test(inputs)) { one.broadcast(inputs, -1); one.fed++; }
				} else if (line.startsWith('route ') && /^[0-O]+$/.test(line.slice(6))) adopt(line.slice(6));
				// (before any route: another search's nearest attempt (the editor's GPU random runs: their archive takes no
				// imports, and their routes often come first) as the route arm's target, --rArmPre)
				else if (line.startsWith('arm ') && /^[0-O]+$/.test(line.slice(4))) { armGate = true; try { if (bursts && !armRouted && bursts.attempt) bursts.attempt(line.slice(4)); } catch (e) { /* not yet */ } }
				else if (line.startsWith('steer ') && steerBuf) {
					// (the editor's plan past its count, src/editor.js pastPlan: every worker's head A by it, dpFirst; the
					// closest attempt starts over: another measure)
					try {
						const bytes = fs.readFileSync(line.slice(6));
						const sab = new SharedArrayBuffer(bytes.length);
						new Uint8Array(sab).set(bytes);
						const sd = SF.readSteerFile(Buffer.from(sab));
						if (sd.W !== L.width || sd.H !== L.height) throw new Error('it was made for another level');
						for (const p of seedPorts) p.postMessage({ steer: sab, past: true });
						near = null; nearPending = false; steerGen++;
						const s0 = SF.steerAt(Object.assign(sd, { dpFirst: true }), sim0);
						say({ ev: 'steer', dp: sd.dp ? { n: sd.dp.n, T: sd.dp.T } : null, start: Number.isFinite(s0) ? Math.round(s0 * 100) / 100 : null });
					} catch (e) { say({ ev: 'warning', text: `the steer field past the plan is not used: ${e.message}` }); }
				}
			}
		});
		// the end of stdin: the editor went away (a crash, or a kill that missed its children): stop, rather than run on
		// every thread for the rest of --seconds
		process.stdin.on('end', () => Atomics.store(ctrl, 1, 1));
		process.stdin.on('error', () => Atomics.store(ctrl, 1, 1));
	}
	/** a route (masks) from worker `seed` (0: a GPU burst) after simTicks simulated ticks: replayed in the exact engine
	 *  before it counts (the same engine found it, from snapshots and replays: a mismatch would be a bug) */
	const routeFound = (masks, seed, simTicks, who, byL = false, byW = false, how = '') => {
		const t = masks.length;
		if (route && t >= route.ticks) return;
		const ev = C.evaluate(L, masks);
		if (!ev || ev.ms.length !== t) { say({ ev: 'warning', text: `${who}: a route of ${t} ticks does not replay (${ev ? `finishes after ${ev.ms.length}` : 'does not finish'})` }); return; }
		bound(t - 1);
		const inputs = C.eetasBytes(ev.ms).toString('latin1');
		route = { ticks: t, runTicks: ev.runTicks, inputs, seed, simTicks, sec: sec() };
		if (byL) nLead++;
		if (byW) nWay++;
		// (head L of every worker: the new best route's schedule; byL: a head-L pick found it, its share's yield)
		if (one && (a.pL > 0 || a.pW > 0)) for (const p of one.ports) p.postMessage({ type: 'route', inputs, byL, byW });
		if (!first) first = { ticks: t, sec: route.sec, simTicks, seed };
		const cls = classOf(ev.ms);
		say({ ev: 'result', kind: 'finish', ticks: t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), deaths: ev.deaths, inputs, seed, simTicks, sec: route.sec, ...(seed ? {} : { by: 'gpu' }), ...(byL ? { byL: true } : {}), ...(byW ? { byW: true } : {}),
			...(how ? { how } : {}), ...(cls ? { gates: cls.sig } : {}) });
		if (a.out) { try { C.writeEetas(a.out, ev.ms); } catch (e) { say({ ev: 'warning', text: `cannot write ${a.out}: ${e.message}` }); } }
		if (a.first) Atomics.store(ctrl, 1, 1);
		onBest(ev.ms, cls);
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
		const cls = classOf(ev.ms);
		say({ ev: 'route', ticks: masks.length, runTicks: ev.runTicks, ...(cls ? { gates: cls.sig } : {}) });
		onBest(ev.ms, cls);
	};
	// ---- the route classes (--classW, coarse cells): a route's class = its gates of rank 0-2 (routeGates); the class
	// workers avoid one gate of the best route each, in turn (CLASS_S), and report a route of another class even when it is
	// slower than the best ("result" kind "class"), so the AutoTASer can optimize both classes (Stupid Fox: the first route
	// took the 10-coin door in 5 of 5 runs, the door-free class came 743-1,643 s later and optimizes to 0:36.26 vs 0:55.48)
	const CW = a.classW > 0 && a.cells === 'coarse' && L.fg.includes(121) ? { G: null, queue: [], k: 0, live: new Set(), classes: new Map(), bestSig: null, ended: false, found: 0, runs: 0, ticks: 0 } : null;
	/** a route's gates and class signature (null without class workers) */
	function classOf(ms) {
		if (!CW) return null;
		try { if (!CW.G) CW.G = gateContext(L); return routeGates(L, CW.G, ms); } catch (e) { say({ ev: 'warning', text: `route classes: ${e.message}` }); return null; }
	}
	const startTile = Math.min(L.width * L.height - 1, Math.max(0, (Math.trunc(sim0.py + 8) >> 4) * L.width + (Math.trunc(sim0.px + 8) >> 4)));
	/** a new best route: its class is the best's; a new class of best: the gates to avoid (rank 0-2, in that order, then
	 *  the route's; only those the trophy stays walkable without) and the class workers */
	function onBest(ms, cls) {
		armRouted = true;
		if (bursts) bursts.route(ms);
		if (!CW || !cls) return;
		CW.bestTicks = ms.length;
		CW.bestMs = ms;
		const prior = CW.classes.get(cls.sig);
		if (!prior || ms.length < prior.ticks) CW.classes.set(cls.sig, { ticks: ms.length, gates: cls.gates.filter((g) => g.rank <= 2).map((g) => g.desc) });
		if (cls.sig === CW.bestSig) return;
		CW.bestSig = cls.sig;
		// (the order: coin doors first (a coin door commits the route to its coins: Stupid Fox's 10-coin door), then the
		// switch / key / effect triggers (Forgotten Veil's purple switch 0), then the other doors; each in the route's order)
		const ord = (g) => (g.rank === 2 ? 0 : g.rank === 0 ? 1 : 2);
		const q = cls.gates.filter((g) => g.rank <= 2).sort((x, y) => ord(x) - ord(y) || x.t - y.t);
		CW.queue = q.filter((g) => { try { return gateAvoidable(L, CW.G, g, startTile); } catch (e) { return false; } });
		CW.k = 0;
		say({ ev: 'classes', best: cls.sig, gates: cls.gates.length, avoid: CW.queue.map((g) => g.desc) });
		while (CW.live.size < a.classW && CW.queue.length && !CW.ended) if (!startClass()) break;
	}
	/** the next class worker (the next gate of the queue, in turn) */
	function startClass() {
		if (!CW.queue.length || CW.ended) return false;
		const busy = new Set([...CW.live].map((w) => w.gate.key));
		let g = null;
		for (let k = 0; k < CW.queue.length && !g; k++) { const c = CW.queue[(CW.k + k) % CW.queue.length]; if (!busy.has(c.key)) { g = c; CW.k = (CW.k + k + 1) % CW.queue.length; } }
		if (!g) return false;
		const left = a.seconds - (Date.now() - t0) / 1000;
		if (left < 10) return false;
		const cctrl = new Int32Array(new SharedArrayBuffer(8));
		cctrl[0] = Math.min(a.depth, Math.round(a.classSlack * (CW.bestTicks || a.depth)));
		const seed = (a.seed + 7001 + CW.runs * 13) >>> 0;
		CW.runs++;
		const pre = CW.bestMs ? C.eetasBytes(CW.bestMs.subarray(0, Math.max(0, g.t - CLASS_BACK))).toString('latin1') : '';
		const w = new Worker(__filename, { workerData: { goexplore: true, a: Object.assign({}, a, { seconds: Math.min(a.classS, left - 2), seedInputs: pre }), seed, ctrl: cctrl, field, ofield, steerBuf, lb, port: null, seedPort: null,
			avoid: avoidTilesOf(CW.G, g) },
			resourceLimits: { maxOldGenerationSizeMb: Math.round(HEAP_F * a.mem + HEAP_ADD), maxYoungGenerationSizeMb: HEAP_YOUNG } });
		const rec = { w, gate: g, ctrl: cctrl, seed, ticks: 0 };
		CW.live.add(rec);
		say({ ev: 'class', what: 'start', avoid: g.desc, seconds: Math.round(Math.min(a.classS, left - 2)), bound: cctrl[0], seed });
		w.on('message', (m) => {
			if (m.type === 'stat' || m.type === 'done') rec.ticks = m.ticks || rec.ticks;
			if (m.type === 'finish') classFound(Uint8Array.from(m.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31), rec);
		});
		w.on('error', (e) => say({ ev: 'warning', text: `class worker (${g.desc}): ${e && e.message ? e.message : e}` }));
		w.on('exit', () => {
			CW.live.delete(rec);
			CW.ticks += rec.ticks;
			if (!CW.ended) startClass();
		});
		return true;
	}
	/** a class worker's route: the best when it is faster; else a route of another class when its gates differ from the
	 *  best's (each class's fastest is reported) */
	function classFound(masks, rec) {
		const ev = C.evaluate(L, masks);
		if (!ev || ev.ms.length !== masks.length) { say({ ev: 'warning', text: `class worker: a route of ${masks.length} ticks does not replay` }); return; }
		const t = ev.ms.length;
		if (t - 1 < Atomics.load(rec.ctrl, 0)) Atomics.store(rec.ctrl, 0, t - 1);
		if (!route || t < route.ticks) { routeFound(ev.ms, rec.seed, 0, `class worker (avoiding ${rec.gate.desc})`, false, false, `class worker avoiding ${rec.gate.desc}`); return; }
		const cls = classOf(ev.ms);
		if (!cls || cls.sig === CW.bestSig) return;
		const prior = CW.classes.get(cls.sig);
		if (prior && prior.ticks <= t) return;
		CW.classes.set(cls.sig, { ticks: t, gates: cls.gates.filter((g) => g.rank <= 2).map((g) => g.desc) });
		CW.found++;
		say({ ev: 'result', kind: 'class', ticks: t, runTicks: ev.runTicks, time: C.fmt(ev.runTicks), inputs: C.eetasBytes(ev.ms).toString('latin1'), avoid: rec.gate.desc,
			gates: cls.sig, desc: CW.classes.get(cls.sig).gates.join('; '), best: route.ticks, sec: sec(), new: !prior });
	}
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
			// (--dom=1: the room's novelty group over every worker's and burst's rooms: the GPU bursts leave dominated ones out)
			const g = one.dom !== null && m.dcls !== undefined && m.dmask ? one.dom.groupOf({ cls: m.dcls, mask: Int32Array.from(m.dmask) }) : (r ? r.grp : null);
			if (r) { if (m.t < r.t) { r.t = m.t; if (bursts) bursts.room(Object.assign({}, m, { grp: r.grp })); } return false; }
			one.rooms.set(m.room, { t: m.t, desc: m.desc, tile: m.tile, grp: g });
			if (g !== null) m = Object.assign({}, m, { grp: g });
			if (bursts) bursts.room(m);
			// (--rooms=1: every room found, with the inputs that reach it: the gate benchmark watches for its target room)
			if (a.rooms && m.inputs && m.t > (pre0 ? pre0.length : 0)) say({ ev: 'room', room: m.room, desc: m.desc, t: m.t, sec: sec(), by: m.seed === undefined ? 'gpu' : 'cpu', sub: m.sub, keys: m.keys, ...(m.wt !== undefined ? { wt: m.wt } : {}), inputs: m.inputs });
			return true;
		};
		one.dom = a.dom !== 0 ? domIndex() : null;
		const d0 = RM.dom(sim0);
		one.register({ room: RM.key(sim0), desc: RM.desc(sim0), dcls: d0.cls, dmask: Array.from(d0.mask), tile: Math.min(L.width * L.height - 1, Math.max(0, (Math.trunc(sim0.py + 8) >> 4) * L.width + (Math.trunc(sim0.px + 8) >> 4))), t: pre0 ? pre0.length : 0, inputs: preStr });
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
			// (a worker's closest by an older steer field than the last switch's: another measure, dropped)
			if ((msg.gen || 0) < steerGen) return;
			if (!near || msg.rc < near.rc - 1e-3 || (msg.rc <= near.rc + 1e-3 && msg.t < near.t)) {
				// (--spdG: the whole search's nearest distance to every worker's stall clock; gen: the steer switches made,
				// a worker drops one of an older measure)
				if (one && a.spd > 0 && a.spdG && (!near || msg.rc < near.rc - 1e-3)) for (const p of one.ports) p.postMessage({ type: 'gnear', rc: msg.rc, gen: steerGen });
				near = msg; nearPending = true;
			}
		} else if (msg.type === 'source') {
			onSource(msg);
		} else if (msg.type === 'room') {
			if (one && one.register(msg) && a.share && a.workers > 1) { one.broadcast(msg.inputs, msg.seed); one.shared++; }
		} else if (msg.type === 'edge') {
			if (bursts) bursts.edge(msg.from, msg.tile, msg.to, msg.trig);
		} else if (msg.type === 'finish') {
			routeFound(Uint8Array.from(msg.inputs, (ch) => (ch.charCodeAt(0) - 48) & 31), msg.seed, msg.simTicks, `worker ${msg.seed}`, !!msg.byL, !!msg.byW);
		} else if (msg.type === 'picklog') {
			plogs.set(msg.seed, msg.rows);
			// (every worker's latest log summed: the 60 rows with the most picks)
			if (plogs.size >= stats.size) {
				const sum = new Map();
				for (const rows of plogs.values()) for (const [k, n, nc, im, desc] of rows) { const r = sum.get(k); if (r) { r[1] += n; r[2] += nc; r[3] += im; } else sum.set(k, [k, n, nc, im, desc]); }
				const rows = [...sum.values()].sort((x, y) => y[1] - x[1]).slice(0, 60).map(([k, n, nc, im, desc]) => { const [h, , z] = k.split('|'); return [h, desc, z, n, nc, im]; });
				let picks = 0; for (const r of sum.values()) picks += r[1];
				say({ ev: 'picklog', sec: sec(), picks, rows });
				plogs.clear();
			}
		} else if (msg.type === 'done') dones.set(msg.seed, msg);
	};
	const workers = seeds.map((seed, i) => new Promise((res) => {
		// (the heap limit: room for the garbage between two collections above the budget, which counts what the heap holds;
		// the one search: a channel per worker, see above; the wall breaker's seeds: another)
		let port = null;
		const list = [seedIn[i]];
		if (one) { const ch = new MessageChannel(); port = ch.port2; list.push(port); one.ports.push(ch.port1); }
		const w = new Worker(__filename, { workerData: { goexplore: true, a, seed, ctrl, field, ofield, steerBuf, lb, port, seedPort: seedIn[i], idx: i }, transferList: list,
			resourceLimits: { maxOldGenerationSizeMb: Math.round(HEAP_F * a.mem + HEAP_ADD), maxYoungGenerationSizeMb: HEAP_YOUNG } });
		w.on('message', onMessage);
		// (a worker that dies (its V8 heap limit: ERR_WORKER_OUT_OF_MEMORY, a throw) says so with the heap numbers: the
		// editor's supervisor logs the one search's end, src/editor.js oneEnded)
		const heapNow = () => { const d = stats.get(seed) || {}; const m = process.memoryUsage(); return { heapMB: d.heapMB || 0, memMB: d.memMB || 0, cells: d.cells || 0, mainHeapMB: Math.round(m.heapUsed / 1048576), rssMB: Math.round(m.rss / 1048576) }; };
		w.on('error', (e) => { say({ ev: 'warning', text: `worker ${seed}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`, workerError: true, code: e && e.code ? e.code : null, ...heapNow() }); res(); });
		w.on('exit', (code) => { if (code) say({ ev: 'warning', text: `worker ${seed} exited with code ${code}`, workerExit: code, ...heapNow() }); res(); });
	}));
	if (one && a.bursts) {
		const BU = require('./bursts.js');
		try {
			bursts = BU.create({ L, a, field, RM: one.RM, ports: one.ports, say, minLen: pre0 ? pre0.length : 0, bound: () => Atomics.load(ctrl, 0), register: one.register, sec: () => (Date.now() - t0) / 1000,
				broadcast: (inputs) => one.broadcast(inputs, -1), finish: (masks, how) => routeFound(masks, 0, 0, how ? 'the route arm' : 'a GPU burst', false, false, how || ''),
				nearest: () => (near && near.inputs ? { inputs: near.inputs, rc: near.rc } : null) });
			for (const [k, r] of one.rooms) bursts.room({ room: k, desc: r.desc, tile: r.tile, t: r.t, inputs: preStr });
			bursts.start();
		} catch (e) { say({ ev: 'warning', text: `no GPU bursts: ${e.message}` }); bursts = null; }
	}
	await Promise.all(workers);
	// (the class workers end with the search)
	if (CW) {
		CW.ended = true;
		const live = [...CW.live];
		for (const r of live) Atomics.store(r.ctrl, 1, 1);
		await Promise.all(live.map((r) => new Promise((res) => { r.w.once('exit', res); setTimeout(res, 5000); })));
	}
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
		picks: total('picks'), end, ...(end === 'unreachable' ? { levelFile: levelFileOf(a) } : {}), finish: route ? route.ticks : 0, first, leadRoutes: nLead, wayRoutes: nWay, cpuS: cpuSec(), ...deathsNow(), ...timedNow(), ...usefulNow(), ...(a.pickBox ? { pickBox: { picks: total('boxPicks'), cells: total('boxCells') } } : {}),
		...(CW ? { classes: { runs: CW.runs, found: CW.found, ticks: CW.ticks, best: CW.bestSig, list: [...CW.classes].map(([sig, c]) => ({ sig, ticks: c.ticks, gates: c.gates })) } } : {}),
		cells: a.cells, ...(one ? { allRooms: one.rooms.size, shared: one.shared, fed: one.fed } : {}), ...(bursts ? { gpu: bursts.stats() } : {}), workers: seeds.map((s) => {
			const d = dones.get(s) || stats.get(s) || {};
			return Object.assign({ seed: s, end: d.end || null, ticks: d.ticks || 0, cells: d.cells || 0, first: d.first || null, best: d.best || null, full: !!d.full,
				snaps: d.snaps || 0, dropped: d.dropped || 0, replays: d.replays || 0, impr: d.impr || 0, evicted: d.evicted || 0, sweeps: d.sweeps || 0, nodes: d.nodes || 0,
				memMB: d.memMB || 0, heapMB: d.heapMB || 0, seeded: d.seeded || 0, seedCells: d.seedCells || 0, picks: d.picks || 0, lbCut: d.lbCut || 0, leadPicks: d.leadPicks || 0,
				leadRoutes: d.leadRoutes || 0, leadShare: d.leadShare || 0, wayPicks: d.wayPicks || 0, wayShare: d.wayShare || 0 },
			a.cells === 'coarse' ? { rooms: d.rooms || 0, bursts: d.bursts || 0, walks: d.walks || 0, walkHits: d.hits || 0, walkMs: d.walkMs || 0, imports: d.imports || 0, importAdded: d.importAdded || 0, spdFlags: d.spdFlags || 0, spdPeak: d.spdPeak || 0,
				roomDead: !!d.roomDead, deadCut: d.deadCut || 0, groups: d.groups || 0, dominated: d.dominated || 0, maximal: d.maximal || 0, picksDom: d.picksDom || 0, dDom: d.dDom || 0 } : {});
		}) });
	console.log(`[goexplore] ${a.workers} worker${a.workers > 1 ? 's' : ''} (seed ${a.seed}${a.workers > 1 ? `..${a.seed + a.workers - 1}` : ''}), ${a.cells} cells, ${secs.toFixed(1)} s, ` +
		`${(tk / 1e6).toFixed(2)} M ticks, ${total('cells').toLocaleString('en-US')} cells${a.cells === 'coarse' ? ` in ${Math.max(0, ...[...stats.values()].map((v) => v.rooms || 0))} rooms` : ''}, end ${end}: ` +
		// (a route given on stdin, "route <inputs>", is no find of this search: first stays null)
		(route ? `${first ? `first route ${first.ticks} ticks after ${first.sec} s (${first.simTicks.toLocaleString('en-US')} ticks of worker ${first.seed})` : 'no route of its own'}; best ${route.ticks} ticks (${C.fmt(route.runTicks)}) after ${route.sec} s${route.adopted ? ' (given)' : ''}` +
			(a.out ? ` -> ${a.out}` : '') : `no route (closest: reach cost ${near ? near.rc.toFixed(2) : '-'} at tick ${near ? near.t : '-'})`) +
		(end === 'unreachable' ? ` (the reach field rules the start out: ${levelFileOf(a) || 'this level'})` : ''));
}

if (!isMainThread && workerData && workerData.goexplore) workerMain();
else if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; });

module.exports = { CellMap, mixW, OPTIONS, QP, QV, FINE_MAX_TILES, parseArgs, settle, cellsFor, defaultMem, machineMemory, processMB, memOfTotal, registryOthers, registryClaim, discreteOf,
	roomOf, counterRelevance, switchReaders, domIndex, maskIn, roomFields, roomUseful, bitAt, CUL_A, roomDead, liveAt, pendingTrigger, inputsOf, rngOf, rollSeed, rollInputs, rollHostMB, lowerBoundTiles, gateContext, routeGates, gateAvoidable, avoidTilesOf, deathsOf, deathMovesFor, DEATH_TICKS, DEATH_TILES };
