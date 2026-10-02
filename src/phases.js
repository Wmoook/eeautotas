'use strict';
// The Optimizer view's data (docs/ui/DESIGN.md sections 9 and 11): what the optimizer did and does, as a timeline model the
// page draws (src/app/phases.js, window.TL). The phase dictionary (the families, the stages, their plain names) is that file's
// too: require('./app/phases.js') in Node is the dictionary, so the server's texts and the page's use the same names.
//
// jobTimeline(dir, {range, sig, running, live, now}) -> the model of GET /api/jobs/:id/phases (11.3):
//   {v, kind: 'job', job, sig, running, legacy, preview, range, t0, tNow, now {text, round, key, label, fam, since}, speed,
//    lanes [{id, label, subs, explain}], spans [{id, lane, sub, key, fam, label, explain, detail, round, t0, t1, threads, w0, w1,
//    saved, n}], rounds [{round, t0, t1, order, recipe [{key, label, fam, state: done | now | skipped | next, why}]}], marks [{t,
//    lane, sub, kind: best | refused, runTicks, saved, fam, key, label, what, round}], best [[t, runTicks, fam, label]], base,
//    rangeFinds, score [{key, fam, label, explain, ms, runs, finds, saved}], history [{t, runTicks, saved, what, key, fam, label,
//    round}] (every entry, classified)} | {unchanged: true, sig} when ?sig= is the model's sig.
//   Built from the job's grind_events.jsonl and gpu/events.jsonl (src/events.js: grind.js and gpusearch.js write them), read
//   incrementally (a file's new lines only); without them from grind.log (legacyJob: a run from before the events, `legacy`);
//   a job that never ran: the first round's stages as a preview (`preview`).
// hybridTimeline(state) -> the same shape (kind 'hybrid') for the level editor's Hybrid (best): GET /api/editor/hybrid
//   `timeline` (src/editor.js hybridState), from tools/hybrid.js's live state (liveOf: the compiler's stages and rounds, the
//   search's runs and states, the prefix searches, the routes, the restarts).
// classify(nameOrWhat, ctx), FAMS, STAGES: the dictionary (the Stats page's "by family" uses them).
const fs = require('fs');
const path = require('path');
const C = require('./common.js');
const D = require('./app/phases.js');

const { classify, classifySlot, recipeOf, fmt, dur, mmss, count, secTicks, MINUS } = D;
const RANGES = { session: 0, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, all: Infinity };
const MAX_SPANS = 2000;
const MAX_MARKS = 1200, MAX_HIST = 600;   // the finds drawn and the history classified, the newest
const LANES = {
	stages: { id: 'stages', label: 'Stages', explain: 'The round\'s stages, one after another (the route sweep\'s whole time, its windows below)' },
	sweep: { id: 'sweep', label: 'Sweep', explain: 'The route sweep\'s windows, up to 4 at once (a row per lane)' },
	fly: { id: 'fly', label: 'Corridor beam', explain: 'The corridor beam\'s own lane, next to the stages for the whole session' },
	gpu: { id: 'gpu', label: 'GPU', explain: 'The GPU searcher\'s work, one block per invocation' },
	in: { id: 'in', label: 'Handed in', explain: 'Runs handed in from outside: Find a route, Search harder, you, a rented machine' },
};
const LANE_ORDER = ['stages', 'sweep', 'fly', 'gpu', 'in'];

// ---------------------------------------------------------------- the events files, read incrementally
const cache = new Map();   // file -> {off, ino, events}
/** the lines of a JSONL file (only its new complete lines are parsed: the file's offset is kept; a shorter file = a new one) */
function readJsonl(file) {
	let st;
	try { st = fs.statSync(file); } catch (e) { if (cache.has(file)) { cacheBytes -= cache.get(file).off; cache.delete(file); } return []; }
	let c = cache.get(file);
	if (c && (st.size < c.off || (c.ino && st.ino && st.ino !== c.ino))) c = null;
	if (!c) c = { off: 0, ino: st.ino, events: [] };
	if (st.size > c.off) {
		let fd = null;
		try {
			fd = fs.openSync(file, 'r');
			const buf = Buffer.alloc(st.size - c.off);
			const n = fs.readSync(fd, buf, 0, buf.length, c.off);
			const cut = buf.lastIndexOf(10, n - 1);
			if (cut >= 0) {
				for (const l of buf.toString('utf8', 0, cut).split('\n')) { if (!l) continue; try { c.events.push(JSON.parse(l)); } catch (e) { /* a broken line */ } }
				c.off += cut + 1;
			}
		} catch (e) { /* read again next time */ } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } } }
	}
	// (the least recently used last in line; the cache is bounded by the bytes it has parsed, CACHE_BYTES, and by 400 files:
	// a parsed event takes ~3x its line, so 96 MB of lines is ~300 MB of the server's heap at most)
	if (cache.has(file)) cacheBytes -= cache.get(file).off;
	cache.delete(file);
	cache.set(file, c);
	cacheBytes += c.off;
	while (cache.size > 1 && (cache.size > 400 || cacheBytes > CACHE_BYTES)) {
		const k = cache.keys().next().value;
		cacheBytes -= cache.get(k).off;
		cache.delete(k);
	}
	return c.events;
}
const CACHE_BYTES = 96 << 20;
let cacheBytes = 0;
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const rot = (f) => f.replace(/\.jsonl$/, '.1.jsonl');
const eventsOf = (f) => readJsonl(rot(f)).concat(readJsonl(f));

// ---------------------------------------------------------------- pieces shared by the three builders
/** a span's plain detail (the tooltip, the now sentence) */
function detailOf(s) {
	const win = Number.isFinite(s.w0) && Number.isFinite(s.w1) ? `ticks ${count(s.w0)}–${count(s.w1)}` : '';
	switch (s.key) {
		case 'mut': return win ? `every input of ${win}` : 'every input of the run';
		case 'endgame': return 'every input over the run\'s last ticks';
		case 'sweep': return s.whole ? (s.note ? `windows of 800 ticks, ${s.note}` : 'windows of 800 ticks over the whole run') : win ? `window ${win}` : '';
		case 'loop': return win ? `a loop at ${win}` : 'a loop';
		case 'seg': return win;
		case 'skips': return 'where the run passes a spot it reaches much later';
		case 'skipf': return 'path changes from states all along the run';
		case 'flyb': return s.note ? String(s.note) : 'long low-contact stretches';
		case 'sc': return win;
		case 'phase': return s.note ? String(s.note) : 'time doors';
		case 'beam': return 'thousands of runs side by side';
		case 'splice': return s.note ? `joining the best with ${s.note}` : 'joining the best with every run\'s faster stretches';
		default: return win || (s.note ? String(s.note) : '');
	}
}
/** a span from an event-ish record: its dictionary entry and plain texts */
function dressSpan(s) {
	const c = s.lane === 'gpu' ? classifySlot(s.slot) : classify(s.name);
	s.key = c.key; s.fam = c.fam; s.label = c.label; s.explain = c.explain;
	s.detail = s.lane === 'gpu' ? (Number.isFinite(s.w0) && Number.isFinite(s.w1) ? `ticks ${count(s.w0)}–${count(s.w1)}` : '') : detailOf(s);
	// (a sweep window's block says which window: its ticks)
	if (s.lane === 'sweep' && Number.isFinite(s.w0) && Number.isFinite(s.w1)) s.short = `ticks ${count(s.w0)}–${count(s.w1)}`;
	return s;
}
/**
 * The blocks of one row of the tape (a lane, or one of the sweep's lanes) for the figure: consecutive blocks shorter than
 * `minMs` (a few pixels of the plot) merged into one band, whatever their stage (the GPU searcher's 3-30 s turns made a lane
 * of hundreds of 1-px blocks, a barcode; a 48-h session's sweep windows the same): the band has the colour of the stage
 * with the most time in it, its detail the stages and their runs. Drawing only: the score counts the blocks themselves. The
 * spans are copied (the built parts are shared between calls).
 */
