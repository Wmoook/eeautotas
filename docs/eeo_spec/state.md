# eeo-tas world state, events and run lifecycle

Scope: everything outside the per-tick movement arithmetic. That means the main loop and the order of events, the
deferred queues, keys, time doors, switches, coins, crowns, completion and the run timer, death and respawn,
checkpoints and spawn points, timed effects (curse, zombie, poison, fire), teams, levitation state, the world
gravity multiplier, god mode, and eeo-tas save states. The last section audits `tools/tas/eesim.js` against this
spec.

References:
- `X.as:N` is a line in `C:\Users\super\eeo-tas\src\X.as` (eeo-tas, the ground truth).
- `eeo:X.as:N` is a line in the original `C:\Users\super\ee-offline\src\X.as`, cited only where eeo-tas changed it.
- `eesim.js:N` is a line in `C:\Users\super\3d33\tools\tas\eesim.js`.
- `blitter/BlGame.as`, `blitter/BlContainer.as` and `blitter/BlObject.as` are single physical lines (CR line
  endings), so they are cited by function name.

Determinism tags used below:

| tag | meaning |
|---|---|
| **DET** | deterministic per tick, from the level, the `.eetas` bytes and the start state |
| **FRAME** | depends on how ticks fall into rendered frames. That is real-time, so not reproducible in general |
| **RT** | reads the wall clock (`new Date().time`, `getTimer()`) |
| **RND** | reads `Math.random()` (one global, unseeded Flash PRNG, also consumed by particles and rendering) |
| **LIVE** | reads live keyboard or mouse input, which is not in the `.eetas` file |

---------------------------------------------------------------------------------------------------------------

## 1. Main loop: frames, ticks and the exact order of events

### 1.1 Frame loop (`blitter/BlGame.as` `handleEnterFrame`)
```
if ((now - Bl.time) / Config.physics_ms_per_tick > 15) Bl.time = now - physics_ms_per_tick * 15;
for (; Bl.time < now; Bl.time += Config.physics_ms_per_tick) state.tick();   // 0..15 ticks
state.enterFrame();            // ONCE per rendered frame  -> PlayState.enterFrame (queue drains!)
Bl.exitFrame(); state.exitFrame(); state.draw(screen)
```
- `now` is `new Date().time` (**RT**). The stage frame rate is 120 (`Config.as:78`, set in `PlayState.as:191`).
- `Config.physics_ms_per_tick` defaults to 10 (`Config.as:44`). `/playtas s`, `/playsegment s` and `/speed s` set
  it to `10/s` (`UI2.as:2205`, `UI2.as:2227`, `UI2.as:2246-2247`). This changes only the real-time tick rate. The
  drag constants are computed once in static initializers with the value 10 (`Config.as:47-55`), so physics does
  not depend on the replay speed.
- **Consequence (FRAME):** `PlayState.enterFrame` drains the three PlayState queues (section 4) once per rendered
  frame, after all ticks of that frame. It does not drain once per tick. Between two consecutive ticks there can
  be 0, 1 or several drains:
  - At `/playtas 1` (10 ms per tick, target frame 8.33 ms), nearly every gap between ticks contains 1 frame
    boundary, sometimes 2. A frame that is late by more than about 1.7 ms puts 2 ticks in one frame, which means 0
    drains between them.
  - At replay speeds above 1 (for example `/playtas 4`, 2.5 ms per tick), several ticks share a frame, so most
    gaps between ticks contain no drain.
  - In frame-advance mode (Shift+C, below), every tick is followed by many idle frames, so the queues are drained
    repeatedly until nothing changes.
  - Draining one queued item is idempotent: `overlaps()` at an unchanged state returns the same result and leaves
    `overlapa..d` unchanged after the first call. So 1 drain and many drains differ only when two or more queued
    items interact.
- **Canonical sim model:** one drain pass after every tick, in the order given in 1.3. Offer
  `drainsPerTick = 0 | 1 | N | fixpoint` as an option, and flag any TAS segment during which a PlayState queue is
  non-empty as "real-time sensitive". The purple-switch queue and the team retry run inside `Player.tick`, so they
  are **DET**.

### 1.2 Tick gate and TAS input (`states/PlayState.as:534-558`)
```
if (KeyBinding.tick.isJustPressed(false) /*Shift+C*/ || TASGlobal.ticksEnabled) {
    TASGlobal.steps = 1;
    if (eetasInput != null && eetasInput.bytesAvailable > 0) TASGlobal.getTASInput = true;
    if (eetasInput != null && eetasInput.bytesAvailable == 0 && !endofTAS) {           // TAS just ran out
        if (isSegment) { ticksEnabled = false; steps = 0; isSegment = false; }         // /playsegment: pause, this tick does not run
        else ticksEnabled = true;                                                     // /playtas: keep running on live keyboard
        endofTAS = true; Config.physics_ms_per_tick = TASGlobal.speedMult;
    }
}
if (ticksEnabled || steps > 0) { ...the tick body (1.3)...; steps--; ... }
```
- While paused, `state.tick()` is still called every frame but does nothing, and `enterFrame` still drains the
  queues every frame. `TASGlobal.ticksEnabled` is a static that starts `true` (`tas/TASGlobal.as:8`) and persists
  across level loads.
- **Input byte decoding** (`tas/TASInput.as:21-34`, `Me.as:35-45`). Each tick in which `getTASInput` is set reads
  exactly one signed byte `b` and computes `m = b - 48`, then jump = `m&1`, left = `(m>>1)&1`, right = `(m>>2)&1`,
  up = `(m>>3)&1`, down = `(m>>4)&1`. The results are `leftdown = -1`, `updown = -1`, `rightdown = +1`,
  `downdown = +1`, and `spacejustdown = spacedown = jump`. Then `horizontal = leftdown + rightdown` and
  `vertical = updown + downdown`, so left+right gives 0 (`Me.as:61-62`).
  - Every byte counts, including CR, LF and spaces. `'\n'` (10) gives `m = -38`, which is left+up+down. `'\r'` (13)
    gives jump+right+up+down. `'P'` (80) gives `m = 32`, which is no buttons.
  - `/record` writes only the bytes 48..79 (`tas/TASInput.as:36-61`), so the jump bit is `spacejustdown || spacedown`.
  - Because replay sets `spacejustdown = spacedown`, the real-time held-jump repeat (`lastJump`, **RT**,
    `Player.as:940-962`) never matters during replay. The recording session itself can differ from its replay when
    jump was held. **The replay is authoritative.**
- The byte is read inside `Player.tick` → `getPlayerInput` (`Player.as:452`) only if `isControlled`
  (`Player.as:1938-1940`). While the player is dead, the byte is still consumed, and the inputs are zeroed
  afterwards (`Player.as:454-459`).
- Byte `i` (0-based) is consumed in the tick where `PlayState.ticks` becomes `ticks0 + i + 1`. After `/reset`,
  `ticks0` is 0. `TASSaveState.load` confirms this indexing: `userInputs.position = levelTime`
  (`tas/TASSaveState.as:428-430`).

### 1.3 Exact order inside one tick (single player, `ticksEnabled`)
| # | where | what | tag |
|---|---|---|---|
| 1 | `PlayState.as:561` → `UI2.as:2381-2436` | UI2.tick: minimap, block bar, P toggles mod mode (fly) | LIVE |
| 2 | `PlayState.as:562` | `ticks++` (the level clock, section 2) | DET |
| 3 | `PlayState.as:564-575` | gate snapshots. `showCoinGate = coins`, reverted if `world.overlaps(player)`. The same for `showBlueCoinGate = bcoins` and `showDeathGate = deaths` (three separate overlaps calls, each with side effects, section 3) | DET |
| 4 | `PlayState.as:578-587` | particles | visual |
| 5 | `PlayState.as:589-654` | screenshot prompts, camera keys | LIVE, visual |
| 6 | `PlayState.as:656-669` | G toggles god mode (needs `Bl.data.canToggleGodMode`), `resetDeath()` | LIVE |
| 7 | `PlayState.as:675-682` | Shift+R retry in trials mode (`getTimer`) | LIVE, RT |
| 8 | `PlayState.as:684-790` | mouse editing (`placeBlock` → `setTile` → `PlayState.tilequeue`) | LIVE |
| 9 | `PlayState.as:791-792` | `steps--`, then `playerOverlaps()` (tagging between players; a no-op with one player, `PlayState.as:940-970`) | DET |
| 10 | `PlayState.as:793` → `blitter/BlContainer.as` `tick` | for each child in insertion order: `world.tick()`, then fake players, then `player.tick()` | |
| 10a | `World.as:137-156` | `World.update`: `offset += .3` (visual only in eeo-tas). Particles. `setTimedoor((ticks/100) % 10 >= 5)` (section 6). For each key color that is on with `(ticks - keysTimer[c])/100 >= 5`: `playState.switchKey(c, false)` (section 5) | DET |
| 10b | `Player.as:381-1180` | `Player.tick` (1.4) | DET, except portals (RND) |
| 10c | `blitter/BlContainer.as` `tick` | camera lerp (`Config.camera_lag`) | visual |
| — | frame boundary | `PlayState.enterFrame` (`PlayState.as:478-526`): (i) drain `queue` (orange switches, crown, silver crown), (ii) drain `keysquene`, (iii) drain `tilequeue` (block edits) | FRAME |

