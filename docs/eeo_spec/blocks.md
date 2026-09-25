# eeo-tas block behavior spec (every block id)

Scope: what is solid when, and what touching each block does, in **eeo-tas** (`~\eeo-tas\src`, AS3,
the ground truth), precise enough to implement a bit-exact JS sim. Movement integration (drag constants, sub-steps,
jumping, auto-align) is only described where a block changes it. Level-file parsing is only described where it decides
block data (lookup values, spawn order). Section 11 audits `tools/tas/eesim.js` against this spec.

All `File.as:line` references are to `eeo-tas/src` unless marked otherwise. `ItemId.as`, `ItemManager.as` and `Lookup.as`
are identical to the original EE Offline (`~\ee-offline\src`). eeo-tas changed `Player.as`, `Me.as`,
`World.as`, `states/PlayState.as`, `Config.as`, `UI2.as`, `KeyBinding.as` (plus UI files). The block-relevant changes are
called out as **[eeo-tas change]**. The main one: timers (keys, time doors, curse/zombie/poison/fire) count ticks instead of
wall-clock time.

## 0. Conventions

- **tick `t`**: the value of `PlayState.ticks` during a physics step. It is incremented first thing in a stepped
  `PlayState.tick` (PlayState.as:562). `/reset` sets it to 0 (UI2.as:1701-1705). After `/reset`, `/playtas` makes the
  first stepped tick `t = 1` consume eetas byte 0 (PlayState.as:536-541, Me.as:35-45). If the user does not `/reset`
  first, `t` starts at some arbitrary value. Every tick-based phase below (time doors, key expiry) then shifts, so a
  sim needs an initial `T0` (default 0).
- **layer 0**: `World.realmap[0]`, which holds every non-background block (foreground, decoration, "above" layer,
  liquids, coins, NPCs). All gameplay reads layer 0 only (`getTile(0, ...)`, `realmap[0]`). Layer 1 (background) is
  never read by physics. The ItemManager render layer (FORGROUND/DECORATION/ABOVE) is irrelevant to gameplay.
- **`L(x,y)`**: `world.lookup.getInt(x, y)` (Lookup.as:70-73), the int stored for that cell, or 0 if none.
  `getBoolean` (Lookup.as:95-98) returns the same stored value coerced to Boolean (non-zero = true).
- **speeds**: `speedX/speedY/modifierX/modifierY` getters return the internal `_speedX...` times 7.752, and the
  setters divide by 7.752 (SynchronizedObject.as). eesim stores the internal values. Boosts write `_speedX/_speedY`
  directly.
- **cell of the player**: `cx = (x+8)>>4, cy = (y+8)>>4` (Player.as:406-407; `>>` truncates via ToInt32, and x, y >= 0
  in the world).
- **flying** = `isInGodMode || isInModMode` (Player.as:1897-1899). Both are toggled only from the keyboard (G, P), not
  from `.eetas`.
- AS3 `switch` with duplicate `case` labels takes the first match. Where the source is ambiguous about name resolution,
  the compiled bytecode decides (6.4).

## 1. Order of operations (block-relevant)

**Game loop** (blitter/BlGame.as:144-160, a file with CR-only line endings). Each rendered frame (target 120 fps,
Config.as:78) runs `state.tick()` once per elapsed `Config.physics_ms_per_tick` of wall-clock time (at most 15), then
`state.enterFrame()` once, then draws. `/playtas s` sets `physics_ms_per_tick = 10/s` (UI2.as:2207-2228).

**PlayState.tick** (PlayState.as:534-795), when it steps (TAS replay, or frame advance with Shift+C):
1. `ticks++` (562).
2. Gate display values, each with an overlap revert, in this order (564-575):
   `showCoinGate = coins`, `showBlueCoinGate = bcoins`, `showDeathGate = deaths`. For each one:
   `old = v; v = new; if (world.overlaps(player)) v = old`. That is three separate `overlaps` calls, with side effects (3.2).
3. Keyboard-only actions: god mode toggle with G (656-669), time-trial retry with Shift+R (675-682), editing. None of
   these can come from `.eetas`.
4. `playerOverlaps()` (792, 940-970): curse/zombie/protection spreading between players. With no fake players nothing
   happens (the player is never compared with itself).
5. `super.tick()` calls BlContainer.tick (BlContainer.as:59-63), which ticks the children in insertion order:
   `world` (World.update), then fake players, then `player` (Player.tick).

**World.update** (World.as:137-156): `offset += .3` (animation only), then
`setTimedoor((Global.playState.ticks/100) % 10 >= 5)` (147), then for each color with an active key and
`(ticks - keysTimer[color]) / 100 >= 5`: `PlayState.switchKey(color, false)` (149-153). The for-in order over the `keys`
object is unspecified; it only matters if two keys expire on the same tick and their overlap results interact.

**Player.tick** (Player.as:381-1180), block-relevant steps in order:

| step | what | lines |
|---|---|---|
| a | timed deaths (curse, zombie, fire, poison) | 399-404 |
| b | cell and `current` (half-block adjust) | 406-419 |
| c | retry of a deferred team change (6.4) | 421 |
| d | `current_below` | 423-440 |
| e | delayed-tile queue | 409, 442-447 |
| f | drain `Player.tilequeue` (deferred purple presses) | 449-450 |
| g | input; dead -> inputs zeroed | 452-459 |
| h | forces from `current` (and kills) and from `delayed`; flipGravity rotation | 469-690 |
| i | mx/my, speed/gravity multipliers, slippery, drag by `current`, boosts, dead -> speed 0 | 692-831 |
| j | sub-stepped movement, `processPortals()` at the top of each iteration | 833-935, 1051-1174 |
| k | if alive: jump, then `touchBlock(cx, cy, isgodmod)` | 937-995, Me.as:74-358 |
| l | levitation thrust | 998-1000 |
| m | auto-align (not in liquids) | 1004-1042 |
| n | run timer (`Me.updateStuff`) | 1044, Me.as:374-376 |
| o | death animation over: `respawn(); deaths++` **[eeo-tas change: EE Offline did this in Player.draw]** | 1176-1179 |

**PlayState.enterFrame** (PlayState.as:478-526) runs once per rendered frame, after that frame's ticks. It drains
`queue` (orange switch presses, crown and silver crown checks, 498-501), then `keysquene` (503-507), then the editor's
`tilequeue` (509-513).

**Determinism caveat (real time):** `queue` and `keysquene` retries happen once per frame, not once per tick. With
exactly one tick per frame (frame advance, or a replay where no frame runs two ticks) this is the same as "after every
tick, after Player.tick". At 1x replay (100 ticks/s at 120 fps) most frames run 0 or 1 tick, but a slow frame runs 2+,
and at `/playtas` speeds above about 1.2x that is normal. The retry then happens only after the last tick of the frame.
A sim should specify "drain after every tick", which is exact under the one-tick-per-frame assumption. `Player.tilequeue`
(purple) is drained per tick (step f) and is always deterministic.

## 2. Level data read by blocks

World.deserializeFromMessage (World.as:193-400):
- Each entry is `type, layer, xs[], ys[]`, followed by extra fields chosen by type (259-283):
  - one int "rotation" if `isBlockRotateable || isNonRotatableHalfBlock || isBlockNumbered`, or the type is 77, 83,
    1520, or one of the 7 rotatable spikes 361, 1625, 1627, 1629, 1631, 1633, 1635;
  - portals 242/381: `rotation, id, target`;
  - sign 385: UTF text, int type;
  - world portal 374: UTF target world, int spawn target;
  - label 1000: text, color, wrap;
  - NPCs 1550-1559, 1569-1579: name + 3 messages.
- Cells with x >= width or y >= height are skipped (292). `layers[layer][y][x] = type` (294): later entries overwrite
  earlier ones.
- `lookup.setInt(x, y, rotation)` for the rotatable/half/numbered types (296-298), music (331-336) and the 7 rotatable
  spikes (339-348). **This happens for either layer** (see gap G17). Portal data: `lookup.setPortal` (349-353).
  World portals: 354-357.
- Spawn points (359-366): `spawnPoints[rotation].push([x, y])` for 255 (it carries no int, so `rotation` = 0) and for
  1582 (`rotation` = its spawn id). **Order = entry order in the file, then xs order inside the entry.**
- The label case (374-381) has no `break` and falls into the sign case (cosmetic).

Runtime tile changes: only coin pickup (100 -> 110, 101 -> 111). It goes through `setTileComplex` (World.as:415-549),
which starts with `lookup.deleteLookup` (Lookup.as:43-53): the cell's int, portal, world portal, secret, blink and sign
are all deleted. `resetPlayer` puts the coins back (`World.resetCoins`, 402-409). Editing is out of scope.

Unknown ids: gameplay is purely id-based. An id with no brick definition is still solid if it is in the isSolid ranges
(see the table, section 10).

Drawing code also writes the shared `lookup` for animations: ICE `setNumber` (World.as:1430-1440), 370 (1592-1605), WATER
119 and TOXIC 1585 `setInt` with `Math.random` (1611-1638), and 1586 (1639-1652). None of these ids reads its own
lookup in gameplay, so this is cosmetic.

## 3. Solidity

### 3.1 Id classes (ItemId.as)
- `isSolid` (366-372): `!isClimbable(id) && ((9<=id<=97) || (122<=id<=217) || (1001<=id<=1499)) && id != 83 && id != 77`.
- `isClimbable` (376-394): 98, 99, 118, 120, 424, 459, 460, 472, 1146, 1534, 1563, 1602.
- `canJumpThroughFromBelow` (569-619): 61, 62, 63, 64, 89, 90, 91, 96, 97, 122-127, 146, 154, 158, 194, 211, 216, 1001-1004,
  1050, 1051, 1052-1056, 1069, 1087, 1092, 1147, 1148, 1149, 1155, 1160, 1164, 1165.
- `isRotatableHalfBlock` (664-680): 1001-1004, 1052-1056, 1092, 1155. All of them are also one-way.
- `isHalfBlock` (632-662): 1041-1043, 1075-1078, 1101-1105, 1116-1125, 1140, 1141.
  `isNonRotatableHalfBlock` (554-564): 1101-1105.
- `isLiquid` (699-708): 119, 369, 416, 1585. `isSlippery` (689-697): 1064. `isBoost` (621-630): 114-117.
- `isBlockNumbered` (400-433) and `isBlockRotateable` (441-552) only decide which ids carry an int (section 2).
- Every one-way, half block and door/gate is inside the isSolid ranges. Background ids (500-999) are never solid.

### 3.2 World.overlaps(player) (World.as:604-751)
```
overlaps(p):
  if (p.x < 0 || p.y < 0 || p.x > W*16-16 || p.y > H*16-16) return 1      // 605: outside the world = blocked
  if (p.isFlying) return 0                                                // 608
  ox = int(p.x) >> 4;  oy = int(p.y) >> 4                                 // 610-611
  xEnd = (p.x + 16) / 16;  yEnd = (p.y + 16) / 16                         // 613-614 (Numbers; loops use <)
  skipa = skipb = skipc = skipd = false
  for (cy = oy; cy < yEnd; cy++) for (cx = ox; cx < xEnd; cx++) {         // 622-624, row-major
    val = layer0[cy][cx]
    if (!isSolid(val)) { if (val == 243) setSecret(cx, cy); continue }    // 627-632
    if (!intersects(p.x, p.y, 16, 16,  cx*16, cy*16, 16, 16)) continue    // 633 (positive-area overlap, strict <)
    rot = L(cx, cy)
    if (isRotatableHalfBlock(val)) {                                      // 635-662
      if (rot == 1 && (p.speedY < 0 || cy <= p.overlapa || (p.speedY == 0 && p.speedX == 0 && p.oy + 15 > cy*16)))
        { if (cy != oy || p.overlapa == -1) p.overlapa = cy; skipa = true; continue }   // "up"
      if (rot == 2 && (p.speedX > 0 || (cx <= p.overlapb && p.speedX <= 0 && p.ox < cx*16 + 16)))
        { if (cx != ox || p.overlapb == -1) p.overlapb = cx; skipb = true; continue }   // "right"
      if (rot == 3 && (p.speedY > 0 || (cy <= p.overlapc && p.speedY <= 0 && p.oy < cy*16 + 16)))
        { if (cy != oy || p.overlapc == -1) p.overlapc = cy; skipc = true; continue }   // "down"
      if (rot == 0 && (p.speedX < 0 || cx <= p.overlapd || (p.speedY == 0 && p.speedX < 0 && p.ox - 15 < cx*16)))
        { if (cx != ox || p.overlapd == -1) p.overlapd = cx; skipd = true; continue }   // "left"
      // none matched (or rot outside 0..3): falls through and blocks
    } else if (isHalfBlock(val)) {                                        // 663-680
      part = rot 1: (cx*16, cy*16+8, 16, 8)   bottom half
             rot 2: (cx*16, cy*16, 8, 16)     left half
             rot 3: (cx*16, cy*16, 16, 8)     top half
             rot 0: (cx*16+8, cy*16, 8, 16)   right half
             other: the whole tile (no extra test)
      if (!intersects(player box, part)) continue
    } else if (canJumpThroughFromBelow(val)) {                            // 681-689: plain one-way = the "up" rule
      if (p.speedY < 0 || cy <= p.overlapa || (p.speedY == 0 && p.speedX == 0 && p.oy + 15 > cy*16))
        { if (cy != oy || p.overlapa == -1) p.overlapa = cy; skipa = true; continue }
    }
    door/gate switch (691-741): `continue` when passable (3.3); 50: setSecret, then blocks
    return val                                                            // 743
  }
  if (!skipa) p.overlapa = -1; if (!skipb) p.overlapb = -1               // 746-749 (skipped by an early return)
  if (!skipc) p.overlapc = -1; if (!skipd) p.overlapd = -1
  return 0
```
- `p.speedX/speedY` are the current speeds. Inside a sub-step, stepx may already have zeroed `_speedX` before stepy calls
  overlaps. `p.ox/p.oy` hold the position before the current sub-step (Player.as:927-928). `p.overlapa..d` persist on the
  player (initially -1, Player.as:88-91) and are never reset by respawn or `/reset`.
- Secrets are cosmetic (`secretsLookup`): 243 is revealed whenever it is in the scan range, before the rectangle test;
  50 is revealed when it is the blocking tile.
- Callers, all with the player at its current x, y: sub-step x and y (Player.as:870, 907); PlayState gate displays
  (PlayState.as:566, 571, 575); `switchKey` (221); `pressOrangeSwitch` (233); `checkCrown` (241); `checkSilverCrown`
  (258); `pressPurpleSwitch` (Player.as:1577); `UpdateTeamDoorsById` (Player.as:1594). **Every call has the side
  effects** (overlapa..d reset or set, secrets), so an exact sim must make exactly the same calls.
- `World.Overlaps` (capital O, World.as:584-602) and `ItemManager.GetBlockBounds` (2419-2441) are only used by the
  editor (PlayState.setTile). `AddBlockBounds` is never called.

### 3.3 Doors and gates (World.as:691-741)
A door or gate is a solid tile. It is skipped (`continue`, not blocking) when:

| id | block | not blocking when | line |
|---|---|---|---|
| 23 / 24 / 25 | red / green / blue key door | that key is active | 692-694 |
| 26 / 27 / 28 | red / green / blue key gate | that key is NOT active | 695-697 |
| 1005 / 1006 / 1007 | cyan / magenta / yellow key door | key active | 699-701 |
| 1008 / 1009 / 1010 | cyan / magenta / yellow key gate | key NOT active | 702-704 |
| 156 | time door | `timedoorState` | 706 |
| 157 | time gate | `!timedoorState` | 707 |
| 184 | purple door | `pl.switches[L]` truthy | 709 |
| 185 | purple gate | `!pl.switches[L]` | 710 |
| 1079 | orange door | `orangeSwitches[L]` | 712 |
| 1080 | orange gate | `!orangeSwitches[L]` | 713 |
| 200 | gold door | `pl.wearsGoldSmiley` (the cookie `goldBorder` setting, PlayState.as:128, Player.as:1499-1507) | 715 |
| 201 | gold gate | `!pl.wearsGoldSmiley` | 716 |
| 1094 | crown door | `pl.collideWithCrownDoorGate` | 718 |
| 1095 | crown gate | `!pl.collideWithCrownDoorGate` | 719 |
| 1152 | silver crown door | `pl.collideWithSilverCrownDoorGate` | 721 |
| 1153 | silver crown gate | `!...Silver...` | 722 |
| 43 | coin door | `L <= pl.coins` | 724 |
| 213 | blue coin door | `L <= pl.bcoins` | 725 |
| 1011 | death door | `L <= pl.deaths` | 726 |
| 165 | coin gate | `L > showCoinGate` (other players: `L > coins`) | 727 |
| 214 | blue coin gate | `L > showBlueCoinGate` | 728 |
| 1012 | death gate | `L > showDeathGate` | 729 |
| 1027 | team door | `pl.team == L` | 731 |
| 1028 | team gate | `pl.team != L` | 732 |
| 206 | **zombie GATE** | `!pl.zombie`: open normally, solid while zombie | 734 |
| 207 | **zombie DOOR** | `pl.zombie`: solid normally, open while zombie | 735 |
| 50 | secret "appear" | never; it is revealed and blocks | 737-740 |

`zombie` is a getter that returns false while flying (Player.as:1680-1684). Any other solid id blocks. EEO has no curse or
poison doors/gates (there are no such ids in ItemId.as or ItemManager.as).

### 3.4 State changes with an overlap revert (deferred)
The pattern: set the new state; if the player now overlaps something (`overlaps != 0`), restore the old state and
queue a retry.

| change | code | retried |
|---|---|---|
| key on/off | `PlayState.switchKey(color, state, fromqueue)` (PlayState.as:219-225) calls `World.setKey` (World.as:117-123). The revert is `setKey(color, !state)` with fromqueue=false, so reverting an expiry sets the key back on AND **resets `keysTimer = t`**. | `keysquene`, per frame (503-507), with fromqueue=true. `setKey` returns without change if `(t - keysTimer)/100 >= 5` (120). |
| purple switch | `Player.pressPurpleSwitch(id, en)` (Player.as:1570-1581). id 1000 first recurses over 0..999 (each with its own check), then sets 1000 itself. | `Player.tilequeue` at step f of the next Player.tick. Cleared by `respawn`. |
| orange switch | `PlayState.pressOrangeSwitch` (PlayState.as:227-237), same 1000 rule | `queue`, per frame |
| crown flag | `checkCrown(collide)` (239-245); `removeCrown` (247-254) calls `checkCrown(false)` | `queue` |
| silver crown flag | `checkSilverCrown` (256-262) | `queue` |
| coin / blue coin / death gate display | PlayState.tick (564-575) | the next tick (recomputed every tick) |
| team | `UpdateTeamDoorsById(id, false)` (Player.as:1590-1604) | the next tick's step c (6.4) |

### 3.5 Changes without an overlap revert (they can close a solid on the player)
Time doors (World.as:147). Coin, blue coin and death doors only ever open. Zombie state changes: becoming a zombie closes
the zombie gate 206; protection or respawn curing a zombie closes the zombie door 207. Gold border never changes.
Inside a solid, every sub-step collides (the position is restored and the speed zeroed on that axis) until the tile
opens.

