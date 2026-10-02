/* EE Auto TAS: the Stats page (docs/ui/DESIGN.md section 10), served as /stats.js and loaded with `defer` by stats.html after
   /ui.js. Two views under the title, kept in the hash: Your runs (#runs, the default) and Benchmarks (#bench, #bench=<id>).
   - Your runs: GET /api/stats (src/stats.js jobsStats): the stat tiles, where the time came from (by phase family), the
     newest improvements and every run in a table with its trend; fetched on load and every 30 s while the page is visible.
   - Benchmarks: GET /api/stats/benchmarks and /api/stats/benchmarks/<id> (imported results tables: tools/stats-import.js):
     the routed count, how the hybrid compares with the search and the compiler alone, who found the first route, the time
     to solve, the routes found over time, the quality against the best known TAS and the levels' table; fetched once (the
     nav's Refresh fetches again).
   It owns #statsRoot, #statsUpdated and #statsRefresh (stats.html) and sets window.STATS = { refresh }. Charts and formats
   from /ui.js (UI.*), the visual system from /ui.css (its "the Stats page" section holds this page's rules). */
(function () {
	'use strict';
	const D = document, W = window;
	const root = D.getElementById('statsRoot');
	if (!root || root.dataset.built) return;
	root.dataset.built = '1';
	if (typeof UI !== 'object') {
		root.innerHTML = '<div class="sheet"><div class="empty"><b>The page did not load completely</b>Reload it (the app may have been updated).</div></div>';
		return;
	}
	const esc = UI.esc, count = UI.count, fmt = UI.fmt, MINUS = UI.MINUS;
	const $ = (id) => D.getElementById(id);
	const RUNS_POLL_MS = 30000;
	const FAM_FALLBACK = {
		tweak: { label: 'Input tweaks', color: 'var(--ph-tweak)' }, explore: { label: 'Route explore', color: 'var(--ph-explore)' },
		path: { label: 'Path changes', color: 'var(--ph-path)' }, local: { label: 'Local search', color: 'var(--ph-local)' },
		finish: { label: 'Finish & timing', color: 'var(--ph-finish)' }, combine: { label: 'Combine', color: 'var(--ph-combine)' },
		outside: { label: 'Handed in', color: 'var(--ph-outside)' },
	};
	// who found a benchmark level's first route: the hybrid's parts in their colours (the Optimizer view's part colours)
	const BY = {
		search: { label: 'Search', color: 'var(--ph-tweak)' }, compiler: { label: 'Compiler', color: 'var(--ph-explore)' },
		optimizer: { label: 'Optimizer', color: 'var(--ph-local)' }, prefix: { label: 'Prefix search', color: 'var(--ph-path)' },
	};
	const BY_ORDER = ['search', 'compiler', 'optimizer', 'prefix'];
	const RESULT = {
		routed: { label: 'Routed', cls: 'ahead', title: 'a verified route' },
		unconfirmed: { label: 'Not confirmed', cls: 'warn', title: '' },
		none: { label: 'No route', cls: 'behind', title: 'no route found' },
	};

	const S = {
		view: 'runs', benchId: null,
		runs: { data: null, err: null, at: 0, loading: false },
		bench: { list: null, data: null, err: null, at: 0, loading: false, listErr: null },
		ru: { q: '', sort: 'last', dir: -1, fold: {} },
		bu: { sec: 'all', result: 'any', by: 'any', q: '', withRun: false, sort: 'default', dir: 1, fold: {} },
	};
	try { const f = JSON.parse(UI.store.get('eeat.stats.fold', '{}')); if (f && typeof f === 'object') { S.ru.fold = f.runs || {}; S.bu.fold = f.bench || {}; } } catch (e) { /* none */ }
	const saveFold = () => UI.store.set('eeat.stats.fold', JSON.stringify({ runs: S.ru.fold, bench: S.bu.fold }));

	// ---------------------------------------------------------------- formats
	const pad2 = (n) => String(n).padStart(2, '0');
	/** an optimizer time: 45 min, 3 h 05 min, 312 h */
	function hoursText(ms, compact) {
		if (!(ms > 0)) return '0 min';
		if (ms < 60000) return compact ? '< 1 min' : 'under a minute';
		const min = Math.round(ms / 60000);
		if (min < 60) return `${min} min`;
		const h = Math.floor(min / 60), m = min % 60;
		if (h >= 100) return `${h} h`;
		return compact ? `${h} h ${pad2(m)}` : `${h} h ${pad2(m)} min`;
	}
	/** seconds as m:ss or h:mm:ss (a solve time) */
	function solveText(s) {
		if (!Number.isFinite(s)) return '';
		s = Math.round(s);
		const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
		return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
	}
	/** seconds in words: 45 s, 4 min 01 s, 39 min, 1 h 49 min */
	const secWords = (s) => (Number.isFinite(s) ? UI.dur(s * 1000) : '');
	function bigNumber(n) {
		if (!Number.isFinite(n)) return '';
		const u = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million']];
		for (const [v, w] of u) if (n >= v) return `${(n / v).toFixed(n >= v * 10 ? 0 : 1)} ${w}`;
		return count(n);
	}
	function dateText(t) { try { return new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } }
	function fullDate(t) { try { return new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
	/** a clock time today, else the day and the time */
	function whenText(t) {
		if (!Number.isFinite(t)) return '';
		const d = new Date(t), n = new Date();
		if (d.toDateString() === n.toDateString()) return UI.clock(t);
		try { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + UI.clock(t); } catch (e) { return UI.clock(t); }
	}
	const savedTicks = (t) => (t > 0 ? `${MINUS}${count(t)} ${t === 1 ? 'tick' : 'ticks'}` : '0 ticks');
	const savedTime = (t) => (t > 0 ? UI.delta(-t) : t < 0 ? UI.delta(-t) : '0.00 s');
	const pct = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0);

	// ---------------------------------------------------------------- data
	async function getJson(url) {
		const r = await fetch(url, { cache: 'no-store' });
		let j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok) { const e = new Error((j && j.error) || `the app answered ${r.status}`); e.status = r.status; throw e; }
		return j;
	}
	async function loadRuns(quiet) {
		if (S.runs.loading) return;
		S.runs.loading = true;
		if (!quiet && !S.runs.data) renderView();
		try { S.runs.data = await getJson('/api/stats'); S.runs.err = null; S.runs.at = Date.now(); } catch (e) { S.runs.err = e.message; }
		S.runs.loading = false;
		if (S.view === 'runs') renderView(); else updated();
	}
	async function loadBench(force) {
		if (S.bench.loading) return;
		S.bench.loading = true;
		if (!S.bench.list || force) renderView();
		try {
			const l = await getJson('/api/stats/benchmarks');
			S.bench.list = l.benchmarks || []; S.bench.listErr = null;
		} catch (e) { S.bench.listErr = e.message; }
		const list = S.bench.list || [];
		const want = S.benchId && list.some((b) => b.id === S.benchId) ? S.benchId : (list[0] && list[0].id) || null;
		if (want && (force || !S.bench.data || S.bench.data.id !== want)) {
			try { S.bench.data = await getJson(`/api/stats/benchmarks/${encodeURIComponent(want)}`); S.bench.err = null; S.bench.at = Date.now(); } catch (e) { S.bench.err = e.message; S.bench.data = null; }
		} else if (!want) S.bench.data = null;
		if (!S.bench.at) S.bench.at = Date.now();
		S.bench.loading = false;
		if (S.view === 'bench') renderView(); else updated();
	}
	function refresh() { if (S.view === 'bench') loadBench(true); else loadRuns(); }

	// ---------------------------------------------------------------- the frame: title, view switch, the nav's right side
	function parseHash() {
		const h = (location.hash || '').replace(/^#/, '');
		const m = /^bench(?:=([a-z0-9-]{1,64}))?$/.exec(h);
		if (m) { S.view = 'bench'; S.benchId = m[1] || null; } else S.view = 'runs';
	}
	function setHash(h) {
		if (('#' + h) === location.hash) return;
		try { history.pushState(null, '', '#' + h); } catch (e) { location.hash = h; return; }
		onHash();
	}
	function frame() {
		root.innerHTML = `<div class="st-head"><h1 class="t-title">Stats</h1>` +
			`<div class="seg" role="group" aria-label="View"><button type="button" data-view="runs">Your runs</button><button type="button" data-view="bench">Benchmarks</button></div></div>` +
			`<div id="stView" class="st-view" aria-live="polite"></div>`;
		const r = $('statsRefresh');
		if (r) { r.hidden = false; r.addEventListener('click', refresh); }
	}
	function markSeg() {
		for (const b of root.querySelectorAll('.st-head .seg button')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
	}
	function updated() {
		const el = $('statsUpdated');
		if (!el) return;
		const at = S.view === 'bench' ? S.bench.at : S.runs.at;
		el.textContent = at ? `Updated ${Date.now() - at < 5000 ? 'just now' : UI.ago(Date.now() - at)}` : '';
	}
	function onHash() {
		const was = S.view, wasId = S.benchId;
		parseHash();
		markSeg();
		if (S.view === 'runs') { renderView(); if (!S.runs.data || Date.now() - S.runs.at > RUNS_POLL_MS) loadRuns(true); } else {
			renderView();
			if (!S.bench.list || was !== 'bench' && !S.bench.data || (S.benchId && wasId !== S.benchId && (!S.bench.data || S.bench.data.id !== S.benchId))) loadBench(false);
		}
		updated();
		try { D.title = (S.view === 'bench' ? 'Benchmarks' : 'Stats') + ' · EE Auto TAS'; } catch (e) { /* none */ }
	}
	function renderView() {
		const v = $('stView');
		if (!v) return;
		// a poll of your runs while its table is on screen: the numbers and the table again, the filter field kept (its focus)
		if (S.view === 'runs' && S.runs.data && S.runs.data.totals && S.runs.data.totals.runs && $('stRunQ') && $('stRunsTop')) {
			$('stRunsTop').innerHTML = runsTopHtml(S.runs.data);
			rerenderRuns();
			v.classList.toggle('st-stale', S.runs.loading);
			updated();
			return;
		}
		v.innerHTML = S.view === 'bench' ? benchHtml() : runsHtml();
		v.classList.toggle('st-stale', S.view === 'runs' ? (S.runs.loading && !!S.runs.data) : (S.bench.loading && !!S.bench.data));
		updated();
	}
	const loadingHtml = (what) => `<div class="sheet"><div class="loading"><span class="spin"></span>Loading ${esc(what)}...</div></div>`;
	const errHtml = (what, msg) => `<div class="sheet"><div class="msg err">Could not load ${esc(what)}: ${esc(msg)}</div><div style="margin-top:12px"><button type="button" class="small" data-act="retry">Try again</button></div></div>`;

	// ================================================================ Your runs
	function famOf(d, k) { return (d.fams && d.fams[k]) || FAM_FALLBACK[k] || { label: k, color: 'var(--ph-combine)' }; }
	function runsHtml() {
		const d = S.runs.data;
		if (!d) return S.runs.err ? errHtml('your runs', S.runs.err) : loadingHtml('your runs');
		const T = d.totals || {};
		if (!T.runs) {
			return `<div class="sheet"><div class="empty"><b>No runs yet</b>Import a level and a TAS on the Runs page: the optimizer's work and every second it saves show up here.<div style="margin-top:16px"><a class="btn" href="/">Make your first run faster</a></div></div></div>`;
		}
		let s = `<div id="stRunsTop">${runsTopHtml(d)}</div>`;
		// every run
		s += `<section class="sheet st-sheet"><div class="sec-h"><h2>All runs <span class="chip">${count((d.jobs || []).length)}</span></h2>` +
			`<div class="tools"><input type="search" id="stRunQ" placeholder="Filter runs" aria-label="Filter runs" value="${esc(S.ru.q)}"></div></div>` +
			`<div id="stRunsTbl">${runsTableHtml(d)}</div></section>`;
		return s;
	}
	function runsTopHtml(d) {
		const T = d.totals || {};
		let s = S.runs.err ? `<div class="msg err" style="margin:0 0 16px">The last refresh failed: ${esc(S.runs.err)} (the numbers from ${esc(UI.clock(S.runs.at))})</div>` : '';
		// the stat tiles
		const tiles = [];
		tiles.push(kpi('Runs', count(T.runs), T.running ? `<span class="chip ahead live"><i></i>${count(T.running)} optimizing</span>` : 'none optimizing now'));
		tiles.push(kpi('Time saved', fmt(T.savedTicks), T.originalTicks ? `${pct(T.savedTicks, T.originalTicks).toFixed(1)}% of the originals` : '', `${count(T.savedTicks)} ticks saved over all runs`));
		tiles.push(kpi('Improvements', count(T.improvements), `${count(T.today)} today`));
		tiles.push(kpi('Optimizer time', `${T.optimizedApprox ? '≈ ' : ''}${hoursText(T.optimizedMs, true)}`, T.since ? `since ${dateText(T.since)}` : '',
			`${hoursText(T.optimizedMs)}${T.optimizedApprox ? ', some of it estimated from the optimizer logs (their times have no dates)' : ', from the optimizer\'s own records'}`));
		if (T.simTicks !== null && T.simTicks !== undefined) tiles.push(kpi('Simulated', `${bigNumber(T.simTicks)}`, 'ticks since the events began', `${count(T.simTicks)} ticks of the exact physics`));
		s += `<div class="kpis st-kpis">${tiles.join('')}</div>`;
		// where the time came from + the newest improvements
		s += `<div class="st-grid2">`;
		s += `<section class="card st-card"><div class="card-h"><span>Where the time came from</span><small>by the phase that found it</small></div>${byFamHtml(d)}</section>`;
		s += `<section class="card st-card"><div class="card-h"><span>Recent improvements</span><small>the newest ${Math.min(20, (d.recent || []).length)}</small></div>${recentHtml(d)}</section>`;
		s += `</div>`;
		return s;
	}
	function kpi(k, v, sub, tip) {
		return `<div class="card kpi"${tip ? ` data-tip="${esc(tip)}"` : ''}><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${/^</.test(sub) ? sub : esc(sub)}</div>` : ''}</div>`;
	}
	function byFamHtml(d) {
		const by = d.byFam || {};
		const order = (d.famOrder || Object.keys(FAM_FALLBACK));
		const items = order.filter((k) => by[k] && (by[k].saved > 0 || by[k].finds > 0)).map((k) => {
			const f = famOf(d, k), b = by[k];
			const finds = (v) => (typeof v === 'object' && v ? v.finds : +v || 0);
			const st = Object.entries(b.stages || {}).sort((x, y) => finds(y[1]) - finds(x[1])).slice(0, 6).map(([l, v]) => `${esc(l)} ${count(finds(v))}`).join(', ');
			return { label: f.label, value: b.saved, color: f.color, text: savedTicks(b.saved),
				tip: `<b>${esc(f.label)}</b><br><span class="tv">${count(b.finds)}</span> ${b.finds === 1 ? 'find' : 'finds'}, ${esc(savedTicks(b.saved))}${st ? `<br><span class="muted">${st}</span>` : ''}` };
		}).sort((x, y) => y.value - x.value);
		if (!items.length) return `<div class="st-none">No improvements yet. They show up here as the optimizer finds them.</div>`;
		return UI.bars(items) + stagesHtml(d);
	}
	/** the phases that found the most time (the families' bars split by phase): a small table */
	function stagesHtml(d) {
		const st = (d.byStage || []).filter((x) => x.saved > 0).slice(0, 6);
		if (!st.length) return '';
		const tot = (d.byStage || []).reduce((a, x) => a + Math.max(0, x.saved), 0) || 1;   // of all the time saved
		return `<div class="st-stages"><div class="st-mini-h">The phases that found the most</div><table class="tbl st-mini"><thead><tr><th>Phase</th><th class="n">Finds</th><th class="n">Saved</th><th class="n">Share</th></tr></thead><tbody>` +
			st.map((x) => `<tr><td class="st-by"><i class="sw" style="background:${famOf(d, x.fam).color}"></i>${esc(x.label)}</td><td class="n">${count(x.finds)}</td>` +
				`<td class="n good">${esc(savedTicks(x.saved))}</td><td class="n">${Math.round(x.saved / tot * 100)}%</td></tr>`).join('') +
			`</tbody></table></div>`;
	}
	function recentHtml(d) {
		const r = d.recent || [];
		if (!r.length) return `<div class="st-none">Nothing yet.</div>`;
		return `<div class="tbl-wrap st-recent"><table class="tbl"><thead><tr><th>When</th><th>Run</th><th class="n">Saved</th><th class="n">New best</th><th>Found by</th></tr></thead><tbody>` +
			r.map((e) => {
				const f = famOf(d, e.fam);
				return `<tr><td class="tnum" title="${esc(fullDate(e.t))}">${esc(whenText(e.t))}</td>` +
					`<td class="st-name"><a href="/#job=${esc(e.job)}" title="${esc(e.name)}">${esc(e.name)}</a></td>` +
					`<td class="n good">${esc(savedTicks(e.saved))}</td><td class="n">${esc(e.time)}</td>` +
					`<td class="st-by" title="${esc(e.what)}"><i class="sw" style="background:${f.color}"></i>${esc(e.label)}</td></tr>`;
			}).join('') + `</tbody></table></div>`;
	}
	const RUN_COLS = [
		{ k: 'name', t: 'Run', v: (j) => j.name.toLowerCase() },
		{ k: 'section', t: 'Section', v: (j) => j.section },
		{ k: 'orig', t: 'Original', n: true, v: (j) => j.original.runTicks },
		{ k: 'best', t: 'Best', n: true, v: (j) => j.best.runTicks },
		{ k: 'saved', t: 'Saved', n: true, v: (j) => j.savedTicks },
		{ k: 'pct', t: '%', n: true, v: (j) => j.pct },
		{ k: 'finds', t: 'Finds', n: true, v: (j) => j.improvements },
		{ k: 'opt', t: 'Optimized', n: true, v: (j) => j.optimizedMs },
		{ k: 'last', t: 'Last find', n: true, v: (j) => (j.lastT === null ? -Infinity : j.lastT) },
		{ k: 'trend', t: 'Trend', nosort: true },
	];
	function sortRows(rows, cols, key, dir, tie) {
		const c = cols.find((x) => x.k === key);
		if (!c || !c.v) return rows;
		return rows.slice().sort((a, b) => {
			const x = c.v(a), y = c.v(b);
			const nx = x === null || x === undefined || x === Infinity, ny = y === null || y === undefined || y === Infinity;
			if (nx !== ny) return nx ? 1 : -1;   // the empty ones last, whichever way
			if (x < y) return -dir;
			if (x > y) return dir;
			return tie ? tie(a, b) : 0;
		});
	}
	function thHtml(c, ui) {
		if (c.nosort) return `<th${c.n ? ' class="n"' : ''}>${esc(c.t)}</th>`;
		const on = ui.sort === c.k;
		const arrow = on ? (ui.dir > 0 ? ' ▲' : ' ▼') : '';
		return `<th${c.n ? ' class="n"' : ''} aria-sort="${on ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th" data-sort="${c.k}">${esc(c.t)}${arrow}</button></th>`;
	}
	function runsTableHtml(d) {
		const now = d.t || Date.now();
		const q = S.ru.q.trim().toLowerCase();
		const all = (d.jobs || []);
		const rows = q ? all.filter((j) => j.name.toLowerCase().includes(q) || String(j.campaign || '').toLowerCase().includes(q)) : all;
		if (!rows.length) return `<div class="st-none">No run matches "${esc(S.ru.q)}".</div>`;
		const sorted = sortRows(rows, RUN_COLS, S.ru.sort, S.ru.dir, (a, b) => a.name.localeCompare(b.name));
		let s = `<div class="tbl-wrap st-scroll"><table class="tbl st-tbl st-runs"><thead><tr>${RUN_COLS.map((c) => thHtml(c, S.ru)).join('')}<th><span class="sr">Actions</span></th></tr></thead>`;
		for (const sec of [['campaign', 'Campaign'], ['other', 'Other']]) {
			const rs = sorted.filter((j) => j.section === sec[0]);
			if (!rs.length) continue;
			const folded = !!S.ru.fold[sec[0]];
			const saved = rs.reduce((a, j) => a + Math.max(0, j.savedTicks), 0);
			s += `<tbody><tr class="grp" tabindex="0" data-fold="runs:${sec[0]}" aria-expanded="${!folded}"><td colspan="${RUN_COLS.length + 1}"><span class="st-car${folded ? '' : ' open'}"></span>${sec[1]} <span class="chip">${count(rs.length)}</span><span class="st-grp-note">${esc(savedTime(saved))} saved</span></td></tr>`;
			if (!folded) s += rs.map((j) => runRow(j, now)).join('');
			s += `</tbody>`;
		}
		return s + `</table></div>`;
	}
	function runRow(j, now) {
		const first = j.spark && j.spark[0], last = j.spark && j.spark[j.spark.length - 1];
		const tip = first && last ? `<b>${esc(j.name)}</b><br>${esc(fmt(first[1]))} on ${esc(dateText(first[0]))}<br>${esc(fmt(last[1]))} on ${esc(dateText(last[0]))}` : '';
		const sp = j.spark && j.spark.length > 1 ? UI.spark(j.spark, { tEnd: j.running ? now : 0, tip, label: `${j.name}: the best time over time` }) : `<span class="muted st-flat" title="no improvement yet">-</span>`;
		const imp = j.savedTicks > 0;
		return `<tr><td class="st-name"><a href="/#job=${esc(j.id)}" title="${esc(j.name)}">${esc(j.name)}</a>${j.running ? ' <span class="chip ahead live st-run"><i></i>optimizing</span>' : ''}` +
			`${j.campaign ? `<div class="st-sub">${esc(j.campaign)}</div>` : ''}</td>` +
			`<td>${j.section === 'campaign' ? 'Campaign' : 'Other'}</td>` +
			`<td class="n${imp ? ' st-was' : ''}">${esc(j.original.time)}</td><td class="n st-best">${esc(j.best.time)}</td>` +
			`<td class="n${imp ? ' good' : ' muted'}">${imp ? esc(savedTime(j.savedTicks)) : 'none yet'}</td>` +
			`<td class="n">${imp ? esc(j.pct.toFixed(1)) : ''}</td><td class="n">${count(j.improvements)}</td>` +
			`<td class="n" title="${j.approx ? 'estimated from the optimizer log' : ''}">${j.optimizedMs > 0 ? `${j.approx ? '≈ ' : ''}${esc(hoursText(j.optimizedMs, true))}` : '<span class="muted">-</span>'}</td>` +
			`<td class="n" title="${j.lastT ? esc(fullDate(j.lastT)) : ''}">${j.lastT ? esc(UI.ago(now - j.lastT)) : '<span class="muted">-</span>'}</td>` +
			`<td class="st-trend">${sp}</td>` +
			`<td class="st-act"><a class="btn small watch" href="/#watch=${esc(j.id)}" aria-label="Watch ${esc(j.name)}">Watch</a></td></tr>`;
	}

	// ================================================================ Benchmarks
	function benchHtml() {
		const B = S.bench;
		if (!B.list) return B.listErr ? errHtml('the benchmarks', B.listErr) : loadingHtml('the benchmarks');
		if (!B.list.length) {
			return `<div class="sheet"><div class="empty st-empty"><b>No benchmarks yet</b>Import a results table to compare runs of the whole level set:` +
				`<pre class="st-cmd">node tools/stats-import.js &lt;file.csv&gt;</pre>(or <code>EEAutoTAS.exe tools/stats-import.js &lt;file.csv&gt;</code>). It is copied into the app's data folder and shows up here.</div></div>`;
		}
		const b = B.data;
		if (!b) return B.err ? errHtml('this benchmark', B.err) : loadingHtml('the benchmark');
		const n = b.numbers;
		let s = '';
		// the picker and where it came from
		const imp = `imported ${esc(dateText(b.imported))}${b.source ? ` from ${esc(b.source)}` : ''}`;
		s += `<div class="st-bhead">`;
		if (B.list.length > 1) {
			s += `<label class="st-pick"><span class="sr">Benchmark</span><select id="stBenchSel">${B.list.map((x) => `<option value="${esc(x.id)}"${x.id === b.id ? ' selected' : ''}>${esc(x.name)} (${count(x.levels)} levels)</option>`).join('')}</select></label>`;
		} else s += `<h2 class="t-sec">${esc(b.name)}</h2>`;
		s += `<span class="t-small muted">${imp}</span></div>`;
		// the headline
		s += `<section class="sheet st-headline"><div class="st-big"><span class="st-hero">${count(n.routed)}</span><span class="st-of"> of ${count(n.levels)} routed</span></div>`;
		s += `<div class="st-confirm">${count(n.confirmed)} confirmed in the app${n.unconfirmed ? `; ${count(n.unconfirmed)} need random portals the app could not confirm` : ''}</div>`;
		if (n.sections.length) {
			s += `<div class="st-meters">` + n.sections.map((x) => {
				const p = x.total ? x.routed / x.total * 100 : 0;
				return `<div class="st-mrow"><span class="st-mk">${esc(x.title)}</span><span class="st-mv">${count(x.routed)} of ${count(x.total)}</span>` +
					`<div class="bar" role="img" aria-label="${esc(x.title)}: ${x.routed} of ${x.total} routed"><i style="width:${p.toFixed(2)}%"></i></div><span class="st-mp">${Math.round(p)}%</span></div>`;
			}).join('') + `</div>`;
		}
		s += `</section>`;
		// three panels
		s += `<div class="st-grid3">`;
		s += `<section class="card st-card"><div class="card-h"><span>How it compares</span></div>${compareHtml(b, n)}</section>`;
		s += `<section class="card st-card"><div class="card-h"><span>First route found by</span></div>${byHtml(b, n)}</section>`;
		s += `<section class="card st-card"><div class="card-h"><span>Time to solve</span><small>routed levels</small></div>${histoHtml(n)}</section>`;
		s += `</div>`;
		// two panels
		s += `<div class="st-grid2 st-grid2w">`;
		s += `<section class="card st-card"><div class="card-h"><span>Routed within</span><small>levels routed by then, log time</small></div>${withinHtml(b, n)}</section>`;
		s += `<section class="card st-card"><div class="card-h"><span>Route quality vs the best known TAS</span></div>${qualityHtml(b, n)}</section>`;
		s += `</div>`;
		// the levels
		s += `<section class="sheet st-sheet"><div class="sec-h"><h2>Levels</h2><span class="t-small muted" id="stLvCount"></span></div>${levelFiltersHtml(b)}<div id="stLvTbl">${levelTableHtml(b)}</div></section>`;
		return s;
	}
	function aloneNote(title, what) {
		const m = /\((\d+)\s*min/i.exec(String(title || ''));
		return m ? `${what}: one ${m[1]}-minute run per level.` : '';
	}
	function compareHtml(b, n) {
		const c = n.compare;
		const items = [{ label: 'The hybrid', value: c.hybrid, color: 'var(--ink-2)', tip: `<b>The hybrid</b><br><span class="tv">${count(c.hybrid)}</span> of ${count(n.levels)} levels routed` }];
		if (c.hasSearch) items.push({ label: 'Search alone', value: c.search, color: 'var(--ph-tweak)', tip: `<b>Search alone</b><br><span class="tv">${count(c.search)}</span> levels with a route` });
		if (c.hasCompiler) items.push({ label: 'Compiler alone', value: c.compiler, color: 'var(--ph-explore)', tip: `<b>Compiler alone</b><br><span class="tv">${count(c.compiler)}</span> levels routed` });
		if (c.hasSearch && c.hasCompiler) {
			items.push({ label: 'Either alone', value: c.either, color: 'var(--muted)', tip: `<b>Either alone</b><br><span class="tv">${count(c.either)}</span> levels the search or the compiler routed on its own` });
			items.push({ label: 'Only the hybrid', value: 0, text: count(c.onlyHybrid), tip: `<b>Only the hybrid</b><br><span class="tv">${count(c.onlyHybrid)}</span> levels routed by the hybrid and by neither alone` });
		}
		const notes = [aloneNote(b.columns && b.columns.searchAlone, 'Search alone'), aloneNote(b.columns && b.columns.compilerAlone, 'Compiler alone')].filter(Boolean).join(' ');
		return UI.bars(items, { max: Math.max(1, n.levels) }) + (notes ? `<div class="hint">${esc(notes)}</div>` : '');
	}
	function byHtml(b, n) {
		const keys = BY_ORDER.concat(Object.keys(n.by).filter((k) => !BY_ORDER.includes(k)).sort()).filter((k) => n.by[k] > 0);
		const lab = (k) => (BY[k] || { label: k }).label, col = (k) => (BY[k] || { color: 'var(--muted)' }).color;
		const share = (k) => Math.round(n.by[k] / Math.max(1, n.routed) * 100);
		const parts = keys.map((k) => ({ label: lab(k), value: n.by[k], color: col(k),
			tip: `<b>${esc(lab(k))}</b><br><span class="tv">${count(n.by[k])}</span> first routes (${share(k)}% of the routed levels)` }));
		if (!parts.length) return `<div class="st-none">The table names no part.</div>`;
		// per part: its first routes, their share and how long they took (the median of its levels' solve times)
		const med = (k) => {
			const xs = b.rows.filter((r) => r.result !== 'none' && r.by === k && Number.isFinite(r.solveS)).map((r) => r.solveS).sort((x, y) => x - y);
			return xs.length ? xs[Math.floor(xs.length / 2)] : null;
		};
		const tbl = `<table class="tbl st-mini"><thead><tr><th>Part</th><th class="n">Routes</th><th class="n">Share</th><th class="n">Median solve</th></tr></thead><tbody>` +
			keys.map((k) => { const m = med(k); return `<tr><td class="st-by"><i class="sw" style="background:${col(k)}"></i>${esc(lab(k))}</td><td class="n">${count(n.by[k])}</td><td class="n">${share(k)}%</td><td class="n">${m === null ? '' : esc(solveText(m))}</td></tr>`; }).join('') +
			`</tbody></table>`;
		return `<div class="st-stack">${UI.stack(parts)}</div>${tbl}<div class="hint">Which part of the hybrid found each routed level's first verified route.</div>`;
	}
	function histoHtml(n) {
		if (!n.solve.n) return `<div class="st-none">No solve times in the table.</div>`;
		const bins = n.solve.bins.map((x) => ({ label: x.label, n: x.n, tip: `<span class="tv">${count(x.n)}</span> ${x.n === 1 ? 'level' : 'levels'} solved in ${esc(x.text)}` }));
		return `<div class="st-histo">${UI.histo(bins, { w: 360, h: 150, color: 'var(--ink-2)', label: 'Levels by the time to solve them' })}</div>` +
			`<div class="st-foot">median <b>${esc(secWords(n.solve.median))}</b>, 90% by <b>${esc(secWords(n.solve.p90))}</b><span class="muted">, the longest ${esc(secWords(n.solve.max))}</span></div>`;
	}
	const LOG_TICKS = [[1, '1 s'], [10, '10 s'], [60, '1 min'], [600, '10 min'], [3600, '1 h'], [7200, '2 h'], [36000, '10 h']];
	function cumul(xs) {
		const s = xs.filter((x) => Number.isFinite(x)).map((x) => Math.max(1, x)).sort((a, b) => a - b);
		const pts = [[1, 0]];
		s.forEach((x, k) => pts.push([x, k + 1]));
		return pts;
	}
	function withinHtml(b, n) {
		const hy = b.rows.filter((r) => r.result !== 'none').map((r) => r.solveS);
		const se = b.rows.filter((r) => r.searchAlone && r.searchAlone.routed).map((r) => r.searchAlone.solveS);
		const series = [{ name: 'the hybrid', color: 'var(--ink)', pts: cumul(hy), w: 2 }];
		const seHas = se.some((x) => Number.isFinite(x));
		if (seHas) series.push({ name: 'search alone', color: 'var(--ph-tweak)', pts: cumul(se), w: 2 });
		const all = series.flatMap((x) => x.pts.map((p) => p[0]));
		const xmax = Math.max(10, ...all);
		const ymax = Math.max(1, n.levels > 0 ? Math.max(...series.map((x) => x.pts[x.pts.length - 1][1])) : 1);
		const xt = LOG_TICKS.filter((t) => t[0] <= xmax * 1.0001);
		const xname = new Map(LOG_TICKS);
		// a narrow screen draws it in fewer units (the same text size on screen)
		const narrow = (W.innerWidth || 1200) < 600;
		const svg = UI.steps(series, {
			w: narrow ? 360 : 640, h: narrow ? 230 : 230, xlog: true, xmin: 1, xmax, ymin: 0, ymax,
			xticks: xt.map((t) => t[0]).filter((v) => !narrow || v !== 10 && v !== 7200), xfmt: (v) => xname.get(v) || secWords(v),
			label: 'Levels routed by each time', padR: narrow ? 104 : 132, padL: narrow ? 34 : 48,
			hoverFmt: (x, rows) => `<div><b>by ${esc(secWords(x))}</b></div>` + rows.map((r) => `<div class="tr"><i class="tk" style="background:${r.color}"></i><span class="tv">${r.v === null ? 0 : count(r.v)}</span> ${esc(r.name)}</div>`).join(''),
		});
		const legend = UI.legend(series.map((x) => ({ label: `${x.name} (${count(x.pts[x.pts.length - 1][1])})`, color: x.color, line: true })));
		const cn = n.compare.hasCompiler ? `<div class="hint">Compiler alone: ${count(n.compare.compiler)} levels within its ${/\((\d+)\s*min/i.test(String(b.columns && b.columns.compilerAlone)) ? /\((\d+)\s*min/i.exec(b.columns.compilerAlone)[1] + '-minute run' : 'own run'} (no times recorded).</div>` : '';
		// the chart's numbers as a table: the levels routed by a few times
		const marks = [[60, '1 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 h']].filter((m) => m[0] < xmax);
		const by = (pts, x) => { let v = 0; for (const p of pts) if (p[0] <= x) v = p[1]; else break; return v; };
		const tbl = `<div class="st-minwrap"><table class="tbl st-mini st-within"><thead><tr><th>Routed by</th>${marks.map((m) => `<th class="n">${m[1]}</th>`).join('')}<th class="n">In all</th></tr></thead><tbody>` +
			series.map((x) => `<tr><td class="st-by"><i class="sw" style="background:${x.color}"></i>${esc(x.name)}</td>${marks.map((m) => `<td class="n">${count(by(x.pts, m[0]))}</td>`).join('')}<td class="n"><b>${count(x.pts[x.pts.length - 1][1])}</b></td></tr>`).join('') +
			`</tbody></table></div>`;
		return `<div class="st-chart">${svg}</div>${legend}${tbl}${cn}`;
	}
	function qualityHtml(b, n) {
		const q = n.quality;
		if (!q.known) return `<div class="st-none">No level of the table has both a route and a best known TAS.</div>`;
		const rows = b.rows.filter((r) => r.result !== 'none' && Number.isFinite(r.ratio));
		let s = `<div class="st-qnums"><div><span class="st-qv">${count(q.known)}</span> levels with a best known TAS</div>` +
			`<div><span class="st-qv">${count(q.under)}</span> at or under it, <span class="st-qv">${count(q.within10)}</span> within 10%</div>` +
			`<div>median <span class="st-qv">${Number(q.median).toFixed(3)}</span> × the best known</div></div>`;
		s += dotStrip(rows);
		// the levels furthest under and over the best known
		const sorted = rows.slice().sort((x, y) => x.ratio - y.ratio);
		const line = (r) => `<tr><td class="st-name" title="${esc(r.level)}">${esc(r.level)}</td><td class="n">${esc(r.best.time)}</td><td class="n muted">${esc(r.known.time)}</td>` +
			`<td class="n${r.ratio <= 1 ? ' good' : ''}">${r.ratio.toFixed(3)}×</td></tr>`;
		const under = sorted.filter((r) => r.ratio < 1).slice(0, 3), over = sorted.slice(-3).reverse().filter((r) => r.ratio > 1);
		if (under.length || over.length) {
			s += `<div class="st-minwrap"><table class="tbl st-mini st-qtbl"><thead><tr><th>Level</th><th class="n">Best route</th><th class="n">Best known</th><th class="n">Ratio</th></tr></thead>` +
				(under.length ? `<tbody><tr class="st-qh"><td colspan="4">Furthest under the best known</td></tr>${under.map(line).join('')}</tbody>` : '') +
				(over.length ? `<tbody><tr class="st-qh"><td colspan="4">Furthest over it</td></tr>${over.map(line).join('')}</tbody>` : '') + `</table></div>`;
		}
		return s;
	}
	/** one dot per level on a 0.6x .. 2x+ axis (dodged into rows where they would overlap), gold at or under 1.0 */
	function dotStrip(rows) {
		const w = 360, padL = 14, padR = 22, lo = 0.6, hi = 2;
		const X = (v) => padL + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (w - padL - padR);
		const R = 3, step = 2 * R + 1;
		const pts = rows.map((r) => ({ r, x: X(r.ratio) })).sort((a, b) => a.x - b.x);
		const lanes = [];   // per row the x of its last dot
		let maxLane = 0;
		for (const p of pts) {
			let k = 0;
			while (lanes[k] !== undefined && p.x - lanes[k] < step) k++;
			lanes[k] = p.x; p.k = k; if (k > maxLane) maxLane = k;
		}
		const lanesN = Math.min(maxLane + 1, 14);
		const top = 8, plotH = lanesN * step + 4, axisY = top + plotH + 4, h = axisY + 20;
		const Y = (k) => top + plotH - 4 - Math.min(k, lanesN - 1) * step - R;
		let s = `<svg class="uic st-dots" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Each level's best route over its best known TAS">`;
		s += `<line class="gl" x1="${padL}" x2="${w - padR}" y1="${axisY - 3.5}" y2="${axisY - 3.5}"/>`;
		s += `<line class="st-one" x1="${X(1)}" x2="${X(1)}" y1="${top}" y2="${axisY - 3}"/>`;
		for (const [v, t] of [[0.6, '0.6×'], [0.8, '0.8×'], [1, '1×'], [1.2, '1.2×'], [1.5, '1.5×'], [2, '2×+']]) s += `<text class="ax" x="${X(v).toFixed(1)}" y="${axisY + 12}" text-anchor="middle">${t}</text>`;
		for (const p of pts) {
			const r = p.r, gold = r.ratio <= 1;
			const tip = `<b>${esc(r.level)}</b><br><span class="tv">${esc(r.best.time)}</span> vs the best known <span class="tv">${esc(r.known.time)}</span><br>${r.ratio.toFixed(3)}×${gold ? ' (at or under it)' : ''}`;
			s += `<g class="st-dot${gold ? ' gold' : ''}" data-tip="${esc(tip)}"><circle class="hit" cx="${p.x.toFixed(1)}" cy="${Y(p.k).toFixed(1)}" r="${R + 3}"/><circle cx="${p.x.toFixed(1)}" cy="${Y(p.k).toFixed(1)}" r="${R}"/></g>`;
		}
		return s + `</svg>`;
	}

	// ---------------------------------------------------------------- the levels' table
	function levelFiltersHtml(b) {
		const secs = (b.numbers.sections || []);
		const segs = [['all', 'All']].concat(secs.map((x) => [x.key, x.title]));
		if (!segs.some((x) => x[0] === S.bu.sec)) S.bu.sec = 'all';
		const bys = Object.keys(b.numbers.by || {});
		return `<div class="st-filters">` +
			`<div class="seg" role="group" aria-label="Section">${segs.map(([k, t]) => `<button type="button" data-sec="${esc(k)}" aria-pressed="${S.bu.sec === k}">${esc(t)}</button>`).join('')}</div>` +
			`<select id="stLvRes" aria-label="Result">${[['any', 'Any result'], ['routed', 'Routed'], ['unconfirmed', 'Not confirmed'], ['none', 'No route']].map(([v, t]) => `<option value="${v}"${S.bu.result === v ? ' selected' : ''}>${t}</option>`).join('')}</select>` +
			(bys.length ? `<select id="stLvBy" aria-label="First route by"><option value="any">First route by: any</option>${BY_ORDER.concat(bys.filter((k) => !BY_ORDER.includes(k))).filter((k) => bys.includes(k)).map((k) => `<option value="${esc(k)}"${S.bu.by === k ? ' selected' : ''}>First route by: ${esc((BY[k] || { label: k }).label.toLowerCase())}</option>`).join('')}</select>` : '') +
			`<input type="search" id="stLvQ" placeholder="Find a level" aria-label="Find a level" value="${esc(S.bu.q)}">` +
			`<label class="lab st-chk"><input type="checkbox" id="stLvRun"${S.bu.withRun ? ' checked' : ''}> only levels with a run</label>` +
			`</div>`;
	}
	const LV_COLS = [
		{ k: 'level', t: 'Level', v: (r) => r.level.toLowerCase() },
		{ k: 'result', t: 'Result', v: (r) => ({ routed: 0, unconfirmed: 1, none: 2 })[r.result] },
		{ k: 'solve', t: 'Solved in', n: true, v: (r) => (Number.isFinite(r.solveS) ? r.solveS : null) },
		{ k: 'by', t: 'First route by', v: (r) => r.by || null },
		{ k: 'best', t: 'Best route', n: true, v: (r) => (r.best ? r.best.runTicks : null) },
		{ k: 'known', t: 'Best known', n: true, v: (r) => (r.known ? r.known.runTicks : null) },
		{ k: 'ratio', t: 'vs known', n: true, v: (r) => (Number.isFinite(r.ratio) ? r.ratio : null) },
		{ k: 'search', t: 'Search alone', v: (r) => (r.searchAlone && r.searchAlone.routed ? (Number.isFinite(r.searchAlone.solveS) ? r.searchAlone.solveS : 1e9) : r.searchAlone ? 2e9 : null) },
		{ k: 'compiler', t: 'Compiler alone', v: (r) => (r.compilerAlone === true ? 0 : r.compilerAlone === false ? 1 : null) },
		{ k: 'run', t: 'Run', v: (r) => (r.run || '').toLowerCase() || null },
	];
	function levelRows(b) {
		const u = S.bu, q = u.q.trim().toLowerCase(), jobs = b.jobs || {};
		return b.rows.filter((r) => (u.sec === 'all' || r.section === u.sec) && (u.result === 'any' || r.result === u.result) &&
			(u.by === 'any' || r.by === u.by) && (!q || r.level.toLowerCase().includes(q) || r.merged.some((m) => m.toLowerCase().includes(q))) && (!u.withRun || jobs[r.i]));
	}
	function levelTableHtml(b) {
		const rows = levelRows(b), u = S.bu, jobs = b.jobs || {};
		const cnt = $('stLvCount');
		const countText = `Showing ${count(rows.length)} of ${count(b.rows.length)}`;
		if (cnt) cnt.textContent = countText; else setTimeout(() => { const c = $('stLvCount'); if (c) c.textContent = countText; }, 0);
		if (!rows.length) return `<div class="st-none">No level matches these filters.</div>`;
		const secOrder = new Map((b.sections || []).map((x, k) => [x.key, k]));
		const defaultOrder = (a, c) => ((secOrder.get(a.section) || 0) - (secOrder.get(c.section) || 0)) || a.i - c.i;
		const sorted = u.sort === 'default' ? rows.slice().sort(defaultOrder) : sortRows(rows, LV_COLS, u.sort, u.dir, defaultOrder);
		const cols = LV_COLS.filter((c) => !(c.k === 'search' && !b.numbers.compare.hasSearch) && !(c.k === 'compiler' && !b.numbers.compare.hasCompiler));
		let s = `<div class="tbl-wrap st-scroll st-lvwrap"><table class="tbl st-tbl st-lv"><thead><tr>${cols.map((c) => thHtml(c, u)).join('')}<th><span class="sr">Actions</span></th></tr></thead>`;
		const groups = u.sec === 'all' ? (b.sections || []).map((x) => x.key).concat([...new Set(sorted.map((r) => r.section))].filter((k) => !secOrder.has(k))) : [u.sec];
		for (const g of groups) {
			const rs = sorted.filter((r) => r.section === g);
			if (!rs.length) continue;
			s += `<tbody>`;
			if (u.sec === 'all') {
				const sec = (b.sections || []).find((x) => x.key === g) || { title: g, routed: rs.filter((r) => r.result !== 'none').length, total: rs.length };
				const folded = !!u.fold[`${b.id}:${g}`];
				s += `<tr class="grp" tabindex="0" data-fold="bench:${esc(b.id)}:${esc(g)}" aria-expanded="${!folded}"><td colspan="${cols.length + 1}"><span class="st-car${folded ? '' : ' open'}"></span>${esc(sec.title)}: ${count(sec.routed)} of ${count(sec.total)} routed` +
					`${rs.length !== sec.total ? `<span class="st-grp-note">${count(rs.length)} shown</span>` : ''}</td></tr>`;
				if (folded) { s += `</tbody>`; continue; }
			}
			s += rs.map((r) => levelRow(r, cols, jobs[r.i])).join('') + `</tbody>`;
		}
		return s + `</table></div>`;
	}
	function levelRow(r, cols, job) {
		const res = RESULT[r.result] || RESULT.none;
		const resTitle = r.result === 'unconfirmed' ? r.resultText : res.title;
		const cell = {
			level: () => `<td class="st-name">${job ? `<a href="/#job=${esc(job)}" title="Open the run of ${esc(r.level)}">${esc(r.level)}</a>` : esc(r.level)}` +
				`${r.merged.length > 1 ? ` <span class="chip st-copies" title="${esc('Identical copies merged: ' + r.merged.join(', '))}">+${r.merged.length - 1} ${r.merged.length - 1 === 1 ? 'copy' : 'copies'}</span>` : ''}</td>`,
			result: () => `<td><span class="chip ${res.cls}" title="${esc(resTitle)}"><i></i>${res.label}</span></td>`,
			solve: () => `<td class="n" title="${Number.isFinite(r.solveS) ? esc(secWords(r.solveS)) : ''}">${Number.isFinite(r.solveS) ? esc(solveText(r.solveS)) : ''}</td>`,
			by: () => `<td class="st-by">${r.by ? `<i class="sw" style="background:${(BY[r.by] || { color: 'var(--muted)' }).color}"></i>${esc((BY[r.by] || { label: r.by }).label)}` : ''}</td>`,
			best: () => `<td class="n st-best">${r.best ? esc(r.best.time) : ''}</td>`,
			known: () => `<td class="n">${r.known ? esc(r.known.time) : ''}</td>`,
			ratio: () => `<td class="n${Number.isFinite(r.ratio) && r.ratio <= 1 ? ' good' : ''}">${Number.isFinite(r.ratio) ? r.ratio.toFixed(3) : ''}</td>`,
			search: () => `<td class="tnum">${r.searchAlone ? (r.searchAlone.routed ? `${Number.isFinite(r.searchAlone.solveS) ? esc(solveText(r.searchAlone.solveS)) : 'Routed'}${r.searchAlone.best ? ` <span class="muted">→</span> ${esc(r.searchAlone.best.time)}` : ''}` : '<span class="muted">No route</span>') : ''}</td>`,
			compiler: () => `<td>${r.compilerAlone === true ? 'Routed' : r.compilerAlone === false ? '<span class="muted">No route</span>' : ''}</td>`,
			run: () => `<td class="st-runcell">${esc(r.run || '')}</td>`,
		};
		return `<tr>${cols.map((c) => cell[c.k]()).join('')}<td class="st-act">${job ? `<a class="btn small watch" href="/#watch=${esc(job)}" aria-label="Watch the run of ${esc(r.level)}">Watch</a>` : ''}</td></tr>`;
	}
	function rerenderLevels() {
		const el = $('stLvTbl');
		if (el && S.bench.data) el.innerHTML = levelTableHtml(S.bench.data);
	}
	function rerenderRuns() {
		const el = $('stRunsTbl');
		if (el && S.runs.data) el.innerHTML = runsTableHtml(S.runs.data);
	}

	// ---------------------------------------------------------------- events (one delegated set on the page)
	root.addEventListener('click', (e) => {
		const t = e.target;
		const vb = t.closest('.st-head .seg button[data-view]');
		if (vb) { setHash(vb.dataset.view === 'bench' ? (S.benchId ? `bench=${S.benchId}` : 'bench') : 'runs'); return; }
		if (t.closest('[data-act="retry"]')) { refresh(); return; }
		const sb = t.closest('button.th[data-sort]');
		if (sb) {
			const inLv = !!sb.closest('.st-lv'), ui = inLv ? S.bu : S.ru, k = sb.dataset.sort;
			if (ui.sort === k) ui.dir = -ui.dir; else { ui.sort = k; ui.dir = /^(name|level|section|result|by|run|search|compiler)$/.test(k) ? 1 : (inLv ? 1 : -1); }
			if (inLv) rerenderLevels(); else rerenderRuns();
			return;
		}
		const g = t.closest('tr.grp[data-fold]');
		if (g && !t.closest('a')) {
			const [kind, ...rest] = g.dataset.fold.split(':');
			const key = rest.join(':');
			const fold = kind === 'bench' ? S.bu.fold : S.ru.fold;
			if (fold[key]) delete fold[key]; else fold[key] = 1;
			saveFold();
			if (kind === 'bench') rerenderLevels(); else rerenderRuns();
			return;
		}
		const secb = t.closest('.st-filters .seg button[data-sec]');
		if (secb) {
			S.bu.sec = secb.dataset.sec;
			for (const b of secb.parentNode.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === secb));
			rerenderLevels();
		}
	});
	root.addEventListener('keydown', (e) => {
		const g = e.target.closest && e.target.closest('tr.grp[data-fold]');
		if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); g.click(); }
	});
	root.addEventListener('input', (e) => {
		const t = e.target;
		if (t.id === 'stRunQ') { S.ru.q = t.value; rerenderRuns(); } else if (t.id === 'stLvQ') { S.bu.q = t.value; rerenderLevels(); }
	});
	root.addEventListener('change', (e) => {
		const t = e.target;
		if (t.id === 'stLvRes') { S.bu.result = t.value; rerenderLevels(); } else if (t.id === 'stLvBy') { S.bu.by = t.value; rerenderLevels(); } else if (t.id === 'stLvRun') { S.bu.withRun = t.checked; rerenderLevels(); } else if (t.id === 'stBenchSel') { setHash(`bench=${t.value}`); }
	});

	// ---------------------------------------------------------------- start
	frame();
	W.addEventListener('hashchange', onHash);
	W.addEventListener('popstate', onHash);
	onHash();
	setInterval(() => {
		updated();
		if (S.view === 'runs' && D.visibilityState === 'visible' && !S.runs.loading && Date.now() - S.runs.at >= RUNS_POLL_MS) loadRuns(true);
	}, 5000);
	D.addEventListener('visibilitychange', () => { if (D.visibilityState === 'visible' && S.view === 'runs' && Date.now() - S.runs.at >= RUNS_POLL_MS) loadRuns(true); });
	W.addEventListener('eeat-online', () => refresh());
	W.STATS = { refresh };
})();
