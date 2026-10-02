# THE HYBRID, lane "race" (branch n5-hy-race): the compiler and the search side by side on one level

Box 9 (8x A100-40GB, EPYC 7K62), this lane's share: GPUs 6-7, at most 45 threads, 120 GB. 2026-10-01, 13:00-15:30 EDT.
Branch `n5-hy-race` from main 7cab8c6:
- bd59a5b: the tool;
- 9621ce7: when the compiler ends, its workers go to a prefix search;
- 1647af6: no job retry after the import refused a route;
- 2b3abcc: a route after the end updates the final.

## Summary

- **Routed.** On the 16 test levels at 600 s, the hybrid routed 12. The search alone, on the same box at the same time,
  routed the same 12. The 4 levels that neither product routes were still not routed by either.
- **9 more levels that neither product routes at 300 s, run at 900 s: the hybrid routed 5.**
  - 4 of the 5 routes came before 600 s. The search alone (S600, 600 s) routed 1 of those 9 (The Tunnels, at 427 s).
  - The compiler alone (the 900-s scoreboard, 04ecf95) routes 3 of the 9, at 629-838 s.
  - **3 of the 5 came from the hybrid's hand-overs between the two sides.**
- **The feed back (the search's nearest attempt to a stuck compiler) routed 2 levels.** In both, the compiler had
  stalled. The hybrid gave it the search's nearest attempt, and the compiler built its route on top of that attempt:
  - Escape the Lava at 189 s. The search alone (v1.7.1, 600 s) does not route it. The compiler alone (900 s) routed it
    in 1 of 2 runs, at 838 s.
  - The Tunnels at 352 s. The search alone took 427 s. The compiler alone (900 s) took 629 and 694 s.
- **The hint (the compiler's furthest anchor to a stuck search) routed 1 level.** On Toad Town Tunnels, the hint started
  an escape at 639 s. It came from the compiler's anchor with 36 coins at 32,473 ticks. That escape found a route of
  35,801 ticks at about 796 s, and the main search found one of 38,190 at the same moment. The search alone (S600) is
  103.8 tiles short at 600 s. The compiler alone does not route it at 300 s or 900 s.
  - The other 27 hints (28 in all, every one an escape) found nothing.
- **First route.** The hybrid's first route is the earlier of the two sides. The compiler came first on 2 of the 12
  levels routed at 600 s:
  - Lab of Insanity: 46.5 s, against 75.4 s for the hybrid's own search (the search alone: 65.7 s and 72.3 s).
  - Just One More Time: 73.2 s, against 123.4 s (the search alone: 168.5 s and 241.5 s).

  Across the 12 levels, the median first route was 49.3 s for the hybrid and 60.2 s for the search alone (geometric
  mean ratio 0.84). Most of that difference is the search's own spread between runs, not the compiler.
- **Polish.** From its first route to the final at 600 s, the hybrid saved 13-63% (median 38%). Against the search alone
  at 600 s, the final run ticks have a geometric mean ratio of 0.87: 7 levels better, 5 worse.
  - It beat the best known TAS on all 6 levels that have one, for example Perilous Endeavor 2,910 against 2,976, and
    INFINITE 3,528 against 5,063.
  - The joins (the compiler's perfect pass, run on any route) gave the final route on 2 levels: Spidey's Abode -794
    ticks and INFINITE -142.
- **Verified.** Every final route was replayed from the level file by src/eesim.js (tools/cmp/verify.js): 12 of 12 at
  600 s and 5 of 5 at 900 s. The search-alone baseline's 12 routes were checked the same way.

## What tools/hybrid.js does

`node tools/hybrid.js <level.eelvl> --seconds=600 [--gpu=<id>] [--out=<dir>] [--cworkers=3] [--sworkers=4] [--stallS=60]`

1. **Both sides start at once.**
   - The compiler runs as a child process: `compile.js --json --stdin=1 --sourceDist=1`. Its budget S is set so that S
     plus its stages after the moves (joins, loops, endgame) end 15 s before the hybrid does: 455 s at 600 s, 755 s at
     900 s.
   - The search runs in the same process: the AutoTASer (`autotas.js` run), the same code that `atrun.js` and the
     117/203 sweep use. That is Find a route on `--sworkers` CPU workers plus the GPU, then a job at the first route and
     its optimizer (the grind, with the GPU searcher). It runs in its own EEAT_HOME.
2. **Every route is replayed before it counts.** That covers both sides, the optimizer's bests, the prefix search and
   the joins. The replay is `common.evaluate` on `plan/types.js loadLevelFile`, the same loader verify.js uses.
3. **The first verified route, from either side.**
   - A compiler route goes to the AutoTASer through the new `autotas.js outside()`. With no job yet, it becomes the
     job's base and the optimizer starts on it at once. Otherwise it goes to the job's inbox, and the grind judges it
     or splices it.
   - Every faster route, and every faster job best, bounds the compiler's branch and bound (stdin `route`).
4. **The stall hand-over (the hint).** The compiler counts as stalled when, with no route yet, it has no new furthest
   anchor for `--stallS` (60 s). A new furthest anchor is one with a higher gain, or the same gain and 3 tiles nearer.
   - When it stalls, its furthest anchor's inputs go to the search through the new `editor.js hint()`. They go into
     the CPU search's archive (import or seed). On coarse-cell levels, the search's next stall escape (a fresh one
     search with GPU bursts) starts from there at once.
   - On fine-cell levels there is no escape, so the hybrid runs its own `goexplore.js --prefix` search.
   - When the compiler ends without a route, its 3 workers run a prefix search of the hybrid's own from that anchor.
5. **The feed back.** While the compiler is stalled, the search's nearest attempt goes to the compiler (stdin `import`).
   A model state the compiler has not seen becomes an anchor it plans from. This happens at most every 20 s, and each
   attempt sent must be at least 1 tile nearer than the last.
6. **The polish.**
   - The job's grind runs all the way to the end.
   - The compiler runs its own perfect pass on its own route.
   - Once the compiler has ended with at least 45 s left, `tools/perfect/joins.js` runs on the best route so far, and
     the result goes to the job. A compiler with no route of its own is stopped 90 s before the end to make room for
     this.
7. **The end.**
   - The best verified route of all is written to `<out>/best.eetas`, read back and replayed.
   - `<out>/hybrid.json` records who routed first and when, every route, the hints, the feeds, the prefix searches, the
     joins, and the ticks before and after the polish.
   - Exit codes: 0 routed, 2 no route.

Changes outside the tool:
- `autotas.js`: `run()` returns `outside(masks, source)`.
- `editor.js`: `hint(inputs, what)`. `escPick` takes the hint first, and `escLaunch` keeps the rotation where it is.
- `compile.js`: `--stdin=1` and `--sourceDist=1`.
- `strategy.js`: the 'source' events carry the anchor's gain (`again`).

All of these are additive. Nothing changes unless the hybrid calls them.

## The test

- **Hybrid.** 600 s a level, 2 at a time, one per GPU (lanes `lane.sh`). Each run used 3 compiler workers and 4 search
  workers. Peak was about 14 GB RSS a run. The orders are in `race_levels.txt`.
- **The search alone (my baseline).** The same 16 levels on the same box at the same time: `atrun.js` from main 7cab8c6,
  W5, 600 s, findS 600, one per GPU. Each GPU therefore held one baseline search and one hybrid search, so both arms
  shared their GPU in the same way.
- **Second search-alone sample.** The baseline lane's S600: v1.7.1 3755116, W5, 600 s, optS 30. Only its first-route
  times are comparable, because optS 30 means its finals are not.
- **Earlier data.** The compiler at 300 s (`AB.jsonl`) and the search at 300 s (relab main 72d8355).
- **The choice of levels.** 6 that the compiler routes at 300 s. 6 that only the search routes at 300 s, with fast,
  medium and slow first routes. 4 that neither routes, chosen where the search gets within 1.4-7.4 tiles.

### 16 levels at 600 s

| # | level | class (at 300 s) | hybrid: first route (by, s, ticks) | compiler's first (s, ticks) | the hybrid's search first (s, ticks) | hybrid final at 600 s | first -> final | search alone 600 s: first (s, ticks) / final | S600 v1.7.1 first (s) | best known |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | VVVVVV | neither | none (compiler gain 23; search 1.4 tiles) | - | - | - | - | none (1.4 tiles) | none | - |
| 2 | Endeavor | neither | none (gain 10; 4.4 tiles) | - | - | - | - | none | none | - |
| 3 | LoZ Skyward Sword | neither | none (gain 5; 4.8 tiles) | - | - | - | - | none | none | - |
| 4 | The Tower Domination | neither | none (gain 2; 7.4 tiles) | - | - | - | - | none | none | - |
| 5 | Perilous Endeavor | search only | search, 24.0, 7,692 | - | 23.7, 7,692 | **2,910** | -62.2% | 22.6, 9,236 / 6,378 | 31.6 | 2,976 |
| 6 | EX Crew Odyssey | search only | search, 76.7, 5,589 | - | 76.2, 5,589 | **3,875** | -30.7% | 169.8, 7,954 / 5,160 | 65.8 | 4,678 |
| 7 | Lab of Insanity | search only | **compiler, 46.6, 7,412** | 46.5, 7,412 | 75.4, 7,034 | **6,459** | -12.9% | 65.7, 7,157 / 6,499 | 72.3 | - |
| 8 | Need for Steed | search only | search, 94.2, 4,446 | - | 94.0, 4,446 | **3,404** | -23.4% | 143.5, 4,774 / 3,587 | 102.4 | 3,727 |
| 9 | Spidey's Abode | search only | search, 217.8, 15,988 | - | 217.1, 15,988 | **13,055** (joins) | -18.3% | 196.1, 15,287 / 12,179 | 275.2 | - |
| 10 | KOcrew Creepy Cavern | search only | search, 155.0, 11,477 | - | 154.6, 11,477 | **8,824** | -23.1% | 72.0, 12,808 / 8,955 | none | - |
| 11 | Just One More Time | compiler | **compiler, 73.2, 3,252** | 73.2, 3,252 | 123.4, 2,982 | **2,488** | -23.5% | 168.5, 3,131 / 2,405 | 241.5 | - |
| 12 | Animaly | compiler | search, 13.5, 12,130 | 104.7, 5,700 | 13.2, 12,130 | **4,587** | -62.2% | 14.3, 12,095 / 4,503 | 9.6 | - |
| 13 | Level 1 Overworld | compiler | search, 52.0, 23,665 | 115.1, 12,556 | 51.3, 23,665 | **8,876** | -62.5% | 54.7, 21,453 / 9,507 | 52.7 | - |
| 14 | Ruins | compiler | search, 4.2, 2,510 | 14.0, 1,532 | 4.1, 2,510 | **1,148** | -54.3% | 10.2, 2,510 / 1,121 | 6.6 | 1,522 |
| 15 | Christmas Town | compiler | search, 23.9, 6,781 | 65.8, 4,594 | 23.5, 6,781 | **3,678** | -45.8% | 18.9, 9,402 / 3,473 | 53.4 | 6,340 |
| 16 | INFINITE | compiler | search, 10.4, 7,641 | 122.1, 5,566 | 10.0, 7,641 | **3,528** (joins on the compiler's 3,670) | -53.8% | 9.6, 9,263 / 7,124 | 8.9 | 5,063 |

- **Routed.** The hybrid routed 12 of 16. The search alone routed 12 of 16 (the same 12). S600 routed 11 of 16: it
  missed KOcrew Creepy Cavern, which the other two routed at 72 and 155 s.
- **First route, median.** Hybrid 49.3 s; the search alone 60.2 s. The geometric mean ratio of hybrid to search alone is
  0.84.
  - The compiler came first on 2 of the 12, beating the hybrid's own search by 29 s and 50 s.
  - On the 5 levels where the compiler routes at 300 s, the search came first: 4-52 s against the compiler's 14-122 s.
    The compiler's first routes there were much shorter, though: 0.47-0.73 of the search's first route.
- **Final at 600 s.** The geometric mean ratio of hybrid to search alone is 0.867. The hybrid was better on 7 levels:
  - Perilous Endeavor 0.46;
  - INFINITE 0.50, where the compiler's route and the joins did it;
  - EX Crew Odyssey 0.75;
  - Level 1 Overworld 0.93;
  - Need for Steed 0.95;
  - KOcrew Creepy Cavern 0.985;
  - Lab of Insanity 0.994.

  It was worse on 5: Spidey's Abode 1.07, Christmas Town 1.06, Just One More Time 1.03, Ruins 1.02 and Animaly 1.02.
  Perilous Endeavor and Odyssey are the search's own spread (no compiler route, no hint).
  - The losses are where the search led all the way. There the hybrid's optimizer had 4 workers against the
    baseline's 5, and the compiler held 3 more workers that bought nothing.
- **Polish from the first route, median -38%.** It was the grind on the job in every case, plus:
  - the joins: -794 on Spidey's Abode (13,849 to 13,055) and -142 on the compiler's INFINITE route (3,670 to 3,528), the
    final word on both; also -44, -10 and -3 on Creepy Cavern, Odyssey and Overworld, where the grind passed it later;
  - the compiler's own perfect pass on its own route.

### 9 levels at 900 s that neither routes at 300 s

All 9 levels are unrouted at 300 s by both the compiler (AB) and the search (relab, 2 arms).
- Pretty How Town and Escape the Lava were queued at 900 s twice. The first launch overlapped the 600-s batch's last
  pair and was stopped after 16-34 s.
- The search alone (S600) ran at 3 searches a GPU (the baseline lane's sweep). The hybrid ran at 1-2 a GPU.

| level | hybrid: first route | how | final at 900 s | first -> final | search alone (S600 v1.7.1, 600 s) | compiler alone (900-s scoreboard, 04ecf95) |
|---|---|---|---|---|---|---|
| Escape the Lava | **compiler, 189.4 s, 21,216** | **the feed back** (below) | **13,737** (5 deaths) | -35.3% | none (45.2 tiles) | 1 of 2 runs, 838 s |
| Polar Eclipse | search (path skips), 232.3 s, 16,091 | the search on its own (no stall, no hand-over) | **13,300** (the joins -304 on the way) | -17.3% | none (10.2 tiles) | none |
| The Tunnels | **compiler, 351.8 s, 42,985** | **the feed back** (below) | **39,551** | -8.0% | 427.1 s | 629 / 694 s |
| Pretty How Town | search, 554.5 s, 24,016 (the compiler 706.4 s, 18,167) | each on its own | **17,936** (the compiler's perfect pass; random portals, see below) | -25.3% | none (79.2 tiles) | 715 / 746 s |
| Toad Town Tunnels | **search, ~796 s: the hint's escape 35,801, the main search 38,190** | **the hint** (below) | **35,801** | - | none (103.8 tiles) | none |
| Hunt | none (compiler gain 8; 2 hints, 1 feed) | | | | none (24.6 tiles) | none |
| The Square | none (gain 2; 1 hint, 1 feed) | | | | none (10.2 tiles) | none |
| Nightmare Relics | none (gain 8; 4 hints, 1 feed) | | | | none (10.2 tiles) | none |
| ML's First Samurai | none (gain 4; 3 hints, 1 feed) | | | | none (17.4 tiles) | none |

**Toad Town Tunnels, the hint.** The compiler stalled 3 times. Its third furthest anchor (gain 41, 36 coins, 32,473
ticks) went to the search at 639.0 s, and escape 8 started from it at 639.2 s. Then:
- at 795.6 s that escape found a route of 38,196 ticks, cleaned to 35,801;
- at 796.2 s the main search, which had the anchor in its archive, found one of 38,190.

The AutoTASer's job import then blocked the hybrid's thread until 856 s. The 35,801 route reached the hybrid after its
end and was written to best.eetas. Its replay finishes at 35,801 (verify.js). At the time of the run, hybrid.json still
said 38,190; 2b3abcc fixes that.

**The feed back, measured (compile_events.jsonl).**
- **Escape the Lava.** The compiler stalled at gain 2 (tick 610) for 60 s.
  - At 74.3 s the hybrid fed it the search's nearest attempt: 13,675 ticks, 838.8 tiles out by the steer distance. That
    became the compiler's anchor 8.
  - From 85.4 s on, every new anchor descends from it (ticks 13,943 and up, gain 11 to 15).
  - At 189.4 s came the route, 21,216 ticks: the search's first 13,675 ticks plus the compiler's last 7,541.
- **The Tunnels.** The compiler stalled at gain 20 (12 coins, tick 10,584) from 205.7 s.
  - At 266.1 s the hybrid fed it the search's nearest attempt: 37,862 ticks, 107.4 tiles out.
  - Within 7 s the compiler had anchors past it, gaining from 29 up to 37.
  - At 351.8 s came the route, 42,985 ticks.

**Pretty How Town has random portals.** The AutoTASer's job import of the search's route ran rng.js's exit analysis for
131 s in the hybrid's thread, then refused the route: "no combination of exits lets it finish ... (outcome tree
truncated)".
- So that level had no optimizer job, and its final is the compiler's perfect pass.
- verify.js replays the route as finishing, under the simulator's own portal rule.
- Its chance in a real EEO play is unknown. The compiler's 900-s scoreboard counts the same level the same way.

## Problems found (and what was done)

- **A job import can block the hybrid's thread for minutes.** This is `jobs.importJob`'s random-portal analysis: 131 s on
  Pretty How Town, 59 s on Toad Town Tunnels. While it runs, the hybrid's clock stops, along with its hand-overs and its
  record of the routes.
  - Fixed in part. 1647af6: after an import refused a route, the hybrid does not try a job of its own again. 2b3abcc: a
    route that arrives after the end updates the final.
  - The AutoTASer's own import still blocks, because `importJob` is synchronous. A worker thread for it would fix the
    rest.
- **The hint's anchor can be trivial.** On Need for Steed it was gain 2 at 54 ticks; on Toad Town Tunnels the first was
  gain 2 at 122 ticks. A hint costs one escape turn: at least 120 s of half the search's workers. A minimum depth (say
  1,000 ticks, or ahead of the search's own longest attempt) would avoid this.
- **The 600-s "first route" on Pretty How Town** says 685.9 s in hybrid.json, because of the blocked import. The search
  found it at 554.5 s (search_timeline.jsonl).

## The path to every level (from this run)

1. **The feed back is the hybrid's real gain.** The search reaches far states the compiler does not. Given one, the
   compiler plans the rest with its exact legs.
   - Feed earlier and wider: not only after a 60-s stall and not only the nearest attempt. Each room's first arrival
     (editor `sources`), each new room, at most every 20 s, from the start.
   - Then run the hybrid on every level the compiler fails: 183 levels, 116 of them with no progress after about 600 s.
     Measure it against the S600 search-alone sweep (the baseline lane's results.jsonl) and the 900-s compiler
     scoreboard.
2. **The hint (compiler to search): 1 route from 28 escapes** (Toad Town Tunnels). It costs escape turns that the
   search's own rotation would otherwise use. A/B it with `--hint=0` on the 13 "neither" levels at 900 s before
   claiming more.
3. **CPU split after the first route.** When the search's route already leads, the compiler's 3 workers could go to the
   grind. Its own route rarely beat the grind's 600-s best: once on 12 levels, on INFINITE.
4. **The 8 levels still unrouted.** At 600 s: VVVVVV, Endeavor, LoZ Skyward Sword and The Tower Domination. At 900 s:
   Hunt, The Square, Nightmare Relics and ML's First Samurai.
   - The compiler got as far as gain 23 / 10 / 5 / 2 / 8 / 2 / 8 / 4.
   - The search got within 1.4-24.6 tiles. VVVVVV's 1.4 tiles is a false near.
   - They need the wider feed back (item 1) and longer runs.
5. **Same-condition repeats.** Each level here is one sample. The search's own spread is large: first routes differ by
   2x between runs, and S600 missed Creepy Cavern, which the other two runs routed at 72 and 155 s. Before a ship, run
   two samples of the hybrid against the search alone on the 25 levels above.

## Files

- **Box 9, results:** `~/hy_results/race/` (18 MB), the same as the laptop worktree's `src/out/n5/hybrid/race/race/`:
  - `b600/<id>/`, `x900/<id>/`, `n900/<id>/`: hybrid.json, hybrid.log, compile.json, best.eetas, search_timeline.jsonl;
  - `base/<id>/`: the search alone, result.json and final.eetas;
  - agg.jsonl (600 s), agg900.jsonl and aggn900.jsonl (900 s), s600_16.jsonl.
- **Box 9, the full runs:** `~/hy_race_out/`.
- **Scripts** (`src/out/n5/hybrid/race/`): hy1.sh (one run), lane.sh / lane2.sh (the batches), agg.js, report.js (the
  600-s table), cand.js.
- **Verification** (`node tools/cmp/verify.js <dir> ~/lv/lv230`):
  - `~/hy_race_out/V`: 12 of 12 ok;
  - `V9` (x900): 3 of 3 ok;
  - `VN` (n900): 2 of 2 ok, with Toad Town Tunnels' report set to 35,801;
  - `VB` (the search alone): 12 of 12 ok.
