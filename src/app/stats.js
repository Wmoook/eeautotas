/* EE Auto TAS: the Stats page (docs/ui/DESIGN.md section 10), served as /stats.js and loaded with `defer` by stats.html
   after /ui.js. It is the slot for the Stats page's builder: this version only shows the empty page.

   THE CONTRACT (stats.html gives this file):
   - #statsRoot           the page's body under the nav (inside <div class="page">): the title row, the view switch (Your runs /
                          Benchmarks, kept in the hash: #runs, #bench, #bench=<id>), the views. Empty at load.
   - #statsUpdated        the nav's right side: "Updated 12 s ago" (12 px, muted).
   - #statsRefresh        the nav's Refresh button (hidden until this file shows it): fetch again.
   - window.STATS         optional: { refresh() } for the page's own code; nothing else calls it.
   Data: GET /api/stats (your runs) and GET /api/stats/benchmarks[/<id>] (DESIGN.md 11.5, 11.6). Charts and formats from /ui.js
   (UI.spark, UI.bars, UI.histo, UI.steps, UI.stack, UI.legend, UI.tip, UI.fmt, UI.dur, ...); the visual system from /ui.css
   (.sheet, .sec, .sec-h, .kpis / .kpi, .tbl, .seg, .chip, .bar, .empty, .loading). */
(function () {
	'use strict';
	const root = document.getElementById('statsRoot');
	if (!root || root.dataset.built) return;
	root.innerHTML = '<div class="sec-h"><h1 class="t-title">Stats</h1></div>' +
		'<div class="sheet"><div class="empty"><b>Nothing to show here yet</b>The stats of your runs and of imported benchmark tables will show up here.' +
		'<div style="margin-top:16px"><a class="btn" href="/">Back to your runs</a></div></div></div>';
})();
