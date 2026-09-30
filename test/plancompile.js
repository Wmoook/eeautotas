'use strict';
// test/plancompile.js: THE COMPILER's product paths (n4plan, part 'strategy').
//   unit  T-COMPILE-UNIT: node src/compile.js on the plan toy (a key, its door, a sealed coin pocket, the trophy: the
//         plantypes key-door room with a trophy) with the mock parts (--parts=test/planmock.js): the stage lines (parse,
//         model, bounds, plan, moves, verify, polish, result, wrote), the .eetas written and finishing (C.evaluate), exit 0;
//         a failing executor: exit 2 with the reason; a missing level: exit 1; --json: every line an event (JSON), the
//         stages, a result, the report; --report written
//   real  the same with the real parts (src/plan/model.js, facts.js, planner.js, executor.js), when they exist
//   off   T-OFF: EEAT_PLAN unset: editor.STRATEGIES' keys = origin/main's; a search (CPU stand-ins, no GPU) launches the
//         same strategies with the same argument lists as origin/main's editor.js (EEAT_EVLOG's spawn records); with
//         EEAT_PLAN=1 the 'plan' strategy appears ("the planner (compile)"), runs (a stand-in src/plan.js), its route is the
//         search's (found()), its status line the row's detail, the other strategies' arguments unchanged
//   api   T-COMPILE-API: POST / GET / stop /api/editor/compile against the server (in a temp home, the mock parts through
//         EEAT_COMPILE_PARTS): the stage lines, a job made from the route, loadtas = /loadtas <its best.eetas> (the file
//         exists and finishes), one at a time, stop, a level without a trophy refused; the endpoints listed; the page's
//         script parses and has the Compile button
//   truth src/plan/truth.js --part=model,compile on a toy truth root: absent parts, the toy routed and verified, the totals
//   page  the page's Compile code cut out of editor.html and run on stubs: the lines, the clipboard (and its refusal), the toast
//   usage: node test/plancompile.js [--only=unit,real,off,api,truth,page]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${detail}` : ''}`); };

// the plan toy (# wall, S spawn, k red key, d red key door, T trophy, a walled pocket with a coin c) and a room without a trophy
const TOY = ['######################', '#..........###.......#', '#..........#c#.......#', '#..........###.......#', '#S....k.........d..T.#', '######################'];
const NOTROPHY = ['##########', '#S.......#', '##########'];
function eelvlOfRows(rows, name) {
	const ED = require('../src/editor.js');
	const ID = { '#': [9], S: [255], k: [6], d: [23], c: [100], T: [121] };
	const cells = [];
	rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') cells.push([x, y, ...ID[ch]]); }));
	return ED.eelvlOf({ name, width: rows[0].length, height: rows.length, cells });
}
const argv = (k) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };

