'use strict';
// test/stats.js: the Stats page's data (src/stats.js, docs/ui/DESIGN.md 10, 11.5, 11.6) on synthetic data only: the CSV
// reader (a BOM, quoted cells with commas, quotes and line breaks, CRLF), the benchmark import (the columns by their
// titles, the section title lines, blank lines, unconfirmed and unrouted rows, an empty best known, the extra columns,
// the errors), a benchmark's numbers (the counts, the comparison, the first-route parts, the time-to-solve bins, the
// median and the 90th percentile, the quality against the best known), tools/stats-import.js (import, --list, --remove,
// a bad file), the runs of a benchmark's levels (by the md5 a row names, by the level name, " (hybrid)" names, a
// campaign row's campaign run, the best run), the runs' numbers (totals, the families, the stages, the newest
// improvements, the sparkline), a job's optimizer time (grind.log sessions, grind_events.jsonl, gpu/events.jsonl), and
// the endpoints (GET /api/stats, /api/stats/benchmarks, /api/stats/benchmarks/:id, 404s, /stats) on the server in a temp
// EEAT_HOME. Node built-ins only; writes nothing inside the repo (a temp folder, removed at the end).
// usage: node test/stats.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

// the temp home BEFORE src/common.js is loaded: it reads EEAT_HOME once
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-stats-test-'));
process.env.EEAT_HOME = HOME;
fs.mkdirSync(path.join(HOME, 'jobs'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'common.js'));
const ST = require(path.join(ROOT, 'src', 'stats.js'));
const IMP = require(path.join(ROOT, 'tools', 'stats-import.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined && !ok ? ': ' + detail : ''}`);
}
function section(s) { console.log(`\n== ${s}`); }
const J = (x) => JSON.stringify(x);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------- the CSV
section('the CSV reader');
{
	const rows = ST.parseCsv('\ufeffa,b,c\r\n"x, y","say ""hi""",3\n"two\nlines",,\n');
	check('BOM stripped, 3 rows', rows.length === 3 && rows[0][0] === 'a', J(rows));
	check('a quoted comma', rows[1][0] === 'x, y', J(rows[1]));
	check('doubled quotes', rows[1][1] === 'say "hi"', J(rows[1]));
	check('a line break inside quotes, empty cells kept', rows[2][0] === 'two\nlines' && rows[2].length === 3 && rows[2][2] === '', J(rows[2]));
	check('no last line break: the last row kept', ST.parseCsv('a,b\n1,2').length === 2);
	check('times: m:ss.cc, h:mm:ss.cc, s.cc', ST.timeTicks('0:19.63') === 1963 && ST.timeTicks('1:02:03.45') === 372345 && ST.timeTicks('19.63') === 1963 && ST.timeTicks('abc') === null);
	check('durations: 4m 01s, 1h 02m 03s, 241', ST.durSeconds('4m 01s') === 241 && ST.durSeconds('1h 02m 03s') === 3723 && ST.durSeconds('241') === 241 && ST.durSeconds('') === null);
}

// ---------------------------------------------------------------- the import
const CSV = [
	'\ufeffSection,Level,Hybrid result,Time to solve (s),Time to solve,First route came from,Best route time,Which hybrid run,Best known TAS,Search alone,Compiler alone,Identical copies merged,Notes',
	'CAMPAIGN: 2 of 3 routed,,,,,,,,,,,,',
	'campaign,Tutorial 1,Routed,20,0m 20s,compiler,0:19.63,10-min run (all levels),0:16.55,0m 10s -> 0:16.83,Routed,,',
	'campaign,"Comma, Level",Routed (not confirmed: random portals),300,5m 00s,search,1:00.00,long run,1:00.00,no route,no route,,"a ""note"""',
	'campaign,Hard One,No route,,,,,,,no route,no route,,',
	'',
	'OTHER: 1 of 1 routed,,,,,,,,,,,,',
	'other,Test Level (1a2b3c4d),Routed,4000,1h 06m 40s,optimizer,2:00.00,long run,,,,Test Level = Test Level_9f8e7d6c5b,',
	'',
].join('\r\n');
let B;
section('the import');
{
	B = ST.importCsv(CSV, { source: 'C:\\some\\where\\hybrid_levels.csv', now: 1000 });
	check('4 level rows (the title and blank lines skipped)', B.rows.length === 4, B.rows.map((r) => r.level).join(' | '));
	check('the name and id from the file name', B.name === 'Hybrid Levels' && B.id === 'hybrid-levels' && B.source === 'hybrid_levels.csv' && B.imported === 1000, `${B.name} ${B.id} ${B.source}`);
	check('the columns found by their titles', B.columns.result === 'Hybrid result' && B.columns.solveS === 'Time to solve (s)' && B.columns.by === 'First route came from' && B.columns.merged === 'Identical copies merged', J(B.columns));
	check('the sections recomputed, titles from the title lines', J(B.sections) === J([{ key: 'campaign', title: 'Campaign', routed: 2, total: 3 }, { key: 'other', title: 'Other', routed: 1, total: 1 }]), J(B.sections));
	const [t1, cl, ho, tl] = B.rows;
	check('a routed row', t1.result === 'routed' && t1.solveS === 20 && t1.by === 'compiler' && t1.best.runTicks === 1963 && t1.known.runTicks === 1655 && t1.ratio === 1.186 && t1.run === '10-min run (all levels)', J(t1));
	check('search alone "0m 10s -> 0:16.83"', t1.searchAlone && t1.searchAlone.routed === true && t1.searchAlone.solveS === 10 && t1.searchAlone.best.runTicks === 1683, J(t1.searchAlone));
	check('compiler alone routed / no route', t1.compilerAlone === true && cl.compilerAlone === false);
	check('a quoted level with a comma, unconfirmed', cl.level === 'Comma, Level' && cl.result === 'unconfirmed' && cl.ratio === 1, J(cl));
	check('an extra column kept per row', cl.extra && cl.extra.Notes === 'a "note"', J(cl.extra));
	check('a row with no route: no solve time, no first route', ho.result === 'none' && ho.solveS === null && ho.by === null && ho.best === null && ho.searchAlone.routed === false, J(ho));
	check('an empty best known: no ratio', tl.known === null && tl.ratio === null && tl.searchAlone === null && tl.compilerAlone === null, J(tl));
	check('identical copies split', J(tl.merged) === J(['Test Level', 'Test Level_9f8e7d6c5b']), J(tl.merged));
	check('a section from the section column wins over the title line', tl.section === 'other');
	const named = ST.importCsv(CSV, { name: 'Hybrid, 220 test levels' });
	check('--name: the id its slug', named.name === 'Hybrid, 220 test levels' && named.id === 'hybrid-220-test-levels', named.id);
	const throws = (f) => { try { f(); return null; } catch (e) { return e.message; } };
	check('no level column: an error', /no "level" column/.test(throws(() => ST.importCsv('a,b\n1,2')) || ''));
	check('an empty file: an error', /empty/.test(throws(() => ST.importCsv('\ufeff\r\n\r\n')) || ''));
	check('a header alone: an error', /no level rows/.test(throws(() => ST.importCsv('Level,Hybrid result\n')) || ''));
	check('a bad id: an error', /bad id/.test(throws(() => ST.importCsv(CSV, { id: '../x' })) || ''));
	check('the section column alone (no title lines)', J(ST.importCsv('Section,Level,Result\ncampaign,A,Routed\nother,B,no route\n').sections) === J([{ key: 'campaign', title: 'Campaign', routed: 1, total: 1 }, { key: 'other', title: 'Other', routed: 0, total: 1 }]));
}

// ---------------------------------------------------------------- the numbers
section("a benchmark's numbers");
{
	const n = ST.benchNumbers(B);
	check('levels / routed / confirmed / unconfirmed', n.levels === 4 && n.routed === 3 && n.confirmed === 2 && n.unconfirmed === 1, J([n.levels, n.routed, n.confirmed, n.unconfirmed]));
	check('the comparison', J(n.compare) === J({ hybrid: 3, search: 1, compiler: 1, either: 1, onlyHybrid: 2, hasSearch: true, hasCompiler: true }), J(n.compare));
	check('the first route by part', J(n.by) === J({ compiler: 1, search: 1, optimizer: 1 }), J(n.by));
	check('the time-to-solve bins (20 s, 300 s, 4000 s)', J(n.solve.bins.map((b) => b.n)) === J([0, 1, 0, 0, 1, 0, 0, 0, 1]), J(n.solve.bins.map((b) => b.n)));
	check('median 300, p90 4000, the longest 4000', n.solve.n === 3 && n.solve.median === 300 && n.solve.p90 === 4000 && n.solve.max === 4000, J(n.solve));
	check('the quality: 2 with a best known, 1 at or under, 1 within 10%, median the upper middle', n.quality.known === 2 && n.quality.under === 1 && n.quality.within10 === 1 && near(n.quality.median, 1.186), J(n.quality));
	check('median / quantile of an even and an odd count', ST.median([1, 2, 3, 4]) === 3 && ST.median([1, 2, 3]) === 2 && ST.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) === 9 && ST.median([]) === null);
	check('an empty benchmark', ST.benchNumbers({ rows: [] }).levels === 0 && ST.benchNumbers({ rows: [] }).solve.median === null);
}

