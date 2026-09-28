# Forgotten Helix round 3, lane r3-exact: coin 4, exact precision and effects (2026-09-28, 06:43-07:30 EDT)

Branch `hx2-r3-exact` = origin/main 2f8b272 + this note (no product change: there is no exact route to make general).
Scripts (git-ignored scratch, the worktree's `src/out/hx2r3/`, copies in `src/out/night/fetch/helix2/r3-exact/scripts`):
`queue.js` (the shaft with a real gravity queue), `whatif.js` (the shaft carrying low gravity), `fvdoors.js` (FV's
known route: its coins), `dump.js` / `where.js` / `at.js` / `gtab.js` (the level's records, values, gravity table), plus
r2-exact's scripts (flood2.js, manifold.js, portals.js, ascii.js, ...). Everything on the laptop CPU, 1 process, a few
seconds each. No GPU: the A100 and the EPYC were not touched (nothing in this lane needed them; the hx-int-1 runs on
the A100 were left alone).

## Headline

**No route (routed = false, improved = false). Forgotten Helix got no further than 3 coins, and this round finds no
way past coin 4 either.** I re-checked r2-exact's chain from scratch. I found one modelling slip in it: the gravity
queue after the shaft's portal (section 2). It does not change the verdict, because the 16 px/tick speed cap binds
first.

| item | result |
|---|---|
| r2's only named caveat: the portal exit tick (case 3 keeps the old y step) | **matches the AS3** as documented in `docs/eeo_spec/movement.md` 4.18: case 1 keeps `currentSX` and sets `currentSY = -currentSX`, case 3 keeps `currentSY`, "the literal behaviour" |
| the 182 gravity effects (1517) all 0 | **in the file itself**: 1517 is a numbered id (`NUMBERED_IDS`), its int arg is read; the one record holding all 182 tiles carries `[0]`. Not a parser default |
| the shaft's fall speed with the REAL gravity queue (the ball comes off the right arrows) | UP held in the tick after the teleport adds 0.5-0.7 px/tick at arrow speeds 6-12 (r2: "input-free" is wrong there), but the maximum is unchanged: **8.626 at S >= 14 (8.6335 at most seen), the bound 8.75 stands**; the flight needs >= 9.04 |
| carrying low gravity into the shaft (impossible anyway: r2 section 2) | it would make things WORSE: the fall reaches only **1.9-2.7 px/tick** (the low-gravity terminal speed), although with S >= 13 the ball then reaches the top bounce portal (251,94) -> (251,93) |
| the arrow speed the corridor gives | hold right + one jump from the corridor floor (x 86-91, start speeds 0-6.78): **S <= 8.54** at the portal (108,128) (a sample: r1 found 8.14) -> vyIn about 6.6-7.3 even with UP |
| FV vs Helix at coin 4 (why FV's route has no such wall) | FV's shaft is a right-arrow field with rotated portal chains, and FV's corridor has the ceiling portals on rows 125 AND 126 ((74-76,126) -> (4,195): a hop from the floor) with no spikes on rows 125 / 128. Helix removed the row-126 portals, spiked the corridor, and replaced the arrows with an open shaft whose top bounce (249-251,94) (reverse x1.42) is out of reach: apex row 106.2 at the 16 cap, the bounce needs row 94 |
| coins | Helix has 15 gold coins (FV's (346,191) is a solid 1024 brick in Helix) and keeps FV's door 16 (6 tiles). Door 16 never opens in Helix. It does not matter: FV's own known route (forgotten-veil-d30867 best, 11,065 ticks) takes 15 coins and never needs door 16. Helix's coins 1-4 are FV's route's first 4 |

## 1. The exit tick: r2's caveat closed (to the spec)

r2 wrote: "unless the port differs from eeo-tas at the portal exit tick: `_portalTeleport` case 3 keeps the old y step". The
spec, which is written from eeo-tas's AS3 with line references, says the same thing (movement.md 4.18, lines 428-452):
`case 3: speedX = -osy*magic; speedY = osx*magic; ... reminderX = -reminderY; currentSX = -currentSY; break; //
currentSY, reminderY unchanged`. So after (249,123) -> (96,125) the ball moves left AND down by the old step in the exit
tick (it drops about vyIn px below py 2000). eesim.js `_portalTeleport` (lines 1495-1550) does exactly this. The
FV / Octorage / Good Egg TASes replay in the port through many rotated portals.

## 2. The gravity queue after the teleport (new; the verdict holds)

r2's `manifold.js` put the ball in the portal (108,128) with a spawn-area gravity queue (air). In a real run the ball
comes off the right arrows (97-107,128). In the tick after the teleport the DELAYED tile (the current tile of 2 ticks
before) is still an arrow: mox 2, moy 0. So in that one tick the vertical input acts. Without it, the "no modifier" drag
(x0.8876) hits the rising speed (Player.as's `(my == 0 && mox != 0)` branch). `queue.js` rides the arrows into the
portal from x 97 / 102 / 105 with speeds 6-16, then plays each input policy. The value is the fall speed when the centre
first falls into row 123:

| start | S | none | UP held after the teleport | DOWN |
|---|---|---|---|---|
| x 97 | 8 | 6.599 | 7.258 | 6.631 |
| x 97 | 12 | 7.621 | 8.161 | 7.534 |
| x 97 | 14 | 8.189 | **8.626** | 8.109 |
| x 97 | 16 | 8.626 | 8.626 | 8.626 |
| x 102 | 12 | 7.421 | 7.986 | 7.332 |
| x 105 | 16 | **8.6335** | 8.626 | 8.559 |

The teleport sets speed_y = -1.42 S (-22.72 at S 16). In the next tick the cap cuts it to -16 whether or not UP is held,
so the plateau (8.626) and the bound (8.75 = 16 px for the teleport tick + 296.24 px of rise from any speed, r2 section
3) are unchanged. Below the cap, UP gains 0.5-0.7 px/tick. The corridor's real arrow speeds are S <= ~8.5 (table
above), which gives vyIn of about 6.6-7.3 with UP. The flight's least pad landing on r1/r2's grid is at vyIn 9.04, and
its least portal hit is at 9.08.

## 3. Low gravity would not help anyway

The flood proofs (r2 section 2) show that low gravity cannot reach the corridor. Suppose it could. `whatif.js` sets
`low_gravity` on at the portal (108,128). The rise is then much higher: the apex is row 93.8 for S >= 13, the ball
reaches the top bounce (251,94) -> (251,93) and is sent back down at x1.42. The fall under low gravity, though, is slow:
**vyIn 2.74** (S 13-16), and 1.90-2.02 for S 6-10. With normal gravity the same shaft gives 4.2-8.6. So the effect idea
is closed from both sides: it is unreachable, and it would be useless.

## 4. The other checks (no new way)

- Gravity table of every tile id in Helix: the only non-default rows are the arrows 1/2/3 and the zero-gravity tiles
  (dot 4, boosts 114-117, ladder 120, slow dot 459). The shaft (cols 249-251, rows 95-125) and the corridor
  (x 74-96, rows 125-128) hold none of them. Spikes (361) are not solid (flags 0) and kill by gFlags 4 (the centre
  tile at the tick start). The 204s are solid decorative lava bricks, not liquid.
- Boosts: speed-down (117) only at (391,74-76) by the trophy. Speed-up (116) at (77-78,114) sits under the checkpoints
  (77-78,113), cut off from the corridor by the solid rows 115-120, on the way to the up-arrow room. There is nothing that pushes the ball
  down into (249,123).
- Portals into (249,123): only (96,125) (id 4 -> 5). Into the ceiling portals (74-76,125): none (id 1). Into (72,137)
  (coin 4): (2-4,164) and (133,163), both behind the ceiling portals by r2's sound flood.
- Entering (96,125) any other way: moving left gives an exit moving down into the spike (249,124). Moving down gives an
  exit moving right into the spike (250,123) (16 px/tick cannot clear col 250 from col 249). Moving right is r2's
  re-entry (<= 5.892). The only use of (96,125) is as the exit.

## 5. Where it stands

Coin 4 is out of reach at 3 coins in this engine, and so is every other 4th coin (r2's tile proof). The flight needs a
fall of >= 9.04 px/tick into (249,123). The level gives at most 8.64 (the 16 cap, S >= 14), about 7.3 with the arrow
speeds the corridor really gives, and 8.75 is a hard bound. The design looks like it expects more: the open shaft up to
the bounce portals at row 94 and the spiked corridor. But in eeo-tas's physics (the port matches the AS3 spec at every
step checked here) the ball cannot rise past row 106.2. Unless the real game differs from the eeo-tas source, Forgotten
Helix cannot be cleared as built. Nothing was imported: no route exists, hand-made or otherwise.

Not done (no route to generalize): a product change. A general "gate proof" in the editor's check would help on levels
like this: r2's sound tile flood per coin count plus its height budget, to say "the 4th coin needs (74-76,125) and
nothing at 3 coins opens another way". It would stop searches early, but it cannot make Helix routable.
