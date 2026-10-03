'use strict';
// test/exeargs.js - the app's Node children as EEAutoTAS.exe starts them (v1.8.1; the v1.8.0 bug: in the exe every Compile
// and Hybrid (best) opened two browser tabs on the main page and ran without the compiler's stretch and chain children).
// The exe (tools/exe/launcher.js, a Node single executable application) reads its command line itself: Node reads none of
// it, the first argument is the script to run, and a command line with no script starts the web app (which, its port
// taken, opens a browser tab and exits). So a child must be started as `execPath <script.js> ...` with its heap in
// NODE_OPTIONS, never `execPath --max-old-space-size=N <script.js>` (src/plan/strategy.js did, for the stretch child,
// the whole-level / chain child and the one shot's process).
//   plan    the launcher's own rule (its planOf, cut out of launcher.js between `// <plan>` and `// </plan>` and run here):
//           a script runs, Node options before a script are dropped with a note (never the app), the app's own options
//           start the app, an option the app does not have never starts it
//   static  every spawn / execFile / fork of process.execPath in the files the exe packs (src/, tools/hybrid.js,
//           tools/perfect/joins.js, tools/stats-import.js): no Node option before the script, no execArgv
//   compile a real compile (src/compile.js) on a toy level with its children started the way the exe starts them: a
//           preload hook sends every `execPath <args>` through a stand-in for the exe (planOf, then the script with
//           Module.runMain, as launcher.js does); the stretch child and the chain child run as scripts with their heap
//           (their V8 heap limit as given) and nothing starts the app; with EEAT_ONESHOT=1 the one shot's process too,
//           its IPC channel up
// Usage: node test/exeargs.js [--only=plan,static,compile]
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).filter((s) => s.startsWith('--')).map((s) => { const [k, ...v] = s.slice(2).split('='); return [k, v.length ? v.join('=') : '1']; }));
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const on = (k) => !ONLY || ONLY.has(k);
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

const LAUNCHER = fs.readFileSync(path.join(ROOT, 'tools', 'exe', 'launcher.js'), 'utf8');
const planSrc = (() => {
	const m = /\/\/ <plan>[^\n]*\n([\s\S]*?)\/\/ <\/plan>/.exec(LAUNCHER);
	if (!m) throw new Error('tools/exe/launcher.js: no // <plan> ... // </plan> part');
	return m[1];
})();
const planOf = new Function(`${planSrc}\nreturn planOf;`)();

if (on('plan')) {
	const P = (a) => planOf(a.slice());
	let r = P(['C:/app/src/compile.js', 'lvl.eelvl', '--seconds=60']);
	ok(r.run === 'script' && r.script === 'C:/app/src/compile.js' && r.rest.join(' ') === 'lvl.eelvl --seconds=60' && !r.ignored.length, `plan: a script runs (${JSON.stringify(r)})`);
	r = P(['--max-old-space-size=1536', 'C:/app/src/plan/lab/stretch_child.js', 'lvl.eelvl']);
	ok(r.run === 'script' && /stretch_child\.js$/.test(r.script) && r.rest.join(' ') === 'lvl.eelvl' && r.ignored.join(' ') === '--max-old-space-size=1536',
		`plan: a Node option before a script is dropped, the script runs, never the app (${JSON.stringify(r)})`);
	r = P(['--expose-gc', '--stack-size=2000', 'x.mjs', '--a=1']);
	ok(r.run === 'script' && r.script === 'x.mjs' && r.ignored.length === 2 && r.rest[0] === '--a=1', `plan: several Node options, an .mjs (${JSON.stringify(r)})`);
	r = P(['--max-old-space-size=1536']);
	ok(r.run === 'error', `plan: a Node option with no script never starts the app (${JSON.stringify(r)})`);
	r = P([]);
	ok(r.run === 'app' && r.rest.join(' ') === '--open', `plan: a double-click starts the app and opens the browser (${JSON.stringify(r)})`);
	r = P(['--no-open', '--port=47900']);
	ok(r.run === 'app' && r.rest.join(' ') === '--port=47900', `plan: the app's own options (${JSON.stringify(r)})`);
	r = P(['--port=47900']);
	ok(r.run === 'app' && r.rest.join(' ') === '--open --port=47900', `plan: --port alone (${JSON.stringify(r)})`);
	r = P(['tas', 'import', 'a.eelvl', 'b.eetas', '--name=x']);
	ok(r.run === 'tas' && r.rest.join(' ') === 'import a.eelvl b.eetas --name=x', `plan: tas with its options (${JSON.stringify(r)})`);
	r = P(['stats-import', 'r.csv', '--name=x']);
	ok(r.run === 'stats-import' && r.rest.length === 2, `plan: stats-import (${JSON.stringify(r)})`);
	ok(P(['bench']).run === 'bench' && P(['--help']).run === 'help' && P(['help']).run === 'help', 'plan: bench, help');
}

