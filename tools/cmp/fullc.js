'use strict';
// THE COMPILER's full compile (the chief's baseline, the lanes' gate): src/compile.js on every .eelvl under a dir, in parallel.
//   node tools/cmp/fullc.js <code dir> <levels dir> <out dir> [--par=36] [--workers=3] [--seconds=60] [--list=<file of rel paths>]
//        [--json=1] [--minfree=GB] [--rss=1]
// --json=1: the compile's JSON event lines go to <id>.log (every event carries t = its second: the time to the first
//   verified route and the best route at any earlier budget are read from them; summ.js reads the plan / why lines from
//   the report then). --minfree=GB: a compile starts only while the box's MemAvailable is above GB (the RAM guard: a
//   box is limited by its RAM long before its threads). --rss=1 (Linux): every 2 s the resident memory of each running
//   compile's process tree (the compile + its child processes; worker threads are in the process) is read from /proc:
//   index.jsonl gets its peak (peakRssMB), <out>/rss.jsonl the box's used memory and the compiles' sum over time.
//   --killfree=GB (with --rss=1): when MemAvailable falls under GB, the youngest running compile is killed (its process
//   tree) and queued again at the end (the box never runs out of RAM; a compile's RSS grows with its budget).
//   --parfile=<file>: the parallelism read again from that file (one integer) before each start (a running full
//   compile made wider or narrower by the RSS it measures).
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const [, , code, lvDir, out, ...rest] = process.argv;
const opt = (k, d) => { const a = rest.find((s) => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
let par = +opt('par', 36); const parfile = opt('parfile', '');
const workers = +opt('workers', 3), seconds = +opt('seconds', 60), list = opt('list', '');
const json = opt('json', '0') === '1', minfree = +opt('minfree', 0), rssOn = opt('rss', '0') === '1' && process.platform === 'linux', killfree = +opt('killfree', 0);
fs.mkdirSync(out, { recursive: true });
const all = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.eelvl')) all.push(p); } };
walk(lvDir);
all.sort();
let todo = all;
if (list) { const want = new Set(fs.readFileSync(list, 'utf8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter(Boolean)); todo = all.filter((p) => want.has(path.relative(lvDir, p))); }
let next = 0, running = 0, done = 0;
const t0 = Date.now();
const live = new Map();   // pid -> {id, f, ts, peak (kB), requeue}
let requeued = 0;
const memAvailGB = () => { try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); return m ? +m[1] / 1048576 : Infinity; } catch (e) { return Infinity; } };
const PAGE_KB = 4;
function sampleRss() {
	// one pass over /proc: ppid and rss of every process; a compile's tree = its pid and every descendant
	const kids = new Map(), rss = new Map();
	for (const d of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) continue;
		let s;
		try { s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch (e) { continue; }
		const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
		const pid = +d, ppid = +f[1];
		rss.set(pid, +f[21] * PAGE_KB);
		const k = kids.get(ppid) || []; k.push(pid); kids.set(ppid, k);
	}
	let sum = 0;
	for (const [pid, x] of live) {
		let t = 0; const st = [pid];
		while (st.length) { const p = st.pop(); t += rss.get(p) || 0; for (const c of kids.get(p) || []) st.push(c); }
		if (t > x.peak) x.peak = t;
		sum += t;
	}
	let used = null;
	try { const m = fs.readFileSync('/proc/meminfo', 'utf8'); used = (+m.match(/MemTotal:\s+(\d+)/)[1] - +m.match(/MemAvailable:\s+(\d+)/)[1]) / 1048576; } catch (e) { used = null; }
	if (killfree > 0 && memAvailGB() < killfree) {
		// the RAM guard: the youngest compile (the least work lost) killed with its tree, queued again
		let y = null;
		for (const [pid, x] of live) if (!x.requeue && (!y || x.ts > y[1].ts)) y = [pid, x];
		if (y) {
			y[1].requeue = true; requeued++;
			const st = [y[0]], tree = [];
			while (st.length) { const p = st.pop(); tree.push(p); for (const c of kids.get(p) || []) st.push(c); }
			for (const p of tree) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } }
			todo.push(y[1].f);
			console.log(`RAM guard: MemAvailable < ${killfree} GB: killed ${y[1].id} (queued again; ${requeued} so far)`);
		}
	}
	fs.appendFileSync(path.join(out, 'rss.jsonl'), JSON.stringify({ s: Math.round((Date.now() - t0) / 1000), running, compilesGB: Math.round(sum / 1048576 * 100) / 100, usedGB: used === null ? null : Math.round(used * 100) / 100 }) + '\n');
}
const rssTimer = rssOn ? setInterval(() => { try { sampleRss(); } catch (e) { /* a process gone mid-read */ } if (parfile) start(); }, 2000) : null;
let waitTimer = null;
function start() {
	if (parfile) { try { const v = parseInt(fs.readFileSync(parfile, 'utf8'), 10); if (v > 0 && v !== par) { console.log(`par ${par} -> ${v} (${parfile})`); par = v; } } catch (e) { /* none */ } }
	while (running < par && next < todo.length) {
		if (minfree > 0 && running > 0 && memAvailGB() < minfree) { if (!waitTimer) waitTimer = setTimeout(() => { waitTimer = null; start(); }, 3000); return; }
		const f = todo[next++], rel = path.relative(lvDir, f), id = rel.replace(/[\\/]/g, '__').replace(/\.eelvl$/, '');
		running++;
		const ts = Date.now();
		const args = [path.join(code, 'src', 'compile.js'), f, `--out=${path.join(out, id + '.eetas')}`, `--report=${path.join(out, id + '.json')}`, `--workers=${workers}`, `--seconds=${seconds}`, '--known=0'];
		if (json) args.push('--json');
		const logFd = fs.openSync(path.join(out, id + '.log'), 'w');
		const p = cp.spawn(process.execPath, args, { cwd: code, stdio: ['ignore', logFd, logFd] });
		fs.closeSync(logFd);
		const me = { id, f, ts, peak: 0, requeue: false };
		if (p.pid) live.set(p.pid, me);
		const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, (seconds * 3 + 60) * 1000);
		p.on('close', (c) => {
			clearTimeout(kill);
			live.delete(p.pid);
			if (me.requeue) { running--; start(); return; }
			fs.appendFileSync(path.join(out, 'index.jsonl'), JSON.stringify(Object.assign({ rel, id, code: c, sec: (Date.now() - ts) / 1000 }, rssOn ? { peakRssMB: Math.round(me.peak / 1024) } : {})) + '\n');
			running--; done++;
			if (done % 10 === 0 || done === todo.length) console.log(`${done}/${todo.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
			if (done === todo.length) { console.log('ALL DONE'); if (rssTimer) clearInterval(rssTimer); }
			start();
		});
	}
}
start();
