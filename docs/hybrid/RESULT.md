# THE HYBRID, measured on all 230 levels (n5-hy-best, box 9, 2026-10-01)

**H routes 128 of the 230 levels in 71 minutes on the whole box.** Every route was replayed from its level file by
`tools/cmp/verify.js`, and all 128 finished at their run ticks.

- **Against the compiler alone (C):** 47 routed, so H routes 81 more and loses none.
- **Against the search alone at 600 s (S):** H routes fewer, 128 against 137.
- **Against C and S combined:** H routes fewer, 128 against 144.
- **Route quality:** H's routes are the best of all the arms.
  - 33 are at or under the best known TAS, against 29 for C and S combined.
  - Where both routed, H's route is faster than the better of C and S on 75 levels and slower on 49.
- **Why H routes fewer than S:** fitting 230 levels into about an hour meant 24 levels at once. Each of H's searches
  got about half the CPU that S's searches had.
  - Where both routed, H's first route came later: median 128.6 s against S's 53.4 s.
  - S routed 20 levels between 120 s and 565 s that H did not route within its 600-s cap or its stall rule.

## What ran

- **The candidate:** branch `n5-hy-best` = origin/main 7cab8c6 + n5-hy-leg c8b84fa + n5-hy-race 9da23c1, with these
  additions:
  - **The leg hybrid inside the race driver:** `tools/hybrid.js --leg=1`, the default, so the race driver's compiler child
    runs with `EEAT_HYBRID=1`.
  - **The early stops:**
    - `--polishS=120`: a level ends 120 s after its first verified route. Once a route is known, the compiler, if it has a
      route of its own, gets `stop` 75 s before that end so its own stages can polish its route.
    - `--stallStopS=180`: before any route, a level ends after 180 s with no progress. Progress is any of:
      - a new furthest compiler anchor;
      - a search attempt a tile nearer the trophy;
      - a new search room that opens territory;
      - more coins or switches on the search's progress front.
  - **The batch driver:** `tools/hybrid_batch.js`. It runs a level on whichever GPU has the fewest levels, and starts a new
    level only while load and free RAM allow. It is resumable, and it can adopt the running levels of a killed batch.
  - **Code:** 776d377 and dca1ba5 on the box. The batch was restarted once, 6 minutes in, to raise its load gate; it adopted
    the 20 levels that were running.
- **Per level:**
  - the compiler W2 (`--cworkers=2`) plus its leg searches (goexplore, W2, with GPU bursts);
  - the search product W3 (`--sworkers=3`): Find a route, then a job and its optimizer on the GPU;
  - a 600-s cap. Bad EE Level 9 and Cold World were started first, with a 1,800-s cap and a 300-s stall rule.
- **Concurrency:** 24 levels at once (3 per A100) with a 1-minute load gate of 330. The load ran at 300-360 on the
  container's 184 CPUs, and 120-195 GB of RAM was used.
- **Time:** 20:07:36 to 21:18:32 UTC, 70.9 minutes for all 230. The levels used 96,352 seconds in total, median 416 s each.
- **The order:** the levels expected to take longest went first (`docs/hybrid/mklist.js`).
- **The references:**
  - **C:** this morning's paired 300-s compile of main, the B arm of `src/out/n5/lasthour/ship/AB.jsonl`.
  - **C900:** C plus the 15 levels that the 900-s scoreboard `src/out/n5/b8/score900_04ecf95.md` routed, at their best route.
  - **S:** the baseline's search alone on box 9: v1.7.1, findS 600, three searches a GPU, W5, on 213 levels. It did not
    run the last 17 hard levels.
  - **Quality:** run ticks divided by the best known (`AB.jsonl` `best`).

## Count

| arm | all 230 | campaign 203 | hard 25 | d4 2 | on the 213 S ran |
|---|---|---|---|---|---|
| **H (the hybrid, early stops)** | **128** | 113 | **15** | 0 | 119 |
| C (compile 300 s) | 47 | 39 | 8 | 0 | 40 |
| C900 (C + the 900-s scoreboard) | 61 | 53 | 8 | 0 | 54 |
| S (search alone 600 s) | 137 | 130 | 7 | 0 | 137 |
| C u S | 144 | 130 | 14 | 0 | 137 |
| C900 u S | 146 | 132 | 14 | 0 | 139 |

