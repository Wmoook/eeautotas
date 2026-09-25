# eeo-tas movement physics: Player.as and everything it calls

This is the ground-truth spec for a bit-exact JavaScript reimplementation of player movement in the eeo-tas client.
Source: `C:\Users\super\eeo-tas\src` (paths below are relative to it). The original EE Offline
(`C:\Users\super\ee-offline\src`) differs in the places listed in section 0.4. Section 12 audits
`tools/tas/eesim.js` against this spec.

Contents
- 0 Conventions (numbers, units, AS3 semantics, ee-offline differences)
- 1 Where Player.tick runs (frame loop, PlayState.tick, order of objects)
- 2 Constants (Config.as, exact bits)
- 3 Player state that affects physics
- 4 Player.tick, step by step, with formulas
- 5 Collision: World.overlaps
- 6 Per-block physics table
- 7 Effects (setEffect, touchBlock) and timed deaths
- 8 Death, respawn, spawn points
- 9 Input: .eetas bytes to horizontal/vertical/jump
- 10 Initial state (fresh load vs `/reset`)
- 11 Things that are not deterministic per tick
- 12 Audit of tools/tas/eesim.js (gap list)
- 13 Derived numbers for sanity checks

---

## 0 Conventions

### 0.1 Numbers and AS3 semantics
- AS3 `Number` is an IEEE-754 double, the same as a JS number. `int` is 32-bit signed. Storing a Number into an
  `int` field, variable or parameter applies ECMAScript ToInt32: NaN becomes 0, the value truncates toward zero
  and wraps mod 2^32. JS `x | 0` does the same.
- `a >> k`, `a << k` and `x >>= 0` apply ToInt32 first, exactly like JS. On a non-negative position `x >>= 0`
  is `Math.floor`.
- `%` on Numbers is IEEE fmod (the result has the sign of the dividend), the same as JS `%`.
- Every multiplication must be done in the order written. `_speedX *= a; _speedX *= b` is not `_speedX *= a*b`.
- **Hoisting.** A `var` declared anywhere in a function body (including inside an `if` block) is function scoped
  and initialised at function entry: `Number` to NaN, `int` to 0, `Boolean` to false, objects to null. This
  creates the team-door quirk in 4.3.
- Truth tests on Numbers (`if (this.moy)`, `morx && mox`) are false for +0, -0 and NaN.
- A `switch` compares its cases in order with `===`, and the first match wins. Duplicate case labels are legal
  and the later duplicates are dead code (see 4.4).

### 0.2 Units and the speed scale
- Position `x, y` (Player.as:132-153, SecureNumber, a plain double in practice) is the top-left corner of the 16x16
  hit box, in pixels. A tile is 16 px. `(cx, cy)` are tile coordinates.
- Speeds are stored in `_speedX, _speedY` and accelerations in `_modifierX, _modifierY`
  (SynchronizedObject.as:8-11), all in **pixels per tick**.
- The public properties `speedX, speedY, modifierX, modifierY` (SynchronizedObject.as:49-92) scale by
  `mult = Config.physics_variable_multiplyer = 7.752`:
  - get: `isNaN(_v) ? 0 : _v * 7.752`
  - set(value): `_v = value / 7.752`
  
  Wherever the code uses the public property, the multiply and divide round trip is part of the arithmetic
  and must be reproduced bit for bit. This applies to `this.modifierX = ...` (every tick), jumps, portal
  rotation, levitation thrust, respawn and savestate load.
- One tick is one `PlayState.tick()` that passes its tick gate (PlayState.as:558). Nominally it is 10 ms
  (`Config.physics_ms_per_tick`). No physics formula uses the tick length: the drag constants are computed once
  at class initialisation with the value 10, and `/playtas N` changes only the wall clock.

### 0.3 Field types that matter
| field | type | where | consequence |
|---|---|---|---|
| `morx, mory` | **int** | Player.as:85-86 | Buoyancies -0.5 / 0.4 / 0.2 / -0.4 are truncated to 0. Only ±2 or 0 survive. |
| `mox, moy, mx, my` | Number | SynchronizedObject.as:28-32 | Keep the fractional buoyancies and multipliers. |
| `horizontal, vertical` | int | Player.as:288-289 | -1, 0 or +1 |
| `cx, cy` | int, **public members** | Player.as:122-123 | They are modified by the half-block adjustment (4.2) and then passed to touchBlock. |
| `currentSX, currentSY` | Number, public members | Player.as:125-126 | Sub-step remaining displacement (tick temporaries). |
| `reminderX, reminderY` | Number, tick locals captured by the nested functions | Player.as:833,836 | Sub-step fractional part. |
| `ox, oy` | Number, public members | Player.as:293-294 | Position before the current sub-step. Also read by `World.overlaps` (one-ways). Initial value 0. |
| `queue` | `Vector.<int>(2)` | Player.as:274 | The two-tick gravity queue, initially `[0, 0]`. |
| `slippery` | Number | Player.as:375 | Ice timer. |
| `jumpCount, maxJumps` | int | Player.as:378-379 | Initial values 0 and 1. |
| `flipGravity, jumpBoost, speedBoost` | int (SecureInt) | Player.as:317-319 | |
| `low_gravity` | Boolean | Player.as:312 | |
| `_currentThrust` | Number | Player.as:327 | Levitation thrust. |
| `lastPortal` | Point or null | Player.as:300 | **Initially non-null** (`new Point()`). |
| `overlapa..overlapd` | int | Player.as:88-91 | One-way memory, initially -1. |
| `pastx, pasty` | int | Player.as:272-273 | Last touched cell, initially 0,0. |
| `team` | int | Player.as:233 | See 4.3. |

### 0.4 eeo-tas vs ee-offline (only the differences that touch movement)
- Player.as:399-404: timed kills compare `state.ticks` (the PlayState tick counter) with a duration in ticks.
  ee-offline compared `Date` milliseconds.
- Player.as:1724-1730 `setEffect`: `if (duration > 0) { if (!arg) arg = state.ticks; duration += 2*Global.ping;
  duration *= 100; }`. ee-offline used Date. Me.as passes `arg = 0` for curse, zombie, poison and fire.
- Player.as:1176-1179: the respawn after death runs **at the end of Player.tick**. ee-offline did it in `draw()`.
- Player.as:406-407, 834, 837: `cx, cy, currentSX, currentSY` became members. This does not change behaviour.
- World.as:117-153: keys and time doors are based on `PlayState.ticks`, not the `World.offset` clock. This belongs
  to the world spec, but it changes collision (5.5).

---

## 1 Where Player.tick runs

### 1.1 Frame loop (blitter/BlGame.as `handleEnterFrame`)
```
if ((now - Bl.time) / ms_per_tick > 15) Bl.time = now - ms_per_tick*15      // at most 15 ticks of catch-up
for (; Bl.time < now; Bl.time += ms_per_tick) state.tick();                 // 0..15 PlayState.tick() per frame
state.enterFrame();                                                          // ONCE PER FRAME
Bl.exitFrame(); state.exitFrame(); state.draw(...)
```
The stage frame rate is 120 (PlayState.as:191). At `/playtas 1` (ms_per_tick = 10) a frame usually runs 0 or 1
ticks and sometimes 2. `PlayState.enterFrame` (PlayState.as:478-526) processes the deferred queues (orange
switch, crown and silver-crown re-checks, key re-sets, block placement). That makes their timing relative to
ticks real-time dependent (section 11). A per-tick model ("run enterFrame after every tick") is what happens
whenever a frame has at most one tick.

### 1.2 PlayState.tick (PlayState.as:534-795), in order
1. The tick gate (536-558). During replay `TASGlobal.ticksEnabled` is true. If `eetasInput.bytesAvailable > 0`,
   `TASGlobal.getTASInput = true` (this tick reads one input byte, see 9). When the bytes run out, the next tick
   sets `endofTAS`. Later ticks read the keyboard.
