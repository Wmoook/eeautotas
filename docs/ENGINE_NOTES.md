# tools/tas: bit-exact JS port of EESim for TAS optimization

`eesim.js` is a Node (CommonJS) port of `scripts/physics/ee_sim.gd`. After every tick it matches Godot bit for bit:
all traced fields (doubles compared by raw IEEE bits) plus the full event stream. It is about 2x faster than a
straightforward port, and snapshot/restore/stateKey are cheap enough to call on every search node.

| file | what |
|---|---|
| `export_level.gd` | level -> `data/<id>.json` (width, height, gravity bits, fg/bg base64, extras in Dictionary order). *Not in this repo:* EX Odyssey project, `3d33/tools/tas/` (this app reads `.eelvl` files itself with `src/eelvl.js`) |
| `dump_trace.gd` | replays inputs through the GDScript EESim and writes the state after every tick (`data/<name>_trace.bin` raw float64 + `_trace.json` fields/events/RNG vectors). *Not in this repo:* `3d33/tools/tas/` |
| `eesim.js` | the port (`src/eesim.js` here) |
| `validate.js` | compares eesim.js against a trace: every tick and field, events, snapshot/restore, stateKey, throughput. *Not in this repo:* `3d33/tools/tas/`; here `node test/regress.js` covers the engine |
| `fuzz.js` | builds test cases for mechanics the TAS never touches (see Validation). *Not in this repo:* `3d33/tools/tas/` |