function mergeShort(spans, minMs) {
	const out = [];
	for (const s0 of spans) {
		const last = out[out.length - 1];
		const d = (s0.t1 || Infinity) - s0.t0;
		if (last && last.small && !s0.whole && last.t1 && s0.t0 - last.t1 < Math.max(5000, minMs) && d < minMs && (last.t1 - last.t0) < minMs * 20) {
			last.t1 = s0.t1; last.n = (last.n || 1) + (s0.n || 1);
			if (s0.saved !== undefined && s0.saved !== null) last.saved = (last.saved > 0 ? last.saved : 0) + (+s0.saved || 0);
			const mx = last.mix.get(s0.key) || { ms: 0, n: 0, label: s0.label, fam: s0.fam };
			mx.ms += d; mx.n += s0.n || 1; last.mix.set(s0.key, mx);
			continue;
		}
		const s = Object.assign({}, s0);
		if (!s.whole && d < minMs) { s.small = true; s.mix = new Map([[s.key, { ms: d, n: s.n || 1, label: s.label, fam: s.fam }]]); }
		out.push(s);
	}
	for (const s of out) {
		if (!s.mix) continue;
		if (s.mix.size > 1 || s.n > 1) {
			let top = null;
			for (const [k, v] of s.mix) if (!top || v.ms > top[1].ms) top = [k, v];
			s.key = top[0]; s.fam = top[1].fam;
			const gpu = s.lane === 'gpu';
			s.label = s.mix.size > 1 ? (gpu ? 'GPU search' : 'Several stages') : top[1].label;
			s.short = undefined; s.w0 = undefined; s.w1 = undefined;
			s.detail = [...s.mix.values()].sort((x, y) => y.ms - x.ms).map((v) => `${v.label.replace(/^GPU: /, '')} ×${v.n}`).join(', ');
			if (s.mix.size > 1) s.explain = gpu ? 'The GPU searcher\'s turns, too short to draw one by one at this range: the colour is the one with the most time. A shorter range shows each.'
				: 'Stages too short to draw one by one at this range: the colour is the one with the most time. A shorter range shows each.';
		}
		delete s.mix; delete s.small;
	}
	return out;
}
/** the round whose time holds t (rounds sorted by t0) */
function roundAt(rounds, t) {
	let r = null;
	for (const x of rounds) { if (x.t0 && x.t0 <= t) r = x; else if (x.t0 > t) break; }
	return r && (!r.t1 || t <= r.t1 + 5000) ? r.round : null;
}

/**
 * The parts every job model shares: the range, the clipped spans and marks, the best steps, the score, the now sentence.
 * b: {sessions [{t0, end (null: open), W, gpu}], spans, rounds, marks (history-based, all), refused, finds (GPU find events),
 * gpuOpen, paused, status, meta, hist, legacy}; o: the request's options.
 */
function assemble(dir, b, o) {
	const now = o.now || Date.now();
	const last = b.sessions[b.sessions.length - 1] || null;
	const open = !!(last && last.end === null);
	const hist = b.hist;
	const orig = (b.meta.tas && b.meta.tas.runTicks) || null;
	const range = Object.prototype.hasOwnProperty.call(RANGES, o.range) ? o.range : 'session';
	// (stopped: the session range ends with that session; the others with the last thing that happened, a run handed in later too)
	const tNow = open ? now : (range === 'session' && last ? last.end : Math.max(last ? last.end : 0, hist.length ? hist[hist.length - 1].t : 0)) || now;
	let t0;
	if (range === 'session') t0 = last ? last.t0 : (hist.length ? hist[0].t : tNow - 60e3);
	else if (range === 'all') {
		// (from the first thing that happened: a session or a find; the job's creation only when there is neither)
		const first = Math.min(b.sessions.length ? b.sessions[0].t0 : Infinity, hist.length ? Math.min(...hist.map((h) => h.t)) : Infinity);
		t0 = Math.min(Number.isFinite(first) ? first : (+b.meta.created || tNow - 60e3), tNow - 60e3);
	}
	else t0 = tNow - RANGES[range];
	if (!(tNow - t0 >= 10e3)) t0 = tNow - 10e3;
	// the spans in range (open ones run to now); for the figure each row's runs of blocks under ~4 px of an 800-px plot merged
	// into bands, then the newest MAX_SPANS
	const inRange = b.spans.filter((s) => (s.t1 || tNow) >= t0 && s.t0 <= tNow).sort((p, q) => p.t0 - q.t0);
	const rowsOf = new Map();
	for (const sp of inRange) { const k = `${sp.lane}|${sp.sub | 0}`; if (!rowsOf.has(k)) rowsOf.set(k, []); rowsOf.get(k).push(sp); }
	let spans = [];
	for (const list of rowsOf.values()) spans = spans.concat(mergeShort(list, (tNow - t0) / 200));
	spans.sort((p, q) => p.t0 - q.t0);
	if (spans.length > MAX_SPANS) spans = spans.slice(spans.length - MAX_SPANS);
	// the marks in range (the best runs: history; the hand-ins that were not accepted)
	const marks = b.marks.concat(b.refused).filter((m) => m.t >= t0 - 1000 && m.t <= tNow + 1000).sort((p, q) => p.t - q.t);
	// the best steps: the best at the range's start, then every find in range
	const sorted = hist.slice().sort((p, q) => p.t - q.t);
	let b0 = orig;
	for (const h of sorted) if (h.t < t0) b0 = h.runTicks;   // (a find AT the range's start is its first step: the "all" range starts there)
	const best = b0 ? [[t0, b0, null, 'the best at the range\'s start']] : [];
	const byT = new Map(b.marks.map((m) => [m.t, m]));
	for (const h of sorted) {
		if (h.t < t0 || h.t > tNow + 1000) continue;
		const m = byT.get(h.t);
		best.push([h.t, h.runTicks, m ? m.fam : 'combine', m ? `${m.label}: ${MINUS}${count(h.saved)}` : h.what]);
	}
	const rangeFinds = best.length - 1;
	// the lanes with something in range
	const used = new Set(spans.map((s) => s.lane));
	for (const m of marks) used.add(m.lane);
	let subs = 1;
	for (const s of spans) if (s.lane === 'sweep') subs = Math.max(subs, (s.sub | 0) + 1);
	const lanes = LANE_ORDER.filter((id) => used.has(id)).map((id) => Object.assign({}, LANES[id], id === 'sweep' ? { subs: Math.max(subs, Math.min(4, subs)) } : {}));
	// the score: per stage, the time of its runs in range (CPU: its threads' share of the session's threads), its finds
	const W = (s) => { const ss = b.sessions[s.sess]; return (ss && ss.W) || 1; };
	const rows = new Map();
	const row = (k, fam, label, explain) => rows.get(k) || rows.set(k, { key: k, fam, label, explain: explain || '', ms: 0, cpuMs: 0, gpuMs: 0, runs: 0, finds: 0, saved: 0 }).get(k);
	for (const s of inRange) {
		if (s.whole) continue;   // (the sweep's whole span: its windows count)
		const a = Math.max(s.t0, t0), z = Math.min(s.t1 || tNow, tNow);
		if (z <= a) continue;
		const r = row(s.key, s.fam, s.label, s.explain);
		// (the CPU's time weighted by its threads' share, the GPU's wall time: two machines, two columns; ms = both, the
		// rate's base: a sum of the two can be longer than the session)
		if (s.lane === 'gpu') r.gpuMs += z - a; else r.cpuMs += (z - a) * Math.min(1, (s.threads || W(s)) / W(s));
		r.ms = r.cpuMs + r.gpuMs;
		r.runs += s.n || 1;
	}
	for (const m of marks) {
		if (m.kind !== 'best' || m.t < t0) continue;
		const f = m.find;
		if (f && f.fams) {
			// (a GPU find: its saving split over the families whose shortcuts it used, the rest to the combine with other runs)
			const parts = Object.entries(f.fams).map(([k, v]) => [classifySlot(k), Math.max(0, -v)]).filter((p) => p[1] > 0);
			if (f.other > 0) parts.push([D.STAGE.splice ? { key: 'splice', fam: 'combine', label: D.STAGE.splice.label, explain: D.STAGE.splice.explain } : null, f.other]);
			const tot = parts.reduce((x, p) => x + p[1], 0);
			if (tot > 0) {
				let bestP = parts[0];
				for (const p of parts) { if (p[1] > bestP[1]) bestP = p; const r = row(p[0].key, p[0].fam, p[0].label, p[0].explain); r.saved += Math.round((m.saved || 0) * p[1] / tot); }
				row(bestP[0].key, bestP[0].fam, bestP[0].label, bestP[0].explain).finds++;
				continue;
			}
		}
		const r = row(m.key, m.fam, m.label, m.explainOf || '');
		r.finds++; r.saved += m.saved || 0;
	}
	const score = [...rows.values()].sort((p, q) => q.saved - p.saved || q.ms - p.ms);
	// the rounds in range (the last one's recipe is the chips)
	const rounds = b.rounds.filter((r) => !r.t0 || ((r.t1 || tNow) >= t0 && r.t0 <= tNow));
	// (the payload: a long job's range holds thousands of finds; the view draws the newest MAX_MARKS, the Improvements table the
	// newest MAX_HIST rows; the score above counted every one)
	const marksOut = marks.length > MAX_MARKS ? marks.slice(marks.length - MAX_MARKS) : marks;
	const histOut = b.history.length > MAX_HIST ? b.history.slice(b.history.length - MAX_HIST) : b.history;
	const bestNow = b.status.bestRunTicks || (hist.length ? hist[hist.length - 1].runTicks : orig) || null;
	const model = {
		v: 1, kind: 'job', job: path.basename(dir), sig: o.sigNow, running: open, legacy: !!b.legacy, preview: false, range, t0, tNow, gpu: !!b.gpuOn,
		speed: open && o.live && o.live.cpu ? { cpu: +o.live.cpu.ticksPerSec || 0, gpu: o.live.gpu ? +o.live.gpu.ticksPerSec || 0 : 0, threads: o.live.cpu.threads || null, gpuName: o.live.gpu ? o.live.gpu.name || null : null } : null,
		lanes, spans: spans.map(clean), rounds, marks: marksOut.map(cleanMark), best, base: orig ? { runTicks: orig, time: fmt(orig), label: 'original' } : null, rangeFinds, score,
		history: histOut, histTotal: b.history.length, marksTotal: marks.length, bestNow,
	};
	model.now = nowJob(model, { open, last, hist, status: b.status, spansAll: b.spans, gpuOpen: b.gpuOpen, paused: b.paused, now, best: b.status.bestRunTicks || (hist.length ? hist[hist.length - 1].runTicks : orig) });
	return model;
}
// (a span's explanation is the dictionary's for its key: the page looks it up, D.STAGE[key].explain; a span whose key the
// dictionary has not keeps its own)
const clean = (s) => ({ id: s.id, lane: s.lane, sub: s.sub | 0, key: s.key, fam: s.fam, label: s.label, short: s.short || undefined, explain: D.STAGE[s.key] && D.STAGE[s.key].explain === s.explain ? undefined : s.explain, detail: s.detail, name: s.name, round: s.round, t0: s.t0, t1: s.t1,
	threads: s.threads || null, w0: s.w0, w1: s.w1, saved: s.saved === undefined ? null : s.saved, killed: !!s.killed, whole: !!s.whole, n: s.n || 1 });
