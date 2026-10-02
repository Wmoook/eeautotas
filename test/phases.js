'use strict';
// The Optimizer view's data and drawing (docs/ui/DESIGN.md sections 9 and 11), synthetic data only (no job, level or run of
// anyone's; ~2 s without --grind):
//   dict    the phase dictionary: every row of 11.2 classified from the real name / `what` formats, the GPU slots, the recipe
//   events  src/events.js: t added, appended lines, the rotation to <name>.1.jsonl with the session line again (cont), off
//           (EEAT_EVENTS=0), a write that cannot happen is silent
//   model   src/phases.js jobTimeline on a synthetic grind_events.jsonl + gpu/events.jsonl: the spans and their lanes (the
//           sweep's sub-rows), open spans while it runs, the marks on the lane of the span that found them, the GPU's finds by
//           the family of their largest credit, the score's CPU shares (threads / W) and the sweep's whole span counting 0,
//           the range cut, the GPU merge and the 2,000-span cap, sig -> unchanged, the recipe's chips, the now sentences
//           (running / paused / never started), refused hand-ins, rotated files read too
//   legacy  a synthetic grind.log: the session, the stage spans, the sweep's lanes, round lines, a day's rollover, [try] lines
//           out of the session, the legacy flag
//   hybrid  hybridTimeline on a hybrid state (the compiler's stages and rounds, the search's runs and states, the prefix
//           searches, the routes, the restarts) and its now sentences
//   view    src/app/phases.js loaded with a minimal window: TL.html on the models above (a block per span, labels only where
//           they fit, the playhead while it runs, diamonds on their lanes, the legend, the scoreboard, the guide; the compact
//           view: no labels in blocks, "Open the full view"); TL.classify
//   server  GET /api/jobs/:id/phases through the app's server (a temp EEAT_HOME): the model, ?sig= -> unchanged, an unknown
//           job 404; GET /api/editor/hybrid with no hybrid: no timeline
//   grind   (--grind or --only=grind; spawns the grind: ~1 min) the grind's results byte for byte the same with and
//           without its events (EEAT_EVENTS=0): two arms on a toy level until the first round's input tweaks are done: the
//           same history, best runs, stage outputs and log lines; the events arm's file has the session, the round, a span
//           per mutate pass and a best event per find (the same t as its history entry), and its timeline puts every find
//           on the mutate spans' lane. In steps (no test process beside the grinds): --grind-prep=<home> (the toy jobs, their
//           grind command lines), run both arms from a shell until "endgame1" shows in their grind.log (timeout 60 is
//           plenty), then --grind-compare=<dirA (EEAT_EVENTS=0)>,<dirB>
// usage: node test/phases.js [--only=dict,events,model,legacy,hybrid,view,server,grind] [--grind]
//        node test/phases.js --grind-prep=<home> | --grind-compare=<dirA>,<dirB>
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
// (--grind-prep=<home>: the toy jobs there, kept; else a temp home, removed at the end)
const PREP = (args.find((a) => a.startsWith('--grind-prep=')) || '').slice(13);
const HOME = PREP ? path.resolve(PREP) : fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-phases-'));
if (PREP) fs.mkdirSync(HOME, { recursive: true });
process.env.EEAT_HOME = HOME;
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const COMPARE = args.some((a) => a.startsWith('--grind-compare='));
const want = (k) => (PREP || COMPARE ? false : only.length ? only.includes(k) : k !== 'grind' || args.includes('--grind'));

