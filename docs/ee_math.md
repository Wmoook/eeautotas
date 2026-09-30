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
- dots (no pull, both keys act): held along the motion the air run; RELEASED only `⊗ B` (the no-modifier drag needs a
  pull on the other axis: a ball coasts 590 ticks from v* to 0 in a dot field, 94 in air); against the motion
  `⊗ B ⊗ N`; climbables: `B ⊗ N` on both axes always (climb up -1.0189913613742367);
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

## 2 Separability and coupling

Derive / separability: `src/math/axis.js`, `src/math/regime.js`, `tools/math/sepcheck.js` (+ `sepsum.js`),
`test/mathsep.js`. It makes 1.9 ("where x and y meet") exact: which ticks are products, the proofs, the complete list of
couplings with their frequency on the real routes, and a classifier that says, tick by tick, which regime a path is in.
The per-axis maps of `axis.js` are section 1's recurrences restated per axis with a 1D obstacle (checked on their own
against the engine; `kin.js` is the full-tick model).

**The result in one paragraph.** One EE tick is a map T on (x, vx, y, vy, D) (D: the discrete state) driven by the
input (h, v, j) (horizontal -1/0/1, vertical -1/0/1, the jump bit). T factorizes EXACTLY, bit for bit, into an x map
and a y map, `T = X_E x Y_E`, for a fixed ENVIRONMENT E, and the two axes meet in only four ways: (1) E itself (a
function of the TILE the box's centre is in, the tile of 2 ticks before, the tile below, and the effects), (2)
collisions whose answer for one axis depends on where the other axis is in the tick (corners, a ledge's edge), (3)
teleports (the portal rotation mixes the velocities), (4) the one-way rules (they read both speeds). On the 218 known
routes (2,013,028 ticks) 97.46% of the ticks are exact products (the per-axis model = the engine on every one of them),
a further 1.13% are triangular (one axis independent and exact, the other driven by its sub-steps) and 0.10% are mutual
corners; inside a uniform environment every pair (x input pattern, y input pattern) of the tested families composes
(976 M engine runs, 29.3 G ticks, 0 differences): the engine's run of the pair is (x of the one, y of the other). This
is what makes a leg a lookup: an x table and a y table, intersected.

### 2.1 The environment E and the per-axis maps

For one alive, non-god tick, eesim.js `_playerTick` computes, before any speed or position is touched (1044-1163):

| E component | from | lines |
|---|---|---|
| `cx, cy` | `(x + 8) >> 4, (y + 8) >> 4`, then the half-block rule (a half block moves the current tile up / left) | 1044-1056 |
| `current` c, `delayed` d | the tile at (cx, cy); the gravity queue's tile of 2 ticks ago (1 for dots / climbables) | 1047-1072 |
| `morx, mory` (int) / `mox, moy` (double) | the gravity tables of c / of d, rotated by flipGravity, mo x gm (low gravity, world gravity) | 1105-1151 |
| `mx, my` | which input acts on which axis (d liquid: both; moy != 0: h only; mox != 0: v only; else both), x sm | 1135-1146 |
| `slip` | the ice timer after this tick's update, from the tile BELOW the centre | 1158-1161 |
| `jm, maxJumps, lev, thrust` | jump multiplier (jump effect, zombie, slip), multijump, levitation | 2149-2156 |
| the door states | the tick's own: PlayState's gate snapshots and World.update (time doors, key expiry) run before Player.tick | 959-990 |

Nothing in E reads a speed, and E reads the position only through the TILE `(cx, cy)` (plus the tile below it).
Given E the two axes run these maps (`src/math/axis.js`, the engine's operations in the engine's order):

```
X_E(x, vx; h):
  vx1 = dragAxis(vx, (mox + mx)/MULT, mx, moy, E)     # 1164-1188: the drag tree reads mx, moy (a constant of E), slip, class(c)
  vx1 = boost override if c is a left / right boost    # 1216-1227
  (x2, hit) = moveAxis(x, vx1, boostCur, Bx)           # the sub-steps of 1285-1352 restricted to x; Bx the 1D obstacle
  vx2 = hit ? 0 : vx1
  [x-gravity only (morx != 0): jump / jumpCount / levitation thrust]   # 1361-1424
  x3 = alignAxis(x2, vx2, modX, liquid(c))             # 1426-1443: reads x mod 16
Y_E(y, vy, jc, thr; v, j): the same with (my, mox), then (for mory != 0) jumpCount, the jump, the thrust   # 1190-1214, 1382-1424, 1444-1459
```

`jumpCount` and the levitation thrust belong to the axis of the CURRENT tile's gravity (mor != 0): the reset needs
`grounded` (a blocked step toward mor, 1315 / 1346) and that axis's speed; the jump needs mor and mo on the same axis
(so a transition tick, current and delayed pulling along different axes, has no jump and no reset). The drag condition
`(mx == 0 && moy != 0)` reads the OTHER axis's gravity, but moy is a constant of E, not a state variable.

### 2.2 Theorem 1: the tick factorizes

**Theorem 1.** Let a tick be alive, not in god mode, with no teleport, no one-way tile under a probed box, the box not
overlapping a blocking tile at its start, and no door change pending at its start (a purple-switch retry, a team change
that changes the team, a key expiring, a coin / death gate snapshot changing). Let Bx(p) = blocked(p, y0) and
By(p) = blocked(x0, p) be the 1D obstacles with the other axis FROZEN at its tick-start coordinate. If the engine's
lockstep loop ends each axis where its own 1D map with that obstacle ends it, the tick is exactly
`(x', vx') = X_E(x, vx; h)` and `(y', vy', jc', thr') = Y_E(y, vy, jc, thr; v, j)`.

*Proof.* Every statement of the tick reads, besides E: its own axis's variables (drag 1164-1214: `speed_x`,
`modifier_x`, `mx`; the sub-step arithmetic of stepx 1291-1311 reads only `px, remx, csx`; the retry after a blocked
step restores `px = ox, csx = osx` and leaves `remx` as the failing step set it); the collision probe `_ovAt(px, py)`
(1312, 1343), the only statement that reads both coordinates; the jump / thrust statements (1382-1424) only the mor
axis; the align (1428, 1444) only its axis. With the probes answered as the frozen maps answer them, each axis is its
1D map. A blocked axis's retries repeat its failing step (obstacles, tiles, half blocks and the world's edge, sit on whole
pixels, so the first step from a fractional position, to the whole pixel, never fails from a free box: the failing step
starts at a whole pixel, with `rem` 0 (moving +) or 1 (moving -), the value a retry starts from) and fail again while
the frozen obstacle is the answer. Qed. The hypotheses are decided exactly by `src/math/regime.js classifyTick`: it
replays the lockstep loop with a side-effect-free `blockedAt` and compares each axis with its frozen map.

*Engine check (the 218 known routes, 2,013,028 ticks, box 3):* 1,961,850 ticks (97.46%) satisfy the hypotheses, and on
EVERY one of them the per-axis model (axis.js + regime.js) equals the engine after the tick in px, py, speed_x,
speed_y, jump_count, the thrust, isThrusting and grounded: **0 differences**. The 18-mask form (the definition of
separability, straight from the engine): from the state before every 5th separable tick of every route (392,279
states), all 18 masks (h in {-, L, R}, v in {-, U, D}, jump in {0, 1}); among the masks whose tick satisfies the
hypotheses (7,047,012 (state, mask) ticks), the engine's x after the tick is identical for equal x-driving input
(1,131,397 groups) and its y for equal y-driving input (882,037 groups): **0 violations**.

### 2.3 Theorem 2: the axes meet only through E (and three tick couplings)

**Theorem 2.** In a run of ticks satisfying Theorem 1, x(t) is a function of (x0, vx0, h(0..t-1), E(0..t-1)) and y(t)
of (y0, vy0, jc0, thr0, v, j, E). E(t) is a function of the centre tile (cx, cy)(t), the tile below it, and the
effect parameters; the gravity queue delays the pull by 2 ticks (1 in dots / climbables).

So the joint motion is a HYBRID system: per-axis continuous maps selected by a discrete mode (E, the contact set), the
mode switching when the centre crosses a tile edge into another physics class. In a region whose tiles all have one
physics class (open air, a dot field, an arrow field, water, ...) E is constant and the axes are independent. There are
no diagonal forces: every gravity table entry pulls along one axis (gMox / gMoy: one is 0), flipGravity rotates by 90
degrees, and a boost sets one axis. "Diagonal arrows" = an arrow field entered diagonally = two mode switches (the
centre crosses a row edge and a column edge on different ticks, or on the same tick).

The only per-tick couplings (the complement of Theorem 1), with their share of the known routes' ticks:

| coupling | what reads both axes | route ticks | frozen-map model still exact |
|---|---|---|---|
| TRIANGULAR y <- x | y's collision probed after x's sub-step (a walk-off, a landing on a ledge's edge) | 0.69% | x: always (Th. 5) |
| TRIANGULAR x <- y | x's blocked step retried after y moved (a slide past a wall's end) | 0.44% | y: always |
| MUTUAL corner | both | 0.10% | never (0 of 2,065) |
| ONE-WAY | the rules read speedX when speedY == 0, the overlap memory, ox / oy (1708-1748) | 0.95% | 81% |
| PORTAL | x' from vy and y' from vx, x 1.42, the remainders swapped (1495-1551) | 0.10% | 6% |
| DOOR change at the tick's start | team retry, purple-switch retry, key expiry, gate snapshot | 0.04% | 95% |
| DEAD / killed | both speeds 0 (a product of constant maps); the respawn teleports | 0.17% | 98% |
| EFFECT touched | touchBlock changes the parameters (the next ticks' E; levitation's thrust in this tick) | 0.06% | 96% |

Not tick couplings but mode switches: the environment changed (current / delayed class, slip, parameters) on 6.27% of
the ticks; ice memory (slip > 0: the ice drags on BOTH axes, the timer set by the tile below the centre) 0.15%.

### 2.4 Theorem 3: cross products in uniform environments (the trajectory library's premise)

Which input drives which axis (from 1135-1139, 1382-1424; the other inputs are ignored):

| environment | x driven by | y driven by | ignored |
|---|---|---|---|
| vertical gravity (air, up / down arrows, flip 0 / 2, low gravity, multijump, levitation, speed / jump effects) | h | jump bit (the jump; with levitation the thrust) | v |
| horizontal gravity (left / right arrows, flip 1 / 3) | jump bit | v | h |
| no gravity (dots, climbables, water, mud, lava, toxic, boosts, flip 4) | h | v | jump (mor = 0: no jump) |

**Theorem 3.** In a uniform environment with no collision, for any x-input sequence a and y-input sequence b, the
engine's run of the combined input is (x of a's run, y of b's run), whatever the ignored bits do.

*Engine check (`sepcheck.js free`, box 3):* 26 environments (open air; multijump 2 and infinite; jump effect; speed
effects 1.5x and 0.6x; low gravity; levitation; gravity flipped up / left / right / off; up, down, left, right arrows;
dots and invisible dots; a climbable; water; mud; lava and toxic (protected); left and down boosts; spikes (protected)),
3 random start states each (random sub-pixel positions, speeds from rest to the boost's 16), T = 30 ticks, ALL input
sequences with at most 2 changes on each side (x: 5,049 sequences of {-, L, R}; y: 872 of {0, jump} or 5,049 of {-, U,
D}), every pair played by the engine with the ignored bits randomized per tick: see 2.9 (**0 differences**).

### 2.5 Theorem 4: translation invariance of the per-axis offsets, and its two exceptions

A trajectory library stores offsets dx(t) = x(t) - x0. **Speeds never depend on the position** (the drag tree reads no
position), so vx(t) is the same wherever the ball is. Positions:

**Theorem 4.** For the free x map and an integer n, the offsets from x0 and from x0 + n are bit-identical for every
input sequence if (a) x(t) and x(t) + n lie in the same binade [2^k, 2^(k+1)) at every tick, and (b) n = 0 mod 16 or
the auto-align never fires (it fires only with |vx| < 1 and |modX| < 0.1: no key held under vertical gravity, a ball
nearly at rest; under gravity it never fires on the gravity axis unless the gravity multiplier is < 0.3876).

*Proof.* `fmod1(x)` (x - trunc(x)) and `1 - rem` are exact, `x |= 0` is exact, so the whole-pixel steps are exact
translations; the fractional part of x has the resolution ulp(x) = 2^(k-52), so the same binade gives the same `rem` bits
and the same `cs - (1 - rem)`; the one rounding, the final `x += cs`, rounds at ulp(x'), equal in the same binade (and
an integer shift keeps the parity of x / ulp(x), so ties round alike: section 1.5's T-ADD / T-BIN say the same: the free
move is the one add fl(x + v)). The align reads `fmod16(x)` (exact) and rounds `x -= t/15` at ulp(x). Qed.

*Engine check (`sepcheck.js trans`):* where (a) and (b) hold: 100% identical offsets (11.7 M trajectory pairs, see
2.9); where the binade changes: the offsets differ in 57-98% of the pairs, by at most 7.5e-11 px (the rounding at the
coarser ulp: a table must not be used across a binade edge without recomputing; the edges are x = 256, 512, 1024, 2048,
4096 px = tile columns 16, 32, 64, 128, 256, and the same rows for y); where the align fires and n != 0 mod 16: 73% of
the pairs differ, by up to 6.1 px (the grid pull).

So a 1D table row is exact for a start (fraction of x0, binade of the path, and x0 mod 16 when the align can fire, i.e.
no key and |v| < 1 at some tick); integer translations inside the binade are free.

### 2.6 Theorem 5: contacts, and the triangular structure

A flat obstacle (a floor under every column the box covers during the tick, a wall over every row) is answered the
same at every position of the other axis: the tick is a product whose y (or x) map is the 1D CONTACT map (the last free
sub-step position, speed 0, grounded toward gravity). EE has no ground friction of its own: running on a floor is the
air recurrence of x, with y pinned.

**Theorem 5 (triangular ticks).** If x's probes are answered by Bx (x independent) but y's are not, x' = X_E(x, vx; h)
exactly and y' is the lockstep loop's with x given: y is DRIVEN by x's sub-step schedule (the walk-off: the floor ends
under the box after x's first step; the landing on a ledge's edge). Symmetrically for y independent.

