# EE movement as mathematics (n4-math)

The EE MATH program (2026-09-30): Everybody Edits Offline's movement written as exact mathematics the compiler can
EVALUATE instead of search. Every statement here is about IEEE doubles as the engine computes them (AS3 `Number`; never
a rounded state), and every one is checked against `src/eesim.js` (the exact port of eeo-tas, itself proven exact on
the benchmark levels) by an engine test before anything uses it. Sections: 1 the per-tick recurrences (derive /
recurrences: `src/plan/kin.js`, `test/kin.js`); the other derive / build parts add theirs below.

Notation: `fl(e)` = the double the engine gets for the expression `e` evaluated in the engine's order (every `+ - * /`
rounded to nearest, ties to even); `a ⊕ b = fl(a + b)`, `a ⊗ b = fl(a * b)`, `a ⊘ b = fl(a / b)`. Positions and speeds
are px and px/tick (the engine's internal units; AS3's public `speedX` is 7.752 x these). A tile is 16 px; the ball's
box is the 16 x 16 square with top-left `(x, y)`; `y` points down.

## 1 The per-tick recurrences

`src/plan/kin.js` is Player.tick (eeo-tas Player.as:381-1180, as `src/eesim.js _playerTick` ports it) as pure functions
of doubles: no engine object, every operation in the engine's order, `-0` kept where the engine keeps it. `tick(st, mask,
W)` composes them into the whole tick of a state `st` in a world `W` (tiles, lookup ints, doors, portal exits, spawns).
Section 1.11 is the proof that kin = the engine; 1.12 lists what kin leaves to the world.

### 1.1 One tick, in the engine's order

For a state `s` and an input `u = (h, v, j)` (the `.eetas` mask: `h = right - left`, `v = down - up` in {-1, 0, 1}, `j`
the jump bit; in a replay every tick with the jump bit is a fresh press):

1. the clock `t ⊕ 1`; PlayState's three gate `overlaps()` at the box (their only effect on movement: the one-way memory);
   World.update: the time doors' state `(t mod 1000) >= 500`.
2. the dead offset (`+0.3` a dead tick, else 0); the timed kills (curse, zombie, fire, poison: `t - start > D`).
3. the centre cell `c = ((trunc(x + 8)) >> 4, (trunc(y + 8)) >> 4)`; a half block there shifts it (rot 1 and presents:
   up one, rot 0: left one); `cur` = the tile there; `del` = the gravity queue's tile two ticks back (`q0`; in a dot or
   a climbable `cur` itself enters twice, so `del` = last tick's tile and next tick's `del` = this one); `below` = the
   tile one cell in the pull's direction (`belowDir`, with EE's duplicate-case quirk).
4. input (zeroed while dead), the pulls (1.3), a kill from `cur` (spikes, fire, toxic; not protected).
5. the axes and multipliers: `mx, my` (1.3), `sm` (speed effect x1.5 / x0.6, zombie x0.6), `gm` (low gravity x0.15,
   then the level's float32 gravity as a double); `mox ⊗= gm`, `moy ⊗= gm`; the modifiers
   `ax = (mox ⊕ mx·sm) ⊘ 7.752`, `ay = (moy ⊕ my·sm) ⊘ 7.752`.
6. the ice timer (1.4).
7. **the speed recurrences** `vx ← Vx(vx)`, `vy ← Vy(vy)` (1.4); then a boost tile (114-117) sets its axis to `±16`;
   dead: both 0.
8. the move (1.5): if `vx ≠ 0 or vy ≠ 0`: the portal (1.8, once), then the sub-stepped 16 x 16 box, x then y each
   iteration, each step tested by World.overlaps; a blocked step restores that axis, zeroes its speed and may set
   `grounded` (a blocked step toward `cur`'s pull).
9. if alive: the jump (1.6), then Me.touchBlock (effects, checkpoint; coins, keys, switches, ... are the world's).
10. levitation's thrust (1.6), also while dead.
11. the auto-align of each axis (1.7).
12. the respawn when the dead offset passes 16 (the 54th tick after the kill: `0.3 x 54 = 16.200000000000017`).

The recurrences of steps 7, 8 and 11 are per axis; steps 3-6 compute their coefficients from the tiles and effects;
steps 8 (collisions, the portal) and 9 (the jump) are where the axes meet (1.9).

### 1.2 Constants (Config.as; exact bits)

| name | value | note |
|---|---|---|
| `M` (physics_variable_multiplyer) | 7.752 | every acceleration and jump goes through `/ M` (the public setter) |
| `B` base drag | 0.9813195279915707 (`6accf435f866ef3f`) | `pow(.9981, 10) * 1.00016093` with MSVC's pow (V8's `Math.pow` differs in the last bits for 7 of 8) |
| `N` no-modifier drag = toxic drag | 0.9045276172161355 (`1db5c8e6e3f1ec3f`) | `B ⊗ N` ≈ 0.88763 a tick, as two roundings |
| water / mud / lava drag | 0.9512631926190679 / 0.776454555582322 / 0.817204298414359 | after `B` |
| ice no-mod / ice drag | 0.9931818159222694 / 0.9981624074698556 | |
| `G = 2 ⊘ M` | 0.2579979360165119 | gravity's pull a tick (gm = 1) |
| `A = 1 ⊘ M` | 0.12899896800825594 | a direction key a tick (sm = 1); `G = 2A` exactly |
| key at sm 1.5 / 0.6 | 0.19349845201238391 / 0.07739938080495357 | `(1 ⊗ sm) ⊘ M` |
| low-gravity pull | 0.03869969040247678 | `((2 ⊗ 0.15) ⊗ 1) ⊘ M` |
| liquid pulls (delayed tile) | water -0.06449948400412797, mud 0.05159958720330238, lava 0.02579979360165119, toxic -0.05159958720330238 | `buoyancy ⊘ M`; their int `mory` is 0: no jumps, no floor in liquids |
| jump `J = ((0 - mory) x 26 x jm) ⊘ M` | -6.707946336429309 (jm 1), -8.720330237358102 (1.3), -5.030959752321982 (0.75), -5.902992776057792 (ice 0.88) | jm = 1, x1.3 / x0.75 (jump effect), x0.75 zombie, x0.88 on ice, in that order |
| cap / snap | 16 / 1e-4 | `s > 16 → 16`, `s < -16 → -16`, `|s| < 1e-4 → +0` |
| boost | ±16 | set after the drag |
| portal factor | 1.42 | speeds and modifiers through the getter / setter: `((v ⊗ M) ⊗ 1.42) ⊘ M` |
| thrust | 0.2 on the jump bit, -0.01 a tick after | `vy ← ((vy ⊗ M) ⊖ ((thr ⊗ 13) ⊗ (mory ⊗ 0.5))) ⊘ M` every tick with levitation, even at thrust 0 |

### 1.3 The pulls and which inputs act (Player.as:461-715)

Per tile id (kin.js `forces`, the tables = eesim.js prepareLevel's, checked for ids 0..4095):

| tile | as `cur`: `morx, mory` (int) | as `del`: `mox, moy` (double) | rotated by flip |
|---|---|---|---|
| air and everything not below | 0, 2 | 0, 2 | yes |
| arrows 1/411, 2/412, 3/413, 1518/1519 | ∓2 or ∓2 on their axis | the same as doubles | no |
| dots 4, 414; boosts 114-117 | 0, 0 | 0, 0 | - |
| climbables (12 ids) | 0, 0 | 0, 0 | - |
| water / mud / lava / toxic | 0, 0 (int of -0.5, 0.4, 0.2, -0.4) | 0, -0.5 / 0.4 / 0.2 / -0.4 | yes |
| fire, spikes | 0, 2 and a kill | 0, 2 | yes |

flipGravity 1 / 2 / 3 rotate the pairs whose rotate flag holds (`mox' = -moy, moy' = mox` for 1, negate for 2,
`mox' = moy, moy' = -mox` for 3: `-0` appears, harmless), 4 zeroes them. Then the axes (kin.js `axes`): `del` a liquid:
`mx = h, my = v`; else `moy ≠ 0`: `mx = h, my = 0`; else `mox ≠ 0`: `mx = 0, my = v`; else both. So under a vertical pull
only left / right act and under a horizontal pull only up / down; with no pull (dots, climbables, boosts, flip 4) both.

The COEFFICIENTS of the recurrences are thus functions of `(cur, del, below, flip, effects)`, and `del` is `cur` of two
ticks ago (one in dots and climbables): **a field entered acts 2 ticks later and keeps acting 2 ticks after leaving**.

### 1.4 The speed recurrence (Player.as:725-805; kin.js `stepV`, `stepX`, `stepY`)

One axis (X shown; Y is the same with `vy, ay, my, mox`):

```
Vx(v) = v                                          if v == 0 and ax == 0 (the block is skipped)
s     = v ⊕ ax
opp   = (s < 0 and mx > 0) or (s > 0 and mx < 0)   (the NEW speed against the held key)
s     = (s ⊗ B) ⊗ N          if ((mx == 0 and moy ≠ 0) or opp) and slip <= 0,  or cur is climbable
      = (s ⊗ B) ⊗ W|U|L|T    if cur is water | mud | lava | toxic
      = on ice (slip > 0):   (mx ≠ 0 and not opp ? s ⊗ B : s ⊗ Ino), then ⊗ I if opp
      = s ⊗ B                otherwise
