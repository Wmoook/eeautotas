'use strict';
// builds src/out/xp/xp.exe from xp.cpp against this worktree's native/ headers (CPU only)
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ZIG = 'C:/Users/super/eeautotas/tools/.cache/zig-x86_64-windows-0.16.0/zig.exe';
const src = process.argv[2] || 'xp.cpp', out = process.argv[3] || src.replace(/\.cpp$/, '.exe');
const t0 = Date.now();
execFileSync(ZIG, ['c++', '-O2', '-std=c++17', '-target', 'x86_64-windows-gnu', '-ffp-contract=off', '-fno-fast-math', '-w',
	'-I', path.join(ROOT, 'native'), path.join(__dirname, src), '-o', path.join(__dirname, out)], { stdio: 'inherit' });
console.log(`${out}: ${Date.now() - t0} ms`);
