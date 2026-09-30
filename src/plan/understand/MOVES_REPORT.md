# N4U study 2: the move maths on real routes

2026-09-29, study-moves of COMPILER-UNDERSTAND (wf_af610491-c90). Branch `n4u-moves` (off `origin/n4plan-model` bc3e1aa):
`src/plan/understand/{moves.js, moves_agg.js, moves_cls_agg.js, movecheck.js, listfiles.js}`. The data (per-move JSONL,
28 MB) is in `src/out/n4plan/understand/moves/` of the main checkout, not in git.

Everything below is the engine's own replay (src/eesim.js). **Exact** means the same `stateHash()` at the move's end
tick. **Class** means the same next support (the class letter and the centre tile, or a teleport to that tile) at the
same tick or earlier. No level-specific code is involved. Box 3 ran it with 16 threads at nice 10, taking about 1 minute
for each pass.

## 0. Data and segmentation

- Truthset: 219 known routes, 218 of which replay (1 is stale: `08_4_Treasure_Trove_Cove`). They cover 106 levels
  (111 user jobs and 108 benchmark runs), **49,846 moves** and **2,013,028 ticks**. A route has a median of 178 moves
  (p90 568, max 1,064).
- **Support state** of a tick is one of: `G` (on_ground: this tick's movement hit the floor, in any gravity direction),
  `W` (liquid), `C` (climbable), `Z` (dots 4/414), `B` (boost), `D` (dead) or `A` (air). A **move** runs from one
  boundary to the next. A boundary is a landing or field entry (`A -> G/W/C/Z/B`), a teleport (|dpos| > 20 px in one
  tick), a death or a respawn.
- Move classes, in priority order: respawn, death, portal, boost, swim, climb, dot, arrow (any arrow tile or gravity
  other than down), jump (a jump pressed from the ground), **hop** (the move is launched by a jump on the previous
  move's landing tick), hopjump, airjump (multi-jump), fall (walk-off) and walk.

| class | moves | % moves | % ticks | len p50 / p90 | raw dir runs p50 / p90 | essential dir runs p50 / p90 |
|---|---:|---:|---:|---|---|---|
| hop | 17,073 | 34.3 | 16.8 | 15 / 42 | 2 / 7 | 1 / 6 |
| arrow | 10,078 | 20.2 | **38.3** | 44 / 138 | 5 / 18 | 3 / 13 |
| jump | 7,626 | 15.3 | 12.0 | 28 / 62 | 3 / 8 | 1 / 6 |
| dot | 5,391 | 10.8 | 13.6 | 26 / 106 | 4 / 15 | 3 / 11 |
| fall | 4,613 | 9.3 | 9.3 | 26 / 67 | 3 / 9 | 2 / 8 |
| boost | 2,305 | 4.6 | 3.3 | 9 / 74 | 2 / 10 | 1 / 8 |
| portal | 1,726 | 3.5 | 2.8 | 16 / 70 | 2 / 8 | 1 / 5 |
| climb | 395 | 0.8 | 1.1 | 29 / 118 | 4 / 16 | 3 / 12 |
| swim | 297 | 0.6 | 1.2 | 52 / 132 | 5 / 20 | 3 / 17 |
| airjump | 178 | 0.4 | 1.3 | 81 / 354 | 8 / 62 | 8 / 31 |
| death / respawn | 61 / 61 | 0.1 / 0.1 | 0.1 / 0.2 | 32 / 54 | | |
| walk | 42 | 0.1 | 0 | 4 / 19 | | |

Plain ground moves (walk, jump, hop, fall) make up 58.9% of the moves but only 38.1% of the ticks. Arrow and dot
moves together take **52% of the route time**.

## 1. HOPS: the largest gap in the current family

**53.5% of the routes' 40,072 landings are hops**: the jump is pressed on the landing tick itself. In Player.as order,
that tick's movement lands (`grounded`) and the jump fires in the same tick. 21,458 of the 40,153 ground-start moves
are launched this way.

In the primitives family (`origin/n4plan-primitives` 2e70a92, and still f6911f4), **no ground macro ends in a hop**.
The landing tick of a JUMP / WALKOFF / RUN arc carries the macro's own mask, which has no jump bit after k = 0. The
next JUMP presses one tick later: a different state, and one tick slower on every bounce.

The graph as a whole can still hop, but only through an air node, for example STEP(J|d) from the ground followed by
the HOLD(d|J, land) chain. That path holds jump through the whole arc, which leaves a different held-jump-timer state
than a clean hop, and it costs two or more edges and extra expansions.

Exact coverage from the route's own takeoff state (same end stateHash, same tick), one macro:

| moves (plain support, no effect) | builder macro as is | builder + a **hop option** (the landing tick re-simulated with the jump bit) | per-tick <= 1 air change + hop option (exhaustive) |
|---|---:|---:|---:|
| jump (7,422) | 34.2% | 61.1% | 70.8% |
| hop (16,714) | **0.0%** | 60.9% | 69.9% |
| fall / walk-off (3,500) | 36.5% | 46.5% | n/a |

The fix is cheap and general. Whenever an arc edge ends on a landing, emit a second child: restore the pre-landing
snapshot and play the landing tick with `mask | 1`. That costs 1 extra tick per edge. The first edge of a node that was
launched by a hop is the macro's tail (k >= 1, no press).

## 2. EXACT reproduction needs per-tick timing and more than 1 change

- **Timing slack.** Of the 86,717 essential change points, **90.8% break the exact end state when shifted by 1 tick**
  (jump 94.2%, fall 93.8%, arrow 84.2%, dot 87.8%, portal 81.4%).
- **The builder's grid.** Only 21.2% (jump) and 12.7% (hop) of the per-tick one-change timings fall on the builder's
  grid {2, 4, 8, 12, 16, 24}. About half of them are at **tick 1** after the press (jump 837 of 1,650; hop 1,122 of
  2,568).
- **Change kinds** among the one-change hits:
  - jump: "late hold" (no direction on the press tick, a direction from tick c) 1,003; turn 399; release 248.
  - hop: late hold 1,216; turn 915; release 437.
  - **No builder macro has the late hold.** JUMP always presses with d at k = 0. The graph can compose it (STEP(J),
    then the HOLD(d) chain), but only at the HOLD stops (c ∈ {1, 3, 7, 17, ...} with more edges) and at the cost of
    more depth.
- **Essential changes.** The route's inputs were greedily simplified: merge a direction run into a neighbour, drop
  up/down, keep jump bits only where a jump happened, shorten jump runs to one tick. Each step was kept only while the
  engine still reached the same end stateHash. The result is an upper bound on the minimum changes, so the coverages
  below are lower bounds. At k = 1 they are within 1.5 points of the exhaustive per-tick F1 test, so the bound is tight.

| F_k = at most k direction changes at any tick (jump presses free) | k<=0 | <=1 | <=2 | <=3 | <=4 | <=6 | <=8 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ALL moves (49,846) | 46.0 | 58.2 | 69.8 | 76.9 | 82.3 | 88.7 | 92.4 |
| ticks-weighted | 17.5 | 27.0 | 37.7 | 45.4 | 51.9 | 60.3 | 65.9 |
| jump | 51.2 | 60.9 | 74.7 | 81.3 | 87.1 | 92.9 | 96.6 |
| hop | 58.1 | 68.5 | 78.8 | 84.6 | 89.1 | 94.3 | 97.0 |
| fall | 41.1 | 54.7 | 68.1 | 76.7 | 83.3 | 89.7 | 93.3 |
| arrow | 28.3 | 42.7 | 54.3 | 63.2 | 70.1 | 79.1 | 84.5 |
| dot | 29.5 | 44.9 | 59.1 | 68.5 | 74.8 | 83.3 | 87.7 |
| swim | 20.9 | 37.0 | 50.8 | 59.3 | 64.0 | 71.4 | 77.8 |
| climb | 30.1 | 46.1 | 59.2 | 66.3 | 72.4 | 79.0 | 83.8 |
| boost | 60.8 | 72.4 | 79.3 | 82.8 | 85.7 | 89.1 | 91.7 |
| portal | 60.3 | 75.1 | 83.8 | 88.3 | 91.3 | 94.4 | 95.8 |

The plain jump run-up has 0 essential ground changes in 76.8% of moves and at most 1 in 88.0%. Its median is 4 ground
ticks before the press (p90 27).

Jump presses: 33,316 of the essential jump runs are 1 tick long. The longer ones sit in arrow (4,914 moves), fall
(1,191) and dot (558) moves: the held-jump repeat (`_last_jump`, a re-jump every 150 ms while held). **Held jump is a
real input** there, so it needs a family member.

**Conclusion.** No small family reproduces 90% of the routes' moves exactly. The routes are TAS-optimised down to the
tick and the sub-pixel: exact 90% needs about k = 6 per-tick changes on plain moves and more than 8 on arrow, dot and
swim moves. That is 3·(2A)^k/k! members from each state, which is not a table.

## 3. At the SUPPORT-CLASS level, one per-tick change is enough for plain moves

The question here: can a family member reach the route's next support (same class, same tile) at the same tick or
earlier, starting from the route's own state? Pass `--cls=9` covered 49,431 moves. Masks were {-, L, R} on plain moves
and the 9 non-cancelling direction masks on every other move, because the gravity can turn inside a move. With only the
start state's probe-reduced masks, arrow coverage is 43.2% and swim 31.8%. F2 means two changes, per tick, and was
tried on the plain moves that F1 missed.

| class | F0 constant | **F1 one change, per tick** | **F2** (plain) | F1 strictly earlier | F1 same tick and not slower (dvx >= 0) or earlier | builder JUMP / WALKOFF macros |
|---|---:|---:|---:|---:|---:|---:|
| ALL | 62.3 | 86.1 | | 16.1 | 66.1 | 84.4 (plain) |
| jump | 74.2 | **96.0** | **99.2** | 22.3 | 81.6 | 86.2 |
| hop | 72.6 | **97.1** | **99.7** | 1.0 | 55.7 | 86.5 (as the hop's tail) |
| fall | 56.8 | 87.3 | **93.8** | 11.6 | 72.0 | 73.1 |
| climb | 56.9 | **90.5** | | 55.7 | 85.1 | |
| swim | 53.2 | **90.1** | | 62.9 | 88.7 | |
| death | 68.3 | 86.2 | | 15.5 | 86.2 | |
| dot | 58.4 | 83.9 | | 41.2 | 80.0 | |
| boost | 70.3 | 82.4 | | 12.7 | 78.1 | |
| portal | 72.1 | 81.8 | | 10.5 | 78.8 | |
| arrow | 37.8 | 61.5 | | 25.6 | 55.7 | |
| airjump (multi-jump) | 6.8 | 10.3 | | 9.6 | 10.3 | |

Reading this table:

- The plain families reach the right support at the right time. The routes' extra changes buy **exact state**, meaning
  speed and sub-pixel position for the next move. On hops, F1 reaches the same tile at the same tick but slower in 44%
  of cases. That speed is what the optimum is made of.
- Arrow moves are long (median 44 ticks, p90 138) and turn the gravity inside the move. Even with 9 masks, one change
  reaches only 61.5% of them. They need the HOLD chain (a mask held until a stop, then the next) with stops at the
  gravity-change and field-entry events, not only at n ∈ {2, 6, 16}. Arrow moves are 38% of all route time.
- Multi-jump moves (airjump, 178 moves) need the second-press timing as a family parameter. F1 without it reaches 10%.

### T-MOVES: the builder's whole navigation graph against the real moves

`movecheck.js` ran against `origin/n4plan-primitives` f6911f4 (prims + navgraph + bounds, anytime A*, 1.5 s per move).
It took one route per level, every 8th move, about 2,360 moves. From the route's exact state at a move start,
`prims.route()` searched toward the route's next support (tile + class). **Covered** means reached in no more ticks than
the route took.

| class | n | covered | reached, but later | not found (budget) | strictly faster (class level) | median expanded |
|---|---:|---:|---:|---:|---:|---:|
| ALL | 2,358 | **87.2%** | 7.7% | 5.1% | 28.7% | 429 |
| hop | 651 | 98.8% | 1.1% | 0.2% | 19.5% | 331 |
| fall | 335 | 92.8% | 4.5% | 2.7% | 10.7% | 154 |
| portal | 105 | 92.4% | 5.7% | 1.9% | 13.3% | 59 |
| boost | 162 | 91.4% | 4.3% | 4.3% | 11.7% | 4 |
| jump | 367 | 85.6% | 10.6% | 3.8% | 54.5% | 589 |
| climb | 27 | 81.5% | 3.7% | 14.8% | 59.3% | 135 |
| dot | 260 | **75.0%** | 15.0% | 10.0% | 37.3% | 591 |
| arrow | 443 | **72.0%** | 15.1% | 12.9% | 36.8% | 1,200 |

- Each move here is checked alone, starting from the route's state, which is often already launched by a hop. The hop
  gap therefore does not show in this test. It shows when moves are **chained**: the builder can only jump 1 tick after
  each landing. 189 of 218 routes hop. The routes hop 0.71 times per 100 ticks at the median (p90 2.9, max 4.7), so the
  gap costs at least 0.7% of the run at the median and 3-4% on Forgotten Veil-like routes (438 hops in 11,201 ticks).
- "Strictly faster" is at the class level only. The route may have arrived later on purpose, for its exact state.
- Arrow and dot moves are the weak classes: 72-75% covered, 15% reached only later, 10-13% not found within budget.
  Together they are 52% of route time.

## 4. Support states do not quantise

- Ground starts (40,153): py is an integer in 93.0% (the landing snaps y), but **px is an integer in only 9.7%**,
  vx = 0 in only 10.2%, and vy = 0 in 42.4% (the rest are hops). Distinct exact (px, vx) pairs: 21,646. The key
  (tile, round(vx·16)) gives 21,199 distinct values and (tile, round(vx·2)) gives 17,133. So quantisation merges
  almost nothing.
- Perturbation test: the move's start is changed inside a class and the route's own inputs are replayed (47,734 moves).

| perturbation | same exact state at the next support | same tile + ground, abs(dpx) < 1, abs(dvx) < 1/16 | different |
|---|---:|---:|---:|
| px + 1e-9 | 27.6% | 68.1% | 4.3% |
| px + 1/64 | 27.1% | 67.7% | 5.2% |
| px + 1/4 | 21.1% | 61.1% | 17.8% |
| vx + 1/256 | 27.8% | 69.0% | 3.2% |
| vx + 1/32 | 25.0% | 58.6% | 16.4% |

A perturbation disappears (the next support is the same exact state) in 67% of portal moves, 43% of arrow moves and
about 25% of plain moves. Everywhere else, a 1e-9 px difference **survives to the next support**.

**The support-state class that keeps moves exact is the exact state itself.** Use the full stateHash for nodes and
dedup. A class key such as (tile, floor(px), round(vx·16), ground, jumps, features), or the builder's `support()`,
predicts the next class 95% of the time (X + c at 1e-9) and 82% at 1/4 px. It is only a heuristic, fit for ordering and
for opt-in dominance, never for a proof.

## 5. Table sizes

- Standable cells (a free tile over a solid) per level: median 1,494, p90 5,342, max 10,732.
- Air window A = 43 ticks (p90 of the single-jump arcs; the median is 16).
- Per-tick family members from one state, with masks {-, L, R}: F0 = 3, F1 = 3 + 6(A−1) ≈ 255, F2 ≈ 11,000,
  F3 ≈ 320,000. The hop option doubles only the landing tick.
- A precomputed table of (standable cell × 109 vx classes) × F1 would hold about 4e7 arcs per level, each up to 43
  ticks: about 1.8e9 ticks. That is minutes per level, and it would still not be exact, because states do not quantise
  (section 4). F2 would hold about 2e9 arcs.
- **So there are no exact tables.** Every edge is simulated online from the node's exact state, as the builder already
  does. tables.js is useful only for bounds and candidate order. With prefix sharing (the d0 prefix played once, a
  snapshot at every c, then d1 to the event), F1 from one node costs about 3A + 6A·A/2 ≈ 5,700 ticks, roughly 1-2 ms.
  A 60 s compile therefore affords about 30-60k F1 expansions on one thread, times the worker count.

## 6. Recommended family

**PT1+H**, the per-tick one-change family with the hop option, plus chains on the ground and in the fields:

1. **Ground (plain support):** RUN / IDLE prefix chains, already in the builder, with a stop at every tick (not at the
   RUN_N grid). The route run-ups are 4 ticks at the median and 27 at p90, and 88% have at most one ground change.
2. **Arc from a ground node:** press on k = 0 with d0 ∈ {-, L, R}, hold d0, switch to d1 ∈ {-, L, R} \ {d0} at any
   c ∈ [1, A], and run to the first support event. **Emit both the landing child and the landing-tick hop child.**
   This covers the builder's JUMP(d, rel r) / JUMP(d, turn t) at every r and t, and adds the late hold (0 → d),
   which is the most common one-change shape and about half of all changes at c = 1.
3. **Arc of a hop node** (launched on the previous landing tick): the same shapes without the press.
4. **Walk-off:** the ground chain's last tick continues as an arc with no press (the same F1 shapes and the hop
   child). The builder's WALKOFF(d, hold | rel) is the F0 / F1-at-takeoff subset.
5. **Fields, arrows, liquids, climbables, boosts:** HOLD(m) chains over the 9 non-cancelling masks, or the probe-reduced
   ones when the gravity is fixed. Stop at every tick up to 16, then at the gravity or field changes and the events.
   Add a held-jump variant (the jump bit held; it is essential in 4,914 arrow and 558 dot moves).

Expected coverage: exact about 70% on plain moves (1 change); class level 96-97% on jump and hop, and 87% on
walk-offs, which need F2 (93.8%; jump and hop are at 99.2% and 99.7% with F2). To go beyond that, lean on exact dedup plus composition: an F1 edge whose landing
tile matches the route's but whose state differs is still a correct edge, and the next F1 edge from it recovers the
position. That is where A* over exact states earns the optimum.

## 6b. Is the hop needed? And a prototype of the fixes

**Hop need (`moves.js --hopneed`).** Take a plain hop move, replay its landing tick WITHOUT the jump bit, and press on
the next tick instead. Then try every per-tick one-change shape toward the move's next support by the route's own tick.
There are 16,714 plain hop moves. With the hop, F1 reaches the next support by the route's tick in 16,416 of them.
Without the hop, **only 37.7% (6,188) still reach it by the route's tick**:

| without the hop | moves | share |
|---|---:|---:|
| still in time | 6,188 | 37.7% |
| exactly 1 tick late | 8,726 | 53.2% |
| 2-3 ticks late | 137 | 0.8% |
| not reached even with 3 extra ticks (the delayed arc misses) | 1,365 | 8.3% |

So the hop is needed in 62% of hop moves. A compiler without it is at least 1 tick late on each of those bounces, and
on 8% of them the jump does not work at all.

**Prototype (`prims_patch.js`)** on a copy of the builder's f6911f4 prims.js:

- `hop`: every landing edge or chain also emits the landing-tick jump child.
- `pt1`: 264 per-tick one-change JUMPC arcs are added to every plain ground node.

The test was chained T-MOVES (`movecheck.js --chain=4`: the goal is the support 4 moves ahead, 2.5 s each, every 24th
start, 5 shards per variant):

| variant | chains | covered (the support 4 moves ahead in <= route ticks) | found at all | median expanded |
|---|---:|---:|---:|---:|
| base (f6911f4) | 803 | 34.2% | 49.7% | 2,680 |
| + hop | 803 | 34.6% | 48.8% | 2,496 |
| + hop + pt1 (264 blind JUMPC macros per ground node) | 798 | **29.1%** | 41.2% | **829** |

Paired over the same chains, hop against base: covered 34.6% against 34.2% (18 chains only hop covers, 15 only base
covers). Of the 381 chains both found, hop was faster in 57 and base in 30. The mean was +0.56 ticks for hop, because
the anytime A* stops at its first route within budget.

**Reading.** The chained search is limited by its budget: half of the 4-move chains are not found at all in 2.5 s.

- The hop child costs nothing measurable and wins more head-to-head chains. Its value, though, is at the optimum:
  62% of hop moves need it, at least 1 tick each. It pays when the leg search converges (the w = 1 pass, a proven leg),
  not in a greedy first find.
- Adding every per-tick arc as a plain macro is harmful. The branching of a ground node goes from about 30 to about
  290, A* expansions drop 3.2x and chained coverage falls from 34.2% to 29.1%.
- **Per-tick arcs must be generated lazily**: the RUN / IDLE / JUMP grid first, then the per-tick refinements of the
  best-bounded arcs only (ordered by bounds.js / the tables' predicted landing, or on demand when a leg is proven
  unreachable within the grid), with prefix sharing.

## 7. Five instructions for the integrator and the iterate lanes

1. **Add the HOP to every arc edge.** When an edge ends on a landing, also emit the child that restores the
   pre-landing snapshot and plays the landing tick with `mask | 1`. A node launched by a hop starts its arc with the
   macro's tail (no press). The ready-made patch is `prims_patch.js hop`.
   - 53.5% of real landings are hops and 189 of 218 routes use them.
   - Without the hop, 62% of hop moves are late: 53% by exactly 1 tick, 8% miss entirely. That is at least 0.7% of the
     run at the median and 3-4% on Forgotten Veil. The exact coverage of hop moves by one macro is 0%.
   - In the prototype it is neutral to positive when chained (34.6% against 34.2% covered, 57 against 30 chains faster).
   - It is general, exact and costs 1 tick per landing edge.
2. **Add per-tick arc timings, including the late hold, but LAZILY.** Keep the grid macros as the first children. Add
   the one-change refinements (d0 ∈ {-, L, R} from the press, d1 from any tick c <= A = 43, played as prefix chains)
   only for the best-bounded arcs, or on demand when a leg is not found or not proven within the grid. Add F2 for
   walk-offs.
   - 90.8% of the routes' change points are exact only at their own tick.
   - Half of the one-change timings are at c = 1, and the most common shape (press with no direction, the direction
     from the next tick) is in no builder macro.
   - Class-level coverage: F1 96-97% (jump, hop), F2 99%; fall 87.3% with F1, 93.8% with F2.
   - Measured: all 264 arcs at every ground node cut A* expansions 3.2x and chained coverage from 34.2% to 29.1%.
3. **Keep exact states and no exact tables.**
   - A node is its full stateHash. Never quantise positions or speeds: px is an integer in only 9.7% of ground starts,
     and a 1e-9 px difference survives to the next support in 72% of moves.
   - `support()` and the other class keys are for ordering and opt-in dominance only, never for proofs.
   - tables.js is for bounds and candidate order only. An F1 table would hold about 4e7 arcs per level and would still
     not be exact.
4. **Fields and arrows are 52% of route time and the weakest class.**
   - Use HOLD chains over all 9 non-cancelling masks, not the start state's probe set: the gravity turns inside a move.
     F1 on arrow moves goes from 43% (probe set) to 61.5% (9 masks).
   - Stop at every tick up to 16, then at the gravity-change, field-entry and field-exit events.
   - Add a held-jump variant: it is essential in 4,914 arrow and 558 dot moves (the held re-jump timer).
   - T-MOVES today: arrow 72.0% and dot 75.0% covered, against 93-99% on plain moves. The iterate lanes should work
     here first.
5. **Gate every family change on T-MOVES plus moves.js.**
   - Run `node src/plan/understand/movecheck.js --plan=<tree>/src/plan --shard=i/16 --every=8 --ms=1500` (about
     6 min on box 3, 16 shards), then `--agg`. Baseline f6911f4: 87.2% overall.
   - `moves.js` gives the exact coverage of the family. Baseline: jump 34.2%, hop 0.0%, fall 36.5%. With 1 and 2 it
     should reach about 71%, 70% and 46%+.
   - A change that lowers either number is a regression.
   - The compile's legs stay exact because every edge is an engine replay. The class numbers only measure how well the
     planner can reach things.

## Reproduce

```
EEAT_TRUTH_ROOT=<checkout with src/jobs + src/out/god> node src/plan/understand/moves.js --shard=i/16 --out=<dir>        # exact study (~1 min on 16 threads)
EEAT_TRUTH_ROOT=... node src/plan/understand/moves.js --cls=9 --shard=i/16 --out=<dir2>                                   # class-level F0/F1/F2 (~6 min)
node src/plan/understand/moves_agg.js <dir> ; node src/plan/understand/moves_cls_agg.js <dir2>
EEAT_TRUTH_ROOT=... node src/plan/understand/movecheck.js --shard=i/16 --every=8 --ms=1500 --out=<dir3>   # T-MOVES, run from a tree with the builder's prims.js
node src/plan/understand/movecheck.js --agg=<dir3>
```
