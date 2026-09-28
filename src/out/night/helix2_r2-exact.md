# Forgotten Helix round 2, lane r2-exact: coin 4, exact precision and effects (2026-09-28, 05:40-06:50 EDT)

Branch `hx2-r2-exact` (= origin/main f8c229c + this note; no product change: there was no exact route to make general).
Scripts (git-ignored scratch, the worktree's `src/out/hx2r2/`, copies in `src/out/night/fetch/helix2/r2-exact/scripts`):
`flood2.js` (a sound tile flood), `flood3.js` (the same with a sound height budget), `rise.js`, `manifold.js`,
`manifold2.js`, `reentry.js`, `band.js`, `mscan.js`, `mscan2.js`, `gridpts.js`, `portals.js`, `proofs.sh` (reruns
sections 1-3 and 5 into `proofs.log`); `flight2.js` = r1-exact's exact flight DFS `flight.js` with a prune hole fixed
(section 4); `ascii.js`, `fx.js`. The flight scans ran on the EPYC (24 processes, nice 5, `/root/hx2r2x`, removed
after; logs in the fetch folder); everything else on the laptop CPU (1 process). No GPU was needed; the A100 was not
touched.

## Headline

**No route (routed = false, improved = false). Coin 4, and every other 4th coin, is out of reach at 3 coins.** This
round turns round 1's cell-merged evidence and r1-exact's grids into proofs where it can, and checks the rest on the
exact states the level can produce:

| claim | status | numbers |
|---|---|---|
| every 4th coin is behind the ceiling portals (74-76,125) | **proof** (sound tile flood) | at 3 coins without those portals: 2,750 tiles, none of the 12 other coins, no protection / run / multijump / fly tile |
| low gravity cannot be carried into the corridor without a death | **proof** (sound tile flood) | from (94,79) avoiding its removers (135,142), (93,80): 353 tiles, no corridor, funnel or checkpoint tile |
| ... nor with a death (respawn at a funnel checkpoint) | **proof** (sound flood with a height budget) | from (129,144) the ball's centre never gets above row 107; (94,79) needs row 79 (a 35-row budget still fails; the engine allows < 20) |
| the fall speed the shaft gives into (249,123) | exact, engine | max 8.637174 px/tick over arrow speeds 12-16 (step 0.002, 4 remainders); 8.625964 for every S >= 13.2 up to the 16 cap; bound over all S 8.75 |
| the other way into (249,123): back through (96,125) from the corridor | exact, engine | <= 5.892 px/tick (the corridor's rightward speed <= 6.78, the run's terminal); 8.984 even at an impossible 16 |
| the flight (96,125) -> (74-76,125) from the REAL entry states | exact DFS per state, no merging (r1-exact's DFS with a prune hole fixed) | none of the real states even LANDS on the pad (counts in section 4); on the grid the least fall that lands on the pad is 9.04, that reaches the portals 9.08 |
| round 1's "~1 px/tick" margin | refuted as too optimistic | the real max is 8.637 px/tick: 0.40 short of a pad landing even at the engine's speed cap, ~3 short with the approach the level allows (~6.0) |

## 1. Order: the only 4th coin is behind (74-76,125) (proof)

`flood2.js`: a SOUND over-approximation of the tiles the ball's centre can occupy at a tick start:
- per tick the centre moves at most 16 px per axis (speeds are capped at 16 after the drag, boosts set 16, and the
  teleport tick moves by the old capped speed rotated: eesim.js 1159-1217, `_portalTeleport`), so tick-start tiles are
  8-neighbours; a diagonal step needs at least one of the two orthogonal tiles non-solid (the 1 px x / y sub-steps
  put the centre in one of them mid-tick, and the box would then overlap a solid). Mid-tick passes through spike
  tiles are allowed (the hitbox is checked once a tick: the 7.99 px overlap is inside this model);
- a tile blocks only if it is surely solid (F_SOLID and not jump-through / half / rotated half / door kind; every
  switch door, gate, key door and team door counts as open; gold coin doors by the count: Helix has no coin gates,
  so fewer coins never open more) or kills at a tick start (gFlags & 4: the spikes; protection is not reachable);
- a portal tile allows both its teleport (to every exit of its target id: random picks are scriptable) and plain
  moves; gravity, arrows, speeds and effects ignored. Deaths add no tile (the respawn is a checkpoint already reached).

Round 1's flood forbade a diagonal step when EITHER orthogonal tile was solid (with a spike on the other side the
ball can pass mid-tick): not sound. With the sound rule, from the spawn at 3 coins: 10,983 tiles (every coin, effect
and portal the known routes use). With the three ceiling portals (74-76,125) removed: **2,750 tiles, and NOT reached:
all 12 other gold coins, the protection (394,72), the run effects (36,153) (284,62..63), the multijump effects, the fly
effects (209,123) (234,133) (281,119), the portal target (2,197)**. Coins 1-3 are (26,70), (79,80), (13,110). So "any 4th
coin opens door 4" does not help: at 3 coins the one way on is the ball's centre in (74-76,125) at a tick start.
No portal targets id 1 (the ceiling portals' id), so they are entered only from the corridor.

## 2. Effects: low gravity is the only one, and it cannot reach the corridor (proofs)

At 3 coins the reachable effect tiles are low gravity (94,79) (on) and its removers (93,80), (135,142), the team
effects and the gravity effects; every one of the 182 gravity effects in the level has the value 0 (normal gravity:
`flip_gravity = 0`, a no-op here). Run / multijump / fly / protection are unreachable (section 1).

- **Without a death**: `flood2.js` from (94,79) with (135,142) and (93,80) removed: 353 tiles, **none of the corridor
  ((88,128), (96,125), (83,126), (76,125)), the shaft, the funnel checkpoints (129,144), (100,140), (78,141), (88,128),
  or (77,113), (78,113)**. The low gravity is always removed before the corridor.
- **With a death** (the respawn keeps static effects): the ball must touch a checkpoint K past (135,142), go back to
  (94,79) without touching another checkpoint, and die. (129,144) is a chokepoint of the funnel's way east (row 144,
  x 128-130: (128,143), (129,143) are solid), so K = (129,144) (from (100,140), (78,141), (88,128) the sound flood
  cannot even reach (135,142) without touching (129,144)). Tile-wise the way back exists (103 tiles, up the diagonal
  spike channel (137,131) -> (105,85)), so it needs physics: `flood3.js` = flood2 + a SOUND height budget. The ball
  gains upward speed only at an "aid": a tile whose 3x3 neighbourhood holds a solid (the ground under the box is row
  cy+1, columns cx-1..cx+1), a non-default-gravity tile (arrows, dots, boosts, liquids, climbables; the delayed tile is
  an 8-neighbour), or a portal. Elsewhere it is in free flight under default gravity, where the centre rises at most
  R px from any speed: `rise.js` measured the engine's rise from every V <= 22.72 (16 x 1.42, the most a teleport
  leaves; 0.25 steps x 16 sub-pixel starts): at most 296.24 px (18.5 rows), + 16 px for a teleport tick: R = 313 px,
  under 20 rows; the budget is 21 rows above the aid's row. State: tile -> the highest row still allowed,
  label-correcting. Result from (129,144) (every other checkpoint avoided): **202 tiles, the highest row 107 (the
  channel at (135,107)); (94,79) NOT reached.** Margins: with budgets of 25 / 30 / 35 rows still not reached (highest
  rows 103 / 98 / 93); 40 rows (640 px, twice the engine's rise) reaches it. Sanity: from the spawn at 3 coins the
  same flood reaches all 9 checked tiles the real runs reach (coins 1-3, (94,79), (135,142), (129,144), (88,128),
  (76,125), (72,138)).
- So a respawn in the funnel never has low gravity, and the respawn at (88,128) at rest is the floor case (section 5).

## 3. The fall speed into (249,123), exact

`manifold.js`: the ball at a tick start in the portal (108,128) with speed S right (any S the arrows can give; the
speed variable is capped at 16 before the teleport) and x remainder remx; the engine plays (108,128) -> (251,125),
the rise and the fall. The height is input-free (r1-exact, shaft2.js, bit for bit). Only the fraction of py matters at
(249,123) (the exit tile sets py; `_rem_x = -_rem_y`), so each (S, remx) gives one exact (vyIn, f):

| S (px/tick) | 6 | 8 | 10 | 12 | 13 | 13.086 | >= 13.2 (to 16) |
|---|---|---|---|---|---|---|---|
| vyIn at row 123 | 4.168 | 5.929 | 7.073-7.194 | 8.097 | 8.562 | **8.637174** (the max found) | 8.625964 |

- S in [12, 16] step 0.002 x remx {0, 0.25, 0.5, 0.75} (8,004 points): max **8.637173898545825** (S 13.086, remx 0.75).
- A bound over all S: the rise out of (251,125) is at most 16 (the teleport tick) + 296.24 (rise.js) px, so the apex
  centre is at y >= 1695.8; free fall from rest at 1695 reaches y 1977 (past any first sample in row 123: 1968 + v)
  at 8.749 px/tick: **vyIn <= 8.75 for every arrow speed**.
- The other way in, `manifold2.js` / `reentry.js`: the ball enters (96,125) from the corridor moving right at vx,
  goes up out of (249,123) at 1.42 vx and falls back into it. The corridor's only rightward push is the run input
  (terminal 6.78 px/tick; no arrows / boosts / portals push right there; run effects unreachable): vx in [0.1, 6.78]
  step 0.005 x 4 remainders (5,348 points): **vyIn <= 5.892**. Even at vx = 14-16 (impossible) it saturates at 8.984.
- The realistic arrow speed (the jump from the corridor floor over (92-96,128), r1: S 8.14) gives ~6.0.

## 4. The flight from the REAL entry states, exact DFS

`flight.js` (r1-exact's: exhaustive over every input sequence, exact states, duplicates by `stateKey`; in the air
L / none / R (an air jump is impossible: `jump_count` is set to 1 when airborne, max_jumps 1; up / down do nothing
under vertical gravity), on the ground also the three jumps) from each (vyIn, f) of section 3 crossed with vxIn (the
shaft's sideways speed at the entry, set by the inputs; the flight's upward exit speed is 1.42 vxIn; the ball is in
column 249 for its last 3-4 tick starts before (249,123) (cols 248 / 250 are spikes there), so |vxIn| < ~5.5).

**A hole in r1-exact's DFS, fixed (`flight2.js`)**: its envelope prune runs on falling states (vy >= 0), and a ball
that bumps the ceiling (71-84,124) while rising into the portals (74-76,125) ends that tick with vy = 0 and its centre
IN the portal tile: every input teleports it on the next tick, but the prune's rollouts follow the teleport to (2,197)
and could see the spikes (2..5,198) there and cut the state: a success could be lost. flight2.js never prunes a state
whose centre is in a portal tile. And the scans below use `GOAL=pad`: a landing on the pad (74-76,128) at any speed
counts as a success, as well as a teleport (every way into the portals passes one of the two; a landing counts even
when the ball could not brake before the spikes (71-73,128), so this goal is weaker, and the depth limit of 70 ticks
is safe for it: the band crossing comes first, and a flight that lands later averages under 4.6 px/tick, far too slow
for the band). So a 0 below is 0 for the real goal too.
Sanity: the EPYC gives the same node counts as the laptop (3,280 / 116,508 / 13); vyIn 9.1, vxIn -1.6, f 0.25 lands
on the pad after L x27 (27 nodes). With the fix and the portal goal, the finished part of r1-exact's scanB grid (5 of
24 parts, 9,635 states) found the same successes as r1-exact (vyIn 9.08 f 0.875 vxIn -1.62; 9.10) and none lower.