### 1.4 Order inside `Player.tick` (state-relevant steps only)
1. `animoffset += .2`, mod/aura offsets (visual) (`Player.as:384-392`).
2. `deadoffset`: `+= .3` if `isDead`, else `= 0` (`Player.as:395-396`).
3. If not dead, the timed-effect kills in this order: curse, zombie, fire, poison (`Player.as:399-404`, section 11).
4. `cx = (x+8)>>4`, `cy = (y+8)>>4` (members since eeo-tas). `delayed = queue.shift()`, `current = tile(cx,cy)`,
   plus the half-block adjustment (`Player.as:406-419`).
5. **Team retry:** `if (tx != -1) UpdateTeamDoors(tx, ty)` (`Player.as:421`, section 12).
   - The later `var tx:Number` and `var ty:Number` at `Player.as:1012` and `Player.as:1029` do **not** shadow this
     line. I disassembled `Player.tick` in the compiled `C:\Users\super\Downloads\EE_Offline.swf` (the original
     EEO, same source line). Offset 743 is `getlocal0; getproperty private::tx`, which is the member. The locals
     live in activation slots 27 and 28. eeo-tas was not available compiled. If its compiler resolved the name to
     the hoisted local instead (NaN → `UpdateTeamDoors(0,0)` every tick), teams would reset every tick. A one-room
     team-door test in eeo-tas settles it.
6. `current_below`, then `queue.push(current)`, and a second shift+push on dots 4/414 and climbables
   (`Player.as:423-447`).
7. **Drain `Player.tilequeue`** (purple-switch retries): `n = length; while (n--) tilequeue.shift()()`
   (`Player.as:449-450`).
8. `getPlayerInput()` reads the TAS byte (`Player.as:452`). If dead, the inputs are zeroed (`Player.as:454-459`).
9. Gravity and modifiers. Spikes, fire tiles and toxic waste call `killPlayer()` if not dead and not
   invulnerable (`Player.as:529-557`). Zombie changes `speedMultiplier` (`Player.as:363-369`).
10. Drag and boosts. If dead, the speeds are zeroed (`Player.as:827-830`), so there is no movement in the death
    tick or in any later dead tick.
11. The sub-step movement loop with `processPortals` (`Player.as:924-935`, `Player.as:1051-1174`). Multi-target
    portals pick with `Math.random` (`Player.as:1046-1049`, `Player.as:1099`, **RND**).
12. If not dead: the jump logic (jumps are disabled while levitating), `touchBlock(cx, cy, isgodmod)`
    (`Me.as:74-358`, sections 5-12), `sendMovement` (network leftover, no state effect) (`Player.as:937-995`).
    Levitation `isThrusting` is set only inside this block (`Player.as:946-965`).
13. `if (hasLevitation) updateThrust()`. This runs **even while dead** (`Player.as:998-1000`).
14. Auto-align to the grid (`Player.as:1004-1042`). It still applies while dead.
15. `updateStuff()`: the run timer (`Me.as:374-376`, section 9).
16. **Respawn:** `if (deadoffset > 16) { respawn(); deaths++; }` (`Player.as:1176-1179`, section 10).
    - eeo-tas moved this here from `draw()` (`eeo:Player.as:1317-1321`, which was frame based). It now runs
      **before** the frame's queue drains.

---------------------------------------------------------------------------------------------------------------

## 2. Clocks

| clock | type, where | reset by | used by | tag |
|---|---|---|---|---|
| `PlayState.ticks` ("level time") | int, `PlayState.as:532`, `++` at `PlayState.as:562` | new level (0) and `/reset` (`UI2.as:1703`). **Not** reset by `resetPlayer`, death, respawn or `/loadlevel` | key timers, time doors, timed effects, fire animation | DET |
| `Me.ticks` ("run timer", shown as "Time") | int, `Me.as:15`, `Me.as:375` | `resetPlayer()` when `worldSpawnID == -1` (`Player.as:1282-1285`) | the run time, campaign trials (`UI2.as:735`) | DET |
| `World.offset` | Number, `World.as:91`, `+= .3` at `World.as:138` | never | coin and wave animation only. In the original EEO it drove keys and time doors (`eeo:World.as:120-156`); eeo-tas no longer uses it for them | visual |
| `lastJump` | Number, `Player.as:275`, Date based | `-Date` at construction | held-jump repeat (750 ms first, then 150 ms) | RT, never matters in replay |
| `last_respawn` | `Player.as:197`, `Player.as:1253` | respawn | `getCanBeTagged` (multiplayer only) | RT |
| `PlayState.pastT`, `lastRetry` | `PlayState.as:530`, `PlayState.as:676` | | editing, trials retry | RT, LIVE |

`/fps` (DebugStats) shows `Time = player.ticks/100` s and `Level time = state.ticks/100` s (`ui/DebugStats.as:73-74`).

---------------------------------------------------------------------------------------------------------------

## 3. `World.overlaps(player)`: the guard every event uses

`World.as:604-751` returns 1 when the 16x16 box is outside `[0, 16W-16] x [0, 16H-16]`. This test comes before the
god-mode test, so god mode still collides with the world edge. Otherwise it returns 0 when `isFlying`, and
otherwise the id of the first blocking tile in scan order (rows `cy` outer, columns `cx` inner), or 0.

**Side effects** (they are state, and the sim must reproduce them wherever `overlaps` is called):
- `overlapa..overlapd` (the one-way platform memory) are updated when a one-way tile is skipped
  (`World.as:636-688`). When it returns 0 without skipping, the unskipped ones are reset to -1
  (`World.as:746-749`). An early `return val` leaves them untouched.
- `lookup.setSecret` for 243 and 50 (`World.as:628-630`, `World.as:737-739`). This is visual only.

**State read by the door switch** (`World.as:691-741`). Each entry is "passable when ..."; otherwise the tile
blocks:

| tiles | passable when |
|---|---|
| 23, 24, 25 (red/green/blue key doors) | the key is on |
| 26, 27, 28 (gates) | the key is off |
| 1005-1007, 1008-1010 | the same for cyan, magenta, yellow |
| 156 time door | `timedoorState` |
| 157 time gate | `!timedoorState` |
| 184 purple door | `player.switches[id]` |
| 185 purple gate | `!player.switches[id]` |
| 1079 orange door | `world.orangeSwitches[id]` |
| 1080 orange gate | `!world.orangeSwitches[id]` |
| 200 gold door | `wearsGoldSmiley` |
| 201 gold gate | `!wearsGoldSmiley` |
| 1094 crown door | `collideWithCrownDoorGate` |
| 1095 crown gate | `!collideWithCrownDoorGate` |
| 1152 silver door | `collideWithSilverCrownDoorGate` |
| 1153 silver gate | `!collideWithSilverCrownDoorGate` |
| 43 coin door | `n <= coins` (live value) |
| 213 blue coin door | `n <= bcoins` (live value) |
| 1011 death door | `n <= deaths` (live value) |
| 165 coin gate | `n > showCoinGate` (snapshot value) |
| 214 blue coin gate | `n > showBlueCoinGate` (snapshot value) |
| 1012 death gate | `n > showDeathGate` (snapshot value) |
| 1027 team door | `team == n` |
| 1028 team gate | `team != n` |
| 206 ZOMBIE_GATE | `!zombie` |
| 207 ZOMBIE_DOOR | `zombie` |