2. `ui2instance.tick()`, then `ticks++` (562). **`PlayState.ticks` is the clock for effects, keys and time doors.**
3. The coin, blue-coin and death gate display values, each set and then reverted if `world.overlaps(player)` is
   non-zero (564-575). Each call has overlaps side effects (5.6).
4. Particles, UI keys, god-mode key (656-669), camera and mouse editing (not part of a TAS; a middle click on
   empty space with edit rights `return`s before step 6, skipping world and player for that tick, 687-697).
5. `playerOverlaps()` (792, 940-970): curse and zombie tagging between players. With no fake players it only
   decrements `touchCooldown`, which does not affect movement.
6. `super.tick()` means BlContainer.tick (blitter/BlContainer.as): every child's `tick()` **in insertion order:
   `world` (added at PlayState.as:110), fake players (addBefore player), then `player` (131)**, then the camera.
   - `World.tick()` calls `World.update()` (World.as:137-156): `offset += .3`, particles,
     `setTimedoor((PlayState.ticks/100) % 10 >= 5)`, then for every active key with
     `(PlayState.ticks - keysTimer[color]) / 100 >= 5` it calls `PlayState.switchKey(color, false)`, which
     calls overlaps.
   - `Player.tick()` is section 4.

---

## 2 Constants (Config.as:44-65, SynchronizedObject.as:13-26)

| name | formula | value used (little-endian hex of the double) |
|---|---|---|
| `physics_variable_multiplyer` (MULT) | 7.752 | 7.752 |
| `physics_base_drag` | `pow(.9981,10)*1.00016093` | `6accf435f866ef3f` (0.98131952799157074) |
| `physics_no_modifier_drag` | `pow(.99,10)*1.00016093` | `1db5c8e6e3f1ec3f` |
| `physics_toxic_drag` | `pow(.99,10)*1.00016093` | `1db5c8e6e3f1ec3f` (same as no-modifier) |
| `physics_water_drag` | `pow(.995,10)*1.00016093` | `8dffc581bf70ee3f` |
| `physics_mud_drag` | `pow(.975,10)*1.00016093` | `1bcd6139b7d8e83f` |
| `physics_lava_drag` | `pow(.98,10)*1.00016093` | `b6e3faa08926ea3f` |
| `physics_ice_no_mod_drag` | `pow(.9993,10)*1.00016093` | `fac64b3b25c8ef3f` |
| `physics_ice_drag` | `pow(.9998,10)*1.00016093` | `bebf054af2f0ef3f` |
| `physics_jump_height` | 26 | |
| `physics_gravity` (`_gravity`) | 2 | |
| `physics_boost` (`_boost`) | 16 | |
| `physics_water_buoyancy` | -0.5 | |
| `physics_mud_buoyancy` | 0.4 | |
| `physics_lava_buoyancy` | 0.2 | |
| `physics_toxic_buoyancy` | -0.4 | |
| `physics_queue_length` | 2 | |
| `Global.ping` (Global.as:166-169) | 0.2 | |
| levitation `_maxThrust`, `_thrustBurnOff` (Player.as:325-326) | 0.2, 0.01 | |

**The pow values: never compute them with V8's `Math.pow`.** V8 returns different last bits for 7 of the 8
(for example no-modifier gives `1eb5...` instead of `1db5...`). The hex column is the result of the MSVC CRT `pow`
(Godot) and also of binary exponentiation (square and multiply). Plain repeated multiplication differs on 6 of
the 8. BASE and NO_MOD (= TOXIC) are confirmed by the bit-exact replay of the Forgotten Veil eeo-tas TAS, which uses
both on nearly every tick. That rules out an fdlibm-style pow like V8's in the Flash runtime. It is likely, but not
verified, that the runtime uses the same Windows CRT `pow` or square-and-multiply. WATER, MUD, LAVA, ICE and
ICE_NO_MOD have not yet been checked against eeo-tas (Forgotten Veil has none of these blocks). The first real
trace through water, mud, lava or ice confirms them.

---

## 3 Player state that affects physics
Section 0.3 lists the core fields. Effects: `jumpBoost` (0, 1 = x1.3 jump, 2 = x0.75 jump), `speedBoost`
(0, 1 = x1.5, 2 = x0.6), `low_gravity`, `hasLevitation`, `isThrusting`, `_currentThrust`, `maxJumps`
(1000 or more = infinite), `flipGravity` (0 down, 1 left, 2 up, 3 right, 4 none; other values act as 0 for gravity
and like 3 for `current_below`), `isInvulnerable`, `cursed`, `zombie`, `poison`, `isOnFire`, and the
`*TimeStart` / `*Duration` pairs. `isFlying = isInGodMode || isInModMode` (Player.as:1897-1899). A .eetas file
cannot toggle either mode (both need keyboard keys), so a TAS is never flying unless the user presses G or P
during the replay.

Multipliers (all evaluated when read, in this exact order):
```
gravityMultiplier (347-352): gm = 1; if (low_gravity) gm *= 0.15; gm *= worldGravityMultiplier;
jumpMultiplier   (354-361): jm = 1; if (jumpBoost==1) jm *= 1.3; if (jumpBoost==2) jm *= .75;
                            if (zombie) jm *= .75; if (slippery > 0) jm *= .88;
speedMultiplier  (363-369): sm = 1; if (speedBoost==1) sm *= 1.5; if (speedBoost==2) sm *= .6; if (zombie) sm *= .6;
```
`zombie` reads as false while flying (1680-1684). `worldGravityMultiplier` is the level header's float32 gravity
widened to double, used as is (PlayState.as:116, CampaignPage.as:608). **0 is not replaced by 1:** a header
gravity of 0 means no gravity at all.

---

## 4 Player.tick (Player.as:381-1180), step by step

### 4.1 Visual counters and timed deaths (384-404)
`animoffset`, `modoffset`, `auraAnimOffset` are visual only. Then:
```
if (isDead) deadoffset += .3; else deadoffset = 0;
if (!isDead) {
  if (cursed   && curseDuration  && state.ticks - curseTimeStart  > curseDuration)  killPlayer();
  if (zombie   && zombieDuration && state.ticks - zombieTimeStart > zombieDuration) killPlayer();
  if (isOnFire && fireDuration   && state.ticks - fireTimeStart   > fireDuration)   killPlayer();
  if (poison   && poisonDuration && state.ticks - poisonTimeStart > poisonDuration) killPlayer();
}
```
Durations are in ticks (section 7.2). `killPlayer` (1202-1210): `if (!isFlying && !isDead) isDead = true`.

### 4.2 Tile under the centre, the delayed queue and half blocks (406-419)
```
cx = (x + 8) >> 4;  cy = (y + 8) >> 4;           // ToInt32 then shift
delayed = queue.shift();                          // oldest entry (2 ticks old)
current = world.getTile(0, cx, cy);               // layer 0; 0 outside the world (BlTilemap.as:151-158)
if (isHalfBlock(current)) {                       // ids 1041-1043,1075-1078,1101-1105,1116-1125,1140,1141
  rot = world.lookup.getInt(cx, cy);              // the block's rotation (0 if none)
  if (!isBlockRotateable(current) && isNonRotatableHalfBlock(current)) rot = 1;   // presents 1101-1105
  if (rot == 1) cy -= 1;                          // bottom half: use the tile ABOVE
  if (rot == 0) cx -= 1;                          // right half:  use the tile to the LEFT
  current = world.getTile(0, cx, cy);             // rot 2 (left half) / 3 (top half): current stays the half block
}
```
The adjusted `cx, cy` (members) are used for everything below: current_below, portals, touchBlock, pastx/pasty.

