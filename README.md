# EE Auto TAS

Automatic TAS optimizer for **Everybody Edits Offline** (eeo-tas). Give it a level (`.eelvl`) and a TAS that
finishes it (`.eetas`). It keeps searching for a faster run, around the clock, until you stop it. You then download
the faster `.eetas` and play it in eeo-tas.

- It uses an exact copy of the game's physics, bit for bit the same as eeo-tas, so a run that finishes here finishes
  the same way in the game.
- Every improvement is proven by replaying the whole run. Nothing is estimated.
- It runs on your own computer. No account, no internet, no AI needed.

## Easiest: the .exe (nothing to install)

Download **EEAutoTAS.exe** from the [Releases page](https://github.com/Wmoook/eeautotas/releases) and double-click
it. That is the whole app in one file (Node.js is inside it), so you can also just send the file to a friend.

- Windows may say "Windows protected your PC" because the file is not code-signed: click **More info**, then
  **Run anyway**. Some antivirus programs are wary of new unsigned programs too.
- Keep the black window open while it optimizes (closing it stops the optimizer; it resumes next time).
- Your runs are saved in `%LOCALAPPDATA%\EEAutoTAS\jobs`, so a newer exe keeps them.
- The command line works too: `EEAutoTAS.exe tas help` (see "Command line" below; use `EEAutoTAS.exe tas` wherever
  it says `node src/tas.js`). `EEAutoTAS.exe --help` lists the options.

To build the exe yourself: `npm run build:exe` (Windows, Node 22.12+). It writes `dist\EEAutoTAS.exe`; the first
build downloads two build tools from npm (postject, rcedit) into `tools\.cache`.

## Requirements (to run from the source)

- Windows (the launcher is a `.bat`; the tools themselves run anywhere Node runs)
- [Node.js](https://nodejs.org/) **18 or newer** (the free LTS version is fine)

That is all: no `npm install`, no Godot, no Python.

## Run it (from the source)

- **Double-click `START.bat`.** Your browser opens http://localhost:47823. Keep the black window open while it
  optimizes. Closing it stops the optimizer, and it resumes the next time you start the app.
- Or from a terminal in this folder: `npm start` (or `node src/server.js --open`; `--port=12345` for another port).

## Use it

1. **Drop your `.eelvl` and `.eetas`** on the page (or click to choose them), give the run a name, answer **How did
   you start the TAS in eeo-tas?** (see below; the default is right for the usual workflow) and press
   **Import & check**. The level is read the way EE Offline reads it, and your TAS is replayed in the exact physics.
   A run can only be created (and started) for a TAS that finishes the level: it then shows **✓ TAS verified to
   completion**. If it does not finish, you get a clear message (where the ball ended up, coins, deaths) and no run
   is created.
2. Pick how many **threads** to use and press **Start**. It uses the CPU heavily. The first time the app starts it
   measures how fast your CPU runs the physics (a few seconds, once; the page names the CPU it found), and the
   thread list shows the measured speed for each count, e.g. "8 · 26 M/s (fastest)". On many laptops more threads
   is not faster: pick the fastest count or fewer, and keep it cool. While it optimizes, the run shows its real speed
   right now ("Speed now: 12.4 M ticks/s on the CPU (8 threads)") and how many ticks it has simulated. One run
   optimizes at a time. The **processor**: CPU, or GPU + CPU on computers with an NVIDIA graphics card; the page
   shows the measured speed of both and marks the faster (see "CPU or GPU?" below).
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

- **EE graphics:** the level looks like Everybody Edits: the game's own blocks, backgrounds, decorations and shadows,
  the smiley for your run and a see-through smiley for the ghost. Doors, gates and switches open and close as the run
  goes, coin and death doors count down, coins disappear when the run takes them (a faint coin marks where one was).
  The images belong to Everybody Edits, so they are not part of this app: it reads them from your **eeo-tas** folder
  while you watch (the one you play TASes with: `EEO_TAS`, else `eeo-tas` in your user folder). If it is somewhere
  else, press **⚙** next to "EE graphics" and enter its folder (it needs `media/blocks.png` and
  `src/items/ItemManager.as`). Without eeo-tas, or with "EE graphics" unticked, the level is drawn in EE's minimap
  colors instead: arrows, dots, boosts, portals (a white dot marks a random exit), coins, doors and gates (filled =
  closed, outline = open, with the coins or deaths they need), spikes and the finish (green checker) are marked.
- The yellow trail is the last moment of the run, the thin line its whole route.
- The **ghost** is your original `.eetas`, shown at the same in-game time. The timers of both runs run live, and the
  panel says how far the original is behind at this point of the route (for example "original is 0.42 s behind
  here"), and at the finish.
- **Space** play / pause, speed 0.25x to 16x, the bar scrubs through the run, **jump to** takes a run time
  (`1:10.00`, `70.5s`) or a tick number. Frame by frame: the **◀ 1 tick / 1 tick ▶** buttons (hold to repeat) or
  **Shift+← / →**; **|◀ 1 s / 1 s ▶|** or **← / →** move 1 s. The current tick is shown next to them.
- **+ / -** or the mouse wheel zoom, drag to look around (**Follow** or a double click follows the ball again),
  **Fit level** (or **0**) shows the whole level. **G** hides the ghost, **Esc** closes.
- When the optimizer finds a faster run while you watch, a **Newer version found · reload** button appears; the view
  does not change until you press it.
- Link straight to it: `http://localhost:47823/#watch=<job id>&t=1:10.00` (also `&zoom=0..13` or `&zoom=fit`,
  `&play=1`).
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

Pick the **processor** next to Start. The page shows the measured speed of both on your computer and marks the faster.

- **CPU**: the optimizer's search tools on your CPU threads.
- **GPU + CPU** (NVIDIA graphics cards): the same CPU optimizer, plus a GPU search running next to it the whole time.
  The GPU starts from every tick of your current best run, tries millions of small input changes at once
  (holds, deletions, pairs of changes, random perturbations), and finds exact shortcuts: variants that reach a later
  state of the run in fewer ticks. They are combined into a faster run and handed to the optimizer, which checks
  it once more before accepting it. Page and log say "GPU".

**It is exact.** The GPU runs a second copy of EE's physics (`native/eecore.h`, C++), written to do every 64-bit
floating point operation of the main engine in the same order, so the results are bit for bit the same. `test/gpu.js`
proves it: both engines replay the real runs, dozens of real levels with random inputs and generated levels with
every block type, and must give the same state after **every tick** (on the CPU build and on the GPU). On top of
that, every shortcut the GPU reports is replayed again on the CPU with two independent state hashes, and every run
goes through the main engine and the acceptance rule before it counts. A GPU mistake can cost time, never give you
a run that fails in eeo-tas.

Good to know:

- Needs an NVIDIA GPU and a recent driver (2024 or newer). Nothing else to install: the `.exe` contains the GPU
  engine. The first time, the driver compiles it for your GPU (about 10 seconds, during the one-time GPU benchmark).
- Browser GPUs (WebGPU) cannot do this: they have no 64-bit floats. Gaming GPUs run 64-bit math at 1/64 of their
  normal speed, so the GPU engine does comparisons and conversions with exact integer tricks instead
  (`native/eecore.h`), which roughly doubled its speed.
- Laptops: GPU and CPU share the cooling. With both working flat out, the GPU gets hot and slows itself down; the
  live speed on the page shows what you actually get.
- A level can be too unusual for the GPU engine (a gravity setting that is not a normal number, or a gigantic
  number of switches); the page then says why, and the CPU does everything.
- From the source: `node tools/build-native.js` builds the GPU engine (it downloads zig and NVIDIA's NVRTC into
  `tools/.cache` once), and `node test/gpu.js --gpu` runs the exactness proof.

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
  `grind.log` is the optimizer's log. `src/data/` holds the levels converted for the optimizer, the CPU speed
  measurement (`_system.json`; delete it to measure again), the viewer's eeo-tas folder setting (`settings.json`) and
  the sprite map read from it (`eegfx.json`, rebuilt when eeo-tas changes). Both folders stay on your computer (git
  ignores them).
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
node src/bench.js                              measure the CPU's physics speed (1 thread and all threads)
```

The app also has a local JSON API (`GET http://localhost:47823/api` lists it; the viewer uses
`/api/jobs/<id>/level`, `/api/jobs/<id>/trajectory` and `/api/eegfx`, the processor selector `/api/system`). CLAUDE.md
documents both. `node src/eegfx.js` shows which eeo-tas folder the EE graphics come from and what it found there
(`node src/eegfx.js coverage level.eelvl` lists block ids of a level without a sprite).

## Limitations

- It can only shorten the run you give it: it needs a TAS that already finishes the level, and it searches for
  faster inputs near that route and its variations. It finds new routes locally, but it does not plan a whole new
  route across the level.
- How exact is "exact"? The physics copy follows the eeo-tas source line by line for every block and effect
  (gravity arrows and dots, liquids, ice, climbables, boosts, keys, switches, every door and gate family, portals,
  coins, spikes, fire, checkpoints, levitation, teams, curse, zombie, poison, protection, multi-jump, low gravity,
  speed/jump/gravity effects and more). Two real eeo-tas runs replay tick for tick: a Forgotten Veil TAS (1:55.27)
  and an Infinity Pain TAS (6:52.76, heavy on levitation, teams, multi-jump and low gravity). Curse, zombie, poison,
  time doors, liquids and ice are checked against the source and by tests, but no real run of them has been compared
  yet. One open detail: EEO computes 7 of its 8 friction constants with Flash's `Math.pow`, and it is not yet known
  whether that rounds like the constants used here in the very last bit. It has not changed a finish or a death in
  any test; `node test/review.js` prints a one-minute check you can do in eeo-tas to settle it.
- World portals, reset points and god blocks need the Y / G keys, which a `.eetas` cannot press, so in a TAS they do
  nothing, exactly like in eeo-tas. Remaining gaps are listed under "Known gaps" in `docs/ENGINE_NOTES.md`.
- The TAS has to finish within its own inputs. eeo-tas keeps running with no input after the file ends, but the
  optimizer only counts a finish that happens while the file is still playing.
- All times are the in-game timer, the same number eeo-tas shows. It starts at your first input, so ticks
  before that do not count.
- Heavy CPU (and in GPU mode GPU) use for as long as it runs. GPU mode needs an NVIDIA graphics card (see "CPU or GPU?").

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
