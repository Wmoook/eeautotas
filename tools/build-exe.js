'use strict';
// Builds dist/EEAutoTAS.exe: one file with Node and the whole app inside, for people without Node (send it to
// friends). It runs exactly like START.bat; tools/exe/launcher.js explains how.
//   npm run build:exe          (the first build downloads postject and rcedit from npm into tools/.cache)
// Steps: collect the app files -> a single executable application blob (node --experimental-sea-config) -> copy
// this Node's node.exe -> remove its signature (it would be broken by the changes) -> icon and file details (rcedit)
// -> inject the blob (postject). The exe contains the Node version that runs this script.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const CACHE = path.join(__dirname, '.cache');
const BUILD = path.join(CACHE, 'build');
const EXE = path.join(OUT, 'EEAutoTAS.exe');
const TOOLS = { postject: '1.0.0-alpha.6', rcedit: '4.0.1' };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (process.platform !== 'win32') throw new Error('build the exe on Windows (it packs this node.exe)');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 12)) throw new Error(`Node 22.12+ needed to build (this is ${process.version})`);

// ---------------------------------------------------------------- the app files
/** Everything the app needs at run time; never the per-PC data (levels, runs, scratch). */
function appFiles() {
	const files = [];
	const skip = new Set(['src/data', 'src/jobs', 'src/out']);
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
			const r = `${rel}/${e.name}`;
			if (e.isDirectory()) { if (!skip.has(r)) walk(r); } else if (/\.(js|json|html|md)$/.test(e.name)) files.push(r);
		}
	};
	walk('src');
	walk('docs');
	for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'package.json']) files.push(f);
	return files.sort();
}

// ---------------------------------------------------------------- PE signature
/** Removes the Authenticode signature of a PE file (node.exe is signed; the signature would be invalid after the
 *  changes, which looks worse to Windows and antivirus software than no signature). */
function stripSignature(file) {
	const b = fs.readFileSync(file);
	const pe = b.readUInt32LE(0x3c);
	if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
	const opt = pe + 24;
	const dirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);   // PE32+ : PE32
	const sec = dirs + 4 * 8;                                          // IMAGE_DIRECTORY_ENTRY_SECURITY
	const at = b.readUInt32LE(sec), size = b.readUInt32LE(sec + 4);
	if (!size) return false;
	if (at + size < b.length - 8) throw new Error('the signature is not at the end of the file');
	b.writeUInt32LE(0, sec); b.writeUInt32LE(0, sec + 4);
	fs.writeFileSync(file, b.subarray(0, at));
	return true;
}
function hasSignature(file) {
	const b = fs.readFileSync(file);
	const pe = b.readUInt32LE(0x3c), opt = pe + 24;
	const dirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
	return b.readUInt32LE(dirs + 36) > 0;
}

// ---------------------------------------------------------------- build
function tools() {
	const nm = path.join(CACHE, 'node_modules');
	const ok = Object.entries(TOOLS).every(([n, v]) => {   // pinned versions; npm checks their integrity
		try { return JSON.parse(fs.readFileSync(path.join(nm, n, 'package.json'), 'utf8')).version === v; } catch (e) { return false; }
	});
	if (!ok) {
		console.log('[build] downloading postject and rcedit (npm, once)...');
		fs.mkdirSync(CACHE, { recursive: true });
		if (!fs.existsSync(path.join(CACHE, 'package.json'))) fs.writeFileSync(path.join(CACHE, 'package.json'), '{"private":true}\n');
		const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
		execFileSync(process.execPath, [npm, 'install', '--no-audit', '--no-fund', '--prefix', CACHE,
			...Object.entries(TOOLS).map(([n, v]) => `${n}@${v}`)], { stdio: 'inherit' });
	}
	return { postject: path.join(nm, 'postject', 'dist', 'cli.js'), rcedit: path.join(nm, 'rcedit', 'bin', 'rcedit-x64.exe') };
}

function main() {
	const t = tools();
	const files = appFiles();
	const hash = crypto.createHash('sha256');
	for (const f of files) { hash.update(f); hash.update(fs.readFileSync(path.join(ROOT, f))); }
	hash.update(fs.readFileSync(path.join(__dirname, 'exe', 'launcher.js')));
	hash.update(process.version);
	const version = `${pkg.version}-${hash.digest('hex').slice(0, 10)}`;
	console.log(`[build] EE Auto TAS ${version}: ${files.length} files, Node ${process.version}`);

	fs.rmSync(BUILD, { recursive: true, force: true });
	fs.mkdirSync(BUILD, { recursive: true });
	fs.mkdirSync(OUT, { recursive: true });
	const assets = { 'manifest.json': path.join(BUILD, 'manifest.json') };
	fs.writeFileSync(assets['manifest.json'], JSON.stringify({ version, node: process.version, files }));
	for (const f of files) assets[f] = path.join(ROOT, f);
	const blob = path.join(BUILD, 'app.blob');
	fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
		main: path.join(__dirname, 'exe', 'launcher.js'), output: blob,
		disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets,
	}, null, 1));
	execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], { stdio: 'inherit' });

	const tmp = path.join(BUILD, 'EEAutoTAS.exe');
	fs.copyFileSync(process.execPath, tmp);
	if (stripSignature(tmp)) console.log('[build] removed the node.exe signature');
	const ico = path.join(BUILD, 'EEAutoTAS.ico');
	fs.writeFileSync(ico, require('./exe/icon.js').makeIco());
	const ver = pkg.version.split('-')[0];
	// rcedit (Electron's, deprecated on npm but still the standard tool) only sets the icon and the file details
	if (!fs.existsSync(t.rcedit)) console.log('[build] rcedit is missing: the exe keeps the Node.js icon and details');
	else execFileSync(t.rcedit, [tmp, '--set-icon', ico, '--set-file-version', ver, '--set-product-version', ver,
		'--set-version-string', 'FileDescription', 'EE Auto TAS',
		'--set-version-string', 'ProductName', 'EE Auto TAS',
		'--set-version-string', 'InternalName', 'EEAutoTAS',
		'--set-version-string', 'OriginalFilename', 'EEAutoTAS.exe',
		'--set-version-string', 'CompanyName', 'EE Auto TAS',
		'--set-version-string', 'LegalCopyright', 'EE Auto TAS. Includes Node.js (MIT license, Node.js contributors).',
		'--set-version-string', 'Comments', `https://github.com/Wmoook/eeautotas ${version}`], { stdio: 'inherit' });
	execFileSync(process.execPath, [t.postject, tmp, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
		{ stdio: ['ignore', 'ignore', 'inherit'] });
	if (hasSignature(tmp)) throw new Error('the exe still has a (broken) signature');

	// smoke test: the exe starts, unpacks its files into a temp folder and answers --help
	const home = path.join(BUILD, 'smoke-home');
	const help = execFileSync(tmp, ['--help'], { encoding: 'utf8', env: { ...process.env, EEAT_HOME: home } });
	if (!help.includes(version)) throw new Error(`smoke test failed:\n${help}`);
	const tasHelp = execFileSync(tmp, ['tas', 'help'], { encoding: 'utf8', env: { ...process.env, EEAT_HOME: home } });
	if (!/command line/.test(tasHelp)) throw new Error(`smoke test (tas help) failed:\n${tasHelp}`);
	fs.rmSync(home, { recursive: true, force: true });

	fs.rmSync(EXE, { force: true });
	fs.renameSync(tmp, EXE);
	const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
	console.log(`[build] done: ${path.relative(ROOT, EXE)} (${mb} MB, version ${version})`);
}

main();
