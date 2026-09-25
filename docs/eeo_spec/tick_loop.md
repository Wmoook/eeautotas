# eeo-tas: the per-tick loop, TAS input, clocks and determinism

Scope: how one physics tick is driven in eeo-tas, in exact order; how a `.eetas` file is read and applied; the run
timer; every clock and every `Math.random` that can touch gameplay; key timers, time doors, effect timers,
death/respawn timing, checkpoints and the deferred queues. The last section compares all of this with
`tools/tas/eesim.js` (`tick()`, `_playerTick()`, `applyMask()`, `parseEetas()`) and lists every difference.

Block-specific physics (gravity tables, drag, collision, `touchBlock` per block) is covered by the other spec
files. It appears here only where it sets tick order or timing.

## 0. Sources and conventions

- Ground truth: `C:\Users\super\eeo-tas\src` at git HEAD `8fc5872` ("Merge pull request #33 from Seb-135/bugfixes").
  All `file:line` references below are to that tree. Paths are relative to `src\`.
- `blitter\BlGame.as`, `blitter\BlContainer.as` and `blitter\BlObject.as` use old-Mac CR-only line endings. Most
  tools show them as one line. Their line numbers below count CR-separated lines.
- The original EE Offline is `C:\Users\super\ee-offline` (HEAD `d148289`). `BlGame`, `BlContainer`, `Bl`,
  `SynchronizedObject`, `Lookup` and `ItemId` are byte-identical in both trees. `PlayState`, `Me`, `Player`, `World`,
  `Config` and `KeyBinding` differ. The timing-relevant differences come from eeo-tas commit **`d6e2072`**
  (2022-02-03, "fixes #7, fixes #22, fixes #31, fixes #32"):
  - Key timers and time doors were changed from `World.offset` (`+0.3` per tick, float) to `PlayState.ticks` (int).
  - Curse, zombie, fire and poison were changed from `new Date()` wall-clock timers to `PlayState.ticks`.
  - Respawn after death was moved from `Player.draw` (per rendered frame) to the end of `Player.tick` (per tick).
- **The eeo-tas `README.md` "Known Issues" line "lava, poison, curses work on realtime not ticks" is out of date.**
  It describes builds before `d6e2072`. The current source is tick-based (section 9). An eeo-tas SWF built before
  Feb 2022 behaves like the original EEO for these timers. That old behavior is what `eesim.js` implements today
  (see gap G8).
- AS3 number semantics used below: `int` is int32, `Number` is IEEE double, `/` is always double division, `%` is
  IEEE fmod, and `x >> 0` / `x >>= 0` is ToInt32 (truncation toward zero for |x| < 2^31).

## 1. The frame loop (wall-clock scheduling)

`EverybodyEdits extends BlGame` (`EverybodyEdits.as:84`) and does not override the loop.
`PlayState` sets `Global.stage.frameRate = Config.maxFrameRate` = **120** (`PlayState.as:191`, `Config.as:78`).

`BlGame.handleEnterFrame` (`blitter\BlGame.as:144-162`, CR lines) runs once per Flash frame:

```
if ((Date.now - Bl.time) / Config.physics_ms_per_tick > 15)          // :147
    Bl.time = Date.now - Config.physics_ms_per_tick * 15;             // :148  catch-up cap (about 15 ticks per frame)
for (; Bl.time < Date.now; Bl.time += Config.physics_ms_per_tick)    // :152
    state.tick();                                                     // :153  PlayState.tick (section 2)