const C = require('../src/common.js');
const EVT = require('../src/events.js');
const PH = require('../src/phases.js');
const D = require('../src/app/phases.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `: ${detail}` : ''}`); };
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const sec = (s) => T0 + s * 1000;
const writeLines = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

// ================================================================ dict
if (want('dict')) {
	console.log('dict');
	const cases = [
		['mutate_3a_1', 'mut', 'tweak'], ['mutate_12c_4b', 'mut', 'tweak'], ['skipfind2', 'skipf', 'path'], ['endgame4', 'endgame', 'finish'],
		['sweep3', 'sweep', 'explore'], ['sweep3_4', 'sweep', 'explore'], ['sweep3_4p', 'sweep', 'explore'], ['sweep3_4 (time doors)', 'sweep', 'explore'],
		['sweep3_4 (coin-blind, replayed)', 'sweep', 'explore'], ['deep3_loop2', 'loop', 'explore'], ['deep3_seg2.1', 'seg', 'explore'], ['skips3', 'skips', 'path'],
		['flybeam2', 'flyb', 'local'], ['flybeam lane 4', 'flyb', 'local'], ['shortcuts5', 'sc', 'local'], ['phase3', 'phase', 'finish'], ['phaseb3', 'phase', 'finish'],
		['beam4', 'beam', 'local'], ['splice', 'splice', 'combine'], ['sweep3_4 + best (splice, 2 switches)', 'splice', 'combine'],
		['3 earlier runs (stage outputs, pieces/) + best (splice, 1 switch)', 'splice', 'combine'], ['recover', 'splice', 'combine'],
		['inbox (gpu (12 shortcuts))', 'gpu', 'tweak'], ['try: gpu (3 shortcuts)', 'gpu', 'tweak'], ['inbox (gpu (12 shortcuts)) + best (splice, 1 switch)', 'splice', 'combine'],
		['inbox (focus 1:10.00-1:14.00)', 'focus', 'explore'], ['try: focus 0:10-0:20', 'focus', 'explore'], ['inbox (Find a route (one search))', 'fr', 'outside'],
		['try: Find a route', 'fr', 'outside'], ['inbox (hybrid: compiler (trophy))', 'hybrid', 'outside'], ['try: h100 farm', 'remote', 'outside'],
		['try: endgame solver', 'endgame', 'finish'], ['inbox (endgame solver)', 'endgame', 'finish'], ['inbox (probe 1:10.40)', 'in', 'outside'], ['try: api', 'in', 'outside'],
		['phase fixpoint', 'other', 'combine'],
	];
	const bad = cases.filter(([s, k, f]) => { const c = D.classify(s); return c.key !== k || c.fam !== f || !c.label; }).map(([s, k]) => `${s} -> ${D.classify(s).key} (want ${k})`);
	check(`every row of the dictionary (11.2) from its names and whats (${cases.length} cases)`, !bad.length, bad.join('; '));
	const slots = [['m1', 'gpu-m1'], ['m1+del', 'gpu-m1'], ['del', 'gpu-del'], ['m2', 'gpu-m2'], ['pert', 'gpu-rand'], ['flip', 'gpu-rand'], ['sticky', 'gpu-rand'], ['every', 'gpu-every'], ['idle', 'gpu-idle'], ['zzz', 'gpu']];
	const bs = slots.filter(([f, k]) => D.classify(f, { slot: true }).key !== k);
	check('the GPU slots (m1, del, m2, pert / flip / sticky, every, idle) and their families', !bs.length && D.classifySlot('every').fam === 'explore' && D.classifySlot('idle').fam === 'finish', JSON.stringify(bs));
	const g = D.classify('inbox (gpu (4 shortcuts))', { gpuFam: 'every' });
	check('a GPU find by the family of its largest credit (every move: Route explore)', g.key === 'gpu' && g.fam === 'explore' && g.label === 'GPU: every move', JSON.stringify(g));
	check('a run from the job\'s rented machine (its remote.json source) is "Rented machine"', D.classify('try: h100', { remote: 'h100' }).key === 'remote' && D.classify('try: h100').key === 'in');
	check('the recipe keys (grind.js STAGES_ALL / STAGES_PHASE) all have a label and a family', D.STAGES_PHASE.concat(D.STAGES_ALL).every((k) => D.recipeOf(k).label && D.FAM[D.recipeOf(k).fam]) &&
		D.recipeOf('deep').label === 'Route sweep' && D.recipeOf('mutB').label === 'Input tweaks' && D.recipeOf('phaseB').fam === 'finish');
	check('the families have their colour variables', D.FAMS.length === 7 && D.FAMS.every((f) => D.colorOf(f.fam) === `var(--ph-${f.fam})`) && D.colorOf('nope') === 'var(--ph-combine)');
	check('formats: m:ss.cc, durations, counts, m:ss', D.fmt(4100) === '0:41.00' && D.fmt(-54) === '−0:00.54' && D.dur(45e3) === '45 s' && D.dur(241e3) === '4 min 01 s' && D.dur(3 * 3600e3 + 5 * 60e3) === '3 h 05 min' &&
		D.count(4812) === '4,812' && D.mmss(3725) === '1:02:05');
}

// ================================================================ events
if (want('events')) {
	console.log('events');
	const dir = path.join(HOME, 'ev');
	fs.mkdirSync(dir, { recursive: true });
	const f = path.join(dir, 'x.jsonl');
	const w = EVT.open(f, { maxBytes: 600, head: () => ({ ev: 'session', v: 1, pid: 7 }) });
	w.ev({ ev: 'session', v: 1, pid: 7 });
	for (let i = 0; i < 12; i++) w.ev({ ev: 'stage', id: i, name: `mutate_1a_${i}`, note: 'x'.repeat(20) });
	const cur = EVT.readAll(f);
	const curOnly = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	check('lines get a t, the file rotates past maxBytes to <name>.1.jsonl (one kept), the new file starts with the session line again (cont: true)',
		fs.existsSync(path.join(dir, 'x.1.jsonl')) && curOnly[0].ev === 'session' && curOnly[0].cont === true && cur.every((e) => Number.isFinite(e.t)) &&
		cur.filter((e) => e.ev === 'stage').length >= 4 && fs.statSync(f).size <= 600, `${cur.length} lines, first of the current file ${JSON.stringify(curOnly[0])}`);
	check('rotatedName', EVT.rotatedName('/a/grind_events.jsonl') === '/a/grind_events.1.jsonl' && EVT.rotatedName('/a/events') === '/a/events.1');
	const off = EVT.open(path.join(dir, 'off.jsonl'), { off: true });
	const was = process.env.EEAT_EVENTS;
	process.env.EEAT_EVENTS = '0';
	const off2 = EVT.open(path.join(dir, 'off2.jsonl'));
	if (was === undefined) delete process.env.EEAT_EVENTS; else process.env.EEAT_EVENTS = was;
	check('off (and EEAT_EVENTS=0): nothing written', off.ev({ ev: 'x' }) === false && off2.ev({ ev: 'x' }) === false && !fs.existsSync(path.join(dir, 'off.jsonl')) && !fs.existsSync(path.join(dir, 'off2.jsonl')));
	let threw = false, r = null;
	try { r = EVT.open(path.join(dir, 'no', 'such', 'dir', 'e.jsonl')).ev({ ev: 'x' }); } catch (e) { threw = true; }
	check('a write that cannot happen (no folder) is silent: false, no throw', !threw && r === false);
	// incremental reading: a line half written is not read until it is whole
	const g = path.join(dir, 'inc.jsonl');
	fs.writeFileSync(g, '{"ev":"a","t":1}\n{"ev":"b"');
	const n1 = PH.readJsonl(g).length;
	fs.appendFileSync(g, ',"t":2}\n{"ev":"c","t":3}\n');
	const all = PH.readJsonl(g);
	check('phases.js reads a file incrementally: a half-written line waits until it is whole', n1 === 1 && all.length === 3 && all[1].ev === 'b' && all[2].ev === 'c', `${n1} then ${all.length}`);
}

// ================================================================ a synthetic job with events
/** a job folder: meta, status (history), grind_events.jsonl, gpu/events.jsonl, inbox/results.jsonl */
function mkJob(id, o) {
	const dir = path.join(HOME, 'jobs', id);
	fs.mkdirSync(path.join(dir, 'gpu'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
	C.writeJSON(path.join(dir, 'meta.json'), { name: id, created: sec(-3600), tas: { runTicks: 10000 }, level: { name: id, width: 50, height: 50 }, timeDoors: false });
	C.writeJSON(path.join(dir, 'status.json'), Object.assign({ state: o.running ? 'running' : 'stopped', pid: o.running ? 4242 : 0, bestRunTicks: 9300, history: o.history || [], cursor: o.cursor || {} }, o.status || {}));
	if (o.events) writeLines(path.join(dir, 'grind_events.jsonl'), o.events);
	if (o.gpu) writeLines(path.join(dir, 'gpu', 'events.jsonl'), o.gpu);
	if (o.results) writeLines(path.join(dir, 'inbox', 'results.jsonl'), o.results);
	if (o.log) fs.writeFileSync(path.join(dir, 'grind.log'), o.log);
	return dir;
}
// one session (W 8): round 1 = mutA (2 passes), endgame, the sweep (whole span + 4 lanes of 2 threads), a loop window; round 2
// starts with mutA, then the sweep runs (open); the GPU: search slots and every-move windows, a find credited to pert and m1
const ses = { t: sec(0), ev: 'session', v: 1, pid: 4242, workers: 8, flyK: 1, gpu: true, roundMin: 10, best: 10000, orig: 10000, phaseOrder: false };
const EVS = [ses,
	{ t: sec(0), ev: 'stage', id: 1, lane: 'fly', key: 'fly', name: 'flybeam lane 1', round: 0, threads: 1, note: '600 s on 1:40.00' },
	{ t: sec(1), ev: 'round', round: 1, order: D.STAGES_ALL, resume: null },
	{ t: sec(1), ev: 'stage', id: 2, lane: 'stages', key: 'mutA', name: 'mutate_1a_1', round: 1, threads: 8, of: 10000 },
	{ t: sec(31), ev: 'stageEnd', id: 2, code: 0, killed: false, grown: false, ticks: 5e7 },
	{ t: sec(32), ev: 'best', runTicks: 9900, saved: 100, what: 'mutate_1a_1', span: 2, source: 'stage' },
	{ t: sec(33), ev: 'stage', id: 3, lane: 'stages', key: 'mutA', name: 'mutate_1a_2', round: 1, threads: 8, w0: 100, w1: 2000 },
	{ t: sec(50), ev: 'stageEnd', id: 3, code: 0, ticks: 1e7 },
	{ t: sec(51), ev: 'skip', round: 1, key: 'beam', name: 'beam1', why: 'test skip' },
	{ t: sec(52), ev: 'stage', id: 4, lane: 'stages', key: 'endgame', name: 'endgame1', round: 1, threads: 8, note: 'the last ticks, every input' },
	{ t: sec(80), ev: 'stageEnd', id: 4, code: 0 },
	{ t: sec(81), ev: 'stage', id: 5, lane: 'stages', key: 'deep', name: 'sweep1', round: 1, threads: 8, whole: true, lanes: 4, windows: 16, note: 'every window' },
	...[0, 1, 2, 3].map((k) => ({ t: sec(82), ev: 'stage', id: 6 + k, lane: 'sweep', sub: k, key: 'sweep', name: `sweep1_${k + 1}`, round: 1, threads: 2, w0: 600 * k, w1: 600 * k + 800, note: 'hunt window, new' })),
	...[0, 1, 2, 3].map((k) => ({ t: sec(202), ev: 'stageEnd', id: 6 + k, code: 0 })),
	{ t: sec(202), ev: 'stageResult', id: 6, saved: 54 }, { t: sec(202), ev: 'stageResult', id: 7, saved: 0 },
	{ t: sec(203), ev: 'best', runTicks: 9846, saved: 54, what: 'sweep1_1', span: 6, source: 'stage' },
	{ t: sec(205), ev: 'stageEnd', id: 5, code: 0, windows: 4, found: 1, covered: true },
	{ t: sec(206), ev: 'stage', id: 10, lane: 'stages', key: 'loop', name: 'deep1_loop1', round: 1, threads: 8, w0: 3000, w1: 3400 },
	{ t: sec(326), ev: 'stageEnd', id: 10, code: 0 }, { t: sec(326), ev: 'stageResult', id: 10, saved: 0 },
	{ t: sec(600), ev: 'roundEnd', round: 1, ms: 599000, best: 9846 },
	{ t: sec(601), ev: 'round', round: 2, order: D.STAGES_ALL, resume: null },
	{ t: sec(601), ev: 'stage', id: 11, lane: 'stages', key: 'mutA', name: 'mutate_2a_1', round: 2, threads: 8 },
	{ t: sec(611), ev: 'stageEnd', id: 11, code: 0 },
	{ t: sec(612), ev: 'stage', id: 12, lane: 'stages', key: 'deep', name: 'sweep2', round: 2, threads: 8, whole: true, lanes: 4, windows: 16 },
	{ t: sec(612), ev: 'stage', id: 13, lane: 'sweep', sub: 0, key: 'sweep', name: 'sweep2_1', round: 2, threads: 2, w0: 1800, w1: 2600 },
	{ t: sec(612), ev: 'stage', id: 14, lane: 'sweep', sub: 1, key: 'sweep', name: 'sweep2_2', round: 2, threads: 2, w0: 2400, w1: 3200 },
];
const GEVS = [
	{ t: sec(1), ev: 'gpuStart', v: 1, pid: 4243, name: 'Test GPU', ticksPerSec: 1e8, coinMode: 'aware' },
	{ t: sec(2), ev: 'slot', id: 1, round: 1, arm: 'search', fam: 'm1+del', w0: 0, w1: 512 }, { t: sec(12), ev: 'slotEnd', id: 1, s: 10, ticks: 1e9, added: 4 },
	{ t: sec(12), ev: 'slot', id: 2, round: 1, arm: 'search', fam: 'pert', w0: 0, w1: 10000 }, { t: sec(32), ev: 'slotEnd', id: 2, s: 20, ticks: 2e9, added: 40 },
	{ t: sec(100), ev: 'find', from: 9900, to: 9870, saved: 30, fams: { pert: -20, m1: -6 }, other: 4, handed: 'inbox', accepted: false },
	{ t: sec(102), ev: 'slot', id: 3, round: 3, arm: 'every', fam: 'every', w0: 300, w1: 620 },
];
const HIST = [
	{ t: sec(32), runTicks: 9900, saved: 100, what: 'mutate_1a_1' },
	{ t: sec(101), runTicks: 9870, saved: 30, what: 'inbox (gpu (5 shortcuts))' },
	{ t: sec(203), runTicks: 9846, saved: 24, what: 'sweep1_1' },
	{ t: sec(400), runTicks: 9800, saved: 46, what: 'try: Find a route' },
];
let jobRun = null, mRun = null;
if (want('model') || want('view') || want('server')) {
	jobRun = mkJob('ev-running', { running: true, events: EVS, gpu: GEVS, history: HIST, cursor: { round: 2, stage: 'deep' },
		results: [{ file: 'a.eetas', source: 'probe 0:40', t: sec(300), accepted: false, runTicks: 9950, reason: 'not faster' }, { file: 'b.eetas', source: 'gpu (3 shortcuts)', t: sec(301), accepted: false }] });
	mRun = PH.jobTimeline(jobRun, { range: 'session', running: true, pid: 4242, now: sec(700), live: { cpu: { ticksPerSec: 13.1e6, threads: 8 }, gpu: { ticksPerSec: 384e6, name: 'Test GPU' } } });
}
if (want('model')) {
	console.log('model (events)');
	const m = mRun;
	const by = (n) => m.spans.find((s) => s.name === n);
	check('the model: v 1, kind job, running, not legacy, the session range from its start to now', m.v === 1 && m.kind === 'job' && m.running && !m.legacy && m.t0 === sec(0) && m.tNow === sec(700), `${m.t0} ${m.tNow}`);
	check('the lanes: Stages, Sweep (4 sub-rows), Corridor beam, GPU, Handed in, in that order', m.lanes.map((l) => l.id).join() === 'stages,sweep,fly,gpu,in' && m.lanes[1].subs === 4,
		m.lanes.map((l) => `${l.id}${l.subs || ''}`).join());
	check('a span per stage run: mutate (its window), the endgame, the sweep\'s whole span on the stages lane, its windows on the sweep lane\'s rows, the loop window',
		by('mutate_1a_2').w0 === 100 && by('mutate_1a_2').key === 'mut' && by('endgame1').fam === 'finish' && by('sweep1').lane === 'stages' && by('sweep1').whole &&
		by('sweep1_3').lane === 'sweep' && by('sweep1_3').sub === 2 && by('deep1_loop1').key === 'loop' && by('sweep1_1').saved === 54 && by('sweep1_2').saved === 0,
		JSON.stringify(by('sweep1_3')));
	check('open spans while it runs (t1 null): the sweep of round 2, its two windows, the corridor-beam lane, the GPU\'s every-move window',
		!by('sweep2').t1 && !by('sweep2_1').t1 && !by('flybeam lane 1').t1 && m.spans.some((s) => s.lane === 'gpu' && s.key === 'gpu-every' && !s.t1));
	check('a span\'s plain detail: "every input of ticks 100–2,000", "window ticks 0–800"', by('mutate_1a_2').detail === 'every input of ticks 100–2,000' && by('sweep1_1').detail === 'window ticks 0–800',
		`${by('mutate_1a_2').detail} | ${by('sweep1_1').detail}`);
	const mk = (t) => m.marks.find((x) => x.t === t);
	check('the finds on the lane of the span that found them (mutate: Stages, a sweep window: its Sweep row), the GPU\'s on GPU, a try on Handed in',
		mk(sec(32)).lane === 'stages' && mk(sec(203)).lane === 'sweep' && mk(sec(203)).sub === 0 && mk(sec(101)).lane === 'gpu' && mk(sec(400)).lane === 'in',
		m.marks.map((x) => `${x.lane}${x.sub}`).join());
	check('the GPU\'s find classified by its find event: the family of its largest credit (pert: GPU: random variations)', mk(sec(101)).key === 'gpu' && mk(sec(101)).label === 'GPU: random variations', JSON.stringify(mk(sec(101))));
	check('a hand-in that was not accepted: a refused mark on Handed in (the GPU\'s own refused runs left out)', m.marks.filter((x) => x.kind === 'refused').length === 1 && m.marks.find((x) => x.kind === 'refused').lane === 'in');
	check('the best steps: the original at the range\'s start, then every find (with its family)', m.best.length === 5 && m.best[0][1] === 10000 && m.best[1][1] === 9900 && m.best[1][2] === 'tweak' && m.best[4][1] === 9800 && m.rangeFinds === 4,
		JSON.stringify(m.best.map((p) => p.slice(0, 3))));
	const sc = (k) => m.score.find((x) => x.key === k) || {};
	check('the score: the sweep windows count their threads\' share of W (4 x 120 s x 2/8 = 120 s), the sweep\'s whole span counts 0',
		Math.abs(sc('sweep').ms - (4 * 120e3 * 2 / 8 + 2 * 88e3 * 2 / 8)) < 2 && sc('sweep').runs === 6 && sc('sweep').finds === 1 && sc('sweep').saved === 24, JSON.stringify(sc('sweep')));
	check('the score: the GPU find split over its families by their credit (pert 20, m1 6, the combine with other runs 4 of 30)',
		sc('gpu-rand').saved === 20 && sc('gpu-m1').saved === 6 && sc('splice').saved === 4 && sc('gpu-rand').finds === 1 && sc('gpu-m1').finds === 0, JSON.stringify(m.score.map((x) => [x.key, x.saved, x.finds])));
	check('the score: the GPU slots their plain time (m1+del 10 s, pert 20 s, every move open to now)', sc('gpu-m1').ms === 10e3 && sc('gpu-rand').ms === 20e3 && sc('gpu-every').ms === sec(700) - sec(102), JSON.stringify([sc('gpu-m1').ms, sc('gpu-every').ms]));
	const r2 = m.rounds[m.rounds.length - 1];
	const st = (k) => (r2.recipe.find((c) => c.key === k) || {}).state;
	check('the recipe of the round under way: mutA done, endgame passed (skipped), deep now (the cursor and the open sweep), the rest to come; no chip for the opt-in skip finder and corridor-beam stage that never ran here, nor for the time-door pass of the plain order',
		r2.round === 2 && st('mutA') === 'done' && st('skipfA') === undefined && st('flyb') === undefined && st('phase') === undefined && st('endgame') === 'skipped' && st('deep') === 'now' && st('skips') === 'next' && st('splice') === 'next',
		r2.recipe.map((c) => `${c.key}:${c.state}`).join(' '));
	const r1 = m.rounds.find((r) => r.round === 1);
	check('a round that ended: its skip event\'s why, its passed stages skipped (never "to come")', r1.recipe.find((c) => c.key === 'beam').why === 'test skip' && !r1.recipe.some((c) => c.state === 'next') &&
		r1.recipe.find((c) => c.key === 'deep').state === 'done' && r1.recipe.find((c) => c.key === 'beam').state === 'skipped');
	check('the now sentence while it runs: the round, the sweep\'s windows at once and its lanes, what the GPU does, the last find',
		/^Round 2: Route sweep, exploring ticks 1,800–2,600, 2,400–3,200 at once on 2 lanes \(16 windows in the run\)\. The GPU tries every move in short windows\. Last find 5 min 00 s ago: −46 ticks by Find a route\.$/.test(m.now.text),
		m.now.text);
	check('the speed (live.json: CPU and GPU ticks per second, the threads, the GPU\'s name)', m.speed && m.speed.cpu === 13.1e6 && m.speed.gpu === 384e6 && m.speed.gpuName === 'Test GPU');
	check('every history entry classified, with its round', m.history.length === 4 && m.history[0].round === 1 && m.history[2].round === 1 && m.history[3].key === 'fr', JSON.stringify(m.history.map((h) => [h.key, h.round])));
	// sig
	const again = PH.jobTimeline(jobRun, { range: 'session', running: true, pid: 4242, now: sec(705), sig: m.sig });
	const later = PH.jobTimeline(jobRun, { range: 'session', running: true, pid: 4242, now: sec(725), sig: m.sig });
	fs.appendFileSync(path.join(jobRun, 'grind_events.jsonl'), JSON.stringify({ t: sec(706), ev: 'beat' }) + '\n');
	const grown = PH.jobTimeline(jobRun, { range: 'session', running: true, pid: 4242, now: sec(706), sig: m.sig });
	check('sig: the same files and the same 20-s bucket -> {unchanged: true}; a new line or the next bucket -> a new model', again.unchanged === true && !later.unchanged && !grown.unchanged && grown.v === 1);
	// the range cut, stopped
	const m15 = PH.jobTimeline(jobRun, { range: '15m', running: true, pid: 4242, now: sec(1500) });
	check('the 15-min range: spans and marks from now - 15 min (the first round\'s gone; the best at the range\'s start its first point)',
		m15.t0 === sec(600) && !m15.spans.some((s) => s.name === 'mutate_1a_1') && m15.best[0][1] === 9800 && m15.marks.every((x) => x.t >= sec(600) - 1000), `${m15.t0} ${m15.best[0]}`);
	const stopped = PH.jobTimeline(jobRun, { range: 'session', running: false, now: sec(5000) });
	// (the session's last line: the beat at 706 s appended above)
	check('stopped: no open span (they end at the session\'s last line, killed), not running, the paused sentence', !stopped.running && stopped.spans.every((s) => s.t1) &&
		/^Paused\. The last session ran 12 min and found 200 ticks; the best is 1:33\.00\.$/.test(stopped.now.text), stopped.now.text);
	// the cap; the GPU merge
	const many = [ses, { t: sec(1), ev: 'round', round: 1, order: D.STAGES_ALL }];
	for (let i = 0; i < 2500; i++) many.push({ t: sec(2 + i), ev: 'stage', id: 100 + i, lane: 'stages', key: 'mutA', name: `mutate_1a_${i}`, round: 1, threads: 8 }, { t: sec(2.5 + i), ev: 'stageEnd', id: 100 + i, code: 0 });
	const mm = PH.jobTimeline(mkJob('ev-many', { events: many, history: [] }), { range: 'all', running: false, now: sec(3000) });
	check('at most 2,000 spans: the newest', mm.spans.length === 2000 && mm.spans[mm.spans.length - 1].name === 'mutate_1a_2499' && mm.spans[0].name === 'mutate_1a_500', `${mm.spans.length} spans`);
	const gm = [{ t: sec(1), ev: 'gpuStart', v: 1, name: 'g' }];
	for (let i = 0; i < 600; i++) gm.push({ t: sec(2 + 0.5 * i), ev: 'slot', id: i + 1, arm: 'search', fam: i < 300 ? 'pert' : 'm2' }, { t: sec(2.4 + 0.5 * i), ev: 'slotEnd', id: i + 1 });
	const mg = PH.jobTimeline(mkJob('ev-gpu', { events: [ses, { t: sec(1), ev: 'round', round: 1, order: D.STAGES_ALL }], gpu: gm, history: [] }), { range: 'all', running: false, now: sec(3000) });
	const gs = mg.spans.filter((s) => s.lane === 'gpu');
	check('short GPU blocks of one family in a row merged into one block (their count kept), a block per family run', gs.length >= 2 && gs.length <= 60 && gs.reduce((a, s) => a + s.n, 0) === 600 &&
		gs[0].key === 'gpu-rand' && gs[gs.length - 1].key === 'gpu-m2', `${gs.length} GPU blocks: ${gs.map((s) => `${s.key}x${s.n}`).join(' ')}`);
	// never started
	const jn = mkJob('never', { history: [] });
	const mn = PH.jobTimeline(jn, { now: sec(10) });
	check('a job that never ran: the preview (round 1\'s stages, every chip to come), "Not started yet"', mn.preview && mn.rounds[0].recipe.length === D.STAGES_ALL.length - 4 && mn.rounds[0].recipe.every((c) => c.state === 'next') &&
		/^Not started yet\. Press Start/.test(mn.now.text) && !mn.spans.length);
	// a rotated events file is read too
	const jr = mkJob('rotated', { history: [] });
	writeLines(path.join(jr, 'grind_events.1.jsonl'), [ses, { t: sec(1), ev: 'round', round: 1, order: D.STAGES_ALL }, { t: sec(2), ev: 'stage', id: 1, lane: 'stages', key: 'mutA', name: 'mutate_1a_1', round: 1, threads: 8 }]);
	writeLines(path.join(jr, 'grind_events.jsonl'), [Object.assign({}, ses, { t: sec(3), cont: true }), { t: sec(9), ev: 'stageEnd', id: 1, code: 0 }]);
	const mr = PH.jobTimeline(jr, { range: 'all', running: false, now: sec(20) });
	check('a rotated file (<name>.1.jsonl) is read first; the session line again (cont) is no new session', mr.spans.length === 1 && mr.spans[0].t1 === sec(9) && mr.rounds.length === 1, JSON.stringify(mr.spans));
}

// ================================================================ legacy: grind.log
if (want('legacy')) {
	console.log('legacy (grind.log)');
	const L = [
		'[grind 23:58:00] start: best 1:40.00 (run_ticks 10000), 0 deaths, coins optional (coin-blind search), 6 workers, runs until stopped',
		'[grind 23:58:00] GPU on: the GPU searcher runs next to the CPU stages',
		'[gpu 23:58:01] GPU search started (coin-blind), rounds of 30 s',
		'[grind 23:58:01] mutate_1a_1...',
		'[grind 23:58:31] mutate_1a_1: 1:40.00 -> 1:39.00 (-100)',
		'[grind 23:58:32] endgame1 (the last ticks, every input)...',
		'[grind 23:59:30] sweep1: hunt windows of 800 ticks over the whole run (9900 ticks), up to 3 at once x 2 threads, 120 s each, every window',
		'[grind 23:59:30] sweep1_1 (hunt window ticks 0-800 of 9900, new, lane 1/3, 2 threads)...',
		'[grind 23:59:30] sweep1_2 (hunt window ticks 600-1400 of 9900, new, lane 2/3, 2 threads)...',
		'[grind 23:59:31] sweep1_3 (loop window ticks 3000-3500 of 9900, the run comes back, lane 3/3, 2 threads)...',
		'[gpu 00:00:40] GPU: round 2: 3 shortcuts -> 1:39.00 to 1:38.70 (-30) [pert 3 -30], handed to the grind',
		'[grind 00:00:41] inbox (gpu (3 shortcuts)): 1:39.00 -> 1:38.70 (-30)',
		'[grind 00:01:30] sweep1_1: its window saves 12',
		'[grind 00:01:30] sweep1_2: nothing in this window',
		'[grind 00:01:31] sweep1_3: nothing in this window',
		'[grind 00:01:32] sweep1: 3 windows searched, 1 found time; every window of the run covered (122 s)',
		'[grind 00:01:33] deep1_loop1 (the run comes back to (10, 20) 400 ticks later: ticks 3000-3400)...',
		'[grind 00:03:33] deep1_loop1: no way around the loop found',
		'[grind 00:08:00] round 1 done (10 min): best 1:38.58',
		'[grind 00:08:01] mutate_2a: skipped (the GPU searches these input changes)',
		'[grind 00:08:02] endgame2 (the last ticks, every input)...',
		'[gpu 00:09:00] GPU: round 20 (30 s, library 5): m1+del 0-9858 5.0 s 1 G ticks 0 new',
		'[try 03:00:00] probe 0:40: 1:38.58 -> 1:38.50 (-8) accepted',
	].join('\n') + '\n';
	const HL = [{ t: 0, runTicks: 9900, saved: 100, what: 'mutate_1a_1' }, { t: 0, runTicks: 9870, saved: 30, what: 'inbox (gpu (3 shortcuts))' }, { t: 0, runTicks: 9858, saved: 12, what: 'sweep1_1' },
		{ t: 0, runTicks: 9850, saved: 8, what: 'try: probe 0:40' }];
	// (the session's start: 23:58:00 local, the day before the history's times)
	const start = new Date(2026, 9, 1, 23, 58, 0).getTime();
	HL[0].t = start + 31e3; HL[1].t = start + 161e3; HL[2].t = start + 210e3; HL[3].t = start + 3 * 3600e3 + 2 * 60e3;
	const jl = mkJob('legacy', { log: L, history: HL, status: { sessionStarted: start, state: 'stopped' } });
	const m = PH.jobTimeline(jl, { range: 'all', running: false, now: start + 5 * 3600e3 });
	const by = (n) => m.spans.find((s) => s.name === n);
	check('a job with no events: built from grind.log (legacy), its clock anchored on status.json sessionStarted', m.legacy && m.t0 <= start && by('mutate_1a_1') && by('mutate_1a_1').t0 === start + 1000,
		`${m.legacy} ${by('mutate_1a_1') && by('mutate_1a_1').t0 - start}`);
	check('past midnight: a day added (the sweep ends at 00:01:32 the next day)', by('sweep1') && by('sweep1').t1 === start + (2 * 60 + 92) * 1000, by('sweep1') && (by('sweep1').t1 - start) / 1000);
	check('the sweep\'s windows on its rows (lane k/n), their windows, its result lines (saved)', by('sweep1_2').lane === 'sweep' && by('sweep1_2').sub === 1 && by('sweep1_3').sub === 2 && by('sweep1_1').w1 === 800 &&
		by('sweep1_1').saved === 12 && by('sweep1_2').saved === 0);
	check('a stage ends where the next one of its lane starts (endgame1 at the sweep\'s start), the loop at its result line', by('endgame1').t1 === start + 90e3 && by('deep1_loop1').t1 === start + (5 * 60 + 33) * 1000);
	check('the GPU: one "GPU search" band from its first to its last line', m.spans.filter((s) => s.lane === 'gpu').length === 1 && m.spans.find((s) => s.lane === 'gpu').label === 'GPU search');
	check('round 1 ended by "round 1 done", round 2 from its stages; mutate_2a\'s skip with its why; [try] lines are no part of the session',
		m.rounds.length === 2 && m.rounds[0].t1 === start + 10 * 60e3 && m.rounds[1].recipe.find((c) => c.key === 'mutA').state === 'skipped' &&
		/GPU searches/.test(m.rounds[1].recipe.find((c) => c.key === 'mutA').why) && /^Paused\. The last session ran 11 min/.test(m.now.text), m.now.text);
	check('the finds on their spans\' lanes (mutate: Stages; the sweep window: its row; the GPU\'s: GPU; the probe: Handed in)', m.marks.map((x) => `${x.lane}${x.sub}`).join() === 'stages0,gpu0,sweep0,in0', m.marks.map((x) => `${x.lane}${x.sub}`).join());
}

// ================================================================ the hybrid
let HYS = null, mHy = null;
if (want('hybrid') || want('view')) {
	const started = sec(0);
	HYS = { running: true, stage: 'running', started, elapsed: 2105, workers: { compiler: 3, search: 5 }, cpu: true, restartS: 1800, polishS: 180,
		live: { t: 2105, compiler: { alive: true, round: 1, anchors: 1234, maxGain: 7, furthest: { gain: 7, dist: 12.4, desc: 'coins=3' }, stage: 'plan',
			stages: [[0.3, 'parse', 300, 0], [1.0, 'model', 600, 0], [2.0, 'bounds', 900, 0], [2.4, 'plan', 300, 0], [1500, 'moves', 1497000, 0], [1501, 'verify', 900, 0],
				[1801, 'parse', 200, 1], [1802, 'model', 500, 1], [1803, 'bounds', 800, 1], [1804, 'plan', 300, 1]], rounds: [[0, 0], [1800.5, 1]] },
		search: { run: 1, seed: 1001, state: 'finding', nearest: { tiles: 13.4, strategy: 'one search' }, rooms: 22, states: [[0, 'finding', 0], [1805, 'ended', 0], [1806, 'finding', 1]] },
		prefixes: [{ k: 1, t: 900, end: 1500, why: 'the compiler stalled', nearest: 30 }],
		restarts: [{ n: 1, t: 1805, why: 'no progress of either side for 1800 s' }], sinceProgress: 75, routes: [], first: null, best: null } };
	mHy = PH.hybridTimeline(HYS, { now: started + 2105e3 });
}
if (want('hybrid')) {
	console.log('hybrid');
	const m = mHy;
	const lane = (id) => m.spans.filter((s) => s.lane === id);
	check('the hybrid\'s model: kind hybrid, lanes Compiler, Search, Prefix search (no route yet: no Optimizer)', m.kind === 'hybrid' && m.lanes.map((l) => l.id).join() === 'compiler,search,prefix', m.lanes.map((l) => l.id).join());
	check('the compiler: a block per stage ([t - ms, t]), its plain names, the stage under way open (after plan: Building the moves)', lane('compiler').length === 11 &&
		lane('compiler')[4].label === 'Building the moves' && lane('compiler')[4].t0 === sec(3) && lane('compiler')[10].t1 === null && lane('compiler')[10].label === 'Building the moves',
		lane('compiler').map((s) => s.label).join(' | '));
	check('the search: a block per run (the restart starts run 2; run 1 ended at its "ended" state)', lane('search').length === 2 && lane('search')[0].t1 === sec(1805) && lane('search')[1].t0 === sec(1805) && lane('search')[1].t1 === null,
		JSON.stringify(lane('search').map((s) => [s.t0 - sec(0), s.t1 && s.t1 - sec(0)])));
	check('the prefix search: its block; the restart a line; the compiler\'s second round a "C2" line', lane('prefix').length === 1 && lane('prefix')[0].t1 === sec(1500) && m.restarts.length === 1 && m.restarts[0].t === sec(1805) &&
		m.rounds.some((r) => r.tag === 'C2' && r.t0 === sec(1800.5)));
	check('the compiler\'s chips (its round 2): parse..plan done, moves now, the rest to come', (() => { const r = m.rounds[m.rounds.length - 1]; const s = (k) => r.recipe.find((c) => c.key === k).state; return s('plan') === 'done' && s('moves') === 'now' && s('verify') === 'next' && r.title === 'Compiler round 2'; })());
	check('the now sentence before a route: the time, the compiler (round, anchors, furthest), the search (run, nearest, rooms), the restart rule',
		m.now.text === '35:05 in. The compiler is building the moves (round 2: 1,234 anchors, furthest coins=3, 12.4 tiles to go). Find a route (run 2): 13.4 tiles from the trophy, 22 rooms. No route yet; it starts fresh after 30:00 without progress (the last progress 1:15 ago).',
		m.now.text);
	// routes: the search's first, the compiler's faster one, a slower one; then the polish
	const R = JSON.parse(JSON.stringify(HYS));
	R.stage = 'polish';
	R.live.routes = [{ t: 2000, by: 'search', runTicks: 4218, time: '0:42.18', how: 'Find a route (one search)' }, { t: 2050, by: 'compiler', runTicks: 4100, time: '0:41.00', how: 'trophy' },
		{ t: 2060, by: 'prefix', runTicks: 4300, time: '0:43.00', how: 'from the anchor' }];
	R.live.first = { by: 'search', t: 2000, runTicks: 4218 };
	R.live.best = { by: 'compiler', runTicks: 4100, t: 2050, time: '0:41.00' };
	const m2 = PH.hybridTimeline(R, { now: sec(2105) });
	check('every route a diamond on its part\'s lane (gold: a new best, hollow: slower), the best\'s steps, the Optimizer lane from the first route (Polish)',
		m2.marks.length === 3 && m2.marks[0].lane === 'search' && m2.marks[0].best && m2.marks[1].lane === 'compiler' && m2.marks[1].best && m2.marks[1].saved === 118 && !m2.marks[2].best &&
		m2.best.length === 2 && m2.best[1][1] === 4100 && m2.lanes.some((l) => l.id === 'optimizer') && m2.spans.some((s) => s.lane === 'optimizer' && s.label === 'Polish' && s.t0 === sec(2000)),
		JSON.stringify(m2.marks.map((x) => [x.lane, x.best, x.saved])));
	check('the score: routes and the ticks each part took off the best', m2.score.find((x) => x.key === 'compiler').finds === 1 && m2.score.find((x) => x.key === 'compiler').saved === 118 && m2.score.find((x) => x.key === 'search').finds === 1);
	check('the now sentence with a route: who found it, the best, the polish left (180 s from 33:20: 1:15 at 35:05)', m2.now.text === '35:05 in. Route found by Find a route at 33:20 (0:42.18); the best is 0:41.00 by the compiler. Polishing it: 1:15 left.', m2.now.text);
	const D2 = { running: false, stage: 'done', started: sec(0), elapsed: 2300, live: R.live, result: { runTicks: 4100, by: 'compiler', t: 2050, first: { by: 'search', t: 2000, runTicks: 4218 } } };
	check('done: the best route, by whom, when, the first one', PH.nowHybrid(D2) === 'Done after 38:20: the best route 0:41.00 by the compiler at 34:10 (the first 0:42.18 by Find a route at 33:20).', PH.nowHybrid(D2));
	check('stopped before a route; no hybrid; a state without the live parts (an older tools/hybrid.js): blocks still', /^Stopped after 0:30 without a route/.test(PH.nowHybrid({ running: false, stage: 'stopped', started: 1, elapsed: 30, live: {} })) &&
		PH.hybridTimeline({ stage: 'none' }) === null &&
		PH.hybridTimeline({ running: true, started: sec(0), elapsed: 60, live: { compiler: { alive: true, round: 0, stage: 'moves' }, search: { run: 0, state: 'finding' }, restarts: [], routes: [] } }, { now: sec(60) }).spans.length === 2);
}

// ================================================================ the view (src/app/phases.js in a minimal window)
function loadView() {
	const style = { getPropertyValue: (k) => ({ '--ph-tweak': '#2a78d6', '--ph-explore': '#4a3aa7', '--ph-path': '#e0662f', '--ph-local': '#14a37a', '--ph-finish': '#b8489e', '--ph-combine': '#7d8799', '--ph-outside': '#3e4a5e' })[k] || '' };
	const doc = { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} }, documentElement: {}, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
	const sb = { document: doc, getComputedStyle: () => style, console, Date, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval, Map, Set, WeakMap, RegExp, String, Number, Object, Array, Promise };
	sb.window = sb;
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'phases.js'), 'utf8'), sb, { filename: 'phases.js' });
	return sb.TL;
}
if (want('view')) {
	console.log('view (TL.html)');
	let TL = null, err = null;
	try { TL = loadView(); } catch (e) { err = e; }
	check('src/app/phases.js loads in a browser-like window and defines TL (mount, update, unmount, classify, render, html)', !err && TL && ['mount', 'update', 'unmount', 'classify', 'render', 'html'].every((k) => typeof TL[k] === 'function'), err && err.message);
	if (TL) {
		const r = TL.html(mRun, { width: 1100, range: 'session' });
		const h = r.html;
		const rects = (h.match(/<rect class="blk"/g) || []).length;
		const inView = mRun.spans.filter((s) => s.t0 <= mRun.tNow).length;
		check('the full view: the title, the range control (Session pressed), the speed, the now sentence, the round\'s chips', /<h2>Optimizer<\/h2>/.test(h) && /data-range="session" aria-pressed="true"/.test(h) &&
			/class="tl-speed"[^>]*><span class="dot"><\/span><b>13\.1 M<\/b> \+ <b>384 M<\/b> ticks\/s/.test(h) && /class="tl-now"/.test(h) && /<span class="rk">Round 2<\/span>/.test(h) && /tl-chip now/.test(h) && /tl-chip skipped/.test(h));
		check('a block per span in the figure, in its family colour', rects === inView && /style="fill:var\(--ph-explore\)" data-fam="explore"/.test(h), `${rects} blocks, ${inView} spans`);
		const labels = (h.match(/<text class="bl"[^>]*>([^<]*)<\/text>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
		check('labels inside blocks only where they fit (the 120-s sweep windows of the sweep lane none; the long blocks theirs)', labels.length > 0 && !labels.includes('Route sweep window') && labels.includes('Route sweep') &&
			labels.every((l) => l.length > 0), labels.join(' | '));
		check('the playhead and the open blocks\' gold edge while it runs; the crosshair line; a gold diamond per find, one hollow for the refused hand-in',
			/class="ph" data-ph="1"/.test(h) && /class="oe"/.test(h) && /class="xh"/.test(h) && (h.match(/class="dm"/g) || []).length === 4 && (h.match(/class="dm ref"/g) || []).length === 1,
			`${(h.match(/class="dm"/g) || []).length} gold diamonds`);
		// (a diamond's lane: the y of its centre in the Sweep lane's first row for the sweep window's find)
		const lanesY = mRun.lanes.map((l, i) => 120 + 10 + i * 26);
		const dm = [...h.matchAll(/<path class="dm" d="M([\d.]+),([\d.]+)L/g)].map((x) => +x[2] + 5.5);
		check('the diamonds on their lanes (Stages, GPU, Sweep\'s first row, Handed in)', dm.length === 4 && dm.includes(lanesY[0] + 11) && dm.includes(lanesY[3] + 11) && dm.includes(lanesY[4] + 11) &&
			dm.some((y) => y > lanesY[1] && y < lanesY[1] + 6), `${dm.join(',')} lanes ${lanesY.join(',')}`);
		check('the lane labels and the best time\'s axis in the label column (the original, the best now)', /<span style="top:[\d.]+px" title="[^"]*">Stages<\/span>/.test(h) && />Handed in<\/span>/.test(h) && />1:40\.00<\/span>/.test(h) && /class="ax cur"[^>]*>1:38\.00</.test(h));
		check('the legend: the families present as toggles, "a find", the refused hand-in', /data-lg="explore"/.test(h) && /data-lg="tweak"/.test(h) && /a find<\/span>/.test(h) && /handed in, not accepted/.test(h) && !/data-lg="path"/.test(h));
		check('the scoreboard by family (Route explore saved 24 of the sweep), "Show every stage", the phase guide', /What found time \(this range\)/.test(h) && /Show every stage/.test(h) && /<details class="tl-guide"><summary>What the phases do/.test(h) &&
			/Route explore<\/td><td class="n">[^<]+<\/td><td class="n">\d+<\/td><td class="n">1<\/td><td class="n d">−24<\/td>/.test(h));
		const every = TL.html(mRun, { width: 1100, every: true }).html;
		check('"Show every stage": a row per stage (GPU: random variations, Route sweep, Input tweaks, ...)', /GPU: random variations<\/td>/.test(every) && /Route sweep<\/td>/.test(every) && /Loop cutter<\/td>/.test(every));
		const stoppedH = TL.html(PH.jobTimeline(jobRun, { range: 'session', running: false, now: sec(5000) }), { width: 900 }).html;
		check('stopped: no playhead, no open edges', !/data-ph="1"/.test(stoppedH) && !/class="oe"/.test(stoppedH));
		const legacyNote = TL.html(Object.assign({}, mRun, { legacy: true }), { width: 900 }).html;
		check('a legacy model says it is built from the log', /Built from the log \(times to the second\)\. Restart the run for the full view\./.test(legacyNote));
		const pv = TL.html(PH.jobTimeline(path.join(HOME, 'jobs', 'never'), { now: sec(10) }), { width: 900 }).html;
		check('never started: the chips as a preview (every one "to come"), no figure', /Not started yet/.test(pv) && /tl-chip next/.test(pv) && !/<svg/.test(pv) && /tl-empty/.test(pv));
		const narrow = TL.html(mRun, { width: 390 }).html;
		check('a phone: the plot keeps 544 px (it scrolls inside its section), the labels a column of their own', /<div class="tl-plot"><svg width="544"/.test(narrow) && /--tl-lab:78px/.test(narrow), (narrow.match(/<svg width="\d+"/) || [''])[0]);
		const c = TL.html(mHy, { width: 300, compact: true, sheet: 'hySheet' }).html;
		check('the compact view (the editor\'s Hybrid): the now sentence, the figure (no labels inside blocks), the lane names, "Open the full view"',
			/class="tl-now"/.test(c) && /<svg/.test(c) && !/class="bl"/.test(c) && /data-sheet="1">Open the full view/.test(c) && /Prefix search<\/span>/.test(c) && !/class="tl-score"/.test(c));
		const full = TL.html(mHy, { width: 1000 }).html;
		check('the hybrid\'s full view (the sheet): the compiler\'s chips, the restart line, the parts\' legend, "What found routes", the parts\' guide; no range control',
			/<span class="rk">Compiler round 2<\/span>/.test(full) && /class="rs"/.test(full) && /restart 1<\/text>/.test(full) && /What found routes|What the parts do/.test(full) && !/data-range=/.test(full) && /a route \(gold: a new best\)/.test(full));
		const cl = TL.classify({ t: 1, runTicks: 5, what: 'sweep3_4' }, 'x');
		check('TL.classify without a loaded timeline: the dictionary\'s label and colour from the entry\'s what', cl.label === 'Route sweep' && cl.color === 'var(--ph-explore)' && cl.round === null);
		check('TL.dict is the dictionary (the same as Node\'s require)', TL.dict && TL.dict.STAGES.length === D.STAGES.length && TL.dict.classify('mutate_1a_1').key === 'mut');
	}
}

// ================================================================ the server
function request(port, method, p) {
	return new Promise((resolve) => {
		const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
			const ch = [];
			res.on('data', (d) => ch.push(d));
			res.on('end', () => { const b = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(b); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json: j, text: b }); });
		});
		req.on('error', (e) => resolve({ status: 0, error: e.message }));
		req.end();
	});
}
async function serverChecks() {
	console.log('server');
	const S = require('../src/server.js');
	await new Promise((r) => S.server.listen(0, '127.0.0.1', r));
	const port = S.server.address().port;
	try {
		let r = await request(port, 'GET', '/api/jobs/ev-running/phases?range=all');
		check('GET /api/jobs/:id/phases: the model (v 1, kind job, its spans, marks, score, history)', r.status === 200 && r.json && r.json.v === 1 && r.json.kind === 'job' && r.json.spans.length > 5 && r.json.history.length === 4 && r.json.sig,
			`${r.status} ${r.text.slice(0, 200)}`);
		const sig = r.json && r.json.sig;
		r = await request(port, 'GET', `/api/jobs/ev-running/phases?range=all&sig=${encodeURIComponent(sig)}`);
		check('?sig= of the last answer: {unchanged: true}', r.status === 200 && r.json && r.json.unchanged === true, r.text.slice(0, 200));
		r = await request(port, 'GET', '/api/jobs/no-such-job/phases');
		check('an unknown job: 404', r.status === 404);
		r = await request(port, 'GET', '/api');
		check('GET /api lists /api/jobs/:id/phases', r.json && r.json.endpoints.some((e) => /\/phases/.test(e.path)));
		r = await request(port, 'GET', '/phases.js');
		check('GET /phases.js serves the view (no-cache)', r.status === 200 && /window\.TL|root\.TL/.test(r.text));
		r = await request(port, 'GET', '/api/editor/hybrid');
		check('GET /api/editor/hybrid with no hybrid: no timeline (stage none)', r.status === 200 && r.json.stage === 'none' && !r.json.timeline);
	} finally { await new Promise((r) => S.server.close(r)); }
}