// ---------------------------------------------------------------- tools/stats-import.js
section('tools/stats-import.js');
{
	const dir = path.join(HOME, 'tooldir');
	const csv = path.join(HOME, 'my_results.csv');
	fs.writeFileSync(csv, CSV);
	const run = (args) => {
		const out = [], err = [];
		const lo = console.log, le = console.error;
		console.log = (...a) => out.push(a.join(' '));
		console.error = (...a) => err.push(a.join(' '));
		let code;
		try { code = IMP.main(args); } finally { console.log = lo; console.error = le; }
		return { code, out: out.join('\n'), err: err.join('\n') };
	};
	let r = run([csv, `--dir=${dir}`]);
	check('import: exit 0, the summary', r.code === 0 && /3 of 4 routed \(2 confirmed, 1 not confirmed\)/.test(r.out) && /Campaign: 2 of 3 routed/.test(r.out) && /median 5 min 00 s/.test(r.out), r.out);
	check('import: the file written', fs.existsSync(path.join(dir, 'my-results.json')));
	r = run([csv, `--dir=${dir}`, '--name=Second one', '--json']);
	const js = JSON.parse(r.out);
	check('--name --json', r.code === 0 && js.id === 'second-one' && js.numbers.routed === 3, r.out);
	r = run(['--list', `--dir=${dir}`, '--json']);
	const list = JSON.parse(r.out);
	check('--list: both, newest first', list.length === 2 && list.every((b) => b.levels === 4 && b.routed === 3) && list[0].imported >= list[1].imported, r.out);
	r = run(['--remove=second-one', `--dir=${dir}`]);
	check('--remove', r.code === 0 && !fs.existsSync(path.join(dir, 'second-one.json')), r.out + r.err);
	r = run(['--remove=second-one', `--dir=${dir}`]);
	check('--remove of an unknown id: exit 1', r.code === 1 && /no benchmark/.test(r.err), r.err);
	r = run([path.join(HOME, 'missing.csv'), `--dir=${dir}`]);
	check('a missing file: exit 1', r.code === 1 && /cannot read/.test(r.err), r.err);
	fs.writeFileSync(path.join(HOME, 'bad.csv'), 'x,y\n1,2\n');
	r = run([path.join(HOME, 'bad.csv'), `--dir=${dir}`]);
	check('not a results table: exit 1', r.code === 1 && /no "level" column/.test(r.err), r.err);
	check('read back = the import', J(ST.readBenchmark('my-results', dir).rows) === J(ST.importCsv(CSV, { source: csv }).rows));
	check('readBenchmark: a bad id is null', ST.readBenchmark('../my-results', dir) === null && ST.readBenchmark('NOPE', dir) === null);
}

