'use strict';
// Builds the native engine and its GPU kernels: native/build/eegpu.exe (zig c++) and native/build/eegpu.ptx (NVRTC).
//   node tools/build-native.js            (the first run downloads zig and NVIDIA's NVRTC into tools/.cache, ~290 MB)
// The exe loads the NVIDIA driver at run time (no CUDA toolkit needed to run it); the PTX is compiled by the driver
// for the GPU it runs on. Both are needed only by the GPU mode; everything else is plain Node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const OUT = path.join(NATIVE, 'build');
const CACHE = path.join(__dirname, '.cache');
const DL = {
	zig: { url: 'https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip', sha256: '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e', dir: 'zig-x86_64-windows-0.16.0' },
	nvrtc: { url: 'https://developer.download.nvidia.com/compute/cuda/redist/cuda_nvrtc/windows-x86_64/cuda_nvrtc-windows-x86_64-12.6.85-archive.zip', sha256: 'b1221a95a3758561bc73c56905743730f7459cbaff54a4870aa899fa3489219e', dir: 'cuda_nvrtc-windows-x86_64-12.6.85-archive' },
};

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

function main() {
	if (process.platform !== 'win32') throw new Error('the native build targets Windows');
	const zig = path.join(fetchTool('zig'), 'zig.exe');
	const nvrtc = path.join(fetchTool('nvrtc'), 'bin');
	fs.mkdirSync(OUT, { recursive: true });
	const exe = path.join(OUT, 'eegpu.exe');
	console.log('[native] compiling eegpu.exe...');
	// exact IEEE doubles: no fast-math, no contraction into fused multiply-adds, baseline x86-64 (no FMA instructions)
	execFileSync(zig, ['c++', '-O2', '-std=c++17', '-target', 'x86_64-windows-gnu', '-ffp-contract=off', '-fno-fast-math',
		'-Wall', '-Wno-unused-function', '-Wno-unused-variable', '-Wno-nullability-completeness', path.join(NATIVE, 'eegpu.cpp'), '-o', exe],
		{ stdio: ['ignore', 'inherit', 'inherit'] });
	for (const f of fs.readdirSync(OUT)) if (f.endsWith('.pdb') || f.endsWith('.lib')) fs.rmSync(path.join(OUT, f), { force: true });
	console.log('[native] compiling the GPU kernels (NVRTC)...');
	const r = execFileSync(exe, ['ptx', NATIVE, path.join(OUT, 'eegpu.ptx'), `--nvrtc=${nvrtc}`], { encoding: 'utf8' });
	console.log(`[native] ${r.trim()}`);
	console.log(`[native] done: ${path.relative(ROOT, exe)} + eegpu.ptx`);
}

main();