state.enterFrame();                                                   // :155  PlayState.enterFrame (section 5), once per frame
Bl.exitFrame();                                                       // :156  clears keyboard just-pressed/released
state.exitFrame();                                                    // :157
state.draw(screen, 0, 0);                                             // :159  rendering only (no physics in eeo-tas)
```

- `Config.physics_ms_per_tick` is 10 by default (`Config.as:44`), so 100 ticks per second of wall time. `/playtas N`
  and `/playsegment N` set it to `10/N` (`UI2.as:2205, 2227`). `/speed N` sets `TASGlobal.speedMult = 10/N` and
  applies it (`UI2.as:2246-2247`).
- **Speed does not change physics.** The drag constants are static initializers computed once, when `Config` is
  first used and `physics_ms_per_tick` is still 10 (`Config.as:47-55`). `SynchronizedObject` copies them at
  construction (`SynchronizedObject.as:13-26`). Speed only changes how many ticks run per rendered frame. That
  matters for the per-frame deferred queues (section 5) and nothing else.
- How many ticks a frame gets depends on wall-clock timing: 0, 1, 2 and so on, capped near 15. Everything physical
  happens inside `state.tick()`, except the deferred queues in `PlayState.enterFrame` (section 5).

## 2. `PlayState.tick()` — exact order (`states\PlayState.as:534-795`)

```
534 tick():
536   if (KeyBinding.tick.isJustPressed(false) || TASGlobal.ticksEnabled) {    // Shift+C (KeyBinding.as:36) or running
537     TASGlobal.steps = 1;
539     if (eetasInput != null && eetasInput.bytesAvailable > 0) TASGlobal.getTASInput = true;
543     if (eetasInput != null && eetasInput.bytesAvailable == 0 && !TASGlobal.endofTAS) {   // TAS just ran out
544       if (TASGlobal.isSegment) { ticksEnabled = false; steps = 0; isSegment = false; }   // /playsegment: freeze, NO tick now
549       else ticksEnabled = true;                                                          // /playtas: keep running live
553       endofTAS = true;
554       Config.physics_ms_per_tick = TASGlobal.speedMult;     // default speedMult = 1 (TASGlobal.as:24) => 1 ms/tick = 10x
555     }
556   }
558   if (TASGlobal.ticksEnabled || TASGlobal.steps > 0) {
561     Global.base.ui2instance.tick();          // UI2.as:2381-2436: minimap key, P = mod mode toggle (flying!), Shift+P
562     ticks++;                                 // PlayState.ticks: THE level clock (int)
564-566 old = world.showCoinGate;     world.showCoinGate = player.coins;   if (world.overlaps(player)) world.showCoinGate = old;
569-571 oldb = world.showBlueCoinGate; world.showBlueCoinGate = player.bcoins; if (overlaps) revert;
573-575 oldd = world.showDeathGate;   world.showDeathGate = player.deaths;    if (overlaps) revert;
578-587 PlayState particles tick                          (visual)
589-630 screenshot / hide bubbles / names / inspect / NPC talk (C) / F8 scale   (no physics)
632-654 camera helpers, lock camera (Shift+L), hide UI (no physics)
656-669 if (KeyBinding.godmode.isJustPressed() && Bl.data.canToggleGodMode)   // G key
          { isInGodMode = !isInGodMode; resetDeath(); setShowAllSecrets(...); if (isInModMode) {isInModMode = false; resetDeath();} }
671-673 Esc: stop spectating
675-682 trials mode + Shift+R: getTimer() 500 ms debounce -> player.resetPlayer()       (wall clock, keyboard)
684-708 middle mouse (edit rights): block picker. NOTE line 696 `return;` exits tick() early: no world/player
          tick this call, but ticks++ already happened, steps is not decremented and getTASInput stays true
710-790 mouse: place blocks (edit rights; Date-based 500 ms same-cell debounce, lines 762/775);
          V + click while flying teleports the player (735-739)
791     TASGlobal.steps--;
792     playerOverlaps();        // 940-970: curse/zombie tagging between players (see 11); with no fake players only
                                 //          player.touchCooldown-- when the player can tag (cursed/zombie/protected)
793     super.tick();            // BlContainer.tick (below)
794   }
```

`BlContainer.tick()` (`blitter\BlContainer.as:59-71`, CR lines) runs `o.tick()` for each object in `content`, in
array order (`:60-62`). Then it runs `BlObject.tick()` → `update()` on the PlayState itself, which is empty. Then it
moves the camera (`:64-70`, visual only). `content` is built in the `PlayState` constructor: `add(world)` (`:110`)
first, then `add(player)` (`:131`). Fake players from `/summon` are inserted **before** the player with
`addBefore(p, player)` (`:1240`). The resulting order inside one tick:

1. `world.tick()` → `BlObject.tick()` (`blitter\BlObject.as:58-60`) → **`World.update()`** (section 3)
2. fake players' `tick()`, if any
3. **`player.tick()`**, the `Me`/`Player` tick (section 4)
4. camera follow (visual)

## 3. `World.update()` (`World.as:137-156`)

```
138 offset += .3;                                              // animation clock only (sections 8, 10)
141-144 world particles tick                                   (visual)
147 setTimedoor((Global.playState.ticks / 100) % 10 >= 5);    // time doors: absolute tick schedule
149 for (var color:String in keys)                             // keys = {red, green, blue, cyan, magenta, yellow} (93-100)
150   if (getKey(color) && ((Global.playState.ticks - keysTimer[color]) / 100) >= 5)
151     Global.playState.switchKey(color, false);              // PlayState.as:219-225 (overlap-deferred, section 9.1)
155 super.update();                                            // empty
```

`for (... in keys)` iterates an AVM2 dynamic-object hash. The order is not specified by the language. The natural
guess is insertion order (red, green, blue, cyan, magenta, yellow). It only matters when two or more keys expire on
the same tick and the player overlaps doors of more than one of those colors.

## 4. `Player.tick()` (the `Me` instance) — exact order (`Player.as:381-1180`)

```
384     animoffset += .2;                         modoffset/auraAnimOffset (385-392)       (visual clocks)
395-396 if (isDead) deadoffset += .3; else deadoffset = 0;                                (death timer, 9.4)
399-404 if (!isDead) {                                                                    (timed effects, 9.3)
          if (cursed   && curseDuration  && state.ticks - curseTimeStart  > curseDuration)  killPlayer();
          if (zombie   && zombieDuration && state.ticks - zombieTimeStart > zombieDuration) killPlayer();
          if (isOnFire && fireDuration   && state.ticks - fireTimeStart   > fireDuration)   killPlayer();
          if (poison   && poisonDuration && state.ticks - poisonTimeStart > poisonDuration) killPlayer(); }
406-407 cx = (x+8)>>4; cy = (y+8)>>4;                     (tick-start cell, used by the whole tick)
409     delayed = queue.shift();                           (queue = Vector.<int>(2), initially [0,0], Player.as:274)
410-419 current = tile(cx,cy) (+ half-block redirect)
421     if (tx != -1) UpdateTeamDoors(tx, ty);             (pending team change retry, per tick, 1583-1604)
423-440 current_below
442     queue.push(current);
444-447 if (current == 4 || current == 414 || isClimbable(current)) { delayed = queue.shift(); queue.push(current); }
449-450 run and clear player.tilequeue (deferred purple switch presses, per TICK, 1570-1581)
452     getPlayerInput();                                  (Me.as:30-67: reads ONE .eetas byte, section 6)
454-459 if (isDead) { spacejustdown = false; spacedown = false; horizontal = 0; vertical = 0; }
461-690 gravity / current & delayed tables; toxic, fire, spikes: killPlayer() if !isDead && !isInvulnerable (529-558)
692-715 mx, my, multipliers, modifierX/Y
717-723 slippery
725-805 speedX / speedY update and drag
807-831 boosts; if (isDead) speeds = 0
833-935 sub-stepped movement: loop { processPortals() (1051-1174, Math.random, 10); stepx(); stepy(); }
937-995 if (!isDead) {
941       if (spacejustdown) { lastJump = -Date.now; injump = true; mod = -1 }                (wall clock, 9.6)
946-962   if (spacedown ...) { levitation thrust, or Date-based hold re-jump (750 ms / 150 ms) }
966-971   jumpCount reset / 1
973-990   jump
992       touchBlock(cx, cy, isgodmod);                   (Me.as:74-358: coins, keys, switches, effects, checkpoint, crown, finish)
993       sendMovement(cx, cy);                           (Me.as:360-372: bookkeeping; clears spacejustdown, no physics)
        }
