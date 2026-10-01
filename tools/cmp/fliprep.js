'use strict';
// THE FLIPS' SECOND RUN, while a full compile runs (tools/cmp/fullc.js): every level whose compiled outcome differs from a
// base run (NEW: compiled now, not in the base; LOST: compiled in the base, not now) is compiled again at once with the same
// code and budget, so a gain is told from the spread before the scoreboard is posted. The full compile's parfile is set to
// total - the second runs going, so the two together stay inside one share of the box.
//   node tools/cmp/fliprep.js <code dir> <levels dir> <full dir> <out dir> --base=<JSON array / jsonl of {rel, ok}>...
//        (--base may be given more than once: a level flips when its outcome differs from ANY base run; NEW / LOST name
//        the outcome now, the flip line the bases it differs from)
//        [--n=<levels the full compile runs>] [--max=4] [--total=<the share in compiles> --parfile=<the full compile's>]
//        [--seconds=300] [--workers=3]
// The out dir is a full-compile dir of its own (index.jsonl, <id>.json / .eetas / .log): verify.js and score.js read it.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , code, lvDir, full, out, ...rest] = process.argv;
const opt = (k, d) => { const a = rest.find((s) => s.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const max = +opt('max', 4), total = +opt('total', 0), parfile = opt('parfile', ''), seconds = +opt('seconds', 300), workers = +opt('workers', 3);
const readRows = (f) => { const s = fs.readFileSync(f, 'utf8').trim(); return s.startsWith('[') ? JSON.parse(s) : s.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); };
const baseFiles = rest.filter((s) => s.startsWith('--base=')).map((s) => s.slice(7));
const bases = baseFiles.map((f) => new Map(readRows(f).map((r) => [r.rel, !!(r.ok && (r.runTicks > 0 || r.runTicks === undefined))])));
const n = +opt('n', 0) || (bases.length ? bases[0].size : 0);
fs.mkdirSync(out, { recursive: true });
const done = new Set(), queue = [];
let running = 0, launched = 0;
const setPar = () => { if (total > 0 && parfile) fs.writeFileSync(parfile, String(Math.max(1, total - running)) + '\n'); };
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
function launch() {
	while (running < max && queue.length) {
		const ix = queue.shift();
		running++; launched++; setPar();
		const f = path.join(lvDir, ix.rel), ts = Date.now();
		const args = [path.join(code, 'src', 'compile.js'), f, `--out=${path.join(out, ix.id + '.eetas')}`, `--report=${path.join(out, ix.id + '.json')}`, `--workers=${workers}`, `--seconds=${seconds}`, '--known=0', '--json'];
		const fd = fs.openSync(path.join(out, ix.id + '.log'), 'w');
		const p = cp.spawn(process.execPath, args, { cwd: code, stdio: ['ignore', fd, fd] });
		fs.closeSync(fd);
		const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, (seconds * 3 + 60) * 1000);
		log(`run 2 ${ix.rel} (${ix.flip})`);
		p.on('close', (c) => {
			clearTimeout(kill);
			fs.appendFileSync(path.join(out, 'index.jsonl'), JSON.stringify({ rel: ix.rel, id: ix.id, code: c, sec: (Date.now() - ts) / 1000, flip: ix.flip }) + '\n');
			let ok = false;
			try { const r = JSON.parse(fs.readFileSync(path.join(out, ix.id + '.json'), 'utf8')); ok = !!(r.ok && r.runTicks > 0); } catch (e) { ok = false; }
			log(`run 2 done ${ix.rel} (${ix.flip}): ${ok ? 'compiled' : 'not compiled'}`);
			running--; setPar(); launch();
		});
	}
}
function poll() {
	let rows = [];
	try { rows = readRows(path.join(full, 'index.jsonl')); } catch (e) { rows = []; }
	for (const ix of rows) {
		if (done.has(ix.rel)) continue;
		done.add(ix.rel);
		let ok = false;
		try { const r = JSON.parse(fs.readFileSync(path.join(full, ix.id + '.json'), 'utf8')); ok = !!(r.ok && r.runTicks > 0); } catch (e) { ok = false; }
		const vs = bases.map((b, i) => ((b.get(ix.rel) || false) !== ok ? path.basename(baseFiles[i]) : null)).filter(Boolean);
		if (vs.length) { const flip = (ok ? 'NEW' : 'LOST') + (vs.length < bases.length ? ' vs ' + vs.join(',') : ''); queue.push(Object.assign({}, ix, { flip })); log(`flip ${ix.rel}: ${flip}`); }
	}
	launch();
	if (done.size >= n && !queue.length && !running) { log(`ALL DONE: ${launched} second runs`); if (total > 0 && parfile) fs.writeFileSync(parfile, String(total) + '\n'); return; }
	setTimeout(poll, 10000);
}
poll();