## 4. The current tile, forces and hazards

### 4.1 Cell and current (Player.as:406-419)
`current = getTile(0, cx, cy)` (out of bounds = 0, BlTilemap.as:151). If `isHalfBlock(current)`: `rot = L(cx, cy)`; for
1101-1105 `rot = 1`. `rot == 1 -> cy -= 1`; `rot == 0 -> cx -= 1`; then `current = getTile(0, cx, cy)`. **The adjusted
(cx, cy) is used for everything after this:** touchBlock, pastx/pasty, portal lookup and below. `processPortals`
(1055) re-reads `current` at the same (cx, cy) and gets the same value. So `current` = the tile under the player's
center at the **start** of the tick (before this tick's movement).

### 4.2 Below, and ice (Player.as:423-440, 717-723)
`below` by `current`: 1 or 411 -> (cx-1, cy); 2 or 412 -> (cx, cy-1); 3 -> (cx+1, cy); 4 -> (cx, cy+1). The second
`case 411:` / `case 412:` labels (428-429) are dead code. Every other id, including 413, 414, 1518 and 1519, goes by
flipGravity: 0 -> (cx, cy+1), 1 -> (cx-1, cy), 2 -> (cx, cy-1), anything else (3, 4, >= 5) -> (cx+1, cy).
Slippery: `if (below == 1064 && !isClimbable(current) && current != 4 && current != 414) slippery = 2;
else if (isSolid(below)) slippery = 0; else if (slippery > 0) slippery -= 0.2` (float accumulation). A closed or open
door counts as solid here (raw id).

### 4.3 Delayed tile (Player.as:409, 442-447; `queue` has length 2, Config.as:65)
`delayed = queue.shift(); queue.push(current); if (current is 4, 414 or climbable) { delayed = queue.shift();
queue.push(current) }`. Normally `delayed` = `current` from two ticks ago. On a dot or a climbable it is the previous
tick's current, and the queue becomes [current, current]. Never reset (not by respawn, not by `/reset`).

### 4.4 Forces (Player.as:469-637). Skipped entirely while flying (all four stay 0).
`morx, mory` are **ints** (Player.as:85-86), taken from `current`. `mox, moy` are Numbers, taken from `delayed`.

| tile | current: morx, mory | delayed: mox, moy | rotated by flipGravity |
|---|---|---|---|
| climbable | 0, 0 | 0, 0 | yes (stays 0) |
| 1, 411 | -2, 0 | -2, 0 | no |
| 2, 412 | 0, -2 | 0, -2 | no |
| 3, 413 | 2, 0 | 2, 0 | no |
| 1518, 1519 | 0, 2 | 0, 2 | no |
| 114-117, 4, 414 | 0, 0 | 0, 0 | yes |
| 119 water | 0, int(-0.5) = 0 | 0, -0.5 | yes |
| 369 mud | 0, 0 | 0, 0.4 | yes |
| 416 lava | 0, 0 | 0, 0.2 | yes |
| 1585 toxic | 0, 0 + **kill** | 0, -0.4 | yes |
| 368 fire, spikes 361, 1580, 1625-1636 | 0, 2 + **kill** | (default) 0, 2 | yes |
| anything else | 0, 2 | 0, 2 | yes |

flipGravity rotation (641-690) of (x, y): 1 -> (-y, x); 2 -> (-x, -y); 3 -> (y, -x); 4 -> (0, 0); any other value ->
unchanged. It is applied to the current pair unless `current` is an arrow, and to the delayed pair unless `delayed` is
an arrow. The arrows are 1, 2, 3, 1518, 411, 412, 413 and 1519; dots, boosts and climbables are rotated (they are 0 anyway).
Then (692-707): if `isLiquid(delayed)` then mx = horizontal, my = vertical (free 2D control); else if moy != 0 then
mx = horizontal, my = 0; else if mox != 0 then mx = 0, my = vertical; else both.
`mx, my *= speedMultiplier` (363-369: speedBoost 1 x1.5, 2 x0.6, zombie x0.6). `mox, moy *= gravityMultiplier`
(347-352: low gravity x0.15, then x world gravity).

### 4.5 Kills (Player.as:529-558)
`current` = 1585, 368, 361, 1580 or 1625-1636, and not flying: `if (!isDead && !isInvulnerable) killPlayer()`. This is
checked every tick, before movement, and only the center cell counts (spike rotation is cosmetic). `killPlayer`
(1202-1210) sets `isDead` unless flying. Also, in the same tick, speeds are set to 0 when dead (827-830), and the jump
and touchBlock are skipped (937). Timed deaths: section 6.2.

### 4.6 Drag chosen by current (Player.as:725-805)
Climbable (not flying) -> the "no modifier" drag on both axes. Otherwise, when the no-modifier condition is false:
current 119/369/416/1585 -> water/mud/lava/toxic drag; slippery > 0 -> the ice rules; else base drag. (The constants
belong to the movement spec, Config.as:47-55.)

### 4.7 Boosts (Player.as:807-831, 859, 896)
Not flying: current 114 -> `_speedX = -16`; 115 -> `+16`; 116 -> `_speedY = -16`; 117 -> `+16` (internal units, after
drag). While current is a boost, a negative sub-step also rounds when `reminder == 0` (`reminderX != 0 || isBoost(current)`).

### 4.8 Liquids
Forces and drag as above. Auto-align is off while `isLiquid(current)` and not flying (1009, 1026). Touch rules: lava
sets you on fire; water, mud and toxic extinguish; toxic kills every tick (4.5). 300, 370, 415 and 1586 are cosmetic
surfaces, not liquids.

### 4.9 Portals 242 / 381 (Player.as:1051-1174)
`processPortals()` runs at the top of every sub-step iteration (925). The loop only runs if `_speedX` or `_speedY` is
non-zero at the start of movement, so **a player standing still on a portal never teleports** (and lastPortal is not
cleared either).
```
current = getTile(0, cx, cy)                           // the tick-START cell: cx, cy are not recomputed (1052-1055)
(world portal part, 4.10)
P = lookup.getPortal(cx, cy)                            // Portal(0, 0, 0) if none (Lookup.as:135-138)
if (flying || (current != 242 && current != 381) || P.target == P.id) { lastPortal = null; return }   // 1087-1090
if (lastPortal != null) return
lastPortal = (cx<<4, cy<<4)
list = lookup.getPortals(P.target)                      // every 242/381 whose id == P.target (Lookup.as:155-171),
                                                        // in AS3 for-in order of the portalLookup keys "x"+"x"+"y"
if (list.length <= 0) return                            // lastPortal stays set
cp = list[Math.floor(Math.random() * list.length)]      // randomRange(0, n-1), 1046-1049, 1099: RANDOM if n > 1
oldRot = P.rotation; newRot = rotation of the portal at cp; if (oldRot < newRot) oldRot += 4; dir = oldRot - newRot
osx, osy = speedX, speedY; omx, omy = modifierX, modifierY   (getters); magic = 1.42
dir 1: speedX = osy*m; speedY = -osx*m; modifierX = omy*m; modifierY = -omx*m; reminderY = -reminderX; currentSY = -currentSX
dir 2: speedX = -osx*m; speedY = -osy*m; modifierX = -omx*m; modifierY = -omy*m;
       reminderY = -reminderY; currentSY = -currentSY; reminderX = -reminderX; currentSX = -currentSX
dir 3: speedX = -osy*m; speedY = osx*m; modifierX = -omy*m; modifierY = omx*m; reminderX = -reminderY; currentSX = -currentSY
dir 0: nothing rotated
x = cp.x; y = cp.y; lastPortal = cp
```
Rotations: 0 down, 1 left, 2 up, 3 right (comment at 1106-1111). The setters divide by 7.752. There is at most one
teleport per tick (later iterations see lastPortal != null). On arrival, the next tick's start cell is the exit portal
and lastPortal != null, so there is no bounce. lastPortal becomes null at the first sub-step of a moving tick whose start
cell is not an active portal. Its initial value is a non-null `new Point()` (Player.as:300), and neither respawn nor
`/reset` clears it.

### 4.10 World portal 374 (Player.as:1057-1085)
If not flying and current == 374, for the player: only if the **Y key** (`KeyBinding.risky`, KeyBinding.as:21) is held
(keyboard state, not in `.eetas`) and `!resetSend`. Then `wp = getWorldPortal`; if `wp.id` is non-empty:
`resetSend = true`; if `parseInt(wp.id)` is another loaded world, `campaigns.joinWorld` (another level); otherwise
`resetPlayer(false, false, wp.target)`, a full same-level reset with `worldSpawn = wp.target` (7.4). **In a replay this
never fires** (unless a human holds Y). (The fake-player branch at 1058-1060 reads `wp` before
assigning it; irrelevant for the TAS player.)

## 5. touchBlock (Me.as:74-358)
Called at step k only when alive, with `current` (the tick-start cell's tile, 4.1) and (cx, cy).

### 5.1 Every tick (Me.as:80-129), even while flying
- **100 / 101 coin** (80-124): `setTileComplex(0, cx, cy, current+10)` (the tile becomes 110/111 and the cell's lookup
  is deleted), then `coins++` or `bcoins++` and (cx, cy) is pushed to gx/gy or bx/by. Particles use Math.random
  (cosmetic). 110/111 do nothing for the player.
- **466 reset point** (125-128): `if (isgodmode || !risky.isDown() && isme || resetSend) break; resetPlayer();` This
  needs Y held, so it **never fires in a replay**. It is checked every tick, not only when entering the cell.

### 5.2 On entering a new cell (Me.as:131, 354-355)
The test is `pastx != cx || pasty != cy`, and pastx/pasty are set to (cx, cy) afterwards, even while flying. They start
at (0, 0) and survive respawn and `/reset`. Music 77/83/1520 (133-149), also while flying: plays note/sound `L`, blink
(cosmetic).

### 5.3 On entering, not flying (Me.as:151-352)

| id | effect | lines |
|---|---|---|
| 5 crown | if `!hascrown`: `removeCrown()` (checkCrown(false)), `hascrown = true`, `checkCrown(true)` | 153-160 |
| 113 purple switch | `pressPurpleSwitch(L, !switches[L])` | 162-166 |
| 467 orange switch | `pressOrangeSwitch(L, !orangeSwitches[L])` | 167-171 |
| 1619 purple reset | `if (L == 1000 or switches[L]) pressPurpleSwitch(L, false)` | 173-178 |
| 1620 orange reset | `if (L == 1000 or orangeSwitches[L]) pressOrangeSwitch(L, false)` | 179-184 |
| 411-414, 460, 1519 | blink (cosmetic) | 186-191 |
| 241 / 337 / 397 | smiley frame 31 / `Random.nextInt(72,76)` / 100 (cosmetic; frame never affects physics) | 193-198 |
| 360 checkpoint | `checkpoint = (cx, cy)` | 200-203 |
| 121 trophy | if `!hascrownsilver && !resetSend`: `hascrownsilver = true; completed = true` (stops the run timer); `checkSilverCrown(true)`; win screen | 205-217 |
| 1516 god block | enables the G key (UI only) | 218-229 |
| 1583 map block | enables the minimap (UI only) | 230-239 |
| 6, 7, 8, 408, 409, 410 keys | `switchKey(color, true)`: key on, `keysTimer = t` (refreshed on every entry) | 242-250 (colors: 17-24) |
| 417 jump | `n = L; if (n != jumpBoost) jumpBoost = n` | 253-258 |
| 418 fly | `b = L != 0; if (b != hasLevitation) hasLevitation = b` (false also sets thrust to 0, 1838-1844) | 259-264 |
| 419 run | `speedBoost = L` if different | 265-270 |
| 453 low gravity | `low_gravity = L != 0` | 271-276 |
| 421 curse | `c = L > 0; if (c == cursed or invulnerable) break; cursed = c; setEffect(curse, c, 0, L)` | 277-282 |
| 422 zombie | same pattern with `zombie` | 283-288 |
| 1584 poison | same pattern with `poison` | 289-294 |
| 1573 zombie NPC | `if (zombie or invulnerable) break; zombie = true; setEffect(zombie, true)`: duration 0 = **no death timer** | 295-299 |
| 420 protection | `b = L != 0; if (b == invulnerable) break; invulnerable = b; if b: cursed = zombie = poison = onFire = false` | 300-315 |
| 1618 reset | `resetEffects(false)` (6.1) | 316-318 |
| 423 team | `UpdateTeamDoors(cx, cy)` (6.4) | 320-323 |
| 416 lava | `if (onFire or invulnerable) break; onFire = true; setEffect(fire, true, 0, 2)` | 325-329 |
| 119, 369, 1585 | `if (onFire) onFire = false` | 330-336 |
| 461 multijump | `j = L; if (j != maxJumps) maxJumps = j` | 337-342 |
| 1517 gravity | `g = L; if (g != flipGravity) flipGravity = g` | 343-348 |

Since touchBlock runs after movement, anything it changes takes effect from the next tick's physics. Crowns, the trophy
and switches go through the deferred flags of 3.4.

## 6. Effects

### 6.1 State, use, reset

| effect | state (Player.as) | used by | cleared by |
|---|---|---|---|
| jump 417 | `jumpBoost` int (L) | jumpMultiplier: 1 -> x1.3, 2 -> x0.75, anything else -> x1; also zombie x0.75, slippery > 0 x0.88 (354-361) | reset 1618, resetPlayer |
| run 419 | `speedBoost` int | speedMultiplier: 1 -> x1.5, 2 -> x0.6 | reset, resetPlayer |
| fly 418 | `hasLevitation` | 6.3 | reset, resetPlayer |
| protection 420 | `isInvulnerable` | no spike/fire/toxic death (532, 554), no lava fire, no curse/zombie/poison pickup; turning it on clears curse, zombie, poison and fire | reset, resetPlayer |
| low gravity 453 | `low_gravity` | gravity x0.15 (349) | reset, resetPlayer |
| multijump 461 | `maxJumps` = L (1000 = infinite: jumpCount is never incremented, 975/983; 0 = no jumps; the editor stores -1 as 1000, PlayState.as:1519) | jumps 966-990; standing (current) on 461 sets jumpCount = 0 every tick (966) | reset -> 1 |
| gravity 1517 | `flipGravity` = L: 0 down, 1 left, 2 up, 3 right, 4 none (ui/brickoverlays/GravityProperties.as:23-29) | 4.2, 4.4 | reset -> 0 |
| curse 421 | `cursed`, `curseTimeStart`, `curseDuration` | timed death | respawn, protection, resetPlayer (NOT reset 1618) |
| zombie 422 / NPC 1573 | `zombie` + timer | speed x0.6, jump x0.75, doors 206/207, timed death | respawn, protection, resetPlayer |
| poison 1584 | `poison` + timer | timed death | respawn, protection, resetPlayer |
| fire (lava 416) | `isOnFire` + timer | timed death | water/mud/toxic entry, protection, respawn, resetPlayer |
| team 423 | `team` | team doors/gates | 6.4 |

`resetEffects(resetTimed)` (1817-1821) calls `setEffect(x, false)` for jump, fly, run, protection, low gravity,
multijump (`maxJumps = 1`) and gravity (`flipGravity = arg = 0`), and with `resetTimed` also for curse, zombie, fire and
poison. `setEffect`'s `case effectReset` falls through into effectJump (1732-1737). Nothing calls it with effectReset.

### 6.2 Timed deaths **[eeo-tas change: EE Offline used wall-clock Date ms]**
`setEffect(effect, active, arg, duration)` (1724-1798): `if (duration > 0) { if (!arg) arg = state.ticks;
duration += 2 * Global.ping; duration *= 100 }` with `Global.ping = 0.2` (Global.as:166-169). It stores
`start = arg = t0` (the tick of the touch) and `D = duration`. At the start of every Player.tick while alive (399-404):
`if (cursed && curseDuration && t - curseTimeStart > curseDuration) killPlayer()`, and the same for zombie, isOnFire and
poison.
**So a player cursed at tick t0 dies at the first t with `t - t0 > D`, i.e. t = t0 + floor(D) + 1**, where
`D = ((d + 2*0.2) * 100)` evaluated in IEEE double exactly in that order (JS gives identical doubles: write it literally).
d = L seconds (lava: d = 2, so D = 240 and death comes 241 ticks later). For most d, D = 100d + 40 exactly. For
d in 16-20 and 256-327, D = 100d + 39.999..., so death comes one tick earlier (t0 + 100d + 40). For d = 4 and 64-81, D is
just above the integer, which changes nothing. With D = 0 (NPC zombie) there is no timer. Re-touching the same effect
while it is active does nothing (the state is unchanged), so the timer is not refreshed. A block with L = 0 removes the
effect.

### 6.3 Levitation (fly 418) (Player.as:937-1000, 1846-1895)
```
if (!isDead) {
  injump = spacejustdown
  if (spacedown) { if (hasLevitation) { isThrusting = true; _currentThrust = 0.2 }   // applyThrust
                   else held-jump repeat via new Date() (irrelevant in replay) }
  else isThrusting = false
  jumpCount logic (966-971)
  if (injump && !hasLevitation) { normal jumps }            // levitation disables jumping
  touchBlock
}
if (hasLevitation) {                                         // updateThrust, runs even while dead
  if (mory != 0) speedY -= _currentThrust * (26/2) * (mory * 0.5)   // getter/setter: internal /7.752
  if (morx != 0) speedX -= _currentThrust * (26/2) * (morx * 0.5)
  if (!isThrusting) { if (_currentThrust > 0) _currentThrust -= 0.01; else _currentThrust = 0 }
}
```
`morx/mory` are this tick's current-tile ints after rotation (±2 or 0, so `*0.5` gives ±1). On dots, climbables and
liquids there is no thrust force. After release the thrust decays 0.2, 0.19, ..., 0.00999...97, -3.1e-17, then 0
(the force is applied before the decay, so the tiny negative value is applied once). Since `isThrusting` is only
cleared inside `!isDead`, it keeps its value while dead. In a replay `spacedown` = the jump bit.

### 6.4 Team (423, 1027, 1028)
```
touch 423 (entering, not flying; Me.as:320-323):  UpdateTeamDoors(cx, cy)
UpdateTeamDoors(x, y)          (Player.as:1583-1588): id = L(x, y); this.tx = x; this.ty = y; UpdateTeamDoorsById(id, false)
UpdateTeamDoorsById(id, force) (Player.as:1590-1604):
  oid = team; if (team == id) return                // NOTE: this.tx/ty stay set
  team = id
  if (!force && overlaps(player)) team = oid        // deferred: tx/ty stay set, so it is retried
  else this.tx = this.ty = -1
step c of every Player.tick (Player.as:421):  if (this.tx != -1) UpdateTeamDoors(this.tx, this.ty)
```
- `team` starts at 0 (Player.as:233). Only this code and resetPlayer (`team = 0`, Player.as:1281, which leaves
  tx/ty alone) change it. Respawn keeps it. Doors: 1027 is passable iff `team == L`, 1028 iff `team != L`.
- The retry at step c runs before movement, at the tick-start position. It calls `overlaps` (with its side effects,
  3.2) only when `team != L(tx, ty)`. If tx/ty still point at a cell whose L equals `team` (after the early return),
  step c calls UpdateTeamDoors every tick but returns before any overlaps call. That is invisible, except that after a
  resetPlayer (`team = 0`) the lingering tx/ty would restore that team (with an overlap check).
- **Source vs. bytecode.** `tick()` also declares the locals `var tx:Number` (1012) and `var ty:Number` (1029) in the
  auto-align code. With ECMAScript hoisting, line 421 would read those NaN locals and call `UpdateTeamDoors(0, 0)` every
  tick. The compiled EE Offline (`~\Downloads\EE_Offline.swf`, Player.tick bytecode offsets 743-762:
  `getlocal0; getproperty private::tx; pushbyte -1; ifeq; ...; callpropvoid UpdateTeamDoors`) reads the **members**.
  The locals are activation slots 27/28, used only by auto-align (offset 5689 and later). eeo-tas has the same source
  line and project setup, so assume member semantics, as above. No compiled eeo-tas was available to check. If a level
  depends on teams, confirm it with a team block next to its own team door.
  (`eeo_spec/movement.md` assumes the hoisted-local reading; the bytecode contradicts that.)

## 7. Death, respawn, spawn points, checkpoints, reset

### 7.1 Death and respawn
`killPlayer` (1202-1210). While dead: inputs are zeroed from the next tick on (454-459), speeds are 0 every tick (827-830),
there is no jump or touchBlock, and `deadoffset += .3` per tick (395; 0 while alive). At the end of the tick where
`deadoffset > 16` (the 54th tick after the kill tick) comes `respawn(); deaths++` (1176-1179). This is at the end of
Player.tick, i.e. **before** that frame's PlayState.enterFrame queues and before the next tick's gate displays.
`respawn` (1240-1263): modifiers and speeds set to 0, `isDead = false`, `isOnFire = false`, `resetSend = false`,
**`tilequeue = []`** (pending purple presses are dropped), `placeAtSpawn(true)`, and curse, zombie, fire and poison off.
It keeps: jump/run/fly/protection/low gravity/multijump/gravity, team, keys, switches, coins, crowns, pastx/pasty,
lastPortal, the delayed queue, slippery, jumpCount, overlapa..d and deadoffset (which becomes 0 on the next tick).

### 7.2 placeAtSpawn(checkpoint) (Player.as:1212-1238)
```
nx = ny = 1
if (checkpoint && checkpoint_x != -1) { nx = checkpoint_x; ny = checkpoint_y }
else if (spawnPoints.length > 0) {
  if (!spawnPoints[worldSpawn]) spawnPoints[worldSpawn] = []
  id = spawnPoints[worldSpawn].length > 0 ? worldSpawn : 0
  if (!nextSpawnPos[id] || nextSpawnPos[id] >= spawnPoints[id].length) nextSpawnPos[id] = 0
  if (spawnPoints[id].length > 0) { [nx, ny] = spawnPoints[id][nextSpawnPos[id]]; nextSpawnPos[id]++ }
}
x = nx*16; y = ny*16
```
- `spawnPoints[0]` holds **all 255 tiles and all 1582 tiles with L == 0, in file order** (section 2). `spawnPoints[k]`
  holds the 1582 tiles with L == k. `worldSpawn` is 0 unless a world portal or a level join set it.
- With no spawn at all, the position is (16, 16). If `spawnPoints` is non-empty but list 0 is empty (only 1582 tiles
  with L != 0), the position is also (16, 16).
- **Spawns are round-robin**: every placement without a checkpoint uses the next index. The PlayState constructor
  places once (PlayState.as:122-123, index 0). Every `/reset` (resetPlayer -> respawn) and every death without a
  checkpoint places once more. So the TAS start index is (number of earlier placements) mod n. After just "load level,
  /reset", a level with n >= 2 spawns starts at **index 1**. `/resetall` (UI2.as:1706-1710) clears `nextSpawnPos`
  before its own placement, which gives index 0. It does not zero `PlayState.ticks`, though; only `/reset` does.

### 7.3 Checkpoint 360
Set on entering the cell (not flying). Only `resetPlayer` clears it (`resetCheckpoint`, 1309-1312).

### 7.4 resetPlayer(load, clear, worldSpawnID = -1) (Player.as:1265-1297)
Returns at once if flying (and not load/clear). Then: `worldSpawn = worldSpawnID` if >= 0; `hascrown = hascrownsilver =
false`; `checkCrown(false)` and `checkSilverCrown(false)` (both can defer); crown flags false; `deaths = 0`; coins 0;
`isDead = false`; `resetEffects(true)`; checkpoint (-1, -1); `switches = {}` (purple, **no overlap check**); `team = 0`;
if worldSpawnID == -1, `Me.ticks = 0`; `completed = false`; `world.resetCoins()`; gx/gy/bx/by cleared; secrets cleared;
`respawn()`.
It does NOT reset: orange switches, keys and keysTimer, the time door, `PlayState.ticks` (the `/reset` command zeroes it
separately, UI2.as:1703), `nextSpawnPos`, lastPortal, the delayed queue, pastx/pasty, slippery, jumpCount, overlapa..d,
and the gate display values.

## 8. What is not deterministic per tick

| mechanism | source | status |
|---|---|---|
| portal whose target id has more than one portal | `Math.random` (Player.as:1046-1049, 1099) over the AS3 for-in order of `portalLookup` (Lookup.as:159) | **random**, and the list order is unspecified: only the chosen exit position is meaningful |
| orange switch, crown, silver crown and key retries | per rendered frame (PlayState.as:498-507; BlGame.as:147-155) | deterministic only with <= 1 tick per frame |
| reset point 466, world portal 374 | Y key (Me.as:126, Player.as:1061) | keyboard; never in a pure replay |
| god/mod mode (flying) | G / P keys (PlayState.as:656, UI2.as:2414) | keyboard |
| held-jump repeat | `new Date()` (Player.as:275, 941, 952-960, 980, 988) | irrelevant: the eetas jump bit sets `spacejustdown` too (Me.as:43-44) |
| cake smiley, coin particles, ice shimmer, eyes 1502, fireworks 1581, bubbles 370/1586, water/toxic ripples, world portal particles, death animation | `Math.random` | cosmetic only |
| keys, time doors, curse/zombie/poison/fire | `PlayState.ticks` **[eeo-tas change]** | deterministic given the initial `T0` |
| gold door/gate | cookie `goldBorder` (PlayState.as:128) | fixed per session: a sim option |

## 9. Initial state a sim must be given (not reset by `/reset`)
`T0 = PlayState.ticks` (0 after `/reset`); `nextSpawnPos` (7.2); orange switches and active keys with their
`keysTimer` (an old key stays active until `t >= keysTimer + 500`); `pastx/pasty` (the spawn cell counts as "entered"
on the first tick unless it equals them); lastPortal; the delayed queue; slippery; jumpCount; overlapa..d; the gate
display values; `wearsGoldSmiley`.
To get T0 = 0 and spawn index 0: `/reset` (ticks = 0, stepping stops), then `/resetall` (spawn index 0; no tick runs
while stepping is off), then `/playtas`. `/reset` alone gives T0 = 0, but the spawn index is (earlier placements) mod n.
Even then, the delayed queue, pastx/pasty, lastPortal, slippery, jumpCount and overlapa..d keep whatever the pre-reset
play left behind. They only matter if the first ticks read them: spawning on a special block, a delayed arrow/liquid,
ice below, or a one-way under the spawn.

## 10. Per-id table

Flags: `S` solid (`isSolid`), `C` climbable, `1W` one-way (`canJumpThroughFromBelow`), `R1W` rotatable one-way, `H` half
block, `LQ` liquid. `L:int` means the level stores an int for the cell (read with `L(x,y)`); `L:portal`,
`L:wportal`, `L:sign`, `L:label` and `L:npc` mean other extra data. Render layer: fg/deco/above = layer 0 in the file;
bg = layer 1. The package and name come from ItemManager.as (`createBrick` and `addNpc` calls; `blocks.json` also gives
the ItemManager.as line). "Background (layer 1)" rows are ids that ItemManager places in the background layer; in a
file they appear in layer 1, which physics never reads. Behavior is the same regardless of the ItemManager layer:
everything is id-based.

| id | name (ItemId constant or tags) | package | render layer | flags | behavior in eeo-tas |
|---|---|---|---|---|---|
| 0 | Clear Empty Delete | gravity | bg |  | Empty. Air. |
| 1 | Left Arrow | gravity | deco |  | Gravity arrow left. current: morx,mory = -2,0; delayed: mox,moy = -2,0; NOT rotated by flipGravity. below = (cx-1,cy). §4.2, §4.4 |
| 2 | Up Arrow | gravity | deco |  | Gravity arrow up. current (0,-2), delayed (0,-2), not rotated. below = (cx,cy-1). §4.4 |
| 3 | Right Arrow | gravity | deco |  | Gravity arrow right. current (2,0), delayed (2,0), not rotated. below = (cx+1,cy). §4.4 |
| 4 | Dot | gravity | deco |  | Gravity dot: no gravity (current and delayed 0,0; rotation keeps 0). Flushes the delayed queue (§4.3). Ice below does not set slippery while current is 4. below = (cx,cy+1). §4.4 |
| 5 | CROWN | crown | deco |  | Crown. Touch (entering, not flying): if !hascrown: removeCrown() (checkCrown(false)), hascrown = true, checkCrown(true) (deferred by overlap). Crown doors/gates 1094/1095. The tile stays. §5.3 |
| 6 | KEY_RED | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 7 | KEY_GREEN | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 8 | KEY_BLUE | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 9 | Grey Gray Taupe | basic | fg | S | Solid. |
| 10 | Blue Dark Blue Cobalt | basic | fg | S | Solid. |
| 11 | Purple Pink Plum | basic | fg | S | Solid. |
| 12 | Red Magenta Vermillion | basic | fg | S | Solid. |
| 13 | Yellow Lime Chartreuse | basic | fg | S | Solid. |
| 14 | Green Kelly Emerald | basic | fg | S | Solid. |
| 15 | Blue Cyan Light Blue | basic | fg | S | Solid. |
| 16 | Brown Orange Soil | brick | fg | S | Solid. |
| 17 | Blue Cyan Turquoise | brick | fg | S | Solid. |
| 18 | Purple Dark Violet | brick | fg | S | Solid. |
| 19 | Green Grass | brick | fg | S | Solid. |
| 20 | Red Maroon Hell | brick | fg | S | Solid. |
| 21 | Beige Tan Olive | brick | fg | S | Solid. |
| 22 | Caution Warning Hazard | generic | deco | S | Solid. |
| 23 | Red Magenta | doors | deco | S | Key door (23 red, 24 green, 25 blue): solid unless that key is active. §3.3 |
| 24 | Green | doors | deco | S | Key door (23 red, 24 green, 25 blue): solid unless that key is active. §3.3 |
| 25 | Blue | doors | deco | S | Key door (23 red, 24 green, 25 blue): solid unless that key is active. §3.3 |
| 26 | Red Magenta | gates | deco | S | Key gate (26 red, 27 green, 28 blue): solid while that key is active. §3.3 |
| 27 | Green | gates | deco | S | Key gate (26 red, 27 green, 28 blue): solid while that key is active. §3.3 |
| 28 | Blue | gates | deco | S | Key gate (26 red, 27 green, 28 blue): solid while that key is active. §3.3 |
| 29 | Silver White Iron | metal | fg | S | Solid. |
| 30 | Orange Bronze Amber | metal | fg | S | Solid. |
| 31 | Yellow Gold Jasmine | metal | fg | S | Solid. |
| 32 | Face Smiley Yellow | generic | deco | S | Solid. |
| 33 | Black Dark Standard | generic | deco | S | Solid. |
| 34 | Left Soil | grass | deco | S | Solid. |
| 35 | Middle Soil | grass | fg | S | Solid. |
| 36 | Right Soil | grass | deco | S | Solid. |
| 37 | Purple Pink Magenta | beta | fg | S | Solid. |
| 38 | Green Emerald Malachite | beta | fg | S | Solid. |
| 39 | Blue Sapphire | beta | fg | S | Solid. |
| 40 | Red Ruby Garnet | beta | fg | S | Solid. |
| 41 | Yellow Gold Jasmine | beta | fg | S | Solid. |
| 42 | Grey Gray Taupe | beta | fg | S | Solid. |
| 43 | COINDOOR | coins | deco | S L:int | Coin door. L = count. Passable iff L <= coins (immediate, no revert). §3.3 |
| 44 | Black Pure Old | secrets | fg | S | Black block. Solid (id range), no special rule. |
| 45 | X Crate Metal | factory | fg | S | Solid. |
| 46 | Concrete Grey Gray | factory | fg | S | Solid. |
| 47 | Wood Tree Wooden | factory | fg | S | Solid. |
| 48 | X Crate Wooden | factory | fg | S | Solid. |
| 49 | Silver Metal Scales | factory | fg | S | Solid. |
| 50 | Appear | secrets | deco | S | Secret "appear" block. Solid. Every overlaps() that reaches it (after the rect test) marks it revealed (cosmetic) and returns it as blocking. §3.2 |
| 51 | Red Light red Pink | glass | fg | S | Solid. |
| 52 | Pink Magenta Purple | glass | fg | S | Solid. |
| 53 | Purple Violet Amethyst | glass | fg | S | Solid. |
| 54 | Blue Sapphire | glass | fg | S | Solid. |
| 55 | Cyan Light blue Diamond | glass | fg | S | Solid. |
| 56 | Green Light green Emerald | glass | fg | S | Solid. |
| 57 | Yellow Light yellow Jasmine | glass | fg | S | Solid. |
| 58 | Orange Light orange Topaz | glass | fg | S | Solid. |
| 59 | Sand Environment | summer 2011 | fg | S | Solid. |
| 60 | Pink Cotton Candy Fairy Floss | candy | fg | S | Solid. |
| 61 | Platform Magenta Pink | candy | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 62 | Platform Red One-Way | candy | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 63 | Platform Cyan One-Way | candy | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 64 | Platform Green One-Way | candy | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 65 | Candy Cane Red | candy | deco | S | Solid. |
| 66 | Cake Licorice Hamburger | candy | deco | S | Solid. |
| 67 | Gingerbread Chocolate Brown | candy | deco | S | Solid. |
| 68 | Brick Gray Grey | halloween 2011 | fg | S | Solid. |
| 69 | Basic Gray Grey | halloween 2011 | fg | S | Solid. |
| 70 | Red Ruby | minerals | fg | S | Solid. |
| 71 | Pink Magenta Purple | minerals | fg | S | Solid. |
| 72 | Blue Indigo Sapphire | minerals | fg | S | Solid. |
| 73 | Cyan Light blue Aquamarine | minerals | fg | S | Solid. |
| 74 | Green Lime Emerald | minerals | fg | S | Solid. |
| 75 | Yellow Jasmine | minerals | fg | S | Solid. |
| 76 | Orange Topaz | minerals | fg | S | Solid. |
| 77 | PIANO | music | deco | L:int | Piano. NOT solid (explicit exception in isSolid). Entering (also flying): plays note L, blink. Cosmetic for L in -27..60; any other L throws RangeError (pianoSounds[L + 27], 88 sounds) and aborts the rest of every tick that starts in the cell (eesim: tick_aborted). |
| 78 | Yellow | christmas 2011 | fg | S | Solid. |
| 79 | White | christmas 2011 | fg | S | Solid. |
| 80 | Red | christmas 2011 | fg | S | Solid. |
| 81 | Blue | christmas 2011 | fg | S | Solid. |
| 82 | Green | christmas 2011 | fg | S | Solid. |
| 83 | DRUMS | music | deco | L:int | Drums. NOT solid (explicit exception). Entering: plays sound L, blink. Cosmetic for L in 0..19; any other L throws RangeError (20 drum sounds) and aborts the rest of every tick that starts in the cell. |
| 84 | Red Screen Panel | sci-fi | fg | S | Solid. |
| 85 | Blue Screen Panel | sci-fi | fg | S | Solid. |
| 86 | Metal Gray Bumpy | sci-fi | fg | S | Solid. |
| 87 | Metal White Grey | sci-fi | fg | S | Solid. |
| 88 | Brown Camouflauge Leopard | sci-fi | fg | S | Solid. |
| 89 | Platform Red One-way | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 90 | Platform Blue One-way | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 91 | Platform Green One-way | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 92 | Wall Brick Grey | prison | fg | S | Solid. |
| 93 | Wood Planks Board | pirate | fg | S | Solid. |
| 94 | Chest Treasure Loot | pirate | fg | S | Solid. |
| 95 | Gray Grey | stone | fg | S | Solid. |
| 96 | Platform White One-way | dojo | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 97 | Platform Gray Grey | dojo | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 98 | VINE_V | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 99 | VINE_H | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 100 | COIN_GOLD | coins | above |  | Gold coin. Not solid. Touch every tick (also flying): tile -> 110, lookup at the cell deleted, coins++. §5.1 |
| 101 | COIN_BLUE | coins | above |  | Blue coin. Not solid. Touch every tick (also flying): tile -> 111, bcoins++. §5.1 |
| 110 | COLLECTEDCOIN | coins | deco |  | Collected gold / blue coin. Not solid, no effect. resetPlayer turns it back into 100 / 101. |
| 111 | COLLECTEDBLUECOIN | coins | deco |  | Collected gold / blue coin. Not solid, no effect. resetPlayer turns it back into 100 / 101. |
| 113 | SWITCH_PURPLE | switches | deco | L:int | Purple switch. L = switch id. Touch (entering, not flying): pressPurpleSwitch(L, !switches[L]) (per player, overlap-deferred via Player.tilequeue; L=1000 toggles 0..999 and 1000). §5.3, §3.4 |
| 114 | SPEED_LEFT | boost | deco |  | Boost left: current -> forces 0; after drag _speedX = -16 (internal units). While current, negative sub-steps round at reminder 0 too. §4.7 |
| 115 | SPEED_RIGHT | boost | deco |  | Boost right: _speedX = +16. §4.7 |
| 116 | SPEED_UP | boost | deco |  | Boost up: _speedY = -16. §4.7 |
| 117 | SPEED_DOWN | boost | deco |  | Boost down: _speedY = +16. §4.7 |
| 118 | CHAIN | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 119 | WATER | liquids | above | LQ | Water (liquid). delayed: moy = -0.5 (buoyancy, rotated by flipGravity), free 2D input; current: water drag, no auto-align. Touch (entering, not flying): extinguishes fire. §4.8 |
| 120 | NINJA_LADDER | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 121 | BRICK_COMPLETE | crown | above |  | Trophy (complete, silver crown). Not solid (121 < 122). Touch (entering, not flying): if !hascrownsilver: hascrownsilver = true, completed = true (run timer Me.ticks stops), checkSilverCrown(true) (deferred by overlap), win screen. §5.3 |
| 122 | Brown Wood Platform | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 123 | Red Wood Platform | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 124 | Blue Wood Platform | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 125 | Dark Brown Wood | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 126 | Dark Red Wood | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 127 | Dark Blue Wood | wild west | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 128 | Green Light Green Lime | plastic | deco | S | Solid. |
| 129 | Red | plastic | deco | S | Solid. |
| 130 | Yellow | plastic | deco | S | Solid. |
| 131 | Light Blue Cyan | plastic | deco | S | Solid. |
| 132 | Blue Indigo | plastic | deco | S | Solid. |
| 133 | Purple Magenta Pink | plastic | deco | S | Solid. |
| 134 | Green | plastic | deco | S | Solid. |
| 135 | Orange | plastic | deco | S | Solid. |
| 136 | Disappear | secrets | deco | S | Secret "disappear" block. Solid (122..217) and invisible (only drawn when editing+flying). No special rule. |
| 137 | White Beige | sand | fg | S | Solid. |
| 138 | Grey Gray | sand | fg | S | Solid. |
| 139 | Yellow | sand | fg | S | Solid. |
| 140 | Yellow Orange | sand | fg | S | Solid. |
| 141 | Brown Light | sand | fg | S | Solid. |
| 142 | Brown Dark Dirt | sand | fg | S | Solid. |
| 143 | Center Middle White | cloud | fg | S | Solid. |
| 144 | Diamond plating Plate Metal | industrial | fg | S | Solid. |
| 145 | Wiring Wires Metal | industrial | fg | S | Solid. |
| 146 | Platform One-Way One Way | industrial | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 147 | Scissor Scaffolding X | industrial | deco | S | Solid. |
| 148 | Lift Table Piston | industrial | deco | S | Solid. |
| 149 | Tube Plate Piston | industrial | fg | S | Solid. |
| 150 | Conveyor belt Left Metal | industrial | deco | S | Solid. |
| 151 | Conveyor belt Middle Metal | industrial | deco | S | Solid. |
| 152 | Conveyor belt Middle Metal | industrial | deco | S | Solid. |
| 153 | Conveyor belt Right Metal | industrial | deco | S | Solid. |
| 154 | Platform Wood Ship | pirate | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 156 | TIMEDOOR | timed | deco | S | Time door. Passable iff timedoorState = ((t/100) % 10 >= 5), i.e. t mod 1000 in [500, 999]. No overlap revert. §3.3, §3.5 |
| 157 | TIMEGATE | timed | deco | S | Time gate. Passable iff !timedoorState (t mod 1000 in [0, 499]). §3.3 |
| 158 | Platform Stone | medieval | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 159 | Brick Stone | medieval | fg | S | Solid. |
| 160 | Brick Arrow slit Stone | medieval | fg | S | Solid. |
| 162 | Parapet Stone | medieval | deco | S | Solid. |
| 163 | Barrel Keg | medieval | deco | S | Solid. |
| 165 | COINGATE | coins | deco | S L:int | Coin gate. L = count. Passable iff L > showCoinGate (updated at the start of each PlayState tick with overlap revert). §3.3, §3.4 |
| 166 | Left | pipes | fg | S | Solid. |
| 167 | Horizontal | pipes | fg | S | Solid. |
| 168 | Right | pipes | fg | S | Solid. |
| 169 | Up | pipes | fg | S | Solid. |
| 170 | Vertical | pipes | fg | S | Solid. |
| 171 | Down | pipes | fg | S | Solid. |
| 172 | White Metal Plate | outer space | fg | S | Solid. |
| 173 | Blue Metal Plate | outer space | fg | S | Solid. |
| 174 | Green Metal Plate | outer space | fg | S | Solid. |
| 175 | SMILEY_PLATINUM_SPENDER | outer space | fg | S | Solid. |
| 176 | Sand Mars Orange | outer space | fg | S | Solid. |
| 177 | Mars Orange Sandstone | desert | fg | S | Solid. |
| 178 | Mars Orange Sandstone | desert | fg | S | Solid. |
| 179 | Mars Orange Sandstone | desert | fg | S | Solid. |
| 180 | Mars Orange Sandstone | desert | fg | S | Solid. |
| 181 | Mars Orange Sandstone | desert | fg | S | Solid. |
| 182 | Black Dark Coal | basic | fg | S | Solid. |
| 184 | DOOR_PURPLE | switches | deco | S L:int | Purple door. Passable iff switches[L]. §3.3 |
| 185 | GATE_PURPLE | switches | deco | S L:int | Purple gate. Passable iff !switches[L]. §3.3 |
| 186 | Gray Grey | checker | deco | S | Solid. |
| 187 | Blue | checker | deco | S | Solid. |
| 188 | Purple Magenta Pink | checker | deco | S | Solid. |
| 189 | Red Magenta | checker | deco | S | Solid. |
| 190 | Yellow Lime | checker | deco | S | Solid. |
| 191 | Green | checker | deco | S | Solid. |
| 192 | Cyan Blue | checker | deco | S | Solid. |
| 193 | Idol Face Brick | jungle | deco | S | Solid. |
| 194 | Platform Old Mossy | jungle | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 195 | Brick Grey Gray | jungle | fg | S | Solid. |
| 196 | Brick Red Pink | jungle | fg | S | Solid. |
| 197 | Brick Blue Ruins | jungle | fg | S | Solid. |
| 198 | Brick Yellow Olive | jungle | fg | S | Solid. |
| 199 | Pot Jar Clay | jungle | deco | S | Solid. |
| 200 | DOOR_GOLD | gold | deco | S | Gold door. Passable iff the player wears the gold smiley border (cookie goldBorder). §3.3 |
| 201 | GATE_GOLD | gold | deco | S | Gold gate. Passable iff the player does NOT wear the gold border. §3.3 |
| 202 | Yellow | lava | fg | S | Solid. |
| 203 | Orange | lava | fg | S | Solid. |
| 204 | Orange Red | lava | fg | S | Solid. |
| 206 | ZOMBIE_GATE | zombie | deco | S | Zombie GATE. Passable iff NOT zombie (solid while zombie). §3.3 |
| 207 | ZOMBIE_DOOR | zombie | deco | S | Zombie DOOR. Passable iff zombie (solid while not zombie). §3.3 |
| 208 | Brick White Ancient | marble | fg | S | Solid. |
| 209 | Brick Green Ancient | marble | fg | S | Solid. |
| 210 | Brick Red Pink | marble | fg | S | Solid. |
| 211 | Column Platform Top | marble | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 212 | Hay Yellow Haybale | farm | deco | S | Solid. |
| 213 | BLUECOINDOOR | coins | deco | S L:int | Blue coin door. Passable iff L <= bcoins. §3.3 |
| 214 | BLUECOINGATE | coins | deco | S L:int | Blue coin gate. Passable iff L > showBlueCoinGate. §3.3 |
| 215 | Snow Environment | christmas 2014 | fg | S | Solid. |
| 216 | Ice Snow Platform | christmas 2014 | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 218 | Red Bulb Round | christmas 2011 | deco |  | No effect (air for physics). |
| 219 | Green Bulb Round | christmas 2011 | deco |  | No effect (air for physics). |
| 220 | Blue Bulb Round | christmas 2011 | deco |  | No effect (air for physics). |
| 221 | Circle Wreath Garland | christmas 2011 | deco |  | No effect (air for physics). |
| 222 | Star Yellow Night | christmas 2011 | deco |  | No effect (air for physics). |
| 223 | Cup Trophy Halloween | Prizes | above |  | No effect (air for physics). |
| 224 | Grave Tombstone Headstone | halloween 2011 | above |  | No effect (air for physics). |
| 225 | Cobweb Spider Web Right | halloween 2011 | above |  | No effect (air for physics). |
| 226 | Cobweb Spider Web Left | halloween 2011 | above |  | No effect (air for physics). |
| 227 | Cream Small Creme | candy | above |  | No effect (air for physics). |
| 228 | Umbrella Parasol Beach | summer 2011 | above |  | No effect (air for physics). |
| 229 | Left Sand Corner | summer 2011 | above |  | No effect (air for physics). |
| 230 | Right Sand Corner | summer 2011 | above |  | No effect (air for physics). |
| 231 | Rock Stone Environment | summer 2011 | above |  | No effect (air for physics). |
| 232 | Bush Nature Plant | summer 2011 | above |  | No effect (air for physics). |
| 233 | Grass Left Grass | spring 2011 | above |  | No effect (air for physics). |
| 234 | Grass Middle Short | spring 2011 | above |  | No effect (air for physics). |
| 235 | Grass Right Short | spring 2011 | above |  | No effect (air for physics). |
| 236 | Grass Hedge Left | spring 2011 | above |  | No effect (air for physics). |
| 237 | Grass Hedge Middle | spring 2011 | above |  | No effect (air for physics). |
| 238 | Grass Hedge Right | spring 2011 | above |  | No effect (air for physics). |
| 239 | Flower Sun Yellow | spring 2011 | above |  | No effect (air for physics). |
| 240 | Bush Plant Shrub | spring 2011 | above |  | No effect (air for physics). |
| 241 | DIAMOND | diamond | deco |  | Diamond. Touch (entering, not flying): smiley frame = 31. Cosmetic. |
| 242 | PORTAL | portals | deco | L:portal | Portal. Lookup: id, target, rotation (0 down, 1 left, 2 up, 3 right). Teleports on the first sub-step of a tick whose start cell is this tile, if moving, not flying, target != id, lastPortal == null. Random exit when several portals have id == target. §4.9 |
| 243 | Blank Hidden | secrets | deco |  | Secret "blank" block. NOT solid. Every overlaps() whose scan range contains it marks it revealed (before the rect test); drawn as block 44 until revealed. Cosmetic. §3.2 |
| 244 | Pink Violet Purple | new year 2010 | deco |  | No effect (air for physics). |
| 245 | Yellow | new year 2010 | deco |  | No effect (air for physics). |
| 246 | Blue | new year 2010 | deco |  | No effect (air for physics). |
| 247 | Red | new year 2010 | deco |  | No effect (air for physics). |
| 248 | Green | new year 2010 | deco |  | No effect (air for physics). |
| 249 | Snow Left Corner | christmas 2010 | above |  | No effect (air for physics). |
| 250 | Snow Right Corner | christmas 2010 | above |  | No effect (air for physics). |
| 251 | Tree Plant Nature | christmas 2010 | above |  | No effect (air for physics). |
| 252 | Tree Snow Plant | christmas 2010 | above |  | No effect (air for physics). |
| 253 | Fence Snow Wood | christmas 2010 | above |  | No effect (air for physics). |
| 254 | Fence Wood | christmas 2010 | above |  | No effect (air for physics). |
| 255 | SPAWNPOINT | tools | deco |  | Spawn point. No touch effect. Joins spawnPoints[0] in file order; used round-robin by placeAtSpawn. §7 |
| 256 | Cyan Teal Wavy | easter 2012 | above |  | No effect (air for physics). |
| 257 | Pink Wavy | easter 2012 | above |  | No effect (air for physics). |
| 258 | Green Line Yellow | easter 2012 | above |  | No effect (air for physics). |
| 259 | Pink Stripes | easter 2012 | above |  | No effect (air for physics). |
| 260 | Green Dots | easter 2012 | above |  | No effect (air for physics). |
| 261 | Bars Metal | prison | above |  | No effect (air for physics). |
| 262 | Transparent Clear Black | windows | above |  | No effect (air for physics). |
| 263 | Transparent Green | windows | above |  | No effect (air for physics). |
| 264 | Transparent Turquoise Cyan | windows | above |  | No effect (air for physics). |
| 265 | Transparent Blue | windows | above |  | No effect (air for physics). |
| 266 | Transparent Purple Violet | windows | above |  | No effect (air for physics). |
| 267 | Transparent Pink Magenta | windows | above |  | No effect (air for physics). |
| 268 | Transparent Red Pink | windows | above |  | No effect (air for physics). |
| 269 | Transparent Orange | windows | above |  | No effect (air for physics). |
| 270 | Transparent Yellow | windows | above |  | No effect (air for physics). |
| 271 | Wood Decoration Navy | pirate | deco |  | No effect (air for physics). |
| 272 | Skull Head Skeleton | pirate | above |  | No effect (air for physics). |
| 273 | MEDIEVAL_SHIELD | medieval | deco | L:int | No effect (air for physics). |
| 274 | Eye Purple Circle | monster | deco |  | No effect (air for physics). |
| 275 | MEDIEVAL_AXE | medieval | deco | L:int | No effect (air for physics). |
| 276 | DOJO_LIGHT_LEFT | dojo | deco | L:int | No effect (air for physics). |
| 277 | DOJO_LIGHT_RIGHT | dojo | deco | L:int | No effect (air for physics). |
| 278 | Window Open House | dojo | deco |  | No effect (air for physics). |
| 279 | DOJO_DARK_LEFT | dojo | deco | L:int | No effect (air for physics). |
| 280 | DOJO_DARK_RIGHT | dojo | deco | L:int | No effect (air for physics). |
| 281 | Window Dark Open | dojo | deco |  | No effect (air for physics). |
| 282 | Character Chinese | dojo | deco |  | No effect (air for physics). |
| 283 | Character Chinese | dojo | deco |  | No effect (air for physics). |
| 284 | Yin Yang Chinese White | dojo | deco |  | No effect (air for physics). |
| 285 | Pole White | wild west | above |  | No effect (air for physics). |
| 286 | Pole Gray Dark | wild west | above |  | No effect (air for physics). |
| 287 | Door Wood Brown | wild west | deco |  | No effect (air for physics). |
| 288 | Door Wood Brown | wild west | deco |  | No effect (air for physics). |
| 289 | Door Wood Red | wild west | deco |  | No effect (air for physics). |
| 290 | Door Wood Red | wild west | deco |  | No effect (air for physics). |
| 291 | Door Wood Blue | wild west | deco |  | No effect (air for physics). |
| 292 | Door Wood Blue | wild west | deco |  | No effect (air for physics). |
| 293 | Window Curtains | wild west | deco |  | No effect (air for physics). |
| 294 | Fence Wood Brown | wild west | above |  | No effect (air for physics). |
| 295 | Fence Wood Brown | wild west | above |  | No effect (air for physics). |
| 296 | Fence Wood Red | wild west | above |  | No effect (air for physics). |
| 297 | Fence Wood Red | wild west | above |  | No effect (air for physics). |
| 298 | Fence Wood Blue | wild west | above |  | No effect (air for physics). |
| 299 | Fence Wood Blue | wild west | above |  | No effect (air for physics). |
| 300 | WAVE | water | above |  | Liquid surface/decoration (wave, mud bubbles, lava surface, toxic surface). NOT a liquid, no effect. |
| 301 | White | sand | above |  | No effect (air for physics). |
| 302 | Gray Grey | sand | above |  | No effect (air for physics). |
| 303 | Yellow | sand | above |  | No effect (air for physics). |
| 304 | Yellow Orange | sand | above |  | No effect (air for physics). |
| 305 | Brown Light | sand | above |  | No effect (air for physics). |
| 306 | Brown Dark | sand | above |  | No effect (air for physics). |
| 307 | Beach Ball Toy | summer 2012 | above |  | No effect (air for physics). |
| 308 | Pail Bucket Toy | summer 2012 | above |  | No effect (air for physics). |
| 309 | Shovel Dig Toy | summer 2012 | above |  | No effect (air for physics). |
| 310 | Drink Margarita Umbrella | summer 2012 | above |  | No effect (air for physics). |
| 311 | Top Side White | cloud | deco |  | No effect (air for physics). |
| 312 | Bottom Side White | cloud | deco |  | No effect (air for physics). |
| 313 | Left Side White | cloud | deco |  | No effect (air for physics). |
| 314 | Right Side White | cloud | deco |  | No effect (air for physics). |
| 315 | Top right Corner White | cloud | deco |  | No effect (air for physics). |
| 316 | Top left Corner White | cloud | deco |  | No effect (air for physics). |
| 317 | Bottom left Corner White | cloud | deco |  | No effect (air for physics). |
| 318 | Bottom right Corner White | cloud | deco |  | No effect (air for physics). |
| 319 | Caution Warning Fire | industrial | above |  | No effect (air for physics). |
| 320 | Caution Warning Death | industrial | above |  | No effect (air for physics). |
| 321 | Caution Warning Electricity | industrial | above |  | No effect (air for physics). |
| 322 | Caution Warning No | industrial | above |  | No effect (air for physics). |
| 323 | Caution Warning Horizontal | industrial | deco |  | No effect (air for physics). |
| 324 | Caution Warning Vertical | industrial | deco |  | No effect (air for physics). |
| 325 | Brick Stone House | medieval | above |  | No effect (air for physics). |
| 326 | Top Display Stone | medieval | above |  | No effect (air for physics). |
| 327 | MEDIEVAL_BANNER | medieval | deco | L:int | No effect (air for physics). |
| 328 | MEDIEVAL_COATOFARMS | medieval | deco | L:int | No effect (air for physics). |
| 329 | MEDIEVAL_SWORD | medieval | deco | L:int | No effect (air for physics). |
| 330 | Shield Warrior Weapon | medieval | deco |  | No effect (air for physics). |
| 331 | Rock Hard Gray | outer space | above |  | No effect (air for physics). |
| 332 | Sign Panel Computer | outer space | deco |  | No effect (air for physics). |
| 333 | Red Dot Light | outer space | deco |  | No effect (air for physics). |
| 334 | Blue Dot Light | outer space | deco |  | No effect (air for physics). |
| 335 | Computer Control panel System | outer space | deco |  | No effect (air for physics). |
| 336 | Rock Orange Sandstone | desert | above |  | No effect (air for physics). |
| 337 | CAKE | cake | deco |  | Cake. Touch: smiley frame = Random.nextInt(72,76) (Math.random). Cosmetic. |
| 338 | TOOTH_BIG | monster | deco | L:int | No effect (air for physics). |
| 339 | TOOTH_SMALL | monster | deco | L:int | No effect (air for physics). |
| 340 | TOOTH_TRIPLE | monster | deco | L:int | No effect (air for physics). |
| 341 | Eye Yellow Circle | monster | deco |  | No effect (air for physics). |
| 342 | Eye Blue Circle | monster | deco |  | No effect (air for physics). |
| 343 | Center Middle | fog | above |  | No effect (air for physics). |
| 344 | Bottom Side | fog | above |  | No effect (air for physics). |
| 345 | Top Side | fog | above |  | No effect (air for physics). |
| 346 | Left Side | fog | above |  | No effect (air for physics). |
| 347 | Right Side | fog | above |  | No effect (air for physics). |
| 348 | Top Right Corner | fog | above |  | No effect (air for physics). |
| 349 | Top Left Corner | fog | above |  | No effect (air for physics). |
| 350 | Bottom Left Corner | fog | above |  | No effect (air for physics). |
| 351 | Bottom Right Corner | fog | above |  | No effect (air for physics). |
| 352 | Head Transfer Lamp | halloween 2012 | above |  | No effect (air for physics). |
| 353 | Antenna Tesla coil Middle | halloween 2012 | deco |  | No effect (air for physics). |
| 354 | Wire Blue Red | halloween 2012 | deco |  | No effect (air for physics). |
| 355 | Wire Blue Red | halloween 2012 | deco |  | No effect (air for physics). |
| 356 | Lightning Storm Electricity | halloween 2012 | above |  | No effect (air for physics). |
| 357 | Bush Plant Nature | jungle | above |  | No effect (air for physics). |
| 358 | Rock Pot Jar | jungle | above |  | No effect (air for physics). |
| 359 | Idol Statue Gold | jungle | above |  | No effect (air for physics). |
| 360 | CHECKPOINT | tools | deco |  | Checkpoint. Touch (entering, not flying): checkpoint = (cx,cy); respawn goes there. §5.3, §7 |
| 361 | SPIKE | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 362 | Ribbon Blue Vertical | christmas 2012 | deco |  | No effect (air for physics). |
| 363 | Ribbon Blue Horizontal | christmas 2012 | deco |  | No effect (air for physics). |
| 364 | Ribbon Blue Cross | christmas 2012 | deco |  | No effect (air for physics). |
| 365 | Ribbon Purple Vertical | christmas 2012 | deco |  | No effect (air for physics). |
| 366 | Ribbon Purple Horizontal | christmas 2012 | deco |  | No effect (air for physics). |
| 367 | Ribbon Purple Cross | christmas 2012 | deco |  | No effect (air for physics). |
| 368 | FIRE | hazards | above |  | Fire hazard. current -> killPlayer unless invulnerable. (Does NOT set onFire.) §4.5 |
| 369 | MUD | liquids | above | LQ | Mud (liquid). moy = +0.4, mud drag. Touch: extinguishes fire. §4.8 |
| 370 | MUD_BUBBLE | swamp | above |  | Liquid surface/decoration (wave, mud bubbles, lava surface, toxic surface). NOT a liquid, no effect. |
| 371 | Grass Thick Nature | swamp | above |  | No effect (air for physics). |
| 372 | Wood Nature Log | swamp | above |  | No effect (air for physics). |
| 373 | Danger Sign Caution | swamp | above |  | No effect (air for physics). |
| 374 | WORLD_PORTAL | portals | deco | L:wportal | World portal. Only with the Y ("risky") key held (keyboard, not in .eetas): join another world or resetPlayer(worldSpawn = target). No effect in replays. §4.10 |
| 375 | GLOWYLINE_BLUE_SLOPE | sci-fi | deco | L:int | No effect (air for physics). |
| 376 | GLOWY_LINE_BLUE_STRAIGHT | sci-fi | deco | L:int | No effect (air for physics). |
| 377 | GLOWY_LINE_YELLOW_SLOPE | sci-fi | deco | L:int | No effect (air for physics). |
| 378 | GLOWY_LINE_YELLOW_STRAIGHT | sci-fi | deco | L:int | No effect (air for physics). |
| 379 | GLOWY_LINE_GREEN_SLOPE | sci-fi | deco | L:int | No effect (air for physics). |
| 380 | GLOWY_LINE_GREEN_STRAIGHT | sci-fi | deco | L:int | No effect (air for physics). |
| 381 | PORTAL_INVISIBLE | portals | deco | L:portal | Invisible portal. Same as 242 (invisible). §4.9 |
| 382 | Column Top Ancient | marble | deco |  | No effect (air for physics). |
| 383 | Column Middle Ancient | marble | deco |  | No effect (air for physics). |
| 384 | Column Bottom Ancient | marble | deco |  | No effect (air for physics). |
| 385 | TEXT_SIGN | sign | above | L:sign | Sign. Text bubble when within 8 px. Cosmetic. |
| 386 | Wheat Nature Plant | farm | above |  | No effect (air for physics). |
| 387 | Corn Nature Plant | farm | above |  | No effect (air for physics). |
| 388 | Fence Wood Left | farm | above |  | No effect (air for physics). |
| 389 | Fence Wood Right | farm | above |  | No effect (air for physics). |
| 390 | Leaves Left Orange | autumn 2014 | above |  | No effect (air for physics). |
| 391 | Leaves Right Orange | autumn 2014 | above |  | No effect (air for physics). |
| 392 | Grass Left | autumn 2014 | above |  | No effect (air for physics). |
| 393 | Grass Middle | autumn 2014 | above |  | No effect (air for physics). |
| 394 | Grass Right | autumn 2014 | above |  | No effect (air for physics). |
| 395 | Acorn Nut Brown | autumn 2014 | above |  | No effect (air for physics). |
| 396 | Pumpkin Halloween Food | autumn 2014 | above |  | No effect (air for physics). |
| 397 | HOLOGRAM | hologram | deco |  | Hologram. Touch: smiley frame = 100. Cosmetic. |
| 398 | Snow Fluff Left | christmas 2014 | above |  | No effect (air for physics). |
| 399 | Snow Fluff Middle | christmas 2014 | above |  | No effect (air for physics). |
| 400 | Snow Fluff Right | christmas 2014 | above |  | No effect (air for physics). |
| 401 | Candy cane Stripes | christmas 2014 | above |  | No effect (air for physics). |
| 402 | Tinsel Nature Garland | christmas 2014 | deco |  | No effect (air for physics). |
| 403 | Stocking Sock Red | christmas 2014 | deco |  | No effect (air for physics). |
| 404 | Bow Ribbon Red | christmas 2014 | deco |  | No effect (air for physics). |
| 405 | Red | valentines 2015 | deco |  | No effect (air for physics). |
| 406 | Purple Pink | valentines 2015 | deco |  | No effect (air for physics). |
| 407 | Pink | valentines 2015 | deco |  | No effect (air for physics). |
| 408 | KEY_CYAN | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 409 | KEY_MAGENTA | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 410 | KEY_YELLOW | keys | deco |  | Key (6 red, 7 green, 8 blue, 408 cyan, 409 magenta, 410 yellow). Touch (entering, not flying): switchKey(color,true): key on, keysTimer = t; overlap -> revert + keysquene. Active exactly 500 ticks (off in World.update of tick kt+500). Re-entering refreshes the timer. §5.3, §3.4 |
| 411 | Invisible Left Arrow | gravity | deco |  | Invisible left arrow = id 1 (forces, below (cx-1,cy)); entering (not flying): blink, cosmetic. |
| 412 | Invisible Up Arrow | gravity | deco |  | Invisible up arrow = id 2 (below (cx,cy-1)); entering: blink, cosmetic. |
| 413 | Invisible Right Arrow | gravity | deco |  | Invisible right arrow: forces = id 3, but below uses the flipGravity default (not (cx+1,cy)). Entering: blink, cosmetic. |
| 414 | Invisible Dot | gravity | deco |  | Invisible dot = id 4 for forces, queue flush and the slippery exception, but below uses the flipGravity default. Entering: blink, cosmetic. |
| 415 | LAVA_SURFACE | lava | above |  | Liquid surface/decoration (wave, mud bubbles, lava surface, toxic surface). NOT a liquid, no effect. |
| 416 | LAVA | liquids | above | LQ | Lava (liquid). moy = +0.2, lava drag. Touch (entering, not flying): if !onFire && !invulnerable: on fire, dies 241 ticks later unless extinguished. §4.8, §6 |
| 417 | EFFECT_JUMP | effect | deco | L:int | Jump effect. L: 0 normal, 1 high (x1.3), 2 low (x0.75). Touch: if L != jumpBoost: jumpBoost = L. §6 |
| 418 | EFFECT_FLY | effect | deco | L:int | Fly (levitation) effect. L != 0 on. Touch: hasLevitation = L != 0 (off -> thrust 0). Holding jump thrusts instead of jumping. §6.3 |
| 419 | EFFECT_RUN | effect | deco | L:int | Speed effect. L: 0 normal, 1 fast (x1.5), 2 slow (x0.6) on mx,my. §6 |
| 420 | EFFECT_PROTECTION | effect | deco | L:int | Protection effect. L != 0 on. Turning on clears curse, zombie, poison, fire. While on: no spike/fire/toxic death, no lava fire, no curse/zombie/poison pickup. §6 |
| 421 | EFFECT_CURSE | effect | deco | L:int | Curse effect. L = seconds (0 = remove). Touch (not invulnerable, state differs): cursed; dies at t0 + floor((L+0.4)*100) + 1. Re-touch does not refresh. §6.2 |
| 422 | EFFECT_ZOMBIE | zombie | deco | L:int | Zombie effect. L = seconds (0 = remove). Zombie: speed x0.6, jump x0.75, zombie door 207 open / gate 206 closed; dies after the timer like curse. §6.2 |
| 423 | EFFECT_TEAM | teams | deco | L:int | Team effect. L = team 0..6 (None, Red, Blue, Green, Cyan, Magenta, Yellow). Touch (entering, not flying): team = L if no overlap results; otherwise retried every tick at step c via the member tx/ty. Kept through respawn; resetPlayer sets 0. §6.4 |
| 424 | ROPE | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 425 | Cactus Nature Plant | desert | above |  | No effect (air for physics). |
| 426 | Bush Cactus Nature | desert | above |  | No effect (air for physics). |
| 427 | Tree Nature Plant | desert | above |  | No effect (air for physics). |
| 428 | Star Shiny Red | outer space | deco |  | No effect (air for physics). |
| 429 | Star Shiny Blue | outer space | deco |  | No effect (air for physics). |
| 430 | Star Shiny Yellow | outer space | deco |  | No effect (air for physics). |
| 431 | Cream Big Creme | candy | above |  | No effect (air for physics). |
| 432 | Gumdrop Red | candy | above |  | No effect (air for physics). |
| 433 | Gumdrop Green | candy | above |  | No effect (air for physics). |
| 434 | Gumdrop Pink | candy | above |  | No effect (air for physics). |
| 435 | Cannon Sea war Gun | pirate | deco |  | No effect (air for physics). |
| 436 | Port Window Porthole Ship | pirate | deco |  | No effect (air for physics). |
| 437 | Window Wood House | medieval | deco |  | No effect (air for physics). |
| 438 | GLOWY_LINE_RED_SLOPE | sci-fi | deco | L:int | No effect (air for physics). |
| 439 | GLOWY_LINE_RED_STRAIGHT | sci-fi | deco | L:int | No effect (air for physics). |
| 440 | MEDIEVAL_TIMBER | medieval | deco | L:int | No effect (air for physics). |
| 441 | Life preserver Life saver Circle | summer 2015 | above |  | No effect (air for physics). |
| 442 | Anchor Metal Ship | summer 2015 | deco |  | No effect (air for physics). |
| 443 | Rope Left Dock | summer 2015 | above |  | No effect (air for physics). |
| 444 | Rope Right Dock | summer 2015 | above |  | No effect (air for physics). |
| 445 | Tree Nature Palm | summer 2015 | above |  | No effect (air for physics). |
| 446 | Light Lampshade | domestic | deco |  | No effect (air for physics). |
| 447 | DOMESTIC_LIGHT_BULB | domestic | deco | L:int | No effect (air for physics). |
| 448 | DOMESTIC_TAP | domestic | deco | L:int | No effect (air for physics). |
| 449 | DOMESTIC_PAINTING | domestic | deco | L:int | No effect (air for physics). |
| 450 | DOMESTIC_VASE | domestic | deco | L:int | No effect (air for physics). |
| 451 | DOMESTIC_TV | domestic | deco | L:int | No effect (air for physics). |
| 452 | DOMESTIC_WINDOW | domestic | deco | L:int | No effect (air for physics). |
| 453 | EFFECT_LOW_GRAVITY | effect | deco | L:int | Low gravity effect. L != 0 on: gravity x0.15 (times world gravity). §6 |
| 454 | Bush Nature Plant | halloween 2015 | above |  | No effect (air for physics). |
| 455 | Fence Spikes | halloween 2015 | above |  | No effect (air for physics). |
| 456 | HALLOWEEN_2015_WINDOW_RECT | halloween 2015 | deco | L:int | No effect (air for physics). |
| 457 | HALLOWEEN_2015_WINDOW_CIRCLE | halloween 2015 | deco | L:int | No effect (air for physics). |
| 458 | HALLOWEEN_2015_LAMP | halloween 2015 | deco | L:int | No effect (air for physics). |
| 459 | SLOW_DOT | gravity | deco | C | Slow dot: climbable (§4.4): no gravity, no-modifier drag on both axes, flushes the delayed queue. |
| 460 | SLOW_DOT_INVISIBLE | gravity | deco | C | Invisible slow dot: climbable like 459; entering (not flying): blink, cosmetic. |
| 461 | EFFECT_MULTIJUMP | effect | deco | L:int | Multi-jump effect. L = max jumps (1000 = infinite, 0 = none). Touch: maxJumps = L. Standing on it (current) resets jumpCount to 0 every tick. §6 |
| 462 | Glass Wine Drink | new year 2015 | deco |  | No effect (air for physics). |
| 463 | Bottle Champagne Drink | new year 2015 | deco |  | No effect (air for physics). |
| 464 | NEW_YEAR_2015_BALLOON | new year 2015 | deco | L:int | No effect (air for physics). |
| 465 | NEW_YEAR_2015_STREAMER | new year 2015 | deco | L:int | No effect (air for physics). |
| 466 | RESET_POINT | tools | above |  | Reset point. Checked every tick (not just on entering), only with the Y key held (keyboard, not in .eetas) -> resetPlayer(). No effect in replays. §5.1 |
| 467 | SWITCH_ORANGE | switches | deco | L:int | Orange switch. L = id. Touch: pressOrangeSwitch(L, !orangeSwitches[L]) (world-level, overlap-deferred via PlayState.queue, drained per frame). §5.3 |
| 468 | Green Plant Vine | fairytale | deco |  | No effect (air for physics). |
| 469 | Mushroom Orange | fairytale | deco |  | No effect (air for physics). |
| 470 | Dew Drop Transparent Water | fairytale | deco |  | No effect (air for physics). |
| 471 | FAIRYTALE_FLOWERS | fairytale | deco | L:int | No effect (air for physics). |
| 472 | FAIRYTALE_LADDER | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 473 | Dirt Brown Soil | spring 2016 | above |  | No effect (air for physics). |
| 474 | Dirt Brown Soil | spring 2016 | above |  | No effect (air for physics). |
| 475 | SPRING_DAISY | spring 2016 | deco | L:int | No effect (air for physics). |
| 476 | SPRING_TULIP | spring 2016 | deco | L:int | No effect (air for physics). |
| 477 | SPRING_DAFFODIL | spring 2016 | deco | L:int | No effect (air for physics). |
| 478 | Trophy Bronze Spring | Prizes | above |  | No effect (air for physics). |
| 479 | Trophy Silver Spring | Prizes | above |  | No effect (air for physics). |
| 480 | Trophy Gold Spring | Prizes | above |  | No effect (air for physics). |
| 481 | SUMMER_FLAG | summer 2016 | deco | L:int | No effect (air for physics). |
| 482 | SUMMER_AWNING | summer 2016 | deco | L:int | No effect (air for physics). |
| 483 | SUMMER_ICECREAM | summer 2016 | deco | L:int | No effect (air for physics). |
| 484 | Trophy Bronze Summer | Prizes | above |  | No effect (air for physics). |
| 485 | Trophy Silver Summer | Prizes | above |  | No effect (air for physics). |
| 486 | Trophy Gold Summer | Prizes | above |  | No effect (air for physics). |
| 487 | Hamburger Sandwich Food | restaurant | deco |  | No effect (air for physics). |
| 488 | Hot Dog Sausage Food | restaurant | deco |  | No effect (air for physics). |
| 489 | Sub Sandwich Ham | restaurant | deco |  | No effect (air for physics). |
| 490 | Soda Drink Beverage | restaurant | deco |  | No effect (air for physics). |
| 491 | French Fries Chips Food | restaurant | deco |  | No effect (air for physics). |
| 492 | RESTAURANT_CUP | restaurant | deco | L:int | No effect (air for physics). |
| 493 | RESTAURANT_PLATE | restaurant | deco | L:int | No effect (air for physics). |
| 494 | RESTAURANT_BOWL | restaurant | deco | L:int | No effect (air for physics). |
| 495 | Stalagmite Stone Brown | mine | deco |  | No effect (air for physics). |
| 496 | Stalagtite Stone Brown | mine | deco |  | No effect (air for physics). |
| 497 | CAVE_CRYSTAL | mine | deco | L:int | No effect (air for physics). |
| 498 | CAVE_TORCH | mine | deco |  | No effect (air for physics). |
| 499 | HALLOWEEN_2016_ROTATABLE | halloween 2016 | deco | L:int | No effect (air for physics). |
| 500 | Gray Grey | basic | bg |  | Background (layer 1): never read by physics. |
| 501 | Blue | basic | bg |  | Background (layer 1): never read by physics. |
| 502 | Purple Magenta Pink | basic | bg |  | Background (layer 1): never read by physics. |
| 503 | Red | basic | bg |  | Background (layer 1): never read by physics. |
| 504 | Yellow Lime Green | basic | bg |  | Background (layer 1): never read by physics. |
| 505 | Green Backdrop | basic | bg |  | Background (layer 1): never read by physics. |
| 506 | Cyan Teal Turquoise | basic | bg |  | Background (layer 1): never read by physics. |
| 507 | Orange Brown Dirt | brick | bg |  | Background (layer 1): never read by physics. |
| 508 | Cyan Teal Turquoise | brick | bg |  | Background (layer 1): never read by physics. |
| 509 | Magenta Purple Violet | brick | bg |  | Background (layer 1): never read by physics. |
| 510 | Green Lime | brick | bg |  | Background (layer 1): never read by physics. |
| 511 | Red | brick | bg |  | Background (layer 1): never read by physics. |
| 512 | Yellow Soil Brown | brick | bg |  | Background (layer 1): never read by physics. |
| 513 | Gray Grey Shadow | checker | bg |  | Background (layer 1): never read by physics. |
| 514 | Blue | checker | bg |  | Background (layer 1): never read by physics. |
| 515 | Purple Magenta Pink | checker | bg |  | Background (layer 1): never read by physics. |
| 516 | Red Pink | checker | bg |  | Background (layer 1): never read by physics. |
| 517 | Yellow Lime | checker | bg |  | Background (layer 1): never read by physics. |
| 518 | Green | checker | bg |  | Background (layer 1): never read by physics. |
| 519 | Cyan Teal Turquoise | checker | bg |  | Background (layer 1): never read by physics. |
| 520 | Gray Grey Shadow | dark | bg |  | Background (layer 1): never read by physics. |
| 521 | Blue | dark | bg |  | Background (layer 1): never read by physics. |
| 522 | Purple Magenta Pink | dark | bg |  | Background (layer 1): never read by physics. |
| 523 | Red | dark | bg |  | Background (layer 1): never read by physics. |
| 524 | Yellow Lime | dark | bg |  | Background (layer 1): never read by physics. |
| 525 | Green | dark | bg |  | Background (layer 1): never read by physics. |
| 526 | Cyan Teal Turquoise | dark | bg |  | Background (layer 1): never read by physics. |
| 527 | Yellow | pastel | bg |  | Background (layer 1): never read by physics. |
| 528 | Green | pastel | bg |  | Background (layer 1): never read by physics. |
| 529 | Yellow Green Lime | pastel | bg |  | Background (layer 1): never read by physics. |
| 530 | Cyan Light Blue Sky | pastel | bg |  | Background (layer 1): never read by physics. |
| 531 | Blue Sky | pastel | bg |  | Background (layer 1): never read by physics. |
| 532 | Pink Red Magenta | pastel | bg |  | Background (layer 1): never read by physics. |
| 533 | Orange | canvas | bg |  | Background (layer 1): never read by physics. |
| 534 | Beige Brown Tan | canvas | bg |  | Background (layer 1): never read by physics. |
| 535 | Yellow | canvas | bg |  | Background (layer 1): never read by physics. |
| 536 | Green | canvas | bg |  | Background (layer 1): never read by physics. |
| 537 | Cyan Light Blue Water | canvas | bg |  | Background (layer 1): never read by physics. |
| 538 | Gray Grey | canvas | bg |  | Background (layer 1): never read by physics. |
| 539 | Stripes Pink Pastel | candy | bg |  | Background (layer 1): never read by physics. |
| 540 | Stripes Blue Pastel | candy | bg |  | Background (layer 1): never read by physics. |
| 541 | Stone Gray Grey | halloween 2011 | bg |  | Background (layer 1): never read by physics. |
| 542 | Brick Gray Grey | halloween 2011 | bg |  | Background (layer 1): never read by physics. |
| 543 | Brick Damaged Right | halloween 2011 | bg |  | Background (layer 1): never read by physics. |
| 544 | Brick Damaged Left | halloween 2011 | bg |  | Background (layer 1): never read by physics. |
| 545 | Stripes Red Yellow | carnival | bg |  | Background (layer 1): never read by physics. |
| 546 | Stripes Purple Violet | carnival | bg |  | Background (layer 1): never read by physics. |
| 547 | Magenta Pink | carnival | bg |  | Background (layer 1): never read by physics. |
| 548 | Checker Black White | carnival | bg |  | Background (layer 1): never read by physics. |
| 549 | Green | carnival | bg |  | Background (layer 1): never read by physics. |
| 550 | Wall Brick Background | prison | bg |  | Background (layer 1): never read by physics. |
| 551 | Window Light Orange | prison | bg |  | Background (layer 1): never read by physics. |
| 552 | Window Light Blue | prison | bg |  | Background (layer 1): never read by physics. |
| 553 | Window Dark Vent | prison | bg |  | Background (layer 1): never read by physics. |
| 554 | Wood Dark Planks | pirate | bg |  | Background (layer 1): never read by physics. |
| 555 | Wood Light Planks | pirate | bg |  | Background (layer 1): never read by physics. |
| 556 | Roof Shingles Scales | medieval | bg |  | Background (layer 1): never read by physics. |
| 557 | Mud Quicksand Environment | swamp | bg |  | Background (layer 1): never read by physics. |
| 558 | Yellow | carnival | bg |  | Background (layer 1): never read by physics. |
| 559 | Wood Dark Planks | pirate | bg |  | Background (layer 1): never read by physics. |
| 560 | Flag Jolly Roger Skull | pirate | bg |  | Background (layer 1): never read by physics. |
| 561 | Dark Gray Grey | stone | bg |  | Background (layer 1): never read by physics. |
| 562 | Half Dark Gray | stone | bg |  | Background (layer 1): never read by physics. |
| 563 | Poland Stripes Red | carnival | bg |  | Background (layer 1): never read by physics. |
| 564 | White | dojo | bg |  | Background (layer 1): never read by physics. |
| 565 | Grey Gray | dojo | bg |  | Background (layer 1): never read by physics. |
| 566 | Roof Blue Tile | dojo | bg |  | Background (layer 1): never read by physics. |
| 567 | Roof Blue Dark | dojo | bg |  | Background (layer 1): never read by physics. |
| 568 | Siding Wood Brown | wild west | bg |  | Background (layer 1): never read by physics. |
| 569 | Siding Wood Dark Brown | wild west | bg |  | Background (layer 1): never read by physics. |
| 570 | Siding Wood Red | wild west | bg |  | Background (layer 1): never read by physics. |
| 571 | Siding Wood Dark Red | wild west | bg |  | Background (layer 1): never read by physics. |
| 572 | Siding Wood Blue | wild west | bg |  | Background (layer 1): never read by physics. |
| 573 | Siding Wood Dark Blue | wild west | bg |  | Background (layer 1): never read by physics. |
| 574 | WATER_BG | water | bg |  | Background (layer 1): never read by physics. |
| 575 | WATER_BG_OCTOPUS | water | bg |  | Background (layer 1): never read by physics. |
| 576 | WATER_BG_FISH | water | bg |  | Background (layer 1): never read by physics. |
| 577 | WATER_BG_SEAHORSE | water | bg |  | Background (layer 1): never read by physics. |
| 578 | WATER_BG_SEAWEED | water | bg |  | Background (layer 1): never read by physics. |
| 579 | Off-white | sand | bg |  | Background (layer 1): never read by physics. |
| 580 | Gray Grey | sand | bg |  | Background (layer 1): never read by physics. |
| 581 | Yellow | sand | bg |  | Background (layer 1): never read by physics. |
| 582 | Orange Yellow | sand | bg |  | Background (layer 1): never read by physics. |
| 583 | Brown Light | sand | bg |  | Background (layer 1): never read by physics. |
| 584 | Brown Dark | sand | bg |  | Background (layer 1): never read by physics. |
| 585 | Plate Metal | industrial | bg |  | Background (layer 1): never read by physics. |
| 586 | Gray Steel Plate | industrial | bg |  | Background (layer 1): never read by physics. |
| 587 | Blue Cyan Plate | industrial | bg |  | Background (layer 1): never read by physics. |
| 588 | Green Plate Metal | industrial | bg |  | Background (layer 1): never read by physics. |
| 589 | Yellow Orange Plate | industrial | bg |  | Background (layer 1): never read by physics. |
| 590 | Straw Hay Roof | medieval | bg |  | Background (layer 1): never read by physics. |
| 591 | Roof Shingles Scales | medieval | bg |  | Background (layer 1): never read by physics. |
| 592 | Roof Shingles Scales | medieval | bg |  | Background (layer 1): never read by physics. |
| 593 | Gray Dry wall Stucco | medieval | bg |  | Background (layer 1): never read by physics. |
| 594 | White Tile Bathroom | clay | bg |  | Background (layer 1): never read by physics. |
| 595 | Brick Tile Bathroom | clay | bg |  | Background (layer 1): never read by physics. |
| 596 | Diamond Chisel Tile | clay | bg |  | Background (layer 1): never read by physics. |
| 597 | X Cross Chisel | clay | bg |  | Background (layer 1): never read by physics. |
| 598 | Rough Natural | clay | bg |  | Background (layer 1): never read by physics. |
| 599 | Anvil Blacksmith | medieval | bg |  | Background (layer 1): never read by physics. |
| 600 | Wood Planks Vertical | medieval | bg |  | Background (layer 1): never read by physics. |
| 601 | White Grey Gray | outer space | bg |  | Background (layer 1): never read by physics. |
| 602 | Blue Metal | outer space | bg |  | Background (layer 1): never read by physics. |
| 603 | Green Metal | outer space | bg |  | Background (layer 1): never read by physics. |
| 604 | Red Metal | outer space | bg |  | Background (layer 1): never read by physics. |
| 605 | Blue Night Sky | neon | bg |  | Background (layer 1): never read by physics. |
| 606 | Blue | canvas | bg |  | Background (layer 1): never read by physics. |
| 607 | Blue Solid | carnival | bg |  | Background (layer 1): never read by physics. |
| 608 | Green Grass | monster | bg |  | Background (layer 1): never read by physics. |
| 609 | Green Dark Grass | monster | bg |  | Background (layer 1): never read by physics. |
| 610 | Gray Grey Shadow | normal | bg |  | Background (layer 1): never read by physics. |
| 611 | Blue | normal | bg |  | Background (layer 1): never read by physics. |
| 612 | Purple Magenta Pink | normal | bg |  | Background (layer 1): never read by physics. |
| 613 | Red | normal | bg |  | Background (layer 1): never read by physics. |
| 614 | Yellow Lime | normal | bg |  | Background (layer 1): never read by physics. |
| 615 | Green | normal | bg |  | Background (layer 1): never read by physics. |
| 616 | Cyan Teal Turquoise | normal | bg |  | Background (layer 1): never read by physics. |
| 617 | Brick Grey Gray | jungle | bg |  | Background (layer 1): never read by physics. |
| 618 | Brick Red Pink | jungle | bg |  | Background (layer 1): never read by physics. |
| 619 | Brick Blue Ruins | jungle | bg |  | Background (layer 1): never read by physics. |
| 620 | Brick Yellow Olive | jungle | bg |  | Background (layer 1): never read by physics. |
| 621 | Leaves Green Grass | jungle | bg |  | Background (layer 1): never read by physics. |
| 622 | Leaves Green Grass | jungle | bg |  | Background (layer 1): never read by physics. |
| 623 | Leaves Green Grass | jungle | bg |  | Background (layer 1): never read by physics. |
| 624 | Wrapping paper Yellow Stripes | christmas 2012 | bg |  | Background (layer 1): never read by physics. |
| 625 | Wrapping paper Green Stripes | christmas 2012 | bg |  | Background (layer 1): never read by physics. |
| 626 | Wrapping paper Blue Purple | christmas 2012 | bg |  | Background (layer 1): never read by physics. |
| 627 | Yellow | lava | bg |  | Background (layer 1): never read by physics. |
| 628 | Orange | lava | bg |  | Background (layer 1): never read by physics. |
| 629 | Red Orange | lava | bg |  | Background (layer 1): never read by physics. |
| 630 | Green Grass Environment | swamp | bg |  | Background (layer 1): never read by physics. |
| 637 | Gray Outline Grey | sci-fi | bg |  | Background (layer 1): never read by physics. |
| 638 | Brick White Ancient | marble | bg |  | Background (layer 1): never read by physics. |
| 639 | Brick Green Ancient | marble | bg |  | Background (layer 1): never read by physics. |
| 640 | Brick Red Pink | marble | bg |  | Background (layer 1): never read by physics. |
| 641 | Leaves Yellow | autumn 2014 | bg |  | Background (layer 1): never read by physics. |
| 642 | Leaves Orange | autumn 2014 | bg |  | Background (layer 1): never read by physics. |
| 643 | Leaves Red | autumn 2014 | bg |  | Background (layer 1): never read by physics. |
| 644 | Orange | basic | bg |  | Background (layer 1): never read by physics. |
| 645 | Black Dark Shadow | basic | bg |  | Background (layer 1): never read by physics. |
| 646 | Gray Grey | brick | bg |  | Background (layer 1): never read by physics. |
| 647 | Blue | brick | bg |  | Background (layer 1): never read by physics. |
| 648 | Black Dark Shadow | brick | bg |  | Background (layer 1): never read by physics. |
| 649 | Orange | checker | bg |  | Background (layer 1): never read by physics. |
| 650 | Black Dark Shadow | checker | bg |  | Background (layer 1): never read by physics. |
| 651 | Orange | dark | bg |  | Background (layer 1): never read by physics. |
| 652 | Black Dark Shadow | dark | bg |  | Background (layer 1): never read by physics. |
| 653 | Orange | normal | bg |  | Background (layer 1): never read by physics. |
| 654 | Black Dark Shadow | normal | bg |  | Background (layer 1): never read by physics. |
| 655 | Dark Purple | cave | bg |  | Background (layer 1): never read by physics. |
| 656 | Dark Cyan | cave | bg |  | Background (layer 1): never read by physics. |
| 657 | Dark Blue Night | cave | bg |  | Background (layer 1): never read by physics. |
| 658 | Dark Pink Magenta | cave | bg |  | Background (layer 1): never read by physics. |
| 659 | Dark Green | cave | bg |  | Background (layer 1): never read by physics. |
| 660 | Dark Orange Brown | cave | bg |  | Background (layer 1): never read by physics. |
| 661 | Dark Yellow Olive | cave | bg |  | Background (layer 1): never read by physics. |
| 662 | Dark Red | cave | bg |  | Background (layer 1): never read by physics. |
| 663 | Red Pink Scales | monster | bg |  | Background (layer 1): never read by physics. |
| 664 | Red Pink Dark | monster | bg |  | Background (layer 1): never read by physics. |
| 665 | Purple Scales Violet | monster | bg |  | Background (layer 1): never read by physics. |
| 666 | Purple Scales Dark | monster | bg |  | Background (layer 1): never read by physics. |
| 667 | Roof Red Tile | dojo | bg |  | Background (layer 1): never read by physics. |
| 668 | Roof Red Dark | dojo | bg |  | Background (layer 1): never read by physics. |
| 669 | Roof Green Tile | dojo | bg |  | Background (layer 1): never read by physics. |
| 670 | Roof Green Dark | dojo | bg |  | Background (layer 1): never read by physics. |
| 671 | Red | canvas | bg |  | Background (layer 1): never read by physics. |
| 672 | Purple Violet | canvas | bg |  | Background (layer 1): never read by physics. |
| 673 | Orange Fire | neon | bg |  | Background (layer 1): never read by physics. |
| 674 | Green Jungle | neon | bg |  | Background (layer 1): never read by physics. |
| 675 | Magenta Pink Red | neon | bg |  | Background (layer 1): never read by physics. |
| 676 | Orange | pastel | bg |  | Background (layer 1): never read by physics. |
| 677 | Purple | pastel | bg |  | Background (layer 1): never read by physics. |
| 678 | Wood Tree Brown | environment | bg |  | Background (layer 1): never read by physics. |
| 679 | Leaves Grass Green | environment | bg |  | Background (layer 1): never read by physics. |
| 680 | Bamboo Wood | environment | bg |  | Background (layer 1): never read by physics. |
| 681 | Obsidian Rock Ice | environment | bg |  | Background (layer 1): never read by physics. |
| 682 | Fire Lava Hot | environment | bg |  | Background (layer 1): never read by physics. |
| 683 | Wallpaper Yellow Dark yellow | domestic | bg |  | Background (layer 1): never read by physics. |
| 684 | Wallpaper Brown Dark brown | domestic | bg |  | Background (layer 1): never read by physics. |
| 685 | Wallpaper Red Dark red | domestic | bg |  | Background (layer 1): never read by physics. |
| 686 | Wallpaper Blue Dark blue | domestic | bg |  | Background (layer 1): never read by physics. |
| 687 | Wallpaper Green Dark green | domestic | bg |  | Background (layer 1): never read by physics. |
| 688 | Green Limestone | stone | bg |  | Background (layer 1): never read by physics. |
| 689 | Half Limestone | stone | bg |  | Background (layer 1): never read by physics. |
| 690 | Brown | stone | bg |  | Background (layer 1): never read by physics. |
| 691 | Half Brown | stone | bg |  | Background (layer 1): never read by physics. |
| 692 | Blue | stone | bg |  | Background (layer 1): never read by physics. |
| 693 | Half | stone | bg |  | Background (layer 1): never read by physics. |
| 694 | Mossy Green Brick | halloween 2015 | bg |  | Background (layer 1): never read by physics. |
| 695 | Sliding Gray Grey | halloween 2015 | bg |  | Background (layer 1): never read by physics. |
| 696 | Mossy Gray Grey | halloween 2015 | bg |  | Background (layer 1): never read by physics. |
| 697 | Yellow | neon | bg |  | Background (layer 1): never read by physics. |
| 698 | Cyan | neon | bg |  | Background (layer 1): never read by physics. |
| 699 | Brown Dirt Soil | desert | bg |  | Background (layer 1): never read by physics. |
| 700 | Brown Dirt Soil | desert | bg |  | Background (layer 1): never read by physics. |
| 701 | Brown Dirt Soil | desert | bg |  | Background (layer 1): never read by physics. |
| 702 |  | arctic | bg |  | Background (layer 1): never read by physics. |
| 703 |  | arctic | bg |  | Background (layer 1): never read by physics. |
| 704 | Orange Mist Fog | fairytale | bg |  | Background (layer 1): never read by physics. |
| 705 | Green Mist Fog | fairytale | bg |  | Background (layer 1): never read by physics. |
| 706 | Blue Mist Fog | fairytale | bg |  | Background (layer 1): never read by physics. |
| 707 | Pink Mist Fog | fairytale | bg |  | Background (layer 1): never read by physics. |
| 708 | Thatched Straw Seasonal | summer 2016 | bg |  | Background (layer 1): never read by physics. |
| 709 |  | gold | bg |  | Background (layer 1): never read by physics. |
| 710 |  | gold | bg |  | Background (layer 1): never read by physics. |
| 711 |  | gold | bg |  | Background (layer 1): never read by physics. |
| 712 | Planks Wood Seasonal | summer 2016 | bg |  | Background (layer 1): never read by physics. |
| 713 | Planks Wood Seasonal | summer 2016 | bg |  | Background (layer 1): never read by physics. |
| 714 | Planks Wood Seasonal | summer 2016 | bg |  | Background (layer 1): never read by physics. |
| 715 | White Light | basic | bg |  | Background (layer 1): never read by physics. |
| 716 | White Light | brick | bg |  | Background (layer 1): never read by physics. |
| 717 | White Light | normal | bg |  | Background (layer 1): never read by physics. |
| 718 | White Light | checker | bg |  | Background (layer 1): never read by physics. |
| 719 | White Light | dark | bg |  | Background (layer 1): never read by physics. |
| 720 | Stone Brown Tan | mine | bg |  | Background (layer 1): never read by physics. |
| 721 | Cloth Fabric Pattern | textile | bg |  | Background (layer 1): never read by physics. |
| 722 | Cloth Fabric Pattern | textile | bg |  | Background (layer 1): never read by physics. |
| 723 | Cloth Fabric Pattern | textile | bg |  | Background (layer 1): never read by physics. |
| 724 | Cloth Fabric Pattern | textile | bg |  | Background (layer 1): never read by physics. |
| 725 | Cloth Fabric Pattern | textile | bg |  | Background (layer 1): never read by physics. |
| 726 | Tree Wood Black | halloween 2016 | bg |  | Background (layer 1): never read by physics. |
| 727 | Leaves Plant Purple | halloween 2016 | bg |  | Background (layer 1): never read by physics. |
| 728 | Plywood Wood Brown | construction | bg |  | Background (layer 1): never read by physics. |
| 729 | Gravel Stone Gray | construction | bg |  | Background (layer 1): never read by physics. |
| 730 | Cement Stone Beige | construction | bg |  | Background (layer 1): never read by physics. |
| 731 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 732 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 733 | White | tiles | bg |  | Background (layer 1): never read by physics. |
| 734 | Gray Grey | tiles | bg |  | Background (layer 1): never read by physics. |
| 735 | Black Gray Grey | tiles | bg |  | Background (layer 1): never read by physics. |
| 736 | Red | tiles | bg |  | Background (layer 1): never read by physics. |
| 737 | Orange | tiles | bg |  | Background (layer 1): never read by physics. |
| 738 | Yellow | tiles | bg |  | Background (layer 1): never read by physics. |
| 739 | Green | tiles | bg |  | Background (layer 1): never read by physics. |
| 740 | Cyan | tiles | bg |  | Background (layer 1): never read by physics. |
| 741 | Blue | tiles | bg |  | Background (layer 1): never read by physics. |
| 742 | Purple | tiles | bg |  | Background (layer 1): never read by physics. |
| 743 | White Light | beta | bg |  | Background (layer 1): never read by physics. |
| 744 | Grey Gray Taupe | beta | bg |  | Background (layer 1): never read by physics. |
| 745 | Black Dark Onyx | beta | bg |  | Background (layer 1): never read by physics. |
| 746 | Red Ruby Garnet | beta | bg |  | Background (layer 1): never read by physics. |
| 747 | Orange Copper | beta | bg |  | Background (layer 1): never read by physics. |
| 748 | Yellow Gold Jasmine | beta | bg |  | Background (layer 1): never read by physics. |
| 749 | Green Emerald Malachite | beta | bg |  | Background (layer 1): never read by physics. |
| 750 | Blue Cyan Light blue | beta | bg |  | Background (layer 1): never read by physics. |
| 751 | Blue Sapphire | beta | bg |  | Background (layer 1): never read by physics. |
| 752 | Purple Pink Magenta | beta | bg |  | Background (layer 1): never read by physics. |
| 753 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 754 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 755 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 756 | Beam Metal Red | construction | bg |  | Background (layer 1): never read by physics. |
| 757 | Ice Brick Cyan | Winter 2018 | bg |  | Background (layer 1): never read by physics. |
| 758 | Snow Pile Grey | Winter 2018 | bg |  | Background (layer 1): never read by physics. |
| 759 | Glacier Snow Ice | Winter 2018 | bg |  | Background (layer 1): never read by physics. |
| 760 | Slate Grey Gray | Winter 2018 | bg |  | Background (layer 1): never read by physics. |
| 761 | Rock Environment Brown | Garden | bg |  | Background (layer 1): never read by physics. |
| 762 | Grass Moss Environment | Garden | bg |  | Background (layer 1): never read by physics. |
| 763 | Leaves Green Leaf | Garden | bg |  | Background (layer 1): never read by physics. |
| 765 | TOXIC_WASTE_BG | Toxic | bg |  | Background (layer 1): never read by physics. |
| 766 | Dark Grey Gray | cave | bg |  | Background (layer 1): never read by physics. |
| 767 | Dark Grey Gray | cave | bg |  | Background (layer 1): never read by physics. |
| 768 | Dark Grey Gray | cave | bg |  | Background (layer 1): never read by physics. |
| 769 | GREY_DUNGEON_BG | Dungeon | bg |  | Background (layer 1): never read by physics. |
| 770 | GREEN_DUNGEON_BG | Dungeon | bg |  | Background (layer 1): never read by physics. |
| 771 | BLUE_DUNGEON_BG | Dungeon | bg |  | Background (layer 1): never read by physics. |
| 772 | PURPLE_DUNGEON_BG | Dungeon | bg |  | Background (layer 1): never read by physics. |
| 1000 | LABEL | Label | deco | L:label | Label. Cosmetic (1000 is outside 1001..1499: not solid). |
| 1001 | ONEWAY_CYAN | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1002 | ONEWAY_ORANGE | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1003 | ONEWAY_YELLOW | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1004 | ONEWAY_PINK | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1005 | Cyan Teal | doors | deco | S | Key door (1005 cyan, 1006 magenta, 1007 yellow): solid unless that key is active. §3.3 |
| 1006 | Pink Purple Violet | doors | deco | S | Key door (1005 cyan, 1006 magenta, 1007 yellow): solid unless that key is active. §3.3 |
| 1007 | Yellow | doors | deco | S | Key door (1005 cyan, 1006 magenta, 1007 yellow): solid unless that key is active. §3.3 |
| 1008 | Cyan Teal | gates | deco | S | Key gate (1008 cyan, 1009 magenta, 1010 yellow): solid while that key is active. §3.3 |
| 1009 | Pink Purple Violet | gates | deco | S | Key gate (1008 cyan, 1009 magenta, 1010 yellow): solid while that key is active. §3.3 |
| 1010 | Yellow | gates | deco | S | Key gate (1008 cyan, 1009 magenta, 1010 yellow): solid while that key is active. §3.3 |
| 1011 | DEATH_DOOR | death | deco | S L:int | Death door. Passable iff L <= deaths. §3.3 |
| 1012 | DEATH_GATE | death | deco | S L:int | Death gate. Passable iff L > showDeathGate. §3.3 |
| 1013 | Green Emerald Peridot | magic | fg | S | Solid. |
| 1014 | Purple Violet Amethyst | magic | fg | S | Solid. |
| 1015 | Yellow Orange Amber | magic | fg | S | Solid. |
| 1016 | Blue Sapphire | magic | fg | S | Solid. |
| 1017 | Red Ruby Garnet | magic | fg | S | Solid. |
| 1018 | Orange Persimmon Copper | basic | fg | S | Solid. |
| 1019 | Blue Cyan Light blue | beta | fg | S | Solid. |
| 1020 | Orange Copper | beta | fg | S | Solid. |
| 1021 | Black Dark Onyx | beta | fg | S | Solid. |
| 1022 | Gray Grey Concrete | brick | fg | S | Solid. |
| 1023 | Blue Dark Zaffre | brick | fg | S | Solid. |
| 1024 | Black Dark Coal | brick | fg | S | Solid. |
| 1025 | Orange | checker | deco | S | Solid. |
| 1026 | Black Dark Gray | checker | deco | S | Solid. |
| 1027 | TEAM_DOOR | teams | deco | S L:int | Team door. L = team 0..6. Passable iff team == L (team starts at 0; set by touching 423). §3.3, §6.4 |
| 1028 | TEAM_GATE | teams | deco | S L:int | Team gate. Passable iff team != L. §3.3, §6.4 |
| 1029 | Moon Rock Stone | outer space | fg | S | Solid. |
| 1030 | Wood Tree Brown | environment | fg | S | Solid. |
| 1031 | Leaves Grass Green | environment | fg | S | Solid. |
| 1032 | Bamboo Wood Yellow | environment | fg | S | Solid. |
| 1033 | Obsidian Rock Ice | environment | fg | S | Solid. |
| 1034 | Fire Lava Hot | environment | fg | S | Solid. |
| 1035 | Tile Double Floor | domestic | fg | S | Solid. |
| 1036 | Wood Brown Floor | domestic | fg | S | Solid. |
| 1037 | Red Carpet | domestic | fg | S | Solid. |
| 1038 | Blue Carpet | domestic | fg | S | Solid. |
| 1039 | Green Carpet Grass | domestic | fg | S | Solid. |
| 1040 | White Marble Box | domestic | fg | S | Solid. |
| 1041 | HALFBLOCK_DOMESTIC_YELLOW | domestic | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1042 | HALFBLOCK_DOMESTIC_BROWN | domestic | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1043 | HALFBLOCK_DOMESTIC_WHITE | domestic | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1044 | Green Limestone | stone | fg | S | Solid. |
| 1045 | Brown Dirt | stone | fg | S | Solid. |
| 1046 | Blue | stone | fg | S | Solid. |
| 1047 | Mossy Green Brick | halloween 2015 | fg | S | Solid. |
| 1048 | Siding Light gray | halloween 2015 | fg | S | Solid. |
| 1049 | Mossy Gray Green | halloween 2015 | fg | S | Solid. |
| 1050 | HALLOWEEN_2015_ONEWAY | halloween 2015 | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1051 | ONEWAY_SCIFI_YELLOW | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1052 | ONEWAY_GRAY | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1053 | ONEWAY_BLUE | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1054 | ONEWAY_RED | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1055 | ONEWAY_GREEN | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1056 | ONEWAY_BLACK | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1057 | Neutral Yellow Body | generic | deco | S | Solid. |
| 1058 | Caution Warning Hazard | generic | deco | S | Solid. |
| 1059 | Ice | arctic | fg | S | Solid. |
| 1060 |  | arctic | fg | S | Solid. |
| 1061 | Left | arctic | deco | S | Solid. |
| 1062 | Middle | arctic | fg | S | Solid. |
| 1063 | Right | arctic | deco | S | Solid. |
| 1064 | ICE | ice | deco | S | Ice. Solid. As the tile below the player (below, §4.2): slippery = 2 -> ice drag rules and jump x0.88. §4.2 |
| 1065 |  | gold | fg | S | Solid. |
| 1066 |  | gold | fg | S | Solid. |
| 1067 |  | gold | fg | S | Solid. |
| 1068 |  | gold | fg | S | Solid. |
| 1069 |  | gold | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1070 | Cobblestone Pebbles | fairytale | fg | S | Solid. |
| 1071 | Orange Tree | fairytale | fg | S | Solid. |
| 1072 | Green Moss | fairytale | fg | S | Solid. |
| 1073 | Blue Cloud | fairytale | deco | S | Solid. |
| 1074 | Red Mushroom Spotted | fairytale | deco | S | Solid. |
| 1075 | HALFBLOCK_FAIRYTALE_ORANGE | fairytale | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1076 | HALFBLOCK_FAIRYTALE_GREEN | fairytale | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1077 | HALFBLOCK_FAIRYTALE_BLUE | fairytale | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1078 | HALFBLOCK_FAIRYTALE_PINK | fairytale | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1079 | DOOR_ORANGE | switches | deco | S L:int | Orange door. Passable iff orangeSwitches[L]. §3.3 |
| 1080 | GATE_ORANGE | switches | deco | S L:int | Orange gate. Passable iff !orangeSwitches[L]. §3.3 |
| 1081 | Dirt Brown Soil | spring 2016 | fg | S | Solid. |
| 1082 | Hedge Green Leaf | spring 2016 | fg | S | Solid. |
| 1083 | Thatched Straw Seasonal | summer 2016 | fg | S | Solid. |
| 1084 | Planks Wood Seasonal | summer 2016 | fg | S | Solid. |
| 1085 | Planks Wood Seasonal | summer 2016 | fg | S | Solid. |
| 1086 | Planks Wood Seasonal | summer 2016 | fg | S | Solid. |
| 1087 | Platform Dock Wood | summer 2016 | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1088 | White Light | basic | fg | S | Solid. |
| 1089 | White Light | beta | fg | S | Solid. |
| 1090 | White Light | brick | fg | S | Solid. |
| 1091 | White Light | checker | deco | S | Solid. |
| 1092 | ONEWAY_WHITE | one-way | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1093 | Stone Brown Tan | mine | fg | S | Solid. |
| 1094 | CROWNDOOR | crown | deco | S | Crown door. Passable iff collideWithCrownDoorGate (set by crown 5, deferred). §3.3 |
| 1095 | CROWNGATE | crown | deco | S | Crown gate. Passable iff !collideWithCrownDoorGate. §3.3 |
| 1096 | Plywood Wood Brown | construction | fg | S | Solid. |
| 1097 | Gravel Stone Gray | construction | fg | S | Solid. |
| 1098 | Cement Stone Beige | construction | fg | S | Solid. |
| 1099 | Beam Metal Red | construction | fg | S | Solid. |
| 1100 | Beam Metal Red | construction | fg | S | Solid. |
| 1101 | HALFBLOCK_CHRISTMAS_2016_PRESENT_RED | christmas 2016 | deco | S H L:int | Solid non-rotatable half block (present). Collision uses the stored L (1 bottom, 2 left, 3 top, 0 right, else full; placed = 1); the current-tile rule always uses rot 1 (current = tile above). §3.2, §4.1 |
| 1102 | HALFBLOCK_CHRISTMAS_2016_PRESENT_GREEN | christmas 2016 | deco | S H L:int | Solid non-rotatable half block (present). Collision uses the stored L (1 bottom, 2 left, 3 top, 0 right, else full; placed = 1); the current-tile rule always uses rot 1 (current = tile above). §3.2, §4.1 |
| 1103 | HALFBLOCK_CHRISTMAS_2016_PRESENT_WHITE | christmas 2016 | deco | S H L:int | Solid non-rotatable half block (present). Collision uses the stored L (1 bottom, 2 left, 3 top, 0 right, else full; placed = 1); the current-tile rule always uses rot 1 (current = tile above). §3.2, §4.1 |
| 1104 | HALFBLOCK_CHRISTMAS_2016_PRESENT_BLUE | christmas 2016 | deco | S H L:int | Solid non-rotatable half block (present). Collision uses the stored L (1 bottom, 2 left, 3 top, 0 right, else full; placed = 1); the current-tile rule always uses rot 1 (current = tile above). §3.2, §4.1 |
| 1105 | HALFBLOCK_CHRISTMAS_2016_PRESENT_YELLOW | christmas 2016 | deco | S H L:int | Solid non-rotatable half block (present). Collision uses the stored L (1 bottom, 2 left, 3 top, 0 right, else full; placed = 1); the current-tile rule always uses rot 1 (current = tile above). §3.2, §4.1 |
| 1106 | White | tiles | fg | S | Solid. |
| 1107 | Gray Grey | tiles | fg | S | Solid. |
| 1108 | Black Gray Grey | tiles | fg | S | Solid. |
| 1109 | Red | tiles | fg | S | Solid. |
| 1110 | Orange | tiles | fg | S | Solid. |
| 1111 | Yellow | tiles | fg | S | Solid. |
| 1112 | Green | tiles | fg | S | Solid. |
| 1113 | Cyan | tiles | fg | S | Solid. |
| 1114 | Blue | tiles | fg | S | Solid. |
| 1115 | Purple | tiles | fg | S | Solid. |
| 1116 | HALFBLOCK_WHITE | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1117 | HALFBLOCK_GRAY | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1118 | HALFBLOCK_BLACK | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1119 | HALFBLOCK_RED | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1120 | HALFBLOCK_ORANGE | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1121 | HALFBLOCK_YELLOW | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1122 | HALFBLOCK_GREEN | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1123 | HALFBLOCK_CYAN | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1124 | HALFBLOCK_BLUE | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1125 | HALFBLOCK_PURPLE | Half Blocks | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1126 | Center Middle Dark | cloud | fg | S | Solid. |
| 1127 | Tube Plate Piston | industrial | fg | S | Solid. |
| 1128 | Beam Metal Red | construction | fg | S | Solid. |
| 1129 | Beam Metal Red | construction | fg | S | Solid. |
| 1130 | Beam Metal Red | construction | fg | S | Solid. |
| 1131 | Beam Metal Red | construction | fg | S | Solid. |
| 1132 | Cyan Aquamarine Turquoise | magic | fg | S | Solid. |
| 1133 | Scissor Scaffolding X | industrial | deco | S | Solid. |
| 1134 | INDUSTRIAL_TABLE | industrial | deco | S L:int | Solid. |
| 1135 | INDUSTRIAL_PIPE_THICK | industrial | deco | S L:int | Solid. |
| 1136 | Ice Brick Cyan | Winter 2018 | fg | S | Solid. |
| 1137 | Snow Pile Grey | Winter 2018 | fg | S | Solid. |
| 1138 | Glacier Snow Ice | Winter 2018 | fg | S | Solid. |
| 1139 | Slate Grey Gray | Winter 2018 | fg | S | Solid. |
| 1140 | HALFBLOCK_WINTER2018_SNOW | Winter 2018 | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1141 | HALFBLOCK_WINTER2018_GLACIER | Winter 2018 | deco | S H L:int | Solid half block (§3.2). L = rot: 1 bottom half, 2 left half, 3 top half, 0 right half, other = full tile. Center cell rot 1 -> current = tile above; rot 0 -> tile to the left (§4.1). |
| 1142 | White Opal Pearl | magic | fg | S | Solid. |
| 1143 | Rock Environment Brown | Garden | fg | S | Solid. |
| 1144 | Grass Moss Environment | Garden | fg | S | Solid. |
| 1145 | Leaves Green Leaf | Garden | fg | S | Solid. |
| 1146 | GARDEN_LATTICE_VINES | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 1147 | GARDEN_ONEWAY_FLOWER | Garden | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1148 | GARDEN_ONEWAY_LEAF_L | Garden | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1149 | GARDEN_ONEWAY_LEAF_R | Garden | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1150 | Green Screen Panel | sci-fi | fg | S | Solid. |
| 1151 | Yellow Screen Panel | sci-fi | fg | S | Solid. |
| 1152 | SILVERCROWNDOOR | crown | deco | S | Silver crown door. Passable iff collideWithSilverCrownDoorGate (set by trophy 121). §3.3 |
| 1153 | SILVERCROWNGATE | crown | deco | S | Silver crown gate. Passable iff !collideWithSilverCrownDoorGate. §3.3 |
| 1154 | Blue Cotton Candy Fairy Floss | candy | fg | S | Solid. |
| 1155 | METAL_PLATFORM | Toxic | deco | S 1W R1W L:int | Solid rotatable one-way (§3.2). L = rot: 1 = up (normal platform; default when placed), 2 = passable moving right (blocks from the right), 3 = passable moving down (ceiling), 0 = passable moving left; any other rot = full solid. |
| 1156 | GREY_DUNGEON_BRICK | Dungeon | fg | S | Solid. |
| 1157 | GREEN_DUNGEON_BRICK | Dungeon | fg | S | Solid. |
| 1158 | BLUE_DUNGEON_BRICK | Dungeon | fg | S | Solid. |
| 1159 | PURPLE_DUNGEON_BRICK | Dungeon | fg | S | Solid. |
| 1160 | DUNGEON_PILLAR_TOP | Dungeon | deco | S 1W L:int | Dungeon pillar top: solid one-way platform (plain rule, rotation L is cosmetic only). §3.2 |
| 1161 | Black Onyx | magic | fg | S | Solid. |
| 1162 | Magenta Pink Purple | sci-fi | fg | S | Solid. |
| 1163 | Cyan Screen Panel | sci-fi | fg | S | Solid. |
| 1164 | ONEWAY_SCIFI_MAGENTA | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1165 | ONEWAY_SCIFI_CYAN | sci-fi | deco | S 1W | Solid one-way platform (§3.2): not blocking while moving up / below the top (overlapa rule); solid when landing from above. |
| 1500 | HALLOWEEN_2016_PUMPKIN | halloween 2016 | deco | L:int | No effect (air for physics). |
| 1501 | Grass Plant Purple | halloween 2016 | above |  | No effect (air for physics). |
| 1502 | HALLOWEEN_2016_EYES | halloween 2016 | deco | L:int | Animated decoration (Math.random in drawing). Cosmetic, not solid. |
| 1503 | Sawhorse Orange White | construction | deco |  | No effect (air for physics). |
| 1504 | Cone Orange White | construction | deco |  | No effect (air for physics). |
| 1505 | Sign Orange Caution | construction | deco |  | No effect (air for physics). |
| 1506 | CHRISTMAS_2016_LIGHTS_UP | christmas 2016 | deco | L:int | No effect (air for physics). |
| 1507 | CHRISTMAS_2016_LIGHTS_DOWN | christmas 2016 | deco | L:int | No effect (air for physics). |
| 1508 | Bell Bow Holiday | christmas 2016 | deco |  | No effect (air for physics). |
| 1509 | Holly Berries Holiday Nature | christmas 2016 | deco |  | No effect (air for physics). |
| 1510 | CHRISTMAS_2016_CANDLE | christmas 2016 | deco |  | No effect (air for physics). |
| 1511 | Shamrock Clover Green | St. Patricks 2017 | above |  | No effect (air for physics). |
| 1512 | Pot of Gold | St. Patricks 2017 | above |  | No effect (air for physics). |
| 1513 | Horseshoe Gold | St. Patricks 2017 | deco |  | No effect (air for physics). |
| 1514 | Rainbow Left | St. Patricks 2017 | deco |  | No effect (air for physics). |
| 1515 | Rainbow Right | St. Patricks 2017 | deco |  | No effect (air for physics). |
| 1516 | GOD_BLOCK | tools | above |  | God block. Touch: enables the G key for god mode (UI only; G is not in .eetas). No physics effect. |
| 1517 | EFFECT_GRAVITY | effect | deco | L:int | Gravity effect. L = flipGravity: 0 down, 1 left, 2 up, 3 right, 4 none (other = unrotated, below = right). §6, §4.4 |
| 1518 | Down Arrow | gravity | deco |  | Gravity arrow down. current (0,2), delayed (0,2), not rotated. below uses the flipGravity default (not an explicit case). §4.4 |
| 1519 | Invisible Down Arrow | gravity | deco |  | Invisible down arrow = id 1518 (forces; below by flipGravity). Entering: blink, cosmetic. |
| 1520 | GUITAR | music | deco | L:int | Guitar. Not solid (1520 > 1499). Entering: plays note L, blink. Cosmetic for L in 0..48; any other L throws RangeError (49 guitar sounds) and aborts the rest of every tick that starts in the cell. |
| 1521 | Pole White | wild west | above |  | No effect (air for physics). |
| 1522 | Pole Gray Dark | wild west | above |  | No effect (air for physics). |
| 1523 | Top Side Dark | cloud | deco |  | No effect (air for physics). |
| 1524 | Bottom Side Dark | cloud | deco |  | No effect (air for physics). |
| 1525 | Left Side Dark | cloud | deco |  | No effect (air for physics). |
| 1526 | Right Side Dark | cloud | deco |  | No effect (air for physics). |
| 1527 | Top right Corner Dark | cloud | deco |  | No effect (air for physics). |
| 1528 | Top left Corner Dark | cloud | deco |  | No effect (air for physics). |
| 1529 | Bottom left Corner Dark | cloud | deco |  | No effect (air for physics). |
| 1530 | Bottom right Corner Dark | cloud | deco |  | No effect (air for physics). |
| 1531 | Fence Wood Center | farm | above |  | No effect (air for physics). |
| 1532 | Sign Red Caution | construction | deco |  | No effect (air for physics). |
| 1533 | Red Fire Hydrant | construction | deco |  | No effect (air for physics). |
| 1534 | METAL_LADDER | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 1535 | INDUSTRIAL_PIPE_THIN | industrial | deco | L:int | No effect (air for physics). |
| 1536 | DOMESTIC_PIPE_STRAIGHT | domestic | deco | L:int | No effect (air for physics). |
| 1537 | DOMESTIC_PIPE_T | domestic | deco | L:int | No effect (air for physics). |
| 1538 | DOMESTIC_FRAME_BORDER | domestic | deco | L:int | No effect (air for physics). |
| 1539 | Pipe Tube Mario | domestic | deco |  | No effect (air for physics). |
| 1540 | Trophy Bronze Design | Prizes | above |  | No effect (air for physics). |
| 1541 | Trophy Silver Design | Prizes | above |  | No effect (air for physics). |
| 1542 | Trophy Gold Design | Prizes | above |  | No effect (air for physics). |
| 1543 | Snow Pile Small | Winter 2018 | above |  | No effect (air for physics). |
| 1544 | Snow Pile Left | Winter 2018 | above |  | No effect (air for physics). |
| 1545 | Snow Pile Right | Winter 2018 | above |  | No effect (air for physics). |
| 1546 | Snowman Hat Carrot | Winter 2018 | above |  | No effect (air for physics). |
| 1547 | Tree Wood Snow | Winter 2018 | deco |  | No effect (air for physics). |
| 1548 | Snowflake Large Sky | Winter 2018 | deco |  | No effect (air for physics). |
| 1549 | Snowflake Small Sky | Winter 2018 | deco |  | No effect (air for physics). |
| 1550 | NPC_SMILE | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1551 | NPC_SAD | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1552 | NPC_OLD | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1553 | NPC_ANGRY | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1554 | NPC_SLIME | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1555 | NPC_ROBOT | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1556 | NPC_KNIGHT | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1557 | NPC_MEH | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1558 | NPC_COW | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1559 | NPC_FROG | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1560 | Grass Green Nature | Garden | above |  | No effect (air for physics). |
| 1561 | Fence White Short | Garden | above |  | No effect (air for physics). |
| 1562 | Fence Brown Lattice | Garden | deco |  | No effect (air for physics). |
| 1563 | GARDEN_STALK | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 1564 | Snail Shell | Garden | deco |  | No effect (air for physics). |
| 1565 | Butterfly | Garden | deco |  | No effect (air for physics). |
| 1566 | Wood Frame Window | Garden | above |  | No effect (air for physics). |
| 1567 | Green Dot Light | outer space | deco |  | No effect (air for physics). |
| 1568 | Yellow Dot Light | outer space | deco |  | No effect (air for physics). |
| 1569 | NPC_STARFISH | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1570 | NPC_BRUCE | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1571 | NPC_DT | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1572 | NPC_SKELETON | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1573 | NPC_ZOMBIE | npc | above | L:npc | Zombie NPC. Touch (entering, not flying, not zombie, not invulnerable): zombie = true with NO timer (permanent until protection / respawn / resetPlayer). §6.2 |
| 1574 | NPC_GHOST | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1575 | NPC_ASTRONAUT | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1576 | NPC_SANTA | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1577 | NPC_SNOWMAN | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1578 | NPC_WALRUS | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1579 | NPC_CRAB | npc | above | L:npc | NPC. Not solid. Talk with the C key (UI). No physics effect. |
| 1580 | SPIKE_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1581 | FIREWORKS | Fireworks | deco | L:int | Animated decoration (Math.random in drawing). Cosmetic, not solid. |
| 1582 | WORLD_PORTAL_SPAWN | tools | deco | L:int | World portal spawn. L = spawn id. Joins spawnPoints[L] (L = 0: same list as 255). No touch effect. §7 |
| 1583 | MAP_BLOCK | tools | above |  | Map block. Touch: enables the minimap. UI only. |
| 1584 | EFFECT_POISON | effect | deco | L:int | Poison effect. L = seconds (0 = remove). Timed death like curse, no other effect. §6.2 |
| 1585 | TOXIC_WASTE | liquids | above | LQ | Toxic waste (liquid). moy = -0.4, toxic drag. current -> killPlayer unless invulnerable (every tick). Touch: extinguishes fire. §4.5, §4.8 |
| 1586 | TOXIC_WASTE_SURFACE | Toxic | above |  | Liquid surface/decoration (wave, mud bubbles, lava surface, toxic surface). NOT a liquid, no effect. |
| 1587 | TOXIC_WASTE_BARREL | Toxic | deco | L:int | No effect (air for physics). |
| 1588 | SEWER_PIPE | Toxic | deco | L:int | No effect (air for physics). |
| 1589 | RUSTED_LADDER | Toxic | deco |  | No effect (air for physics). |
| 1590 | GUARD_RAIL | Toxic | above |  | No effect (air for physics). |
| 1591 | GOLDEN_EASTER_EGG | Special | above |  | Animated decoration (Math.random in drawing). Cosmetic, not solid. |
| 1592 | DUNGEON_PILLAR_BOTTOM | Dungeon | deco | L:int | No effect (air for physics). |
| 1593 | DUNGEON_PILLAR_MIDDLE | Dungeon | deco | L:int | No effect (air for physics). |
| 1594 | DUNGEON_ARCH_LEFT | Dungeon | deco | L:int | No effect (air for physics). |
| 1595 | DUNGEON_ARCH_RIGHT | Dungeon | deco | L:int | No effect (air for physics). |
| 1596 | SHADOW_A | Shadows | deco | L:int | No effect (air for physics). |
| 1597 | DUNGEON_TORCH | Dungeon | deco | L:int | No effect (air for physics). |
| 1598 | DUNGEON_BARS | Dungeon | deco |  | No effect (air for physics). |
| 1599 | DUNGEON_RING | Dungeon | deco |  | No effect (air for physics). |
| 1600 | DUNGEON_HOOK | Dungeon | deco |  | No effect (air for physics). |
| 1601 | DUNGEON_LOCK | Dungeon | deco |  | No effect (air for physics). |
| 1602 | DUNGEON_CHAIN | climbable | deco | C | Climbable (§4.4): current -> morx,mory 0; delayed -> mox,moy 0; no-modifier drag on both axes while current; flushes the delayed queue; ice below ignored. |
| 1603 | GREEN_SPACE | Special | deco |  | No effect (air for physics). |
| 1604 | GOLD_SACK | Special | deco |  | No effect (air for physics). |
| 1605 | SHADOW_B | Shadows | deco | L:int | No effect (air for physics). |
| 1606 | SHADOW_C | Shadows | deco | L:int | No effect (air for physics). |
| 1607 | SHADOW_D | Shadows | deco | L:int | No effect (air for physics). |
| 1608 | SHADOW_E | Shadows | deco |  | No effect (air for physics). |
| 1609 | SHADOW_F | Shadows | deco | L:int | No effect (air for physics). |
| 1610 | SHADOW_G | Shadows | deco | L:int | No effect (air for physics). |
| 1611 | SHADOW_H | Shadows | deco | L:int | No effect (air for physics). |
| 1612 | SHADOW_I | Shadows | deco | L:int | No effect (air for physics). |
| 1613 | SHADOW_J | Shadows | deco |  | No effect (air for physics). |
| 1614 | SHADOW_K | Shadows | deco | L:int | No effect (air for physics). |
| 1615 | SHADOW_L | Shadows | deco | L:int | No effect (air for physics). |
| 1616 | SHADOW_M | Shadows | deco | L:int | No effect (air for physics). |
| 1617 | SHADOW_N | Shadows | deco | L:int | No effect (air for physics). |
| 1618 | EFFECT_RESET | effect | deco |  | Reset effect. Touch: resetEffects(false): jump, fly, run, protection, low gravity -> off, maxJumps 1, flipGravity 0. Timed effects (curse, zombie, poison, fire) and team stay. §6 |
| 1619 | RESET_PURPLE | switches | deco | L:int | Purple reset. Touch (entering, not flying): if L == 1000 or switches[L]: pressPurpleSwitch(L, false). §5.3 |
| 1620 | RESET_ORANGE | switches | deco | L:int | Orange reset. Touch: if L == 1000 or orangeSwitches[L]: pressOrangeSwitch(L, false). §5.3 |
| 1622 | Mushroom Red Spotted | fairytale | deco |  | No effect (air for physics). |
| 1623 | Magenta Pink Purple | outer space | deco |  | No effect (air for physics). |
| 1624 | Cyan Dot Light | outer space | deco |  | No effect (air for physics). |
| 1625 | SPIKE_SILVER | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1626 | SPIKE_SILVER_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1627 | SPIKE_BLACK | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1628 | SPIKE_BLACK_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1629 | SPIKE_RED | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1630 | SPIKE_RED_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1631 | SPIKE_GOLD | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1632 | SPIKE_GOLD_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1633 | SPIKE_GREEN | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1634 | SPIKE_GREEN_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 1635 | SPIKE_BLUE | hazards | deco | L:int | Spikes (rotatable, L = rotation, cosmetic). current -> killPlayer unless invulnerable/dead (every tick, only the center cell counts). Not solid. §4.5 |
| 1636 | SPIKE_BLUE_CENTER | hazards | deco |  | Spikes, center (no rotation). current -> killPlayer unless invulnerable. §4.5 |
| 155, 161, 164, 183, 205, 217, 1166-1499 | (no brick defined) | - | - | S | Still SOLID if present in layer 0 (isSolid is purely id-range based). |
| 102-109, 112, 631-636, 764, 773-999, 1621, >= 1637, < 0 | (no brick defined) | - | - | | Air (no rule matches). |

## 11. Audit of `tools/tas/eesim.js` (read 2026-09-25) against this spec

Verified equal: the solid, climbable, one-way, rotatable one-way, half and non-rotatable half id lists (`buildFlags`,
eesim.js:132-157, compared id by id against ItemId.as). The overlaps algorithm with its side effects (`_ovAt`/`_ovSlow`
1233-1331; the fast paths are argued in the README). The door switch except 206/207 (see G3). The gravity and kill
tables (prepareLevel 273-302). below, slippery, the delayed queue, boosts, liquids. Coins (also while flying) and
their lookup deletion. Crowns, trophy, purple/orange switches and resets (including id 1000), checkpoints. Keys'
deferral and timer-refresh-on-revert. Jump, run, low gravity, multijump, gravity and reset effects. Protection and fire
(lava: death 241 ticks later, same as eeo-tas, because `(2.4*1000) = 2400` ms maps to `D = 240` ticks). Water/mud/toxic
extinguish. Portals for a single exit. The ee_level.gd `ROTATION_IDS` list equals the eeo-tas "reads an int" rule
exactly.

Gaps, most severe first (the same list is returned to the orchestrator):

- **G1 Time doors 156/157 use EE Offline's accumulating clock, not eeo-tas ticks (high).** eesim `tick()` (626-630)
  toggles when `_offset - _hide_timedoor_offset >= 150` with `_offset += 0.3` per tick. That toggles at ticks 501, 1001,
  1501, 2002, 2503, ..., 6010, ..., 11011 (drifting later). eeo-tas: `timedoorState = (t/100) % 10 >= 5`
  (World.as:147), i.e. exactly `t mod 1000 >= 500` (checked for every t < 2e7), toggling at 500, 1000, 1500, and so on.
  Fix: in World.update, `this._timedoor_state = ((this._T0 + this._ticks) % 1000) >= 500`. Key the stateKey on
  `t % 1000` for levels with 156/157. Drop `_hide_timedoor_offset`.
- **G2 Key duration (medium).** `_setKey`/expiry (1528-1533, 633) use `(_offset - _kt)/30 >= 5`. That lasts 500 or
  501 ticks (501 for about 34% of pickup ticks). eeo-tas: `keysTimer = t`, expiry and the fromqueue drop when
  `(t - kt)/100 >= 5`, i.e. `t - kt >= 500` (World.as:120, 122, 150): exactly 500 ticks. Fix: store the integer tick and
  compare `t - kt >= 500` in both places. The revert-refresh (`kt = t`) stays.
- **G3 Zombie gate/door inverted (medium; any level with 206/207).** `_doorPassable` (1369-1370) returns 206 -> false
  (solid) and 207 -> true (open). eeo-tas World.as:734-735: 206 (ZOMBIE_GATE) is passable iff `!zombie`, and 207
  (ZOMBIE_DOOR) iff `zombie`. For a non-zombie, 206 is open and 207 solid. This was inherited from ee_sim.gd:1158-1159.
  Fix: `case 206: return !this.zombie; case 207: return this.zombie;`.
- **G4 Curse 421, zombie 422, poison 1584 and the zombie NPC 1573 are not implemented (high where used).** Needed:
  the touch rules of 5.3, timers per 6.2 (`D = (d + 2*0.2) * 100`, death at the first t with `t - t0 > D`, checked at
  the start of the player tick in the order curse, zombie, fire, poison), zombie speed x0.6 and jump
  x0.75 (`_speed_multiplier` at 769 and `_jumpMultiplier` at 1609 lack it), zombie doors (G3), protection clearing all
  of them and blocking their pickup, respawn and resetPlayer clearing them, and the NPC zombie with no timer.
- **G5 Levitation (fly 418) is not implemented (high where used).** Per 6.3: the thrust state, jump disabled while
  levitating, `updateThrust` after touchBlock (even while dead), the decay sequence, the reset effect 1618 and
  resetPlayer clearing it.
- **G6 Team effect 423 and the team state are missing; team doors assume team 0 (medium where used).** `_doorPassable`
  (1367-1368) compares against 0. eeo-tas (6.4): touching 423 sets `team = L(cell)` with an overlap check. If it is
  blocked, the member tx/ty retry it at step c of every later tick (before movement). The team survives respawn;
  resetPlayer sets it to 0. Fix: add `team`, `teamTx/teamTy`, the 423 touch and the step-c retry, calling overlaps
  exactly as often as eeo-tas (the side effects matter). Doors 1027/1028 then compare against `team`. Key both in
  stateKey.
- **G7 Spawn points (medium for multi-spawn levels).** prepareLevel (229) collects only 255, in row-major scan order,
  and `_placeAtSpawn` (1593-1607) round-robins from index 0. eeo-tas: list 0 = 255 **and 1582 with L == 0, in file entry
  order** (World.as:359-366), plus per-id lists for world portal spawns. After "load, /reset" the TAS starts at index 1
  (7.2). Fix: have the level reader keep entry order and spawn ids, build `spawnPoints[k]`, and add `worldSpawn` and an
  initial `nextSpawnPos` option (0 for /resetall, 1 mod n for load + /reset).
- **G8 Respawn happens in the wrong place in the tick (low).** eesim `tick()` (660-663) respawns after draining the
  state/key queues (the EE Offline Player.draw order). eeo-tas respawns at the end of Player.tick (Player.as:1176-1179),
  before PlayState.enterFrame, so the queue retries of that tick run at the spawn position and with `deaths`
  incremented. Fix: move `respawn(); deaths++` to the end of `_playerTick`, after run_ticks.
- **G9 Gold door/gate 200/201 are hard-coded for "no gold border" (low).** `_doorPassable` 1355-1356. Make
  `wearsGoldSmiley` a sim option (the cookie `goldBorder`, PlayState.as:128).
- **G10 Initial state is fixed (low).** `reset()` (467-517) zeroes things that `/reset` does not reset in eeo-tas:
  `PlayState.ticks` T0, `nextSpawnPos`, orange switches, keys and their timers, pastx/pasty, lastPortal, the delayed
  queue, slippery, jumpCount, overlapa..d (section 9). Expose them as options, or document the required start sequence
  (`/reset`, then `/resetall`, then `/playtas`; section 9).
- **G11 Fire timer is written in ms (info).** The result is identical for lava (d = 2). When adding G4, use the tick
  formula for all four timers. Porting the ms form to other durations would be off by one tick for d in 16-20 and 262-327: `(d+0.4)*1000` ms
  gives death 1 tick later than eeo-tas's `(d+0.4)*100` ticks there (checked for d = 1..999).
- **G12 Multi-exit portals (info).** eeo-tas picks with `Math.random` from a list in AS3 for-in order, which cannot be
  reproduced. eesim's `rngScript` (1133-1154) picks an index into its own list (extras order). To replay a real eeo-tas
  run, the script has to name the exit **position** actually taken, not an index.
- **G13 World portal 374 and reset point 466 (info).** They need the Y key, which is not in `.eetas`, so eesim ignoring
  them is correct for replays. If a "Y held" input is ever added: the reset point is checked every tick, and the world
  portal triggers resetPlayer(worldSpawn = target) or another level.
- **G14 Per-frame queue timing (info).** eesim drains `queue` and `keysquene` after every tick. That is exact only when
  eeo-tas ran at most 1 tick per frame (section 1). Document the assumption.
- **G15 The reset effect must also clear levitation (with G5).** eesim's EFFECT_RESET (1473-1476) clears the others
  correctly.
- **G16 Protection must also clear curse/zombie/poison (with G4).** It currently clears only fire (1465-1471).
- **G17 Lookup values from layer-1 entries (low, level reader).** eeo-tas calls `lookup.setInt` for numbered or rotatable
  types in either layer (World.as:296-298, 331-348), so a layer-1 entry can overwrite the int of the layer-0 block in the
  same cell. ee_level.gd (121-126) keeps extras for layer 0 only. It only matters for crafted files.
- **G18 Key expiry order (info).** eeo-tas iterates the `keys` object with for-in (unspecified order); eesim uses red to
  yellow. It only matters when two keys expire on the same tick while their doors overlap the player.