| H vs | gained (H routes, it does not) | lost (it routes, H does not) | net |
|---|---|---|---|
| C | 81 | 0 | +81 |
| C900 | 70 | 3 (Pretty How Town, The Tunnels, Ring Of Chaos) | +67 |
| S | 11 (9 on hard levels S did not run) | 20 | -9 |
| C u S | 4 | 20 | -16 |
| C900 u S | 3 | 21 | -18 |

- **Routed by H and by neither C nor S (4):**
  - Planets: 8,179, first route at 328 s.
  - Escape the Lava: 19,756, first route at 508 s.
  - My level de42c861: 142, first route at 76 s. S did not run it.
  - NC Naos Antediluvian de5f2cef: 9,801, first route at 422 s. S did not run it.
- **Routed by S and not by H (20).** S found these at 120-565 s.
  - **H ran to its 600-s cap (14):** Mount Uonegatscil, Spring Rose, Evolution Revolution, Good Egg Galaxy, MYSTERY
    MANSION, Ethereal Ground, The Tunnels, hakashouseoffun, Not Enough Skeletons, Ring Of Chaos, Desolate Helix, NC Naos
    Antediluvian (the campaign copy), I Crew Persian Peril, NSFW Skypolis.
  - **H's stall rule stopped them (6):**
    - Imps Paradise: S 120.7 s.
    - This is not snow: S 294.2 s.
    - Spidey's Abode: S 275.2 s.
    - Be gone.: S 523.3 s.
    - Bad EE Level 8: S 330.6 s.
    - EXPro Forgotten Veil: S 385.2 s.
- **The compiler inside H** made a route of its own on 58 levels, with a median first route of 89 s. On 17 of them the
  300-s compile alone had no route: Tutorial #3, Unforgiving Climb, Longing To The Sky, Perilous Endeavor, the cake is a
  lie, One Minute Descent, Operation Planet X, MMBA Skull Citadel, Terror In The North, Ice Slide Ride, The 7 Depths of
  Hell, Aedan Garden, Sentinel Ravines, Eurus, UT Eternal Galaxy, EX Crew RR, My level de42c861.

## Quality (run ticks divided by the best known)

| arm | routed with a best known | median | geo mean | at / under the best known | within 5% |
|---|---|---|---|---|---|
| **H** | 85 | 1.043 | **1.081** | **33** | **46** |
| C | 43 | 1.110 | 1.117 | 11 | 18 |
| C900 | 48 | 1.111 | 1.122 | 13 | 20 |
| S | 76 | 1.060 | 1.140 | 25 | 35 |
| C u S | 83 | 1.040 | 1.098 | 29 | 43 |
| C900 u S | 83 | 1.039 | 1.080 | 30 | 44 |

| head to head, both routed | levels | geo H / ref | H faster | ref faster | tie |
|---|---|---|---|---|---|
| C | 47 | **0.948** | 29 | 18 | 0 |
| C900 | 58 | 0.955 | 35 | 23 | 0 |
| S | 117 | **0.949** | 78 | 38 | 1 |
| C u S (the faster of the two) | 124 | 0.981 | 75 | 49 | 0 |
| C900 u S | 125 | 0.994 | 72 | 53 | 0 |

- **Who found H's routes:**
  - First route: the search 91, the compiler 34, a prefix search from the compiler's furthest anchor 3.
  - Final route: the search's optimizer 58, the search 50, the joins pass 18, the compiler 2.
  - The joins pass shortened the final route on 56 levels. The largest gains: The Ten Commandments -835, Unforgiving
    Climb -987, Water Levels -743.

## Time to the first route

| | levels | median s | p90 s |
|---|---|---|---|
| H | 128 | 122.5 | 413.4 |
| S | 137 | 72.3 | 322.0 |
| H, on the 117 both routed | 117 | **128.6** | 404.7 |
| S, on the 117 both routed | 117 | **53.4** | 219.6 |