// ---------------------------------------------------------------- arms (child processes: their own env and modules)
async function armMain() {
	const arm = JSON.parse(Buffer.from(argv('arm'), 'base64').toString('utf8'));
	if (arm.kind === 'search') return armSearch(arm);
	if (arm.kind === 'api') return armApi(arm);
	throw new Error(`unknown arm ${arm.kind}`);
}
/** one search through <src>/editor.js with CPU stand-ins (no GPU): the strategies, the spawn records, the result */
async function armSearch(arm) {
	const ED = require(path.join(arm.src, 'editor.js'));
	const buf = Buffer.from(arm.eelvlB64, 'base64');
	ED.start({ eelvlB64: buf.toString('base64'), seconds: arm.seconds, workers: arm.workers, steer: false }, { available: false, why: 'test: no GPU' }, arm.test);
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 300));
	let st = ED.state();
	while (st.running && Date.now() - t0 < (arm.seconds + 20) * 1000) { await new Promise((r) => setTimeout(r, 200)); st = ED.state(); }
	const recs = fs.existsSync(arm.evlog) ? fs.readFileSync(arm.evlog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	const out = { strategies: st.strategies.map((q) => ({ key: q.key, label: q.label, cpu: q.cpu, detail: q.detail, state: q.state })), spawns: recs.filter((r) => r.ev === 'spawn').map((r) => ({ k: r.k, args: r.args })),
		result: st.result ? { runTicks: st.result.runTicks, strategy: st.result.strategy } : null, log: st.log ? st.log.slice(-12) : [], running: st.running };
	process.stdout.write(`ARM ${JSON.stringify(out)}\n`);
	ED.shutdown();
	setTimeout(() => process.exit(0), 300);
}
function request(port, method, p, body) {
	return new Promise((resolve) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => { const b = Buffer.concat(chunks); let json = null; try { json = JSON.parse(b.toString('utf8')); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, body: b }); });
		});
		req.on('error', (e) => resolve({ status: 0, error: e.message }));
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}
/** the server in a temp home (EEAT_HOME set by the parent): the COMPILE action's HTTP API */
async function armApi(arm) {
	const SV = require(path.join(ROOT, 'src', 'server.js'));
	const C = require(path.join(ROOT, 'src', 'common.js'));
	const T = require(path.join(ROOT, 'src', 'plan', 'types.js'));
	await new Promise((res) => SV.server.listen(0, '127.0.0.1', res));
	const port = SV.server.address().port;
	const out = {};
	const waitDone = async (ms) => { const t0 = Date.now(); let r; do { await new Promise((z) => setTimeout(z, 250)); r = await request(port, 'GET', '/api/editor/compile'); } while (r.json && r.json.running && Date.now() - t0 < ms); return r.json; };
	try {
		const list = await request(port, 'GET', '/api');
		out.endpoints = (list.json && list.json.endpoints || []).filter((e) => /compile/.test(e.path)).map((e) => `${e.method} ${e.path}`);
		out.idle = (await request(port, 'GET', '/api/editor/compile')).json;
		process.env.PLANMOCK_MODE = 'normal';
		const r1 = await request(port, 'POST', '/api/editor/compile', { eelvlB64: arm.toy, seconds: 10, workers: 1, name: 'plan toy' });
		out.post = { status: r1.status, running: r1.json && r1.json.running };
		out.done = await waitDone(60000);
		if (out.done && out.done.loadtas) {
			const f = out.done.loadtas.replace(/^\/loadtas /, '');
			out.file = f;
			out.fileExists = fs.existsSync(f);
			out.underJobs = path.resolve(f).startsWith(path.resolve(C.JOBS));
			try {
				const J = require(path.join(ROOT, 'src', 'jobs.js'));
				const ev = C.evaluate(J.loadJobLevel(out.done.job), C.readEetas(f));
				out.replay = ev ? { runTicks: ev.runTicks, deaths: ev.deaths } : null;
			} catch (e) { out.replayError = e.message; }
		}
		// (one at a time; stop)
		process.env.PLANMOCK_MODE = 'stuck';
		const r2 = await request(port, 'POST', '/api/editor/compile', { eelvlB64: arm.toy, seconds: 30, workers: 1, name: 'stuck' });
		const r3 = await request(port, 'POST', '/api/editor/compile', { eelvlB64: arm.toy, seconds: 30, workers: 1, name: 'second' });
		out.second = { first: r2.status, again: r3.status, error: r3.json && r3.json.error };
		await new Promise((z) => setTimeout(z, 1500));
		const r4 = await request(port, 'POST', '/api/editor/compile/stop', {});
		out.stopReply = r4.status;
		out.stopped = await waitDone(15000);
		process.env.PLANMOCK_MODE = 'normal';
		// (a level without a trophy: refused with its problems)
		const r5 = await request(port, 'POST', '/api/editor/compile', { eelvlB64: arm.notrophy, seconds: 5 });
		out.bad = { status: r5.status, error: r5.json && r5.json.error, problems: r5.json && Array.isArray(r5.json.problems) ? r5.json.problems.length : 0 };
		out.page = (await request(port, 'GET', '/editor')).status;
	} catch (e) { out.error = e.stack; }
	process.stdout.write(`ARM ${JSON.stringify(out)}\n`);
	SV.server.close();
	setTimeout(() => process.exit(0), 300);
}
function runArm(arm, env, timeoutMs) {
	const r = spawnSync(process.execPath, [__filename, `--arm=${Buffer.from(JSON.stringify(arm)).toString('base64')}`], { encoding: 'utf8', timeout: timeoutMs, env: Object.assign({}, process.env, env) });
	const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('ARM '));
	if (!line) return { error: `no ARM line (exit ${r.status}): ${String(r.stdout || '').slice(-800)} ${String(r.stderr || '').slice(-1500)}` };
	return JSON.parse(line.slice(4));
}

