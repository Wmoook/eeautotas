'use strict';
// src/stats.js: the data of the Stats page (docs/ui/DESIGN.md sections 10, 11.5 and 11.6), for src/server.js
// (GET /api/stats, GET /api/stats/benchmarks[/<id>]) and tools/stats-import.js.
//
// - jobsStats(summaries, {now}): /api/stats from the job summaries (src/jobs.js summary(): the history, the original and
//   the best) and each job's files: the optimizer's time (the sessions of grind_events.jsonl, else of grind.log's
//   "start:" lines: approximate), the simulated ticks (the events' stageEnd / slotEnd ticks), every improvement by the
//   phase family that found it (src/phases.js classify when it is there, else this file's copy of its dictionary).
// - benchmarks: an imported results table (the hybrid CSV format: tools/stats-import.js) kept as
//   <DATA>/benchmarks/<id>.json (src/data/benchmarks/ in the repo: never in git), its numbers (benchNumbers) and the jobs
//   of the app that are runs of its levels (matchJobs).
// Read-only on the jobs: nothing here writes into src/jobs.
const fs = require('fs');
const path = require('path');
const C = require('./common.js');

const BENCH_DIR = path.join(C.DATA, 'benchmarks');
const ID_RE = /^[a-z0-9-]{1,64}$/;
const LOG_MAX = 8 << 20;   // the end of grind.log read for the sessions before the events (bytes)