const cleanMark = (m) => ({ t: m.t, lane: m.lane, sub: m.sub | 0, kind: m.kind, runTicks: m.runTicks, saved: m.saved, fam: m.fam, key: m.key, label: m.label, what: m.what, round: m.round, why: m.why });

/** the history, classified (the GPU's finds by their find events: the family of the largest credit) */
function classifyHistory(hist, finds, rounds, remote) {
	return hist.map((h) => {
		let f = null;
		if (/^(inbox \(|try: )gpu\b/.test(String(h.what || ''))) {
			for (const x of finds) { if (x.t <= h.t + 2000 && x.t >= h.t - 30000 && x.to === h.runTicks) f = x; }
		}
		let gpuFam = null;
		if (f && f.fams) { let bv = 0; for (const [k, v] of Object.entries(f.fams)) if (-v > bv) { bv = -v; gpuFam = k; } }
		const c = classify(h.what, { gpuFam, remote });
		return { t: h.t, runTicks: h.runTicks, saved: h.saved, what: h.what, key: c.key, fam: c.fam, label: c.label, explainOf: c.explain, round: roundAt(rounds, h.t), find: f };
	});
}
/** a mark's lane for a history entry: its span's, else by what it is */
function laneOfWhat(w) {
	w = String(w || '');
	if (/^(inbox \(|try: )gpu\b/.test(w)) return 'gpu';
	if (/^(inbox \(|try: )/.test(w) && !/\(splice/.test(w)) return 'in';
	if (/^flybeam lane/.test(w)) return 'fly';
	if (/^sweep\d+_\d+/.test(w)) return 'sweep';
	return 'stages';
}
/** the hand-ins that were not accepted (inbox/results.jsonl), but the GPU's own (it combines them itself) */
function refusedOf(dir) {
	const out = [];
	for (const r of readJsonl(path.join(dir, 'inbox', 'results.jsonl'))) {
		if (r.accepted || /^gpu\b/i.test(String(r.source || ''))) continue;
		out.push({ t: +r.t, lane: 'in', sub: 0, kind: 'refused', runTicks: r.runTicks, saved: 0, fam: 'outside', key: 'in', label: 'Handed in', what: String(r.source || ''), why: r.reason || '' });
	}
	return out;
}

// ---------------------------------------------------------------- the now sentence (11.3)
function nowJob(model, x) {
	const hist = x.hist || [];
	const lastH = hist.length ? hist[hist.length - 1] : null;
	const lastFind = () => {
		if (!lastH) return '';
		const c = (model.history || []).find((h) => h.t === lastH.t && h.runTicks === lastH.runTicks);
		return ` Last find ${dur(x.now - lastH.t)} ago: ${MINUS}${secTicks(lastH.saved)} by ${c ? c.label : classify(lastH.what).label}.`;
	};
	if (model.preview) return { text: 'Not started yet. Press Start: the first minutes find the most time.', round: 1, key: null, label: null, fam: null, since: null };
	if (!x.open) {
		const st = x.status || {};
		if (st.state === 'error') return { text: `Stopped by an error (see the optimizer log under Files). The best is ${fmt(x.best)}.` };
		const s = x.last;
		if (!s) return { text: lastH ? `Not running. The best is ${fmt(x.best)}.${lastFind()}` : 'Not started yet. Press Start: the first minutes find the most time.' };
		const found = hist.filter((h) => h.t >= s.t0 && h.t <= s.end + 1000).reduce((a, h) => a + (h.saved || 0), 0);
		const ran = dur(Math.max(0, s.end - s.t0));
		const word = st.state === 'finished' ? 'Finished (its deadline).' : 'Paused.';
		return { text: `${word} The last session ran ${ran} and ${found > 0 ? `found ${secTicks(found)}` : 'found no faster run'}; the best is ${fmt(x.best)}.` };
	}
	// running: the stages lane's open span (the round's stage), the sweep's open windows, the GPU's open block
	const openSp = (lane) => x.spansAll.filter((s) => s.lane === lane && !s.t1 && s.sess === x.last.i).sort((p, q) => p.t0 - q.t0);
	const st = openSp('stages').pop();
	const rounds = model.rounds || [];
	const r = rounds[rounds.length - 1];
	if (!st && !r) return { text: 'Starting the optimizer…', round: null };
	let text;
	if (st) {
		let det = st.detail || '';
		if (st.whole) {
			const w = openSp('sweep');
			const wins = w.map((s) => (Number.isFinite(s.w0) ? `${count(s.w0)}–${count(s.w1)}` : '')).filter(Boolean);
			const of = st.windows ? ` (${st.windows} windows in the run)` : '';
			det = wins.length ? `exploring ${wins.length > 1 ? `ticks ${wins.join(', ')} at once` : `ticks ${wins[0]}`} on ${w.length} lane${w.length === 1 ? '' : 's'}${of}` : `windows of 800 ticks over the run${of}`;
		}
		text = `Round ${st.round || (r && r.round) || 1}: ${st.label}${det ? `, ${det}` : ''}.`;
	} else {
		const now = r.recipe && r.recipe.find((c) => c.state === 'now');
		text = `Round ${r.round}: ${now ? `${now.label}, between its steps` : 'between two stages'}.`;
	}
	if (x.paused) text += ' The GPU waits while Find a route has it.';
	else {
		const g = openSp('gpu').pop();
		if (g) text += ` The GPU ${D.GPU_DOES[g.key] || 'searches'}.`;
	}
	text += lastFind();
	return { text, round: st ? st.round : r ? r.round : null, key: st ? st.key : null, label: st ? st.label : null, fam: st ? st.fam : null, since: st ? st.t0 : null };
}

// the stages that run only when switched on (the skip finder, the corridor beam as a stage): no chip unless they ever ran here
const OPT_IN = new Set(['skipfA', 'skipf', 'flyb']);
/** the round's recipe: one chip per stage of its order (done / now / skipped / next); the opt-in stages that never ran on this
 *  job and the time-door pass in the plain order (it runs only in the time-door order) are left out */
function recipe(r, spansAll, skips, ctx) {
	const everRan = new Set();
	for (const s of spansAll) if (s.stageKey) everRan.add(s.stageKey === 'skipf' || s.stageKey === 'skipfA' ? 'skipf' : s.stageKey);
	const order0 = r.order && r.order.length ? r.order : D.STAGES_ALL;
	const order = order0.filter((k) => !(OPT_IN.has(k) && !everRan.has(k === 'skipfA' ? 'skipf' : k)) && !(k === 'phase' && !order0.includes('phaseB')));
	const inRound = spansAll.filter((s) => s.sess === r.sess && s.lane === 'stages' && (s.round === r.round || (s.stageKey === 'splice' && s.t0 >= r.t0 && (!r.t1 || s.t0 <= r.t1))));
	const keyOf = (s) => (s.stageKey === 'loop' || s.stageKey === 'seg' || s.stageKey === 'sweep' ? 'deep' : s.stageKey);
	const sk = skips.filter((s) => s.sess === r.sess && s.round === r.round);
	const ran = new Map();
	for (const s of inRound) { const k = keyOf(s); const v = ran.get(k) || { open: false, n: 0 }; v.n++; if (!s.t1) v.open = true; ran.set(k, v); }
	// how far the round got: the cursor's stage (running), else the last stage that ran
	let at = -1;
	if (ctx.cursorStage && ctx.open && ctx.cursorRound === r.round) at = order.indexOf(ctx.cursorStage);
	for (let i = 0; i < order.length; i++) if (ran.has(order[i]) || sk.some((s) => s.key === order[i])) at = Math.max(at, i);
	const done = !!r.ended;   // (a round that ended; one a stop cut short leaves the rest to come)
	return order.map((k, i) => {
		const c = recipeOf(k);
		const s = sk.find((x) => x.key === k);
		const v = ran.get(k);
		let state, why = '';
		if (v && v.open && ctx.open) state = 'now';
		else if (ctx.open && ctx.cursorRound === r.round && ctx.cursorStage === k && !done) state = 'now';
		else if (v) state = 'done';
		else if (s) { state = 'skipped'; why = s.why || ''; }
		else if (done || i < at) { state = 'skipped'; why = k === 'flyb' && ctx.flyK ? D.SKIP_WHY.flybLane : D.SKIP_WHY[k] || ''; }
		else state = 'next';
		return { key: k, dict: c.dict, label: c.label, fam: c.fam, explain: c.explain, state, why };
	});
}

// ---------------------------------------------------------------- a job with events (11.1)
function fromEvents(dir, evs, gevs, ctx) {
	const sessions = [], spans = [], rounds = [], skips = [], bestEvs = [];
	const byId = new Map();
	let cur = null;
	for (const e of evs) {
		if (!e || typeof e !== 'object') continue;
		if (e.ev === 'session') {
			if (e.cont && cur) continue;
			if (cur && cur.end === null) cur.end = cur.tLast;
			cur = { i: sessions.length, t0: +e.t, tLast: +e.t, end: null, why: null, pid: e.pid, W: e.workers || 1, flyK: e.flyK || 0, gpu: !!e.gpu, phaseOrder: !!e.phaseOrder };
			sessions.push(cur);
			continue;
		}
		if (!cur) continue;
		const t = +e.t || cur.tLast;
		if (t > cur.tLast) cur.tLast = t;
		if (e.ev === 'stage') {
			const s = { sess: cur.i, id: e.id, lane: e.lane || 'stages', sub: e.sub | 0, stageKey: e.key, name: String(e.name || ''), round: e.round, t0: t, t1: null, threads: e.threads || null,
				w0: e.w0, w1: e.w1, note: e.note || '', whole: !!e.whole, windows: e.windows || null, saved: undefined, killed: false, ticks: 0 };
			byId.set(`${cur.i}:${e.id}`, s);
			spans.push(s);
		} else if (e.ev === 'stageEnd') {
			const s = byId.get(`${cur.i}:${e.id}`);
			if (s) { s.t1 = t; s.code = e.code; s.killed = !!e.killed; s.ticks = e.ticks || 0; }
		} else if (e.ev === 'stageResult') {
			const s = byId.get(`${cur.i}:${e.id}`);
			if (s) s.saved = +e.saved || 0;
		} else if (e.ev === 'round') {
			for (const r of rounds) if (r.sess === cur.i && !r.t1) r.t1 = t;
			rounds.push({ sess: cur.i, round: e.round, t0: t, t1: null, order: e.order || [], resume: e.resume || null });
		} else if (e.ev === 'roundEnd') {
			for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i].sess === cur.i && rounds[i].round === e.round) { rounds[i].t1 = t; rounds[i].ended = true; rounds[i].best = e.best; break; }
		} else if (e.ev === 'skip') skips.push({ sess: cur.i, t, round: e.round, key: e.key, name: e.name, why: e.why });
		else if (e.ev === 'best') bestEvs.push({ sess: cur.i, t, span: e.span === null || e.span === undefined ? null : `${cur.i}:${e.span}`, what: e.what, source: e.source });
		else if (e.ev === 'end') { cur.end = t; cur.why = e.why; }
	}
	// the GPU: its slots (a block each), its finds (their families' credit), a pause while Find a route has it; its lines are
	// part of the grind session they fall in (the searcher's last words count for the session's length)
	const finds = [];
	let gsess = -1, paused = false;
	const gOpen = new Map();
	for (const e of gevs) {
		if (!e || typeof e !== 'object') continue;
		const t = +e.t || 0;
		const sess = (() => { for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].t0 <= t + 2000) return i; return -1; })();
		if (sess >= 0 && t > sessions[sess].tLast && sessions[sess].end === null) sessions[sess].tLast = t;
		if (e.ev === 'gpuStart') { if (!e.cont) gsess++; paused = false; for (const s of gOpen.values()) { if (!s.t1) { s.t1 = Math.max(s.t0, t); s.killed = true; } } gOpen.clear(); continue; }
		if (sess < 0) continue;
		if (e.ev === 'slot') {
			const s = { sess, g: gsess, id: e.id, lane: 'gpu', sub: 0, slot: e.fam, name: `gpu ${e.fam}`, round: e.round, t0: t, t1: null, w0: e.w0, w1: e.w1, threads: null };
			gOpen.set(`${gsess}:${e.id}`, s);
			spans.push(s);
		} else if (e.ev === 'slotEnd') {
			const s = gOpen.get(`${gsess}:${e.id}`);
			if (s) { s.t1 = t; s.ticks = e.ticks || 0; s.added = e.added || 0; s.err = e.err || null; s.saved = undefined; gOpen.delete(`${gsess}:${e.id}`); }
		} else if (e.ev === 'find') finds.push({ t, from: e.from, to: e.to, saved: e.saved, fams: e.fams || {}, other: e.other || 0, accepted: e.accepted });
		else if (e.ev === 'pause') paused = true;
		else if (e.ev === 'resume') paused = false;
	}
	// is the last session the grind that runs now? (the others end at their last line, their open spans killed there)
	const last = sessions[sessions.length - 1];
	const running = !!ctx.running && last && (!ctx.pid || !last.pid || last.pid === ctx.pid) && last.end === null;
	for (const s of sessions) if (s.end === null && !(s === last && running)) s.end = s.tLast;
	for (const s of spans) if (!s.t1 && s.lane !== 'gpu' && sessions[s.sess].end !== null) { s.t1 = Math.max(s.t0, sessions[s.sess].end); s.killed = true; }
	for (const r of rounds) if (!r.t1 && sessions[r.sess].end !== null) r.t1 = Math.max(r.t0, sessions[r.sess].end);
	// open GPU blocks: open only while the session runs (and the searcher's last word is recent); else closed at its last line
	const lastG = gevs.length ? +gevs[gevs.length - 1].t || 0 : 0;
	for (const s of gOpen.values()) {
		if (s.t1) continue;
		if (running && s.sess === last.i && (ctx.now || Date.now()) - lastG < 10 * 60e3) continue;
		s.t1 = Math.max(s.t0, Math.min(sessions[s.sess].end || lastG, lastG || s.t0)); s.killed = true;
	}
	for (const s of spans) dressSpan(s);
	// the history, classified; its marks on the lane of the span that found them
	const status = ctx.status, hist = Array.isArray(status.history) ? status.history.filter((h) => h && Number.isFinite(+h.t)) : [];
	const history = classifyHistory(hist, finds, rounds, ctx.remote);
	const bestByT = new Map(bestEvs.map((x) => [x.t, x]));
	const spanBy = new Map(spans.filter((s) => s.lane !== 'gpu').map((s) => [`${s.sess}:${s.id}`, s]));
	const marks = history.map((h) => {
		const be = bestByT.get(h.t);
		const sp = be && be.span ? spanBy.get(be.span) : null;
		return { t: h.t, lane: sp ? sp.lane : laneOfWhat(h.what), sub: sp ? sp.sub : 0, kind: 'best', runTicks: h.runTicks, saved: h.saved, fam: h.fam, key: h.key, label: h.label, explainOf: h.explainOf,
			what: h.what, round: h.round, find: h.find };
	});
	// the last round's recipe (the chips: the view shows only the round under way or the last one; a recipe for every round
	// was 900 KB and seconds of the server's time on a long job)
	const cursor = status.cursor || {};
	for (const r of rounds) r.title = `Round ${r.round}`;
	const lr = rounds[rounds.length - 1];
	const rctx = (r) => ({ open: running && r.sess === last.i, cursorStage: cursor.stage, cursorRound: cursor.round, flyK: sessions[r.sess].flyK });
	if (lr) lr.recipe = recipe(lr, spans, skips, rctx(lr));
	const recipeOf = (no) => { const r = rounds.filter((x) => x.round === no).pop(); return r ? r.recipe || recipe(r, spans, skips, rctx(r)) : null; };
	const b = { sessions: sessions.map((s) => ({ t0: s.t0, end: s.end, W: s.W, gpu: s.gpu, i: s.i })), spans, rounds: rounds.map(roundOut),
		marks, refused: refusedOf(dir), status, meta: ctx.meta, hist, history: history.map(stripHist), gpuOn: !!(last && last.gpu), paused: running && paused, legacy: false, recipeOf };
	if (b.sessions.length) b.sessions[b.sessions.length - 1].end = running ? null : b.sessions[b.sessions.length - 1].end;
	b.sessions.forEach((s, i) => { s.i = i; });
	return b;
}
const stripHist = (h) => ({ t: h.t, runTicks: h.runTicks, saved: h.saved, what: h.what, key: h.key, fam: h.fam, label: h.label, round: h.round });
/** a round as the model sends it: its order and recipe only on the round that has a recipe (the last) */
const roundOut = (r) => (r.recipe ? { round: r.round, t0: r.t0, t1: r.t1, order: r.order, recipe: r.recipe, title: r.title } : { round: r.round, t0: r.t0, t1: r.t1, title: r.title });

