# CLAUDE.md: EE Auto TAS, a guide for AI coding assistants

The user started you in this folder, probably while the app is running in their browser. They will say things like
"at 1:10 I think you can skip the second portal". This page tells you what the app does, where everything is, and
exactly how to check an idea and hand an improvement to the running optimizer. The app does not need you: it runs
by itself. You are an optional helper.

## 1. What the app does

EE Auto TAS optimizes a TAS (tool-assisted speedrun, an `.eetas` file of eeo-tas) for an Everybody Edits Offline
level (`.eelvl`). The user imports both in the web app (`START.bat`, http://localhost:47823). The app checks that the
TAS finishes the level in an exact physics port of eeo-tas. It then runs `src/grind.js`, which cycles search tools
over the run until the user stops it. Every improvement is proven by a full replay and saved. The user downloads the
optimized `.eetas` and plays it in eeo-tas (`/loadtas`, `/reset`, `/playtas`).

- Plain Node.js 18+, no dependencies (built-ins only), CommonJS, `'use strict'`. There is no build step. Windows is
  the target (START.bat, taskkill), but the tools run anywhere Node runs.
- Nothing here needs an AI, a GPU, Godot or Python.

## 2. Ground rules

- **Never write `src/jobs/<id>/best.eetas` yourself.** Hand runs in with `node src/tas.js try <job> <file>`. It
  verifies the run with the same rule as the optimizer and writes files atomically. If the job is running, the file
  goes through the job's inbox and the grind decides within about 3 seconds.
- Do not kill processes you did not start. The grind belongs to the user's app. Stop it only if they ask
  (`tas.js stop <job>` or the Pause button).
- `src/eesim.js` (physics) and `src/eelvl.js` (level reader) are bit-exact ports of eeo-tas (AS3 source). Do not
  change them unless the user asks. If you do, follow the AS3 exactly (docs/eeo_spec has file:line references) and
  run `node test/regress.js --quick`. These two files use 2-space indentation. Every other `src/*.js` file uses tabs.
- Put scratch scripts and files in `src/out/` (gitignored). Each job has a `probes/` folder for candidate runs.
- `.eetas` files are **raw bytes**. Read them with `C.readEetas(file)` and write them with `C.writeEetas(file, masks)`
  (`src/common.js`). Never read one as text: eeo-tas plays every byte as a tick, line breaks included.

## 3. Recipe: "at 1:10 I think X is possible"

Times the user gives are **in-game run times** (the timer eeo-tas shows). Every command accepts `m:ss.cc`
(`1:10` = `1:10.00`), `70.5s`, or a plain number, which is a **tick** (an index into the `.eetas`).

1. **Find the job.** `node src/tas.js jobs`. You can refer to a job by its id, a unique prefix, or part of its name.
   `node src/tas.js status <job>` shows whether it is running, the live speed, the best time, the stage, recent
   improvements and the log.
2. **Look at that moment.** `node src/tas.js where <job> 1:10`. It shows the tick, position (tiles), velocity
   (px/tick), whether the ball is on the ground, gravity direction, the tiles at the centre, below and ahead, coins,
   keys and switches, the active effects (levitation and its thrust, multijump, jump / speed / gravity effects, low
   gravity, protection, curse / zombie / fire / poison with the ticks until they kill, team, god mode), the inputs of
   the last 30 and next 100 ticks (`R+J x3, R x20, - x5`), the next events
   (portals, coins, jumps, landings) and an ASCII map (`@` ball, `+` path in the next 3 s, `-` path in the last 1 s).
3. **See it.** `node src/tas.js render <job> 1:08 1:14`. It prints the PNG path. **Read the PNG** (it is an image).
   Tiles are colored by kind: solid grey, arrows and dots blue, portals purple rings (a white dot means a random
   exit), coins yellow or blue (hollow if already taken), doors hatched, one-ways drawn as a bar on their solid side.
   The path runs cyan to yellow to red over time, with run-time labels. The green box is the ball at the start of
   the range and the red box is the ball at the end. The rest of the run is a thin grey line. Tile coordinates are
   printed on the top and left edges. For a wide area pass `--scale=4`; for a close-up pass a short range or
   `--margin=3`.
4. **Form a hypothesis** in terms of inputs. For example: "jump 6 ticks earlier at 1:10.40 and hold R. The ball clears
   the wall at tile (330, 150) and lands on the ledge the run reaches at 1:11.20". Section 5 has the physics.
5. **Test it exactly.**
   - One idea: `node src/tas.js probe <job> 1:10.40 "R+J x6, R x40"`. It plays those inputs from the best run's
     *exact* state at 1:10.40. It then looks for an **exact rejoin**: a state identical (`stateHash`) to one the best
     run reaches later. It tries the inputs themselves and then the best run's own inputs continued from nearby
     offsets. A rejoin is proof. The saving is the tick difference. It writes a verified candidate `.eetas` and
     prints how to hand it in (or pass `--try`). If nothing rejoins, it prints the closest reference state
     (tick and distance). Use it to adjust the timing.
   - Many variants: copy `src/examples/idea_template.js` to `src/out/` and edit it. It tries thousands of small input changes around a moment with
     `J.probe` and a shared `J.probeContext` (about 1 ms each) and writes the best one.
   - Let the machine search: `node src/tas.js focus <job> 1:08 1:14 120`. This runs the route explorer
     (`explore.js --exact=1`), the dense shortcut search (`shortcuts.js`) and input mutations (`mutate.js`) on just
     that window, splices the results, and hands every faster run to the job. If the job is running, focus uses half
     the CPU threads. It takes about 3 x seconds plus a little extra. From the web app, the "Ideas" box does the same.
   - The ending: `node src/tas.js endgame <job> [K] [--seconds=60]` tries EVERY input sequence from K ticks before the
     finish toward the trophy (exact; no rejoin needed, the trophy cell is the goal) and hands a faster finish in. When
     it finds nothing it prints "proof": no input sequence from that state finishes sooner (without dying).
6. **Hand it in.** `node src/tas.js try <job> <candidate.eetas>`. It prints the verdict. Running job: the grind's
   verdict arrives within seconds (`--wait=60` by default). Stopped job: decided at once and `best.eetas` is updated.
   A run that finishes but is not better stays in `pieces/`; a running grind splices it with the best at once (its
   faster stretches are kept), a stopped job's grind when it starts, and again at the end of every round, so a partial
   improvement still helps.
7. **Tell the user** the new time, the ticks saved (1 tick = 0.01 s) and, if random portals are involved, the odds
   (section 4). The web app shows a notification for each improvement. To let them see it, give them the viewer
   link `http://localhost:47823/#watch=<job id>&t=1:10.00`: it plays the current best run from that moment with
   their original `.eetas` as a ghost (a "Newer version found" button appears in an open viewer when your run lands).

If an idea fails, `render` the probe's candidate (`--file=<candidate.eetas>`), or run `where <job> <t> --file=...` on it
to see where it goes wrong. Coins that are only collected on the way (no coin door or gate on the route) are optional:
`status` says "coins optional", and the searches may then skip them.

## 4. Key ideas

- **Exact physics port.** `EESim` (src/eesim.js) reproduces eeo-tas bit for bit: Player.as, World.as, PlayState.as,
  every float operation in the same order. `sim.stateKey()` / `sim.stateHash()` are equal only for states that behave
  identically from then on (absolute clocks are left out).
- **Exact rejoins = proven shortcuts.** If a searched state at tick t equals the best run's state at a later tick j,
  then the best run's inputs from j replay identically from there. `best[0..i) + found inputs + best[j..]` finishes
  exactly j - t ticks sooner. No approximation is involved, so no fake improvements. Every tool works this way
  (mutate, shortcuts, explore `--exact`, splice, probe), and every result is verified by a full replay anyway.
- **The acceptance rule** (`common.judge`, used by grind, try and the inbox): the run must finish the level, die no
  more often than the starting run, and be faster with no lower random-portal chance, or equally fast and more
  likely to work.
- **The grind cycle** (src/grind.js): rounds of about 10 minutes (`--roundMin`): mutate loop, the exact endgame
  solver (`endgame.js`, once per ending: again when the best's last 64 ticks change; `--endgame=0` off), deep exact-rejoin
  exploring windows (every other one with `explore --hunt=1`, guided skip hunting; `--hunt=0` off; first up to 3 loop windows: stretches where the run comes back to where it was with nothing
  collected in between (`src/loops.js`), the longest first, each once; then every coin-to-coin segment in windows; window after window from a cursor, for ~55% of the
  round), mutate, a slice of the dense shortcuts pass (from its own cursor), the time-door pass (`phase.js`, on levels with
  time doors, or coin doors when the coins count), mutate, a beam search every other round
  when there is time (every 4th anyway; one stopped by a restart is not repeated), then a splice of all results plus
  `pieces/`. Settings rotate with the round. After every stage the grind saves where it is in `status.json` `cursor`
  (round, stage, the deep and shortcuts cursors as tick + state hash, the seed counter), so a restart continues there.
  Without the GPU, mutate searches only the start ticks whose next ~800 ticks changed since its last full pass
  (`grind_mutref.eetas`). A finishing run that is not accepted (a stage output that went stale, an inbox run) is
  logged and spliced with the best at once (splice.js in-process, well under a second); stage outputs stay in the
  round's splice while they still have states the best lacks. While a stage runs, the grind checks `inbox/` every 3 s
  and writes a status heartbeat every 30 s.
  Each stage works on its own copy of the best run (`grind_ref.eetas`). The CPU tools' newer options are passed behind
  `--anchored=1` (mutate `--anchor --dprune --fixpoint`) and `--tails=1` (explore `--tails`), both on by default.
- **Random portals.** A portal whose target id belongs to several portals picks its exit with `Math.random` in EEO.
  That draw is unseeded and not reproducible. At import, `rng.js` replays the TAS under every combination of exits.
  The level JSON gets an `rng_script`, the fastest finishing combination, which every simulation uses. **chance** is
  the probability that the run finishes in a real EEO replay, for example 50% for one 2-exit portal where only one
  exit works. The user may need to replay a few times. The optimizer never lowers the chance.
- **Coin-blind search** (`--nocoins=1`): when coins only matter as pickups, states that differ only in collected
  coins count as equal. This finds more rejoins and allows skipping coins.
- **Start mode.** How the user started the TAS in eeo-tas decides the start state (eesim.js `EESim.reset()`):
  `reset` (default, the eeo-tas README workflow: load, `/reset`, `/playtas`; `/reset` moves to spawn index 1 % n and
  restores 110/111 coins) or `load` (`/playtas` right after loading: spawn 0). It is chosen at import (page, API
  `startMode`, `tas.js import --start=load`), kept in `meta.json` (`startMode`, `startMatters`) and written into the
  level JSON as `start_mode`, so every tool and `J.loadJobLevel` simulate from it without extra options. It only
  matters with 2+ spawn points, time doors or collected coins stored in the file (`meta.startMatters`, from
  `viewer.startMatters(level)`); the page shows it in the job header only then.
- **GPU mode** (README "CPU or GPU?"): `native/eecore.h` is a second copy of the physics in C++ (the same double
  operations in the same order as eesim.js; hot-path comparisons / truncations / int<->double conversions go through
  exact integer helpers, valid because the engine never meets a NaN: `gpu.unsupported()` refuses levels whose gravity
  multiplier is not finite). One source compiles natively (zig c++) and for NVIDIA GPUs (NVRTC, `--fmad=false`):
  `native/build/eegpu.exe` + `eegpu_{8,32,128,512}.ptx` (`node tools/build-native.js`; the number = the state's
  variable-tail capacity in words). `eegpu search` runs the exact-rejoin search of `native/search.h` (families m1,
  del, m2 = mutate's; pert, flip, sticky = random perturbations of the reference) and re-checks every hit on the CPU
  with two independent hashes; `src/gpusearch.js` (started by grind `--gpu=1`) keeps an edge library keyed by state
  hashes (saved in `gpu/library.bin`), splits each round into eegpu invocations with their own cursors (m1 + del up
  to 30% until a full pass over the current best is done, m2 up to 20%, one random family in turn for the rest),
  combines the library with the union of every known run (`splice.js unionGraph`: the best, best_*.eetas, pieces/,
  stage outputs, the best runs of other jobs of the same level), `C.evaluate` + `C.judge`, hands faster runs in
  through `J.tryCandidate` and searches from them at once; it writes `gpu_status.json`. **Any change to eesim.js physics must be mirrored in eecore.h** and
  `node test/gpu.js` (CPU build) and `node test/gpu.js --gpu` must pass: they compare stateHash after every tick.
  `src/bench.js` measures the CPU the app runs on once (`src/data/_system.json`, `GET /api/system`); `gpu.runBench`
  measures the GPU on the same arena (`data/_gpu.json`); the
  thread list and the Processor note name the detected CPU and show its measured ticks/s per thread count (on many
  laptops more threads is not faster; the thread list shows the measured speed for the user's CPU). The app is shared:
  texts name the detected hardware (`common.cpuName`, `bench.describe`), never "this PC".
- **Live speed.** `EESim.tick()` counts ticks per thread (`E.setTickCounter` / `E.flushTicks`, one shared counter per
  tool: `common.tickMeter`); mutate, shortcuts, explore and optimize print `[ticks] <total>` every second. The grind
  sums them over its session and writes `live.json` every second (`summary().live`, the page's "Speed now",
  `tas.js status`); a fresh `gpu_status.json` is copied in as `live.gpu`.

## 5. Physics cheat sheet (eeo-tas; details and AS3 references in docs/eeo_spec)

- 1 tick = 10 ms = 1 byte of `.eetas` = 0.01 s of run time. A tile is 16 px. The position `(px, py)` is the
  top-left corner of the 16x16 hit box. The centre tile is `((px+8)>>4, (py+8)>>4)`. y points down.
- Inputs per tick (mask bits): 1 jump, 2 left, 4 right, 8 up, 16 down. The byte is `48 + mask` ('0'..'O').
  Left+right or up+down cancel. In replay, **every tick with the jump bit is a fresh press**.
- Speeds in the sim (`speed_x`, `speed_y`) are px/tick. The AS3 "public" speeds are these x 7.752 (Config
  `physics_variable_multiplyer`). The arithmetic goes through that factor exactly.
- Gravity: +2/7.752 = 0.258 px/tick per tick. Then drag x0.98132 (base drag) every tick. Falling tops out near
  13.55 px/tick. Speeds are capped at 16.
- Running: holding a direction adds 1/7.752 = 0.129 px/tick per tick with base drag only. Speed is 2.13 after
  20 ticks, 4.59 after 60 and 5.75 after 100, and tends to 6.78 px/tick. With no input (or the opposite one) the
  extra "no modifier" drag applies: x0.8876 per tick in total, so the ball stops fast. Momentum is precious.
- Jump: `speed = -26 x 2 / 7.752 = -6.708 px/tick` against gravity (x1.3 with the jump effect). It needs gravity on
  that axis from both the current and the delayed tile (no jumps in dots, liquids, on climbables or boosts), and
  `jumpCount < maxJumps`. `jumpCount` resets on a tick where the ball hit the floor with speed 0 on that axis. A
  1-tick jump rises for 22 ticks and about 63 px (4 tiles).
- **The gravity queue** (Player.as:406-447): each tick reads two tiles. `current` is the tile under the box centre
  now. It sets int `morx/mory` (can you jump, what counts as floor) and kills (spikes, fire, toxic). `delayed` is the
  `current` of **2 ticks ago**. It sets the acceleration `mox/moy`. Dots (4, 414) and climbables shorten the delay to
  1 tick. So entering an arrow or dot field changes acceleration 2 ticks later, and leaving it keeps the old force for
  2 ticks.
- Which inputs act: under vertical gravity up/down do nothing, and under horizontal gravity left/right do nothing.
  Liquids and zero-gravity tiles (dots, climbables, boosts) allow both axes.
- Blocks: arrows 1/2/3/1518 (and invisible 411/412/413/1519) set gravity left/up/right/down. Dots 4/414 cancel
  gravity (4-way control, drag). Boosts 114-117 set speed to 16 px/tick. One-ways block from one side, set by their
  rotation. Half blocks are half-tile solids. Keys, switches and coins open or close doors and gates.
  Spikes, fire and toxic kill, and the respawn comes 54 ticks later.
- Portals: the teleport happens at the start of the movement loop, at most once per tick. The velocity is rotated by
  the rotation difference and multiplied by 1.42 when rotated. Standing on an exit portal does not teleport again.
- Run timer: it starts at the end of the first tick with any input. The finishing tick is not counted.
  `run_ticks = finishTick - timerStart` (the same as eeo-tas `Me.ticks`). `where` prints `timerStart`.
- Sub-steps: movement advances in 1 px steps with a collision test each step. Wall hits zero the speed. Exact
  rejoins happen often after wall hits, landings and portals, because those reset the state.
- Specs: `docs/eeo_spec/movement.md` (Player.tick step by step, collisions, portals, jumps),
  `tick_loop.md` (tick order, TAS input bytes, run timer, randomness), `state.md` (keys, switches, doors, coins,
  death, checkpoints), `blocks.md` / `blocks.json` (every block id), `eelvl_format.md` (level files),
  `level_survey.md` (what the sample levels use). `docs/ENGINE_NOTES.md` covers the engine API and its known gaps.

## 6. Files

| file | what |
|---|---|
| `START.bat` | double-click launcher (checks for Node, runs `node src/server.js --open`) |
| `tools/build-exe.js`, `tools/exe/` | `npm run build:exe` -> `dist/EEAutoTAS.exe` (a Node single executable application: `launcher.js` unpacks the app to `%LOCALAPPDATA%\EEAutoTAS\app\<version>` and sets `EEAT_HOME` = `%LOCALAPPDATA%\EEAutoTAS` for jobs and data; `EEAutoTAS.exe tas ...` = the CLI, `EEAutoTAS.exe script.js` = run a script). Child tools get their heap size through `NODE_OPTIONS` (`C.heapEnv`), because the exe does not read Node flags from its command line. |
| `src/server.js` | web app + JSON API on 127.0.0.1:47823 (`--port=`, `--open`); resumes the last running job |
| `src/app/index.html` | the page (single file, no build) |
| `src/tas.js` | the CLI (`node src/tas.js help`) |
| `src/jobs.js` | job model shared by server and CLI: import, start/stop, summary, try, where, replay, render, probe, focus |
| `src/common.js` | `.eetas` bytes I/O, atomic writes, time parsing, level lookup, `replay()`, `evaluate()`, `judge()` |
| `src/render.js` | PNG renderer (canvas, 5x7 font, PNG encoder on zlib) |
| `src/viewer.js` | data for the page's run viewer: `trajectory()` (per-tick positions, timer, inputs, flags, events, door states in the job's exact engine), `align()` (DTW: the original's tick at the same point, per best tick), `levelView()`, `startMatters()` |
| `src/minimap.js`, `src/minimapcolors.json` | EE's own minimap color per block id (eeo-tas ItemManager.as `createBrick(..., minimapColor)`, -1 = the average of the block image); regenerate with `node src/minimap.js build [eeo-tas dir]` |
| `native/eecore.h`, `native/search.h`, `native/kernels.cu`, `native/eegpu.cpp`, `native/cudadrv.h` | the native engine (the physics of eesim.js in C++, bit for bit), the GPU search's candidate families, the CUDA kernels (trace, search, bench), the host tool (`eegpu trace|state|info|ptx|search|bench`), the NVIDIA driver / NVRTC loader |
| `src/gpu.js` | `levelBlob()` (prepared level -> the native tool's binary), `nativeTool()`, `unsupported(level)`, the GPU benchmark (`data/_gpu.json`) |
| `src/gpusearch.js` | the GPU searcher of a running job (grind `--gpu=1`): rounds of `eegpu search` split into invocations per family share (`--round=30`, `--sysShare=0.3` m1+del until one full pass over the current best, `--m2Share=0.2` m2, the rest one of pert / flip / sticky in turn; windows from cursors kept in `gpu/state.json` with the seed counter and per-family numbers), the edge library (`gpu/library.bin`, fingerprinted by eesim.js, the level blob and the coin mode), the union combine (`--union=40` most recent runs, `--siblings=1` other jobs of the same level; a library edge that does not replay is dropped; when the union's fastest combination is refused, the best alone with the library), verify, inbox; it searches its own judged run at once (until the grind refuses it); `gpu_status.json` (with `families`), `[gpu ...]` lines in grind.log (one line per round with every invocation's window, time, ticks and new shortcuts). `--tool=<file.js>` runs a stand-in for eegpu (tests without a GPU). `--every=1` (opt-in) adds "every move" rounds: `eegpu explore --rejoin=1` windows along the run (exact cells; every state equal to a later run state is a proven shortcut, re-checked with both hashes). Off by default: on full-size levels the exact windows explode (20-40 s per 40-60 ticks on a laptop GPU) and the search families find more per second |
| `tools/build-native.js`, `test/gpu.js` | build the native engine; the exactness proof (per-tick stateHash vs eesim.js; `--gpu` runs it on the GPU) |
| `src/eegfx.js` | EE graphics for the viewer, read at run time from the user's eeo-tas folder (`settings.json` `eegfxDir`, else `$EEO_TAS`, else `~/eeo-tas`): parses ItemManager.as / ItemId.as into a sprite map (block id -> sheet, 16 px frame, y, ItemLayer, shadow; the BlockSprites; morphable blocks; NPCs, smiley, death animation), cached in `<data>/eegfx.json`. **Never commit EE images or derived sprite data**: the page loads the PNGs from eeo-tas through the server. The page's `gx*` functions follow World.as's draw rules. `node src/eegfx.js [dir]`, `node src/eegfx.js coverage <level.eelvl>...` |
| `src/editor.js`, `src/app/editor.html`, `test/editor.js` | the level editor (`/editor`): the editor's level JSON <-> `.eelvl` (`eelvl.js writeEelvl` / `readEelvl`), block info, checks (start, trophy, open way incl. portals), the route search: `eegpu explore - --finish=1` ("every move": exhaustive, one state per cell, the first finish = the fastest at its cell grain; a pass ladder (`passCells`, `passSeconds`, `nextPass`): it starts coarse (pass -1; coarse passes coarsen positions only, speeds stay at pass 0's 1/16 px/tick), a pass gets a share of the time (max(20 s, left / 3)) while a coarser pass is untried, goes coarser after a full table or a used-up share, finer after it ran out of states or found a route; with a route of T ticks every pass runs `--depth=T-1` (only faster routes) until the time is up; the "ran out of situations" verdict only from pass 0 or finer with `"overflow":0` in explore's `done` event, and it is evidence, not proof; salts: merged cells lose pixel-exact routes depending on which state stands for a cell, so with no next pass and time left the pass that ran through its depth runs again with the next `--salt` (another merged graph), the finest pass looping salts in one process (`--salts`, `{"ev":"try"}` events); once every move ran out of situations at a fine grain with nothing cut and no route, the GPU beams stop so the tries get the GPU; the 40x25 shaft level's 251-tick run-up route comes from salt 8) next to `eegpu beam --goal=1` (with a guide line also a second beam `--guide --guideWeight=4 --goalWeight=4`; the beam's selection runs on the GPU: dedupe, score histogram, picks in score order with a per-bucket cap) and the CPU strategy `src/goexplore.js` (`cpu: true`; N - 1 worker threads, capped by the benchmark's fastest thread count and by half the threads while a job's optimizer runs; its depth limit is not cut by the beams' width; its routes bound the explore's next pass like any route, faster routes found elsewhere reach it on stdin as `depth D`; halted once every GPU strategy has ended with a route known, unless one of them failed); without an NVIDIA GPU / the native engine / a level eegpu supports, `start()` runs the CPU strategy alone (`S.cpuOnly` = the note), every route replayed in the JS engine; state in `<data>/editor/` (`solve.json`, `level.eelvl`, `route.eetas`). The page copies the viewer's `gx*` drawing functions. `node test/editor.js [--gpu]` |
| `src/goexplore.js` | the CPU route search of Find a route (Go-Explore): an archive with one cell per (tile, on ground, sign of vx, vy class, jump count, gravity queue, discrete state: coins and which, keys, switches, effects, checkpoint, gates, portal draws), each keeping its earliest state; a heap picks the lowest reach cost + 2 sqrt(picks); 8 random runs of 40 ticks per pick (an input kept with p 0.85); finer cells (4 levels, down to 1/16 px and 1/128 px/tick) in the 3 x 3 tiles around a cell picked a 6th time when the lowest reach cost has not improved for 200 picks; states the reach field rules out end a run. Snapshots only for picked cells, within a budget (`--mem`; evicted ones are rebuilt by replaying from the parent or the start). Worker threads with seeds `--seed`, `--seed + 1`, ...; one worker with a tick budget (`--maxTicks`) is exactly reproducible. Prints the editor's JSON events (`start`, `progress`, `closest`, `result` kind `finish` after `C.evaluate`, `done`); `--first=1`, `--depth=`, `--out=`, `--stdin=1` (`depth D`, `stop`; the end of stdin stops it too) |
| `src/reach.js`, `test/reach.js` | the reach field (v3) of Find a route: a physics-aware cost to the trophy in fifths of a tile per abstract state (tile, type, level): R rising (the centre's apex in half rows above the tile's top edge: q -1 = lower half only, 0 = upper half, >= 1 = into the row above), F falling (the fall potential: the free-fall distance whose speed the ball has, plus the px to the tile's bottom edge, in rows), L falling in the lower half (no jump: it is never at standing height), C rising in a field (dots / side arrows, climbables, water, mud / lava, up arrows: the upward speed at the row's top edge with the push left in the row, 1/8 px/tick), XR left a field sideways in this row (no pumping). The physics is one forward move function (`fwd`) plus same-tile edges (the jump, the apex, a field's stop / bounce / turn, boosts) and portals / death respawns; a backward label-setting search in cost buckets inverts it per pair of tile profiles. Every table is the engine's own arithmetic (rises from a speed and gravity queue, the free-fall orbit, the jump 63.42 px; fields' pushes and top speeds checked against the engine), and every rule errs toward reachable: -1 (cut off) is a proof: the explore prunes those states (`--prune=1`, after its finish test) and the editor calls a cut-off start impossible. The lookup (`fifthsAt`, the same doubles as native/beam.h `reachFifths`) uses the gravity queue, the ceiling and slipperiness; a rising ball in a row next to fields is both R and XR (the higher cost: each alone is a valid description). Levels with jump / fly / speed / low-gravity / multijump / gravity effects or another world gravity: walking distance (walk mode, never a proof). `reachField(level, {check, explain, goals, maxCost})` (Bellman self-check; the highest row the start reaches; explore.js --hunt's time-to-go field), `costAt(field, sim)` (tiles), `writeReachFile` (RCH3 for eegpu `--reach=`; `eegpu info` says `"reach":3`, an older tool is refused with "the search tool is older than the app: rebuild it"), `shareField`. The editor builds it in a worker thread, cached in `<data>/editor/reach_<level hash>_v3.bin`/`.json`. `node test/reach.js [--only=A..G] [--gpu] [--tool=] [--jobs=]`: A the tables against the engine, B rooms with engine answers (ledges, dot steps, strip-k, up-pump, the user's 50x50 shaft level ranked), C every state of every job's runs and the known editor routes reachable, D a step fuzz (cut off at t implies cut off at t + 1), E the self-check and the goals options, F the JS lookup = `eegpu reachtest` (host; `--gpu` the GPU too; a host build with `-DRF_CHECK` checks every table index), G build times (200x200: 300 ms target) |
| `src/bench.js` | CPU benchmark of the engine (1, half and all threads, warmed-up workers), cached in `src/data/_system.json` per CPU / Node / engine size |
| `src/blocks.js`, `src/blocknames.json` | block names and kinds for display (from docs/eeo_spec/blocks.json) |
| `src/eesim.js` | the exact physics port (EESim, EEInput, applyMask, parseEetasBytes, loadLevel, prepareLevel) |
| `src/eelvl.js` | EEO-exact `.eelvl` reader, `toSimLevel()` = the level JSON; `writeEelvl()` (header + records, raw deflate; args checked against `argKind`) |
| `src/rng.js` | random-portal outcome tree: chance, best outcome script, per-portal odds |
| `src/grind.js` | the optimizer loop for one job (`--job=src/jobs/<id>`; `--roundMin=10`, `--deepS=<s>` per deep window, `--anchored=1`, `--tails=1`, `--siblings` passed to gpusearch); resumes from `status.json` `cursor` |
| `src/mutate.js` | input mutations at every tick, exact rejoins, DP (seconds) |
| `src/shortcuts.js` | local beams from every `--step`-th tick, exact rejoins, DP |
| `src/loops.js` | the run's loops: stretches (a -> b) where the ball comes back within 48 px with nothing collected or toggled in between, longest first (`revisits(level, masks, {coins})`; `node src/loops.js <job> [run.eetas]`); the grind explores these windows first (OC's Octorage: loop #1 = the -356 route skip, found in 2 minutes) |
| `src/phase.js` | time-door and coin-door shortcuts: every state hash holds the doors' phase (ticks % 1000), so exact rejoins miss them; single input changes, proposals by `stateHashClockBlind` (coin-blind past the last coin door), each replayed plain or with the clock re-synced by idle ticks before the first input (free: the timer starts at the first input), combined by weighted interval scheduling, judged |
| `src/explore.js`, `test/explore.js` | Go-Explore route explorer for a window (`--from --join --until --exact=1`); `--tails=1` keeps every exact rejoin as an edge (DP, `<out>.edges.json`); `--hunt=1` (off by default) is guided skip hunting with the same edges: a time-to-go field of the reference per context (reach.js `goals`, built before the search: 2-3 s of CPU per context on a 200x200-400x200 level, shared by the workers), one archive cell per (tile, ground, vx sign, vy class, jumps, context), picks half by most lead and half by novelty, tails from cells ahead of the reference (it finds local skips `--tails` misses and misses long detours a wide `--tails` window finds: a complement; numbers in the header); `--ticks=N` = an equal tick budget per worker. `node test/explore.js`: `--hunt` and `--tails` on a hand-made room (exact edges, a judged run, deterministic) |
| `src/optimize.js` | beam search along the reference with verified leads |
| `src/splice.js` | best combination of several runs at equal states: the shortest path over the union of their state graphs (Dijkstra, bucket queue, typed-array hash index; ~0.3 s for 30 Infinity Pain runs); also a module: `trace`, `traceCache`, `unionGraph(runs).path({lib, avoidRng})`, `firstBadCheck` (used by grind.js and gpusearch.js) |
| `src/endgame.js`, `test/endgame.js` | the exact endgame solver: from S(F - K) of a run (F = its finish tick) every input sequence, tick by tick (the 18 masks; masks whose left/right or up/down bits provably do nothing are simulated once), states merged globally by stateHash (an earlier copy dominates), deaths dropped, a state at depth d cut when d + h + 1 > the budget; h = `lowerBound()`, ticks until the centre can be in a trophy cell, never an overestimate: the speed limit (16.25 px per axis per tick) with a portal field, a kinematic envelope while the touched tiles have an empty tile's physics (per axis the extreme input, a collision may stop the ball any tick, one jump per landing via `riseTable`, portals as j + Q(p)), else a general per-axis envelope (speed + the largest pull / input / thrust per tick, jumps only where a touched tile has `mor` on the axis; boosts end it). The first finish is the fastest from that start (checked with `C.evaluate` + `C.judge`); running out of states = a proof. `ladder()`: K = 8, 16, 24, .. from many starts (the run, best_*.eetas, original, pieces/), smallest K first, midpoints after a give-up (`--cap` open states, default 300000, ~1.2 KB each); a find becomes the reference and a start. `node src/endgame.js --tas=<run> [--level=] [--K=<max> \| --K=a,b] [--seconds=60] [--out=]` (JSON lines), `tas.js endgame <job> [K]` (hands the faster run in), `endgameJob(id, opts)`. A search in which the acceptance rule refused a faster finish (a lower random-portal chance) is reported with `rejected`, not as a proof. `node test/endgame.js [--only=bound\|exhaust\|masks\|ladder\|jobs]`: the bound against real walks to synthetic goals in rooms with every block kind (also 150-tick climbing walks, boost lanes, portal networks), the search with and without cuts, the mask merging, the ladder's mechanics, the bound along the jobs' runs and 213's 2.35 |
| `src/run.js` | quick replay: finish tick, run time, coins |
| `src/examples/idea_template.js` | a script that tries thousands of input variants around a moment exactly; copy it and edit |
| `tools/rediscover.js` | the rediscovery benchmark: finds replayed from a run before the find by the tool meant to aim at them (Octorage loop skip, 213 endgame, Stupid Fox time doors, FV skip hunting), with the reason the spot is targeted, the time and ticks; `--only=`, `--json` (skips cases whose jobs are not on the machine) |
| `test/regress.js` | engine regression tests (maintained together with the physics) |
| `test/mechanics.js` | block mechanics against the AS3 (effects, levitation, teams, zombie doors, lookup table) |
| `test/review.js` | the review suite: music blocks without a sound (tick abort), the AS3 portal lookup, stateKey decoding, snapshot / stateKey fuzz on kitchen-sink levels, the two real eeo-tas runs, and the app (import limits, report, where, HTTP errors, viewer data, EE graphics on a fake eeo-tas, inbox verdict) in a temp copy of src/ (`--quick`, `--only=`) |

The tools take `--tas=<file>` and `--level=<level id | job id>`. For a `.eetas` inside `src/jobs/<id>/`, `--level` can
be left out. Each tool's header comment lists its options.

## 7. Jobs on disk

`src/jobs/<id>/` (the id is `<name-slug>-<6 hex>`), plus the level at `src/data/job_<id with _>.json`:

| file | what |
|---|---|
| `meta.json` | name, level info, the original TAS (ticks, finish tick, run ticks, coins, deaths), import-time portal odds, `levelId`, `startMode` (`reset` / `load`), `startMatters`, `spawns`, `timeDoors` |
| `status.json` | written by grind (and by `try` when stopped): `state`, `pid`, `stage`, `rounds` (finished rounds), `cursor` {round, stage, used, deep, sc ({t, h}: tick + state hash), scRate, seed} (where a restart continues), `bestRunTicks`, `chance`, `coinsOptional`, `history` [{t, runTicks, saved, what, chance}], `updated` (heartbeat) |
| `best.eetas` | **the current best run** (bytes '0'..'O', cut at the finish); `best_<runTicks>.eetas` = every improvement |
| `original.eetas`, `original.eelvl` | the uploaded files, byte for byte |
| `grind.log` | the optimizer's log (`[grind ...]`, `[try ...]` lines); `console.log` = the grind's raw stdout |
| `inbox/` | candidates for a running grind: `<stamp>_<source>.eetas` + `.json` {source}; verdicts in `inbox/results.jsonl` |
| `pieces/` | finishing runs from outside that were not better; spliced in every round (newest 30 kept; the GPU searcher's in `pieces/gpu/`, newest 10) |
| `focus.json`, `focus.log`, `focus/<stamp>/` | the last focus search: state, range, results; its log; its files |
| `probes/`, `renders/` | candidates written by `probe`, PNGs written by `render` |
| `report.json` | the final report from "Finish run" (time saved, odds, per-portal odds) |
| `grind_*.eetas`, `grind_*.log` | stage outputs and logs of the current grind (`grind_ref.eetas` = the stage's copy of best, `grind_mutref.eetas` = the run mutate's last full pass covered, `grind_now.eetas` = the last at-once splice) |
| `gpu/` | the GPU searcher's files: `library.bin` (the shortcut library), `state.json` (cursors, seed counter, per-family numbers), `level.bin`, `ref.eetas`, `edges.bin` |
| `live.json` | written by grind every second: `{t, cpu: {ticks, ticksPerSec, threads, model}, gpu}` (`ticks` = simulated this session, `ticksPerSec` over the last ~3 s, 0 between stages; `gpu` = `gpu_status.json` {t, name, ticks, ticksPerSec, state, edges} while it is under 5 s old, else null) |

`src/jobs/_running.json` records the job to resume when the app starts. The level JSON is eelvl.js `toSimLevel()`
output plus `rng_script` (section 4) and `start_mode` (section 4, "Start mode"). `src/data/_system.json` is the CPU
benchmark.

## 8. CLI (`node src/tas.js help`)

`jobs` | `status <job>` | `where <job> <t>` | `render <job> [from] [to] [out.png]` | `replay <job|file> [--level=<job>]` |
`probe <job> <t> "<inputs>" [--try]` | `try <job> <file.eetas>` | `focus <job> <from> <to> [seconds]` |
`endgame <job> [K] [--seconds=60] [--cap=]` |
`import <level.eelvl> <run.eetas> [--name=] [--start=reset|load]` | `start <job> [--workers=N]` | `stop <job>` |
`finish <job>`. (`node src/bench.js [--threads=N]` measures the engine speed.)
Options: `--json` (machine-readable output), `--file=<run.eetas>` (where, render and replay on another run),
`--wait=<s>`, `--source=<text>`, `--workers=N`, `--scale=`, `--margin=`.

## 9. HTTP API (the web app's server; `GET /api` lists it)

| method | path | what |
|---|---|---|
| GET | `/api/state` | all job summaries (incl. `bestVersion`, changes with every new best, and `live`: the running job's `live.json` while under 5 s old, else null), CPU threads, `cpuModel`, `bench` |
| GET | `/api/system` | processors: CPU (`model`, `text` e.g. "Intel Core i7-11800H (16 threads): 7.3 M ticks/s per thread, fastest with 8 threads (measured)") with the measured ticks/s (1 thread, all threads, `estimate[n-1]` per thread count, `peakThreads`); GPU (`available`, `model`, measured `ticksPerSec`, or `why`); `faster`: `cpu` or `gpu` |
| POST | `/api/jobs` | import: JSON `{name, eelvlName, eetasName, eelvlB64, eetasB64, startMode}` (base64 of the raw file bytes; `startMode` `reset` (default) or `load`) |
| GET | `/api/jobs/:id` | one job summary (best, history, stage, `live` speed, inbox, focus, files) |
| POST | `/api/jobs/:id/start` | JSON `{workers, processor}` (`processor` `cpu`, or `gpu` = the CPU stages plus the GPU searcher; refused with the reason when no GPU or the level is unsupported) |
| POST | `/api/jobs/:id/stop` | pause |
| POST | `/api/jobs/:id/finish` | stop and write `report.json` (returned) |
| DELETE | `/api/jobs/:id` | delete the job and its files |
| GET | `/api/jobs/:id/best.eetas`, `/original.eetas` | downloads |
| GET | `/api/jobs/:id/log` | last 300 lines of grind.log |
| GET | `/api/jobs/:id/where?t=1:10.00` | state at a time or tick (JSON; `&format=text` = the CLI text) |
| GET | `/api/jobs/:id/render.png?from=1:08&to=1:14` | PNG (`&scale=`, `&margin=`) |
| GET | `/api/jobs/:id/replay` | summary and timeline of the best run (`&format=text`) |
| POST | `/api/jobs/:id/try` | raw `.eetas` bytes or JSON `{eetasB64, source}`; `?wait=<s>` for a running job's verdict |
| POST | `/api/jobs/:id/probe` | JSON `{at, inputs: "R+J x3, R x20", try}` |
| POST | `/api/jobs/:id/focus` | JSON `{from, to, seconds, workers}`, runs in the background |
| GET | `/api/jobs/:id/focus` | the last focus search: state, results, log tail |
| GET | `/api/jobs/:id/trajectory?which=best` | the run for the viewer, simulated with the job's level JSON (rng_script, start_mode): `ticks`, `complete`, `runTicks`, `timerStart`, `version`, base64 little-endian arrays `x`, `y` (Int32, px x 16, top-left of the box, index = tick 0..ticks), `run` (Int32 run timer), `flags` (Uint8: 1 dead, 2 on ground, bits 2-4 gravity 0 down 1 up 2 left 3 right 4 none), `inputs` (masks), `events` ([tick, kind, ...]: coin/blue_coin x y, portal fx fy tx ty, death, respawn, jump, key color x y, key_expired, switch kind id on, checkpoint/crown/complete x y), `doors` ({"id:number": [solid at 0, toggle ticks...]}), `coinsTaken0`, `clock0` (the level clock at tick 0, for time doors); for `best` also `align` (Int32: the original's first tick at the same point, per best tick) and `original` {runTicks, version}. `which=original`: the uploaded TAS |
| GET | `/api/jobs/:id/level` | the level for the viewer: `width`, `height`, `fg`/`bg` (base64 Uint16 ids), `palette` {id: "aarrggbb" EE minimap color}, `kinds` {id: [kind, dir/sub, solid]} (src/blocks.js), `nums` [[index, rotation/number]], `lookup` [[index, int]] (the AS3 Lookup table), `bgColor` ("rrggbb" or null), `portals` [[index, rot, id, target, random]], `spawns`, `startMode`, `startMatters` |
| GET | `/api/eegfx` | EE graphics (src/eegfx.js): `{available, dir, source, why, version, sheets, sizes, blocks: {id: [sheet, frame, y, layer, shadow]}, sprites, rot, npcs, smiley, death, numbers, ids}`; `available: false` with `why` when no eeo-tas folder is found |
| POST | `/api/eegfx` | JSON `{dir}`: the eeo-tas folder for EE graphics (checked for `media/blocks.png` and `src/items/ItemManager.as`, saved in `<data>/settings.json`; `""` = find it automatically) |
| GET | `/api/eegfx/sheet/<name>.png` | a sprite sheet, straight from the eeo-tas media folder (only names in the map) |
| GET | `/editor` | the level editor page (`src/app/editor.html`) |
| GET | `/api/editor/blocks?ids=9,121` | per id: `names`, `kinds` ([kind, dir/sub, solid]), `palette` (EE minimap color), `args` (eelvl `argKind`) |
| POST | `/api/editor/eelvl` | the editor's level JSON `{level: {name, width, height, gravity, bgColor, cells: [[x, y, id, ...args]], bg}}` -> `.eelvl` bytes |
| POST | `/api/editor/parse` | `{eelvlB64}` -> the editor's level JSON (read like EEO: the Lookup's numbers and portals) |
| POST | `/api/editor/check` | `{eelvlB64}` or `{level}` -> `problems` [{code: spawn / trophy / unreachable, text}], `notes`, `start`, `trophies`, `reach` (open / portals / none), `gpu` |
| POST | `/api/editor/solve` | `{eelvlB64, guide: [[x, y], ...] (px, ball centre), seconds (60), width (32768), workers (CPU threads), seed}`: the route search in the background (GPU strategies + the CPU's `src/goexplore.js`; the CPU alone without an NVIDIA GPU), one at a time; 400 with `problems` when the level is not ready |
| GET | `/api/editor/solve` | `running`, `stage` (searching / found / not found / stopped / error), `tick`, `ticksPerSec`, `cpuOnly` (the note when the CPU searches alone, else ''), `workers`, `strategies` [{key, label, cpu, live, state, layer, found, detail}], `result` {time, runTicks, ticks, inputs ('0'+mask chars), path [[x, y] per tick], strategy}, `closest` (no route yet: the attempt nearest the trophy by walking distance around walls and deadly tiles: {dist, tiles, ticks, time, inputs, path, strategy}), `message`; `POST .../stop`; `GET .../route.eetas`, `.../closest.eetas`, `.../level.eelvl` |
| POST | `/api/editor/job` | `{eelvlB64, eetasB64, name, start, processor}`: `jobs.importJob` (start mode reset; one spawn) and optionally start (GPU when available) |

## 10. Scripting against the engine

```js
const C = require('./src/common.js');      // from src/out/: require('../common.js')
const J = require('./src/jobs.js');
const E = C.E;                              // eesim.js
const id = J.resolve('veil');               // id, prefix or part of the name
const level = J.loadJobLevel(id);           // prepared level (with the job's rng_script)
const best = C.readEetas(`${J.jobDir(id)}/best.eetas`);
const tr = C.replay(level, best, { trace: true });   // X, Y, VX, VY, RUN per tick, events [{t, kind, data}]
const t = C.tickOf(tr, C.parseTime('1:10.40'));
const sim = new E.EESim(level); sim.reset();
const inp = new E.EEInput();
for (let k = 0; k < t; k++) { E.applyMask(inp, best[k]); sim.tick(inp); }
const s = sim.snapshot();                   // restore(s) as often as you like; stateHash() to compare states
const ev = C.evaluate(level, candidateMasks);          // null = does not finish; else {runTicks, deaths, chance, ms}
C.writeEetas('src/out/idea.eetas', ev.ms);             // then: node src/tas.js try <job> src/out/idea.eetas
```