### 4.3 The team reset quirk (421, 1583-1604)
`if (tx != -1) UpdateTeamDoors(tx, ty);` does not read the members `tx, ty` (278-279). `tick()` declares
`var tx:Number` (1012) and `var ty:Number` (1029), which are hoisted and are NaN at this point. `NaN != -1` is
true, so every tick calls `UpdateTeamDoors(0, 0)` (NaN becomes int 0):
```
id = world.lookup.getInt(0, 0);        // normally 0 (the border tile has no number)
tx = 0; ty = 0;                        // members, never read elsewhere
UpdateTeamDoorsById(id, false):
  oid = team; if (team == id) return;
  team = id;
  if (world.overlaps(player)) team = oid;      // full overlaps side effects (5.6)
  else { tx = -1; ty = -1; }
```
So at the start of every tick `team` goes back to `T0 = lookup.getInt(0,0)`. The only exception is when that
would put the player's box inside a solid, and then overlaps is still called and its side effects happen. A team
effect block (423, 7.1) sets `team` in touchBlock at the end of a tick, so the new team applies only to
overlaps calls **between** that tick and the next tick's line 421: PlayState.enterFrame queues, the next tick's
three coin-gate overlaps (PlayState.as:564-575) and World.update key expiry. For movement collision, team doors
and gates behave as team `T0`.

### 4.4 current_below (423-440)
```
switch (current) {
  case 1: case 411: x=-1; break;       // left arrows
  case 2: case 412: y=-1; break;       // up arrows
  case 3: case 411: x=+1; break;       // only 3 (411 already matched above)
  case 4: case 412: y=+1; break;       // only 4 (412 already matched above)
  default: switch (flipGravity) { case 0: y=+1; case 1: x=-1; case 2: y=-1; default: x=+1; }   // each with break
}
current_below = world.getTile(0, cx + x, cy + y);
```
The duplicate labels make 413, 414, 1518 and 1519 fall to `default`, which uses the flip direction. flipGravity 3,
4 or any other value uses `x+1`. `current_below` is used only for ice (4.14).

### 4.5 Gravity queue push (442-447)
```
queue.push(current);
if (current == 4 || current == 414 || isClimbable(current)) { delayed = queue.shift(); queue.push(current); }
```
Normal tiles: `delayed` is the `current` of 2 ticks ago. Dots and climbables: `delayed` becomes the `current` of
1 tick ago, and the queue is left as `[current, current]`, so the next tick's `delayed` is this tick's tile.
Climbable = 120, 118, 98, 99, 424, 459, 460, 472, 1534, 1146, 1563, 1602 (ItemId.as:376-394).

### 4.6 Deferred purple switches (449-450)
`tilequeue` holds purple-switch presses that were blocked by an overlap. Each queued entry runs once per tick,
in order, here (`pressPurpleSwitch`, 1570-1581; if the player still overlaps, the entry is re-queued).

### 4.7 Input (452, Me.as:30-67) - section 9
Sets `horizontal = leftdown + rightdown`, `vertical = updown + downdown` (each -1, 0 or +1), `spacejustdown`
and `spacedown`. **During replay `spacejustdown = spacedown = bit0`.**

### 4.8 Dead: no input (454-459)
`if (isDead) { spacejustdown = spacedown = false; horizontal = vertical = 0; }`

### 4.9 Gravity from `current` (morx, mory: int) and kills (461-566)
```
rotateGravitymo = rotateGravitymor = true; isgodmod = isFlying;
morx = mory = 0; mox = moy = 0;                 // (464-467)
if (!isgodmod) {
  if (isClimbable(current)) { morx = mory = 0; }                         // rotateGravitymor stays true
  else switch (current) {
    1, 411:          morx = -2; mory = 0; rotateGravitymor = false;
    2, 412:          morx = 0;  mory = -2; rotateGravitymor = false;
    3, 413:          morx = +2; mory = 0; rotateGravitymor = false;
    1518, 1519:      morx = 0;  mory = +2; rotateGravitymor = false;
    114-117, 4, 414: morx = mory = 0;
    119 WATER:       mory = int(-0.5) = 0
    369 MUD:         mory = int(0.4)  = 0
    416 LAVA:        mory = int(0.2)  = 0
    1585 TOXIC:      mory = int(-0.4) = 0;  if (!isDead && !isInvulnerable) killPlayer();
    368 FIRE, spikes 361,1580,1625..1636:  mory = 2;  if (!isDead && !isInvulnerable) killPlayer();
    default:         mory = 2
  }
```

### 4.10 Gravity from `delayed` (mox, moy: Number) (568-638)
```
  if (isClimbable(delayed)) { mox = moy = 0; }
  else switch (delayed) {
    1, 411:  mox = -2; rotateGravitymo = false;     2, 412:  moy = -2; rotateGravitymo = false;
    3, 413:  mox = +2; rotateGravitymo = false;     1518, 1519: moy = +2; rotateGravitymo = false;
    114-117, 4, 414: 0, 0
    119: moy = -0.5    369: moy = 0.4    416: moy = 0.2    1585: moy = -0.4    (no kill here)
    default: moy = 2
  }
}   // end !isgodmod
```

### 4.11 flipGravity rotation (640-690)
Only the pairs whose rotate flag is still true are rotated (arrows keep their direction; default gravity,
liquids and spikes rotate). `temp` is a Number.
```
1: mo: t=mox; mox=-moy; moy=t;     mor: t=morx; morx=-mory; mory=t;
2: mo: mox=-mox; moy=-moy;         mor: morx=-morx; mory=-mory;
3: mo: t=mox; mox=moy; moy=-t;     mor: t=morx; morx=mory; mory=-t;
4: mo: mox=moy=0;                  mor: morx=mory=0;
other values: no change
```
This can produce -0 (for example `moy = -t` with t = 0). -0 is harmless because every later use is a truth test,
a comparison or an addition to +0.

### 4.12 Which input axes are active (692-707)
```
if (isLiquid(delayed))  { mx = horizontal; my = vertical; }      // liquid = 119, 369, 416, 1585
else if (moy)           { mx = horizontal; my = 0; }
else if (mox)           { mx = 0; my = vertical; }
else                    { mx = horizontal; my = vertical; }
```

### 4.13 Multipliers and acceleration (709-715)
```
mx *= speedMultiplier; my *= speedMultiplier;
mox *= gravityMultiplier; moy *= gravityMultiplier;
this.modifierX = mox + mx;    // setter: _modifierX = (mox + mx) / 7.752
this.modifierY = moy + my;    // setter: _modifierY = (moy + my) / 7.752
```

### 4.14 Ice (717-723)
```
if (isSlippery(current_below) && !isClimbable(current) && current != 4 && current != 414) slippery = 2;  // ICE 1064
else if (isSolid(current_below)) slippery = 0;
else if (slippery > 0) slippery -= .2;
```
The float decay after leaving ice (over non-solid tiles) is 1.8, 1.6, 1.4000000000000001, ...,
0.2000000000000003, **2.7755575615628914e-16**, -0.19999999999999973. So `slippery > 0` holds for 10 more ticks,
not 9.

### 4.15 Drag, cap and snap (725-805)
X (Y is the same with `speedY/modifierY/my/mox` in place of `speedX/modifierX/mx/moy`):
```
if (_speedX || _modifierX) {
  _speedX += _modifierX;
  opp = (_speedX < 0 && mx > 0) || (_speedX > 0 && mx < 0);                    // uses the NEW _speedX
  if ((((mx == 0 && moy != 0) || opp) && (slippery <= 0 || isgodmod)) || (isClimbable(current) && !isgodmod)) {
    _speedX *= base_drag; _speedX *= no_modifier_drag;
  } else if (current == 119 && !isgodmod) { _speedX *= base_drag; _speedX *= water_drag; }
  else if (current == 369 && !isgodmod)   { _speedX *= base_drag; _speedX *= mud_drag; }
  else if (current == 416 && !isgodmod)   { _speedX *= base_drag; _speedX *= lava_drag; }
  else if (current == 1585 && !isgodmod)  { _speedX *= base_drag; _speedX *= toxic_drag; }
  else if (slippery > 0 && !isgodmod) {
    if (mx != 0 && !opp) _speedX *= base_drag; else _speedX *= ice_no_mod_drag;
    if (opp)             _speedX *= ice_drag;
  } else _speedX *= base_drag;
  if (_speedX > 16) _speedX = 16; else if (_speedX < -16) _speedX = -16;
  else if (_speedX < 0.0001 && _speedX > -0.0001) _speedX = 0;
}
```
The Y branch tests `(my == 0 && mox != 0)`. Liquid, climbable and dot drags come from `current`. The input axis
choice (4.12) comes from `delayed`.