// ---------------------------------------------------------------- unit: the CLI with the mock parts
function sectionUnit(TMP) {
	console.log('(unit) T-COMPILE-UNIT: node src/compile.js on the plan toy with the mock parts');
	const C = require('../src/common.js');
	const T = require('../src/plan/types.js');
	const toy = path.join(TMP, 'toy.eelvl');
	fs.writeFileSync(toy, eelvlOfRows(TOY, 'plan toy'));
	const L = T.loadLevelFile(toy);
	const outF = path.join(TMP, 'out', 'toy.eetas'), rep = path.join(TMP, 'out', 'toy.json');
	const cli = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'compile.js'), ...args], { encoding: 'utf8', timeout: 90000, env: Object.assign({}, process.env, { PLANMOCK_MODE: 'normal' }, env || {}) });
	let r = cli([toy, `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=10', '--workers=1', `--out=${outF}`, `--report=${rep}`]);
	const lines = String(r.stdout || '').split('\n').filter(Boolean);
	const names = lines.map((l) => l.split(/\s+/)[0]);
	const order = ['parse', 'model', 'bounds', 'plan', 'moves', 'verify', 'polish', 'prove', 'result', 'wrote'];
	check('the stage lines, like a compiler: parse, model, bounds, plan, moves, verify, polish, prove (each with its time), result, wrote; exit 0',
		r.status === 0 && order.every((n) => names.includes(n)) && order.every((n, i) => i === 0 || names.indexOf(n) > names.indexOf(order[i - 1])) &&
		lines.filter((l) => /^(parse|model|bounds|plan|moves|verify|polish|prove)\s+\d+\.\d\d s  /.test(l)).length === 8, `exit ${r.status}\n${lines.join('\n')}\n${String(r.stderr || '').slice(-400)}`);
	const ev = fs.existsSync(outF) ? C.evaluate(L, C.readEetas(outF)) : null;
	const rj = fs.existsSync(rep) ? JSON.parse(fs.readFileSync(rep, 'utf8')) : null;
	check('the .eetas written: it finishes (C.evaluate), cut at the finish, the run ticks the result line\'s and the report\'s',
		!!ev && ev.complete === C.readEetas(outF).length && !!rj && rj.ok && rj.runTicks === ev.runTicks && new RegExp(`^result\\s+${ev.runTicks.toLocaleString('en-US')} run ticks`).test(lines.find((l) => l.startsWith('result')) || ''),
		ev ? `${ev.runTicks} run ticks, ${ev.complete} ticks` : 'no file');
	check('the report: lb (admissible, from the planner), gap = run ticks - lb, the legs (label, fromTick, ticks, lb, proven, tool), stages in ms, the /loadtas line',
		!!rj && rj.lb > 0 && rj.gap === rj.runTicks - rj.lb && Array.isArray(rj.legs) && rj.legs.length === 2 && rj.legs.every((g) => typeof g.label === 'string' && Number.isFinite(g.ticks) && 'proven' in g && 'tool' in g) &&
		['parse', 'model', 'bounds', 'plan', 'moves', 'verify', 'polish'].every((k) => Number.isFinite(rj.stages[k])) && rj.loadtas === `/loadtas ${outF}`,
		rj ? JSON.stringify({ lb: rj.lb, gap: rj.gap, legs: rj.legs, stages: rj.stages }) : 'none');
	// (exit 2: no route; the reason and where it stalled)
	r = cli([toy, `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=8', '--workers=1', `--out=${path.join(TMP, 'out', 'none.eetas')}`], { PLANMOCK_MODE: 'fail' });
	const l2 = String(r.stdout || '').split('\n').filter(Boolean);
	check('no route (a failing executor): exit 2, no .eetas, the result line says why and where it stalled (the most progress, the last failures)',
		r.status === 2 && !fs.existsSync(path.join(TMP, 'out', 'none.eetas')) && /^result\s+no route \(end \w+\): .*the most progress: anchor .*last failures/.test(l2.find((l) => l.startsWith('result')) || ''),
		`exit ${r.status}: ${(l2.find((l) => l.startsWith('result')) || '').slice(0, 300)}`);
	// (exit 1: an error)
	r = cli([path.join(TMP, 'nope.eelvl'), `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=5']);
	check('a missing level: exit 1 with an error line', r.status === 1 && /^error\s/.test(String(r.stdout || '')), `exit ${r.status}: ${String(r.stdout || '').slice(0, 200)}`);
	// (the hard watchdog: a part's synchronous call that ignores its budget blocks the compile's thread; the watchdog
	// thread ends the process past its limit with the reason and the last stage: never a compile that hangs)
	const tw0 = Date.now();
	r = cli([toy, `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=2', '--workers=1', `--out=${path.join(TMP, 'out', 'wd.eetas')}`], { PLANMOCK_MODE: 'block', EEAT_COMPILE_WATCHDOG_S: '3' });
	const twS = (Date.now() - tw0) / 1000;
	check('the hard watchdog: a part blocked in a synchronous call (the mock\'s lowerBound busy-waiting) ends at the limit (3 s): exit 1, "error    the watchdog: ... blocked after the stage model"',
		r.status === 1 && twS < 20 && /^error\s+the watchdog: the compile passed its hard limit of 3 s, blocked after the stage model/m.test(String(r.stdout || '')), `exit ${r.status} after ${twS.toFixed(1)} s: ${String(r.stdout || '').slice(-300)}`);
	// (--json: the events)
	r = cli([toy, `--parts=${path.join(__dirname, 'planmock.js')}`, '--seconds=10', '--workers=1', '--json', `--out=${path.join(TMP, 'out', 'toy2.eetas')}`]);
	const jl = String(r.stdout || '').split('\n').filter(Boolean);
	let evs = [];
	try { evs = jl.map((l) => JSON.parse(l)); } catch (e) { evs = null; }
	const kinds = evs ? new Set(evs.map((e) => e.ev)) : new Set();
	const rep2 = evs ? evs.find((e) => e.ev === 'report') : null;
	check('--json: every line a JSON event (stage x9 with joins, result, progress, done, report last), exit 0; the report\'s inputs finish',
		r.status === 0 && !!evs && evs.filter((e) => e.ev === 'stage').length === 9 && evs.some((e) => e.ev === 'stage' && e.name === 'joins') &&['result', 'progress', 'done', 'report'].every((k) => kinds.has(k)) && evs[evs.length - 1].ev === 'report' && !!rep2 &&
		!!C.evaluate(L, T.masksOf(rep2.inputs)), `exit ${r.status}, ${jl.length} lines, ${[...kinds].join(',')}`);
}

// ---------------------------------------------------------------- real: the real parts, when they exist
function sectionReal(TMP) {
	console.log('(real) the compiler with the real parts (src/plan/model.js, facts.js, planner.js, executor.js)');
	const missing = ['model.js', 'facts.js', 'planner.js', 'executor.js'].filter((f) => !fs.existsSync(path.join(ROOT, 'src', 'plan', f)));
	if (missing.length) { console.log(`  skipped: ${missing.join(', ')} not built yet`); return; }
	const C = require('../src/common.js');
	const T = require('../src/plan/types.js');
	const toy = path.join(TMP, 'toy_real.eelvl');
	fs.writeFileSync(toy, eelvlOfRows(TOY, 'plan toy'));
	const L = T.loadLevelFile(toy);
	const outF = path.join(TMP, 'out', 'toy_real.eetas');
	const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'compile.js'), toy, '--seconds=30', '--workers=2', `--out=${outF}`, `--report=${outF}.json`], { encoding: 'utf8', timeout: 120000 });
	const lines = String(r.stdout || '').split('\n').filter(Boolean);
	const ev = fs.existsSync(outF) ? C.evaluate(L, C.readEetas(outF)) : null;
	check('the real parts compile the toy: exit 0, the stage lines, the .eetas finishes', r.status === 0 && !!ev && lines.some((l) => l.startsWith('result')), `exit ${r.status}\n${lines.join('\n')}\n${String(r.stderr || '').slice(-600)}`);
	// (the PROVE stage: the executor's exact tier from the start after 0..R idle ticks, bounded by the route's own cost,
	// exhausted: PROVEN OPTIMAL, lb = the route's run ticks)
	const rj = fs.existsSync(`${outF}.json`) ? JSON.parse(fs.readFileSync(`${outF}.json`, 'utf8')) : null;
	check('the real parts PROVE the toy\'s route optimal: the prove line "PROVEN", the report\'s lb = its run ticks, lbProof, gap 0',
		!!rj && lines.some((l) => /^prove\s.*PROVEN/.test(l)) && rj.lb === rj.runTicks && !!rj.lbProof && rj.gap === 0 && ev && ev.runTicks === rj.runTicks,
		rj ? `lb ${rj.lb}, run ticks ${rj.runTicks}, gap ${rj.gap}: ${rj.lbProof || lines.find((l) => l.startsWith('prove')) || ''}` : 'no report');
}

