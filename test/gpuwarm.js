'use strict';
// gpu.js warmKernels: every state size's kernel module loaded once into the cache folder, through `eegpu info --ptxdir`
// with the module under the name info loads (eegpu_8.ptx). No GPU: a stand-in tool (a .js file next to fake modules)
// answers like `eegpu info` and records which module's content it was given.
//   node test/gpuwarm.js
const fs = require('fs'), os = require('os'), path = require('path');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'eeat-gpuwarm-'));
process.env.EEAT_HOME = path.join(T, 'home');
process.env.EEAT_GPU_CACHE = path.join(T, 'cache');
fs.mkdirSync(path.join(T, 'home', 'data'), { recursive: true });
const G = require('../src/gpu.js');
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`FAIL ${what}`); } };

const TOOLDIR = path.join(T, 'tool');
fs.mkdirSync(TOOLDIR);
for (const tw of [8, 32, 128, 512]) fs.writeFileSync(path.join(TOOLDIR, `eegpu_${tw}.ptx`), `// fake module ${tw}\n.version 8.5\n`);
const LOG = path.join(T, 'calls.jsonl');
const STAND = path.join(TOOLDIR, 'eegpu.js');
fs.writeFileSync(STAND, `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const opt = (k) => { const m = a.find((x) => x.startsWith('--' + k + '=')); return m ? m.slice(k.length + 3) : null; };
const dir = opt('ptxdir'), cache = opt('cachedir');
const txt = fs.readFileSync(path.join(dir, 'eegpu_8.ptx'), 'utf8');
const tw = +/fake module (\\d+)/.exec(txt)[1];
const seen = fs.existsSync(path.join(cache, 'm' + tw));
fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'm' + tw), txt);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ cmd: a[0], tw, dir, cache, files: fs.readdirSync(dir) }) + '\\n');
console.log(JSON.stringify({ module: seen ? 'cache' : 'compiled', loadMs: 5, kernels: {}, gpu: { name: 'stand-in' } }));
`);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

(async () => {
	// 1. a cold cache: every module compiled, in order, each through info with its own content as eegpu_8.ptx
	const r1 = await G.warmKernels({ tool: STAND });
	const c1 = calls();
	ok(c1.length === 4, `4 info calls (${c1.length})`);
	ok(c1.map((c) => c.tw).join() === '8,32,128,512', `the modules in order (${c1.map((c) => c.tw)})`);
	ok(c1.every((c) => c.cmd === 'info' && c.files.join() === 'eegpu_8.ptx'), 'info with one eegpu_8.ptx in its --ptxdir');
	ok(c1.every((c) => path.resolve(c.cache) === path.resolve(process.env.EEAT_GPU_CACHE)), 'the cache folder passed (cacheArgs)');
	ok(r1.map((r) => r.module).join() === 'compiled,compiled,compiled,compiled', `compiled x4 (${r1.map((r) => r.module)})`);
	ok(c1.every((c) => !fs.existsSync(c.dir)), 'the temporary folders removed');
	const rec = JSON.parse(fs.readFileSync(path.join(process.env.EEAT_HOME, 'data', '_gpu_warm.json'), 'utf8'));
	ok(rec.ok === true && rec.tws.length === 4, 'the record written (ok, 4 sizes)');
	// 2. this build done: no call
	const r2 = await G.warmKernels({ tool: STAND });
	ok(calls().length === 4 && r2.length === 4, 'done for this build: no more calls');
	// 3. force: every module found in the cache now
	const r3 = await G.warmKernels({ tool: STAND, force: true });
	ok(calls().length === 8 && r3.every((r) => r.module === 'cache'), `forced: 4 more calls, every module "cache" (${r3.map((r) => r.module)})`);
	// 4. another build (a module changed): warmed again; a missing module is no failure
	fs.unlinkSync(path.join(TOOLDIR, 'eegpu_128.ptx'));
	const r4 = await G.warmKernels({ tool: STAND });
	ok(calls().length === 11 && r4.find((r) => r.tw === 128).error === 'no module', `a new build warmed again, the missing module skipped (${calls().length})`);
	const rec4 = JSON.parse(fs.readFileSync(path.join(process.env.EEAT_HOME, 'data', '_gpu_warm.json'), 'utf8'));
	ok(rec4.ok === true, 'a missing module leaves the record ok');
	// 5. a tool that fails: the record not ok, so the next start tries again
	const BAD = path.join(TOOLDIR, 'bad.js');
	fs.writeFileSync(BAD, `console.log(JSON.stringify({ gpu: null, why: 'no NVIDIA GPU' }));`);
	const r5 = await G.warmKernels({ tool: BAD, force: true });
	ok(r5.filter((r) => r.error === 'no NVIDIA GPU').length === 3, `a failing tool: errors (${JSON.stringify(r5.map((r) => r.error))})`);
	ok(JSON.parse(fs.readFileSync(path.join(process.env.EEAT_HOME, 'data', '_gpu_warm.json'), 'utf8')).ok === false, 'a failing tool: the record not ok');
	fs.rmSync(T, { recursive: true, force: true });
	console.log(`gpuwarm: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
