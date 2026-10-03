'use strict';
// EEAutoTAS.exe entry point: a Node single executable application built by tools/build-exe.js (Node is inside the
// exe, so it runs on a PC without Node). The app's files are embedded in the exe. On start they are unpacked once to
// %LOCALAPPDATA%\EEAutoTAS\app\<version>\ (the optimizer runs worker threads and child processes, which need real
// files), and the runs are kept in %LOCALAPPDATA%\EEAutoTAS\jobs (EEAT_HOME), so a newer exe keeps them.
//   EEAutoTAS.exe                   the web app (opens the browser), like START.bat; --port=N, --no-open
//   EEAutoTAS.exe tas <command>     the command line (src/tas.js), e.g. `EEAutoTAS.exe tas jobs`
//   EEAutoTAS.exe bench             measure the CPU's engine speed (src/bench.js)
//   EEAutoTAS.exe <file.js> [args]  run a script with the exe's Node (the app starts its own tools this way); Node options
//                                   before it are not read (a warning; a child's heap goes in NODE_OPTIONS: common.js
//                                   heapEnv), and an option the app does not have never starts the app
// Only Node built-ins can be require()d here; the app itself is loaded from the unpacked files with Module.runMain.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const sea = require('node:sea');

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
const HOME = path.resolve(process.env.EEAT_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'EEAutoTAS'));
const APP = path.join(HOME, 'app', manifest.version);
const EXE = process.execPath;
let interactive = false;   // started by a double-click (the web app): keep the window open on an error

/** Shows an error. A double-clicked window would close at once, so it waits for Enter first. */
function fatal(e) {
	console.error(`\nEE Auto TAS could not start: ${e && e.stack || e}`);
	if (!interactive || !process.stdin.isTTY) process.exit(1);
	console.error('\nPress Enter to close this window.');
	process.stdin.resume();
	process.stdin.once('data', () => process.exit(1));
}

/** Unpacks the embedded app files once per version (into a temp folder, then renamed: never half-written). */
function unpack() {
	const done = path.join(APP, '.complete');
	if (fs.existsSync(done)) return;
	if (fs.existsSync(APP)) fs.rmSync(APP, { recursive: true, force: true });   // left over from an interrupted copy
	const tmp = `${APP}.tmp${process.pid}`;
	fs.rmSync(tmp, { recursive: true, force: true });
	for (const f of manifest.files) {
		const p = path.join(tmp, f);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, Buffer.from(sea.getRawAsset(f)));
	}
	fs.writeFileSync(path.join(tmp, '.complete'), manifest.version);
	try {
		fs.renameSync(tmp, APP);
	} catch (e) {   // a second copy of the exe unpacked it at the same moment
		fs.rmSync(tmp, { recursive: true, force: true });
		if (!fs.existsSync(done)) throw e;
	}
}

/** Old versions of the app files: removed a week after a newer exe first ran (an old exe may still be open). */
function tidy() {
	const dir = path.join(HOME, 'app');
	const weekAgo = Date.now() - 7 * 86400e3;
	for (const v of fs.readdirSync(dir)) {
		if (v === manifest.version) continue;
		try {
			const p = path.join(dir, v);
			const done = path.join(p, '.complete');
			const t = fs.existsSync(done) ? fs.statSync(done).mtimeMs : 0;
			if (t < weekAgo || v.includes('.tmp')) fs.rmSync(p, { recursive: true, force: true });
		} catch (e) { /* in use: next time */ }
	}
}

/** CLAUDE.md / AGENTS.md in the data folder: start an AI assistant there and it knows how this exe version works. */
function aiGuide() {
	const q = (p) => `"${p}"`;
	const text = `# EE Auto TAS (the .exe version): guide for AI coding assistants

This folder holds the data of EE Auto TAS, an optimizer for Everybody Edits Offline TAS runs (\`.eetas\`), running as
**${path.basename(EXE)}** (Node is inside the exe; Node itself may not be installed on the computer).

- The exe: ${q(EXE)} (double-click = the web app at http://localhost:47823).
- The app's source, the full guide and the physics docs: ${q(APP)} (read \`CLAUDE.md\` there first: section 3 is the
  recipe for "at 1:10 I think X is possible").
- The runs (jobs) are here in \`jobs/\` (not in \`src/jobs/\` as the full guide says), the converted levels in \`data/\`.

Everywhere the full guide says \`node src/tas.js <command>\`, use:

    ${q(EXE)} tas <command>

and for a script (for example a copy of \`src/examples/idea_template.js\`, put in \`${path.join(HOME, 'out')}\`):

    ${q(EXE)} path\\to\\script.js

A script can require the app's modules by their full path, e.g.
\`require(${JSON.stringify(path.join(APP, 'src', 'jobs.js'))})\`. Hand runs in with \`tas try <job> <file.eetas>\`,
never by writing \`jobs/<id>/best.eetas\` yourself.
`;
	for (const name of ['CLAUDE.md', 'AGENTS.md']) {
		const p = path.join(HOME, name);
		try { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) fs.writeFileSync(p, text); } catch (e) { /* read-only */ }
	}
}