// ---------------------------------------------------------------- off: T-OFF
function mainStrategyKeys() {
	const src = execSync('git show origin/main:src/editor.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
	const a = src.indexOf('\nconst STRATEGIES = {\n'), b = src.indexOf('\n};\n', a);
	return { keys: [...src.slice(a, b).matchAll(/^\t(\w+): \{/gm)].map((m) => m[1]), src };
}
function sectionOff(TMP) {
	console.log('(off) T-OFF: EEAT_PLAN unset = origin/main\'s editor; EEAT_PLAN=1 the planner');
	delete process.env.EEAT_PLAN;
	const ED = require('../src/editor.js');
	const M = mainStrategyKeys();
	check('editor.STRATEGIES\' keys = origin/main\'s (the planner kept out of it: stratOf)', JSON.stringify(Object.keys(ED.STRATEGIES)) === JSON.stringify(M.keys) && !('plan' in ED.STRATEGIES) && ED.stratOf('plan').label === 'the planner (compile)',
		`${Object.keys(ED.STRATEGIES).join(',')} vs main ${M.keys.join(',')}`);
	// (a tree = this src/ with origin/main's editor.js)
	const mainSrc = path.join(TMP, 'main', 'src');
	fs.cpSync(path.join(ROOT, 'src'), mainSrc, { recursive: true, filter: (f) => !/[\\/]src[\\/](out|jobs|data)([\\/]|$)/.test(f) });
	fs.writeFileSync(path.join(mainSrc, 'editor.js'), M.src);
	// (the stand-ins: a CPU search, the path skips, a planner; the level: 60 x 60 (coarse cells: the path skips and the
	// escape are in the search) with the toy's key, door and trophy)
	const cpu = path.join(TMP, 'fakecpu.js'), plan = path.join(TMP, 'fakeplan.js');
	fs.writeFileSync(cpu, "process.stdout.write(JSON.stringify({ev:'start'})+'\\n');setInterval(()=>process.stdout.write(JSON.stringify({ev:'progress',states:1,layer:0,ticksPerSec:0,workers:1})+'\\n'),400);process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));\n");
	const route = '4'.repeat(1200);
	fs.writeFileSync(plan, `const a=process.argv.slice(2);const say=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');say({ev:'start',args:a});` +
		`say({ev:'progress',states:2,layer:40,detail:'plan: step 1/2 \\'key red\\' rung 0 · 1 anchor'});setTimeout(()=>{say({ev:'source',kind:'room',room:1,key:'k1',tick:40,inputs:'${'4'.repeat(40)}'});` +
		`say({ev:'result',kind:'finish',ticks:9,runTicks:9,inputs:'${route}'});say({ev:'progress',states:2,layer:40,detail:'plan: step 2/2 \\'trophy\\' rung 0 (ok) · 2 anchors · route'});},600);` +
		`process.stdin.on('data',(d)=>{require('fs').appendFileSync(${JSON.stringify(path.join(TMP, 'plan_stdin.txt'))},d);});process.stdin.on('end',()=>process.exit(0));\n`);
	const rows = [];
	for (let y = 0; y < 60; y++) rows.push(y === 0 || y === 59 ? '#'.repeat(60) : `#${'.'.repeat(58)}#`);
	rows[58] = `#S....k.........d..T${'.'.repeat(39)}#`;
	const eelvlB64 = eelvlOfRows(rows, 'off level').toString('base64');
	const test = { cpu: [process.execPath, cpu], skips: true, laneCmd: [process.execPath, cpu], escape: true, escapeCmd: [process.execPath, cpu], planCmd: [process.execPath, plan], precision: false, prover: false, steerWaitMs: 0 };
	const arm = (src, home, evlog, env) => { fs.mkdirSync(home, { recursive: true }); try { fs.unlinkSync(evlog); } catch (e) { /* none */ } return runArm({ kind: 'search', src, eelvlB64, seconds: 4, workers: 4, test, evlog }, Object.assign({ EEAT_HOME: home, EEAT_EVLOG: evlog, EEAT_PLAN: '' }, env || {}), 90000); };
	const home = path.join(TMP, 'home');
	const mainArm = arm(mainSrc, home, path.join(TMP, 'ev_main.jsonl'));
	const offArm = arm(path.join(ROOT, 'src'), home, path.join(TMP, 'ev_off.jsonl'));
	const sig = (x) => JSON.stringify({ s: (x.strategies || []).map((q) => [q.key, q.label, q.cpu]), sp: (x.spawns || []).map((r) => [r.k, r.args]) });
	check('EEAT_PLAN unset: the same strategies (keys, labels) and the same launched argument lists as origin/main\'s editor.js (EEAT_EVLOG\'s spawn records)',
		!mainArm.error && !offArm.error && (mainArm.spawns || []).length >= 2 && sig(mainArm) === sig(offArm) && !(offArm.strategies || []).some((q) => q.key === 'plan'),
		mainArm.error || offArm.error || `main ${(mainArm.spawns || []).map((r) => r.k).join(',')} / this ${(offArm.spawns || []).map((r) => r.k).join(',')}${sig(mainArm) === sig(offArm) ? '' : `\n${sig(mainArm)}\n${sig(offArm)}`}`);
	const onArm = arm(path.join(ROOT, 'src'), home, path.join(TMP, 'ev_on.jsonl'), { EEAT_PLAN: '1' });
	const pq = (onArm.strategies || []).find((q) => q.key === 'plan');
	const ps = (onArm.spawns || []).find((r) => r.k === 'plan');
	check('EEAT_PLAN=1: the strategy "plan" ("the planner (compile)", a CPU strategy) runs src/plan.js <level> --seconds --workers --stdin=1; its status line is the row\'s detail',
		!onArm.error && !!pq && pq.label === 'the planner (compile)' && pq.cpu && !!ps && ps.args.some((x) => /--stdin=1/.test(x)) && ps.args.some((x) => /^--seconds=\d+/.test(x)) && ps.args.some((x) => /^--workers=\d+/.test(x)) &&
		/^plan: step 2\/2 'trophy'/.test(pq.detail || ''), onArm.error || `${JSON.stringify(pq)} ${JSON.stringify(ps)}`);
	check('EEAT_PLAN=1: its route is the search\'s (found(): replayed, S.result by "the planner (compile)")', !!onArm.result && /the planner \(compile\)/.test(onArm.result.strategy || '') && onArm.result.runTicks > 0,
		JSON.stringify(onArm.result));
	const others = (x) => JSON.stringify((x.spawns || []).filter((r) => r.k !== 'plan').map((r) => [r.k, r.args]));
	check('EEAT_PLAN=1: the other strategies\' argument lists unchanged (4 workers: the planner takes its quarter from the idle threads or from the CPU search, as the path skips)',
		others(onArm) === others(offArm) || (onArm.spawns || []).filter((r) => r.k !== 'plan').length === (offArm.spawns || []).length, `${others(onArm)}\n${others(offArm)}`);
	const stdinTxt = fs.existsSync(path.join(TMP, 'plan_stdin.txt')) ? fs.readFileSync(path.join(TMP, 'plan_stdin.txt'), 'utf8') : '';
	check('EEAT_PLAN=1: the planner is told the search\'s bound (stdin "depth D"; "route <inputs>" when another strategy found it)', /depth \d+/.test(stdinTxt), stdinTxt.slice(0, 120));
	// (the body's plan: true alone turns it on too)
	const bodyOn = require('../src/editor.js').planOn({ plan: true }) && !require('../src/editor.js').planOn({}) && !require('../src/editor.js').planOn({ plan: 'yes' });
	check('the switch: EEAT_PLAN=1 or the body\'s plan: true (exactly true), nothing else', bodyOn, String(bodyOn));
}

// ---------------------------------------------------------------- api: T-COMPILE-API
function sectionApi(TMP) {
	console.log('(api) T-COMPILE-API: POST / GET / stop /api/editor/compile (the server in a temp home, the mock parts)');
	const home = path.join(TMP, 'apihome');
	fs.mkdirSync(home, { recursive: true });
	const x = runArm({ kind: 'api', toy: eelvlOfRows(TOY, 'plan toy').toString('base64'), notrophy: eelvlOfRows(NOTROPHY, 'no trophy').toString('base64') },
		{ EEAT_HOME: home, EEAT_COMPILE_PARTS: path.join(__dirname, 'planmock.js'), EEAT_PLAN: '' }, 180000);
	check('GET /api lists the compile routes', !x.error && JSON.stringify(x.endpoints) === JSON.stringify(['POST /api/editor/compile', 'GET /api/editor/compile', 'POST /api/editor/compile/stop']), x.error || JSON.stringify(x.endpoints));
	check('GET before any compile: {running: false, stage: none}', !!x.idle && x.idle.running === false && x.idle.stage === 'none', JSON.stringify(x.idle));
	const d = x.done || {};
	const names = (d.stages || []).map((s) => s.name);
	check('POST: 200 running; then the stage lines parse, model, bounds, plan, moves, verify, polish, prove, joins (each {name, ms, text}), stage "done", a result {runTicks, time, lb, gap, legs}',
		!!x.post && x.post.status === 200 && x.post.running === true && JSON.stringify(names) === JSON.stringify(['parse', 'model', 'bounds', 'plan', 'moves', 'verify', 'polish', 'prove', 'joins']) && d.stage === 'done' &&
		!!d.result && d.result.runTicks > 0 && /^\d+:\d\d\.\d\d$/.test(d.result.time) && d.result.lb > 0 && d.result.gap === d.result.runTicks - d.result.lb && Array.isArray(d.result.legs),
		JSON.stringify({ post: x.post, stage: d.stage, names, result: d.result, message: d.message }).slice(0, 600));
	check('a job made from the route; loadtas = "/loadtas <the job\'s best.eetas>": the file exists under the jobs folder and finishes with the result\'s run ticks',
		!!d.job && /^\/loadtas /.test(d.loadtas || '') && x.fileExists && x.underJobs && /best\.eetas$/.test(x.file || '') && !!x.replay && x.replay.runTicks === d.result.runTicks,
		`${d.job} ${d.loadtas} exists ${x.fileExists} replay ${JSON.stringify(x.replay)} ${x.replayError || ''}`);
	check('one at a time: a second POST while one runs is refused (400)', !!x.second && x.second.first === 200 && x.second.again === 400 && /already running/.test(x.second.error || ''), JSON.stringify(x.second));
	check('POST stop: the compile stops (stage "stopped", no job, no loadtas)', x.stopReply === 200 && !!x.stopped && x.stopped.running === false && x.stopped.stage === 'stopped' && !x.stopped.loadtas,
		JSON.stringify(x.stopped).slice(0, 300));
	check('a level without a trophy: 400 with its problems', !!x.bad && x.bad.status === 400 && x.bad.problems >= 1, JSON.stringify(x.bad));
	const page = fs.readFileSync(path.join(ROOT, 'src', 'app', 'editor.html'), 'utf8');
	const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	let perr = null;
	for (const s of scripts) { try { new Function(s); } catch (e) { perr = e.message; } }
	check('the page: its script parses; the Compile button, its panel, the clipboard copy with a read-only field and a Copy button', x.page === 200 && !perr && /id="bCompile"/.test(page) && /id="compileSt"/.test(page) &&
		/navigator\.clipboard\.writeText\(s\.loadtas\)/.test(page) && /id="cmpLine" readonly/.test(page) && /\/api\/editor\/compile/.test(page), perr || `page ${x.page}`);
}

// ---------------------------------------------------------------- page: the page's Compile code, cut out and run on stubs
async function sectionPage() {
	console.log('(page) the editor page\'s Compile code (cut out of editor.html, run against stubs)');
	const page = fs.readFileSync(path.join(ROOT, 'src', 'app', 'editor.html'), 'utf8');
	const a = page.indexOf('// ------------------------------------------------------------ Compile (POST'), b = page.indexOf("$('bCompile').onclick = compileLevel;");
	if (a < 0 || b < 0) { check('the Compile section is in the page', false, `${a} ${b}`); return; }
	const code = page.slice(a, b + "$('bCompile').onclick = compileLevel;".length);
	const els = new Map();
	const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', disabled: false, value: '', onclick: null, focus() {}, select() {} }); return els.get(id); };
	// ($: an element made by an innerHTML (the Stop / Copy buttons, the line) exists only while that HTML holds its id)
	const $ = (id) => {
		if (['bCmpStop', 'bCmpCopy', 'cmpLine', 'cmpOpen'].includes(id)) { if (!el('compileSt').innerHTML.includes(`id="${id}"`)) return null; const e = el(id); const m = new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(el('compileSt').innerHTML); if (m) e.value = m[1].replace(/&amp;/g, '&'); return e; }
		return el(id);
	};
	el('sSec').value = '60';
	const toasts = [], clip = [];
	let clipOk = true, apiState = null;
	const env = {
		$, esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
		fmt: (t) => `${Math.floor(t / 6000)}:${((t % 6000) / 100).toFixed(2).padStart(5, '0')}`,
		api: async () => apiState, postJson: async () => apiState, eelvlBytes: async () => new Uint8Array(4), b64: () => 'AAAA', fileSource: () => null, LV: { name: 'toy' },
		store: { set() {}, get() { return null; } }, toast: (h, err) => toasts.push({ h, err: !!err }),
		navigator: { clipboard: { writeText: async (s) => { if (!clipOk) throw new Error('denied'); clip.push(s); } } },
		document: { execCommand: () => true }, setTimeout: () => 0, clearTimeout: () => {},
	};
	const run = new Function(...Object.keys(env), `${code}\nreturn { CMPL, compileLevel, pollCompile, renderCompile, copyLoadtas };`)(...Object.values(env));
	const stages = [{ name: 'parse', ms: 10, text: 'toy.eelvl 22x6' }, { name: 'model', ms: 5, text: '2 triggers' }];
	// (a compile this page started, running)
	apiState = { running: true, started: 111, stage: 'model', stages, detail: 'plan: step 1/2', elapsed: 1.2, seconds: 60 };
	await run.compileLevel();
	const h1 = el('compileSt').innerHTML;
	check('running: the stage lines like a compiler (name, seconds, text), the status line, a Stop button; the Compile button disabled',
		/parse {3}\s*0\.01 s {2}toy\.eelvl 22x6/.test(h1) && /model {3}\s*0\.01 s {2}2 triggers/.test(h1) && /plan: step 1\/2/.test(h1) && /id="bCmpStop"/.test(h1) && el('bCompile').disabled === true, h1.slice(0, 300));
	// (done: the line to the clipboard, the toast, the field with a Copy button, the job link)
	const done = { running: false, started: 111, stage: 'done', stages: stages.concat([{ name: 'polish', ms: 0, text: 'no gain' }]), job: 'toy-compiled-abc123', loadtas: '/loadtas C:\\jobs\\toy-compiled-abc123\\best.eetas',
		result: { runTicks: 83, time: '0:00.83', lb: 17, lbTime: '0:00.17', gapPct: 79.5, legs: [{}, {}], provenLegs: 1, known: null }, message: 'Compiled', elapsed: 3, seconds: 60 };
	apiState = done;
	await run.pollCompile();
	await new Promise((r) => setImmediate(r));
	const h2 = el('compileSt').innerHTML;
	check('done: the /loadtas line copied to the clipboard, the toast "Compiled: 0:00.83 (lower bound 0:00.17), /loadtas line copied", the result row, the field and its Copy button, the job link',
		clip.length === 1 && clip[0] === done.loadtas && toasts.some((t) => /Compiled: <b>0:00\.83<\/b> \(lower bound 0:00\.17\), \/loadtas line copied/.test(t.h) && !t.err) &&
		/result {3}\s+83 run ticks \(0:00\.83\); lower bound 17 \(gap 79\.5%\); proven legs 1 of 2/.test(h2) && /id="cmpLine" readonly value="\/loadtas C:\\jobs\\toy-compiled-abc123\\best\.eetas"/.test(h2) &&
		/id="bCmpCopy"/.test(h2) && /#watch=toy-compiled-abc123/.test(h2) && el('bCompile').disabled === false, `${JSON.stringify(clip)} ${JSON.stringify(toasts)} ${h2.slice(0, 400)}`);
	await run.pollCompile();
	check('told once: polling the same done compile again copies nothing more', clip.length === 1 && toasts.filter((t) => /Compiled/.test(t.h)).length === 1, `${clip.length} copies`);
	// (the clipboard refused: the read-only field, a toast saying so)
	clipOk = false;
	apiState = Object.assign({}, done, { started: 222 });
	run.CMPL.mine = 222;
	await run.pollCompile();
	await new Promise((r) => setImmediate(r));
	const h3 = el('compileSt').innerHTML;
	check('the clipboard refused: the toast says to copy the line below; the read-only field with the line and a Copy button stay, a note under it',
		toasts.some((t) => /the browser refused the clipboard/.test(t.h)) && /id="cmpLine" readonly/.test(h3) && /id="bCmpCopy"/.test(h3) && /refused the clipboard: copy the line above/.test(h3), h3.slice(-300));
	// (a compile another page started: no clipboard, no toast)
	const n0 = toasts.length;
	clipOk = true;
	apiState = Object.assign({}, done, { started: 333 });
	await run.pollCompile();
	check('a compile this page did not start: its lines shown, no clipboard, no toast', toasts.length === n0 && clip.length === 1 && /cmpLine/.test(el('compileSt').innerHTML), `${toasts.length - n0} toasts`);
	// (no route: the reason)
	apiState = { running: false, started: 444, stage: 'no route', stages, message: 'no route (end exhausted): the most progress ...', elapsed: 60, seconds: 60 };
	run.CMPL.mine = 444;
	await run.pollCompile();
	check('no route: the message in an error box and an error toast', /class="msg err">Compile: no route \(end exhausted\)/.test(el('compileSt').innerHTML) && toasts[toasts.length - 1].err, el('compileSt').innerHTML.slice(-200));
}

// ---------------------------------------------------------------- truth: src/plan/truth.js on a toy truth root
function sectionTruth(TMP) {
	console.log('(truth) src/plan/truth.js --part=compile,model on a toy truth root (the mock parts)');
	const root = path.join(TMP, 'truthroot'), lv = path.join(root, 'src', 'out', 'god', 'levels', 'campaign');
	fs.mkdirSync(lv, { recursive: true });
	fs.writeFileSync(path.join(lv, '00_toy.eelvl'), eelvlOfRows(TOY, 'plan toy'));
	fs.writeFileSync(path.join(lv, '01_notrophy.eelvl'), eelvlOfRows(NOTROPHY, 'no trophy'));
	const out = path.join(TMP, 'truthout');
	const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'plan', 'truth.js'), '--part=model,compile', '--sets=campaign', '--seconds=8', '--workers=2', `--root=${root}`, `--out=${out}`, `--parts=${path.join(__dirname, 'planmock.js')}`],
		{ encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { PLANMOCK_MODE: 'normal' }) });
	const rows = fs.existsSync(path.join(out, 'truth.jsonl')) ? fs.readFileSync(path.join(out, 'truth.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
	const lv0 = rows.find((x) => x.kind === 'level' && x.name === '00_toy'), lv1 = rows.find((x) => x.kind === 'level' && x.name === '01_notrophy');
	const tot = rows.find((x) => x.kind === 'totals');
	const md = fs.existsSync(path.join(out, 'truth.md')) ? fs.readFileSync(path.join(out, 'truth.md'), 'utf8') : '';
	check('truth.js: the parts\' tests absent -> "absent" rows; T-E2E: the toy routed, its output verified here, the level without a trophy not (its reason), the totals; truth.md tables',
		!!lv0 && lv0.routed && lv0.verified === true && lv0.runTicks > 0 && lv0.lb > 0 && !!lv1 && !lv1.routed && !!lv1.why && !!tot && tot.routed === 1 && tot.unverified === 0 &&
		rows.some((x) => x.kind === 'part' && (x.status === 'absent' || x.status === 'pass' || x.status === 'fail')) && /## T-E2E/.test(md) && /\| campaign \| 00_toy \| yes \|/.test(md),
		`exit ${r.status}; ${JSON.stringify({ lv0: lv0 && { routed: lv0.routed, verified: lv0.verified, runTicks: lv0.runTicks }, lv1: lv1 && lv1.why, tot })}\n${String(r.stdout || '').slice(-600)}`);
}

(async () => {
	if (argv('arm')) { await armMain(); return; }
	const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plancompile-'));
	fs.mkdirSync(path.join(TMP, 'out'), { recursive: true });
	try {
		if (want('unit')) sectionUnit(TMP);
		if (want('real')) sectionReal(TMP);
		if (want('off')) sectionOff(TMP);
		if (want('api')) sectionApi(TMP);
		if (want('truth')) sectionTruth(TMP);
		if (want('page')) await sectionPage();
	} finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* busy */ } }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(1); });
