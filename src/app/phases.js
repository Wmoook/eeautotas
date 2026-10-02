/* EE Auto TAS: the Optimizer view (docs/ui/DESIGN.md section 9), served as /phases.js and loaded with `defer` by index.html and
   editor.html after /ui.js. It is the slot for the Optimizer view's builder: this file defines nothing yet, and both pages show
   their built-in views until it defines `window.TL`. The pages call it only behind `typeof TL === 'object'`, so a missing or
   broken file never breaks a page.

   THE CONTRACT (what the pages call; everything is optional except mount on the Runs page):

   Runs page (index.html, the job sheet's <section class="sec opt" id="opt">):
   - TL.mount(el, { job, summary })  a run was picked: build the view in `el` (#opt, empty at the call; the section's own
                                     padding and top hairline come from the sheet), fetch GET /api/jobs/<job>/phases and poll
                                     it as section 9.5 says. `summary` = the run's GET /api/state entry (src/jobs.js summary()).
   - TL.update(summary)              every /api/state poll of the run on screen (1.5 s while it runs, else 2.5 s): the live
                                     numbers (summary.live: the speed; running, stage, round, best, history, bestVersion).
   - TL.unmount(el)                  before another run is mounted in `el` (stop your timers and fetches).
   - TL.classify(entry, job)         optional: an Improvements row (a summary.history entry {t, runTicks, saved, what, ...})
                                     -> { label, color (a CSS colour, e.g. 'var(--ph-explore)'), round } or null; the table then
                                     shows the family's swatch, the plain label and the round.
   While TL.mount exists the page leaves its own live-speed strip (liveHtml) out of the header: the view's header shows the
   speed (DESIGN.md 6.3). Without TL the page draws its built-in summary in #opt (the now sentence, rounds, running time,
   improvements, the best-time chart: index.html renderOpt / optSummary).

   Level editor (editor.html, the Hybrid's panel):
   - TL.render(el, model, { compact, sheet })  called at the end of every renderHybrid (1 s polls) with el = #hyTape (under the
                                     Hybrid's panel in the right column, class "tl tl-compact") and model = GET /api/editor/hybrid
                                     `timeline` (the server's model, DESIGN.md 11.4; no call while it is absent). { compact: true,
                                     sheet: 'hySheet' }: the 300-px view; its "Open the full view" button calls
                                     window.hySheetOpen(), which opens the sheet #hySheet over the map and calls
                                     TL.render($('hySheetBody'), model, { compact: false }) on every poll while it is open
                                     (window.hySheetClose() / Esc / its close button close it).

   Shared tools from /ui.js (window.UI): UI.tip (the tooltip: any element with data-tip="<escaped html>"), UI.steps / UI.spark /
   UI.bars / UI.histo / UI.stack / UI.legend (small charts as strings), UI.inkOn(color) (a label's ink on a coloured block),
   UI.fmt / UI.delta / UI.deltaTicks / UI.dur / UI.count / UI.rate / UI.clock / UI.ago / UI.esc, UI.store (localStorage that never
   throws: the range is 'eeat.ui.range'), UI.motion() (false with prefers-reduced-motion), UI.newBest(el), and the events
   'eeat-theme' (redraw canvas colours) and 'eeat-online' on window. The phase colours are the CSS variables --ph-tweak,
   --ph-explore, --ph-path, --ph-local, --ph-finish, --ph-combine, --ph-outside (ui.css). */
'use strict';
