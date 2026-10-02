/* EE Auto TAS: the Optimizer view (docs/ui/DESIGN.md section 9), served as /phases.js and loaded with `defer` by index.html and
   editor.html after /ui.js. One component for two sources: a job's optimizer (GET /api/jobs/<id>/phases: src/phases.js builds
   the timeline model from grind_events.jsonl and gpu/events.jsonl, or from grind.log for older runs) and the level editor's
   Hybrid (best) run (GET /api/editor/hybrid `timeline`). It shows what the optimizer does now (a sentence), the round's stages
   (chips), the best time over time above a tape of the phases (one row per lane: the stages, the sweep's lanes, the corridor
   beam, the GPU, the runs handed in; gold diamonds where time was found), a legend, a scoreboard of what found time and a guide
   to the phases.

   THE PHASE DICTIONARY (the families, the stages, their plain names and one-line explanations) is in this file too: in the
   browser it is window.TL.dict; in Node (src/phases.js: require('./app/phases.js')) it is module.exports, so the server's
   model and the page use the same names. The view itself only runs in a browser (window.document).

   THE CONTRACT (what the pages call; the pages call it only behind `typeof TL === 'object'`, so a broken file breaks nothing):

   Runs page (index.html, the job sheet's <section class="sec opt" id="opt">):
   - TL.mount(el, { job, summary })  a run was picked: build the view in `el`, fetch GET /api/jobs/<job>/phases and poll it
                                     every 3 s while the run runs and the tab is visible (?sig= skips unchanged payloads),
                                     once when it is stopped and again when its best or state changes.
   - TL.update(summary)              every /api/state poll of the run on screen: the live speed, and a fetch when the run's
                                     state, stage or best changed.
   - TL.unmount(el)                  before another run is mounted in `el` (its timers and fetches stop).
   - TL.classify(entry, job)         an Improvements row (a summary.history entry {t, runTicks, saved, what}) -> { label,
                                     color ('var(--ph-<family>)'), round } (the round when the timeline knows it).
   Level editor (editor.html, the Hybrid's panel):
   - TL.render(el, model, { compact, sheet })  the hybrid's timeline (GET /api/editor/hybrid `timeline`): { compact: true,
                                     sheet: 'hySheet' } in #hyTape (300 px: the now sentence, the best route's steps, the lanes,
                                     "Open the full view" -> window.hySheetOpen()); { compact: false } in the sheet #hySheetBody.
   - TL.html(model, opts)            the same view as an HTML string (tests: test/phases.js).

   Shared tools from /ui.js (window.UI) when it is there: the tooltip (any element with data-tip), UI.store, UI.motion; the phase
   colours are the CSS variables --ph-tweak, --ph-explore, --ph-path, --ph-local, --ph-finish, --ph-combine, --ph-outside. */