// <plan> (test/exeargs.js cuts this part out and runs it)
/** What a command line asks for (pure). { run: 'script', script, rest, ignored } | { run: 'tas' | 'bench' |
 *  'stats-import' | 'help', rest } | { run: 'app', rest: the server's arguments } | { run: 'error', text }.
 *  Node's own options before a script (`node --max-old-space-size=N tool.js`): this exe gets its whole command line and
 *  Node reads none of it, so they cannot take effect (a child's heap goes in NODE_OPTIONS: src/common.js heapEnv); the
 *  script runs without them (`ignored`). In v1.8.0 such a command line started the app instead: each of the compiler's
 *  children (src/plan/strategy.js) opened a browser tab on the running app and exited, and never ran. An option the app
 *  does not have never starts the app (it opens a browser tab), with or without a script. */
function planOf(args) {
	const isScript = (a) => /\.[cm]?js$/i.test(String(a || ''));
	const APP_OPT = /^(--port=\d+|--open|--no-open)$/;   // the web app's own (src/server.js, and --no-open here)
	let ignored = [];
	if (args[0] && /^-/.test(args[0]) && !APP_OPT.test(args[0])) {
		const at = args.findIndex(isScript);
		if (at > 0) { ignored = args.slice(0, at); args = args.slice(at); }
	}
	if (isScript(args[0])) return { run: 'script', script: args[0], rest: args.slice(1), ignored };   // a tool started by the app (or a script)
	if (args[0] === 'tas' || args[0] === 'bench' || args[0] === 'stats-import') return { run: args[0], rest: args.slice(1) };
	if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return { run: 'help', rest: [] };
	if (args.some((a) => /^-/.test(a) && !APP_OPT.test(a))) return { run: 'error', text: `unknown option in: ${args.join(' ')}` };
	return { run: 'app', rest: args.includes('--no-open') ? args.filter((a) => a !== '--no-open') : ['--open', ...args] };
}
// </plan>

function main() {
	const plan = planOf(process.argv.slice(2));
	process.env.EEAT_HOME = HOME;   // the app keeps runs and levels here (common.js); children inherit it
	process.env.EEAT_EXE = EXE;     // how tas.js prints its own commands
	let script, rest = plan.rest;
	if (plan.run === 'error') {
		console.error(`[EEAutoTAS.exe] ${plan.text} (${path.basename(EXE)} --help)`);
		process.exit(2);
	}
	if (plan.run === 'script') {
		if (plan.ignored.length) console.error(`[EEAutoTAS.exe] Node options on the command line are not read by the exe (give them in NODE_OPTIONS): ignored ${plan.ignored.join(' ')}`);
		script = path.resolve(plan.script);
	} else {
		unpack();
		const src = path.join(APP, 'src');
		if (plan.run === 'tas') script = path.join(src, 'tas.js');
		else if (plan.run === 'bench') script = path.join(src, 'bench.js');
		// (the Stats page's benchmark import, from any folder: the CSV's path as given, relative to where it was typed)
		else if (plan.run === 'stats-import') { script = path.join(APP, 'tools', 'stats-import.js'); rest = rest.map((a) => (/^-/.test(a) ? a : path.resolve(a))); }
		else if (plan.run === 'help') {
			console.log(`EE Auto TAS ${manifest.version}\n\n  ${path.basename(EXE)}                  the web app (opens the browser); --port=N, --no-open\n` +
				`  ${path.basename(EXE)} tas <command>    the command line (${path.basename(EXE)} tas help)\n` +
				`  ${path.basename(EXE)} bench            measure the CPU's engine speed\n` +
				`  ${path.basename(EXE)} stats-import <file.csv>   a results table for the Stats page (Benchmarks)\n\nApp files: ${APP}\nYour runs: ${path.join(HOME, 'jobs')}`);
			return;
		} else {
			interactive = true;
			process.title = 'EE Auto TAS';
			script = path.join(src, 'server.js');
			try { tidy(); } catch (e) { /* not important */ }
			aiGuide();
		}
	}
	if (!fs.existsSync(script)) throw new Error(`no such file: ${script}`);
	process.argv = [EXE, script, ...rest];
	Module.runMain();   // runs the script like `node script.js`: require.main === module, relative requires work
}

process.on('uncaughtException', (e) => { if (interactive) fatal(e); else { console.error(e && e.stack || e); process.exit(1); } });
try { main(); } catch (e) { fatal(e); }