// ================================================================ the grind: its results byte for byte the same with and without its events
// Two arms on a toy level (EEAT_EVENTS=0 / on), each until the first round's input tweaks are done (the next stage, the exact
// finish, starts); compared up to there: what comes after is timed (explore windows) and is no evidence either way.
//   --grind                 the whole check here (this process, a grind and its tool at a time)
//   --grind-prep=<home>     the two toy jobs in <home> (the grinds are then run from a shell: the grind and its tool only), their
//                           folders and grind command lines printed as JSON
//   --grind-compare=<dirA>,<dirB>  the comparison of two arms run that way (A: EEAT_EVENTS=0)
function grindPrep() {
	const J = require('../src/jobs.js');
	const ED = require('../src/editor.js');
	// a toy level: a 70 x 8 room, the spawn at the left, a wall 2 tiles high at x 15, the trophy at the right; a slow TAS: runs
	// right with a pause, waits against the wall and jumps it late (the input tweaks find time in it at once: the ball standing
	// at the wall is the same state whenever it got there, an exact rejoin)
	const W = 70, H = 8, cells = [];
	for (let x = 0; x < W; x++) cells.push([x, 0, 9], [x, H - 1, 9]);
	for (let y = 1; y < H - 1; y++) cells.push([0, y, 9], [W - 1, y, 9]);
	cells.push([15, H - 2, 9], [15, H - 3, 9]);
	cells.push([2, H - 2, 255], [W - 3, H - 2, 121]);
	const eelvl = ED.eelvlOf({ name: 'phases toy', width: W, height: H, cells });
	const seq = [];
	const add = (m, n) => { for (let k = 0; k < n; k++) seq.push(m); };
	add(4, 30); add(0, 20); add(4, 90); add(5, 20); add(4, 2000);
	return [true, false].map((off) => {
		const meta = J.importJob({ eelvl, eetas: Buffer.from(C.eetasBytes(Uint8Array.from(seq))), name: `phases toy ${off ? 'off' : 'on'}`, eelvlName: 'toy.eelvl', eetasName: 'toy.eetas' });
		const dir = J.jobDir(meta.id), level = meta.levelId || C.jobLevelId(meta.id);
		const argv = [path.join(__dirname, '..', 'src', 'grind.js'), `--job=${dir}`, `--level=${level}`, '--forever=1', '--workers=1', '--flybeamShare=0'];
		return { off, id: meta.id, dir, level, argv, shell: `${off ? 'EEAT_EVENTS=0 ' : ''}EEAT_HOME=${HOME} timeout 60 node ${argv.map((x) => JSON.stringify(x)).join(' ')}` };
	});
}
async function grindRun(arms) {
	for (const arm of arms) {
		const env = Object.assign({}, process.env, { EEAT_HOME: HOME });
		if (arm.off) env.EEAT_EVENTS = '0'; else delete env.EEAT_EVENTS;
		const t0 = Date.now();
		const ch = spawn(process.execPath, arm.argv, { env, stdio: 'ignore', windowsHide: true });
		let done = false;
		while (!done && Date.now() - t0 < 240e3) {
			await new Promise((r) => setTimeout(r, 500));
			let log = '';
			try { log = fs.readFileSync(path.join(arm.dir, 'grind.log'), 'utf8'); } catch (e) { /* not yet */ }
			done = /\] endgame1 /.test(log) || ch.exitCode !== null;
		}
		if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		else { try { ch.kill('SIGKILL'); } catch (e) { /* gone */ } }
		await new Promise((r) => setTimeout(r, 800));
		arm.ms = Date.now() - t0;
	}
}
/** the arms' results up to the first round's input tweaks' end (the exact finish's start) */
function grindCompare(dirA, dirB) {
	console.log('grind (with / without events: the same results)');
	const read = (d, f) => { try { return fs.readFileSync(path.join(d, f)); } catch (e) { return null; } };
	const lines = (d) => String(read(d, 'grind.log') || '').split('\n').filter(Boolean);
	const cut = (d) => { const L = lines(d); const i = L.findIndex((l) => /^\[grind [\d:]+\] endgame1 /.test(l)); return i < 0 ? null : L.slice(0, i); };
	// the log up to there, its clock and timings left out
	const logOf = (d) => (cut(d) || []).map((l) => l.replace(/^\[grind [\d:]+\] /, '').replace(/\(\d+ ms\)/g, '(ms)').replace(/\d+ s\)/g, 's)')).filter((l) => !/^\[/.test(l)).join('\n');
	const mutHist = (d) => (C.readJSON(path.join(d, 'status.json'), {}).history || []).filter((h) => /^mutate_1a_/.test(h.what));
	const hist = (d) => mutHist(d).map((h) => [h.runTicks, h.saved, h.what]);
	const outs = (d) => fs.readdirSync(d).filter((f) => /^grind_mut_1a_.*\.eetas$/.test(f)).sort();
	check('both arms ran the first round\'s input tweaks to their end (the exact finish started) and found time', cut(dirA) && cut(dirB) && mutHist(dirA).length > 0, `${!!cut(dirA)} ${!!cut(dirB)} ${JSON.stringify(hist(dirA))}`);
	check('the same history (run ticks, saved, what, in order)', JSON.stringify(hist(dirA)) === JSON.stringify(hist(dirB)), `${JSON.stringify(hist(dirA))} vs ${JSON.stringify(hist(dirB))}`);
	const bestFiles = (d) => mutHist(d).map((h) => `best_${h.runTicks}.eetas`);
	check('the same best runs (every best_<ticks>.eetas of those finds), byte for byte', bestFiles(dirA).length > 0 && bestFiles(dirA).every((f) => read(dirA, f) && read(dirB, f) && Buffer.compare(read(dirA, f), read(dirB, f)) === 0),
		bestFiles(dirA).join(' '));
	check('the same stage outputs (grind_mut_1a_*.eetas), byte for byte', JSON.stringify(outs(dirA)) === JSON.stringify(outs(dirB)) && outs(dirA).length > 0 &&
		outs(dirA).every((f) => Buffer.compare(read(dirA, f), read(dirB, f)) === 0), `${outs(dirA)} vs ${outs(dirB)}`);
	check('the same log lines (its clock and timings left out)', logOf(dirA) === logOf(dirB), `\n${logOf(dirA)}\n--- vs ---\n${logOf(dirB)}`);
	check('without events (EEAT_EVENTS=0): no grind_events.jsonl', !fs.existsSync(path.join(dirA, 'grind_events.jsonl')));
	const evs = EVT.readAll(path.join(dirB, 'grind_events.jsonl'));
	const stages = evs.filter((e) => e.ev === 'stage' && /^mutate_1a_/.test(e.name));
	const hB = mutHist(dirB);
	const bests = evs.filter((e) => e.ev === 'best' && /^mutate_1a_/.test(e.what));
	check('with events: the session (v 1, its workers), round 1 (its order), a stage + stageEnd per mutate pass (key mutA, its threads), a best event per find with its history entry\'s t and span',
		evs[0] && evs[0].ev === 'session' && evs[0].v === 1 && evs[0].workers === 1 && evs.some((e) => e.ev === 'round' && e.round === 1 && e.order[0] === 'mutA') && stages.length > 0 &&
		stages.every((s) => s.key === 'mutA' && s.threads === 1 && evs.some((e) => e.ev === 'stageEnd' && e.id === s.id)) && bests.length === hB.length &&
		bests.every((b, i) => b.t === hB[i].t && b.span !== null && stages.some((s) => s.id === b.span && s.name === b.what)), JSON.stringify(evs.slice(0, 6)));
	const m = PH.jobTimeline(dirB, { range: 'session', running: false });
	check('its timeline: the mutate spans on the Stages lane, their finds on that lane, classified "Input tweaks", in round 1', m.spans.filter((s) => s.key === 'mut' && /^mutate_1a_/.test(s.name)).length === stages.length &&
		m.marks.filter((x) => x.kind === 'best' && /^mutate_1a_/.test(x.what)).every((x) => x.lane === 'stages' && x.key === 'mut' && x.label === 'Input tweaks' && x.round === 1), JSON.stringify(m.marks).slice(0, 300));
}

(async () => {
	const prep = args.find((a) => a.startsWith('--grind-prep='));
	const cmp = args.find((a) => a.startsWith('--grind-compare='));
	if (prep) { console.log(JSON.stringify(grindPrep(), null, 1)); return; }
	if (cmp) { const [a, b] = cmp.slice(16).split(','); grindCompare(path.resolve(a), path.resolve(b)); }
	else {
		if (want('server')) await serverChecks();
		if (want('grind')) { const arms = grindPrep(); await grindRun(arms); grindCompare(arms[0].dir, arms[1].dir); }
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* in use */ }
	process.exit(fail ? 1 : 0);
})();
