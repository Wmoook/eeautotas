# tools/tas: bit-exact JS port of EESim for TAS optimization

`eesim.js` is a Node (CommonJS) port of `scripts/physics/ee_sim.gd`. After every tick it matches Godot bit for bit:
all traced fields (doubles compared by raw IEEE bits) plus the full event stream. It is about 2x faster than a
straightforward port, and snapshot/restore/stateKey are cheap enough to call on every search node.

| file | what |
|---|---|
| `export_level.gd` | level -> `data/<id>.json` (width, height, gravity bits, fg/bg base64, extras in Dictionary order) |
| `dump_trace.gd` | replays inputs through the GDScript EESim and writes the state after every tick (`data/<name>_trace.bin` raw float64 + `_trace.json` fields/events/RNG vectors) |
| `eesim.js` | the port |
| `validate.js` | compares eesim.js against a trace: every tick and field, events, snapshot/restore, stateKey, throughput |
| `fuzz.js` | builds test cases for mechanics the TAS never touches (see Validation) |

`G="C:/Users/super/Downloads/Godot_v4.6.1-stable_win64.exe/Godot_v4.6.1-stable_win64_console.exe"`, headless only:

```sh
"$G" --headless --audio-driver Dummy --path . -s res://tools/tas/export_level.gd -- level=forgotten_veil   # also odyssey
"$G" --headless --audio-driver Dummy --path . -s res://tools/tas/dump_trace.gd -- level=forgotten_veil \
     tas=res://levels/tas/forgotten_veil.eetas name=forgotten_veil
node tools/tas/validate.js                       # default: data/forgotten_veil_trace.json  -> PASS
node tools/tas/validate.js tools/tas/data/<name>_trace.json [--quick] [--no-bench] [--reps N]
```
`dump_trace.gd` also takes `random=<seed>:<ticks>[:<hold>]`, `raw=<bytes file>` (1 jump held, 2 left, 4 right,
8 up, 16 down, 32 jump_pressed, 64 god_toggle), `patch=<json>` (blocks placed into the level; the patched level is
exported as `data/<name>_level.json`), `ticks=`, `pad=`. Traces and test cases in `data/` are regenerable and
git-ignored; `data/forgotten_veil.json` / `odyssey.json` are what the optimizer loads.

## API
```js
const { loadLevel, EESim, EEInput, applyMask, parseEetas } = require('./eesim.js');
const level = loadLevel('tools/tas/data/forgotten_veil.json');   // read-only, share it between sims
const sim = new EESim(level); sim.reset();
const inp = new EEInput();                    // left right up down jump jump_pressed god_toggle
for (const m of parseEetas(text)) { applyMask(inp, m); sim.tick(inp); }   // eeo-tas: jump bit = jump + jump_pressed
```
- State (names as in ee_sim.gd): `px py speed_x speed_y coins blue_coins has_crown has_silver_crown run_ticks
  deaths is_dead on_ground gravity_dir{x,y} in_god_mode checkpoint{x,y} jump_count ...`, `sim.ticks()`.
  `optimize.js` also reads `_keysMask` (bit c = red, green, blue, cyan, magenta, yellow) and `_switches` /
  `_oswitches` (Map id -> bool). They stay stable.
- `sim.onEvent = (kind, data) => {}`: the same kinds/payloads as `sim_event` (tiles/dirs as `{x, y}`, `pos` as
  doubles where Godot has a float32 Vector2). With `onEvent = null` no event objects are built.
- `tick()` mutates `input.jump_pressed` / `god_toggle` (cleared) exactly like EESim.
- `snapshot([reuse])` / `restore(s)`: full state, restorable any number of times in any order, bit-identical
  continuation. Scalars are copied. Collected coins, secrets and switch maps are copy-on-write and shared.
  `snapshot(prev)` refills an old snapshot object (no allocation). Call between ticks.