Here `n = lookup.getInt(cx,cy)`, which is 0 when absent (`Lookup.as:70-73`). The `zombie` getter returns false
while flying (`Player.as:1680-1684`). The snapshot values for coin, blue coin and death gates apply only because
`pl.isme` is true (`World.as:727-729`).

**The deferred-write pattern.** Every event that changes something `overlaps` reads first writes the new value,
then calls `world.overlaps(player)`. If the result is non-zero, it restores the old value and schedules a retry.
Any solid overlap blocks the change, not only the door that changed. For example, a player stuck inside a closed
time door (time doors change **without** this check, section 6) cannot pick up keys, press switches or change
team until they get out. The call sites are:

| call site | retry mechanism |
|---|---|
| `PlayState.switchKey` (`PlayState.as:219-225`) | `keysquene`, per frame |
| `PlayState.pressOrangeSwitch` (`PlayState.as:227-237`) | `queue`, per frame |
| `PlayState.checkCrown` (`PlayState.as:239-245`), `checkSilverCrown` (`PlayState.as:256-262`) | `queue`, per frame |
| `Player.pressPurpleSwitch` (`Player.as:1570-1581`) | `Player.tilequeue`, per tick |
| `Player.UpdateTeamDoorsById` (`Player.as:1590-1604`) | member `tx/ty`, per tick |
| gate snapshots (`PlayState.as:564-575`) | none: the old value stays until a later tick succeeds |
| `PlayState.setTile` (`PlayState.as:465-472`) | editing only |

---------------------------------------------------------------------------------------------------------------

## 4. Deferred queues

| queue | owner and type | filled by | drained | cleared by |
|---|---|---|---|---|
| `queue` | `PlayState.as:271`, Array of closures | `pressOrangeSwitch(id, en)`, `checkCrown(c)`, `checkSilverCrown(c)` | `PlayState.enterFrame` (`PlayState.as:498-501`), **per frame** | never (not by respawn or reset) |
| `keysquene` | `PlayState.as:272`, Array of `{color, state}` | `switchKey` | `PlayState.as:503-507`, per frame, after `queue`. It calls `switchKey(color, state, fromqueue=true)` | never |
| `tilequeue` | `PlayState.as:273`, Array of Tile | block editing | `PlayState.as:509-513`, per frame, last | `/loadlevel`, `/clear`, `/resize` |
| `Player.tilequeue` | `Player.as:223`, Array of closures | `pressPurpleSwitch` | inside `Player.tick` (`Player.as:449-450`), **per tick** | `respawn()` (`Player.as:1255`) |
| team retry `tx,ty` | `Player.as:278-279` (int, -1 = none) | `UpdateTeamDoors` | `Player.as:421`, per tick | set to -1 on success (`Player.as:1600-1603`) |
| `Player.queue` | `Player.as:274`, `Vector.<int>(2)`, starts `[0,0]` | delayed-tile physics | `Player.as:409-447` | never (not by respawn or reset) |

- Every drain takes `n = length` first, then pops `n` items (`while (n--) q.shift()()`). Items re-queued during
  the drain wait for the next drain.
- A closure re-executes the whole call with its captured arguments, including the recursion over switch id 1000.
- No queue is part of a `TASSaveState`. They also survive `/reset`, so the canonical start (section 13) needs them
  empty.

---------------------------------------------------------------------------------------------------------------

## 5. Keys (6 colors)

**State:**
- `World.keys[color]`: SecureBoolean (`World.as:93-100`).
- `World.keysTimer[color]`: int, initially 0 (`World.as:102-109`).
- The colors are red, green, blue, cyan, magenta and yellow, from tiles 6, 7, 8, 408, 409 and 410 (`Me.as:17-24`).

**`World.setKey(color, state, fromqueue)`** (`World.as:117-123`):
```
if (fromqueue && ((ticks - keysTimer[color]) / 100) >= 5) return;     // queued retry that is 500+ ticks old: dropped
keys[color] = state;
if (state == true && !fromqueue) keysTimer[color] = ticks;
```
`(a/100) >= 5` is exactly `a >= 500` for integer `a`. I checked this in doubles for `a` in `[0, 2e6)`.

**`PlayState.switchKey(color, state, fromqueue=false)`** (`PlayState.as:219-225`):
```
world.setKey(color, state, fromqueue);
if (world.overlaps(player)) { world.setKey(color, !state /* fromqueue=false! */); keysquene.push({color, state}); }
```

**Events:**
- **Pickup:** touching a key tile, just-entered only, not in god mode, not dead (`Me.as:242-250`), calls
  `switchKey(c, true)`. The key turns on and `keysTimer = ticks`.
  - If that makes the player overlap (for example standing in the matching gate 26-28), the key is set back off,
    `keysTimer` **keeps** the new stamp, and `{c, true}` is queued.
  - Each retry is `setKey(c, true, fromqueue)`. It is dropped once 500 ticks have passed since the stamp.
    Otherwise it turns the key on without re-stamping. If it overlaps again, the key is set off and re-queued.
  - Touching a key tile again while the key is on re-stamps the timer, which extends it.