// ---------------------------------------------------------------- the runs of a benchmark's levels
section("the runs of a benchmark's levels");
{
	const jobs = [
		{ id: 'by-level', level: { name: 'Tutorial 1' }, name: 'whatever', best: { runTicks: 2000 } },
		{ id: 'by-name', name: 'Tutorial 1 (hybrid)', best: { runTicks: 1900 } },
		{ id: 'md5-own', level: { name: 'Test Level' }, _md5: '1a2b3c4dffff', best: { runTicks: 15000 } },
		{ id: 'md5-copy', level: { name: 'Something else' }, _md5: '9f8e7d6c5b00', best: { runTicks: 12000 } },
		{ id: 'claimed', level: { name: 'Hard One' }, _md5: '1a2b3c4d0000', best: { runTicks: 20000 } },
		{ id: 'camp-no', name: 'Comma, Level', best: { runTicks: 100 } },
		{ id: 'camp-yes', name: 'Comma, Level', campaign: { entry: '1/1.eelvl' }, best: { runTicks: 5000 } },
	];
	const m = ST.matchJobs(B, jobs, { md5Of: (j) => j._md5 || '' });
	check('by the level name or the name less " (hybrid)": the best run', m[0] === 'by-name', J(m));
	check('a campaign row takes a run of a campaign level first', m[1] === 'camp-yes', J(m));
	check('a job whose md5 another row names is no run of this one', m[2] === undefined && m[3] !== 'claimed', J(m));
	check('by the md5 the row names or a merged copy names: the best run', m[3] === 'md5-copy', J(m));
	check('the row hexes', J(ST.rowHexes(B.rows[3])) === J(['1a2b3c4d', '9f8e7d6c5b']), J(ST.rowHexes(B.rows[3])));
	check('no jobs: nothing', J(ST.matchJobs(B, [], { md5Of: () => '' })) === '{}');
}