- Query helpers from ee_sim.gd: `is_key_active is_switch_on is_orange_switch_on get_tile get_tile_number
  is_tile_solid_now is_tile_one_way is_coin_collected is_secret_revealed get_portal key_time_left`.

## stateKey()
`sim.stateKey()` returns a binary string (UTF-16 code units, about 64 chars on FV) for Map/Set keys. It is equal
iff the two states behave identically from here on: physics and events, `run_ticks` in `complete` aside.
Absolute clocks are left out (`_ticks _offset run_ticks prev_px/py teleported`, plus the per-tick input and
derived fields that the next tick overwrites before reading them). Running timers are keyed as exact ticks
remaining (World.offset table). That covers active keys and keys with a queued switch, the time-door phase
(only if the level has 156/157), fire (only while burning) and `_dead_offset` (only while dead). `_ox/_oy` are
keyed only when a one-way tile is under the box or the player is dead. The key also covers coins (collected-coin
bitset), secrets, switch on-sets, queues and the RNG step count (only if some portal id has more than one target).
`-0` and `+0` key the same, as do all `_slippery <= 0` values (provably no behavioural difference).
- **Absolute-clock caveat.** A key/time-door period that *starts* at tick p lasts 500 or 501 ticks depending on
  p, because `_offset += 0.3` accumulates in floating point (73% / 27%). So two equal-key states at *different*
  ticks can differ by one tick in the length of a key or time-door period that begins after that point. At the
  same tick, equal keys are exact. `stateKey(true)` also keys `_ticks` on levels that have key tiles or time
  doors (FV has blue/magenta keys with doors), making it exact across ticks too.
- Under eeo-tas inputs (`applyMask`, where jump always comes with jump_pressed) the held-jump timer `_last_jump`
  and `_prev_jump_held` provably never matter, so they are not keyed. If you drive `EEInput` directly with
  `jump && !jump_pressed`, set `sim.stateKeyRawInput = true`.

## Exactness notes
- Arithmetic follows ee_sim.gd op for op. The 8 drag constants are hardcoded from Godot's bits (checked against
  every trace). `int()` = truncation, `fmod` exact. Godot's RandomNumberGenerator (PCG32, `randi_range`) is
  ported with BigInt. FV's TAS uses it once (a random multi-target portal).
- The speed-ups are exact shortcuts:
  - `overlaps()` classifies the box from precomputed per-tile masks: all air, or the first tile in scan order is
    a plain solid. The per-tile rectangle test provably always passes inside the scan range.
  - The collision-free sub-step loop runs the same stepping arithmetic, then verifies with one lookup that every
    probed box was plain air; otherwise it re-runs the exact loop.
  - PlayState's three `overlaps()` calls are classified once when they take a fast path.
  - `fmod` avoids V8's C call; `(d / 30) >= 5` equals `d >= 150`, checked at load.
  The GDScript code is the reference; `validate.js` is the proof.

## Validation (all PASS)
FV TAS (11539 ticks). FV TAS prefixes + 4000 random ticks around the portals, the switch and the magenta key
(`fv_mix_*`). An Odyssey random walk (20000 ticks). Three fuzz arenas (`node tools/tas/fuzz.js name=fuzz1
seed=1`, 30-40k ticks with raw inputs, every block family: deaths/respawns, checkpoints, 2 spawns, liquids, ice,
climbables, spikes/fire/toxic, all keys/doors/gates, time doors, purple/orange switches incl. id 1000, coin /
blue / death doors+gates, crowns, effects, `flip_gravity` 1-4, one-ways, half blocks, secrets, portals with every
rotation and random picks, music, god mode, held jumps). The deferred-queue corridor (`fuzz.js mode=queues`:
switch/crown/key pressed inside a gate, key expiring inside its door). Each is checked every tick and field, plus
events, random-order restores and stateKey (including 150+ groups of different histories converging on equal
keys at the same tick, whose futures must be identical).