*Engine checks:* on the routes the independent axis of every triangular tick equals its frozen 1D map (see 2.9: 0
differences). `sepcheck.js ground`: a floor across the whole level, a start standing on it, every (h pattern, jump
pattern) pair with <= 2 changes over 30 ticks (5,049 x 872 = 4,402,728 runs, 132 M ticks per start, 4 starts): **x =
x(h), y = y(jump) in every run** (0 differences). The same floor with a 4-tile pit: y differs from y(jump) in up to 25% of
the runs (the walk-off: y depends on x), and once the ball is IN the pit its walls block x at some heights only (x
depends on y): x differs too (up to 22%); a slow start that never reaches the far wall: x = x(h) in every run, only y
depends (the triangular case).

### 2.7 The regime of a path, tick by tick (the API)

`src/math/regime.js`:

- `classifyTick(sim, mask)` -> `{code, env, sep, model}`: the tick sim would play (sim unchanged). `code` bits:
  couplings `C_CORNER` (mutual), `C_TRIXY` (y depends on x), `C_TRIYX` (x depends on y), `C_ONEWAY`, `C_PORTAL`,
  `C_STUCK`, `C_DOORQ`, `C_DEAD`, `C_EFFECT`, `C_GOD` (`C_COUPLED` = any); modes `C_XHITP / C_XHITN / C_YHITP /
  C_YHITN` (blocked moving + / -), `C_GROUND`, `C_JUMP`; grid / memory `C_ALIGNX / C_ALIGNY` (the map depends on the
  position mod 16), `C_HALFCUR` (the half-block rule moved the centre tile), `C_ICEMEM` (slip > 0), `C_NEAR` (nothing
  collided but the swept rectangle held a non-air tile: a staircase past a corner). `sep` = no coupling bit (Theorem 1:
  the tick is the product). `model` = the per-axis prediction of the state after the tick.
- `pathRegimes(level, masks, {check})` -> `{codes, cur, del, stats}`: a run replayed, every tick classified (plus
  `C_ENVCHG` when E differs from the tick before, `C_MISS` when check finds the model wrong); `cur` / `del` the physics
  class of the current / delayed tile (`PC_NAMES`: air, arrowL/U/R/D, dot, climb, water, mud, lava, toxic, boostL/R/U/D,
  kill, portal, effect, solid).
- `certifyFree(level, xs, ys, {cls})` -> -1 or the first tick that may leave the free product regime: for a HYPOTHETICAL
  path (an x table row next to a y table row placed at a start), every tick's swept box on plain-air tiles in the world
  and the centre tile of the class `cls` (default air; not over ice). -1 = Theorem 3 applies: the engine will play
  exactly (xs, ys); the move solver then replays it once (the check the task asks for).
- `envSchedule(level, xs, ys, q0, q1)` -> per tick of a HYPOTHETICAL path the current / delayed tile ids and physics
  classes, the tile below, the centre tile (the half-block rule, the gravity queue from the start's `sim._q0, _q1`): the
  mode schedule a candidate leg meets, from its positions alone (= the engine's on every tick of test/mathsep.js's run).
- `drivers(level, env)` -> `{xH, xJ, yV, yJ, jumpX, jumpY}`: which input acts on which axis in that environment.
- `blockedAt(sim, x, y)`: overlaps() != 0 without side effects (2: only a one-way rule decides); `physClass(level, id)`;
  `envKey`.

`src/math/axis.js`: `envOf(sim, mask)` (E), `dragAxis`, `moveAxis(p, s, boostCur, blocked)`, `alignAxis`,
`alignFires`, `gravityTail`, `fmod1`, `fmod16`.

### 2.8 What this means for the compiler

- 70.2% of the known routes' ticks lie in FREE-UNIFORM runs (a product, both axes free, no mode switch, no align, no
  ice): 131,494 runs, 47,007 of them 10+ ticks and 13,647 of 30+; separable constant-environment runs (contacts allowed)
  average 15.5 ticks (118,914 runs, 42,491 of 10+, 17,255 of 30+). Inside them a leg is a 1D-table lookup per axis and
  an intersection.
- Contacts are products too: on a floor x is the air recurrence and y the contact map (13.2% of route ticks: y blocked,
  x free; 5.8%: x blocked, y free); the walk-off tick is triangular (compute x first, y from x's schedule); only 0.10%
  of ticks are mutual corners.
- Legs (support to support, cut at the grounded ticks; 39,998 legs on the routes, mean 44.3 ticks): the INTERIOR of 53.4%
  of the legs is a single-environment product (the library applies as is), 16.7% more are products with environment
  switches (piecewise lookups, the switches at tile edges), 20.1% hold a triangular tick (x first, y from x's
  sub-steps, or the reverse) and 9.8% a hard coupling (a mutual corner, a one-way, a portal, a death, an effect). The
  take-off tick is a product in 93.6% of the legs, the landing tick in 86.0% (triangular 9.5%: a landing on a ledge's
  edge).
- Mode switches (6.27% of ticks) happen at tile edges: the regime schedule of a candidate path is known from its
  positions alone (the centre tile each tick, 2 ticks of queue lag), so a path can be split at them and each piece looked
  up in its field's tables.
- Exactness: tables keyed by (sub-pixel fraction, binade, and mod 16 where the align can fire) are exact under integer
  translation (Theorem 4); a binade edge or an align at another phase changes the low bits: verify by one replay.

### 2.9 The numbers (box 3, 2026-09-30; `node tools/math/sepsum.js <out>.json` prints them)

**The known routes** (`sepcheck.js routes --m18=5`, `EEAT_TRUTH_ROOT` = the truth set: 111 jobs + 108 benchmark runs, 218
replay, 1 stale; 5.2 s on 28 threads): 2,013,028 ticks.

| regime | ticks | share | per-axis model vs engine |
|---|---|---|---|
| product (Theorem 1) | 1,961,850 | 97.46% | exact on all (0 differences) |
| - both axes free | 1,575,248 | 78.25% | |
| - y blocked (floor / ceiling), x free | 265,836 | 13.21% | |
| - x blocked (wall), y free | 116,285 | 5.78% | |
| - both blocked (flat, consistent) | 4,481 | 0.22% | |
| triangular (Theorem 5) | 22,779 | 1.13% | the independent axis exact on all |
| mutual corner | 2,065 | 0.10% | never exact |
| one-way under a box | 19,077 | 0.95% | 81% exact (the flag is conservative) |
| portal | 1,922 | 0.10% | 6% |
| dead / killed | 3,355 | 0.17% | 98% (frozen) |
| effect touched | 1,272 | 0.06% | 96% |
| door change pending | 829 | 0.04% | 95% |
| (mode switch: E changed) | 126,253 | 6.27% | (not a coupling of the tick) |
| (auto-align fired x / y) | 44,361 / 29,955 | 2.20% / 1.49% | (in the model) |
| (a staircase past a corner, nothing hit) | 33,353 | 1.66% | (in the model) |
| (ice memory) | 2,951 | 0.15% | (in the model) |

By the centre tile's class (share of its ticks that are products / free products): air 1,399,206 (97.90% / 78.05%),
up arrows 157,023 (98.63 / 82.70), dots 126,545 (98.46 / 74.73), right arrows 124,157 (98.74 / 83.29), left arrows
113,393 (98.73 / 86.26), inside a passable solid (open door, one-way, half block) 24,598 (71.64 / 46.29), water 16,897
(99.37 / 86.02), effect tiles 15,898 (89.77 / 69.80), climbables 14,303 (97.29 / 76.55), portals 7,941 (75.27 / 36.23),
killers 5,666 (41.44 / 29.12), down arrows 2,345, mud 1,544 (100.00), boosts 2,757, lava 755.

18-mask check: 392,279 states, 7,047,012 separable (state, mask) ticks, 1,131,397 x groups / 882,037 y groups, 0
violations.

certifyFree on single ticks of the routes that are free products in one field class (current = delayed, nothing hit, no
switch): it accepts 1,415,138 of 1,424,452 (99.35%): air 1,025,791 / 1,033,366, up arrows 108,396 / 108,727, right
arrows 86,937 / 87,094, dots 85,585 / 85,764, left arrows 81,144 / 81,998, water 13,622 / 13,759, climbables 10,115 /
10,196, down arrows, mud, lava, boosts all (the refusals: a non-air tile in the swept rectangle that the staircase went
around). Portal, effect, killer and trigger tiles are never certified (they change the state).

Legs (`legStats`: support to support at the grounded ticks): 39,998 legs, 1,773,647 ticks, 27,448 of 10+ ticks and 18,848
of 30+. Interior: pure 21,366 legs (53.42%; 20.80% of the leg ticks), switch 6,681 (16.70%; 24.77%), triangular 8,052
(20.13%; 27.93%), coupled 3,899 (9.75%; 26.50%). Take-off ticks product / triangular / coupled 37,425 / 1,389 / 1,184;
landing ticks 34,400 / 3,796 / 1,802.

**Cross products in uniform environments** (`sepcheck.js free --T=30 --k=2 --per=3`, 590 s on 28 threads): 26
environments x 3 starts, every x sequence x every y sequence with <= 2 changes over 30 ticks: 976,102,974 engine runs,
29,283,089,220 ticks: **0 x differences, 0 y differences**, no run near the world's edge.

| environments | x family x y family | runs per start |
|---|---|---|
| vertical gravity (air and its effects, up / down arrows, gravity up, spikes) | 5,049 (h) x 872 (jump) | 4,402,728 |
| horizontal gravity (left / right arrows, gravity left / right) | 872 (jump) x 5,049 (v) | 4,402,728 |
| no gravity (dots, climbable, 4 liquids, boosts, gravity off) | 5,049 (h) x 5,049 (v) | 25,492,401 |

**Translation** (`sepcheck.js trans --T=60 --per=24`, 31 s; shifts n in {1, 5, 8, 13, 16, 32, 256, 300} from bases in the
binades 2^8 .. 2^12, all h / jump sequences with <= 2 changes over 60 ticks; runs that come within 40 px of the world's
edge left out):

| axis | n mod 16 | binade | align armed | pairs | identical offsets | max difference |
|---|---|---|---|---|---|---|
| x | 0 | same | yes / no | 3,735,985 / 1,444,586 | 100% / 100% | 0 |
| x | != 0 | same | no | 2,892,276 | 100% | 0 |
| x | != 0 | same | yes | 7,533,879 | 27.1% | 6.06 px |
| x | any | differs | no | 2,967,642 | 12.4% | 1.2e-11 px |
| x | 0 | differs | yes | 2,538,842 | 1.9% | 7.5e-11 px |
| x | != 0 | differs | yes | 2,924,166 | 5.3% | 4.89 px |
| y (gravity) | any | same | (never) | 2,057,054 | 100% | 0 |
| y (gravity) | any | differs | (never) | 1,883,850 | 35.0% | 1.1e-11 px |
| y (low gravity) | 0 / != 0 | same | yes | 262,782 / 561,751 | 100% / 27.5% | 0 / 2.22 px |
| y (low gravity) | any | same | no | 1,324,131 | 100% | 0 |

**Contacts** (`sepcheck.js ground --T=30 --per=4`, 47 s): a floor under the whole level, 4 starts on it, 5,049 x 872
pairs each (4,402,728 runs, 132 M ticks per start): 0 x and 0 y differences. The floor with a 4-tile pit, 4 starts 20-60
px before it: y differs from y(jump) in 18,976 / 310,596 / 333,802 / 1,102,014 runs (the walk-off), x from x(h) in 0 /
495,444 / 526,554 / 976,687 (the pit's walls, reached only by the runs that fell in).

**Test** `node test/mathsep.js` (37 checks, ~2 s): the cross products of every environment at T = 7, the model exact on all
17,837 product ticks of 18,000 random-walk ticks in 30 random rooms of every block kind, each coupling class where it must appear, certifyFree, the
translation rule, envSchedule = the engine along a run.

## 3 Reach1d: 1D reachability, the exact solver and the 1D minimum time

(derive / reach1d.) Code: `src/plan/kin1d.js` (the model, the tables, the queries), `src/plan/kin_tables/` (the table
builder; the small tables in git), `test/kin1d_theorems.js` (the engine checks), `tools/math/reach1d_cover.js` (the real
routes). The per-tick recurrence is section 1 (1.4 the speed, 1.5 T-ADD the move, 1.7 the align); the separation of the
axes section 2. This section is the input axis of free air as a 1D system: what it reaches, how to find a pattern that
reaches a target without search, and its minimum time.

### 3.1 The two axes of free air

`kin1d.axisStep(v, m, mo, mO, drag, slip)` = `kin.stepV` with the drag given by its kind (checked equal, 3.4): `mod = (mo
+ m) / 7.752`; `v' = D(v + mod)` (unless v = mod = 0), D = base x no_mod when (m = 0 and mO != 0) or m opposes v + mod,
base x water / mud / lava / toxic in a liquid, the ice rule while slippery > 0, base otherwise; cap +-16; snap |v'| <
1e-4 to 0. Then `x' = x ⊕ v'` (T-ADD, x >= 16), a jump sets `v' = J = (0 - mor) 26 jm / 7.752`, and `x' = align(x')`
when ARMED: |v'| < 1, |mod| < 0.1, no liquid at the centre.

The tables' context (PLAIN free air): gravity down, the current and the delayed tile default (morx 0, mory 2, mox 0,
moy 2 gm), no liquid / climbable / dot / boost, slippery <= 0, no levitation. There x is the INPUT AXIS (m = h sm, mo =
0, mO = 2 gm: the release drag applies with no key held) and y the GRAVITY AXIS (m = 0, mo = 2 gm, mO = 0: base drag
only). With sm = gm = jm = 1: a key adds 1/7.752 = 0.12899896800825594, gravity 0.2579979360165119, J =
-6.707946336429309.

- **Speeds are position-free** (section 2): the x speeds of a free-air stretch are a function of (vx0, the horizontal
  inputs) alone, the y speeds of (vy0, the jump ticks). With max_jumps 1 the gravity axis has NO input in the air: one
  trajectory per start (vy0 = J after a jump or a hop, 0 after a walk-off or a bonk); multi-jump adds the air-jump ticks.
- **Positions**: `x_t = align(... ⊕ v_t)` from the REAL x0 (T-ADD): the offset x_t - x0 depends on x0 only through
  the roundings (at most t ulp(x)/2: 5e-11 px for x < 8192, t = 120; T-BIN) and the align (x mod 16, armed ticks only).
  So a table stores speeds exactly and the offsets nominally (from 0, align off), and `evalIA(x0, v0, code, t)` gives
  the engine's exact doubles in t additions.
- **The finite speed set** (1.4 fixed points): hold R from rest reaches V = 6.776552880470027 (hex f7eea4ad301b1b40)
  exactly at tick 1760 and stays; release from V reaches 0 in 94 ticks. Every x speed of the plain context is therefore
  a word from rest (the REST TREE: table class `rest`); the other fixed starts are +-V (`top`, `topL`).

### 3.2 THEOREM M (the extremes) and the 1D minimum time

**THEOREM M.** For every input word p of the input axis and tick t: `v_t(hold L) <= v_t(p) <= v_t(hold R)`, and with no
armed tick in p also `x_t(hold L) <= x_t(p) <= x_t(hold R)`. Proof: the speed map is non-decreasing in v for each input
(fl is monotone; the drag factor is positive and both branches give 0 at s = 0; cap and snap are monotone) and in the
input for each v (L <= none <= R: the gaps are at least a key's 0.11 px/tick after the drag, far above one rounding);
`x ⊕ v` is monotone in both; induction. The align pulls a position toward the nearest grid line (16k) and never across
it: every word ends in `[x_t(hold L) - 2, x_t(hold R) + 2]` (`ALIGN_SLACK`; measured overshoot at most 0.078 px, 3.4).

**LEMMA L (the last change is monotone).** For a fixed prefix and a final pair of runs (mi for j ticks, then mf to T),
x_T and v_T are monotone in the change tick j (one tick of mf becomes mi), exactly, when neither run can be armed (both
held keys at sm = 1). The solver binary-searches j there.

**The 1D minimum time** (a lower bound for EVERY input sequence of free air): `kin1d.minT(x0, v0, X)` = the least t with
`x_t(hold toward X) >= X`; it is attained (hold toward is a pattern), so it is exact for the axis; `minTSafe` subtracts
the 2 px align slack (admissible for every word). From rest: 6.59 / 23.69 / 49.49 / 101.33 / 165.44 / 319.12 / 494.24 px
in 10 / 20 / 30 / 45 / 60 / 90 / 120 ticks (`summary.json` holdR: every tick to 240, every start class). With the
gravity axis a single trajectory, a free-air leg's minimum time is max(minT on x, the first tick the y trajectory reaches
the target row); a leg whose found T equals it is proven optimal from that start state.

### 3.3 Patterns, tables, the solver

**Patterns.** Runs of a constant input (L, none, R); k = runs - 1 changes; a 29-bit code (`encode` / `decode` / `str`:
m0..m3 2 bits each, the change ticks c1..c3 7 bits each, <= 127). `evalIA(x0, v0, code, t[, ctx, trace])`: the exact
end state (and every tick); `evalGA(y0, vy0, t, ctx, jumps)`: the gravity axis with air jumps (`[tick, J]` entries when
J changes between them).

**The tables** (`buildTable`; `src/plan/kin_tables/build.js`; cache `kin1d.cacheDir()` = `<tmp>/eeat_kin1d/<engineKey>`
or `EEAT_KIN1D_DIR`; box 3: `/root/math_reach1d_tables/c3d70bab001b74e4/`): every pattern with <= K changes and length
<= T from a start class, per tick the rows (nominal dx, v exact, code; bit 31 = the pattern had an armed tick: its real
dx can differ by up to 2 px) sorted by dx; `lookup(tab, t, lo, hi, {x0})` binary-searches a window and evaluates each
row from the real x0. Built on box 3 in 2-4 s each:

| class | K 2, T 120 | K 3, T 48 |
|---|---|---|
| rest (v0 = 0), top (+V), topL (-V) | 3,413,280 rows, 68 MB each | 4,884,384 rows, 98 MB each |

The DP over (t, speed) does not compress: two words almost never reach the same double speed (only the snap to 0
merges), so K 3 to T 120 would be ~2e8 rows a class. The solver replaces the big tables; the tables give the classes and
the RESOLUTION (`summary.json`: per class, K and t the range, the largest gap between consecutive reachable offsets, and
the largest / median gap inside the range less 8 px at each end, where only hold R / L and their last-tick variants
live). From rest, inside the range:

| t | 20 | 40 | 48 | 60 | 120 |
|---|---|---|---|---|---|
| K 1: largest gap (px) | 0.95 | 2.31 | 3.12 | 3.53 | 5.05 |
| K 2: largest / median gap | 0.138 / 0.0127 | 0.215 / 0.0105 | 0.228 / 0.0102 | 0.286 / 0.0092 | 0.309 / 0.0067 |
| K 3: largest / median gap | 0.0187 / 0.00088 | 0.0259 / 0.00033 | 0.0361 / 0.00028 | | |

So from rest every window of width >= 0.31 px inside the reachable range (less 8 px at each end) holds an exact offset
with <= 2 changes at every t <= 120, and every window >= 0.036 px one with <= 3 changes (t <= 48); from +V the K 2 / K 3
largest interior gaps are 0.53-0.64 / 0.22 px.

**THE SOLVER** `solveIA(x0, v0, T, lo, hi, {k, vlo, vhi, tube, limit, maxNodes, ctx})`: every pattern with <= k changes
whose EXACT x_T is in [lo, hi] (and v_T in [vlo, vhi]; `tube(j, xPrev, x)` a per-tick corridor: the level's free columns
at the row the separated gravity axis is in at tick j), fewest changes first: a walk over the runs, a node cut when THEOREM
M's interval from its state (hold L / hold R, +-2 px if an armed tick is possible) misses the window, the last change by
LEMMA L's binary search. Sound (every answer is an exact evaluation) and complete on its family (the cuts are proofs;
3.4 SOLVE). A 1 px window: microseconds to a millisecond; an exact point (x, v) target with k 3 and T ~ 100: 0.2-1.5 M
nodes (0.1-1 s).

