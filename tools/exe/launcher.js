'use strict';
// EEAutoTAS.exe entry point: a Node single executable application built by tools/build-exe.js (Node is inside the
// exe, so it runs on a PC without Node). The app's files are embedded in the exe. On start they are unpacked once to
// %LOCALAPPDATA%\EEAutoTAS\app\<version>\ (the optimizer runs worker threads and child processes, which need real
// files), and the runs are kept in %LOCALAPPDATA%\EEAutoTAS\jobs (EEAT_HOME), so a newer exe keeps them.
//   EEAutoTAS.exe                   the web app (opens the browser), like START.bat; --port=N, --no-open
//   EEAutoTAS.exe tas <command>     the command line (src/tas.js), e.g. `EEAutoTAS.exe tas jobs`
//   EEAutoTAS.exe bench             measure this PC's engine speed (src/bench.js)
//   EEAutoTAS.exe <file.js> [args]  run a script with the exe's Node (the app starts its own tools this way)
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
**${path.basename(EXE)}** (Node is inside the exe; this PC may not have Node installed).

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

function main() {
	const args = process.argv.slice(2);
	process.env.EEAT_HOME = HOME;   // the app keeps runs and levels here (common.js); children inherit it
	process.env.EEAT_EXE = EXE;     // how tas.js prints its own commands
	let script, rest;
	if (args[0] && /\.[cm]?js$/i.test(args[0])) {   // a tool started by the app (or a script)
		script = path.resolve(args[0]);
		rest = args.slice(1);
	} else {
		unpack();
		const src = path.join(APP, 'src');
		if (args[0] === 'tas') { script = path.join(src, 'tas.js'); rest = args.slice(1); }
		else if (args[0] === 'bench') { script = path.join(src, 'bench.js'); rest = args.slice(1); }
		else if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
			console.log(`EE Auto TAS ${manifest.version}\n\n  ${path.basename(EXE)}                  the web app (opens the browser); --port=N, --no-open\n` +
				`  ${path.basename(EXE)} tas <command>    the command line (${path.basename(EXE)} tas help)\n` +
				`  ${path.basename(EXE)} bench            measure this PC's engine speed\n\nApp files: ${APP}\nYour runs: ${path.join(HOME, 'jobs')}`);
			return;
		} else {
			interactive = true;
			process.title = 'EE Auto TAS';
			script = path.join(src, 'server.js');
			rest = args.includes('--no-open') ? args.filter((a) => a !== '--no-open') : ['--open', ...args];
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
