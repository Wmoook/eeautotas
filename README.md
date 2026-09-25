# EE Auto TAS

Automatic TAS optimizer for **Everybody Edits Offline** (eeo-tas). Give it a level (`.eelvl`) and a TAS that
finishes it (`.eetas`). It keeps searching for a faster run, around the clock, until you stop it. You then download
the faster `.eetas` and play it in eeo-tas.

- It uses an exact copy of the game's physics, bit for bit the same as eeo-tas, so a run that finishes here finishes
  the same way in the game.
- Every improvement is proven by replaying the whole run. Nothing is estimated.
- It runs on your own computer. No account, no internet, no AI needed.

## Requirements

- Windows (the launcher is a `.bat`; the tools themselves run anywhere Node runs)
- [Node.js](https://nodejs.org/) **18 or newer** (the free LTS version is fine)

That is all: no `npm install`, no Godot, no Python.

## Run it

- **Double-click `START.bat`.** Your browser opens http://localhost:47823. Keep the black window open while it
  optimizes. Closing it stops the optimizer, and it resumes the next time you start the app.
- Or from a terminal in this folder: `npm start` (or `node src/server.js --open`; `--port=12345` for another port).

## Use it

1. **Drop your `.eelvl` and `.eetas`** on the page (or click to choose them), give the run a name, answer **How did
   you start the TAS in eeo-tas?** (see below; the default is right for the usual workflow) and press
   **Import & check**. The level is read the way EE Offline reads it, and your TAS is replayed in the exact physics.
   If it does not finish the level you get a clear message (where the ball ended up, coins, deaths).
2. Pick how many **threads** to use and press **Start**. It uses the CPU heavily. The first time the app starts it
   measures how fast this PC runs the physics (a few seconds, once), and the thread list shows the speed for each
   count, e.g. "8 · 26 M/s (fastest)". On a laptop more threads is often not faster: pick the fastest count or
   fewer, and keep it cool. One run optimizes at a time. The **processor** is the CPU; GPU mode is not available,
   and the page says why (see "CPU or GPU?" below).
3. **Notifications:** every improvement pops up in the page. If you allow browser notifications, you also get one
   while the tab is in the background. The tab title shows the time saved. The chart and the list show every
   improvement and which search found it.
4. **Watch** (any time, also while it optimizes): plays the current best run in the level, with your original
   `.eetas` as a pale **ghost** ball at the same in-game time. See "Watching a run" below.
5. **Pause / Resume** at any time. Progress is never lost: the best run is saved after every improvement, and a
   paused or closed app continues where it left off.
6. **Ideas** (optional): if you think time can be saved somewhere, enter that part of the run (in-game time, like
   `1:10.00` to `1:14.00`) and press **Search harder here**. The app runs its route explorer and shortcut searches on
   just that part, next to the main optimizer, and hands anything faster to it. **Show map** draws the level and your
   path there.
7. **Finish run** stops the optimizer, writes a final report (time saved, odds, see below) and downloads the final
   `.eetas`. **Download optimized .eetas** works any time, even while it runs. **Original** gets back your own file.
8. Play it in eeo-tas like any TAS: load the level, `/loadtas` (pick the file), `/reset`, `/playtas` (or start it
   the same way you started your own TAS, see below).

## Watching a run

**Watch** (next to each run in the list, and at the top of a run) opens a player over the page. It replays the
job's current best run in the same exact physics the optimizer uses, while the optimizer keeps running.

- The level is drawn in EE's own minimap colors (background blocks dimmed). Arrows show their gravity direction,
  dots, boosts, portals (a white dot marks a random exit), coins (they disappear when the run takes them), doors and
  gates (filled = closed, outline = open, with the coins or deaths they need), spikes and the finish (green checker)
  are marked. The yellow line is the last moment of the run, the thin line its whole route.
- The **ghost** is your original `.eetas`, shown at the same in-game time. The timers of both runs run live, and the
  panel says how far the original is behind at this point of the route (for example "original is 0.42 s behind
  here"), and at the finish.
- **Space** play / pause, speed 0.25x to 16x, the bar scrubs through the run, **jump to** takes a run time
  (`1:10.00`, `70.5s`) or a tick number. **+ / -** or the mouse wheel zoom, drag to look around (**Follow** or a double
  click follows the ball again), **← / →** move 1 s (with Shift 1 tick), **G** hides the ghost, **Esc** closes.
- When the optimizer finds a faster run while you watch, a **Newer version found · reload** button appears; the view
  does not change until you press it.
- Link straight to it: `http://localhost:47823/#watch=<job id>&t=1:10.00` (also `&zoom=0..13`, `&play=1`).
- It works on a phone-sized screen too (pinch to zoom).

## How you started the TAS in eeo-tas

The state a TAS starts from depends on how you started it in eeo-tas:

- **After /reset** (the default, and the eeo-tas README workflow: load the level, `/reset`, then record or play).
  `/reset` moves the player to the *next* spawn point.
- **Right after loading the level** (`/playtas` without `/reset`): the first spawn point, and coins that the level
  file stores as already collected stay collected.

This only matters on levels with **2 or more spawn points** or **time doors** (and levels that store collected coins).
On every other level both starts are identical and the app says so. If your TAS does not finish with the start you
picked but does with the other one, the import tells you. The choice is stored with the run and every tool uses it;
the run's header shows it when it matters. From a terminal: `node src/tas.js import level.eelvl run.eetas --start=load`.
"Right after loading" assumes you typed `/playtas` right away: the level clock (time doors) runs while you wait.

## CPU or GPU?

The app runs on the **CPU**, and that is the faster choice for this job. GPU mode is shown but not available:

- **It must be exact.** Every run is replayed bit for bit like eeo-tas: the same 64-bit floating point operations
  in the same order (EE's physics works in `Number`, an IEEE double). A result that is off in the last bit can take a
  different path a few thousand ticks later, and the optimizer would hand you a run that fails in the game.
- **WebGPU (the GPU in a browser) has no 64-bit floats at all**, only 32-bit (and 16-bit). Emulating doubles with
  pairs of 32-bit floats is slow and does not round exactly like IEEE doubles.
- **Gaming GPUs run 64-bit math at about 1/64 of their 32-bit speed** (GeForce cards; only data-center cards are
  faster). With CUDA or Vulkan an exact port would be possible, but slow.
- **The physics is branchy.** Each tick moves the ball in 1 px steps with a collision test per step, and portals,
  doors, keys, switches and deaths all branch. The searches try thousands of different inputs, so neighboring GPU
  threads would take different branches almost at once, and GPUs are slow at that. The searches also keep hash
  tables of states and snapshots, which suit a CPU.
- **The numbers:** one CPU thread runs about 5-7 million ticks per second, a laptop about 20-30 million on all
  threads, a desktop more. An exact GPU port would have to beat that with 64-bit math at 1/64 speed and heavy branch
  divergence; it would very likely be slower, and it would be a second engine that would have to be proven
  bit-identical. So there is one exact engine, and it runs on the CPU. `GET /api/system` shows this PC's measurement.

## What "random portal odds" mean

Some levels have portals with several exits (several portals share the target id). EE Offline picks one of them
**at random** every time, so a TAS through such a portal only works when the game happens to pick the right exit.
The app checks every combination of exits:

- **100%**: the run works every time.
- **50%**, for example: one portal with 2 exits where only one of them leads to the finish. Replay the TAS until the
  portal goes the right way (on average twice).

The optimizer **never lowers** these odds. A faster run that works less often is rejected. The final report lists
each random portal on the route, its time, how many exits it has and how many of them still finish.

## Where things are

- `src/jobs/<id>/best.eetas` is the current best run of a job. `best_<ticks>.eetas` keeps every improvement, and
  `grind.log` is the optimizer's log. `src/data/` holds the levels converted for the optimizer and the CPU speed
  measurement (`_system.json`; delete it to measure again). Both folders stay on your computer (git ignores them).
- Delete a run with the **Delete** button (click twice).

## Command line (optional)

Everything the page does also works from a terminal, whether or not the app is running:

```
node src/tas.js help                           all commands
node src/tas.js jobs                           list runs
node src/tas.js status <job>                   details, recent improvements, log
node src/tas.js where <job> 1:10               the run's state at 1:10 (position, speed, next inputs, a text map)
node src/tas.js render <job> 1:08 1:14         PNG of the level around the path in that part
node src/tas.js try <job> my_run.eetas         offer your own faster run to a job (it is verified first)
node src/tas.js focus <job> 1:08 1:14 120      search that part harder
node src/tas.js import level.eelvl run.eetas   create a run without the page (--start=load: started right after
                                               loading the level); then: start <job>, stop <job>
node src/bench.js                              measure this PC's physics speed (1 thread and all threads)
```

The app also has a local JSON API (`GET http://localhost:47823/api` lists it; the viewer uses
`/api/jobs/<id>/level` and `/api/jobs/<id>/trajectory`, the processor selector `/api/system`). CLAUDE.md documents
both.

## Limitations

- It can only shorten the run you give it: it needs a TAS that already finishes the level, and it searches for
  faster inputs near that route and its variations. It finds new routes locally, but it does not plan a whole new
  route across the level.
- Mechanics that the physics copy does not model yet are listed under "Known gaps" in `docs/ENGINE_NOTES.md`
  (currently world portals, the fly effect, curse / zombie / team effects). A level that uses them on the route
  cannot be optimized reliably.
- The TAS has to finish within its own inputs. eeo-tas keeps running with no input after the file ends, but the
  optimizer only counts a finish that happens while the file is still playing.
- All times are the in-game timer, the same number eeo-tas shows. It starts at your first input, so ticks
  before that do not count.
- Heavy CPU use for as long as it runs. CPU only (see "CPU or GPU?").

## Using it with an AI assistant (optional)

You never need an AI for this app. If you like, you can start an AI coding assistant (for example Claude Code) in
this folder while the app runs and talk to it about your run: "at 1:10 I think you can jump over that wall
earlier". `CLAUDE.md` (and `AGENTS.md`) tell the assistant how the app works. It can look at that moment, draw the
level, test your idea exactly in the game's physics, and hand an improvement to the running optimizer. The
optimizer checks everything the assistant hands in with the same rule it uses for its own results, so a wrong idea
can never make your run worse.

## Troubleshooting

- **"The TAS does not finish this level"**: the `.eetas` belongs to another level, or to another version of it, or
  the file was edited in a text editor. Every byte of an `.eetas` is one tick, so an added line break is an extra
  input. On a level with several spawn points, check "How did you start the TAS in eeo-tas?" (the message says
  when the other start works).
- **The page does not open**: go to http://localhost:47823 yourself. If another program uses that port, run
  `node src/server.js --open --port=47900`.
- **Node.js is not installed**: START.bat opens the download page. Install the LTS version, then start again.