| scan (flight2.js, GOAL=pad) | states | successes | capped |
|---|---|---|---|
| r1-exact's scanB grid: vyIn 8.30-9.10 step 0.02, f k/8, vxIn -3.2..-0.4 step 0.02 | 46,248 | 233 (pad landings), **all at vyIn >= 9.04**: 9.04 x10, 9.06 x52, 9.08 x80, 9.10 x80; none <= 9.02 | 0 |
| cap: vyIn = 8.625964 (every S >= 13.2), f = k/64, vxIn -5..3 step 0.05 | 10,304 | 0 | 0 |
| real: S 6..16 step 0.05 x remx {0, 0.5} (exact vyIn up to 8.634, f), vxIn -5..3 step 0.1 | 32,562 | 0 | 0 |
| re-entry: vx 3..6.78 step 0.005 x 4 remainders (3,028 points, vyIn 2.7-5.89), vxIn -5..3 step 0.2 | 124,148 | 0 | 0 |
| near the max: S 12..16 step 0.01 x 4 remx (1,601 points, vyIn 8.19-8.637), vxIn -5..3 step 0.2 | 65,641 | 0 | 0 |
| low: S 6..12 step 0.01 x 4 remx (2,400 points, vyIn 4.17-8.13), vxIn -5..3 step 0.2 | 98,400 | 0 | 0 |
| near the max, dense, in the vxIn band of the grid's successes (-1.6..-2.0): S 12..16 step 0.004 x 4 remx (4,002 points), vxIn -2.2..-1.4 step 0.05 | 68,030 | 0 | 0 |