Vx(v) = 16 if s > 16, -16 if s < -16, +0 if |s| < 1e-4, else s
```

then a boost tile overrides (114: -16, 115: 16 on x; 116: -16, 117: 16 on y) and a dead ball's speeds are 0.
The drag rule of an axis reads the OTHER axis's pull (`moy` for x): a field property, not the other axis's state.

**The free-air forms** (cur = del = air, gravity down, gm = sm = 1, no ice): with `h` the horizontal key,

```
Vx_h(v) = (v ⊕ hA) ⊗ B              if h ≠ 0 and sign(v ⊕ hA) = sign(h)     (running / accelerating)
        = ((v ⊕ hA) ⊗ B) ⊗ N        if h = 0 (coasting) or v ⊕ hA is still against h (braking)
                                    (+ the snap; |v| <= 16)
Vy(v)   = (v ⊕ G) ⊗ B               for every input (up / down do nothing under a vertical pull; the jump bit
                                    does nothing in the air with maxJumps 1: 1.6)
```

Checked facts (test/kin_lemmas.js, on the model that 1.11 ties to the engine):
- the held run from rest converges to the double **v* = 6.776552880470027** (a fixed point, reached after 1760 ticks);
  speed effect x1.5: 10.164829320704984, x0.6: 4.065931728282007;
- **the fall is exactly twice the run**: `Vy^t(0) = 2 Vx_1^t(0)` for every t (G = 2A in doubles, both use `B` only, and
  scaling by 2 commutes with rounding); the terminal fall 13.553105760940054 (after 1760 ticks), the up arrow's its
  negation; a jump's rise is the same map from `J`;
- releasing from v* coasts to exactly +0 in 94 ticks (x0.8876 a tick, then the snap); reversing from v* reaches -v*;
- water: drift -0.9053176290607918 (up), swim 1.8106352581215837 across / 0.9053176290607918 down; mud: drift
  0.16515987972806034, swim 0.41289969932015064 / 0.5780595790482113; lava: 0.10446175820026755, 0.5223087910013383 /
  0.6267705492016059; toxic: -0.4075965445496944, 1.0189913613742367 / 0.6113948168245416 (all fixed points);
- dots: the air run (no pull: the key's axis gets `B` only while held, `B ⊗ N` released); climbables: `B ⊗ N` on both
  axes always (climb up -1.0189913613742367);
- ice (slip > 0): a held key is the air run; released `⊗ Ino` (0.99318 a tick: the slide from v* stops after 1626
  ticks); reversed `⊗ Ino ⊗ I`;
- the ice timer (kin.js `slipStep`): 2 while `below` is ice (not in a climbable or a dot), 0 over any other solid, else
  `-0.2` a tick while `> 0`: 1.8, 1.6, 1.4000000000000001, ..., 0.2000000000000003, 2.7755575615628914e-16, then
  -0.19999999999999973: **11 ticks of ice physics after leaving the ice** (and the jump x0.88 with them);
- every speed a tick sets lies in [-16, 16] (a portal's rotation alone can give 22.72 until the next tick's cap) and
  none in (0, 1e-4);
- **MONOTONICITY (the basis of sound interval bounds).** In every context (15 tile kinds x 11 effect sets, both axes,
  each key held fixed) the speed update is nondecreasing in `v` (3,096,720 consecutive pairs of sorted speeds: 0
  decreasing; it follows from rounding being monotone and the drag switch `opp` flipping only through 0). So the speeds
  reachable after t ticks under ANY inputs lie in `[L_t, U_t]` with `L_{t+1} = min_u V(L_t, u)`, `U_{t+1} = max_u
  V(U_t, u)`;
- **ORDER IN THE KEY, and its exceptions.** `V(v, -1) <= V(v, 0) <= V(v, +1)` everywhere EXCEPT (i) mud and lava, where
  a key held along the motion drags `B ⊗ mud` (0.762) / `B ⊗ lava` (0.802) but a released key `B ⊗ N` (0.888), and on
  the y axis holding AGAINST the motion drags `B ⊗ N` instead of mud's: in mud / lava above ~0.3-1.4 px/tick, releasing
  or pressing against the motion keeps MORE speed; (ii) the ice timer (slip > 0): along-key `B` (0.981) vs released
  `Ino` (0.993): above `|v| = A sm B / (Ino - B)` = 10.67 (sm 1), 6.40 (sm 0.6), 3.84 (sm 0.36) releasing keeps more
  speed (reachable by boosts, portals, arrows). Checked: 0 out of order outside these, and on ice none below the threshold;
- the reachable speed sets are nearly free: in air from rest `Vx` reaches **4,600,117 distinct doubles in 14 ticks** (of
  3^14 = 4,782,969 input sequences): a 1-D table must be indexed by the input pattern, not deduplicated by value.

### 1.5 The position update (Player.as:833-935; kin.js `moveFree`, `subSteps`, `tick`)

The engine moves the box in sub-steps: `rem = fmod(p, 1)`, `cs = v`;
- `cs > 0`: to the next integer (`p ⊕ (1 - rem)`, truncated), then 1 px steps, then the fraction `p ⊕ cs`;
- `cs < 0`: from a fractional `p` (or on a boost tile): down to the integer (`p ⊖ rem`, truncated, `rem = 1`), 1 px
  steps, then the fraction; **from an integer `p` off a boost: the whole distance in one add** (`p ⊕ v`);
x then y in each iteration, each step tested by World.overlaps (1.9), the loop running while an axis has distance
left and is not blocked.

**THEOREM T-ADD (the free move is one rounded add).** If no step is blocked, `p ≥ 16` and `|v| ≤ 16`, the sub-stepped
move ends at `fl(p + v)` exactly. Proof: `rem = p - trunc(p)` is exact (Sterbenz) and a multiple of `ulp(p) ≥ 2^-48`;
`1 - rem` is exact (a multiple of 2^-52 below 1); `v - (1 - rem)`, `v + rem` are multiples of `min(ulp v, ulp p) =
ulp v` (`|v| ≤ 16` < p's binade) no larger than `|v|`, hence exact; the integer steps are exact; so every step before the
last is exact and the last `m ⊕ c` rounds the exact `p + v` once. Engine-checked on the model (3,000,000 random and
edge cases over 13 binades, 16..131072, with the boost step: 0 differ; `p` in [0, 16), outside the proof: 0 of
3,000,000 differ).

So in free air, per axis: **`x' = align(x ⊕ Vx(vx))`, `y' = align(y ⊕ Vy(vy))`** (align: 1.7).

**Lemma T-BIN (translation).** `x ⊕ v - x` is `v` rounded to the grid `ulp(x)` (ties to even on `x`'s last bit): the
same for every `x` of one binade `[2^e, 2^(e+1))` with the same parity of `x / ulp(x)` (an integer shift keeps it) when
`x + v` stays in that binade; it can differ across binades (12% of 108,216 random offsets of one fractional start in
two binades differ). So EE motion is translation invariant only **per binade and per sub-pixel class**: a trajectory
library keys offsets by (binade of x, binade of y) as well as by the start's fractional parts. Example: a standing jump
from y 512 peaks 63.42039730461818 px up, from y 2048 63.420397304618064 px (21 ticks either way).

**The collision loop** (exact; kin.js `tick`): per iteration `(ox, oy) = (x, y)`, the x step, `if overlaps(x, y)`:
`x = ox`, `vx = 0`, `grounded` if `vx` was toward `morx`'s pull, `cs_x` back to the step's start, x done; then the y
step with the (maybe restored) x, the same with `mory`. Consequences the recurrence must keep:
- a landing ends at the last free sub-step: an integer (the floor top minus 16: `y = 16k - 16` exactly) unless the very
  first (fractional) step is blocked; on the ground the fixed point is `(y = 16k - 16, vy = 0)` with `grounded` every
  tick (the tick's `G ⊗ B` step is blocked);
- after a blocked step `rem` is NOT restored (it keeps 0 or 1), and the blocked axis's step is retried every later
  iteration while the other axis moves (sliding round a corner: the retried x can succeed after a y step; its speed stays
  0);
- the path is a staircase: 1 px x, 1 px y, ... so a diagonal pass by a corner depends on the order (x first);
- one-ways read the SIGNS of the current speeds (zeroed at a blocked step) and the sub-step's start (`ox, oy`), with a
  memory per side (`overlapa..d`) that every overlaps() call updates (including PlayState's three calls at the tick's
  start): kin keeps it (`st.oa..od`).

### 1.6 Jump, hop, multijump, levitation (Player.as:937-1000; kin.js `jumpSpeed`, `jumpMult`, `thrustStep`)

After the move, if alive: in a replay `spacejustdown = spacedown = j`, so the jump attempt is exactly the bit (the Date
timers never read). `jc ← 0` if (`vx == 0` and `morx ≠ 0` and `mox ≠ 0`, or `vy == 0` and `mory ≠ 0` and `moy ≠ 0`) and
`grounded`, or `cur` is the multijump block 461; then `jc ← 1` if `jc == 0` and not grounded; then with the bit and no
levitation: if `jc < maxJumps` and `morx, mox ≠ 0`: `vx ← J` (x jump, `jc + 1` unless maxJumps ≥ 1000), then the same
test for y. So:
- **the jump fires on a tick whose move hit the floor** (grounded), including the landing tick itself: the hop (54% of
  real landings, the moves study) is the jump bit on the landing tick;
- the jump speed replaces `vy` AFTER the move: it moves the ball from the next tick on (and the tick's align sees it);
- it needs the pull on that axis from both `cur` (int) and `del` (double): no jumps in liquids, dots, climbables, boosts,
  nor for 2 ticks after entering one; a world gravity of 0 means no jumps;
- the standing jump (gm 1, from an integer y): peak after 21 ticks, 63.42039730461818 px (from y 512), back to its
  height after 45 ticks; x1.3: 26 ticks, 101.08 px, back after 57; x0.75: 16 ticks, 37.42 px, back after 35;
- multijump (maxJumps > 1): in the air `jc = 1` after the first airborne tick, so `maxJumps - 1` air jumps; 1000 or
  more: unlimited;
- levitation: the bit sets the thrust to 0.2; every tick `vy ← ((vy ⊗ M) ⊖ ((thr ⊗ 13) ⊗ (mory ⊗ 0.5))) ⊘ M` (x too
  with `morx`), even at thrust 0 (the round trip itself rounds), then `-0.01` a tick without the bit (0.19, 0.18,
  0.16999999999999998, ..., 0.009999999999999969, -3.122502256758253e-17, then 0).

### 1.7 The auto-align (Player.as:1003-1042; kin.js `align`)

Per axis, after the move, the jump and the thrust: nothing if `|v| ≥ 1` or `cur` is a liquid; else if `|a| < 0.1` (the
tick's modifier): `t = p mod 16`; `t < 0.2`: `trunc(p)`; `t < 2`: `p ⊖ t ⊘ 15`; `t > 15.8`: `trunc(p) + 1`;
`t > 14`: `p ⊕ (t - 14) ⊘ 15`. `|a| < 0.1` means no key held (or a key at x0.6: 0.0774), or low gravity's pull on its
axis (0.0387); normal gravity (0.258) never aligns its axis. The align commutes with 16 px shifts inside a binade (checked).
It is the ONLY place where the absolute position mod 16 enters the free-air recurrence.

### 1.8 Portals (Player.as:1051-1174; kin.js `portalTurn`, `tick`)

Once a tick, before the sub-steps and only if a speed is nonzero after the speed update (a ball whose speeds are both 0
then, e.g. at rest in a dot field, does not teleport; one standing under gravity does: its `G ⊗ B` step runs): at
the tick-start cell, if it is an active portal (242 / 381, target ≠ id) and the last-portal flag is clear: the flag is
set, an exit is drawn (Math.random in EEO: the world's `W.exit`), the rotation difference `d = old - new (+4)` turns the
speeds, the modifiers and the remaining sub-step distances (`d = 1: (vx, vy) → (1.42 vy, -1.42 vx)`, 2: `-1.42 (vx, vy)`,
3: `(-1.42 vy, 1.42 vx)`, each through `⊗ M ⊗ 1.42 ⊘ M`; 0: unchanged, no factor), the position becomes the exit
cell's corner (an integer) while the old sub-pixel remainders stay. The flag clears only on a tick that moves with the
tick-start cell not an active portal (so a chain of portal cells, or the exit portal, does not teleport again).

### 1.9 Where x and y meet

The per-axis recurrences above are independent except through:
1. **collisions**: `overlaps(x, y)` tests the box at both coordinates, so a blocked step of one axis depends on the
   other; the staircase order (x first) decides corner passes;
2. **the centre cell**: `cur`, `del`, `below` come from both coordinates, and they set both axes' coefficients (pulls,
   drag, boosts, kills, ice);
3. **the jump**: fires from the floor contact of the pull's axis (`grounded`), sets that axis's speed;
4. **portals**: rotate `(vx, vy)` together;
5. the drag rule of each axis reads the other axis's PULL (`moy` for x) - a field constant, not the other axis's state.
In free air of one field (no contact, the same `cur`/`del` class, no portal) the two axes evolve independently:
checked on the model (200,000 random pairs: `x', vx'` depend on `(x, vx, h)` only), and it is the engine's behaviour by
1.11.

### 1.10 Death and respawn

A kill (spikes / fire / toxic as `cur`, unprotected; the timed effects at `t - start > D` with `D = (n + 0.4) x 100`
in doubles, lava's fire `D = 240`) sets `dead`: from then input is 0, both speeds 0 after the drag, no jump, no touch;
the respawn at the end of the 54th dead tick puts the ball at the checkpoint (or the next spawn of the level's
rotation), speeds and modifiers 0, curse / zombie / poison / fire off.

### 1.11 The proof: kin = eesim.js (test/kin.js)

`node test/kin.js [--only=A..F] [--quick] ...` compares kin with the engine field by field (41 fields: position, speeds,
modifiers, the gravity queue, the ice timer, the current tile, jump count, every effect and its timer, levitation, the
one-way memory and the sub-step start, the last-portal flag, the checkpoint and spawn index, the clock, dead offset,
deaths, grounded) with `Object.is` (bit for bit, `-0 ≠ +0`):

| part | what | result (0 = no field of any tick differs) |
|---|---|---|
| A | constants (bits), the flag and gravity tables of ids 0..4095 | equal |
| B | one tick from constructed states in an open field: every context (24 current-tile kinds x 5 delayed kinds x 17 effect sets: speed / jump effects, zombie, low gravity, flip 1-4, protection, ice timers, levitation, multijump, dead; world gravity 1 and float32 0.3) x all 32 masks x every reachable speed (the 1-D closures of kin's maps from rest: x in air to depth 14 = 4,600,117 speeds, y in air from rest and every jump, x / y in water, mud, lava, dots, climbables to depth 11 (~170-265 k each), x on ice to depth 12 (511,109); edge doubles: 0, -0, ±1e-4 and neighbours, ±16, subnormals, 22.72; 20,000 random doubles): **7,154,295 speeds** | box 3: **457,874,880 one-tick checks, 0 differ** (laptop, depth 8: 2,968,672) |
| B2 | the same in contact: on a floor / at a left or right wall / under a ceiling / in a corner of every contact kind (brick, ice, a plain and rotated one-ways, half blocks of rotation 0-3, a present, time doors, the secret block 50), touching or a fraction away, in air / dots / water / arrows / climbables / boosts | box 3: **228,937,440 contact ticks** (75,997,676 with a blocked step, 12,969,456 grounded, 2,436,384 jumps), 0 differ |
| C | free runs: random levels of every block kind kin models (solids, 19 half blocks x rot 0-4, presents, plain and rotated one-ways, 4 liquids, ice, climbables, dots, arrows, boosts, fire / spikes, 13 effects with their numbers, time doors, checkpoints, several spawns, single-exit portal pairs and self-targets, world gravity 1 / 0 / -1 / 2 / float32), random mid-run starts, sticky random inputs (keep 0.5 / 0.85 / 0.95), **kin on its own state** | box 3: **160,000 levels x 4 starts x 200 ticks = 128,000,000 ticks** (107,398 deaths, 88,144 teleports) and **12,000 levels x 4 x 2000 ticks = 96,000,000 ticks** (46,799 deaths, 37,777 teleports): 0 differ |
| D | exhaustive input trees: every sequence of the 18 distinct inputs to depth 5 from random mid-run states of random levels | box 3: 24 starts x 2,000,718 = **48,017,232 nodes, 0 differ** |
| E | the real routes (truthset.js: the user's jobs + the benchmark runs), the world answering with the engine's own doors (as they stand during the move), tiles (coin pickups undone), portal draws: one step every tick, and **kin running free on its own state from the level start to the trophy** | **218 routes, 2,013,028 ticks (1861 teleports), 0 differ, both ways** (laptop and box 3) |
| F | the lemmas of 1.4-1.9 on the model (tied to the engine by A-E) | hold |

### 1.12 What kin leaves to the world (the exceptions, each modelled or stated)

kin models every movement rule of Player.tick. The WORLD's side is an interface (`W`), so a planner can plug in a
level's static geometry (`makeWorld`) or the engine's live state (test/kin_routes.js):
- `W.doorOpen(id, cx, cy, st)`: keys, switches, coins, deaths, team, time doors, crowns, zombie doors are world state
  (`makeWorld`: shut; the tests: time doors by kin's own clock, the routes: the engine's door state during the move);
- `W.coin`, `W.touch`: coins, keys, switches, crowns, the trophy, team: touches that change the world, not the physics;
- `W.exit(P, st)`: a random portal's exit (EEO's Math.random; `makeWorld` picks `o.pick` or the first);
- `W.spawn(st)`: the spawn rotation without a checkpoint.
Not modelled (never met in the 2.01 M real ticks, and each outside a replay's movement): an out-of-range music block
(the engine aborts the rest of the tick: eeo-tas throws),
the one-way memory side effects of the world's own overlaps() calls (a team retry, a purple-switch retry, a key expiry,
PlayState's per-frame queues) and PlayState's coin-gate display dance between its three tick-start calls (kin makes
the three calls with one door answer).

### 1.13 Box 3 at full size

`~/math_rec_res` (28 processes, 2026-09-30 01:00-01:15 EDT): B `--depth=14 --cap=5e6 --sdepth=11 --scap=2e6` x 8
shards (8 x 57.2 M checks), C `--runs=20000 --ticks=200` x 8 and `--runs=3000 --ticks=2000` x 4, D `--tree=5
--starts=4` x 6, E + F x 2 (`EEAT_TRUTH_ROOT` = `~/n4plan_primitives/truth`), then B2 x 8 (`--depth=14 --sdepth=11`). In all: **960,842,580 engine ticks compared field by field
(B 457,874,880 + B2 228,937,440 + C 224,000,000 + D 48,017,232 + E 2,013,028), 0 differences**. God mode (the G key, never in
a replay; kin has its paths): `--god=1` on C, 1,200,000 ticks on the laptop, 0 differ. Rerun: `src/out/math/run_box.sh` (the worktree's scratch).

### 1.14 API (src/plan/kin.js)

```js
const K = require('./src/plan/kin.js');
// the context of a tick, then one axis's speed update (stepX / stepY also set S.modX / S.modY)
const S = K.surface({ cur, del, below, flip, slip, sb, zombie, lowGravity, worldGravity, god, dead });
const vx1 = K.stepX(vx, h, S);          // h in {-1, 0, 1}
const vy1 = K.stepY(vy, v, S);          // v in {-1 up, 0, 1 down}
const x1 = K.align(K.moveFree(x, vx1, false), vx1, S.modX, S.liquidCur);   // free air: moveFree = x ⊕ vx1 (T-ADD)
K.stepV(v, mod, m, moOther, slip, cur, god)   // the bare recurrence
K.jumpSpeed(mor, K.jumpMult(jb, zombie, god, slip)), K.thrustStep(v, thr, mor), K.portalTurn(dir, vx, vy)
K.subSteps(p, v, boost)                 // the sub-step positions (for swept-box tests)
K.overlaps(st, W, x, y)                 // World.overlaps with the one-way memory
// the whole tick (the engine's Player.tick) in a world
const W = K.makeWorld(L, { doorOpen, pick });   // L = eesim prepareLevel / eelvl loadEelvlLevel
const st = K.fromSim(sim);              // or K.newState({...})
K.tick(st, mask, W);                    // st.px, st.py, st.vx, st.vy, st.grounded, ... = the engine's next state
```