// ---------------------------------------------------------------- a job from before the events: its grind.log (11.3.1)
/** grind.log's lines [{tag, sec (of its day), text}] with their times: the clock times anchored on status.json sessionStarted
 *  (the last start line) or the file's mtime (the last line), a day added at every backward jump of more than 6 hours */
function logLines(dir, status) {
	const f = path.join(dir, 'grind.log');
	let text = '', mtime = Date.now();
	try {
		const st = fs.statSync(f);
		mtime = st.mtimeMs;
		const n = Math.min(st.size, 4 << 20);
		const fd = fs.openSync(f, 'r');
		const buf = Buffer.alloc(n);
		fs.readSync(fd, buf, 0, n, st.size - n);
		fs.closeSync(fd);
		text = buf.toString('utf8');
		if (n < st.size) text = text.slice(text.indexOf('\n') + 1);
	} catch (e) { return []; }
	const recs = [];
	for (const l of text.split(/\r?\n/)) {
		const m = /^\[(grind|gpu|try) (\d\d):(\d\d):(\d\d)\] (.*)$/.exec(l);
		if (m) recs.push({ tag: m[1], sec: +m[2] * 3600 + +m[3] * 60 + +m[4], text: m[5] });
	}
	if (!recs.length) return [];
	let day = 0, prev = recs[0].sec;
	for (const r of recs) { if (r.sec < prev - 6 * 3600) day++; prev = r.sec; r.rel = day * 86400 + r.sec; }
	const secOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
	let base = null;
	const starts = recs.filter((r) => r.tag === 'grind' && /^start: best/.test(r.text));
	const S = starts[starts.length - 1];
	if (S && status.sessionStarted) {
		const c = secOfDay(status.sessionStarted);
		if (Math.abs(c - S.sec) <= 5) base = status.sessionStarted - (c - S.sec) * 1000 - S.rel * 1000;
	}
	if (base === null) {
		const L = recs[recs.length - 1], cM = secOfDay(mtime);
		base = mtime - ((cM - L.sec + 86400) % 86400) * 1000 - L.rel * 1000;
	}
	for (const r of recs) r.t = base + r.rel * 1000;
	return recs;
}
const RE_STAGE = /^([A-Za-z]\w*(?:\.\d+)?)(?: \((.*)\))?\.\.\.$/;
/** the round of a stage by its log name (mutate_3a_1 -> 3, sweep3_4 -> 3, ...) and its recipe key */
function nameInfo(name) {
	let m = /^mutate_(\d+)([abc])/.exec(name);
	if (m) return { round: +m[1], key: `mut${m[2].toUpperCase()}` };
	if ((m = /^sweep(\d+)/.exec(name))) return { round: +m[1], key: 'deep' };
	if ((m = /^deep(\d+)/.exec(name))) return { round: +m[1], key: 'deep' };
	if ((m = /^endgame(\d+)/.exec(name))) return { round: +m[1], key: 'endgame' };
	if ((m = /^skipfind(\d+)/.exec(name))) return { round: +m[1], key: 'skipf' };
	if ((m = /^skips(\d+)/.exec(name))) return { round: +m[1], key: 'skips' };
	if ((m = /^shortcuts(\d+)/.exec(name))) return { round: +m[1], key: 'sc' };
	if ((m = /^phaseb(\d+)/.exec(name))) return { round: +m[1], key: 'phaseB' };
	if ((m = /^phase(\d+)/.exec(name))) return { round: +m[1], key: 'phase' };
	if ((m = /^beam(\d+)/.exec(name))) return { round: +m[1], key: 'beam' };
	if ((m = /^flybeam(\d+)/.exec(name))) return { round: +m[1], key: 'flyb' };
	return { round: null, key: null };
}
function legacyJob(dir, ctx) {
	const status = ctx.status;
	const recs = logLines(dir, status);
	if (!recs.some((r) => r.tag === 'grind' && /^start: best/.test(r.text))) return null;
	const sessions = [], spans = [], skips = [], roundEnds = [];
	let cur = null, seq = 0;
	const openOn = new Map();   // lane key -> span
	const close = (key, t, extra) => { const s = openOn.get(key); if (s) { s.t1 = Math.max(s.t0, t); Object.assign(s, extra || {}); openOn.delete(key); } };
	const closeAll = (t, killed) => { for (const k of [...openOn.keys()]) close(k, t, killed ? { killed: true } : null); };
	let gFirst = null, gLast = null;
	const gpuBand = () => {
		if (cur && gFirst !== null) spans.push({ sess: cur.i, id: ++seq, lane: 'gpu', slot: 'gpu', name: 'GPU search', t0: gFirst, t1: gLast, threads: null, legacyGpu: true });
		gFirst = gLast = null;
	};
	let prevT = recs[0].t;
	for (const r of recs) {
		const t = r.t;
		if (r.tag === 'gpu') { if (cur) { if (gFirst === null) gFirst = t; gLast = t; } prevT = t; continue; }
		if (r.tag === 'try') continue;   // (a run handed to a stopped job, days later perhaps: no part of a session)
		const x = r.text;
		if (r.tag === 'grind' && /^start: best/.test(x)) {
			if (cur) { closeAll(prevT, true); gpuBand(); cur.end = prevT; }
			const w = /(\d+) workers/.exec(x);
			cur = { i: sessions.length, t0: t, end: null, W: w ? +w[1] : 1, gpu: false };
			sessions.push(cur);
			prevT = t;
			continue;
		}
		prevT = t;
		if (!cur || r.tag !== 'grind') continue;
		if (/^GPU on/.test(x)) { cur.gpu = true; continue; }
		if (/^finished: best/.test(x)) { closeAll(t); cur.end = t; continue; }
		let m;
		if ((m = /^round (\d+) done/.exec(x))) { roundEnds.push({ sess: cur.i, round: +m[1], t }); for (const k of [...openOn.keys()]) if (k === 'stages') close(k, t); continue; }
		if ((m = /^(sweep\d+): hunt windows/.exec(x))) {
			close('stages', t);
			const s = { sess: cur.i, id: ++seq, lane: 'stages', name: m[1], stageKey: 'deep', round: nameInfo(m[1]).round, t0: t, t1: null, whole: true, threads: cur.W, note: '' };
			spans.push(s); openOn.set('stages', s);
			continue;
		}
		if ((m = /^(sweep\d+): \d+ windows? searched/.exec(x))) { const s = openOn.get('stages'); if (s && s.name === m[1]) close('stages', t); continue; }
		if ((m = /^(sweep\d+_\d+): (?:its window saves (\d+)|nothing in this window)/.exec(x))) {
			for (const [k, s] of openOn) if (s.name === m[1]) close(k, t, { saved: m[2] ? +m[2] : 0 });
			continue;
		}
		if ((m = /^(deep\d+_loop\d+): (?:a way around the loop, -(\d+)|no way around)/.exec(x))) { const s = openOn.get('stages'); if (s && s.name === m[1]) close('stages', t, { saved: m[2] ? +m[2] : 0 }); continue; }
		if ((m = /^(mutate_\d+[abc])\w*: skipped \((.*)\)$/.exec(x))) { const ni = nameInfo(m[1]); skips.push({ sess: cur.i, t, round: ni.round, key: ni.key, name: m[1], why: m[2] }); continue; }
		if ((m = /^(beam(\d+)): stopped by the restart/.exec(x))) { skips.push({ sess: cur.i, t, round: +m[2], key: 'beam', name: m[1], why: 'stopped by the restart; not repeated' }); continue; }
		if ((m = /^(flybeam lane \d+) \((.*)\)\.\.\.$/.exec(x))) {
			close('fly', t);
			const s = { sess: cur.i, id: ++seq, lane: 'fly', name: m[1], stageKey: 'fly', round: null, t0: t, t1: null, threads: 1, note: m[2] };
			spans.push(s); openOn.set('fly', s);
			continue;
		}
		if ((m = /^(flybeam lane \d+)(?::| \()/.exec(x)) && openOn.get('fly') && openOn.get('fly').name === m[1]) { close('fly', t); continue; }
		if ((m = RE_STAGE.exec(x))) {
			const name = m[1], note = m[2] || '';
			const ni = nameInfo(name);
			if (/^sweep\d+_\d+$/.test(name)) {
				const ln = /lane (\d+)\/(\d+)/.exec(note), tk = /ticks (\d+)-(\d+)/.exec(note), th = /(\d+) threads/.exec(note);
				const sub = ln ? +ln[1] - 1 : 0;
				close(`sweep${sub}`, t);
				const s = { sess: cur.i, id: ++seq, lane: 'sweep', sub, name, stageKey: 'sweep', round: ni.round, t0: t, t1: null, w0: tk ? +tk[1] : undefined, w1: tk ? +tk[2] : undefined,
					threads: th ? +th[1] : 1, note };
				spans.push(s); openOn.set(`sweep${sub}`, s);
				continue;
			}
			const sw = openOn.get('stages');
			if (sw && sw.whole) close('stages', t);
			close('stages', t);
			const tk = /ticks (\d+)-(\d+)/.exec(note);
			const s = { sess: cur.i, id: ++seq, lane: 'stages', name, stageKey: /_loop/.test(name) ? 'loop' : /_seg/.test(name) ? 'seg' : ni.key, round: ni.round, t0: t, t1: null,
				w0: tk ? +tk[1] : undefined, w1: tk ? +tk[2] : undefined, threads: cur.W, note: note.replace(/ticks \d+-\d+(, )?/, '') };
			spans.push(s); openOn.set('stages', s);
		}
	}
	// the last session: running (the grind started before the upgrade) or stopped at its last line
	const last = sessions[sessions.length - 1];
	const running = !!ctx.running;
	if (cur) {
		if (running) {
			if (gFirst !== null) spans.push({ sess: cur.i, id: ++seq, lane: 'gpu', slot: 'gpu', name: 'GPU search', t0: gFirst, t1: null, threads: null, legacyGpu: true });
		} else { closeAll(prevT, true); gpuBand(); if (cur.end === null) cur.end = prevT; }
	}
	for (const s of spans) { dressSpan(s); if (s.legacyGpu) { s.key = 'gpu'; s.fam = 'tweak'; s.label = 'GPU search'; s.explain = D.STAGE.gpu.explain; s.detail = ''; } }
	// rounds: from the spans' names, ended by "round N done"
	const rmap = new Map();
	for (const s of spans) {
		if (!Number.isFinite(s.round) || s.lane === 'gpu') continue;
		const k = `${s.sess}:${s.round}`;
		const r = rmap.get(k) || { sess: s.sess, round: s.round, t0: s.t0, t1: null };
		r.t0 = Math.min(r.t0, s.t0);
		rmap.set(k, r);
	}
	for (const e of roundEnds) { const r = rmap.get(`${e.sess}:${e.round}`); if (r) { r.t1 = e.t; r.ended = true; } }
	const rounds = [...rmap.values()].sort((p, q) => p.t0 - q.t0);
	for (const r of rounds) if (!r.t1 && !(running && r.sess === last.i)) r.t1 = Math.max(r.t0, ...spans.filter((s) => s.sess === r.sess && s.round === r.round).map((s) => s.t1 || s.t0));
	const order = ctx.meta.timeDoors || spans.some((s) => /^phase/.test(s.name)) ? D.STAGES_PHASE : D.STAGES_ALL;
	const cursor = status.cursor || {};
	for (const r of rounds) { r.order = order; r.title = `Round ${r.round}`; }
	const lr = rounds[rounds.length - 1];
	const rctx = (r) => ({ open: running && r.sess === last.i, cursorStage: cursor.stage, cursorRound: cursor.round, flyK: spans.some((x) => x.lane === 'fly') ? 1 : 0 });
	if (lr) lr.recipe = recipe(lr, spans, skips, rctx(lr));
	const recipeOf = (no) => { const r = rounds.filter((x) => x.round === no).pop(); return r ? r.recipe || recipe(r, spans, skips, rctx(r)) : null; };
	const hist = Array.isArray(status.history) ? status.history.filter((h) => h && Number.isFinite(+h.t)) : [];
	const history = classifyHistory(hist, [], rounds, ctx.remote);
	// a find's lane: the span of that name (the latest one that started before it), else by what it is
	const marks = history.map((h) => {
		let sp = null;
		for (const s of spans) if (s.lane !== 'gpu' && s.name === h.what && s.t0 <= h.t + 1000) sp = s;
		return { t: h.t, lane: sp ? sp.lane : laneOfWhat(h.what), sub: sp ? sp.sub | 0 : 0, kind: 'best', runTicks: h.runTicks, saved: h.saved, fam: h.fam, key: h.key, label: h.label,
			explainOf: h.explainOf, what: h.what, round: h.round };
	});
	if (last && running) last.end = null;
	return { sessions: sessions.map((s) => ({ t0: s.t0, end: s.end, W: s.W, gpu: s.gpu, i: s.i })), spans, rounds: rounds.map(roundOut),
		marks, refused: refusedOf(dir), status, meta: ctx.meta, hist, history: history.map(stripHist), gpuOn: !!(last && last.gpu), paused: false, legacy: true, recipeOf };
}

// ---------------------------------------------------------------- a job that never ran: the first round's stages, a preview
function previewJob(dir, ctx, o) {
	const meta = ctx.meta;
	const order = meta.timeDoors ? D.STAGES_PHASE : D.STAGES_ALL;
	const now = o.now || Date.now();
	const orig = (meta.tas && meta.tas.runTicks) || null;
	const recipe1 = order.filter((k) => !OPT_IN.has(k) && !(k === 'phase' && !order.includes('phaseB')))
		.map((k) => { const c = recipeOf(k); return { key: k, dict: c.dict, label: c.label, fam: c.fam, explain: c.explain, state: 'next', why: '' }; });
	const m = { v: 1, kind: 'job', job: path.basename(dir), sig: o.sigNow, running: false, legacy: false, preview: true, range: o.range || 'session', t0: null, tNow: now, speed: null,
		lanes: [], spans: [], rounds: [{ round: 1, t0: null, t1: null, order, recipe: recipe1, title: 'Round 1' }], marks: [], best: orig ? [[now, orig, null]] : [], base: orig ? { runTicks: orig, time: fmt(orig), label: 'original' } : null,
		rangeFinds: 0, score: [], history: [] };
	m.now = nowJob(m, { open: false, hist: [], now });
	return m;
}

/**
 * GET /api/jobs/:id/phases: the timeline model of the job in `dir`. o: {range (session | 15m | 1h | 6h | all), sig (the
 * client's last: {unchanged: true} when nothing changed), running (the server's view: the grind runs), pid, live (live.json),
 * remote (the job's remote.json source), now}.
 */
function jobTimeline(dir, o) {
	o = o || {};
	const now = o.now || Date.now();
	const evF = path.join(dir, 'grind_events.jsonl'), gF = path.join(dir, 'gpu', 'events.jsonl');
	const status = C.readJSON(path.join(dir, 'status.json'), {}) || {};
	const hl = Array.isArray(status.history) ? status.history.length : 0;
	const range = Object.prototype.hasOwnProperty.call(RANGES, o.range) ? o.range : 'session';
	const sig = [sizeOf(rot(evF)) + sizeOf(evF), sizeOf(rot(gF)) + sizeOf(gF), hl, o.running ? 1 : 0, sizeOf(path.join(dir, 'inbox', 'results.jsonl')), range,
		status.state || '', status.stage || '', (status.cursor && status.cursor.stage) || '', o.running ? Math.floor(now / 20000) : sizeOf(path.join(dir, 'grind.log'))].join('-');
	if (o.sig && o.sig === sig) return { unchanged: true, sig };
	// (one model per state of the files: every open tab of the job, and every range of it, share the work; a running job's sig
	// moves on every 20 s, so a cached model's "ago" texts are at most that old)
	const mk = `${dir}|${sig}|${o.remote || ''}`;
	if (models.has(mk)) { const m = models.get(mk); models.delete(mk); models.set(mk, m); return m; }
	const meta = C.readJSON(path.join(dir, 'meta.json'), {}) || {};
	const ctx = { status, meta, running: !!o.running, pid: o.pid || status.pid || null, remote: o.remote || null, now };
	const oo = Object.assign({}, o, { range, now, sigNow: sig });
	// the built parts (b) by the files' state alone (not the range, not the clock): a range switch only assembles again
	const bk = [sizeOf(rot(evF)) + sizeOf(evF), sizeOf(rot(gF)) + sizeOf(gF), hl, o.running ? 1 : 0, sizeOf(path.join(dir, 'inbox', 'results.jsonl')),
		status.state || '', status.stage || '', (status.cursor && status.cursor.stage) || '', status.bestRunTicks || '', sizeOf(path.join(dir, 'grind.log')), o.remote || '', o.pid || ''].join('-');
	const hit = built.get(dir);
	let b = hit && hit.key === bk ? hit.b : undefined;
	if (b === undefined) {
		const evs = eventsOf(evF);
		if (evs.some((e) => e && e.ev === 'session')) b = fromEvents(dir, evs, eventsOf(gF), ctx);
		else b = legacyJob(dir, ctx);
		if (!b && Array.isArray(status.history) && status.history.length) {
			// (finds but no log: the history alone)
			const hist = status.history.filter((h) => h && Number.isFinite(+h.t));
			const history = classifyHistory(hist, [], [], ctx.remote);
			b = { sessions: [], spans: [], rounds: [], marks: history.map((h) => ({ t: h.t, lane: laneOfWhat(h.what), sub: 0, kind: 'best', runTicks: h.runTicks, saved: h.saved, fam: h.fam, key: h.key,
				label: h.label, what: h.what, round: null })), refused: refusedOf(dir), status, meta, hist, history: history.map(stripHist), legacy: false };   // (no optimizer run: nothing was rebuilt from a log)
		}
		built.delete(dir);
		built.set(dir, { key: bk, b: b || null });
		while (built.size > 24) built.delete(built.keys().next().value);
	}
	const model = b ? assemble(dir, b, oo) : previewJob(dir, ctx, oo);
	models.set(mk, model);
	while (models.size > 32) models.delete(models.keys().next().value);
	return model;
}
const built = new Map();    // dir -> {key, b}: the last built parts of a job, by its files' state
/** the recipe of any round of the job (the model carries only the last round's: tools, tests); o as jobTimeline's */
function roundRecipe(dir, round, o) {
	jobTimeline(dir, o);
	const h = built.get(dir);
	return h && h.b && typeof h.b.recipeOf === 'function' ? h.b.recipeOf(round) : null;
}
const models = new Map();   // dir|sig -> the model sent (the newest 32)

// ---------------------------------------------------------------- the level editor's Hybrid (best) (11.4)
/** the hybrid's now sentence (state: GET /api/editor/hybrid) */
function nowHybrid(state) {
	const s = state || {}, L = s.live || {}, c = L.compiler || {}, q = L.search || {};
	const el = mmss(s.elapsed || 0);
	const best = L.best || (s.result ? { runTicks: s.result.runTicks, by: s.result.by, t: s.result.t } : null);
	const by = (b) => ({ compiler: 'the compiler', search: 'Find a route', optimizer: 'the optimizer', prefix: 'the prefix search', joins: 'the joins' })[b] || b || '?';
	if (!s.running) {
		if (s.stage === 'none' || !s.stage) return 'No hybrid run yet.';
		if (s.result) {
			const r = s.result;
			return `${s.stage === 'stopped' ? 'Stopped' : 'Done'} after ${el}: the best route ${fmt(r.runTicks)} by ${by(r.by)}${r.t !== undefined && r.t !== null ? ` at ${mmss(r.t)}` : ''}` +
				`${r.first && r.first.runTicks !== r.runTicks ? ` (the first ${fmt(r.first.runTicks)} by ${by(r.first.by)} at ${mmss(r.first.t)})` : ''}.`;
		}
		return `${s.stage === 'stopped' ? 'Stopped' : 'Ended'} after ${el} without a route.${s.message ? ` ${s.message}` : ''}`;
	}
	if (L.first && best) {
		const left = s.polishS && L.first.t !== undefined ? Math.max(0, L.first.t + s.polishS - (L.t || s.elapsed || 0)) : null;
		return `${el} in. Route found by ${by(L.first.by)} at ${mmss(L.first.t)} (${fmt(L.first.runTicks)}); the best is ${fmt(best.runTicks)} by ${by(best.by)}.` +
			` ${L.ending ? 'Ending.' : `Polishing it${left !== null ? `: ${mmss(left)} left` : ''}.`}`;
	}
	const st = c.stage ? (D.HY_STAGES[nextHyStage(c.stage)] || c.stage) : '';
	const f = c.furthest;
	const comp = c.alive === false ? 'The compiler has ended' : `The compiler is ${st ? st.toLowerCase() : 'running'} (round ${(c.round || 0) + 1}: ${count(c.anchors || 0)} anchors` +
		`${f ? `, furthest ${f.desc || `gain ${f.gain}`}${f.dist !== null && f.dist !== undefined && +f.dist < 6000 ? `, ${(+f.dist).toFixed(1)} tiles to go` : ''}` : ''})`;
	const nr = q.nearest;
	const srch = q.state === undefined ? 'The search is starting' : `Find a route (run ${(q.run || 0) + 1}): ${nr ? `${(+nr.tiles).toFixed(1)} tiles from the trophy` : 'no attempt yet'}${q.rooms ? `, ${count(q.rooms)} rooms` : ''}`;
	const stuck = s.restartS ? ` No route yet; it starts fresh after ${mmss(s.restartS)} without progress${L.sinceProgress !== undefined && L.sinceProgress !== null ? ` (the last progress ${mmss(L.sinceProgress)} ago)` : ''}.` : ' No route yet.';
	return `${el} in. ${comp}. ${srch}.${stuck}`;
}
/** the stage the compiler is in after `last` ended (its stage events come at their ends) */
function nextHyStage(last) {
	const i = D.HY_ORDER.indexOf(last);
	return i >= 0 && i + 1 < D.HY_ORDER.length ? D.HY_ORDER[i + 1] : last;
}
/**
 * GET /api/editor/hybrid `timeline`: the hybrid's run as a timeline model (kind 'hybrid'): lanes Compiler (its stages, its
 * rounds), Search (a block per run: Find a route, then Optimizing), Prefix search, Optimizer (the polish from the first route
 * on); every verified route a diamond on the lane of its part (gold: a new best), the best route's steps, the restarts.
 */
function hybridTimeline(state, o) {
	const s = state || {};
	if (!s.started || !s.live) return null;
	const L = s.live, c = L.compiler || {}, q = L.search || {};
	const T0 = +s.started, at = (sec) => T0 + Math.round((+sec || 0) * 1000);
	const tNow = s.running ? ((o && o.now) || Date.now()) : T0 + Math.round((+s.elapsed || +L.t || 0) * 1000);
	const tEnd = (sec) => Math.min(tNow, at(sec));
	const spans = [];
	let id = 0;
	const part = (k) => D.HY_PARTS[k];
	const block = (lane, t0, t1, label, extra) => {
		if (!(t1 === null || t1 > t0)) return;
		const p = part(lane);
		spans.push(Object.assign({ id: ++id, lane, sub: 0, key: lane, fam: p.fam, label, explain: p.explain, detail: '', t0, t1, threads: null, n: 1 }, extra || {}));
	};
	// the compiler: its stages ([t, name, ms, round] at their ends), the stage under way open; its rounds
	const stages = Array.isArray(c.stages) ? c.stages : [];
	const cRounds = Array.isArray(c.rounds) && c.rounds.length ? c.rounds : [[0, 0]];
	let lastEnd = 0;
	for (const st of stages) {
		const t1 = at(st[0]), t0 = Math.max(T0, t1 - (+st[2] || 0));
		block('compiler', t0, t1, D.HY_STAGES[st[1]] || String(st[1]), { name: String(st[1]), round: (st[3] || 0) + 1, detail: `round ${(st[3] || 0) + 1}` });
		lastEnd = Math.max(lastEnd, +st[0] || 0);
	}
	const roundStart = +(cRounds[cRounds.length - 1][0] || 0);
	if (c.alive !== false && s.running) {
		const from = Math.max(lastEnd, roundStart);
		const lastName = stages.length && (+stages[stages.length - 1][0] || 0) >= roundStart ? stages[stages.length - 1][1] : null;
		const nm = lastName ? nextHyStage(lastName) : (stages.length ? 'parse' : null);
		block('compiler', at(from), null, nm ? (D.HY_STAGES[nm] || nm) : 'Compiler', { name: nm || 'compiler', round: (c.round || 0) + 1, detail: `round ${(c.round || 0) + 1}` });
	} else if (!stages.length) block('compiler', T0, c.alive === false && c.endAt ? at(c.endAt) : tNow, 'Compiler', {});
	// the search: a block per run (the start and every restart), split where its state turns to optimizing
	const restarts = (L.restarts || []).map((r) => ({ n: r.n, t: at(r.t), why: r.why || '', sec: r.t }));
	const runStarts = [0].concat(restarts.map((r) => r.sec));
	const states = Array.isArray(q.states) ? q.states : [];
	for (let i = 0; i < runStarts.length; i++) {
		const a = at(runStarts[i]);
		// (a state of this run: by its run number when it has one (an "ended" at the restart's own second is the run before's)
		const inRun = (x) => (x[2] !== undefined ? +x[2] === i : +x[0] >= runStarts[i] && (i + 1 >= runStarts.length || +x[0] < runStarts[i + 1]));
		const ended = states.find((x) => (x[1] === 'ended' || x[1] === 'done') && inRun(x));
		const b = i + 1 < runStarts.length ? at(runStarts[i + 1]) : ended ? tEnd(ended[0]) : (s.running ? null : tNow);
		const opt = states.find((x) => x[1] === 'optimizing' && inRun(x));
		const runN = i + 1;
		if (opt) { block('search', a, at(opt[0]), 'Find a route', { name: `run ${runN}`, detail: `run ${runN}` }); block('search', at(opt[0]), b, 'Optimizing', { name: `run ${runN}`, detail: `run ${runN}: the optimizer on its route` }); }
		else block('search', a, b, 'Find a route', { name: `run ${runN}`, detail: `run ${runN}${q.seed && i === runStarts.length - 1 ? `, seed ${q.seed}` : ''}` });
	}
	// the prefix searches (from the compiler's furthest point)
	for (const p of Array.isArray(L.prefixes) ? L.prefixes : []) block('prefix', at(p.t), p.end !== null && p.end !== undefined ? tEnd(p.end) : (s.running ? null : tNow), 'Prefix search', { name: `prefix ${p.k}`, detail: p.why || '' });
	// the polish (from the first route on)
	if (L.first) block('optimizer', at(L.first.t), s.running ? null : tNow, 'Polish', { name: 'polish', detail: 'the optimizer, the compiler\'s polish, the joins' });
	// the routes: a diamond each (on its part's lane), the best route's steps
	const laneOfBy = (b) => (b === 'compiler' ? 'compiler' : b === 'prefix' ? 'prefix' : b === 'optimizer' || b === 'joins' ? 'optimizer' : 'search');
	const routes = (L.routes || []).filter((r) => Number.isFinite(+r.runTicks)).sort((p, x) => p.t - x.t);
	const marks = [], best = [];
	let bestRT = Infinity;
	const score = new Map();
	for (const r of routes) {
		const lane = laneOfBy(r.by);
		const p = part(lane);
		const isBest = r.runTicks < bestRT;
		const saved = isBest && bestRT < Infinity ? bestRT - r.runTicks : 0;
		marks.push({ t: at(r.t), lane, sub: 0, kind: 'route', best: isBest, runTicks: r.runTicks, saved, fam: p.fam, key: lane, label: `${p.label}: ${r.how || 'a route'}`, how: r.how || '', what: r.by, at: mmss(r.t) });
		const sc = score.get(lane) || { routes: 0, saved: 0 };
		sc.routes++; sc.saved += saved;
		score.set(lane, sc);
		if (isBest) { best.push([at(r.t), r.runTicks, p.fam, `${p.label} at ${mmss(r.t)}`]); bestRT = r.runTicks; }
	}
	const used = new Set(spans.map((x) => x.lane).concat(marks.map((m) => m.lane)));
	const lanes = ['compiler', 'search', 'prefix', 'optimizer'].filter((k) => used.has(k)).map((k) => ({ id: k, label: part(k).label, fam: part(k).fam, explain: part(k).explain, subs: 1 }));
	const scoreRows = lanes.map((l) => {
		const ms = spans.filter((x) => x.lane === l.id).reduce((a, x) => a + Math.max(0, (x.t1 || tNow) - x.t0), 0);
		const sc = score.get(l.id) || { routes: 0, saved: 0 };
		return { key: l.id, fam: l.fam, label: l.label, explain: l.explain, ms, runs: spans.filter((x) => x.lane === l.id).length, finds: sc.routes, saved: sc.saved };
	});
	// the compiler's stage chips (its current round): done, now, to come
	const cr = (c.round || 0);
	const seen = new Set(stages.filter((x) => (x[3] || 0) === cr).map((x) => x[1]));
	const cur = s.running && c.alive !== false ? (seen.size ? nextHyStage([...stages].reverse().find((x) => (x[3] || 0) === cr)[1]) : 'parse') : null;
	const chips = D.HY_ORDER.map((k) => ({ key: k, label: D.HY_STAGES[k], fam: 'explore', explain: '', state: seen.has(k) ? 'done' : k === cur ? 'now' : s.running && c.alive !== false ? 'next' : 'skipped', why: seen.has(k) || s.running ? '' : 'did not run' }));
	const rounds = cRounds.slice(1).map((r) => ({ round: (+r[1] || 0) + 1, t0: at(r[0]), t1: null, tag: `C${(+r[1] || 0) + 1}` }));
	rounds.push({ round: cr + 1, t0: null, t1: null, recipe: chips, title: `Compiler${cr ? ` round ${cr + 1}` : ''}` });
	return {
		v: 1, kind: 'hybrid', running: !!s.running, legacy: false, preview: false, t0: T0, tNow, lanes, spans, rounds, marks, best, restarts,
		base: null, rangeFinds: best.length, score: scoreRows, history: [], speed: null,
		now: { text: nowHybrid(s), round: cr + 1, key: c.stage || null },
	};
}

module.exports = { jobTimeline, roundRecipe, hybridTimeline, nowJob, nowHybrid, legacyJob, classify, classifySlot, FAMS: D.FAMS, STAGES: D.STAGES, RANGES, readJsonl, dict: D };