// ---------------------------------------------------------------- the runs' numbers
section("the runs' numbers");
{
	const now = new Date(2026, 9, 2, 12, 0, 0).getTime();
	const today = new Date(2026, 9, 2, 9, 0, 0).getTime(), yday = new Date(2026, 9, 1, 9, 0, 0).getTime();
	const sums = [
		{ id: 'j1', name: 'Spring run', created: yday - 3600000, running: true, state: 'running', original: { runTicks: 1000 }, best: { runTicks: 900 },
			campaign: { entry: '12/6.eelvl', campaign: '12', title: 'Spring', tier: 6, tiers: 6 },
			history: [{ t: yday, runTicks: 950, saved: 50, what: 'mutate_3' }, { t: today, runTicks: 900, saved: 50, what: 'inbox (Find a route 12:00)' }] },
		{ id: 'j2', name: 'Other run', created: yday, original: { runTicks: 500 }, best: { runTicks: 480 },
			history: [{ t: today + 1000, runTicks: 480, what: 'sweep2_3 (coin-blind, replayed) + best (splice, 2 runs)' }] },
		{ id: 'j3', name: 'Untouched', created: today, original: { runTicks: 300 }, best: { runTicks: 300 }, history: [] },
	];
	const d = ST.jobsStats(sums, { now, time: (id) => ({ ms: id === 'j1' ? 60000 : 30000, approx: id === 'j2', simTicks: id === 'j3' ? null : 10, finds: [], sessions: 1 }) });
	const T = d.totals;
	check('totals', T.runs === 3 && T.running === 1 && T.savedTicks === 120 && T.originalTicks === 1800 && T.improvements === 3 && T.today === 2, J(T));
	check('optimizer time, approx, simulated, since', T.optimizedMs === 120000 && T.optimizedApprox === true && T.simTicks === 20 && T.since === yday - 3600000, J(T));
	check('the families', d.byFam.tweak.saved === 50 && d.byFam.tweak.finds === 1 && d.byFam.outside.saved === 50 && d.byFam.explore.saved === 20, J(d.byFam));
	check('the stages, the most saved first', d.byStage.length === 3 && d.byStage[2].key === 'sweep' && d.byStage[2].saved === 20 && d.byStage[0].saved === 50, J(d.byStage));
	check('the newest improvements first', d.recent.length === 3 && d.recent[0].job === 'j2' && d.recent[2].what === 'mutate_3' && d.recent[0].time === C.fmt(480), J(d.recent.map((x) => x.t)));
	const j1 = d.jobs[0];
	check('a campaign run', j1.section === 'campaign' && j1.campaign === 'Spring, level 6 of 6' && j1.pct === 10 && j1.improvements === 2 && j1.firstT === yday && j1.lastT === today, J(j1));
	check('its sparkline from the original', J(j1.spark) === J([[yday - 3600000, 1000], [yday, 950], [today, 900]]), J(j1.spark));
	check('an other run, an untouched run', d.jobs[1].section === 'other' && d.jobs[2].savedTicks === 0 && d.jobs[2].firstT === null && d.jobs[2].spark.length === 1);
	check('the families dictionary and order', d.famOrder.length === 7 && d.fams.tweak.label === 'Input tweaks');
	check('downsample keeps the first and the last', (() => { const p = Array.from({ length: 500 }, (_, k) => [k, k]); const s = ST.downsample(p, 48); return s.length <= 48 && s[0][0] === 0 && s[s.length - 1][0] === 499; })());
	check('classify: rules', ST.classify('mutate_1').fam === 'tweak' && ST.classify('endgame').fam === 'finish' && ST.classify('try: me').fam === 'outside' && ST.classify('sweep3_4p').key !== 'sweep' && ST.classify('???').key === 'other');
	check('empty input', ST.jobsStats([], { now }).totals.runs === 0 && ST.jobsStats(null, { now }).jobs.length === 0);
}