- **Expiry:** in `World.update` of tick `t`, which runs before the player moves (`World.as:149-153`), every key
  with `on && t - keysTimer >= 500` calls `switchKey(c, false)`.
  - If the key turning off would make the player overlap (the player is standing in the key's door area), it is
    set back on with `setKey(c, true, false)`, which **re-stamps `keysTimer = t`**, and `{c, false}` is queued.
  - Every frame the retry `setKey(c, false, true)` runs. It is not dropped because the timer was just re-stamped,
    so the key turns off as soon as the retry happens while the player does not overlap.
  - The re-stamp also means the `World.update` expiry does not fire again for 500 ticks.
- **Exact timing (DET):** a key picked up (or re-stamped) during tick `p` is on from the end of tick `p` (after
  touchBlock) and turns off at the start of tick `p + 500`, before that tick's player movement. So the key is on
  for the movement of ticks `p+1 .. p+499`: its doors are open and its gates are solid. The original EEO used
  `World.offset += 0.3` with `/30 >= 5`, which gave 500 or 501 ticks; eeo-tas does not.
- **Iteration order:** the expiry loop is `for (color in keys)` over an Object, so the AVM2 hash order is
  unspecified. It matters only when two keys expire in the same tick and at least one is deferred. The
  recommended order is red, green, blue, cyan, magenta, yellow.
- **Not reset** by death, respawn, `resetPlayer`, `/reset` or `/loadlevel` (same World object). Only a newly
  loaded level (a new PlayState and World) starts with all keys off and all timers 0.
- **After `/reset`:** the timers keep old absolute values while `ticks` restarts at 0. A key that was on at reset
  time stays on until `ticks - keysTimer >= 500`. Precondition for a TAS: no key is on at `/reset`.

---------------------------------------------------------------------------------------------------------------

## 6. Time doors (156 door, 157 gate)

- `World.update` at tick `t` sets `timedoorState = ((t/100) % 10) >= 5` (`World.as:147`). In doubles this equals
  `(t % 1000) >= 500` for all `t >= 0` (checked for `t` in `[0, 2e6)`).
  - `t % 1000` in 0..499: the state is false. Door 156 is solid and gate 157 is passable.
  - `t % 1000` in 500..999: the state is true. Door 156 is passable and gate 157 is solid.
- The state is an **absolute** function of the level clock (reset only by `/reset` and by loading a level). The
  original EEO toggled relative to `hideTimedoorOffset` with float drift (`eeo:World.as:126-153`).
- The gate snapshot checks of tick `t` (step 3 in 1.3) run **before** `World.update`, so they see the state of
  tick `t-1`. In the first tick after `/reset` they see the value from before the reset.
- There is **no overlap check**, so a door can close on the player, who is then stuck until it opens. Every other
  event is deferred while they are stuck (section 3).
- The door art uses `(ticks/100 >> 0) % 5` (`World.as:1060-1064`), which is visual only.
- Because the timer starts at the first input (section 9), a TAS can idle before its first input to shift the
  door phase for free.

---------------------------------------------------------------------------------------------------------------

## 7. Switches

**Purple** (per player: `Player.switches:Object`, `Player.as:195`). Tiles: switch 113, reset 1619, door 184,
gate 185. The switch id is `lookup.getInt`.
- The switch tile (just-entered, not god mode, alive) calls `pressPurpleSwitch(sid, !switches[sid])`
  (`Me.as:162-166`).
- The reset tile calls `pressPurpleSwitch(rsid, false)` if `rsid == 1000 || switches[rsid]` (`Me.as:173-178`).
- `pressPurpleSwitch(id, en)` (`Player.as:1570-1581`):
  - if `id == 1000`, it first recurses for 0..999;
  - then it sets `switches[id] = en`;
  - if `overlaps`, it restores `!en` and queues a closure on `Player.tilequeue`, which is retried at step 7 of the
    next `Player.tick`.
- `respawn()` clears `Player.tilequeue`, which drops pending purple retries. `resetPlayer` sets `switches = {}`.

**Orange** (global: `World.orangeSwitches:Object`, `World.as:129`). Tiles: switch 467, reset 1620, door 1079,
gate 1080.
- Same logic via `PlayState.pressOrangeSwitch` (`PlayState.as:227-237`, `Me.as:167-171`, `Me.as:179-184`).
- Retries go to `PlayState.queue` (per frame, **FRAME**).
- Orange state is **not** reset by death, respawn, `resetPlayer` or `/reset`. It is reset only by
  `/loadlevel` and `/clear` (which replace it with a ByteArray: same truthiness, `UI2.as:1696`, `UI2.as:1752`) or by
  loading the level again.

**Id 1000:** a press with id 1000 sets all of ids 0..999 **and** 1000 itself. Doors and gates whose id is 1000 read
entry 1000. Reads of unknown ids are falsy.

---------------------------------------------------------------------------------------------------------------

## 8. Coins, coin doors/gates, death doors/gates

- **Collect** (`Me.as:80-124`). This is not limited to just-entered cells and also works in god mode. It does not
  happen while dead, because touchBlock does not run.
  - If `current` is 100 or 101, `world.setTileComplex(0,cx,cy,current+10)`: the tile becomes 110 or 111 and every
    lookup entry of that cell is deleted.
  - Then `coins++` or `bcoins++`, and `(cx,cy)` is appended to `gx/gy` or `bx/by`.
  - Tiles 110 and 111 do nothing.
- **Door** (43 coin, 213 blue, 1011 death): compared with the **live** counter every time `overlaps` runs.
- **Gate** (165 coin, 214 blue, 1012 death): compared with `showCoinGate`, `showBlueCoinGate` and `showDeathGate`.
  These are copied from the counters at step 3 of each tick. Each copy is reverted, and so stays at the old value
  across ticks, while the new value would make the player overlap (`PlayState.as:564-575`). They start at 0 (or
  whatever they held before `/reset`) and must be snapshot state.
- Coins **persist through death**. `resetPlayer` zeroes the counters, turns every 110/111 back into 100/101
  (`World.as:402-409`) and clears `gx..by`.
- `totalCoins` and `bonusCoins` are UI only.

---------------------------------------------------------------------------------------------------------------

## 9. Crowns, completion and the run timer

**Gold crown** (tile 5; just-entered, not god mode, alive; `Me.as:153-160`), only `if (!hascrown)`:
1. `PlayState.removeCrown()` (`PlayState.as:247-254`): `hascrown = false`, then `checkCrown(false)`.
2. `hascrown = true`.
3. `checkCrown(true)`.

`checkCrown(c)` sets `collideWithCrownDoorGate = c`. If that overlaps, it restores `!c` and queues
`checkCrown(c)` (per frame). So `hascrown` and `collideWithCrownDoorGate` can differ while a retry is pending, and
both are state.

**Silver crown / trophy** (tile 121; just-entered, not god mode, alive; `Me.as:205-217`), only
`if (!hascrownsilver && !resetSend)`:
1. `hascrownsilver = true`.
2. `completed = true`.
3. `checkSilverCrown(true)` (deferred like the gold crown).
4. `Global.ui2.completeLevel()`. This only shows a win overlay if `/winscreen` is on (`UI2.as:723-770`). The game
   keeps ticking.

`resetSend` is only set by world portals, which need the Y key (section 14), so it is always false in a replay.
Only the first trophy counts.

**Run timer** (`Me.as:374-376`), at step 15 of every tick:
```
if (isControlled) if (!completed && (ticks || horizontal || vertical || spacedown)) ticks += 1;
```
`horizontal` and `vertical` are the values after zeroing on death and summing left+right and up+down.

**What ends a run.** Nothing stops the game. A TAS run is complete at the tick `t_c` in which touchBlock sets
`completed`. Let `t_s` be the first tick whose step 15 sees a non-zero input (not while dead). Then the run time is
`Me.ticks = t_c - t_s`:
- ticks `t_s .. t_c-1` are counted, and the completion tick is not;
- ticks before `t_s` are free, and the player still falls and moves during them;
- the level time is `PlayState.ticks = t_c`.

The optimizer objective is `t_c - t_s`, not `t_c`. The `.eetas` usually continues past `t_c`. After the last byte,
`/playtas` hands control to the keyboard and `/playsegment` pauses (1.2).

---------------------------------------------------------------------------------------------------------------

## 10. Death and respawn

**Causes** (`killPlayer`, `Player.as:1202-1210`: sets `isDead` only if `!isFlying && !isDead`; picks a random
death animation with `Math.random`, **RND**, visual only):
- `current` is toxic waste 1585 (`Player.as:529-535`), or fire 368 or any spike or spike-center tile
  (`Player.as:537-557`), provided the player is not dead and not invulnerable. `current` is the tile under the box
  center at the start of the tick.
- A timed-effect timer runs out at step 3 (section 11).
- `/kill` (LIVE).

**Timeline** (for death during tick `T`, at step 3 or step 9):
- Tick `T`: speeds are zeroed at step 10, so there is no movement. touchBlock and the jump logic are skipped.
  `deadoffset` stays 0 in `T` because step 2 already ran.
- Ticks `T+1 ..`: `deadoffset += 0.3` at step 2. The inputs are consumed but zeroed. Speeds are zeroed before
  movement. Still active while dead: the delayed queue, the purple and team retries, `slippery`, grid alignment
  (x can still creep toward the grid, because `_modifierX` is about 0 in normal gravity), the levitation thrust
  update, and key expiry. The run timer keeps running once started, but it cannot start while dead.
- The float sum of 0.3 first exceeds 16 after **54** additions (16.200000000000017). So at the end of tick
  **`T+54`**, `respawn()` runs and then `deaths++` (`Player.as:1176-1179`). The death gate snapshot sees the new
  count at step 3 of `T+55`. A death door sees it immediately.

**`respawn()`** (`Player.as:1240-1263`):
- zeroes `_modifierX/Y` and `_speedX/Y`;
- sets `isDead = false`, `deathsend = false`, `isOnFire = false`, `resetSend = false`;
- sets `last_respawn` (RT, multiplayer only);
- sets `tilequeue = []` (drops pending purple retries);
- calls `placeAtSpawn(true)`, which uses the checkpoint if set, otherwise the next spawn in the cycle (section 13);
- calls `setEffect(curse|zombie|fire|poison, false)`.

**Not changed by death or respawn:**
- deaths (incremented after respawn), coins and collected coin tiles, keys and their timers, purple and orange
  switches, crowns and the collide flags;
- team and `tx/ty`, the checkpoint, jump boost, speed boost, protection, low gravity, multijump, flip gravity,
  levitation and thrust;
- `jumpCount`, `slippery`, `Player.queue`, `pastx/pasty`, `ox/oy`, `overlapa..d`, `lastPortal`;
- the PlayState queues, `nextSpawnPos` (advanced by `placeAtSpawn`), the level clock and the run timer.

**Subtle:** `pastx/pasty` still hold the cell where the player died, so the respawn cell counts as "just entered"
unless it is that same cell.

**`resetPlayer(load=false, clear=false, worldSpawnID=-1)`** (`Player.as:1265-1297`, used by `/reset`, `/resetall`,
the reset tile 466, world portals and `/loadlevel`):
- Returns immediately if flying (unless `load` or `clear`).
- Otherwise:
  - clears both crowns via `checkCrown(false)` and `checkSilverCrown(false)` (possibly queued), then forces both
    collide flags to false;
  - sets `deaths = 0`, `coins = bcoins = 0` and `resetDeath()`;
  - calls `resetEffects()`, which clears static and timed effects;
  - resets the checkpoint to -1, sets `switches = {}` and `team = 0`;
  - sets `Me.ticks = 0` (if `worldSpawnID == -1`) and `completed = false`;
  - calls `world.resetCoins()` and clears `gx..by`;
  - resets secrets (visual) and the map flag (UI);
  - finally calls `respawn()`.
- It does **not** reset: keys and timers, orange switches, the PlayState queues, `Player.queue`, `jumpCount`,
  `slippery`, `pastx/pasty`, `ox/oy`, `overlapa..d`, `lastPortal`, `tx/ty`, `isThrusting`, `nextSpawnPos` or the
  level clock.

---------------------------------------------------------------------------------------------------------------

## 11. Timed and static effects (state side)

`setEffect(id, active, arg=0, duration=0)` (`Player.as:1724-1798`):
```
if (duration > 0) { if (!arg) arg = state.ticks; duration += 2 * Global.ping; duration *= 100; }   // ping = 0.2 const (Global.as:166-169)
```
Timed effects store `xTimeStart = arg` and `xDuration = duration` when activated. Deactivating clears only the flag.
All effect tiles below act only when just entered, not in god mode, and alive (`Me.as:253-348`).

| tile | condition | action |
|---|---|---|
| 417 jump | value `v` = `lookup.getInt` | if different: `jumpBoost = v` (0 none, 1 ×1.3, 2 ×0.75) |
| 419 run | `v` | if different: `speedBoost = v` (1 ×1.5, 2 ×0.6) |
| 453 low gravity | `v` truthy | `low_gravity = v` (gravity ×0.15) |
| 461 multijump | `v` | if different: `maxJumps = v` (1000 or more = infinite) |
| 1517 gravity | `v` | if different: `flipGravity = v` |
| 418 fly | `v` truthy | `hasLevitation = v`. Setting false also zeroes `_currentThrust` (`Player.as:1838-1844`) |
| 420 protection | `v` truthy, if different | `isInvulnerable = v`. If on: also turns off curse, zombie, poison and fire |
| 1618 effect reset | | `resetEffects(false)`: every static effect off (jump 0, fly false with thrust 0, run 0, protection off, low gravity off, `maxJumps = 1`, `flipGravity = 0`). Timed effects are **kept** |
| 421 curse | `on = v > 0`; skip if `cursed == on` or invulnerable | `cursed = on`. If on: `curseTimeStart = ticks`, `curseDuration = (v + 0.4) * 100` |
| 422 zombie | same with `zombie` | the same fields for zombie |
| 1584 poison | same with `poison` | the same fields for poison |
| 1573 NPC zombie | skip if zombie or invulnerable | `zombie = true` with duration 0: **permanent**, never kills |
| 416 lava | skip if on fire or invulnerable | `isOnFire = true`, `fireTimeStart = ticks`, `fireDuration = (2 + 0.4) * 100 = 240` exactly |
| 119, 369, 1585 water, mud, toxic | if on fire | `isOnFire = false` |

Touching a curse, zombie or poison tile with `v > 0` while already under that effect does **not** refresh the
timer.

**Kill check** (step 3, `Player.as:399-404`), in tick `t` while not dead:
```
if (cursed  && curseDuration  && t - curseTimeStart  > curseDuration)  kill
if (zombie  && zombieDuration && t - zombieTimeStart > zombieDuration) kill      // zombie getter is false while flying
if (isOnFire&& fireDuration   && t - fireTimeStart   > fireDuration)   kill
if (poison  && poisonDuration && t - poisonTimeStart > poisonDuration) kill
```
- Compute the duration exactly as `d = v; d += 0.4 /* = 2*0.2 */; d *= 100` in doubles. Do not use `100*v + 40`.
- The kill happens at elapsed `L = t - start >= floor(d) + 1`. That is `100v + 41` except for `v` in 16..20 and
  256..327, where `d` rounds just below the integer and the kill comes one tick earlier, at `100v + 40`.
- Lava ignites at the end of tick `p`; the burning player dies at the start of tick `p + 241`.
- eeo-tas replaced the original wall-clock timers (`eeo:Player.as:388-393`) with these tick-based ones.

**Effects on physics:**
- `jumpMultiplier` (`Player.as:354-361`): ×1.3 or ×0.75 from the jump boost, ×0.75 if **zombie**, ×0.88 if
  `slippery > 0`.
- `speedMultiplier` (`Player.as:363-369`): ×1.5 or ×0.6 from the run boost, ×0.6 if **zombie**.
- `gravityMultiplier` (`Player.as:347-352`): ×0.15 if low gravity, times the world multiplier (section 15).
- Zombie doors and gates (section 3).
- Levitation: jumping is disabled; `spacedown` sets `isThrusting = true` and `_currentThrust = 0.2`
  (`Player.as:946-965`); `updateThrust` runs every tick while levitating, dead or alive (`Player.as:1846-1861`).
- Curse and poison have no physics effect besides the kill timer.
- Death clears curse, zombie, fire and poison. `resetPlayer` clears everything.

**Tagging:** `playerOverlaps` transfers curse and zombie between players; it is a no-op with one player.

---------------------------------------------------------------------------------------------------------------

## 12. Teams (423 effect, 1027 door, 1028 gate)

- **Touching 423** (just-entered, not god mode, alive; `Me.as:320-323`) calls `UpdateTeamDoors(cx,cy)`
  (`Player.as:1583-1588`). That sets `tx = cx`, `ty = cy` and `id = lookup.getInt(cx,cy)` (0..6), then calls
  `UpdateTeamDoorsById(id, false)` (`Player.as:1590-1604`):
  ```
  if (team == id) return;                           // NOTE: tx,ty stay set (a harmless no-op retry every tick)
  oid = team; team = id;
  if (hitmap.overlaps(player)) team = oid;          // stays pending: tx,ty retried at Player.as:421 each tick
  else tx = ty = -1;
  ```
- The retry at step 5 of every tick re-reads the lookup at `(tx,ty)`, even long after the player left that tile,
  and even after death: respawn does not clear it. When the retry calls `overlaps`, that has the usual side effects.
- `team` is **not** reset by death. `resetPlayer` sets `team = 0` but not `tx`. So a stale `tx` whose tile id
  differs from 0 re-applies the old team on the next tick after `/reset`. Precondition: `tx == -1` at the start.
- **Team doors:** 1027 is passable iff `team == n`; 1028 is passable iff `team != n`.
- `/setteam` forces the change (LIVE command, `UI2.as:1759-1804`).

---------------------------------------------------------------------------------------------------------------

## 13. Checkpoints, spawn points and the start state

**Checkpoint** (360; just-entered, not god mode, alive; `Me.as:200-203`): sets `checkpoint_x = cx`,
`checkpoint_y = cy` (tile coordinates, after the half-block adjustment). There is no deferral. It persists through
death. `resetPlayer` sets it to -1.

**Spawn list** (`World.as:359-366`, while the level loads):
- Every entry of a tile group of type 255 (spawn) or 1582 (world-portal spawn), on either layer, is appended in
  **file order** to `spawnPoints[rotation]`. 255 has no extra data, so `rotation = 0`. For 1582 it is the spawn id.
- So `spawnPoints[0]` = every 255 plus every 1582 with id 0, ordered by group order in the file, then entry order
  inside each group.
- Entries with `x >= W` or `y >= H` are skipped. A spawn entry stays in the list even if a later group overwrites
  the tile.
- EEO's own `/save` writes groups in `for-in` order of an Object (`DownloadLevel.as:127-152`), so the order must be
  read from the file, never recomputed from the tile map.

**`placeAtSpawn(checkpoint)`** (`Player.as:1212-1238`):
```
nx = ny = 1
if (checkpoint && checkpoint_x != -1) { nx,ny = checkpoint }
else if (spawnPoints.length > 0) {
    if (!spawnPoints[worldSpawn]) spawnPoints[worldSpawn] = [];
    id = spawnPoints[worldSpawn].length > 0 ? worldSpawn : 0;
    if (!nextSpawnPos[id] || nextSpawnPos[id] >= spawnPoints[id].length) nextSpawnPos[id] = 0;
    if (spawnPoints[id].length > 0) { nx,ny = spawnPoints[id][nextSpawnPos[id]]; nextSpawnPos[id]++; }
}
x = nx*16; y = ny*16;      // no spawn: (16,16)
```
- `worldSpawn` is 0 for normal loads (`ui/campaigns/CampaignPage.as:673`, `EverybodyEdits.as:499-501`). It changes
  only through world portals.
- The cycle index `nextSpawnPos` advances on **every** use: the level load, every respawn without a checkpoint,
  and `/reset`. `/resetall` and `/loadlevel` clear it (`UI2.as:1707`, `UI2.as:1665`).

**How a TAS starts:**
1. Loading the level (`PlayState.as:99-192`) creates a fresh World and Player, calls `placeAtSpawn()` (which uses
   spawn **#0**, so next = 1) and sets `ticks = 0`. `ticksEnabled` keeps its previous value, which is true on a
   fresh start, so the game runs live.
2. `/reset` (`UI2.as:1701-1705`) calls `resetPlayer()` and `respawn()`. Without a checkpoint that uses spawn
   **#(1 % count)**, which is the second spawn when there are two or more. It then sets `ticks = 0` and pauses.
3. `/loadtas` then `/playtas s`. The first tick is `PlayState.ticks = 1` and consumes byte 0.

The canonical start state `S0` for a sim (fresh load, then `/reset`, with no deaths in between) has:
- **World:** tiles from the file, all coins uncollected, all keys off with timers 0, no orange switches, empty
  PlayState queues, `ticks = 0`.
- **Player position and motion:** the spawn at index `startSpawn = 1 % n` (or 0 with no `/reset`, or with
  `/resetall`), or `(16,16)` when there is no spawn. Speeds and modifiers 0, not dead. `deadoffset`: 0.
- **Player counters and flags:** deaths, coins, `Me.ticks` and team all 0; `completed = false`; no crowns and both
  collide flags false; `switches = {}`; `tx = ty = -1`; checkpoint `(-1,-1)`.
- **Effects:** all default: `maxJumps = 1`, `flipGravity = 0`, thrust 0, not thrusting, no curse, zombie, poison or
  fire.
- **Leftovers from before the reset:** these fields survive `/reset` (`Player.as:1265-1297` does not touch them),
  so they can hold pre-reset values. Their fresh-load values are:
  - `jumpCount = 0` and `slippery = 0`;
  - `Player.queue = [0,0]`;
  - `pastx = pasty = 0`;
  - `ox = oy = 0` (field initial values, `Player.as:291-294`; not the spawn position);
  - `overlapa..d = -1`;
  - `lastPortal` non-null (`new Point()`, `Player.as:300`);
  - `showCoinGate = showBlueCoinGate = showDeathGate = 0`;
  - `timedoorState` from the old clock.

  A real `/reset` inherits these from the ticks run before it. They are harmless if the player stood still on
  plain default-gravity, non-ice tiles, away from one-way tiles, and touched no key, switch, team block or crown.
  List this as a precondition, or make each field a start parameter.
- **God mode:** if the player is in god mode at `/reset`, `resetPlayer` returns immediately. Precondition: god
  mode is off.

---------------------------------------------------------------------------------------------------------------

## 14. God mode, mod mode, gold border, reset tile, world portals, god and map blocks

- **`isFlying = isInGodMode || isInModMode`** (`Player.as:1897-1899`). While flying:
  - no gravity and no drag switches (`isgodmod`);
  - `overlaps` returns 0 except for the world bounds, and no deaths;
  - touchBlock still runs: coins are collected and `pastx/pasty` still update, but effects, crowns, switches, keys
    and checkpoints are skipped;
  - the zombie and poison getters return false.

  God mode is toggled with G (LIVE, needs `canToggleGodMode`, `PlayState.as:656-669`) or `/fly` or `/god`. Mod
  mode is toggled with P (LIVE, `UI2.as:2414-2429`). None of this is in `.eetas`, so the sim should keep god mode
  off, or at most provide a test hook.
- **God block 1516** (`Me.as:218-229`) only enables the G key, and **map block 1583** (`Me.as:230-239`) only
  affects the UI. Neither has any physics state.
- **Reset tile 466** (`Me.as:125-128`) acts only while the player holds **Y** (`KeyBinding.risky`,
  `KeyBinding.as:21`), which is LIVE. It is a no-op in a replay.
- **World portal 374** (`Player.as:1057-1085`) also needs Y for the local player, so it is a no-op in a replay.
- **Gold doors and gates 200/201** read `wearsGoldSmiley`, which is the user's gold-border setting
  (`Global.cookie.data.goldBorder`, `EverybodyEdits.as:493`, `PlayState.as:128`). It is a per-run configuration
  value, not a level property. The smiley changes from 241, 337 and 397 are visual; `CAKE` also calls
  `Math.random`.

---------------------------------------------------------------------------------------------------------------

## 15. World gravity multiplier

- The level header reads `data.readFloat()` (`ui/campaigns/CampaignPage.as:608`): a **float32** widened to double.
  It is passed to the PlayState constructor and stored as `player.worldGravityMultiplier` (`PlayState.as:104`,
  `PlayState.as:116`).
- It is used only in `gravityMultiplier` (`Player.as:347-352`):
  `gm = 1; if (low_gravity) gm *= 0.15; gm *= worldGravityMultiplier`. That applies to `mox` and `moy` (the
  delayed-tile gravity, `Player.as:711-712`). It does not apply to `morx/mory`, jumps or buoyancy signs.
- **A header value of 0 means no gravity**. There is no fallback to 1. `/gravity g` (0.1..3) changes it live
  (`UI2.as:1830-1849`).
- All 35 sample levels have 1.

---------------------------------------------------------------------------------------------------------------

## 16. Random and real-time summary

| thing | source | effect on a replay |
|---|---|---|
| multi-target portal exit | `Math.random` (`Player.as:1046-1049`, `Player.as:1099`) | **not reproducible.** The global PRNG is also consumed per frame by particles and water/mud animation (`World.as:1599-1647`), death animations and CAKE. The sim needs a scripted choice (like `rng.js`) |
| PlayState queue drains | frame boundaries (1.1) | FRAME, see the canonical model |
| held-jump repeat | `Date` | irrelevant under replay |
| tagging cooldown | `Date` | multiplayer only |
| reset tile, world portals, god/mod toggles, editing, `/` commands | keyboard, mouse | LIVE, assumed absent |
| key, time-door and effect timers | `PlayState.ticks` | DET (eeo-tas change) |
| respawn delay | `deadoffset` per tick | DET (eeo-tas change) |

---------------------------------------------------------------------------------------------------------------

## 17. eeo-tas save states (`tas/TASSaveState.as`)

**`/state save` never works in this source.** `saveStates` is an empty `Object` (`UI2.as:234`), and
`saveStates[name].save()` (`UI2.as:2121`) calls a method on `undefined` (TypeError), so no slot is ever created.
TASes are therefore always replayed from `/reset`. The field list is still a good inventory of what the authors
considered state:

**World fields:**
- `keysTimer`. Restoring it also calls `setKey(c, timer, true)`, so each key becomes `timer != 0` unless 500 ticks
  have passed. The key booleans themselves are not saved (`tas/TASSaveState.as:286-290`).
- `levelTime` (= `PlayState.ticks`).
- `orangeSwitches`, restored through `pressOrangeSwitch`, so it can be deferred.

**Player fields:**
- `purpleSwitches` (restored through `pressPurpleSwitch`, deferred), `slippery`, `time` (= `Me.ticks`).
- `hascrown` and `hascrownsilver`. The collide flags are re-derived through `checkCrown`, which can be deferred,
  and `completed = hascrownsilver`.
- `gx/gy/bx/by`. The counts and tiles are re-derived through `restoreCoins`, which only counts tiles that are
  100/110 or 101/111.
- `jumpCount`, `maxJumps`, `hasLevitation`, `currentThrust`, `low_gravity`, `speedBoost`, `jumpBoost`,
  `flipGravity`, `isInvulnerable`.
- `cursed`, `zombie`, `isOnFire` and `poison`, each with its start and duration. The duration is restored as
  `d/100 - 0.4` and then turned back into `(x + 0.4)*100`, which can drift by 1 ulp.
- `deaths`, `isDead`, `deadoffset`, `worldSpawn`.
- `x, y`, and `speedx/y`, saved through the **public** getter (`_speedX*7.752`) and restored through the setter
  (`/7.752`). The round trip can change the last bit. The same goes for `modifierX/Y`.
- `checkpointx/y`, `team`, `camx/y` (camera), `tilequeue` (purple closures), `queue`.
- `current`, `current_below`, `morx/mory/mox/moy/mx/my`, `pastx/pasty`, `horizontal/vertical`, `oh/ov` (network
  only), `ox/oy`, `enforceMovement` (network only), `cx/cy`, `donex/doney`, `animoffset` (visual),
  `currentSX/currentSY`.
- `rank` and `writeHead` are unused.

**Save states miss** (and a sim snapshot must include):
- `overlapa..d`, `lastPortal`, `tx/ty`, `isThrusting`;
- the key booleans and the collide flags (only re-derived);
- the three gate snapshots `show*Gate`;
- the PlayState `queue` and `keysquene`, and `nextSpawnPos`;
- `timedoorState` (derived from ticks at the next World.update, but read by step 3 before that).

---------------------------------------------------------------------------------------------------------------

## 18. What the sim state must contain

### 18.1 snapshot() / restore(): every field that is read before it is rewritten in a later tick
- **Level clock and timer:** `ticks` (`PlayState.ticks`), `runTicks` (`Me.ticks`), `completed` (equals
  `hascrownsilver` without save states).
- **Motion:** `x, y, _speedX, _speedY`, `Player.queue[2]`, `slippery`, `jumpCount`, `pastx, pasty`, `ox, oy`,
  `overlapa..d`, `lastPortal != null`.
- **Death:** `isDead`, `deadoffset`, `deaths`, `checkpoint_x/y`, `nextSpawnPos[spawnId]`.
- **Coins:** `coins`, `bcoins`, the collected-coin tile set, `showCoinGate`, `showBlueCoinGate`, `showDeathGate`.
- **Keys and time doors:** `keys[6]`, `keysTimer[6]` (ints, absolute ticks). `timedoorState` as of the last
  World.update: it can be derived from `ticks-1` except in the first tick after the start.
- **Switches:** `switches` (purple) and `orangeSwitches`.
- **Crowns:** `hascrown`, `hascrownsilver`, `collideWithCrownDoorGate`, `collideWithSilverCrownDoorGate`.
- **Team:** `team`, `tx`, `ty`.
- **Static effects:** `jumpBoost`, `speedBoost`, `low_gravity`, `maxJumps`, `flipGravity`, `isInvulnerable`,
  `hasLevitation`, `_currentThrust`, `isThrusting`.
- **Timed effects:** `cursed`, `curseTimeStart`, `curseDuration`; the same three fields for `zombie`, `poison` and
  `isOnFire`.
- **Queues:** `PlayState.queue` (as `[kind, a, b]` records), `keysquene` (`[color, state]`), and
  `Player.tilequeue` (`[id, en]`).
- **RNG state** for portal choices (the sim's model).
- **Per-run constants** (not per-state, but part of the sim configuration): `worldGravityMultiplier` (float32),
  `wearsGoldSmiley`, `worldSpawn`, `startSpawn`, the drain model.

### 18.2 stateKey(): exact "same future" key under eeo-tas semantics
Key everything in 18.1 except absolute clocks. Encode each running timer relative to `ticks`:
- **Active or queued key:** `r = keysTimer - ticks`. Expiry is at `r + 500 <= 0`, and a queued retry is dropped
  when `ticks - keysTimer >= 500`. This is exact, with no 500/501 ambiguity.
- **Time doors,** if the level has 156 or 157: `ticks % 1000`. The phase is absolute, so states at ticks that
  differ modulo 1000 are really different. Include the "first tick" flag if `timedoorState` differs from the
  derived value.
- **Curse, zombie, poison and fire, when active with duration > 0:** the ticks remaining until
  `ticks - start > dur`, which is `start + floor(d) + 1 - ticks`, with `d` computed as in section 11. An active
  effect with duration 0 is a flag only.
- **Run timer started:** `runTicks > 0`.
- **Team fields,** if the level has 423: `team` (only if the level has 1027 or 1028) and the pending retry target
  `(tx != -1 && lookup(tx,ty) != team) ? lookup(tx,ty) : -1`. The retry position matters only through that id.
- **Levitation fields,** if the level has 418: `hasLevitation`, `_currentThrust` and `isThrusting`.
- **Zombie**, if the level has 422 or 1573. **Invulnerability** if the level has 420.
- **Physics fields** as eesim keys them today.

The following are **not** EEO state and need not be keyed; keying them only over-splits: secrets (visual),
`on_ground`, `gravity_dir`, `prev_px/py`, `teleported`, `World.offset`, and the event diff state.

---------------------------------------------------------------------------------------------------------------

## 19. Audit of `tools/tas/eesim.js` (state handling) against this spec

`eesim.js` ports `scripts/physics/ee_sim.gd`, whose header says it ports the **original** EE Offline
(`ee_sim.gd:3`). eeo-tas changed the key, time-door and effect clocks and moved the respawn, so several
differences come from that. Severity: **H** changes outcomes on real levels (sample levels named), **M** affects an
edge case or the start state, **L** is a cleanup or has no behavioral effect.

1. **H: key timers use the old `World.offset` clock.**
   - Where: `eesim.js:626` (`_offset += 0.3`), `eesim.js:631-635` (`(offset - kt)/30 >= 5`), `eesim.js:1528-1533`
     (`_setKey` stamps `kt = _offset`), `key_time_left` (`eesim.js:525-529`).
   - eeo-tas: `World.as:117-123` and `World.as:149-153` use integer `ticks`: `kt = ticks`, expiry at
     `ticks - kt >= 500`, retry dropped at the same bound.
   - Effect: eesim keys last 500 **or 501** ticks (65.9% / 34.1% of start ticks); eeo-tas keys last exactly 500.
     Almost every sample level has keys (Odyssey, FV, RR, Ment, Are You A God, Occult, Spidey, Torava, ...).
2. **H: time doors toggle relative to the offset clock.**
   - Where: `eesim.js:627-630`.
   - eeo-tas: absolute `timedoorState = (ticks % 1000) >= 500` (`World.as:147`). eesim toggles at ticks
     501, 1001, 1501, 2002, 2503, 3004, ... where eeo-tas toggles at 500, 1000, 1500, 2000, ...
   - Sample levels: Edge Of Insanity, Spidey's Abode, The Torava Disaster, Tutorial #2, The Musical Showcase.
   - Drop `_offset`, `_hide_timedoor_offset` and `OFFSETS`/`expiryTick` (`eesim.js:105-129`).
3. **H: respawn runs after the queue drains.**
   - Where: `eesim.js:638-663`.
   - eeo-tas respawns at the end of `Player.tick` (`Player.as:1176-1179`), before `PlayState.enterFrame`. So
     deferred orange, crown or key retries pending at the moment of respawn run at the **spawn** position in
     eeo-tas, and at the death position in eesim.
   - Fix: move `if (is_dead && _dead_offset > 16) { respawn(); deaths++; }` to the end of `_playerTick`, after
     `run_ticks`.
4. **H: the spawn list is wrong for some levels.**
   - Where: `eesim.js:229` (only tile 255, row-major over the final tile map), `_placeAtSpawn`
     (`eesim.js:1593-1607`), `reset()` (`eesim.js:475`, `eesim.js:509-510`, start index 0).
   - eeo-tas takes 255 and 1582 with id 0 from the **file group order** (`World.as:359-366`) and indexes by
     `worldSpawn`.
   - A Music Extravaganza has `spawnPoints[0] = [1582@(1,2), 255@(118,171)]`, but eesim sees only `(118,171)`.
   - The start after `/reset` uses spawn index `1 % n`, not 0 (section 13). This affects 4x4 Labyrinth, cyph,
     Spidey's Abode, Technological Terror and A Music Extravaganza.
   - Needs: the level loader to emit spawns in file order, plus `startSpawn` and `worldSpawn` options.
5. **H: curse, zombie and poison are missing** (421, 422, 1584, NPC zombie 1573). This includes:
   - their flags and timers, and the kill check at step 3 (`Player.as:399-404`, where eesim has only fire at
     `eesim.js:674-676`);
   - the zombie ×0.75 jump and ×0.6 speed multipliers (`eesim.js:769-773`, `eesim.js:1609-1615`);
   - the zombie doors;
   - protection clearing them (`eesim.js:1465-1472` clears only fire);
   - respawn clearing them (`eesim.js:573-582`).
   - Sample levels: Forgotten Helix and Panicore (curse), Gloomy Castle (zombie, values 8-12).
6. **H: zombie doors and gates are swapped.**
   - Where: `eesim.js:1369-1370`, which says 206 blocks and 207 passes.
   - eeo-tas `World.as:734-735`: 206 `ZOMBIE_GATE` is passable when not zombie, and 207 `ZOMBIE_DOOR` is passable
     only when zombie. So for a normal player, 206 passes and 207 blocks.
7. **H: teams are missing.**
   - Where: `eesim.js:1367-1368` hardcode team 0.
   - Needs `team` and `tx/ty`, 423 in touchBlock (`Me.as:320-323`), and the per-tick retry at step 5
     (`Player.as:421`, including its `overlaps()` side effects).
   - Sample levels: A Music Extravaganza (135 blocks), Be gone, CTM 2, Desolate Relics, Forgotten Helix, Gloomy
     Castle, Octorage, Panicore, Tea Land, Technological Terror.
8. **H: levitation (418) state is missing:** `hasLevitation`, `_currentThrust`, `isThrusting`, including the stale
   `isThrusting` read while dead, jumps being disabled, and effect reset and protection interplay. The physics is
   specified elsewhere; the state belongs in snapshot and key. Sample levels: CTM 2, Desolate Relics (44),
   Forgotten Helix, Gloomy Castle, Panicore, Tea Land, Torava.
9. **H: gold doors are hardcoded to "no gold border".**
   - Where: `eesim.js:1355-1356`.
   - eeo-tas reads the user's gold border setting (section 14). It must be a sim option (The EE Legend has 18).
10. **M: world gravity ≤ 0 becomes 1.**
    - Where: `eesim.js:305`.
    - eeo-tas uses the float32 header value as-is, and 0 means no gravity (section 15). The value must be the
      exact float32 widened, which the export's `gravity_hex` already allows.
11. **M: effect reset (1618) does not clear levitation or thrust** (`eesim.js:1473-1476` against
    `Player.as:1817-1821` → `setEffect(effectFly,false)`). This depends on #8.
12. **M: the start state is a fresh load, not a `/reset`** (`eesim.js:467-517`):
    - spawn index 0 (#4);
    - `_ox/_oy = spawn` (`eesim.js:511`), where a fresh load has 0,0 (differs only if the spawn box touches a
      one-way tile before moving);
    - no way to pass the leftovers from before the reset (section 13).
    - Add start options, or document the preconditions.
13. **M: queue drain model.** eesim drains PlayState `queue` and `keysquene` once per tick (`eesim.js:638-658`).
    eeo-tas drains per frame (1.1). Keep one drain per tick as the canonical model, add a `drainsPerTick` option,
    and expose "queue non-empty" so the optimizer can avoid or flag real-time-sensitive segments.
14. **M: `parseEetas` does not match eeo-tas byte decoding.**
    - Where: `eesim.js:350-362`. It trims whitespace, clamps `ord-48` to 0..31 and decodes UTF-16 code points.
    - eeo-tas reads **every byte**: signed, `-48`, low 5 bits (1.2). `'P'` and above (for example `'P'` → none, and
      eesim gives all five buttons), CR/LF and any non-ASCII byte differ.
    - Files written by `/record` contain only bytes 48..79, so this matters only for hand-edited files. Mirror
      the byte decoding, and warn on bytes outside 48..79.
15. **L: fire uses the millisecond clock** (`eesim.js:674-676`, `eesim.js:1477-1485`, key at
    `eesim.js:1845-1852`). This is numerically equal to eeo-tas: the kill comes at elapsed ≥ 241 ticks both ways.
    Store `fireTimeStart = ticks` and `fireDuration = 240` to share code with #5.
16. **L: key expiry color order** (`eesim.js:632`) is red..yellow. eeo-tas uses an unspecified `for-in` order. Only
    simultaneous deferred expiries are affected.
17. **L: snapshot is missing new state** (`eesim.js:1978-1987`, `eesim.js:1698-1716`). Once #5 to #8 are added,
    snapshot must include:
    - `team`, `tx`, `ty`;
    - `cursed/curseTimeStart/curseDuration`, the same three for `zombie` and `poison`;
    - `hasLevitation`, `_currentThrust`, `isThrusting`;
    - integer `kt[6]` (the ticks-based key timers);
    - the per-run options (gold border, `worldSpawn`, drain model) in the sim configuration.

    `_offset`, `_hide_timedoor_offset` and `_timedoor_state` become derivable from `_ticks`, except the first tick
    after the start.
18. **L: stateKey does not match eeo-tas timing** (`eesim.js:1770-1904`):
    - The key timers (`eesim.js:1876-1893`, `expiryTick`) and the time door entry (`eesim.js:1894`) must become
      `kt - ticks` and `ticks % 1000` (18.2). The README's "absolute-clock caveat" then disappears for keys.
    - The key must add the team, pending-team, curse, zombie, poison, levitation and zombie-flag entries (18.2).
    - `on_ground`, `gravity_dir` (`eesim.js:1834`, `eesim.js:1874`) and `secretBits` (`eesim.js:1902`) are not EEO
      state. Keying them is correct but over-splits.
    - `_last_portal_set` without the coordinates is right: eeo-tas only tests `lastPortal != null`.
19. **Already equivalent** (no change needed):
    - the gate snapshot overlaps order (`eesim.js:599-618`);
    - the purple queue drain position and its clear on respawn (`eesim.js:702-710`, `eesim.js:578`);
    - the deferred pattern and id-1000 recursion for switches, crowns and keys (`eesim.js:1519-1590`);
    - `resetSend` treated as always false (reset tile and world portal as no-ops);
    - `run_ticks` gated by `has_silver_crown` (equals `completed`);
    - the coin collect rules;
    - checkpoints and `_next_spawn` cycling (apart from #4);
    - the `deadoffset` 0.3 float accumulation (54 ticks);
    - `kill_player` gating;
    - the god toggle position (a test hook, LIVE in eeo-tas).

---------------------------------------------------------------------------------------------------------------

## Appendix: world-state mechanics in the 35 sample levels (layer 0 counts)

This table lists only the levels with a notable mechanic from this spec. Keys and key doors, coin doors, crowns,
portals and trophies also appear in most of the other levels (Odyssey, FV, Occult, Are You A God, Jump Jump Jump,
Wine Quest, Tutorials, ...).

| level | spawns in `spawnPoints[0]` | keys | time doors | switches | team | effects of note | other |
|---|---|---|---|---|---|---|---|
| 4x4 Labyrinth | 2 (row-major) | | | | | | god block |
| A Music Extravaganza | 2 (1582#0 first) | | | purple 117 | 135 | low gravity, gravity, run | |
| Be gone | 1 | | | | 93 | protection, multijump | 76 checkpoints |
| CTM 2 | 1 | | | purple 369 | 12 | fly 4, lava 622, toxic 262, fire 206 | |
| Desolate Relics | 1 | 2 | | purple 23 | 34 | fly 44 | |
| cyph | 2 | | | | | | 162 key doors |
| Edge Of Insanity | 1 | 32 | 22 | purple 55 | | | |
| Egg Quest II, EX Crew RR, EX Crue Ment | **0** (start at 16,16) | yes | | | | | world portal (EQ2) |
| Forgotten Helix | 1 | | | purple 5 | 24 | **curse 14** (1-6 s), fly 4, gravity 182, multijump | 54 checkpoints |
| Gloomy Castle | 1 | | | purple 60 | 11 | **zombie 71** (8-12 s), fly 2 | death doors, reset tile |
| Octorage | 1 | | | purple 75 | 82 | protection | world portals |
| Panicore | 1 | | | purple 172 | 20 | **curse 132** (10 s), fly 5 | reset tiles, death door |
| Spidey's Abode | 2 | 1190 | 8 | | | | |
| Tea Land | 1 | | | | 4 | fly 1 | |
| Technological Terror | 2 | 1 | | purple 18 | 21 | | |
| The EE Legend | 1 | 1 | | | | | **gold doors 18** |
| The Torava Disaster | 1 | 59 | 74 | | | fly 2 | |
| Tutorial #2 | 1 | | 35 | purple 9 | | lava 241 | death doors, reset tile |
| The Musical Showcase | 1 | | 2 | purple 114 | | jump, run | world portals |

All 35 files have header gravity 1.0. No sample level uses zombie doors (206/207) or poison.