- **Why H's first route is later:**
  - H's search had W3 against S's W5.
  - It shared about 7.7 busy CPUs per level with the compiler, the leg searches and the optimizer. S's searches ran 12 at a
    time, at about 6.5 cores each.
  - In the race test at 16 levels with more CPU (`src/out/n5/hybrid/race/race.md`), the hybrid's first route came before
    the search alone's: median 49 s against 60 s.
- **C's first-route times:** AB.jsonl records only the compile's wall time, so there is nothing to compare here.

## Stop reasons (logged per level in `H_results.jsonl` `stop` / `lastProgress`)

| stop | routed | not routed |
|---|---|---|
| polish: 120 s after the first route | 119 | - |
| cap: 600 s, or 1,800 s for the d4 levels | 9 | 68 |
| stall: no progress for 180 s, or 300 s for d4 | 0 | 34 |

- **Stall-stopped levels (34), candidates for a longer rerun:**
  - Phina and the Rose, Springopolis, NSFW Spring Relics, Toad Town Tunnels, The Square, Snake Snake SNAAKE, Weird World,
    LOEE Demonic Citadel.
  - **Imps Paradise**, **This is not snow**.
  - Rotcil Illusions, The Torava Disaster, NSFW City of Avalon, Nirthophia, Desolate Relics, Tropical Trials, Beat the
    Spikes 2, Cold World (campaign).
  - **Spidey's Abode**.
  - Dreamland, MegaMan Dash, Into Magma Panic, Floating Temples, The Tower Domination, MoonBase, Starlight.
  - **Be gone.**, **Bad EE Level 8**.
  - cold_world (d4).
  - **EXPro Forgotten Veil**.
  - Good Egg Galaxy (hard), Infinity Pain (hard), Stupid Fox (hard), Wine Quest I.
  - The six in bold were routed by S, so the 180-s rule ended them too soon.
- **The d4 pair:** neither was routed.
  - Bad EE Level 9 ran to the 1,800-s cap: 25.2 tiles from the trophy, compiler gain 20.
  - Cold World was stall-stopped at 1,784 s: 35.4 tiles from the trophy, gain 0.

## Verdict

- **Against the compiler:** the hybrid is a clear gain. It routes 128 levels against 47 at 300 s and 61 at 900 s, loses no
  level C routes, and its routes on the 47 shared levels are 5.2% shorter (geometric mean).
- **Against the search alone:** at this box-filling setting the hybrid routes fewer levels, 128 against 137 (119 against 137
  on the levels S ran), but its routes are better.
  - Its routes are 5.1% shorter on the 117 levels both routed, and shorter on 78 of them against 38.
  - 33 of its routes are at or under the best known, against 25 for S.
  - The count loss comes from the CPU share: H got about half of S's CPU per level, and its first route came 2.4x later
    (median 128.6 s against 53.4 s).
- **Against C and S combined:** 128 against 144, but the best route quality of every arm. 33 routes are at or under the
  best known, against 29, and H's route is faster than the better of C and S on 75 of 124 levels.
- **The path to more levels:**
  1. **Give the search its full share.** Run H at about 12-14 levels at once on this box, matching S's per-level CPU. That
     takes about 2 h for the 230 instead of 71 min.
  2. **Rerun the stall-stopped and capped levels longer.** These are the 34 stall-stopped levels and the 68 unrouted capped
     levels.
  3. **Widen the stall rule to about 300 s.** The 180-s rule ended 6 levels that S routes.

## Files

- **Committed here:**
  - `docs/hybrid/RESULT.md`: this report.
  - `docs/hybrid/H_results.jsonl`: one line per level with the stop reason, first and final route, the compiler's and the
    search's numbers, and the leg hybrid's stats.
  - `docs/hybrid/rows.jsonl`: the per-level comparison rows for H, C, C900, S and C u S.
  - `docs/hybrid/verify.txt`: the replay log.
  - `docs/hybrid/tables.md`: the tables above, as `compare.js` prints them.
  - The tools that made them: `mklist.js`, `collect.js`, `compare.js`, `summary.js`.
- **On box 9:**
  - `~/hy_results/measure/`: `H_results.jsonl`, `verify.txt` and `eetas/` (the 128 verified routes, each `<rel with __>.eetas`
    with its `.json` run ticks).
  - `~/hy_measure_out/H`: the run directories with `hybrid.json` and `hybrid.log`, plus `batch.log`.