In all, over the states the level can produce: **0 pad landings and 0 portal hits in 399,085 states (cap, real, re-entry, near the max twice, low), none capped**.

(A denser version, all 8,004 points of S 12-16 step 0.002 with vxIn step 0.1 = 648 k states, did not fit the round:
near the max the DFS does ~8-10 states a second per process; it was stopped unfinished after 9 min, and a 264 k
version (vxIn -2.6..-1.0 step 0.05) after 4 min, both with no landing line in their logs (a landing prints at once).)

Before the fix (flight.js, portal goal, laptop and EPYC): cap 10,304 states, real 32,562, low 32,400 x 2 parts, fine
4 of 18 parts: 0 successes, 0 capped (superseded by the table above). The re-entry scan's first try (all vx from
0.1) hit the 400,000-node cap on its slowest states (vyIn 0.38 and similar: the ball crawls out of the exit at
0.5 px/tick and the DFS walks every way down); one of them rerun with a 3 M cap finished at 1,278,559 nodes, no
landing (79 s); the table's re-entry row is vx >= 3 (vyIn >= ~2.7), slower exits are kinematically hopeless
(section 5: the band needs ~12 px/tick).

## 5. The floor, the respawn at (88,128), landings

The band: in cols 77-84 the centre must be in rows 126-127 at every tick start (row 125 and row 128 are spikes there,
and a ceiling bump under (71-84,124) puts py at 2000, centre row 125). `band.js` (the engine's recurrences):
- a jump from the floor (py 2048): the centre is in rows 126-127 at ticks 2..7 only and in row 125 at tick 8. To be
  in the portals (74-76,125) at tick 8 from the floor (centre col >= 86) is >= 145 px in 8 ticks = 18 px/tick, over
  the 16 cap; else the centre is at col >= 85 at tick 8 and stays there until it is back in row 126 (cols 77-84 are
  spikes or ceiling above it): at least ~19 ticks after the jump (a bump under (90-96,124) at ~tick 9 + 8 ticks, or
  the free apex higher up) within x_c 1360..1471, so <= ~5.8 px/tick on average, + <= 0.127 a tick from the run
  input, against the fall's ~12 px/tick (next point). So **no floor state (the respawn at (88,128) at rest, a landing
  from the flight at <= 12.4 px/tick) reaches the portals by a jump**, whatever its speed (kinematic, with margin). Running off the floor's left end puts the
  centre in (85,128): a spike. flight.js cuts floor landings as a new cycle (r1-exact); this closes that cut for the
  jump; the other continuations from the floor go right (the arrows or (96,125): section 3's manifolds).
- a fall: after a ceiling bump (py 2000, vy 0) the centre is in row 126 from tick 8 and in row 128 at tick 19: 11 band
  ticks for > 128 px (col >= 85 at tick 7 to col <= 76 at tick 19): ~12 px/tick needed. That is the flight's own
  mechanism (the ball bumps (90-96,124) right after the exit), searched exactly by flight.js from every real exit.
  From higher (the gap (85-89,124), the upper corridor) the band is shorter and the ball slower (it must hover at
  cols >= 85 while above row 126, where the run input adds <= 0.129 px/tick a tick): no.

## 6. What was tried from the task list, and why the rest does not apply

- The spike hitbox (centre tile, once a tick): inside every model here (flood2's mid-tick passes, flight.js's engine).
- Other portal-entry timings / sub-pixel entries: the manifold covers every S and x remainder (the only free
  parameters of the entry besides vxIn).
- Rest-to-rest macro-moves / the precision solver (`src/out/precision/solver/`): they solve exact POSITION puzzles;
  this gap is a SPEED deficit (the level cannot produce the fall speed), which no position search closes.
- Deaths: section 2 (effects) and 5 (the floor respawn); checkpoints do not give the pad a slow arrival: the pad's
  only arrival is the flight, and the funnel's checkpoints are all behind the band or on its safe floor.
- Coin order: section 1.

## 7. Where it stands

Forgotten Helix cannot be cleared in this engine as the level is built (unless the port differs from eeo-tas at the
portal exit tick: `_portalTeleport` case 3 keeps the old y step, the ball drops by vyIn in the exit tick). The
remaining non-proof parts: the flight threshold is a per-state exhaustive DFS on grids and on the real entry
manifold (sampled finely, not a continuum proof), and the floor case is a kinematic bound. The hx-int-1 runs on the
A100 (stuck at 3 coins) cannot get past coin 3: the machines are better used elsewhere.

Not built (no route to generalize): a general version of sections 1-2 for the product. On levels with effects the
reach field is walk mode (never a proof), so Find a route cannot say "impossible" there; flood2's sound tile flood
per coin count and flood3's height budget (free-flight rise <= 313 px between aids) would let the editor's check say
which gate is provably closed (here: "the 4th coin needs the ceiling portals (74-76,125); low gravity cannot reach
them") in well under a second, and stop searches that cannot succeed.
