# EE Auto TAS: the UI redesign, the Stats page and the Optimizer view

The builders follow this document exactly. Where it gives a value (a color, a size, a name, a field), use that value.
Where it says "free", choose. Where it conflicts with a test, the test wins, and the conflict is a bug in this document:
report it.

The user's request: "add a stats page in the web ui and also add like a for optimizer like u can see the phases it
takes etc... in a good ui so u understnd whats going on etc" and "also improve the ui design and stuff completely it could
be way better!!".

Base: main 8b85c2e. Branch for the builders: `n5-ui` (this document's branch).

Contents:

1. Direction: what the app should feel like
2. Test constraints: what must not change (read this before touching a page)
3. The visual system: tokens, type, spacing, components, states
4. Shared files and serving
5. The navigation and the page shells
6. The Runs page (index.html)
7. The run viewer (the `#watch=` overlay)
8. The level editor (editor.html)
9. The Optimizer view (job page and the editor's Hybrid run)
10. The Stats page (stats.html)
11. Data contracts (events, endpoints, the CSV import)
12. Responsive rules
13. Work packages, order, checks, acceptance

---

## 1. Direction

**Subject.** A speedrun tool for Everybody Edits Offline. The person using it imports a level and a TAS, leaves the
optimizer running for hours, and comes back to see how much faster the run got and what found the time. In the level
editor they watch Find a route, Compile or the Hybrid fight their way to the trophy.

**The idea: a split board.** Speedrunners read runs on split timers (LiveSplit): a big run time, segment deltas in
green and red, gold for a best segment. EE itself is gold coins on a dark tile world. The app takes both:

- The **run time is the hero** of every run view, set in a DIN face (Bahnschrift) with tabular figures, like a timing
  board.
- **Gold means "a best"**: the best time, every improvement mark, the brand coin, and the constructive primary action
  (Start, Find a route, Compile). Gold is never used for anything else.
- **Green and red are deltas and state only** (ahead / saved, behind / error), always with a sign, a word or an icon.
- **The optimizer is a tape**: a horizontal timeline of phase blocks per lane (stages, sweep lanes, corridor beam, GPU)
  with gold diamonds where time was found and the best time stepping down above it. This is the one bold element of the
  app; everything around it stays quiet.
- **Night is the native theme** (a blue graphite, not black): the map and the viewer are always night; the pages follow
  the OS, with a manual switch. Day is a cool paper (not cream).

What changes from today (and why):

| Today | New | Why |
|---|---|---|
| Cream background, gold on cream | Blue-graphite night / cool-paper day | A warm cream page is the most common generic look; the EE world is dark |
| Every heading uppercase, letter-spaced | Sentence case, Bahnschrift titles | Uppercase eyebrows everywhere is template chrome |
| Monospace for every number | Bahnschrift tabular figures for times and counts; mono only for logs, input strings, md5s, `/loadtas` | Times are the subject; mono labels are a generic tell |
| Job page = a stack of cards and boxes | One sheet with sections and hairlines | Fewer borders, clearer hierarchy |
| Green "go" buttons, ink "primary" buttons | Gold for the action that makes a run faster; ink for downloads and finishing | Gold = best, consistently |
| A step chart and a list of improvements | The Optimizer view: now sentence, round recipe, best-time chart over the tape, scoreboard | The user asked to see the phases and understand them |
| No Stats | A Stats page: your runs and imported benchmarks | Asked for |
| Errors swallowed when the app stops | An offline banner | The page silently froze before |
| No URL for a job page | `#job=<id>`, back button works | Stats links to runs |

Motion: exactly one orchestrated moment, the **new best**: the big time slides the new value in (180 ms), the gold mark
drops onto the tape and rings once (600 ms), the toast arrives with a gold bar. Nothing else animates by itself except
the running-stage playhead and the spinners. `prefers-reduced-motion: reduce` turns all of it off.

---

## 2. Test constraints (frozen)

The tests cut code and markup out of the pages by name and by literal text. Breaking any item below breaks
`node test/editor.js --only=app` or `node test/review.js --quick --only=app`. When in doubt: restyle with CSS, add new
code in new functions or new files, and leave existing lines alone.

### 2.1 Rules for both pages

- A page function the tests cut out starts with `function name(` (or `async function name(`) **at column 0** and ends at
  the **first `}` at column 0** after it. Do not rename, nest, indent or split these functions, and do not give them a new
  free variable (the tests run them with stand-ins; a call into `UI.*` or `TL.*` inside them throws there). If one of them
  must call new code, guard it: `if (typeof UI === 'object') ...`.
- One-line constants the tests grab (`const esc = ...`, `const fmt = ...`, `const rateM = ...`, `const clamp = ...`, ...)
  stay one line, at column 0, unchanged.
- Class names that frozen renderers emit stay; restyle them, do not rename them.
- Every inline `<script>` must parse on its own.

### 2.2 index.html

| Frozen | Where the test reads it |
|---|---|
| The block from `const rateMG = ` up to (not including) `function friendlyStage(` stays one contiguous block (rentedJobs, remoteRate, remoteWhere, ticksN, deathsHtml, remoteAhead, tonightText, sinceText, stoppedSince, remoteShort, remoteHtml, renderRented). Its free variables: `state`, `$`, `store.get`, `selected`, `selectJob`, `esc`, `fmt`, `rateM`, `bigCount`, `friendlyStage`, `gpuFamily`. | review.js `remoteChecks` |
| Top-level `function bigCount(`, `function friendlyStage(`, `function gpuFamily(` | review.js |
| The block from `const JSECS = [` up to `function selectJob(` (JSECS, jsecOpen, campOrder, jobCard, renderJobs). Free variables: `$`, `store`, `esc`, `state`, `liveShort`, `remoteShort`, `selectJob`, `openViewer`, `document`, `selected`. Its output keeps `<button class="jsh" data-sec="campaign" ...><span class="car">...</span>Campaign...<span class="jn">N</span></button>`, `class="ctag"` with the text `Title · level 1 of 1`, and `data-id="<id>"` on the run buttons. | editor.js app (the runs list) |
| `function levelCheckHtml(` (needs only `esc`): emits `class="msg warn"`, `<input type="checkbox" id="eeoCopy"> Use EEO's own copy of ...`, `class="lvok"` | review.js |
| `function openInEditor(` | review.js |
| The effects block `const FXB = {` up to `/** a simple-look badge`, `function ub(` (one line), `function fxLabel(`, `function fxSpans(`, `vwPrepFx`, `vwFxList` | review.js viewer effects |
| `<div class="vtop">` ... `</div>` followed by exactly `\n\t\t<div class="vstage"`, containing `<button id="vEditor"...>Open in level editor</button>` then (whitespace only) `<button id="vClose"` | review.js |
| `<button class="ghost" id="dlOrig">Original</button>` then whitespace then `<button class="ghost" id="edBtn" ...>Open in level editor</button>` (no attribute after `id="dlOrig"`, button text exact) | review.js |
| Lines: `$('vEditor').onclick = () => { if (vw.id) openInEditor(vw.id); };` (column 0), `$('edBtn').onclick = () => openInEditor(j.id);`, `eeoCopy: !!($('eeoCopy') && $('eeoCopy').checked)`, `if (files.eelvl && (!lvCheck \|\| lvCheck.file !== files.eelvl)) checkLevelFile(files.eelvl);`, `${jobCheckHtml(j)}` | review.js |
| The text `href="/editor"` somewhere in the page | editor.js app |

### 2.3 editor.html

| Frozen | Where the test reads it |
|---|---|
| **Exactly one** inline `<script>` (a `<script>` tag with no attribute). External scripts (`<script src="/ui.js"></script>`) do not count and are allowed. | editor.js app |
| The text `Level editor` in the page | editor.js app |
| `<a class="pill" id="pJob" href="/" hidden` | review.js |
| `<label class="ck" id="lJobPath" hidden ...><input type="checkbox" id="cJobPath"> job's run</label>` | review.js |
| `<div class="tools" id="tools">`: the test takes everything up to its **first `</div>`**, and the `cFrontier` label, `bFollow`, `cExplore` must be inside. **Toolbar groups are `<span>`, never `<div>`.** The label stays `<label class="ck" ...><input type="checkbox" id="cFrontier" checked> search frontier</label>`. | editor.js frontier / explore |
| `<canvas id="cv"></canvas><canvas id="cvFx" class="fx" aria-hidden="true"></canvas>` and `<canvas id="cvHeat" class="fx heat" aria-hidden="true"></canvas><canvas id="cvTrail" class="fx" aria-hidden="true"></canvas>` (exact adjacency) | editor.js |
| CSS rules, **inline in editor.html**, character for character: `.stage canvas.fx { pointer-events: none; }`, `#cvHeat { z-index: 1; mix-blend-mode: screen; } #cvTrail { z-index: 2; } #cvFx { z-index: 3; }`, `.stage canvas.heat { inset: auto; left: 0; top: 0; width: auto; height: auto; transform-origin: 0 0; will-change: transform; }`, `.bestp.min .bs, .bestp.min .bl, .bestp.min canvas { display: none; }` | editor.js |
| The best-route panel markup exactly: `<div class="bestp" id="bestP" title="click: fold / unfold" hidden><div class="bt"><span>best route</span><b id="bpTime"></b></div><div class="bs" id="bpSub"></div><div class="bl" id="bpLast"></div><canvas id="bpChart" width="212" height="42"></canvas></div>` | editor.js |
| `<input type="range" id="fSeek"`, `<button id="fEnd"`, and the `cGoto` button markup `<button class="small" id="cGoto"...>...Go to</button>` | editor.js |
| ids `bHybrid`, `sHyStall`, `hybridSt`; the region `const HYB = {` ... `$('bHybrid').onclick = hybridLevel;` runs with only `$`, `store`, `esc`, `fmt`, `toast`, `LV`, `GPU`. renderHybrid's output keeps: one `<tr class="...">` per route and no other `<tr class=`, `Hybrid route</div><div class="rt">`, `id="hyWatch"`, `id="hyOpt"`...`>Optimize<`, `id="hyEetas">Download .eetas`, `Stop the hybrid`, `class="msg info">Hybrid: ...`, the texts the test greps (`CPU only`, `restarts fresh after 30:00 stuck`, `round 2`, `nearest <b>13.4</b> tiles from the trophy`, `best so far</span><b>0:41.00</b>`, ...) | editor.js hybridPageChecks |
| The region `const PICK = {` ... `/** the level as .eelvl bytes` | editor.js |
| Every code line the tests grep (the frontier, exploration, Follow and best-route lines: `if (k === 'f' \|\| k === 'F') { gotoFrontier(); return; }`, `if (EXP.on \|\| EXP.shown) drawExplore(now);`, ... see `test/editor.js` lines 375-530, 960-1040) and every function they cut out by name (tracePath, frontierOf, drawFrontier, gotoFrontier, glideStep, the heat and trail functions, the Follow functions, bestRoute, changedSpan, impUpdate, impJob, bestPanel, bestChart, b64i32, api, b64, loadJson, lvMsg, openEelvl, checkHtml, useEeoCopy, jobClear, openJob, jobPath, jobFromHash, the consts FX, EXP, VW, FOL, IMP, HEAT_LUT, EXP_COLORS, ...) | editor.js, review.js |

**Rule for editor.html:** change the markup outside the map stage, the CSS, and append new code at the end of the
script. Do not edit existing script lines, except the hook lines this document names.

### 2.4 Other

- `test/review.js` copies only `index.html` and `editor.html` into its temporary app (line 883). Change it to copy
  **every file of `src/app/`** so the new files are served there too.
- The exe packs only `.js`, `.json`, `.html`, `.md` (`tools/build-exe.js` `appFiles`). Add `.css` to that pattern.
- Third-party levels, TASes and the benchmark CSV never go into git. Tests use synthetic data.

---

## 3. The visual system

### 3.1 Tokens (paste into `src/app/ui.css`, verbatim)

Day is `:root`. Night applies on OS dark (unless the user picked day), on `data-theme="dark"`, and on any `.night`
subtree (the map stage and the viewer are always `.night`).

```css
:root {
	color-scheme: light;
	/* surfaces */
	--ground: #eef1f6;  --panel: #ffffff;  --raise: #f3f5f9;  --sunken: #e6eaf1;
	--line: #dde2ea;    --line-2: #c5ccd8;
	/* ink (contrast on --panel: 17.4 / 9.0 / 5.3) */
	--ink: #141a26;     --ink-2: #3e4a5e;  --muted: #5f6c82;
	/* meaning */
	--coin: #f2b51c;      /* gold fills (buttons, bars); never text on day */
	--coin-mark: #b98100; /* gold marks on day (3.4:1) */
	--coin-ink: #8a5a00;  /* gold text (5.9:1) */
	--coin-wash: #fff4d6; --on-coin: #1a1405;
	--ahead: #147a43;  --ahead-wash: #e2f3e9;
	--behind: #c0392b; --behind-wash: #fbe9e6;
	--warn: #9a5a00;   --warn-wash: #fff1db;
	--remote: #2a63d4; --remote-wash: #e8effc;
	--focus: #2a63d4;
	/* optimizer phase families (validated all-pairs on #ffffff: CVD dE 9.2, normal dE 16.3, all >= 3:1) */
	--ph-tweak: #2a78d6; --ph-explore: #4a3aa7; --ph-path: #e0662f; --ph-local: #14a37a; --ph-finish: #b8489e;
	--ph-combine: #7d8799; --ph-outside: #3e4a5e;
	/* elevation */
	--shadow-card: 0 1px 0 rgba(20, 26, 38, .05);
	--shadow-float: 0 12px 32px rgba(20, 26, 38, .18), 0 2px 6px rgba(20, 26, 38, .08);
	/* type */
	--f-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif;
	--f-num: "Bahnschrift", "DIN Alternate", "DIN 2014", "Barlow", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
	--f-mono: "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
	/* space (4 px grid), radii (by hierarchy), layout */
	--s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;
	--r1: 4px; --r2: 8px; --r3: 12px; --r4: 16px;
	--nav-h: 48px; --rail-w: 320px; --main-max: 1120px; --page-max: 1480px;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) { /* the NIGHT declarations: a copy of every declaration of the block below */ }
}
:root[data-theme="dark"], .night {
	color-scheme: dark;
	--ground: #10151f;  --panel: #182031;  --raise: #212b40;  --sunken: #0c1018;
	--line: #2b3750;    --line-2: #3a4866;
	--ink: #e9eef7;     --ink-2: #b3bdd0;  --muted: #8391ab;   /* on --panel: 14.0 / 8.6 / 5.1 */
	--coin: #ffc83d;    --coin-mark: #ffc83d; --coin-ink: #ffd76a; --coin-wash: rgba(255, 200, 61, .12); --on-coin: #1a1405;
	--ahead: #3ddc84;   --ahead-wash: rgba(61, 220, 132, .12);
	--behind: #ff7468;  --behind-wash: rgba(255, 116, 104, .12);
	--warn: #ffa24c;    --warn-wash: rgba(255, 162, 76, .12);
	--remote: #7fb2ff;  --remote-wash: rgba(127, 178, 255, .12);
	--focus: #7fb2ff;
	/* validated all-pairs on #182031: CVD dE 9.8, normal dE 16.7, all >= 3:1 */
	--ph-tweak: #2b99e7; --ph-explore: #7758bb; --ph-path: #da570b; --ph-local: #0a9068; --ph-finish: #d168a7;
	--ph-combine: #6b7891; --ph-outside: #b3bdd0;
	--shadow-card: none;
	--shadow-float: 0 16px 40px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .35);
}
```

Paste the block verbatim and fill the media query's rule with the same declarations as the night block (the night set
is written twice: inside the media query with the `:not([data-theme="light"])` guard, and under
`:root[data-theme="dark"], .night`). The palettes above were checked with the data-viz validator (OKLab, CVD
simulation, contrast): do not change a hex without re-running it.

**Theme switch.** `localStorage['eeat.ui.theme']` = `auto` (default) | `dark` | `light`; `ui.js` sets
`document.documentElement.dataset.theme` before first paint (it is loaded synchronously in `<head>`); `auto` removes the
attribute. A `?theme=dark|light` query overrides it for that load (for headless screenshots).

### 3.2 Typography

| Role | Face | Size / line | Weight | Notes |
|---|---|---|---|---|
| Hero time (best time on the job page, the hybrid's best) | `--f-num` | 60 / 1 | 600 | `font-variant-numeric: tabular-nums`, letter-spacing -0.01em |
| KPI value, editor result time | `--f-num` | 36 / 1.1 | 600 | tabular |
| Job / page title | `--f-num` | 24 / 30 | 600 | |
| Section title | `--f-num` | 18 / 24 | 600 | sentence case, never uppercase |
| Card title (dense columns) | `--f-num` | 16 / 22 | 600 | |
| Lead / important text | `--f-ui` | 16 / 24 | 400 | the Optimizer "now" sentence |
| Body | `--f-ui` | 14 / 21 | 400 | |
| Dense UI (buttons, table cells) | `--f-ui` | 13.5 / 20 | 400 / 600 | |
| Small (labels, hints, captions) | `--f-ui` | 12 / 16 | 400 | labels in `--ink-2`, hints in `--muted` |
| Micro (axis ticks, block labels in the tape) | `--f-ui` | 11 / 14 | 600 | |
| Times and counts anywhere | `--f-num` | the size of their context | 500 | tabular; deltas use the real minus `−` |
| Logs, input strings (`R+J x3`), md5s, `/loadtas` line | `--f-mono` | 12 / 18 | 400 | nothing else is monospace |

No uppercase transforms and no letter-spaced labels anywhere (remove `text-transform: uppercase` from `.card h2`,
`.jsh`, `.vclock .lbl`, `.hyRoutes th`, `.result .rk`, `.exleg .et`, `.bestp .bt`; the texts are already sentence case).
Labels end without a colon. Meta strings are separate elements with spacing, not text joined by middle dots, except
where a frozen renderer emits them.

Formats (`ui.js` exports them; frozen code keeps its own): times `m:ss.cc`; deltas `−0.54 s` and `−54 ticks`; durations
`45 s`, `12 min`, `3 h 05 min`; counts `4,812`; speeds `13.1 M ticks/s`; clock times `14:05` (local, 24 h unless the
browser's locale says otherwise: `toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})`).

### 3.3 Components (in `ui.css`; class names below are the contract)

**Buttons** (`button`, keep the existing variant class names because the pages' code emits them):

| Class | Use | Look |
|---|---|---|
| (none) | secondary actions | `--raise` fill, 1 px `--line` border, `--ink` text |
| `.go` | the action that makes a run faster or finds a route: Start / Resume, Search harder here, Find a route, Find and optimize, Compile, Hybrid (best), Search along the line | `--coin` fill, `--on-coin` text, no border; hover: 6% darker (`filter: brightness(.94)`) |
| `.primary` | downloads, Import & check, Finish run | `--ink` fill, `--panel` text |
| `.watch` | Watch | transparent, 1 px `--coin-mark` border, `--coin-ink` text, a play triangle before the text (CSS `::before`, 0.6 em) |
| `.stop` | Pause, Stop, Delete armed | transparent, 1 px `--behind` border at 50% (`color-mix`), `--behind` text; hover `--behind-wash` |
| `.ghost` | quiet text actions | transparent, no border, `--ink-2`; hover `--raise` |
| `.small` | dense rows | height 26, padding 0 10, 12 px |

All buttons: height 32, padding 0 14, radius `--r2`, `--f-ui` 13.5 px 600, `gap: 6px` (inline-flex, centered);
`:disabled` opacity .45; `:focus-visible` `outline: 2px solid var(--focus); outline-offset: 2px`. Icons are CSS masks on
`::before` keyed by `[data-ic="..."]` or by id (never inside the text of a frozen button): download, play, pause,
editor (a grid), stop (a square), theme (sun / moon / half). 16 px, `background: currentColor`.

**Fields.** `input[type=text|number]`, `select`: height 32, padding 0 10, radius `--r2`, `--raise` fill, 1 px `--line`
border, focus ring as buttons. Labels (`label.f`) 12 px `--ink-2`, 4 px above the field. Checkboxes use
`accent-color: var(--coin)`.

**Segmented control** `.seg` (new): a row of `button`s inside a `--sunken` track (radius `--r2`, padding 2); the selected
one (`[aria-pressed="true"]`) gets `--panel` fill and `--shadow-card`. Used for time ranges, Stats tabs, table sections.

**Chips** `.chip` (new) and the existing `.pill`: inline-flex, height 22 (`.pill` 26 in the nav), padding 0 8, radius
`--r1`, 12 px 600, `--raise` fill, `--ink-2` text. Variants `.gold` (`--coin-wash` / `--coin-ink`), `.ahead`, `.behind`,
`.warn`, `.remote` (wash + text of that color). A status chip always starts with an 8 px dot (`<i></i>`) **and** a word.
`.pill.ok` = `.chip.ahead`, `.pill.no` = `.chip.behind` (kept for the existing code).

**Cards** `.card`: `--panel`, 1 px `--line`, radius `--r3`, padding 16 (12 in the editor's columns), `--shadow-card`.
Cards are for the rail (New run, Rented machines), the editor's columns, the Stats tiles. The job page is not cards.

**Sections** `.sec` (new): the job page and Stats are one sheet (`--panel`, radius `--r3`, padding 24) divided into
sections; each `.sec + .sec` has `border-top: 1px solid var(--line); padding-top: 24px; margin-top: 24px`. A section
header `.sec-h` is a flex row: the title (`h2`, the section title style) left, its tools (segmented controls, buttons)
right.

**Tables** `.tbl` (new): `width: 100%; border-collapse: collapse`. `th`: 12 px 600 `--ink-2`, left, padding 8 10,
`border-bottom: 1px solid var(--line-2)`, sticky top with `--panel` fill; a sortable header is a `button.th` with ▲/▼
after the text of the sorted column. `td`: 13.5 px, padding 8 10, `border-bottom: 1px solid var(--line)`; numbers
`.n` right-aligned in `--f-num` tabular. Row hover `--raise`; the selected or highlighted row `--coin-wash`. A group row
`.grp` (Campaign / Other) spans all columns, `--f-num` 14 px 600 with its count, and folds its rows.

**Stat tiles** `.kpi` (new): a label (12 px `--ink-2`), a value (`--f-num` 36 px), an optional sub line (12 px
`--muted`, may hold a delta chip). No colored borders, no icons.

**Bars** `.bar` (new): a 6 px track (`--sunken`, radius 3) with a fill `<i style="width:..%">` (radius 3); the fill color
says what it measures (`--ahead` for routed / done, a family color for a share). A meter row = label, value text, bar.

**Messages** (keep the names): `.msg.err` (`--behind-wash`, `--behind` text, a ⚠ before), `.msg.warn` (`--warn-wash`,
`--ink` text, 1 px `--warn` border at 40%), `.msg.info` (`--raise`, `--ink-2`), `.lvok` (`--ahead`).

**Toasts** (`#toasts`, keep): `--panel` of the page's theme, radius `--r2`, `--shadow-float`, a 3 px
left bar: `--coin` for a new best, `--behind` for `.err`, `--ink-2` otherwise. Bottom right, 16 px from the edges.

**Tooltip** `.tip` (new, one element per page from `ui.js`): `--panel`, 1 px `--line-2`, radius `--r2`,
`--shadow-float`, 12 px, max-width 300, padding 8 10, follows the pointer (12 px offset, flips at the edges),
`pointer-events: none`. Every chart mark and tape block has one.

**Spinner** `.spin` (keep). **Empty states** `.empty` (keep the name): centered, a `--f-num` 18 px title, one or two
lines of `--ink-2`, one action button. **Loading**: a `.loading` line (spinner + "Loading ...") where the content will
be; no skeleton shimmer.

**Offline banner** `#offline` (new, every page, from `ui.js`): under the nav, full width, `--behind-wash`, `--behind`
text 13.5 px: "The app is not answering. It may have been closed: start it again with START.bat (or EEAutoTAS.exe).
Trying again every 5 s." Shown after 2 failed requests in a row (`UI.netFail()` / `UI.netOk()` called by the pages'
pollers), hidden on the next success.

### 3.4 Charts (inline SVG from `ui.js` / `timeline.js`; no library)

- Lines 2 px, round joins; dots 8 px with a 2 px ring in the surface color; bars at most 24 px thick, 4 px rounded data
  end, square at the baseline, 2 px surface gap between touching bars or segments.
- Gridlines: 1 px `--line`, solid; axis text 11 px `--muted`, `--f-num` tabular. One y-axis per chart, always.
- Text never takes a series color; identity comes from a swatch or the mark beside the text.
- A legend whenever 2+ series; direct labels on at most the ends or the one series the chart is about.
- Every chart has a hover layer (a crosshair on lines, a per-mark tooltip on bars and blocks) and a text or table
  equivalent next to it (the tape: the scoreboard table; Stats charts: the table and the numbers in the panel).
- A label inside a colored block uses `UI.inkOn(hex)`: `#ffffff` or `#0b0f17`, whichever contrasts more; no label when the
  block is narrower than the text + 8 px.

---

## 4. Shared files and serving

| File | Owner | What |
|---|---|---|
| `src/app/ui.css` | WP1 | tokens (3.1), base elements, components (3.3), the nav (5), the offline banner, the tooltip |
| `src/app/ui.js` | WP1 | browser script, loaded synchronously in `<head>` of every page: theme (3.1), `UI.nav(active, rightHtml)` builder, `UI.netFail/netOk` (offline banner), `UI.tip` (tooltip), formats (`UI.fmt`, `UI.delta`, `UI.dur`, `UI.count`, `UI.rate`), `UI.inkOn`, chart primitives `UI.spark`, `UI.bars`, `UI.histo`, `UI.steps` (step line), `UI.stack` (100% bar). `'use strict'`, tabs, no globals but `UI`. |
| `src/app/timeline.js` | WP5 | the Optimizer view renderer `TL` (section 9), used by index.html and editor.html |
| `src/app/stats.html` | WP6 | the Stats page |
| `src/phases.js` | WP4 | Node: the phase dictionary, the timeline model builders (job, hybrid), the now sentence, the legacy log parser |
| `src/events.js` | WP4 | Node: the append-only JSONL writer with rotation (grind.js, gpusearch.js) |
| `src/stats.js` | WP6 | Node: `/api/stats` (11.5) and the benchmarks (11.6): the CSV parser (shared with the tool), the list, one benchmark, the job matching |
| `tools/stats-import.js` | WP6 | the benchmark import tool (a thin CLI over `src/stats.js`); packed into the exe (add it to the `tools/hybrid.js` line of `tools/build-exe.js` `appFiles`) so `EEAutoTAS.exe tools/stats-import.js <file.csv>` works |

`src/server.js` serves, besides `/`, `/index.html`, `/editor`, `/editor.html`:

- `GET /stats` and `/stats.html` -> `src/app/stats.html` (`text/html; charset=utf-8`)
- `GET /ui.css` (`text/css; charset=utf-8`), `GET /ui.js`, `GET /timeline.js` (`text/javascript; charset=utf-8`), with
  `Cache-Control: no-cache` (the files change with the app version).
- Only these names (a whitelist), never a path from the URL.

`tools/build-exe.js`: `/\.(js|json|html|md|css)$/`. `test/review.js` line 883: copy every file of `src/app`.

Each page's `<head>`: `<link rel="stylesheet" href="/ui.css">`, `<script src="/ui.js"></script>`, then its own
`<style>` (page-specific rules; the frozen editor rules stay there), then (index, editor) `<script src="/timeline.js"
defer></script>`.

---

## 5. The navigation and the page shells

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ (•) EE Auto TAS    Runs   Editor   Stats                    [page status pills ...]  [◐]      │  48 px, sticky
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  ^ coin glyph 18 px      ^ active tab: --ink + a 2 px --coin bar on the nav's bottom edge
```

Markup (static in each page, so it paints at once; `UI.nav` only marks the active tab and wires the theme button):

```html
<nav class="topnav" aria-label="EE Auto TAS">
	<a class="brand" href="/"><span class="coin" aria-hidden="true"></span>EE Auto TAS</a>
	<div class="tabs"><a class="tab" href="/" data-tab="runs">Runs</a><a class="tab" href="/editor" data-tab="editor">Editor</a><a class="tab" href="/stats" data-tab="stats">Stats</a></div>
	<div class="navr" id="navR"><!-- page-specific --></div>
	<button class="ghost themeb" id="themeBtn" data-ic="theme" title="Theme: follows the system"></button>
</nav>
<div id="offline" hidden></div>
```

- `.topnav`: height `--nav-h`, `--panel` fill, 1 px `--line` bottom border, padding 0 16, `position: sticky; top: 0;
  z-index: 20`. `.brand`: `--f-num` 17 px 600 `--ink`. `.tab`: 14 px 600 `--ink-2`, padding 0 12, full nav height; hover
  `--ink`; `[aria-current="page"]` `--ink` with `box-shadow: inset 0 -2px 0 var(--coin)`.
- The theme button cycles auto -> dark -> light; its title says which ("Theme: follows the system", "Theme: night",
  "Theme: day").
- **Runs**: `#navR` holds `#pills` (renderPills: the CPU pill, the "optimizing <name>" chip with a running dot, the rented
  machines chip). The old header (title, subtitle, "Level editor" pill) goes; the subtitle text moves to the empty state.
- **Editor**: `#navR` holds `#pJob`, `#pSize`, `#pGpu` (markup kept). The `h1` back link, the long `.sub` line and the
  "← Your runs" pill go (the Runs tab replaces them; the `.sub` text moves into the Find a route card's hint). The page
  keeps `<title>Level editor · EE Auto TAS</title>`.
- **Stats**: `#navR` holds "Updated 12 s ago" (12 px `--muted`) and a `.ghost.small` Refresh button.

Shells: Runs and Stats scroll the window; the page body is `max-width: var(--page-max); margin: 0 auto; padding: 24px`
(16 on phones). The editor stays a full-height app (`.app` grid: nav, then the 3 columns).

---

## 6. The Runs page (index.html)

### 6.1 Layout

```
┌ nav ─────────────────────────────────────────────────────────────────────────────────────────┐
├ rail (320) ──────────────┬ main (fluid, max 1120) ────────────────────────────────────────────┤
│ [Filter runs        ]    │ ┌ sheet ─────────────────────────────────────────────────────────┐ │
│ [+ New run]              │ │ Forgotten Veil                          [▶ Watch] [Pause] [Finish run]
│                          │ │ Worst, level 4 of 5   ✓ verified   started after /reset         │ │
│ Campaign            12 ▾ │ │ ⚠ level check warnings (if any)                                 │ │
│ │ Tutorial 1        ●    │ │                                                                 │ │
│ │ 0:16.55 → 0:16.41      │ │ 1:50.53      2:31.20      −40.67 s   26.9%   1 death   100%     │ │
│ │ ...                    │ │ best (hero)  original     saved (chips)                          │ │
│ Other               31 ▾ │ ├─────────────────────────────────────────────────────────────────┤ │
│ │ ...                    │ │ Optimizer                 [Session][15 min][1 h][6 h][All]      │ │
│                          │ │ (section 9: now, recipe, chart + tape, scoreboard)              │ │
│ Rented machines (card)   │ ├─────────────────────────────────────────────────────────────────┤ │
│                          │ │ Improvements                                             312    │ │
│                          │ │ (table, newest first)                                           │ │
│                          │ ├─────────────────────────────────────────────────────────────────┤ │
│                          │ │ Files  [Download optimized .eetas (1:50.53)] [Original] [Open in level editor]   [Delete]
│                          │ │ (Finish report when there is one)                               │ │
│                          │ ├─────────────────────────────────────────────────────────────────┤ │
│                          │ │ Search harder (Ideas)                                           │ │
│                          │ ├─────────────────────────────────────────────────────────────────┤ │
│                          │ │ ▸ Optimizer log   ▸ Processor   ▸ Log on <rented machine>       │ │
│                          │ └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

The main column is one sheet, `<div class="sheet" id="sheet">` (`--panel`, radius `--r3`, padding 24, `--shadow-card`),
holding these containers in this order, each a `.sec`: `#detail` (header, the times, the live / remote strips),
`<section id="opt">` (the Optimizer view: owned by `timeline.js`, never rebuilt by `renderDetail`), `#detail2`
(Improvements, Files, the report, the log disclosures), `#ideas`. renderDetail writes its first part to `#detail` and its
second to `#detail2` (keep every frozen literal of 2.2 inside it). The rail: `#jobFilter`, the New run card, `#jobs`,
`#rented`.

### 6.2 The rail

- **Filter** `#jobFilter` (new, `input type=search`, placeholder "Filter runs"): renderJobs hides runs whose name does not
  contain the text (case-insensitive). Inside the frozen block read it as `(($('jobFilter') || {}).value || '')` so the
  test's stand-in `$` still works.
- **New run**: with no runs, the New run card shows open in the main column as the onboarding (below). With runs, it is
  folded behind a `+ New run` button at the top of the rail (`aria-expanded`), and dropping `.eelvl` / `.eetas` files
  anywhere on the page opens it and takes them. Same elements and ids as today (`#drop #pick #files #lvCheck #name
  #startMode #importBtn #importHint #importMsg`), restyled: the drop zone a 2 px dashed `--line-2` box, radius `--r3`,
  `--sunken` fill; hover / drag-over: dashed `--coin-mark`, `--coin-wash`. "Import & check" is `.primary`.
- **Runs list** (frozen renderer; restyle only): the section headings `.jsh` are `--f-num` 14 px 600 `--ink-2`, sentence
  case, the count `.jn` a `.chip`; a run `.job` is a row, not a card: no shadow, no border, radius `--r2`, padding 8 10,
  hover `--raise`; the selected one `--raise` with a 3 px `--coin` bar on its left (`box-shadow: inset 3px 0 0
  var(--coin)`). Line 1 name (14 px 600) and the state dot (`.dot.run` `--ahead`, `.dot.rem` `--remote`); `.ctag` 12 px
  `--muted`; `.t2` the times in `--f-num` 13 px `--ink-2` with the saved part in `--ahead`. The `Watch` button `.jw` is a
  `.watch.small` that shows on hover, focus-within and on the selected row (always on touch devices).
- **Rented machines** (frozen renderer): a `.card` below the list, styled with the `--remote` accent for "on <machine>"
  and the GPU tags.

### 6.3 The header and the times (in `#detail`)

- Title row: the run's name (job title style) and, on the right, the actions: `Watch` (`.watch`), then running:
  `Pause` (`.stop`) + `Finish run` (`.primary`); stopped: `processor` and `threads` selects (labelled, compact) + `Start`
  / `Resume` (`.go`) + `Finish run` when it has a gain. Under the title one row of facts as chips and text: the campaign
  tag, `✓ verified` (`--ahead` chip, its title the long text), the start mode when it matters, the level-check warnings
  (`jobCheckHtml`, as a `.msg.warn` under the row).
- The times: the best time (hero), the original (`--f-num` 24 px `--muted`, struck through when improved), then chips:
  saved `−40.67 s · 4,067 ticks` (`.chip.ahead`; `.chip` "no improvement yet" when zero), the percentage, deaths
  (`deathsHtml`, as a chip), the random-portal chance when below 100% (`.chip.warn` "finishes in 50% of plays").
- **Live strip** (replaces the green box; `liveHtml` restyled): one line under the times: a running dot, "Speed now"
  `13.1 M` ticks/s CPU (8 threads) + `384 M` GPU (name) = total, and on the right "1.2 billion ticks this session". 13.5
  px, numbers `--f-num` 600. When idle (between stages) the numbers are `--muted`.
- The **remote** strip (frozen `remoteHtml`): the same treatment with `--remote`.
- The four "stats" boxes (Status, Now, Running for, Rounds · coins) go away: the state is in the nav chip and the
  Pause / Start button, the stage, the round and the running time in the Optimizer view; the coin mode becomes a chip in
  the facts row ("coins optional" / "coins needed", its title the explanation). `friendlyStage` stays (frozen; the
  rented-machines code uses it), and the `.stats` / `.stat` styles stay for `remoteHtml` (frozen), which emits them.
- With the Optimizer view loaded (`typeof TL === 'object'`), the live strip moves into its header (the model's
  `speed`) and `#detail` does not show `liveHtml`; without it (timeline.js failed to load) `#detail` shows it as today.
- The processor note `#procNote` moves into the "Processor" disclosure at the bottom (keep the id).

### 6.4 Improvements (in `#detail2`)

A `.tbl`, newest first, at most 360 px tall (the table scrolls; its header sticks), columns: **When** (clock time;
title: the full date), **Saved** (`−54 ticks`, `--ahead`), **New best** (`--f-num`), **Found by** (a 10 px square in the
family color + the plain label from the dictionary, e.g. "Route sweep (round 3)"; its title the raw `what`), **Round**.
Rows come from the phases payload's `history` (section 11.3: classified on the server); before it arrives, from
`j.history` with the raw `what` (no swatch). Empty: "Improvements show up here as the optimizer finds them. The first
minutes usually find the most."

### 6.5 Files, report, Search harder, disclosures

- Files row: `Download optimized .eetas (1:50.53)` (`.primary`, `data-ic="download"`), `Original` and `Open in level
  editor` (`.ghost`, frozen markup), a spacer, `Delete` (`.ghost`; armed: `.stop` "Click again to delete"). The Finish
  report (`reportHtml`) follows as a sub-panel (`--raise`, radius `--r2`), the odds in `--f-num` 24 px.
- **Search harder** (the Ideas card, `renderIdeas`, ids kept): a section titled "Search harder", one line of explanation
  ("Pick a stretch of the run where you think time can be saved. It searches just that stretch next to the optimizer and
  hands anything faster to it."), the fields in a row (From, To, Search time), `Show map` (default) and `Search harder
  here` (`.go`). The map image box `--sunken`, radius `--r2`.
- Disclosures at the bottom (`details`, 13.5 px `--ink-2` summary with a chevron): "Optimizer log" (`#logBox`),
  "Processor" (`#procNote` and the GPU explanation), "Log on <machine>" (`#rlogBox`). Logs `--f-mono` 12 px on
  `--sunken`.

### 6.6 Empty, loading, errors

- No runs: the main column shows a sheet with the title "Make your first run faster", the text "Import a level (.eelvl)
  and a TAS that finishes it (.eetas). The app replays your TAS in EE's exact physics, then searches for faster inputs
  until you stop it. Every improvement is proven by a full replay." and the New run card open under it.
- A selected run that has never run: the Optimizer view says "Not started yet. Press Start: the first minutes find the
  most time." and shows the round recipe for this level (the stage order) as a preview.
- The app stops answering: the offline banner (3.3). refresh(): `catch (e) { UI.netFail(); return; }`, `UI.netOk()` after
  a success (guarded with `typeof UI`).

### 6.7 Routing

- `#job=<id>`: selects that run. `selectJob(id)` pushes `#job=<id>` (`history.pushState`) when the user picks a run, and
  replaces it (`history.replaceState`) when the page picks one by itself; `openFromHash` handles `job=` (select, no push)
  as well as `watch=` (unchanged); `tasopt.sel` stays the fallback when there is no hash.
- The browser's back button walks between runs.

### 6.8 Polling

Unchanged (`/api/state` every 1.5 s while a run runs, else 2.5 s). The Optimizer view polls on its own (9.5). The
document title keeps `−0.14 s · 0:16.41 · EE Auto TAS`.

---

## 7. The run viewer (`#watch=`)

Behavior, ids and markup structure stay (2.2). The `.vwin` gets the class `night` (always the night tokens). Changes are
CSS only:

- `.vwin` radius `--r4`, `--panel` (night), 1 px `--line`. `.vtop`: the title `--f-num` 15 px 600 + the meta in `--ink-2`;
  the buttons as the system's buttons (night); `#vNewer` as a `.chip.gold`-looking button.
- HUD clocks `.vclock`: the best time `--f-num` 22 px 600 `--coin`, the original `--f-num` 16 px `--remote` (the ghost
  color stays light blue), labels 11 px sentence case `--muted`. `.vdiff.ahead` `--ahead`, `.behind` `--behind`.
- Key display `.vkeys`: 24 px squares, radius `--r1`, the pressed key `--coin` with `--on-coin` text.
- The bottom bar `.vbar`: three groups separated by 1 px `--line` dividers: transport (play, the slider, the time, the
  step buttons, the tick chip), speed + jump-to, view toggles (ghost, path, EE graphics, ⚙) as compact chips with their
  checkboxes. The slider `accent-color: var(--coin)`.
- Panels (`.vguide`, `.vgfxp`, `.vlegend`): `--panel` at 96% with `--shadow-float`, radius `--r3`.

---

## 8. The level editor (editor.html)

### 8.1 Layout

```
┌ nav: (•) EE Auto TAS  Runs  Editor  Stats        [Loaded from job…][200 × 200][GPU: RTX 3080]  [◐] ┐
├ left (262) ───┬ map (stagewrap.night) ──────────────────────────────┬ right (340) ───────────────────┤
│ Selected block│ [tools: paint erase rect pick guide | undo redo |   │ Find a route            GPU    │
│ (card)        │  zoom − + Fit | EE graphics grid frontier explore │ checks list                    │
│               │  Follow | job's run]                                │ Settings (2-col grid)          │
│ Blocks        │                                                     │ Search   [Find a route] [Find and optimize]
│ (card,        │  the map                                            │ Compile  [Compile] [Hybrid (best)]
│  scrolls)     │                                                     │ [Stop]                         │
│               │                                                     │ run panels (newest first)      │
│               │ status line                                         │ Level (card)                   │
└───────────────┴─────────────────────────────────────────────────────┴────────────────────────────────┘
```

- `.main` grid `262px minmax(0, 1fr) 340px`, gap 12, padding 0 12 12 (breakpoints in section 12).
- The map column `.stagewrap` gets the class `night`; its toolbar groups become `<span class="tgroup">` (never `div`,
  2.3) with the `.sep` dividers kept; toolbar buttons 30 px tall; the `.on` state `--coin-wash` fill, `--coin-ink` text,
  1 px `--coin-mark` border. Canvas, overlays and the stage internals are untouched (their CSS restyled only where it
  uses old colors: `#ffd23f` -> `var(--coin)`, `#4a3d18` borders -> `var(--coin-mark)` at 50%).
- Left column cards: titles in the card-title style; the palette grid unchanged (36 px swatches), the selected swatch a
  2 px `--coin` ring.

### 8.2 The right column

**Find a route card** (`#routeCard`, ids kept):

- Title "Find a route" with `#rcSub` as a `.chip` ("GPU" / "CPU only").
- `#checks` list: 18 px status icons (`.ic.ok` `--ahead-wash`/`--ahead`, `.ic.no`, `.ic.warn`, `.ic.opt`), 13.5 px text.
- Settings as a 2-column grid of labelled selects: "Search for" (`#sSec`), "States per tick" (`#sWidth`), "Hybrid
  restarts after" (`#sHyStall`, the label's tail "stuck" kept in its title).
- Actions in two labelled rows: **Search**: `Find a route` (`#bSolve`, `.go`), `Find and optimize` (`#bAuto`);
  **Compile**: `Compile` (`#bCompile`), `Hybrid (best)` (`#bHybrid`, `.go`). `#bStop` (`.stop`) under them, full width,
  shown only while something runs. Under the rows a `.hint` in plain words: "Find a route searches for any way to the
  trophy (GPU and CPU). Compile builds the inputs from the level, without a search. Hybrid runs both until a route, then
  polishes it." (it replaces the old header line).
- **Run panels** (`#compileSt`, `#hybridSt`, `#autoSt`, `#solveWhy`, `#solveSt`): each renders as a `.runp` (new class
  in the renderers that are not frozen; `renderHybrid`'s `.hyBox` is styled the same): `--raise`, radius `--r2`, padding
  10 12; a header row (bold title, a status chip, the elapsed time right-aligned in `--f-num`), then the body. Routes
  tables (`.hyRoutes`) use the `.tbl` look at 12 px; the best row's time `--ahead` 600 (as today).
- The result card `.result`: the time in `--f-num` 36 px `--ahead` (route found) or `--warn` (nearest only, `.near`);
  `.stale` `--muted`.

**The Hybrid's Optimizer view**: under `#hybridSt` add `<div id="hyTape" class="tl tl-compact"></div>` and, at the very
end of `renderHybrid` (one new line, the only edit inside the HYB region):

```js
	if (typeof TL === 'object' && s.timeline) TL.render($('hyTape'), s.timeline, { compact: true, sheet: 'hySheet' });
```

(`typeof TL` is safe in the test's sandbox; `s.timeline` comes from the server, 11.4). The compact view shows the now
sentence, the lanes (Compiler, Search, Prefix search, Optimizer) and the best-route steps in 300 px; its "Open the full
view" button opens the sheet `#hySheet` (below).

**The sheet** `#hySheet` (new, inside `.stagewrap` (which gets `position: relative`), after `.status`): a panel that slides up over the lower 45% of the
map (`position: absolute; left: 0; right: 0; bottom: 30px`), `--panel` night, top radius `--r3`, `--shadow-float`, a
title row ("Hybrid run", the elapsed time, a close button), and the full-width Optimizer view (`TL.render(..., {compact:
false})`). Esc closes it (only when it is open: append the key check at the end of the script, never inside the
existing key handler).

**Level card** (ids kept): unchanged content, restyled; `#lvPick` full width.

---

## 9. The Optimizer view

One component, `TL` in `src/app/timeline.js`, renders a **timeline model** (11.3) built by the server. Two sources:

- a job's optimizer (`GET /api/jobs/:id/phases`): lanes = the round's stages, the sweep lanes, the corridor beam, the GPU,
  hand-ins;
- the editor's Hybrid run (`GET /api/editor/hybrid` `timeline`): lanes = Compiler, Search, Prefix search, Optimizer.

### 9.1 Anatomy (the job page, full width)

```
Optimizer                              [Session] [15 min] [1 h] [6 h] [All]        13.1 M + 384 M ticks/s
─────────────────────────────────────────────────────────────────────────────────────────────────────────
Round 3: Route sweep, exploring ticks 1,800–2,600 (window 4 of 12) on 3 lanes. The GPU tries random variations.
Last find 2 min ago: −54 ticks by GPU input tweaks.                                            (now, 16 px)

Round 3   ✓Input tweaks  –Skip finder  ✓Exact finish  ●Route sweep  Skip search  Corridor beam  Input tweaks …
          (the round recipe: one chip per stage of this round, in order)

 2:31.20 ┐                                                                        best time
         └──┐                                                                     (step line, 120 px)
            └─────┐                                                                 drops colored by
 1:50.53          └──────────────────────────────◆──────────────────────────◆─   the family that found them
─────────────────────────────────────────────────────────────────────────────────────────────────────────
 Stages     ▇▇Input tweaks▇▇│▇Exact▇│▇▇▇▇▇▇▇▇▇▇▇ Route sweep ▇▇▇▇▇▇▇▇▇▇▇▇│▇Skip│▇▇Local▇▇│▇Beam▇│┃
 Sweep                       ▬▬ ▬▬▬ ▬▬  ▬▬▬ ▬▬                                                  ┃
                             ▬▬▬ ▬▬ ▬▬▬ ▬▬   (4 thin sub-rows: one per sweep lane, a bar a window)┃
 Corridor   ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇┃
 GPU        ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇┃
 Handed in       ◇                    ◇                                                              ┃
            14:00        14:10   |R2     14:20        14:30   |R3    14:40                         now
─────────────────────────────────────────────────────────────────────────────────────────────────────────
■ Input tweaks  ■ Route explore  ■ Path changes  ■ Local search  ■ Finish & timing  ■ Combine   ◆ a find
─────────────────────────────────────────────────────────────────────────────────────────────────────────
What found time (this range)                                                        [Show every stage]
 Phase              Time     Runs   Finds   Saved        Per minute
 ■ GPU input tweaks 1 h 12   41     58      −2,412 ticks 33.5
 ■ Route sweep      38 min   19     6       −1,129       29.7
 ...
```

**Header row** (`.sec-h`): the title "Optimizer", the range control (`.seg`: "Session", "15 min", "1 h", "6 h", "All";
default "Session" = the current session when running, else the last one; remembered in
`localStorage['eeat.ui.range']`), the live speed on the right (`model.speed`: "13.1 M + 384 M ticks/s", its title the
CPU threads and the GPU's name; `--muted` between stages).

**Now** (`.tl-now`, 16 px, `--ink`; the numbers `--f-num` 600): the server's `now.text` (11.3). When stopped: "Paused.
The last session ran 2 h 14 min and found 312 ticks; the best is 1:50.53." Never more than 3 lines.

**Round recipe** (`.tl-recipe`): "Round N" (`--f-num` 14 px 600), then one chip per stage key of `rounds[last].order`:
done = the family swatch + label in `--ink-2`; the current = `--coin-wash` fill, 1 px `--coin-mark`, `--ink` text;
skipped = `--muted` with a line-through and its reason in the title ("skipped: the GPU searches these input changes");
to come = `--muted`. Each chip's title: the one-line explanation from the dictionary. On the hybrid: the recipe is the
compiler's stage list (parse, model, bounds, plan, moves, verify, polish, ...).

**The figure** (one SVG, `width: 100%`, height = 120 + lanes x 26 + 24; a shared x-axis):

- **Best time** (top, 120 px): a step line (`UI.steps`) in `--ink-2` 2 px from the range start's best to now; every drop
  is a 3 px vertical segment in the color of the family that found it, with an 8 px dot (2 px ring) at its bottom. The
  y-axis on the left: 3 ticks (the range's highest best, the current best, one between) as run times. When the range
  holds no find, a flat line and the label "No find in this range".
- **The tape** (below): one row per lane, 22 px tall, 4 px apart, on `--sunken`; the lane label column is 96 px, sticky
  left, 12 px `--ink-2`. Blocks are rects (radius 3, 2 px surface gap between neighbors) in their family color from
  `t0` to `t1` (a running block to "now", its right edge a 2 px `--coin` line); the block label (the stage's plain name)
  inside when it fits (3.4). The sweep: one block per window, on 4 thin sub-rows of the "Sweep" lane (each 4 px; the
  lane is 22 px with 4 sub-rows of 4 px + 3 gaps of 2 px); its label "Route sweep" sits once over the round's sweep
  stretch. Round boundaries: a 1 px `--line-2` vertical line through the tape with "R3" (11 px `--muted`) at the axis.
- **Find marks**: a 9 px gold diamond (`--coin-mark`, 2 px surface ring) on the lane and at the time of the span whose
  output was accepted (or on "Handed in" for inbox / try finds); a hand-in that was not accepted is a hollow `--muted`
  diamond.
- **Now playhead**: while running, a 2 px `--coin` line through the whole figure at "now" with a 6 px tab on the axis.
- **Axis**: clock times at round 5 / 10 / 15 / 30 / 60 min steps (as the range allows), 11 px `--muted`, tabular.
- **Hover**: a vertical crosshair through the chart and the tape; the tooltip lists the best time at that moment and, per
  lane, what ran then ("Route sweep, ticks 1,800–2,600, 3 threads, 2 min 00 s, saved 54"). A block or a diamond has its own
  tooltip (label, explanation, times, threads, window, result).
- **Accessibility**: the SVG has `role="img"` and an `aria-label` = the now text; the scoreboard is its table equivalent.

**Legend** (`.tl-legend`): the families present in the range, swatch + label, then "◆ a find". Click a family to
highlight its blocks (others at 35% opacity); click again to clear.

**Scoreboard** (`.tbl`, "What found time (this range)"): one row per family by default (a toggle "Show every stage" splits
them by stage key), columns Phase (swatch + label), Time (the CPU time the lanes spent in it, summed), Runs, Finds,
Saved (ticks, `--ahead`), Per minute (ticks saved per minute of its time; one decimal). Sorted by Saved. Rows with no
time in the range are hidden. This answers "what is working".

**Phase guide** (a `details` under the scoreboard, "What the phases do"): the dictionary's labels and one-liners for the
families and stages this level uses (11.2).

### 9.2 The compact view (the editor's right column)

300 px wide: the now text (13.5 px, 3 lines max), the best-route steps (60 px), the 4 lanes (16 px each, no labels inside
blocks), the lane names as 11 px labels, the legend reduced to the lane names. A `.ghost.small` "Open the full view"
opens the sheet (8.2).

### 9.3 The hybrid's model (what the lanes show)

- **Compiler** lane: one block per compiler stage (`compiler.stages`: [t, name, ms] -> a block [t - ms, t]) in the
  part color `--ph-explore` with the stage's plain name; the current stage open-ended; rounds of the compiler (a new
  `compile_r<k>`) start a new run of blocks with a "C2" round line.
- **Search** lane: one block per search run (from the start or a restart to the next restart or its end), `--ph-tweak`,
  labelled "Find a route" then "Optimizing" once the search's state turns `optimizing` (`search.states`).
- **Prefix search** lane: a block while `prefix` is set, `--ph-path`.
- **Optimizer** lane: from the first route on, a `--ph-local` block labelled "Polish".
- **Marks**: every verified route as a diamond on the lane of its `by` part, and the best-route steps above from
  `routes[]`; restarts as a `--behind` 1 px dashed vertical line labelled "restart 1".
- **Now**: "35:05 in. The compiler is building moves (round 2: 1,234 anchors, furthest coins=3, 12.4 tiles to go).
  Find a route (run 2): 13.4 tiles from the trophy, 22 rooms. No route yet; it starts fresh after 30:00 without progress
  (the last progress 1:15 ago)." / "Route found by the compiler at 34:10 (0:41.00). Polishing it: 1:10 left."

### 9.4 The plain names (rendered from the model; the server owns the text)

The model carries each block's `label` and `explain`; the UI never invents names. The dictionary is in section 11.2.

### 9.5 Updating

- Job page: `TL.mount($('opt'), {job: id})` on selection; it fetches `/api/jobs/:id/phases?range=<k>&sig=<last sig>`
  every 3 s while the job runs and the tab is visible (`document.visibilityState`), once when it is stopped (and again when
  `bestVersion` changes). `{unchanged: true}` keeps the drawing. The SVG is rebuilt only when the model changed; the now
  line and the playhead advance every second without a fetch.
- Hybrid: rendered from each `/api/editor/hybrid` poll (1 s) by the hook line (8.2).
- Rendering cost: at most 2,000 blocks (the server caps the model, 11.3); one SVG string per render.

### 9.6 New best: the one moment

When the model's best drops (job) or a route arrives (hybrid): the hero time (`#detail .big`) slides the new value in
from 6 px below (180 ms ease-out), the new diamond scales from 0 to 1 and draws one expanding gold ring (600 ms), the
toast's left bar is `--coin`. Nothing else moves. `prefers-reduced-motion: reduce`: no motion at all.

---

## 10. The Stats page (stats.html)

A separate page at `/stats` with the shared nav. Two views as a `.seg` under the title: **Your runs** (`#runs`, the
default) and **Benchmarks** (`#bench` or `#bench=<id>`); the hash keeps the view.

### 10.1 Your runs

```
Stats                                                       [Your runs] [Benchmarks]
┌ kpi ───────────┬ kpi ─────────────────┬ kpi ──────────┬ kpi ──────────────────┬ kpi ───────────────┐
│ Runs           │ Time saved           │ Improvements  │ Optimizer time        │ Simulated          │
│ 159            │ 12:34.56             │ 4,812         │ ≈ 312 h               │ 1.4 trillion ticks │
│ 1 optimizing   │ 8.1% of the originals│ 38 today      │ since 2026-09-24      │ since events began │
└────────────────┴──────────────────────┴───────────────┴───────────────────────┴────────────────────┘
┌ Where the time came from ─────────────────────┐ ┌ Recent improvements ───────────────────────────┐
│ ■ Input tweaks     ████████████  −41,203      │ │ 14:31  Forgotten Veil  −54   1:50.53  ■ Route sweep
│ ■ Route explore    ███████       −22,118      │ │ 14:28  Ice level       −3    0:45.79  ■ Corridor beam
│ ■ Path changes     ██            −6,310       │ │ ... (20 rows)                                  │
│ ...                                           │ └────────────────────────────────────────────────┘
└───────────────────────────────────────────────┘
All runs                                                            [Filter runs        ]
 Run              Section   Original   Best      Saved        %      Finds  Optimized  Last find   Trend
 Forgotten Veil   Campaign  2:31.20    1:50.53   −40.67 s     26.9   312    14 h 05    2 min ago   ╲___  [Watch]
 ...
```

- KPI tiles (`.kpi`, a grid `repeat(auto-fit, minmax(180px, 1fr))`): **Runs** (count; sub "N optimizing"), **Time saved**
  (the sum of `savedTicks` as a time; sub: percent of the sum of the originals), **Improvements** (the count of history
  entries; sub: how many today), **Optimizer time** (the sum of sessions; "≈" when any part is estimated from logs; sub:
  since the oldest run's creation), **Simulated** (ticks from the events; hidden when no run has events yet).
- **Where the time came from**: horizontal bars, one per family (the family color, 24 px max thick, 4 px rounded end),
  value at the tip (`−41,203 ticks`), sorted; the title of a bar: finds and the stages in it. Single measure: no legend
  (the labels name the bars).
- **Recent improvements**: the last 20 across runs: time, run name (link to `/#job=<id>`), saved (`--ahead`), the new
  best, the family swatch + label.
- **All runs**: a `.tbl` with the group rows Campaign / Other (folding, like the runs list), sortable by every column
  (default: last find, newest first); Trend = `UI.spark` (120 x 28: the best time over wall time as a step line, 1.5 px
  `--ink-2`, the last point an 8 px `--coin-mark` dot, no axes; tooltip: first and last best with dates); row actions
  `Watch` (`/#watch=<id>`) and the name links to `/#job=<id>`. A filter field above it.
- Data: `GET /api/stats` (11.5), fetched on load and every 30 s while visible.

### 10.2 Benchmarks

A benchmark is an imported results table (the hybrid CSV format, 11.6). The page lists them; with none:

> **No benchmarks yet.** Import a results table to compare runs of the whole level set: `node tools/stats-import.js
> <file.csv>` (or `EEAutoTAS.exe tools/stats-import.js <file.csv>`). It is copied into the app's data folder and shows
> up here.

```
Benchmarks: [Hybrid, 220 test levels ▾]                                    imported 2026-10-02 from hybrid_levels.csv
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 189 of 220 routed                                                                                      │
│ 185 confirmed in the app; 4 need random portals the app could not confirm                              │
│ Campaign  175 of 203  ███████████████████████████████████████████▉  86%                               │
│ Other      14 of 17   █████████████████████████████████████████      82%                               │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ How it compares ────────────────┐ ┌ First route found by ───────────┐ ┌ Time to solve ────────────────────┐
│ The hybrid        189  ████████ │ │ ████████████████████▓▓▓▓▓▓░░    │ │      ▆                            │
│ Search alone      134  █████▌   │ │ Search 134  Compiler 48         │ │    ▆ █ █ ▆                        │
│ Compiler alone     48  ██       │ │ Optimizer 4  Prefix search 3    │ │  ▃ █ █ █ █ ▃ ▃ ▂                  │
│ Either alone      139  █████▊   │ └─────────────────────────────────┘ │ ≤10s 30s 1m 2m 5m 10m 30m 1h >1h  │
│ Only the hybrid    51           │                                     │ median 4 min 01 s, 90% by 39 min  │
└─────────────────────────────────┘                                     └───────────────────────────────────┘
┌ Routed within ──────────────────────────────────────────┐ ┌ Route quality vs the best known TAS ───────┐
│ 189 ┤                                       ___/ hybrid  │ │ 88 levels with a best known TAS            │
│     │                          ____-----‾‾‾              │ │ 33 at or under it, 52 within 10%           │
│ 134 ┤        ____----‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ search alone  │ │ median 1.048 × the best known              │
│     │ __--‾‾                                             │ │ ··:··|·::::·:··  ·   ·      (dot strip)    │
│   0 ┼──────┬──────┬──────┬──────┬──────┬──────           │ │ 0.6×   1×    1.2×   1.5×   2×+             │
│     1 s   10 s   1 min  10 min  1 h   2 h  (log time)    │ └────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────┘
Levels                [All | Campaign | Other]  [Any result ▾]  [First route by: any ▾]  [Find a level    ]  [ ] only levels with a run
 Level                 Result   Solved in  First route by  Best route  Best known  vs known  Search alone      Compiler alone  Run
 Campaign: 175 of 203 routed ▾
 Tutorial 1            Routed   0:20       Compiler        0:19.63     0:16.55     1.186     0:10 -> 0:16.83   Routed          10-min run   [Watch]
 ...
```

- **Picker**: a `select` of the imported benchmarks (name, levels) when there is more than one, else the name as a title;
  "imported <date> from <file>" on the right, `--muted`.
- **Headline** (the one hero number of the view): "189 of 220 routed" in `--f-num` 36 px (the count) + 18 px (the rest);
  the confirmed sentence 13.5 px `--ink-2`; one meter per section (`.bar` with `--ahead`), "175 of 203" and the percent.
  (Stats keeps gold for bests only: the dots of the quality strip at or under the best known.)
- **How it compares**: horizontal bars colored by who: the hybrid `--ink-2`, Search alone `--ph-tweak`, Compiler alone
  `--ph-explore` (the part colors), Either alone `--muted`; rows: the hybrid
  (routed), Search alone (rows whose search-alone cell has a route), Compiler alone (rows whose compiler-alone cell is
  "routed"), Either alone (either of the two), Only the hybrid (routed by the hybrid and by neither alone; a number, no
  bar). Under it, 12 px `--muted`: "Search alone: one 10-minute run per level. Compiler alone: one 5-minute run per level."
  (the column titles say so; the import keeps them).
- **First route found by**: a 100% stacked bar (`UI.stack`, 24 px tall, 2 px gaps) in the hybrid part colors (Search
  `--ph-tweak`, Compiler `--ph-explore`, Optimizer `--ph-local`, Prefix search `--ph-path`) with the legend under it as
  "Search 134" etc. (swatch + label + count); hover shows the share.
- **Time to solve**: a histogram (`UI.histo`), columns at most 24 px, one color (`--ink-2`: the hybrid), 9 bins by the solve time
  of the routed levels: ≤ 10 s, 10-30 s, 30 s-1 min, 1-2 min, 2-5 min, 5-10 min, 10-30 min, 30-60 min, > 1 h; the
  count at each column's top; under it the median and the 90th percentile.
- **Routed within**: a cumulative step chart (`UI.steps`), x = solve time on a log scale (1 s to the largest), y = levels
  routed by then; two lines: the hybrid (`--ink`, 2 px) and the search alone (`--ph-tweak`, 2 px) from its solve
  times; direct labels at the line ends ("the hybrid 189", "search alone 134"); a legend under it; the compiler alone
  has no solve times: a note "Compiler alone: 48 levels within its 5-minute run (no times recorded)". Crosshair hover:
  "by 10 min: the hybrid 136, search alone 120".
- **Route quality**: for rows with both a best route and a best known TAS: the ratio best / known. Three numbers in text
  (count with a known TAS, at or under it, within 10%, median ratio), then a dot strip (one 6 px dot per level on a
  0.6x-2x+ axis, `--ink-2` at 60%, the dots at or under 1.0 in `--coin-mark`; a 1 px `--line-2` line at 1.0); hover a dot
  for the level and both times.
- **The table**: filters in one row above it (`.seg` All / Campaign / Other, a Result select: Any result / Routed / Not
  confirmed / No route, a First-route-by select, a search field, "Only levels with a run" checkbox); the count of shown
  rows on the right ("Showing 175 of 220"). Columns, all sortable (default: section, then the file's order): Level,
  Result (a status chip: "Routed" `--ahead`, "Not confirmed" `--warn` with the reason in its title, "No route"
  `--behind`), Solved in (m:ss / h:mm:ss), First route by, Best route, Best known, vs known (the ratio, 3 decimals; `--ahead`
  when ≤ 1.000), Search alone ("0:10 -> 0:16.83" or "No route"), Compiler alone, Run (the file's "which run" text, e.g.
  "10-min run"), and the actions: `Watch` (`/#watch=<job>`) and the level name as a link (`/#job=<job>`) when a run of
  that level is in the app (11.6 `jobs`). With "All", group rows "Campaign: 175 of 203 routed" and "Other: 14 of 17
  routed" (folding). The merged-copies column is not a column: a level with merged copies shows a small "+2 copies" chip
  with the names in its title.
- Data: `GET /api/stats/benchmarks` (the list) and `GET /api/stats/benchmarks/:id` (one), fetched once (no polling;
  "Refresh" in the nav re-fetches).

Expected numbers for the benchmark the user has today (the import and the page must show these): 220 levels; routed 189,
confirmed 185; campaign 175 of 203, other 14 of 17; search alone 134, compiler alone 48, either alone 139, only the hybrid
51; first route by search 134, compiler 48, optimizer 4, prefix 3; time-to-solve bins 7, 12, 11, 32, 44, 42, 17, 17, 7
(median 241 s, 90th percentile 2,359 s, max 6,516 s); with a best known TAS 88, at or under it 33, within 10% 52, median
ratio 1.048.

---

## 11. Data contracts

### 11.1 The structured stage log (new, backward compatible)

Nothing existing changes: `status.json`, `grind.log`, `history`, `live.json`, `gpu_status.json` stay as they are. Two
append-only files are added.

`src/events.js`: `open(file, {maxBytes = 8 << 20})` -> `{ ev(obj) }`; `ev` adds `t: Date.now()` when missing and
appends `JSON.stringify(obj) + '\n'` with `fs.appendFileSync` (errors ignored); when the file passes `maxBytes` it is
renamed to `<name>.1.jsonl` (one old file kept) before the write. The first line of every file is the session line, which
carries `v: 1`.

**`src/jobs/<id>/grind_events.jsonl`** (written by grind.js):

| ev | Fields | Written |
|---|---|---|
| `session` | `v: 1`, `pid`, `workers` (W), `flyK`, `gpu` (bool), `roundMin`, `best` (run ticks), `orig`, `phaseOrder` (bool: STAGES_PHASE in use) | at the start of `main()` |
| `beat` | (none) | every 60 s from the live timer, only when no other event was written in the last 60 s (the session's length) |
| `round` | `round`, `order` (the stage keys of STAGES for this round), `resume` (key or null) | at each round's start, after `redecideCoins` |
| `stage` | `id` (a counter for the session), `lane` (`stages` / `sweep` / `fly`), `sub` (sweep lane 0-3), `key` (the stage key of `STAGES_ALL` / `STAGES_PHASE`: `mutA`, `skipfA`, `endgame`, `deep`, `skips`, `skipf`, `flyb`, `mutB`, `sc`, `phase`, `phaseB`, `mutC`, `beam`, `splice`; or for the pieces of `deep`: `sweep`, `loop`, `seg`; `fly` for the corridor-beam lane), `name` (the log name, e.g. `sweep3_4`, `mutate_3b_1`), `round`, `threads` (the `--workers` / `--threads` the tool really got, after the `cpu_share` cut), `w0`, `w1` (the window, when the tool has one), `of` (the run's ticks), `note` | in `runTool`, at the spawn: a new optional last argument `meta` carries lane, sub, key, name, round, w0, w1, note; `stage()` passes lane `stages` and its name; the sweep lanes pass lane `sweep` and their lane index as `sub` (a window's `phase.js --edges` pass is a second span in the same sub, name `<name>p`); the flybeam lane passes lane `fly`; `spliceAll` and `recoverOutputs` pass lane `stages`, key `splice`. **The sweep as a whole** (`sweepStage` runs no tool of its own) writes a `stage` (lane `stages`, key `deep`, name `sweep<r>`) at its start and a `stageEnd` at its end, with no tool fields, so the Stages lane shows "Route sweep" for its whole duration while the Sweep lane shows the windows |
| `stageEnd` | `id`, `code`, `killed`, `grown`, `ticks` (simulated by it: its lane's count at the end) | in `runTool` at `close` / `error`; the sweep's own end in `sweepStage` |
| `stageResult` | `id`, `saved` (the window's own find in ticks against its start run; 0 = nothing) | after the sweep window's and the loop window's result lines ("its window saves N" / "nothing in this window", "a way around the loop, -N" / "no way around the loop found"); the reader merges it into the span |
| `skip` | `round`, `key`, `name`, `why` | where the grind logs "skipped" (mutate while the GPU searches, `--skip`, "nothing changed since the last pass", the beam "stopped by the restart; not repeated") |
| `best` | `runTicks`, `saved`, `what`, `span` (the id of the running span whose name equals `what`, else null), `source` (`stage` / `inbox` / `splice` / `try` / `recover`), `chance`, `deaths` | in `consider()` on accept (next to the history push) |
| `roundEnd` | `round`, `ms`, `best` | after "round N done" |
| `end` | `why` (`finished` / `error` / `exit`) | at "finished", in the error handler, and `process.on('exit')` (best effort) |

**`src/jobs/<id>/gpu/events.jsonl`** (written by gpusearch.js):

| ev | Fields | Written |
|---|---|---|
| `gpuStart` | `v: 1`, `name`, `ticksPerSec` (the benchmark), `coinMode` | at start |
| `slot` | `id`, `round`, `arm` (`search` / `every` / `idle`), `fam` (`m1`, `del`, `m2`, `pert`, `flip`, `sticky`, `every`, `idle`), `w0`, `w1` | before each eegpu invocation (`invoke`, `runEvery`, `runIdle`) |
| `slotEnd` | `id`, `s` (seconds), `ticks`, `added` (new library edges), `err` (text or null) | after it |
| `find` | `from`, `to` (run ticks), `saved`, `fams` (`{"m1": -1, "pert": -303, ...}` as in the log's brackets), `other` (ticks credited to other runs), `handed` (bool) | in `offer()` when it hands a run in |
| `pause` / `resume` | `why` | `yieldToEditor` (Find a route has the GPU) |
| `fail` | `err`, `wait` (s) | `failed()` |

Cost: a few lines a minute (~1 MB a day per file); writes are synchronous appends of ~150 bytes. A grind that runs
during the upgrade writes no events: the reader falls back (11.3).

### 11.2 The phase dictionary (`src/phases.js`)

Families (the key, the label, the CSS variable):

| fam | Label | Color var | What it is |
|---|---|---|---|
| `tweak` | Input tweaks | `--ph-tweak` | Changing one or two inputs, or random variations of the run, and keeping changes that meet the run again sooner |
| `explore` | Route explore | `--ph-explore` | Trying every move in a window of the run |
| `path` | Path changes | `--ph-path` | Taking another way from somewhere along the run |
| `local` | Local search | `--ph-local` | Small searches along the run: shortcuts, beams, the corridor beam |
| `finish` | Finish & timing | `--ph-finish` | The exact ending and the timing of time doors and the start |
| `combine` | Combine | `--ph-combine` | Joining the best run with other runs' faster stretches |
| `outside` | Handed in | `--ph-outside` | Runs handed in from outside the optimizer: Find a route, you, a rented machine |

Stages (matched on a span's `name`, a history entry's `what`, or a GPU slot's `fam`; first match wins):

| key | Matches | Label | fam | One line (`explain`) |
|---|---|---|---|---|
| `mut` | `^mutate_` | Input tweaks | tweak | Changes one or two inputs at every tick and keeps every change that rejoins the run sooner. |
| `skipf` | `^skipfind` | Skip finder | path | From states all along the run, searches for a later point it can reach sooner another way. |
| `endgame` | `^endgame` | Exact finish | finish | Tries every input over the run's last ticks; when nothing is faster, the ending is proven. |
| `sweep` | `^sweep\d+(_\d+)?$` | Route sweep | explore | Tries every move in 8-second windows across the whole run, up to 4 windows at once. |
| `loop` | `^deep\d+_loop` | Loop cutter | explore | Looks for a way around a stretch where the run comes back to where it was. |
| `seg` | `^deep\d+_seg` | Coin-to-coin explore | explore | Tries every move between coins, one window after another. |
| `skips` | `^skips\d` | Skip search | path | Finds spots the run passes early and only uses later, and tries every move from there. |
| `flyb` | `^flybeam` (stage and lane) | Corridor beam | local | Follows long flying, falling or sliding stretches with thousands of variations at once. |
| `sc` | `^shortcuts` | Local shortcuts | local | Searches many small shortcuts from a cursor that moves along the run. |
| `phase` | `^phaseb?\d` | Time doors | finish | Shifts the run so time and coin doors open sooner, with free idle ticks before the first input. |
| `beam` | `^beam\d` | Beam search | local | Plays thousands of runs side by side and keeps the ones furthest ahead. |
| `splice` | `^splice$`, ` \+ best \(splice`, `^\d+ earlier runs` | Combine | combine | Joins the best run with every other run's faster stretches where they reach the same state. |
| `gpu-m1` | slot `m1` | GPU: one-input tweaks | tweak | The GPU changes single inputs at every tick, millions at a time. |
| `gpu-del` | slot `del` | GPU: skipped ticks | tweak | The GPU tries leaving ticks out. |
| `gpu-m2` | slot `m2` | GPU: two-input tweaks | tweak | The GPU changes pairs of inputs. |
| `gpu-rand` | slot `pert`, `flip`, `sticky` | GPU: random variations | tweak | The GPU tries random variations of stretches of the run. |
| `gpu-every` | slot `every` | GPU: every move | explore | The GPU tries every move in short windows along the run. |
| `gpu-idle` | slot `idle` | GPU: idle start | finish | The GPU waits before the first input (free: the timer starts there) and looks for faster ways from there. |
| `gpu` | what `^inbox \(gpu ` / `^try: gpu` | GPU search | the family of the largest saving in the matching `find` event (within 5 s before), else tweak | The GPU searcher's find, checked by the optimizer. |
| `focus` | what `^(inbox \(\|try: )focus` | Search harder | explore | Your "Search harder" range, searched next to the optimizer. |
| `fr` | what `^(inbox \(\|try: )Find a route` | Find a route | outside | A route from Find a route, handed to the optimizer. |
| `remote` | what `^try: .*farm`, or the job's remote `source` | Rented machine | outside | A faster run from the copy on a rented machine. |
| `in` | what `^inbox \(` / `^try: ` (rest) | Handed in | outside | A run handed in from outside (a script, `tas.js try`). |
| `other` | anything else | (the raw name) | combine | |

The hybrid's compiler stages: `parse` "Reading the level", `model` "Level model", `bounds` "Bounds", `plan` "Planning the
order", `moves` "Building the moves", `verify` "Verifying", `polish` "Polishing", `perfect` "Order and polish", `loops`
"Cutting loops", `joins` "Carrying speed across joins", `endgame` "Exact finish", `prove` "Proving legs", others by
their name. Search states: `finding` "Find a route", `optimizing` "Optimizing", `ended` "Ended".

Exports: `FAMS`, `STAGES`, `classify(nameOrWhat, ctx)` -> `{key, fam, label, explain}`, `jobTimeline(id, {range, sig})`,
`hybridTimeline(state)`, `nowJob(model, summary)`, `nowHybrid(state)`, `legacyJob(id)`.

### 11.3 `GET /api/jobs/:id/phases?range=<session|15m|1h|6h|all>&sig=<sig>`

Response (the timeline model; times in ms since the epoch):

```js
{
	v: 1, kind: 'job', job: '<id>', sig: '<events size>-<gpu events size>-<history length>-<running>',
	unchanged: false,               // true (and nothing else) when ?sig= equals sig
	running: true, legacy: false,   // legacy: built from grind.log (11.3.1)
	range: 'session', t0: 1790898534000, tNow: 1790902134000,
	now: { text: 'Round 3: Route sweep, exploring ticks 1,800–2,600 (window 4 of 12) on 3 lanes. ...', round: 3, key: 'sweep', label: 'Route sweep', fam: 'explore', since: 1790902014000 },
	speed: { cpu: 13100000, gpu: 384000000, threads: 8, gpuName: 'NVIDIA ...' } | null,
	lanes: [ { id: 'stages', label: 'Stages' }, { id: 'sweep', label: 'Sweep', subs: 4 }, { id: 'fly', label: 'Corridor beam' },
		{ id: 'gpu', label: 'GPU' }, { id: 'in', label: 'Handed in', marks: true } ],            // only lanes with something in range
	spans: [ { id: 57, lane: 'sweep', sub: 2, key: 'sweep', fam: 'explore', label: 'Route sweep', explain: '...',
		detail: 'ticks 1,800–2,600, 3 threads', round: 3, t0, t1: null, threads: 3, w0: 1800, w1: 2600, saved: 54, finds: 1 } ],
	rounds: [ { round: 3, t0, t1: null, order: ['mutA', 'skipfA', 'endgame', 'deep', ...],
		recipe: [ { key: 'mutA', label: 'Input tweaks', fam: 'tweak', state: 'done' | 'now' | 'skipped' | 'next', why: '...' } ] } ],
	marks: [ { t, lane: 'sweep', kind: 'best' | 'handin' | 'refused', runTicks, saved, fam, label, what, span: 57 } ],
	best: [ [t, runTicks], ... ],   // the steps in range: the first point is the best at t0
	base: { runTicks, time, label: 'original' },
	score: [ { fam: 'tweak', key: 'gpu-rand', label: 'GPU: random variations', ms, runs, finds, saved } ],
	history: [ { t, runTicks, saved, what, key, fam, label, round, span } ]   // ALL history entries, classified (not only the range)
}
```

Rules:

- `range` limits spans, marks and best points to `[tNow - range, tNow]` (`session`: from the current or last `session` event; `all`: from the first event or the first
  history entry); at most 2,000 spans (the newest kept; consecutive GPU slots of one family shorter than (range / 600) merged into one
  block per family run).
- `score` counts spans in range (the sweep's whole-duration span, key `deep` with no tool, counts 0: its windows count;
  `skip` events make the recipe's `skipped` chips): `ms` = the span's duration x its threads / W for CPU lanes (so 4 sweep lanes of 3
  threads count as their share), the plain duration for the GPU; `finds` / `saved` from `best` events linked by `span`,
  GPU finds by `find` events' `fams`.
- `now.text` (`nowJob`): `Round N: <label>, <detail>.` + (sweep) `on <n> lanes` + (GPU running) ` The GPU <gpu label in
  lower case>.` + (last find) ` Last find <ago> ago: −<saved> ticks by <label>.`; stopped: `Paused. The last session ran
  <dur> and found <ticks> ticks; the best is <time>.`; starting: `Starting the optimizer...`; never started: `Not started
  yet. Press Start: the first minutes find the most time.`.
- `sig` lets the client skip unchanged payloads; the server keeps the parsed events per job in memory keyed by file size
  (a growing file is parsed from the last offset only).
- A job with no session at all (never started, no events, no `start:` line in `grind.log`): `spans: []`, `marks: []`,
  `best` = the original's one point, `rounds: [{ round: 1, t0: null, t1: null, order, recipe }]` with `order` = the first
  round's stage keys the grind would run on this level (`phases.js` copies grind.js's choice: `STAGES_PHASE` on a level
  with time doors or counting coin doors, else `STAGES_ALL`) and every chip `state: 'next'` (the preview of 6.6).
- The work runs only on request; `/api/state` is not touched.

#### 11.3.1 Legacy (jobs with no events file, or a grind that started before the upgrade)

`legacyJob(id)` reads `grind.log` (at most its last 4 MB) and builds the same model with `legacy: true`:

- The session = from the last `start:` line; dates: the clock times in `[grind HH:MM:SS]` anchored on `status.json
  sessionStarted` (that start line) or else the file's mtime (the last line), with a day added at every backward jump.
- Spans: a line `<name>...` or `<name> (<note>)...` starts a span of that name in its lane (sweep windows: the lane from
  "lane k/n"); it ends at the sweep / loop result line of that name, or at the next stage start in the same lane, or at
  "round N done"; the round boundaries from "round N done".
- Marks from `<what>: a -> b (-n)` lines and from `history`; the GPU lane only as one "GPU search" band from the first to
  the last `[gpu ...]` line, with marks from `GPU: ... handed to the grind` lines.
- The UI shows "Built from the log (times to the second). Restart the run for the full view." under the figure.

### 11.4 The hybrid (`GET /api/editor/hybrid`, additive)

- `tools/hybrid.js` `liveOf()` adds: `compiler.stages` = `R.compiler.stages.slice(-80)` ([seconds, name, ms]),
  `search.states` = `[[seconds, state], ...]` (append when `ctl.state().state` changes; last 40).
- `src/editor.js` `hybridState()` adds `timeline: PH.hybridTimeline(state)` (the model of 11.3 with `kind: 'hybrid'`,
  times = `started` + seconds x 1000, lanes `compiler` / `search` / `prefix` / `optimizer`, `best` from `live.routes`, marks
  for routes and restarts, `now.text` from `nowHybrid`). Built on each GET (small arrays).

### 11.5 `GET /api/stats`

```js
{
	t: 1790902134000,
	totals: { runs: 159, running: 1, savedTicks: 75456, originalTicks: 931200, improvements: 4812, today: 38,
		optimizedMs: 1123200000, optimizedApprox: true, simTicks: 1.4e12 | null, since: 1790000000000 },
	byFam: { tweak: { saved: 41203, finds: 2900 }, explore: { ... }, ... },
	recent: [ { t, job, name, runTicks, time, saved, what, fam, label } ],          // the newest 20
	jobs: [ { id, name, section: 'campaign' | 'other', campaign, created, running,
		original: { runTicks, time }, best: { runTicks, time }, savedTicks, pct, improvements,
		firstT, lastT, optimizedMs, approx, spark: [ [t, runTicks], ... ] /* <= 48 points */ } ]
}
```

- `optimizedMs` per job: the sum of sessions from `grind_events.jsonl` (each session: its `session` event to its last
  event), plus the sessions before the events from `grind.log` (`start:` lines to the last line before the next start;
  `approx: true` when any part came from the log). Cached in memory per job by the files' (size, mtime).
- `simTicks`: the sum of `stageEnd.ticks` and GPU `slotEnd.ticks`; null when no job has events.
- `spark`: the history as steps, downsampled to at most 48 points (always keep the first and the last).

### 11.6 Benchmarks: the import tool and the endpoints

`node tools/stats-import.js <file.csv> [--name="..."] [--id=<slug>]`, `--list`, `--remove=<id>`:

- Reads the CSV (UTF-8, a BOM stripped, `\r\n` or `\n`, RFC 4180 quotes and doubled quotes), maps the header by the
  column titles (case-insensitive, by these substrings: `section`, `level`, `hybrid result` (or `result`), `time to solve
  (s)`, `first route came from`, `best route time`, `which hybrid run` (or `which run`), `best known`, `search alone`,
  `compiler alone`, `identical copies`); unknown columns are kept per row in `extra`. Blank lines are skipped; a line whose
  first cell holds `TITLE: n of m ...` (e.g. `CAMPAIGN: 175 of 203 routed`) sets that section's title (its counts are
  recomputed from the rows, not trusted).
- Writes `<DATA>/benchmarks/<id>.json` (`C.DATA`, so `src/data/benchmarks/` in the repo: gitignored; the exe's
  `%LOCALAPPDATA%\EEAutoTAS\data\benchmarks\`) atomically (`C.writeAtomic`), prints the summary (the expected numbers of
  10.2 for the user's file) and the path. `--id` defaults to a slug of the name (the name defaults to the file's base
  name); an existing id is replaced.
- The JSON:

```js
{
	v: 1, id: 'hybrid-levels', name: 'Hybrid, 220 test levels', source: 'hybrid_levels.csv', imported: 1790902134000,
	columns: { searchAlone: 'search alone (10 min): solve -> route', compilerAlone: 'compiler alone (5 min)', ... },  // the original titles
	sections: [ { key: 'campaign', title: 'Campaign', routed: 175, total: 203 }, { key: 'other', title: 'Other', routed: 14, total: 17 } ],
	rows: [ {
		i: 0, section: 'campaign', level: 'Tutorial 1',
		result: 'routed' | 'unconfirmed' | 'none',   // "routed", "routed (random portals: not confirmed ...)", "no route"
		resultText: 'routed',                         // the cell as written
		solveS: 20 | null, by: 'compiler' | 'search' | 'optimizer' | 'prefix' | null,
		best: { time: '0:19.63', runTicks: 1963 } | null, run: '10-min run (all levels)',
		known: { time: '0:16.55', runTicks: 1655 } | null, ratio: 1.186 | null,
		searchAlone: { routed: true, solveS: 10, best: { time: '0:16.83', runTicks: 1683 } } | { routed: false } | null,
		compilerAlone: true | false | null,
		merged: [ '04_4_Egg_Quest_II', ... ],       // "identical copies merged", split on " = "
		extra: { }
	} ]
}
```

- `GET /api/stats/benchmarks` -> `{ benchmarks: [ { id, name, source, imported, levels, routed, confirmed, sections } ] }`
  (newest first); `GET /api/stats/benchmarks/:id` -> the JSON + `jobs: { "<row i>": "<job id>" }`: a row matches a job when
  the job's level name (`meta.level.name`, trimmed, case-insensitive) equals the row's level, or the job's name minus a
  trailing ` (hybrid)` / ` (compiled)` equals it, or (other levels: `Name (md5prefix)`) the job's `level.md5` starts with the
  hex in the row's parentheses; several matching jobs: the one with the best run. 404 JSON for an unknown id. Ids are
  checked against `^[a-z0-9-]{1,64}$` (no path from the URL).
- Both endpoints are listed in `GET /api`'s endpoint list, and in CLAUDE.md section 9 (with `/api/stats` and
  `/api/jobs/:id/phases`).

---

## 12. Responsive rules

| Width | Runs | Editor | Stats |
|---|---|---|---|
| ≥ 1200 | rail 320 + main | 262 / 1fr / 340 | KPI 5 across; the three benchmark panels in a row |
| 900-1199 | rail 280 + main | 250 / 1fr, the right column under the map, 2 columns of cards | KPI auto-fit; panels 2 across |
| 600-899 | one column: the rail becomes a "Your runs (159)" disclosure above the job sheet (open when no run is selected) | one column, the map first (64 vh) | panels stacked |
| < 600 | 16 px gutters; the hero time 44 px; the action buttons wrap under the title; the Optimizer figure scrolls sideways inside its section with the lane labels sticky (min width 640) | as above; the toolbar wraps; the sheet takes 70% of the map | the tables scroll sideways with the first column sticky |

- The nav: below 600 the tabs stay, the page status pills hide (`#navR` keeps only the running chip), the brand shows the
  coin only.
- No horizontal page scroll at any width; only the tables and the Optimizer figure scroll inside their own containers.
- Touch: buttons and chips at least 32 px tall on touch devices (`@media (pointer: coarse)`), the run row's Watch always
  visible.

---

## 13. Work packages, order, checks, acceptance

### 13.1 Packages

| WP | Owner files | Depends on | Content |
|---|---|---|---|
| WP1 Shell | `src/app/ui.css`, `src/app/ui.js`, `src/server.js` (static routes), `tools/build-exe.js`, `test/review.js` (copy list) | none | sections 3, 4, 5 (the nav markup goes into the pages in WP2 / WP3 / WP6) |
| WP2 Runs page | `src/app/index.html` | WP1 | sections 6, 7 (index markup, CSS, renderDetail split, filter, new-run fold, routing, offline hook, the `#opt` section mount) |
| WP3 Editor | `src/app/editor.html` | WP1 | section 8 (markup outside the stage, CSS, the hook line in renderHybrid, `#hyTape`, the sheet) |
| WP4 Optimizer data | `src/events.js`, `src/phases.js`, `src/grind.js`, `src/gpusearch.js`, `tools/hybrid.js`, `src/editor.js` (`hybridState` timeline), `src/server.js` (`/api/jobs/:id/phases`), `test/phases.js` | none | 11.1-11.4 |
| WP5 Optimizer view | `src/app/timeline.js` | WP1, WP4 (the model shape) | section 9 |
| WP6 Stats | `tools/stats-import.js`, `src/stats.js` (the endpoint code: jobs stats, benchmarks), `src/server.js` (`/api/stats*`, `/stats`), `src/app/stats.html`, `test/stats.js` | WP1, WP4 (`phases.classify`) | sections 10, 11.5, 11.6 |

`src/server.js` is touched by WP1, WP4 and WP6: each adds its own route lines in its own block, nothing else; the
merge takes all three. Order: WP1 and WP4 first (in parallel), then WP2, WP3, WP5, WP6 (in parallel), then one
integration pass (the nav in every page, the Optimizer view mounted on both pages, CLAUDE.md).

### 13.2 New tests (synthetic data only)

- `test/phases.js`: `classify` on every row of 11.2 (names and `what`s from the real formats); a synthetic
  `grind_events.jsonl` + `gpu/events.jsonl` in a temp job folder -> the model (spans, sweep subs, open spans, marks linked
  to spans, GPU find attribution, score shares, range cut, the 2,000-span cap, `sig` / `unchanged`); a synthetic
  `grind.log` -> the legacy model (day rollover, sweep lanes, round lines); `nowJob` texts (running / paused / starting /
  never started); `hybridTimeline` on the hybrid state of `test/editor.js hybridPageChecks`; the events writer's rotation.
  A grind run is not needed: the hooks are thin.
- `test/stats.js`: a synthetic CSV with the user's header (BOM, blank lines, section title lines, a quoted level name with
  a comma, an unconfirmed row, an empty best known) -> the import JSON and its numbers; `--list`, `--remove`; the endpoints
  in a temp `EEAT_HOME` (`/api/stats` totals from fake jobs with history; the benchmark list, one benchmark, a job match by
  level name, by `(hybrid)` name, by md5 prefix; 404 for an unknown or malformed id).
- The page code that is new and pure (`TL.render` on a model, `UI.spark`, `UI.histo`, `UI.steps`, `UI.stack`) gets checks
  in `test/phases.js` / `test/stats.js` by loading `src/app/timeline.js` / `ui.js` with a minimal `window` stand-in and
  checking the SVG strings (a block per span, labels only where they fit, the playhead, diamonds on the right lane).

### 13.3 Checks (every package, before handing back)

- `node test/editor.js --only=app`, `node test/review.js --quick --only=app`, `node test/regress.js --quick`, plus
  `node test/phases.js` and `node test/stats.js` once they exist; `node test/editor.js --only=hybrid` for WP3 / WP4.
- A scratch app for the eyes: `EEAT_HOME=<scratch dir>` holding copies of 3-5 of the user's jobs (read only from
  `src/jobs`, copied, never written back) and a copy of the CSV imported with the tool; `node src/server.js --port=4785x`;
  at most 2 node processes; no GPU; kill it when done.
- Screenshots of that server only, headless: `msedge --headless --disable-gpu --window-size=1440,900
  --screenshot=<file> "http://127.0.0.1:4785x/?theme=dark#job=<id>"`. Take: the Runs page (a running job if the
  scratch home can run one on the CPU for a minute, else a stopped one) night and day, 1440 and 390 wide; the editor
  night; Stats (Your runs, Benchmarks) night and day; the viewer open (`#watch=<id>`). Look at every shot for overflow,
  clipped labels, colliding text and contrast before calling it done.

### 13.4 Acceptance (the integration pass checks every line)

- [ ] All existing features, endpoints and ids work; the tests of 13.3 pass.
- [ ] The nav is on all three pages; the active tab is marked; the theme switch cycles and persists; `?theme=` works.
- [ ] No uppercase letter-spaced labels; numbers in Bahnschrift tabular; mono only for logs, inputs, md5s, `/loadtas`.
- [ ] Gold only for bests, improvement marks, the brand and `.go` actions; green / red only for deltas and states, always
      with a sign or a word.
- [ ] The job page: the hero time, the Optimizer view (now, recipe, chart over tape, legend, scoreboard, phase guide),
      Improvements with "Found by", Files, Search harder, disclosures; `#job=<id>` and back work.
- [ ] A running job's tape advances every second and refetches every 3 s; a new best runs the one motion moment
      (none with reduced motion).
- [ ] A job with no events shows the legacy view with its note; a never-started job shows the recipe preview.
- [ ] The editor: nav with the job / size / GPU pills, the Find a route card with the two action rows, the Hybrid's compact
      view and the sheet.
- [ ] Stats: Your runs (KPIs, by family, recent, the table with sparklines, links to runs) and Benchmarks (the expected
      numbers of 10.2 for the user's CSV, every chart with hover, the table's filters, sorting, groups and Watch links).
- [ ] The offline banner appears when the server is stopped and goes away when it is back.
- [ ] No horizontal page scroll at 390 px; the figure and the tables scroll inside themselves.
- [ ] CLAUDE.md: rows for `src/app/ui.css`, `ui.js`, `timeline.js`, `stats.html`, `src/events.js`, `src/phases.js`,
      `src/stats.js`, `tools/stats-import.js`, the two events files in section 7, the new endpoints in section 9.