### 3.4 The engine checks (`node test/kin1d_theorems.js [--quick] [--shard=i/n] [--T2= --T3= --depth= --D2=]`)

Box 3, 12 shards, `--T2=64 --T3=32 --depth=10 --D2=14` (seeds 31-42): **643,170,947 engine checks, 0 mismatches** (the
first run had 1: a SOLVE test start 221 px from the room's border wall whose 75-tick hold L ran into it, not free air;
the test's starts moved to x0 >= 900 and that shard rerun clean). Over 396 starts (12 x0, some within 0.2 px of a grid
line; 33 v0: rest, the align edge 0.99 / 1, run speeds, the cap, random):
- S1: every word over all 32 masks of length <= 3 and over {-, L, R} of length <= 10: px, speed_x, py, speed_y after
  every tick = the model's (the jump and up / down bits do nothing in free air under gravity down: the axes separate).
- S2: every pattern with <= 2 changes up to 64 ticks and with <= 3 changes up to 32 ticks, every tick (569 M checks).
- M: in S2 x beyond hold L / hold R without an armed tick 0 times, v beyond 0; the largest align overshoot 0.018 px; M2
  (the model: every word over {-, L, R} up to 14 ticks from 1,248 starts within 3 px of a grid line): +0.078 px.
- S2r / SEP: random patterns (<= 3 changes, and any), 120 ticks, jump and up / down bits mixed in; x the same from two y
  states (one falling fast), y the same whatever the horizontal inputs.
- P: 1 M single ticks from random doubles (x0 in [48, 6600), v0, y0, vy0).
- G: the gravity axis from 0 and every jump class J(jm), jm in {1, 1.3, 0.75, 0.5625, 1.144, 0.88}, 4 y0, 120 ticks;
  multi-jump (max_jumps 2, 3, 1000), air jumps at every tick 1..40 (+ a second one).
- CTX: the generic axisStep with the engine's own context: speed x1.5, x0.6, zombie x0.6 (the held key then aligns), low
  gravity (y aligns near the apex), a level gravity 0.5 (float32), flip gravity 1 / 2 / 3.
- TAB: table rows (K 2, T 40, 4 classes) replayed from 3 real x0: v exact, evalIA exact, the nominal dx within 3e-12 px.
- KIN: axisStep = `kin.stepV` (3 M random contexts, every drag kind, ice), `x + v = kin.moveFree` (3 M pairs), align =
  `kin.align`.
- SOLVE: 600 random patterns with <= 3 changes (T <= 100) as exact point targets: all found; every answer and every
  answer of a 10 px window query (9,600) replayed by the engine where the solver says.

### 3.5 The real routes (`tools/math/reach1d_cover.js`; box 3, 28 shards, ~2 min; `--agg` prints the summary)

The truthset: 218 routes of 106 levels, 2,013,028 ticks; the moves study's 49,846 moves.

**Per tick and axis** (axisStep + the move + the jump + the align from the engine's previous state and this tick's
context): the model = the engine on EVERY tick without a collision, in every context: x plain 1,220,818 ticks (94.7%
exact, the rest collisions), arrows / flipped gravity 532,128 (88.1%), dots 3,997, climbables 383, liquids 2,327, ice
1,343; y likewise (plain 80.3%: landings and bonks collide); **0 unexplained ticks on either axis**. Not modelled here:
levitation (244,166 ticks, 12.1%: its thrust is kin.js `thrustStep`), boosts (2,757), teleports (1,815), dead (3,294).