### 4.16 Boosts and dead freeze (807-831)
```
if (!isgodmod) {
  switch (current) { 114: _speedX = -16; 115: _speedX = 16; 116: _speedY = -16; 117: _speedY = 16; }
  if (isDead) { _speedX = 0; _speedY = 0; }
}
```

### 4.17 Sub-stepped movement (833-935)
```
reminderX = x % 1; currentSX = _speedX; reminderY = y % 1; currentSY = _speedY;
donex = doney = false; grounded = false;
while ((currentSX != 0 && !donex) || (currentSY != 0 && !doney)) {
  processPortals();                 // 4.18, at the top of EVERY iteration
  ox = x; oy = y; osx = currentSX; osy = currentSY;
  stepx(); stepy();                 // BOTH run every iteration, even after that axis is done
}
```
stepx (846-882). stepy is identical with y, `reminderY`, `currentSY`, `_speedY`, `mory`, `doney`:
```
if (currentSX > 0) {
  if (currentSX + reminderX >= 1) { x += (1 - reminderX); x >>= 0; currentSX -= (1 - reminderX); reminderX = 0; }
  else { x += currentSX; currentSX = 0; }
} else if (currentSX < 0) {
  if (reminderX + currentSX < 0 && (reminderX != 0 || isBoost(current))) {
    currentSX += reminderX; x -= reminderX; x >>= 0; reminderX = 1;
  } else { x += currentSX; currentSX = 0; }
}
if (world.overlaps(player)) {                 // section 5, with the NEW x
  x = ox;
  if (_speedX > 0 && morx > 0) grounded = true;
  if (_speedX < 0 && morx < 0) grounded = true;
  _speedX = 0;
  currentSX = osx;                            // restores the step's start value
  donex = true;
}
```
Exact consequences that must be reproduced:
- **Moving left from an integer x** (`reminderX == 0`) on a non-boost tile moves the whole remaining distance in
  one step (`x += currentSX`), with one collision test at the end. Moving right always goes to the next integer
  first, then 1 px steps, then the fraction. Moving left from a fractional x goes to the integer below, then 1 px
  steps (`reminderX = 1`), then the fraction. On a boost tile, left or up from an integer position first takes a
  zero-length step, then 1 px steps.
- After a collision `x` is restored but **`reminderX` is not**. It keeps the value it got in the failed step
  (0 or 1), so it can disagree with `x % 1` from then on.
- After `donex`, stepx still runs in every later iteration with `currentSX = osx`. So the X movement is retried
  after each Y sub-step (sliding along corners). A later success moves x but leaves `_speedX = 0`.
- `grounded` is a tick local, set only by a blocked step toward the current tile's gravity (`morx/mory`).

### 4.18 processPortals (1051-1174): teleport and velocity rotation
Called at the top of every loop iteration, with the tick-start `cx, cy`. They are not recomputed, because the
recompute lines are commented out.
```
current = world.getTile(0, cx, cy);               // same value as before (no tile changes in between)
if (!isgodmod && current == 374 WORLD_PORTAL) { ... only with the keyboard key Y (KeyBinding.risky) held ... }
p = lookup.getPortal(cx, cy);                     // default Portal(0,0,0) if none
if (isgodmod || (current != 242 && current != 381) || p.target == p.id) { lastPortal = null; return; }
if (lastPortal != null) return;
lastPortal = Point(cx<<4, cy<<4);
portals = lookup.getPortals(p.target);            // every portal (242 or 381) whose id == p.target
if (portals.length <= 0) return;                  // lastPortal stays set
cp = portals[floor(Math.random() * n)];           // randomRange(0, n-1): RANDOM if n > 1 (section 11)
old = p.rotation; new = lookup.getPortal(cp.x>>4, cp.y>>4).rotation;   // 0 down, 1 left, 2 up, 3 right
if (old < new) old += 4;
osx = speedX; osy = speedY; omx = modifierX; omy = modifierY;      // getters (x 7.752)
magic = 1.42;
switch (old - new) {
  case 1: speedX = osy*magic;  speedY = -osx*magic; modifierX = omy*magic;  modifierY = -omx*magic;   // setters (/ 7.752)
          reminderY = -reminderX; currentSY = -currentSX; break;          // currentSX, reminderX unchanged
  case 2: speedX = -osx*magic; speedY = -osy*magic; modifierX = -omx*magic; modifierY = -omy*magic;
          reminderY = -reminderY; currentSY = -currentSY; reminderX = -reminderX; currentSX = -currentSX; break;
  case 3: speedX = -osy*magic; speedY = osx*magic;  modifierX = -omy*magic; modifierY = omx*magic;
          reminderX = -reminderY; currentSX = -currentSY; break;          // currentSY, reminderY unchanged
  // case 0 (same rotation): nothing changes, not even the 1.42 factor
}
x = cp.x; y = cp.y; lastPortal = cp;
```
- Speed values are `((_v * 7.752) * 1.42) / 7.752` with the rounding at each step. They are not `_v * 1.42`.
- The remaining sub-step displacement (`currentSX/SY`) is rotated but **not** scaled. Case 1 keeps `currentSX`
  **and** sets `currentSY = -currentSX`, and case 3 does the mirror. That is the literal behaviour.
- The new remainders can be negative or stale. `x = cp.x` is an integer, but `reminderX` is not reset, so the
  first step after a teleport can advance by `1 - reminderX` and then truncate back (4.17).
- One teleport per tick at most: later iterations see the same `current` and a non-null `lastPortal`.
  `lastPortal` goes back to null only in a tick whose loop runs while the tick-start tile is not an active portal.
  A player whose tick-start tile is still a portal (for example the exit portal, or a portal chain) does not
  teleport again. After a teleport, `touchBlock` uses the old `cx, cy` (the source portal cell).
- The speed can exceed 16 after rotation (up to 22.72). The next tick's drag caps it.

### 4.19 Jump (937-990). Only `if (!isDead)`.
```
mod = 1; injump = false;
if (spacejustdown) { lastJump = -Date.now(); injump = true; mod = -1; }
if (spacedown || (!isme && !isControlled && hasLevitation)) {
  if (hasLevitation) { isThrusting = true; applyThrust(); }           // _currentThrust = 0.2
  else if (lastJump < 0) { if (Date.now() + lastJump > 750) injump = true; }    // REAL TIME, see below
  else                  { if (Date.now() - lastJump > 150) injump = true; }
} else isThrusting = false;
if (((speedX == 0 && morx && mox) || (speedY == 0 && mory && moy)) && grounded || current == 461) jumpCount = 0;
if (jumpCount == 0 && !grounded) jumpCount = 1;
if (injump && !hasLevitation) {
  if (jumpCount < maxJumps && morx && mox) {
    if (maxJumps < 1000) jumpCount += 1;
    this.speedX = -morx * 26 * jumpMultiplier;      // setter: _speedX = (((-morx) * 26) * jm) / 7.752
    lastJump = Date.now() * mod;
  }
  if (jumpCount < maxJumps && mory && moy) {        // re-checked after the X jump
    if (maxJumps < 1000) jumpCount += 1;
    this.speedY = -mory * 26 * jumpMultiplier;
    lastJump = Date.now() * mod;
  }
}
touchBlock(cx, cy, isgodmod);    // 7.1
sendMovement(cx, cy);            // no physics
```
- A jump needs gravity on that axis from both `current` (int `morx/mory`, so there is no jump in liquids, dots,
  climbables or boosts) and `delayed` (`mox/moy`, after the gravity multiplier; a world gravity of 0 means no
  jumps).