// ---------------------------------------------------------------- the phase dictionary (DESIGN.md 11.2)
// The families and the stages' rules of src/phases.js (the Optimizer view's builder owns that file); this copy classifies
// the history when src/phases.js is not there (or answers nothing sensible), so the Stats page never depends on it.
const FAMS = {
	tweak: { label: 'Input tweaks', color: 'var(--ph-tweak)', explain: 'Changing one or two inputs, or random variations of the run, and keeping changes that meet the run again sooner.' },
	explore: { label: 'Route explore', color: 'var(--ph-explore)', explain: 'Trying every move in a window of the run.' },
	path: { label: 'Path changes', color: 'var(--ph-path)', explain: 'Taking another way from somewhere along the run.' },
	local: { label: 'Local search', color: 'var(--ph-local)', explain: 'Small searches along the run: shortcuts, beams, the corridor beam.' },
	finish: { label: 'Finish & timing', color: 'var(--ph-finish)', explain: 'The exact ending and the timing of time doors and the start.' },
	combine: { label: 'Combine', color: 'var(--ph-combine)', explain: 'Joining the best run with other runs\' faster stretches.' },
	outside: { label: 'Handed in', color: 'var(--ph-outside)', explain: 'Runs handed in from outside the optimizer: Find a route, you, a rented machine.' },
};
const FAM_ORDER = Object.keys(FAMS);
// first match wins; a history entry's `what` (the grind's stage names, "inbox (...)", "try: ...")
const RULES = [
	{ key: 'mut', re: /^mutate_/, label: 'Input tweaks', fam: 'tweak', explain: 'Changes one or two inputs at every tick and keeps every change that rejoins the run sooner.' },
	{ key: 'skipf', re: /^skipfind/, label: 'Skip finder', fam: 'path', explain: 'From states all along the run, searches for a later point it can reach sooner another way.' },
	{ key: 'endgame', re: /^endgame/, label: 'Exact finish', fam: 'finish', explain: 'Tries every input over the run\'s last ticks; when nothing is faster, the ending is proven.' },
	// "sweep3_4" and its find as the history writes it ("sweep3_4 (coin-blind, replayed) + best (splice, ...)"), not
	// the window's phase pass "sweep3_4p"
	{ key: 'sweep', re: /^sweep\d+(_\d+)?(?![\w])/, label: 'Route sweep', fam: 'explore', explain: 'Tries every move in 8-second windows across the whole run, up to 4 windows at once.' },
	{ key: 'loop', re: /^deep\d+_loop/, label: 'Loop cutter', fam: 'explore', explain: 'Looks for a way around a stretch where the run comes back to where it was.' },
	{ key: 'seg', re: /^deep\d+_seg/, label: 'Coin-to-coin explore', fam: 'explore', explain: 'Tries every move between coins, one window after another.' },
	{ key: 'skips', re: /^skips\d/, label: 'Skip search', fam: 'path', explain: 'Finds spots the run passes early and only uses later, and tries every move from there.' },
	{ key: 'flyb', re: /^flybeam/, label: 'Corridor beam', fam: 'local', explain: 'Follows long flying, falling or sliding stretches with thousands of variations at once.' },
	{ key: 'sc', re: /^shortcuts/, label: 'Local shortcuts', fam: 'local', explain: 'Searches many small shortcuts from a cursor that moves along the run.' },
	{ key: 'phase', re: /^phaseb?\d/, label: 'Time doors', fam: 'finish', explain: 'Shifts the run so time and coin doors open sooner, with free idle ticks before the first input.' },
	{ key: 'beam', re: /^beam\d/, label: 'Beam search', fam: 'local', explain: 'Plays thousands of runs side by side and keeps the ones furthest ahead.' },
	{ key: 'splice', re: /^splice$| \+ best \(splice|^\d+ earlier runs/, label: 'Combine', fam: 'combine', explain: 'Joins the best run with every other run\'s faster stretches where they reach the same state.' },
	{ key: 'gpu', re: /^inbox \(gpu |^try: gpu/i, label: 'GPU search', fam: 'tweak', explain: 'The GPU searcher\'s find, checked by the optimizer.' },
	{ key: 'focus', re: /^(inbox \(|try: )focus/i, label: 'Search harder', fam: 'explore', explain: 'Your "Search harder" range, searched next to the optimizer.' },
	{ key: 'fr', re: /^(inbox \(|try: )Find a route/i, label: 'Find a route', fam: 'outside', explain: 'A route from Find a route, handed to the optimizer.' },
	{ key: 'remote', re: /^try: .*farm/i, label: 'Rented machine', fam: 'outside', explain: 'A faster run from the copy on a rented machine.' },
	{ key: 'in', re: /^inbox \(|^try: /, label: 'Handed in', fam: 'outside', explain: 'A run handed in from outside (a script, tas.js try).' },
];
// the GPU searcher's families (gpu/events.jsonl `find` fams) -> the phase family
const GPU_FAM = { m1: 'tweak', del: 'tweak', m2: 'tweak', pert: 'tweak', flip: 'tweak', sticky: 'tweak', every: 'explore', idle: 'finish' };

let PH;   // src/phases.js (the Optimizer view's data), when it is there
function phases() {
	if (PH === undefined) { try { PH = require('./phases.js'); if (!PH || typeof PH.classify !== 'function') PH = null; } catch (e) { PH = null; } }
	return PH;
}
/** the family of a GPU find: the largest saving of the `find` event within 5 s before t (gpu/events.jsonl), else null */
function gpuFamAt(finds, t) {
	if (!finds || !finds.length || !Number.isFinite(t)) return null;
	let best = null;
	for (let i = finds.length - 1; i >= 0; i--) {
		const f = finds[i];
		if (f.t > t + 1000) continue;
		if (f.t < t - 5000) break;
		let top = null, topV = 0;
		for (const [k, v] of Object.entries(f.fams || {})) if (Math.abs(+v || 0) > topV) { topV = Math.abs(+v || 0); top = k; }
		if (top && GPU_FAM[top]) { best = GPU_FAM[top]; break; }
	}
	return best;
}
/** a history entry's `what` (or a span's name) -> {key, fam, label, explain}; ctx: {t, gpuFinds} */
function classify(what, ctx) {
	const s = String(what === undefined || what === null ? '' : what);
	const ph = phases();
	if (ph) {
		try {
			const r = ph.classify(s, ctx || {});
			if (r && FAMS[r.fam]) return { key: r.key || 'other', fam: r.fam, label: r.label || s, explain: r.explain || '' };
		} catch (e) { /* this file's copy */ }
	}
	for (const r of RULES) {
		if (!r.re.test(s)) continue;
		let fam = r.fam;
		if (r.key === 'gpu') fam = gpuFamAt(ctx && ctx.gpuFinds, ctx && ctx.t) || fam;
		return { key: r.key, fam, label: r.label, explain: r.explain };
	}
	return { key: 'other', fam: 'combine', label: s || 'other', explain: '' };
}

// ---------------------------------------------------------------- a job's optimizer time and simulated ticks
const fileSig = (f) => { try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch (e) { return '-'; } };
function readTail(f, max) {
	try {
		const st = fs.statSync(f);
		if (st.size <= max) return fs.readFileSync(f, 'utf8');
		const fd = fs.openSync(f, 'r');
		try {
			const b = Buffer.alloc(max);
			fs.readSync(fd, b, 0, max, st.size - max);
			const s = b.toString('utf8');
			return s.slice(s.indexOf('\n') + 1);   // from the first whole line
		} finally { fs.closeSync(fd); }
	} catch (e) { return ''; }
}
function jsonLines(text) {
	const out = [];
	for (const ln of text.split('\n')) {
		if (!ln || ln.charCodeAt(0) !== 123) continue;
		try { const o = JSON.parse(ln); if (o && typeof o === 'object') out.push(o); } catch (e) { /* a partial last line */ }
	}
	return out;
}
/** grind_events.jsonl (and its rotated .1.jsonl): {sessions: [{t0, t1}], simTicks, hasEvents} */
function grindEvents(dir) {
	const evs = [];
	for (const f of ['grind_events.1.jsonl', 'grind_events.jsonl']) evs.push(...jsonLines(readTail(path.join(dir, f), 64 << 20)));
	const sessions = [];
	let cur = null, sim = 0;
	for (const e of evs) {
		const t = +e.t;
		if (e.ev === 'session') { cur = { t0: t, t1: t }; sessions.push(cur); continue; }
		if (cur && Number.isFinite(t) && t > cur.t1) cur.t1 = t;
		if (e.ev === 'stageEnd' && Number.isFinite(+e.ticks)) sim += +e.ticks;
	}
	return { sessions, simTicks: sim, hasEvents: evs.length > 0 };
}
/** gpu/events.jsonl: {simTicks, finds: [{t, fams, saved}] (by t), hasEvents} */
function gpuEvents(dir) {
	const evs = [];
	for (const f of ['events.1.jsonl', 'events.jsonl']) evs.push(...jsonLines(readTail(path.join(dir, 'gpu', f), 64 << 20)));
	let sim = 0;
	const finds = [];
	for (const e of evs) {
		if (e.ev === 'slotEnd' && Number.isFinite(+e.ticks)) sim += +e.ticks;
		else if (e.ev === 'find' && Number.isFinite(+e.t)) finds.push({ t: +e.t, fams: e.fams || {}, saved: +e.saved || 0 });
	}
	finds.sort((a, b) => a.t - b.t);
	return { simTicks: sim, finds, hasEvents: evs.length > 0 };
}
/** the sessions of grind.log: one per "start:" line, its length = the clock time from it to the session's last [grind] /
 *  [gpu] line (the lines hold the time of day only: each step forward modulo a day) -> [ms, ...] in the file's order */
function logSessions(dir) {
	const text = readTail(path.join(dir, 'grind.log'), LOG_MAX);
	const out = [];
	let last = -1, ms = 0, open = false;
	for (const ln of text.split('\n')) {
		const m = /^\[(grind|gpu) (\d\d):(\d\d):(\d\d)\] ?(.*)$/.exec(ln);
		if (!m) continue;
		const sec = (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
		if (m[1] === 'grind' && /^start:/.test(m[5])) {
			if (open) out.push(ms);
			open = true; ms = 0; last = sec;
			continue;
		}
		if (!open) continue;
		ms += (((sec - last) % 86400) + 86400) % 86400 * 1000;
		last = sec;
	}
	if (open) out.push(ms);
	return out;
}
const timeMemo = new Map();   // job id -> {sig, v}
/** a job's optimizer time {ms, approx}, simulated ticks (null without events) and GPU finds, cached by its files */
function jobTime(id) {
	const dir = path.join(C.JOBS, id);
	const files = ['grind_events.jsonl', 'grind_events.1.jsonl', 'grind.log', 'gpu/events.jsonl', 'gpu/events.1.jsonl'];
	const sig = files.map((f) => fileSig(path.join(dir, f))).join('|');
	const m = timeMemo.get(id);
	if (m && m.sig === sig) return m.v;
	const ge = grindEvents(dir), gp = gpuEvents(dir), log = logSessions(dir);
	let ms = 0;
	for (const s of ge.sessions) ms += Math.max(0, s.t1 - s.t0);
	// the log's sessions before the events: each grind since the events began wrote both a "start:" line and a session event
	const before = log.slice(0, Math.max(0, log.length - ge.sessions.length));
	for (const x of before) ms += x;
	const v = { ms, approx: before.length > 0, simTicks: ge.hasEvents || gp.hasEvents ? ge.simTicks + gp.simTicks : null, finds: gp.finds, sessions: ge.sessions.length + before.length };
	timeMemo.set(id, { sig, v });
	if (timeMemo.size > 4000) timeMemo.delete(timeMemo.keys().next().value);
	return v;
}

// ---------------------------------------------------------------- GET /api/stats (DESIGN.md 11.5)
/** a step series downsampled to at most n points (the first and the last kept) */
function downsample(pts, n) {
	if (pts.length <= n) return pts;
	const out = [];
	for (let k = 0; k < n; k++) out.push(pts[Math.round(k * (pts.length - 1) / (n - 1))]);
	return out;
}
const campaignText = (c) => (c ? `${c.title || `Campaign ${c.campaign}`}${c.tier ? `, level ${c.tier}${c.tiers ? ` of ${c.tiers}` : ''}` : ''}` : null);
/** /api/stats: summaries = src/jobs.js summary() of every job (the server's listJobs()) */
function jobsStats(summaries, opts) {
	const o = opts || {};
	const now = o.now || Date.now();
	const day = new Date(now); day.setHours(0, 0, 0, 0);
	const midnight = day.getTime();
	const totals = { runs: 0, running: 0, savedTicks: 0, originalTicks: 0, improvements: 0, today: 0, optimizedMs: 0, optimizedApprox: false, simTicks: null, since: null };
	const byFam = {};
	const byStage = new Map();   // "<key>|<fam>" -> {key, label, fam, finds, saved}
	const recent = [];
	const jobs = [];
	for (const s of summaries || []) {
		if (!s || !s.id) continue;
		const orig = (s.original && s.original.runTicks) || 0;
		const best = (s.best && s.best.runTicks) || orig;
		const hist = Array.isArray(s.history) ? s.history : [];
		const tm = o.time ? o.time(s.id) : jobTime(s.id);
		totals.runs++;
		if (s.running) totals.running++;
		totals.savedTicks += Math.max(0, orig - best);
		totals.originalTicks += orig;
		totals.improvements += hist.length;
		totals.optimizedMs += tm.ms;
		if (tm.approx) totals.optimizedApprox = true;
		if (tm.simTicks !== null) totals.simTicks = (totals.simTicks || 0) + tm.simTicks;
		if (Number.isFinite(s.created) && (totals.since === null || s.created < totals.since)) totals.since = s.created;
		let prev = orig, firstT = null, lastT = null;
		const pts = [[Number.isFinite(s.created) ? s.created : (hist.length ? hist[0].t : now), orig]];
		for (const h of hist) {
			const t = +h.t, rt = +h.runTicks;
			const saved = Number.isFinite(+h.saved) ? +h.saved : (Number.isFinite(rt) ? prev - rt : 0);
			if (Number.isFinite(rt)) prev = rt;
			if (Number.isFinite(t)) {
				if (firstT === null || t < firstT) firstT = t;
				if (lastT === null || t > lastT) lastT = t;
				if (t >= midnight) totals.today++;
				if (Number.isFinite(rt)) pts.push([t, rt]);
			}
			const c = classify(h.what, { t, gpuFinds: tm.finds, job: s.id });
			const f = byFam[c.fam] || (byFam[c.fam] = { saved: 0, finds: 0, stages: {} });
			f.saved += Math.max(0, saved);
			f.finds++;
			const sl = c.key === 'other' ? 'Other' : c.label;
			const g = f.stages[sl] || (f.stages[sl] = { finds: 0, saved: 0 });
			g.finds++;
			g.saved += Math.max(0, saved);
			const sk = `${c.key === 'other' ? 'other' : c.key}|${c.fam}`;
			const b = byStage.get(sk) || byStage.set(sk, { key: c.key, label: sl, fam: c.fam, finds: 0, saved: 0 }).get(sk);
			b.finds++;
			b.saved += Math.max(0, saved);
			recent.push({ t, job: s.id, name: s.name || s.id, runTicks: rt, time: Number.isFinite(rt) ? C.fmt(rt) : '', saved, what: String(h.what || ''), key: c.key, fam: c.fam, label: c.label });
		}
		jobs.push({
			id: s.id, name: s.name || s.id, section: s.campaign ? 'campaign' : 'other', campaign: campaignText(s.campaign),
			created: Number.isFinite(s.created) ? s.created : null, running: !!s.running, state: s.state || null,
			original: { runTicks: orig, time: C.fmt(orig) }, best: { runTicks: best, time: C.fmt(best) },
			savedTicks: orig - best, pct: orig ? Math.round((orig - best) / orig * 10000) / 100 : 0, improvements: hist.length,
			firstT, lastT, optimizedMs: tm.ms, approx: tm.approx, sessions: tm.sessions, spark: downsample(pts, 48),
		});
	}
	recent.sort((a, b) => (b.t || 0) - (a.t || 0));
	const stages = [...byStage.values()].sort((a, b) => b.saved - a.saved || b.finds - a.finds);
	return { t: now, totals, byFam, byStage: stages, fams: FAMS, famOrder: FAM_ORDER, recent: recent.slice(0, 20), jobs };
}

// ---------------------------------------------------------------- the CSV (RFC 4180)
/** text -> rows of cells: a BOM stripped, \r\n or \n, quoted cells with doubled quotes and line breaks inside */
function parseCsv(text) {
	let s = String(text || '');
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	const rows = [];
	let row = [], cell = '', q = false, i = 0;
	const n = s.length;
	while (i < n) {
		const ch = s[i];
		if (q) {
			if (ch === '"') {
				if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
				q = false; i++; continue;
			}
			cell += ch; i++; continue;
		}
		if (ch === '"' && cell === '') { q = true; i++; continue; }
		if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
		if (ch === '\r' || ch === '\n') {
			row.push(cell); rows.push(row); row = []; cell = '';
			i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
			continue;
		}
		cell += ch; i++;
	}
	if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
	return rows;
}

// ---------------------------------------------------------------- the benchmark import (DESIGN.md 11.6)
// the columns by their titles (case-insensitive substrings; the first title that matches, in this order of tries)
const COLS = [
	['section', [(t) => t === 'section', (t) => t.includes('section')]],
	['level', [(t) => t === 'level', (t) => /\blevel\b/.test(t) && !t.includes('result')]],
	['result', [(t) => t.includes('hybrid result'), (t) => t === 'result', (t) => t.includes('result')]],
	['solveS', [(t) => t.includes('time to solve (s)'), (t) => t.includes('solve') && t.includes('(s)')]],
	['solveText', [(t) => t.includes('time to solve')]],
	['by', [(t) => t.includes('first route came from'), (t) => t.includes('first route')]],
	['best', [(t) => t.includes('best route time'), (t) => t.includes('best route')]],
	['run', [(t) => t.includes('which hybrid run'), (t) => t.includes('which run')]],
	['known', [(t) => t.includes('best known')]],
	['searchAlone', [(t) => t.includes('search alone')]],
	['compilerAlone', [(t) => t.includes('compiler alone')]],
	['merged', [(t) => t.includes('identical copies')]],
];
function mapColumns(header) {
	const titles = header.map((h) => String(h || '').trim());
	const low = titles.map((t) => t.toLowerCase());
	const taken = new Set();
	const idx = {};
	for (const [key, tries] of COLS) {
		for (const f of tries) {
			const k = low.findIndex((t, j) => !taken.has(j) && t && f(t));
			if (k >= 0) { idx[key] = k; taken.add(k); break; }
		}
	}
	return { idx, titles, taken };
}
/** "0:19.63", "1:02:03.45", "19.63" -> run ticks; null when it is not a time */
function timeTicks(v) {
	const s = String(v || '').trim();
	let m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d{1,2})?)$/.exec(s);
	if (m) return (+m[1]) * 360000 + (+m[2]) * 6000 + Math.round(parseFloat(m[3]) * 100);
	m = /^(\d+):(\d{1,2}(?:\.\d{1,2})?)$/.exec(s);
	if (m) return (+m[1]) * 6000 + Math.round(parseFloat(m[2]) * 100);
	m = /^(\d+(?:\.\d{1,2})?)\s*s?$/.exec(s);
	if (m && s.includes('.')) return Math.round(parseFloat(m[1]) * 100);
	return null;
}
const timeOf = (v) => { const t = timeTicks(v); return t === null ? null : { time: C.fmt(t), runTicks: t }; };
/** "4m 01s", "1h 02m 03s", "241" -> seconds; null */
function durSeconds(v) {
	const s = String(v || '').trim().toLowerCase();
	if (!s) return null;
	if (/^\d+(\.\d+)?$/.test(s)) return +s;
	const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(s);
	if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
	return null;
}
function resultOf(v) {
	const s = String(v || '').trim().toLowerCase();
	if (/^routed/.test(s)) return /not confirmed|unconfirmed/.test(s) ? 'unconfirmed' : 'routed';
	if (/^(confirmed|yes|ok|solved)/.test(s)) return 'routed';
	return 'none';
}
const BY = { compiler: 'compiler', search: 'search', optimizer: 'optimizer', prefix: 'prefix', 'prefix search': 'prefix' };
function byOf(v) {
	const s = String(v || '').trim().toLowerCase();
	if (!s) return null;
	if (BY[s]) return BY[s];
	const w = s.split(/[\s(]/)[0];
	return BY[w] || s.slice(0, 40);
}
/** "0m 10s -> 0:16.83" | "no route" | "" -> {routed, solveS, best} | {routed: false} | null */
function aloneOf(v) {
	const s = String(v || '').trim();
	if (!s) return null;
	if (/^no\b|^none$|^-$/i.test(s)) return { routed: false };
	const m = /^(.*?)\s*->\s*(\S+)\s*$/.exec(s);
	if (m) return { routed: true, solveS: durSeconds(m[1]), best: timeOf(m[2]) };
	if (/^routed|^yes/i.test(s)) return { routed: true };
	return { routed: false, text: s.slice(0, 80) };
}
function compilerOf(v) {
	const s = String(v || '').trim().toLowerCase();
	if (!s) return null;
	return /^routed|^yes/.test(s);
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
function slug(s) {
	return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '') || 'benchmark';
}
/** CSV text -> the benchmark JSON (DESIGN.md 11.6); o: {name, id, source, now} */
function importCsv(text, opts) {
	const o = opts || {};
	const rows = parseCsv(text);
	const blank = (r) => !r || r.every((c) => !String(c || '').trim());
	let h = 0;
	while (h < rows.length && blank(rows[h])) h++;
	if (h >= rows.length) throw new Error('the file is empty');
	const { idx, titles, taken } = mapColumns(rows[h]);
	if (idx.level === undefined) throw new Error(`not a results table: no "level" column in its first line (${titles.filter(Boolean).slice(0, 6).join(', ')})`);
	const get = (r, k) => (idx[k] === undefined ? '' : String(r[idx[k]] === undefined ? '' : r[idx[k]]).trim());
	const sections = new Map();   // key -> {key, title}
	const secOf = (key, title) => {
		if (!sections.has(key)) sections.set(key, { key, title: title || titleCase(key) });
		else if (title) sections.get(key).title = title;
		return sections.get(key);
	};
	let titleKey = null;
	const out = [];
	for (let k = h + 1; k < rows.length; k++) {
		const r = rows[k];
		if (blank(r)) continue;
		// a section's title line: "CAMPAIGN: 175 of 203 routed" in its first cell, the rest empty (its counts are recomputed)
		const first = String(r[0] || '').trim();
		const tm = /^([A-Za-z][\w &'-]*?)\s*:\s*\d+\s+of\s+\d+\b/.exec(first);
		if (tm && r.slice(1).every((c) => !String(c || '').trim())) {
			titleKey = tm[1].trim().toLowerCase();
			secOf(titleKey, titleCase(tm[1].trim()));
			continue;
		}
		const level = get(r, 'level');
		if (!level) continue;
		const section = (get(r, 'section') || titleKey || 'all').toLowerCase();
		secOf(section);
		const resultText = get(r, 'result');
		const result = resultOf(resultText);
		let solveS = idx.solveS !== undefined ? durSeconds(get(r, 'solveS')) : null;
		if (solveS === null && idx.solveText !== undefined) solveS = durSeconds(get(r, 'solveText'));
		const best = timeOf(get(r, 'best'));
		const known = timeOf(get(r, 'known'));
		const extra = {};
		titles.forEach((t, j) => { if (!taken.has(j) && t && String(r[j] || '').trim()) extra[t] = String(r[j]).trim(); });
		out.push({
			i: out.length, section, level, result, resultText,
			solveS: result === 'none' ? null : solveS, by: result === 'none' ? null : byOf(get(r, 'by')),
			best, run: get(r, 'run') || null, known,
			ratio: best && known && known.runTicks > 0 ? Math.round(best.runTicks / known.runTicks * 1000) / 1000 : null,
			searchAlone: idx.searchAlone !== undefined ? aloneOf(get(r, 'searchAlone')) : null,
			compilerAlone: idx.compilerAlone !== undefined ? compilerOf(get(r, 'compilerAlone')) : null,
			merged: get(r, 'merged') ? get(r, 'merged').split(/\s*=\s*/).map((x) => x.trim()).filter(Boolean) : [],
			extra,
		});
	}
	if (!out.length) throw new Error('no level rows in the table');
	const columns = {};
	for (const [key] of COLS) if (idx[key] !== undefined) columns[key] = titles[idx[key]];
	const secs = [...sections.values()].filter((s) => out.some((r) => r.section === s.key)).map((s) => {
		const rs = out.filter((r) => r.section === s.key);
		return { key: s.key, title: s.title, routed: rs.filter((r) => r.result !== 'none').length, total: rs.length };
	});
	const source = o.source ? path.basename(String(o.source)) : null;
	const base = source ? source.replace(/\.[^.]+$/, '') : 'benchmark';
	const name = String(o.name || titleCase(base.replace(/[_-]+/g, ' ').trim())).slice(0, 120);
	const id = o.id ? String(o.id) : slug(name);
	if (!ID_RE.test(id)) throw new Error(`bad id "${id}": lower-case letters, digits and dashes, at most 64`);
	return { v: 1, id, name, source, imported: o.now || Date.now(), columns, sections: secs, rows: out };
}

// ---------------------------------------------------------------- a benchmark's numbers (DESIGN.md 10.2)
const BINS = [
	{ label: '≤10s', max: 10 }, { label: '30s', max: 30 }, { label: '1m', max: 60 }, { label: '2m', max: 120 }, { label: '5m', max: 300 },
	{ label: '10m', max: 600 }, { label: '30m', max: 1800 }, { label: '1h', max: 3600 }, { label: '>1h', max: Infinity },
];
const BIN_TEXT = ['10 s or less', '10-30 s', '30 s-1 min', '1-2 min', '2-5 min', '5-10 min', '10-30 min', '30-60 min', 'over 1 h'];
/** the q-quantile by nearest rank (q 0.5: the median of an odd count) of sorted numbers */
function quantile(sorted, q) {
	if (!sorted.length) return null;
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
}
/** the median as one of the values: the middle one, of an even count the upper of the two (a level's own number) */
function median(sorted) {
	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
function benchNumbers(b) {
	const rows = (b && b.rows) || [];
	const routed = rows.filter((r) => r.result !== 'none');
	const search = rows.filter((r) => r.searchAlone && r.searchAlone.routed);
	const comp = rows.filter((r) => r.compilerAlone === true);
	const either = rows.filter((r) => (r.searchAlone && r.searchAlone.routed) || r.compilerAlone === true);
	const onlyHybrid = routed.filter((r) => !(r.searchAlone && r.searchAlone.routed) && r.compilerAlone !== true);
	const by = {};
	for (const r of routed) if (r.by) by[r.by] = (by[r.by] || 0) + 1;
	const solve = routed.map((r) => r.solveS).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
	const bins = BINS.map((bn, k) => ({ label: bn.label, text: BIN_TEXT[k], n: 0 }));
	for (const s of solve) { const k = BINS.findIndex((bn) => s <= bn.max); bins[k].n++; }
	const ratios = rows.filter((r) => r.result !== 'none' && Number.isFinite(r.ratio)).map((r) => r.ratio).sort((x, y) => x - y);
	return {
		levels: rows.length, routed: routed.length, confirmed: rows.filter((r) => r.result === 'routed').length,
		unconfirmed: rows.filter((r) => r.result === 'unconfirmed').length,
		sections: (b && b.sections) || [],
		compare: { hybrid: routed.length, search: search.length, compiler: comp.length, either: either.length, onlyHybrid: onlyHybrid.length,
			hasSearch: rows.some((r) => r.searchAlone), hasCompiler: rows.some((r) => r.compilerAlone !== null && r.compilerAlone !== undefined) },
		by,
		solve: { n: solve.length, bins, median: median(solve), p90: quantile(solve, 0.9), max: solve.length ? solve[solve.length - 1] : null },
		quality: { known: ratios.length, under: ratios.filter((x) => x <= 1).length, within10: ratios.filter((x) => x <= 1.1).length,
			median: ratios.length ? median(ratios) : null },
	};
}

// ---------------------------------------------------------------- the benchmarks on disk and the jobs of their levels
const benchFile = (id, dir) => path.join(dir || BENCH_DIR, `${id}.json`);
function validBench(b) { return b && b.v === 1 && typeof b.id === 'string' && ID_RE.test(b.id) && Array.isArray(b.rows); }
function writeBenchmark(b, dir) {
	if (!validBench(b)) throw new Error('not a benchmark');
	const f = benchFile(b.id, dir);
	C.writeAtomic(f, JSON.stringify(b));
	return f;
}
function readBenchmark(id, dir) {
	if (!ID_RE.test(String(id || ''))) return null;
	const b = C.readJSON(benchFile(id, dir), null);
	return validBench(b) && b.id === id ? b : null;
}
function listBenchmarks(dir) {
	let names = [];
	try { names = fs.readdirSync(dir || BENCH_DIR).filter((f) => /^[a-z0-9-]{1,64}\.json$/.test(f)); } catch (e) { return []; }
	const out = [];
	for (const f of names) {
		const b = readBenchmark(f.slice(0, -5), dir);
		if (!b) continue;
		const n = benchNumbers(b);
		out.push({ id: b.id, name: b.name, source: b.source, imported: b.imported, levels: n.levels, routed: n.routed, confirmed: n.confirmed, sections: b.sections });
	}
	return out.sort((x, y) => (y.imported || 0) - (x.imported || 0) || x.id.localeCompare(y.id));
}
function removeBenchmark(id, dir) {
	if (!ID_RE.test(String(id || ''))) return false;
	try { fs.unlinkSync(benchFile(id, dir)); return true; } catch (e) { return false; }
}
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const md5Memo = new Map();   // job id -> {sig, v}
/** a job's level md5: meta.level.md5 (the level check, since 2026-09-28), else the md5 of its original.eelvl (cached) */
function jobMd5(j) {
	if (j.level && j.level.md5) return String(j.level.md5).toLowerCase();
	if (!j.id || !/^[a-z0-9-]+$/.test(j.id)) return '';
	const f = path.join(C.JOBS, j.id, 'original.eelvl');
	const sig = fileSig(f);
	const m = md5Memo.get(j.id);
	if (m && m.sig === sig) return m.v;
	let v = '';
	try { v = require('crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch (e) { /* no file */ }
	md5Memo.set(j.id, { sig, v });
	return v;
}
/** the md5 prefixes a row names: its own "(1a2b3c4d)" and its merged copies' "_1a2b3c4d" suffixes */
function rowHexes(r) {
	const out = [];
	const hm = /\(([0-9a-f]{6,32})\)\s*$/i.exec(r.level);
	if (hm) out.push(hm[1].toLowerCase());
	for (const m of r.merged || []) { const x = /[_ (]([0-9a-f]{8,32})\)?$/i.exec(m); if (x) out.push(x[1].toLowerCase()); }
	return out;
}
/** the app's jobs that are runs of a benchmark's levels -> {"<row i>": "<job id>"}: first the jobs whose level md5 starts
 *  with an md5 prefix the row names ("Name (1a2b3c4d)", or an identical copy "..._1a2b3c4d" it merged), else the jobs whose
 *  level name, or name without " (hybrid)" / " (compiled)", equals the row's level (case-insensitive) and whose md5 no
 *  other row names (a test level saved under a campaign level's name is no run of that level), on a campaign row a run of
 *  a campaign level first (summary().campaign); several: the one with the best run. o.md5Of(job): tests */
function matchJobs(b, jobs, o) {
	const md5Of = (o && o.md5Of) || jobMd5;
	const out = {};
	const rows = (b && b.rows) || [];
	const hexes = rows.map(rowHexes);
	const js = (jobs || []).map((j) => {
		const md5 = String(md5Of(j) || '').toLowerCase();
		let claim = -1;
		if (md5) for (let k = 0; k < rows.length && claim < 0; k++) if (hexes[k].some((h) => md5.startsWith(h))) claim = rows[k].i;
		return { id: j.id, level: norm(j.level && j.level.name), name: norm(String(j.name || '').replace(/\s*\((hybrid|compiled)\)\s*$/i, '')),
			md5, claim, camp: !!j.campaign, best: (j.best && j.best.runTicks) || Infinity };
	});
	rows.forEach((r, k) => {
		const lv = norm(r.level), hx = hexes[k];
		const better = (x, y) => !y || x.best < y.best;
		let pick = null;
		for (const j of js) if (j.md5 && hx.some((h) => j.md5.startsWith(h)) && better(j, pick)) pick = j;
		if (!pick) {
			let tier = -1;
			for (const j of js) {
				if (!(j.level === lv || j.name === lv) || (j.claim >= 0 && j.claim !== r.i)) continue;
				const t = r.section === 'campaign' && j.camp ? 1 : 0;
				if (t > tier || (t === tier && better(j, pick))) { pick = j; tier = t; }
			}
		}
		if (pick) out[r.i] = pick.id;
	});
	return out;
}

module.exports = {
	BENCH_DIR, ID_RE, FAMS, FAM_ORDER, RULES, BINS,
	classify, jobsStats, jobTime, logSessions, grindEvents, gpuEvents, downsample,
	parseCsv, importCsv, mapColumns, timeTicks, durSeconds, benchNumbers, quantile, median,
	writeBenchmark, readBenchmark, listBenchmarks, removeBenchmark, matchJobs, rowHexes, jobMd5, slug,
};