## Performance (i7-11800H laptop, one thread, FV TAS, onEvent null)
About 4.5M ticks/s at ~3.5 GHz (about 3.3M at the 2.3 GHz base clock); a straightforward port does 2.4M / 1.7M.
`snapshot(reuse)` ~45 ns, `snapshot()` ~150 ns, `restore()` ~50 ns, `stateKey()` ~150-220 ns.

## Optimizer tools
All of them read a run that completes the level (`--tas=`, default the level's TAS). Every result is verified
by a clean replay before it is written. The key idea is **exact rejoins**: a searched state whose `stateHash()` equals the
reference run's state at a later tick j is a proven shortcut. From there the reference inputs replay exactly, so
the time saved is j minus the searched tick. `stateHash()` is a 53-bit hash of exactly what `stateKey()` contains,
about 3x cheaper. Exact rejoins are frequent in EE: wall hits, landings and portals reset the state.
| file | what |
|---|---|
| `run.js <file>` | replay a run: completion tick, run timer, coins, deaths, coin timeline (~20 ms for a 2-minute run) |
| `optimize.js` | beam search along the reference route (`--width`, `--workers`, `--passes`, `--dist`). The elitism line always replays the reference inputs shifted by the best **verified** lead, so a lead it found is never lost again. `--prefix=<file>` plays a new segment first, then searches. |
| `explore.js` | route explorer (Go-Explore style) for one window `--from..--until`: an archive of cells (position, velocity, jump and gravity-queue state, context) with the earliest arrival, seeded with the reference route, extended by random sticky-input rollouts. It prefers states that are ahead of the reference. `--exact=1` accepts only exact rejoins. It finds NEW routes, e.g. mini 7 (-11 ticks). |
| `sweep.js` | runs `explore.js --exact=1` on overlapping windows of the whole run, then combines all shortcuts by dynamic programming over the reference ticks |
| `shortcuts.js` | local beams (`--depth`, `--cap`) from every `--step`-th reference tick, collecting exact rejoins, combined by DP |
| `splice.js out a b c...` | splices several runs at equal states (fastest combination) |
| `segsearch.js` | cell-dedupe BFS for one segment (superseded by explore.js) |
| `mutate.js` | input mutations at every tick: delete 1-2 ticks, hold one option over 1-4 ticks while dropping 0-2 ticks, then (if those find nothing) pairs of single-tick changes up to 5 apart. The reference inputs replay after the change and any exact rejoin counts, combined by DP. Takes seconds; run it between the other stages. |
| `routecheck.js` | verifies approximate route candidates (`explore.js --cands=K`) by letting the beam (`optimize.js --prefix`) finish the level from each one |
| `grind.js --until=05:56 [--rot=N] [--skip=W,A,B,deep,beam]` | runs until the deadline, which rolls to the next day. Each round: mutation loops, deep exact-rejoin exploring of every coin-to-coin segment in rotating window sizes, one dense shortcuts pass, and a beam every other round, then splices. `--rot` continues the parameter rotation after a restart. It publishes every improvement to `levels/tas/<level>_fast.eetas` and to `tas_fast_name` in the level config, which Settings > RUN FASTEST plays. Log: `out/grind.log`. |

Overnight result (2026-09-24/25, i7-11800H, 16 threads): 1:55.27 -> **1:53.10**. The biggest wins came from exact-rejoin
exploring (minis 6 and 7, the start, the portal chain before coin 4, the portal loop) and dense local shortcuts at depth
120-200. Mutation passes found many 1-2 tick fixes. The beam and the wide shortcut stage added little. Approximate rejoins
were always fake here (mini 10), so the exact check is what makes the results trustworthy.

## Known gaps
Not in ee_sim.gd either: world portals 374, levitation, curse/zombie/team effects. Not exercised by any trace:
levels with world gravity != 1, levels without a spawn point, `respawn()` with a pending switch queue.