998-1000 if (hasLevitation) updateThrust();
1003-1042 grid auto-align
1044    updateStuff();                                    (Me.as:374-376: run timer, section 7)
1176-1179 if (deadoffset > 16) { respawn(); deaths++; } (respawn is per TICK, at the very end of the tick)
```

`processPortals()` is a nested function. It is called at the top of every movement-loop iteration (`:925`) and
reads the tick-start cell `(cx, cy)`, which never changes inside the loop.

## 5. `PlayState.enterFrame()` — once per rendered frame, after all of that frame's ticks (`PlayState.as:478-526`)

```
479 super.enterFrame();                    (children: no physics)
480 Global.base.ui2instance.enterFrame();  (UI2.as:1363-1369: time-trial clock label = player.ticks)
482-496 HUD texts, "over 9000" sound
498-501 var length = queue.length;      while (length--) queue.shift()();       // PlayState.queue: orange switches, crown & silver-crown collide flags
503-507 var keyslength = keysquene.length; while (keyslength--) { k = keysquene.shift(); switchKey(k.color, k.state, true); }
509-513 var tilelength = tilequeue.length;  while (tilelength--) { setTile(...) }  // PlayState.tilequeue: block placement by the editor only
515-525 minimap, chat
```

**These three queues are processed per rendered frame, not per tick.** Each loop snapshots the queue length first,
so anything re-queued during processing waits for the next frame. What gets queued:

- `PlayState.queue`: closures from `pressOrangeSwitch` (`:227-237`), `checkCrown` (`:239-245`) and
  `checkSilverCrown` (`:256-262`), whenever setting the new value makes `world.overlaps(player)` nonzero. The value
  is reverted and the call is retried at the next `enterFrame`.
- `keysquene`: `{color, state}` from `switchKey` (`:219-225`) when the new key state overlaps the player.
- The player's own `tilequeue` (purple switches) and the pending team change (`tx`, `ty`) are retried **per tick**
  inside `Player.tick` (section 4). So those are deterministic.

Consequence (section 12): when a frame contains k ≥ 2 ticks, an orange-switch, crown or key change deferred during
tick i < k is not retried until after tick k. How many ticks share a frame depends on wall-clock timing, the frame
rate the Flash Player actually achieves (often 60-64 Hz, not 120), lag and the `/playtas N` speed. At 1x speed with
at least 100 real frames per second, every frame has 0 or 1 ticks. In that case the queue is retried between
every two consecutive ticks, which is exactly "process after every tick".

## 6. TAS input

### 6.1 File format and decoding
- A `.eetas` file is raw bytes, **one byte per tick**. `/loadtas` copies the file verbatim into
  `TASGlobal.eetasInput` (`UI2.as:2179-2183, 2254-2271`). There is no trimming, no text decoding and no BOM handling.
- `TASInput.readInputs()` (`tas\TASInput.as:21-34`):
  `v = eetasInput.readByte() - 48` (`offset = 48`, `:14`; `readByte` is signed, -128..127), then
  `jump = v&1, left = (v>>1)&1, right = (v>>2)&1, up = (v>>3)&1, down = (v>>4)&1`.
  Because 256 is a multiple of 32, this is exactly **`mask = (unsignedByte - 48) & 31`** for every byte value.
  Bits above bit 4 are ignored.
- Bits: 1 jump, 2 left, 4 right, 8 up, 16 down. Files written by eeo-tas only contain bytes 48..79 ('0'..'O')
  (`TASInput.writeInputs`, `:36-61`).
- Other bytes are **not** skipped. Each one is a tick with these inputs:

| byte | char | mask | inputs |
|---|---|---|---|
| 0x0A | `\n` | 26 | left + up + down (vertical cancels) |
| 0x0D | `\r` | 29 | jump + right + up + down |
| 0x20 | space | 16 | down |
| 0x09 | tab | 25 | jump + up + down |
| 0x50..0x5F | `P`..`_` | 0..15 | wraps (`P` = nothing) |
| 0xEF 0xBB 0xBF | UTF-8 BOM | 31, 11, 15 | three ticks |

  The eeo-tas README workflow says "combine the .eetas files in a text editor". An editor that appends a final
  newline adds one extra tick (left+up+down) at the end. A CRLF adds two.

### 6.2 When a byte is consumed
- `/playtas [N]` (`UI2.as:2207-2228`) sets `eetasInput.position = 0`, `isSegment = false`, `endofTAS = false`,
  `replaying = true`, `ticksEnabled = true` and `physics_ms_per_tick = 10/N`. `/playsegment [N]` (`:2184-2206`)
  does the same with `isSegment = true`. **Neither one resets the level.**
- Each executed tick: `PlayState.tick` sets `getTASInput = true` while bytes remain (`PlayState.as:539-541`).
  `Me.getPlayerInput()` (`Me.as:30-67`) runs inside `Player.tick` at `Player.as:452`, after the gravity queue,
  `current` and the purple-switch queue, and before any movement:
  ```
  if (isControlled) {                                   // Player.as:1938-1940: target == this, or no target and isme
    if (TASGlobal.getTASInput && TASGlobal.replaying) { // one byte
      inputs.readInputs();
      leftdown = left ? -1 : 0; updown = up ? -1 : 0; rightdown = right ? 1 : 0; downdown = down ? 1 : 0;
      spacejustdown = inputs.jump;  spacedown = spacejustdown;          // Me.as:43-44
    } else { keyboard (Me.as:47-53) }
    if (TASGlobal.userInputs != null) writeInputs(spacejustdown || spacedown, ...);   // recording, also during replay
    horizontal = leftdown + rightdown;  vertical = updown + downdown;   // left+right => 0, up+down => 0
    Bl.resetJustPressed();
    TASGlobal.getTASInput = false;
  }
  ```
- So byte k (0-based) drives the (k+1)-th tick executed after `/playtas`. After the canonical `/reset` (6.4), that
  tick has **`PlayState.ticks = k + 1`**. Nothing earlier in the tick reads the byte. The `.eetas` stream has no
  frame/tick mismatch: bytes are consumed per tick, never per frame.
- Edge cases that break this mapping. None of them happen in a hands-off replay:
  - a middle-click early `return` (`PlayState.as:696`): a tick is counted but the byte is not consumed;
  - spectating a fake player (`isControlled` false for the main player): the fake player consumes the bytes, and
    the main player keeps its last `horizontal` and `vertical`;
  - typing a command mid-replay.

### 6.3 Jump: press vs hold
In replay, every tick with the jump bit set has `spacejustdown = spacedown = true`. `Player.tick` sets
`injump = true` whenever `spacejustdown` is true (`Player.as:940-944`). The wall-clock hold logic (`:946-962`,
`lastJump` against `Date`: re-jump 750 ms after the press or 150 ms after the last jump) can only add
`injump = true` to a tick that already has it. **So a held jump bit is a fresh press on every tick, and all
`Date`-based jump state is irrelevant to replays.** When dead, both flags are forced false (`:454-459`).

Live keyboard play is different: `spacejustdown` is true only for the first tick after the key event, because
`Bl.resetJustPressed()` runs in every `getPlayerInput`. Held-jump re-jumps follow the wall clock. A file recorded
live, where jump was held across a landing, therefore replays differently. Recording writes `jump || held` as one
bit (`Me.as:55-57`).

### 6.4 Canonical replay protocol and the starting state
The protocol is: load the level → `/loadtas` → **`/reset`** → `/playtas`. `/reset` (`UI2.as:1701-1705`) runs
`player.resetPlayer()`, then `PlayState.ticks = 0`, then `ticksEnabled = false`. The world stays frozen until
`/playtas`, apart from manual Shift+C steps.

`resetPlayer(load=false, clear=false, worldSpawnID=-1)` (`Player.as:1265-1297`):
- Does nothing at all if the player is flying (god or mod mode).
- `hascrown = hascrownsilver = false`, then `checkCrown(false)` and `checkSilverCrown(false)`. These can defer via
  `PlayState.queue` if the pre-reset position overlaps. The collide flags are then forced false directly.
- `deaths = 0`, coins = 0, `resetDeath()`, `resetEffects()` (all effects, timed ones included), `resetCheckpoint()`,
  `switches = {}` (purple, set directly with no overlap check), `team = 0`.
- `Me.ticks = 0` (run timer), `completed = false`.
- `world.resetCoins()` (110→100, 111→101), coin lists cleared, `lookup.resetSecrets()`.
- `respawn()` → `placeAtSpawn(true)`, which uses the spawn rotation because the checkpoint was just cleared.

**Not reset** by `/reset`. These survive from whatever happened before it:
- World key states and `keysTimer`. A key taken before `/reset` stays active until the new clock reaches
  `keysTimer + 500`, because `ticks - keysTimer` goes negative.
- `world.orangeSwitches`. Orange switches are never reset by `/reset`.
- `world.nextSpawnPos`, the spawn rotation (below).
- `timedoorState`, until the first `World.update`. It only affects the three gate `overlaps()` calls of tick 1.
- `PlayState.queue` and `keysquene`.
- `Player.queue` (the delayed-gravity pair), `slippery`, `jumpCount`, `lastPortal`, `pastx`/`pasty`, `ox`/`oy`,
  `overlapa..d`, `_currentThrust`, the pending team change `tx`/`ty`.

When a level loads, ticks run in real time (`TASGlobal.ticksEnabled` starts true, `TASGlobal.as:8`). So before the
user types `/reset`, the player has usually fallen from the spawn and come to rest. That residue is what the TAS
starts from. It usually does not matter (the start tile's `delayed` is 0 or the spawn block 255, which is the
default gravity). It does matter when:
1. the level has **two or more spawn points** (spawn rotation, below);
2. the spot the player rests on before the reset is ice (`slippery = 2` decays for 10 ticks after the reset);
3. the resting cell holds gravity arrows, dots, a portal or one-way blocks;
4. keys or orange switches were touched before the reset.

**Spawn rotation.** `placeAtSpawn` (`Player.as:1212-1238`) uses `world.spawnPoints[spawnID][nextSpawnPos[spawnID]]`
and then increments `nextSpawnPos`, wrapping to 0. The `PlayState` constructor already calls `placeAtSpawn()` once
(`PlayState.as:123`). So after one `/reset`, the TAS starts at spawn index **1 mod N**, not 0. Each death without a
checkpoint advances the rotation again. `spawnPoints[0]` holds every spawn point block (255) and every
world-portal spawn (1582) with id 0, **in level-file order**: entry by entry, xs/ys order within an entry
(`World.as:359-365`). It is not row-major order. `worldSpawn` is 0 for a normal load
(`EverybodyEdits.as:451, 501`).

Joining a non-trial campaign world restores saved progress first (`EverybodyEdits.as:520-549`). `/reset` clears
most of it, subject to the list above.

### 6.5 End of file
- `/playtas`: in the tick call after the last byte was consumed, `bytesAvailable == 0 && !endofTAS` is true. It
  sets `ticksEnabled = true` and `endofTAS = true`, and `physics_ms_per_tick = speedMult`. That same call and every
  later tick run with **live keyboard input** (usually nothing pressed, so mask 0). There is no gap tick. Because
  `speedMult` defaults to 1 (`TASGlobal.as:24`), the game then runs at 1 ms per tick (10x speed) unless `/speed` was
  used. `replaying` stays true until `/endtas`, which is harmless because `getTASInput` stays false.
- `/playsegment`: in that same call, `ticksEnabled = false` and `steps = 0`, so **no tick runs**. The game freezes
  right after the tick of the last byte.
- `/endtas` (`UI2.as:2229-2238`) stops the replay and ticks.

### 6.6 Recording and save states (they only matter for how a file was made)
- `/record start` creates `TASGlobal.userInputs`. Every executed tick writes one byte at `position`
  (`TASInput.as:56-60`), including ticks of a replay.
- `/state save` and `/state load` (`UI2.as:2114-2137`, `tas\TASSaveState.as`) copy the buffer and, on load, set
  `userInputs.position = PlayState.ticks` at save time (`TASSaveState.as:428-430`). Byte index = `PlayState.ticks - 1`
  therefore only holds if recording started right after `/reset` (ticks = 0).
- Save states do not restore `world.keys` booleans correctly. `load()` calls `setKey(color, keysTimer[color], true)`,
  passing the timer int as the state. They also skip `lastPortal`, `lastJump`, `overlapa..d` and the particle/visual
  state. Effect timers are round-tripped as `duration/100 - 0.4`, which may not be exact. A file assembled from
  save-state segments can therefore replay differently from what its author saw. **The replay is the ground truth.**

## 7. The run timer: what `run_ticks` must be

`Me.updateStuff()` (`Me.as:374-376`), the last thing in the player tick before the respawn check
(`Player.as:1044`):

```
if (isControlled) if (!completed && (ticks || horizontal || vertical || spacedown)) ticks += 1;
```

- `Me.ticks` is **the run time in centiseconds**. The time-trial HUD shows `ClockTime.format(player.ticks)`
  (`UI2.as:1363-1367`, `ui\campaigns\ClockTime.as:35-64`, 100 per second). `/fps` or `/info` shows
  `Time: (player.ticks/100).toFixed(2)s` and `Level time: (PlayState.ticks/100).toFixed(2)s`
  (`ui\DebugStats.as:73-74`). The trial result uses `player.ticks` (`UI2.as:735`).
- The timer starts at the end of the first tick F where the post-death-zeroing input has `horizontal != 0`, or
  `vertical != 0`, or the jump bit. Left+right, or up+down, cancel and do not start it. Dead ticks cannot start it.
- `completed` is set in `touchBlock`, case `BRICK_COMPLETE` (121) (`Me.as:205-217`, only when `!hascrownsilver`
  and `!resetSend`). That happens earlier in the same tick than `updateStuff`, so the completion tick C is not
  counted: **`run_ticks = C - F`**, with C and F as 1-based tick indices. Ticks spent dead are counted once the
  timer runs.
- `resetPlayer()` with `worldSpawnID == -1` sets `Me.ticks = 0` and `completed = false`. Reset points (466) do this
  when the risky key is held (11).
- `PlayState.ticks` (the level time) is a different clock: it counts every executed tick since `/reset`.

## 8. Every clock

| clock | where | unit / step | reset by | drives | deterministic per tick? |
|---|---|---|---|---|---|
| `PlayState.ticks` (int) | `PlayState.as:532, 562` | +1 per executed tick, before World/Player | `/reset` (`UI2.as:1703`); save-state load | key timers, time doors, timed effects, fire/levitation animation frames | yes |
| `Me.ticks` (int) | `Me.as:15, 375` | +1 per tick (7) | `resetPlayer` (worldSpawnID -1) | displayed run time | yes |
| `Player.deadoffset` (Number) | `Player.as:310, 395-396` | +0.3 per dead tick | set to 0 on alive ticks | respawn after 54 dead ticks (9.4) | yes |
| `Player.touchCooldown` (int) | `Player.as:108`, `PlayState.as:944-946` | -1 per tick while the player can tag | set to 100 on tag | tagging (fake players only) | yes |
| `Player._currentThrust` | `Player.as:1846-1861` | -0.01 per tick when not thrusting | respawn does not reset it | levitation | yes |
| `Player.slippery` | `Player.as:717-723` | 2, then -0.2 per tick off ice | not reset by `/reset` | ice drag, jump multiplier | yes |
| `World.offset` | `World.as:91, 138` | +0.3 per tick | never (level load) | animations only in eeo-tas | yes (unused for physics) |
| `animoffset`, `modoffset`, `auraAnimOffset` | `Player.as:384-392` | per tick | – | visual | – |
| `Bl.time`, `Date` | `BlGame.as:147-153` | wall-clock ms | – | how many ticks run per frame | **no** |
| `Player.lastJump` (`Date`) | `Player.as:275, 941-988` | wall-clock ms | – | held-jump re-jump; provably unused in replay (6.3) | no (irrelevant) |
| `Player.last_respawn` (`Date`) | `Player.as:1253, 1716` | wall-clock ms | – | 1 s tag immunity (fake players) | **no** |
| `lastRetry` (`getTimer`) | `PlayState.as:676-681` | wall-clock ms | – | Shift+R debounce (keyboard) | no |
| `pastT` (`Date`) | `PlayState.as:762, 775` | wall-clock ms | – | editor placement debounce | no |
| draw-time animation numbers | `World.as:1069-1160, 1430-1441, 1592-1651` | per rendered frame (visible cells only) | – | visual. Blink state has its own dictionary. Ice (1064), water (119), toxic waste (1585), mud bubble and toxic surface animations write the **shared** `lookup` dictionary (`Lookup.as:70-93`) through `setInt`/`setNumber`. Physics never uses `getInt` on those cells: `overlaps()` reads it for ice but only uses it for half and rotated blocks | none for physics |

`Global.ping` is the constant **0.2** (`Global.as:166-169`). It is not random.

## 9. Timers and deferred state

### 9.1 Keys (6/7/8/408/409/410) and their doors and gates
- Taking a key: `touchBlock` on a just-entered cell, not in god mode (`Me.as:242-250`), calls
  `state.switchKey(color, true)`.
- `switchKey(color, state, fromqueue=false)` (`PlayState.as:219-225`):
  `world.setKey(color, state, fromqueue); if (world.overlaps(player)) { world.setKey(color, !state); keysquene.push({color, state}); }`
- `World.setKey(color, state, fromqueue)` (`World.as:117-123`):
  `if (fromqueue && ((ticks - keysTimer[color]) / 100) >= 5) return; keys[color] = state; if (state && !fromqueue) keysTimer[color] = ticks;`
  - The revert inside `switchKey` calls `setKey(color, !state)` with `fromqueue = false`. When `!state` is true, the
    revert **restarts the timer** (`keysTimer = ticks`). An expiry blocked because the player stands inside the
    door therefore keeps the key on and restarts its 500 ticks. When the queued "off" is retried at the next frame
    and the player is out of the door, the key turns off.
  - `switchKey` runs its overlap check even when `setKey` returned early (a dropped queued change). If the player
    still overlaps, it applies `!state` and re-queues.
- **Expiry**: at the start of tick T' (`World.update`, before the player moves), a key taken at tick T
  (`keysTimer = T`) expires when `(T' - T)/100 >= 5`. That is exactly **T' = T + 500**. The comparison is exact
  because the difference is an int. The door is open for the rest of tick T and for ticks T+1..T+499. From tick
  T+500 the player moves with the door solid, unless the player overlaps it, in which case the expiry is deferred as
  described above.
- A key taken while it would overlap its own gate is deferred through `keysquene`. It is applied at the first frame
  boundary where the player does not overlap, and the timer counts from the original touch. If 500 ticks pass
  first, it is dropped.

### 9.2 Time doors (156) and time gates (157)
`World.update` (`World.as:147`) sets `timedoorState = ((PlayState.ticks / 100) % 10) >= 5` on every tick, before the
player moves. For every tick n ≥ 1 this is **exactly `n mod 1000 >= 500`**. `n/100` is correctly rounded and `%` is
exact fmod, so values such as n = 1000k+499 give 10k+4.99 and never round up to 5. The phase is absolute from
`/reset`: ticks 1-499 and 1000-1499 have `timedoorState = false`; ticks 500-999 and 1500-1999 have it true.

`overlaps()`: 156 is passable when `timedoorState` is true, 157 when it is false (`World.as:706-707`). There is no
overlap check or deferral when the state flips: the player can be inside a time door when it closes. The three gate
`overlaps()` calls at the start of `PlayState.tick` (section 2) run before `World.update`, so they see the previous
tick's state.

### 9.3 Timed effects: curse (421), zombie (422 and NPC 1573), fire (lava 416), poison (1584)
`setEffect(effectId, active, arg=0, duration=0)` (`Player.as:1724-1798`):

```
if (duration > 0) {
  if (!arg) arg = state.ticks;           // start = PlayState.ticks of the setting tick (it is never 0 inside a tick)
  duration += 2 * Global.ping;           // + 0.4
  duration *= 100;                       // double, in ticks
}
... cursed/zombie/isOnFire/poison = active; if (active) { xxxTimeStart = arg; xxxDuration = duration; }
```

- Setters (in `touchBlock`, just-entered cells, not in god mode):
  - curse: `setEffect(curse, s > 0, 0, s)`, s = lookup int, 0..999 in the editor (`Me.as:277-282`);
  - zombie: the same (`:283-288`);
  - poison: the same (`:289-294`);
  - NPC zombie 1573: `setEffect(zombie, true)`, duration 0, so **zombie forever** (`:295-299`);
  - lava 416: `setEffect(fire, true, 0, 2)` if not already on fire and not protected (`:325-329`);
  - water, mud and toxic waste (119/369/1585) put the fire out (`:330-336`);
  - protection 420 clears all four (`:300-315`).
  - None is set if already in that state or protected.
- Check: at the start of each `Player.tick`, only while alive (`Player.as:399-404`): kill when
  `PlayState.ticks - start > D`, where **`D = (s + 2*0.2) * 100`** evaluated in doubles, in that order. A timer set
  at tick T kills at tick **T + floor(D) + 1**:
  - lava (s = 2): D = 240, killed at T + 241;
  - for 904 of the values s = 0..999, D is exactly s*100 + 40 and the kill is at T + s*100 + 41;
  - **96 values of s** give a non-integer D:
    - s = 4 and s = 64..81: D is slightly above the integer (440.00000000000006, 6440.000000000001, …). The kill
      tick is unchanged: T + s*100 + 41.
    - s = 16..20 and s = 256..327: D is slightly below the integer (1639.9999999999998, 25639.999999999996, …).
      The kill comes **one tick earlier**: T + s*100 + 40.
    - **Implement the double arithmetic literally**; do not use `s*100 + 40`.
- `respawn()` clears all four (`Player.as:1259-1262`). `resetEffects(false)` from EFFECT_RESET 1618 keeps them
  (`Player.as:1817-1821`).
- Zombie also scales speed by 0.6 and jump by 0.75 (`Player.as:354-369`), and it drives the zombie doors and gates
  (206/207). That belongs to the effects spec.

### 9.4 Death and respawn
- `killPlayer()` (`Player.as:1202-1210`) sets `isDead = true` if not flying and not already dead. Deaths come from:
  the timed effects at tick start (9.3); `current` = toxic 1585, fire 368 or any spike, checked on the **tick-start
  cell** (`Player.as:529-558`), so the player dies on the tick after entering the cell; `/kill`.
- Once `isDead`, each tick: `deadoffset += 0.3` at tick start; inputs are consumed (a byte is still read) and then
  zeroed; speeds are set to 0; `touchBlock` and jumping are skipped. The run timer keeps counting if it has started.
- Respawn: at the end of `Player.tick`, `if (deadoffset > 16) { respawn(); deaths++; }` (`Player.as:1176-1179`).
  The sum 0.3 × n in doubles first exceeds 16 at n = 54 (16.200000000000017). A player killed during tick D
  therefore respawns **at the end of tick D + 54** and is alive at the start of tick D + 55. Respawn runs before
  the camera update and before `PlayState.enterFrame`, so it comes before the deferred queues.
- `respawn()` (`Player.as:1240-1263`) does the following:
  - sets modifiers and speeds to 0, `isDead = false`, `isOnFire = false`, `resetSend = false`,
    `last_respawn = Date`;
  - **clears `tilequeue`**, so pending purple switch presses are lost;
  - calls `placeAtSpawn(true)` (checkpoint, else spawn rotation) and clears the timed effects.
  - It does **not** reset `queue` (delayed gravity for the next two ticks), `slippery`, `jumpCount`, static effects
    (gravity, jump, speed, multi-jump, low gravity, protection, levitation), keys, switches, coins, crowns,
    `lastPortal`, `pastx`/`pasty` or `team`.
- `deaths` is incremented after the respawn. Death doors and gates see the new count from the next tick's
  `showDeathGate` update (section 2) and in `overlaps()` (`World.as:726, 729`).

### 9.5 Checkpoints (360)
`touchBlock` on a just-entered cell, not in god mode, sets `checkpoint_x = cx`, `checkpoint_y = cy`
(`Me.as:200-203`). Respawn uses the checkpoint when `checkpoint_x != -1` (`Player.as:1215-1217`).
`resetPlayer` clears it (`:1279, 1309-1312`). Placing a block over the checkpoint cell in the editor also clears it
(`PlayState.as:423-437`).

### 9.6 Other deferred state (per tick, deterministic)
- Purple switch 113, purple reset 1619: `pressPurpleSwitch` (`Player.as:1570-1581`) sets the switch; if the player
  overlaps, it reverts and queues on the player's own `tilequeue`. The queue is retried at `Player.as:449-450` of the
  next tick. `respawn()` drops it.
- Team (423): `UpdateTeamDoors` stores the pending cell in `tx`/`ty`. `Player.as:421` retries it every tick until it
  succeeds (`:1583-1604`).
- Coin, blue-coin and death gates: `showCoinGate`, `showBlueCoinGate` and `showDeathGate` follow the counts at the
  start of each tick unless that would overlap (section 2). Coin, blue-coin and death **doors** read the live counts.

## 10. Every `Math.random` (and `Random`)

| use | where | gameplay? |
|---|---|---|
| **multi-target portal exit** `randomRange(0, n-1) = floor(Math.random()*n)` | `Player.as:1046-1049, 1099` | **yes** |
| candidate order for that pick: `Lookup.getPortals` iterates `for (id in portalLookup)`, hash order of `"XxY"` keys | `Lookup.as:155-171` | yes (index to portal mapping is unspecified) |
| coin pickup particles | `Me.as:70-71` | no |
| cake smiley face `Random.nextInt(72, 76)` | `Me.as:196`, `utilities\Random.as:7` | no (cosmetic frame) |
| portal particles | `Player.as:1164-1165` | no |
| death animation choice | `AnimationManager.as:141` via `Player.as:1205` | no |
| ice shine, world-portal particles, Halloween eyes, fireworks, mud bubbles, water, toxic | `World.as:862, 1316-1317, 1436, 1482, 1490, 1521, 1599-1600, 1618-1619, 1632-1633, 1646-1647` | no (draw only; see the lookup note in section 8) |
| anti-cheat slot names | `com\reygazu\anticheat\variables\SecureObject.as:52` | no (values are stored exactly) |

A portal teleports only when the entered portal's `target != id` and the player is not flying. With exactly one
candidate portal the result is deterministic. With two or more, eeo-tas is **not reproducible**: the random source
is unseeded, and the candidate order is unspecified.

## 11. Things outside the `.eetas` that change physics during a replay

- **Risky key Y** (`KeyBinding.as:21`, held and without Shift):
  - Reset point 466 (`Me.as:125-128`) is checked on every tick in the cell, not only on entry. For the player it
    does nothing unless Y is held. With Y held it calls `resetPlayer()`, which also resets the run timer.
  - World portal 374 (`Player.as:1057-1085`) likewise needs Y held. It then calls `joinWorld` (a different level)
    or `resetPlayer(false, false, spawnId)`.
  - A replay made without touching the keyboard treats both as inert.
- **G** (god mode, if `canToggleGodMode`), **P** (mod mode, always allowed because `canCheat` is always true,
  `Player.as:1509-1514`, `UI2.as:2414-2429`), V+click teleport, editor mouse clicks, Shift+R in trials, and chat
  commands.
- **Gold smiley border**, a cookie setting: gold door 200 is passable only with the border, gold gate 201 only
  without it (`World.as:715-716`, `Player.as:1499-1507`, `PlayState.as:128`).
- **World gravity multiplier** from the level (`PlayState.as:116`; `/gravity` changes it).
- **Fake players** (`/summon`). They tick between the world and the player. They pick up crowns
  (`removeCrown` affects everyone) and can tag curses and zombies with the `Date`-based 1 s respawn immunity
  (`Player.as:1713-1717`, `PlayState.as:940-970`).
- Spectating (6.2) and middle-click (`PlayState.as:696`).

## 12. Determinism summary

**Deterministic per tick** given the level, the `.eetas` bytes, the start state (6.4), no keyboard or mouse during
the replay, no fake players, and at most one tick per frame:
- all movement and collision, `touchBlock` effects, coins, crowns, finish, checkpoints;
- purple switches (per-tick queue), team;
- keys (exactly 500 ticks), time doors (`ticks mod 1000`);
- curse, zombie, fire and poison (tick timers, 9.3);
- death → respawn (54 ticks), deaths;
- the run timer.

**Not deterministic per tick:**
1. The exit of a multi-target portal (`Math.random` and unspecified candidate order).
2. The **resolution tick of deferred orange switches, crown and silver-crown collide flags, and key on/off
   retries**. They are processed per frame (section 5), so the result depends on the frame/tick interleaving: wall
   clock, real fps, lag, and the `/playtas` speed (at 10x a frame holds about 8 ticks). They are only exact when
   every frame holds at most one tick.
3. Anything driven by live input during the replay (11), including reset points and world portals with Y.
4. The start state when something happened before `/reset` (6.4): spawn rotation with 2+ spawns, orange switches,
   keys, slippery, the gravity queue, `lastPortal`.
5. Tagging between players (`Date`, fake players only).
6. Held-jump timing and the retry/placement debounces (`Date`/`getTimer`). They are irrelevant to `.eetas` replays
   (6.3).
7. Builds older than `d6e2072`: curse, zombie, fire and poison run on `Date`; keys and time doors run on
   `World.offset` (float +0.3 per tick, 500 or 501 ticks); respawn happens in `Player.draw`, per frame.
- Visual only: every other `Math.random`, `getTimer` and `Date` use.

## 13. Reference tick for a simulator (eeo-tas HEAD semantics)

```js
// state: ticks (PlayState.ticks), runTicks (Me.ticks), completed, and so on.
// masks: Uint8Array from the raw file bytes: masks[i] = (buf[i] - 48) & 31
function tick(mask) {
  ticks += 1;                                               // PlayState.as:562
  gateUpdate('coin'); gateUpdate('blue'); gateUpdate('death');   // PlayState.as:564-575 (set, overlaps -> revert)
  // World.update, World.as:137-156
  timedoorState = ((ticks / 100) % 10) >= 5;
  for (const c of ['red','green','blue','cyan','magenta','yellow'])       // AVM2 for-in order assumed (section 3)
    if (key[c] && ((ticks - keysTimer[c]) / 100) >= 5) switchKey(c, false, false);
  playerTick(mask);                                          // Player.as:381-1180, including the final respawn check
  // PlayState.enterFrame queues: per FRAME in eeo-tas. Per tick = the "<= 1 tick per frame" schedule.
  runQueueSnapshot(stateQueue);                              // orange switches, crown, silver crown
  runQueueSnapshot(keysQueue, /*fromqueue*/ true);
}
function playerTick(mask) {
  deadoffset = isDead ? deadoffset + 0.3 : 0;
  if (!isDead) for (const e of [curse, zombie, fire, poison])
    if (e.active && e.duration && ticks - e.start > e.duration) killPlayer();
  /* cx, cy, delayed/current queue, pending team retry, current_below, queue push, purple tilequeue */
  const left = (mask >> 1) & 1, right = (mask >> 2) & 1, up = (mask >> 3) & 1, down = (mask >> 4) & 1;
  let jump = (mask & 1) !== 0;                               // spacejustdown = spacedown = jump
  horizontal = right - left; vertical = down - up;
  if (isDead) { jump = false; horizontal = 0; vertical = 0; }
  /* gravity, speeds, movement with processPortals, jump (injump = jump), touchBlock, thrust, align */
  if (!completed && (runTicks || horizontal || vertical || jump)) runTicks++;
  if (deadoffset > 16) { respawn(); deaths++; }
}
// setEffect with duration s > 0: start = ticks; duration = (s + 2 * 0.2) * 100;   // doubles, this order
// start state: fresh load (spawn index 0), [optional idle ticks], resetPlayer(), ticks = 0, runTicks = 0
//              (spawn index 1 % N after one /reset)
```

## 14. Comparison with `tools/tas/eesim.js`

`eesim.js` is a port of `ee_sim.gd`, which follows the **original EEO** (pre-`d6e2072`) timing with a virtual 10 ms
clock (`CLOCK_BASE + _ticks*10`). Its `tick()` (`eesim.js:594-665`) runs:
1. `_ticks++`
2. the three gates
3. `god_toggle`
4. World.update, `_offset`-based
5. `_playerTick`
6. `_stateQueue`, then `_keysQueue`
7. `if (is_dead && _dead_offset > 16) { respawn(); deaths++ }`
8. events

Steps 1-5 match eeo-tas order (section 2). The input position inside `_playerTick` matches `Me.getPlayerInput`.
`applyMask` gives `jump_pressed = jump`, so `_spacejustdown == _spacedown` exactly as in eeo-tas, and the
`_last_jump`/`now` hold logic is inert, as in eeo-tas (6.3). The lava fire timer via `now` is equivalent (kill at
+241). The run-timer rule is equivalent (`!has_silver_crown` versus `!completed`). The death/respawn count
(54 ticks) matches.

### Gaps

| # | severity | eeo-tas (HEAD) | eesim.js | fix |
|---|---|---|---|---|
| G1 | high | Key timer = `PlayState.ticks`. Expiry at exactly T+500; the queued-key drop rule uses the same test (`World.as:117-123, 149-153`) | `_offset` (+0.3 float) with `/30 >= 5`: 500 **or 501** ticks (about a quarter of start ticks give 501; 5119 of 19999 in a check) (`eesim.js:631-635, 1528-1533`) | `_kt[c] = this._ticks`; test `((this._ticks - this._kt[c]) / 100) >= 5` in both places. stateKey: key the exact remaining ticks. The README "absolute-clock caveat" for keys goes away |
| G2 | high | Time doors: `((ticks/100) % 10) >= 5`, which toggles at exactly 500, 1000, 1500, … from `/reset` (`World.as:147`) | Toggles when `_offset - _hide_timedoor_offset >= 150`: at 501, 1001, 1501, 2002, 2503, … and drifts +11 ticks by tick 12000 (`eesim.js:627-630`) | Replace with `this._timedoor_state = ((this._ticks / 100) % 10) >= 5` each tick. stateKey on time-door levels must key `_ticks % 1000`; an exact rejoin across ticks then needs equal phase |
| G3 | high | Respawn at the end of `Player.tick`, before the per-frame queues (`Player.as:1176-1179`) | Respawn after `_stateQueue`/`_keysQueue` (original EEO `Player.draw`) (`eesim.js:659-663`) | Move `if (is_dead && _dead_offset > 16) { respawn(); deaths++ }` to the end of `_playerTick`, after the run timer and before the queues. The order matters when a deferred orange/crown/key change is pending on the respawn tick: eeo-tas retries it at the spawn position, eesim at the corpse |
| G4 | high | Every byte is one tick: `mask = (byte - 48) & 31`. No trim, no BOM, no text decoding (`TASInput.as:26-33`) | `parseEetas`: UTF-8 text, BOM skipped, whitespace (≤ 32) trimmed at both ends, `clamp(ord - 48, 0, 31)` (`eesim.js:350-362`) | Parse a Buffer: `masks[i] = (buf[i] - 48) & 31`. Warn on bytes outside 48..79, especially a trailing `\n` or `\r\n`, which eeo-tas plays as extra ticks (left+up+down, jump+right+up+down). Tools read `.eetas` with `'utf8'` and must pass bytes |
| G5 | high (2+ spawns) | The TAS starts after `/reset`, so the spawn rotation has advanced once: start = `spawnPoints[0][1 % N]`. The list is in level-file order and includes world-portal spawns with id 0 (`Player.as:1212-1238`, `PlayState.as:123`, `World.as:359-365`) | `reset()` starts at spawn index 0 in row-major order, 255 only (`eesim.js:1593-1607`, `prepareLevel`) | Build spawns in file order (1582 with id 0 included); add a start option (`startSpawnIndex`, default 1 % N = "load + /reset"); model `/reset` as `resetPlayer()` (6.4) instead of a fresh load |
| G6 | medium | Deferred PlayState.queue and keysquene are processed per rendered frame (`PlayState.as:498-507`, `BlGame.as:152-155`), so they are only deterministic at ≤ 1 tick per frame | Processed after every tick (`eesim.js:638-658`) | Keep per tick (it equals the ≤ 1 tick/frame schedule). Expose "a deferred item survived this tick" (queue non-empty at the end of `tick()`) so the optimizer can reject or flag routes whose outcome depends on it. Optionally add a test mode that retries the queues only every k ticks |
| G7 | medium | Curse, zombie (and NPC zombie), poison and fire are tick-based: `D = (s + 0.4) * 100` (double), kill when `ticks - start > D`; protection clears all four; respawn clears all four (`Player.as:399-404, 1724-1798`, `Me.as:277-336`) | Only fire (lava 2 s) exists, on the virtual Date clock. It happens to match (+241). No curse, zombie or poison (`eesim.js:674-676, 1477-1488`) | Implement all four with `_start = _ticks` and the literal double `D`. Clear them on respawn and protection. Add zombie speed ×0.6 and jump ×0.75. Key the remaining ticks in stateKey. Check s = 16..20, 4, 64..81, 256..327 (non-integer D) |
| G8 | medium | Source HEAD is tick-based (`d6e2072`, Feb 2022). The eeo-tas README known issue is stale | Implements the pre-`d6e2072` behavior (offset keys and time doors, Date-style fire, per-frame-style respawn) | Confirm which eeo-tas build made each TAS. For builds at or after `d6e2072`, apply G1-G3 and G7. Keep the old model behind a flag for older builds. FV being bit-exact does not settle it unless FV's key expiries were ever at a 500/501-sensitive moment |
| G9 | medium | `/reset` leaves residue: `Player.queue`, `slippery`, `jumpCount`, `pastx`/`pasty`, `lastPortal`, `ox`/`oy`, `overlapa..d`, world keys and `keysTimer`, orange switches, `nextSpawnPos` (`Player.as:1265-1297`) | `reset()` zeroes everything as a fresh load (`eesim.js:467-517`) | Add `resetPlayer()` exactly as in `Player.as:1265-1297`. Start = `reset()` + optional idle ticks with mask 0 (the player settles) + `resetPlayer()` + `_ticks = run_ticks = 0`. Document the precondition: `/reset` right after load, touching nothing |
| G10 | low | Reset point 466 and world portal 374 only act while the risky key Y is held. Reset points restart the run timer (`Me.as:125-128`, `Player.as:1057-1085`) | Both are ignored | Equivalent under "Y never held". Treat both as inert, and implement `resetPlayer` for an optional "Y held" mode |
| G11 | low | Multi-target portal exit = `Math.random` over the for-in order of `portalLookup`. Not reproducible (`Player.as:1099`, `Lookup.as:155-171`) | Godot PCG32 seeded 0x5EED, or `rngScript` over file-order candidates (`eesim.js:1133-1154`) | No exact model exists. Make the exit an explicit per-entry choice, keyed by the target tile rather than an index. Report when a route uses a multi-target portal: an eeo-tas replay of it is luck |
| G12 | low | Key expiry order comes from for-in over the `keys` object (AVM2 hash order) (`World.as:149`) | Fixed red…yellow (`eesim.js:632`) | Keep red…yellow. Flag ticks where 2 or more keys expire at once while the player straddles doors of those colors |
| G13 | low | After EOF, `/playtas` continues with live keyboard input (normally mask 0) at `speedMult` (default 1 ms/tick). `/playsegment` stops with no extra tick (`PlayState.as:543-555`) | The caller decides. Tools stop at completion and write `masks.slice(0, complete)` | Nothing to change for completing runs. When simulating past EOF use mask 0. Never write files whose completion needs ticks past EOF |
| G14 | low | Gold smiley border (a cookie setting) opens 200 and closes 201 (`World.as:715-716`) | Hardcoded as no border (200 blocks, 201 passes) (`eesim.js:1355-1356`) | Make it a level/run option, default false |
| G15 | info | The `.eetas` has no god/mod-mode bit. G and P are keyboard only | `EEInput.god_toggle` (raw bit 64) and `jump && !jump_pressed` (live hold semantics on a virtual clock) exist | Not eeo-tas. Only `applyMask` input is valid for eeo-tas-exact runs |

### Notes outside this area (found while checking)
- **Zombie doors and gates look swapped in `eesim.js`.** eeo-tas: `ZOMBIE_GATE = 206` is passable when **not**
  zombie, `ZOMBIE_DOOR = 207` is passable when zombie (`World.as:734-735`, `ItemId.as:96-97`). `eesim.js`
  `_doorPassable` has `case 206: return false; case 207: return true;` (`eesim.js:1369-1370`). For a non-zombie
  player that is the opposite of eeo-tas.
- Drag constants (`Config.as:47-55`, `Math.pow(x, 10) * 1.00016093`): the hardcoded bits in `eesim.js` equal `x^10`
  computed by **exponentiation by squaring** (`x^2`, `x^4`, `x^8`, then `x^2 * x^8`) and then × 1.00016093. For
  7 of the 8 constants that result differs by 1-3 ulp from V8's `Math.pow` and from the correctly rounded `pow`; only
  BASE_DRAG agrees with all three. The hardcoded values are therefore right only if Flash's `Math.pow` also uses
  the squaring path for integer exponents. That is plausible for avmplus but was **not verified here**. Whoever
  owns the constants should confirm it, for example against a Flash or Ruffle run on ice, water or mud. Never
  derive them with V8 `Math.pow`.
