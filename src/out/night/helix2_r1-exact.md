# Forgotten Helix round 2, lane r1-exact: coin 4 settled with exact searches (2026-09-28, 04:33-05:40 EDT)

Branch `hx2-r1-exact` (= origin/main f8c229c + this note). Scripts (git-ignored scratch): the worktree's `src/out/hx2/`
(`flight.js`, `scan.js`, `shaft2.js`, `flood.js`, `climb.js`, `probe.js`, `ascii.js`, `fx.js`, `events.js`), logs
`scanA_*.log`, `scanB_*.log` there and in `src/out/night/fetch/helix2/r1-exact/`. Laptop CPU only (<= 5 processes); no
GPU, no remote machine: none of the questions needed one.

## Headline

**Coin 4 of Forgotten Helix is out of reach in the engine, and so is every 4th coin (no route: routed = false).** The
round-1 "~1 px/tick" margin was measured against a fall speed the level cannot produce; with exact searches:

| quantity | exact value |
|---|---|
| fall speed into (249,123) needed for the flight (96,125) -> ceiling portals (74-76,125) | **>= 9.08 px/tick** (the least that works on a 0.02 grid; round 1's 4-policy grid said 9.5) |
| the most the shaft can give, even entering the arrows at the 16 px/tick cap | **8.626 px/tick** (vs 9.08: short by 0.45) |
| what the real approach gives (the jump from the corridor floor onto the arrows: S 8.14 into (108,128), U 11.70; round 1's fine-cell best U 11.69-11.72) | **~6.3 px/tick** (short by ~2.8) |

So the ball is short even at the engine's speed cap; the real margin is ~2.8 px/tick of fall speed (~4 px/tick of exit
speed), not a sub-pixel line. No precision trick (spike hitbox, sub-pixel entry, timing, macro-moves) closes a gap of
that size, and no effect, death or coin order opens another way (below).

## 1. The only way to a 4th coin at 3 coins: the pad and the ceiling portals (74-76,125)

`flood.js`: tile connectivity from the spawn at 3 coins, OPTIMISTIC (gravity ignored, every switch / team door open,
diagonal moves past spike corners (not past solid corners), portals followed, coin doors open at coins >= n):
- coins 1-3 are (26,70), (79,80), (13,110) (doors 1, 2, 3 at (32,71), (27,109), (68,102));
- with the ceiling portals (74-76,125) and the pad (74-76,128) removed, **no other coin is reachable** (all 12 others,
  and the fly effects (209,123) / (234,133) / (281,119) and the fly-off (184,95), are cut off at 3 coins);
- so "any 4th coin opens door 4" does not help: every 4th coin is behind (74-76,125) -> (2,197).
- no portal targets the ceiling portals' id: the only way in is the corridor rows 126-127 (spikes above at row 125
  x 77-84, below at row 128 x 77-85; the pad is boxed by spikes 71-73 and the wall x 70).

## 2. The flight, exact (`flight.js`)

The ball enters (249,123) (the engine's own teleport: rotation 0 -> 1, x1.42; the exit tick moves x by the OLD fall
speed and keeps the old y step, so the ball also drops by vyIn in that tick). From the exit, an **exhaustive DFS over
every input sequence** (in the air L / none / R, on the ground also the three with jump; exact states, no merging,
duplicates by `stateKey`), goal = the portal event to (2,197). Sound pruning only: dead; seen; and, in free flight with
vy >= 0 (the height is then the same for every input: checked bit-exactly in the rollouts, else no prune), the x
envelope (all-left = least x, all-right = most x; x is monotone in the inputs; rollouts with protection on) against the
spike rows tick by tick and the landing row (only the pad goes on; a landing on the safe floor 86-91 is a new cycle,
section 4). The spike hitbox (centre tile only, once a tick before movement) is the engine's own.

- `scanA` (vyIn 6.0-9.0 step 0.1, vxIn -5..3 step 0.1, py fraction 0 / 0.25 / 0.5 / 0.75: **11,284 entry states, every
  DFS complete (none capped): 0 reach the portals**).
- The first successes (scanA, vyIn 9.1-9.7): e.g. vyIn 9.1, vxIn -1.6, fraction 0.25: exit (-13.04, -2.02) px/tick,
  inputs L x25, then on the pad none, R+J, R ... (brake, jump into (74-76,125)); replayed in a fresh engine
  (`verify1.js`): tick 37 portal (74,125) -> (2,197), alive. 123 successes in 9.1-10.4 (the scan was stopped there).
- `scanB` (the threshold, fine): vyIn 8.30-9.10 step 0.02, vxIn -3.2..-0.4 step 0.02, py fraction step 1/8: **46,247
  entry states, 0 successes with vyIn <= 9.06 (every DFS complete, none capped)**; successes only at vyIn 9.08 (2: vxIn
  -1.78 / f 0, vxIn -1.62 / f 0.875) and 9.10 (4); 1 capped state (vyIn 9.10). ~22 min on 5 laptop processes.
- The upward exit (vxIn < 0 -> vy_out = 1.42 vxIn) is what makes 9.1 enough: the ball hangs under the ceiling (90-96,124)
  and its apex moves left; with vxIn = 0 the apex is at the exit and even 13+ fails.

## 3. The shaft, exact (`shaft2.js`)

