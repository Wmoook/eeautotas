'use strict';
// Builds the native engine and its GPU kernels: native/build/eegpu.exe (zig c++) and native/build/eegpu.ptx (NVRTC).
//   node tools/build-native.js            (the first run downloads zig and NVIDIA's NVRTC into tools/.cache, ~290 MB)
//   node tools/build-native.js --exe      (eegpu.exe only, one compile: its CPU commands, e.g. `eegpu prove`, need no
//                                          kernels. The kernels of an earlier full build stay only while their sources
//                                          are unchanged (eegpu_ptx.json); else they are removed, and the GPU commands
//                                          of such a build fail at their kernel load instead of running old kernels)
// The exe loads the NVIDIA driver at run time (no CUDA toolkit needed to run it); the PTX is compiled by the driver
// for the GPU it runs on. Both are needed only by the GPU mode (and Find a route's proof, eegpu prove: the exe alone);
// everything else is plain Node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const OUT = path.join(NATIVE, 'build');
const CACHE = path.join(__dirname, '.cache');
const DL = {
	zig: { url: 'https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip', sha256: '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e', dir: 'zig-x86_64-windows-0.16.0' },
	nvrtc: { url: 'https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/windows-x86_64/cuda_nvrtc-windows-x86_64-12.6.85-archive.zip', sha256: 'b1221a95a3758561bc73c56905743730f7459cbaff54a4870aa899fa3489219e', dir: 'cuda_nvrtc-windows-x86_64-12.6.85-archive' },
};

// what the kernels are made of (eegpu ptx: kernels.cu and the 4 headers it hands NVRTC, its options in eegpu.cpp, the
// NVRTC build): a full build stamps its PTX files with it (eegpu_ptx.json), and --exe keeps them only while it matches
const KERNEL_SRC = ['kernels.cu', 'eecore.h', 'search.h', 'beam.h', 'explore.h', 'eegpu.cpp'];
const STAMP = path.join(OUT, 'eegpu_ptx.json');
function kernelStamp() {
	const h = crypto.createHash('sha1');
	h.update(DL.nvrtc.dir);
	for (const f of KERNEL_SRC) h.update(fs.readFileSync(path.join(NATIVE, f)));
	return h.digest('hex');
}

function fetchTool(name) {
	const t = DL[name];
	const dir = path.join(CACHE, t.dir);
	if (fs.existsSync(dir)) return dir;
	fs.mkdirSync(path.join(CACHE, 'dl'), { recursive: true });
	const zip = path.join(CACHE, 'dl', `${name}.zip`);
	console.log(`[native] downloading ${name} (once)...`);
	execFileSync('curl', ['-sSL', '-o', zip, t.url], { stdio: 'inherit' });
	const sum = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
	if (sum !== t.sha256) throw new Error(`${name}: checksum mismatch (${sum})`);
	execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${CACHE}'`], { stdio: 'inherit' });
	return dir;
}

async function main() {
	if (process.platform !== 'win32') throw new Error('the native build targets Windows');
	const exeOnly = process.argv.includes('--exe');
	const srcStamp = kernelStamp();   // (the sources this build starts from)
	const zig = path.join(fetchTool('zig'), 'zig.exe');
	const nvrtc = exeOnly ? '' : path.join(fetchTool('nvrtc'), 'bin');
	fs.mkdirSync(OUT, { recursive: true });
	const exe = path.join(OUT, 'eegpu.exe');
	console.log('[native] compiling eegpu.exe...');
	// exact IEEE doubles: no fast-math, no contraction into fused multiply-adds, baseline x86-64 (no FMA instructions)
	execFileSync(zig, ['c++', '-O2', '-std=c++17', '-target', 'x86_64-windows-gnu', '-ffp-contract=off', '-fno-fast-math',
		'-Wall', '-Wno-unused-function', '-Wno-unused-variable', '-Wno-nullability-completeness', path.join(NATIVE, 'eegpu.cpp'), '-o', exe],
		{ stdio: ['ignore', 'inherit', 'inherit'] });
	for (const f of fs.readdirSync(OUT)) if (f.endsWith('.pdb') || f.endsWith('.lib')) fs.rmSync(path.join(OUT, f), { force: true });
	if (exeOnly) {
		const ptx = fs.readdirSync(OUT).filter((f) => /^eegpu_\d+\.ptx$/.test(f));
		let stamp = null;
		try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch (e) { /* none: a build before the stamp */ }
		const current = ptx.length > 0 && !!stamp && stamp.src === srcStamp;
		if (ptx.length && !current) {
			for (const f of [...ptx, path.basename(STAMP)]) fs.rmSync(path.join(OUT, f), { force: true });
			console.log('[native] removed the GPU kernels of an older build (their sources changed): the GPU commands need a full build (node tools/build-native.js)');
		}
		console.log(`[native] done: ${path.relative(ROOT, exe)} (${current ? 'the GPU kernels of the last full build are current' : 'no GPU kernels'}: --exe)`);
		return;
	}
	// one PTX file per state-tail capacity (the exe loads only the one a level needs), compiled in parallel. Sim::tick
	// stays inlined in every kernel: the out-of-line build (eegpu ptx --def=EE_TICK_NOINLINE) is 1.66 MB of PTX instead of
	// 7.77 MB, 25 s of NVRTC instead of 198 s and 148 s of first driver compile instead of 229 s (a busy i7-11800H), but
	// on the RTX 3080 Laptop it ran bench 0.93x, explore expand 0.96x, beam expand 0.95x and search 0.86x (in one process,
	// launch by launch; the bench processes alternating A/B 0.935x); the first compile happens once per build anyway.
	console.log('[native] compiling the GPU kernels (NVRTC, 4 state sizes in parallel)...');
	const TWS = [8, 32, 128, 512];
	const outs = await Promise.all(TWS.map((tw) => new Promise((res, rej) => {
		execFile(exe, ['ptx', NATIVE, path.join(OUT, `eegpu_${tw}.ptx`), `--nvrtc=${nvrtc}`, `--tw=${tw}`], { encoding: 'utf8', maxBuffer: 1 << 26 },
			(err, stdout, stderr) => (err ? rej(new Error(`ptx ${tw}: ${stderr || err.message}`)) : res(stdout.trim())));
	})));
	for (const o of outs) console.log(`[native] ${o}`);
	for (const f of fs.readdirSync(OUT)) if (/^eegpu\.ptx$|^dev\./.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
	fs.writeFileSync(STAMP, JSON.stringify({ src: srcStamp, t: new Date().toISOString() }));
	console.log(`[native] done: ${path.relative(ROOT, exe)} + eegpu_{${TWS.join(',')}}.ptx`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