if (on('static')) {
	// (the files the exe packs: tools/build-exe.js appFiles' src/ walk and its tools)
	const files = [];
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
			const r = `${rel}/${e.name}`;
			if (e.isDirectory()) { if (!['src/data', 'src/jobs', 'src/out'].includes(r)) walk(r); } else if (/\.js$/.test(e.name)) files.push(r);
		}
	};
	walk('src');
	for (const f of ['tools/hybrid.js', 'tools/perfect/joins.js', 'tools/stats-import.js']) files.push(f);
	let calls = 0;
	for (const f of files) {
		const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
		// a Node child with a literal argument list: its first element a Node option
		for (const m of s.matchAll(/(?:spawn|spawnSync|execFile|execFileSync)\(\s*process\.execPath\s*,\s*\[\s*([^,\]]*)/g)) {
			calls++;
			ok(!/^\s*['"`]-/.test(m[1]), `static: ${f}: a Node option before the script: ${m[0].slice(0, 120)}`);
		}
		// fork: no Node options (execArgv) on its command line either
		for (const m of s.matchAll(/execArgv\s*:\s*([^\n]*)/g)) ok(/^\[\s*\]/.test(m[1]), `static: ${f}: execArgv with Node options: ${m[0].slice(0, 120)}`);
	}
	ok(calls >= 10, `static: the scan saw the app's Node children (${calls} calls)`);
}

async function compileRun(label, env, wantOneShot) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exeargs-'));
	try {
		// the toy (test/s99stretch.js's room): a 64 x 20 room, a spike gap, the trophy past it, a coin behind the start
		const ED = require('../src/editor.js');
		const W = 64, H = 20, F = 16, cells = [];
		for (let x = 0; x < W; x++) { cells.push([x, 0, 9]); cells.push([x, H - 1, 9]); }
		for (let y = 0; y < H; y++) { cells.push([0, y, 9]); cells.push([W - 1, y, 9]); }
		for (let x = 1; x < W - 1; x++) if (x <= 30 || x >= 44) cells.push([x, F, 9]); else cells.push([x, H - 2, 361]);
		cells.push([30, 15, 255]); cells.push([48, 15, 121]); cells.push([27, 15, 100]);
		const file = path.join(dir, 'room.eelvl');
		fs.writeFileSync(file, ED.eelvlOf({ name: 'exeargs', width: W, height: H, cells }));
		const log = path.join(dir, 'launches.jsonl'), stub = path.join(dir, 'exe_stub.js'), hook = path.join(dir, 'hook.js');
		// the exe's stand-in: the launcher's rule, then the script as the launcher runs it (Module.runMain)
		fs.writeFileSync(stub, `'use strict';\nconst fs = require('fs'), path = require('path'), Module = require('module'), v8 = require('v8');\n${planSrc}\n` +
			`const plan = planOf(process.argv.slice(2));\n` +
			`const heap = /--max-old-space-size=(\\d+)/.exec(process.env.NODE_OPTIONS || '');\n` +
			`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ run: plan.run, script: plan.script ? path.basename(plan.script) : null, ignored: plan.ignored || [], heap: heap ? +heap[1] : null,\n` +
			`	limitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), ipc: typeof process.send === 'function' }) + '\\n');\n` +
			`if (plan.run !== 'script') process.exit(plan.run === 'error' ? 2 : 0);   // (the app: its port taken, a browser tab, then it exits)\n` +
			`process.argv = [process.argv[0], path.resolve(plan.script), ...plan.rest];\nModule.runMain();\n`);
		// every Node child of the compile through the stand-in, as the exe would get it: spawn(execPath, args) ->
		// exe args; fork(module, args, {execArgv}) -> exe execArgv module args (the exe's own execArgv is empty)
		fs.writeFileSync(hook, `'use strict';\nconst cp = require('child_process');\nconst STUB = ${JSON.stringify(stub)};\n` +
			`const sp = cp.spawn;\ncp.spawn = function (cmd, a, o) { if (cmd === process.execPath && Array.isArray(a)) return sp.call(this, cmd, [STUB, ...a], o); return sp.apply(this, arguments); };\n` +
			`const fk = cp.fork;\ncp.fork = function (mod, a, o) { if (!Array.isArray(a)) { o = a; a = []; } o = Object.assign({}, o); const ea = o.execArgv || []; o.execArgv = [];\n` +
			`	return fk.call(this, STUB, [...ea, mod, ...a], o); };\n`);
		const out = path.join(dir, 'route.eetas'), rep = path.join(dir, 'report.json');
		const e = Object.assign({}, process.env, env, { NODE_OPTIONS: `${(process.env.NODE_OPTIONS || '').replace(/--max[-_]old[-_]space[-_]size[= ]\d+/g, '').trim()} --require=${hook.replace(/\\/g, '/')}`.trim() });
		const r = await new Promise((res) => {
			const ch = cp.spawn(process.execPath, [path.join(ROOT, 'src', 'compile.js'), file, `--out=${out}`, `--report=${rep}`, '--seconds=10', '--workers=1', '--quiet', '--joins=0', '--endgame=0'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
			let err = '';
			ch.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
			ch.stdout.on('data', () => { /* the stages */ });
			const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (x) { /* gone */ } }, 120000);
			ch.on('close', (code) => { clearTimeout(t); res({ code, err }); });
		});
		const L = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : [];
		let report = null;
		try { report = JSON.parse(fs.readFileSync(rep, 'utf8')); } catch (x) { /* none */ }
		ok(r.code === 0 && report && report.ok !== false && fs.existsSync(out), `compile ${label}: the compile routed (exit ${r.code}; ${r.err.split('\n').filter(Boolean).slice(-2).join(' | ')})`);
		ok(L.length > 0 && L.every((x) => x.run === 'script'), `compile ${label}: every Node child ran as a script, none started the app (${JSON.stringify(L.map((x) => [x.run, x.script]))})`);
		ok(L.every((x) => !x.ignored.length), `compile ${label}: no Node option on a child's command line (${JSON.stringify(L.filter((x) => x.ignored.length))})`);
		for (const [name, want] of [['stretch_child.js', 1536], ['bwchain_child.js', 1536]]) {
			const x = L.find((y) => y.script === name);
			ok(!!x && x.heap === want && x.limitMB >= want && x.limitMB < want + 512, `compile ${label}: ${name} ran with its heap ${want} MB in NODE_OPTIONS (${JSON.stringify(x)})`);
		}
		ok(report && report.stretch && report.stretch.children >= 1, `compile ${label}: the compile's stretch child (report.stretch ${JSON.stringify(report && report.stretch)})`);
		if (wantOneShot) {
			const x = L.find((y) => y.script === 'osworker.js');
			ok(!!x && x.ipc && x.heap === 1536 && x.limitMB >= 1536, `compile ${label}: the one shot's process ran as a script with its IPC channel and its heap (${JSON.stringify(x)})`);
			ok(report && report.oneshot && !report.oneshot.error, `compile ${label}: the one shot answered (${JSON.stringify(report && report.oneshot && { error: report.oneshot.error, readyMs: report.oneshot.readyMs })})`);
		}
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (x) { /* busy */ }
	}
}

(async () => {
	if (on('compile')) {
		await compileRun('(the defaults)', {}, false);
		await compileRun('(EEAT_ONESHOT=1)', { EEAT_ONESHOT: '1' }, true);
	}
	console.log(`\nexeargs: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