The Godot validation commands below run in the EX Odyssey project (`C:\Users\super\3d33`), where these files live.
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
const { loadLevel, EESim, EEInput, applyMask, parseEetasBytes } = require('./eesim.js');
const level = require('./eelvl.js').loadEelvlLevel('level.eelvl');   // or loadLevel(json); read-only, share it
const sim = new EESim(level);                 // = load the level, /reset, /playtas (see "eeo-tas tick loop" below)
const inp = new EEInput();                    // left right up down jump jump_pressed god_toggle
for (const m of parseEetasBytes(fs.readFileSync(file))) { applyMask(inp, m); sim.tick(inp); }   // raw bytes!
```
- `parseEetasBytes(buffer)`: eeo-tas `TASInput.readInputs` exactly: every byte is a tick, `mask = (byte - 48) & 31`,
  no trimming, no BOM skipping (LF = left+up+down, CR = jump+right+up+down, a BOM = 3 ticks). `parseEetas(text)`
  is kept for old callers: `parseEetasBytes(Buffer.from(text, 'latin1'))` (correct for ASCII files read as
  `'utf8'`; anything else must be read as bytes). `eetasOddBytes(buf)` lists bytes outside `'0'..'O'`.
- `new EESim(level, { start, idleTicks, startSpawn, goldBorder, ticksPerFrame })` (defaults from
  `prepareLevel(json, opts)` / JSON `start_mode idle_ticks start_spawn gold_border ticks_per_frame`).
- `sim.ticks()` = ticks since the replay started (= bytes consumed; the completion tick), `sim.level_ticks()` =
  `PlayState.ticks` (they differ only with `start: 'load'` and idle ticks).
- State (names as in ee_sim.gd): `px py speed_x speed_y coins blue_coins has_crown has_silver_crown run_ticks
  deaths is_dead on_ground gravity_dir{x,y} in_god_mode checkpoint{x,y} jump_count ...`, `sim.ticks()`.
  Effects: `jump_boost speed_boost low_gravity max_jumps flip_gravity is_invulnerable is_on_fire is_cursed
  is_zombie is_poisoned has_levitation is_thrusting _current_thrust team` (+ `_team_tx/_team_ty`, the pending team
  retry, and the `_*_time_start` / `_*_duration` timers).
  `optimize.js` also reads `_keysMask` (bit c = red, green, blue, cyan, magenta, yellow) and `_switches` /
  `_oswitches` (Map id -> bool). They stay stable.
- `sim.onEvent = (kind, data) => {}`: the same kinds/payloads as `sim_event` (tiles/dirs as `{x, y}`, `pos` as
  doubles where Godot has a float32 Vector2). With `onEvent = null` no event objects are built. Additional kinds:
  `effect` `{effect: 'curse'|'zombie'|'poison'|'levitation'|'protection', on, tile, duration?}` (when a touch changes
  it) and `team` `{team, from, tile}` (a team change that went through).
- `tick()` mutates `input.jump_pressed` / `god_toggle` (cleared) exactly like EESim.
- `snapshot([reuse])` / `restore(s)`: full state, restorable any number of times in any order, bit-identical
  continuation. Scalars are copied. Collected coins, secrets and switch maps are copy-on-write and shared.
  `snapshot(prev)` refills an old snapshot object (no allocation). Call between ticks.
- Query helpers from ee_sim.gd: `is_key_active is_switch_on is_orange_switch_on get_tile get_tile_number
  is_tile_solid_now is_tile_one_way is_coin_collected is_secret_revealed get_portal key_time_left`.

## stateKey()
`sim.stateKey()` returns a binary string (UTF-16 code units, about 64 chars on FV) for Map/Set keys. It is equal
iff the two states behave identically from here on: physics and events, `run_ticks` in `complete` aside.
Absolute clocks are left out (`_ticks run_ticks frame_queue_ticks prev_px/py teleported`, plus the per-tick input
and derived fields that the next tick overwrites before reading them). Running timers are keyed as exact ticks
remaining: active keys and keys with a queued retry (`keysTimer + 500 - ticks`, all values <= 1 alike), curse,
zombie, fire and poison (flag, plus `start + floor(duration) + 1 - ticks` while alive, all values <= 1 alike, 0 = no
timer) and `_dead_offset` (only while dead). Levitation keys `_current_thrust` and `is_thrusting` (the latter only
while the thrust is non-zero, the only time it is read); on levels with 423 the team and the pending retry's cell
number (only while it differs from the team). The only absolute-clock state is keyed as such: the
time-door phase `PlayState.ticks % 1000` (only if the level has 156/157) and `ticks % ticksPerFrame` (only if
ticksPerFrame > 1). `_ox/_oy` are keyed only when a one-way tile is under the box or the player is dead. The key
also covers coins (collected-coin bitset), secrets, switch on-sets, queues and the RNG step count (only if some
portal id has more than one target). `-0` and `+0` key the same, as do all `_slippery <= 0` values (provably no
behavioural difference).
- **Exact across ticks.** eeo-tas timers are integer tick counts (a key lasts exactly 500 ticks from any start;
  the old EE Offline `World.offset` clock gave 500 or 501), so equal keys at different ticks behave identically.
  `stateKey(true)` / `stateHash(true)` are accepted for compatibility and change nothing.
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
  - `fmod` avoids V8's C call. The eeo-tas clock tests use their integer forms: `((t / 100) % 10) >= 5` is
    `t % 1000 >= 500` and `((d / 100) >= 5)` is `d >= 500` for integer t, d (spot-checked at load, checked over
    [0, 2e6) by `test/regress.js`).
  The GDScript code is the reference; `validate.js` is the proof.

## eeo-tas tick loop, clocks and start (ground truth eeo-tas/src; `node test/regress.js`)
- **Tick order** (`PlayState.tick`): `PlayState.ticks++`, the three gate snapshots, World.update (time doors, key
  expiry), `Player.tick` ending with the respawn check, then `PlayState.enterFrame`'s queue drains.
- **Keys**: `keysTimer = PlayState.ticks` (int); expiry and the queued-retry drop when `ticks - keysTimer >= 500`:
  exactly 500 ticks (World.as:117-123, 149-153). A deferred expiry re-stamps the timer; a deferred pickup does not.
- **Time doors 156/157**: `timedoorState = ticks % 1000 >= 500` every tick (World.as:147): absolute phase from
  `/reset` (open 500-999, 1500-1999, ...). The gate snapshots of tick t still see the state of tick t-1.
- **Respawn** at the end of `Player.tick` (Player.as:1176-1179): killed in tick D, respawned at the end of D + 54,
  before the per-frame queues, which then retry at the spawn position.
- **Fire** (lava): start = `PlayState.ticks`, duration `(2 + 2*0.2) * 100` = 240, killed at start + 241.
- **Start** (`reset()`): level load (spawn index 0), `idleTicks` live idle ticks, then with `start: 'reset'`
  (default, the eeo-tas README workflow) `/reset` = `resetPlayer()` + `ticks = 0`: the next spawn of the rotation
  (index 1 % n), 110/111 back to 100/101, coins/deaths/timer/effects/checkpoint/crowns/purple switches cleared;
  keys + timers, orange switches, queues, the gravity queue, slippery, pastx/pasty, ox/oy (0,0 at load),
  overlapa..d, lastPortal, time-door state and gate snapshots are kept. `start: 'load'` = `/playtas` right after
  the load (spawn 0, 110/111 stay collected, `ticks = idleTicks`). `startSpawn` forces a spawn index.
- **Spawns**: `spawnPoints[0]` = every 255 and 1582 #0 in level-file order (eelvl.js `spawn_points`); none =
  (16,16). Old JSON without `spawn_points` falls back to row-major 255 (`level.spawnOrder`).
- **World gravity**: the header float32 as stored (0 = none, negative = upwards); no fallback to 1.
- **Gold border**: option `goldBorder` (cookie setting): 200 open / 201 shut with it; default off.
- **Per-frame queues** (orange switches, crowns, keys): eeo-tas drains them once per rendered frame. `/playtas 1`
  runs a tick every 10 ms at 120 fps (8.3 ms frames): 0 or 1 tick per frame, so a drain follows every tick, and
  extra drains between two ticks change nothing: that is the default `ticksPerFrame = 1` (also Shift+C
  stepping). Lag, a < 100 fps player, `/playtas N` with N > 1.2 or the 10x speed after the end of the file put 2+
  ticks in a frame; `ticksPerFrame = k` models k per frame. `sim.frame_queue_ticks` counts the ticks that ended
  with such a retry pending: 0 means the run does not depend on frame timing (FV: 0).
- **End of the .eetas**: `/playtas` keeps running on the live keyboard (mask 0 when nothing is held) at 1 ms per
  tick; `/playsegment` stops. A run must complete within its bytes.

## Block mechanics (ground truth Player.as, Me.as, World.as; `node test/mechanics.js`)
All effect blocks act when the tick-START cell is entered (touchBlock after movement, `pastx/pasty` rule), not flying.
- **Timed effects** curse 421, zombie 422, poison 1584 (and fire from lava): touch with `v = getInt` of the cell:
  `on = v > 0`; nothing happens if the flag already equals `on` (no timer refresh) or while protected; else the flag
  is set and, if on, `start = PlayState.ticks`, `D = (v + 2*0.2) * 100` in doubles (Player.setEffect). Killed at the
  top of the first Player.tick with `ticks - start > D`, i.e. `start + floor(D) + 1` (v = 16..20 and 256..327 kill
  one tick before `100v + 41`), checked in the order curse, zombie, fire, poison, only while alive. NPC zombie 1573:
  zombie with duration 0 (never kills), unless already zombie or protected. Respawn and `/reset` clear all four;
  effect reset 1618 does not.
- **Zombie**: speed x0.6 after the run effect, jump x0.75 after the jump effect and before ice's x0.88; zombie GATE
  206 is open unless zombie, zombie DOOR 207 only while zombie (World.as:734-735; eesim had them swapped). No overlap
  revert: becoming a zombie inside 206 leaves the player stuck in it.
- **Protection 420** (`getBoolean`, change only if different): turning it on clears curse, zombie, poison and fire;
  while on, none of them (nor lava's fire) can be picked up, and spikes / fire / toxic do not kill.
- **Effect reset 1618** = `resetEffects(false)`: jump, run, protection, low gravity, multijump (1), gravity (0) and
  levitation (thrust 0) off; timed effects and team kept.
- **Levitation 418** (`getBoolean`): while it is on, the jump bit sets `isThrusting` and `_currentThrust = 0.2`
  instead of jumping (no jumps at all); a tick without the bit clears `isThrusting` (alive only: a dead player keeps
  the stale value). After touchBlock, also while dead: `speedY = (speedY*7.752 - (thrust*13)*(mory*0.5))/7.752` on
  each axis with a non-zero int `mor` (so no force in liquids, dots, climbables, boosts; the x7.752 round trip happens
  even at thrust 0), then, unless thrusting, `thrust -= 0.01` while > 0, else 0 (0.19, 0.18, ... -3.1e-17, 0).
  Turning it off (418 with 0, 1618, /reset) zeroes the thrust. Respawn keeps levitation, thrust and isThrusting.
- **Teams**: 423 calls `UpdateTeamDoors(cx, cy)`: `tx,ty = cell`; if `team != getInt`, set it and, if the box then
  overlaps something (a team door/gate closing on it), revert and keep `tx,ty` pending, else `tx = ty = -1`. Every
  Player.tick retries a pending cell right after `current` (before movement, also while dead, with overlaps()' side
  effects). Doors: 1027 open iff `team == L`, 1028 iff `team != L`. Death keeps team and `tx,ty`; `/reset` sets
  team 0 and keeps `tx,ty`. Player.as:421's `tx` is the member, not the `var tx:Number` local declared later in
  Player.tick (the hoisting reading would reset the team every tick): EE Offline's compiled Player.tick
  (`Downloads/EE_Offline.swf`, built with Flex SDK 4.6 build 23201, the SDK of eeo-tas's `.actionScriptProperties`)
  reads `getlocal0; getproperty private::tx` at offset 744. eeo-tas itself was not available compiled.
- **Gold door 200 / gate 201**: `goldBorder` option (see above).
- **Keyboard-only blocks**: god block 1516 (enables the G key), world portal 374 and reset point 466 (need Y held) are
  not solid and do nothing in a replay; so are signs, labels, NPCs other than 1573, music, map block, decorations.
- **Lookup table**: `prepareLevel` builds the cell numbers from `lookup_int` (AS3 `Lookup.getInt`: position keyed,
  either layer, last write wins); JSON without it falls back to `extras` (identical for every file EEO writes).

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
The web app measures each PC once (`src/bench.js`: a synthetic arena with random inputs, warmed-up workers, 1 / half /
all threads at once; cached in `src/data/_system.json`, shown by the Processor selector and `GET /api/system`). On
this laptop: about 6-7M ticks/s on one thread, about 26M with 8 threads, and no more with 16. `node src/bench.js
--threads=N` measures by hand. Why there is no GPU mode: README.md, "CPU or GPU?".

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
| `sweep.js` | *not in this repo* (EX Odyssey project, `3d33/tools/tas/`; here `grind.js` does this per coin-to-coin segment): runs `explore.js --exact=1` on overlapping windows of the whole run, then combines all shortcuts by dynamic programming over the reference ticks |
| `shortcuts.js` | local beams (`--depth`, `--cap`) from every `--step`-th reference tick, collecting exact rejoins, combined by DP |
| `splice.js out a b c...` | splices several runs at equal states (fastest combination) |
| `segsearch.js` | *not in this repo* (`3d33/tools/tas/`): cell-dedupe BFS for one segment (superseded by explore.js) |
| `mutate.js` | input mutations at every tick: delete 1-2 ticks, hold one option over 1-4 ticks while dropping 0-2 ticks, then (if those find nothing) pairs of single-tick changes up to 5 apart. The reference inputs replay after the change and any exact rejoin counts, combined by DP. Takes seconds; run it between the other stages. |
| `routecheck.js` | *not in this repo* (`3d33/tools/tas/`): verifies approximate route candidates (`explore.js --cands=K`) by letting the beam (`optimize.js --prefix`) finish the level from each one |
| `grind.js --until=05:56 [--rot=N] [--skip=W,A,B,deep,beam]` | runs until the deadline, which rolls to the next day. Each round: mutation loops, deep exact-rejoin exploring of every coin-to-coin segment in rotating window sizes, one dense shortcuts pass, and a beam every other round, then splices. `--rot` continues the parameter rotation after a restart. Job mode only (`--job=src/jobs/<id>`, started by the web app or `tas.js start`): every improvement goes to the job's `best.eetas` / `best_<ticks>.eetas`, log `grind.log`; it also accepts runs from the job inbox (`tas.js try`). See CLAUDE.md. |

Overnight result (2026-09-24/25, i7-11800H, 16 threads): 1:55.27 -> **1:53.10**. The biggest wins came from exact-rejoin
exploring (minis 6 and 7, the start, the portal chain before coin 4, the portal loop) and dense local shortcuts at depth
120-200. Mutation passes found many 1-2 tick fixes. The beam and the wide shortcut stage added little. Approximate rejoins
were always fake here (mini 10), so the exact check is what makes the results trustworthy.

## Known gaps
- Checked only against the AS3 source (synthetic tests in `test/regress.js` and `test/mechanics.js`), not against a
  real eeo-tas trace: world gravity != 1, levels without a spawn point, a respawn with a pending queue retry, and
  every mechanic of the section above (curse, zombie, poison, levitation, teams, zombie doors). The team retry
  reading rests on EE Offline's bytecode (same SDK), not on a compiled eeo-tas.
- Not modelled: anything needing the keyboard during a replay (Y on world portals 374 / reset points 466, G after a
  god block 1516, P), multiplayer tagging (`playerOverlaps`, a no-op alone), and the AS3 `portalLookup` quirks of
  crafted files with several records at one position (stale portal entries stay exits in EEO; eesim takes portals
  from the final tiles). Water / toxic cells get random lookup values while drawn (World.as:1611-1638), which
  nothing in physics reads.
- `Math.random` portal exits and per-frame queue timing: see above.