**Free-air segments** (per move, the longest run of plain ticks with no collision on either axis, in the air, one speed /
gravity multiplier, the current tile's gravity default: an arrow there reverses the jump): 31,438 of the 49,846 moves
have one (63.1%; the rest are micro-hops that collide at once or field moves), 747,887 ticks (37.2% of all route ticks);
96.3% in the canonical context (x1, x1).
- The route's own pattern is in the family (<= 3 changes, <= 127 ticks) in 26,128 segments (83.1%, 67.7% of the ticks):
  **the table's evaluation reproduces all 26,128 exactly** (x and vx every tick, bit for bit).
- The gravity axis reproduces **all 31,438 segments exactly** (281 with air jumps).
- Own changes: k 0 49.0%, 1 13.1%, 2 13.8%, 3 7.2%, 4 4.8%, 5 3.2%, 6+ 8.9%.
- The EXACT end state (x, vx) by ANY pattern with <= k changes (the solver's point target): <= 0 49.0%, <= 1 62.1%,
  <= 2 75.9%, <= 3 83.1% (= the own-pattern share: an exact double end state fingerprints its pattern; 0.6% at the node
  budget).
- **The landing position** (the end x within +-0.5 px, any speed; the solver's window query): of the 31,222 segments of
  <= 127 ticks, 16,260 with 0 changes, 12,288 with 1, 2,674 with 2: **every one within 2 changes** (none needs 3, none
  unsolved). The routes' extra changes buy the exact speed and sub-pixel state for the next leg.
- The start speed vx0 is in the rest tree (<= 2 changes / 120 ticks or <= 3 / 48): 35.5% (vx0 = 0: 15.3%); 46.2% have a
  plain history since vx was last 0, 68% of those within 3 changes: take-off speeds carry long histories, so the solver
  takes the REAL v0 (any double) and the tables serve the canonical starts and the resolution.
- Start vy: J (a jump or a hop) 38.2%, 0 (a walk-off or a bonk) 25.4%, other (a field exit, a portal) 36.4%.

### 3.6 Exceptions and limits

- Collisions end a segment (per axis; the solver's `tube` keeps a pattern off the walls; the landing is the collision
  that ends the leg). Portals, boosts (the speed override and the zero step) and deaths are not in these tables.
- Levitation's thrust is not in `axisStep` (kin.js `thrustStep`). Ice and liquids are (drag kinds; checked on the real
  routes) but not in the tables.
- sm = 0.6 (speed effect 2, zombie): the held key is armed (|mod| < 0.1), so LEMMA L's binary search is off (the solver
  scans); the tables are sm = gm = 1 (other contexts: pass `ctx` to evalIA / solveIA).
- A jump's J reads the multipliers of its tick (a jump effect or ice between two air jumps): evalGA takes `[tick, J]`.

### 3.7 API (`src/plan/kin1d.js`)

`axisStep, align, armed, ia(ctx), ga(ctx), ctxOf(sim), stepIA, stepGA, encode, decode, str, changes, inputAt, evalIA,
evalGA, holdX, rangeIA, minT, minTSafe, solveIA, buildTable, lookup, summary, writeTable, readTable, loadTable(name,
{K, T}), cacheDir, engineKey, CLASSES {rest, top, topL}, TOP, ALIGN_SLACK`; `src/plan/kin_tables/summary.json` (per class
the resolution table and the hold R / hold L / release offsets and speeds to 240 ticks as hex doubles), `ga.json` (the
gravity axis per (gm, jm) and start class 0 / J, 240 ticks, hex doubles).

## 4 The move solver: a leg evaluated, its bound, chains

(build / solver.) Code: `src/plan/msolve.js` (the solver, the bound, the fan-out, the chains), `test/msolve.js` (the
engine checks), `tools/math/msolve_bench.js` (the 49,846 real moves as legs), `tools/math/msolve_chain.js` (chains on
the real routes). It puts sections 1-3 and 6 to work: a LEG is solved, not searched, wherever the plain regime holds,
by the gravity axis' one-parameter family (3.1) and the input axis' exact branch and bound (3.2-3.3); field legs go to
section 6's solver; what neither covers goes to a small engine family (the coupled piece). Every answer is the engine's
own replay.

### 4.1 A leg

A leg starts at a REAL engine state (an `EESnapshot`: the exact position, speeds, jump count, effects, the doors as
they stand) and asks for a TARGET: centre tiles and the support class the ball must be in there, the moves study's
letters (G on the ground: this tick's movement hit the floor; Z dots, W liquid, C climbable, B boost; `any`), or a
teleport onto an exit tile (a portal move: the solver enters one of the portals whose exits lead there, `via`, and the
goal tick must teleport). The goal test is exact on a real state (`S.goal`): the centre tile `((x + 8) >> 4, (y + 8)
>> 4)`, the class letter (the CURRENT tile's physics, read at the tick's start: a field entered at tick t reads as
that class at t + 1), alive. The answer: the input masks of the leg, its ticks T, the landing hop (the same masks with
the jump on the last tick: the same support, another state; 54% of real landings are hops), the lower bound, whether T
is PROVEN optimal, and which tier found it.

### 4.2 The plain regime: the gravity axis is a family, the landing tick a closed form

The start is PLAIN when section 2's environment is: gravity down (flip 0), no levitation, no ice timer, the current and
both queued tiles of default gravity (no field, effect, portal or killer: `plainIds`), the centre on such a tile.
Inside it (section 3.1) y has NO input in the air with max_jumps 1, so the whole y history of a leg is one of a few
MEMBERS, each a table of doubles computed once per leg from the real (y0, vy0) by the recurrence (`gravTrace`: kin1d's
axis step, the raw y before the align kept too):

| member | y(t) | x must |
|---|---|---|
| jump at tick j (a standing ball) | y0 for t <= j, then the free trajectory from (y0, J) | stand on the floor at ticks 1..j |
| walk off at tick o | y0 for t < o, then the fall from (y0, 0) | stand at 1..o-1, be off the floor at o |
| walk | y0 | stand every tick |
| launched (a hop, a fall) | the one free trajectory from (y0, vy0) | nothing |
| BONK at (b, line) (a rise member) | the member to b - 1, the ceiling line at b (vy = 0), then the fall | be under the ceiling at b |

A bonk member exists for every ceiling line (a multiple of 16) the rise crosses; its blocked y is the line (the 1 px
steps from a fractional y end there) or, from a whole y, the start itself (the move is ONE add there: blocked, y
stays: Player.as's sub-step rule, section 1.5).

**THEOREM S1 (the landing tick).** For a member and a floor row fr (the floor line l = 16 fr - 16, where a standing
ball's y is), the ball lands on that row at the one tick T = the first t after the member's air start with
y(t - 1) <= l < y_raw(t) and v(t) > 0 (y_raw: before the align, which the collision probe precedes), provided the x
path keeps the box free and puts a landable tile under it there. *Proof:* the y recurrence has no term in x (section
2, THEOREM 1) and no input (3.1); the move is one add (T-ADD) until a probe collides; descending from y(t-1) <= l the
1 px steps reach l and the next step overlaps row fr, so y stops at l, vy = 0 and grounded holds (section 1.5).
Low gravity arms the y align (|a| < 0.1): the aligned y may sit back on the line while the raw y crossed it, hence
y_raw (the engine check below found this: 12 legs where the aligned test missed the landing).

So the candidates of a leg are the (T, member, row) ITEMS, T computed in closed form from the member's table, sorted by
T: **cheapest T first**. For a field-entry target the items are the ticks at which y is in the target row's centre
range.

### 4.3 The input axis at T: the exact branch and bound

At an item's T the x axis must end in the target's WINDOW (the target columns' centre range `[16 c - 8, 16 c + 8)`,
narrowed to where a landable tile lies under the box, widened by the align slack: the landing probe sees the raw x
and the first sub-step) and pass the TUBE every tick: the 16 x 16 box at (x_t, y_t) free of solids (the level's
bitmask with the doors as they stand: one-ways pass, half blocks block), the centre on plain tiles, on the floor while
the member stands (tested at the engine's first x sub-step: the walk-off rule), off it at the walk-off tick, under the
ceiling at a bonk tick. `solveX` enumerates the x patterns with <= K changes (kin1d's runs of -, L, R; K = 2 by
default: section 3.5 found every real landing within 2 changes) as a branch and bound:

- each tick is the exact recurrence (axisStep, the one add, the align) with the member's WALLS: a box that would enter a
  solid at the member's y stops at its last free sub-step (the 1 px steps from a fractional x; from a whole x a short
  move is one add and stays), vx = 0: section 2's THEOREM 5 (a contact's independent axis) made a function of the tick;
- a node is cut when THEOREM M's interval from its state misses the window: here as THE HOLD TABLES (`holdTables`),
  the offsets of n ticks of hold R / hold L from every start speed on a 1/64 px/tick grid (n <= 160; ~2 M doubles,
  built once per (sm, gm) in ~10 ms). The speed map is monotone in v (1.4), so a speed between two grid points has its
  offset between theirs: `holdRange` is an O(1) SOUND interval (+ the 2 px align slack), and a cut is a proof;
- the last change is binary-searched (LEMMA L) where both runs are held keys, scanned otherwise;
- a per-item share of the node budget (40 k) keeps one item from eating the leg's budget (400 k).

Each emitted pattern with its member is one input string; it is replayed ONCE by the engine from the start's snapshot
(~0.6 us a tick). A miss (a corner of the sub-step staircase, a one-way, a door, a trigger) goes on to the next
pattern. The first replay that meets the goal is the answer (its first goal tick), so every answer is exact by
construction.

### 4.4 Four tiers: plain, field, coupled, chain

1. plain: 4.2-4.3.
2. field (not plain, or no plain answer; not for a teleport target): section 6's `solveLeg` (the start field's axis
   roles, the gravity axis' options, the input axes by `fields.solveAxis`, the schedule iteration across field
   boundaries), its answer replayed by this solver's goal test.
3. coupled: the per-tick one-change family over the 9 direction masks, with and without a press at the first tick, the
   prefix played once and snapshotted every tick (the moves study's F1): only where neither tier found an answer, or
   BELOW the field answer's T (the cheapest T across the tiers). Since the fields iteration (4.10): in the same pass the
   JUMP PRESS AT THE CHANGE TICK ON THE SAME DIRECTION (hold m0, press the jump at tick c, hold on: one more hold a change
   tick), for a leg that pass left unsolved the press on a change of direction, and THE SPEED-LIMIT CUT (sound) on every
   hold (`EEAT_MATH_CORDER=0`: the family before, no cut).
4. chain (a leg of 40+ ticks none of the three solved; not for a teleport target): the leg as a chain of shorter ones
   through supports (4.6) within the leg's horizon and a 400 ms clock, from a plain start and from a non-plain one (its
   successors by the event fan-out: a leg across fields = the pieces between its field events); the root's direct leg
   is skipped (it is the leg that failed).

### 4.5 THE PLAIN BOUND and its certificate

**THEOREM B.** Let the start be plain with max_jumps 1 and the target tiles T*. Every input sequence that stays in the
plain regime needs at least `lb = max(tx, ty)` ticks to put the centre on a target tile (and at least 1 for G):

- tx = min over the target columns of the least n with `hold toward from (x0, max(v0 toward, 0))` reaching the column's
  centre range less the align slack (0 when x0 is within it), the 1D minimum time of 3.2;
- ty = min over the target rows r of: 0 when y0 is within `[16 r - 8 - 2, 16 r + 8 + 2)`; below it, the first n at which
  the fall from `max(vy0, 0)` reaches `16 r - 8 - 2`; above it, the first n at which the rise of a jump pressed now (a
  standing ball: y moves from tick 2) or the current rise reaches `16 r + 8 + 2`, +1 for a landing (the rise must end
  first); past one jump's reach `ceil(dy / |J|)` (no tick rises more than |J|: stairs re-jump).

*Proof.* Per axis (the axes do not meet in the plain regime but through collisions, which only stop motion): x under
any input is at most hold toward (THEOREM M) and a wall can only zero a speed (the clamp to max(v0, 0) covers a wall
absorbing a speed away from the target: without it a ball moving away from the target, stopped by a wall, beats the
free bound); the y speed has no input but the jump, which only lowers it, and a floor or a bonk only stop it; the
align moves a coordinate by < 2 px (1.7); the centre range covers every floor height (half blocks, one-ways: the
first version tested the floor line and was beaten by a real landing on a half block). Qed for the plain regime.

**The certificate** (`certify`): the bound is claimed for EVERY input sequence only when the ball cannot leave the
plain regime before tick lb. Leaving it needs the centre on a non-plain, non-solid tile u; the first such tile a path
enters before tick lb lies in the rectangle the plain extremes reach in lb ticks (x: hold L / R from the clamped
speeds, y: lb x |J| of rise to the fall), and until it enters u the path is plain, so the first tick it can be in u is at least
max(tx(u's column), ty(u's row)) (THEOREM B's two parts for the tile, no landing tick): **THE TILE TEST** certifies lb
when every non-plain tile of the rectangle has max(tx, ty) >= lb (per column / row cached; the first version asked for
no such tile at all). **THE SPEED LIMIT**: every speed is capped at 16 px/tick after the drag (a boost sets 16), the
sub-steps move by the speed and the align by < 2 px, so without a teleport or a respawn the centre moves at most 20 px
a tick an axis; when the box the ball can reach at that limit in lb ticks holds no STRICT tile (a portal, a killer, an
effect: a summed-area table of the level's static tiles), a path that first leaves the plain regime at a field tile u
still needs max(tx, ty)(u) + ceil(the gap from u to a target tile's centre range / 20) ticks, and u leaves the bound
when that reaches lb. A timed killer running (a curse, a zombie, fire, poison) voids every certificate (its death
respawns the ball elsewhere). **A leg found at a certified lb is PROVEN OPTIMAL.**

**Proofs by the event-graph bound** (`leg(o.prove)`, the bench's default): a solved leg the plain certificate did not
prove asks section 5's admissible bound (`src/math/lb.js`: the A* over the level's collision events, its sources closed
by the bounded speed-ups and the teleports) for the same start and target (mode `land` for a landing class G: the goal's
states are grounded with the centre in the tiles; `touch` for the others) with the horizon T + 1: the leg's T equal to
that bound is PROVEN OPTIMAL too (`res.provenBy` 'plain' | 'events'); a bound above a replayed leg's T would be a
counterexample to it (`res.lbMathAbove`, counted by the bench).

*Engine checks.* (a) The 49,846 real moves (4.7): on every leg with a certified bound, lb <= the route's own ticks
(the route is a real input sequence): **0 violations** in the final runs (20,379 certified legs with the tile test and the speed limit, 19,791 with the tile test alone,
16,297 with the rectangle alone; the first run had 12 violations, which found the two errors above: the low-gravity
align and the landing height); (b) test/msolve.js: random input words (sticky, jump presses anywhere) from 3 starts on
a room with a gap, a step and a ceiling, and on the same room with three boosts (16 px/tick: faster than any plain
move) and a dot field: no word ever stands on a tile sooner than its certified bound or its proven leg (88 pairs, 26
proven; with the boosts 46 pairs, the tile test 37 certified / 7 proven, the rectangle alone 35 / 6: 0 violations); (c)
the bound's parts are section 3's checked THEOREM M / minT and the recurrence.

### 4.6 Chains: A* over support states

`chain(start, target)`: a node is an exact engine state at a support (its snapshot, the masks from the chain's start,
g = its ticks), merged by stateHash (a state reached again no sooner is dropped). Its edges are solved legs: the
direct leg to the target (plain at a plain node; the field and coupled tiers where the node is not plain) and THE
FORWARD FAN-OUT `landings(node)`: the plain solver in its EACH mode, one item per (T, member, tile) over the standable
tiles the plain extremes reach in 60 ticks (half the nearest to the target, half the nearest to the ball, 30 at most,
a 20 k node budget), the earliest verified landing on each tile, and its hop; and THE EVENT FAN-OUT (each of the 18
held masks played to its first support event: a landing, a field entered or left, a teleport; the successors of a
field node). Two numbers per node: the CLAIM fa = g + the certified plain bound (0 where none applies: admissible),
and the ORDER f = g + w x max(that bound, kappa x the reach field's cost to the target's tiles) (src/reach.js to the
target's tiles, deaths off, built once per target; kappa = 16 / 6.7766 ticks a tile, the top running speed: an order,
not a bound); the reach field's -1 in physics mode drops the node (a proof: no death-free way to the tiles); among equal
f the deepest node first. TWO PHASES (anytime): w = 2 (greedy toward the target) until the first chain or half the
clock, then the heap re-keyed with w = 1 (A*: every node whose fa reaches the best chain's T dropped), so the clock's
rest improves the chain and can close it. Lazy verification: an edge is a replayed answer, made when its node is
expanded. **Closed** = no open node's fa is below the best chain's T and every bound used was certified: no chain of
these legs is shorter (the order's weight does not enter the claim).

### 4.7 The numbers

**The real moves** (`tools/math/msolve_bench.js`, box 3, the moves study's segmentation of the truthset's 218 routes;
every move but deaths / respawns and moves over 400 ticks = 49,371 legs; the start = the route's exact state at the
move's start, the target = the route's next support (its centre tile and class letter; a teleport onto it for a
portal move), Tmax = the route's ticks + 10; every answer replayed AGAIN by a separate EESim with the moves study's own
test: **0 answers rejected**; the final code, run r10):

| class | legs | solved | <= route | < route | exact end | proven optimal | plain / field / coupled / chain (% of the class) |
|---|---:|---:|---:|---:|---:|---:|---|
| **all** | 49,371 | **92.4%** | **88.8%** | 23.4% | 20.8% | **18.9%** | 55.0 / 15.6 / 21.3 / 0.4 |
| hop | 17,073 | 99.2% | 98.3% | 0.9% | 21.4% | 34.6% | 92.8 / 4.8 / 1.6 / 0 |
| jump | 7,623 | 97.9% | 93.7% | 57.9% | 17.6% | 34.3% | 91.3 / 5.1 / 0.8 / 0.7 |
| fall | 4,572 | 94.3% | 91.8% | 15.2% | 27.1% | 14.9% | 69.8 / 17.1 / 7.3 / 0.1 |
| walk | 42 | 100% | 100% | 90.5% | 2.4% | 76.2% | 78.6 / 21.4 / 0 / 0 |
| airjump | 162 | 19.1% | 14.2% | 13.6% | 0.6% | 0 | 8.6 / 0.6 / 5.6 / 4.3 |
| arrow | 9,879 | 78.2% | 71.1% | 30.6% | 17.3% | 0.8% | 6.4 / 22.3 / 48.0 / 1.4 |
| dot | 5,317 | 89.4% | 83.2% | 41.1% | 13.4% | 0 | 0 / 43.3 / 46.0 / 0.1 |
| boost | 2,297 | 91.5% | 87.7% | 16.1% | 35.7% | 0 | 3.7 / 43.0 / 44.4 / 0.3 |
| portal | 1,723 | 94.4% | 93.2% | 15.2% | 40.9% | 0 | 23.9 / 0 / 70.5 / 0 |
| climb | 390 | 92.6% | 89.5% | 55.9% | 13.6% | 0 | 0 / 34.9 / 57.7 / 0 |
| swim | 293 | 90.4% | 87.7% | 61.4% | 12.6% | 0 | 0 / 19.5 / 71.0 / 0 |

- **solved** = an input string the engine replays onto the target support; **<= route** = in no more ticks than the
  route's own move (the TAS-optimised one), **< route** strictly fewer (at the support class: the route may have bought
  its exact state with those ticks); **exact end** = the answer's end state (or its hop's) = the route's end state
  (stateHash) at the same tick; **proven optimal** = T equals a certified plain bound (4.5) or section 5's event-graph
  bound: no input sequence reaches the target sooner.
- **9,308 legs PROVEN OPTIMAL** (18.9%): 1,951 by the certified plain bound, 7,357 by the event-graph bound; hop 5,907,
  jump 2,612, fall 681, arrow 76, walk 32; 2,265 of them strictly faster than the route's own move and 7,043 in its
  ticks (there THE ROUTE'S OWN MOVE is proven optimal too). The event-graph bound never exceeded a replayed leg's T
  (0 counterexamples); its time median 667 us, p90 3.9 ms (42,037 legs asked).
- The tiers: plain 27,171 legs (the mathematics of 4.2-4.3: one engine replay per leg at the median), field 7,693
  (section 6), coupled 10,529, chain 222 (a leg of 40+ ticks the three tiers did not solve, as a chain, 4.6, within a 400 ms clock; 22 in the first run: the chain tier from plain starts only, one phase).
- Against the first full run (r5: the chain tier from plain starts only, one phase, the rectangle certificate, no
  event-graph proofs): 205 legs solved more (most of them arrow legs), none fewer; certificates 16,297 -> 20,379 (one
  lost: a start with a timed killer running, which the first certificate let through), proven optimal 1,624 -> 9,308.
- **Microseconds per leg** (the solve; the event-graph proof apart, above): the laptop, one thread, unloaded, the first
  code (1,053 legs of 3 routes): the plain tier's legs median **80 us**, p90 1.0 ms (1 engine verify at the median, 2
  at p90), the field tier 9.2 ms, the coupled piece 28 ms; the final code (245 legs of 2 routes, every 3rd move): plain
  median 116 us, p90 1.5 ms, field 20 ms, coupled 28 ms. On box 3 (loaded: the compiler program beside it), the final
  run: plain median 250 us (p90 15 ms), field 7.1 ms, coupled 35 ms, chain 0.59 s; a failed leg median 0.54 s (the
  chain tier's clock).
- **The plain bound**: on 33,432 legs, certified on 20,379 (the tile test and the speed limit; 19,791 with the tile
  test alone, 16,297 with the rectangle alone); on every certified leg lb <= the route's own ticks (**0 violations**);
  lb / route median 0.559 (the admissible bounds of the n4 study: median 0.145; section 5's event-graph bound is
  tighter, which is why it proves the most).
- The route beaten: 11,560 legs in fewer ticks than the route's own, 105,743 ticks in all.
- Where it fails: arrow legs across fields (the ball enters and leaves arrow tiles inside the move: 22% unsolved),
  long plain legs (> 60 ticks: the most of the plain classes' failures), multi-jump (airjump 19.1% solved); the
  failures' reasons: not plain and no coupled candidate 1,677, no plain candidate 1,597, the budget 418. No field leg is
  proven (no admissible bound across fields is certified here).

**Chains** (`tools/math/msolve_chain.js`, box 3: from the route's state at every 48th move's start to the support 4
moves ahead, 5 s a chain, the route's own ticks over those 4 moves as the yardstick):

1,123 chains (every 48th move of the 218 routes; **0 answers rejected** by the independent replay):

| run | found | <= route | < route | closed | nodes expanded (median) |
|---|---:|---:|---:|---:|---:|
| the first fan-out (80 tiles, 60 k nodes), w = 1 | 41.1% | 31.9% | 25.0% | 14.8% | 37 |
| the cheap fan-out (30 tiles, 20 k nodes), w = 1 | 44.2% | 32.8% | 25.9% | 14.8% | 40 |
| the cheap fan-out, w = 2 (weighted A*) | 48.8% | 31.7% | 25.1% | 0 | 24 |
| + the reach field's order, w = 1 | 45.8% | 33.9% | 26.8% | 14.9% | 54 |
| **+ two phases (w = 2 until the first chain or half the clock, then w = 1): the default** | **52.4%** | **35.8%** | **28.3%** | **15.2%** | 57 |

- Chain by chain: the reach field's order against the run before it 21 chains found only with it, 3 only without (of
  the 493 both found, 8 shorter with it, 1 longer); the two phases against the reach order alone 74 found only with
  them, 0 only without (of the 514 both found, 2 shorter, 5 longer); the first chain after median 374 ms.
- The chains of plain moves only (hop, jump, fall, walk: 410) 80.2% found, 55.6% <= the route; the chains through
  fields, boosts or portals (713) 36.3% / 24.4%. The found ones take median 0.98 of the route's ticks.
- Closed (optimal within the graph of its legs): 171 chains (15.2%); 6 of them are longer than the route (the route
  takes a leg the graph does not hold: the closed claim is about these legs, not about every input).
- The final code (the certificate's tile test and speed limit: more bounds certified, so more closed claims) ran once more
  under twice the load (28 shards next to the compiler program: median 45 nodes expanded in the 5 s vs 57): found
  49.7%, <= route 34.8%, < route 27.6%, closed 18.6% (209 chains, 10 of them longer than the route); on the 31-chain
  laptop sample (3 s a chain) the certificate changed nothing but the claims: found 64.5% either way, closed 25.8% vs
  22.6%.
- Where they fail: the 5 s clock (the median chain spends it all: ~57 nodes, each a direct leg of up to 80 ticks and
  its fan-outs; the fan-out is ~3/4 of a chain's time), four-move stretches through fields.

### 4.8 What the solver does not cover yet

- Multi-jump in the plain regime (the air-jump tick is a second member parameter: not listed; airjump legs 18.5% solved).
- Long plain legs (> 60 ticks: the most failures of the plain classes): the K = 2 tree grows as T^2 per item and the
  budget runs out; the chain (4.6) is the way for them (supports in between).
- Arrow legs by THEOREM F2's frame map (the level, the state and the inputs rotated into the plain frame, solved by
  the plain tier, rotated back, replayed): not built; the arrow class is the solver's weakest (77.8%), and the
  arrow-class moves are mostly arrow tiles (9,377 in the census) rather than a flipped world gravity (162).
- The bound across fields (the field tier's own bound is section 6's `lb`, reported there, not certified here), so no
  field leg is claimed proven optimal.
- The standable-tile fan-out from a non-plain node: such a node gets the event fan-out and its direct leg only.
- Doors that change during a leg (the plain tier's solid map holds the doors as they stand at the leg's start state,
  `solidOf`: a door a key, a switch, a coin or the clock opens mid-leg is a wall to it; the engine replay decides),
  levitation, and effects gained mid-leg (the plain regime ends there: the field and coupled tiers).

### 4.9 API (`src/plan/msolve.js`)

`createSolver(L, {K, Tmax})` -> `S`: `S.leg(start, target, o)` -> `{ok, masks, T, hop, lb, cert, proven, tool,
member, k, cands, verifies, us, why, provenBy, lbMath, proveUs}` (o: `Tmax`, `K`, `plain` / `fields` / `coupled` (each on by default), `prove` (the event-graph proof; `createSolver(L, {prove: true})` for every leg), `nodes`,
`itemNodes`, `fieldMs`, `coupledTicks`, `chain` / `chainAny` / `chainMs` (the chain tier), `debug(item)`);
`createSolver(L, {certTiles: false})`: the certificate's rectangle alone, `{certSpeed: false}`: the tile test without the speed limit; `S.chain(start, target, o)` -> `{ok, masks,
T, closed, expanded, legs, nodes, cut, reach, firstMs, ms}` (o: `ms`, `legT`, `w` (the final weight, 1), `w1` (the
first phase's, 2), `phase1` (0.5 of the clock), `fanT`, `fanMax`, `fanNodes`, `events`, `reach`, `kappa`, `Tmax`,
`coupledDirect`, `rootLeg`); `S.landings(start, o)` -> `[{tile, T, masks, hop}]`; `S.lowerBound(start, target)`;
`S.goal(target)`; `S.replay(start, masks, target)`; `clsOf(sim, flags)`; `holdTables(ctx)`, `holdRange(H, x, v, n,
slack)`. A target: `{tiles: [tile index], cls: 'G' | 'Z' | 'W' | 'C' | 'B' | 'A' | 'any', tele, via}`. A start: an
`EESnapshot` or an `EESim`. `node test/msolve.js [--quick] [--samples=N]`;
`EEAT_TRUTH_ROOT=<root> node tools/math/msolve_bench.js --moves=<exact_jsonl> --out=<dir> --shard=i/n` then `--agg=<dir>`;
`tools/math/msolve_chain.js` likewise (`--chain=4 --every=48 --ms=5000`; `--w`, `--w1`, `--phase1`, `--fanMax`,
`--fanNodes`, `--events=0`, `--reach=0`, `--kappa`). The land-and-act members (4.11): `o.land` (default on,
`EEAT_MSOLVE_LAND=0` off), `o.landStanding` (off), `o.landRows` (6 landings a base member), `o.plainMs` (the plain
tier's clock); `EEAT_TRUTH_ROOT=<root> node tools/math/msolve_air.js --moves=<exact_jsonl> --out=<dir> --shard=i/n
[--span=2] [--cls=any] [--coupled=1] [--fields=1]` then `--agg=<dir>`; `msolve_bench.js --land=0`.

### 4.10 The field legs: the coupled piece's jump families and the speed-limit cut (the fields iteration)

**The failing class.** The r10 run's unsolved field moves (4.7): arrow 2,157, dot 565, boost 195, portal 96, climb 29,
swim 28; 1,992 of them take at most 120 ticks (the compiler's direct horizon). Their routes' inputs: the most common
short pattern is ONE direction held with ONE jump press somewhere inside the leg (the moves study's essential runs:
arrow d1 / jr1 96, d2 / jr1 74, d3 / jr1 87 of the 1,433 arrow legs), which the coupled piece could not play: its
family pressed the jump only at the leg's first tick. And in the compiler's budget (150 k engine ticks a leg) the
coupled piece's F1 family reaches only its first prefixes (a prefix costs T + 8 x T x T / 2 ticks: ~14 k at T = 60).

**The change** (`src/plan/msolve.js` solveCoupled; `EEAT_MATH_CORDER=0`: the family before, no cut):

1. THE SAME-DIRECTION JUMP PRESS: in F1's pass, per prefix (m0, p0) and change tick c, after the 8 holds m1 != m0 one
   more hold: m0 with the jump bit at tick c (hold, jump, hold on). One hold a change tick (+1/8 of the pass).
2. THE CHANGE-DIRECTION JUMP PRESS (m1 != m0, the jump bit at c): a second pass, only for a leg the first left
   unsolved (on a solved leg its holds are time without a use: the solved sample's median 38 -> 60 ms before this rule).
3. THE SPEED-LIMIT CUT (sound): without a teleport the centre moves at most SPEED_PX (20) px a tick an axis (16 +
   the align; endgame.js's D_TICK is 16.25), and a death ends the hold, so a state g px (Chebyshev) from the target
   tiles' box range needs ceil(g / 20) ticks more: a hold whose tick + that passes its limit is cut, and a prefix is cut
   from that tick on (every branch from its later states needs as much). Off with a portal in the level or a teleport
   target.
4. NOT KEPT: an order of the direction masks by their heading to the target (x toward the target first, the first-tick
   press interleaved per mask) with both press families in one pass: +409 of the 1,992 failing legs, but it lost 79
   legs of a 2,713-leg solved sample for 44 (the target's direction is not the pressed direction in a field: an arrow's
   push, a dot's drag).

**Measured** (box 3, `tools/math/msolve_bench.js --only=<list> --coupledTicks=150000 --fieldMs=120 --chain=0
--prove=0`: the executor's budgets, the r10 legs from the route's exact state, Tmax = the route's ticks + 10; every
answer replayed again by the bench's separate EESim: **0 rejected**):

| legs | the first version | the jump families + cut | in <= the route's ticks |
|---|---:|---:|---:|
| unsolved field legs <= 120 ticks (1,992) | 0 | **339 (17.0%)** | 0 -> 285 |
| of them arrow / dot / boost / portal / climb / swim | 0 / 0 / 0 / 0 / 0 / 0 | 260 / 28 / 25 / 25 / 0 / 1 | |
| solved field legs, every 6th (2,713) | 2,651 | **2,662** (only the first 6, only this 17) | 2,473 -> 2,486 |

On the legs both solve the new T is lower on 19, higher on 5 (the budget's order: the same family explored in another
order within 150 k ticks). Of the 339 legs it adds 306 hold one direction and press the jump inside the leg (family 1),
33 press it at a change of direction (family 2).

**In the compiler** (box 3, 60 s, --workers=3; n4-plan 2cb8357 + this): the shared gate **exit 0** (compiled 11 vs the
baseline's 9, better 7, worse 2: First Person Maze 33 -> 0 and Starlight 18 -> 15, each rerun twice side by side on
one tree: this 33 / 33 and 16 / 18, `EEAT_MATH_CORDER=0` 0 / 0 and 18 / 18: the levels' spread); the field class
(lane 3's 18 levels + Accident Prone and The Blank Page, which the math tier had lost; both arms side by side,
`EEAT_MATH_CORDER=0` the other): compiled 1 vs 1 (Accident Prone 3,452 vs 3,444 run ticks), progress 134 vs 129
(Starlight 23 vs 20, EXCrew Trolled Minis 12 vs 10, KOcrew 9 vs 8, Level 1 Overworld 36 vs 37, the rest equal; one run
each: within the spread), the tier's coupled legs 74 vs 57 (field 3 vs 17: the coupled piece below the field
answer's T takes them), its direct time 62 vs 68 s in all. test/msolve.js 50/0, test/planexec.js 32/32.

### 4.11 The land-and-act members (the coverage iteration)

The compiler's missed legs (section 7.6) start in the AIR (79% of the trigger / trophy legs the search tiers found: an
arrival is the touch of a coin or a switch mid-flight), and the plain tier's airborne start was ONE member, the launched
trajectory to its landing: a leg that lands and acts again (a hop, a jump, a walk-off, a walk on) was the chain tier's
(7% success in the compile).

**THEOREM L (a landing composes).** In the plain regime a member that crosses the floor line 16 fr - 16 descending at
tick T1, the box over a floor of row fr, ends tick T1 with y = the line and vy = 0 (the collision's), on the ground:
from T1 on it is a STANDING ball of row fr, whatever the x pattern was (the plain regime's x recurrence is the same on
the ground and in the air, section 2; the landing changes y alone). So the gravity axis of a leg through one landing is
the base member up to T1 followed by the standing family from (line, T1): a jump at j2 >= T1 (j2 = T1 is the landing
hop; y(t) = gravTrace(line, J)[t - j2] for t > j2), a walk-off at o2 > T1 (the fall from the line from o2 on), or the
walk. A two-parameter family (T1 = the member's crossing tick of each floor line with a floor under the hold range, at
most `o.landRows` 6 a base; j2 or o2), each member a closed form of the tables. The x axis is ONE pattern across the
landing (<= K changes over the whole leg), the tube: before T1 the base member's, at T1 the landing test (the box free
at the line, a floor of row fr under the raw / first-sub-step / aligned x), on the ground ticks the floor under the
first x sub-step (the walk-off rule), the walk-off tick without it, after the act the member's own flight; the jump bits
at the base's jump tick and at j2. Every candidate is replayed by the engine as before (a miss: the next candidate), so
the family only orders and proposes: nothing is claimed that the engine did not play.

**The cost rule.** Only airborne starts get the members by default (`o.landStanding`: a standing start's jump / walk-off
members as bases too). On the single real moves (msolve_bench, every 4th move, box 3) the standing bases lost 43 of
11,747 legs (39 jumps: the new items at the same T spent the jump members' node budget) and won 5 hops, 93 answers longer
and 63 shorter. A failing leg now spends its whole node budget (400 k nodes: p90 421 ms vs 1 ms on the airborne legs
below), so `o.plainMs` gives the plain tier a clock (checked per item and every 2,048 nodes); the compiler's executor
passes half of its time left.

**Measured** (box 3, `tools/math/msolve_air.js`: the route's exact state in the middle of every flight move of the 218
routes, class A, to the support TWO moves on (land + act + arrive: the end of the next move), Tmax = the route's ticks
from there + 10 (at most 150), the plain tier alone, the members on and off in one process, every answer replayed again
by a separate EESim with the moves study's test):

| airborne start -> the support 2 moves on | legs | solved on / off | <= route on / off | < route (on) |
|---|---:|---|---|---:|
| **all** | 15,281 | **58.0% / 4.7%** | **53.2% / 4.6%** | 17.1% |
| hop > hop | 5,123 | 75.6% / 3.9% | 70.2% / 3.9% | 8.1% |
| jump > hop | 1,484 | 68.8% / 6.3% | 64.8% / 6.3% | 13.0% |
| hop > jump | 1,472 | 64.6% / 5.0% | 58.6% / 5.0% | 46.3% |
| jump > jump | 918 | 70.2% / 6.5% | 62.9% / 6.5% | 50.5% |
| fall > fall | 894 | 69.9% / 1.7% | 64.4% / 1.7% | 13.2% |
| hop > fall | 659 | 67.8% / 3.2% | 60.1% / 3.2% | 19.9% |
| hop > arrow / dot, jump > arrow | 2,084 | 6.5-15.4% / 1.7-6.7% | | |

0 answers rejected by the independent replay; 8,154 legs solved only with the members, 0 only without; of the 712
both solved, the same T in every one. The time a leg (the loaded box): median 6.3 ms vs 0.22 ms, p90 421 ms vs 1 ms
(the failures' whole node budget: hence the clock). The field crossings (> arrow, > dot) stay the field / coupled
tiers' (the plain tier alone here); the failures: no plain candidate 5,532 (the field crossings, a second landing, a
bonk after the landing, K > 2), the node budget 707, not plain 176.

## 5 Admissible leg bounds: the event graph

(build / bounds.) Code: `src/math/lb.js` (the bound), `src/math/legsolve.js` (the free-air leg solver of its proofs),
`tools/math/lbcheck.js` (every tick of every leg of the known routes), `test/admbounds_truth.js` (the `math` and `best`
columns next to the n4 study's bounds). A lower bound on the ticks EVERY input sequence needs from an exact engine state
to a target, built from the recurrences of sections 1-3 (the engine's own doubles; no rounded state, no slack constant
on the free axes) and the level's tiles; section 4's THEOREM B is the plain regime's bound with a certificate, this one
covers the whole level: the gravity axis' collisions as EVENTS, the fields as BOUNDED SPEED-UPS, portals and deaths as
teleports.

### 5.1 The question

A state sigma (an `EESnapshot`: the exact position, speeds, jump count, effects, doors) and a TARGET: a set of centre
tiles and a mode, `touch` (the centre in a target tile at a tick's end), `land` (grounded with the centre there; a ball
already so counts: tick 0) or `landing` (a NEW landing there: the ball airborne at some tick before; the moves study's
next support, a hop in place included). **LB(sigma, target) <= the least T of any input sequence** whose replay from
sigma meets the target at tick T. The model's start must be PLAIN (`plainCtx`: gravity down, the current tile and both
queued tiles plain air, no effect but the speed / jump / gravity multipliers, max_jumps 1, alive, no levitation, no god
mode); else lb = null and the other bounds answer (section 4's, section 6's, the n4 study's).

### 5.2 THEOREM X: the input axis' envelope (walls zero a speed, they never add one)

Let `U_t = max(max_m step_m(U_(t-1)), 0)` from U_0 = vx0 (m over the inputs L, none, R: kin1d `axisStep`, and on a level
with ice also the slippery rule), `Xmax_t = A+(fl(Xmax_(t-1) + U_t))` with `A+(X) = max(X, align(X))`, and the mirror
L_t, Xmin_t. **THEOREM X.** For every input sequence, every level and every t: `L_t <= vx_t <= U_t` and
`Xmin_t <= x_t <= Xmax_t`, in the engine's doubles. *Proof.* Induction. A tick's x speed is step_m(vx) or 0 (a wall
zeroes it: kin.js `stepX`, section 1.5); step_m is non-decreasing in v (1.4) and the max over m of non-decreasing maps is
non-decreasing, so vx' <= max_m step_m(U) = U' and 0 <= max(U', 0). The move is the one rounded add x ⊕ v' (T-ADD) or,
blocked, a point between x and it; fl(+) is monotone in both arguments. The align moves toward the nearest grid line
and is non-decreasing (its pieces are increasing and its jumps are upward: 1.7), so A+ is non-decreasing and bounds the
aligned and the unaligned value. Qed. The envelope is the exact 1D minimum time of section 3.2 extended to walls, ice
and the align, with no slack: `xreach(a, b)` = the first t at which [Xmin_t, Xmax_t] meets a centre window [a, b)
(binary search: the envelope is monotone in t).

From an event node (5.3) the envelope restarts from the node's column window [16 kc - 8, 16 kc + 8) with the speed
bound `U = max(|vx0|, v*)` (v* = the held run's fixed point at the start's speed multiplier, 6.7766 px/tick at 1x):
**U is invariant**: for |v| <= U, |step_m(v)| <= U, because above v* the held step (v + a) B and the ice glide v Ino both
decrease (1.4, 3.1). The window grows by the exact sequence U, step(U), ... (`Useq`).

### 5.3 The gravity axis as collision events

In plain air y has no input (3.1, section 4's THEOREM S1): `vy' = (vy + G) B`, the move one add. The only other things
that change it are COLLISIONS, and they happen on LINES:

- a LANDING on a standing line s = t - 16 (t the top of a tile that can block: 16 r for a solid; 16 r and 16 r + 8 for a
  half block, a one-way, a door or gate, the secret block: every shape it can take), when the band descends past s:
  `vh > 0` and `pl <= s < nh` (pl, nh: the band's low end before, high end after the tick). The ball is then grounded
  with vy = 0; the jump may set vy = J at that very tick (the hop) or at any later tick on the line (J, and 0.88 J on a
  level with ice: the slippery jump);
- a BONK under a ceiling line c (a tile bottom: 16 r + 16, or 16 r + 8 for the shapes above) when the band rises past c:
  `vl < 0` and `nl < c <= ph`. vy = 0; the ball at [c, c + 1) from a fractional pre-position, or at the pre-position
  itself from a whole one (the move is one add there, blocked: it stays; section 4.2);
- the world's edges block as solids: y = 0 is a ceiling, 16 H - 16 a standing line in every column.

A line is in a centre column kc when a tile of it lies in columns kc - 1 .. kc + 1 (the 16 px box overlaps them).
**The engine retries a blocked step** in the move loop's later iterations while the other axis still moves (eesim.js
`csy = osy`): after a landing or a bonk the ball ends anywhere from the line to its free position of that tick, with
vy = 0 (grounded for a landing). So an event's y is a BAND: [s - 1, s + h] for a landing, [c - l, c + h] for a bonk (h,
l the free position's reach past the line, at most 16 px), and only next to a gap (a free cell within 3 columns in the
row past the line: `freeNear`; elsewhere the retried step is blocked again and the band is the line). On a level with
ice the y drag of an airborne tick can be Ino (the slippery timer runs 11 ticks past the ice): the band's ends take the
least and the most of both drags (each step is monotone in v). With low gravity (|a| < 0.1) the y align can fire: the
band's ends are aligned down / up.

**THE EVENT GRAPH.** Nodes LAND(kc, s, band) and BONK(kc, c, band) with a time. Edges: FLIGHTS from a node's band at
its speed (LAND: the jump J (and 0.88 J on ice) and the walk-off 0; BONK: 0), stepped tick by tick as an interval of
exact doubles, the x window per tick grown from the node's column by `Useq` (from the start: THEOREM X's envelope); at
flight tick n a line crossed as above in a column [k0, k1] of that tick's window makes a node at time
`max(t + n, xreach(column))`. WALK: LAND(kc, s) -> LAND(kc +- 1, s) at t + 1 (the centre column changes; only from a
band that is the line itself). The start is the flight from (y0, vy0) with the start's own envelope.

**THEOREM G (the relaxation is admissible).** Every engine path from sigma that stays in the plain regime maps to a
path of the event graph whose node times are <= the path's own ticks; the target test of the graph (a flight tick's
band and window meet a target tile: `touch`; a landing node in a target column and row: `land`, one after an airborne
tick: `landing`) holds no later than the path meets the target. *Proof.* Induction over the path's y collisions.
Between two collisions the path's y is the free recurrence from the event's state, which lies in the node's band with
the node's speed (0 or J); the band's ends evolve by the same monotone recurrence, so the path's y stays in the band at
every tick (interval arithmetic in exact doubles, the align and the ice drag bracketed). A collision of the path is on
a line of a tile that blocks it, which is one of the graph's lines in the path's centre column (every blocking shape
contributes every line it can have), at a tick at which the path's x is in THEOREM X's window: the graph has the node,
at a time <= the tick. A grounded tick of the path (walking, standing) is the walk-off flight's first tick: from the
band [s - 1, s + h] at speed 0 the band descends past s at once (vy = G B > 0), so the graph re-lands on the line at
t + 1 in every column of that tick's window that has the line, which holds the path's column (the floor under the
path's box is a tile of that line). The x axis is only relaxed: walls never stop the window, and a node allows every
speed up to U. Qed.

### 5.4 Sources: where the plain model ends

A SOURCE is a centre cell whose physics is not plain air (arrows, dots, boosts, climbables, liquids, effects, music, a
portal that teleports: not a silent one, reach.js `silentPortals`) or that kills (spikes, fire, toxic). The cell is the
engine's `current` (eesim.js `_playerTick`: the tile under the centre at the tick's start, a half block's cell shifted
to the cell above / to the left by its rotation): every rule that ends the plain model reads it (the gravity queue,
touchBlock, processPortals), so there is no dilation. A flight tick (or a node) whose window and band meet a source cell
at time t closes that branch with `t + REST(cell)`: sound, because the path is plain until the centre is in that cell
at a tick's start, and REST bounds everything after it (5.5). The start's own centre cell is checked first.

### 5.5 THEOREM R: the rest after a source (the bounded speed-ups)

**The level's speed sups** (`levelSups`): from the classes of the level's own tiles, per axis the most speed any tick can
have, the fields' fixed points (1.4, section 6): x = the held run's v* (at the speed effect's x1.5 where one is in the
level), the fall's terminal where x can be a gravity axis (side arrows, gravity effects), 16 where a side boost, a
portal (the rotation's x1.42 then the cap) or levitation is; y down = the fall's terminal (the level's gravity
multiplier, at least 1) or 16 (down boosts, portals, levitation); y up = |J| (x1.3 with the jump effect), the fall's
terminal under up arrows / gravity effects, the climb's 1.1 and the liquids' drift 4, or 16 (up boosts, portals,
levitation); a tile of physics this table does not know (the n4 study's untamed effects 453, 1520, 1573): 16 on every
axis. The start's own speeds raise them where they are higher. **REST(i)** = the least over the target tiles of
`max over axes ceil((16 (d - 1) - 7) / (sup + 0.25))` (d the tile distance on that axis; 0.25 px a tick for the align,
7 px once for a portal's x1.42 tick), through the TELEPORTS: a portal group (the portal cells with one exit set: 1 tick
+ the least REST at its exits, the Chebyshev distance to the group's nearest cell at the 16.25 px/tick cap), a death
(a kill cell: DEATH_MIN = 54 dead ticks + the least REST at a respawn tile; with a timed killer anywhere), the exits'
values by a fixpoint; and the given field (the n4 study's `admbounds` field) where it is higher.

**THEOREM R.** From any state centred in cell i, every input sequence needs at least REST(i) ticks to the target.
*Proof.* Per axis the centre's displacement over n ticks is at most n (sup + 0.25) (+ 7 px once when a portal's
rotation fires): every tick's speed is within the sups (they are the fixed points of every field the level holds, a
cap where a boost / portal / levitation can set 16) and the align adds at most 0.25 px a tick; a teleport moves the
centre to an exit at >= 1 tick (a death at >= DEATH_MIN); from a point of tile i to a point of a tile d tiles away is
at least 16 (d - 1) px. The fixpoint's values are the least over the ways through the teleports. Qed.

So a source is a BOUNDED SPEED-UP, not a wall of ignorance: the bound goes on through it at the most speed the level
can give. The first version gave a source rest 0 (sound, and the bound on every leg near an arrow collapsed to the
flight time to the arrow); then the isotropic 16.25 px/tick cap (1.3 ticks a tile); the per-axis sups make a free-air
level's rest the run and the fall (a tile in 2.4 ticks of run at v*).

### 5.6 The search: A* over the event graph, and the certificate

h(node) = the least REST (and field) over the node's cells: admissible by THEOREM R, so A* by t + h expands the nodes
in order of a lower bound of every path through them. Nodes are deduplicated by (column, line, band) keeping the
earliest; a node is DOMINATED by an expanded node of the same (column, line) whose band holds its band, no later (every
continuation of the dominated one is one of the other's). The target and the sources are tested on each node's exact
band when it is made, before the dedup.

- lb = the least target time found, or the least open f when the search stops first: the node cap (`cap`, 4,000), the
  time budget (`ms`), the HORIZON (an f >= horizon: the bound is then the horizon; `certify(sim, target, T)` passes
  T + 1). Each is sound: every unexplored path's time is >= its node's f (h admissible).
- The graph exhausted without reaching the target: the model says the target is out of the plain reach; the model is a
  relaxation, so that is a proof in its physics, but a gap in the model must not turn into a huge bound: the answer is
  the start cell's REST (5.5), admissible on its own.

**PROVEN OPTIMAL.** A leg found in T ticks from sigma with LB(sigma, target) = T is optimal from sigma: no input
sequence of any kind (inside the model or through a source) meets the target sooner. `certify(sim, target, T)` ->
`{lb, proven}`; `proof(lb, T)` -> 'optimal' | 'gap'. The compiler's report states it per leg (the Wire stage: call
`certify` at each solved leg's start state).

**The free-air leg solver** (`legsolve.solveLeg(L, sim, target, {lb, tmax})`): for T from lb upward, the x patterns of
<= 2 changes whose exact x_T lies in the target's centre window (kin1d `solveIA`: THEOREM M's branch and bound, 3.3),
each replayed once with no jump, then with ONE jump on each tick the no-jump replay was grounded (the hop included); the
goal is the engine's (the centre in the target, alive, grounded for `land`, airborne first for `landing`). A find at
T = lb is a proof.

### 5.7 The engine checks and the numbers

Every bound is checked against real input sequences replayed by the engine: a violation is a bound above what a real
sequence did (the routes' own ticks, or an engine-replayed solver answer). Box 3 (loaded 130-140 of 192 threads).

**Every tick of every leg** (`tools/math/lbcheck.js`, `--solve=1`: the truthset's 218 routes cut into the moves study's
49,846 legs, support to support; at EVERY tick t of a leg the bound from the route's exact state at t to the leg's end,
`landing` when it ends on a new landing, `land` for the final move onto the trophy's support, `touch` otherwise, against
t1 - t): **2,013,028 checks, 0 violations**; 42.4% of the ticks are outside the plain start (lb null). A query costs
9.6 ms mean on the loaded box (75 nodes expanded; 0.2% of the plain queries stopped by the node cap).

At the legs' starts (the plain ones: 35,712 of 49,846), bound / the route's own ticks:

| class | legs | median | mean | p10 | = 1 (the route's move proven optimal) |
|---|---:|---:|---:|---:|---:|
| **free air** (hop, jump, fall, walk) | 28,528 | **0.900** | 0.758 | 0.308 | 42.5% |
| free air, >= 10 ticks | 17,898 | 0.708 | 0.670 | 0.255 | 22.6% |
| hop | 16,984 | 1.000 | 0.877 | 0.500 | 63.5% |
| jump | 7,461 | 0.568 | 0.566 | 0.222 | 8.9% |
| fall | 4,042 | 0.611 | 0.613 | 0.207 | 16.7% |
| walk | 41 | 0.750 | 0.642 | 0.296 | 0 |
| portal | 931 | 0.442 | 0.515 | 0.048 | 26.3% |
| boost | 545 | 0.467 | 0.428 | 0 | 0 |
| arrow | 5,524 | 0.250 | 0.292 | 0.101 | 0 |
| all | 35,712 | 0.739 | 0.671 | 0.196 | 34.6% |

The route's own ticks overstate the true minimum (a TAS buys the next move's state with them). Against the best known
T (the route's or a solver's answer, whichever is less: an upper bound of the true minimum, so these ratios are lower
bounds of the true tightness): free air **median 0.963 / mean 0.785** with `legsolve`, **median 1.000 / mean 0.829**
with section 4's `msolve` (49.5% at 1). **PROVEN OPTIMAL legs**: the route's own move 12,367 (24.8% of the legs; 41.3%
of the free-air legs), with `legsolve`'s answers 14,327 (free air 47.2%), with `msolve`'s 14,490 (free air 48.2%). For
comparison section 4's plain bound (`msolve.lowerBound`, uncertified) on the same legs: free air median 0.515, at 1 on
3.5%.

The solver side: no `legsolve` answer below the bound (0 of 49,846); `msolve` answered 825 `landing` legs below it, all
of them its own goal ("grounded there") met without an airborne tick (656 starts already standing on the tile, 169
walks onto the next one: `src/out/mathlb/msviol.js`), not a new landing; `lbcheck` now compares only msolve answers
that are one.

**The event segments of `test/admbounds_truth.js`** (the n4 study's harness: the route's trigger events, every tick of
every segment plus every earlier segment start to every target, the `math` column next to adm / prim / eg; 30 ms a
query; the 14 routes of the 7 ice levels run again after the jump fix below, every other route's bound unchanged by
it): all 218 routes (the 219th file is stale: it does not finish its level): **math 0 violations in 1,301,347 checks**
(adm / prim / eg / max 0 as well; `src/out/mathlb/at_agg.js`). The segments are long (4,638 of them, 433 ticks on
average: a trigger to the next), and there the bound adds little: math median 0.146 (>= 10 ticks 0.134) where it is
defined (2,704 segment starts: plain), prim (bounds.js) 0.158 / **0.145**, the max of adm / prim / eg 0.161 / 0.148;
the max with math (`best`) 0.163 / 0.149, mean 0.260 vs 0.249, the sum over the segments 0.127 vs 0.124 of the routes'
ticks; math above every other bound on 644 segments. The event graph's strength is the free-air leg; a segment of
hundreds of ticks through fields, walls and detours is the other bounds' ground (5.8).

**What the checks found** (each an error of an earlier version, fixed and checked again): the world's edges block (a
ball at the top edge: Infinity Pain); the engine RETRIES a blocked step (Ice Slide Ride: a landing 0.256 px past the
line); the y drag on ice (Ino while slippery); a hop in place (the `landing` mode); the jump multiplier at the JUMP's tick
(`admbounds_truth`, The way of the north: a slippery start (x0.88) hops at x1 once the timer ran out; the bound was 1
tick too high on 3 ticks of one segment: the leg's jump speeds are now the effect's J and its x0.88 on ice levels,
whatever the start's timer; `lbcheck` never saw it: its legs end at the landing).

### 5.8 What the bound does not cover yet

- Starts outside the plain model (lb null): a start in or next to a field (arrows, dots, boosts, climbables, liquids:
  their queued tiles), levitation, flipped gravity, multi-jump (the air jumps are more members of the gravity axis:
  section 4.8), zombie / curse / fire / poison, god mode. The other bounds answer there (section 4.5 plain, section 6's
  field envelope, the n4 study's `admbounds`); the next step is the event graph in the field's frame (THEOREM F2: an
  arrow field is the plain axes rotated) and the air jump as a flight from any tick of a flight.
- Legs that pass a source: bounded at the level's speed sups (5.5), sound and loose (arrow legs median 0.25 of the
  route): the field envelopes of section 6 as the rest inside a field region would be the tight form.
- The x axis knows no walls: a leg that must go round a wall is bounded by the straight envelope (only y collisions are
  events). Walls as x events (the same construction on the other axis) would bound the detours.
- Long legs: the node cap / time budget stops the A* early and the answer is its frontier (sound, lower): ALL >= 10
  ticks median 0.55; the event segments of `admbounds_truth` (hundreds of ticks between triggers) gain little.
- Not wired: the compiler's report (the Wire stage: `certify` at each solved leg's start, `proof` in its report line).

### 5.9 API (`src/math/lb.js`, `src/math/legsolve.js`)

`createMathLB(L, {cap, ms, horizon})` -> `M`: `M.leg(sim, target, lo)` -> `{lb, why, tx, arc, nodes, capped, src}`
(`target` {tiles, mode: 'touch' | 'land' | 'landing'}; `lo` {field: a rest per tile (optional), cap, ms, horizon,
debug}; `why` 'start' / 'arc' (on the start's own flight) / 'target' / 'source' / 'frontier' / 'exhausted' /
'horizon'; lb null outside the plain start); `M.certify(sim, target, T, lo)` -> `{lb, why, proven}`; `M.stats()`;
`proof(lb, ticks)`; `staticOf(L)` (the lines, the sources, the teleport groups, the sups); `plainCtx(sim, S)`;
`xSteps(ctx, ice)`, `alignUp`, `alignDn`. `solveLeg(L, sim, target, {lb, tmax, k, limit, ms})` -> `{T, masks, proven,
tried, ms}` | null. `EEAT_TRUTH_ROOT=<root> node tools/math/lbcheck.js --moves=<exact_jsonl> --out=<dir>
[--shard=i/n] [--every=0] [--solve=1] [--solver=msolve] [--msb=1] [--adm=1]`, then `--agg=<dir>`;
`node test/admbounds_truth.js --math=1 --mathMs=30 [--shard=i/n] [--out=<file>]`.

## 6 Field kinematics: every field as one recurrence with its own coefficients

(build / fields.) Code: `src/math/fields.js` (the axis contexts, the recurrences, the envelope, the axis solver, the
path through field boundaries), `src/math/fieldsolve.js` (the field leg solver), `tools/math/fields_tables.js` ->
`src/math/field_tables/summary.json` (the tables), `test/fields_theorems.js` (the engine checks),
`tools/math/fields_cover.js` (the real routes). Sections 1-3 are the plain field's; this section is every other field
(arrows, dots, climbables, the four liquids, boosts, ice, gravity / speed / jump effects) and the boundaries between
fields.

### 6.1 The one recurrence: a field is an AXIS CONTEXT

For one tick with the environment (current tile c, delayed tile d, flipGravity, the effects) each axis runs section
1.4's `stepV` with coefficients the environment fixes. `fields.fieldCtx(o)` computes them exactly as `kin.tick` does
(the axis choice reads d and the UNSCALED pulls, then `m x sm`, `mo x gm`, the modifier `(mo + m) / 7.752`, the jump
multiplier after the ice timer), per axis an AXIS CONTEXT

```
A = { ms[3] (the input term of input index 0 none / 1 L or U / 2 R or D), mods[3] = (mo + ms[i]) / 7.752,
      mo (this axis' pull x gm), moO (the other axis' pull: only whether it is 0 matters), cur (climbable / liquid
      drags), slip (the ice timer after this tick's update), boost (0 or the +-16 a boost tile writes),
      mor, J (the current tile's int pull and the jump speed; J = 0: no jump on this axis), liquid }
v' = boost || stepV(v, mods[i], ms[i], moO, slip, cur);     p' = align(p (+) v', v', mods[i], liquid)
```

(`vStep`, `pStep`; `p (+) v'` is T-ADD's one rounded add, `kin.moveFree` below p = 16). The contexts fall into seven
RECURRENCE CLASSES (`kindOf`, `describe`: the drag each input applies, release / along / against):

| class | where | release / along / against | held from rest -> (exact double, tick) | release from it stops in |
|---|---|---|---|---|
| GRAV | air's y, an arrow's own axis, flip 1-3's rotated pull | B / B / B (no input acts) | 13.553105760940054 (1760); low gravity 2.0329658641410036 (1732) | (no input) |
| INPUT | air's x, an arrow's cross axis (moO != 0) | B N / B / B N | 6.776552880470027 (1760); x1.5 10.164829320704984 (1709); x0.6 4.065931728282007 (1732) | 94 (97, 90) |
| FREE | dots, flip 4, a boost's cross axis (moO = 0) | B / B / B N | the same as INPUT | **590** (612, 563) |
| CLIMB | climbables (and toxic's x) | B N / B N / B N | 1.0189913613742367 (292); x1.5 1.5284870420613546; x0.6 0.6113948168245416 | 78 |
| LIQUID | water / mud / lava / toxic (current) | x: B N / B D / B N; y: B D / B D / B N | water x 1.8106352581215837, y down 0.9053176290607918 / drift -0.9053176290607918; mud x 0.41289969932015064, y 0.5780595790482113 / drift 0.16515987972806034; lava x 0.5223087910013383, y 0.6267705492016059 / 0.10446175820026755; toxic y 0.6113948168245416 / -0.4075965445496944 | 70-83 (x) |
| BOOST | a boost tile's axis | +-16 whatever the input | -16 / +16 (tick 1) | - |
| ICE | slip > 0 (2 while on ice, then the 11-tick tail) | Ino / B / Ino I | the air values held; released x 0.99318 a tick | 1626 |

(B the base drag, N the no-modifier drag, D the liquid's, Ino / I the ice drags: section 1.2. A liquid's buoyancy is
its y pull; y's release drag is the liquid's because x has no pull there.)

### 6.2 THEOREM F1: the field model is the engine (test/fields_theorems.js F1, F4)

In every field and effect set, each axis' position and speed after every tick of every input word equal the axis
context's recurrence. *Engine check (box 3, 24 shards, `--T=32`):* 99 field contexts (the 15 fields x plain, speed
x1.5, x0.6, zombie, low gravity; flip 1-4 for air and the liquids; flip 1-4 with speed x1.5 and low gravity for air)
x 4 start states x both axes x EVERY input pattern with <= 2 changes of length 32 on the axis' own channel (h for x, v
for y: 5,769 patterns), the other channel sticky random and random jump bits: **4,569,048 engine runs, 146,209,536
engine ticks, px, py, speed_x, speed_y compared every tick: 0 mismatches.** F4: every held input's fixed point (every
context x axis x input x start 0 / +-16: 1,782) played by the engine to its tick: 1,408,500 ticks, 0 differ.

### 6.3 THEOREM F2: the classification (the arrows ARE the plain field)

**THEOREM F2 (the mirror).** `stepV(-v, -mod, -m, -moO) = -stepV(v, mod, m, moO)`: round to nearest is odd, the drag
conditions test signs and `moO != 0`, the cap and the snap are symmetric (a `+0` may come back `-0`: the same number).
So the field with every pull negated is the negated recurrence (`fields.mirror`). *Check (F2, box 3):* all 198 axis
contexts of F1 over 1,982,407 speeds (the reachable closure from rest, +-16 and J, edge doubles, 20,000 random): 0
failures. Grouping every axis context with an earlier one it equals or mirrors over those speeds gives **40 distinct
recurrences** (each liquid and effect set its own). The identities the tables use, each checked there:
- arrowL.y = arrowR.y = arrowU.x = arrowD.x = air.x: the cross axis of any arrow field IS the plain input axis;
- arrowR.x = arrowD.y = air.y; **arrowL.x and arrowU.y are the MIRROR of air.y** (the gravity axis, negated);
- air with flip 1 / 2 / 3: its pulled axis is air.y's mirror / mirror / itself; flip 4 = dots;
- dot.y = dot.x = boostU.x = boostL.y (FREE); climb.y = climb.x;
so every arrow field is the plain field rotated or reflected, bit for bit in the speeds, and the plain tables (section
3, `src/plan/kin_tables`) serve it with the axes and signs changed; positions are evaluated from the real start
(T-ADD: exact, no translation assumption).

### 6.4 Field boundaries: the schedule (THEOREM F5)

The coefficients change when the centre enters a tile of another physics, with the gravity queue's delay: tick t uses
`cur_t` (the centre's tile at the tick's start, the half-block rule) and `del_t` = `cur` of 2 ticks before (1 in dots
and climbables, where the queue shifts twice). Entering an arrow field from the air: 2 ticks with the arrow as `cur`
(its floor / jump axis, kills) and the air as `del` (the down pull, h acting), then the arrow's own context; leaving it
the same the other way. `fields.schedule(o, T)`: the per-tick contexts of a path that stays on one field's tiles from a
given queue. `fields.pathEval(L, st, masks)`: the COLLISION-FREE per-axis evaluation of an input sequence through a
static level's fields (per tick the centre tile, the queue, the tile below and the ice timer, fieldCtx, both axis maps,
multi-jump's air jumps), stopping where the swept box meets a solid, the world's edge or a tile whose touch changes the
state (effects, portals, keys, switches, crowns, the trophy, NPCs, music blocks; coins pass unless asked). *Engine check
(F5, box 3):* two-field rooms (13 fields: air, the 4 arrows, dots, climbable, water, mud, the 4 boosts; every ordered
pair, the boundary vertical and horizontal) x 40 runs of 90 sticky random ticks starting 2-7 tiles before the boundary
with random effects: **12,480 runs, 1,029,469 ticks, 6,712 runs across the boundary: pathEval = the engine on every
tick it evaluates (0 mismatches).**

### 6.5 THEOREM F3: the envelope, sound in every field

For an axis schedule (`A` or `A[t]`) and a start (p0, v0): `lo_{t+1} = min_i V(lo_t, i)`, `hi_{t+1} = max_i V(hi_t, i)`
(V = vStep) and `plo_{t+1} = plo_t (+) lo_{t+1}`, `phi` likewise. **THEOREM F3.** Every input word's speed at t lies in
`[lo_t, hi_t]` and its position in `[plo_t - s, phi_t + s]`, s = ALIGN_SLACK (2 px) where an armed tick is possible
(`envelope`, `armable`). Proof: V is non-decreasing in v for every fixed input (section 1.4's MONOTONICITY, which holds
in every field class), so `V(v, i) >= V(lo_t, i) >= lo_{t+1}` for v >= lo_t; the rounded add is monotone in both
arguments; induction; the align moves a position toward the nearest grid line by < 0.2 px a tick and never across it.
It needs NO key order, so it covers mud, lava and fast ice (section 1.4's exceptions), where hold-toward is not the
extreme. *Check (F3):* every word of length 9 over the 3 inputs from 5 starts in every context and axis: **19,486,170
words, 0 outside the envelope**, the largest align overshoot 0.967 px; the envelope's top is a held input's trajectory
in 927 of 990 (context, start) cases (the rest: the liquids' key-order exceptions). `minTAxis(p0, v0, X, As)` = the
least t whose envelope side reaches X: a lower bound for EVERY input word on that schedule (the 1D minimum time of any
field), exact where a held input attains the envelope.

### 6.6 Closed forms and the tables (src/math/field_tables/summary.json)

Each held input is the affine map `v -> (v + a) d` rounded twice (a the modifier, d the drag product): in the reals
`v_t = v* + (v0 - v*) d^t`, `v* = a d / (1 - d)`. The doubles stay within 1e-14 of it for 120 ticks in every class (the
table's `closed.maxGap`: 1e-16 .. 9e-15) and reach an exact fixed point (the table's `fixed`: the double and its tick,
engine-checked by F4). The table (`node tools/math/fields_tables.js`, 365 KB): 37 distinct recurrences of the 15
fields x {plain, speed x1.5, x0.6, low gravity} x 2 axes (identical ones share an entry; `same` / `mirror` list the
contexts served), per entry the class and drags, the constants as exact doubles (mods, mo, moO, J), the fixed points of
every input from 0 and +-16, the release's stop from the held fixed point, the closed form, and the envelope rows from
rest (vlo, vhi, plo, phi; 120 ticks, hex doubles): every field's 1D minimum-time function.

### 6.7 The field leg solver (src/math/fieldsolve.js)

`solveLeg(L, sim, goal, o)`: from a real state to goal tiles (the centre tile, with the support class asked: G on the
ground, Z dots, W liquid, C climbable, B boost), within `goal.maxT` ticks:
1. the start field's schedule (the queue's older tiles first) gives each axis' role: a GRAVITY axis (no input in
   flight) or INPUT axes;
2. a gravity field: the gravity axis has ONE trajectory per option: fly on (an airborne start), walk (pinned on its
   floor), jump at tick j (pinned until the press, then J), walk off the floor's edge at T0 (the floor's span under the
   box, from the level: pinned until T0 - 1, then free from rest), each read with a bonk on the start's ceiling
   (axis.js moveAxis, the engine's sub-steps) and without; at every tick T where it lies in a goal tile's window, or (G)
   lands on the goal row's floor plane `16 c` (both signs: the floor under a down-pulled ball, the wall beside an
   arrow's ball, the ceiling of an up arrow), `fields.solveAxis` gives every input-axis pattern (<= k changes, default
   2) in the goal tile's window at T, under the option's TUBE (the box over its floor until the press; off the edge
   exactly at T0);
3. no gravity (dots, climbables, liquids, boosts' cross axis, flip 4): both axes solved in the windows, every pair
   composes (section 2's THEOREM 3);
4. candidates by increasing T, each replayed ONCE by the engine from the start's snapshot: the first that reaches a
   goal tile with the class asked is the leg (exact: the engine's own replay);
5. across field boundaries: a refused candidate's ENGINE schedule (the contexts the engine used on its replay, tick by
   tick) replaces the assumed one and steps 2-4 run again on it (time-varying contexts; 2 rounds).
The field bound `lb`: per goal tile the later of the input axis' envelope time (THEOREM F3) and the earliest tick any
gravity option lands on the goal row's plane (G; the window tick otherwise): every input word inside the start field's
model needs at least lb ticks, and a leg found at lb is optimal there.

`fields.solveAxis(p0, v0, T, lo, hi, As, o)` is kin1d.solveIA for any axis schedule: every pattern with <= o.k changes
whose EXACT p_T is in [lo, hi] (a speed window, a tube, an input subset), fewest changes first, branch and bound on
THEOREM F3 from each node's exact state, the last change binary-searched (LEMMA L) where both runs are held keys of an
ordered class. *Check (F6):* 400 random patterns (<= 2 changes, T <= 64, random contexts and axes) as exact point
targets: all found, all 4,151 answers equal their evaluation, each first answer replayed by the engine lands where the
solver says.

### 6.8 The real moves (tools/math/fields_cover.js; box 3, 28 shards)

The 218 routes cut into moves between support states as the moves study does (a boundary at every landing, field
entry, teleport, death, respawn; labels hop, jump, fall, walk, arrow, dot, climb, swim, boost, airjump); every move of
<= 127 ticks that ends on a support (not a teleport or a death), from the route's OWN start state: is the route's next
support (its class letter and centre tile) reached within the route's own ticks? The mathematics alone (no family, no
search), a 250 ms clock for the candidate generation:

| label | moves | solved | faster than the route | as fast | median / p90 ms | found leg = the field bound |
|---|---|---|---|---|---|---|
| hop | 16,981 | 88.4% | 91 | 14,924 | 1 / 2 | 89.2% |
| arrow | 8,914 | 34.0% | 1,035 | 1,992 | 1 / 251 | 35.3% |
| jump | 7,533 | 74.2% | 3,734 | 1,853 | 18 / 251 | 51.5% |
| dot | 4,947 | 57.8% | 967 | 1,890 | 1 / 28 | 16.1% |
| fall | 4,455 | 75.7% | 459 | 2,914 | 4 / 126 | 33.3% |
| boost | 2,209 | 43.1% | 112 | 840 | 0 / 8 | 64.0% |
| climb | 361 | 43.5% | 56 | 101 | 1 / 35 | 22.3% |
| swim | 265 | 33.2% | 56 | 32 | 1 / 38 | 42.0% |
| airjump | 136 | 5.1% | 6 | 1 | 24 / 269 | 42.9% |
| walk | 42 | 100% | 38 | 4 | 1 / 19 | 85.7% |
| all | 45,843 | **67.9%** | 6,554 | 24,551 | **1 / 69** | 63.1% |

(1,114 s summed over the 45,843 legs; the schedule iteration found 521 of them, 384 on dots.) The field bound was never
above the route's own ticks where it was finite: admissible on every real move measured. Where the mathematics loses a
move: arrow moves cross fields and slide along walls (contacts the per-axis model does not see), dot moves end by
landing after leaving the dots (the schedule iteration's gain there: +7.8 points), multi-jump (airjump: no air-jump
option yet). For comparison, the moves study's exhaustive one-change family over the 9 direction masks (every change
tick: ~5,700 engine ticks a move) reaches the class-level support in time for jump 96.0%, hop 97.1%, fall 87.3%, dot
83.9%, arrow 61.5%, and the builder's navigation-graph search (1.5 s a move) 87.2% overall (arrow 72.0%, dot 75.0%).
With that family as `solveLeg`'s last resort (`o.family`: only where the mathematics found nothing; median 2 ms, p90
136 ms a leg): **87.4% overall** (math 66.7% + schedule iteration 1.1% + family 19.6%): hop 97.4%, arrow 75.2%, dot
86.6%, fall 89.0%, boost 91.2%, climb 90.3%, swim 90.9%, jump 78.8%, airjump 12.5%; faster than the route on 9,354 moves.

### 6.9 What the field tables do not cover yet

- Portals: section 1.8's map (`kin.portalTurn`: `(vx, vy) -> R_d (vx, vy)` through `(v x 7.752) x 1.42 / 7.752`, the
  position to the exit's corner, the old remainders kept) is exact (kin E: 1,861 real teleports); the solver does not
  plan through a portal (the random exit is the world's `W.exit`; pathEval stops at a portal tile).
- Levitation (fly): the thrust (`kin.thrustStep`) is a third per-axis term every tick; not in the axis contexts.
- Ice: the ICE class is modelled per tick (slip in the context) but the solver's first schedule assumes slip 0; a
  refused candidate's engine schedule carries the real slip.
- Multi-jump: pathEval has the air jumps; the solver has no air-jump option.
- Contacts beyond the start's floor / ceiling: walls met on the way, one-ways, half blocks: the engine's verify decides.

### 6.10 API

`src/math/fields.js`: `CLASSES, REP, classOfId(id), physKey(id), tileKind(id), fieldCtx(o), ctxOfSim(sim), schedule(o,
T), vStep(v, i, A), pStep(p, v, i, A), step, At(As, t), armed, evalAxis(p0, v0, code, t, As, trace), holdAxis,
envelope(p0, v0, T, As, from), minTAxis(p0, v0, X, As, tmax, safe, from), fixedPoint(A, i, v0), kindOf(A), describe(A),
solveAxis(p0, v0, T, lo, hi, As, o), mirror(A), pathEval(L, st, masks, o)`. `src/math/fieldsolve.js`: `solveLeg(L,
sim, goal, o) -> {ok, masks, ticks, tool ('math' | 'iter' | 'family'), T, lb, tried, solves, ms}` (o: k 2, jmax 40,
limit 6, maxMs 250, iterate true, rounds 2, family false: the exhaustive one-change family as a last resort),
`supportClass(sim)`, `tileOfSim(sim)`, `verify`, `scheduleOf(sim, T)`. Checks: `node test/fields_theorems.js [--quick]
[--only=F1..F6] [--T=32] [--D=9] [--shard=i/n]` (box 3 at full size: **176,469,571 checks, 0 mismatches**); the tables:
`node tools/math/fields_tables.js`; the routes: `EEAT_TRUTH_ROOT=<truth> node tools/math/fields_cover.js --shard=i/n
--out=<dir> [--family=1]`, then `--agg=<dir>`.
