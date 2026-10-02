/* EE Auto TAS: the pages' shared script (docs/ui/DESIGN.md sections 3-5). Every page loads it synchronously in its
   <head>, after /ui.css and before its own code, so the theme is set before the first paint. No global but `UI`.
   - the theme: localStorage 'eeat.ui.theme' = auto | dark | light (auto follows the OS), ?theme=dark|light for one load
   - UI.nav(active): marks the active tab of the page's static <nav class="topnav"> and wires the theme button
   - UI.netFail() / UI.netOk(): the offline banner (#offline) after 2 failed requests in a row; fetch() is wrapped, so a
     page's own requests count without any call, and an idle page pings /api every 10 s
   - UI.tip: one tooltip element for the page; any element with data-tip="<escaped html>" shows it on hover
   - formats (UI.fmt, UI.delta, UI.deltaTicks, UI.dur, UI.count, UI.rate, UI.clock, UI.ago, UI.esc), UI.inkOn(color)
   - small charts as strings: UI.spark, UI.bars, UI.histo, UI.steps (a step-line chart with a crosshair), UI.stack, UI.legend */
(function () {
	'use strict';
	const D = document, W = window, root = D.documentElement;

	// ---------------------------------------------------------------- storage (never throws: private windows, blocked storage)
	const store = {
		get(k, d) { try { const v = W.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
		set(k, v) { try { W.localStorage.setItem(k, String(v)); } catch (e) { /* not kept */ } },
	};

	// ---------------------------------------------------------------- theme
	const THEME_KEY = 'eeat.ui.theme';
	const MODES = ['auto', 'dark', 'light'];
	const MODE_TITLE = { auto: 'Theme: follows the system', dark: 'Theme: night', light: 'Theme: day' };
	let mode = store.get(THEME_KEY, 'auto');
	if (!MODES.includes(mode)) mode = 'auto';
	let forced = null;
	try { const q = new URLSearchParams(W.location.search).get('theme'); if (q === 'dark' || q === 'light') forced = q; } catch (e) { /* none */ }
	const darkMq = W.matchMedia ? W.matchMedia('(prefers-color-scheme: dark)') : null;
	function themeNow() { return forced || mode; }
	function isNight() { const m = themeNow(); return m === 'dark' || (m === 'auto' && !!(darkMq && darkMq.matches)); }
	function applyTheme() {
		const m = themeNow();
		if (m === 'auto') delete root.dataset.theme; else root.dataset.theme = m;
		const b = D.getElementById('themeBtn');
		if (b) { b.dataset.mode = m; b.title = MODE_TITLE[m]; b.setAttribute('aria-label', MODE_TITLE[m]); }
	}
	function setTheme(m) {
		if (!MODES.includes(m)) return;
		mode = m; forced = null; store.set(THEME_KEY, m); applyTheme();
		try { W.dispatchEvent(new CustomEvent('eeat-theme', { detail: { mode: m, night: isNight() } })); } catch (e) { /* old browser */ }
	}
	applyTheme();
	if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', () => { if (themeNow() === 'auto') { try { W.dispatchEvent(new CustomEvent('eeat-theme', { detail: { mode: 'auto', night: isNight() } })); } catch (e) { /* old */ } } });

	// ---------------------------------------------------------------- the navigation
	let navDone = false;
	function nav(active) {
		const n = D.querySelector('.topnav');
		if (!n) return;
		active = active || (D.body && D.body.dataset.page) || '';
		for (const a of n.querySelectorAll('.tab')) {
			if (a.dataset.tab === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
		}
		const b = D.getElementById('themeBtn');
		if (b && !b.dataset.wired) {
			b.dataset.wired = '1';
			b.addEventListener('click', () => setTheme(MODES[(MODES.indexOf(themeNow()) + 1) % MODES.length]));
		}
		applyTheme();
		navDone = true;
	}

	// ---------------------------------------------------------------- the offline banner
	const OFFLINE_TEXT = '<b>The app is not answering.</b> It may have been closed: start it again with START.bat (or EEAutoTAS.exe). Trying again every 5 s.';
	const fetch0 = W.fetch ? W.fetch.bind(W) : null;
	let fails = 0, offline = false, pingTimer = 0, lastNet = Date.now();
	function banner(show) {
		// (the page as a whole knows: live badges grey, the actions that need the app off, ui.css .offline)
		root.classList.toggle('offline', !!show);
		const el = D.getElementById('offline');
		if (!el) return;
		if (show) { el.innerHTML = OFFLINE_TEXT; el.setAttribute('role', 'status'); el.hidden = false; } else el.hidden = true;
	}
	function ping() {
		if (!fetch0) return;
		fetch0('/api', { cache: 'no-store' }).then(() => netOk(), () => netFail());
	}
	function netFail() {
		lastNet = Date.now();
		fails++;
		if (fails >= 2 && !offline) { offline = true; banner(true); }
		if (offline && !pingTimer) pingTimer = setInterval(ping, 5000);
	}
	function netOk() {
		lastNet = Date.now();
		fails = 0;
		if (offline) { offline = false; banner(false); try { W.dispatchEvent(new CustomEvent('eeat-online')); } catch (e) { /* old */ } }
		if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
	}
	if (fetch0) {
		// a request that reaches the server (any status) is the app answering; a network error is not (an abort is neither)
		W.fetch = function (...a) {
			return fetch0(...a).then((r) => { netOk(); return r; }, (e) => { if (!e || e.name !== 'AbortError') netFail(); throw e; });
		};
	}
	// an idle page (the editor with nothing running) still notices the app going away
	setInterval(() => { if (!offline && D.visibilityState === 'visible' && Date.now() - lastNet > 10000) ping(); }, 5000);

	// ---------------------------------------------------------------- formats
	const MINUS = '−';
	const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const pad2 = (n) => String(n).padStart(2, '0');
	/** run ticks (1 tick = 0.01 s) as m:ss.cc (h:mm:ss.cc from an hour) */
	function fmt(t) {
		if (t === null || t === undefined || !isFinite(t)) return '';
		const neg = t < 0; t = Math.round(Math.abs(t));
		const cc = t % 100, s = Math.floor(t / 100) % 60, m = Math.floor(t / 6000) % 60, h = Math.floor(t / 360000);
		return (neg ? MINUS : '') + (h ? `${h}:${pad2(m)}` : `${m}`) + `:${pad2(s)}.${pad2(cc)}`;
	}
	/** a change of run ticks in seconds, with its sign: −0.54 s */
	function delta(t) {
		if (!isFinite(t)) return '';
		const a = Math.abs(t) / 100;
		const v = a >= 60 ? fmt(Math.abs(t)) : a.toFixed(2) + ' s';
		return (t < 0 ? MINUS : t > 0 ? '+' : '') + v;
	}
	function count(n) { return isFinite(n) ? Math.round(n).toLocaleString('en-US') : ''; }
	function deltaTicks(t) { return (t < 0 ? MINUS : t > 0 ? '+' : '') + count(Math.abs(t)) + (Math.abs(t) === 1 ? ' tick' : ' ticks'); }
	/** a duration in ms: 45 s, 4 min 01 s, 12 min, 3 h 05 min */
	function dur(ms) {
		if (!isFinite(ms) || ms < 0) return '';
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s} s`;
		if (s < 600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min`;
		if (m >= 2880) return `${Math.floor(m / 1440)} days`;
		return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
	}
	/** a speed in ticks per second: 13.1 M */
	function rate(n) {
		if (!isFinite(n) || n <= 0) return '0';
		if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' G';
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' M';
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + ' k';
		return String(Math.round(n));
	}
	function clock(t) { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
	function ago(ms) { return dur(Math.max(0, ms)) + ' ago'; }

	// ---------------------------------------------------------------- colours
	function cssVar(name, el) { try { return getComputedStyle(el || root).getPropertyValue(name).trim(); } catch (e) { return ''; } }
	function rgbOf(c) {
		if (!c) return null;
		c = String(c).trim();
		const v = /^var\((--[\w-]+)\)$/.exec(c);
		if (v) c = cssVar(v[1]);
		let m = /^#([0-9a-f]{3})$/i.exec(c);
		if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
		m = /^#([0-9a-f]{6})/i.exec(c);
		if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
		m = /^rgba?\(([^)]+)\)/i.exec(c);
		if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
		return null;
	}
	function lum(rgb) {
		const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
	}
	/** the label colour on a block of colour c: white or near-black, whichever contrasts more */
	function inkOn(c) {
		const rgb = rgbOf(c);
		if (!rgb) return '#ffffff';
		const L = lum(rgb), dark = lum([11, 15, 23]);
		return (1.05 / (L + 0.05)) >= ((L + 0.05) / (dark + 0.05)) ? '#ffffff' : '#0b0f17';
	}

	// ---------------------------------------------------------------- tooltip
	let tipEl = null, tipFor = null, tipChart = null;
	function tipNode() {
		if (!tipEl) { tipEl = D.createElement('div'); tipEl.className = 'tip'; tipEl.hidden = true; tipEl.setAttribute('role', 'tooltip'); D.body.appendChild(tipEl); }
		return tipEl;
	}
	function tipShow(html, x, y) {
		const t = tipNode();
		if (t.innerHTML !== html) t.innerHTML = html;
		t.hidden = false;
		const r = t.getBoundingClientRect(), vw = W.innerWidth, vh = W.innerHeight;
		let left = x + 12, top = y + 12;
		if (left + r.width > vw - 8) left = Math.max(8, x - 12 - r.width);
		if (top + r.height > vh - 8) top = Math.max(8, y - 12 - r.height);
		t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}
	function tipHide() { if (tipEl) tipEl.hidden = true; tipFor = null; if (tipChart) { chartLeave(tipChart); tipChart = null; } }
	function onPointer(e) {
		const tg = e.target;
		const chart = tg && tg.closest ? tg.closest('svg[data-chart]') : null;
		if (chart && CHARTS.has(chart.dataset.chart)) {
			const ch = CHARTS.get(chart.dataset.chart);
			const html = chartHover(ch, chart, e);
			if (tipChart && tipChart !== chart) chartLeave(tipChart);
			tipChart = chart;
			// a mark's own tooltip wins over the crosshair's
			const own = tg.closest('[data-tip]');
			if (own && chart.contains(own)) { tipShow(own.getAttribute('data-tip'), e.clientX, e.clientY); return; }
			if (html) tipShow(html, e.clientX, e.clientY); else tipHide();
			return;
		}
		if (tipChart) { chartLeave(tipChart); tipChart = null; }
		const el = tg && tg.closest ? tg.closest('[data-tip]') : null;
		if (!el) { if (tipEl && !tipEl.hidden) tipHide(); return; }
		tipFor = el;
		tipShow(el.getAttribute('data-tip'), e.clientX, e.clientY);
	}
	D.addEventListener('pointermove', onPointer, { passive: true });
	D.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') onPointer(e); }, { passive: true });
	D.addEventListener('scroll', () => tipHide(), { passive: true, capture: true });
	D.addEventListener('pointerleave', () => tipHide());

	// ---------------------------------------------------------------- charts
	const CHARTS = new Map();
	let chartSeq = 0;
	function chartId(spec) {
		const id = 'c' + (++chartSeq);
		CHARTS.set(id, spec);
		if (CHARTS.size > 300) CHARTS.delete(CHARTS.keys().next().value);
		return id;
	}
	function chartLeave(svg) { const xh = svg.querySelector('.xh'); if (xh) xh.setAttribute('visibility', 'hidden'); }
	function chartHover(ch, svg, e) {
		if (!ch.hover) return '';
		const r = svg.getBoundingClientRect();
		if (!r.width) return '';
		const X = (e.clientX - r.left) * (ch.w / r.width);
		if (X < ch.x0 - 2 || X > ch.x1 + 2) { chartLeave(svg); return ''; }
		const xh = svg.querySelector('.xh');
		if (xh) { xh.setAttribute('x1', X); xh.setAttribute('x2', X); xh.setAttribute('visibility', 'visible'); }
		return ch.hover(ch.inv(Math.max(ch.x0, Math.min(ch.x1, X))));
	}
	const num = (v) => Math.round(v * 10) / 10;
	const attrTip = (html) => (html ? ` data-tip="${esc(html)}"` : '');
	function niceTicks(lo, hi, n) {
		if (!(hi > lo)) return [lo];
		const raw = (hi - lo) / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw)));
		const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) || raw;
		const out = [];
		for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
		return out;
	}
	/** a sparkline: the best time over wall time as steps (pts [[t, value]...], lower values lower), the last point a dot.
	 *  o: {w 120, h 28, color 'var(--ink-2)', dot 'var(--coin-mark)', tip (html), lw 1.5} */
	function spark(pts, o) {
		o = o || {};
		const w = o.w || 120, h = o.h || 28, pad = 5;
		if (!pts || !pts.length) return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
		const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
		const x0 = Math.min(...xs), x1 = Math.max(o.tEnd || 0, ...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
		const X = (t) => pad + (x1 > x0 ? (t - x0) / (x1 - x0) : 1) * (w - 2 * pad);
		const Y = (v) => pad + (y1 > y0 ? (y1 - v) / (y1 - y0) : 0.5) * (h - 2 * pad);
		let d = `M${num(X(xs[0]))},${num(Y(ys[0]))}`;
		for (let i = 1; i < pts.length; i++) d += `H${num(X(xs[i]))}V${num(Y(ys[i]))}`;
		const lx = X(x1);
		d += `H${num(lx)}`;
		const ly = Y(ys[ys.length - 1]);
		return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${attrTip(o.tip)} role="img" aria-label="${esc(o.label || 'trend')}">` +
			`<rect width="${w}" height="${h}" fill="transparent"/>` +
			`<path d="${d}" fill="none" style="stroke:${o.color || 'var(--ink-2)'}" stroke-width="${o.lw || 1.5}" stroke-linejoin="round" stroke-linecap="round"/>` +
			`<circle cx="${num(lx)}" cy="${num(ly)}" r="4" style="fill:${o.dot || 'var(--coin-mark)'};stroke:var(--panel)" stroke-width="2"/></svg>`;
	}
	/** horizontal bars (HTML): items [{label, value, color, text, tip}]; o: {max}. Three columns: the label, a track whose bar is
	 *  exactly value / max of it (every track the same length, so the bars compare), the value's text after it. */
	function bars(items, o) {
		o = o || {};
		const max = o.max || Math.max(1, ...items.map((i) => Math.abs(i.value) || 0));
		return `<div class="hbars">` + items.map((i) => {
			const pct = Math.max(0, Math.min(100, (Math.abs(i.value) || 0) / max * 100));
			return `<div class="hl"${attrTip(i.tip)}>${i.color ? `<i class="sw" style="background:${i.color}"></i>` : ''}${esc(i.label)}</div>` +
				`<div class="hb"${attrTip(i.tip)} role="img" aria-label="${esc(i.label)}: ${esc(i.text === undefined ? count(i.value) : i.text)}">${pct > 0 ? `<i style="width:${pct.toFixed(2)}%;background:${i.color || 'var(--ink-2)'}"></i>` : ''}</div>` +
				`<div class="hv"${attrTip(i.tip)}>${esc(i.text === undefined ? count(i.value) : i.text)}</div>`;
		}).join('') + `</div>`;
	}
	/** a histogram (SVG): bins [{label, n, tip}]; o: {w 360, h 150, color 'var(--ink-2)', label (aria)} */
	function histo(bins, o) {
		o = o || {};
		const w = o.w || 360, h = o.h || 150, padT = 18, padB = 22, padX = 4;
		const max = Math.max(1, ...bins.map((b) => b.n || 0));
		const band = (w - 2 * padX) / Math.max(1, bins.length), bw = Math.min(24, band * 0.62), base = h - padB;
		const Y = (n) => base - (n / max) * (base - padT);
		let s = `<svg class="uic" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(o.label || 'histogram')}">`;
		s += `<line class="gl" x1="${padX}" x2="${w - padX}" y1="${base + 0.5}" y2="${base + 0.5}"/>`;
		bins.forEach((b, i) => {
			const cx = padX + band * (i + 0.5), x = cx - bw / 2, n = b.n || 0;
			if (n > 0) {
				const y = Y(n), r = Math.min(4, (base - y) / 2);
				s += `<path class="mk" d="M${num(x)},${base}V${num(y + r)}Q${num(x)},${num(y)} ${num(x + r)},${num(y)}H${num(x + bw - r)}Q${num(x + bw)},${num(y)} ${num(x + bw)},${num(y + r)}V${base}Z" style="fill:${o.color || 'var(--ink-2)'}"/>`;
				s += `<text class="vx" x="${num(cx)}" y="${num(y - 5)}" text-anchor="middle">${count(n)}</text>`;
			}
			s += `<text class="ax" x="${num(cx)}" y="${h - 6}" text-anchor="middle">${esc(b.label)}</text>`;
			s += `<rect class="hit" x="${num(cx - band / 2)}" y="${padT - 14}" width="${num(band)}" height="${base - padT + 14}"${attrTip(b.tip || `<span class="tv">${count(n)}</span> ${esc(b.label)}`)}/>`;
		});
		return s + `</svg>`;
	}
	/** a step-line chart with one y axis, a legend-free direct label at each line's end and a crosshair tooltip.
	 *  series [{name, color, pts [[x, y] ...], w (stroke, 2)}]; o: {w 640, h 220, xlog, xmin, xmax, ymin, ymax,
	 *  xfmt, yfmt, xticks [..], yticks [..], label (aria), hoverFmt(x, rows) -> html, endLabels true} */
	function steps(series, o) {
		o = o || {};
		const w = o.w || 640, h = o.h || 220, padL = o.padL || 48, padR = o.padR || (o.endLabels === false ? 10 : 110), padT = 12, padB = 24;
		const all = series.flatMap((s) => s.pts);
		const xmin = o.xmin !== undefined ? o.xmin : Math.min(...all.map((p) => p[0]));
		const xmax = o.xmax !== undefined ? o.xmax : Math.max(...all.map((p) => p[0]));
		const ymin = o.ymin !== undefined ? o.ymin : Math.min(0, ...all.map((p) => p[1]));
		const ymax = o.ymax !== undefined ? o.ymax : Math.max(1, ...all.map((p) => p[1]));
		const lg = !!o.xlog;
		const tx = (v) => (lg ? Math.log10(Math.max(v, 1e-9)) : v);
		const a = tx(xmin), b = tx(xmax) > a ? tx(xmax) : a + 1;
		const X = (v) => padL + (tx(v) - a) / (b - a) * (w - padL - padR);
		const inv = (px) => { const t = a + (px - padL) / (w - padL - padR) * (b - a); return lg ? Math.pow(10, t) : t; };
		const Y = (v) => padT + (ymax > ymin ? (ymax - v) / (ymax - ymin) : 0.5) * (h - padT - padB);
		const xf = o.xfmt || ((v) => String(Math.round(v))), yf = o.yfmt || ((v) => count(v));
		const yt = o.yticks || niceTicks(ymin, ymax, 4);
		const xt = o.xticks || niceTicks(xmin, xmax, 6);
		const id = chartId({});
		let s = `<svg class="uic" data-chart="${id}" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(o.label || 'chart')}">`;
		for (const v of yt) s += `<line class="gl" x1="${padL}" x2="${w - padR}" y1="${num(Y(v)) + 0.5}" y2="${num(Y(v)) + 0.5}"/><text class="ax" x="${padL - 6}" y="${num(Y(v)) + 4}" text-anchor="end">${esc(yf(v))}</text>`;
		for (const v of xt) { if (v < xmin || v > xmax) continue; s += `<text class="ax" x="${num(X(v))}" y="${h - 6}" text-anchor="middle">${esc(xf(v))}</text>`; }
		const ends = [];
		for (const se of series) {
			const p = se.pts.slice().sort((u, v) => u[0] - v[0]);
			if (!p.length) continue;
			let d = `M${num(X(p[0][0]))},${num(Y(p[0][1]))}`;
			for (let i = 1; i < p.length; i++) d += `H${num(X(p[i][0]))}V${num(Y(p[i][1]))}`;
			const endX = o.extend === false ? X(p[p.length - 1][0]) : X(xmax);
			d += `H${num(endX)}`;
			s += `<path d="${d}" fill="none" style="stroke:${se.color}" stroke-width="${se.w || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
			ends.push({ x: endX, y: Y(p[p.length - 1][1]), name: se.name, color: se.color, v: p[p.length - 1][1] });
		}
		if (o.endLabels !== false) {
			ends.sort((u, v) => u.y - v.y);
			for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].ly = (ends[i - 1].ly || ends[i - 1].y) + 14;
			for (const e of ends) s += `<circle cx="${num(e.x)}" cy="${num(e.y)}" r="4" style="fill:${e.color};stroke:var(--panel)" stroke-width="2"/><text class="lbl" x="${num(e.x + 8)}" y="${num((e.ly || e.y) + 4)}">${esc(e.name)} ${esc(yf(e.v))}</text>`;
		}
		s += `<line class="xh" x1="0" x2="0" y1="${padT}" y2="${h - padB}" visibility="hidden"/>`;
		s += `<rect class="hit" x="${padL}" y="${padT}" width="${w - padL - padR}" height="${h - padT - padB}"/>`;
		// marks over the hit area (their own tooltips): o.marks [{x, y, color, tip}], 8 px dots with a 2 px ring of the surface;
		// marks closer than 10 px are one dot (the newest, "+ n more here" in its tip): rings that overlap cut the line into dashes
		const mk = (o.marks || []).map((m) => ({ m, cx: X(m.x), cy: Y(m.y) })).sort((u, v) => u.cx - v.cx);
		const groups = [];
		for (const q of mk) {
			const g = groups[groups.length - 1];
			if (g && Math.hypot(q.cx - g.last.cx, q.cy - g.last.cy) < 10) { g.n++; g.last = q; } else groups.push({ n: 1, last: q });
		}
		for (const g of groups) {
			const { m, cx, cy } = g.last;
			const tip = g.n > 1 && m.tip ? `${m.tip}<br><span class="muted">+ ${g.n - 1} more here</span>` : m.tip;
			s += `<circle class="mk" cx="${num(cx)}" cy="${num(cy)}" r="4" style="fill:${m.color || 'var(--coin-mark)'};stroke:var(--panel)" stroke-width="2"${attrTip(tip)}/>`;
		}
		s += `</svg>`;
		const spec = CHARTS.get(id);
		Object.assign(spec, {
			w, x0: padL, x1: w - padR, inv,
			hover: (xv) => {
				const rows = series.map((se) => {
					const p = se.pts.slice().sort((u, v) => u[0] - v[0]);
					let val = null;
					for (const q of p) { if (q[0] <= xv) val = q[1]; else break; }
					return { name: se.name, color: se.color, v: val };
				});
				if (o.hoverFmt) return o.hoverFmt(xv, rows);
				return `<div><b>${esc(xf(xv))}</b></div>` + rows.map((r) => `<div class="tr"><i class="tk" style="background:${r.color}"></i><span class="tv">${r.v === null ? '-' : esc(yf(r.v))}</span> ${esc(r.name)}</div>`).join('');
			},
		});
		return s;
	}
	/** a 100% stacked bar (HTML): parts [{label, value, color, tip}]; o: {legend true, h 24} */
	function stack(parts, o) {
		o = o || {};
		const tot = parts.reduce((s, p) => s + (p.value || 0), 0) || 1;
		let s = `<div class="stackbar" style="height:${o.h || 24}px" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.value}`).join(', '))}">`;
		for (const p of parts) if (p.value > 0) s += `<i style="flex:${p.value} 1 0;background:${p.color}"${attrTip(p.tip || `<span class="tv">${count(p.value)}</span> ${esc(p.label)} (${Math.round(p.value / tot * 100)}%)`)}></i>`;
		s += `</div>`;
		if (o.legend !== false) s += legend(parts.map((p) => ({ label: `${p.label} ${count(p.value)}`, color: p.color })));
		return s;
	}
	/** a legend: items [{label, color, line (a line key instead of a swatch)}] */
	function legend(items) {
		return `<div class="legend">` + items.map((i) => `<span>${i.line ? `<i class="lk" style="background:${i.color}"></i>` : `<i class="sw" style="background:${i.color}"></i>`}${esc(i.label)}</span>`).join('') + `</div>`;
	}

	// ---------------------------------------------------------------- motion
	const reduced = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null;
	function motion() { return !(reduced && reduced.matches); }
	/** the one orchestrated moment: a new best slides into the element */
	function newBest(el) {
		if (!el || !motion()) return;
		el.classList.remove('ui-slide');
		void el.offsetWidth;
		el.classList.add('ui-slide');
	}

	W.UI = {
		store, nav, setTheme, isNight, theme: themeNow,
		netFail, netOk, isOffline: () => offline,
		tip: { show: tipShow, hide: tipHide },
		esc, fmt, delta, deltaTicks, count, dur, rate, clock, ago, MINUS,
		cssVar, inkOn, niceTicks,
		spark, bars, histo, steps, stack, legend,
		motion, newBest,
	};
	if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', () => { if (!navDone) nav(); });
	else nav();
})();