// ---------------------------------------------------------------- a job's optimizer time on disk
section("a job's optimizer time");
function writeJob(id, meta, status) {
	const dir = path.join(C.JOBS, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ...meta }));   // jobs.js importJob's meta carries its id
	fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
	return dir;
}
{
	const dir = writeJob('timed-run-aaaaaa', { name: 'Timed run', created: 1, tas: { runTicks: 100 } }, { state: 'stopped' });
	fs.writeFileSync(path.join(dir, 'grind.log'), [
		'[grind 10:00:00] start: round 1', '[grind 10:05:00] mutate: -3', 'not a log line', '[gpu 10:05:00] round 1',
		'[grind 23:59:00] start: again', '[grind 00:01:00] across midnight',
	].join('\n') + '\n');
	let t = ST.jobTime('timed-run-aaaaaa');
	check('grind.log alone: two sessions (one across midnight), estimated', t.ms === 420000 && t.approx === true && t.simTicks === null && t.sessions === 2, J(t));
	check('logSessions', J(ST.logSessions(dir)) === J([300000, 120000]));
	fs.writeFileSync(path.join(dir, 'grind_events.jsonl'), [
		J({ ev: 'session', t: 1000 }), J({ ev: 'stageEnd', t: 61000, ticks: 5000 }), '{"partial',
	].join('\n') + '\n');
	fs.mkdirSync(path.join(dir, 'gpu'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'gpu', 'events.jsonl'), [J({ ev: 'slotEnd', ticks: 100 }), J({ ev: 'find', t: 59000, fams: { every: -30, m1: -2 } })].join('\n') + '\n');
	t = ST.jobTime('timed-run-aaaaaa');
	check('with the events: the event session + the log sessions before it', t.ms === 60000 + 300000 && t.approx === true && t.simTicks === 5100 && t.sessions === 2, J(t));
	check('a GPU find by its family', t.finds.length === 1 && ST.classify('inbox (gpu round 3)', { t: 60000, gpuFinds: t.finds }).fam === 'explore' && ST.classify('inbox (gpu round 3)', { t: 90000, gpuFinds: t.finds }).fam === 'tweak');
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the endpoints
section('the endpoints (the server in a temp EEAT_HOME)');
function get(port, p) {
	return new Promise((res, rej) => {
		http.get({ host: '127.0.0.1', port, path: p }, (r) => {
			const b = [];
			r.on('data', (c) => b.push(c));
			r.on('end', () => {
				const s = Buffer.concat(b).toString('utf8');
				let json = null;
				try { json = JSON.parse(s); } catch (e) { /* html */ }
				res({ status: r.statusCode, type: r.headers['content-type'] || '', text: s, json });
			});
		}).on('error', rej);
	});
}
async function endpoints() {
	const hist = (t) => [{ t, runTicks: 950, saved: 50, what: 'mutate_1' }, { t: t + 1000, runTicks: 900, saved: 50, what: 'try: me' }];
	writeJob('tutorial-1-hybrid-aaaaaa', { name: 'Tutorial 1 (hybrid)', created: Date.now() - 86400000, tas: { runTicks: 1000 },
		level: { name: 'Tutorial 1', md5: 'eeeeeeeeeeee', check: { campaign: { entry: '0/1.eelvl', title: 'Tutorial', tier: 1, tiers: 4 } } } },
	{ state: 'stopped', bestRunTicks: 900, history: hist(Date.now() - 3600000) });
	writeJob('test-level-bbbbbb', { name: 'My test level', created: Date.now() - 7200000, tas: { runTicks: 600 }, level: { name: 'Test Level', md5: '9f8e7d6c5b1234' } },
		{ state: 'stopped', bestRunTicks: 600, history: [] });
	writeJob('unrelated-cccccc', { name: 'Unrelated', created: Date.now(), tas: { runTicks: 300 }, level: { name: 'Nope' } }, { state: 'stopped', bestRunTicks: 290, history: [{ t: Date.now(), runTicks: 290, what: 'endgame' }] });
	ST.writeBenchmark(ST.importCsv(CSV, { name: 'Hybrid, 4 test levels', now: Date.now() }));
	const { server } = require(path.join(ROOT, 'src', 'server.js'));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;
	try {
		let r = await get(port, '/api/stats');
		const T = r.json && r.json.totals;
		check('GET /api/stats: 200, the totals', r.status === 200 && T && T.runs === 3 && T.savedTicks === 110 && T.originalTicks === 1900 && T.improvements === 3 && T.running === 0, J(T));
		check('GET /api/stats: the jobs, the campaign run', r.json.jobs.length === 3 && r.json.jobs.find((j) => j.id === 'tutorial-1-hybrid-aaaaaa').campaign === 'Tutorial, level 1 of 4' &&
			r.json.jobs.find((j) => j.id === 'test-level-bbbbbb').section === 'other', J(r.json.jobs.map((j) => [j.id, j.section, j.campaign])));
		check('GET /api/stats: families, stages, the newest', r.json.byFam.tweak.saved === 50 && r.json.byFam.outside.saved === 50 && r.json.byFam.finish.saved === 10 && r.json.byStage.length === 3 && r.json.recent.length === 3 && r.json.recent[0].what === 'endgame', J(r.json.byFam));
		r = await get(port, '/api/stats/benchmarks');
		const L = r.json && r.json.benchmarks;
		check('GET /api/stats/benchmarks: the list', r.status === 200 && L.length === 1 && L[0].id === 'hybrid-4-test-levels' && L[0].levels === 4 && L[0].routed === 3 && L[0].confirmed === 2, r.text.slice(0, 300));
		r = await get(port, '/api/stats/benchmarks/hybrid-4-test-levels');
		const b = r.json;
		check('GET /api/stats/benchmarks/:id: the rows and the numbers', r.status === 200 && b.rows.length === 4 && b.numbers.routed === 3 && b.numbers.solve.median === 300 && b.numbers.quality.known === 2, r.text.slice(0, 300));
		check('GET /api/stats/benchmarks/:id: the runs of its levels (by name, by a merged copy\'s md5)', J(b.jobs) === J({ 0: 'tutorial-1-hybrid-aaaaaa', 3: 'test-level-bbbbbb' }), J(b.jobs));
		for (const p of ['/api/stats/benchmarks/nope', '/api/stats/benchmarks/..%2F..%2Fdata%2F_system', '/api/stats/benchmarks/UPPER', '/api/stats/benchmarks/' + 'a'.repeat(80)]) {
			r = await get(port, p);
			check(`404 JSON for ${p.length > 60 ? p.slice(0, 48) + '...' : p}`, r.status === 404 && r.json && typeof r.json.error === 'string', `${r.status} ${r.text.slice(0, 120)}`);
		}
		r = await get(port, '/api');
		check('GET /api lists the stats endpoints', r.status === 200 && /\/api\/stats\/benchmarks\/:id/.test(r.text) && /\/api\/stats\b/.test(r.text));
		r = await get(port, '/stats');
		check('GET /stats: the page with its root, its clock and its refresh', r.status === 200 && /text\/html/.test(r.type) && /id="statsRoot"/.test(r.text) && /id="statsUpdated"/.test(r.text) && /id="statsRefresh"/.test(r.text) && /\/stats\.js/.test(r.text), r.status);
		r = await get(port, '/stats.js');
		let parsed = false;
		try { new vm.Script(r.text, { filename: 'stats.js' }); parsed = true; } catch (e) { parsed = e.message; }
		check('GET /stats.js: served, and it parses', r.status === 200 && parsed === true, String(parsed));
		// no benchmarks: an empty list, not an error
		ST.removeBenchmark('hybrid-4-test-levels');
		r = await get(port, '/api/stats/benchmarks');
		check('no benchmark: an empty list', r.status === 200 && J(r.json) === J({ benchmarks: [] }), r.text);
	} finally {
		await new Promise((r) => server.close(r));
	}
}

endpoints().catch((e) => { fail++; console.log(`  FAIL the endpoints: ${e.stack || e}`); }).finally(() => {
	try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* the OS cleans its temp */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
});