The ball on the arrows (row 128, x 97-107) at s0, the engine plays the arrows, (108,128) -> (251,125), the rise and
the fall; vyIn = the fall speed at the start of the first tick whose centre is in row 123. **The height does not depend
on the inputs**: for every s0, 200 random L / none / R sequences give bit-identical heights (horizontal gravity on the
arrows: L / R do nothing there; in the shaft only walls touch the ball, which zero vx only).

| arrow entry s0 (px/tick) at x 100 | U out of (251,125) | apex row | vyIn at row 123 |
|---|---|---|---|
| 0 | 9.30 | 118.8 | 5.06 |
| 5 | 10.06 | 117.9 | 5.43 |
| 8 | 11.63 | 115.8 | 6.27 |
| 12 | 14.60 | 111.6 | 7.46 |
| 16 (the speed cap) | 18.11 (first tick; capped to 16 after) | 106.2 | **8.63** |

Entering at x 97 or 107 instead: at most 8.626 / 8.551. The shaft's top portals (249-251,94) would reverse and amplify
(x1.42 downward) but need an apex above row 95 (U ~ 20+). The ball reaches the arrows only from the corridor floor
(86-91) over the spikes (92-96,128) (a run of <= 6 tiles; on the arrows L / R do nothing: horizontal gravity): the
probe run right 30 ticks + jump gives S 8.14 into (108,128), U 11.70 -> vyIn ~6.3.

## 4. Deaths, checkpoints and effects

- **Checkpoint (88,128)** (on the corridor floor, touched on the way in): a death there respawns the ball at rest on
  the floor, 55 ticks later, static effects kept (eesim.js `respawn`). From the floor: a jump without the ceiling rises
  63.4 px (apex y 1992.6): the ball must stay at x >= 1360 for ~29 ticks while above row 126, then falls through row
  126 at ~3.4 px/tick and has ~7 ticks to cross the 128 px of floor spikes (> 16 px/tick: impossible); a jump under the
  ceiling (90-96,124) stops at y 2008 and then needs > 13.6 px/tick (the floor gives <= ~4.5; a landing from the flight
  <= 1.42 x 8.63 = 12.25). So the respawn gives nothing the floor does not already give. (The floor case is this
  kinematic bound, not the exact DFS: floor states make the exact DFS explode.)
- **Low gravity** (the "lowgrav coins=3" room): the only low-gravity-on tile at 3 coins is (94,79); the only way on to
  the corridor passes (135,142), a low-gravity-OFF tile in a 1-tile-high passage (solid above and below, x 133-136);
  the centre moves <= 16 px a tick, so it is always in that tile once. Flood with (135,142) removed: the corridor is cut
  off. Carrying it through a death needs a checkpoint past the passage touched before retaking (94,79): from the
  respawn at (129,144) (just past the passage) a BFS (`climb.js`, 1 px / 1/16 cells, 14 inputs, 700 ticks: evidence)
  never gets east of the passage (left arrows push into it; the way back up is a 60-row spike channel with no floor).
  With low gravity the corridor WOULD be easy (from the checkpoint a jump bumps the ceiling at x 90 and drifts left
  under 0.15 gravity) - but it cannot be there.
- **Fly** (levitation, holds its thrust through deaths): (209,123), (234,133), (281,119) are unreachable at 3 coins.
  Protection (394,72), run (36,153 / 284,62), multijump (61,164 ...) likewise, or behind coin 4.
- **Re-entering the exit portal (96,125) from the corridor** sends the ball back up (249,123) at 1.42 x its rightward
  speed (<= ~5 on the floor): no gain over the arrows.

## 5. What this means

- Forgotten Helix cannot be cleared in the engine from the level as it is (coin 4 at 3 coins): the flight needs
  >= 9.08 px/tick into (249,123), the level can give 8.63 at the absolute speed cap and ~6.3 in practice. This is an
  exact result per entry state (the flight: exhaustive per state on 0.1 / 0.02 grids; the shaft: bit-exact
  input-independence) plus kinematic bounds for the floor and the one-tile passage; it is not a merged-cell verdict.
  If eeo-tas itself differs from the port here (the portal exit tick's step handling in `_portalTeleport` case 3 keeps
  the old y step: the ball drops by vyIn in the exit tick), the verdict could change; that code is the AS3's.
- The remake moved FV's corridor portal into the ceiling and made the pad reachable only by a fast flight; the fall
  the shaft gives is too slow. A route needs a level change (e.g. a longer arrow run, or the pad reachable by a
  checkpoint) or a mechanic the port lacks.
- No product change: there was no exact route to generalize. The hx-int-1 runs (A100 GPUs 2-3, stuck at 3 coins) cannot
  get further on this level; the GPUs are better used elsewhere (Naos coin 8, the precision lane's dive).

## Not done / limits

- The entry grid is a sample of a continuum (each grid point is an exhaustive exact search): 0.1 x 0.1 x 1/4 for
  vyIn 6.0-9.0 and 0.02 x 0.02 x 1/8 for 8.30-9.10. The gap at the speed cap is 0.45 px/tick (22 grid steps).
- The floor case (a landing on the safe floor 86-91, the checkpoint respawn) is the kinematic bound above: an exact
  DFS from floor launches (`flight.js launch`, `RISE=1` for a sound prune while rising) did not finish in 110 s per
  launch (the ceiling at x 90-96 blocks the prune there).
- The way back east through (135,142) is evidence (1 px / 1/16 cells, 700 ticks), not a proof.
- A route that clears Helix does not exist in this engine for this level; the deaths lane's (r1d) search from a
  low-gravity respawn at (88,128) starts from a state the level cannot produce (section 4).
