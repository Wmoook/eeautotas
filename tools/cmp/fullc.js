'use strict';
// THE COMPILER's full compile (the chief's baseline, the lanes' gate): src/compile.js on every .eelvl under a dir, in parallel.
//   node tools/cmp/fullc.js <code dir> <levels dir> <out dir> [--par=36] [--workers=3] [--seconds=60] [--list=<file of rel paths>]
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , code, lvDir, out, ...rest] = process.argv;
const opt = (k, d) => { const a = rest.find((s) => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const par = +opt('par', 36), workers = +opt('workers', 3), seconds = +opt('seconds', 60), list = opt('list', '');
fs.mkdirSync(out, { recursive: true });
const all = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.eelvl')) all.push(p); } };
walk(lvDir);
all.sort();
let todo = all;
if (list) { const want = new Set(fs.readFileSync(list, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)); todo = all.filter((p) => want.has(path.relative(lvDir, p))); }
let next = 0, running = 0, done = 0;
const t0 = Date.now();
function start() {
	while (running < par && next < todo.length) {
		const f = todo[next++], rel = path.relative(lvDir, f), id = rel.replace(/[\\/]/g, '__').replace(/\.eelvl$/, '');
		running++;
		const ts = Date.now();
		const p = cp.spawn(process.execPath, [path.join(code, 'src', 'compile.js'), f, `--out=${path.join(out, id + '.eetas')}`, `--report=${path.join(out, id + '.json')}`, `--workers=${workers}`, `--seconds=${seconds}`, '--known=0'], { cwd: code, stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
		const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, (seconds * 3 + 60) * 1000);
		p.on('close', (c) => {
			clearTimeout(kill);
			fs.writeFileSync(path.join(out, id + '.log'), log);
			fs.appendFileSync(path.join(out, 'index.jsonl'), JSON.stringify({ rel, id, code: c, sec: (Date.now() - ts) / 1000 }) + '\n');
			running--; done++;
			if (done % 10 === 0 || done === todo.length) console.log(`${done}/${todo.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
			if (done === todo.length) console.log('ALL DONE');
			start();
		});
	}
}
start();