- `jumpCount` goes back to 0 only on a tick where the player hit the floor (`grounded`), the post-move speed on
  that axis is 0, and `mox` or `moy` is non-zero. It also resets every tick that `current` is 461.
- **Replay:** `spacejustdown == spacedown == bit0`, so a held jump bit is a new jump attempt every tick and the
  Date timer is never read. The Date branch matters only in live play and while recording. A recording made in
  real time can therefore replay differently: replay ignores the 750 ms / 150 ms auto-repeat limits.

### 4.20 Levitation thrust (997-1000, 1846-1861), after touchBlock, runs even when dead
```
if (hasLevitation) {
  if (mory != 0) this.speedY -= _currentThrust * 13 * (mory * 0.5);   // _speedY = (_speedY*7.752 - (thr*13)*(mory*.5)) / 7.752
  if (morx != 0) this.speedX -= _currentThrust * 13 * (morx * 0.5);
  if (!isThrusting) { if (_currentThrust > 0) _currentThrust -= 0.01; else _currentThrust = 0; }
}
```
- The getter and setter round trip happens **every tick while `hasLevitation` is set and `mory` (or `morx`) is
  non-zero, even if the thrust is 0**, because `(v * 7.752) / 7.752` is not always `v`.
- The burn after releasing the jump bit: 0.2, 0.19, ..., about 0.01, then **-3.12e-17** (applied once as a tiny
  negative thrust), then 0.
- `isThrusting` is updated only in 4.19. It keeps a stale value while dead, or while jump is held with
  levitation off.
- The thrust is applied after movement, so it changes the next tick's speed.
- `hasLevitation = false` also sets `_currentThrust = 0` (1838-1844). In a dot, liquid or climbable
  (morx = mory = 0) there is no thrust.

### 4.21 Auto-align to the grid (1003-1042)
```
imx = _speedX << 8;          // non-zero exactly when |_speedX| >= 1 (ToInt32 truncation)
if (imx != 0 || (isLiquid(current) && !isgodmod)) moving = true;
else if (_modifierX < 0.1 && _modifierX > -0.1) {
  tx = x % 16;
  if (tx < 2)       { if (tx < .2) x >>= 0; else x -= tx/15; }
  else if (tx > 14) { if (tx > 15.8) { x >>= 0; x++; } else x += (tx - 14)/15; }
}
// same for Y with _speedY, _modifierY, y
```
- This uses `_modifierX/_modifierY` from 4.13, or from 4.18 if a portal changed them.
- |_modifier| < 0.1 means |mo + m| < 0.7752. So a held key with sm = 0.6 (speed effect 2 or zombie) still
  aligns, and so does low gravity on the gravity axis (2 * 0.15 = 0.3) when |speed| < 1. Normal gravity (2) or a
  held key (1) do not.

### 4.22 End of tick (1044, 1176-1179)
`updateStuff()` (Me.as:374-376) is the run timer only. Then `if (deadoffset > 16) { respawn(); deaths++; }`.
`deadoffset` reaches 16.200000000000017 on the **54th** tick after the kill tick, so the respawn happens at the
end of tick `killTick + 54` (section 8).

---

## 5 Collision: World.overlaps (World.as:604-751)

### 5.1 Entry
```
if (o.x < 0 || o.y < 0 || o.x > width*16-16 || o.y > height*16-16) return 1;   // outside = solid (also when flying)
if (player.isFlying) return 0;                                                  // no side effects
ox = int(x) >> 4;  oy = int(y) >> 4;
for (cy = oy; cy < (y + 16)/16; cy++)          // 1 or 2 rows:    row oy+1 only if y + 16 > oy*16 + 16
  for (cx = ox; cx < (x + 16)/16; cx++)        // 1 or 2 columns  (the double y+16 is rounded before comparing)
```
Scan order: row-major, top row first, left column first.

### 5.2 Per tile (in scan order)
```
val = realmap[0][cy][cx];
if (!isSolid(val)) { if (val == 243) lookup.setSecret(cx, cy, true); continue; }
if (!rect(x, y, 16, 16).intersects(rect(cx*16, cy*16, 16, 16))) continue;   // always true inside the scan range
rot = lookup.getInt(cx, cy);
if (isRotatableHalfBlock(val)) {          // one-ways 1001-1004,1052-1056,1092 and 1155 (all canJumpThroughFromBelow)
   ... 5.3 (continue = passable)
} else if (isHalfBlock(val)) {
   ... 5.4 (continue = no contact)
} else if (canJumpThroughFromBelow(val)) {
   ... 5.3 "up" rule, whatever the rotation
}
switch (val) { ... 5.5 doors and gates: continue = passable ...; case 50: lookup.setSecret(cx,cy,true); }
return val;                               // first blocking tile; the rest is not scanned
```
After the scan finds nothing: `if (!skipa) overlapa = -1;` and the same for b, c, d. **An early `return val` skips
these resets**, so `overlapX` keeps whatever this call already wrote.

`isSolid(id)` (ItemId.as:366-372) = not climbable and (9..97 or 122..217 or 1001..1499) and not 77 or 83.
Rectangle.intersects is `a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h`: strict, doubles.

### 5.3 One-way rules
`speedX/speedY` here are the public getters (x 7.752), but only their sign and zero-ness matter. `pl.ox/pl.oy`
are the player's pre-sub-step position (4.17), or stale values when called from elsewhere. `oy` and `ox` without
`pl.` are the local `int(y)>>4` and `int(x)>>4`.
```
up    (rot 1, and every plain canJumpThroughFromBelow tile):
  if (speedY < 0 || cy <= overlapa || (speedY == 0 && speedX == 0 && pl.oy + 15 > cy*16)) {
     if (cy != oy || overlapa == -1) overlapa = cy;  skipa = true;  continue; }
right (rot 2):
  if (speedX > 0 || (cx <= overlapb && speedX <= 0 && pl.ox < cx*16 + 16)) {
     if (cx != ox || overlapb == -1) overlapb = cx;  skipb = true;  continue; }
down  (rot 3):
  if (speedY > 0 || (cy <= overlapc && speedY <= 0 && pl.oy < cy*16 + 16)) {
     if (cy != oy || overlapc == -1) overlapc = cy;  skipc = true;  continue; }
left  (rot 0):
  if (speedX < 0 || cx <= overlapd || (speedY == 0 && speedX < 0 && pl.ox - 15 < cx*16)) {
     if (cx != ox || overlapd == -1) overlapd = cx;  skipd = true;  continue; }
```
For a rotatable one-way, only the rule matching its `rot` is tested. Any other rot value, or a failed rule,
falls through to 5.5 and blocks as a **full 16x16 tile** (one-ways have no thin hitbox). Plain jump-through
tiles (61-64, 89-91, 96, 97, 122-127, 146, 154, 158, 194, 211, 216, 1069, 1087, 1050, 1051, 1164, 1165,
1147-1149, 1160) always use the "up" rule.

### 5.4 Half blocks (rot from lookup; presents 1101-1105 use their stored rotation here, not the forced 1 of 4.2)
| rot | solid part | test |
|---|---|---|
| 1 | bottom half | intersects(cx*16, cy*16+8, 16, 8) |
| 2 | left half | intersects(cx*16, cy*16, 8, 16) |
| 3 | top half | intersects(cx*16, cy*16, 16, 8) |
| 0 | right half | intersects(cx*16+8, cy*16, 8, 16) |
| other | full tile | no test (falls through) |