(function (root) {
	'use strict';

	// ================================================================ the phase dictionary (DESIGN.md 11.2), shared with src/phases.js
	const FAMS = [
		{ fam: 'tweak', label: 'Input tweaks', explain: 'Changing one or two inputs, or random variations of the run, and keeping the changes that meet the run again sooner.' },
		{ fam: 'explore', label: 'Route explore', explain: 'Trying every move in a window of the run.' },
		{ fam: 'path', label: 'Path changes', explain: 'Taking another way from somewhere along the run.' },
		{ fam: 'local', label: 'Local search', explain: 'Small searches along the run: shortcuts, beams, the corridor beam.' },
		{ fam: 'finish', label: 'Finish & timing', explain: 'The exact ending, and the timing of time doors and of the start.' },
		{ fam: 'combine', label: 'Combine', explain: 'Joining the best run with other runs\' faster stretches.' },
		{ fam: 'outside', label: 'Handed in', explain: 'Runs handed in from outside the optimizer: Find a route, you, a rented machine.' },
	];
	const FAM = Object.fromEntries(FAMS.map((f) => [f.fam, f]));
	const colorOf = (fam) => `var(--ph-${FAM[fam] ? fam : 'combine'})`;
	// the stages: matched on a span's name, a history entry's `what`, or a GPU slot's family (`slot`); the first match wins
	const W_IN = '^(?:inbox \\(|try: )';
	const STAGES = [
		// ("<a stage's run> + best (splice ...)": a stage's find spliced with the best is that stage's find, as grind.js credits
		// its span: classify() names it by its leading stage, and only a lead it cannot name is the combine's)
		{ key: 'splice', label: 'Combine', fam: 'combine', explain: 'Joins the best run with every other run\'s faster stretches where they reach the same state.',
			re: [/^splice$/, /^\d+ earlier runs?\b/, /^recover$/] },
		{ key: 'gpu', label: 'GPU search', fam: 'tweak', explain: 'The GPU searcher\'s find, checked by the optimizer.', re: [/^inbox \(gpu\b/, /^try: gpu\b/] },
		{ key: 'endgame', label: 'Exact finish', fam: 'finish', explain: 'Tries every input over the run\'s last ticks; when nothing is faster, the ending is proven.',
			re: [/^endgame/, new RegExp(W_IN + 'endgame', 'i')] },
		{ key: 'focus', label: 'Search harder', fam: 'explore', explain: 'Your "Search harder" range, searched next to the optimizer.', re: [new RegExp(W_IN + 'focus', 'i')] },
		{ key: 'fr', label: 'Find a route', fam: 'outside', explain: 'A route from Find a route, handed to the optimizer.', re: [new RegExp(W_IN + '(?:find a route|autotas)', 'i')] },
		{ key: 'hybrid', label: 'Hybrid (best)', fam: 'outside', explain: 'A route from the level editor\'s Hybrid (best): the compiler and the search side by side.', re: [new RegExp(W_IN + 'hybrid', 'i')] },
		{ key: 'remote', label: 'Rented machine', fam: 'outside', explain: 'A faster run from the copy on a rented machine.', re: [/^try: .*farm/i] },
		{ key: 'mut', label: 'Input tweaks', fam: 'tweak', explain: 'Changes one or two inputs at every tick and keeps every change that rejoins the run sooner.', re: [/^mutate_/] },
		{ key: 'skipf', label: 'Skip finder', fam: 'path', explain: 'From states all along the run, searches for a later point it can reach sooner another way.', re: [/^skipfind/] },
		{ key: 'sweep', label: 'Route sweep', fam: 'explore', explain: 'Tries every move in windows of 800 ticks across the whole run, up to 4 windows at once.', re: [/^sweep\d+(?:_\d+p?)?(?:\s|$)/] },
		{ key: 'loop', label: 'Loop cutter', fam: 'explore', explain: 'Looks for a way around a stretch where the run comes back to where it was.', re: [/^deep\d+_loop/] },
		{ key: 'seg', label: 'Coin-to-coin explore', fam: 'explore', explain: 'Tries every move between coins, one window after another.', re: [/^deep\d+_seg/, /^deep\d+$/] },
		{ key: 'skips', label: 'Skip search', fam: 'path', explain: 'Finds spots the run passes early and only uses later, and tries every move from there.', re: [/^skips\d/] },
		{ key: 'flyb', label: 'Corridor beam', fam: 'local', explain: 'Follows long flying, falling or sliding stretches with thousands of variations at once.', re: [/^flybeam/] },
		{ key: 'sc', label: 'Local shortcuts', fam: 'local', explain: 'Searches many small shortcuts from a cursor that moves along the run.', re: [/^shortcuts/] },
		{ key: 'phase', label: 'Time doors', fam: 'finish', explain: 'Shifts the run so time and coin doors open sooner, with free idle ticks before the first input.', re: [/^phaseb?\d/] },
		{ key: 'beam', label: 'Beam search', fam: 'local', explain: 'Plays thousands of runs side by side and keeps the ones furthest ahead.', re: [/^beam\d/] },
		{ key: 'gpu-m1', label: 'GPU: one-input tweaks', fam: 'tweak', explain: 'The GPU changes single inputs at every tick (and leaves ticks out), millions at a time.', slot: ['m1', 'm1+del', 'sys'] },
		{ key: 'gpu-del', label: 'GPU: skipped ticks', fam: 'tweak', explain: 'The GPU tries leaving ticks out.', slot: ['del'] },
		{ key: 'gpu-m2', label: 'GPU: two-input tweaks', fam: 'tweak', explain: 'The GPU changes pairs of inputs.', slot: ['m2'] },
		{ key: 'gpu-rand', label: 'GPU: random variations', fam: 'tweak', explain: 'The GPU tries random variations of stretches of the run.', slot: ['pert', 'flip', 'sticky'] },
		{ key: 'gpu-every', label: 'GPU: every move', fam: 'explore', explain: 'The GPU tries every move in short windows along the run.', slot: ['every'] },
		{ key: 'gpu-idle', label: 'GPU: idle start', fam: 'finish', explain: 'The GPU waits before the first input (free: the timer starts there) and looks for faster ways from there.', slot: ['idle'] },
		{ key: 'in', label: 'Handed in', fam: 'outside', explain: 'A run handed in from outside (a script, tas.js try, a probe).', re: [/^inbox \(/, /^try: /, /^try$/] },
	];
	const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s]));
	// what the GPU does, for the now sentence ("The GPU tries random variations.")
	const GPU_DOES = { 'gpu-m1': 'changes single inputs', 'gpu-del': 'leaves ticks out', 'gpu-m2': 'changes pairs of inputs', 'gpu-rand': 'tries random variations',
		'gpu-every': 'tries every move in short windows', 'gpu-idle': 'tries waiting at the start', gpu: 'searches' };
	const brief = (s) => ({ key: s.key, fam: s.fam, label: s.label, explain: s.explain });
	/** a GPU slot's family (m1, m1+del, del, m2, pert, flip, sticky, every, idle) -> {key, fam, label, explain} */
	function classifySlot(f) {
		for (const s of STAGES) if (s.slot && s.slot.includes(String(f))) return brief(s);
		return { key: 'gpu', fam: 'tweak', label: 'GPU search', explain: STAGE.gpu.explain };
	}
	/**
	 * a span's name or a history entry's `what` -> {key, fam, label, explain}. ctx: {slot: true} (a GPU slot's family), {gpuFam:
	 * 'pert'} (a GPU find's largest credit: its family and label), {remote: '<the job's remote source>'}
	 */
	function classify(s, ctx) {
		s = String(s === undefined || s === null ? '' : s);
		if (ctx && ctx.slot) return classifySlot(s);
		// a stage's find spliced with the best (grind.js spliceNow: "<what> + best (splice, n runs)") is its stage's find
		const sp = /^(.+?) \+ best \(splice/.exec(s);
		if (sp) { const c = classify(sp[1], ctx); return c.key === 'other' ? brief(STAGE.splice) : c; }
		if (ctx && ctx.remote && (s === `try: ${ctx.remote}` || s === `inbox (${ctx.remote})`)) return brief(STAGE.remote);
		for (const st of STAGES) {
			if (!st.re || !st.re.some((r) => r.test(s))) continue;
			if (st.key === 'gpu' && ctx && ctx.gpuFam) {
				const g = classifySlot(ctx.gpuFam);
				return { key: 'gpu', fam: g.fam, label: g.label, explain: `${STAGE.gpu.explain} ${g.explain}` };
			}
			return brief(st);
		}
		return { key: 'other', fam: 'combine', label: s.replace(/^inbox \((.*)\)$/, '$1').slice(0, 60) || 'other', explain: '' };
	}
	// the grind's round, stage by stage (grind.js STAGES_ALL / STAGES_PHASE keys): the chips of the round recipe
	const RECIPE = {
		mutA: 'mut', mutB: 'mut', mutC: 'mut', skipfA: 'skipf', skipf: 'skipf', endgame: 'endgame', deep: 'sweep', skips: 'skips', flyb: 'flyb', sc: 'sc',
		phase: 'phase', phaseB: 'phase', beam: 'beam', splice: 'splice',
	};
	const STAGES_ALL = ['mutA', 'skipfA', 'endgame', 'deep', 'skips', 'skipf', 'flyb', 'mutB', 'sc', 'phase', 'mutC', 'beam', 'splice'];
	const STAGES_PHASE = ['mutA', 'skipfA', 'phase', 'endgame', 'phaseB', 'deep', 'skips', 'skipf', 'flyb', 'mutB', 'sc', 'mutC', 'beam', 'splice'];
	/** a recipe key (mutA, deep, ...) -> {key, fam, label, explain} */
	const recipeOf = (k) => { const s = STAGE[RECIPE[k]]; return s ? Object.assign(brief(s), { key: k, dict: s.key }) : { key: k, fam: 'combine', label: k, explain: '' }; };
	// why a stage of the round did not run when the grind passes it by without a word
	const SKIP_WHY = {
		mutA: 'nothing to change', mutB: 'nothing to change', mutC: 'nothing to change',
		skipfA: 'the skip finder is opt-in (--skipfind=1), and runs here only in a first round', skipf: 'the skip finder is opt-in (--skipfind=1)',
		endgame: 'the ending has not changed since its last exact search', deep: 'nothing left to sweep this round',
		skips: 'once per best, at most every third round (not on time-door levels)', flyb: 'the corridor beam is opt-in as a stage',
		flybLane: 'the corridor beam runs in its own lane (below), not as a stage', sc: 'no time left in the round',
		phase: 'only on levels with time doors or counting coin doors', phaseB: 'only after a new best on time-door levels',
		beam: 'every other round when there is time (every 4th anyway)', splice: 'nothing to combine',
	};
	// the level editor's Hybrid (best): its parts (the lanes) and the compiler's stages (src/compile.js)
	const HY_PARTS = {
		compiler: { label: 'Compiler', fam: 'explore', color: 'var(--ph-explore)', explain: 'The compiler: the level -> a plan of which trigger to take next -> moves derived from the physics. No search.' },
		search: { label: 'Search', fam: 'tweak', color: 'var(--ph-tweak)', explain: 'Find a route (the GPU and CPU searches), then the optimizer on its route.' },
		prefix: { label: 'Prefix search', fam: 'path', color: 'var(--ph-path)', explain: 'A search from the compiler\'s furthest point, when the compiler is stuck.' },
		optimizer: { label: 'Optimizer', fam: 'local', color: 'var(--ph-local)', explain: 'The polish after the first route: the optimizer, the compiler\'s polish and the joins.' },
	};
	const HY_STAGES = { parse: 'Reading the level', model: 'Level model', bounds: 'Bounds', plan: 'Planning the order', moves: 'Building the moves', oneshot: 'One shot',
		verify: 'Verifying', perfect: 'Order and polish', polish: 'Polishing', repolish: 'Polishing again', prove: 'Proving legs', lastpolish: 'The last polish',
		loops: 'Cutting loops', joins: 'Carrying speed across joins', endgame: 'Exact finish' };
	const HY_ORDER = ['parse', 'model', 'bounds', 'plan', 'moves', 'verify', 'perfect', 'polish', 'prove', 'loops', 'joins', 'endgame'];
	const HY_STATES = { finding: 'Find a route', optimizing: 'Optimizing', done: 'Ended', ended: 'Ended' };

	// ---------------------------------------------------------------- formats (the same as ui.js: the server's texts use them too)
	const MINUS = '−';
	const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const pad2 = (n) => String(n).padStart(2, '0');
	/** run ticks as m:ss.cc */
	function fmt(t) {
		if (t === null || t === undefined || !isFinite(t)) return '';
		const neg = t < 0; t = Math.round(Math.abs(t));
		const cc = t % 100, s = Math.floor(t / 100) % 60, m = Math.floor(t / 6000) % 60, h = Math.floor(t / 360000);
		return (neg ? MINUS : '') + (h ? `${h}:${pad2(m)}` : `${m}`) + `:${pad2(s)}.${pad2(cc)}`;
	}
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
	/** seconds as m:ss (h:mm:ss from an hour) */
	function mmss(sec) {
		const s = Math.max(0, Math.floor(+sec || 0)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
		return `${h ? `${h}:${pad2(m)}` : m}:${pad2(x)}`;
	}
	const count = (n) => (isFinite(n) ? Math.round(n).toLocaleString('en-US') : '');
	function rate(n) {
		if (!isFinite(n) || n <= 0) return '0';
		if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' G';
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' M';
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + ' k';
		return String(Math.round(n));
	}
	function clock(t) { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
	const ticksText = (n) => `${count(n)} tick${Math.abs(n) === 1 ? '' : 's'}`;
	/** an amount of run time: "0.81 s (81 ticks)" (1 tick = 0.01 s; the seconds first, as the game's timer counts) */
	const secTicks = (n) => `${(Math.abs(n) / 100).toFixed(2)} s (${ticksText(Math.abs(n))})`;

	const DICT = { FAMS, FAM, STAGES, STAGE, GPU_DOES, RECIPE, STAGES_ALL, STAGES_PHASE, SKIP_WHY, HY_PARTS, HY_STAGES, HY_ORDER, HY_STATES,
		classify, classifySlot, recipeOf, colorOf, fmt, dur, mmss, count, rate, clock, esc, ticksText, secTicks, MINUS };
	if (typeof module === 'object' && module && module.exports) module.exports = DICT;
	if (!root || !root.document) return;

	// ================================================================ the view (window.TL)
	const D = root.document;
	const UIx = () => (typeof root.UI === 'object' && root.UI ? root.UI : null);
	const store = {
		get(k, d) { const u = UIx(); if (u && u.store) return u.store.get(k, d); try { const v = root.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
		set(k, v) { const u = UIx(); if (u && u.store) return u.store.set(k, v); try { root.localStorage.setItem(k, String(v)); } catch (e) { /* not kept */ } },
	};
	const RANGES = [['session', 'Session'], ['15m', '15 min'], ['1h', '1 h'], ['6h', '6 h'], ['all', 'All']];
	const RANGE_KEY = 'eeat.ui.range';
	const num = (v) => Math.round(v * 10) / 10;
	const attrTip = (h) => (h ? ` data-tip="${esc(h)}"` : '');
	/** the numbers of a plain sentence in the numbers' face (escaped first) */
	const numSpan = (s) => esc(s).replace(/(−?\d[\d,]*(?:[.:]\d+)*(?:–\d[\d,]*)?)/g, '<span class="n">$1</span>');

	// ---------------------------------------------------------------- colours (a label's ink on a coloured block)
	const inkCache = new Map();
	function rgbOf(c) {
		let m = /^#([0-9a-f]{3})$/i.exec(c);
		if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
		m = /^#([0-9a-f]{6})/i.exec(c);
		if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
		m = /^rgba?\(([^)]+)\)/i.exec(c);
		if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
		return null;
	}
	const lum = (rgb) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
	/** the ink of a label on the family's colour as it is in `el`'s theme: white or near-black, whichever contrasts more */
	function inkOn(fam, el) {
		let c = '';
		try { c = getComputedStyle(el || D.documentElement).getPropertyValue(`--ph-${fam}`).trim(); } catch (e) { c = ''; }
		if (inkCache.has(c)) return inkCache.get(c);
		const rgb = rgbOf(c);
		let ink = '#ffffff';
		if (rgb) { const L = lum(rgb), dark = lum([11, 15, 23]); ink = (1.05 / (L + 0.05)) >= ((L + 0.05) / (dark + 0.05)) ? '#ffffff' : '#0b0f17'; }
		inkCache.set(c, ink);
		return ink;
	}

	// ---------------------------------------------------------------- the stylesheet (one <style>, the first time a view is drawn)
	const CSS = `
.tl { --tl-lab: 96px; min-width: 0; }
.tl .tl-h { margin-bottom: 10px; }
.tl-speed { font-size: 13px; color: var(--ink-2); white-space: nowrap; display: inline-flex; align-items: baseline; gap: 4px; }
.tl-speed b { font: 600 14px var(--f-num); font-variant-numeric: tabular-nums; color: var(--ink); }
.tl-speed.idle b { color: var(--muted); }
.tl-speed .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ahead); align-self: center; animation: ui-pulse 1.8s infinite; margin-right: 2px; }
.tl-speed.idle .dot { background: var(--muted); animation: none; }
.tl-now { font: 400 16px/24px var(--f-ui); color: var(--ink); max-width: 82ch; }
.tl-now .n, .tl-score .n, .tl-recipe .rk { font-family: var(--f-num); font-variant-numeric: tabular-nums; font-weight: 600; }
.tl-recipe { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.tl-recipe .rk { font-size: 14px; line-height: 24px; color: var(--ink); margin-right: 4px; white-space: nowrap; }
.tl-recipe .rk .rp { font: 500 12px var(--f-ui); color: var(--muted); margin-left: 4px; }
.tl-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: var(--r1); font: 600 12px/1 var(--f-ui);
	background: var(--raise); color: var(--ink-2); border: 1px solid transparent; white-space: nowrap; cursor: default; }
.tl-chip i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.tl-chip.now { background: var(--coin-wash); border-color: var(--coin-mark); color: var(--ink); }
.tl-chip.now::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--coin-mark); animation: ui-pulse 1.8s infinite; }
.tl-chip.skipped { background: transparent; border-color: var(--line); color: var(--muted); text-decoration: line-through; text-decoration-thickness: 1px; }
.tl-chip.next { background: transparent; border: 1px dashed var(--line-2); color: var(--muted); }
.tl-chip.skipped i, .tl-chip.next i { opacity: .5; }
.tl-fig { position: relative; display: flex; margin-top: 16px; }
.tl-lab { flex: none; width: var(--tl-lab); position: relative; }
.tl-lab > span { position: absolute; left: 0; right: 10px; font-size: 12px; line-height: 14px; color: var(--ink-2); white-space: nowrap; overflow: hidden;
	text-overflow: ellipsis; transform: translateY(-50%); }
.tl-lab > span.ax { color: var(--muted); font: 500 11px/14px var(--f-num); font-variant-numeric: tabular-nums; text-align: right; }
.tl-lab > span.ax.cur { color: var(--ink); font-weight: 600; }
.tl-plot { flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }
.tl-plot svg { display: block; overflow: visible; font-family: var(--f-ui); }
.tl svg .ln { fill: color-mix(in srgb, var(--line) 55%, transparent); }
.tl svg .bl { font: 600 11px var(--f-ui); pointer-events: none; }
.tl svg .ax { fill: var(--muted); font: 500 11px var(--f-num); font-variant-numeric: tabular-nums; }
.tl svg .gl { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
.tl svg .rl { stroke: var(--line-2); stroke-width: 1; shape-rendering: crispEdges; }
.tl svg .rt { fill: var(--muted); font: 600 11px var(--f-num); }
.tl svg .bestl { fill: none; stroke: var(--ink-2); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tl svg .bestl.later { stroke-dasharray: 4 4; pointer-events: stroke; }
.tl svg .drop { stroke-width: 3; stroke-linecap: butt; }
.tl svg .dot { stroke: var(--panel); stroke-width: 2; }
.tl svg .ph { stroke: var(--coin); stroke-width: 2; pointer-events: none; }
.tl svg .pht { fill: var(--coin); pointer-events: none; }
.tl svg .phl { fill: var(--coin-ink); font: 600 11px var(--f-num); pointer-events: none; }
.tl svg .oe { stroke: var(--coin); stroke-width: 2; pointer-events: none; }
.tl svg .xh { stroke: var(--ink-2); stroke-width: 1; pointer-events: none; shape-rendering: crispEdges; }
.tl svg .dm { stroke: var(--panel); stroke-width: 2; fill: var(--coin-mark); }
.tl svg .dm.ref { fill: var(--panel); stroke: var(--muted); stroke-width: 1.5; }
.tl svg .dm.alt { fill: var(--panel); stroke: var(--coin-mark); stroke-width: 1.5; }
.tl svg .hit { fill: transparent; }
.tl svg .rs { stroke: var(--behind); stroke-width: 1; stroke-dasharray: 3 3; }
.tl svg .rst { fill: var(--behind); font: 600 11px var(--f-ui); }
.tl svg .none { fill: var(--muted); font: 400 12px var(--f-ui); }
.tl svg [data-fam] { transition: opacity .15s; }
.tl-fig.hl svg [data-fam]:not(.on) { opacity: .3; }
.tl svg .tl-new { animation: tl-pop .6s ease-out; transform-box: fill-box; transform-origin: center; }
.tl svg .tl-ring { fill: none; stroke: var(--coin-mark); stroke-width: 2; animation: tl-ring .6s ease-out forwards; transform-box: fill-box; transform-origin: center; pointer-events: none; }
@keyframes tl-pop { from { transform: scale(0); } 60% { transform: scale(1.3); } to { transform: scale(1); } }
@keyframes tl-ring { from { transform: scale(.5); opacity: .95; } to { transform: scale(3); opacity: 0; } }
.tl-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; margin-top: 10px; }
.tl-legend button { height: 26px; padding: 0 8px; font: 500 12px var(--f-ui); background: transparent; border-color: transparent; color: var(--ink-2); gap: 6px; }
.tl-legend button:hover:not(:disabled) { background: var(--raise); border-color: transparent; color: var(--ink); }
.tl-legend button[aria-pressed="true"] { background: var(--raise); border-color: var(--line-2); color: var(--ink); }
.tl-legend .sw { width: 10px; height: 10px; border-radius: 2px; }
.tl-legend .dmk, .tl-legend .dmr { width: 8px; height: 8px; transform: rotate(45deg); flex: none; margin: 0 2px; }
.tl-legend .dmk { background: var(--coin-mark); }
.tl-legend .dmr { border: 1.5px solid var(--muted); }
.tl-legend .lgi { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); padding: 0 8px; height: 26px; }
.tl-note { margin-top: 6px; font-size: 12px; color: var(--muted); }
.tl-score { margin-top: 20px; }
.tl-score .sec-h { margin-bottom: 6px; }
.tl-score h3 { font: 600 15px/20px var(--f-num); }
.tl-score .tbl td.d { color: var(--ahead); }
.tl-score .tbl td.lb { white-space: nowrap; }
.tl-score .tw { overflow-x: auto; }
.tl-score .sm-only { display: none; font-size: 11.5px; line-height: 15px; color: var(--muted); font-weight: 400; }
.tl-guide { margin-top: 14px; }
.tl-guide .gfam { margin-top: 12px; }
.tl-guide .gfam > b { display: flex; align-items: center; gap: 8px; font: 600 13.5px/20px var(--f-num); color: var(--ink); }
.tl-guide .gfam > p { margin: 2px 0 0 18px; font-size: 13px; color: var(--ink-2); max-width: 78ch; }
.tl-guide ul { margin: 4px 0 0 18px; padding-left: 16px; font-size: 13px; color: var(--ink-2); max-width: 78ch; }
.tl-guide li { margin: 3px 0; } .tl-guide li b { color: var(--ink); font-weight: 600; }
.tl-empty { margin-top: 14px; padding: 22px 14px; border-radius: var(--r2); background: var(--raise); color: var(--ink-2); font-size: 13.5px; text-align: center; }
.tl-err { margin-top: 10px; }
.tl-compact { --tl-lab: 72px; }
.tl-compact .tl-now { font-size: 13px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.tl-compact .tl-fig { margin-top: 8px; }
.tl-compact .tl-lab > span { font-size: 11px; right: 6px; }
.tl-compact .tl-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
.tl-compact .tl-foot .legend { margin-top: 0; font-size: 11px; gap: 4px 10px; }
.tl-sheetv .tl-now { font-size: 14px; line-height: 21px; }
@media (max-width: 599px) {
	.tl-full { --tl-lab: 70px; }
	.tl-score .sm-hide { display: none; }
	.tl-score .sm-only { display: block; }
	.tl-full .tl-now { font-size: 15px; line-height: 22px; }
	.tl-full .tl-h .tools { width: 100%; justify-content: space-between; }
}
`;
	function ensureCss() {
		if (D.getElementById('tl-style')) return;
		const st = D.createElement('style');
		st.id = 'tl-style';
		st.textContent = CSS;
		(D.head || D.documentElement).appendChild(st);
	}

	// ---------------------------------------------------------------- the figure: the best time over a tape of the phases (one SVG)
	/** clock ticks for the axis: a step of 1, 2, 5, 10, 15, 30 min, 1, 2, 3, 6, 12 h or 1 day that leaves ~90 px between labels */
	function axisTicks(x0, x1, px) {
		const span = Math.max(1, x1 - x0);
		const steps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3];
		const want = span / Math.max(1, px / 92);
		const step = steps.find((s) => s >= want) || steps[steps.length - 1];
		const off = new Date(x0).getTimezoneOffset() * 60e3;   // (local clock boundaries)
		const out = [];
		for (let t = Math.ceil((x0 - off) / step) * step + off; t <= x1; t += step) out.push(t);
		return { ticks: out, step };
	}
	/** an axis label: the date for day steps, else the local clock (seconds only for steps under a minute) */
	function tickLabel(t, step) {
		try {
			if (step >= 86400e3) return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
			return new Date(t).toLocaleTimeString([], step < 60e3 ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
		} catch (e) { return ''; }
	}
	/** a block's tooltip */
	function spanTip(s, model) {
		const c = s.label || (STAGE[s.key] ? STAGE[s.key].label : s.name);
		const t1 = s.t1 || model.tNow;
		const bits = [];
		if (s.detail) bits.push(esc(s.detail));
		if (s.threads) bits.push(`${s.threads} thread${s.threads === 1 ? '' : 's'}`);
		bits.push(`${clock(s.t0)}${s.t1 ? `–${clock(s.t1)}` : ', running'} (${dur(t1 - s.t0)})`);
		if (s.n > 1) bits.push(`${s.n} runs merged`);
		if (s.saved > 0) bits.push(`<span class="up">${s.n > 1 ? 'they saved' : 'its window saved'} ${secTicks(s.saved)}</span>`);
		else if (s.saved === 0 && s.t1) bits.push('found nothing here');
		if (s.killed && s.t1) bits.push('stopped');
		const ex = s.explain || (STAGE[s.key] ? STAGE[s.key].explain : '');
		return `<b>${esc(c)}</b>${s.name && s.name !== c && s.n <= 1 ? ` <span class="muted">${esc(s.name)}</span>` : ''}` +
			`${ex ? `<div class="muted" style="margin-top:2px">${esc(ex)}</div>` : ''}<div style="margin-top:4px">${bits.join(' · ')}</div>`;
	}
	function markTip(m) {
		if (m.kind === 'refused') return `<b>Handed in, not accepted</b><div>${esc(m.what || '')}${m.runTicks ? `: ${fmt(m.runTicks)}` : ''}</div><div class="muted">${clock(m.t)}${m.why ? ` · ${esc(m.why)}` : ''}</div>`;
		if (m.kind === 'route') return `<b>${esc(m.label || 'route')}</b><div>${m.runTicks ? `<span class="tv">${fmt(m.runTicks)}</span>` : ''}${m.how ? ` · ${esc(m.how)}` : ''}</div><div class="muted">${m.at || clock(m.t)}${m.best ? '' : ' · not faster than the best then'}</div>`;
		return `<b>${esc(m.label || 'a find')}</b><div><span class="up">${MINUS}${secTicks(m.saved || 0)}</span> → <span class="tv">${fmt(m.runTicks)}</span></div>` +
			`<div class="muted">${m.at || clock(m.t)}${m.round ? ` · round ${m.round}` : ''}${m.what && m.what !== m.label ? ` · ${esc(m.what)}` : ''}</div>`;
	}
	/**
	 * The figure as {lab: html of the label column, svg: html, h, w, hover: (t) -> html}. model: the timeline model; o: {width
	 * (the plot's px), compact, sel (a family highlighted), newT (the newest best mark: its pop)}.
	 */
	function figure(model, o) {
		const compact = !!o.compact;
		const W = Math.max(120, Math.round(o.width));
		const chartH = compact ? 56 : 120, laneH = compact ? 14 : 22, gap = compact ? 3 : 4, axisH = compact ? 18 : 24;
		const lanes = (model.lanes || []).filter(Boolean);
		const tapeTop = chartH + (compact ? 6 : 10);
		const laneY = (i) => tapeTop + i * (laneH + gap);
		const tapeH = lanes.length ? lanes.length * (laneH + gap) - gap : 0;
		const axisY = tapeTop + tapeH + 6;
		const H = axisY + axisH - 6;
		const running = !!model.running;
		const tNow = model.tNow || Date.now();
		const x0 = model.t0;
		// (room past "now" while it runs: at least 30 s, more than the server's 20-s step, so the playhead moves until the next
		// model comes; and 6 px at both ends, so a find at the very start or end is a whole diamond)
		const pad = running ? Math.max(30000, (tNow - x0) * 0.025) : 0;
		const x1 = Math.max(x0 + 1000, tNow + pad);
		const IN = 6;
		const X = (t) => IN + (t - x0) / (x1 - x0) * (W - 2 * IN);
		const clampX = (x) => Math.max(0, Math.min(W, x));
		let s = '', lab = '';
		// the best time (the step line; every drop in the colour of the family that found it)
		const pts = (model.best || []).filter((p) => p && isFinite(p[1]));
		// (a stopped run's best found after the range ends, a run handed in later: the line ends with a dashed step to it, so the
		// lowest label is the best the run has now, as the big time above says)
		const later = Number.isFinite(model.bestNow) && pts.length && model.bestNow < pts[pts.length - 1][1] && !running ? model.bestNow : null;
		const vs = pts.map((p) => p[1]).concat(later !== null ? [later] : []);
		const yHi = vs.length ? Math.max(...vs) : 0, yLo = vs.length ? Math.min(...vs) : 0;
		const top = compact ? 6 : 10, bot = chartH - (compact ? 6 : 12);
		const Y = (v) => (yHi > yLo ? top + (yHi - v) / (yHi - yLo) * (bot - top) : (top + bot) / 2);
		s += `<line class="gl" x1="0" x2="${W}" y1="${num(bot) + 0.5}" y2="${num(bot) + 0.5}"/>`;
		if (pts.length) {
			let d = `M${num(clampX(X(pts[0][0])))},${num(Y(pts[0][1]))}`;
			for (let i = 1; i < pts.length; i++) d += `H${num(clampX(X(pts[i][0])))}V${num(Y(pts[i][1]))}`;
			d += `H${num(clampX(X(Math.min(tNow, x1))))}`;
			s += `<path class="bestl" d="${d}"/>`;
			if (later !== null) {
				const xl = clampX(X(Math.min(tNow, x1)));
				s += `<path class="bestl later" d="M${num(xl)},${num(Y(pts[pts.length - 1][1]))}V${num(Y(later))}H${W}"${attrTip(`<b>${fmt(later)}</b><div>the best now: found after this range (a run handed in later)</div>`)}/>`;
			}
			// (drops: a 3-px segment in the family colour and a dot; dots closer than 10 px are one, the newest)
			let lastDot = null;
			const dots = [];
			for (let i = 1; i < pts.length; i++) {
				const x = clampX(X(pts[i][0])), fam = pts[i][2] || 'combine';
				s += `<line class="drop" x1="${num(x)}" x2="${num(x)}" y1="${num(Y(pts[i - 1][1]))}" y2="${num(Y(pts[i][1]))}" style="stroke:${colorOf(fam)}" data-fam="${fam}"/>`;
				const y = Y(pts[i][1]);
				if (lastDot && Math.hypot(x - lastDot.x, y - lastDot.y) < 10) { lastDot.n++; lastDot.x = x; lastDot.y = y; lastDot.i = i; lastDot.fam = fam; }
				else { lastDot = { x, y, i, n: 1, fam }; dots.push(lastDot); }
			}
			for (const q of dots) {
				const p = pts[q.i];
				const tip = `<b>${fmt(p[1])}</b> <span class="muted">${clock(p[0])}</span>${p[3] ? `<div>${esc(p[3])}</div>` : ''}${q.n > 1 ? `<div class="muted">+ ${q.n - 1} more here</div>` : ''}`;
				s += `<circle class="dot" cx="${num(q.x)}" cy="${num(q.y)}" r="4" style="fill:${colorOf(q.fam)}" data-fam="${q.fam}"${attrTip(tip)}/>`;
			}
			if (pts.length === 1 || (o.rangeFinds === 0)) s += `<text class="none" x="${num(W / 2)}" y="${num(top + 14)}" text-anchor="middle">${compact ? 'no route yet' : 'No find in this range'}</text>`;
			// (the y axis in the label column: the range's highest best, the current best, one between)
			const ys = yHi > yLo ? [[yHi, false], [Math.round((yHi + yLo) / 2), false], [yLo, true]] : [[yHi, true]];
			for (const [v, cur] of ys) lab += `<span class="ax${cur ? ' cur' : ''}" style="top:${num(Y(v))}px">${fmt(v)}</span>`;
		} else {
			s += `<text class="none" x="${num(W / 2)}" y="${num((top + bot) / 2 + 4)}" text-anchor="middle">${compact ? 'no route yet' : 'No best time yet'}</text>`;
			lab += `<span class="ax" style="top:${num((top + bot) / 2)}px">${compact ? 'best' : 'best time'}</span>`;
		}
		// the tape: a row per lane, the blocks in their family colour, labels inside where they fit (and clear of the finds)
		const lanesIdx = new Map(lanes.map((l, i) => [l.id, i]));
		const SHORT = { fly: 'Corridor', in: 'Handed in' };
		lanes.forEach((l, i) => {
			s += `<rect class="ln" x="0" y="${laneY(i)}" width="${W}" height="${laneH}" rx="3"/>`;
			lab += `<span style="top:${num(laneY(i) + laneH / 2)}px" title="${esc(l.explain || l.label)}">${esc(o.narrow && SHORT[l.id] ? SHORT[l.id] : l.label)}</span>`;
		});
		const markX = new Map();   // lane -> the x of its finds (a label never covers one)
		for (const m of model.marks || []) { if (m.t < x0 || m.t > x1) continue; const a = markX.get(m.lane) || []; a.push(X(m.t)); markX.set(m.lane, a); }
		const open = [];
		for (const sp of model.spans || []) {
			const i = lanesIdx.get(sp.lane);
			if (i === undefined) continue;
			const l = lanes[i];
			let y = laneY(i), h = laneH;
			const rows = l.subs > 1;
			if (rows) { const rh = (laneH - (l.subs - 1) * 2) / l.subs; y += (sp.sub | 0) * (rh + 2); h = rh; }
			const a = clampX(X(sp.t0)), b = clampX(X(sp.t1 || tNow));
			if (b < 0 || a > W) continue;
			const w = Math.max(1.5, b - a - (b - a > 4 ? 2 : 0));
			const fam = sp.fam || 'combine';
			const isOpen = !sp.t1 && running;
			s += `<rect class="blk" x="${num(a)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${h >= 8 ? 3 : 1.5}" style="fill:${colorOf(fam)}" data-fam="${fam}"` +
				`${isOpen ? ` data-open="${sp.t0}" data-x0="${num(a)}"` : ''}${attrTip(spanTip(sp, model))}/>`;
			if (isOpen) open.push({ a, y, h });
			const text = sp.short || sp.label || '';
			const tw = text.length * 6.3;
			if (!compact && !rows && text && w > tw + 10 && !(markX.get(sp.lane) || []).some((mx) => mx >= a - 1 && mx <= a + 5 + tw + 7)) {
				s += `<text class="bl" x="${num(a + 5)}" y="${num(y + h / 2 + 4)}" style="fill:${inkOn(fam, o.el)}">${esc(text)}</text>`;
			}
		}
		// the open blocks' running edge (a 2 px gold line at "now")
		const xn = clampX(X(Math.min(tNow, x1)));
		if (running) for (const q of open) s += `<line class="oe" x1="${num(xn)}" x2="${num(xn)}" y1="${num(q.y)}" y2="${num(q.y + q.h)}" data-oe="1"/>`;
		// rounds: a hairline through the tape, "R3" just above it (clear of the axis' labels)
		let lastRx = -1e9;
		for (const r of model.rounds || []) {
			if (!r.t0 || r.t0 <= x0 || r.t0 >= x1) continue;
			const x = X(r.t0);
			s += `<line class="rl" x1="${num(x) + 0.5}" x2="${num(x) + 0.5}" y1="${tapeTop - (compact ? 4 : 13)}" y2="${axisY}"/>`;
			if (!compact && x - lastRx > 26) { s += `<text class="rt" x="${num(x + 3)}" y="${tapeTop - 3}">${esc(r.tag || `R${r.round}`)}</text>`; lastRx = x; }
		}
		// restarts (the hybrid): a dashed red line through everything
		for (const r of model.restarts || []) {
			if (!r.t || r.t <= x0 || r.t >= x1) continue;
			const x = X(r.t);
			// (its label on the side away from the playhead when they are close)
			const nearNow = running && Math.abs(x - X(Math.min(tNow, x1))) < 60;
			s += `<line class="rs" x1="${num(x)}" x2="${num(x)}" y1="0" y2="${axisY}"/><text class="rst" x="${num(nearNow ? x - 3 : x + 3)}" y="10"${nearNow ? ' text-anchor="end"' : ''}${attrTip(`<b>Restart ${r.n}</b><div>${esc(r.why || '')}</div>`)}>restart ${r.n}</text>`;
		}
		// the axis: clock times (the hybrid: the time since its start, as its panel counts it)
		if (lanes.length || pts.length) {
			const hy = model.kind === 'hybrid';
			let ticks, label;
			if (hy) {
				const steps = [5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3];
				const step = steps.find((x) => x >= (x1 - x0) / Math.max(1, W / 70)) || steps[steps.length - 1];
				ticks = [];
				for (let t = x0 + step; t < x1; t += step) ticks.push(t);
				label = (t) => mmss((t - x0) / 1000);
			} else { const at = axisTicks(x0, x1, W); ticks = at.ticks; label = (t) => tickLabel(t, at.step); }
			let lastX = -1e9, lastW = 0;
			for (const t of ticks) {
				const x = X(t), text = label(t), w = text.length * 6.2;
				if (x < w / 2 + 2 || x > W - w / 2 - 2 || x - lastX < (w + lastW) / 2 + 12) continue;
				if (running && !compact && Math.abs(x - xn) < w / 2 + 16) continue;   // (the playhead's "now" label there)
				s += `<line class="gl" x1="${num(x) + 0.5}" x2="${num(x) + 0.5}" y1="${axisY - 3}" y2="${axisY}"/><text class="ax" x="${num(x)}" y="${axisY + 12}" text-anchor="middle">${esc(text)}</text>`;
				lastX = x; lastW = w;
			}
		}
		// the finds: gold diamonds on their lane (refused hand-ins hollow); diamonds closer than 7 px on a lane are one
		const groups = new Map();
		for (const m of model.marks || []) {
			const i = lanesIdx.get(m.lane);
			if (i === undefined || m.t < x0 || m.t > x1) continue;
			const l = lanes[i];
			let cy = laneY(i) + laneH / 2;
			if (l.subs > 1) { const rh = (laneH - (l.subs - 1) * 2) / l.subs; cy = laneY(i) + (m.sub | 0) * (rh + 2) + rh / 2; }
			const cx = X(m.t), k = `${m.lane}|${m.sub | 0}`;
			const g = groups.get(k) || [];
			const last = g[g.length - 1];
			if (last && cx - last.cx < 7 && last.m.kind === m.kind) { last.n++; last.cx = cx; last.cy = cy; last.saved += m.saved || 0; if ((m.saved || 0) >= (last.m.saved || 0)) last.m = m; last.newest = Math.max(last.newest, m.t); }
			else g.push({ m, cx, cy, n: 1, saved: m.saved || 0, newest: m.t });
			groups.set(k, g);
		}
		const r = compact ? 4 : 5.5;
		for (const g of groups.values()) {
			for (const q of g) {
				const cls = q.m.kind === 'refused' ? 'dm ref' : q.m.kind === 'route' && !q.m.best ? 'dm alt' : 'dm';
				const isNew = o.newT && q.newest === o.newT && q.m.kind !== 'refused';
				const tip = markTip(q.m) + (q.n > 1 ? `<div class="muted">+ ${q.n - 1} more here${q.saved ? ` (${MINUS}${secTicks(q.saved)} in all)` : ''}</div>` : '');
				s += `<path class="${cls}${isNew ? ' tl-new' : ''}" d="M${num(q.cx)},${num(q.cy - r)}L${num(q.cx + r)},${num(q.cy)}L${num(q.cx)},${num(q.cy + r)}L${num(q.cx - r)},${num(q.cy)}Z" data-fam="${q.m.fam || 'combine'}"${attrTip(tip)}/>`;
				if (isNew) s += `<circle class="tl-ring" cx="${num(q.cx)}" cy="${num(q.cy)}" r="${r}"/>`;
			}
		}
		// the playhead ("now", while it runs)
		if (running) {
			s += `<line class="ph" data-ph="1" x1="${num(xn)}" x2="${num(xn)}" y1="0" y2="${axisY}"/>`;
			s += `<path class="pht" data-ph="1" d="M${num(xn - 4)},${axisY}L${num(xn + 4)},${axisY}L${num(xn)},${axisY + 6}Z"/>`;
			if (!compact) s += `<text class="phl" data-ph="1" x="${num(Math.min(W - 2, xn + 6))}" y="${axisY + 12}" text-anchor="${xn > W - 30 ? 'end' : 'start'}">now</text>`;
		}
		s += `<line class="xh" x1="0" x2="0" y1="0" y2="${axisY}" visibility="hidden"/>`;
		const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(model.now && model.now.text || 'the optimizer\'s timeline')}">` +
			`<rect class="hit" x="0" y="0" width="${W}" height="${axisY}"/>${s}</svg>`;
		/** the crosshair's tooltip at time t: the best then, and per lane what ran */
		const hover = (t) => {
			let b = null;
			for (const p of pts) { if (p[0] <= t) b = p; else break; }
			const rows = [];
			for (const l of lanes) {
				const here = (model.spans || []).filter((sp) => sp.lane === l.id && sp.t0 <= t && (sp.t1 || tNow) >= t);
				if (!here.length) continue;
				const sp = here[here.length - 1];
				rows.push(`<div class="tr"><i class="tk" style="background:${colorOf(sp.fam)}"></i><span>${esc(l.label)}: <b>${esc(sp.label)}</b>${sp.detail ? ` <span class="muted">${esc(sp.detail)}</span>` : ''}${here.length > 1 ? ` <span class="muted">+${here.length - 1}</span>` : ''}</span></div>`);
			}
			const when = model.kind === 'hybrid' ? `${mmss((t - x0) / 1000)} in` : clock(t);
			return `<div><b>${esc(when)}</b>${b ? ` · best <span class="tv">${fmt(b[1])}</span>` : ''}</div>${rows.join('')}`;
		};
		return { svg, lab, h: H, w: W, hover, X, x0, x1, axisY, inv: (px) => x0 + (px - IN) / (W - 2 * IN) * (x1 - x0) };
	}

	// ---------------------------------------------------------------- the parts around the figure
	function recipeHtml(model) {
		const rs = model.rounds || [];
		const r = rs[rs.length - 1];
		if (!r || !r.recipe || !r.recipe.length) return '';
		const paused = model.kind !== 'hybrid' && !model.running && !model.preview;
		const total = new Map(), seen = new Map();
		for (const c of r.recipe) total.set(c.label, (total.get(c.label) || 0) + 1);
		const chips = r.recipe.map((c) => {
			const st = c.state || 'next';
			const k = (seen.get(c.label) || 0) + 1;
			seen.set(c.label, k);
			const name = total.get(c.label) > 1 ? `${c.label} ${k}/${total.get(c.label)}` : c.label;
			const word = st === 'now' ? 'running now' : st === 'done' ? 'done' : st === 'skipped' ? `skipped${c.why ? `: ${c.why}` : ''}` : paused ? 'to come when it resumes' : 'to come';
			const pass = total.get(c.label) > 1 ? `<div class="muted">pass ${k} of ${total.get(c.label)} this round</div>` : '';
			const tip = `<b>${esc(c.label)}</b> <span class="muted">${esc(word)}</span>${c.explain ? `<div>${esc(c.explain)}</div>` : ''}${pass}${c.detail ? `<div class="muted">${esc(c.detail)}</div>` : ''}`;
			return `<span class="tl-chip ${st}"${attrTip(tip)}><i style="background:${colorOf(c.fam)}"></i>${esc(name)}</span>`;
		}).join('');
		const title = esc(r.title || `Round ${r.round}`) + (paused ? ' <span class="rp">paused here</span>' : '');
		return `<div class="tl-recipe" aria-label="the stages of this round"><span class="rk">${title}</span>${chips}</div>`;
	}
	/** the families (and marks) in the figure, as toggles */
	function legendHtml(model, o) {
		const fams = new Set();
		for (const sp of model.spans || []) fams.add(sp.fam);
		for (const m of model.marks || []) if (m.kind !== 'refused') fams.add(m.fam);
		for (const p of model.best || []) if (p[2]) fams.add(p[2]);
		if (model.kind === 'hybrid') {
			const parts = (model.lanes || []).map((l) => `<span class="lgi"><i class="sw" style="background:${colorOf(l.fam)}"></i>${esc(l.label)}</span>`).join('');
			return `<div class="tl-legend">${parts}<span class="lgi"><i class="dmk"></i>a route (gold: a new best)</span>${(model.restarts || []).length ? '<span class="lgi" style="color:var(--behind)">┆ a restart</span>' : ''}</div>`;
		}
		const items = FAMS.filter((f) => fams.has(f.fam)).map((f) => `<button type="button" data-lg="${f.fam}" aria-pressed="${o.sel === f.fam}" title="${esc(f.explain)} (click: highlight)"><i class="sw" style="background:${colorOf(f.fam)}"></i>${esc(f.label)}</button>`).join('');
		const refused = (model.marks || []).some((m) => m.kind === 'refused');
		return `<div class="tl-legend" aria-label="the phase families">${items}<span class="lgi"><i class="dmk"></i>a find</span>${refused ? '<span class="lgi"><i class="dmr"></i>handed in, not accepted</span>' : ''}</div>`;
	}
	/** what found time in the range: by family (default) or by stage */
	function scoreHtml(model, o) {
		let rows = (model.score || []).filter((x) => x.ms > 0 || x.finds > 0);
		const hy = model.kind === 'hybrid';
		if (!rows.length) return '';
		if (!o.every && !hy) {
			const by = new Map();
			for (const x of rows) {
				const k = x.fam;
				const g = by.get(k) || { key: k, fam: k, label: (FAM[k] || {}).label || k, explain: (FAM[k] || {}).explain || '', ms: 0, cpuMs: 0, gpuMs: 0, runs: 0, finds: 0, saved: 0 };
				g.ms += x.ms; g.cpuMs += x.cpuMs || 0; g.gpuMs += x.gpuMs || 0; g.runs += x.runs; g.finds += x.finds; g.saved += x.saved;
				by.set(k, g);
			}
			rows = [...by.values()];
		}
		rows.sort((p, q) => q.saved - p.saved || q.finds - p.finds || q.ms - p.ms);
		const mins = (ms) => (ms > 0 ? esc(dur(ms)) : '<span class="muted">—</span>');
		const body = rows.map((x) => {
			// (the rate: run time saved per hour of its machine time, the CPU's and the GPU's together)
			const perH = x.ms > 0 && x.saved > 0 ? (x.saved / 100) / (x.ms / 3600000) : 0;
			const saved = x.saved > 0 ? `${MINUS}${(x.saved / 100).toFixed(2)} s` : '0';
			const gpuLine = !hy && x.gpuMs > 0 ? `<span class="sm-only">GPU ${esc(dur(x.gpuMs))}</span>` : '';
			const time = hy ? `<td class="n">${mins(x.ms)}</td>` : `<td class="n">${mins(x.cpuMs !== undefined ? x.cpuMs : x.ms)}${gpuLine}</td><td class="n sm-hide">${mins(x.gpuMs || 0)}</td>`;
			return `<tr${attrTip(x.explain ? `<b>${esc(x.label)}</b><div>${esc(x.explain)}</div>` : '')}><td class="lb"><i class="sw" style="background:${colorOf(x.fam)}"></i>${esc(x.label)}</td>` +
				`${time}<td class="n sm-hide">${count(x.runs)}</td><td class="n">${count(x.finds)}</td>` +
				`<td class="n${x.saved > 0 ? ' d' : ''}" title="${x.saved > 0 ? esc(ticksText(x.saved)) : ''}">${saved}</td><td class="n sm-hide">${perH ? `${perH.toFixed(perH < 10 ? 2 : 1)} s` : '—'}</td></tr>`;
		}).join('');
		const title = hy ? 'What found routes' : `What found time (${o.rangeLabel ? `the last ${o.rangeLabel}` : 'this range'})`;
		const tools = hy ? '' : `<div class="tools"><button type="button" class="ghost small" data-every="1" aria-pressed="${!!o.every}">${o.every ? 'By family' : 'Show every stage'}</button></div>`;
		const th = hy ? `<th class="n" title="its own time in the run (the parts run side by side)">Running</th>`
			: `<th class="n" title="the CPU time of its runs, as its threads' share of the machine">CPU</th><th class="n sm-hide" title="the GPU's time on it (the GPU runs next to the CPU: the two columns are two machines, so their sum can be longer than the session)">GPU</th>`;
		return `<div class="tl-score"><div class="sec-h"><h3>${esc(title)}</h3>${tools}</div><div class="tw"><table class="tbl"><thead><tr>` +
			`<th>${hy ? 'Part' : 'Phase'}</th>${th}<th class="n sm-hide">Runs</th>` +
			`<th class="n">${hy ? 'Routes' : 'Finds'}</th><th class="n" title="${hy ? 'run time its routes took off the best route' : 'run time taken off the best run'}">Saved</th><th class="n sm-hide" title="run time saved per hour of its CPU and GPU time">Per hour</th></tr></thead>` +
			`<tbody>${body}</tbody></table></div></div>`;
	}
	function guideHtml(model, open) {
		if (model.kind === 'hybrid') {
			const items = Object.values(HY_PARTS).map((p) => `<div class="gfam"><b><i class="sw" style="background:${p.color}"></i>${esc(p.label)}</b><p>${esc(p.explain)}</p></div>`).join('');
			return `<details class="tl-guide"${open ? ' open' : ''}><summary>What the parts do</summary>${items}</details>`;
		}
		const keys = new Set();
		for (const sp of model.spans || []) keys.add(sp.key);
		for (const x of model.score || []) keys.add(x.key);
		const r = (model.rounds || [])[(model.rounds || []).length - 1];
		if (r && r.recipe) for (const c of r.recipe) keys.add(c.dict || RECIPE[c.key]);
		const used = STAGES.filter((s) => keys.has(s.key));
		const items = FAMS.map((f) => {
			const st = used.filter((s) => s.fam === f.fam);
			if (!st.length) return '';
			return `<div class="gfam"><b><i class="sw" style="background:${colorOf(f.fam)}"></i>${esc(f.label)}</b><p>${esc(f.explain)}</p>` +
				`<ul>${st.map((s) => `<li><b>${esc(s.label)}</b>: ${esc(s.explain)}</li>`).join('')}</ul></div>`;
		}).join('');
		return `<details class="tl-guide"${open ? ' open' : ''}><summary>What the phases do</summary>${items || '<p class="t-small">The phases appear here once the optimizer has run.</p>'}</details>`;
	}
	function speedHtml(sp) {
		if (!sp) return '';
		const cpu = +sp.cpu || 0, gpu = +sp.gpu || 0;
		const idle = !(cpu + gpu > 0);
		const tip = `${sp.threads ? `CPU: ${sp.threads} thread${sp.threads === 1 ? '' : 's'}` : 'CPU'}${sp.gpuName ? `; GPU: ${sp.gpuName}` : ''}${idle ? ' (between stages)' : ''}`;
		return `<span class="tl-speed${idle ? ' idle' : ''}" title="${esc(tip)}"><span class="dot"></span><b>${rate(cpu)}</b>${gpu > 0 || sp.gpuName ? ` + <b>${rate(gpu)}</b>` : ''} ticks/s</span>`;
	}
	const rangeLabelOf = (r) => ({ '15m': '15 min', '1h': 'hour', '6h': '6 hours' })[r] || '';

	/**
	 * The view as an HTML string: {html, fig} (fig: the figure's parts for the hover, or null). model: a timeline model (job or
	 * hybrid); o: {width (el's px), compact, sheet, range, sel, every, guide (open), newT, el, speed}.
	 */
	function html(model, o) {
		o = o || {};
		if (!model || typeof model !== 'object') return { html: '<div class="loading"><span class="spin"></span>Loading the optimizer\'s timeline…</div>', fig: null };
		const compact = !!o.compact, hy = model.kind === 'hybrid';
		const narrow = !!(o.width && o.width < 600);
		const labW = compact ? 72 : (narrow ? 70 : 96);
		const width = Math.max(compact ? 160 : 260, (o.width || (compact ? 300 : 900)));
		const plotW = Math.max(compact ? 120 : (narrow ? 180 : 544), width - labW);
		let h = '';
		if (!compact && !hy) {
			const seg = `<div class="seg" role="group" aria-label="time range">${RANGES.map(([k, l]) => `<button type="button" data-range="${k}" aria-pressed="${(o.range || 'session') === k}">${l}</button>`).join('')}</div>`;
			h += `<div class="sec-h tl-h"><h2>Optimizer</h2><div class="tools">${seg}<span data-speed="1">${speedHtml(o.speed || model.speed)}</span></div></div>`;
		}
		h += `<div class="tl-now" role="status">${numSpan(model.now && model.now.text ? model.now.text : '')}</div>`;
		if (!compact) h += recipeHtml(model);
		let fig = null;
		const hasTime = model.t0 && model.tNow && ((model.spans || []).length || (model.best || []).length > 0) && !model.preview;
		if (hasTime) {
			fig = figure(model, { width: plotW, compact, sel: o.sel, newT: o.newT, el: o.el, rangeFinds: model.rangeFinds, narrow });
			h += `<div class="tl-fig${o.sel ? ' hl' : ''}" style="--tl-lab:${labW}px"><div class="tl-lab" style="height:${fig.h}px">${fig.lab}</div><div class="tl-plot">${fig.svg}</div></div>`;
			if (model.legacy) h += `<div class="tl-note">Built from the log (times to the second). Restart the run for the full view.</div>`;
		} else if (!compact && model.preview) {
			h += `<div class="tl-empty">The stages above are this level's round. Once it runs, the phases show up here on a timeline, with the best time above them.</div>`;
		}
		if (compact) {
			const parts = (model.lanes || []).map((l) => ({ label: l.label, color: colorOf(l.fam) }));
			const lg = parts.length ? `<div class="legend">${parts.map((p) => `<span><i class="sw" style="background:${p.color}"></i>${esc(p.label)}</span>`).join('')}</div>` : '<span></span>';
			h += `<div class="tl-foot">${lg}${o.sheet ? '<button type="button" class="ghost small" data-sheet="1">Open the full view</button>' : ''}</div>`;
			return { html: h, fig };
		}
		if (hasTime) h += legendHtml(model, o);
		h += scoreHtml(model, { every: o.every, rangeLabel: rangeLabelOf(o.range) });
		h += guideHtml(model, o.guide);
		return { html: h, fig };
	}

	// ---------------------------------------------------------------- the live parts: hover, the playhead, the highlight
	/** the crosshair: the plot's hit area gets the tooltip of the time under the pointer (ui.js shows any data-tip) */
	function wireFigure(el, fig) {
		if (!fig) return;
		const svg = el.querySelector('.tl-plot svg');
		if (!svg) return;
		const hit = svg.querySelector('.hit'), xh = svg.querySelector('.xh');
		let lastKey = '';
		svg.addEventListener('pointermove', (e) => {
			const r = svg.getBoundingClientRect();
			const px = (e.clientX - r.left) * (fig.w / (r.width || fig.w));
			if (px < 0 || px > fig.w) return;
			if (xh) { xh.setAttribute('x1', num(px)); xh.setAttribute('x2', num(px)); xh.setAttribute('visibility', 'visible'); }
			const t = fig.inv(px), key = Math.round(px / 3);
			if (key !== lastKey && hit) { lastKey = key; hit.setAttribute('data-tip', fig.hover(t)); }
		});
		svg.addEventListener('pointerleave', () => { if (xh) xh.setAttribute('visibility', 'hidden'); });
	}
	/** every second while it runs: the playhead and the open blocks' right edges follow the clock (no fetch, no rebuild) */
	function advance(el, fig, running) {
		if (!fig || !running) return;
		const now = Date.now();
		if (now > fig.x1) return false;   // (past the room the figure left: the next fetch rebuilds it)
		const x = num(Math.max(0, Math.min(fig.w, fig.X(now))));
		for (const n of el.querySelectorAll('[data-ph]')) {
			if (n.tagName === 'line') { n.setAttribute('x1', x); n.setAttribute('x2', x); }
			else if (n.tagName === 'path') n.setAttribute('d', `M${x - 4},${fig.axisY}L${x + 4},${fig.axisY}L${x},${fig.axisY + 6}Z`);
			else if (n.tagName === 'text') n.setAttribute('x', Math.min(fig.w - 2, x + 6));
		}
		for (const n of el.querySelectorAll('[data-oe]')) { n.setAttribute('x1', x); n.setAttribute('x2', x); }
		for (const n of el.querySelectorAll('rect[data-open]')) { const a = +n.getAttribute('data-x0'); n.setAttribute('width', num(Math.max(1.5, x - a))); }
		return true;
	}
	function applyHighlight(el, fam) {
		const f = el.querySelector('.tl-fig');
		if (!f) return;
		f.classList.toggle('hl', !!fam);
		for (const n of f.querySelectorAll('[data-fam]')) n.classList.toggle('on', !!fam && n.getAttribute('data-fam') === fam);
		for (const b of el.querySelectorAll('.tl-legend [data-lg]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-lg') === fam));
	}

	// ---------------------------------------------------------------- a job's view (the Runs page): mount, update, unmount
	const views = new Map();   // el -> view
	const visible = () => !D.visibilityState || D.visibilityState === 'visible';
	function draw(v) {
		if (!v.model) return;
		const width = v.el.clientWidth || 900;
		v.width = width;
		const newest = (v.model.marks || []).filter((m) => m.kind !== 'refused').reduce((a, m) => Math.max(a, m.t), 0);
		const motion = !UIx() || !UIx().motion || UIx().motion();
		const newT = v.seen && newest > v.lastBestT && motion ? newest : 0;
		if (newest) v.lastBestT = Math.max(v.lastBestT || 0, newest);
		v.seen = true;
		const sp = v.summary && v.summary.live && v.summary.live.cpu ? liveSpeed(v.summary.live) : v.model.speed;
		const r = html(v.model, { width, range: v.range, sel: v.sel, every: v.every, guide: v.guide, newT, el: v.el, speed: sp });
		const plot = v.el.querySelector('.tl-plot'), sx = plot ? plot.scrollLeft : 0;
		v.el.innerHTML = r.html;
		v.fig = r.fig;
		const plot2 = v.el.querySelector('.tl-plot');
		if (plot2) plot2.scrollLeft = sx || (plot2.scrollWidth > plot2.clientWidth && v.model.running ? plot2.scrollWidth : 0);
		wireFigure(v.el, r.fig);
		if (v.sel) applyHighlight(v.el, v.sel);
		wire(v);
	}
	function wire(v) {
		for (const b of v.el.querySelectorAll('[data-range]')) b.onclick = () => { v.range = b.getAttribute('data-range'); store.set(RANGE_KEY, v.range); v.sig = ''; fetchNow(v); };
		for (const b of v.el.querySelectorAll('[data-lg]')) b.onclick = () => { const f = b.getAttribute('data-lg'); v.sel = v.sel === f ? '' : f; applyHighlight(v.el, v.sel); };
		const ev = v.el.querySelector('[data-every]');
		if (ev) ev.onclick = () => { v.every = !v.every; store.set('eeat.ui.everyStage', v.every ? '1' : '0'); draw(v); };
		const g = v.el.querySelector('.tl-guide');
		if (g) g.ontoggle = () => { v.guide = g.open; };
	}
	function liveSpeed(live) {
		if (!live || !live.cpu) return null;
		return { cpu: +live.cpu.ticksPerSec || 0, gpu: live.gpu ? +live.gpu.ticksPerSec || 0 : 0, threads: live.cpu.threads || null, gpuName: live.gpu ? live.gpu.name || null : null };
	}
	function schedule(v) {
		clearTimeout(v.timer);
		if (!v.alive) return;
		const running = !!(v.summary ? v.summary.running : v.model && v.model.running);
		if (running && visible()) v.timer = setTimeout(() => fetchNow(v), 3000);
	}
	async function fetchNow(v) {
		if (!v.alive) return;
		clearTimeout(v.timer);
		if (v.busy) { v.again = true; return; }
		v.busy = true;
		const job = v.job;
		try {
			const r = await fetch(`/api/jobs/${encodeURIComponent(job)}/phases?range=${encodeURIComponent(v.range)}${v.sig ? `&sig=${encodeURIComponent(v.sig)}` : ''}`, { cache: 'no-store' });
			if (!v.alive || v.job !== job) return;
			if (!r.ok) {
				let m = '';
				try { m = (await r.json()).error; } catch (e) { /* not JSON */ }
				if (!v.model) v.el.innerHTML = `<div class="sec-h tl-h"><h2>Optimizer</h2></div><div class="msg info tl-err">The optimizer's timeline is not available${m ? `: ${esc(m)}` : ''}.</div>`;
			} else {
				const m = await r.json();
				if (!v.alive || v.job !== job) return;
				if (!m.unchanged) { v.model = m; v.sig = m.sig || ''; draw(v); }
			}
		} catch (e) { /* the app is not answering: ui.js shows its banner; the next poll tries again */ }
		finally {
			v.busy = false;
			if (v.alive) { if (v.again) { v.again = false; fetchNow(v); } else schedule(v); }
		}
	}
	function mount(el, o) {
		if (!el) return;
		ensureCss();
		if (views.has(el)) unmount(el);
		o = o || {};
		const v = { el, job: o.job, summary: o.summary || null, range: store.get(RANGE_KEY, 'session'), sel: '', every: store.get('eeat.ui.everyStage', '0') === '1',
			guide: false, model: null, sig: '', timer: 0, tick: 0, alive: true, busy: false, again: false, seen: false, lastBestT: 0, width: 0, key: '' };
		if (!RANGES.some(([k]) => k === v.range)) v.range = 'session';
		v.key = keyOf(v.summary);
		views.set(el, v);
		el.classList.add('tl', 'tl-full');
		el.innerHTML = `<div class="sec-h tl-h"><h2>Optimizer</h2></div><div class="loading"><span class="spin"></span>Loading the optimizer's timeline…</div>`;
		fetchNow(v);
		v.tick = setInterval(() => {
			if (!v.alive || !v.model || !v.model.running || !visible()) return;
			// (past the room the figure left: the figure grows here, from the model it has; the server's model comes on the
			// 3-s schedule, which is the only thing that fetches)
			if (advance(v.el, v.fig, true) === false) { v.model.tNow = Date.now(); draw(v); }
		}, 1000);
		if (typeof ResizeObserver === 'function') {
			let t = 0;
			v.ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (v.alive && v.model && Math.abs((v.el.clientWidth || 0) - v.width) > 4) draw(v); }, 150); });
			v.ro.observe(el);
		}
		v.onVis = () => { if (visible() && v.alive) fetchNow(v); };
		D.addEventListener('visibilitychange', v.onVis);
	}
	/** what in a summary means "fetch again": the state, the stage, the round, the best */
	const keyOf = (s) => (s ? [s.running, s.state, s.stage, s.round, s.bestVersion, (s.history || []).length].join('|') : '');
	function update(summary) {
		if (!summary) return;
		for (const v of views.values()) {
			if (v.job !== summary.id) continue;
			v.summary = summary;
			const sp = v.el.querySelector('[data-speed]');
			if (sp) sp.innerHTML = speedHtml(liveSpeed(summary.live) || (summary.running ? null : null));
			const k = keyOf(summary);
			if (k !== v.key) { v.key = k; fetchNow(v); }
			else if (summary.running && !v.timer && !v.busy) schedule(v);
		}
	}
	function unmount(el) {
		const v = views.get(el);
		if (!v) return;
		v.alive = false;
		clearTimeout(v.timer);
		clearInterval(v.tick);
		if (v.ro) v.ro.disconnect();
		D.removeEventListener('visibilitychange', v.onVis);
		views.delete(el);
	}
	/** an Improvements row -> {label, color, round}: the timeline's classification (with the round) when it is loaded, else the
	 *  dictionary's from its `what` */
	function classifyEntry(entry, job) {
		if (!entry) return null;
		for (const v of views.values()) {
			if (v.job !== job || !v.model || !v.model.history) continue;
			if (!v.hmap || v.hmapOf !== v.model) {
				v.hmap = new Map();
				for (const x of v.model.history) v.hmap.set(`${x.t}|${x.runTicks}`, x);
				v.hmapOf = v.model;
			}
			const x = v.hmap.get(`${entry.t}|${entry.runTicks}`);
			if (x) return { label: x.label, color: colorOf(x.fam), round: x.round || null };
		}
		const c = classify(entry.what);
		return { label: c.label, color: colorOf(c.fam), round: null };
	}

	// ---------------------------------------------------------------- the hybrid's view (the editor): rendered from each poll
	const rendered = new Map();   // el -> {html, model}
	function render(el, model, o) {
		if (!el) return;
		ensureCss();
		o = o || {};
		const compact = !!o.compact;
		el.classList.add('tl');
		el.classList.toggle('tl-compact', compact);
		el.classList.toggle('tl-sheetv', !compact);
		const prev = rendered.get(el) || {};
		const newest = (model && model.marks || []).filter((m) => m.best).reduce((a, m) => Math.max(a, m.t), 0);
		const motion = !UIx() || !UIx().motion || UIx().motion();
		const newT = prev.seen && newest > (prev.lastBestT || 0) && motion ? newest : 0;
		const cs = root.getComputedStyle ? root.getComputedStyle(el) : null;
		const inner = (el.clientWidth || 0) - (cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0);
		const width = inner > 0 ? inner : (compact ? 300 : 900);
		const r = html(model, { width, compact, sheet: o.sheet, newT, el, guide: prev.guide, every: false });
		const state = { html: r.html, seen: true, lastBestT: Math.max(prev.lastBestT || 0, newest), guide: prev.guide, model, o, width: inner, ro: prev.ro };
		rendered.set(el, state);
		// (drawn while hidden, or its box changed: drawn again at its size)
		if (!state.ro && typeof ResizeObserver === 'function') {
			let t = 0;
			state.ro = new ResizeObserver(() => {
				clearTimeout(t);
				t = setTimeout(() => {
					const st = rendered.get(el);
					if (!st || !st.model) return;
					const c2 = root.getComputedStyle ? root.getComputedStyle(el) : null;
					const w2 = (el.clientWidth || 0) - (c2 ? (parseFloat(c2.paddingLeft) || 0) + (parseFloat(c2.paddingRight) || 0) : 0);
					if (w2 > 0 && Math.abs(w2 - (st.width || 0)) > 4) { st.html = ''; render(el, st.model, st.o); }
				}, 120);
			});
			state.ro.observe(el);
		}
		if (prev.html === r.html && el.firstChild) return;   // (cleared by the page meanwhile: drawn again)
		el.innerHTML = r.html;
		wireFigure(el, r.fig);
		const pl = el.querySelector('.tl-plot');
		if (pl && pl.scrollWidth > pl.clientWidth) pl.scrollLeft = pl.scrollWidth;
		const b = el.querySelector('[data-sheet]');
		if (b) b.onclick = () => { if (typeof root.hySheetOpen === 'function') root.hySheetOpen(); };
		const g = el.querySelector('.tl-guide');
		if (g) g.ontoggle = () => { state.guide = g.open; };
	}

	/** draw a view again from what it has (the theme changed: the blocks' label ink); no fetch */
	function redraw(el) {
		inkCache.clear();
		const v = views.get(el);
		if (v && v.model) { draw(v); return true; }
		const st = rendered.get(el);
		if (st && st.model) { st.html = ''; render(el, st.model, st.o); return true; }
		return false;
	}
	root.TL = { mount, update, unmount, classify: classifyEntry, render, redraw, html, dict: DICT };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