### 5.5 Doors and gates (continue = passable)
| id | passable when |
|---|---|
| 23 / 24 / 25 | red / green / blue key active |
| 26 / 27 / 28 | red / green / blue key NOT active |
| 1005 / 1006 / 1007 | cyan / magenta / yellow key active |
| 1008 / 1009 / 1010 | cyan / magenta / yellow NOT active |
| 156 TIMEDOOR | `timedoorState` (= `(PlayState.ticks/100) % 10 >= 5`) |
| 157 TIMEGATE | `!timedoorState` |
| 184 DOOR_PURPLE / 185 GATE_PURPLE | `player.switches[lookup]` truthy / falsy |
| 1079 DOOR_ORANGE / 1080 GATE_ORANGE | `world.orangeSwitches[lookup]` truthy / falsy |
| 200 DOOR_GOLD / 201 GATE_GOLD | `wearsGoldSmiley` / `!wearsGoldSmiley` (the user's gold-border setting, PlayState.as:128) |
| 1094 / 1095 | `collideWithCrownDoorGate` / its negation |
| 1152 / 1153 | `collideWithSilverCrownDoorGate` / its negation |
| 43 COINDOOR | `lookup <= coins` |
| 213 BLUECOINDOOR | `lookup <= bcoins` |
| 1011 DEATH_DOOR | `lookup <= deaths` |
| 165 COINGATE | `lookup > showCoinGate` (for isme) |
| 214 BLUECOINGATE | `lookup > showBlueCoinGate` |
| 1012 DEATH_GATE | `lookup > showDeathGate` |
| 1027 TEAM_DOOR | `team == lookup` (team is normally `T0`, 4.3) |
| 1028 TEAM_GATE | `team != lookup` |
| **206 ZOMBIE_GATE** | **`!zombie`** |
| **207 ZOMBIE_DOOR** | **`zombie`** |
| 50 | never passable (reveals a secret) |

Key, orange-switch, crown and gate display values are world or PlayState state (other specs). Purple switches,
the crown flags, coins and team belong to the player.

### 5.6 Side effects of every overlaps() call
`overlapa..d` updates (5.2, 5.3) and secret reveals (243 non-solid and 50 solid). overlaps() is called by: every
sub-step (4.17), `UpdateTeamDoorsById` (4.3), the 3 coin-gate checks per PlayState.tick, `switchKey`,
`pressOrangeSwitch`, `checkCrown`, `checkSilverCrown` (PlayState.as:219-262), `pressPurpleSwitch`
(Player.as:1577) and `World.update` key expiry. All of these are part of the state evolution.

---

## 6 Per-block physics table (layer 0 id at the player's centre after 4.2 = `current`; the one 2 ticks back = `delayed`)

| ids | as `current` | as `delayed` | other |
|---|---|---|---|
| 0, non-solid decoration, 5, 6-8, 100/101/110/111, 121, 255, 360, 385, 1000, effects... (anything not listed below) | mory = 2 (rotated by flip) | moy = 2 (rotated) | |
| 1, 411 | morx = -2 (not rotated) | mox = -2 | below: x-1 |
| 2, 412 | mory = -2 | moy = -2 | below: y-1 |
| 3, 413 | morx = +2 | mox = +2 | below: 3 -> x+1, 413 -> flip default |
| 1518, 1519 | mory = +2 | moy = +2 | below: flip default |
| 4, 414 (dots) | 0, 0 | 0, 0 | immediate queue (4.5); no ice while on them; below 4 -> y+1, 414 -> flip default |
| 114/115/116/117 (boosts) | 0, 0; after drag `_speedX = -16 / +16` or `_speedY = -16 / +16` | 0, 0 | left/up stepping from an integer position (4.17) |
| climbables (4.5 list) | 0, 0; no-modifier drag on both axes | 0, 0 | immediate queue; no ice |
| 119 water | morx = mory = 0; water drag | moy = -0.5 (rotated); both input axes | no auto-align; entering puts out fire |
| 369 mud | 0; mud drag | moy = +0.4 | same as water |
| 416 lava | 0; lava drag | moy = +0.2 | entering sets fire (7.1) |
| 1585 toxic | 0; toxic drag; **kills** (not invulnerable) | moy = -0.4 | entering puts out fire |
| 368 fire, spikes 361, 1580, 1625-1636 | mory = 2 (rotated); **kills** (not invulnerable) | moy = 2 | spike rotation is ignored |
| solid ids (5.2) | collision; as `current` (possible inside half blocks, one-ways, open doors): default gravity | default | |
| half blocks | 4.2 adjustment, 5.4 | | |
| one-ways | 5.3 | | |
| 1064 ice | solid | | `current_below == 1064` means slippery = 2 |
| 242, 381 portals | teleport (4.18) | | |
| 374 world portal, 466 reset point | nothing in a TAS (need the Y key) | | |
| 461 multi-jump effect | `jumpCount = 0` every tick while `current` | | |
| 243 | non-solid, revealed by overlaps | | |
| 77, 83, 1520 music | non-solid, sound only | | |

---

## 7 Effects

### 7.1 touchBlock (Me.as:74-358), called in 4.19 with the (adjusted) tick-start `cx, cy` and `current`
1. Always, every tick: gold and blue coins (`current` 100/101 become 110/111, coins++). 466 reset point:
   `if (isgodmode || (!risky && isme) || resetSend) break;` so it is inert without the Y key.
2. Only if `pastx != cx || pasty != cy` (a newly entered cell):
   - music sounds only.
   - if `!isgodmode`:
     | id | effect |
     |---|---|
     | 5 crown | `if (!hascrown) { removeCrown(); hascrown = true; checkCrown(true) }` |
     | 113 / 467 | purple / orange switch toggle (queued if the player overlaps) |
     | 1619 / 1620 | reset purple / orange (id 1000 = all) |
     | 360 | checkpoint = (cx, cy) |
     | 121 | `if (!hascrownsilver && !resetSend) { hascrownsilver = true; completed = true; checkSilverCrown(true) }` |
     | 1516 god block | enables the G key only |
     | 6, 7, 8, 408, 409, 410 | `switchKey(color, true)` (the key starts at PlayState.ticks) |
     | 417 jump | `n = getInt; if (jumpBoost != n) jumpBoost = n` |
     | 418 fly | `b = getBoolean; if (hasLevitation != b) hasLevitation = b` (false also zeroes `_currentThrust`) |
     | 419 run | `speedBoost = getInt` (if different) |
     | 453 low gravity | `low_gravity = getBoolean` (if different) |
     | 421 curse | `c = getInt > 0; if (cursed == c \|\| isInvulnerable) break; cursed = c; setEffect(curse, c, 0, getInt)` |
     | 422 zombie | the same with zombie |
     | 1584 poison | the same with poison |
     | 1573 NPC_ZOMBIE | `if (zombie \|\| isInvulnerable) break; zombie = true; setEffect(zombie, true)`: no duration, never kills |
     | 420 protection | `b = getBoolean; if (isInvulnerable == b) break; isInvulnerable = b; if (b) { cursed = zombie = poison = isOnFire = false (and their timers) }` |
     | 1618 reset | `resetEffects(false)`: jumpBoost 0, levitation off (thrust 0), speedBoost 0, protection off, low gravity off, maxJumps 1, flipGravity 0; the timed effects stay |
     | 423 team | `UpdateTeamDoors(cx, cy)` so `team = getInt` unless overlapping (4.3) |
     | 416 lava | `if (isOnFire \|\| isInvulnerable) break; isOnFire = true; setEffect(fire, true, 0, 2)` |
     | 119, 369, 1585 | `if (isOnFire) isOnFire = false` |
     | 461 multi-jump | `n = getInt; if (n != maxJumps) maxJumps = n` (1000 = infinite, 0 = no jumps) |
     | 1517 gravity | `n = getInt; if (flipGravity != n) flipGravity = n` |
     | 241 / 337 / 397 | smiley frame only (337 CAKE uses `utilities.Random`, visual) |
   - `pastx = cx; pasty = cy` (also in god mode).

`getBoolean` is `lookup || false`, so any non-zero stored number is true. All ints come from the block's stored
argument (the level file).

### 7.2 setEffect durations (Player.as:1724-1798)
For curse, zombie, poison and fire with `duration > 0`: `start = PlayState.ticks` (the current tick, because
`arg` is 0) and `D = (d + 2*0.2) * 100` computed in doubles (`d` is the block's number, 2 for lava).
The death check (4.1) runs at the top of each later tick: `ticks - start > D`, so **the kill tick is
`start + floor(D) + 1`**. D is not always an integer. For d = 16..20 and for many d >= 256 it is just
below one (1639.9999999999998 for d = 16, 25639.999999999996 for d = 256), which kills one tick earlier than
`d*100 + 41`. For other d it is exact or just above, so always compute D in doubles. Lava: D = 240 exactly, so the
kill is at `start + 241`. Re-touching the same effect while it is active does nothing, so the timer is **not**
refreshed. Touching the effect block with number 0 turns the effect off. Respawn clears all four timed effects
(Player.as:1259-1262).

---

## 8 Death, respawn and spawn points
- Kill sources: spikes, fire, toxic (4.9, not invulnerable), timed effects (4.1). The kill tick still consumes
  its input, and its speeds are zeroed in 4.16. The player never moves while dead. Only 4.20's thrust can touch
  the speed, and 4.16 zeroes it again on the next tick.
- `respawn()` (1240-1263) at the end of tick `killTick + 54`: all four speed and modifier values are set to 0
  (through the setters, 0/7.752 = 0), `isDead = false`, `isOnFire = false`, `tilequeue = []`,
  `placeAtSpawn(true)`, and curse, zombie, fire and poison are cleared. Then `deaths++`. **Not reset:** queue,
  jumpCount, slippery, lastPortal, overlapa..d, pastx/pasty, flipGravity and the other static effects.
- `placeAtSpawn(checkpoint)` (1212-1238): the checkpoint if one is set. Otherwise `spawnPoints[id]` (id =
  `worldSpawn`, 0 in a normal level), where `spawnPoints[0]` = all 255 blocks **plus** all 1582 blocks with
  number 0, **in level-file record order** (World.as:240-397, 359-366), not map order. The index
  `nextSpawnPos[id]` goes 0, 1, 2, ... and wraps. Every placeAtSpawn without a checkpoint advances it,
  including level load, `/reset` and each death without a checkpoint. `/resetall` sets it back to 0.
  With no spawn point at all the player goes to (16, 16).

---

## 9 Input: .eetas bytes (tas/TASInput.as:21-34, Me.as:30-67)
- The .eetas file is read raw (UI2.as:2259-2271). Each PlayState.tick reads one byte with `readByte()`
  (signed) when bytes remain. There is **no stripping and no clamping**: `m = byte - 48`, then
  `jump = m & 1, left = (m>>1)&1, right = (m>>2)&1, up = (m>>3)&1, down = (m>>4)&1`.
  This is equivalent to **`mask = (unsignedByte + 16) & 31`**. '0'..'O' map to 0..31, 'P' maps to 0, LF (10)
  maps to 26 (left+up+down), CR (13) to 29 (jump+right+up+down), and a UTF-8 BOM gives 3 ticks. A newline left
  in a hand-combined file is a real input tick.
- `leftdown = left ? -1 : 0; rightdown = right ? 1 : 0; updown = up ? -1 : 0; downdown = down ? 1 : 0;
  spacejustdown = jump; spacedown = spacejustdown;` then `horizontal = leftdown + rightdown`,
  `vertical = updown + downdown` (left+right = 0).
- The byte is consumed even while dead (4.8 zeroes it afterwards).
- Recording writes `jump = spacejustdown || spacedown` (Me.as:55-57), so a held key records as jump on every tick.

---

## 10 Initial state
**Fresh level load** (PlayState constructor, Player constructor): queue `[0,0]`, speeds and modifiers 0,
`lastPortal` non-null, `ox = oy = 0`, `pastx = pasty = 0`, `overlapa..d = -1`, `jumpCount = 0`, `maxJumps = 1`,
`slippery = 0`, no effects, `team = 0`, at spawn index 0 (`nextSpawnPos` becomes 1). `PlayState.ticks = 0`.

**The TAS workflow runs `/reset`** (UI2.as:1701-1705 = `resetPlayer()`, `PlayState.ticks = 0`, ticks off), then
`/playtas`, which does **not** reset anything (2207-2228). `resetPlayer()` (1265-1297) resets the crowns, deaths,
coins, all effects, the checkpoint, purple switches, `team = 0`, secrets, and respawns (the next spawn index!).
It does **not** reset the player's queue, jumpCount, slippery, lastPortal, overlapa..d, pastx/pasty, ox/oy,
isThrusting or lastJump. It does not reset world state either: active keys and their `keysTimer` (a key touched
at tick 2000 before `/reset` stays active until PlayState.ticks reaches 2500 after it), orange switches,
`nextSpawnPos`, or blink and animation lookups. A bit-exact start needs a fresh load plus one `/reset`, with
nothing touched in between, or these values carried over. For multi-spawn levels the start spawn is index 1 (in
file order) after load plus one `/reset`.

---

## 11 Not deterministic per tick (real time or random)
| what | where | effect |
|---|---|---|
| **Portal exit choice** when more than one portal has id == target | Player.as:1046-1049, 1099; the candidate order is the AVM2 `for..in` order of `portalLookup` (Lookup.as:155-171) | `Math.random`, not reproducible, even between eeo-tas replays. A route through such a portal is a gamble with probability 1/n per outcome. |
| PlayState.enterFrame queues (orange switch, crown and silver-crown re-checks, key re-sets) | PlayState.as:498-507, BlGame | Run once per rendered **frame**, not per tick. Usually after every tick at replay speed 1; delayed when a frame runs 2+ ticks (lag, or `/playtas N` with N > 1.2). |
| Held-jump auto-repeat (750 / 150 ms) | Player.as:941-961, 980, 988 | `Date`. Never used in replay (spacejustdown == spacedown). Live and recorded play differ from replay. |
| `lastJump` initial, `last_respawn`, `SynchronizedObject.last` | Date | only the above / tagging |
| Keyboard during replay | PlayState tick, UI2 | G (god mode), Y (reset points, world portals), mouse clicks (block editing, the middle-click `return`), `/` commands. Anything the user does during a replay changes it. |
| Visual only | death animation, particles, ice/water animation, cake frame | Math.random, no physics effect |

Everything else in movement, including the timed effects, keys and time doors in eeo-tas, is a pure function of
the tick count and the inputs.

---

## 12 Audit of tools/tas/eesim.js (`_playerTick` and helpers)
Checked line by line against sections 1-10. **Matching (no change needed):** the gravity queue incl. dots and
climbables, the half-block current adjustment, current_below including the duplicate-case quirk, the gravity
tables (int morx/mory), the flip rotation, the input axis choice, speed and gravity multipliers (without zombie),
the modifier `(mo+m)/7.752`, ice decay, both drag trees and the order of multiplications, cap and snap, boosts,
the dead freeze, the step arithmetic (reminders not restored on collision, retries after `done`, the
left-from-integer shortcut, the boost zero step), grounded, the portal teleport arithmetic (getter and setter
round trip, currentS/reminder rotation, one teleport per tick), jump rules and jumpCount, auto-align
(`|speed| >= 1` equals `imx != 0`), `overlaps()` bounds, scan, one-way rules, half blocks and every door except
the ones below, touchBlock for coins, crown, switches, checkpoint, trophy, keys, jump, run, low gravity,
multi-jump, gravity and lava. The fire timing is equivalent (both kill at +241 ticks). Deaths respawn after 54
ticks.

Gaps (most severe first):

1. **[high] Zombie gate/door inverted.** AS3 World.as:734-735: 206 ZOMBIE_GATE is passable when **not** zombie,
   207 ZOMBIE_DOOR is passable when zombie. eesim.js:1369-1370 (and ee_sim.gd:1158-1159) return
   `206 -> false` (blocks) and `207 -> true` (open) for a non-zombie player: exactly reversed.
   Fix: `case 206: return !zombie; case 207: return zombie;`.
2. **[high] Levitation (418) missing.** Needs the 418 touch toggle, `applyThrust` on the jump bit, no normal jumps
   while levitating, `updateThrust` after touchBlock with the x7.752 round trip every tick (also dead and at
   thrust 0), the burn-off including the -3.1e-17 step, stale `isThrusting`, EFFECT_RESET clearing it, and
   `_currentThrust`/`isThrusting`/`hasLevitation` in snapshot/restore/stateKey. It is used by 7 of the 30 sample
   levels.
3. **[high] Zombie effect missing (422 and NPC 1573).** Needs `sm *= .6` (eesim.js:769-773), `jm *= .75` in the
   order jumpBoost, zombie, slippery (eesim.js:1609-1615), zombie doors, the timed death (7.2; the NPC has no
   timer), protection blocking and clearing it, and respawn clearing it. Gloomy Castle has 71 zombie blocks.
4. **[high] Curse (421) and poison (1584) missing:** the timed death at `start + floor((d+0.4)*100) + 1`,
   touch rules 7.1 (no refresh, number 0 turns it off, ignored while invulnerable), and cleared by protection and
   respawn. Forgotten Helix and Panicore have curses.
5. **[high] Time doors 156/157 (world area, changes collision).** eeo-tas: `timedoorState =
   (PlayState.ticks/100) % 10 >= 5` every tick (World.as:147), an absolute phase with a 1000-tick period that
   restarts at `/reset`. eesim.js:626-630 uses ee-offline's `World.offset` toggle, which drifts by one tick per
   period and starts from a different phase.
6. **[high] Key duration (world area).** eeo-tas: `keysTimer = PlayState.ticks`, expiring when
   `(ticks - timer)/100 >= 5`, so exactly 500 ticks (World.as:117-123, 149-153). eesim.js:631-635 and
   1528-1533 use the offset clock (500 or 501). The queued re-set logic (`fromqueue`) also compares ticks.
7. **[medium] Protection (420)** must also clear curse, zombie and poison with their timers (Me.as:300-315).
   eesim.js:1465-1472 clears only fire.
8. **[medium] EFFECT_RESET (1618)** must also turn off levitation (and zero the thrust) (Player.as:1817-1821,
   1838-1844). eesim.js:1473-1476.
9. **[medium] Team state (423 and 4.3).** eesim.js:1367-1368 hardcodes team 0. To be exact: store `team`, apply
   423 in touchBlock (with the overlaps revert), and at the start of every `_playerTick` (after cx/cy/current,
   before current_below) set `team = lookup(0,0)` unless the box then overlaps. Call overlaps with its side
   effects. This matters for the overlaps calls between ticks and for blocked reverts. Team blocks are in 10 of
   the 30 levels.
10. **[medium] Gold smiley.** 200/201 depend on the user's gold-border setting (PlayState.as:128). eesim.js:1355-1356
    assumes off. Make it a sim option.
11. **[medium] Spawn order and set.** eeo-tas uses the level-file record order of 255 **and** id-0 1582 blocks
    (World.as:359-366). eesim.js:229 scans 255 only, in map order (prepareLevel).
12. **[medium] Start spawn index.** Level load uses spawn 0 and `/reset` advances to the next (8, 10).
    `reset()` (eesim.js:510) uses index 0. Add a "spawn index at TAS start" parameter (default 1 mod count).
13. **[medium] .eetas decoding.** eeo-tas uses raw bytes, `mask = (byte + 16) & 31`, with no stripping or
    clamping (9). `parseEetas` (eesim.js:350-362) strips whitespace, clamps to 0..31 and iterates UTF-16
    characters. Inner or trailing newlines, a BOM or chars >= 'P' decode differently.
14. **[medium] Portal RNG.** eeo-tas uses `Math.random`, which cannot be reproduced. eesim.js:1133-1154 defaults
    to Godot PCG32 (seed 0x5EED), a model of Godot, not eeo-tas. For eeo-tas, make the `rngScript` mode (or a
    "forbid or branch on multi-exit portals" mode) the default, and flag every teleport with n > 1 in results.
15. **[low] Respawn order.** eeo-tas respawns at the end of Player.tick (Player.as:1176-1179), **before**
    PlayState.enterFrame's queues. eesim.js:639-663 runs the queues first and then respawns, so the queued
    overlaps checks see the death position instead of the spawn.
16. **[low] enterFrame queues are per frame in eeo-tas** (11). eesim.js processes them after every tick (correct
    when a frame has at most one tick). Document it; it cannot be fixed.
17. **[low] World gravity 0.** eesim.js:305 maps `gravity <= 0` to 1. eeo-tas uses 0 (no gravity, no jumps).
    All 35 samples have gravity 1.
18. **[low] Initial ox/oy.** `reset()` sets `_ox/_oy` to the spawn (eesim.js:511). A fresh eeo-tas load has
    0,0, and after `/reset` the last pre-reset sub-step values. Only the one-way rules read these before the first
    moving tick. Also document that `/reset` keeps queue, slippery, jumpCount, lastPortal, overlapa..d, pastx/pasty
    and world keys/orange switches (10).
19. **[low] Raw-input jump mode.** `_spacejustdown = jump_pressed || (jump && !prev)` plus the fake-clock timer
    (eesim.js:717, 996-1002) has no counterpart in eeo-tas replay, where `spacejustdown == spacedown == bit0`.
    Only `applyMask` input is valid for eeo-tas.
20. **[info] Drag constants.** eesim.js:27-34 hardcodes the right bits (V8 `Math.pow` would be wrong for 7 of 8).
    WATER, MUD, LAVA, ICE and ICE_NO_MOD are still unverified against eeo-tas (2).
21. **[info] World portal 374, reset point 466, god block 1516** are inert without keyboard keys. Omitting
    them is correct for .eetas replays.
22. **[info] State coverage.** Every new field (team, zombie/curse/poison flags and timers, levitation fields,
    spawn index, gold-smiley option) must go into snapshot/restore/stateKey/stateHash. Absolute tick timers
    (effects, keys, time doors) make states tick-dependent, so key them as "ticks remaining" like the existing
    key timers.

---

## 13 Derived numbers (for tests)
- Acceleration per tick: gravity `2/7.752 = 0.2579979360165119`; key `1/7.752 = 0.12899896800825594`;
  key at x1.5 `0.19349845201238391`; key at x0.6 `0.07739938080495357`; low gravity `0.3/7.752 = 0.03869969040247678`.
- Jump start speed (internal): `-52/7.752 = -6.707946336429309`; jumpBoost 1: `(-52*1.3)/7.752 = -8.720330237358102`;
  0.75: `-5.030959752321982`. Combined multipliers: 1.3*.88 = 1.1440000000000001, 1.3*.75 = 0.9750000000000001,
  .75*.75 = 0.5625, .75*.88 = 0.66.
- Terminal fall speed (default gravity, base drag only): about 13.553 px/tick. Max run (holding a key while
  gravity is down): about 6.7766 px/tick; with the speed effect: about 10.165. Boost: exactly 16.
- Releasing the horizontal key while gravity is vertical: `v *= base; v *= no_mod` each tick (about x0.8876).
- deadoffset: 0.3 accumulated 54 times = 16.200000000000017 > 16 (53 times = 15.9).
